// Package appdir centralises resolution of the per-user directories MD-Memo persists into
// (config.json, session.json, agents.yaml, generated assets, the scraps folder behind "~").
//
// Every one of those used to call os.UserConfigDir / os.UserHomeDir directly, which made it
// impossible to run the test suite without reading and writing the developer's real
// %AppData%\md-memo and ~/Documents/md-memo. The overrides below exist purely so a TestMain
// can redirect all of that into a temp directory. When no override is set (the only case in
// production) these are exact pass-throughs to the os package.
package appdir

import (
	"os"
	"sync"
)

var (
	mu           sync.RWMutex
	configDirOvr string
	homeDirOvr   string
)

// SetConfigDirOverride redirects ConfigDir to dir. An empty string restores the OS default.
// Intended for tests only.
func SetConfigDirOverride(dir string) {
	mu.Lock()
	configDirOvr = dir
	mu.Unlock()
}

// SetHomeDirOverride redirects HomeDir to dir. An empty string restores the OS default.
// Intended for tests only.
func SetHomeDirOverride(dir string) {
	mu.Lock()
	homeDirOvr = dir
	mu.Unlock()
}

// ConfigDir reports the base directory for per-user application configuration. It is a
// drop-in replacement for os.UserConfigDir.
func ConfigDir() (string, error) {
	mu.RLock()
	ovr := configDirOvr
	mu.RUnlock()
	if ovr != "" {
		return ovr, nil
	}
	return os.UserConfigDir()
}

// HomeDir reports the current user's home directory. It is a drop-in replacement for
// os.UserHomeDir.
func HomeDir() (string, error) {
	mu.RLock()
	ovr := homeDirOvr
	mu.RUnlock()
	if ovr != "" {
		return ovr, nil
	}
	return os.UserHomeDir()
}
