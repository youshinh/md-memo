package embed

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testGeminiKey = "AIzaSyTESTKEY0123456789abcdefg"

type geminiTestReq struct {
	Model    string `json:"model"`
	TaskType string `json:"taskType"`
	Content  struct {
		Parts []struct {
			Text       string `json:"text"`
			InlineData *struct {
				MimeType string `json:"mimeType"`
				Data     string `json:"data"`
			} `json:"inlineData"`
		} `json:"parts"`
	} `json:"content"`
}

// geminiEcho answers each embedding of a batch with whichVec(n), where n is read from the text ("...t17") or from the bytes of
// the image ("img17").
func geminiEcho(t *testing.T) func(n int, c captured, w http.ResponseWriter) {
	return func(_ int, c captured, w http.ResponseWriter) {
		var req struct {
			Requests []geminiTestReq `json:"requests"`
		}
		if err := json.Unmarshal(c.Body, &req); err != nil {
			t.Errorf("bad request body: %v", err)
		}
		var out []map[string]any
		for _, r := range req.Requests {
			p := r.Content.Parts[0]
			n := 0
			if p.InlineData != nil {
				raw, _ := base64.StdEncoding.DecodeString(p.InlineData.Data)
				n, _ = strconv.Atoi(strings.TrimPrefix(string(raw), "img"))
			} else {
				n = numOf(t, p.Text)
			}
			out = append(out, map[string]any{"values": whichVec(n)})
		}
		writeJSON(w, 200, map[string]any{"embeddings": out})
	}
}

func geminiPNG(n int) *Image {
	return &Image{MIME: "image/png", Data: []byte("img" + strconv.Itoa(n))}
}

