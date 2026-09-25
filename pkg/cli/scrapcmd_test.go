package cli

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// scrapSandbox gives the test a home, a config.json naming a scrap folder inside it (returned
// unresolved as written and as a path), and a pinned "today" of 2026-09-25.
func scrapSandbox(t *testing.T) (scrapDir string) {
	t.Helper()
	home := withTempHome(t)
	pinNow(t)
	scrapDir = filepath.Join(home, "my scraps")
	cfg, _ := json.Marshal(map[string]interface{}{"scraps": map[string]string{"scrapDir": scrapDir}})
	writeConfigFile(t, string(cfg))
	return scrapDir
}

func mustJSON(t *testing.T, s string, v interface{}) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), v); err != nil {
		t.Fatalf("not JSON (%v): %q", err, s)
	}
}

// ---- scrap path ----------------------------------------------------------------------------

func TestScrapPath(t *testing.T) {
	dir := scrapSandbox(t)

	out, _, code, err := runHeadless(t, "scrap", "path")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	if want := filepath.Join(dir, "2026-09-25.md") + "\n"; out != want {
		t.Errorf("scrap path = %q, want the bare path %q (even though stdout is not a terminal)", out, want)
	}

	out, _, _, _ = runHeadless(t, "scrap", "path", "--date", "2026-01-02")
	if want := filepath.Join(dir, "2026-01-02.md") + "\n"; out != want {
		t.Errorf("--date: %q, want %q", out, want)
	}
	out, _, _, _ = runHeadless(t, "scrap", "path", "--date=2024-02-29")
	if want := filepath.Join(dir, "2024-02-29.md") + "\n"; out != want {
		t.Errorf("--date=: %q, want %q", out, want)
	}

	out, _, _, _ = runHeadless(t, "scrap", "path", "--json", "--date", "2026-01-02")
	var res struct {
		Date, Path string
		Exists     bool
	}
	mustJSON(t, out, &res)
	if res.Date != "2026-01-02" || res.Path != filepath.Join(dir, "2026-01-02.md") || res.Exists {
		t.Errorf("json = %+v", res)
	}
	writeFile(t, filepath.Join(dir, "2026-01-02.md"), "x")
	out, _, _, _ = runHeadless(t, "scrap", "path", "--date", "2026-01-02", "--json")
	mustJSON(t, out, &res)
	if !res.Exists {
		t.Errorf("exists should be true once the file is there: %+v", res)
	}

	// It never creates anything: the folder for a day with no file is still absent.
	other := scrapSandbox(t)
	_, _, _, _ = runHeadless(t, "scrap", "path")
	if exists(other) {
		t.Error("scrap path created the scrap folder")
	}
}

func TestScrapPathDefaultFolderAndTilde(t *testing.T) {
	home := withTempHome(t)
	pinNow(t)
	out, _, _, _ := runHeadless(t, "scrap", "path")
	if want := filepath.Join(home, "Documents", "md-memo", "scraps", "2026-09-25.md") + "\n"; out != want {
		t.Errorf("default = %q, want %q", out, want)
	}
	writeConfigFile(t, `{"scrap_dir": "~/legacy"}`)
	out, _, _, _ = runHeadless(t, "scrap", "path")
	if want := filepath.Join(home, "legacy", "2026-09-25.md") + "\n"; out != want {
		t.Errorf("~ not expanded: %q, want %q", out, want)
	}
}

