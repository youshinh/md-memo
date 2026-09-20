package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParseGlobalSummonShortcut(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty config falls back", "", defaultGlobalSummonShortcut},
		{"whitespace config falls back", "   \n", defaultGlobalSummonShortcut},
		{"malformed JSON falls back", "{not json", defaultGlobalSummonShortcut},
		{"no shortcuts section falls back", `{"general":{"trayResident":true}}`, defaultGlobalSummonShortcut},
		{"null shortcuts section falls back", `{"shortcuts":null}`, defaultGlobalSummonShortcut},
		{"missing key falls back", `{"shortcuts":{"minimize":"Ctrl+Shift+H"}}`, defaultGlobalSummonShortcut},
		{"blank value falls back", `{"shortcuts":{"globalSummon":"   "}}`, defaultGlobalSummonShortcut},
		{"configured value wins", `{"shortcuts":{"globalSummon":"Cmd+Shift+Space"}}`, "Cmd+Shift+Space"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseGlobalSummonShortcut(c.in); got != c.want {
				t.Fatalf("parseGlobalSummonShortcut(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestResolveStartupFileArg(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("# hello\n"), 0600); err != nil {
		t.Fatalf("failed to create fixture: %v", err)
	}
	subdir := filepath.Join(dir, "adirectory")
	if err := os.Mkdir(subdir, 0700); err != nil {
		t.Fatalf("failed to create fixture dir: %v", err)
	}

	t.Run("returns an absolute path for an existing file", func(t *testing.T) {
		got := resolveStartupFileArg([]string{file})
		if !filepath.IsAbs(got) {
			t.Fatalf("resolveStartupFileArg = %q, want an absolute path", got)
		}
		if got != file {
			t.Fatalf("resolveStartupFileArg = %q, want %q", got, file)
		}
	})

	t.Run("strips surrounding quotes", func(t *testing.T) {
		if got := resolveStartupFileArg([]string{`"` + file + `"`}); got != file {
			t.Fatalf("resolveStartupFileArg(quoted) = %q, want %q", got, file)
		}
	})

	t.Run("skips flags and picks the first real file", func(t *testing.T) {
		if got := resolveStartupFileArg([]string{"--debug", "-x", file}); got != file {
			t.Fatalf("resolveStartupFileArg = %q, want %q", got, file)
		}
	})

	t.Run("skips directories", func(t *testing.T) {
		if got := resolveStartupFileArg([]string{subdir, file}); got != file {
			t.Fatalf("resolveStartupFileArg = %q, want %q", got, file)
		}
	})

	t.Run("returns empty when nothing matches", func(t *testing.T) {
		for _, args := range [][]string{
			nil,
			{},
			{"--headless"},
			{filepath.Join(dir, "does-not-exist.md")},
			{""},
		} {
			if got := resolveStartupFileArg(args); got != "" {
				t.Errorf("resolveStartupFileArg(%v) = %q, want \"\"", args, got)
			}
		}
	})

	t.Run("relative path is made absolute", func(t *testing.T) {
		// A relative argument must not be forwarded as-is: the running instance that receives
		// the "open" message has a completely different working directory.
		cwd, err := os.Getwd()
		if err != nil {
			t.Skipf("cannot determine cwd: %v", err)
		}
		rel, err := filepath.Rel(cwd, file)
		if err != nil {
			t.Skipf("no relative path from %q to %q: %v", cwd, file, err)
		}
		got := resolveStartupFileArg([]string{rel})
		if !filepath.IsAbs(got) {
			t.Fatalf("resolveStartupFileArg(%q) = %q, want an absolute path", rel, got)
		}
	})
}

func TestBuildOpenInNewTabJSEscapesEverything(t *testing.T) {
	title := `we"ird'.md`
	content := "line1\nline2 \\ \"quoted\" </script> \u2028 \U0001F600 日本語"
	path := `C:\Users\someone\we"ird'.md`

	js := buildOpenInNewTabJS(title, content, path)

	if !strings.HasPrefix(js, "window.__mdMemoRPC && window.__mdMemoRPC.newTab(") {
		t.Fatalf("unexpected call shape: %q", js)
	}

	// A raw newline or an unescaped quote in the argument list would be a syntax error in the
	// evaluated expression, so assert the payload really was JSON-encoded.
	args := strings.TrimSuffix(strings.TrimPrefix(js, "window.__mdMemoRPC && window.__mdMemoRPC.newTab("), ");")
	var decoded []interface{}
	if err := json.Unmarshal([]byte("["+args+"]"), &decoded); err != nil {
		t.Fatalf("arguments are not valid JSON (%v): %s", err, args)
	}
	if len(decoded) != 3 {
		t.Fatalf("got %d arguments, want 3: %s", len(decoded), args)
	}
	if decoded[0] != title {
		t.Errorf("title = %v, want %q", decoded[0], title)
	}
	if decoded[1] != content {
		t.Errorf("content = %v, want %q", decoded[1], content)
	}
	if decoded[2] != path {
		t.Errorf("path = %v, want %q", decoded[2], path)
	}
	if strings.ContainsAny(js, "\n\r") {
		t.Errorf("rendered JS contains a raw newline: %q", js)
	}
}

// evalCaptureWebView is a minimal WebViewInstance that records what was evaluated. Dispatch
// runs its callback inline, which is enough for these tests and keeps them deterministic.
type evalCaptureWebView struct {
	mu   sync.Mutex
	eval []string
}

func (m *evalCaptureWebView) Dispatch(f func()) { f() }

func (m *evalCaptureWebView) Eval(js string) {
	m.mu.Lock()
	m.eval = append(m.eval, js)
	m.mu.Unlock()
}

func (m *evalCaptureWebView) calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.eval))
	copy(out, m.eval)
	return out
}

