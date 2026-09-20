//go:build !windows

package procutil

import (
	"os/exec"
	"syscall"
)

// HideWindow is a no-op on non-Windows platforms; there is no console window to hide.
func HideWindow(cmd *exec.Cmd) {}

// KillTreeOnCancel puts cmd in its own process group and arranges for the whole group (not
// just the immediate process) to be terminated when cmd's context is canceled, e.g. on a step
// timeout. Without this, exec.CommandContext only kills the immediate process, leaving
// grandchildren (such as a shell's own child processes) running.
func KillTreeOnCancel(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		if cmd.Process != nil && cmd.Process.Pid > 0 {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}
