//go:build !windows

package gitsync

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
