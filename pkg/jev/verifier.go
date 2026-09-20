package jev

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Destructive command blacklist
var destructiveCommands = map[string]bool{
	"rm":       true,
	"dd":       true,
	"mkfs":     true,
	"fdisk":    true,
	"wipefs":   true,
	"format":   true,
	"parted":   true,
	"mkswap":   true,
	"sfdisk":   true,
	"diskpart": true,
}

// System directories where redirection is strictly prohibited
var protectedSysDirs = []string{
	"/",
	"/etc",
	"/bin",
	"/sbin",
	"/usr",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/var/run",
	"/lib",
	"/lib64",
	`c:\windows`,
	`c:\program files`,
}

var forkBombRegex = regexp.MustCompile(`:\(\)\s*\{\s*:\|:&\s*\};:`)

// ASTCommandVerifier provides syntax-directed deterministic guardrail using AST parsing.
type ASTCommandVerifier struct {
	// allowUnquotedVars disables the "unquoted-var" rule. It is a style/injection-hygiene rule,
	// used as-is for one-click Quick Actions, but too strict for the AI CLI bar where the user
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
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return ValidationResult{
			IsSafe:  false,
			Reason:  "コマンドが空です (Empty command)",
			Command: cmd,
			Rule:    "empty",
		}, nil
	}

	// 1. Regex pre-filter for raw fork bomb syntax
	if forkBombRegex.MatchString(trimmed) {
		return ValidationResult{
			IsSafe:  false,
			Reason:  "フォーク爆弾パターンを検知しました (Fork bomb detected)",
			Command: cmd,
			Rule:    "fork-bomb",
		}, nil
	}

	// 2. Parse into AST
	// A fresh *syntax.Parser per call: mvdan.cc/sh/v3's Parser keeps internal lexer state
	// across a Parse call and is not safe for concurrent reuse, and ASTCommandVerifier
	// instances are shared App-wide across concurrently running Jev requests.
	parser := syntax.NewParser(syntax.KeepComments(true), syntax.Variant(syntax.LangBash))
	reader := strings.NewReader(trimmed)
	file, err := parser.Parse(reader, "")
	if err != nil {
		return ValidationResult{
			IsSafe:      false,
			Reason:      fmt.Sprintf("構文解析エラー: %v (Bash syntax parse error)", err),
			Command:     cmd,
			ParseFailed: true,
			Rule:        "parse",
		}, nil
	}

	// 3. Walk AST and inspect
	var isSafe = true
	var blockReason = ""
	var blockRule = ""
	var blockSubject = ""
	var blockSeverity = 0

	// The whole AST is always walked and the MOST SEVERE violation is reported, so that a mild
	// finding early in the command can never hide a worse one later (e.g. `rm a; wipefs /dev/sda`).
	// Severity: 3 = disk-level destructive command, 2 = rm / write into a system directory,
	// 1 = unquoted variable expansion. Ties keep the first finding.
	violate := func(severity int, rule, subject, reason string) {
		isSafe = false
		if severity > blockSeverity {
			blockSeverity = severity
			blockRule = rule
			blockSubject = subject
			blockReason = reason
		}
	}

	// Tracking double-quoted contexts to verify unquoted variable expansions
	inDoubleQuotes := false

	syntax.Walk(file, func(node syntax.Node) bool {
		if node == nil {
			return true
		}

		switch n := node.(type) {
		case *syntax.CallExpr:
			if len(n.Args) > 0 {
				cmdName := wordToString(n.Args[0])
				baseName := strings.ToLower(filepath.Base(cmdName))

				// Strip potential extension (e.g. mkfs.ext4 -> mkfs)
				stemName := baseName
				if idx := strings.Index(baseName, "."); idx > 0 {
					stemName = baseName[:idx]
				}

				if destructiveCommands[baseName] || destructiveCommands[stemName] {
					subject := stemName
					if destructiveCommands[baseName] {
						subject = baseName
					}
					severity := 3
					if subject == "rm" {
						severity = 2
					}
					violate(severity, "destructive", subject,
						fmt.Sprintf("破壊的コマンド %q は安全基準により実行を拒否されました (Destructive command blocked)", cmdName))
				}
			}

		case *syntax.DblQuoted:
			prev := inDoubleQuotes
			inDoubleQuotes = true
			for _, part := range n.Parts {
				syntax.Walk(part, func(subNode syntax.Node) bool {
					return true
				})
			}
			inDoubleQuotes = prev
			return false // parts already handled

		case *syntax.ParamExp:
			if !inDoubleQuotes && !v.allowUnquotedVars {
				varName := n.Param.Value
				violate(1, "unquoted-var", varName,
					fmt.Sprintf("未クォート変数の展開 ($%s) を検知しました。意図しない展開やインジェクション防止のためダブルクォートで囲む必要があります (Unquoted variable expansion blocked)", varName))
			}

		case *syntax.Redirect:
			if n.Op == syntax.RdrOut || n.Op == syntax.AppOut || n.Op == syntax.DplOut || n.Op == syntax.ClbOut {
				if n.Word != nil {
					targetPath := wordToString(n.Word)
					if isProtectedSystemPath(targetPath) {
						violate(2, "protected-redirect", targetPath,
							fmt.Sprintf("システム重要ディレクトリ %q へのリダイレクト書き込みは物理的に遮断されています (Protected system path redirect blocked)", targetPath))
					}
				}
			}
		}

		return true
	})

	return ValidationResult{
		IsSafe:  isSafe,
		Reason:  blockReason,
		Command: cmd,
		Rule:    blockRule,
		Subject: blockSubject,
	}, nil
}

// ScoreCommand evaluates the destructive impact of a command on an ordered scale (0: Safe, 1: Modifying, 2: Destructive).
// It returns a Jev ScoreResult with the expected value (weighted average) and discrete probability distribution.
func (v *ASTCommandVerifier) ScoreCommand(cmd string) (*ScoreResult, error) {
	valRes, err := v.Verify(cmd)
	if err != nil {
		return nil, err
	}

	// 3-step discrete scale: [0: Read-only/Safe, 1: State-modifying, 2: Destructive]
	probs := make([]float64, 3)

	if !valRes.IsSafe {
		// Destructive / Violating AST guardrail: concentrate mass on Step 2 (Destructive)
		probs[0] = 0.02
		probs[1] = 0.08
		probs[2] = 0.90
	} else {
		trimmed := strings.TrimSpace(cmd)
		lower := strings.ToLower(trimmed)

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

func wordToString(w *syntax.Word) string {
	if w == nil {
		return ""
	}
	var sb strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			sb.WriteString(p.Value)
		case *syntax.SglQuoted:
			sb.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, sub := range p.Parts {
				if lit, ok := sub.(*syntax.Lit); ok {
					sb.WriteString(lit.Value)
				}
			}
		case *syntax.ParamExp:
			sb.WriteString("$" + p.Param.Value)
		}
	}
	return sb.String()
}

// Pseudo-devices that are routinely used as redirect targets and never modify the system.
var harmlessRedirectTargets = map[string]bool{
	"/dev/null":   true,
	"/dev/stdout": true,
	"/dev/stderr": true,
	"/dev/tty":    true,
}

func isProtectedSystemPath(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	lower := strings.ToLower(clean)

	if lower == "/" {
		return true
	}
	if harmlessRedirectTargets[lower] {
		return false
	}

	for _, dir := range protectedSysDirs {
		dirClean := filepath.ToSlash(filepath.Clean(dir))
		dirLower := strings.ToLower(dirClean)

		if lower == dirLower || strings.HasPrefix(lower, dirLower+"/") {
			return true
		}
	}

	return false
}
