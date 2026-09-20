//go:build windows

package ipc

import (
	"golang.org/x/sys/windows"
)

// stillActive is STILL_ACTIVE (259): GetExitCodeProcess reports it for a process that has
// not exited yet.
const stillActive = 259

// processAlive reports whether pid names a live process.
//
// It is deliberately conservative: if the process cannot be opened for a reason other than
// "no such process" (most plausibly access denied), it answers true, because the caller uses
// a false answer to delete the session file and skip the handoff entirely. Being wrong in
// that direction would mean refusing to talk to a running instance.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}

	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if err == windows.ERROR_INVALID_PARAMETER {
			// Documented result for a PID that does not exist.
			return false
		}
		// Access denied or anything else: cannot prove it is dead.
		return true
	}
	defer windows.CloseHandle(h)

	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	return code == stillActive
}
