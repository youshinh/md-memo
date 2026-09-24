//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

var (
	modDwmapi                 = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmSetWindowAttribute = modDwmapi.NewProc("DwmSetWindowAttribute")

	modGdi32             = windows.NewLazySystemDLL("gdi32.dll")
	procCreateSolidBrush = modGdi32.NewProc("CreateSolidBrush")

	modUser32                 = windows.NewLazySystemDLL("user32.dll")
	procSetWindowLongPtrW     = modUser32.NewProc("SetWindowLongPtrW")
	procSetClassLongPtrW      = modUser32.NewProc("SetClassLongPtrW")
	procSendMessageW          = modUser32.NewProc("SendMessageW")
	procPostMessageW          = modUser32.NewProc("PostMessageW")
	procRegisterWindowMessageW = modUser32.NewProc("RegisterWindowMessageW")
	procLoadImageW            = modUser32.NewProc("LoadImageW")
	procShowWindow            = modUser32.NewProc("ShowWindow")
	procSetForegroundWindow   = modUser32.NewProc("SetForegroundWindow")
	procFindWindowW           = modUser32.NewProc("FindWindowW")
	procCallWindowProcW       = modUser32.NewProc("CallWindowProcW")
	procCreatePopupMenu       = modUser32.NewProc("CreatePopupMenu")
	procAppendMenuW           = modUser32.NewProc("AppendMenuW")
	procTrackPopupMenu        = modUser32.NewProc("TrackPopupMenu")
	procDestroyMenu           = modUser32.NewProc("DestroyMenu")
	procGetCursorPos          = modUser32.NewProc("GetCursorPos")
	procDestroyWindow         = modUser32.NewProc("DestroyWindow")
	procPostQuitMessage       = modUser32.NewProc("PostQuitMessage")

	modPsapi            = windows.NewLazySystemDLL("psapi.dll")
	procEmptyWorkingSet = modPsapi.NewProc("EmptyWorkingSet")

	modShell32              = windows.NewLazySystemDLL("shell32.dll")
	procShell_NotifyIconW    = modShell32.NewProc("Shell_NotifyIconW")
	procIsZoomed             = modUser32.NewProc("IsZoomed")
	procGetWindowLongPtrW    = modUser32.NewProc("GetWindowLongPtrW")
	procGetWindowRect        = modUser32.NewProc("GetWindowRect")
	procSetWindowPos         = modUser32.NewProc("SetWindowPos")
	procMonitorFromWindow    = modUser32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW      = modUser32.NewProc("GetMonitorInfoW")

	modKernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procCreateMutexW   = modKernel32.NewProc("CreateMutexW")

	procRegisterHotKey   = modUser32.NewProc("RegisterHotKey")
	procUnregisterHotKey = modUser32.NewProc("UnregisterHotKey")
	procGetGUIThreadInfo = modUser32.NewProc("GetGUIThreadInfo")
	procKeybdEvent       = modUser32.NewProc("keybd_event")

	procSetWindowsHookExW   = modUser32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = modUser32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = modUser32.NewProc("CallNextHookEx")
	procGetCurrentThreadId  = modKernel32.NewProc("GetCurrentThreadId")

	modImm32                      = windows.NewLazySystemDLL("imm32.dll")
	procImmGetDefaultIMEWnd       = modImm32.NewProc("ImmGetDefaultIMEWnd")
	procImmGetContext             = modImm32.NewProc("ImmGetContext")
	procImmReleaseContext         = modImm32.NewProc("ImmReleaseContext")
	procImmSetConversionStatus    = modImm32.NewProc("ImmSetConversionStatus")
	procImmSetOpenStatus          = modImm32.NewProc("ImmSetOpenStatus")
)

const (
	WH_CBT             = 5
	HCBT_CREATEWND     = 3
	GCLP_HBRBACKGROUND = ^uintptr(9) // -10 in 2's complement

	WM_DESTROY      = 0x0002
	WM_CLOSE        = 0x0010
	WM_LBUTTONUP    = 0x0202
	WM_LBUTTONDBLCLK = 0x0203
	WM_RBUTTONUP    = 0x0205
	WM_APP          = 0x8000
	WM_TRAYICON     = WM_APP + 1
	WM_HOTKEY       = 0x0312

	MOD_ALT      = 0x0001
	MOD_CONTROL  = 0x0002
	MOD_SHIFT    = 0x0004
	MOD_WIN      = 0x0008
	MOD_NOREPEAT = 0x4000
	HOTKEY_ID    = 0x9001

	SW_HIDE       = 0
	SW_SHOWNORMAL = 1
	SW_MAXIMIZE   = 3
	SW_RESTORE    = 9

	GWLP_WNDPROC = ^uintptr(3) // -4 in 2's complement
	GWL_STYLE    = ^uintptr(15) // -16 in 2's complement

	WS_CAPTION    = 0x00C00000
	WS_THICKFRAME = 0x00040000

	MONITOR_DEFAULTTONEAREST = 2

	SWP_NOSIZE       = 0x0001
	SWP_NOMOVE       = 0x0002
	SWP_NOZORDER     = 0x0004
	SWP_NOACTIVATE   = 0x0010
	SWP_FRAMECHANGED = 0x0020

	WM_SYSCOMMAND = 0x0112
	SC_MAXIMIZE   = 0xF030
	SC_RESTORE    = 0xF120

	NIM_ADD    = 0x00000000
	NIM_MODIFY = 0x00000001
	NIM_DELETE = 0x00000002

	NIF_MESSAGE = 0x00000001
	NIF_ICON    = 0x00000002
	NIF_TIP     = 0x00000004

	MF_STRING    = 0x00000000
	MF_SEPARATOR = 0x00000800
	TPM_RETURNCMD = 0x0100
	TPM_NONOTIFY  = 0x0080

	ID_TRAY_OPEN = 1001
	ID_TRAY_QUIT = 1002
)

type POINT struct {
	X, Y int32
}

type MONITORINFO struct {
	CbSize    uint32
	RcMonitor windows.Rect
	RcWork    windows.Rect
	DwFlags   uint32
}

type GUITHREADINFO struct {
	CbSize        uint32
	Flags         uint32
	HwndActive    windows.Handle
	HwndFocus     windows.Handle
	HwndCapture   windows.Handle
	HwndMenuOwner windows.Handle
	HwndMoveSize  windows.Handle
	HwndCaret     windows.Handle
	RcCaret       windows.Rect
}

type NOTIFYICONDATAW struct {
	CbSize           uint32
	HWnd             windows.Handle
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            windows.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UTimeoutOrVersion uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         windows.GUID
	HBalloonIcon     windows.Handle
}

