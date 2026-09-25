package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"md-memo/pkg/encoding"
	"md-memo/pkg/ipc"
)

// ---- a fake of the page -------------------------------------------------------------------------
//
// The RPC methods talk to window.__mdMemoRPC in the WebView. fakePage answers those calls from a
// small in-memory list of tabs that follows the same contract as frontend/js/app.js (which
// tests/rpc_write_tabs_test.mjs runs for real), so the Go side is tested for what it sends, how it
// maps the page's answers and errors, and everything it does itself (files, encodings, paths).

type fakeTab struct {
	ID, Title, Path, Content, Encoding string
	Dirty                              bool
}

type fakePage struct {
	app *App

	mu     sync.Mutex
	tabs   []*fakeTab
	active string
	nextID int
	calls  []string // the function names called, in order
	specs  []map[string]interface{}

	disk         map[string]string // what the page's file reader returns, for tab.close if_saved
	beforeCommit func(p *fakePage) // runs inside commitSave before the hash check (a user edit in between)
	notReady     bool              // window.__mdMemoRPC does not exist yet: every call answers null
	closePrompts int
}

func newFakePage(app *App) *fakePage {
	p := &fakePage{app: app, disk: map[string]string{}}
	app.w = p
	atomic.StoreInt32(&app.isDestroyed, 0)
	p.addTab(&fakeTab{Title: "Untitled-1.md", Content: "# Initial\n", Encoding: "UTF-8"})
	p.active = p.tabs[0].ID
	return p
}

func (p *fakePage) addTab(t *fakeTab) *fakeTab {
	p.nextID++
	t.ID = fmt.Sprintf("tab_%d", p.nextID)
	if t.Encoding == "" {
		t.Encoding = "UTF-8"
	}
	p.tabs = append(p.tabs, t)
	return t
}

func (p *fakePage) tab(id string) *fakeTab {
	for _, t := range p.tabs {
		if t.ID == id {
			return t
		}
	}
	return nil
}

func (p *fakePage) callNames() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.calls...)
}

func (p *fakePage) Dispatch(f func()) { go f() }

var (
	evalCodeRE = regexp.MustCompile(`(?s)const code = (".*?");\n`)
	rpcCallRE  = regexp.MustCompile(`(?s)^\(async \(\) => window\.__mdMemoRPC && window\.__mdMemoRPC\.(\w+)\((.*)\)\)\(\)$`)
)

// codeOfEval is the JS expression CallJSWithResponse wrapped into the script it evaluates.
func codeOfEval(js string) string {
	m := evalCodeRE.FindStringSubmatch(js)
	if m == nil {
		return js
	}
	var code string
	if err := json.Unmarshal([]byte(m[1]), &code); err != nil {
		return js
	}
	return code
}

// parseRPCCall splits the expression rpcCallExpr builds, "(async () => window.__mdMemoRPC &&
// window.__mdMemoRPC.fn(a, b))()", into fn and its JSON arguments.
func parseRPCCall(code string) (string, []json.RawMessage, error) {
	m := rpcCallRE.FindStringSubmatch(code)
	if m == nil {
		return "", nil, fmt.Errorf("not an RPC call: %.80s", code)
	}
	var args []json.RawMessage
	if err := json.Unmarshal([]byte("["+m[2]+"]"), &args); err != nil {
		return "", nil, fmt.Errorf("arguments of %s are not JSON: %v", m[1], err)
	}
	return m[1], args, nil
}

func (p *fakePage) Eval(js string) {
	reqID := extractReqID(js)
	fn, args, err := parseRPCCall(codeOfEval(js))
	if err != nil {
		_, _ = p.app.ReportRPCResult(reqID, "", err.Error())
		return
	}
	res, jsErr := p.handle(fn, args)
	if jsErr != "" {
		_, _ = p.app.ReportRPCResult(reqID, "", jsErr)
		return
	}
	data, _ := json.Marshal(res)
	_, _ = p.app.ReportRPCResult(reqID, string(data), "")
}

func arg(args []json.RawMessage, i int, into interface{}) {
	if i < len(args) {
		_ = json.Unmarshal(args[i], into)
	}
}

func (p *fakePage) resolve(id string) (*fakeTab, string) {
	if id == "" {
		if t := p.tab(p.active); t != nil {
			return t, ""
		}
		return nil, "[not_found] no tab is open"
	}
	if t := p.tab(id); t != nil {
		return t, ""
	}
	return nil, "[not_found] no such tab: " + id
}

