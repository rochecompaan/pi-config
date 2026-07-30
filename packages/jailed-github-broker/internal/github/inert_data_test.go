package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const hostileText = "--hostile; $(subshell) \"double\" 'single' spaces\nnext-line"
const hostileName = "--hostile;$(subshell)\"double\"'single'"

func TestFreeTextAndNameArgumentsRemainInert(t *testing.T) {
	t.Setenv("GH_HOST", hostileText)
	t.Setenv("GH_REPO", hostileText)

	pullQuery := func(field string) url.Values {
		return url.Values{"per_page": []string{"1"}, "state": []string{"open"}, field: []string{hostileName}}
	}
	cases := []struct {
		name, field, queryField, method, endpoint, preflight string
		operation                                            protocol.Operation
		arguments                                            map[string]any
		value                                                string
	}{
		{"issues.create.title", "title", "", "POST", "/repos/owner/repo/issues", "", protocol.IssuesCreate, map[string]any{"title": hostileText, "body": "body"}, hostileText},
		{"issues.create.body", "body", "", "POST", "/repos/owner/repo/issues", "", protocol.IssuesCreate, map[string]any{"title": "title", "body": hostileText}, hostileText},
		{"issues.update.title", "title", "", "PATCH", "/repos/owner/repo/issues/1", "/repos/owner/repo/issues/1", protocol.IssuesUpdate, map[string]any{"number": 1, "title": hostileText}, hostileText},
		{"issues.update.body", "body", "", "PATCH", "/repos/owner/repo/issues/1", "/repos/owner/repo/issues/1", protocol.IssuesUpdate, map[string]any{"number": 1, "body": hostileText}, hostileText},
		{"issues.comment.body", "body", "", "POST", "/repos/owner/repo/issues/1/comments", "/repos/owner/repo/issues/1", protocol.IssuesComment, map[string]any{"number": 1, "body": hostileText}, hostileText},
		{"pullRequests.list.base", "", "base", "GET", "/repos/owner/repo/pulls?" + pullQuery("base").Encode(), "", protocol.PullRequestsList, map[string]any{"state": "open", "base": hostileName, "limit": 1}, hostileName},
		{"pullRequests.list.head", "", "head", "GET", "/repos/owner/repo/pulls?" + pullQuery("head").Encode(), "", protocol.PullRequestsList, map[string]any{"state": "open", "head": hostileName, "limit": 1}, hostileName},
		{"pullRequests.create.title", "title", "", "POST", "/repos/owner/repo/pulls", "", protocol.PullRequestsCreate, map[string]any{"title": hostileText, "head": "feature", "base": "main", "body": "body", "draft": false}, hostileText},
		{"pullRequests.create.head", "head", "", "POST", "/repos/owner/repo/pulls", "", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": hostileName, "base": "main", "body": "body", "draft": false}, hostileName},
		{"pullRequests.create.base", "base", "", "POST", "/repos/owner/repo/pulls", "", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": hostileName, "body": "body", "draft": false}, hostileName},
		{"pullRequests.create.body", "body", "", "POST", "/repos/owner/repo/pulls", "", protocol.PullRequestsCreate, map[string]any{"title": "title", "head": "feature", "base": "main", "body": hostileText, "draft": false}, hostileText},
		{"pullRequests.update.title", "title", "", "PATCH", "/repos/owner/repo/pulls/1", "", protocol.PullRequestsUpdate, map[string]any{"number": 1, "title": hostileText}, hostileText},
		{"pullRequests.update.body", "body", "", "PATCH", "/repos/owner/repo/pulls/1", "", protocol.PullRequestsUpdate, map[string]any{"number": 1, "body": hostileText}, hostileText},
		{"pullRequests.update.base", "base", "", "PATCH", "/repos/owner/repo/pulls/1", "", protocol.PullRequestsUpdate, map[string]any{"number": 1, "base": hostileName}, hostileName},
		{"pullRequests.comment.body", "body", "", "POST", "/repos/owner/repo/issues/1/comments", "/repos/owner/repo/pulls/1", protocol.PullRequestsComment, map[string]any{"number": 1, "body": hostileText}, hostileText},
		{"actions.runs.list.branch", "", "branch", "GET", "/repos/owner/repo/actions/runs?" + url.Values{"branch": []string{hostileName}, "per_page": []string{"1"}}.Encode(), "", protocol.ActionsRunsList, map[string]any{"branch": hostileName, "limit": 1}, hostileName},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			arguments, err := json.Marshal(test.arguments)
			if err != nil {
				t.Fatal(err)
			}
			request, err := Parse(test.operation, arguments, "owner/repo")
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			caller := &recordedCaller{results: inertResults(test.operation)}
			if _, err := Execute(context.Background(), request, caller); err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			if test.preflight != "" {
				assertPinnedAPIArgs(t, caller.calls[0].Args, "GET", test.preflight, false)
			}
			call := caller.calls[len(caller.calls)-1]
			assertPinnedAPIArgs(t, call.Args, test.method, test.endpoint, test.queryField == "")
			for _, call := range caller.calls {
				for _, argument := range call.Args {
					if strings.Contains(argument, test.value) || strings.Contains(argument, "attacker.invalid") {
						t.Fatalf("untrusted text reached argv: %#v", call.Args)
					}
				}
			}
			if test.queryField != "" {
				if len(call.Stdin) != 0 {
					t.Fatalf("query value reached stdin: %q", call.Stdin)
				}
				parsed, err := url.ParseRequestURI(test.endpoint)
				if err != nil {
					t.Fatal(err)
				}
				if got := parsed.Query().Get(test.queryField); got != test.value {
					t.Fatalf("query %q = %q, want %q", test.queryField, got, test.value)
				}
				return
			}
			var input map[string]any
			if err := json.Unmarshal(call.Stdin, &input); err != nil {
				t.Fatalf("stdin is not JSON: %v", err)
			}
			if got := input[test.field]; got != test.value {
				t.Fatalf("JSON %q = %#v, want %#v", test.field, got, test.value)
			}
		})
	}
}

