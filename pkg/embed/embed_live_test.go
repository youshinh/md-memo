//go:build live

// These tests talk to real servers. They never run in the normal suite (the build tag keeps them out) and each one skips itself
// unless its environment variables are set:
//
//	go test -tags live -count=1 -run Live -v ./pkg/embed/
//
//	OLLAMA_URL                       a running Ollama, e.g. http://localhost:11434   (OLLAMA_EMBED_MODEL, default bge-m3)
//	OPENAI_BASE_URL + OPENAI_API_KEY an OpenAI-compatible server                      (OPENAI_EMBED_MODEL, default text-embedding-3-small)
//	GEMINI_API_KEY                   the Gemini API                                  (GEMINI_EMBED_MODEL, default gemini-embedding-2)
//
// The keys are read from the environment only, and are never printed.
package embed

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
	"time"
)

func liveEnv(t *testing.T, names ...string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, n := range names {
		v := os.Getenv(n)
		if v == "" {
			t.Skipf("%s is not set", n)
		}
		out[n] = v
	}
	return out
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// liveCheck embeds a few sentences as documents and as queries, and checks what every Embedder promises: unit vectors, one per
// input in order, a known Dim afterwards, and that a question lands nearer to the passage that answers it than to one that does not.
func liveCheck(t *testing.T, e Embedder) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	docs := []Input{
		{Text: "The Eiffel Tower is a wrought-iron lattice tower in Paris, France."},
		{Text: "Photosynthesis is how plants turn sunlight, water and carbon dioxide into sugar."},
		{Text: "エッフェル塔はパリにある鉄の塔で、1889年に完成した。"},
	}
	dv, err := e.Embed(ctx, Document, docs)
	if err != nil {
		t.Fatalf("Embed(documents): %v", err)
	}
	if len(dv) != len(docs) {
		t.Fatalf("got %d vectors for %d documents", len(dv), len(docs))
	}
	if e.Dim() == 0 || e.Dim() != len(dv[0]) {
		t.Fatalf("Dim = %d, vector has %d values", e.Dim(), len(dv[0]))
	}
	for i, v := range dv {
		if len(v) != e.Dim() || !isUnit(v) {
			t.Fatalf("document %d: %d values, unit=%v", i, len(v), isUnit(v))
		}
	}
	qv, err := e.Embed(ctx, Query, []Input{{Text: "Where is the Eiffel Tower?"}})
	if err != nil {
		t.Fatalf("Embed(query): %v", err)
	}
	if !isUnit(qv[0]) {
		t.Fatal("query vector is not a unit vector")
	}
	if tower, plants := dot(qv[0], dv[0]), dot(qv[0], dv[1]); tower <= plants {
		t.Fatalf("the question is not closer to the tower (%.3f) than to photosynthesis (%.3f)", tower, plants)
	}
	t.Logf("%s: dim %d, tower %.3f, plants %.3f, japanese tower %.3f", e.ID(), e.Dim(), dot(qv[0], dv[0]), dot(qv[0], dv[1]), dot(qv[0], dv[2]))
}

func TestLiveOllama(t *testing.T) {
	env := liveEnv(t, "OLLAMA_URL")
	e, err := New(Config{BaseURL: env["OLLAMA_URL"], Model: envOr("OLLAMA_EMBED_MODEL", "bge-m3")})
	if err != nil {
		t.Fatal(err)
	}
	liveCheck(t, e)
}

func TestLiveOpenAICompatible(t *testing.T) {
	env := liveEnv(t, "OPENAI_BASE_URL", "OPENAI_API_KEY")
	e, err := New(Config{BaseURL: env["OPENAI_BASE_URL"], Model: envOr("OPENAI_EMBED_MODEL", "text-embedding-3-small"), APIKey: env["OPENAI_API_KEY"]})
	if err != nil {
		t.Fatal(err)
	}
	liveCheck(t, e)
}

func TestLiveGemini(t *testing.T) {
	env := liveEnv(t, "GEMINI_API_KEY")
	model := envOr("GEMINI_EMBED_MODEL", "gemini-embedding-2")
	e, err := New(Config{Model: model, APIKey: env["GEMINI_API_KEY"], Dimensions: 768})
	if err != nil {
		t.Fatal(err)
	}
	liveCheck(t, e)
	if e.Dim() != 768 {
		t.Fatalf("Dim = %d, asked for 768", e.Dim())
	}

	if !e.Caps().Image {
		t.Skipf("%s takes no images", model)
	}
	// A picture and a sentence share a space: the red square is nearer to "a red square" than to "a green square".
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	iv, err := e.Embed(ctx, Document, []Input{{Image: solidPNG(t, color.RGBA{R: 220, A: 255})}})
	if err != nil {
		t.Fatalf("Embed(image): %v", err)
	}
	tv, err := e.Embed(ctx, Query, []Input{{Text: "a red square"}, {Text: "a green square"}})
	if err != nil {
		t.Fatalf("Embed(text): %v", err)
	}
	if len(iv[0]) != 768 || !isUnit(iv[0]) {
		t.Fatalf("image vector: %d values, unit=%v", len(iv[0]), isUnit(iv[0]))
	}
	red, green := dot(iv[0], tv[0]), dot(iv[0], tv[1])
	t.Logf("red square vs 'a red square' %.3f, vs 'a green square' %.3f", red, green)
	if red <= green {
		t.Errorf("the red picture is not nearer to the red sentence (%.3f) than to the green one (%.3f)", red, green)
	}
}

func solidPNG(t *testing.T, c color.Color) *Image {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return &Image{MIME: "image/png", Data: buf.Bytes()}
}
