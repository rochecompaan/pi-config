package server

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

type sessionGuard struct {
	session         *protocol.Session
	mu              sync.Mutex
	writeMu         sync.Mutex
	transportMu     sync.Mutex
	transportFailed bool
}

func (server *Server) writeError(ctx context.Context, conn net.Conn, session *sessionGuard, requestID uint32) {
	frame := protocol.Frame{Kind: protocol.Error, RequestID: requestID, Payload: []byte(`{"message":"request rejected"}`)}
	_ = session.send(ctx, conn, frame, server.limits, server.idleTimeout)
}

func (server *Server) writeSessionFrame(ctx context.Context, conn net.Conn, session *sessionGuard, frame protocol.Frame) bool {
	return session.send(ctx, conn, frame, server.limits, server.idleTimeout) == nil
}

func (server *Server) writeTerminalFrame(requestCtx context.Context, conn net.Conn, session *sessionGuard, requestID uint32, status int32) bool {
	writeCtx, cancelWrite := context.WithTimeout(requestCtx, server.idleTimeout)
	defer cancelWrite()
	return server.writeSessionFrame(writeCtx, conn, session, protocol.ExitFrame(requestID, status))
}

func (guard *sessionGuard) send(ctx context.Context, conn net.Conn, frame protocol.Frame, limits protocol.Limits, idleTimeout time.Duration) error {
	guard.writeMu.Lock()
	defer guard.writeMu.Unlock()
	if !guard.transportWritable() {
		return net.ErrClosed
	}
	if err := guard.accept(protocol.ServerToClient, frame); err != nil {
		return err
	}
	deadline := time.Now().Add(idleTimeout)
	if operationDeadline, ok := ctx.Deadline(); ok && operationDeadline.Before(deadline) {
		deadline = operationDeadline
	}
	if err := conn.SetWriteDeadline(deadline); err != nil {
		guard.markTransportFailed()
		return err
	}
	unblocked := make(chan struct{})
	stopUnblock := context.AfterFunc(ctx, func() {
		_ = conn.SetWriteDeadline(time.Now())
		close(unblocked)
	})
	err := protocol.WriteFrame(conn, frame, limits)
	if !stopUnblock() {
		<-unblocked
	}
	if err != nil {
		guard.markTransportFailed()
	}
	return err
}

func (guard *sessionGuard) markTransportFailed() {
	guard.transportMu.Lock()
	guard.transportFailed = true
	guard.transportMu.Unlock()
}

func (guard *sessionGuard) transportWritable() bool {
	guard.transportMu.Lock()
	defer guard.transportMu.Unlock()
	return !guard.transportFailed
}

func (guard *sessionGuard) accept(direction protocol.Direction, frame protocol.Frame) error {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	return guard.session.Accept(direction, frame)
}
