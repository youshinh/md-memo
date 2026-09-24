package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/llm"
)

// The image-capture feature lets the user pick windows and/or free rectangles on screen, then saves
// each as a PNG under the scraps' assets folder, OCRs them in the order picked and appends one note
// entry linking every image. This file holds the parts that need no OS: the selection state
// machine that the native overlay (imgcap_windows.go) drives with mouse and key events, the hit
// test, and the note formatting.

const (
	capSelWindow = "window"
	capSelRegion = "region"

	// capClickSlop is how far (px) the pointer may travel between press and release for the gesture
	// to still count as a click on a window rather than a drag for a rectangle.
	capClickSlop = 4
	// capMinRegion is the smallest rectangle (px per side) accepted as a drag selection.
	capMinRegion = 8
)

// capWindow is one candidate top-level window: what is visible (not minimized, not cloaked, not one
// of our own overlays) at capture start, with its on-screen bounds.
type capWindow struct {
	HWND  uintptr
	Rect  image.Rectangle
	Title string
}

// capSelection is one thing the user picked. Windows keep their title; free rectangles have none.
type capSelection struct {
	Kind  string
	Rect  image.Rectangle
	Title string
	HWND  uintptr
}

// windowAt returns the topmost window containing pt. wins must be ordered top to bottom, as
// EnumWindows produces them.
func windowAt(wins []capWindow, pt image.Point) (capWindow, bool) {
	for _, w := range wins {
		if pt.In(w.Rect) {
			return w, true
		}
	}
	return capWindow{}, false
}

// normalizeRect turns two corner points, in any order, into a canonical rectangle.
func normalizeRect(a, b image.Point) image.Rectangle {
	return image.Rectangle{
		Min: image.Point{X: min(a.X, b.X), Y: min(a.Y, b.Y)},
		Max: image.Point{X: max(a.X, b.X), Y: max(a.Y, b.Y)},
	}
}

func pointDistance(a, b image.Point) int {
	dx, dy := a.X-b.X, a.Y-b.Y
	if dx < 0 {
		dx = -dx
	}
	if dy < 0 {
		dy = -dy
	}
	return max(dx, dy)
}

// capSession is the selection state machine. It is fed events by the overlay and never touches the
// OS; the overlay reads Hover/Drag/Selections to draw frames and Done/Cancelled to know when to stop.
//
//   - Hovering (no button down) tracks the window under the pointer.
//   - A click on a window, or a drag for a rectangle, makes a selection. Without Ctrl held that
//     selection ends the session at once (it is "sent"); with Ctrl held it is added and the session
//     goes on, and releasing Ctrl ends it.
//   - Ctrl+click on a window that is already selected removes it again.
//   - Escape cancels everything.
type capSession struct {
	wins []capWindow

	pointer  image.Point
	hover    capWindow
	hasHover bool

	pressed  bool
	pressPt  image.Point
	dragging bool

	selections []capSelection

	done      bool
	cancelled bool
}

func newCapSession(wins []capWindow) *capSession {
	return &capSession{wins: wins}
}

// Move reports the pointer position (screen coordinates); ctrl is whether Ctrl is held.
func (s *capSession) Move(pt image.Point, ctrl bool) {
	if s.done {
		return
	}
	s.pointer = pt
	if s.pressed && pointDistance(pt, s.pressPt) > capClickSlop {
		s.dragging = true
	}
	if !s.pressed {
		s.hover, s.hasHover = windowAt(s.wins, pt)
	}
	s.noteCtrl(ctrl)
}

func (s *capSession) Down(pt image.Point, ctrl bool) {
	if s.done {
		return
	}
	s.pointer = pt
	s.pressed = true
	s.pressPt = pt
	s.dragging = false
	s.noteCtrl(ctrl)
}

func (s *capSession) Up(pt image.Point, ctrl bool) {
	if s.done || !s.pressed {
		return
	}
	s.pointer = pt
	dragged := s.dragging || pointDistance(pt, s.pressPt) > capClickSlop
	s.pressed, s.dragging = false, false

	var picked bool
	if dragged {
		r := normalizeRect(s.pressPt, pt)
		if r.Dx() >= capMinRegion && r.Dy() >= capMinRegion {
			s.selections = append(s.selections, capSelection{Kind: capSelRegion, Rect: r})
			picked = true
		}
	} else if w, ok := windowAt(s.wins, pt); ok {
		if i := s.indexOfWindow(w.HWND); i >= 0 && ctrl {
			s.selections = append(s.selections[:i], s.selections[i+1:]...)
		} else if i < 0 {
			s.selections = append(s.selections, capSelection{Kind: capSelWindow, Rect: w.Rect, Title: w.Title, HWND: w.HWND})
			picked = true
		}
	}
	if picked && !ctrl {
		s.done = true
		return
	}
	s.noteCtrl(ctrl)
}

// CtrlChanged is for the overlay's key poll: Ctrl going up ends a multi-selection.
func (s *capSession) CtrlChanged(ctrl bool) {
	if s.done {
		return
	}
	s.noteCtrl(ctrl)
}

