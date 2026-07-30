package protocol

import (
	"bytes"
	"io"
	"testing"
)

func TestWriteStdoutFromRejectsUnsafeLimitBeforeReading(t *testing.T) {
	reader := &countingReader{}
	err := WriteStdoutFrom(io.Discard, reader, 11, Limits{MaxControlBytes: 1_048_576, MaxStreamBytes: MaxStreamFrameBytes + 1})
	if err == nil {
		t.Fatal("WriteStdoutFrom() accepted unsafe stream limit")
	}
	if reader.reads != 0 {
		t.Fatalf("WriteStdoutFrom() performed %d reads with unsafe allocation authority", reader.reads)
	}
}

func TestWriteStdoutFromChunksWithoutResponseBuffering(t *testing.T) {
	limits := Limits{MaxControlBytes: 5, MaxStreamBytes: 4}
	input := bytes.Repeat([]byte("x"), 14) // Larger than both control and stream limits.
	reader := maxReadReader{Reader: bytes.NewReader(input), max: int(limits.MaxStreamBytes)}
	var wire bytes.Buffer

	if err := WriteStdoutFrom(&wire, reader, 11, limits); err != nil {
		t.Fatal(err)
	}

	var got []byte
	var sizes []int
	for wire.Len() > 0 {
		frame, err := ReadFrame(&wire, limits)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Kind != StdoutData || frame.RequestID != 11 {
			t.Fatalf("frame = %#v", frame)
		}
		if len(frame.Payload) > int(limits.MaxStreamBytes) {
			t.Fatalf("chunk = %d bytes", len(frame.Payload))
		}
		sizes = append(sizes, len(frame.Payload))
		got = append(got, frame.Payload...)
	}
	if !bytes.Equal(got, input) {
		t.Fatalf("streamed bytes = %q, want %q", got, input)
	}
	if want := []int{4, 4, 4, 2}; !equalInts(sizes, want) {
		t.Fatalf("chunk sizes = %v, want %v", sizes, want)
	}
}

type maxReadReader struct {
	io.Reader
	max int
}

func (r maxReadReader) Read(p []byte) (int, error) {
	if len(p) > r.max {
		return 0, io.ErrShortBuffer
	}
	return r.Reader.Read(p)
}

func equalInts(left, right []int) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
