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
			ch <- &rpcResult{
				Data: resultJSON,
				Err:  errorStr,
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

	template := `(async () => {
		try {
			const fn = () => ({{EXPR}});
			const res = await Promise.resolve(fn());
			if (window.backend_reportRPCResult) {
				window.backend_reportRPCResult("{{REQ_ID}}", JSON.stringify(res), "");
			}
		} catch (e) {
			if (window.backend_reportRPCResult) {
				window.backend_reportRPCResult("{{REQ_ID}}", "", String(e && e.message ? e.message : e));
			}
		}
	})();`
	wrappedJS := strings.Replace(template, "{{EXPR}}", jsExpr, 1)
	wrappedJS = strings.ReplaceAll(wrappedJS, "{{REQ_ID}}", reqID)

	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			a.w.Eval(wrappedJS)
		}
	})

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
		var params struct {
			TabID string `json:"tab_id,omitempty"`
		}
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &params)
		}

		jsCall := fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.getBuffer(%q)", params.TabID)
		resJSON, err := a.CallJSWithResponse(ctx, jsCall)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to get buffer: %v", err))
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
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid buffer.set params")
		}

		// Optimistic lock verification
		if params.ExpectedHash != "" || params.ExpectedGeneration > 0 {
			// Fetch current buffer state
			jsCall := "window.__mdMemoRPC && window.__mdMemoRPC.getBuffer()"
			curJSON, err := a.CallJSWithResponse(ctx, jsCall)
			if err == nil {
				var cur struct {
					Content string `json:"content"`
				}
				_ = json.Unmarshal([]byte(curJSON), &cur)
				curHash := computeHash(cur.Content)
				curGen := atomic.LoadUint64(&globalBufferGen)

				if params.ExpectedHash != "" && params.ExpectedHash != curHash {
					return &ipc.RPCResponse{
						JSONRPC: "2.0",
						ID:      req.ID,
						Error: &ipc.RPCError{
							Code:    ipc.ErrCodeConflict,
							Message: fmt.Sprintf("conflict: expected hash %s but buffer is at %s", params.ExpectedHash, curHash),
						},
					}
				}
				if params.ExpectedGeneration > 0 && params.ExpectedGeneration != curGen {
					return &ipc.RPCResponse{
						JSONRPC: "2.0",
						ID:      req.ID,
						Error: &ipc.RPCError{
							Code:    ipc.ErrCodeConflict,
							Message: fmt.Sprintf("conflict: expected generation %d but buffer is at %d", params.ExpectedGeneration, curGen),
						},
					}
				}
			}
		}

		// Update buffer in WebView with Undo preservation
		encodedText, _ := json.Marshal(params.Content)
		jsSet := fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.setBuffer(%s)", string(encodedText))
		_, err := a.CallJSWithResponse(ctx, jsSet)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to set buffer: %v", err))
		}

		newGen := atomic.AddUint64(&globalBufferGen, 1)
		newHash := computeHash(params.Content)

		return successResponse(req.ID, map[string]interface{}{
			"success":    true,
			"hash":       newHash,
			"generation": newGen,
			"length":     len(params.Content),
		})

	case "buffer.append":
		var params struct {
			Content string `json:"content"`
			TabID   string `json:"tab_id,omitempty"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid buffer.append params")
		}

		encodedText, _ := json.Marshal(params.Content)
		jsAppend := fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.appendBuffer(%s)", string(encodedText))
		_, err := a.CallJSWithResponse(ctx, jsAppend)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to append buffer: %v", err))
		}

		atomic.AddUint64(&globalBufferGen, 1)
		return successResponse(req.ID, map[string]interface{}{
			"success": true,
		})

	case "buffer.replace":
		var params ipc.BufferReplaceParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid buffer.replace params")
		}

		// Optimistic lock check
		if params.ExpectedHash != "" {
			jsCall := "window.__mdMemoRPC && window.__mdMemoRPC.getBuffer()"
			curJSON, err := a.CallJSWithResponse(ctx, jsCall)
			if err == nil {
				var cur struct {
					Content string `json:"content"`
				}
				_ = json.Unmarshal([]byte(curJSON), &cur)
				curHash := computeHash(cur.Content)
				if params.ExpectedHash != curHash {
					return &ipc.RPCResponse{
						JSONRPC: "2.0",
						ID:      req.ID,
						Error: &ipc.RPCError{
							Code:    ipc.ErrCodeConflict,
							Message: fmt.Sprintf("conflict: expected hash %s but buffer is at %s", params.ExpectedHash, curHash),
						},
					}
				}
			}
		}

		encodedText, _ := json.Marshal(params.Content)
		jsReplace := fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.replaceRange(%d, %d, %d, %d, %s)",
			params.StartLine, params.StartCol, params.EndLine, params.EndCol, string(encodedText))
		_, err := a.CallJSWithResponse(ctx, jsReplace)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to replace buffer range: %v", err))
		}

		newGen := atomic.AddUint64(&globalBufferGen, 1)
		return successResponse(req.ID, map[string]interface{}{
			"success":    true,
			"generation": newGen,
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
		var params struct {
			TabID string `json:"tab_id"`
		}
		_ = json.Unmarshal(req.Params, &params)
		jsCall := fmt.Sprintf("window.__mdMemoRPC && window.__mdMemoRPC.switchTab(%q)", params.TabID)
		_, err := a.CallJSWithResponse(ctx, jsCall)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("failed to switch tab: %v", err))
		}
		return successResponse(req.ID, map[string]bool{"success": true})

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
