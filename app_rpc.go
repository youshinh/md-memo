package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/ipc"
)

type rpcResult struct {
	Data string
	Err  string
}

var (
	globalBufferGen uint64 = 1
	rpcCallbacks    sync.Map // reqID (string) -> chan *rpcResult
)

// ReportRPCResult is bound to window.backend_reportRPCResult for JS -> Go RPC response resolution.
func (a *App) ReportRPCResult(reqID, resultJSON, errorStr string) (bool, error) {
	defer func() {
		_ = recover()
	}()
	if val, ok := rpcCallbacks.Load(reqID); ok {
		if ch, ok := val.(chan *rpcResult); ok {
			// Non-blocking send: this runs inline on the UI thread (bound functions execute
			// synchronously on the WebView message loop). If the channel's single buffer slot
			// is already full (e.g. a duplicate/late report for a reqID already resolved or
			// abandoned), a blocking send here would freeze the UI thread forever. Drop instead.
			select {
			case ch <- &rpcResult{
				Data: resultJSON,
				Err:  errorStr,
			}:
			default:
			}
		}
	}
	return true, nil
}

// CallJSWithResponse evaluates a JS expression in WebView and blocks until it resolves with a JSON result.
func (a *App) CallJSWithResponse(ctx context.Context, jsExpr string) (string, error) {
	if a.w == nil || atomic.LoadInt32(&a.isDestroyed) != 0 {
		return "", errors.New("webview is not running")
	}

	reqID := fmt.Sprintf("req_%d", time.Now().UnixNano())
	ch := make(chan *rpcResult, 1)
	rpcCallbacks.Store(reqID, ch)
	defer rpcCallbacks.Delete(reqID)

	exprJSON, _ := json.Marshal(jsExpr)
	template := `(async () => {
		try {
			const fn = async () => {
				const code = {{EXPR_JSON}};
				try {
					return eval(code);
				} catch (_) {
					return (new Function(code))();
				}
			};
			const res = await Promise.resolve(fn());
			if (window.backend_reportRPCResult) {
				window.backend_reportRPCResult("{{REQ_ID}}", JSON.stringify(res === undefined ? null : res), "");
			}
		} catch (e) {
			if (window.backend_reportRPCResult) {
				window.backend_reportRPCResult("{{REQ_ID}}", "", String(e && e.message ? e.message : e));
			}
		}
	})();`
	wrappedJS := strings.Replace(template, "{{EXPR_JSON}}", string(exprJSON), 1)
	wrappedJS = strings.ReplaceAll(wrappedJS, "{{REQ_ID}}", reqID)

	a.dispatchEval(wrappedJS)

	select {
	case res := <-ch:
		if res.Err != "" {
			return "", errors.New(res.Err)
		}
		return res.Data, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func computeHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:8]) // 16-char hex prefix
}