var (
	origWndProc       uintptr
	globalHwnd        windows.Handle
	globalApp         *App
	globalHIcon       windows.Handle
	isForceQuit       int32
	isTrayCreated     int32
	globalMutexHandle windows.Handle
	wmShowExistingMsg uint32
)

func getShowExistingMsg() uint32 {
	if wmShowExistingMsg == 0 {
		msgName, _ := windows.UTF16PtrFromString("MDMemo_Activate_Window_Msg_v1")
		ret, _, _ := procRegisterWindowMessageW.Call(uintptr(unsafe.Pointer(msgName)))
		wmShowExistingMsg = uint32(ret)
	}
	return wmShowExistingMsg
}

// trimProcessWorkingSet trims memory usage of main process safely
func trimProcessWorkingSet() {
	defer func() { _ = recover() }()
	h := windows.CurrentProcess()
	if procEmptyWorkingSet.Find() == nil {
		_, _, _ = procEmptyWorkingSet.Call(uintptr(h))
	}
}

func addTrayIcon(hwnd windows.Handle, hIcon windows.Handle) {
	if atomic.CompareAndSwapInt32(&isTrayCreated, 0, 1) {
		var nid NOTIFYICONDATAW
		nid.CbSize = uint32(unsafe.Sizeof(nid))
		nid.HWnd = hwnd
		nid.UID = 1
		nid.UFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
		nid.UCallbackMessage = WM_TRAYICON
		nid.HIcon = hIcon

		tip, _ := windows.UTF16FromString("MD-Memo")
		copy(nid.SzTip[:], tip)

		_, _, _ = procShell_NotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
	}
}

func removeTrayIcon(hwnd windows.Handle) {
	if atomic.CompareAndSwapInt32(&isTrayCreated, 1, 0) {
		var nid NOTIFYICONDATAW
		nid.CbSize = uint32(unsafe.Sizeof(nid))
		nid.HWnd = hwnd
		nid.UID = 1
		_, _, _ = procShell_NotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
	}
}

func showAndRestoreWindow(hwnd windows.Handle) {
	// Record visibility first: a working-set trim scheduled by an earlier hide checks this
	// flag before it fires, and must see the window as back on screen.
	setWindowVisible(true)
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_SHOWNORMAL)
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_RESTORE)
	_, _, _ = procSetForegroundWindow.Call(uintptr(hwnd))
}

func hideWindowToTray(hwnd windows.Handle) {
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_HIDE)
	setWindowVisible(false)
	// This runs on the UI thread (WM_CLOSE / tray menu / the minimizeWindow bind), so the
	// EmptyWorkingSet syscall must not happen inline. It is also delayed, so summoning the
	// window straight back does not have to fault every evicted page in again.
	scheduleWorkingSetTrim()
}

// closeWillQuit reports whether a WM_CLOSE ends the process. With the tray resident it only hides the window (trayWndProc),
// unless this is a forced quit (the tray's Quit, backend_forceQuit).
func closeWillQuit() bool {
	return atomic.LoadInt32(&isForceQuit) != 0 || !isResidentConfigEnabled()
}

func isResidentConfigEnabled() bool {
	if globalApp == nil {
		return true
	}
	cfgStr, err := globalApp.GetConfig()
	if err != nil || cfgStr == "" {
		return true // Default: resident mode enabled for maximum responsiveness
	}
	var c struct {
		General struct {
			TrayResident *bool `json:"trayResident"`
		} `json:"general"`
	}
	if err := json.Unmarshal([]byte(cfgStr), &c); err == nil && c.General.TrayResident != nil {
		return *c.General.TrayResident
	}
	return true
}

func handleTrayMenu(hwnd windows.Handle) {
	var pt POINT
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))

	hMenu, _, _ := procCreatePopupMenu.Call()
	if hMenu == 0 {
		return
	}
	defer procDestroyMenu.Call(hMenu)

	openText, _ := windows.UTF16PtrFromString("Open MD-Memo")
	quitText, _ := windows.UTF16PtrFromString("Quit")

	_, _, _ = procAppendMenuW.Call(hMenu, MF_STRING, ID_TRAY_OPEN, uintptr(unsafe.Pointer(openText)))
	_, _, _ = procAppendMenuW.Call(hMenu, MF_SEPARATOR, 0, 0)
	_, _, _ = procAppendMenuW.Call(hMenu, MF_STRING, ID_TRAY_QUIT, uintptr(unsafe.Pointer(quitText)))

	_, _, _ = procSetForegroundWindow.Call(uintptr(hwnd))
	cmd, _, _ := procTrackPopupMenu.Call(hMenu, TPM_RETURNCMD|TPM_NONOTIFY, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(hwnd), 0)

	switch cmd {
	case ID_TRAY_OPEN:
		showAndRestoreWindow(hwnd)
	case ID_TRAY_QUIT:
		atomic.StoreInt32(&isForceQuit, 1)
		removeTrayIcon(hwnd)
		if globalApp != nil {
			_ = globalApp.CloseWindow()
		}
		_, _, _ = procDestroyWindow.Call(uintptr(hwnd))
	}
}

func trayWndProc(hwnd windows.Handle, msg uint32, wParam uintptr, lParam uintptr) uintptr {
	// Handle activate broadcast from subsequent instances
	if activateMsg := getShowExistingMsg(); activateMsg != 0 && msg == activateMsg {
		showAndRestoreWindow(hwnd)
		return 0
	}

	switch msg {
	case WM_TRAYICON:
		switch lParam {
		case WM_LBUTTONUP, WM_LBUTTONDBLCLK:
			showAndRestoreWindow(hwnd)
			return 0
		case WM_RBUTTONUP:
			handleTrayMenu(hwnd)
			return 0
		}

	case WM_HOTKEY:
		if wParam == HOTKEY_ID {
			showAndRestoreWindow(hwnd)
			return 0
		}

	case WM_CLOSE:
		if !closeWillQuit() {
			// Minimize / Hide to system tray instead of destroying process
			hideWindowToTray(hwnd)
			return 0
		}
		// Otherwise terminate normally
		removeTrayIcon(hwnd)

	case WM_DESTROY:
		_, _, _ = procUnregisterHotKey.Call(uintptr(hwnd), HOTKEY_ID)
		removeTrayIcon(hwnd)
		_, _, _ = procPostQuitMessage.Call(0)
	}

	if origWndProc != 0 {
		ret, _, _ := procCallWindowProcW.Call(origWndProc, uintptr(hwnd), uintptr(msg), wParam, lParam)
		return ret
	}
	return 0
}

