package search

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSearchScraps(t *testing.T) {
	tempDir := t.TempDir()

	// 複数のテストファイルを作成
	file1 := filepath.Join(tempDir, "2026-09-16.md")
	content1 := `---
## [10:00:00] npm test
` + "```text" + `
Error: Test failed at src/index.ts:42
Stack: at runTest (test.js:10)
` + "```" + `
メモ: 後でindex.tsの修正が必要
`
	if err := os.WriteFile(file1, []byte(content1), 0644); err != nil {
		t.Fatalf("failed to create file1: %v", err)
	}

	file2 := filepath.Join(tempDir, "2026-09-17.md")
	content2 := `---
## [14:00:00] git diff
` + "```text" + `
+ func SearchScraps()
- old code
` + "```" + `
メモ: SearchScrapsの実装完了
`
	if err := os.WriteFile(file2, []byte(content2), 0644); err != nil {
		t.Fatalf("failed to create file2: %v", err)
	}

	// 1. クエリ "index.ts" で検索
	results, err := SearchScraps(tempDir, "index.ts", 10)
	if err != nil {
		t.Fatalf("SearchScraps failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result file, got %d", len(results))
	}
	if results[0].FileName != "2026-09-16.md" {
		t.Errorf("expected 2026-09-16.md, got %s", results[0].FileName)
	}
	if len(results[0].Matches) != 2 { // "Error: Test failed at src/index.ts:42" と "メモ: 後でindex.tsの修正が必要"
		t.Fatalf("expected 2 matches in file1, got %d", len(results[0].Matches))
	}
	if results[0].Matches[0].LineNumber != 4 {
		t.Errorf("expected line number 4, got %d", results[0].Matches[0].LineNumber)
	}
	if results[0].Matches[0].Snippet == "" {
		t.Errorf("expected snippet not to be empty")
	}

	// 2. クエリ "SearchScraps"（大文字小文字無視）
	results2, err := SearchScraps(tempDir, "searchscraps", 10)
	if err != nil {
		t.Fatalf("SearchScraps failed: %v", err)
	}
	if len(results2) != 1 {
		t.Fatalf("expected 1 result file, got %d", len(results2))
	}
	if results2[0].FileName != "2026-09-17.md" {
		t.Errorf("expected 2026-09-17.md, got %s", results2[0].FileName)
	}

	// 3. 空クエリ時は空配列を返す
	emptyResults, err := SearchScraps(tempDir, "", 10)
	if err != nil {
		t.Fatalf("SearchScraps with empty query failed: %v", err)
	}
	if len(emptyResults) != 0 {
		t.Errorf("expected 0 results for empty query, got %d", len(emptyResults))
	}
}

func BenchmarkSearchScraps(b *testing.B) {
	tempDir := b.TempDir()
	// 50ファイル作成
	for i := 0; i < 50; i++ {
		name := filepath.Join(tempDir, fmt.Sprintf("2026-01-%02d.md", i%30+1))
		body := fmt.Sprintf("Line 1\nLine 2 target query here %d\nLine 3\nLine 4\n", i)
		_ = os.WriteFile(name, []byte(body), 0644)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = SearchScraps(tempDir, "target query", 100)
	}
}
