package main

import (
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	HOTKEY_ID_QUICKCAPTURE = 0x9002
	// VK for 'Q', used with MOD_CONTROL|MOD_SHIFT for the fixed default hotkey. NOT 'O': Ctrl+Shift+O
	// is already this app's own default in-app shortcut for "Open Folder" (see DEFAULT_SHORTCUTS_WIN
	// in frontend/js/app.js) - a global OS-level RegisterHotKey on the same combo would silently
	// swallow that keystroke everywhere, including while md-memo itself has focus, before the
	// WebView's own keydown handler ever saw it.
	quickCaptureVKQ = 0x51

	quickCaptureClassName = "MDMemoQuickCapture"

	wmCreate   = 0x0001
	wmCommand  = 0x0111
	wmKeyDown  = 0x0100
	wmChar     = 0x0102
	wmSetFont  = 0x0030
	wmActivate = 0x0006

	vkReturn  = 0x0D
	vkEscape  = 0x1B
	vkControl = 0x11

	// GCS_COMPSTR: passed to ImmGetCompositionStringW to ask for the length of the current
	// composition string. A non-zero length means an IME composition is in progress right now.
	gcsCompStr = 0x0008

	// Private WM_APP messages posted to the popup's own hwnd to ask its own thread to act on it -
	// PostMessageW is safe to call from any thread, unlike SetFocus/DestroyWindow which are not.
	wmAppRefocus = 0x8000 + 1
	wmAppDismiss = 0x8000 + 2

	bnClicked = 0

	cfUnicodeText = 13

	wsPopup        = 0x80000000
	wsClipChildren = 0x02000000
	wsVisible      = 0x10000000
	wsChild        = 0x40000000
	wsTabStop      = 0x00010000
	wsExTopmost    = 0x00000008
	wsExToolWindow = 0x00000080
	wsExLayered    = 0x00080000

	// BS_OWNERDRAW: the buttons are painted by quickCaptureWndProc's WM_DRAWITEM handler instead
	// of the stock (light, bevelled) button look.
	bsOwnerDraw = 0x0000000B

	wmPaint        = 0x000F
	wmDrawItem     = 0x002B
	wmCtlColorEdit = 0x0133
	wmMouseMove    = 0x0200
	wmMouseLeave   = 0x02A3

	tmeLeave    = 0x2
	odtButton   = 4
	odsSelected = 0x1

	dtCenter     = 0x1
	dtVCenter    = 0x4
	dtSingleLine = 0x20

	// Stock GDI objects: DC_BRUSH/DC_PEN take their color from SetDCBrushColor/SetDCPenColor, so
	// painting needs no per-draw brush or pen allocation (and nothing to leak or delete).
	stockNullPen = 8
	stockDCBrush = 18
	stockDCPen   = 19

	bkModeTransparent = 1

	// DwmSetWindowAttribute attributes (Windows 11): rounded corners and a border color that
	// matches the popup instead of the system accent.
	dwmwaWindowCornerPreference = 33
	dwmwaBorderColor            = 34
	dwmwcpRound                 = 2

	// lwaAlpha selects whole-window constant alpha for SetLayeredWindowAttributes.
	lwaAlpha = 0x2
	// quickCaptureAlpha is the popup's opacity (0 transparent .. 255 opaque). ~85% is visibly
	// see-through over a bright window; going lower washes the light text out against a light
	// backdrop now that the popup itself is dark.
	quickCaptureAlpha = 217

	esAutoHScroll = 0x0080

	smCxScreen = 0

	idcArrow = 32512

	idQuickCaptureEdit      = 1101
	idQuickCaptureBtnSend   = 1102
	idQuickCaptureBtnFormat = 1103

	// Single-row layout: input field on the left, both buttons to its right, all one line. The
	// window height is sized to exactly fit one control row plus the margin.
	quickCaptureWidth      = 640
	quickCaptureMargin     = 4
	quickCaptureCtrlHeight = 28
	quickCaptureHeight     = quickCaptureCtrlHeight + 2*quickCaptureMargin
	quickCaptureTopY       = 120
	quickCaptureBtnGap     = 4
	// Send and AI Send are the same width so the two buttons read as a matched pair.
	quickCaptureBtnSendW   = 80
	quickCaptureBtnFormatW = 80

	// The input field is a rounded rectangle painted by the parent window; the EDIT control sits
	// inside it, inset by quickCaptureFieldPadX and vertically centered, with no border of its own.
	quickCaptureRadius     = 6
	quickCaptureFieldPadX  = 10
	quickCaptureEditHeight = 20

	// COLORREFs (0x00BBGGRR) taken from md-memo's dark theme in frontend/css/style.css:
	// --bg-modal, --bg-input, --bg-btn, --bg-btn-hover, --text-main, --text-active, --border-color.
	// The accent color is not here: it follows the user's selected theme (see quickCaptureAccent).
	colBg         = 0x262525
	colField      = 0x3c3c3c
	colBtn        = 0x333333
	colBtnHover   = 0x444444
	colText       = 0xd4d4d4
	colTextActive = 0xffffff
	colBorder     = 0x423e3e
)

