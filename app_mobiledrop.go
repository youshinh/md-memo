package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"md-memo/pkg/dropzone"
	"md-memo/pkg/encoding"
	"md-memo/pkg/llm"
	"md-memo/pkg/qrgen"
)

// mobileDropQueryVision is llm.QueryVision behind a variable so tests never reach the network.
var mobileDropQueryVision = llm.QueryVision

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
// submitted photo can be OCR'd without another round trip to the frontend.
func (a *App) StartMobileDrop(visionConfigJSON string) (*MobileDropInfo, error) {
	a.dropzoneMu.Lock()
	defer a.dropzoneMu.Unlock()
	if a.dropzoneServer != nil {
		return nil, errors.New("Mobile Dropは既に起動しています")
	}

	var visionCfg llm.VisionConfig
	_ = json.Unmarshal([]byte(visionConfigJSON), &visionCfg)

	var srv *dropzone.Server
	srv = dropzone.New(func(p dropzone.Payload) {
		a.handleMobileDropPayload(srv, p, visionCfg)
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

// handleMobileDropPayload runs once a phone submission passes validation. It turns the
// content into a markdown section (photos go through the same vision/OCR call as Ctrl+V) and
// hands it to the frontend to append to the end of the active note.
func (a *App) handleMobileDropPayload(srv *dropzone.Server, p dropzone.Payload, visionCfg llm.VisionConfig) {
	a.releaseMobileDrop(srv)

	if atomic.LoadInt32(&a.isDestroyed) != 0 {
		return
	}

	section, err := buildMobileDropSection(p, visionCfg, time.Now())
	if err != nil {
		a.dispatchMobileDropEvent("__onMobileDropError", map[string]string{"message": err.Error()})
		return
	}
	a.dispatchMobileDropEvent("__onMobileDropReceived", map[string]string{"content": section})
}

// buildMobileDropSection renders one submission as the markdown appended to the note.
func buildMobileDropSection(p dropzone.Payload, visionCfg llm.VisionConfig, at time.Time) (string, error) {
	var body string
	switch p.Kind {
	case dropzone.KindImage:
		markdown, err := mobileDropQueryVision(visionCfg.Prompt, base64.StdEncoding.EncodeToString(p.Data), p.MimeType, visionCfg)
		if err != nil {
			return "", err
		}
		body = dropzone.StripMarkdownFence(markdown)
	case dropzone.KindFile:
		// Phones send whatever encoding the file has; Japanese .txt files are often Shift_JIS.
		text, _, _ := encoding.DetectAndDecode(p.Data)
		body = dropzone.FormatFileBody(p.Filename, text)
	default: // KindText, KindURL
		body = dropzone.FormatTextBody(p.Text)
	}
	return dropzone.FormatSection(p.Kind, p.Filename, body, at), nil
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