func applyNativeDarkMode(w webview2.WebView) {
	defer func() {
		_ = recover()
	}()

	hwnd := uintptr(w.Window())
	if hwnd == 0 {
		return
	}

	// 1. Explicitly load and assign window title bar icon (16x16) and taskbar icon (32x32)
	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	if hinst != 0 && procLoadImageW.Find() == nil && procSendMessageW.Find() == nil {
		// Resource ID 1 (default ID generated by rsrc)
		hIconSm, _, _ := procLoadImageW.Call(uintptr(hinst), 1, 1 /* IMAGE_ICON */, 16, 16, 0x00008000 /* LR_SHARED */)
		hIconLg, _, _ := procLoadImageW.Call(uintptr(hinst), 1, 1 /* IMAGE_ICON */, 32, 32, 0x00008000 /* LR_SHARED */)
		if hIconSm != 0 {
			globalHIcon = windows.Handle(hIconSm)
			_, _, _ = procSendMessageW.Call(hwnd, 0x0080 /* WM_SETICON */, 0 /* ICON_SMALL */, hIconSm)
		}
		if hIconLg != 0 {
			_, _, _ = procSendMessageW.Call(hwnd, 0x0080 /* WM_SETICON */, 1 /* ICON_BIG */, hIconLg)
		}
	}

	// 2. Enable Windows 10/11 Immersive Dark Mode for window frame & title bar
	darkMode := int32(1)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 20, uintptr(unsafe.Pointer(&darkMode)), 4)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&darkMode)), 4)

	// 3. Set Class background brush to dark RGB(30, 30, 30) (#1e1e1e)
	darkBrush, _, _ := procCreateSolidBrush.Call(0x001e1e1e) // 0x00BBGGRR -> 0x1e, 0x1e, 0x1e
	if darkBrush != 0 {
		var gclp int32 = -10
		_, _, _ = procSetClassLongPtrW.Call(hwnd, uintptr(gclp), darkBrush)
	}

	// 4. Set WebView2 Controller DefaultBackgroundColor to dark RGB(30, 30, 30) (#1e1e1e)
	// This prevents the default white canvas from flashing while web content is loading
	type ifaceHeader struct {
		itab uintptr
		data unsafe.Pointer
	}
	type webviewHeader struct {
		hwnd       uintptr
		mainthread uintptr
		browser    ifaceHeader
	}
	wh := (*webviewHeader)(unsafe.Pointer(reflectValPointer(w)))
	if wh != nil && wh.browser.data != nil {
		chromium := (*edge.Chromium)(wh.browser.data)
		if chromium != nil {
			ctrl := chromium.GetController()
			if ctrl != nil {
				ctrl2 := ctrl.GetICoreWebView2Controller2()
				if ctrl2 != nil {
					_ = ctrl2.PutDefaultBackgroundColor(edge.COREWEBVIEW2_COLOR{
						A: 255,
						R: 0x1e,
						G: 0x1e,
						B: 0x1e,
					})
				}
			}
		}
	}
}

var lastToggleMaximizeTime int64

// toggleWindowMaximize toggles window between maximized and restored state with debouncing
func toggleWindowMaximize(hwnd windows.Handle) {
	if hwnd == 0 {
		return
	}
	now := time.Now().UnixMilli()
	if now-atomic.LoadInt64(&lastToggleMaximizeTime) < 200 {
		return
	}
	atomic.StoreInt64(&lastToggleMaximizeTime, now)

	ret, _, _ := procIsZoomed.Call(uintptr(hwnd))
	if ret != 0 {
		_, _, _ = procShowWindow.Call(uintptr(hwnd), uintptr(SW_RESTORE))
	} else {
		_, _, _ = procShowWindow.Call(uintptr(hwnd), uintptr(SW_MAXIMIZE))
	}
}

// fullscreenState is only touched on the UI thread (the F11 accelerator and the bound function both run there).
var fullscreenState struct {
	on        bool
	style     uintptr
	rect      windows.Rect
	maximized bool
}

var lastToggleFullscreenTime int64

// toggleWindowFullscreen switches between the normal window and real full screen: no title bar, no frame, the whole monitor
// (taskbar included). It follows what Chromium does for its own F11: a maximized window is put back to its normal size first
// because Windows keeps the taskbar in front of a maximized window, and leaving full screen restores the style, the position
// and the maximized state.
func toggleWindowFullscreen(hwnd windows.Handle) {
	if hwnd == 0 {
		return
	}
	now := time.Now().UnixMilli()
	if now-atomic.LoadInt64(&lastToggleFullscreenTime) < 200 {
		return
	}
	atomic.StoreInt64(&lastToggleFullscreenTime, now)

	h := uintptr(hwnd)
	if !fullscreenState.on {
		zoomed, _, _ := procIsZoomed.Call(h)
		if zoomed != 0 {
			_, _, _ = procSendMessageW.Call(h, WM_SYSCOMMAND, SC_RESTORE, 0)
		}
		style, _, _ := procGetWindowLongPtrW.Call(h, GWL_STYLE)
		var rc windows.Rect
		_, _, _ = procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&rc)))
		monitor, _, _ := procMonitorFromWindow.Call(h, MONITOR_DEFAULTTONEAREST)
		var mi MONITORINFO
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		if ok, _, _ := procGetMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&mi))); ok == 0 {
			if zoomed != 0 {
				_, _, _ = procSendMessageW.Call(h, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
			}
			return
		}
		fullscreenState.on = true
		fullscreenState.style = style
		fullscreenState.rect = rc
		fullscreenState.maximized = zoomed != 0
		_, _, _ = procSetWindowLongPtrW.Call(h, GWL_STYLE, style&^uintptr(WS_CAPTION|WS_THICKFRAME))
		m := mi.RcMonitor
		_, _, _ = procSetWindowPos.Call(h, 0, uintptr(m.Left), uintptr(m.Top), uintptr(m.Right-m.Left), uintptr(m.Bottom-m.Top),
			SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED)
		return
	}

	fullscreenState.on = false
	_, _, _ = procSetWindowLongPtrW.Call(h, GWL_STYLE, fullscreenState.style)
	// Two moves on purpose: the first repaints the frame (and the taskbar), the second puts the window back where it was.
	_, _, _ = procSetWindowPos.Call(h, 0, 0, 0, 0, 0, SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED)
	r := fullscreenState.rect
	_, _, _ = procSetWindowPos.Call(h, 0, uintptr(r.Left), uintptr(r.Top), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top),
		SWP_NOZORDER|SWP_NOACTIVATE|SWP_FRAMECHANGED)
	if fullscreenState.maximized {
		_, _, _ = procSendMessageW.Call(h, WM_SYSCOMMAND, SC_MAXIMIZE, 0)
	}
}

