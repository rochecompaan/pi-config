package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/gitproto"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/runner"
)

func (server *Server) dispatchGit(requestCtx context.Context, conn net.Conn, session *sessionGuard, control protocol.ControlRequestBody) {
	operationCtx, cancelOperation := context.WithTimeout(requestCtx, server.operationTimeout)
	defer cancelOperation()
	streamCtx, stopStream := context.WithCancel(operationCtx)
	defer stopStream()
	if _, err := protocol.DecodeArguments[struct{}](control.Arguments); err != nil || !server.authorized(gitCapabilities(control.Operation)) {
		server.writeError(operationCtx, conn, session, control.RequestID)
		return
	}
	started := time.Now()
	audit := AuditEvent{
		Operation: control.Operation, RequestID: control.RequestID,
		Repository: server.cfg.Repository, ExitStatus: 1,
	}
	var input *inputPump
	var stdout *framedWriter
	var stderr *fixedDiagnosticWriter
	var receiveInput *validatedReceiveInput
	defer func() {
		audit.Duration = time.Since(started)
		if input != nil {
			audit.StdinBytes = input.Count()
		}
		if stdout != nil {
			audit.StdoutBytes = stdout.Count()
		}
		if stderr != nil {
			audit.StderrBytes = stderr.Count()
		}
		if receiveInput != nil {
			audit.Refs = receiveInput.Refs()
		}
		server.recordAudit(audit)
	}()
	if !server.writeSessionFrame(operationCtx, conn, session, protocol.Frame{
		Kind: protocol.ControlResponse, RequestID: control.RequestID,
		Payload: protocol.EncodeAcceptance(server.limits.MaxStreamBytes),
	}) {
		return
	}
	input = newInputPump(streamCtx, conn, server.limits, session, stopStream)
	defer input.Close()
	stdout = &framedWriter{ctx: operationCtx, server: server, conn: conn, session: session, requestID: control.RequestID, kind: protocol.StdoutData}
	stderrFrames := &framedWriter{ctx: operationCtx, server: server, conn: conn, session: session, requestID: control.RequestID, kind: protocol.StderrData}
	stderr = &fixedDiagnosticWriter{destination: stderrFrames, diagnostic: []byte("ssh transport diagnostic\n"), cancel: stopStream}

	processStdout, childStdout := io.Pipe()
	stopPipeClose := context.AfterFunc(streamCtx, func() { _ = childStdout.CloseWithError(streamCtx.Err()) })
	defer stopPipeClose()
	processed := make(chan error, 1)
	capabilities := make(chan advertisementResult, 1)
	if control.Operation == protocol.GitReceivePack {
		go server.processReceiveAdvertisement(streamCtx, processStdout, stdout, capabilities, processed, stopStream)
	} else {
		close(capabilities)
		go copyStream(processStdout, stdout, processed, stopStream)
	}

	childInput := io.Reader(input)
	if control.Operation == protocol.GitReceivePack {
		receiveInput = &validatedReceiveInput{
			input: input, advertisement: capabilities, cancel: stopStream,
			maxBytes: server.cfg.Limits.MaxPushPrefixBytes, policy: server.cfg.PushPolicy,
		}
		childInput = receiveInput
	}
	resultDone := make(chan runner.StreamResult, 1)
	go func() {
		resultDone <- server.sshRunner.Stream(streamCtx, runner.StreamCall{
			Args:  sshArgs(control.Operation, server.cfg.Repository),
			Stdin: childInput, Stdout: childStdout, Stderr: stderr,
		})
		_ = childStdout.Close()
	}()

	result := <-resultDone
	if err := <-processed; err != nil && result.ExitStatus == 0 {
		result.ExitStatus = 1
		result.Err = err
	}
	status := int32(result.ExitStatus)
	if status < 0 {
		status = 1
	}
	audit.ExitStatus = int(status)
	if !server.writeTerminalFrame(requestCtx, conn, session, control.RequestID, status) {
		audit.ExitStatus = 1
	}
}

func gitCapabilities(operation protocol.Operation) []config.Capability {
	if operation == protocol.GitReceivePack {
		return []config.Capability{config.GitRead, config.GitWrite}
	}
	return []config.Capability{config.GitRead}
}

func sshArgs(operation protocol.Operation, repository string) []string {
	service := "git-upload-pack"
	if operation == protocol.GitReceivePack {
		service = "git-receive-pack"
	}
	return []string{"git@github.com", service + " '" + repository + ".git'"}
}

