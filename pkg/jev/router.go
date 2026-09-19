package jev

import (
	"strings"
)

// RouteDecision represents the 2-level shallow decision tree evaluation.
type RouteDecision struct {
	Level1Method string // "deterministic" vs "generative"
	Level2Effect string // "read" vs "write"
	Candidate    Candidate
}

// DecisionRouter routes candidates based on method and side effect.
type DecisionRouter struct{}

// NewDecisionRouter creates a new DecisionRouter.
func NewDecisionRouter() *DecisionRouter {
	return &DecisionRouter{}
}

// Route evaluates the candidate through the 2-level shallow decision tree.
func (r *DecisionRouter) Route(c Candidate) RouteDecision {
	// Level 1: Method classification
	method := "generative"
	if c.ActionType == "sh" {
		method = "deterministic"
	}

	// Level 2: Side-effect classification (Read vs Write)
	effect := "read"
	cmdLower := strings.ToLower(c.Command)

	if method == "deterministic" {
		writeKeywords := []string{
			"commit", "push", "apply", "mv ", "cp ", "touch ", "mkdir ",
			"sed -i", "tee ", ">>", ">", "install", "build -o",
		}
		for _, kw := range writeKeywords {
			if strings.Contains(cmdLower, kw) {
				effect = "write"
				break
			}
		}
	} else {
		// AI/Doc: code generation or doc modification is write-intent
		if strings.Contains(cmdLower, "generate") || strings.Contains(cmdLower, "refactor") ||
			strings.Contains(cmdLower, "update") || strings.Contains(cmdLower, "create") ||
			strings.Contains(cmdLower, "fix") {
			effect = "write"
		}
	}

	return RouteDecision{
		Level1Method: method,
		Level2Effect: effect,
		Candidate:    c,
	}
}