func (p *fakePage) handle(fn string, args []json.RawMessage) (interface{}, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, fn)
	if p.notReady {
		return nil, ""
	}

	switch fn {
	case "getBuffer":
		var id string
		arg(args, 0, &id)
		t, e := p.resolve(id)
		if e != "" {
			return nil, e
		}
		return map[string]interface{}{
			"tabId": t.ID, "title": t.Title, "path": t.Path, "content": t.Content,
			"length": len(t.Content), "lineCount": strings.Count(t.Content, "\n") + 1,
			"isActive": t.ID == p.active, "isModified": t.Dirty,
		}, ""

	case "switchTab":
		var id string
		arg(args, 0, &id)
		t, e := p.resolve(id)
		if e != "" {
			return nil, e
		}
		p.active = t.ID
		return true, ""

	case "writeText":
		var req struct {
			TabID              string `json:"tabId"`
			Mode               string `json:"mode"`
			Content            string `json:"content"`
			ExpectedHash       string `json:"expectedHash"`
			ExpectedGeneration uint64 `json:"expectedGeneration"`
			CurrentGeneration  uint64 `json:"currentGeneration"`
			Range              *struct {
				StartLine, StartCol, EndLine, EndCol int
			} `json:"range"`
		}
		arg(args, 0, &req)
		t, e := p.resolve(req.TabID)
		if e != "" {
			return nil, e
		}
		prev := computeHash(t.Content)
		if req.ExpectedHash != "" && req.ExpectedHash != prev {
			return nil, fmt.Sprintf("[conflict] conflict: expected hash %s but buffer is at %s", req.ExpectedHash, prev)
		}
		if req.ExpectedGeneration > 0 && req.ExpectedGeneration != req.CurrentGeneration {
			return nil, fmt.Sprintf("[conflict] conflict: expected generation %d but buffer is at %d", req.ExpectedGeneration, req.CurrentGeneration)
		}
		text := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(req.Content)
		switch req.Mode {
		case "set":
			t.Content = text
		case "append":
			t.Content += text
		case "replace":
			// only single-line ranges are needed here
			line := strings.Split(t.Content, "\n")
			r := req.Range
			if r == nil || r.StartLine != r.EndLine || r.StartLine < 1 || r.StartLine > len(line) {
				return nil, "fake page: unsupported range"
			}
			l := line[r.StartLine-1]
			s, en := r.StartCol-1, r.EndCol-1
			if s < 0 || en < s || en > len(l) {
				return nil, "fake page: range out of the line"
			}
			line[r.StartLine-1] = l[:s] + text + l[en:]
			t.Content = strings.Join(line, "\n")
		default:
			return nil, "fake page: bad mode " + req.Mode
		}
		t.Dirty = true
		return map[string]interface{}{"tab_id": t.ID, "previous_hash": prev, "hash": computeHash(t.Content)}, ""

	case "prepareSave":
		var id string
		arg(args, 0, &id)
		t, e := p.resolve(id)
		if e != "" {
			return nil, e
		}
		return map[string]interface{}{
			"tab_id": t.ID, "content": t.Content, "hash": computeHash(t.Content),
			"path": t.Path, "encoding": t.Encoding, "title": t.Title,
		}, ""

	case "commitSave":
		var id string
		var info struct {
			Path, Encoding, Hash string
			Bytes                int
		}
		arg(args, 0, &id)
		arg(args, 1, &info)
		t := p.tab(id)
		if t == nil {
			return nil, "[not_found] no such tab: " + id + " (it was closed while saving; the file was written)"
		}
		if p.beforeCommit != nil {
			p.beforeCommit(p)
		}
		if computeHash(t.Content) != info.Hash {
			return nil, "[conflict] the note was edited while it was being saved (the file holds the earlier text)"
		}
		t.Path = info.Path
		t.Title = filepath.Base(info.Path)
		t.Encoding = info.Encoding
		t.Dirty = false
		return map[string]interface{}{"tab_id": t.ID, "path": t.Path, "title": t.Title}, ""

	case "openTab":
		var spec map[string]interface{}
		arg(args, 0, &spec)
		p.specs = append(p.specs, spec)
		path, _ := spec["path"].(string)
		background, _ := spec["background"].(bool)
		if path != "" {
			for _, t := range p.tabs {
				if strings.EqualFold(t.Path, path) {
					if !background {
						p.active = t.ID
					}
					return map[string]interface{}{"id": t.ID, "title": t.Title, "path": t.Path, "existing": true}, ""
				}
			}
		}
		title, _ := spec["title"].(string)
		if title == "" {
			title = "Untitled-new.md"
		}
		content := "# header\n\n"
		if c, ok := spec["content"].(string); ok {
			content = c
		}
		enc, _ := spec["encoding"].(string)
		t := p.addTab(&fakeTab{Title: title, Path: path, Content: content, Encoding: enc})
		if !background {
			p.active = t.ID
		}
		return map[string]interface{}{"id": t.ID, "title": t.Title, "path": t.Path, "existing": false}, ""

	case "closeTabChecked":
		var id string
		var ifSaved bool
		arg(args, 0, &id)
		arg(args, 1, &ifSaved)
		t := p.tab(id)
		if t == nil {
			return nil, "[not_found] no such tab: " + id
		}
		remove := func() {
			for i, x := range p.tabs {
				if x == t {
					p.tabs = append(p.tabs[:i], p.tabs[i+1:]...)
					return
				}
			}
		}
		if ifSaved {
			if t.Path == "" || p.disk[t.Path] != t.Content {
				return map[string]interface{}{"closed": false, "reason": "unsaved"}, ""
			}
			remove()
			return map[string]interface{}{"closed": true}, ""
		}
		if !t.Dirty {
			remove()
			return map[string]interface{}{"closed": true}, ""
		}
		p.closePrompts++
		return map[string]interface{}{"closed": false, "reason": "prompt"}, ""
	}
	return nil, "fake page: unknown function " + fn
}

// ---- helpers ------------------------------------------------------------------------------------

func rpc(t *testing.T, app *App, method string, params interface{}) *ipc.RPCResponse {
	t.Helper()
	req := &ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: method}
	if params != nil {
		data, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		req.Params = data
	}
	return app.DispatchRPCOperation(req)
}

