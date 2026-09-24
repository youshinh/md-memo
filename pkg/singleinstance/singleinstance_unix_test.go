//go:build darwin || linux

package singleinstance

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"md-memo/pkg/appdir"
)

// TestAcquireReportsAlreadyRunningThenSucceedsAfterRelease exercises the real flock path in
// singleinstance_unix.go end to end. It simulates a second MD-Memo process by opening the lock
// file on a descriptor of its own and flock-ing it directly, bypassing this package's Acquire -
// flock locks are per open file description, not per process, so two independent descriptors on
// the same path behave exactly like two separate processes would, without needing to actually
// fork one.
func TestAcquireReportsAlreadyRunningThenSucceedsAfterRelease(t *testing.T) {
	tmp := t.TempDir()
	appdir.SetConfigDirOverride(tmp)
	t.Cleanup(func() {
		_ = Release()
		appdir.SetConfigDirOverride("")
	})

	path, err := LockFilePath()
	if err != nil {
		t.Fatalf("LockFilePath(): %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}

	other, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatalf("opening lock file on a separate descriptor: %v", err)
	}
	defer other.Close()
	if err := syscall.Flock(int(other.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("taking the flock on the other descriptor: %v", err)
	}

	// With another descriptor already holding the exclusive lock, Acquire must report "not
	// acquired" without an error - a second MD-Memo launch is expected, not a failure.
	ok, err := Acquire()
	if err != nil {
		t.Fatalf("Acquire() while another descriptor holds the lock: unexpected error %v", err)
	}
	if ok {
		t.Fatal("Acquire() = true while another descriptor holds the flock, want false (already running)")
	}

	// Simulate that other "process" exiting: release and close its descriptor.
	if err := syscall.Flock(int(other.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatalf("releasing the other descriptor's flock: %v", err)
	}
	if err := other.Close(); err != nil {
		t.Fatalf("closing the other descriptor: %v", err)
	}

	ok, err = Acquire()
	if err != nil {
		t.Fatalf("Acquire() after the other holder released: unexpected error %v", err)
	}
	if !ok {
		t.Fatal("Acquire() = false after the other holder released the lock, want true")
	}
}
