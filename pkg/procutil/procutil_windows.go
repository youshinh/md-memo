//go:build windows

// Package procutil centralizes the small, OS-specific process helpers that used to be
// copy-pasted across pkg/jev, pkg/slotagent, pkg/gitsync, and the root package: hiding a
// child process's console window, and making sure a whole process tree (not just the
// immediate child) is torn down when the command's context is canceled.
package procutil

import (
	"os/exec"
	"strconv"
	"syscall"
)

// HideWindow configures cmd so its child process never spawns a visible console window on
// Windows. It is a no-op on other platforms.
func HideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}

// KillTreeOnCancel arranges for the whole process tree rooted at cmd (not just the immediate
// process) to be terminated when cmd's context is canceled, e.g. on a step timeout. Without
// this, exec.CommandContext only kills the immediate process, leaving grandchildren (such as
// a shell's own child processes) running and any underlying operation still in flight. On
// Windows this uses a hidden `taskkill /PID <pid> /T /F` against the command's process.
func KillTreeOnCancel(cmd *exec.Cmd) {
	HideWindow(cmd)
	cmd.Cancel = func() error {
		if cmd.Process != nil && cmd.Process.Pid > 0 {
			killCmd := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
			HideWindow(killCmd)
			return killCmd.Run()
		}
		return nil
	}
}
