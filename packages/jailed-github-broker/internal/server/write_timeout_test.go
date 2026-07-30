package server

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestInitialFrameDeadlineIncludesHandlerSchedulingDelay(t *testing.T) {
	server := newTestServer(t, &fakeCaller{}, config.RepositoryRead)
	server.cfg.Limits.InitialFrameTimeoutSeconds = 1
	serverConn, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		server.handle(context.Background(), serverConn, time.Now().Add(-2*time.Second))
		close(done)
	}()

	assertClosedWithin(t, client, 200*time.Millisecond)
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("handler retained a socket whose accept-time deadline had elapsed")
	}
	_ = client.Close()
}

func TestNonReadingAPIClientReleasesConcurrencySlotAtOperationTimeout(t *testing.T) {
	description := strings.Repeat("x", 900_000)
	caller := &fakeCaller{result: github.Result{Stdout: []byte(fmt.Sprintf(
		`{"name":"demo","owner":{"login":"acme"},"full_name":"acme/demo","description":%q,"private":false,"default_branch":"main","html_url":"https://github.com/acme/demo"}`,
		description,
	))}}
	server := newTestServer(t, caller, config.RepositoryRead)
	server.cfg.Limits.MaxConcurrentRequests = 1
	server.cfg.Limits.OperationTimeoutSeconds = 1
	server.cfg.Limits.IdleStreamTimeoutSeconds = 1
	server.operationTimeout = time.Second
	server.idleTimeout = time.Second
	server.limits.MaxStreamBytes = 64 * 1024
	listener, cancel, done := serveUnix(t, server)

	first := dialUnix(t, listener.Addr().String())
	writeRequest(t, first, 51, protocol.RepositoryGet, `{}`)
	waitForCallCount(t, caller, 1)
	second := dialUnix(t, listener.Addr().String())
	assertClosedWithin(t, second, 300*time.Millisecond)
	_ = second.Close()

	accepted := waitForAcceptedRequest(listener.Addr().String(), protocol.RepositoryGet, 2*time.Second)
	_ = first.Close()
	cancel()
	_ = listener.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve did not return after cleanup")
	}
	if !accepted {
		t.Fatal("API client retained the only concurrency slot beyond the operation timeout")
	}
}

func TestNonReadingGitClientReleasesAfterOneFailedStdoutWrite(t *testing.T) {
	configureSSHHelper(t, "flood", nil)
	pidFile := t.TempDir() + "/ssh.pid"
	t.Setenv("SSH_HELPER_PID_FILE", pidFile)
	server := newGitServerWithTimeouts(t, 5*time.Second, time.Second, config.GitRead)
	server.cfg.Limits.MaxConcurrentRequests = 1
	server.idleTimeout = 250 * time.Millisecond
	server.limits.MaxStreamBytes = 64 * 1024
	listener, cancel, done := servePipes(server)
	defer func() {
		cancel()
		_ = listener.Close()
		<-done
	}()

	first, observed := connectObservedPipe(listener)
	defer first.Close()
	writeRequest(t, first, 52, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, first); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	started := time.Now()
	waitForFile(t, pidFile)
	pidText, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidText)))
	if err != nil {
		t.Fatal(err)
	}
	second := connectPipe(listener)
	assertClosedWithin(t, second, 300*time.Millisecond)
	_ = second.Close()

	if !waitForAcceptedPipeRequest(listener, protocol.GitUploadPack, 900*time.Millisecond) {
		t.Fatal("failed stdout write retained the only concurrency slot")
	}
	waitForProcessGone(t, pid)
	if elapsed := time.Since(started); elapsed >= 450*time.Millisecond {
		t.Fatalf("failed stdout write retained process/handler for %s, want one 250ms write deadline", elapsed)
	}
	if writes := observed.writeCount(); writes != 3 {
		t.Fatalf("server Write calls = %d, want control header/payload and one failed stdout write with no terminal retry", writes)
	}
}

