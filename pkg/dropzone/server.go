package dropzone

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// DefaultPort is tried first; if it's already in use an OS-assigned
	// ephemeral port is used instead.
	DefaultPort = 8765
	// DefaultIdleTimeout is how long the server waits, from start (and
	// after every authenticated request), before shutting itself down
	// unattended.
	DefaultIdleTimeout = 60 * time.Second
	// maxPingGraceSeconds caps how long one /ping?grace=N may hold the session open.
	maxPingGraceSeconds = 180
	// DefaultMaxBodyBytes caps a single upload request (a photo).
	DefaultMaxBodyBytes int64 = 20 << 20 // 20MB
	// DefaultMaxBatchBodyBytes caps a whole /upload-batch request (several
	// files plus text).
	DefaultMaxBatchBodyBytes int64 = 60 << 20 // 60MB
	// MaxTextBytes caps typed text and text files: both land in the editor
	// as-is, and a multi-megabyte paste would stall it.
	MaxTextBytes int64 = 2 << 20 // 2MB
	// maxBatchImageBytes and maxBatchAudioBytes cap one item within a batch;
	// DefaultMaxBatchBodyBytes still bounds the request as a whole.
	maxBatchImageBytes int64 = 20 << 20 // 20MB
	maxBatchAudioBytes int64 = 25 << 20 // 25MB
	// maxBatchFiles is the most files a single /upload-batch may carry.
	maxBatchFiles = 10
	// maxSharedTextBytes caps the PC -> phone shared-text card.
	maxSharedTextBytes = 64 << 10 // 64KB

	maxMultipartMemory = 4 << 20 // buffered in memory before spilling to a temp file
	readHeaderTimeout  = 10 * time.Second
)

// audioExtensions are filename extensions (lowercase, with the leading dot)
// that identify an audio recording when the sniffed content type is not
// itself informative but the client declared an audio/* type.
var audioExtensions = map[string]bool{
	".webm": true, ".m4a": true, ".mp3": true, ".wav": true, ".ogg": true, ".aac": true,
}

// QREncoder renders url as a PNG image for the Server to hand back from
// Start. It lets this package stay free of the QR-generation dependency;
// see pkg/qrgen for the concrete implementation used by the app.
type QREncoder func(url string) (png []byte, err error)

// Result is returned by Start on success.
type Result struct {
	URL         string // http://<lan-ip>:<port>/?token=... — what the QR code encodes
	QRPNG       []byte // nil if no QREncoder was supplied, or it failed
	QRError     string // non-empty if an Encoder was supplied but failed; URL is still valid
	IdleTimeout time.Duration
}

// Server is a one-shot, ephemeral HTTP receiver for the Mobile Drop
// feature. A single Server handles at most one successful submission: on
// the first valid /upload, /upload-text or /upload-batch, it hands the
// batch to OnBatch and shuts itself down. It also shuts down after
// IdleTimeout with no activity, or when Stop is called explicitly (e.g. the
// user cancels the QR modal).
//
// A Server is single-use: call Start at most once. The zero value is not
// usable; construct with New.
type Server struct {
	// OnBatch is called exactly once, from a background goroutine, when a
	// valid submission is received. It may take a while (a photo is OCR'd
	// there); the server stays up but refuses further submissions.
	OnBatch func(Batch)
	// OnTimeout is called when the server shuts itself down because
	// IdleTimeout elapsed with no successful submission. Not called if
	// Stop() was called explicitly or a submission succeeded first.
	OnTimeout func()
	// IdleTimeout overrides DefaultIdleTimeout when non-zero. Read once at
	// Start.
	IdleTimeout time.Duration
	// MaxBodyBytes overrides DefaultMaxBodyBytes when non-zero. Read once
	// at Start. Applies to the legacy single-item /upload endpoint.
	MaxBodyBytes int64
	// MaxBatchBodyBytes overrides DefaultMaxBatchBodyBytes when non-zero.
	// Read once at Start. Applies to /upload-batch.
	MaxBatchBodyBytes int64
	// Encoder renders the pairing URL as a QR PNG. Optional — if nil,
	// Result.QRPNG is left nil and the caller is expected to show the URL
	// as plain text instead.
	Encoder QREncoder
	// TunnelTimeout overrides DefaultTunnelTimeout when non-zero. Read once
	// when StartTunnel succeeds.
	TunnelTimeout time.Duration
	// TunnelStartTimeout overrides DefaultTunnelStartTimeout when non-zero.
	// Mainly useful for tests.
	TunnelStartTimeout time.Duration

	mu              sync.Mutex
	token           string
	port            int
	srv             *http.Server
	timer           *time.Timer
	currentTimeout  time.Duration // what resetIdleTimer re-arms: IdleTimeout, or the tunnel's once it is up
	tunnelCmd       *exec.Cmd
	tunnelRequested bool
	stopOnce        sync.Once
	stopped         bool
	completed       bool // the single allowed submission has been accepted
	sharedText      string
	sharedRev       int
}

