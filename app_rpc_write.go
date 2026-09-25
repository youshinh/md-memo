package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"md-memo/pkg/encoding"
	"md-memo/pkg/ipc"
	"md-memo/pkg/notesave"
)

// The RPC methods that change a note or a tab (buffer.set / append / replace / replace_selection /
// save, tab.new / close). app_rpc.go routes them here; the work inside the page is
// window.__mdMemoRPC in frontend/js/app.js.

// rpcWriteMu makes the write methods run one at a time. That keeps globalBufferGen (the number of RPC
// writes so far) exact when two clients write together, and makes "check expected_generation, then
// write" one step. It is held while waiting for the page, at most the 5 s of the request.
var rpcWriteMu sync.Mutex

// errPageNotReady is returned when the page has not defined window.__mdMemoRPC yet (start-up) or
// answered nothing.
var errPageNotReady = errors.New("the editor page is not ready (window.__mdMemoRPC is not available yet)")

// Every call into the page goes through this wrapper. CallJSWithResponse evaluates an expression
// with eval and, if that THROWS, runs the same code again as a function body (so that `ui.eval` can
// take a statement): a write that threw half way through would then be applied twice (a second
// append). An async arrow function never throws to its caller, it returns a rejected promise, which
// CallJSWithResponse reports as the error without a second run.
const (
	rpcCallPrefix = "(async () => window.__mdMemoRPC && window.__mdMemoRPC."
	rpcCallSuffix = ")()"
)

// rpcCallExpr builds the JS that calls window.__mdMemoRPC.<fn>(args...). Every argument is passed
// as JSON, so text with quotes, backslashes, line breaks or characters outside the BMP cannot break
// out of the expression.
func rpcCallExpr(fn string, args ...interface{}) string {
	parts := make([]string, len(args))
	for i, a := range args {
		b, err := json.Marshal(a)
		if err != nil {
			b = []byte("null")
		}
		parts[i] = string(b)
	}
	return rpcCallPrefix + fn + "(" + strings.Join(parts, ", ") + ")" + rpcCallSuffix
}

// callRPCJS runs one window.__mdMemoRPC function in the page and returns the JSON of its result.
// A page that has no such object yet, or a function that returned nothing, is errPageNotReady.
func (a *App) callRPCJS(ctx context.Context, fn string, args ...interface{}) (string, error) {
	res, err := a.CallJSWithResponse(ctx, rpcCallExpr(fn, args...))
	if err != nil {
		return "", err
	}
	if res == "" || res == "null" {
		return "", errPageNotReady
	}
	return res, nil
}

// jsErrPrefix is how the page marks an error the caller should see as a JSON-RPC error of its own:
// "[not_found] no such tab: x" (see rpcFail in app.js). Anything without the prefix is a failure
// inside the app (-32603).
var jsErrPrefix = regexp.MustCompile(`^\[(not_found|conflict|invalid_params)\] `)

var jsErrCodes = map[string]int{
	"not_found":      ipc.ErrCodeNotFound,
	"conflict":       ipc.ErrCodeConflict,
	"invalid_params": ipc.ErrCodeInvalidParams,
}

// jsErrorResponse turns an error from the page into the RPC error: the coded ones keep their code and
// their message (without the marker), everything else is -32603 "<what>: <error>".
func jsErrorResponse(id interface{}, err error, what string) *ipc.RPCResponse {
	msg := err.Error()
	if m := jsErrPrefix.FindStringSubmatch(msg); m != nil {
		return errorResponse(id, jsErrCodes[m[1]], strings.TrimPrefix(msg, m[0]))
	}
	return errorResponse(id, ipc.ErrCodeInternalError, fmt.Sprintf("%s: %v", what, err))
}

// tabIDParam reads the optional {"tab_id": "..."} of buffer.get, buffer.get_selection and tab.switch.
// Params that are not an object with a string tab_id are -32602 (a number there used to be read as "no
// tab" and quietly acted on the active tab).
func tabIDParam(req *ipc.RPCRequest) (string, *ipc.RPCResponse) {
	var params struct {
		TabID string `json:"tab_id"`
	}
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return "", errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid %s params: %v", req.Method, err))
		}
	}
	return params.TabID, nil
}

