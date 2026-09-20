package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

// --- FileURLFromPath / pathFromFileURL -------------------------------------------------

func TestFileURLFromPath_WindowsStyleDrivePath(t *testing.T) {
	got := FileURLFromPath(`C:\Users\a b\x.png`)
	want := "file:///C:/Users/a%20b/x.png"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestFileURLFromPath_UnixStylePath(t *testing.T) {
	got := FileURLFromPath("/home/user/a b.png")
	want := "file:///home/user/a%20b.png"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestFileURLFromPath_SpecialCharacters(t *testing.T) {
	got := FileURLFromPath(`C:\notes\日本語 #1 100%.md`)
	if !strings.HasPrefix(got, "file:///C:/notes/") {
		t.Fatalf("unexpected prefix: %q", got)
	}
	if strings.Contains(got, "#") || strings.Contains(got, " ") {
		t.Errorf("expected '#' and ' ' to be percent-encoded, got %q", got)
	}
	if !strings.Contains(got, "%23") {
		t.Errorf("expected '#' to encode as %%23, got %q", got)
	}
	if !strings.Contains(got, "%25") {
		t.Errorf("expected '%%' to encode as %%25, got %q", got)
	}
}

func TestPathFromFileURL_RoundTripsWindowsPath(t *testing.T) {
	original := `C:\Users\a b\日本語.md`
	fileURL := FileURLFromPath(original)
	got, err := pathFromFileURL(fileURL)
	if err != nil {
		t.Fatalf("pathFromFileURL failed: %v", err)
	}
	want := filepath.FromSlash("C:/Users/a b/日本語.md")
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestPathFromFileURL_RejectsNonFileScheme(t *testing.T) {
	if _, err := pathFromFileURL("https://example.com/x"); err == nil {
		t.Fatal("expected an error for a non-file scheme")
	}
}

// --- hasURLScheme / resolveTargetPath ---------------------------------------------------

func TestHasURLScheme_DriveLetterIsNotAScheme(t *testing.T) {
	if _, ok := hasURLScheme(`C:\Users\a`); ok {
		t.Error("a Windows drive letter must not be treated as a URL scheme")
	}
}

func TestHasURLScheme_DetectsKnownSchemes(t *testing.T) {
	cases := map[string]string{
		"file:///C:/x":         "file",
		"http://example.com":   "http",
		"javascript:alert(1)":  "javascript",
		"vscode://open":        "vscode",
	}
	for input, want := range cases {
		got, ok := hasURLScheme(input)
		if !ok || got != want {
			t.Errorf("hasURLScheme(%q) = (%q, %v), want (%q, true)", input, got, ok, want)
		}
	}
}

func TestResolveTargetPath_RejectsNonFileScheme(t *testing.T) {
	if _, err := resolveTargetPath("http://example.com/x", ""); err == nil {
		t.Error("expected http scheme to be rejected")
	}
	if _, err := resolveTargetPath("javascript:alert(1)", ""); err == nil {
		t.Error("expected javascript scheme to be rejected")
	}
}

func TestResolveTargetPath_FileURL(t *testing.T) {
	got, err := resolveTargetPath("file:///C:/Users/a%20b/x.png", "")
	if err != nil {
		t.Fatalf("resolveTargetPath failed: %v", err)
	}
	want := filepath.FromSlash("C:/Users/a b/x.png")
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestResolveTargetPath_RelativeNeedsBaseDir(t *testing.T) {
	if _, err := resolveTargetPath("note-assets/x.png", ""); err == nil {
		t.Error("expected an error when no baseDir is available for a relative path")
	}
	got, err := resolveTargetPath("note-assets/x.png", `C:\notes`)
	if err != nil {
		t.Fatalf("resolveTargetPath failed: %v", err)
	}
	want := filepath.Join(`C:\notes`, "note-assets/x.png")
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

// --- openCommandFor / revealCommandFor ---------------------------------------------------

func TestOpenCommandFor_PerOS(t *testing.T) {
	cases := []struct {
		goos     string
		wantName string
		wantArgs []string
	}{
		{"windows", "rundll32", []string{"url.dll,FileProtocolHandler", `C:\x.png`}},
		{"darwin", "open", []string{"/x.png"}},
		{"linux", "xdg-open", []string{"/x.png"}},
	}
	for _, c := range cases {
		path := `C:\x.png`
		if c.goos != "windows" {
			path = "/x.png"
		}
		name, args := openCommandFor(c.goos, path)
		if name != c.wantName || !equalStrings(args, c.wantArgs) {
			t.Errorf("openCommandFor(%q): got (%q, %v) want (%q, %v)", c.goos, name, args, c.wantName, c.wantArgs)
		}
	}
}

func TestRevealCommandFor_PerOS(t *testing.T) {
	name, args := revealCommandFor("windows", `C:\dir\x.png`)
	if name != "explorer.exe" || !equalStrings(args, []string{`/select,C:\dir\x.png`}) {
		t.Errorf("windows reveal: got (%q, %v)", name, args)
	}

	name, args = revealCommandFor("darwin", "/dir/x.png")
	if name != "open" || !equalStrings(args, []string{"-R", "/dir/x.png"}) {
		t.Errorf("darwin reveal: got (%q, %v)", name, args)
	}

	name, args = revealCommandFor("linux", "/dir/x.png")
	if name != "xdg-open" || !equalStrings(args, []string{"/dir"}) {
		t.Errorf("linux reveal: got (%q, %v)", name, args)
	}
}

func equalStrings(a, b []string) bool {
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

// --- OpenPath / RevealPath ----------------------------------------------------------------

func withStubbedStartProcess(t *testing.T) *[][]string {
	t.Helper()
	var calls [][]string
	orig := inputsStartProcess
	inputsStartProcess = func(name string, args ...string) error {
		calls = append(calls, append([]string{name}, args...))
		return nil
	}
	t.Cleanup(func() { inputsStartProcess = orig })
	return &calls
}

func TestOpenPath_ExistingAbsoluteFile(t *testing.T) {
	calls := withStubbedStartProcess(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	if err := os.WriteFile(target, []byte("hi"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	app := &App{}
	if err := app.OpenPath(target, ""); err != nil {
		t.Fatalf("OpenPath failed: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected exactly one process launch, got %v", *calls)
	}
	wantName, wantArgs := openCommandFor(runtime.GOOS, target)
	got := (*calls)[0]
	if got[0] != wantName || !equalStrings(got[1:], wantArgs) {
		t.Errorf("got %v want [%s %v]", got, wantName, wantArgs)
	}
}

func TestOpenPath_MissingFileErrors(t *testing.T) {
	withStubbedStartProcess(t)
	app := &App{}
	if err := app.OpenPath(filepath.Join(t.TempDir(), "missing.md"), ""); err == nil {
		t.Error("expected an error for a nonexistent target")
	}
}

func TestOpenPath_RejectsHTTPScheme(t *testing.T) {
	calls := withStubbedStartProcess(t)
	app := &App{}
	if err := app.OpenPath("http://example.com", ""); err == nil {
		t.Error("expected an error for an http scheme")
	}
	if len(*calls) != 0 {
		t.Error("no process should have been started")
	}
}

func TestRevealPath_ExistingFile(t *testing.T) {
	calls := withStubbedStartProcess(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "note.md")
	if err := os.WriteFile(target, []byte("hi"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	app := &App{}
	if err := app.RevealPath(target, ""); err != nil {
		t.Fatalf("RevealPath failed: %v", err)
	}
	wantName, wantArgs := revealCommandFor(runtime.GOOS, target)
	got := (*calls)[0]
	if got[0] != wantName || !equalStrings(got[1:], wantArgs) {
		t.Errorf("got %v want [%s %v]", got, wantName, wantArgs)
	}
}

// --- sanitizeAssetFileName ------------------------------------------------------------------

func TestSanitizeAssetFileName(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":    "passwd",
		`..\..\windows\x.png`: "x.png",
		"con.txt":             "_con.txt",
		"CON":                 "_CON",
		"a<b>c:d\"e|f?g*h":    "a_b_c_d_e_f_g_h",
		"trailing.   ":        "trailing",
		"":                    "file",
		"..":                  "file",
		".":                   "file",
	}
	for input, want := range cases {
		got := sanitizeAssetFileName(input)
		if got != want {
			t.Errorf("sanitizeAssetFileName(%q) = %q, want %q", input, got, want)
		}
	}
}

// --- uniqueAssetPath ------------------------------------------------------------------------

func TestUniqueAssetPath_Collision(t *testing.T) {
	dir := t.TempDir()
	p1, n1 := uniqueAssetPath(dir, "shot", "png")
	if n1 != "shot.png" {
		t.Fatalf("expected first name shot.png, got %q", n1)
	}
	if err := os.WriteFile(p1, []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	p2, n2 := uniqueAssetPath(dir, "shot", "png")
	if n2 != "shot-2.png" {
		t.Errorf("expected collision name shot-2.png, got %q", n2)
	}
	if err := os.WriteFile(p2, []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, n3 := uniqueAssetPath(dir, "shot", "png")
	if n3 != "shot-3.png" {
		t.Errorf("expected second collision name shot-3.png, got %q", n3)
	}
}

// --- decodeCappedBase64 ---------------------------------------------------------------------

func TestDecodeCappedBase64_RejectsOversized(t *testing.T) {
	huge := strings.Repeat("A", 200)
	if _, err := decodeCappedBase64(huge, 10); err == nil {
		t.Error("expected an error for an oversized payload")
	}
}

func TestDecodeCappedBase64_StripsDataURLPrefix(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("hello"))
	data, err := decodeCappedBase64("data:image/png;base64,"+payload, 1024)
	if err != nil {
		t.Fatalf("decodeCappedBase64 failed: %v", err)
	}
	if string(data) != "hello" {
		t.Errorf("got %q want %q", data, "hello")
	}
}

func TestDecodeCappedBase64_RejectsInvalid(t *testing.T) {
	if _, err := decodeCappedBase64("not-valid-base64!!!", 1024); err == nil {
		t.Error("expected an error for invalid base64")
	}
}

// --- SaveAsset / ImportAssetFile ------------------------------------------------------------

func withFixedNow(t *testing.T, at time.Time) {
	t.Helper()
	orig := inputsNow
	inputsNow = func() time.Time { return at }
	t.Cleanup(func() { inputsNow = orig })
}

func TestSaveAsset_WritesUnderBaseDirWithRelPath(t *testing.T) {
	withFixedNow(t, time.Date(2026, 9, 21, 15, 4, 5, 0, time.UTC))
	baseDir := t.TempDir()
	payload := base64.StdEncoding.EncodeToString([]byte("PNGDATA"))

	app := &App{}
	result, err := app.SaveAsset(baseDir, "png", payload)
	if err != nil {
		t.Fatalf("SaveAsset failed: %v", err)
	}
	wantName := "2026-09-21-150405.png"
	wantAbs := filepath.Join(baseDir, "assets", wantName)
	if result.AbsPath != wantAbs {
		t.Errorf("AbsPath = %q, want %q", result.AbsPath, wantAbs)
	}
	if result.RelPath != "./assets/"+wantName {
		t.Errorf("RelPath = %q, want %q", result.RelPath, "./assets/"+wantName)
	}
	if result.FileURL != FileURLFromPath(wantAbs) {
		t.Errorf("FileURL = %q, want %q", result.FileURL, FileURLFromPath(wantAbs))
	}
	data, err := os.ReadFile(wantAbs)
	if err != nil || string(data) != "PNGDATA" {
		t.Errorf("file content mismatch: %v %q", err, data)
	}
}

func TestSaveAsset_EmptyBaseDirUsesAppDirAndNoRelPath(t *testing.T) {
	withFixedNow(t, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	payload := base64.StdEncoding.EncodeToString([]byte("x"))

	app := &App{}
	result, err := app.SaveAsset("", "txt", payload)
	if err != nil {
		t.Fatalf("SaveAsset failed: %v", err)
	}
	if result.RelPath != "" {
		t.Errorf("expected empty RelPath when baseDir is empty, got %q", result.RelPath)
	}
	appDir, err := inputsAppDir()
	if err != nil {
		t.Fatalf("inputsAppDir: %v", err)
	}
	wantPrefix := filepath.Join(appDir, "assets")
	if !strings.HasPrefix(result.AbsPath, wantPrefix) {
		t.Errorf("AbsPath = %q, want prefix %q", result.AbsPath, wantPrefix)
	}
}

func TestSaveAsset_RejectsUnknownExtension(t *testing.T) {
	app := &App{}
	if _, err := app.SaveAsset(t.TempDir(), "exe", base64.StdEncoding.EncodeToString([]byte("x"))); err == nil {
		t.Error("expected an error for a non-whitelisted extension")
	}
}

func TestSaveAsset_RejectsOversizedPayload(t *testing.T) {
	app := &App{}
	huge := strings.Repeat("A", 40*1024*1024)
	if _, err := app.SaveAsset(t.TempDir(), "txt", huge); err == nil {
		t.Error("expected an error for a payload over the size cap")
	}
}

func TestImportAssetFile_SanitizesNameAndHandlesCollision(t *testing.T) {
	baseDir := t.TempDir()
	app := &App{}
	payload := base64.StdEncoding.EncodeToString([]byte("data"))

	r1, err := app.ImportAssetFile(baseDir, "../../etc/report.pdf", payload)
	if err != nil {
		t.Fatalf("ImportAssetFile failed: %v", err)
	}
	if filepath.Base(r1.AbsPath) != "report.pdf" {
		t.Errorf("expected sanitized name report.pdf, got %q", filepath.Base(r1.AbsPath))
	}

	r2, err := app.ImportAssetFile(baseDir, "report.pdf", payload)
	if err != nil {
		t.Fatalf("ImportAssetFile failed: %v", err)
	}
	if filepath.Base(r2.AbsPath) != "report-2.pdf" {
		t.Errorf("expected collision name report-2.pdf, got %q", filepath.Base(r2.AbsPath))
	}
}

// --- Voice: TranscribeAudioAsync / RetryVoiceCacheAsync / Keep / Discard -------------------

type voiceMockWebView struct {
	mu    sync.Mutex
	evals []string
}

func (m *voiceMockWebView) Dispatch(fn func()) { fn() }

func (m *voiceMockWebView) Eval(js string) {
	m.mu.Lock()
	m.evals = append(m.evals, js)
	m.mu.Unlock()
}

func (m *voiceMockWebView) waitFor(t *testing.T, substr string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		for _, e := range m.evals {
			if strings.Contains(e, substr) {
				m.mu.Unlock()
				return e
			}
		}
		m.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for an eval containing %q", substr)
	return ""
}

func withStubbedQueryAudio(t *testing.T, fn func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error)) {
	t.Helper()
	orig := inputsQueryAudio
	inputsQueryAudio = fn
	t.Cleanup(func() { inputsQueryAudio = orig })
}

func TestTranscribeAudioAsync_Success(t *testing.T) {
	withStubbedQueryAudio(t, func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error) {
		return "こんにちは", nil
	})
	mock := &voiceMockWebView{}
	app := &App{w: mock}

	app.TranscribeAudioAsync("req_ab12", "QUJD", "audio/webm", "{}")
	eval := mock.waitFor(t, "__onVoiceResult", 5*time.Second)
	if !strings.Contains(eval, "req_ab12") || !strings.Contains(eval, "こんにちは") {
		t.Errorf("unexpected eval: %s", eval)
	}
}

func TestTranscribeAudioAsync_FailureSavesCache(t *testing.T) {
	withStubbedQueryAudio(t, func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error) {
		return "", fmt.Errorf("network down")
	})
	mock := &voiceMockWebView{}
	app := &App{w: mock}

	audioPayload := base64.StdEncoding.EncodeToString([]byte("audio-bytes"))
	app.TranscribeAudioAsync("req_xy9z", audioPayload, "audio/webm", "{}")
	eval := mock.waitFor(t, "__onVoiceResult", 5*time.Second)
	if !strings.Contains(eval, "network down") {
		t.Errorf("expected the error message in the eval: %s", eval)
	}

	dir, err := voiceCacheDir()
	if err != nil {
		t.Fatalf("voiceCacheDir: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read voice_cache dir: %v", err)
	}
	found := false
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), "_xy9z.webm") {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a cache file ending in _xy9z.webm, got entries %v", entries)
	}
}

func TestRetryVoiceCacheAsync_SuccessDeletesCache(t *testing.T) {
	dir, err := voiceCacheDir()
	if err != nil {
		t.Fatalf("voiceCacheDir: %v", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	cachePath := filepath.Join(dir, "2026-09-21-000000_ab12.webm")
	if err := os.WriteFile(cachePath, []byte("audio"), 0600); err != nil {
		t.Fatalf("write cache: %v", err)
	}

	withStubbedQueryAudio(t, func(prompt, audioBase64, mimeType string, cfg llm.VoiceConfig) (string, error) {
		return "retried text", nil
	})
	mock := &voiceMockWebView{}
	app := &App{w: mock}

	app.RetryVoiceCacheAsync("req_ab12", cachePath, "{}")
	eval := mock.waitFor(t, "retried text", 5*time.Second)
	if !strings.Contains(eval, "req_ab12") {
		t.Errorf("unexpected eval: %s", eval)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Error("expected the cache file to be removed after a successful retry")
	}
}

func TestKeepVoiceCache_MovesIntoAssets(t *testing.T) {
	dir, err := voiceCacheDir()
	if err != nil {
		t.Fatalf("voiceCacheDir: %v", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	cachePath := filepath.Join(dir, "2026-09-21-000001_cd34.webm")
	if err := os.WriteFile(cachePath, []byte("audio-keep"), 0600); err != nil {
		t.Fatalf("write cache: %v", err)
	}

	baseDir := t.TempDir()
	app := &App{}
	result, err := app.KeepVoiceCache(cachePath, baseDir)
	if err != nil {
		t.Fatalf("KeepVoiceCache failed: %v", err)
	}
	if !strings.HasPrefix(result.AbsPath, filepath.Join(baseDir, "assets")) {
		t.Errorf("expected the file moved under assets, got %q", result.AbsPath)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Error("expected the original cache file to be removed")
	}
	data, err := os.ReadFile(result.AbsPath)
	if err != nil || string(data) != "audio-keep" {
		t.Errorf("unexpected content: %v %q", err, data)
	}
}

func TestDiscardVoiceCache_RemovesFile(t *testing.T) {
	dir, err := voiceCacheDir()
	if err != nil {
		t.Fatalf("voiceCacheDir: %v", err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	cachePath := filepath.Join(dir, "2026-09-21-000002_ef56.webm")
	if err := os.WriteFile(cachePath, []byte("x"), 0600); err != nil {
		t.Fatalf("write cache: %v", err)
	}

	app := &App{}
	if err := app.DiscardVoiceCache(cachePath); err != nil {
		t.Fatalf("DiscardVoiceCache failed: %v", err)
	}
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Error("expected the cache file to be removed")
	}
}

func TestResolveVoiceCachePath_RejectsTraversal(t *testing.T) {
	if _, err := resolveVoiceCachePath("../../etc/passwd"); err == nil {
		t.Error("expected traversal outside voice_cache to be rejected")
	}
}

func TestResolveVoiceCachePath_AcceptsPlainNameInsideCacheDir(t *testing.T) {
	dir, err := voiceCacheDir()
	if err != nil {
		t.Fatalf("voiceCacheDir: %v", err)
	}
	got, err := resolveVoiceCachePath("2026-09-21-000000_ab12.webm")
	if err != nil {
		t.Fatalf("resolveVoiceCachePath failed: %v", err)
	}
	want := filepath.Join(dir, "2026-09-21-000000_ab12.webm")
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

func TestOpenPath_PercentEncodedRelativeTarget(t *testing.T) {
	calls := withStubbedStartProcess(t)
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.MkdirAll(assets, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	real := filepath.Join(assets, "my photo (1).png")
	if err := os.WriteFile(real, []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	app := &App{}
	if err := app.OpenPath("./assets/my%20photo%20%281%29.png", dir); err != nil {
		t.Fatalf("OpenPath failed: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected one launch, got %v", *calls)
	}
	if got := (*calls)[0][len((*calls)[0])-1]; got != real {
		t.Errorf("opened %q, want %q", got, real)
	}
}

func TestResolveTargetPath_LiteralPercentNameWins(t *testing.T) {
	dir := t.TempDir()
	literal := filepath.Join(dir, "a%20b.txt")
	if err := os.WriteFile(literal, []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := resolveTargetPath("a%20b.txt", dir)
	if err != nil || got != literal {
		t.Errorf("got %q, %v; want %q", got, err, literal)
	}
}
