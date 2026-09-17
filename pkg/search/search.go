package search

import (
	"bufio"
	"bytes"
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
}

// SearchResult represents matches found inside a scrap file.
type SearchResult struct {
	FilePath string        `json:"filePath"`
	FileName string        `json:"fileName"` // e.g. 2026-09-17.md
	Matches  []SearchMatch `json:"matches"`
}

// SearchScraps scans all .md files under scrapDir concurrently using a worker pool.
func SearchScraps(scrapDir string, query string, maxResults int) ([]SearchResult, error) {
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

				matches := searchSingleFile(path, queryLowerBytes, maxResults-int(atomic.LoadInt32(&totalMatches)))
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

func searchSingleFile(filePath string, queryLower []byte, fileLimit int) []SearchMatch {
	f, err := os.Open(filePath)
	if err != nil {
		return nil
	}
	defer f.Close()

	// Read lines with bufio.Scanner (max 10MB per line safety)
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
		lineLower := strings.ToLower(line)

		if strings.Contains(lineLower, string(queryLower)) {
			// Build context snippet (prev line, current line, next line)
			var snippetParts []string
			if i > 0 {
				snippetParts = append(snippetParts, allLines[i-1])
			}
			snippetParts = append(snippetParts, line)
			if i+1 < lineCount {
				snippetParts = append(snippetParts, allLines[i+1])
			}

			matches = append(matches, SearchMatch{
				LineNumber: i + 1, // 1-indexed
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
