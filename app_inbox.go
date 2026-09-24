package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"md-memo/pkg/inbox"
	"md-memo/pkg/llm"
	"md-memo/pkg/ocr"
	"md-memo/pkg/scrap"
)

// InboxSettings is config.json's "inbox" key: hot-folder processing is opt-in (off by default)
// since it moves files on disk and, for audio and for OCR when the on-device engine is
// unavailable, sends their contents to whichever cloud model the vision/voice settings name.
type InboxSettings struct {
	Enabled bool   `json:"enabled"`
	Dir     string `json:"dir"`
}

func (a *App) parseInboxConfig(configJSON string) InboxSettings {
	var raw struct {
		Inbox InboxSettings `json:"inbox"`
	}
	if configJSON != "" {
		_ = json.Unmarshal([]byte(configJSON), &raw)
	}
	return raw.Inbox
}

func inboxVisionVoiceConfigs(configJSON string) (llm.VisionConfig, llm.VoiceConfig) {
	var raw struct {
		Vision llm.VisionConfig `json:"vision"`
		Voice  llm.VoiceConfig  `json:"voice"`
	}
	_ = json.Unmarshal([]byte(configJSON), &raw)
	// The voice settings have no credentials of their own by default (the Settings screen says
	// "uses the API key from the image OCR settings"), so fill them in from vision exactly as the
	// Voice Input UI does; without this every dropped audio file failed with "API Key not set".
	return raw.Vision, llm.ResolveVoiceConfig(raw.Voice, raw.Vision)
}

// resolveInboxDir mirrors scrap.ResolveScrapDir's ~ expansion, defaulting to a sibling of the
// default scrap dir rather than an empty-string special case, since "" here means "not
// configured yet" rather than "use the current directory".
func resolveInboxDir(dir string) string {
	if dir == "" {
		dir = "~/Documents/md-memo/inbox"
	}
	return scrap.ResolveScrapDir(dir)
}

// inboxRecognize and inboxTranscribe are ocr.Recognize / the speech service behind variables so
// tests never reach a real OCR engine, model or the network, mirroring mobileDropQueryVision /
// mobileDropTranscribe in app_mobiledrop.go. Transcription takes a path, not bytes, so the local
// engine can stream a long recording from disk instead of loading it into memory.
var (
	inboxRecognize  = ocr.Recognize
	inboxTranscribe = func(path, mimeType string, cfg llm.VoiceConfig) (string, error) {
		return speechService().TranscribeFile(context.Background(), cfg, path, mimeType)
	}
)

// failureNote turns an error into the short reason appended to a "could not process" note, so a
// misconfiguration (a missing API key, an engine that is not installed) is visible in the note
// instead of a bare "failed".
func failureNote(err error) string {
	if err == nil {
		return ""
	}
	msg := strings.Join(strings.Fields(err.Error()), " ")
	if r := []rune(msg); len(r) > 200 {
		msg = string(r[:200]) + "…"
	}
	return ": " + msg
}

// inboxOCRTimeout covers both engines: the cloud attempt (capped at 30 s inside ocr.Recognize)
// and, if it fails, the on-device fallback that follows.
const inboxOCRTimeout = 60 * time.Second

// InitInboxWatcher reads config.json's "inbox" settings and (re)starts the hot-folder watcher.
// Called at startup and again whenever settings are saved (mirroring InitDiscordBridge): any
// previously running watcher is stopped first, so re-saving with a new directory or disabling
// it takes effect immediately without a restart.
func (a *App) InitInboxWatcher() {
	cfgStr, _ := a.GetConfig()
	s := a.parseInboxConfig(cfgStr)

	a.inboxMu.Lock()
	defer a.inboxMu.Unlock()
	if a.inboxWatcher != nil {
		_ = a.inboxWatcher.Close()
		a.inboxWatcher = nil
	}
	if !s.Enabled {
		return
	}

	dir := resolveInboxDir(s.Dir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}

	// The vision/voice settings are read when each file is handled, not captured here, so a changed
	// API key or OCR mode applies to the very next file without re-saving the inbox settings.
	w, err := inbox.NewWatcher(dir, inbox.Handlers{
		OnImage: func(path string) {
			cfgNow, _ := a.GetConfig()
			visionCfg, _ := inboxVisionVoiceConfigs(cfgNow)
			a.handleInboxImage(path, visionCfg)
		},
		OnAudio: func(path string) {
			cfgNow, _ := a.GetConfig()
			_, voiceCfg := inboxVisionVoiceConfigs(cfgNow)
			a.handleInboxAudio(path, voiceCfg)
		},
	}, 0)
	if err != nil {
		return
	}
	a.inboxWatcher = w
}

