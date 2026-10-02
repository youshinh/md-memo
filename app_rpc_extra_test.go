package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"md-memo/pkg/appdir"
	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
)

// ---- helpers ---------------------------------------------------------------------------------------------------------------------

func rpcDo(app *App, method string, params interface{}) *ipc.RPCResponse {
	raw, _ := json.Marshal(params)
	if params == nil {
		raw = nil
	}
	return app.DispatchRPCOperation(&ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: raw})
}

// rpcOK asserts success and returns the result as a generic object.
func rpcOK(t *testing.T, resp *ipc.RPCResponse) map[string]interface{} {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	raw, _ := json.Marshal(resp.Result)
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("result is not an object: %s", raw)
	}
	return out
}

func rpcErr(t *testing.T, resp *ipc.RPCResponse, code int, contains string) {
	t.Helper()
	if resp.Error == nil {
		t.Fatalf("want error %d (%q), got result %v", code, contains, resp.Result)
	}
	if resp.Error.Code != code || !strings.Contains(resp.Error.Message, contains) {
		t.Errorf("error = %d %q, want %d containing %q", resp.Error.Code, resp.Error.Message, code, contains)
	}
}

func num(m map[string]interface{}, k string) int { f, _ := m[k].(float64); return int(f) }

// scrapConfig writes a config.json (into the temp settings folder TestMain made) that points the scraps at a fresh folder.
func scrapConfig(t *testing.T, extra map[string]interface{}) (scrapDir string) {
	t.Helper()
	scrapDir = filepath.Join(t.TempDir(), "scraps")
	cfg := map[string]interface{}{"scraps": map[string]interface{}{"scrapDir": scrapDir}}
	for k, v := range extra {
		cfg[k] = v
	}
	if err := os.MkdirAll(appdir.AppConfigDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(cfg)
	path := appdir.ConfigFilePath()
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
	return scrapDir
}

func writeScrap(t *testing.T, dir, name, text string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// pageMock stands in for the page: it answers the window.__mdMemoRPC calls of the new methods and records them.
type pageMock struct {
	app     *App
	mu      sync.Mutex
	handler func(fn string, args []json.RawMessage) (result string, errText string)
	calls   []string // "fn(args)"
}

var pageCallRE = regexp.MustCompile(`__mdMemoRPC\.(\w+)\((.*)\)\)\(\)$`)

func (m *pageMock) Dispatch(f func()) { go f() }

func (m *pageMock) Eval(js string) {
	code := js
	if i := strings.Index(js, "const code = "); i != -1 {
		rest := js[i+13:]
		if end := strings.Index(rest, ";\n"); end != -1 {
			var unq string
			if json.Unmarshal([]byte(rest[:end]), &unq) == nil {
				code = unq
			}
		}
	}
	reqID := extractReqID(js)
	match := pageCallRE.FindStringSubmatch(code)
	if match == nil {
		_, _ = m.app.ReportRPCResult(reqID, "true", "")
		return
	}
	var args []json.RawMessage
	if strings.TrimSpace(match[2]) != "" {
		if err := json.Unmarshal([]byte("["+match[2]+"]"), &args); err != nil {
			_, _ = m.app.ReportRPCResult(reqID, "", "mock: bad args: "+err.Error())
			return
		}
	}
	m.mu.Lock()
	m.calls = append(m.calls, match[1]+"("+match[2]+")")
	h := m.handler
	m.mu.Unlock()
	res, errText := h(match[1], args)
	_, _ = m.app.ReportRPCResult(reqID, res, errText)
}

func (m *pageMock) lastCall() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.calls) == 0 {
		return ""
	}
	return m.calls[len(m.calls)-1]
}

func newPageApp(t *testing.T, h func(fn string, args []json.RawMessage) (string, string)) (*App, *pageMock) {
	t.Helper()
	app := &App{scrapDir: filepath.Join(t.TempDir(), "scraps")}
	m := &pageMock{app: app, handler: h}
	app.w = m
	return app, m
}

// bufferPage is a page with one note (tab_1) that answers getBuffer and writeText the way app.js does.
type bufferPage struct {
	mu         sync.Mutex
	content    string
	writes     int
	afterRead  func() // runs after getBuffer answered: the person typing between the read and the write
	lastWrite  map[string]interface{}
	editedOnce bool
}

func (b *bufferPage) handle(fn string, args []json.RawMessage) (string, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch fn {
	case "getBuffer":
		var id string
		_ = json.Unmarshal(args[0], &id)
		if id != "" && id != "tab_1" {
			return "", "[not_found] no such tab: " + id
		}
		out, _ := json.Marshal(map[string]interface{}{"tabId": "tab_1", "title": "n.md", "path": "", "content": b.content, "length": len(b.content), "lineCount": 1, "isActive": true})
		if b.afterRead != nil && !b.editedOnce {
			b.editedOnce = true
			b.afterRead()
		}
		return string(out), ""
	case "writeText":
		var req map[string]interface{}
		_ = json.Unmarshal(args[0], &req)
		b.lastWrite = req
		prev := computeHash(b.content)
		if h, _ := req["expectedHash"].(string); h != "" && h != prev {
			return "", "[conflict] conflict: expected hash " + h + " but buffer is at " + prev
		}
		text, _ := req["content"].(string)
		switch req["mode"] {
		case "set":
			b.content = text
		case "append":
			b.content += text
		}
		b.writes++
		out, _ := json.Marshal(map[string]interface{}{"tab_id": "tab_1", "previous_hash": prev, "hash": computeHash(b.content)})
		return string(out), ""
	}
	return "", "mock: unexpected " + fn
}

