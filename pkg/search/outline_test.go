package search

import (
	"context"
	"math/rand"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The outline (docs/design/tag-filter-2026-10.md section 11): a tag under a heading reaches every smaller heading below it.

const testBOM = "\xEF\xBB\xBF" // written as bytes: a byte order mark typed into a source file is rejected by the compiler

// ---- a reference written the plain way ------------------------------------------------------------------------------------------------

var (
	refHeadingRE = regexp.MustCompile(`^ {0,3}(#{1,3})([ \t]|$)`)
	refRuleRE    = regexp.MustCompile(`^[ \t\r\f\v]*-{3,}[ \t\r\f\v]*$`)
)

// refOutline is the level and the parent of every entry of Entries(text) by the rule as the design document says it in words: the
// parent is the nearest earlier entry with a smaller level, looking back no further than a break (an entry of level 0, or an entry that
// starts with a rule). It shares nothing with newOutline but the entries: the lines are cut with strings and read with regular expressions.
func refOutline(text string) (level, parent []int, startsRule []bool) {
	entries := Entries([]byte(text))
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	lines[0] = strings.TrimPrefix(lines[0], testBOM) // the first line's mark is not looked at (see entryLevel)
	headingLevel := func(s string) int {
		if m := refHeadingRE.FindStringSubmatch(s); m != nil {
			return len(m[1])
		}
		return 0
	}
	level, parent, startsRule = make([]int, len(entries)), make([]int, len(entries)), make([]bool, len(entries))
	for i, e := range entries {
		first := lines[e.StartLine-1]
		switch {
		case headingLevel(first) > 0:
			level[i] = headingLevel(first)
		case refRuleRE.MatchString(first):
			startsRule[i] = true
			if e.EndLine > e.StartLine {
				level[i] = headingLevel(lines[e.StartLine])
			}
		}
	}
	for i := range entries {
		parent[i] = -1
		if level[i] == 0 || startsRule[i] {
			continue
		}
		for k := i - 1; k >= 0; k-- {
			if level[k] == 0 {
				break // a rule alone, or the front part: the chain does not go past it
			}
			if level[k] < level[i] {
				parent[i] = k
				break
			}
			if startsRule[k] {
				break // an outline that opens with a rule is the end of what is above it
			}
		}
	}
	return level, parent, startsRule
}

// refAbove is the entries above i, the nearest first, by a parent array.
func refAbove(parent []int, i int) []int {
	var out []int
	for p := parent[i]; p >= 0; p = parent[p] {
		out = append(out, p)
	}
	return out
}

// refLast is the last entry under entry i's heading: the entries with i above them are the ones right after it.
func refLast(parent []int, i int) int {
	last := i
	for j := i + 1; j < len(parent); j++ {
		in := false
		for _, a := range refAbove(parent, j) {
			in = in || a == i
		}
		if !in {
			break
		}
		last = j
	}
	return last
}

// checkOutline compares newOutline with the reference for a text, including that a subtree is a run of entries.
func checkOutline(t *testing.T, text string) (level, parent []int) {
	t.Helper()
	data := []byte(text)
	entries := Entries(data)
	rl, rp, _ := refOutline(text)
	o := newOutline(data, entries, true)
	// the tag search asks for the parents only, and gets the same ones
	if lean := newOutline(data, entries, false); lean.level != nil || ints32(lean.parent) != ints32(o.parent) {
		t.Fatalf("the outline without levels: %v %v, with them %v", lean.level, lean.parent, o.parent)
	}
	for i := range entries {
		if int(o.level[i]) != rl[i] || int(o.parent[i]) != rp[i] {
			t.Fatalf("entry %d (line %d) of %q: level %d parent %d; the reference says level %d parent %d", i, entries[i].StartLine, text, o.level[i], o.parent[i], rl[i], rp[i])
		}
		last := refLast(rp, i)
		if int(o.lasts()[i]) != last {
			t.Fatalf("entry %d of %q: last %d, want %d", i, text, o.lasts()[i], last)
		}
		// everything after the run is not under i
		for j := last + 1; j < len(entries); j++ {
			for _, a := range refAbove(rp, j) {
				if a == i {
					t.Fatalf("entry %d of %q: entry %d is under it but not contiguous with it", i, text, j)
				}
			}
		}
	}
	return rl, rp
}

func ints32(a []int32) string {
	var s []string
	for _, n := range a {
		s = append(s, strconv.Itoa(int(n)))
	}
	return strings.Join(s, " ")
}

func ints(a []int) string {
	var s []string
	for _, n := range a {
		s = append(s, strconv.Itoa(n))
	}
	return strings.Join(s, " ")
}

func TestOutlineParents(t *testing.T) {
	cases := []struct {
		name, text      string
		levels, parents string // per entry of Entries(text), separated by spaces
	}{
		{"three levels", "# A\n## B\n### C\n", "1 2 3", "-1 0 1"},
		{"a skipped level: the parent is the nearest smaller", "# A\n### C\n", "1 3", "-1 0"},
		{"a level skipped on the way down and back", "# A\n### C\n## B\n", "1 3 2", "-1 0 0"},
		{"a bigger heading after a smaller one is a root, not a child of its former parent", "# A\n## B\n# A2\n## B2\n", "1 2 1 2", "-1 0 -1 2"},
		{"a second heading of the same level is a sibling", "# A\n## B\n## C\n### D\n", "1 2 2 3", "-1 0 0 2"},
		{"going back up several levels", "# A\n## B\n### C\n## D\n", "1 2 3 2", "-1 0 1 0"},
		{"the first heading may be a ###", "### C\n## B\n# A\n", "3 2 1", "-1 -1 -1"},
		{"a ## then a # is not under it", "## B\n# A\n### C\n", "2 1 3", "-1 -1 1"},
		{"front part", "intro\n# A\n## B\n", "0 1 2", "-1 -1 1"},
		{"a front part is not above anything", "intro\n## B\n", "0 2", "-1 -1"},
		{"a rule and its heading are one entry and a root", "---\n## ping\n### detail\n", "2 3", "-1 0"},
		{"a daily scrap: two rule entries, each its own outline", "---\n## [10:00:00] a\n### a1\n---\n## [10:05:00] b\n### b1\n", "2 3 2 3", "-1 0 -1 2"},
		{"a rule that opens an entry ends every chain before it", "# A\n## B\n---\n### C\n", "1 2 3", "-1 0 -1"},
		{"a rule alone breaks the chain", "# A\n## B\n---\ntext\n### C\n", "1 2 0 3", "-1 0 -1 -1"},
		{"a rule alone: what is after it is not under A", "# A\n---\ntext\n## B\n", "1 0 2", "-1 -1 -1"},
		{"a blank line between a rule and a heading: the rule is an entry of its own", "# A\n---\n\n## B\n", "1 0 2", "-1 -1 -1"},
		{"a comment line between a rule and a heading: the same", "# A\n---\n<!-- tags: x -->\n## B\n", "1 0 2", "-1 -1 -1"},
		{"a heading right after a rule is that entry's heading (the rule's level)", "# A\n---\n## B\n### C\n", "1 2 3", "-1 -1 1"},
		{"a longer rule and a rule with spaces", "# A\n-----\n## B\n  ---  \n### C\n", "1 2 3", "-1 -1 -1"},
		{"front matter: its rule entry is a wall, the closing rule and the heading are an outline", "---\ntags: [x]\n---\n# A\n## B\n", "0 1 2", "-1 -1 1"},
		{"#### is not an entry: it is text of the entry above", "# A\n#### deep\ntext\n## B\n", "1 2", "-1 0"},
		{"#### alone is not a heading at all", "#### deep\ntext\n", "0", "-1"},
		{"the first line of a ##### is text too", "# A\n##### x\n## B\n", "1 2", "-1 0"},
		{"a heading in a code fence is not a heading", "# A\n```\n# fake\n## fake\n```\n## B\n", "1 2", "-1 0"},
		{"an unclosed fence takes the rest of the note", "# A\n```\n## B\n### C\n", "1", "-1"},
		{"a heading indented by three spaces is one, by four is not", "# A\n   ## B\n    ## code\n### C\n", "1 2 3", "-1 0 1"},
		{"a # with no space is not a heading", "# A\n#B\n## C\n", "1 2", "-1 0"},
		{"a heading with a tab after the #", "# A\n##\tB\n", "1 2", "-1 0"},
		{"an empty heading", "# A\n##\n", "1 2", "-1 0"},
		{"CRLF", "# A\r\n## B\r\n### C\r\n## D\r\n", "1 2 3 2", "-1 0 1 0"},
		{"CRLF, a rule and its heading", "---\r\n## ping\r\n### detail\r\n", "2 3", "-1 0"},
		{"CRLF, a rule alone", "# A\r\n---\r\ntext\r\n## B\r\n", "1 0 2", "-1 -1 -1"},
		{"a byte order mark on the first heading", testBOM + "# A\n## B\n", "1 2", "-1 0"},
		{"a byte order mark and CRLF", testBOM + "# A\r\n## B\r\n### C\r\n", "1 2 3", "-1 0 1"},
		{"no newline at the end", "# A\n## B", "1 2", "-1 0"},
		{"a rule with no newline after it", "# A\n---", "1 0", "-1 -1"},
		{"one heading", "# A\n", "1", "-1"},
		{"no heading at all", "just text\nmore\n", "0", "-1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			level, parent := checkOutline(t, c.text)
			if got := ints(level); got != c.levels {
				t.Errorf("levels %q, want %q (entries %+v)", got, c.levels, Entries([]byte(c.text)))
			}
			if got := ints(parent); got != c.parents {
				t.Errorf("parents %q, want %q", got, c.parents)
			}
		})
	}
	// no text, no entries
	if o := newOutline(nil, Entries(nil), true); len(o.parent) != 0 {
		t.Errorf("an empty text has an outline: %+v", o)
	}
}

