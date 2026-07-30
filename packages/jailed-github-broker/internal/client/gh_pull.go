package client

import (
	"fmt"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func parsePullRequest(args []string) (Request, parsedFlags, error) {
	if len(args) == 0 {
		return Request{}, parsedFlags{}, fmt.Errorf("pull-request subcommand is required")
	}
	switch args[0] {
	case "list":
		return parsePullList(args[1:])
	case "view":
		return parseNumberOperation(args[1:], protocol.PullRequestsGet, false)
	case "create":
		return parsePullCreate(args[1:])
	case "edit":
		return parsePullEdit(args[1:])
	case "comment":
		return parseComment(args[1:], protocol.PullRequestsComment)
	case "diff":
		return parseNumberOperation(args[1:], protocol.PullRequestsDiff, true)
	case "checks":
		return parseNumberOperation(args[1:], protocol.PullRequestsChecks, false)
	default:
		return Request{}, parsedFlags{}, fmt.Errorf("unsupported pull-request operation")
	}
}

func parsePullList(args []string) (Request, parsedFlags, error) {
	flags, err := parseFlags(args, operationFlags("--state", "--base", "--head", "--limit"))
	arguments := map[string]any{
		"state": valueOr(flags, "--state", "open"), "base": valueOr(flags, "--base", ""),
		"head": valueOr(flags, "--head", ""), "limit": 30,
	}
	if raw, ok := flags.values["--limit"]; ok {
		arguments["limit"], err = positiveDecimal(raw)
	}
	return makeRequest(protocol.PullRequestsList, arguments, false), flags, err
}

func parsePullCreate(args []string) (Request, parsedFlags, error) {
	flags, err := parseFlags(args, operationFlagsWithBools([]string{"--head", "--base", "--title", "--body"}, "--draft"))
	arguments := map[string]any{
		"head": valueOr(flags, "--head", ""), "base": valueOr(flags, "--base", ""),
		"title": valueOr(flags, "--title", ""), "body": valueOr(flags, "--body", ""), "draft": flags.bools["--draft"],
	}
	for _, required := range []string{"--head", "--base", "--title"} {
		if _, present := flags.values[required]; err == nil && !present {
			err = fmt.Errorf("%s is required", required)
		}
	}
	return makeRequest(protocol.PullRequestsCreate, arguments, false), flags, err
}

func parsePullEdit(args []string) (Request, parsedFlags, error) {
	number, rest, err := parseRequiredNumber(args)
	if err != nil {
		return Request{}, parsedFlags{}, err
	}
	flags, err := parseFlags(rest, operationFlags("--title", "--body", "--base", "--state"))
	arguments := map[string]any{"number": number}
	for _, pair := range [][2]string{{"--title", "title"}, {"--body", "body"}, {"--base", "base"}, {"--state", "state"}} {
		copyPresent(arguments, flags, pair[0], pair[1])
	}
	if err == nil && len(arguments) == 1 {
		err = fmt.Errorf("pull-request edit requires a mutable field")
	}
	return makeRequest(protocol.PullRequestsUpdate, arguments, false), flags, err
}
