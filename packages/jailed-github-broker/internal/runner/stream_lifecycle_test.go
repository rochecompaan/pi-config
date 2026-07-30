package runner

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"
)

type blockingReadCloser struct {
	closed chan struct{}
	once   sync.Once
}

func (reader *blockingReadCloser) Read([]byte) (int, error) {
	<-reader.closed
	return 0, io.EOF
}

func (reader *blockingReadCloser) Close() error {
	reader.once.Do(func() { close(reader.closed) })
	return nil
}

func TestStreamDoesNotWaitOnClientInputAfterChildExit(t *testing.T) {
	runner := newTestRunner(t, nil)
	input := &blockingReadCloser{closed: make(chan struct{})}
	done := make(chan StreamResult, 1)
	go func() {
		done <- runner.Stream(context.Background(), StreamCall{
			Args: helperArgs("failure", "raw secret"), Stdin: input,
			Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		})
	}()
	select {
	case result := <-done:
		if result.ExitStatus != 23 {
			t.Fatalf("result = %#v", result)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("Stream waited indefinitely for client input after child exit")
	}
	select {
	case <-input.closed:
	default:
		t.Fatal("Stream did not close the input source")
	}
}
