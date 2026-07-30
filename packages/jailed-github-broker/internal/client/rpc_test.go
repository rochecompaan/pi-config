package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestExecuteAPISendsTypedRequestAndCollectsChunks(t *testing.T) {
	var received chan protocol.ControlRequestBody
	socket, received, stop := startProtocolServer(t, func(conn net.Conn) {
		frame, err := protocol.ReadFrame(conn, protocol.DefaultLimits())
		if err != nil {
			t.Errorf("read: %v", err)
			return
		}
		var body protocol.ControlRequestBody
		if err := json.Unmarshal(frame.Payload, &body); err != nil {
			t.Errorf("control: %v", err)
			return
		}
		received <- body
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: frame.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: frame.RequestID, Payload: []byte(`{"num`)})
		writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: frame.RequestID, Payload: []byte(`ber":1}`)})
		writeTestFrame(t, conn, protocol.ExitFrame(frame.RequestID, 0))
	})
	defer stop()
	request, err := ParseGH([]string{"issue", "view", "1"}, "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	output, status, err := ExecuteAPI(context.Background(), socket, request)
	if err != nil || status != 0 || !bytes.Equal(output, []byte(`{"number":1}`)) {
		t.Fatalf("output=%q status=%d err=%v", output, status, err)
	}
	body := <-received
	if body.Version != int(protocol.Version) || body.RequestID == 0 || body.Operation != protocol.IssuesGet || string(body.Arguments) != `{"number":1}` {
		t.Fatalf("body = %#v args=%s", body, body.Arguments)
	}
}

func TestExecuteAPIPropagatesServerErrorAndExitStatus(t *testing.T) {
	t.Run("structured rejection", func(t *testing.T) {
		socket, _, stop := startProtocolServer(t, func(conn net.Conn) {
			frame, _ := protocol.ReadFrame(conn, protocol.DefaultLimits())
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.Error, RequestID: frame.RequestID, Payload: []byte(`{"message":"request rejected"}`)})
		})
		defer stop()
		request, _ := ParseGH([]string{"repo", "view"}, "owner/repo")
		if _, _, err := ExecuteAPI(context.Background(), socket, request); !errors.Is(err, ErrRejected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("malformed structured rejection", func(t *testing.T) {
		socket, _, stop := startProtocolServer(t, func(conn net.Conn) {
			frame, _ := protocol.ReadFrame(conn, protocol.DefaultLimits())
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.Error, RequestID: frame.RequestID, Payload: []byte(`{"message":"request rejected","unexpected":true}`)})
		})
		defer stop()
		request, _ := ParseGH([]string{"repo", "view"}, "owner/repo")
		if _, _, err := ExecuteAPI(context.Background(), socket, request); err == nil || errors.Is(err, ErrRejected) {
			t.Fatalf("malformed structured error accepted as a broker rejection: %v", err)
		}
	})
	t.Run("host status", func(t *testing.T) {
		socket, _, stop := startProtocolServer(t, func(conn net.Conn) {
			frame, _ := protocol.ReadFrame(conn, protocol.DefaultLimits())
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: frame.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
			writeTestFrame(t, conn, protocol.ExitFrame(frame.RequestID, 17))
		})
		defer stop()
		request, _ := ParseGH([]string{"repo", "view"}, "owner/repo")
		output, status, err := ExecuteAPI(context.Background(), socket, request)
		if err != nil || status != 17 || len(output) != 0 {
			t.Fatalf("output=%q status=%d err=%v", output, status, err)
		}
	})
}

func TestClientRejectsHostileNegotiatedStreamLimit(t *testing.T) {
	conn, peer := net.Pipe()
	session := newClientSession(context.Background(), conn, protocol.API, 1)
	defer session.Close()
	defer peer.Close()
	if err := session.accept(protocol.ClientToServer, protocol.Frame{Kind: protocol.ControlRequest, RequestID: 1}); err != nil {
		t.Fatalf("establish request state: %v", err)
	}

	written := make(chan error, 1)
	go func() {
		written <- protocol.WriteFrame(peer, protocol.Frame{
			Kind: protocol.ControlResponse, RequestID: 1,
			Payload: protocol.EncodeAcceptance(^uint32(0)),
		}, protocol.DefaultLimits())
	}()
	if err := acceptResponse(session, 1); err == nil {
		t.Fatal("client accepted hostile negotiated stream limit")
	}
	if got := session.frameLimits().MaxStreamBytes; got != protocol.DefaultLimits().MaxStreamBytes {
		t.Fatalf("client installed hostile stream limit %d", got)
	}
	if err := <-written; err != nil {
		t.Fatalf("write hostile acceptance: %v", err)
	}
}