// New returns an unstarted Server. onBatch is required; the other fields on
// the returned Server may be set before calling Start.
func New(onBatch func(Batch)) *Server {
	return &Server{OnBatch: onBatch}
}

// Start picks a free port, generates a one-time token, begins listening on
// all interfaces (0.0.0.0) so a phone on the LAN can reach it, and arms the
// idle timeout. It returns the pairing URL (and QR PNG, if an Encoder was
// set) for the caller to display.
func (s *Server) Start() (*Result, error) {
	if s.OnBatch == nil {
		return nil, errors.New("dropzone: OnBatch is required")
	}

	s.mu.Lock()
	alreadyStarted := s.token != ""
	s.mu.Unlock()
	if alreadyStarted {
		return nil, errors.New("dropzone: server already started")
	}

	token, err := generateToken()
	if err != nil {
		return nil, fmt.Errorf("dropzone: generating token: %w", err)
	}

	ip, err := lanIPDetector()
	if err != nil {
		return nil, fmt.Errorf("dropzone: %w", err)
	}

	ln, err := portListener()
	if err != nil {
		return nil, fmt.Errorf("dropzone: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/upload", s.handleUpload)
	mux.HandleFunc("/upload-text", s.handleUploadText)
	mux.HandleFunc("/upload-batch", s.handleUploadBatch)
	mux.HandleFunc("/shared", s.handleShared)
	mux.HandleFunc("/ping", s.handlePing)
	srv := &http.Server{
		Handler:           withSecurityHeaders(mux),
		ReadHeaderTimeout: readHeaderTimeout,
		MaxHeaderBytes:    64 << 10,
	}

	idleTimeout := s.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = DefaultIdleTimeout
	}

	port := ln.Addr().(*net.TCPAddr).Port

	s.mu.Lock()
	s.token = token
	s.port = port
	s.srv = srv
	s.currentTimeout = idleTimeout
	s.timer = time.AfterFunc(idleTimeout, s.handleTimeout)
	s.mu.Unlock()

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.stopWith(false)
		}
	}()

	pairingURL := fmt.Sprintf("http://%s:%d/?token=%s", ip, port, token)

	result := &Result{URL: pairingURL, IdleTimeout: idleTimeout}
	if s.Encoder != nil {
		png, err := s.Encoder(pairingURL)
		if err != nil {
			result.QRError = err.Error()
		} else {
			result.QRPNG = png
		}
	}
	return result, nil
}

// Stop shuts the server down immediately. Safe to call multiple times and
// safe to call even if Start failed or was never called. It does not
// invoke OnTimeout.
func (s *Server) Stop() {
	s.stopWith(false)
}

func (s *Server) handleTimeout() {
	s.stopWith(true)
}

