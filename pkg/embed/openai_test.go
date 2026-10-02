package embed

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type oaiItem struct {
	Index     *int      `json:"index,omitempty"`
	Embedding []float32 `json:"embedding"`
}

func idx(i int) *int { return &i }

// openaiEcho answers every text "t<n>" with whichVec(n), the items in reverse order (the API may answer in any order, naming each
// by its index).
func openaiEcho(t *testing.T) func(n int, c captured, w http.ResponseWriter) {
	return func(_ int, c captured, w http.ResponseWriter) {
		var req struct {
			Input []string `json:"input"`
		}
		_ = json.Unmarshal(c.Body, &req)
		var data []oaiItem
		for i := len(req.Input) - 1; i >= 0; i-- {
			data = append(data, oaiItem{Index: idx(i), Embedding: whichVec(numOf(t, req.Input[i]))})
		}
		writeJSON(w, 200, map[string]any{"object": "list", "data": data})
	}
}

func TestOpenAIRequestShape(t *testing.T) {
	// 256 values are asked for, so the (obedient) server answers 256 values: 3, 4 and zeros.
	srv, rec := serve(t, func(_ int, c captured, w http.ResponseWriter) {
		v := make([]float32, 256)
		v[0], v[1] = 3, 4
		writeJSON(w, 200, map[string]any{"data": []oaiItem{{Index: idx(0), Embedding: v}}})
	})
	e := newOpenAI(Config{Model: "text-embedding-3-small", APIKey: "sk-test-key-123", Dimensions: 256}, srv.URL)
	hermetic(e.req)
	if e.Dim() != 256 {
		t.Fatalf("Dim = %d, want the configured 256 before any answer", e.Dim())
	}
	got, err := e.Embed(context.Background(), Document, []Input{{Text: "alpha"}})
	if err != nil {
		t.Fatal(err)
	}
	c := rec.all()[0]
	if c.Method != "POST" || c.Path != "/v1/embeddings" || c.RawQuery != "" {
		t.Fatalf("request line = %s %s?%s", c.Method, c.Path, c.RawQuery)
	}
	if c.Header.Get("Authorization") != "Bearer sk-test-key-123" || c.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("headers = %v", c.Header)
	}
	want := map[string]any{
		"model":           "text-embedding-3-small",
		"input":           []any{"alpha"},
		"dimensions":      float64(256),
		"encoding_format": "float",
	}
	if body := c.json(t); !reflect.DeepEqual(body, want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
	if len(got[0]) != 256 || !near(got[0][0], 0.6) || !near(got[0][1], 0.8) {
		t.Fatalf("vector is not normalized: %v", got[0][:3])
	}
	if e.ID() != "openai|text-embedding-3-small|256" {
		t.Fatalf("ID = %q", e.ID())
	}
	if caps := e.Caps(); !caps.Text || caps.Image || caps.MaxBatch != 64 {
		t.Fatalf("Caps = %+v", caps)
	}
}

func TestOpenAIWithoutDimensionsOrKey(t *testing.T) {
	srv, rec := serve(t, openaiEcho(t))
	e := newOpenAI(Config{Model: "nomic-embed-text-v1.5"}, srv.URL+"/v1")
	hermetic(e.req)
	if e.Dim() != 0 {
		t.Fatalf("Dim before the first answer = %d, want 0", e.Dim())
	}
	if _, err := e.Embed(context.Background(), Query, texts(2)); err != nil {
		t.Fatal(err)
	}
	c := rec.all()[0]
	if c.Path != "/v1/embeddings" || c.Header.Get("Authorization") != "" {
		t.Fatalf("path=%q authorization=%q", c.Path, c.Header.Get("Authorization"))
	}
	body := c.json(t)
	if _, has := body["dimensions"]; has {
		t.Fatalf("dimensions was sent although none is configured: %v", body)
	}
	// nomic wants its search wording; the Query kind is what asks for it.
	if in := body["input"].([]any); in[0] != "search_query: t0" {
		t.Fatalf("query text = %q", in[0])
	}
	if e.Dim() != 2 {
		t.Fatalf("Dim after the first answer = %d", e.Dim())
	}
}

func TestOpenAIResultsFollowTheIndexNotTheOrderOfTheAnswer(t *testing.T) {
	srv, _ := serve(t, openaiEcho(t)) // answers in reverse
	e := newOpenAI(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(5))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 5)
}

func TestOpenAIAnswerWithoutIndexIsReadInOrder(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"data": []oaiItem{{Embedding: whichVec(0)}, {Embedding: whichVec(1)}, {Embedding: whichVec(2)}}})
	})
	e := newOpenAI(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(3))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 3)
}

func TestOpenAIBatchesAreSplitAt64(t *testing.T) {
	srv, rec := serve(t, openaiEcho(t))
	e := newOpenAI(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(130))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 130)
	var sizes []int
	for _, c := range rec.all() {
		sizes = append(sizes, len(c.json(t)["input"].([]any)))
	}
	if !reflect.DeepEqual(sizes, []int{64, 64, 2}) {
		t.Fatalf("batch sizes = %v, want [64 64 2]", sizes)
	}
}

