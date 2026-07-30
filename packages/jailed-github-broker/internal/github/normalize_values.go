package github

func repository(value apiRepository) (map[string]any, error) {
	name, err := required(value.Name, "name")
	if err != nil {
		return nil, err
	}
	owner, err := user(value.Owner, "owner")
	if err != nil {
		return nil, err
	}
	full, err := required(value.FullName, "full_name")
	if err != nil {
		return nil, err
	}
	private, err := requiredBool(value.Private, "private")
	if err != nil {
		return nil, err
	}
	url, err := required(value.URL, "html_url")
	if err != nil {
		return nil, err
	}
	branch, err := required(value.DefaultBranch, "default_branch")
	if err != nil {
		return nil, err
	}
	return map[string]any{"repository": name, "owner": owner, "nameWithOwner": full, "description": optional(value.Description), "private": private, "url": url, "defaultBranch": branch}, nil
}
func issue(value apiIssue, body bool) (map[string]any, error) {
	number, err := requiredID(value.Number, "number")
	if err != nil {
		return nil, err
	}
	title, err := required(value.Title, "title")
	if err != nil {
		return nil, err
	}
	state, err := required(value.State, "state")
	if err != nil {
		return nil, err
	}
	author, err := user(value.User, "user")
	if err != nil {
		return nil, err
	}
	assignees, err := users(value.Assignees, "assignees")
	if err != nil {
		return nil, err
	}
	labels, err := labelNames(value.Labels)
	if err != nil {
		return nil, err
	}
	url, err := required(value.URL, "html_url")
	if err != nil {
		return nil, err
	}
	created, err := required(value.CreatedAt, "created_at")
	if err != nil {
		return nil, err
	}
	updated, err := required(value.UpdatedAt, "updated_at")
	if err != nil {
		return nil, err
	}
	result := map[string]any{"number": number, "title": title, "state": state, "author": author, "assignees": assignees, "labels": labels, "url": url, "createdAt": created, "updatedAt": updated}
	if body {
		text, err := nullable(value.Body, "body")
		if err != nil {
			return nil, err
		}
		result["body"] = text
	}
	return result, nil
}
func comment(value apiComment) (map[string]any, error) {
	id, err := requiredID(value.ID, "id")
	if err != nil {
		return nil, err
	}
	author, err := user(value.User, "user")
	if err != nil {
		return nil, err
	}
	body, err := required(value.Body, "body")
	if err != nil {
		return nil, err
	}
	url, err := required(value.URL, "html_url")
	if err != nil {
		return nil, err
	}
	created, err := required(value.CreatedAt, "created_at")
	if err != nil {
		return nil, err
	}
	updated, err := required(value.UpdatedAt, "updated_at")
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "author": author, "body": body, "url": url, "createdAt": created, "updatedAt": updated}, nil
}
func pull(value apiPull, mergeable bool) (map[string]any, error) {
	number, err := requiredID(value.Number, "number")
	if err != nil {
		return nil, err
	}
	title, err := required(value.Title, "title")
	if err != nil {
		return nil, err
	}
	body, err := nullable(value.Body, "body")
	if err != nil {
		return nil, err
	}
	state, err := required(value.State, "state")
	if err != nil {
		return nil, err
	}
	draft, err := requiredBool(value.Draft, "draft")
	if err != nil {
		return nil, err
	}
	author, err := user(value.User, "user")
	if err != nil {
		return nil, err
	}
	if value.Head == nil || value.Base == nil {
		return nil, missing("head/base")
	}
	head, err := required(value.Head.Ref, "head.ref")
	if err != nil {
		return nil, err
	}
	base, err := required(value.Base.Ref, "base.ref")
	if err != nil {
		return nil, err
	}
	sha, err := required(value.Head.SHA, "head.sha")
	if err != nil {
		return nil, err
	}
	url, err := required(value.URL, "html_url")
	if err != nil {
		return nil, err
	}
	created, err := required(value.CreatedAt, "created_at")
	if err != nil {
		return nil, err
	}
	updated, err := required(value.UpdatedAt, "updated_at")
	if err != nil {
		return nil, err
	}
	result := map[string]any{"number": number, "title": title, "body": body, "state": state, "draft": draft, "author": author, "head": head, "base": base, "headObjectId": sha, "url": url, "createdAt": created, "updatedAt": updated}
	if mergeable {
		result["mergeableState"] = optional(value.MergeableState)
	}
	return result, nil
}
func run(value apiRun, details bool) (map[string]any, error) {
	id, err := requiredID(value.ID, "id")
	if err != nil {
		return nil, err
	}
	name, err := required(value.DisplayTitle, "display_title")
	if err != nil {
		return nil, err
	}
	workflow, err := required(value.WorkflowName, "name")
	if err != nil {
		return nil, err
	}
	status, err := required(value.Status, "status")
	if err != nil {
		return nil, err
	}
	event, err := required(value.Event, "event")
	if err != nil {
		return nil, err
	}
	branch, err := required(value.HeadBranch, "head_branch")
	if err != nil {
		return nil, err
	}
	sha, err := required(value.HeadSHA, "head_sha")
	if err != nil {
		return nil, err
	}
	url, err := required(value.URL, "html_url")
	if err != nil {
		return nil, err
	}
	created, err := required(value.CreatedAt, "created_at")
	if err != nil {
		return nil, err
	}
	updated, err := required(value.UpdatedAt, "updated_at")
	if err != nil {
		return nil, err
	}
	result := map[string]any{"id": id, "name": name, "workflowName": workflow, "status": status, "conclusion": optional(value.Conclusion), "event": event, "headBranch": branch, "headObjectId": sha, "url": url, "createdAt": created, "updatedAt": updated}
	if details {
		attempt, err := requiredID(value.Attempt, "run_attempt")
		if err != nil {
			return nil, err
		}
		jobs, err := required(value.JobsURL, "jobs_url")
		if err != nil {
			return nil, err
		}
		result["attempt"] = attempt
		result["jobsUrl"] = jobs
	}
	return result, nil
}
