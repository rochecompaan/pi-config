// Package github defines the broker's fixed, typed GitHub operations.
package github

import (
	"context"
	"errors"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const (
	apiVersion = "2022-11-28"
	apiAccept  = "application/vnd.github+json"
	miB        = 1 << 20
)

var (
	ErrInvalidRequest = errors.New("invalid GitHub operation request")
	ErrResultTooLarge = errors.New("GitHub result is too large")
	ErrWrongResource  = errors.New("GitHub resource has the wrong type")
)

// Request is a validated operation bound to one configured repository.
type Request struct {
	operation  protocol.Operation
	owner      string
	repository string
	arguments  any
}

// Call is one fixed host command. Args never contain client command-line input.
type Call struct {
	Args       []string
	Stdin      []byte
	CloseStdin bool
	RawLimit   int
	Failure    string
}

// Result is the bounded stdout captured by the host-command runner.
type Result struct{ Stdout []byte }

// CallerError is the only host-failure detail the runner returns to this core.
// It deliberately excludes host stderr and command text.
type CallerError struct{ ExitStatus int }

func (error *CallerError) Error() string { return "host command failed" }

// OperationError is the safe failure returned to broker callers. It preserves
// the exit status and generated operation message without exposing host output.
type OperationError struct {
	ExitStatus int
	Message    string
}

func (error *OperationError) Error() string { return error.Message }

// Caller is implemented by the subprocess boundary in Task 5.
type Caller interface {
	Call(context.Context, Call) (Result, *CallerError)
}

// RequiredCapabilities returns the complete capability set for request.
func RequiredCapabilities(request Request) []config.Capability {
	var capabilities []config.Capability
	switch request.operation {
	case protocol.RepositoryGet:
		capabilities = []config.Capability{config.RepositoryRead}
	case protocol.IssuesList, protocol.IssuesGet:
		capabilities = []config.Capability{config.IssuesRead}
	case protocol.IssuesCreate, protocol.IssuesUpdate, protocol.IssuesComment:
		capabilities = []config.Capability{config.IssuesWrite}
	case protocol.PullRequestsList, protocol.PullRequestsGet, protocol.PullRequestsDiff:
		capabilities = []config.Capability{config.PullRequestsRead}
	case protocol.PullRequestsCreate, protocol.PullRequestsUpdate, protocol.PullRequestsComment:
		capabilities = []config.Capability{config.PullRequestsWrite}
	case protocol.PullRequestsChecks:
		capabilities = []config.Capability{config.PullRequestsRead, config.StatusesRead}
	case protocol.ActionsRunsList, protocol.ActionsRunsGet, protocol.ActionsRunsLogs:
		capabilities = []config.Capability{config.ActionsRead}
	case protocol.StatusesGet:
		capabilities = []config.Capability{config.StatusesRead}
	}
	return append([]config.Capability(nil), capabilities...)
}
