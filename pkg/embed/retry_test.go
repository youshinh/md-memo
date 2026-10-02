package embed

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

type pong struct {
	OK bool `json:"ok"`
}

// timeoutErr is what a stalled connection looks like to net/http.
type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func okResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func newTestRequester(secrets ...string) (*requester, *sleeps) {
	r := newRequester("Test", secrets...)
	return r, hermetic(r)
}

func TestRetryAfterIsHonouredThenSuccess(t *testing.T) {
	srv, rec := serve(t, func(n int, _ captured, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "2")
			writeJSON(w, 429, map[string]string{"error": "slow down"})
			return
		}
		writeJSON(w, 200, pong{OK: true})
	})
	r, slept := newTestRequester()
	var out pong
	if err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &out); err != nil {
		t.Fatalf("post: %v", err)
	}
	if !out.OK || rec.count() != 2 {
		t.Fatalf("ok=%v requests=%d, want a second request to succeed", out.OK, rec.count())
	}
	if got := slept.all(); !equalDurations(got, []time.Duration{2 * time.Second}) {
		t.Fatalf("waits = %v, want [2s] (the server's Retry-After)", got)
	}
}

func TestBackoffIsOneTwoFourThenGivesUp(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		writeJSON(w, 500, map[string]string{"error": "boom"})
	})
	r, slept := newTestRequester()
	err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{})
	if err == nil {
		t.Fatal("expected an error after the retries")
	}
	if rec.count() != 4 {
		t.Fatalf("requests = %d, want 1 + 3 retries", rec.count())
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
	if got := slept.all(); !equalDurations(got, want) {
		t.Fatalf("waits = %v, want %v", got, want)
	}
	var he *HTTPError
	if !errors.As(err, &he) || he.Status != 500 {
		t.Fatalf("error %v does not carry the 500 status", err)
	}
	if !strings.Contains(err.Error(), "HTTP 500") || !strings.Contains(err.Error(), "gave up after 4 attempts") || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error text = %q, want the status, the attempts and a snippet of the body", err)
	}
}

func TestJitterStaysWithinAQuarter(t *testing.T) {
	r, _ := newTestRequester()
	r.rnd = func() float64 { return 0 }
	if d := r.backoff(0); d != 750*time.Millisecond {
		t.Fatalf("lowest first wait = %v, want 750ms", d)
	}
	r.rnd = func() float64 { return 0.999999 }
	if d := r.backoff(2); d < 4900*time.Millisecond || d > 5*time.Second {
		t.Fatalf("highest third wait = %v, want just under 5s", d)
	}
}

func TestStatusesThatAreRetriedAndThatAreNot(t *testing.T) {
	for _, s := range []int{429, 500, 502, 503, 504} {
		srv, rec := serve(t, func(n int, _ captured, w http.ResponseWriter) {
			if n == 1 {
				writeJSON(w, s, map[string]string{"error": "later"})
				return
			}
			writeJSON(w, 200, pong{OK: true})
		})
		r, _ := newTestRequester()
		if err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{}); err != nil || rec.count() != 2 {
			t.Errorf("status %d: err=%v requests=%d, want one retry then success", s, err, rec.count())
		}
	}
	for _, s := range []int{400, 401, 403, 404, 413, 422, 501} {
		srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
			writeJSON(w, s, map[string]string{"error": "no"})
		})
		r, slept := newTestRequester()
		err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{})
		var he *HTTPError
		if !errors.As(err, &he) || he.Status != s {
			t.Errorf("status %d: error %v", s, err)
		}
		if rec.count() != 1 || len(slept.all()) != 0 {
			t.Errorf("status %d: requests=%d waits=%v, want no retry", s, rec.count(), slept.all())
		}
	}
}

func TestRetryAfterIsCappedAndReadsBothForms(t *testing.T) {
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		header string
		want   time.Duration
	}{
		{"", 0},
		{"0", 0},
		{"-5", 0},
		{"soon", 0},
		{"7", 7 * time.Second},
		{"60", 60 * time.Second},
		{"120", 60 * time.Second},
		{"99999999999999999999", 0}, // not a number we can hold: backoff
		{now.Add(10 * time.Second).Format(http.TimeFormat), 10 * time.Second},
		{now.Add(time.Hour).Format(http.TimeFormat), 60 * time.Second},
		{now.Add(-time.Minute).Format(http.TimeFormat), 0},
	}
	for _, c := range cases {
		if got := parseRetryAfter(c.header, now); got != c.want {
			t.Errorf("Retry-After %q = %v, want %v", c.header, got, c.want)
		}
	}

	srv, _ := serve(t, func(n int, _ captured, w http.ResponseWriter) {
		if n == 1 {
			w.Header().Set("Retry-After", "3600")
			writeJSON(w, 429, map[string]string{})
			return
		}
		writeJSON(w, 200, pong{OK: true})
	})
	r, slept := newTestRequester()
	if err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{}); err != nil {
		t.Fatal(err)
	}
	if got := slept.all(); !equalDurations(got, []time.Duration{60 * time.Second}) {
		t.Fatalf("waits = %v, want the hour capped to 60s", got)
	}
}

