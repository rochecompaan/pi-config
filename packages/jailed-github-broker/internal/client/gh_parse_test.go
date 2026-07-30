package client

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestParseGHApprovedOperations(t *testing.T) {
	falseValue := false
	tests := []struct {
		name      string
		args      []string
		operation protocol.Operation
		want      map[string]any
		raw       bool
	}{
		{"repository view", []string{"repo", "view"}, protocol.RepositoryGet, map[string]any{}, false},
		{"issue list defaults", []string{"issue", "list"}, protocol.IssuesList, map[string]any{"state": "open", "limit": float64(30)}, false},
		{"issue list", []string{"issue", "list", "--state", "all", "--limit", "100"}, protocol.IssuesList, map[string]any{"state": "all", "limit": float64(100)}, false},
		{"issue view", []string{"issue", "view", "12"}, protocol.IssuesGet, map[string]any{"number": float64(12)}, false},
		{"issue create", []string{"issue", "create", "--title", "title", "--body", "body"}, protocol.IssuesCreate, map[string]any{"title": "title", "body": "body"}, false},
		{"issue create empty body", []string{"issue", "create", "--title", "title"}, protocol.IssuesCreate, map[string]any{"title": "title", "body": ""}, false},
		{"issue edit", []string{"issue", "edit", "12", "--state", "closed", "--body", ""}, protocol.IssuesUpdate, map[string]any{"number": float64(12), "state": "closed", "body": ""}, false},
		{"issue comment", []string{"issue", "comment", "12", "--body", "hello"}, protocol.IssuesComment, map[string]any{"number": float64(12), "body": "hello"}, false},
		{"pr list defaults", []string{"pr", "list"}, protocol.PullRequestsList, map[string]any{"state": "open", "base": "", "head": "", "limit": float64(30)}, false},
		{"pr list", []string{"pr", "list", "--state", "closed", "--base", "main", "--head", "topic", "--limit", "2"}, protocol.PullRequestsList, map[string]any{"state": "closed", "base": "main", "head": "topic", "limit": float64(2)}, false},
		{"pr view", []string{"pr", "view", "2"}, protocol.PullRequestsGet, map[string]any{"number": float64(2)}, false},
		{"pr create", []string{"pr", "create", "--head", "topic", "--base", "main", "--title", "title", "--draft"}, protocol.PullRequestsCreate, map[string]any{"head": "topic", "base": "main", "title": "title", "body": "", "draft": true}, false},
		{"pr create default draft", []string{"pr", "create", "--title", "title", "--base", "main", "--head", "topic"}, protocol.PullRequestsCreate, map[string]any{"head": "topic", "base": "main", "title": "title", "body": "", "draft": falseValue}, false},
		{"pr edit", []string{"pr", "edit", "9", "--base", "release", "--title", "new"}, protocol.PullRequestsUpdate, map[string]any{"number": float64(9), "base": "release", "title": "new"}, false},
		{"pr comment", []string{"pr", "comment", "9", "--body", "ok"}, protocol.PullRequestsComment, map[string]any{"number": float64(9), "body": "ok"}, false},
		{"pr diff", []string{"pr", "diff", "9"}, protocol.PullRequestsDiff, map[string]any{"number": float64(9)}, true},
		{"pr checks", []string{"pr", "checks", "9"}, protocol.PullRequestsChecks, map[string]any{"number": float64(9)}, false},
		{"run list", []string{"run", "list", "--branch", "topic", "--status", "success"}, protocol.ActionsRunsList, map[string]any{"branch": "topic", "status": "success", "limit": float64(30)}, false},
		{"run view", []string{"run", "view", "123"}, protocol.ActionsRunsGet, map[string]any{"runId": float64(123)}, false},
		{"run logs", []string{"run", "view", "123", "--log"}, protocol.ActionsRunsLogs, map[string]any{"runId": float64(123)}, true},
		{"status", []string{"status", "get", "0123456789012345678901234567890123456789"}, protocol.StatusesGet, map[string]any{"objectId": "0123456789012345678901234567890123456789"}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, err := ParseGH(test.args, "owner/repo")
			if err != nil {
				t.Fatalf("ParseGH: %v", err)
			}
			if request.Operation != test.operation || request.Raw != test.raw {
				t.Fatalf("request = %#v", request)
			}
			var arguments map[string]any
			if err := json.Unmarshal(request.Arguments, &arguments); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(arguments, test.want) {
				t.Fatalf("arguments = %#v, want %#v", arguments, test.want)
			}
		})
	}
}

func TestParseGHCommonOutputFlagsAndRepository(t *testing.T) {
	request, err := ParseGH([]string{"issue", "view", "1", "--jq", ".title", "--repo", "github.com/owner/repo", "--json", "number,title"}, "owner/repo")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(request.Fields, []string{"number", "title"}) || request.JQ != ".title" {
		t.Fatalf("selection = %#v, %q", request.Fields, request.JQ)
	}
}