// The byte readers of the outline are the string readers of the splitter, written for bytes (no allocation per entry): they must not
// drift apart.
func TestOutlineLineReadersAgreeWithTheSplitters(t *testing.T) {
	lines := []string{"", " ", "#", "# ", "# a", "#a", "## a", "### a", "#### a", "##### a", "###", "###\t", "   # a", "    # a", " \t# a", "\t# a",
		"#\ta", "# #", "##x", "---", "--", "-----", "- - -", "  ---  ", "\t---", "---x", "--- x", "-", "----------------------------", "***", "```", "~~~",
		"日本語", "# 日本語", "#　全角空白", " ---", "--- "}
	rng := rand.New(rand.NewSource(7))
	alphabet := []string{"#", "#", "-", "-", " ", "\t", "a", "日", "x"}
	for i := 0; i < 3000; i++ {
		var b strings.Builder
		for n := rng.Intn(8); n > 0; n-- {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		lines = append(lines, b.String())
	}
	for _, l := range lines {
		want := 0
		if isEntryHeading(l) {
			rest := strings.TrimLeft(l, " ")
			for want < len(rest) && rest[want] == '#' {
				want++
			}
		}
		if got := int(headingLevel([]byte(l))); got != want {
			t.Errorf("headingLevel(%q) = %d, isEntryHeading says %v (level %d)", l, got, isEntryHeading(l), want)
		}
		if got, want := isRuleBytes([]byte(l)), isRuleLine(l); got != want {
			t.Errorf("isRuleBytes(%q) = %v, isRuleLine says %v", l, got, want)
		}
	}
}

// ---- the tags that reach an entry -----------------------------------------------------------------------------------------------------

// articleNote: a log heading with an article pasted under it; the entries are, in order (lines in brackets): 0 "# 記事" [1-3] with the tag
// 素材, 1 "## 加工" [4-6] with 工程, 2 "### 乾燥" [7-8], 3 "## 利用" [9-10], 4 "# 別の記事" [11-12].
const articleNote = "# 記事\n<!-- tags: 素材 -->\n竹の導入\n## 加工\n<!-- tags: 工程 -->\n竹を加工する\n### 乾燥\n竹を乾燥する\n## 利用\n竹の利用\n# 別の記事\n竹とは別の話\n"

func TestTagMapEntriesInheritFromTheHeadingsAbove(t *testing.T) {
	m := ScanTags([]byte(articleNote))
	if m == nil || m.ol == nil {
		t.Fatalf("no outline: %+v", m)
	}
	checks := []struct {
		entry int
		tag   string
		want  bool
	}{
		{0, "素材", true}, {1, "素材", true}, {2, "素材", true}, {3, "素材", true}, {4, "素材", false}, // the top heading's tag: all of its subtree, not the next article
		{0, "工程", false}, {1, "工程", true}, {2, "工程", true}, {3, "工程", false}, {4, "工程", false}, // a ## heading's tag: its ### below, not its parent or its sibling
		{2, "乾燥", false}, {5, "素材", false}, {-1, "素材", false},
	}
	for _, c := range checks {
		if got := m.HasEntry(c.entry, []string{c.tag}); got != c.want {
			t.Errorf("HasEntry(%d, %q) = %v, want %v", c.entry, c.tag, got, c.want)
		}
	}
	if !m.HasEntry(2, []string{"素材", "工程"}) || m.HasEntry(3, []string{"素材", "工程"}) {
		t.Error("both tags: the ### under the ## has them, its uncle's ## has only the first")
	}
	lines := map[int]string{3: "素材", 5: "素材,工程", 8: "素材,工程", 10: "素材", 12: ""}
	for line, want := range lines {
		if got := m.HasLine(line, ParseTagList("素材,工程")); got != (want == "素材,工程") {
			t.Errorf("HasLine(%d, both) = %v", line, got)
		}
		if got := m.HasLine(line, []string{"素材"}); got != (want != "") {
			t.Errorf("HasLine(%d, 素材) = %v", line, got)
		}
	}
	// the entry's own tags are the entry's own, whatever it inherits
	if got := tagsOf(m, 2); got != "" {
		t.Errorf("EntryTags(2) = %q: it is the entry's own tags", got)
	}
	if got := tagsOf(m, 1); got != "工程" {
		t.Errorf("EntryTags(1) = %q", got)
	}
}

func TestTagMapFileTagsStillApplyToEverything(t *testing.T) {
	m := ScanTags([]byte("<!-- tags: 全体 -->\nintro\n# A\n## B\n<!-- tags: b -->\n### C\n# D\n"))
	for i := 0; i < 5; i++ {
		if !m.HasEntry(i, []string{"全体"}) {
			t.Errorf("entry %d lacks the file's tag", i)
		}
	}
	if m.HasEntry(1, []string{"b"}) || !m.HasEntry(3, []string{"b"}) || m.HasEntry(4, []string{"b"}) {
		t.Error("b is on ## B and ### C only")
	}
	// a front matter tag too
	m = ScanTags([]byte("---\ntags: fm\n---\n# A\n<!-- tags: a -->\n## B\n"))
	for i := range m.entries {
		if !m.HasEntry(i, []string{"fm"}) {
			t.Errorf("entry %d lacks the front matter's tag", i)
		}
	}
	if !m.HasEntry(len(m.entries)-1, []string{"fm", "a"}) {
		t.Error("the front matter's and the heading's tag reach ## B")
	}
}

func TestTagMapBuildsTheOutlineOnlyForAFileThatHasTagsOfItsEntries(t *testing.T) {
	for _, c := range []struct {
		name, text string
		want       bool
	}{
		{"no comment at all", "# A\n## B\n", false},
		{"a comment that is not a tag", "# A\n<!-- note -->\n## B\n", false},
		{"the whole note's tag only", "<!-- tags: a -->\nintro\n# A\n", false},
		{"a front matter's tag only", "---\ntags: a\n---\n# A\n", false},
		{"a tag in a code fence", "# A\n```\n<!-- tags: a -->\n```\n", false},
		{"a tag of an entry", "# A\n<!-- tags: a -->\n## B\n", true},
	} {
		m := ScanTags([]byte(c.text))
		if got := m != nil && m.ol != nil; got != c.want {
			t.Errorf("%s: outline made %v, want %v", c.name, got, c.want)
		}
	}
	if ScanTags([]byte("# A\n## B\ntext\n")) != nil {
		t.Error("a file with no comment and no front matter tags must stay nil")
	}
}

func TestTagMapAnEntryUnderARuleDoesNotInheritAcrossIt(t *testing.T) {
	m := ScanTags([]byte("---\n## [10:05:00] ping\n<!-- tags: 急ぎ -->\n### 詳細\n本文\n---\n### 別\n本文\n"))
	// entries: 0 the rule and "## ping" (the tag), 1 "### 詳細" under it, 2 the rule and "### 別" (a root of its own)
	if !m.HasEntry(1, []string{"急ぎ"}) || m.HasEntry(2, []string{"急ぎ"}) {
		t.Errorf("detail %v, next outline %v", m.HasEntry(1, []string{"急ぎ"}), m.HasEntry(2, []string{"急ぎ"}))
	}
	// a rule that has no heading breaks the chain
	m = ScanTags([]byte("# A\n<!-- tags: a -->\n## B\n---\ntext\n### C\n"))
	if !m.HasEntry(1, []string{"a"}) || m.HasEntry(2, []string{"a"}) || m.HasEntry(3, []string{"a"}) {
		t.Errorf("B %v, the rule %v, C %v", m.HasEntry(1, []string{"a"}), m.HasEntry(2, []string{"a"}), m.HasEntry(3, []string{"a"}))
	}
}

func writeArticleFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeMD(t, dir, "2026-10-01.md", articleNote)
	writeMD(t, dir, "2026-10-02.md", "<!-- tags: 家 -->\n前文の竹\n# A\n## B\n竹がここにある\n")
	return dir
}

