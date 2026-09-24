package llm

import (
	"context"
	"errors"
	"testing"
)

// withAppleFMStubs replaces every seam applefm.go uses to talk to the real OS/`fm` binary,
// restoring the originals on cleanup. Tests never spawn a real process or depend on GOOS.
func withAppleFMStubs(t *testing.T, goos string, lookPathErr error, availableOut string, availableErr error, respondOut string, respondErr error) {
	t.Helper()
	origGOOS, origLookPath, origAvailable, origRespond := currentGOOS, lookPathFM, runFMAvailable, runFMRespond
	currentGOOS = goos
	lookPathFM = func() error { return lookPathErr }
	runFMAvailable = func(ctx context.Context) (string, error) { return availableOut, availableErr }
	runFMRespond = func(ctx context.Context, prompt string) (string, error) { return respondOut, respondErr }
	t.Cleanup(func() {
		currentGOOS, lookPathFM, runFMAvailable, runFMRespond = origGOOS, origLookPath, origAvailable, origRespond
	})
}

func TestIsAppleFMAvailable(t *testing.T) {
	t.Run("non-darwin returns false without touching lookPath", func(t *testing.T) {
		lookPathCalled := false
		withAppleFMStubs(t, "windows", nil, "System model available", nil, "", nil)
		lookPathFM = func() error { lookPathCalled = true; return nil }
		if IsAppleFMAvailable() {
			t.Error("expected false on non-darwin GOOS")
		}
		if lookPathCalled {
			t.Error("must not even check for the fm binary on a non-macOS platform")
		}
	})

	t.Run("darwin without fm on PATH returns false", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", errors.New("not found"), "System model available", nil, "", nil)
		if IsAppleFMAvailable() {
			t.Error("expected false when fm is not on PATH")
		}
	})

	t.Run("darwin with fm present but model unavailable returns false", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "System model unavailable", nil, "", nil)
		if IsAppleFMAvailable() {
			t.Error("expected false when fm available does not report availability")
		}
	})

	t.Run("darwin with fm available reports true", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "", nil)
		if !IsAppleFMAvailable() {
			t.Error("expected true when fm is on PATH and reports availability")
		}
	})

	t.Run("darwin where fm available errors out returns false", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "", errors.New("boom"), "", nil)
		if IsAppleFMAvailable() {
			t.Error("expected false when the availability check itself fails")
		}
	})
}

func TestQueryAppleFM(t *testing.T) {
	t.Run("unavailable device returns errAppleFMUnavailable without calling respond", func(t *testing.T) {
		respondCalled := false
		withAppleFMStubs(t, "windows", nil, "", nil, "", nil)
		runFMRespond = func(ctx context.Context, prompt string) (string, error) { respondCalled = true; return "", nil }
		_, err := queryAppleFM("hello")
		if !errors.Is(err, errAppleFMUnavailable) {
			t.Errorf("expected errAppleFMUnavailable, got %v", err)
		}
		if respondCalled {
			t.Error("must not call fm respond when the device is not available")
		}
	})

	t.Run("successful respond returns trimmed text", func(t *testing.T) {
		var seenPrompt string
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "  こんにちは、Markdownとは軽量マークアップ言語です。  \n", nil)
		runFMRespond = func(ctx context.Context, prompt string) (string, error) {
			seenPrompt = prompt
			return "  こんにちは、Markdownとは軽量マークアップ言語です。  \n", nil
		}
		out, err := queryAppleFM("Markdownとは？")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out != "こんにちは、Markdownとは軽量マークアップ言語です。" {
			t.Errorf("expected trimmed output, got %q", out)
		}
		if seenPrompt != "Markdownとは？" {
			t.Errorf("expected the exact prompt to be forwarded, got %q", seenPrompt)
		}
	})

	t.Run("fm respond failure is surfaced as an error", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "", errors.New("exit status 1"))
		if _, err := queryAppleFM("hello"); err == nil {
			t.Error("expected an error when fm respond fails")
		}
	})

	t.Run("empty output is treated as a failure so callers fall back", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "   \n", nil)
		if _, err := queryAppleFM("hello"); err == nil {
			t.Error("expected an error for empty fm respond output")
		}
	})
}

func TestQueryPrefersAppleFMOnlyWhenUnconfigured(t *testing.T) {
	t.Run("no baseURL on a capable Mac uses Apple FM and skips Ollama", func(t *testing.T) {
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "on-device answer", nil)
		resp, err := Query("hi", Config{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp != "on-device answer" {
			t.Errorf("expected the Apple FM response to win when nothing else is configured, got %q", resp)
		}
	})

	t.Run("an explicit BaseURL never routes through Apple FM even on a capable Mac", func(t *testing.T) {
		respondCalled := false
		withAppleFMStubs(t, "darwin", nil, "System model available", nil, "", nil)
		runFMRespond = func(ctx context.Context, prompt string) (string, error) { respondCalled = true; return "should not be used", nil }
		// Ollama isn't running in this test environment, so this call is expected to fail --
		// the point is only that it must attempt the configured endpoint, not Apple FM.
		_, _ = Query("hi", Config{BaseURL: "http://127.0.0.1:1", Model: "qwen2.5:latest"})
		if respondCalled {
			t.Error("a deliberately configured endpoint must never be overridden by Apple FM")
		}
	})
}
