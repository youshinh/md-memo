package search

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// referenceSearchSingleFile is the original read-the-whole-file implementation, kept here
// purely as the oracle the streaming version is compared against.
func referenceSearchSingleFile(filePath string, queryLower []byte, fileLimit int) []SearchMatch {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)

	var allLines []string
	for scanner.Scan() {
		allLines = append(allLines, scanner.Text())
	}

	var matches []SearchMatch
	lineCount := len(allLines)

	for i := 0; i < lineCount; i++ {
		line := allLines[i]
		if strings.Contains(strings.ToLower(line), string(queryLower)) {
			var snippetParts []string
			if i > 0 {
				snippetParts = append(snippetParts, allLines[i-1])
			}
			snippetParts = append(snippetParts, line)
			if i+1 < lineCount {
				snippetParts = append(snippetParts, allLines[i+1])
			}
			matches = append(matches, SearchMatch{
				LineNumber: i + 1,
				LineText:   line,
				Snippet:    strings.Join(snippetParts, "\n"),
			})
			if len(matches) >= fileLimit {
				break
			}
		}
	}
	return matches
}

func writeFixture(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0644); err != nil {
		t.Fatalf("write fixture %s: %v", name, err)
	}
	return p
}

// TestSearchSingleFile_StreamingMatchesReference asserts the streaming rewrite is
// byte-for-byte identical to the previous implementation across the interesting edge cases:
// a match on the very first line (no previous line), on the very last line (no next line),
// on consecutive lines, in an empty file, in a single-line file, and under the per-file
// limit.
func TestSearchSingleFile_StreamingMatchesReference(t *testing.T) {
	dir := t.TempDir()

	fixtures := map[string]string{
		"first-line.md":       "target at the top\nsecond\nthird\n",
		"last-line.md":        "alpha\nbeta\ntarget at the bottom",
		"consecutive.md":      "a\ntarget one\ntarget two\ntarget three\nz\n",
		"single-line.md":      "target only line",
		"empty.md":            "",
		"no-trailing-nl.md":   "x\ntarget\ny",
		"no-match.md":         "nothing to see here\nmove along\n",
		"unicode.md":          "前の行\nこれはtargetを含む行です\n次の行\n",
		"blank-lines.md":      "\n\ntarget between blanks\n\n\n",
		"crlf.md":             "one\r\ntarget line\r\nthree\r\n",
		"repeated-limited.md": strings.Repeat("target\nfiller\n", 40),
	}

	for name, body := range fixtures {
		path := writeFixture(t, dir, name, body)
		for _, limit := range []int{1, 3, 100} {
			t.Run(fmt.Sprintf("%s/limit=%d", name, limit), func(t *testing.T) {
				want := referenceSearchSingleFile(path, []byte("target"), limit)
				got := searchSingleFile(context.Background(), path, []byte("target"), limit)
				if !reflect.DeepEqual(got, want) {
					t.Errorf("streaming result differs from reference\n got: %#v\nwant: %#v", got, want)
				}
			})
		}
	}
}

// TestSearchScrapsContext_MultiFileParity checks the full multi-file entry point against the
// per-file oracle, so the worker-pool plumbing is covered too.
func TestSearchScrapsContext_MultiFileParity(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, "2026-09-01.md", "intro\ntarget alpha\noutro\n")
	writeFixture(t, dir, "2026-09-02.md", "target beta\nsecond line\n")
	writeFixture(t, dir, "2026-09-03.md", "only text\nlast target")
	writeFixture(t, dir, "ignored.txt", "target in a non-markdown file\n")

	results, err := SearchScrapsContext(context.Background(), dir, "target", 100)
	if err != nil {
		t.Fatalf("SearchScrapsContext failed: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("expected 3 files with matches, got %d: %#v", len(results), results)
	}

	for _, r := range results {
		want := referenceSearchSingleFile(r.FilePath, []byte("target"), 100)
		if !reflect.DeepEqual(r.Matches, want) {
			t.Errorf("%s: matches differ\n got: %#v\nwant: %#v", r.FileName, r.Matches, want)
		}
	}

	// Descending filename order is part of the contract.
	if results[0].FileName != "2026-09-03.md" || results[2].FileName != "2026-09-01.md" {
		t.Errorf("unexpected file ordering: %s, %s, %s", results[0].FileName, results[1].FileName, results[2].FileName)
	}
}

// TestSearchScrapsContext_CancelledReturnsEarly asserts a cancelled context short-circuits
// the scan instead of walking every file.
func TestSearchScrapsContext_CancelledReturnsEarly(t *testing.T) {
	dir := t.TempDir()
	body := strings.Repeat("target line\nfiller line\n", 5000)
	for i := 0; i < 40; i++ {
		writeFixture(t, dir, fmt.Sprintf("2026-09-%02d.md", i+1), body)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before the scan starts

	results, err := SearchScrapsContext(ctx, dir, "target", 100000)
	if err != nil {
		t.Fatalf("SearchScrapsContext returned error: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected no results from a pre-cancelled scan, got %d files", len(results))
	}
	if ctx.Err() == nil {
		t.Error("expected ctx.Err() to be set so callers can distinguish cancelled from finished")
	}
}

// TestSearchScraps_BackwardCompatibleWrapper makes sure the context-free entry point the
// rest of the app still calls behaves exactly as before.
func TestSearchScraps_BackwardCompatibleWrapper(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, "note.md", "alpha\ntarget here\nomega\n")

	results, err := SearchScraps(dir, "target", 10)
	if err != nil {
		t.Fatalf("SearchScraps failed: %v", err)
	}
	if len(results) != 1 || len(results[0].Matches) != 1 {
		t.Fatalf("unexpected results: %#v", results)
	}
	if results[0].Matches[0].Snippet != "alpha\ntarget here\nomega" {
		t.Errorf("snippet = %q", results[0].Matches[0].Snippet)
	}
	if results[0].Matches[0].LineNumber != 2 {
		t.Errorf("lineNumber = %d, want 2", results[0].Matches[0].LineNumber)
	}
}
