package jev

import (
	"context"
	"strings"
)

// AgentRouter orchestrates hierarchical routing between Jev fast determination and heavy LLM agents.
type AgentRouter struct {
	JevClient *Client
	Threshold float64
	MaxSteps  int
}

// NewAgentRouter creates a new AgentRouter with the specified confidence threshold (default 0.85).
func NewAgentRouter(client *Client, threshold float64) *AgentRouter {
	if threshold <= 0 {
		threshold = 0.85
	}
	if client == nil {
		client = NewClient(ClientConfig{})
	}
	return &AgentRouter{
		JevClient: client,
		Threshold: threshold,
		MaxSteps:  8,
	}
}

// Dispatch evaluates the input and decides whether to execute directly or escalate to an LLM agent.
func (r *AgentRouter) Dispatch(ctx context.Context, input string) (*ExecutionPlan, error) {
	trimmed := strings.TrimSpace(input)

	// Evaluate confidence score P(action)
	confidence, selectedCmd := r.calculateConfidence(trimmed)

	if confidence >= r.Threshold {
		// High confidence: Deterministic instant execution, bypass heavy LLM
		return &ExecutionPlan{
			ActionType:      "direct",
			Confidence:      confidence,
			SelectedCommand: selectedCmd,
			TargetAgent:     "jev-direct",
			ShouldEscalate:  false,
		}, nil
	}

	// Ambiguous / Complex: Escalate to full LLM agent
	targetAgent := "claude-code"
	if strings.Contains(strings.ToLower(trimmed), "local") || strings.Contains(strings.ToLower(trimmed), "機密") {
		targetAgent = "hermes"
	}

	return &ExecutionPlan{
		ActionType:      "escalated",
		Confidence:      confidence,
		SelectedCommand: trimmed,
		TargetAgent:     targetAgent,
		PrunedContext:   r.PruneContext(trimmed, trimmed),
		ShouldEscalate:  true,
	}, nil
}

// DispatchSystemOne uses TypeSafe AI Jev System 1 primitives (Choice, Noul, Score) for fine-grained routing.
func (r *AgentRouter) DispatchSystemOne(ctx context.Context, input string) (*ExecutionPlan, error) {
	trimmed := strings.TrimSpace(input)

	// Construct System 1 request with triad of primitives
	req := SystemOneRequest{
		State: trimmed,
		Choices: map[string]ChoiceQuestion{
			"action_mode": {
				Name:        "action_mode",
				Description: "Categorical routing decision",
				Options:     []string{"direct_execution", "agent_escalation", "manual_clarification"},
			},
		},
		Nouls: map[string]NoulQuestion{
			"needs_llm": {
				Name:        "needs_llm",
				Description: "Probability that the task requires heavy LLM agent reasoning",
			},
		},
		Scores: map[string]ScoreQuestion{
			"risk_level": {
				Name:        "risk_level",
				Description: "Destructive risk score from 0 (safe) to 2 (destructive)",
				Min:         0,
				Max:         2,
				Step:        1,
				Labels:      []string{"safe_read", "modifying", "destructive"},
			},
		},
	}

	soResp, err := r.JevClient.SystemOne(ctx, req)
	if err != nil {
		// Fallback to heuristic Dispatch if SystemOne encounters an error
		return r.Dispatch(ctx, input)
	}

	noulNeedsLLM := soResp.Nouls["needs_llm"]
	riskScore := soResp.Scores["risk_level"].Score
	choiceRes := soResp.Choices["action_mode"]

	// 1. Clear Direct Execution (Low LLM need < 0.20 AND Safe risk < 1.0)
	if noulNeedsLLM < 0.20 && riskScore < 1.0 {
		return &ExecutionPlan{
			ActionType:      "direct",
			Confidence:      1.0 - noulNeedsLLM,
			SelectedCommand: trimmed,
			TargetAgent:     "jev-direct",
			ShouldEscalate:  false,
		}, nil
	}

	// 2. Clear LLM Escalation (High LLM need >= 0.70 OR Choice escalation OR High risk >= 1.5)
	targetAgent := "claude-code"
	if strings.Contains(strings.ToLower(trimmed), "local") || strings.Contains(strings.ToLower(trimmed), "機密") {
		targetAgent = "hermes"
	}

	if noulNeedsLLM >= 0.70 || riskScore >= 1.5 || choiceRes.Selected == "agent_escalation" {
		return &ExecutionPlan{
			ActionType:      "escalated",
			Confidence:      noulNeedsLLM,
			SelectedCommand: trimmed,
			TargetAgent:     targetAgent,
			PrunedContext:   r.PruneContext(trimmed, trimmed),
			ShouldEscalate:  true,
		}, nil
	}

	// 3. Gray zone / Middle confidence: use threshold-based decision
	shouldEscalate := (1.0 - noulNeedsLLM) < r.Threshold
	actionType := "direct"
	if shouldEscalate {
		actionType = "escalated"
	}

	return &ExecutionPlan{
		ActionType:      actionType,
		Confidence:      choiceRes.Confidence,
		SelectedCommand: trimmed,
		TargetAgent:     targetAgent,
		PrunedContext:   r.PruneContext(trimmed, trimmed),
		ShouldEscalate:  shouldEscalate,
	}, nil
}

