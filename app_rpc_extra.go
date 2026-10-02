package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"md-memo/pkg/cli"
	"md-memo/pkg/configpack"
	"md-memo/pkg/encoding"
	"md-memo/pkg/gitsync"
	"md-memo/pkg/ipc"
)

// The JSON-RPC methods beyond buffer.* / tab.* / ui.* (app_rpc.go routes them here): where things are (app.info, config.get), the
// scraps (scrap.path / list / search / open / append, the last being `cmd | md-memo` with a token), the scrap folder's Git sync
// (git.status / git.sync), a command run over some text (filter.validate / filter.run: what the command bar does), finding and
// replacing inside a note (buffer.find / replace_all), the caret (buffer.cursor / select), the view (ui.state / set_view / open_panel)
// and the task list (task.list / cancel). The answers of the first group are the very functions the command line uses (pkg/cli
// shared.go), so the two never disagree. Every method here needs the session token (pkg/ipc/auth.go lists the only reads that do
// not).

// decodeRPCParams reads the params object into out; no params leaves out as it is.
func decodeRPCParams(req *ipc.RPCRequest, out interface{}) *ipc.RPCResponse {
	if len(req.Params) == 0 {
		return nil
	}
	if err := json.Unmarshal(req.Params, out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("invalid %s params: %v", req.Method, err))
	}
	return nil
}

// cliErrorResponse maps an error of pkg/cli's shared functions: a bad argument is -32602, anything else -32603.
func cliErrorResponse(id interface{}, err error, what string) *ipc.RPCResponse {
	if cli.IsParamError(err) {
		return errorResponse(id, ipc.ErrCodeInvalidParams, err.Error())
	}
	return errorResponse(id, ipc.ErrCodeInternalError, fmt.Sprintf("%s: %v", what, err))
}

// ---- where things are ------------------------------------------------------------------------------------------------------------

func (a *App) rpcAppInfo(req *ipc.RPCRequest) *ipc.RPCResponse {
	return successResponse(req.ID, cli.Info(AppVersion, true))
}

func (a *App) rpcConfigGet(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Key string `json:"key"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	doc, err := cli.ConfigGet(strings.TrimSpace(params.Key))
	if err != nil {
		return cliErrorResponse(req.ID, err, "cannot read the settings")
	}
	return successResponse(req.ID, map[string]interface{}{"key": strings.TrimSpace(params.Key), "value": doc})
}

// ---- scraps ----------------------------------------------------------------------------------------------------------------------

func (a *App) rpcScrapPath(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Date string `json:"date"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	res, err := cli.ScrapPathFor(params.Date)
	if err != nil {
		return cliErrorResponse(req.ID, err, "scrap.path failed")
	}
	return successResponse(req.ID, res)
}

func (a *App) rpcScrapList(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		From  string `json:"from"`
		To    string `json:"to"`
		Lines bool   `json:"lines"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	files, err := cli.ScrapList(params.From, params.To, params.Lines)
	if err != nil {
		return cliErrorResponse(req.ID, err, "scrap.list failed")
	}
	return successResponse(req.ID, files)
}

func (a *App) rpcScrapSearch(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Text     string          `json:"text"`
		From     string          `json:"from"`
		To       string          `json:"to"`
		Limit    int             `json:"limit"`
		Ranked   bool            `json:"ranked"`
		Semantic bool            `json:"semantic"`
		Kind     json.RawMessage `json:"kind"` // "note,log" or ["note","log"]
		Path     string          `json:"path"`
		Update   bool            `json:"update"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	var kinds []string
	if len(params.Kind) > 0 && string(params.Kind) != "null" {
		var asList []string
		var asString string
		switch {
		case json.Unmarshal(params.Kind, &asList) == nil:
			kinds = asList
		case json.Unmarshal(params.Kind, &asString) == nil:
			kinds = strings.Split(asString, ",")
		default:
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "invalid scrap.search params: kind must be a string or a list of strings")
		}
	}
	res, err := cli.ScrapSearch(ctx, cli.ScrapSearchParams{
		Text: params.Text, From: params.From, To: params.To, Limit: params.Limit, Ranked: params.Ranked, Semantic: params.Semantic,
		Kinds: kinds, Path: params.Path, Update: params.Update,
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, "scrap.search timed out (5 s); narrow it with from/to or a smaller limit")
		}
		return cliErrorResponse(req.ID, err, "scrap.search failed")
	}
	return successResponse(req.ID, res)
}

