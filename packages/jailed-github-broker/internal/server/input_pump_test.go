package server

import (
	"context"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestGitDisconnectWhileSSHStdinBlockedReleasesProcessAndSlot(t *testing.T) {
	pidFile := configureNonReadingSSH(t)
	server := newGitServerWithTimeouts(t, 5*time.Second, 5*time.Second, config.GitRead)
	server.cfg.Limits.MaxConcurrentRequests = 1
	server.cfg.Limits.MaxStreamFrameBytes = int(protocol.DefaultLimits().MaxStreamBytes)
	server.limits.MaxStreamBytes = protocol.DefaultLimits().MaxStreamBytes
	listener, cancel, done := serveUnix(t, server)
	defer func() {
		cancel()
		_ = listener.Close()
		<-done
	}()

	client := dialUnix(t, listener.Addr().String())
	writeRequest(t, client, 61, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	waitForFile(t, pidFile)
	pid := readPIDFile(t, pidFile)
	payload := make([]byte, server.limits.MaxStreamBytes)
	if err := protocol.WriteFrame(client, protocol.Frame{Kind: protocol.StdinData, RequestID: 61, Payload: payload}, server.limits); err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}

	if !waitForAcceptedRequest(listener.Addr().String(), protocol.GitUploadPack, 900*time.Millisecond) {
		t.Fatal("disconnect while SSH stdin was blocked retained the only concurrency slot")
	}
	waitForProcessGone(t, pid)
}

func TestGitInputQueueSaturationCancelsStream(t *testing.T) {
	limits := protocol.Limits{MaxControlBytes: 1024, MaxStreamBytes: 64 * 1024}
	session := &sessionGuard{session: protocol.NewSession(protocol.Git)}
	if err := session.accept(protocol.ClientToServer, protocol.Frame{Kind: protocol.ControlRequest, RequestID: 62}); err != nil {
		t.Fatal(err)
	}
	if err := session.accept(protocol.ServerToClient, protocol.Frame{Kind: protocol.ControlResponse, RequestID: 62}); err != nil {
		t.Fatal(err)
	}
	serverConn, client := net.Pipe()
	streamCtx, cancelStream := context.WithCancel(context.Background())
	pump := newInputPump(context.Background(), serverConn, limits, session, cancelStream)
	defer func() {
		_ = client.Close()
		_ = pump.Close()
	}()

	payload := make([]byte, limits.MaxStreamBytes)
	for range int(inputQueueByteCapacity/uint64(limits.MaxStreamBytes)) + 1 {
		if err := protocol.WriteFrame(client, protocol.Frame{Kind: protocol.StdinData, RequestID: 62, Payload: payload}, limits); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-streamCtx.Done():
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("queue accepted more than %d bytes without canceling the stream", inputQueueByteCapacity)
	}
}

func configureNonReadingSSH(t *testing.T) string {
	t.Helper()
	configureSSHHelper(t, "no-read", nil)
	pidFile := filepath.Join(t.TempDir(), "ssh.pid")
	t.Setenv("SSH_HELPER_PID_FILE", pidFile)
	return pidFile
}
