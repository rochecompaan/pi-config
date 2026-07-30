package client

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

var ErrRejected = errors.New("broker rejected request")

const maxResponseBytes = 32 << 20

type controlEnvelope struct {
	Version   int                `json:"version"`
	RequestID uint32             `json:"requestId"`
	Operation protocol.Operation `json:"operation"`
	Arguments json.RawMessage    `json:"arguments"`
}

func openRequest(ctx context.Context, socket string, operation protocol.Operation, arguments json.RawMessage, mode protocol.Mode) (*clientSession, uint32, error) {
	if !filepath.IsAbs(socket) {
		return nil, 0, fmt.Errorf("broker socket path must be absolute")
	}
	requestID, err := randomRequestID()
	if err != nil {
		return nil, 0, err
	}
	payload, err := json.Marshal(controlEnvelope{Version: int(protocol.Version), RequestID: requestID, Operation: operation, Arguments: arguments})
	if err != nil {
		return nil, 0, err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, 0, fmt.Errorf("connect to broker: %w", err)
	}
	session := newClientSession(ctx, conn, mode, requestID)
	if err := session.send(protocol.ControlRequest, payload); err != nil {
		_ = session.Close()
		return nil, 0, fmt.Errorf("send broker request: %w", err)
	}
	return session, requestID, nil
}

func acceptResponse(session *clientSession, requestID uint32) error {
	frame, err := session.readServer()
	if err != nil {
		return fmt.Errorf("read broker response: %w", err)
	}
	if frame.RequestID != requestID {
		return fmt.Errorf("broker response request ID mismatch")
	}
	if frame.Kind == protocol.Error {
		rejection, err := protocol.DecodeArguments[struct {
			Message string `json:"message"`
		}](frame.Payload)
		if err != nil || rejection.Message != "request rejected" {
			return fmt.Errorf("invalid broker rejection response")
		}
		if err := session.requireEOF(); err != nil {
			return err
		}
		return ErrRejected
	}
	response, err := protocol.DecodeAcceptance(frame.Payload)
	if err != nil {
		return fmt.Errorf("invalid broker acceptance response")
	}
	session.setStreamLimit(response.MaxStreamFrameBytes)
	return nil
}

// ExecuteAPI performs one API request and validates its complete response transcript.
func ExecuteAPI(ctx context.Context, socket string, request Request) ([]byte, int, error) {
	session, requestID, err := openRequest(ctx, socket, request.Operation, request.Arguments, protocol.API)
	if err != nil {
		return nil, 1, err
	}
	defer session.Close()
	if err := acceptResponse(session, requestID); err != nil {
		return nil, 1, err
	}
	output := make([]byte, 0)
	for {
		frame, err := session.readServer()
		if err != nil {
			return nil, 1, fmt.Errorf("read broker stream: %w", err)
		}
		switch frame.Kind {
		case protocol.StdoutData:
			if len(frame.Payload) > maxResponseBytes-len(output) {
				return nil, 1, fmt.Errorf("broker response exceeds client limit")
			}
			output = append(output, frame.Payload...)
		case protocol.Exit:
			status, err := protocol.DecodeExitStatus(frame)
			if err != nil || status < 0 {
				return nil, 1, fmt.Errorf("invalid broker exit status")
			}
			if err := session.requireEOF(); err != nil {
				return nil, 1, err
			}
			return output, int(status), nil
		default:
			return nil, 1, fmt.Errorf("invalid API response frame")
		}
	}
}

func randomRequestID() (uint32, error) {
	var raw [4]byte
	for {
		if _, err := io.ReadFull(rand.Reader, raw[:]); err != nil {
			return 0, fmt.Errorf("generate request ID: %w", err)
		}
		if value := binary.BigEndian.Uint32(raw[:]); value != 0 {
			return value, nil
		}
	}
}
