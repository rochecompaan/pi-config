package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestActionsNormalizeRealGitHubRunNames(t *testing.T) {
	raw := `{"id":9223372036854775807,"name":"CI","display_title":"lint","status":"completed","conclusion":null,"event":"push","head_branch":"main","head_sha":"0123456789012345678901234567890123456789","html_url":"https://x","created_at":"c","updated_at":"u","run_attempt":1,"jobs_url":"https://jobs"}`
	for _, test := range []struct{ operation, response string }{
		{"actions.runs.list", `{"workflow_runs":[` + raw + `]}`},
		{"actions.runs.get", raw},
	} {
		t.Run(test.operation, func(t *testing.T) {
			got, err := normalize(test.operation, []byte(test.response))
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err := json.Unmarshal(got, &value); err != nil {
				t.Fatal(err)
			}
			if values, ok := value.([]any); ok {
				value = values[0]
			}
			object := value.(map[string]any)
			if object["name"] != "lint" || object["workflowName"] != "CI" {
				t.Fatalf("names = %#v", object)
			}
		})
	}
}

func TestChecksAndStatusesAcceptNullableOptionalURLsAndOutput(t *testing.T) {
	checkValue := apiCheckRun{Name: stringPtr("check"), Status: stringPtr("completed"), DetailsURL: nil, Output: nil}
	got, err := check(checkValue)
	if err != nil {
		t.Fatal(err)
	}
	if got["detailsUrl"] != nil || got["description"] != nil {
		t.Fatalf("check = %#v", got)
	}
	statusValue := apiStatus{Context: stringPtr("ci"), State: stringPtr("success"), TargetURL: nil}
	got, err = status(statusValue)
	if err != nil {
		t.Fatal(err)
	}
	if got["detailsUrl"] != nil {
		t.Fatalf("status = %#v", got)
	}
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":1}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	for _, response := range []string{
		`{"total_count":1,"check_runs":[{"name":"check","status":"completed","details_url":5}]}`,
		`{"total_count":1,"statuses":[{"context":"ci","state":"success","target_url":5}]}`,
	} {
		caller := &recordedCaller{results: []Result{{Stdout: pullHead()}, {Stdout: []byte(response)}}}
		got, err := Execute(context.Background(), request, caller)
		if got != nil || err == nil {
			t.Fatalf("wrong-type response = %q, %v", got, err)
		}
	}
}

func TestPullRequestsListRequiresStateAndBuildsExactQueries(t *testing.T) {
	if _, err := Parse(protocol.PullRequestsList, json.RawMessage(`{"limit":1}`), "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("missing state error = %v", err)
	}
	for _, state := range []string{"open", "closed", "all"} {
		t.Run(state, func(t *testing.T) {
			request, err := Parse(protocol.PullRequestsList, json.RawMessage(`{"state":"`+state+`","limit":1}`), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			caller := &recordedCaller{results: []Result{{Stdout: []byte(`[]`)}}}
			if _, err := Execute(context.Background(), request, caller); err != nil {
				t.Fatal(err)
			}
			want := "/repos/owner/repo/pulls?per_page=1&state=" + state
			if got := caller.calls[0].Args[len(caller.calls[0].Args)-1]; got != want {
				t.Fatalf("endpoint = %q, want %q", got, want)
			}
		})
	}
}

func TestAllOperationsProduceCompletePinnedCallContracts(t *testing.T) {
	// The table intentionally exercises every RPC operation through Execute,
	// asserting generated calls rather than private builder implementation.
	for _, test := range callContractCases(t) {
		t.Run(string(test.operation), func(t *testing.T) {
			request, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			caller := &recordedCaller{results: test.results}
			_, err = Execute(context.Background(), request, caller)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(caller.calls, test.calls) {
				t.Fatalf("calls = %#v\nwant %#v", caller.calls, test.calls)
			}
		})
	}
}

func TestAllOperationSchemasRejectMissingInvalidBoundsAndClientFields(t *testing.T) {
	for _, test := range []struct {
		operation protocol.Operation
		arguments string
	}{
		{protocol.RepositoryGet, `{"repo":"other/repo"}`},
		{protocol.IssuesList, `{"state":"bad","limit":1}`},
		{protocol.IssuesGet, `{"number":0}`},
		{protocol.IssuesCreate, `{"title":""}`},
		{protocol.IssuesUpdate, `{"number":1}`},
		{protocol.IssuesComment, `{"number":1,"body":""}`},
		{protocol.PullRequestsList, `{"state":"bad","limit":1}`},
		{protocol.PullRequestsGet, `{"number":0}`},
		{protocol.PullRequestsCreate, `{"title":"title","head":"feature","base":"main"}`},
		{protocol.PullRequestsUpdate, `{"number":1}`},
		{protocol.PullRequestsComment, `{"number":1,"body":""}`},
		{protocol.PullRequestsDiff, `{"number":0}`},
		{protocol.PullRequestsChecks, `{"number":0}`},
		{protocol.ActionsRunsList, `{"limit":101}`},
		{protocol.ActionsRunsGet, `{"runId":0}`},
		{protocol.ActionsRunsLogs, `{"runId":0}`},
		{protocol.StatusesGet, `{"objectId":"not-a-commit"}`},
	} {
		t.Run(string(test.operation), func(t *testing.T) {
			if _, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("Parse(%s) error = %v", test.arguments, err)
			}
		})
	}
	for _, field := range []string{"repo", "jq", "template", "output", "outputProgram"} {
		if _, err := Parse(protocol.IssuesGet, json.RawMessage(`{"number":1,"`+field+`":"value"}`), "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("client field %q error = %v", field, err)
		}
	}
}