// rpcScrapOpen opens the scrap file of a day in a tab: tab.new with that path (a day with no file is -32002 like any missing file).
func (a *App) rpcScrapOpen(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Date       string `json:"date"`
		Background bool   `json:"background"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	pr, err := cli.ScrapPathFor(params.Date)
	if err != nil {
		return cliErrorResponse(req.ID, err, "scrap.open failed")
	}
	raw, _ := json.Marshal(map[string]interface{}{"path": pr.Path, "background": params.Background})
	return a.rpcTabNew(ctx, &ipc.RPCRequest{JSONRPC: req.JSONRPC, ID: req.ID, Method: "tab.new", Params: raw})
}

// scrapAppendResult is the answer of scrap.append.
type scrapAppendResult struct {
	Success bool   `json:"success"`
	Path    string `json:"path"`
	Date    string `json:"date"`
	Time    string `json:"time"`
	Title   string `json:"title"`
	Line    int    `json:"line"`  // the line of the entry's "---" rule in the file
	Bytes   int    `json:"bytes"` // what was added to the file
}

// rpcScrapAppend is `cmd | md-memo [title words]` over JSON-RPC, with a token: the text is appended to today's scrap file as an entry
// headed "## [HH:MM:SS] <title>" (title defaults to "CLI Pipe"), the Git sync is started, the page is told, and the window is brought
// to the front only when activate is true (the pipe always does; an agent that writes while the person types should not).
// content is text; content_base64 is raw bytes decoded the way the pipe decodes its standard input (a BOM, UTF-16, a Japanese
// console's Shift_JIS), up to the pipe's 10 MB. cwd is only told to the page, as the pipe does. format "markdown" writes the content as
// it is, not in a text fence, so that the links in it (a summary of search results, say) stay clickable; the heading is the same.
func (a *App) rpcScrapAppend(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Content       *string `json:"content"`
		ContentBase64 string  `json:"content_base64"`
		Title         string  `json:"title"`
		Cwd           string  `json:"cwd"`
		Activate      bool    `json:"activate"`
		Format        string  `json:"format"` // "text" (the pipe's fenced entry, the default) or "markdown" (the content as it is)
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if (params.Content != nil) == (params.ContentBase64 != "") {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "give content or content_base64 (exactly one)")
	}
	if params.Format != "" && params.Format != "text" && params.Format != "markdown" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, `format must be "text" or "markdown"`)
	}
	var raw []byte
	if params.Content != nil {
		raw = []byte(*params.Content)
	} else {
		var err error
		if raw, err = base64.StdEncoding.DecodeString(params.ContentBase64); err != nil {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("content_base64 is not base64: %v", err))
		}
	}
	if len(raw) > maxPipeBytes {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "the content exceeds the maximum allowed size (10MB)")
	}
	text := encoding.DecodePiped(raw)
	if strings.TrimSpace(text) == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "nothing to append: the content is empty")
	}
	// The title is one line of a heading: line breaks and runs of spaces become one space, and it stops at 200 characters.
	title := strings.Join(strings.Fields(params.Title), " ")
	if utf8.RuneCountInString(title) > 200 {
		title = string([]rune(title)[:200])
	}
	path, line, written, err := a.appendDailyScrap(text, title, params.Cwd, true, params.Format == "markdown")
	if err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("scrap.append failed: %v", err))
	}
	if params.Activate {
		activatePlatformWindow()
	}
	now := time.Now()
	if title == "" {
		title = "CLI Pipe"
	}
	return successResponse(req.ID, &scrapAppendResult{
		Success: true, Path: path, Date: now.Format("2006-01-02"), Time: now.Format("15:04:05"), Title: title, Line: line, Bytes: written,
	})
}

// ---- Git sync of the scrap folder ------------------------------------------------------------------------------------------------

func (a *App) rpcGitStatus(req *ipc.RPCRequest) *ipc.RPCResponse {
	installed, version := gitsync.CheckGitInstalled()
	info := gitsync.GetRepoStatus(a.GetScrapDir())
	remote, _ := configpack.StripUserinfo(info.RemoteURL) // a remote may carry a password: never reported
	a.gitMu.RLock()
	engine := a.gitEngine
	a.gitMu.RUnlock()
	return successResponse(req.ID, map[string]interface{}{
		"git_installed": installed, "git_version": version,
		"scrap_dir": a.GetScrapDir(), "is_git": info.IsGit, "remote_url": remote, "branch": info.Branch, "clean": info.Clean,
		"sync_enabled": engine != nil && engine.Enabled(),
	})
}

// rpcGitSync starts a sync now (commit, pull, push of the scrap folder) in the background, as the automatic sync does after an edit,
// and returns at once; git.status shows the result. Nothing happens when the sync is not switched on in Settings.
func (a *App) rpcGitSync(req *ipc.RPCRequest) *ipc.RPCResponse {
	a.gitMu.RLock()
	engine := a.gitEngine
	a.gitMu.RUnlock()
	if engine == nil || !engine.Enabled() {
		return successResponse(req.ID, map[string]interface{}{"triggered": false, "reason": "Git sync is not switched on in Settings"})
	}
	engine.TriggerNow()
	return successResponse(req.ID, map[string]interface{}{"triggered": true})
}

// ---- a command over some text (the command bar) ----------------------------------------------------------------------------------

// runFilterCommand runs the shell command of filter.run. A variable so that the tests can see whether the guard let a command through
// without ever running one.
var runFilterCommand = executeCli

const (
	filterDefaultTimeout = 5 * time.Second
	filterMaxTimeout     = 8 * time.Second // the connection itself lives 10 s
	filterMaxOutput      = 1 << 20
)

func (a *App) rpcFilterValidate(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Command string `json:"command"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if strings.TrimSpace(params.Command) == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "command is required")
	}
	v := validateCliCommand(strings.TrimSpace(params.Command))
	return successResponse(req.ID, map[string]interface{}{"safe": v.IsSafe, "warning": v.IsWarning, "blocked": v.IsBlocked, "risk_level": v.RiskLevel, "reason": v.Reason})
}

