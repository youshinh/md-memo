package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// interactionsServer answers POST /v1beta/interactions with reply (a JSON string, or an
// http status via status) and hands every decoded request body to check. Anything else is a 404,
// so a request to the wrong endpoint fails the test.
func interactionsServer(t *testing.T, status int, reply string, check func(r *http.Request, body map[string]interface{})) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/interactions" {
			t.Errorf("unexpected path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]interface{}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("request body is not JSON: %v (%s)", err, raw)
		}
		if check != nil {
			check(r, body)
		}
		w.Header().Set("Content-Type", "application/json")
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(server.Close)
	return server
}

const okInteraction = `{"id":"i1","status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"  今日の会議のメモです  "}]}]}`

func transcriptionConfig(t *testing.T, body map[string]interface{}) map[string]interface{} {
	t.Helper()
	gc, _ := body["generation_config"].(map[string]interface{})
	tc, _ := gc["transcription_config"].(map[string]interface{})
	if tc == nil {
		t.Fatalf("generation_config.transcription_config missing: %v", body)
	}
	return tc
}

// --- Interactions style ------------------------------------------------------------------------

func TestQueryAudio_InteractionsRequestShape(t *testing.T) {
	var calls int32
	server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
		atomic.AddInt32(&calls, 1)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("x-goog-api-key"); got != "gemini-test-key" {
			t.Errorf("x-goog-api-key = %q", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		if r.URL.Query().Get("key") != "" {
			t.Errorf("the key must travel in the header, not the URL: %s", r.URL.String())
		}
		if body["model"] != "gemini-3.5-transcribe" {
			t.Errorf("model = %v, want the default gemini-3.5-transcribe", body["model"])
		}
		if store, ok := body["store"]; !ok || store != false {
			t.Errorf("store must be sent as false so Google does not keep the recording, got %v (present=%v)", store, ok)
		}
		input, _ := body["input"].([]interface{})
		if len(input) != 1 {
			t.Fatalf("input = %v, want one audio item", body["input"])
		}
		item, _ := input[0].(map[string]interface{})
		if item["type"] != "audio" || item["data"] != "QUJD" || item["mime_type"] != "audio/webm" {
			t.Errorf("audio input = %v", item)
		}
		tc := transcriptionConfig(t, body)
		if tc["mode"] != "smart" {
			t.Errorf("mode = %v, want the bare string \"smart\"", tc["mode"])
		}
		if _, present := tc["language_codes"]; present {
			t.Errorf("empty language_codes must be omitted (auto-detect): %v", tc)
		}
		if _, present := tc["custom_vocabulary"]; present {
			t.Errorf("empty custom_vocabulary must be omitted: %v", tc)
		}
		if _, present := body["contents"]; present {
			t.Errorf("the generateContent shape must not leak into an interactions request: %v", body)
		}
	})

	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "gemini-test-key"}
	text, err := QueryAudio("", "QUJD", "audio/webm;codecs=opus", cfg)
	if err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
	if text != "今日の会議のメモです" {
		t.Errorf("text = %q, want the trimmed transcript", text)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Errorf("expected exactly one request, got %d", calls)
	}
}

func TestQueryAudio_InteractionsOptionsAreForwarded(t *testing.T) {
	server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
		tc := transcriptionConfig(t, body)
		if want := []interface{}{"ja-JP", "en-US"}; !reflect.DeepEqual(tc["language_codes"], want) {
			t.Errorf("language_codes = %v, want %v (trimmed, blanks and duplicates dropped)", tc["language_codes"], want)
		}
		if want := []interface{}{"Kubernetes", "BigQuery"}; !reflect.DeepEqual(tc["custom_vocabulary"], want) {
			t.Errorf("custom_vocabulary = %v, want %v", tc["custom_vocabulary"], want)
		}
		if want := map[string]interface{}{"type": "verbatim"}; !reflect.DeepEqual(tc["mode"], want) {
			t.Errorf("mode = %v, want the verbatim object %v", tc["mode"], want)
		}
	})

	cfg := VoiceConfig{
		BaseURL:          server.URL,
		APIKey:           "k",
		Model:            "gemini-3.5-transcribe",
		LanguageCodes:    []string{"ja-JP", " en-US ", "", "ja-JP"},
		CustomVocabulary: []string{"Kubernetes", "  BigQuery ", "Kubernetes", " "},
		Mode:             "Verbatim",
	}
	if _, err := QueryAudio("", "QUJD", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
}

