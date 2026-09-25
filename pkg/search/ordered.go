package search

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Options are the extras of SearchScrapsOrdered, the search the command line's `scrap search`
// runs. The GUI's SearchScrapsContext takes none of them.
type Options struct {
	// Keep, when set, is asked about every markdown file (by its path) before it is scanned; a file
	// it rejects is skipped entirely, so it cannot use up the match limit.
	Keep func(path string) bool
	// Less, when set, decides which of two file paths is searched (and so listed) first; it must be
	// a strict order. The default is the file name descending, path as the tie-break, which puts
	// 2026-09-25.md before 2026-09-24.md.
	Less func(a, b string) bool
	// Headings records, for every match, the nearest Markdown heading at or above it.
	Headings bool
}

func newestNameFirst(a, b string) bool {
	if ba, bb := filepath.Base(a), filepath.Base(b); ba != bb {
		return ba > bb
	}
	return a > b
}

// SearchScrapsOrdered finds the same matches as SearchScrapsContext, but in a fully determined
// order: files newest name first (2026-09-25.md before 2026-09-24.md; the path breaks a tie, and
// Options.Less can replace the rule), lines top to bottom, and it stops after exactly maxResults matches (100 when maxResults <= 0). The GUI
// search scans files in parallel and its cap is approximate under concurrency; a command line that
// promises "the first N hits, newest first" needs the strict version, and one process scanning
// one file after another is fast enough for a folder of notes. It honours ctx between lines.
func SearchScrapsOrdered(ctx context.Context, scrapDir, query string, maxResults int, opts Options) ([]SearchResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	trimmedQuery := strings.TrimSpace(query)
	if trimmedQuery == "" {
		return []SearchResult{}, nil
	}
	if maxResults <= 0 {
		maxResults = 100
	}

	cleanDir := filepath.Clean(scrapDir)
	if info, err := os.Stat(cleanDir); err != nil || !info.IsDir() {
		return []SearchResult{}, nil
	}

	var files []string
	for _, path := range collectMarkdownFiles(cleanDir) {
		if opts.Keep == nil || opts.Keep(path) {
			files = append(files, path)
		}
	}
	less := opts.Less
	if less == nil {
		less = newestNameFirst
	}
	sort.Slice(files, func(i, j int) bool { return less(files[i], files[j]) })

	queryLower := bytes.ToLower([]byte(trimmedQuery))
	results := []SearchResult{}
	total := 0
	for _, path := range files {
		if total >= maxResults || ctx.Err() != nil {
			break
		}
		matches := searchFile(ctx, path, queryLower, maxResults-total, opts.Headings)
		if len(matches) == 0 {
			continue
		}
		results = append(results, SearchResult{FilePath: path, FileName: filepath.Base(path), Matches: matches})
		total += len(matches)
	}
	return results, nil
}

// headingTracker follows the ATX headings of one Markdown file line by line, so a match can be
// told which section it sits in. It knows fenced code (``` and ~~~): a "# comment" line inside a
// fence is code, not a heading. It does not know setext headings (a line underlined with === or
// ---), indented code blocks beyond the 4-space rule, HTML blocks or block quotes; the scraps and
// notes it serves write "## [time] title" headings, which is what it is for.
type headingTracker struct {
	fenceChar byte // '`' or '~' while inside a fence, 0 outside
	fenceLen  int
	heading   string // the trimmed heading line, "" until one is seen
	line      int    // its 1-based line number
}

// feed takes the next line (num is its 1-based number, line has no line ending).
func (h *headingTracker) feed(line string, num int) {
	// A fence or a heading may be indented by at most three spaces.
	i := 0
	for i < len(line) && line[i] == ' ' {
		i++
	}
	if i > 3 || i >= len(line) {
		return
	}
	switch c := line[i]; c {
	case '`', '~':
		n := 0
		for i+n < len(line) && line[i+n] == c {
			n++
		}
		if n < 3 {
			return
		}
		rest := line[i+n:]
		switch {
		case h.fenceChar == 0:
			// The info string of a backtick fence cannot contain a backtick (that is inline code).
			if c == '`' && strings.IndexByte(rest, '`') >= 0 {
				return
			}
			h.fenceChar, h.fenceLen = c, n
		case c == h.fenceChar && n >= h.fenceLen && strings.TrimSpace(rest) == "":
			h.fenceChar = 0
		}
	case '#':
		if h.fenceChar != 0 {
			return
		}
		n := 0
		for i+n < len(line) && line[i+n] == '#' {
			n++
		}
		if n > 6 {
			return
		}
		if rest := line[i+n:]; rest == "" || rest[0] == ' ' || rest[0] == '\t' {
			h.heading = strings.TrimSpace(line)
			h.line = num
		}
	}
}
