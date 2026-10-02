package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/atomicfile"
	"md-memo/pkg/dialog"
)

// Printing the preview to PDF with the app's own print panel (frontend/js/print_panel.js). The page is printed by WebView2's own
// engine through the DevTools protocol (Page.printToPDF), which takes what the panel asks for: the paper, its orientation, the margins,
// a scale, the pages, and a header and footer of our own (the file's name and its place, not the date and the address of the page that
// the browser's own header and footer would print). css/print.css is what makes the page look like paper.
//
//	PrintPreviewAsync   make the PDF for the panel's settings and keep it for the preview (the panel shows it from /api/print/preview.pdf)
//	PrintPickPdfPath    the Save dialog (the person's own choice of where the PDF goes)
//	PrintSavePdfAsync   make the PDF again and write it to that path
//	PrintPreviewClose   forget the PDF kept for the preview
//
// The three async calls answer through window.__onPrintPdfResult(reqID, result, errMsg) (the shims' __mdmemoSettle).

const (
	printPDFTimeout  = 90 * time.Second
	printMaxPDFBytes = 256 << 20
)

// errPrintUnsupported is what a platform without a way to print the page to PDF answers (a Mac prints through the system's own
// dialog, which the printer button opens, and has no panel).
var errPrintUnsupported = errors.New("saving the preview as PDF is not available on this platform")

// printPdfAvailable tells whether this build makes the PDF itself (the print panel and the JSON-RPC method print.pdf): Windows, through
// WebView2. The tests put their own in its place.
var printPdfAvailable = func() bool { return runtime.GOOS == "windows" }

// printSettings are the panel's choices.
type printSettings struct {
	Paper        string `json:"paper"`        // a4, a3, b5, letter
	Landscape    bool   `json:"landscape"`    // false: portrait
	Margin       string `json:"margin"`       // normal, narrow
	Scale        int    `json:"scale"`        // percent, 25 to 200 (0 = 100)
	Pages        string `json:"pages"`        // "" = all; "1-3, 5"
	HeaderFooter bool   `json:"headerFooter"` // the file's name above, its place and the page number below
	Title        string `json:"title"`        // the file's name (header)
	Location     string `json:"location"`     // where the file is (footer)
}

// paperInches are the paper sizes in inches (width x height, portrait).
var paperInches = map[string][2]float64{
	"a4":     {8.27, 11.69},
	"a3":     {11.69, 16.54},
	"b5":     {7.17, 10.12}, // JIS B5
	"letter": {8.5, 11},
}

var pagesSyntax = regexp.MustCompile(`^[0-9 ,\-]{0,100}$`)

// margins in inches: top, right, bottom, left. Normal is 20 mm all round (14 mm looked as if there were none on a Japanese document),
// narrow 10 mm. A header or footer needs room: at least 11.4 mm above and below.
func (s printSettings) margins() (top, right, bottom, left float64) {
	if s.Margin == "narrow" {
		top, right, bottom, left = 0.39, 0.39, 0.39, 0.39
	} else {
		top, right, bottom, left = 0.79, 0.79, 0.79, 0.79
	}
	if s.HeaderFooter {
		if top < 0.45 {
			top = 0.45
		}
		if bottom < 0.45 {
			bottom = 0.45
		}
	}
	return
}

// cdpParams are the parameters of Page.printToPDF.
func (s printSettings) cdpParams() (map[string]interface{}, error) {
	paper := s.Paper
	if paper == "" {
		paper = "a4"
	}
	size, ok := paperInches[paper]
	if !ok {
		return nil, fmt.Errorf("unknown paper %q", s.Paper)
	}
	if s.Margin != "" && s.Margin != "normal" && s.Margin != "narrow" {
		return nil, fmt.Errorf("unknown margin %q", s.Margin)
	}
	scale := s.Scale
	if scale == 0 {
		scale = 100
	}
	if scale < 25 || scale > 200 {
		return nil, fmt.Errorf("the scale must be between 25 and 200 percent")
	}
	pages := strings.TrimSpace(s.Pages)
	if !pagesSyntax.MatchString(pages) {
		return nil, fmt.Errorf("the pages are written like 1-3, 5")
	}
	top, right, bottom, left := s.margins()
	p := map[string]interface{}{
		"landscape":         s.Landscape,
		"paperWidth":        size[0],
		"paperHeight":       size[1],
		"marginTop":         top,
		"marginRight":       right,
		"marginBottom":      bottom,
		"marginLeft":        left,
		"scale":             float64(scale) / 100,
		"printBackground":   true, // the grey of code and table heads (css/print.css asks for exactly those backgrounds)
		"preferCSSPageSize": false,
		"transferMode":      "ReturnAsBase64",
	}
	if pages != "" {
		p["pageRanges"] = pages
	}
	if s.HeaderFooter {
		p["displayHeaderFooter"] = true
		p["headerTemplate"] = printHeaderTemplate(s.Title, left)
		p["footerTemplate"] = printFooterTemplate(s.Location, left)
	} else {
		p["displayHeaderFooter"] = false
	}
	return p, nil
}

