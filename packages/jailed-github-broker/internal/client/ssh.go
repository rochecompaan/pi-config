package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

var allowedSSHDiagnostic = []byte("ssh transport diagnostic\n")

// ParseSSH accepts only the exact Git-generated GitHub forms approved by policy.
func ParseSSH(args []string, repository string) (SSHRequest, error) {
	if !validRepositorySlug(repository) {
		return SSHRequest{}, fmt.Errorf("configured repository must be owner/repository")
	}
	if len(args) == 4 {
		if args[0] != "-o" || args[1] != "SendEnv=GIT_PROTOCOL" {
			return SSHRequest{}, fmt.Errorf("unsupported SSH option")
		}
		args = args[2:]
	}
	if len(args) != 2 || args[0] != "git@github.com" {
		return SSHRequest{}, fmt.Errorf("unsupported SSH authority or argument shape")
	}
	for _, candidate := range []struct {
		service   string
		operation protocol.Operation
	}{
		{"git-upload-pack", protocol.GitUploadPack},
		{"git-receive-pack", protocol.GitReceivePack},
	} {
		if args[1] == candidate.service+" '"+repository+".git'" {
			return SSHRequest{Operation: candidate.operation}, nil
		}
	}
	return SSHRequest{}, fmt.Errorf("unsupported SSH remote command")
}

// RelayGit carries Git bytes unchanged over the framed full-duplex session.
func RelayGit(ctx context.Context, socket string, request SSHRequest, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	arguments := json.RawMessage(`{}`)
	session, requestID, err := openRequest(ctx, socket, request.Operation, arguments, protocol.Git)
	if err != nil {
		return 1, err
	}
	defer session.Close()
	if err := acceptResponse(session, requestID); err != nil {
		return 1, err
	}
	inputResult := make(chan error, 1)
	go func() { inputResult <- session.pumpInput(stdin) }()

	diagnosticSeen := false
	for {
		frame, readErr := session.readServer()
		if readErr != nil {
			select {
			case inputErr := <-inputResult:
				if inputErr != nil {
					return 1, fmt.Errorf("Git input failed: %w", inputErr)
				}
			default:
			}
			return 1, fmt.Errorf("Git broker stream failed: %w", readErr)
		}
		switch frame.Kind {
		case protocol.StdoutData:
			err = writeExact(stdout, frame.Payload)
		case protocol.StderrData:
			if diagnosticSeen || !bytes.Equal(frame.Payload, allowedSSHDiagnostic) {
				err = fmt.Errorf("invalid SSH diagnostic")
			} else {
				diagnosticSeen = true
				err = writeExact(stderr, frame.Payload)
			}
		case protocol.Exit:
			status, decodeErr := protocol.DecodeExitStatus(frame)
			if decodeErr != nil || status < 0 {
				err = fmt.Errorf("invalid Git broker exit status")
			} else {
				if closeErr := session.requireEOF(); closeErr != nil {
					return 1, closeErr
				}
				return int(status), nil
			}
		default:
			err = fmt.Errorf("invalid Git response frame")
		}
		if err != nil {
			return 1, err
		}
	}
}

// RunSSH rejects locally before dialing and maps only fixed diagnostics.
func RunSSH(ctx context.Context, socket, repository string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	request, err := ParseSSH(args, repository)
	if err != nil {
		writeDiagnostic(stderr, "jailed-git-ssh: unsupported invocation\n")
		return 2
	}
	status, err := RelayGit(ctx, socket, request, stdin, stdout, stderr)
	if err != nil {
		writeDiagnostic(stderr, "jailed-git-ssh: transport failed\n")
		return 1
	}
	if status == 0 {
		return 0
	}
	return shellStatus(status)
}
