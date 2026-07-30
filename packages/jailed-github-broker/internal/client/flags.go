package client

import (
	"fmt"
	"strconv"
	"strings"
)

type flagKind byte

const (
	valueFlag flagKind = iota
	boolFlag
)

type parsedFlags struct {
	values map[string]string
	bools  map[string]bool
}

func parseFlags(args []string, allowed map[string]flagKind) (parsedFlags, error) {
	parsed := parsedFlags{values: make(map[string]string), bools: make(map[string]bool)}
	seen := make(map[string]struct{})
	for index := 0; index < len(args); index++ {
		name := args[index]
		kind, ok := allowed[name]
		if !ok || !strings.HasPrefix(name, "--") || strings.Contains(name, "=") {
			return parsedFlags{}, fmt.Errorf("unsupported or trailing argument %q", name)
		}
		if _, duplicate := seen[name]; duplicate {
			return parsedFlags{}, fmt.Errorf("duplicate flag %s", name)
		}
		seen[name] = struct{}{}
		if kind == boolFlag {
			parsed.bools[name] = true
			continue
		}
		index++
		if index == len(args) || strings.HasPrefix(args[index], "--") {
			return parsedFlags{}, fmt.Errorf("flag %s requires a value", name)
		}
		parsed.values[name] = args[index]
	}
	return parsed, nil
}

func positiveDecimal(value string) (int, error) {
	if value == "" || value[0] == '+' || value[0] == '-' || (len(value) > 1 && value[0] == '0') {
		return 0, fmt.Errorf("expected a positive decimal integer")
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < 1 {
		return 0, fmt.Errorf("expected a positive decimal integer")
	}
	return number, nil
}

func positiveDecimal64(value string) (int64, error) {
	if value == "" || value[0] == '+' || value[0] == '-' || (len(value) > 1 && value[0] == '0') {
		return 0, fmt.Errorf("expected a positive decimal integer")
	}
	number, err := strconv.ParseInt(value, 10, 64)
	if err != nil || number < 1 {
		return 0, fmt.Errorf("expected a positive decimal integer")
	}
	return number, nil
}
