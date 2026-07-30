package runner

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// StreamCall describes a generated full-duplex invocation. Args are generated
// by the trusted server; the executable, cwd, and environment remain fixed by Runner.
type StreamCall struct {
	Args   []string
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// StreamResult contains only a process status and generic failure marker.
type StreamResult struct {
	ExitStatus int
	Err        error
}

var errStreamFailed = errors.New("host stream failed")

// Stream runs a full-duplex fixed command with the same process-group,
// operation-timeout, idle-timeout, environment, and cwd as Call.
func (runner *Runner) Stream(parent context.Context, call StreamCall) StreamResult {
	status := 1
	input := &activityReader{reader: call.Stdin}
	stdout := &activityStreamWriter{writer: call.Stdout}
	stderr := &activityStreamWriter{writer: call.Stderr}
	activity := make(chan struct{}, 1)
	input.activity, stdout.activity, stderr.activity = activity, activity, activity
	if call.Stdin == nil || call.Stdout == nil || call.Stderr == nil {
		return StreamResult{ExitStatus: status, Err: errStreamFailed}
	}

	operation, cancel := context.WithTimeout(parent, runner.operationTimeout)
	defer cancel()
	command := exec.Command(runner.executable, append([]string(nil), call.Args...)...)
	command.Dir = runner.workingDirectory
	command.Env = os.Environ()
	command.Stdout, command.Stderr = stdout, stderr
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := command.StdinPipe()
	if err != nil {
		return StreamResult{ExitStatus: status, Err: errStreamFailed}
	}
	if err := command.Start(); err != nil {
		return StreamResult{ExitStatus: status, Err: errStreamFailed}
	}
	inputDone := make(chan error, 1)
	go func() {
		_, copyErr := io.Copy(stdin, input)
		_ = stdin.Close()
		inputDone <- copyErr
	}()
	authority := newProcessAuthority(command)
	exitObserved := make(chan error, 1)
	go func() { exitObserved <- waitWithoutReap(command.Process.Pid) }()
	idle := time.NewTimer(runner.idleTimeout)
	defer idle.Stop()
	closeInput := func() {
		_ = stdin.Close()
		if closer, ok := call.Stdin.(io.Closer); ok {
			_ = closer.Close()
		}
	}
	var observationError error
	observed := false
	interrupted := false
	for !observed {
		select {
		case <-activity:
			resetTimer(idle, runner.idleTimeout)
		case observationError = <-exitObserved:
			observed = true
		case inputError := <-inputDone:
			inputDone = nil
			if inputError != nil {
				interrupted = true
				authority.terminate()
			}
		case <-operation.Done():
			interrupted = true
			authority.terminate()
			closeInput()
		case <-idle.C:
			interrupted = true
			authority.terminate()
			closeInput()
		}
	}
	closeInput()
	waitError := authority.retireAndReap()
	if observationError == nil && waitError == nil && !interrupted {
		status = 0
		return StreamResult{ExitStatus: 0}
	}
	if exitError, ok := waitError.(*exec.ExitError); ok && exitError.ExitCode() > 0 {
		status = exitError.ExitCode()
	}
	return StreamResult{ExitStatus: status, Err: errStreamFailed}
}

type activityReader struct {
	reader   io.Reader
	activity chan<- struct{}
}

func (reader *activityReader) Read(value []byte) (int, error) {
	n, err := reader.reader.Read(value)
	if n > 0 {
		notify(reader.activity)
	}
	return n, err
}

type activityStreamWriter struct {
	writer   io.Writer
	activity chan<- struct{}
}

func (writer *activityStreamWriter) Write(value []byte) (int, error) {
	n, err := writer.writer.Write(value)
	if n > 0 {
		notify(writer.activity)
	}
	return n, err
}
