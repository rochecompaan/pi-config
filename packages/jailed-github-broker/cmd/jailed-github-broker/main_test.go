package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/client"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestRunRejectsUnknownMulticallNameAndDoesNotInspectAuthEnvironment(t *testing.T) {
	var requested []string
	getenv := func(name string) string { requested = append(requested, name); return "" }
	status := run(context.Background(), "/tmp/not-gh", nil, getenv, bytes.NewReader(nil), &bytes.Buffer{}, &bytes.Buffer{})
	if status == 0 || len(requested) != 0 {
		t.Fatalf("status=%d requested=%v", status, requested)
	}
}

func TestRunGHUsesOnlyNarrowJailSettings(t *testing.T) {
	var requested []string
	getenv := func(name string) string {
		requested = append(requested, name)
		switch name {
		case client.SocketEnvironment:
			return filepath.Join(t.TempDir(), "missing.sock")
		case client.RepositoryEnvironment:
			return "owner/repo"
		default:
			return "secret"
		}
	}
	status := run(context.Background(), "/nix/store/hash/bin/gh", []string{"api", "/user"}, getenv, bytes.NewReader(nil), &bytes.Buffer{}, &bytes.Buffer{})
	if status == 0 || !reflect.DeepEqual(requested, []string{client.SocketEnvironment, client.RepositoryEnvironment}) {
		t.Fatalf("status=%d requested=%v", status, requested)
	}
}

func TestRunSSHUsesOnlyNarrowJailSettings(t *testing.T) {
	var requested []string
	getenv := func(name string) string {
		requested = append(requested, name)
		switch name {
		case client.SocketEnvironment:
			return filepath.Join(t.TempDir(), "missing.sock")
		case client.RepositoryEnvironment:
			return "owner/repo"
		default:
			return "secret"
		}
	}
	args := []string{"-p", "22", "git@github.com", "git-upload-pack 'owner/repo.git'"}
	status := run(context.Background(), "/nix/store/hash/bin/jailed-git-ssh", args, getenv, bytes.NewReader(nil), &bytes.Buffer{}, &bytes.Buffer{})
	if status != 2 || !reflect.DeepEqual(requested, []string{client.SocketEnvironment, client.RepositoryEnvironment}) {
		t.Fatalf("status=%d requested=%v", status, requested)
	}
}

func TestRunRequiresJailSettings(t *testing.T) {
	for _, missing := range []string{client.SocketEnvironment, client.RepositoryEnvironment} {
		getenv := func(name string) string {
			if name == missing {
				return ""
			}
			if name == client.SocketEnvironment {
				return "/tmp/socket"
			}
			return "owner/repo"
		}
		var stderr bytes.Buffer
		if status := run(context.Background(), "gh", []string{"repo", "view"}, getenv, bytes.NewReader(nil), &bytes.Buffer{}, &stderr); status == 0 {
			t.Fatalf("missing %s accepted", missing)
		}
	}
}

func TestParseServeArgumentsRequiresExactAuditFD(t *testing.T) {
	directory := t.TempDir()
	base := []string{
		"serve", "--config", filepath.Join(directory, "config"),
		"--socket", filepath.Join(directory, "socket"),
		"--ready-file", filepath.Join(directory, "ready"),
	}
	valid := append(append([]string(nil), base...), "--audit-fd", "3")
	parsed, err := parseServeArguments(valid)
	if err != nil || parsed.auditFD != 3 {
		t.Fatalf("parsed=%+v err=%v, want audit FD 3", parsed, err)
	}
	for _, suffix := range [][]string{
		nil,
		{"--audit-fd", ""},
		{"--audit-fd", "2"},
		{"--audit-fd", "4"},
		{"--audit-fd", "not-a-number"},
		{"--audit-fd", "3", "--audit-fd", "3"},
	} {
		args := append(append([]string(nil), base...), suffix...)
		if _, err := parseServeArguments(args); err == nil {
			t.Errorf("parseServeArguments(%q) succeeded", args)
		}
	}
}

