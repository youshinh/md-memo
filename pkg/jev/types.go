package jev

// Candidate represents an autonomous action candidate suggested by Jev.
type Candidate struct {
	ActionType  string  `json:"action_type"` // "sh", "ai", "doc"
	Command     string  `json:"command"`
	Description string  `json:"description"`
	Scope       string  `json:"scope"`                // "local", "global"
	Confidence  float64 `json:"confidence,omitempty"` // Probability score P(action)
}

// Slot represents a discrete cell in the MAP-Elites feature space.
type Slot struct {
	Axis1 string `json:"axis1"` // "deterministic", "generative"
	Axis2 string `json:"axis2"` // "local", "global"
}

// OrthogonalSelector defines the MAP-Elites beam selector configuration.
type OrthogonalSelector struct {
	Slots []Slot
}

// ValidationResult holds the verdict of the AST static analysis guardrail.
type ValidationResult struct {
	IsSafe  bool   `json:"isSafe"`
	Reason  string `json:"reason"`
	Command string `json:"command"`
	// ParseFailed is true when IsSafe=false was caused by the command failing to parse
	// under the verifier's grammar (e.g. PowerShell syntax fed to the sh/bash parser),
	// rather than by an actual safety-rule violation. Callers that want to treat "could
	// not analyze" differently from "analyzed and found unsafe" should check this field;
	// existing callers that only inspect IsSafe/Reason are unaffected.
	ParseFailed bool `json:"parseFailed,omitempty"`
	// Rule identifies which guardrail rule produced IsSafe=false: "empty", "fork-bomb", "parse",
	// "destructive", "unquoted-var" or "protected-redirect". Empty when IsSafe=true.
	Rule string `json:"rule,omitempty"`
	// Subject is the offending command name, variable name or redirect target for Rule.
	Subject string `json:"subject,omitempty"`
}

// CommandVerifier is the contract for deterministic AST syntax analysis.
type CommandVerifier interface {
	Verify(cmd string) (ValidationResult, error)
}

// JevPredictRequest represents the prediction payload sent to Jev Engine.
type JevPredictRequest struct {
	BufferContext string `json:"buffer_context"`
	CursorOffset  int    `json:"cursor_offset"`
	GrammarSchema string `json:"grammar_schema"`
	MaxCandidates int    `json:"max_candidates"`
}

// JevPredictResponse is returned to the frontend for inline rendering.
type JevPredictResponse struct {
	Candidates []Candidate `json:"candidates"`
	RawGrammar string      `json:"raw_grammar,omitempty"`
}

// JevExecuteResult represents the execution outcome of an accepted candidate.
type JevExecuteResult struct {
	Success    bool   `json:"success"`
	Output     string `json:"output"`
	Error      string `json:"error,omitempty"`
	Markdown   string `json:"markdown"` // Formatted markdown to append/insert
	ActionType string `json:"action_type"`
}

// AgentTask represents a task dispatched to an AI Agent.
type AgentTask struct {
	ID          string `json:"id"`
	Prompt      string `json:"prompt"`
	Context     string `json:"context"`
	TargetAgent string `json:"target_agent"`
}

// ExecutionPlan specifies whether to run directly or escalate to an LLM agent.
type ExecutionPlan struct {
	ActionType      string  `json:"action_type"` // "direct" vs "escalated"
	Confidence      float64 `json:"confidence"`
	SelectedCommand string  `json:"selected_command"`
	TargetAgent     string  `json:"target_agent"`
	PrunedContext   string  `json:"pruned_context"`
	ShouldEscalate  bool    `json:"should_escalate"`
}

// ScoreResult represents the expected value (weighted average) of an ordered discrete scale.
// Used by ASTCommandVerifier.ScoreCommand (destructive-impact scoring of a shell command) —
// unrelated to the Jev System One wire format below, which deliberately does NOT reuse this
// name (its per-question answers all live in one SystemOneAnswer struct instead).
type ScoreResult struct {
	Score         float64   `json:"score"`         // Weighted average (expected value)
	Probabilities []float64 `json:"probabilities"` // Probability mass at each discrete step
}

