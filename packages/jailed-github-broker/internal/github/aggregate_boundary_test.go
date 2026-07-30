package github

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestMutationPreflightAggregateBoundaries(t *testing.T) {
	issue := []byte(`{"number":1,"title":"title","body":"body","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`)
	comment := []byte(`{"id":1,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u"}`)
	pull := []byte(`{"number":1,"title":"title","body":"body","state":"open","draft":false,"user":{"login":"me"},"head":{"ref":"feature","sha":"0123456789012345678901234567890123456789"},"base":{"ref":"main"},"html_url":"https://x","created_at":"c","updated_at":"u"}`)
	for _, test := range []struct {
		operation            protocol.Operation
		arguments, preflight string
		result               []byte
	}{
		{protocol.IssuesUpdate, `{"number":1,"title":"new"}`, `{"number":1}`, issue},
		{protocol.IssuesComment, `{"number":1,"body":"body"}`, `{"number":1}`, comment},
		{protocol.PullRequestsComment, `{"number":1,"body":"body"}`, string(pull), comment},
	} {
		t.Run(string(test.operation), func(t *testing.T) {
			request, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			preflight := paddedJSON(test.preflight, 4*miB-len(test.result))
			caller := &recordedCaller{results: []Result{{Stdout: preflight}, {Stdout: test.result}}}
			got, err := Execute(context.Background(), request, caller)
			if err != nil || got == nil {
				t.Fatalf("exact aggregate Execute() = %q, %v", got, err)
			}
			if len(caller.calls) != 2 || caller.calls[1].RawLimit != len(test.result) {
				t.Fatalf("calls = %#v", caller.calls)
			}

			caller = &recordedCaller{results: []Result{{Stdout: paddedJSON(test.preflight, 4*miB+1)}}}
			got, err = Execute(context.Background(), request, caller)
			if got != nil || !errors.Is(err, ErrResultTooLarge) {
				t.Fatalf("over aggregate Execute() = %q, %v", got, err)
			}
			if len(caller.calls) != 1 {
				t.Fatalf("over aggregate calls = %d, want only preflight", len(caller.calls))
			}
		})
	}
}

func paddedJSON(value string, size int) []byte {
	if len(value) > size {
		panic("fixture exceeds requested size")
	}
	return []byte(value + strings.Repeat(" ", size-len(value)))
}
