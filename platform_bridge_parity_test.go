package main

import (
	"os"
	"reflect"
	"regexp"
	"testing"
)

// This test reads window_windows.go and window_darwin.go as plain text (it does not need cgo
// or a macOS toolchain, so it runs on every CI runner, including this Windows host) and checks
// two things that have silently drifted before:
//
//  1. The two platforms bind the same set of "backend_X" names to JS, except for a short,
//     explicit allowlist of features that only exist on one platform (Explorer "Send To" /
//     Quick Capture are Windows-only today; there is currently nothing macOS-only).
//  2. Every bind that hands webview a plain method value (`w.Bind("backend_X", app.Y)`, as
//     opposed to an inline closure) points at an App method whose signature webview_go's Bind
//     can actually marshal: at most two return values, and if there are two, the second one
//     must be an error. webview_go panics/rejects the bind at runtime otherwise (see
//     github.com/webview/webview_go's Bind doc comment), so this is worth catching at compile
//     time instead of by clicking every button on both operating systems.

// windowsOnlyBinds names backend_ functions bound on Windows but not on macOS. Today these are
// Explorer "Send To" shortcut management and the fixed-hotkey Quick Capture popup, both Windows
// integrations with no macOS counterpart.
var windowsOnlyBinds = map[string]bool{
	"backend_openQuickCapture":           true,
	"backend_updateQuickCaptureShortcut": true,
	"backend_installSendToShortcut":      true,
	"backend_uninstallSendToShortcut":    true,
	"backend_isSendToShortcutInstalled":  true,
}

// darwinOnlyBinds names backend_ functions bound on macOS but not on Windows. There are none
// today; the map exists so a future macOS-only feature has somewhere to be declared instead of
// this test just breaking.
var darwinOnlyBinds = map[string]bool{}

var bindNameRE = regexp.MustCompile(`w\.Bind\("([^"]+)"`)

// bindMethodRE matches only the plain-method-value form `w.Bind("backend_X", app.Y)`, not an
// inline closure. Those are the ones whose target can be reflected on directly.
var bindMethodRE = regexp.MustCompile(`w\.Bind\("(backend_[A-Za-z0-9_]+)",\s*app\.([A-Za-z0-9_]+)\)`)

func readSourceFile(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("could not read %s: %v", name, err)
	}
	return string(data)
}

func extractBindNames(src string) map[string]bool {
	names := map[string]bool{}
	for _, m := range bindNameRE.FindAllStringSubmatch(src, -1) {
		names[m[1]] = true
	}
	return names
}

// TestBindNamesMatchBetweenPlatforms is the "set of names" half of the parity check described
// above.
func TestBindNamesMatchBetweenPlatforms(t *testing.T) {
	darwinSrc := readSourceFile(t, "window_darwin.go")
	windowsSrc := readSourceFile(t, "window_windows.go")

	darwinBinds := extractBindNames(darwinSrc)
	windowsBinds := extractBindNames(windowsSrc)

	if len(darwinBinds) == 0 || len(windowsBinds) == 0 {
		t.Fatalf("found no w.Bind(...) calls (darwin=%d, windows=%d); the regex or the file layout probably changed",
			len(darwinBinds), len(windowsBinds))
	}

	for name := range windowsBinds {
		if windowsOnlyBinds[name] {
			continue
		}
		if !darwinBinds[name] {
			t.Errorf("window_windows.go binds %q but window_darwin.go does not, and it is not in windowsOnlyBinds", name)
		}
	}
	for name := range darwinBinds {
		if darwinOnlyBinds[name] {
			continue
		}
		if !windowsBinds[name] {
			t.Errorf("window_darwin.go binds %q but window_windows.go does not, and it is not in darwinOnlyBinds", name)
		}
	}

	// Every allowlisted name must actually be missing on the other side and present on its own
	// side - otherwise the allowlist is stale and should shrink.
	for name := range windowsOnlyBinds {
		if !windowsBinds[name] {
			t.Errorf("windowsOnlyBinds contains %q, but window_windows.go no longer binds it - remove it from the allowlist", name)
		}
		if darwinBinds[name] {
			t.Errorf("windowsOnlyBinds contains %q, but window_darwin.go now binds it too - remove it from the allowlist", name)
		}
	}
	for name := range darwinOnlyBinds {
		if !darwinBinds[name] {
			t.Errorf("darwinOnlyBinds contains %q, but window_darwin.go no longer binds it - remove it from the allowlist", name)
		}
		if windowsBinds[name] {
			t.Errorf("darwinOnlyBinds contains %q, but window_windows.go now binds it too - remove it from the allowlist", name)
		}
	}
}

// TestDarwinBindMethodsMatchWebviewGoShape reflects on every App method bound as a plain method
// value on macOS (webview/webview_go, unlike the Windows go-webview2 fork, is the pickier of the
// two about this) and checks it returns at most two values, the second of which - if present -
// is an error. This is what webview_go's Bind requires; getting it wrong is normally only
// caught by clicking the button on a real Mac.
func TestDarwinBindMethodsMatchWebviewGoShape(t *testing.T) {
	darwinSrc := readSourceFile(t, "window_darwin.go")

	appType := reflect.TypeOf((*App)(nil))
	errorType := reflect.TypeOf((*error)(nil)).Elem()

	matches := bindMethodRE.FindAllStringSubmatch(darwinSrc, -1)
	if len(matches) == 0 {
		t.Fatal("found no w.Bind(\"backend_X\", app.Y) calls in window_darwin.go; the regex or the file layout probably changed")
	}

	checked := 0
	for _, m := range matches {
		bindName, methodName := m[1], m[2]
		method, ok := appType.MethodByName(methodName)
		if !ok {
			t.Errorf("%s binds app.%s, but (*App) has no such method", bindName, methodName)
			continue
		}
		checked++

		// Method.Type on a value obtained via MethodByName from a pointer type includes the
		// receiver as the first "in" parameter; only the "out" side matters here.
		numOut := method.Type.NumOut()
		if numOut > 2 {
			t.Errorf("%s binds app.%s, which returns %d values; webview_go's Bind allows at most 2 (a value and an error)",
				bindName, methodName, numOut)
			continue
		}
		if numOut == 2 {
			last := method.Type.Out(1)
			if !last.Implements(errorType) {
				t.Errorf("%s binds app.%s, whose second return value is %s, not error; webview_go's Bind requires the second of two return values to be an error",
					bindName, methodName, last)
			}
		}
	}
	if checked == 0 {
		t.Fatal("matched w.Bind(\"backend_X\", app.Y) calls, but none resolved to a real (*App) method - check bindMethodRE")
	}
}
