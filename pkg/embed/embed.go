// Package embed turns text (and, for the models that take them, images) into vectors for the semantic search of the scraps
// (docs/design/semantic-search-2026-10.md). One Embedder is one configured model: the local Ollama, an OpenAI-compatible server
// (OpenAI, LM Studio, vLLM...) or Gemini. The semantic index (pkg/semindex) only knows this interface.
//
// Rules every Embedder keeps:
//   - the vectors it returns are L2-normalized (so a dot product is the cosine similarity), one per input, in the order of the inputs;
//   - Embed splits a long input list into requests of at most Caps().MaxBatch, retries a 429 / 5xx a few times (honouring
//     Retry-After) and gives up when ctx is cancelled;
//   - an error never carries the API key (neither in its text nor in the URL it names);
//   - nothing is sent anywhere until Embed is called, and no call is made at construction.
package embed

import "context"

// Kind says what an input is used for. Models that need to know (an e5 model wants "query: " / "passage: " in front, some APIs have a task type)
// are served by the Embedder; the caller only says whether it is indexing a document or asking.
type Kind int

const (
	Document Kind = iota
	Query
)

// Image is a picture to embed: PNG or JPEG bytes (the caller has already scaled it down and re-encoded it, which also drops its EXIF).
type Image struct {
	MIME string // "image/png" or "image/jpeg"
	Data []byte
}

// Input is one thing to embed: exactly one of Text and Image is set.
type Input struct {
	Text  string
	Image *Image
}

// Caps tells what an Embedder takes.
type Caps struct {
	Text     bool
	Image    bool
	MaxBatch int // inputs per request the provider accepts (Embed splits longer lists itself)
}

// Embedder is one configured embedding model.
type Embedder interface {
	// ID names the model for the index: "provider|model|dimensions". An index built with one ID is not used with another.
	ID() string
	// Dim is the length of the vectors; 0 until it is known (a provider that only tells it with its first answer).
	Dim() int
	Caps() Caps
	// Embed returns one normalized vector per input.
	Embed(ctx context.Context, kind Kind, in []Input) ([][]float32, error)
}

// Config is what the settings hold for the model: config.semantic.model.
type Config struct {
	BaseURL    string // http://localhost:11434, https://api.openai.com/v1, https://generativelanguage.googleapis.com ...
	Model      string // bge-m3, text-embedding-3-small, gemini-embedding-2 ...
	APIKey     string // empty for a local model
	Dimensions int    // 0 = the model's own; a smaller number cuts the vector where the model allows it (OpenAI, Gemini)
}
