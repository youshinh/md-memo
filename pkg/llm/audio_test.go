package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQueryAudio_GeminiSuccess(t *testing.T) {
	var gotMime, gotData string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "generateContent") {
			http.NotFound(w, r)
			return
		}
		if key := r.URL.Query().Get("key"); key != "gemini-test-key" {
			t.Errorf("expected key 'gemini-test-key', got %q", key)
		}
		var body struct {
			Contents []struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData *struct {
						MimeType string `json:"mime_type"`
						Data     string `json:"data"`
					} `json:"inline_data"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 2 {
			t.Fatalf("unexpected request shape: %+v", body)
		}
		if body.Contents[0].Parts[1].InlineData == nil {
			t.Fatalf("expected an inline_data audio part")
		}
		gotMime = body.Contents[0].Parts[1].InlineData.MimeType
		gotData = body.Contents[0].Parts[1].InlineData.Data

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{
					"content": map[string]interface{}{
						"parts": []map[string]interface{}{
							{"text": "  今日の会議のメモです  "},
						},
					},
				},
			},
		})
	}))
	defer server.Close()

	cfg := VoiceConfig{
		BaseURL: server.URL + "/v1beta/",
		Model:   "gemini-2.5-flash",
		APIKey:  "gemini-test-key",
	}

	text, err := QueryAudio("", "QUJD", "audio/webm;codecs=opus", cfg)
	if err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
	if text != "今日の会議のメモです" {
		t.Errorf("expected trimmed transcription, got %q", text)
	}
	if gotMime != "audio/webm" {
		t.Errorf("expected codecs parameter stripped to 'audio/webm', got %q", gotMime)
	}
	if gotData != "QUJD" {
		t.Errorf("expected base64 payload forwarded as-is, got %q", gotData)
	}
}

func TestQueryAudio_NonGeminiProviderRejected(t *testing.T) {
	cfg := VoiceConfig{
		BaseURL: "http://localhost:11434",
		Model:   "qwen2.5:latest",
	}
	_, err := QueryAudio("", "QUJD", "audio/wav", cfg)
	if err == nil {
		t.Fatal("expected an error for a non-Gemini provider")
	}
	if !strings.Contains(err.Error(), "voice transcription needs a Gemini model") {
		t.Errorf("unexpected error message: %v", err)
	}
}

func TestQueryAudio_MissingAPIKey(t *testing.T) {
	cfg := VoiceConfig{Model: "gemini-2.5-flash"}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil {
		t.Fatal("expected an error when the API key is missing")
	}
}

func TestQueryAudio_EmptyTranscriptionIsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"candidates": []map[string]interface{}{
				{
					"content": map[string]interface{}{
						"parts": []map[string]interface{}{
							{"text": "   "},
						},
					},
				},
			},
		})
	}))
	defer server.Close()

	cfg := VoiceConfig{
		BaseURL: server.URL + "/v1beta/",
		Model:   "gemini-2.5-flash",
		APIKey:  "gemini-test-key",
	}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil {
		t.Fatal("expected an error for an empty transcription")
	}
}

func TestQueryAudio_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	cfg := VoiceConfig{
		BaseURL: server.URL + "/v1beta/",
		Model:   "gemini-2.5-flash",
		APIKey:  "gemini-test-key",
	}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil {
		t.Fatal("expected an error on a non-200 response")
	}
}
