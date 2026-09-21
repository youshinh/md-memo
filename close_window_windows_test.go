//go:build windows

package main

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// With the tray resident, "closing the window" (Ctrl+W on the last tab, backend.closeWindow) only hides it and the app goes
// on. It used to mark the App destroyed all the same, and from then on every async result (OCR, voice, Quick Actions, LLM)
// was thrown away: the placeholder stayed in the note and Ctrl+J / Ctrl+V looked dead until the app was restarted.
func TestCloseWindow_ResidentOnlyHidesAndResultsKeepFlowing(t *testing.T) {
	atomic.StoreInt32(&isForceQuit, 0)
	t.Cleanup(func() { atomic.StoreInt32(&isForceQuit, 0) })

	mock := &voiceMockWebView{}
	app := &App{w: mock}

	if err := app.CloseWindow(); err != nil {
		t.Fatalf("CloseWindow: %v", err)
	}
	if atomic.LoadInt32(&app.isDestroyed) != 0 {
		t.Fatal("a hide to the tray must not mark the App destroyed")
	}

	app.dispatchVoiceResult("voice_ab12", "こんにちは", "", "")
	eval := mock.waitFor(t, "__onVoiceResult", 2*time.Second)
	if !strings.Contains(eval, "voice_ab12") {
		t.Errorf("the result must still reach the page after the window was closed to the tray: %s", eval)
	}
}

func TestCloseWindow_ForcedQuitMarksTheAppDestroyed(t *testing.T) {
	atomic.StoreInt32(&isForceQuit, 1)
	t.Cleanup(func() { atomic.StoreInt32(&isForceQuit, 0) })

	mock := &voiceMockWebView{}
	app := &App{w: mock}

	if err := app.CloseWindow(); err != nil {
		t.Fatalf("CloseWindow: %v", err)
	}
	if atomic.LoadInt32(&app.isDestroyed) == 0 {
		t.Fatal("a real quit must mark the App destroyed, so no result is evaluated on a dying WebView")
	}

	app.dispatchVoiceResult("voice_cd34", "x", "", "")
	mock.mu.Lock()
	n := len(mock.evals)
	mock.mu.Unlock()
	if n != 0 {
		t.Errorf("nothing may be evaluated once the App is destroyed, got %d evals", n)
	}
}
