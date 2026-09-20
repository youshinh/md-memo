package llm

import (
	"strings"
	"testing"
)

// TestDetectProvider pins the heuristic that was previously inlined in Query, including the
// cases the rest of the suite exercises end-to-end (LM Studio on :1234, a llama.cpp-style
// server on :8080, Gemini via googleapis.com, plain Ollama on :11434, OpenRouter).
func TestDetectProvider(t *testing.T) {
	tests := []struct {
		name    string
		baseURL string
		model   string
		apiKey  string
		want    Provider
	}{
		{"plain ollama", "http://localhost:11434", "qwen2.5:latest", "", ProviderOllama},
		{"ollama trailing slash", "http://127.0.0.1:11434/", "llama3", "", ProviderOllama},
		{"lm studio 1234", "http://localhost:1234", "google/gemma-4-12b-qat", "", ProviderOpenAICompatible},
		{"lm studio 1234 with v1", "http://localhost:1234/v1", "local-model", "", ProviderOpenAICompatible},
		{"llama.cpp 8080", "http://localhost:8080", "local-model", "", ProviderOpenAICompatible},
		{"openrouter", "https://openrouter.ai/api/v1", "google/gemini-3.8-flash", "sk-or-v1-x", ProviderGemini},
		{"openrouter non-gemini model", "https://openrouter.ai/api/v1", "meta-llama/llama-3-70b", "sk-or-v1-x", ProviderOpenAICompatible},
		{"openai", "https://api.openai.com/v1", "gpt-4o-mini", "sk-x", ProviderOpenAICompatible},
		{"groq", "https://api.groq.com/openai", "llama-3.1-8b", "", ProviderOpenAICompatible},
		{"together", "https://api.together.xyz", "mixtral", "", ProviderOpenAICompatible},
		{"gemini by host", "https://generativelanguage.googleapis.com", "", "key", ProviderGemini},
		{"gemini by model", "", "gemini-flash-lite-latest", "key", ProviderGemini},
		{"api key alone implies openai shape", "", "some-model", "key", ProviderOpenAICompatible},
		{"nothing configured", "", "", "", ProviderUnknown},
		{"local host, no key, no marker", "http://192.168.1.10:9999", "custom", "", ProviderOllama},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetectProvider(tt.baseURL, tt.model, tt.apiKey); got != tt.want {
				t.Errorf("DetectProvider(%q, %q, %q) = %q, want %q", tt.baseURL, tt.model, tt.apiKey, got, tt.want)
			}
		})
	}
}

// TestDetectProvider_MatchesLegacyQueryHeuristic re-implements the exact expression that used
// to live in Query and asserts DetectProvider agrees with it on every combination, so the
// extraction is provably a pure refactor for the request path.
func TestDetectProvider_MatchesLegacyQueryHeuristic(t *testing.T) {
	legacy := func(baseURL, model, apiKey string) Provider {
		baseURL = strings.TrimRight(baseURL, "/")
		if strings.Contains(baseURL, "googleapis.com") || strings.Contains(model, "gemini") {
			return ProviderGemini
		}
		if strings.Contains(baseURL, "/v1") || strings.Contains(baseURL, ":1234") || strings.Contains(baseURL, ":8080") ||
			apiKey != "" || strings.Contains(baseURL, "openai.com") || strings.Contains(baseURL, "groq.com") ||
			strings.Contains(baseURL, "together.xyz") {
			return ProviderOpenAICompatible
		}
		return ProviderOllama
	}

	baseURLs := []string{
		"", "/", "http://localhost:11434", "http://localhost:1234/v1", "http://localhost:8080",
		"https://api.openai.com/v1", "https://api.groq.com", "https://api.together.xyz",
		"https://generativelanguage.googleapis.com", "https://openrouter.ai/api/v1",
		"http://10.0.0.5:3000",
	}
	models := []string{"", "qwen2.5:latest", "gemini-flash-lite-latest", "gpt-4o-mini"}
	keys := []string{"", "sk-test"}

	for _, b := range baseURLs {
		for _, m := range models {
			for _, k := range keys {
				want := legacy(b, m, k)
				got := DetectProvider(b, m, k)
				// ProviderUnknown is the one intentional addition: it only replaces
				// ProviderOllama when absolutely nothing is configured, and Query maps it
				// back onto the Ollama path.
				if got == ProviderUnknown {
					if want != ProviderOllama {
						t.Errorf("DetectProvider(%q,%q,%q) = unknown but legacy said %q", b, m, k, want)
					}
					continue
				}
				if got != want {
					t.Errorf("DetectProvider(%q,%q,%q) = %q, legacy = %q", b, m, k, got, want)
				}
			}
		}
	}
}
