package client

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/rochecompaan/roche-pi/jailed-github-broker/internal/protocol"
)

func TestFormatNormalizedJSON(t *testing.T) {
	input := []byte(`[{"number":1,"title":"one","state":"open"},{"number":2,"title":"two","state":"closed"}]`)
	tests := []struct {
		name   string
		fields []string
		jq     string
		want   string
	}{
		{"unchanged plus newline", nil, "", string(input) + "\n"},
		{"field selection", []string{"number", "title"}, "", `[{"number":1,"title":"one"},{"number":2,"title":"two"}]` + "\n"},
		{"identity", []string{"title"}, ".", `[{"title":"one"},{"title":"two"}]` + "\n"},
		{"array field compact", []string{"title"}, ".[].title", "one\ntwo\n"},
		{"array field spaced", []string{"title"}, ".[] | .title", "one\ntwo\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := Request{Operation: protocol.IssuesList, Fields: test.fields, JQ: test.jq}
			got, err := Format(request, input)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.want {
				t.Fatalf("got %q want %q", got, test.want)
			}
		})
	}
}

func TestFormatObjectFieldAndJSONValues(t *testing.T) {
	request := Request{Operation: protocol.IssuesGet, Fields: []string{"title", "labels", "body"}, JQ: ".labels"}
	got, err := Format(request, []byte(`{"title":"hello","labels":["bug"],"body":null,"ignored":"drop"}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `["bug"]`+"\n" {
		t.Fatalf("got %q", got)
	}
}

func TestFormatFailsClosed(t *testing.T) {
	tests := []struct {
		request Request
		input   []byte
	}{
		{Request{Operation: protocol.IssuesGet}, []byte(`{"number":1} trailing`)},
		{Request{Operation: protocol.IssuesGet, Fields: []string{"title"}}, []byte(`[]`)},
		{Request{Operation: protocol.IssuesGet, Fields: []string{"title"}, JQ: ".title"}, []byte(`{"number":1}`)},
		{Request{Operation: protocol.IssuesList, Fields: []string{"title"}, JQ: ".[0]"}, []byte(`[]`)},
	}
	for _, test := range tests {
		if got, err := Format(test.request, test.input); err == nil {
			t.Fatalf("accepted %q -> %q", test.input, got)
		}
	}
}

func TestFormatBoundsJQOutput(t *testing.T) {
	large := bytes.Repeat([]byte("a"), maxFormattedBytes)
	encoded, _ := json.Marshal(map[string]any{"title": string(large)})
	request := Request{Operation: protocol.IssuesGet, Fields: []string{"title"}, JQ: ".title"}
	if _, err := Format(request, encoded); err == nil {
		t.Fatal("accepted over-limit formatted output")
	}
}
