package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/config"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/github"
	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestAuditSinkWritesOneEscapedStructuredRecordPerRequest(t *testing.T) {
	var output bytes.Buffer
	NewAuditSink(&output).Record(AuditEvent{
		Operation:   protocol.PullRequestsCreate,
		RequestID:   73,
		Repository:  "acme/demo",
		Duration:    1500 * time.Millisecond,
		ExitStatus:  23,
		Refs:        []string{`feature"\topic`, "main"},
		StdinBytes:  81,
		StdoutBytes: 42,
		StderrBytes: 7,
	})

	record := output.String()
	if strings.Count(record, "\n") != 1 {
		t.Fatalf("audit records = %q, want exactly one line", record)
	}
	for _, required := range []string{
		`"operation":"pullRequests.create"`, `"request_id":"73"`, `"repository":"acme/demo"`,
		`"duration_ms":1500`, `"exit_status":23`, `"stdin_bytes":81`, `"stdout_bytes":42`, `"stderr_bytes":7`,
		`"refs":["feature\"\\topic","main"]`,
	} {
		if !strings.Contains(record, required) {
			t.Errorf("audit record %q lacks %q", record, required)
		}
	}
}

func TestAuditSinkWritesWholeJSONRecordsConcurrently(t *testing.T) {
	var output lockedAuditBuffer
	sink := NewAuditSink(&output)
	const records = 64
	var writers sync.WaitGroup
	for index := 0; index < records; index++ {
		writers.Add(1)
		go func(requestID uint32) {
			defer writers.Done()
			sink.Record(AuditEvent{
				Operation: protocol.RepositoryGet, RequestID: requestID,
				Repository: `acme/demo"\\\n`, Refs: []string{},
			})
		}(uint32(index + 1))
	}
	writers.Wait()

	scanner := bufio.NewScanner(strings.NewReader(output.String()))
	seen := make(map[uint32]bool, records)
	for scanner.Scan() {
		var record struct {
			Operation   string   `json:"operation"`
			RequestID   uint32   `json:"request_id,string"`
			Repository  string   `json:"repository"`
			DurationMS  int64    `json:"duration_ms"`
			ExitStatus  int      `json:"exit_status"`
			Refs        []string `json:"refs"`
			StdinBytes  int64    `json:"stdin_bytes"`
			StdoutBytes int64    `json:"stdout_bytes"`
			StderrBytes int64    `json:"stderr_bytes"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("invalid audit JSON %q: %v", scanner.Text(), err)
		}
		if record.Operation != string(protocol.RepositoryGet) || record.Repository != `acme/demo"\\\n` || record.Refs == nil {
			t.Fatalf("audit record = %+v", record)
		}
		seen[record.RequestID] = true
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if len(seen) != records {
		t.Fatalf("whole records=%d, want %d", len(seen), records)
	}
}

func TestAcceptedAPIAuditCoversSuccessFailureAndCancellation(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		caller := &fakeCaller{result: github.Result{Stdout: []byte(`{"name":"demo","owner":{"login":"acme"},"full_name":"acme/demo","description":null,"private":false,"default_branch":"main","html_url":"https://github.com/acme/demo"}`)}}
		server := newTestServer(t, caller, config.RepositoryRead)
		events := captureAudit(server)
		client, stop := startServer(t, server)
		defer stop()

		writeRequest(t, client, 71, protocol.RepositoryGet, `{}`)
		frames := readThroughExit(t, client)
		assertExitStatus(t, frames, 0)
		event := receiveAudit(t, events)
		if event.Operation != protocol.RepositoryGet || event.RequestID != 71 || event.Repository != "acme/demo" || event.ExitStatus != 0 || event.StdoutBytes == 0 {
			t.Fatalf("audit event = %+v", event)
		}
		assertNoAdditionalAudit(t, events)
	})

	t.Run("failure redacts body and escapes validated refs", func(t *testing.T) {
		caller := &fakeCaller{err: &github.CallerError{ExitStatus: 23}}
		server := newTestServer(t, caller, config.PullRequestsWrite)
		records := captureAuditRecords(server)
		client, stop := startServer(t, server)
		defer stop()

		const sentinel = "AUDIT_BODY_SECRET_SENTINEL"
		writeRequest(t, client, 72, protocol.PullRequestsCreate,
			`{"title":"title","head":"feature\"\\topic","base":"main","body":"`+sentinel+`","draft":false}`)
		frames := readThroughExit(t, client)
		assertExitStatus(t, frames, 23)
		assertClosedWithin(t, client, time.Second)

		record := records.receive(t)
		if strings.Count(record, "\n") != 1 {
			t.Fatalf("audit records = %q, want one", record)
		}
		if strings.Contains(record, sentinel) {
			t.Fatalf("audit leaked request body: %q", record)
		}
		for _, required := range []string{`"operation":"pullRequests.create"`, `"request_id":"72"`, `"repository":"acme/demo"`, `"exit_status":23`, `"refs":["feature\"\\topic","main"]`} {
			if !strings.Contains(record, required) {
				t.Errorf("audit record %q lacks %q", record, required)
			}
		}
	})

	t.Run("cancellation", func(t *testing.T) {
		caller := &fakeCaller{block: true, done: make(chan struct{})}
		server := newTestServer(t, caller, config.RepositoryRead)
		events := captureAudit(server)
		client, stop := startServer(t, server)
		defer stop()

		writeRequest(t, client, 74, protocol.RepositoryGet, `{}`)
		if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
			t.Fatalf("first frame = %#v", frame)
		}
		if err := client.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-caller.done:
		case <-time.After(time.Second):
			t.Fatal("API caller was not canceled")
		}
		event := receiveAudit(t, events)
		if event.RequestID != 74 || event.ExitStatus == 0 {
			t.Fatalf("audit event = %+v", event)
		}
		assertNoAdditionalAudit(t, events)
	})
}

