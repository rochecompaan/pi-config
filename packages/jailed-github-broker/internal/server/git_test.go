package server

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const (
	oldOID = "1111111111111111111111111111111111111111"
	newOID = "2222222222222222222222222222222222222222"
)

func TestGitUploadPackUsesFixedArgvAndFramesStreams(t *testing.T) {
	stdinFile, argvFile := configureSSHHelper(t, "upload", nil)
	server := newGitServer(t, config.GitRead)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 21, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	writeFrame(t, client, protocol.Frame{Kind: protocol.StdinData, RequestID: 21, Payload: []byte("client-input")})
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 21})
	frames := readThroughExit(t, client)
	var stdout, stderr []byte
	for _, frame := range frames {
		switch frame.Kind {
		case protocol.StdoutData:
			stdout = append(stdout, frame.Payload...)
		case protocol.StderrData:
			stderr = append(stderr, frame.Payload...)
		}
	}
	if string(stdout) != "host-output" {
		t.Fatalf("stdout = %q", stdout)
	}
	if string(stderr) != "ssh transport diagnostic\n" || bytes.Contains(stderr, []byte("RAW-SECRET")) {
		t.Fatalf("stderr diagnostic = %q", stderr)
	}
	if got := mustReadFile(t, stdinFile); got != "client-input" {
		t.Fatalf("SSH stdin = %q", got)
	}
	wantArgv := "git@github.com\ngit-upload-pack 'acme/demo.git'\n"
	if got := mustReadFile(t, argvFile); got != wantArgv {
		t.Fatalf("SSH argv = %q, want %q", got, wantArgv)
	}
}

func TestGitReceivePackAllowsFeatureAndForwardsPrefixUnchanged(t *testing.T) {
	advertisement := advertised("refs/heads/main", "report-status delete-refs push-options")
	stdinFile, argvFile := configureSSHHelper(t, "receive", advertisement)
	server := newGitServer(t, config.GitRead, config.GitWrite)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 31, protocol.GitReceivePack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	if got := readStdoutBytes(t, client, len(advertisement)); !bytes.Equal(got, advertisement) {
		t.Fatalf("advertisement changed: %q", got)
	}
	prefix := append(pkt(oldOID+" "+newOID+" refs/heads/feature\x00report-status push-options"), []byte("0000")...)
	prefix = append(prefix, pkt("ci.skip")...)
	prefix = append(prefix, []byte("0000")...)
	pack := []byte("PACK-feature-data")
	writeDataChunks(t, client, 31, append(append([]byte(nil), prefix...), pack...))
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 31})
	frames := readThroughExit(t, client)
	last := frames[len(frames)-1]
	status, _ := protocol.DecodeExitStatus(last)
	if status != 0 {
		t.Fatalf("exit status = %d, frames=%#v", status, frames)
	}
	if got := []byte(mustReadFile(t, stdinFile)); !bytes.Equal(got, append(prefix, pack...)) {
		t.Fatalf("SSH stdin changed: %q", got)
	}
	wantArgv := "git@github.com\ngit-receive-pack 'acme/demo.git'\n"
	if got := mustReadFile(t, argvFile); got != wantArgv {
		t.Fatalf("SSH argv = %q", got)
	}
}

func TestGitReceivePackDeniedMainNeverReachesSSHStdin(t *testing.T) {
	advertisement := advertised("refs/heads/main", "report-status delete-refs")
	stdinFile, _ := configureSSHHelper(t, "receive", advertisement)
	server := newGitServer(t, config.GitRead, config.GitWrite)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 32, protocol.GitReceivePack, `{}`)
	_ = readFrame(t, client)
	_ = readStdoutBytes(t, client, len(advertisement))
	denied := append(pkt(oldOID+" "+newOID+" refs/heads/main\x00report-status"), []byte("0000PACK-denied")...)
	writeDataChunks(t, client, 32, denied)
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 32})
	frames := readThroughExit(t, client)
	status, err := protocol.DecodeExitStatus(frames[len(frames)-1])
	if err != nil {
		t.Fatalf("denied push terminal frame: %v", err)
	}
	if status == 0 {
		t.Fatalf("denied push exit status = 0")
	}
	waitForFile(t, stdinFile)
	if got := mustReadFile(t, stdinFile); got != "" {
		t.Fatalf("denied bytes reached SSH stdin: %q", got)
	}
}

