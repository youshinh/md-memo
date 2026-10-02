package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"md-memo/pkg/ipc"
)

// `md-memo tab pdf`: the flags become the print.pdf parameters; a file is opened in a background tab for the print and closed again (unless it
// was open already); the PDF goes next to the file when --out is not given; nothing is sent on a mistake.

func pdfHandler(opened ipc.TabNewResult) func(string, json.RawMessage) (interface{}, *ipc.RPCError) {
	return func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		switch method {
		case "tab.new":
			return opened, nil
		case "print.pdf":
			var p map[string]interface{}
			_ = json.Unmarshal(params, &p)
			tab, _ := p["tab_id"].(string)
			return pdfResult{Path: p["out"].(string), Bytes: 2048, Pages: 2, TabID: tab}, nil
		case "tab.close":
			return ipc.TabCloseResult{Closed: true}, nil
		}
		return nil, &ipc.RPCError{Code: ipc.ErrCodeMethodNotFound, Message: method}
	}
}

func methods(peer *capturePeer) []string {
	var out []string
	for _, r := range peer.all() {
		out = append(out, r.Method)
	}
	return out
}

func TestTabPDFOfTheActiveTabSendsTheFlags(t *testing.T) {
	session, peer := startCapturePeer(t, pdfHandler(ipc.TabNewResult{}))
	out := filepath.Join(t.TempDir(), "report.pdf")
	stdout, _, code, err := runClient(session, "tab", "pdf", "-o", out, "--paper", "a3", "--landscape", "--margin", "narrow", "--scale", "80", "--pages", "1-2", "--header-footer", "--overwrite", "--text")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if !strings.Contains(stdout, "Wrote "+out) || !strings.Contains(stdout, "2 page(s)") {
		t.Errorf("text output = %q", stdout)
	}
	if got := methods(peer); len(got) != 1 || got[0] != "print.pdf" {
		t.Fatalf("only print.pdf is called for the active tab: %v", got)
	}
	p := peer.params(t)
	want := map[string]interface{}{"out": out, "overwrite": true, "paper": "a3", "landscape": true, "margin": "narrow", "scale": float64(80), "pages": "1-2", "header_footer": true}
	for k, v := range want {
		if p[k] != v {
			t.Errorf("param %s = %v, want %v", k, p[k], v)
		}
	}
	if _, has := p["tab_id"]; has {
		t.Errorf("no tab given, none sent: %v", p)
	}

	// the minimum: --out only (the app's defaults apply to everything else)
	_, _, code, err = runClient(session, "tab", "pdf", "--out", out, "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	p = peer.params(t)
	for _, k := range []string{"paper", "landscape", "margin", "scale", "pages", "header_footer"} {
		if _, has := p[k]; has {
			t.Errorf("%s was not asked for, so it is not sent: %v", k, p)
		}
	}
	if p["overwrite"] != false {
		t.Errorf("overwrite defaults to false: %v", p)
	}
}

func TestTabPDFWithATabIDAndJSON(t *testing.T) {
	session, peer := startCapturePeer(t, pdfHandler(ipc.TabNewResult{}))
	out := filepath.Join(t.TempDir(), "n.pdf")
	stdout, _, code, err := runClient(session, "tab", "pdf", "--tab", "tab_9", "-o", out, "--json")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	var got pdfResult
	if err := json.Unmarshal([]byte(stdout), &got); err != nil || got.Path != out || got.TabID != "tab_9" || got.Pages != 2 {
		t.Errorf("json = %q, %v", stdout, err)
	}
	if peer.params(t)["tab_id"] != "tab_9" {
		t.Errorf("params = %v", peer.params(t))
	}
}

func TestTabPDFOfAFileOpensItInTheBackgroundAndClosesItAgain(t *testing.T) {
	dir := t.TempDir()
	note := filepath.Join(dir, "notes", "plan.md")
	session, peer := startCapturePeer(t, pdfHandler(ipc.TabNewResult{ID: "tab_new", Title: "plan.md", Path: note, Existing: false}))

	stdout, _, code, err := runClient(session, "tab", "pdf", note, "--text")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if got := methods(peer); strings.Join(got, ",") != "tab.new,print.pdf,tab.close" {
		t.Fatalf("calls = %v", got)
	}
	all := peer.all()
	var opened, printed, closed map[string]interface{}
	_ = json.Unmarshal(all[0].Params, &opened)
	_ = json.Unmarshal(all[1].Params, &printed)
	_ = json.Unmarshal(all[2].Params, &closed)
	if opened["path"] != note || opened["background"] != true {
		t.Errorf("tab.new = %v", opened)
	}
	wantOut := filepath.Join(dir, "notes", "plan.pdf")
	if printed["tab_id"] != "tab_new" || printed["out"] != wantOut {
		t.Errorf("print.pdf = %v, want the tab it opened and the PDF next to the note (%s)", printed, wantOut)
	}
	if closed["tab_id"] != "tab_new" || closed["if_saved"] != true {
		t.Errorf("tab.close = %v: the tab this command opened is closed without asking anything", closed)
	}
	if !strings.Contains(stdout, wantOut) {
		t.Errorf("output = %q", stdout)
	}

	// a file that was open already is left open
	session, peer = startCapturePeer(t, pdfHandler(ipc.TabNewResult{ID: "tab_old", Title: "plan.md", Path: note, Existing: true}))
	if _, _, code, err := runClient(session, "tab", "pdf", note, "-o", filepath.Join(dir, "x.pdf")); err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if got := methods(peer); strings.Join(got, ",") != "tab.new,print.pdf" {
		t.Errorf("a tab that was open before is not closed: %v", got)
	}
}

func TestTabPDFClosesWhatItOpenedWhenThePrintFails(t *testing.T) {
	note := filepath.Join(t.TempDir(), "plan.md")
	session, peer := startCapturePeer(t, func(method string, params json.RawMessage) (interface{}, *ipc.RPCError) {
		switch method {
		case "tab.new":
			return ipc.TabNewResult{ID: "tab_new", Path: note}, nil
		case "print.pdf":
			return nil, &ipc.RPCError{Code: ipc.ErrCodeConflict, Message: `"x.pdf" already exists: pass overwrite:true to replace it`}
		}
		return ipc.TabCloseResult{Closed: true}, nil
	})
	_, _, code, err := runClient(session, "tab", "pdf", note)
	if code != 1 || err == nil || !strings.Contains(err.Error(), "already exists: pass --overwrite") || strings.Contains(err.Error(), "overwrite:true") {
		t.Errorf("code %d err %v: the flag is spelled the CLI's way", code, err)
	}
	if got := methods(peer); strings.Join(got, ",") != "tab.new,print.pdf,tab.close" {
		t.Errorf("the tab is closed even when the print failed: %v", got)
	}
}

func TestTabPDFMistakesSendNothing(t *testing.T) {
	session, peer := startCapturePeer(t, pdfHandler(ipc.TabNewResult{}))
	for name, args := range map[string][]string{
		"no out and no file": {"tab", "pdf"},
		"a file and a tab":   {"tab", "pdf", "a.md", "--tab", "tab_1"},
		"two files":          {"tab", "pdf", "a.md", "b.md", "-o", "x.pdf"},
		"unknown flag":       {"tab", "pdf", "--nope", "-o", "x.pdf"},
	} {
		if _, _, code, err := runClient(session, args...); code != 1 || err == nil {
			t.Errorf("%s: code %d err %v", name, code, err)
		}
	}
	if len(peer.all()) != 0 {
		t.Errorf("nothing is sent for a mistake: %v", methods(peer))
	}
}

func TestTabPDFRelativeOutIsMadeAbsolute(t *testing.T) {
	session, peer := startCapturePeer(t, pdfHandler(ipc.TabNewResult{}))
	if _, _, code, err := runClient(session, "tab", "pdf", "-o", filepath.Join("out", "r.pdf")); err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	cwd, _ := os.Getwd()
	if got := peer.params(t)["out"]; got != filepath.Join(cwd, "out", "r.pdf") {
		t.Errorf("out = %v", got)
	}
}
