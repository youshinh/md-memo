package cli

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/embed"
	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
	"md-memo/pkg/semindex"
)

// The entry points that both the command line (md-memo info / config get / scrap ...) and the JSON-RPC methods of the running app
// (app.info, config.get, scrap.path, scrap.list, scrap.search) are built on, so the two always answer the same. They read config.json
// from the per-user settings folder like the commands do, print nothing and write nothing.

// ParamError is an argument the caller got wrong (a bad date, an empty search text, an unknown kind). The JSON-RPC server answers it
// with -32602.
type ParamError struct{ Msg string }

func (e *ParamError) Error() string { return e.Msg }

func paramErr(format string, a ...interface{}) error { return &ParamError{Msg: fmt.Sprintf(format, a...)} }

// IsParamError reports whether err is (or wraps) a ParamError.
func IsParamError(err error) bool {
	var pe *ParamError
	return errors.As(err, &pe)
}

// ---- info ------------------------------------------------------------------------------------------------------------------------

// InfoResult is the JSON of `md-memo info` and of the app.info method.
type InfoResult = infoResult

// Info is where things are: the version, the settings and scrap folders, today's scrap file, the hot folder, autosave. guiRunning is
// what the caller knows (the app itself says true; the command asks the session file). No secret is in it.
func Info(version string, guiRunning bool) InfoResult {
	cfg := LoadConfig()
	scrapDir := cfg.ScrapDirResolved()
	today := scrap.DailyPath(scrapDir, nowFunc())
	if version == "" {
		version = "unknown"
	}
	return infoResult{
		Version:          version,
		ConfigDir:        cfg.Dir(),
		ConfigFile:       cfg.Path,
		ScrapDir:         scrapDir,
		TodayScrapPath:   today,
		TodayScrapExists: isRegularFile(today),
		InboxDir:         cfg.InboxDir(),
		InboxEnabled:     cfg.InboxEnabled(),
		Autosave:         cfg.AutoSave(),
		GUIRunning:       guiRunning,
	}
}

// ---- config ----------------------------------------------------------------------------------------------------------------------

// ConfigGet is config.json with every API key, token and password hidden (RedactConfig), or one value of it picked by a dotted path
// ("scraps.scrapDir"; a number picks an array item). An empty path is the whole file. An unreadable file is an error (not "{}": an
// agent would read an empty file as "nothing is configured"); a missing key is a ParamError.
func ConfigGet(keyPath string) (interface{}, error) {
	cfg := LoadConfig()
	if cfg.Err != nil {
		return nil, fmt.Errorf("cannot use %s: %v", cfg.Path, cfg.Err)
	}
	var doc interface{} = RedactConfig(cfg.Values)
	if keyPath != "" {
		var ok bool
		if doc, ok = lookupConfigPath(doc, keyPath); !ok {
			return nil, paramErr("no such key: %s", keyPath)
		}
	}
	return doc, nil
}

// ---- scrap path / list -----------------------------------------------------------------------------------------------------------

// ScrapPathResult is the answer of scrap.path.
type ScrapPathResult struct {
	Date   string `json:"date"`
	Path   string `json:"path"`
	Exists bool   `json:"exists"`
}

// ScrapPathFor is the path of the scrap file of a day (YYYY-MM-DD; "" is today), whether or not it exists.
func ScrapPathFor(date string) (ScrapPathResult, error) {
	day := nowFunc()
	if date != "" {
		d, err := parseDay("date", date)
		if err != nil {
			return ScrapPathResult{}, &ParamError{Msg: err.Error()}
		}
		day, _ = time.Parse(scrap.DateLayout, d)
	}
	path := scrap.DailyPath(LoadConfig().ScrapDir(), day)
	return ScrapPathResult{Date: day.Format(scrap.DateLayout), Path: path, Exists: isRegularFile(path)}, nil
}

// ScrapFileInfo is one daily file of scrap.list.
type ScrapFileInfo = scrapFileInfo

// ScrapList lists the daily files (YYYY-MM-DD.md) of the scrap folder, newest first; from and to (YYYY-MM-DD, either may be empty)
// bound the day, withLines counts the lines of each (it reads every file). A missing folder is an empty list.
func ScrapList(from, to string, withLines bool) ([]ScrapFileInfo, error) {
	days, err := parseDayRange(from, to)
	if err != nil {
		return nil, &ParamError{Msg: err.Error()}
	}
	return listScrapFiles(LoadConfig().ScrapDirResolved(), days, withLines), nil
}

// ---- scrap search ----------------------------------------------------------------------------------------------------------------

// ScrapSearchParams are the arguments of `md-memo scrap search` (and of scrap.search), named like its flags.
type ScrapSearchParams struct {
	Text     string   `json:"text"`
	From     string   `json:"from"`
	To       string   `json:"to"`
	Limit    int      `json:"limit"`    // 0 = the default (100 for the word searches, 10 for the semantic search); at least 1
	Ranked   bool     `json:"ranked"`   // notes that hold the words of the text, best first
	Semantic bool     `json:"semantic"` // notes close in meaning (needs the semantic index)
	Kinds    []string `json:"kind"`     // semantic only: note, log, ai
	Path     string   `json:"path"`     // semantic only: a pattern for the file's path inside the scrap folder, or its name
	Update   bool     `json:"update"`   // semantic only: bring the index up to date first (a few seconds at most)
	// Cutoff (semantic only): a note that scores below this share of the best note's score is left out. nil = 0.85, 0 = leave none
	// out, otherwise 0 to 1. Scores of a model are not comparable between questions or models, so the cut is relative, never a fixed
	// score (docs/design/semantic-search-2026-10.md section 16).
	Cutoff *float64 `json:"cutoff"`
}

