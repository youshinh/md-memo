package components

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func payload(n int) []byte {
	b := make([]byte, n)
	x := uint32(12345)
	for i := range b {
		x = x*1664525 + 1013904223
		b[i] = byte(x >> 24)
	}
	return b
}

func sum256(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

type recServer struct {
	*httptest.Server
	mu     sync.Mutex
	ranges []string
	agents []string
}

func newServer(t *testing.T, h http.HandlerFunc) *recServer {
	t.Helper()
	s := &recServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.ranges = append(s.ranges, r.Header.Get("Range"))
		s.agents = append(s.agents, r.Header.Get("User-Agent"))
		s.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *recServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.ranges)
}

func (s *recServer) rangeHeaders() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.ranges)
}

func serveBytes(content []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "f.bin", time.Time{}, bytes.NewReader(content))
	}
}

func newEnv(t *testing.T) (*Manager, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "parts")
	return NewManager(root), root
}

func filePart(id, url string, content []byte) Part {
	return Part{ID: id, Kind: "model", URL: url, SHA256: sum256(content), Size: int64(len(content)), Entry: "model.bin"}
}

type zentry struct {
	name string
	data []byte
	mode os.FileMode
}

func makeZip(t *testing.T, entries []zentry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		var w interface{ Write([]byte) (int, error) }
		var err error
		if e.mode != 0 {
			hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
			hdr.SetMode(e.mode)
			w, err = zw.CreateHeader(hdr)
		} else {
			w, err = zw.Create(e.name)
		}
		if err != nil {
			t.Fatalf("zip create %q: %v", e.name, err)
		}
		if _, err := w.Write(e.data); err != nil {
			t.Fatalf("zip write %q: %v", e.name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipPart(id, url string, archive []byte, entry string, extract ...string) Part {
	return Part{ID: id, Kind: "runtime", URL: url, SHA256: sum256(archive), Size: int64(len(archive)), Archive: "zip", Extract: extract, Entry: entry}
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("%s should not exist (stat err = %v)", path, err)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type progressLog struct{ calls [][2]int64 }

func (l *progressLog) fn(done, total int64) { l.calls = append(l.calls, [2]int64{done, total}) }

func (l *progressLog) check(t *testing.T, first, total int64) {
	t.Helper()
	if len(l.calls) < 2 {
		t.Fatalf("progress called %d times, want at least 2", len(l.calls))
	}
	if l.calls[0][0] != first {
		t.Errorf("first progress done = %d, want %d", l.calls[0][0], first)
	}
	last := l.calls[len(l.calls)-1]
	if last != [2]int64{total, total} {
		t.Errorf("last progress = %v, want [%d %d]", last, total, total)
	}
	for i, c := range l.calls {
		if i > 0 && c[0] < l.calls[i-1][0] {
			t.Errorf("progress went backwards: %v after %v", c, l.calls[i-1])
		}
		if c[0] > total {
			t.Errorf("progress done %d exceeds total %d", c[0], total)
		}
	}
}

func TestInstallSingleFile(t *testing.T) {
	content := payload(3<<20 + 123)
	srv := newServer(t, serveBytes(content))
	p := filePart("whisper-base", srv.URL+"/m.bin", content)
	m, root := newEnv(t)
	assertMissing(t, root)

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatal(err)
	}

	entry, ok := m.Path(p)
	if !ok {
		t.Fatal("Path reports not installed")
	}
	if want := filepath.Join(m.Dir(p.ID), "model.bin"); entry != want || !filepath.IsAbs(entry) {
		t.Errorf("entry = %q, want absolute %q", entry, want)
	}
	if !bytes.Equal(mustRead(t, entry), content) {
		t.Error("installed bytes differ from served bytes")
	}
	st := m.Status(p)
	if !st.Installed || st.ID != p.ID || st.Path != entry || st.Size != int64(len(content)) {
		t.Errorf("status = %+v", st)
	}
	if got := names(t, root); !slices.Equal(got, []string{"whisper-base"}) {
		t.Errorf("root contains %v, want only the part dir", got)
	}
	if got := names(t, m.Dir(p.ID)); !slices.Equal(got, []string{".installed.json", "model.bin"}) {
		t.Errorf("part dir contains %v", got)
	}

	var mk marker
	if err := json.Unmarshal(mustRead(t, filepath.Join(m.Dir(p.ID), ".installed.json")), &mk); err != nil {
		t.Fatal(err)
	}
	if mk.ID != p.ID || mk.SHA256 != sum256(content) || mk.Size != int64(len(content)) || mk.URL != p.URL {
		t.Errorf("marker = %+v", mk)
	}
	if _, err := time.Parse(time.RFC3339, mk.InstalledAt); err != nil {
		t.Errorf("installedAt %q is not RFC3339: %v", mk.InstalledAt, err)
	}

	log.check(t, 0, int64(len(content)))
	for _, c := range log.calls {
		if c[1] != int64(len(content)) {
			t.Errorf("progress total = %d, want %d", c[1], len(content))
		}
	}
	if srv.agents[0] != "md-memo" {
		t.Errorf("User-Agent = %q", srv.agents[0])
	}
}

func TestInstallUnverifiedPartAndUnknownLength(t *testing.T) {
	content := payload(64 << 10)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write(content[:len(content)/2])
		w.(http.Flusher).Flush() // no Content-Length: chunked
		w.Write(content[len(content)/2:])
	})
	m, _ := newEnv(t)
	p := Part{ID: "user-model", URL: srv.URL + "/x", Entry: "x.bin"}

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatal(err)
	}
	log.check(t, 0, int64(len(content)))
	if log.calls[0][1] != 0 {
		t.Errorf("total before the end = %d, want 0 (unknown)", log.calls[0][1])
	}
	entry, ok := m.Path(p)
	if !ok || !bytes.Equal(mustRead(t, entry), content) {
		t.Fatal("part not installed correctly")
	}
	var mk marker
	if err := json.Unmarshal(mustRead(t, filepath.Join(m.Dir(p.ID), ".installed.json")), &mk); err != nil {
		t.Fatal(err)
	}
	if mk.SHA256 != sum256(content) {
		t.Errorf("marker sha = %q, want the computed digest", mk.SHA256)
	}
}

