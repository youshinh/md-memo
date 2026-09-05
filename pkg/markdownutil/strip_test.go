package markdownutil

import (
	"strings"
	"testing"
)

func TestStripMarkdown(t *testing.T) {
	input := "# タイトル\n\n" +
		"これは **太字** と *斜体* と ~~取り消し~~ のテストです。\n\n" +
		"- [ ] リスト項目1\n" +
		"- [x] リスト項目2\n" +
		"* リスト項目3\n\n" +
		"> これは引用文です。\n\n" +
		"[リンクテキスト](https://example.com)\n" +
		"![画像説明](https://example.com/image.png)\n\n" +
		"```python\n" +
		"def hello():\n" +
		"    print(\"world\")\n" +
		"```\n\n" +
		"インライン `code` です。\n\n" +
		"$E=mc^2$ および $$x^2 + y^2 = z^2$$\n"

	plain := StripMarkdown(input)

	if strings.Contains(plain, "# タイトル") {
		t.Errorf("expected header markdown removed, got %q", plain)
	}
	if !strings.Contains(plain, "タイトル") {
		t.Errorf("expected text 'タイトル' preserved, got %q", plain)
	}
	if strings.Contains(plain, "**太字**") {
		t.Errorf("expected bold syntax removed, got %q", plain)
	}
	if !strings.Contains(plain, "太字") {
		t.Errorf("expected text '太字' preserved, got %q", plain)
	}
	if strings.Contains(plain, "https://example.com") {
		t.Errorf("expected link url stripped, got %q", plain)
	}
	if !strings.Contains(plain, "リンクテキスト") {
		t.Errorf("expected link text preserved, got %q", plain)
	}
	if !strings.Contains(plain, "print(\"world\")") {
		t.Errorf("expected code body preserved, got %q", plain)
	}
}

func TestStripMarkdown_Table(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Headers",
			input:    "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6",
			expected: "H1\nH2\nH3\nH4\nH5\nH6\n",
		},
		{
			name:     "Bold and Italics",
			input:    "**Bold1** __Bold2__ *Italic1* _Italic2_",
			expected: "Bold1 Bold2 Italic1 Italic2\n",
		},
		{
			name:     "Strikethrough",
			input:    "~~Strike~~",
			expected: "Strike\n",
		},
		{
			name:     "Lists",
			input:    "- Item 1\n* Item 2\n+ Item 3\n1. Item 4\n2. Item 5",
			expected: "Item 1\nItem 2\nItem 3\nItem 4\nItem 5\n",
		},
		{
			name:     "Task Lists",
			input:    "- [ ] Todo\n- [x] Done\n* [X] Also Done",
			expected: "Todo\nDone\nAlso Done\n",
		},
		{
			name:     "Blockquotes",
			input:    "> Quote 1\n>Quote 2",
			expected: "Quote 1\nQuote 2\n",
		},
		{
			name:     "Links and Images",
			input:    "[OpenAI](https://openai.com) ![Logo](logo.png)",
			expected: "OpenAI Logo\n",
		},
		{
			name:     "Code",
			input:    "`inline code`\n```go\nfunc main() {}\n```",
			expected: "inline code\nfunc main() {}\n",
		},
		{
			name:     "Math",
			input:    "$x=1$ $$y=2$$",
			expected: "x=1 y=2\n",
		},
		{
			name:     "Horizontal Rules",
			input:    "---\n***\n___",
			expected: "\n",
		},
		{
			name:     "Empty String",
			input:    "",
			expected: "\n",
		},
		{
			name:     "Plain Text",
			input:    "Just plain text.",
			expected: "Just plain text.\n",
		},
		{
			name:     "Multiple Newlines",
			input:    "Line 1\n\n\nLine 2",
			expected: "Line 1\n\n\nLine 2\n",
		},
		{
			name:     "Complex Example",
			input:    "# Title\n\nSome **bold** and *italic* text.\n\n- [ ] Task 1\n- [x] Task 2",
			expected: "Title\n\nSome bold and italic text.\nTask 1\nTask 2\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StripMarkdown(tt.input)
			if got != tt.expected {
				t.Errorf("StripMarkdown() = %q, want %q", got, tt.expected)
			}
		})
	}
}