// reflectValPointer extracts the underlying interface data pointer
func reflectValPointer(i interface{}) unsafe.Pointer {
	type eface struct {
		rtype uintptr
		data  unsafe.Pointer
	}
	return (*eface)(unsafe.Pointer(&i)).data
}

// configureWebViewSettings disables Chromium accelerator traps so F11, F5 and friends reach the page
func configureWebViewSettings(w webview2.WebView) {
	defer func() {
		_ = recover()
	}()

	type ifaceHeader struct {
		itab uintptr
		data unsafe.Pointer
	}
	type webviewHeader struct {
		hwnd       uintptr
		mainthread uintptr
		browser    ifaceHeader
	}

	wh := (*webviewHeader)(unsafe.Pointer(reflectValPointer(w)))
	if wh == nil || wh.browser.data == nil {
		return
	}
	chromium := (*edge.Chromium)(wh.browser.data)
	if chromium == nil {
		return
	}

	// 1. Disable browser accelerator keys so F11, F5, etc. are not swallowed by Chromium
	settings, err := chromium.GetSettings()
	if err == nil && settings != nil {
		_ = settings.PutAreBrowserAcceleratorKeysEnabled(false)
	}

	// Microphone / clipboard permissions are left at the WebView2 default (its own one-time prompt):
	// the preview pane can embed arbitrary HTML, so nothing is granted silently.

	// F11 and the other keys reach the page as ordinary keydown events now, and the page decides what they do (full screen,
	// Zen mode, ...). A native F11 handler used to sit here; it was handed the key code alone, so it took Shift+F11 as well and
	// Zen mode never saw its key, and it could not follow a user's own binding.
}

func checkSingleInstance() bool {
	mutexName, _ := windows.UTF16PtrFromString("Local\\MDMemo_SingleInstance_Mutex_v1")
	hMutex, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(mutexName)))
	if err == windows.ERROR_ALREADY_EXISTS {
		// Existing instance is already running!
		// Broadcast custom message to existing window to restore & activate itself
		msgID := getShowExistingMsg()
		if msgID != 0 {
			_, _, _ = procPostMessageW.Call(0xFFFF /* HWND_BROADCAST */, uintptr(msgID), 0, 0)
		}
		// Also try FindWindow fallback just in case
		title, _ := windows.UTF16PtrFromString("MD-Memo")
		hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
		if hwnd != 0 {
			showAndRestoreWindow(windows.Handle(hwnd))
		}
		return false // Second instance should exit immediately
	}
	globalMutexHandle = windows.Handle(hMutex)
	return true
}

