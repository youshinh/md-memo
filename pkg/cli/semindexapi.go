package cli

import (
	"context"

	"md-memo/pkg/semindex"
)

// The semantic index for the Settings screen (docs/design/semantic-search-2026-10.md section 9): the same status and the same update as
// `md-memo scrap index`, as values. The screen holds the "semantic" section while the person is still editing it, so the section can be
// passed in; it is laid over the saved config.json (the other sections stay: the key of a text model on the same host counts).

// SemanticConfigWith is the semantic configuration, the scrap folder and the index folder, with section (the "semantic" object as the
// Settings screen holds it) in place of the saved one. nil: as saved.
func SemanticConfigWith(section map[string]interface{}) (sc semindex.Config, scrapDir, idxDir string) {
	cfg := LoadConfig()
	values := cfg.Values
	if section != nil {
		merged := make(map[string]interface{}, len(values)+1)
		for k, v := range values {
			merged[k] = v
		}
		merged["semantic"] = section
		values = merged
	}
	scrapDir = cfg.ScrapDirResolved()
	return semindex.ParseConfig(values), scrapDir, semindex.IndexDir(scrapDir)
}

// SemanticIndexStatus is `md-memo scrap index --status` for section (nil: as saved). It calls no model. ConsentGiven says whether notes
// may be sent to the model's host (always for a model on this machine).
func SemanticIndexStatus(section map[string]interface{}) (IndexStatus, error) {
	sc, scrapDir, idxDir := SemanticConfigWith(section)
	st, err := buildIndexStatus(sc, scrapDir, idxDir)
	st.ConsentGiven = sc.ConsentGiven()
	return st, err
}

// SemanticIndexRun updates or rebuilds the index (or counts, with DryRun) for section (nil: as saved). A host that is not this machine
// and has not been allowed is refused before anything is sent (*semindex.ConsentError), and a large run that would send many texts to
// such a host needs Yes (*CloudConfirmError).
func SemanticIndexRun(ctx context.Context, section map[string]interface{}, o IndexRun) (IndexResult, error) {
	sc, scrapDir, idxDir := SemanticConfigWith(section)
	return runIndex(ctx, sc, scrapDir, idxDir, o)
}