func mustOK(t *testing.T, resp *ipc.RPCResponse) interface{} {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("unexpected error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result
}

func mustFail(t *testing.T, resp *ipc.RPCResponse, code int) string {
	t.Helper()
	if resp.Error == nil {
		t.Fatalf("expected error %d, got result %+v", code, resp.Result)
	}
	if resp.Error.Code != code {
		t.Fatalf("error code = %d (%s), want %d", resp.Error.Code, resp.Error.Message, code)
	}
	return resp.Error.Message
}

func newRPCApp(t *testing.T) (*App, *fakePage) {
	t.Helper()
	app := &App{}
	return app, newFakePage(app)
}

// ---- hash parity --------------------------------------------------------------------------------

func TestComputeHashKnownValues(t *testing.T) {
	// The same values are pinned in frontend/js/note_hash_test.js against the page's copy of the function.
	cases := map[string]string{
		"":    "e3b0c44298fc1c14",
		"abc": "ba7816bf8f01cfea",
		"# \u898b\u51fa\u3057 \U0001F916\nline\r\nend": "de75cb63e13bbb54",
	}
	for in, want := range cases {
		if got := computeHash(in); got != want {
			t.Errorf("computeHash(%q) = %s, want %s", in, got, want)
		}
	}
}

// ---- how the calls into the page are built ------------------------------------------------------

func TestRPCCallExprEscapesEverything(t *testing.T) {
	nasty := "quote \" backslash \\ newline\n cr\r tab\t line-sep \u2028 para-sep \u2029 </script> back`tick ${x} \U0001F600 \x00 end"
	expr := rpcCallExpr("writeText", map[string]interface{}{"content": nasty, "n": 7}, "tab_1", 3, true)
	fn, args, err := parseRPCCall(expr)
	if err != nil {
		t.Fatal(err)
	}
	if fn != "writeText" || len(args) != 4 {
		t.Fatalf("fn=%s args=%d", fn, len(args))
	}
	var obj struct {
		Content string `json:"content"`
		N       int    `json:"n"`
	}
	if err := json.Unmarshal(args[0], &obj); err != nil || obj.Content != nasty || obj.N != 7 {
		t.Fatalf("content did not survive: %v %q", err, obj.Content)
	}
	var id string
	_ = json.Unmarshal(args[1], &id)
	if id != "tab_1" {
		t.Errorf("id = %q", id)
	}
	// a tab id that would break out of a quoted string cannot
	expr = rpcCallExpr("getBuffer", `x"); alert(1); ("`)
	if strings.Count(expr, `"); alert(1)`) != 0 && !strings.Contains(expr, `\"); alert(1)`) {
		t.Errorf("the id was not escaped: %s", expr)
	}
	if _, a, err := parseRPCCall(expr); err != nil || len(a) != 1 {
		t.Errorf("the call no longer parses as one argument: %v %d", err, len(a))
	}
}

func TestJSErrorResponseMapsMarkersToCodes(t *testing.T) {
	cases := []struct {
		in   string
		code int
		msg  string
	}{
		{"[not_found] no such tab: x", ipc.ErrCodeNotFound, "no such tab: x"},
		{"[conflict] conflict: expected hash a but buffer is at b", ipc.ErrCodeConflict, "conflict: expected hash a but buffer is at b"},
		{"[invalid_params] tab_id is required", ipc.ErrCodeInvalidParams, "tab_id is required"},
		{"TypeError: x is not a function", ipc.ErrCodeInternalError, "failed to do it: TypeError: x is not a function"},
		{"[unknown_kind] whatever", ipc.ErrCodeInternalError, "failed to do it: [unknown_kind] whatever"},
		{"context deadline exceeded", ipc.ErrCodeInternalError, "failed to do it: context deadline exceeded"},
	}
	for _, c := range cases {
		resp := jsErrorResponse(7, errors.New(c.in), "failed to do it")
		if resp.Error == nil || resp.Error.Code != c.code || resp.Error.Message != c.msg {
			t.Errorf("%q -> %+v, want %d %q", c.in, resp.Error, c.code, c.msg)
		}
		if resp.ID != 7 {
			t.Errorf("the response must carry the request id")
		}
	}
}

// ---- buffer.get ---------------------------------------------------------------------------------

func TestBufferGetUnknownTabIsNotFound(t *testing.T) {
	app, _ := newRPCApp(t)
	msg := mustFail(t, rpc(t, app, "buffer.get", map[string]string{"tab_id": "bogus"}), ipc.ErrCodeNotFound)
	if msg != "no such tab: bogus" {
		t.Errorf("message = %q", msg)
	}
	// it used to answer an empty buffer with no error
}

func TestBufferGetHonoursTabIDAndReportsIt(t *testing.T) {
	app, page := newRPCApp(t)
	bg := page.addTab(&fakeTab{Title: "Bg.md", Path: "/n/Bg.md", Content: "background text"})

	info := mustOK(t, rpc(t, app, "buffer.get", nil)).(*ipc.BufferInfo)
	if info.Content != "# Initial\n" || info.TabID != page.active || !info.IsActive {
		t.Errorf("active tab: %+v", info)
	}
	info = mustOK(t, rpc(t, app, "buffer.get", map[string]string{"tab_id": bg.ID})).(*ipc.BufferInfo)
	if info.Content != "background text" || info.TabID != bg.ID || info.IsActive || info.FilePath != "/n/Bg.md" {
		t.Errorf("background tab: %+v", info)
	}
	if info.Hash != computeHash("background text") {
		t.Errorf("hash = %s", info.Hash)
	}
	data, _ := json.Marshal(info)
	if !strings.Contains(string(data), `"tab_id":"`+bg.ID+`"`) {
		t.Errorf("tab_id must be the string id in JSON: %s", data)
	}
}

func TestPageNotReadyIsAnInternalErrorNotAnEmptyResult(t *testing.T) {
	app, page := newRPCApp(t)
	page.notReady = true
	target := filepath.Join(t.TempDir(), "x.md")
	for m, params := range map[string]interface{}{
		"buffer.get":     map[string]string{},
		"buffer.set":     ipc.BufferSetParams{Content: "x"},
		"buffer.append":  ipc.BufferAppendParams{Content: "x"},
		"buffer.replace": ipc.BufferReplaceParams{Content: "x", StartLine: 1, StartCol: 1, EndLine: 1, EndCol: 1},
		"buffer.save":    ipc.BufferSaveParams{Path: target},
		"tab.new":        ipc.TabNewParams{Background: true},
		"tab.close":      ipc.TabCloseParams{TabID: "t"},
	} {
		msg := mustFail(t, rpc(t, app, m, params), ipc.ErrCodeInternalError)
		if !strings.Contains(msg, "not ready") {
			t.Errorf("%s: message %q should say the page is not ready", m, msg)
		}
	}
}

// ---- writes: --tab, the lock, generation --------------------------------------------------------

func TestBufferSetActiveAndBackgroundTab(t *testing.T) {
	app, page := newRPCApp(t)
	bg := page.addTab(&fakeTab{Title: "Bg.md", Content: "bg"})
	activeBefore := page.active
	genBefore := atomic.LoadUint64(&globalBufferGen)

	res := mustOK(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{Content: "new active"})).(*ipc.BufferWriteResult)
	if page.tab(activeBefore).Content != "new active" || res.TabID != activeBefore {
		t.Errorf("active write: %+v, content %q", res, page.tab(activeBefore).Content)
	}
	if res.PreviousHash != computeHash("# Initial\n") || res.Hash != computeHash("new active") || !res.Success {
		t.Errorf("hashes: %+v", res)
	}
	if res.Generation != genBefore+1 {
		t.Errorf("generation = %d, want %d", res.Generation, genBefore+1)
	}
	if res.Length == nil || *res.Length != len("new active") {
		t.Errorf("length = %v (the UTF-8 byte size of what was sent)", res.Length)
	}

	res = mustOK(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{TabID: bg.ID, Content: "日本語"})).(*ipc.BufferWriteResult)
	if bg.Content != "日本語" || res.TabID != bg.ID {
		t.Errorf("background write: %+v, content %q", res, bg.Content)
	}
	if *res.Length != 9 {
		t.Errorf("length = %d, want the UTF-8 bytes (9)", *res.Length)
	}
	if page.active != activeBefore {
		t.Error("the active tab changed")
	}
	if page.tab(activeBefore).Content != "new active" {
		t.Error("the active tab was touched by a write to another tab")
	}
	if res.Generation != genBefore+2 {
		t.Errorf("generation = %d, want %d", res.Generation, genBefore+2)
	}
}