// WNDCLASSEXW mirrors the Win32 struct field-for-field. Field sizes/types are
// chosen so Go's own alignment rules reproduce the C layout on amd64 (the only
// architecture this app ships for): the two int32 fields sit between two
// pointer-sized runs, exactly as in the real struct.
type WNDCLASSEXW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

// msgT mirrors the Win32 MSG struct field-for-field (see WNDCLASSEXW's comment above for why this
// approach reproduces the C layout correctly on amd64): hwnd/wParam/lParam are pointer-sized, so
// Go's own alignment rules insert the same padding after the 32-bit message field, and after the
// trailing pt.y, that the real struct has.
type msgT struct {
	hwnd    windows.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}

type rectT struct {
	left, top, right, bottom int32
}

// paintStructT mirrors PAINTSTRUCT (72 bytes on amd64: Go inserts the same padding as C).
type paintStructT struct {
	hdc         windows.Handle
	fErase      int32
	rcPaint     rectT
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

// drawItemStructT mirrors DRAWITEMSTRUCT, passed as lParam of WM_DRAWITEM.
type drawItemStructT struct {
	ctlType    uint32
	ctlID      uint32
	itemID     uint32
	itemAction uint32
	itemState  uint32
	hwndItem   windows.Handle
	hDC        windows.Handle
	rcItem     rectT
	itemData   uintptr
}

// trackMouseEventT mirrors TRACKMOUSEEVENT.
type trackMouseEventT struct {
	cbSize      uint32
	dwFlags     uint32
	hwndTrack   windows.Handle
	dwHoverTime uint32
}

var (
	procSelectObject    = modGdi32.NewProc("SelectObject")
	procGetStockObject  = modGdi32.NewProc("GetStockObject")
	procSetDCBrushColor = modGdi32.NewProc("SetDCBrushColor")
	procSetDCPenColor   = modGdi32.NewProc("SetDCPenColor")
	procRoundRect       = modGdi32.NewProc("RoundRect")
	procSetBkMode       = modGdi32.NewProc("SetBkMode")
	procSetBkColor      = modGdi32.NewProc("SetBkColor")
	procSetTextColor    = modGdi32.NewProc("SetTextColor")
	procCreateRoundRgn  = modGdi32.NewProc("CreateRoundRectRgn")

	procFillRect        = modUser32.NewProc("FillRect")
	procDrawTextW       = modUser32.NewProc("DrawTextW")
	procBeginPaint      = modUser32.NewProc("BeginPaint")
	procEndPaint        = modUser32.NewProc("EndPaint")
	procInvalidateRect  = modUser32.NewProc("InvalidateRect")
	procTrackMouseEvent = modUser32.NewProc("TrackMouseEvent")
	procSetWindowRgn    = modUser32.NewProc("SetWindowRgn")
)

var (
	procRegisterClassExW     = modUser32.NewProc("RegisterClassExW")
	procCreateWindowExW      = modUser32.NewProc("CreateWindowExW")
	procDefWindowProcW       = modUser32.NewProc("DefWindowProcW")
	procGetForegroundWindow  = modUser32.NewProc("GetForegroundWindow")
	procGetWindowTextW       = modUser32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW = modUser32.NewProc("GetWindowTextLengthW")
	procGetKeyState          = modUser32.NewProc("GetKeyState")
	procSetFocus             = modUser32.NewProc("SetFocus")
	procGetFocus             = modUser32.NewProc("GetFocus")
	procGetSystemMetrics     = modUser32.NewProc("GetSystemMetrics")
	procLoadCursorW          = modUser32.NewProc("LoadCursorW")
	procOpenClipboard        = modUser32.NewProc("OpenClipboard")
	procCloseClipboard       = modUser32.NewProc("CloseClipboard")
	procGetClipboardData     = modUser32.NewProc("GetClipboardData")
	procGlobalLock           = modKernel32.NewProc("GlobalLock")
	procGlobalUnlock         = modKernel32.NewProc("GlobalUnlock")
	procSetLayeredWindowAttr = modUser32.NewProc("SetLayeredWindowAttributes")
	procGetMessageW          = modUser32.NewProc("GetMessageW")
	procTranslateMessage     = modUser32.NewProc("TranslateMessage")
	procDispatchMessageW     = modUser32.NewProc("DispatchMessageW")

	procCreateFontW = modGdi32.NewProc("CreateFontW")

	// modImm32/procImmGetContext/procImmReleaseContext are already declared in
	// window_windows.go (used there for the IME mode toggle) - reused as-is here.
	procImmGetCompositionStringW = modImm32.NewProc("ImmGetCompositionStringW")
)

// isIMEComposing asks the IME directly (via IMM32) whether hwnd currently has a non-empty
// composition string in progress, instead of tracking WM_IME_STARTCOMPOSITION/ENDCOMPOSITION
// messages: diagnostic logging showed those messages are just as unreliable on this thread's
// shared message loop as WM_KEYDOWN for Enter/Escape was, so a flag fed by them stayed
// permanently false and Enter kept firing submit mid-conversion regardless. Querying the IME's
// actual current state synchronously sidesteps that unreliable message delivery entirely.
func isIMEComposing(hwnd windows.Handle) bool {
	himc, _, _ := procImmGetContext.Call(uintptr(hwnd))
	if himc == 0 {
		return false
	}
	defer procImmReleaseContext.Call(uintptr(hwnd), himc)
	size, _, _ := procImmGetCompositionStringW.Call(himc, gcsCompStr, 0, 0)
	return int32(size) > 0
}

var (
	quickCaptureMu              sync.Mutex
	quickCaptureClassOnce       sync.Once
	quickCaptureHInstance       windows.Handle
	quickCaptureHwnd            windows.Handle
	quickCaptureEditHwnd        windows.Handle
	quickCaptureBtnSendHwnd     windows.Handle
	quickCaptureBtnFormatHwnd   windows.Handle
	quickCaptureForegroundTitle string
	origQuickCaptureEditWndProc uintptr
	quickCaptureFont            windows.Handle
	quickCaptureDismissTimer    *time.Timer

	// Brushes are created once with the window class and live for the process lifetime (two
	// solid-color GDI handles); everything else is painted with stock DC brushes/pens.
	quickCaptureBrushBg    windows.Handle
	quickCaptureBrushField windows.Handle

	// Accent colors (COLORREF) for the popup's current theme, and the button the mouse is over.
	// Only ever touched from the popup's own thread.
	quickCaptureAccentColor      uintptr
	quickCaptureAccentHoverColor uintptr
	quickCaptureHoverBtn         windows.Handle
	origQuickCaptureBtnWndProc   uintptr

	// True while an AI Send is waiting on the model. Popup thread only.
	quickCaptureAIBusy bool
)

func colorRef(c [3]uint8) uintptr {
	return uintptr(c[0]) | uintptr(c[1])<<8 | uintptr(c[2])<<16
}

// scheduleQuickCaptureAutoDismiss/cancelQuickCaptureAutoDismiss implement "close the popup after
// it sits unfocused for 2 seconds" (it has no title bar/taskbar entry, so a lingering unfocused
// copy is easy to lose track of and just gets in the way). Both always run on the popup's own
// dedicated thread (see runQuickCapturePopupThread), except the timer's own fire callback, which
// runs on a Go timer goroutine and so must not touch the window directly - it posts wmAppDismiss
// instead, which is safe to call from any thread, and lets quickCaptureWndProc (on the popup's own
// thread) perform the actual DestroyWindow.
func scheduleQuickCaptureAutoDismiss() {
	cancelQuickCaptureAutoDismiss()
	quickCaptureDismissTimer = time.AfterFunc(2*time.Second, func() {
		quickCaptureMu.Lock()
		hwnd := quickCaptureHwnd
		quickCaptureMu.Unlock()
		if hwnd != 0 {
			_, _, _ = procPostMessageW.Call(uintptr(hwnd), wmAppDismiss, 0, 0)
		}
	})
}

func cancelQuickCaptureAutoDismiss() {
	if quickCaptureDismissTimer != nil {
		quickCaptureDismissTimer.Stop()
		quickCaptureDismissTimer = nil
	}
}

// registerQuickCaptureWindowsHotkey registers the fixed Ctrl+Shift+Q quick-capture
// hotkey. It is independent of the user-configurable HOTKEY_ID hotkey and must be
// registered/unregistered separately.
func registerQuickCaptureWindowsHotkey(hwnd windows.Handle) {
	_, _, _ = procRegisterHotKey.Call(uintptr(hwnd), HOTKEY_ID_QUICKCAPTURE, MOD_CONTROL|MOD_SHIFT|MOD_NOREPEAT, quickCaptureVKQ)
}

// showQuickCapturePopup captures the current foreground window's title, then creates (or asks the
// already-open popup to refocus) the tiny native popup for quick note entry. Runs on the caller's
// thread (the main WebView2 UI thread, from the WM_HOTKEY handler) - it never touches the popup's
// own hwnd directly once created, only via PostMessageW, because the popup window itself now lives
// on its own dedicated OS thread (see runQuickCapturePopupThread) and Win32 window handles must
// only be manipulated (SetFocus, DestroyWindow, etc.) from the thread that owns them.
func showQuickCapturePopup() {
	quickCaptureMu.Lock()
	existing := quickCaptureHwnd
	quickCaptureMu.Unlock()

	if existing != 0 {
		_, _, _ = procPostMessageW.Call(uintptr(existing), wmAppRefocus, 0, 0)
		return
	}

	// The foreground title must be read before the popup is created/shown, otherwise
	// GetForegroundWindow would just return our own popup.
	title := captureForegroundTitle()
	go runQuickCapturePopupThread(title)
}

// runQuickCapturePopupThread creates the popup window and pumps its own dedicated message loop on
// its own locked OS thread, entirely separate from the WebView2 UI thread. This replaced an
// earlier design that shared the WebView2 thread's message loop and relied on a system-wide
// WH_KEYBOARD_LL hook to intercept Enter/Escape (which never reached this window through the
// normal WM_KEYDOWN path - almost certainly consumed upstream by WebView2/Chromium's own
// accelerator-key handling on that shared thread). That hook fixed Enter/Escape but turned out to
// be the cause of a second bug: a global low-level keyboard hook is a well-known way to disrupt
// TSF/IME composition system-wide, and diagnostic logging confirmed exactly that failure mode -
// during composition the IME correctly reported VK_PROCESSKEY, but composition was never
// COMMITTED; instead the control fell back to inserting the raw typed romaji as literal
// characters. Giving the popup its own uncontended thread and message loop fixes both problems at
// once: Enter/Escape are delivered normally (nothing else competes for this thread's message
// queue), and there is no global hook left to interfere with IME composition anywhere in the
// system.
func runQuickCapturePopupThread(title string) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)

	registerQuickCaptureClass(hinst)

	screenWidth, _, _ := procGetSystemMetrics.Call(smCxScreen)
	x := (int32(screenWidth) - quickCaptureWidth) / 2
	if x < 0 {
		x = 0
	}

	className, _ := windows.UTF16PtrFromString(quickCaptureClassName)
	windowName, _ := windows.UTF16PtrFromString("MD-Memo Quick Capture")

	// Follow the theme the main window uses (config.json general.theme) for the accent color.
	theme := "olive"
	if globalApp != nil {
		cfgStr, _ := globalApp.GetConfig()
		theme = parseQuickCaptureTheme(cfgStr)
	}
	accent, accentHover := quickCaptureAccent(theme)
	quickCaptureAccentColor = colorRef(accent)
	quickCaptureAccentHoverColor = colorRef(accentHover)
	quickCaptureHoverBtn = 0

	// Created hidden (no WS_VISIBLE) so the rounded corners and alpha below are in place before
	// the first frame is shown.
	hwnd, _, _ := procCreateWindowExW.Call(
		uintptr(wsExTopmost|wsExToolWindow|wsExLayered),
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		uintptr(wsPopup|wsClipChildren),
		uintptr(x), uintptr(quickCaptureTopY), uintptr(quickCaptureWidth), uintptr(quickCaptureHeight),
		0, 0, uintptr(hinst), 0,
	)
	if hwnd == 0 {
		return
	}
	// A layered window shows nothing until its attributes are set, so this must follow creation.
	_, _, _ = procSetLayeredWindowAttr.Call(hwnd, 0, quickCaptureAlpha, lwaAlpha)

	// Windows 11 rounds the window and lets us set its border color. Older Windows rejects these
	// attributes, so fall back to clipping the window to a rounded region (square-cornered borders
	// are not drawn there, which is fine for a flat dark panel).
	cornerPref := int32(dwmwcpRound)
	hr, _, _ := procDwmSetWindowAttribute.Call(hwnd, dwmwaWindowCornerPreference, uintptr(unsafe.Pointer(&cornerPref)), unsafe.Sizeof(cornerPref))
	if int32(hr) == 0 {
		borderColor := uint32(colBorder)
		_, _, _ = procDwmSetWindowAttribute.Call(hwnd, dwmwaBorderColor, uintptr(unsafe.Pointer(&borderColor)), unsafe.Sizeof(borderColor))
	} else {
		rgn, _, _ := procCreateRoundRgn.Call(0, 0, quickCaptureWidth+1, quickCaptureHeight+1, 2*quickCaptureRadius, 2*quickCaptureRadius)
		if rgn != 0 {
			_, _, _ = procSetWindowRgn.Call(hwnd, rgn, 1)
		}
	}
	_, _, _ = procShowWindow.Call(hwnd, SW_SHOWNORMAL)

	quickCaptureMu.Lock()
	quickCaptureHInstance = hinst
	quickCaptureHwnd = windows.Handle(hwnd)
	quickCaptureForegroundTitle = title
	quickCaptureMu.Unlock()

	_, _, _ = procSetForegroundWindow.Call(hwnd)
	_, _, _ = procSetFocus.Call(uintptr(quickCaptureEditHwnd))

	// This popup's dedicated message pump. Runs until WM_DESTROY posts WM_QUIT (see
	// quickCaptureWndProc), at which point this goroutine - and the OS thread it is locked to -
	// exit; the next hotkey press spawns a fresh one.
	var msg msgT
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(ret) <= 0 {
			return
		}
		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		_, _, _ = procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// registerQuickCaptureClass registers the popup's window class exactly once;