// ---- where things are --------------------------------------------------------------------------------------------------------------

func TestRPCAppInfoAndConfigGetAnswerLikeTheCLI(t *testing.T) {
	scrapDir := scrapConfig(t, map[string]interface{}{
		"vision": map[string]interface{}{"baseUrl": "https://api.example.com", "apiKey": "sk-very-secret"},
	})
	app := &App{}
	info := rpcOK(t, rpcDo(app, "app.info", nil))
	want := cli.Info(AppVersion, true)
	if info["version"] != AppVersion || info["scrap_dir"] != want.ScrapDir || info["gui_running"] != true || info["scrap_dir"] != scrapDir {
		t.Errorf("app.info = %v", info)
	}
	for _, v := range info {
		if s, ok := v.(string); ok && strings.Contains(s, "sk-very-secret") {
			t.Errorf("a secret in app.info: %v", info)
		}
	}

	whole := rpcOK(t, rpcDo(app, "config.get", nil))
	raw, _ := json.Marshal(whole)
	vision, _ := whole["value"].(map[string]interface{})["vision"].(map[string]interface{})
	if strings.Contains(string(raw), "sk-very-secret") || vision["apiKey"] != "<set>" {
		t.Errorf("config.get must hide every key: %s", raw)
	}
	one := rpcOK(t, rpcDo(app, "config.get", map[string]string{"key": "scraps.scrapDir"}))
	if one["key"] != "scraps.scrapDir" || one["value"] != scrapDir {
		t.Errorf("one value: %v", one)
	}
	rpcErr(t, rpcDo(app, "config.get", map[string]string{"key": "no.such.key"}), ipc.ErrCodeInvalidParams, "no such key")
	rpcErr(t, rpcDo(app, "config.get", "not an object"), ipc.ErrCodeInvalidParams, "invalid config.get params")
}

func TestRPCScrapPathListAndSearchMatchTheCLI(t *testing.T) {
	scrapDir := scrapConfig(t, nil)
	writeScrap(t, scrapDir, "2026-09-01.md", "# a\n竹の話。建材にする。\n")
	writeScrap(t, scrapDir, "2026-09-02.md", "# b\n納期の話。図面は来週。\n")
	app := &App{}

	p := rpcOK(t, rpcDo(app, "scrap.path", map[string]string{"date": "2026-09-01"}))
	if p["date"] != "2026-09-01" || p["exists"] != true || filepath.Base(p["path"].(string)) != "2026-09-01.md" {
		t.Errorf("scrap.path = %v", p)
	}
	if q := rpcOK(t, rpcDo(app, "scrap.path", map[string]string{"date": "2026-01-01"})); q["exists"] != false {
		t.Errorf("a day with no file: %v", q)
	}
	rpcErr(t, rpcDo(app, "scrap.path", map[string]string{"date": "2026-13-01"}), ipc.ErrCodeInvalidParams, "invalid date")

	list := rpcDo(app, "scrap.list", map[string]interface{}{"lines": true})
	raw, _ := json.Marshal(list.Result)
	var files []map[string]interface{}
	_ = json.Unmarshal(raw, &files)
	if len(files) != 2 || files[0]["date"] != "2026-09-02" || num(files[0], "lines") != 2 {
		t.Errorf("scrap.list = %s", raw)
	}
	if r := rpcDo(app, "scrap.list", map[string]string{"from": "2026-09-02"}); func() int {
		b, _ := json.Marshal(r.Result)
		var f []interface{}
		_ = json.Unmarshal(b, &f)
		return len(f)
	}() != 1 {
		t.Errorf("from: %v", r.Result)
	}
	rpcErr(t, rpcDo(app, "scrap.list", map[string]string{"from": "2026-09-05", "to": "2026-09-01"}), ipc.ErrCodeInvalidParams, "is after")

	s := rpcOK(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "建材"}))
	if num(s, "count") != 1 {
		t.Fatalf("scrap.search = %v", s)
	}
	m := s["matches"].([]interface{})[0].(map[string]interface{})
	if m["text"] != "竹の話。建材にする。" || num(m, "line") != 2 {
		t.Errorf("match = %v", m)
	}
	// every hit says how to cite it as a link (pkg/cli/links.go)
	if m["rel"] != "2026-09-01.md" || m["url"] != cli.FileURL(m["file"].(string)) || m["label"] != "2026-09-01 a" || !strings.HasPrefix(m["link"].(string), "[2026-09-01") || !strings.HasSuffix(m["link"].(string), "]("+m["url"].(string)+")") {
		t.Errorf("link fields of %v", m)
	}
	// the ranked search: words on any lines, and the limit counts notes
	r := rpcOK(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "納期 図面", "ranked": true}))
	if r["ranked"] != true || num(r, "count") != 1 {
		t.Errorf("ranked = %v", r)
	}
	// what the command prints for the same arguments is what the method returns
	cres, err := cli.ScrapSearch(context.Background(), cli.ScrapSearchParams{Text: "建材"})
	if err != nil || cres.Count != 1 || cres.Matches[0].Text != m["text"] {
		t.Errorf("CLI and RPC disagree: %+v %v", cres, err)
	}
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "  "}), ipc.ErrCodeInvalidParams, "search text required")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "limit": -1}), ipc.ErrCodeInvalidParams, "invalid --limit")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "kind": "note"}), ipc.ErrCodeInvalidParams, "needs --semantic")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "kind": 3}), ipc.ErrCodeInvalidParams, "kind must be")
	// the semantic search is off by default: the person has to switch it on, so this is -32602 and nothing was embedded or sent
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "semantic": true}), ipc.ErrCodeInvalidParams, "semantic search is off")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "semantic": true, "ranked": true}), ipc.ErrCodeInvalidParams, "cannot be combined")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "cutoff": 0.5}), ipc.ErrCodeInvalidParams, "needs --semantic")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "semantic": true, "cutoff": 2}), ipc.ErrCodeInvalidParams, "invalid --cutoff")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "x", "semantic": true, "kind": []string{"photo"}}), ipc.ErrCodeInvalidParams, "invalid --kind")
}