func TestBufferAppendAndReplaceTakeTabID(t *testing.T) {
	app, page := newRPCApp(t)
	bg := page.addTab(&fakeTab{Title: "Bg.md", Content: "hello world"})

	res := mustOK(t, rpc(t, app, "buffer.append", ipc.BufferAppendParams{TabID: bg.ID, Content: "!"})).(*ipc.BufferWriteResult)
	if bg.Content != "hello world!" || res.TabID != bg.ID || res.Hash != computeHash("hello world!") || res.PreviousHash != computeHash("hello world") {
		t.Errorf("append: %+v %q", res, bg.Content)
	}
	if res.Length != nil {
		t.Error("length is a buffer.set field only")
	}
	res = mustOK(t, rpc(t, app, "buffer.replace", ipc.BufferReplaceParams{
		TabID: bg.ID, StartLine: 1, StartCol: 1, EndLine: 1, EndCol: 6, Content: "HELLO",
	})).(*ipc.BufferWriteResult)
	if bg.Content != "HELLO world!" || res.TabID != bg.ID {
		t.Errorf("replace: %+v %q", res, bg.Content)
	}
	if page.tab(page.active).Content != "# Initial\n" {
		t.Error("the active tab must not change")
	}
}

func TestWritesToAnUnknownTabAreNotFound(t *testing.T) {
	app, page := newRPCApp(t)
	genBefore := atomic.LoadUint64(&globalBufferGen)
	for _, c := range []struct {
		method string
		params interface{}
	}{
		{"buffer.set", ipc.BufferSetParams{TabID: "bogus", Content: "x"}},
		{"buffer.append", ipc.BufferAppendParams{TabID: "bogus", Content: "x"}},
		{"buffer.replace", ipc.BufferReplaceParams{TabID: "bogus", Content: "x", StartLine: 1, StartCol: 1, EndLine: 1, EndCol: 1}},
		{"buffer.save", ipc.BufferSaveParams{TabID: "bogus", Path: filepath.Join(t.TempDir(), "x.md")}},
		{"tab.switch", map[string]string{"tab_id": "bogus"}},
		{"tab.close", ipc.TabCloseParams{TabID: "bogus"}},
	} {
		msg := mustFail(t, rpc(t, app, c.method, c.params), ipc.ErrCodeNotFound)
		if !strings.Contains(msg, "no such tab: bogus") {
			t.Errorf("%s: message %q", c.method, msg)
		}
	}
	if atomic.LoadUint64(&globalBufferGen) != genBefore {
		t.Error("a failed write must not count as a write")
	}
	if page.tab(page.active).Content != "# Initial\n" {
		t.Error("a failed write changed the active tab")
	}
}

func TestBufferSetOptimisticLockIsOneCallToThePage(t *testing.T) {
	app, page := newRPCApp(t)
	hash := computeHash("# Initial\n")

	mustOK(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{Content: "v2", ExpectedHash: hash}))
	if got := page.callNames(); len(got) != 1 || got[0] != "writeText" {
		t.Fatalf("calls into the page = %v: the check and the write must be ONE call (no getBuffer pre-check)", got)
	}
	if page.tab(page.active).Content != "v2" {
		t.Fatal("the write did not happen")
	}

	// A stale hash: -32001 with the message the CLI has always shown, and nothing written.
	msg := mustFail(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{Content: "v3", ExpectedHash: hash}), ipc.ErrCodeConflict)
	want := fmt.Sprintf("conflict: expected hash %s but buffer is at %s", hash, computeHash("v2"))
	if msg != want {
		t.Errorf("message = %q, want %q", msg, want)
	}
	if page.tab(page.active).Content != "v2" {
		t.Error("a refused write changed the note")
	}
}

func TestBufferSetLockOnABackgroundTab(t *testing.T) {
	app, page := newRPCApp(t)
	bg := page.addTab(&fakeTab{Title: "Bg.md", Content: "base"})
	stale := computeHash("base")
	mustOK(t, rpc(t, app, "buffer.append", ipc.BufferAppendParams{TabID: bg.ID, Content: "+"}))
	mustFail(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{TabID: bg.ID, Content: "mine", ExpectedHash: stale}), ipc.ErrCodeConflict)
	if bg.Content != "base+" {
		t.Errorf("content = %q", bg.Content)
	}
}

func TestBufferSetExpectedGeneration(t *testing.T) {
	app, page := newRPCApp(t)
	gen := atomic.LoadUint64(&globalBufferGen)

	msg := mustFail(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{Content: "x", ExpectedGeneration: gen + 100}), ipc.ErrCodeConflict)
	if msg != fmt.Sprintf("conflict: expected generation %d but buffer is at %d", gen+100, gen) {
		t.Errorf("message = %q", msg)
	}
	if page.tab(page.active).Content != "# Initial\n" {
		t.Error("nothing may be written on a conflict")
	}
	if atomic.LoadUint64(&globalBufferGen) != gen {
		t.Error("a refused write must not bump the generation")
	}
	res := mustOK(t, rpc(t, app, "buffer.set", ipc.BufferSetParams{Content: "x", ExpectedGeneration: gen})).(*ipc.BufferWriteResult)
	if res.Generation != gen+1 {
		t.Errorf("generation = %d", res.Generation)
	}
}

func TestBufferGenerationCountsRPCWritesExactlyUnderConcurrency(t *testing.T) {
	app, page := newRPCApp(t)
	page.tab(page.active).Content = ""
	genBefore := atomic.LoadUint64(&globalBufferGen)

	const n = 24
	var wg sync.WaitGroup
	gens := make(chan uint64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp := rpc(t, app, "buffer.append", ipc.BufferAppendParams{Content: fmt.Sprintf("<%d>", i)})
			if resp.Error != nil {
				t.Errorf("append %d: %v", i, resp.Error)
				return
			}
			gens <- resp.Result.(*ipc.BufferWriteResult).Generation
		}(i)
	}
	wg.Wait()
	close(gens)
	seen := map[uint64]bool{}
	for g := range gens {
		if seen[g] {
			t.Errorf("generation %d was handed out twice", g)
		}
		seen[g] = true
	}
	if got := atomic.LoadUint64(&globalBufferGen); got != genBefore+n {
		t.Errorf("generation = %d, want %d", got, genBefore+n)
	}
	content := page.tab(page.active).Content
	for i := 0; i < n; i++ {
		if !strings.Contains(content, fmt.Sprintf("<%d>", i)) {
			t.Errorf("append %d is missing from %q", i, content)
		}
	}
}

