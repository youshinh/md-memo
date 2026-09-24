package main

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/llm"
)

func pt(x, y int) image.Point { return image.Point{X: x, Y: y} }

func rc(x0, y0, x1, y1 int) image.Rectangle { return image.Rect(x0, y0, x1, y1) }

// Two overlapping windows, top first, the way EnumWindows lists them: B is in front of A.
func testWindows() []capWindow {
	return []capWindow{
		{HWND: 2, Rect: rc(300, 100, 700, 400), Title: "B"},
		{HWND: 1, Rect: rc(0, 0, 500, 300), Title: "A"},
	}
}

func TestWindowAt_TopmostWins(t *testing.T) {
	wins := testWindows()
	if w, ok := windowAt(wins, pt(400, 200)); !ok || w.HWND != 2 {
		t.Fatalf("overlap: got %+v ok=%v, want window 2 (in front)", w, ok)
	}
	if w, ok := windowAt(wins, pt(50, 50)); !ok || w.HWND != 1 {
		t.Fatalf("A only: got %+v ok=%v, want window 1", w, ok)
	}
	if _, ok := windowAt(wins, pt(900, 900)); ok {
		t.Fatal("outside every window: want no hit")
	}
	// The right and bottom edges are exclusive, as for image.Rectangle.
	if _, ok := windowAt(wins, pt(700, 200)); ok {
		t.Fatal("right edge is outside the window")
	}
}

func TestNormalizeRect(t *testing.T) {
	want := rc(10, 20, 110, 220)
	for _, c := range [][2]image.Point{
		{pt(10, 20), pt(110, 220)},
		{pt(110, 220), pt(10, 20)},
		{pt(110, 20), pt(10, 220)},
		{pt(10, 220), pt(110, 20)},
	} {
		if got := normalizeRect(c[0], c[1]); got != want {
			t.Errorf("normalizeRect(%v, %v) = %v, want %v", c[0], c[1], got, want)
		}
	}
}

func TestSession_ClickWindowSendsAtOnce(t *testing.T) {
	s := newCapSession(testWindows())
	s.Move(pt(50, 50), false)
	if r, ok := s.Live(); !ok || r != rc(0, 0, 500, 300) {
		t.Fatalf("hover frame = %v ok=%v, want window A's rect", r, ok)
	}
	s.Down(pt(50, 50), false)
	s.Up(pt(52, 51), false) // a slight wobble is still a click
	if !s.Done() || s.Cancelled() {
		t.Fatalf("done=%v cancelled=%v, want done and not cancelled", s.Done(), s.Cancelled())
	}
	got := s.Result()
	if len(got) != 1 || got[0].Kind != capSelWindow || got[0].HWND != 1 || got[0].Title != "A" || got[0].Rect != rc(0, 0, 500, 300) {
		t.Fatalf("result = %+v, want window A with its title and rect", got)
	}
}

func TestSession_DragRectangleSendsOnRelease(t *testing.T) {
	s := newCapSession(testWindows())
	s.Down(pt(100, 100), false)
	s.Move(pt(140, 130), false)
	if r, ok := s.Live(); !ok || r != rc(100, 100, 140, 130) {
		t.Fatalf("live drag frame = %v ok=%v", r, ok)
	}
	s.Up(pt(60, 40), false) // dragged up and to the left
	if !s.Done() {
		t.Fatal("releasing the mouse without Ctrl must send")
	}
	got := s.Result()
	if len(got) != 1 || got[0].Kind != capSelRegion || got[0].Rect != rc(60, 40, 100, 100) || got[0].Title != "" {
		t.Fatalf("result = %+v, want a title-less region 60,40-100,100", got)
	}
}

func TestSession_TinyDragIsIgnored(t *testing.T) {
	s := newCapSession(nil) // no windows: a click hits nothing
	s.Down(pt(100, 100), false)
	s.Move(pt(106, 110), false) // moved past the click slop but the box is under the minimum size
	s.Up(pt(106, 110), false)
	if s.Done() || len(s.Selections()) != 0 {
		t.Fatalf("done=%v selections=%v, want nothing picked and still waiting", s.Done(), s.Selections())
	}
}

func TestSession_ClickOnEmptyDesktopKeepsWaiting(t *testing.T) {
	s := newCapSession(testWindows())
	s.Down(pt(900, 900), false)
	s.Up(pt(900, 900), false)
	if s.Done() || len(s.Selections()) != 0 {
		t.Fatal("a click outside every window must not end the session")
	}
}

