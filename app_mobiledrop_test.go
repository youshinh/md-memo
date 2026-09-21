package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/dropzone"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
)

// A photo/voice note that cannot be processed is saved to assets, and the note folder is asked
// of the frontend. No test may wait on a webview that never answers, so the default is "" (the
// app data folder, which TestMain redirects into a temp dir) and tests that care stub their own.
func init() {
	mobileDropNoteDir = func(*App) string { return "" }
}

// stubMobileDropNoteDir points the note folder at dir for one test and counts the lookups.
func stubMobileDropNoteDir(t *testing.T, dir string) *int32 {
	t.Helper()
	var calls int32
	orig := mobileDropNoteDir
	mobileDropNoteDir = func(*App) string {
		atomic.AddInt32(&calls, 1)
		return dir
	}
	t.Cleanup(func() { mobileDropNoteDir = orig })
	return &calls
}

// notConfiguredErrors are the genuine "no API key" errors of the two AI calls (both fail before
// any request is made, so this stays offline).
func notConfiguredErrors(t *testing.T) (vision, voice error) {
	t.Helper()
	_, vision = llm.QueryVision("", "", "image/png", llm.VisionConfig{})
	_, voice = llm.QueryAudio("", "", "audio/webm", llm.VoiceConfig{})
	if !errors.Is(vision, llm.ErrNotConfigured) || !errors.Is(voice, llm.ErrNotConfigured) {
		t.Fatalf("expected both calls to report ErrNotConfigured, got %v / %v", vision, voice)
	}
	return vision, voice
}

// stubMobileDropVision replaces the vision call for the duration of a test so nothing reaches
// the network, recording what it was asked.
func stubMobileDropVision(t *testing.T, reply string, err error) *struct {
	prompt, imageBase64, mime string
	calls                     int
} {
	t.Helper()
	got := &struct {
		prompt, imageBase64, mime string
		calls                     int
	}{}
	orig := mobileDropQueryVision
	mobileDropQueryVision = func(prompt, imageBase64, mimeType string, _ llm.VisionConfig) (string, error) {
		got.prompt, got.imageBase64, got.mime = prompt, imageBase64, mimeType
		got.calls++
		return reply, err
	}
	t.Cleanup(func() { mobileDropQueryVision = orig })
	return got
}

// stubMobileDropTranscribe replaces the audio transcription call for the duration of a test.
func stubMobileDropTranscribe(t *testing.T, reply string, err error) *struct {
	audio []byte
	mime  string
	calls int32
} {
	t.Helper()
	got := &struct {
		audio []byte
		mime  string
		calls int32
	}{}
	orig := mobileDropTranscribe
	mobileDropTranscribe = func(audio []byte, mimeType string, _ llm.VoiceConfig) (string, error) {
		atomic.AddInt32(&got.calls, 1)
		got.audio, got.mime = audio, mimeType
		return reply, err
	}
	t.Cleanup(func() { mobileDropTranscribe = orig })
	return got
}

var mobileDropTestTime = time.Date(2026, 9, 20, 10, 5, 9, 0, time.UTC)

func TestBuildMobileDropSection_TextAndURL(t *testing.T) {
	got, err := buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindText, Text: "  buy milk  "}, llm.VisionConfig{}, mobileDropTestTime)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "## Mobile Drop [10:05:09]") || !strings.HasSuffix(got, "\n\nbuy milk\n") {
		t.Errorf("text section malformed: %q", got)
	}

	got, _ = buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindURL, Text: "https://example.com/a"}, llm.VisionConfig{}, mobileDropTestTime)
	if !strings.Contains(got, "[https://example.com/a](https://example.com/a)") {
		t.Errorf("a bare URL should become a markdown link: %q", got)
	}
}

func TestBuildMobileDropSection_Files(t *testing.T) {
	got, _ := buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindFile, Filename: "notes.md", Data: []byte("# Title\n\nbody\n")}, llm.VisionConfig{}, mobileDropTestTime)
	if !strings.Contains(got, "— notes.md") || !strings.HasSuffix(got, "\n\n# Title\n\nbody\n") {
		t.Errorf("markdown file should be appended as-is under its name: %q", got)
	}

	got, _ = buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindFile, Filename: "cfg.json", Data: []byte(`{"a":1}`)}, llm.VisionConfig{}, mobileDropTestTime)
	if !strings.Contains(got, "```json\n{\"a\":1}\n```") {
		t.Errorf("a json file should be fenced: %q", got)
	}
}

