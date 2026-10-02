package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// What the print panel asks of the engine, how the PDF is kept for the preview, and how it is saved. The engine itself (WebView2's
// Page.printToPDF) is not run here: printToPDF is replaced by a function that records what it was asked and answers a small PDF.

const fakePDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 3 /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Pages /Count 2 /Parent 2 0 R /Kids [] >>\nendobj\n%%EOF\n"

func TestPrintSettingsBecomeTheEnginesParameters(t *testing.T) {
	p, err := printSettings{}.cdpParams()
	if err != nil {
		t.Fatal(err)
	}
	if p["paperWidth"] != 8.27 || p["paperHeight"] != 11.69 || p["landscape"] != false || p["scale"] != 1.0 {
		t.Errorf("the defaults are A4, portrait, 100%%: %v", p)
	}
	if p["displayHeaderFooter"] != false {
		t.Errorf("header and footer are off unless asked for: %v", p["displayHeaderFooter"])
	}
	if _, has := p["headerTemplate"]; has {
		t.Errorf("no header template while the header is off")
	}
	if p["printBackground"] != true || p["preferCSSPageSize"] != false || p["transferMode"] != "ReturnAsBase64" {
		t.Errorf("fixed parameters: %v", p)
	}
	if _, has := p["pageRanges"]; has {
		t.Errorf("all pages: no range")
	}

	p, err = printSettings{Paper: "a3", Landscape: true, Margin: "narrow", Scale: 125, Pages: " 1-3, 5 "}.cdpParams()
	if err != nil {
		t.Fatal(err)
	}
	if p["paperWidth"] != 11.69 || p["paperHeight"] != 16.54 || p["landscape"] != true || p["scale"] != 1.25 || p["pageRanges"] != "1-3, 5" {
		t.Errorf("A3 landscape, 125%%, pages: %v", p)
	}
	if p["marginTop"] != 0.39 || p["marginLeft"] != 0.39 {
		t.Errorf("narrow margins (10 mm): %v %v", p["marginTop"], p["marginLeft"])
	}
	p, err = printSettings{}.cdpParams()
	if err != nil {
		t.Fatal(err)
	}
	if p["marginTop"] != 0.79 || p["marginRight"] != 0.79 || p["marginBottom"] != 0.79 || p["marginLeft"] != 0.79 {
		t.Errorf("normal margins (20 mm all round): %v %v %v %v", p["marginTop"], p["marginRight"], p["marginBottom"], p["marginLeft"])
	}
	for _, paper := range []string{"a4", "a3", "b5", "letter"} {
		if _, err := (printSettings{Paper: paper}).cdpParams(); err != nil {
			t.Errorf("%s: %v", paper, err)
		}
	}
	for _, bad := range []printSettings{{Paper: "a0"}, {Margin: "huge"}, {Scale: 5}, {Scale: 900}, {Pages: "1; rm -rf"}, {Pages: strings.Repeat("1,", 80)}} {
		if _, err := bad.cdpParams(); err == nil {
			t.Errorf("%+v must be refused", bad)
		}
	}
}

func TestPrintHeaderAndFooterAreTheFilesNameAndPlace(t *testing.T) {
	s := printSettings{HeaderFooter: true, Title: `<b>2026-10-02</b>.md`, Location: `C:\Users\me\notes & more\<x>`}
	p, err := s.cdpParams()
	if err != nil {
		t.Fatal(err)
	}
	head, foot := p["headerTemplate"].(string), p["footerTemplate"].(string)
	if p["displayHeaderFooter"] != true {
		t.Fatalf("header and footer are on")
	}
	if !strings.Contains(head, "&lt;b&gt;2026-10-02&lt;/b&gt;.md") || strings.Contains(head, "<b>") {
		t.Errorf("a file name is text, not markup: %s", head)
	}
	if !strings.Contains(foot, `C:\Users\me\notes &amp; more\&lt;x&gt;`) || !strings.Contains(foot, `class="pageNumber"`) || !strings.Contains(foot, `class="totalPages"`) {
		t.Errorf("the footer holds the place and the page number: %s", foot)
	}
	// the browser's own date and address are not printed: the templates are the whole header and footer
	if strings.Contains(head+foot, "class=\"date\"") || strings.Contains(head+foot, "class=\"url\"") || strings.Contains(head+foot, "class=\"title\"") {
		t.Errorf("no date, address or page title: %s %s", head, foot)
	}
	if !strings.Contains(head, "font:8px") || !strings.Contains(foot, "font:8px") {
		t.Errorf("a font size must be written out (the default is 0)")
	}
	// the margins leave room for them, even narrow
	narrow := printSettings{HeaderFooter: true, Margin: "narrow"}
	top, _, bottom, _ := narrow.margins()
	if top < 0.45 || bottom < 0.45 {
		t.Errorf("narrow margins with a header: %v %v", top, bottom)
	}
	top, _, bottom, _ = printSettings{Margin: "narrow"}.margins()
	if top != 0.39 || bottom != 0.39 {
		t.Errorf("narrow margins without one stay narrow: %v %v", top, bottom)
	}
	// a long file name and a long path do not run away
	long := strings.Repeat("あ", 500)
	if got := oneLinePrint("a\n  b\t"+long, 20); len([]rune(got)) != 20 || !strings.HasSuffix(got, "…") || !strings.HasPrefix(got, "a b ") {
		t.Errorf("oneLinePrint = %q", got)
	}
}

