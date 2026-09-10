//go:build windows

package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"unsafe"

	"github.com/jchv/go-webview2"
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

	modKernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procCreateMutexW   = modKernel32.NewProc("CreateMutexW")
)

const (
	WM_DESTROY      = 0x0002
	WM_CLOSE        = 0x0010
	WM_LBUTTONUP    = 0x0202
	WM_LBUTTONDBLCLK = 0x0203
	WM_RBUTTONUP    = 0x0205
	WM_APP          = 0x8000
	WM_TRAYICON     = WM_APP + 1

	SW_HIDE    = 0
	SW_SHOWNORMAL = 1
	SW_RESTORE = 9

	GWLP_WNDPROC = ^uintptr(3) // -4 in 2's complement

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
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_SHOWNORMAL)
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_RESTORE)
	_, _, _ = procSetForegroundWindow.Call(uintptr(hwnd))
}

func hideWindowToTray(hwnd windows.Handle) {
	_, _, _ = procShowWindow.Call(uintptr(hwnd), SW_HIDE)
	trimProcessWorkingSet()
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

	case WM_CLOSE:
		if atomic.LoadInt32(&isForceQuit) == 0 && isResidentConfigEnabled() {
			// Minimize / Hide to system tray instead of destroying process
			hideWindowToTray(hwnd)
			return 0
		}
		// Otherwise terminate normally
		removeTrayIcon(hwnd)

	case WM_DESTROY:
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
			"--disable-client-side-phishing-detection",
	)

	dataDir, err := os.UserConfigDir()
	if err != nil {
		dataDir = os.TempDir()
	}
	webViewDataPath := filepath.Join(dataDir, "md-memo", "webview")
	_ = os.MkdirAll(webViewDataPath, 0755)

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

	w.SetSize(1050, 720, webview2.HintNone)

	// Bind Go RPC methods
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
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
	_ = w.Bind("backend_autocompleteAsync", app.AutocompleteAsync)
	_ = w.Bind("backend_trimMemory", app.TrimMemory)
	_ = w.Bind("backend_closeWindow", app.CloseWindow)
	_ = w.Bind("backend_forceQuit", func() error {
		atomic.StoreInt32(&isForceQuit, 1)
		removeTrayIcon(hwnd)
		return app.CloseWindow()
	})
	_ = w.Bind("backend_openExternal", app.OpenExternal)

	w.Init(`
		window.backend = {
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
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
			autocompleteAsync: (reqID, prefix, suffix, configJson) => window.backend_autocompleteAsync(reqID, prefix, suffix, configJson),
			trimMemory: () => window.backend_trimMemory(),
			closeWindow: () => window.backend_closeWindow(),
			forceQuit: () => window.backend_forceQuit(),
			openExternal: (url) => window.backend_openExternal(url)
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}
