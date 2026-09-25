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
	if v != "1.9.0" {
		t.Errorf("expected AppVersion 1.9.0, got %s", v)
	}
}
