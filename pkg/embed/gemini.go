package embed

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

const (
	// geminiMaxBatch is the most inputs one batchEmbedContents call carries. UNVERIFIED: the current API reference states no limit;
	// 100 requests per batch is the limit older documentation gave, and a chunk is a few hundred characters, so a full batch is far
	// below the 8,192-token limit per input and any plausible request size.
	geminiMaxBatch = 100
	// geminiMaxImagesPerRequest: the embeddings guide says "Maximum: 6 images per request" for gemini-embedding-2. UNVERIFIED whether
	// that counts the images of a whole batchEmbedContents call or of each embedding inside it; the safer reading is the whole call,
	// so a batch is cut before a seventh image.
	geminiMaxImagesPerRequest = 6
)

// geminiProfile is what differs between the Gemini embedding models: whether they take images, and how a query is told from a
// document. The table is keyed by the start of the model's name, so gemini-embedding-001 keeps working next to gemini-embedding-2.
type geminiProfile struct {
	prefix     string
	multimodal bool
	// taskTypes: the model takes the taskType field (RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT). Otherwise the model must not be sent a
	// task type, and the wording (format) goes in front of the text instead.
	taskTypes bool
	format    textFormat
}

var geminiProfiles = []geminiProfile{
	// The embeddings guide: "You cannot use the task_type field for the gemini-embedding-2 model. Instead, include the task as an
	// instruction in your prompt." For retrieval: a query is "task: search result | query: {content}", a document is
	// "title: {title} | text: {content}" with "title: none" when there is no title. The text part of an image input carries no
	// task wording, and an image has none either.
	{prefix: "gemini-embedding-2", multimodal: true, format: textFormat{"task: search result | query: ", "title: none | text: "}},
	{prefix: "gemini-embedding-001", taskTypes: true},
}

// geminiDefaultProfile serves a model that is not in the table. UNVERIFIED: the older, documented shape (a task type, text only) is
// the safer guess; a newer model that refuses a task type fails loudly with the server's own message instead of silently getting
// instruction text in its input.
var geminiDefaultProfile = geminiProfile{taskTypes: true}

func geminiProfileFor(model string) geminiProfile {
	m := strings.ToLower(model)
	for _, p := range geminiProfiles {
		if strings.HasPrefix(m, p.prefix) {
			return p
		}
	}
	return geminiDefaultProfile
}

// geminiEmbedder speaks the Gemini API's batchEmbedContents (one call for any number of inputs, one embedding per input; a single
// input is a batch of one, so there is no second code path). The API key travels in the x-goog-api-key header, never in the URL,
// so no error message or log line that names the URL can carry it.
type geminiEmbedder struct {
	model    string // without "models/"
	dims     int    // config.Dimensions (outputDimensionality); 0 = the model's own (3072)
	endpoint string
	header   map[string]string
	profile  geminiProfile
	req      *requester
	dim      dimMemo
}

func newGemini(cfg Config, base string) *geminiEmbedder {
	model := strings.TrimPrefix(cfg.Model, "models/")
	return &geminiEmbedder{
		model:    model,
		dims:     cfg.Dimensions,
		endpoint: geminiAPIBase(base) + "/v1beta/models/" + url.PathEscape(model) + ":batchEmbedContents",
		header:   map[string]string{"x-goog-api-key": cfg.APIKey},
		profile:  geminiProfileFor(model),
		req:      newRequester("Gemini", cfg.APIKey),
	}
}

// geminiAPIBase reduces a configured base URL to the bare host, so that "/v1beta/..." can be appended whether the user typed a
// version suffix or not (pkg/llm does the same; the OpenAI-compatibility path of Google's host is dropped too).
func geminiAPIBase(base string) string {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	for _, suffix := range []string{"/openai", "/v1beta", "/v1"} {
		base = strings.TrimSuffix(base, suffix)
	}
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	return base
}

func (e *geminiEmbedder) ID() string { return fmt.Sprintf("gemini|%s|%d", e.model, e.dims) }

// Dim is known before the first answer when Dimensions is set; otherwise it is learnt from the first answer.
func (e *geminiEmbedder) Dim() int {
	if d := e.dim.get(); d > 0 {
		return d
	}
	return e.dims
}

// Caps: only the models documented as multimodal (gemini-embedding-2*) take images.
func (e *geminiEmbedder) Caps() Caps {
	return Caps{Text: true, Image: e.profile.multimodal, MaxBatch: geminiMaxBatch}
}

type geminiPart struct {
	Text       string            `json:"text,omitempty"`
	InlineData *geminiInlineData `json:"inlineData,omitempty"`
}

type geminiInlineData struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"` // base64
}

type geminiContent struct {
	Parts []geminiPart `json:"parts"`
}

