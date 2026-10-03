package cli

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"

	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
)

// What narrows a search besides its text: tags and days (docs/design/tag-filter-2026-10.md). `md-memo scrap search --tag/--from/--to`
// and the JSON-RPC method scrap.search take them as parameters; the window's search panel sends them as one JSON object. Here are the
// object the window sends, the list of tags with their counts that the panel offers (`md-memo scrap tags`, scrap.tags), and the
// semantic search's tag test.

// ScrapFilter is the filter the window's search panel sends: the tags an entry must all have (a note's tag comments, see
// pkg/search/tags.go) and the first and last day of the note's file name (YYYY-MM-DD, either may be empty).
type ScrapFilter struct {
	Tags []string `json:"tags"`
	From string   `json:"from"`
	To   string   `json:"to"`
}

// ParseScrapFilter reads the filter as the page sends it: JSON, or "" / "null" for none. The values get the command line's checks
// (tags normalized and at most 8, days YYYY-MM-DD and in order); what is wrong is a ParamError whose message is one line.
func ParseScrapFilter(filterJSON string) (ScrapFilter, error) {
	var f ScrapFilter
	s := strings.TrimSpace(filterJSON)
	if s == "" || s == "null" {
		return f, nil
	}
	if err := json.Unmarshal([]byte(s), &f); err != nil {
		return ScrapFilter{}, paramErr("the filter is not valid: %s", oneLine(err))
	}
	tags, err := search.ParseTagFilter(f.Tags)
	if err != nil {
		return ScrapFilter{}, paramErr("invalid tag filter: %v", err)
	}
	days, err := parseDayRange(f.From, f.To)
	if err != nil {
		return ScrapFilter{}, &ParamError{Msg: err.Error()}
	}
	return ScrapFilter{Tags: tags, From: days.from, To: days.to}, nil
}

// Empty reports whether the filter narrows nothing.
func (f ScrapFilter) Empty() bool { return len(f.Tags) == 0 && f.From == "" && f.To == "" }

// SearchOptions is the filter in the form the word searches take: the days as a test of the file's name (the rule of
// scrap.DayOfName, so a note saved as 2026-09-27_title.md is in range), the tags as they are. The filter must come from
// ParseScrapFilter (or be empty).
func (f ScrapFilter) SearchOptions() search.Options {
	opts := search.Options{Tags: f.Tags}
	if days := (dayRange{from: f.From, to: f.To}); days.set() {
		opts.Keep = days.keepFile
	}
	return opts
}

// keepFile is the day test of a file path: its name starts with a day inside the range. A note that has no day in its name is never
// in a range.
func (d dayRange) keepFile(path string) bool {
	day, ok := scrap.DayOfName(filepath.Base(path))
	return ok && d.contains(day)
}

// ---- scrap tags --------------------------------------------------------------------------------

// ScrapTagsResult is the answer of `md-memo scrap tags` and of scrap.tags: the tags in use, most files first, how many .md files
// were looked at, and how many of those have no day in their name (a date range never takes them in).
type ScrapTagsResult struct {
	Tags    []search.TagCount `json:"tags"`
	Files   int               `json:"files"`
	Undated int               `json:"undated"`
}

// ScrapTags walks the scrap folder (the files the search reads) and counts its tags. It reads every note that has a "<!--" in it
// or a front matter: ask for it when it is needed, not at start. It honours ctx.
func ScrapTags(ctx context.Context) (ScrapTagsResult, error) {
	res := ScrapTagsResult{Tags: []search.TagCount{}}
	tags, err := search.CollectTagsVisit(ctx, LoadConfig().ScrapDirResolved(), func(path string) {
		res.Files++
		if _, ok := scrap.DayOfName(filepath.Base(path)); !ok {
			res.Undated++
		}
	})
	if err != nil {
		return ScrapTagsResult{}, err
	}
	if len(tags) > 0 {
		res.Tags = tags
	}
	return res, nil
}

// ---- the semantic search's tag test ------------------------------------------------------------

// semanticTagKeep is search.SearchOptions.Keep for tags: a chunk is kept when the entry that holds its first line has every wanted
// tag. A file is read once however many chunks it has (the index search asks about its chunks one after the other). No tags is nil:
// the index search is not asked anything.
func semanticTagKeep(scrapDir string, want []string) func(rel string, line int) bool {
	if len(want) == 0 {
		return nil
	}
	maps := map[string]*search.TagMap{} // nil for a file that carries no tag or cannot be read
	return func(rel string, line int) bool {
		m, ok := maps[rel]
		if !ok {
			m = search.ScanTagsFile(filepath.Join(scrapDir, filepath.FromSlash(rel)))
			maps[rel] = m
		}
		return m.HasLine(line, want)
	}
}
