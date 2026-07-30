package protocol

import (
	"errors"
	"strings"
	"testing"
)

func TestDecodeControlRequestStrictlyValidatesJSON(t *testing.T) {
	request, err := DecodeControlRequest([]byte(`{"version":1,"requestId":42,"operation":"issues.list","arguments":{"state":"open"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if request.RequestID != 42 || request.Operation != "issues.list" || string(request.Arguments) != `{"state":"open"}` {
		t.Fatalf("DecodeControlRequest() = %#v", request)
	}
}

func TestDecodeControlRequestRejectsUnknownTrailingAndDuplicateFields(t *testing.T) {
	for _, body := range []string{
		`{"version":1,"requestId":1,"operation":"issues.list","extra":true}`,
		`{"version":1,"requestId":1,"operation":"issues.list"}{}`,
		`{"version":1,"requestId":1,"requestId":2,"operation":"issues.list"}`,
		`{"version":2,"requestId":1,"operation":"issues.list"}`,
		`{"version":1,"requestId":0,"operation":"issues.list"}`,
		`{"version":1,"requestId":1,"operation":""}`,
	} {
		_, err := DecodeControlRequest([]byte(body))
		if !errors.Is(err, ErrInvalidControl) {
			t.Fatalf("DecodeControlRequest(%s) error = %v, want ErrInvalidControl", body, err)
		}
	}
}

func TestDecodeControlRequestRejectsNestedDuplicateFields(t *testing.T) {
	_, err := DecodeControlRequest([]byte(`{"version":1,"requestId":1,"operation":"issues.list","arguments":{"state":"open","state":"closed"}}`))
	if !errors.Is(err, ErrInvalidControl) {
		t.Fatalf("DecodeControlRequest() error = %v, want ErrInvalidControl", err)
	}
}

func TestDecodeInitialRequestBindsHeaderAndBodyRequestIDs(t *testing.T) {
	frame := Frame{Kind: ControlRequest, RequestID: 4, Payload: []byte(`{"version":1,"requestId":4,"operation":"issues.list"}`)}
	if _, err := DecodeInitialRequest(frame, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	frame.Payload = []byte(`{"version":1,"requestId":5,"operation":"issues.list"}`)
	if _, err := DecodeInitialRequest(frame, DefaultLimits()); !errors.Is(err, ErrInvalidControl) {
		t.Fatalf("DecodeInitialRequest() error = %v, want ErrInvalidControl", err)
	}
}

func TestDecodeControlRequestAcceptsEveryDefinedOperation(t *testing.T) {
	for _, operation := range []Operation{
		RepositoryGet, IssuesList, IssuesGet, IssuesCreate, IssuesUpdate, IssuesComment,
		PullRequestsList, PullRequestsGet, PullRequestsCreate, PullRequestsUpdate,
		PullRequestsComment, PullRequestsDiff, PullRequestsChecks, ActionsRunsList,
		ActionsRunsGet, ActionsRunsLogs, StatusesGet, GitUploadPack, GitReceivePack,
	} {
		body := []byte(`{"version":1,"requestId":1,"operation":"` + string(operation) + `"}`)
		if _, err := DecodeControlRequest(body); err != nil {
			t.Fatalf("DecodeControlRequest(%q) error = %v", operation, err)
		}
	}
}

func TestDecodeControlRequestRejectsCaseAliasesAndUnknownOperations(t *testing.T) {
	for _, body := range []string{
		`{"Version":1,"requestId":1,"operation":"issues.list"}`,
		`{"version":1,"RequestId":1,"operation":"issues.list"}`,
		`{"version":1,"requestId":1,"Operation":"issues.list"}`,
		`{"version":1,"requestId":1,"operation":"Issues.List"}`,
		`{"version":1,"requestId":1,"operation":"repository.delete"}`,
	} {
		if _, err := DecodeControlRequest([]byte(body)); !errors.Is(err, ErrInvalidControl) {
			t.Fatalf("DecodeControlRequest(%s) error = %v, want ErrInvalidControl", body, err)
		}
	}
}

type nestedArguments struct {
	State string `json:"state"`
}

type argumentsDTO struct {
	Title  string          `json:"title"`
	Nested nestedArguments `json:"nested"`
}

func TestDecodeArgumentsRejectsUnknownDuplicateAndCaseAliasFields(t *testing.T) {
	for _, body := range []string{
		`{"title":"x","nested":{"state":"open"}}`,
		`{"Title":"x","nested":{"state":"open"}}`,
		`{"title":"x","title":"y","nested":{"state":"open"}}`,
		`{"title":"x","nested":{"State":"open"}}`,
		`{"title":"x","nested":{"state":"open","state":"closed"}}`,
		`{"title":"x","nested":{"state":"open"},"extra":true}`,
		`{"title":"x","nested":{"state":"open"}}{}`,
	} {
		got, err := DecodeArguments[argumentsDTO]([]byte(body))
		if body == `{"title":"x","nested":{"state":"open"}}` {
			if err != nil || got.Nested.State != "open" {
				t.Fatalf("DecodeArguments(valid) = %#v, %v", got, err)
			}
			continue
		}
		if !errors.Is(err, ErrInvalidControl) {
			t.Fatalf("DecodeArguments(%s) error = %v, want ErrInvalidControl", body, err)
		}
	}
}

func TestDecodeInitialRequestRequiresBoundedControlFrame(t *testing.T) {
	limits := Limits{MaxControlBytes: 4, MaxStreamBytes: 4}
	for _, frame := range []Frame{
		{Kind: StdinData, RequestID: 1, Payload: []byte(`{}`)},
		{Kind: ControlRequest, RequestID: 0, Payload: []byte(`{}`)},
		{Kind: ControlRequest, RequestID: 1, Payload: []byte(`12345`)},
	} {
		if _, err := DecodeInitialRequest(frame, limits); !errors.Is(err, ErrInvalidControl) {
			t.Fatalf("DecodeInitialRequest(%#v) error = %v, want ErrInvalidControl", frame, err)
		}
	}
}

func TestDecodeControlRequestRejectsNonObjectArguments(t *testing.T) {
	_, err := DecodeControlRequest([]byte(`{"version":1,"requestId":1,"operation":"issues.list","arguments":[]}`))
	if !errors.Is(err, ErrInvalidControl) || !strings.Contains(err.Error(), "arguments") {
		t.Fatalf("DecodeControlRequest() error = %v", err)
	}
}
