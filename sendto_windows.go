package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"md-memo/pkg/procutil"
)

const sendToShortcutName = "MD-Memo (OCR).lnk"

// createShortcutScript uses the same WScript.Shell COM technique any "create a .lnk from a
// script" guide uses; unlike pkg/ocr's WinRT projection this has no PowerShell-version
// requirement (it works under both classic Windows PowerShell and PowerShell 7), but
// powershell.exe is used anyway for consistency with the rest of this app's PowerShell calls.
const createShortcutScript = `param([string]$ShortcutPath, [string]$TargetPath)

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($ShortcutPath)
$sc.TargetPath = $TargetPath
$sc.Arguments = "ocr"
$sc.WorkingDirectory = Split-Path $TargetPath
$sc.Description = "Send an image to MD-Memo for OCR"
$sc.Save()
`

var (
	sendToScriptOnce sync.Once
	sendToScriptPath string
	sendToScriptErr  error
)

// helperScriptDir keeps the helper script under the per-user cache directory rather than %TEMP%: a
// script dropped in a temp folder and run with -ExecutionPolicy Bypass is exactly the pattern
// antivirus heuristics look for.
func helperScriptDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "md-memo", "scripts")
}

func ensureSendToScript() (string, error) {
	sendToScriptOnce.Do(func() {
		dir := helperScriptDir()
		if err := os.MkdirAll(dir, 0755); err != nil {
			sendToScriptErr = err
			return
		}
		path := filepath.Join(dir, "create_sendto_shortcut.ps1")
		if err := os.WriteFile(path, []byte(createShortcutScript), 0644); err != nil {
			sendToScriptErr = err
			return
		}
		sendToScriptPath = path
	})
	return sendToScriptPath, sendToScriptErr
}

func sendToShortcutPath() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", fmt.Errorf("APPDATA environment variable not set")
	}
	return filepath.Join(appData, "Microsoft", "Windows", "SendTo", sendToShortcutName), nil
}

// InstallSendToShortcut places a "MD-Memo (OCR)" entry in the Explorer "Send To" menu that
// invokes `md-memo ocr <path>` on the right-clicked file: no GUI launch, no standing process.
func (a *App) InstallSendToShortcut() error {
	shortcutPath, err := sendToShortcutPath()
	if err != nil {
		return err
	}
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolving md-memo's own executable path: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	scriptPath, err := ensureSendToScript()
	if err != nil {
		return fmt.Errorf("preparing the shortcut-creation script: %w", err)
	}

	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ShortcutPath", shortcutPath, "-TargetPath", exePath)
	procutil.HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("creating Send To shortcut: %w: %s", err, string(out))
	}
	return nil
}

// UninstallSendToShortcut removes the Send To entry created by InstallSendToShortcut, if present.
func (a *App) UninstallSendToShortcut() error {
	shortcutPath, err := sendToShortcutPath()
	if err != nil {
		return err
	}
	if err := os.Remove(shortcutPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// IsSendToShortcutInstalled reports whether InstallSendToShortcut has already run.
func (a *App) IsSendToShortcutInstalled() bool {
	shortcutPath, err := sendToShortcutPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(shortcutPath)
	return err == nil
}
