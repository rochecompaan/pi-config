package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

// An Exit frame is final and the broker handler closes its local Unix socket
// immediately on return. This bound permits local scheduling delay without
// allowing a peer to hold a successful request open indefinitely.
const terminalCloseTimeout = 250 * time.Millisecond

type clientSession struct {
	conn      net.Conn
	protocol  *protocol.Session
	requestID uint32
	limits    protocol.Limits

	sessionMu  sync.Mutex
	writeMu    sync.Mutex
	inputMu    sync.Mutex
	input      io.Reader
	inputDone  bool
	closeOnce  sync.Once
	cancelOnce sync.Once

	stopCancel func() bool
	cancelDone chan struct{}
}

func newClientSession(ctx context.Context, conn net.Conn, mode protocol.Mode, requestID uint32) *clientSession {
	session := &clientSession{
		conn: conn, protocol: protocol.NewSession(mode), requestID: requestID,
		limits: protocol.DefaultLimits(), cancelDone: make(chan struct{}),
	}
	stop := context.AfterFunc(ctx, func() {
		session.shutdown()
		close(session.cancelDone)
	})
	session.stopCancel = stop
	return session
}

func (session *clientSession) Close() error {
	session.shutdown()
	session.cancelOnce.Do(func() {
		if !session.stopCancel() {
			<-session.cancelDone
		}
	})
	return nil
}

func (session *clientSession) shutdown() {
	session.closeOnce.Do(func() {
		session.stopInput()
		_ = session.conn.Close()
	})
}

func (session *clientSession) send(kind protocol.Kind, payload []byte) error {
	frame := protocol.Frame{Kind: kind, RequestID: session.requestID, Payload: payload}
	session.writeMu.Lock()
	defer session.writeMu.Unlock()
	if err := session.accept(protocol.ClientToServer, frame); err != nil {
		return err
	}
	if err := protocol.WriteFrame(session.conn, frame, session.frameLimits()); err != nil {
		session.shutdown()
		return err
	}
	return nil
}

func (session *clientSession) readServer() (protocol.Frame, error) {
	frame, err := protocol.ReadFrame(session.conn, session.frameLimits())
	if err != nil {
		return protocol.Frame{}, err
	}
	if err := session.accept(protocol.ServerToClient, frame); err != nil {
		return protocol.Frame{}, err
	}
	if frame.Kind == protocol.Exit || frame.Kind == protocol.Error {
		session.stopInput()
	}
	return frame, nil
}

func (session *clientSession) setStreamLimit(maxStreamBytes uint32) {
	session.sessionMu.Lock()
	session.limits.MaxStreamBytes = maxStreamBytes
	session.sessionMu.Unlock()
}

func (session *clientSession) frameLimits() protocol.Limits {
	session.sessionMu.Lock()
	defer session.sessionMu.Unlock()
	return session.limits
}

func (session *clientSession) accept(direction protocol.Direction, frame protocol.Frame) error {
	session.sessionMu.Lock()
	defer session.sessionMu.Unlock()
	return session.protocol.Accept(direction, frame)
}

func (session *clientSession) pumpInput(input io.Reader) error {
	session.setInput(input)
	buffer := make([]byte, session.frameLimits().MaxStreamBytes)
	for {
		count, err := input.Read(buffer)
		if session.inputStopped() {
			return nil
		}
		if count > 0 {
			if writeErr := session.send(protocol.StdinData, buffer[:count]); writeErr != nil {
				return writeErr
			}
		}
		if err == io.EOF {
			return session.send(protocol.EndInput, nil)
		}
		if err != nil {
			session.shutdown()
			return err
		}
		if count == 0 {
			session.shutdown()
			return io.ErrNoProgress
		}
	}
}

func (session *clientSession) setInput(input io.Reader) {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	if session.inputDone {
		closeInput(input)
		return
	}
	session.input = input
}

func (session *clientSession) stopInput() {
	session.inputMu.Lock()
	if session.inputDone {
		session.inputMu.Unlock()
		return
	}
	session.inputDone = true
	input := session.input
	session.inputMu.Unlock()
	closeInput(input)
}

func (session *clientSession) inputStopped() bool {
	session.inputMu.Lock()
	defer session.inputMu.Unlock()
	return session.inputDone
}

func closeInput(input io.Reader) {
	if closer, ok := input.(io.Closer); ok {
		_ = closer.Close()
	}
}

func (session *clientSession) requireEOF() error {
	if err := session.conn.SetReadDeadline(time.Now().Add(terminalCloseTimeout)); err != nil {
		return fmt.Errorf("set terminal close deadline: %w", err)
	}
	defer session.conn.SetReadDeadline(time.Time{})
	var trailing [1]byte
	count, err := session.conn.Read(trailing[:])
	if count != 0 || err == nil {
		return fmt.Errorf("broker sent trailing data after terminal frame")
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		return fmt.Errorf("broker did not close after terminal frame")
	}
	return fmt.Errorf("validate broker terminal close: %w", err)
}
