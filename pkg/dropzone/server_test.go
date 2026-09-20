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
func newHandlerTestServer(onBatch func(Batch)) *Server {
	s := &Server{OnBatch: onBatch}
	s.token = "test-token-123"
	return s
}

// onePayload is a convenience for tests that only care about a single-item
// batch (the shape /upload and /upload-text still deliver).
func onePayload(b Batch) Payload {
	if len(b.Items) != 1 {
		panic("expected a one-item batch")
	}
	return b.Items[0]
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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	s := newHandlerTestServer(func(Batch) {})

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
			received := make(chan Batch, 1)
			s := newHandlerTestServer(func(b Batch) { received <- b })

			rec := httptest.NewRecorder()
			s.handleUploadText(rec, textRequest(s.token, c.text))

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
			}
			select {
			case b := <-received:
				p := onePayload(b)
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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	received := make(chan Batch, 1)
	s := newHandlerTestServer(func(b Batch) { received <- b })

	imgBytes := []byte("\x89PNG\r\n\x1a\nfake-but-good-enough-for-sniffing")
	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "photo.png", "image/png", imgBytes))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case b := <-received:
		p := onePayload(b)
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
	received := make(chan Batch, 1)
	s := newHandlerTestServer(func(b Batch) { received <- b })

	// Generic declared type, forcing sniffing — mirrors a mobile browser
	// sending application/octet-stream for an unknown extension.
	textBytes := []byte("# Hello\n\nSome markdown body.")
	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "notes.md", "application/octet-stream", textBytes))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case b := <-received:
		p := onePayload(b)
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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
		filename string
		data     []byte
		wantKind Kind
		wantMime string
	}{
		{"png declared png", "image/png", "photo.png", png, KindImage, "image/png"},
		{"png declared octet-stream", "application/octet-stream", "photo.png", png, KindImage, "image/png"},
		{"png declared with parameters", "image/png; charset=binary", "photo.png", png, KindImage, "image/png"},
		{"text mislabelled as image", "image/jpeg", "note.txt", []byte("just some text"), KindFile, "text/plain; charset=utf-8"},
		{"heic is not sniffable but is an image", "image/heic", "photo.heic", []byte("ftypheic-ish bytes"), KindImage, "image/heic"},
		{"markdown", "text/markdown", "notes.md", []byte("# hi"), KindFile, "text/plain; charset=utf-8"},
		{"webm sniffs as video/webm but is a voice note", "video/webm", "voice_note_1.webm", []byte("\x1a\x45\xdf\xa3fake-webm"), KindAudio, "video/webm"},
		{"declared audio with a recognized extension but generic bytes", "audio/mp4", "voice_note_2.m4a", []byte("not really sniffable"), KindAudio, "audio/mp4"},
		{"declared audio without a recognized extension falls back to file", "audio/mp4", "clip", []byte("not really sniffable"), KindFile, "text/plain; charset=utf-8"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			kind, mime := classifyUpload(c.declared, c.filename, c.data)
			if kind != c.wantKind || mime != c.wantMime {
				t.Errorf("classifyUpload = (%v, %q), want (%v, %q)", kind, mime, c.wantKind, c.wantMime)
			}
		})
	}
}

func TestHandleUploadMissingFilePart(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})

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
	s := newHandlerTestServer(func(Batch) {})

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
	s := newHandlerTestServer(func(Batch) {})
	for _, target := range []string{"/favicon.ico", "/favicon.ico?token=" + s.token, "/admin?token=" + s.token} {
		rec := httptest.NewRecorder()
		s.handleIndex(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: expected 404, got %d", target, rec.Code)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})
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
	s := newHandlerTestServer(func(Batch) {})
	s.MaxBodyBytes = 64 // deliberately tiny

	rec := httptest.NewRecorder()
	s.handleUploadText(rec, textRequest(s.token, strings.Repeat("x", 500)))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", rec.Code)
	}
}

