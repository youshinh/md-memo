package llm

import (
	"encoding/json"
	"io"
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

func TestOpenAIVisionQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"message": map[string]interface{}{
							"role":    "assistant",
							"content": "Image content parsed",
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
		BaseURL: server.URL + "/v1",
		Model:   "gpt-4o",
		APIKey:  "openai-test-key",
	}

	resp, err := QueryVision("Describe", "base64data", "image/png", cfg)
	if err != nil {
		t.Fatalf("QueryVision OpenAI failed: %v", err)
	}
	if resp != "Image content parsed" {
		t.Errorf("expected 'Image content parsed', got %q", resp)
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

func TestBuildGeminiURL(t *testing.T) {
	tests := []struct {
		baseURL  string
		model    string
		apiKey   string
		expected string
	}{
		{"", "", "key", "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=key"},
		{"https://custom.com/v1beta", "models/my-model", "abc", "https://custom.com/v1beta/models/my-model:generateContent?key=abc"},
		{"https://custom.com/v1", "my-model", "abc", "https://custom.com/v1beta/models/my-model:generateContent?key=abc"},
	}

	for _, tt := range tests {
		got := buildGeminiURL(tt.baseURL, tt.model, tt.apiKey)
		if got != tt.expected {
			t.Errorf("buildGeminiURL(%q, %q, %q) = %q, want %q", tt.baseURL, tt.model, tt.apiKey, got, tt.expected)
		}
	}
}

func TestBuildOpenAIURL(t *testing.T) {
	tests := []struct {
		baseURL  string
		endpoint string
		expected string
	}{
		{"http://localhost:11434/v1", "chat/completions", "http://localhost:11434/v1/chat/completions"},
		{"http://localhost:11434", "completions", "http://localhost:11434/v1/completions"},
		{"https://api.openai.com/v1/chat/completions", "chat/completions", "https://api.openai.com/v1/chat/completions"},
	}

	for _, tt := range tests {
		got := buildOpenAIURL(tt.baseURL, tt.endpoint)
		if got != tt.expected {
			t.Errorf("buildOpenAIURL(%q, %q) = %q, want %q", tt.baseURL, tt.endpoint, got, tt.expected)
		}
	}
}

func TestCleanSuggestion(t *testing.T) {
	tests := []struct {
		suggestion string
		prefix     string
		expected   string
	}{
		{"hello", "some prefix\n", "hello"},
		{"<think>thinking</think>hello", "", ""},
		{"Here's a thinking process: blah blah \nhello", "", " blah blah \nhello"},
		{"```markdown\nhello\n```", "", "\nhello"},
		{"hello\n# header", "", "hello"},
		{"hello\n\nnext paragraph", "", "hello"},
		{"Continuation: hello", "", " hello"},
		{"Result: hello", "", " hello"},
		{"<thought>some thought</thought>hello", "", ""},
	}

	for _, tt := range tests {
		got := cleanSuggestion(tt.suggestion, tt.prefix)
		if got != tt.expected {
			t.Errorf("cleanSuggestion(%q, %q) = %q, want %q", tt.suggestion, tt.prefix, got, tt.expected)
		}
	}
}

func TestQueryErrorHandling(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("Internal Server Error"))
	}))
	defer server.Close()

	cfg := Config{
		BaseURL: server.URL,
		Model:   "qwen2.5:latest",
	}

	// Because of fallback in Query (Ollama -> OpenAI), both will fail.
	_, err := Query("Hello", cfg)
	if err == nil {
		t.Fatalf("expected error for 500 status code, got nil")
	}
	if !strings.Contains(err.Error(), "APIエラー (500)") {
		t.Errorf("expected 500 error in message, got %v", err)
	}
}

func TestQueryOpenAI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"message": map[string]interface{}{
							"role":    "assistant",
							"content": "Hello from mock OpenAI",
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := Config{
		BaseURL: server.URL + "/v1",
		Model:   "gpt-4o-mini",
		APIKey:  "test-key",
	}

	resp, err := Query("Hello", cfg)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if resp != "Hello from mock OpenAI" {
		t.Errorf("expected 'Hello from mock OpenAI', got %q", resp)
	}
}

func TestQueryGeminiText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"candidates": []map[string]interface{}{
					{
						"content": map[string]interface{}{
							"parts": []map[string]interface{}{
								{
									"text": "Hello from mock Gemini",
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

	cfg := Config{
		BaseURL: server.URL + "/v1beta",
		Model:   "gemini-flash",
		APIKey:  "test-key",
	}

	resp, err := Query("Hello", cfg)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if resp != "Hello from mock Gemini" {
		t.Errorf("expected 'Hello from mock Gemini', got %q", resp)
	}
}

func TestOllamaFallbackToOpenAI(t *testing.T) {
	var ollamaCalled, openaiCalled bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/generate" {
			ollamaCalled = true
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Path == "/v1/chat/completions" || r.URL.Path == "/chat/completions" {
			openaiCalled = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"message": map[string]interface{}{
							"role":    "assistant",
							"content": "Fallback successful",
						},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := Config{
		BaseURL: server.URL,
		Model:   "local-model",
	}

	// This should try Ollama, fail (404), then fallback to OpenAI API style
	resp, err := Query("Hello", cfg)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if !ollamaCalled {
		t.Errorf("Expected Ollama endpoint to be called")
	}
	if !openaiCalled {
		t.Errorf("Expected OpenAI fallback to be called")
	}
	if resp != "Fallback successful" {
		t.Errorf("expected 'Fallback successful', got %q", resp)
	}
}

func TestGenerateGeminiImage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "generateContent") {
			body, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(body), "ASPECT_RATIO_SIXTEEN_BY_NINE") {
				t.Errorf("expected ASPECT_RATIO_SIXTEEN_BY_NINE in request payload, got: %s", string(body))
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"candidates": []map[string]interface{}{
					{
						"content": map[string]interface{}{
							"parts": []map[string]interface{}{
								{
									"inlineData": map[string]string{
										"mimeType": "image/png",
										"data":     "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
									},
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

	cfg := ImageGenConfig{
		BaseURL: server.URL,
		Model:   "gemini-2.5-flash-image",
		APIKey:  "test-api-key",
	}

	data, mime, err := GenerateImage("Draw a diagram", cfg)
	if err != nil {
		t.Fatalf("GenerateImage failed: %v", err)
	}
	if mime != "image/png" {
		t.Errorf("expected image/png, got %s", mime)
	}
	if len(data) == 0 {
		t.Errorf("expected image data, got empty")
	}
}

func TestGenerateImagen(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "predict") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"predictions": []map[string]interface{}{
					{
						"bytesBase64Encoded": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
						"mimeType":           "image/png",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	cfg := ImageGenConfig{
		BaseURL: server.URL,
		Model:   "imagen-3.0-generate-002",
		APIKey:  "test-api-key",
	}

	data, mime, err := GenerateImage("Draw architecture", cfg)
	if err != nil {
		t.Fatalf("GenerateImage failed: %v", err)
	}
	if mime != "image/png" {
		t.Errorf("expected image/png, got %s", mime)
	}
	if len(data) == 0 {
		t.Errorf("expected image data, got empty")
	}
}
