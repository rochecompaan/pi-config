package github

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

type recordedCaller struct {
	calls   []Call
	results []Result
	err     *CallerError
}

func (c *recordedCaller) Call(_ context.Context, call Call) (Result, *CallerError) {
	c.calls = append(c.calls, call)
	if c.err != nil {
		return Result{}, c.err
	}
	if len(c.results) == 0 {
		return Result{}, &CallerError{ExitStatus: 1}
	}
	result := c.results[0]
	c.results = c.results[1:]
	return result, nil
}

func TestParseRequiresExactlyBoundedOperationArguments(t *testing.T) {
	tests := []struct {
		operation    protocol.Operation
		arguments    string
		capabilities []config.Capability
	}{
		{protocol.RepositoryGet, `{}`, []config.Capability{config.RepositoryRead}},
		{protocol.IssuesList, `{"state":"open","limit":2}`, []config.Capability{config.IssuesRead}},
		{protocol.IssuesGet, `{"number":1}`, []config.Capability{config.IssuesRead}},
		{protocol.IssuesCreate, `{"title":"title","body":"body"}`, []config.Capability{config.IssuesWrite}},
		{protocol.IssuesUpdate, `{"number":1,"state":"closed"}`, []config.Capability{config.IssuesWrite}},
		{protocol.IssuesComment, `{"number":1,"body":"body"}`, []config.Capability{config.IssuesWrite}},
		{protocol.PullRequestsList, `{"state":"open","base":"main","head":"feature","limit":2}`, []config.Capability{config.PullRequestsRead}},
		{protocol.PullRequestsGet, `{"number":1}`, []config.Capability{config.PullRequestsRead}},
		{protocol.PullRequestsCreate, `{"title":"title","head":"feature","base":"main","body":"body","draft":false}`, []config.Capability{config.PullRequestsWrite}},
		{protocol.PullRequestsUpdate, `{"number":1,"base":"main"}`, []config.Capability{config.PullRequestsWrite}},
		{protocol.PullRequestsComment, `{"number":1,"body":"body"}`, []config.Capability{config.PullRequestsWrite}},
		{protocol.PullRequestsDiff, `{"number":1}`, []config.Capability{config.PullRequestsRead}},
		{protocol.PullRequestsChecks, `{"number":1}`, []config.Capability{config.PullRequestsRead, config.StatusesRead}},
		{protocol.ActionsRunsList, `{"branch":"main","status":"completed","limit":2}`, []config.Capability{config.ActionsRead}},
		{protocol.ActionsRunsGet, `{"runId":1}`, []config.Capability{config.ActionsRead}},
		{protocol.ActionsRunsLogs, `{"runId":1}`, []config.Capability{config.ActionsRead}},
		{protocol.StatusesGet, `{"objectId":"0123456789012345678901234567890123456789"}`, []config.Capability{config.StatusesRead}},
	}
	for _, test := range tests {
		t.Run(string(test.operation), func(t *testing.T) {
			request, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo")
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			if got := RequiredCapabilities(request); !reflect.DeepEqual(got, test.capabilities) {
				t.Fatalf("RequiredCapabilities() = %v, want %v", got, test.capabilities)
			}
		})
	}
}

func TestParseRejectsInvalidAndUnknownArguments(t *testing.T) {
	for _, test := range []struct {
		operation protocol.Operation
		arguments string
	}{
		{protocol.IssuesGet, `{"number":"https://github.com/issues/1"}`},
		{protocol.IssuesList, `{"limit":0}`},
		{protocol.IssuesCreate, `{"title":""}`},
		{protocol.IssuesUpdate, `{"number":1}`},
		{protocol.IssuesComment, `{"number":1,"body":""}`},
		{protocol.PullRequestsList, `{"state":"merged"}`},
		{protocol.PullRequestsCreate, `{"title":"x","head":"bad name","base":"main"}`},
		{protocol.PullRequestsCreate, `{"title":"x","head":"feature","base":"main"}`},
		{protocol.PullRequestsUpdate, `{"number":1}`},
		{protocol.ActionsRunsLogs, `{"runId":0}`},
		{protocol.StatusesGet, `{"objectId":"https://github.com/commit/1"}`},
		{protocol.IssuesGet, `{"number":1,"jq":".x"}`},
	} {
		t.Run(string(test.operation), func(t *testing.T) {
			if _, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo"); err == nil {
				t.Fatalf("Parse(%s) succeeded", test.arguments)
			}
		})
	}
}