func (s *Server) stopWith(firedTimeout bool) {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		if s.timer != nil {
			s.timer.Stop()
		}
		srv := s.srv
		s.stopped = true
		submitted := s.completed
		s.mu.Unlock()

		s.killTunnel()

		if srv != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil {
				// A stalled client must not keep the port open past the shutdown grace period.
				_ = srv.Close()
			}
		}

		if firedTimeout && !submitted && s.OnTimeout != nil {
			s.OnTimeout()
		}
	})
}

// resetIdleTimer extends the idle timeout on any authenticated activity
// (opening the page counts, not just submitting), using whatever the current
// timeout is: IdleTimeout normally, or the (longer) tunnel timeout once
// StartTunnel has switched modes.
func (s *Server) resetIdleTimer() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil && !s.stopped && !s.completed {
		s.timer.Reset(s.currentTimeout)
	}
}

// extendIdleTimer re-arms the idle timer for at least d (never less than the normal timeout). The
// phone asks for it right before it hands control to the camera, the file picker or its own voice
// recorder: a page that is in the background cannot ping, so the session would otherwise expire
// while the user is busy recording.
func (s *Server) extendIdleTimer(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer == nil || s.stopped || s.completed {
		return
	}
	if d < s.currentTimeout {
		d = s.currentTimeout
	}
	s.timer.Reset(d)
}

func (s *Server) validToken(got string) bool {
	s.mu.Lock()
	want := s.token
	s.mu.Unlock()
	if got == "" || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// authorized checks the one-time token, which must be in the URL query (the
// page always puts it there). It runs BEFORE any request body is read, so an
// unauthenticated client cannot make the server buffer an upload.
func (s *Server) authorized(r *http.Request) bool {
	return s.validToken(r.URL.Query().Get("token"))
}

func (s *Server) maxBodyBytes() int64 {
	if s.MaxBodyBytes > 0 {
		return s.MaxBodyBytes
	}
	return DefaultMaxBodyBytes
}

func (s *Server) maxBatchBodyBytes() int64 {
	if s.MaxBatchBodyBytes > 0 {
		return s.MaxBatchBodyBytes
	}
	return DefaultMaxBatchBodyBytes
}

// maxTextBodyBytes is the request cap for typed text: MaxTextBytes plus room
// for the form encoding (percent-escaping can triple the size of non-ASCII).
func (s *Server) maxTextBodyBytes() int64 {
	limit := MaxTextBytes*3 + 4096
	if body := s.maxBodyBytes(); body < limit {
		return body
	}
	return limit
}

// claim takes the single allowed submission. It reports false if one was
// already accepted or the server has been stopped, so two phones (or two
// taps) racing each other cannot both be delivered.
func (s *Server) claim() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.completed || s.stopped {
		return false
	}
	s.completed = true
	if s.timer != nil {
		s.timer.Stop() // OnComplete may take a while; the idle timeout must not fire meanwhile
	}
	return true
}

// complete is called by a handler after a valid submission. It responds to
// the phone, then asynchronously invokes OnBatch and shuts the server down
// (asynchronously, so the HTTP response for this very request is not
// blocked on server teardown).
func (s *Server) complete(w http.ResponseWriter, batch Batch) {
	if !s.claim() {
		http.Error(w, "already used", http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))

	go func() {
		if s.OnBatch != nil {
			s.OnBatch(batch)
		}
		s.Stop()
	}()
}

// SetSharedText updates the text shown on the phone's "text from PC" card
// (a selection or clipboard snapshot pushed down from the desktop), capped
// at maxSharedTextBytes without splitting a multi-byte rune. Each call bumps
// the revision /shared reports, so the phone only re-renders on change.
func (s *Server) SetSharedText(text string) {
	if len(text) > maxSharedTextBytes {
		text = capUTF8(text, maxSharedTextBytes)
	}
	s.mu.Lock()
	s.sharedText = text
	s.sharedRev++
	s.mu.Unlock()
}

