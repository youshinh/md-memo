package main

import (
	"image"
	"runtime"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The picking overlay and the pixel grabbing for image capture (the platform-independent selection
// logic is capSession in imgcap.go).
//
// While picking, two windows cover the virtual desktop. Neither is a snapshot of the screen - what
// is underneath stays live and nothing is read until the choice is made:
//
//   - the input window is a full-desktop layered window at a low alpha (a faint veil, so it is
//     obvious that picking is on). It takes the mouse and keyboard.
//   - the frame window is a solid green window shaped, with SetWindowRgn, to just the frames, the
//     number badges and the hint bar. It is layered and transparent to hit tests, so it never
//     steals a click from the input window below it.
//
// Both belong to one dedicated thread with its own message loop, like the Quick Capture popup, and
// the thread exists only while picking.

const (
	capInputClass = "MDMemoCapInput"
	capFrameClass = "MDMemoCapFrame"

	capWmSetCursor  = 0x0020
	capWmNcHitTest  = 0x0084
	capWmEraseBkgnd = 0x0014
	capWmTimer      = 0x0113
	capWmLButtonDn  = 0x0201
	capWmLButtonUp  = 0x0202
	capWmRButtonDn  = 0x0204

	capWsExTransparent = 0x00000020
	capWsExNoActivate  = 0x08000000
	capSwShow          = 5
	capIdcCross        = 32515
	capBlackBrush      = 4
	capHTTransparent   = ^uintptr(0)  // HTTRANSPARENT (-1): let the hit test fall through to the window below
	capHwndTopmost     = ^uintptr(0)  // HWND_TOPMOST (-1)
	capGwlExStyle      = ^uintptr(19) // GWL_EXSTYLE (-20)
	capDpiPerMonV2     = ^uintptr(3)  // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	capRgnOr           = 2
	capRgnDiff         = 4

	capTimerID = 1
	capTimerMs = 25
	// capMaxWait is how long the overlay may stay up with no decision before it gives up; it keeps a
	// mishap (focus stolen, Esc lost) from leaving the screen veiled.
	capMaxWait = 2 * time.Minute

	capVeilAlpha     = 36
	capFrameThick    = 3
	capBadgeW        = 24
	capBadgeH        = 20
	capHintW         = 560
	capHintH         = 28
	capHintTop       = 12
	capMinWindowSize = 24

	// COLORREFs (0x00BBGGRR).
	capColGreen = 0x5EC522 // #22C55E
	capColBadge = 0x2D5314 // a dark green under the number

	dwmwaExtendedFrameBounds = 9
	dwmwaCloaked             = 14

	srcCopy             = 0x00CC0020
	captureBlt          = 0x40000000
	pwRenderFullContent = 2
	dibRgbColors        = 0

	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79
)

var (
	procEnumWindows                  = modUser32.NewProc("EnumWindows")
	procIsWindowVisible              = modUser32.NewProc("IsWindowVisible")
	procIsIconic                     = modUser32.NewProc("IsIconic")
	procGetClassNameW                = modUser32.NewProc("GetClassNameW")
	procGetAsyncKeyState             = modUser32.NewProc("GetAsyncKeyState")
	procSetCapture                   = modUser32.NewProc("SetCapture")
	procReleaseCapture               = modUser32.NewProc("ReleaseCapture")
	procSetCursor                    = modUser32.NewProc("SetCursor")
	procGetDC                        = modUser32.NewProc("GetDC")
	procReleaseDC                    = modUser32.NewProc("ReleaseDC")
	procPrintWindow                  = modUser32.NewProc("PrintWindow")
	procSetTimer                     = modUser32.NewProc("SetTimer")
	procKillTimer                    = modUser32.NewProc("KillTimer")
	procSetThreadDpiAwarenessContext = modUser32.NewProc("SetThreadDpiAwarenessContext")

	procCreateCompatibleDC = modGdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = modGdi32.NewProc("CreateDIBSection")
	procBitBlt             = modGdi32.NewProc("BitBlt")
	procDeleteDC           = modGdi32.NewProc("DeleteDC")
	procDeleteObject       = modGdi32.NewProc("DeleteObject")
	procCreateRectRgn      = modGdi32.NewProc("CreateRectRgn")
	procCombineRgn         = modGdi32.NewProc("CombineRgn")

	procDwmGetWindowAttribute = modDwmapi.NewProc("DwmGetWindowAttribute")
	procDwmFlush              = modDwmapi.NewProc("DwmFlush")
)

// bitmapInfoHeader mirrors BITMAPINFOHEADER. For a 32-bit BI_RGB bitmap it is all CreateDIBSection
// needs (there is no colour table).
type bitmapInfoHeader struct {
	size          uint32
	width         int32
	height        int32
	planes        uint16
	bitCount      uint16
	compression   uint32
	sizeImage     uint32
	xPelsPerMeter int32
	yPelsPerMeter int32
	clrUsed       uint32
	clrImportant  uint32
}

var (
	capActive    atomic.Bool
	capClassOnce sync.Once
	capFont      windows.Handle

	// capOv is the overlay in progress. Only the overlay thread touches it.
	capOv *capOverlay

	// capEnumOut collects EnumWindows results. A Go callback can never be freed, so one callback is
	// made once and reused; only the overlay thread (one at a time) fills this.
	capEnumCB  = sync.OnceValue(func() uintptr { return windows.NewCallback(capEnumProc) })
	capEnumOut []capWindow
)

// startImageCapture begins picking. It returns at once; everything happens on its own thread, which
// ends when the capture is finished. A second call while one is running does nothing.
func startImageCapture(caption, contextTitle string) {
	if globalApp == nil || !capActive.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer capActive.Store(false)
		defer func() { _ = recover() }()
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		runImageCapture(caption, contextTitle)
	}()
}

func runImageCapture(caption, contextTitle string) {
	// See the real pixel grid on every monitor, whatever the app manifest says.
	if procSetThreadDpiAwarenessContext.Find() == nil {
		old, _, _ := procSetThreadDpiAwarenessContext.Call(capDpiPerMonV2)
		if old != 0 {
			defer procSetThreadDpiAwarenessContext.Call(old)
		}
	}

	wins := enumCaptureWindows()
	desktop := capVirtualScreen()
	sels := capPick(wins, desktop)
	if len(sels) == 0 {
		return
	}
	at := time.Now()

	capWaitForComposition()
	imgs := capGrabAll(sels, wins, desktop)
	if len(imgs) == 0 {
		return
	}
	// OCR and the network are slow; finish on another goroutine so this thread can end now.
	go globalApp.finishCapture(caption, contextTitle, at, imgs)
}

func capVirtualScreen() image.Rectangle {
	x, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
	y, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
	w, _, _ := procGetSystemMetrics.Call(smCxVirtualScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyVirtualScreen)
	return image.Rect(int(int32(x)), int(int32(y)), int(int32(x))+int(int32(w)), int(int32(y))+int(int32(h)))
}

// capKeyDown reports whether a key is physically down right now. It is a variable so a test can
// stand in for the keyboard (Ctrl held across several clicks cannot be posted as messages).
var capKeyDown = func(vk uintptr) bool {
	state, _, _ := procGetAsyncKeyState.Call(vk)
	return state&0x8000 != 0
}

// ---- windows to pick from --------------------------------------------------------------------

// enumCaptureWindows lists the visible top-level windows, front to back.
func enumCaptureWindows() []capWindow {
	capEnumOut = nil
	_, _, _ = procEnumWindows.Call(capEnumCB(), 0)
	out := capEnumOut
	capEnumOut = nil
	return out
}

func capEnumProc(hwnd, _ uintptr) uintptr {
	if w, ok := capWindowInfo(hwnd); ok {
		capEnumOut = append(capEnumOut, w)
	}
	return 1 // keep enumerating
}

func capClassName(hwnd uintptr) string {
	buf := make([]uint16, 128)
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf[:n])
}

