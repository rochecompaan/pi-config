// Package server dispatches one typed broker request per accepted Unix socket.
package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"sync"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/runner"
)

// Options contains trusted host-side dependencies. Executable and working
// directory paths must be absolute and never come from a client request.
type Options struct {
	Config           config.Config
	APICaller        github.Caller
	SSHExecutable    string
	WorkingDirectory string
	Audit            func(AuditEvent)
}

// Server owns immutable broker policy and host command dependencies.
type Server struct {
	cfg              config.Config
	apiCaller        github.Caller
	limits           protocol.Limits
	sshRunner        *runner.Runner
	operationTimeout time.Duration
	idleTimeout      time.Duration
	audit            func(AuditEvent)
}

// New validates the trusted server wiring.
func New(options Options) (*Server, error) {
	if err := options.Config.Validate(); err != nil {
		return nil, err
	}
	if !options.Config.Enable {
		return nil, fmt.Errorf("broker must be enabled")
	}
	if options.APICaller == nil {
		return nil, fmt.Errorf("API caller is required")
	}
	if !filepath.IsAbs(options.SSHExecutable) {
		return nil, fmt.Errorf("SSH executable must be absolute")
	}
	if !filepath.IsAbs(options.WorkingDirectory) {
		return nil, fmt.Errorf("working directory must be absolute")
	}
	sshRunner, err := runner.New(runner.Config{
		Executable: options.SSHExecutable, WorkingDirectory: options.WorkingDirectory,
		OperationTimeout: time.Duration(options.Config.Limits.OperationTimeoutSeconds) * time.Second,
		IdleTimeout:      time.Duration(options.Config.Limits.IdleStreamTimeoutSeconds) * time.Second,
	})
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg: options.Config, apiCaller: options.APICaller,
		limits: protocol.Limits{
			MaxControlBytes: uint32(options.Config.Limits.MaxControlBytes),
			MaxStreamBytes:  uint32(options.Config.Limits.MaxStreamFrameBytes),
		},
		sshRunner:        sshRunner,
		operationTimeout: time.Duration(options.Config.Limits.OperationTimeoutSeconds) * time.Second,
		idleTimeout:      time.Duration(options.Config.Limits.IdleStreamTimeoutSeconds) * time.Second,
		audit:            options.Audit,
	}, nil
}

// Serve accepts sockets until the context or listener is closed. A socket
// occupies a concurrency slot immediately after Accept, before any frame read.
func (server *Server) Serve(ctx context.Context, listener net.Listener) error {
	if listener == nil {
		return fmt.Errorf("listener is required")
	}
	semaphore := make(chan struct{}, server.cfg.Limits.MaxConcurrentRequests)
	var handlers sync.WaitGroup
	defer handlers.Wait()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		acceptedAt := time.Now()
		select {
		case semaphore <- struct{}{}:
			handlers.Add(1)
			go func(conn net.Conn, acceptedAt time.Time) {
				defer handlers.Done()
				defer func() { <-semaphore }()
				server.handle(ctx, conn, acceptedAt)
			}(conn, acceptedAt)
		default:
			_ = conn.Close()
		}
	}
}

func (server *Server) handle(parent context.Context, conn net.Conn, acceptedAt time.Time) {
	defer conn.Close()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	deadline := acceptedAt.Add(time.Duration(server.cfg.Limits.InitialFrameTimeoutSeconds) * time.Second)
	if err := conn.SetReadDeadline(deadline); err != nil {
		return
	}
	frame, err := protocol.ReadFrame(conn, server.limits)
	if err != nil {
		return
	}
	session := &sessionGuard{session: protocol.NewSession(modeFor(frame))}
	if err := session.accept(protocol.ClientToServer, frame); err != nil {
		return
	}
	request, err := protocol.DecodeInitialRequest(frame, server.limits)
	if err != nil {
		server.writeError(ctx, conn, session, frame.RequestID)
		return
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return
	}
	if request.Operation == protocol.GitUploadPack || request.Operation == protocol.GitReceivePack {
		server.dispatchGit(ctx, conn, session, request)
		return
	}
	server.dispatchAPI(ctx, conn, session, request)
}

func modeFor(frame protocol.Frame) protocol.Mode {
	request, err := protocol.DecodeControlRequest(frame.Payload)
	if err == nil && (request.Operation == protocol.GitUploadPack || request.Operation == protocol.GitReceivePack) {
		return protocol.Git
	}
	return protocol.API
}
