package ipc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The session token is mandatory for every method except the pure reads (auth.go). These tests talk
// to a real Server over loopback with hand-written request lines, the way a script would.

var allWriteMethods = []string{
	"buffer.set", "buffer.append", "buffer.replace", "buffer.replace_selection", "buffer.save",
	"tab.switch", "tab.new", "tab.close",
	"ui.activate", "ui.toggle_split", "ui.eval",
	"made.up.method", // a method nobody has heard of is protected too: protection is the default
	"",               // and so is a request with no method at all
}

var readMethods = []string{"buffer.get", "buffer.get_selection", "tab.list"}

// startCountingServer starts a Server whose handler answers "ok" and counts how often it ran.
func startCountingServer(t *testing.T) (*Server, *int32) {
	t.Helper()
	var calls int32
	srv, err := StartServer(0, func(req *RPCRequest) *RPCResponse {
		atomic.AddInt32(&calls, 1)
		return &RPCResponse{JSONRPC: "2.0", ID: req.ID, Result: "ok"}
	}, nil)
	if err != nil {
		t.Fatalf("StartServer: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv, &calls
}

// rawCall sends one request line and returns the decoded response line.
func rawCall(t *testing.T, srv *Server, method, auth string) RPCResponse {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", srv.Port()), time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	req := map[string]interface{}{"jsonrpc": "2.0", "id": 1, "method": method}
	if auth != "" {
		req["auth"] = auth
	}
	line, _ := json.Marshal(req)
	if _, err := conn.Write(append(line, '\n')); err != nil {
		t.Fatalf("write: %v", err)
	}
	sc := bufio.NewScanner(conn)
	if !sc.Scan() {
		t.Fatalf("no response for %q: %v", method, sc.Err())
	}
	var resp RPCResponse
	if err := json.Unmarshal(sc.Bytes(), &resp); err != nil {
		t.Fatalf("bad response %q: %v", sc.Text(), err)
	}
	return resp
}

func TestReadOnlyMethodSetIsExactlyThePureReads(t *testing.T) {
	var got []string
	for m := range readOnlyMethods {
		got = append(got, m)
	}
	sort.Strings(got)
	want := append([]string(nil), readMethods...)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("token-free methods = %v, want exactly %v: a method is public only by deliberate choice", got, want)
	}
	for _, m := range readMethods {
		if !IsReadOnlyMethod(m) {
			t.Errorf("%s should be token-optional", m)
		}
	}
	for _, m := range allWriteMethods {
		if IsReadOnlyMethod(m) {
			t.Errorf("%q must need the token", m)
		}
	}
}

func TestAuthorizeTable(t *testing.T) {
	const tok = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	type row struct {
		name     string
		method   string
		supplied string
		expected string
		allowed  bool
	}
	rows := []row{
		{"read, no token", "buffer.get", "", tok, true},
		{"read, right token", "buffer.get", tok, tok, true},
		{"read, wrong token", "buffer.get", "nope", tok, false},
		{"selection read, no token", "buffer.get_selection", "", tok, true},
		{"tab list, no token", "tab.list", "", tok, true},
		{"tab list, wrong token", "tab.list", tok + "0", tok, false},
		{"write, no token", "buffer.set", "", tok, false},
		{"write, wrong token", "buffer.set", "nope", tok, false},
		{"write, right token", "buffer.set", tok, tok, true},
		{"write, token that is a prefix", "buffer.set", tok[:len(tok)-1], tok, false},
		{"write, token with a suffix", "buffer.set", tok + "x", tok, false},
		{"write, case-changed token", "buffer.set", strings.ToUpper(tok), tok, false},
		{"unknown method, no token", "zzz", "", tok, false},
		{"unknown method, right token", "zzz", tok, tok, true},
		{"empty method, no token", "", "", tok, false},
		{"ui.eval, no token", "ui.eval", "", tok, false},
		{"no token configured, write", "buffer.set", "", "", false},
		{"no token configured, guessed empty", "buffer.set", "anything", "", false},
		{"no token configured, read", "buffer.get", "", "", true},
	}
	for _, r := range rows {
		err := authorize(r.method, r.supplied, r.expected)
		if (err == nil) != r.allowed {
			t.Errorf("%s: authorize(%q, %q) = %v, allowed want %v", r.name, r.method, r.supplied, err, r.allowed)
			continue
		}
		if err != nil {
			if err.Code != ErrCodeUnauthorized {
				t.Errorf("%s: code = %d, want %d", r.name, err.Code, ErrCodeUnauthorized)
			}
			if !strings.HasPrefix(err.Message, "Unauthorized") {
				t.Errorf("%s: message = %q", r.name, err.Message)
			}
			if r.expected != "" && strings.Contains(err.Message, r.expected) {
				t.Errorf("%s: the message leaks the token", r.name)
			}
			if r.supplied != "" && len(r.supplied) > 3 && strings.Contains(err.Message, r.supplied) {
				t.Errorf("%s: the message echoes the supplied token", r.name)
			}
		}
	}
}

func TestMissingTokenMessageSaysItIsRequiredAndWhereToReadIt(t *testing.T) {
	err := authorize("buffer.set", "", "x")
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"auth token required", `"buffer.set"`, "auth", "ipc-session.json", "token"} {
		if !strings.Contains(err.Message, want) {
			t.Errorf("message %q should mention %q", err.Message, want)
		}
	}
}