// capWindowInfo decides whether hwnd is something a person would call "a window" and, if so, where
// it is. What it leaves out: hidden, minimized and cloaked windows (other virtual desktops,
// suspended UWP apps), the desktop itself (it would be a full-screen capture), click-through
// overlays, title-less tool windows, tiny windows, and our own picking/popup windows.
func capWindowInfo(hwnd uintptr) (capWindow, bool) {
	if v, _, _ := procIsWindowVisible.Call(hwnd); v == 0 {
		return capWindow{}, false
	}
	if v, _, _ := procIsIconic.Call(hwnd); v != 0 {
		return capWindow{}, false
	}
	var cloaked uint32
	_, _, _ = procDwmGetWindowAttribute.Call(hwnd, dwmwaCloaked, uintptr(unsafe.Pointer(&cloaked)), unsafe.Sizeof(cloaked))
	if cloaked != 0 {
		return capWindow{}, false
	}
	switch capClassName(hwnd) {
	case "Progman", "WorkerW", capInputClass, capFrameClass, quickCaptureClassName:
		return capWindow{}, false
	}
	ex, _, _ := procGetWindowLongPtrW.Call(hwnd, capGwlExStyle)
	if ex&wsExLayered != 0 && ex&capWsExTransparent != 0 {
		return capWindow{}, false
	}
	title := getWindowText(windows.Handle(hwnd))
	if title == "" && ex&wsExToolWindow != 0 {
		return capWindow{}, false
	}

	// The visible frame, without the invisible resize border Windows 10/11 adds around a window.
	var rc rectT
	hr, _, _ := procDwmGetWindowAttribute.Call(hwnd, dwmwaExtendedFrameBounds, uintptr(unsafe.Pointer(&rc)), unsafe.Sizeof(rc))
	if int32(hr) != 0 {
		if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rc))); ok == 0 {
			return capWindow{}, false
		}
	}
	r := image.Rect(int(rc.left), int(rc.top), int(rc.right), int(rc.bottom))
	if r.Dx() < capMinWindowSize || r.Dy() < capMinWindowSize {
		return capWindow{}, false
	}
	return capWindow{HWND: hwnd, Rect: r, Title: title}, true
}