func TestOpenAuditFileRejectsMissingOrNonappendDescriptors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	appendFile, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer appendFile.Close()
	validFD, err := syscall.Dup(int(appendFile.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	opened, err := openAuditFile(validFD)
	if err != nil {
		t.Fatalf("openAuditFile(append FD): %v", err)
	}
	_ = opened.Close()

	missingFD, err := syscall.Dup(int(appendFile.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	_ = syscall.Close(missingFD)
	if _, err := openAuditFile(missingFD); err == nil {
		t.Fatal("openAuditFile accepted a closed descriptor")
	}

	nonappend, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer nonappend.Close()
	if _, err := openAuditFile(int(nonappend.Fd())); err == nil {
		t.Fatal("openAuditFile accepted a non-append descriptor")
	}
}

func TestHostToolConfigurationIsEmptyOrAbsolute(t *testing.T) {
	if hostGHExecutable == "" && hostSSHExecutable == "" {
		return
	}
	if !filepath.IsAbs(hostGHExecutable) || !filepath.IsAbs(hostSSHExecutable) {
		t.Fatalf("host tool configuration = %q, %q; want both empty or absolute", hostGHExecutable, hostSSHExecutable)
	}
}

func TestServeCreatesReadyAfterListeningAndCleansArtifacts(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "config.json")
	socketPath := filepath.Join(directory, "broker.sock")
	readyPath := filepath.Join(directory, "ready")
	config := map[string]any{
		"enable": true, "repository": "owner/repo", "capabilities": []string{"repository:read"},
	}
	data, _ := json.Marshal(config)
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	oldGH, oldSSH := hostGHExecutable, hostSSHExecutable
	hostGHExecutable, hostSSHExecutable = "/bin/false", "/bin/false"
	defer func() { hostGHExecutable, hostSSHExecutable = oldGH, oldSSH }()

	t.Setenv("AUDIT_FORBIDDEN_ENV", "environment-secret-sentinel")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var audit lockedBuffer
	go func() {
		done <- runServeWithAudit(ctx, []string{"serve", "--config", configPath, "--socket", socketPath, "--ready-file", readyPath, "--audit-fd", "3"}, &bytes.Buffer{}, &audit)
	}()
	waitForPath(t, readyPath)
	info, err := os.Stat(socketPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode=%v err=%v", info, err)
	}
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("ready preceded listen: %v", err)
	}
	_ = conn.Close()
	matches, _ := filepath.Glob(filepath.Join(directory, ".jailed-github-broker-*"))
	if len(matches) != 1 {
		t.Fatalf("private cwd matches=%v", matches)
	}
	if info, err := os.Stat(matches[0]); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("cwd mode=%v err=%v", info, err)
	}
	cancel()
	select {
	case status := <-done:
		if status != 0 {
			t.Fatalf("serve status=%d", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serve did not stop")
	}
	for _, path := range append(matches, socketPath, readyPath) {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("artifact remains: %s (%v)", path, err)
		}
	}
}

func TestServeRejectsMalformedArgumentsConfigAndToolPaths(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"enable":true,"repository":"owner/repo","capabilities":[],"unknown":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := [][]string{
		{"serve"},
		{"serve", "--config", configPath, "--socket", filepath.Join(directory, "s"), "--ready-file", filepath.Join(directory, "r"), "tail"},
		{"serve", "--config=" + configPath, "--socket", filepath.Join(directory, "s"), "--ready-file", filepath.Join(directory, "r")},
		{"serve", "--config", configPath, "--config", configPath, "--socket", filepath.Join(directory, "s"), "--ready-file", filepath.Join(directory, "r")},
	}
	for _, args := range tests {
		if status := run(context.Background(), "jailed-github-broker", args, os.Getenv, bytes.NewReader(nil), &bytes.Buffer{}, &bytes.Buffer{}); status == 0 {
			t.Fatalf("accepted %q", args)
		}
	}
	validPaths := []string{"serve", "--config", configPath, "--socket", filepath.Join(directory, "malformed.sock"), "--ready-file", filepath.Join(directory, "malformed.ready"), "--audit-fd", "3"}
	if status := runServeWithAudit(context.Background(), validPaths, &bytes.Buffer{}, &bytes.Buffer{}); status == 0 {
		t.Fatal("accepted malformed config with valid serve arguments")
	}
	oldGH, oldSSH := hostGHExecutable, hostSSHExecutable
	defer func() { hostGHExecutable, hostSSHExecutable = oldGH, oldSSH }()
	validConfig := filepath.Join(directory, "valid.json")
	_ = os.WriteFile(validConfig, []byte(`{"enable":true,"repository":"owner/repo","capabilities":[]}`), 0o600)
	args := []string{"serve", "--config", validConfig, "--socket", filepath.Join(directory, "s2"), "--ready-file", filepath.Join(directory, "r2"), "--audit-fd", "3"}
	hostGHExecutable, hostSSHExecutable = "", ""
	if status := runServeWithAudit(context.Background(), args, &bytes.Buffer{}, &bytes.Buffer{}); status == 0 {
		t.Fatal("accepted absent host executables")
	}
	hostGHExecutable, hostSSHExecutable = "gh", "/bin/false"
	if status := runServeWithAudit(context.Background(), args, &bytes.Buffer{}, &bytes.Buffer{}); status == 0 {
		t.Fatal("accepted relative host executable")
	}
}

func TestServeSocketAuditsAcceptedAPIFailure(t *testing.T) {
	// A smoke assertion that serve wires runner/server rather than only creating artifacts.
	directory := t.TempDir()
	configPath, socketPath, readyPath := filepath.Join(directory, "c"), filepath.Join(directory, "s"), filepath.Join(directory, "r")
	_ = os.WriteFile(configPath, []byte(`{"enable":true,"repository":"owner/repo","capabilities":["repository:read"]}`), 0o600)
	oldGH, oldSSH := hostGHExecutable, hostSSHExecutable
	hostGHExecutable, hostSSHExecutable = "/bin/false", "/bin/false"
	defer func() { hostGHExecutable, hostSSHExecutable = oldGH, oldSSH }()
	t.Setenv("AUDIT_FORBIDDEN_ENV", "environment-secret-sentinel")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var audit lockedBuffer
	go func() {
		done <- runServeWithAudit(ctx, []string{"serve", "--config", configPath, "--socket", socketPath, "--ready-file", readyPath, "--audit-fd", "3"}, &bytes.Buffer{}, &audit)
	}()
	waitForPath(t, readyPath)
	request, _ := client.ParseGH([]string{"repo", "view"}, "owner/repo")
	_, status, err := client.ExecuteAPI(context.Background(), socketPath, request)
	if err != nil || status != 1 {
		t.Fatalf("status=%d err=%v", status, err)
	}
	cancel()
	<-done
	record := audit.String()
	for _, required := range []string{`"operation":"repository.get"`, `"repository":"owner/repo"`, `"duration_ms":`, `"exit_status":1`, `"stdin_bytes":2`, `"stdout_bytes":0`, `"stderr_bytes":0`} {
		if !strings.Contains(record, required) {
			t.Errorf("audit record %q lacks %q", record, required)
		}
	}
	if !regexp.MustCompile(`"request_id":"[0-9]+"`).MatchString(record) {
		t.Errorf("audit record lacks escaped request ID: %q", record)
	}
	if strings.Contains(record, "environment-secret-sentinel") || strings.Contains(record, "/bin/false") {
		t.Fatalf("audit leaked forbidden data: %q", record)
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (buffer *lockedBuffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buf.Write(value)
}

func (buffer *lockedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buf.String()
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("path not created: %s", path)
}

var _ = protocol.Version
