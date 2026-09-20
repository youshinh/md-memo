package dropzone

import (
	"strings"
	"testing"
	"time"
)

func TestRenderPageSucceedsAndCarriesTheToken(t *testing.T) {
	page, err := renderPage("abc123")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if !strings.Contains(page, `var TOKEN = "abc123";`) {
		t.Errorf("the token must be baked in as a JS string literal")
	}
	// The phone posts to relative URLs carrying the token in the query.
	for _, want := range []string{"'/upload?token='", "'/upload-text?token='"} {
		if !strings.Contains(page, want) {
			t.Errorf("page script is missing %s", want)
		}
	}
}

func TestRenderPageCannotBeBrokenOutOfByTheToken(t *testing.T) {
	page, err := renderPage(`x"</script><script>alert(1)</script>`)
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if strings.Contains(page, "</script><script>alert(1)") {
		t.Errorf("a hostile token must not be able to close the script tag: %s", page)
	}
}

func isEmojiRune(r rune) bool {
	return (r >= 0x1F300 && r <= 0x1FAFF) || (r >= 0x2600 && r <= 0x27BF) || r == 0xFE0F
}

// The app draws every icon as a line SVG; emoji render differently on every OS and break that.
func TestUserFacingTextHasNoEmoji(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	section := FormatSection(KindText, "photo.png", "body", time.Date(2026, 9, 20, 10, 5, 9, 0, time.UTC))
	for name, text := range map[string]string{"phone page": page, "note section": section} {
		for _, r := range text {
			if isEmojiRune(r) {
				t.Errorf("%s contains the emoji %q (U+%04X): use a line SVG icon or plain text", name, r, r)
			}
		}
	}
	if got := strings.Count(page, "<svg"); got < 3 {
		t.Errorf("the three phone-page cards should each carry a line icon, found %d svg elements", got)
	}
}