func TestScrapBadDates(t *testing.T) {
	scrapSandbox(t)
	for _, args := range [][]string{
		{"scrap", "path", "--date", "2026-13-01"},
		{"scrap", "path", "--date", "2026-9-5"},
		{"scrap", "path", "--date", "20260925"},
		{"scrap", "path", "--date", "yesterday"},
		{"scrap", "path", "--date", "2026-02-30"},
		{"scrap", "path", "--date="},
		{"scrap", "list", "--from", "nope"},
		{"scrap", "list", "--to", "2026-00-10"},
		{"scrap", "search", "x", "--from", "2026-1-1"},
		{"scrap", "search", "x", "--to", "2026/01/01"},
	} {
		_, _, code, err := runHeadless(t, args...)
		// --date= is "not given" for the flag package's purposes: an empty value means today.
		if strings.HasSuffix(strings.Join(args, " "), "--date=") {
			if err != nil || code != 0 {
				t.Errorf("%v: an empty --date means today, got code %d err %v", args, code, err)
			}
			continue
		}
		if err == nil || code != 1 || !strings.HasPrefix(err.Error(), "invalid date") {
			t.Errorf("%v: code %d, err %v; want exit 1 with \"invalid date ...\"", args, code, err)
		}
	}
	if _, _, code, err := runHeadless(t, "scrap", "list", "--from", "2026-09-10", "--to", "2026-09-01"); code != 1 || err == nil || !strings.Contains(err.Error(), "after --to") {
		t.Errorf("a reversed range must be an error, got code %d err %v", code, err)
	}
}

// ---- scrap list ----------------------------------------------------------------------------

func TestScrapListEmptyAndMissingFolder(t *testing.T) {
	dir := scrapSandbox(t)

	// Missing folder.
	out, _, code, err := runHeadless(t, "scrap", "list", "--json")
	if err != nil || code != 0 || strings.TrimSpace(out) != "[]" {
		t.Errorf("missing folder: code %d err %v out %q, want []", code, err, out)
	}
	if exists(dir) {
		t.Error("scrap list created the folder")
	}
	out, _, _, _ = runHeadless(t, "scrap", "list", "--text")
	if !strings.HasPrefix(out, "No scrap files in ") {
		t.Errorf("text for an empty list = %q", out)
	}

	// Empty folder.
	writeFile(t, filepath.Join(dir, ".keep"), "")
	out, _, _, _ = runHeadless(t, "scrap", "list", "--json")
	if strings.TrimSpace(out) != "[]" {
		t.Errorf("empty folder: %q", out)
	}
}

func TestScrapListFiltersOrdersAndDescribes(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-25.md"), "one\ntwo\n")
	writeFile(t, filepath.Join(dir, "2026-09-03.md"), "no trailing newline")
	writeFile(t, filepath.Join(dir, "2026-09-20.md"), "")
	writeFile(t, filepath.Join(dir, "2026-09-10.md"), "a\r\nb\r\nc\r\n") // CRLF
	// Everything below is not a daily file and must not be listed.
	writeFile(t, filepath.Join(dir, "notes.md"), "x")
	writeFile(t, filepath.Join(dir, "2026-9-5.md"), "x")
	writeFile(t, filepath.Join(dir, "2026-09-25.txt"), "x")
	writeFile(t, filepath.Join(dir, "2026-02-30.md"), "x")
	writeFile(t, filepath.Join(dir, "sub", "2026-09-19.md"), "x")
	writeFile(t, filepath.Join(dir, "2026-09-11.md", "inside.md"), "x") // a FOLDER with a date name

	type entry struct {
		Date     string `json:"date"`
		Path     string `json:"path"`
		Size     int64  `json:"size"`
		Modified string `json:"modified"`
		Lines    *int   `json:"lines"`
	}
	list := func(args ...string) []entry {
		t.Helper()
		out, _, code, err := runHeadless(t, append([]string{"scrap", "list", "--json"}, args...)...)
		if err != nil || code != 0 {
			t.Fatalf("%v: code %d err %v", args, code, err)
		}
		var es []entry
		mustJSON(t, out, &es)
		return es
	}
	dates := func(es []entry) string {
		var d []string
		for _, e := range es {
			d = append(d, e.Date)
		}
		return strings.Join(d, ",")
	}

	all := list()
	if got, want := dates(all), "2026-09-25,2026-09-20,2026-09-10,2026-09-03"; got != want {
		t.Errorf("dates = %s, want %s", got, want)
	}
	if all[0].Path != filepath.Join(dir, "2026-09-25.md") || all[0].Size != 8 {
		t.Errorf("entry = %+v", all[0])
	}
	if _, err := time.Parse(time.RFC3339, all[0].Modified); err != nil {
		t.Errorf("modified %q is not RFC 3339", all[0].Modified)
	}
	if all[0].Lines != nil {
		t.Error("lines must be absent unless --lines is given")
	}

	if got, want := dates(list("--from", "2026-09-10")), "2026-09-25,2026-09-20,2026-09-10"; got != want {
		t.Errorf("--from: %s, want %s", got, want)
	}
	if got, want := dates(list("--to", "2026-09-10")), "2026-09-10,2026-09-03"; got != want {
		t.Errorf("--to: %s, want %s", got, want)
	}
	if got, want := dates(list("--from", "2026-09-04", "--to", "2026-09-20")), "2026-09-20,2026-09-10"; got != want {
		t.Errorf("--from --to: %s, want %s", got, want)
	}
	if got := dates(list("--from", "2030-01-01")); got != "" {
		t.Errorf("nothing in range should be empty, got %s", got)
	}

	withLines := list("--lines")
	wantLines := map[string]int{"2026-09-25": 2, "2026-09-20": 0, "2026-09-10": 3, "2026-09-03": 1}
	for _, e := range withLines {
		if e.Lines == nil || *e.Lines != wantLines[e.Date] {
			t.Errorf("%s: lines = %v, want %d", e.Date, e.Lines, wantLines[e.Date])
		}
	}

	// Text form: one line per file, newest first, path last.
	out, _, _, _ := runHeadless(t, "scrap", "list", "--text", "--from", "2026-09-20")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "2026-09-25") || !strings.HasSuffix(lines[1], "2026-09-20.md") {
		t.Errorf("text = %q", out)
	}
}

