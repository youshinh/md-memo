package jev

import (
	"strings"
	"testing"
)

func TestFormatMarkdownExecutionResult_EmptyOutputStillReportsARun(t *testing.T) {
	c := Candidate{ActionType: "sh", Command: "git status -s"}

	for _, output := range []string{"", "  \n"} {
		got := FormatMarkdownExecutionResult(c, output, true)
		want := "\n- [x] sh git status -s\n  > (出力なし)\n"
		if got != want {
			t.Errorf("empty output %q: got %q, want %q", output, got, want)
		}
	}
}

func TestFormatMarkdownExecutionResult_WithOutputHasNoEmptyMarker(t *testing.T) {
	c := Candidate{ActionType: "sh", Command: "git status -s"}

	short := FormatMarkdownExecutionResult(c, " M app.go", true)
	if !strings.Contains(short, "  >  M app.go\n") || strings.Contains(short, "出力なし") {
		t.Errorf("short output should be a blockquote without the empty marker, got %q", short)
	}

	long := FormatMarkdownExecutionResult(c, "a\nb\nc\nd", true)
	if !strings.Contains(long, "  ```\n") || strings.Contains(long, "出力なし") {
		t.Errorf("long output should be a fenced block without the empty marker, got %q", long)
	}
}
