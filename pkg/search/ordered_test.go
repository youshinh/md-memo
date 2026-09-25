package search

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func writeMD(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func lineNumbers(rs []SearchResult) []string {
	var out []string
	for _, r := range rs {
		for _, m := range r.Matches {
			out = append(out, r.FileName+":"+strconv.Itoa(m.LineNumber))
		}
	}
	return out
}

func TestSearchScrapsOrderedIsNewestFirstAndExact(t *testing.T) {
	dir := t.TempDir()
	// Many files, each with several hits, so the parallel engine's early stop would be visible.
	for day := 1; day <= 20; day++ {
		name := "2026-09-" + pad2(day) + ".md"
		writeMD(t, dir, name, "needle a\nfiller\nneedle b\nneedle c\n")
	}
	got, err := SearchScrapsOrdered(context.Background(), dir, "needle", 7, Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := "2026-09-20.md:1,2026-09-20.md:3,2026-09-20.md:4,2026-09-19.md:1,2026-09-19.md:3,2026-09-19.md:4,2026-09-18.md:1"
	if s := strings.Join(lineNumbers(got), ","); s != want {
		t.Errorf("hits = %s\nwant   %s", s, want)
	}
	// The same call, again and again, gives the same answer.
	for i := 0; i < 30; i++ {
		again, _ := SearchScrapsOrdered(context.Background(), dir, "needle", 7, Options{})
		if s := strings.Join(lineNumbers(again), ","); s != want {
			t.Fatalf("run %d differs: %s", i, s)
		}
	}
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

func TestSearchScrapsOrderedCustomOrder(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "a.md", "needle\n")
	writeMD(t, dir, "b.md", "needle\n")
	writeMD(t, dir, "c.md", "needle\n")
	// Oldest name first instead of the default newest first.
	got, _ := SearchScrapsOrdered(context.Background(), dir, "needle", 2, Options{Less: func(a, b string) bool { return a < b }})
	if s := strings.Join(lineNumbers(got), ","); s != "a.md:1,b.md:1" {
		t.Errorf("custom order: %s", s)
	}
	def, _ := SearchScrapsOrdered(context.Background(), dir, "needle", 2, Options{})
	if s := strings.Join(lineNumbers(def), ","); s != "c.md:1,b.md:1" {
		t.Errorf("default order: %s", s)
	}
}

func TestSearchScrapsOrderedDefaultsAndEdges(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "2026-09-01.md", "Alpha\n")
	writeMD(t, dir, "2026-09-02.txt", "alpha in a text file\n")
	writeMD(t, dir, ".git/2026-09-03.md", "alpha in a hidden folder\n")

	if got, _ := SearchScrapsOrdered(context.Background(), dir, "  ", 10, Options{}); len(got) != 0 {
		t.Errorf("a blank query finds nothing, got %v", got)
	}
	if got, err := SearchScrapsOrdered(context.Background(), filepath.Join(dir, "missing"), "alpha", 10, Options{}); err != nil || len(got) != 0 {
		t.Errorf("a missing folder is an empty result, got %v, %v", got, err)
	}
	got, err := SearchScrapsOrdered(context.Background(), dir, "ALPHA", 0, Options{}) // 0 = default limit; case-insensitive
	if err != nil || len(got) != 1 || got[0].FileName != "2026-09-01.md" {
		t.Errorf("got %v, %v; want only the .md file outside the dot folder", got, err)
	}
	// The result is never nil: it marshals as [] not null.
	empty, _ := SearchScrapsOrdered(context.Background(), dir, "nomatch", 5, Options{})
	if b, _ := json.Marshal(empty); string(b) != "[]" {
		t.Errorf("empty result marshals as %s", b)
	}
}

func TestSearchScrapsOrderedKeepFilterDoesNotUseUpTheLimit(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "notes.md", strings.Repeat("needle\n", 10))
	writeMD(t, dir, "zzz-not-a-date.md", strings.Repeat("needle\n", 10))
	writeMD(t, dir, "2026-09-01.md", "needle one\n")
	writeMD(t, dir, "2026-09-02.md", "needle two\n")

	onlyDated := func(path string) bool {
		base := filepath.Base(path)
		return len(base) == len("2026-09-01.md") && base[0] == '2'
	}
	got, _ := SearchScrapsOrdered(context.Background(), dir, "needle", 2, Options{Keep: onlyDated})
	if s := strings.Join(lineNumbers(got), ","); s != "2026-09-02.md:1,2026-09-01.md:1" {
		t.Errorf("hits = %s", s)
	}
}

func TestSearchScrapsOrderedHeadings(t *testing.T) {
	dir := t.TempDir()
	note := strings.Join([]string{
		"needle before any heading",     // 1
		"# Title",                       // 2
		"intro needle",                  // 3
		"---",                           // 4
		"## [10:00:00] first entry",     // 5
		"```text",                       // 6
		"# a shell comment, needle",     // 7  inside a fence: not a heading
		"```",                           // 8
		"after the fence needle",        // 9
		"~~~",                           // 10
		"## also inside a fence needle", // 11
		"~~~",                           // 12
		"### Sub section",               // 13
		"    # indented code needle",    // 14 four spaces: not a heading
		"#hashtag needle",               // 15 no space: not a heading
		"####### seven hashes needle",   // 16 too many: not a heading
		"## needle in a heading itself", // 17 the match line is the heading
		"last line needle",              // 18
	}, "\n") + "\n"
	writeMD(t, dir, "2026-09-25.md", note)

	got, err := SearchScrapsOrdered(context.Background(), dir, "needle", 100, Options{Headings: true})
	if err != nil || len(got) != 1 {
		t.Fatalf("got %v, %v", got, err)
	}
	type hit struct {
		line, hline int
		heading     string
	}
	want := []hit{
		{1, 0, ""},
		{3, 2, "# Title"},
		{7, 5, "## [10:00:00] first entry"},
		{9, 5, "## [10:00:00] first entry"},
		{11, 5, "## [10:00:00] first entry"},
		{14, 13, "### Sub section"},
		{15, 13, "### Sub section"},
		{16, 13, "### Sub section"},
		{17, 17, "## needle in a heading itself"},
		{18, 17, "## needle in a heading itself"},
	}
	if len(got[0].Matches) != len(want) {
		t.Fatalf("matches = %d, want %d: %+v", len(got[0].Matches), len(want), got[0].Matches)
	}
	for i, m := range got[0].Matches {
		if m.LineNumber != want[i].line || m.HeadingLine != want[i].hline || m.Heading != want[i].heading {
			t.Errorf("match %d: line %d heading %q@%d; want line %d heading %q@%d",
				i, m.LineNumber, m.Heading, m.HeadingLine, want[i].line, want[i].heading, want[i].hline)
		}
	}
}

