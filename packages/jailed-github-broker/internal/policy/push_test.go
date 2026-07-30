package policy

import (
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
)

func TestValidateRejectsMainByDefault(t *testing.T) {
	err := Validate(config.DefaultPushPolicy(), []Update{{
		Old: "1111111111111111111111111111111111111111",
		New: "2222222222222222222222222222222222222222",
		Ref: "refs/heads/main",
	}})
	if err == nil || !strings.Contains(err.Error(), "refs/heads/main") {
		t.Fatalf("Validate() error = %v, want main denial", err)
	}
}

func TestValidateDefaultAllowsGitHubUpdateShapesExceptMain(t *testing.T) {
	updates := []Update{
		{Old: "1111111111111111111111111111111111111111", New: "2222222222222222222222222222222222222222", Ref: "refs/heads/feature/new"},
		{Old: "0000000000000000000000000000000000000000", New: "3333333333333333333333333333333333333333", Ref: "refs/tags/v1.0.0"},
		{Old: "4444444444444444444444444444444444444444", New: "0000000000000000000000000000000000000000", Ref: "refs/heads/obsolete"},
		{Old: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", New: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Ref: "refs/heads/rewritten"},
	}
	if err := Validate(config.DefaultPushPolicy(), updates); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestValidateUsesExactCustomDeniedRefs(t *testing.T) {
	policy := config.PushPolicy{DenyRefs: []string{"refs/heads/release"}}
	if err := Validate(policy, []Update{{Ref: "refs/heads/release"}}); err == nil {
		t.Fatal("Validate() error = nil for exact denied ref")
	}
	if err := Validate(policy, []Update{{Ref: "refs/heads/release-candidate"}}); err != nil {
		t.Fatalf("Validate() error = %v for non-exact ref", err)
	}
}

func TestValidateOptionallyRejectsDeletes(t *testing.T) {
	policy := config.PushPolicy{DenyDeletes: true}
	if err := Validate(policy, []Update{{
		Old: "1111111111111111111111111111111111111111",
		New: "0000000000000000000000000000000000000000",
		Ref: "refs/heads/feature",
	}}); err == nil {
		t.Fatal("Validate() error = nil for deletion")
	}
}

func TestValidateOptionallyLimitsRefUpdates(t *testing.T) {
	limit := 1
	policy := config.PushPolicy{MaxRefUpdates: &limit}
	if err := Validate(policy, []Update{{Ref: "refs/heads/a"}, {Ref: "refs/heads/b"}}); err == nil {
		t.Fatal("Validate() error = nil above maximum")
	}
}