func TestInstallNilProgress(t *testing.T) {
	content := payload(1000)
	srv := newServer(t, serveBytes(content))
	m, _ := newEnv(t)
	if err := m.Install(context.Background(), filePart("m", srv.URL, content), nil); err != nil {
		t.Fatal(err)
	}
}

func TestInstallChecksumMismatch(t *testing.T) {
	content := payload(10000)
	srv := newServer(t, serveBytes(content))
	m, root := newEnv(t)
	p := filePart("m", srv.URL, content)
	p.SHA256 = sum256([]byte("something else"))

	err := m.Install(context.Background(), p, nil)
	if !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("err = %v, want ErrChecksumMismatch", err)
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v, want nothing left behind", got)
	}
	if _, ok := m.Path(p); ok {
		t.Error("part reported installed")
	}
}

func TestInstallSizeMismatch(t *testing.T) {
	content := payload(10000)
	srv := newServer(t, serveBytes(content))
	for _, size := range []int64{int64(len(content)) + 1, int64(len(content)) - 1} {
		m, root := newEnv(t)
		p := filePart("m", srv.URL, content)
		p.Size = size
		err := m.Install(context.Background(), p, nil)
		if err == nil || errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("size %d: err = %v, want a size error", size, err)
		}
		if !strings.Contains(err.Error(), strconv.Itoa(len(content))) {
			t.Errorf("error %q does not mention the actual size", err)
		}
		if got := names(t, root); len(got) != 0 {
			t.Errorf("root contains %v", got)
		}
		if _, ok := m.Path(p); ok {
			t.Error("part reported installed")
		}
	}
}

func TestInstallEmptyDownload(t *testing.T) {
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {})
	m, root := newEnv(t)
	if err := m.Install(context.Background(), Part{ID: "m", URL: srv.URL, Entry: "m.bin"}, nil); err == nil {
		t.Fatal("empty download accepted")
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v", got)
	}
}