func TestSearchScrapsOrderedCRLFAndJapanese(t *testing.T) {
	dir := t.TempDir()
	note := "# 買い物メモ\r\n## [09:00:00] 牛乳を買う\r\n- [ ] 牛乳 2本\r\n本文の続き\r\n"
	writeMD(t, dir, "2026-09-25.md", note)

	got, _ := SearchScrapsOrdered(context.Background(), dir, "牛乳", 10, Options{Headings: true})
	if len(got) != 1 || len(got[0].Matches) != 2 {
		t.Fatalf("got %+v", got)
	}
	m := got[0].Matches[1]
	if m.LineNumber != 3 || m.LineText != "- [ ] 牛乳 2本" {
		t.Errorf("line %d %q: the carriage return must not be part of the text", m.LineNumber, m.LineText)
	}
	if m.Heading != "## [09:00:00] 牛乳を買う" || m.HeadingLine != 2 {
		t.Errorf("heading %q@%d", m.Heading, m.HeadingLine)
	}
	for _, mm := range got[0].Matches {
		if strings.Contains(mm.LineText, "\r") || strings.Contains(mm.Heading, "\r") {
			t.Errorf("CR left in %+v", mm)
		}
	}
}

func TestSearchScrapsOrderedStopsWhenCancelled(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "2026-09-01.md", strings.Repeat("needle\n", 5))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := SearchScrapsOrdered(ctx, dir, "needle", 100, Options{})
	if err != nil || len(got) != 0 {
		t.Errorf("a cancelled search must return at once with nothing more, got %v, %v", got, err)
	}
}

// The GUI engine must not change: no headings computed, none in its JSON.
func TestGUISearchStaysFreeOfHeadings(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "2026-09-25.md", "# Title\nneedle\n")
	got, err := SearchScraps(dir, "needle", 10)
	if err != nil || len(got) != 1 || len(got[0].Matches) != 1 {
		t.Fatalf("got %v, %v", got, err)
	}
	m := got[0].Matches[0]
	if m.Heading != "" || m.HeadingLine != 0 {
		t.Errorf("the GUI search must not fill headings: %+v", m)
	}
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "heading") {
		t.Errorf("the GUI's JSON must be unchanged, got %s", b)
	}
	if want := `{"lineNumber":2,"lineText":"needle","snippet":"# Title\nneedle"}`; string(b) != want {
		t.Errorf("match JSON = %s, want %s", b, want)
	}
}

func TestHeadingTracker(t *testing.T) {
	type step struct {
		line    string
		heading string
		num     int
	}
	run := func(lines []string) (h headingTracker) {
		for i, l := range lines {
			h.feed(l, i+1)
		}
		return h
	}
	cases := []struct {
		name  string
		lines []string
		want  step
	}{
		{"plain heading", []string{"x", "## Title  "}, step{heading: "## Title", num: 2}},
		{"tab after hashes", []string{"#\tTitle"}, step{heading: "#\tTitle", num: 1}},
		{"empty heading", []string{"#"}, step{heading: "#", num: 1}},
		{"three spaces of indent is still a heading", []string{"   ### x"}, step{heading: "### x", num: 1}},
		{"four spaces is code", []string{"    # x"}, step{}},
		{"no space is a tag", []string{"#tag"}, step{}},
		{"seven hashes", []string{"####### x"}, step{}},
		{"fence hides headings", []string{"```", "# x", "```"}, step{}},
		{"fence closes, heading counts again", []string{"```", "# x", "```", "## y"}, step{heading: "## y", num: 4}},
		{"longer closing fence", []string{"```", "# x", "`````", "## y"}, step{heading: "## y", num: 4}},
		{"shorter fence does not close", []string{"````", "```", "# x"}, step{}},
		{"other fence char does not close", []string{"```", "~~~", "# x"}, step{}},
		{"closing fence has no text", []string{"```", "``` info", "# x"}, step{}},
		{"tilde fence", []string{"~~~ md", "# x", "~~~", "# y"}, step{heading: "# y", num: 4}},
		{"backtick info string with a backtick is inline code, not a fence", []string{"```a`b", "# x"}, step{heading: "# x", num: 2}},
		{"an unclosed fence hides the rest", []string{"# a", "```", "# b"}, step{heading: "# a", num: 1}},
	}
	for _, c := range cases {
		h := run(c.lines)
		if h.heading != c.want.heading || h.line != c.want.num {
			t.Errorf("%s: heading %q@%d, want %q@%d", c.name, h.heading, h.line, c.want.heading, c.want.num)
		}
	}
}
