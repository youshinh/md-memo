package main

import (
	"strings"
	"testing"
)

type mockWebViewForScrap struct {
	dispatched []func()
	evals      []string
}

func (m *mockWebViewForScrap) Dispatch(fn func()) {
	m.dispatched = append(m.dispatched, fn)
	fn()
}

func (m *mockWebViewForScrap) Eval(js string) {
	m.evals = append(m.evals, js)
}

func TestAppAppendDailyScrapAndSearch(t *testing.T) {
	tempDir := t.TempDir()

	mockW := &mockWebViewForScrap{}
	app := &App{
		w:        mockW,
		scrapDir: tempDir,
	}

	// 1. スクラップ追記
	content := "panic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV: segmentation violation at 0x0]\nsrc/app.go:42"
	filePath, err := app.AppendDailyScrap(content, "go test ./...", "C:\\project")
	if err != nil {
		t.Fatalf("AppendDailyScrap failed: %v", err)
	}

	if len(mockW.evals) == 0 {
		t.Errorf("expected WebView to receive onScrapAppended evaluation, got none")
	} else {
		lastEval := mockW.evals[len(mockW.evals)-1]
		if !strings.Contains(lastEval, "window.onScrapAppended") {
			t.Errorf("expected window.onScrapAppended in eval, got %s", lastEval)
		}
	}

	// 2. 超高速検索
	results, err := app.SearchScraps("app.go:42", 10)
	if err != nil {
		t.Fatalf("SearchScraps failed: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result file, got %d", len(results))
	}
	if results[0].FilePath != filePath {
		t.Errorf("expected FilePath %s, got %s", filePath, results[0].FilePath)
	}
	if len(results[0].Matches) == 0 {
		t.Fatalf("expected matches, got 0")
	}

	match := results[0].Matches[0]
	if !strings.Contains(match.LineText, "src/app.go:42") {
		t.Errorf("expected match line text to contain src/app.go:42, got %s", match.LineText)
	}
}

// URLバリデーションのみを検証する。OpenExternal を直接呼ぶと OS に URL が発行され、
// テスト実行のたびに VS Code やブラウザが実際に起動してしまうため呼ばないこと。
func TestValidateExternalURL(t *testing.T) {
	allowed := []string{
		"vscode://file/c:/project/app.go:42",
		"https://example.com/docs",
		"http://127.0.0.1:41739/",
	}
	for _, raw := range allowed {
		if _, err := validateExternalURL(raw); err != nil {
			t.Errorf("expected %q to be allowed, got error: %v", raw, err)
		}
	}

	rejected := []string{
		"file:///c:/windows/system32/cmd.exe",
		"javascript:alert(1)",
		"ms-settings:privacy",
		"c:/project/app.go",
		"",
	}
	for _, raw := range rejected {
		if _, err := validateExternalURL(raw); err == nil {
			t.Errorf("expected %q to be rejected", raw)
		}
	}
}
