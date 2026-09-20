//go:build !windows

package procutil

import (
	"os/exec"
	"testing"
)

func TestHideWindow_IsNoopOnUnix(t *testing.T) {
	cmd := exec.Command("true")
	HideWindow(cmd)

	if cmd.SysProcAttr != nil {
		t.Errorf("expected HideWindow to be a no-op on unix, got SysProcAttr=%+v", cmd.SysProcAttr)
	}
}

func TestKillTreeOnCancel_SetsSetpgidAndCancel(t *testing.T) {
	cmd := exec.Command("true")
	KillTreeOnCancel(cmd)

	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("expected Setpgid to be true")
	}
	if cmd.Cancel == nil {
		t.Fatal("expected cmd.Cancel to be set")
	}
	// No process was started, so Cancel must be a safe no-op.
	if err := cmd.Cancel(); err != nil {
		t.Errorf("Cancel on an unstarted command should be a no-op, got: %v", err)
	}
}