func TestOpenAIDimensionsTheServerIgnoredIsAnError(t *testing.T) {
	srv, _ := serve(t, openaiEcho(t)) // answers 2 values whatever was asked
	e := newOpenAI(Config{Model: "m", Dimensions: 512}, srv.URL)
	hermetic(e.req)
	_, err := e.Embed(context.Background(), Document, texts(1))
	if err == nil || !strings.Contains(err.Error(), "512") || !strings.Contains(err.Error(), "dimensions setting") {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenAIWrongCountIsAnError(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"data": []oaiItem{{Index: idx(0), Embedding: whichVec(0)}}})
	})
	e := newOpenAI(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Document, texts(2)); err == nil || !strings.Contains(err.Error(), "asked for 2 vectors, got 1") {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenAIRefusesAnImage(t *testing.T) {
	srv, rec := serve(t, openaiEcho(t))
	e := newOpenAI(Config{Model: "text-embedding-3-small"}, srv.URL)
	_, err := e.Embed(context.Background(), Document, []Input{{Image: &Image{MIME: "image/jpeg", Data: []byte{1, 2}}}})
	if err == nil || !strings.Contains(err.Error(), "text only") || rec.count() != 0 {
		t.Fatalf("err=%v requests=%d", err, rec.count())
	}
}

func TestOpenAIRetryOn429ThenSuccessAndNoRetryOn400(t *testing.T) {
	srv, rec := serve(t, func(n int, c captured, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "3")
			writeJSON(w, 429, map[string]any{"error": map[string]string{"message": "Rate limit reached"}})
			return
		}
		openaiEcho(t)(n, c, w)
	})
	e := newOpenAI(Config{Model: "m", APIKey: "sk-test-key-123"}, srv.URL)
	slept := hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(2))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 2)
	if rec.count() != 2 || !equalDurations(slept.all(), []time.Duration{3 * time.Second}) {
		t.Fatalf("requests=%d waits=%v", rec.count(), slept.all())
	}

	srv400, rec400 := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 400, map[string]any{"error": map[string]string{"message": "'input' is too long"}})
	})
	e = newOpenAI(Config{Model: "m"}, srv400.URL)
	slept = hermetic(e.req)
	_, err = e.Embed(context.Background(), Document, texts(1))
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 400 || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("error = %v", err)
	}
	if rec400.count() != 1 || len(slept.all()) != 0 {
		t.Fatalf("requests=%d waits=%v, want no retry of a 400", rec400.count(), slept.all())
	}
}

func TestOpenAIKeyNeverInAnError(t *testing.T) {
	const key = "sk-live-QRSTUV0123456789"
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 401, map[string]any{"error": map[string]string{"message": "Incorrect API key provided: " + key + ". You can find your API key at ..."}})
	})
	e := newOpenAI(Config{Model: "m", APIKey: key}, srv.URL)
	hermetic(e.req)
	_, err := e.Embed(context.Background(), Document, texts(1))
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "QRSTUV") {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenAICancelledContext(t *testing.T) {
	srv, rec := serve(t, openaiEcho(t))
	e := newOpenAI(Config{Model: "m"}, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Embed(ctx, Document, texts(3)); !errors.Is(err, context.Canceled) || rec.count() != 0 {
		t.Fatalf("err=%v requests=%d", err, rec.count())
	}
}

func TestOpenAIURLs(t *testing.T) {
	for in, want := range map[string]string{
		"https://api.openai.com/v1":                  "https://api.openai.com/v1/embeddings",
		"https://api.openai.com":                     "https://api.openai.com/v1/embeddings",
		"https://api.openai.com/":                    "https://api.openai.com/v1/embeddings",
		"https://api.openai.com/v1/":                 "https://api.openai.com/v1/embeddings",
		"https://api.openai.com/v1/embeddings":       "https://api.openai.com/v1/embeddings",
		"https://api.openai.com/v1/chat/completions": "https://api.openai.com/v1/embeddings",
		"http://localhost:1234":                      "http://localhost:1234/v1/embeddings",
		"http://localhost:1234/v1":                   "http://localhost:1234/v1/embeddings",
		"http://localhost:11434/v1":                  "http://localhost:11434/v1/embeddings",
		"https://openrouter.ai/api/v1":               "https://openrouter.ai/api/v1/embeddings",
		"https://example.com/v2":                     "https://example.com/v2/embeddings",
		"https://example.com/api":                    "https://example.com/api/v1/embeddings",
		"https://example.com/v1beta":                 "https://example.com/v1beta/embeddings",
		"https://example.com/service":                "https://example.com/service/v1/embeddings",
	} {
		if got := openAIEmbeddingsURL(in); got != want {
			t.Errorf("openAIEmbeddingsURL(%q) = %q, want %q", in, got, want)
		}
	}
}
