package main

import "testing"

// A folder or document handed to the shell must not be launched with a hidden window state: Windows
// carries it over to the window the shell opens, and an Explorer window opened that way is invisible.
func TestNewShellLaunchCmd_DoesNotHideTheWindow(t *testing.T) {
	cmd := newShellLaunchCmd("rundll32", "url.dll,FileProtocolHandler", `C:\some\folder`)
	if cmd.SysProcAttr != nil && (cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&0x08000000 != 0) {
		t.Fatalf("the launcher is started hidden (HideWindow=%v, flags=%#x); the folder window it opens would be invisible",
			cmd.SysProcAttr.HideWindow, cmd.SysProcAttr.CreationFlags)
	}
	if got := cmd.Args[len(cmd.Args)-1]; got != `C:\some\folder` {
		t.Fatalf("path argument = %q", got)
	}
}
