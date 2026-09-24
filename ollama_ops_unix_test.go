//go:build darwin || linux

package main

import (
	"errors"
	"os/exec"
	"runtime"
	"syscall"
	"testing"
	"time"
)

// TestStartDetachedAndReap_NoZombie is the regression test for the zombie-process bug in
// startOllamaServiceOS: it used to call cmd.Start() and return without ever calling cmd.Wait(),
// so the short-lived launcher process (the backgrounding "sh", or "open" on macOS) stayed a
// defunct zombie entry in the process table until this app process happened to exit. It never
// runs "ollama" itself - only a benign "true" - so it stays hermetic while still exercising the
// exact Start()-then-background-Wait() pattern startOllamaServiceOS now uses via
// startDetachedAndReap.
//
// A zombie child is still visible to kill(pid, 0) (the kernel keeps its exit status around
// until reaped), so this polls that syscall until it reports ESRCH, proving the process was
// actually reaped rather than merely having exited.
func TestStartDetachedAndReap_NoZombie(t *testing.T) {
	cmd := exec.Command("sh", "-c", "true")
	if err := startDetachedAndReap(cmd); err != nil {
		t.Fatalf("startDetachedAndReap: %v", err)
	}
	pid := cmd.Process.Pid

	deadline := time.Now().Add(3 * time.Second)
	for {
		killErr := syscall.Kill(pid, 0)
		if errors.Is(killErr, syscall.ESRCH) {
			return // reaped: the process table entry is gone
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d was not reaped within 3s of starting (zombie leak): syscall.Kill(pid, 0) = %v", pid, killErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestStartDetachedAndReap_PropagatesStartError checks the boring path: a command that cannot
// even start (unknown executable) must still return an error, not silently swallow it now that
// the success path backgrounds the Wait().
func TestStartDetachedAndReap_PropagatesStartError(t *testing.T) {
	cmd := exec.Command("md-memo-does-not-exist-xyz")
	if err := startDetachedAndReap(cmd); err == nil {
		t.Fatal("expected an error starting a nonexistent executable, got nil")
	}
}

// TestGetInstallOllamaCmdOS_Unix exercises the real, unstubbed getInstallOllamaCmdOS on this
// build (darwin or linux). It does not assert a specific command - that would require faking
// Homebrew's presence - only that whatever ollamaInstallPlan decided ends up reflected
// verbatim: empty when ollamaInstallPlan errors (no automated darwin install path), a
// space-joined command line otherwise. This is the same logic ollama_ops_plan_test.go
// table-tests exhaustively on Windows; this just confirms the unix wiring calls it correctly
// with the real runtime.GOOS and a real (not faked) brew lookup.
func TestGetInstallOllamaCmdOS_Unix(t *testing.T) {
	got := getInstallOllamaCmdOS()
	hasBrew := false
	if _, err := exec.LookPath("brew"); err == nil {
		hasBrew = true
	}
	wantName, wantArgs, wantErr := ollamaInstallPlan(runtime.GOOS, hasBrew)
	if wantErr != nil {
		if got != "" {
			t.Errorf("expected empty install command when ollamaInstallPlan errors, got %q", got)
		}
		return
	}
	want := wantName
	for _, a := range wantArgs {
		want += " " + a
	}
	if got != want {
		t.Errorf("getInstallOllamaCmdOS() = %q, want %q (derived from ollamaInstallPlan)", got, want)
	}
}
