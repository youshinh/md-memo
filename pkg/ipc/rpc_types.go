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
	TabID      int    `json:"tab_id"`
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
	TabID              interface{} `json:"tab_id,omitempty"` // int, "active", or nil
	Content            string      `json:"content"`
	ExpectedHash       string      `json:"expected_hash,omitempty"`
	ExpectedGeneration uint64      `json:"expected_generation,omitempty"`
}

// BufferReplaceParams represents parameters for replacing a subrange in the buffer.
type BufferReplaceParams struct {
	TabID              interface{} `json:"tab_id,omitempty"` // int, "active", or nil
	StartLine          int         `json:"start_line"`       // 1-indexed
	StartCol           int         `json:"start_col"`        // 1-indexed
	EndLine            int         `json:"end_line"`         // 1-indexed
	EndCol             int         `json:"end_col"`          // 1-indexed
	Content            string      `json:"content"`
	ExpectedHash       string      `json:"expected_hash,omitempty"`
	ExpectedGeneration uint64      `json:"expected_generation,omitempty"`
}

// TabInfo represents metadata of an open tab.
type TabInfo struct {
	ID         int    `json:"id"`
	Title      string `json:"title"`
	FilePath   string `json:"file_path,omitempty"`
	IsActive   bool   `json:"is_active"`
	IsModified bool   `json:"is_modified"`
}
