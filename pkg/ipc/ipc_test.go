package ipc

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIPCSendAndReceive(t *testing.T) {
	port := 49155 // テスト用ポート

	var received *Message
	var wg sync.WaitGroup
	wg.Add(1)

	listener, err := StartListener(port, func(msg *Message) {
		received = msg
		wg.Done()
	})
	if err != nil {
		t.Fatalf("failed to start listener: %v", err)
	}
	defer listener.Close()

	sentMsg := &Message{
		Action:    "pipe",
		Content:   "error: line 42 crashed",
		Command:   "git diff",
		Cwd:       "C:\\Users\\test",
		Timestamp: time.Now().Format(time.RFC3339),
	}

	err = Send(port, sentMsg, 500*time.Millisecond)
	if err != nil {
		t.Fatalf("failed to send IPC message: %v", err)
	}

	wg.Wait()

	if received == nil {
		t.Fatal("expected message to be received, got nil")
	}
	if received.Action != sentMsg.Action {
		t.Errorf("expected Action %q, got %q", sentMsg.Action, received.Action)
	}
	if received.Content != sentMsg.Content {
		t.Errorf("expected Content %q, got %q", sentMsg.Content, received.Content)
	}
	if received.Command != sentMsg.Command {
		t.Errorf("expected Command %q, got %q", sentMsg.Command, received.Command)
	}
	if received.Cwd != sentMsg.Cwd {
		t.Errorf("expected Cwd %q, got %q", sentMsg.Cwd, received.Cwd)
	}
}

func TestIPCSendTimeoutWhenNoListener(t *testing.T) {
	unusedPort := 49156
	msg := &Message{Action: "activate"}
	err := Send(unusedPort, msg, 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected error connecting to unused port, got nil")
	}
}

func TestIPCLargePayload(t *testing.T) {
	port := 49157

	var received *Message
	var wg sync.WaitGroup
	wg.Add(1)

	listener, err := StartListener(port, func(msg *Message) {
		received = msg
		wg.Done()
	})
	if err != nil {
		t.Fatalf("failed to start listener: %v", err)
	}
	defer listener.Close()

	// 2MBのログデータ
	largeText := make([]byte, 2*1024*1024)
	for i := range largeText {
		largeText[i] = 'a'
	}

	sentMsg := &Message{
		Action:  "pipe",
		Content: string(largeText),
		Command: "cat large.log",
	}

	err = Send(port, sentMsg, 2*time.Second)
	if err != nil {
		t.Fatalf("failed to send large IPC message: %v", err)
	}

	wg.Wait()

	if received == nil || len(received.Content) != len(sentMsg.Content) {
		t.Fatalf("expected large content to match length %d, got %v", len(sentMsg.Content), received)
	}
}

func TestJSONRPCServerAndClient(t *testing.T) {
	// Start server on dynamic port (0)
	srv, err := StartServer(0, func(req *RPCRequest) *RPCResponse {
		switch req.Method {
		case "ping":
			return &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  "pong",
			}
		case "echo":
			var p struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(req.Params, &p)
			return &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  p.Text,
			}
		case "conflict_test":
			return &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: &RPCError{
					Code:    ErrCodeConflict,
					Message: "expected hash mismatch",
				},
			}
		default:
			return &RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error: &RPCError{
					Code:    ErrCodeMethodNotFound,
					Message: "method not found",
				},
			}
		}
	}, nil)

	if err != nil {
		t.Fatalf("StartServer failed: %v", err)
	}
	defer srv.Close()

	session := srv.Session()
	if session == nil || session.Port <= 0 || session.Token == "" {
		t.Fatalf("invalid session metadata: %+v", session)
	}

	// 1. Test ping
	var pong string
	err = CallRPC(session, "ping", nil, &pong, 1*time.Second)
	if err != nil {
		t.Fatalf("CallRPC ping failed: %v", err)
	}
	if pong != "pong" {
		t.Errorf("expected 'pong', got %q", pong)
	}

	// 2. Test echo with params
	var echoResult string
	err = CallRPC(session, "echo", map[string]string{"text": "Hello Unix Filter"}, &echoResult, 1*time.Second)
	if err != nil {
		t.Fatalf("CallRPC echo failed: %v", err)
	}
	if echoResult != "Hello Unix Filter" {
		t.Errorf("expected 'Hello Unix Filter', got %q", echoResult)
	}

	// 3. Test Conflict error
	var dummy string
	err = CallRPC(session, "conflict_test", nil, &dummy, 1*time.Second)
	if err == nil {
		t.Fatal("expected conflict error, got nil")
	}
	rpcErr, ok := err.(*RPCError)
	if !ok || rpcErr.Code != ErrCodeConflict {
		t.Errorf("expected ErrCodeConflict, got %v", err)
	}

	// 4. Test Session Load from file
	loaded, err := LoadSession()
	if err != nil {
		t.Fatalf("LoadSession failed: %v", err)
	}
	if loaded.Port != session.Port || loaded.Token != session.Token {
		t.Errorf("loaded session mismatch: %+v vs %+v", loaded, session)
	}

	// 5. Test Unauthorized token
	tamperedSession := *session
	tamperedSession.Token = "invalid-token"
	err = CallRPC(&tamperedSession, "ping", nil, &pong, 1*time.Second)
	if err == nil || !strings.Contains(err.Error(), "Unauthorized") {
		t.Errorf("expected unauthorized error with invalid token, got %v", err)
	}
}
