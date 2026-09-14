package llm

import (
	"net/http"
	"strings"
	"time"
)

// DefaultOllamaBaseURL is the default localhost endpoint for Ollama.
const DefaultOllamaBaseURL = "http://127.0.0.1:11434"

// IsOllamaURL reports whether the given URL points to a local Ollama instance.
func IsOllamaURL(baseURL string) bool {
	clean := strings.ToLower(strings.TrimSpace(baseURL))
	return strings.Contains(clean, "127.0.0.1:11434") || strings.Contains(clean, "localhost:11434")
}

// CheckOllamaHealth performs a fast (1.5s timeout) ping to Ollama's /api/tags endpoint.
// It returns true if Ollama is running and responds with HTTP 200 OK.
func CheckOllamaHealth(baseURL string) bool {
	if baseURL == "" {
		baseURL = DefaultOllamaBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	// Normalize to standard root if /v1 was appended
	baseURL = strings.TrimSuffix(baseURL, "/v1")

	url := baseURL + "/api/tags"
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false
	}

	fastPingClient := &http.Client{
		Timeout: 1500 * time.Millisecond,
	}

	resp, err := fastPingClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}
