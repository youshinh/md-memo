package cli

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"md-memo/pkg/scrap"
)

// `md-memo scrap path|list|search|index`: access to the scrap folder without the GUI. path, list and
// search are read-only: nothing here creates, moves or writes a file or folder. `index` (semanticcmd.go)
// writes only the semantic index, which lives outside the scrap folder. The folder comes from
// config.json through the shared Config (scraps.scrapDir, default ~/Documents/md-memo/scraps).

// defaultSearchLimit is the number of matches `scrap search` stops at unless --limit says otherwise.
const defaultSearchLimit = 100

func (r *HeadlessRunner) runScrap(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("scrap subcommand required: path, list, search, or index")
	}
	switch args[0] {
	case "path":
		return r.runScrapPath(args[1:])
	case "list":
		return r.runScrapList(args[1:])
	case "search":
		return r.runScrapSearch(args[1:])
	case "index":
		return r.runScrapIndex(args[1:])
	}
	return 1, fmt.Errorf("unknown scrap action: %s", args[0])
}

// parseDay checks a --date/--from/--to value: exactly YYYY-MM-DD and a real calendar day.
func parseDay(flagName, value string) (string, error) {
	if len(value) == len(scrap.DateLayout) {
		if _, err := time.Parse(scrap.DateLayout, value); err == nil {
			return value, nil
		}
	}
	return "", fmt.Errorf("invalid date %q for --%s (use YYYY-MM-DD)", value, flagName)
}

// dayRange is the optional --from / --to filter. Days are compared as YYYY-MM-DD strings, which
// order like the dates themselves and involve no time zone.
type dayRange struct{ from, to string }

func parseDayRange(from, to string) (dayRange, error) {
	var d dayRange
	var err error
	if from != "" {
		if d.from, err = parseDay("from", from); err != nil {
			return d, err
		}
	}
	if to != "" {
		if d.to, err = parseDay("to", to); err != nil {
			return d, err
		}
	}
	if d.from != "" && d.to != "" && d.from > d.to {
		return d, fmt.Errorf("--from %s is after --to %s", d.from, d.to)
	}
	return d, nil
}

func (d dayRange) set() bool { return d.from != "" || d.to != "" }

func (d dayRange) contains(day string) bool {
	return (d.from == "" || day >= d.from) && (d.to == "" || day <= d.to)
}

// ---- scrap path ----------------------------------------------------------------------------

func (r *HeadlessRunner) runScrapPath(args []string) (int, error) {
	fs := newQuietFlagSet("scrap path")
	date := fs.String("date", "", "Day to give the path of (YYYY-MM-DD, default today)")
	forceJSON := fs.Bool("json", false, "Print {date, path, exists} as JSON")
	_ = fs.Bool("text", false, "Print the bare path (this is the default)")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	if len(rest) > 0 {
		return 1, fmt.Errorf("scrap path takes no arguments, got %q", rest[0])
	}

	pr, err := ScrapPathFor(*date) // the same answer as the JSON-RPC method scrap.path (shared.go)
	if err != nil {
		return 1, err
	}
	day, _ := time.Parse(scrap.DateLayout, pr.Date)
	path := pr.Path

	// The bare path even when piped: the point of this command is $(md-memo scrap path).
	if *forceJSON {
		PrintFormatted(r.stdout, FormatJSON, "", map[string]interface{}{
			"date":   day.Format(scrap.DateLayout),
			"path":   path,
			"exists": isRegularFile(path),
		})
		return 0, nil
	}
	fmt.Fprintln(r.stdout, path)
	return 0, nil
}

// ---- scrap list ----------------------------------------------------------------------------

