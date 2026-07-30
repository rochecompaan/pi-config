package github

func statuses(value apiStatuses) (map[string]any, error) {
	state, err := required(value.State, "state")
	if err != nil {
		return nil, err
	}
	sha, err := required(value.SHA, "sha")
	if err != nil {
		return nil, err
	}
	if value.Statuses == nil {
		return nil, missing("statuses")
	}
	out := make([]map[string]any, 0, len(*value.Statuses))
	for _, entry := range *value.Statuses {
		normalized, err := status(entry)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return map[string]any{"state": state, "objectId": sha, "statuses": out}, nil
}
func users(value *[]apiUser, field string) ([]string, error) {
	if value == nil {
		return nil, missing(field)
	}
	out := make([]string, 0, len(*value))
	for _, entry := range *value {
		login, err := user(&entry, field)
		if err != nil {
			return nil, err
		}
		out = append(out, login)
	}
	return out, nil
}
func labelNames(value *[]apiLabel) ([]string, error) {
	if value == nil {
		return nil, missing("labels")
	}
	out := make([]string, 0, len(*value))
	for _, entry := range *value {
		name, err := required(entry.Name, "label.name")
		if err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, nil
}
func encodeIssues(values []apiIssue, body bool) ([]byte, error) {
	out := make([]map[string]any, 0, len(values))
	for _, value := range values {
		normalized, err := issue(value, body)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return encode(out)
}
func encodePulls(values []apiPull, mergeable bool) ([]byte, error) {
	out := make([]map[string]any, 0, len(values))
	for _, value := range values {
		normalized, err := pull(value, mergeable)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return encode(out)
}
func encodeRuns(values []apiRun, details bool) ([]byte, error) {
	out := make([]map[string]any, 0, len(values))
	for _, value := range values {
		normalized, err := run(value, details)
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	return encode(out)
}