// ---- the picking overlay ---------------------------------------------------------------------

type capOverlay struct {
	sess    *capSession
	origin  image.Point
	size    image.Point
	input   windows.Handle
	frame   windows.Handle
	hint    string
	started time.Time

	// What the frame window currently shows, so an event that changes nothing rebuilds nothing.
	shownInit bool
	shownLive image.Rectangle
	shownHas  bool
	shownSels []image.Rectangle
	quit      bool
}

func capRegisterClasses(hinst windows.Handle) {
	capClassOnce.Do(func() {
		register := func(name string, proc uintptr, cursor, brush uintptr) {
			var wc WNDCLASSEXW
			wc.cbSize = uint32(unsafe.Sizeof(wc))
			wc.lpfnWndProc = proc
			wc.hInstance = hinst
			wc.hCursor = windows.Handle(cursor)
			wc.hbrBackground = windows.Handle(brush)
			wc.lpszClassName = mustUTF16Ptr(name)
			_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
		}
		cross, _, _ := procLoadCursorW.Call(0, capIdcCross)
		black, _, _ := procGetStockObject.Call(capBlackBrush)
		register(capInputClass, windows.NewCallback(capInputWndProc), cross, black)
		register(capFrameClass, windows.NewCallback(capFrameWndProc), 0, 0)

		font, _, _ := procCreateFontW.Call(
			^uintptr(13), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0,
			uintptr(unsafe.Pointer(mustUTF16Ptr("Segoe UI"))),
		)
		capFont = windows.Handle(font)
	})
}

