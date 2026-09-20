package jev

import "strings"

// ASTCommandVerifier provides the deterministic, syntax-directed guardrail as a CommandVerifier. It is
// ModeStrict of VerifyCommand: the judgement itself lives in guard.go and guard_ast.go, so this type,
// `md-memo jev verify`, the GUI run gate and the hook runner can never disagree about a command.
type ASTCommandVerifier struct {
	// allowUnquotedVars disables the "unquoted-var" rule. It is a style/injection-hygiene rule,
	// used as-is for one-click Quick Actions, but too strict for a bar where the user
	// reviews the generated command before running it.
	allowUnquotedVars bool
}

// NewASTCommandVerifier creates a new ASTCommandVerifier instance.
func NewASTCommandVerifier() *ASTCommandVerifier {
	return &ASTCommandVerifier{}
}

// NewASTCommandVerifierAllowingUnquotedVars is NewASTCommandVerifier without the "unquoted-var" rule.
// All destructive-command, fork-bomb and protected-redirect rules still apply.
func NewASTCommandVerifierAllowingUnquotedVars() *ASTCommandVerifier {
	v := NewASTCommandVerifier()
	v.allowUnquotedVars = true
	return v
}

// Verify implements CommandVerifier.
func (v *ASTCommandVerifier) Verify(cmd string) (ValidationResult, error) {
	return v.verdict(cmd).ValidationResult(cmd), nil
}

func (v *ASTCommandVerifier) verdict(cmd string) Verdict {
	return verifyCommand(cmd, ModeStrict, nil, v.allowUnquotedVars)
}

// ScoreCommand evaluates the destructive impact of a command on an ordered scale (0: Safe, 1: Modifying, 2: Destructive).
// It returns a Jev ScoreResult with the expected value (weighted average) and discrete probability distribution.
func (v *ASTCommandVerifier) ScoreCommand(cmd string) (*ScoreResult, error) {
	verdict := v.verdict(cmd)

	// 3-step discrete scale: [0: Read-only/Safe, 1: State-modifying, 2: Destructive]
	probs := make([]float64, 3)

	switch verdict.Level {
	case LevelBlock:
		// Destructive / Violating AST guardrail: concentrate mass on Step 2 (Destructive)
		probs[0] = 0.02
		probs[1] = 0.08
		probs[2] = 0.90
	case LevelWarn:
		// Not refused, but the guard could not vouch for it (pipe into an interpreter, a string built at
		// run time): most of the mass on "modifying", some on "destructive".
		probs[0] = 0.05
		probs[1] = 0.70
		probs[2] = 0.25
	default:
		lower := strings.ToLower(strings.TrimSpace(cmd))

		// State-modifying indicators
		isModifying := strings.Contains(lower, "git commit") ||
			strings.Contains(lower, "git push") ||
			strings.Contains(lower, "git merge") ||
			strings.Contains(lower, "mkdir ") ||
			strings.Contains(lower, "touch ") ||
			strings.Contains(lower, "mv ") ||
			strings.Contains(lower, "cp ") ||
			strings.Contains(lower, "echo ") ||
			strings.Contains(lower, "sed ") ||
			strings.Contains(lower, "npm install") ||
			strings.Contains(lower, "go build") ||
			strings.Contains(lower, ">")

		if isModifying {
			probs[0] = 0.10
			probs[1] = 0.85
			probs[2] = 0.05
		} else {
			// Read-only / Reference query (git status, ls, grep, cat, test)
			probs[0] = 0.95
			probs[1] = 0.04
			probs[2] = 0.01
		}
	}

	// Calculate expected value (weighted average): E = 0*P0 + 1*P1 + 2*P2
	expectedScore := (0.0 * probs[0]) + (1.0 * probs[1]) + (2.0 * probs[2])

	return &ScoreResult{
		Score:         expectedScore,
		Probabilities: probs,
	}, nil
}
