package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"runtime"
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

// ollamaInstallPlan decides which command automatically installs Ollama for goos, given
// whether Homebrew is available (hasBrew is only consulted for "darwin"). It performs no I/O
// itself - no process execution, no filesystem or PATH lookups - so every platform/brew
// combination can be table-tested from any host, including this project's Windows dev/CI
// machines where the darwin and linux branches can never otherwise run.
//
// On darwin without Homebrew, err is returned instead of a command: the generic Linux
// installer (curl | sh against ollama.com/install.sh) exits with an error on macOS, so running
// it there produced a confusing shell failure instead of pointing the user at a real fix.
// Homebrew's cask is the only automated install path this app offers on macOS.
func ollamaInstallPlan(goos string, hasBrew bool) (name string, args []string, err error) {
	switch goos {
	case "darwin":
		if hasBrew {
			return "brew", []string{"install", "--cask", "ollama"}, nil
		}
		return "", nil, fmt.Errorf("Homebrew not found. Install Ollama from https://ollama.com/download, then try again.")
	case "windows":
		return "winget", []string{"install", "-e", "--id", "Ollama.Ollama", "--accept-source-agreements", "--accept-package-agreements"}, nil
	default: // linux and any other platform with a POSIX shell
		return "sh", []string{"-c", "curl -fsSL https://ollama.com/install.sh | sh"}, nil
	}
}

// ollamaStartCmdFor decides which command launches Ollama in the background for goos, given
// whether /Applications/Ollama.app exists (hasOllamaApp is only consulted for "darwin"). Like
// ollamaInstallPlan, it does no I/O itself so it can be table-tested on any host.
func ollamaStartCmdFor(goos string, hasOllamaApp bool) (name string, args []string) {
	if goos == "darwin" && hasOllamaApp {
		return "open", []string{"-a", "Ollama"}
	}
	return "sh", []string{"-c", "ollama serve >/dev/null 2>&1 &"}
}

// buildInstallOllamaCmd constructs the *exec.Cmd that installs Ollama automatically on this
// machine, or returns the error ollamaInstallPlan produced when there is no automated path
// (darwin without Homebrew). The winget invocation is still routed through cmd.exe /c, matching
// the command line getInstallOllamaCmdOS used to build for Windows before this refactor.
func buildInstallOllamaCmd(ctx context.Context) (*exec.Cmd, error) {
	hasBrew := false
	if runtime.GOOS == "darwin" {
		if _, lookErr := exec.LookPath("brew"); lookErr == nil {
			hasBrew = true
		}
	}
	name, args, err := ollamaInstallPlan(runtime.GOOS, hasBrew)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		return exec.CommandContext(ctx, "cmd.exe", "/c", strings.TrimSpace(name+" "+strings.Join(args, " "))), nil
	}
	return exec.CommandContext(ctx, name, args...), nil
}

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
			installCmd, planErr := buildInstallOllamaCmd(ctx)
			if planErr != nil {
				dispatch(2, "Ollamaのインストールに失敗しました", true, false, planErr.Error())
				return
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
	js := fmt.Sprintf("if (window.__onOllamaSetupProgress) { window.__onOllamaSetupProgress(%s); }", string(progJSON))
	a.dispatchEval(js)
}
