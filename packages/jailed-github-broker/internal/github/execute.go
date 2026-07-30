package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"unicode/utf8"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

// Execute invokes only generated fixed calls and returns a normalized result.
func Execute(ctx context.Context, request Request, caller Caller) ([]byte, error) {
	switch request.operation {
	case protocol.PullRequestsChecks:
		return executeChecks(ctx, request, caller)
	case protocol.IssuesUpdate, protocol.IssuesComment, protocol.PullRequestsComment:
		return executePreflight(ctx, request, caller)
	case protocol.ActionsRunsLogs:
		args := request.arguments.(runIDArgs)
		return executeBytes(ctx, caller, logsCall(request, args.RunID), 32*miB)
	case protocol.PullRequestsDiff:
		args := request.arguments.(numberArgs)
		return executeBytes(ctx, caller, apiCall(request, "GET", endpoint(request, "/pulls/"+strconv.Itoa(args.Number)), nil, 8*miB, "pull-request diff", "application/vnd.github.diff"), 8*miB)
	default:
		call, operation, err := oneCall(request)
		if err != nil {
			return nil, err
		}
		raw, err := invoke(ctx, caller, call, call.RawLimit)
		if err != nil {
			return nil, err
		}
		if request.operation == protocol.IssuesGet {
			var value struct {
				PullRequest json.RawMessage `json:"pull_request"`
			}
			if err := decode(raw, &value); err != nil {
				return nil, err
			}
			if value.PullRequest != nil {
				return nil, ErrWrongResource
			}
		}
		return normalize(operation, raw)
	}
}

func oneCall(request Request) (Call, string, error) {
	switch request.operation {
	case protocol.RepositoryGet:
		return apiCall(request, "GET", endpoint(request, ""), nil, miB, "repository read", apiAccept), "repository.get", nil
	case protocol.IssuesList:
		args := request.arguments.(issueListArgs)
		query := "repo:" + request.owner + "/" + request.repository + " is:issue"
		if *args.State != "all" {
			query += " state:" + *args.State
		}
		return apiCall(request, "GET", "/search/issues?q="+url.QueryEscape(query)+"&per_page="+strconv.Itoa(args.Limit), nil, 8*miB, "issue list", apiAccept), "issues.list", nil
	case protocol.IssuesGet:
		args := request.arguments.(numberArgs)
		return apiCall(request, "GET", endpoint(request, "/issues/"+strconv.Itoa(args.Number)), nil, 2*miB, "issue read", apiAccept), "issues.get", nil
	case protocol.IssuesCreate:
		args := request.arguments.(issueCreateArgs)
		return jsonCall(request, "POST", "/issues", map[string]any{"title": args.Title, "body": args.Body}, 2*miB, "issue create"), "issues.create", nil
	case protocol.PullRequestsList:
		args := request.arguments.(prListArgs)
		query := url.Values{"per_page": {strconv.Itoa(args.Limit)}}
		query.Set("state", *args.State)
		if args.Base != "" {
			query.Set("base", args.Base)
		}
		if args.Head != "" {
			query.Set("head", args.Head)
		}
		return apiCall(request, "GET", endpoint(request, "/pulls")+"?"+query.Encode(), nil, 8*miB, "pull-request list", apiAccept), "pullRequests.list", nil
	case protocol.PullRequestsGet:
		args := request.arguments.(numberArgs)
		return apiCall(request, "GET", endpoint(request, "/pulls/"+strconv.Itoa(args.Number)), nil, 2*miB, "pull-request read", apiAccept), "pullRequests.get", nil
	case protocol.PullRequestsCreate:
		args := request.arguments.(prCreateArgs)
		return jsonCall(request, "POST", "/pulls", map[string]any{"title": args.Title, "head": args.Head, "base": args.Base, "body": args.Body, "draft": *args.Draft}, 2*miB, "pull-request create"), "pullRequests.create", nil
	case protocol.PullRequestsUpdate:
		args := request.arguments.(prUpdateArgs)
		return jsonCall(request, "PATCH", "/pulls/"+strconv.Itoa(args.Number), updateBody(args.Title, args.Body, args.Base, args.State), 2*miB, "pull-request update"), "pullRequests.update", nil
	case protocol.ActionsRunsList:
		args := request.arguments.(runListArgs)
		query := url.Values{"per_page": {strconv.Itoa(args.Limit)}}
		if args.Branch != "" {
			query.Set("branch", args.Branch)
		}
		if args.Status != "" {
			query.Set("status", args.Status)
		}
		return apiCall(request, "GET", endpoint(request, "/actions/runs")+"?"+query.Encode(), nil, 8*miB, "actions run list", apiAccept), "actions.runs.list", nil
	case protocol.ActionsRunsGet:
		args := request.arguments.(runIDArgs)
		return apiCall(request, "GET", endpoint(request, "/actions/runs/"+strconv.FormatInt(args.RunID, 10)), nil, 2*miB, "actions run read", apiAccept), "actions.runs.get", nil
	case protocol.StatusesGet:
		args := request.arguments.(objectIDArgs)
		return apiCall(request, "GET", endpoint(request, "/commits/"+args.ObjectID+"/status"), nil, 8*miB, "commit status read", apiAccept), "statuses.get", nil
	}
	return Call{}, "", fmt.Errorf("%w: unsupported operation", ErrInvalidRequest)
}

