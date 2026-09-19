//go:build !windows

package slotagent

import (
	"os/exec"
	"syscall"
)

func setupPlatformProcessTreeKill(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil && cmd.Process.Pid > 0 {
			// Send SIGKILL to the entire process group (-pid)
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}
