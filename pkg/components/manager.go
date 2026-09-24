package components

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrUnsupportedPlatform = errors.New("components: part is not available for this platform")
	ErrInsecureURL         = errors.New("components: only https URLs are allowed")
	ErrChecksumMismatch    = errors.New("components: downloaded file does not match the expected SHA-256")
	ErrBusy                = errors.New("components: this part is already being installed")
)

const (
	markerName       = ".installed.json"
	progressInterval = 100 * time.Millisecond
	headerTimeout    = 30 * time.Second
	copyBufferSize   = 256 << 10
	maxRedirects     = 10
	maxMarkerBytes   = 1 << 16
)

// A var so tests can lower the zip-bomb cap instead of writing 2 GB.
var maxExtractBytes int64 = 2 << 30

type marker struct {
	ID          string `json:"id"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	URL         string `json:"url"`
	InstalledAt string `json:"installedAt"`
}

type Manager struct {
	root string
	mu   sync.Mutex
	busy map[string]bool
}

func NewManager(root string) *Manager {
	if root != "" {
		if abs, err := filepath.Abs(root); err == nil {
			root = abs
		}
	}
	return &Manager{root: root, busy: map[string]bool{}}
}

func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
		default:
			return false
		}
	}
	// A leading dot would collide with .tmp-* dirs; a trailing dot is trimmed by Windows;
	// ".part" would collide with another id's partial download.
	return id[0] != '.' && !strings.HasSuffix(id, ".") && !strings.HasSuffix(id, ".part")
}

func validEntry(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\:`+"\x00")
}

func (m *Manager) Dir(id string) string {
	if m.root == "" || !validID(id) {
		return ""
	}
	return filepath.Join(m.root, id)
}

func (m *Manager) partPath(id string) string {
	return filepath.Join(m.root, id+".part")
}

func (m *Manager) Path(p Part) (string, bool) {
	dir := m.Dir(p.ID)
	if dir == "" || !validEntry(p.Entry) {
		return "", false
	}
	entry := filepath.Join(dir, p.Entry)
	if fi, err := os.Stat(entry); err != nil || !fi.Mode().IsRegular() {
		return "", false
	}
	mk, err := readMarker(dir)
	if err != nil {
		return "", false
	}
	if p.SHA256 != "" && !strings.EqualFold(mk.SHA256, p.SHA256) {
		return "", false
	}
	return entry, true
}

func (m *Manager) Status(p Part) Status {
	st := Status{ID: p.ID}
	entry, ok := m.Path(p)
	if !ok {
		return st
	}
	st.Installed = true
	st.Path = entry
	st.Size = dirSize(filepath.Dir(entry))
	return st
}

func readMarker(dir string) (marker, error) {
	var mk marker
	f, err := os.Open(filepath.Join(dir, markerName))
	if err != nil {
		return mk, err
	}
	defer f.Close()
	err = json.NewDecoder(io.LimitReader(f, maxMarkerBytes)).Decode(&mk)
	return mk, err
}

func dirSize(dir string) int64 {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	var n int64
	for _, e := range entries {
		if e.IsDir() || e.Name() == markerName {
			continue
		}
		if fi, err := e.Info(); err == nil {
			n += fi.Size()
		}
	}
	return n
}

func (m *Manager) acquire(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy[id] {
		return false
	}
	m.busy[id] = true
	return true
}

func (m *Manager) release(id string) {
	m.mu.Lock()
	delete(m.busy, id)
	m.mu.Unlock()
}

func checkURL(u *url.URL) error {
	switch strings.ToLower(u.Scheme) {
	case "https":
		if u.Hostname() != "" {
			return nil
		}
	case "http":
		switch strings.ToLower(u.Hostname()) {
		case "localhost", "127.0.0.1", "::1":
			return nil
		}
	}
	return ErrInsecureURL
}