func executePreflight(ctx context.Context, request Request, caller Caller) ([]byte, error) {
	var number int
	switch args := request.arguments.(type) {
	case issueUpdateArgs:
		number = args.Number
	case commentArgs:
		number = args.Number
	}
	preflightPath := "/issues/"
	if request.operation == protocol.PullRequestsComment {
		preflightPath = "/pulls/"
	}
	preflight, err := invoke(ctx, caller, apiCall(request, "GET", endpoint(request, preflightPath+strconv.Itoa(number)), nil, 2*miB, "resource preflight", apiAccept), 4*miB)
	if err != nil {
		return nil, err
	}
	if request.operation == protocol.PullRequestsComment {
		var value struct {
			Head *apiRef `json:"head"`
		}
		if err := decode(preflight, &value); err != nil {
			return nil, err
		}
		if value.Head == nil {
			return nil, ErrWrongResource
		}
	} else {
		var value struct {
			PullRequest json.RawMessage `json:"pull_request"`
		}
		if err := decode(preflight, &value); err != nil {
			return nil, err
		}
		if value.PullRequest != nil {
			return nil, ErrWrongResource
		}
	}
	var call Call
	var operation string
	switch request.operation {
	case protocol.IssuesUpdate:
		args := request.arguments.(issueUpdateArgs)
		call = jsonCall(request, "PATCH", "/issues/"+strconv.Itoa(args.Number), updateBody(args.Title, args.Body, nil, args.State), 2*miB, "issue update")
		operation = "issues.update"
	case protocol.IssuesComment:
		args := request.arguments.(commentArgs)
		call = jsonCall(request, "POST", "/issues/"+strconv.Itoa(args.Number)+"/comments", map[string]any{"body": args.Body}, 2*miB, "issue comment")
		operation = "issues.comment"
	case protocol.PullRequestsComment:
		args := request.arguments.(commentArgs)
		call = jsonCall(request, "POST", "/issues/"+strconv.Itoa(args.Number)+"/comments", map[string]any{"body": args.Body}, 2*miB, "pull-request comment")
		operation = "pullRequests.comment"
	}
	raw, err := invoke(ctx, caller, call, 4*miB-len(preflight))
	if err != nil {
		return nil, err
	}
	return normalize(operation, raw)
}

func apiCall(request Request, method, path string, input []byte, limit int, failure, accept string) Call {
	args := []string{"api", "--hostname", "github.com", "--method", method, "-H", "Accept: " + accept, "-H", "X-GitHub-Api-Version: " + apiVersion}
	if input != nil {
		args = append(args, "--input", "-")
	}
	args = append(args, path)
	return Call{Args: args, Stdin: append([]byte(nil), input...), CloseStdin: true, RawLimit: limit, Failure: failure}
}
func jsonCall(request Request, method, suffix string, value map[string]any, limit int, failure string) Call {
	input, _ := json.Marshal(value)
	return apiCall(request, method, endpoint(request, suffix), input, limit, failure, apiAccept)
}
func logsCall(request Request, runID int64) Call {
	return Call{Args: []string{"run", "view", "--repo", "github.com/" + request.owner + "/" + request.repository, "--log", strconv.FormatInt(runID, 10)}, CloseStdin: true, RawLimit: 32 * miB, Failure: "actions run logs"}
}
func endpoint(request Request, suffix string) string {
	return "/repos/" + request.owner + "/" + request.repository + suffix
}
func updateBody(title, body, base, state *string) map[string]any {
	value := map[string]any{}
	if title != nil {
		value["title"] = *title
	}
	if body != nil {
		value["body"] = *body
	}
	if base != nil {
		value["base"] = *base
	}
	if state != nil {
		value["state"] = *state
	}
	return value
}
func invoke(ctx context.Context, caller Caller, call Call, limit int) ([]byte, error) {
	call.RawLimit = limit
	result, err := caller.Call(ctx, cloneCall(call))
	if err != nil {
		status := err.ExitStatus
		if status == 0 {
			status = 1
		}
		return nil, &OperationError{ExitStatus: status, Message: call.Failure}
	}
	if len(result.Stdout) > limit {
		return nil, ErrResultTooLarge
	}
	return result.Stdout, nil
}
func cloneCall(call Call) Call {
	call.Args = append([]string(nil), call.Args...)
	call.Stdin = append([]byte(nil), call.Stdin...)
	return call
}
func executeBytes(ctx context.Context, caller Caller, call Call, limit int) ([]byte, error) {
	raw, err := invoke(ctx, caller, call, limit)
	if err != nil {
		return nil, err
	}
	if !utf8.Valid(raw) {
		return nil, fmt.Errorf("invalid UTF-8 host response")
	}
	return raw, nil
}