// ---- scrap.append: `cmd | md-memo` with a token -----------------------------------------------------------------------------------

func TestRPCScrapAppendIsThePipe(t *testing.T) {
	scrapDir := scrapConfig(t, nil)
	app := &App{scrapDir: scrapDir}

	first := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "line one\nline two\n", "title": "ping 8.8.8.8"}))
	path := first["path"].(string)
	if first["success"] != true || first["title"] != "ping 8.8.8.8" || num(first, "line") != 1 || filepath.Dir(path) != scrapDir {
		t.Fatalf("first append = %v", first)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), "---\n## [") || !strings.Contains(string(data), "] ping 8.8.8.8\n```text\nline one\nline two\n```\n") {
		t.Errorf("entry format (the pipe's): %q", data)
	}
	if num(first, "bytes") != len(data) {
		t.Errorf("bytes %d, file %d", num(first, "bytes"), len(data))
	}

	// the title is one line of a heading; the default is the pipe's
	second := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "x", "title": "a\n## [00:00:00] injected\n\n  title"}))
	if second["title"] != "a ## [00:00:00] injected title" {
		t.Errorf("title = %q", second["title"])
	}
	third := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "y"}))
	if third["title"] != "CLI Pipe" {
		t.Errorf("default title = %q", third["title"])
	}
	// where each entry starts, counted in the file (the number a caller reads around)
	all, _ := os.ReadFile(path)
	lines := strings.Split(string(all), "\n")
	for _, r := range []map[string]interface{}{first, second, third} {
		ln := num(r, "line")
		if ln < 1 || ln > len(lines) || lines[ln-1] != "---" || !strings.HasPrefix(lines[ln], "## [") {
			t.Errorf("line %d is %q, not the rule of the entry %v", ln, lines[ln-1], r["title"])
		}
	}
	if num(second, "line") <= num(first, "line") || num(third, "line") <= num(second, "line") {
		t.Errorf("lines must grow: %v %v %v", first["line"], second["line"], third["line"])
	}

	// raw bytes are decoded as the pipe decodes standard input: here Shift_JIS from a Japanese console
	sjis := []byte{0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA}
	b64 := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content_base64": base64.StdEncoding.EncodeToString(sjis), "title": "sjis"}))
	again, _ := os.ReadFile(b64["path"].(string))
	if !strings.Contains(string(again), "```text\n日本語\n```") {
		t.Errorf("Shift_JIS bytes were not decoded: %q", again)
	}
	// a BOM is not text
	bom := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content_base64": base64.StdEncoding.EncodeToString([]byte("\xEF\xBB\xBFbom text")), "title": "bom"}))
	again, _ = os.ReadFile(bom["path"].(string))
	if !strings.Contains(string(again), "```text\nbom text\n```") {
		t.Errorf("BOM kept: %q", again)
	}

	// refused calls write nothing: the file is as it was
	snapshot, _ := os.ReadFile(path)
	// format markdown: the content as it is, not in a text fence, so that a link in it stays clickable
	md := rpcOK(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "Summary ([2026-09-01](file:///C:/n/2026-09-01.md)).\n- one", "title": "Summary of 2 notes", "format": "markdown"}))
	mdData, _ := os.ReadFile(path)
	mdLines := strings.Split(string(mdData), "\n")
	if ln := num(md, "line"); mdLines[ln-1] != "---" || !strings.HasSuffix(mdLines[ln], "] Summary of 2 notes") || mdLines[ln+1] != "" || !strings.HasPrefix(mdLines[ln+2], "Summary ([2026-09-01](file:///") || strings.Contains(strings.Join(mdLines[ln-1:], "\n"), "```") {
		t.Errorf("markdown entry at line %d: %q", ln, mdLines[ln-1:])
	}
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "x", "format": "html"}), ipc.ErrCodeInvalidParams, `format must be`)
	snapshot, _ = os.ReadFile(path)
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{}), ipc.ErrCodeInvalidParams, "content or content_base64")
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "a", "content_base64": "YQ=="}), ipc.ErrCodeInvalidParams, "content or content_base64")
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": "  \n\t"}), ipc.ErrCodeInvalidParams, "nothing to append")
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{"content_base64": "***not base64***"}), ipc.ErrCodeInvalidParams, "not base64")
	rpcErr(t, rpcDo(app, "scrap.append", map[string]interface{}{"content": strings.Repeat("x", maxPipeBytes+1)}), ipc.ErrCodeInvalidParams, "10MB")
	if final, _ := os.ReadFile(path); string(final) != string(snapshot) {
		t.Errorf("a refused call changed the file")
	}
}