func TestExecuteBuildsFixedCallsAndNormalizesResponses(t *testing.T) {
	request, err := Parse(protocol.IssuesCreate, json.RawMessage(`{"title":"title; $(nope)","body":"body"}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{{Stdout: []byte(`{"number":7,"title":"title; $(nope)","body":"body","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://github.com/o/r/issues/7","created_at":"","updated_at":"","secret":"discard"}`)}}}
	got, err := Execute(context.Background(), request, caller)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	wantArgs := []string{"api", "--hostname", "github.com", "--method", "POST", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "--input", "-", "/repos/owner/repo/issues"}
	if !reflect.DeepEqual(caller.calls[0].Args, wantArgs) {
		t.Fatalf("host argv = %#v, want %#v", caller.calls[0].Args, wantArgs)
	}
	if string(caller.calls[0].Stdin) != `{"body":"body","title":"title; $(nope)"}` || !caller.calls[0].CloseStdin {
		t.Fatalf("host stdin = %q, close = %v", caller.calls[0].Stdin, caller.calls[0].CloseStdin)
	}
	if strings.Contains(strings.Join(caller.calls[0].Args, " "), "title; $(nope)") {
		t.Fatal("client text reached host argv")
	}
	assertJSON(t, got, `{"number":7,"title":"title; $(nope)","body":"body","state":"open","author":"me","assignees":[],"labels":[],"url":"https://github.com/o/r/issues/7","createdAt":"","updatedAt":""}`)
}

func TestExecuteUsesFixedIssueSearchQuery(t *testing.T) {
	request, err := Parse(protocol.IssuesList, json.RawMessage(`{"state":"closed","limit":2}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{{Stdout: []byte(`{"items":[]}`)}}}
	if _, err := Execute(context.Background(), request, caller); err != nil {
		t.Fatal(err)
	}
	want := "/search/issues?q=repo%3Aowner%2Frepo+is%3Aissue+state%3Aclosed&per_page=2"
	if got := caller.calls[0].Args[len(caller.calls[0].Args)-1]; got != want {
		t.Fatalf("endpoint = %q, want %q", got, want)
	}
}

func TestExecutePreflightsMutationsWithoutLeakingPartialCalls(t *testing.T) {
	for _, test := range []struct {
		operation            protocol.Operation
		arguments, preflight string
	}{
		{protocol.IssuesUpdate, `{"number":3,"title":"new"}`, `{"pull_request":{}}`},
		{protocol.IssuesComment, `{"number":3,"body":"body"}`, `{"pull_request":{}}`},
		{protocol.PullRequestsComment, `{"number":3,"body":"body"}`, `{"number":3,"title":"issue"}`},
	} {
		t.Run(string(test.operation), func(t *testing.T) {
			request, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			caller := &recordedCaller{results: []Result{{Stdout: []byte(test.preflight)}}}
			if _, err := Execute(context.Background(), request, caller); err == nil {
				t.Fatal("Execute() succeeded")
			}
			if len(caller.calls) != 1 {
				t.Fatalf("host calls = %d, want only preflight", len(caller.calls))
			}
		})
	}
}

func TestExecuteRejectsPullRequestsFromIssueRead(t *testing.T) {
	request, err := Parse(protocol.IssuesGet, json.RawMessage(`{"number":3}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{{Stdout: []byte(`{"number":3,"pull_request":{}}`)}}}
	if _, err := Execute(context.Background(), request, caller); !errors.Is(err, ErrWrongResource) {
		t.Fatalf("Execute() error = %v, want ErrWrongResource", err)
	}
}

func TestExecuteChecksPaginatesAndRejectsPartialOverLimit(t *testing.T) {
	request, err := Parse(protocol.PullRequestsChecks, json.RawMessage(`{"number":3}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{
		{Stdout: []byte(`{"head":{"sha":"0123456789012345678901234567890123456789"}}`)},
		{Stdout: []byte(`{"total_count":1,"check_runs":[{"name":"check","status":"completed","conclusion":"success","details_url":"https://x","output":{"title":""}}]}`)},
		{Stdout: []byte(`{"total_count":1,"statuses":[{"context":"ci","state":"success","target_url":"https://x"}]}`)},
	}}
	got, err := Execute(context.Background(), request, caller)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, got, `[{"name":"check","state":"completed","conclusion":"success","detailsUrl":"https://x","description":"","startedAt":null,"completedAt":null},{"name":"ci","state":"success","conclusion":null,"detailsUrl":"https://x","description":null,"startedAt":null,"completedAt":null}]`)
	if len(caller.calls) != 3 || !strings.Contains(caller.calls[1].Args[len(caller.calls[1].Args)-1], "page=1&per_page=100") {
		t.Fatalf("pagination calls = %#v", caller.calls)
	}

	caller = &recordedCaller{results: []Result{{Stdout: []byte(`{"head":{"sha":"0123456789012345678901234567890123456789"}}`)}, {Stdout: []byte(`{"total_count":1001,"check_runs":[]}`)}}}
	if _, err := Execute(context.Background(), request, caller); !errors.Is(err, ErrResultTooLarge) {
		t.Fatalf("over-limit Execute() error = %v, want ErrResultTooLarge", err)
	}
}

func TestExecuteRejectsRawLimitAndDoesNotUseEnvironmentOrOutputPrograms(t *testing.T) {
	request, err := Parse(protocol.RepositoryGet, json.RawMessage(`{}`), "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{results: []Result{{Stdout: make([]byte, 1<<20+1)}}}
	if _, err := Execute(context.Background(), request, caller); !errors.Is(err, ErrResultTooLarge) {
		t.Fatalf("oversize Execute() error = %v, want ErrResultTooLarge", err)
	}
	if caller.calls[0].RawLimit != 1<<20 {
		t.Fatalf("raw limit = %d", caller.calls[0].RawLimit)
	}
	for _, forbidden := range []string{"GH_HOST", "GH_REPO", "--jq", "--template", "--paginate"} {
		if strings.Contains(strings.Join(caller.calls[0].Args, " "), forbidden) {
			t.Fatalf("forbidden %q in argv", forbidden)
		}
	}
}

func TestExecuteBuildsFixedHostCallForEachRemainingOperation(t *testing.T) {
	issue := `{"number":1,"title":"title","body":"body","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`
	pull := `{"number":1,"title":"title","body":"body","state":"open","draft":false,"user":{"login":"me"},"head":{"ref":"feature","sha":"0123456789012345678901234567890123456789"},"base":{"ref":"main"},"html_url":"https://x","created_at":"c","updated_at":"u"}`
	comment := `{"id":1,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u"}`
	run := `{"id":1,"name":"workflow","display_title":"run","status":"completed","conclusion":"success","event":"push","head_branch":"main","head_sha":"0123456789012345678901234567890123456789","html_url":"https://x","created_at":"c","updated_at":"u","run_attempt":1,"jobs_url":"https://jobs"}`
	for _, test := range []struct {
		operation protocol.Operation
		arguments string
		responses []string
		endpoint  string
	}{
		{protocol.RepositoryGet, `{}`, []string{`{"name":"repo","owner":{"login":"owner"},"full_name":"owner/repo","private":false,"html_url":"https://x","default_branch":"main"}`}, "/repos/owner/repo"},
		{protocol.IssuesGet, `{"number":1}`, []string{issue}, "/repos/owner/repo/issues/1"},
		{protocol.IssuesUpdate, `{"number":1,"title":"new"}`, []string{issue, issue}, "/repos/owner/repo/issues/1"},
		{protocol.IssuesComment, `{"number":1,"body":"body"}`, []string{issue, comment}, "/repos/owner/repo/issues/1/comments"},
		{protocol.PullRequestsList, `{"state":"open","limit":1}`, []string{"[" + pull + "]"}, "/repos/owner/repo/pulls?"},
		{protocol.PullRequestsGet, `{"number":1}`, []string{pull}, "/repos/owner/repo/pulls/1"},
		{protocol.PullRequestsCreate, `{"title":"title","head":"feature","base":"main","draft":false}`, []string{pull}, "/repos/owner/repo/pulls"},
		{protocol.PullRequestsUpdate, `{"number":1,"title":"new"}`, []string{pull}, "/repos/owner/repo/pulls/1"},
		{protocol.PullRequestsComment, `{"number":1,"body":"body"}`, []string{pull, comment}, "/repos/owner/repo/issues/1/comments"},
		{protocol.PullRequestsDiff, `{"number":1}`, []string{"diff --git a/a b/a\n"}, "/repos/owner/repo/pulls/1"},
		{protocol.ActionsRunsList, `{"limit":1}`, []string{`{"workflow_runs":[` + run + `]}`}, "/repos/owner/repo/actions/runs?"},
		{protocol.ActionsRunsGet, `{"runId":1}`, []string{run}, "/repos/owner/repo/actions/runs/1"},
		{protocol.ActionsRunsLogs, `{"runId":1}`, []string{"log line\n"}, "1"},
		{protocol.StatusesGet, `{"objectId":"0123456789012345678901234567890123456789"}`, []string{`{"state":"success","sha":"0123456789012345678901234567890123456789","statuses":[]}`}, "/repos/owner/repo/commits/0123456789012345678901234567890123456789/status"},
	} {
		t.Run(string(test.operation), func(t *testing.T) {
			request, err := Parse(test.operation, json.RawMessage(test.arguments), "owner/repo")
			if err != nil {
				t.Fatal(err)
			}
			caller := &recordedCaller{}
			for _, response := range test.responses {
				caller.results = append(caller.results, Result{Stdout: []byte(response)})
			}
			if _, err := Execute(context.Background(), request, caller); err != nil {
				t.Fatal(err)
			}
			last := caller.calls[len(caller.calls)-1]
			if !strings.Contains(last.Args[len(last.Args)-1], test.endpoint) {
				t.Fatalf("last argv = %#v, missing endpoint %q", last.Args, test.endpoint)
			}
			if strings.Contains(strings.Join(last.Args, " "), "--jq") {
				t.Fatal("client output program reached host argv")
			}
		})
	}
}

func assertJSON(t *testing.T, got []byte, want string) {
	t.Helper()
	var gotValue, wantValue any
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("invalid got JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("invalid want JSON: %v", err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("JSON = %#v, want %#v", gotValue, wantValue)
	}
}
