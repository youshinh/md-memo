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

	// 5. Agent Dispatch (Direct vs Escalated)
	planDirect, err := app.JevDispatchAgent("git status")
	if err != nil {
		t.Fatalf("JevDispatchAgent failed: %v", err)
	}
	if planDirect.ShouldEscalate {
		t.Errorf("git status should not escalate")
	}

	planEscalate, err := app.JevDispatchAgent("全アーキテクチャの大規模リファクタリング計画")
	if err != nil {
		t.Fatalf("JevDispatchAgent failed: %v", err)
	}
	if !planEscalate.ShouldEscalate {
		t.Errorf("complex task should escalate")
	}

	// 6. Context Pruning
	pruned := app.JevPruneContext("# Header\nContent\n## Target\nKeyword match here", "Keyword")
	if !strings.Contains(pruned, "Keyword match here") {
		t.Errorf("expected pruned context to contain keyword")
	}

	// 7. Loop Convergence
	task := jev.AgentTask{ID: "t-1", Prompt: "test"}
	stop, prog := app.JevEvaluateLoopConvergence(task, 1, "task completed successfully")
	if !stop || prog < 1.0 {
		t.Errorf("expected loop convergence completion")
	}
}

func TestApp_JevPredict_ScheduleAndNotesContext(t *testing.T) {
	app := &App{}
	app.InitJevEngine()

	doc := `おはようございます！何かお手伝いできることはありますか？
！今日もよろしくお願いします。
明日は休みなのでお出かけの予定はありますか？
予定表`

	resp, err := app.JevPredict(doc, len(doc))
	if err != nil {
		t.Fatalf("JevPredict failed: %v", err)
	}

	if len(resp.Candidates) != 3 {
		t.Fatalf("expected 3 candidates, got %d", len(resp.Candidates))
	}

	for i, c := range resp.Candidates {
		t.Logf("Candidate %d: ActionType=%s, Command=%s, Description=%s", i+1, c.ActionType, c.Command, c.Description)
	}

	// Must NOT contain the English fallback code refactor
	if strings.Contains(resp.Candidates[0].Command, "refactor current block") {
		t.Errorf("Candidate 0 should not be English refactor fallback: %s", resp.Candidates[0].Command)
	}

	// Must contain schedule/task planning or checklist
	if !strings.Contains(resp.Candidates[0].Command, "アクションプラン") && !strings.Contains(resp.Candidates[0].Command, "チェックリスト") {
		t.Errorf("Candidate 0 expected to relate to action plan or checklist, got: %s", resp.Candidates[0].Command)
	}
}
