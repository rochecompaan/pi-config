package server

import (
	"bytes"
	"context"
	"os"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/client"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestNegotiatedStreamLimitAboveDefaultCarriesLargeAPIResponse(t *testing.T) {
	response := bytes.Repeat([]byte("x"), 70<<10)
	caller := &fakeCaller{result: github.Result{Stdout: response}}
	server := newStreamLimitServer(t, caller, "/bin/false", 128<<10, config.ActionsRead)
	listener, cancel, done := serveUnix(t, server)
	defer func() { cancel(); <-done }()

	output, status, err := client.ExecuteAPI(context.Background(), listener.Addr().String(), client.Request{
		Operation: protocol.ActionsRunsLogs,
		Arguments: []byte(`{"runId":1}`),
	})
	if err != nil || status != 0 || !bytes.Equal(output, response) {
		t.Fatalf("output bytes=%d status=%d err=%v", len(output), status, err)
	}
}

func TestNegotiatedStreamLimitBelowDefaultChunksGitInput(t *testing.T) {
	stdinFile, _ := configureSSHHelper(t, "upload", nil)
	server := newStreamLimitServer(t, &fakeCaller{}, helperExecutable(t), 8<<10, config.GitRead)
	listener, cancel, done := serveUnix(t, server)
	defer func() { cancel(); <-done }()

	input := bytes.Repeat([]byte("g"), 70<<10)
	var stdout, stderr bytes.Buffer
	status, err := client.RelayGit(context.Background(), listener.Addr().String(), client.SSHRequest{
		Operation: protocol.GitUploadPack,
	}, bytes.NewReader(input), &stdout, &stderr)
	if err != nil || status != 0 {
		t.Fatalf("status=%d err=%v stderr=%q", status, err, stderr.String())
	}
	got, readErr := os.ReadFile(stdinFile)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if !bytes.Equal(got, input) {
		t.Fatalf("SSH stdin bytes=%d, want %d", len(got), len(input))
	}
}

func newStreamLimitServer(t *testing.T, caller github.Caller, sshExecutable string, limit int, capabilities ...config.Capability) *Server {
	t.Helper()
	cfg := config.Config{
		Enable: true, Repository: "acme/demo", Capabilities: capabilities,
		PushPolicy: config.DefaultPushPolicy(), Limits: config.DefaultLimits(),
	}
	cfg.Limits.MaxStreamFrameBytes = limit
	server, err := New(Options{
		Config: cfg, APICaller: caller, SSHExecutable: sshExecutable, WorkingDirectory: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}
