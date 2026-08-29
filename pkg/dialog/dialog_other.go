//go:build !windows && !darwin

package dialog

import (
	"bytes"
	"os/exec"
	"strings"
)

// OpenFileDialog fallback for Linux/other OS.
func OpenFileDialog(title string) (string, error) {
	cmd := exec.Command("zenity", "--file-selection", "--title="+title)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", nil // Cancelled
	}
	return strings.TrimSpace(out.String()), nil
}

// SaveFileDialog fallback for Linux/other OS.
func SaveFileDialog(title, defaultName string) (string, error) {
	cmd := exec.Command("zenity", "--file-selection", "--save", "--confirm-overwrite", "--title="+title, "--filename="+defaultName)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", nil // Cancelled
	}
	return strings.TrimSpace(out.String()), nil
}
