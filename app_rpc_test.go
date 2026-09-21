package main

import (
	"encoding/json"
	"regexp"
	"strconv"
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

func TestApp_ReportRPCResult_DuplicateDoesNotBlock(t *testing.T) {
	app := &App{}

	reqID := "dup-req-1"
	ch := make(chan *rpcResult, 1)
	rpcCallbacks.Store(reqID, ch)
	defer rpcCallbacks.Delete(reqID)

	// First report fills the cap-1 buffered channel.
	done := make(chan struct{})
	go func() {
		_, _ = app.ReportRPCResult(reqID, `{"ok":true}`, "")
		done <- struct{}{}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("first ReportRPCResult call did not return promptly")
	}

	// Second (duplicate) report for the same reqID must not block forever, since nothing
	// is draining the channel yet (simulating a duplicate/late report on the UI thread).
	done2 := make(chan struct{})
	go func() {
		ok, err := app.ReportRPCResult(reqID, `{"ok":true}`, "")
		if err != nil || !ok {
			t.Errorf("duplicate ReportRPCResult returned unexpected result: ok=%v err=%v", ok, err)
		}
		done2 <- struct{}{}
	}()
	select {
	case <-done2:
	case <-time.After(2 * time.Second):
		t.Fatal("duplicate ReportRPCResult call blocked (deadlock) instead of returning promptly")
	}
}

// selectionMockWebView is a minimal fake of the webview used by App.CallJSWithResponse, tailored
// to the getSelection/replaceSelection JS contract that buffer.get_selection and
// buffer.replace_selection rely on (see window.__mdMemoRPC in frontend/js/app.js).
type selectionMockWebView struct {
	app *App

	text         string
	start        int
	end          int
	hasSelection bool

	// selectionMoved simulates the user moving the caret between the CLI's read and its write,
	// which must make the JS side's atomicity re-check fail (replaced:false).
	selectionMoved bool
}

func (m *selectionMockWebView) Dispatch(f func()) {
	go f()
}

var replaceSelectionCallRE = regexp.MustCompile(`replaceSelection\((".*?"), "([^"]*)", (-?\d+), (-?\d+)\)`)

func (m *selectionMockWebView) Eval(js string) {
	codeStr := js
	codeIdx := strings.Index(js, "const code = ")
	if codeIdx != -1 {
		rest := js[codeIdx+13:]
		if endIdx := strings.Index(rest, ";\n"); endIdx != -1 {
			var unquoted string
			if err := json.Unmarshal([]byte(rest[:endIdx]), &unquoted); err == nil {
				codeStr = unquoted
			}
		}
	}

	reqID := extractReqID(js)

	switch {
	case strings.Contains(codeStr, "replaceSelection"):
		match := replaceSelectionCallRE.FindStringSubmatch(codeStr)
		if match == nil {
			_, _ = m.app.ReportRPCResult(reqID, "", "mock: could not parse replaceSelection call")
			return
		}
		var newText string
		_ = json.Unmarshal([]byte(match[1]), &newText)
		expStart, _ := strconv.Atoi(match[3])
		expEnd, _ := strconv.Atoi(match[4])

		replaced := m.hasSelection && !m.selectionMoved && expStart == m.start && expEnd == m.end
		result := map[string]interface{}{"replaced": replaced}
		if replaced {
			newEnd := m.start + len(newText)
			result["start"] = m.start
			result["end"] = newEnd
			m.end = newEnd
			m.text = newText
		} else {
			result["reason"] = "selection changed"
		}
		data, _ := json.Marshal(result)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")

	case strings.Contains(codeStr, "getSelection"):
		payload := map[string]interface{}{
			"tabId":        "tab_1",
			"text":         m.text,
			"start":        m.start,
			"end":          m.end,
			"hasSelection": m.hasSelection,
		}
		data, _ := json.Marshal(payload)
		_, _ = m.app.ReportRPCResult(reqID, string(data), "")

	default:
		_, _ = m.app.ReportRPCResult(reqID, "true", "")
	}
}

func TestAppRPCGetSelection_HasSelection(t *testing.T) {
	app := &App{}
	mock := &selectionMockWebView{app: app, text: "hello", start: 2, end: 7, hasSelection: true}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.get_selection"}
	resp := app.DispatchRPCOperation(req)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	sel, ok := resp.Result.(*ipc.SelectionInfo)
	if !ok {
		t.Fatalf("expected *ipc.SelectionInfo, got %T", resp.Result)
	}
	if sel.Text != "hello" || sel.Start != 2 || sel.End != 7 {
		t.Errorf("unexpected selection: %+v", sel)
	}
}

func TestAppRPCGetSelection_NoSelection(t *testing.T) {
	app := &App{}
	mock := &selectionMockWebView{app: app, hasSelection: false}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.get_selection"}
	resp := app.DispatchRPCOperation(req)
	if resp.Error == nil {
		t.Fatal("expected error for no active selection, got nil")
	}
	if resp.Error.Code != ipc.ErrCodeNoSelection {
		t.Errorf("expected ErrCodeNoSelection, got %d: %s", resp.Error.Code, resp.Error.Message)
	}
	if resp.Error.Message != "no active selection" {
		t.Errorf("expected exact message %q, got %q", "no active selection", resp.Error.Message)
	}
}

func TestAppRPCGetSelection_CollapsedRangeTreatedAsNoSelection(t *testing.T) {
	app := &App{}
	// hasSelection true but start == end (a bare caret) must still count as "no selection".
	mock := &selectionMockWebView{app: app, hasSelection: true, start: 4, end: 4}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.get_selection"}
	resp := app.DispatchRPCOperation(req)
	if resp.Error == nil || resp.Error.Code != ipc.ErrCodeNoSelection {
		t.Fatalf("expected ErrCodeNoSelection for collapsed range, got %+v", resp.Error)
	}
}

func TestAppRPCReplaceSelection_HappyPath(t *testing.T) {
	app := &App{}
	mock := &selectionMockWebView{app: app, text: "world", start: 6, end: 11, hasSelection: true}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	genBefore := atomic.LoadUint64(&globalBufferGen)

	params := ipc.ReplaceSelectionParams{Content: "there"}
	pData, _ := json.Marshal(params)
	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.replace_selection", Params: pData}
	resp := app.DispatchRPCOperation(req)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	res, ok := resp.Result.(*ipc.ReplaceSelectionResult)
	if !ok {
		t.Fatalf("expected *ipc.ReplaceSelectionResult, got %T", resp.Result)
	}
	if !res.Success {
		t.Error("expected Success=true")
	}
	if res.Start != 6 || res.End != 11 {
		t.Errorf("unexpected result bounds: %+v", res)
	}
	genAfter := atomic.LoadUint64(&globalBufferGen)
	if genAfter != genBefore+1 {
		t.Errorf("expected generation to bump by 1, got %d -> %d", genBefore, genAfter)
	}
}

func TestAppRPCReplaceSelection_NoSelection(t *testing.T) {
	app := &App{}
	mock := &selectionMockWebView{app: app, hasSelection: false}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	params := ipc.ReplaceSelectionParams{Content: "text"}
	pData, _ := json.Marshal(params)
	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.replace_selection", Params: pData}
	resp := app.DispatchRPCOperation(req)
	if resp.Error == nil || resp.Error.Code != ipc.ErrCodeNoSelection {
		t.Fatalf("expected ErrCodeNoSelection, got %+v", resp.Error)
	}
}

func TestAppRPCReplaceSelection_ConflictWhenSelectionMoved(t *testing.T) {
	app := &App{}
	mock := &selectionMockWebView{app: app, text: "world", start: 6, end: 11, hasSelection: true, selectionMoved: true}
	app.w = mock
	atomic.StoreInt32(&app.isDestroyed, 0)

	params := ipc.ReplaceSelectionParams{Content: "there"}
	pData, _ := json.Marshal(params)
	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "buffer.replace_selection", Params: pData}
	resp := app.DispatchRPCOperation(req)
	if resp.Error == nil {
		t.Fatal("expected conflict error when selection moved, got nil")
	}
	if resp.Error.Code != ipc.ErrCodeConflict {
		t.Errorf("expected ErrCodeConflict, got %d: %s", resp.Error.Code, resp.Error.Message)
	}
}

func TestApp_GetAppVersion(t *testing.T) {
	app := &App{}
	v := app.GetAppVersion()
	if v == "" {
		t.Fatal("expected non-empty AppVersion")
	}
	if v != "1.6.0" {
		t.Errorf("expected AppVersion 1.6.0, got %s", v)
	}
}