// RegisterClassExW fails on a duplicate class name if called again.
func registerQuickCaptureClass(hinst windows.Handle) {
	quickCaptureClassOnce.Do(func() {
		wndProcCallback := windows.NewCallback(quickCaptureWndProc)
		className, _ := windows.UTF16PtrFromString(quickCaptureClassName)

		cursor, _, _ := procLoadCursorW.Call(0, idcArrow)

		var wc WNDCLASSEXW
		wc.cbSize = uint32(unsafe.Sizeof(wc))
		wc.lpfnWndProc = wndProcCallback
		wc.hInstance = hinst
		wc.hCursor = windows.Handle(cursor)
		brushBg, _, _ := procCreateSolidBrush.Call(colBg)
		brushField, _, _ := procCreateSolidBrush.Call(colField)
		quickCaptureBrushBg = windows.Handle(brushBg)
		quickCaptureBrushField = windows.Handle(brushField)

		wc.hbrBackground = quickCaptureBrushBg
		wc.lpszClassName = className

		_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

		// Same face md-memo's own UI uses first; Japanese glyphs fall back through GDI font
		// linking. Height -15 px is slightly larger than the main UI's 14 px body text, for typing.
		fontHandle, _, _ := procCreateFontW.Call(
			^uintptr(14), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0,
			uintptr(unsafe.Pointer(mustUTF16Ptr("Segoe UI"))),
		)
		quickCaptureFont = windows.Handle(fontHandle)
	})
}