// capUTF8 truncates s to at most max bytes without cutting a rune in half.
func capUTF8(s string, max int) string {
	var b strings.Builder
	for _, r := range s {
		if b.Len()+utf8.RuneLen(r) > max {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

// withSecurityHeaders applies the headers every response should carry. The
// pairing token lives in the URL, so referrers are suppressed and nothing is
// cached.
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.resetIdleTimer()

	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	page, err := renderPage(token)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(page))
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.resetIdleTimer()

	r.Body = http.MaxBytesReader(w, r.Body, s.maxBodyBytes())
	if err := r.ParseMultipartForm(maxMultipartMemory); err != nil {
		if isMaxBytesError(err) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad request", http.StatusBadRequest)
		}
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		if isMaxBytesError(err) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "failed reading upload", http.StatusBadRequest)
		}
		return
	}

	kind, mimeType := classifyUpload(header.Header.Get("Content-Type"), header.Filename, data)
	if kind == KindFile {
		// Non-image, non-audio files are pasted into the note as text.
		if int64(len(data)) > MaxTextBytes {
			http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
			return
		}
		if bytes.IndexByte(data, 0) >= 0 {
			http.Error(w, "unsupported file (text files only)", http.StatusUnsupportedMediaType)
			return
		}
	}

	s.complete(w, Batch{Items: []Payload{{
		Kind:     kind,
		Filename: header.Filename,
		MimeType: mimeType,
		Data:     data,
	}}})
}

func (s *Server) handleUploadText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.resetIdleTimer()

	r.Body = http.MaxBytesReader(w, r.Body, s.maxTextBodyBytes())
	if err := r.ParseForm(); err != nil {
		if isMaxBytesError(err) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad request", http.StatusBadRequest)
		}
		return
	}

	text := r.PostFormValue("text")
	if strings.TrimSpace(text) == "" {
		http.Error(w, "empty text", http.StatusBadRequest)
		return
	}
	if int64(len(text)) > MaxTextBytes {
		http.Error(w, "text too large", http.StatusRequestEntityTooLarge)
		return
	}

	kind := KindText
	if IsBareURL(text) {
		kind = KindURL
	}

	s.complete(w, Batch{Items: []Payload{{Kind: kind, Text: text}}})
}

// handleUploadBatch accepts the phone's unified "send all" submission: any
// number of files (repeated "file" parts) plus an optional "text" field,
// delivered to OnBatch as a single Batch so the app makes one note
// insertion for the whole tray.
func (s *Server) handleUploadBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.resetIdleTimer()

	r.Body = http.MaxBytesReader(w, r.Body, s.maxBatchBodyBytes())
	if err := r.ParseMultipartForm(maxMultipartMemory); err != nil {
		if isMaxBytesError(err) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "bad request", http.StatusBadRequest)
		}
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	fileHeaders := r.MultipartForm.File["file"]
	if len(fileHeaders) > maxBatchFiles {
		http.Error(w, "too many files", http.StatusBadRequest)
		return
	}

	items := make([]Payload, 0, len(fileHeaders)+1)
	for _, fh := range fileHeaders {
		item, status, err := readBatchFile(fh)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		items = append(items, item)
	}

	if text := strings.TrimSpace(r.FormValue("text")); text != "" {
		if int64(len(text)) > MaxTextBytes {
			http.Error(w, "text too large", http.StatusRequestEntityTooLarge)
			return
		}
		kind := KindText
		if IsBareURL(text) {
			kind = KindURL
		}
		items = append(items, Payload{Kind: kind, Text: text})
	}

	if len(items) == 0 {
		http.Error(w, "empty batch", http.StatusBadRequest)
		return
	}

	s.complete(w, Batch{Items: items, Geo: parseGeo(r.Header)})
}

