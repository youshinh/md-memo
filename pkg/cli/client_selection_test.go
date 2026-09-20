package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"

	"md-memo/pkg/ipc"
)

// fakeRPCPeer is a hermetic stand-in for a running md-memo instance: it speaks the same
// newline-delimited JSON-RPC protocol as ipc.Server but never touches the real session file
// (ipc.StartServer writes to the real %AppData%/md-memo/ipc-session.json, which would clobber a
// developer's live session; see pkg/ipc's own TestMain for why that must be avoided).
type fakeRPCPeer struct {
	listener net.Listener
	handler  func(method string, params json.RawMessage) (interface{}, *ipc.RPCError)
}

func startFakeRPCPeer(t *testing.T, handler func(method string, params json.RawMessage) (interface{}, *ipc.RPCError)) *ipc.SessionInfo {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to start fake RPC peer: %v", err)
	}
	peer := &fakeRPCPeer{listener: ln, handler: handler}
	t.Cleanup(func() { _ = ln.Close() })

	go peer.acceptLoop()

	port := ln.Addr().(*net.TCPAddr).Port
	return &ipc.SessionInfo{PID: 1, Port: port, Token: "test-token"}
}

func (p *fakeRPCPeer) acceptLoop() {
	for {
		conn, err := p.listener.Accept()
		if err != nil {
			return
		}
		go p.handleConn(conn)
	}
}

func (p *fakeRPCPeer) handleConn(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}
	var req ipc.RPCRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		return
	}
	result, rpcErr := p.handler(req.Method, req.Params)
	resp := &ipc.RPCResponse{JSONRPC: "2.0", ID: req.ID}
	if rpcErr != nil {
		resp.Error = rpcErr
	} else {
		resp.Result = result
	}
	data, err := json.Marshal(resp)
	if err != nil {
		return
	}
	data = append(data, '\n')
	_, _ = conn.Write(data)
}

func TestClientBufferGetSelection_HasSelection(t *testing.T) {
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		if method != "buffer.get_selection" {
			return nil, &ipc.RPCError{Code: ipc.ErrCodeMethodNotFound, Message: "unexpected method: " + method}
		}
		return ipc.SelectionInfo{Text: "picked text", Start: 3, End: 14}, nil
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	code, err := runner.Run([]string{"buffer", "get", "--selection", "--text"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr: %s)", code, stderr.String())
	}
	if stdout.String() != "picked text" {
		t.Errorf("expected plain selection text with no trailing newline, got %q", stdout.String())
	}
}

func TestClientBufferGetSelection_JSON(t *testing.T) {
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		return ipc.SelectionInfo{Text: "abc", Start: 1, End: 4}, nil
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	code, err := runner.Run([]string{"buffer", "get", "--selection", "--json"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr: %s)", code, stderr.String())
	}
	var got map[string]interface{}
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("expected valid JSON output, got %q: %v", stdout.String(), err)
	}
	if got["text"] != "abc" {
		t.Errorf("unexpected JSON output: %v", got)
	}
}

func TestClientBufferGetSelection_NoSelection(t *testing.T) {
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		return nil, &ipc.RPCError{Code: ipc.ErrCodeNoSelection, Message: "no active selection"}
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	code, err := runner.Run([]string{"buffer", "get", "--selection"})
	if code != 1 {
		t.Errorf("expected exit code 1, got %d", code)
	}
	if err == nil || err.Error() != "no active selection" {
		t.Errorf("expected error message %q, got %v", "no active selection", err)
	}
}

func TestClientBufferReplaceSelection_HappyPath(t *testing.T) {
	var receivedContent string
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		if method != "buffer.replace_selection" {
			return nil, &ipc.RPCError{Code: ipc.ErrCodeMethodNotFound, Message: "unexpected method: " + method}
		}
		var p ipc.ReplaceSelectionParams
		_ = json.Unmarshal(params, &p)
		receivedContent = p.Content
		return ipc.ReplaceSelectionResult{Success: true, Generation: 7, Start: 3, End: 10}, nil
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	stdinContent := "formatted\r\nreplacement\r\n"
	oldStdin := setStdinForTest(t, stdinContent)
	defer oldStdin()

	code, err := runner.Run([]string{"buffer", "replace-selection", "--text"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr: %s)", code, stderr.String())
	}
	if receivedContent != "formatted\nreplacement\n" {
		t.Errorf("expected CRLF normalized to LF with trailing newline kept, got %q", receivedContent)
	}
	if !strings.Contains(stdout.String(), "Generation: 7") {
		t.Errorf("expected generation in output, got %q", stdout.String())
	}
}

func TestClientBufferReplaceSelection_NoSelection(t *testing.T) {
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		return nil, &ipc.RPCError{Code: ipc.ErrCodeNoSelection, Message: "no active selection"}
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	oldStdin := setStdinForTest(t, "replacement")
	defer oldStdin()

	code, err := runner.Run([]string{"buffer", "replace-selection"})
	if code != 1 {
		t.Errorf("expected exit code 1, got %d", code)
	}
	if err == nil || err.Error() != "no active selection" {
		t.Errorf("expected error message %q, got %v", "no active selection", err)
	}
}

func TestClientBufferReplaceSelection_ConflictWhenSelectionMoved(t *testing.T) {
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		return nil, &ipc.RPCError{Code: ipc.ErrCodeConflict, Message: "selection changed before replace could be applied"}
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	oldStdin := setStdinForTest(t, "replacement")
	defer oldStdin()

	code, err := runner.Run([]string{"buffer", "replace-selection"})
	if code != 1 {
		t.Errorf("expected exit code 1, got %d", code)
	}
	if err == nil || !strings.Contains(err.Error(), "selection changed") {
		t.Errorf("expected conflict error surfaced verbatim, got %v", err)
	}
}

func TestClientBufferReplaceSelection_ArgsSkipStdin(t *testing.T) {
	var receivedContent string
	session := startFakeRPCPeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		var p ipc.ReplaceSelectionParams
		_ = json.Unmarshal(params, &p)
		receivedContent = p.Content
		return ipc.ReplaceSelectionResult{Success: true, Generation: 1}, nil
	})

	var stdout, stderr bytes.Buffer
	runner := NewClientRunner(session, &stdout, &stderr)

	code, err := runner.Run([]string{"buffer", "replace-selection", "--tab", "tab_2", "inline", "text"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr: %s)", code, stderr.String())
	}
	if receivedContent != "inline text" {
		t.Errorf("expected positional args joined as content, got %q", receivedContent)
	}
}

func TestNormalizeCRLF(t *testing.T) {
	cases := map[string]string{
		"a\r\nb\r\n": "a\nb\n",
		"a\rb":       "a\nb",
		"a\nb":       "a\nb",
		"":           "",
	}
	for in, want := range cases {
		if got := normalizeCRLF(in); got != want {
			t.Errorf("normalizeCRLF(%q) = %q, want %q", in, got, want)
		}
	}
}

// setStdinForTest temporarily points os.Stdin at a pipe pre-loaded with content, so
// readRemainingInput's non-terminal stdin path is exercised hermetically.
func setStdinForTest(t *testing.T, content string) func() {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("failed to create pipe: %v", err)
	}
	go func() {
		_, _ = w.Write([]byte(content))
		_ = w.Close()
	}()
	old := os.Stdin
	os.Stdin = r
	return func() {
		os.Stdin = old
		_ = r.Close()
	}
}
