package scrap

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyPath(t *testing.T) {
	day := time.Date(2026, 9, 5, 23, 59, 59, 0, time.Local)
	dir := t.TempDir()

	got := DailyPath(dir, day)
	if want := filepath.Join(filepath.Clean(dir), "2026-09-05.md"); got != want {
		t.Errorf("DailyPath = %q, want %q", got, want)
	}
	if DailyFileName(day) != "2026-09-05.md" {
		t.Errorf("DailyFileName = %q", DailyFileName(day))
	}

	// It only computes: nothing may be created, not even the folder.
	missing := filepath.Join(dir, "not-created")
	_ = DailyPath(missing, day)
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Errorf("DailyPath must not create anything (stat err = %v)", err)
	}

	// ~ and the empty default are expanded like ResolveScrapDir does.
	if got, want := DailyPath("", day), filepath.Join(ResolveScrapDir(""), "2026-09-05.md"); got != want {
		t.Errorf("empty dir: %q, want %q", got, want)
	}
	if got, want := DailyPath("~/notes", day), filepath.Join(ResolveScrapDir("~/notes"), "2026-09-05.md"); got != want {
		t.Errorf("~ dir: %q, want %q", got, want)
	}
}

// The writer and DailyPath must agree on where a day's scrap lives.
func TestAppendUsesDailyPath(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.Local)
	path, err := AppendRaw(dir, "hello\n", now)
	if err != nil {
		t.Fatal(err)
	}
	if want := DailyPath(dir, now); path != want {
		t.Errorf("AppendRaw wrote %q, DailyPath says %q", path, want)
	}
}

func TestDateOfFile(t *testing.T) {
	good := map[string]string{
		"2026-09-25.md": "2026-09-25",
		"2026-02-28.MD": "2026-02-28",
		"2024-02-29.md": "2024-02-29", // leap day
	}
	for name, want := range good {
		got, ok := DateOfFile(name)
		if !ok || got != want {
			t.Errorf("DateOfFile(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
	for _, name := range []string{
		"", "notes.md", "2026-09-25", "2026-09-25.txt", "2026-9-5.md", "2026-09-25.md.bak",
		"2026-02-30.md", "2026-13-01.md", "2025-02-29.md", "x2026-09-25.md", "2026-09-25 .md",
		"２０２６-09-25.md", "2026/09/25.md",
	} {
		if got, ok := DateOfFile(name); ok {
			t.Errorf("DateOfFile(%q) = %q, want it rejected", name, got)
		}
	}
}