func TestWriteParamErrorsAreInvalidParams(t *testing.T) {
	app, _ := newRPCApp(t)
	for _, m := range []string{"buffer.set", "buffer.append", "buffer.replace"} {
		// no params at all
		msg := mustFail(t, app.DispatchRPCOperation(&ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: m}), ipc.ErrCodeInvalidParams)
		if !strings.HasPrefix(msg, "invalid "+m+" params") {
			t.Errorf("%s: %q", m, msg)
		}
		// a tab id that is not a string (older docs said "int, active or nil")
		msg = mustFail(t, rpc(t, app, m, map[string]interface{}{"content": "x", "tab_id": 3}), ipc.ErrCodeInvalidParams)
		if !strings.Contains(msg, "tab_id") {
			t.Errorf("%s: the message should name tab_id, got %q", m, msg)
		}
	}
}

func TestReadsAndSwitchRefuseANonStringTabID(t *testing.T) {
	app, page := newRPCApp(t)
	for _, m := range []string{"buffer.get", "buffer.get_selection", "tab.switch"} {
		// a number used to be read as "no tab" and quietly act on the active tab
		msg := mustFail(t, rpc(t, app, m, map[string]interface{}{"tab_id": 3}), ipc.ErrCodeInvalidParams)
		if !strings.HasPrefix(msg, "invalid "+m+" params") || !strings.Contains(msg, "tab_id") {
			t.Errorf("%s: message = %q", m, msg)
		}
	}
	if got := page.callNames(); len(got) != 0 {
		t.Errorf("the page was asked %v", got)
	}
}

func TestTabSwitchNeedsAnID(t *testing.T) {
	app, page := newRPCApp(t)
	bg := page.addTab(&fakeTab{Title: "Bg.md"})
	msg := mustFail(t, rpc(t, app, "tab.switch", map[string]string{}), ipc.ErrCodeInvalidParams)
	if msg != "tab_id is required" {
		t.Errorf("message = %q", msg)
	}
	mustOK(t, rpc(t, app, "tab.switch", map[string]string{"tab_id": bg.ID}))
	if page.active != bg.ID {
		t.Error("the tab was not switched")
	}
}

// ---- buffer.save --------------------------------------------------------------------------------

func TestBufferSaveNewFileBindsTheTab(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "# メモ\nbody\n"
	dir := t.TempDir()
	target := filepath.Join(dir, "saved note.md")

	res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target})).(*ipc.BufferSaveResult)
	if res.Path != target || res.Bytes != len("# メモ\nbody\n") || !res.Created || res.Encoding != "UTF-8" || res.TabID != tab.ID {
		t.Errorf("result = %+v", res)
	}
	if res.Hash != computeHash("# メモ\nbody\n") {
		t.Errorf("hash = %s (must be the hash buffer.get reports)", res.Hash)
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "# メモ\nbody\n" {
		t.Fatalf("file = %q, %v", raw, err)
	}
	if tab.Path != target || tab.Title != "saved note.md" || tab.Dirty || tab.Encoding != "UTF-8" {
		t.Errorf("tab not bound: %+v", tab)
	}
	if got := page.callNames(); len(got) != 2 || got[0] != "prepareSave" || got[1] != "commitSave" {
		t.Errorf("calls = %v", got)
	}

	// The same path again is the tab's own file: no overwrite flag needed, and it is not "created".
	tab.Content += "more\n"
	res = mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target})).(*ipc.BufferSaveResult)
	if res.Created {
		t.Error("the file existed")
	}
	if raw, _ := os.ReadFile(target); string(raw) != "# メモ\nbody\nmore\n" {
		t.Errorf("file = %q", raw)
	}
	// ...and with no path at all: the bound file
	tab.Content += "again\n"
	res = mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{})).(*ipc.BufferSaveResult)
	if res.Path != target {
		t.Errorf("path = %q, want the bound file", res.Path)
	}
	if raw, _ := os.ReadFile(target); !strings.HasSuffix(string(raw), "again\n") {
		t.Errorf("file = %q", raw)
	}
}

func TestBufferSaveUnboundTabWithoutPathIsRefused(t *testing.T) {
	app, page := newRPCApp(t)
	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{}), ipc.ErrCodeInvalidParams)
	if msg != "not saved: tab has no file: give --as <path>" {
		t.Errorf("message = %q", msg)
	}
	if tab := page.tab(page.active); tab.Path != "" {
		t.Error("nothing may be bound")
	}
	for _, c := range page.callNames() {
		if c == "commitSave" {
			t.Error("commitSave must not run after a refusal")
		}
	}
}

func TestBufferSaveOverwriteRule(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "new text"
	target := filepath.Join(t.TempDir(), "existing.md")
	if err := os.WriteFile(target, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}

	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target}), ipc.ErrCodeInvalidParams)
	if !strings.HasPrefix(msg, "not saved: refused overwrite:") {
		t.Errorf("message = %q", msg)
	}
	if raw, _ := os.ReadFile(target); string(raw) != "precious" {
		t.Errorf("the file was changed by a refused save: %q", raw)
	}
	if tab.Path != "" {
		t.Error("a refused save must not bind the tab")
	}

	res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target, Overwrite: true})).(*ipc.BufferSaveResult)
	if res.Created {
		t.Error("created should be false for an existing file")
	}
	if raw, _ := os.ReadFile(target); string(raw) != "new text" {
		t.Errorf("file = %q", raw)
	}
}

func TestBufferSaveAsToAnotherFileNeedsOverwriteOnlyWhenItExists(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.addTab(&fakeTab{Title: "a.md", Path: filepath.Join(t.TempDir(), "a.md"), Content: "text"})
	if err := os.WriteFile(tab.Path, []byte("text"), 0o644); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(filepath.Dir(tab.Path), "b.md")
	// a target that does not exist is fine without the flag: this is a Save As
	res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{TabID: tab.ID, Path: other})).(*ipc.BufferSaveResult)
	if !res.Created || tab.Path != other {
		t.Errorf("result %+v, tab path %q", res, tab.Path)
	}
	// a third file, then save the tab (now bound to b.md) over a.md: a.md exists and is not its own
	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{TabID: tab.ID, Path: filepath.Join(filepath.Dir(other), "a.md")}), ipc.ErrCodeInvalidParams)
	if !strings.Contains(msg, "refused overwrite") {
		t.Errorf("message = %q", msg)
	}
}

