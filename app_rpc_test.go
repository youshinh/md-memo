package main

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"md-memo/pkg/ipc"
)

type rpcMockWebView struct {
	app      *App
	jsBuffer string
}

func (m *rpcMockWebView) Dispatch(f func()) {
	go f()
}

func (m *rpcMockWebView) Eval(js string) {
	// Extract the evaluated code from `const code = "..."`
	codeStr := js
	codeIdx := strings.Index(js, "const code = ")
	if codeIdx != -1 {
		rest := js[codeIdx+13:]
		// find closing semicolon or newline
		endIdx := strings.Index(rest, ";\n")
		if endIdx != -1 {
			var unquoted string
			if err := json.Unmarshal([]byte(rest[:endIdx]), &unquoted); err == nil {
				codeStr = unquoted
			}
		}
	}

	reqID := extractReqID(js)

	// Simple mock that simulates window.__mdMemoRPC evaluation
	if strings.Contains(codeStr, "getBuffer") {
		payload := map[string]interface{}{
			"tabId":      "tab_1",
			"title":      "TestDoc.md",
			"path":       "/tmp/TestDoc.md",
			"content":    m.jsBuffer,
			"length":     len(m.jsBuffer),
			"lineCount":  len(strings.Split(m.jsBuffer, "\n")),
			"isActive":   true,
			"isModified": false,
		}
		data, _ := json.Marshal(payload)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")
	} else if strings.Contains(codeStr, "setBuffer") {
		// Extract new text passed to setBuffer
		startQuote := strings.Index(codeStr, `setBuffer("`)
		if startQuote != -1 {
			sub := codeStr[startQuote+10:]
			endQuote := strings.Index(sub, `")`)
			if endQuote != -1 {
				var newText string
				_ = json.Unmarshal([]byte(sub[:endQuote+1]), &newText)
				m.jsBuffer = newText
			}
		}
		_, _ = m.app.ReportRPCResult(reqID, "true", "")
	} else if strings.Contains(codeStr, "getTabs") {
		tabs := []map[string]interface{}{
			{"id": "tab_1", "title": "TestDoc.md", "isActive": true},
		}
		data, _ := json.Marshal(tabs)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")
	} else {
		_, _ = m.app.ReportRPCResult(reqID, "true", "")
	}
}

func extractReqID(js string) string {
	idx := strings.Index(js, `window.backend_reportRPCResult("`)
	if idx == -1 {
		return ""
	}
	sub := js[idx+32:]
	end := strings.Index(sub, `"`)
	if end == -1 {
		return ""
	}
	return sub[:end]
}

func TestAppRPCBufferOperationsAndOptimisticLock(t *testing.T) {
	app := &App{}
	mock := &rpcMockWebView{
		app:      app,
		jsBuffer: "# Initial Buffer\n- [ ] Task A\n",
	}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	// 1. buffer.get
	reqGet := &ipc.RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "buffer.get",
	}
	respGet := app.DispatchRPCOperation(reqGet)
	if respGet.Error != nil {
		t.Fatalf("buffer.get failed: %v", respGet.Error)
	}
	bufInfo, ok := respGet.Result.(*ipc.BufferInfo)
	if !ok {
		t.Fatalf("expected *ipc.BufferInfo, got %T", respGet.Result)
	}
	if bufInfo.Content != mock.jsBuffer {
		t.Errorf("content mismatch: got %q, want %q", bufInfo.Content, mock.jsBuffer)
	}
	initialHash := bufInfo.Hash
	if initialHash == "" {
		t.Fatal("expected non-empty hash")
	}

	// 2. buffer.set with correct expected_hash
	newContent := "# Updated Buffer\n- [x] Task A Done\n"
	paramsSet := ipc.BufferSetParams{
		Content:      newContent,
		ExpectedHash: initialHash,
	}
	pData, _ := json.Marshal(paramsSet)
	reqSet := &ipc.RPCRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "buffer.set",
		Params:  pData,
	}
	respSet := app.DispatchRPCOperation(reqSet)
	if respSet.Error != nil {
		t.Fatalf("buffer.set with valid expected_hash failed: %v", respSet.Error)
	}
	if mock.jsBuffer != newContent {
		t.Errorf("expected jsBuffer to update to %q, got %q", newContent, mock.jsBuffer)
	}

	// 3. buffer.set with mismatched expected_hash (Optimistic Lock conflict)
	staleParams := ipc.BufferSetParams{
		Content:      "# Conflicting Edit\n",
		ExpectedHash: "wrong-hash-123456",
	}
	pStale, _ := json.Marshal(staleParams)
	reqConflict := &ipc.RPCRequest{
		JSONRPC: "2.0",
		ID:      3,
		Method:  "buffer.set",
		Params:  pStale,
	}
	respConflict := app.DispatchRPCOperation(reqConflict)
	if respConflict.Error == nil {
		t.Fatal("expected conflict error for wrong hash, got nil")
	}
	if respConflict.Error.Code != ipc.ErrCodeConflict {
		t.Errorf("expected ErrCodeConflict (-32001), got %d: %s", respConflict.Error.Code, respConflict.Error.Message)
	}

	// 4. tab.list
	reqTabs := &ipc.RPCRequest{
		JSONRPC: "2.0",
		ID:      4,
		Method:  "tab.list",
	}
	respTabs := app.DispatchRPCOperation(reqTabs)
	if respTabs.Error != nil {
		t.Fatalf("tab.list failed: %v", respTabs.Error)
	}

	time.Sleep(10 * time.Millisecond)
}
