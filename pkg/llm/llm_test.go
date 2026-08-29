package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOllamaQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/generate" {
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["model"] != "qwen2.5:latest" {
				t.Errorf("expected model qwen2.5:latest, got %v", body["model"])
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"response": "Hello from mock Ollama",
				"done":     true,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := Config{
		BaseURL: server.URL,
		Model:   "qwen2.5:latest",
	}

	resp, err := Query("Hello", cfg)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if resp != "Hello from mock Ollama" {
		t.Errorf("expected 'Hello from mock Ollama', got %q", resp)
	}
}

func TestGeminiVisionQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			if strings.Contains(r.URL.Path, "v1beta/v1beta") {
				t.Errorf("URL contains duplicated v1beta: %s", r.URL.Path)
			}
			key := r.URL.Query().Get("key")
			if key != "gemini-test-key" {
				t.Errorf("expected key 'gemini-test-key', got %q", key)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"candidates": []map[string]interface{}{
					{
						"content": map[string]interface{}{
							"parts": []map[string]interface{}{
								{
									"text": "# 画像から書き起こしたマークダウン\n\n- 項目1\n- 項目2",
								},
							},
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := VisionConfig{
		BaseURL: server.URL + "/v1beta/",
		Model:   "gemini-flash-lite-latest",
		APIKey:  "gemini-test-key",
	}

	resp, err := QueryVision("マークダウン化して", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "image/png", cfg)
	if err != nil {
		t.Fatalf("QueryVision failed: %v", err)
	}
	if !strings.Contains(resp, "画像から書き起こしたマークダウン") {
		t.Errorf("expected markdown output, got %q", resp)
	}
}

func TestLMStudioRawCompletions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/completions" {
			var body struct {
				Model  string `json:"model"`
				Prompt string `json:"prompt"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)

			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"text": "けど、散歩に出かけよう。",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1",
		Model:     "prism-ml/bonsai-27b",
		MaxTokens: 50,
	}

	suggestion, err := QueryAutocomplete("今日はいい日だと思うんど", "", cfg)
	if err != nil {
		t.Fatalf("LM Studio Raw Completions failed: %v", err)
	}
	if suggestion != "けど、散歩に出かけよう。" {
		t.Errorf("expected 'けど、散歩に出かけよう。', got %q", suggestion)
	}
}

func TestLMStudioHeaderTruncation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"text": "いい天気です。\n# 2026-08-31 17:55\nおはようございます。\n今日はいい天気です。",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1",
		Model:     "prism-ml/bonsai-27b",
		MaxTokens: 50,
	}

	suggestion, err := QueryAutocomplete("今日は", "", cfg)
	if err != nil {
		t.Fatalf("QueryAutocomplete failed: %v", err)
	}
	if suggestion != "いい天気です。" {
		t.Errorf("expected 'いい天気です。', got %q", suggestion)
	}
}

func TestLMStudioThinkTagTruncation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"text": "晴れ、温度は25℃です。\n<think>\nHere's a thinking process:",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1",
		Model:     "prism-ml/bonsai-27b",
		MaxTokens: 50,
	}

	suggestion, err := QueryAutocomplete("今日の天気は", "", cfg)
	if err != nil {
		t.Fatalf("QueryAutocomplete failed: %v", err)
	}
	if suggestion != "晴れ、温度は25℃です。" {
		t.Errorf("expected '晴れ、温度は25℃です。', got %q", suggestion)
	}
}

func TestLMStudioClosingThinkTag(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"text": "晴れ、温度は25℃です。\n</think>",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1",
		Model:     "prism-ml/bonsai-27b",
		MaxTokens: 50,
	}

	suggestion, err := QueryAutocomplete("今日の天気は", "", cfg)
	if err != nil {
		t.Fatalf("QueryAutocomplete failed: %v", err)
	}
	if suggestion != "晴れ、温度は25℃です。" {
		t.Errorf("expected '晴れ、温度は25℃です。', got %q", suggestion)
	}
}

func TestReasoningContentFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/completions" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"message": map[string]interface{}{
							"role":              "assistant",
							"content":           "",
							"reasoning_content": "* Input text\n* Task: continue\n今日はいい天気ですね",
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1",
		Model:     "google/gemma-4-12b-qat",
		MaxTokens: 100,
	}

	suggestion, err := QueryAutocomplete("こんにちは、", "", cfg)
	if err != nil {
		t.Fatalf("Reasoning fallback failed: %v", err)
	}
	if suggestion != "今日はいい天気ですね" {
		t.Errorf("expected '今日はいい天気ですね', got %q", suggestion)
	}
}

func TestOllamaAutocompleteQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/generate" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"response": "世界へようこそ",
				"done":     true,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL,
		Model:     "qwen2.5:latest",
		MaxTokens: 20,
	}

	suggestion, err := QueryAutocomplete("こんにちは、", "", cfg)
	if err != nil {
		t.Fatalf("QueryAutocomplete failed: %v", err)
	}
	if suggestion != "世界へようこそ" {
		t.Errorf("expected '世界へようこそ', got %q", suggestion)
	}
}

func TestGeminiAutocompleteQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			if strings.Contains(r.URL.Path, "v1beta/v1beta") {
				t.Errorf("URL contains duplicated v1beta: %s", r.URL.Path)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"candidates": []map[string]interface{}{
					{
						"content": map[string]interface{}{
							"parts": []map[string]interface{}{
								{
									"text": "Geminiによる予測テキスト",
								},
							},
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := AutocompleteConfig{
		BaseURL:   server.URL + "/v1beta/",
		Model:     "gemini-flash-lite-latest",
		APIKey:    "test-key",
		MaxTokens: 25,
	}

	suggestion, err := QueryAutocomplete("今日は", "", cfg)
	if err != nil {
		t.Fatalf("Gemini QueryAutocomplete failed: %v", err)
	}
	if suggestion != "Geminiによる予測テキスト" {
		t.Errorf("expected 'Geminiによる予測テキスト', got %q", suggestion)
	}
}