func TestBuildMobileDropSection_ShiftJISFile(t *testing.T) {
	sjis, err := encoding.Encode("こんにちは、世界", "Shift_JIS")
	if err != nil {
		t.Fatalf("encoding the fixture: %v", err)
	}
	got, err := buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindFile, Filename: "memo.txt", Data: sjis}, llm.VisionConfig{}, mobileDropTestTime)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(got, "こんにちは、世界") {
		t.Errorf("a Shift_JIS text file must be decoded, got %q", got)
	}
}

func TestBuildMobileDropSection_ImageGoesThroughVision(t *testing.T) {
	stub := stubMobileDropVision(t, "```markdown\n# Receipt\n- coffee 3.50\n```", nil)
	png := []byte("\x89PNG\r\n\x1a\nfake")

	got, err := buildMobileDropSection(
		dropzone.Payload{Kind: dropzone.KindImage, Filename: "IMG_1.png", MimeType: "image/png", Data: png},
		llm.VisionConfig{Prompt: "OCR this"}, mobileDropTestTime)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stub.calls != 1 || stub.prompt != "OCR this" || stub.mime != "image/png" {
		t.Errorf("vision called with prompt=%q mime=%q (calls=%d)", stub.prompt, stub.mime, stub.calls)
	}
	if want := base64.StdEncoding.EncodeToString(png); stub.imageBase64 != want {
		t.Errorf("the photo must reach the vision call base64-encoded")
	}
	if !strings.Contains(got, "\n\n# Receipt\n- coffee 3.50\n") || strings.Contains(got, "```") {
		t.Errorf("the model's outer markdown fence must be stripped: %q", got)
	}
}

func TestBuildMobileDropSection_ImageFailureIsReported(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("Gemini API Keyが設定されていません"))
	got, err := buildMobileDropSection(dropzone.Payload{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}, llm.VisionConfig{}, mobileDropTestTime)
	if err == nil || got != "" {
		t.Fatalf("an OCR failure must surface as an error, got (%q, %v)", got, err)
	}
}

func TestMobileDropItemBody_Audio(t *testing.T) {
	stub := stubMobileDropTranscribe(t, "  buy milk and eggs  ", nil)
	webm := []byte("\x1a\x45\xdf\xa3fake-webm")

	body, err := mobileDropItemBody(dropzone.Payload{Kind: dropzone.KindAudio, Filename: "voice_note_1.webm", MimeType: "audio/webm", Data: webm}, llm.VisionConfig{}, llm.VoiceConfig{Prompt: "transcribe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stub.calls != 1 || stub.mime != "audio/webm" || string(stub.audio) != string(webm) {
		t.Errorf("transcribe called with mime=%q audio=%q (calls=%d)", stub.mime, stub.audio, stub.calls)
	}
	if body != "buy milk and eggs" {
		t.Errorf("body = %q, want the transcript trimmed", body)
	}
}

func TestBuildMobileDropBatchSection_OrderPreservedAndGeoOnFirstOnly(t *testing.T) {
	visionStub := stubMobileDropVision(t, "# Receipt", nil)
	audioStub := stubMobileDropTranscribe(t, "hello world", nil)

	batch := dropzone.Batch{
		Items: []dropzone.Payload{
			{Kind: dropzone.KindImage, Filename: "a.png", MimeType: "image/png", Data: []byte("img-a")},
			{Kind: dropzone.KindImage, Filename: "b.png", MimeType: "image/png", Data: []byte("img-b")},
			{Kind: dropzone.KindAudio, Filename: "voice_note_1.webm", MimeType: "audio/webm", Data: []byte("audio")},
			{Kind: dropzone.KindText, Text: "buy milk"},
		},
		Geo: &dropzone.Geo{Lat: 34.693738, Lon: 135.502165},
	}

	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, nil)
	if fallbacks != 0 {
		t.Errorf("nothing failed, yet %d items were reported as kept as files", fallbacks)
	}

	posA := strings.Index(got, "a.png")
	posB := strings.Index(got, "b.png")
	posAudio := strings.Index(got, "voice_note_1.webm")
	posText := strings.Index(got, "buy milk")
	if posA < 0 || posB < 0 || posAudio < 0 || posText < 0 || !(posA < posB && posB < posAudio && posAudio < posText) {
		t.Fatalf("items must appear in the order they were sent: %q", got)
	}
	if visionStub.calls != 2 || audioStub.calls != 1 {
		t.Errorf("expected 2 vision calls and 1 transcribe call, got %d and %d", visionStub.calls, audioStub.calls)
	}
	if strings.Count(got, "34.694, 135.502") != 1 {
		t.Errorf("geo must be attached to exactly one (the first) item's header: %q", got)
	}
	if idx := strings.Index(got, "34.694, 135.502"); idx > posB {
		t.Errorf("geo must be attached to the FIRST item, not a later one: %q", got)
	}
}

