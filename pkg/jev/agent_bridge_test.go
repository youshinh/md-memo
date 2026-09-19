package jev

import (
	"context"
	"strings"
	"testing"
)

func TestAgentRouter_Dispatch(t *testing.T) {
	client := NewClient(ClientConfig{})
	router := NewAgentRouter(client, 0.85)

	// 1. High confidence deterministic action (P >= 0.85) -> Direct execution, NO escalation
	plan1, err := router.Dispatch(context.Background(), "git status")
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}
	if plan1.ShouldEscalate {
		t.Errorf("expected direct execution for high confidence command, but got escalated")
	}
	if plan1.Confidence < 0.85 {
		t.Errorf("expected confidence >= 0.85, got %f", plan1.Confidence)
	}
	if plan1.ActionType != "direct" {
		t.Errorf("expected action type 'direct', got %s", plan1.ActionType)
	}

	// 2. Ambiguous / Complex task (P < 0.85) -> Escalated to LLM agent
	complexTask := "リポジトリ全体のアーキテクチャ脆弱性を多角的に監査し、設計書を更新した上で修正計画を立案してください"
	plan2, err := router.Dispatch(context.Background(), complexTask)
	if err != nil {
		t.Fatalf("dispatch failed: %v", err)
	}
	if !plan2.ShouldEscalate {
		t.Errorf("expected escalation for complex task, but got direct")
	}
	if plan2.Confidence >= 0.85 {
		t.Errorf("expected confidence < 0.85 for complex task, got %f", plan2.Confidence)
	}
	if plan2.ActionType != "escalated" {
		t.Errorf("expected action type 'escalated', got %s", plan2.ActionType)
	}
}

func TestAgentRouter_DispatchSystemOne(t *testing.T) {
	client := NewClient(ClientConfig{})
	router := NewAgentRouter(client, 0.85)

	// 1. High confidence / low risk command -> Direct execution
	planDirect, err := router.DispatchSystemOne(context.Background(), "git status")
	if err != nil {
		t.Fatalf("DispatchSystemOne failed: %v", err)
	}
	if planDirect.ShouldEscalate {
		t.Errorf("expected direct execution for 'git status', got escalated")
	}
	if planDirect.ActionType != "direct" {
		t.Errorf("expected action type 'direct', got %s", planDirect.ActionType)
	}

	// 2. High complexity task -> Escalated to Claude Code
	complexTask := "リポジトリ全体のアーキテクチャ再設計と全体リファクタリングを実施する"
	planEscalate, err := router.DispatchSystemOne(context.Background(), complexTask)
	if err != nil {
		t.Fatalf("DispatchSystemOne failed: %v", err)
	}
	if !planEscalate.ShouldEscalate {
		t.Errorf("expected escalation for complex task, got direct")
	}
	if planEscalate.TargetAgent != "claude-code" {
		t.Errorf("expected target agent 'claude-code', got %s", planEscalate.TargetAgent)
	}

	// 3. Local/confidential task -> Escalated to Hermes
	localTask := "機密コードのローカル解析と設計書の修正"
	planLocal, err := router.DispatchSystemOne(context.Background(), localTask)
	if err != nil {
		t.Fatalf("DispatchSystemOne failed: %v", err)
	}
	if planLocal.TargetAgent != "hermes" {
		t.Errorf("expected target agent 'hermes' for confidential task, got %s", planLocal.TargetAgent)
	}

	// 4. Destructive command -> Escalated / guarded
	planDestructive, err := router.DispatchSystemOne(context.Background(), "rm -rf /var/data")
	if err != nil {
		t.Fatalf("DispatchSystemOne failed: %v", err)
	}
	if !planDestructive.ShouldEscalate {
		t.Errorf("expected escalation for destructive command, got direct")
	}
}

func TestAgentRouter_PruneContext(t *testing.T) {
	router := NewAgentRouter(nil, 0.85)

	longDoc := `# Project Overview
This is a general overview that is very long.
` + strings.Repeat("Some background paragraph text.\n", 50) + `

## Authentication Module
- [ ] sh go test ./pkg/auth
Important auth token verification logic is here.
Secret key handling and OAuth2 flow.

## Database Migrations
` + strings.Repeat("Some irrelevant database notes.\n", 50)

	query := "auth token verification"
	pruned := router.PruneContext(longDoc, query)

	// S/N ratio check: pruned text should contain auth section but be significantly smaller than raw text
	if !strings.Contains(pruned, "Authentication Module") {
		t.Errorf("pruned context should preserve relevant 'Authentication Module' section")
	}
	if !strings.Contains(pruned, "Important auth token verification") {
		t.Errorf("pruned context should contain matching query keywords")
	}

	rawLen := len(longDoc)
	prunedLen := len(pruned)
	reductionRatio := float64(rawLen-prunedLen) / float64(rawLen)

	if reductionRatio < 0.50 {
		t.Errorf("expected at least 50%% context pruning reduction, got %f (raw: %d, pruned: %d)", reductionRatio, rawLen, prunedLen)
	}
}

func TestAgentRouter_EvaluateLoopConvergence(t *testing.T) {
	router := NewAgentRouter(nil, 0.85)

	task := AgentTask{
		ID:     "task-1",
		Prompt: "Implement feature and write unit tests",
	}

	// Step 1: In progress
	stop1, progress1 := router.EvaluateLoopConvergence(task, 1, "created file and implemented function")
	if stop1 {
		t.Errorf("should not stop at step 1")
	}
	if progress1 >= 1.0 {
		t.Errorf("progress should be < 1.0 at step 1")
	}

	// Step 2: Task completed with clear marker
	stop2, progress2 := router.EvaluateLoopConvergence(task, 2, "all unit tests passed successfully. Task completed.")
	if !stop2 {
		t.Errorf("should stop when task indicates completion")
	}
	if progress2 < 1.0 {
		t.Errorf("progress should be 1.0 upon completion")
	}

	// Step 10: Early stopping / safety barrier against infinite loops
	stopMax, _ := router.EvaluateLoopConvergence(task, 10, "still running something")
	if !stopMax {
		t.Errorf("should trigger early stopping on maximum step threshold to prevent runaways")
	}
}
