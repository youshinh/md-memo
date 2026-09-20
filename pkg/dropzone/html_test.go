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
	// The phone talks to the batch endpoint, the shared-text poller and the
	// activity ping, all carrying the token in the query.
	for _, want := range []string{"/upload-batch?token=", "/shared?token=", "/ping?token="} {
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

// isEmojiRune flags a rune as emoji, except U+2715 (✕) which is the app's
// one allowed glyph for close/remove controls.
func isEmojiRune(r rune) bool {
	if r == 0x2715 {
		return false
	}
	return (r >= 0x1F300 && r <= 0x1FAFF) || (r >= 0x2600 && r <= 0x27BF) || r == 0xFE0F
}

// The app draws every icon as a line SVG; emoji render differently on every OS and break that.
func TestUserFacingTextHasNoEmoji(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	section := FormatSection(KindText, "photo.png", "body", time.Date(2026, 9, 20, 10, 5, 9, 0, time.UTC), nil)
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

// Camera, file chooser, then text - the order the user asked for.
func TestPageOrderIsCameraFileText(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	camera := strings.Index(page, `id="photoInput"`)
	file := strings.Index(page, `id="fileInput"`)
	text := strings.Index(page, `id="textInput"`)
	if camera < 0 || file < 0 || text < 0 {
		t.Fatalf("the page lost a control: camera=%d file=%d text=%d", camera, file, text)
	}
	if !(camera < file && file < text) {
		t.Errorf("order must be camera < file < text, got camera=%d file=%d text=%d", camera, file, text)
	}
}

// The native <input type=file> reads "choose file" even when it opens the camera, which is
// what confused people: the camera and the file chooser are separate, plainly labelled buttons.
func TestCameraAndFileChoosersAreLabelledButtons(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	for _, want := range []string{
		`<label class="action" for="photoInput">`,
		`<label class="action" for="fileInput">`,
		`カメラで撮影`,
		`ファイルを選択`,
		`id="photoInput" class="sr-only" accept="image/*" capture="environment"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page is missing %q", want)
		}
	}
	// The file chooser also takes photos from the library, as well as the text files, and now
	// accepts more than one at a time for the send tray.
	fileInput := page[strings.Index(page, `id="fileInput"`):]
	fileInput = fileInput[:strings.Index(fileInput, ">")]
	for _, accepted := range []string{"image/*", ".md", ".txt", "multiple"} {
		if !strings.Contains(fileInput, accepted) {
			t.Errorf("the file chooser must accept %s: %s", accepted, fileInput)
		}
	}
	// Only the camera asks the phone to open the camera directly.
	if strings.Contains(fileInput, "capture") {
		t.Errorf("the file chooser must not force the camera: %s", fileInput)
	}
	// Neither native control is drawn.
	if strings.Contains(page, `<input type="file" id="photoInput" accept`) {
		t.Error("the native camera input must not be shown as the button")
	}
}

// The send tray is a batch of files plus optional text, submitted in one request.
func TestPageHasSendTrayAndBatchEndpoint(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	for _, want := range []string{
		`id="trayList"`,
		`id="sendAllBtn"`,
		`id="textInput"`,
		`id="sharedCard"`,
		`id="copySharedBtn"`,
		`id="voiceBtn"`,
		`id="voiceFallbackInput"`,
		`/upload-batch?token=`,
		`upload.addEventListener('progress'`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("page is missing %q", want)
		}
	}
}

// Geolocation must only ever be attempted over HTTPS (a plain-HTTP LAN page
// must never even try, per the spec's "HTTPS限定・非侵襲" requirement).
func TestPageGeolocationIsHTTPSOnly(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if !strings.Contains(page, "location.protocol === 'https:'") {
		t.Error("page is missing the HTTPS-only guard around geolocation")
	}
}

// The status line must be announced to assistive tech as it changes.
func TestStatusLineIsAriaLive(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if !strings.Contains(page, `id="status" aria-live="polite"`) {
		t.Error("the status line should carry aria-live so screen readers announce it")
	}
}

// /shared polling must stop once the page is hidden, and legacy field
// names / endpoints referenced from JS must not linger.
func TestPageSharedPollingRespectsVisibility(t *testing.T) {
	page, err := renderPage("tok")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if !strings.Contains(page, "visibilitychange") {
		t.Error("page must react to visibilitychange to stop polling /shared in the background")
	}
}

// The page is a plain string with one placeholder: it must appear exactly once in the source and
// never survive into the rendered page, and the package must not pull in html/template again.
func TestTokenPlaceholderIsSubstitutedExactlyOnce(t *testing.T) {
	if n := strings.Count(pageSource, tokenPlaceholder); n != 1 {
		t.Fatalf("pageSource contains the token placeholder %d times, want exactly 1", n)
	}
	page, err := renderPage("abc123")
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if strings.Contains(page, tokenPlaceholder) {
		t.Error("the placeholder must not remain in the rendered page")
	}
	if strings.Contains(page, "{{") {
		t.Error("stray template syntax in the page")
	}
}
