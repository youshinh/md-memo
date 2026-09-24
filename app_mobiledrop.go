package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"md-memo/pkg/dropzone"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
	"md-memo/pkg/qrgen"
)

// mobileDropQueryVision is llm.QueryVision behind a variable so tests never reach the network.
var mobileDropQueryVision = llm.QueryVision

// mobileDropTranscribe is the speech service behind a variable so tests never reach the network.
// Which engine runs follows cfg.Engine: a Mobile Drop config built by the frontend names none
// (Gemini), while the Discord bridge reads the user's engine choice from config.json.
var mobileDropTranscribe = func(audio []byte, mimeType string, cfg llm.VoiceConfig) (string, error) {
	return speechService().Transcribe(context.Background(), cfg, audio, mimeType)
}

// mobileDropNoteDir returns the folder of the note a drop is appended to, "" when it cannot be
// told. Go does not know the active note, so the default asks the frontend; tests stub it.
var mobileDropNoteDir = askFrontendNoteDir

const mobileDropNoteDirTimeout = 2 * time.Second

func askFrontendNoteDir(a *App) string {
	if a == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), mobileDropNoteDirTimeout)
	defer cancel()
	resJSON, err := a.CallJSWithResponse(ctx, "window.__mdMemoRPC && window.__mdMemoRPC.getNoteDir()")
	if err != nil {
		return ""
	}
	var dir string
	if json.Unmarshal([]byte(resJSON), &dir) != nil {
		return ""
	}
	return strings.TrimSpace(dir)
}

// mobileDropBatchConcurrency bounds how many items of one batch are processed (OCR'd/
// transcribed) at once: sequential would be slow for a handful of photos, unbounded would let
// a 10-item batch hammer the vision/voice API all at once.
const mobileDropBatchConcurrency = 3

// MobileDropInfo is returned to the frontend when the Mobile Drop QR-sync
// server starts, carrying everything the QR modal needs to render.
type MobileDropInfo struct {
	URL                string `json:"url"`
	QRDataURI          string `json:"qrDataUri,omitempty"`
	QRError            string `json:"qrError,omitempty"`
	IdleTimeoutSeconds int    `json:"idleTimeoutSeconds"`
}

// StartMobileDrop launches the ephemeral "Mobile Drop" QR-sync server: a phone on the same
// LAN can scan the returned QR code (or open the URL directly) to push a photo, a piece of
// text/URL, or a small file straight into the active note. The server accepts exactly one
// submission and then shuts itself down, or shuts down after IdleTimeoutSeconds of
// inactivity, or when CancelMobileDrop is called.
//
// visionConfigJSON is the current vision/OCR config (same shape as QueryVisionAsync's) so a
// submitted photo can be OCR'd without another round trip to the frontend. Kept as a
// one-argument method for compatibility; a voice recording sent through this entry point cannot
// be transcribed (there is no voice config), so it is kept as an audio file in assets instead.
// StartMobileDropWithVoice is what the frontend now calls.
func (a *App) StartMobileDrop(visionConfigJSON string) (*MobileDropInfo, error) {
	return a.startMobileDrop(visionConfigJSON, "")
}

// StartMobileDropWithVoice is StartMobileDrop plus a voice/transcription config (same shape as
// TranscribeAudioAsync's), so a voice recording dropped from the phone can be transcribed
// without a round trip to the frontend, the same way a photo is OCR'd.
func (a *App) StartMobileDropWithVoice(visionConfigJSON, voiceConfigJSON string) (*MobileDropInfo, error) {
	return a.startMobileDrop(visionConfigJSON, voiceConfigJSON)
}

func (a *App) startMobileDrop(visionConfigJSON, voiceConfigJSON string) (*MobileDropInfo, error) {
	a.dropzoneMu.Lock()
	defer a.dropzoneMu.Unlock()
	if a.dropzoneServer != nil {
		return nil, errors.New("Mobile Dropは既に起動しています")
	}

	var visionCfg llm.VisionConfig
	_ = json.Unmarshal([]byte(visionConfigJSON), &visionCfg)
	var voiceCfg llm.VoiceConfig
	_ = json.Unmarshal([]byte(voiceConfigJSON), &voiceCfg)

	var srv *dropzone.Server
	srv = dropzone.New(func(b dropzone.Batch) {
		a.handleMobileDropBatch(srv, b, visionCfg, voiceCfg)
	})
	srv.Encoder = qrgen.PNG
	srv.OnTimeout = func() {
		a.releaseMobileDrop(srv)
		a.dispatchMobileDropEvent("__onMobileDropTimeout", nil)
	}

	result, err := srv.Start()
	if err != nil {
		return nil, err
	}
	a.dropzoneServer = srv

	info := &MobileDropInfo{
		URL:                result.URL,
		QRError:            result.QRError,
		IdleTimeoutSeconds: int(result.IdleTimeout.Seconds()),
	}
	if len(result.QRPNG) > 0 {
		info.QRDataURI = "data:image/png;base64," + base64.StdEncoding.EncodeToString(result.QRPNG)
	}
	return info, nil
}