func mustUTF16Ptr(s string) *uint16 {
	p, _ := windows.UTF16PtrFromString(s)
	return p
}

// quickCaptureWndProc must never let a Go panic escape into the raw Win32 message-dispatch
// callback boundary (undefined/unsafe behavior for the whole process's UI thread) - if anything
// below panics, fall back to DefWindowProcW's answer for this message instead of crashing.
func quickCaptureWndProc(hwnd windows.Handle, msg uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			result, _, _ = procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
		}
	}()

	switch msg {
	case wmCreate:
		createQuickCaptureControls(hwnd)
		return 0

	case wmCommand:
		notifyCode := uint32(wParam >> 16)
		ctrlID := uint32(wParam & 0xFFFF)
		if notifyCode == bnClicked {
			switch ctrlID {
			case idQuickCaptureBtnSend:
				submitQuickCapture(false)
				return 0
			case idQuickCaptureBtnFormat:
				submitQuickCapture(true)
				return 0
			}
		}

	case wmPaint:
		paintQuickCaptureField(hwnd)
		return 0

	case wmCtlColorEdit:
		// The EDIT control sits inside the rounded field, so it paints the field's colors.
		_, _, _ = procSetTextColor.Call(wParam, colText)
		_, _, _ = procSetBkColor.Call(wParam, colField)
		return uintptr(quickCaptureBrushField)

	case wmDrawItem:
		if drawQuickCaptureButton((*drawItemStructT)(unsafe.Pointer(lParam))) {
			return 1
		}

	case wmActivate:
		// Low word 0 = WA_INACTIVE: some other application's window just became active while
		// this popup (which has no title bar/taskbar entry, so it is easy to lose track of) was
		// still open. Give focus 2 seconds to come back (e.g. a stray click that returns) before
		// closing it - see scheduleQuickCaptureAutoDismiss.
		if uint32(wParam&0xFFFF) == 0 {
			scheduleQuickCaptureAutoDismiss()
		} else {
			cancelQuickCaptureAutoDismiss()
		}

	case wmAppRefocus:
		// Posted by showQuickCapturePopup when the hotkey is pressed again while this popup is
		// already open - runs on this window's own thread, so SetForegroundWindow/SetFocus are
		// safe to call directly here (unlike from the thread that posted this message).
		cancelQuickCaptureAutoDismiss()
		_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_SHOWNORMAL)
		_, _, _ = procSetForegroundWindow.Call(uintptr(hwnd))
		_, _, _ = procSetFocus.Call(uintptr(quickCaptureEditHwnd))
		return 0

	case wmAppDismiss:
		// Posted by scheduleQuickCaptureAutoDismiss's timer callback, which runs on an arbitrary
		// Go timer goroutine and so cannot call DestroyWindow directly.
		destroyQuickCapturePopup()
		return 0

	case WM_DESTROY:
		cancelQuickCaptureAutoDismiss()
		// Clear tracked handles so a later hotkey press recreates the popup
		// instead of being ignored by the double-creation guard above.
		quickCaptureMu.Lock()
		quickCaptureHwnd = 0
		quickCaptureMu.Unlock()
		quickCaptureEditHwnd = 0
		quickCaptureBtnSendHwnd = 0
		quickCaptureBtnFormatHwnd = 0
		origQuickCaptureEditWndProc = 0
		origQuickCaptureBtnWndProc = 0
		quickCaptureHoverBtn = 0
		quickCaptureAIBusy = false
		// Ends this window's dedicated message loop (runQuickCapturePopupThread) so its goroutine
		// and OS thread exit instead of blocking forever in GetMessageW.
		_, _, _ = procPostQuitMessage.Call(0)
	}

	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func quickCaptureFieldWidth() int {
	return quickCaptureWidth - 2*quickCaptureMargin - 2*quickCaptureBtnGap - quickCaptureBtnSendW - quickCaptureBtnFormatW
}