func TestBufferSavePathRefusalsAreInvalidParamsThatNameTheRule(t *testing.T) {
	app, page := newRPCApp(t)
	dir := t.TempDir()
	cases := []struct {
		name, path, want string
	}{
		{"relative", "notes.md", "absolute"},
		{"UNC", `\\host\share\x.md`, "network"},
		{"forward UNC", "//host/share/x.md", "network"},
		{"device", filepath.Join(dir, "NUL.md"), "device name"},
		{"stream", filepath.Join(dir, "x.md:stream"), "colon"},
		{"extension", filepath.Join(dir, "x.docx"), ".md, .markdown, .txt"},
		{"missing folder", filepath.Join(dir, "nope", "x.md"), "does not exist"},
	}
	if err := os.Mkdir(filepath.Join(dir, "adir.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases = append(cases, struct{ name, path, want string }{"directory with extension", filepath.Join(dir, "adir.md"), "is a folder"})
	for _, c := range cases {
		msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: c.path, Overwrite: true}), ipc.ErrCodeInvalidParams)
		if !strings.HasPrefix(msg, "not saved: ") || !strings.Contains(msg, c.want) {
			t.Errorf("%s: message %q should start with 'not saved: ' and mention %q", c.name, msg, c.want)
		}
	}
	if page.tab(page.active).Path != "" {
		t.Error("nothing may be bound after refusals")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 { // only adir.md
		t.Errorf("the folder was touched: %d entries", len(entries))
	}
}

func TestBufferSaveEncodings(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "日本語のメモ\nabc\n"
	dir := t.TempDir()

	// utf-8 by default
	res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: filepath.Join(dir, "u.md")})).(*ipc.BufferSaveResult)
	if res.Encoding != "UTF-8" {
		t.Errorf("encoding = %s", res.Encoding)
	}

	// Shift_JIS under every spelling
	for i, name := range []string{"sjis", "shift_jis", "Shift-JIS", "CP932", "SJIS"} {
		p := filepath.Join(dir, fmt.Sprintf("s%d.txt", i))
		res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{TabID: tab.ID, Path: p, Encoding: name, Overwrite: true})).(*ipc.BufferSaveResult)
		if res.Encoding != "Shift_JIS" {
			t.Errorf("%s: encoding = %s", name, res.Encoding)
		}
		raw, _ := os.ReadFile(p)
		back, err := encoding.DecodeWith(raw, "Shift_JIS")
		if err != nil || back != tab.Content {
			t.Errorf("%s: file decodes to %q, %v", name, back, err)
		}
		if res.Bytes != len(raw) {
			t.Errorf("%s: bytes = %d, file has %d", name, res.Bytes, len(raw))
		}
		if tab.Encoding != "Shift_JIS" {
			t.Errorf("%s: the tab keeps the encoding it was saved with, got %s", name, tab.Encoding)
		}
	}
}

func TestBufferSaveKeepsTheEncodingOfABoundTabUnlessNamed(t *testing.T) {
	app, page := newRPCApp(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy.txt")
	tab := page.addTab(&fakeTab{Title: "legacy.txt", Path: path, Encoding: "Shift_JIS", Content: "日本語\n"})
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{TabID: tab.ID})).(*ipc.BufferSaveResult)
	if res.Encoding != "Shift_JIS" {
		t.Errorf("encoding = %s, want the tab's own", res.Encoding)
	}
	raw, _ := os.ReadFile(path)
	if back, _ := encoding.DecodeWith(raw, "Shift_JIS"); back != "日本語\n" || string(raw) == "日本語\n" {
		t.Errorf("file bytes %x are not Shift_JIS", raw)
	}

	res = mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{TabID: tab.ID, Encoding: "utf-8"})).(*ipc.BufferSaveResult)
	if res.Encoding != "UTF-8" {
		t.Errorf("an explicit encoding wins, got %s", res.Encoding)
	}
	if raw, _ := os.ReadFile(path); string(raw) != "日本語\n" {
		t.Errorf("file = %x", raw)
	}
	if tab.Encoding != "UTF-8" {
		t.Errorf("the tab now has encoding %s", tab.Encoding)
	}
}

func TestBufferSaveUnrepresentableCharacterIsRefusedAndNothingIsWritten(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "ok\nrobot \U0001F916 here"
	target := filepath.Join(t.TempDir(), "sjis.md")

	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target, Encoding: "sjis"}), ipc.ErrCodeInvalidParams)
	for _, want := range []string{"not saved:", "unrepresentable character", "U+1F916 at line 2, column 7"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "\U0001F916") || strings.Contains(msg, "robot") {
		t.Errorf("the message must not quote note content: %q", msg)
	}
	if _, err := os.Stat(target); err == nil {
		t.Error("the file must not exist")
	}
	if tab.Path != "" {
		t.Error("the tab must not be bound")
	}
	// the same text saves fine as UTF-8
	mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target, Encoding: "utf-8"}))
}

func TestBufferSaveUnknownEncodingIsRefusedBeforeAskingThePage(t *testing.T) {
	app, page := newRPCApp(t)
	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: filepath.Join(t.TempDir(), "x.md"), Encoding: "latin1"}), ipc.ErrCodeInvalidParams)
	if !strings.HasPrefix(msg, "not saved: unknown encoding") || !strings.Contains(msg, "utf-8 or sjis") {
		t.Errorf("message = %q", msg)
	}
	if got := page.callNames(); len(got) != 0 {
		t.Errorf("the page was asked %v", got)
	}
}

func TestBufferSaveEditedDuringTheSaveIsAConflictAndBindsNothing(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "text when the save began"
	target := filepath.Join(t.TempDir(), "race.md")
	page.beforeCommit = func(p *fakePage) { p.tab(tab.ID).Content += " + the user typed" }

	msg := mustFail(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target}), ipc.ErrCodeConflict)
	for _, want := range []string{"the file was written but the tab was not bound", "edited while it was being saved"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "text when the save began" {
		t.Errorf("the file holds %q, %v; it must hold the text from before the edit", raw, err)
	}
	if tab.Path != "" {
		t.Error("the tab must not be bound")
	}
	if !strings.Contains(tab.Content, "the user typed") {
		t.Error("the user's edit must not be lost")
	}
}

func TestBufferSaveWritesAtomicallyAndKeepsPermissions(t *testing.T) {
	app, page := newRPCApp(t)
	tab := page.tab(page.active)
	tab.Content = "replacement"
	dir := t.TempDir()
	target := filepath.Join(dir, "private.md")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustOK(t, rpc(t, app, "buffer.save", ipc.BufferSaveParams{Path: target, Overwrite: true}))
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o600 {
			t.Errorf("mode = %v, want 0600 kept", fi.Mode().Perm())
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temporary file left behind: %s", e.Name())
		}
	}
}