func TestPdfPageCountIsTheLargestCount(t *testing.T) {
	if n := pdfPageCount([]byte(fakePDF)); n != 3 {
		t.Errorf("pages = %d, want 3 (the root of the page tree)", n)
	}
	for _, none := range []string{"", "not a pdf", "/Count x"} {
		if n := pdfPageCount([]byte(none)); n != 0 {
			t.Errorf("%q: %d", none, n)
		}
	}
}

func TestDecodePrintPDFTakesTheDataOfTheAnswer(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte(fakePDF))
	if pdf, err := decodePrintPDF(`{"data":"` + b64 + `"}`); err != nil || string(pdf) != fakePDF {
		t.Errorf("%v %q", err, pdf)
	}
	for _, bad := range []string{``, `{}`, `{"data":""}`, `{"data":"%%%"}`, `nope`} {
		if _, err := decodePrintPDF(bad); err == nil {
			t.Errorf("%q must be an error", bad)
		}
	}
}

func TestThePreviewPDFIsServedOnlyToTheAppWithItsToken(t *testing.T) {
	forgetPrintPDF()
	defer forgetPrintPDF()
	const port = 41739
	get := func(host, query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/print/preview.pdf"+query, nil)
		req.Host = host
		rec := httptest.NewRecorder()
		servePrintPreview(rec, req, port)
		return rec
	}
	if rec := get("127.0.0.1:41739", ""); rec.Code != http.StatusNotFound {
		t.Errorf("nothing kept yet: %d", rec.Code)
	}
	url := keepPrintPDF([]byte(fakePDF))
	query := url[strings.Index(url, "?"):]
	rec := get("127.0.0.1:41739", query)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/pdf" || rec.Body.String() != fakePDF || rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("the kept PDF: %d %v", rec.Code, rec.Header())
	}
	if rec := get("localhost:41739", query); rec.Code != 200 {
		t.Errorf("localhost is this server too: %d", rec.Code)
	}
	if rec := get("evil.example:41739", query); rec.Code != http.StatusForbidden {
		t.Errorf("another host name: %d", rec.Code)
	}
	if rec := get("127.0.0.1:41739", "?t=guess"); rec.Code != http.StatusNotFound {
		t.Errorf("a wrong token: %d", rec.Code)
	}
	// a newer PDF replaces it: the old address stops working
	newer := keepPrintPDF([]byte("%PDF newer"))
	if newer == url {
		t.Errorf("every PDF gets its own address")
	}
	if rec := get("127.0.0.1:41739", query); rec.Code != http.StatusNotFound {
		t.Errorf("the replaced PDF is gone: %d", rec.Code)
	}
	(&App{}).PrintPreviewClose()
	if rec := get("127.0.0.1:41739", newer[strings.Index(newer, "?"):]); rec.Code != http.StatusNotFound {
		t.Errorf("closed: %d", rec.Code)
	}
}

// enginePDF puts a fake engine in place of the platform's and records the parameters of each print.
func enginePDF(t *testing.T) (calls *[]map[string]interface{}, mu *sync.Mutex) {
	t.Helper()
	var list []map[string]interface{}
	var lock sync.Mutex
	old := printToPDF
	printToPDF = func(a *App, params map[string]interface{}) ([]byte, error) {
		lock.Lock()
		list = append(list, params)
		lock.Unlock()
		return []byte(fakePDF), nil
	}
	t.Cleanup(func() { printToPDF = old })
	return &list, &lock
}

