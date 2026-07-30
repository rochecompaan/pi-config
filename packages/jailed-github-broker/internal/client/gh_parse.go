package client

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

// ParseGH converts the approved long-flag-only grammar to one typed request.
func ParseGH(args []string, repository string) (Request, error) {
	if !validRepositorySlug(repository) {
		return Request{}, fmt.Errorf("configured repository must be owner/repository")
	}
	var (
		request Request
		flags   parsedFlags
		err     error
	)
	if len(args) < 2 {
		return Request{}, fmt.Errorf("an approved command and subcommand are required")
	}
	switch args[0] {
	case "repo":
		request, flags, err = parseRepo(args[1:])
	case "issue":
		request, flags, err = parseIssue(args[1:])
	case "pr":
		request, flags, err = parsePullRequest(args[1:])
	case "run":
		request, flags, err = parseRun(args[1:])
	case "status":
		request, flags, err = parseStatus(args[1:])
	default:
		return Request{}, fmt.Errorf("unsupported gh command %q", args[0])
	}
	if err != nil {
		return Request{}, err
	}
	if err := applyOutputFlags(&request, flags, repository); err != nil {
		return Request{}, err
	}
	if request.Raw && (len(request.Fields) != 0 || request.JQ != "") {
		return Request{}, fmt.Errorf("raw output does not support JSON selection")
	}
	if _, err := github.Parse(request.Operation, request.Arguments, repository); err != nil {
		return Request{}, err
	}
	return request, nil
}

func parseRepo(args []string) (Request, parsedFlags, error) {
	if len(args) == 0 || args[0] != "view" {
		return Request{}, parsedFlags{}, fmt.Errorf("unsupported repository operation")
	}
	flags, err := parseFlags(args[1:], operationFlags())
	return makeRequest(protocol.RepositoryGet, map[string]any{}, false), flags, err
}

func parseStatus(args []string) (Request, parsedFlags, error) {
	if len(args) < 2 || args[0] != "get" {
		return Request{}, parsedFlags{}, fmt.Errorf("unsupported status operation")
	}
	flags, err := parseFlags(args[2:], operationFlags())
	return makeRequest(protocol.StatusesGet, map[string]any{"objectId": args[1]}, false), flags, err
}

func makeRequest(operation protocol.Operation, arguments map[string]any, raw bool) Request {
	encoded, _ := json.Marshal(arguments)
	return Request{Operation: operation, Arguments: encoded, Raw: raw}
}

func operationFlags(extra ...string) map[string]flagKind {
	allowed := map[string]flagKind{"--repo": valueFlag, "--json": valueFlag, "--jq": valueFlag}
	for _, name := range extra {
		allowed[name] = valueFlag
	}
	return allowed
}

func operationFlagsWithBools(values []string, bools ...string) map[string]flagKind {
	allowed := operationFlags(values...)
	for _, name := range bools {
		allowed[name] = boolFlag
	}
	return allowed
}

func applyOutputFlags(request *Request, flags parsedFlags, repository string) error {
	if selected, ok := flags.values["--repo"]; ok && selected != repository && selected != "github.com/"+repository {
		return fmt.Errorf("repository does not match configured repository")
	}
	jsonFields, hasJSON := flags.values["--json"]
	jq, hasJQ := flags.values["--jq"]
	if hasJQ && !hasJSON {
		return fmt.Errorf("--jq requires --json")
	}
	if hasJSON {
		fields, err := selectedFields(request.Operation, jsonFields)
		if err != nil {
			return err
		}
		request.Fields = fields
	}
	if hasJQ {
		if err := validateJQ(request.Operation, jq, request.Fields); err != nil {
			return err
		}
		request.JQ = jq
	}
	return nil
}

func selectedFields(operation protocol.Operation, value string) ([]string, error) {
	allowed, exists := responseFields[operation]
	if !exists || value == "" {
		return nil, fmt.Errorf("operation does not support selected JSON fields")
	}
	parts := strings.Split(value, ",")
	seen := make(map[string]struct{}, len(parts))
	for _, field := range parts {
		if _, ok := allowed[field]; !ok || field == "" {
			return nil, fmt.Errorf("unsupported JSON field %q", field)
		}
		if _, duplicate := seen[field]; duplicate {
			return nil, fmt.Errorf("duplicate JSON field %q", field)
		}
		seen[field] = struct{}{}
	}
	return parts, nil
}
