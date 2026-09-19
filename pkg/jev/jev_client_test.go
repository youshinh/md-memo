package jev

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestClient_PredictRemote(t *testing.T) {
	// Mock Jev remote server returning EBNF constrained output
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		// EBNF constrained items with noise
		w.Write([]byte(`{
			"text": "- [ ] sh git status\n- [ ] ai refactor error handling\n- [ ] doc update README.md"
		}`))
	}))
	defer server.Close()

	client := NewClient(ClientConfig{
		Endpoint: server.URL,
		Timeout:  2 * time.Second,
	})

	resp, err := client.Predict(context.Background(), JevPredictRequest{
		BufferContext: "# My Project\n\nFix bug in parser.",
		CursorOffset:  10,
	})
	if err != nil {
		t.Fatalf("predict failed: %v", err)
	}

	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 candidates, got %d", len(resp.Candidates))
	}
	if resp.Candidates[0].ActionType != "sh" || resp.Candidates[0].Command != "git status" {
		t.Errorf("candidate 0 mismatch: %+v", resp.Candidates[0])
	}
}

func TestClient_PredictFallback(t *testing.T) {
	// When remote server is unreachable, it should use heuristic local generation
	client := NewClient(ClientConfig{
		Endpoint: "http://127.0.0.1:99999/unreachable",
		Timeout:  100 * time.Millisecond,
	})

	resp, err := client.Predict(context.Background(), JevPredictRequest{
		BufferContext: "func TestAuth(t *testing.T) {\n",
		CursorOffset:  15,
	})
	if err != nil {
		t.Fatalf("fallback predict should not return fatal error: %v", err)
	}

	if len(resp.Candidates) == 0 {
		t.Fatalf("expected fallback candidates to be generated")
	}
}

func TestClient_PredictOpenRouterLive(t *testing.T) {
	apiKey := os.Getenv("OPENROUTER_API_KEY")
	if apiKey == "" {
		t.Skip("skipping live OpenRouter test: OPENROUTER_API_KEY not set")
	}

	client := NewClient(ClientConfig{
		OpenRouterKey: apiKey,
		Model:         "google/gemini-3.8-flash",
		Timeout:       15 * time.Second,
	})

	resp, err := client.Predict(context.Background(), JevPredictRequest{
		BufferContext: "# Database optimization\nRefactor connection pool and run load tests.",
		CursorOffset:  20,
	})
	if err != nil {
		t.Fatalf("live OpenRouter predict failed: %v", err)
	}

	if len(resp.Candidates) == 0 {
		t.Fatalf("expected at least 1 candidate from OpenRouter, got 0")
	}

	t.Logf("Received %d candidates from OpenRouter:", len(resp.Candidates))
	for i, c := range resp.Candidates {
		t.Logf("  [%d] ActionType=%s, Command=%s", i+1, c.ActionType, c.Command)
	}
}
