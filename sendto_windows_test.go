package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSendToShortcutPath(t *testing.T) {
	t.Run("missing APPDATA is an error", func(t *testing.T) {
		orig := os.Getenv("APPDATA")
		os.Unsetenv("APPDATA")
		defer os.Setenv("APPDATA", orig)

		if _, err := sendToShortcutPath(); err == nil {
			t.Fatal("expected an error when APPDATA is unset")
		}
	})

	t.Run("builds the standard Explorer Send To path", func(t *testing.T) {
		orig := os.Getenv("APPDATA")
		os.Setenv("APPDATA", `C:\Users\example\AppData\Roaming`)
		defer os.Setenv("APPDATA", orig)

		got, err := sendToShortcutPath()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := filepath.Join(`C:\Users\example\AppData\Roaming`, "Microsoft", "Windows", "SendTo", sendToShortcutName)
		if got != want {
			t.Errorf("sendToShortcutPath() = %q, want %q", got, want)
		}
	})
}
