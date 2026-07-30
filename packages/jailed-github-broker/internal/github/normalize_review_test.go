package github

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestNormalizeOperationSpecificAllowlists(t *testing.T) {
	issue := `{"number":9007199254740993,"title":"title","body":null,"state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u","extra":"discard"}`
	pull := `{"number":9007199254740993,"title":"title","body":null,"state":"open","draft":false,"user":{"login":"me"},"head":{"ref":"feature","sha":"0123456789012345678901234567890123456789"},"base":{"ref":"main"},"html_url":"https://x","created_at":"c","updated_at":"u","mergeable_state":"clean","extra":"discard"}`
	run := `{"id":9007199254740993,"name":"workflow","display_title":"run","status":"completed","conclusion":null,"event":"push","head_branch":"main","head_sha":"0123456789012345678901234567890123456789","html_url":"https://x","created_at":"c","updated_at":"u","run_attempt":2,"jobs_url":"https://jobs","extra":"discard"}`
	for _, test := range []struct {
		operation, raw string
		keys           []string
	}{
		{"repository.get", `{"name":"repo","owner":{"login":"owner"},"full_name":"owner/repo","description":null,"private":false,"html_url":"https://x","default_branch":"main","extra":true}`, []string{"repository", "owner", "nameWithOwner", "description", "private", "url", "defaultBranch"}},
		{"issues.list", `{"items":[` + issue + `]}`, []string{"number", "title", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"}},
		{"issues.get", issue, []string{"number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"}},
		{"issues.create", issue, []string{"number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"}},
		{"issues.update", issue, []string{"number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"}},
		{"issues.comment", `{"id":9007199254740993,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u","extra":true}`, []string{"id", "author", "body", "url", "createdAt", "updatedAt"}},
		{"pullRequests.list", `[` + pull + `]`, []string{"number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt"}},
		{"pullRequests.get", pull, []string{"number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt", "mergeableState"}},
		{"pullRequests.create", pull, []string{"number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt", "mergeableState"}},
		{"pullRequests.update", pull, []string{"number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt", "mergeableState"}},
		{"pullRequests.comment", `{"id":9007199254740993,"user":{"login":"me"},"body":"body","html_url":"https://x","created_at":"c","updated_at":"u"}`, []string{"id", "author", "body", "url", "createdAt", "updatedAt"}},
		{"actions.runs.list", `{"workflow_runs":[` + run + `]}`, []string{"id", "name", "workflowName", "status", "conclusion", "event", "headBranch", "headObjectId", "url", "createdAt", "updatedAt"}},
		{"actions.runs.get", run, []string{"id", "name", "workflowName", "status", "conclusion", "event", "headBranch", "headObjectId", "url", "createdAt", "updatedAt", "attempt", "jobsUrl"}},
		{"statuses.get", `{"state":"success","sha":"0123456789012345678901234567890123456789","statuses":[],"extra":true}`, []string{"state", "objectId", "statuses"}},
	} {
		t.Run(test.operation, func(t *testing.T) {
			got, err := normalize(test.operation, []byte(test.raw))
			if err != nil {
				t.Fatal(err)
			}
			assertResponseKeys(t, got, test.keys)
			if string(got) == "" {
				t.Fatal("empty normalization")
			}
		})
	}
}

func TestNormalizePreservesLargeIDsAndRejectsMissingOrWrongRequiredFields(t *testing.T) {
	got, err := normalize("issues.get", []byte(`{"number":9007199254740993,"title":"title","body":null,"state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(got, []byte(`"number":9007199254740993`)) {
		t.Fatalf("normalization lost 64-bit ID: %s", got)
	}
	for _, raw := range []string{
		`{"number":"1","title":"title","state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`,
		`{"number":1,"state":"open","user":{"login":"me"},"assignees":[],"labels":[],"html_url":"https://x","created_at":"c","updated_at":"u"}`,
	} {
		if _, err := normalize("issues.get", []byte(raw)); err == nil {
			t.Fatalf("normalize(%s) succeeded", raw)
		}
	}
}

func assertResponseKeys(t *testing.T, raw []byte, want []string) {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if values, ok := value.([]any); ok {
		if len(values) != 1 {
			t.Fatalf("array = %#v", values)
		}
		value = values[0]
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("response = %#v", value)
	}
	if len(object) != len(want) {
		t.Fatalf("keys = %#v, want %v", object, want)
	}
	for _, key := range want {
		if _, ok := object[key]; !ok {
			t.Fatalf("missing key %q in %#v", key, object)
		}
	}
}