func TestInstallHTTPErrors(t *testing.T) {
	for _, code := range []int{http.StatusNotFound, http.StatusInternalServerError, http.StatusForbidden} {
		srv := newServer(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", code) })
		m, root := newEnv(t)
		err := m.Install(context.Background(), Part{ID: "m", URL: srv.URL, Entry: "m.bin"}, nil)
		if err == nil || !strings.Contains(err.Error(), strconv.Itoa(code)) {
			t.Fatalf("status %d: err = %v, want an error naming the status", code, err)
		}
		if got := names(t, root); len(got) != 0 {
			t.Errorf("status %d: root contains %v", code, got)
		}
	}
}

func TestCheckURL(t *testing.T) {
	cases := map[string]bool{
		"https://example.com/m.bin":       true,
		"HTTPS://example.com/m.bin":       true,
		"http://localhost:8080/m.bin":     true,
		"http://127.0.0.1:1234/m.bin":     true,
		"http://[::1]:1234/m.bin":         true,
		"http://example.com/m.bin":        false,
		"http://localhost.example.com/x":  false,
		"http://127.0.0.2/x":              false,
		"ftp://example.com/x":             false,
		"file:///etc/passwd":              false,
		"//example.com/x":                 false,
		"":                                false,
		"https:///nohost":                 false,
		"http://user@example.com:80/m.b":  false,
		"http://example.com@localhost/x":  true,
		"http://localhost@example.com/xy": false,
	}
	for raw, ok := range cases {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		err = checkURL(u)
		if ok && err != nil {
			t.Errorf("%q rejected: %v", raw, err)
		}
		if !ok && !errors.Is(err, ErrInsecureURL) {
			t.Errorf("%q: err = %v, want ErrInsecureURL", raw, err)
		}
	}
}

func TestInstallRejectsInsecureURL(t *testing.T) {
	m, root := newEnv(t)
	for _, raw := range []string{"http://example.com/m.bin", "ftp://example.com/m.bin", "", "file:///tmp/m.bin"} {
		err := m.Install(context.Background(), Part{ID: "m", URL: raw, Entry: "m.bin"}, nil)
		if !errors.Is(err, ErrInsecureURL) {
			t.Errorf("%q: err = %v, want ErrInsecureURL", raw, err)
		}
	}
	assertMissing(t, root)
}

func TestInstallRejectsRedirectToInsecureURL(t *testing.T) {
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.invalid/m.bin", http.StatusFound)
	})
	m, root := newEnv(t)
	err := m.Install(context.Background(), Part{ID: "m", URL: srv.URL, Entry: "m.bin"}, nil)
	if !errors.Is(err, ErrInsecureURL) {
		t.Fatalf("err = %v, want ErrInsecureURL", err)
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v", got)
	}
}

func TestInstallFollowsSafeRedirect(t *testing.T) {
	content := payload(5000)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redir" {
			http.Redirect(w, r, "/m.bin", http.StatusFound)
			return
		}
		serveBytes(content)(w, r)
	})
	m, _ := newEnv(t)
	p := filePart("m", srv.URL+"/redir", content)
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Path(p); !ok {
		t.Fatal("not installed")
	}
}

func TestInstallUnsupportedPlatform(t *testing.T) {
	content := payload(1000)
	srv := newServer(t, serveBytes(content))
	m, root := newEnv(t)
	p := filePart("m", srv.URL, content)

	p.Platform = "plan9/mips"
	if err := m.Install(context.Background(), p, nil); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("err = %v, want ErrUnsupportedPlatform", err)
	}
	if srv.count() != 0 {
		t.Error("request was made for an unsupported platform")
	}
	assertMissing(t, root)

	p.Platform = runtime.GOOS + "/" + runtime.GOARCH
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatalf("matching platform: %v", err)
	}
}

func TestInstallCancelledBeforeStart(t *testing.T) {
	srv := newServer(t, serveBytes(payload(1000)))
	m, root := newEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := m.Install(ctx, Part{ID: "m", URL: srv.URL, Entry: "m.bin"}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if srv.count() != 0 {
		t.Error("request was made with a cancelled context")
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v", got)
	}
}

func TestInstallResumesAfterCancel(t *testing.T) {
	content := payload(2 << 20)
	half := len(content) / 2
	release := make(chan struct{})
	var stall atomic.Bool
	stall.Store(true)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") == "" && stall.CompareAndSwap(true, false) {
			w.Header().Set("Content-Length", strconv.Itoa(len(content)))
			w.WriteHeader(http.StatusOK)
			w.Write(content[:half])
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return
		}
		serveBytes(content)(w, r)
	})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	m, root := newEnv(t)
	p := filePart("whisper-small", srv.URL+"/m.bin", content)
	part := filepath.Join(root, "whisper-small.part")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errc := make(chan error, 1)
	go func() { errc <- m.Install(ctx, p, nil) }()
	waitFor(t, "half of the file on disk", func() bool {
		fi, err := os.Stat(part)
		return err == nil && fi.Size() >= int64(half)
	})
	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("first attempt err = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("first attempt did not return after cancel")
	}
	if got := mustRead(t, part); !bytes.Equal(got, content[:half]) {
		t.Fatalf("partial file has %d bytes, want the first %d", len(got), half)
	}
	if _, ok := m.Path(p); ok {
		t.Fatal("cancelled install reported as installed")
	}

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatalf("second attempt: %v", err)
	}
	if got := srv.rangeHeaders(); len(got) != 2 || got[0] != "" || got[1] != "bytes="+strconv.Itoa(half)+"-" {
		t.Errorf("Range headers = %q", got)
	}
	log.check(t, int64(half), int64(len(content)))
	entry, ok := m.Path(p)
	if !ok || !bytes.Equal(mustRead(t, entry), content) {
		t.Fatal("resumed file is not byte-identical")
	}
	assertMissing(t, part)
}