// --- TypeSafe AI / Jev System One wire format ---
//
// POST https://api.typesafe.ai/v1/systemone (lowercase path; an earlier version of this client
// sent "/v1/systemOne" and had never actually been exercised against the real service).
// Verified 2026-09-20 against the first-party HTTP API reference (docs.typesafe.ai/api.md) and
// primitives reference (docs.typesafe.ai/primitives.md). The real wire format is ONE
// "questions" map keyed by question id, each entry carrying its own "type" discriminator
// ("choice" | "score" | "noul"), and correspondingly one "answers" map in the response — not
// three separate choices/nouls/scores maps as an earlier version of these types assumed.
//
// Jev does not generate text (see docs.typesafe.ai/model-jaggedness/jev-1.13.md, "Generation");
// it only answers bounded questions about a given State. Do not use it to produce free text.

// SystemOneQuestionType identifies which of the three System One primitives a question uses.
type SystemOneQuestionType string

const (
	QuestionChoice SystemOneQuestionType = "choice"
	QuestionScore  SystemOneQuestionType = "score"
	QuestionNoul   SystemOneQuestionType = "noul"
)

// SystemOneQuestion is one entry of SystemOneRequest.Questions. Instructions may be a string,
// object or array per the API docs — state field paths referenced in it are conventionally
// backtick-quoted, e.g. "Does `ticket.body` request a refund?". Criteria's required shape
// depends on Type:
//   - QuestionChoice: required map[string]string of option -> description (max 255 options)
//   - QuestionScore:  required []string of 2-10 ordered level descriptions (low to high;
//     describe distinct situations, not numerals/degrees)
//   - QuestionNoul:   optional map[string]string{"true": "...", "false": "..."} boundary hints
type SystemOneQuestion struct {
	Type         SystemOneQuestionType `json:"type"`
	Instructions interface{}           `json:"instructions"`
	Criteria     interface{}           `json:"criteria,omitempty"`
}

// SystemOneAnswer is Jev's answer to one question. Only the fields matching Type are populated
// by the real API; systemOneLocal (the offline heuristic fallback) follows the same convention.
// Score/Choice criteria are echoed back keyed by option name (Choice) or by stringified level
// index "0".."n-1" (Score, with Legend mapping those same indices back to their descriptions).
type SystemOneAnswer struct {
	Type          SystemOneQuestionType `json:"type"`
	Noul          float64               `json:"noul,omitempty"`   // QuestionNoul: 0..1, 0.5 = unsure
	Choice        string                `json:"choice,omitempty"` // QuestionChoice: the selected option
	Score         float64               `json:"score,omitempty"`  // QuestionScore: probability-weighted mean level index
	Probabilities map[string]float64    `json:"probabilities,omitempty"`
	Confidence    float64               `json:"confidence,omitempty"` // QuestionChoice/QuestionScore only
	Legend        map[string]string     `json:"legend,omitempty"`     // QuestionScore only: index -> level description
}

// SystemOneUsage reports token accounting for one System One request.
type SystemOneUsage struct {
	InputTokens  int `json:"input_tokens,omitempty"`
	OutputTokens int `json:"output_tokens,omitempty"`
}

// SystemOneRequest is the exact request body for POST https://api.typesafe.ai/v1/systemone.
// Model is required by the real API (e.g. "jev-latest"); NewClient/SystemOne fill it in from
// ClientConfig.Model when the caller leaves it blank.
type SystemOneRequest struct {
	State     interface{}                  `json:"state"`
	Model     string                       `json:"model"`
	Questions map[string]SystemOneQuestion `json:"questions"`
}

// SystemOneResponse is the exact response body from the System One evaluation endpoint.
type SystemOneResponse struct {
	Model   string                     `json:"model,omitempty"`
	Answers map[string]SystemOneAnswer `json:"answers"`
	Usage   SystemOneUsage             `json:"usage,omitempty"`
}