func TestPrintPreviewAsyncKeepsThePDFAndAnswersItsAddress(t *testing.T) {
	forgetPrintPDF()
	defer forgetPrintPDF()
	calls, mu := enginePDF(t)
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	opts, _ := json.Marshal(printSettings{Paper: "b5", Landscape: true, HeaderFooter: true, Title: "a.md", Location: "C:\\n"})
	app.PrintPreviewAsync("r1", string(opts))
	e := mock.waitFor(t, `__onPrintPdfResult("r1"`, 5*time.Second)
	if !strings.Contains(e, `"url":"/api/print/preview.pdf?t=`) || !strings.Contains(e, `"pages":3`) || !strings.HasSuffix(e, `, ""); }`) {
		t.Errorf("answer: %s", e)
	}
	mu.Lock()
	got := (*calls)[0]
	mu.Unlock()
	if got["paperWidth"] != 7.17 || got["landscape"] != true || got["displayHeaderFooter"] != true {
		t.Errorf("the engine was asked: %v", got)
	}

	app.PrintPreviewAsync("r2", `{"paper":"a0"}`)
	e2 := mock.waitFor(t, `__onPrintPdfResult("r2"`, 5*time.Second)
	if !strings.Contains(e2, `null, "unknown paper`) {
		t.Errorf("a bad setting is an error sentence: %s", e2)
	}
	app.PrintPreviewAsync("r3", `not json`)
	if e3 := mock.waitFor(t, `__onPrintPdfResult("r3"`, 5*time.Second); !strings.Contains(e3, `null, "the print settings could not be read`) {
		t.Errorf("%s", e3)
	}
}

func TestPrintSavePdfAsyncWritesTheFileWhereTheyChose(t *testing.T) {
	enginePDF(t)
	dir := t.TempDir()
	mock := &asyncMockWebView{}
	app := &App{w: mock}

	app.PrintSavePdfAsync("s1", `{"paper":"a4"}`, filepath.Join(dir, "note"))
	e := mock.waitFor(t, `__onPrintPdfResult("s1"`, 5*time.Second)
	want := filepath.Join(dir, "note.pdf")
	if b, err := os.ReadFile(want); err != nil || string(b) != fakePDF {
		t.Fatalf("the file %s: %v %q", want, err, b)
	}
	if !strings.Contains(e, `"bytes":`) || !strings.Contains(e, `"pages":3`) || !strings.Contains(e, `note.pdf`) {
		t.Errorf("answer: %s", e)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, ".md-memo-pdf-*")); len(left) != 0 {
		t.Errorf("no temporary file is left: %v", left)
	}
	// .PDF stays as it is; no path, a missing folder and bad settings write nothing
	app.PrintSavePdfAsync("s2", `{}`, filepath.Join(dir, "Big.PDF"))
	mock.waitFor(t, `__onPrintPdfResult("s2"`, 5*time.Second)
	if _, err := os.Stat(filepath.Join(dir, "Big.PDF")); err != nil {
		t.Errorf("the extension was kept: %v", err)
	}
	for id, c := range map[string]struct{ opts, path, want string }{
		"s3": {`{}`, "  ", "no file name"},
		"s4": {`{}`, filepath.Join(dir, "missing", "x.pdf"), "does not exist"},
		"s5": {`{"scale":3}`, filepath.Join(dir, "x.pdf"), "scale"},
	} {
		app.PrintSavePdfAsync(id, c.opts, c.path)
		if e := mock.waitFor(t, `__onPrintPdfResult("`+id+`"`, 5*time.Second); !strings.Contains(e, `null, "`) || !strings.Contains(e, c.want) {
			t.Errorf("%s: %s", id, e)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "x.pdf")); err == nil {
		t.Errorf("bad settings wrote a file")
	}
}

func TestPrintPickPdfPathOffersTheNotesName(t *testing.T) {
	// the dialog itself is not shown here: only what it is offered is worked out (the Windows dialog is not started in a test)
	if got := safePdfName("2026-10-02.md"); got != "2026-10-02" {
		t.Errorf("%q", got)
	}
	if got := safePdfName(`a:b*c?.md`); got != "a_b_c_" {
		t.Errorf("%q", got)
	}
	if got := safePdfName("  "); got != "note" {
		t.Errorf("%q", got)
	}
	if got := safePdfName("見積もり.markdown"); got != "見積もり" {
		t.Errorf("%q", got)
	}
}