func TestInstallRestartsWhenServerIgnoresRange(t *testing.T) {
	content := payload(200 << 10)
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Write(content)
	})
	m, root := newEnv(t)
	p := filePart("m", srv.URL, content)
	mustWrite(t, filepath.Join(root, "m.part"), bytes.Repeat([]byte{0xFF}, 500))

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatal(err)
	}
	if got := srv.rangeHeaders(); len(got) != 1 || got[0] != "bytes=500-" {
		t.Errorf("Range headers = %q, want a single resume attempt", got)
	}
	log.check(t, 0, int64(len(content)))
	entry, _ := m.Path(p)
	if !bytes.Equal(mustRead(t, entry), content) {
		t.Fatal("garbage prefix survived the restart")
	}
}

func TestInstallCompletePartialFile(t *testing.T) {
	content := payload(100 << 10)

	t.Run("correct", func(t *testing.T) {
		srv := newServer(t, serveBytes(content))
		m, root := newEnv(t)
		p := filePart("m", srv.URL, content)
		mustWrite(t, filepath.Join(root, "m.part"), content)
		var log progressLog
		if err := m.Install(context.Background(), p, log.fn); err != nil {
			t.Fatal(err)
		}
		if got := srv.rangeHeaders(); len(got) != 1 || got[0] != "bytes="+strconv.Itoa(len(content))+"-" {
			t.Errorf("Range headers = %q", got)
		}
		log.check(t, int64(len(content)), int64(len(content)))
		entry, ok := m.Path(p)
		if !ok || !bytes.Equal(mustRead(t, entry), content) {
			t.Fatal("not installed from the complete partial file")
		}
	})

	t.Run("corrupt", func(t *testing.T) {
		srv := newServer(t, serveBytes(content))
		m, root := newEnv(t)
		bad := slices.Clone(content)
		bad[len(bad)/2] ^= 0xFF
		mustWrite(t, filepath.Join(root, "m.part"), bad)
		err := m.Install(context.Background(), filePart("m", srv.URL, content), nil)
		if !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("err = %v, want ErrChecksumMismatch", err)
		}
		if got := names(t, root); len(got) != 0 {
			t.Errorf("root contains %v", got)
		}
	})

	t.Run("longer than the server file", func(t *testing.T) {
		srv := newServer(t, serveBytes(content))
		m, root := newEnv(t)
		mustWrite(t, filepath.Join(root, "m.part"), append(slices.Clone(content), make([]byte, 1000)...))
		err := m.Install(context.Background(), Part{ID: "m", URL: srv.URL, Entry: "m.bin"}, nil)
		if err == nil {
			t.Fatal("stale partial file accepted")
		}
		if got := names(t, root); len(got) != 0 {
			t.Errorf("root contains %v", got)
		}
	})
}

func TestInstallDiscardsOversizedPartial(t *testing.T) {
	content := payload(50 << 10)
	srv := newServer(t, serveBytes(content))
	m, root := newEnv(t)
	p := filePart("m", srv.URL, content)
	mustWrite(t, filepath.Join(root, "m.part"), payload(len(content)+4000))
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if got := srv.rangeHeaders(); len(got) != 1 || got[0] != "" {
		t.Errorf("Range headers = %q, want a fresh full download", got)
	}
	entry, _ := m.Path(p)
	if !bytes.Equal(mustRead(t, entry), content) {
		t.Fatal("wrong content")
	}
}