func (m *Manager) validate(p Part) error {
	if p.Platform != "" && p.Platform != runtime.GOOS+"/"+runtime.GOARCH {
		return ErrUnsupportedPlatform
	}
	if !validID(p.ID) {
		return fmt.Errorf("components: invalid part id %q", p.ID)
	}
	if m.root == "" {
		return errors.New("components: no root directory")
	}
	u, err := url.Parse(p.URL)
	if err != nil {
		return fmt.Errorf("components: invalid URL: %w", err)
	}
	if err := checkURL(u); err != nil {
		return err
	}
	if !validEntry(p.Entry) {
		return fmt.Errorf("components: invalid entry %q", p.Entry)
	}
	switch p.Archive {
	case "":
	case "zip":
		for _, pat := range p.Extract {
			if _, err := path.Match(strings.ToLower(pat), ""); err != nil {
				return fmt.Errorf("components: bad extract pattern %q: %w", pat, err)
			}
		}
	default:
		return fmt.Errorf("components: unsupported archive %q", p.Archive)
	}
	return nil
}

func (m *Manager) Install(ctx context.Context, p Part, progress func(done, total int64)) error {
	if err := m.validate(p); err != nil {
		return err
	}
	if !m.acquire(p.ID) {
		return ErrBusy
	}
	defer m.release(p.ID)

	if _, ok := m.Path(p); ok {
		return nil
	}
	if err := os.MkdirAll(m.root, 0o755); err != nil {
		return err
	}
	m.removeTemps(p.ID)

	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = headerTimeout
	tr.DisableCompression = true // a transparent gunzip would break Range resume and the checksum
	client := &http.Client{Transport: tr, CheckRedirect: checkRedirect}
	defer tr.CloseIdleConnections()

	part := m.partPath(p.ID)
	sum, size, err := fetch(ctx, client, p, part, &reporter{fn: progress})
	if err != nil {
		return err
	}

	tmp, err := os.MkdirTemp(m.root, ".tmp-"+p.ID+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	_ = os.Chmod(tmp, 0o755)

	if err := populate(ctx, p, part, tmp); err != nil {
		return err
	}
	mk := marker{ID: p.ID, SHA256: sum, Size: size, URL: p.URL, InstalledAt: time.Now().UTC().Format(time.RFC3339)}
	if err := writeMarker(tmp, mk); err != nil {
		return err
	}

	dir := m.Dir(p.ID)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.Rename(tmp, dir)
}

func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return errors.New("components: too many redirects")
	}
	return checkURL(req.URL)
}

func writeMarker(dir string, mk marker) error {
	b, err := json.MarshalIndent(mk, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, markerName), b, 0o644)
}

