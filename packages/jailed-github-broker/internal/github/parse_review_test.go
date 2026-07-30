package github

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestParseIssuesListPreservesStrictDecodeFailures(t *testing.T) {
	for _, arguments := range []string{
		`{"state":"open","limit":"1"}`,
		`{"state":"open","limit":1,"unknown":true}`,
		`{"state":"open","limit":1,"limit":2}`,
	} {
		if _, err := Parse(protocol.IssuesList, json.RawMessage(arguments), "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("Parse(%s) error = %v, want ErrInvalidRequest", arguments, err)
		}
	}
}

func TestParseIssuesListRequiresState(t *testing.T) {
	if _, err := Parse(protocol.IssuesList, json.RawMessage(`{"limit":1}`), "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Parse() error = %v, want ErrInvalidRequest", err)
	}
}

func TestIssuesListUsesExactStateQueries(t *testing.T) {
	for _, test := range []struct{ state, endpoint string }{
		{"all", "/search/issues?q=repo%3Aowner%2Frepo+is%3Aissue&per_page=1"},
		{"open", "/search/issues?q=repo%3Aowner%2Frepo+is%3Aissue+state%3Aopen&per_page=1"},
		{"closed", "/search/issues?q=repo%3Aowner%2Frepo+is%3Aissue+state%3Aclosed&per_page=1"},
	} {
		t.Run(test.state, func(t *testing.T) {
			request, err := Parse(protocol.IssuesList, json.RawMessage(`{"state":"`+test.state+`","limit":1}`), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			caller := &recordedCaller{results: []Result{{Stdout: []byte(`{"items":[]}`)}}}
			if _, err := Execute(t.Context(), request, caller); err != nil {
				t.Fatal(err)
			}
			if got := caller.calls[0].Args[len(caller.calls[0].Args)-1]; got != test.endpoint {
				t.Fatalf("endpoint = %q, want %q", got, test.endpoint)
			}
		})
	}
}