func TestInstallZipExtracts(t *testing.T) {
	cli := payload(3000)
	archive := makeZip(t, []zentry{
		{name: "Release/", data: nil},
		{name: "Release/whisper-cli.exe", data: cli},
		{name: "Release/GGML.DLL", data: []byte("ggml upper")},
		{name: "Release/ggml-cpu.dll", data: []byte("ggml cpu")},
		{name: "Release/sub/ggml-extra.dll", data: []byte("ggml extra")},
		{name: "Release/README.txt", data: []byte("skipped")},
		{name: "Release/other.dll", data: []byte("skipped too")},
	})
	srv := newServer(t, serveBytes(archive))
	m, root := newEnv(t)
	p := zipPart("whisper-runtime", srv.URL+"/rt.zip", archive, "whisper-cli.exe", "WHISPER-CLI.EXE", "GGML*.dll")

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatal(err)
	}
	log.check(t, 0, int64(len(archive)))

	dir := m.Dir(p.ID)
	want := []string{".installed.json", "GGML.DLL", "ggml-cpu.dll", "ggml-extra.dll", "whisper-cli.exe"}
	if got := names(t, dir); !slices.Equal(got, want) {
		t.Fatalf("part dir = %v, want %v", got, want)
	}
	entry, ok := m.Path(p)
	if !ok || !bytes.Equal(mustRead(t, entry), cli) {
		t.Fatal("entry missing or wrong")
	}
	if got := mustRead(t, filepath.Join(dir, "ggml-extra.dll")); string(got) != "ggml extra" {
		t.Errorf("flattened file = %q", got)
	}
	st := m.Status(p)
	wantSize := int64(len(cli) + len("ggml upper") + len("ggml cpu") + len("ggml extra"))
	if !st.Installed || st.Size != wantSize {
		t.Errorf("status = %+v, want size %d", st, wantSize)
	}
	if got := names(t, root); !slices.Equal(got, []string{"whisper-runtime"}) {
		t.Errorf("root contains %v, want the archive and temp dirs cleaned up", got)
	}
	var mk marker
	if err := json.Unmarshal(mustRead(t, filepath.Join(dir, ".installed.json")), &mk); err != nil {
		t.Fatal(err)
	}
	if mk.SHA256 != sum256(archive) || mk.Size != int64(len(archive)) {
		t.Errorf("marker = %+v, want the archive's digest and size", mk)
	}
}

func TestInstallZipWithoutExtractKeepsEverything(t *testing.T) {
	archive := makeZip(t, []zentry{
		{name: "a/one.txt", data: []byte("1")},
		{name: "b/two.bin", data: []byte("22")},
		{name: "b/", data: nil},
		{name: "c/one.txt", data: []byte("duplicate name")},
	})
	srv := newServer(t, serveBytes(archive))
	m, _ := newEnv(t)
	p := zipPart("z", srv.URL, archive, "one.txt")
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if got := names(t, m.Dir("z")); !slices.Equal(got, []string{".installed.json", "one.txt", "two.bin"}) {
		t.Fatalf("part dir = %v", got)
	}
	if got := mustRead(t, filepath.Join(m.Dir("z"), "one.txt")); string(got) != "1" {
		t.Errorf("one.txt = %q, want the first entry to win", got)
	}
}

func TestInstallZipEntryMissing(t *testing.T) {
	archive := makeZip(t, []zentry{
		{name: "bin/ggml.dll", data: []byte("x")},
		{name: "bin/whisper-cli.exe", data: []byte("y")},
	})
	srv := newServer(t, serveBytes(archive))
	m, root := newEnv(t)
	p := zipPart("rt", srv.URL, archive, "whisper-cli.exe", "ggml*.dll")

	err := m.Install(context.Background(), p, nil)
	if err == nil || !strings.Contains(err.Error(), "whisper-cli.exe") {
		t.Fatalf("err = %v, want an error naming the missing entry", err)
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v, want nothing left behind", got)
	}
	if _, ok := m.Path(p); ok {
		t.Error("part reported installed")
	}
}

func TestInstallZipSlipNamesStayInsideDir(t *testing.T) {
	archive := makeZip(t, []zentry{
		{name: "ok.exe", data: []byte("ok")},
		{name: "../evil.dll", data: []byte("1")},
		{name: "/abs.dll", data: []byte("2")},
		{name: "a/../../b.dll", data: []byte("3")},
		{name: `..\win.dll`, data: []byte("4")},
		{name: `C:\Windows\drive.dll`, data: []byte("5")},
		{name: "C:stream.dll", data: []byte("6")},
		{name: "x/..", data: []byte("7")},
		{name: ".", data: []byte("8")},
	})
	srv := newServer(t, serveBytes(archive))
	m, root := newEnv(t)
	p := zipPart("slip", srv.URL, archive, "ok.exe")

	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if got := names(t, filepath.Dir(root)); !slices.Equal(got, []string{"parts"}) {
		t.Errorf("temp base contains %v, want only the root", got)
	}
	if got := names(t, root); !slices.Equal(got, []string{"slip"}) {
		t.Errorf("root contains %v, want only the part dir", got)
	}
	want := []string{".installed.json", "abs.dll", "b.dll", "drive.dll", "evil.dll", "ok.exe", "win.dll"}
	if got := names(t, m.Dir("slip")); !slices.Equal(got, want) {
		t.Errorf("part dir = %v, want %v", got, want)
	}
}

