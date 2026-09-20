package slotagent

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// longRunningAgent returns an AgentDef that blocks for far longer than the test is willing
// to wait, using whatever sleep primitive the host OS provides.
func longRunningAgent(t *testing.T) AgentDef {
	t.Helper()
	if runtime.GOOS == "windows" {
		exe, err := exec.LookPath("powershell.exe")
		if err != nil {
			t.Skipf("powershell.exe not available: %v", err)
		}
		return AgentDef{
			Command: exe,
			Args:    []string{"-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 120"},
		}
	}
	exe, err := exec.LookPath("sleep")
	if err != nil {
		t.Skipf("sleep not available: %v", err)
	}
	return AgentDef{Command: exe, Args: []string{"120"}}
}

// TestRunner_RegisterCancelStopsRunPromptly is the regression test for the bug where the
// Cancel button did nothing: app.go builds its own context.WithTimeout and calls
// Runner.Execute directly, so unless that cancel func is Registered, Cancel(reqID) has
// nothing to look up and the agent CLI keeps running until the 180s timeout.
//
// Note that a prompt return also proves the process tree is gone: Execute only returns
// after both pipe readers have seen EOF, which cannot happen while any process still holds
// the child's stdout/stderr write handles.
func TestRunner_RegisterCancelStopsRunPromptly(t *testing.T) {
	runner := NewRunner()
	agentDef := longRunningAgent(t)

	const reqID = "req-cancel-register"
	// Same shape as app.go RunSlotAgentAsync: a long timeout plus an explicit Register.
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	runner.Register(reqID, cancel)
	defer runner.Unregister(reqID)

	done := make(chan *AgentExecutionResult, 1)
	go func() {
		done <- runner.Execute(ctx, reqID, agentDef, "", "", "")
	}()

	// Let the child actually spawn before cancelling.
	time.Sleep(500 * time.Millisecond)

	start := time.Now()
	runner.Cancel(reqID)

	select {
	case res := <-done:
		if elapsed := time.Since(start); elapsed > 20*time.Second {
			t.Fatalf("Execute took %v to return after Cancel; expected it to stop promptly", elapsed)
		}
		if res.ExitCode == 0 {
			t.Errorf("expected a non-zero exit code after cancellation, got 0 (output=%q)", res.Output)
		}
		if res.TimedOut {
			t.Errorf("expected TimedOut=false for a cancellation, got true")
		}
		if !strings.Contains(res.ErrorMsg, "キャンセル") {
			t.Errorf("expected a cancellation message, got %q", res.ErrorMsg)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Execute never returned after Cancel: the agent process was not stopped")
	}
}

// TestRunner_CancelWithoutRegisterIsNoop pins the old (broken) behaviour as the explicit
// contract: Cancel only works for request IDs that were Registered.
func TestRunner_CancelWithoutRegisterIsNoop(t *testing.T) {
	runner := NewRunner()
	runner.Cancel("never-registered") // must not panic
	runner.Unregister("never-registered")
	runner.Register("", nil) // ignored
}

// TestRunner_UnregisterPreventsLateCancel makes sure a reused/stale request ID cannot have a
// later Cancel tear down an unrelated context after the run already finished.
func TestRunner_UnregisterPreventsLateCancel(t *testing.T) {
	runner := NewRunner()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runner.Register("req-late", cancel)
	runner.Unregister("req-late")
	runner.Cancel("req-late")

	select {
	case <-ctx.Done():
		t.Fatal("Cancel reached a context that had already been unregistered")
	default:
	}
}
