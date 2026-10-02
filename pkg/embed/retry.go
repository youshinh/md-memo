package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	defaultRequestTimeout = 60 * time.Second
	// maxRetries is how many times a failed request is sent again (so a request is sent at most 1+3 times).
	maxRetries  = 3
	backoffBase = time.Second // the waits are 1s, 2s, 4s (with jitter) when the server names none
	// maxRetryAfter caps a server's Retry-After: indexing runs in the background and may wait, but never minutes per request.
	maxRetryAfter = 60 * time.Second
	// maxResponseBody caps what is read from an answer. A batch of 100 vectors of 3,072 floats is about 6 MB of JSON; this leaves
	// plenty of room and still stops a runaway or hostile server from filling the memory.
	maxResponseBody = 64 << 20
	// maxErrorBody caps what is read from an error answer, of which only a short snippet is ever shown.
	maxErrorBody = 64 << 10
	snippetBytes = 300
)

// HTTPError is a provider's non-2xx answer. Its text names the provider, the status and a short snippet of the body with every
// secret taken out. Callers can errors.As it to tell a rejected key (401/403) or an unknown model (404) from a transient failure.
type HTTPError struct {
	Provider string
	Status   int
	Body     string // a short snippet, already redacted
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("%s: HTTP %d", e.Provider, e.Status)
	}
	return fmt.Sprintf("%s: HTTP %d: %s", e.Provider, e.Status, e.Body)
}

// requester is the one place a provider's HTTP request is made: a per-request timeout, bounded retries with backoff, a size cap on
// the answer, and errors that never carry the API key. The fields after "provider" are replaced by tests (no real waiting, no real
// randomness).
type requester struct {
	provider string
	secrets  []string // the API key (the text of an error is scrubbed of these)

	client  *http.Client
	timeout time.Duration
	maxBody int64
	sleep   func(ctx context.Context, d time.Duration) error
	rnd     func() float64 // [0,1): the jitter
	now     func() time.Time
}

func newRequester(provider string, secrets ...string) *requester {
	return &requester{
		provider: provider,
		secrets:  secrets,
		client:   sharedClient,
		timeout:  defaultRequestTimeout,
		maxBody:  maxResponseBody,
		sleep:    sleepCtx,
		rnd:      rand.Float64,
		now:      time.Now,
	}
}

// sharedClient has no Client.Timeout: every request carries its own context deadline, which also covers reading the body. It does
// not follow a redirect to another host: the API key travels in a header (x-goog-api-key is not one of the headers net/http drops
// on a cross-host redirect), and an embedding endpoint has no reason to redirect anywhere else.
var sharedClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("stopped after 5 redirects")
		}
		if req.URL.Host != via[0].URL.Host {
			return errors.New("refusing to follow a redirect to another host")
		}
		return nil
	},
}

// sleepCtx waits d, or returns ctx's error as soon as ctx ends.
func sleepCtx(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// post sends body to endpoint and decodes the JSON answer into out. A 429/500/502/503/504 and a network timeout are tried again
// (honouring Retry-After); every other failure, a 400 above all, is returned at once because sending the same request again cannot
// change the answer.
func (r *requester) post(ctx context.Context, endpoint string, header map[string]string, body []byte, out any) error {
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", r.provider, err)
		}
		res, err := r.once(ctx, endpoint, header, body)

		var failure error
		var wait time.Duration
		switch {
		case err != nil:
			// The caller's cancel or deadline ends everything; only the per-request timeout is worth another try.
			if cerr := ctx.Err(); cerr != nil {
				return fmt.Errorf("%s: %w", r.provider, cerr)
			}
			failure = r.networkFailure(err)
			if !isTimeout(err) {
				return failure
			}
		case res.status >= 200 && res.status < 300:
			if err := json.Unmarshal(res.body, out); err != nil {
				return fmt.Errorf("%s: unreadable answer (%v), it starts: %s", r.provider, err, r.snippet(res.body))
			}
			return nil
		default:
			he := &HTTPError{Provider: r.provider, Status: res.status, Body: r.snippet(res.body)}
			if !retryableStatus(res.status) {
				return he
			}
			failure, wait = he, res.retryAfter
		}

		if attempt >= maxRetries {
			return fmt.Errorf("%w (gave up after %d attempts)", failure, attempt+1)
		}
		if wait <= 0 {
			wait = r.backoff(attempt)
		}
		if err := r.sleep(ctx, wait); err != nil {
			return fmt.Errorf("%s: %w", r.provider, err)
		}
	}
}

