//go:build !windows

package procutil

import (
	"bufio"
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestHideWindow_IsNoopOnUnix(t *testing.T) {
	cmd := exec.Command("true")
	HideWindow(cmd)

	if cmd.SysProcAttr != nil {
		t.Errorf("expected HideWindow to be a no-op on unix, got SysProcAttr=%+v", cmd.SysProcAttr)
	}
}

func TestKillTreeOnCancel_SetsSetpgidAndCancel(t *testing.T) {
	cmd := exec.Command("true")
	KillTreeOnCancel(cmd)

	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Fatal("expected Setpgid to be true")
	}
	if cmd.Cancel == nil {
		t.Fatal("expected cmd.Cancel to be set")
	}
	// No process was started, so Cancel must be a safe no-op.
	if err := cmd.Cancel(); err != nil {
		t.Errorf("Cancel on an unstarted command should be a no-op, got: %v", err)
	}
}

// TestKillTreeOnCancel_KillsProcessGroup proves the whole point of Setpgid + the custom Cancel
// func: cancelling the context must kill a grandchild process too, not just the immediate
// child. sh backgrounds "sleep 30", prints its pid, then waits on it - so "sh" is the process
// group leader and "sleep" is a grandchild of this test, sharing sh's process group because
// KillTreeOnCancel put sh in its own group before it forked. Cancelling should SIGKILL the
// whole group, and syscall.Kill(pid, 0) on the sleep pid should start reporting ESRCH shortly
// after.
func TestKillTreeOnCancel_KillsProcessGroup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // safety net in case the test fails before the explicit cancel below

	cmd := exec.CommandContext(ctx, "sh", "-c", "sleep 30 & echo $!; wait")
	KillTreeOnCancel(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("reading grandchild pid from stdout: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("parsing grandchild pid %q: %v", line, err)
	}

	cancel()
	_ = cmd.Wait() // expected to report the process was killed; that is the point of this test

	deadline := time.Now().Add(3 * time.Second)
	for {
		killErr := syscall.Kill(pid, 0)
		if errors.Is(killErr, syscall.ESRCH) {
			return // the grandchild is gone: the process-group kill reached it
		}
		if time.Now().After(deadline) {
			t.Fatalf("grandchild pid %d (sleep) still alive 3s after cancel: syscall.Kill(pid, 0) = %v", pid, killErr)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
