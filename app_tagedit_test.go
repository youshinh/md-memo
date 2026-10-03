package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/ipc"
)

// The tag editor's two doors into the app (docs/design/tag-filter-2026-10.md sections 10.5 and 10.6): the JSON-RPC method scrap.tag_edit
// and the window's bind TagEditAsync. Both are the calculation of cli.ScrapTagEdit on the text they are given; the rules of where a tag
// goes are tested in pkg/search and the command in pkg/cli.

func TestRPCScrapTagEdit(t *testing.T) {
	dir := scrapConfig(t, nil) // a settings folder to be safe; the folder itself must stay uncreated
	app := &App{}

	r := rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "# H\nbody\n", "op": "add", "scope": "entry", "line": 2, "tags": []string{"仕事"}}))
	want := map[string]interface{}{
		"changed": true, "scope": "entry", "start_line": 2.0, "end_line": 2.0, "new_lines": []interface{}{"<!-- tags: 仕事 -->"}, "eol": "\n", "line": 2.0,
		"added": []interface{}{"仕事"}, "removed": []interface{}{}, "unchanged": []interface{}{}, "note_tags": []interface{}{}, "entry_tags": []interface{}{"仕事"},
		"message_code": "",
	}
	if !reflect.DeepEqual(r, want) {
		t.Errorf("add:\n%v\nwant\n%v", r, want)
	}

	// tags as a string, scope defaulting to note, and the whole new text on request
	r = rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "# H\r\nbody\r\n", "op": "add", "tags": "仕事, 急ぎ", "return_text": true}))
	if r["scope"] != "note" || r["text"] != "<!-- tags: 仕事, 急ぎ -->\r\n# H\r\nbody\r\n" || r["eol"] != "\r\n" || r["changed"] != true {
		t.Errorf("note: %v", r)
	}
	// no text unless asked for
	if _, has := rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "x", "op": "show"}))["text"]; has {
		t.Error("text without return_text")
	}

	// remove, show, and the answers that are not errors
	r = rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "# H\n<!-- tags: a -->\nbody\n", "op": "remove", "scope": "entry", "line": 3, "tags": "a", "return_text": true}))
	if r["changed"] != true || r["text"] != "# H\nbody\n" || r["line"] != 0.0 {
		t.Errorf("remove: %v", r)
	}
	r = rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "<!-- tags: n -->\n# H\n<!-- tags: e -->\nbody\n", "op": "show", "scope": "entry", "line": 4}))
	if !reflect.DeepEqual(r["note_tags"], []interface{}{"n"}) || !reflect.DeepEqual(r["entry_tags"], []interface{}{"e"}) || r["changed"] != false {
		t.Errorf("show: %v", r)
	}
	r = rpcOK(t, rpcDo(app, "scrap.tag_edit", map[string]interface{}{"text": "---\ntags: x\n---\nbody\n", "op": "add", "tags": "a"}))
	if r["changed"] != false || r["message_code"] != "front_matter" || r["unchanged"].([]interface{})[0] != "a" {
		t.Errorf("a refusal is an answer: %v", r)
	}

	// bad parameters are -32602, naming the rule
	for _, c := range []struct {
		params map[string]interface{}
		want   string
	}{
		{map[string]interface{}{"text": "x", "tags": "a"}, "op required"},
		{map[string]interface{}{"text": "x", "op": "toggle", "tags": "a"}, "unknown op"},
		{map[string]interface{}{"text": "x", "op": "add", "scope": "file", "tags": "a"}, "unknown scope"},
		{map[string]interface{}{"text": "x", "op": "add", "scope": "entry", "tags": "a"}, "needs line"},
		{map[string]interface{}{"text": "x", "op": "add", "scope": "entry", "line": 9, "tags": "a"}, "outside the text"},
		{map[string]interface{}{"text": "x", "op": "add"}, "no tag"},
		{map[string]interface{}{"text": "x", "op": "add", "tags": 3}, "tags must be a string or a list of strings"},
		{map[string]interface{}{"text": "x", "op": "add", "tags": "a,b,c,d,e,f,g,h,i"}, "too many tags"},
		{map[string]interface{}{"text": "x", "op": "add", "tags": []string{strings.Repeat("x", 65)}}, "longer than 64"},
		{map[string]interface{}{"text": 3, "op": "add", "tags": "a"}, "invalid scrap.tag_edit params"},
	} {
		rpcErr(t, rpcDo(app, "scrap.tag_edit", c.params), ipc.ErrCodeInvalidParams, c.want)
	}

	// it is a calculation: no file is made, and the scrap folder is not even created
	if _, err := os.Stat(dir); err == nil {
		t.Error("scrap.tag_edit created the scrap folder")
	}
	// like every method that is not one of the three old reads it needs the token (the unauthenticated call is also in
	// TestRPCExtraMethodsNeedTheSessionToken's list)
	if ipc.IsReadOnlyMethod("scrap.tag_edit") {
		t.Error("scrap.tag_edit must need the session token")
	}
}

