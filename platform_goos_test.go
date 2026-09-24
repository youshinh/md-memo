package main

import (
	"os"
	"regexp"
	"testing"

	"md-memo/pkg/hotkey"
)

// This file pins the pure, GOOS-parameterised helpers extracted from GetPlatformCapabilities
// (app.go), defaultGlobalSummonShortcutFor (app_config.go), cliGeneratorOSType (cli_ai.go) and
// externalOpenCommandFor (app_files.go) so their darwin/linux branches can be exercised by
// `go test .` on a Windows host, where runtime.GOOS never selects them at run time. The real
// call sites still pass runtime.GOOS; behaviour is unchanged.

func TestPlatformCapabilitiesFor(t *testing.T) {
	tests := []struct {
		goos string
		want PlatformCapabilities
	}{
		{"windows", PlatformCapabilities{OS: "windows", NativeImeSwitch: true, Tray: true, GlobalHotkey: true}},
		{"darwin", PlatformCapabilities{OS: "darwin", NativeImeSwitch: false, Tray: false, GlobalHotkey: true}},
		{"linux", PlatformCapabilities{OS: "linux"}},
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			got := platformCapabilitiesFor(tt.goos)
			if got != tt.want {
				t.Errorf("platformCapabilitiesFor(%q) = %+v, want %+v", tt.goos, got, tt.want)
			}
		})
	}
}

func TestDefaultGlobalSummonShortcutFor(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"darwin", "Cmd+Alt+M"},
		{"windows", "Ctrl+Alt+M"},
		{"linux", "Ctrl+Alt+M"},
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			if got := defaultGlobalSummonShortcutFor(tt.goos); got != tt.want {
				t.Errorf("defaultGlobalSummonShortcutFor(%q) = %q, want %q", tt.goos, got, tt.want)
			}
		})
	}
}

func TestCliGeneratorOSType(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"darwin", "macOS (zsh / bash)"},
		{"linux", "Linux (bash)"},
		{"windows", "Windows (PowerShell / cmd)"},
		{"plan9", "Windows (PowerShell / cmd)"}, // unknown GOOS falls back to the Windows description, matching the old if/else chain
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			if got := cliGeneratorOSType(tt.goos); got != tt.want {
				t.Errorf("cliGeneratorOSType(%q) = %q, want %q", tt.goos, got, tt.want)
			}
		})
	}
}

func TestExternalOpenCommandFor(t *testing.T) {
	const target = "https://example.com/x?y=1"
	tests := []struct {
		goos     string
		wantName string
		wantArgs []string
	}{
		{"windows", "rundll32", []string{"url.dll,FileProtocolHandler", target}},
		{"darwin", "open", []string{target}},
		{"linux", "xdg-open", []string{target}},
	}
	for _, tt := range tests {
		t.Run(tt.goos, func(t *testing.T) {
			// Pure: builds the exec.Cmd arguments only, never runs anything - TestMain forbids
			// tests from actually launching an external process.
			name, args := externalOpenCommandFor(tt.goos, target)
			if name != tt.wantName {
				t.Errorf("externalOpenCommandFor(%q) name = %q, want %q", tt.goos, name, tt.wantName)
			}
			if len(args) != len(tt.wantArgs) {
				t.Fatalf("externalOpenCommandFor(%q) args = %v, want %v", tt.goos, args, tt.wantArgs)
			}
			for i := range args {
				if args[i] != tt.wantArgs[i] {
					t.Errorf("externalOpenCommandFor(%q) args[%d] = %q, want %q", tt.goos, i, args[i], tt.wantArgs[i])
				}
			}
		})
	}
}

// TestGlobalSummonShortcutMatchesFrontend cross-checks the Go platform defaults against the
// frontend's DEFAULT_SHORTCUTS_WIN / DEFAULT_SHORTCUTS_MAC tables (frontend/js/app.js), the
// same pairing tests/mac_shortcut_display_test.mjs checks in the other direction (JS against
// the defaultGlobalSummonShortcut IIFE literal in app_config.go). Keeping both directions
// pinned means either file drifting from the other fails a test on its own platform's runner.
func TestGlobalSummonShortcutMatchesFrontend(t *testing.T) {
	data, err := os.ReadFile("frontend/js/app.js")
	if err != nil {
		t.Fatalf("reading frontend/js/app.js: %v", err)
	}
	src := string(data)

	winBlock := extractJSConstBlock(t, src, "DEFAULT_SHORTCUTS_WIN")
	macBlock := extractJSConstBlock(t, src, "DEFAULT_SHORTCUTS_MAC")

	winSummon := extractJSGlobalSummon(t, winBlock, "DEFAULT_SHORTCUTS_WIN")
	macSummon := extractJSGlobalSummon(t, macBlock, "DEFAULT_SHORTCUTS_MAC")

	if want := defaultGlobalSummonShortcutFor("windows"); winSummon != want {
		t.Errorf("DEFAULT_SHORTCUTS_WIN.globalSummon = %q, defaultGlobalSummonShortcutFor(\"windows\") = %q", winSummon, want)
	}
	if want := defaultGlobalSummonShortcutFor("darwin"); macSummon != want {
		t.Errorf("DEFAULT_SHORTCUTS_MAC.globalSummon = %q, defaultGlobalSummonShortcutFor(\"darwin\") = %q", macSummon, want)
	}

	// The Mac default must also parse as a valid Carbon hotkey: Cmd+Option, key M. This is the
	// pure hotkey.Parse logic (no cgo, no macOS-only imports), so it runs on Windows too.
	modifiers, keyCode, ok := hotkey.Parse(macSummon)
	if !ok {
		t.Fatalf("hotkey.Parse(%q) failed to parse", macSummon)
	}
	if modifiers != hotkey.CmdKey|hotkey.OptionKey {
		t.Errorf("hotkey.Parse(%q) modifiers = %#x, want Cmd|Option = %#x", macSummon, modifiers, hotkey.CmdKey|hotkey.OptionKey)
	}
	const kVK_ANSI_M = 0x2E
	if keyCode != kVK_ANSI_M {
		t.Errorf("hotkey.Parse(%q) keyCode = %#x, want kVK_ANSI_M = %#x", macSummon, keyCode, kVK_ANSI_M)
	}
}

// extractJSConstBlock returns the `const NAME = { ... };` object literal's source text (braces
// balanced), mirroring extractConst() in tests/mac_shortcut_display_test.mjs so both files stay
// in step about what "the block" means.
func extractJSConstBlock(t *testing.T, src, name string) string {
	t.Helper()
	marker := "const " + name + " = {"
	start := indexOf(src, marker)
	if start == -1 {
		t.Fatalf("const %s not found in frontend/js/app.js", name)
	}
	braceStart := indexOf(src[start:], "{") + start
	depth := 0
	i := braceStart
	for ; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return src[start : i+1]
			}
		}
	}
	t.Fatalf("unbalanced braces for const %s in frontend/js/app.js", name)
	return ""
}

var globalSummonRe = regexp.MustCompile(`globalSummon:\s*'([^']*)'`)

func extractJSGlobalSummon(t *testing.T, block, blockName string) string {
	t.Helper()
	m := globalSummonRe.FindStringSubmatch(block)
	if m == nil {
		t.Fatalf("globalSummon entry not found in %s", blockName)
	}
	return m[1]
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
