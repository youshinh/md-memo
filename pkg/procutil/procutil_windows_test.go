//go:build windows

package procutil

import (
	"os/exec"
	"testing"
)

func TestHideWindow_SetsWindowsFlags(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	HideWindow(cmd)

	if cmd.SysProcAttr == nil {
		t.Fatal("expected SysProcAttr to be set")
	}
	if !cmd.SysProcAttr.HideWindow {
		t.Error("expected HideWindow to be true")
	}
	if cmd.SysProcAttr.CreationFlags&0x08000000 == 0 {
		t.Error("expected CREATE_NO_WINDOW creation flag to be set")
	}
}

func TestKillTreeOnCancel_SetsHideWindowAndCancel(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	KillTreeOnCancel(cmd)

	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow {
		t.Error("expected HideWindow to be set as part of KillTreeOnCancel")
	}
	if cmd.Cancel == nil {
		t.Fatal("expected cmd.Cancel to be set")
	}
	// No process was started, so Cancel must be a safe no-op.
	if err := cmd.Cancel(); err != nil {
		t.Errorf("Cancel on an unstarted command should be a no-op, got: %v", err)
	}
}