func TestOnlyOneSubmissionIsAccepted(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

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
	s := New(func(Batch) {})
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
	s := New(func(Batch) {})
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
	s := New(func(Batch) { t.Errorf("OnBatch should not fire in a timeout test") })
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
	s := New(func(Batch) {})
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
	received := make(chan Batch, 1)
	s := New(func(b Batch) { received <- b })
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
	case b := <-received:
		p := onePayload(b)
		if p.Kind != KindText || p.Text != "hello from phone" {
			t.Errorf("unexpected payload: %+v", p)
		}
	case <-time.After(time.Second):
		t.Fatal("OnBatch was never called")
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

// buildBatchMultipart assembles a multipart/form-data body for /upload-batch
// with a token field, zero or more named "file" parts, and an optional text
// field.
func buildBatchMultipart(t *testing.T, token string, files []struct {
	name, contentType string
	data              []byte
}, text string) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	if err := w.WriteField("token", token); err != nil {
		t.Fatalf("WriteField token: %v", err)
	}
	for _, f := range files {
		part, err := w.CreatePart(map[string][]string{
			"Content-Disposition": {`form-data; name="file"; filename="` + f.name + `"`},
			"Content-Type":        {f.contentType},
		})
		if err != nil {
			t.Fatalf("CreatePart: %v", err)
		}
		if _, err := part.Write(f.data); err != nil {
			t.Fatalf("write part: %v", err)
		}
	}
	if text != "" {
		if err := w.WriteField("text", text); err != nil {
			t.Fatalf("WriteField text: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return buf, w.FormDataContentType()
}

func batchRequest(t *testing.T, token string, files []struct {
	name, contentType string
	data              []byte
}, text string) *http.Request {
	t.Helper()
	body, formType := buildBatchMultipart(t, token, files, text)
	req := httptest.NewRequest(http.MethodPost, "/upload-batch?token="+url.QueryEscape(token), body)
	req.Header.Set("Content-Type", formType)
	return req
}

func TestHandleUploadBatchHappyPath(t *testing.T) {
	received := make(chan Batch, 1)
	s := newHandlerTestServer(func(b Batch) { received <- b })

	png := []byte("\x89PNG\r\n\x1a\nimage-one")
	png2 := []byte("\x89PNG\r\n\x1a\nimage-two")
	webm := []byte("\x1a\x45\xdf\xa3fake-webm-audio")

	files := []struct{ name, contentType string; data []byte }{
		{"IMG_1.png", "image/png", png},
		{"IMG_2.png", "image/png", png2},
		{"voice_note_1.webm", "audio/webm", webm},
	}
	req := batchRequest(t, s.token, files, "buy milk")
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case b := <-received:
		if len(b.Items) != 4 {
			t.Fatalf("expected 4 items (3 files + text), got %d: %+v", len(b.Items), b.Items)
		}
		wantKinds := []Kind{KindImage, KindImage, KindAudio, KindText}
		for i, want := range wantKinds {
			if b.Items[i].Kind != want {
				t.Errorf("item %d: Kind = %v, want %v", i, b.Items[i].Kind, want)
			}
		}
		if b.Items[0].Filename != "IMG_1.png" || b.Items[1].Filename != "IMG_2.png" {
			t.Errorf("file order not preserved: %+v", b.Items[:2])
		}
		if b.Items[3].Text != "buy milk" {
			t.Errorf("text item = %q, want %q", b.Items[3].Text, "buy milk")
		}
	case <-time.After(time.Second):
		t.Fatal("OnBatch was never called")
	}
}

func TestHandleUploadBatchRejectsTooManyFiles(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

	files := make([]struct{ name, contentType string; data []byte }, 11)
	for i := range files {
		files[i] = struct{ name, contentType string; data []byte }{
			name: "f" + strconv.Itoa(i) + ".png", contentType: "image/png", data: []byte("\x89PNG\r\n\x1a\nx"),
		}
	}
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, s.token, files, ""))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for 11 files, got %d", rec.Code)
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatal("OnBatch must not fire when the file count is rejected")
	}
}

func TestHandleUploadBatchRejectsOversizedItems(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})

	bigImage := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte("a"), int(maxBatchImageBytes))...)
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, s.token, []struct{ name, contentType string; data []byte }{
		{"big.png", "image/png", bigImage},
	}, ""))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized image: expected 413, got %d", rec.Code)
	}

	bigAudio := append([]byte("\x1a\x45\xdf\xa3"), bytes.Repeat([]byte("a"), int(maxBatchAudioBytes))...)
	rec = httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, s.token, []struct{ name, contentType string; data []byte }{
		{"big.webm", "audio/webm", bigAudio},
	}, ""))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized audio: expected 413, got %d", rec.Code)
	}
}

