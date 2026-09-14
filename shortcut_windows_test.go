//go:build windows

package main

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

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

func TestTrayIconBehavior(t *testing.T) {
	var nid NOTIFYICONDATAW
	nidSize := unsafe.Sizeof(nid)
	t.Logf("NOTIFYICONDATAW Size: %d", nidSize)

	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	t.Logf("hinst: %v", hinst)

	hIconSm, _, _ := procLoadImageW.Call(uintptr(hinst), 1, 1 /* IMAGE_ICON */, 16, 16, 0x00008000 /* LR_SHARED */)
	t.Logf("procLoadImageW hIconSm: %v", hIconSm)

	// Test Shell_NotifyIconW
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.UID = 999
	nid.UFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
	nid.UCallbackMessage = WM_TRAYICON
	nid.HIcon = windows.Handle(hIconSm)
	tip, _ := windows.UTF16FromString("Test Tray")
	copy(nid.SzTip[:], tip)

	procCreateWindowExW := modUser32.NewProc("CreateWindowExW")
	className, _ := windows.UTF16PtrFromString("STATIC")
	wndName, _ := windows.UTF16PtrFromString("TestTrayWindow")
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(wndName)),
		0,
		0, 0, 0, 0,
		0, 0, uintptr(hinst), 0,
	)
	t.Logf("Created test HWND: %v", hwnd)
	if hwnd != 0 {
		defer procDestroyWindow.Call(hwnd)
		nid.HWnd = windows.Handle(hwnd)
		// Try various cbSize or structure variations
		sizes := []uint32{
			uint32(unsafe.Sizeof(nid)), // 976
			952,                        // V4 64-bit without certain alignments?
			528,                        // V3 64-bit (XP)
			504,                        // V2 64-bit (2000)
			88,                         // V1 (95/NT4)
		}
		for _, s := range sizes {
			nid.CbSize = s
			ret, _, err := procShell_NotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
			t.Logf("cbSize %d -> ret: %v, err: %v", s, ret, err)
			if ret != 0 {
				t.Logf("SUCCESS with cbSize %d!", s)
				procShell_NotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
				break
			}
		}
	}
}
