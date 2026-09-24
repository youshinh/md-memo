package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/discordbridge"
	"md-memo/pkg/dropzone"
	"md-memo/pkg/llm"
)

func TestParseDiscordBridgeConfig(t *testing.T) {
	t.Run("empty config yields defaults", func(t *testing.T) {
		a := &App{}
		got := a.parseDiscordBridgeConfig("")
		want := DiscordBridgeSettings{PollIntervalSeconds: 45}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("parses and trims the discordBridge block", func(t *testing.T) {
		a := &App{}
		cfg := `{"discordBridge":{"enabled":true,"botToken":"  tok-abc  ","allowedUserId":" 12345 ","pollIntervalSeconds":90}}`
		got := a.parseDiscordBridgeConfig(cfg)
		want := DiscordBridgeSettings{Enabled: true, BotToken: "tok-abc", AllowedUserID: "12345", PollIntervalSeconds: 90}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("missing discordBridge block yields defaults", func(t *testing.T) {
		a := &App{}
		got := a.parseDiscordBridgeConfig(`{"unrelated": true}`)
		if got.Enabled || got.PollIntervalSeconds != 45 {
			t.Errorf("expected disabled defaults, got %+v", got)
		}
	})

	t.Run("a non-positive interval falls back to the 45s default", func(t *testing.T) {
		a := &App{}
		got := a.parseDiscordBridgeConfig(`{"discordBridge":{"pollIntervalSeconds":0}}`)
		if got.PollIntervalSeconds != 45 {
			t.Errorf("expected default interval, got %d", got.PollIntervalSeconds)
		}
	})
}

func TestDiscordDropConfigs_ReadsVisionAndVoiceSections(t *testing.T) {
	cfg := `{"vision":{"apiKey":"vk","model":"vm"},"voice":{"apiKey":"ak","model":"am"}}`
	vision, voice := discordDropConfigs(cfg)
	if vision.APIKey != "vk" || vision.Model != "vm" {
		t.Errorf("unexpected vision config: %+v", vision)
	}
	if voice.APIKey != "ak" || voice.Model != "am" {
		t.Errorf("unexpected voice config: %+v", voice)
	}
}

func TestDiscordDropConfigs_VoiceFallsBackToVisionCredentials(t *testing.T) {
	_, voice := discordDropConfigs(`{"vision":{"apiKey":"vk"},"voice":{"model":"am"}}`)
	if voice.APIKey != "vk" {
		t.Errorf("voice must inherit the vision key, got %+v", voice)
	}
}

func TestDiscordAttachmentKind(t *testing.T) {
	cases := map[string]dropzone.Kind{
		"image/png":           dropzone.KindImage,
		"image/jpeg; foo=bar": dropzone.KindImage,
		"audio/ogg":           dropzone.KindAudio,
		"video/webm":          dropzone.KindAudio,
		"application/pdf":     dropzone.KindFile,
		"":                    dropzone.KindFile,
	}
	for ct, want := range cases {
		if got := discordAttachmentKind(ct); got != want {
			t.Errorf("discordAttachmentKind(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestDiscordMessageToPayloads(t *testing.T) {
	t.Run("text-only message becomes one KindText payload", func(t *testing.T) {
		m := discordbridge.Message{Content: "  hello from my phone  "}
		items := discordMessageToPayloads(m)
		if len(items) != 1 || items[0].Kind != dropzone.KindText || items[0].Text != "hello from my phone" {
			t.Errorf("unexpected items: %+v", items)
		}
	})

	t.Run("attachment-only message downloads and classifies the file", func(t *testing.T) {
		orig := discordDownloadAttachment
		discordDownloadAttachment = func(ctx context.Context, url string, maxBytes int64) ([]byte, error) {
			if url != "https://cdn.example/photo.png" {
				t.Errorf("unexpected url: %s", url)
			}
			return []byte("png-bytes"), nil
		}
		t.Cleanup(func() { discordDownloadAttachment = orig })

		m := discordbridge.Message{Attachments: []discordbridge.Attachment{
			{URL: "https://cdn.example/photo.png", Filename: "photo.png", ContentType: "image/png"},
		}}
		items := discordMessageToPayloads(m)
		if len(items) != 1 || items[0].Kind != dropzone.KindImage || string(items[0].Data) != "png-bytes" || items[0].Filename != "photo.png" {
			t.Errorf("unexpected items: %+v", items)
		}
	})

	t.Run("a caption plus a photo becomes two items", func(t *testing.T) {
		orig := discordDownloadAttachment
		discordDownloadAttachment = func(ctx context.Context, url string, maxBytes int64) ([]byte, error) {
			return []byte("data"), nil
		}
		t.Cleanup(func() { discordDownloadAttachment = orig })

		m := discordbridge.Message{
			Content:     "look at this",
			Attachments: []discordbridge.Attachment{{URL: "u", Filename: "f.png", ContentType: "image/png"}},
		}
		items := discordMessageToPayloads(m)
		if len(items) != 2 || items[0].Kind != dropzone.KindText || items[1].Kind != dropzone.KindImage {
			t.Errorf("unexpected items: %+v", items)
		}
	})

	t.Run("a failed download becomes an inline failure note instead of being dropped", func(t *testing.T) {
		orig := discordDownloadAttachment
		discordDownloadAttachment = func(ctx context.Context, url string, maxBytes int64) ([]byte, error) {
			return nil, os.ErrDeadlineExceeded
		}
		t.Cleanup(func() { discordDownloadAttachment = orig })

		m := discordbridge.Message{Attachments: []discordbridge.Attachment{{URL: "u", Filename: "f.png", ContentType: "image/png"}}}
		items := discordMessageToPayloads(m)
		if len(items) != 1 || items[0].Kind != dropzone.KindText || !strings.Contains(items[0].Text, "f.png") {
			t.Errorf("unexpected items: %+v", items)
		}
	})
}

func TestDiscordItemBody(t *testing.T) {
	t.Run("a photo that OCRs successfully returns the OCR text", func(t *testing.T) {
		stubMobileDropVision(t, "# Local OCR result", nil)
		p := dropzone.Payload{Kind: dropzone.KindImage, Filename: "a.png", Data: []byte("x")}
		got := discordItemBody(p, llm.VisionConfig{}, llm.VoiceConfig{}, t.TempDir())
		if got != "# Local OCR result" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("a photo that fails OCR is kept as a file under scrapDir/assets", func(t *testing.T) {
		visionErr, _ := notConfiguredErrors(t)
		stubMobileDropVision(t, "", visionErr)
		withFixedNow(t, mobileDropTestTime)
		scrapDir := t.TempDir()

		p := dropzone.Payload{Kind: dropzone.KindImage, Filename: "a.png", MimeType: "image/png", Data: []byte("x")}
		got := discordItemBody(p, llm.VisionConfig{}, llm.VoiceConfig{}, scrapDir)
		if !strings.Contains(got, "画像OCRをスキップし") || !strings.Contains(got, "assets") {
			t.Errorf("expected a kept-file fallback body, got %q", got)
		}
		if _, err := os.Stat(filepath.Join(scrapDir, "assets")); err != nil {
			t.Errorf("expected the photo to be saved under scrapDir/assets: %v", err)
		}
	})

	t.Run("plain text always passes through FormatTextBody", func(t *testing.T) {
		got := discordItemBody(dropzone.Payload{Kind: dropzone.KindText, Text: "hello"}, llm.VisionConfig{}, llm.VoiceConfig{}, t.TempDir())
		if got != "hello" {
			t.Errorf("got %q", got)
		}
	})
}

func TestFormatDiscordSection(t *testing.T) {
	at := time.Date(2026, 9, 22, 8, 15, 0, 0, time.UTC)

	got := formatDiscordSection(dropzone.KindText, "", "hello", at)
	if !strings.Contains(got, "## Discord [08:15:00]") || !strings.HasSuffix(got, "\n\nhello\n") {
		t.Errorf("unexpected section: %q", got)
	}

	withName := formatDiscordSection(dropzone.KindImage, "photo.png", "body", at)
	if !strings.Contains(withName, "## Discord [08:15:00] — photo.png") {
		t.Errorf("expected the filename in the header, got: %q", withName)
	}
}

func TestHandleDiscordMessage_AppendsToScrapWithoutTouchingAnOpenWindow(t *testing.T) {
	scrapDir := t.TempDir()
	app := &App{scrapDir: scrapDir} // a.w is nil: must not panic (the poller can fire with the window hidden/closed)

	app.handleDiscordMessageAt(discordbridge.Message{Content: "hello from my phone"}, llm.VisionConfig{}, llm.VoiceConfig{}, mobileDropTestTime)

	data, err := os.ReadFile(filepath.Join(scrapDir, "2026-09-20.md"))
	if err != nil {
		t.Fatalf("expected today's scrap file to exist: %v", err)
	}
	if !strings.Contains(string(data), "## Discord [10:05:09]") || !strings.Contains(string(data), "hello from my phone") {
		t.Errorf("unexpected scrap content: %s", data)
	}
}

func TestHandleDiscordMessage_NotifiesTheFrontendWithoutSwitchingTabs(t *testing.T) {
	mock := &voiceMockWebView{}
	app := &App{scrapDir: t.TempDir(), w: mock}

	app.handleDiscordMessage(discordbridge.Message{Content: "hi"}, llm.VisionConfig{}, llm.VoiceConfig{})

	eval := mock.waitFor(t, "onDiscordBridgeMessage", 2*time.Second)
	if strings.Contains(eval, "onScrapAppended") {
		t.Errorf("must dispatch its own event, not the CLI-pipe onScrapAppended that steals the active tab: %s", eval)
	}
}

// discordFakeServer serves just enough of the Discord REST surface for InitDiscordBridge's
// connect step (token check + DM channel + one empty message poll).
func discordFakeServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/users/@me", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(discordbridge.Self{ID: "bot-1", Username: "md-memo-bot"})
	})
	mux.HandleFunc("/users/@me/channels", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "chan-1"})
	})
	mux.HandleFunc("/channels/chan-1/messages", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]discordbridge.Message{})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func withIsolatedConfigDir(t *testing.T) string {
	t.Helper()
	prev, err := appdir.ConfigDir()
	if err != nil {
		t.Fatalf("appdir.ConfigDir: %v", err)
	}
	dir := t.TempDir()
	appdir.SetConfigDirOverride(dir)
	t.Cleanup(func() { appdir.SetConfigDirOverride(prev) })
	return dir
}

func TestInitDiscordBridge_DisabledConfigLeavesNoPollerRunning(t *testing.T) {
	withIsolatedConfigDir(t)
	app := &App{}

	if err := os.WriteFile(getConfigFilePath(), []byte(`{"discordBridge":{"enabled":false}}`), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	app.invalidateConfigCache()
	app.InitDiscordBridge()

	app.discordMu.Lock()
	defer app.discordMu.Unlock()
	if app.discordPoller != nil {
		t.Error("a disabled config must not leave a poller running")
	}
}

func TestInitDiscordBridge_EnabledConfigStartsAPollerAndReconfigStopsIt(t *testing.T) {
	withIsolatedConfigDir(t)
	srv := discordFakeServer(t)
	prevOverride := discordBridgeBaseURLOverride
	discordBridgeBaseURLOverride = srv.URL
	t.Cleanup(func() { discordBridgeBaseURLOverride = prevOverride })

	app := &App{}
	enabledCfg := `{"discordBridge":{"enabled":true,"botToken":"tok","allowedUserId":"710512141975556166","pollIntervalSeconds":15}}`
	if err := os.WriteFile(getConfigFilePath(), []byte(enabledCfg), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	app.invalidateConfigCache()
	app.InitDiscordBridge()

	app.discordMu.Lock()
	poller := app.discordPoller
	app.discordMu.Unlock()
	if poller == nil {
		t.Fatal("an enabled, complete config must start a poller")
	}

	// Re-initializing with the bridge disabled must stop the poller started above.
	if err := os.WriteFile(getConfigFilePath(), []byte(`{"discordBridge":{"enabled":false}}`), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	app.invalidateConfigCache()
	app.InitDiscordBridge()

	app.discordMu.Lock()
	defer app.discordMu.Unlock()
	if app.discordPoller != nil {
		t.Error("expected the poller to be stopped and cleared after disabling the bridge")
	}
}

func TestTestDiscordBridgeConnection(t *testing.T) {
	srv := discordFakeServer(t)

	t.Run("blank fields are rejected before any request", func(t *testing.T) {
		app := &App{}
		if _, err := app.TestDiscordBridgeConnection("", ""); err == nil {
			t.Error("expected an error for blank token/user id")
		}
	})

	t.Run("a valid token and user id succeed", func(t *testing.T) {
		orig := discordTestConnectionBaseURL
		discordTestConnectionBaseURL = srv.URL
		defer func() { discordTestConnectionBaseURL = orig }()

		app := &App{}
		got, err := app.TestDiscordBridgeConnection("tok", "710512141975556166")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got["botUsername"] != "md-memo-bot" {
			t.Errorf("unexpected result: %+v", got)
		}
	})
}
