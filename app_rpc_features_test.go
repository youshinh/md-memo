package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/ipc"
)

// JSON-RPC print.pdf and deepsearch.plan, and the query and mode of ui.open_panel (app_rpc_features.go, app_rpc_extra.go).

// printAvailable makes this build "have a PDF engine" for a test (only Windows does), and puts the real answer back.
func printAvailable(t *testing.T, on bool) {
	t.Helper()
	was := printPdfAvailable
	printPdfAvailable = func() bool { return on }
	t.Cleanup(func() { printPdfAvailable = was })
}

func TestRPCPrintPdfNeedsAPdfEngineAndVetsWhereItWrites(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "note.pdf")
	app, page := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		return `{"path":"x","bytes":1,"pages":1,"tab_id":"tab_1"}`, ""
	})

	printAvailable(t, false)
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": good}), ipc.ErrCodeInternalError, "not available on this platform")
	if len(page.calls) != 0 {
		t.Errorf("no page call without an engine: %v", page.calls)
	}

	printAvailable(t, true)
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{}), ipc.ErrCodeInvalidParams, "out is required")
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": "rel/note.pdf"}), ipc.ErrCodeInvalidParams, "absolute")
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": filepath.Join(dir, "note.txt")}), ipc.ErrCodeInvalidParams, "must end in .pdf")
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": filepath.Join(dir, "missing", "note.pdf")}), ipc.ErrCodeInvalidParams, "does not exist")
	// a folder named like a PDF is not a file
	if err := os.Mkdir(filepath.Join(dir, "folder.pdf"), 0o755); err != nil {
		t.Fatal(err)
	}
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": filepath.Join(dir, "folder.pdf")}), ipc.ErrCodeInvalidParams, "is a folder")
	// the settings go through the engine's own checks
	for name, p := range map[string]map[string]interface{}{
		"paper": {"paper": "a0"}, "margin": {"margin": "huge"}, "scale": {"scale": 900}, "pages": {"pages": "1; rm -rf"},
	} {
		p["out"] = good
		if resp := rpcDo(app, "print.pdf", p); resp.Error == nil || resp.Error.Code != ipc.ErrCodeInvalidParams {
			t.Errorf("%s: %+v", name, resp)
		}
	}
	// a file that is there is not replaced unless asked
	if err := os.WriteFile(good, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": good}), ipc.ErrCodeConflict, "overwrite:true")
	if len(page.calls) != 0 {
		t.Errorf("a refused request must not touch the page: %v", page.calls)
	}
}