// selectDCPaint selects the stock DC brush and pen into hdc, colored fill (brush) and, unless
// outline is negative, outline (pen); a negative outline selects the null pen (no stroke).
func selectDCPaint(hdc uintptr, fill uintptr, outline int64) {
	brush, _, _ := procGetStockObject.Call(stockDCBrush)
	_, _, _ = procSetDCBrushColor.Call(hdc, fill)
	_, _, _ = procSelectObject.Call(hdc, brush)
	if outline < 0 {
		pen, _, _ := procGetStockObject.Call(stockNullPen)
		_, _, _ = procSelectObject.Call(hdc, pen)
		return
	}
	pen, _, _ := procGetStockObject.Call(stockDCPen)
	_, _, _ = procSetDCPenColor.Call(hdc, uintptr(outline))
	_, _, _ = procSelectObject.Call(hdc, pen)
}

// paintQuickCaptureField draws the rounded input field behind the EDIT control. The window class
// background (WM_ERASEBKGND) has already filled everything with colBg; WS_CLIPCHILDREN keeps this
// from painting over the controls themselves.
func paintQuickCaptureField(hwnd windows.Handle) {
	var ps paintStructT
	hdc, _, _ := procBeginPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
	if hdc != 0 {
		selectDCPaint(hdc, colField, -1)
		_, _, _ = procRoundRect.Call(hdc,
			quickCaptureMargin, quickCaptureMargin,
			uintptr(quickCaptureMargin+quickCaptureFieldWidth()), uintptr(quickCaptureMargin+quickCaptureCtrlHeight),
			2*quickCaptureRadius, 2*quickCaptureRadius)
	}
	_, _, _ = procEndPaint.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&ps)))
}