// rpcWrite is one text write: mode "set" (the whole note), "append" or "replace" (a 1-based
// line/column range).
type rpcWrite struct {
	TabID                                string
	Mode                                 string
	Content                              string
	StartLine, StartCol, EndLine, EndCol int
	ExpectedHash                         string
	ExpectedGeneration                   uint64
}

// rpcWriteBuffer performs the write in the page in ONE call: the page checks expected_hash and
// expected_generation against the live text and writes, with nothing able to happen between the
// check and the write. The tab is never made the active one.
func (a *App) rpcWriteBuffer(ctx context.Context, id interface{}, w rpcWrite) (*ipc.BufferWriteResult, *ipc.RPCResponse) {
	rpcWriteMu.Lock()
	defer rpcWriteMu.Unlock()

	jsReq := map[string]interface{}{
		"tabId":              w.TabID,
		"mode":               w.Mode,
		"content":            w.Content,
		"expectedHash":       w.ExpectedHash,
		"expectedGeneration": w.ExpectedGeneration,
		"currentGeneration":  atomic.LoadUint64(&globalBufferGen),
	}
	if w.Mode == "replace" {
		jsReq["range"] = map[string]int{
			"startLine": w.StartLine, "startCol": w.StartCol, "endLine": w.EndLine, "endCol": w.EndCol,
		}
	}
	resJSON, err := a.callRPCJS(ctx, "writeText", jsReq)
	if err != nil {
		return nil, jsErrorResponse(id, err, "failed to write buffer")
	}
	var out struct {
		TabID        string `json:"tab_id"`
		Hash         string `json:"hash"`
		PreviousHash string `json:"previous_hash"`
	}
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return nil, errorResponse(id, ipc.ErrCodeInternalError, fmt.Sprintf("invalid write response: %v", err))
	}
	gen := atomic.AddUint64(&globalBufferGen, 1)
	return &ipc.BufferWriteResult{
		Success:      true,
		TabID:        out.TabID,
		Hash:         out.Hash,
		PreviousHash: out.PreviousHash,
		Generation:   gen,
	}, nil
}

// notSaved is the -32602 / -32603 answer of buffer.save when nothing was written.
func notSaved(id interface{}, code int, reason string) *ipc.RPCResponse {
	return errorResponse(id, code, "not saved: "+reason)
}

