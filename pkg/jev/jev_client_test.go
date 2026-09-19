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

func TestClient_SystemOne_Local(t *testing.T) {
	client := NewClient(ClientConfig{})

	// 1. Test Choice with Shannon entropy confidence
	reqChoice := SystemOneRequest{
		State: "We need to run git status to check modified files",
		Choices: map[string]ChoiceQuestion{
			"action_type": {
				Name:    "action_type",
				Options: []string{"git_operation", "file_edit", "system_admin"},
			},
		},
	}
	respChoice, err := client.SystemOne(context.Background(), reqChoice)
	if err != nil {
		t.Fatalf("SystemOne choice failed: %v", err)
	}
	res, ok := respChoice.Choices["action_type"]
	if !ok {
		t.Fatal("expected action_type in choices response")
	}
	if res.Selected != "git_operation" {
		t.Errorf("expected Selected='git_operation', got %q", res.Selected)
	}
	if res.Confidence <= 0 || res.Confidence > 1.0 {
		t.Errorf("expected confidence between 0 and 1, got %f", res.Confidence)
	}
	t.Logf("Choice result: Selected=%s, Confidence=%.4f, Probs=%v", res.Selected, res.Confidence, res.Probabilities)

	// 2. Test Noul (Probability 0..1 without confidence field)
	reqNoul := SystemOneRequest{
		State: "大規模なアーキテクチャ再設計と全体リファクタリングを実施する",
		Nouls: map[string]NoulQuestion{
			"needs_llm": {
				Name:        "needs_llm",
				Description: "Requires full LLM agent escalation",
			},
		},
	}
	respNoul, err := client.SystemOne(context.Background(), reqNoul)
	if err != nil {
		t.Fatalf("SystemOne noul failed: %v", err)
	}
	prob, ok := respNoul.Nouls["needs_llm"]
	if !ok {
		t.Fatal("expected needs_llm in nouls response")
	}
	if prob < 0.8 {
		t.Errorf("expected high needs_llm probability (> 0.8) for complex task, got %f", prob)
	}
	t.Logf("Noul result: needs_llm probability=%.4f", prob)

	// 3. Test Score (Ordered discrete scale expected value / weighted average)
	reqScore := SystemOneRequest{
		State: "rm -rf /var/log/app",
		Scores: map[string]ScoreQuestion{
			"risk_level": {
				Name:        "risk_level",
				Description: "Command risk level",
				Min:         0,
				Max:         2,
				Step:        1,
				Labels:      []string{"safe_read", "edit", "destructive"},
			},
		},
	}
	respScore, err := client.SystemOne(context.Background(), reqScore)
	if err != nil {
		t.Fatalf("SystemOne score failed: %v", err)
	}
	scoreRes, ok := respScore.Scores["risk_level"]
	if !ok {
		t.Fatal("expected risk_level in scores response")
	}
	if scoreRes.Score < 1.5 {
		t.Errorf("expected high risk score (> 1.5) for 'rm -rf', got %f", scoreRes.Score)
	}
	if len(scoreRes.Probabilities) != 3 {
		t.Errorf("expected 3 probabilities for scale 0..2, got %d", len(scoreRes.Probabilities))
	}
	t.Logf("Score result: expected value=%.4f, probs=%v", scoreRes.Score, scoreRes.Probabilities)
}

func TestClient_SystemOne_Remote(t *testing.T) {
	// Mock TypeSafe AI Jev server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/systemOne" {
			t.Errorf("expected path /v1/systemOne, got %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-typesafe-key" {
			t.Errorf("expected Bearer token, got %s", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"choices": {
				"routing": {
					"selected": "direct",
					"confidence": 0.94,
					"probabilities": {"direct": 0.94, "manual_review": 0.06}
				}
			},
			"nouls": {
				"is_safe": 0.99
			},
			"scores": {
				"impact": {
					"score": 0.12,
					"probabilities": [0.90, 0.08, 0.02]
				}
			}
		}`))
	}))
	defer server.Close()

	client := NewClient(ClientConfig{
		Endpoint:    server.URL,
		TypeSafeKey: "test-typesafe-key",
		Timeout:     2 * time.Second,
	})

	resp, err := client.SystemOne(context.Background(), SystemOneRequest{
		State: "ls -la",
		Choices: map[string]ChoiceQuestion{
			"routing": {Name: "routing", Options: []string{"direct", "manual_review"}},
		},
	})
	if err != nil {
		t.Fatalf("SystemOne remote failed: %v", err)
	}

	if resp.Choices["routing"].Selected != "direct" {
		t.Errorf("expected Selected='direct', got %s", resp.Choices["routing"].Selected)
	}
	if resp.Choices["routing"].Confidence != 0.94 {
		t.Errorf("expected confidence=0.94, got %f", resp.Choices["routing"].Confidence)
	}
	if resp.Nouls["is_safe"] != 0.99 {
		t.Errorf("expected noul=0.99, got %f", resp.Nouls["is_safe"])
	}
	if resp.Scores["impact"].Score != 0.12 {
		t.Errorf("expected score=0.12, got %f", resp.Scores["impact"].Score)
	}
}
