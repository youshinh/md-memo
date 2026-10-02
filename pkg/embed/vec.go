package embed

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
)

// normalize scales v to length 1 in place, so that a dot product of two vectors is their cosine similarity. A zero vector is left as it
// is (there is no direction to keep).
func normalize(v []float32) {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	if sum == 0 || math.IsNaN(sum) || math.IsInf(sum, 0) {
		return
	}
	inv := float32(1 / math.Sqrt(sum))
	for i := range v {
		v[i] *= inv
	}
}

// cutTo returns the first dim values of v, normalized again: cutting a normalized vector short leaves it shorter than 1. The result
// is a copy so that the long vector's memory is not kept alive by the short one.
func cutTo(v []float32, dim int) []float32 {
	out := make([]float32, dim)
	copy(out, v[:dim])
	normalize(out)
	return out
}

// dimMemo remembers the length of the vectors a provider answered with: the Embedder's Dim, which is unknown until the first answer.
type dimMemo struct{ n atomic.Int64 }

func (d *dimMemo) get() int { return int(d.n.Load()) }

// observe records the length of a vector from an answer. A later answer of another length means the model behind the name changed
// (or the server swapped it): mixing the two would make every dot product meaningless, so it is an error.
func (d *dimMemo) observe(provider string, n int) error {
	if n == 0 {
		return fmt.Errorf("%s: the answer holds an empty vector", provider)
	}
	if d.n.CompareAndSwap(0, int64(n)) {
		return nil
	}
	if cur := int(d.n.Load()); cur != n {
		return fmt.Errorf("%s: the model answered with vectors of %d values, earlier ones had %d (the model behind this name changed: rebuild the index)", provider, n, cur)
	}
	return nil
}

// embedInBatches sends texts through send in runs of at most maxBatch and joins the answers in order.
func embedInBatches(ctx context.Context, maxBatch int, texts []string, send func(context.Context, []string) ([][]float32, error)) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += maxBatch {
		end := min(start+maxBatch, len(texts))
		vecs, err := send(ctx, texts[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
	}
	return out, nil
}

// textInputs checks that every input is plain, non-empty text and puts the model's query/document wording in front of it. An image
// is refused with a message that says why (nothing is sent anywhere before the whole list is checked).
func textInputs(provider, model string, kind Kind, in []Input, f textFormat) ([]string, error) {
	out := make([]string, len(in))
	for i, x := range in {
		switch {
		case x.Image != nil && x.Text != "":
			return nil, fmt.Errorf("%s: input %d has both text and an image; an input is one or the other", provider, i)
		case x.Image != nil:
			return nil, fmt.Errorf("%s: input %d is an image, but %s embeds text only; choose a multimodal embedding model (gemini-embedding-2) or leave images out", provider, i, model)
		case strings.TrimSpace(x.Text) == "":
			return nil, fmt.Errorf("%s: input %d is empty; there is nothing to embed", provider, i)
		}
		out[i] = f.apply(kind, x.Text)
	}
	return out, nil
}
