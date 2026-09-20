//go:build darwin || linux

package singleinstance

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

var (
	mu sync.Mutex
	// held is the open descriptor carrying the flock. It is a package-level variable on
	// purpose: the lock lives exactly as long as the descriptor, so it must never be closed
	// or garbage collected while the app is running.
	held *os.File
)

// Acquire tries to take the exclusive single-instance lock.
//
// It returns (true, nil) when this process now owns the lock (including when it already did),
// (false, nil) when another live process holds it, and (false, err) only when the lock file
// itself could not be created or locked for some other reason. A caller that cannot tell the
// difference should treat an error as "go ahead and start": refusing to launch because of an
// unwritable config directory would be worse than running twice.
func Acquire() (bool, error) {
	mu.Lock()
	defer mu.Unlock()

	if held != nil {
		return true, nil
	}

	path, err := LockFilePath()
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return false, err
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, err
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return false, nil
		}
		return false, err
	}

	held = f
	return true, nil
}

// Release drops the lock. Production code never calls it - the process exit that closes the
// descriptor is what releases the lock - but tests need to be able to hand it back.
func Release() error {
	mu.Lock()
	defer mu.Unlock()

	if held == nil {
		return nil
	}
	f := held
	held = nil
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return f.Close()
}