func (s *capSession) noteCtrl(ctrl bool) {
	if !ctrl && len(s.selections) > 0 && !s.pressed {
		s.done = true
	}
}

func (s *capSession) Escape() {
	s.done, s.cancelled = true, true
}

func (s *capSession) indexOfWindow(hwnd uintptr) int {
	for i, sel := range s.selections {
		if sel.Kind == capSelWindow && sel.HWND == hwnd {
			return i
		}
	}
	return -1
}

func (s *capSession) Done() bool      { return s.done }
func (s *capSession) Cancelled() bool { return s.cancelled }

// Result is what to capture, in the order picked. It is empty for a cancelled session.
func (s *capSession) Result() []capSelection {
	if s.cancelled {
		return nil
	}
	return append([]capSelection(nil), s.selections...)
}

// Selections are the confirmed picks so far (for drawing numbered frames).
func (s *capSession) Selections() []capSelection { return s.selections }

// Live is the frame to draw for what the pointer is doing right now: the rectangle being dragged,
// or else the window under the pointer.
func (s *capSession) Live() (image.Rectangle, bool) {
	if s.done {
		return image.Rectangle{}, false
	}
	if s.pressed {
		if s.dragging {
			return normalizeRect(s.pressPt, s.pointer), true
		}
		// Button down but not yet moved far: this is still a click on the window under it.
		if w, ok := windowAt(s.wins, s.pressPt); ok {
			return w.Rect, true
		}
		return image.Rectangle{}, false
	}
	if s.hasHover {
		return s.hover.Rect, true
	}
	return image.Rectangle{}, false
}

// ---- note formatting -------------------------------------------------------------------------

// capItem is one captured image with its OCR outcome.
type capItem struct {
	Sel     capSelection
	Link    string // note-relative image link, e.g. ./assets/....png
	Text    string // recognized text; "" when the image has none
	OCRFail string // non-empty when OCR failed; the reason
}

// captureFileName names the PNG for the i-th (1-based) capture taken at "at". The time keeps names
// unique across captures; the index keeps them ordered within one.
func captureFileName(at time.Time, i int) string {
	return fmt.Sprintf("%s-cap%d.png", at.Format("2006-01-02-150405"), i)
}

func captureLink(name string) string {
	return "./assets/" + filepath.Base(name)
}

// captureHeading labels one capture in the note.
func captureHeading(i int, sel capSelection) string {
	if sel.Kind == capSelWindow {
		title := cleanCaptureTitle(sel.Title)
		if title == "" {
			title = "ウィンドウ"
		}
		return fmt.Sprintf("%d. %s", i, title)
	}
	return fmt.Sprintf("%d. 選択範囲 (%d×%d)", i, sel.Rect.Dx(), sel.Rect.Dy())
}

// formatCaptureEntry builds the appended note body: a timestamped header, the caption the user
// typed (if any), the window they were in (if known), then per capture a heading, the image link
// and the OCR text as a blockquote.
func formatCaptureEntry(caption, contextTitle string, at time.Time, items []capItem) string {
	var b strings.Builder
	fmt.Fprintf(&b, "**[%s] 画面キャプチャ**\n", at.Format("15:04:05"))
	if c := strings.TrimSpace(caption); c != "" {
		b.WriteString(c + "\n")
	}
	if t := strings.TrimSpace(contextTitle); t != "" {
		fmt.Fprintf(&b, "> [context: %s]\n", t)
	}
	for i, it := range items {
		b.WriteString("\n")
		fmt.Fprintf(&b, "**%s**\n", captureHeading(i+1, it.Sel))
		fmt.Fprintf(&b, "![capture %d](%s)\n", i+1, it.Link)
		switch {
		case it.OCRFail != "":
			fmt.Fprintf(&b, "> (OCRでテキストを抽出できませんでした: %s)\n", it.OCRFail)
		case strings.TrimSpace(it.Text) != "":
			for _, line := range strings.Split(strings.TrimSpace(it.Text), "\n") {
				b.WriteString("> " + line + "\n")
			}
		}
	}
	return b.String()
}

// captureTitleMax is the longest window title kept whole. An Explorer window's title is the full
// folder path (up to MAX_PATH, 260, plus a suffix), which is exactly what should stay readable in the
// note; only a runaway title is cut.
const captureTitleMax = 400

// cleanCaptureTitle makes a window title safe to put on one line of Markdown: whitespace runs
// (including newlines) collapse to one space, and the characters Markdown would act on are escaped -
// "*" and "`" so a title like "a*b*c" cannot bold half of a heading, and a backslash that sits before
// punctuation (as in the path D:\_backup\(old)), which would otherwise vanish as an escape when the
// note is rendered. A backslash before a letter (C:\Users) is already literal and is left alone.
func cleanCaptureTitle(title string) string {
	rs := []rune(strings.Join(strings.Fields(title), " "))
	cut := len(rs) > captureTitleMax
	if cut {
		rs = rs[:captureTitleMax]
	}
	var b strings.Builder
	for i, r := range rs {
		switch {
		case r == '*' || r == '`':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\\' && i+1 < len(rs) && isASCIIPunct(rs[i+1]):
			b.WriteString(`\\`)
		default:
			b.WriteRune(r)
		}
	}
	if cut {
		b.WriteString("…")
	}
	return b.String()
}

