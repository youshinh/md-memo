package semindex

import (
	"context"
	"errors"
	"hash/fnv"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode"

	"md-memo/pkg/embed"
)

// fakeEmb is an offline embedder: a hashed bag of character pairs and Latin words, normalized, so texts that share words get close
// vectors. It counts what it is asked, and can be told to fail.
type fakeEmb struct {
	mu     sync.Mutex
	id     string
	dim    int
	calls  int
	inputs int
	texts  []string
	failAt int // fail the Nth call from now (1 = the next); 0 = never
	maxB   int
	// onCall, when set, runs at the start of every Embed call with the number of the call (1, 2, ...), before the call does anything.
	onCall func(n int)
}

func newFake() *fakeEmb { return &fakeEmb{id: "fake|bag|96", dim: 96, maxB: 16} }

func (f *fakeEmb) ID() string { return f.id }
func (f *fakeEmb) Dim() int   { return f.dim }
func (f *fakeEmb) Caps() embed.Caps {
	return embed.Caps{Text: true, MaxBatch: f.maxB}
}

func (f *fakeEmb) Embed(ctx context.Context, kind embed.Kind, in []embed.Input) ([][]float32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.calls++
	if f.onCall != nil {
		f.onCall(f.calls)
	}
	if f.failAt > 0 {
		f.failAt--
		if f.failAt == 0 {
			return nil, errors.New("the model is down")
		}
	}
	out := make([][]float32, len(in))
	for i, x := range in {
		f.inputs++
		f.texts = append(f.texts, x.Text)
		out[i] = bag(x.Text, f.dim)
	}
	return out, nil
}

func bucket(s string, dim int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return int(h.Sum32() % uint32(dim))
}

func bag(text string, dim int) []float32 {
	v := make([]float32, dim)
	rs := []rune(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, text))
	for i := 0; i+1 < len(rs); i++ {
		v[bucket(string(rs[i:i+2]), dim)]++
	}
	var n float64
	for _, x := range v {
		n += float64(x * x)
	}
	if n == 0 {
		v[0] = 1
		return v
	}
	n = math.Sqrt(n)
	for i := range v {
		v[i] = float32(float64(v[i]) / n)
	}
	return v
}

func writeFile(t *testing.T, dir, rel, content string) string {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// dirs gives a scrap folder and an index folder (outside it) for one test.
func dirs(t *testing.T) (scrap, index string) {
	t.Helper()
	root := t.TempDir()
	scrap = filepath.Join(root, "scraps")
	index = filepath.Join(root, "index")
	if err := os.MkdirAll(scrap, 0o755); err != nil {
		t.Fatal(err)
	}
	return scrap, index
}
