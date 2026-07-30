package client

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestParseSSHApprovedGitHubForms(t *testing.T) {
	tests := []struct {
		args      []string
		operation protocol.Operation
	}{
		{[]string{"git@github.com", "git-upload-pack 'owner/repo.git'"}, protocol.GitUploadPack},
		{[]string{"git@github.com", "git-receive-pack 'owner/repo.git'"}, protocol.GitReceivePack},
		{[]string{"-o", "SendEnv=GIT_PROTOCOL", "git@github.com", "git-upload-pack 'owner/repo.git'"}, protocol.GitUploadPack},
	}
	for _, test := range tests {
		request, err := ParseSSH(test.args, "owner/repo")
		if err != nil || request.Operation != test.operation {
			t.Fatalf("ParseSSH(%q) = %#v, %v", test.args, request, err)
		}
	}
}

func TestParseSSHRejectsEverythingOutsideExactGitShape(t *testing.T) {
	tests := [][]string{
		nil, {"git@github.com"}, {"github.com", "git-upload-pack 'owner/repo.git'"},
		{"root@github.com", "git-upload-pack 'owner/repo.git'"}, {"git@evil.example", "git-upload-pack 'owner/repo.git'"},
		{"-p", "22", "git@github.com", "git-upload-pack 'owner/repo.git'"},
		{"-o", "ProxyCommand=sh", "git@github.com", "git-upload-pack 'owner/repo.git'"},
		{"-oSendEnv=GIT_PROTOCOL", "git@github.com", "git-upload-pack 'owner/repo.git'"},
		{"-T", "git@github.com", "git-upload-pack 'owner/repo.git'"}, {"-N", "git@github.com"},
		{"git@github.com", "git-upload-pack 'other/repo.git'"}, {"git@github.com", "git-upload-pack 'owner/repo'"},
		{"git@github.com", "git-upload-pack owner/repo.git"}, {"git@github.com", `git-upload-pack "owner/repo.git"`},
		{"git@github.com", "git-upload-pack 'owner/repo.git'; id"}, {"git@github.com", "git-upload-pack 'owner/repo.git' trailing"},
		{"git@github.com", "git archive 'owner/repo.git'"}, {"git@github.com", "sh"},
		{"git@github.com", "git-receive-pack 'owner/repo.git'", "tail"},
	}
	for _, args := range tests {
		if request, err := ParseSSH(args, "owner/repo"); err == nil {
			t.Fatalf("accepted %q: %#v", args, request)
		}
	}
}

func TestRelayGitPreservesFramedStreamsAndExitStatus(t *testing.T) {
	input := bytes.Repeat([]byte("pack"), 20000)
	var received chan []byte
	socket, received, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
		var stdin bytes.Buffer
		for {
			frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
			if err != nil {
				t.Errorf("read input: %v", err)
				return
			}
			if frame.Kind == protocol.EndInput {
				break
			}
			if frame.Kind != protocol.StdinData {
				t.Errorf("input kind=%v", frame.Kind)
				return
			}
			stdin.Write(frame.Payload)
		}
		received <- stdin.Bytes()
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID, Payload: []byte{0, 1, 2, 255}})
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StderrData, RequestID: request.RequestID, Payload: []byte("ssh transport diagnostic\n")})
		writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 23))
	})
	defer stop()
	request, _ := ParseSSH([]string{"git@github.com", "git-upload-pack 'owner/repo.git'"}, "owner/repo")
	var stdout, stderr bytes.Buffer
	status, err := RelayGit(context.Background(), socket, request, bytes.NewReader(input), &stdout, &stderr)
	if err != nil || status != 23 {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if !bytes.Equal(<-received, input) || !bytes.Equal(stdout.Bytes(), []byte{0, 1, 2, 255}) || stderr.String() != "ssh transport diagnostic\n" {
		t.Fatalf("streams changed: stdout=%v stderr=%q", stdout.Bytes(), stderr.String())
	}
}

func TestRunSSHRejectsLocallyBeforeConnecting(t *testing.T) {
	var stdout, stderr bytes.Buffer
	status := RunSSH(context.Background(), filepath.Join(t.TempDir(), "absent.sock"), "owner/repo", []string{"-p", "22", "git@github.com", "git-upload-pack 'owner/repo.git'"}, bytes.NewReader(nil), &stdout, &stderr)
	if status != 2 || stdout.Len() != 0 || stderr.String() != "jailed-git-ssh: unsupported invocation\n" {
		t.Fatalf("status=%d stdout=%q stderr=%q", status, stdout.String(), stderr.String())
	}
}

func TestRunSSHReturnsSuccessfulBrokerStatus(t *testing.T) {
	socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
		for {
			frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
			if err != nil {
				return
			}
			if frame.Kind == protocol.EndInput {
				break
			}
		}
		writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
	})
	defer stop()
	status := RunSSH(context.Background(), socket, "owner/repo", []string{"git@github.com", "git-upload-pack 'owner/repo.git'"}, bytes.NewReader(nil), io.Discard, io.Discard)
	if status != 0 {
		t.Fatalf("status=%d", status)
	}
}

func TestRelayGitPropagatesRejection(t *testing.T) {
	socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.Error, RequestID: request.RequestID, Payload: []byte(`{"message":"request rejected"}`)})
	})
	defer stop()
	request := SSHRequest{Operation: protocol.GitReceivePack}
	if _, err := RelayGit(context.Background(), socket, request, bytes.NewReader(nil), io.Discard, io.Discard); !errors.Is(err, ErrRejected) {
		t.Fatalf("err=%v", err)
	}
}

