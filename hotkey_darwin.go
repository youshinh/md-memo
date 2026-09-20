//go:build darwin

package main

// This file is deliberately the only place Carbon appears. The global summon hotkey is the
// one macOS feature with no pure-Cocoa equivalent, so if it ever has to be dropped - a build
// failure on a future SDK, a sandboxing requirement - deleting this file and replacing
// updateGlobalHotKeyNative with `return false` is the whole removal. Nothing else in the
// darwin build references anything declared here.
//
// The shortcut string parsing lives in pkg/hotkey, which is pure Go and unit tested on any
// platform; only the registration glue below needs a Mac to compile.

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Carbon

#include <Carbon/Carbon.h>
#include <dispatch/dispatch.h>
#include <pthread.h>

// Defined with external linkage in window_darwin.go's preamble, which is a separate cgo
// translation unit. It fronts the app and its window on the main queue.
void mdmemoActivateWindow(void);

static EventHandlerRef gHotKeyHandler = NULL;
static EventHotKeyRef  gHotKeyRef = NULL;

// 'MDMO' as a plain integer: a four-character literal would only draw a -Wmultichar warning.
static const OSType kMDMemoHotKeySignature = 0x4D444D4F;

static OSStatus mdmemoHotKeyCallback(EventHandlerCallRef inCaller, EventRef inEvent, void *inUserData) {
    // Mirrors the Windows WM_HOTKEY handler, which calls showAndRestoreWindow: the summon
    // hotkey only ever brings MD-Memo to the front, it never hides it again.
    mdmemoActivateWindow();
    return noErr;
}

// mdmemoUnregisterHotKeyOnMain must only be called on the main thread.
static void mdmemoUnregisterHotKeyOnMain(void) {
    if (gHotKeyRef != NULL) {
        UnregisterEventHotKey(gHotKeyRef);
        gHotKeyRef = NULL;
    }
}

// mdmemoRegisterHotKeyOnMain replaces any existing registration with keyCode+modifiers.
// Returns 1 on success and 0 on failure. Must only be called on the main thread.
static int mdmemoRegisterHotKeyOnMain(unsigned int keyCode, unsigned int modifiers) {
    mdmemoUnregisterHotKeyOnMain();

    if (gHotKeyHandler == NULL) {
        EventTypeSpec eventType;
        eventType.eventClass = kEventClassKeyboard;
        eventType.eventKind = kEventHotKeyPressed;

        OSStatus handlerStatus = InstallApplicationEventHandler(&mdmemoHotKeyCallback, 1,
                                                                &eventType, NULL,
                                                                &gHotKeyHandler);
        if (handlerStatus != noErr) {
            gHotKeyHandler = NULL;
            return 0;
        }
    }

    EventHotKeyID hotKeyID;
    hotKeyID.signature = kMDMemoHotKeySignature;
    hotKeyID.id = 1;

    EventHotKeyRef ref = NULL;
    OSStatus status = RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                                          GetApplicationEventTarget(), 0, &ref);
    if (status != noErr || ref == NULL) {
        return 0;
    }

    gHotKeyRef = ref;
    return 1;
}

// mdmemoRegisterHotKey is the thread-safe entry point. Carbon hot-key registration has to
// happen on the main thread; the bound function that reaches here already runs on it, so the
// dispatch_sync branch is only a safety net (and never a deadlock, because it is skipped when
// we are already on the main thread).
static int mdmemoRegisterHotKey(unsigned int keyCode, unsigned int modifiers) {
    __block int result = 0;
    if (pthread_main_np() != 0) {
        result = mdmemoRegisterHotKeyOnMain(keyCode, modifiers);
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            result = mdmemoRegisterHotKeyOnMain(keyCode, modifiers);
        });
    }
    return result;
}

static void mdmemoUnregisterHotKey(void) {
    if (pthread_main_np() != 0) {
        mdmemoUnregisterHotKeyOnMain();
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            mdmemoUnregisterHotKeyOnMain();
        });
    }
}
*/
import "C"

import (
	"strings"

	"md-memo/pkg/hotkey"
)

// updateGlobalHotKeyNative registers (or, for an empty string, clears) the global summon
// hotkey and reports whether that actually succeeded.
//
// It used to be `return true` with no registration behind it at all: no hotkey was ever
// registered, it was never called at startup the way the Windows path calls it, and the
// settings UI cheerfully reported success for every combination the user tried. The real
// OSStatus is honoured here, so an unparseable shortcut or a combination already owned by
// another application now reports false.
func updateGlobalHotKeyNative(shortcutStr string) bool {
	if strings.TrimSpace(shortcutStr) == "" {
		C.mdmemoUnregisterHotKey()
		return true // Unregistered successfully
	}

	modifiers, keyCode, ok := hotkey.Parse(shortcutStr)
	if !ok {
		return false
	}

	return C.mdmemoRegisterHotKey(C.uint(keyCode), C.uint(modifiers)) != 0
}
