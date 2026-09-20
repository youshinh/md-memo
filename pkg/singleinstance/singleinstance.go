// Package singleinstance provides the "is another MD-Memo already running?" check for the
// platforms that do not have one built into their window layer.
//
// Windows answers this with a named mutex created in window_windows.go and never calls
// Acquire; the stub in singleinstance_stub.go exists purely so this package compiles and
// vets everywhere. On darwin and linux Acquire takes an exclusive, non-blocking flock on a
// lock file under the per-user config directory and keeps the descriptor open for the rest
// of the process's life, so the lock is released by the kernel however the process dies -
// including a crash, where a PID file or a "delete on exit" scheme would leave a stale lock
// behind and make the app permanently unstartable.
package singleinstance

import (
	"path/filepath"

	"md-memo/pkg/appdir"
)

// LockFileName is the name of the lock file inside the md-memo config directory.
const LockFileName = "instance.lock"

// LockFilePath reports the absolute path of the single-instance lock file. It goes through
// pkg/appdir rather than os.UserConfigDir so tests can redirect it into a temp directory.
func LockFilePath() (string, error) {
	configDir, err := appdir.ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "md-memo", LockFileName), nil
}
