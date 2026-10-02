package embed

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// openaiMaxBatch is how many texts go into one /embeddings call. OpenAI takes up to 2,048 inputs, but also caps a request at about
// 300,000 tokens in total; a small batch stays far below that whatever the chunks hold, and local servers (LM Studio, vLLM) are
// slower per request than OpenAI.
const openaiMaxBatch = 64

// openaiEmbedder speaks the OpenAI embeddings API, POST {base}/embeddings, which OpenAI, LM Studio, vLLM, llama.cpp's server,
// Ollama's /v1 route, OpenRouter and others share.
type openaiEmbedder struct {
	model    string
	dims     int // config.Dimensions; 0 = what the model gives
	endpoint string
	header   map[string]string
	format   textFormat
	req      *requester
	dim      dimMemo
}

func newOpenAI(cfg Config, base string) *openaiEmbedder {
	e := &openaiEmbedder{
		model:    cfg.Model,
		dims:     cfg.Dimensions,
		endpoint: openAIEmbeddingsURL(base),
		format:   textFormatFor(cfg.Model),
		req:      newRequester("OpenAI-compatible server", cfg.APIKey),
	}
	if cfg.APIKey != "" { // a local server has none
		e.header = map[string]string{"Authorization": "Bearer " + cfg.APIKey}
	}
	return e
}

// openAIEmbeddingsURL mirrors pkg/llm's buildOpenAIURL: the base may be typed with or without /v1 (or with the chat endpoint pasted
// from the text-model setting), and the endpoint is always .../v1/embeddings. A base that already ends in a version segment of its
// own (/v1, /v2, /v1beta) keeps it.
func openAIEmbeddingsURL(base string) string {
	u := strings.TrimRight(strings.TrimSpace(base), "/")
	for _, suffix := range []string{"/embeddings", "/chat/completions", "/completions"} {
		if strings.HasSuffix(u, suffix) {
			u = strings.TrimRight(strings.TrimSuffix(u, suffix), "/")
			break
		}
	}
	if !endsWithVersionSegment(u) {
		u += "/v1"
	}
	return u + "/embeddings"
}

// endsWithVersionSegment reports whether the last path segment of u is v1, v2, v1beta, v1alpha and the like.
func endsWithVersionSegment(u string) bool {
	seg := u[strings.LastIndex(u, "/")+1:]
	if len(seg) < 2 || seg[0] != 'v' {
		return false
	}
	digits := strings.TrimSuffix(strings.TrimSuffix(seg[1:], "beta"), "alpha")
	if digits == "" {
		return false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (e *openaiEmbedder) ID() string { return fmt.Sprintf("openai|%s|%d", e.model, e.dims) }

// Dim is known before the first answer when Dimensions is set (the server is asked for exactly that many, and an answer of another
// length is an error); otherwise it is the model's own length, learnt from the first answer.
func (e *openaiEmbedder) Dim() int {
	if d := e.dim.get(); d > 0 {
		return d
	}
	return e.dims
}

// Caps: the OpenAI embeddings API takes text only.
func (e *openaiEmbedder) Caps() Caps { return Caps{Text: true, MaxBatch: openaiMaxBatch} }

type openaiRequest struct {
	Model          string   `json:"model"`
	Input          []string `json:"input"`
	Dimensions     int      `json:"dimensions,omitempty"`
	EncodingFormat string   `json:"encoding_format"`
}

type openaiResponse struct {
	Data []struct {
		Index     *int      `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

func (e *openaiEmbedder) Embed(ctx context.Context, kind Kind, in []Input) ([][]float32, error) {
	if len(in) == 0 {
		return [][]float32{}, nil
	}
	texts, err := textInputs("OpenAI-compatible server", e.model, kind, in, e.format)
	if err != nil {
		return nil, err
	}
	return embedInBatches(ctx, openaiMaxBatch, texts, e.send)
}

func (e *openaiEmbedder) send(ctx context.Context, texts []string) ([][]float32, error) {
	body, err := json.Marshal(openaiRequest{
		Model:          e.model,
		Input:          texts,
		Dimensions:     e.dims,
		EncodingFormat: "float", // not base64: a server that defaults to base64 would answer with a string
	})
	if err != nil {
		return nil, err
	}
	var res openaiResponse
	if err := e.req.post(ctx, e.endpoint, e.header, body, &res); err != nil {
		return nil, err
	}
	n := len(texts)
	if len(res.Data) != n {
		return nil, fmt.Errorf("OpenAI-compatible server: asked for %d vectors, got %d", n, len(res.Data))
	}

	// The answer names each vector's input by "index" and may come in any order. A server that leaves the index out (or repeats
	// one) is read in the order it answered.
	out := make([][]float32, n)
	for _, d := range res.Data {
		if d.Index == nil || *d.Index < 0 || *d.Index >= n || out[*d.Index] != nil {
			out = nil
			break
		}
		out[*d.Index] = d.Embedding
	}
	if out == nil {
		out = make([][]float32, n)
		for i, d := range res.Data {
			out[i] = d.Embedding
		}
	}

	for _, v := range out {
		if e.dims > 0 && len(v) != e.dims {
			return nil, fmt.Errorf("OpenAI-compatible server: asked for vectors of %d values, got %d (the server may not support the dimensions setting for %s)", e.dims, len(v), e.model)
		}
		if err := e.dim.observe("OpenAI-compatible server", len(v)); err != nil {
			return nil, err
		}
		normalize(v)
	}
	return out, nil
}