func TestHandleUploadBatchRejectsBinaryFile(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, s.token, []struct{ name, contentType string; data []byte }{
		{"tool.txt", "text/plain", []byte("MZ\x90\x00\x03\x00\x00\x00binary")},
	}, ""))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("binary file in a batch: expected 415, got %d", rec.Code)
	}
}

func TestHandleUploadBatchRejectsEmptyBatch(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, s.token, nil, "   "))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an empty batch, got %d", rec.Code)
	}
}

func TestHandleUploadBatchRequiresToken(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, batchRequest(t, "wrong", nil, "hello"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	time.Sleep(20 * time.Millisecond)
	if atomic.LoadInt32(&called) != 0 {
		t.Fatal("OnBatch must not fire for an unauthorized batch")
	}
}

func TestOnlyOneBatchSubmissionIsAccepted(t *testing.T) {
	var called int32
	s := newHandlerTestServer(func(Batch) { atomic.AddInt32(&called, 1) })

	var wg sync.WaitGroup
	var accepted int32
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			s.handleUploadBatch(rec, batchRequest(t, s.token, nil, "note "+strconv.Itoa(i)))
			if rec.Code == http.StatusOK {
				atomic.AddInt32(&accepted, 1)
			}
		}(i)
	}
	wg.Wait()
	time.Sleep(50 * time.Millisecond)

	if n := atomic.LoadInt32(&accepted); n != 1 {
		t.Errorf("%d concurrent batches were answered 200, want exactly 1", n)
	}
	if n := atomic.LoadInt32(&called); n != 1 {
		t.Errorf("OnBatch called %d times, want exactly 1", n)
	}
}

func TestParseGeo(t *testing.T) {
	cases := []struct {
		name     string
		lat, lon string
		wantNil  bool
		wantLat  float64
		wantLon  float64
	}{
		{"valid", "34.693738", "135.502165", false, 34.693738, 135.502165},
		{"missing lon", "34.693738", "", true, 0, 0},
		{"missing lat", "", "135.502165", true, 0, 0},
		{"missing both", "", "", true, 0, 0},
		{"NaN lat", "NaN", "135.5", true, 0, 0},
		{"NaN lon", "34.5", "NaN", true, 0, 0},
		{"lat out of range", "91", "135.5", true, 0, 0},
		{"lon out of range", "34.5", "181", true, 0, 0},
		{"lat exactly at boundary", "90", "180", false, 90, 180},
		{"not a number", "abc", "135.5", true, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := http.Header{}
			if c.lat != "" {
				h.Set("X-Geo-Lat", c.lat)
			}
			if c.lon != "" {
				h.Set("X-Geo-Lon", c.lon)
			}
			got := parseGeo(h)
			if c.wantNil {
				if got != nil {
					t.Errorf("parseGeo(lat=%q, lon=%q) = %+v, want nil", c.lat, c.lon, got)
				}
				return
			}
			if got == nil || got.Lat != c.wantLat || got.Lon != c.wantLon {
				t.Errorf("parseGeo(lat=%q, lon=%q) = %+v, want {%v %v}", c.lat, c.lon, got, c.wantLat, c.wantLon)
			}
		})
	}
}

