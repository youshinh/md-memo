package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOSOpenQueue(t *testing.T) {
	var q osOpenQueue
	if q.add("a.md") {
		t.Fatal("before the page has asked for its start-up file the path must be queued, not opened")
	}
	if q.add("b.md") {
		t.Fatal("second path before start-up must be queued too")
	}
	got := q.claim()
	if len(got) != 2 || got[0] != "a.md" || got[1] != "b.md" {
		t.Fatalf("claim() = %v, want [a.md b.md] in arrival order", got)
	}
	if again := q.claim(); len(again) != 0 {
		t.Fatalf("a second claim() must be empty, got %v", again)
	}
	if !q.add("c.md") {
		t.Fatal("after start-up a path must be opened at once")
	}
	if len(q.pending) != 0 {
		t.Fatalf("a path opened at once must not be queued: %v", q.pending)
	}
}

func TestGetStartupFileTakesPathsTheOSOpened(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.md")
	second := filepath.Join(dir, "second.md")
	if err := os.WriteFile(first, []byte("# first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("# second\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := &App{}
	// A Finder double-click that launched the app: the events arrive before the page asks.
	// (The path that is missing is dropped: there is nothing to show for it.)
	app.OpenFromOS(filepath.Join(dir, "gone.md"))
	app.OpenFromOS(first)
	app.OpenFromOS(second)
	app.OpenFromOS("  ")

	res, err := app.GetStartupFile()
	if err != nil {
		t.Fatalf("GetStartupFile: %v", err)
	}
	if res == nil || res.Path != first || res.Title != "first.md" || res.Content != "# first\n" {
		t.Fatalf("start-up file = %+v, want %s", res, first)
	}

	if again, err := app.GetStartupFile(); err != nil || again != nil {
		t.Fatalf("the paths are handed over once: got %+v, %v", again, err)
	}
	if len(app.osOpen.pending) != 0 {
		t.Fatalf("nothing may stay queued after start-up: %v", app.osOpen.pending)
	}
}

func TestGetStartupFileWithNothingOpenedByTheOS(t *testing.T) {
	res, err := (&App{}).GetStartupFile()
	if err != nil || res != nil {
		t.Fatalf("no file anywhere: got %+v, %v", res, err)
	}
}