func TestRPCPrintPdfAsksThePageAndAnswersWithItsResult(t *testing.T) {
	printAvailable(t, true)
	dir := t.TempDir()
	out := filepath.Join(dir, "report.PDF") // the extension is not case-sensitive
	app, page := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		if fn != "printPdf" {
			return "", "mock: unexpected " + fn
		}
		return `{"path":` + string(args[2]) + `,"bytes":4321,"pages":3,"tab_id":"tab_7"}`, ""
	})

	got := rpcOK(t, rpcDo(app, "print.pdf", map[string]interface{}{
		"out": out, "tab_id": "tab_7", "paper": "a3", "landscape": true, "margin": "narrow", "scale": 80, "pages": " 1-2 ", "header_footer": true,
	}))
	if got["path"] != out || num(got, "bytes") != 4321 || num(got, "pages") != 3 || got["tab_id"] != "tab_7" {
		t.Errorf("print.pdf = %v", got)
	}
	call := page.lastCall()
	if !strings.HasPrefix(call, `printPdf("tab_7", {`) {
		t.Fatalf("page call = %s", call)
	}
	for _, want := range []string{`"paper":"a3"`, `"landscape":true`, `"margin":"narrow"`, `"scale":80`, `"pages":"1-2"`, `"headerFooter":true`} {
		if !strings.Contains(call, want) {
			t.Errorf("page call lacks %s: %s", want, call)
		}
	}

	// defaults: A4, portrait, normal margins, 100 %, all pages, no header and footer, the active tab
	page.mu.Lock()
	page.calls = nil
	page.mu.Unlock()
	rpcOK(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": filepath.Join(dir, "plain.pdf")}))
	call = page.lastCall()
	for _, want := range []string{`printPdf("", {`,`"paper":"a4"`, `"landscape":false`, `"margin":"normal"`, `"scale":100`, `"pages":""`, `"headerFooter":false`} {
		if !strings.Contains(call, want) {
			t.Errorf("default page call lacks %s: %s", want, call)
		}
	}

	// overwrite:true replaces a file that is there
	if err := os.WriteFile(filepath.Join(dir, "plain.pdf"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	rpcOK(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": filepath.Join(dir, "plain.pdf"), "overwrite": true}))
}

func TestRPCPrintPdfKeepsTheCodesOfThePagesErrors(t *testing.T) {
	printAvailable(t, true)
	out := filepath.Join(t.TempDir(), "n.pdf")
	for _, c := range []struct {
		pageErr string
		code    int
		text    string
	}{
		{"[not_found] no such tab: tab_9", ipc.ErrCodeNotFound, "no such tab"},
		{"[invalid_params] an HTML page has no print layout", ipc.ErrCodeInvalidParams, "no print layout"},
		{"[conflict] a print is already in progress", ipc.ErrCodeConflict, "already in progress"},
		{"the engine said no", ipc.ErrCodeInternalError, "print.pdf failed: the engine said no"},
	} {
		app, _ := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) { return "", c.pageErr })
		rpcErr(t, rpcDo(app, "print.pdf", map[string]interface{}{"out": out, "tab_id": "tab_9"}), c.code, c.text)
	}
}

func TestRPCDeepSearchPlanIsADryRunThatKeepsNothing(t *testing.T) {
	// no text model: answered at once, nothing searched
	deepSandbox(t, "", "", nil)
	app := &App{}
	got := rpcOK(t, rpcDo(app, "deepsearch.plan", map[string]interface{}{"query": "竹の話"}))
	if got["model_configured"] != false || got["plan_id"] != "" {
		t.Errorf("no model configured: %v", got)
	}
	rpcErr(t, rpcDo(app, "deepsearch.plan", map[string]interface{}{"query": "  "}), ipc.ErrCodeInvalidParams, "query is required")

	// with a model on this machine and the notes indexed: sources, sizes and where it would go, and no plan kept
	srv := newDeepFakeServer(t)
	app, _, _ = deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	buildDeepIndex(t)
	deepPlans.mu.Lock()
	before := len(deepPlans.plans)
	deepPlans.mu.Unlock()

	got = rpcOK(t, rpcDo(app, "deepsearch.plan", map[string]interface{}{"query": "竹の成長について", "limit": 5}))
	if got["model_configured"] != true || got["semantic"] != true {
		t.Fatalf("plan = %v", got)
	}
	if id, _ := got["plan_id"].(string); id != "" {
		t.Errorf("a dry run has no plan id: %q", id)
	}
	sources, _ := got["sources"].([]interface{})
	if len(sources) == 0 || len(sources) > 5 {
		t.Errorf("sources = %v", got["sources"])
	}
	dest, _ := got["destination"].(map[string]interface{})
	if dest["local"] != true || dest["consent_given"] != true || dest["model"] != "test-model" {
		t.Errorf("destination = %v", dest)
	}
	if num(got, "est_tokens") <= 0 {
		t.Errorf("est_tokens = %v", got["est_tokens"])
	}
	if stats, _ := got["stats"].(map[string]interface{}); num(stats, "masked") != 1 {
		t.Errorf("the key in the notes is taken out of what would be sent, and the plan says so: %v", got["stats"])
	}
	deepPlans.mu.Lock()
	after := len(deepPlans.plans)
	deepPlans.mu.Unlock()
	if after != before {
		t.Errorf("a dry run kept a plan (%d -> %d): it could push a person's pending plan out of the store", before, after)
	}
	// the answer carries no note text, only where the excerpts are
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), "竹は成長が早く") {
		t.Errorf("excerpt text in the plan: %s", raw)
	}
}

func TestRPCOpenPanelTakesAQueryAndAModeForTheNotesSearchOnly(t *testing.T) {
	var gotArgs []string
	app, page := newPageApp(t, func(fn string, args []json.RawMessage) (string, string) {
		gotArgs = nil
		for _, a := range args {
			gotArgs = append(gotArgs, string(a))
		}
		if fn != "openPanel" {
			return "", "mock: unexpected " + fn
		}
		return `{"panel":"scraps_search","mode":"meaning"}`, ""
	})
	got := rpcOK(t, rpcDo(app, "ui.open_panel", map[string]interface{}{"name": "scraps_search", "mode": "meaning", "query": "竹の伐採"}))
	if got["panel"] != "scraps_search" || got["mode"] != "meaning" {
		t.Errorf("open_panel = %v", got)
	}
	if len(gotArgs) != 2 || gotArgs[0] != `"scraps_search"` || !strings.Contains(gotArgs[1], `"query":"竹の伐採"`) || !strings.Contains(gotArgs[1], `"mode":"meaning"`) {
		t.Errorf("page args = %v", gotArgs)
	}
	// without them it is the plain opening, as before (one argument)
	rpcOK(t, rpcDo(app, "ui.open_panel", map[string]interface{}{"name": "scraps_search"}))
	if len(gotArgs) != 1 {
		t.Errorf("plain opening passes only the name: %v", gotArgs)
	}
	page.mu.Lock()
	page.calls = nil
	page.mu.Unlock()
	rpcErr(t, rpcDo(app, "ui.open_panel", map[string]interface{}{"name": "scraps_search", "mode": "fuzzy"}), ipc.ErrCodeInvalidParams, `mode must be "exact" or "meaning"`)
	rpcErr(t, rpcDo(app, "ui.open_panel", map[string]interface{}{"name": "find", "query": "x"}), ipc.ErrCodeInvalidParams, "scraps_search only")
	rpcErr(t, rpcDo(app, "ui.open_panel", map[string]interface{}{"name": "scraps_search", "query": strings.Repeat("あ", 4001)}), ipc.ErrCodeInvalidParams, "longer than 4000")
	if len(page.calls) != 0 {
		t.Errorf("a refused request must not touch the page: %v", page.calls)
	}
}
