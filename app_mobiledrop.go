package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/dropzone"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
	"md-memo/pkg/qrgen"
)

// mobileDropQueryVision is llm.QueryVision behind a variable so tests never reach the network.
var mobileDropQueryVision = llm.QueryVision

// mobileDropTranscribe is llm.QueryAudio behind a variable so tests never reach the network.
var mobileDropTranscribe = func(audio []byte, mimeType string, cfg llm.VoiceConfig) (string, error) {
	return llm.QueryAudio(cfg.Prompt, base64.StdEncoding.EncodeToString(audio), mimeType, cfg)
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
// one-argument method for compatibility; a batch containing a voice recording sent through
// this entry point reports a per-item transcription failure, since there is no voice config to
// transcribe it with. StartMobileDropWithVoice is what the frontend now calls.
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
// One item failing does not lose the rest: its section carries an inline failure note instead.
func (a *App) handleMobileDropBatch(srv *dropzone.Server, b dropzone.Batch, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig) {
	a.releaseMobileDrop(srv)

	if atomic.LoadInt32(&a.isDestroyed) != 0 {
		return
	}

	content := buildMobileDropBatchSection(b, visionCfg, voiceCfg, time.Now())
	a.dispatchMobileDropEvent("__onMobileDropReceived", map[string]string{"content": content})
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
func buildMobileDropBatchSection(b dropzone.Batch, visionCfg llm.VisionConfig, voiceCfg llm.VoiceConfig, at time.Time) string {
	bodies := make([]string, len(b.Items))

	sem := make(chan struct{}, mobileDropBatchConcurrency)
	var wg sync.WaitGroup
	for i, item := range b.Items {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, item dropzone.Payload) {
			defer wg.Done()
			defer func() { <-sem }()
			body, err := mobileDropItemBody(item, visionCfg, voiceCfg)
			if err != nil {
				body = fmt.Sprintf("[Mobile Drop: %sの処理に失敗しました: %s]", mobileDropItemLabel(item), err.Error())
			}
			bodies[i] = body
		}(i, item)
	}
	wg.Wait()

	var sb strings.Builder
	for i, item := range b.Items {
		var geo *dropzone.Geo
		if i == 0 {
			geo = b.Geo
		}
		sb.WriteString(dropzone.FormatSection(item.Kind, item.Filename, bodies[i], at, geo))
	}
	return sb.String()
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
		return strings.TrimSpace(text), nil
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
	if a.w == nil {
		return
	}
	payloadJSON, err := json.Marshal(data)
	if err != nil {
		payloadJSON = []byte("null")
	}
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			a.w.Eval(fmt.Sprintf("if (window.%s) { window.%s(%s); }", fnName, fnName, string(payloadJSON)))
		}
	})
}
