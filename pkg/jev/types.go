package jev

// Candidate represents an autonomous action candidate suggested by Jev.
type Candidate struct {
	ActionType  string `json:"action_type"` // "sh", "ai", "doc"
	Command     string `json:"command"`
	Description string `json:"description"`
	Scope       string `json:"scope"` // "local", "global"
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