type advertisementResult struct {
	capabilities gitproto.Capabilities
	err          error
}

func (server *Server) processReceiveAdvertisement(ctx context.Context, source *io.PipeReader, destination io.Writer, result chan<- advertisementResult, done chan<- error, cancel context.CancelFunc) {
	defer source.Close()
	advertisement, err := gitproto.ParseAdvertisedCapabilities(io.TeeReader(source, destination), server.cfg.Limits.MaxPushPrefixBytes)
	result <- advertisementResult{capabilities: advertisement.Capabilities, err: err}
	close(result)
	if err != nil {
		cancel()
		done <- err
		return
	}
	_, err = io.Copy(destination, source)
	if err != nil && ctx.Err() == nil {
		cancel()
	}
	done <- err
}

func copyStream(source *io.PipeReader, destination io.Writer, done chan<- error, cancel context.CancelFunc) {
	defer source.Close()
	_, err := io.Copy(destination, source)
	if err != nil {
		cancel()
	}
	done <- err
}

type framedWriter struct {
	ctx       context.Context
	server    *Server
	conn      net.Conn
	session   *sessionGuard
	requestID uint32
	kind      protocol.Kind
	bytes     atomic.Int64
}

func (writer *framedWriter) Write(value []byte) (int, error) {
	written := 0
	for len(value) != 0 {
		length := len(value)
		if length > int(writer.server.limits.MaxStreamBytes) {
			length = int(writer.server.limits.MaxStreamBytes)
		}
		frame := protocol.Frame{Kind: writer.kind, RequestID: writer.requestID, Payload: append([]byte(nil), value[:length]...)}
		if !writer.server.writeSessionFrame(writer.ctx, writer.conn, writer.session, frame) {
			return written, net.ErrClosed
		}
		written += length
		writer.bytes.Add(int64(length))
		value = value[length:]
	}
	return written, nil
}

func (writer *framedWriter) Count() int64 {
	return writer.bytes.Load()
}

type fixedDiagnosticWriter struct {
	destination io.Writer
	diagnostic  []byte
	cancel      context.CancelFunc
	once        sync.Once
	err         error
	bytes       atomic.Int64
}

func (writer *fixedDiagnosticWriter) Write(raw []byte) (int, error) {
	writer.bytes.Add(int64(len(raw)))
	if len(raw) == 0 {
		return 0, nil
	}
	writer.once.Do(func() {
		written, err := writer.destination.Write(writer.diagnostic)
		if err == nil && written != len(writer.diagnostic) {
			err = io.ErrShortWrite
		}
		writer.err = err
		if err != nil {
			writer.cancel()
		}
	})
	if writer.err != nil {
		return 0, writer.err
	}
	return len(raw), nil
}

func (writer *fixedDiagnosticWriter) Count() int64 {
	return writer.bytes.Load()
}

type validatedReceiveInput struct {
	input         io.Reader
	advertisement <-chan advertisementResult
	cancel        context.CancelFunc
	maxBytes      int
	policy        config.PushPolicy
	once          sync.Once
	reader        io.Reader
	err           error
	refsMu        sync.Mutex
	refs          []string
}

func (input *validatedReceiveInput) Refs() []string {
	input.refsMu.Lock()
	defer input.refsMu.Unlock()
	return append([]string(nil), input.refs...)
}

func (input *validatedReceiveInput) Read(destination []byte) (int, error) {
	input.once.Do(func() {
		advertisement, ok := <-input.advertisement
		if !ok || advertisement.err != nil {
			input.err = fmt.Errorf("invalid receive-pack advertisement")
			input.cancel()
			return
		}
		prefix, err := gitproto.ParseReceivePack(input.input, gitproto.ReceiveOptions{
			MaxBytes: input.maxBytes, Policy: input.policy, AdvertisedCaps: advertisement.capabilities,
		})
		if err != nil {
			input.err = err
			input.cancel()
			return
		}
		input.refsMu.Lock()
		for _, update := range prefix.Updates {
			input.refs = append(input.refs, update.Ref)
		}
		input.refsMu.Unlock()
		input.reader = io.MultiReader(bytes.NewReader(prefix.Raw), input.input)
	})
	if input.err != nil {
		return 0, input.err
	}
	return input.reader.Read(destination)
}
