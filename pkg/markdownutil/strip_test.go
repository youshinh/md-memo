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