// rpcBufferSave writes a tab's text to a file, in two steps with the page so that this side can
// validate and write:
//
//  1. prepareSave (page): the live text, its hash, and what the tab is bound to now;
//  2. validate + write (notesave.Save: path rules, overwrite rule, strict encoding, atomic write);
//  3. commitSave (page): if the text still hashes to what was written, the tab is bound to the file
//     (path, title, encoding, clean, watcher). If the user edited meanwhile it is a conflict and nothing
//     is bound: the file then holds the older text, and the message says so.
//
// It never opens a dialog and never creates a folder. Every failure that leaves the file untouched starts
// with "not saved:".
func (a *App) rpcBufferSave(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params ipc.BufferSaveParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return notSaved(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid buffer.save params: %v", err))
		}
	}
	// A bad encoding name is refused before the page is asked for anything.
	requested, err := encoding.ParseName(params.Encoding)
	if err != nil {
		return notSaved(req.ID, ipc.ErrCodeInvalidParams, err.Error())
	}

	rpcWriteMu.Lock()
	defer rpcWriteMu.Unlock()

	prepJSON, err := a.callRPCJS(ctx, "prepareSave", params.TabID)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to read the note")
	}
	var prep struct {
		TabID    string `json:"tab_id"`
		Content  string `json:"content"`
		Hash     string `json:"hash"`
		Path     string `json:"path"`
		Encoding string `json:"encoding"`
		Title    string `json:"title"`
	}
	if err := json.Unmarshal([]byte(prepJSON), &prep); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid prepareSave response: %v", err))
	}

	target := params.Path
	if target == "" {
		target = prep.Path
	}
	if target == "" {
		return notSaved(req.ID, ipc.ErrCodeInvalidParams, "tab has no file: give --as <path>")
	}

	// utf-8 unless the caller named an encoding; a tab already bound to a file keeps its own.
	enc := requested
	if enc == "" {
		enc = encoding.NameUTF8
		if prep.Path != "" {
			if own, err := encoding.ParseName(prep.Encoding); err == nil && own != "" {
				enc = own
			}
		}
	}

	res, err := notesave.Save(notesave.Request{
		Path:      target,
		Own:       prep.Path,
		Overwrite: params.Overwrite,
		Text:      prep.Content,
		Encoding:  enc,
	})
	if err != nil {
		var refused *notesave.RefusedError
		var unrep *encoding.UnrepresentableError
		switch {
		case errors.As(err, &refused):
			return notSaved(req.ID, ipc.ErrCodeInvalidParams, err.Error())
		case errors.As(err, &unrep):
			return notSaved(req.ID, ipc.ErrCodeInvalidParams, err.Error()+" (save as utf-8, or remove the character)")
		default:
			return notSaved(req.ID, ipc.ErrCodeInternalError, err.Error())
		}
	}

	// The file changed: a scrap folder that is git-synced must notice, as after the GUI's own save.
	a.TriggerGitSync()

	commit := map[string]interface{}{
		"path":     res.Path,
		"encoding": res.Encoding,
		"hash":     prep.Hash,
		"bytes":    res.Bytes,
	}
	if _, err := a.callRPCJS(ctx, "commitSave", prep.TabID, commit); err != nil {
		resp := jsErrorResponse(req.ID, err, "the file was written but the tab could not be bound to it")
		if resp.Error != nil && resp.Error.Code == ipc.ErrCodeConflict {
			resp.Error.Message = "the file was written but the tab was not bound to it: " + resp.Error.Message
		}
		return resp
	}

	return successResponse(req.ID, &ipc.BufferSaveResult{
		TabID:    prep.TabID,
		Path:     res.Path,
		Bytes:    res.Bytes,
		Hash:     computeHash(prep.Content),
		Encoding: res.Encoding,
		Created:  res.Created,
	})
}

// rpcTabNew opens a tab. With a path the file is read and decoded here (the same reader the
// double-click path uses) and handed to the page, which opens no second tab for a file that is
// already open.
func (a *App) rpcTabNew(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params ipc.TabNewParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid tab.new params: %v", err))
		}
	}
	if params.Path != "" && params.Content != nil {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "give path or content, not both")
	}

	spec := map[string]interface{}{"background": params.Background}
	if params.Title != "" {
		spec["title"] = params.Title
	}
	switch {
	case params.Path != "":
		clean, err := notesave.CleanPath(params.Path)
		if err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, err.Error())
		}
		file, err := readNoteFile(clean)
		if err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				return errorResponse(req.ID, ipc.ErrCodeNotFound, fmt.Sprintf("no such file: %q", clean))
			case errors.Is(err, errIsDirectory):
				return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("%q is a folder, not a file", clean))
			}
			return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("cannot read %q: %v", clean, err))
		}
		spec["path"] = file.Path
		spec["content"] = file.Content
		spec["encoding"] = file.Encoding
		if params.Title == "" {
			spec["title"] = file.Title
		}
	case params.Content != nil:
		spec["content"] = *params.Content
	}

	resJSON, err := a.callRPCJS(ctx, "openTab", spec)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to open tab")
	}
	var out ipc.TabNewResult
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid openTab response: %v", err))
	}
	return successResponse(req.ID, &out)
}

// rpcTabClose closes a tab without ever waiting for a dialog (the CLI waits 3 s, the app 5 s). A
// clean tab closes; a tab with unsaved changes gets the GUI's own save prompt and the answer is
// closed:false, reason "prompt"; with if_saved the page closes it only when its text equals the
// file's, otherwise closed:false, reason "unsaved". An unknown id is -32002.
func (a *App) rpcTabClose(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params ipc.TabCloseParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid tab.close params: %v", err))
		}
	}
	if params.TabID == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "tab_id is required")
	}
	resJSON, err := a.callRPCJS(ctx, "closeTabChecked", params.TabID, params.IfSaved)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to close tab")
	}
	var out ipc.TabCloseResult
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid closeTabChecked response: %v", err))
	}
	return successResponse(req.ID, &out)
}