const (
	// defaultSemanticLimit is how many notes a semantic search shows unless asked for more: 10 holds a right note for 0.91 of the
	// questions of the mixed Japanese and English test, 30 for 0.98, and every further result is mostly a wrong one.
	defaultSemanticLimit = 10
	// defaultSemanticCutoff keeps the notes that score at least this share of the best one; it takes 1 to 3 of 10 results away and
	// loses no question's right note (a fixed score threshold does: see the design note).
	defaultSemanticCutoff = 0.85
)

// ScrapSearchResult is the JSON of `scrap search` and of scrap.search.
type ScrapSearchResult = scrapSearchResult

// ScrapSearch searches the scrap folder: the plain search (one line that holds the text), the ranked word search (notes that hold its
// words) or the semantic search (notes close in meaning). Bad arguments are ParamErrors. A semantic search that cannot be done because
// the feature is off, a cloud host has not been allowed or the model is not set up is a ParamError too (the person has to act); one
// that cannot be answered now (empty or damaged index, the model cannot be reached) falls back to the ranked word search and says why
// in the result's Notes.
func ScrapSearch(ctx context.Context, p ScrapSearchParams) (ScrapSearchResult, error) {
	res, err := scrapSearch(ctx, p)
	if err == nil {
		decorateHits(res.Matches, LoadConfig().ScrapDirResolved()) // rel, url, label, link: how to cite each hit (links.go)
	}
	return res, err
}

func scrapSearch(ctx context.Context, p ScrapSearchParams) (ScrapSearchResult, error) {
	var zero ScrapSearchResult
	query := strings.TrimSpace(p.Text)
	if query == "" {
		return zero, paramErr("search text required: md-memo scrap search <text>")
	}
	limit := p.Limit
	if limit == 0 {
		limit = defaultSearchLimit
		if p.Semantic {
			limit = defaultSemanticLimit
		}
	}
	if limit < 1 {
		return zero, paramErr("invalid --limit %d (use 1 or more)", p.Limit)
	}
	cutoff := defaultSemanticCutoff
	if p.Cutoff != nil {
		if *p.Cutoff < 0 || *p.Cutoff > 1 {
			return zero, paramErr("invalid --cutoff %v (use 0 to 1; 0 leaves none out)", *p.Cutoff)
		}
		cutoff = *p.Cutoff
	}
	days, err := parseDayRange(p.From, p.To)
	if err != nil {
		return zero, &ParamError{Msg: err.Error()}
	}
	if !p.Semantic {
		for flagName, set := range map[string]bool{"kind": len(p.Kinds) > 0, "path": p.Path != "", "update": p.Update, "cutoff": p.Cutoff != nil} {
			if set {
				return zero, paramErr("--%s needs --semantic", flagName)
			}
		}
		return scrapSearchWords(ctx, query, limit, p.Ranked, days)
	}
	if p.Ranked {
		return zero, paramErr("--semantic and --ranked cannot be combined (a semantic search falls back to the ranked word search by itself)")
	}
	kinds, err := validateKinds(p.Kinds)
	if err != nil {
		return zero, &ParamError{Msg: err.Error()}
	}
	res, err := scrapSearchSemantic(ctx, semanticQuery{query: query, limit: limit, days: days, kinds: kinds, pathGlob: p.Path, update: p.Update, cutoff: cutoff})
	if err != nil && (errors.Is(err, semindex.ErrNotEnabled) || errors.Is(err, semindex.ErrNeedsConsent) || errors.Is(err, embed.ErrNotConfigured)) {
		return zero, &ParamError{Msg: err.Error()}
	}
	return res, err
}

// scrapSearchWords is the plain search and the ranked word search.
func scrapSearchWords(ctx context.Context, query string, limit int, ranked bool, days dayRange) (ScrapSearchResult, error) {
	opts := search.Options{Headings: true, Less: scrapFileOrder}
	if days.set() {
		// A range means the daily files: anything not named YYYY-MM-DD.md has no day to compare.
		opts.Keep = func(path string) bool {
			day, ok := scrap.DateOfFile(filepath.Base(path))
			return ok && days.contains(day)
		}
	}
	// One more than asked for, to learn whether the list was cut.
	var found []search.SearchResult
	var err error
	if ranked {
		// Words instead of one line, entry by entry, best first (search/ranked.go); the limit counts hits, one per note.
		found, err = search.SearchScrapsRanked(ctx, LoadConfig().ScrapDirResolved(), query, limit+1, opts)
	} else {
		found, err = search.SearchScrapsOrdered(ctx, LoadConfig().ScrapDirResolved(), query, limit+1, opts)
	}
	if err != nil {
		return ScrapSearchResult{}, err
	}
	res := scrapSearchResult{Query: query, Ranked: ranked, Matches: []scrapHit{}}
	res.Matches, res.Truncated = hitsFromResults(found, limit)
	if res.Matches == nil {
		res.Matches = []scrapHit{}
	}
	res.Count = len(res.Matches)
	return res, nil
}
