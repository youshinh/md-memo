package jev

import (
	"strings"
	"testing"
)

func TestParseTaskActionItems(t *testing.T) {
	// Mixed input containing conversational noise, markdown preamble, and valid EBNF items
	rawLLMOutput := `了解しました。以下のタスクを提案します。

- [ ] sh git diff --stat
- [ ] ai generate unit test for auth module
- [ ] doc update docs/architecture.md with latest design
- [x] invalid completed checkbox should be skipped
some random conversational trailing text.
`

	items := ParseTaskActionItems(rawLLMOutput)
	if len(items) != 3 {
		t.Fatalf("expected 3 valid task items, got %d", len(items))
	}

	if items[0].ActionType != "sh" || items[0].Command != "git diff --stat" {
		t.Errorf("item 0 mismatch: %+v", items[0])
	}
	if items[1].ActionType != "ai" || items[1].Command != "generate unit test for auth module" {
		t.Errorf("item 1 mismatch: %+v", items[1])
	}
	if items[2].ActionType != "doc" || items[2].Command != "update docs/architecture.md with latest design" {
		t.Errorf("item 2 mismatch: %+v", items[2])
	}
}

func TestFormatTaskItem(t *testing.T) {
	c := Candidate{
		ActionType: "sh",
		Command:    "ls -la",
	}
	formatted := FormatTaskItem(c)
	expected := "- [ ] sh ls -la\n"
	if formatted != expected {
		t.Errorf("expected %q, got %q", expected, formatted)
	}
}

func TestEBNFSchemaPresence(t *testing.T) {
	schema := TaskActionEBNF
	if !strings.Contains(schema, "task_list") || !strings.Contains(schema, "action_type") {
		t.Errorf("EBNF schema missing key rules: %s", schema)
	}
}