func TestExecuteAPIRejectsInvalidServerTranscript(t *testing.T) {
	tests := []struct {
		name    string
		handler func(net.Conn, protocol.Frame)
	}{
		{"data before acceptance", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID, Payload: []byte("x")})
		}},
		{"acceptance ID mismatch", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID + 1, Payload: []byte(`{}`)})
		}},
		{"stderr after acceptance", func(conn net.Conn, request protocol.Frame) {
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: request.RequestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StderrData, RequestID: request.RequestID, Payload: []byte("secret")})
		}},
		{"stream ID mismatch", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID + 1, Payload: []byte("x")})
		}},
		{"client direction from server", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdinData, RequestID: request.RequestID, Payload: []byte("x")})
		}},
		{"duplicate exit", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
		}},
		{"stdout after exit", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StdoutData, RequestID: request.RequestID, Payload: []byte("late")})
		}},
		{"stderr after exit", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			writeTestFrame(t, conn, protocol.Frame{Kind: protocol.StderrData, RequestID: request.RequestID, Payload: []byte("late")})
		}},
		{"trailing byte", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			if _, err := conn.Write([]byte{0xff}); err != nil {
				t.Errorf("write trailing byte: %v", err)
			}
		}},
		{"missing close", func(conn net.Conn, request protocol.Frame) {
			writeAccepted(t, conn, request.RequestID)
			writeTestFrame(t, conn, protocol.ExitFrame(request.RequestID, 0))
			var one [1]byte
			_, _ = conn.Read(one[:])
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			socket, _, stop := startProtocolServer(t, func(conn net.Conn) {
				frame, _ := protocol.ReadFrame(conn, protocol.DefaultLimits())
				test.handler(conn, frame)
			})
			defer stop()
			request, _ := ParseGH([]string{"repo", "view"}, "owner/repo")
			ctx := context.Background()
			cancel := func() {}
			if test.name == "missing close" {
				ctx, cancel = context.WithTimeout(ctx, 2*terminalCloseTimeout)
			}
			_, _, err := ExecuteAPI(ctx, socket, request)
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

func TestOpenRequestCancellationInterruptsInitialWrite(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	accepted := make(chan struct{})
	releasePeer := make(chan struct{})
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		close(accepted)
		<-releasePeer
	}()

	arguments := json.RawMessage(`{"padding":"` + string(bytes.Repeat([]byte("x"), 900<<10)) + `"}`)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		session, _, openErr := openRequest(ctx, socket, protocol.RepositoryGet, arguments, protocol.API)
		if session != nil {
			_ = session.Close()
		}
		result <- openErr
	}()
	<-accepted
	cancel()
	select {
	case openErr := <-result:
		if openErr == nil {
			t.Fatal("initial request write succeeded without a draining peer")
		}
	case <-time.After(time.Second):
		close(releasePeer)
		_ = listener.Close()
		<-peerDone
		t.Fatal("cancellation did not interrupt the initial request write")
	}
	close(releasePeer)
	_ = listener.Close()
	<-peerDone
}

func TestClientSessionCloseIsIdempotent(t *testing.T) {
	conn, peer := net.Pipe()
	defer peer.Close()
	session := newClientSession(context.Background(), conn, protocol.API, 1)
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- session.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second client session close blocked")
	}
}

func TestRunGHRejectsLocallyBeforeConnecting(t *testing.T) {
	var stdout, stderr bytes.Buffer
	status := RunGH(context.Background(), filepath.Join(t.TempDir(), "absent.sock"), "owner/repo", []string{"api", "/user"}, &stdout, &stderr)
	if status != 2 || stdout.Len() != 0 || stderr.String() != "gh: unsupported or invalid command\n" {
		t.Fatalf("status=%d stdout=%q stderr=%q", status, stdout.String(), stderr.String())
	}
}

func TestExecuteAPICancelsBlockedConnection(t *testing.T) {
	socket, _, stop := startProtocolServer(t, func(conn net.Conn) {
		_, _ = protocol.ReadFrame(conn, protocol.DefaultLimits())
		<-time.After(time.Second)
	})
	defer stop()
	request, _ := ParseGH([]string{"repo", "view"}, "owner/repo")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	_, _, err := ExecuteAPI(ctx, socket, request)
	if err == nil || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("err=%v duration=%v", err, time.Since(started))
	}
}

func startProtocolServer(t *testing.T, handler func(net.Conn)) (string, chan protocol.ControlRequestBody, func()) {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan protocol.ControlRequestBody, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err == nil {
			defer conn.Close()
			handler(conn)
		}
	}()
	return socket, received, func() { _ = listener.Close(); <-done }
}

func writeTestFrame(t *testing.T, conn net.Conn, frame protocol.Frame) {
	t.Helper()
	if err := protocol.WriteFrame(conn, frame, protocol.DefaultLimits()); err != nil {
		t.Errorf("write: %v", err)
	}
}

func writeAccepted(t *testing.T, conn net.Conn, requestID uint32) {
	t.Helper()
	writeTestFrame(t, conn, protocol.Frame{Kind: protocol.ControlResponse, RequestID: requestID, Payload: protocol.EncodeAcceptance(protocol.DefaultLimits().MaxStreamBytes)})
}