func TestOpenPathInNewTab(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "handoff.md")
	const body = "# Handoff\n\n日本語の \"本文\"\n"
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatalf("failed to create fixture: %v", err)
	}

	t.Run("evaluates a newTab call carrying the decoded content", func(t *testing.T) {
		app := &App{}
		mock := &evalCaptureWebView{}
		app.w = mock

		if err := app.OpenPathInNewTab(file); err != nil {
			t.Fatalf("OpenPathInNewTab failed: %v", err)
		}

		calls := mock.calls()
		if len(calls) != 1 {
			t.Fatalf("got %d Eval calls, want 1", len(calls))
		}
		if !strings.Contains(calls[0], "__mdMemoRPC.newTab(") {
			t.Fatalf("Eval did not call newTab: %q", calls[0])
		}
		wantTitle, _ := json.Marshal(filepath.Base(file))
		if !strings.Contains(calls[0], string(wantTitle)) {
			t.Errorf("Eval is missing the tab title %s: %q", wantTitle, calls[0])
		}
		wantContent, _ := json.Marshal(body)
		if !strings.Contains(calls[0], string(wantContent)) {
			t.Errorf("Eval is missing the file content: %q", calls[0])
		}
	})

	t.Run("rejects bad input without evaluating anything", func(t *testing.T) {
		cases := map[string]string{
			"empty path":   "",
			"blank path":   "   ",
			"missing file": filepath.Join(dir, "nope.md"),
			"directory":    dir,
		}
		for name, path := range cases {
			app := &App{}
			mock := &evalCaptureWebView{}
			app.w = mock
			if err := app.OpenPathInNewTab(path); err == nil {
				t.Errorf("%s: expected an error", name)
			}
			if got := mock.calls(); len(got) != 0 {
				t.Errorf("%s: evaluated %d expressions, want 0", name, len(got))
			}
		}
	})

	t.Run("reports an error when there is no webview", func(t *testing.T) {
		app := &App{}
		if err := app.OpenPathInNewTab(file); err == nil {
			t.Error("expected an error when app.w is nil")
		}
	})
}

func TestGetPlatformCapabilities(t *testing.T) {
	app := &App{}
	caps := app.GetPlatformCapabilities()

	if caps.OS != runtime.GOOS {
		t.Fatalf("os = %q, want %q", caps.OS, runtime.GOOS)
	}
	if !caps.GlobalHotkey {
		t.Error("globalHotkey = false; both supported platforms register a global summon hotkey")
	}

	switch runtime.GOOS {
	case "windows":
		if !caps.NativeImeSwitch {
			t.Error("windows: nativeImeSwitch = false, want true (backend_setIMEMode really drives IMM)")
		}
		if !caps.Tray {
			t.Error("windows: tray = false, want true")
		}
	case "darwin":
		if caps.NativeImeSwitch {
			t.Error("darwin: nativeImeSwitch = true, but backend_setIMEMode is a no-op there")
		}
		if caps.Tray {
			t.Error("darwin: tray = true, but there is no tray icon on macOS")
		}
	}

	// The struct is handed straight to the frontend by the bind layer, so the JSON key names
	// are part of the contract.
	data, err := json.Marshal(caps)
	if err != nil {
		t.Fatalf("capabilities do not marshal: %v", err)
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("capabilities JSON is not an object: %v", err)
	}
	for _, key := range []string{"os", "nativeImeSwitch", "tray", "globalHotkey"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("capabilities JSON is missing %q: %s", key, data)
		}
	}
}

func TestInvalidateLookPathCache(t *testing.T) {
	const probe = "md-memo-nonexistent-binary-for-tests"

	// Prime the cache with a stale negative answer, as a PATH lookup performed before
	// shellenv.Apply() finished would.
	lookPathCacheMu.Lock()
	lookPathCache[probe] = lookPathCacheEntry{found: true, resolvedAt: time.Now()}
	lookPathCacheMu.Unlock()

	if !lookPathCached(probe) {
		t.Fatal("primed cache entry was not served")
	}

	invalidateLookPathCache()

	lookPathCacheMu.Lock()
	_, present := lookPathCache[probe]
	lookPathCacheMu.Unlock()
	if present {
		t.Fatal("invalidateLookPathCache left an entry behind")
	}

	// And the real (negative) answer is what comes back afterwards.
	if lookPathCached(probe) {
		t.Fatalf("%q unexpectedly found on PATH after invalidation", probe)
	}
}
