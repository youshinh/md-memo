//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// setCmdWindowFlags configures the command to run completely hidden without opening a console window on Windows.
func setCmdWindowFlags(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// 0x08000000 = CREATE_NO_WINDOW
	cmd.SysProcAttr.CreationFlags |= 0x08000000
}

// getInstallOllamaCmdOS returns the platform-specific command to install Ollama.
func getInstallOllamaCmdOS() string {
	return "winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements"
}

// startOllamaServiceOS attempts to start Ollama in the background on Windows.
func startOllamaServiceOS() error {
	// Try starting ollama serve with CREATE_NO_WINDOW
	cmd := exec.Command("cmd.exe", "/c", "start /b ollama serve")
	setCmdWindowFlags(cmd)
	setupCmdProcessTreeKill(cmd)
	return cmd.Start()
}