func TestSession_CtrlCollectsThenReleaseSendsInOrder(t *testing.T) {
	s := newCapSession(testWindows())

	s.Down(pt(50, 50), true) // window A
	s.Up(pt(50, 50), true)
	if s.Done() {
		t.Fatal("with Ctrl held the first pick must not send")
	}
	s.Down(pt(600, 350), true) // window B
	s.Up(pt(600, 350), true)
	s.Down(pt(800, 500), true) // a free rectangle
	s.Move(pt(900, 560), true)
	s.Up(pt(900, 560), true)
	if s.Done() {
		t.Fatal("still holding Ctrl")
	}
	if n := len(s.Selections()); n != 3 {
		t.Fatalf("selections so far = %d, want 3", n)
	}

	s.CtrlChanged(false)
	if !s.Done() || s.Cancelled() {
		t.Fatalf("done=%v cancelled=%v after Ctrl release", s.Done(), s.Cancelled())
	}
	got := s.Result()
	if len(got) != 3 {
		t.Fatalf("result has %d entries, want 3", len(got))
	}
	if got[0].HWND != 1 || got[1].HWND != 2 || got[2].Kind != capSelRegion {
		t.Fatalf("order = %+v, want window A, window B, region (the order they were picked)", got)
	}
	if got[0].Title != "A" || got[1].Title != "B" {
		t.Fatalf("titles = %q, %q, want A and B", got[0].Title, got[1].Title)
	}
}

func TestSession_CtrlClickAgainRemovesWindow(t *testing.T) {
	s := newCapSession(testWindows())
	s.Down(pt(50, 50), true)
	s.Up(pt(50, 50), true)
	s.Down(pt(50, 50), true)
	s.Up(pt(50, 50), true)
	if len(s.Selections()) != 0 {
		t.Fatalf("selections = %+v, want the second Ctrl+click to take window A out again", s.Selections())
	}
	// With nothing selected, releasing Ctrl has nothing to send and the session goes on.
	s.CtrlChanged(false)
	if s.Done() {
		t.Fatal("no selection: Ctrl release must not end the session")
	}
}

func TestSession_ReleasingCtrlBeforeMouseUpSendsEverything(t *testing.T) {
	s := newCapSession(testWindows())
	s.Down(pt(50, 50), true)
	s.Up(pt(50, 50), true) // window A collected
	s.Down(pt(800, 500), true)
	s.Move(pt(900, 600), true)
	s.CtrlChanged(false) // Ctrl comes up in the middle of the drag: the drag is not over yet
	if s.Done() {
		t.Fatal("a drag in progress must not be cut off by Ctrl release")
	}
	s.Up(pt(900, 600), false)
	if !s.Done() {
		t.Fatal("mouse up without Ctrl sends")
	}
	if got := s.Result(); len(got) != 2 || got[1].Kind != capSelRegion {
		t.Fatalf("result = %+v, want window A then the dragged region", got)
	}
}

func TestSession_EscapeCancels(t *testing.T) {
	s := newCapSession(testWindows())
	s.Down(pt(50, 50), true)
	s.Up(pt(50, 50), true)
	s.Escape()
	if !s.Done() || !s.Cancelled() {
		t.Fatalf("done=%v cancelled=%v, want both", s.Done(), s.Cancelled())
	}
	if got := s.Result(); len(got) != 0 {
		t.Fatalf("cancelled session returned %+v, want nothing", got)
	}
	// Later events are ignored.
	s.Down(pt(400, 200), false)
	s.Up(pt(400, 200), false)
	if got := s.Result(); len(got) != 0 {
		t.Fatalf("events after cancel changed the result: %+v", got)
	}
}

func TestSession_LiveFrameFollowsPointer(t *testing.T) {
	s := newCapSession(testWindows())
	if _, ok := s.Live(); ok {
		t.Fatal("no frame before the pointer has moved")
	}
	s.Move(pt(400, 200), false)
	if r, _ := s.Live(); r != rc(300, 100, 700, 400) {
		t.Fatalf("frame = %v, want window B", r)
	}
	s.Move(pt(50, 50), false)
	if r, _ := s.Live(); r != rc(0, 0, 500, 300) {
		t.Fatalf("frame = %v, want window A", r)
	}
	s.Move(pt(900, 900), false)
	if _, ok := s.Live(); ok {
		t.Fatal("pointer over no window: no frame")
	}
}