// drawQuickCaptureButton paints one owner-drawn button: Send in the theme accent color (it is the
// Enter action), AI Send as a neutral outlined button. Reports whether it handled the item.
func drawQuickCaptureButton(di *drawItemStructT) bool {
	if di == nil || di.ctlType != odtButton {
		return false
	}
	hdc := uintptr(di.hDC)
	hovered := di.hwndItem == quickCaptureHoverBtn || di.itemState&odsSelected != 0

	var fill uintptr
	var outline int64 = -1
	textColor := uintptr(colText)
	var label string
	switch di.ctlID {
	case idQuickCaptureBtnSend:
		label = "Send"
		fill = quickCaptureAccentColor
		if hovered {
			fill = quickCaptureAccentHoverColor
		}
		textColor = colTextActive
	case idQuickCaptureBtnFormat:
		label = "AI Send"
		if quickCaptureAIBusy {
			label = "Working…"
		}
		fill = colBtn
		if hovered {
			fill = colBtnHover
		}
		outline = colBorder
	default:
		return false
	}

	rc := di.rcItem
	// Corners of the rounded button fall outside it, so paint the window background under it first.
	selectDCPaint(hdc, colBg, -1)
	dcBrush, _, _ := procGetStockObject.Call(stockDCBrush)
	_, _, _ = procFillRect.Call(hdc, uintptr(unsafe.Pointer(&rc)), dcBrush)

	selectDCPaint(hdc, fill, outline)
	_, _, _ = procRoundRect.Call(hdc, uintptr(rc.left), uintptr(rc.top), uintptr(rc.right), uintptr(rc.bottom),
		2*quickCaptureRadius, 2*quickCaptureRadius)

	oldFont, _, _ := procSelectObject.Call(hdc, uintptr(quickCaptureFont))
	_, _, _ = procSetBkMode.Call(hdc, bkModeTransparent)
	_, _, _ = procSetTextColor.Call(hdc, textColor)
	_, _, _ = procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(mustUTF16Ptr(label))), ^uintptr(0),
		uintptr(unsafe.Pointer(&rc)), dtCenter|dtVCenter|dtSingleLine)
	_, _, _ = procSelectObject.Call(hdc, oldFont)
	return true
}