func TestGemini001RequestShape(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": []map[string]any{{"values": []float32{3, 0, 4}}}})
	})
	e := newGemini(Config{Model: "gemini-embedding-001", APIKey: testGeminiKey, Dimensions: 3}, srv.URL)
	hermetic(e.req)
	if e.Dim() != 3 {
		t.Fatalf("Dim = %d, want the configured 3 before the first answer", e.Dim())
	}

	got, err := e.Embed(context.Background(), Query, []Input{{Text: "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	c := rec.all()[0]
	if c.Method != "POST" || c.Path != "/v1beta/models/gemini-embedding-001:batchEmbedContents" {
		t.Fatalf("request line = %s %s", c.Method, c.Path)
	}
	if c.RawQuery != "" {
		t.Fatalf("the URL carries a query (%q): the key must travel in a header only", c.RawQuery)
	}
	if c.Header.Get("x-goog-api-key") != testGeminiKey || c.Header.Get("Authorization") != "" || c.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("headers = %v", c.Header)
	}
	want := map[string]any{"requests": []any{map[string]any{
		"model":                "models/gemini-embedding-001",
		"content":              map[string]any{"parts": []any{map[string]any{"text": "hello"}}},
		"taskType":             "RETRIEVAL_QUERY",
		"outputDimensionality": float64(3),
	}}}
	if body := c.json(t); !reflect.DeepEqual(body, want) {
		t.Fatalf("body = %v\nwant %v", body, want)
	}
	// A vector of fewer than 3072 values comes back unnormalized from gemini-embedding-001: it is normalized here.
	if !near(got[0][0], 0.6) || !near(got[0][1], 0) || !near(got[0][2], 0.8) {
		t.Fatalf("vector = %v, want [0.6 0 0.8]", got[0])
	}
	if e.ID() != "gemini|gemini-embedding-001|3" {
		t.Fatalf("ID = %q", e.ID())
	}
	if caps := e.Caps(); !caps.Text || caps.Image || caps.MaxBatch != 100 {
		t.Fatalf("Caps = %+v", caps)
	}

	// A document is told from a query by its task type.
	if _, err := e.Embed(context.Background(), Document, []Input{{Text: "hello"}}); err != nil {
		t.Fatal(err)
	}
	var req geminiTestReqBatch
	_ = json.Unmarshal(rec.all()[1].Body, &req)
	if req.Requests[0].TaskType != "RETRIEVAL_DOCUMENT" {
		t.Fatalf("document task type = %q", req.Requests[0].TaskType)
	}
}

type geminiTestReqBatch struct {
	Requests []geminiTestReq `json:"requests"`
}

func TestGemini2UsesWordingInTheTextNotATaskType(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	if e.Dim() != 0 {
		t.Fatalf("Dim = %d, want 0 until known", e.Dim())
	}
	if _, err := e.Embed(context.Background(), Document, texts(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Embed(context.Background(), Query, texts(1)); err != nil {
		t.Fatal(err)
	}
	reqs := rec.all()
	doc := reqs[0].json(t)["requests"].([]any)[0].(map[string]any)
	qry := reqs[1].json(t)["requests"].([]any)[0].(map[string]any)
	for name, r := range map[string]map[string]any{"document": doc, "query": qry} {
		if _, has := r["taskType"]; has {
			t.Errorf("%s: gemini-embedding-2 must not be sent a task type: %v", name, r)
		}
		if _, has := r["outputDimensionality"]; has {
			t.Errorf("%s: no dimensions were configured, none should be sent: %v", name, r)
		}
		if r["model"] != "models/gemini-embedding-2" {
			t.Errorf("%s: model = %v", name, r["model"])
		}
	}
	text := func(r map[string]any) any {
		return r["content"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"]
	}
	if text(doc) != "title: none | text: t0" {
		t.Errorf("document text = %q", text(doc))
	}
	if text(qry) != "task: search result | query: t0" {
		t.Errorf("query text = %q", text(qry))
	}
	if e.Dim() != 2 {
		t.Fatalf("Dim after the first answer = %d", e.Dim())
	}
}

func TestGemini2TakesImagesAsInlineData(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "models/gemini-embedding-2", APIKey: testGeminiKey, Dimensions: 0}, srv.URL)
	hermetic(e.req)
	if !e.Caps().Image {
		t.Fatal("gemini-embedding-2 is multimodal")
	}
	if e.ID() != "gemini|gemini-embedding-2|0" {
		t.Fatalf("ID = %q (the models/ prefix must not be part of it)", e.ID())
	}
	in := []Input{{Text: "t0"}, {Image: geminiPNG(1)}, {Image: &Image{MIME: "image/jpeg", Data: []byte("img2")}}, {Text: "t3"}}
	got, err := e.Embed(context.Background(), Query, in)
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 4)

	c := rec.all()[0]
	if c.Path != "/v1beta/models/gemini-embedding-2:batchEmbedContents" {
		t.Fatalf("path = %q", c.Path)
	}
	var req geminiTestReqBatch
	if err := json.Unmarshal(c.Body, &req); err != nil {
		t.Fatal(err)
	}
	img := req.Requests[1].Content.Parts[0]
	if img.Text != "" || img.InlineData == nil || img.InlineData.MimeType != "image/png" || img.InlineData.Data != base64.StdEncoding.EncodeToString([]byte("img1")) {
		t.Fatalf("image part = %+v: it must be inline data, with no instruction text", img)
	}
	if jpg := req.Requests[2].Content.Parts[0].InlineData; jpg == nil || jpg.MimeType != "image/jpeg" {
		t.Fatalf("jpeg part = %+v", jpg)
	}
	if len(req.Requests[1].Content.Parts) != 1 || req.Requests[1].TaskType != "" {
		t.Fatalf("an image is one part and has no task type: %+v", req.Requests[1])
	}
}

func TestGeminiImageIsRefusedWhereTheModelIsTextOnly(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	for _, model := range []string{"gemini-embedding-001", "gemini-embedding-exp-03-07", "text-embedding-004"} {
		e := newGemini(Config{Model: model, APIKey: testGeminiKey}, srv.URL)
		if e.Caps().Image {
			t.Errorf("%s: Caps.Image = true", model)
		}
		_, err := e.Embed(context.Background(), Document, []Input{{Text: "t0"}, {Image: geminiPNG(1)}})
		if err == nil || !strings.Contains(err.Error(), "text only") || !strings.Contains(err.Error(), "gemini-embedding-2") {
			t.Errorf("%s: error = %v, want a refusal that names the multimodal model", model, err)
		}
	}
	if rec.count() != 0 {
		t.Fatalf("%d requests were sent although an input was refused", rec.count())
	}
}

func TestGeminiImageTypesAndEmptyInputs(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	for name, in := range map[string]Input{
		"webp":       {Image: &Image{MIME: "image/webp", Data: []byte("img1")}},
		"no data":    {Image: &Image{MIME: "image/png"}},
		"empty text": {Text: " "},
		"both":       {Text: "t1", Image: geminiPNG(1)},
	} {
		if _, err := e.Embed(context.Background(), Document, []Input{{Text: "t0"}, in}); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	if rec.count() != 0 {
		t.Fatalf("%d requests were sent for refused input", rec.count())
	}
	// image/jpg is the spelling some tools give; it is sent as image/jpeg.
	if _, err := e.Embed(context.Background(), Document, []Input{{Image: &Image{MIME: "Image/JPG", Data: []byte("img0")}}}); err != nil {
		t.Fatal(err)
	}
	var req geminiTestReqBatch
	_ = json.Unmarshal(rec.all()[0].Body, &req)
	if req.Requests[0].Content.Parts[0].InlineData.MimeType != "image/jpeg" {
		t.Fatalf("mime = %q", req.Requests[0].Content.Parts[0].InlineData.MimeType)
	}
}

func TestGeminiBatchesAreSplitAt100AndKeepTheirOrder(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(250))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 250)
	var sizes []int
	for _, c := range rec.all() {
		sizes = append(sizes, len(c.json(t)["requests"].([]any)))
	}
	if !reflect.DeepEqual(sizes, []int{100, 100, 50}) {
		t.Fatalf("batch sizes = %v, want [100 100 50]", sizes)
	}
}