// rpcFilterRun runs a shell command with input on its standard input and returns what it printed: what the command bar does to the
// selection, without touching any note (read the text with buffer.get_selection, run it, write the answer with buffer.replace_selection).
// The command goes through the same guard as the command bar (validateCliCommand: reviewed mode of pkg/jev): a blocked command is
// refused, one the guard warns about runs only with confirm_warning true, which the caller sends only when the person agreed.
func (a *App) rpcFilterRun(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Command        string `json:"command"`
		Input          string `json:"input"`
		ConfirmWarning bool   `json:"confirm_warning"`
		TimeoutMs      int    `json:"timeout_ms"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	cmd := strings.TrimSpace(params.Command)
	if cmd == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "command is required")
	}
	v := validateCliCommand(cmd)
	if v.IsBlocked {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "refused by the command guard: "+v.Reason)
	}
	if v.IsWarning && !params.ConfirmWarning {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "the command guard warns about this command ("+v.Reason+"); run it again with confirm_warning true only if the person agreed")
	}
	timeout := filterDefaultTimeout
	if params.TimeoutMs > 0 {
		timeout = time.Duration(params.TimeoutMs) * time.Millisecond
		if timeout > filterMaxTimeout {
			timeout = filterMaxTimeout
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	res, err := runFilterCommand(ctx, cmd, params.Input)
	if ctx.Err() != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("the command did not finish within %d ms and was stopped", timeout.Milliseconds()))
	}
	if res == nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("the command could not be run: %v", err))
	}
	out, truncOut := capText(res.Output, filterMaxOutput)
	errText, truncErr := capText(res.Error, filterMaxOutput)
	return successResponse(req.ID, map[string]interface{}{
		"stdout": out, "stderr": errText, "exit_code": res.ExitCode, "truncated": truncOut || truncErr,
		"risk_level": v.RiskLevel, "duration_ms": time.Since(started).Milliseconds(),
	})
}

// capText cuts s to at most max bytes, on a character boundary.
func capText(s string, max int) (string, bool) {
	if len(s) <= max {
		return s, false
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// ---- find and replace inside a note ----------------------------------------------------------------------------------------------

type rpcBufferText struct {
	TabID   string
	Content string // LF text, as the page holds it
	Hash    string
}

// rpcReadBuffer reads a tab's live text (an unknown id is -32002).
func (a *App) rpcReadBuffer(ctx context.Context, id interface{}, tabID string) (*rpcBufferText, *ipc.RPCResponse) {
	resJSON, err := a.callRPCJS(ctx, "getBuffer", tabID)
	if err != nil {
		return nil, jsErrorResponse(id, err, "failed to read the note")
	}
	var raw struct {
		TabID   string `json:"tabId"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal([]byte(resJSON), &raw); err != nil {
		return nil, errorResponse(id, ipc.ErrCodeInternalError, fmt.Sprintf("invalid buffer response: %v", err))
	}
	return &rpcBufferText{TabID: raw.TabID, Content: raw.Content, Hash: computeHash(raw.Content)}, nil
}