// quickCaptureButtonWndProc subclasses both buttons only to learn when the mouse enters and leaves
// them, so drawQuickCaptureButton can show a hover color. Everything else goes to the stock proc.
func quickCaptureButtonWndProc(hwnd windows.Handle, msg uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			result, _, _ = procCallWindowProcW.Call(origQuickCaptureBtnWndProc, uintptr(hwnd), uintptr(msg), wParam, lParam)
		}
	}()

	switch msg {
	case wmMouseMove:
		if quickCaptureHoverBtn != hwnd {
			quickCaptureHoverBtn = hwnd
			tme := trackMouseEventT{dwFlags: tmeLeave, hwndTrack: hwnd}
			tme.cbSize = uint32(unsafe.Sizeof(tme))
			_, _, _ = procTrackMouseEvent.Call(uintptr(unsafe.Pointer(&tme)))
			_, _, _ = procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		}
	case wmMouseLeave:
		if quickCaptureHoverBtn == hwnd {
			quickCaptureHoverBtn = 0
			_, _, _ = procInvalidateRect.Call(uintptr(hwnd), 0, 0)
		}
	}

	ret, _, _ := procCallWindowProcW.Call(origQuickCaptureBtnWndProc, uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func createQuickCaptureControls(hwndParent windows.Handle) {
	editClass, _ := windows.UTF16PtrFromString("EDIT")
	buttonClass, _ := windows.UTF16PtrFromString("BUTTON")
	sendLabel, _ := windows.UTF16PtrFromString("Send")
	formatLabel, _ := windows.UTF16PtrFromString("AI Send")

	fieldWidth := quickCaptureFieldWidth()

	// The EDIT control has no border of its own: it sits inset inside the rounded field that
	// paintQuickCaptureField draws, vertically centered.
	hEdit, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(editClass)),
		0,
		uintptr(wsChild|wsVisible|wsTabStop|esAutoHScroll),
		uintptr(quickCaptureMargin+quickCaptureFieldPadX),
		uintptr(quickCaptureMargin+(quickCaptureCtrlHeight-quickCaptureEditHeight)/2),
		uintptr(fieldWidth-2*quickCaptureFieldPadX), quickCaptureEditHeight,
		uintptr(hwndParent), idQuickCaptureEdit, uintptr(quickCaptureHInstance), 0,
	)
	quickCaptureEditHwnd = windows.Handle(hEdit)

	btnSendX := quickCaptureMargin + fieldWidth + quickCaptureBtnGap

	hBtnSend, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(buttonClass)),
		uintptr(unsafe.Pointer(sendLabel)),
		uintptr(wsChild|wsVisible|wsTabStop|bsOwnerDraw),
		uintptr(btnSendX), quickCaptureMargin, quickCaptureBtnSendW, quickCaptureCtrlHeight,
		uintptr(hwndParent), idQuickCaptureBtnSend, uintptr(quickCaptureHInstance), 0,
	)
	quickCaptureBtnSendHwnd = windows.Handle(hBtnSend)

	btnFormatX := btnSendX + quickCaptureBtnSendW + quickCaptureBtnGap

	hBtnFormat, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(buttonClass)),
		uintptr(unsafe.Pointer(formatLabel)),
		uintptr(wsChild|wsVisible|wsTabStop|bsOwnerDraw),
		uintptr(btnFormatX), quickCaptureMargin, quickCaptureBtnFormatW, quickCaptureCtrlHeight,
		uintptr(hwndParent), idQuickCaptureBtnFormat, uintptr(quickCaptureHInstance), 0,
	)
	quickCaptureBtnFormatHwnd = windows.Handle(hBtnFormat)

	if quickCaptureFont != 0 && quickCaptureEditHwnd != 0 {
		_, _, _ = procSendMessageW.Call(uintptr(quickCaptureEditHwnd), wmSetFont, uintptr(quickCaptureFont), 1)
	}

	// Both buttons share one small subclass that tracks mouse hover, which an owner-drawn button
	// does not report by itself.
	btnProcCallback := windows.NewCallback(quickCaptureButtonWndProc)
	for _, h := range []windows.Handle{quickCaptureBtnSendHwnd, quickCaptureBtnFormatHwnd} {
		if h == 0 {
			continue
		}
		prev, _, _ := procSetWindowLongPtrW.Call(uintptr(h), GWLP_WNDPROC, btnProcCallback)
		if prev != 0 {
			origQuickCaptureBtnWndProc = prev
		}
	}

	if quickCaptureEditHwnd != 0 {
		editProcCallback := windows.NewCallback(quickCaptureEditWndProc)
		ret, _, _ := procSetWindowLongPtrW.Call(uintptr(quickCaptureEditHwnd), GWLP_WNDPROC, editProcCallback)
		if ret != 0 {
			origQuickCaptureEditWndProc = ret
		}
	}
}

