package llm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const testGeminiKey = "AIzaSyFAKEKEY_1234567890abcdefghijk"

// A hosted-model request that cannot reach the server: net/http answers with an error that holds the whole address, and the
// address holds the API key. What comes out of the exported entry points must not.
func closedServerURL(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.NotFoundHandler())
	addr := server.URL
	server.Close() // nothing listens there any more: connection refused, on loopback, no network involved
	return addr
}

func TestGeminiErrorsNeverCarryTheAPIKey(t *testing.T) {
	base := closedServerURL(t)

	check := func(name string, err error) {
		t.Helper()
		if err == nil {
			t.Fatalf("%s: expected an error, the server is closed", name)
		}
		if strings.Contains(err.Error(), testGeminiKey) || strings.Contains(err.Error(), "key=AIza") {
			t.Errorf("%s: the error carries the API key: %v", name, err)
		}
		host := strings.TrimPrefix(base, "http://")
		if !strings.Contains(err.Error(), host) {
			t.Errorf("%s: the error should still say where it failed (%s): %v", name, host, err)
		}
	}

	_, err := Query("hello", Config{BaseURL: base, Model: "gemini-flash-lite-latest", APIKey: testGeminiKey})
	check("Query", err)

	_, err = QueryVision("what is this", "AAAA", "image/png", VisionConfig{BaseURL: base, Model: "gemini-flash-lite-latest", APIKey: testGeminiKey})
	check("QueryVision", err)

	_, err = QueryAutocomplete("The quick", "", AutocompleteConfig{BaseURL: base, Model: "gemini-flash-lite-latest", APIKey: testGeminiKey, Enabled: true})
	check("QueryAutocomplete", err)

	_, err = QueryAudio("transcribe", "AAAA", "audio/webm", VoiceConfig{BaseURL: base, Model: "gemini-flash-lite-latest", APIKey: testGeminiKey})
	check("QueryAudio", err)

	_, _, err = GenerateImage("a cat", ImageGenConfig{BaseURL: base, Model: "gemini-3.1-flash-lite-image", APIKey: testGeminiKey})
	check("GenerateImage (Gemini)", err)

	_, _, err = GenerateImage("a cat", ImageGenConfig{BaseURL: base, Model: "imagen-4.0-generate-001", APIKey: testGeminiKey})
	check("GenerateImage (Imagen)", err)
}

func TestGeminiErrorBodyThatEchoesTheKeyIsRedacted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":400,"message":"API key not valid: ` + r.URL.Query().Get("key") + `. Please pass a valid API key."}}`))
	}))
	defer server.Close()

	_, err := Query("hello", Config{BaseURL: server.URL, Model: "gemini-flash-lite-latest", APIKey: testGeminiKey})
	if err == nil {
		t.Fatal("expected the 400 to be an error")
	}
	if strings.Contains(err.Error(), testGeminiKey) {
		t.Errorf("the error body echoed the key and it is still in the error: %v", err)
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("the status should stay in the error: %v", err)
	}
}

// RefineVoiceText sends the key in a header, so the address in a connection error has none; a server that quotes the key it was given
// in an error body is the case left, and it must not reach the person either.
func TestRefineVoiceTextErrorBodyThatEchoesTheKeyIsRedacted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":400,"message":"API key not valid: ` + r.Header.Get("x-goog-api-key") + `. Please pass a valid API key."}}`))
	}))
	defer server.Close()

	_, err := RefineVoiceText(context.Background(), "えーと明日の会議", VoiceConfig{BaseURL: server.URL, APIKey: testGeminiKey}, RefineContext{})
	if err == nil {
		t.Fatal("expected the 400 to be an error")
	}
	if strings.Contains(err.Error(), testGeminiKey) {
		t.Errorf("the error body echoed the key and it is still in the error: %v", err)
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("the status should stay in the error: %v", err)
	}
}

func TestScrubKeyErrKeepsTheErrorChain(t *testing.T) {
	if scrubKeyErr(nil, "secret-value") != nil {
		t.Error("nil stays nil")
	}
	plain := errors.New("connection refused")
	if scrubKeyErr(plain, "secret-value") != plain {
		t.Error("an error with no secret is returned as it is")
	}

	inner := &url.Error{Op: "Post", URL: "https://x.example/v1?key=SECRETKEY123", Err: errors.New("EOF")}
	wrapped := scrubKeyErr(inner, "SECRETKEY123")
	if strings.Contains(wrapped.Error(), "SECRETKEY123") {
		t.Errorf("secret still in %v", wrapped)
	}
	var ue *url.Error
	if !errors.As(wrapped, &ue) {
		t.Error("errors.As still finds the *url.Error")
	}

	notConfigured := scrubKeyErr(errNotConfigured("no key SECRETKEY123 set"), "SECRETKEY123")
	if !errors.Is(notConfigured, ErrNotConfigured) {
		t.Error("errors.Is(err, ErrNotConfigured) must keep working for callers that fall back on it")
	}
	if strings.Contains(notConfigured.Error(), "SECRETKEY123") {
		t.Errorf("secret still in %v", notConfigured)
	}
}

func TestRedactSecrets(t *testing.T) {
	cases := []struct {
		in      string
		secrets []string
		want    string
	}{
		{`Post "https://x.example/v1?key=SECRET123&alt=json": EOF`, nil, `Post "https://x.example/v1?key=***&alt=json": EOF`},
		{`failed at ?api_key=abc&x=1`, nil, `failed at ?api_key=***&x=1`},
		{`Post "https://x.example/cb?token=TOK123&x=1": EOF`, nil, `Post "https://x.example/cb?token=***&x=1": EOF`},
		{`GET /v1?a=1&access_token=ACC123 failed`, nil, `GET /v1?a=1&access_token=*** failed`},
		{`bad AIzaSyFAKEKEY_1234567890abcdefghijk here`, nil, `bad *** here`},
		{`Authorization: Bearer abcdefgh12345678`, nil, `Authorization: Bearer ***`},
		{`the key hunter2hunter2 was refused`, []string{"hunter2hunter2"}, `the key *** was refused`},
		{`max_tokens=200 and a monkey=1`, nil, `max_tokens=200 and a monkey=1`},
		{`APIエラー (401): {"error":"nope"}`, nil, `APIエラー (401): {"error":"nope"}`},
		{`short secret ab`, []string{"ab"}, `short secret ab`}, // a secret too short to be one is not replaced everywhere
		{``, nil, ``},
	}
	for _, c := range cases {
		if got := RedactSecrets(c.in, c.secrets...); got != c.want {
			t.Errorf("RedactSecrets(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
