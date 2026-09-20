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

func TestHandleMobileDropPayload_DeliversTheSection(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropPayload(nil, dropzone.Payload{Kind: dropzone.KindText, Text: "hello from phone"}, llm.VisionConfig{})

	eval := mock.waitFor(t, "__onMobileDropReceived", time.Second)
	if !strings.Contains(eval, "hello from phone") || !strings.Contains(eval, "Mobile Drop") {
		t.Errorf("received callback is missing the section: %s", eval)
	}
}

func TestHandleMobileDropPayload_ReportsVisionErrors(t *testing.T) {
	stubMobileDropVision(t, "", errors.New("vision backend down"))
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.handleMobileDropPayload(nil, dropzone.Payload{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}, llm.VisionConfig{})

	eval := mock.waitFor(t, "__onMobileDropError", time.Second)
	if !strings.Contains(eval, "vision backend down") {
		t.Errorf("error callback lost the message: %s", eval)
	}
}

func TestHandleMobileDropPayload_SilentAfterShutdown(t *testing.T) {
	stub := stubMobileDropVision(t, "unused", nil)
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	atomic.StoreInt32(&app.isDestroyed, 1)

	app.handleMobileDropPayload(nil, dropzone.Payload{Kind: dropzone.KindImage, MimeType: "image/png", Data: []byte("x")}, llm.VisionConfig{})

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
	oldSession, newSession := dropzone.New(func(dropzone.Payload) {}), dropzone.New(func(dropzone.Payload) {})

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
	app.dropzoneServer = dropzone.New(func(dropzone.Payload) {})
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
