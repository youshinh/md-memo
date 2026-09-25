package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"md-memo/pkg/ipc"
)

// capturePeer is a hermetic stand-in for a running instance (like fakeRPCPeer) that also records every
// request it received, token included: the tests below check what the CLI sends, not only how it prints.
type capturePeer struct {
	mu       sync.Mutex
	requests []ipc.RPCRequest
}

func (p *capturePeer) all() []ipc.RPCRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ipc.RPCRequest(nil), p.requests...)
}

func (p *capturePeer) last(t *testing.T) ipc.RPCRequest {
	t.Helper()
	all := p.all()
	if len(all) == 0 {
		t.Fatal("no request reached the app")
	}
	return all[len(all)-1]
}

func (p *capturePeer) params(t *testing.T) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(p.last(t).Params, &m); err != nil {
		t.Fatalf("params are not an object: %v (%s)", err, p.last(t).Params)
	}
	return m
}

func startCapturePeer(t *testing.T, handler func(method string, params json.RawMessage) (interface{}, *ipc.RPCError)) (*ipc.SessionInfo, *capturePeer) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	peer := &capturePeer{}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				sc := bufio.NewScanner(conn)
				sc.Buffer(make([]byte, 64*1024), 11*1024*1024)
				if !sc.Scan() {
					return
				}
				var req ipc.RPCRequest
				if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
					return
				}
				peer.mu.Lock()
				peer.requests = append(peer.requests, req)
				peer.mu.Unlock()
				result, rpcErr := handler(req.Method, req.Params)
				resp := &ipc.RPCResponse{JSONRPC: "2.0", ID: req.ID}
				if rpcErr != nil {
					resp.Error = rpcErr
				} else {
					resp.Result = result
				}
				data, _ := json.Marshal(resp)
				_, _ = conn.Write(append(data, '\n'))
			}(conn)
		}
	}()
	return &ipc.SessionInfo{PID: 1, Port: ln.Addr().(*net.TCPAddr).Port, Token: "session-token-123"}, peer
}

func runClient(session *ipc.SessionInfo, args ...string) (stdout, stderr string, code int, err error) {
	var out, errOut bytes.Buffer
	code, err = NewClientRunner(session, &out, &errOut).Run(args)
	return out.String(), errOut.String(), code, err
}

func okHandler(result interface{}) func(string, json.RawMessage) (interface{}, *ipc.RPCError) {
	return func(string, json.RawMessage) (interface{}, *ipc.RPCError) { return result, nil }
}

func failHandler(code int, msg string) func(string, json.RawMessage) (interface{}, *ipc.RPCError) {
	return func(string, json.RawMessage) (interface{}, *ipc.RPCError) {
		return nil, &ipc.RPCError{Code: code, Message: msg}
	}
}

// ---- the token ----------------------------------------------------------------------------------