func TestSearchesReadTagsOfTheHeadingsAbove(t *testing.T) {
	dir := writeArticleFixture(t)
	ctx := context.Background()
	cases := []struct {
		tags         string
		ordered      string
		rankedHits   int
		rankedInFile string
	}{
		// 素材 is under "# 記事": the lines of its three sections, not the next article's
		{"素材", "2026-10-01.md:3,2026-10-01.md:6,2026-10-01.md:8,2026-10-01.md:10", 4, "2026-10-01.md"},
		// 工程 is under "## 加工": its own lines and the ### below
		{"工程", "2026-10-01.md:6,2026-10-01.md:8", 2, "2026-10-01.md"},
		{"素材,工程", "2026-10-01.md:6,2026-10-01.md:8", 2, "2026-10-01.md"},
		// the file's tag reaches everything in its file
		{"家", "2026-10-02.md:2,2026-10-02.md:5", 2, "2026-10-02.md"},
		{"家,素材", "", 0, ""},
		{"無い", "", 0, ""},
	}
	for _, c := range cases {
		tags := ParseTagList(c.tags)
		got, err := SearchScrapsOrdered(ctx, dir, "竹", 100, Options{Tags: tags})
		if err != nil {
			t.Fatal(err)
		}
		// per file in the order of the search (newest first), lines in order: sort by name for a stable comparison
		if h := sortedHits(got); h != c.ordered {
			t.Errorf("ordered %q: %s, want %s", c.tags, h, c.ordered)
		}
		ranked, err := SearchScrapsRanked(ctx, dir, "竹", 100, Options{Tags: tags})
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for _, r := range ranked {
			n += len(r.Matches)
			if r.FileName != c.rankedInFile {
				t.Errorf("ranked %q: a hit in %s", c.tags, r.FileName)
			}
		}
		if n != c.rankedHits {
			t.Errorf("ranked %q: %d hits (%s), want %d", c.tags, n, hitsOf(ranked), c.rankedHits)
		}
		// the fallback the window uses is the same search with the same filter
		fb, _ := SearchScrapsWithFallbackOptions(ctx, dir, "竹", 100, Options{Tags: tags})
		if sortedHits(fb) != c.ordered {
			t.Errorf("fallback %q: %s", c.tags, sortedHits(fb))
		}
	}
	// the ranked hit of the sub-section is the sub-section's own line
	r, _ := SearchScrapsRanked(ctx, dir, "乾燥", 100, Options{Tags: []string{"素材", "工程"}})
	if len(r) != 1 || r[0].Matches[0].LineNumber != 7 { // the first line of the section that has the word
		t.Errorf("乾燥: %s", hitsOf(r))
	}
}

