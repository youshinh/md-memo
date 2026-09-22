package discordbridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVerifyToken_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bot good-token" {
			t.Errorf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/users/@me" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(Self{ID: "42", Username: "md-memo-bot"})
	}))
	defer srv.Close()

	c := &Client{Token: "good-token", HTTPClient: srv.Client(), BaseURL: srv.URL}
	self, err := c.VerifyToken(context.Background())
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if self.ID != "42" || self.Username != "md-memo-bot" {
		t.Errorf("unexpected self: %+v", self)
	}
}

func TestVerifyToken_BadToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := &Client{Token: "bad-token", HTTPClient: srv.Client(), BaseURL: srv.URL}
	if _, err := c.VerifyToken(context.Background()); err == nil {
		t.Fatal("expected an error for a 401 response")
	}
}

func TestEnsureDMChannel_ReturnsChannelID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/users/@me/channels" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["recipient_id"] != "710512141975556166" {
			t.Errorf("unexpected recipient_id: %v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "chan-1"})
	}))
	defer srv.Close()

	c := &Client{Token: "t", HTTPClient: srv.Client(), BaseURL: srv.URL}
	id, err := c.EnsureDMChannel(context.Background(), "710512141975556166")
	if err != nil {
		t.Fatalf("EnsureDMChannel: %v", err)
	}
	if id != "chan-1" {
		t.Errorf("got channel id %q, want chan-1", id)
	}
}

// A username typed into the "Discord User ID" field (the most common setup mistake, since it
// looks like a plausible answer) must fail with a clear, actionable message instead of Discord's
// generic 400 - and must not even reach the network, so the settings-screen Test Connection
// button reports it in well under a second.
func TestEnsureDMChannel_RejectsAUsernameInsteadOfTheNumericID(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := &Client{Token: "t", HTTPClient: srv.Client(), BaseURL: srv.URL}
	_, err := c.EnsureDMChannel(context.Background(), "yoshin9087")
	if err == nil {
		t.Fatal("expected an error for a username-shaped id")
	}
	if !strings.Contains(err.Error(), "ユーザーIDをコピー") {
		t.Errorf("expected guidance on finding the real numeric id, got: %v", err)
	}
	if called {
		t.Error("a malformed id must be rejected locally, without calling the Discord API")
	}
}

func TestIsSnowflake(t *testing.T) {
	cases := map[string]bool{
		"710512141975556166": true,
		"999":                false, // too short to be a real snowflake
		"yoshin9087":         false,
		"":                   false,
		"12345678901234567a": false,
	}
	for id, want := range cases {
		if got := isSnowflake(id); got != want {
			t.Errorf("isSnowflake(%q) = %v, want %v", id, got, want)
		}
	}
}

func TestFetchMessagesAfter_ReversesToChronologicalOrder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("after"); got != "100" {
			t.Errorf("unexpected after= %q", got)
		}
		// Discord returns newest-first.
		msgs := []Message{{ID: "300", Content: "third"}, {ID: "200", Content: "second"}}
		_ = json.NewEncoder(w).Encode(msgs)
	}))
	defer srv.Close()

	c := &Client{Token: "t", HTTPClient: srv.Client(), BaseURL: srv.URL}
	msgs, err := c.FetchMessagesAfter(context.Background(), "chan-1", "100", 50)
	if err != nil {
		t.Fatalf("FetchMessagesAfter: %v", err)
	}
	if len(msgs) != 2 || msgs[0].ID != "200" || msgs[1].ID != "300" {
		t.Errorf("expected chronological [200, 300], got %+v", msgs)
	}
}

func TestFetchMessagesAfter_RateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "2.5")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()

	c := &Client{Token: "t", HTTPClient: srv.Client(), BaseURL: srv.URL}
	_, err := c.FetchMessagesAfter(context.Background(), "chan-1", "", 50)
	rl, ok := err.(*RateLimitError)
	if !ok {
		t.Fatalf("expected *RateLimitError, got %T (%v)", err, err)
	}
	if rl.Wait().Seconds() != 2.5 {
		t.Errorf("Wait() = %v, want 2.5s", rl.Wait())
	}
}

func TestDownloadAttachment_RejectsOversized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 100))
	}))
	defer srv.Close()

	if _, err := DownloadAttachment(context.Background(), srv.URL, 10); err == nil {
		t.Fatal("expected an error for a response larger than maxBytes")
	}
}

func TestDownloadAttachment_OK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Errorf("attachment download must not send the bot token, got %q", auth)
		}
		_, _ = w.Write([]byte("hello"))
	}))
	defer srv.Close()

	data, err := DownloadAttachment(context.Background(), srv.URL, 1024)
	if err != nil {
		t.Fatalf("DownloadAttachment: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("got %q, want %q", data, "hello")
	}
}
