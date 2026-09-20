package ipc

import (
	"encoding/json"
	"testing"
	"time"
)

// TestOpenActionRoundTrip pins the wire format of the "open" handoff: the absolute path must
// survive JSON encoding in its own field, and must not be confused with Content (which the
// "pipe" action uses for scrap text).
func TestOpenActionRoundTrip(t *testing.T) {
	original := &Message{
		Action:    ActionOpen,
		Path:      "/Users/someone/Documents/notes/日本語 メモ.md",
		Timestamp: time.Now().Format(time.RFC3339),
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var decoded Message
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if decoded.Action != ActionOpen {
		t.Errorf("action = %q, want %q", decoded.Action, ActionOpen)
	}
	if decoded.Path != original.Path {
		t.Errorf("path = %q, want %q", decoded.Path, original.Path)
	}
	if decoded.Content != "" {
		t.Errorf("content = %q, want empty for an open message", decoded.Content)
	}
}

// TestPathIsOmittedWhenEmpty keeps "pipe"/"activate" messages byte-identical to what older
// builds sent, so a new CLI talking to an older running instance changes nothing.
func TestPathIsOmittedWhenEmpty(t *testing.T) {
	data, err := json.Marshal(&Message{Action: ActionActivate})
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if _, present := raw["path"]; present {
		t.Errorf("activate message carries a %q key: %s", "path", data)
	}
}

// TestSendOpenIsAcknowledged proves the new action goes through the same ack handshake as the
// existing ones, which is what lets main treat a successful Send as "the running instance has
// it, this process may exit".
func TestSendOpenIsAcknowledged(t *testing.T) {
	received := make(chan *Message, 1)
	srv, err := StartServer(0, nil, func(msg *Message) {
		received <- msg
	})
	if err != nil {
		t.Fatalf("StartServer failed: %v", err)
	}
	defer srv.Close()

	const wantPath = "/tmp/md-memo-open-test.md"
	if err := Send(srv.Port(), &Message{Action: ActionOpen, Path: wantPath}, 2*time.Second); err != nil {
		t.Fatalf("Send(open) failed: %v", err)
	}

	select {
	case got := <-received:
		if got.Action != ActionOpen {
			t.Errorf("handler saw action %q, want %q", got.Action, ActionOpen)
		}
		if got.Path != wantPath {
			t.Errorf("handler saw path %q, want %q", got.Path, wantPath)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("legacy handler was never invoked for an open message")
	}
}

// TestActionConstantsMatchTheWireStrings guards against someone renaming a constant and
// silently breaking older CLIs that still send the literal strings.
func TestActionConstantsMatchTheWireStrings(t *testing.T) {
	if ActionPipe != "pipe" || ActionActivate != "activate" || ActionOpen != "open" {
		t.Fatalf("action constants drifted: pipe=%q activate=%q open=%q", ActionPipe, ActionActivate, ActionOpen)
	}
}