func TestRelayGitRejectsInvalidServerTranscript(t *testing.T) {
	tests := []struct {
		name    string
		handler func(net.Conn, protocol.Frame)
	}{
		{"stream ID mismatch", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID + 1, Payload: []byte("x")})
		}},
		{"client direction from server", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdinData, RequestID: request.RequestID, Payload: []byte("x")})
		}},
		{"duplicate exit", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
		}},
		{"stdout after exit", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID, Payload: []byte("late")})
		}},
		{"stderr after exit", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StderrData, RequestID: request.RequestID, Payload: allowedSSHDiagnostic})
		}},
		{"trailing byte", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			if _, err := conn.Write([]byte{0xff}); err != nil {
				t.Errorf("write trailing byte: %v", err)
			}
		}},
		{"missing close", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			var one [1]byte
			_, _ = conn.Read(one[:])
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
				writeAccepted(t, conn, request.RequestID)
				drainGitInput(t, conn)
				test.handler(conn, request)
			})
			defer stop()
			request := SSHRequest{Operation: protocol.GitUploadPack}
			ctx := context.Background()
			cancel := func() {}
			if test.name == "missing close" {
				ctx, cancel = context.WithTimeout(ctx, 2*terminalCloseTimeout)
			}
			_, err := RelayGit(ctx, socket, request, bytes.NewReader(nil), io.Discard, io.Discard)
			timedOut := ctx.Err() != nil
			cancel()
			if err == nil {
				t.Fatal("accepted invalid transcript")
			}
			if timedOut {
				t.Fatal("terminal close validation exceeded its protocol bound")
			}
		})
	}
}

func TestRelayGitCancelsOnContextAndLocalStreamFailure(t *testing.T) {
	t.Run("context before acceptance", func(t *testing.T) {
		socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
			var one [1]byte
			_, _ = conn.Read(one[:])
		})
		defer stop()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := RelayGit(ctx, socket, SSHRequest{Operation: protocol.GitUploadPack}, bytes.NewReader(nil), io.Discard, io.Discard)
			done <- err
		}()
		time.Sleep(20 * time.Millisecond)
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("cancellation succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("relay did not cancel before acceptance")
		}
	})
	t.Run("context", func(t *testing.T) {
		disconnected := make(chan struct{})
		socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
			var one [1]byte
			_, _ = conn.Read(one[:])
			close(disconnected)
		})
		defer stop()
		ctx, cancel := context.WithCancel(context.Background())
		request := SSHRequest{Operation: protocol.GitUploadPack}
		done := make(chan error, 1)
		blocking := &blockingReader{done: ctx.Done()}
		go func() { _, err := RelayGit(ctx, socket, request, blocking, io.Discard, io.Discard); done <- err }()
		time.Sleep(20 * time.Millisecond)
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("cancellation succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("relay did not cancel")
		}
		select {
		case <-disconnected:
		case <-time.After(time.Second):
			t.Fatal("server not disconnected")
		}
	})
	t.Run("stdin failure", func(t *testing.T) {
		disconnected := make(chan struct{})
		socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
			var one [1]byte
			for {
				if _, err := conn.Read(one[:]); err != nil {
					break
				}
			}
			close(disconnected)
		})
		defer stop()
		request := SSHRequest{Operation: protocol.GitUploadPack}
		if _, err := RelayGit(context.Background(), socket, request, failingReader{}, io.Discard, io.Discard); err == nil {
			t.Fatal("reader failure accepted")
		}
		select {
		case <-disconnected:
		case <-time.After(time.Second):
			t.Fatal("server not disconnected")
		}
	})
	t.Run("stdout failure", func(t *testing.T) {
		disconnected := make(chan struct{})
		socket, _, stop := startGitServer(t, func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID, Payload: []byte("data")})
			var one [1]byte
			for {
				if _, err := conn.Read(one[:]); err != nil {
					break
				}
			}
			close(disconnected)
		})
		defer stop()
		request := SSHRequest{Operation: protocol.GitUploadPack}
		_, err := RelayGit(context.Background(), socket, request, bytes.NewReader(nil), failingWriter{}, io.Discard)
		if err == nil {
			t.Fatal("writer failure accepted")
		}
		select {
		case <-disconnected:
		case <-time.After(time.Second):
			t.Fatal("server not disconnected")
		}
	})
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

type blockingReader struct{ done <-chan struct{} }

func (reader *blockingReader) Read([]byte) (int, error) { <-reader.done; return 0, context.Canceled }

func startGitServer(t *testing.T, handler func(net.Conn, protocol.Frame)) (string, chan []byte, func()) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			request, readErr := protocol.ReadFrame(conn, protocol.DefaultLimits())
			if readErr != nil {
				t.Errorf("read request: %v", readErr)
				return
			}
			handler(conn, request)
		}
	}()
	return socket, received, func() { _ = listener.Close(); <-done }
}

func drainGitInput(t *testing.T, conn net.Conn) {
	t.Helper()
	for {
		frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
		if err != nil {
			t.Errorf("read Git input: %v", err)
			return
		}
		if frame.Kind == protocol.EndInput {
			return
		}
		if frame.Kind != protocol.StdinData {
			t.Errorf("unexpected Git input kind: %v", frame.Kind)
			return
		}
	}
}