func TestInstallZipExtractCap(t *testing.T) {
	old := maxExtractBytes
	maxExtractBytes = 100
	t.Cleanup(func() { maxExtractBytes = old })

	archive := makeZip(t, []zentry{
		{name: "small.exe", data: []byte("tiny")},
		{name: "big.bin", data: bytes.Repeat([]byte("A"), 5000)},
	})
	srv := newServer(t, serveBytes(archive))
	m, root := newEnv(t)
	err := m.Install(context.Background(), zipPart("bomb", srv.URL, archive, "small.exe"), nil)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("err = %v, want a too-large error", err)
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v", got)
	}
}

func TestInstallZipCorruptArchiveIsDiscarded(t *testing.T) {
	srv := newServer(t, serveBytes(payload(5000)))
	m, root := newEnv(t)
	err := m.Install(context.Background(), Part{ID: "z", URL: srv.URL, Archive: "zip", Entry: "a.exe"}, nil)
	if err == nil {
		t.Fatal("a non-zip archive was accepted")
	}
	if got := names(t, root); len(got) != 0 {
		t.Errorf("root contains %v, want the bad archive removed", got)
	}
}

func TestInstallZipKeepsExecutableBit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no exec bit on Windows")
	}
	archive := makeZip(t, []zentry{
		{name: "bin/helper", data: []byte("#!/bin/sh"), mode: 0o755},
		{name: "bin/tool.exe", data: []byte("x"), mode: 0o644},
		{name: "bin/data.txt", data: []byte("d"), mode: 0o644},
	})
	srv := newServer(t, serveBytes(archive))
	m, _ := newEnv(t)
	if err := m.Install(context.Background(), zipPart("x", srv.URL, archive, "helper"), nil); err != nil {
		t.Fatal(err)
	}
	for name, exec := range map[string]bool{"helper": true, "tool.exe": true, "data.txt": false} {
		fi, err := os.Stat(filepath.Join(m.Dir("x"), name))
		if err != nil {
			t.Fatal(err)
		}
		if got := fi.Mode().Perm()&0o111 != 0; got != exec {
			t.Errorf("%s: executable = %v, want %v (mode %v)", name, got, exec, fi.Mode())
		}
	}
}

func TestInstallTwiceIsNoop(t *testing.T) {
	content := payload(4000)
	srv := newServer(t, serveBytes(content))
	m, _ := newEnv(t)
	p := filePart("m", srv.URL, content)
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	before := srv.count()

	var log progressLog
	if err := m.Install(context.Background(), p, log.fn); err != nil {
		t.Fatal(err)
	}
	if srv.count() != before {
		t.Errorf("second install made %d request(s)", srv.count()-before)
	}
	if len(log.calls) != 0 {
		t.Errorf("no-op install reported progress %v", log.calls)
	}
}

func TestInstallReplacesInvalidInstallAndCleansStaleTemps(t *testing.T) {
	content := payload(4000)
	srv := newServer(t, serveBytes(content))
	m, root := newEnv(t)
	p := filePart("m", srv.URL, content)

	mustWrite(t, filepath.Join(root, "m", "junk.txt"), []byte("junk"))
	mustWrite(t, filepath.Join(root, ".tmp-m-12345", "half.bin"), []byte("half"))
	mustWrite(t, filepath.Join(root, ".tmp-m-x-999", "other.bin"), []byte("another id's temp dir"))

	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if got := names(t, root); !slices.Equal(got, []string{".tmp-m-x-999", "m"}) {
		t.Errorf("root contains %v", got)
	}
	if got := names(t, m.Dir("m")); !slices.Equal(got, []string{".installed.json", "model.bin"}) {
		t.Errorf("part dir = %v, want the junk replaced", got)
	}

	// A newer expected digest (or a deleted entry) makes the old install invalid; it is replaced.
	newer := payload(5000)
	srv2 := newServer(t, serveBytes(newer))
	p2 := filePart("m", srv2.URL, newer)
	if _, ok := m.Path(p2); ok {
		t.Fatal("old install matches the new digest")
	}
	if err := m.Install(context.Background(), p2, nil); err != nil {
		t.Fatal(err)
	}
	entry, ok := m.Path(p2)
	if !ok || !bytes.Equal(mustRead(t, entry), newer) {
		t.Fatal("not upgraded")
	}
}