func TestGeminiAtMostSixImagesPerRequest(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	// 15 inputs, 13 of them images (0..8, 10, 12, 13, 14) and two texts (9, 11): at 6 images a request, that is three requests.
	var in []Input
	for i := 0; i < 15; i++ {
		if i == 9 || i == 11 {
			in = append(in, Input{Text: "t" + strconv.Itoa(i)})
		} else {
			in = append(in, Input{Image: geminiPNG(i)})
		}
	}
	got, err := e.Embed(context.Background(), Document, in)
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 15)
	total := 0
	for n, c := range rec.all() {
		images := 0
		var req geminiTestReqBatch
		_ = json.Unmarshal(c.Body, &req)
		for _, r := range req.Requests {
			if r.Content.Parts[0].InlineData != nil {
				images++
			}
		}
		if images > 6 {
			t.Errorf("request %d carries %d images, the limit is 6", n, images)
		}
		total += len(req.Requests)
	}
	if rec.count() != 3 || total != 15 {
		t.Fatalf("requests=%d inputs sent=%d, want 3 requests holding all 15 inputs once", rec.count(), total)
	}
}

func TestGeminiReducedDimensionsAreRenormalized(t *testing.T) {
	// A server that answers longer than asked (or a model whose own vector is shorter than its full size): normalized either way.
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": []map[string]any{{"values": []float32{1, 1, 1, 1}}, {"values": []float32{2, 0, 0, 0}}}})
	})
	e := newGemini(Config{Model: "gemini-embedding-001", APIKey: testGeminiKey, Dimensions: 2}, srv.URL)
	hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(2))
	if err != nil {
		t.Fatal(err)
	}
	if len(got[0]) != 2 || !near(got[0][0], 0.70710678) || !isUnit(got[0]) || len(got[1]) != 2 || !near(got[1][0], 1) {
		t.Fatalf("vectors = %v", got)
	}

	// Fewer values than asked for is an error.
	srvShort, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": []map[string]any{{"values": []float32{1}}}})
	})
	e = newGemini(Config{Model: "gemini-embedding-001", APIKey: testGeminiKey, Dimensions: 4}, srvShort.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Document, texts(1)); err == nil || !strings.Contains(err.Error(), "asked for vectors of 4") {
		t.Fatalf("error = %v", err)
	}
}

