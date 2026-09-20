package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestGetConfig_CachedButPicksUpChanges covers the memoised config.json reader added to cut
// the three cold-start reads (InitScrapEngine, InitJevEngine, getInitialGlobalShortcut) plus
// the per-WM_CLOSE read from isResidentConfigEnabled down to one.
//
// Contract: identical results to reading the file every time, including the first-run case
// where the file does not exist yet.
func TestGetConfig_CachedButPicksUpChanges(t *testing.T) {
	cfgPath := getConfigFilePath()
	_ = os.Remove(cfgPath)
	t.Cleanup(func() { _ = os.Remove(cfgPath) })

	app := &App{}

	// 1. First run: no file at all must still yield ("", nil).
	got, err := app.GetConfig()
	if err != nil || got != "" {
		t.Fatalf("missing config: GetConfig() = (%q, %v), want (\"\", nil)", got, err)
	}

	// 2. A file appearing is picked up (the cached "does not exist" entry must not stick).
	first := `{"scrap_dir":"/tmp/one"}`
	if err := os.WriteFile(cfgPath, []byte(first), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if got, _ := app.GetConfig(); got != first {
		t.Fatalf("after create: GetConfig() = %q, want %q", got, first)
	}

	// 3. Repeated reads are served from the cache but must be identical.
	for i := 0; i < 5; i++ {
		if got, _ := app.GetConfig(); got != first {
			t.Fatalf("cached read %d = %q, want %q", i, got, first)
		}
	}

	// 4. An external edit is picked up on the very next call. Sleep past the filesystem's
	//    mtime resolution and change the size too, since the key is (exists, modtime, size).
	time.Sleep(1100 * time.Millisecond)
	second := `{"scrap_dir":"/tmp/two","git_sync_enabled":false}`
	if err := os.WriteFile(cfgPath, []byte(second), 0600); err != nil {
		t.Fatalf("rewrite config: %v", err)
	}
	if got, _ := app.GetConfig(); got != second {
		t.Fatalf("after external edit: GetConfig() = %q, want %q", got, second)
	}

	// 5. SaveConfig must make its own write visible immediately, without depending on the
	//    mtime having ticked. Use a real temp directory: SaveConfig re-inits the scrap
	//    engine, which starts a background git sync against whatever scrap_dir says.
	third := `{"scrap_dir":` + quote(filepath.ToSlash(t.TempDir())) + `,"git_sync_enabled":false}`
	if _, err := app.SaveConfig(third); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if got, _ := app.GetConfig(); got != third {
		t.Fatalf("after SaveConfig: GetConfig() = %q, want %q", got, third)
	}

	// 6. Deleting the file goes back to "".
	_ = os.Remove(cfgPath)
	if got, _ := app.GetConfig(); got != "" {
		t.Fatalf("after delete: GetConfig() = %q, want \"\"", got)
	}
}