func TestBuildMobileDropBatchSection_OneFailureDoesNotLoseTheOthers(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("OCR down"))
	stubMobileDropTranscribe(t, "transcribed fine", nil)
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()

	batch := dropzone.Batch{Items: []dropzone.Payload{
		{Kind: dropzone.KindImage, Filename: "broken.png", MimeType: "image/png", Data: []byte("x")},
		{Kind: dropzone.KindAudio, Filename: "ok.webm", MimeType: "audio/webm", Data: []byte("y")},
	}}

	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	if strings.Contains(got, "処理に失敗しました") {
		t.Errorf("the failed photo must be kept, not reported as lost: %q", got)
	}
	if !strings.Contains(got, "![broken.png](./assets/2026-09-20-100509.png)\n> 画像OCRに失敗したため、画像として保存しました: OCR down") {
		t.Errorf("failed item should link the saved photo with the reason, got %q", got)
	}
	if !strings.Contains(got, "transcribed fine") {
		t.Errorf("the other item must still be delivered, got %q", got)
	}
	if fallbacks != 1 {
		t.Errorf("fallbackCount = %d, want 1", fallbacks)
	}
}

func TestHandleMobileDropBatch_DeliversTheSection(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropBatch(nil, dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindText, Text: "hello from phone"}}}, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if !strings.Contains(eval, "hello from phone") || !strings.Contains(eval, "Mobile Drop") {
		t.Errorf("received callback is missing the section: %s", eval)
	}
}

// A failing item must still deliver a section (keeping the photo, with the reason next to it)
// rather than an error callback, since a batch may contain other items that succeeded.
func TestHandleMobileDropBatch_ReportsVisionErrorsInline(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("vision backend down"))
	stubMobileDropNoteDir(t, t.TempDir())
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropBatch(nil, dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}}}, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if !strings.Contains(eval, "vision backend down") {
		t.Errorf("failure callback lost the message: %s", eval)
	}
	if !strings.Contains(eval, `"fallbackCount":1`) {
		t.Errorf("the frontend must be told one item was kept as a file: %s", eval)
	}
}

func TestHandleMobileDropBatch_ReportsZeroFallbacksForAnOrdinaryBatch(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropBatch(nil, dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindText, Text: "hello"}}}, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if !strings.Contains(eval, `"fallbackCount":0`) {
		t.Errorf("fallbackCount must always be present: %s", eval)
	}
}

func TestHandleMobileDropBatch_SilentAfterShutdown(t *testing.T) {
	stub := stubMobileDropVision(t, "unused", nil)
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	atomic.StoreInt32(&app.isDestroyed, 1)

	app.handleMobileDropBatch(nil, dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}}}, llm.VisionConfig{}, llm.VoiceConfig{})

	if stub.calls != 0 {
		t.Error("a destroyed app must not spend an OCR call on the photo")
	}
	if len(mock.evals) != 0 {
		t.Errorf("a destroyed app must not touch the webview, got %v", mock.evals)
	}
}

// The submitted text is untrusted input that ends up inside a JS call: it must not be able to
// break out of the argument.
func TestDispatchMobileDropEvent_EscapesUntrustedContent(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	nasty := "</script><script>alert(1)</script>  \"');alert(2);//"
	app.dispatchMobileDropEvent("__onMobileDropReceived", map[string]string{"content": nasty})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	for _, bad := range []string{"</script>", " ", " ", "alert(1)</"} {
		if strings.Contains(eval, bad) {
			t.Errorf("the eval string contains %q unescaped: %s", bad, eval)
		}
	}
	if !strings.HasPrefix(eval, "if (window.__onMobileDropReceived) { window.__onMobileDropReceived({") {
		t.Errorf("unexpected call shape: %s", eval)
	}
}

