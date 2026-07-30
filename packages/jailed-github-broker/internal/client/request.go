// Package client implements the fail-closed jailed gh and Git SSH clients.
package client

import (
	"encoding/json"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const (
	// SocketEnvironment is the required non-secret jail-side broker socket setting.
	SocketEnvironment = "JAILED_GITHUB_BROKER_SOCKET"
	// RepositoryEnvironment is the required non-secret jail-side owner/repository setting.
	RepositoryEnvironment = "JAILED_GITHUB_BROKER_REPOSITORY"
	maxFormattedBytes     = 32 << 20
)

// Request is a typed API operation plus jail-local output selection.
type Request struct {
	Operation protocol.Operation
	Arguments json.RawMessage
	Fields    []string
	JQ        string
	Raw       bool
}

// SSHRequest is one authority-free typed Git service request.
type SSHRequest struct {
	Operation protocol.Operation
}
