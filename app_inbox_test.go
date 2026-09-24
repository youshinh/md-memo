package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

var (
	errFakeOCR        = errors.New("fake OCR failure")
	errFakeTranscribe = errors.New("fake transcription failure")
)

func TestParseInboxConfig(t *testing.T) {
	a := &App{}

	t.Run("empty config yields disabled defaults", func(t *testing.T) {
		got := a.parseInboxConfig("")
		want := InboxSettings{}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("extracts the inbox block", func(t *testing.T) {
		got := a.parseInboxConfig(`{"inbox":{"enabled":true,"dir":"/tmp/my-inbox"}}`)
		want := InboxSettings{Enabled: true, Dir: "/tmp/my-inbox"}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("missing inbox block yields disabled defaults", func(t *testing.T) {
		got := a.parseInboxConfig(`{"unrelated":true}`)
		want := InboxSettings{}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})
}

func TestInboxVisionVoiceConfigs(t *testing.T) {
	vision, voice := inboxVisionVoiceConfigs(`{"vision":{"baseUrl":"https://v","apiKey":"vk"},"voice":{"baseUrl":"https://a","apiKey":"ak"}}`)
	if vision.BaseURL != "https://v" || vision.APIKey != "vk" {
		t.Errorf("unexpected vision config: %+v", vision)
	}
	if voice.BaseURL != "https://a" || voice.APIKey != "ak" {
		t.Errorf("unexpected voice config: %+v", voice)
	}
}

func TestInboxVisionVoiceConfigs_VoiceFallsBackToVisionCredentials(t *testing.T) {
	// The reported failure: voice has a model but no key of its own, vision holds the key.
	_, voice := inboxVisionVoiceConfigs(`{"vision":{"baseUrl":"https://v","apiKey":"vk"},"voice":{"model":"gemini-3.5-transcribe","apiKey":""}}`)
	if voice.APIKey != "vk" || voice.BaseURL != "https://v" {
		t.Errorf("voice must inherit the vision credentials, got %+v", voice)
	}
	if voice.Model != "gemini-3.5-transcribe" {
		t.Errorf("voice model must be kept, got %q", voice.Model)
	}
}

func TestResolveInboxDir(t *testing.T) {
	t.Run("empty dir defaults under Documents/md-memo", func(t *testing.T) {
		got := resolveInboxDir("")
		if filepath.Base(got) != "inbox" {
			t.Errorf("expected default dir to end in 'inbox', got %q", got)
		}
	})

	t.Run("explicit dir is expanded like scrap dir", func(t *testing.T) {
		got := resolveInboxDir("/custom/inbox")
		want := filepath.Clean("/custom/inbox")
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}

func TestAudioMimeTypeForExt(t *testing.T) {
	cases := map[string]string{
		".mp3":  "audio/mpeg",
		".MP3":  "audio/mpeg",
		".wav":  "audio/wav",
		".m4a":  "audio/mp4",
		".ogg":  "audio/ogg",
		".flac": "audio/flac",
		".xyz":  "audio/mpeg",
	}
	for ext, want := range cases {
		if got := audioMimeTypeForExt(ext); got != want {
			t.Errorf("audioMimeTypeForExt(%q) = %q, want %q", ext, got, want)
		}
	}
}

func TestMoveInboxFileToAssets(t *testing.T) {
	t.Run("moves the file and returns a relative reference", func(t *testing.T) {
		srcDir := t.TempDir()
		scrapDir := t.TempDir()
		src := filepath.Join(srcDir, "shot.png")
		if err := os.WriteFile(src, []byte("data"), 0644); err != nil {
			t.Fatal(err)
		}

		ref := moveInboxFileToAssets(src, scrapDir)
		if ref == "" {
			t.Fatal("expected a non-empty reference")
		}
		if _, err := os.Stat(src); !os.IsNotExist(err) {
			t.Error("expected the source file to no longer exist at its original path")
		}
		assetsDir := filepath.Join(scrapDir, "assets")
		entries, err := os.ReadDir(assetsDir)
		if err != nil || len(entries) != 1 {
			t.Fatalf("expected exactly one file under %s, err=%v entries=%v", assetsDir, err, entries)
		}
	})

	t.Run("nonexistent source returns empty string without panicking", func(t *testing.T) {
		if ref := moveInboxFileToAssets(filepath.Join(t.TempDir(), "nope.png"), t.TempDir()); ref != "" {
			t.Errorf("expected empty reference for a missing source file, got %q", ref)
		}
	})
}

func TestHandleInboxImage(t *testing.T) {
	origRecognize := inboxRecognize
	defer func() { inboxRecognize = origRecognize }()

	scrapDir := t.TempDir()
	a := &App{}
	a.scrapDir = scrapDir

	t.Run("successful OCR appends a blockquote and moves the file to assets", func(t *testing.T) {
		srcDir := t.TempDir()
		src := filepath.Join(srcDir, "photo.png")
		if err := os.WriteFile(src, []byte("img"), 0644); err != nil {
			t.Fatal(err)
		}
		inboxRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			return "captured text", nil
		}

		a.handleInboxImage(src, llm.VisionConfig{})

		entries, _ := os.ReadDir(filepath.Join(scrapDir, "assets"))
		if len(entries) != 1 {
			t.Fatalf("expected the photo to be moved to assets, got %v", entries)
		}
		data, err := os.ReadFile(filepath.Join(scrapDir, time.Now().Format("2006-01-02.md")))
		if err != nil {
			t.Fatalf("expected today's scrap file to exist: %v", err)
		}
		if !strings.Contains(string(data), "captured text") {
			t.Errorf("expected the scrap entry to contain the recognized text, got: %s", data)
		}
	})

	t.Run("OCR failure still moves the file to assets and notes the failure", func(t *testing.T) {
		srcDir2 := t.TempDir()
		src2 := filepath.Join(srcDir2, "unreadable.png")
		if err := os.WriteFile(src2, []byte("img"), 0644); err != nil {
			t.Fatal(err)
		}
		inboxRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
			return "", errFakeOCR
		}

		a.handleInboxImage(src2, llm.VisionConfig{})

		entries, _ := os.ReadDir(filepath.Join(scrapDir, "assets"))
		found := false
		for _, e := range entries {
			if strings.Contains(e.Name(), "unreadable.png") {
				found = true
			}
		}
		if !found {
			t.Errorf("expected the failed-OCR photo to still be moved to assets, got %v", entries)
		}
	})
}

func TestHandleInboxAudio(t *testing.T) {
	origTranscribe := inboxTranscribe
	defer func() { inboxTranscribe = origTranscribe }()

	scrapDir := t.TempDir()
	a := &App{}
	a.scrapDir = scrapDir

	t.Run("successful transcription appends a timestamped blockquote", func(t *testing.T) {
		srcDir := t.TempDir()
		src := filepath.Join(srcDir, "memo.mp3")
		if err := os.WriteFile(src, []byte("audio"), 0644); err != nil {
			t.Fatal(err)
		}
		var seenMime string
		inboxTranscribe = func(path, mimeType string, cfg llm.VoiceConfig) (string, error) {
			seenMime = mimeType
			return "transcribed words", nil
		}

		a.handleInboxAudio(src, llm.VoiceConfig{})

		if seenMime != "audio/mpeg" {
			t.Errorf("expected audio/mpeg mime type, got %q", seenMime)
		}
		data, err := os.ReadFile(filepath.Join(scrapDir, time.Now().Format("2006-01-02.md")))
		if err != nil {
			t.Fatalf("expected today's scrap file to exist: %v", err)
		}
		if !strings.Contains(string(data), "transcribed words") {
			t.Errorf("expected the scrap entry to contain the transcription, got: %s", data)
		}
		entries, _ := os.ReadDir(filepath.Join(scrapDir, "assets"))
		found := false
		for _, e := range entries {
			if strings.Contains(e.Name(), "memo.mp3") {
				found = true
			}
		}
		if !found {
			t.Errorf("expected the audio file to be moved to assets, got %v", entries)
		}
	})

	t.Run("transcription failure still moves the file and notes the failure", func(t *testing.T) {
		srcDir2 := t.TempDir()
		src2 := filepath.Join(srcDir2, "silence.wav")
		if err := os.WriteFile(src2, []byte("audio"), 0644); err != nil {
			t.Fatal(err)
		}
		inboxTranscribe = func(path, mimeType string, cfg llm.VoiceConfig) (string, error) {
			return "", errFakeTranscribe
		}

		a.handleInboxAudio(src2, llm.VoiceConfig{})

		data, err := os.ReadFile(filepath.Join(scrapDir, time.Now().Format("2006-01-02.md")))
		if err != nil {
			t.Fatalf("expected today's scrap file to exist: %v", err)
		}
		if !strings.Contains(string(data), "文字起こしに失敗しました") {
			t.Errorf("expected a failure note in the scrap entry, got: %s", data)
		}
		if !strings.Contains(string(data), errFakeTranscribe.Error()) {
			t.Errorf("the failure note should carry the reason (%q), got: %s", errFakeTranscribe.Error(), data)
		}
	})
}
