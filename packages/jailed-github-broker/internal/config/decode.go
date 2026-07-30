package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

type rawConfig struct {
	Enable       json.RawMessage `json:"enable"`
	Repository   json.RawMessage `json:"repository"`
	Capabilities json.RawMessage `json:"capabilities"`
	PushPolicy   json.RawMessage `json:"pushPolicy"`
	Limits       json.RawMessage `json:"limits"`
}

type rawPushPolicy struct {
	DenyRefs      json.RawMessage `json:"denyRefs"`
	DenyDeletes   json.RawMessage `json:"denyDeletes"`
	MaxRefUpdates json.RawMessage `json:"maxRefUpdates"`
}

type rawLimits struct {
	MaxConcurrentRequests      json.RawMessage `json:"maxConcurrentRequests"`
	MaxControlBytes            json.RawMessage `json:"maxControlBytes"`
	MaxStreamFrameBytes        json.RawMessage `json:"maxStreamFrameBytes"`
	MaxPushPrefixBytes         json.RawMessage `json:"maxPushPrefixBytes"`
	InitialFrameTimeoutSeconds json.RawMessage `json:"initialFrameTimeoutSeconds"`
	OperationTimeoutSeconds    json.RawMessage `json:"operationTimeoutSeconds"`
	IdleStreamTimeoutSeconds   json.RawMessage `json:"idleStreamTimeoutSeconds"`
}

// DecodeJSON strictly decodes and validates non-secret broker configuration.
func DecodeJSON(data []byte) (Config, error) {
	var raw rawConfig
	if err := decodeNonNull(data, &raw, "config"); err != nil {
		return Config{}, err
	}

	cfg := Config{
		Capabilities: []Capability{},
		PushPolicy:   DefaultPushPolicy(),
		Limits:       DefaultLimits(),
	}
	if err := decodeIfPresent(raw.Enable, &cfg.Enable, "enable"); err != nil {
		return Config{}, err
	}
	if err := decodeIfPresent(raw.Repository, &cfg.Repository, "repository"); err != nil {
		return Config{}, err
	}
	if err := decodeIfPresent(raw.Capabilities, &cfg.Capabilities, "capabilities"); err != nil {
		return Config{}, err
	}
	if raw.PushPolicy != nil {
		var policy rawPushPolicy
		if err := decodeNonNull(raw.PushPolicy, &policy, "pushPolicy"); err != nil {
			return Config{}, err
		}
		if err := mergePushPolicy(&cfg.PushPolicy, policy); err != nil {
			return Config{}, err
		}
	}
	if raw.Limits != nil {
		var limits rawLimits
		if err := decodeNonNull(raw.Limits, &limits, "limits"); err != nil {
			return Config{}, err
		}
		if err := mergeLimits(&cfg.Limits, limits); err != nil {
			return Config{}, err
		}
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func mergePushPolicy(policy *PushPolicy, raw rawPushPolicy) error {
	if err := decodeIfPresent(raw.DenyRefs, &policy.DenyRefs, "pushPolicy.denyRefs"); err != nil {
		return err
	}
	if err := decodeIfPresent(raw.DenyDeletes, &policy.DenyDeletes, "pushPolicy.denyDeletes"); err != nil {
		return err
	}
	if raw.MaxRefUpdates != nil {
		if isNull(raw.MaxRefUpdates) {
			policy.MaxRefUpdates = nil
			return nil
		}
		var maximum int
		if err := decodeNonNull(raw.MaxRefUpdates, &maximum, "pushPolicy.maxRefUpdates"); err != nil {
			return err
		}
		policy.MaxRefUpdates = &maximum
	}
	return nil
}

func mergeLimits(limits *Limits, raw rawLimits) error {
	for _, field := range []struct {
		data   json.RawMessage
		target *int
		name   string
	}{
		{raw.MaxConcurrentRequests, &limits.MaxConcurrentRequests, "limits.maxConcurrentRequests"},
		{raw.MaxControlBytes, &limits.MaxControlBytes, "limits.maxControlBytes"},
		{raw.MaxStreamFrameBytes, &limits.MaxStreamFrameBytes, "limits.maxStreamFrameBytes"},
		{raw.MaxPushPrefixBytes, &limits.MaxPushPrefixBytes, "limits.maxPushPrefixBytes"},
		{raw.InitialFrameTimeoutSeconds, &limits.InitialFrameTimeoutSeconds, "limits.initialFrameTimeoutSeconds"},
		{raw.OperationTimeoutSeconds, &limits.OperationTimeoutSeconds, "limits.operationTimeoutSeconds"},
		{raw.IdleStreamTimeoutSeconds, &limits.IdleStreamTimeoutSeconds, "limits.idleStreamTimeoutSeconds"},
	} {
		if err := decodeIfPresent(field.data, field.target, field.name); err != nil {
			return err
		}
	}
	return nil
}

func decodeIfPresent[T any](data json.RawMessage, target *T, name string) error {
	if data == nil {
		return nil
	}
	return decodeNonNull(data, target, name)
}

func decodeNonNull[T any](data []byte, target *T, name string) error {
	if isNull(data) {
		return fmt.Errorf("%s cannot be null", name)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("decode %s: trailing JSON value", name)
		}
		return fmt.Errorf("decode %s: trailing data: %w", name, err)
	}
	return nil
}

func isNull(data []byte) bool {
	return bytes.Equal(bytes.TrimSpace(data), []byte("null"))
}
