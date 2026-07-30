package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

type fakeCaller struct {
	mu     sync.Mutex
	calls  []github.Call
	result github.Result
	err    *github.CallerError
	block  bool
	done   chan struct{}
}

func (caller *fakeCaller) Call(ctx context.Context, call github.Call) (github.Result, *github.CallerError) {
	caller.mu.Lock()
	caller.calls = append(caller.calls, call)
	caller.mu.Unlock()
	if caller.block {
		<-ctx.Done()
		if caller.done != nil {
			close(caller.done)
		}
		return github.Result{}, &github.CallerError{ExitStatus: 1}
	}
	return caller.result, caller.err
}

func (caller *fakeCaller) count() int {
	caller.mu.Lock()
	defer caller.mu.Unlock()
	return len(caller.calls)
}

func TestAPISuccessChunksOutputAndSendsExactlyOneExit(t *testing.T) {
	caller := &fakeCaller{result: github.Result{Stdout: []byte(`{"name":"demo","owner":{"login":"acme"},"full_name":"acme/demo","description":null,"private":false,"default_branch":"main","html_url":"https://github.com/acme/demo"}`)}}
	server := newTestServer(t, caller, config.RepositoryRead)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 41, protocol.RepositoryGet, `{}`)
	frames := readThroughExit(t, client)
	if len(frames) < 3 || frames[0].Kind != protocol.ControlResponse {
		t.Fatalf("frames = %#v, want response, chunked stdout, exit", frames)
	}
	var stdout []byte
	exits := 0
	for _, frame := range frames[1:] {
		switch frame.Kind {
		case protocol.StdoutData:
			if len(frame.Payload) > 16 {
				t.Fatalf("stdout frame has %d bytes, limit 16", len(frame.Payload))
			}
			stdout = append(stdout, frame.Payload...)
		case protocol.Exit:
			exits++
			status, err := protocol.DecodeExitStatus(frame)
			if err != nil || status != 0 {
				t.Fatalf("exit = %d, %v", status, err)
			}
		default:
			t.Fatalf("unexpected frame kind %v", frame.Kind)
		}
	}
	if exits != 1 || len(stdout) <= 16 || !json.Valid(stdout) {
		t.Fatalf("exits=%d stdout=%q", exits, stdout)
	}
}

func TestAPIFailurePreservesExitWithoutHostDiagnostic(t *testing.T) {
	caller := &fakeCaller{err: &github.CallerError{ExitStatus: 23}}
	server := newTestServer(t, caller, config.RepositoryRead)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 7, protocol.RepositoryGet, `{}`)
	frames := readThroughExit(t, client)
	if len(frames) != 2 || frames[0].Kind != protocol.ControlResponse || frames[1].Kind != protocol.Exit {
		t.Fatalf("frames = %#v", frames)
	}
	status, _ := protocol.DecodeExitStatus(frames[1])
	if status != 23 {
		t.Fatalf("status = %d, want 23", status)
	}
}

func TestAPIOperationTimeoutSendsExactlyOneCompleteNonzeroExit(t *testing.T) {
	caller := &fakeCaller{block: true}
	server := newTestServer(t, caller, config.RepositoryRead)
	server.operationTimeout = 100 * time.Millisecond
	server.idleTimeout = 500 * time.Millisecond
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 8, protocol.RepositoryGet, `{}`)
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

