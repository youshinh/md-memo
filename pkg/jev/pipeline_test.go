package jev

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDecisionTreeRouter(t *testing.T) {
	router := NewDecisionRouter()

	// Case 1: deterministic read
	r1 := router.Route(Candidate{ActionType: "sh", Command: "git status"})
	if r1.Level1Method != "deterministic" || r1.Level2Effect != "read" {
		t.Errorf("expected deterministic/read, got %+v", r1)
	}

	// Case 2: deterministic write
	r2 := router.Route(Candidate{ActionType: "sh", Command: "git commit -m 'feat: test'"})
	if r2.Level1Method != "deterministic" || r2.Level2Effect != "write" {
		t.Errorf("expected deterministic/write, got %+v", r2)
	}

	// Case 3: generative local (ai)
	r3 := router.Route(Candidate{ActionType: "ai", Command: "refactor function"})
	if r3.Level1Method != "generative" {
		t.Errorf("expected generative, got %+v", r3)
	}

	// Case 4: generative global (doc)
	r4 := router.Route(Candidate{ActionType: "doc", Command: "summarize issues"})
	if r4.Level1Method != "generative" {
		t.Errorf("expected generative, got %+v", r4)
	}
}

func TestPipelineRunner_StreamingAndTimeout(t *testing.T) {
	verifier := NewASTCommandVerifier()
	runner := NewPipelineRunner(verifier, 15*time.Second)

	// Safe command execution
	res, err := runner.Execute(context.Background(), Candidate{
		ActionType: "sh",
		Command:    "echo 'hello jev pipeline'",
	}, "")
	if err != nil {
		t.Fatalf("pipeline execution failed: %v", err)
	}
	if !res.Success {
		t.Fatalf("expected success, got error: %s", res.Error)
	}
	if !strings.Contains(res.Output, "hello jev pipeline") {
		t.Errorf("expected output to contain 'hello jev pipeline', got: %q", res.Output)
	}
	if !strings.Contains(res.Markdown, "> ") && !strings.Contains(res.Markdown, "```") {
		t.Errorf("expected markdown formatted as blockquote or code block, got: %q", res.Markdown)
	}
}

func TestPipelineRunner_BlockedExecution(t *testing.T) {
	verifier := NewASTCommandVerifier()
	runner := NewPipelineRunner(verifier, 15*time.Second)

	// Destructive command should be stopped by AST verifier
	res, err := runner.Execute(context.Background(), Candidate{
		ActionType: "sh",
		Command:    "rm -rf /",
	}, "")
	if err == nil && res.Success {
		t.Fatalf("destructive command should not succeed")
	}
	if res.Success {
		t.Errorf("expected success to be false for blocked command")
	}
}