func TestHostPinningAndTextDataRemainInert(t *testing.T) {
	t.Setenv("GH_HOST", "attacker.invalid")
	t.Setenv("GH_REPO", "attacker/repo")
	request, err := Parse(protocol.IssuesCreate, json.RawMessage(`{"title":"$(x); --hostname evil\nnext","body":"$(x); --input file"}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{{Stdout: []byte(`{"number":1,"title":"$(x); --hostname evil\nnext","body":"$(x); --input file","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`)}}}
	if _, err := Execute(context.Background(), request, caller); err != nil {
		t.Fatal(err)
	}
	call := caller.calls[0]
	if !reflect.DeepEqual(call.Args[:3], []string{"api", "--hostname", "github.com"}) {
		t.Fatalf("host argv = %#v", call.Args)
	}
	for _, arg := range call.Args {
		if arg == "$(x); --hostname evil\nnext" || arg == "$(x); --input file" {
			t.Fatalf("text reached argv: %#v", call.Args)
		}
	}
	if !bytes.Contains(call.Stdin, []byte("$(x); --hostname evil\\nnext")) {
		t.Fatalf("stdin = %q", call.Stdin)
	}
}

type callContractCase struct {
	operation protocol.Operation
	arguments string
	results   []Result
	calls     []Call
}

func stringPtr(value string) *string { return &value }

func callContractCases(t *testing.T) []callContractCase {
	t.Helper()
	issue := `{"number":1,"title":"title","body":"body","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`
	pull := `{"number":1,"title":"title","body":"body","state":"open","draft":false,"user":{"login":"me"},"head":{"ref":"feature","sha":"0123456789012345678901234567890123456789"},"base":{"ref":"main"},"html_url":"https://x","created_at":"c","updated_at":"u","mergeable_state":"clean"}`
	comment := `{"id":1,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u"}`
	run := `{"id":1,"name":"workflow","display_title":"run","status":"completed","conclusion":"success","event":"push","head_branch":"main","head_sha":"0123456789012345678901234567890123456789","html_url":"https://x","created_at":"c","updated_at":"u","run_attempt":1,"jobs_url":"https://jobs"}`
	head := `{"head":{"sha":"0123456789012345678901234567890123456789"}}`
	checks := `{"total_count":0,"check_runs":[]}`
	statuses := `{"total_count":0,"statuses":[]}`
	preflight := `{"number":1}`
	api := func(method, endpoint, body string, limit int, failure, accept string) Call {
		args := []string{"api", "--hostname", "github.com", "--method", method, "-H", "Accept: " + accept, "-H", "X-GitHub-Api-Version: 2022-11-28"}
		if body != "" {
			args = append(args, "--input", "-")
		}
		args = append(args, endpoint)
		call := Call{Args: args, CloseStdin: true, RawLimit: limit, Failure: failure}
		if body != "" {
			call.Stdin = []byte(body)
		}
		return call
	}
	jsonAPI := func(method, endpoint, body string, limit int, failure string) Call {
		return api(method, endpoint, body, limit, failure, "application/vnd.github+json")
	}
	base := "/repos/owner/repo"
	return []callContractCase{
		{protocol.RepositoryGet, `{}`, []Result{{Stdout: []byte(`{"name":"repo","owner":{"login":"owner"},"full_name":"owner/repo","description":null,"private":false,"html_url":"https://x","default_branch":"main"}`)}}, []Call{jsonAPI("GET", base, "", miB, "repository read")}},
		{protocol.IssuesList, `{"state":"all","limit":1}`, []Result{{Stdout: []byte(`{"items":[]}`)}}, []Call{jsonAPI("GET", "/search/issues?q=repo%3Aowner%2Frepo+is%3Aissue&per_page=1", "", 8*miB, "issue list")}},
		{protocol.IssuesGet, `{"number":1}`, []Result{{Stdout: []byte(issue)}}, []Call{jsonAPI("GET", base+"/issues/1", "", 2*miB, "issue read")}},
		{protocol.IssuesCreate, `{"title":"title","body":"body"}`, []Result{{Stdout: []byte(issue)}}, []Call{jsonAPI("POST", base+"/issues", `{"body":"body","title":"title"}`, 2*miB, "issue create")}},
		{protocol.IssuesUpdate, `{"number":1,"title":"title"}`, []Result{{Stdout: []byte(preflight)}, {Stdout: []byte(issue)}}, []Call{jsonAPI("GET", base+"/issues/1", "", 4*miB, "resource preflight"), jsonAPI("PATCH", base+"/issues/1", `{"title":"title"}`, 4*miB-len(preflight), "issue update")}},
		{protocol.IssuesComment, `{"number":1,"body":"body"}`, []Result{{Stdout: []byte(preflight)}, {Stdout: []byte(comment)}}, []Call{jsonAPI("GET", base+"/issues/1", "", 4*miB, "resource preflight"), jsonAPI("POST", base+"/issues/1/comments", `{"body":"body"}`, 4*miB-len(preflight), "issue comment")}},
		{protocol.PullRequestsList, `{"state":"open","limit":1}`, []Result{{Stdout: []byte(`[]`)}}, []Call{jsonAPI("GET", base+"/pulls?per_page=1&state=open", "", 8*miB, "pull-request list")}},
		{protocol.PullRequestsGet, `{"number":1}`, []Result{{Stdout: []byte(pull)}}, []Call{jsonAPI("GET", base+"/pulls/1", "", 2*miB, "pull-request read")}},
		{protocol.PullRequestsCreate, `{"title":"title","head":"feature","base":"main","body":"body","draft":false}`, []Result{{Stdout: []byte(pull)}}, []Call{jsonAPI("POST", base+"/pulls", `{"base":"main","body":"body","draft":false,"head":"feature","title":"title"}`, 2*miB, "pull-request create")}},
		{protocol.PullRequestsUpdate, `{"number":1,"base":"main"}`, []Result{{Stdout: []byte(pull)}}, []Call{jsonAPI("PATCH", base+"/pulls/1", `{"base":"main"}`, 2*miB, "pull-request update")}},
		{protocol.PullRequestsComment, `{"number":1,"body":"body"}`, []Result{{Stdout: []byte(pull)}, {Stdout: []byte(comment)}}, []Call{jsonAPI("GET", base+"/pulls/1", "", 4*miB, "resource preflight"), jsonAPI("POST", base+"/issues/1/comments", `{"body":"body"}`, 4*miB-len(pull), "pull-request comment")}},
		{protocol.PullRequestsDiff, `{"number":1}`, []Result{{Stdout: []byte("diff --git a/a b/a\n")}}, []Call{api("GET", base+"/pulls/1", "", 8*miB, "pull-request diff", "application/vnd.github.diff")}},
		{protocol.PullRequestsChecks, `{"number":1}`, []Result{{Stdout: []byte(head)}, {Stdout: []byte(checks)}, {Stdout: []byte(statuses)}}, []Call{jsonAPI("GET", base+"/pulls/1", "", 8*miB, "pull-request preflight"), jsonAPI("GET", base+"/commits/0123456789012345678901234567890123456789/check-runs?page=1&per_page=100", "", 8*miB-len(head), "pull-request checks"), jsonAPI("GET", base+"/commits/0123456789012345678901234567890123456789/status?page=1&per_page=100", "", 8*miB-len(head)-len(checks), "pull-request checks")}},
		{protocol.ActionsRunsList, `{"limit":1}`, []Result{{Stdout: []byte(`{"workflow_runs":[` + run + `]}`)}}, []Call{jsonAPI("GET", base+"/actions/runs?per_page=1", "", 8*miB, "actions run list")}},
		{protocol.ActionsRunsGet, `{"runId":1}`, []Result{{Stdout: []byte(run)}}, []Call{jsonAPI("GET", base+"/actions/runs/1", "", 2*miB, "actions run read")}},
		{protocol.ActionsRunsLogs, `{"runId":1}`, []Result{{Stdout: []byte("log\n")}}, []Call{{Args: []string{"run", "view", "--repo", "github.com/owner/repo", "--log", "1"}, CloseStdin: true, RawLimit: 32 * miB, Failure: "actions run logs"}}},
		{protocol.StatusesGet, `{"objectId":"0123456789012345678901234567890123456789"}`, []Result{{Stdout: []byte(`{"state":"success","sha":"0123456789012345678901234567890123456789","statuses":[]}`)}}, []Call{jsonAPI("GET", base+"/commits/0123456789012345678901234567890123456789/status", "", 8*miB, "commit status read")}},
	}
}