func TestReleaseMobileDrop_OnlyClearsItsOwnSession(t *testing.T) {
	app := &App{}
	oldSession, newSession := dropzone.New(func(dropzone.Batch) {}), dropzone.New(func(dropzone.Batch) {})

	app.dropzoneServer = newSession
	app.releaseMobileDrop(oldSession) // e.g. the cancelled session's late timeout
	if app.dropzoneServer != newSession {
		t.Fatal("a stale session cleared its successor")
	}
	app.releaseMobileDrop(newSession)
	if app.dropzoneServer != nil {
		t.Fatal("the active session should be cleared by its own release")
	}
}

func TestCancelMobileDrop_WithoutASessionIsANoOp(t *testing.T) {
	app := &App{}
	if err := app.CancelMobileDrop(); err != nil {
		t.Fatalf("CancelMobileDrop() = %v", err)
	}
	app.dropzoneServer = dropzone.New(func(dropzone.Batch) {})
	if err := app.CancelMobileDrop(); err != nil {
		t.Fatalf("CancelMobileDrop() = %v", err)
	}
	if app.dropzoneServer != nil {
		t.Fatal("cancel must forget the session")
	}
}

func TestRequestMobileDropTunnelAsync_WithoutASession(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.RequestMobileDropTunnelAsync()

	eval := mock.waitFor(t, "__onMobileDropTunnelError", 2*time.Second)
	if !strings.Contains(eval, "Mobile Drop") {
		t.Errorf("expected the not-running message, got %s", eval)
	}
}

func TestTunnelErrorMessage(t *testing.T) {
	missing := tunnelErrorMessage(dropzone.ErrCloudflaredNotFound)
	if !strings.Contains(missing, "cloudflared") || !strings.Contains(missing, dropzone.CloudflaredInstallHint()) {
		t.Errorf("a missing cloudflared should come with the install command: %q", missing)
	}
	other := tunnelErrorMessage(errors.New("boom"))
	if !strings.Contains(other, "boom") {
		t.Errorf("other errors should carry their cause: %q", other)
	}
}

func TestTunnelErrorPayload(t *testing.T) {
	missing := tunnelErrorPayload(dropzone.ErrCloudflaredNotFound)
	if missing["code"] != "cloudflared_missing" {
		t.Errorf("a missing cloudflared must be flagged for the UI, got %v", missing)
	}
	if missing["installCommand"] != dropzone.CloudflaredInstallHint() || missing["installCommand"] == "" {
		t.Errorf("the install command must travel with the error so the UI can offer Copy, got %q", missing["installCommand"])
	}
	if !strings.Contains(missing["message"], "cloudflared") {
		t.Errorf("the plain message stays as the fallback text: %v", missing)
	}

	other := tunnelErrorPayload(errors.New("timed out"))
	if _, flagged := other["code"]; flagged || other["installCommand"] != "" {
		t.Errorf("other failures must not offer an install command: %v", other)
	}
	if !strings.Contains(other["message"], "timed out") {
		t.Errorf("other failures keep their cause: %v", other)
	}
}

// --- keeping the photo / voice note when it cannot be turned into text ---------------------

func readAsset(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "assets", name))
	if err != nil {
		t.Fatalf("expected assets/%s to exist: %v", name, err)
	}
	return string(data)
}

// The API is not set up: exactly what Ctrl+Shift+V does with an image-only clipboard, plus a
// note that names the missing setting.
func TestMobileDrop_NotConfiguredKeepsThePhotoLikeCtrlShiftV(t *testing.T) {
	visionErr, _ := notConfiguredErrors(t)
	visionStub := stubMobileDropVision(t, "", visionErr)
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()
	jpg := []byte("\xff\xd8\xff\xe0fake-jpeg")

	batch := dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, Filename: "IMG_0042.JPG", MimeType: "image/jpeg", Data: jpg}}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	want := "\n\n## Mobile Drop [10:05:09] — IMG_0042.JPG\n\n" +
		"![IMG_0042.JPG](./assets/2026-09-20-100509.jpg)\n" +
		"> 画像OCRをスキップし、画像として保存しました: Gemini API Keyが設定されていません (設定 → AIモデル → 画像解析)\n"
	if got != want {
		t.Errorf("section mismatch\n got: %q\nwant: %q", got, want)
	}
	if fallbacks != 1 || visionStub.calls != 1 {
		t.Errorf("fallbackCount = %d, vision calls = %d, want 1 and 1", fallbacks, visionStub.calls)
	}
	if saved := readAsset(t, noteDir, "2026-09-20-100509.jpg"); saved != string(jpg) {
		t.Errorf("the saved file must hold the photo's bytes, got %q", saved)
	}
}

