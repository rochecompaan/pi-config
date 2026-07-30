// Package config decodes the broker's non-secret configuration.
package config

import (
	"fmt"
	"strings"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

// Capability authorizes one fixed group of broker operations.
type Capability string

const (
	RepositoryRead    Capability = "repository:read"
	IssuesRead        Capability = "issues:read"
	IssuesWrite       Capability = "issues:write"
	PullRequestsRead  Capability = "pull-requests:read"
	PullRequestsWrite Capability = "pull-requests:write"
	ActionsRead       Capability = "actions:read"
	StatusesRead      Capability = "statuses:read"
	GitRead           Capability = "git:read"
	GitWrite          Capability = "git:write"
)

var validCapabilities = map[Capability]struct{}{
	RepositoryRead: {}, IssuesRead: {}, IssuesWrite: {}, PullRequestsRead: {},
	PullRequestsWrite: {}, ActionsRead: {}, StatusesRead: {}, GitRead: {}, GitWrite: {},
}

// Config is the complete non-secret broker configuration.
type Config struct {
	Enable       bool         `json:"enable"`
	Repository   string       `json:"repository"`
	Capabilities []Capability `json:"capabilities"`
	PushPolicy   PushPolicy   `json:"pushPolicy"`
	Limits       Limits       `json:"limits"`
}

// PushPolicy controls syntactic ref-update denials only.
type PushPolicy struct {
	DenyRefs      []string `json:"denyRefs"`
	DenyDeletes   bool     `json:"denyDeletes"`
	MaxRefUpdates *int     `json:"maxRefUpdates"`
}

// Limits bound per-broker resource use.
type Limits struct {
	MaxConcurrentRequests      int `json:"maxConcurrentRequests"`
	MaxControlBytes            int `json:"maxControlBytes"`
	MaxStreamFrameBytes        int `json:"maxStreamFrameBytes"`
	MaxPushPrefixBytes         int `json:"maxPushPrefixBytes"`
	InitialFrameTimeoutSeconds int `json:"initialFrameTimeoutSeconds"`
	OperationTimeoutSeconds    int `json:"operationTimeoutSeconds"`
	IdleStreamTimeoutSeconds   int `json:"idleStreamTimeoutSeconds"`
}

// DefaultPushPolicy returns an independent copy of broker defaults.
func DefaultPushPolicy() PushPolicy {
	return PushPolicy{DenyRefs: []string{"refs/heads/main"}}
}

// DefaultLimits returns documented broker resource limits.
func DefaultLimits() Limits {
	return Limits{
		MaxConcurrentRequests:      8,
		MaxControlBytes:            1_048_576,
		MaxStreamFrameBytes:        65_536,
		MaxPushPrefixBytes:         1_048_576,
		InitialFrameTimeoutSeconds: 5,
		OperationTimeoutSeconds:    600,
		IdleStreamTimeoutSeconds:   120,
	}
}

// Validate checks configuration values independent of transport.
func (cfg Config) Validate() error {
	if cfg.Enable && !validRepository(cfg.Repository) {
		return fmt.Errorf("repository is required and must be an owner/repository slug when enabled")
	}
	if cfg.Repository != "" && !validRepository(cfg.Repository) {
		return fmt.Errorf("repository must be an owner/repository slug")
	}

	seen := make(map[Capability]struct{}, len(cfg.Capabilities))
	for _, capability := range cfg.Capabilities {
		if _, ok := validCapabilities[capability]; !ok {
			return fmt.Errorf("unknown capability %q", capability)
		}
		if _, duplicate := seen[capability]; duplicate {
			return fmt.Errorf("duplicate capability %q", capability)
		}
		seen[capability] = struct{}{}
	}
	if _, wantsWrite := seen[GitWrite]; wantsWrite {
		if _, hasRead := seen[GitRead]; !hasRead {
			return fmt.Errorf("git:write requires git:read")
		}
	}
	if err := validatePushPolicy(cfg.PushPolicy); err != nil {
		return err
	}
	return validateLimits(cfg.Limits)
}

func validRepository(repository string) bool {
	owner, name, found := strings.Cut(repository, "/")
	return found && !strings.Contains(name, "/") && validOwner(owner) && validRepositoryName(name)
}

func validOwner(owner string) bool {
	if len(owner) == 0 || len(owner) > 39 || owner[0] == '-' || owner[len(owner)-1] == '-' {
		return false
	}
	previousHyphen := false
	for i := range owner {
		character := owner[i]
		if isASCIIAlphaNumeric(character) {
			previousHyphen = false
			continue
		}
		if character != '-' || previousHyphen {
			return false
		}
		previousHyphen = true
	}
	return true
}

func validRepositoryName(name string) bool {
	if len(name) == 0 || len(name) > 100 || name == "." || name == ".." {
		return false
	}
	for i := range name {
		character := name[i]
		if !isASCIIAlphaNumeric(character) && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(character byte) bool {
	return character >= 'a' && character <= 'z' ||
		character >= 'A' && character <= 'Z' ||
		character >= '0' && character <= '9'
}

func validatePushPolicy(policy PushPolicy) error {
	seen := make(map[string]struct{}, len(policy.DenyRefs))
	for _, ref := range policy.DenyRefs {
		if !validFullRef(ref) {
			return fmt.Errorf("pushPolicy.denyRefs contains invalid ref %q", ref)
		}
		if _, duplicate := seen[ref]; duplicate {
			return fmt.Errorf("pushPolicy.denyRefs contains duplicate ref %q", ref)
		}
		seen[ref] = struct{}{}
	}
	if policy.MaxRefUpdates != nil && *policy.MaxRefUpdates < 1 {
		return fmt.Errorf("pushPolicy.maxRefUpdates must be positive")
	}
	return nil
}

func validFullRef(ref string) bool {
	if !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") ||
		strings.Contains(ref, "//") || strings.Contains(ref, "@{") || strings.HasSuffix(ref, ".") {
		return false
	}
	for _, component := range strings.Split(ref, "/") {
		if component == "" || component[0] == '.' || strings.HasSuffix(component, ".lock") {
			return false
		}
		for i := range component {
			character := component[i]
			if character <= ' ' || character == 0x7f || strings.ContainsRune(`~^:?*[\`, rune(character)) {
				return false
			}
		}
	}
	return true
}

func validateLimits(limits Limits) error {
	for name, value := range map[string]int{
		"limits.maxConcurrentRequests":      limits.MaxConcurrentRequests,
		"limits.maxControlBytes":            limits.MaxControlBytes,
		"limits.maxStreamFrameBytes":        limits.MaxStreamFrameBytes,
		"limits.maxPushPrefixBytes":         limits.MaxPushPrefixBytes,
		"limits.initialFrameTimeoutSeconds": limits.InitialFrameTimeoutSeconds,
		"limits.operationTimeoutSeconds":    limits.OperationTimeoutSeconds,
		"limits.idleStreamTimeoutSeconds":   limits.IdleStreamTimeoutSeconds,
	} {
		if value < 1 {
			return fmt.Errorf("%s must be positive", name)
		}
	}
	if uint64(limits.MaxStreamFrameBytes) > uint64(protocol.MaxStreamFrameBytes) {
		return fmt.Errorf("limits.maxStreamFrameBytes exceeds practical maximum of %d", protocol.MaxStreamFrameBytes)
	}
	maxUint32 := uint64(^uint32(0))
	for name, value := range map[string]int{
		"limits.maxControlBytes":     limits.MaxControlBytes,
		"limits.maxStreamFrameBytes": limits.MaxStreamFrameBytes,
		"limits.maxPushPrefixBytes":  limits.MaxPushPrefixBytes,
	} {
		if uint64(value) > maxUint32 {
			return fmt.Errorf("%s exceeds uint32", name)
		}
	}
	maxDurationSeconds := uint64((1<<63 - 1) / 1_000_000_000)
	for name, value := range map[string]int{
		"limits.initialFrameTimeoutSeconds": limits.InitialFrameTimeoutSeconds,
		"limits.operationTimeoutSeconds":    limits.OperationTimeoutSeconds,
		"limits.idleStreamTimeoutSeconds":   limits.IdleStreamTimeoutSeconds,
	} {
		if uint64(value) > maxDurationSeconds {
			return fmt.Errorf("%s overflows time.Duration", name)
		}
	}
	return nil
}
