//go:build !windows

package main

import (
	"os"
	"os/exec"
	"runtime"
)

// setCmdWindowFlags is a no-op on Unix platforms.
func setCmdWindowFlags(cmd *exec.Cmd) {
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
	cmd := exec.Command("sh", "-c", "pkill -f 'ollama serve' || pkill -f 'ollama'")
	_ = cmd.Run()
	return nil
}
