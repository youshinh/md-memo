package jev

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// TestClient_PredictLocal_FallbackContexts asserts the contract of the hardcoded
// heuristic fallback predictor (predictLocal) across every keyword context plus
// the generic default: exactly 3 distinct candidates, every candidate whose
// Command is a plain shell command (i.e. not a {{ ... }} AI slot or a [? ... ]
// research slot) must be typed "sh" so the deterministic runner actually executes
// it instead of forwarding it to the LLM, and it must pass the AST verifier.
// Descriptions must also no longer reference a specific hardcoded agent name.
func TestClient_PredictLocal_FallbackContexts(t *testing.T) {
	client := NewClient(ClientConfig{})
	verifier := NewASTCommandVerifier()

	contexts := map[string]string{
		"agent":   "agent にこのメモの実装・調査を依頼したい",
		"git":     "git diff の内容を確認してからコミットしたい",
		"tasks":   "today's task list and 予定 for tomorrow",
		"testing": "please add a unit test and run the テスト suite",
		"default": "banana smoothie recipe notes for the weekend",
	}

	for name, bufferCtx := range contexts {
		t.Run(name, func(t *testing.T) {
			resp := client.predictLocal(JevPredictRequest{BufferContext: bufferCtx})

			if len(resp.Candidates) != 3 {
				t.Fatalf("expected exactly 3 candidates, got %d: %+v", len(resp.Candidates), resp.Candidates)
			}

			seenCommands := make(map[string]bool)
			for _, c := range resp.Candidates {
				if seenCommands[c.Command] {
					t.Errorf("duplicate candidate command %q in context %q", c.Command, name)
				}
				seenCommands[c.Command] = true

				if strings.Contains(c.Description, "Antigravity") || strings.Contains(c.Description, "agy") {
					t.Errorf("description still references a hardcoded agent name: %q", c.Description)
				}

				isSlot := strings.HasPrefix(c.Command, "{{") || strings.HasPrefix(c.Command, "[?")
				if !isSlot {
					if c.ActionType != "sh" {
						t.Errorf("plain shell command %q must have ActionType \"sh\", got %q", c.Command, c.ActionType)
					}
					result, err := verifier.Verify(c.Command)
					if err != nil {
						t.Fatalf("verifier error for command %q: %v", c.Command, err)
					}
					if !result.IsSafe {
						t.Errorf("expected hardcoded command %q to pass AST verification, reason: %s", c.Command, result.Reason)
					}
				}
			}
		})
	}
}

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
		// Deliberately avoids "file"/"edit"-shaped tokens so only git_operation's own name
		// scores a match; Criteria has no defined order (map, same as the real API's JSON
		// object), so a genuinely tied score between two options would be an arbitrary,
		// non-representative thing for this test to assert on.
		State: "We need to run git status to check the current branch",
		Questions: map[string]SystemOneQuestion{
			"action_type": {
				Type:         QuestionChoice,
				Instructions: "Which category best fits the described action?",
				Criteria: map[string]string{
					"git_operation": "A git command such as status, diff, commit, or push.",
					"file_edit":     "Editing or creating a file's contents.",
					"system_admin":  "OS-level administration such as installing packages or managing services.",
				},
			},
		},
	}
	respChoice, err := client.SystemOne(context.Background(), reqChoice)
	if err != nil {
		t.Fatalf("SystemOne choice failed: %v", err)
	}
	res, ok := respChoice.Answers["action_type"]
	if !ok {
		t.Fatal("expected action_type in answers response")
	}
	if res.Type != QuestionChoice {
		t.Errorf("expected Type=%q, got %q", QuestionChoice, res.Type)
	}
	if res.Choice != "git_operation" {
		t.Errorf("expected Choice='git_operation', got %q", res.Choice)
	}
	if res.Confidence <= 0 || res.Confidence > 1.0 {
		t.Errorf("expected confidence between 0 and 1, got %f", res.Confidence)
	}
	t.Logf("Choice result: Choice=%s, Confidence=%.4f, Probs=%v", res.Choice, res.Confidence, res.Probabilities)

	// 2. Test Noul (Probability 0..1 without confidence field)
	reqNoul := SystemOneRequest{
		State: "大規模なアーキテクチャ再設計と全体リファクタリングを実施する",
		Questions: map[string]SystemOneQuestion{
			"needs_llm": {
				Type:         QuestionNoul,
				Instructions: "Does this task require full LLM agent escalation?",
			},
		},
	}
	respNoul, err := client.SystemOne(context.Background(), reqNoul)
	if err != nil {
		t.Fatalf("SystemOne noul failed: %v", err)
	}
	noulAns, ok := respNoul.Answers["needs_llm"]
	if !ok {
		t.Fatal("expected needs_llm in answers response")
	}
	if noulAns.Type != QuestionNoul {
		t.Errorf("expected Type=%q, got %q", QuestionNoul, noulAns.Type)
	}
	if noulAns.Noul < 0.8 {
		t.Errorf("expected high needs_llm probability (> 0.8) for complex task, got %f", noulAns.Noul)
	}
	t.Logf("Noul result: needs_llm probability=%.4f", noulAns.Noul)

	// 3. Test Score (ordered levels -> probability-weighted mean level index)
	reqScore := SystemOneRequest{
		State: "rm -rf /var/log/app",
		Questions: map[string]SystemOneQuestion{
			"risk_level": {
				Type:         QuestionScore,
				Instructions: "How risky is this command?",
				Criteria:     []string{"safe_read", "edit", "destructive"},
			},
		},
	}
	respScore, err := client.SystemOne(context.Background(), reqScore)
	if err != nil {
		t.Fatalf("SystemOne score failed: %v", err)
	}
	scoreRes, ok := respScore.Answers["risk_level"]
	if !ok {
		t.Fatal("expected risk_level in answers response")
	}
	if scoreRes.Type != QuestionScore {
		t.Errorf("expected Type=%q, got %q", QuestionScore, scoreRes.Type)
	}
	if scoreRes.Score < 1.5 {
		t.Errorf("expected high risk score (> 1.5) for 'rm -rf', got %f", scoreRes.Score)
	}
	if len(scoreRes.Probabilities) != 3 {
		t.Errorf("expected 3 probabilities for a 3-level scale, got %d", len(scoreRes.Probabilities))
	}
	if len(scoreRes.Legend) != 3 {
		t.Errorf("expected legend for all 3 levels, got %d", len(scoreRes.Legend))
	}
	t.Logf("Score result: expected value=%.4f, probs=%v, legend=%v", scoreRes.Score, scoreRes.Probabilities, scoreRes.Legend)
}

