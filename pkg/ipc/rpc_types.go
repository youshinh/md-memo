package ipc

import (
	"encoding/json"
	"time"
)

// Standard JSON-RPC 2.0 error codes
const (
	ErrCodeParseError     = -32700
	ErrCodeInvalidRequest = -32600
	ErrCodeMethodNotFound = -32601
	ErrCodeInvalidParams  = -32602
	ErrCodeInternalError  = -32603

	// Application-specific error codes
	ErrCodeUnauthorized = -32000
	ErrCodeConflict     = -32001
	ErrCodeNotFound     = -32002
	ErrCodeNoSelection  = -32003
)

// RPCRequest represents a standard JSON-RPC 2.0 request payload.
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"` // number, string, or nil for notifications
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	Auth    string          `json:"auth,omitempty"` // Session authentication token
}

// RPCResponse represents a standard JSON-RPC 2.0 response payload.
type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id,omitempty"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
}

// RPCError represents a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return e.Message
}

// SessionInfo contains connection metadata written by the running md-memo instance.
type SessionInfo struct {
	PID       int       `json:"pid"`
	Port      int       `json:"port"`
	Token     string    `json:"token"`
	StartedAt time.Time `json:"started_at"`
}

// BufferInfo describes the state of an editor buffer.
type BufferInfo struct {
	TabID      string `json:"tab_id"` // the id tab.list reports (1.9.0 and older always sent the number 0 here)
	Title      string `json:"title"`
	FilePath   string `json:"file_path,omitempty"`
	Content    string `json:"content"`
	Hash       string `json:"hash"`       // SHA-256 hex (first 16 chars or full)
	Generation uint64 `json:"generation"` // Monotonically increasing revision counter
	Length     int    `json:"length"`
	LineCount  int    `json:"line_count"`
	IsActive   bool   `json:"is_active"`
	IsModified bool   `json:"is_modified"`
}

// BufferSetParams represents parameters for setting or replacing buffer contents.
type BufferSetParams struct {
	TabID              string `json:"tab_id,omitempty"` // an id from tab.list; empty = the active tab of the primary pane
	Content            string `json:"content"`
	ExpectedHash       string `json:"expected_hash,omitempty"`
	ExpectedGeneration uint64 `json:"expected_generation,omitempty"`
}

// BufferAppendParams represents parameters for adding text at the end of a note.
type BufferAppendParams struct {
	TabID   string `json:"tab_id,omitempty"`
	Content string `json:"content"`
}

// BufferReplaceParams represents parameters for replacing a subrange in the buffer.
type BufferReplaceParams struct {
	TabID              string `json:"tab_id,omitempty"` // an id from tab.list; empty = the active tab of the primary pane
	StartLine          int    `json:"start_line"`       // 1-indexed
	StartCol           int    `json:"start_col"`        // 1-indexed
	EndLine            int    `json:"end_line"`         // 1-indexed
	EndCol             int    `json:"end_col"`          // 1-indexed
	Content            string `json:"content"`
	ExpectedHash       string `json:"expected_hash,omitempty"`
	ExpectedGeneration uint64 `json:"expected_generation,omitempty"`
}

// BufferWriteResult is the result of buffer.set, buffer.append and buffer.replace.
type BufferWriteResult struct {
	Success bool   `json:"success"`
	TabID   string `json:"tab_id"` // the tab that was written (the one you named, or the active tab of the primary pane)
	// Hash is the hash of the note now. PreviousHash is the hash of what it was just before: a tab that is
	// not on screen has no undo history, so a caller that wants to undo a write keeps the old text and uses
	// this to check nothing else changed in between.
	Hash         string `json:"hash"`
	PreviousHash string `json:"previous_hash"`
	Generation   uint64 `json:"generation"`
	Length       *int   `json:"length,omitempty"` // buffer.set only: the size of the text that was sent, in UTF-8 bytes
}

// BufferSaveParams represents parameters for writing a note to a file (buffer.save). It never opens a
// dialog and never replaces an existing file unless Overwrite says so (or it is the note's own file).
type BufferSaveParams struct {
	TabID     string `json:"tab_id,omitempty"`   // empty = the active tab of the primary pane
	Path      string `json:"path,omitempty"`     // absolute; empty = the file the tab is already bound to
	Encoding  string `json:"encoding,omitempty"` // utf-8, or sjis / shift_jis / shift-jis / cp932; empty = the tab's own
	Overwrite bool   `json:"overwrite,omitempty"`
}

// BufferSaveResult is the result of buffer.save.
type BufferSaveResult struct {
	TabID    string `json:"tab_id"`
	Path     string `json:"path"`
	Bytes    int    `json:"bytes"`
	Hash     string `json:"hash"` // hash of the saved text, the value buffer.get reports and expected_hash takes
	Encoding string `json:"encoding"`
	Created  bool   `json:"created"` // the file did not exist before
}

// TabNewParams represents parameters for opening a tab (tab.new). Path and Content are exclusive.
type TabNewParams struct {
	Title      string  `json:"title,omitempty"`
	Path       string  `json:"path,omitempty"`    // an absolute path of an existing file; a file that is already open is not opened twice
	Content    *string `json:"content,omitempty"` // nil = the app's usual new-note header; "" = an empty note
	Background bool    `json:"background,omitempty"`
}

// TabNewResult is the result of tab.new.
type TabNewResult struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Path     string `json:"path"`
	Existing bool   `json:"existing"` // the path was already open in this tab; no second tab was made
}

// TabCloseParams represents parameters for closing a tab (tab.close).
type TabCloseParams struct {
	TabID   string `json:"tab_id"`
	IfSaved bool   `json:"if_saved,omitempty"` // close without any prompt, only when the tab's text equals its file's
}

// TabCloseResult is the result of tab.close. Reason is "unsaved" (if_saved and the text differs from
// the file, or the tab has no file), "prompt" (the tab has unsaved changes: the save prompt of the GUI
// is now showing and the call did not wait for it) or "gone" (the tab was closed by someone else meanwhile).
type TabCloseResult struct {
	Closed bool   `json:"closed"`
	Reason string `json:"reason,omitempty"`
}

// SelectionInfo describes the text currently selected in an editor.
type SelectionInfo struct {
	TabID string `json:"tab_id,omitempty"`
	Text  string `json:"text"`
	Start int    `json:"start"` // UTF-16 offset in the textarea
	End   int    `json:"end"`   // UTF-16 offset in the textarea
}

// ReplaceSelectionParams represents parameters for atomically replacing the current selection.
type ReplaceSelectionParams struct {
	TabID   string `json:"tab_id,omitempty"`
	Content string `json:"content"`
}

// ReplaceSelectionResult represents the result of a buffer.replace_selection call.
type ReplaceSelectionResult struct {
	Success    bool   `json:"success"`
	Generation uint64 `json:"generation"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
}

// TabInfo represents metadata of an open tab.
type TabInfo struct {
	ID         int    `json:"id"`
	Title      string `json:"title"`
	FilePath   string `json:"file_path,omitempty"`
	IsActive   bool   `json:"is_active"`
	IsModified bool   `json:"is_modified"`
}
