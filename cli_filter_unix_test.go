//go:build darwin || linux

package main

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestExecuteCli_KillsProcessGroupOnCancel is the regression test for the command-bar's
// non-Windows path never tearing down the pipeline it spawned. Before this fix,
// setupCmdProcessTreeKill only did anything when runtime.GOOS == "windows", so on macOS and
// Linux a pipeline like "sleep 20 | cat" kept running as an orphaned process group past the
// command bar's 30s timeout, or past an explicit CancelCommandFilter - exec.CommandContext by
// itself only kills the immediate "sh" process, not the children it forked.
//
// It drives executeCli - the same function RunCommandFilter/RunCommandFilterAsync call - with a
// short 300ms timeout standing in for the real 30s one, running a pipeline that sleeps far
// longer than that, and proves the whole process group is gone well within a generous 3s
// budget.
func TestExecuteCli_KillsProcessGroupOnCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	start := time.Now()
	res, err := executeCli(ctx, "echo $$; sleep 20 | cat", "")
	elapsed := time.Since(start)

	if elapsed > 3*time.Second {
		t.Fatalf("executeCli took %v to return after a 300ms context timeout; want well under 3s", elapsed)
	}
	if res == nil {
		t.Fatalf("executeCli returned a nil result, err=%v", err)
	}
	if res.ExitCode != 124 {
		t.Errorf("expected ExitCode 124 (timed out) once the context deadline was exceeded, got %d (stderr=%q)", res.ExitCode, res.Error)
	}

	pidLine := strings.TrimSpace(strings.SplitN(res.Output, "\n", 2)[0])
	pid, perr := strconv.Atoi(pidLine)
	if perr != nil {
		t.Fatalf("could not parse the shell's own pid ($$) from output %q: %v", res.Output, perr)
	}

	// KillTreeOnCancel puts the "sh" that ran this command in its own process group (pgid ==
	// its own pid, since Setpgid is applied before Start). Killing that whole group on cancel
	// must also reach "sleep", the grandchild it piped into "cat" - that is exactly the bug
	// this test guards against.
	deadline := time.Now().Add(3 * time.Second)
	for {
		killErr := syscall.Kill(-pid, 0)
		if errors.Is(killErr, syscall.ESRCH) {
			return // the whole process group is gone
		}
		if time.Now().After(deadline) {
			t.Fatalf("process group %d still alive 3s after the command bar's cancel: syscall.Kill(-pid, 0) = %v", pid, killErr)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