// readBatchFile reads and classifies one "file" part of a batch, enforcing
// the per-kind size caps (images, audio, text files each have their own).
func readBatchFile(fh *multipart.FileHeader) (Payload, int, error) {
	f, err := fh.Open()
	if err != nil {
		return Payload{}, http.StatusBadRequest, errors.New("bad request")
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		if isMaxBytesError(err) {
			return Payload{}, http.StatusRequestEntityTooLarge, errors.New("payload too large")
		}
		return Payload{}, http.StatusBadRequest, errors.New("failed reading upload")
	}

	kind, mimeType := classifyUpload(fh.Header.Get("Content-Type"), fh.Filename, data)
	switch kind {
	case KindImage:
		if int64(len(data)) > maxBatchImageBytes {
			return Payload{}, http.StatusRequestEntityTooLarge, errors.New("image too large")
		}
	case KindAudio:
		if int64(len(data)) > maxBatchAudioBytes {
			return Payload{}, http.StatusRequestEntityTooLarge, errors.New("audio too large")
		}
	case KindFile:
		if int64(len(data)) > MaxTextBytes {
			return Payload{}, http.StatusRequestEntityTooLarge, errors.New("file too large")
		}
		if bytes.IndexByte(data, 0) >= 0 {
			return Payload{}, http.StatusUnsupportedMediaType, errors.New("unsupported file (text files only)")
		}
	}

	return Payload{Kind: kind, Filename: fh.Filename, MimeType: mimeType, Data: data}, http.StatusOK, nil
}

// handleShared serves the PC -> phone shared-text card. It deliberately
// does NOT reset the idle timer: the phone polls this every couple of
// seconds while composing a batch, and that alone must not keep an
// abandoned session alive forever.
func (s *Server) handleShared(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	s.mu.Lock()
	text, rev := s.sharedText, s.sharedRev
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(struct {
		Text string `json:"text"`
		Rev  int    `json:"rev"`
	}{Text: text, Rev: rev})
}

// handlePing is the phone's "I'm still composing a batch" heartbeat: unlike
// /shared, it does reset the idle timer, so building a multi-item tray does
// not expire the session out from under the user.
func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if grace, err := strconv.Atoi(r.URL.Query().Get("grace")); err == nil && grace > 0 {
		if grace > maxPingGraceSeconds {
			grace = maxPingGraceSeconds
		}
		s.extendIdleTimer(time.Duration(grace) * time.Second)
	} else {
		s.resetIdleTimer()
	}
	w.WriteHeader(http.StatusNoContent)
}

// parseGeo reads the phone's one-shot location from X-Geo-Lat/X-Geo-Lon,
// accepting only finite values in range; anything else (missing, malformed,
// NaN/Inf, out of range) yields a nil Geo rather than an error, since
// location is a non-essential enhancement.
func parseGeo(h http.Header) *Geo {
	latStr, lonStr := h.Get("X-Geo-Lat"), h.Get("X-Geo-Lon")
	if latStr == "" || lonStr == "" {
		return nil
	}
	lat, err := strconv.ParseFloat(latStr, 64)
	if err != nil || !isFiniteInRange(lat, -90, 90) {
		return nil
	}
	lon, err := strconv.ParseFloat(lonStr, 64)
	if err != nil || !isFiniteInRange(lon, -180, 180) {
		return nil
	}
	return &Geo{Lat: lat, Lon: lon}
}

func isFiniteInRange(v, lo, hi float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= lo && v <= hi
}

// classifyUpload decides what an uploaded file is. The bytes decide, not the
// client-declared type: a phone may label anything image/*. HEIC/HEIF is one
// exception, since net/http cannot sniff it but vision models accept it;
// audio declared with a recognizable extension is the other, since some
// mobile browsers sniff a voice recording's webm/ogg container as video or
// generic binary.
func classifyUpload(declaredType, filename string, data []byte) (Kind, string) {
	sniffed := http.DetectContentType(data)
	switch {
	case strings.HasPrefix(sniffed, "image/"):
		return KindImage, sniffed
	case strings.HasPrefix(sniffed, "audio/"), sniffed == "video/webm", sniffed == "application/ogg":
		return KindAudio, sniffed
	}
	declared := strings.ToLower(strings.TrimSpace(strings.SplitN(declaredType, ";", 2)[0]))
	switch declared {
	case "image/heic", "image/heif":
		return KindImage, declared
	}
	if strings.HasPrefix(declared, "audio/") && audioExtensions[strings.ToLower(extOf(filename))] {
		return KindAudio, declared
	}
	return KindFile, sniffed
}