func TestRPCScrapOpenOpensTheDaysFile(t *testing.T) {
	scrapDir := scrapConfig(t, nil)
	writeScrap(t, scrapDir, "2026-09-01.md", "# a\nhello\n")
	var spec map[string]interface{}
	app, _ := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		if fn != "openTab" {
			return "", "unexpected " + fn
		}
		_ = json.Unmarshal(args[0], &spec)
		return `{"id":"tab_7","title":"2026-09-01.md","path":"x","existing":false}`, ""
	})
	res := rpcOK(t, rpcDo(app, "scrap.open", map[string]interface{}{"date": "2026-09-01", "background": true}))
	if res["id"] != "tab_7" || spec["background"] != true || filepath.Base(spec["path"].(string)) != "2026-09-01.md" || !strings.Contains(spec["content"].(string), "hello") {
		t.Errorf("result %v, spec %v", res, spec)
	}
	rpcErr(t, rpcDo(app, "scrap.open", map[string]interface{}{"date": "2026-01-01"}), 32002*-1, "no such file")
}

// ---- Git ---------------------------------------------------------------------------------------------------------------------------

func TestRPCGitStatusNeverShowsACredentialAndSyncNeedsTheSetting(t *testing.T) {
	scrapDir := scrapConfig(t, nil)
	app := &App{scrapDir: scrapDir}
	if err := os.MkdirAll(scrapDir, 0o755); err != nil {
		t.Fatal(err)
	}
	st := rpcOK(t, rpcDo(app, "git.status", nil))
	if st["is_git"] != false || st["sync_enabled"] != false || st["scrap_dir"] != scrapDir {
		t.Errorf("a plain folder: %v", st)
	}
	if got := rpcOK(t, rpcDo(app, "git.sync", nil)); got["triggered"] != false || !strings.Contains(got["reason"].(string), "not switched on") {
		t.Errorf("sync without the setting: %v", got)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	for _, args := range [][]string{{"init", "-q"}, {"remote", "add", "origin", "https://someone:hunter2-token@example.com/me/notes.git"}} {
		cmd := exec.Command("git", append([]string{"-C", scrapDir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git %v: %v %s", args, err, out)
		}
	}
	st = rpcOK(t, rpcDo(app, "git.status", nil))
	raw, _ := json.Marshal(st)
	if st["is_git"] != true || strings.Contains(string(raw), "hunter2") || !strings.Contains(st["remote_url"].(string), "example.com/me/notes.git") {
		t.Errorf("repo status: %s", raw)
	}
}

// ---- a command over some text -----------------------------------------------------------------------------------------------------

func TestRPCFilterRunIsGuardedLikeTheCommandBar(t *testing.T) {
	app := &App{}
	var ran []string
	old := runFilterCommand
	runFilterCommand = func(ctx context.Context, cmd, input string) (*CommandResult, error) {
		ran = append(ran, cmd+"<"+input)
		return &CommandResult{Output: "OUT:" + strings.ToUpper(input), Error: "", ExitCode: 0}, nil
	}
	t.Cleanup(func() { runFilterCommand = old })

	v := rpcOK(t, rpcDo(app, "filter.validate", map[string]string{"command": "sort"}))
	if v["safe"] != true || v["blocked"] != false {
		t.Errorf("validate sort: %v", v)
	}
	if v := rpcOK(t, rpcDo(app, "filter.validate", map[string]string{"command": "rm -rf /"})); v["blocked"] != true || v["reason"] == "" {
		t.Errorf("validate rm -rf /: %v", v)
	}
	if v := rpcOK(t, rpcDo(app, "filter.validate", map[string]string{"command": "rm temp.txt"})); v["warning"] != true {
		t.Errorf("validate rm: %v", v)
	}
	rpcErr(t, rpcDo(app, "filter.validate", map[string]string{"command": " "}), ipc.ErrCodeInvalidParams, "command is required")

	res := rpcOK(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "sort", "input": "b\na\n"}))
	if res["stdout"] != "OUT:B\nA\n" || num(res, "exit_code") != 0 || res["risk_level"] != "safe" || len(ran) != 1 {
		t.Errorf("a safe command: %v (ran %v)", res, ran)
	}
	// a blocked command never reaches the runner
	rpcErr(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "rm -rf /", "input": "x"}), ipc.ErrCodeInvalidParams, "refused by the command guard")
	// a warned one runs only when the caller says the person agreed
	rpcErr(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "rm temp.txt"}), ipc.ErrCodeInvalidParams, "confirm_warning")
	if len(ran) != 1 {
		t.Fatalf("the guard let a command through without asking: %v", ran)
	}
	if res := rpcOK(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "rm temp.txt", "confirm_warning": true})); res["risk_level"] != "warning" || len(ran) != 2 {
		t.Errorf("confirmed: %v (ran %v)", res, ran)
	}
	rpcErr(t, rpcDo(app, "filter.run", map[string]interface{}{"command": ""}), ipc.ErrCodeInvalidParams, "command is required")

	// a very long output is cut on a character boundary and says so
	runFilterCommand = func(ctx context.Context, cmd, input string) (*CommandResult, error) {
		return &CommandResult{Output: strings.Repeat("あ", filterMaxOutput), ExitCode: 3}, nil
	}
	big := rpcOK(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "sort"}))
	if big["truncated"] != true || len(big["stdout"].(string)) > filterMaxOutput || num(big, "exit_code") != 3 {
		t.Errorf("big output: truncated=%v len=%d", big["truncated"], len(big["stdout"].(string)))
	}
	// a command that is still running at the deadline is stopped, and the caller is told
	runFilterCommand = func(ctx context.Context, cmd, input string) (*CommandResult, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	rpcErr(t, rpcDo(app, "filter.run", map[string]interface{}{"command": "sort", "timeout_ms": 50}), ipc.ErrCodeInternalError, "did not finish within 50 ms")
}

