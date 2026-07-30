package server

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

const (
	inputQueueByteCapacity  uint64 = 256 * 1024
	inputQueueFrameCapacity        = 256
)

var errInputQueueSaturated = errors.New("git input queue saturated")

// inputPump is the sole reader of client stream frames. Its queue holds at
// most 256 KiB (or one configured maximum-sized frame) and 256 frames.
type inputPump struct {
	conn     net.Conn
	limits   protocol.Limits
	session  *sessionGuard
	cancel   context.CancelFunc
	queue    *boundedInputQueue
	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
	bytes    atomic.Int64
}

func newInputPump(ctx context.Context, conn net.Conn, limits protocol.Limits, session *sessionGuard, cancel context.CancelFunc) *inputPump {
	pump := &inputPump{
		conn: conn, limits: limits, session: session, cancel: cancel,
		queue: newBoundedInputQueue(inputQueueBytes(limits.MaxStreamBytes)),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
	}
	stopContext := context.AfterFunc(ctx, pump.stopReading)
	go func() {
		pump.run(ctx)
		stopContext()
	}()
	return pump
}

func inputQueueBytes(maxStreamBytes uint32) uint64 {
	if uint64(maxStreamBytes) > inputQueueByteCapacity {
		return uint64(maxStreamBytes)
	}
	return inputQueueByteCapacity
}

func (pump *inputPump) Read(destination []byte) (int, error) {
	return pump.queue.Read(destination)
}

func (pump *inputPump) Count() int64 {
	return pump.bytes.Load()
}

func (pump *inputPump) Close() error {
	pump.stopReading()
	<-pump.done
	return nil
}

func (pump *inputPump) stopReading() {
	pump.stopOnce.Do(func() {
		close(pump.stop)
		_ = pump.conn.SetReadDeadline(time.Now())
	})
}

func (pump *inputPump) run(ctx context.Context) {
	defer close(pump.done)
	for {
		select {
		case <-pump.stop:
			pump.queue.finish(ctx.Err())
			return
		default:
		}
		frame, err := protocol.ReadFrame(pump.conn, pump.limits)
		if err != nil {
			if ctx.Err() != nil || pump.stopped() {
				pump.queue.finish(ctx.Err())
				return
			}
			pump.fail(err)
			return
		}
		if err := pump.session.accept(protocol.ClientToServer, frame); err != nil {
			pump.fail(err)
			return
		}
		switch frame.Kind {
		case protocol.StdinData:
			pump.bytes.Add(int64(len(frame.Payload)))
			if len(frame.Payload) == 0 {
				continue
			}
			if err := pump.queue.push(frame.Payload); err != nil {
				pump.fail(err)
				return
			}
		case protocol.EndInput:
			pump.queue.finish(nil)
		default:
			pump.fail(protocol.ErrInvalidState)
			return
		}
	}
}

func (pump *inputPump) stopped() bool {
	select {
	case <-pump.stop:
		return true
	default:
		return false
	}
}

func (pump *inputPump) fail(err error) {
	pump.queue.finish(err)
	pump.cancel()
}

type boundedInputQueue struct {
	mu       sync.Mutex
	frames   [][]byte
	queued   uint64
	maxBytes uint64
	finished bool
	terminal error
	ready    chan struct{}
	current  []byte
}

func newBoundedInputQueue(maxBytes uint64) *boundedInputQueue {
	return &boundedInputQueue{maxBytes: maxBytes, ready: make(chan struct{}, 1)}
}

func (queue *boundedInputQueue) push(payload []byte) error {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.finished || len(queue.frames) >= inputQueueFrameCapacity || queue.queued+uint64(len(payload)) > queue.maxBytes {
		return errInputQueueSaturated
	}
	queue.frames = append(queue.frames, payload)
	queue.queued += uint64(len(payload))
	queue.notify()
	return nil
}

func (queue *boundedInputQueue) finish(err error) {
	queue.mu.Lock()
	if !queue.finished {
		queue.finished = true
		queue.terminal = err
	}
	queue.notify()
	queue.mu.Unlock()
}

func (queue *boundedInputQueue) Read(destination []byte) (int, error) {
	if len(destination) == 0 {
		return 0, nil
	}
	for len(queue.current) == 0 {
		queue.mu.Lock()
		if len(queue.frames) != 0 {
			queue.current = queue.frames[0]
			queue.frames[0] = nil
			queue.frames = queue.frames[1:]
			queue.queued -= uint64(len(queue.current))
			queue.mu.Unlock()
			break
		}
		if queue.finished {
			err := queue.terminal
			queue.mu.Unlock()
			if err == nil {
				err = io.EOF
			}
			return 0, err
		}
		queue.mu.Unlock()
		<-queue.ready
	}
	count := copy(destination, queue.current)
	queue.current = queue.current[count:]
	return count, nil
}

func (queue *boundedInputQueue) notify() {
	select {
	case queue.ready <- struct{}{}:
	default:
	}
}
