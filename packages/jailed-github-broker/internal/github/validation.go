package github

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func positive(value int) error {
	if value < 1 {
		return fmt.Errorf("number must be positive")
	}
	return nil
}
func positiveLimit(value int) error {
	if value < 1 || value > 100 {
		return fmt.Errorf("limit must be 1 through 100")
	}
	return nil
}
func validateList(state string, limit int) error {
	if state != "" && state != "open" && state != "closed" && state != "all" {
		return fmt.Errorf("invalid state")
	}
	return positiveLimit(limit)
}
func validateTitle(value string) error {
	if len(value) < 1 || len(value) > 256 || !utf8.ValidString(value) {
		return fmt.Errorf("title must be 1 through 256 UTF-8 bytes")
	}
	return nil
}
func validateBody(value string, required bool) error {
	if (required && len(value) == 0) || len(value) > 65536 || !utf8.ValidString(value) {
		return fmt.Errorf("invalid body")
	}
	return nil
}
func validateName(value string) error {
	if value == "" {
		return nil
	}
	return validateNameRequired(value)
}
func validateNameRequired(value string) error {
	if len(value) > 255 || value == "" || !utf8.ValidString(value) || strings.ContainsAny(value, " \t\x00\r\n") {
		return fmt.Errorf("invalid branch name")
	}
	return nil
}
func validateObjectID(value string) error {
	if len(value) != 40 && len(value) != 64 {
		return fmt.Errorf("invalid object ID")
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return fmt.Errorf("invalid object ID")
		}
	}
	return nil
}
func validateState(state *string) error {
	if state != nil && *state != "open" && *state != "closed" {
		return fmt.Errorf("invalid state")
	}
	return nil
}
func validateIssueUpdate(args issueUpdateArgs) error {
	if err := positive(args.Number); err != nil {
		return err
	}
	if args.Title == nil && args.Body == nil && args.State == nil {
		return fmt.Errorf("update is empty")
	}
	if args.Title != nil {
		if err := validateTitle(*args.Title); err != nil {
			return err
		}
	}
	if args.Body != nil {
		if err := validateBody(*args.Body, false); err != nil {
			return err
		}
	}
	return validateState(args.State)
}
func validatePRUpdate(args prUpdateArgs) error {
	if err := positive(args.Number); err != nil {
		return err
	}
	if args.Title == nil && args.Body == nil && args.Base == nil && args.State == nil {
		return fmt.Errorf("update is empty")
	}
	if args.Title != nil {
		if err := validateTitle(*args.Title); err != nil {
			return err
		}
	}
	if args.Body != nil {
		if err := validateBody(*args.Body, false); err != nil {
			return err
		}
	}
	if args.Base != nil {
		if err := validateNameRequired(*args.Base); err != nil {
			return err
		}
	}
	return validateState(args.State)
}
