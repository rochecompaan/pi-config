package protocol

import (
	"encoding/binary"
	"fmt"
)

// ExitStatusSize is the exact signed int32 payload size for Exit frames.
const ExitStatusSize = 4

// EncodeExitStatus returns the big-endian wire representation of an exit code.
func EncodeExitStatus(status int32) []byte {
	payload := make([]byte, ExitStatusSize)
	binary.BigEndian.PutUint32(payload, uint32(status))
	return payload
}

// ExitFrame constructs a valid terminal frame for one request.
func ExitFrame(requestID uint32, status int32) Frame {
	return Frame{Kind: Exit, RequestID: requestID, Payload: EncodeExitStatus(status)}
}

// DecodeExitStatus validates and returns an Exit frame's signed status.
func DecodeExitStatus(frame Frame) (int32, error) {
	if frame.Kind != Exit || len(frame.Payload) != ExitStatusSize {
		return 0, fmt.Errorf("%w: exit status payload", ErrInvalidFrame)
	}
	return int32(binary.BigEndian.Uint32(frame.Payload)), nil
}