func TestQueryAudio_InteractionsCapsVocabularyAtTheAPILimit(t *testing.T) {
	server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
		vocab, _ := transcriptionConfig(t, body)["custom_vocabulary"].([]interface{})
		if len(vocab) != 1000 {
			t.Errorf("custom_vocabulary has %d terms, want it capped at 1000", len(vocab))
		}
	})

	terms := make([]string, 1200)
	for i := range terms {
		terms[i] = fmt.Sprintf("term-%d", i)
	}
	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k", CustomVocabulary: terms}
	if _, err := QueryAudio("", "QUJD", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
}

func TestQueryAudio_InteractionsIgnoresThePrompt(t *testing.T) {
	server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "SECRET-PROMPT") {
			t.Errorf("the interactions style has no prompt; it leaked into the request: %s", raw)
		}
	})

	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k", Prompt: "SECRET-PROMPT config"}
	if _, err := QueryAudio("SECRET-PROMPT argument", "QUJD", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
}

func TestQueryAudio_InteractionsStripsDataURLPrefix(t *testing.T) {
	server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
		input, _ := body["input"].([]interface{})
		item, _ := input[0].(map[string]interface{})
		if item["data"] != "QUJD" {
			t.Errorf("data = %v, want the bare base64 payload", item["data"])
		}
	})

	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k"}
	if _, err := QueryAudio("", " data:audio/webm;base64,QUJD ", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
}

func TestQueryAudio_InteractionsMIMENormalization(t *testing.T) {
	cases := []struct{ in, want string }{
		{"audio/webm;codecs=opus", "audio/webm"},
		{"audio/webm; codecs=opus", "audio/webm"},
		{"", "audio/webm"},
		{"video/webm", "audio/webm"}, // what Go's sniffer reports for a phone's WebM recording
		{"application/ogg", "audio/ogg"},
		{"audio/mp4", "audio/m4a"},
		{"audio/x-m4a", "audio/m4a"},
		{"audio/x-wav", "audio/wav"},
		{"audio/wave", "audio/wav"},
		{"audio/x-aac", "audio/aac"},
		{"audio/x-flac", "audio/flac"},
		{"audio/mpeg", "audio/mpeg"},
		{"audio/ogg", "audio/ogg"},
		{"audio/l16", "audio/l16"},
		{"audio/something-new", "audio/something-new"},
	}
	for _, c := range cases {
		var got string
		server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
			input, _ := body["input"].([]interface{})
			item, _ := input[0].(map[string]interface{})
			got, _ = item["mime_type"].(string)
		})
		cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k"}
		if _, err := QueryAudio("", "QUJD", c.in, cfg); err != nil {
			t.Fatalf("mime %q: QueryAudio failed: %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("mime %q was sent as %q, want %q", c.in, got, c.want)
		}
	}
}

