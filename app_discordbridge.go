package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"md-memo/pkg/appdir"
	"md-memo/pkg/discordbridge"
	"md-memo/pkg/dropzone"
	"md-memo/pkg/llm"
	"md-memo/pkg/scrap"
)

// DiscordBridgeSettings models config.json's "discordBridge" section: an opt-in bridge that lets
// the one paired Discord account append to today's scrap file from anywhere, even while md-memo
// was closed, by polling the bot's own DM channel over plain HTTPS. There is no inbound port, no
// relay server, and no hosted infrastructure - the only account involved is the free Discord bot
// the user creates for themselves in the Discord Developer Portal.
type DiscordBridgeSettings struct {
	Enabled             bool
	BotToken            string
	AllowedUserID       string
	PollIntervalSeconds int
}

func (a *App) parseDiscordBridgeConfig(configJSON string) DiscordBridgeSettings {
	cfg := DiscordBridgeSettings{PollIntervalSeconds: 45}
	if configJSON == "" {
		return cfg
	}
	var raw struct {
		DiscordBridge struct {
			Enabled             bool   `json:"enabled"`
			BotToken            string `json:"botToken"`
			AllowedUserID       string `json:"allowedUserId"`
			PollIntervalSeconds int    `json:"pollIntervalSeconds"`
		} `json:"discordBridge"`
	}
	if json.Unmarshal([]byte(configJSON), &raw) != nil {
		return cfg
	}
	cfg.Enabled = raw.DiscordBridge.Enabled
	cfg.BotToken = strings.TrimSpace(raw.DiscordBridge.BotToken)
	cfg.AllowedUserID = strings.TrimSpace(raw.DiscordBridge.AllowedUserID)
	if raw.DiscordBridge.PollIntervalSeconds > 0 {
		cfg.PollIntervalSeconds = raw.DiscordBridge.PollIntervalSeconds
	}
	return cfg
}

// discordDropConfigs pulls the same vision/voice settings Mobile Drop uses, straight out of
// config.json. Unlike Mobile Drop (a bound method the frontend calls with these already
// serialized), the bridge's poller runs on its own in the Go backend and may fire while the
// window is hidden to the tray, so it cannot ask the frontend for them.
func discordDropConfigs(configJSON string) (llm.VisionConfig, llm.VoiceConfig) {
	var raw struct {
		Vision llm.VisionConfig `json:"vision"`
		Voice  llm.VoiceConfig  `json:"voice"`
	}
	_ = json.Unmarshal([]byte(configJSON), &raw)
	// Same credential fallback the Voice Input UI applies: voice settings without their own key
	// use the image OCR key.
	return raw.Vision, llm.ResolveVoiceConfig(raw.Voice, raw.Vision)
}

// discordDownloadAttachment is discordbridge.DownloadAttachment behind a variable so tests never
// reach the network, mirroring mobileDropQueryVision/mobileDropTranscribe in app_mobiledrop.go.
var discordDownloadAttachment = discordbridge.DownloadAttachment

// discordBridgeBaseURLOverride / discordTestConnectionBaseURL point the poller / the settings
// screen's connection test at a fake server in tests instead of the real Discord API; both are
// always "" (meaning the real API) in production.
var (
	discordBridgeBaseURLOverride string
	discordTestConnectionBaseURL string
)

func discordBridgeStatePath() string {
	dir, err := appdir.ConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "md-memo", "discord_bridge_state.json")
}