// The header and footer templates are small HTML pages that the engine draws in the margin; "pageNumber" and "totalPages" are
// replaced by it. Text is escaped: a file name is not markup. The font size is written out (the default is 0).
func printHeaderTemplate(title string, leftInch float64) string {
	return `<div style="width:100%;font:8px 'Segoe UI','Yu Gothic UI',sans-serif;color:#555;padding:0 ` + strconv.FormatFloat(leftInch, 'f', 2, 64) + `in;">` +
		`<span style="font-weight:600;">` + html.EscapeString(oneLinePrint(title, 120)) + `</span></div>`
}

func printFooterTemplate(location string, leftInch float64) string {
	pad := strconv.FormatFloat(leftInch, 'f', 2, 64) + "in"
	return `<div style="width:100%;font:8px 'Segoe UI','Yu Gothic UI',sans-serif;color:#555;padding:0 ` + pad + `;box-sizing:border-box;display:flex;justify-content:space-between;">` +
		`<span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:85%;">` + html.EscapeString(oneLinePrint(location, 260)) + `</span>` +
		`<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
}

// oneLinePrint is s on one line, at most n runes.
func oneLinePrint(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

var pagesCountRE = regexp.MustCompile(`/Count\s+(\d+)`)

// pdfPageCount is the number of pages of a PDF made by the engine: the largest /Count of its page tree (0 when it cannot tell).
func pdfPageCount(pdf []byte) int {
	best := 0
	for _, m := range pagesCountRE.FindAllSubmatch(pdf, -1) {
		if n, err := strconv.Atoi(string(m[1])); err == nil && n > best && n < 100000 {
			best = n
		}
	}
	return best
}

// ---- the PDF kept for the panel's preview -----------------------------------------------------------------------------------------

var printKept struct {
	mu    sync.Mutex
	token string
	data  []byte
}

// keepPrintPDF holds the PDF for the preview and returns the address the panel loads it from. One PDF at a time.
func keepPrintPDF(data []byte) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	token := hex.EncodeToString(b)
	printKept.mu.Lock()
	printKept.token, printKept.data = token, data
	printKept.mu.Unlock()
	return "/api/print/preview.pdf?t=" + token
}

func forgetPrintPDF() {
	printKept.mu.Lock()
	printKept.token, printKept.data = "", nil
	printKept.mu.Unlock()
}

// servePrintPreview serves the kept PDF to the page of this app (the same checks as the image endpoint: this server's own host name,
// and the token that only the panel was given).
func servePrintPreview(w http.ResponseWriter, r *http.Request, port int) {
	if !isAllowedImageHost(r.Host, port) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	printKept.mu.Lock()
	token, data := printKept.token, printKept.data
	printKept.mu.Unlock()
	if token == "" || r.URL.Query().Get("t") != token || len(data) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `inline; filename="preview.pdf"`)
	_, _ = w.Write(data)
}

// ---- the calls of the panel -------------------------------------------------------------------------------------------------------

type printPreviewResult struct {
	URL   string `json:"url"`
	Pages int    `json:"pages"`
	Bytes int    `json:"bytes"`
}

type printSaveResult struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	Pages int    `json:"pages"`
}

// printToPDF is how the page is printed (the engine of the platform); the tests put their own in its place.
var printToPDF = func(a *App, params map[string]interface{}) ([]byte, error) { return a.cdpPrintToPDF(params) }

// makePrintPDF prints the page to a PDF with the settings in optsJSON.
func (a *App) makePrintPDF(optsJSON string) ([]byte, error) {
	var s printSettings
	if err := json.Unmarshal([]byte(optsJSON), &s); err != nil {
		return nil, fmt.Errorf("the print settings could not be read: %w", err)
	}
	params, err := s.cdpParams()
	if err != nil {
		return nil, err
	}
	pdf, err := printToPDF(a, params)
	if err != nil {
		return nil, err
	}
	if len(pdf) == 0 || len(pdf) > printMaxPDFBytes {
		return nil, fmt.Errorf("the PDF has an unusable size (%d bytes)", len(pdf))
	}
	return pdf, nil
}

// PrintPreviewAsync makes the PDF for the settings and keeps it for the panel's preview.
func (a *App) PrintPreviewAsync(reqID, optsJSON string) {
	go func() {
		pdf, err := a.makePrintPDF(optsJSON)
		if err != nil {
			a.dispatchPrintResult(reqID, nil, err)
			return
		}
		a.dispatchPrintResult(reqID, printPreviewResult{URL: keepPrintPDF(pdf), Pages: pdfPageCount(pdf), Bytes: len(pdf)}, nil)
	}()
}

// PrintPickPdfPath is the Save dialog of the PDF: the path the person chose ("" when they cancelled). The name offered is the
// note's, with .pdf.
func (a *App) PrintPickPdfPath(defaultName string) (string, error) {
	path, err := dialog.SaveFileDialog("PDF として保存", safePdfName(defaultName)+".pdf")
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	return path, nil
}

// PrintSavePdfAsync makes the PDF with the settings and writes it to path (a path from PrintPickPdfPath).
func (a *App) PrintSavePdfAsync(reqID, optsJSON, path string) {
	go func() {
		path = strings.TrimSpace(path)
		if path == "" {
			a.dispatchPrintResult(reqID, nil, errors.New("no file name"))
			return
		}
		if strings.ToLower(filepath.Ext(path)) != ".pdf" {
			path += ".pdf"
		}
		if st, err := os.Stat(filepath.Dir(path)); err != nil || !st.IsDir() {
			a.dispatchPrintResult(reqID, nil, fmt.Errorf("the folder %q does not exist", filepath.Dir(path)))
			return
		}
		pdf, err := a.makePrintPDF(optsJSON)
		if err != nil {
			a.dispatchPrintResult(reqID, nil, err)
			return
		}
		if err := atomicfile.Write(path, pdf, ".md-memo-pdf-*"); err != nil {
			a.dispatchPrintResult(reqID, nil, fmt.Errorf("the PDF could not be written: %w", err))
			return
		}
		a.dispatchPrintResult(reqID, printSaveResult{Path: path, Bytes: len(pdf), Pages: pdfPageCount(pdf)}, nil)
	}()
}

// PrintPreviewClose forgets the PDF kept for the preview (the panel was closed).
func (a *App) PrintPreviewClose() { forgetPrintPDF() }

// dispatchPrintResult settles the window's promise of reqID.
func (a *App) dispatchPrintResult(reqID string, result interface{}, err error) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	resJSON, _ := json.Marshal(result)
	errJSON, _ := json.Marshal(errMsg)
	a.dispatchEval(fmt.Sprintf("if (window.__onPrintPdfResult) { window.__onPrintPdfResult(%q, %s, %s); }", reqID, resJSON, errJSON))
}

// decodePrintPDF takes the PDF out of the answer of Page.printToPDF ({"data": "<base64>"}).
func decodePrintPDF(resultJSON string) ([]byte, error) {
	var res struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal([]byte(resultJSON), &res); err != nil {
		return nil, fmt.Errorf("the answer of the engine could not be read: %w", err)
	}
	if res.Data == "" {
		return nil, errors.New("the engine made no PDF")
	}
	pdf, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil {
		return nil, fmt.Errorf("the PDF could not be decoded: %w", err)
	}
	return pdf, nil
}

// safePdfName is the name the Save dialog offers: the note's name without its extension, with no character a file name cannot have
// ("note" for an empty one).
func safePdfName(noteName string) string {
	name := strings.TrimSpace(noteName)
	if name == "" {
		return "note"
	}
	name = strings.TrimSuffix(name, filepath.Ext(name))
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 0x20 {
			return '_'
		}
		return r
	}, name)
	if strings.TrimSpace(name) == "" {
		return "note"
	}
	return name
}
