// Package protocol provides bounded framing and request-session validation.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	// Version is the only supported wire protocol version.
	Version byte = 1
	// HeaderSize is version, kind, request ID, and payload length.
	HeaderSize = 10
	// MaxStreamFrameBytes is the practical hard cap for one stream payload.
	MaxStreamFrameBytes uint32 = 1_048_576
)

var (
	ErrInvalidFrame  = errors.New("invalid protocol frame")
	ErrFrameTooLarge = errors.New("protocol frame exceeds limit")
)

// Kind identifies a framed protocol message.
type Kind byte

const (
	ControlRequest Kind = iota + 1
	ControlResponse
	StdinData
	StdoutData
	StderrData
	EndInput
	Exit
	Error
)

// Frame is one bounded wire message.
type Frame struct {
	Kind      Kind
	RequestID uint32
	Payload   []byte
}

// Limits constrains allocation and transport message sizes.
type Limits struct {
	MaxControlBytes uint32
	MaxStreamBytes  uint32
}

// DefaultLimits are protocol-local conservative defaults.
func DefaultLimits() Limits {
	return Limits{MaxControlBytes: 1_048_576, MaxStreamBytes: 65_536}
}

// WriteFrame writes one complete fixed-header frame.
func WriteFrame(writer io.Writer, frame Frame, limits Limits) error {
	if err := validateLimits(limits); err != nil {
		return err
	}
	if err := validateFrame(frame, limits); err != nil {
		return err
	}
	var header [HeaderSize]byte
	header[0] = Version
	header[1] = byte(frame.Kind)
	binary.BigEndian.PutUint32(header[2:6], frame.RequestID)
	binary.BigEndian.PutUint32(header[6:10], uint32(len(frame.Payload)))
	if err := writeAll(writer, header[:]); err != nil {
		return err
	}
	return writeAll(writer, frame.Payload)
}

// ReadFrame reads exactly one complete frame and rejects oversized lengths
// before allocating a payload buffer.
func ReadFrame(reader io.Reader, limits Limits) (Frame, error) {
	if err := validateLimits(limits); err != nil {
		return Frame{}, err
	}
	var header [HeaderSize]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return Frame{}, err
	}
	if header[0] != Version || !validKind(Kind(header[1])) {
		return Frame{}, fmt.Errorf("%w: version or kind", ErrInvalidFrame)
	}
	length := binary.BigEndian.Uint32(header[6:10])
	frame := Frame{Kind: Kind(header[1]), RequestID: binary.BigEndian.Uint32(header[2:6])}
	if length > limitFor(frame.Kind, limits) {
		return Frame{}, fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, length)
	}
	if length > 0 {
		frame.Payload = make([]byte, length)
		if _, err := io.ReadFull(reader, frame.Payload); err != nil {
			return Frame{}, err
		}
	}
	if err := validateFrame(frame, limits); err != nil {
		return Frame{}, err
	}
	return frame, nil
}

func validateLimits(limits Limits) error {
	if limits.MaxStreamBytes == 0 || limits.MaxStreamBytes > MaxStreamFrameBytes {
		return fmt.Errorf("%w: stream limit", ErrInvalidFrame)
	}
	return nil
}

func validateFrame(frame Frame, limits Limits) error {
	if !validKind(frame.Kind) || frame.RequestID == 0 {
		return fmt.Errorf("%w: kind or request ID", ErrInvalidFrame)
	}
	if uint64(len(frame.Payload)) > uint64(limitFor(frame.Kind, limits)) {
		return fmt.Errorf("%w: %d bytes", ErrFrameTooLarge, len(frame.Payload))
	}
	if frame.Kind == EndInput && len(frame.Payload) != 0 {
		return fmt.Errorf("%w: end-input payload", ErrInvalidFrame)
	}
	if frame.Kind == Exit && len(frame.Payload) != ExitStatusSize {
		return fmt.Errorf("%w: exit status payload", ErrInvalidFrame)
	}
	return nil
}

func limitFor(kind Kind, limits Limits) uint32 {
	switch kind {
	case ControlRequest, ControlResponse, Error:
		return limits.MaxControlBytes
	default:
		return limits.MaxStreamBytes
	}
}

func validKind(kind Kind) bool {
	return kind >= ControlRequest && kind <= Error
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) != 0 {
		written, err := writer.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}
