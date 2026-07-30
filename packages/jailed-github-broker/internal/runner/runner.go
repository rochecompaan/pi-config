// Package runner executes fixed host commands without exposing host diagnostics.
package runner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
)

var errOutputLimit = errors.New("host stdout exceeds configured limit")

// Config contains the trusted host-side dependencies for Runner. Executable
// and WorkingDirectory must be supplied as absolute paths by host wiring.
type Config struct {
	Executable       string
	WorkingDirectory string
	OperationTimeout time.Duration
	IdleTimeout      time.Duration
}

// Runner implements github.Caller with a fixed executable and working directory.
type Runner struct {
	executable       string
	workingDirectory string
	operationTimeout time.Duration
	idleTimeout      time.Duration
}

// New validates trusted runner dependencies. It never selects an executable or
// working directory itself.
func New(config Config) (*Runner, error) {
	if !filepath.IsAbs(config.Executable) {
		return nil, fmt.Errorf("runner executable must be absolute")
	}
	if !filepath.IsAbs(config.WorkingDirectory) {
		return nil, fmt.Errorf("runner working directory must be absolute")
	}
	if config.OperationTimeout <= 0 {
		return nil, fmt.Errorf("runner operation timeout must be positive")
	}
	if config.IdleTimeout <= 0 {
		return nil, fmt.Errorf("runner idle timeout must be positive")
	}
	return &Runner{
		executable: config.Executable, workingDirectory: config.WorkingDirectory,
		operationTimeout: config.OperationTimeout, idleTimeout: config.IdleTimeout,
	}, nil
}

// Call runs the generated argv directly. It inherits the host environment,
// closes stdin after the supplied request body, bounds retained stdout, and
// terminates the complete process group for cancellation, timeout, or overflow.
func (runner *Runner) Call(parent context.Context, call github.Call) (github.Result, *github.CallerError) {
	status := 1
	if call.RawLimit <= 0 {
		return github.Result{}, &github.CallerError{ExitStatus: status}
	}

	operation, cancelOperation := context.WithTimeout(parent, runner.operationTimeout)
	defer cancelOperation()
	command := exec.Command(runner.executable, call.Args...)
	command.Dir = runner.workingDirectory
	command.Env = os.Environ() // preserve the normal host environment unchanged
	command.Stdin = bytes.NewReader(call.Stdin)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	activity := make(chan struct{}, 1)
	overflow := make(chan struct{}, 1)
	output := &boundedBuffer{limit: call.RawLimit}
	command.Stdout = outputWriter{output: output, activity: activity, overflow: overflow}
	stderrOutput := &discardWriter{activity: activity}
	command.Stderr = stderrOutput
	if err := command.Start(); err != nil {
		return github.Result{}, &github.CallerError{ExitStatus: status}
	}
	authority := newProcessAuthority(command)
	exitObserved := make(chan error, 1)
	go func() { exitObserved <- waitWithoutReap(command.Process.Pid) }()

	idle := time.NewTimer(runner.idleTimeout)
	defer idle.Stop()
	var (
		observationError error
		waitReady        bool
		interrupted      bool
	)
	for !waitReady {
		select {
		case <-activity:
			resetTimer(idle, runner.idleTimeout)
		case <-overflow:
			interrupted = true
			authority.terminate()
		case observationError = <-exitObserved:
			waitReady = true
		case <-operation.Done():
			interrupted = true
			authority.terminate()
		case <-idle.C:
			interrupted = true
			authority.terminate()
		}
	}
	waitError := authority.retireAndReap()
	if observationError == nil && waitError == nil && !output.Overflowed() && !interrupted {
		status = 0
		return github.Result{Stdout: output.Bytes()}, nil
	}
	if exitError, ok := waitError.(*exec.ExitError); ok && exitError.ExitCode() > 0 {
		status = exitError.ExitCode()
	}
	return github.Result{}, &github.CallerError{ExitStatus: status}
}

type outputWriter struct {
	output   *boundedBuffer
	activity chan<- struct{}
	overflow chan<- struct{}
}

func (writer outputWriter) Write(value []byte) (int, error) {
	n, err := writer.output.Write(value)
	notify(writer.activity)
	if err != nil {
		notify(writer.overflow)
	}
	return n, err
}

type discardWriter struct {
	activity chan<- struct{}
}

func (writer *discardWriter) Write(value []byte) (int, error) {
	notify(writer.activity)
	return len(value), nil
}

func notify(activity chan<- struct{}) {
	select {
	case activity <- struct{}{}:
	default:
	}
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}

type boundedBuffer struct {
	limit    int
	count    int
	overflow bool
	data     bytes.Buffer
	mu       sync.Mutex
}

func (buffer *boundedBuffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if len(value) > buffer.limit-buffer.count {
		buffer.overflow = true
		return 0, errOutputLimit
	}
	buffer.count += len(value)
	return buffer.data.Write(value)
}

func (buffer *boundedBuffer) Overflowed() bool {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.overflow
}

func (buffer *boundedBuffer) Bytes() []byte {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return append([]byte(nil), buffer.data.Bytes()...)
}
