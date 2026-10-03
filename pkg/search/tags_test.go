package search

import (
	"context"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestNormalizeTag(t *testing.T) {
	cases := map[string]string{
		"仕事":       "仕事",
		"#仕事":      "仕事",
		"  #Work ": "work",
		"##a":      "a",
		"# a":      "a",
		"#":        "",
		"":         "",
		"ＡＢＣ":      "abc",  // full-width ASCII letters
		"＃買い物":     "買い物",  // a full-width # is a # too
		"２０２６":     "2026", // full-width digits
		"　仕事　":     "仕事",   // ideographic spaces
		"Ｃ＋＋":      "c++",
		"ひらがな":     "ひらがな", // kana are not unified
		"カタカナ":     "カタカナ",
		"c#":       "c#", // only a leading # goes
	}
	for in, want := range cases {
		if got := NormalizeTag(in); got != want {
			t.Errorf("NormalizeTag(%q) = %q, want %q", in, got, want)
		}
		if again := NormalizeTag(want); again != want {
			t.Errorf("NormalizeTag is not idempotent for %q: %q", in, again)
		}
	}
}

func TestParseTagList(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"仕事, 買い物", []string{"仕事", "買い物"}},
		{"#仕事,急ぎ", []string{"仕事", "急ぎ"}},
		{"a b\tc　d", []string{"a", "b", "c", "d"}}, // white space, the ideographic space too
		{"a、b，c;d；e", []string{"a", "b", "c", "d", "e"}},
		{"A a ＡＡ #a", []string{"a", "aa"}}, // de-duplicated after normalizing, in the order written
		{"  ,, ; ", nil},
		{"#", nil},
		{"", nil},
		{"a,b,c,d,e,f,g,h,i,j", []string{"a", "b", "c", "d", "e", "f", "g", "h"}}, // at most 8
		{strings.Repeat("x", 64) + " " + strings.Repeat("y", 65) + " ok", []string{strings.Repeat("x", 64), "ok"}},
		{strings.Repeat("日", 64) + " " + strings.Repeat("日", 65), []string{strings.Repeat("日", 64)}}, // 64 characters, not bytes
	}
	for _, c := range cases {
		if got := ParseTagList(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseTagList(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A search refuses what ParseTagList would drop: a filter that lost a tag quietly would let more through than was asked for.
func TestParseTagFilter(t *testing.T) {
	ok := []struct {
		in   []string
		want []string
	}{
		{nil, nil},
		{[]string{}, nil},
		{[]string{"", "  "}, nil}, // nothing asked for is no filter
		{[]string{"仕事"}, []string{"仕事"}},
		{[]string{"#仕事, 急ぎ", "急ぎ", "Ｗｏｒｋ"}, []string{"仕事", "急ぎ", "work"}},               // a list of lists, de-duplicated
		{[]string{"a,b,c,d,e,f,g,h"}, []string{"a", "b", "c", "d", "e", "f", "g", "h"}}, // exactly 8
		{[]string{"a", "a", "a,b"}, []string{"a", "b"}},
	}
	for _, c := range ok {
		got, err := ParseTagFilter(c.in)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseTagFilter(%q) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	bad := []struct {
		in   []string
		want string
	}{
		{[]string{"a,b,c,d,e,f,g,h,i"}, "too many tags (at most 8)"},
		{[]string{"a,b,c,d", "e,f,g,h", "i"}, "too many tags"},
		{[]string{strings.Repeat("x", 65)}, "longer than 64"},
		{[]string{"ok", strings.Repeat("日", 65)}, "longer than 64"},
		{[]string{"#"}, "no tag in"},
		{[]string{",;、"}, "no tag in"},
	}
	for _, c := range bad {
		if got, err := ParseTagFilter(c.in); err == nil || !strings.Contains(err.Error(), c.want) || got != nil || strings.Contains(err.Error(), "\n") {
			t.Errorf("ParseTagFilter(%q) = %q, %v; want an error with %q", c.in, got, err, c.want)
		}
	}
}

func tagsOf(m *TagMap, i int) string {
	return strings.Join(m.EntryTags(i), ",")
}

func TestScanTagsIsNilForAFileThatCannotCarryATag(t *testing.T) {
	for _, src := range []string{
		"",
		"plain text\nno comment here\n",
		"---\n## [10:00:00] 打ち合わせ\nbody\n", // a rule and a heading, not a front matter
		"---\ntitle: x\nno closing line\n", // never closed
		"---\ntitle: x\n---\nbody\n",       // a front matter without tags
	} {
		if m := ScanTags([]byte(src)); m != nil {
			t.Errorf("ScanTags(%q) = %+v, want nil", src, m)
		}
	}
	// the nil map answers anyway
	var m *TagMap
	if m.HasLine(1, []string{"a"}) || m.HasEntry(0, []string{"a"}) || len(m.FileTags()) != 0 || len(m.EntryTags(0)) != 0 {
		t.Error("the nil TagMap must be an empty one")
	}
	if !m.HasLine(1, nil) || !m.HasEntry(0, nil) {
		t.Error("no wanted tag is always true")
	}
}

func TestScanTagsFileScopeIsTheFrontPart(t *testing.T) {
	src := "<!-- tags: 仕事, 急ぎ -->\n前文。\n\n# 見出し1\n本文1\n<!-- tags: 買い物 -->\n\n## 見出し2\n本文2\n\n---\n本文3\n<!-- tags: 仕事 #メモ -->\n"
	m := ScanTags([]byte(src))
	if m == nil {
		t.Fatal("nil")
	}
	if got := strings.Join(m.FileTags(), ","); got != "仕事,急ぎ" {
		t.Errorf("file tags = %q", got)
	}
	entries := Entries([]byte(src))
	if len(entries) != 4 {
		t.Fatalf("entries = %+v", entries)
	}
	if tagsOf(m, 0) != "" || tagsOf(m, 1) != "買い物" || tagsOf(m, 2) != "" || tagsOf(m, 3) != "仕事,メモ" {
		t.Errorf("own tags = %q %q %q %q", tagsOf(m, 0), tagsOf(m, 1), tagsOf(m, 2), tagsOf(m, 3))
	}
	// the effective tags are the union of the file's and the entry's own: AND over the wanted ones
	checks := []struct {
		entry int
		want  string
		ok    bool
	}{
		{0, "仕事", true}, {0, "仕事,急ぎ", true}, {0, "買い物", false},
		{1, "仕事,買い物", true}, {1, "急ぎ,買い物", true}, {1, "メモ", false},
		{2, "仕事", true}, {2, "買い物", false}, // no inheritance from a heading above
		{3, "仕事,メモ,急ぎ", true}, {3, "買い物", false},
		{4, "仕事", false}, {-1, "仕事", false}, // no such entry
	}
	for _, c := range checks {
		if got := m.HasEntry(c.entry, ParseTagList(c.want)); got != c.ok {
			t.Errorf("HasEntry(%d, %q) = %v, want %v", c.entry, c.want, got, c.ok)
		}
	}
	// HasLine goes by the entry the line is in
	lines := []struct {
		line int
		want string
		ok   bool
	}{
		{1, "急ぎ", true}, {2, "急ぎ", true}, {4, "買い物", true}, {5, "買い物", true}, {6, "買い物", true}, {9, "買い物", false},
		{11, "メモ", true}, {12, "メモ", true}, {13, "メモ", true}, {14, "仕事", false}, {0, "仕事", false}, {-3, "仕事", false},
	}
	for _, c := range lines {
		if got := m.HasLine(c.line, ParseTagList(c.want)); got != c.ok {
			t.Errorf("HasLine(%d, %q) = %v, want %v (entries %+v)", c.line, c.want, got, c.ok, entries)
		}
	}
}

func TestScanTagsAFileThatOpensWithAHeadingOrARuleHasNoFrontPart(t *testing.T) {
	// the comment right under the first heading tags that entry only
	src := "# 見出し1\n<!-- tags: a -->\n本文\n\n# 見出し2\n本文2\n"
	m := ScanTags([]byte(src))
	if len(m.FileTags()) != 0 || tagsOf(m, 0) != "a" || m.HasEntry(1, []string{"a"}) {
		t.Errorf("heading first: file %q own0 %q entry1 has a: %v", m.FileTags(), tagsOf(m, 0), m.HasEntry(1, []string{"a"}))
	}
	// a daily scrap: "---" then the heading is one entry
	src = "---\n## [10:00:00] 仕事の連絡\n<!-- tags: 仕事 -->\n本文\n\n---\n## [11:00:00] 昼食\n本文2\n"
	m = ScanTags([]byte(src))
	if len(m.FileTags()) != 0 || !m.HasLine(4, []string{"仕事"}) || m.HasLine(8, []string{"仕事"}) {
		t.Errorf("daily scrap: file %q, line 4 %v, line 8 %v", m.FileTags(), m.HasLine(4, []string{"仕事"}), m.HasLine(8, []string{"仕事"}))
	}
	// blank lines first: the front part is still above the first heading
	m = ScanTags([]byte("\n\n<!-- tags: top -->\n# h\ntext\n"))
	if got := strings.Join(m.FileTags(), ","); got != "top" || !m.HasEntry(1, []string{"top"}) {
		t.Errorf("blank lines then a comment: %q", got)
	}
}

func TestScanTagsReadsOnlyOneWholeLineComments(t *testing.T) {
	cases := []struct {
		name, src string
		want      []string // file tags
	}{
		{"plain", "<!-- tags: a -->\n", []string{"a"}},
		{"no spaces", "<!--tags:a,b-->\n", []string{"a", "b"}},
		{"key tag", "<!-- tag: a -->\n", []string{"a"}},
		{"key in capitals", "<!-- TAGS: A -->\n", []string{"a"}},
		{"space before the colon", "<!-- tags : a -->\n", []string{"a"}},
		{"indented, trailing white space", "   \t<!-- tags: a -->  \t\n", []string{"a"}},
		{"CRLF", "<!-- tags: a, b -->\r\nbody\r\n", []string{"a", "b"}},
		{"BOM", "\xEF\xBB\xBF<!-- tags: a -->\nbody\n", []string{"a"}},
		{"empty list", "<!-- tags: -->\nbody\n", nil},
		{"another comment", "<!-- note: tags: a -->\n", nil},
		{"text before", "see <!-- tags: a -->\n", nil},
		{"text after", "<!-- tags: a --> done\n", nil},
		{"two comments", "<!-- tags: a --> <!-- tags: b -->\n", nil},
		{"spans lines", "<!-- tags: a\nb -->\n", nil},
		{"spans lines 2", "<!--\ntags: a -->\n", nil},
		{"in a block quote", "> <!-- tags: a -->\n", nil},
		{"inside a fence", "```md\n<!-- tags: a -->\n```\n<!-- tags: b -->\n", []string{"b"}},
		{"inside a tilde fence", "~~~\n<!-- tags: a -->\n~~~\n", nil},
		{"inside a longer fence", "````\n```\n<!-- tags: a -->\n```\n````\n<!-- tags: c -->\n", []string{"c"}},
		{"a heading in a fence is not an entry", "```\n# not a heading\n<!-- tags: a -->\n```\n<!-- tags: b -->\n# real\n", []string{"b"}},
		{"unclosed fence swallows the rest", "```\n<!-- tags: a -->\n", nil},
		{"more than 32 tags", "<!-- tags: " + strings.Join(manyTags(40), " ") + " -->\n", manyTags(32)},
		{"a tag of 65 characters", "<!-- tags: " + strings.Repeat("x", 65) + " ok -->\n", []string{"ok"}},
	}
	for _, c := range cases {
		m := ScanTags([]byte(c.src))
		var got []string
		if m != nil {
			got = m.FileTags()
		}
		if len(got) != len(c.want) || (len(got) > 0 && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("%s: file tags = %q, want %q", c.name, got, c.want)
		}
	}
}

func manyTags(n int) []string {
	var out []string
	for i := 0; i < n; i++ {
		out = append(out, "t"+string(rune('a'+i%26))+string(rune('a'+i/26)))
	}
	return out
}

func TestScanTagsFrontMatter(t *testing.T) {
	cases := []struct {
		name, src string
		want      []string
	}{
		{"flow list", "---\ntitle: x\ntags: [仕事, 急ぎ]\n---\nbody\n", []string{"仕事", "急ぎ"}},
		{"quoted flow list", "---\ntags: [\"a\", 'b c']\n---\n", []string{"a", "b", "c"}},
		{"comma list", "---\ntags: a, b\n---\nbody\n", []string{"a", "b"}},
		{"block list", "---\ntitle: x\ntags:\n  - a\n  - \"b\"\n- c\ndate: 2026-10-03\n---\nbody\n", []string{"a", "b", "c"}},
		{"key tag, capitals", "---\nTag: a\n---\n", []string{"a"}},
		{"CRLF", "---\r\ntags: [a]\r\n---\r\nbody\r\n", []string{"a"}},
		{"BOM", "\xEF\xBB\xBF---\ntags: a\n---\n", []string{"a"}},
		{"blank line first", "---\n\ntags: a\n---\n", []string{"a"}},
		{"ends with dots", "---\ntags: a\n...\nbody\n", []string{"a"}},
		{"after the block list", "---\ntags:\n  - a\nother: b\ntags_not: c\n---\n", []string{"a"}},
		{"a nested key is not a tag", "---\nmeta:\n  tags: a\n---\n", nil},
		{"first line after the rule is not a key", "---\n## [10:00:00] x\ntags: a\n---\n", nil},
		{"tags later in the file are not a front matter", "intro\n---\ntags: a\n---\n", nil},
		{"never closed", "---\ntags: a\nmore\n", nil},
		{"four dashes", "----\ntags: a\n---\n", nil},
	}
	for _, c := range cases {
		m := ScanTags([]byte(c.src))
		var got []string
		if m != nil {
			got = m.FileTags()
		}
		if len(got) != len(c.want) || (len(got) > 0 && !reflect.DeepEqual(got, c.want)) {
			t.Errorf("%s: file tags = %q, want %q", c.name, got, c.want)
		}
	}
	// a front matter tags the whole file, every entry of it
	src := "---\ntags: [仕事]\n---\n# 見出し\n本文\n\n## 見出し2\n<!-- tags: 急ぎ -->\n"
	m := ScanTags([]byte(src))
	n := len(Entries([]byte(src)))
	for i := 0; i < n; i++ {
		if !m.HasEntry(i, []string{"仕事"}) {
			t.Errorf("entry %d lacks the front matter's tag", i)
		}
	}
	if !m.HasLine(8, []string{"仕事", "急ぎ"}) || m.HasLine(5, []string{"急ぎ"}) {
		t.Errorf("front matter plus an entry's comment: line 8 %v, line 5 %v", m.HasLine(8, []string{"仕事", "急ぎ"}), m.HasLine(5, []string{"急ぎ"}))
	}
}

// The entries a TagMap indexes are the ones Entries cuts, whatever the file holds.
func TestTagMapEntriesAreTheEntriesTheSearchCuts(t *testing.T) {
	src := "\xEF\xBB\xBF# bom heading\r\n<!-- tags: a -->\r\n---\r\n## [10:00:00] x\r\n```\r\n---\r\n# not a heading\r\n```\r\n<!-- tags: b -->\r\n# real\r\n"
	m := ScanTags([]byte(src))
	if m == nil {
		t.Fatal("nil")
	}
	if !reflect.DeepEqual(m.entries, Entries([]byte(src))) {
		t.Errorf("entries differ:\n%+v\n%+v", m.entries, Entries([]byte(src)))
	}
	// the fence hides the rule and the heading: b belongs to the entry that holds the fence
	if !m.HasLine(9, []string{"b"}) || m.HasLine(10, []string{"b"}) {
		t.Errorf("b: line 9 %v, line 10 %v", m.HasLine(9, []string{"b"}), m.HasLine(10, []string{"b"}))
	}
}

func TestCollectTagsCountsFilesAndEntries(t *testing.T) {
	dir := t.TempDir()
	writeMD(t, dir, "2026-10-01.md", "<!-- tags: 仕事 -->\n前文\n\n---\n## [10:00:00] a\n<!-- tags: 急ぎ -->\n本文\n\n---\n## [11:00:00] b\n本文\n")
	writeMD(t, dir, "2026-10-02.md", "---\n## [10:00:00] c\n<!-- tags: 仕事, 急ぎ -->\n本文\n\n---\n## [11:00:00] d\n<!-- tags: 急ぎ -->\n")
	writeMD(t, dir, "sub/notes.md", "---\ntags: [買い物]\n---\n# x\nbody\n")
	writeMD(t, dir, "plain.md", "no tags here\n")
	writeMD(t, dir, ".hidden/2026-10-03.md", "<!-- tags: 隠し -->\n")
	writeMD(t, dir, "not-markdown.txt", "<!-- tags: txt -->\n")

	got, err := CollectTags(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []TagCount{
		{Tag: "急ぎ", Files: 2, Entries: 3},  // 1 entry of the first file, 2 of the second
		{Tag: "仕事", Files: 2, Entries: 4},  // all 3 entries of the first file (a tag above the first rule), 1 of the second
		{Tag: "買い物", Files: 1, Entries: 2}, // the front matter tags the file: both its entries (the block above the closing rule, and the rest)
	}
	// 仕事 and 急ぎ both count 2 files: ties are by tag
	if want[0].Tag > want[1].Tag {
		want[0], want[1] = want[1], want[0]
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("CollectTags =\n%+v\nwant\n%+v", got, want)
	}

	// no tag anywhere (or no folder) is an empty list, never nil
	for _, d := range []string{t.TempDir(), dir + "-missing"} {
		got, err := CollectTags(context.Background(), d)
		if err != nil || got == nil || len(got) != 0 {
			t.Errorf("%s: %v %v", d, got, err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, err := CollectTags(ctx, dir); err == nil || got != nil {
		t.Errorf("a cancelled walk must say so: %v %v", got, err)
	}
}

func hitsOf(rs []SearchResult) string {
	var out []string
	for _, r := range rs {
		for _, m := range r.Matches {
			out = append(out, r.FileName+":"+strconv.Itoa(m.LineNumber))
		}
	}
	return strings.Join(out, ",")
}

func tagFixture(t *testing.T) string {
	dir := t.TempDir()
	// entry by entry: line 1-3 front part (file tag 家), 4-6 work, 7-9 shopping, 10-12 untagged
	writeMD(t, dir, "2026-10-01.md",
		"<!-- tags: 家 -->\n牛乳 front\n\n---\n## [10:00:00] work\n牛乳 for work <!-- not a tag -->\n<!-- tags: 仕事 -->\n\n---\n## [11:00:00] shop\n<!-- tags: 買い物 -->\n牛乳 for shopping\n\n---\n## [12:00:00] none\n牛乳 untagged\n")
	writeMD(t, dir, "2026-10-02.md", "---\n## [09:00:00] x\n牛乳 and no tag at all\n")
	writeMD(t, dir, "2026-10-03.md", "---\ntags: [仕事]\n---\n# whole file\n牛乳 front matter work\n")
	// a tag comment in a code block is not a tag
	writeMD(t, dir, "2026-10-04.md", "# how to\n```md\n<!-- tags: 仕事 -->\n```\n牛乳 in a note about tags\n")
	return dir
}

func TestSearchOrderedWithTagsKeepsTheLinesOfTheTaggedEntries(t *testing.T) {
	dir := tagFixture(t)
	ctx := context.Background()
	all, _ := SearchScrapsOrdered(ctx, dir, "牛乳", 100, Options{})
	if got := hitsOf(all); got != "2026-10-04.md:5,2026-10-03.md:5,2026-10-02.md:3,2026-10-01.md:2,2026-10-01.md:6,2026-10-01.md:12,2026-10-01.md:16" {
		t.Fatalf("without tags: %s", got)
	}
	cases := []struct {
		tags string
		want string
	}{
		{"仕事", "2026-10-03.md:5,2026-10-01.md:6"},
		{"買い物", "2026-10-01.md:12"},
		{"家", "2026-10-01.md:2,2026-10-01.md:6,2026-10-01.md:12,2026-10-01.md:16"}, // the file's own tag reaches every entry of it
		{"家,仕事", "2026-10-01.md:6"},
		{"仕事,買い物", ""},
		{"無い", ""},
	}
	for _, c := range cases {
		got, err := SearchScrapsOrdered(ctx, dir, "牛乳", 100, Options{Tags: ParseTagList(c.tags)})
		if err != nil {
			t.Fatal(err)
		}
		if h := hitsOf(got); h != c.want {
			t.Errorf("tags %q: %s, want %s", c.tags, h, c.want)
		}
	}
	// the limit counts the lines that stay: the first untagged-file hits do not use it up
	got, _ := SearchScrapsOrdered(ctx, dir, "牛乳", 1, Options{Tags: []string{"仕事"}})
	if h := hitsOf(got); h != "2026-10-03.md:5" {
		t.Errorf("limit 1: %s", h)
	}
	got, _ = SearchScrapsOrdered(ctx, dir, "牛乳", 2, Options{Tags: []string{"家"}})
	if h := hitsOf(got); h != "2026-10-01.md:2,2026-10-01.md:6" {
		t.Errorf("limit 2 in one file: %s", h)
	}
	// Keep and Tags work together
	got, _ = SearchScrapsOrdered(ctx, dir, "牛乳", 100, Options{Tags: []string{"仕事"}, Keep: func(p string) bool { return strings.HasSuffix(p, "01.md") }})
	if h := hitsOf(got); h != "2026-10-01.md:6" {
		t.Errorf("keep + tags: %s", h)
	}
}

func TestSearchRankedWithTagsScoresOnlyTheTaggedEntries(t *testing.T) {
	dir := tagFixture(t)
	ctx := context.Background()
	all, _ := SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{})
	if len(all) != 7 { // one hit per entry that holds the word: four in the first file, one in each of the others
		t.Fatalf("without tags: %s", hitsOf(all))
	}
	// per entry: one hit each, in the tagged entries only
	got, err := SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{Tags: []string{"仕事"}})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]int{}
	for _, r := range got {
		files[r.FileName] += len(r.Matches)
	}
	if len(got) != 2 || files["2026-10-01.md"] != 1 || files["2026-10-03.md"] != 1 {
		t.Errorf("仕事: %s", hitsOf(got))
	}
	got, _ = SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{Tags: []string{"家"}})
	n := 0
	for _, r := range got {
		n += len(r.Matches)
		if r.FileName != "2026-10-01.md" {
			t.Errorf("家: %s", hitsOf(got))
		}
	}
	if n != 4 {
		t.Errorf("家 tags the 4 entries of its file: %s", hitsOf(got))
	}
	if got, _ := SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{Tags: []string{"家", "買い物"}}); hitsOf(got) != "2026-10-01.md:12" {
		t.Errorf("家+買い物: %s", hitsOf(got))
	}
	if got, _ := SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{Tags: []string{"無い"}}); len(got) != 0 {
		t.Errorf("an unknown tag is an empty answer, not an error: %s", hitsOf(got))
	}
	// the hit of an entry is the same line with or without the filter
	only, _ := SearchScrapsRanked(ctx, dir, "牛乳", 100, Options{Tags: []string{"買い物"}})
	if len(only) != 1 || only[0].Matches[0].LineNumber != 12 || only[0].Matches[0].LineText != "牛乳 for shopping" {
		t.Errorf("買い物: %+v", only)
	}
}

// No tag means the same code path as ever: the results are identical to the ones without the field, and the fallback function is the
// window's own search.
func TestSearchWithoutTagsIsUnchanged(t *testing.T) {
	dir := tagFixture(t)
	ctx := context.Background()
	for _, q := range []string{"牛乳", "牛乳 work", "no tag at all", "nothing here"} {
		a, _ := SearchScrapsOrdered(ctx, dir, q, 100, Options{})
		b, _ := SearchScrapsOrdered(ctx, dir, q, 100, Options{Tags: nil})
		c, _ := SearchScrapsOrdered(ctx, dir, q, 100, Options{Tags: []string{}})
		if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(a, c) {
			t.Errorf("%q: ordered differs", q)
		}
		ra, _ := SearchScrapsRanked(ctx, dir, q, 100, Options{})
		rb, _ := SearchScrapsRanked(ctx, dir, q, 100, Options{Tags: []string{}})
		if !reflect.DeepEqual(ra, rb) {
			t.Errorf("%q: ranked differs", q)
		}
		f1, e1 := SearchScrapsWithFallback(ctx, dir, q, 100)
		f2, e2 := SearchScrapsWithFallbackOptions(ctx, dir, q, 100, Options{})
		if e1 != nil || e2 != nil || !reflect.DeepEqual(f1, f2) {
			t.Errorf("%q: fallback differs: %v %v", q, e1, e2)
		}
	}
}

func TestSearchScrapsWithFallbackOptionsFallsBackToTheRankedSearchWithTheSameOptions(t *testing.T) {
	dir := tagFixture(t)
	ctx := context.Background()
	// no single line holds "work 牛乳 shopping" (the exact search finds nothing), but the shopping entry holds the words 牛乳 and shopping
	opts := Options{Tags: []string{"買い物"}}
	exact, _ := SearchScrapsOrdered(ctx, dir, "牛乳 shop", 100, opts)
	if len(exact) != 0 {
		t.Fatalf("expected no exact hit: %s", hitsOf(exact))
	}
	got, err := SearchScrapsWithFallbackOptions(ctx, dir, "牛乳 shop", 100, opts)
	if err != nil || len(got) != 1 || got[0].FileName != "2026-10-01.md" || got[0].Matches[0].Score <= 0 {
		t.Fatalf("fallback: %+v %v", got, err)
	}
	// the exact search wins when it finds something
	got, _ = SearchScrapsWithFallbackOptions(ctx, dir, "牛乳 for shopping", 100, opts)
	if len(got) != 1 || got[0].Matches[0].Score != 0 {
		t.Errorf("exact: %+v", got)
	}
	// the tag is still required in the fallback: the shopping entry is the only one with both words, and it is not a 仕事 entry, so the
	// answer is the two work entries that hold one of the words
	got, _ = SearchScrapsWithFallbackOptions(ctx, dir, "牛乳 shop", 100, Options{Tags: []string{"仕事"}})
	if h := hitsOf(got); h != "2026-10-03.md:5,2026-10-01.md:6" {
		t.Errorf("fallback with another tag: %s", h)
	}
	for _, r := range got {
		if !r.Matches[0].Partial {
			t.Errorf("a work entry lacks the word shop: %+v", r)
		}
	}
}

func TestIsTagCommentLine(t *testing.T) {
	for line, want := range map[string]bool{
		"<!-- tags: 仕事, 買い物 -->":       true,
		"  <!--tags:仕事-->  ":           true,
		"<!-- TAG: a -->":              true,
		"<!-- tags: -->":               true, // an empty list is still a tag comment
		"<!-- not a tag -->":           false,
		"<!-- tags: a --> and text":    false,
		"text <!-- tags: a -->":        false,
		"<!-- tags: a -->\n<!-- b -->": false,
		"<!-- keywords: a -->":         false,
		"tags: a":                      false,
		"":                             false,
	} {
		if got := IsTagCommentLine(line); got != want {
			t.Errorf("IsTagCommentLine(%q) = %v, want %v", line, got, want)
		}
	}
}

// A tag comment is metadata that the preview hides; the context a search shows around a hit must not bring it back.
func TestSearchSnippetsLeaveOutTagComments(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	writeMD(t, dir, "2026-10-01.md", "# 見積もり\n<!-- tags: 仕事 -->\n納期を確認する\n<!-- tags: 急ぎ -->\n以上\n")
	snippetOf := func(rs []SearchResult) string {
		if len(rs) != 1 || len(rs[0].Matches) != 1 {
			t.Fatalf("results: %+v", rs)
		}
		return rs[0].Matches[0].Snippet
	}
	for name, search := range map[string]func() ([]SearchResult, error){
		"ordered": func() ([]SearchResult, error) { return SearchScrapsOrdered(ctx, dir, "納期", 10, Options{}) },
		"gui":     func() ([]SearchResult, error) { return SearchScrapsContext(ctx, dir, "納期", 10) },
		"ranked":  func() ([]SearchResult, error) { return SearchScrapsRanked(ctx, dir, "納期", 10, Options{}) },
	} {
		rs, err := search()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if s := snippetOf(rs); s != "納期を確認する" {
			t.Errorf("%s: snippet = %q, want only the matching line (both neighbours are tag comments)", name, s)
		}
		if rs[0].Matches[0].LineNumber != 3 {
			t.Errorf("%s: the line number must still count the comment lines: %d", name, rs[0].Matches[0].LineNumber)
		}
	}
	// an ordinary neighbour stays
	writeMD(t, dir, "2026-10-02.md", "前の行\n納期を確認する\n次の行\n")
	rs, _ := SearchScrapsOrdered(ctx, dir, "次の行", 10, Options{})
	if s := rs[0].Matches[0].Snippet; s != "納期を確認する\n次の行" {
		t.Errorf("ordinary context changed: %q", s)
	}
}
