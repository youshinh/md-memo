//go:build darwin

package dialog

import (
	"bytes"
	"os/exec"
)

// OpenFileDialog shows native macOS Open File dialog using osascript safely.
func OpenFileDialog(title string) (string, error) {
	cmd := exec.Command("osascript", osascriptArgs(kindOpenFile, title, "")...)
	var out bytes.Buffer
	cmd.Stdout = &out
	// Any osascript failure - including the user cancelling the dialog - is reported back as
	// "no path chosen" rather than an error. osascript's own exit code does not distinguish a
	// cancel from any other failure, so this package cannot either; behaviour unchanged from
	// before the refactor into osascript.go.
	if err := cmd.Run(); err != nil {
		return "", nil
	}
	return parseChooseResult(out.String(), false), nil
}

// SaveFileDialog shows native macOS Save File dialog using osascript safely.
func SaveFileDialog(title, defaultName string) (string, error) {
	cmd := exec.Command("osascript", osascriptArgs(kindSaveFile, title, defaultName)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", nil // User cancelled
	}
	return parseChooseResult(out.String(), false), nil
}

// OpenFolderDialog shows native macOS Choose Folder dialog using osascript safely.
func OpenFolderDialog(title string) (string, error) {
	cmd := exec.Command("osascript", osascriptArgs(kindOpenFolder, title, "")...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", nil // User cancelled
	}
	return parseChooseResult(out.String(), true), nil
}