func (m *Manager) Remove(id string) error {
	if !validID(id) {
		return fmt.Errorf("components: invalid part id %q", id)
	}
	if !m.acquire(id) {
		return ErrBusy
	}
	defer m.release(id)

	if err := os.RemoveAll(m.Dir(id)); err != nil {
		return err
	}
	if err := os.Remove(m.partPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	m.removeTemps(id)
	return nil
}

// removeTemps deletes leftover .tmp-<id>-<digits> dirs; the digits-only check keeps id "a" from
// touching the temp dir of id "a-b".
func (m *Manager) removeTemps(id string) {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return
	}
	prefix := ".tmp-" + id + "-"
	for _, e := range entries {
		rest, ok := strings.CutPrefix(e.Name(), prefix)
		if !ok || !e.IsDir() || rest == "" || strings.Trim(rest, "0123456789") != "" {
			continue
		}
		_ = os.RemoveAll(filepath.Join(m.root, e.Name()))
	}
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(b []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(b)
}

type reporter struct {
	fn    func(done, total int64)
	total int64
	last  time.Time
}

func (r *reporter) emit(done int64, force bool) {
	if r.fn == nil {
		return
	}
	now := time.Now()
	if !force && now.Sub(r.last) < progressInterval {
		return
	}
	r.last = now
	r.fn(done, r.total)
}

type countWriter struct {
	n   int64
	rep *reporter
}

func (w *countWriter) Write(b []byte) (int, error) {
	w.n += int64(len(b))
	w.rep.emit(w.n, false)
	return len(b), nil
}

// parseContentRange reads "bytes S-E/T" (start=S) or "bytes */T" (start=-1); total is -1 when "*".
func parseContentRange(v string) (start, total int64, ok bool) {
	rest, found := strings.CutPrefix(strings.TrimSpace(v), "bytes ")
	if !found {
		return 0, 0, false
	}
	rng, tot, found := strings.Cut(rest, "/")
	if !found {
		return 0, 0, false
	}
	total = -1
	if tot != "*" {
		n, err := strconv.ParseInt(tot, 10, 64)
		if err != nil {
			return 0, 0, false
		}
		total = n
	}
	if rng == "*" {
		return -1, total, true
	}
	first, _, _ := strings.Cut(rng, "-")
	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return start, total, true
}

func hashPrefix(ctx context.Context, h io.Writer, f *os.File, n int64) error {
	got, err := io.Copy(h, ctxReader{ctx, io.LimitReader(f, n)})
	if err != nil {
		return err
	}
	if got != n {
		return errors.New("components: partial download is shorter than expected")
	}
	return nil
}

// fetch downloads p.URL into partPath, resuming an existing partial file, and verifies size and
// checksum. Cancellation and network errors keep the partial file so the next attempt resumes;
// a file that downloaded fully but is wrong is deleted.
func fetch(ctx context.Context, client *http.Client, p Part, partPath string, rep *reporter) (sum string, size int64, err error) {
	var have int64
	if fi, statErr := os.Stat(partPath); statErr == nil && fi.Mode().IsRegular() {
		have = fi.Size()
	}
	if have > 0 && p.Size > 0 && have > p.Size {
		_ = os.Remove(partPath)
		have = 0
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "md-memo")
	if have > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(have, 10)+"-")
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()

	discard := func(e error) (string, int64, error) {
		_ = os.Remove(partPath)
		return "", 0, e
	}
	h := sha256.New()
	var f *os.File
	var total int64

	switch resp.StatusCode {
	case http.StatusPartialContent:
		start, tot, ok := parseContentRange(resp.Header.Get("Content-Range"))
		if !ok || start != have {
			return discard(errors.New("components: server returned an unexpected byte range"))
		}
		if f, err = os.OpenFile(partPath, os.O_RDWR|os.O_CREATE, 0o644); err != nil {
			return "", 0, err
		}
		if err = hashPrefix(ctx, h, f, have); err != nil {
			f.Close()
			if ctx.Err() != nil {
				return "", 0, err
			}
			return discard(err)
		}
		switch {
		case tot >= 0:
			total = tot
		case resp.ContentLength >= 0:
			total = have + resp.ContentLength
		default:
			total = p.Size
		}
	case http.StatusOK:
		// The server ignored Range: start over.
		have = 0
		if f, err = os.OpenFile(partPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644); err != nil {
			return "", 0, err
		}
		total = p.Size
		if resp.ContentLength > 0 {
			total = resp.ContentLength
		}
	case http.StatusRequestedRangeNotSatisfiable:
		if have == 0 {
			return "", 0, fmt.Errorf("components: download failed: server returned %s", resp.Status)
		}
		// The partial file is treated as complete; verification below decides.
		if _, tot, ok := parseContentRange(resp.Header.Get("Content-Range")); ok && tot >= 0 && tot != have {
			return discard(errors.New("components: partial download does not match the server's file"))
		}
		if f, err = os.Open(partPath); err != nil {
			return "", 0, err
		}
		err = hashPrefix(ctx, h, f, have)
		f.Close()
		if err != nil {
			if ctx.Err() != nil {
				return "", 0, err
			}
			return discard(err)
		}
		rep.total = have
		rep.emit(have, true)
		return finish(p, partPath, h, have, rep)
	default:
		return "", 0, fmt.Errorf("components: download failed: server returned %s", resp.Status)
	}

	rep.total = total
	cw := &countWriter{n: have, rep: rep}
	rep.emit(have, true)
	_, copyErr := io.CopyBuffer(io.MultiWriter(f, h, cw), ctxReader{ctx, resp.Body}, make([]byte, copyBufferSize))
	if closeErr := f.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return "", 0, copyErr
	}
	switch {
	case total > 0 && cw.n < total:
		return "", 0, fmt.Errorf("components: download incomplete (%d of %d bytes)", cw.n, total)
	case total > 0 && cw.n > total:
		return discard(fmt.Errorf("components: server sent %d bytes, expected %d", cw.n, total))
	}
	return finish(p, partPath, h, cw.n, rep)
}

