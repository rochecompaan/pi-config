package config

import (
	"fmt"
	"strings"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestDecodeAcceptsValidRepositorySlug(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{"enable":true,"repository":"alpha-exploration/clubhouse_infra"}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	if cfg.Repository != "alpha-exploration/clubhouse_infra" {
		t.Fatalf("Repository = %q", cfg.Repository)
	}
}

func TestDecodeAcceptsGitHubOwnerAndRepositoryForms(t *testing.T) {
	for _, repository := range []string{
		"octo-org/.github",
		"owner/repo.name_with-dashes",
		"owner/repo-",
	} {
		t.Run(repository, func(t *testing.T) {
			_, err := DecodeJSON([]byte(`{"enable":true,"repository":"` + repository + `"}`))
			if err != nil {
				t.Fatalf("DecodeJSON() error = %v", err)
			}
		})
	}
}

func TestDecodeRejectsInvalidRepositorySlugs(t *testing.T) {
	for _, repository := range []string{
		"", "owner", "/repo", "owner/", "owner/repo/extra", "owner//repo", "owner repo",
		"owner/repo name", "https://github.com/owner/repo", "owner/../repo", "owner_name/repo",
		"owner.name/repo", "-owner/repo", "owner-/repo", "owner--name/repo", "owner/repo;command",
	} {
		t.Run(repository, func(t *testing.T) {
			_, err := DecodeJSON([]byte(`{"enable":true,"repository":"` + repository + `"}`))
			if err == nil {
				t.Fatal("DecodeJSON() error = nil")
			}
		})
	}
}

func TestDecodeRequiresRepositoryWhenEnabled(t *testing.T) {
	_, err := DecodeJSON([]byte(`{"enable":true}`))
	if err == nil || !strings.Contains(err.Error(), "repository") {
		t.Fatalf("DecodeJSON() error = %v, want repository error", err)
	}
}

func TestDecodeRejectsUnknownCapabilitiesAndFields(t *testing.T) {
	for _, data := range [][]byte{
		[]byte(`{"repository":"owner/repo","capabilities":["not-a-capability"]}`),
		[]byte(`{"repository":"owner/repo","unexpected":true}`),
		[]byte(`{"repository":"owner/repo"}{}`),
	} {
		_, err := DecodeJSON(data)
		if err == nil {
			t.Fatalf("DecodeJSON(%s) error = nil", data)
		}
	}
}

func TestDecodeRejectsNullForNonNullableFields(t *testing.T) {
	for _, data := range [][]byte{
		[]byte(`null`),
		[]byte(`{"enable":null}`),
		[]byte(`{"repository":null}`),
		[]byte(`{"capabilities":null}`),
		[]byte(`{"pushPolicy":null}`),
		[]byte(`{"limits":null}`),
		[]byte(`{"pushPolicy":{"denyRefs":null}}`),
		[]byte(`{"pushPolicy":{"denyDeletes":null}}`),
		[]byte(`{"limits":{"maxControlBytes":null}}`),
	} {
		t.Run(string(data), func(t *testing.T) {
			if _, err := DecodeJSON(data); err == nil {
				t.Fatal("DecodeJSON() error = nil")
			}
		})
	}
}

func TestDecodeRequiresGitReadForGitWrite(t *testing.T) {
	_, err := DecodeJSON([]byte(`{"repository":"owner/repo","capabilities":["git:write"]}`))
	if err == nil || !strings.Contains(err.Error(), "git:read") {
		t.Fatalf("DecodeJSON() error = %v, want git:read dependency", err)
	}
}

func TestDecodeAppliesDocumentedDefaults(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{"repository":"owner/repo"}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}

	if cfg.Enable {
		t.Error("Enable = true, want false")
	}
	if len(cfg.Capabilities) != 0 {
		t.Errorf("Capabilities = %v, want empty", cfg.Capabilities)
	}
	if got, want := cfg.PushPolicy.DenyRefs, []string{"refs/heads/main"}; !sameStrings(got, want) {
		t.Errorf("DenyRefs = %v, want %v", got, want)
	}
	if cfg.PushPolicy.DenyDeletes {
		t.Error("DenyDeletes = true, want false")
	}
	if cfg.PushPolicy.MaxRefUpdates != nil {
		t.Errorf("MaxRefUpdates = %v, want nil", *cfg.PushPolicy.MaxRefUpdates)
	}
	if cfg.Limits != (Limits{
		MaxConcurrentRequests:      8,
		MaxControlBytes:            1_048_576,
		MaxStreamFrameBytes:        65_536,
		MaxPushPrefixBytes:         1_048_576,
		InitialFrameTimeoutSeconds: 5,
		OperationTimeoutSeconds:    600,
		IdleStreamTimeoutSeconds:   120,
	}) {
		t.Errorf("Limits = %+v", cfg.Limits)
	}
}

func TestDecodeMergesPartialPushPolicyWithDefaults(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{
		"repository":"owner/repo",
		"pushPolicy":{"denyDeletes":true}
	}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	if got, want := cfg.PushPolicy.DenyRefs, []string{"refs/heads/main"}; !sameStrings(got, want) {
		t.Errorf("DenyRefs = %v, want %v", got, want)
	}
	if !cfg.PushPolicy.DenyDeletes {
		t.Error("DenyDeletes = false, want true")
	}
	if cfg.PushPolicy.MaxRefUpdates != nil {
		t.Errorf("MaxRefUpdates = %v, want nil", *cfg.PushPolicy.MaxRefUpdates)
	}
}

