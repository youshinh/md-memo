//go:build !windows

package ipc

import (
	"errors"
	"syscall"
)

// processAlive reports whether pid names a live process.
//
// Signal 0 performs the permission/existence checks without delivering anything: a nil error
// means the process exists and we may signal it, EPERM means it exists but belongs to
// someone else, and ESRCH means there is no such process. Like the Windows implementation
// this errs towards "alive", because a false answer makes the caller purge the session file
// and skip the single-instance handoff.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return !errors.Is(err, syscall.ESRCH)
}
