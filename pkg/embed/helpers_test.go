package embed

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// captured is one request a test server received.
type captured struct {
	Method   string
	Path     string
	RawQuery string
	Header   http.Header
	Body     []byte
}

func (c captured) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(c.Body, &m); err != nil {
		t.Fatalf("request body is not JSON: %v\n%s", err, c.Body)
	}
	return m
}

type recorder struct {
	mu   sync.Mutex
	reqs []captured
}

func (r *recorder) add(c captured) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reqs = append(r.reqs, c)
	return len(r.reqs)
}

func (r *recorder) all() []captured {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]captured(nil), r.reqs...)
}

func (r *recorder) count() int { return len(r.all()) }

// serve starts a local server; respond gets the 1-based number of the request and what it carried. Nothing leaves the machine.
func serve(t *testing.T, respond func(n int, c captured, w http.ResponseWriter)) (*httptest.Server, *recorder) {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c := captured{Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Header: r.Header.Clone(), Body: body}
		respond(rec.add(c), c, w)
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// sleeps records the waits a requester was asked for instead of waiting.
type sleeps struct {
	mu sync.Mutex
	d  []time.Duration
}

func (s *sleeps) all() []time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Duration(nil), s.d...)
}

// hermetic makes a requester wait for nothing and add no jitter (a jitter of 0.5 is exactly the base wait).
func hermetic(r *requester) *sleeps {
	s := &sleeps{}
	r.sleep = func(ctx context.Context, d time.Duration) error {
		s.mu.Lock()
		s.d = append(s.d, d)
		s.mu.Unlock()
		return ctx.Err()
	}
	r.rnd = func() float64 { return 0.5 }
	return s
}

func equalDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func near(a, b float32) bool { return math.Abs(float64(a-b)) < 1e-5 }

func isUnit(v []float32) bool {
	var s float64
	for _, x := range v {
		s += float64(x) * float64(x)
	}
	return math.Abs(s-1) < 1e-4
}

// numOf reads the number out of "t17" (or of the end of "title: none | text: t17"): the tests answer each text with a vector that
// says which input it was, so that the order of the results can be checked.
func numOf(t *testing.T, text string) int {
	t.Helper()
	i := strings.LastIndex(text, "t")
	n, err := strconv.Atoi(text[i+1:])
	if err != nil {
		t.Fatalf("test text %q does not end in t<number>", text)
	}
	return n
}

// whichVec is the vector a test server answers input number n with: [n, 1], which normalizes to a direction that tells n.
func whichVec(n int) []float32 { return []float32{float32(n), 1} }

// checkOrder asserts that got[i] is the (normalized) answer for input i.
func checkOrder(t *testing.T, got [][]float32, n int) {
	t.Helper()
	if len(got) != n {
		t.Fatalf("got %d vectors, want %d", len(got), n)
	}
	for i, v := range got {
		if len(v) != 2 || !isUnit(v) {
			t.Fatalf("vector %d is %v, want a unit vector of 2 values", i, v)
		}
		if math.Abs(float64(v[0]/v[1])-float64(i)) > 1e-3 {
			t.Fatalf("vector %d belongs to input %v: results are out of order", i, v[0]/v[1])
		}
	}
}

func texts(n int) []Input {
	in := make([]Input, n)
	for i := range in {
		in[i] = Input{Text: "t" + strconv.Itoa(i)}
	}
	return in
}