func TestBufferSaveTriggersTheGitSyncLikeTheGUISave(t *testing.T) {
	src, err := os.ReadFile("app_rpc_write.go")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(src), "\r\n", "\n")
	start := strings.Index(text, "func (a *App) rpcBufferSave(")
	end := strings.Index(text[start:], "\n}\n")
	body := text[start : start+end]
	save := strings.Index(body, "notesave.Save(")
	sync := strings.Index(body, "a.TriggerGitSync()")
	commit := strings.Index(body, `"commitSave"`)
	if save < 0 || sync < 0 || commit < 0 || !(save < sync && sync < commit) {
		t.Errorf("rpcBufferSave must call TriggerGitSync after the file is written and before the tab is bound (save=%d sync=%d commit=%d)", save, sync, commit)
	}
	// and the GUI's SaveFile does the same, which is what this mirrors
	files, _ := os.ReadFile("app_files.go")
	if !strings.Contains(string(files), "a.TriggerGitSync()") {
		t.Error("app_files.go no longer calls TriggerGitSync in SaveFile")
	}
}

// ---- tab.new ------------------------------------------------------------------------------------

func TestTabNewNewNoteAndBackground(t *testing.T) {
	app, page := newRPCApp(t)
	activeBefore := page.active

	res := mustOK(t, rpc(t, app, "tab.new", ipc.TabNewParams{Title: "Scratch.md", Background: true})).(*ipc.TabNewResult)
	if res.ID == "" || res.Title != "Scratch.md" || res.Path != "" || res.Existing {
		t.Errorf("result = %+v", res)
	}
	if page.active != activeBefore {
		t.Error("background must not select the new tab")
	}
	if got := page.specs[len(page.specs)-1]; got["background"] != true || got["title"] != "Scratch.md" {
		t.Errorf("spec = %v", got)
	}
	if _, has := page.specs[len(page.specs)-1]["content"]; has {
		t.Error("without content the page uses its usual new-note header")
	}

	res = mustOK(t, rpc(t, app, "tab.new", map[string]interface{}{"content": ""})).(*ipc.TabNewResult)
	if page.active != res.ID {
		t.Error("without background the new tab is shown")
	}
	if c, ok := page.specs[len(page.specs)-1]["content"]; !ok || c != "" {
		t.Errorf("content \"\" must reach the page as an empty note, got %v", page.specs[len(page.specs)-1])
	}
	if page.tab(res.ID).Content != "" {
		t.Errorf("content = %q", page.tab(res.ID).Content)
	}
}

func TestTabNewFromAFileReadsAndDecodesIt(t *testing.T) {
	app, page := newRPCApp(t)
	dir := t.TempDir()
	utf := filepath.Join(dir, "Note.md")
	if err := os.WriteFile(utf, []byte("\xEF\xBB\xBF# 見出し\r\nbody\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sjisBytes, _ := encoding.Encode("日本語のメモ\n", "Shift_JIS")
	sjis := filepath.Join(dir, "legacy.txt")
	if err := os.WriteFile(sjis, sjisBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	res := mustOK(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: utf, Background: true})).(*ipc.TabNewResult)
	if res.Path != utf || res.Title != "Note.md" || res.Existing {
		t.Errorf("result = %+v", res)
	}
	if tab := page.tab(res.ID); tab.Content != "# 見出し\r\nbody\r\n" || tab.Encoding != "UTF-8" {
		t.Errorf("tab = %+v (BOM removed, text as it is on disk)", tab)
	}

	res = mustOK(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: sjis, Title: "Custom.txt", Background: true})).(*ipc.TabNewResult)
	tab := page.tab(res.ID)
	if tab.Content != "日本語のメモ\n" || tab.Encoding != "Shift_JIS" || res.Title != "Custom.txt" {
		t.Errorf("tab = %+v, result %+v", tab, res)
	}

	// the same file again: no second tab
	count := len(page.tabs)
	again := mustOK(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: utf, Background: true})).(*ipc.TabNewResult)
	if !again.Existing || again.Path != utf {
		t.Errorf("second open: %+v", again)
	}
	if len(page.tabs) != count {
		t.Error("a file that is open must not get a second tab")
	}
}

func TestTabNewRefusals(t *testing.T) {
	app, _ := newRPCApp(t)
	dir := t.TempDir()
	content := "x"

	msg := mustFail(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: filepath.Join(dir, "a.md"), Content: &content}), ipc.ErrCodeInvalidParams)
	if msg != "give path or content, not both" {
		t.Errorf("message = %q", msg)
	}
	for path, want := range map[string]string{
		"relative.md":                "absolute",
		`\\host\share\a.md`:          "network",
		"//host/share/a.md":          "network",
		filepath.Join(dir, "x.md:s"): "colon",
	} {
		msg := mustFail(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: path}), ipc.ErrCodeInvalidParams)
		if !strings.Contains(msg, want) {
			t.Errorf("%q: message %q should mention %q", path, msg, want)
		}
	}
	msg = mustFail(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: filepath.Join(dir, "missing.md")}), ipc.ErrCodeNotFound)
	if !strings.HasPrefix(msg, "no such file: ") {
		t.Errorf("message = %q", msg)
	}
	msg = mustFail(t, rpc(t, app, "tab.new", ipc.TabNewParams{Path: dir}), ipc.ErrCodeInvalidParams)
	if !strings.Contains(msg, "is a folder") {
		t.Errorf("message = %q", msg)
	}
	mustFail(t, rpc(t, app, "tab.new", map[string]interface{}{"path": 5}), ipc.ErrCodeInvalidParams)
}

func TestReadNoteFileErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := readNoteFile(filepath.Join(dir, "nope.md")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing file: %v", err)
	}
	if _, err := readNoteFile(dir); !errors.Is(err, errIsDirectory) {
		t.Errorf("directory: %v", err)
	}
	p := filepath.Join(dir, "a.md")
	_ = os.WriteFile(p, []byte("hi"), 0o644)
	f, err := readNoteFile(p)
	if err != nil || f.Content != "hi" || f.Path != p || f.Title != "a.md" || f.Encoding != "UTF-8" {
		t.Errorf("file = %+v, %v", f, err)
	}
}

