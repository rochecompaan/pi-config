package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
)

func TestNewRejectsNonAbsoluteDependenciesAndTimeouts(t *testing.T) {
	for name, config := range map[string]Config{
		"relative executable":        {Executable: "gh", WorkingDirectory: t.TempDir(), OperationTimeout: time.Second, IdleTimeout: time.Second},
		"relative working directory": {Executable: os.Args[0], WorkingDirectory: "work", OperationTimeout: time.Second, IdleTimeout: time.Second},
		"zero operation timeout":     {Executable: os.Args[0], WorkingDirectory: t.TempDir(), IdleTimeout: time.Second},
		"zero idle timeout":          {Executable: os.Args[0], WorkingDirectory: t.TempDir(), OperationTimeout: time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := New(config); err == nil {
				t.Fatal("New succeeded")
			}
		})
	}
}

func TestCallExecutesFixedPathWithLiteralArgumentsAndInheritedEnvironment(t *testing.T) {
	t.Setenv("RUNNER_INHERITED", "present")
	runner := newTestRunner(t, nil)
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	argument := "; touch " + marker
	result, callError := runner.Call(context.Background(), github.Call{
		Args: helperArgs("argv-env", argument), CloseStdin: true, RawLimit: 4096, Failure: "repository read",
	})
	if callError != nil {
		t.Fatalf("Call failed: %+v", callError)
	}
	var got struct {
		Args []string `json:"args"`
		Env  string   `json:"env"`
		EOF  bool     `json:"eof"`
	}
	if err := json.Unmarshal(result.Stdout, &got); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if want := []string{argument}; fmt.Sprint(got.Args) != fmt.Sprint(want) {
		t.Fatalf("arguments = %#v, want %#v", got.Args, want)
	}
	if got.Env != "present" || !got.EOF {
		t.Fatalf("environment/stdin = %#v, want inherited environment and EOF", got)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shell interpreted argument: marker stat = %v", err)
	}
}

