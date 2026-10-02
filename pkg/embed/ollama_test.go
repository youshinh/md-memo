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

// ollamaEcho answers every text "t<n>" with whichVec(n).
func ollamaEcho(t *testing.T) func(n int, c captured, w http.ResponseWriter) {
	return func(_ int, c captured, w http.ResponseWriter) {
		var req struct {
			Input []string `json:"input"`
		}
		_ = json.Unmarshal(c.Body, &req)
		out := make([][]float32, len(req.Input))
		for i, s := range req.Input {
			out[i] = whichVec(numOf(t, s))
		}
		writeJSON(w, 200, map[string]any{"model": "m", "embeddings": out})
	}
}

func TestOllamaRequestShape(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": [][]float32{{3, 4}, {0, 2}}})
	})
	e := newOllama(Config{Model: "bge-m3"}, srv.URL)
	hermetic(e.req)
	if e.Dim() != 0 {
		t.Fatalf("Dim before the first answer = %d, want 0", e.Dim())
	}

	got, err := e.Embed(context.Background(), Document, []Input{{Text: "alpha"}, {Text: "beta"}})
	if err != nil {
		t.Fatal(err)
	}
	reqs := rec.all()
	if len(reqs) != 1 {
		t.Fatalf("requests = %d, want 1", len(reqs))
	}
	c := reqs[0]
	if c.Method != "POST" || c.Path != "/api/embed" || c.RawQuery != "" {
		t.Fatalf("request line = %s %s?%s", c.Method, c.Path, c.RawQuery)
	}
	if c.Header.Get("Content-Type") != "application/json" || c.Header.Get("Authorization") != "" {
		t.Fatalf("headers = %v", c.Header)
	}
	want := map[string]any{
		"model":      "bge-m3",
		"input":      []any{"alpha", "beta"},
		"truncate":   true,
		"keep_alive": "5m",
		"options":    map[string]any{},
	}
	if body := c.json(t); !reflect.DeepEqual(body, want) {
		t.Fatalf("body = %v, want %v", body, want)
	}

	// The answer is normalized, one vector per input, in order.
	if len(got) != 2 || !near(got[0][0], 0.6) || !near(got[0][1], 0.8) || !near(got[1][0], 0) || !near(got[1][1], 1) {
		t.Fatalf("vectors = %v, want [[0.6 0.8] [0 1]]", got)
	}
	if e.Dim() != 2 {
		t.Fatalf("Dim after the first answer = %d, want 2", e.Dim())
	}
	if e.ID() != "ollama|bge-m3|0" {
		t.Fatalf("ID = %q", e.ID())
	}
	if caps := e.Caps(); !caps.Text || caps.Image || caps.MaxBatch != 32 {
		t.Fatalf("Caps = %+v", caps)
	}
}

func TestOllamaIDIsStableBeforeAndAfterTheFirstAnswer(t *testing.T) {
	srv, _ := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m", Dimensions: 0}, srv.URL)
	hermetic(e.req)
	before := e.ID()
	if _, err := e.Embed(context.Background(), Query, texts(1)); err != nil {
		t.Fatal(err)
	}
	if e.ID() != before {
		t.Fatalf("ID changed from %q to %q once the dimension was learnt", before, e.ID())
	}
}

func TestOllamaBatchesAreSplitAndKeepTheirOrder(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(70))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 70)
	var sizes []int
	for _, c := range rec.all() {
		sizes = append(sizes, len(c.json(t)["input"].([]any)))
	}
	if !reflect.DeepEqual(sizes, []int{32, 32, 6}) {
		t.Fatalf("batch sizes = %v, want [32 32 6]", sizes)
	}
}

func TestOllamaNothingToEmbedSendsNothing(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m"}, srv.URL)
	got, err := e.Embed(context.Background(), Query, nil)
	if err != nil || len(got) != 0 || rec.count() != 0 {
		t.Fatalf("got=%v err=%v requests=%d", got, err, rec.count())
	}
}

func TestOllamaDimensionsCutAndRenormalize(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": [][]float32{{0.5, 0.5, 0.5, 0.5}}})
	})
	e := newOllama(Config{Model: "nomic-embed-text", Dimensions: 2}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(1))
	if err != nil {
		t.Fatal(err)
	}
	if len(got[0]) != 2 || !near(got[0][0], 0.70710678) || !near(got[0][1], 0.70710678) || !isUnit(got[0]) {
		t.Fatalf("vector = %v, want the first 2 values scaled back to length 1", got[0])
	}
	if e.Dim() != 2 || e.ID() != "ollama|nomic-embed-text|2" {
		t.Fatalf("Dim=%d ID=%q", e.Dim(), e.ID())
	}

	// A Dimensions bigger than the model's vectors changes nothing.
	e = newOllama(Config{Model: "m", Dimensions: 8}, srv.URL)
	hermetic(e.req)
	got, err = e.Embed(context.Background(), Document, texts(1))
	if err != nil || len(got[0]) != 4 || !isUnit(got[0]) {
		t.Fatalf("got=%v err=%v", got, err)
	}
}

func TestOllamaRefusesAnImageBeforeSendingAnything(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "bge-m3"}, srv.URL)
	_, err := e.Embed(context.Background(), Document, []Input{{Text: "t1"}, {Image: &Image{MIME: "image/png", Data: []byte{1}}}})
	if err == nil || !strings.Contains(err.Error(), "image") || !strings.Contains(err.Error(), "text only") {
		t.Fatalf("error = %v, want a clear refusal of the image", err)
	}
	if rec.count() != 0 {
		t.Fatalf("%d requests were sent although an input was refused", rec.count())
	}
}

