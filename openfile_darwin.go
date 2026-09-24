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
