package jev

// Candidate represents an autonomous action candidate suggested by Jev.
type Candidate struct {
	ActionType  string  `json:"action_type"` // "sh", "ai", "doc"
	Command     string  `json:"command"`
	Description string  `json:"description"`
	Scope       string  `json:"scope"` // "local", "global"
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
	BufferContext string   `json:"buffer_context"`
	CursorOffset  int      `json:"cursor_offset"`
	GrammarSchema string   `json:"grammar_schema"`
	MaxCandidates int      `json:"max_candidates"`
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

// --- TypeSafe AI / Jev System 1 Primitives (Choice, Noul, Score) ---

// ChoiceQuestion defines an unordered classification question.
type ChoiceQuestion struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Options     []string `json:"options"`
}

// ChoiceResult represents the probabilistic classification verdict.
type ChoiceResult struct {
	Selected      string             `json:"selected"`
	Confidence    float64            `json:"confidence"` // Entropy concentration metric (0..1)
	Probabilities map[string]float64 `json:"probabilities"`
}

// NoulQuestion defines a probability assessment question (0..1).
type NoulQuestion struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Note: In Jev official spec, Noul has no 'confidence' field.
// The returned float64 value (0..1) itself represents the probability:
// - Near 0.0 or 1.0: High conviction
// - Near 0.5: Maximum uncertainty / split decision
type NoulResult = float64

// ScoreQuestion defines an ordered discrete scale question (e.g. risk level 0..2).
type ScoreQuestion struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Min         int      `json:"min"`
	Max         int      `json:"max"`
	Step        int      `json:"step,omitempty"` // Default 1
	Labels      []string `json:"labels,omitempty"` // e.g. ["safe_read", "file_edit", "destructive"]
}

// ScoreResult represents the expected value (weighted average) of the ordered scale.
type ScoreResult struct {
	Score         float64   `json:"score"`         // Weighted average (expected value)
	Probabilities []float64 `json:"probabilities"` // Probability mass at each discrete step
}

// SystemOneRequest represents a request to the official TypeSafe AI Jev endpoint.
type SystemOneRequest struct {
	State     interface{}               `json:"state"` // Context string or structured object
	Choices   map[string]ChoiceQuestion `json:"choices,omitempty"`
	Nouls     map[string]NoulQuestion   `json:"nouls,omitempty"`
	Scores    map[string]ScoreQuestion  `json:"scores,omitempty"`
}

// SystemOneResponse holds the output of the Jev System 1 probabilistic inference.
type SystemOneResponse struct {
	Choices map[string]ChoiceResult `json:"choices,omitempty"`
	Nouls   map[string]NoulResult   `json:"nouls,omitempty"`
	Scores  map[string]ScoreResult  `json:"scores,omitempty"`
}


