package ocr

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/llm"
)

var errOnDeviceUnavailable = errors.New("on-device OCR not available")

// ModeOnDevice is llm.VisionConfig.OCRMode's "never send the image anywhere" value; any other
// value (including "") means "auto".
const ModeOnDevice = "on-device"

// cloudAttemptTimeout caps the cloud attempt so a dead connection cannot eat the whole OCR budget
// and leave the on-device fallback no time to run.
const cloudAttemptTimeout = 30 * time.Second

// recognizeOnDevice is indirected per-OS: ocr_windows.go provides the real WinRT-backed
// implementation (Windows.Media.Ocr via a one-shot PowerShell invocation, no standing
// process); ocr_unix.go always reports unavailable. Tests can stub this too.
var recognizeOnDevice = recognizeOnDeviceOS

// Recognize extracts text from the image at imagePath.
//
// In auto mode (the default) the cloud vision model configured in cfg goes first: it reads
// Japanese, small print, numbers and tables far more accurately than the on-device engine, and
// returns structured Markdown. The on-device engine (Windows only, offline, no standing process)
// is the fallback for when the cloud attempt fails - no API key, no network, an error, or an
// answer with no text in it.
//
// With cfg.OCRMode == ModeOnDevice the image never leaves the machine: only the on-device engine
// runs, and if it fails that is the result.
func Recognize(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
	if cfg.OCRMode == ModeOnDevice {
		return recognizeOnDevice(ctx, imagePath)
	}

	text, cloudErr := recognizeCloud(ctx, imagePath, cfg)
	if cloudErr == nil && strings.TrimSpace(text) != "" {
		return text, nil
	}

	deviceText, deviceErr := recognizeOnDevice(ctx, imagePath)
	if deviceErr == nil {
		return deviceText, nil
	}
	if cloudErr != nil {
		return "", fmt.Errorf("cloud OCR failed (%v); on-device OCR also failed (%v)", cloudErr, deviceErr)
	}
	// The cloud model answered, just with nothing to read: an image without text is not an error.
	return "", nil
}

// recognizeCloud sends the image to the configured vision model. The model call has no context
// of its own, so it runs on a goroutine that is abandoned when the attempt times out or ctx ends.
func recognizeCloud(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
	data, err := os.ReadFile(imagePath)
	if err != nil {
		return "", fmt.Errorf("reading image for cloud OCR: %w", err)
	}
	mimeType := mimeTypeForExt(filepath.Ext(imagePath))
	encoded := base64.StdEncoding.EncodeToString(data)

	type result struct {
		text string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		text, err := llm.QueryVision(cfg.Prompt, encoded, mimeType, cfg)
		ch <- result{text, err}
	}()

	timer := time.NewTimer(cloudAttemptTimeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return "", r.err
		}
		return stripWrappingFence(r.text), nil
	case <-timer.C:
		return "", errors.New("cloud OCR timed out")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// stripWrappingFence removes a code fence that wraps the whole answer (models often return the
// Markdown they were asked for inside ```markdown ... ```), leaving fences of other languages and
// fences inside the text alone.
func stripWrappingFence(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "```") {
		return s
	}
	lines := strings.Split(s, "\n")
	if len(lines) < 2 || strings.TrimSpace(lines[len(lines)-1]) != "```" {
		return s
	}
	lang := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[0]), "```")))
	if lang == "" || lang == "text" || lang == "markdown" || lang == "md" {
		return strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}
	return s
}

func isCJKRune(r rune) bool {
	return (r >= 0x3000 && r <= 0x30FF) || // CJK punctuation, hiragana, katakana
		(r >= 0x3400 && r <= 0x4DBF) || // CJK extension A
		(r >= 0x4E00 && r <= 0x9FFF) || // CJK ideographs
		(r >= 0xFF00 && r <= 0xFFEF) // full-width / half-width forms
}

// tidyOnDeviceText repairs the spacing Windows.Media.Ocr produces for Japanese: it puts a space
// between every character ("2026 年 9 月 ご 利 用"). A space next to a Japanese character is
// dropped; runs of spaces between two non-Japanese words collapse to one. Line breaks are kept.
// The cost is that a real space between Japanese and Latin text ("テスト ping") is dropped too,
// which is ordinary Japanese typography.
func tidyOnDeviceText(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i, line := range lines {
		runes := []rune(line)
		var b strings.Builder
		var prev rune
		for j := 0; j < len(runes); j++ {
			if runes[j] != ' ' {
				b.WriteRune(runes[j])
				prev = runes[j]
				continue
			}
			k := j
			for k < len(runes) && runes[k] == ' ' {
				k++
			}
			var next rune
			if k < len(runes) {
				next = runes[k]
			}
			if !(prev != 0 && isCJKRune(prev)) && !(next != 0 && isCJKRune(next)) {
				b.WriteRune(' ')
				prev = ' '
			}
			j = k - 1
		}
		lines[i] = strings.TrimSpace(b.String())
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// FormatEntry renders recognized text as a Markdown blockquote so it reads as a distinct
// captured note rather than plain body text. Returns "" for no-text-recognized (callers should
// not append an empty entry). Shared by every caller of Recognize (the `ocr` CLI subcommand,
// the inbox hot-folder watcher) so a dropped image looks the same in a note regardless of how
// it got there.
func FormatEntry(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n") + "\n"
}

func mimeTypeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return "image/png"
	}
}
