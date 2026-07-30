package client

import (
	"fmt"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func parseIssue(args []string) (Request, parsedFlags, error) {
	if len(args) == 0 {
		return Request{}, parsedFlags{}, fmt.Errorf("issue subcommand is required")
	}
	switch args[0] {
	case "list":
		flags, err := parseFlags(args[1:], operationFlags("--state", "--limit"))
		arguments := map[string]any{"state": valueOr(flags, "--state", "open"), "limit": 30}
		if raw, ok := flags.values["--limit"]; ok {
			arguments["limit"], err = positiveDecimal(raw)
		}
		return makeRequest(protocol.IssuesList, arguments, false), flags, err
	case "view":
		return parseNumberOperation(args[1:], protocol.IssuesGet, false)
	case "create":
		flags, err := parseFlags(args[1:], operationFlags("--title", "--body"))
		title, present := flags.values["--title"]
		if err == nil && !present {
			err = fmt.Errorf("--title is required")
		}
		return makeRequest(protocol.IssuesCreate, map[string]any{"title": title, "body": valueOr(flags, "--body", "")}, false), flags, err
	case "edit":
		return parseIssueEdit(args[1:])
	case "comment":
		return parseComment(args[1:], protocol.IssuesComment)
	default:
		return Request{}, parsedFlags{}, fmt.Errorf("unsupported issue operation")
	}
}

func parseIssueEdit(args []string) (Request, parsedFlags, error) {
	number, rest, err := parseRequiredNumber(args)
	if err != nil {
		return Request{}, parsedFlags{}, err
	}
	flags, err := parseFlags(rest, operationFlags("--title", "--body", "--state"))
	arguments := map[string]any{"number": number}
	copyPresent(arguments, flags, "--title", "title")
	copyPresent(arguments, flags, "--body", "body")
	copyPresent(arguments, flags, "--state", "state")
	if err == nil && len(arguments) == 1 {
		err = fmt.Errorf("issue edit requires a mutable field")
	}
	return makeRequest(protocol.IssuesUpdate, arguments, false), flags, err
}

func parseComment(args []string, operation protocol.Operation) (Request, parsedFlags, error) {
	number, rest, err := parseRequiredNumber(args)
	if err != nil {
		return Request{}, parsedFlags{}, err
	}
	flags, err := parseFlags(rest, operationFlags("--body"))
	body, present := flags.values["--body"]
	if err == nil && !present {
		err = fmt.Errorf("--body is required")
	}
	return makeRequest(operation, map[string]any{"number": number, "body": body}, false), flags, err
}

func parseNumberOperation(args []string, operation protocol.Operation, raw bool) (Request, parsedFlags, error) {
	number, rest, err := parseRequiredNumber(args)
	if err != nil {
		return Request{}, parsedFlags{}, err
	}
	flags, flagErr := parseFlags(rest, operationFlags())
	return makeRequest(operation, map[string]any{"number": number}, raw), flags, flagErr
}

func parseRequiredNumber(args []string) (int, []string, error) {
	if len(args) == 0 {
		return 0, nil, fmt.Errorf("positive number is required")
	}
	number, err := positiveDecimal(args[0])
	return number, args[1:], err
}

func valueOr(flags parsedFlags, name, fallback string) string {
	if value, ok := flags.values[name]; ok {
		return value
	}
	return fallback
}

func copyPresent(arguments map[string]any, flags parsedFlags, flag, field string) {
	if value, ok := flags.values[flag]; ok {
		arguments[field] = value
	}
}
