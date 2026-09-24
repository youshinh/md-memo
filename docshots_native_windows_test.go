//go:build windows && nativeprobe

package main

// Renders the two native pieces of the Quick Capture flow with their own drawing code, for the
// manual: the popup, and the picking overlay (frames, badges, hint bar). Nothing is read from the
// screen: each window is asked to draw itself with PrintWindow. It creates real windows, so it is built
// only with -tags nativeprobe and skips unless DOCSHOTS_OUT names a folder. The pictures are then put
// together by tools/docshots/native/compose_native.py (see its header for the two commands).

import (
	"image"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procGetDlgItemDoc = modUser32.NewProc("GetDlgItem")

var procFindWindowDoc = modUser32.NewProc("FindWindowW")

func dsFindWin(class string) uintptr {
	h, _, _ := procFindWindowDoc.Call(uintptr(unsafe.Pointer(mustUTF16Ptr(class))), 0)
	return h
}

func dsWaitFor(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func docOut(t *testing.T) string {
	out := os.Getenv("DOCSHOTS_OUT")
	if out == "" {
		t.Skip("DOCSHOTS_OUT not set")
	}
	return out
}

// printToRGBA has the window draw itself into an image of its own size.
func printToRGBA(t *testing.T, hwnd uintptr) *image.RGBA {
	var wr rectT
	_, _, _ = procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&wr)))
	w, h := int(wr.right-wr.left), int(wr.bottom-wr.top)
	screen, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, screen)
	dc, bmp, bits := capNewDIB(screen, w, h)
	if dc == 0 {
		t.Fatal("no DIB")
	}
	defer capFreeDIB(dc, bmp)
	if ok, _, _ := procPrintWindow.Call(hwnd, dc, pwRenderFullContent); ok == 0 {
		t.Fatal("PrintWindow failed")
	}
	return capDIBToRGBA(bits, w, h)
}

func writePNG(t *testing.T, path string, img image.Image) {
	data := encodePNG(img)
	if data == nil {
		t.Fatal("encode failed")
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s (%d bytes)", path, len(data))
}

func TestDocshotsNative_Popup(t *testing.T) {
	out := docOut(t)
	globalApp = &App{}
	globalApp.scrapDir = t.TempDir()
	defer func() { globalApp = nil }()

	for _, c := range []struct{ name, text string }{
		{"popup_en", "Call Mr. Tanaka about the estimate before Friday"},
		{"popup_ja", "田中さんに見積もりの件で金曜までに電話する"},
		{"popup_empty", ""},
	} {
		openQuickCapture(false)
		var popup uintptr
		dsWaitFor(t, "popup", 3*time.Second, func() bool { popup = dsFindWin(quickCaptureClassName); return popup != 0 })
		time.Sleep(500 * time.Millisecond)
		edit, _, _ := procGetDlgItemDoc.Call(popup, idQuickCaptureEdit)
		if c.text != "" {
			_, _, _ = procSendMessageW.Call(edit, 0x000C /* WM_SETTEXT */, 0, uintptr(unsafe.Pointer(mustUTF16Ptr(c.text))))
			n := uintptr(len([]rune(c.text)))
			_, _, _ = procSendMessageW.Call(edit, 0x00B1 /* EM_SETSEL */, n, n) // caret after the text, as when typing
		}
		time.Sleep(200 * time.Millisecond)
		img := printToRGBA(t, popup)
		writePNG(t, filepath.Join(out, c.name+".png"), img)
		_, _, _ = procPostMessageW.Call(popup, wmAppDismiss, 0, 0)
		dsWaitFor(t, "popup to close", 3*time.Second, func() bool { return dsFindWin(quickCaptureClassName) == 0 })
	}
	_ = windows.Handle(0)
}

// The picking overlay in the state "Ctrl held, two areas picked, a third being dragged", on a
// 1120x720 desktop, drawn by the overlay's own paint code. Black in the result means "not part of the
// frame window" (outside its region), which the composer treats as transparent.
func TestDocshotsNative_Overlay(t *testing.T) {
	out := docOut(t)
	// The frame window is created and printed on this thread: PrintWindow sends WM_PRINT to the
	// window's own thread, which must therefore be the calling one (it pumps no messages).
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	globalApp = &App{}
	globalApp.scrapDir = t.TempDir()
	defer func() { globalApp = nil }()

	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	capRegisterClasses(hinst)

	desk := image.Rect(0, 0, 1120, 720)
	for _, lang := range []string{"en", "ja"} {
		ov := &capOverlay{sess: newCapSession(nil), origin: desk.Min, size: desk.Size(), hint: captureHint(lang), started: time.Now()}
		capOv = ov
		h, _, _ := procCreateWindowExW.Call(
			uintptr(wsExTopmost|wsExToolWindow|wsExLayered|capWsExTransparent|capWsExNoActivate),
			uintptr(unsafe.Pointer(mustUTF16Ptr(capFrameClass))), uintptr(unsafe.Pointer(mustUTF16Ptr("doc"))),
			uintptr(wsPopup), 0, 0, uintptr(desk.Dx()), uintptr(desk.Dy()), 0, 0, uintptr(hinst), 0)
		if h == 0 {
			t.Fatal("frame window")
		}
		ov.frame = windows.Handle(h)
		_, _, _ = procSetLayeredWindowAttr.Call(h, 0, 255, lwaAlpha)

		drag := func(a, b image.Point) {
			ov.sess.Down(a, true)
			ov.sess.Move(b, true)
			ov.sess.Up(b, true)
		}
		drag(image.Pt(50, 180), image.Pt(352, 300)) // 1: the schedule table
		drag(image.Pt(50, 362), image.Pt(346, 496)) // 2: the JSON block
		ov.sess.Down(image.Pt(50, 560), true)       // 3: being dragged over the checklist
		ov.sess.Move(image.Pt(420, 636), true)
		ov.applyRegion()
		_, _, _ = procShowWindow.Call(h, capSwShow)
		time.Sleep(200 * time.Millisecond)

		img := printToRGBA(t, h)
		writePNG(t, filepath.Join(out, "overlay_"+lang+".png"), img)
		_, _, _ = procDestroyWindow.Call(h)
		capOv = nil
	}
}