// findParams are what buffer.find and buffer.replace_all look for. Text is searched literally unless regex is true; the engine is Go's
// (RE2: no look-around or back-references; "(?m)" makes ^ and $ match at every line, "(?s)" lets . match a line break). case_sensitive
// defaults to false; whole_word wraps the pattern in \b...\b (ASCII word boundaries).
type findParams struct {
	Pattern       string `json:"pattern"`
	Regex         bool   `json:"regex"`
	CaseSensitive bool   `json:"case_sensitive"`
	WholeWord     bool   `json:"whole_word"`
}

func (f findParams) compile() (*regexp.Regexp, error) {
	if f.Pattern == "" {
		return nil, errors.New("pattern is required")
	}
	expr := f.Pattern
	if !f.Regex {
		expr = regexp.QuoteMeta(expr)
	}
	if f.WholeWord {
		expr = `\b(?:` + expr + `)\b`
	}
	if !f.CaseSensitive {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("the pattern is not valid: %v", err)
	}
	return re, nil
}

// u16Walker turns byte offsets of a Go string into the UTF-16 offsets, lines and columns the page uses, for offsets given in
// ascending order.
type u16Walker struct {
	s                       string
	byteIdx, u16            int
	line                    int // 1-based
	lineStartU16, lineStart int // where the current line starts (UTF-16 offset, byte offset)
}

func newU16Walker(s string) *u16Walker { return &u16Walker{s: s, line: 1} }

// at advances to byte offset b (not before the last one asked) and returns the UTF-16 offset, the 1-based line and column.
func (w *u16Walker) at(b int) (u16, line, col int) {
	for w.byteIdx < b && w.byteIdx < len(w.s) {
		r, size := utf8.DecodeRuneInString(w.s[w.byteIdx:])
		n := 1
		if r >= 0x10000 {
			n = 2
		}
		w.byteIdx += size
		w.u16 += n
		if r == '\n' {
			w.line++
			w.lineStartU16 = w.u16
			w.lineStart = w.byteIdx
		}
	}
	return w.u16, w.line, w.u16 - w.lineStartU16 + 1
}

func (w *u16Walker) lineText(maxRunes int) string {
	end := strings.IndexByte(w.s[w.lineStart:], '\n')
	text := w.s[w.lineStart:]
	if end >= 0 {
		text = w.s[w.lineStart : w.lineStart+end]
	}
	if rs := []rune(text); len(rs) > maxRunes {
		text = string(rs[:maxRunes]) + "..."
	}
	return text
}

type findMatch struct {
	Start    int    `json:"start"` // UTF-16 offsets into the note's text, like buffer.get_selection
	End      int    `json:"end"`
	Line     int    `json:"line"` // 1-based, columns count UTF-16 units, like buffer.replace
	Col      int    `json:"col"`
	EndLine  int    `json:"end_line"`
	EndCol   int    `json:"end_col"`
	Text     string `json:"text"`      // the matched text (at most 500 characters)
	LineText string `json:"line_text"` // the line it starts on (at most 300 characters)
}

const (
	findDefaultLimit = 200
	findMaxLimit     = 5000
)