func TestMobileDrop_NotConfiguredKeepsTheVoiceNote(t *testing.T) {
	_, voiceErr := notConfiguredErrors(t)
	stubMobileDropTranscribe(t, "", voiceErr)
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()
	m4a := []byte("fake-m4a-bytes")

	batch := dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindAudio, Filename: "voice memo.m4a", MimeType: "audio/mp4", Data: m4a}}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	want := "\n\n## Mobile Drop [10:05:09] — voice memo.m4a\n\n" +
		"[voice memo.m4a](./assets/2026-09-20-100509.m4a)\n" +
		"> 文字起こしをスキップし、音声として保存しました: Gemini API Keyが設定されていません (設定 → AIモデル → 音声入力)\n"
	if got != want {
		t.Errorf("section mismatch\n got: %q\nwant: %q", got, want)
	}
	if fallbacks != 1 {
		t.Errorf("fallbackCount = %d, want 1", fallbacks)
	}
	if saved := readAsset(t, noteDir, "2026-09-20-100509.m4a"); saved != string(m4a) {
		t.Errorf("the saved file must hold the recording's bytes, got %q", saved)
	}
}

// The user's real failure: an empty transcript used to turn the voice note into a lost-item line.
func TestMobileDrop_EmptyTranscriptKeepsTheVoiceNote(t *testing.T) {
	stubMobileDropTranscribe(t, "   ", nil)
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()

	batch := dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindAudio, Filename: "b4f6a1a2.m4a", MimeType: "audio/mp4", Data: []byte("rec")}}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	if strings.Contains(got, "処理に失敗しました") {
		t.Errorf("the recording must not be reported as lost: %q", got)
	}
	want := "[b4f6a1a2.m4a](./assets/2026-09-20-100509.m4a)\n> 文字起こしに失敗したため、音声として保存しました: 文字起こし結果が空でした\n"
	if !strings.HasSuffix(got, want) {
		t.Errorf("body mismatch\n got: %q\nwant suffix: %q", got, want)
	}
	if fallbacks != 1 {
		t.Errorf("fallbackCount = %d, want 1", fallbacks)
	}
	readAsset(t, noteDir, "2026-09-20-100509.m4a")
}

// Any other error (HTTP failure, timeout, empty transcript reported by the API layer) keeps the
// file too, with the plain "failed" wording instead of "skipped".
func TestMobileDrop_OtherErrorsKeepTheFileWithTheFailureWording(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("Gemini APIエラー (503): overloaded"))
	stubMobileDropTranscribe(t, "", fmt.Errorf("Gemini接続エラー: %w", errors.New("context deadline exceeded")))
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()

	batch := dropzone.Batch{Items: []dropzone.Payload{
		{Kind: dropzone.KindImage, Filename: "a.png", MimeType: "image/png", Data: []byte("img")},
		{Kind: dropzone.KindAudio, Filename: "b.webm", MimeType: "video/webm", Data: []byte("aud")},
	}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	for _, want := range []string{
		"![a.png](./assets/2026-09-20-100509.png)\n> 画像OCRに失敗したため、画像として保存しました: Gemini APIエラー (503): overloaded\n",
		"[b.webm](./assets/2026-09-20-100509.webm)\n> 文字起こしに失敗したため、音声として保存しました: Gemini接続エラー: context deadline exceeded\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	if strings.Contains(got, "スキップ") || strings.Contains(got, "設定 →") {
		t.Errorf("the settings hint belongs to the not-configured case only: %q", got)
	}
	if fallbacks != 2 {
		t.Errorf("fallbackCount = %d, want 2 (both kinds count)", fallbacks)
	}
}

