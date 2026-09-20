//go:build !windows

package main

import (
	"os"
	"os/exec"
	"runtime"

	"md-memo/pkg/procutil"
)

// setCmdWindowFlags is a no-op on Unix platforms.
func setCmdWindowFlags(cmd *exec.Cmd) {
	procutil.HideWindow(cmd)
}

// getInstallOllamaCmdOS returns the platform-specific command to install Ollama.
func getInstallOllamaCmdOS() string {
	if runtime.GOOS == "darwin" {
		// Prefer Homebrew cask if available
		if _, err := exec.LookPath("brew"); err == nil {
			return "brew install --cask ollama"
		}
		return "curl -fsSL https://ollama.com/install.sh | sh"
	}
	// Linux / other
	return "curl -fsSL https://ollama.com/install.sh | sh"
}

// startOllamaServiceOS attempts to start Ollama in the background on macOS/Linux.
func startOllamaServiceOS() error {
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/Applications/Ollama.app"); err == nil {
			cmd := exec.Command("open", "-a", "Ollama")
			return cmd.Start()
		}
	}
	cmd := exec.Command("sh", "-c", "ollama serve >/dev/null 2>&1 &")
	return cmd.Start()
}

// stopOllamaServiceOS terminates running Ollama background processes on macOS/Linux.
func stopOllamaServiceOS() error {
	if runtime.GOOS == "darwin" {
		cmdApp := exec.Command("osascript", "-e", `quit app "Ollama"`)
		_ = cmdApp.Run()
	}
	// `pkill -f 'ollama serve'` matches the server's full command line, which is what we
	// actually want to stop. The fallback used to be `pkill -f 'ollama'`, which matches ANY
	// command line containing the substring - an editor with ollama.log open, `tail -f
	// ollama.log`, a `grep ollama`, and the user's own foreground `ollama run llama3` - and
	// killed all of them. `pkill -x ollama` matches only processes whose executable name is
	// exactly "ollama", which is the real server started without the "serve" argument.
	cmd := exec.Command("sh", "-c", "pkill -f 'ollama serve' || pkill -x ollama")
	_ = cmd.Run()
	return nil
}
