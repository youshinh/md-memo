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

// DateLayout is the layout of a day in a scrap file name (2026-09-25).
const DateLayout = "2006-01-02"

// DailyFileName is the name of the scrap file of the day t falls on: 2026-09-25.md.
func DailyFileName(t time.Time) string {
	return t.Format(DateLayout + ".md")
}

// DailyPath is the file today's (or any day's) scrap goes into: DailyFileName(t) inside dir, where
// dir is expanded like ResolveScrapDir does (~ and the like; empty means the default folder).
// It only computes the path: nothing is created or read.
func DailyPath(dir string, t time.Time) string {
	return filepath.Join(ResolveScrapDir(dir), DailyFileName(t))
}

// DateOfFile reports the day a scrap file name stands for: "2026-09-25.md" gives "2026-09-25".
// It is false for any other name (notes.md, 2026-9-5.md, 2026-02-30.md, a folder name), so callers
// can tell the writer's daily files from whatever else sits in the folder. The ".md" is matched
// case-insensitively; the date must be a real calendar day written with two-digit month and day.
func DateOfFile(name string) (string, bool) {
	const n = len(DateLayout)
	if len(name) != n+3 || !strings.EqualFold(name[n:], ".md") {
		return "", false
	}
	day := name[:n]
	if _, err := time.Parse(DateLayout, day); err != nil {
		return "", false
	}
	return day, true
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

// FormatMarkdownEntry is an entry whose content is Markdown that stays Markdown: the same rule and heading as FormatScrapEntry
// ("---", "## [HH:MM:SS] title"), then the content as it is, not in a text fence, so that links, lists and emphasis in it are live
// (a summary with links to the notes it quotes, for example). title defaults to "CLI Pipe" like the fenced entry's.
func FormatMarkdownEntry(content, title string, t time.Time) string {
	heading := strings.TrimSpace(title)
	if heading == "" {
		heading = "CLI Pipe"
	}
	return "---\n" + fmt.Sprintf("## [%s] %s\n\n", t.Format("15:04:05"), heading) + strings.TrimRight(content, "\r\n") + "\n"
}

// AppendMarkdownAt is AppendScrapAt for FormatMarkdownEntry.
func AppendMarkdownAt(scrapDir, content, title string, t time.Time) (path string, startLine, written int, err error) {
	entry := FormatMarkdownEntry(content, title, t)
	path, startLine, err = appendEntry(scrapDir, entry, t, true)
	if err != nil {
		return "", 0, 0, err
	}
	written = len(entry)
	if startLine > 1 {
		written++
	}
	return path, startLine, written, nil
}

// AppendScrap appends the given content to scraps/YYYY-MM-DD.md in scrapDir.
func AppendScrap(scrapDir, content, command string, t time.Time) (string, error) {
	path, _, err := appendEntry(scrapDir, FormatScrapEntry(content, command, t), t, false)
	return path, err
}

// AppendScrapAt is AppendScrap that also says where the entry starts: the 1-based line of its "---" rule in the file, and how many
// bytes were written (the separator, if any, and the entry). It reads the existing file once to count its lines, so the hot paths
// that do not need the line (a pipe, the Discord bridge) use AppendScrap.
func AppendScrapAt(scrapDir, content, command string, t time.Time) (path string, startLine, written int, err error) {
	entry := FormatScrapEntry(content, command, t)
	path, startLine, err = appendEntry(scrapDir, entry, t, true)
	if err != nil {
		return "", 0, 0, err
	}
	written = len(entry)
	if startLine > 1 {
		written++ // the blank line that separates it from what was there
	}
	return path, startLine, written, nil
}

// AppendRaw appends entry to scraps/YYYY-MM-DD.md verbatim (no code-fence wrapping), for callers
// that already produced their own markdown - e.g. the Discord bridge, whose messages go through
// the same image/OCR and audio/transcription formatting Mobile Drop uses and must not be
// re-wrapped in a "```text" block meant for raw CLI output.
func AppendRaw(scrapDir, entry string, t time.Time) (string, error) {
	path, _, err := appendEntry(scrapDir, entry, t, false)
	return path, err
}

// appendEntry opens (creating if needed) scraps/YYYY-MM-DD.md in scrapDir and writes entry at
// its end, preceded by a blank line when the file already has content.
//
// With wantLine it also returns the 1-based line the entry's first line lands on, counted from the file as it was under the same
// lock as the write; otherwise that is 0 and the file is not read.
func appendEntry(scrapDir, entry string, t time.Time, wantLine bool) (string, int, error) {
	scrapMu.Lock()
	defer scrapMu.Unlock()

	resolvedDir := ResolveScrapDir(scrapDir)
	if err := os.MkdirAll(resolvedDir, 0755); err != nil {
		return "", 0, fmt.Errorf("failed to create scrap directory: %w", err)
	}

	// resolvedDir is already absolute, so DailyPath's own expansion leaves it as it is.
	targetPath := DailyPath(resolvedDir, t)

	startLine := 0
	if wantLine {
		startLine = entryStartLine(targetPath)
	}

	f, err := os.OpenFile(targetPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return "", 0, fmt.Errorf("failed to open scrap file: %w", err)
	}
	defer f.Close()

	// Check if file is non-empty to precede with newline if needed
	stat, err := f.Stat()
	if err == nil && stat.Size() > 0 {
		if _, err := f.WriteString("\n"); err != nil {
			return "", 0, fmt.Errorf("failed to write separator: %w", err)
		}
	}

	if _, err := f.WriteString(entry); err != nil {
		return "", 0, fmt.Errorf("failed to write scrap entry: %w", err)
	}

	return targetPath, startLine, nil
}

// entryStartLine is the line an entry appended to the file as it is now would start on (see appendEntry): 1 for a missing or empty
// file; otherwise the separator that appendEntry writes ends an unfinished last line, or is an empty line of its own when the file
// ended with a line break, and the entry comes after it.
func entryStartLine(path string) int {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return 1
	}
	// "a\n": one line break, the separator is line 2, the entry starts on line 3. "a": no line break, the unfinished line 1 is ended by
	// the separator, the entry starts on line 2. Either way: the number of line breaks plus two.
	return strings.Count(string(data), "\n") + 2
}