func TestTagEditAsyncAnswersLikeTheRPCMethod(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	reqs := []string{
		`{"text":"# H\nbody\n","op":"add","scope":"entry","line":2,"tags":["仕事"]}`,
		`{"text":"# H\r\nbody\r\n","op":"add","tags":"仕事, 急ぎ","return_text":true}`,
		`{"text":"# H\n<!-- tags: a -->\nbody\n","op":"remove","scope":"entry","line":3,"tags":["a"]}`,
		`{"text":"---\ntags: x\n---\nbody\n","op":"add","tags":["a"]}`,
		`{"text":"<!-- tags: n -->\n# H\n<!-- tags: e -->\nbody\n","op":"show","scope":"entry","line":4}`,
	}
	for i, req := range reqs {
		id := "t" + string(rune('a'+i))
		app.TagEditAsync(id, req)
		got, msg := resultOf(t, mock, id)
		if msg != "" {
			t.Fatalf("%s: %q", req, msg)
		}
		var params json.RawMessage = json.RawMessage(req)
		rpc := app.DispatchRPCOperation(&ipc.RPCRequest{JSONRPC: "2.0", ID: 1, Method: "scrap.tag_edit", Params: params})
		if !reflect.DeepEqual(got, rpcOK(t, rpc)) {
			t.Errorf("%s:\nbind %v\nrpc  %v", req, got, rpcOK(t, rpc))
		}
		// the lists are never null: the page iterates them
		for _, k := range []string{"new_lines", "added", "removed", "unchanged", "note_tags", "entry_tags"} {
			if _, ok := got[k].([]interface{}); !ok {
				t.Errorf("%s: %s is %v, not a list", req, k, got[k])
			}
		}
	}

	// the delivery is the one every async bind of the page uses
	app.TagEditAsync("fmt", reqs[0])
	e := mock.waitFor(t, `__onDeepSearchResult("fmt"`, 5*time.Second)
	if !strings.HasPrefix(e, "if (window.__onDeepSearchResult)") || !strings.HasSuffix(e, `, ""); }`) {
		t.Errorf("delivery: %s", e)
	}
}

func TestTagEditAsyncRefusesABadRequestInOneLine(t *testing.T) {
	mock := &asyncMockWebView{}
	app := &App{w: mock}
	over := `{"text":"` + strings.Repeat("a", 16<<20) + `","op":"show"}`
	for i, c := range []struct{ req, want string }{
		{``, "empty"},
		{`   `, "empty"},
		{`not json`, "not valid"},
		{`[1]`, "not valid"},
		{`{"text":3,"op":"add","tags":"a"}`, "not valid"},
		{`{"text":"x","op":"add","tags":3}`, "tags must be a string or a list of strings"},
		{`{"text":"x","tags":"a"}`, "op required"},
		{`{"text":"x","op":"nope","tags":"a"}`, "unknown op"},
		{`{"text":"x","op":"add","scope":"entry","tags":"a"}`, "needs line"},
		{`{"text":"x","op":"add","tags":"a,b,c,d,e,f,g,h,i"}`, "too many tags"},
		{over, "over 16 MB"},
	} {
		id := "e" + string(rune('a'+i))
		app.TagEditAsync(id, c.req)
		// "null, <message>": the message may hold ", " itself, so it is read as the JSON string it is
		e := mock.waitFor(t, `__onDeepSearchResult("`+id+`"`, 10*time.Second)
		rest := strings.TrimSuffix(e[strings.Index(e, `("`+id+`", `)+len(`("`+id+`", `):], "); }")
		var msg string
		if !strings.HasPrefix(rest, "null, ") || json.Unmarshal([]byte(strings.TrimPrefix(rest, "null, ")), &msg) != nil {
			t.Errorf("%.40q: delivered %s, want null and an error message", c.req, rest)
			continue
		}
		if !strings.Contains(msg, c.want) || strings.Contains(msg, "\n") {
			t.Errorf("%.40q: message %q; want a one-line error with %q", c.req, msg, c.want)
		}
	}
}

// The calculation takes only the request: no settings, no scrap folder, no window (an App with none answers).
func TestTagEditNeedsNothingButTheRequest(t *testing.T) {
	res, err := tagEdit(`{"text":"# H\nbody\n","op":"add","scope":"entry","line":2,"tags":["a"]}`)
	if err != nil || !res.Changed || !reflect.DeepEqual(res.NewLines, []string{"<!-- tags: a -->"}) {
		t.Errorf("%+v %v", res, err)
	}
	(&App{}).TagEditAsync("no-window", `{"text":"x","op":"show"}`) // dispatching to no window must not panic
}
