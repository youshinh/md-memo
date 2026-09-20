package jev

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// failingRoundTripper fails the test as soon as any HTTP request is attempted. It is installed
// on a Client's httpClient so "this code path must not touch the network" can be asserted
// positively rather than inferred from a timeout.
type failingRoundTripper struct {
	t *testing.T
}

func (f failingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	f.t.Helper()
	f.t.Fatalf("unexpected outbound HTTP request to %s (buffer context must stay local)", req.URL.String())
	return nil, nil
}

// clearJevEnv removes every environment variable NewClient / getOpenRouterKey / getTypeSafeKey
// consult, so a developer machine that happens to export one of them cannot mask a regression.
func clearJevEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"JEV_API_URL", "JEV_API_KEY", "JEV_MODEL", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY"} {
		t.Setenv(k, "")
	}
}

// TestPredict_NoConfig_NoNetwork is the core privacy regression test for Quick Actions:
// with an empty ClientConfig and a clean environment, Predict must resolve entirely locally.
func TestPredict_NoConfig_NoNetwork(t *testing.T) {
	clearJevEnv(t)

	client := NewClient(ClientConfig{Timeout: 2 * time.Second})
	if client.cfg.Endpoint != "" {
		t.Fatalf("expected empty endpoint with nothing configured, got %q", client.cfg.Endpoint)
	}
	client.httpClient.Transport = failingRoundTripper{t: t}

	resp, err := client.Predict(context.Background(), JevPredictRequest{
		BufferContext: "今日の予定を整理したい",
		CursorOffset:  5,
	})
	if err != nil {
		t.Fatalf("local predict returned error: %v", err)
	}
	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 local candidates, got %d", len(resp.Candidates))
	}
}

// TestSystemOne_NoConfig_NoNetwork covers the other GUI-reachable network path on this client
// (AgentRouter.DispatchSystemOne -> SystemOne -> callTypeSafeAPI).
func TestSystemOne_NoConfig_NoNetwork(t *testing.T) {
	clearJevEnv(t)

	client := NewClient(ClientConfig{Timeout: 2 * time.Second})
	client.httpClient.Transport = failingRoundTripper{t: t}

	resp, err := client.SystemOne(context.Background(), SystemOneRequest{
		State: "git status",
		Nouls: map[string]NoulQuestion{
			"needs_llm": {Name: "needs_llm", Description: "requires heavy LLM"},
		},
	})
	if err != nil {
		t.Fatalf("local SystemOne returned error: %v", err)
	}
	if _, ok := resp.Nouls["needs_llm"]; !ok {
		t.Fatalf("expected local noul result, got %+v", resp.Nouls)
	}
}

// TestPredict_ConfiguredEndpoint_StillCallsRemote makes sure the privacy gate did not disable
// the feature for users who did configure a remote engine.
func TestPredict_ConfiguredEndpoint_StillCallsRemote(t *testing.T) {
	clearJevEnv(t)

	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text": "- [ ] sh git status\n- [ ] ai refactor\n- [ ] doc update README.md"}`))
	}))
	defer server.Close()

	client := NewClient(ClientConfig{Endpoint: server.URL, Timeout: 2 * time.Second})
	if _, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: "fix parser"}); err != nil {
		t.Fatalf("predict failed: %v", err)
	}
	if !called {
		t.Fatal("configured endpoint was never contacted")
	}
}

// TestPredict_GenericOpenRouterEnv_RequiresOptIn pins fix (b): a generic OPENROUTER_API_KEY in
// the environment must not by itself turn on remote prediction, but the headless CLI's explicit
// opt-in must keep working.
func TestPredict_GenericOpenRouterEnv_RequiresOptIn(t *testing.T) {
	t.Run("opt-out (GUI default) performs no request", func(t *testing.T) {
		clearJevEnv(t)
		t.Setenv("OPENROUTER_API_KEY", "sk-or-v1-generic-env-key")

		client := NewClient(ClientConfig{Timeout: 2 * time.Second})
		client.httpClient.Transport = failingRoundTripper{t: t}

		resp, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: "private note text"})
		if err != nil {
			t.Fatalf("predict returned error: %v", err)
		}
		if len(resp.Candidates) != 3 {
			t.Fatalf("expected 3 local candidates, got %d", len(resp.Candidates))
		}
	})

	t.Run("opt-in (headless CLI) does perform a request", func(t *testing.T) {
		clearJevEnv(t)
		t.Setenv("OPENROUTER_API_KEY", "sk-or-v1-generic-env-key")

		client := NewClient(ClientConfig{Timeout: 2 * time.Second, AllowGenericEnvKeys: true})
		if client.getOpenRouterKey() == "" {
			t.Fatal("expected the env key to be honoured with AllowGenericEnvKeys=true")
		}

		attempted := make(chan string, 1)
		client.httpClient.Transport = recordingRoundTripper{urls: attempted}

		if _, err := client.Predict(context.Background(), JevPredictRequest{BufferContext: "private note text"}); err != nil {
			t.Fatalf("predict returned error: %v", err)
		}
		select {
		case u := <-attempted:
			if u == "" {
				t.Fatal("expected a recorded request URL")
			}
		default:
			t.Fatal("expected an outbound OpenRouter request with AllowGenericEnvKeys=true")
		}
	})
}

// recordingRoundTripper records the first attempted request URL and then fails the request so
// no real traffic leaves the machine.
type recordingRoundTripper struct {
	urls chan string
}

func (r recordingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	select {
	case r.urls <- req.URL.String():
	default:
	}
	return nil, http.ErrUseLastResponse
}

// TestNewClient_DefaultEndpointOnlyWithKey documents the endpoint-defaulting rule.
func TestNewClient_DefaultEndpointOnlyWithKey(t *testing.T) {
	clearJevEnv(t)

	if got := NewClient(ClientConfig{}).cfg.Endpoint; got != "" {
		t.Errorf("nothing configured: expected empty endpoint, got %q", got)
	}
	if got := NewClient(ClientConfig{TypeSafeKey: "ts-key"}).cfg.Endpoint; got != DefaultTypeSafeEndpoint {
		t.Errorf("typesafe key configured: expected %q, got %q", DefaultTypeSafeEndpoint, got)
	}

	t.Setenv("JEV_API_KEY", "app-specific-key")
	if got := NewClient(ClientConfig{}).cfg.Endpoint; got != DefaultTypeSafeEndpoint {
		t.Errorf("JEV_API_KEY set: expected %q, got %q", DefaultTypeSafeEndpoint, got)
	}
}