// ---- find and replace in a note ------------------------------------------------------------------------------------------------------

func TestRPCBufferFindGivesUTF16PositionsLikeThePage(t *testing.T) {
	page := &bufferPage{content: "あ😀Foo bar\nfoo\n\nzFOOz foo"}
	app, _ := newPageApp(t, page.handle)

	res := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "foo"}))
	ms := res["matches"].([]interface{})
	if num(res, "count") != 4 || res["truncated"] != false || res["hash"] != computeHash(page.content) {
		t.Fatalf("find = %v", res)
	}
	first := ms[0].(map[string]interface{})
	// "あ" is 1 UTF-16 unit, the emoji 2: "Foo" starts at offset 3, column 4 of line 1
	if num(first, "start") != 3 || num(first, "end") != 6 || num(first, "line") != 1 || num(first, "col") != 4 || num(first, "end_col") != 7 || first["text"] != "Foo" || first["line_text"] != "あ😀Foo bar" {
		t.Errorf("first match = %v", first)
	}
	if m := ms[1].(map[string]interface{}); num(m, "line") != 2 || num(m, "col") != 1 {
		t.Errorf("second match = %v", m)
	}
	if m := ms[3].(map[string]interface{}); num(m, "line") != 4 || num(m, "col") != 7 {
		t.Errorf("last match = %v", m)
	}
	// the offsets are what buffer.replace and buffer.get_selection use: slicing the UTF-16 text with them gives the match
	u16 := utf16.Encode([]rune(page.content))
	for _, m := range ms {
		mm := m.(map[string]interface{})
		if got := string(utf16.Decode(u16[num(mm, "start"):num(mm, "end")])); !strings.EqualFold(got, "foo") || got != mm["text"] {
			t.Errorf("offsets %v..%v slice to %q, the match is %q", mm["start"], mm["end"], got, mm["text"])
		}
	}

	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "foo", "case_sensitive": true})); num(got, "count") != 2 {
		t.Errorf("case sensitive: %v", got)
	}
	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "foo", "whole_word": true})); num(got, "count") != 3 {
		t.Errorf("whole word (zFOOz is not one): %v", got)
	}
	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "(?m)^foo$", "regex": true})); num(got, "count") != 1 {
		t.Errorf("regex with line anchors: %v", got)
	}
	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "a.b", "regex": false})); num(got, "count") != 0 {
		t.Errorf("a dot is literal unless regex: %v", got)
	}
	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "foo", "limit": 2})); num(got, "count") != 2 || got["truncated"] != true {
		t.Errorf("limit: %v", got)
	}
	// an empty match (x*) is not a find
	if got := rpcOK(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "q*", "regex": true})); num(got, "count") != 0 {
		t.Errorf("empty matches: %v", got)
	}
	rpcErr(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": ""}), ipc.ErrCodeInvalidParams, "pattern is required")
	rpcErr(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "(", "regex": true}), ipc.ErrCodeInvalidParams, "not valid")
	rpcErr(t, rpcDo(app, "buffer.find", map[string]interface{}{"pattern": "x", "tab_id": "tab_9"}), ipc.ErrCodeNotFound, "no such tab")
}

