package main

import (
	"encoding/json"
	"strings"
	"testing"

	"md-memo/pkg/jev"
)

func TestApp_JevPredictAndExecute(t *testing.T) {
	app := &App{}
	app.InitJevEngine()

	// 1. Predict
	doc := "# API Service\n\nFix authentication bug in handler."
	resp, err := app.JevPredict(doc, len(doc))
	if err != nil {
		t.Fatalf("JevPredict failed: %v", err)
	}

	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 orthogonal candidates, got %d", len(resp.Candidates))
	}

	// Verify orthogonal slots
	if resp.Candidates[0].ActionType != "ai" {
		t.Errorf("Slot 1 should be ai, got %s", resp.Candidates[0].ActionType)
	}
	if resp.Candidates[1].ActionType != "sh" {
		t.Errorf("Slot 2 should be sh, got %s", resp.Candidates[1].ActionType)
	}
	if resp.Candidates[2].ActionType != "doc" {
		t.Errorf("Slot 3 should be doc, got %s", resp.Candidates[2].ActionType)
	}

	// 2. Execute safe shell command
	candJSON, _ := json.Marshal(jev.Candidate{
		ActionType: "sh",
		Command:    "echo 'jev integration test passed'",
	})

	execRes, err := app.JevExecute(string(candJSON), doc)
	if err != nil {
		t.Fatalf("JevExecute failed: %v", err)
	}
	if !execRes.Success {
		t.Fatalf("expected execution success, got error: %s", execRes.Error)
	}
	if !strings.Contains(execRes.Output, "jev integration test passed") {
		t.Errorf("expected output to contain message, got: %q", execRes.Output)
	}

	// 3. Execute dangerous shell command (Should be blocked by AST guardrail)
	dangJSON, _ := json.Marshal(jev.Candidate{
		ActionType: "sh",
		Command:    "rm -rf /",
	})
	dangRes, _ := app.JevExecute(string(dangJSON), doc)
	if dangRes != nil && dangRes.Success {
		t.Fatalf("destructive command must be blocked")
	}

	// 4. Standalone Verify
	valRes, err := app.JevVerify("cat $UNQUOTED_VAR")
	if err != nil {
		t.Fatalf("JevVerify failed: %v", err)
	}
	if valRes.IsSafe {
		t.Errorf("unquoted variable must fail verification")
	}
}
