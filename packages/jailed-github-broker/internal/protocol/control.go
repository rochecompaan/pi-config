package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ErrInvalidControl marks malformed or ambiguous control JSON.
var ErrInvalidControl = errors.New("invalid control request")

// Operation is one operation the broker protocol recognizes.
type Operation string

const (
	RepositoryGet       Operation = "repository.get"
	IssuesList          Operation = "issues.list"
	IssuesGet           Operation = "issues.get"
	IssuesCreate        Operation = "issues.create"
	IssuesUpdate        Operation = "issues.update"
	IssuesComment       Operation = "issues.comment"
	PullRequestsList    Operation = "pullRequests.list"
	PullRequestsGet     Operation = "pullRequests.get"
	PullRequestsCreate  Operation = "pullRequests.create"
	PullRequestsUpdate  Operation = "pullRequests.update"
	PullRequestsComment Operation = "pullRequests.comment"
	PullRequestsDiff    Operation = "pullRequests.diff"
	PullRequestsChecks  Operation = "pullRequests.checks"
	ActionsRunsList     Operation = "actions.runs.list"
	ActionsRunsGet      Operation = "actions.runs.get"
	ActionsRunsLogs     Operation = "actions.runs.logs"
	StatusesGet         Operation = "statuses.get"
	GitUploadPack       Operation = "git.uploadPack"
	GitReceivePack      Operation = "git.receivePack"
)

var validOperations = map[Operation]struct{}{
	RepositoryGet: {}, IssuesList: {}, IssuesGet: {}, IssuesCreate: {}, IssuesUpdate: {}, IssuesComment: {},
	PullRequestsList: {}, PullRequestsGet: {}, PullRequestsCreate: {}, PullRequestsUpdate: {}, PullRequestsComment: {},
	PullRequestsDiff: {}, PullRequestsChecks: {}, ActionsRunsList: {}, ActionsRunsGet: {}, ActionsRunsLogs: {},
	StatusesGet: {}, GitUploadPack: {}, GitReceivePack: {},
}

// ControlRequestBody is the strictly decoded initial request payload.
type ControlRequestBody struct {
	Version   int             `json:"version"`
	RequestID uint32          `json:"requestId"`
	Operation Operation       `json:"operation"`
	Arguments json.RawMessage `json:"arguments"`
}

// DecodeInitialRequest validates the first control frame and binds its header
// request ID to the request ID inside its strict JSON payload.
func DecodeInitialRequest(frame Frame, limits Limits) (ControlRequestBody, error) {
	if frame.Kind != ControlRequest || frame.RequestID == 0 || uint64(len(frame.Payload)) > uint64(limits.MaxControlBytes) {
		return ControlRequestBody{}, fmt.Errorf("%w: invalid initial frame", ErrInvalidControl)
	}
	request, err := DecodeControlRequest(frame.Payload)
	if err != nil {
		return ControlRequestBody{}, err
	}
	if request.RequestID != frame.RequestID {
		return ControlRequestBody{}, fmt.Errorf("%w: header and body request IDs differ", ErrInvalidControl)
	}
	return request, nil
}

// DecodeControlRequest decodes one exact envelope with no unknown, trailing,
// duplicate, or case-aliased fields. Arguments, when present, must be an object.
func DecodeControlRequest(data []byte) (ControlRequestBody, error) {
	if err := rejectDuplicateKeys(data); err != nil {
		return ControlRequestBody{}, err
	}
	if err := validateEnvelopeKeys(data); err != nil {
		return ControlRequestBody{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request ControlRequestBody
	if err := decoder.Decode(&request); err != nil {
		return ControlRequestBody{}, fmt.Errorf("%w: %v", ErrInvalidControl, err)
	}
	if err := ensureEOF(decoder); err != nil {
		return ControlRequestBody{}, err
	}
	if request.Version != int(Version) || request.RequestID == 0 {
		return ControlRequestBody{}, fmt.Errorf("%w: version or request ID", ErrInvalidControl)
	}
	if _, valid := validOperations[request.Operation]; !valid {
		return ControlRequestBody{}, fmt.Errorf("%w: unknown operation %q", ErrInvalidControl, request.Operation)
	}
	if len(request.Arguments) != 0 && !isJSONObject(request.Arguments) {
		return ControlRequestBody{}, fmt.Errorf("%w: arguments must be an object", ErrInvalidControl)
	}
	if len(request.Arguments) == 0 {
		request.Arguments = json.RawMessage(`{}`)
	}
	return request, nil
}

func validateEnvelopeKeys(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return fmt.Errorf("%w: envelope must be an object", ErrInvalidControl)
	}
	for name := range fields {
		switch name {
		case "version", "requestId", "operation", "arguments":
		default:
			return fmt.Errorf("%w: unknown envelope field %q", ErrInvalidControl, name)
		}
	}
	return nil
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: trailing JSON", ErrInvalidControl)
	}
	return nil
}

func isJSONObject(data []byte) bool {
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}

func rejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := inspectJSONValue(decoder); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidControl, err)
	}
	return ensureEOF(decoder)
}

func inspectJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate field %q", key)
			}
			seen[key] = struct{}{}
			if err := inspectJSONValue(decoder); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	case '[':
		for decoder.More() {
			if err := inspectJSONValue(decoder); err != nil {
				return err
			}
		}
		_, err := decoder.Token()
		return err
	default:
		return errors.New("unexpected JSON delimiter")
	}
}