func TestQueryAudio_InteractionsResponseVariants(t *testing.T) {
	cases := []struct {
		name    string
		reply   string
		want    string
		wantErr string
	}{
		{
			name:  "text of every model_output step is concatenated",
			reply: `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Hello "},{"type":"text","text":"wor"}]},{"type":"model_output","content":[{"type":"text","text":"ld"}]}]}`,
			want:  "Hello world",
		},
		{
			name:  "other step types and non-text items are ignored",
			reply: `{"status":"completed","steps":[{"type":"thought","content":[{"type":"text","text":"SECRET"}]},{"type":"model_output","content":[{"type":"image","text":"NOPE"},{"type":"text","text":"kept"}]}]}`,
			want:  "kept",
		},
		{
			name:  "a top-level output_text wins over the steps",
			reply: `{"status":"completed","output_text":"from output_text","steps":[{"type":"model_output","content":[{"type":"text","text":"from steps"}]}]}`,
			want:  "from output_text",
		},
		{
			name:  "output_text alone is enough, and status may be absent",
			reply: `{"output_text":"  bare  "}`,
			want:  "bare",
		},
		{
			name:  "word annotations do not disturb the transcript",
			reply: `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Hello world","annotations":[{"type":"word_info","text":"Hello","start_offset":"0.1s"}]}]}]}`,
			want:  "Hello world",
		},
		{
			name:  "an empty error object is not an error",
			reply: `{"status":"completed","error":{},"steps":[{"type":"model_output","content":[{"type":"text","text":"fine"}]}]}`,
			want:  "fine",
		},
		{
			name:    "a status other than completed is an error",
			reply:   `{"status":"in_progress","steps":[{"type":"model_output","content":[{"type":"text","text":"partial"}]}]}`,
			wantErr: "in_progress",
		},
		{
			name:    "incomplete results are an error too",
			reply:   `{"status":"incomplete","output_text":"cut off"}`,
			wantErr: "incomplete",
		},
		{
			name:    "the API's own message is surfaced",
			reply:   `{"status":"failed","error":{"code":400,"message":"audio could not be decoded"}}`,
			wantErr: "audio could not be decoded",
		},
		{
			name:    "an error object without a status is still an error",
			reply:   `{"error":{"message":"quota exhausted"},"output_text":"ignored"}`,
			wantErr: "quota exhausted",
		},
		{
			name:    "a bare-string error is surfaced",
			reply:   `{"status":"completed","error":"plain failure"}`,
			wantErr: "plain failure",
		},
		{
			name:    "no steps and no text means the clip held no speech",
			reply:   `{"status":"completed","steps":[]}`,
			wantErr: "話し声が検出されませんでした",
		},
		{
			name:    "a completed answer without any output field is the same no-speech error (what a silent recording returns)",
			reply:   `{"status":"completed","usage":{"total_input_tokens":61,"total_output_tokens":0},"object":"interaction"}`,
			wantErr: "話し声が検出されませんでした",
		},
		{
			name:    "a blank transcript is no speech either",
			reply:   `{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"   "}]}]}`,
			wantErr: "話し声が検出されませんでした",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := interactionsServer(t, 0, c.reply, nil)
			cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k"}
			got, err := QueryAudio("", "QUJD", "audio/webm", cfg)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("err = %v, want it to contain %q", err, c.wantErr)
				}
				if errors.Is(err, ErrNotConfigured) {
					t.Errorf("a response problem is not a configuration problem: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Errorf("text = %q, want %q", got, c.want)
			}
		})
	}
}

func TestQueryAudio_InteractionsHTTPError(t *testing.T) {
	server := interactionsServer(t, http.StatusBadRequest, `{"error":{"message":"bad request"}}`, nil)
	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k"}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil || !strings.Contains(err.Error(), "Gemini APIエラー (400)") || !strings.Contains(err.Error(), "bad request") {
		t.Fatalf("err = %v, want the status and the body", err)
	}
	if errors.Is(err, ErrNotConfigured) {
		t.Errorf("an HTTP failure must stay a plain error: %v", err)
	}
}

func TestQueryAudio_InteractionsBaseURLVariants(t *testing.T) {
	for _, suffix := range []string{"", "/", "/v1beta", "/v1beta/", "/v1", "/v1/"} {
		var calls int32
		server := interactionsServer(t, 0, okInteraction, func(r *http.Request, body map[string]interface{}) {
			atomic.AddInt32(&calls, 1)
		})
		cfg := VoiceConfig{BaseURL: server.URL + suffix, APIKey: "k"}
		if _, err := QueryAudio("", "QUJD", "audio/webm", cfg); err != nil {
			t.Errorf("base URL suffix %q: %v", suffix, err)
			continue
		}
		if atomic.LoadInt32(&calls) != 1 {
			t.Errorf("base URL suffix %q: %d requests, want 1", suffix, calls)
		}
	}
}

