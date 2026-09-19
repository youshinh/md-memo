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
	parser *syntax.Parser
}

// NewASTCommandVerifier creates a new ASTCommandVerifier instance.
func NewASTCommandVerifier() *ASTCommandVerifier {
	return &ASTCommandVerifier{
		parser: syntax.NewParser(syntax.KeepComments(true), syntax.Variant(syntax.LangBash)),
	}
}

// Verify implements CommandVerifier.
func (v *ASTCommandVerifier) Verify(cmd string) (ValidationResult, error) {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return ValidationResult{
			IsSafe:  false,
			Reason:  "コマンドが空です (Empty command)",
			Command: cmd,
		}, nil
	}

	// 1. Regex pre-filter for raw fork bomb syntax
	if forkBombRegex.MatchString(trimmed) {
		return ValidationResult{
			IsSafe:  false,
			Reason:  "フォーク爆弾パターンを検知しました (Fork bomb detected)",
			Command: cmd,
		}, nil
	}

	// 2. Parse into AST
	reader := strings.NewReader(trimmed)
	file, err := v.parser.Parse(reader, "")
	if err != nil {
		return ValidationResult{
			IsSafe:  false,
			Reason:  fmt.Sprintf("構文解析エラー: %v (Bash syntax parse error)", err),
			Command: cmd,
		}, nil
	}

	// 3. Walk AST and inspect
	var isSafe = true
	var blockReason = ""

	// Tracking double-quoted contexts to verify unquoted variable expansions
	inDoubleQuotes := false

	syntax.Walk(file, func(node syntax.Node) bool {
		if !isSafe {
			return false // Stop walking on violation
		}
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
					isSafe = false
					blockReason = fmt.Sprintf("破壊的コマンド %q は安全基準により実行を拒否されました (Destructive command blocked)", cmdName)
					return false
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
			if !inDoubleQuotes {
				isSafe = false
				varName := n.Param.Value
				blockReason = fmt.Sprintf("未クォート変数の展開 ($%s) を検知しました。意図しない展開やインジェクション防止のためダブルクォートで囲む必要があります (Unquoted variable expansion blocked)", varName)
				return false
			}

		case *syntax.Redirect:
			if n.Op == syntax.RdrOut || n.Op == syntax.AppOut || n.Op == syntax.DplOut || n.Op == syntax.ClbOut {
				if n.Word != nil {
					targetPath := wordToString(n.Word)
					if isProtectedSystemPath(targetPath) {
						isSafe = false
						blockReason = fmt.Sprintf("システム重要ディレクトリ %q へのリダイレクト書き込みは物理的に遮断されています (Protected system path redirect blocked)", targetPath)
						return false
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

func isProtectedSystemPath(path string) bool {
	clean := filepath.ToSlash(filepath.Clean(path))
	lower := strings.ToLower(clean)

	if lower == "/" {
		return true
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