func TestScrapListRejectsStrayArguments(t *testing.T) {
	scrapSandbox(t)
	if _, _, code, err := runHeadless(t, "scrap", "list", "stray"); code != 1 || err == nil {
		t.Errorf("code %d err %v", code, err)
	}
	if _, _, code, err := runHeadless(t, "scrap", "list", "--nope"); code != 1 || err == nil {
		t.Errorf("code %d err %v", code, err)
	}
	if _, _, code, err := runHeadless(t, "scrap"); code != 1 || err == nil {
		t.Errorf("a bare scrap needs an action: code %d err %v", code, err)
	}
	if _, _, code, err := runHeadless(t, "scrap", "delete"); code != 1 || err == nil || !strings.Contains(err.Error(), "unknown scrap action") {
		t.Errorf("code %d err %v", code, err)
	}
}

// ---- scrap search --------------------------------------------------------------------------

type searchOut struct {
	Query     string `json:"query"`
	Count     int    `json:"count"`
	Truncated bool   `json:"truncated"`
	Matches   []struct {
		File        string `json:"file"`
		Date        string `json:"date"`
		Line        int    `json:"line"`
		Text        string `json:"text"`
		Heading     string `json:"heading"`
		HeadingLine int    `json:"heading_line"`
	} `json:"matches"`
}

func searchJSON(t *testing.T, args ...string) searchOut {
	t.Helper()
	out, _, code, err := runHeadless(t, append([]string{"scrap", "search", "--json"}, args...)...)
	if err != nil || code != 0 {
		t.Fatalf("%v: code %d err %v", args, code, err)
	}
	var res searchOut
	mustJSON(t, out, &res)
	return res
}

