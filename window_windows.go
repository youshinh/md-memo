//go:build windows

package main

import (
	"log"
	"os"
	"sync/atomic"

	"github.com/jchv/go-webview2"
)

func runPlatformWindow(app *App, serverURL string) {
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
		"--disable-background-networking "+
			"--disable-sync "+
			"--disable-translate "+
			"--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion "+
			"--disable-component-update "+
			"--mute-audio "+
			"--enable-features=ResourceScheduler "+
			"--disable-gpu-shader-disk-cache",
	)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "MD-Notepad",
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

	w.SetSize(1050, 720, webview2.HintNone)

	// Bind Go RPC methods
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
	_ = w.Bind("backend_openFile", app.OpenFile)
	_ = w.Bind("backend_saveFile", app.SaveFile)
	_ = w.Bind("backend_saveFileAs", app.SaveFileAs)
	_ = w.Bind("backend_exportPlainTextAs", app.ExportPlainTextAs)
	_ = w.Bind("backend_queryLLMAsync", app.QueryLLMAsync)
	_ = w.Bind("backend_queryVisionAsync", app.QueryVisionAsync)
	_ = w.Bind("backend_autocompleteAsync", app.AutocompleteAsync)

	w.Init(`
		window.backend = {
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
			openFile: () => window.backend_openFile(),
			saveFile: (path, content, enc) => window.backend_saveFile(path, content, enc),
			saveFileAs: (content, enc, defaultName) => window.backend_saveFileAs(content, enc, defaultName || ""),
			exportPlainTextAs: (content, enc, defaultName) => window.backend_exportPlainTextAs(content, enc, defaultName || ""),
			queryLLMAsync: (reqID, prompt, configJson) => window.backend_queryLLMAsync(reqID, prompt, configJson),
			queryVisionAsync: (reqID, prompt, imageBase64, mimeType, configJson) => window.backend_queryVisionAsync(reqID, prompt, imageBase64, mimeType, configJson),
			autocompleteAsync: (reqID, prefix, suffix, configJson) => window.backend_autocompleteAsync(reqID, prefix, suffix, configJson)
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}
