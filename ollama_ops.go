package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/llm"
)

// OllamaSetupProgress represents a progress event dispatched during automated Ollama setup.
type OllamaSetupProgress struct {
	ReqID   string `json:"reqId"`
	Step    int    `json:"step"`    // 1: Check, 2: Install, 3: Launch, 4: Pull Model, 5: Done
	Total   int    `json:"total"`   // 5
	Message string `json:"message"`
	IsDone  bool   `json:"isDone"`
	Success bool   `json:"success"`
	Error   string `json:"error"`
}

var ollamaCancels sync.Map

// Indirection over the OS-level start/stop so tests can stub them: the real implementations
// launch and force-kill Ollama on this machine.
var (
	startOllamaService = startOllamaServiceOS
	stopOllamaService  = stopOllamaServiceOS
)

// CheckOllamaRunning returns true if the local Ollama instance is currently running and healthy.
func (a *App) CheckOllamaRunning() bool {
	return llm.CheckOllamaHealth("")
}

// StartOllamaService attempts to launch the Ollama background daemon or app.
func (a *App) StartOllamaService() error {
	return startOllamaService()
}

// StopOllamaService terminates running Ollama background processes to immediately free system memory.
func (a *App) StopOllamaService() error {
	return stopOllamaService()
}

// EnsureOllamaRunning checks if Ollama is running; if not, attempts to start it and polls until healthy.
func (a *App) EnsureOllamaRunning(timeout time.Duration) error {
	if llm.CheckOllamaHealth("") {
		return nil
	}

	if err := startOllamaService(); err != nil {
		return fmt.Errorf("Ollamaサービスの起動に失敗しました: %w", err)
	}

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		if llm.CheckOllamaHealth("") {
			return nil
		}
	}

	return fmt.Errorf("Ollamaサービスの起動待機がタイムアウトしました (%v)", timeout)
}

// SetupOllamaGemma4Async automates the entire installation, startup, and model download for Ollama + Gemma 4 E2B.
func (a *App) SetupOllamaGemma4Async(reqID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		ollamaCancels.Store(reqID, cancel)
		defer func() {
			cancel()
			ollamaCancels.Delete(reqID)
		}()

		dispatch := func(step int, message string, isDone, success bool, errMsg string) {
			a.dispatchOllamaSetupProgress(&OllamaSetupProgress{
				ReqID:   reqID,
				Step:    step,
				Total:   5,
				Message: message,
				IsDone:  isDone,
				Success: success,
				Error:   errMsg,
			})
		}

		// Step 1: Check if Ollama CLI is installed
		dispatch(1, "Ollamaのインストール状況を確認しています...", false, false, "")
		hasOllama := false
		if _, err := exec.LookPath("ollama"); err == nil {
			hasOllama = true
		} else {
			// Double check via command execution
			checkCmd := exec.CommandContext(ctx, "ollama", "--version")
			setCmdWindowFlags(checkCmd)
			if err := checkCmd.Run(); err == nil {
				hasOllama = true
			}
		}

		// Step 2: Install Ollama if not present
		if !hasOllama {
			dispatch(2, "Ollamaを自動インストールしています (数分かかる場合があります)...", false, false, "")
			installCmdStr := getInstallOllamaCmdOS()
			var installCmd *exec.Cmd
			if strings.HasPrefix(installCmdStr, "winget") {
				installCmd = exec.CommandContext(ctx, "cmd.exe", "/c", installCmdStr)
			} else {
				installCmd = exec.CommandContext(ctx, "sh", "-c", installCmdStr)
			}
			setCmdWindowFlags(installCmd)
			setupCmdProcessTreeKill(installCmd)

			if out, err := installCmd.CombinedOutput(); err != nil {
				dispatch(2, "Ollamaのインストールに失敗しました", true, false, fmt.Sprintf("%v: %s", err, string(out)))
				return
			}
		} else {
			dispatch(2, "Ollamaはすでにインストールされています", false, false, "")
		}

		// Step 3: Ensure Ollama Service is running
		dispatch(3, "Ollamaサービスを起動・ヘルスチェックしています...", false, false, "")
		if err := a.EnsureOllamaRunning(25 * time.Second); err != nil {
			dispatch(3, "Ollamaサービスの起動に失敗しました", true, false, err.Error())
			return
		}

		// Step 4: Pull Gemma 4 E2B model
		dispatch(4, "Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...", false, false, "")
		pullCmd := exec.CommandContext(ctx, "ollama", "pull", "gemma4:e2b")
		setCmdWindowFlags(pullCmd)
		setupCmdProcessTreeKill(pullCmd)

		if out, err := pullCmd.CombinedOutput(); err != nil {
			dispatch(4, "Gemma 4 E2B モデルのダウンロードに失敗しました", true, false, fmt.Sprintf("%v: %s", err, string(out)))
			return
		}

		// Step 5: Finished successfully
		dispatch(5, "Ollama & Gemma 4 E2B のセットアップが完了しました！", true, true, "")
	}()
}

// CancelOllamaSetup cancels an ongoing setup operation.
func (a *App) CancelOllamaSetup(reqID string) {
	if val, ok := ollamaCancels.Load(reqID); ok {
		if cancel, ok := val.(context.CancelFunc); ok {
			cancel()
		}
		ollamaCancels.Delete(reqID)
	}
}

func (a *App) dispatchOllamaSetupProgress(progress *OllamaSetupProgress) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	progJSON, _ := json.Marshal(progress)
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			js := fmt.Sprintf("if (window.__onOllamaSetupProgress) { window.__onOllamaSetupProgress(%s); }", string(progJSON))
			a.w.Eval(js)
		}
	})
}
