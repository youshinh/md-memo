package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"md-memo/pkg/appdir"
)

// session.json holds the text of every open note. It is written as a whole file (a crash cannot leave half of it), a damaged one is
// kept as session.json.bak before the page's next save replaces it, and it stays private.

// sessionDir points the session file at a folder of its own for one test (TestMain already keeps the run away from the real
// %AppData%; this gives each test an empty folder).
func sessionDir(t *testing.T) string {
	t.Helper()
	prev, _ := appdir.ConfigDir()
	root := t.TempDir()
	appdir.SetConfigDirOverride(root)
	t.Cleanup(func() { appdir.SetConfigDirOverride(prev) })
	return filepath.Join(root, "md-memo")
}

func leftoverTemps(t *testing.T, dir string) []string {
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

func TestSaveSessionReplacesTheWholeFileAndLeavesNoTemp(t *testing.T) {
	dir := sessionDir(t)
	app := &App{}
	first := `{"tabs":[{"id":"a","content":"first"}]}`
	second := `{"tabs":[{"id":"a","content":"second, and a good deal longer than the first"}]}`

	if ok, err := app.SaveSession(first); err != nil || !ok {
		t.Fatalf("first save: ok=%v err=%v", ok, err)
	}
	if got, _ := app.GetSession(); got != first {
		t.Fatalf("session = %q, want %q", got, first)
	}
	if ok, err := app.SaveSession(second); err != nil || !ok {
		t.Fatalf("second save: ok=%v err=%v", ok, err)
	}
	if got, _ := app.GetSession(); got != second {
		t.Fatalf("session after the second save = %q, want %q", got, second)
	}
	if left := leftoverTemps(t, dir); len(left) != 0 {
		t.Errorf("temporary files left behind: %v", left)
	}
	if _, err := os.Stat(filepath.Join(dir, "session.json.bak")); err == nil {
		t.Error("a valid session must not produce a .bak")
	}
}

// A write that truncated session.json in place was cut by a crash into a half file. Replacing it by a rename leaves the old file
// (here still reachable through a second name) untouched.
func TestSaveSessionDoesNotWriteTheOldFileInPlace(t *testing.T) {
	dir := sessionDir(t)
	app := &App{}
	old := `{"tabs":[{"id":"a","content":"the previous session"}]}`
	if _, err := app.SaveSession(old); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "session.alias")
	if err := os.Link(filepath.Join(dir, "session.json"), alias); err != nil {
		t.Skipf("hard links are not available here: %v", err)
	}
	if _, err := app.SaveSession(`{"tabs":[{"id":"b","content":"the new one"}]}`); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(alias); string(got) != old {
		t.Errorf("the old file was rewritten in place: %q", got)
	}
}

func TestSaveSessionFailureLeavesNoTempFile(t *testing.T) {
	dir := sessionDir(t)
	app := &App{}
	// a directory where the file should be: the rename over it fails after the temporary file was written
	if err := os.MkdirAll(filepath.Join(dir, "session.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	if ok, err := app.SaveSession(`{"tabs":[]}`); err == nil || ok {
		t.Fatalf("expected an error, got ok=%v err=%v", ok, err)
	}
	if left := leftoverTemps(t, dir); len(left) != 0 {
		t.Errorf("temporary files left behind after a failure: %v", left)
	}
}

func TestSaveSessionIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	dir := sessionDir(t)
	if _, err := (&App{}).SaveSession(`{"tabs":[]}`); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("session.json mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestGetSessionKeepsAnUnreadableSessionAsBak(t *testing.T) {
	dir := sessionDir(t)
	app := &App{}
	whole := `{"activeTabId":"a","tabs":[{"id":"a","title":"x.md","content":"my only copy of an idea"}]}`
	cut := whole[:len(whole)/2] // what a crash in the middle of an in-place write leaves
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.json"), []byte(cut), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := app.GetSession()
	if err != nil || got != cut {
		t.Fatalf("GetSession = %q, %v; want the damaged text handed back unchanged (the page decides)", got, err)
	}
	if bak, err := os.ReadFile(filepath.Join(dir, "session.json.bak")); err != nil || string(bak) != cut {
		t.Fatalf("session.json.bak = %q, %v; want the damaged session kept", bak, err)
	}

	// the page's next save replaces session.json; the kept copy stays
	if _, err := app.SaveSession(`{"tabs":[{"id":"n","content":""}]}`); err != nil {
		t.Fatal(err)
	}
	if bak, _ := os.ReadFile(filepath.Join(dir, "session.json.bak")); string(bak) != cut {
		t.Errorf("the .bak changed after the next save: %q", bak)
	}
}

func TestGetSessionWithoutAFileOrWithAnEmptyOneKeepsNothing(t *testing.T) {
	dir := sessionDir(t)
	app := &App{}
	if got, err := app.GetSession(); got != "" || err != nil {
		t.Fatalf("no session yet: %q, %v", got, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.json"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := app.GetSession(); got != "" || err != nil {
		t.Fatalf("empty file: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "session.json.bak")); err == nil {
		t.Error("nothing to keep: no .bak expected")
	}
}