// DispatchRPCOperation executes a JSON-RPC 2.0 request against the App state.
func (a *App) DispatchRPCOperation(req *ipc.RPCRequest) (resp *ipc.RPCResponse) {
	defer func() {
		if r := recover(); r != nil {
			resp = errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("panic in RPC: %v", r))
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch req.Method {
	case "buffer.get":
		tabID, bad := tabIDParam(req)
		if bad != nil {
			return bad
		}

		// An unknown tab id is an error (-32002), not an empty buffer: the page throws for it.
		resJSON, err := a.callRPCJS(ctx, "getBuffer", tabID)
		if err != nil {
			return jsErrorResponse(req.ID, err, "failed to get buffer")
		}

		var raw struct {
			TabID      string `json:"tabId"`
			Title      string `json:"title"`
			Path       string `json:"path"`
			Content    string `json:"content"`
			Length     int    `json:"length"`
			LineCount  int    `json:"lineCount"`
			IsActive   bool   `json:"isActive"`
			IsModified bool   `json:"isModified"`
		}
		if err := json.Unmarshal([]byte(resJSON), &raw); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid buffer response: %v", err))
		}

		bufInfo := &ipc.BufferInfo{
			TabID:      raw.TabID,
			Title:      raw.Title,
			FilePath:   raw.Path,
			Content:    raw.Content,
			Hash:       computeHash(raw.Content),
			Generation: atomic.LoadUint64(&globalBufferGen),
			Length:     raw.Length,
			LineCount:  raw.LineCount,
			IsActive:   raw.IsActive,
			IsModified: raw.IsModified,
		}
		return successResponse(req.ID, bufInfo)

	case "buffer.set":
		var params ipc.BufferSetParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid buffer.set params: %v", err))
		}
		res, errResp := a.rpcWriteBuffer(ctx, req.ID, rpcWrite{
			TabID: params.TabID, Mode: "set", Content: params.Content,
			ExpectedHash: params.ExpectedHash, ExpectedGeneration: params.ExpectedGeneration,
		})
		if errResp != nil {
			return errResp
		}
		length := len(params.Content)
		res.Length = &length
		return successResponse(req.ID, res)

	case "buffer.append":
		var params ipc.BufferAppendParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid buffer.append params: %v", err))
		}
		res, errResp := a.rpcWriteBuffer(ctx, req.ID, rpcWrite{TabID: params.TabID, Mode: "append", Content: params.Content})
		if errResp != nil {
			return errResp
		}
		return successResponse(req.ID, res)

	case "buffer.replace":
		var params ipc.BufferReplaceParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid buffer.replace params: %v", err))
		}
		res, errResp := a.rpcWriteBuffer(ctx, req.ID, rpcWrite{
			TabID: params.TabID, Mode: "replace", Content: params.Content,
			StartLine: params.StartLine, StartCol: params.StartCol, EndLine: params.EndLine, EndCol: params.EndCol,
			ExpectedHash: params.ExpectedHash, ExpectedGeneration: params.ExpectedGeneration,
		})
		if errResp != nil {
			return errResp
		}
		return successResponse(req.ID, res)

	case "buffer.save":
		return a.rpcBufferSave(ctx, req)

	case "buffer.get_selection":
		tabID, bad := tabIDParam(req)
		if bad != nil {
			return bad
		}

		resJSON, err := a.CallJSWithResponse(ctx, rpcCallExpr("getSelection", tabID))
		if err != nil {
			return jsErrorResponse(req.ID, err, "failed to get selection")
		}

		var raw struct {
			TabID        string `json:"tabId"`
			Text         string `json:"text"`
			Start        int    `json:"start"`
			End          int    `json:"end"`
			HasSelection bool   `json:"hasSelection"`
		}
		if err := json.Unmarshal([]byte(resJSON), &raw); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid selection response: %v", err))
		}
		if !raw.HasSelection || raw.Start == raw.End {
			return noSelectionResponse(req.ID)
		}
		return successResponse(req.ID, &ipc.SelectionInfo{
			TabID: raw.TabID,
			Text:  raw.Text,
			Start: raw.Start,
			End:   raw.End,
		})

	case "buffer.replace_selection":
		var params ipc.ReplaceSelectionParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid buffer.replace_selection params")
		}

		// One write at a time, so the generation counter means "RPC writes so far" (rpcWriteMu).
		rpcWriteMu.Lock()
		defer rpcWriteMu.Unlock()

		// Re-read the selection right before writing so the replace call below can pass its
		// exact bounds; JS re-checks those bounds still hold to keep the read-then-write atomic
		// even though the user's caret can move between our two round trips.
		curJSON, err := a.CallJSWithResponse(ctx, rpcCallExpr("getSelection", params.TabID))
		if err != nil {
			return jsErrorResponse(req.ID, err, "failed to read selection")
		}
		var cur struct {
			TabID        string `json:"tabId"`
			Start        int    `json:"start"`
			End          int    `json:"end"`
			HasSelection bool   `json:"hasSelection"`
		}
		_ = json.Unmarshal([]byte(curJSON), &cur)
		if !cur.HasSelection || cur.Start == cur.End {
			return noSelectionResponse(req.ID)
		}

		resJSON, err := a.CallJSWithResponse(ctx, rpcCallExpr("replaceSelection", params.Content, cur.TabID, cur.Start, cur.End))
		if err != nil {
			return jsErrorResponse(req.ID, err, "failed to replace selection")
		}

		var res struct {
			Replaced bool   `json:"replaced"`
			Start    int    `json:"start"`
			End      int    `json:"end"`
			Reason   string `json:"reason"`
		}
		if err := json.Unmarshal([]byte(resJSON), &res); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid replaceSelection response: %v", err))
		}
		if !res.Replaced {
			msg := "selection changed before replace could be applied"
			if res.Reason != "" {
				msg = res.Reason
			}
			return &ipc.RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: &ipc.RPCError{
					Code:    ipc.ErrCodeConflict,
					Message: msg,
				},
			}
		}

		newGen := atomic.AddUint64(&globalBufferGen, 1)
		return successResponse(req.ID, &ipc.ReplaceSelectionResult{
			Success:    true,
			Generation: newGen,
			Start:      res.Start,
			End:        res.End,
		})

	case "tab.list":
		jsCall := "window.__mdMemoRPC && window.__mdMemoRPC.getTabs()"
		resJSON, err := a.CallJSWithResponse(ctx, jsCall)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to list tabs: %v", err))
		}

		var tabs []map[string]interface{}
		_ = json.Unmarshal([]byte(resJSON), &tabs)
		return successResponse(req.ID, tabs)

	case "tab.switch":
		tabID, bad := tabIDParam(req)
		if bad != nil {
			return bad
		}
		if tabID == "" {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "tab_id is required")
		}
		// An unknown id is -32002 (the page checks it before touching anything).
		if _, err := a.CallJSWithResponse(ctx, rpcCallExpr("switchTab", tabID)); err != nil {
			return jsErrorResponse(req.ID, err, "failed to switch tab")
		}
		return successResponse(req.ID, map[string]bool{"success": true})

	case "tab.new":
		return a.rpcTabNew(ctx, req)

	case "tab.close":
		return a.rpcTabClose(ctx, req)

	case "ui.toggle_split":
		jsCall := "window.__mdMemoRPC && window.__mdMemoRPC.toggleSplit()"
		_, err := a.CallJSWithResponse(ctx, jsCall)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to toggle split: %v", err))
		}
		return successResponse(req.ID, map[string]bool{"success": true})

	case "ui.activate":
		activatePlatformWindow()
		return successResponse(req.ID, map[string]bool{"success": true})

	case "ui.eval":
		var params struct {
			Expression string `json:"expression"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid expression")
		}
		resJSON, err := a.CallJSWithResponse(ctx, params.Expression)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, err.Error())
		}
		return successResponse(req.ID, resJSON)

	default:
		return errorResponse(req.ID, ipc.ErrCodeMethodNotFound, fmt.Sprintf("method not found: %s", req.Method))
	}
}

func successResponse(id interface{}, result interface{}) *ipc.RPCResponse {
	return &ipc.RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
}

func noSelectionResponse(id interface{}) *ipc.RPCResponse {
	return &ipc.RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &ipc.RPCError{
			Code:    ipc.ErrCodeNoSelection,
			Message: "no active selection",
		},
	}
}

func errorResponse(id interface{}, code int, message string) *ipc.RPCResponse {
	return &ipc.RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &ipc.RPCError{
			Code:    code,
			Message: message,
		},
	}
}
