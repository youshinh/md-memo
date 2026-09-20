package jev

import (
	"regexp"
	"strings"
	"sync"
)

type psSet struct {
	rangeRe    *regexp.Regexp
	verbNounRe *regexp.Regexp
}

// psTables is compiled on first use. IsPowerShellSyntax runs before every CLI filter on Windows, but a
// user who only ever runs `sort` should not pay for two patterns at start-up.
var psTables = sync.OnceValue(func() *psSet {
	return &psSet{
		rangeRe:    regexp.MustCompile(`\b\d+\.\.\d+\b`),
		verbNounRe: regexp.MustCompile(`(?i)\b(Get|Set|New|Remove|Test|Start|Stop|Restart|Invoke|Write|Read|Clear|Copy|Move|Rename|Select|Measure)-[A-Za-z]+\b`),
	}
})

// IsPowerShellSyntax reports whether the command appears to use PowerShell-specific syntax or cmdlets.
// The guard uses it to skip the bash AST (which cannot read PowerShell), and the Windows CLI runner uses
// it to choose the shell.
func IsPowerShellSyntax(cmdStr string) bool {
	trimmed := strings.TrimSpace(cmdStr)
	if strings.HasPrefix(trimmed, "|") {
		return true
	}

	lower := strings.ToLower(trimmed)

	if strings.HasPrefix(lower, "powershell") || strings.HasPrefix(lower, "pwsh") {
		return true
	}
	if strings.HasPrefix(lower, "$input") {
		return true
	}
	if lower == "sort -r" || lower == "sort -u" || lower == "uniq" {
		return true
	}

	psKeywords := []string{
		"$_", "$psitem", "$true", "$false", "$null",
		"$(", "${",
		"foreach-object", "where-object", "select-object", "measure-object",
		"sort-object", "group-object", "compare-object",
		"get-content", "set-content", "out-string", "out-file", "out-null",
		"test-connection", "test-path", "test-netconnection",
		"invoke-webrequest", "invoke-restmethod", "invoke-expression",
		"| %", "| ?", "| %{", "| ?{",
	}
	for _, kw := range psKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}

	ps := psTables()
	if ps.rangeRe.MatchString(trimmed) {
		return true
	}
	if ps.verbNounRe.MatchString(trimmed) {
		return true
	}
	if strings.Contains(trimmed, "{") && strings.Contains(trimmed, "}") {
		return true
	}

	return false
}