func TestServerRequiresTheTokenForEveryWriteMethod(t *testing.T) {
	srv, calls := startCountingServer(t)
	token := srv.Session().Token

	for _, m := range allWriteMethods {
		before := atomic.LoadInt32(calls)

		resp := rawCall(t, srv, m, "")
		if resp.Error == nil || resp.Error.Code != ErrCodeUnauthorized {
			t.Errorf("%q without a token: %+v, want -32000", m, resp)
		}
		resp = rawCall(t, srv, m, "wrong-token")
		if resp.Error == nil || resp.Error.Code != ErrCodeUnauthorized {
			t.Errorf("%q with a wrong token: %+v, want -32000", m, resp)
		}
		if atomic.LoadInt32(calls) != before {
			t.Errorf("%q ran although the token was missing or wrong", m)
		}

		resp = rawCall(t, srv, m, token)
		if resp.Error != nil || resp.Result != "ok" {
			t.Errorf("%q with the right token: %+v", m, resp)
		}
		if atomic.LoadInt32(calls) != before+1 {
			t.Errorf("%q did not reach the handler with the right token", m)
		}
	}
}

func TestServerReadsKeepTheOldRule(t *testing.T) {
	srv, calls := startCountingServer(t)
	token := srv.Session().Token

	for _, m := range readMethods {
		if resp := rawCall(t, srv, m, ""); resp.Error != nil || resp.Result != "ok" {
			t.Errorf("%s without a token: %+v, want it accepted", m, resp)
		}
		if resp := rawCall(t, srv, m, token); resp.Error != nil || resp.Result != "ok" {
			t.Errorf("%s with the token: %+v", m, resp)
		}
		before := atomic.LoadInt32(calls)
		resp := rawCall(t, srv, m, "wrong-token")
		if resp.Error == nil || resp.Error.Code != ErrCodeUnauthorized {
			t.Errorf("%s with a WRONG token: %+v, want -32000", m, resp)
		}
		if atomic.LoadInt32(calls) != before {
			t.Errorf("%s ran with a wrong token", m)
		}
	}
}

func TestServerErrorNeverContainsTheToken(t *testing.T) {
	srv, _ := startCountingServer(t)
	token := srv.Session().Token
	for _, auth := range []string{"", "wrong"} {
		resp := rawCall(t, srv, "buffer.set", auth)
		if resp.Error == nil {
			t.Fatal("expected an error")
		}
		if strings.Contains(resp.Error.Message, token) {
			t.Errorf("the error leaks the token: %q", resp.Error.Message)
		}
	}
}

func TestCallRPCStillAuthenticatesWriteMethods(t *testing.T) {
	srv, calls := startCountingServer(t)

	var out string
	if err := CallRPC(srv.Session(), "buffer.set", map[string]string{"content": "x"}, &out, time.Second); err != nil {
		t.Fatalf("CallRPC with the session token: %v", err)
	}
	if out != "ok" || atomic.LoadInt32(calls) != 1 {
		t.Errorf("out=%q calls=%d", out, atomic.LoadInt32(calls))
	}

	noToken := *srv.Session()
	noToken.Token = ""
	err := CallRPC(&noToken, "buffer.set", nil, &out, time.Second)
	rpcErr, ok := err.(*RPCError)
	if !ok || rpcErr.Code != ErrCodeUnauthorized {
		t.Errorf("CallRPC without a token = %v, want -32000", err)
	}
	// ...and reads still work without one.
	if err := CallRPC(&noToken, "buffer.get", nil, &out, time.Second); err != nil {
		t.Errorf("a read without a token: %v", err)
	}
}

func TestLegacyMessagesStayUnauthenticated(t *testing.T) {
	var got int32
	srv, err := StartServer(0, nil, func(msg *Message) { atomic.AddInt32(&got, 1) })
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	// The one-line messages of `cmd | md-memo` and `md-memo <file>` carry no token.
	for _, msg := range []*Message{{Action: ActionActivate}, {Action: ActionPipe, Content: "x"}, {Action: ActionOpen, Path: "/x.md"}} {
		if err := Send(srv.Port(), msg, time.Second); err != nil {
			t.Errorf("Send(%s) without a token: %v", msg.Action, err)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&got) < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if atomic.LoadInt32(&got) != 3 {
		t.Errorf("legacy handler ran %d times, want 3", atomic.LoadInt32(&got))
	}
}

func TestTokenMatchesBehaviour(t *testing.T) {
	if !tokenMatches("abc", "abc") {
		t.Error("equal tokens must match")
	}
	for _, other := range []string{"abd", "ab", "abcd", "", "ABC"} {
		if tokenMatches(other, "abc") {
			t.Errorf("%q must not match", other)
		}
	}
}

// The comparison must stay constant-time: this fails if someone swaps subtle.ConstantTimeCompare for
// == or !=, which is a one-character change that no behavioural test can tell apart.
func TestTokenIsComparedInConstantTime(t *testing.T) {
	authSrc, err := os.ReadFile("auth.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(authSrc), "subtle.ConstantTimeCompare") {
		t.Error("auth.go must compare tokens with crypto/subtle.ConstantTimeCompare")
	}
	ipcSrc, err := os.ReadFile("ipc.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"Auth != ", "Auth == ", "!= s.session.Token", "== s.session.Token", "Token == req", "Token != req"} {
		if strings.Contains(string(ipcSrc), bad) {
			t.Errorf("ipc.go compares the token directly (%q): use authorize / tokenMatches", bad)
		}
	}
	if !strings.Contains(string(ipcSrc), "authorize(") {
		t.Error("ipc.go must run every RPC request through authorize")
	}
}
