package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
)

// JSON-RPC for the print and deep search features (docs/design/rpc-additions-2026-10.md section 7). Like every method added after the
// first three reads, all of them need the session token (pkg/ipc/auth.go).
//
//	print.pdf         a tab's preview as a PDF file, through the same preparation and engine as the print panel (Windows)
//	deepsearch.plan   what a deep search would send, and where: a dry run, nothing is sent to a model and nothing is kept
//
// The deep search itself is not here: it sends excerpts of the notes to a model (a cost, and a send outside this PC unless the model
// is local), which is why the window asks the person first. ui.open_panel {name: "scraps_search", mode: "meaning", query} brings the
// person to the panel where it is run (app_rpc_extra.go).

// printRPCTimeout is how long print.pdf waits for the page: the connection's own deadline is 10 s (pkg/ipc), and an answer must still fit.
const printRPCTimeout = 8 * time.Second

type printPdfParams struct {
	Out          string `json:"out"`           // the file to write: an absolute path ending in .pdf
	TabID        string `json:"tab_id"`        // the note to print (an id from tab.list); the active tab when absent
	Paper        string `json:"paper"`         // a4 (default), a3, b5, letter
	Landscape    bool   `json:"landscape"`     // false: portrait
	Margin       string `json:"margin"`        // normal (default, 20 mm) or narrow (10 mm)
	Scale        int    `json:"scale"`         // percent, 25 to 200 (default 100)
	Pages        string `json:"pages"`         // "" = all; "1-3, 5"
	HeaderFooter bool   `json:"header_footer"` // the file's name above, its folder and the page number below
	Overwrite    bool   `json:"overwrite"`     // replace a file that is there (otherwise -32001)
}

// printPdfResult is the answer of print.pdf.
type printPdfResult struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	Pages int    `json:"pages"`
	TabID string `json:"tab_id"`
}

// rpcPrintPdf saves a tab's preview as a PDF: the page shows the tab's preview (the view is put back afterwards), prepares the pictures
// and the diagrams for paper and has the engine print it to out. Only a Markdown note has a print layout (an HTML page is -32602). The
// file is only ever written at the path given, which must be absolute and end in .pdf, in a folder that exists; one that is already
// there is replaced only with overwrite:true. The call is answered within printRPCTimeout: a note that takes longer is an error
// (the PDF may still appear).
func (a *App) rpcPrintPdf(req *ipc.RPCRequest) *ipc.RPCResponse {
	var params printPdfParams
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if !printPdfAvailable() {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, errPrintUnsupported.Error()+" (on a Mac the printer button of the preview opens the system print dialog, where PDF > Save as PDF is)")
	}
	out := strings.TrimSpace(params.Out)
	switch {
	case out == "":
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "out is required: the .pdf file to write")
	case !filepath.IsAbs(out):
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "out must be an absolute path")
	case strings.ToLower(filepath.Ext(out)) != ".pdf":
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "out must end in .pdf")
	}
	if st, err := os.Stat(filepath.Dir(out)); err != nil || !st.IsDir() {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("the folder %q does not exist", filepath.Dir(out)))
	}
	if st, err := os.Stat(out); err == nil {
		if st.IsDir() {
			return errorResponse(req.ID, ipc.ErrCodeInvalidParams, fmt.Sprintf("%q is a folder, not a file", out))
		}
		if !params.Overwrite {
			return errorResponse(req.ID, ipc.ErrCodeConflict, fmt.Sprintf("%q already exists: pass overwrite:true to replace it", out))
		}
	}
	settings := printSettings{Paper: params.Paper, Landscape: params.Landscape, Margin: params.Margin, Scale: params.Scale, Pages: params.Pages, HeaderFooter: params.HeaderFooter}
	if _, err := settings.cdpParams(); err != nil { // the same checks the engine's parameters go through
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, err.Error())
	}
	spec := map[string]interface{}{
		"paper": defaultString(params.Paper, "a4"), "landscape": params.Landscape, "margin": defaultString(params.Margin, "normal"),
		"scale": defaultInt(params.Scale, 100), "pages": strings.TrimSpace(params.Pages), "headerFooter": params.HeaderFooter,
	}

	ctx, cancel := context.WithTimeout(context.Background(), printRPCTimeout)
	defer cancel()
	resJSON, err := a.callRPCJS(ctx, "printPdf", params.TabID, spec, out)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, "print.pdf timed out (8 s): the note is too large to print in one call (the file may still appear)")
		}
		return jsErrorResponse(req.ID, err, "print.pdf failed")
	}
	var res printPdfResult
	if err := json.Unmarshal([]byte(resJSON), &res); err != nil {
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("invalid print.pdf response: %v", err))
	}
	return successResponse(req.ID, &res)
}

func defaultString(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

func defaultInt(n, def int) int {
	if n == 0 {
		return def
	}
	return n
}

// rpcDeepSearchPlan is the first half of a deep search and nothing else: it searches (by meaning, by words when it cannot), cuts the
// excerpts out of the notes with the secrets taken out, and says which notes, how much, and where it would be sent (this PC, or a host
// and whether the person has allowed it). Nothing goes to a model and no plan is kept (no plan_id: it cannot be run). With no text
// model set up it answers model_configured:false at once.
func (a *App) rpcDeepSearchPlan(ctx context.Context, req *ipc.RPCRequest) *ipc.RPCResponse {
	var params struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if bad := decodeRPCParams(req, &params); bad != nil {
		return bad
	}
	if strings.TrimSpace(params.Query) == "" {
		return errorResponse(req.ID, ipc.ErrCodeInvalidParams, "query is required")
	}
	plan, err := a.planDeepSearch(ctx, params.Query, params.Limit, false, cli.ScrapFilter{}) // the dry run has no filter: it plans the whole folder
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errorResponse(req.ID, ipc.ErrCodeInternalError, "deepsearch.plan timed out (5 s); try a smaller limit")
		}
		return errorResponse(req.ID, ipc.ErrCodeInternalError, fmt.Sprintf("deepsearch.plan failed: %v", err))
	}
	return successResponse(req.ID, &plan)
}
