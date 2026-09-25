package slotagent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tempDirForNotes points os.TempDir() at a folder of the test's own (every variable the OS looks at) and returns it.
func tempDirForNotes(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(k, dir)
	}
	return dir
}

func stubExpandLongPath(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	orig := expandLongPath
	expandLongPath = fn
	t.Cleanup(func() { expandLongPath = orig })
}

// The path handed to the agent is the expanded one: same file under a different spelling, which is what an 8.3 path and
// its long form are. The fake renames the file so the two spellings really differ, on every OS.
func TestCreateTempNoteFile_HandsTheAgentTheLongForm(t *testing.T) {
	dir := tempDirForNotes(t)
	var asked string
	stubExpandLongPath(t, func(p string) (string, error) {
		asked = p
		long := filepath.Join(filepath.Dir(p), "a-long-name-"+filepath.Base(p))
		return long, os.Rename(p, long)
	})

	path, cleanup, err := CreateTempNoteFile("# 未保存のノート\n")
	if err != nil {
		t.Fatal(err)
	}
	if asked == "" || filepath.Dir(asked) != dir || !strings.HasPrefix(filepath.Base(asked), "md-memo-slot-") {
		t.Errorf("the expander is asked about the file that was created: %q", asked)
	}
	if !strings.HasPrefix(filepath.Base(path), "a-long-name-md-memo-slot-") || filepath.Dir(path) != dir {
		t.Fatalf("the agent must get the expanded path, got %q", path)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "# 未保存のノート\n" {
		t.Errorf("the note is readable at the handed path: %q %v", data, err)
	}

	// {file} and the note-path hint carry that path (the start of PrepareCommand's chain)
	def := AgentDef{Command: "agent", Args: []string{"-p", "対象ノート: {file}\n指示: {instruction}"}}
	cmd, err := PrepareCommand(context.Background(), def, path, "整えて", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := cmd.Args[2]; got != "対象ノート: "+path+"\n指示: 整えて" {
		t.Errorf("{file} = %q", got)
	}
	if cmd.Dir != FindProjectRoot(path) {
		t.Errorf("the process starts in the folder of the handed path: %q", cmd.Dir)
	}

	cleanup()
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Errorf("cleanup must remove the file: %v", left)
	}
}

// A path that cannot be expanded is used as it is: the run does not fail over it.
func TestCreateTempNoteFile_KeepsThePathWhenTheExpansionFails(t *testing.T) {
	dir := tempDirForNotes(t)
	cases := map[string]func(string) (string, error){
		"an error":                 func(string) (string, error) { return "", errors.New("GetLongPathName failed") },
		"an error with an answer":  func(p string) (string, error) { return p + "-x", errors.New("failed") },
		"an empty answer":          func(string) (string, error) { return "", nil },
		"a file that is not there": func(p string) (string, error) { return filepath.Join(dir, "nowhere", "x.md"), nil },
		"the same path":            func(p string) (string, error) { return p, nil },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			var created string
			stubExpandLongPath(t, func(p string) (string, error) { created = p; return fn(p) })
			path, cleanup, err := CreateTempNoteFile("x")
			if err != nil {
				t.Fatalf("the run must not fail: %v", err)
			}
			if path != created {
				t.Errorf("path = %q, want the one os.CreateTemp made (%q)", path, created)
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("the file must be there: %v", err)
			}
			cleanup()
			if _, err := os.Stat(path); err == nil {
				t.Errorf("cleanup must remove the file")
			}
		})
	}
}

func TestLongPathOrSame(t *testing.T) {
	stubExpandLongPath(t, func(p string) (string, error) { return p, nil })
	if got := longPathOrSame("no-such-file.md"); got != "no-such-file.md" {
		t.Errorf("got %q", got)
	}
	// the real expander (no-op off Windows) never breaks a path that exists
	expandLongPath = platformLongPath
	f := filepath.Join(t.TempDir(), "note.md")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := longPathOrSame(f)
	if _, err := os.Stat(got); err != nil {
		t.Errorf("the result must name the file: %q %v", got, err)
	}
}