// capPick shows the overlay and runs it until the person has chosen (or given up). It returns what
// was chosen, in order, or nothing.
func capPick(wins []capWindow, desktop image.Rectangle) []capSelection {
	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	capRegisterClasses(hinst)

	cfgStr, _ := globalApp.GetConfig()
	ov := &capOverlay{
		sess:    newCapSession(wins),
		origin:  desktop.Min,
		size:    desktop.Size(),
		hint:    captureHint(captureLanguage(cfgStr)),
		started: time.Now(),
	}
	capOv = ov
	defer func() { capOv = nil }()

	create := func(exStyle uintptr, class string) uintptr {
		h, _, _ := procCreateWindowExW.Call(
			exStyle,
			uintptr(unsafe.Pointer(mustUTF16Ptr(class))),
			uintptr(unsafe.Pointer(mustUTF16Ptr("MD-Memo Capture"))),
			uintptr(wsPopup),
			uintptr(int32(desktop.Min.X)), uintptr(int32(desktop.Min.Y)), uintptr(desktop.Dx()), uintptr(desktop.Dy()),
			0, 0, uintptr(hinst), 0,
		)
		return h
	}
	in := create(wsExTopmost|wsExToolWindow|wsExLayered, capInputClass)
	if in == 0 {
		return nil
	}
	fr := create(wsExTopmost|wsExToolWindow|wsExLayered|capWsExTransparent|capWsExNoActivate, capFrameClass)
	if fr == 0 {
		_, _, _ = procDestroyWindow.Call(in)
		return nil
	}
	ov.input, ov.frame = windows.Handle(in), windows.Handle(fr)
	_, _, _ = procSetLayeredWindowAttr.Call(in, 0, capVeilAlpha, lwaAlpha)
	_, _, _ = procSetLayeredWindowAttr.Call(fr, 0, 255, lwaAlpha)

	// A frame is on screen from the first moment: start from where the pointer already is.
	var p POINT
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	ov.sess.Move(image.Pt(int(p.X), int(p.Y)), capKeyDown(vkControl))
	ov.applyRegion()

	_, _, _ = procShowWindow.Call(in, capSwShow)
	_, _, _ = procShowWindow.Call(fr, capSwShow)
	_, _, _ = procSetForegroundWindow.Call(in)
	_, _, _ = procSetFocus.Call(in)
	ov.raiseFrame()
	_, _, _ = procSetTimer.Call(in, capTimerID, capTimerMs, 0)

	var msg msgT
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}

	_, _, _ = procKillTimer.Call(in, capTimerID)
	_, _, _ = procDestroyWindow.Call(fr)
	_, _, _ = procDestroyWindow.Call(in)
	return ov.sess.Result()
}

// raiseFrame puts the frame window back above the input window (activating the input window lifts it).
func (ov *capOverlay) raiseFrame() {
	_, _, _ = procSetWindowPos.Call(uintptr(ov.frame), capHwndTopmost, 0, 0, 0, 0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE)
}

func (ov *capOverlay) screenPoint(lParam uintptr) image.Point {
	x := int32(int16(lParam & 0xFFFF))
	y := int32(int16((lParam >> 16) & 0xFFFF))
	return image.Pt(int(x)+ov.origin.X, int(y)+ov.origin.Y)
}

// refresh redraws the frames if anything visible changed and ends the loop once the session is over.
func (ov *capOverlay) refresh() {
	live, has := ov.sess.Live()
	sels := make([]image.Rectangle, 0, len(ov.sess.Selections()))
	for _, s := range ov.sess.Selections() {
		sels = append(sels, s.Rect)
	}
	if !ov.shownInit || has != ov.shownHas || live != ov.shownLive || !slices.Equal(sels, ov.shownSels) {
		ov.applyRegion()
	}
	if ov.sess.Done() && !ov.quit {
		ov.quit = true
		_, _, _ = procPostQuitMessage.Call(0)
	}
}