func TestCallPreservesParentPWDWhileUsingPrivateWorkingDirectory(t *testing.T) {
	parentPWD, present := os.LookupEnv("PWD")
	if !present {
		t.Fatal("parent PWD is not set")
	}
	privateDirectory := t.TempDir()
	// Race-instrumented helper-process shutdown exceeds one second; timeout
	// behavior remains covered independently in TestCallAppliesIdleAndOperationTimeouts.
	runner, err := New(Config{Executable: os.Args[0], WorkingDirectory: privateDirectory, OperationTimeout: 3 * time.Second, IdleTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUNNER_HELPER", "1")
	result, callError := runner.Call(context.Background(), github.Call{
		Args: helperArgs("cwd-env"), CloseStdin: true, RawLimit: 4096, Failure: "repository read",
	})
	if callError != nil {
		t.Fatalf("Call failed: %+v", callError)
	}
	var got struct {
		PWD string `json:"pwd"`
		CWD string `json:"cwd"`
	}
	if err := json.Unmarshal(result.Stdout, &got); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if got.PWD != parentPWD {
		t.Errorf("child PWD = %q, want parent PWD %q", got.PWD, parentPWD)
	}
	if got.CWD != privateDirectory {
		t.Errorf("child cwd = %q, want injected private directory %q", got.CWD, privateDirectory)
	}
}

func TestCallSendsConfiguredInput(t *testing.T) {
	runner := newTestRunner(t, nil)
	result, callError := runner.Call(context.Background(), github.Call{
		Args: helperArgs("stdin"), Stdin: []byte("request body"), CloseStdin: true, RawLimit: 4096, Failure: "issue create",
	})
	if callError != nil {
		t.Fatalf("Call failed: %+v", callError)
	}
	if got, want := string(result.Stdout), "request body"; got != want {
		t.Fatalf("stdout = %q, want %q", got, want)
	}
}

func TestCallRejectsNonpositiveOutputLimit(t *testing.T) {
	runner := newTestRunner(t, nil)
	_, callError := runner.Call(context.Background(), github.Call{Args: helperArgs("sleep"), CloseStdin: true, Failure: "repository read"})
	if callError == nil || callError.ExitStatus == 0 {
		t.Fatalf("Call error = %#v, want safe nonzero error", callError)
	}
}

func TestCallBoundsOutputAndDoesNotExposeHostStderr(t *testing.T) {
	t.Setenv("GH_DEBUG", "api")
	t.Setenv("GH_TOKEN", "host-secret")
	runner := newTestRunner(t)
	_, callError := runner.Call(context.Background(), github.Call{
		Args: helperArgs("overflow"), CloseStdin: true, RawLimit: 16, Failure: "hostile\noperation",
	})
	if callError == nil || callError.ExitStatus == 0 || callError.Error() != "host command failed" {
		t.Fatalf("Call error = %#v, want generic nonzero host error", callError)
	}
}

func TestCallReturnsExactOrdinaryExitStatusWithoutHostStderr(t *testing.T) {
	const hostileStderr = "token=ghp_host_secret"
	runner := newTestRunner(t, nil)
	result, callError := runner.Call(context.Background(), github.Call{
		Args: helperArgs("failure", hostileStderr), CloseStdin: true, RawLimit: 4096, Failure: "repository read",
	})
	if callError == nil {
		t.Fatal("Call succeeded")
	}
	if callError.ExitStatus != 23 {
		t.Errorf("exit status = %d, want 23", callError.ExitStatus)
	}
	if got := callError.Error(); got != "host command failed" || strings.Contains(got, hostileStderr) {
		t.Errorf("error = %q, want generic error without host stderr", got)
	}
	if len(result.Stdout) != 0 {
		t.Errorf("stdout = %q, want empty result on host failure", result.Stdout)
	}
}

func TestProcessAuthorityRetiresNegativePGIDBeforeLeaderReap(t *testing.T) {
	leaderReaped := false
	kills := 0
	authority := processAuthority{
		pgid: 42,
		kill: func(pid int, signal syscall.Signal) error {
			if leaderReaped {
				t.Fatal("negative PGID signalled after leader reap")
			}
			if pid != -42 || signal != syscall.SIGKILL {
				t.Fatalf("kill(%d, %v)", pid, signal)
			}
			kills++
			return nil
		},
		reap: func() error {
			leaderReaped = true
			return nil
		},
	}
	if err := authority.retireAndReap(); err != nil {
		t.Fatal(err)
	}
	authority.terminate()
	if kills != 1 || !leaderReaped {
		t.Fatalf("kills=%d leaderReaped=%t", kills, leaderReaped)
	}
}

func TestCallCompletionAndOverflowCleanDescendants(t *testing.T) {
	for _, test := range []struct {
		name  string
		mode  string
		limit int
		want  int
	}{
		{name: "successful completion", mode: "spawn-success", limit: 4096, want: 0},
		{name: "error completion", mode: "spawn-exit", limit: 4096, want: 23},
		{name: "overflow completion", mode: "spawn-overflow-exit", limit: 16, want: 7},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := newTestRunner(t, nil)
			pidFile := filepath.Join(t.TempDir(), "descendant.pid")
			_, callError := runner.Call(context.Background(), github.Call{
				Args: helperArgs(test.mode, pidFile), CloseStdin: true,
				RawLimit: test.limit, Failure: "repository read",
			})
			pid := readRunnerPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			if test.want == 0 && callError != nil {
				t.Fatalf("Call error = %#v, want success", callError)
			}
			if test.want != 0 && (callError == nil || callError.ExitStatus != test.want) {
				t.Fatalf("Call error = %#v, want status %d", callError, test.want)
			}
			waitForGone(t, pid)
		})
	}
}

func TestCallCancellationKillsAndReapsProcessGroup(t *testing.T) {
	runner := newTestRunner(t, nil)
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan *github.CallerError, 1)
	go func() {
		_, callError := runner.Call(ctx, github.Call{Args: helperArgs("spawn", pidFile), CloseStdin: true, RawLimit: 4096, Failure: "repository read"})
		result <- callError
	}()
	waitForFile(t, pidFile)
	cancel()
	if callError := <-result; callError == nil || callError.ExitStatus < 1 {
		t.Fatalf("Call error = %#v, want generic nonzero error", callError)
	}
	pidData, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil {
		t.Fatal(err)
	}
	waitForGone(t, pid)
}