func isMaxBytesError(err error) bool {
	if err == nil {
		return false
	}
	var mbErr *http.MaxBytesError
	if errors.As(err, &mbErr) {
		return true
	}
	// Older stdlib versions / re-wrapped errors surface this as a plain
	// string; keep the substring check as a fallback.
	return strings.Contains(err.Error(), "http: request body too large")
}

func generateToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// lanIPDetector and portListener are package-level indirections (rather than
// direct calls to detectLANIP/listen) purely so tests can stub host network
// behavior without depending on the actual machine's interfaces or binding
// the real default port. routeLocalIP is the seam for the routing lookup.
var (
	lanIPDetector = detectLANIP
	portListener  = listen
	routeLocalIP  = defaultRouteIP
)

func listen() (net.Listener, error) {
	if ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", DefaultPort)); err == nil {
		return ln, nil
	}
	return net.Listen("tcp", "0.0.0.0:0")
}

// defaultRouteIP returns the local address the OS would use to reach an
// outside host, i.e. the interface that carries the LAN traffic. A UDP
// "connect" only performs the route lookup; no packet is sent, and
// 192.0.2.1 (TEST-NET-1) is never a real host.
func defaultRouteIP() (net.IP, error) {
	conn, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil, errors.New("unexpected local address type")
	}
	return addr.IP, nil
}

// detectLANIP returns the private (RFC 1918) IPv4 address a phone on the same
// Wi-Fi/LAN should use to reach this machine. The interface carrying the
// default route wins: on a developer machine WSL/Docker/Hyper-V/VPN adapters
// also own private addresses, and a phone cannot reach those.
func detectLANIP() (string, error) {
	if ip, err := routeLocalIP(); err == nil {
		if ip4 := ip.To4(); ip4 != nil && isPrivateIPv4(ip4) {
			return ip4.String(), nil
		}
	}
	return scanLANIP()
}

// scanLANIP is the fallback when there is no usable default route (e.g. a
// LAN-only network): the first private IPv4 address on an up, non-loopback
// interface, preferring real adapters over virtual ones.
func scanLANIP() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("listing network interfaces: %w", err)
	}
	virtualIP := ""
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || !isPrivateIPv4(ip4) {
				continue
			}
			if isVirtualInterface(ifc.Name) {
				if virtualIP == "" {
					virtualIP = ip4.String()
				}
				continue
			}
			return ip4.String(), nil
		}
	}
	if virtualIP != "" {
		return virtualIP, nil
	}
	return "", errors.New("no LAN-reachable network interface found (are you connected to Wi-Fi/Ethernet?)")
}

// virtualInterfaceHints are substrings (lowercase) of interface names that
// belong to VMs, containers and overlay networks rather than the LAN.
var virtualInterfaceHints = []string{
	"vethernet", "virtual", "vmware", "vbox", "docker", "wsl", "hyper-v",
	"tailscale", "zerotier", "veth", "br-", "utun",
}

func isVirtualInterface(name string) bool {
	n := strings.ToLower(name)
	for _, hint := range virtualInterfaceHints {
		if strings.Contains(n, hint) {
			return true
		}
	}
	return false
}

// isPrivateIPv4 reports whether ip is a routable, RFC 1918 private address
// (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16). It excludes loopback and
// link-local (169.254.0.0/16) ranges, which are not reachable from another
// device on the LAN.
func isPrivateIPv4(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		switch {
		case ip4[0] == 10:
			return true
		case ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31:
			return true
		case ip4[0] == 192 && ip4[1] == 168:
			return true
		}
	}
	return false
}
