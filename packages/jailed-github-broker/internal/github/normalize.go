package github

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

type apiUser struct {
	Login *string `json:"login"`
}
type apiLabel struct {
	Name *string `json:"name"`
}
type apiIssue struct {
	Number    *int64          `json:"number"`
	Title     *string         `json:"title"`
	Body      json.RawMessage `json:"body"`
	State     *string         `json:"state"`
	User      *apiUser        `json:"user"`
	Assignees *[]apiUser      `json:"assignees"`
	Labels    *[]apiLabel     `json:"labels"`
	URL       *string         `json:"html_url"`
	CreatedAt *string         `json:"created_at"`
	UpdatedAt *string         `json:"updated_at"`
}
type apiComment struct {
	ID        *int64   `json:"id"`
	User      *apiUser `json:"user"`
	Body      *string  `json:"body"`
	URL       *string  `json:"html_url"`
	CreatedAt *string  `json:"created_at"`
	UpdatedAt *string  `json:"updated_at"`
}
type apiRef struct {
	Ref *string `json:"ref"`
	SHA *string `json:"sha"`
}
type apiPull struct {
	Number         *int64          `json:"number"`
	Title          *string         `json:"title"`
	Body           json.RawMessage `json:"body"`
	State          *string         `json:"state"`
	Draft          *bool           `json:"draft"`
	User           *apiUser        `json:"user"`
	Head           *apiRef         `json:"head"`
	Base           *apiRef         `json:"base"`
	URL            *string         `json:"html_url"`
	CreatedAt      *string         `json:"created_at"`
	UpdatedAt      *string         `json:"updated_at"`
	MergeableState *string         `json:"mergeable_state"`
}
type apiRun struct {
	ID           *int64  `json:"id"`
	WorkflowName *string `json:"name"`
	DisplayTitle *string `json:"display_title"`
	Status       *string `json:"status"`
	Conclusion   *string `json:"conclusion"`
	Event        *string `json:"event"`
	HeadBranch   *string `json:"head_branch"`
	HeadSHA      *string `json:"head_sha"`
	URL          *string `json:"html_url"`
	CreatedAt    *string `json:"created_at"`
	UpdatedAt    *string `json:"updated_at"`
	Attempt      *int64  `json:"run_attempt"`
	JobsURL      *string `json:"jobs_url"`
}
type apiRepository struct {
	Name          *string  `json:"name"`
	Owner         *apiUser `json:"owner"`
	FullName      *string  `json:"full_name"`
	Description   *string  `json:"description"`
	Private       *bool    `json:"private"`
	URL           *string  `json:"html_url"`
	DefaultBranch *string  `json:"default_branch"`
}
type apiStatus struct {
	Context     *string `json:"context"`
	State       *string `json:"state"`
	Description *string `json:"description"`
	TargetURL   *string `json:"target_url"`
	CreatedAt   *string `json:"created_at"`
	UpdatedAt   *string `json:"updated_at"`
}
type apiStatuses struct {
	State    *string      `json:"state"`
	SHA      *string      `json:"sha"`
	Statuses *[]apiStatus `json:"statuses"`
}

func normalize(operation string, raw []byte) ([]byte, error) {
	switch operation {
	case "repository.get":
		var value apiRepository
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(repository(value))
	case "issues.list":
		var value struct {
			Items *[]apiIssue `json:"items"`
		}
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		if value.Items == nil {
			return nil, missing("items")
		}
		return encodeIssues(*value.Items, false)
	case "issues.get", "issues.create", "issues.update":
		var value apiIssue
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(issue(value, true))
	case "issues.comment", "pullRequests.comment":
		var value apiComment
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(comment(value))
	case "pullRequests.list":
		var value []apiPull
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encodePulls(value, false)
	case "pullRequests.get", "pullRequests.create", "pullRequests.update":
		var value apiPull
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(pull(value, true))
	case "actions.runs.list":
		var value struct {
			Runs *[]apiRun `json:"workflow_runs"`
		}
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		if value.Runs == nil {
			return nil, missing("workflow_runs")
		}
		return encodeRuns(*value.Runs, false)
	case "actions.runs.get":
		var value apiRun
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(run(value, true))
	case "statuses.get":
		var value apiStatuses
		if err := decode(raw, &value); err != nil {
			return nil, err
		}
		return encode(statuses(value))
	}
	return nil, fmt.Errorf("unknown normalizer %q", operation)
}

func decode(raw []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("invalid GitHub response: %w", err)
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return fmt.Errorf("invalid GitHub response")
	}
	return nil
}
func encode(value any, errors ...error) ([]byte, error) {
	if len(errors) != 0 && errors[0] != nil {
		return nil, errors[0]
	}
	return json.Marshal(value)
}
func missing(field string) error { return fmt.Errorf("GitHub response is missing %s", field) }
func required(value *string, field string) (string, error) {
	if value == nil {
		return "", missing(field)
	}
	return *value, nil
}
func requiredID(value *int64, field string) (int64, error) {
	if value == nil {
		return 0, missing(field)
	}
	return *value, nil
}
func requiredBool(value *bool, field string) (bool, error) {
	if value == nil {
		return false, missing(field)
	}
	return *value, nil
}
func nullable(raw json.RawMessage, field string) (any, error) {
	if len(raw) == 0 {
		return nil, missing(field)
	}
	if bytes.Equal(raw, []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("invalid %s", field)
	}
	return value, nil
}
func optional(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
func user(value *apiUser, field string) (string, error) {
	if value == nil {
		return "", missing(field)
	}
	return required(value.Login, field+".login")
}
