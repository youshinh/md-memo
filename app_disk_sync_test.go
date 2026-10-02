package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/ipc"
	"md-memo/pkg/textsig"
)

// A file changed by something else after a tab last read or wrote it must not be overwritten by the tab's next save. The page sends
// the fingerprint of the text it last knew of the file (see pkg/textsig and frontend/js/disk_sync.js); the Go side compares it with
// what the file holds now.

func writeNote(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSaveFileCheckedRefusesAFileChangedUnderTheTab(t *testing.T) {
	app := &App{}
	p := writeNote(t, t.TempDir(), "n.md", "what the tab read\n")
	known := textsig.Sum("what the tab read\n")

	// something else rewrites the file
	if err := os.WriteFile(p, []byte("what the other editor wrote\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := app.SaveFileChecked(p, "my edit\n", "UTF-8", known)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Conflict || res.Success {
		t.Fatalf("result = %+v, want a conflict that wrote nothing", res)
	}
	if raw, _ := os.ReadFile(p); string(raw) != "what the other editor wrote\n" {
		t.Errorf("the file was written over despite the conflict: %q", raw)
	}
}

func TestSaveFileCheckedWritesWhenTheFileIsWhatTheTabKnows(t *testing.T) {
	app := &App{}
	p := writeNote(t, t.TempDir(), "n.md", "known\r\ntext\r\n") // CRLF on disk, LF in the tab: line endings do not count
	res, err := app.SaveFileChecked(p, "known\ntext\nmore\n", "UTF-8", textsig.Sum("known\ntext\n"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Conflict || !res.Success {
		t.Fatalf("result = %+v, want a plain save", res)
	}
	if want := textsig.Sum("known\ntext\nmore\n"); res.Sig != want {
		t.Errorf("Sig = %q, want %q (what the file holds now)", res.Sig, want)
	}
	if raw, _ := os.ReadFile(p); string(raw) != "known\ntext\nmore\n" {
		t.Errorf("file = %q", raw)
	}
}

func TestSaveFileCheckedChecksNothingItCannotCheck(t *testing.T) {
	app := &App{}
	dir := t.TempDir()

	// a tab that never learned the file: saves as before
	p := writeNote(t, dir, "a.md", "anything")
	if res, err := app.SaveFileChecked(p, "x", "UTF-8", ""); err != nil || res.Conflict || !res.Success {
		t.Errorf("no expected fingerprint: res=%+v err=%v", res, err)
	}
	// the file is gone: the save recreates it, as it always did
	gone := filepath.Join(dir, "gone.md")
	if res, err := app.SaveFileChecked(gone, "again", "UTF-8", textsig.Sum("what it was")); err != nil || res.Conflict || !res.Success {
		t.Errorf("deleted file: res=%+v err=%v", res, err)
	}
	if raw, _ := os.ReadFile(gone); string(raw) != "again" {
		t.Errorf("recreated file = %q", raw)
	}
}

func TestSaveFileCheckedUnderShiftJIS(t *testing.T) {
	app := &App{}
	p := filepath.Join(t.TempDir(), "sjis.md")
	// "日本語のメモ" in Shift_JIS, written by an old editor
	sjis := []byte{0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA, 0x82, 0xCC, 0x83, 0x81, 0x83, 0x82}
	if err := os.WriteFile(p, sjis, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := app.SaveFileChecked(p, "日本語のメモ\n追記", "Shift_JIS", textsig.Sum("日本語のメモ"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Conflict || !res.Success {
		t.Fatalf("the text on disk is the one the tab read (decoded from Shift_JIS), so the save must go through: %+v", res)
	}
}

func TestBufferSaveOwnFileChangedOnDiskIsAConflict(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	dir := t.TempDir()
	p := writeNote(t, dir, "own.md", "text the tab read\n")
	tab.Path, tab.Title, tab.Content = p, "own.md", "my edit\n"
	tab.DiskSig = textsig.Sum("text the tab read\n")

	if err := os.WriteFile(p, []byte("a Git pull changed this\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{}), ipc.ErrCodeConflict)
	if !strings.HasPrefix(msg, "not saved: ") || !strings.Contains(msg, "changed on disk") {
		t.Errorf("message = %q", msg)
	}
	if raw, _ := os.ReadFile(p); string(raw) != "a Git pull changed this\n" {
		t.Errorf("the refused save changed the file: %q", raw)
	}
	for _, c := range page.callNames() {
		if c == "commitSave" {
			t.Error("commitSave must not run after a refusal")
		}
	}

	// overwrite says the caller wants the file replaced whatever it holds
	mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Overwrite: true}))
	if raw, _ := os.ReadFile(p); string(raw) != "my edit\n" {
		t.Errorf("file after overwrite = %q", raw)
	}
	if tab.DiskSig != textsig.Sum("my edit\n") {
		t.Errorf("the tab must now know the file holds what was written: %q", tab.DiskSig)
	}
}

func TestBufferSaveOwnFileUnchangedStillSaves(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	p := writeNote(t, t.TempDir(), "own.md", "text the tab read\n")
	tab.Path, tab.Title, tab.Content = p, "own.md", "text the tab read\nplus a line\n"
	tab.DiskSig = textsig.Sum("text the tab read\n")

	mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{}))
	if raw, _ := os.ReadFile(p); string(raw) != "text the tab read\nplus a line\n" {
		t.Errorf("file = %q", raw)
	}
}

func TestBufferSaveKeepsACRLFFilesLineEnding(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	p := writeNote(t, t.TempDir(), "crlf.md", "one\r\ntwo\r\n")
	tab.Path, tab.Title, tab.Eol = p, "crlf.md", "crlf"
	tab.Content = "one\ntwo\nthree\n"
	tab.DiskSig = textsig.Sum("one\ntwo\n")

	mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{}))
	if raw, _ := os.ReadFile(p); string(raw) != "one\r\ntwo\r\nthree\r\n" {
		t.Errorf("file = %q, want the CRLF line ending kept", raw)
	}
}
