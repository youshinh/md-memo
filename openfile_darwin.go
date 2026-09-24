//go:build darwin

package main

import "C"

import "sync/atomic"

// osOpenHandler receives every file macOS asks the app to open (see the delegate's
// application:openFiles: in window_darwin.go). It is set once, before the run loop starts.
var osOpenHandler atomic.Pointer[func(string)]

func setOSOpenHandler(f func(string)) {
	osOpenHandler.Store(&f)
}

// mdmemoGoOpenFile is called from Objective-C on the main thread, once per file. It must return
// quickly: the handler only queues the path or starts a goroutine.
//
//export mdmemoGoOpenFile
func mdmemoGoOpenFile(path *C.char) {
	if path == nil {
		return
	}
	if h := osOpenHandler.Load(); h != nil {
		(*h)(C.GoString(path))
	}
}

// osQuitHandler ends the app when the user quits it from the menu or the Dock (see the
// delegate's applicationShouldTerminate: in window_darwin.go). It is set once the webview exists.
var osQuitHandler atomic.Pointer[func()]

func setOSQuitHandler(f func()) {
	osQuitHandler.Store(&f)
}

// mdmemoGoQuit is called from Objective-C on the main thread after the page has saved its
// session. It reports 1 when the handler has started the exit, and 0 when there is none yet, in
// which case the caller lets AppKit terminate the process itself. Like mdmemoGoOpenFile it must
// return quickly: the handler only schedules the run loop to stop.
//
//export mdmemoGoQuit
func mdmemoGoQuit() C.int {
	if h := osQuitHandler.Load(); h != nil {
		(*h)()
		return 1
	}
	return 0
}
