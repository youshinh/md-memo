//go:build darwin || linux

package shellenv

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestResolveLoginShellPathAgainstRealShShell runs the actual probe against /bin/sh, the one
// shell every Unix (and the CI macos-latest / ubuntu-latest runners) is guaranteed to have.
// This is the one part of the package pure-function tests in shellenv_test.go cannot cover:
// that a real shell invocation, real -l/-i flags and real process teardown actually produce a
// usable PATH.
func TestResolveLoginShellPathAgainstRealShShell(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("/bin/sh not present on this machine")
	}
	t.Setenv("SHELL", "/bin/sh")

	path, err := ResolveLoginShellPath(context.Background())
	if err != nil {
		t.Fatalf("ResolveLoginShellPath() against /bin/sh: %v", err)
	}
	if !strings.Contains(path, "/usr/bin") {
		t.Fatalf("ResolveLoginShellPath() = %q, want it to contain /usr/bin", path)
	}
}

// TestResolveLoginShellPathSurvivesRcBanner points /bin/sh's login-shell startup file at a
// throwaway HOME whose .profile prints banner-style noise (the kind direnv, nvm, a MOTD or a
// fortune command routinely produce) before the probe's own printf runs. ExtractPath's ability
// to ignore text outside the markers is already covered as a pure function in shellenv_test.go;
// this proves the same thing end to end through a real shell's rc-file startup sequence.
func TestResolveLoginShellPathSurvivesRcBanner(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("/bin/sh not present on this machine")
	}

	home := t.TempDir()
	profile := filepath.Join(home, ".profile")
	banner := "echo \"Welcome to the test shell!\"\necho \"direnv: loading .envrc\"\n"
	if err := os.WriteFile(profile, []byte(banner), 0644); err != nil {
		t.Fatalf("writing fake .profile: %v", err)
	}

	t.Setenv("HOME", home)
	t.Setenv("SHELL", "/bin/sh")

	path, err := ResolveLoginShellPath(context.Background())
	if err != nil {
		t.Fatalf("ResolveLoginShellPath() with an rc banner ahead of the markers: %v", err)
	}
	if strings.TrimSpace(path) == "" {
		t.Fatal("ResolveLoginShellPath() returned an empty PATH despite the rc banner noise")
	}
}

// TestResolveLoginShellPathAbandonsHangingShellWithinTimeout points $SHELL at a script that
// never returns and never prints the probe's markers, standing in for a login shell stuck on a
// prompt, a broken rc file, or a hung subprocess. ResolveLoginShellPath must not block MD-Memo
// startup indefinitely: each of its two attempts is bounded by the package's probeTimeout, and
// procutil.KillTreeOnCancel is what actually reaps the hung shell (and anything it spawned) when
// that timeout fires.
func TestResolveLoginShellPathAbandonsHangingShellWithinTimeout(t *testing.T) {
	dir := t.TempDir()
	fakeShell := filepath.Join(dir, "hangs.sh")
	script := "#!/bin/sh\nsleep 100\n"
	if err := os.WriteFile(fakeShell, []byte(script), 0755); err != nil {
		t.Fatalf("writing fake hanging shell: %v", err)
	}
	t.Setenv("SHELL", fakeShell)

	start := time.Now()
	_, err := ResolveLoginShellPath(context.Background())
	elapsed := time.Since(start)

	// ResolveLoginShellPath makes two attempts, each bounded by probeTimeout; allow generous
	// slack on top for process start/teardown on a loaded CI runner.
	maxWait := 2*probeTimeout + 5*time.Second
	if elapsed > maxWait {
		t.Fatalf("ResolveLoginShellPath() took %s against a shell that never returns, want <= %s", elapsed, maxWait)
	}
	if err == nil {
		t.Fatal("ResolveLoginShellPath() succeeded against a shell that never prints the markers; expected an error")
	}
}