func TestNonReadingGitDiagnosticReleasesAfterOneFailedWrite(t *testing.T) {
	configureSSHHelper(t, "stderr-flood", nil)
	pidFile := t.TempDir() + "/ssh.pid"
	t.Setenv("SSH_HELPER_PID_FILE", pidFile)
	server := newGitServerWithTimeouts(t, 5*time.Second, time.Second, config.GitRead)
	server.cfg.Limits.MaxConcurrentRequests = 1
	server.idleTimeout = 250 * time.Millisecond
	listener, cancel, done := servePipes(server)
	defer func() {
		cancel()
		_ = listener.Close()
		<-done
	}()

	first, observed := connectObservedPipe(listener)
	defer first.Close()
	writeRequest(t, first, 53, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, first); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	started := time.Now()
	waitForFile(t, pidFile)
	pidText, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidText)))
	if err != nil {
		t.Fatal(err)
	}

	second := connectPipe(listener)
	assertClosedWithin(t, second, 300*time.Millisecond)
	_ = second.Close()

	if !waitForAcceptedPipeRequest(listener, protocol.GitUploadPack, 900*time.Millisecond) {
		t.Fatal("failed stderr diagnostic retained the only concurrency slot")
	}
	waitForProcessGone(t, pid)
	if elapsed := time.Since(started); elapsed >= 450*time.Millisecond {
		t.Fatalf("failed diagnostic retained process/handler for %s, want one 250ms write deadline", elapsed)
	}
	if writes := observed.writeCount(); writes != 3 {
		t.Fatalf("server Write calls = %d, want control header/payload and one failed diagnostic write with no terminal retry", writes)
	}
}

func waitForCallCount(t *testing.T, caller *fakeCaller, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if caller.count() >= count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("caller count = %d, want at least %d", caller.count(), count)
}

func waitForAcceptedRequest(address string, operation protocol.Operation, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("unix", address, 100*time.Millisecond)
		if err != nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		_ = conn.SetDeadline(time.Now().Add(300 * time.Millisecond))
		payload := []byte(fmt.Sprintf(`{"version":1,"requestId":99,"operation":%q,"arguments":{}}`, operation))
		err = protocol.WriteFrame(conn, protocol.Frame{Kind: protocol.ControlRequest, RequestID: 99, Payload: payload}, protocol.DefaultLimits())
		if err == nil {
			var frame protocol.Frame
			frame, err = protocol.ReadFrame(conn, protocol.DefaultLimits())
			if err == nil && frame.Kind == protocol.ControlResponse {
				_ = conn.Close()
				return true
			}
		}
		_ = conn.Close()
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

type pipeListener struct {
	connections chan net.Conn
	closed      chan struct{}
	once        sync.Once
}

func servePipes(server *Server) (*pipeListener, context.CancelFunc, <-chan error) {
	listener := &pipeListener{connections: make(chan net.Conn), closed: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, listener) }()
	return listener, cancel, done
}

func connectPipe(listener *pipeListener) net.Conn {
	server, client := net.Pipe()
	listener.connections <- server
	return client
}

type observedConn struct {
	net.Conn
	mu     sync.Mutex
	writes int
}

func connectObservedPipe(listener *pipeListener) (net.Conn, *observedConn) {
	server, client := net.Pipe()
	observed := &observedConn{Conn: server}
	listener.connections <- observed
	return client, observed
}

func (conn *observedConn) Write(value []byte) (int, error) {
	conn.mu.Lock()
	conn.writes++
	conn.mu.Unlock()
	return conn.Conn.Write(value)
}

func (conn *observedConn) writeCount() int {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	return conn.writes
}

func waitForAcceptedPipeRequest(listener *pipeListener, operation protocol.Operation, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn := connectPipe(listener)
		_ = conn.SetDeadline(time.Now().Add(300 * time.Millisecond))
		payload := []byte(fmt.Sprintf(`{"version":1,"requestId":99,"operation":%q,"arguments":{}}`, operation))
		err := protocol.WriteFrame(conn, protocol.Frame{Kind: protocol.ControlRequest, RequestID: 99, Payload: payload}, protocol.DefaultLimits())
		if err == nil {
			frame, readErr := protocol.ReadFrame(conn, protocol.DefaultLimits())
			if readErr == nil && frame.Kind == protocol.ControlResponse {
				_ = conn.Close()
				return true
			}
		}
		_ = conn.Close()
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func (listener *pipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-listener.connections:
		return conn, nil
	case <-listener.closed:
		return nil, net.ErrClosed
	}
}

func (listener *pipeListener) Close() error {
	listener.once.Do(func() { close(listener.closed) })
	return nil
}

func (listener *pipeListener) Addr() net.Addr { return pipeAddr{} }

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }
