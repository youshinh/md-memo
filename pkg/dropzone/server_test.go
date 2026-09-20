package dropzone

import (
	"bytes"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// newHandlerTestServer builds a *Server suitable for calling its HTTP
// handlers directly (no real network listener involved), with the token
// pre-set the way Start() would set it.
func newHandlerTestServer(onComplete func(Payload)) *Server {
	s := &Server{OnComplete: onComplete}
	s.token = "test-token-123"
	return s
}

// textRequest builds a POST /upload-text request carrying the token in the
// URL, the way the real page does.
func textRequest(token, text string) *http.Request {
	form := url.Values{"text": {text}}
	req := httptest.NewRequest(http.MethodPost, "/upload-text?token="+url.QueryEscape(token), strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func TestHandleUploadTextRequiresToken(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	// wrong token, token only in the body (not accepted), and no token at all
	reqs := []*http.Request{
		textRequest("wrong", "hello"),
		func() *http.Request {
			form := url.Values{"text": {"hello"}, "token": {s.token}}
			r := httptest.NewRequest(http.MethodPost, "/upload-text", strings.NewReader(form.Encode()))
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			return r
		}(),
		textRequest("", "hello"),
	}
	for i, req := range reqs {
		rec := httptest.NewRecorder()
		s.handleUploadText(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("request %d: expected 403, got %d", i, rec.Code)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("OnComplete must not fire for an unauthorized request")
	}
}

// trackingBody records whether anything was read from it.
type trackingBody struct {
	r    io.Reader
	read int32
}

func (b *trackingBody) Read(p []byte) (int, error) {
	atomic.StoreInt32(&b.read, 1)
	return b.r.Read(p)
}

func TestUnauthenticatedRequestsDoNotReadTheBody(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})

	body, contentType := buildMultipart(t, s.token, "photo.png", "image/png", []byte("\x89PNG\r\n\x1a\nxx"))
	tb := &trackingBody{r: body}
	req := httptest.NewRequest(http.MethodPost, "/upload?token=wrong", tb)
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("/upload: expected 403, got %d", rec.Code)
	}
	if atomic.LoadInt32(&tb.read) != 0 {
		t.Error("/upload read the request body before authenticating")
	}

	tb = &trackingBody{r: strings.NewReader("text=hello")}
	req = httptest.NewRequest(http.MethodPost, "/upload-text?token=wrong", tb)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec = httptest.NewRecorder()
	s.handleUploadText(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("/upload-text: expected 403, got %d", rec.Code)
	}
	if atomic.LoadInt32(&tb.read) != 0 {
		t.Error("/upload-text read the request body before authenticating")
	}
}

func TestHandleUploadTextClassification(t *testing.T) {
	cases := []struct {
		name string
		text string
		want Kind
	}{
		{"bare url", "https://example.com/note", KindURL},
		{"plain text", "buy milk tomorrow", KindText},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			received := make(chan Payload, 1)
			s := newHandlerTestServer(func(p Payload) { received <- p })

			rec := httptest.NewRecorder()
			s.handleUploadText(rec, textRequest(s.token, c.text))

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			select {
			case p := <-received:
				if p.Kind != c.want {
					t.Errorf("Kind = %v, want %v", p.Kind, c.want)
				}
				if p.Text != c.text {
					t.Errorf("Text = %q, want %q", p.Text, c.text)
				}
			case <-time.After(time.Second):
				t.Fatal("OnComplete was never called")
			}
		})
	}
}

func TestHandleUploadTextRejectsEmpty(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	rec := httptest.NewRecorder()
	s.handleUploadText(rec, textRequest(s.token, "   "))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for blank text, got %d", rec.Code)
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("OnComplete must not fire for empty text")
	}
}

func TestHandleUploadTextRejectsOversizedText(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	rec := httptest.NewRecorder()
	s.handleUploadText(rec, textRequest(s.token, strings.Repeat("x", int(MaxTextBytes)+1)))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for text over MaxTextBytes, got %d", rec.Code)
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("OnComplete must not fire for oversized text")
	}
}

// buildMultipart assembles a multipart/form-data body with a token field
// and a single file field.
func buildMultipart(t *testing.T, token, fieldFilename, contentType string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	if err := w.WriteField("token", token); err != nil {
		t.Fatalf("WriteField token: %v", err)
	}
	part, err := w.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="` + fieldFilename + `"`},
		"Content-Type":        {contentType},
	})
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return buf, w.FormDataContentType()
}

// uploadRequest builds a POST /upload request carrying the token in the URL.
func uploadRequest(t *testing.T, token, filename, contentType string, data []byte) *http.Request {
	t.Helper()
	body, formType := buildMultipart(t, token, filename, contentType, data)
	req := httptest.NewRequest(http.MethodPost, "/upload?token="+url.QueryEscape(token), body)
	req.Header.Set("Content-Type", formType)
	return req
}

func TestHandleUploadRequiresToken(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, "wrong-token", "photo.png", "image/png", []byte("fake-png-bytes")))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("OnComplete must not fire for an unauthorized upload")
	}
}

func TestHandleUploadImageClassification(t *testing.T) {
	received := make(chan Payload, 1)
	s := newHandlerTestServer(func(p Payload) { received <- p })

	imgBytes := []byte("\x89PNG\r\n\x1a\nfake-but-good-enough-for-sniffing")
	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "photo.png", "image/png", imgBytes))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case p := <-received:
		if p.Kind != KindImage {
			t.Errorf("Kind = %v, want KindImage", p.Kind)
		}
		if p.MimeType != "image/png" {
			t.Errorf("MimeType = %q, want image/png", p.MimeType)
		}
		if p.Filename != "photo.png" {
			t.Errorf("Filename = %q, want photo.png", p.Filename)
		}
		if !bytes.Equal(p.Data, imgBytes) {
			t.Errorf("Data mismatch: got %q want %q", p.Data, imgBytes)
		}
	case <-time.After(time.Second):
		t.Fatal("OnComplete was never called")
	}
}

func TestHandleUploadFileClassification(t *testing.T) {
	received := make(chan Payload, 1)
	s := newHandlerTestServer(func(p Payload) { received <- p })

	// Generic declared type, forcing sniffing — mirrors a mobile browser
	// sending application/octet-stream for an unknown extension.
	textBytes := []byte("# Hello\n\nSome markdown body.")
	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "notes.md", "application/octet-stream", textBytes))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case p := <-received:
		if p.Kind != KindFile {
			t.Errorf("Kind = %v, want KindFile", p.Kind)
		}
		if p.Filename != "notes.md" {
			t.Errorf("Filename = %q, want notes.md", p.Filename)
		}
	case <-time.After(time.Second):
		t.Fatal("OnComplete was never called")
	}
}

func TestHandleUploadRejectsBinaryAndOversizedFiles(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "tool.txt", "text/plain", []byte("MZ\x90\x00\x03\x00\x00\x00binary")))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("binary file: expected 415, got %d", rec.Code)
	}

	big := bytes.Repeat([]byte("a"), int(MaxTextBytes)+1)
	rec = httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "big.txt", "text/plain", big))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized text file: expected 413, got %d", rec.Code)
	}

	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatalf("OnComplete must not fire for a rejected file")
	}
}

func TestClassifyUpload(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nrest")
	cases := []struct {
		name     string
		declared string
		data     []byte
		wantKind Kind
		wantMime string
	}{
		{"png declared png", "image/png", png, KindImage, "image/png"},
		{"png declared octet-stream", "application/octet-stream", png, KindImage, "image/png"},
		{"png declared with parameters", "image/png; charset=binary", png, KindImage, "image/png"},
		{"text mislabelled as image", "image/jpeg", []byte("just some text"), KindFile, "text/plain; charset=utf-8"},
		{"heic is not sniffable but is an image", "image/heic", []byte("ftypheic-ish bytes"), KindImage, "image/heic"},
		{"markdown", "text/markdown", []byte("# hi"), KindFile, "text/plain; charset=utf-8"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kind, mime := classifyUpload(c.declared, c.data)
			if kind != c.wantKind || mime != c.wantMime {
				t.Errorf("classifyUpload = (%v, %q), want (%v, %q)", kind, mime, c.wantKind, c.wantMime)
			}
		})
	}
}

func TestHandleUploadMissingFilePart(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})

	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	_ = w.WriteField("token", s.token)
	_ = w.Close()

	req := httptest.NewRequest(http.MethodPost, "/upload?token="+s.token, buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	s.handleUpload(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing file part, got %d", rec.Code)
	}
}

func TestHandleIndexRequiresToken(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	s.handleIndex(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/?token="+s.token, nil)
	rec = httptest.NewRecorder()
	s.handleIndex(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with correct token, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "MD-Memo") {
		t.Errorf("index page missing expected content")
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("index page should forbid framing, CSP = %q", csp)
	}
}

func TestOtherPathsAreNotFound(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})
	for _, target := range []string{"/favicon.ico", "/favicon.ico?token=" + s.token, "/admin?token=" + s.token} {
		rec := httptest.NewRecorder()
		s.handleIndex(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: expected 404, got %d", target, rec.Code)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})
	h := withSecurityHeaders(http.HandlerFunc(s.handleIndex))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/?token="+s.token, nil))

	for header, want := range map[string]string{
		"Referrer-Policy":        "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "no-store",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	// Errors carry them too, so a 403 body is not cached or sniffed either.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("error responses must carry the security headers")
	}
}

func TestMaxBodyBytesEnforced(t *testing.T) {
	s := newHandlerTestServer(func(Payload) {})
	s.MaxBodyBytes = 64 // deliberately tiny

	rec := httptest.NewRecorder()
	s.handleUploadText(rec, textRequest(s.token, strings.Repeat("x", 500)))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", rec.Code)
	}
}

func TestOnlyOneSubmissionIsAccepted(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	first := httptest.NewRecorder()
	s.handleUploadText(first, textRequest(s.token, "first"))
	second := httptest.NewRecorder()
	s.handleUploadText(second, textRequest(s.token, "second"))

	if first.Code != http.StatusOK {
		t.Fatalf("first submission: expected 200, got %d", first.Code)
	}
	if second.Code != http.StatusConflict {
		t.Fatalf("second submission: expected 409, got %d", second.Code)
	}
	time.Sleep(50 * time.Millisecond)
	if n := atomic.LoadInt32(&called); n != 1 {
		t.Fatalf("OnComplete called %d times, want exactly 1", n)
	}
}

func TestConcurrentSubmissionsDeliverOnce(t *testing.T) {
	var called, accepted int32
	s := newHandlerTestServer(func(Payload) { atomic.AddInt32(&called, 1) })

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			s.handleUploadText(rec, textRequest(s.token, "note "+strconv.Itoa(i)))
			if rec.Code == http.StatusOK {
				atomic.AddInt32(&accepted, 1)
			}
		}(i)
	}
	wg.Wait()
	time.Sleep(50 * time.Millisecond)

	if n := atomic.LoadInt32(&accepted); n != 1 {
		t.Errorf("%d requests were answered 200, want exactly 1", n)
	}
	if n := atomic.LoadInt32(&called); n != 1 {
		t.Errorf("OnComplete called %d times, want exactly 1", n)
	}
}

func TestStopIsIdempotentAndSafeBeforeStart(t *testing.T) {
	s := New(func(Payload) {})
	s.Stop()
	s.Stop() // must not panic
}

// stubNetworkForTest replaces the package-level LAN-IP detector and port
// listener with test-safe versions: a fixed documentation-range IP
// (RFC 5737) for the former, and a loopback-only, OS-assigned port for the
// latter (avoiding both real host network dependence and binding the real
// default port). It restores the originals on test cleanup and returns the
// real listener the stub created, once Start has run, via the returned
// getter.
func stubNetworkForTest(t *testing.T) func() net.Listener {
	t.Helper()
	origIP, origListener := lanIPDetector, portListener
	var captured net.Listener
	lanIPDetector = func() (string, error) { return "203.0.113.5", nil }
	portListener = func() (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		captured = ln
		return ln, nil
	}
	t.Cleanup(func() {
		lanIPDetector, portListener = origIP, origListener
	})
	return func() net.Listener { return captured }
}

func TestStartTwiceReturnsError(t *testing.T) {
	getLn := stubNetworkForTest(t)
	s := New(func(Payload) {})
	s.IdleTimeout = time.Minute
	if _, err := s.Start(); err != nil {
		t.Fatalf("first Start() failed: %v", err)
	}
	defer s.Stop()

	if _, err := s.Start(); err == nil {
		t.Fatalf("second Start() should have returned an error")
	}
	if getLn() == nil {
		t.Fatalf("test setup problem: listener was never captured")
	}
}

func TestIdleTimeoutFires(t *testing.T) {
	stubNetworkForTest(t)
	timedOut := make(chan struct{}, 1)
	s := New(func(Payload) { t.Errorf("OnComplete should not fire in a timeout test") })
	s.OnTimeout = func() { close(timedOut) }
	s.IdleTimeout = 30 * time.Millisecond

	if _, err := s.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}

	select {
	case <-timedOut:
	case <-time.After(time.Second):
		t.Fatal("OnTimeout was never called")
	}
}

func TestAcceptedSubmissionSuppressesTheIdleTimeout(t *testing.T) {
	stubNetworkForTest(t)
	var timedOut int32
	s := New(func(Payload) {})
	s.OnTimeout = func() { atomic.AddInt32(&timedOut, 1) }
	s.IdleTimeout = 30 * time.Millisecond

	if _, err := s.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	defer s.Stop()
	if !s.claim() {
		t.Fatal("claim() should succeed on a fresh server")
	}
	if s.claim() {
		t.Fatal("a second claim() must fail")
	}

	// OnComplete (e.g. photo OCR) can outlast the idle timeout; the phone was already
	// told OK, so a "timed out" report would be wrong.
	time.Sleep(150 * time.Millisecond)
	if atomic.LoadInt32(&timedOut) != 0 {
		t.Fatal("OnTimeout fired after a submission was accepted")
	}
}

func TestFullLifecycleUploadThenShutdown(t *testing.T) {
	getLn := stubNetworkForTest(t)
	received := make(chan Payload, 1)
	s := New(func(p Payload) { received <- p })
	s.IdleTimeout = 5 * time.Second // long enough not to interfere

	result, err := s.Start()
	if err != nil {
		t.Fatalf("Start() failed: %v", err)
	}

	parsed, err := url.Parse(result.URL)
	if err != nil {
		t.Fatalf("parsing result URL: %v", err)
	}
	token := parsed.Query().Get("token")
	if token == "" {
		t.Fatalf("result URL missing token: %s", result.URL)
	}

	ln := getLn()
	if ln == nil {
		t.Fatalf("listener was never captured")
	}
	realPort := ln.Addr().(*net.TCPAddr).Port
	realBase := "http://127.0.0.1:" + strconv.Itoa(realPort)

	// The page itself is served with the hardening headers.
	page, err := http.Get(realBase + "/?token=" + token)
	if err != nil {
		t.Fatalf("GET / failed: %v", err)
	}
	_ = page.Body.Close()
	if page.StatusCode != http.StatusOK || page.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("index over the real server: status %d, Referrer-Policy %q", page.StatusCode, page.Header.Get("Referrer-Policy"))
	}

	form := url.Values{"text": {"hello from phone"}}
	resp, err := http.Post(realBase+"/upload-text?token="+token, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()))
	if err != nil {
		t.Fatalf("POST /upload-text failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	select {
	case p := <-received:
		if p.Kind != KindText || p.Text != "hello from phone" {
			t.Errorf("unexpected payload: %+v", p)
		}
	case <-time.After(time.Second):
		t.Fatal("OnComplete was never called")
	}

	// The server shuts itself down after a successful submission — a
	// second request should fail to connect (or at least not succeed),
	// polling briefly since shutdown happens in a background goroutine.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, err := http.Get(realBase + "/?token=" + token)
		if err != nil {
			return // connection refused/closed, as expected
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("server did not shut down after a successful submission")
}

func TestDetectLANIPPrefersTheDefaultRouteInterface(t *testing.T) {
	orig := routeLocalIP
	t.Cleanup(func() { routeLocalIP = orig })
	routeLocalIP = func() (net.IP, error) { return net.ParseIP("192.168.1.23"), nil }

	got, err := detectLANIP()
	if err != nil {
		t.Fatalf("detectLANIP() error: %v", err)
	}
	if got != "192.168.1.23" {
		t.Errorf("detectLANIP() = %q, want the default-route address 192.168.1.23", got)
	}
}

func TestIsVirtualInterface(t *testing.T) {
	for name, want := range map[string]bool{
		"vEthernet (WSL)":               true,
		"vEthernet (Default Switch)":    true,
		"VMware Network Adapter VMnet8": true,
		"VirtualBox Host-Only Network":  true,
		"docker0":                       true,
		"br-1a2b3c4d5e6f":               true,
		"Tailscale":                     true,
		"Wi-Fi":                         false,
		"Ethernet":                      false,
		"en0":                           false,
		"wlan0":                         false,
	} {
		if got := isVirtualInterface(name); got != want {
			t.Errorf("isVirtualInterface(%q) = %v, want %v", name, got, want)
		}
	}
}
