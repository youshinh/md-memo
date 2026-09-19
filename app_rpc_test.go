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
	// Simple mock that simulates window.__mdMemoRPC evaluation
	if strings.Contains(js, "getBuffer") {
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
		// Extract reqID
		reqID := extractReqID(js)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")
	} else if strings.Contains(js, "setBuffer") {
		// Extract new text passed to setBuffer
		startQuote := strings.Index(js, `setBuffer("`)
		if startQuote != -1 {
			sub := js[startQuote+10:] // starts with "
			// Find closing quote before closing paren
			endQuote := strings.Index(sub, `")`)
			if endQuote != -1 {
				var newText string
				_ = json.Unmarshal([]byte(sub[:endQuote+1]), &newText)
				m.jsBuffer = newText
			}
		}
		reqID := extractReqID(js)
		_, _ = m.app.ReportRPCResult(reqID, "true", "")
	} else if strings.Contains(js, "getTabs") {
		tabs := []map[string]interface{}{
			{"id": "tab_1", "title": "TestDoc.md", "isActive": true},
		}
		data, _ := json.Marshal(tabs)
		reqID := extractReqID(js)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")
	} else {
		reqID := extractReqID(js)
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
