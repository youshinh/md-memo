package main

import (
	"fmt"
	"os"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// This test reads window_windows.go, window_darwin.go and bind_common.go as plain text (it does
// not need cgo or a macOS toolchain, so it runs on every CI runner, including this Windows host)
// and checks three things that have silently drifted before:
//
//  1. The two platforms bind the same set of "backend_X" names to JS, except for a short,
//     explicit allowlist of features that only exist on one platform (Explorer "Send To" /
//     Quick Capture are Windows-only today; there is currently nothing macOS-only). A name bound
//     in bind_common.go (shared by both platforms via bindCommonBackend) counts as present on
//     both sides.
//  2. Every bind that hands webview a plain method value (`w.Bind("backend_X", app.Y)`, as
//     opposed to an inline closure) points at an App method whose signature webview_go's Bind
//     can actually marshal: at most two return values, and if there are two, the second one
//     must be an error. webview_go panics/rejects the bind at runtime otherwise (see
//     github.com/webview/webview_go's Bind doc comment), so this is worth catching at compile
//     time instead of by clicking every button on both operating systems. This applies to
//     bind_common.go's binds too, since they run on macOS just as much as window_darwin.go's own.
//  3. Every `window.backend.<x>` JS wrapper that forwards straight to a `window.backend_Y(...)`
//     call forwards exactly as many arguments as the bound Go method has parameters. webview_go
//     rejects a call with the wrong argument count at runtime ("function arguments mismatch"),
//     so a mismatch introduced on the Windows side (the file most often edited) would only be
//     noticed by clicking the matching button on a real Mac.

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
// above. bind_common.go's binds are folded into both platforms' sets: a name bound there is, by
// construction, bound on Windows and macOS alike.
func TestBindNamesMatchBetweenPlatforms(t *testing.T) {
	darwinSrc := readSourceFile(t, "window_darwin.go")
	windowsSrc := readSourceFile(t, "window_windows.go")
	commonSrc := readSourceFile(t, "bind_common.go")

	commonBinds := extractBindNames(commonSrc)
	darwinBinds := extractBindNames(darwinSrc)
	windowsBinds := extractBindNames(windowsSrc)

	if len(commonBinds) == 0 {
		t.Fatalf("found no w.Bind(...) calls in bind_common.go; the regex or the file layout probably changed")
	}
	if len(darwinBinds) == 0 || len(windowsBinds) == 0 {
		t.Fatalf("found no w.Bind(...) calls (darwin=%d, windows=%d); the regex or the file layout probably changed",
			len(darwinBinds), len(windowsBinds))
	}
	for name := range commonBinds {
		darwinBinds[name] = true
		windowsBinds[name] = true
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
	commonSrc := readSourceFile(t, "bind_common.go")

	appType := reflect.TypeOf((*App)(nil))
	errorType := reflect.TypeOf((*error)(nil)).Elem()

	// bind_common.go's binds run on macOS too (see bindCommonBackend's call site in
	// window_darwin.go), so they are just as subject to webview_go's shape requirement.
	matches := bindMethodRE.FindAllStringSubmatch(darwinSrc+"\n"+commonSrc, -1)
	if len(matches) == 0 {
		t.Fatal("found no w.Bind(\"backend_X\", app.Y) calls in window_darwin.go or bind_common.go; the regex or the file layout probably changed")
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

// jsBackendCallRE matches a JS call of the form window.backend_X(arg1, arg2, ...), as found in
// the window.backend = {...} wrapper object (and the standalone window.backend_uiReady() call)
// that each platform file's w.Init(...) literal defines. None of the arguments in any of these
// calls contain their own parentheses today (they are bare identifiers or `x || "default"`), so
// the argument list can be captured without balancing nested parens.
var jsBackendCallRE = regexp.MustCompile(`window\.backend_([A-Za-z0-9_]+)\(([^()]*)\)`)

// countForwardedArgs returns the number of comma-separated arguments in a JS call's argument
// list. ok is false when the list forwards a spread (...args), which cannot be counted
// statically and must be skipped by the caller.
func countForwardedArgs(raw string) (count int, ok bool) {
	s := strings.TrimSpace(raw)
	if strings.Contains(s, "...") {
		return 0, false
	}
	if s == "" {
		return 0, true
	}
	return len(strings.Split(s, ",")), true
}

// buildBindTargets extracts the backend_X -> app.Y plain-method-value binds visible to one
// platform (its own window_*.go plus the shared bind_common.go) into a name -> method name map.
// A name bound via an inline closure - or not bound with a plain method value on this platform at
// all - is simply absent from the result; the caller treats that as "cannot check statically".
func buildBindTargets(platformSrc, commonSrc string) map[string]string {
	targets := map[string]string{}
	for _, m := range bindMethodRE.FindAllStringSubmatch(commonSrc+"\n"+platformSrc, -1) {
		targets[m[1]] = m[2]
	}
	return targets
}

// lineOf returns the 1-based line number of byte offset idx within src.
func lineOf(src string, idx int) int {
	return strings.Count(src[:idx], "\n") + 1
}

// TestBackendShimArgumentCounts is the third parity item described at the top of this file: every
// window.backend_X(...) call found in a platform's Init JS must forward exactly as many arguments
// as the bound (*App) method has parameters. webview_go (macOS) rejects a mismatched call at
// runtime with "function arguments mismatch"; go-webview2 (Windows) does not enforce this the
// same way, so a mismatch introduced while editing window_windows.go - the file touched far more
// often - would otherwise only surface by clicking the matching button on a real Mac.
//
// A call is skipped (not failed) when its bind is an inline closure or otherwise not a plain
// `app.Y` value on that platform (the closure's own body is what actually runs, and is not
// reflectable), or when it forwards a spread. Skips are logged with a reason so a real gap does
// not hide silently; run with `go test -v` to see them.
func TestBackendShimArgumentCounts(t *testing.T) {
	windowsSrc := readSourceFile(t, "window_windows.go")
	darwinSrc := readSourceFile(t, "window_darwin.go")
	commonSrc := readSourceFile(t, "bind_common.go")

	appType := reflect.TypeOf((*App)(nil))
	windowsTargets := buildBindTargets(windowsSrc, commonSrc)
	darwinTargets := buildBindTargets(darwinSrc, commonSrc)

	platforms := []struct {
		name    string
		file    string
		src     string
		targets map[string]string
	}{
		{"windows", "window_windows.go", windowsSrc, windowsTargets},
		{"darwin", "window_darwin.go", darwinSrc, darwinTargets},
	}

	checked := 0
	var skipped []string
	for _, p := range platforms {
		for _, m := range jsBackendCallRE.FindAllStringSubmatchIndex(p.src, -1) {
			bindName := "backend_" + p.src[m[2]:m[3]]
			argsRaw := p.src[m[4]:m[5]]
			line := lineOf(p.src, m[0])

			methodName, bound := p.targets[bindName]
			if !bound {
				skipped = append(skipped, fmt.Sprintf("%s:%d window.%s (%s: inline closure or no plain app.Y bind)", p.file, line, bindName, p.name))
				continue
			}
			argCount, ok := countForwardedArgs(argsRaw)
			if !ok {
				skipped = append(skipped, fmt.Sprintf("%s:%d window.%s (%s: forwards a spread, cannot count statically)", p.file, line, bindName, p.name))
				continue
			}
			method, ok := appType.MethodByName(methodName)
			if !ok && p.name != runtime.GOOS {
				// Platform-only methods (Send To, Quick Capture) live in _windows.go files, so a
				// macOS test binary has no such method to reflect on; the Windows run checks them.
				skipped = append(skipped, fmt.Sprintf("%s:%d window.%s (%s-only method, checked when testing on %s)", p.file, line, bindName, p.name, p.name))
				continue
			}
			if !ok {
				t.Errorf("%s:%d calls window.%s, bound to app.%s, but (*App) has no such method", p.file, line, bindName, methodName)
				continue
			}
			// Method.Type on a value obtained via MethodByName from a pointer type includes the
			// receiver as the first "in" parameter.
			wantArgs := method.Type.NumIn() - 1
			checked++
			if argCount != wantArgs {
				t.Errorf("%s:%d window.%s forwards %d argument(s) to app.%s, which takes %d - webview_go rejects this call on macOS at runtime (\"function arguments mismatch\")",
					p.file, line, bindName, argCount, methodName, wantArgs)
			}
		}
	}
	if checked == 0 {
		t.Fatal("found no checkable window.backend_X(...) forwarding calls; the regex or the file layout probably changed")
	}

	sort.Strings(skipped)
	t.Logf("checked %d forwarding calls; skipped %d (inline closures / non-plain binds / spreads):", checked, len(skipped))
	for _, s := range skipped {
		t.Logf("  skip: %s", s)
	}
}