// sortedHits lists the hits as "name:line", by file name and line number (the searches order the files newest first).
func sortedHits(rs []SearchResult) string {
	type hit struct {
		name string
		line int
	}
	var hits []hit
	for _, r := range rs {
		for _, m := range r.Matches {
			hits = append(hits, hit{r.FileName, m.LineNumber})
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].name != hits[j].name {
			return hits[i].name < hits[j].name
		}
		return hits[i].line < hits[j].line
	})
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.name + ":" + strconv.Itoa(h.line)
	}
	return strings.Join(out, ",")
}

func TestCollectTagsCountsTheEntriesAHeadingsTagReaches(t *testing.T) {
	dir := writeArticleFixture(t)
	// a heading's tag counted once per entry even when a smaller heading repeats it; a file's tag does not double with an entry's
	writeMD(t, dir, "2026-10-03.md", "<!-- tags: 全体 -->\n前文\n# A\n<!-- tags: x, 全体 -->\n## B\n<!-- tags: x -->\n### C\n# D\n<!-- tags: x -->\n")
	got, err := CollectTags(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]TagCount{}
	for _, c := range got {
		counts[c.Tag] = c
	}
	want := map[string]TagCount{
		"素材": {Tag: "素材", Files: 1, Entries: 4}, // 記事 and the three sections under it
		"工程": {Tag: "工程", Files: 1, Entries: 2}, // 加工 and 乾燥
		"家":  {Tag: "家", Files: 1, Entries: 3},  // the file's tag: every entry (front part, # A, ## B)
		"全体": {Tag: "全体", Files: 1, Entries: 5}, // every entry of its file, though one entry writes it again
		"x":  {Tag: "x", Files: 1, Entries: 4},  // A, B, C (under A, repeated on B) and D: A+B+C is 3 entries, D adds 1
	}
	for tag, w := range want {
		if counts[tag] != w {
			t.Errorf("%s: %+v, want %+v", tag, counts[tag], w)
		}
	}
	if len(counts) != len(want) {
		t.Errorf("tags %v", counts)
	}
}