func TestGeminiAPIBase(t *testing.T) {
	cases := map[string]string{
		"": "https://generativelanguage.googleapis.com",
		"https://generativelanguage.googleapis.com":         "https://generativelanguage.googleapis.com",
		"https://generativelanguage.googleapis.com/":        "https://generativelanguage.googleapis.com",
		"https://generativelanguage.googleapis.com/v1beta":  "https://generativelanguage.googleapis.com",
		"https://generativelanguage.googleapis.com/v1beta/": "https://generativelanguage.googleapis.com",
		"http://proxy.local:8080/gemini/v1beta":             "http://proxy.local:8080/gemini",
	}
	for in, want := range cases {
		if got := geminiAPIBase(in); got != want {
			t.Errorf("geminiAPIBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- generateContent style (the pre-existing path, kept unchanged) ------------------------------

func TestQueryAudio_GenerateContentSuccess(t *testing.T) {
	var gotMime, gotData, gotPrompt string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "generateContent") {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/v1beta/models/gemini-2.5-flash:generateContent" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if key := r.URL.Query().Get("key"); key != "gemini-test-key" {
			t.Errorf("expected key 'gemini-test-key', got %q", key)
		}
		if r.Header.Get("x-goog-api-key") != "" {
			t.Errorf("the generateContent style keeps the key in the query string")
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
			Store *bool `json:"store"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Store != nil {
			t.Errorf("store belongs to the interactions API only")
		}
		if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 2 {
			t.Fatalf("unexpected request shape: %+v", body)
		}
		if body.Contents[0].Parts[1].InlineData == nil {
			t.Fatalf("expected an inline_data audio part")
		}
		gotPrompt = body.Contents[0].Parts[0].Text
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
	if gotPrompt != "この音声を正確に文字起こししてください。" {
		t.Errorf("default prompt = %q", gotPrompt)
	}
}

func TestQueryAudio_GenerateContentMIMEIsOnlyStripped(t *testing.T) {
	var gotMime string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Contents []struct {
				Parts []struct {
					InlineData *struct {
						MimeType string `json:"mime_type"`
					} `json:"inline_data"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotMime = body.Contents[0].Parts[1].InlineData.MimeType
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`)
	}))
	defer server.Close()

	cfg := VoiceConfig{BaseURL: server.URL, Model: "gemini-2.5-flash", APIKey: "k"}
	if _, err := QueryAudio("", "QUJD", "audio/mp4", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
	if gotMime != "audio/mp4" {
		t.Errorf("the old path must keep sending the type as given, got %q", gotMime)
	}
}

func TestQueryAudio_GenerateContentPromptPrecedence(t *testing.T) {
	var gotPrompt string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Contents []struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotPrompt = body.Contents[0].Parts[0].Text
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`)
	}))
	defer server.Close()

	cfg := VoiceConfig{BaseURL: server.URL, Model: "gemini-2.5-flash", APIKey: "k", Prompt: "config prompt"}
	if _, err := QueryAudio("", "QUJD", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
	if gotPrompt != "config prompt" {
		t.Errorf("prompt = %q, want the config prompt when the argument is empty", gotPrompt)
	}
	if _, err := QueryAudio("argument prompt", "QUJD", "audio/webm", cfg); err != nil {
		t.Fatalf("QueryAudio failed: %v", err)
	}
	if gotPrompt != "argument prompt" {
		t.Errorf("prompt = %q, want the argument to win", gotPrompt)
	}
}

func TestQueryAudio_GenerateContentEmptyTranscriptionIsError(t *testing.T) {
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
	if err == nil || !strings.Contains(err.Error(), "文字起こし結果が空でした") {
		t.Fatalf("err = %v, want the empty-transcription error", err)
	}
}

func TestQueryAudio_GenerateContentAPIError(t *testing.T) {
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
	if err == nil || !strings.Contains(err.Error(), "Gemini APIエラー (500): boom") {
		t.Fatalf("err = %v, want the status and body", err)
	}
	if errors.Is(err, ErrNotConfigured) {
		t.Errorf("an HTTP failure must stay a plain error: %v", err)
	}
}

// --- style selection ------------------------------------------------------------------------------

func TestQueryAudio_StyleSelection(t *testing.T) {
	cases := []struct {
		name     string
		model    string
		style    string
		wantPath string
	}{
		{"default model is a transcribe model", "", "", "/v1beta/interactions"},
		{"auto keyword", "gemini-3.5-transcribe", "auto", "/v1beta/interactions"},
		{"auto matches any transcribe model", "gemini-4-transcribe-preview", "", "/v1beta/interactions"},
		{"auto sends other models through generateContent", "gemini-2.5-flash", "auto", "/v1beta/models/gemini-2.5-flash:generateContent"},
		{"lite model", "gemini-flash-lite-latest", "", "/v1beta/models/gemini-flash-lite-latest:generateContent"},
		{"explicit interactions overrides the model name", "gemini-2.5-flash", "interactions", "/v1beta/interactions"},
		{"explicit generateContent overrides the model name", "gemini-3.5-transcribe", "generateContent", "/v1beta/models/gemini-3.5-transcribe:generateContent"},
		{"style names are case-insensitive", "gemini-3.5-transcribe", "GenerateContent", "/v1beta/models/gemini-3.5-transcribe:generateContent"},
		{"and so is interactions", "gemini-2.5-flash", " Interactions ", "/v1beta/interactions"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotPath string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				if strings.HasSuffix(r.URL.Path, "/interactions") {
					_, _ = io.WriteString(w, okInteraction)
					return
				}
				_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`)
			}))
			defer server.Close()

			cfg := VoiceConfig{BaseURL: server.URL, Model: c.model, APIStyle: c.style, APIKey: "k"}
			if _, err := QueryAudio("", "QUJD", "audio/webm", cfg); err != nil {
				t.Fatalf("QueryAudio failed: %v", err)
			}
			if gotPath != c.wantPath {
				t.Errorf("hit %q, want %q", gotPath, c.wantPath)
			}
		})
	}
}

func TestQueryAudio_UnknownStyleListsTheValidOnes(t *testing.T) {
	cfg := VoiceConfig{BaseURL: "http://127.0.0.1:1", APIKey: "k", APIStyle: "whisper"}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil {
		t.Fatal("expected an error for an unknown API style")
	}
	for _, want := range []string{"whisper", "auto", "interactions", "generateContent"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should mention %q", err, want)
		}
	}
	if !errors.Is(err, ErrNotConfigured) {
		t.Errorf("an unusable setting is a configuration problem: %v", err)
	}
}

func TestQueryAudio_UnknownModeIsRejectedBeforeSending(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	}))
	defer server.Close()

	cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k", Mode: "fast"}
	_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
	if err == nil || !strings.Contains(err.Error(), "smart") || !strings.Contains(err.Error(), "verbatim") {
		t.Fatalf("err = %v, want it to list smart / verbatim", err)
	}
	if !errors.Is(err, ErrNotConfigured) {
		t.Errorf("an unusable setting is a configuration problem: %v", err)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Errorf("nothing should be sent for an invalid mode")
	}
}

func TestQueryAudio_LiveModelIsRejectedWithAHint(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
	}))
	defer server.Close()

	for _, style := range []string{"", "interactions", "generateContent"} {
		cfg := VoiceConfig{BaseURL: server.URL, APIKey: "k", Model: "gemini-3.5-transcribe-live", APIStyle: style}
		_, err := QueryAudio("", "QUJD", "audio/webm", cfg)
		if err == nil {
			t.Fatalf("style %q: expected an error for the Live model", style)
		}
		if !strings.Contains(err.Error(), "gemini-3.5-transcribe-live") || !strings.Contains(err.Error(), DefaultVoiceModel) {
			t.Errorf("style %q: the error should name the live model and the model to use: %v", style, err)
		}
		if !errors.Is(err, ErrNotConfigured) {
			t.Errorf("style %q: a model that cannot work is a configuration problem: %v", style, err)
		}
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Errorf("a live model must be refused before any request is made")
	}
}

func TestIsLiveVoiceModel(t *testing.T) {
	live := []string{"gemini-3.5-transcribe-live", "models/gemini-live-2.5-flash-preview", "gemini-2.0-flash-live-001", "Gemini-Live"}
	for _, m := range live {
		if !isLiveVoiceModel(m) {
			t.Errorf("%q should be recognised as a Live model", m)
		}
	}
	notLive := []string{"gemini-3.5-transcribe", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-delivery-model", ""}
	for _, m := range notLive {
		if isLiveVoiceModel(m) {
			t.Errorf("%q must not be treated as a Live model", m)
		}
	}
}

// --- ErrNotConfigured --------------------------------------------------------------------------

func TestQueryAudio_NotConfiguredErrors(t *testing.T) {
	cases := []struct {
		name    string
		cfg     VoiceConfig
		wantMsg string
	}{
		{"no key with the default model", VoiceConfig{}, "Gemini API Keyが設定されていません"},
		{"no key with a general model", VoiceConfig{Model: "gemini-2.5-flash"}, "Gemini API Keyが設定されていません"},
		{"non-Gemini provider", VoiceConfig{BaseURL: "http://localhost:11434", Model: "qwen2.5:latest"}, "voice transcription needs a Gemini model"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := QueryAudio("", "QUJD", "audio/webm", c.cfg)
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

func TestErrNotConfiguredClassification(t *testing.T) {
	wrapped := fmt.Errorf("outer: %w", errNotConfigured("inner message"))
	if !errors.Is(wrapped, ErrNotConfigured) {
		t.Error("a wrapped not-configured error must still match")
	}
	if got := errNotConfigured("inner message").Error(); got != "inner message" {
		t.Errorf("Error() = %q, the human text must be untouched", got)
	}
	if errors.Is(errors.New("Gemini API Keyが設定されていません"), ErrNotConfigured) {
		t.Error("classification must come from the type, not from the message text")
	}
	if errors.Is(errNotConfigured("x"), errors.New("not configured")) {
		t.Error("only the sentinel itself matches")
	}
}