func TestRPCBufferReplaceAllWritesOnceAndLosesToAConcurrentEdit(t *testing.T) {
	page := &bufferPage{content: "foo Foo FOO bar"}
	app, _ := newPageApp(t, page.handle)

	res := rpcOK(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": "foo", "replace": "baz"}))
	if num(res, "replaced") != 3 || page.content != "baz baz baz bar" || page.writes != 1 || res["hash"] != computeHash(page.content) || res["previous_hash"] != computeHash("foo Foo FOO bar") {
		t.Fatalf("replace_all = %v, content %q, writes %d", res, page.content, page.writes)
	}
	// the write names the hash of what was read, so the page can refuse it if the text moved
	if page.lastWrite["expectedHash"] != computeHash("foo Foo FOO bar") || page.lastWrite["mode"] != "set" {
		t.Errorf("write request = %v", page.lastWrite)
	}

	// regex: $1 and ${name} expand; without regex the replacement is literal ($1 stays $1)
	page.content = "id=7, id=42"
	if res := rpcOK(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": `id=(\d+)`, "regex": true, "replace": "n:${1}"})); num(res, "replaced") != 2 || page.content != "n:7, n:42" {
		t.Errorf("regex: %v %q", res, page.content)
	}
	page.content = "cost $1"
	if res := rpcOK(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": "$1", "replace": "$2 ${x}"})); num(res, "replaced") != 1 || page.content != "cost $2 ${x}" {
		t.Errorf("literal: %v %q", res, page.content)
	}

	// no match: nothing is written, the hash is unchanged
	before := page.writes
	if res := rpcOK(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": "zzz", "replace": "y"})); num(res, "replaced") != 0 || page.writes != before || res["hash"] != res["previous_hash"] {
		t.Errorf("no match: %v writes %d->%d", res, before, page.writes)
	}

	// the caller's expected_hash is checked against what was read
	page.content = "alpha"
	rpcErr(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": "a", "replace": "b", "expected_hash": "0000000000000000"}), ipc.ErrCodeConflict, "conflict: expected hash")
	if page.content != "alpha" {
		t.Errorf("a refused call changed the note: %q", page.content)
	}
	// the person types between the read and the write: the page refuses the write (-32001) and the note keeps their text
	page.content = "alpha"
	page.editedOnce = false
	page.afterRead = func() { page.content = "alpha, and what I just typed" }
	rpcErr(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": "alpha", "replace": "omega"}), ipc.ErrCodeConflict, "conflict")
	if page.content != "alpha, and what I just typed" {
		t.Errorf("the person's edit was overwritten: %q", page.content)
	}
	rpcErr(t, rpcDo(app, "buffer.replace_all", map[string]interface{}{"pattern": ""}), ipc.ErrCodeInvalidParams, "pattern is required")
}

// ---- caret, view, panels, tasks ------------------------------------------------------------------------------------------------------

func TestRPCBufferCursorAndSelect(t *testing.T) {
	var lastArgs []json.RawMessage
	app, mock := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		lastArgs = args
		switch fn {
		case "getBuffer":
			return `{"tabId":"tab_1","content":"あ😀b\nsecond line"}`, ""
		case "getCursor":
			return `{"tabId":"tab_1","start":3,"end":3,"hasSelection":false,"line":1,"col":4,"endLine":1,"endCol":4,"length":22}`, ""
		case "setCursor":
			var s, e int
			_ = json.Unmarshal(args[1], &s)
			_ = json.Unmarshal(args[2], &e)
			return fmt.Sprintf(`{"tabId":"tab_1","start":%d,"end":%d,"hasSelection":%v,"line":1,"col":1,"endLine":1,"endCol":1,"length":22}`, s, e, e > s), ""
		}
		return "", "unexpected " + fn
	})
	cur := rpcOK(t, rpcDo(app, "buffer.cursor", nil))
	if num(cur, "start") != 3 || cur["has_selection"] != false || num(cur, "line") != 1 || num(cur, "col") != 4 || num(cur, "length") != 22 || cur["tab_id"] != "tab_1" {
		t.Errorf("buffer.cursor = %v", cur)
	}
	if !strings.Contains(mock.lastCall(), `getCursor("")`) {
		t.Errorf("call = %s", mock.lastCall())
	}

	// by offsets: an omitted end is a bare caret; scroll is on and focus off unless said otherwise
	sel := rpcOK(t, rpcDo(app, "buffer.select", map[string]interface{}{"start": 1, "end": 3}))
	if num(sel, "start") != 1 || num(sel, "end") != 3 || sel["has_selection"] != true {
		t.Errorf("select = %v", sel)
	}
	var opts map[string]interface{}
	_ = json.Unmarshal(lastArgs[3], &opts)
	if opts["scroll"] != true || opts["focus"] != false {
		t.Errorf("options sent to the page: %v", opts)
	}
	rpcOK(t, rpcDo(app, "buffer.select", map[string]interface{}{"start": 5, "scroll": false, "focus": true}))
	_ = json.Unmarshal(lastArgs[3], &opts)
	var s, e int
	_ = json.Unmarshal(lastArgs[1], &s)
	_ = json.Unmarshal(lastArgs[2], &e)
	if s != 5 || e != 5 || opts["scroll"] != false || opts["focus"] != true {
		t.Errorf("caret only: %d %d %v", s, e, opts)
	}

	// by line and column (1-based, UTF-16 columns): line 1 column 4 is after "あ😀" (3 units); line 2 column 1 is offset 5
	rpcOK(t, rpcDo(app, "buffer.select", map[string]interface{}{"start_line": 1, "start_col": 4, "end_line": 2, "end_col": 3}))
	_ = json.Unmarshal(lastArgs[1], &s)
	_ = json.Unmarshal(lastArgs[2], &e)
	if s != 3 || e != 7 {
		t.Errorf("line/col to offsets: %d %d (want 3 and 7)", s, e)
	}

	rpcErr(t, rpcDo(app, "buffer.select", nil), ipc.ErrCodeInvalidParams, "give start")
	rpcErr(t, rpcDo(app, "buffer.select", map[string]interface{}{"start": 1, "start_line": 1, "start_col": 1}), ipc.ErrCodeInvalidParams, "not both")
	rpcErr(t, rpcDo(app, "buffer.select", map[string]interface{}{"start": -1}), ipc.ErrCodeInvalidParams, "negative")
	rpcErr(t, rpcDo(app, "buffer.select", map[string]interface{}{"start_line": 0, "start_col": 2, "end_line": 1, "end_col": 1}), ipc.ErrCodeInvalidParams, "1-based")
}

func TestLineColToOffsetCountsUTF16LikeThePage(t *testing.T) {
	text := "あ😀b\nsecond\n\nlast"
	cases := []struct{ line, col, want int }{
		{1, 1, 0}, {1, 2, 1}, {1, 4, 3}, {1, 5, 4}, {2, 1, 5}, {2, 3, 7}, {3, 1, 12}, {4, 1, 13}, {4, 5, 17},
		{9, 9, 17},   // past the end: clamped
		{0, 0, 0},    // below 1: the start
		{1, 900, 17}, // far past the line: clamped to the text, as the page does
	}
	for _, c := range cases {
		if got := lineColToOffset(text, c.line, c.col); got != c.want {
			t.Errorf("lineColToOffset(%d, %d) = %d, want %d", c.line, c.col, got, c.want)
		}
	}
	if utf16Len("あ😀b") != 4 || utf16Len("") != 0 {
		t.Errorf("utf16Len")
	}
}

func TestRPCUIStateSetViewAndOpenPanel(t *testing.T) {
	var spec map[string]interface{}
	var panel string
	app, _ := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		switch fn {
		case "getUiState":
			return `{"activeTabId":"tab_2","splitMode":true,"secondaryTabId":"tab_3","preview":"side","zen":false,"fullscreen":null}`, ""
		case "setUiState":
			spec = nil
			_ = json.Unmarshal(args[0], &spec)
			return `{"activeTabId":"tab_2","splitMode":false,"secondaryTabId":null,"preview":"off","zen":true,"fullscreen":false}`, ""
		case "openPanel":
			_ = json.Unmarshal(args[0], &panel)
			if panel == "nope" {
				return "", `[invalid_params] unknown panel "nope"; use one of: find, replace`
			}
			return fmt.Sprintf(`{"panel":%q}`, panel), ""
		}
		return "", "unexpected " + fn
	})
	st := rpcOK(t, rpcDo(app, "ui.state", nil))
	if st["active_tab_id"] != "tab_2" || st["split"] != true || st["secondary_tab_id"] != "tab_3" || st["preview"] != "side" || st["zen"] != false {
		t.Errorf("ui.state = %v", st)
	}
	if v, has := st["fullscreen"]; !has || v != nil {
		t.Errorf("an unknown fullscreen is null, not false: %v", st)
	}
	after := rpcOK(t, rpcDo(app, "ui.set_view", map[string]interface{}{"preview": "off", "split": false, "zen": true}))
	if spec["preview"] != "off" || spec["split"] != false || spec["zen"] != true || after["zen"] != true || after["preview"] != "off" || after["fullscreen"] != false {
		t.Errorf("set_view: sent %v, got %v", spec, after)
	}
	rpcOK(t, rpcDo(app, "ui.set_view", map[string]interface{}{"zen": false}))
	if len(spec) != 1 || spec["zen"] != false {
		t.Errorf("only the given keys are sent: %v", spec)
	}
	rpcErr(t, rpcDo(app, "ui.set_view", map[string]interface{}{}), ipc.ErrCodeInvalidParams, "at least one")
	rpcErr(t, rpcDo(app, "ui.set_view", map[string]interface{}{"preview": "both"}), ipc.ErrCodeInvalidParams, `"off", "full" or "side"`)

	if got := rpcOK(t, rpcDo(app, "ui.open_panel", map[string]string{"name": "find"})); got["panel"] != "find" || panel != "find" {
		t.Errorf("open_panel = %v", got)
	}
	rpcErr(t, rpcDo(app, "ui.open_panel", map[string]string{"name": "nope"}), ipc.ErrCodeInvalidParams, "unknown panel")
	rpcErr(t, rpcDo(app, "ui.open_panel", map[string]string{"name": " "}), ipc.ErrCodeInvalidParams, "name is required")
}

