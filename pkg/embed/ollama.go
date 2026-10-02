package embed

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const (
	// ollamaMaxBatch is how many texts go into one /api/embed call. Ollama has no fixed limit; a small batch keeps one call short
	// on a CPU-only machine (the design measures about 29 short texts per second there) and one failure cheap to repeat.
	ollamaMaxBatch = 32
	// ollamaKeepAlive keeps the model loaded between the batches of one indexing run, and lets Ollama unload it a few minutes after
	// the last one (the model takes about 1.2 GB of memory).
	ollamaKeepAlive = "5m"
)

// ollamaEmbedder speaks Ollama's native embedding API, POST {base}/api/embed. (The /v1/embeddings route of Ollama is the OpenAI
// shape and is served by openaiEmbedder.)
type ollamaEmbedder struct {
	model    string
	dims     int // config.Dimensions; 0 = what the model gives
	endpoint string
	header   map[string]string
	format   textFormat
	req      *requester
	dim      dimMemo
}

// newOllama builds the embedder; base is the server's root, with or without a trailing /api, /api/embed or /v1.
func newOllama(cfg Config, base string) *ollamaEmbedder {
	e := &ollamaEmbedder{
		model:    cfg.Model,
		dims:     cfg.Dimensions,
		endpoint: ollamaEmbedURL(base),
		format:   textFormatFor(cfg.Model),
		req:      newRequester("Ollama", cfg.APIKey),
	}
	if cfg.APIKey != "" { // a local Ollama has none; one behind an authenticating proxy may
		e.header = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
	}
	return e
}

func ollamaEmbedURL(base string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	for _, suffix := range []string{"/api/embed", "/api/embeddings", "/api", "/v1"} {
		if strings.HasSuffix(base, suffix) {
			base = strings.TrimSuffix(base, suffix)
			break
		}
	}
	return base + "/api/embed"
}

func (e *ollamaEmbedder) ID() string { return fmt.Sprintf("ollama|%s|%d", e.model, e.dims) }

func (e *ollamaEmbedder) Dim() int { return e.dim.get() }

// Caps: Ollama's library has no multimodal embedding model, so an image is refused with a message instead of being sent.
func (e *ollamaEmbedder) Caps() Caps { return Caps{Text: true, MaxBatch: ollamaMaxBatch} }

type ollamaRequest struct {
	Model     string         `json:"model"`
	Input     []string       `json:"input"`
	Truncate  bool           `json:"truncate"`
	KeepAlive string         `json:"keep_alive"`
	Options   map[string]any `json:"options"`
}

type ollamaResponse struct {
	Embeddings [][]float32 `json:"embeddings"`
}

func (e *ollamaEmbedder) Embed(ctx context.Context, kind Kind, in []Input) ([][]float32, error) {
	if len(in) == 0 {
		return [][]float32{}, nil
	}
	texts, err := textInputs("Ollama", e.model, kind, in, e.format)
	if err != nil {
		return nil, err
	}
	return embedInBatches(ctx, ollamaMaxBatch, texts, e.send)
}

func (e *ollamaEmbedder) send(ctx context.Context, texts []string) ([][]float32, error) {
	body, err := json.Marshal(ollamaRequest{
		Model:     e.model,
		Input:     texts,
		Truncate:  true, // a text longer than the model's context is cut, not refused: one long chunk must not stop a run
		KeepAlive: ollamaKeepAlive,
		Options:   map[string]any{},
	})
	if err != nil {
		return nil, err
	}
	var res ollamaResponse
	if err := e.req.post(ctx, e.endpoint, e.header, body, &res); err != nil {
		return nil, err
	}
	if len(res.Embeddings) != len(texts) {
		return nil, fmt.Errorf("Ollama: asked for %d vectors, got %d", len(texts), len(res.Embeddings))
	}
	for i, v := range res.Embeddings {
		// Dimensions is a cut, which only a model trained for it (Matryoshka representation learning, as nomic-embed-text v1.5 and
		// Qwen3-Embedding are; bge-m3 is not) survives without losing its meaning: use it only with such a model. A Dimensions
		// bigger than the model's vectors changes nothing.
		if e.dims > 0 && len(v) > e.dims {
			v = cutTo(v, e.dims)
		} else {
			normalize(v)
		}
		if err := e.dim.observe("Ollama", len(v)); err != nil {
			return nil, err
		}
		res.Embeddings[i] = v
	}
	return res.Embeddings, nil
}