// geminiEmbedRequest is one embedding of a batch. The JSON names are the canonical (camelCase) form of the proto field names; the
// API also accepts the snake_case spelling the guide's examples use.
type geminiEmbedRequest struct {
	Model    string        `json:"model"`
	Content  geminiContent `json:"content"`
	TaskType string        `json:"taskType,omitempty"`
	// OutputDimensionality is sent at the top level of each request. UNVERIFIED: the API reference marks the top-level
	// taskType/title/outputDimensionality as deprecated in favour of an embedContentConfig object, but the guide's own REST example
	// for gemini-embedding-2 still sets the dimension at the top level, so that is what is known to work; if Google removes it,
	// moving it into embedContentConfig is a change in this one struct and in prepare.
	OutputDimensionality int `json:"outputDimensionality,omitempty"`

	image bool // not sent: whether the input is an image (the per-call image limit counts them)
}

type geminiBatchRequest struct {
	Requests []geminiEmbedRequest `json:"requests"`
}

type geminiBatchResponse struct {
	Embeddings []struct {
		Values []float32 `json:"values"`
	} `json:"embeddings"`
}

func (e *geminiEmbedder) Embed(ctx context.Context, kind Kind, in []Input) ([][]float32, error) {
	if len(in) == 0 {
		return [][]float32{}, nil
	}
	reqs, err := e.prepare(kind, in) // everything is checked before anything is sent
	if err != nil {
		return nil, err
	}
	out := make([][]float32, 0, len(in))
	for start := 0; start < len(reqs); {
		end, images := start, 0
		for end < len(reqs) && end-start < geminiMaxBatch {
			if reqs[end].image {
				if images == geminiMaxImagesPerRequest {
					break
				}
				images++
			}
			end++
		}
		vecs, err := e.send(ctx, reqs[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
		start = end
	}
	return out, nil
}

func (e *geminiEmbedder) prepare(kind Kind, in []Input) ([]geminiEmbedRequest, error) {
	taskType := ""
	if e.profile.taskTypes {
		taskType = "RETRIEVAL_DOCUMENT"
		if kind == Query {
			taskType = "RETRIEVAL_QUERY"
		}
	}
	reqs := make([]geminiEmbedRequest, len(in))
	for i, x := range in {
		r := geminiEmbedRequest{
			Model:                "models/" + e.model,
			TaskType:             taskType,
			OutputDimensionality: e.dims,
		}
		switch {
		case x.Image != nil && x.Text != "":
			return nil, fmt.Errorf("Gemini: input %d has both text and an image; an input is one or the other", i)
		case x.Image != nil:
			if !e.profile.multimodal {
				return nil, fmt.Errorf("Gemini: input %d is an image, but %s embeds text only; choose gemini-embedding-2 or leave images out", i, e.model)
			}
			mime, err := geminiImageMIME(x.Image)
			if err != nil {
				return nil, fmt.Errorf("Gemini: input %d: %w", i, err)
			}
			r.Content.Parts = []geminiPart{{InlineData: &geminiInlineData{MimeType: mime, Data: base64.StdEncoding.EncodeToString(x.Image.Data)}}}
			r.image = true
		case strings.TrimSpace(x.Text) == "":
			return nil, fmt.Errorf("Gemini: input %d is empty; there is nothing to embed", i)
		default:
			r.Content.Parts = []geminiPart{{Text: e.profile.format.apply(kind, x.Text)}}
		}
		reqs[i] = r
	}
	return reqs, nil
}

// geminiImageMIME accepts what the guide lists for images, PNG and JPEG, and nothing else (the caller has already converted).
func geminiImageMIME(img *Image) (string, error) {
	if len(img.Data) == 0 {
		return "", fmt.Errorf("the image has no data")
	}
	switch strings.ToLower(strings.TrimSpace(img.MIME)) {
	case "image/png":
		return "image/png", nil
	case "image/jpeg", "image/jpg":
		return "image/jpeg", nil
	}
	return "", fmt.Errorf("image type %q is not accepted; Gemini embeds image/png and image/jpeg", img.MIME)
}

func (e *geminiEmbedder) send(ctx context.Context, reqs []geminiEmbedRequest) ([][]float32, error) {
	body, err := json.Marshal(geminiBatchRequest{Requests: reqs})
	if err != nil {
		return nil, err
	}
	var res geminiBatchResponse
	if err := e.req.post(ctx, e.endpoint, e.header, body, &res); err != nil {
		return nil, err
	}
	if len(res.Embeddings) != len(reqs) {
		return nil, fmt.Errorf("Gemini: asked for %d vectors, got %d", len(reqs), len(res.Embeddings))
	}
	out := make([][]float32, len(reqs))
	for i, em := range res.Embeddings {
		v := em.Values
		switch {
		case e.dims > 0 && len(v) < e.dims:
			return nil, fmt.Errorf("Gemini: asked for vectors of %d values, got %d", e.dims, len(v))
		case e.dims > 0 && len(v) > e.dims:
			// Both models are trained for cutting (Matryoshka), so keeping the first values is sound if a server did not.
			v = cutTo(v, e.dims)
		default:
			// A vector of fewer than 3,072 values is not normalized (the guide says so for gemini-embedding-001), and the cosine
			// of unnormalized vectors is not their dot product, so every vector is normalized here.
			normalize(v)
		}
		if err := e.dim.observe("Gemini", len(v)); err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}