func TestWindowNeedsPrint(t *testing.T) {
	desktop := rc(0, 0, 1920, 1080)
	wins := testWindows() // B (2) in front of A (1); they overlap
	a := capSelection{Kind: capSelWindow, HWND: 1, Rect: wins[1].Rect}
	b := capSelection{Kind: capSelWindow, HWND: 2, Rect: wins[0].Rect}

	if !windowNeedsPrint(wins, a, desktop) {
		t.Error("A is partly covered by B: want print")
	}
	if windowNeedsPrint(wins, b, desktop) {
		t.Error("B is in front of everything: read it from the screen")
	}
	off := capSelection{Kind: capSelWindow, HWND: 2, Rect: rc(1800, 100, 2100, 400)}
	if !windowNeedsPrint(wins, off, desktop) {
		t.Error("a window running off the desktop: want print")
	}
	region := capSelection{Kind: capSelRegion, Rect: rc(0, 0, 100, 100)}
	if windowNeedsPrint(wins, region, desktop) {
		t.Error("a free rectangle is always read from the screen")
	}
	apart := []capWindow{
		{HWND: 5, Rect: rc(1000, 500, 1100, 600)},
		{HWND: 1, Rect: rc(0, 0, 500, 300)},
	}
	if windowNeedsPrint(apart, a, desktop) {
		t.Error("the window above does not overlap: read it from the screen")
	}
}

func TestCaptureFileNameAndLink(t *testing.T) {
	at := time.Date(2026, 9, 24, 16, 5, 9, 0, time.Local)
	if got, want := captureFileName(at, 2), "2026-09-24-160509-cap2.png"; got != want {
		t.Fatalf("captureFileName = %q, want %q", got, want)
	}
	if got, want := captureLink(filepath.Join("C:\\x\\assets", "a.png")), "./assets/a.png"; got != want {
		t.Fatalf("captureLink = %q, want %q", got, want)
	}
}

func TestCleanCaptureTitle(t *testing.T) {
	cases := map[string]string{
		"  Notepad \r\n - untitled  ": "Notepad - untitled",
		"a*b*c":                       `a\*b\*c`,
		"x `y` z":                     "x \\`y\\` z",
		"":                            "",
	}
	for in, want := range cases {
		if got := cleanCaptureTitle(in); got != want {
			t.Errorf("cleanCaptureTitle(%q) = %q, want %q", in, got, want)
		}
	}
	// An Explorer window is titled with its whole folder path: it must come through complete.
	path := `C:\Users\yoush\AppData\Local\Temp\claude\C--Users-yoush-Documents-md-memo\c138e774-26ab-487f-b1a6-972721e796ce\scratchpad`
	if got := cleanCaptureTitle(path); got != path {
		t.Errorf("a folder path was altered or cut:\n got  %q\n want %q", got, path)
	}
	// A backslash before punctuation would be eaten as an escape when the note is rendered.
	if got, want := cleanCaptureTitle(`D:\_backup\(old)`), `D:\\_backup\\(old)`; got != want {
		t.Errorf("punctuation after a backslash: got %q, want %q", got, want)
	}
	if got, want := cleanCaptureTitle(`a\*b`), `a\\\*b`; got != want {
		t.Errorf("backslash before an asterisk: got %q, want %q", got, want)
	}
	// Only a runaway title is cut.
	if got := cleanCaptureTitle(strings.Repeat("a", captureTitleMax)); len([]rune(got)) != captureTitleMax {
		t.Errorf("a title of exactly the limit was cut: %d runes", len([]rune(got)))
	}
	long := strings.Repeat("あ", captureTitleMax+50)
	if got := []rune(cleanCaptureTitle(long)); len(got) != captureTitleMax+1 || got[captureTitleMax] != '…' {
		t.Errorf("long title: %d runes, want %d plus an ellipsis", len(got), captureTitleMax)
	}
}

func TestCaptureLanguageAndHint(t *testing.T) {
	if got := captureLanguage(`{"general":{"language":"en"}}`); got != "en" {
		t.Errorf("language = %q, want en", got)
	}
	for _, in := range []string{``, `{}`, `not json`, `{"general":{}}`} {
		if got := captureLanguage(in); got != "ja" {
			t.Errorf("captureLanguage(%q) = %q, want the ja default", in, got)
		}
	}
	if !strings.Contains(captureHint("en"), "Esc") || !strings.Contains(captureHint("ja"), "Esc") {
		t.Error("the hint must mention how to cancel")
	}
	if captureHint("en") == captureHint("ja") {
		t.Error("English and Japanese hints should differ")
	}
}

