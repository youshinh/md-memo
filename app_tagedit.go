package main

import (
	"encoding/json"
	"errors"
	"strings"

	"md-memo/pkg/cli"
	"md-memo/pkg/search"
)

// The window's tag commands (docs/design/tag-filter-2026-10.md section 10.6) ask Go how the tags of the open tab's text change; the
// rule for where a tag goes is search.EditTags, the same one `md-memo scrap tag` and the JSON-RPC method scrap.tag_edit use. This
// computes only: it reads no file, touches no tab, and runs nothing until the page asks.

// TagEditAsync answers cli.ScrapTagEdit through window.__onDeepSearchResult(reqID, result, errMsg) (the shim's __mdmemoSettle, as
// ScrapFilterOptionsAsync does). reqJSON is the params of scrap.tag_edit: {"text", "op": "add"|"remove"|"show", "scope": "note"|"entry",
// "line", "tags": ["a"] or "a, b", "return_text"}. The result is the edit: {"changed", "scope", "start_line", "end_line", "new_lines",
// "eol", "line", "added", "removed", "unchanged", "note_tags", "entry_tags", "message_code"} (and "text" with return_text); the lists are
// never null. A request that is over 16 MB or not valid is an error message of one line.
func (a *App) TagEditAsync(reqID, reqJSON string) {
	go func() {
		res, err := tagEdit(reqJSON)
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		a.dispatchDeepSearchResult(reqID, res, nil)
	}()
}

// tagEdit reads the page's request and works the edit out.
func tagEdit(reqJSON string) (cli.ScrapTagEditResult, error) {
	var req cli.ScrapTagEditRequest
	switch {
	case len(reqJSON) > search.MaxTagEditBytes:
		return cli.ScrapTagEditResult{}, errors.New("the request is over 16 MB")
	case strings.TrimSpace(reqJSON) == "":
		return cli.ScrapTagEditResult{}, errors.New("the tag request is empty")
	}
	if err := json.Unmarshal([]byte(reqJSON), &req); err != nil {
		return cli.ScrapTagEditResult{}, errors.New("the tag request is not valid: " + strings.Join(strings.Fields(err.Error()), " "))
	}
	return cli.ScrapTagEdit(req)
}