func TestAcceptedGitAuditCountsStreamsWithoutLoggingContent(t *testing.T) {
	t.Setenv("GH_TOKEN", "AUTH_ENV_SECRET_SENTINEL")
	configureSSHHelper(t, "upload", nil)
	server := newGitServer(t, config.GitRead)
	records := captureAuditRecords(server)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 75, protocol.GitUploadPack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	const packSentinel = "PACK_SECRET_SENTINEL"
	writeDataChunks(t, client, 75, []byte(packSentinel))
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 75})
	frames := readThroughExit(t, client)
	assertExitStatus(t, frames, 0)
	assertClosedWithin(t, client, time.Second)

	record := records.receive(t)
	if strings.Count(record, "\n") != 1 {
		t.Fatalf("audit records = %q, want one", record)
	}
	for _, forbidden := range []string{packSentinel, "RAW-SECRET", "git-upload-pack", "git@github.com", "AUTH_ENV_SECRET_SENTINEL"} {
		if strings.Contains(record, forbidden) {
			t.Fatalf("audit leaked %q: %q", forbidden, record)
		}
	}
	for _, required := range []string{`"operation":"git.uploadPack"`, `"request_id":"75"`, `"repository":"acme/demo"`, `"exit_status":0`, `"stdin_bytes":20`, `"stdout_bytes":11`, `"stderr_bytes":34`} {
		if !strings.Contains(record, required) {
			t.Errorf("audit record %q lacks %q", record, required)
		}
	}
}