func TestMobileDrop_KeptFilesKeepOrderNamesAndTheOtherItems(t *testing.T) {
	visionErr, _ := notConfiguredErrors(t)
	orig := mobileDropQueryVision
	mobileDropQueryVision = func(prompt, imageBase64, mimeType string, _ llm.VisionConfig) (string, error) {
		// Only the PNG can be read; the JPEGs fail while it is being processed concurrently.
		if mimeType == "image/png" {
			return "# Readable", nil
		}
		return "", visionErr
	}
	t.Cleanup(func() { mobileDropQueryVision = orig })
	stubMobileDropTranscribe(t, "spoken words", nil)
	withFixedNow(t, mobileDropTestTime)
	noteDir := t.TempDir()
	dirCalls := int32(0)

	batch := dropzone.Batch{
		Items: []dropzone.Payload{
			{Kind: dropzone.KindImage, Filename: "first.jpg", MimeType: "image/jpeg", Data: []byte("one")},
			{Kind: dropzone.KindText, Text: "typed note"},
			{Kind: dropzone.KindImage, Filename: "second.jpg", MimeType: "image/jpeg", Data: []byte("two")},
			{Kind: dropzone.KindImage, Filename: "readable.png", MimeType: "image/png", Data: []byte("three")},
			{Kind: dropzone.KindAudio, Filename: "talk.webm", MimeType: "audio/webm", Data: []byte("four")},
			{Kind: dropzone.KindImage, Filename: "third.jpg", MimeType: "image/jpeg", Data: []byte("five")},
		},
		Geo: &dropzone.Geo{Lat: 35.0, Lon: 139.0},
	}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string {
		atomic.AddInt32(&dirCalls, 1)
		return noteDir
	})

	if fallbacks != 3 {
		t.Errorf("fallbackCount = %d, want 3 (the three unreadable photos)", fallbacks)
	}
	if atomic.LoadInt32(&dirCalls) != 1 {
		t.Errorf("the note folder must be looked up once per batch, got %d lookups", dirCalls)
	}

	// Same second, same extension: the names are suffixed in the order the items were sent.
	wantNames := []string{"2026-09-20-100509.jpg", "2026-09-20-100509-2.jpg", "2026-09-20-100509-3.jpg"}
	for i, label := range []string{"first.jpg", "second.jpg", "third.jpg"} {
		want := fmt.Sprintf("![%s](./assets/%s)", label, wantNames[i])
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	readAsset(t, noteDir, wantNames[0])
	if saved := readAsset(t, noteDir, wantNames[1]); saved != "two" {
		t.Errorf("second kept file holds %q, want %q", saved, "two")
	}
	if saved := readAsset(t, noteDir, wantNames[2]); saved != "five" {
		t.Errorf("third kept file holds %q, want %q", saved, "five")
	}

	positions := []int{
		strings.Index(got, "first.jpg"), strings.Index(got, "typed note"), strings.Index(got, "second.jpg"),
		strings.Index(got, "# Readable"), strings.Index(got, "spoken words"), strings.Index(got, "third.jpg"),
	}
	for i := 1; i < len(positions); i++ {
		if positions[i-1] < 0 || positions[i] <= positions[i-1] {
			t.Fatalf("items must stay in the order they were sent: %v in %q", positions, got)
		}
	}
	if strings.Count(got, "35.000, 139.000") != 1 || strings.Index(got, "35.000, 139.000") > strings.Index(got, "typed note") {
		t.Errorf("geo must still sit on the first item only: %q", got)
	}
}

func TestMobileDrop_NoteFolderIsOnlyAskedWhenSomethingNeedsSaving(t *testing.T) {
	stubMobileDropVision(t, "# ok", nil)
	stubMobileDropTranscribe(t, "fine", nil)
	lookups := stubMobileDropNoteDir(t, t.TempDir())
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	batch := dropzone.Batch{Items: []dropzone.Payload{
		{Kind: dropzone.KindImage, Filename: "a.png", MimeType: "image/png", Data: []byte("x")},
		{Kind: dropzone.KindAudio, Filename: "b.webm", MimeType: "audio/webm", Data: []byte("y")},
		{Kind: dropzone.KindText, Text: "hi"},
	}}
	app.handleMobileDropBatch(nil, batch, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if atomic.LoadInt32(lookups) != 0 {
		t.Errorf("a batch that OCR'd and transcribed fine must not ask the webview anything, got %d lookups", *lookups)
	}
	if !strings.Contains(eval, `"fallbackCount":0`) {
		t.Errorf("unexpected payload: %s", eval)
	}
}

// Local Ollama / LM Studio needs no key: the photo must still go through OCR and not be kept.
func TestMobileDrop_LocalVisionServerStillOCRsWithoutAKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("a keyless local server must not receive an Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"# Local OCR result"}}]}`))
	}))
	defer server.Close()
	noteDir := t.TempDir()

	batch := dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, Filename: "shot.png", MimeType: "image/png", Data: []byte("png")}}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{BaseURL: server.URL, Model: "qwen2.5-vl:latest"}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return noteDir })

	if !strings.Contains(got, "# Local OCR result") {
		t.Errorf("the local model's OCR text must be delivered: %q", got)
	}
	if fallbacks != 0 {
		t.Errorf("fallbackCount = %d, want 0", fallbacks)
	}
	if _, err := os.Stat(filepath.Join(noteDir, "assets")); !os.IsNotExist(err) {
		t.Errorf("nothing should have been saved when OCR worked (stat err = %v)", err)
	}
}

