//go:build windows

package main

import (
	"errors"
	"os"
	"time"
	"unsafe"
)

var (
	procImeRetypeGetWindowThreadProcessId = modUser32.NewProc("GetWindowThreadProcessId")
	procImeRetypeMapVirtualKey            = modUser32.NewProc("MapVirtualKeyW")
)

const (
	imeRetypeVkImeOn    = 0x16
	imeRetypeKeyUp      = 0x0002
	imeRetypeSettleWait = 70 * time.Millisecond // the Tab key that accepted the suggestion is up by now
	imeRetypeImeOnWait  = 60 * time.Millisecond // the IME needs a moment to switch to kana input
	imeRetypeKeyGap     = 8 * time.Millisecond
)

// ownsForeground reports whether the window with the keyboard focus belongs to this process. Keys are injected into
// whatever window is in front, so this is checked right before sending: a word must never be typed into another app.
func ownsForeground() bool {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return false
	}
	var pid uint32
	_, _, _ = procImeRetypeGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid == uint32(os.Getpid())
}

func imeRetypeKey(vk byte) {
	scan, _, _ := procImeRetypeMapVirtualKey.Call(uintptr(vk), 0) // MAPVK_VK_TO_VSC
	_, _, _ = procKeybdEvent.Call(uintptr(vk), scan, 0, 0)
	time.Sleep(imeRetypeKeyGap)
	_, _, _ = procKeybdEvent.Call(uintptr(vk), scan, imeRetypeKeyUp, 0)
	time.Sleep(imeRetypeKeyGap)
}

// platformImeRetype switches the IME to kana input (the IME-On key, the same one setIMEMode sends) and types the
// letters, so the IME builds an unconfirmed composition from them.
func platformImeRetype(romaji string) error {
	keys, ok := imeRetypeKeys(romaji)
	if !ok {
		return errors.New("only a-z can be retyped")
	}
	if procKeybdEvent.Find() != nil || procGetForegroundWindow.Find() != nil {
		return errors.New("keyboard input is not available")
	}
	time.Sleep(imeRetypeSettleWait)
	if !ownsForeground() {
		return errors.New("the window is no longer in front")
	}
	imeRetypeKey(imeRetypeVkImeOn)
	time.Sleep(imeRetypeImeOnWait)
	if !ownsForeground() {
		return errors.New("the window is no longer in front")
	}
	for _, vk := range keys {
		imeRetypeKey(vk)
	}
	return nil
}