func TestAcceptedReceivePackAuditIncludesValidatedRefsWithoutPack(t *testing.T) {
	advertisement := advertised("refs/heads/main", "report-status")
	configureSSHHelper(t, "receive", advertisement)
	server := newGitServer(t, config.GitRead, config.GitWrite)
	records := captureAuditRecords(server)
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 77, protocol.GitReceivePack, `{}`)
	if frame := readFrame(t, client); frame.Kind != protocol.ControlResponse {
		t.Fatalf("first frame = %#v", frame)
	}
	_ = readStdoutBytes(t, client, len(advertisement))
	prefix := append(pkt(oldOID+" "+newOID+" refs/heads/feature\x00report-status"), []byte("0000")...)
	const packSentinel = "PACK_AUDIT_SECRET_SENTINEL"
	writeDataChunks(t, client, 77, append(prefix, []byte(packSentinel)...))
	writeFrame(t, client, protocol.Frame{Kind: protocol.EndInput, RequestID: 77})
	assertExitStatus(t, readThroughExit(t, client), 0)
	assertClosedWithin(t, client, time.Second)

	record := records.receive(t)
	if strings.Count(record, "\n") != 1 || !strings.Contains(record, `"refs":["refs/heads/feature"]`) {
		t.Fatalf("receive-pack audit record = %q", record)
	}
	if strings.Contains(record, packSentinel) {
		t.Fatalf("audit leaked pack bytes: %q", record)
	}
}

func TestAuditSinkWriteFailureDoesNotChangeAcceptedRequest(t *testing.T) {
	caller := &fakeCaller{result: github.Result{Stdout: []byte(`{"name":"demo","owner":{"login":"acme"},"full_name":"acme/demo","description":null,"private":false,"default_branch":"main","html_url":"https://github.com/acme/demo"}`)}}
	server := newTestServer(t, caller, config.RepositoryRead)
	server.audit = NewAuditSink(errorWriter{}).Record
	client, stop := startServer(t, server)
	defer stop()

	writeRequest(t, client, 76, protocol.RepositoryGet, `{}`)
	assertExitStatus(t, readThroughExit(t, client), 0)
}

type lockedAuditBuffer struct {
	mu     sync.Mutex
	output bytes.Buffer
}

func (buffer *lockedAuditBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.output.Write(data)
}

func (buffer *lockedAuditBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.output.String()
}

type errorWriter struct{}

func (errorWriter) Write([]byte) (int, error) { return 0, errors.New("audit unavailable") }

type auditRecordCapture struct {
	mu       sync.Mutex
	output   bytes.Buffer
	recorded chan struct{}
}

func captureAuditRecords(server *Server) *auditRecordCapture {
	records := &auditRecordCapture{recorded: make(chan struct{}, 2)}
	sink := NewAuditSink(records)
	server.audit = func(event AuditEvent) {
		sink.Record(event)
		records.recorded <- struct{}{}
	}
	return records
}

func (records *auditRecordCapture) Write(data []byte) (int, error) {
	records.mu.Lock()
	defer records.mu.Unlock()
	return records.output.Write(data)
}

func (records *auditRecordCapture) receive(t *testing.T) string {
	t.Helper()
	select {
	case <-records.recorded:
		records.mu.Lock()
		defer records.mu.Unlock()
		return records.output.String()
	case <-time.After(time.Second):
		t.Fatal("audit record not written")
		return ""
	}
}

func captureAudit(server *Server) <-chan AuditEvent {
	events := make(chan AuditEvent, 2)
	server.audit = func(event AuditEvent) { events <- event }
	return events
}

func receiveAudit(t *testing.T, events <-chan AuditEvent) AuditEvent {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(time.Second):
		t.Fatal("audit event not recorded")
		return AuditEvent{}
	}
}

func assertNoAdditionalAudit(t *testing.T, events <-chan AuditEvent) {
	t.Helper()
	select {
	case event := <-events:
		t.Fatalf("duplicate audit event: %+v", event)
	case <-time.After(20 * time.Millisecond):
	}
}

func assertExitStatus(t *testing.T, frames []protocol.Frame, want int32) {
	t.Helper()
	if len(frames) == 0 || frames[len(frames)-1].Kind != protocol.Exit {
		t.Fatalf("frames = %#v, want terminal exit", frames)
	}
	status, err := protocol.DecodeExitStatus(frames[len(frames)-1])
	if err != nil || status != want {
		t.Fatalf("exit status = %d, %v; want %d", status, err, want)
	}
}