func TestEveryClientCallSendsTheSessionToken(t *testing.T) {
	session, peer := startCapturePeer(t, func(method string, _ json.RawMessage) (interface{}, *ipc.RPCError) {
		if method == "tab.list" {
			return []map[string]interface{}{{"id": "tab_1", "title": "t", "path": "", "isActive": true}}, nil
		}
		return map[string]interface{}{"success": true, "closed": true, "id": "t", "path": "/x.md", "bytes": 1, "content": ""}, nil
	})
	calls := [][]string{
		{"buffer", "get", "--text"},
		{"buffer", "set", "x"},
		{"buffer", "append", "x"},
		{"buffer", "replace", "--start", "1:1", "--end", "1:1", "x"},
		{"buffer", "save", "--as", filepath.Join(t.TempDir(), "n.md")},
		{"tab", "list"},
		{"tab", "switch", "tab_1"},
		{"tab", "new", "--background"},
		{"tab", "close", "tab_1"},
		{"ui", "activate"},
	}
	for _, args := range calls {
		if _, _, _, err := runClient(session, args...); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	reqs := peer.all()
	if len(reqs) != len(calls) {
		t.Fatalf("%d requests for %d calls", len(reqs), len(calls))
	}
	for _, r := range reqs {
		if r.Auth != "session-token-123" {
			t.Errorf("%s was sent without the session token (auth=%q)", r.Method, r.Auth)
		}
	}
}

// ---- --tab reaches the app for every write ------------------------------------------------------

func TestBufferWritesSendTabID(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(map[string]interface{}{"success": true, "generation": 3, "hash": "h"}))
	cases := []struct {
		args   []string
		method string
	}{
		{[]string{"buffer", "set", "--tab", "tab_9", "text"}, "buffer.set"},
		{[]string{"buffer", "append", "--tab", "tab_9", "text"}, "buffer.append"},
		{[]string{"buffer", "replace", "--tab", "tab_9", "--start", "1:1", "--end", "1:2", "text"}, "buffer.replace"},
	}
	for _, c := range cases {
		if _, _, code, err := runClient(session, c.args...); err != nil || code != 0 {
			t.Fatalf("%v: code %d err %v", c.args, code, err)
		}
		req := peer.last(t)
		if req.Method != c.method {
			t.Errorf("method = %s, want %s", req.Method, c.method)
		}
		if got := peer.params(t)["tab_id"]; got != "tab_9" {
			t.Errorf("%v: tab_id = %v", c.args, got)
		}
	}
	// without --tab the field is left out: the app uses the active tab
	if _, _, _, err := runClient(session, "buffer", "set", "text"); err != nil {
		t.Fatal(err)
	}
	if _, has := peer.params(t)["tab_id"]; has {
		t.Errorf("no --tab must send no tab_id: %v", peer.params(t))
	}
}

// ---- buffer save --------------------------------------------------------------------------------

func TestBufferSaveSendsAbsoluteAsAndFlags(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(ipc.BufferSaveResult{TabID: "tab_1", Path: "/abs/note.md", Bytes: 42, Hash: "h", Encoding: "UTF-8", Created: true}))

	// a relative --as is made absolute against THIS process's working directory; flags may follow words
	stdout, _, code, err := runClient(session, "buffer", "save", "--as", filepath.Join("sub", "note.md"), "--overwrite", "--encoding", "sjis", "--tab", "tab_1", "--text")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if stdout != "Saved /abs/note.md (42 bytes)\n" {
		t.Errorf("stdout = %q", stdout)
	}
	p := peer.params(t)
	cwd, _ := os.Getwd()
	wantPath := filepath.Join(cwd, "sub", "note.md")
	if p["path"] != wantPath {
		t.Errorf("path = %v, want %v", p["path"], wantPath)
	}
	if !filepath.IsAbs(p["path"].(string)) {
		t.Error("--as must reach the app absolute")
	}
	if p["overwrite"] != true || p["encoding"] != "sjis" || p["tab_id"] != "tab_1" {
		t.Errorf("params = %v", p)
	}
	if peer.last(t).Method != "buffer.save" {
		t.Errorf("method = %s", peer.last(t).Method)
	}
}

func TestBufferSaveKeepsAnAbsoluteAsAndDefaultsToNothingElse(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(ipc.BufferSaveResult{Path: "p", Bytes: 1}))
	abs := filepath.Join(t.TempDir(), "n.md")
	if _, _, _, err := runClient(session, "buffer", "save", "--as", abs, "--text"); err != nil {
		t.Fatal(err)
	}
	p := peer.params(t)
	if p["path"] != abs {
		t.Errorf("path = %v", p["path"])
	}
	if _, has := p["overwrite"]; has {
		t.Errorf("overwrite must default to false (omitted): %v", p)
	}
	if _, has := p["encoding"]; has {
		t.Errorf("encoding is left to the app when not named: %v", p)
	}

	// with no --as at all: the tab's own file
	if _, _, _, err := runClient(session, "buffer", "save", "--text"); err != nil {
		t.Fatal(err)
	}
	if _, has := peer.params(t)["path"]; has {
		t.Errorf("no --as must send no path: %v", peer.params(t))
	}
}