func TestRPCTaskListAndCancel(t *testing.T) {
	var cancelled string
	app, _ := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		switch fn {
		case "getTasks":
			return `{"running":[{"id":"t1","kind":"ask","label":"Ask","status":"running","startedAt":1700000000000,"cancellable":true}],"recent":[{"id":"t0","kind":"slot","label":"Slot","status":"done","startedAt":1,"finishedAt":2,"cancellable":false}]}`, ""
		case "cancelTask":
			_ = json.Unmarshal(args[0], &cancelled)
			if cancelled == "t1" {
				return `{"cancelled":true}`, ""
			}
			return `{"cancelled":false,"reason":"not_found"}`, ""
		}
		return "", "unexpected " + fn
	})
	res := rpcOK(t, rpcDo(app, "task.list", nil))
	running := res["running"].([]interface{})[0].(map[string]interface{})
	if running["id"] != "t1" || running["started_at"] == nil || running["startedAt"] != nil || running["cancellable"] != true {
		t.Errorf("running = %v (keys are snake_case)", running)
	}
	if rec := res["recent"].([]interface{})[0].(map[string]interface{}); rec["finished_at"] == nil {
		t.Errorf("recent = %v", rec)
	}
	if got := rpcOK(t, rpcDo(app, "task.cancel", map[string]string{"id": "t1"})); got["cancelled"] != true || cancelled != "t1" {
		t.Errorf("cancel = %v", got)
	}
	if got := rpcOK(t, rpcDo(app, "task.cancel", map[string]string{"id": "zz"})); got["cancelled"] != false || got["reason"] != "not_found" {
		t.Errorf("cancel unknown = %v", got)
	}
	rpcErr(t, rpcDo(app, "task.cancel", map[string]string{"id": ""}), ipc.ErrCodeInvalidParams, "id is required")
}