func TestTimeoutIsRetriedAndEachRequestHasADeadline(t *testing.T) {
	var deadlines []time.Duration
	calls := 0
	r, slept := newTestRequester()
	r.timeout = 7 * time.Second
	r.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		d, ok := req.Context().Deadline()
		if !ok {
			t.Error("the request has no deadline")
		}
		deadlines = append(deadlines, time.Until(d))
		if calls < 3 {
			return nil, &url.Error{Op: "Post", URL: req.URL.String(), Err: timeoutErr{}}
		}
		return okResponse(`{"ok":true}`), nil
	})}
	var out pong
	if err := r.post(context.Background(), "http://embed.invalid/x", nil, []byte(`{}`), &out); err != nil || !out.OK {
		t.Fatalf("err=%v ok=%v", err, out.OK)
	}
	if calls != 3 || !equalDurations(slept.all(), []time.Duration{time.Second, 2 * time.Second}) {
		t.Fatalf("calls=%d waits=%v, want 2 retries of a timeout", calls, slept.all())
	}
	for _, d := range deadlines {
		if d <= 6*time.Second || d > 7*time.Second {
			t.Errorf("deadline in %v, want about the 7s timeout", d)
		}
	}
	if defaultRequestTimeout != 60*time.Second || newRequester("x").timeout != 60*time.Second {
		t.Error("the default per-request timeout is not 60s")
	}
}

func TestOtherNetworkErrorsAreNotRetried(t *testing.T) {
	calls := 0
	r, slept := newTestRequester()
	r.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("dial tcp 127.0.0.1:11434: connectex: No connection could be made because the target machine actively refused it")
	})}
	err := r.post(context.Background(), "http://127.0.0.1:11434/api/embed", nil, []byte(`{}`), &pong{})
	if err == nil || !strings.HasPrefix(err.Error(), "Test: ") || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("error = %v", err)
	}
	if calls != 1 || len(slept.all()) != 0 {
		t.Fatalf("calls=%d waits=%v, want no retry of a refused connection", calls, slept.all())
	}
}

func TestCancelDuringBackoffStopsAtOnce(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) { writeJSON(w, 503, map[string]string{}) })
	ctx, cancel := context.WithCancel(context.Background())
	r, _ := newTestRequester()
	r.sleep = func(ctx context.Context, d time.Duration) error {
		cancel() // the user stops the run while it waits
		return ctx.Err()
	}
	err := r.post(ctx, srv.URL, nil, []byte(`{}`), &pong{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if rec.count() != 1 {
		t.Fatalf("requests = %d, want the one sent before the cancel", rec.count())
	}
}

func TestCancelledBeforeSendingSendsNothing(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) { writeJSON(w, 200, pong{OK: true}) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, _ := newTestRequester()
	if err := r.post(ctx, srv.URL, nil, []byte(`{}`), &pong{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if rec.count() != 0 {
		t.Fatalf("a cancelled call sent %d requests", rec.count())
	}
}

func TestCancelDuringRequestIsNotRetried(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	r, _ := newTestRequester()
	r.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		cancel()
		return nil, &url.Error{Op: "Post", URL: req.URL.String(), Err: context.Canceled}
	})}
	if err := r.post(ctx, "http://embed.invalid/x", nil, []byte(`{}`), &pong{}); !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestSleepCtx(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("a cancelled sleep did not return at once")
	}
	if err := sleepCtx(context.Background(), 0); err != nil {
		t.Fatalf("a zero wait returned %v", err)
	}
}

