package llm

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsOllamaURL(t *testing.T) {
	tests := []struct {
		url      string
		expected bool
	}{
		{"http://localhost:11434", true},
		{"http://127.0.0.1:11434", true},
		{"http://localhost:11434/v1", true},
		{"http://127.0.0.1:11434/api/generate", true},
		{"http://localhost:1234/v1", false},
		{"https://api.openai.com/v1", false},
		{"https://generativelanguage.googleapis.com", false},
		{"", false},
	}

	for _, tt := range tests {
		got := IsOllamaURL(tt.url)
		if got != tt.expected {
			t.Errorf("IsOllamaURL(%q) = %v, want %v", tt.url, got, tt.expected)
		}
	}
}

func TestCheckOllamaHealth(t *testing.T) {
	// 1. Healthy server
	healthyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/tags" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"models": []}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer healthyServer.Close()

	if !CheckOllamaHealth(healthyServer.URL) {
		t.Errorf("expected CheckOllamaHealth to return true for healthy server, got false")
	}

	// 2. Server returning 500 error
	errServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer errServer.Close()

	if CheckOllamaHealth(errServer.URL) {
		t.Errorf("expected CheckOllamaHealth to return false for error server, got true")
	}

	// 3. Completely unreachable port
	if CheckOllamaHealth("http://127.0.0.1:59999") {
		t.Errorf("expected CheckOllamaHealth to return false for unreachable server, got true")
	}
}
