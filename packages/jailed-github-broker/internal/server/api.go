package server

import (
	"context"
	"errors"
	"net"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func (server *Server) dispatchAPI(requestCtx context.Context, conn net.Conn, session *sessionGuard, control protocol.ControlRequestBody) {
	operationCtx, cancelOperation := context.WithTimeout(requestCtx, server.operationTimeout)
	defer cancelOperation()
	request, err := github.Parse(control.Operation, control.Arguments, server.cfg.Repository)
	if err != nil || !server.authorized(github.RequiredCapabilities(request)) {
		server.writeError(operationCtx, conn, session, control.RequestID)
		return
	}
	started := time.Now()
	audit := AuditEvent{
		Operation: control.Operation, RequestID: control.RequestID, Repository: server.cfg.Repository,
		ExitStatus: 1, Refs: github.ValidatedRefNames(request), StdinBytes: int64(len(control.Arguments)),
	}
	defer func() {
		audit.Duration = time.Since(started)
		server.recordAudit(audit)
	}()
	if !server.writeSessionFrame(operationCtx, conn, session, protocol.Frame{
		Kind: protocol.ControlResponse, RequestID: control.RequestID,
		Payload: protocol.EncodeAcceptance(server.limits.MaxStreamBytes),
	}) {
		return
	}
	go server.monitorAPIClient(conn, session, cancelOperation)

	output, executeErr := github.Execute(operationCtx, request, server.apiCaller)
	status := int32(0)
	if executeErr != nil {
		status = exitStatus(executeErr)
	} else {
		audit.StdoutBytes = int64(len(output))
	}
	audit.ExitStatus = int(status)
	if executeErr == nil {
		if err := server.writeStdout(operationCtx, conn, session, control.RequestID, output); err != nil {
			audit.ExitStatus = 1
			cancelOperation()
			return
		}
	}
	if !server.writeTerminalFrame(requestCtx, conn, session, control.RequestID, status) {
		audit.ExitStatus = 1
	}
}

func (server *Server) recordAudit(event AuditEvent) {
	if server.audit != nil {
		server.audit(event)
	}
}

func (server *Server) monitorAPIClient(conn net.Conn, session *sessionGuard, cancel context.CancelFunc) {
	frame, err := protocol.ReadFrame(conn, server.limits)
	if err == nil {
		_ = session.accept(protocol.ClientToServer, frame)
	}
	cancel()
}

func (server *Server) writeStdout(ctx context.Context, conn net.Conn, session *sessionGuard, requestID uint32, output []byte) error {
	for len(output) != 0 {
		length := len(output)
		if length > int(server.limits.MaxStreamBytes) {
			length = int(server.limits.MaxStreamBytes)
		}
		frame := protocol.Frame{Kind: protocol.StdoutData, RequestID: requestID, Payload: append([]byte(nil), output[:length]...)}
		if !server.writeSessionFrame(ctx, conn, session, frame) {
			return net.ErrClosed
		}
		output = output[length:]
	}
	return nil
}

func (server *Server) authorized(required []config.Capability) bool {
	configured := make(map[config.Capability]struct{}, len(server.cfg.Capabilities))
	for _, capability := range server.cfg.Capabilities {
		configured[capability] = struct{}{}
	}
	for _, capability := range required {
		if _, ok := configured[capability]; !ok {
			return false
		}
	}
	return true
}

func exitStatus(err error) int32 {
	var operationError *github.OperationError
	if errors.As(err, &operationError) && operationError.ExitStatus > 0 {
		return int32(operationError.ExitStatus)
	}
	return 1
}