func TestCapabilityAndRepositoryInjectionFailBeforeCaller(t *testing.T) {
	for _, test := range []struct {
		name      string
		operation protocol.Operation
		args      string
	}{
		{name: "capability", operation: protocol.IssuesList, args: `{"state":"open","limit":1}`},
		{name: "repository field", operation: protocol.RepositoryGet, args: `{"repository":"evil/other"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			caller := &fakeCaller{}
			server := newTestServer(t, caller, config.RepositoryRead)
			client, stop := startServer(t, server)
			defer stop()
			writeRequest(t, client, 9, test.operation, test.args)
			frame := readFrame(t, client)
			if frame.Kind != protocol.Error || frame.RequestID != 9 || caller.count() != 0 {
				t.Fatalf("frame=%#v calls=%d", frame, caller.count())
			}
		})
	}
}

func TestAPIClientStreamFrameCancelsHostCall(t *testing.T) {
	caller := &fakeCaller{block: true, done: make(chan struct{})}
	server := newTestServer(t, caller, config.RepositoryRead)
	client, stop := startServer(t, server)
	defer stop()
	writeRequest(t, client, 11, protocol.RepositoryGet, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame kind = %v", frame.Kind)
	}
	writeFrame(t, client, protocol.Frame{Kind: protocol.StdinData, RequestID: 11, Payload: []byte("forbidden")})
	select {
	case <-caller.done:
	case <-time.After(time.Second):
		t.Fatal("host call was not canceled after invalid API stream frame")
	}
}

func TestAcceptedSocketConcurrencyAndInitialDeadline(t *testing.T) {
	caller := &fakeCaller{}
	server := newTestServer(t, caller, config.RepositoryRead)
	server.cfg.Limits.MaxConcurrentRequests = 1
	server.cfg.Limits.InitialFrameTimeoutSeconds = 1
	listener, cancel, done := serveUnix(t, server)
	defer func() { cancel(); <-done }()

	first := dialUnix(t, listener.Addr().String())
	defer first.Close()
	if _, err := first.Write([]byte{protocol.Version, byte(protocol.ControlRequest)}); err != nil {
		t.Fatal(err)
	}
	second := dialUnix(t, listener.Addr().String())
	defer second.Close()
	assertClosedWithin(t, second, 300*time.Millisecond)
	assertClosedWithin(t, first, 1500*time.Millisecond)
}

func TestInvalidSocketDoesNotAffectAnotherSocket(t *testing.T) {
	caller := &fakeCaller{result: github.Result{Stdout: []byte(`{"name":"demo","private":false,"default_branch":"main","html_url":"https://github.com/acme/demo"}`)}}
	server := newTestServer(t, caller, config.RepositoryRead)
	listener, cancel, done := serveUnix(t, server)
	defer func() { cancel(); <-done }()

	bad := dialUnix(t, listener.Addr().String())
	writeFrame(t, bad, protocol.Frame{Kind: protocol.StdinData, RequestID: 1})
	assertClosedWithin(t, bad, time.Second)
	bad.Close()

	good := dialUnix(t, listener.Addr().String())
	defer good.Close()
	writeRequest(t, good, 2, protocol.RepositoryGet, `{}`)
	frames := readThroughExit(t, good)
	if frames[len(frames)-1].Kind != protocol.Exit {
		t.Fatalf("good socket frames = %#v", frames)
	}
}

func newTestServer(t *testing.T, caller github.Caller, capabilities ...config.Capability) *Server {
	t.Helper()
	cfg := config.Config{
		Enable: true, Repository: "acme/demo", Capabilities: capabilities,
		PushPolicy: config.DefaultPushPolicy(), Limits: config.DefaultLimits(),
	}
	cfg.Limits.MaxStreamFrameBytes = 16
	server, err := New(Options{Config: cfg, APICaller: caller, SSHExecutable: "/bin/false", WorkingDirectory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func startServer(t *testing.T, server *Server) (net.Conn, func()) {
	t.Helper()
	listener, cancel, done := serveUnix(t, server)
	client := dialUnix(t, listener.Addr().String())
	return client, func() { client.Close(); cancel(); <-done }
}

func serveUnix(t *testing.T, server *Server) (net.Listener, context.CancelFunc, <-chan error) {
	t.Helper()
	listener, err := net.Listen("unix", filepath.Join(t.TempDir(), "broker.sock"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	return listener, func() { cancel(); listener.Close() }, done
}

func dialUnix(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", address)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func writeRequest(t *testing.T, conn net.Conn, id uint32, operation protocol.Operation, args string) {
	t.Helper()
	payload := []byte(`{"version":1,"requestId":` + jsonNumber(id) + `,"operation":"` + string(operation) + `","arguments":` + args + `}`)
	writeFrame(t, conn, protocol.Frame{Kind: protocol.ControlRequest, RequestID: id, Payload: payload})
}

func jsonNumber(id uint32) string {
	data, _ := json.Marshal(id)
	return string(data)
}

func writeFrame(t *testing.T, conn net.Conn, frame protocol.Frame) {
	t.Helper()
	limits := protocol.DefaultLimits()
	if err := protocol.WriteFrame(conn, frame, limits); err != nil {
		t.Fatal(err)
	}
}

func readFrame(t *testing.T, conn net.Conn) protocol.Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

func readThroughExit(t *testing.T, conn net.Conn) []protocol.Frame {
	t.Helper()
	var frames []protocol.Frame
	for {
		frame := readFrame(t, conn)
		frames = append(frames, frame)
		if frame.Kind == protocol.Exit || frame.Kind == protocol.Error {
			return frames
		}
	}
}

func assertClosedWithin(t *testing.T, conn net.Conn, timeout time.Duration) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	var byte [1]byte
	_, err := conn.Read(byte[:])
	if err == nil {
		t.Fatal("connection remained readable")
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		t.Fatalf("connection not closed within %s", timeout)
	}
	if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		// Unix peers can report reset; any non-timeout read error proves closure.
		return
	}
}
