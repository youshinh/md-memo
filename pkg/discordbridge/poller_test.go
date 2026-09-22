package discordbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeDiscord serves just enough of the Discord REST surface for the poller: token check, DM
// channel creation, and a message feed the test can append to at will.
type fakeDiscord struct {
	mu       sync.Mutex
	messages []Message
	token    string
	unauthed bool
}

func newFakeDiscord(token string) *fakeDiscord {
	return &fakeDiscord{token: token}
}

func (f *fakeDiscord) push(id, authorID, content string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages = append(f.messages, Message{ID: id, Content: content, Author: struct {
		ID string `json:"id"`
	}{ID: authorID}})
}

func (f *fakeDiscord) server() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/users/@me", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		unauthed := f.unauthed
		f.mu.Unlock()
		if unauthed || r.Header.Get("Authorization") != "Bot "+f.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(Self{ID: "bot-1", Username: "md-memo-bot"})
	})
	mux.HandleFunc("/users/@me/channels", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "chan-1"})
	})
	mux.HandleFunc("/channels/chan-1/messages", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		after := r.URL.Query().Get("after")
		var out []Message
		if after == "" {
			if len(f.messages) > 0 {
				out = []Message{f.messages[len(f.messages)-1]}
			}
		} else {
			var passed bool
			for _, m := range f.messages {
				if passed {
					out = append(out, m)
				}
				if m.ID == after {
					passed = true
				}
			}
			// Discord returns newest-first; reverse to match that shape (Client reverses back).
			for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
				out[i], out[j] = out[j], out[i]
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	return httptest.NewServer(mux)
}

func withFastPolling(t *testing.T) {
	t.Helper()
	prevMin := minIntervalSeconds
	minIntervalSeconds = 0
	t.Cleanup(func() { minIntervalSeconds = prevMin })
}

func TestPoller_FirstRunBaselinesWithoutDeliveringHistory(t *testing.T) {
	withFastPolling(t)
	fake := newFakeDiscord("good-token")
	fake.push("100", "710512141975556166", "sent before the bridge was ever enabled")
	srv := fake.server()
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "state.json")
	var mu sync.Mutex
	var delivered []Message
	p := NewPoller(Config{
		BotToken: "good-token", AllowedUserID: "710512141975556166", IntervalSeconds: 1,
		BaseURL: srv.URL, StatePath: statePath,
		OnMessage: func(m Message) { mu.Lock(); delivered = append(delivered, m); mu.Unlock() },
	})
	p.Start(context.Background())
	defer p.Stop()

	waitFor(t, 2*time.Second, func() bool {
		_, err := os.Stat(statePath)
		return err == nil
	})

	mu.Lock()
	defer mu.Unlock()
	if len(delivered) != 0 {
		t.Errorf("first run must not replay pre-existing history, got %+v", delivered)
	}
	if got := loadLastMessageID(statePath); got != "100" {
		t.Errorf("expected baseline cursor 100, got %q", got)
	}
}

func TestPoller_DeliversNewMessagesFromAllowedUserOnly(t *testing.T) {
	withFastPolling(t)
	fake := newFakeDiscord("good-token")
	fake.push("100", "710512141975556166", "old, becomes the baseline")
	srv := fake.server()
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "state.json")
	var mu sync.Mutex
	var delivered []Message
	p := NewPoller(Config{
		BotToken: "good-token", AllowedUserID: "710512141975556166", IntervalSeconds: 1,
		BaseURL: srv.URL, StatePath: statePath,
		OnMessage: func(m Message) { mu.Lock(); delivered = append(delivered, m); mu.Unlock() },
	})
	p.Start(context.Background())
	defer p.Stop()

	waitFor(t, 2*time.Second, func() bool { return loadLastMessageID(statePath) == "100" })

	fake.push("101", "someone-else", "an impostor DMing the bot must be ignored")
	fake.push("102", "710512141975556166", "hello from my phone")

	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(delivered) == 1
	})

	mu.Lock()
	defer mu.Unlock()
	if len(delivered) != 1 || delivered[0].ID != "102" || delivered[0].Content != "hello from my phone" {
		t.Errorf("expected exactly the one message from the allowed user, got %+v", delivered)
	}
}

func TestPoller_PanicInOnMessageIsReportedNotFatal(t *testing.T) {
	withFastPolling(t)
	fake := newFakeDiscord("good-token")
	fake.push("100", "710512141975556166", "baseline")
	srv := fake.server()
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "state.json")
	var mu sync.Mutex
	var statuses []string
	p := NewPoller(Config{
		BotToken: "good-token", AllowedUserID: "710512141975556166", IntervalSeconds: 1,
		BaseURL: srv.URL, StatePath: statePath,
		OnMessage: func(m Message) { panic("boom") },
		OnStatus:  func(status, message string) { mu.Lock(); statuses = append(statuses, status); mu.Unlock() },
	})
	p.Start(context.Background())
	defer p.Stop()

	waitFor(t, 2*time.Second, func() bool { return loadLastMessageID(statePath) == "100" })
	fake.push("101", "710512141975556166", "this delivery panics")

	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		for _, s := range statuses {
			if s == "error" {
				return true
			}
		}
		return false
	})
}

func TestPoller_StopIsPromptEvenDuringConnectRetryBackoff(t *testing.T) {
	fake := newFakeDiscord("good-token")
	fake.unauthed = true
	srv := fake.server()
	defer srv.Close()

	p := NewPoller(Config{
		BotToken: "wrong-token", AllowedUserID: "710512141975556166", IntervalSeconds: 1,
		BaseURL: srv.URL, StatePath: filepath.Join(t.TempDir(), "state.json"),
	})
	p.Start(context.Background())

	done := make(chan struct{})
	go func() { p.Stop(); close(done) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() must not wait out the multi-second reconnect backoff")
	}
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !cond() {
		t.Fatalf("condition not met within %v", timeout)
	}
}