func (ov *capOverlay) tick() {
	if ov.sess.Done() {
		return
	}
	if capKeyDown(vkEscape) || time.Since(ov.started) > capMaxWait {
		ov.sess.Escape()
	} else {
		ov.sess.CtrlChanged(capKeyDown(vkControl))
	}
	ov.refresh()
}

func (ov *capOverlay) local(r image.Rectangle) image.Rectangle { return r.Sub(ov.origin) }

func capBadgeRect(r image.Rectangle) image.Rectangle {
	return image.Rect(r.Min.X, r.Min.Y, r.Min.X+capBadgeW, r.Min.Y+capBadgeH)
}

func (ov *capOverlay) hintRect() image.Rectangle {
	cx, _, _ := procGetSystemMetrics.Call(smCxScreen) // the primary monitor, whose top-left is (0,0)
	w := min(capHintW, int(int32(cx))-16)
	x := (int(int32(cx)) - w) / 2
	return image.Rect(x, capHintTop, x+w, capHintTop+capHintH)
}

func capRectRgn(r image.Rectangle) uintptr {
	h, _, _ := procCreateRectRgn.Call(uintptr(int32(r.Min.X)), uintptr(int32(r.Min.Y)), uintptr(int32(r.Max.X)), uintptr(int32(r.Max.Y)))
	return h
}

// applyRegion reshapes the frame window to the frames, badges and hint bar for the current state.
// SetWindowRgn takes ownership of the region it is given; the temporaries are freed here.
func (ov *capOverlay) applyRegion() {
	live, has := ov.sess.Live()
	total := capRectRgn(image.Rectangle{})
	addFrame := func(r image.Rectangle) {
		r = ov.local(r)
		outer := capRectRgn(r)
		if inner := r.Inset(capFrameThick); !inner.Empty() {
			in := capRectRgn(inner)
			_, _, _ = procCombineRgn.Call(outer, outer, in, capRgnDiff)
			_, _, _ = procDeleteObject.Call(in)
		}
		_, _, _ = procCombineRgn.Call(total, total, outer, capRgnOr)
		_, _, _ = procDeleteObject.Call(outer)
	}
	addBox := func(r image.Rectangle) {
		box := capRectRgn(r)
		_, _, _ = procCombineRgn.Call(total, total, box, capRgnOr)
		_, _, _ = procDeleteObject.Call(box)
	}

	sels := make([]image.Rectangle, 0, len(ov.sess.Selections()))
	for _, s := range ov.sess.Selections() {
		addFrame(s.Rect)
		addBox(ov.local(capBadgeRect(s.Rect)))
		sels = append(sels, s.Rect)
	}
	if has {
		addFrame(live)
	}
	addBox(ov.local(ov.hintRect()))

	_, _, _ = procSetWindowRgn.Call(uintptr(ov.frame), total, 1)
	_, _, _ = procInvalidateRect.Call(uintptr(ov.frame), 0, 0)
	ov.shownInit, ov.shownLive, ov.shownHas, ov.shownSels = true, live, has, sels
}

