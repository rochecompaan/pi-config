package protocol

import (
	"errors"
	"fmt"
)

// ErrInvalidState marks frames disallowed by the one-request connection state.
var ErrInvalidState = errors.New("invalid protocol state transition")

// Direction identifies the side that emitted a frame.
type Direction byte

const (
	ClientToServer Direction = iota + 1
	ServerToClient
)

// Mode determines whether client stream input is permitted after acceptance.
type Mode byte

const (
	API Mode = iota + 1
	Git
)

type state byte

const (
	awaitRequest state = iota
	awaitResponse
	streaming
	terminal
)

// Session validates a complete transcript for one logical request connection.
type Session struct {
	mode      Mode
	state     state
	requestID uint32
	inputDone bool
}

// NewSession creates a fail-closed one-request state validator.
func NewSession(mode Mode) *Session {
	session := &Session{mode: mode, state: awaitRequest}
	if mode != API && mode != Git {
		session.state = terminal
	}
	return session
}

// Accept validates and advances one emitted frame. Every invalid transition
// poisons the session so no subsequent frame can be accepted.
func (session *Session) Accept(direction Direction, frame Frame) error {
	if frame.RequestID == 0 || (direction != ClientToServer && direction != ServerToClient) {
		return session.reject("direction or request ID")
	}
	if session.state == terminal {
		return session.reject("terminal")
	}
	if session.state == awaitRequest {
		if direction != ClientToServer || frame.Kind != ControlRequest {
			return session.reject("expected control request")
		}
		session.requestID = frame.RequestID
		session.state = awaitResponse
		return nil
	}
	if frame.RequestID != session.requestID {
		return session.reject("mismatched request ID")
	}
	if session.state == awaitResponse {
		if direction != ServerToClient || (frame.Kind != ControlResponse && frame.Kind != Error) {
			return session.reject("expected response or error")
		}
		if frame.Kind == Error {
			session.state = terminal
		} else {
			session.state = streaming
		}
		return nil
	}
	return session.acceptStream(direction, frame)
}

func (session *Session) acceptStream(direction Direction, frame Frame) error {
	if session.inputDone && direction == ClientToServer {
		return session.reject("input already ended")
	}
	if session.mode == API {
		if direction != ServerToClient || (frame.Kind != StdoutData && frame.Kind != Exit) {
			return session.reject("API stream direction or kind")
		}
	} else if session.mode != Git || !validGitStream(direction, frame.Kind) {
		return session.reject("Git stream direction or kind")
	}
	if frame.Kind == EndInput {
		session.inputDone = true
	}
	if frame.Kind == Exit {
		session.state = terminal
	}
	return nil
}

func (session *Session) reject(reason string) error {
	session.state = terminal
	return fmt.Errorf("%w: %s", ErrInvalidState, reason)
}

func validGitStream(direction Direction, kind Kind) bool {
	if direction == ClientToServer {
		return kind == StdinData || kind == EndInput
	}
	return direction == ServerToClient && (kind == StdoutData || kind == StderrData || kind == Exit)
}
