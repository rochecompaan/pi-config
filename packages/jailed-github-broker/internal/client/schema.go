package client

import (
	"fmt"
	"strings"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func fieldSet(names ...string) map[string]struct{} {
	result := make(map[string]struct{}, len(names))
	for _, name := range names {
		result[name] = struct{}{}
	}
	return result
}

var responseFields = map[protocol.Operation]map[string]struct{}{
	protocol.RepositoryGet:       fieldSet("repository", "owner", "nameWithOwner", "description", "private", "url", "defaultBranch"),
	protocol.IssuesList:          fieldSet("number", "title", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"),
	protocol.IssuesGet:           fieldSet("number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"),
	protocol.IssuesCreate:        fieldSet("number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"),
	protocol.IssuesUpdate:        fieldSet("number", "title", "body", "state", "author", "assignees", "labels", "url", "createdAt", "updatedAt"),
	protocol.IssuesComment:       commentFields(),
	protocol.PullRequestsList:    pullFields(false),
	protocol.PullRequestsGet:     pullFields(true),
	protocol.PullRequestsCreate:  pullFields(true),
	protocol.PullRequestsUpdate:  pullFields(true),
	protocol.PullRequestsComment: commentFields(),
	protocol.PullRequestsChecks:  fieldSet("name", "state", "conclusion", "detailsUrl", "description", "startedAt", "completedAt"),
	protocol.ActionsRunsList:     runFields(false),
	protocol.ActionsRunsGet:      runFields(true),
	protocol.StatusesGet:         fieldSet("state", "objectId", "statuses"),
}

func commentFields() map[string]struct{} {
	return fieldSet("id", "author", "body", "url", "createdAt", "updatedAt")
}

func pullFields(details bool) map[string]struct{} {
	fields := fieldSet("number", "title", "body", "state", "draft", "author", "head", "base", "headObjectId", "url", "createdAt", "updatedAt")
	if details {
		fields["mergeableState"] = struct{}{}
	}
	return fields
}

func runFields(details bool) map[string]struct{} {
	fields := fieldSet("id", "name", "workflowName", "status", "conclusion", "event", "headBranch", "headObjectId", "url", "createdAt", "updatedAt")
	if details {
		fields["attempt"] = struct{}{}
		fields["jobsUrl"] = struct{}{}
	}
	return fields
}

func validateJQ(operation protocol.Operation, expression string, selected []string) error {
	if expression == "." {
		return nil
	}
	array := arrayResponse(operation)
	var field string
	if array && strings.HasPrefix(expression, ".[].") {
		field = strings.TrimPrefix(expression, ".[].")
	} else if array && strings.HasPrefix(expression, ".[] | .") {
		field = strings.TrimPrefix(expression, ".[] | .")
	} else if !array && strings.HasPrefix(expression, ".") {
		field = strings.TrimPrefix(expression, ".")
	} else {
		return fmt.Errorf("unsupported --jq expression")
	}
	if field == "" || strings.ContainsAny(field, ".[]| ()\t\r\n\"'") || !contains(selected, field) {
		return fmt.Errorf("--jq may reference only a selected top-level field")
	}
	return nil
}

func arrayResponse(operation protocol.Operation) bool {
	switch operation {
	case protocol.IssuesList, protocol.PullRequestsList, protocol.PullRequestsChecks, protocol.ActionsRunsList:
		return true
	default:
		return false
	}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