// ---- the property: the production outline against the plain reference -----------------------------------------------------------------

// refEffective is what each entry of a text has (the whole file's tags, its own and those above it), by the reference parents and
// ScanTags's reading of the tag lines.
func refEffective(text string) (file []string, eff [][]string) {
	data := []byte(text)
	m := ScanTags(data)
	file = m.FileTags()
	entries := Entries(data)
	if len(entries) == 0 {
		return file, nil
	}
	_, parent, _ := refOutline(text)
	eff = make([][]string, len(entries))
	for i := range entries {
		eff[i] = append(eff[i], file...)
		eff[i] = addTags(eff[i], m.EntryTags(i), 1<<30)
		for _, a := range refAbove(parent, i) {
			eff[i] = addTags(eff[i], m.EntryTags(a), 1<<30)
		}
	}
	return file, eff
}

func entryIndexAt(entries []Entry, line int) int {
	for i, e := range entries {
		if e.StartLine <= line && line <= e.EndLine {
			return i
		}
	}
	return -1
}

// checkEffectiveTags compares the map's answers (HasEntry, HasLine) and the folder walk's counts with the reference for a text.
func checkEffectiveTags(t *testing.T, text string, probes []string) {
	t.Helper()
	data := []byte(text)
	entries := Entries(data)
	_, eff := refEffective(text)
	m := ScanTags(data)
	for i := range entries {
		for _, p := range probes {
			if got, want := m.HasEntry(i, []string{p}), hasTag(eff[i], p); got != want {
				t.Fatalf("HasEntry(%d, %q) = %v, the reference says %v, on %q", i, p, got, want, text)
			}
		}
	}
	for line := 1; line <= strings.Count(text, "\n")+1; line++ {
		i := entryIndexAt(entries, line)
		for _, p := range probes {
			want := i >= 0 && hasTag(eff[i], p)
			if got := m.HasLine(line, []string{p}); got != want {
				t.Fatalf("HasLine(%d, %q) = %v, the reference says %v, on %q", line, p, got, want, text)
			}
		}
	}
}

