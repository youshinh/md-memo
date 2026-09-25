package search

import (
	"bufio"
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// SearchMatch represents a single matching line with surrounding snippet context.
type SearchMatch struct {
	LineNumber int    `json:"lineNumber"`
	LineText   string `json:"lineText"`
	Snippet    string `json:"snippet"` // Context preview including before/after line
	// Heading is the nearest Markdown (ATX) heading at or above the line, and HeadingLine its line
	// number. They are only filled in when Options.Headings asks for them (the command line's
	// `scrap search`); the GUI search leaves them empty and its JSON does not carry them.
	Heading     string `json:"heading,omitempty"`
	HeadingLine int    `json:"headingLine,omitempty"`
}

// SearchResult represents matches found inside a scrap file.
type SearchResult struct {
	FilePath string        `json:"filePath"`
	FileName string        `json:"fileName"` // e.g. 2026-09-17.md
	Matches  []SearchMatch `json:"matches"`
}

// SearchScraps scans all .md files under scrapDir concurrently using a worker pool.
func SearchScraps(scrapDir string, query string, maxResults int) ([]SearchResult, error) {
	return SearchScrapsContext(context.Background(), scrapDir, query, maxResults)
}

// SearchScrapsContext is SearchScraps with cancellation support. When ctx is cancelled the
// scan stops as soon as the workers notice (checked per file and periodically inside a
// file), which is what lets a newer keystroke in the search box abandon the previous full
// scan instead of queueing N of them. Callers should check ctx.Err() to tell "finished" from
// "abandoned", since a cancelled scan returns whatever it had collected so far.
func SearchScrapsContext(ctx context.Context, scrapDir string, query string, maxResults int) ([]SearchResult, error) {
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

	// 1. Collect all markdown files
	files := collectMarkdownFiles(cleanDir)

	if len(files) == 0 {
		return []SearchResult{}, nil
	}

	// Sort files in descending order so newer scraps appear first
	sort.Slice(files, func(i, j int) bool {
		return files[i] > files[j]
	})

	queryLowerBytes := bytes.ToLower([]byte(trimmedQuery))
	numWorkers := runtime.NumCPU()
	if numWorkers < 1 {
		numWorkers = 1
	}
	if numWorkers > len(files) {
		numWorkers = len(files)
	}

	filesChan := make(chan string, len(files))
	for _, f := range files {
		filesChan <- f
	}
	close(filesChan)

	var totalMatches int32
	var mu sync.Mutex
	var results []SearchResult

	var wg sync.WaitGroup
	wg.Add(numWorkers)

	for w := 0; w < numWorkers; w++ {
		go func() {
			defer wg.Done()

			for path := range filesChan {
				if atomic.LoadInt32(&totalMatches) >= int32(maxResults) {
					return
				}
				if ctx.Err() != nil {
					return
				}

				matches := searchSingleFile(ctx, path, queryLowerBytes, maxResults-int(atomic.LoadInt32(&totalMatches)))
				if len(matches) > 0 {
					mu.Lock()
					results = append(results, SearchResult{
						FilePath: path,
						FileName: filepath.Base(path),
						Matches:  matches,
					})
					newTotal := atomic.AddInt32(&totalMatches, int32(len(matches)))
					mu.Unlock()

					if newTotal >= int32(maxResults) {
						return
					}
				}
			}
		}()
	}

	wg.Wait()

	// Maintain predictable filename order (descending)
	sort.Slice(results, func(i, j int) bool {
		return results[i].FileName > results[j].FileName
	})

	return results, nil
}

// collectMarkdownFiles lists every .md file under cleanDir, skipping folders whose name starts
// with a dot (.git and the like). The order is the walk's, not sorted.
func collectMarkdownFiles(cleanDir string) []string {
	var files []string
	_ = filepath.WalkDir(cleanDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := strings.ToLower(d.Name())
			if strings.HasPrefix(name, ".") && name != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			files = append(files, path)
		}
		return nil
	})
	return files
}

// searchSingleFile is what the GUI search runs on each file: searchFile without headings.
func searchSingleFile(ctx context.Context, filePath string, queryLower []byte, fileLimit int) []SearchMatch {
	return searchFile(ctx, filePath, queryLower, fileLimit, false)
}

// searchFile streams the file line by line instead of materialising every line in a
// []string. A snippet only ever needs the previous line, the matching line and the next
// line, so a 3-line sliding window is enough: a match on line N is only emitted once line
// N+1 has been read (or EOF is reached), which is what makes the "next line" available
// without buffering the whole file. Results are byte-for-byte identical to the previous
// read-everything implementation.
//
// When headings is set the Markdown structure of the file is followed as well (see
// headingTracker) and every match records its nearest heading. Without it nothing extra is
// done per line.
func searchFile(ctx context.Context, filePath string, queryLower []byte, fileLimit int, headings bool) []SearchMatch {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	// Read lines with bufio.Scanner (max 10MB per line safety)
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)

	query := string(queryLower)

	var matches []SearchMatch
	var prevLine, curLine string
	curNum := 0 // 1-indexed line number of curLine; 0 means "no line read yet"
	curMatched := false
	var tracker headingTracker
	var curHeading string
	var curHeadingLine int

	// emit finalises a pending match on curLine now that its following line is known.
	// It reports whether scanning should continue.
	emit := func(nextLine string, hasNext bool) bool {
		if !curMatched {
			return true
		}
		var snippetParts []string
		if curNum > 1 {
			snippetParts = append(snippetParts, prevLine)
		}
		snippetParts = append(snippetParts, curLine)
		if hasNext {
			snippetParts = append(snippetParts, nextLine)
		}
		matches = append(matches, SearchMatch{
			LineNumber:  curNum,
			LineText:    curLine,
			Snippet:     strings.Join(snippetParts, "\n"),
			Heading:     curHeading,
			HeadingLine: curHeadingLine,
		})
		return len(matches) < fileLimit
	}

	lineNum := 0
	for scanner.Scan() {
		line := scanner.Text()
		lineNum++

		if curNum != 0 {
			if !emit(line, true) {
				return matches
			}
			prevLine = curLine
		}

		curLine = line
		curNum = lineNum
		curMatched = strings.Contains(strings.ToLower(line), query)
		if headings {
			// The line counts for its own heading state: a match on a heading line belongs to it.
			tracker.feed(line, lineNum)
			curHeading, curHeadingLine = tracker.heading, tracker.line
		}

		// Cheap periodic cancellation check so a superseded search abandons a huge file
		// instead of scanning it to the end.
		if lineNum%512 == 0 && ctx.Err() != nil {
			return matches
		}
	}

	if curNum != 0 {
		emit("", false)
	}

	return matches
}