func TestRemove(t *testing.T) {
	content := payload(2000)
	srv := newServer(t, serveBytes(content))
	m, root := newEnv(t)
	p := filePart("a", srv.URL, content)
	if err := m.Remove("a"); err != nil {
		t.Fatalf("removing from a root that does not exist: %v", err)
	}
	assertMissing(t, root)

	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "a.part"), []byte("partial"))
	mustWrite(t, filepath.Join(root, ".tmp-a-123", "x"), []byte("x"))
	mustWrite(t, filepath.Join(root, ".tmp-a-b-456", "x"), []byte("x"))
	mustWrite(t, filepath.Join(root, "b", "keep"), []byte("x"))
	mustWrite(t, filepath.Join(root, "b.part"), []byte("x"))

	if err := m.Remove("a"); err != nil {
		t.Fatal(err)
	}
	if got := names(t, root); !slices.Equal(got, []string{".tmp-a-b-456", "b", "b.part"}) {
		t.Errorf("root contains %v", got)
	}
	if _, ok := m.Path(p); ok || m.Status(p).Installed {
		t.Error("part still installed after Remove")
	}
	if err := m.Remove("a"); err != nil {
		t.Errorf("removing an absent part: %v", err)
	}
	for _, bad := range []string{"", "..", "../b", "a/b"} {
		if err := m.Remove(bad); err == nil {
			t.Errorf("Remove(%q) succeeded", bad)
		}
	}
	if got := names(t, root); !slices.Equal(got, []string{".tmp-a-b-456", "b", "b.part"}) {
		t.Errorf("invalid ids touched the root: %v", got)
	}
}

func TestInvalidIDs(t *testing.T) {
	m, root := newEnv(t)
	for _, id := range []string{"", ".", "..", "../x", "a/b", `a\b`, "a b", ".hidden", "trailing.", "x.part", "naïve", "a:b", "a\x00b", strings.Repeat("a", 200)} {
		if got := m.Dir(id); got != "" {
			t.Errorf("Dir(%q) = %q, want empty", id, got)
		}
		err := m.Install(context.Background(), Part{ID: id, URL: "https://example.com/x", Entry: "x"}, nil)
		if err == nil || errors.Is(err, ErrInsecureURL) {
			t.Errorf("Install with id %q: err = %v, want an id error", id, err)
		}
		if _, ok := m.Path(Part{ID: id, Entry: "x"}); ok {
			t.Errorf("Path with id %q reported installed", id)
		}
	}
	for _, id := range []string{"a", "whisper-base.en_v1", "A.B-c_d", "x.partial"} {
		if got, want := m.Dir(id), filepath.Join(root, id); got != want {
			t.Errorf("Dir(%q) = %q, want %q", id, got, want)
		}
	}
	assertMissing(t, root)
}

func TestInvalidEntryAndArchive(t *testing.T) {
	m, root := newEnv(t)
	for _, entry := range []string{"", ".", "..", "sub/x.bin", `sub\x.bin`, "../x.bin", "c:x"} {
		err := m.Install(context.Background(), Part{ID: "m", URL: "https://example.com/x", Entry: entry}, nil)
		if err == nil {
			t.Errorf("entry %q accepted", entry)
		}
		if _, ok := m.Path(Part{ID: "m", Entry: entry}); ok {
			t.Errorf("Path with entry %q reported installed", entry)
		}
	}
	if err := m.Install(context.Background(), Part{ID: "m", URL: "https://example.com/x", Entry: "x", Archive: "tar"}, nil); err == nil {
		t.Error("unsupported archive accepted")
	}
	if err := m.Install(context.Background(), Part{ID: "m", URL: "https://example.com/x", Entry: "x", Archive: "zip", Extract: []string{"[bad"}}, nil); err == nil {
		t.Error("bad extract pattern accepted")
	}
	assertMissing(t, root)
}