// StopInboxWatcher stops the hot-folder watcher, if one is running. Called on app shutdown.
func (a *App) StopInboxWatcher() {
	a.inboxMu.Lock()
	defer a.inboxMu.Unlock()
	if a.inboxWatcher != nil {
		_ = a.inboxWatcher.Close()
		a.inboxWatcher = nil
	}
}

// handleInboxImage and handleInboxAudio run on the watcher's own goroutine, well after the
// hotkey/CLI paths that share ocr.Recognize returned control to their caller; a panic here must
// not take the whole process down.
func (a *App) handleInboxImage(path string, visionCfg llm.VisionConfig) {
	defer func() { _ = recover() }()

	ctx, cancel := context.WithTimeout(context.Background(), inboxOCRTimeout)
	defer cancel()
	text, err := inboxRecognize(ctx, path, visionCfg)

	scrapDir := a.GetScrapDir()
	assetRef := moveInboxFileToAssets(path, scrapDir)

	var body string
	if err != nil || strings.TrimSpace(text) == "" {
		body = "> (OCRでテキストを抽出できませんでした" + failureNote(err) + ")\n"
	} else {
		body = ocr.FormatEntry(text)
	}
	if assetRef != "" {
		body += "\n![" + filepath.Base(path) + "](" + assetRef + ")\n"
	}

	a.appendInboxEntry(scrapDir, body)
}

func (a *App) handleInboxAudio(path string, voiceCfg llm.VoiceConfig) {
	defer func() { _ = recover() }()

	scrapDir := a.GetScrapDir()
	if _, err := os.Stat(path); err != nil {
		return
	}

	text, transcribeErr := inboxTranscribe(path, audioMimeTypeForExt(filepath.Ext(path)), voiceCfg)
	assetRef := moveInboxFileToAssets(path, scrapDir)

	var body string
	if transcribeErr != nil || strings.TrimSpace(text) == "" {
		body = "> (文字起こしに失敗しました" + failureNote(transcribeErr) + ")\n"
	} else {
		body = ocr.FormatEntry(strings.TrimSpace(text))
	}
	if assetRef != "" {
		body += "\n[" + filepath.Base(path) + "](" + assetRef + ")\n"
	}

	a.appendInboxEntry(scrapDir, fmt.Sprintf("**[%s]**\n%s", time.Now().Format("15:04:05"), body))
}

func audioMimeTypeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".wav":
		return "audio/wav"
	case ".m4a":
		return "audio/mp4"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	default:
		return "audio/mpeg"
	}
}

// moveInboxFileToAssets relocates a processed inbox file to <scrapDir>/assets so it is never
// silently lost (a failed OCR/transcription still keeps the original, matching Mobile Drop's
// same guarantee) and the inbox folder does not accumulate already-handled files forever.
// Returns a note-relative reference ("./assets/...") for embedding, or "" if the move failed.
func moveInboxFileToAssets(srcPath, scrapDir string) string {
	assetsDir := filepath.Join(scrapDir, "assets")
	if err := os.MkdirAll(assetsDir, 0755); err != nil {
		return ""
	}
	name := time.Now().Format("2006-01-02-150405") + "-" + filepath.Base(srcPath)
	dest := filepath.Join(assetsDir, name)
	if err := os.Rename(srcPath, dest); err != nil {
		return ""
	}
	return "./assets/" + name
}

// appendInboxEntry writes body to today's scrap file verbatim (it is already Markdown, not raw
// CLI output) and notifies the WebView exactly like AppendDailyScrap does, so an open note view
// reacts to an inbox drop the same way it would to any other append.
func (a *App) appendInboxEntry(scrapDir, body string) {
	now := time.Now()
	filePath, err := scrap.AppendRaw(scrapDir, body, now)
	if err != nil {
		return
	}

	a.TriggerGitSync()

	if a.w != nil {
		a.w.Dispatch(func() {
			if atomic.LoadInt32(&a.isDestroyed) == 0 {
				payload, _ := json.Marshal(map[string]interface{}{
					"filePath":  filePath,
					"fileName":  filepath.Base(filePath),
					"date":      now.Format("2006-01-02"),
					"timestamp": now.Format("15:04:05"),
					"content":   body,
					"command":   "inbox",
					"cwd":       "",
				})
				js := fmt.Sprintf("if (window.onScrapAppended) { window.onScrapAppended(%s); }", string(payload))
				a.w.Eval(js)
			}
		})
	}
}
