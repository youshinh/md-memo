package atomicfile

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func leftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			names = append(names, e.Name())
		}
	}
	return names
}

func TestWriteCreatesAndReplaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")

	if err := Write(path, []byte("first"), ".t-*.tmp"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "first" {
		t.Fatalf("content = %q", got)
	}
	if err := Write(path, []byte("second, longer"), ".t-*.tmp"); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "second, longer" {
		t.Fatalf("content after replace = %q", got)
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("temporary files left behind: %v", left)
	}
}

func TestWriteKeepsPermissionsOfAnExistingFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, []byte("new"), ".t-*.tmp"); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600 kept", fi.Mode().Perm())
	}

	fresh := filepath.Join(dir, "fresh.md")
	if err := Write(fresh, []byte("x"), ".t-*.tmp"); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(fresh); fi.Mode().Perm() != 0o644 {
		t.Errorf("a new file gets 0644, got %v", fi.Mode().Perm())
	}
}

func TestWriteMissingFolderIsAnErrorAndCreatesNothing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "no-such-folder", "note.md")
	if err := Write(path, []byte("x"), ".t-*.tmp"); err == nil {
		t.Fatal("expected an error for a missing folder")
	}
	if _, err := os.Stat(filepath.Join(dir, "no-such-folder")); err == nil {
		t.Error("the folder must not be created")
	}
}

func TestWriteFailureLeavesTheOldFileAndNoTemp(t *testing.T) {
	dir := t.TempDir()
	// The target is a directory: the rename over it fails, after the temp file was written.
	target := filepath.Join(dir, "adir")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Write(target, []byte("x"), ".t-*.tmp"); err == nil {
		t.Fatal("expected an error when the target is a directory")
	}
	if left := leftovers(t, dir); len(left) != 0 {
		t.Errorf("temporary files left behind after a failure: %v", left)
	}
}