func TestScrapSearchFindsHitsWithTheirHeadings(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"),
		"---\n## [09:00:00] git log\n```text\n# a comment: deploy\n```\nplain text about Deploy\n")
	writeFile(t, filepath.Join(dir, "2026-09-25.md"),
		"---\n## [10:00:00] 牛乳を買う\r\n- [ ] deploy のあとで牛乳\r\n本文\r\n")
	writeFile(t, filepath.Join(dir, "notes.md"), "# Ideas\ndeploy on friday\n")

	res := searchJSON(t, "deploy")
	if res.Query != "deploy" || res.Truncated || res.Count != 4 || len(res.Matches) != 4 {
		t.Fatalf("result = %+v", res)
	}
	type want struct {
		file, date string
		line       int
		text       string
		hline      int
		heading    string
	}
	wants := []want{
		{"2026-09-25.md", "2026-09-25", 3, "- [ ] deploy のあとで牛乳", 2, "## [10:00:00] 牛乳を買う"},
		{"2026-09-24.md", "2026-09-24", 4, "# a comment: deploy", 2, "## [09:00:00] git log"}, // the fence hides the # line
		{"2026-09-24.md", "2026-09-24", 6, "plain text about Deploy", 2, "## [09:00:00] git log"},
		{"notes.md", "", 2, "deploy on friday", 1, "# Ideas"}, // not a date-named file: no date
	}
	for i, w := range wants {
		m := res.Matches[i]
		if filepath.Base(m.File) != w.file || !filepath.IsAbs(m.File) || m.Date != w.date || m.Line != w.line ||
			m.Text != w.text || m.HeadingLine != w.hline || m.Heading != w.heading {
			t.Errorf("match %d = %+v, want %+v", i, m, w)
		}
	}
	// Order: the daily files, newest first, then the rest.
	if filepath.Base(res.Matches[3].File) != "notes.md" {
		t.Errorf("order: %v", res.Matches)
	}
}

func TestScrapSearchDateRangeOnlyCoversDatedFiles(t *testing.T) {
	dir := scrapSandbox(t)
	for _, d := range []string{"2026-09-01", "2026-09-10", "2026-09-20"} {
		writeFile(t, filepath.Join(dir, d+".md"), "needle "+d+"\n")
	}
	writeFile(t, filepath.Join(dir, "notes.md"), "needle in notes\n")
	writeFile(t, filepath.Join(dir, "sub", "2026-09-15.md"), "needle in a sub folder\n")
	writeFile(t, filepath.Join(dir, ".git", "2026-09-12.md"), "needle in a hidden folder\n")

	files := func(res searchOut) string {
		var f []string
		for _, m := range res.Matches {
			f = append(f, filepath.Base(m.File))
		}
		return strings.Join(f, ",")
	}
	// No range: every .md, dot folders excepted, sub-folders included; the daily files newest
	// first, then the others (notes.md must not push the newest days out of the limit).
	if got, want := files(searchJSON(t, "needle")), "2026-09-20.md,2026-09-15.md,2026-09-10.md,2026-09-01.md,notes.md"; got != want {
		t.Errorf("no range: %s", got)
	}
	// A range: only the date-named files inside it (sub-folders included).
	if got, want := files(searchJSON(t, "needle", "--from", "2026-09-05")), "2026-09-20.md,2026-09-15.md,2026-09-10.md"; got != want {
		t.Errorf("--from: %s, want %s", got, want)
	}
	if got, want := files(searchJSON(t, "--to", "2026-09-10", "needle")), "2026-09-10.md,2026-09-01.md"; got != want {
		t.Errorf("--to (before the query): %s, want %s", got, want)
	}
	if got, want := files(searchJSON(t, "needle", "--from", "2026-09-10", "--to", "2026-09-15")), "2026-09-15.md,2026-09-10.md"; got != want {
		t.Errorf("--from --to: %s, want %s", got, want)
	}
	if res := searchJSON(t, "needle", "--from", "2030-01-01"); res.Count != 0 || res.Matches == nil {
		t.Errorf("an empty range must be an empty list, got %+v", res)
	}
}

func TestScrapSearchLimitAndTruncation(t *testing.T) {
	dir := scrapSandbox(t)
	for day := 10; day <= 14; day++ {
		writeFile(t, filepath.Join(dir, fmt.Sprintf("2026-09-%02d.md", day)), "hit 1\nhit 2\nhit 3\n")
	}
	res := searchJSON(t, "hit", "--limit", "4")
	if res.Count != 4 || !res.Truncated || len(res.Matches) != 4 {
		t.Fatalf("limit 4: %+v", res)
	}
	if filepath.Base(res.Matches[0].File) != "2026-09-14.md" || res.Matches[3].Line != 1 || filepath.Base(res.Matches[3].File) != "2026-09-13.md" {
		t.Errorf("the first 4 hits, newest first, expected: %+v", res.Matches)
	}
	if res := searchJSON(t, "hit", "--limit", "15"); res.Count != 15 || res.Truncated {
		t.Errorf("exactly all: %+v", res)
	}
	if res := searchJSON(t, "hit", "--limit", "14"); res.Count != 14 || !res.Truncated {
		t.Errorf("one short: %+v", res)
	}
	if res := searchJSON(t, "hit"); res.Count != 15 || res.Truncated {
		t.Errorf("the default limit is 100: %+v", res)
	}
	text, _, _, _ := runHeadless(t, "scrap", "search", "--text", "hit", "--limit", "2")
	if !strings.Contains(text, "stopped after 2 matches") {
		t.Errorf("text output should say the list was cut: %q", text)
	}
}

