package github

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

type numberArgs struct {
	Number int `json:"number"`
}
type listArgs struct {
	State string `json:"state"`
	Limit int    `json:"limit"`
}
type issueListArgs struct {
	State *string `json:"state"`
	Limit int     `json:"limit"`
}
type issueCreateArgs struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}
type issueUpdateArgs struct {
	Number int     `json:"number"`
	Title  *string `json:"title"`
	Body   *string `json:"body"`
	State  *string `json:"state"`
}
type commentArgs struct {
	Number int    `json:"number"`
	Body   string `json:"body"`
}
type prListArgs struct {
	State *string `json:"state"`
	Base  string  `json:"base"`
	Head  string  `json:"head"`
	Limit int     `json:"limit"`
}
type prCreateArgs struct {
	Title string `json:"title"`
	Head  string `json:"head"`
	Base  string `json:"base"`
	Body  string `json:"body"`
	Draft *bool  `json:"draft"`
}
type prUpdateArgs struct {
	Number int     `json:"number"`
	Title  *string `json:"title"`
	Body   *string `json:"body"`
	Base   *string `json:"base"`
	State  *string `json:"state"`
}
type runListArgs struct {
	Branch string `json:"branch"`
	Status string `json:"status"`
	Limit  int    `json:"limit"`
}
type runIDArgs struct {
	RunID int64 `json:"runId"`
}
type objectIDArgs struct {
	ObjectID string `json:"objectId"`
}

// Parse strictly decodes and bounds a request for repository (owner/repository).
func Parse(operation protocol.Operation, data json.RawMessage, repository string) (Request, error) {
	owner, name, ok := strings.Cut(repository, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return Request{}, fmt.Errorf("%w: repository", ErrInvalidRequest)
	}
	request := Request{operation: operation, owner: owner, repository: name}
	var err error
	switch operation {
	case protocol.RepositoryGet:
		request.arguments, err = protocol.DecodeArguments[struct{}](data)
	case protocol.IssuesList:
		var args issueListArgs
		args, err = protocol.DecodeArguments[issueListArgs](data)
		if err == nil {
			if args.State == nil {
				err = fmt.Errorf("state is required")
			} else {
				err = validateList(*args.State, args.Limit)
			}
		}
		request.arguments = args
	case protocol.IssuesGet, protocol.PullRequestsGet, protocol.PullRequestsDiff, protocol.PullRequestsChecks:
		var args numberArgs
		args, err = protocol.DecodeArguments[numberArgs](data)
		if err == nil {
			err = positive(args.Number)
		}
		request.arguments = args
	case protocol.IssuesCreate:
		var args issueCreateArgs
		args, err = protocol.DecodeArguments[issueCreateArgs](data)
		if err == nil {
			err = validateTitle(args.Title)
			if err == nil {
				err = validateBody(args.Body, false)
			}
		}
		request.arguments = args
	case protocol.IssuesUpdate:
		var args issueUpdateArgs
		args, err = protocol.DecodeArguments[issueUpdateArgs](data)
		if err == nil {
			err = validateIssueUpdate(args)
		}
		request.arguments = args
	case protocol.IssuesComment:
		var args commentArgs
		args, err = protocol.DecodeArguments[commentArgs](data)
		if err == nil {
			err = positive(args.Number)
			if err == nil {
				err = validateBody(args.Body, true)
			}
		}
		request.arguments = args
	case protocol.PullRequestsList:
		var args prListArgs
		args, err = protocol.DecodeArguments[prListArgs](data)
		if err == nil {
			if args.State == nil {
				err = fmt.Errorf("state is required")
			} else {
				err = validateList(*args.State, args.Limit)
			}
			if err == nil {
				err = validateName(args.Base)
				if err == nil {
					err = validateName(args.Head)
				}
			}
		}
		request.arguments = args
	case protocol.PullRequestsCreate:
		var args prCreateArgs
		args, err = protocol.DecodeArguments[prCreateArgs](data)
		if err == nil && args.Draft == nil {
			err = fmt.Errorf("draft is required")
		}
		if err == nil {
			err = validateTitle(args.Title)
			if err == nil {
				err = validateNameRequired(args.Head)
				if err == nil {
					err = validateNameRequired(args.Base)
					if err == nil {
						err = validateBody(args.Body, false)
					}
				}
			}
		}
		request.arguments = args
	case protocol.PullRequestsUpdate:
		var args prUpdateArgs
		args, err = protocol.DecodeArguments[prUpdateArgs](data)
		if err == nil {
			err = validatePRUpdate(args)
		}
		request.arguments = args
	case protocol.PullRequestsComment:
		var args commentArgs
		args, err = protocol.DecodeArguments[commentArgs](data)
		if err == nil {
			err = positive(args.Number)
			if err == nil {
				err = validateBody(args.Body, true)
			}
		}
		request.arguments = args
	case protocol.ActionsRunsList:
		var args runListArgs
		args, err = protocol.DecodeArguments[runListArgs](data)
		if err == nil {
			err = positiveLimit(args.Limit)
			if err == nil {
				err = validateName(args.Branch)
				if err == nil {
					err = validateName(args.Status)
				}
			}
		}
		request.arguments = args
	case protocol.ActionsRunsGet, protocol.ActionsRunsLogs:
		var args runIDArgs
		args, err = protocol.DecodeArguments[runIDArgs](data)
		if err == nil && args.RunID < 1 {
			err = fmt.Errorf("run ID must be positive")
		}
		request.arguments = args
	case protocol.StatusesGet:
		var args objectIDArgs
		args, err = protocol.DecodeArguments[objectIDArgs](data)
		if err == nil {
			err = validateObjectID(args.ObjectID)
		}
		request.arguments = args
	default:
		return Request{}, fmt.Errorf("%w: unsupported operation %q", ErrInvalidRequest, operation)
	}
	if err != nil {
		return Request{}, fmt.Errorf("%w: %v", ErrInvalidRequest, err)
	}
	return request, nil
}
