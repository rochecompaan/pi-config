package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const reviewSHA = "0123456789012345678901234567890123456789"

func TestChecksReturnsOneFlatArray(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{
		{Stdout: []byte(`{"head":{"sha":"` + reviewSHA + `"}}`)},
		{Stdout: []byte(`{"total_count":1,"check_runs":[{"name":"check","status":"completed","conclusion":"success","details_url":"https://x","output":{"title":"ok"}}]}`)},
		{Stdout: []byte(`{"total_count":1,"statuses":[{"context":"status","state":"success","target_url":"https://x"}]}`)},
	}}
	got, err := Execute(context.Background(), request, caller)
	if err != nil {
		t.Fatal(err)
	}
	var output []map[string]any
	if err := json.Unmarshal(got, &output); err != nil {
		t.Fatalf("response is not flat array: %v (%s)", err, got)
	}
	if len(output) != 2 {
		t.Fatalf("records = %#v", output)
	}
}

func TestChecksRejectsCombinedRecordAndPageOverrunsWithoutPartialResult(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		responses []Result
		want      error
	}{
		{"record", []Result{{Stdout: pullHead()}, {Stdout: page("check_runs", 1001, 1001)}}, ErrResultTooLarge},
		{"over-returned", []Result{{Stdout: pullHead()}, {Stdout: page("check_runs", 1, 2)}, {Stdout: page("statuses", 0, 0)}}, ErrResultTooLarge},
		{"page", append([]Result{{Stdout: pullHead()}}, tenPages("check_runs", 1001)...), ErrResultTooLarge},
		{"byte", []Result{{Stdout: pullHead()}, {Stdout: make([]byte, 8*miB)}}, ErrResultTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			caller := &recordedCaller{results: test.responses}
			got, err := Execute(context.Background(), request, caller)
			if got != nil || !errors.Is(err, test.want) {
				t.Fatalf("Execute() = %q, %v; want nil, %v", got, err, test.want)
			}
		})
	}
}

func TestChecksAcceptsEmptyAndFinalPages(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{
		{Stdout: pullHead()},
		{Stdout: page("check_runs", 101, 100)}, {Stdout: page("check_runs", 101, 1)},
		{Stdout: page("statuses", 0, 0)},
	}}
	got, err := Execute(context.Background(), request, caller)
	if err != nil {
		t.Fatal(err)
	}
	var values []any
	if err := json.Unmarshal(got, &values); err != nil {
		t.Fatal(err)
	}
	if len(values) != 101 {
		t.Fatalf("records = %d", len(values))
	}
}

func pullHead() []byte { return []byte(`{"head":{"sha":"` + reviewSHA + `"}}`) }
func page(field string, total, records int) []byte {
	values := ""
	for index := 0; index < records; index++ {
		if index > 0 {
			values += ","
		}
		if field == "check_runs" {
			values += `{"name":"check","status":"completed","conclusion":"success","details_url":"https://x","output":{"title":"ok"}}`
		} else {
			values += `{"context":"status","state":"success","target_url":"https://x"}`
		}
	}
	return []byte(fmt.Sprintf(`{"total_count":%d,"%s":[%s]}`, total, field, values))
}
func tenPages(field string, total int) []Result {
	values := make([]Result, 10)
	for index := range values {
		values[index] = Result{Stdout: page(field, total, 100)}
	}
	return values
}