func TestPathNeedsEntryAndMatchingDigest(t *testing.T) {
	content := payload(3000)
	srv := newServer(t, serveBytes(content))
	m, _ := newEnv(t)
	p := filePart("m", srv.URL, content)
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}

	changed := p
	changed.SHA256 = sum256([]byte("a different release"))
	if _, ok := m.Path(changed); ok || m.Status(changed).Installed {
		t.Error("Path ignored a changed expected digest")
	}
	unpinned := p
	unpinned.SHA256 = ""
	if _, ok := m.Path(unpinned); !ok {
		t.Error("an empty expected digest should accept any installed file")
	}
	upper := p
	upper.SHA256 = strings.ToUpper(p.SHA256)
	if _, ok := m.Path(upper); !ok {
		t.Error("digest comparison should not depend on case")
	}
	other := p
	other.Entry = "other.bin"
	if _, ok := m.Path(other); ok {
		t.Error("Path returned an entry that does not exist")
	}

	entry, _ := m.Path(p)
	if err := os.Remove(entry); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Path(p); ok {
		t.Error("Path true after the entry file was deleted")
	}
	if st := m.Status(p); st.Installed || st.Path != "" || st.Size != 0 || st.ID != "m" {
		t.Errorf("status = %+v", st)
	}

	// Reinstalling repairs it.
	before := srv.count()
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Fatal(err)
	}
	if srv.count() != before+1 {
		t.Error("repair did not download again")
	}
	if _, ok := m.Path(p); !ok {
		t.Error("not repaired")
	}
	if err := os.Remove(filepath.Join(m.Dir("m"), ".installed.json")); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Path(p); ok {
		t.Error("Path true without the marker")
	}
}

func TestLazyRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "never", "created")
	m := NewManager(root)
	p := Part{ID: "m", URL: "https://example.com/x", Entry: "m.bin"}
	m.Path(p)
	m.Status(p)
	m.Dir("m")
	m.Remove("m")
	assertMissing(t, root)
	assertMissing(t, filepath.Dir(root))
}

func TestInstallSameIDConcurrent(t *testing.T) {
	content := payload(4000)
	release := make(chan struct{})
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		<-release
		serveBytes(content)(w, r)
	})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })

	m, _ := newEnv(t)
	p := filePart("m", srv.URL, content)
	const n = 6
	results := make(chan error, n)
	for i := 0; i < n; i++ {
		go func() { results <- m.Install(context.Background(), p, nil) }()
	}
	for i := 0; i < n-1; i++ {
		select {
		case err := <-results:
			if !errors.Is(err, ErrBusy) {
				t.Fatalf("losing install: err = %v, want ErrBusy", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for the losing installs")
		}
	}
	if err := m.Remove("m"); !errors.Is(err, ErrBusy) {
		t.Errorf("Remove during install: err = %v, want ErrBusy", err)
	}
	once.Do(func() { close(release) })
	select {
	case err := <-results:
		if err != nil {
			t.Fatalf("winning install: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("winner did not finish")
	}
	if srv.count() != 1 {
		t.Errorf("server saw %d requests, want 1", srv.count())
	}
	if _, ok := m.Path(p); !ok {
		t.Error("not installed")
	}
	if err := m.Install(context.Background(), p, nil); err != nil {
		t.Errorf("install after the race: %v", err)
	}
}

func TestInstallDifferentIDsRunConcurrently(t *testing.T) {
	content := payload(4000)
	var arrived atomic.Int32
	both := make(chan struct{})
	srv := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if arrived.Add(1) == 2 {
			close(both)
		}
		select {
		case <-both:
		case <-time.After(10 * time.Second):
			http.Error(w, "the other install never started", http.StatusInternalServerError)
			return
		}
		serveBytes(content)(w, r)
	})
	m, _ := newEnv(t)
	results := make(chan error, 2)
	for _, id := range []string{"a", "b"} {
		go func() { results <- m.Install(context.Background(), filePart(id, srv.URL, content), nil) }()
	}
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"a", "b"} {
		if _, ok := m.Path(filePart(id, srv.URL, content)); !ok {
			t.Errorf("%s not installed", id)
		}
	}
}

func TestReporterThrottle(t *testing.T) {
	var calls []int64
	r := &reporter{fn: func(done, total int64) { calls = append(calls, done) }}
	r.emit(0, true)
	for i := int64(1); i <= 5000; i++ {
		r.emit(i, false)
	}
	if len(calls) < 1 || len(calls) > 3 {
		t.Errorf("%d calls in a tight loop, want the first plus at most a couple more", len(calls))
	}
	r.emit(5000, true)
	if calls[len(calls)-1] != 5000 {
		t.Errorf("forced call not delivered: %v", calls)
	}
	(&reporter{}).emit(1, true)
}
