package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/client"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/runner"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/server"
)

// These trusted paths are package-time bindable with -X. They are never flags
// or jail-controlled settings and are invoked directly without PATH lookup.
var (
	hostGHExecutable  string
	hostSSHExecutable string
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	os.Exit(run(ctx, os.Args[0], os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr))
}

func run(ctx context.Context, executable string, args []string, getenv func(string) string, stdin io.Reader, stdout, stderr io.Writer) int {
	switch filepath.Base(executable) {
	case "gh":
		socket, repository := getenv(client.SocketEnvironment), getenv(client.RepositoryEnvironment)
		if socket == "" || repository == "" {
			writeError(stderr, "gh: broker settings are required\n")
			return 2
		}
		return client.RunGH(ctx, socket, repository, args, stdout, stderr)
	case "jailed-git-ssh":
		socket, repository := getenv(client.SocketEnvironment), getenv(client.RepositoryEnvironment)
		if socket == "" || repository == "" {
			writeError(stderr, "jailed-git-ssh: broker settings are required\n")
			return 2
		}
		return client.RunSSH(ctx, socket, repository, args, stdin, stdout, stderr)
	case "jailed-github-broker":
		return runServe(ctx, args, stderr)
	default:
		writeError(stderr, "unsupported invocation name\n")
		return 2
	}
}

type serveArguments struct {
	config  string
	socket  string
	ready   string
	auditFD int
}

func parseServeArguments(args []string) (serveArguments, error) {
	if len(args) == 0 || args[0] != "serve" {
		return serveArguments{}, fmt.Errorf("serve subcommand is required")
	}
	var result serveArguments
	seen := map[string]bool{}
	for index := 1; index < len(args); index++ {
		name := args[index]
		if seen[name] || (name != "--config" && name != "--socket" && name != "--ready-file" && name != "--audit-fd") {
			return serveArguments{}, fmt.Errorf("unsupported or duplicate serve argument")
		}
		seen[name] = true
		index++
		if index == len(args) {
			return serveArguments{}, fmt.Errorf("serve argument requires a value")
		}
		switch name {
		case "--config":
			result.config = args[index]
		case "--socket":
			result.socket = args[index]
		case "--ready-file":
			result.ready = args[index]
		case "--audit-fd":
			if args[index] != "3" {
				return serveArguments{}, fmt.Errorf("audit FD must be 3")
			}
			result.auditFD = 3
		}
	}
	if result.config == "" || result.socket == "" || result.ready == "" || result.auditFD == 0 {
		return serveArguments{}, fmt.Errorf("all serve paths are required")
	}
	if !filepath.IsAbs(result.config) || !filepath.IsAbs(result.socket) || !filepath.IsAbs(result.ready) {
		return serveArguments{}, fmt.Errorf("serve paths must be absolute")
	}
	if result.config == result.socket || result.config == result.ready || result.socket == result.ready {
		return serveArguments{}, fmt.Errorf("serve paths must be distinct")
	}
	return result, nil
}

func runServe(ctx context.Context, args []string, stderr io.Writer) int {
	paths, err := parseServeArguments(args)
	if err != nil {
		writeError(stderr, "serve: invalid arguments\n")
		return 2
	}
	auditFile, err := openAuditFile(paths.auditFD)
	if err != nil {
		writeError(stderr, "serve: audit setup failed\n")
		return 1
	}
	defer auditFile.Close()
	return serve(ctx, paths, stderr, auditFile)
}

func runServeWithAudit(ctx context.Context, args []string, stderr, audit io.Writer) int {
	paths, err := parseServeArguments(args)
	if err != nil {
		writeError(stderr, "serve: invalid arguments\n")
		return 2
	}
	return serve(ctx, paths, stderr, audit)
}

func openAuditFile(fd int) (*os.File, error) {
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), uintptr(syscall.F_GETFL), 0)
	if errno != 0 || int(flags)&syscall.O_ACCMODE == syscall.O_RDONLY || int(flags)&syscall.O_APPEND == 0 {
		return nil, fmt.Errorf("audit FD is not a writable append descriptor")
	}
	file := os.NewFile(uintptr(fd), "audit")
	if file == nil {
		return nil, fmt.Errorf("audit FD is unavailable")
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, fmt.Errorf("audit FD is not a regular file")
	}
	return file, nil
}

func serve(ctx context.Context, paths serveArguments, stderr, audit io.Writer) int {
	if !filepath.IsAbs(hostGHExecutable) || !filepath.IsAbs(hostSSHExecutable) {
		writeError(stderr, "serve: host tool configuration failed\n")
		return 1
	}
	cfg, err := loadConfig(paths.config)
	if err != nil {
		writeError(stderr, "serve: config failed\n")
		return 1
	}
	workingDirectory, err := os.MkdirTemp(filepath.Dir(paths.socket), ".jailed-github-broker-*")
	if err != nil {
		writeError(stderr, "serve: private working directory failed\n")
		return 1
	}
	defer os.RemoveAll(workingDirectory)
	apiRunner, err := runner.New(runner.Config{
		Executable: hostGHExecutable, WorkingDirectory: workingDirectory,
		OperationTimeout: time.Duration(cfg.Limits.OperationTimeoutSeconds) * time.Second,
		IdleTimeout:      time.Duration(cfg.Limits.IdleStreamTimeoutSeconds) * time.Second,
	})
	if err != nil {
		writeError(stderr, "serve: host tool configuration failed\n")
		return 1
	}
	auditSink := server.NewAuditSink(audit)
	broker, err := server.New(server.Options{
		Config: cfg, APICaller: apiRunner, SSHExecutable: hostSSHExecutable,
		WorkingDirectory: workingDirectory, Audit: auditSink.Record,
	})
	if err != nil {
		writeError(stderr, "serve: broker configuration failed\n")
		return 1
	}
	listener, err := net.Listen("unix", paths.socket)
	if err != nil {
		writeError(stderr, "serve: socket creation failed\n")
		return 1
	}
	defer func() { _ = listener.Close(); _ = os.Remove(paths.socket) }()
	if err := os.Chmod(paths.socket, 0o600); err != nil {
		writeError(stderr, "serve: socket permissions failed\n")
		return 1
	}
	if err := createReadyFile(paths.ready); err != nil {
		writeError(stderr, "serve: ready file failed\n")
		return 1
	}
	defer os.Remove(paths.ready)
	stopListener := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stopListener()
	if err := broker.Serve(ctx, listener); err != nil {
		writeError(stderr, "serve: broker stopped unexpectedly\n")
		return 1
	}
	return 0
}

func loadConfig(path string) (config.Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return config.Config{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return config.Config{}, fmt.Errorf("config read failed or exceeded limit")
	}
	return config.DecodeJSON(data)
}

func createReadyFile(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString("ready\n"); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

func writeError(destination io.Writer, message string) {
	if destination != nil {
		_, _ = io.WriteString(destination, message)
	}
}
