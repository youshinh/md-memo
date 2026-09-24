//go:build darwin

package main

import (
	"strings"
	"testing"
)

// These tests read window_darwin.go as text, like platform_bridge_parity_test.go does: the
// orderings they pin down are invisible to the compiler, and breaking them fails only on a real
// Mac (a file that launched the app is refused, or Cmd+Q skips main's cleanup).

// TestAppDelegateInstalledBeforeWebviewNew guards the cold-launch "Open With" fix. The delegate
// must be NSApp's before webview.New runs: otherwise webview installs its own delegate, which has
// no application:openFiles:, and the file that launched the app is delivered to it.
func TestAppDelegateInstalledBeforeWebviewNew(t *testing.T) {
	src := readSourceFile(t, "window_darwin.go")

	install := strings.Index(src, "C.mdmemoInstallAppDelegate()")
	create := strings.Index(src, "webview.New(")
	if install < 0 || create < 0 {
		t.Fatalf("could not find C.mdmemoInstallAppDelegate() (%d) or webview.New( (%d) in window_darwin.go", install, create)
	}
	if install > create {
		t.Errorf("C.mdmemoInstallAppDelegate() is called after webview.New; a file that launches the app would reach webview's delegate instead of ours")
	}

	// The delegate must be set exactly once, in mdmemoInstallAppDelegate: a second setDelegate:
	// from a dispatch_async block is the pattern that lost the launch file.
	if n := strings.Count(src, "setDelegate:gAppDelegate]"); n != 2 {
		// One for NSApp (mdmemoInstallAppDelegate), one for the window (setupMacWindowDelegate).
		t.Errorf("found %d setDelegate:gAppDelegate calls, want 2 (NSApp once, the window once)", n)
	}
	fn := objcFunctionBody(t, src, "static void mdmemoInstallAppDelegate(void)")
	if strings.Contains(fn, "dispatch_async") {
		t.Errorf("mdmemoInstallAppDelegate must set the delegate synchronously, not from dispatch_async")
	}
	if !strings.Contains(fn, "[app setDelegate:gAppDelegate]") {
		t.Errorf("mdmemoInstallAppDelegate no longer sets NSApp's delegate")
	}
}

// TestQuitGoesThroughGracefulPath guards the Cmd+Q fix: the delegate answers
// applicationShouldTerminate:, and the Go handler it calls is registered once the webview exists
// (closePlatformWindow needs app.w).
func TestQuitGoesThroughGracefulPath(t *testing.T) {
	src := readSourceFile(t, "window_darwin.go")

	if !strings.Contains(src, "- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender") {
		t.Fatalf("MDMemoAppDelegate no longer implements applicationShouldTerminate:; Cmd+Q would exit() without saving or cleaning up")
	}

	assign := strings.Index(src, "app.w = w")
	register := strings.Index(src, "setOSQuitHandler(")
	run := strings.LastIndex(src, "w.Run()")
	if assign < 0 || register < 0 || run < 0 {
		t.Fatalf("could not find app.w = w (%d), setOSQuitHandler( (%d) or w.Run() (%d)", assign, register, run)
	}
	if register < assign || register > run {
		t.Errorf("setOSQuitHandler must be called after app.w is set and before w.Run()")
	}
}

// objcFunctionBody returns the text of the C/Objective-C function starting at signature, up to
// the first closing brace at the start of a line.
func objcFunctionBody(t *testing.T, src, signature string) string {
	t.Helper()
	start := strings.Index(src, signature)
	if start < 0 {
		t.Fatalf("could not find %q", signature)
	}
	rest := src[start:]
	end := strings.Index(rest, "\n}")
	if end < 0 {
		t.Fatalf("could not find the end of %q", signature)
	}
	return rest[:end]
}