func TestEnumAndNameWhitespaceArgumentsRejectBeforeCallingHost(t *testing.T) {
	for _, test := range []struct {
		name      string
		operation protocol.Operation
		arguments map[string]any
	}{
		{"issues.list.state", protocol.IssuesList, map[string]any{"state": hostileText, "limit": 1}},
		{"issues.update.state", protocol.IssuesUpdate, map[string]any{"number": 1, "state": hostileText}},
		{"pullRequests.list.state", protocol.PullRequestsList, map[string]any{"state": hostileText, "limit": 1}},
		{"pullRequests.update.state", protocol.PullRequestsUpdate, map[string]any{"number": 1, "state": hostileText}},
		{"actions.runs.list.status", protocol.ActionsRunsList, map[string]any{"status": hostileText, "limit": 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			assertParseRejectsWithoutCall(t, test.operation, test.arguments)
		})
	}

	for _, test := range []struct {
		name      string
		operation protocol.Operation
		field     string
		arguments map[string]any
	}{
		{"pullRequests.list.base", protocol.PullRequestsList, "base", map[string]any{"state": "open", "limit": 1}},
		{"pullRequests.list.head", protocol.PullRequestsList, "head", map[string]any{"state": "open", "limit": 1}},
		{"pullRequests.create.head", protocol.PullRequestsCreate, "head", map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}},
		{"pullRequests.create.base", protocol.PullRequestsCreate, "base", map[string]any{"title": "title", "head": "feature", "base": "main", "body": "body", "draft": false}},
		{"pullRequests.update.base", protocol.PullRequestsUpdate, "base", map[string]any{"number": 1, "base": "main"}},
		{"actions.runs.list.branch", protocol.ActionsRunsList, "branch", map[string]any{"branch": "main", "limit": 1}},
	} {
		for _, whitespace := range []string{" space", "\ttab", "\rreturn", "\nnewline", "\x00nul"} {
			t.Run(test.name+"/"+strconv.Quote(whitespace), func(t *testing.T) {
				arguments := make(map[string]any, len(test.arguments))
				for key, value := range test.arguments {
					arguments[key] = value
				}
				arguments[test.field] = "name" + whitespace
				assertParseRejectsWithoutCall(t, test.operation, arguments)
			})
		}
	}
}