// ---- tab.close ----------------------------------------------------------------------------------

func TestTabCloseParams(t *testing.T) {
	app, _ := newRPCApp(t)
	msg := mustFail(t, rpc(t, app, "tab.close", map[string]interface{}{}), ipc.ErrCodeInvalidParams)
	if msg != "tab_id is required" {
		t.Errorf("message = %q", msg)
	}
	mustFail(t, app.DispatchRPCOperation(&ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "tab.close"}), ipc.ErrCodeInvalidParams)
	mustFail(t, rpc(t, app, "tab.close", map[string]interface{}{"tab_id": 4}), ipc.ErrCodeInvalidParams)
}

func TestTabCloseResults(t *testing.T) {
	app, page := newRPCApp(t)

	clean := page.addTab(&fakeTab{Title: "clean.md", Content: "c"})
	res := mustOK(t, rpc(t, app, "tab.close", ipc.TabCloseParams{TabID: clean.ID})).(*ipc.TabCloseResult)
	if !res.Closed || res.Reason != "" || page.tab(clean.ID) != nil {
		t.Errorf("clean: %+v", res)
	}

	dirty := page.addTab(&fakeTab{Title: "dirty.md", Content: "d", Dirty: true})
	res = mustOK(t, rpc(t, app, "tab.close", ipc.TabCloseParams{TabID: dirty.ID})).(*ipc.TabCloseResult)
	if res.Closed || res.Reason != "prompt" || page.tab(dirty.ID) == nil || page.closePrompts != 1 {
		t.Errorf("dirty: %+v prompts=%d", res, page.closePrompts)
	}

	saved := page.addTab(&fakeTab{Title: "saved.md", Path: "/n/saved.md", Content: "s", Dirty: true})
	page.disk["/n/saved.md"] = "s"
	res = mustOK(t, rpc(t, app, "tab.close", ipc.TabCloseParams{TabID: saved.ID, IfSaved: true})).(*ipc.TabCloseResult)
	if !res.Closed || page.tab(saved.ID) != nil {
		t.Errorf("if_saved identical: %+v", res)
	}

	differs := page.addTab(&fakeTab{Title: "differs.md", Path: "/n/differs.md", Content: "mine"})
	page.disk["/n/differs.md"] = "theirs"
	res = mustOK(t, rpc(t, app, "tab.close", ipc.TabCloseParams{TabID: differs.ID, IfSaved: true})).(*ipc.TabCloseResult)
	if res.Closed || res.Reason != "unsaved" || page.tab(differs.ID) == nil {
		t.Errorf("if_saved different: %+v", res)
	}
	data, _ := json.Marshal(res)
	if string(data) != `{"closed":false,"reason":"unsaved"}` {
		t.Errorf("JSON = %s", data)
	}
	closed, _ := json.Marshal(&ipc.TabCloseResult{Closed: true})
	if string(closed) != `{"closed":true}` {
		t.Errorf("JSON = %s", closed)
	}

	noFile := page.addTab(&fakeTab{Title: "nofile.md", Content: "n"})
	res = mustOK(t, rpc(t, app, "tab.close", ipc.TabCloseParams{TabID: noFile.ID, IfSaved: true})).(*ipc.TabCloseResult)
	if res.Closed || res.Reason != "unsaved" {
		t.Errorf("if_saved without a file: %+v", res)
	}
}

// ---- the param structs --------------------------------------------------------------------------

func TestNewMethodParamDecoding(t *testing.T) {
	var save ipc.BufferSaveParams
	if err := json.Unmarshal([]byte(`{"tab_id":"tab_1","path":"C:\\x\\a.md","encoding":"sjis","overwrite":true}`), &save); err != nil {
		t.Fatal(err)
	}
	if save.TabID != "tab_1" || save.Path != `C:\x\a.md` || save.Encoding != "sjis" || !save.Overwrite {
		t.Errorf("save = %+v", save)
	}
	var nw ipc.TabNewParams
	if err := json.Unmarshal([]byte(`{"title":"T","path":"/a.md","background":true}`), &nw); err != nil {
		t.Fatal(err)
	}
	if nw.Title != "T" || nw.Path != "/a.md" || !nw.Background || nw.Content != nil {
		t.Errorf("new = %+v", nw)
	}
	if err := json.Unmarshal([]byte(`{"content":""}`), &nw); err != nil || nw.Content == nil || *nw.Content != "" {
		t.Errorf("an empty content must be distinguishable from no content: %+v %v", nw, err)
	}
	var cl ipc.TabCloseParams
	if err := json.Unmarshal([]byte(`{"tab_id":"tab_2","if_saved":true}`), &cl); err != nil || cl.TabID != "tab_2" || !cl.IfSaved {
		t.Errorf("close = %+v %v", cl, err)
	}
	var set ipc.BufferSetParams
	if err := json.Unmarshal([]byte(`{"content":"c","tab_id":"tab_3","expected_hash":"h","expected_generation":4}`), &set); err != nil ||
		set.TabID != "tab_3" || set.ExpectedHash != "h" || set.ExpectedGeneration != 4 {
		t.Errorf("set = %+v %v", set, err)
	}
	var rep ipc.BufferReplaceParams
	if err := json.Unmarshal([]byte(`{"content":"c","tab_id":"tab_3","start_line":2,"start_col":3,"end_line":4,"end_col":5}`), &rep); err != nil ||
		rep.TabID != "tab_3" || rep.StartLine != 2 || rep.EndCol != 5 {
		t.Errorf("replace = %+v %v", rep, err)
	}
}

func TestSaveResultJSONShape(t *testing.T) {
	data, _ := json.Marshal(&ipc.BufferSaveResult{TabID: "t", Path: "/p.md", Bytes: 3, Hash: "h", Encoding: "UTF-8", Created: true})
	var m map[string]interface{}
	_ = json.Unmarshal(data, &m)
	for _, k := range []string{"tab_id", "path", "bytes", "hash", "encoding", "created"} {
		if _, ok := m[k]; !ok {
			t.Errorf("buffer.save result lacks %q: %s", k, data)
		}
	}
	data, _ = json.Marshal(&ipc.TabNewResult{ID: "t", Title: "T", Path: "", Existing: false})
	m = nil
	_ = json.Unmarshal(data, &m)
	for _, k := range []string{"id", "title", "path", "existing"} {
		if _, ok := m[k]; !ok {
			t.Errorf("tab.new result lacks %q: %s", k, data)
		}
	}
}