func TestGHOutputFieldSchemasMatchNormalizedOperations(t *testing.T) {
	issueList := fieldSet("number", "title", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt")
	issue := fieldSet("number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt")
	pullList := fieldSet("number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt")
	pull := fieldSet("number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt", "mergeableState")
	want := map[protocol.Operation]map[string]struct{}{
		protocol.RepositoryGet:       fieldSet("repository", "owner", "nameWithOwner", "description", "private", "url", "defaultBranch"),
		protocol.IssuesList:          issueList,
		protocol.IssuesGet:           issue,
		protocol.IssuesCreate:        issue,
		protocol.IssuesUpdate:        issue,
		protocol.IssuesComment:       fieldSet("id", "author", "body", "url", "createdAt", "updatedAt"),
		protocol.PullRequestsList:    pullList,
		protocol.PullRequestsGet:     pull,
		protocol.PullRequestsCreate:  pull,
		protocol.PullRequestsUpdate:  pull,
		protocol.PullRequestsComment: fieldSet("id", "author", "body", "url", "createdAt", "updatedAt"),
		protocol.PullRequestsChecks:  fieldSet("name", "state", "conclusion", "detailsUrl", "description", "startedAt", "completedAt"),
		protocol.ActionsRunsList:     fieldSet("id", "name", "workflowName", "status", "conclusion", "event", "headBranch", "headObjectId", "url", "createdAt", "updatedAt"),
		protocol.ActionsRunsGet:      fieldSet("id", "name", "workflowName", "status", "conclusion", "event", "headBranch", "headObjectId", "url", "createdAt", "updatedAt", "attempt", "jobsUrl"),
		protocol.StatusesGet:         fieldSet("state", "objectId", "statuses"),
	}
	if !reflect.DeepEqual(responseFields, want) {
		t.Fatalf("response fields = %#v, want %#v", responseFields, want)
	}
}

func TestParseGHRejectsUnsupportedAndHostileInput(t *testing.T) {
	oid := "0123456789012345678901234567890123456789"
	tests := [][]string{
		nil, {"auth", "status"}, {"api", "/user"}, {"alias", "list"}, {"extension", "list"},
		{"repo", "create"}, {"repo", "delete"}, {"repo", "view", "other"},
		{"issue", "view", "https://github.com/owner/repo/issues/1"}, {"issue", "view", "1", "tail"},
		{"issue", "list", "--limit", "0"}, {"issue", "list", "--limit", "101"}, {"issue", "list", "--limit"},
		{"issue", "list", "--state", "merged"}, {"issue", "list", "--state", "open", "--state", "closed"},
		{"issue", "create"}, {"issue", "create", "--title", ""}, {"issue", "create", "--title", "x", "--body-file", "secret"},
		{"issue", "create", "--title=x"}, {"issue", "create", "--title", "x", "--title", "y"},
		{"issue", "edit", "1"}, {"issue", "edit", "1", "--title", ""}, {"issue", "edit", "1", "--state", "merged"},
		{"issue", "edit", "1", "--web"}, {"issue", "comment", "1", "--body", ""}, {"issue", "comment", "1", "--body-file", "-"},
		{"pr", "merge", "1"}, {"pr", "checkout", "1"}, {"pr", "create", "--title", "x", "--base", "main"},
		{"pr", "create", "--title", "x", "--base", "", "--head", "topic"}, {"pr", "create", "--title", "x", "--base", "main", "--head", "topic", "--draft", "true"},
		{"pr", "edit", "1"}, {"pr", "edit", "1", "--base", ""}, {"pr", "edit", "1", "--state", "merged"},
		{"pr", "diff", "1", "--patch"}, {"pr", "checks", "1", "--watch"},
		{"workflow", "run"}, {"run", "rerun", "1"}, {"run", "cancel", "1"}, {"run", "view", "1", "--log-failed"},
		{"run", "list", "--limit", "101"}, {"run", "view", "9223372036854775808"}, {"run", "view", "1", "--log", "--log"},
		{"status", "get", "main"}, {"status", "get", oid, "--header", "x"},
		{"issue", "view", "1", "--repo", "other/repo"}, {"issue", "view", "1", "--repo", "https://github.com/owner/repo"},
		{"issue", "view", "1", "--repo", "owner/repo", "--repo", "owner/repo"},
		{"issue", "view", "1", "--json", "number,secret"}, {"issue", "view", "1", "--json", "number,number"},
		{"issue", "view", "1", "--jq", ".title"}, {"issue", "view", "1", "--json", "title", "--jq", ".title | @sh"},
		{"pr", "diff", "1", "--json", "title"}, {"run", "view", "1", "--log", "--jq", ".name"},
		{"issue", "view", "-1"}, {"issue", "view", "+1"}, {"issue", "view", "01"}, {"issue", "view", "1", "-R", "owner/repo"},
	}
	for _, args := range tests {
		t.Run(stringsForName(args), func(t *testing.T) {
			if request, err := ParseGH(args, "owner/repo"); err == nil {
				t.Fatalf("accepted %#v: %#v", args, request)
			}
		})
	}
}

func stringsForName(args []string) string {
	data, _ := json.Marshal(args)
	return string(data)
}
