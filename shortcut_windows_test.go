//go:build windows

package main

import (
	"os"
	"runtime"
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

// TestTrayIconBehavior is a diagnostic that probes which NOTIFYICONDATAW cbSize the running
// Windows build accepts. The probe itself really registers a notification-area icon, which
// makes an icon flash in the user's tray on every `go test .`, so the live Shell_NotifyIconW
// part is opt-in: set MDMEMO_TEST_TRAY=1 to run it. The struct/handle checks above it are
// side-effect free and always run.
func TestTrayIconBehavior(t *testing.T) {
	var nid NOTIFYICONDATAW
	nidSize := unsafe.Sizeof(nid)
	t.Logf("NOTIFYICONDATAW Size: %d", nidSize)

	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	t.Logf("hinst: %v", hinst)

	hIconSm, _, _ := procLoadImageW.Call(uintptr(hinst), 1, 1 /* IMAGE_ICON */, 16, 16, 0x00008000 /* LR_SHARED */)
	t.Logf("procLoadImageW hIconSm: %v", hIconSm)

	if os.Getenv("MDMEMO_TEST_TRAY") != "1" {
		t.Skip("skipping live Shell_NotifyIconW probe (set MDMEMO_TEST_TRAY=1 to run): it registers a real tray icon")
	}

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

func TestCBTHookDarkMode(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if procSetWindowsHookExW.Find() != nil {
		t.Skip("SetWindowsHookExW not found")
	}

	tid, _, _ := procGetCurrentThreadId.Call()
	hookCreatedHwnds := make(map[uintptr]bool)

	cbtCallback := windows.NewCallback(func(nCode int32, wParam uintptr, lParam uintptr) uintptr {
		if nCode == HCBT_CREATEWND {
			hookCreatedHwnds[wParam] = true
			darkMode := int32(1)
			_, _, _ = procDwmSetWindowAttribute.Call(wParam, 20, uintptr(unsafe.Pointer(&darkMode)), 4)
			_, _, _ = procDwmSetWindowAttribute.Call(wParam, 19, uintptr(unsafe.Pointer(&darkMode)), 4)
			darkBrush, _, _ := procCreateSolidBrush.Call(0x001e1e1e)
			if darkBrush != 0 {
				_, _, _ = procSetClassLongPtrW.Call(wParam, GCLP_HBRBACKGROUND, darkBrush)
			}
		}
		ret, _, _ := procCallNextHookEx.Call(0, uintptr(nCode), wParam, lParam)
		return ret
	})

	hHook, _, err := procSetWindowsHookExW.Call(WH_CBT, cbtCallback, 0, tid)
	if hHook == 0 {
		t.Fatalf("SetWindowsHookExW failed: %v", err)
	}
	defer procUnhookWindowsHookEx.Call(hHook)

	procCreateWindowExW := modUser32.NewProc("CreateWindowExW")
	className, _ := windows.UTF16PtrFromString("STATIC")
	wndName, _ := windows.UTF16PtrFromString("TestCBTHookWindow")
	hwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(wndName)),
		0,
		0, 0, 100, 100,
		0, 0, 0, 0,
	)
	if hwnd == 0 {
		t.Fatal("CreateWindowExW failed")
	}
	defer procDestroyWindow.Call(hwnd)

	if !hookCreatedHwnds[hwnd] {
		t.Errorf("CBT hook did not catch created hwnd: %v, recorded: %v", hwnd, hookCreatedHwnds)
	}
}

