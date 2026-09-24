package slotagent

import (
	"testing"
)

// TestGetParserRegexesIsCachedAndComplete pins that the lazy accessor introduced for
// pkg/slotagent/parser.go compiles all five patterns exactly once and hands back the same
// instance on every call (sync.OnceValue semantics), matching the pre-existing package-level-var
// behaviour that callers relied on.
func TestGetParserRegexesIsCachedAndComplete(t *testing.T) {
	first := getParserRegexes()
	second := getParserRegexes()
	if first != second {
		t.Fatalf("expected getParserRegexes to return the same cached instance, got %p and %p", first, second)
	}
	if first.fencedCode == nil || first.inlineCode == nil || first.markdownLink == nil ||
		first.bareURL == nil || first.approvalGate == nil {
		t.Fatalf("expected all five regexes to be compiled, got %+v", first)
	}
}

// TestApprovalGateRegex_TableCases pins FindApprovalGates behaviour (backed by approvalGateRegex)
// across the shapes the human-in-the-loop UI can produce, including cases that must NOT match.
func TestApprovalGateRegex_TableCases(t *testing.T) {
	tests := []struct {
		name       string
		line       string
		wantMatch  bool
		wantDesc   string
		wantApprov bool
	}{
		{"unchecked lowercase gate", "- [ ] do the thing // approve", true, "do the thing", false},
		{"checked lowercase x", "- [x] do the thing // approve", true, "do the thing", true},
		{"checked uppercase X", "- [X] do the thing // approve", true, "do the thing", true},
		{"leading whitespace and tabs", "\t  - [ ] indented step // approve", true, "indented step", false},
		{"extra spacing around markers", "-   [ ]   spaced out step   //   approve", true, "spaced out step", false},
		{"missing approve suffix is not a gate", "- [ ] just a checkbox item", false, "", false},
		{"missing checkbox is not a gate", "next step description // approve", false, "", false},
		{"trailing text after approve breaks the match", "- [ ] step // approve now", false, "", false},
		{"case-insensitive approve keyword is not honored", "- [ ] step // APPROVE", false, "", false},
		{"japanese description", "- [ ] 次のステップを実行する // approve", true, "次のステップを実行する", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gates := FindApprovalGates(tt.line)
			if tt.wantMatch {
				if len(gates) != 1 {
					t.Fatalf("expected 1 gate, got %d for line %q", len(gates), tt.line)
				}
				if gates[0].StepDesc != tt.wantDesc {
					t.Errorf("StepDesc = %q, want %q", gates[0].StepDesc, tt.wantDesc)
				}
				if gates[0].IsApproved != tt.wantApprov {
					t.Errorf("IsApproved = %v, want %v", gates[0].IsApproved, tt.wantApprov)
				}
			} else if len(gates) != 0 {
				t.Errorf("expected no gates for line %q, got %d: %+v", tt.line, len(gates), gates)
			}
		})
	}
}

// TestBareURLRegex_TableCases pins the bareURLRegex matching behaviour used by
// FindExcludedRanges to keep AI-facing prompts from being parsed as slot delimiters. It matches
// on the regex directly (rather than through ParseSlots) so the exact matched substring - not
// just whether a slot was excluded - stays pinned.
func TestBareURLRegex_TableCases(t *testing.T) {
	re := getParserRegexes().bareURL

	tests := []struct {
		name  string
		input string
		want  []string
	}{
		{"plain http url", "http://example.com", []string{"http://example.com"}},
		{"plain https url", "https://example.com", []string{"https://example.com"}},
		{"url with path and query", "https://example.com/path?q=1&x=2", []string{"https://example.com/path?q=1&x=2"}},
		{"url stops at whitespace", "see https://example.com here", []string{"https://example.com"}},
		{"url stops at closing square bracket", "[https://example.com]", []string{"https://example.com"}},
		{"url includes trailing paren (not excluded char)", "(https://example.com)", []string{"https://example.com)"}},
		{"url stops at angle bracket", "<https://example.com>", []string{"https://example.com"}},
		{"url stops at double quote", `"https://example.com"`, []string{"https://example.com"}},
		{"url stops at backtick", "`https://example.com`", []string{"https://example.com"}},
		{"multiple urls in one line", "https://a.com and https://b.com", []string{"https://a.com", "https://b.com"}},
		{"no url present", "no links here", nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := re.FindAllString(tt.input, -1)
			if len(got) != len(tt.want) {
				t.Fatalf("FindAllString(%q) = %v, want %v", tt.input, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("match[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}
