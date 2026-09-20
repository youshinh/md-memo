package scrap

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/appdir"
)

var scrapMu sync.Mutex

// ResolveScrapDir expands ~ or environment paths to absolute filesystem path.
func ResolveScrapDir(path string) string {
	if path == "" {
		home, err := appdir.HomeDir()
		if err != nil {
			return filepath.Join(".", "scraps")
		}
		return filepath.Join(home, "Documents", "md-memo", "scraps")
	}

	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := appdir.HomeDir()
		if err == nil {
			return filepath.Join(home, path[2:])
		}
	} else if path == "~" {
		home, err := appdir.HomeDir()
		if err == nil {
			return home
		}
	}

	return filepath.Clean(path)
}

// FormatScrapEntry formats piped text into markdown format with timestamp and code block.
func FormatScrapEntry(content, command string, t time.Time) string {
	headingCmd := strings.TrimSpace(command)
	if headingCmd == "" {
		headingCmd = "CLI Pipe"
	}

	timeStr := t.Format("15:04:05")
	trimmedContent := strings.TrimRight(content, "\r\n")

	var sb strings.Builder
	sb.WriteString("---\n")
	sb.WriteString(fmt.Sprintf("## [%s] %s\n", timeStr, headingCmd))
	sb.WriteString("```text\n")
	sb.WriteString(trimmedContent)
	sb.WriteString("\n```\n")

	return sb.String()
}

// AppendScrap appends the given content to scraps/YYYY-MM-DD.md in scrapDir.
func AppendScrap(scrapDir, content, command string, t time.Time) (string, error) {
	scrapMu.Lock()
	defer scrapMu.Unlock()

	resolvedDir := ResolveScrapDir(scrapDir)
	if err := os.MkdirAll(resolvedDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create scrap directory: %w", err)
	}

	fileName := t.Format("2006-01-02.md")
	targetPath := filepath.Join(resolvedDir, fileName)

	entry := FormatScrapEntry(content, command, t)

	f, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return "", fmt.Errorf("failed to open scrap file: %w", err)
	}
	defer f.Close()

	// Check if file is non-empty to precede with newline if needed
	stat, err := f.Stat()
	if err == nil && stat.Size() > 0 {
		if _, err := f.WriteString("\n"); err != nil {
			return "", fmt.Errorf("failed to write separator: %w", err)
		}
	}

	if _, err := f.WriteString(entry); err != nil {
		return "", fmt.Errorf("failed to write scrap entry: %w", err)
	}

	return targetPath, nil
}
