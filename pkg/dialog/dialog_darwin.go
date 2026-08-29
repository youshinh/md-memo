//go:build darwin

package dialog

import (
	"bytes"
	"os/exec"
	"strings"
)

// OpenFileDialog shows native macOS Open File dialog using osascript.
func OpenFileDialog(title string) (string, error) {
	script := `POSIX path of (choose file with prompt "` + title + `")`
	cmd := exec.Command("osascript", "-e", script)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return "", nil // User cancelled
	}
	return strings.TrimSpace(out.String()), nil
}

// SaveFileDialog shows native macOS Save File dialog using osascript.
func SaveFileDialog(title, defaultName string) (string, error) {
	script := `POSIX path of (choose file name with prompt "` + title + `" default name "` + defaultName + `")`
	cmd := exec.Command("osascript", "-e", script)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return "", nil // User cancelled
	}
	return strings.TrimSpace(out.String()), nil
}
