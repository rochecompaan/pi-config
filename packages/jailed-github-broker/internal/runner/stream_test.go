package runner

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestStreamRelaysInputOutputAndExitStatus(t *testing.T) {
	runner := newTestRunner(t, nil)
	var stdout, stderr bytes.Buffer
	result := runner.Stream(context.Background(), StreamCall{
		Args: helperArgs("stream", "17"), Stdin: strings.NewReader("stream-input"),
		Stdout: &stdout, Stderr: &stderr,
	})
	if result.ExitStatus != 17 || result.Err == nil {
		t.Fatalf("result = %#v", result)
	}
	if stdout.String() != "stream-input" || stderr.String() != "stream-diagnostic" {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestStreamLeaderCompletionCleansDescendants(t *testing.T) {
	for _, test := range []struct {
		name string
		mode string
		want int
	}{
		{name: "success", mode: "spawn-success", want: 0},
		{name: "error", mode: "spawn-exit", want: 23},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := newTestRunner(t, nil)
			pidFile := filepath.Join(t.TempDir(), "stream-completion-descendant.pid")
			result := runner.Stream(context.Background(), StreamCall{
				Args: helperArgs(test.mode, pidFile), Stdin: strings.NewReader(""),
				Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
			})
			pid := readRunnerPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			if result.ExitStatus != test.want || (test.want == 0 && result.Err != nil) || (test.want != 0 && result.Err == nil) {
				t.Fatalf("result = %#v", result)
			}
			waitForGone(t, pid)
		})
	}
}

func TestStreamCancellationKillsDescendants(t *testing.T) {
	runner := newTestRunner(t, nil)
	pidFile := filepath.Join(t.TempDir(), "stream-descendant.pid")
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan StreamResult, 1)
	go func() {
		result <- runner.Stream(ctx, StreamCall{
			Args: helperArgs("spawn", pidFile), Stdin: strings.NewReader(""),
			Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		})
	}()
	waitForFile(t, pidFile)
	cancel()
	got := <-result
	if got.ExitStatus == 0 || got.Err == nil {
		t.Fatalf("result = %#v", got)
	}
	data, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	waitForGone(t, pid)
}

func TestStreamTimeoutsCleanDescendants(t *testing.T) {
	for _, test := range []struct {
		name      string
		mode      string
		operation time.Duration
		idle      time.Duration
	}{
		{name: "idle", mode: "spawn", operation: time.Second, idle: 40 * time.Millisecond},
		{name: "operation", mode: "spawn-tick", operation: 80 * time.Millisecond, idle: 500 * time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := newTestRunnerWithTimeouts(t, test.operation, test.idle, nil)
			pidFile := filepath.Join(t.TempDir(), "stream-timeout-descendant.pid")
			result := runner.Stream(context.Background(), StreamCall{
				Args: helperArgs(test.mode, pidFile), Stdin: strings.NewReader(""),
				Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
			})
			if result.ExitStatus == 0 || result.Err == nil {
				t.Fatalf("result = %#v", result)
			}
			pid := readRunnerPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			waitForGone(t, pid)
		})
	}
}
