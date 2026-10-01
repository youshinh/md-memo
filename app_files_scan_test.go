package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"md-memo/pkg/encoding"
)

// The related-note pills and the folder list take a note's title from the first 2 KB of the file. A Japanese UTF-8 note whose
// 2048th byte fell inside a 3-byte character used to be read as Shift_JIS, and its title came out as mojibake.
func TestScanFolderFilesTitleSurvivesACutInsideACharacter(t *testing.T) {
	dir := t.TempDir()

	// Pad the head with ASCII until the 2048-byte limit lands inside a character.
	body := strings.Repeat("売上と費用の内訳を確認する。", 400)
	var content string
	for pad := 0; pad < 4; pad++ {
		content = "# 1. 損益報告書\n" + strings.Repeat("a", pad) + body
		if !utf8.Valid([]byte(content)[:2048]) {
			break
		}
	}
	if utf8.Valid([]byte(content)[:2048]) {
		t.Fatal("test setup: could not make the 2048-byte limit split a character")
	}
	if err := os.WriteFile(filepath.Join(dir, "utf8-note.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	// A real Shift_JIS note must still be read as Shift_JIS.
	sjis, err := encoding.Encode("# 2. 月次報告書\n"+strings.Repeat("売上と費用の内訳を確認する。", 400), "Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sjis-note.md"), sjis, 0o644); err != nil {
		t.Fatal(err)
	}

	entries, err := (&App{}).ScanFolderFiles(dir)
	if err != nil {
		t.Fatal(err)
	}
	titles := map[string]string{}
	for _, e := range entries {
		titles[filepath.Base(e.Path)] = e.Title
	}
	if got := titles["utf8-note.md"]; got != "1. 損益報告書" {
		t.Errorf("UTF-8 note cut inside a character: title %q, want %q", got, "1. 損益報告書")
	}
	if got := titles["sjis-note.md"]; got != "2. 月次報告書" {
		t.Errorf("Shift_JIS note: title %q, want %q", got, "2. 月次報告書")
	}
}