func TestScrapSearchArguments(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-25.md"), "- [ ] -x flag\nfoo bar baz\nother\n")

	// Several words are one query, like the other commands' text.
	if res := searchJSON(t, "foo", "bar"); res.Query != "foo bar" || res.Count != 1 {
		t.Errorf("multi-word: %+v", res)
	}
	// "--" lets a query start with a dash.
	if res := searchJSON(t, "--", "-x"); res.Query != "-x" || res.Count != 1 {
		t.Errorf("dash query: %+v", res)
	}
	// Flags after the query.
	if res := searchJSON(t, "other", "--limit", "1"); res.Count != 1 {
		t.Errorf("flags after: %+v", res)
	}

	for _, args := range [][]string{
		{"scrap", "search"},
		{"scrap", "search", "   "},
		{"scrap", "search", "x", "--limit", "0"},
		{"scrap", "search", "x", "--limit", "-3"},
		{"scrap", "search", "x", "--limit", "many"},
		{"scrap", "search", "x", "--bogus"},
	} {
		if _, _, code, err := runHeadless(t, args...); code != 1 || err == nil {
			t.Errorf("%v: code %d err %v, want exit 1 with an error", args, code, err)
		}
	}
	// -h after the words prints the usage, exit 0.
	out, _, code, err := runHeadless(t, "scrap", "search", "x", "-h")
	if err != nil || code != 0 || out != SubcommandUsage("scrap") {
		t.Errorf("-h: code %d err %v out %q", code, err, firstLine(out))
	}
}

func TestScrapSearchEmptyAndMissingFolder(t *testing.T) {
	dir := scrapSandbox(t)
	res := searchJSON(t, "anything") // the folder does not exist
	if res.Count != 0 || res.Truncated || res.Matches == nil {
		t.Errorf("missing folder: %+v", res)
	}
	if exists(dir) {
		t.Error("scrap search created the folder")
	}
	writeFile(t, filepath.Join(dir, ".keep"), "")
	if res := searchJSON(t, "anything"); res.Count != 0 {
		t.Errorf("empty folder: %+v", res)
	}
	out, _, code, err := runHeadless(t, "scrap", "search", "--text", "anything")
	if err != nil || code != 0 || !strings.HasPrefix(out, "No matches for ") {
		t.Errorf("text: code %d err %v out %q", code, err, out)
	}
}

func TestScrapSearchTextOutput(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-25.md"), "## [10:00:00] title\nthe needle line\n")
	out, _, _, _ := runHeadless(t, "scrap", "search", "--text", "needle")
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 ||
		lines[0] != filepath.Join(dir, "2026-09-25.md")+":2: the needle line" ||
		lines[1] != "    under: ## [10:00:00] title (line 1)" {
		t.Errorf("text output = %q", lines)
	}
}

// None of the three actions may leave anything behind on disk.
func TestScrapCommandsCreateNothing(t *testing.T) {
	dir := scrapSandbox(t)
	for _, args := range [][]string{
		{"scrap", "path"}, {"scrap", "path", "--date", "2026-01-01", "--json"},
		{"scrap", "list"}, {"scrap", "list", "--lines", "--json"},
		{"scrap", "search", "x"}, {"scrap", "search", "x", "--from", "2026-01-01"},
	} {
		if _, _, _, err := runHeadless(t, args...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
	if exists(dir) {
		t.Errorf("a scrap command created %s", dir)
	}
}