func isASCIIPunct(r rune) bool {
	return (r >= '!' && r <= '/') || (r >= ':' && r <= '@') || (r >= '[' && r <= '`') || (r >= '{' && r <= '~')
}

// captureHint is the one-line instruction shown at the top of the screen while picking.
func captureHint(lang string) string {
	if lang == "en" {
		return "Click: window    Drag: area    Ctrl: several    Esc: cancel"
	}
	return "クリック: ウィンドウ    ドラッグ: 範囲    Ctrl: 複数選択    Esc: 中止"
}

// captureLanguage reads config.json's general.language ("ja" when unset).
func captureLanguage(configJSON string) string {
	var raw struct {
		General struct {
			Language string `json:"language"`
		} `json:"general"`
	}
	_ = json.Unmarshal([]byte(configJSON), &raw)
	if raw.General.Language == "" {
		return "ja"
	}
	return raw.General.Language
}

// windowNeedsPrint reports whether a selected window's pixels cannot be read from the screen as they
// are: part of it is hidden behind a window above it, or part of it lies off the desktop. Such a
// window is drawn by asking the window itself (PrintWindow) instead. A free rectangle is always
// read from the screen. wins is in z-order, top first.
func windowNeedsPrint(wins []capWindow, sel capSelection, desktop image.Rectangle) bool {
	if sel.Kind != capSelWindow {
		return false
	}
	if !sel.Rect.In(desktop) {
		return true
	}
	for _, w := range wins {
		if w.HWND == sel.HWND {
			return false
		}
		if w.Rect.Overlaps(sel.Rect) {
			return true
		}
	}
	return false
}

// ---- saving and recognizing ------------------------------------------------------------------

// capturedImage is one selection with its pixels, PNG-encoded.
type capturedImage struct {
	Sel capSelection
	PNG []byte
}

// uniqueCapturePath returns a path in dir for name that does not exist yet, adding -2, -3, ... before
// the extension when it does (two captures inside the same second, or a re-run of the same name).
func uniqueCapturePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for n := 2; n < 1000; n++ {
		p = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, n, ext))
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
	return p
}

// saveAndRecognizeCaptures writes every capture to <scrapDir>/assets as a PNG - kept so it can be
// reopened and edited later - and then runs OCR on them one after another, in the order they were
// picked. The image is saved before its OCR starts, so a recognition failure never loses it, and a
// capture that cannot be written is left out (nothing to link to). Each OCR gets its own timeout.
func saveAndRecognizeCaptures(scrapDir string, at time.Time, imgs []capturedImage, cfg llm.VisionConfig) []capItem {
	assetsDir := filepath.Join(scrapDir, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return nil
	}
	items := make([]capItem, 0, len(imgs))
	for i, img := range imgs {
		path := uniqueCapturePath(assetsDir, captureFileName(at, i+1))
		if err := os.WriteFile(path, img.PNG, 0o644); err != nil {
			continue
		}
		it := capItem{Sel: img.Sel, Link: captureLink(path)}
		func() {
			defer func() {
				if r := recover(); r != nil {
					it.OCRFail = "内部エラー"
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), inboxOCRTimeout)
			defer cancel()
			text, err := inboxRecognize(ctx, path, cfg)
			switch {
			case err != nil:
				it.OCRFail = strings.TrimPrefix(failureNote(err), ": ")
			default:
				it.Text = strings.TrimSpace(text)
			}
		}()
		items = append(items, it)
	}
	return items
}

// finishCapture is the tail of a capture: save and recognize every image, then add one entry to
// today's note. It runs on its own goroutine, after the picking overlay is gone.
func (a *App) finishCapture(caption, contextTitle string, at time.Time, imgs []capturedImage) {
	defer func() { _ = recover() }()
	if len(imgs) == 0 {
		return
	}
	cfgStr, _ := a.GetConfig()
	visionCfg, _ := inboxVisionVoiceConfigs(cfgStr)
	scrapDir := a.GetScrapDir()
	items := saveAndRecognizeCaptures(scrapDir, at, imgs, visionCfg)
	if len(items) == 0 {
		return
	}
	a.appendInboxEntry(scrapDir, formatCaptureEntry(caption, contextTitle, at, items)+"\n")
}

// ---- pixels ----------------------------------------------------------------------------------

// imageIsUniform reports whether every pixel of img is the same colour. A window that PrintWindow
// could not draw comes back as one flat fill (usually black); such a result is not a picture of
// the window, so the caller reads the screen instead.
func imageIsUniform(img *image.RGBA) bool {
	if img == nil || len(img.Pix) < 4 {
		return true
	}
	first := img.Pix[0:4]
	for i := 4; i+4 <= len(img.Pix); i += 4 {
		if img.Pix[i] != first[0] || img.Pix[i+1] != first[1] || img.Pix[i+2] != first[2] || img.Pix[i+3] != first[3] {
			return false
		}
	}
	return true
}

// encodePNG returns img as PNG bytes, or nil if it cannot be encoded.
func encodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}
