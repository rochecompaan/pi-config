package github

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestChecksRejectsEmptyAdvertisedPagesWithoutPartialResult(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		results   []Result
		wantError string
		wantCalls int
	}{
		{
			name: "check-runs intermediate",
			results: []Result{
				{Stdout: pullHead()},
				{Stdout: page("check_runs", 300, 100)},
				{Stdout: page("check_runs", 300, 0)},
			},
			wantError: "incomplete check-runs response",
			wantCalls: 3,
		},
		{
			name: "check-runs final",
			results: []Result{
				{Stdout: pullHead()},
				{Stdout: page("check_runs", 101, 100)},
				{Stdout: page("check_runs", 101, 0)},
			},
			wantError: "incomplete check-runs response",
			wantCalls: 3,
		},
		{
			name: "statuses intermediate",
			results: []Result{
				{Stdout: pullHead()},
				{Stdout: page("check_runs", 0, 0)},
				{Stdout: page("statuses", 300, 100)},
				{Stdout: page("statuses", 300, 0)},
			},
			wantError: "incomplete statuses response",
			wantCalls: 4,
		},
		{
			name: "statuses final",
			results: []Result{
				{Stdout: pullHead()},
				{Stdout: page("check_runs", 0, 0)},
				{Stdout: page("statuses", 101, 100)},
				{Stdout: page("statuses", 101, 0)},
			},
			wantError: "incomplete statuses response",
			wantCalls: 4,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			caller := &recordedCaller{results: test.results}
			got, err := Execute(context.Background(), request, caller)
			if got != nil || err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Execute() = %q, %v; want nil, %q", got, err, test.wantError)
			}
			if len(caller.calls) != test.wantCalls {
				t.Fatalf("calls = %d, want %d", len(caller.calls), test.wantCalls)
			}
		})
	}
}
