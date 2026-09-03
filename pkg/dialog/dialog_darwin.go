//go:build darwin

package dialog

import (
	"bytes"
	"os/exec"
	"strings"
)

// OpenFileDialog shows native macOS Open File dialog using osascript safely.
func OpenFileDialog(title string) (string, error) {
	script := `on run argv
		return POSIX path of (choose file with prompt (item 1 of argv))
	end run`
	cmd := exec.Command("osascript", "-e", script, title)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return "", nil // User cancelled
	}
	return strings.TrimSpace(out.String()), nil
}

// SaveFileDialog shows native macOS Save File dialog using osascript safely.
func SaveFileDialog(title, defaultName string) (string, error) {
	script := `on run argv
		return POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv))
	end run`
	cmd := exec.Command("osascript", "-e", script, title, defaultName)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return "", nil // User cancelled
	}
	return strings.TrimSpace(out.String()), nil
}