func TestHandleUploadBatchAttachesGeoToFirstItemOnly(t *testing.T) {
	received := make(chan Batch, 1)
	s := newHandlerTestServer(func(b Batch) { received <- b })

	req := batchRequest(t, s.token, nil, "hello")
	req.Header.Set("X-Geo-Lat", "34.693738")
	req.Header.Set("X-Geo-Lon", "135.502165")
	rec := httptest.NewRecorder()
	s.handleUploadBatch(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	select {
	case b := <-received:
		if b.Geo == nil || b.Geo.Lat != 34.693738 || b.Geo.Lon != 135.502165 {
			t.Errorf("Batch.Geo = %+v, want the parsed coordinates", b.Geo)
		}
	case <-time.After(time.Second):
		t.Fatal("OnBatch was never called")
	}
}

func TestSharedTextRoundTrip(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})

	req := httptest.NewRequest(http.MethodGet, "/shared?token="+s.token, nil)
	rec := httptest.NewRecorder()
	s.handleShared(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"rev":0`) {
		t.Errorf("initial /shared should report rev 0, got %s", rec.Body.String())
	}

	s.SetSharedText("https://example.com/pull/42")
	rec = httptest.NewRecorder()
	s.handleShared(rec, req)
	body := rec.Body.String()
	if !strings.Contains(body, "https://example.com/pull/42") || !strings.Contains(body, `"rev":1`) {
		t.Errorf("/shared should reflect the new text and bump rev, got %s", body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestSharedTextRequiresToken(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})
	s.SetSharedText("secret selection")
	rec := httptest.NewRecorder()
	s.handleShared(rec, httptest.NewRequest(http.MethodGet, "/shared", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "secret selection") {
		t.Error("an unauthorized /shared request must not leak the text")
	}
}

func TestSetSharedTextCapsLength(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})
	s.SetSharedText(strings.Repeat("a", 100000))
	s.mu.Lock()
	n := len(s.sharedText)
	s.mu.Unlock()
	if n > maxSharedTextBytes {
		t.Errorf("shared text was not capped: %d bytes", n)
	}
}

func TestPingRequiresTokenAndReturnsNoContent(t *testing.T) {
	s := newHandlerTestServer(func(Batch) {})

	rec := httptest.NewRecorder()
	s.handlePing(rec, httptest.NewRequest(http.MethodPost, "/ping", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 without token, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	s.handlePing(rec, httptest.NewRequest(http.MethodPost, "/ping?token="+s.token, nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
}

func TestSharedPollingDoesNotResetIdleTimer(t *testing.T) {
	stubNetworkForTest(t)
	var timedOut int32
	s := New(func(Batch) {})
	s.OnTimeout = func() { atomic.AddInt32(&timedOut, 1) }
	s.IdleTimeout = 80 * time.Millisecond
	if _, err := s.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	defer s.Stop()

	req := httptest.NewRequest(http.MethodGet, "/shared?token="+s.token, nil)
	deadline := time.Now().Add(60 * time.Millisecond)
	for time.Now().Before(deadline) {
		rec := httptest.NewRecorder()
		s.handleShared(rec, req)
		time.Sleep(10 * time.Millisecond)
	}

	time.Sleep(150 * time.Millisecond)
	if atomic.LoadInt32(&timedOut) != 1 {
		t.Fatalf("expected the idle timeout to fire despite /shared polling, fired %d times", timedOut)
	}
}

func TestPingResetsIdleTimer(t *testing.T) {
	stubNetworkForTest(t)
	var timedOut int32
	s := New(func(Batch) {})
	s.OnTimeout = func() { atomic.AddInt32(&timedOut, 1) }
	s.IdleTimeout = 80 * time.Millisecond
	if _, err := s.Start(); err != nil {
		t.Fatalf("Start() failed: %v", err)
	}
	defer s.Stop()

	req := httptest.NewRequest(http.MethodPost, "/ping?token="+s.token, nil)
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		rec := httptest.NewRecorder()
		s.handlePing(rec, req)
		time.Sleep(30 * time.Millisecond)
	}
	if atomic.LoadInt32(&timedOut) != 0 {
		t.Fatal("ping should have kept the session alive")
	}
}

func TestLegacyEndpointsStillWork(t *testing.T) {
	received := make(chan Batch, 2)
	s := newHandlerTestServer(func(b Batch) { received <- b })

	rec := httptest.NewRecorder()
	s.handleUpload(rec, uploadRequest(t, s.token, "photo.png", "image/png", []byte("\x89PNG\r\n\x1a\nfake")))
	if rec.Code != http.StatusOK {
		t.Fatalf("/upload: expected 200, got %d", rec.Code)
	}
	select {
	case b := <-received:
		if len(b.Items) != 1 || b.Items[0].Kind != KindImage {
			t.Errorf("/upload should deliver a one-item image batch, got %+v", b)
		}
	case <-time.After(time.Second):
		t.Fatal("/upload never delivered a batch")
	}
}