// Notes of many shapes: the outline is the reference's, and the tags that reach an entry are the reference's.
func TestOutlineAndEffectiveTagsMatchTheReferenceOnRandomNotes(t *testing.T) {
	probes := append(append([]string{}, propertyTags...), "z", "nothing")
	dir := t.TempDir()
	cases := *propertyCases
	for seed := int64(0); seed < int64(cases); seed++ {
		text := randomNote(rand.New(rand.NewSource(seed + 1_000_000)))
		checkOutline(t, text)
		checkEffectiveTags(t, text, probes)
		if seed%25 != 0 {
			continue
		}
		// the folder walk counts the same entries
		_, eff := refEffective(text)
		want := map[string]int{}
		for _, tags := range eff {
			for _, tag := range tags {
				want[tag]++
			}
		}
		sub := dir + "/" + strconv.FormatInt(seed, 10)
		writeMD(t, sub, "n.md", text)
		got, err := CollectTags(context.Background(), sub)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("seed %d: CollectTags %+v, the reference %v, on %q", seed, got, want, text)
		}
		for _, c := range got {
			if c.Files != 1 || c.Entries != want[c.Tag] {
				t.Fatalf("seed %d: %+v, the reference says %d entries, on %q", seed, c, want[c.Tag], text)
			}
		}
	}
}
