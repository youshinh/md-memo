//go:build darwin && !cgo

package main

import "log"

// This file exists only so the package type-checks with CGO_ENABLED=0 on darwin (see
// tools/crosscheck.ps1 and platform_darwin.go). It is never linked into a real build: build_mac.sh
// always sets CGO_ENABLED=1, which is what makes window_darwin.go (`//go:build darwin && cgo`)
// and hotkey_darwin.go (import "C", implicitly cgo-only) the ones actually compiled and run.

// runPlatformWindow's real implementation is in window_darwin.go and needs Objective-C via cgo.
// A CGO_ENABLED=0 build of this package can still be type-checked, but never actually run the
// GUI, so this stub fails loudly instead of silently doing nothing.
func runPlatformWindow(app *App, serverURL string) {
	log.Fatal("macOS build requires CGO_ENABLED=1 (see build_mac.sh)")
}

// activatePlatformWindow's real implementation (window_darwin.go) calls into Objective-C to
// front the window. Nothing in a no-cgo build ever runs long enough to call it for real.
func activatePlatformWindow() {}

// updateGlobalHotKeyNative's real implementation lives in hotkey_darwin.go (Carbon via cgo).
// Reporting failure here matches what a real registration failure already does: the caller
// logs it and carries on without a global hotkey.
func updateGlobalHotKeyNative(shortcutStr string) bool { return false }