func runPlatformWindow(app *App, serverURL string) {
	globalApp = app

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// 1. Instruct WebView2/Edge runtime to initialize its default rendering surface
	// with dark background (#1e1e1e) from the very first frame, eliminating the default white canvas flash.
	_ = os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0xFF1E1E1E")

	// Keep essential security & silence flags, but remove --disable-http-cache and --disable-gpu-shader-disk-cache
	// so WebView2 can leverage disk caches for instantaneous sub-100ms cold boots.
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--force-dark-mode "+
			"--disable-background-networking "+
			"--disable-sync "+
			"--disable-translate "+
			"--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion "+
			"--disable-component-update "+
			"--mute-audio "+
			"--disable-extensions "+
			"--disable-default-apps "+
			"--disable-speech-api "+
			"--disable-print-preview "+
			"--disable-spell-checking "+
			"--disable-autofill "+
			"--disable-breakpad "+
			"--no-default-browser-check "+
			"--renderer-process-limit=1 "+
			"--no-pings "+
			"--disable-domain-reliability "+
			"--disable-client-side-phishing-detection "+
			"--disable-hang-monitor",
	)

	// Prefer LocalAppData (%LOCALAPPDATA%) for WebView2 cache to avoid roaming profile sync overhead and Defender thrashing
	dataDir, err := os.UserCacheDir()
	if err != nil || dataDir == "" {
		dataDir, err = os.UserConfigDir()
		if err != nil || dataDir == "" {
			dataDir = os.TempDir()
		}
	}
	webViewDataPath := filepath.Join(dataDir, "md-memo", "webview")
	_ = os.MkdirAll(webViewDataPath, 0755)

	// Intercept Win32 window creation via thread-scoped WH_CBT hook so we can set
	// DWM dark mode and dark background brush BEFORE the window is first rendered or shown.
	var hHook uintptr
	darkBrush, _, _ := procCreateSolidBrush.Call(0x001e1e1e)
	cbtCallback := windows.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode == HCBT_CREATEWND && wParam != 0 {
			darkMode := int32(1)
			_, _, _ = procDwmSetWindowAttribute.Call(wParam, 20, uintptr(unsafe.Pointer(&darkMode)), 4)
			_, _, _ = procDwmSetWindowAttribute.Call(wParam, 19, uintptr(unsafe.Pointer(&darkMode)), 4)
			if darkBrush != 0 {
				_, _, _ = procSetClassLongPtrW.Call(wParam, GCLP_HBRBACKGROUND, darkBrush)
			}
		}
		ret, _, _ := procCallNextHookEx.Call(hHook, uintptr(nCode), wParam, lParam)
		return ret
	})

	tid, _, _ := procGetCurrentThreadId.Call()
	if procSetWindowsHookExW.Find() == nil && tid != 0 {
		hHook, _, _ = procSetWindowsHookExW.Call(WH_CBT, cbtCallback, 0, tid)
	}

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  webViewDataPath,
		WindowOptions: webview2.WindowOptions{
			Title:  "MD-Memo",
			Width:  1050,
			Height: 720,
			IconId: 1,
		},
	})

	if hHook != 0 && procUnhookWindowsHookEx.Find() == nil {
		_, _, _ = procUnhookWindowsHookEx.Call(hHook)
	}

	if w == nil {
		log.Fatalf("Failed to initialize WebView2. Make sure Microsoft Edge WebView2 Runtime is installed.")
	}
	defer func() {
		atomic.StoreInt32(&app.isDestroyed, 1)
		w.Destroy()
	}()

	app.w = w

	// Apply immediate native and WebView2 dark theme
	applyNativeDarkMode(w)

	hwnd := windows.Handle(w.Window())
	globalHwnd = hwnd

	// Configure WebView2 settings (browser accelerator keys off)
	configureWebViewSettings(w)

	// Add system tray icon
	if globalHIcon != 0 {
		addTrayIcon(hwnd, globalHIcon)
	}

	// Subclass window procedure to intercept WM_CLOSE and handle tray events
	newWndProcCallback := windows.NewCallback(trayWndProc)
	ret, _, _ := procSetWindowLongPtrW.Call(uintptr(hwnd), GWLP_WNDPROC, newWndProcCallback)
	if ret != 0 {
		origWndProc = ret
	}

	// Register global shortcut to restore/bring to front (reads from config, fallback to Ctrl+Alt+M)
	updateGlobalHotKeyNative(getInitialGlobalShortcut())

	w.SetSize(1050, 720, webview2.HintNone)

	// Bind Go RPC methods
	_ = w.Bind("backend_getAppVersion", app.GetAppVersion)
	_ = w.Bind("backend_getPlatformCapabilities", app.GetPlatformCapabilities)
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
	_ = w.Bind("backend_exportConfig", app.ExportConfig)
	_ = w.Bind("backend_importConfig", app.ImportConfig)
	_ = w.Bind("backend_packListExportable", app.PackListExportable)
	_ = w.Bind("backend_packExport", app.PackExport)
	_ = w.Bind("backend_packInspect", app.PackInspect)
	_ = w.Bind("backend_packImport", app.PackImport)
	_ = w.Bind("backend_runCommandFilter", app.RunCommandFilter)
	_ = w.Bind("backend_runCommandFilterAsync", app.RunCommandFilterAsync)
	_ = w.Bind("backend_generateCliCommandAsync", app.GenerateCliCommandAsync)
	_ = w.Bind("backend_validateCliCommand", app.ValidateCliCommand)
	_ = w.Bind("backend_cancelCommandFilter", app.CancelCommandFilter)
	_ = w.Bind("backend_getSession", app.GetSession)
	_ = w.Bind("backend_saveSession", app.SaveSession)
	_ = w.Bind("backend_getStartupFile", app.GetStartupFile)
	_ = w.Bind("backend_openFile", app.OpenFile)
	_ = w.Bind("backend_saveFile", app.SaveFile)
	_ = w.Bind("backend_saveFileAs", app.SaveFileAs)
	_ = w.Bind("backend_exportPlainTextAs", app.ExportPlainTextAs)
	_ = w.Bind("backend_openFolder", app.OpenFolder)
	_ = w.Bind("backend_scanFolderFiles", app.ScanFolderFiles)
	_ = w.Bind("backend_readFileByPath", app.ReadFileByPath)
	_ = w.Bind("backend_queryLLMAsync", app.QueryLLMAsync)
	_ = w.Bind("backend_queryVisionAsync", app.QueryVisionAsync)
	_ = w.Bind("backend_generateImageAsync", app.GenerateImageAsync)
	_ = w.Bind("backend_autocompleteAsync", app.AutocompleteAsync)
	_ = w.Bind("backend_trimMemory", app.TrimMemory)
	_ = w.Bind("backend_uiReady", app.MarkUIReady)
	_ = w.Bind("backend_closeWindow", app.CloseWindow)
	_ = w.Bind("backend_updateGlobalShortcut", app.UpdateGlobalShortcut)
	_ = w.Bind("backend_searchScraps", app.SearchScraps)
	_ = w.Bind("backend_searchScrapsAsync", app.SearchScrapsAsync)
	_ = w.Bind("backend_triggerGitSync", app.TriggerGitSync)
	_ = w.Bind("backend_getGitRepoStatus", app.GetGitRepoStatus)
	_ = w.Bind("backend_setupGitRemote", app.SetupGitRemote)
	_ = w.Bind("backend_checkGitInstalled", app.CheckGitInstalled)
	_ = w.Bind("backend_testGitRemote", app.TestGitRemote)
	_ = w.Bind("backend_testDiscordBridgeConnection", app.TestDiscordBridgeConnection)
	_ = w.Bind("backend_reportRPCResult", app.ReportRPCResult)
	_ = w.Bind("backend_parseSlotsRPC", app.ParseSlotsRPC)
	_ = w.Bind("backend_runSlotAgentAsync", app.RunSlotAgentAsync)
	_ = w.Bind("backend_cancelSlotAgent", app.CancelSlotAgent)
	_ = w.Bind("backend_getSlotHoverPeek", app.GetSlotHoverPeek)
	_ = w.Bind("backend_watchActiveFile", app.WatchActiveFile)
	_ = w.Bind("backend_unwatchActiveFile", app.UnwatchActiveFile)
	_ = w.Bind("backend_getDefaultAgentsConfigYAML", app.GetDefaultAgentsConfigYAML)
	_ = w.Bind("backend_getDefaultAgentsConfigMarkdown", app.GetDefaultAgentsConfigMarkdown)
	_ = w.Bind("backend_getActiveAgentsConfigStatus", app.GetActiveAgentsConfigStatus)
	_ = w.Bind("backend_getActiveSlotConfigJSON", app.GetActiveSlotConfigJSON)
	_ = w.Bind("backend_checkAgentAvailability", app.CheckAgentAvailability)
	_ = w.Bind("backend_detectLLMProvider", app.DetectLLMProvider)
	_ = w.Bind("backend_updateActiveAgentsConfigDefaultAgent", app.UpdateActiveAgentsConfigDefaultAgent)
	_ = w.Bind("backend_exportAgentsConfigFile", app.ExportAgentsConfigFile)
	_ = w.Bind("backend_importAgentsConfigFile", app.ImportAgentsConfigFile)
	_ = w.Bind("backend_openAgentsConfigFile", app.OpenAgentsConfigFile)
	_ = w.Bind("backend_jevPredict", app.JevPredict)
	_ = w.Bind("backend_jevPredictAsync", app.JevPredictAsync)
	_ = w.Bind("backend_jevExecute", app.JevExecute)
	_ = w.Bind("backend_jevExecuteAsync", app.JevExecuteAsync)
	_ = w.Bind("backend_jevVerify", app.JevVerify)
	_ = w.Bind("backend_jevDispatchAgent", app.JevDispatchAgent)
	_ = w.Bind("backend_jevPruneContext", app.JevPruneContext)
	_ = w.Bind("backend_startMobileDrop", app.StartMobileDrop)
	_ = w.Bind("backend_startMobileDropWithVoice", app.StartMobileDropWithVoice)
	_ = w.Bind("backend_setMobileDropSharedText", app.SetMobileDropSharedText)
	_ = w.Bind("backend_cancelMobileDrop", app.CancelMobileDrop)
	_ = w.Bind("backend_requestMobileDropTunnelAsync", app.RequestMobileDropTunnelAsync)
	_ = w.Bind("backend_saveAsset", app.SaveAsset)
	_ = w.Bind("backend_importAssetFile", app.ImportAssetFile)
	_ = w.Bind("backend_openPath", app.OpenPath)
	_ = w.Bind("backend_revealPath", app.RevealPath)
	_ = w.Bind("backend_transcribeAudioAsync", app.TranscribeAudioAsync)
	_ = w.Bind("backend_getSpeechStatus", app.GetSpeechStatus)
	_ = w.Bind("backend_installSpeechPartAsync", app.InstallSpeechPartAsync)
	_ = w.Bind("backend_cancelSpeechInstall", app.CancelSpeechInstall)
	_ = w.Bind("backend_removeSpeechPart", app.RemoveSpeechPart)
	_ = w.Bind("backend_validateWhisperModelFile", app.ValidateWhisperModelFile)
	_ = w.Bind("backend_pickFilePath", app.PickFilePath)
	_ = w.Bind("backend_retryVoiceCacheAsync", app.RetryVoiceCacheAsync)
	_ = w.Bind("backend_keepVoiceCache", app.KeepVoiceCache)
	_ = w.Bind("backend_discardVoiceCache", app.DiscardVoiceCache)
	_ = w.Bind("backend_minimizeWindow", func() error {
		if isResidentConfigEnabled() {
			hideWindowToTray(hwnd)
		} else {
			_, _, _ = procShowWindow.Call(uintptr(hwnd), uintptr(windows.SW_MINIMIZE))
		}
		return nil
	})
	_ = w.Bind("backend_toggleFullscreen", func() error {
		toggleWindowFullscreen(hwnd)
		return nil
	})
	_ = w.Bind("backend_toggleMaximize", func() error {
		toggleWindowMaximize(hwnd)
		return nil
	})
	_ = w.Bind("backend_forceQuit", func() error {
		atomic.StoreInt32(&isForceQuit, 1)
		removeTrayIcon(hwnd)
		return app.CloseWindow()
	})
	_ = w.Bind("backend_openExternal", app.OpenExternal)
	_ = w.Bind("backend_setIMEMode", func(enableJapanese bool) error {
		// 1. Identify target window with input focus (WebView2 child control)
		targetHwnd := hwnd
		if procGetGUIThreadInfo.Find() == nil {
			var gui GUITHREADINFO
			gui.CbSize = uint32(unsafe.Sizeof(gui))
			ret, _, _ := procGetGUIThreadInfo.Call(0, uintptr(unsafe.Pointer(&gui)))
			if ret != 0 && gui.HwndFocus != 0 {
				targetHwnd = gui.HwndFocus
			}
		}

		// 2. Set IMM conversion status on target window
		hImc, _, _ := procImmGetContext.Call(uintptr(targetHwnd))
		if hImc != 0 {
			if enableJapanese {
				// IME_CMODE_NATIVE (0x0001) | IME_CMODE_FULLSHAPE (0x0008)
				_, _, _ = procImmSetOpenStatus.Call(hImc, 1)
				_, _, _ = procImmSetConversionStatus.Call(hImc, 0x0001|0x0008, 0)
			} else {
				_, _, _ = procImmSetOpenStatus.Call(hImc, 0)
			}
			_, _, _ = procImmReleaseContext.Call(uintptr(targetHwnd), hImc)
		}

		// 3. Native Key Assist: Send VK_IME_ON (0x16) / VK_IME_OFF (0x15) to guarantee OS mode change
		if procKeybdEvent.Find() == nil {
			const KEYEVENTF_KEYUP = 0x0002
			if enableJapanese {
				const VK_IME_ON = 0x16
				_, _, _ = procKeybdEvent.Call(VK_IME_ON, 0, 0, 0)
				_, _, _ = procKeybdEvent.Call(VK_IME_ON, 0, KEYEVENTF_KEYUP, 0)
			}
		}
		return nil
	})
	_ = w.Bind("backend_checkOllamaRunning", app.CheckOllamaRunning)
	_ = w.Bind("backend_startOllamaService", app.StartOllamaService)
	_ = w.Bind("backend_stopOllamaService", app.StopOllamaService)
	_ = w.Bind("backend_setupOllamaGemma4Async", app.SetupOllamaGemma4Async)
	_ = w.Bind("backend_cancelOllamaSetup", app.CancelOllamaSetup)

	w.Init(`
		// --- Async bridge -------------------------------------------------------------
		// Some backend calls (Jev prediction, scrap search) used to be synchronous binds,
		// which run INLINE ON THE UI THREAD and froze the window for the duration of the
		// call. They are now started with a backend_xxxAsync(reqID, ...) bind and completed
		// by a window.__onXxxResult(reqID, result, errMsg) callback. This helper keeps the
		// frontend-facing API identical: window.backend.<fn>(args) still returns a Promise
		// that resolves to the same shape and rejects on error. Pending entries are always
		// removed on resolve, reject, or the safety timeout, so the map cannot leak.
		window.__mdmemoPending = window.__mdmemoPending || {};
		window.__mdmemoSeq = 0;
		window.__mdmemoSettle = function (reqID, result, errMsg) {
			var p = window.__mdmemoPending[reqID];
			if (!p) { return; }
			delete window.__mdmemoPending[reqID];
			if (p.timer) { clearTimeout(p.timer); }
			if (errMsg) { p.reject(new Error(errMsg)); } else { p.resolve(result); }
		};
		window.__mdmemoAsync = function (prefix, timeoutMs, invoke) {
			var reqID = prefix + (++window.__mdmemoSeq) + '_' + Date.now();
			return new Promise(function (resolve, reject) {
				var entry = { resolve: resolve, reject: reject, timer: null };
				var fail = function (e) {
					if (!window.__mdmemoPending[reqID]) { return; }
					delete window.__mdmemoPending[reqID];
					if (entry.timer) { clearTimeout(entry.timer); }
					reject(e);
				};
				entry.timer = setTimeout(function () {
					fail(new Error(prefix + 'request timed out'));
				}, timeoutMs);
				window.__mdmemoPending[reqID] = entry;
				var r;
				try {
					r = invoke(reqID);
				} catch (e) {
					fail(e);
					return;
				}
				if (r && typeof r.catch === 'function') { r.catch(fail); }
			});
		};
		window.__onJevPredictResult = function (reqID, result, errMsg) {
			window.__mdmemoSettle(reqID, result, errMsg);
		};
		window.__onSearchScrapsResult = function (reqID, result, errMsg) {
			window.__mdmemoSettle(reqID, result, errMsg);
		};

		// Tell Go the document is loaded. A cold boot with piped stdin waits for this
		// signal (with a short fallback timeout) before appending the scrap, instead of
		// guessing with a fixed sleep. backend_uiReady is idempotent, so signalling from
		// both events is harmless.
		(function () {
			var signalReady = function () {
				try { window.backend_uiReady(); } catch (e) { /* binding not ready yet */ }
			};
			if (document.readyState === 'complete' || document.readyState === 'interactive') {
				signalReady();
			} else {
				document.addEventListener('DOMContentLoaded', signalReady, { once: true });
				window.addEventListener('load', signalReady, { once: true });
			}
		})();

		window.backend = {
			getAppVersion: () => window.backend_getAppVersion(),
			getPlatformCapabilities: () => window.backend_getPlatformCapabilities(),
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
			exportConfig: (configJson) => window.backend_exportConfig(configJson),
			importConfig: () => window.backend_importConfig(),
			packListExportable: (projectHint) => window.backend_packListExportable(projectHint || ""),
			packExport: (selectionJson, configJson) => window.backend_packExport(selectionJson || "", configJson || ""),
			packInspect: (projectHint) => window.backend_packInspect(projectHint || ""),
			packImport: (packPath, selectionJson, projectHint) => window.backend_packImport(packPath || "", selectionJson || "", projectHint || ""),
			runCommandFilter: (cmdStr, input) => window.backend_runCommandFilter(cmdStr, input),
			runCommandFilterAsync: (reqID, cmdStr, input) => window.backend_runCommandFilterAsync(reqID, cmdStr, input),
			cancelCommandFilter: (reqID) => window.backend_cancelCommandFilter(reqID),
			getSession: () => window.backend_getSession(),
			saveSession: (sessionJson) => window.backend_saveSession(sessionJson),
			getStartupFile: () => window.backend_getStartupFile(),
			openFile: () => window.backend_openFile(),
			openFolder: () => window.backend_openFolder(),
			scanFolderFiles: (rootPath) => window.backend_scanFolderFiles(rootPath),
			readFileByPath: (path) => window.backend_readFileByPath(path),
			saveFile: (path, content, enc) => window.backend_saveFile(path, content, enc),
			saveFileAs: (content, enc, defaultName) => window.backend_saveFileAs(content, enc, defaultName || ""),
			exportPlainTextAs: (content, enc, defaultName) => window.backend_exportPlainTextAs(content, enc, defaultName || ""),
			queryLLMAsync: (reqID, prompt, configJson) => window.backend_queryLLMAsync(reqID, prompt, configJson),
			queryVisionAsync: (reqID, prompt, imageBase64, mimeType, configJson) => window.backend_queryVisionAsync(reqID, prompt, imageBase64, mimeType, configJson),
			generateImageAsync: (reqID, prompt, configJson, notePath) => window.backend_generateImageAsync(reqID, prompt, configJson, notePath || ""),
			autocompleteAsync: (reqID, prefix, suffix, configJson) => window.backend_autocompleteAsync(reqID, prefix, suffix, configJson),
			trimMemory: () => window.backend_trimMemory(),
			closeWindow: () => window.backend_closeWindow(),
			minimizeWindow: () => window.backend_minimizeWindow(),
			toggleFullscreen: () => window.backend_toggleFullscreen(),
			toggleMaximize: () => window.backend_toggleMaximize(),
			forceQuit: () => window.backend_forceQuit(),
			openExternal: (url) => window.backend_openExternal(url),
			setIMEMode: (enableJapanese) => window.backend_setIMEMode(!!enableJapanese),
			updateGlobalShortcut: (sc) => window.backend_updateGlobalShortcut(sc || ""),
			checkOllamaRunning: () => window.backend_checkOllamaRunning(),
			startOllamaService: () => window.backend_startOllamaService(),
			stopOllamaService: () => window.backend_stopOllamaService(),
			setupOllamaGemma4Async: (reqID) => window.backend_setupOllamaGemma4Async(reqID),
			cancelOllamaSetup: (reqID) => window.backend_cancelOllamaSetup(reqID),
			generateCliCommandAsync: (reqID, prompt, configJson, contextJson) => window.backend_generateCliCommandAsync(reqID, prompt, configJson, contextJson || ""),
			validateCliCommand: (cmdStr) => window.backend_validateCliCommand(cmdStr),
			searchScraps: (query, maxResults) => window.__mdmemoAsync('searchScraps_', 30000, (reqID) => window.backend_searchScrapsAsync(reqID, query, maxResults || 100)),
			triggerGitSync: () => window.backend_triggerGitSync(),
			getGitRepoStatus: (dir) => window.backend_getGitRepoStatus(dir || ""),
			setupGitRemote: (dir, remoteUrl, branch) => window.backend_setupGitRemote(dir || "", remoteUrl || "", branch || ""),
			checkGitInstalled: () => window.backend_checkGitInstalled(),
			testGitRemote: (remoteUrl) => window.backend_testGitRemote(remoteUrl || ""),
			testDiscordBridgeConnection: (botToken, allowedUserId) => window.backend_testDiscordBridgeConnection(botToken || "", allowedUserId || ""),
			parseSlotsRPC: (fullText, cursorOffset, configJson) => window.backend_parseSlotsRPC(fullText, cursorOffset, configJson),
			runSlotAgentAsync: (reqID, filePath, fullText, cursorOffset, configJson) => window.backend_runSlotAgentAsync(reqID, filePath, fullText, cursorOffset, configJson),
			cancelSlotAgent: (reqID) => window.backend_cancelSlotAgent(reqID),
			getSlotHoverPeek: (reqID) => window.backend_getSlotHoverPeek(reqID),
			watchActiveFile: (filePath) => window.backend_watchActiveFile(filePath),
			unwatchActiveFile: () => window.backend_unwatchActiveFile(),
			getDefaultAgentsConfigYAML: () => window.backend_getDefaultAgentsConfigYAML(),
			getDefaultAgentsConfigMarkdown: () => window.backend_getDefaultAgentsConfigMarkdown(),
			getActiveAgentsConfigStatus: (scrapDir) => window.backend_getActiveAgentsConfigStatus(scrapDir || ""),
			getActiveSlotConfigJSON: () => window.backend_getActiveSlotConfigJSON(),
			checkAgentAvailability: (agentName) => window.backend_checkAgentAvailability(agentName || ""),
			detectLLMProvider: (baseUrl, apiKey) => window.backend_detectLLMProvider(baseUrl || "", apiKey || ""),
			updateActiveAgentsConfigDefaultAgent: (scrapDir, agentName) => window.backend_updateActiveAgentsConfigDefaultAgent(scrapDir || "", agentName || ""),
			exportAgentsConfigFile: (format) => window.backend_exportAgentsConfigFile(format || "yaml"),
			importAgentsConfigFile: () => window.backend_importAgentsConfigFile(),
			openAgentsConfigFile: (scrapDir) => window.backend_openAgentsConfigFile(scrapDir || ""),
			jevPredict: (contextText, cursorOffset) => window.__mdmemoAsync('jevPredict_', 15000, (reqID) => window.backend_jevPredictAsync(reqID, contextText, cursorOffset || 0)),
			jevExecute: (candidateJson, contextText) => window.backend_jevExecute(candidateJson, contextText || ""),
			jevExecuteAsync: (reqID, candidateJson, contextText) => window.backend_jevExecuteAsync(reqID, candidateJson, contextText || ""),
			jevVerify: (cmdStr) => window.backend_jevVerify(cmdStr),
			jevDispatchAgent: (input) => window.backend_jevDispatchAgent(input || ""),
			jevPruneContext: (rawMarkdown, query) => window.backend_jevPruneContext(rawMarkdown || "", query || ""),
			startMobileDrop: (visionConfigJson) => window.backend_startMobileDrop(visionConfigJson || ""),
			startMobileDropWithVoice: (visionConfigJson, voiceConfigJson) => window.backend_startMobileDropWithVoice(visionConfigJson || "", voiceConfigJson || ""),
			setMobileDropSharedText: (text) => window.backend_setMobileDropSharedText(text || ""),
			cancelMobileDrop: () => window.backend_cancelMobileDrop(),
			requestMobileDropTunnel: () => window.backend_requestMobileDropTunnelAsync(),
			saveAsset: (baseDir, ext, dataBase64) => window.backend_saveAsset(baseDir || "", ext || "", dataBase64 || ""),
			importAssetFile: (baseDir, fileName, dataBase64) => window.backend_importAssetFile(baseDir || "", fileName || "", dataBase64 || ""),
			openPath: (target, baseDir) => window.backend_openPath(target || "", baseDir || ""),
			revealPath: (target, baseDir) => window.backend_revealPath(target || "", baseDir || ""),
			transcribeAudioAsync: (reqID, audioBase64, mimeType, voiceConfigJson) => window.backend_transcribeAudioAsync(reqID, audioBase64 || "", mimeType || "", voiceConfigJson || ""),
			getSpeechStatus: (voiceConfigJson) => window.backend_getSpeechStatus(voiceConfigJson || ""),
			installSpeechPartAsync: (reqID, which, voiceConfigJson) => window.backend_installSpeechPartAsync(reqID, which || "", voiceConfigJson || ""),
			cancelSpeechInstall: (reqID) => window.backend_cancelSpeechInstall(reqID),
			removeSpeechPart: (which, voiceConfigJson) => window.backend_removeSpeechPart(which || "", voiceConfigJson || ""),
			validateWhisperModelFile: (path) => window.backend_validateWhisperModelFile(path || ""),
			pickFilePath: (title) => window.backend_pickFilePath(title || ""),
			retryVoiceCacheAsync: (reqID, cachePath, voiceConfigJson) => window.backend_retryVoiceCacheAsync(reqID, cachePath || "", voiceConfigJson || ""),
			keepVoiceCache: (cachePath, baseDir) => window.backend_keepVoiceCache(cachePath || "", baseDir || ""),
			discardVoiceCache: (cachePath) => window.backend_discardVoiceCache(cachePath || "")
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}

func parseShortcut(sc string) (uintptr, uintptr, bool) {
	parts := strings.Split(sc, "+")
	var mods uintptr = MOD_NOREPEAT
	var vk uintptr = 0

	for _, p := range parts {
		p = strings.TrimSpace(strings.ToUpper(p))
		switch p {
		case "CTRL", "CONTROL":
			mods |= MOD_CONTROL
		case "ALT", "OPTION":
			mods |= MOD_ALT
		case "SHIFT":
			mods |= MOD_SHIFT
		case "WIN", "CMD", "COMMAND":
			mods |= MOD_WIN
		case "SPACE":
			vk = 0x20
		case "ENTER", "RETURN":
			vk = 0x0D
		case "ESC", "ESCAPE":
			vk = 0x1B
		default:
			if strings.HasPrefix(p, "F") && len(p) >= 2 {
				var fNum int
				if _, err := fmt.Sscanf(p, "F%d", &fNum); err == nil && fNum >= 1 && fNum <= 24 {
					vk = uintptr(0x70 + (fNum - 1))
				}
			} else if len(p) == 1 {
				ch := p[0]
				if (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
					vk = uintptr(ch)
				}
			}
		}
	}
	if vk == 0 {
		return 0, 0, false
	}
	return mods, vk, true
}

func updateGlobalHotKeyNative(shortcutStr string) bool {
	if globalHwnd == 0 {
		return false
	}
	_, _, _ = procUnregisterHotKey.Call(uintptr(globalHwnd), HOTKEY_ID)
	if strings.TrimSpace(shortcutStr) == "" {
		return true // Unregistered successfully
	}
	mods, vk, ok := parseShortcut(shortcutStr)
	if !ok {
		return false
	}
	ret, _, _ := procRegisterHotKey.Call(uintptr(globalHwnd), HOTKEY_ID, mods, vk)
	return ret != 0
}

func getInitialGlobalShortcut() string {
	// Route through the App's cached reader when one exists (runPlatformWindow assigns
	// globalApp before calling this): config.json is otherwise read from disk a third time
	// on the critical path before the first frame is painted.
	var raw string
	if globalApp != nil {
		raw, _ = globalApp.GetConfig()
	} else {
		data, err := os.ReadFile(getConfigFilePath())
		if err != nil {
			return defaultGlobalSummonShortcut
		}
		raw = string(data)
	}
	return parseGlobalSummonShortcut(raw)
}

// closePlatformWindow implements App.CloseWindow for Windows. Destroying the WebView2 window
// is enough here: trayWndProc's WM_DESTROY case removes the tray icon, unregisters the global
// hotkey and posts WM_QUIT, which unwinds the message loop and returns from runPlatformWindow.
func closePlatformWindow(a *App) {
	if a.w == nil {
		return
	}
	if closeWillQuit() {
		atomic.StoreInt32(&a.isDestroyed, 1)
	}
	a.w.Dispatch(func() {
		if closer, ok := a.w.(interface{ Destroy() }); ok {
			closer.Destroy()
		}
	})
}

func activatePlatformWindow() {
	if globalHwnd != 0 {
		showAndRestoreWindow(globalHwnd)
	}
}