func TestSnakeCase(t *testing.T) {
	for in, want := range map[string]string{"startedAt": "started_at", "id": "id", "isActive": "is_active", "a": "a", "finishedAtMs": "finished_at_ms"} {
		if got := snakeCase(in); got != want {
			t.Errorf("snakeCase(%q) = %q, want %q", in, got, want)
		}
	}
}

// A page that is not there (start-up, a crashed WebView) is an error of the app (-32603), never a hang or a panic.
func TestRPCPageMethodsWithoutAPage(t *testing.T) {
	app := &App{}
	for _, c := range []struct {
		method string
		params interface{}
	}{
		{"buffer.cursor", nil}, {"buffer.find", map[string]string{"pattern": "x"}}, {"ui.state", nil},
		{"ui.set_view", map[string]bool{"zen": true}}, {"ui.open_panel", map[string]string{"name": "find"}}, {"task.list", nil},
		{"task.cancel", map[string]string{"id": "t"}}, {"buffer.select", map[string]int{"start": 1}},
	} {
		resp := rpcDo(app, c.method, c.params)
		if resp.Error == nil || resp.Error.Code != ipc.ErrCodeInternalError {
			t.Errorf("%s without a page: %+v", c.method, resp)
		}
	}
}

// The only methods that run without the session token are the three old reads: every other method of app_rpc.go, the new ones included,
// needs it (pkg/ipc lists what is safe without one, so a new method is protected until someone says otherwise).
func TestEveryRPCMethodExceptTheOldReadsNeedsTheToken(t *testing.T) {
	src, err := os.ReadFile("app_rpc.go")
	if err != nil {
		t.Fatal(err)
	}
	methods := regexp.MustCompile(`case "([a-z_]+\.[a-z_]+)":`).FindAllStringSubmatch(string(src), -1)
	if len(methods) < 30 {
		t.Fatalf("expected the RPC switch to hold at least 30 methods, found %d", len(methods))
	}
	free := map[string]bool{"buffer.get": true, "buffer.get_selection": true, "tab.list": true}
	for _, m := range methods {
		if ipc.IsReadOnlyMethod(m[1]) != free[m[1]] {
			t.Errorf("%s: token optional = %v, want %v", m[1], ipc.IsReadOnlyMethod(m[1]), free[m[1]])
		}
	}
}

// The new methods through the real server: a JSON line over TCP, the session token, the dispatcher. Without the token nothing runs and
// nothing is written; with it, the pipe's append and the search that reads it back work end to end.
func TestNewMethodsThroughTheRealServer(t *testing.T) {
	scrapDir := scrapConfig(t, nil)
	app := &App{scrapDir: scrapDir}
	srv, err := ipc.StartServer(0, app.DispatchRPCOperation, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	session := srv.Session()

	raw := func(method string, params interface{}, auth string) ipc.RPCResponse {
		t.Helper()
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", session.Port), 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		req := map[string]interface{}{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
		if auth != "" {
			req["auth"] = auth
		}
		line, _ := json.Marshal(req)
		_, _ = conn.Write(append(line, '\n'))
		sc := bufio.NewScanner(conn)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		if !sc.Scan() {
			t.Fatalf("no response to %s: %v", method, sc.Err())
		}
		var resp ipc.RPCResponse
		if err := json.Unmarshal(sc.Bytes(), &resp); err != nil {
			t.Fatalf("bad response: %v", err)
		}
		return resp
	}

	for _, m := range []string{"scrap.append", "scrap.search", "app.info", "config.get", "git.sync", "filter.run", "buffer.find", "buffer.cursor", "ui.set_view", "task.cancel"} {
		resp := raw(m, map[string]interface{}{"content": "x", "text": "x", "pattern": "x", "command": "echo", "zen": true, "id": "t"}, "")
		if resp.Error == nil || resp.Error.Code != ipc.ErrCodeUnauthorized {
			t.Errorf("%s without the token: %+v", m, resp)
		}
	}
	if entries, _ := os.ReadDir(scrapDir); len(entries) != 0 {
		t.Fatalf("a refused call wrote into the scrap folder: %v", entries)
	}

	resp := raw("scrap.append", map[string]interface{}{"content": "ping 8.8.8.8: reply in 5 ms", "title": "ping"}, session.Token)
	if resp.Error != nil {
		t.Fatalf("scrap.append: %+v", resp.Error)
	}
	got := raw("scrap.search", map[string]interface{}{"text": "reply in 5"}, session.Token)
	if got.Error != nil {
		t.Fatalf("scrap.search: %+v", got.Error)
	}
	b, _ := json.Marshal(got.Result)
	var res struct {
		Count   int `json:"count"`
		Matches []struct {
			Text, Rel, Link string
			Heading         string
		} `json:"matches"`
	}
	_ = json.Unmarshal(b, &res)
	if res.Count != 1 || !strings.Contains(res.Matches[0].Text, "reply in 5 ms") || res.Matches[0].Heading == "" || !strings.HasPrefix(res.Matches[0].Link, "[") || res.Matches[0].Rel == "" {
		t.Errorf("the entry just appended is found: %s", b)
	}
	if info := raw("app.info", nil, session.Token); info.Error != nil || info.Result == nil {
		t.Errorf("app.info: %+v", info)
	}
}