func TestClient_SystemOne_Remote(t *testing.T) {
	// Mock TypeSafe AI Jev server, matching the real wire format documented at
	// https://docs.typesafe.ai/api.md (verified 2026-09-20): POST /v1/systemone (lowercase),
	// one "questions"/"answers" map with a per-item "type" discriminator.
	var capturedReq SystemOneRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/systemone" {
			t.Errorf("expected path /v1/systemone, got %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-typesafe-key" {
			t.Errorf("expected Bearer token, got %s", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&capturedReq); err != nil {
			t.Errorf("failed to decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"model": "jev-1.13.0",
			"answers": {
				"routing": {
					"type": "choice",
					"choice": "direct",
					"confidence": 0.94,
					"probabilities": {"direct": 0.94, "manual_review": 0.06}
				},
				"is_safe": {
					"type": "noul",
					"noul": 0.99
				},
				"impact": {
					"type": "score",
					"score": 0.12,
					"probabilities": {"0": 0.90, "1": 0.08, "2": 0.02},
					"legend": {"0": "safe", "1": "modifying", "2": "destructive"}
				}
			},
			"usage": {"input_tokens": 42, "output_tokens": 0}
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
		Questions: map[string]SystemOneQuestion{
			"routing": {
				Type:         QuestionChoice,
				Instructions: "Should this run directly or go to manual review?",
				Criteria:     map[string]string{"direct": "Safe to run as-is.", "manual_review": "Needs a human look first."},
			},
		},
	})
	if err != nil {
		t.Fatalf("SystemOne remote failed: %v", err)
	}

	// The request the server actually received must carry the required top-level "model"
	// field (defaulted from ClientConfig.Model, "jev-latest") - this was missing from an
	// earlier version of this client and the real API rejects a request without it.
	if capturedReq.Model == "" {
		t.Error("expected request to include a non-empty top-level model field")
	}

	if resp.Answers["routing"].Choice != "direct" {
		t.Errorf("expected Choice='direct', got %s", resp.Answers["routing"].Choice)
	}
	if resp.Answers["routing"].Confidence != 0.94 {
		t.Errorf("expected confidence=0.94, got %f", resp.Answers["routing"].Confidence)
	}
	if resp.Answers["is_safe"].Noul != 0.99 {
		t.Errorf("expected noul=0.99, got %f", resp.Answers["is_safe"].Noul)
	}
	if resp.Answers["impact"].Score != 0.12 {
		t.Errorf("expected score=0.12, got %f", resp.Answers["impact"].Score)
	}
	if resp.Answers["impact"].Legend["1"] != "modifying" {
		t.Errorf("expected legend[1]='modifying', got %q", resp.Answers["impact"].Legend["1"])
	}
}