// With no note folder the file goes to the app data folder and the link is a file:// URL, the
// same as Ctrl+Shift+V on a note that has no path.
func TestMobileDrop_UnknownNoteFolderUsesTheAppDataFolder(t *testing.T) {
	visionErr, _ := notConfiguredErrors(t)
	stubMobileDropVision(t, "", visionErr)
	withFixedNow(t, mobileDropTestTime)
	prev, err := appdir.ConfigDir()
	if err != nil {
		t.Fatalf("appdir.ConfigDir: %v", err)
	}
	isolated := t.TempDir()
	appdir.SetConfigDirOverride(isolated)
	t.Cleanup(func() { appdir.SetConfigDirOverride(prev) })

	batch := dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, Filename: "IMG_1.png", MimeType: "image/png", Data: []byte("png")}}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return "" })

	abs := filepath.Join(isolated, "md-memo", "assets", "2026-09-20-100509.png")
	if want := "![IMG_1.png](" + FileURLFromPath(abs) + ")\n> 画像OCRをスキップし"; !strings.Contains(got, want) {
		t.Errorf("expected a file:// link to the app data folder\n got: %q\nwant it to contain: %q", got, want)
	}
	if fallbacks != 1 {
		t.Errorf("fallbackCount = %d, want 1", fallbacks)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Errorf("the photo should be saved at %s: %v", abs, err)
	}
}

// If even the fallback save fails the old inline failure line comes back, naming both errors.
func TestMobileDrop_SaveFailureFallsBackToTheFailureLine(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("OCR down"))
	stubMobileDropTranscribe(t, "still fine", nil)
	withFixedNow(t, mobileDropTestTime)
	blocker := filepath.Join(t.TempDir(), "not-a-folder")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	batch := dropzone.Batch{Items: []dropzone.Payload{
		{Kind: dropzone.KindImage, Filename: "broken.png", MimeType: "image/png", Data: []byte("x")},
		{Kind: dropzone.KindAudio, Filename: "ok.webm", MimeType: "audio/webm", Data: []byte("y")},
	}}
	got, fallbacks := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime, func() string { return filepath.Join(blocker, "sub") })

	if !strings.Contains(got, "[Mobile Drop: broken.pngの処理に失敗しました: OCR down (assetsへの保存にも失敗しました: ") {
		t.Errorf("the failure line must name the OCR error and the save error, got %q", got)
	}
	if !strings.Contains(got, "still fine") {
		t.Errorf("the other item must be unaffected: %q", got)
	}
	if fallbacks != 0 {
		t.Errorf("nothing was kept, yet fallbackCount = %d", fallbacks)
	}
}

func TestMobileDrop_KeepLabelIsMarkdownSafe(t *testing.T) {
	cases := []struct {
		p    dropzone.Payload
		want string
	}{
		{dropzone.Payload{Kind: dropzone.KindImage, Filename: "plain.jpg"}, "plain.jpg"},
		{dropzone.Payload{Kind: dropzone.KindImage, Filename: "a [1] b\\c.jpg"}, `a \[1\] b\\c.jpg`},
		{dropzone.Payload{Kind: dropzone.KindImage, Filename: "line\nbreak.jpg"}, "line break.jpg"},
		{dropzone.Payload{Kind: dropzone.KindImage}, "image"},
		{dropzone.Payload{Kind: dropzone.KindAudio, Filename: "  "}, "audio"},
	}
	for _, c := range cases {
		if got := mobileDropLinkLabel(c.p); got != c.want {
			t.Errorf("mobileDropLinkLabel(%q) = %q, want %q", c.p.Filename, got, c.want)
		}
	}
}

