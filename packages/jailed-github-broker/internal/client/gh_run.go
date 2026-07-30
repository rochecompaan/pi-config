package client

import (
	"fmt"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func parseRun(args []string) (Request, parsedFlags, error) {
	if len(args) == 0 {
		return Request{}, parsedFlags{}, fmt.Errorf("run subcommand is required")
	}
	switch args[0] {
	case "list":
		flags, err := parseFlags(args[1:], operationFlags("--branch", "--status", "--limit"))
		arguments := map[string]any{
			"branch": valueOr(flags, "--branch", ""), "status": valueOr(flags, "--status", ""), "limit": 30,
		}
		if raw, ok := flags.values["--limit"]; ok {
			arguments["limit"], err = positiveDecimal(raw)
		}
		return makeRequest(protocol.ActionsRunsList, arguments, false), flags, err
	case "view":
		if len(args) < 2 {
			return Request{}, parsedFlags{}, fmt.Errorf("run ID is required")
		}
		runID, err := positiveDecimal64(args[1])
		if err != nil {
			return Request{}, parsedFlags{}, err
		}
		flags, flagErr := parseFlags(args[2:], operationFlagsWithBools(nil, "--log"))
		operation, raw := protocol.ActionsRunsGet, false
		if flags.bools["--log"] {
			operation, raw = protocol.ActionsRunsLogs, true
		}
		return makeRequest(operation, map[string]any{"runId": runID}, raw), flags, flagErr
	default:
		return Request{}, parsedFlags{}, fmt.Errorf("unsupported run operation")
	}
}
