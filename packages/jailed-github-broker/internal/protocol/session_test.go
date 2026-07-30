package protocol

import (
	"errors"
	"testing"
)

func TestAPISessionAllowsChunkedStdoutThenOneExit(t *testing.T) {
	s := NewSession(API)
	mustAccept(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 9})
	mustAccept(t, s, ServerToClient, Frame{Kind: ControlResponse, RequestID: 9})
	mustAccept(t, s, ServerToClient, Frame{Kind: StdoutData, RequestID: 9, Payload: []byte("first")})
	mustAccept(t, s, ServerToClient, Frame{Kind: StdoutData, RequestID: 9, Payload: []byte("second")})
	mustAccept(t, s, ServerToClient, ExitFrame(9, 0))
	mustReject(t, s, ServerToClient, Frame{Kind: StdoutData, RequestID: 9})
}

func TestGitSessionAllowsIndependentStdoutAndStderr(t *testing.T) {
	s := NewSession(Git)
	for _, event := range []struct {
		direction Direction
		frame     Frame
	}{
		{ClientToServer, Frame{Kind: ControlRequest, RequestID: 2}},
		{ServerToClient, Frame{Kind: ControlResponse, RequestID: 2}},
		{ServerToClient, Frame{Kind: StdoutData, RequestID: 2, Payload: []byte("out")}},
		{ServerToClient, Frame{Kind: StderrData, RequestID: 2, Payload: []byte("err")}},
		{ClientToServer, Frame{Kind: EndInput, RequestID: 2}},
		{ServerToClient, ExitFrame(2, 0)},
	} {
		mustAccept(t, s, event.direction, event.frame)
	}
}

func TestSessionRejectsMismatchedIDsDirectionsAndDuplicateTerminals(t *testing.T) {
	newStreamingGit := func() *Session {
		s := NewSession(Git)
		mustAccept(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 1})
		mustAccept(t, s, ServerToClient, Frame{Kind: ControlResponse, RequestID: 1})
		return s
	}

	s := NewSession(Git)
	mustReject(t, s, ClientToServer, Frame{Kind: StdinData, RequestID: 1})
	mustReject(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 1})

	s = NewSession(Git)
	mustAccept(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 1})
	mustReject(t, s, ClientToServer, Frame{Kind: ControlResponse, RequestID: 1})

	s = newStreamingGit()
	mustReject(t, s, ClientToServer, Frame{Kind: StdinData, RequestID: 2})

	s = newStreamingGit()
	mustAccept(t, s, ClientToServer, Frame{Kind: EndInput, RequestID: 1})
	mustReject(t, s, ClientToServer, Frame{Kind: StdinData, RequestID: 1})

	s = newStreamingGit()
	mustAccept(t, s, ServerToClient, ExitFrame(1, 0))
	mustReject(t, s, ServerToClient, ExitFrame(1, 0))
}

func TestSessionRejectsUnknownModeAndPoisonsAfterInvalidTransition(t *testing.T) {
	s := NewSession(Mode(99))
	mustReject(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 5})
	mustReject(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 5})

	s = NewSession(API)
	mustReject(t, s, ServerToClient, Frame{Kind: ControlRequest, RequestID: 5})
	mustReject(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 5})
}

func TestSessionErrorReplacesResponseAndTerminates(t *testing.T) {
	s := NewSession(API)
	mustAccept(t, s, ClientToServer, Frame{Kind: ControlRequest, RequestID: 3})
	mustAccept(t, s, ServerToClient, Frame{Kind: Error, RequestID: 3})
	mustReject(t, s, ServerToClient, Frame{Kind: Exit, RequestID: 3})
}

func mustAccept(t *testing.T, session *Session, direction Direction, frame Frame) {
	t.Helper()
	if err := session.Accept(direction, frame); err != nil {
		t.Fatalf("Accept(%v) error = %v", frame.Kind, err)
	}
}

func mustReject(t *testing.T, session *Session, direction Direction, frame Frame) {
	t.Helper()
	if err := session.Accept(direction, frame); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("Accept(%v) error = %v, want ErrInvalidState", frame.Kind, err)
	}
}