func TestOllamaRefusesEmptyAndDoubleInputs(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m"}, srv.URL)
	for name, in := range map[string][]Input{
		"empty":      {{Text: "t1"}, {Text: "  \n"}},
		"text+image": {{Text: "t1", Image: &Image{MIME: "image/png", Data: []byte{1}}}},
	} {
		if _, err := e.Embed(context.Background(), Document, in); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if rec.count() != 0 {
		t.Fatalf("%d requests were sent", rec.count())
	}
}

func TestOllamaKeyGoesInAHeaderOnlyWhenSet(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m", APIKey: "proxy-key-123"}, srv.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Document, texts(1)); err != nil {
		t.Fatal(err)
	}
	c := rec.all()[0]
	if c.Header.Get("Authorization") != "Bearer proxy-key-123" || strings.Contains(c.RawQuery, "proxy-key") {
		t.Fatalf("headers=%v query=%q", c.Header, c.RawQuery)
	}
}

func TestOllamaWordingForAModelThatWantsIt(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "hf.co/x/multilingual-e5-large-GGUF:Q8_0"}, srv.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Query, texts(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Embed(context.Background(), Document, texts(1)); err != nil {
		t.Fatal(err)
	}
	reqs := rec.all()
	if q := reqs[0].json(t)["input"].([]any)[0]; q != "query: t0" {
		t.Fatalf("query was sent as %q", q)
	}
	if d := reqs[1].json(t)["input"].([]any)[0]; d != "passage: t0" {
		t.Fatalf("document was sent as %q", d)
	}

	// bge-m3 wants none.
	e = newOllama(Config{Model: "bge-m3"}, srv.URL)
	hermetic(e.req)
	_, _ = e.Embed(context.Background(), Query, texts(1))
	if q := rec.all()[2].json(t)["input"].([]any)[0]; q != "t0" {
		t.Fatalf("bge-m3 query was sent as %q", q)
	}
}

func TestOllamaRetriesAndGivesUpAsTheContractSays(t *testing.T) {
	srv, rec := serve(t, func(n int, c captured, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, 429, map[string]string{"error": "busy"})
			return
		}
		ollamaEcho(t)(n, c, w)
	})
	e := newOllama(Config{Model: "m"}, srv.URL)
	slept := hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(2))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 2)
	if rec.count() != 2 || !equalDurations(slept.all(), []time.Duration{time.Second}) {
		t.Fatalf("requests=%d waits=%v", rec.count(), slept.all())
	}

	// A model that is not pulled is a 404 that says so, and is not retried.
	srv404, rec404 := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 404, map[string]string{"error": `model "nope" not found, try pulling it first`})
	})
	e = newOllama(Config{Model: "nope"}, srv404.URL)
	hermetic(e.req)
	_, err = e.Embed(context.Background(), Document, texts(1))
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 404 || !strings.Contains(err.Error(), "not found") || rec404.count() != 1 {
		t.Fatalf("err=%v requests=%d", err, rec404.count())
	}
}

func TestOllamaWrongCountAndChangedDimensionAreErrors(t *testing.T) {
	srv, _ := serve(t, func(n int, _ captured, w http.ResponseWriter) {
		switch n {
		case 1:
			writeJSON(w, 200, map[string]any{"embeddings": [][]float32{{1, 0}}})
		case 2:
			writeJSON(w, 200, map[string]any{"embeddings": [][]float32{{1, 0, 0}}})
		default:
			writeJSON(w, 200, map[string]any{"embeddings": [][]float32{}})
		}
	})
	e := newOllama(Config{Model: "m"}, srv.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Document, texts(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Embed(context.Background(), Document, texts(1)); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("error = %v, want the changed dimension to be reported", err)
	}
	if _, err := e.Embed(context.Background(), Document, texts(1)); err == nil || !strings.Contains(err.Error(), "asked for 1 vectors, got 0") {
		t.Fatalf("error = %v, want the wrong count to be reported", err)
	}
}

func TestOllamaKeyNeverInAnError(t *testing.T) {
	const key = "proxy-key-ZZZ-987654"
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 401, map[string]string{"error": "bad token " + key})
	})
	e := newOllama(Config{Model: "m", APIKey: key}, srv.URL)
	hermetic(e.req)
	_, err := e.Embed(context.Background(), Document, texts(1))
	if err == nil || strings.Contains(err.Error(), key) {
		t.Fatalf("error = %v", err)
	}
}

func TestOllamaCancelledContext(t *testing.T) {
	srv, rec := serve(t, ollamaEcho(t))
	e := newOllama(Config{Model: "m"}, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Embed(ctx, Document, texts(3)); !errors.Is(err, context.Canceled) || rec.count() != 0 {
		t.Fatalf("err=%v requests=%d", err, rec.count())
	}
}

func TestOllamaURLs(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:11434":           "http://localhost:11434/api/embed",
		"http://localhost:11434/":          "http://localhost:11434/api/embed",
		"http://localhost:11434/api":       "http://localhost:11434/api/embed",
		"http://localhost:11434/api/embed": "http://localhost:11434/api/embed",
		"http://localhost:11434/v1":        "http://localhost:11434/api/embed",
		"https://ollama.example.com/x":     "https://ollama.example.com/x/api/embed",
	} {
		if got := ollamaEmbedURL(in); got != want {
			t.Errorf("ollamaEmbedURL(%q) = %q, want %q", in, got, want)
		}
	}
}
