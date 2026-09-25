package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
)

// `md-memo scrap path|list|search`: read-only access to the scrap folder without the GUI. Nothing
// here creates, moves or writes a file or folder. The folder comes from config.json through the
// shared Config (scraps.scrapDir, default ~/Documents/md-memo/scraps).

// defaultSearchLimit is the number of matches `scrap search` stops at unless --limit says otherwise.
const defaultSearchLimit = 100

func (r *HeadlessRunner) runScrap(args []string) (int, error) {
	if len(args) == 0 {
		return 1, errors.New("scrap subcommand required: path, list, or search")
	}
	switch args[0] {
	case "path":
		return r.runScrapPath(args[1:])
	case "list":
		return r.runScrapList(args[1:])
	case "search":
		return r.runScrapSearch(args[1:])
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

	day := nowFunc()
	if *date != "" {
		d, err := parseDay("date", *date)
		if err != nil {
			return 1, err
		}
		day, _ = time.Parse(scrap.DateLayout, d)
	}
	path := scrap.DailyPath(LoadConfig().ScrapDir(), day)

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
	days, err := parseDayRange(*from, *to)
	if err != nil {
		return 1, err
	}

	dir := LoadConfig().ScrapDirResolved()
	files := listScrapFiles(dir, days, *withLines)

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
}

type scrapSearchResult struct {
	Query     string     `json:"query"`
	Count     int        `json:"count"`
	Truncated bool       `json:"truncated"`
	Matches   []scrapHit `json:"matches"`
}

func (r *HeadlessRunner) runScrapSearch(args []string) (int, error) {
	fs := newQuietFlagSet("scrap search")
	from := fs.String("from", "", "First day (YYYY-MM-DD)")
	to := fs.String("to", "", "Last day (YYYY-MM-DD)")
	limit := fs.Int("limit", defaultSearchLimit, "Stop after this many matches")
	forceJSON := fs.Bool("json", false, "Force JSON output")
	forceText := fs.Bool("text", false, "Force plain text output")
	words, err := parseInterspersed(fs, args)
	if err != nil {
		return r.flagErr("scrap", err)
	}
	query := strings.TrimSpace(strings.Join(words, " "))
	if query == "" {
		return 1, errors.New("search text required: md-memo scrap search <text>")
	}
	if *limit < 1 {
		return 1, fmt.Errorf("invalid --limit %d (use 1 or more)", *limit)
	}
	days, err := parseDayRange(*from, *to)
	if err != nil {
		return 1, err
	}

	opts := search.Options{Headings: true, Less: scrapFileOrder}
	if days.set() {
		// A range means the daily files: anything not named YYYY-MM-DD.md has no day to compare.
		opts.Keep = func(path string) bool {
			day, ok := scrap.DateOfFile(filepath.Base(path))
			return ok && days.contains(day)
		}
	}

	// One more than asked for, to learn whether the list was cut.
	found, err := search.SearchScrapsOrdered(context.Background(), LoadConfig().ScrapDirResolved(), query, *limit+1, opts)
	if err != nil {
		return 1, err
	}
	res := scrapSearchResult{Query: query, Matches: []scrapHit{}}
	for _, file := range found {
		day, _ := scrap.DateOfFile(file.FileName)
		for _, m := range file.Matches {
			if len(res.Matches) == *limit {
				res.Truncated = true
				break
			}
			res.Matches = append(res.Matches, scrapHit{
				File: file.FilePath, Date: day, Line: m.LineNumber, Text: m.LineText,
				Heading: m.Heading, HeadingLine: m.HeadingLine,
			})
		}
	}
	res.Count = len(res.Matches)

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
	}
	if res.Truncated {
		fmt.Fprintf(r.stdout, "(stopped after %d matches; --limit raises it)\n", res.Count)
	}
	return 0, nil
}
