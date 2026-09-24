package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"md-memo/pkg/components"
	"md-memo/pkg/dialog"
	"md-memo/pkg/llm"
	"md-memo/pkg/speech"
)

// The on-device speech engine is optional and downloaded on demand, so nothing here runs (or
// allocates beyond two small structs) until a transcription or the settings screen asks for it.
var (
	speechOnce sync.Once
	speechMgr  *components.Manager
	speechSvc  *speech.Service

	speechInstallMu sync.Mutex
	speechInstalls  = map[string]context.CancelFunc{}
)

// speechComponentsDir is per-machine, non-roaming data (a model is up to 1.5 GB), so it lives
// under the local cache directory rather than the roaming config directory.
func speechComponentsDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "md-memo", "components")
}

func speechInit() {
	speechOnce.Do(func() {
		speechMgr = components.NewManager(speechComponentsDir())
		speechSvc = speech.NewService(speechMgr)
	})
}

func speechService() *speech.Service {
	speechInit()
	return speechSvc
}

type speechPartView struct {
	Part   components.Part   `json:"part"`
	Status components.Status `json:"status"`
}

type speechStatusView struct {
	Supported    bool               `json:"supported"`
	StorageDir   string             `json:"storageDir"`
	DefaultModel string             `json:"defaultModel"`
	Runtime      *speechPartView    `json:"runtime"`
	Models       []speechPartView   `json:"models"`
	Custom       *speechPartView    `json:"custom"`
	Local        speech.LocalStatus `json:"local"`
}

func parseVoiceConfigJSON(voiceConfigJSON string) llm.VoiceConfig {
	var cfg llm.VoiceConfig
	if voiceConfigJSON != "" {
		_ = json.Unmarshal([]byte(voiceConfigJSON), &cfg)
	}
	return cfg
}

// GetSpeechStatus describes the on-device speech engine for the settings screen: the catalog with
// each part's install state, and whether the currently selected setup is ready to use.
func (a *App) GetSpeechStatus(voiceConfigJSON string) string {
	speechInit()
	cfg := parseVoiceConfigJSON(voiceConfigJSON)

	view := speechStatusView{
		StorageDir:   speechComponentsDir(),
		DefaultModel: speech.DefaultWhisperModelID(),
		Local:        speechSvc.LocalStatus(cfg),
	}
	if p, ok := speech.RuntimePart(); ok {
		view.Supported = true
		view.Runtime = &speechPartView{Part: p, Status: speechMgr.Status(p)}
	}
	_, models := speech.Catalog()
	for _, m := range models {
		view.Models = append(view.Models, speechPartView{Part: m, Status: speechMgr.Status(m)})
	}
	if cfg.Whisper.Model == "custom-url" {
		if p, ok := speech.ResolveModelPart(cfg.Whisper); ok {
			view.Custom = &speechPartView{Part: p, Status: speechMgr.Status(p)}
		}
	}

	out, _ := json.Marshal(view)
	return string(out)
}

func speechPartFor(which string, cfg llm.VoiceConfig) (components.Part, bool) {
	switch which {
	case "runtime":
		return speech.RuntimePart()
	case "model":
		return speech.ResolveModelPart(cfg.Whisper)
	}
	return components.Part{}, false
}

func (a *App) dispatchSpeechInstall(reqID, state string, done, total int64, message string) {
	reqJSON, _ := json.Marshal(reqID)
	stateJSON, _ := json.Marshal(state)
	msgJSON, _ := json.Marshal(message)
	js := fmt.Sprintf("if (window.__onSpeechInstall) { window.__onSpeechInstall(%s, %s, %d, %d, %s); }",
		string(reqJSON), string(stateJSON), done, total, string(msgJSON))
	a.dispatchEval(js)
}

// InstallSpeechPartAsync downloads one part ("runtime" or the selected "model") in the background
// and reports progress through window.__onSpeechInstall(reqID, state, done, total, message) with
// state "progress" | "done" | "error" | "canceled". It only ever runs because the user pressed a
// download button.
func (a *App) InstallSpeechPartAsync(reqID, which, voiceConfigJSON string) {
	speechInit()
	part, ok := speechPartFor(which, parseVoiceConfigJSON(voiceConfigJSON))
	if !ok {
		a.dispatchSpeechInstall(reqID, "error", 0, 0, "この項目はインストールできません(未対応のOS、またはモデルが選択されていません)")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	speechInstallMu.Lock()
	speechInstalls[reqID] = cancel
	speechInstallMu.Unlock()

	go func() {
		defer func() {
			speechInstallMu.Lock()
			delete(speechInstalls, reqID)
			speechInstallMu.Unlock()
			cancel()
			if r := recover(); r != nil {
				a.dispatchSpeechInstall(reqID, "error", 0, 0, fmt.Sprintf("内部エラー: %v", r))
			}
		}()

		err := speechMgr.Install(ctx, part, func(done, total int64) {
			a.dispatchSpeechInstall(reqID, "progress", done, total, "")
		})
		switch {
		case err == nil:
			a.dispatchSpeechInstall(reqID, "done", 0, 0, "")
		case errors.Is(err, context.Canceled):
			a.dispatchSpeechInstall(reqID, "canceled", 0, 0, "")
		default:
			a.dispatchSpeechInstall(reqID, "error", 0, 0, err.Error())
		}
	}()
}

// CancelSpeechInstall stops a running download; the partial file is kept so the next attempt resumes.
func (a *App) CancelSpeechInstall(reqID string) {
	speechInstallMu.Lock()
	cancel := speechInstalls[reqID]
	speechInstallMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// RemoveSpeechPart deletes one downloaded part and returns "" on success or an error message.
func (a *App) RemoveSpeechPart(which, voiceConfigJSON string) string {
	speechInit()
	part, ok := speechPartFor(which, parseVoiceConfigJSON(voiceConfigJSON))
	if !ok {
		return "この項目は削除できません"
	}
	if err := speechMgr.Remove(part.ID); err != nil {
		return err.Error()
	}
	return ""
}

// PickFilePath shows the native open-file dialog and returns only the chosen path ("" when
// cancelled). Unlike OpenFile it never reads the file, which matters for a multi-hundred-MB model.
func (a *App) PickFilePath(title string) (string, error) {
	return dialog.OpenFileDialog(title)
}

// ValidateWhisperModelFile checks a user-chosen model file and returns
// {"ok":bool,"multilingual":bool,"error":string} as JSON.
func (a *App) ValidateWhisperModelFile(path string) string {
	info, err := speech.ValidateModelFile(path)
	res := map[string]interface{}{"ok": err == nil, "multilingual": info.Multilingual, "error": ""}
	if err != nil {
		res["error"] = err.Error()
	}
	out, _ := json.Marshal(res)
	return string(out)
}
