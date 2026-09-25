//go:build windows

package slotagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// shortPathOf is GetShortPathName; the folder or file must exist.
func shortPathOf(t *testing.T, path string) string {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	n, err := windows.GetShortPathName(p, nil, 0)
	if err != nil || n == 0 {
		t.Skipf("GetShortPathName is not available for %q: %v", path, err)
	}
	buf := make([]uint16, n)
	n, err = windows.GetShortPathName(p, &buf[0], uint32(len(buf)))
	if err != nil {
		t.Skipf("GetShortPathName failed for %q: %v", path, err)
	}
	return windows.UTF16ToString(buf[:n])
}

const longFolderName = "A Rather Long Folder Name For 8.3"

// makeLongFolder makes <t.TempDir()>\<longFolderName> and returns it with its short spelling. It skips the test when the
// volume has no 8.3 names (the short spelling is then the long one).
func makeLongFolder(t *testing.T) (long, short string) {
	t.Helper()
	long = filepath.Join(t.TempDir(), longFolderName)
	if err := os.MkdirAll(long, 0o755); err != nil {
		t.Fatal(err)
	}
	short = shortPathOf(t, long)
	if strings.EqualFold(short, long) || strings.Contains(strings.ToLower(short), strings.ToLower(longFolderName)) {
		t.Skip("8.3 names are switched off on this volume: nothing to expand")
	}
	return long, short
}

func TestPlatformLongPath_ExpandsAShortPath(t *testing.T) {
	long, short := makeLongFolder(t)
	file := filepath.Join(long, "note.md")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	shortFile := filepath.Join(short, "note.md")

	got, err := platformLongPath(shortFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, longFolderName) {
		t.Errorf("the long name must be back: %q (from %q)", got, shortFile)
	}
	if strings.EqualFold(filepath.Dir(got), short) {
		t.Errorf("the folder is still spelled short: %q", got)
	}
	if _, err := os.Stat(got); err != nil {
		t.Errorf("the expanded path names the file: %v", err)
	}

	// a path that is long already comes back the same, and one that does not exist is an error (longPathOrSame keeps it)
	if again, err := platformLongPath(file); err != nil || !strings.EqualFold(again, got) {
		t.Errorf("a long path stays long: %q %v", again, err)
	}
	if _, err := platformLongPath(filepath.Join(long, "missing.md")); err == nil {
		t.Errorf("a missing file cannot be expanded")
	}
	if same := longPathOrSame(filepath.Join(short, "missing.md")); same != filepath.Join(short, "missing.md") {
		t.Errorf("a failed expansion keeps the path: %q", same)
	}
}

// The real chain: %TEMP% is a short path, and the unsaved note's file is created under it. The path the agent gets has the
// long folder name.
func TestCreateTempNoteFile_ShortTempFolderBecomesLong(t *testing.T) {
	long, short := makeLongFolder(t)
	for _, k := range []string{"TMP", "TEMP"} {
		t.Setenv(k, short)
	}
	if got := os.TempDir(); !strings.EqualFold(got, short) {
		t.Skipf("os.TempDir() = %q, not the short folder %q on this system", got, short)
	}

	path, cleanup, err := CreateTempNoteFile("# unsaved\n")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if !strings.Contains(path, longFolderName) {
		t.Errorf("the agent must get the long path, got %q", path)
	}
	if strings.Contains(strings.ToLower(path), strings.ToLower(filepath.Base(short))) && !strings.EqualFold(filepath.Base(short), longFolderName) {
		t.Errorf("the short folder name must be gone: %q", path)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "# unsaved\n" {
		t.Errorf("the note is at the handed path: %q %v", data, err)
	}
	if !strings.EqualFold(filepath.Dir(path), long) {
		t.Errorf("dir = %q, want %q", filepath.Dir(path), long)
	}
	cleanup()
	if _, err := os.Stat(path); err == nil {
		t.Errorf("cleanup removes the file")
	}
}
