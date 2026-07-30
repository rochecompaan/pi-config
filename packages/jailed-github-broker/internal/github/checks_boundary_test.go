package github

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestChecksAcceptsExactlyOneThousandCombinedRecords(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	results := []Result{{Stdout: pullHead()}}
	for range 5 {
		results = append(results, Result{Stdout: page("check_runs", 500, 100)})
	}
	for range 5 {
		results = append(results, Result{Stdout: page("statuses", 500, 100)})
	}
	caller := &recordedCaller{results: results}
	got, err := Execute(context.Background(), request, caller)
	if err != nil {
		t.Fatalf("Execute() error = %v, calls = %d", err, len(caller.calls))
	}
	var values []any
	if err := json.Unmarshal(got, &values); err != nil {
		t.Fatal(err)
	}
	if len(values) != 1000 || len(caller.calls) != 11 {
		t.Fatalf("records/calls = %d/%d", len(values), len(caller.calls))
	}
}

func TestChecksRejectsOneThousandOneAdvertisedRecordsWithoutPartialResult(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	results := []Result{{Stdout: pullHead()}}
	for range 5 {
		results = append(results, Result{Stdout: page("check_runs", 500, 100)})
	}
	for range 5 {
		results = append(results, Result{Stdout: page("statuses", 501, 100)})
	}
	caller := &recordedCaller{results: results}
	got, err := Execute(context.Background(), request, caller)
	if got != nil || !errors.Is(err, ErrResultTooLarge) {
		t.Fatalf("Execute() = %q, %v", got, err)
	}
	if len(caller.calls) != 7 {
		t.Fatalf("calls = %d, want preflight, five check pages, and rejecting status page", len(caller.calls))
	}
}

func TestChecksStatusLaterPageFailureReturnsNoPartialResult(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &reviewCaller{results: []Result{{Stdout: pullHead()}, {Stdout: page("check_runs", 0, 0)}, {Stdout: page("statuses", 101, 100)}}, errAt: 3}
	got, err := Execute(context.Background(), request, caller)
	if got != nil || err == nil {
		t.Fatalf("Execute() = %q, %v", got, err)
	}
}
