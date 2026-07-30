// Package policy applies syntactic Git push restrictions.
package policy

import (
	"fmt"
	"strings"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
)

// Update is a requested receive-pack ref update. Object IDs are opaque here.
type Update struct {
	Old string
	New string
	Ref string
}

// Validate rejects only policy-denied update shapes. It deliberately performs
// no commit ancestry inspection; GitHub remains authoritative for that policy.
func Validate(policy config.PushPolicy, updates []Update) error {
	if policy.MaxRefUpdates != nil && len(updates) > *policy.MaxRefUpdates {
		return fmt.Errorf("push updates %d refs, maximum is %d", len(updates), *policy.MaxRefUpdates)
	}
	denied := make(map[string]struct{}, len(policy.DenyRefs))
	for _, ref := range policy.DenyRefs {
		denied[ref] = struct{}{}
	}
	for _, update := range updates {
		if _, blocked := denied[update.Ref]; blocked {
			return fmt.Errorf("push update for denied ref %q", update.Ref)
		}
		if policy.DenyDeletes && zeroObjectID(update.New) {
			return fmt.Errorf("push deletion for ref %q is denied", update.Ref)
		}
	}
	return nil
}

func zeroObjectID(id string) bool {
	return id != "" && strings.Trim(id, "0") == ""
}
