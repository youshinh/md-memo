package slotagent

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

// promptEchoAgent is an agent that prints the instruction it is handed (the appended last argument) and nothing else, so what a
// recipe step printed says which step it was.
func promptEchoAgent(t *testing.T) AgentDef {
	t.Helper()
	if runtime.GOOS == "windows" {
		exe, err := exec.LookPath("powershell.exe")
		if err != nil {
			t.Skipf("powershell.exe not available: %v", err)
		}
		return AgentDef{Command: exe, Args: []string{"-NoProfile", "-NonInteractive", "-Command", "& { param($x) Write-Output $x }"}}
	}
	exe, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("sh not available: %v", err)
	}
	return AgentDef{Command: exe, Args: []string{"-c", `echo "$0"`}}
}

func runRecipe(t *testing.T, rec Recipe, startStep int, approved bool) *PipelineStepResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	engine := NewPipelineEngine(NewRunner())
	return engine.ExecuteRecipe(ctx, "req-pipeline-"+t.Name(), rec, promptEchoAgent(t), "", "", startStep, approved)
}

// A recipe that runs to the end hands back what its LAST step printed. It used to return Completed with no output at all, so
// the caller wrote nothing over the slot and the note kept its "running" mark for good.
func TestExecuteRecipe_CompletedCarriesTheLastStepOutput(t *testing.T) {
	res := runRecipe(t, Recipe{Name: "two", Steps: []string{"first", "second"}}, 0, false)
	if res.Status != PipelineStatusCompleted {
		t.Fatalf("status = %q (%s), want completed", res.Status, res.ErrorMsg)
	}
	if res.Output != "second" {
		t.Errorf("Output = %q, want the last step's output %q", res.Output, "second")
	}
	if res.StepIndex != 2 || res.TotalSteps != 2 {
		t.Errorf("step %d of %d, want 2 of 2", res.StepIndex, res.TotalSteps)
	}
}

// With an approval gate the first run stops after that step (its output plus the gate line); the resumed run starts at the next
// step and its output is the recipe's result.
func TestExecuteRecipe_ResumeAfterTheGateReturnsTheLastStepOutput(t *testing.T) {
	rec := Recipe{Name: "gated", Steps: []string{"one", "two", "three"}, RequiresApprovalStep: 2}

	first := runRecipe(t, rec, 0, false)
	if first.Status != PipelineStatusWaitingApproval {
		t.Fatalf("first run status = %q (%s), want waiting_approval", first.Status, first.ErrorMsg)
	}
	if !strings.HasPrefix(first.Output, "two") || !strings.Contains(first.Output, "// approve") {
		t.Errorf("first run Output = %q, want the step-2 output followed by the gate line", first.Output)
	}

	resumed := runRecipe(t, rec, rec.RequiresApprovalStep, true)
	if resumed.Status != PipelineStatusCompleted {
		t.Fatalf("resumed status = %q (%s), want completed", resumed.Status, resumed.ErrorMsg)
	}
	if resumed.Output != "three" {
		t.Errorf("resumed Output = %q, want %q", resumed.Output, "three")
	}
}

// A gate on the last step has nothing to wait for: the recipe completes with that step's output.
func TestExecuteRecipe_GateOnTheLastStepStillCompletesWithItsOutput(t *testing.T) {
	res := runRecipe(t, Recipe{Name: "last-gate", Steps: []string{"only", "final"}, RequiresApprovalStep: 2}, 0, false)
	if res.Status != PipelineStatusCompleted {
		t.Fatalf("status = %q (%s), want completed", res.Status, res.ErrorMsg)
	}
	if res.Output != "final" {
		t.Errorf("Output = %q, want %q", res.Output, "final")
	}
}
