package ocr

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"md-memo/pkg/llm"
)

func TestFormatEntry(t *testing.T) {
	cases := []struct {
		name string
		text string
		want string
	}{
		{"single line", "hello world", "> hello world\n"},
		{"multiple lines each get their own quote marker", "line one\nline two", "> line one\n> line two\n"},
		{"whitespace-only text is empty", "   \n  ", ""},
		{"empty text is empty", "", ""},
		{"leading/trailing whitespace trimmed before quoting", "  hi  \n", "> hi\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FormatEntry(tc.text); got != tc.want {
				t.Errorf("FormatEntry(%q) = %q, want %q", tc.text, got, tc.want)
			}
		})
	}
}

func withRecognizeOnDeviceStub(t *testing.T, fn func(ctx context.Context, imagePath string) (string, error)) {
	t.Helper()
	orig := recognizeOnDevice
	recognizeOnDevice = fn
	t.Cleanup(func() { recognizeOnDevice = orig })
}

// cloudServer is a stand-in Gemini endpoint that counts requests and answers with status/body.
func cloudServer(t *testing.T, calls *int32, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func geminiText(text string) string {
	return `{"candidates":[{"content":{"parts":[{"text":` + jsonString(text) + `}]}}]}`
}

func jsonString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return `"` + s + `"`
}

func writeTestImage(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(p, []byte("not a real png, just bytes"), 0644); err != nil {
		t.Fatalf("failed to write test image: %v", err)
	}
	return p
}

func visionCfg(url string) llm.VisionConfig {
	return llm.VisionConfig{BaseURL: url, APIKey: "k", Model: "gemini-flash-lite-latest"}
}

func TestRecognize_AutoUsesCloudFirstAndSkipsOnDevice(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("cloud OCR text"))

	onDeviceCalled := false
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		onDeviceCalled = true
		return "on-device text", nil
	})

	text, err := Recognize(context.Background(), writeTestImage(t), visionCfg(srv.URL))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "cloud OCR text" {
		t.Errorf("expected the cloud result, got %q", text)
	}
	if onDeviceCalled {
		t.Error("the on-device engine must not run when the cloud model answered")
	}
	if atomic.LoadInt32(&cloudCalls) != 1 {
		t.Errorf("expected exactly one cloud call, got %d", cloudCalls)
	}
}

func TestRecognize_AutoStripsAWrappingCodeFence(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("```markdown\n# Title\n\n| a | b |\n```"))
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "", errOnDeviceUnavailable
	})

	text, err := Recognize(context.Background(), writeTestImage(t), visionCfg(srv.URL))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "# Title\n\n| a | b |" {
		t.Errorf("fence not stripped: %q", text)
	}
}

func TestRecognize_AutoFallsBackToOnDeviceWhenCloudFails(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusInternalServerError, `{"error":"boom"}`)
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "on-device text", nil
	})

	text, err := Recognize(context.Background(), writeTestImage(t), visionCfg(srv.URL))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "on-device text" {
		t.Errorf("expected the on-device fallback, got %q", text)
	}
	if atomic.LoadInt32(&cloudCalls) == 0 {
		t.Error("the cloud model should have been tried first")
	}
}

func TestRecognize_AutoWithoutAnAPIKeyFallsBackToOnDevice(t *testing.T) {
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "on-device text", nil
	})

	text, err := Recognize(context.Background(), writeTestImage(t), llm.VisionConfig{BaseURL: "https://generativelanguage.googleapis.com"})
	if err != nil || text != "on-device text" {
		t.Errorf("no key configured: got %q, %v; want the on-device text", text, err)
	}
}

func TestRecognize_AutoBothFailReportsBoth(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusInternalServerError, `{}`)
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "", errOnDeviceUnavailable
	})

	_, err := Recognize(context.Background(), writeTestImage(t), visionCfg(srv.URL))
	if err == nil {
		t.Fatal("expected an error when both engines fail")
	}
	if !strings.Contains(err.Error(), "cloud OCR failed") || !strings.Contains(err.Error(), "on-device OCR also failed") {
		t.Errorf("error should name both failures, got %v", err)
	}
}