func finish(p Part, partPath string, h hash.Hash, size int64, rep *reporter) (string, int64, error) {
	sum := hex.EncodeToString(h.Sum(nil))
	var err error
	switch {
	case size == 0:
		err = errors.New("components: downloaded file is empty")
	case p.Size > 0 && size != p.Size:
		err = fmt.Errorf("components: downloaded %d bytes, expected %d", size, p.Size)
	case p.SHA256 != "" && !strings.EqualFold(sum, p.SHA256):
		err = fmt.Errorf("%w (got %s)", ErrChecksumMismatch, sum)
	}
	if err != nil {
		_ = os.Remove(partPath)
		return "", 0, err
	}
	rep.total = size
	rep.emit(size, true)
	return sum, size, nil
}

// populate turns the verified partial file into the part's files inside tmp.
func populate(ctx context.Context, p Part, partPath, tmp string) error {
	if p.Archive == "" {
		return moveFile(partPath, filepath.Join(tmp, p.Entry))
	}
	err := extractZip(ctx, partPath, tmp, p.Extract)
	if err == nil {
		if fi, statErr := os.Stat(filepath.Join(tmp, p.Entry)); statErr != nil || !fi.Mode().IsRegular() {
			err = fmt.Errorf("components: archive does not contain %q", p.Entry)
		}
	}
	if err != nil {
		if ctx.Err() == nil {
			_ = os.Remove(partPath) // the archive itself is bad; resuming would only fail again
		}
		return err
	}
	_ = os.Remove(partPath)
	return nil
}

func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyFile(src, dst); err != nil {
		return err
	}
	return os.Remove(src)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// zipBaseName returns the flattened destination name for an entry, or false to skip it.
func zipBaseName(zf *zip.File) (string, bool) {
	name := strings.ReplaceAll(zf.Name, `\`, "/")
	if zf.FileInfo().IsDir() || strings.HasSuffix(name, "/") || !zf.Mode().IsRegular() {
		return "", false
	}
	base := path.Base(name)
	if base == "" || base == "." || base == ".." || base == "/" || strings.ContainsAny(base, ":\x00") {
		return "", false
	}
	return base, true
}

func wanted(patterns []string, base string) bool {
	if len(patterns) == 0 {
		return true
	}
	lower := strings.ToLower(base)
	for _, pat := range patterns {
		if ok, _ := path.Match(strings.ToLower(pat), lower); ok {
			return true
		}
	}
	return false
}

func extractZip(ctx context.Context, src, dir string, patterns []string) error {
	zr, err := zip.OpenReader(src)
	if err != nil && !errors.Is(err, zip.ErrInsecurePath) { // we flatten names, so insecure ones are harmless
		return err
	}
	defer zr.Close()

	budget := maxExtractBytes
	seen := map[string]bool{}
	for _, zf := range zr.File {
		base, ok := zipBaseName(zf)
		if !ok || !wanted(patterns, base) {
			continue
		}
		key := strings.ToLower(base)
		if seen[key] { // two entries flatten to one name: first wins
			continue
		}
		seen[key] = true
		n, err := extractEntry(ctx, zf, filepath.Join(dir, base), budget)
		if err != nil {
			return err
		}
		budget -= n
	}
	return nil
}

func extractEntry(ctx context.Context, zf *zip.File, dest string, budget int64) (int64, error) {
	if zf.UncompressedSize64 > uint64(budget) {
		return 0, errors.New("components: archive is too large to extract")
	}
	rc, err := zf.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()

	perm := os.FileMode(0o644)
	if strings.HasSuffix(strings.ToLower(dest), ".exe") || zf.Mode().Perm()&0o111 != 0 {
		perm = 0o755
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, ctxReader{ctx, io.LimitReader(rc, budget+1)})
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, err
	}
	if n > budget {
		return 0, errors.New("components: archive is too large to extract")
	}
	_ = os.Chmod(dest, perm)
	return n, nil
}