// InitDiscordBridge (re)starts the Discord poller to match the current config, or stops it when
// disabled or missing its token/allowed user id. Cheap to call repeatedly: SaveConfig only calls
// it when the discordBridge-relevant settings actually changed, the same guard already applied
// to InitScrapEngine/InitJevEngine.
func (a *App) InitDiscordBridge() {
	cfgStr, _ := a.GetConfig()
	s := a.parseDiscordBridgeConfig(cfgStr)

	a.discordMu.Lock()
	defer a.discordMu.Unlock()
	if a.discordPoller != nil {
		a.discordPoller.Stop()
		a.discordPoller = nil
	}
	if !s.Enabled || s.BotToken == "" || s.AllowedUserID == "" {
		return
	}

	visionCfg, voiceCfg := discordDropConfigs(cfgStr)
	poller := discordbridge.NewPoller(discordbridge.Config{
		BotToken:        s.BotToken,
		AllowedUserID:   s.AllowedUserID,
		IntervalSeconds: s.PollIntervalSeconds,
		BaseURL:         discordBridgeBaseURLOverride,
		StatePath:       discordBridgeStatePath(),
		OnMessage: func(m discordbridge.Message) {
			a.handleDiscordMessage(m, visionCfg, voiceCfg)
		},
		OnStatus: func(status, message string) {
			a.dispatchDiscordBridgeStatus(status, message)
		},
	})
	a.discordPoller = poller
	poller.Start(context.Background()) // non-blocking: connects and retries on its own goroutine
}

// TestDiscordBridgeConnection is bound to the settings screen's "接続テスト" button: it checks
// the token and DM channel synchronously, with its own short timeout, so a typo surfaces in a
// couple of seconds instead of only after Save (and the poller's own multi-second retry backoff).
func (a *App) TestDiscordBridgeConnection(botToken, allowedUserID string) (map[string]interface{}, error) {
	botToken = strings.TrimSpace(botToken)
	allowedUserID = strings.TrimSpace(allowedUserID)
	if botToken == "" || allowedUserID == "" {
		return nil, fmt.Errorf("Botトークンと連携先のDiscordユーザーIDを入力してください")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client := discordbridge.New(botToken)
	client.BaseURL = discordTestConnectionBaseURL
	self, err := client.VerifyToken(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := client.EnsureDMChannel(ctx, allowedUserID); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"botUsername": self.Username,
	}, nil
}

// handleDiscordMessage runs once per DM from the paired account. It reuses the exact same
// OCR/transcription pipeline Mobile Drop already uses for a photo or voice note (mobileDropItemBody
// / mobileDropKeepFile), then appends the result to today's scrap file instead of the active note
// - there usually is no "active note" for a message that may have arrived while the app was closed.
func (a *App) handleDiscordMessage(m discordbridge.Message, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig) {
	a.handleDiscordMessageAt(m, visionCfg, voiceCfg, time.Now())
}

// handleDiscordMessageAt is handleDiscordMessage with the timestamp injected, so tests can assert
// on a fixed "## Discord [HH:MM:SS]" header and a fixed scraps/YYYY-MM-DD.md file name instead of
// today's real date - the same split app_mobiledrop.go uses between handleMobileDropBatch and
// buildMobileDropBatchSection.
func (a *App) handleDiscordMessageAt(m discordbridge.Message, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig, at time.Time) {
	defer func() {
		if r := recover(); r != nil {
			a.dispatchDiscordBridgeStatus("error", fmt.Sprintf("メッセージの処理中にエラーが発生しました: %v", r))
		}
	}()

	scrapDir := a.GetScrapDir()

	var sb strings.Builder
	for _, p := range discordMessageToPayloads(m) {
		body := discordItemBody(p, visionCfg, voiceCfg, scrapDir)
		sb.WriteString(formatDiscordSection(p.Kind, p.Filename, body, at))
	}
	if sb.Len() == 0 {
		return
	}

	path, err := scrap.AppendRaw(scrapDir, sb.String(), at)
	if err != nil {
		a.dispatchDiscordBridgeStatus("error", "スクラップへの書き込みに失敗しました: "+err.Error())
		return
	}
	a.TriggerGitSync()
	a.dispatchDiscordBridgeMessage(path, at)
}

// discordMessageToPayloads turns one Discord message into the dropzone.Payload items Mobile
// Drop's own processing pipeline expects: its text content (if any) as one KindText item, plus
// one item per attachment. A message with a caption AND a photo becomes two items, each with its
// own "## Discord [HH:MM:SS]" section - simpler and more consistent than special-casing captions.
func discordMessageToPayloads(m discordbridge.Message) []dropzone.Payload {
	var items []dropzone.Payload
	if text := strings.TrimSpace(m.Content); text != "" {
		items = append(items, dropzone.Payload{Kind: dropzone.KindText, Text: text})
	}
	for _, att := range m.Attachments {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		data, err := discordDownloadAttachment(ctx, att.URL, discordbridge.DefaultMaxAttachmentBytes)
		cancel()
		if err != nil {
			items = append(items, dropzone.Payload{
				Kind: dropzone.KindText,
				Text: fmt.Sprintf("[Discord: 添付ファイル %s の取得に失敗しました: %s]", att.Filename, err.Error()),
			})
			continue
		}
		items = append(items, dropzone.Payload{
			Kind:     discordAttachmentKind(att.ContentType),
			Filename: att.Filename,
			MimeType: att.ContentType,
			Data:     data,
		})
	}
	return items
}

func discordAttachmentKind(contentType string) dropzone.Kind {
	ct := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	switch {
	case strings.HasPrefix(ct, "image/"):
		return dropzone.KindImage
	case strings.HasPrefix(ct, "audio/"), ct == "video/webm":
		return dropzone.KindAudio
	default:
		return dropzone.KindFile
	}
}

// discordItemBody processes one payload through Mobile Drop's existing pipeline (OCR for a
// photo, transcription for audio, decode-and-fence for a file, pass-through for text). A photo
// or voice note that could not be processed is kept as a file under scrapDir/assets exactly the
// way a Mobile Drop fallback is, via the very same mobileDropKeepFile.
func discordItemBody(p dropzone.Payload, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig, scrapDir string) string {
	body, err := mobileDropItemBody(p, visionCfg, voiceCfg)
	if err == nil {
		return body
	}
	if p.Kind == dropzone.KindImage || p.Kind == dropzone.KindAudio {
		if kept, saveErr := mobileDropKeepFile(p, err, scrapDir); saveErr == nil {
			return kept
		}
	}
	return fmt.Sprintf("[Discord: %sの処理に失敗しました: %s]", mobileDropItemLabel(p), err.Error())
}

// formatDiscordSection mirrors dropzone.FormatSection's shape ("## <source> [HH:MM:SS] — name")
// with "Discord" as the source label, kept as its own small function rather than adding a label
// parameter to the Mobile-Drop-specific dropzone package.
func formatDiscordSection(kind dropzone.Kind, filename, body string, at time.Time) string {
	header := fmt.Sprintf("## Discord [%s]", at.Format("15:04:05"))
	if name := discordSanitizeFilename(filename); name != "" {
		header = fmt.Sprintf("%s — %s", header, name)
	}
	return fmt.Sprintf("\n\n%s\n\n%s\n", header, strings.TrimRight(body, "\n"))
}

func discordSanitizeFilename(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:120])
	}
	return name
}