func TestCallTimeoutsCleanDescendants(t *testing.T) {
	for _, test := range []struct {
		name      string
		mode      string
		operation time.Duration
		idle      time.Duration
	}{
		{name: "idle", mode: "spawn", operation: 500 * time.Millisecond, idle: 40 * time.Millisecond},
		{name: "operation", mode: "spawn-tick", operation: 80 * time.Millisecond, idle: 500 * time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := newTestRunnerWithTimeouts(t, test.operation, test.idle, nil)
			pidFile := filepath.Join(t.TempDir(), "timeout-descendant.pid")
			_, callError := runner.Call(context.Background(), github.Call{
				Args: helperArgs(test.mode, pidFile), CloseStdin: true, RawLimit: 4096, Failure: "repository read",
			})
			if callError == nil || callError.ExitStatus == 0 {
				t.Fatalf("Call error = %#v, want timeout error", callError)
			}
			pid := readRunnerPID(t, pidFile)
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
			waitForGone(t, pid)
		})
	}
}

func newTestRunner(t *testing.T, _ ...any) *Runner {
	t.Helper()
	return newTestRunnerWithTimeouts(t, 3*time.Second, 3*time.Second)
}

func newTestRunnerWithTimeouts(t *testing.T, operation, idle time.Duration, _ ...any) *Runner {
	t.Helper()
	t.Setenv("GO_WANT_RUNNER_HELPER", "1")
	runner, err := New(Config{Executable: os.Args[0], WorkingDirectory: t.TempDir(), OperationTimeout: operation, IdleTimeout: idle})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func helperArgs(mode string, arguments ...string) []string {
	return append([]string{"-test.run=TestHelperProcess", "--", mode}, arguments...)
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func readRunnerPID(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

func waitForGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("process %d survived cancellation", pid)
}

func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_RUNNER_HELPER") != "1" {
		return
	}
	args := os.Args
	separator := -1
	for i, arg := range args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator < 0 || separator+1 >= len(args) {
		os.Exit(2)
	}
	switch args[separator+1] {
	case "argv-env":
		_, _ = fmt.Printf(`{"args":%s,"env":%q,"eof":%t}`, mustJSON(args[separator+2:]), os.Getenv("RUNNER_INHERITED"), stdinEOF())
	case "cwd-env":
		cwd, err := os.Getwd()
		if err != nil {
			os.Exit(4)
		}
		_, _ = fmt.Printf(`{"pwd":%q,"cwd":%q}`, os.Getenv("PWD"), cwd)
	case "stdin":
		data, _ := os.ReadFile("/dev/stdin")
		_, _ = os.Stdout.Write(data)
	case "stream":
		data, _ := os.ReadFile("/dev/stdin")
		_, _ = os.Stdout.Write(data)
		_, _ = os.Stderr.WriteString("stream-diagnostic")
		status, _ := strconv.Atoi(args[separator+2])
		os.Exit(status)
	case "overflow":
		_, _ = os.Stderr.WriteString("host-secret: credential\n")
		_, _ = os.Stdout.Write([]byte(strings.Repeat("x", 64)))
		os.Exit(7)
	case "failure":
		_, _ = os.Stderr.WriteString(args[separator+2])
		os.Exit(23)
	case "sleep":
		time.Sleep(5 * time.Second)
	case "tick":
		for {
			_, _ = os.Stdout.WriteString(".")
			time.Sleep(10 * time.Millisecond)
		}
	case "spawn", "spawn-success", "spawn-exit", "spawn-overflow-exit", "spawn-tick":
		child := exec.Command(os.Args[0], "-test.run=TestHelperProcess", "--", "sleep")
		child.Env = append(os.Environ(), "GO_WANT_RUNNER_HELPER=1")
		if err := child.Start(); err != nil {
			os.Exit(3)
		}
		_ = os.WriteFile(args[separator+2], []byte(strconv.Itoa(child.Process.Pid)), 0o600)
		if args[separator+1] == "spawn-success" {
			os.Exit(0)
		}
		if args[separator+1] == "spawn-exit" {
			os.Exit(23)
		}
		if args[separator+1] == "spawn-overflow-exit" {
			_, _ = os.Stdout.Write([]byte(strings.Repeat("x", 64)))
			os.Exit(7)
		}
		if args[separator+1] == "spawn-tick" {
			for {
				_, _ = os.Stdout.WriteString(".")
				time.Sleep(10 * time.Millisecond)
			}
		}
		_ = child.Wait()
	}
	os.Exit(0)
}

func stdinEOF() bool {
	var byte [1]byte
	n, _ := os.Stdin.Read(byte[:])
	return n == 0
}

func mustJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}
