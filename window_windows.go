//go:build windows

package main

import (
	"log"
	"os"
	"sync/atomic"
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

	modUser32            = windows.NewLazySystemDLL("user32.dll")
	procSetClassLongPtrW = modUser32.NewProc("SetClassLongPtrW")

	modPsapi            = windows.NewLazySystemDLL("psapi.dll")
	procEmptyWorkingSet = modPsapi.NewProc("EmptyWorkingSet")
)

// trimProcessWorkingSet trims memory usage of main process safely
func trimProcessWorkingSet() {
	defer func() { _ = recover() }()
	h := windows.CurrentProcess()
	if procEmptyWorkingSet.Find() == nil {
		_, _, _ = procEmptyWorkingSet.Call(uintptr(h))
	}
}

type internalChromium struct {
	hwnd        uintptr
	focusOnInit bool
	_pad        [7]byte
	controller  *edge.ICoreWebView2Controller
	webview     unsafe.Pointer
	inited      uintptr
}

type internalBrowserIface struct {
	typ  uintptr
	data *internalChromium
}

type internalWebview struct {
	hwnd       uintptr
	mainthread uintptr
	browser    internalBrowserIface
}

var iidICoreWebView2Controller2 = edge.GUID{
	Data1: 0xc979903e,
	Data2: 0xd4ca,
	Data3: 0x4228,
	Data4: [8]byte{0x92, 0xeb, 0x47, 0xee, 0x3f, 0xa9, 0x6e, 0xab},
}

func applyNativeDarkMode(w webview2.WebView) {
	defer func() {
		_ = recover()
	}()

	hwnd := uintptr(w.Window())
	if hwnd == 0 {
		return
	}

	// 1. Enable Windows 10/11 Immersive Dark Mode for window frame & title bar
	darkMode := int32(1)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 20, uintptr(unsafe.Pointer(&darkMode)), 4)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&darkMode)), 4)

	// 2. Set Class background brush to dark RGB(30, 30, 30) (#1e1e1e)
	darkBrush, _, _ := procCreateSolidBrush.Call(0x001e1e1e) // 0x00BBGGRR -> 0x1e, 0x1e, 0x1e
	if darkBrush != 0 {
		var gclp int32 = -10
		_, _, _ = procSetClassLongPtrW.Call(hwnd, uintptr(gclp), darkBrush)
	}

	// 3. Set WebView2 Controller DefaultBackgroundColor to dark RGB(30, 30, 30) (#1e1e1e)
	type ifaceHeader struct {
		typ  uintptr
		data *internalWebview
	}
	hdr := (*ifaceHeader)(unsafe.Pointer(&w))
	if hdr != nil && hdr.data != nil {
		wv := hdr.data
		if wv.browser.data != nil {
			chrom := wv.browser.data
			if chrom.controller != nil {
				type iunknownVtbl struct {
					QueryInterface edge.ComProc
				}
				type iunknown struct {
					vtbl *iunknownVtbl
				}
				ctrlUnk := (*iunknown)(unsafe.Pointer(chrom.controller))
				if ctrlUnk != nil && ctrlUnk.vtbl != nil {
					var ctrl2 *edge.ICoreWebView2Controller2
					r1, _, _ := ctrlUnk.vtbl.QueryInterface.Call(
						uintptr(unsafe.Pointer(chrom.controller)),
						uintptr(unsafe.Pointer(&iidICoreWebView2Controller2)),
						uintptr(unsafe.Pointer(&ctrl2)),
					)
					if r1 == 0 && ctrl2 != nil {
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
}

func runPlatformWindow(app *App, serverURL string) {
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
			"--disable-gpu-shader-disk-cache",
	)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "MD-Memo",
			Width:  1050,
			Height: 720,
			IconId: 0,
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

	w.SetSize(1050, 720, webview2.HintNone)

	// Bind Go RPC methods
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
	_ = w.Bind("backend_getSession", app.GetSession)
	_ = w.Bind("backend_saveSession", app.SaveSession)
	_ = w.Bind("backend_openFile", app.OpenFile)
	_ = w.Bind("backend_saveFile", app.SaveFile)
	_ = w.Bind("backend_saveFileAs", app.SaveFileAs)
	_ = w.Bind("backend_exportPlainTextAs", app.ExportPlainTextAs)
	_ = w.Bind("backend_queryLLMAsync", app.QueryLLMAsync)
	_ = w.Bind("backend_queryVisionAsync", app.QueryVisionAsync)
	_ = w.Bind("backend_autocompleteAsync", app.AutocompleteAsync)
	_ = w.Bind("backend_trimMemory", app.TrimMemory)

	w.Init(`
		window.backend = {
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
			getSession: () => window.backend_getSession(),
			saveSession: (sessionJson) => window.backend_saveSession(sessionJson),
			openFile: () => window.backend_openFile(),
			saveFile: (path, content, enc) => window.backend_saveFile(path, content, enc),
			saveFileAs: (content, enc, defaultName) => window.backend_saveFileAs(content, enc, defaultName || ""),
			exportPlainTextAs: (content, enc, defaultName) => window.backend_exportPlainTextAs(content, enc, defaultName || ""),
			queryLLMAsync: (reqID, prompt, configJson) => window.backend_queryLLMAsync(reqID, prompt, configJson),
			queryVisionAsync: (reqID, prompt, imageBase64, mimeType, configJson) => window.backend_queryVisionAsync(reqID, prompt, imageBase64, mimeType, configJson),
			autocompleteAsync: (reqID, prefix, suffix, configJson) => window.backend_autocompleteAsync(reqID, prefix, suffix, configJson),
			trimMemory: () => window.backend_trimMemory()
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}