// dispatchDiscordBridgeStatus reports poller lifecycle/errors to a settings-screen indicator via
// window.onDiscordBridgeStatus, following the same isDestroyed-gated Dispatch+Eval pattern as
// every other async backend result (voice, OCR, Quick Actions, git sync).
func (a *App) dispatchDiscordBridgeStatus(status, message string) {
	if a.w == nil {
		return
	}
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			msgJSON, _ := json.Marshal(message)
			js := fmt.Sprintf("if (window.onDiscordBridgeStatus) { window.onDiscordBridgeStatus({status:%q, message:%s}); }", status, string(msgJSON))
			a.w.Eval(js)
		}
	})
}

// dispatchDiscordBridgeMessage notifies the frontend a scrap was appended from Discord. Kept
// separate from onScrapAppended (the CLI-pipe event) on purpose: that handler switches the
// active tab to the scrap file, which is right for "I just ran a command and want to see the
// result" but wrong for a message that can arrive at any moment in the background - it must
// never steal focus from whatever the user is currently editing.
func (a *App) dispatchDiscordBridgeMessage(filePath string, at time.Time) {
	if a.w == nil {
		return
	}
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			payload, _ := json.Marshal(map[string]interface{}{
				"filePath":  filePath,
				"fileName":  filepath.Base(filePath),
				"timestamp": at.Format("15:04:05"),
			})
			js := fmt.Sprintf("if (window.onDiscordBridgeMessage) { window.onDiscordBridgeMessage(%s); }", string(payload))
			a.w.Eval(js)
		}
	})
}
