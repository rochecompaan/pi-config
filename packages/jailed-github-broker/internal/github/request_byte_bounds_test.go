package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestTextAndNameLimitsUseUTF8Bytes(t *testing.T) {
	tests := []struct {
		name       string
		operation  protocol.Operation
		arguments  map[string]any
		field      string
		queryField string
		limit      int
	}{
		{"issues.create title", protocol.IssuesCreate, map[string]any{"title": "title", "body": "body"}, "title", "", 256},
		{"issues.update title", protocol.IssuesUpdate, map[string]any{"number": 1, "title": "title"}, "title", "", 256},
		{"pullRequests.create title", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}, "title", "", 256},
		{"pullRequests.update title", protocol.PullRequestsUpdate, map[string]any{"number": 1, "title": "title"}, "title", "", 256},

		{"issues.create body", protocol.IssuesCreate, map[string]any{"title": "title", "body": "body"}, "body", "", 65_536},
		{"issues.update body", protocol.IssuesUpdate, map[string]any{"number": 1, "body": "body"}, "body", "", 65_536},
		{"issues.comment body", protocol.IssuesComment, map[string]any{"number": 1, "body": "body"}, "body", "", 65_536},
		{"pullRequests.create body", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}, "body", "", 65_536},
		{"pullRequests.update body", protocol.PullRequestsUpdate, map[string]any{"number": 1, "body": "body"}, "body", "", 65_536},
		{"pullRequests.comment body", protocol.PullRequestsComment, map[string]any{"number": 1, "body": "body"}, "body", "", 65_536},

		{"pullRequests.list base", protocol.PullRequestsList, map[string]any{"state": "open", "base": "main", "limit": 1}, "base", "base", 255},
		{"pullRequests.list head", protocol.PullRequestsList, map[string]any{"state": "open", "head": "feature", "limit": 1}, "head", "head", 255},
		{"pullRequests.create head", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}, "head", "", 255},
		{"pullRequests.create base", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}, "base", "", 255},
		{"pullRequests.update base", protocol.PullRequestsUpdate, map[string]any{"number": 1, "base": "main"}, "base", "", 255},
		{"actions.runs.list branch", protocol.ActionsRunsList, map[string]any{"branch": "main", "limit": 1}, "branch", "branch", 255},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			exact := utf8Boundary(test.limit)
			over := utf8Boundary(test.limit + 1)
			if len(exact) != test.limit || len(over) != test.limit+1 {
				t.Fatalf("boundary helper lengths = %d/%d", len(exact), len(over))
			}

			exactArguments := cloneArguments(test.arguments)
			exactArguments[test.field] = exact
			request := parseArguments(t, test.operation, exactArguments)
			caller := &recordedCaller{results: inertResults(test.operation)}
			if _, err := Execute(context.Background(), request, caller); err != nil {
				t.Fatalf("exact boundary Execute() error = %v", err)
			}
			call := caller.calls[len(caller.calls)-1]
			if test.queryField != "" {
				endpoint := call.Args[len(call.Args)-1]
				parsed, err := url.ParseRequestURI(endpoint)
				if err != nil {
					t.Fatal(err)
				}
				if got := parsed.Query().Get(test.queryField); got != exact {
					t.Fatalf("query value has %d bytes, want exact %d-byte value", len(got), test.limit)
				}
			} else {
				var input map[string]any
				if err := json.Unmarshal(call.Stdin, &input); err != nil {
					t.Fatal(err)
				}
				if got, ok := input[test.field].(string); !ok || got != exact {
					t.Fatalf("stdin field = %#v, want exact %d-byte value", input[test.field], test.limit)
				}
			}

			overArguments := cloneArguments(test.arguments)
			overArguments[test.field] = over
			data, err := json.Marshal(overArguments)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Parse(test.operation, data, "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("one-byte-over Parse() error = %v, want ErrInvalidRequest", err)
			}
		})
	}
}

func utf8Boundary(size int) string {
	if size < 2 {
		panic("UTF-8 boundary size must be at least two")
	}
	return strings.Repeat("a", size-2) + "é"
}

func cloneArguments(arguments map[string]any) map[string]any {
	clone := make(map[string]any, len(arguments))
	for key, value := range arguments {
		clone[key] = value
	}
	return clone
}

func parseArguments(t *testing.T, operation protocol.Operation, arguments map[string]any) Request {
	t.Helper()
	data, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	request, err := Parse(operation, data, "owner/repo")
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	return request
}
