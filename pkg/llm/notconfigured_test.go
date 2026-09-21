package llm

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestQueryVision_MissingKeyIsNotConfigured(t *testing.T) {
	cases := []struct {
		name    string
		cfg     VisionConfig
		wantMsg string
	}{
		{"gemini default endpoint", VisionConfig{}, "Gemini API Keyが設定されていません"},
		{"gemini model on a custom host", VisionConfig{BaseURL: "https://proxy.invalid", Model: "gemini-2.5-flash"}, "Gemini API Keyが設定されていません"},
		// .invalid never resolves, so a regression that sent the request anyway still stays offline.
		{"hosted OpenAI", VisionConfig{BaseURL: "https://api.openai.com.invalid/v1", Model: "gpt-4o"}, "Vision API Keyが設定されていません"},
		{"hosted OpenRouter", VisionConfig{BaseURL: "https://openrouter.ai.invalid/api/v1", Model: "openai/gpt-4o"}, "Vision API Keyが設定されていません"},
		{"hosted Groq", VisionConfig{BaseURL: "https://api.groq.com.invalid/openai/v1", Model: "llama-vision"}, "Vision API Keyが設定されていません"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := QueryVision("", "QUJD", "image/png", c.cfg)
			if err == nil {
				t.Fatal("expected an error")
			}
			if err.Error() != c.wantMsg {
				t.Errorf("message = %q, want it unchanged: %q", err.Error(), c.wantMsg)
			}
			if !errors.Is(err, ErrNotConfigured) {
				t.Errorf("errors.Is(err, ErrNotConfigured) = false for %v", err)
			}
		})
	}
}

// A local OpenAI-compatible server (Ollama, LM Studio, llama.cpp, a LAN box) needs no key: the
// request must be made, and an HTTP failure must not be mistaken for a missing setup.
func TestQueryVision_KeylessLocalServerIsNotConfigured(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := QueryVision("", "QUJD", "image/png", VisionConfig{BaseURL: server.URL, Model: "qwen2.5-vl:latest"})
	if err == nil {
		t.Fatal("expected the server's 500 to surface")
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("the keyless local request must be sent, got %d calls", calls)
	}
	if errors.Is(err, ErrNotConfigured) {
		t.Errorf("an HTTP failure is not a configuration problem: %v", err)
	}
}

func TestOpenAIHostNeedsKey(t *testing.T) {
	for _, u := range []string{"https://api.openai.com/v1", "https://API.OpenAI.com/v1", "https://api.groq.com/openai/v1", "https://api.together.xyz/v1", "https://openrouter.ai/api/v1"} {
		if !openAIHostNeedsKey(u) {
			t.Errorf("%q is a hosted service and always needs a key", u)
		}
	}
	for _, u := range []string{"", "http://localhost:11434", "http://127.0.0.1:1234/v1", "http://192.168.1.20:8000/v1", "https://ollama.example.com"} {
		if openAIHostNeedsKey(u) {
			t.Errorf("%q must be allowed to run keyless", u)
		}
	}
}
