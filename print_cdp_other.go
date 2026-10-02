//go:build !windows

package main

// cdpPrintToPDF: only Windows can print the page to a PDF for now (WebView2). A Mac needs WKWebView's own call, which is not written
// yet; the print panel is not shown there.
func (a *App) cdpPrintToPDF(params map[string]interface{}) ([]byte, error) {
	return nil, errPrintUnsupported
}