// SetMobileDropSharedText pushes text (the PC's current selection or clipboard) down to the
// phone's "text from PC" card. A no-op when no Mobile Drop session is running, since the phone
// has nothing to poll in that case.
func (a *App) SetMobileDropSharedText(text string) error {
	a.dropzoneMu.Lock()
	srv := a.dropzoneServer
	a.dropzoneMu.Unlock()
	if srv != nil {
		srv.SetSharedText(text)
	}
	return nil
}

// CancelMobileDrop stops the Mobile Drop server, e.g. because the user closed the QR modal
// without anyone sending anything. Safe to call when no server is running.
func (a *App) CancelMobileDrop() error {
	a.dropzoneMu.Lock()
	srv := a.dropzoneServer
	a.dropzoneServer = nil
	a.dropzoneMu.Unlock()
	if srv != nil {
		// Bound calls run on the UI thread and Stop waits for in-flight requests (up to 3s).
		go srv.Stop()
	}
	return nil
}

// RequestMobileDropTunnelAsync asks the running Mobile Drop server to expose itself through a
// Cloudflare Quick Tunnel, so a phone off the local network (mobile data, another Wi-Fi) can
// still reach it. It only ever runs in response to the user pressing the button in the QR
// modal: nothing leaves the LAN otherwise, and cloudflared is never downloaded or installed
// by this app. The result arrives via window.__onMobileDropTunnelReady /
// __onMobileDropTunnelError (no request id: only one Mobile Drop session exists at a time).
func (a *App) RequestMobileDropTunnelAsync() {
	go func() {
		a.dropzoneMu.Lock()
		srv := a.dropzoneServer
		a.dropzoneMu.Unlock()

		if srv == nil {
			a.dispatchMobileDropEvent("__onMobileDropTunnelError", map[string]string{
				"message": "Mobile Dropが起動していません。もう一度QRコードを表示してください。",
			})
			return
		}

		pairingURL, err := srv.StartTunnel()
		if err != nil {
			a.dispatchMobileDropEvent("__onMobileDropTunnelError", tunnelErrorPayload(err))
			return
		}

		info := MobileDropInfo{
			URL:                pairingURL,
			IdleTimeoutSeconds: int(dropzone.DefaultTunnelTimeout.Seconds()),
		}
		if png, qrErr := qrgen.PNG(pairingURL); qrErr == nil {
			info.QRDataURI = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
		} else {
			info.QRError = qrErr.Error()
		}
		a.dispatchMobileDropEvent("__onMobileDropTunnelReady", info)
	}()
}

// tunnelErrorPayload is what the frontend receives for a failed tunnel switch. When cloudflared
// is simply not installed it carries a code and the OS-specific install command, so the modal
// can offer a Copy button (and word the message in the UI language) instead of a wall of text.
func tunnelErrorPayload(err error) map[string]string {
	payload := map[string]string{"message": tunnelErrorMessage(err)}
	if errors.Is(err, dropzone.ErrCloudflaredNotFound) {
		payload["code"] = "cloudflared_missing"
		payload["installCommand"] = dropzone.CloudflaredInstallHint()
	}
	return payload
}

// tunnelErrorMessage turns a dropzone tunnel error into a friendly, actionable message,
// including an OS-specific install hint when cloudflared itself is the problem.
func tunnelErrorMessage(err error) string {
	if errors.Is(err, dropzone.ErrCloudflaredNotFound) {
		return fmt.Sprintf("cloudflaredが見つかりません。次のコマンドでインストールしてください: %s", dropzone.CloudflaredInstallHint())
	}
	return fmt.Sprintf("外部ネットワークへの切り替えに失敗しました: %v", err)
}

// releaseMobileDrop forgets srv as the active session, but only if it still is: a session that
// was cancelled and then replaced must not clear its successor.
func (a *App) releaseMobileDrop(srv *dropzone.Server) {
	a.dropzoneMu.Lock()
	if a.dropzoneServer == srv {
		a.dropzoneServer = nil
	}
	a.dropzoneMu.Unlock()
}