func TestGeminiWrongCountIsAnError(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 200, map[string]any{"embeddings": []map[string]any{{"values": []float32{1, 0}}}})
	})
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	if _, err := e.Embed(context.Background(), Document, texts(3)); err == nil || !strings.Contains(err.Error(), "asked for 3 vectors, got 1") {
		t.Fatalf("error = %v", err)
	}
}

func TestGeminiRetryOn429ThenSuccessAndNoRetryOn400(t *testing.T) {
	srv, rec := serve(t, func(n int, c captured, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "5")
			writeJSON(w, 429, map[string]any{"error": map[string]any{"code": 429, "status": "RESOURCE_EXHAUSTED"}})
			return
		}
		geminiEcho(t)(n, c, w)
	})
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	slept := hermetic(e.req)
	got, err := e.Embed(context.Background(), Document, texts(3))
	if err != nil {
		t.Fatal(err)
	}
	checkOrder(t, got, 3)
	if rec.count() != 2 || !equalDurations(slept.all(), []time.Duration{5 * time.Second}) {
		t.Fatalf("requests=%d waits=%v", rec.count(), slept.all())
	}

	srv400, rec400 := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 400, map[string]any{"error": map[string]any{"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
	})
	e = newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv400.URL)
	slept = hermetic(e.req)
	_, err = e.Embed(context.Background(), Document, texts(1))
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 400 || rec400.count() != 1 || len(slept.all()) != 0 {
		t.Fatalf("err=%v requests=%d waits=%v, want no retry of a 400", err, rec400.count(), slept.all())
	}
}

func TestGeminiKeyNeverInAnError(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		w.WriteHeader(403)
		_, _ = fmt.Fprintf(w, `{"error":{"message":"The key %s is not allowed","details":"https://x/?key=%s"}}`, testGeminiKey, testGeminiKey)
	})
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	hermetic(e.req)
	_, err := e.Embed(context.Background(), Document, texts(1))
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), testGeminiKey) || strings.Contains(err.Error(), "TESTKEY0123456789") {
		t.Fatalf("error text holds the key: %q", err)
	}
}

func TestGeminiCancelledContext(t *testing.T) {
	srv, rec := serve(t, geminiEcho(t))
	e := newGemini(Config{Model: "gemini-embedding-2", APIKey: testGeminiKey}, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := e.Embed(ctx, Document, texts(3)); !errors.Is(err, context.Canceled) || rec.count() != 0 {
		t.Fatalf("err=%v requests=%d", err, rec.count())
	}
}

func TestGeminiProfileTable(t *testing.T) {
	cases := []struct {
		model      string
		multimodal bool
		taskTypes  bool
	}{
		{"gemini-embedding-2", true, false},
		{"gemini-embedding-2-preview", true, false},
		{"GEMINI-EMBEDDING-2", true, false},
		{"gemini-embedding-001", false, true},
		{"gemini-embedding-exp-03-07", false, true}, // not in the table: the documented older shape
		{"text-embedding-004", false, true},
	}
	for _, c := range cases {
		p := geminiProfileFor(c.model)
		if p.multimodal != c.multimodal || p.taskTypes != c.taskTypes {
			t.Errorf("%s: multimodal=%v taskTypes=%v, want %v %v", c.model, p.multimodal, p.taskTypes, c.multimodal, c.taskTypes)
		}
	}
}

func TestGeminiEndpointFromBaseURL(t *testing.T) {
	for base, want := range map[string]string{
		"": "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"https://generativelanguage.googleapis.com":               "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"https://generativelanguage.googleapis.com/":              "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"https://generativelanguage.googleapis.com/v1beta":        "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"https://generativelanguage.googleapis.com/v1beta/openai": "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"https://generativelanguage.googleapis.com/v1":            "https://generativelanguage.googleapis.com/v1beta/models/m:batchEmbedContents",
		"http://localhost:9999":                                   "http://localhost:9999/v1beta/models/m:batchEmbedContents",
	} {
		e := newGemini(Config{Model: "m", APIKey: "k"}, base)
		if e.endpoint != want {
			t.Errorf("base %q: endpoint %q, want %q", base, e.endpoint, want)
		}
	}
}