func TestBufferSaveJSONIsTheRPCResult(t *testing.T) {
	want := ipc.BufferSaveResult{TabID: "tab_1", Path: "/abs/n.md", Bytes: 7, Hash: "0123456789abcdef", Encoding: "Shift_JIS", Created: false}
	session, _ := startCapturePeer(t, okHandler(want))
	stdout, _, code, err := runClient(session, "buffer", "save", "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	var got ipc.BufferSaveResult
	if err := json.Unmarshal([]byte(stdout), &got); err != nil || got != want {
		t.Errorf("stdout = %q -> %+v, %v", stdout, got, err)
	}
}

func TestBufferSaveErrors(t *testing.T) {
	session, peer := startCapturePeer(t, failHandler(ipc.ErrCodeInvalidParams, "not saved: refused overwrite: \"/x.md\" already exists (pass overwrite to replace it)"))

	// an RPC error is the command's error, exit 1
	code, err := func() (int, error) { _, _, c, e := runClient(session, "buffer", "save", "--as", "x.md"); return c, e }()
	if code != 1 || err == nil || !strings.Contains(err.Error(), "refused overwrite") {
		t.Errorf("code %d err %v", code, err)
	}

	before := len(peer.all())
	for _, args := range [][]string{
		{"buffer", "save", "--as", ""},     // an empty variable must not quietly save to the tab's own file
		{"buffer", "save", "some", "text"}, // no free text
		{"buffer", "save", "--bogus"},      // unknown flag
		{"buffer", "save", "--as"},         // missing value
		{"buffer", "save", "--encoding"},   // missing value
	} {
		_, _, code, err := runClient(session, args...)
		if code != 1 || err == nil {
			t.Errorf("%v: code %d err %v, want an error", args, code, err)
		}
	}
	if len(peer.all()) != before {
		t.Error("a bad command line must not reach the app")
	}

	_, _, code, err = runClient(session, "buffer", "save", "--as", "x.md", "--bogus")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Errorf("unknown flag after a value: code %d err %v", code, err)
	}
}

func TestBufferSaveHelpAfterWordsPrintsUsage(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(nil))
	stdout, _, code, err := runClient(session, "buffer", "save", "--as", "x.md", "-h")
	if err != nil || code != 0 || stdout != SubcommandUsage("buffer") {
		t.Errorf("code %d err %v stdout %.60q", code, err, stdout)
	}
	if len(peer.all()) != 0 {
		t.Error("help must not reach the app")
	}
}

// ---- tab new ------------------------------------------------------------------------------------

func TestTabNewParamsAndOutput(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(ipc.TabNewResult{ID: "tab_77", Title: "Scratch.md", Path: "", Existing: false}))

	stdout, _, code, err := runClient(session, "tab", "new", "--title", "Scratch.md", "--background", "--text")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if stdout != "tab_77\n" {
		t.Errorf("text output = %q, want just the id", stdout)
	}
	p := peer.params(t)
	if p["title"] != "Scratch.md" || p["background"] != true {
		t.Errorf("params = %v", p)
	}
	if _, has := p["path"]; has {
		t.Errorf("no --path, no path: %v", p)
	}

	stdout, _, code, err = runClient(session, "tab", "new", "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	var got ipc.TabNewResult
	if err := json.Unmarshal([]byte(stdout), &got); err != nil || got.ID != "tab_77" || got.Title != "Scratch.md" {
		t.Errorf("json = %q, %v", stdout, err)
	}
	if peer.last(t).Method != "tab.new" {
		t.Errorf("method = %s", peer.last(t).Method)
	}
}

func TestTabNewPathIsMadeAbsoluteAndExistingIsReported(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(ipc.TabNewResult{ID: "tab_2", Title: "n.md", Path: "/abs/n.md", Existing: true}))
	stdout, _, code, err := runClient(session, "tab", "new", "--path", filepath.Join("notes", "n.md"), "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	cwd, _ := os.Getwd()
	if got := peer.params(t)["path"]; got != filepath.Join(cwd, "notes", "n.md") {
		t.Errorf("path = %v", got)
	}
	var got ipc.TabNewResult
	_ = json.Unmarshal([]byte(stdout), &got)
	if !got.Existing {
		t.Errorf("existing must reach the JSON output: %q", stdout)
	}
}