type answer struct {
	status     int
	body       []byte
	retryAfter time.Duration
}

var errAnswerTooLarge = errors.New("the answer is larger than the size this client accepts")

func (r *requester) once(ctx context.Context, endpoint string, header map[string]string, body []byte) (*answer, error) {
	reqCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel() // after the body is read: the deadline covers a stalled body too
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "md-memo")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	ok := resp.StatusCode >= 200 && resp.StatusCode < 300
	limit := r.maxBody
	if !ok {
		limit = maxErrorBody
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		if ok {
			return nil, errAnswerTooLarge
		}
		raw = raw[:limit] // an error page: the start is all that is shown
	}
	return &answer{
		status:     resp.StatusCode,
		body:       raw,
		retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), r.now()),
	}, nil
}

func retryableStatus(s int) bool {
	switch s {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// backoff is 1s, 2s, 4s for attempts 0, 1, 2, each stretched or shrunk by up to a quarter so that several clients do not retry in step.
func (r *requester) backoff(attempt int) time.Duration {
	d := float64(backoffBase << attempt)
	return time.Duration(d * (0.75 + 0.5*r.rnd()))
}

// parseRetryAfter reads both forms of the header (seconds, or an HTTP date). Absent, invalid or already past gives 0 (use the backoff).
func parseRetryAfter(h string, now time.Time) time.Duration {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0
	}
	if secs, err := strconv.ParseInt(h, 10, 64); err == nil {
		if secs <= 0 {
			return 0
		}
		if secs >= int64(maxRetryAfter/time.Second) {
			return maxRetryAfter
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		d := t.Sub(now)
		if d <= 0 {
			return 0
		}
		return min(d, maxRetryAfter)
	}
	return 0
}

// scrubbedError is an error whose text has had the secrets taken out. errors.Is / errors.As still see the original chain (so a
// timeout or a cancel stays recognisable) without the original text, which names the URL, being handed out by Unwrap.
type scrubbedError struct {
	msg string
	err error
}

func (e *scrubbedError) Error() string        { return e.msg }
func (e *scrubbedError) Is(target error) bool { return errors.Is(e.err, target) }
func (e *scrubbedError) As(target any) bool   { return errors.As(e.err, target) }

func (r *requester) networkFailure(err error) error {
	return &scrubbedError{msg: r.provider + ": " + r.redact(err.Error()), err: err}
}

func (r *requester) redact(text string) string { return redact(text, r.secrets...) }

// snippet is the start of an answer body, secrets taken out and whitespace collapsed, for an error message.
func (r *requester) snippet(body []byte) string {
	s := strings.Join(strings.Fields(r.redact(string(body))), " ")
	if len(s) <= snippetBytes {
		return s
	}
	cut := snippetBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "..."
}

// The patterns catch what the exact key does not: a key echoed in a query string, a Google key, a bearer token, an OpenAI-style key
// (which OpenAI's 401 answer repeats in a masked form), the user:password of a URL.
// They are compiled on first use, so a program that never embeds pays nothing for them.
type redactor struct {
	re   *regexp.Regexp
	with string
}

var redactors = sync.OnceValue(func() []redactor {
	return []redactor{
		{regexp.MustCompile(`(?i)([?&;](?:key|api[_-]?key|apikey|access[_-]?token|token)=)[^&\s"'<>)\]]+`), "${1}***"},
		{regexp.MustCompile(`AIza[0-9A-Za-z_\-]{16,}`), "***"},
		{regexp.MustCompile(`(?i)(\bBearer\s+)[A-Za-z0-9._~+/=\-]{8,}`), "${1}***"},
		{regexp.MustCompile(`\bsk-[A-Za-z0-9_*\-]{6,}`), "***"},
		{regexp.MustCompile(`(://)[^/\s@]+@`), "${1}***@"},
	}
})

// redact returns text with the given secrets, and anything shaped like a key or token, replaced by ***.
func redact(text string, secrets ...string) string {
	for _, s := range secrets {
		if s == "" {
			continue
		}
		text = strings.ReplaceAll(text, s, "***")
		if esc := url.QueryEscape(s); esc != s {
			text = strings.ReplaceAll(text, esc, "***")
		}
	}
	for _, p := range redactors() {
		text = p.re.ReplaceAllString(text, p.with)
	}
	return text
}
