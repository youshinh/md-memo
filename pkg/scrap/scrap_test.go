package scrap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAppendScrapNewFile(t *testing.T) {
	tempDir := t.TempDir()

	testTime := time.Date(2026, 9, 17, 15, 4, 5, 0, time.Local)
	content := "fatal: unable to access 'https://github.com/': connection timed out"
	cmd := "git push origin main"

	filePath, err := AppendScrap(tempDir, content, cmd, testTime)
	if err != nil {
		t.Fatalf("AppendScrap failed: %v", err)
	}

	expectedFileName := "2026-09-17.md"
	if filepath.Base(filePath) != expectedFileName {
		t.Errorf("expected file name %s, got %s", expectedFileName, filepath.Base(filePath))
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}

	text := string(data)
	if !strings.Contains(text, "## [15:04:05] git push origin main") {
		t.Errorf("expected header in output, got:\n%s", text)
	}
	if !strings.Contains(text, content) {
		t.Errorf("expected content in output, got:\n%s", text)
	}
	if !strings.Contains(text, "```text\n") {
		t.Errorf("expected code fence in output, got:\n%s", text)
	}
}

func TestAppendScrapExistingFile(t *testing.T) {
	tempDir := t.TempDir()

	testTime1 := time.Date(2026, 9, 17, 10, 0, 0, 0, time.Local)
	testTime2 := time.Date(2026, 9, 17, 15, 30, 0, 0, time.Local)

	filePath, err := AppendScrap(tempDir, "first entry", "", testTime1)
	if err != nil {
		t.Fatalf("AppendScrap 1 failed: %v", err)
	}

	_, err = AppendScrap(tempDir, "second entry", "git diff", testTime2)
	if err != nil {
		t.Fatalf("AppendScrap 2 failed: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}

	text := string(data)
	if !strings.Contains(text, "## [10:00:00] CLI Pipe") {
		t.Errorf("expected first header, got:\n%s", text)
	}
	if !strings.Contains(text, "## [15:30:00] git diff") {
		t.Errorf("expected second header, got:\n%s", text)
	}
	if !strings.Contains(text, "first entry") || !strings.Contains(text, "second entry") {
		t.Errorf("expected both entries in file, got:\n%s", text)
	}
}

func TestResolveScrapDir(t *testing.T) {
	home, _ := os.UserHomeDir()
	resolved := ResolveScrapDir("~/Documents/md-memo/scraps")
	expected := filepath.Join(home, "Documents", "md-memo", "scraps")
	if resolved != expected {
		t.Errorf("expected %s, got %s", expected, resolved)
	}

	rawPath := filepath.Join("C:", "MyScraps")
	resolvedRaw := ResolveScrapDir(rawPath)
	if resolvedRaw != rawPath {
		t.Errorf("expected %s, got %s", rawPath, resolvedRaw)
	}
}