func (a *App) rpcBufferFind(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		findParams
		TabID string `json:"tab_id"`
		Limit int    `json:"limit"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	re, err := params.compile()
	if err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, err.Error())
	}
	limit := params.Limit
	if limit <= 0 {
		limit = findDefaultLimit
	}
	if limit > findMaxLimit {
		limit = findMaxLimit
	}
	buf, bad := a.rpcReadBuffer(ctx, req.ID, params.TabID)
	if bad != nil {
		return bad
	}
	matches := []findMatch{}
	truncated := false
	w, wEnd := newU16Walker(buf.Content), newU16Walker(buf.Content)
	for _, m := range re.FindAllStringIndex(buf.Content, -1) {
		if m[0] == m[1] {
			continue // an empty match is not a find
		}
		if len(matches) == limit {
			truncated = true
			break
		}
		start, line, col := w.at(m[0])
		lineText := w.lineText(300)
		end, endLine, endCol := wEnd.at(m[1])
		text := buf.Content[m[0]:m[1]]
		if rs := []rune(text); len(rs) > 500 {
			text = string(rs[:500]) + "..."
		}
		matches = append(matches, findMatch{Start: start, End: end, Line: line, Col: col, EndLine: endLine, EndCol: endCol, Text: text, LineText: lineText})
	}
	return successResponse(req.ID, map[string]interface{}{"tab_id": buf.TabID, "hash": buf.Hash, "count": len(matches), "truncated": truncated, "matches": matches})
}

// rpcBufferReplaceAll replaces every match in the note in one write: the text is read, replaced here, and written with the hash of
// what was read as expected_hash, which the page checks and writes in ONE step, so an edit made in between is a conflict (-32001) and
// nothing is changed. With regex true the replacement may use $1 or ${name}; otherwise it is literal. No match writes nothing.
func (a *App) rpcBufferReplaceAll(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		findParams
		Replace      string `json:"replace"`
		TabID        string `json:"tab_id"`
		ExpectedHash string `json:"expected_hash"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	re, err := params.compile()
	if err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, err.Error())
	}
	buf, bad := a.rpcReadBuffer(ctx, req.ID, params.TabID)
	if bad != nil {
		return bad
	}
	if params.ExpectedHash != "" && params.ExpectedHash != buf.Hash {
		return errorResponse(req.ID, ipc.ErrCodeConflict, fmt.Sprintf("conflict: expected hash %s but buffer is at %s", params.ExpectedHash, buf.Hash))
	}
	var sb strings.Builder
	last, n := 0, 0
	for _, m := range re.FindAllStringSubmatchIndex(buf.Content, -1) {
		if m[0] == m[1] {
			continue
		}
		sb.WriteString(buf.Content[last:m[0]])
		if params.Regex {
			sb.Write(re.ExpandString(nil, params.Replace, buf.Content, m))
		} else {
			sb.WriteString(params.Replace)
		}
		last = m[1]
		n++
	}
	if n == 0 {
		return successResponse(req.ID, map[string]interface{}{"success": true, "tab_id": buf.TabID, "replaced": 0, "hash": buf.Hash, "previous_hash": buf.Hash})
	}
	sb.WriteString(buf.Content[last:])
	res, errResp := a.rpcWriteBuffer(ctx, req.ID, rpcWrite{TabID: buf.TabID, Mode: "set", Content: sb.String(), ExpectedHash: buf.Hash})
	if errResp != nil {
		return errResp
	}
	return successResponse(req.ID, map[string]interface{}{
		"success": true, "tab_id": res.TabID, "replaced": n, "hash": res.Hash, "previous_hash": res.PreviousHash, "generation": res.Generation,
	})
}

// ---- the caret, the view, the tasks (the page does the work: window.__mdMemoRPC in frontend/js/app.js) ----------------------------

// utf16Len is the length of s in UTF-16 units, the unit the page counts columns and offsets in.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

// lineColToOffset is the UTF-16 offset of a 1-based line and column in text (lines end at \n), clamped into the text like the page does.
func lineColToOffset(text string, line, col int) int {
	if line < 1 {
		line = 1
	}
	if col < 1 {
		col = 1
	}
	lines := strings.Split(text, "\n")
	off := 0
	for i := 0; i < line-1 && i < len(lines); i++ {
		off += utf16Len(lines[i]) + 1
	}
	off += col - 1
	if total := utf16Len(text); off > total {
		off = total
	}
	return off
}

type cursorResult struct {
	TabID        string `json:"tab_id"`
	Start        int    `json:"start"`
	End          int    `json:"end"`
	HasSelection bool   `json:"has_selection"`
	Line         int    `json:"line"`
	Col          int    `json:"col"`
	EndLine      int    `json:"end_line"`
	EndCol       int    `json:"end_col"`
	Length       int    `json:"length"`
}