func TestFormatCaptureEntry(t *testing.T) {
	at := time.Date(2026, 9, 24, 16, 5, 9, 0, time.Local)
	items := []capItem{
		{
			Sel:  capSelection{Kind: capSelWindow, Title: "Notepad - memo.txt", HWND: 1, Rect: rc(0, 0, 400, 300)},
			Link: "./assets/2026-09-24-160509-cap1.png",
			Text: "line one\nline two\n",
		},
		{
			Sel:     capSelection{Kind: capSelRegion, Rect: rc(10, 10, 210, 110)},
			Link:    "./assets/2026-09-24-160509-cap2.png",
			OCRFail: "API Key not set",
		},
		{
			Sel:  capSelection{Kind: capSelRegion, Rect: rc(0, 0, 50, 50)},
			Link: "./assets/2026-09-24-160509-cap3.png",
		},
	}
	got := formatCaptureEntry("  経費の確認  ", "Chrome", at, items)
	want := strings.Join([]string{
		"**[16:05:09] 画面キャプチャ**",
		"経費の確認",
		"> [context: Chrome]",
		"",
		"**1. Notepad - memo.txt**",
		"![capture 1](./assets/2026-09-24-160509-cap1.png)",
		"> line one",
		"> line two",
		"",
		"**2. 選択範囲 (200×100)**",
		"![capture 2](./assets/2026-09-24-160509-cap2.png)",
		"> (OCRでテキストを抽出できませんでした: API Key not set)",
		"",
		"**3. 選択範囲 (50×50)**",
		"![capture 3](./assets/2026-09-24-160509-cap3.png)",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("entry mismatch\n got:\n%s\nwant:\n%s", got, want)
	}

	// Without a caption or context the header stands alone.
	bare := formatCaptureEntry("", "", at, items[:1])
	if strings.Contains(bare, "[context:") || strings.Split(bare, "\n")[1] != "" {
		t.Fatalf("bare entry should have only the header before the first capture:\n%s", bare)
	}
}

func TestUniqueCapturePath(t *testing.T) {
	dir := t.TempDir()
	first := uniqueCapturePath(dir, "x.png")
	if filepath.Base(first) != "x.png" {
		t.Fatalf("free name: got %q", first)
	}
	if err := os.WriteFile(first, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := uniqueCapturePath(dir, "x.png")
	if filepath.Base(second) != "x-2.png" {
		t.Fatalf("taken name: got %q, want x-2.png", filepath.Base(second))
	}
}

func TestSaveAndRecognizeCaptures_OrderAndFailures(t *testing.T) {
	orig := inboxRecognize
	defer func() { inboxRecognize = orig }()

	var seen []string
	inboxRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("each OCR call must have a deadline")
		}
		seen = append(seen, filepath.Base(imagePath))
		if data, err := os.ReadFile(imagePath); err != nil || string(data) == "" {
			t.Errorf("the image must be on disk before its OCR starts: %v", err)
		}
		if strings.HasSuffix(imagePath, "-cap2.png") {
			return "", errors.New("fake OCR failure")
		}
		return "text of " + filepath.Base(imagePath), nil
	}

	scrapDir := t.TempDir()
	at := time.Date(2026, 9, 24, 16, 5, 9, 0, time.Local)
	imgs := []capturedImage{
		{Sel: capSelection{Kind: capSelWindow, Title: "one"}, PNG: []byte("png-1")},
		{Sel: capSelection{Kind: capSelRegion, Rect: rc(0, 0, 10, 10)}, PNG: []byte("png-2")},
		{Sel: capSelection{Kind: capSelRegion, Rect: rc(0, 0, 20, 20)}, PNG: []byte("png-3")},
	}
	items := saveAndRecognizeCaptures(scrapDir, at, imgs, llm.VisionConfig{})

	if want := []string{"2026-09-24-160509-cap1.png", "2026-09-24-160509-cap2.png", "2026-09-24-160509-cap3.png"}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("OCR order = %v, want %v", seen, want)
	}
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	if items[0].Text != "text of 2026-09-24-160509-cap1.png" || items[0].Link != "./assets/2026-09-24-160509-cap1.png" || items[0].Sel.Title != "one" {
		t.Errorf("item 0 = %+v", items[0])
	}
	if items[1].OCRFail != "fake OCR failure" || items[1].Text != "" {
		t.Errorf("item 1 = %+v, want the failure reason and no text", items[1])
	}
	if items[2].Text == "" {
		t.Errorf("a failure on one image must not stop the next: %+v", items[2])
	}
	// Every image is kept, failed OCR or not.
	for i, want := range []string{"png-1", "png-2", "png-3"} {
		data, err := os.ReadFile(filepath.Join(scrapDir, "assets", "2026-09-24-160509-cap"+string(rune('1'+i))+".png"))
		if err != nil || string(data) != want {
			t.Errorf("saved image %d = %q, %v, want %q", i+1, data, err, want)
		}
	}
}

