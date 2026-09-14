//go:build windows

package main

import "testing"

func TestParseShortcut(t *testing.T) {
	tests := []struct {
		input       string
		wantMods    uintptr
		wantVk      uintptr
		wantSuccess bool
	}{
		{
			input:       "Ctrl+Alt+M",
			wantMods:    MOD_NOREPEAT | MOD_CONTROL | MOD_ALT,
			wantVk:      'M',
			wantSuccess: true,
		},
		{
			input:       "Ctrl+Shift+Space",
			wantMods:    MOD_NOREPEAT | MOD_CONTROL | MOD_SHIFT,
			wantVk:      0x20,
			wantSuccess: true,
		},
		{
			input:       "Alt+F11",
			wantMods:    MOD_NOREPEAT | MOD_ALT,
			wantVk:      0x7A, // VK_F11 = 0x70 + 10
			wantSuccess: true,
		},
		{
			input:       "",
			wantSuccess: false,
		},
	}

	for _, tt := range tests {
		mods, vk, ok := parseShortcut(tt.input)
		if ok != tt.wantSuccess {
			t.Errorf("parseShortcut(%q) ok = %v, want %v", tt.input, ok, tt.wantSuccess)
			continue
		}
		if ok {
			if mods != tt.wantMods {
				t.Errorf("parseShortcut(%q) mods = 0x%X, want 0x%X", tt.input, mods, tt.wantMods)
			}
			if vk != tt.wantVk {
				t.Errorf("parseShortcut(%q) vk = 0x%X, want 0x%X", tt.input, vk, tt.wantVk)
			}
		}
	}
}