func (ov *capOverlay) paintFrame(hwnd windows.Handle) {
	var ps paintStructT
	hdc, _, _ := procBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
	if hdc != 0 {
		brush, _, _ := procGetStockObject.Call(stockDCBrush)
		fill := func(r rectT, color uintptr) {
			_, _, _ = procSetDCBrushColor.Call(hdc, color)
			_, _, _ = procFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), brush)
		}
		toRect := func(r image.Rectangle) rectT {
			return rectT{int32(r.Min.X), int32(r.Min.Y), int32(r.Max.X), int32(r.Max.Y)}
		}
		text := func(r rectT, s string, color uintptr) {
			_, _, _ = procSetBkMode.Call(hdc, bkModeTransparent)
			_, _, _ = procSetTextColor.Call(hdc, color)
			_, _, _ = procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(mustUTF16Ptr(s))), ^uintptr(0),
				uintptr(unsafe.Pointer(&r)), dtCenter|dtVCenter|dtSingleLine)
		}

		// The whole window is green; the region decides which parts are ever seen. The badges and the
		// hint bar are painted over it.
		fill(rectT{0, 0, int32(ov.size.X), int32(ov.size.Y)}, capColGreen)
		old, _, _ := procSelectObject.Call(hdc, uintptr(capFont))
		for i, s := range ov.sess.Selections() {
			b := toRect(ov.local(capBadgeRect(s.Rect)))
			fill(b, capColBadge)
			text(b, strconv.Itoa(i+1), colTextActive)
		}
		h := toRect(ov.local(ov.hintRect()))
		fill(h, colBg)
		text(h, ov.hint, colTextActive)
		_, _, _ = procSelectObject.Call(hdc, old)
	}
	_, _, _ = procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
}

func capInputWndProc(hwnd windows.Handle, msg uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			result, _, _ = procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
		}
	}()
	if ov := capOv; ov != nil {
		switch msg {
		case wmMouseMove:
			ov.sess.Move(ov.screenPoint(lParam), capKeyDown(vkControl))
			ov.refresh()
			return 0
		case capWmLButtonDn:
			_, _, _ = procSetCapture.Call(uintptr(hwnd))
			ov.sess.Down(ov.screenPoint(lParam), capKeyDown(vkControl))
			ov.refresh()
			return 0
		case capWmLButtonUp:
			_, _, _ = procReleaseCapture.Call()
			ov.sess.Up(ov.screenPoint(lParam), capKeyDown(vkControl))
			ov.refresh()
			return 0
		case capWmRButtonDn:
			ov.sess.Escape()
			ov.refresh()
			return 0
		case wmKeyDown:
			if wParam == vkEscape {
				ov.sess.Escape()
				ov.refresh()
				return 0
			}
		case capWmTimer:
			ov.tick()
			return 0
		case capWmSetCursor:
			cross, _, _ := procLoadCursorW.Call(0, capIdcCross)
			_, _, _ = procSetCursor.Call(cross)
			return 1
		case wmActivate:
			ov.raiseFrame()
		}
	}
	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func capFrameWndProc(hwnd windows.Handle, msg uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			result, _, _ = procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
		}
	}()
	switch msg {
	case wmPaint:
		if ov := capOv; ov != nil {
			ov.paintFrame(hwnd)
			return 0
		}
	case capWmEraseBkgnd:
		return 1
	case capWmNcHitTest:
		return capHTTransparent
	}
	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

// ---- reading pixels --------------------------------------------------------------------------

// capWaitForComposition lets the desktop compositor finish removing the overlay before pixels are
// read: without it the last frame of the veil or a green frame can end up in the picture.
func capWaitForComposition() {
	if procDwmFlush.Find() == nil {
		_, _, _ = procDwmFlush.Call()
		_, _, _ = procDwmFlush.Call()
	}
	time.Sleep(120 * time.Millisecond)
}

