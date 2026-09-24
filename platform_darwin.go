//go:build darwin

package main

// This file holds the macOS platform functions that need no C.* call, split out of
// window_darwin.go so they - and the rest of this package - still type-check on a machine with
// no Objective-C toolchain: `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...` catches a
// pure-Go regression on Windows CI, without waiting for the macOS runner. window_darwin.go
// (`//go:build darwin && cgo`) keeps the functions that do call into Objective-C; the cgo-only
// symbols this file's callers still need (runPlatformWindow, activatePlatformWindow,
// updateGlobalHotKeyNative) get a stub in platform_darwin_nocgo.go for the !cgo build.

import (
	"log"
	"sync/atomic"
	"time"

	"md-memo/pkg/ipc"
	"md-memo/pkg/singleinstance"
)

// trimProcessWorkingSet is a no-op on macOS: there is no EmptyWorkingSet equivalent, and the
// kernel reclaims pages from an idle process on its own. App.TrimMemory still runs
// debug.FreeOSMemory off the UI thread on this platform, which is the part that matters here.
//
// Because this is a no-op, the windowVisible flag that gates the delayed trim has no effect
// on macOS, so the Cocoa show/hide paths (applicationShouldHandleReopen / windowShouldClose,
// both implemented in Objective-C in window_darwin.go) deliberately do not call back into Go
// just to set it - that would mean exporting Go callbacks through cgo for no behavioural gain.
func trimProcessWorkingSet() {}

// closePlatformWindow implements App.CloseWindow for macOS. It is also how Cmd+Q, the Quit menu
// item and Dock > Quit end the app, once the page has saved its session (window_darwin.go's
// applicationShouldTerminate: reaches it through mdmemoGoQuit).
//
// It stops the Cocoa run loop rather than destroying the webview. webview's cocoa engine
// closes the NSWindow on Destroy but never terminates NSApp, so the old behaviour left the
// process alive with no window: applicationShouldHandleReopen had nothing to show, the Dock
// icon did nothing, and the HTTP server and IPC listener stayed bound to their ports.
//
// Terminating this way (rather than [NSApp terminate:nil]) lets webview_run return normally,
// so runPlatformWindow's deferred Destroy and main's deferred ipcServer.Close() /
// listener.Close() all still run - which is what removes ipc-session.json on exit.
func closePlatformWindow(a *App) {
	if a.w == nil {
		return
	}
	// On macOS closing always ends the process (Terminate below), so the App is destroyed from here on.
	atomic.StoreInt32(&a.isDestroyed, 1)
	a.w.Dispatch(func() {
		if term, ok := a.w.(interface{ Terminate() }); ok {
			term.Terminate()
			return
		}
		if closer, ok := a.w.(interface{ Destroy() }); ok {
			closer.Destroy()
		}
	})
}

// checkSingleInstance reports whether this process may continue starting up.
//
// macOS had no check at all: it returned true unconditionally. Since the IPC handoff gained
// an acknowledgement handshake, a handoff that is not acknowledged deliberately falls through
// to a normal startup, so "no check" really did mean two full instances could run - and the
// second one overwrote ipc-session.json and then deleted it on exit, breaking the CLI for the
// first one.
func checkSingleInstance() bool {
	acquired, err := singleinstance.Acquire()
	if err != nil {
		// The lock file itself is unusable (unwritable config dir, a filesystem without
		// flock). Refusing to launch over that would be a worse failure than the duplicate
		// instance it guards against.
		log.Printf("single-instance lock unavailable, starting anyway: %v", err)
		return true
	}
	if acquired {
		return true
	}

	// Another live instance holds the lock. Bring it to the front - the same courtesy the
	// Windows mutex path performs with its broadcast activate message - and exit quietly.
	targetPort := ipc.DefaultPort
	if session, sessErr := ipc.LoadSession(); sessErr == nil && session != nil && session.Port > 0 {
		targetPort = session.Port
	}
	_ = ipc.Send(targetPort, &ipc.Message{
		Action:    ipc.ActionActivate,
		Timestamp: time.Now().Format(time.RFC3339),
	}, 300*time.Millisecond)

	return false
}

// initialGlobalShortcut reads shortcuts.globalSummon from the config, going through the App's
// cached reader so config.json is not read from disk again on the critical path. It mirrors
// getInitialGlobalShortcut in window_windows.go and shares its parsing.
func initialGlobalShortcut(app *App) string {
	var raw string
	if app != nil {
		raw, _ = app.GetConfig()
	}
	return parseGlobalSummonShortcut(raw)
}