func TestForbiddenRPCFieldsRejectBeforeCallingHost(t *testing.T) {
	operations := []struct {
		name      string
		operation protocol.Operation
		arguments map[string]any
	}{
		{"read", protocol.IssuesGet, map[string]any{"number": 1}},
		{"write", protocol.IssuesCreate, map[string]any{"title": "title", "body": "body"}},
		{"list", protocol.PullRequestsList, map[string]any{"state": "open", "limit": 1}},
	}
	for _, operation := range operations {
		for _, field := range []string{"repo", "jq", "template", "web", "editor", "bodyFile", "recover", "json", "fields", "hostname", "endpoint", "method", "headers"} {
			t.Run(operation.name+"/"+field, func(t *testing.T) {
				arguments := make(map[string]any, len(operation.arguments)+1)
				for key, value := range operation.arguments {
					arguments[key] = value
				}
				arguments[field] = hostileText
				assertParseRejectsWithoutCall(t, operation.operation, arguments)
			})
		}
	}
}

func assertParseRejectsWithoutCall(t *testing.T, operation protocol.Operation, arguments map[string]any) {
	t.Helper()
	data, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	caller := &recordedCaller{}
	if _, err := Parse(operation, data, "owner/repo"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Parse(%s) error = %v, want ErrInvalidRequest", data, err)
	}
	if len(caller.calls) != 0 {
		t.Fatalf("Caller calls = %#v, want none", caller.calls)
	}
}

func assertPinnedAPIArgs(t *testing.T, got []string, method, endpoint string, input bool) {
	t.Helper()
	want := []string{"api", "--hostname", "github.com", "--method", method, "-H", "Accept: " + apiAccept, "-H", "X-GitHub-Api-Version: " + apiVersion}
	if input {
		want = append(want, "--input", "-")
	}
	want = append(want, endpoint)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %#v\nwant %#v", got, want)
	}
}

func inertResults(operation protocol.Operation) []Result {
	issue := `{"number":1,"title":"title","body":"body","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`
	pull := `{"number":1,"title":"title","body":"body","state":"open","draft":false,"user":{"login":"me"},"head":{"ref":"feature","sha":"0123456789012345678901234567890123456789"},"base":{"ref":"main"},"html_url":"https://x","created_at":"c","updated_at":"u","mergeable_state":"clean"}`
	comment := `{"id":1,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u"}`
	switch operation {
	case protocol.IssuesCreate:
		return []Result{{Stdout: []byte(issue)}}
	case protocol.IssuesUpdate:
		return []Result{{Stdout: []byte(`{"number":1}`)}, {Stdout: []byte(issue)}}
	case protocol.IssuesComment:
		return []Result{{Stdout: []byte(`{"number":1}`)}, {Stdout: []byte(comment)}}
	case protocol.PullRequestsList:
		return []Result{{Stdout: []byte(`[]`)}}
	case protocol.PullRequestsCreate, protocol.PullRequestsUpdate:
		return []Result{{Stdout: []byte(pull)}}
	case protocol.PullRequestsComment:
		return []Result{{Stdout: []byte(`{"head":{"ref":"feature"}}`)}, {Stdout: []byte(comment)}}
	case protocol.ActionsRunsList:
		return []Result{{Stdout: []byte(`{"workflow_runs":[]}`)}}
	default:
		panic("missing inert result for " + string(operation))
	}
}
