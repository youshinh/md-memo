package main

import (
	"encoding/base64"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"md-memo/pkg/dropzone"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
)

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

	got := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime)

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

	batch := dropzone.Batch{Items: []dropzone.Payload{
		{Kind: dropzone.KindImage, Filename: "broken.png", MimeType: "image/png", Data: []byte("x")},
		{Kind: dropzone.KindAudio, Filename: "ok.webm", MimeType: "audio/webm", Data: []byte("y")},
	}}

	got := buildMobileDropBatchSection(batch, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime)

	if !strings.Contains(got, "[Mobile Drop: broken.pngの処理に失敗しました: OCR down]") {
		t.Errorf("failed item should carry an inline failure note, got %q", got)
	}
	if !strings.Contains(got, "transcribed fine") {
		t.Errorf("the other item must still be delivered, got %q", got)
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

// A failing item must still deliver a section (with an inline failure note for that item)
// rather than an error callback, since a batch may contain other items that succeeded.
func TestHandleMobileDropBatch_ReportsVisionErrorsInline(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("vision backend down"))
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropBatch(nil, dropzone.Batch{Items: []dropzone.Payload{{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}}}, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if !strings.Contains(eval, "vision backend down") {
		t.Errorf("failure callback lost the message: %s", eval)
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