// calculateConfidence estimates the probabilistic certainty P(action) of the input.
func (r *AgentRouter) calculateConfidence(input string) (float64, string) {
	lower := strings.ToLower(input)

	// Direct CLI patterns with clear deterministic meaning (P >= 0.85)
	if strings.HasPrefix(lower, "git ") || strings.HasPrefix(lower, "go test") ||
		strings.HasPrefix(lower, "ls ") || lower == "ls" ||
		strings.HasPrefix(lower, "cat ") || strings.HasPrefix(lower, "grep ") {
		return 0.95, input
	}

	// Short deterministic intent keywords
	if lower == "status" || lower == "diff" || lower == "test" {
		if lower == "status" {
			return 0.92, "git status"
		}
		if lower == "diff" {
			return 0.90, "git diff --stat"
		}
		if lower == "test" {
			return 0.92, "go test -v ./..."
		}
	}

	// High complexity indicators (multi-step, architectural audit, refactor whole repo)
	complexityIndicators := []string{
		"全体", "大規模", "アーキテクチャ", "設計書", "脆弱性", "多角的",
		"refactor whole", "architecture audit", "multi-step", "investigate deeply",
	}
	for _, ind := range complexityIndicators {
		if strings.Contains(lower, ind) {
			return 0.45, input // Significantly below 0.85 threshold -> triggers escalation
		}
	}

	// Moderate / conversational intent
	if len(strings.Fields(input)) > 8 {
		return 0.65, input
	}

	return 0.75, input
}

// PruneContext extracts only semantically relevant Markdown blocks, achieving ~90% token reduction.
func (r *AgentRouter) PruneContext(rawMarkdown string, query string) string {
	if strings.TrimSpace(rawMarkdown) == "" {
		return ""
	}

	queryTokens := extractKeywords(query)
	if len(queryTokens) == 0 {
		return rawMarkdown
	}

	// Split by Markdown sections (headings '# ')
	sections := splitMarkdownSections(rawMarkdown)
	if len(sections) == 0 {
		return rawMarkdown
	}

	var relevantSections []string

	for _, sec := range sections {
		secLower := strings.ToLower(sec)
		score := 0

		// Boost sections containing task items
		if strings.Contains(sec, "- [ ]") || strings.Contains(sec, "- [x]") {
			score += 2
		}

		// Count keyword matches
		for _, token := range queryTokens {
			if strings.Contains(secLower, token) {
				score += 3
			}
		}

		if score > 0 {
			relevantSections = append(relevantSections, strings.TrimSpace(sec))
		}
	}

	if len(relevantSections) == 0 {
		// Fallback: return top 500 characters
		if len(rawMarkdown) > 500 {
			return rawMarkdown[:500] + "\n...(pruned)"
		}
		return rawMarkdown
	}

	return strings.Join(relevantSections, "\n\n")
}

// EvaluateLoopConvergence governs multi-step agent loops (WIP=1) to prevent runaways.
func (r *AgentRouter) EvaluateLoopConvergence(task AgentTask, currentStep int, lastOutput string) (bool, float64) {
	// 1. Hard safety limit on loop execution
	if currentStep >= r.MaxSteps {
		return true, 1.0 // Early stopping to prevent infinite loop
	}

	outLower := strings.ToLower(lastOutput)

	// 2. Completion markers
	completionMarkers := []string{
		"task completed", "successfully", "完了", "終了しました",
		"all tests passed", "all unit tests passed",
	}
	for _, marker := range completionMarkers {
		if strings.Contains(outLower, marker) {
			return true, 1.0
		}
	}

	// 3. Progress estimation based on step progression
	progress := float64(currentStep) / float64(r.MaxSteps)
	return false, progress
}

func extractKeywords(query string) []string {
	words := strings.Fields(strings.ToLower(query))
	var tokens []string
	stopWords := map[string]bool{"the": true, "is": true, "in": true, "at": true, "and": true, "or": true, "to": true, "for": true}

	for _, w := range words {
		w = strings.Trim(w, ",.?!'\"`#*()")
		if len(w) >= 3 && !stopWords[w] {
			tokens = append(tokens, w)
		}
	}
	return tokens
}

func splitMarkdownSections(markdown string) []string {
	lines := strings.Split(markdown, "\n")
	var sections []string
	var curSection strings.Builder

	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "#") && curSection.Len() > 0 {
			sections = append(sections, curSection.String())
			curSection.Reset()
		}
		curSection.WriteString(line)
		curSection.WriteString("\n")
	}

	if curSection.Len() > 0 {
		sections = append(sections, curSection.String())
	}

	return sections
}
