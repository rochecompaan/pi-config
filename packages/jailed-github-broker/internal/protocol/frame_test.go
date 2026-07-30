package protocol

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadFrameHandlesOneByteFragments(t *testing.T) {
	want := Frame{Kind: StdoutData, RequestID: 7, Payload: []byte("result")}
	var encoded bytes.Buffer
	if err := WriteFrame(&encoded, want, DefaultLimits()); err != nil {
		t.Fatal(err)
	}

	got, err := ReadFrame(oneByteReader{Reader: bytes.NewReader(encoded.Bytes())}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != want.Kind || got.RequestID != want.RequestID || !bytes.Equal(got.Payload, want.Payload) {
		t.Fatalf("ReadFrame() = %#v, want %#v", got, want)
	}
}

func TestReadFrameHandlesCoalescedFrames(t *testing.T) {
	var encoded bytes.Buffer
	limits := DefaultLimits()
	for _, frame := range []Frame{{Kind: StdinData, RequestID: 3, Payload: []byte("a")}, {Kind: EndInput, RequestID: 3}} {
		if err := WriteFrame(&encoded, frame, limits); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []Kind{StdinData, EndInput} {
		got, err := ReadFrame(&encoded, limits)
		if err != nil || got.Kind != want {
			t.Fatalf("ReadFrame() = %#v, %v; want kind %v", got, err, want)
		}
	}
}

func TestReadFrameRejectsUnknownVersionAndKind(t *testing.T) {
	for _, raw := range [][]byte{
		{2, byte(ControlRequest), 0, 0, 0, 1, 0, 0, 0, 0},
		{Version, 255, 0, 0, 0, 1, 0, 0, 0, 0},
	} {
		_, err := ReadFrame(bytes.NewReader(raw), DefaultLimits())
		if !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("ReadFrame(%x) error = %v, want ErrInvalidFrame", raw, err)
		}
	}
}

func TestProtocolEnforcesPracticalStreamLimitBeforeIO(t *testing.T) {
	for _, maxStreamBytes := range []uint32{MaxStreamFrameBytes - 1, MaxStreamFrameBytes} {
		limits := Limits{MaxControlBytes: 1_048_576, MaxStreamBytes: maxStreamBytes}
		if err := WriteFrame(io.Discard, Frame{Kind: EndInput, RequestID: 1}, limits); err != nil {
			t.Errorf("WriteFrame() rejected safe stream limit %d: %v", maxStreamBytes, err)
		}
	}
	for _, maxStreamBytes := range []uint32{MaxStreamFrameBytes + 1, ^uint32(0)} {
		limits := Limits{MaxControlBytes: 1_048_576, MaxStreamBytes: maxStreamBytes}
		if err := WriteFrame(io.Discard, Frame{Kind: EndInput, RequestID: 1}, limits); !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("WriteFrame() stream limit %d error = %v, want ErrInvalidFrame", maxStreamBytes, err)
		}
		reader := &countingReader{}
		if _, err := ReadFrame(reader, limits); !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("ReadFrame() stream limit %d error = %v, want ErrInvalidFrame", maxStreamBytes, err)
		}
		if reader.reads != 0 {
			t.Errorf("ReadFrame() performed %d reads with unsafe allocation authority %d", reader.reads, maxStreamBytes)
		}
	}
}

func TestReadFrameRejectsOversizedLengthBeforeAllocation(t *testing.T) {
	for _, test := range []struct {
		name   string
		kind   Kind
		limits Limits
	}{
		{"stream", StdoutData, Limits{MaxControlBytes: 16, MaxStreamBytes: 3}},
		{"control", ControlRequest, Limits{MaxControlBytes: 3, MaxStreamBytes: 16}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := []byte{Version, byte(test.kind), 0, 0, 0, 1, 0, 0, 0, 4}
			_, err := ReadFrame(bytes.NewReader(raw), test.limits)
			if !errors.Is(err, ErrFrameTooLarge) {
				t.Fatalf("ReadFrame() error = %v, want ErrFrameTooLarge", err)
			}
		})
	}
}

func TestExitStatusUsesFixedWidthSignedPayload(t *testing.T) {
	frame := ExitFrame(7, -42)
	if len(frame.Payload) != ExitStatusSize {
		t.Fatalf("exit payload length = %d, want %d", len(frame.Payload), ExitStatusSize)
	}
	status, err := DecodeExitStatus(frame)
	if err != nil || status != -42 {
		t.Fatalf("DecodeExitStatus() = %d, %v", status, err)
	}
	var wire bytes.Buffer
	if err := WriteFrame(&wire, frame, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	decoded, err := ReadFrame(&wire, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if status, err := DecodeExitStatus(decoded); err != nil || status != -42 {
		t.Fatalf("wire DecodeExitStatus() = %d, %v", status, err)
	}
	for _, payload := range [][]byte{nil, {0, 0, 0}, {0, 0, 0, 0, 0}} {
		invalid := Frame{Kind: Exit, RequestID: 7, Payload: payload}
		_, err := DecodeExitStatus(invalid)
		if !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("DecodeExitStatus(%x) error = %v, want ErrInvalidFrame", payload, err)
		}
		if err := WriteFrame(io.Discard, invalid, DefaultLimits()); !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("WriteFrame(%x) error = %v, want ErrInvalidFrame", payload, err)
		}
		raw := []byte{Version, byte(Exit), 0, 0, 0, 7, 0, 0, 0, byte(len(payload))}
		raw = append(raw, payload...)
		if _, err := ReadFrame(bytes.NewReader(raw), DefaultLimits()); !errors.Is(err, ErrInvalidFrame) {
			t.Fatalf("ReadFrame(%x) error = %v, want ErrInvalidFrame", payload, err)
		}
	}
}

func TestFrameUsesDistinctControlAndStreamLimits(t *testing.T) {
	limits := Limits{MaxControlBytes: 2, MaxStreamBytes: 4}
	for _, frame := range []Frame{
		{Kind: ControlResponse, RequestID: 1, Payload: []byte("ok")},
		{Kind: StdoutData, RequestID: 1, Payload: []byte("four")},
	} {
		var wire bytes.Buffer
		if err := WriteFrame(&wire, frame, limits); err != nil {
			t.Fatalf("WriteFrame(%v) error = %v", frame.Kind, err)
		}
		got, err := ReadFrame(&wire, limits)
		if err != nil || !bytes.Equal(got.Payload, frame.Payload) {
			t.Fatalf("ReadFrame(%v) = %#v, %v", frame.Kind, got, err)
		}
	}
	if err := WriteFrame(io.Discard, Frame{Kind: ControlResponse, RequestID: 1, Payload: []byte("abc")}, limits); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("control error = %v, want ErrFrameTooLarge", err)
	}
}

func TestReadFrameRejectsShortHeaderAndPayload(t *testing.T) {
	_, err := ReadFrame(strings.NewReader("\x01"), DefaultLimits())
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short header error = %v", err)
	}

	var encoded bytes.Buffer
	if err := WriteFrame(&encoded, Frame{Kind: StdoutData, RequestID: 1, Payload: []byte("body")}, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	_, err = ReadFrame(bytes.NewReader(encoded.Bytes()[:HeaderSize+2]), DefaultLimits())
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("short payload error = %v", err)
	}
}

type countingReader struct {
	reads int
}

func (reader *countingReader) Read([]byte) (int, error) {
	reader.reads++
	return 0, io.EOF
}

type oneByteReader struct{ io.Reader }

func (r oneByteReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	return r.Reader.Read(p)
}
