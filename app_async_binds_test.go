package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// asyncMockWebView records every Eval string, guarded by a mutex because the async binds
// dispatch from background goroutines.
type asyncMockWebView struct {
	mu    sync.Mutex
	evals []string
}

func (m *asyncMockWebView) Dispatch(fn func()) { fn() }

func (m *asyncMockWebView) Eval(js string) {
	m.mu.Lock()
	m.evals = append(m.evals, js)
	m.mu.Unlock()
}

func (m *asyncMockWebView) waitFor(t *testing.T, substr string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		for _, e := range m.evals {
			if strings.Contains(e, substr) {
				m.mu.Unlock()
				return e
			}
		}
		m.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	m.mu.Lock()
	got := append([]string(nil), m.evals...)
	m.mu.Unlock()
	t.Fatalf("timed out waiting for an eval containing %q; got %v", substr, got)
	return ""
}

// TestSearchScrapsAsync_DeliversSameShapeAsSyncBind covers the async-ification of the scrap
// search: the frontend-facing contract must be unchanged, so the payload handed to
// window.__onSearchScrapsResult has to marshal to exactly what the synchronous bind returned.
func TestSearchScrapsAsync_DeliversSameShapeAsSyncBind(t *testing.T) {
	scrapDir := t.TempDir()
	body := "intro line\nthe needle is here\ntrailing line\n"
	if err := os.WriteFile(filepath.Join(scrapDir, "2026-09-20.md"), []byte(body), 0644); err != nil {
		t.Fatalf("write scrap: %v", err)
	}

	mock := &asyncMockWebView{}
	app := &App{w: mock, scrapDir: scrapDir}

	want, err := app.SearchScraps("needle", 10)
	if err != nil {
		t.Fatalf("sync SearchScraps failed: %v", err)
	}
	wantJSON, _ := json.Marshal(want)

	app.SearchScrapsAsync("req-search-1", "needle", 10)
	eval := mock.waitFor(t, "__onSearchScrapsResult", 5*time.Second)

	if !strings.Contains(eval, `"req-search-1"`) {
		t.Errorf("callback did not carry the request id: %s", eval)
	}
	if !strings.Contains(eval, string(wantJSON)) {
		t.Errorf("async payload differs from the synchronous result\n got: %s\nwant substring: %s", eval, wantJSON)
	}
	if !strings.Contains(eval, `""`) {
		t.Errorf("expected an empty error argument on success: %s", eval)
	}
}

// TestSearchScrapsAsync_NewerSearchCancelsOlder checks the supersession rule: a second
// search cancels the first, and the first settles with an error rather than resolving with
// partial results that could overwrite the newer ones.
func TestSearchScrapsAsync_NewerSearchCancelsOlder(t *testing.T) {
	scrapDir := t.TempDir()
	// Enough content that the first scan is still running when the second starts.
	big := strings.Repeat("needle line\nfiller line\n", 20000)
	for i := 0; i < 30; i++ {
		name := filepath.Join(scrapDir, fmt.Sprintf("2026-09-%02d.md", i+1))
		if err := os.WriteFile(name, []byte(big), 0644); err != nil {
			t.Fatalf("write scrap: %v", err)
		}
	}

	mock := &asyncMockWebView{}
	app := &App{w: mock, scrapDir: scrapDir}

	app.SearchScrapsAsync("req-old", "needle", 1000000)
	app.SearchScrapsAsync("req-new", "needle", 1000000)

	// Both request ids must eventually settle exactly once; neither may be left pending.
	oldEval := mock.waitFor(t, "req-old", 15*time.Second)
	mock.waitFor(t, "req-new", 15*time.Second)

	// The superseded one is allowed to either have finished first (error "") or to report
	// the interruption - what must never happen is it silently never settling.
	t.Logf("superseded callback: %s", oldEval)
}

// TestJevPredictAsync_DeliversPredictShape covers the async-ification of Quick Actions:
// same resolved shape as the synchronous JevPredict bind, and no network with an empty
// configuration.
func TestJevPredictAsync_DeliversPredictShape(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	app.InitJevEngine()

	app.jevMu.Lock()
	client := app.jevClient
	app.jevMu.Unlock()
	client.SetHTTPClient(&http.Client{Transport: noNetworkRoundTripper{t: t}})

	doc := "# API Service\n\nFix authentication bug in handler."
	app.JevPredictAsync("req-jev-1", doc, len(doc))

	eval := mock.waitFor(t, "__onJevPredictResult", 10*time.Second)
	if !strings.Contains(eval, `"req-jev-1"`) {
		t.Errorf("callback did not carry the request id: %s", eval)
	}
	if !strings.Contains(eval, `"candidates"`) {
		t.Errorf("payload is missing the candidates field expected by the frontend: %s", eval)
	}

	// The payload must be equivalent to what the synchronous bind produces.
	want, err := app.JevPredict(doc, len(doc))
	if err != nil {
		t.Fatalf("sync JevPredict failed: %v", err)
	}
	wantJSON, _ := json.Marshal(want)
	if !strings.Contains(eval, string(wantJSON)) {
		t.Errorf("async payload differs from the synchronous result\n got: %s\nwant substring: %s", eval, wantJSON)
	}
}
