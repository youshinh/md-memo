package embed

import (
	"context"
	"fmt"
	"hash/fnv"
	"strings"
	"sync"
	"unicode"
)

const defaultFakeDim = 64

// Fake is an Embedder that needs no model and no network, for tests of the code that uses one (the semantic index, the CLI). Its
// vectors are a hashed bag of character pairs and ASCII words, so texts that share words or characters get similar vectors and
// unrelated texts do not: enough for "the search finds the note that holds these words". The same text gives the same vector,
// whether it is a Query or a Document. It counts what it was asked, so a test can assert that only the changed chunks were
// embedded, and it can be made to fail.
type Fake struct {
	dim int

	mu         sync.Mutex
	calls      int
	inputs     int
	seen       []string
	failNext   error
	failAlways error
}

// NewFake returns a deterministic, offline Embedder with vectors of dim values (64 when dim < 1). Its ID is "fake|bag|<dim>", its
// Caps are text only with MaxBatch 16. The value is a *Fake: a test that wants Calls, Inputs or FailNext type-asserts to it, or
// uses NewFakeEmbedder.
func NewFake(dim int) Embedder { return NewFakeEmbedder(dim) }

// NewFakeEmbedder is NewFake that returns the concrete *Fake, whose counters and failure switches need no type assertion.
func NewFakeEmbedder(dim int) *Fake {
	if dim < 1 {
		dim = defaultFakeDim
	}
	return &Fake{dim: dim}
}

func (f *Fake) ID() string { return fmt.Sprintf("fake|bag|%d", f.dim) }
func (f *Fake) Dim() int   { return f.dim }
func (f *Fake) Caps() Caps { return Caps{Text: true, MaxBatch: 16} }

// Calls is how many Embed calls carried at least one input (an Embed of nothing does no work and is not counted), failed ones
// included. It counts calls, not the batches a real provider would split them into.
func (f *Fake) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// Inputs is how many inputs were embedded in total; the inputs of a call that failed are not counted.
func (f *Fake) Inputs() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.inputs
}

// Seen is the text of every input that was embedded, in order (the same text is listed each time it is embedded).
func (f *Fake) Seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.seen...)
}

// FailNext makes the next Embed call (that has inputs) return err, once. Calls it makes after that succeed again.
func (f *Fake) FailNext(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = err
}

// FailAlways makes every Embed call return err until it is called again with nil.
func (f *Fake) FailAlways(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failAlways = err
}

func (f *Fake) Embed(ctx context.Context, kind Kind, in []Input) ([][]float32, error) {
	if len(in) == 0 {
		return [][]float32{}, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	f.mu.Lock()
	f.calls++
	if err := f.failNext; err != nil {
		f.failNext = nil
		f.mu.Unlock()
		return nil, err
	}
	if err := f.failAlways; err != nil {
		f.mu.Unlock()
		return nil, err
	}
	f.mu.Unlock()

	texts := make([]string, len(in))
	for i, x := range in {
		if x.Image != nil {
			return nil, fmt.Errorf("fake embedder: input %d is an image; it embeds text only", i)
		}
		texts[i] = x.Text
	}

	f.mu.Lock()
	f.inputs += len(in)
	f.seen = append(f.seen, texts...)
	f.mu.Unlock()

	out := make([][]float32, len(in))
	for i, t := range texts {
		out[i] = fakeVector(t, f.dim)
	}
	return out, nil
}

// fakeVector hashes the character pairs of each whitespace-separated piece of text, and each ASCII word as a whole (counted double,
// as a word says more than a pair of letters), into dim buckets with a random-looking sign (so that two unrelated texts are not
// similar just because every bucket is positive), and normalizes the result.
func fakeVector(text string, dim int) []float32 {
	v := make([]float32, dim)
	add := func(s string, w float32) {
		h := fnv.New64a()
		h.Write([]byte(s))
		sum := h.Sum64()
		sign := float32(1)
		if sum>>63 == 1 {
			sign = -1
		}
		v[int(sum%uint64(dim))] += sign * w
	}
	for _, piece := range strings.Fields(strings.ToLower(text)) {
		runes := []rune(piece)
		if len(runes) == 1 {
			add("1:"+piece, 1)
		}
		for i := 0; i+1 < len(runes); i++ {
			add("2:"+string(runes[i:i+2]), 1)
		}
		if word := strings.TrimFunc(piece, func(r rune) bool { return !isASCIIWordRune(r) }); len([]rune(word)) >= 2 && isASCII(word) {
			add("w:"+word, 2)
		}
	}
	zero := true
	for _, x := range v {
		if x != 0 {
			zero = false
			break
		}
	}
	if zero {
		v[0] = 1 // an empty text (or one whose hashes cancel) still gets a direction
	}
	normalize(v)
	return v
}

func isASCIIWordRune(r rune) bool {
	return r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r))
}

func isASCII(s string) bool {
	for _, r := range s {
		if r >= unicode.MaxASCII {
			return false
		}
	}
	return true
}