func TestGitRejectsClientSelectedRepositoryBeforeSSH(t *testing.T) {
	stdinFile, argvFile := configureSSHHelper(t, "upload", nil)
	server := newGitServer(t, config.GitRead)
	client, stop := startServer(t, server)
	defer stop()
	writeRequest(t, client, 40, protocol.GitUploadPack, `{"repository":"evil/repo","host":"evil"}`)
	if frame := readFrame(t, client); frame.Kind != protocol.Error {
		t.Fatalf("frame = %#v", frame)
	}
	if _, err := os.Stat(argvFile); !os.IsNotExist(err) {
		t.Fatalf("SSH was invoked, stat error %v", err)
	}
	if _, err := os.Stat(stdinFile); !os.IsNotExist(err) {
		t.Fatalf("SSH stdin file exists, stat error %v", err)
	}
}

func TestGitIdleTimeoutSendsNonzeroExit(t *testing.T) {
	configureSSHHelper(t, "idle", nil)
	server := newGitServerWithTimeouts(t, 2*time.Second, 50*time.Millisecond, config.GitRead)
	client, stop := startServer(t, server)
	defer stop()
	writeRequest(t, client, 45, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	frames := readThroughExit(t, client)
	status, _ := protocol.DecodeExitStatus(frames[len(frames)-1])
	if status == 0 {
		t.Fatal("idle SSH process returned success")
	}
}

func TestGitOperationTimeoutSendsExactlyOneCompleteNonzeroExit(t *testing.T) {
	configureSSHHelper(t, "idle", nil)
	server := newGitServerWithTimeouts(t, time.Second, 5*time.Second, config.GitRead)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 47, protocol.GitUploadPack, `{}`)
	frames := readThroughExit(t, client)
	if len(frames) != 2 || frames[0].Kind != protocol.ControlResponse || frames[1].Kind != protocol.Exit {
		t.Fatalf("frames = %#v, want response and one complete exit", frames)
	}
	status, err := protocol.DecodeExitStatus(frames[1])
	if err != nil || status == 0 {
		t.Fatalf("timeout exit = %d, %v; want complete nonzero exit", status, err)
	}
	assertClosedWithin(t, client, 500*time.Millisecond)
}

func TestGitDisconnectAfterEndInputKillsDescendantProcessGroup(t *testing.T) {
	configureSSHHelper(t, "spawn", nil)
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	t.Setenv("SSH_DESCENDANT_PID_FILE", pidFile)
	server := newGitServerWithTimeouts(t, 10*time.Second, 10*time.Second, config.GitRead)
	client, stop := startServer(t, server)
	defer stop()
	writeRequest(t, client, 46, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	waitForFile(t, pidFile)
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 46})
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	pidText := strings.TrimSpace(mustReadFile(t, pidFile))
	pid, err := strconv.Atoi(pidText)
	if err != nil {
		t.Fatal(err)
	}
	waitForProcessGone(t, pid)
}

func TestSSHHelperProcess(t *testing.T) {
	mode := os.Getenv("SSH_HELPER_MODE")
	if mode == "" {
		return
	}
	separator := 0
	for index, arg := range os.Args {
		if arg == "--" {
			separator = index + 1
			break
		}
	}
	argv := strings.Join(os.Args[separator:], "\n") + "\n"
	if err := os.WriteFile(os.Getenv("SSH_ARGV_FILE"), []byte(argv), 0o600); err != nil {
		os.Exit(90)
	}
	input, err := os.Create(os.Getenv("SSH_STDIN_FILE"))
	if err != nil {
		os.Exit(91)
	}
	defer input.Close()
	switch mode {
	case "upload":
		_, _ = os.Stdout.WriteString("host-output")
		_, _ = os.Stderr.WriteString("RAW-SECRET command and environment")
		_, _ = io.Copy(input, os.Stdin)
	case "receive":
		advertisement, _ := os.ReadFile(os.Getenv("SSH_ADVERTISEMENT_FILE"))
		_, _ = os.Stdout.Write(advertisement)
		_, _ = io.Copy(input, os.Stdin)
		_, _ = os.Stdout.WriteString("receive-result")
	case "idle":
		time.Sleep(5 * time.Second)
	case "no-read":
		_ = os.WriteFile(os.Getenv("SSH_HELPER_PID_FILE"), []byte(strconv.Itoa(os.Getpid())), 0o600)
		time.Sleep(5 * time.Second)
	case "flood":
		_ = os.WriteFile(os.Getenv("SSH_HELPER_PID_FILE"), []byte(strconv.Itoa(os.Getpid())), 0o600)
		block := make([]byte, 64*1024)
		for range 256 {
			_, _ = os.Stdout.Write(block)
		}
	case "stderr-flood":
		_ = os.WriteFile(os.Getenv("SSH_HELPER_PID_FILE"), []byte(strconv.Itoa(os.Getpid())), 0o600)
		block := make([]byte, 64*1024)
		for {
			_, _ = os.Stderr.Write(block)
		}
	case "spawn":
		child := exec.Command(os.Args[0], "-test.run=TestSSHDescendantProcess")
		child.Env = append(os.Environ(), "SSH_DESCENDANT_HELPER=1")
		if err := child.Start(); err != nil {
			os.Exit(93)
		}
		_ = os.WriteFile(os.Getenv("SSH_DESCENDANT_PID_FILE"), []byte(strconv.Itoa(child.Process.Pid)), 0o600)
		_, _ = io.Copy(input, os.Stdin)
		_ = child.Wait()
	default:
		os.Exit(92)
	}
	os.Exit(0)
}