// capNewDIB makes a top-down 32-bit bitmap w x h selected into a fresh memory DC. The bits are
// readable through the returned pointer once something has been drawn into the DC. Free with
// capFreeDIB.
func capNewDIB(like uintptr, w, h int) (dc, bmp uintptr, bits unsafe.Pointer) {
	hdr := bitmapInfoHeader{
		size: uint32(unsafe.Sizeof(bitmapInfoHeader{})), width: int32(w), height: -int32(h),
		planes: 1, bitCount: 32,
	}
	dc, _, _ = procCreateCompatibleDC.Call(like)
	if dc == 0 {
		return 0, 0, nil
	}
	bmp, _, _ = procCreateDIBSection.Call(like, uintptr(unsafe.Pointer(&hdr)), dibRgbColors, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 || bits == nil {
		_, _, _ = procDeleteDC.Call(dc)
		return 0, 0, nil
	}
	_, _, _ = procSelectObject.Call(dc, bmp)
	return dc, bmp, bits
}

func capFreeDIB(dc, bmp uintptr) {
	_, _, _ = procDeleteDC.Call(dc) // first: a bitmap still selected into a DC cannot be deleted
	_, _, _ = procDeleteObject.Call(bmp)
}

// capDIBToRGBA copies BGRA (as Windows stores it) into an RGBA image. The alpha byte GDI leaves in
// a DIB is meaningless, so every pixel is made opaque.
func capDIBToRGBA(bits unsafe.Pointer, w, h int) *image.RGBA {
	src := unsafe.Slice((*byte)(bits), w*h*4)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	dst := img.Pix
	for i := 0; i+3 < len(dst); i += 4 {
		dst[i], dst[i+1], dst[i+2], dst[i+3] = src[i+2], src[i+1], src[i], 255
	}
	return img
}

// capGrabScreen reads r (virtual-desktop pixels) from the screen as it is right now.
func capGrabScreen(r image.Rectangle) *image.RGBA {
	w, h := r.Dx(), r.Dy()
	if w <= 0 || h <= 0 {
		return nil
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil
	}
	defer procReleaseDC.Call(0, screen)
	dc, bmp, bits := capNewDIB(screen, w, h)
	if dc == 0 {
		return nil
	}
	defer capFreeDIB(dc, bmp)
	if ok, _, _ := procBitBlt.Call(dc, 0, 0, uintptr(w), uintptr(h), screen,
		uintptr(int32(r.Min.X)), uintptr(int32(r.Min.Y)), srcCopy|captureBlt); ok == 0 {
		return nil
	}
	return capDIBToRGBA(bits, w, h)
}

// capPrintWindow asks the window itself to draw (so windows in front of it, or the desktop edge,
// do not matter) and returns want, the part of it that is its visible frame.
func capPrintWindow(hwnd uintptr, want image.Rectangle) *image.RGBA {
	var wr rectT
	if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&wr))); ok == 0 {
		return nil
	}
	full := image.Rect(int(wr.left), int(wr.top), int(wr.right), int(wr.bottom))
	w, h := full.Dx(), full.Dy()
	if w <= 0 || h <= 0 {
		return nil
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil
	}
	defer procReleaseDC.Call(0, screen)
	dc, bmp, bits := capNewDIB(screen, w, h)
	if dc == 0 {
		return nil
	}
	defer capFreeDIB(dc, bmp)
	if ok, _, _ := procPrintWindow.Call(hwnd, dc, pwRenderFullContent); ok == 0 {
		return nil
	}
	img := capDIBToRGBA(bits, w, h)
	crop := want.Sub(full.Min).Intersect(img.Bounds())
	if crop.Empty() {
		return nil
	}
	return img.SubImage(crop).(*image.RGBA)
}

// capGrabAll turns each pick into a PNG, in the order picked. A window that is partly hidden or off
// the desktop is drawn by the window itself; if that gives one flat colour (some apps cannot be
// printed) or fails, and for everything else, the screen is read. A pick that cannot be read at all
// is dropped.
func capGrabAll(sels []capSelection, wins []capWindow, desktop image.Rectangle) []capturedImage {
	var out []capturedImage
	for _, s := range sels {
		var img *image.RGBA
		if windowNeedsPrint(wins, s, desktop) {
			if p := capPrintWindow(s.HWND, s.Rect); p != nil && !imageIsUniform(p) {
				img = p
			}
		}
		if img == nil {
			img = capGrabScreen(s.Rect.Intersect(desktop))
		}
		if img == nil {
			continue
		}
		if data := encodePNG(img); data != nil {
			out = append(out, capturedImage{Sel: s, PNG: data})
		}
	}
	return out
}
