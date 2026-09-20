package hotkey

import "testing"

func TestParseValidCombinations(t *testing.T) {
	cases := []struct {
		in       string
		wantMods uint32
		wantKey  uint32
	}{
		// The Windows default fallback shortcut.
		{"Ctrl+Alt+M", ControlKey | OptionKey, 0x2E},
		{"ctrl+alt+m", ControlKey | OptionKey, 0x2E},
		{"  Ctrl + Alt + M  ", ControlKey | OptionKey, 0x2E},
		{"Cmd+Shift+Space", CmdKey | ShiftKey, 0x31},
		{"Command+Space", CmdKey, 0x31},
		{"⌘+⌥+A", CmdKey | OptionKey, 0x00},
		{"Control+Option+Z", ControlKey | OptionKey, 0x06},
		{"Win+M", CmdKey, 0x2E},
		{"Alt+F12", OptionKey, 0x6F},
		{"Ctrl+F1", ControlKey, 0x7A},
		{"Shift+Return", ShiftKey, 0x24},
		{"Shift+Enter", ShiftKey, 0x24},
		{"Ctrl+Tab", ControlKey, 0x30},
		{"Cmd+Escape", CmdKey, 0x35},
		{"Cmd+Esc", CmdKey, 0x35},
		{"Ctrl+Up", ControlKey, 0x7E},
		{"Ctrl+Down", ControlKey, 0x7D},
		{"Ctrl+Left", ControlKey, 0x7B},
		{"Ctrl+Right", ControlKey, 0x7C},
		{"Cmd+0", CmdKey, 0x1D},
		{"Cmd+9", CmdKey, 0x19},
		{"Cmd+,", CmdKey, 0x2B},
		{"Cmd+Comma", CmdKey, 0x2B},
		{"Cmd+/", CmdKey, 0x2C},
		{"Cmd+-", CmdKey, 0x1B},
		// No modifier at all is accepted, matching the Windows parser.
		{"M", 0, 0x2E},
	}

	for _, c := range cases {
		mods, key, ok := Parse(c.in)
		if !ok {
			t.Errorf("Parse(%q): ok = false, want true", c.in)
			continue
		}
		if mods != c.wantMods {
			t.Errorf("Parse(%q): modifiers = 0x%04X, want 0x%04X", c.in, mods, c.wantMods)
		}
		if key != c.wantKey {
			t.Errorf("Parse(%q): keyCode = 0x%02X, want 0x%02X", c.in, key, c.wantKey)
		}
	}
}

func TestParseRejectsUnusable(t *testing.T) {
	cases := []string{
		"",
		"   ",
		"+",
		"Ctrl",
		"Ctrl+Alt",
		"Cmd+Shift",
		"Ctrl+F13",  // beyond the F1-F12 range the Windows parser guarantees
		"Ctrl+Home", // not in the supported key set
		"Ctrl+PageDown",
		"Ctrl+Alt+M+Z", // two distinct keys
		"Ctrl+💥",
	}

	for _, in := range cases {
		if mods, key, ok := Parse(in); ok {
			t.Errorf("Parse(%q): ok = true (mods 0x%04X, key 0x%02X), want false", in, mods, key)
		}
	}
}

func TestParseRepeatedKeyIsNotAnError(t *testing.T) {
	// "Ctrl+M+M" names the same key twice; that is redundant but unambiguous.
	mods, key, ok := Parse("Ctrl+M+M")
	if !ok || mods != ControlKey || key != 0x2E {
		t.Fatalf("Parse(\"Ctrl+M+M\") = (0x%04X, 0x%02X, %v), want (0x%04X, 0x2E, true)", mods, key, ok, ControlKey)
	}
}

func TestParseNeverReturnsValuesOnFailure(t *testing.T) {
	mods, key, ok := Parse("Ctrl+Nope")
	if ok || mods != 0 || key != 0 {
		t.Fatalf("Parse(\"Ctrl+Nope\") = (0x%04X, 0x%02X, %v), want (0, 0, false)", mods, key, ok)
	}
}

func TestDescribe(t *testing.T) {
	if got, want := Describe(ControlKey|OptionKey, 0x2E), "Ctrl+Alt+0x2E"; got != want {
		t.Errorf("Describe = %q, want %q", got, want)
	}
	if got, want := Describe(CmdKey|ShiftKey, 0x31), "Shift+Cmd+0x31"; got != want {
		t.Errorf("Describe = %q, want %q", got, want)
	}
	if got, want := Describe(0, 0x00), "0x00"; got != want {
		t.Errorf("Describe = %q, want %q", got, want)
	}
}