func TestTabNewErrors(t *testing.T) {
	session, peer := startCapturePeer(t, failHandler(ipc.ErrCodeNotFound, `no such file: "/abs/x.md"`))
	_, _, code, err := runClient(session, "tab", "new", "--path", "x.md")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "no such file") {
		t.Errorf("code %d err %v", code, err)
	}
	before := len(peer.all())
	for _, args := range [][]string{
		{"tab", "new", "--path", ""},
		{"tab", "new", "extra"},
		{"tab", "new", "--bogus"},
		{"tab", "new", "--title"},
	} {
		_, _, code, err := runClient(session, args...)
		if code != 1 || err == nil {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	if len(peer.all()) != before {
		t.Error("a bad command line must not reach the app")
	}
}

// ---- tab close ----------------------------------------------------------------------------------

func TestTabCloseClosedIsExitZero(t *testing.T) {
	session, peer := startCapturePeer(t, okHandler(ipc.TabCloseResult{Closed: true}))

	// flags may come after the id, or before it
	for _, args := range [][]string{
		{"tab", "close", "tab_1", "--if-saved", "--text"},
		{"tab", "close", "--if-saved", "tab_1", "--text"},
	} {
		stdout, _, code, err := runClient(session, args...)
		if err != nil || code != 0 || stdout != "Closed tab_1\n" {
			t.Errorf("%v: code %d err %v stdout %q", args, code, err, stdout)
		}
		p := peer.params(t)
		if p["tab_id"] != "tab_1" || p["if_saved"] != true {
			t.Errorf("%v: params = %v", args, p)
		}
	}
	if peer.last(t).Method != "tab.close" {
		t.Errorf("method = %s", peer.last(t).Method)
	}

	if _, _, _, err := runClient(session, "tab", "close", "tab_1", "--text"); err != nil {
		t.Fatal(err)
	}
	if _, has := peer.params(t)["if_saved"]; has {
		t.Errorf("without --if-saved the field is left out: %v", peer.params(t))
	}

	stdout, _, code, err := runClient(session, "tab", "close", "tab_1", "--json")
	var got ipc.TabCloseResult
	if err != nil || code != 0 || json.Unmarshal([]byte(stdout), &got) != nil || !got.Closed {
		t.Errorf("json: code %d err %v stdout %q", code, err, stdout)
	}
}

func TestTabCloseNotClosedIsExitOneWithTheReason(t *testing.T) {
	for _, c := range []struct {
		reason, want string
	}{
		{"unsaved", "unsaved"},
		{"prompt", "asking the user whether to save"},
		{"gone", "no longer exists"},
	} {
		session, _ := startCapturePeer(t, okHandler(ipc.TabCloseResult{Closed: false, Reason: c.reason}))
		stdout, _, code, err := runClient(session, "tab", "close", "tab_1", "--if-saved", "--text")
		if code != 1 {
			t.Errorf("%s: exit code %d, want 1 so a script can test it", c.reason, code)
		}
		if err == nil || !strings.Contains(err.Error(), c.want) || !strings.Contains(err.Error(), "tab_1 was not closed") {
			t.Errorf("%s: error = %v", c.reason, err)
		}
		if strings.Contains(stdout, "Closed") {
			t.Errorf("%s: must not claim it closed: %q", c.reason, stdout)
		}

		// JSON: the verdict is the output, the exit code the test; no "Error:" line
		stdout, _, code, err = runClient(session, "tab", "close", "tab_1", "--json")
		var got ipc.TabCloseResult
		if code != 1 || err != nil || json.Unmarshal([]byte(stdout), &got) != nil || got.Closed || got.Reason != c.reason {
			t.Errorf("%s json: code %d err %v stdout %q", c.reason, code, err, stdout)
		}
	}
}

func TestTabCloseErrors(t *testing.T) {
	session, peer := startCapturePeer(t, failHandler(ipc.ErrCodeNotFound, "no such tab: nope"))
	_, _, code, err := runClient(session, "tab", "close", "nope")
	if code != 1 || err == nil || err.Error() != "no such tab: nope" {
		t.Errorf("code %d err %v", code, err)
	}
	before := len(peer.all())
	for _, args := range [][]string{
		{"tab", "close"},
		{"tab", "close", "--if-saved"},
		{"tab", "close", "a", "b"},
		{"tab", "close", "tab_1", "--bogus"},
	} {
		_, _, code, err := runClient(session, args...)
		if code != 1 || err == nil {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	if len(peer.all()) != before {
		t.Error("a bad command line must not reach the app")
	}
}

func TestTabAndBufferSubcommandMessagesAreTrue(t *testing.T) {
	session, _ := startCapturePeer(t, okHandler(nil))
	_, _, _, err := runClient(session, "tab")
	if err == nil || err.Error() != "tab subcommand required: list, switch, new, or close" {
		t.Errorf("err = %v", err)
	}
	_, _, _, err = runClient(session, "buffer")
	if err == nil || !strings.Contains(err.Error(), "save") {
		t.Errorf("buffer without an action should list save: %v", err)
	}
	_, _, _, err = runClient(session, "tab", "frobnicate")
	if err == nil || !strings.Contains(err.Error(), "unknown tab action") {
		t.Errorf("err = %v", err)
	}
}

// ---- help ---------------------------------------------------------------------------------------

func TestHelpDescribesTheNewActionsAndTheTokenRule(t *testing.T) {
	top := TopLevelUsage("9.9.9")
	for _, want := range []string{
		"buffer save", "--as <file>", "--overwrite", "--encoding utf-8|sjis", "tab new", "--background", "tab close <id> [--if-saved]",
		"buffer.save", "tab.new", "tab.close", "-32002", "REQUIRED", "buffer.get_selection", "not authenticated",
		"expected_generation", "previous_hash",
	} {
		if !strings.Contains(top, want) {
			t.Errorf("top-level usage lacks %q", want)
		}
	}
	bufferUsage := SubcommandUsage("buffer")
	for _, want := range []string{"buffer save", "--as", "--encoding", "--overwrite", ".md", ".markdown", ".txt", "refused overwrite", "dialog", "WITHOUT making it the active one"} {
		if !strings.Contains(bufferUsage, want) {
			t.Errorf("buffer usage lacks %q", want)
		}
	}
	tabUsage := SubcommandUsage("tab")
	for _, want := range []string{"tab new", "--title", "--path", "--background", "tab close", "--if-saved", "reason", `"prompt"`, `"unsaved"`} {
		if !strings.Contains(tabUsage, want) {
			t.Errorf("tab usage lacks %q", want)
		}
	}
	if strings.Contains(tabUsage, "not rejected") || strings.Contains(tabUsage, "no valid active tab") {
		t.Error("the unknown-id hazard of tab switch is fixed and must not be described any more")
	}
}

func TestNewValueFlagsAreSteppedOverByTheHelpScan(t *testing.T) {
	for _, f := range []string{"as", "encoding", "title", "path"} {
		if !valueFlags[f] {
			t.Errorf("value flag %q is missing from valueFlags", f)
		}
	}
	// the value of --as is a value, so a help flag after it is still a leading flag
	if text, ok := HelpRequest([]string{"buffer", "save", "--as", "file.md", "-h"}, "1"); !ok || text != SubcommandUsage("buffer") {
		t.Errorf("buffer save --as file.md -h: ok=%v", ok)
	}
	// a value that looks like a help flag is a value
	if _, ok := HelpRequest([]string{"tab", "new", "--title", "-h"}, "1"); ok {
		t.Error("--title -h is a title, not a help request")
	}
	// tab close's flag after the id: the id is text, so nothing is intercepted
	if _, ok := HelpRequest([]string{"tab", "close", "tab_1", "--if-saved"}, "1"); ok {
		t.Error("tab close tab_1 --if-saved must reach the runner")
	}
}