type scrapFileInfo struct {
	Date     string `json:"date"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
	Lines    *int   `json:"lines,omitempty"`
}

func (r *HeadlessRunner) runScrapList(args []string) (int, error) {
	fs := newQuietFlagSet("scrap list")
	from := fs.String("from", "", "First day (YYYY-MM-DD)")
	to := fs.String("to", "", "Last day (YYYY-MM-DD)")
	withLines := fs.Bool("lines", false, "Also count the lines of every file")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	rest, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	if len(rest) > 0 {
		return 1, fmt.Errorf("scrap list takes no arguments, got %q", rest[0])
	}
	files, err := ScrapList(*from, *to, *withLines) // the same answer as the JSON-RPC method scrap.list (shared.go)
	if err != nil {
		return 1, err
	}
	dir := LoadConfig().ScrapDirResolved()

	if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", files)
		return 0, nil
	}
	if len(files) == 0 {
		fmt.Fprintf(r.stdout, "No scrap files in %s\n", dir)
		return 0, nil
	}
	for _, f := range files {
		if f.Lines != nil {
			fmt.Fprintf(r.stdout, "%s  %9d bytes  %6d lines  %s\n", f.Date, f.Size, *f.Lines, f.Path)
		} else {
			fmt.Fprintf(r.stdout, "%s  %9d bytes  %s\n", f.Date, f.Size, f.Path)
		}
	}
	return 0, nil
}

// listScrapFiles returns the daily files (YYYY-MM-DD.md) directly inside dir that fall in days,
// newest first. A missing or unreadable folder is an empty list, never nil.
func listScrapFiles(dir string, days dayRange, withLines bool) []scrapFileInfo {
	files := []scrapFileInfo{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return files
	}
	for _, e := range entries {
		day, ok := scrap.DateOfFile(e.Name())
		if !ok || e.IsDir() || !days.contains(day) {
			continue
		}
		path := filepath.Join(dir, e.Name())
		var info iofs.FileInfo
		if e.Type()&iofs.ModeSymlink != 0 {
			info, err = os.Stat(path) // a link to a note: describe the note
		} else {
			info, err = e.Info()
		}
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		f := scrapFileInfo{
			Date:     day,
			Path:     path,
			Size:     info.Size(),
			Modified: info.ModTime().Format(time.RFC3339),
		}
		if withLines {
			if n, err := countLines(path); err == nil {
				f.Lines = &n
			}
		}
		files = append(files, f)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Date > files[j].Date })
	return files
}

// countLines counts the lines of a file: its line feeds, plus one for a last line without one.
// An empty file has none.
func countLines(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n := 0
	var last byte = '\n'
	for {
		k, err := f.Read(buf)
		if k > 0 {
			n += bytes.Count(buf[:k], []byte{'\n'})
			last = buf[k-1]
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, err
		}
	}
	if last != '\n' {
		n++
	}
	return n, nil
}

// ---- scrap search --------------------------------------------------------------------------

// scrapFileOrder says which file is searched first: the daily files, newest day first, and after
// them any other .md file in the folder (a README, notes) by path. Plain name order would put a
// notes.md before every 2026-... file, and its hits would use up the limit before the newest day.
func scrapFileOrder(a, b string) bool {
	da, aDated := scrap.DateOfFile(filepath.Base(a))
	db, bDated := scrap.DateOfFile(filepath.Base(b))
	switch {
	case aDated && bDated:
		if da != db {
			return da > db
		}
		return a > b // the same day in two folders
	case aDated != bDated:
		return aDated
	}
	return a < b
}

type scrapHit struct {
	File        string `json:"file"`
	Date        string `json:"date,omitempty"`
	Line        int    `json:"line"`
	Text        string `json:"text"`
	Heading     string `json:"heading,omitempty"`
	HeadingLine int    `json:"heading_line,omitempty"`
	// Score and Partial are only there for --ranked: the entry's score (higher is better) and whether some of the words are missing
	// from the entry.
	Score   float64 `json:"score,omitempty"`
	Partial bool    `json:"partial,omitempty"`
	// The rest is only there for --semantic (see semanticcmd.go): the last line of the matching chunk, its kind (note or log), its
	// cosine similarity, the whole note around it, and whether the hit came from the index ("semantic") or from the word search of
	// files the index does not hold yet ("words").
	EndLine int     `json:"end_line,omitempty"`
	Kind    string  `json:"kind,omitempty"`
	Cosine  float64 `json:"cosine,omitempty"`
	Context string  `json:"context,omitempty"`
	Source  string  `json:"source,omitempty"`
	// How to cite the hit as a link (links.go): the file's path inside the scrap folder, its file:// URL, a short label, and
	// [label](url) ready to paste. Every hit has them, whatever the kind of search.
	Rel   string `json:"rel,omitempty"`
	URL   string `json:"url,omitempty"`
	Label string `json:"label,omitempty"`
	Link  string `json:"link,omitempty"`
}

type scrapSearchResult struct {
	Query  string `json:"query"`
	Ranked bool   `json:"ranked,omitempty"`
	// Semantic: the hits come from the semantic index (--semantic). When the index or the model could not answer, it is false, Ranked
	// is true and a note says why.
	Semantic  bool       `json:"semantic,omitempty"`
	Count     int        `json:"count"`
	Truncated bool       `json:"truncated"`
	Pending   int        `json:"pending,omitempty"` // files the index does not hold yet
	Notes     []string   `json:"notes,omitempty"`
	Matches   []scrapHit `json:"matches"`
}

func (r *HeadlessRunner) runScrapSearch(args []string) (int, error) {
	fs := newQuietFlagSet("scrap search")
	from := fs.String("from", "", "First day (YYYY-MM-DD)")
	to := fs.String("to", "", "Last day (YYYY-MM-DD)")
	limit := fs.Int("limit", 0, "Stop after this many matches (default 100; 10 with --semantic)")
	cutoff := fs.Float64("cutoff", defaultSemanticCutoff, "With --semantic: leave out notes that score below this share of the best one (0 = leave none out)")
	ranked := fs.Bool("ranked", false, "Find notes that hold the words of the text (on any lines), best first, instead of one line that holds all of it")
	semantic := fs.Bool("semantic", false, "Find notes close in meaning to the text (needs the semantic index: md-memo scrap index)")
	kind := fs.String("kind", "", "With --semantic: only these kinds of notes: note, log (comma separated)")
	pathGlob := fs.String("path", "", "With --semantic: only files whose path (inside the scrap folder) or name matches this pattern")
	update := fs.Bool("update", false, "With --semantic: bring the index up to date first (at most a few seconds)")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	words, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	query := strings.TrimSpace(strings.Join(words, " "))
	given := map[string]bool{} // which flags were really typed: an absent --limit is the default of the kind of search
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	if query != "" && given["limit"] && *limit < 1 { // an explicit 0 is a mistake (in ScrapSearch an absent limit is 0)
		return 1, fmt.Errorf("invalid --limit %d (use 1 or more)", *limit)
	}
	var cutoffGiven *float64
	if given["cutoff"] {
		cutoffGiven = cutoff
	}
	var kinds []string
	if strings.TrimSpace(*kind) != "" {
		kinds = strings.Split(*kind, ",")
	}
	// The same function answers the JSON-RPC method scrap.search (shared.go).
	res, err := ScrapSearch(context.Background(), ScrapSearchParams{
		Text: query, From: *from, To: *to, Limit: *limit, Ranked: *ranked, Semantic: *semantic, Kinds: kinds, Path: *pathGlob, Update: *update, Cutoff: cutoffGiven,
	})
	if err != nil {
		return 1, err
	}
	if *semantic {
		return r.printSemanticResult(res, ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON)
	}

	if ResolveFormatCustom(*forceJSON, *forceText, IsTerminal(os.Stdout)) == FormatJSON {
		PrintFormatted(r.stdout, FormatJSON, "", res)
		return 0, nil
	}
	if res.Count == 0 {
		fmt.Fprintf(r.stdout, "No matches for %q\n", query)
		return 0, nil
	}
	for _, m := range res.Matches {
		fmt.Fprintf(r.stdout, "%s:%d: %s\n", m.File, m.Line, m.Text)
		if m.Heading != "" {
			fmt.Fprintf(r.stdout, "    under: %s (line %d)\n", m.Heading, m.HeadingLine)
		}
		if res.Ranked {
			note := fmt.Sprintf("    score: %.2f", m.Score)
			if m.Partial {
				note += " (not every word of the text is in this note)"
			}
			fmt.Fprintln(r.stdout, note)
		}
	}
	if res.Truncated {
		fmt.Fprintf(r.stdout, "(stopped after %d matches; --limit raises it)\n", res.Count)
	}
	return 0, nil
}
