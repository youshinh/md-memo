//go:build windows

package gitsync

import (
	"os/exec"
	"syscall"
)

// hideWindow ensures child git processes never spawn a visible console window on Windows.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