func TestSSHDescendantProcess(t *testing.T) {
	if os.Getenv("SSH_DESCENDANT_HELPER") != "1" {
		return
	}
	time.Sleep(5 * time.Second)
	os.Exit(0)
}

func newGitServer(t *testing.T, capabilities ...config.Capability) *Server {
	return newGitServerWithTimeouts(t, 3*time.Second, 2*time.Second, capabilities...)
}

func newGitServerWithTimeouts(t *testing.T, operationTimeout, idleTimeout time.Duration, capabilities ...config.Capability) *Server {
	t.Helper()
	cfg := config.Config{Enable: true, Repository: "acme/demo", Capabilities: capabilities, PushPolicy: config.DefaultPushPolicy(), Limits: config.DefaultLimits()}
	cfg.Limits.MaxStreamFrameBytes = 16
	cfg.Limits.OperationTimeoutSeconds = int(operationTimeout / time.Second)
	cfg.Limits.IdleStreamTimeoutSeconds = int(idleTimeout / time.Second)
	if cfg.Limits.OperationTimeoutSeconds < 1 {
		cfg.Limits.OperationTimeoutSeconds = 1
	}
	if cfg.Limits.IdleStreamTimeoutSeconds < 1 {
		cfg.Limits.IdleStreamTimeoutSeconds = 1
	}
	server, err := New(Options{Config: cfg, APICaller: &fakeCaller{}, SSHExecutable: helperExecutable(t), WorkingDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func configureSSHHelper(t *testing.T, mode string, advertisement []byte) (string, string) {
	t.Helper()
	directory := t.TempDir()
	stdinFile := filepath.Join(directory, "stdin")
	argvFile := filepath.Join(directory, "argv")
	t.Setenv("SSH_HELPER_MODE", mode)
	t.Setenv("SSH_STDIN_FILE", stdinFile)
	t.Setenv("SSH_ARGV_FILE", argvFile)
	if advertisement != nil {
		path := filepath.Join(directory, "advertisement")
		if err := os.WriteFile(path, advertisement, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("SSH_ADVERTISEMENT_FILE", path)
	}
	return stdinFile, argvFile
}

func helperExecutable(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-ssh")
	script := "#!/bin/sh\nexec " + shellQuote(os.Args[0]) + " -test.run=TestSSHHelperProcess -- \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return absolute
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func advertised(ref, capabilities string) []byte {
	return append(pkt(oldOID+" "+ref+"\x00"+capabilities+"\n"), []byte("0000")...)
}

func pkt(payload string) []byte {
	return []byte(fmt.Sprintf("%04x%s", len(payload)+4, payload))
}

func writeDataChunks(t *testing.T, conn io.Writer, id uint32, data []byte) {
	t.Helper()
	for len(data) != 0 {
		length := len(data)
		if length > 16 {
			length = 16
		}
		if err := protocol.WriteFrame(conn, protocol.Frame{Kind: protocol.StdinData, RequestID: id, Payload: data[:length]}, protocol.DefaultLimits()); err != nil {
			t.Fatal(err)
		}
		data = data[length:]
	}
}

func readStdoutBytes(t *testing.T, conn io.Reader, length int) []byte {
	t.Helper()
	var output []byte
	for len(output) < length {
		frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		if frame.Kind != protocol.StdoutData {
			t.Fatalf("frame kind = %v before complete advertisement", frame.Kind)
		}
		output = append(output, frame.Payload...)
	}
	return output
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("file %s not created", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForProcessGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process %d survived disconnect", pid)
}

func readPIDFile(t *testing.T, path string) int {
	t.Helper()
	pidText := strings.TrimSpace(mustReadFile(t, path))
	pid, err := strconv.Atoi(pidText)
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