func TestFinishCapture_AppendsOneEntry(t *testing.T) {
	orig := inboxRecognize
	defer func() { inboxRecognize = orig }()
	inboxRecognize = func(ctx context.Context, imagePath string, cfg llm.VisionConfig) (string, error) {
		return "recognized", nil
	}

	scrapDir := t.TempDir()
	a := &App{}
	a.scrapDir = scrapDir
	at := time.Now()
	a.finishCapture("caption", "Some App", at, []capturedImage{
		{Sel: capSelection{Kind: capSelWindow, Title: "Win"}, PNG: []byte("p1")},
		{Sel: capSelection{Kind: capSelRegion, Rect: rc(0, 0, 30, 40)}, PNG: []byte("p2")},
	})

	data, err := os.ReadFile(filepath.Join(scrapDir, at.Format("2006-01-02.md")))
	if err != nil {
		t.Fatalf("today's note was not written: %v", err)
	}
	body := string(data)
	for _, want := range []string{"画面キャプチャ", "caption", "> [context: Some App]", "**1. Win**", "![capture 1](./assets/", "**2. 選択範囲 (30×40)**", "> recognized"} {
		if !strings.Contains(body, want) {
			t.Errorf("note lacks %q:\n%s", want, body)
		}
	}
	if n := strings.Count(body, "画面キャプチャ"); n != 1 {
		t.Errorf("entry appended %d times, want once", n)
	}

	// Nothing captured: the note is not touched.
	before := len(body)
	a.finishCapture("x", "y", time.Now(), nil)
	after, _ := os.ReadFile(filepath.Join(scrapDir, at.Format("2006-01-02.md")))
	if len(after) != before {
		t.Error("an empty capture must not append anything")
	}
}

func TestImageIsUniform(t *testing.T) {
	flat := image.NewRGBA(image.Rect(0, 0, 8, 8))
	if !imageIsUniform(flat) {
		t.Error("an all-zero image is one flat fill")
	}
	painted := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for i := 0; i < len(painted.Pix); i += 4 {
		painted.Pix[i+3] = 255
	}
	if !imageIsUniform(painted) {
		t.Error("an all-black opaque image is one flat fill")
	}
	painted.Set(7, 7, color.RGBA{R: 1, A: 255})
	if imageIsUniform(painted) {
		t.Error("a single different pixel at the end must be noticed")
	}
	if !imageIsUniform(nil) {
		t.Error("no image counts as unusable")
	}
}

func TestEncodePNG_RoundTrip(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	img.Set(1, 1, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	data := encodePNG(img)
	if len(data) == 0 {
		t.Fatal("encodePNG returned nothing")
	}
	back, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("output is not a PNG: %v", err)
	}
	if back.Bounds().Dx() != 3 || back.Bounds().Dy() != 2 {
		t.Fatalf("size = %v, want 3x2", back.Bounds())
	}
	r, g, b, _ := back.At(1, 1).RGBA()
	if r>>8 != 10 || g>>8 != 20 || b>>8 != 30 {
		t.Errorf("pixel (1,1) = %d,%d,%d, want 10,20,30", r>>8, g>>8, b>>8)
	}
}

func TestSession_FrameStaysWhileClicking(t *testing.T) {
	s := newCapSession(testWindows())
	s.Move(pt(50, 50), false)
	s.Down(pt(50, 50), true)
	if r, ok := s.Live(); !ok || r != rc(0, 0, 500, 300) {
		t.Fatalf("frame while the button is down on a window = %v ok=%v, want it to stay on A", r, ok)
	}
	s.Move(pt(150, 120), true) // now it is a drag, so the frame becomes the dragged rectangle
	if r, _ := s.Live(); r != rc(50, 50, 150, 120) {
		t.Fatalf("frame while dragging = %v", r)
	}
}
