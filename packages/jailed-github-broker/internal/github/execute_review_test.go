package github

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

type failingCaller struct{ status int }

func (c failingCaller) Call(context.Context, Call) (Result, *CallerError) {
	return Result{}, &CallerError{ExitStatus: c.status}
}

func TestExecuteReturnsTypedFixedOperationFailure(t *testing.T) {
	request, err := Parse(protocol.RepositoryGet, json.RawMessage(`{}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	_, err = Execute(t.Context(), request, failingCaller{status: 23})
	var operationError *OperationError
	if !errors.As(err, &operationError) {
		t.Fatalf("Execute() error = %T %v, want OperationError", err, err)
	}
	if operationError.ExitStatus != 23 || operationError.Message != "repository read" {
		t.Fatalf("OperationError = %#v", operationError)
	}
	if operationError.Error() != "repository read" {
		t.Fatalf("Error() leaked %q", operationError.Error())
	}
}

func TestExecuteReturnsNoResultAfterLaterCallFailure(t *testing.T) {
	request, err := Parse(protocol.IssuesUpdate, json.RawMessage(`{"number":1,"title":"new"}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &reviewCaller{results: []Result{{Stdout: []byte(`{"number":1}`)}}, errAt: 1}
	got, err := Execute(t.Context(), request, caller)
	if got != nil || err == nil {
		t.Fatalf("Execute() = %q, %v; want nil result and error", got, err)
	}
}

type reviewCaller struct {
	calls   []Call
	results []Result
	errAt   int
}

func (c *reviewCaller) Call(_ context.Context, call Call) (Result, *CallerError) {
	c.calls = append(c.calls, call)
	if len(c.calls)-1 == c.errAt {
		return Result{}, &CallerError{ExitStatus: 1}
	}
	result := c.results[0]
	c.results = c.results[1:]
	return result, nil
}
