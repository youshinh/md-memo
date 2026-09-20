// Package hotkey turns MD-Memo's textual shortcut strings ("Ctrl+Alt+M", "Cmd+Shift+Space")
// into the (modifier mask, virtual key code) pair Carbon's RegisterEventHotKey expects on
// macOS.
//
// It is deliberately pure Go with no cgo and no macOS-only imports: the Carbon constants are
// spelled out as plain integers so this file compiles, vets and unit-tests on any platform,
// leaving the root package's hotkey_darwin.go with nothing but the registration glue.
//
// The accepted syntax mirrors parseShortcut in window_windows.go exactly - same separator,
// same case-insensitive modifier aliases, same key names - so one shortcut string configured
// in the settings UI means the same thing on both platforms.
package hotkey

import (
	"fmt"
	"strings"
)

// Carbon modifier masks (from <HIToolbox/Events.h>). They are NOT the NSEventModifierFlags
// values; RegisterEventHotKey wants these.
const (
	CmdKey     uint32 = 0x0100 // cmdKey
	ShiftKey   uint32 = 0x0200 // shiftKey
	OptionKey  uint32 = 0x0800 // optionKey
	ControlKey uint32 = 0x1000 // controlKey
)

// keyCodes maps an upper-cased key name to its kVK_* virtual key code (from
// <HIToolbox/Events.h>). Virtual key codes describe a physical key position on the ANSI
// layout, which is why "A" is 0 rather than anything resembling an ASCII code.
var keyCodes = map[string]uint32{
	// kVK_ANSI_A ... kVK_ANSI_Z
	"A": 0x00, "B": 0x0B, "C": 0x08, "D": 0x02, "E": 0x0E,
	"F": 0x03, "G": 0x05, "H": 0x04, "I": 0x22, "J": 0x26,
	"K": 0x28, "L": 0x25, "M": 0x2E, "N": 0x2D, "O": 0x1F,
	"P": 0x23, "Q": 0x0C, "R": 0x0F, "S": 0x01, "T": 0x11,
	"U": 0x20, "V": 0x09, "W": 0x0D, "X": 0x07, "Y": 0x10,
	"Z": 0x06,

	// kVK_ANSI_0 ... kVK_ANSI_9 (note: the order really is this irregular)
	"0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
	"5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,

	// kVK_F1 ... kVK_F12
	"F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76,
	"F5": 0x60, "F6": 0x61, "F7": 0x62, "F8": 0x64,
	"F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,

	// Named keys
	"SPACE":  0x31, // kVK_Space
	"RETURN": 0x24, // kVK_Return
	"ENTER":  0x24,
	"TAB":    0x30, // kVK_Tab
	"ESC":    0x35, // kVK_Escape
	"ESCAPE": 0x35,

	// Arrows
	"LEFT":  0x7B, // kVK_LeftArrow
	"RIGHT": 0x7C, // kVK_RightArrow
	"DOWN":  0x7D, // kVK_DownArrow
	"UP":    0x7E, // kVK_UpArrow

	// Punctuation, spelled both as the literal character and as a name.
	"-": 0x1B, "MINUS": 0x1B, // kVK_ANSI_Minus
	"=": 0x18, "EQUAL": 0x18, // kVK_ANSI_Equal
	"[": 0x21, "LEFTBRACKET": 0x21, // kVK_ANSI_LeftBracket
	"]": 0x1E, "RIGHTBRACKET": 0x1E, // kVK_ANSI_RightBracket
	"\\": 0x2A, "BACKSLASH": 0x2A, // kVK_ANSI_Backslash
	";": 0x29, "SEMICOLON": 0x29, // kVK_ANSI_Semicolon
	"'": 0x27, "QUOTE": 0x27, // kVK_ANSI_Quote
	",": 0x2B, "COMMA": 0x2B, // kVK_ANSI_Comma
	".": 0x2F, "PERIOD": 0x2F, // kVK_ANSI_Period
	"/": 0x2C, "SLASH": 0x2C, // kVK_ANSI_Slash
	"`": 0x32, "GRAVE": 0x32, // kVK_ANSI_Grave
}

// Parse converts a shortcut string such as "Ctrl+Alt+M" into the Carbon modifier mask and
// virtual key code for RegisterEventHotKey.
//
// ok is false when the string names no key at all (only modifiers, or nothing), names an
// unknown key, or names two different keys - in every one of those cases the caller must
// report failure rather than pretend the hotkey was registered.
//
// A shortcut with no modifiers is accepted, exactly as the Windows parser accepts it; the
// settings UI is what keeps users from configuring a bare key.
func Parse(shortcut string) (modifiers uint32, keyCode uint32, ok bool) {
	trimmed := strings.TrimSpace(shortcut)
	if trimmed == "" {
		return 0, 0, false
	}

	haveKey := false
	for _, part := range strings.Split(trimmed, "+") {
		p := strings.ToUpper(strings.TrimSpace(part))
		if p == "" {
			continue
		}

		switch p {
		case "CTRL", "CONTROL", "^":
			modifiers |= ControlKey
			continue
		case "ALT", "OPTION", "OPT", "⌥":
			modifiers |= OptionKey
			continue
		case "SHIFT", "⇧":
			modifiers |= ShiftKey
			continue
		case "CMD", "COMMAND", "WIN", "META", "SUPER", "⌘":
			modifiers |= CmdKey
			continue
		}

		code, known := keyCodes[p]
		if !known {
			return 0, 0, false
		}
		if haveKey && code != keyCode {
			// Two distinct keys in one shortcut is a malformed string, not a hotkey.
			return 0, 0, false
		}
		keyCode = code
		haveKey = true
	}

	if !haveKey {
		return 0, 0, false
	}
	return modifiers, keyCode, true
}

// Describe renders a parsed shortcut back into a short, stable string. It exists for log and
// error messages, so a failed registration can say which combination was attempted.
func Describe(modifiers uint32, keyCode uint32) string {
	var b strings.Builder
	if modifiers&ControlKey != 0 {
		b.WriteString("Ctrl+")
	}
	if modifiers&OptionKey != 0 {
		b.WriteString("Alt+")
	}
	if modifiers&ShiftKey != 0 {
		b.WriteString("Shift+")
	}
	if modifiers&CmdKey != 0 {
		b.WriteString("Cmd+")
	}
	b.WriteString(fmt.Sprintf("0x%02X", keyCode))
	return b.String()
}
