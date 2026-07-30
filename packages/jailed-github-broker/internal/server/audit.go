package server

import (
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

// AuditEvent contains only validated request metadata and byte counts.
type AuditEvent struct {
	Operation                            protocol.Operation
	RequestID                            uint32
	Repository                           string
	Duration                             time.Duration
	ExitStatus                           int
	Refs                                 []string
	StdinBytes, StdoutBytes, StderrBytes int64
}

// AuditSink serializes bounded single-line records to a host-owned writer.
type AuditSink struct {
	writer io.Writer
	mu     sync.Mutex
}

// NewAuditSink creates the production host-side audit sink used by serve.
func NewAuditSink(writer io.Writer) *AuditSink {
	return &AuditSink{writer: writer}
}

// Record writes exactly one bounded record for an accepted request. Sink
// failures are deliberately isolated from the protocol.
func (sink *AuditSink) Record(event AuditEvent) {
	if sink == nil || sink.writer == nil {
		return
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	record, err := event.record()
	if err != nil {
		return
	}
	record = append(record, '\n')
	_, _ = sink.writer.Write(record)
}

func (event AuditEvent) record() ([]byte, error) {
	return json.Marshal(struct {
		Operation   protocol.Operation `json:"operation"`
		RequestID   uint32             `json:"request_id,string"`
		Repository  string             `json:"repository"`
		DurationMS  int64              `json:"duration_ms"`
		ExitStatus  int                `json:"exit_status"`
		Refs        []string           `json:"refs"`
		StdinBytes  int64              `json:"stdin_bytes"`
		StdoutBytes int64              `json:"stdout_bytes"`
		StderrBytes int64              `json:"stderr_bytes"`
	}{
		Operation: event.Operation, RequestID: event.RequestID,
		Repository: event.Repository, DurationMS: event.Duration.Milliseconds(),
		ExitStatus: event.ExitStatus, Refs: append([]string{}, event.Refs...),
		StdinBytes: event.StdinBytes, StdoutBytes: event.StdoutBytes,
		StderrBytes: event.StderrBytes,
	})
}
