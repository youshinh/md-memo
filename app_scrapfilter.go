package main

import (
	"context"
	"errors"
	"time"

	"md-memo/pkg/cli"
)

// What the search panel's filter row offers (docs/design/tag-filter-2026-10.md section 4.6): the tags the notes carry and how many
// notes have no day in their name. The panel asks once, when the person first opens the filter, so the folder is walked then and
// never at start.

// scrapFilterTimeout: the window gives up at 30 s; a folder that takes longer answers with a sentence instead of nothing.
const scrapFilterTimeout = 25 * time.Second

// ScrapFilterOptionsAsync answers cli.ScrapTags on a goroutine through window.__onDeepSearchResult(reqID, result, errMsg) (the
// shim's __mdmemoSettle, as SearchScrapsSemanticAsync does). The result is {"tags": [{"tag", "files", "entries"}], "files": n,
// "undated": n}; the tags are never null.
func (a *App) ScrapFilterOptionsAsync(reqID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), scrapFilterTimeout)
		defer cancel()
		res, err := cli.ScrapTags(ctx)
		if errors.Is(err, context.DeadlineExceeded) {
			err = errors.New("listing the tags took too long; try again")
		}
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		a.dispatchDeepSearchResult(reqID, res, nil)
	}()
}
