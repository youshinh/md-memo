package cli

import (
	"errors"
	"flag"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/ipc"
)

// pdfRPCTimeout is how long `tab pdf` waits for the app: the app answers within 8 s (print.pdf), the connection's own deadline is 10 s.
const pdfRPCTimeout = 10 * time.Second

// pdfResult is what print.pdf answers.
type pdfResult struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
	Pages int    `json:"pages"`
	TabID string `json:"tab_id"`
}

// runTabPDF is `tab pdf [<file>] [--out <file.pdf>] [--tab <id>] [--paper ..] [--landscape] [--margin ..] [--scale N] [--pages ..]
// [--header-footer] [--overwrite]`: a note as a PDF file, made by the running app from the note's preview (the same page as the print
// panel makes). With a file, that file is opened in a background tab for the print and closed again (a file that was already open is
// left open); with --tab, that tab; with neither, the active tab. --out is required unless a file is given (then the PDF goes next to
// it, with .pdf). A file that is there is not replaced unless --overwrite. Windows only: the app answers an error on a Mac.
func (c *ClientRunner) runTabPDF(fs *flag.FlagSet, args []string, forceJSON, forceText *bool) (int, error) {
	var out string
	fs.StringVar(&out, "out", "", "The PDF file to write")
	fs.StringVar(&out, "o", "", "The PDF file to write")
	tab := fs.String("tab", "", "The tab to print (an id from tab list)")
	paper := fs.String("paper", "", "a4 (default), a3, b5 or letter")
	landscape := fs.Bool("landscape", false, "Landscape instead of portrait")
	margin := fs.String("margin", "", "normal (20 mm, default) or narrow (10 mm)")
	scale := fs.Int("scale", 0, "Scale in percent, 25 to 200 (default 100)")
	pages := fs.String("pages", "", "Only these pages, like 1-3,5")
	headerFooter := fs.Bool("header-footer", false, "The file's name above, its folder and the page number below")
	overwrite := fs.Bool("overwrite", false, "Replace the PDF if it is there")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return c.flagErr("tab", err)
	}
	if len(rest) > 1 {
		return 1, fmt.Errorf("tab pdf takes one file, got %d words", len(rest))
	}
	if len(rest) == 1 && *tab != "" {
		return 1, errors.New("give a file or --tab, not both")
	}

	tabID := *tab
	openedID := ""
	if len(rest) == 1 {
		abs, err := filepath.Abs(rest[0])
		if err != nil {
			return 1, fmt.Errorf("cannot resolve %q: %w", rest[0], err)
		}
		if out == "" {
			out = strings.TrimSuffix(abs, filepath.Ext(abs)) + ".pdf"
		}
		var opened ipc.TabNewResult
		if err := ipc.CallRPC(c.session, "tab.new", ipc.TabNewParams{Path: abs, Background: true}, &opened, 3*time.Second); err != nil {
			return 1, err
		}
		tabID = opened.ID
		if !opened.Existing {
			openedID = opened.ID
		}
	}
	if out == "" {
		return 1, errors.New("--out <file.pdf> is required (or give the note's file: the PDF then goes next to it)")
	}
	absOut, err := filepath.Abs(out)
	if err != nil {
		return 1, fmt.Errorf("cannot resolve --out %q: %w", out, err)
	}

	params := map[string]interface{}{"out": absOut, "overwrite": *overwrite}
	if tabID != "" {
		params["tab_id"] = tabID
	}
	if *paper != "" {
		params["paper"] = *paper
	}
	if *landscape {
		params["landscape"] = true
	}
	if *margin != "" {
		params["margin"] = *margin
	}
	if *scale != 0 {
		params["scale"] = *scale
	}
	if *pages != "" {
		params["pages"] = *pages
	}
	if *headerFooter {
		params["header_footer"] = true
	}

	var res pdfResult
	callErr := ipc.CallRPC(c.session, "print.pdf", params, &res, pdfRPCTimeout)
	if openedID != "" { // the tab this command opened goes away again, whatever happened (a file that was open already is left alone)
		var closed ipc.TabCloseResult
		_ = ipc.CallRPC(c.session, "tab.close", ipc.TabCloseParams{TabID: openedID, IfSaved: true}, &closed, 3*time.Second)
	}
	if callErr != nil {
		var rpcErr *ipc.RPCError
		if errors.As(callErr, &rpcErr) && rpcErr.Code == ipc.ErrCodeConflict { // the flag has its own spelling
			return 1, errors.New(strings.ReplaceAll(rpcErr.Message, "pass overwrite:true", "pass --overwrite"))
		}
		return 1, callErr
	}
	if ResolveFormatCustom(*forceJSON, *forceText, IsStdoutTerminal()) == FormatJSON {
		PrintFormatted(c.stdout, FormatJSON, "", res)
	} else {
		fmt.Fprintf(c.stdout, "Wrote %s (%d page(s), %d bytes)\n", res.Path, res.Pages, res.Bytes)
	}
	return 0, nil
}