// handleMobileDropBatch runs once a phone submission passes validation. It builds ONE markdown
// insertion for the whole batch (photos go through the same vision/OCR call as Ctrl+V, audio
// through transcription) and hands it to the frontend to append to the end of the active note.
// A photo or voice note that could not be OCR'd/transcribed is kept as a file in assets instead
// (fallbackCount tells the frontend how many); an item that cannot even be saved carries an
// inline failure note. Either way the rest of the batch is unaffected.
func (a *App) handleMobileDropBatch(srv *dropzone.Server, b dropzone.Batch, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig) {
	a.releaseMobileDrop(srv)

	if atomic.LoadInt32(&a.isDestroyed) != 0 {
		return
	}

	content, fallbackCount := buildMobileDropBatchSection(b, visionCfg, voiceCfg, time.Now(), func() string { return mobileDropNoteDir(a) })
	a.dispatchMobileDropEvent("__onMobileDropReceived", map[string]interface{}{
		"content":       content,
		"fallbackCount": fallbackCount,
	})
}

// buildMobileDropSection renders one submission as the markdown appended to the note. Kept
// standalone (rather than folded into the batch builder) so the existing single-item behavior
// and its tests are unaffected; buildMobileDropBatchSection calls the same per-item logic.
func buildMobileDropSection(p dropzone.Payload, visionCfg llm.VisionConfig, at time.Time) (string, error) {
	body, err := mobileDropItemBody(p, visionCfg, llm.VoiceConfig{})
	if err != nil {
		return "", err
	}
	return dropzone.FormatSection(p.Kind, p.Filename, body, at, nil), nil
}

// buildMobileDropBatchSection renders every item of a batch into one insertion: each item gets
// its own "## Mobile Drop [HH:MM:SS]" header (simplest to read back in a note and to keep in
// sync with the single-item format above), but only the FIRST item carries the geo suffix,
// since the whole batch shares one location fix. Items are processed with bounded concurrency
// (OCR/transcription can be slow) while their order in the resulting text always matches the
// order they were sent in.
//
// A photo or voice note whose OCR/transcription fails for any reason is not lost: it is saved
// to assets (next to the note, see noteDir; nil or "" means the app data folder) and its body
// links to the file with a note saying why. Those saves run one at a time in item order after
// the concurrent phase, so the timestamp names follow the order the items were sent in. noteDir
// is only called when some item needs saving. The second result counts the items kept this way.
func buildMobileDropBatchSection(b dropzone.Batch, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig, at time.Time, noteDir func() string) (string, int) {
	bodies := make([]string, len(b.Items))
	errs := make([]error, len(b.Items))

	sem := make(chan struct{}, mobileDropBatchConcurrency)
	var wg sync.WaitGroup
	for i, item := range b.Items {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, item dropzone.Payload) {
			defer wg.Done()
			defer func() { <-sem }()
			bodies[i], errs[i] = mobileDropItemBody(item, visionCfg, voiceCfg)
		}(i, item)
	}
	wg.Wait()

	dir := sync.OnceValue(func() string {
		if noteDir == nil {
			return ""
		}
		return noteDir()
	})
	fallbackCount := 0
	for i, item := range b.Items {
		if errs[i] == nil {
			continue
		}
		if item.Kind == dropzone.KindImage || item.Kind == dropzone.KindAudio {
			kept, saveErr := mobileDropKeepFile(item, errs[i], dir())
			if saveErr == nil {
				bodies[i] = kept
				fallbackCount++
				continue
			}
			errs[i] = fmt.Errorf("%w (assetsへの保存にも失敗しました: %s)", errs[i], saveErr.Error())
		}
		bodies[i] = fmt.Sprintf("[Mobile Drop: %sの処理に失敗しました: %s]", mobileDropItemLabel(item), errs[i].Error())
	}

	var sb strings.Builder
	for i, item := range b.Items {
		var geo *dropzone.Geo
		if i == 0 {
			geo = b.Geo
		}
		sb.WriteString(dropzone.FormatSection(item.Kind, item.Filename, bodies[i], at, geo))
	}
	return sb.String(), fallbackCount
}

