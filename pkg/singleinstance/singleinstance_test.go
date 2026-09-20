package singleinstance

import (
	"path/filepath"
	"testing"

	"md-memo/pkg/appdir"
)

func TestLockFilePathHonoursConfigDirOverride(t *testing.T) {
	tmp := t.TempDir()
	appdir.SetConfigDirOverride(tmp)
	t.Cleanup(func() { appdir.SetConfigDirOverride("") })

	got, err := LockFilePath()
	if err != nil {
		t.Fatalf("LockFilePath() error: %v", err)
	}

	want := filepath.Join(tmp, "md-memo", LockFileName)
	if got != want {
		t.Fatalf("LockFilePath() = %q, want %q", got, want)
	}
}

func TestLockFilePathIsInsideAppDirectory(t *testing.T) {
	// Without an override the path must still land under <config>/md-memo and never in the
	// config root itself, which is shared with every other application on the machine.
	got, err := LockFilePath()
	if err != nil {
		t.Skipf("no user config dir on this machine: %v", err)
	}
	if filepath.Base(got) != LockFileName {
		t.Errorf("LockFilePath() base = %q, want %q", filepath.Base(got), LockFileName)
	}
	if filepath.Base(filepath.Dir(got)) != "md-memo" {
		t.Errorf("LockFilePath() parent = %q, want \"md-memo\"", filepath.Base(filepath.Dir(got)))
	}
	if !filepath.IsAbs(got) {
		t.Errorf("LockFilePath() = %q, want an absolute path", got)
	}
}

// TestAcquireIsIdempotent covers both implementations: the unix one must return true again
// for the process that already holds the lock (rather than deadlocking or reporting a
// conflict with itself), and the stub must simply always succeed.
func TestAcquireIsIdempotent(t *testing.T) {
	tmp := t.TempDir()
	appdir.SetConfigDirOverride(tmp)
	t.Cleanup(func() {
		_ = Release()
		appdir.SetConfigDirOverride("")
	})

	for i := 0; i < 3; i++ {
		ok, err := Acquire()
		if err != nil {
			t.Fatalf("Acquire() #%d error: %v", i+1, err)
		}
		if !ok {
			t.Fatalf("Acquire() #%d = false, want true", i+1)
		}
	}

	if err := Release(); err != nil {
		t.Fatalf("Release() error: %v", err)
	}
	// Releasing twice must not blow up.
	if err := Release(); err != nil {
		t.Fatalf("second Release() error: %v", err)
	}
}
