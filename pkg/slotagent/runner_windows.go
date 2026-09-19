//go:build windows

package slotagent

import (
	"os/exec"
	"strconv"
	"syscall"
)

func setupPlatformProcessTreeKill(cmd *exec.Cmd) {
	// Hide console window completely when spawning background agent processes
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}

	cmd.Cancel = func() error {
		if cmd.Process != nil && cmd.Process.Pid > 0 {
			killCmd := exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
			killCmd.SysProcAttr = &syscall.SysProcAttr{
				HideWindow:    true,
				CreationFlags: 0x08000000, // CREATE_NO_WINDOW
			}
			return killCmd.Run()
		}
		return nil
	}
}
