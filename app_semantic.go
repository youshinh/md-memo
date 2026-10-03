package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/cli"
	"md-memo/pkg/llm"
	"md-memo/pkg/semindex"
)

// The Settings screen's "Semantic search" section (docs/design/semantic-search-2026-10.md section 9): the state of the index, and
// updating it by hand. The screen passes the "semantic" section as it holds it while the person is still editing (sectionJSON; "" or
// "null" means the saved one), so the buttons work before Save.
//
//	SemanticStatusAsync    the index and the model: cli.SemanticIndexStatus (no model is called, nothing is sent)
//	SemanticUpdateAsync    update or rebuild the index: cli.SemanticIndexRun; progress goes to window.__semanticProgress(files, filesTotal,
//	                       texts, textsTotal), at most four times a second
//	CancelSemanticUpdate   stop the run in progress (what was done is kept, as with Ctrl+C in `md-memo scrap index`)
//
// The three answer through window.__onDeepSearchResult(reqID, result, errMsg) (the shims' __mdmemoSettle). An error is a sentence, except
// for the codes the screen acts on, each at the start of the message: "cancelled", "not_enabled", "consent_required: <host>",
// "confirm_required: <n> chunk texts to <host>" (a large run to a host that is not this machine: ask, then call again with yes),
// "rebuild_needed", "locked" (another run, here or by the command line, is going).

const semanticProgressEvery = 250 * time.Millisecond

var semanticRun struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

// parseSemanticSection reads the section the screen sends: a JSON object, or nothing (as saved).
func parseSemanticSection(sectionJSON string) (map[string]interface{}, error) {
	s := strings.TrimSpace(sectionJSON)
	if s == "" || s == "null" {
		return nil, nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, fmt.Errorf("the semantic settings could not be read: %w", err)
	}
	return m, nil
}

// semanticErrorText gives an error of the index its message with the code the screen acts on first.
func semanticErrorText(err error) error {
	var confirm *cli.CloudConfirmError
	var consent *semindex.ConsentError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled):
		return errors.New("cancelled")
	case errors.Is(err, semindex.ErrNotEnabled):
		return errors.New("not_enabled")
	case errors.As(err, &confirm):
		return fmt.Errorf("confirm_required: %d chunk texts to %s", confirm.Texts, confirm.Dest)
	case errors.As(err, &consent):
		return fmt.Errorf("consent_required: %s", consent.Host)
	case errors.Is(err, semindex.ErrRebuildNeeded):
		return errors.New("rebuild_needed")
	case errors.Is(err, semindex.ErrLocked):
		return errors.New("locked")
	}
	return err
}

// SemanticStatusAsync answers the status of the index for the section (see above).
func (a *App) SemanticStatusAsync(reqID, sectionJSON string) {
	go func() {
		section, err := parseSemanticSection(sectionJSON)
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		st, err := cli.SemanticIndexStatus(section)
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		a.dispatchDeepSearchResult(reqID, st, nil)
	}()
}

// SemanticUpdateAsync updates (or, with rebuild, makes again) the index. yes confirms a large run to a host that is not this machine.
func (a *App) SemanticUpdateAsync(reqID, sectionJSON string, rebuild, yes bool) {
	go func() {
		section, err := parseSemanticSection(sectionJSON)
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, err)
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		semanticRun.mu.Lock()
		if semanticRun.cancel != nil {
			semanticRun.mu.Unlock()
			a.dispatchDeepSearchResult(reqID, nil, errors.New("locked"))
			return
		}
		semanticRun.cancel = cancel
		semanticRun.mu.Unlock()
		defer func() {
			semanticRun.mu.Lock()
			semanticRun.cancel = nil
			semanticRun.mu.Unlock()
		}()

		// An Ollama on this machine that is not running is started, as for any other request to it (the person pressed the button).
		if sc, _, _ := cli.SemanticConfigWith(section); sc.Enabled && sc.ConsentGiven() && llm.IsOllamaURL(sc.Model.BaseURL) && !llm.CheckOllamaHealth(sc.Model.BaseURL) {
			_ = a.EnsureOllamaRunning(6 * time.Second)
		}

		var last time.Time
		progress := func(p semindex.Progress) {
			now := time.Now()
			if now.Sub(last) < semanticProgressEvery && p.FilesDone < p.FilesTotal {
				return
			}
			last = now
			a.dispatchEval(fmt.Sprintf("if (window.__semanticProgress) { window.__semanticProgress(%d, %d, %d, %d); }", p.FilesDone, p.FilesTotal, p.TextsEmbedded, p.TextsTotal))
		}
		res, err := cli.SemanticIndexRun(ctx, section, cli.IndexRun{Rebuild: rebuild, Yes: yes, Progress: progress})
		if err != nil {
			a.dispatchDeepSearchResult(reqID, nil, semanticErrorText(err))
			return
		}
		a.dispatchDeepSearchResult(reqID, res, nil)
	}()
}

// CancelSemanticUpdate stops the run in progress; it tells whether one was going.
func (a *App) CancelSemanticUpdate() bool {
	semanticRun.mu.Lock()
	cancel := semanticRun.cancel
	semanticRun.mu.Unlock()
	if cancel == nil {
		return false
	}
	cancel()
	return true
}
