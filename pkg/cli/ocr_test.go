package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

func TestParseOCRFileConfig(t *testing.T) {
	t.Run("missing/invalid JSON falls back to defaults", func(t *testing.T) {
		cfg := parseOCRFileConfig([]byte("not json"))
		if cfg.ScrapDir != "~/Documents/md-memo/scraps" {
			t.Errorf("expected default scrap dir, got %q", cfg.ScrapDir)
		}
	})

	t.Run("reads scrap_dir and vision from real config.json shape", func(t *testing.T) {
		raw := `{"scrap_dir":"/custom/scraps","vision":{"baseUrl":"https://example.com","model":"gemini-flash-lite-latest","apiKey":"k","prompt":"describe"}}`
		cfg := parseOCRFileConfig([]byte(raw))
		if cfg.ScrapDir != "/custom/scraps" {
			t.Errorf("expected custom scrap dir, got %q", cfg.ScrapDir)
		}
		want := llm.VisionConfig{BaseURL: "https://example.com", Model: "gemini-flash-lite-latest", APIKey: "k", Prompt: "describe"}
		if cfg.Vision != want {
			t.Errorf("vision config = %+v, want %+v", cfg.Vision, want)
		}
	})
}

func TestRunOCR(t *testing.T) {
	dir := t.TempDir()
	imgPath := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(imgPath, []byte("fake image bytes"), 0644); err != nil {
		t.Fatalf("failed to write test image: %v", err)
	}

	t.Run("missing argument is a usage error", func(t *testing.T) {
		var out, errOut bytes.Buffer
		r := NewHeadlessRunner(&out, &errOut)
		code, err := r.Run([]string{"ocr"})
		if code == 0 || err == nil {
			t.Fatal("expected a non-zero exit code and an error for a missing image path")
		}
	})

	t.Run("nonexistent image path fails before calling OCR", func(t *testing.T) {
		called := false
		origRecognize := ocrRecognize
		ocrRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			called = true
			return "", nil
		}
		defer func() { ocrRecognize = origRecognize }()

		var out, errOut bytes.Buffer
		r := NewHeadlessRunner(&out, &errOut)
		code, err := r.Run([]string{"ocr", filepath.Join(dir, "does-not-exist.png")})
		if code == 0 || err == nil {
			t.Fatal("expected an error for a nonexistent image path")
		}
		if called {
			t.Error("must not attempt OCR when the image file does not exist")
		}
	})

	t.Run("successful recognition appends a blockquote and reports the path", func(t *testing.T) {
		origRecognize, origAppend := ocrRecognize, scrapAppendRaw
		ocrRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			if imagePath != imgPath {
				t.Errorf("expected imagePath %q, got %q", imgPath, imagePath)
			}
			return "recognized text", nil
		}
		var seenEntry string
		scrapAppendRaw = func(scrapDir, entry string, at time.Time) (string, error) {
			seenEntry = entry
			return filepath.Join(dir, "2026-09-23.md"), nil
		}
		defer func() { ocrRecognize, scrapAppendRaw = origRecognize, origAppend }()

		var out, errOut bytes.Buffer
		r := NewHeadlessRunner(&out, &errOut)
		code, err := r.Run([]string{"ocr", imgPath})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if code != 0 {
			t.Errorf("expected exit code 0, got %d", code)
		}
		if seenEntry != "> recognized text\n" {
			t.Errorf("expected a blockquote entry, got %q", seenEntry)
		}
		if !strings.Contains(out.String(), "2026-09-23.md") {
			t.Errorf("expected stdout to mention the appended path, got %q", out.String())
		}
	})

	t.Run("no text recognized skips the append entirely", func(t *testing.T) {
		origRecognize, origAppend := ocrRecognize, scrapAppendRaw
		appendCalled := false
		ocrRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			return "   ", nil
		}
		scrapAppendRaw = func(scrapDir, entry string, at time.Time) (string, error) {
			appendCalled = true
			return "", nil
		}
		defer func() { ocrRecognize, scrapAppendRaw = origRecognize, origAppend }()

		var out, errOut bytes.Buffer
		r := NewHeadlessRunner(&out, &errOut)
		code, err := r.Run([]string{"ocr", imgPath})
		if err != nil || code != 0 {
			t.Fatalf("expected a clean exit for no recognized text, got code=%d err=%v", code, err)
		}
		if appendCalled {
			t.Error("must not append an empty entry")
		}
	})

	t.Run("OCR failure is surfaced as a non-zero exit", func(t *testing.T) {
		origRecognize := ocrRecognize
		ocrRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			return "", errors.New("both on-device and cloud OCR failed")
		}
		defer func() { ocrRecognize = origRecognize }()

		var out, errOut bytes.Buffer
		r := NewHeadlessRunner(&out, &errOut)
		code, err := r.Run([]string{"ocr", imgPath})
		if code == 0 || err == nil {
			t.Fatal("expected a non-zero exit and an error when OCR fails")
		}
	})
}