func TestAnswerSizeIsCapped(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"ok":true,"pad":"` + strings.Repeat("x", 200) + `"}`))
	})
	r, slept := newTestRequester()
	r.maxBody = 100
	err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{})
	if err == nil || !strings.Contains(err.Error(), "larger") {
		t.Fatalf("error = %v, want a too-large answer", err)
	}
	if rec.count() != 1 || len(slept.all()) != 0 {
		t.Fatalf("requests=%d waits=%v, want no retry of a too-large answer", rec.count(), slept.all())
	}
	if maxResponseBody != 64<<20 {
		t.Error("the answer cap is not 64 MB")
	}
}

func TestUnreadableAnswerIsAnError(t *testing.T) {
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) { _, _ = w.Write([]byte("<html>not json</html>")) })
	r, _ := newTestRequester()
	err := r.post(context.Background(), srv.URL, nil, []byte(`{}`), &pong{})
	if err == nil || !strings.Contains(err.Error(), "unreadable answer") || !strings.Contains(err.Error(), "not json") {
		t.Fatalf("error = %v", err)
	}
}

func TestHeadersAndBodyAreSent(t *testing.T) {
	srv, rec := serve(t, func(_ int, _ captured, w http.ResponseWriter) { writeJSON(w, 200, pong{OK: true}) })
	r, _ := newTestRequester()
	if err := r.post(context.Background(), srv.URL+"/p", map[string]string{"X-Test": "yes"}, []byte(`{"a":1}`), &pong{}); err != nil {
		t.Fatal(err)
	}
	c := rec.all()[0]
	if c.Method != "POST" || c.Path != "/p" || c.Header.Get("Content-Type") != "application/json" || c.Header.Get("X-Test") != "yes" || string(c.Body) != `{"a":1}` {
		t.Fatalf("request = %+v", c)
	}
}

func TestAKeyIsNeverInAnError(t *testing.T) {
	const key = "sk-live-ABCDEF0123456789"
	echo := `{"error":{"message":"Incorrect API key provided: ` + key + `. Also sk-proj-****wxyz, Bearer ` + key + `, ?key=` + key + `"}}`
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(echo))
	})
	r, _ := newTestRequester(key)
	err := r.post(context.Background(), srv.URL+"?key="+key, map[string]string{"Authorization": "Bearer " + key}, []byte(`{}`), &pong{})
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("error = %v", err)
	}
	for _, leak := range []string{key, "ABCDEF0123456789", "wxyz"} {
		if strings.Contains(err.Error(), leak) {
			t.Errorf("error text %q holds %q", err, leak)
		}
	}

	// A connection that cannot be made names the URL in net/http's own error; the key in its query string must not survive.
	r.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})}
	err = r.post(context.Background(), "http://embed.invalid/x?key="+key, nil, []byte(`{}`), &pong{})
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("expected a connection error, got %v", err)
	}
	if strings.Contains(err.Error(), key) {
		t.Errorf("connection error %q holds the key", err)
	}
	if strings.Contains(err.Error(), "?key="+key) {
		t.Errorf("connection error %q holds the key parameter", err)
	}
}

func TestUserinfoOfABaseURLIsNotShown(t *testing.T) {
	r, _ := newTestRequester()
	r.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, &url.Error{Op: "Post", URL: req.URL.String(), Err: errors.New("no route")}
	})}
	err := r.post(context.Background(), "http://user:hunter2@embed.invalid/x", nil, []byte(`{}`), &pong{})
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("error = %v", err)
	}
}

func TestRedact(t *testing.T) {
	cases := []struct{ in, notWant string }{
		{"key is secret-key-1", "secret-key-1"},
		{"GET /x?key=abc123&b=1", "abc123"},
		{"GET /x?api_key=abc123", "abc123"},
		{"AIzaSyA1234567890abcdefghij is mine", "AIzaSyA1234567890abcdefghij"},
		{"Authorization: Bearer abcdefgh12345", "abcdefgh12345"},
		{"Incorrect API key: sk-proj-****abcd", "sk-proj-****abcd"},
		{"http://me:pw@host/", "me:pw"},
		{"url encoded a%2Bb%2Fc", "a%2Bb%2Fc"},
	}
	for _, c := range cases {
		got := redact(c.in, "secret-key-1", "a+b/c")
		if strings.Contains(got, c.notWant) {
			t.Errorf("redact(%q) = %q, still holds %q", c.in, got, c.notWant)
		}
	}
	if got := redact("nothing to hide here"); got != "nothing to hide here" {
		t.Errorf("redact changed a clean text: %q", got)
	}
}

func TestSnippetIsShortAndStaysValidUTF8(t *testing.T) {
	r, _ := newTestRequester("k-secret")
	long := strings.Repeat("あ", 400) // 3 bytes each: a cut at 300 bytes would land inside a rune only if it were careless
	got := r.snippet([]byte(long))
	if len(got) > snippetBytes+3 || !strings.HasSuffix(got, "...") {
		t.Fatalf("snippet is %d bytes: %q", len(got), got)
	}
	if strings.ContainsRune(got, '�') {
		t.Fatal("snippet was cut inside a character")
	}
	if got := r.snippet([]byte("a\n\n  b\tk-secret")); got != "a b ***" {
		t.Fatalf("snippet = %q, want whitespace collapsed and the key removed", got)
	}
}

func TestARedirectToAnotherHostIsRefused(t *testing.T) {
	other, otherRec := serve(t, func(_ int, _ captured, w http.ResponseWriter) { writeJSON(w, 200, pong{OK: true}) })
	srv, _ := serve(t, func(_ int, _ captured, w http.ResponseWriter) {
		w.Header().Set("Location", other.URL+"/steal")
		w.WriteHeader(307)
	})
	r, _ := newTestRequester()
	err := r.post(context.Background(), srv.URL, map[string]string{"x-goog-api-key": "k-secret"}, []byte(`{}`), &pong{})
	if err == nil {
		t.Fatal("expected the redirect to be refused")
	}
	if otherRec.count() != 0 {
		t.Fatal("the request, with its key header, was forwarded to another host")
	}
}

func TestHTTPErrorText(t *testing.T) {
	if got := (&HTTPError{Provider: "P", Status: 404}).Error(); got != "P: HTTP 404" {
		t.Errorf("got %q", got)
	}
	if got := (&HTTPError{Provider: "P", Status: 404, Body: "no model"}).Error(); got != "P: HTTP 404: no model" {
		t.Errorf("got %q", got)
	}
}