// pageCursor is what window.__mdMemoRPC.getCursor / setCursor return.
type pageCursor struct {
	TabID        string `json:"tabId"`
	Start        int    `json:"start"`
	End          int    `json:"end"`
	HasSelection bool   `json:"hasSelection"`
	Line         int    `json:"line"`
	Col          int    `json:"col"`
	EndLine      int    `json:"endLine"`
	EndCol       int    `json:"endCol"`
	Length       int    `json:"length"`
}

func (p pageCursor) result() *cursorResult {
	endLine, endCol := p.EndLine, p.EndCol
	if endLine == 0 {
		endLine, endCol = p.Line, p.Col
	}
	return &cursorResult{TabID: p.TabID, Start: p.Start, End: p.End, HasSelection: p.HasSelection || p.End > p.Start, Line: p.Line, Col: p.Col, EndLine: endLine, EndCol: endCol, Length: p.Length}
}

func (a *App) rpcBufferCursor(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	tabID, bad := tabIDParam(req)
	if bad != nil {
		return bad
	}
	resJSON, err := a.callRPCJS(ctx, "getCursor", tabID)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to read the caret")
	}
	var pc pageCursor
	if err := json.Unmarshal([]byte(resJSON), &pc); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid caret response: %v", err))
	}
	return successResponse(req.ID, pc.result())
}

// rpcBufferSelect puts the caret, or a selection, in a note: by offsets (start, end; UTF-16 units into the text) or by 1-based line and
// column (start_line, start_col, end_line, end_col), not both. An omitted end is the start (a bare caret). scroll (default true) brings
// it into view; focus (default false) gives the editor the keyboard focus, which an agent should not take from the person typing.
func (a *App) rpcBufferSelect(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		TabID     string `json:"tab_id"`
		Start     *int   `json:"start"`
		End       *int   `json:"end"`
		StartLine int    `json:"start_line"`
		StartCol  int    `json:"start_col"`
		EndLine   int    `json:"end_line"`
		EndCol    int    `json:"end_col"`
		Scroll    *bool  `json:"scroll"`
		Focus     bool   `json:"focus"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	byLine := params.StartLine != 0 || params.StartCol != 0 || params.EndLine != 0 || params.EndCol != 0
	byOffset := params.Start != nil || params.End != nil
	switch {
	case byLine && byOffset:
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "give offsets (start, end) or lines and columns (start_line, start_col, ...), not both")
	case !byLine && params.Start == nil:
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "give start (and end), or start_line and start_col (and end_line, end_col)")
	}
	var start, end int
	if byOffset {
		start = *params.Start
		end = start
		if params.End != nil {
			end = *params.End
		}
		if start < 0 || end < 0 {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "offsets cannot be negative")
		}
	} else {
		if params.StartLine < 1 || params.StartCol < 1 {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "start_line and start_col are 1-based")
		}
		buf, bad := a.rpcReadBuffer(ctx, req.ID, params.TabID)
		if bad != nil {
			return bad
		}
		start = lineColToOffset(buf.Content, params.StartLine, params.StartCol)
		end = start
		if params.EndLine != 0 || params.EndCol != 0 {
			if params.EndLine < 1 || params.EndCol < 1 {
				return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "end_line and end_col are 1-based")
			}
			end = lineColToOffset(buf.Content, params.EndLine, params.EndCol)
		}
		params.TabID = buf.TabID
	}
	scroll := true
	if params.Scroll != nil {
		scroll = *params.Scroll
	}
	resJSON, err := a.callRPCJS(ctx, "setCursor", params.TabID, start, end, map[string]interface{}{"scroll": scroll, "focus": params.Focus})
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to set the caret")
	}
	var pc pageCursor
	if err := json.Unmarshal([]byte(resJSON), &pc); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid caret response: %v", err))
	}
	return successResponse(req.ID, pc.result())
}

type uiStateResult struct {
	ActiveTabID    string  `json:"active_tab_id"`
	Split          bool    `json:"split"`
	SecondaryTabID *string `json:"secondary_tab_id"`
	Preview        string  `json:"preview"` // off, full (the preview replaces the editor) or side (beside it)
	Zen            bool    `json:"zen"`
	Fullscreen     *bool   `json:"fullscreen"` // null when the page cannot tell
}

type pageUIState struct {
	ActiveTabID    string  `json:"activeTabId"`
	SplitMode      bool    `json:"splitMode"`
	SecondaryTabID *string `json:"secondaryTabId"`
	Preview        string  `json:"preview"`
	Zen            bool    `json:"zen"`
	Fullscreen     *bool   `json:"fullscreen"`
}

func (p pageUIState) result() *uiStateResult {
	return &uiStateResult{ActiveTabID: p.ActiveTabID, Split: p.SplitMode, SecondaryTabID: p.SecondaryTabID, Preview: p.Preview, Zen: p.Zen, Fullscreen: p.Fullscreen}
}

func (a *App) rpcUIState(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	resJSON, err := a.callRPCJS(ctx, "getUiState")
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to read the view")
	}
	var ps pageUIState
	if err := json.Unmarshal([]byte(resJSON), &ps); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid view response: %v", err))
	}
	return successResponse(req.ID, ps.result())
}

// rpcUISetView sets the view the way the shortcuts do, each key optional and idempotent: preview "off" | "full" | "side", split true or
// false, zen true or false. The answer is the view afterwards (ui.state).
func (a *App) rpcUISetView(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Preview *string `json:"preview"`
		Split   *bool   `json:"split"`
		Zen     *bool   `json:"zen"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	spec := map[string]interface{}{}
	if params.Preview != nil {
		switch *params.Preview {
		case "off", "full", "side":
			spec["preview"] = *params.Preview
		default:
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, `preview must be "off", "full" or "side"`)
		}
	}
	if params.Split != nil {
		spec["split"] = *params.Split
	}
	if params.Zen != nil {
		spec["zen"] = *params.Zen
	}
	if len(spec) == 0 {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "give at least one of preview, split, zen")
	}
	resJSON, err := a.callRPCJS(ctx, "setUiState", spec)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to change the view")
	}
	var ps pageUIState
	if err := json.Unmarshal([]byte(resJSON), &ps); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid view response: %v", err))
	}
	return successResponse(req.ID, ps.result())
}