func TestRecognize_AutoCloudSaysNoTextIsNotAnError(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("   "))
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "", errOnDeviceUnavailable
	})

	text, err := Recognize(context.Background(), writeTestImage(t), visionCfg(srv.URL))
	if err != nil || text != "" {
		t.Errorf("an image with no text should be (\"\", nil), got %q, %v", text, err)
	}
}

func TestRecognize_OnDeviceModeNeverCallsTheCloud(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("cloud OCR text"))
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "on-device text", nil
	})

	cfg := visionCfg(srv.URL)
	cfg.OCRMode = ModeOnDevice
	text, err := Recognize(context.Background(), writeTestImage(t), cfg)
	if err != nil || text != "on-device text" {
		t.Fatalf("got %q, %v; want the on-device text", text, err)
	}
	if atomic.LoadInt32(&cloudCalls) != 0 {
		t.Error("on-device mode must never send the image to the cloud")
	}
}

func TestRecognize_OnDeviceModeFailureIsTheResultNotAFallback(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("cloud OCR text"))
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "", errOnDeviceUnavailable
	})

	cfg := visionCfg(srv.URL)
	cfg.OCRMode = ModeOnDevice
	if _, err := Recognize(context.Background(), writeTestImage(t), cfg); !errors.Is(err, errOnDeviceUnavailable) {
		t.Errorf("expected the on-device error, got %v", err)
	}
	if atomic.LoadInt32(&cloudCalls) != 0 {
		t.Error("on-device mode must not fall back to the cloud")
	}
}

func TestRecognize_MissingImageFileFailsBeforeNetworkCall(t *testing.T) {
	var cloudCalls int32
	srv := cloudServer(t, &cloudCalls, http.StatusOK, geminiText("x"))
	withRecognizeOnDeviceStub(t, func(ctx context.Context, imagePath string) (string, error) {
		return "", errOnDeviceUnavailable
	})

	_, err := Recognize(context.Background(), filepath.Join(t.TempDir(), "does-not-exist.png"), visionCfg(srv.URL))
	if err == nil {
		t.Fatal("expected an error for a missing image file")
	}
	if atomic.LoadInt32(&cloudCalls) != 0 {
		t.Error("must not call the cloud vision endpoint when the image cannot even be read")
	}
}

func TestStripWrappingFence(t *testing.T) {
	cases := map[string]string{
		"plain text":                     "plain text",
		"```\nabc\n```":                  "abc",
		"```markdown\n# T\n```":          "# T",
		"```md\nx\n```":                  "x",
		"```go\nx := 1\n```":             "```go\nx := 1\n```",
		"```\nno closing fence":          "```\nno closing fence",
		"  ```text\n  a\n  b\n```  ":     "a\n  b",
		"before\n```\ninner\n```\nafter": "before\n```\ninner\n```\nafter",
	}
	for in, want := range cases {
		if got := stripWrappingFence(in); got != want {
			t.Errorf("stripWrappingFence(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTidyOnDeviceText(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"spaces between Japanese characters", "ご 利 用 明 細", "ご利用明細"},
		{"digits next to Japanese", "2026 年 9 月 24 日", "2026年9月24日"},
		{"Latin words keep one space", "Meeting   notes  here", "Meeting notes here"},
		{"Latin then Japanese", "ping 確 認", "ping確認"},
		{"lines are kept", "テ ス ト\nping 確認", "テスト\nping確認"},
		{"CRLF is normalized", "a b\r\nc d", "a b\nc d"},
		{"empty stays empty", "  \n ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tidyOnDeviceText(tc.in); got != tc.want {
				t.Errorf("tidyOnDeviceText(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestMimeTypeForExt(t *testing.T) {
	cases := map[string]string{
		".png":  "image/png",
		".PNG":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".bmp":  "image/bmp",
		".gif":  "image/gif",
		".webp": "image/webp",
		".tiff": "image/png",
		"":      "image/png",
	}
	for ext, want := range cases {
		if got := mimeTypeForExt(ext); got != want {
			t.Errorf("mimeTypeForExt(%q) = %q, want %q", ext, got, want)
		}
	}
}

func TestErrOnDeviceUnavailableIsStable(t *testing.T) {
	if !errors.Is(errOnDeviceUnavailable, errOnDeviceUnavailable) {
		t.Fatal("sanity check failed")
	}
}