func TestDecodePreservesExplicitEmptyAndNullPushPolicyValues(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{
		"repository":"owner/repo",
		"pushPolicy":{"denyRefs":[],"denyDeletes":false,"maxRefUpdates":null}
	}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	if len(cfg.PushPolicy.DenyRefs) != 0 {
		t.Errorf("DenyRefs = %v, want empty", cfg.PushPolicy.DenyRefs)
	}
	if cfg.PushPolicy.DenyDeletes {
		t.Error("DenyDeletes = true, want explicit false")
	}
	if cfg.PushPolicy.MaxRefUpdates != nil {
		t.Errorf("MaxRefUpdates = %v, want explicit null", *cfg.PushPolicy.MaxRefUpdates)
	}
}

func TestDecodeMergesPartialLimitsWithDefaults(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{
		"repository":"owner/repo",
		"limits":{"operationTimeoutSeconds":42}
	}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	want := DefaultLimits()
	want.OperationTimeoutSeconds = 42
	if cfg.Limits != want {
		t.Errorf("Limits = %+v, want %+v", cfg.Limits, want)
	}
}

func TestDecodeRejectsLimitsThatOverflowWireOrDurationTypes(t *testing.T) {
	for _, test := range []struct {
		name  string
		field string
		value string
	}{
		{name: "control uint32", field: "maxControlBytes", value: "4294967296"},
		{name: "stream uint32", field: "maxStreamFrameBytes", value: "4294967296"},
		{name: "push prefix uint32", field: "maxPushPrefixBytes", value: "4294967296"},
		{name: "initial duration", field: "initialFrameTimeoutSeconds", value: "9223372037"},
		{name: "operation duration", field: "operationTimeoutSeconds", value: "9223372037"},
		{name: "idle duration", field: "idleStreamTimeoutSeconds", value: "9223372037"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := DecodeJSON([]byte(`{"repository":"owner/repo","limits":{"` + test.field + `":` + test.value + `}}`))
			if err == nil {
				t.Fatalf("accepted overflowing %s", test.field)
			}
		})
	}
}

func TestDecodeEnforcesPracticalStreamFrameCap(t *testing.T) {
	for _, value := range []string{
		fmt.Sprint(protocol.MaxStreamFrameBytes - 1),
		fmt.Sprint(protocol.MaxStreamFrameBytes),
	} {
		if _, err := DecodeJSON([]byte(`{"repository":"owner/repo","limits":{"maxStreamFrameBytes":` + value + `}}`)); err != nil {
			t.Errorf("rejected safe maxStreamFrameBytes=%s: %v", value, err)
		}
	}
	for _, value := range []string{fmt.Sprint(protocol.MaxStreamFrameBytes + 1), "4294967295"} {
		if _, err := DecodeJSON([]byte(`{"repository":"owner/repo","limits":{"maxStreamFrameBytes":` + value + `}}`)); err == nil {
			t.Errorf("accepted unsafe maxStreamFrameBytes=%s", value)
		}
	}
}

func TestDecodeAllowsExplicitPolicyOverrides(t *testing.T) {
	cfg, err := DecodeJSON([]byte(`{
		"repository":"owner/repo",
		"pushPolicy":{"denyRefs":[],"denyDeletes":true,"maxRefUpdates":2},
		"limits":{"maxConcurrentRequests":1,"maxControlBytes":2,"maxStreamFrameBytes":3,"maxPushPrefixBytes":4,"initialFrameTimeoutSeconds":5,"operationTimeoutSeconds":6,"idleStreamTimeoutSeconds":7}
	}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
	if len(cfg.PushPolicy.DenyRefs) != 0 || !cfg.PushPolicy.DenyDeletes || cfg.PushPolicy.MaxRefUpdates == nil || *cfg.PushPolicy.MaxRefUpdates != 2 {
		t.Errorf("PushPolicy = %+v", cfg.PushPolicy)
	}
	if cfg.Limits.OperationTimeoutSeconds != 6 || cfg.Limits.MaxPushPrefixBytes != 4 {
		t.Errorf("Limits = %+v", cfg.Limits)
	}
}

func TestDecodeAcceptsFullyQualifiedDeniedRefs(t *testing.T) {
	_, err := DecodeJSON([]byte(`{
		"repository":"owner/repo",
		"pushPolicy":{"denyRefs":["refs/heads/release/2026","refs/tags/v1.2.3"]}
	}`))
	if err != nil {
		t.Fatalf("DecodeJSON() error = %v", err)
	}
}

func TestDecodeRejectsMalformedDeniedRefs(t *testing.T) {
	for _, ref := range []string{
		"main", "refs/heads/", "refs//heads/topic", "refs/heads/topic..old",
		"refs/heads/.hidden", "refs/heads/topic.lock", "refs/heads/topic name",
		"refs/heads/topic~old", "refs/heads/topic@{1}", "refs/heads/topic\\name",
	} {
		t.Run(ref, func(t *testing.T) {
			_, err := DecodeJSON([]byte(`{"repository":"owner/repo","pushPolicy":{"denyRefs":["` + ref + `"]}}`))
			if err == nil {
				t.Fatal("DecodeJSON() error = nil")
			}
		})
	}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
