package procutil

import (
	"context"
	"io"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

// TestKillTreeOnCancel_KillsGrandchild is the cross-platform regression test for the bug
// these helpers exist to fix: exec.CommandContext by itself only kills the immediate child
// process when its context is canceled, leaving any grandchild it spawned running. It starts
// a command whose immediate child spawns a further nested child that sleeps far longer than
// the test is willing to wait, cancels the context shortly after start, and then proves the
// whole tree is gone by reading the command's stdout to EOF: that pipe cannot close while any
// descendant still holds the write end open (same approach as
// pkg/slotagent/runner_cancel_test.go).
func TestKillTreeOnCancel_KillsGrandchild(t *testing.T) {
	var exe string
	var args []string
	if runtime.GOOS == "windows" {
		psExe, err := exec.LookPath("powershell.exe")
		if err != nil {
			t.Skipf("powershell.exe not available: %v", err)
		}
		exe = psExe
		// The outer powershell's immediate child is a further nested powershell (the
		// grandchild) that actually sleeps; the outer process waits on it.
		args = []string{"-NoProfile", "-NonInteractive", "-Command",
			"powershell -NoProfile -NonInteractive -Command Start-Sleep -Seconds 120"}
	} else {
		shExe, err := exec.LookPath("sh")
		if err != nil {
			t.Skipf("sh not available: %v", err)
		}
		exe = shExe
		args = []string{"-c", "sh -c 'sleep 120'"}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, args...)
	KillTreeOnCancel(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Let the grandchild actually spawn before cancelling.
	time.Sleep(500 * time.Millisecond)
	cancel()

	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, stdout)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("grandchild process was not killed within 20s of context cancellation")
	}
	_ = cmd.Wait()
}