// mobileDropKeepFile saves a photo/voice note that could not be turned into text (cause says
// why) the way Ctrl+Shift+V saves a pasted image: <noteDir>/assets/YYYY-MM-DD-HHmmss.<ext> with
// a relative link, or the app data folder with a file:// link when noteDir is empty. The
// returned body is the link plus a one-line note; an error means the file could not be saved.
func mobileDropKeepFile(p dropzone.Payload, cause error, noteDir string) (string, error) {
	res, err := writeTimestampedAsset(noteDir, mobileDropAssetExt(p), p.Data)
	if err != nil {
		return "", err
	}
	link := res.RelPath
	if link == "" {
		link = res.FileURL
	}
	label := mobileDropLinkLabel(p)
	reason := strings.Join(strings.Fields(cause.Error()), " ")

	if p.Kind == dropzone.KindAudio {
		note := "文字起こしに失敗したため、音声として保存しました: " + reason
		if errors.Is(cause, llm.ErrNotConfigured) {
			note = "文字起こしをスキップし、音声として保存しました: " + reason + " (設定 → AIモデル → 音声入力)"
		}
		return fmt.Sprintf("[%s](%s)\n> %s", label, link, note), nil
	}
	note := "画像OCRに失敗したため、画像として保存しました: " + reason
	if errors.Is(cause, llm.ErrNotConfigured) {
		note = "画像OCRをスキップし、画像として保存しました: " + reason + " (設定 → AIモデル → 画像解析)"
	}
	return fmt.Sprintf("![%s](%s)\n> %s", label, link, note), nil
}

// mobileDropLinkLabel is the original file name as markdown link text (brackets and
// backslashes escaped, control characters flattened); a nameless upload gets a generic word.
func mobileDropLinkLabel(p dropzone.Payload) string {
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, p.Filename))
	if name == "" {
		if p.Kind == dropzone.KindAudio {
			return "audio"
		}
		return "image"
	}
	return strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`).Replace(name)
}

// mobileDropAssetExt is the file extension a kept photo/voice note is saved with: taken from the
// MIME type the server sniffed, else from the uploaded file name, else "bin".
func mobileDropAssetExt(p dropzone.Payload) string {
	switch strings.ToLower(strings.TrimSpace(strings.SplitN(p.MimeType, ";", 2)[0])) {
	case "image/png":
		return "png"
	case "image/jpeg", "image/jpg", "image/pjpeg":
		return "jpg"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	case "image/bmp":
		return "bmp"
	case "image/heic":
		return "heic"
	case "image/heif":
		return "heif"
	case "audio/webm", "video/webm":
		return "webm"
	case "audio/ogg", "application/ogg":
		return "ogg"
	case "audio/opus":
		return "opus"
	case "audio/mpeg", "audio/mp3":
		return "mp3"
	case "audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave":
		return "wav"
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		return "m4a"
	case "audio/aac", "audio/x-aac":
		return "aac"
	case "audio/flac", "audio/x-flac":
		return "flac"
	case "audio/aiff", "audio/x-aiff":
		return "aiff"
	}
	if idx := strings.LastIndex(p.Filename, "."); idx >= 0 {
		ext := strings.ToLower(p.Filename[idx+1:])
		if n := len(ext); n >= 1 && n <= 5 && strings.Trim(ext, "abcdefghijklmnopqrstuvwxyz0123456789") == "" {
			return ext
		}
	}
	return "bin"
}

// mobileDropItemLabel identifies one batch item in an inline failure note: its filename when it
// has one (a photo or a voice recording), otherwise its kind (typed text has neither).
func mobileDropItemLabel(p dropzone.Payload) string {
	if p.Filename != "" {
		return p.Filename
	}
	return string(p.Kind)
}

// mobileDropItemBody produces the processed content for one item, regardless of whether it
// arrived alone (legacy /upload, /upload-text) or as part of a batch.
func mobileDropItemBody(p dropzone.Payload, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig) (string, error) {
	switch p.Kind {
	case dropzone.KindImage:
		markdown, err := mobileDropQueryVision(visionCfg.Prompt, base64.StdEncoding.EncodeToString(p.Data), p.MimeType, visionCfg)
		if err != nil {
			return "", err
		}
		return dropzone.StripMarkdownFence(markdown), nil
	case dropzone.KindAudio:
		text, err := mobileDropTranscribe(p.Data, p.MimeType, voiceCfg)
		if err != nil {
			return "", err
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return "", errors.New("文字起こし結果が空でした")
		}
		return text, nil
	case dropzone.KindFile:
		// Phones send whatever encoding the file has; Japanese .txt files are often Shift_JIS.
		text, _, _ := encoding.DetectAndDecode(p.Data)
		return dropzone.FormatFileBody(p.Filename, text), nil
	default: // KindText, KindURL
		return dropzone.FormatTextBody(p.Text), nil
	}
}

// dispatchMobileDropEvent marshals data (which may be nil) to JSON and invokes
// window.<fnName>(...) in the frontend, following the same Dispatch+Eval pattern as the other
// *Async backend methods.
func (a *App) dispatchMobileDropEvent(fnName string, data interface{}) {
	payloadJSON, err := json.Marshal(data)
	if err != nil {
		payloadJSON = []byte("null")
	}
	a.dispatchEval(fmt.Sprintf("if (window.%s) { window.%s(%s); }", fnName, fnName, string(payloadJSON)))
}