// rpcUIOpenPanel shows one of the app's own panels (find, replace, scraps_search, settings, shortcuts, snippets, all_tabs,
// command_palette) as the shortcut would. It runs nothing: no AI request, no command, no save.
func (a *App) rpcUIOpenPanel(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Name string `json:"name"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if strings.TrimSpace(params.Name) == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "name is required")
	}
	resJSON, err := a.callRPCJS(ctx, "openPanel", params.Name)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to open the panel")
	}
	var out map[string]interface{}
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid panel response: %v", err))
	}
	return successResponse(req.ID, out)
}

// snakeKeys turns the camelCase keys of the page's objects into the snake_case the new methods use (startedAt -> started_at).
func snakeKeys(v interface{}) interface{} {
	switch x := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(x))
		for k, val := range x {
			out[snakeCase(k)] = snakeKeys(val)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for i := range x {
			out[i] = snakeKeys(x[i])
		}
		return out
	}
	return v
}

func snakeCase(s string) string {
	var sb strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				sb.WriteByte('_')
			}
			sb.WriteRune(r + 'a' - 'A')
			continue
		}
		sb.WriteRune(r)
	}
	return sb.String()
}

// rpcTaskList lists the tasks the app is running or ran lately (the Task panel's content): the AI requests, slots and commands the
// person started. It lists, it does not start anything.
func (a *App) rpcTaskList(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	resJSON, err := a.callRPCJS(ctx, "getTasks")
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to list the tasks")
	}
	var out interface{}
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid task response: %v", err))
	}
	return successResponse(req.ID, snakeKeys(out))
}

// rpcTaskCancel stops a running task, the way the Task panel's cancel button does.
func (a *App) rpcTaskCancel(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		ID string `json:"id"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if strings.TrimSpace(params.ID) == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "id is required (an id from task.list)")
	}
	resJSON, err := a.callRPCJS(ctx, "cancelTask", params.ID)
	if err != nil {
		return jsErrorResponse(req.ID, err, "failed to cancel the task")
	}
	var out interface{}
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid task response: %v", err))
	}
	return successResponse(req.ID, snakeKeys(out))
}