// quickCaptureEditWndProc intercepts Enter/Ctrl+Enter/Escape on the single-line
// edit control. WM_KEYDOWN is swallowed so the control never sees it, but
// TranslateMessage has already queued a WM_CHAR for '\r' by the time WM_KEYDOWN
// is dispatched to us, so WM_CHAR is swallowed too for the same two keys.
//
// While an IME composition is active, Enter is the IME's own "confirm this conversion" key, not
// "submit the popup" - intercepting it here would eat the keystroke before the IME ever gets to
// finalize the composed text into the control, corrupting what ends up in the edit box. Escape is
// IME's "cancel this conversion" key for the same reason. Both are only treated as submit/cancel
// once composition is inactive (checked via isIMEComposing).
//
// This now works because the popup runs its own dedicated thread and message loop (see
// runQuickCapturePopupThread): WM_KEYDOWN/WM_CHAR for Enter/Escape reach this subclass through
// the ordinary TranslateMessage/DispatchMessage path with nothing else competing for them. An
// earlier version shared the WebView2 UI thread's message loop, where these two keys never
// arrived at all (almost certainly consumed by WebView2/Chromium's own accelerator handling), and
// worked around that with a system-wide WH_KEYBOARD_LL hook - which fixed Enter/Escape but broke
// Japanese IME composition everywhere (a global low-level keyboard hook is a known way to disrupt
// TSF), so it was removed in favor of giving the popup its own thread instead.
func quickCaptureEditWndProc(hwnd windows.Handle, msg uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			result, _, _ = procCallWindowProcW.Call(origQuickCaptureEditWndProc, uintptr(hwnd), uintptr(msg), wParam, lParam)
		}
	}()

	switch msg {
	case wmKeyDown:
		if !isIMEComposing(hwnd) {
			switch wParam {
			case vkReturn:
				ctrlDown := isCtrlKeyDown()
				submitQuickCapture(ctrlDown)
				return 0
			case vkEscape:
				destroyQuickCapturePopup()
				return 0
			}
		}

	case wmChar:
		if (wParam == vkReturn || wParam == vkEscape) && !isIMEComposing(hwnd) {
			return 0
		}
	}

	ret, _, _ := procCallWindowProcW.Call(origQuickCaptureEditWndProc, uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

func isCtrlKeyDown() bool {
	state, _, _ := procGetKeyState.Call(vkControl)
	return state&0x8000 != 0
}

func captureForegroundTitle() string {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return ""
	}
	return getWindowText(windows.Handle(hwnd))
}

func getWindowText(hwnd windows.Handle) string {
	length, _, _ := procGetWindowTextLengthW.Call(uintptr(hwnd))
	if length == 0 {
		return ""
	}
	buf := make([]uint16, length+1)
	_, _, _ = procGetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf)
}

func getClipboardText() string {
	ret, _, _ := procOpenClipboard.Call(uintptr(quickCaptureHwnd))
	if ret == 0 {
		return ""
	}
	defer procCloseClipboard.Call()

	hData, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if hData == 0 {
		return ""
	}
	ptr, _, _ := procGlobalLock.Call(hData)
	if ptr == 0 {
		return ""
	}
	defer procGlobalUnlock.Call(hData)

	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(ptr)))
}

// resolveQuickCaptureText returns the edit box's text, falling back to the
// clipboard when the box is empty. This fallback is applied uniformly to both
// the plain and the formatted submit paths.
func resolveQuickCaptureText() string {
	text := strings.TrimSpace(getWindowText(quickCaptureEditHwnd))
	if text == "" {
		text = strings.TrimSpace(getClipboardText())
	}
	return text
}

// submitQuickCapture saves the typed text. Plain Send appends it as typed and closes. AI Send
// (formatted) first runs it through the same AI correction as the editor's Alt+C, then adds the
// "> [context: ...]" line. The model call can take seconds, so it runs on its own goroutine while
// the popup stays up showing "Working..."; the goroutine saves the entry and then asks the popup
// to close. It owns its own copy of the text, so closing the popup early (Escape, or focus loss)
// never loses the capture.
//
// Not AppendDailyScrap: it exists for CLI-piped input and always wraps content in a
// "## [HH:MM:SS] CLI Pipe" header plus a ```text code fence, which buried a quick-capture entry
// inside CLI-pipe framing. appendInboxEntry (app_inbox.go) does the right thing: scrap.AppendRaw
// verbatim, then git-sync trigger and the same window.onScrapAppended notification.
func submitQuickCapture(formatted bool) {
	if quickCaptureAIBusy {
		return
	}
	text := resolveQuickCaptureText()

	if text == "" || globalApp == nil {
		destroyQuickCapturePopup()
		return
	}

	if !formatted {
		globalApp.appendInboxEntry(globalApp.GetScrapDir(), text+"\n")
		destroyQuickCapturePopup()
		return
	}

	quickCaptureAIBusy = true
	if quickCaptureBtnFormatHwnd != 0 {
		_, _, _ = procInvalidateRect.Call(uintptr(quickCaptureBtnFormatHwnd), 0, 0)
	}
	title := quickCaptureForegroundTitle
	popup := quickCaptureHwnd
	go func() {
		corrected := text
		func() {
			defer func() {
				if r := recover(); r != nil {
					corrected = text
				}
			}()
			corrected = globalApp.correctQuickCaptureText(text)
		}()
		content := formatQuickCaptureEntry(corrected, title)
		globalApp.appendInboxEntry(globalApp.GetScrapDir(), content+"\n")
		_, _, _ = procPostMessageW.Call(uintptr(popup), wmAppDismiss, 0, 0)
	}()
}

func destroyQuickCapturePopup() {
	if quickCaptureHwnd == 0 {
		return
	}
	_, _, _ = procDestroyWindow.Call(uintptr(quickCaptureHwnd))
}