func TestMobileDropAssetExt(t *testing.T) {
	cases := []struct {
		mime, filename, want string
	}{
		{"image/png", "", "png"},
		{"image/jpeg", "", "jpg"},
		{"image/gif", "", "gif"},
		{"image/webp", "", "webp"},
		{"image/heic", "IMG_1.HEIC", "heic"},
		{"audio/webm", "", "webm"},
		{"video/webm", "", "webm"}, // Go's sniffer reports a WebM recording as video/webm
		{"audio/webm;codecs=opus", "", "webm"},
		{"audio/mp4", "", "m4a"},
		{"audio/x-m4a", "", "m4a"},
		{"audio/mpeg", "", "mp3"},
		{"audio/wave", "", "wav"},
		{"application/ogg", "", "ogg"},
		{"application/octet-stream", "clip.AMR", "amr"},
		{"application/octet-stream", "clip.e;x", "bin"},
		{"", "no-extension", "bin"},
		{"", "trailing.", "bin"},
		{"", "toolongextension.abcdefg", "bin"},
	}
	for _, c := range cases {
		if got := mobileDropAssetExt(dropzone.Payload{MimeType: c.mime, Filename: c.filename}); got != c.want {
			t.Errorf("mobileDropAssetExt(%q, %q) = %q, want %q", c.mime, c.filename, got, c.want)
		}
	}
}

// The default note-folder lookup goes through the RPC bridge (window.__mdMemoRPC.getNoteDir).
type noteDirMockWebView struct {
	app   *App
	reply string // JSON reply; "" means never answer
	seen  atomic.Value
}

func (m *noteDirMockWebView) Dispatch(f func()) { go f() }

func (m *noteDirMockWebView) Eval(js string) {
	m.seen.Store(js)
	if m.reply == "" {
		return
	}
	_, _ = m.app.ReportRPCResult(extractReqID(js), m.reply, "")
}

func TestAskFrontendNoteDir(t *testing.T) {
	app := &App{}
	mock := &noteDirMockWebView{app: app, reply: `"C:\\Users\\me\\notes"`}
	app.w = mock
	if got := askFrontendNoteDir(app); got != `C:\Users\me\notes` {
		t.Errorf("askFrontendNoteDir = %q", got)
	}
	if js, _ := mock.seen.Load().(string); !strings.Contains(js, "getNoteDir") {
		t.Errorf("the lookup must call the frontend's getNoteDir helper, sent %q", js)
	}

	mock.reply = "null"
	if got := askFrontendNoteDir(app); got != "" {
		t.Errorf("a null answer means no folder, got %q", got)
	}
	mock.reply = `{"unexpected":true}`
	if got := askFrontendNoteDir(app); got != "" {
		t.Errorf("a malformed answer means no folder, got %q", got)
	}
}

func TestAskFrontendNoteDir_UnreachableFrontendReturnsEmpty(t *testing.T) {
	if got := askFrontendNoteDir(nil); got != "" {
		t.Errorf("nil app: %q", got)
	}
	if got := askFrontendNoteDir(&App{}); got != "" {
		t.Errorf("no webview: %q", got)
	}

	app := &App{}
	app.w = &noteDirMockWebView{app: app} // never answers
	start := time.Now()
	if got := askFrontendNoteDir(app); got != "" {
		t.Errorf("a silent frontend must yield an empty folder, got %q", got)
	}
	if elapsed := time.Since(start); elapsed > mobileDropNoteDirTimeout+time.Second {
		t.Errorf("the lookup must give up after about %s, took %s", mobileDropNoteDirTimeout, elapsed)
	}
}

func TestMobileDropReceivedPayloadShape(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	app.dispatchMobileDropEvent("__onMobileDropReceived", map[string]interface{}{"content": "x", "fallbackCount": 2})
	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	start := strings.Index(eval, "({")
	end := strings.LastIndex(eval, "})")
	if start < 0 || end < 0 {
		t.Fatalf("unexpected call shape: %s", eval)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(eval[start+1:end+1]), &payload); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if payload["fallbackCount"] != float64(2) {
		t.Errorf("fallbackCount = %v", payload["fallbackCount"])
	}
}
