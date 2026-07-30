package github

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
)

type apiCheckOutput struct {
	Title *string `json:"title"`
}
type apiCheckRun struct {
	Name        *string         `json:"name"`
	Status      *string         `json:"status"`
	Conclusion  *string         `json:"conclusion"`
	DetailsURL  *string         `json:"details_url"`
	Output      *apiCheckOutput `json:"output"`
	StartedAt   *string         `json:"started_at"`
	CompletedAt *string         `json:"completed_at"`
}
type apiCheckPage struct {
	Total *int           `json:"total_count"`
	Runs  *[]apiCheckRun `json:"check_runs"`
}
type apiStatusPage struct {
	Total    *int         `json:"total_count"`
	Statuses *[]apiStatus `json:"statuses"`
}
type checkBudget struct{ raw, pages, records int }

func executeChecks(ctx context.Context, request Request, caller Caller) ([]byte, error) {
	args := request.arguments.(numberArgs)
	first, err := invoke(ctx, caller, apiCall(request, "GET", endpoint(request, "/pulls/"+strconv.Itoa(args.Number)), nil, 8*miB, "pull-request preflight", apiAccept), 8*miB)
	if err != nil {
		return nil, err
	}
	var pull struct {
		Head *apiRef `json:"head"`
	}
	if err := decode(first, &pull); err != nil {
		return nil, err
	}
	if pull.Head == nil || pull.Head.SHA == nil || validateObjectID(*pull.Head.SHA) != nil {
		return nil, ErrWrongResource
	}
	budget := checkBudget{raw: len(first)}
	out := []map[string]any{}
	if err := appendCheckPages(ctx, caller, request, *pull.Head.SHA, &budget, &out); err != nil {
		return nil, err
	}
	if err := appendStatusPages(ctx, caller, request, *pull.Head.SHA, &budget, &out); err != nil {
		return nil, err
	}
	return encode(out)
}

func appendCheckPages(ctx context.Context, caller Caller, request Request, sha string, budget *checkBudget, out *[]map[string]any) error {
	for page := 1; ; page++ {
		if budget.pages == 10 {
			return ErrResultTooLarge
		}
		raw, err := pageCall(ctx, caller, request, "/commits/"+sha+"/check-runs", page, budget)
		if err != nil {
			return err
		}
		var response apiCheckPage
		if err := decode(raw, &response); err != nil {
			return err
		}
		if response.Total == nil || response.Runs == nil || *response.Total < 0 {
			return fmt.Errorf("invalid check-runs page")
		}
		if *response.Total > 1000 {
			return ErrResultTooLarge
		}
		if len(*response.Runs) == 0 && len(*out) < *response.Total {
			return fmt.Errorf("incomplete check-runs response")
		}
		for _, value := range *response.Runs {
			normalized, err := check(value)
			if err != nil {
				return err
			}
			if budget.records == 1000 || len(*out) >= *response.Total {
				return ErrResultTooLarge
			}
			*out = append(*out, normalized)
			budget.records++
		}
		if *response.Total <= page*100 {
			if len(*out) < *response.Total {
				return fmt.Errorf("incomplete check-runs response")
			}
			return nil
		}
	}
}

func appendStatusPages(ctx context.Context, caller Caller, request Request, sha string, budget *checkBudget, out *[]map[string]any) error {
	start := len(*out)
	for page := 1; ; page++ {
		if budget.pages == 10 {
			return ErrResultTooLarge
		}
		raw, err := pageCall(ctx, caller, request, "/commits/"+sha+"/status", page, budget)
		if err != nil {
			return err
		}
		var response apiStatusPage
		if err := decode(raw, &response); err != nil {
			return err
		}
		if response.Total == nil || response.Statuses == nil || *response.Total < 0 {
			return fmt.Errorf("invalid statuses page")
		}
		if *response.Total > 1000 || *response.Total+start > 1000 {
			return ErrResultTooLarge
		}
		if len(*response.Statuses) == 0 && len(*out)-start < *response.Total {
			return fmt.Errorf("incomplete statuses response")
		}
		for _, value := range *response.Statuses {
			normalized, err := status(value)
			if err != nil {
				return err
			}
			if budget.records == 1000 || len(*out)-start >= *response.Total {
				return ErrResultTooLarge
			}
			*out = append(*out, normalized)
			budget.records++
		}
		if *response.Total <= page*100 {
			if len(*out)-start < *response.Total {
				return fmt.Errorf("incomplete statuses response")
			}
			return nil
		}
	}
}

func pageCall(ctx context.Context, caller Caller, request Request, path string, page int, budget *checkBudget) ([]byte, error) {
	if budget.raw >= 8*miB {
		return nil, ErrResultTooLarge
	}
	query := url.Values{"page": {strconv.Itoa(page)}, "per_page": {"100"}}
	raw, err := invoke(ctx, caller, apiCall(request, "GET", endpoint(request, path)+"?"+query.Encode(), nil, 8*miB-budget.raw, "pull-request checks", apiAccept), 8*miB-budget.raw)
	if err != nil {
		return nil, err
	}
	budget.raw += len(raw)
	budget.pages++
	return raw, nil
}

func check(value apiCheckRun) (map[string]any, error) {
	name, err := required(value.Name, "check.name")
	if err != nil {
		return nil, err
	}
	state, err := required(value.Status, "check.status")
	if err != nil {
		return nil, err
	}
	var description any
	if value.Output != nil {
		description = optional(value.Output.Title)
	}
	return map[string]any{"name": name, "state": state, "conclusion": optional(value.Conclusion), "detailsUrl": optional(value.DetailsURL), "description": description, "startedAt": optional(value.StartedAt), "completedAt": optional(value.CompletedAt)}, nil
}
func status(value apiStatus) (map[string]any, error) {
	name, err := required(value.Context, "status.context")
	if err != nil {
		return nil, err
	}
	state, err := required(value.State, "status.state")
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "state": state, "conclusion": nil, "detailsUrl": optional(value.TargetURL), "description": optional(value.Description), "startedAt": optional(value.CreatedAt), "completedAt": optional(value.UpdatedAt)}, nil
}
