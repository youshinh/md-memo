package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// Tags and days narrow every kind of `scrap search` (docs/design/tag-filter-2026-10.md). The fixture below is one folder:
//
//	2026-10-01.md            a tag above the first rule (the whole file: 家) and three entries: work (仕事), shopping (買い物), none
//	2026-10-02_title.md      a front matter tags the file (仕事); its name starts with a day but is not YYYY-MM-DD.md
//	2026-10-03.md            a tag comment inside a code fence, which is code, and a real one outside it (本物)
//	notes.md                 no day in its name; tagged 仕事
func tagFixture(t *testing.T) string {
	t.Helper()
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-10-01.md"),
		"<!-- tags: 家 -->\n牛乳 front\n\n---\n## [10:00:00] work\n牛乳 for work <!-- not a tag -->\n<!-- tags: 仕事 -->\n\n---\n## [11:00:00] shop\n<!-- tags: 買い物 -->\n牛乳 for shopping\n\n---\n## [12:00:00] none\n牛乳 untagged\n")
	writeFile(t, filepath.Join(dir, "2026-10-02_title.md"), "---\ntitle: x\ntags: [仕事, 急ぎ]\n---\n# whole file\n牛乳 front matter work\n")
	writeFile(t, filepath.Join(dir, "2026-10-03.md"), "# how to tag\n```md\n<!-- tags: 隠れ -->\n```\n<!-- tags: 本物 -->\n牛乳 and a fence\n")
	writeFile(t, filepath.Join(dir, "notes.md"), "<!-- tags: 仕事 -->\n牛乳 in the undated note\n")
	return dir
}

// hits names every hit file:line, in the order given.
func hitList(res searchOut) string {
	var out []string
	for _, m := range res.Matches {
		out = append(out, filepath.Base(m.File)+":"+strconv.Itoa(m.Line))
	}
	return strings.Join(out, ",")
}

func TestScrapSearchTagKeepsTheEntriesThatHaveAllTheTags(t *testing.T) {
	tagFixture(t)

	// no tag: everything, newest day first, the undated note last
	all := searchJSON(t, "牛乳")
	if got := hitList(all); got != "2026-10-03.md:6,2026-10-02_title.md:6,2026-10-01.md:2,2026-10-01.md:6,2026-10-01.md:12,2026-10-01.md:16,notes.md:2" {
		t.Fatalf("no tag: %s", got)
	}
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"--tag", "仕事"}, "2026-10-02_title.md:6,2026-10-01.md:6,notes.md:2"},
		{[]string{"--tag", "#仕事"}, "2026-10-02_title.md:6,2026-10-01.md:6,notes.md:2"},                // a leading # does not matter
		{[]string{"--tag", "家"}, "2026-10-01.md:2,2026-10-01.md:6,2026-10-01.md:12,2026-10-01.md:16"}, // a tag on the whole file reaches every entry
		{[]string{"--tag", "買い物"}, "2026-10-01.md:12"},
		{[]string{"--tag", "家,仕事"}, "2026-10-01.md:6"},             // all of them
		{[]string{"--tag", "家", "--tag", "仕事"}, "2026-10-01.md:6"}, // repeated
		{[]string{"--tag", "仕事, 急ぎ"}, "2026-10-02_title.md:6"},     // the front matter's two tags
		{[]string{"--tag", "仕事", "--tag", "買い物"}, ""},              // no entry has both
		{[]string{"--tag", "存在しない"}, ""},                           // an unused tag is no match, not an error
		{[]string{"--tag", "本物"}, "2026-10-03.md:6"},               // the comment outside the fence
		{[]string{"--tag", "隠れ"}, ""},                              // the comment inside the fence is code
		{[]string{"--tag", "仕事", "--from", "2026-10-01", "--to", "2026-10-02"}, "2026-10-02_title.md:6,2026-10-01.md:6"},
		{[]string{"--tag", "仕事", "--limit", "2"}, "2026-10-02_title.md:6,2026-10-01.md:6"},
	}
	for _, c := range cases {
		res := searchJSON(t, append([]string{"牛乳"}, c.args...)...)
		if got := hitList(res); got != c.want {
			t.Errorf("%v: %s, want %s", c.args, got, c.want)
		}
		if res.Matches == nil {
			t.Errorf("%v: matches must be [] when empty, not null", c.args)
		}
	}
	// the limit counts the lines that stay, and says that more were there
	res := searchJSON(t, "牛乳", "--tag", "仕事", "--limit", "1")
	if res.Count != 1 || !res.Truncated || hitList(res) != "2026-10-02_title.md:6" {
		t.Errorf("--limit 1: %+v", res)
	}
	// the date of a hit is the day the name starts with
	res = searchJSON(t, "牛乳", "--tag", "急ぎ")
	if res.Count != 1 || res.Matches[0].Date != "2026-10-02" {
		t.Errorf("date of 2026-10-02_title.md: %+v", res)
	}
}

func TestScrapSearchRankedWithTags(t *testing.T) {
	tagFixture(t)
	// ranked: one hit per entry; the shopping entry is the only one with 買い物, and it holds both words
	res := rankedJSON(t, "牛乳 shopping", "--tag", "買い物")
	if res.Count != 1 || res.Matches[0].Line != 12 || res.Matches[0].Partial || filepath.Base(res.Matches[0].File) != "2026-10-01.md" {
		t.Fatalf("ranked + tag: %+v", res)
	}
	// the tag of the whole file reaches its four entries; one of them holds both words, so the entries with one word are not listed
	if res = rankedJSON(t, "牛乳 shopping", "--tag", "家"); res.Count != 1 || res.Matches[0].Line != 12 {
		t.Fatalf("ranked + file tag: %+v", res)
	}
	// when no entry holds both words, the entries that hold one of them are listed, as without a tag
	if res = rankedJSON(t, "front shopping", "--tag", "家"); res.Count != 2 || !res.Matches[0].Partial || !res.Matches[1].Partial {
		t.Fatalf("ranked + file tag, partial: %+v", res)
	}
	// ranked and plain agree on which entries a tag keeps
	plain := searchJSON(t, "牛乳", "--tag", "仕事")
	ranked := rankedJSON(t, "牛乳", "--tag", "仕事")
	if plain.Count != 3 || ranked.Count != 3 {
		t.Errorf("plain %d, ranked %d", plain.Count, ranked.Count)
	}
	// the fallback word search of a semantic search that cannot answer honours tags too: see the semantic tests
}

func TestScrapSearchDateRangeUsesTheDayAFileNameStartsWith(t *testing.T) {
	tagFixture(t)
	files := func(args ...string) string {
		var out []string
		seen := map[string]bool{}
		for _, m := range searchJSON(t, append([]string{"牛乳"}, args...)...).Matches {
			if b := filepath.Base(m.File); !seen[b] {
				seen[b] = true
				out = append(out, b)
			}
		}
		return strings.Join(out, ",")
	}
	// 2026-10-02_title.md is a note of 2026-10-02 (it was left out of a range when only YYYY-MM-DD.md counted)
	if got, want := files("--from", "2026-10-02", "--to", "2026-10-02"), "2026-10-02_title.md"; got != want {
		t.Errorf("one day: %s, want %s", got, want)
	}
	if got, want := files("--from", "2026-10-02"), "2026-10-03.md,2026-10-02_title.md"; got != want {
		t.Errorf("--from: %s, want %s", got, want)
	}
	// a note with no day in its name is never in a range
	if got := files("--from", "2000-01-01"); strings.Contains(got, "notes.md") {
		t.Errorf("notes.md has no day: %s", got)
	}
	// order: the notes with a day, newest first (the titled one among them), then the others
	if got, want := files(), "2026-10-03.md,2026-10-02_title.md,2026-10-01.md,notes.md"; got != want {
		t.Errorf("order: %s, want %s", got, want)
	}
}

// No tag is the search that always was: an empty --tag value, or only blanks, turns nothing on, and the result is the same bytes.
func TestScrapSearchWithoutTagsIsByteIdentical(t *testing.T) {
	tagFixture(t)
	for _, p := range []ScrapSearchParams{{Text: "牛乳"}, {Text: "牛乳 shopping", Ranked: true}, {Text: "牛乳", From: "2026-10-01", To: "2026-10-02"}} {
		want, err := ScrapSearch(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		wantJSON, _ := json.Marshal(want)
		for _, tags := range [][]string{nil, {}, {""}, {"  ", ""}} {
			q := p
			q.Tags = tags
			got, err := ScrapSearch(context.Background(), q)
			if err != nil {
				t.Fatalf("%q: %v", tags, err)
			}
			if gotJSON, _ := json.Marshal(got); string(gotJSON) != string(wantJSON) {
				t.Errorf("%+v with tags %q:\n%s\nwant\n%s", p, tags, gotJSON, wantJSON)
			}
		}
	}
	// the same through the command
	a, _, _, _ := runHeadless(t, "scrap", "search", "--json", "牛乳")
	b, _, _, _ := runHeadless(t, "scrap", "search", "--json", "--tag", "", "牛乳")
	if a != b {
		t.Errorf("--tag \"\" changed the output:\n%s\n%s", a, b)
	}
}

func TestScrapSearchTagArgumentsAreChecked(t *testing.T) {
	tagFixture(t)
	nine := "a,b,c,d,e,f,g,h,i"
	for _, c := range []struct {
		tags []string
		want string
	}{
		{[]string{nine}, "too many tags"},
		{[]string{"a,b,c,d", "e,f,g,h", "i"}, "too many tags"},
		{[]string{strings.Repeat("x", 65)}, "longer than 64"},
		{[]string{"#"}, "no tag in"},
	} {
		_, err := ScrapSearch(context.Background(), ScrapSearchParams{Text: "牛乳", Tags: c.tags})
		if err == nil || !IsParamError(err) || !strings.Contains(err.Error(), c.want) || !strings.HasPrefix(err.Error(), "invalid --tag") {
			t.Errorf("%q: %v", c.tags, err)
		}
	}
	// eight are fine, and so is every kind of search with them
	if _, err := ScrapSearch(context.Background(), ScrapSearchParams{Text: "牛乳", Tags: []string{"a,b,c,d,e,f,g,h"}}); err != nil {
		t.Errorf("eight tags: %v", err)
	}
	// through the command: exit 1 with the message, and a flag without a value
	if _, _, code, err := runHeadless(t, "scrap", "search", "牛乳", "--tag", nine); code != 1 || err == nil || !strings.Contains(err.Error(), "too many tags") {
		t.Errorf("nine tags: code %d err %v", code, err)
	}
	if _, _, code, err := runHeadless(t, "scrap", "search", "牛乳", "--tag"); code != 1 || err == nil {
		t.Errorf("--tag without a value: code %d err %v", code, err)
	}
	// unlike --kind, --tag needs no --semantic
	if _, err := ScrapSearch(context.Background(), ScrapSearchParams{Text: "牛乳", Tags: []string{"仕事"}}); err != nil {
		t.Errorf("--tag without --semantic: %v", err)
	}
}

func TestScrapSearchTagTextOutput(t *testing.T) {
	dir := tagFixture(t)
	out, _, code, err := runHeadless(t, "scrap", "search", "--text", "牛乳", "--tag", "買い物")
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	if want := filepath.Join(dir, "2026-10-01.md") + ":12: 牛乳 for shopping\n    under: ## [11:00:00] shop (line 10)\n"; out != want {
		t.Errorf("text = %q, want %q", out, want)
	}
	out, _, _, _ = runHeadless(t, "scrap", "search", "--text", "牛乳", "--tag", "存在しない")
	if !strings.HasPrefix(out, "No matches for ") {
		t.Errorf("no match: %q", out)
	}
}

// ---- scrap tags -----------------------------------------------------------------------------

func TestScrapTagsCountsTheTagsAndTheNotesWithoutADay(t *testing.T) {
	tagFixture(t)
	writeFile(t, filepath.Join(LoadConfig().ScrapDirResolved(), ".hidden", "2026-10-09.md"), "<!-- tags: 隠し -->\n") // a dot folder is never read

	out, _, code, err := runHeadless(t, "scrap", "tags", "--json")
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	var res ScrapTagsResult
	mustJSON(t, out, &res)
	got := map[string][2]int{}
	for _, tc := range res.Tags {
		got[tc.Tag] = [2]int{tc.Files, tc.Entries}
	}
	// 家: the whole of 2026-10-01.md (4 entries). 仕事: its work entry (1), the front matter file (2 entries: the block above the closing
	// rule and the rest), notes.md (1 entry). 急ぎ: the front matter file. 買い物: 1. 本物: the entry of 2026-10-03.md that holds it.
	want := map[string][2]int{"家": {1, 4}, "仕事": {3, 4}, "急ぎ": {1, 2}, "買い物": {1, 1}, "本物": {1, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("tags = %v, want %v", got, want)
	}
	if res.Files != 4 || res.Undated != 1 { // 2026-10-01.md, 2026-10-02_title.md, 2026-10-03.md, notes.md; the dot folder is not read
		t.Errorf("files %d undated %d", res.Files, res.Undated)
	}
	// most files first, then by tag
	if res.Tags[0].Tag != "仕事" || res.Tags[0].Files != 3 {
		t.Errorf("order: %+v", res.Tags)
	}
	for i := 1; i < len(res.Tags); i++ {
		a, b := res.Tags[i-1], res.Tags[i]
		if a.Files < b.Files || (a.Files == b.Files && a.Tag >= b.Tag) {
			t.Errorf("not sorted at %d: %+v %+v", i, a, b)
		}
	}
	// the JSON keys the page and the scripts read
	var raw struct {
		Tags    []map[string]interface{} `json:"tags"`
		Files   *int                     `json:"files"`
		Undated *int                     `json:"undated"`
	}
	mustJSON(t, out, &raw)
	if len(raw.Tags) != 5 || raw.Files == nil || raw.Undated == nil {
		t.Fatalf("JSON shape: %s", out)
	}
	if first := raw.Tags[0]; first["tag"] != "仕事" || first["files"] != float64(3) || first["entries"] != float64(4) || len(first) != 3 {
		t.Errorf("first tag: %v", first)
	}

	text, _, code, err := runHeadless(t, "scrap", "tags", "--text")
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	for _, want := range []string{"5 tags in ", "(4 files read, 1 of them with no day in the name)", "仕事", "3 files", "4 entries"} {
		if !strings.Contains(text, want) {
			t.Errorf("text lacks %q:\n%s", want, text)
		}
	}
}

func TestScrapTagsOnAnEmptyOrMissingFolderIsAnEmptyListAndCreatesNothing(t *testing.T) {
	dir := scrapSandbox(t)
	res, err := ScrapTags(context.Background())
	if err != nil || res.Tags == nil || len(res.Tags) != 0 || res.Files != 0 || res.Undated != 0 {
		t.Errorf("missing folder: %+v %v", res, err)
	}
	out, _, code, err := runHeadless(t, "scrap", "tags", "--json")
	var shape map[string]interface{}
	mustJSON(t, out, &shape)
	if tags, ok := shape["tags"].([]interface{}); err != nil || code != 0 || !ok || len(tags) != 0 || shape["files"] != float64(0) || shape["undated"] != float64(0) {
		t.Errorf("JSON: code %d err %v out %q (tags must be [], not null)", code, err, out)
	}
	if exists(dir) {
		t.Error("scrap tags created the scrap folder")
	}
	writeFile(t, filepath.Join(dir, "2026-10-01.md"), "no tags here\n")
	out, _, _, _ = runHeadless(t, "scrap", "tags", "--text")
	if !strings.HasPrefix(out, "No tags in ") || !strings.Contains(out, "(1 files)") || !strings.Contains(out, "<!-- tags: work, urgent -->") {
		t.Errorf("text for none: %q", out)
	}
	if _, _, code, err := runHeadless(t, "scrap", "tags", "extra"); code != 1 || err == nil {
		t.Errorf("scrap tags takes no arguments: code %d err %v", code, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ScrapTags(ctx); err == nil {
		t.Error("a cancelled listing must say so")
	}
}

// ---- the window's filter -----------------------------------------------------------------------

func TestParseScrapFilter(t *testing.T) {
	for _, none := range []string{"", "  ", "null", "{}", `{"tags":[],"from":"","to":""}`, `{"tags":null}`, `{"tags":[""," "]}`} {
		f, err := ParseScrapFilter(none)
		if err != nil || !f.Empty() {
			t.Errorf("%q: %+v %v", none, f, err)
		}
	}
	f, err := ParseScrapFilter(`{"tags":["#仕事"," Ｗｏｒｋ","仕事"],"from":"2026-10-01","to":"2026-10-03","other":1}`)
	if err != nil || !reflect.DeepEqual(f, ScrapFilter{Tags: []string{"仕事", "work"}, From: "2026-10-01", To: "2026-10-03"}) || f.Empty() {
		t.Errorf("a filter: %+v %v", f, err)
	}
	for _, c := range []struct{ in, want string }{
		{`{"tags":["a","b","c","d","e","f","g","h","i"]}`, "invalid tag filter: too many tags"},
		{`{"tags":["` + strings.Repeat("x", 65) + `"]}`, "longer than 64"},
		{`{"from":"2026-1-1"}`, "invalid date"},
		{`{"to":"20261001"}`, "invalid date"},
		{`{"from":"2026-10-03","to":"2026-10-01"}`, "is after"},
		{`{"tags":"仕事"}`, "the filter is not valid"},
		{`{"tags":`, "the filter is not valid"},
		{`[1]`, "the filter is not valid"},
	} {
		_, err := ParseScrapFilter(c.in)
		if err == nil || !IsParamError(err) || !strings.Contains(err.Error(), c.want) || strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: %v, want a one-line ParamError with %q", c.in, err, c.want)
		}
	}
}

func TestScrapFilterSearchOptionsTestTheDayOfTheFileName(t *testing.T) {
	f, _ := ParseScrapFilter(`{"from":"2026-10-02","to":"2026-10-02","tags":["仕事"]}`)
	opts := f.SearchOptions()
	if !reflect.DeepEqual(opts.Tags, []string{"仕事"}) || opts.Keep == nil || opts.Less != nil || opts.Headings {
		t.Fatalf("%+v", opts)
	}
	for path, want := range map[string]bool{
		filepath.Join("x", "2026-10-02.md"): true, filepath.Join("x", "2026-10-02_title.md"): true,
		filepath.Join("x", "2026-10-01.md"): false, filepath.Join("x", "2026-10-03.md"): false, filepath.Join("x", "notes.md"): false,
	} {
		if got := opts.Keep(path); got != want {
			t.Errorf("Keep(%s) = %v", path, got)
		}
	}
	if only := (ScrapFilter{Tags: []string{"a"}}).SearchOptions(); only.Keep != nil {
		t.Error("no days: no file test")
	}
}

// The semantic search asks the tag test once per chunk; a file is read once for all of its chunks.
func TestSemanticTagKeepReadsAFileOnce(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "sub", "a.md"), "# one\n<!-- tags: x -->\ntext\n\n# two\ntext\n")
	keep := semanticTagKeep(dir, []string{"x"})
	if semanticTagKeep(dir, nil) != nil {
		t.Fatal("no tags: nothing to ask")
	}
	if !keep("sub/a.md", 1) || !keep("sub/a.md", 3) || keep("sub/a.md", 5) || keep("sub/a.md", 99) {
		t.Error("lines 1-4 are the first entry, 5-6 the second")
	}
	if err := os.Remove(filepath.Join(dir, "sub", "a.md")); err != nil {
		t.Fatal(err)
	}
	if !keep("sub/a.md", 2) { // answered from what was read the first time
		t.Error("the file must be read once")
	}
	if keep("gone.md", 1) || keep("gone.md", 1) {
		t.Error("a file that cannot be read keeps nothing")
	}
}

// ---- semantic search and its word-search fallback ----------------------------------------------

func seedTaggedScraps(t *testing.T, dir string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, "2026-09-01.md"),
		"# 2026-09-01 09:00\n<!-- tags: 建材 -->\n竹は成長が早く、三年ほどで伐採できる。建材として使えば環境への負荷が小さい。\n\n# 2026-09-01 15:30\n<!-- tags: 開発 -->\nRust の借用チェッカーに怒られた。ライフタイムの書き方を調べる。\n")
	writeFile(t, filepath.Join(dir, "2026-09-02.md"),
		"<!-- tags: 日記 -->\n# 2026-09-02 10:00\n夕食はカレーにした。スパイスから煮込むと香りが全然違う。\n\n# 2026-09-02 11:00\n竹の伐採の件。業者に連絡した。\n")
	writeFile(t, filepath.Join(dir, "2026-09-03.md"), "# 2026-09-03 08:00\n会議の議事録。竹の見積もりを出す。担当は佐藤さん。\n")
}

func TestSemanticSearchWithTagsKeepsTheChunksOfTheTaggedEntries(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedTaggedScraps(t, dir)
	buildIndex(t)

	q := "竹の伐採"
	all := semSearch(t, q, "--limit", "50")
	files := func(r semOut) string {
		var out []string
		seen := map[string]bool{}
		for _, m := range r.Matches {
			if !seen[m.Rel] {
				seen[m.Rel] = true
				out = append(out, m.Rel)
			}
		}
		return strings.Join(out, ",")
	}
	if len(all.Matches) < 5 {
		t.Fatalf("expected one hit per entry: %v", rels(all))
	}
	// one entry
	r := semSearch(t, q, "--tag", "建材", "--limit", "50")
	if r.Count != 1 || r.Matches[0].Rel != "2026-09-01.md" || !strings.Contains(r.Matches[0].Text, "竹は成長が早く") || !r.Semantic {
		t.Errorf("建材: %+v", r)
	}
	// the tag above the first heading of 2026-09-02.md belongs to both of its entries
	r = semSearch(t, q, "--tag", "日記", "--limit", "50")
	if r.Count != 2 || files(r) != "2026-09-02.md" {
		t.Errorf("日記: %v", rels(r))
	}
	// all of them, in any order; an entry that has only one of them is out
	r = semSearch(t, q, "--tag", "日記,建材", "--limit", "50")
	if r.Count != 0 || r.Matches == nil {
		t.Errorf("日記+建材: %+v", r)
	}
	// the day range works with it
	if r = semSearch(t, q, "--tag", "建材", "--from", "2026-09-02", "--limit", "50"); r.Count != 0 {
		t.Errorf("建材 from the 2nd: %v", rels(r))
	}
	if r = semSearch(t, q, "--tag", "日記", "--to", "2026-09-02", "--limit", "50"); r.Count != 2 {
		t.Errorf("日記 to the 2nd: %v", rels(r))
	}
	// a tag nobody uses: no match, no error
	if r = semSearch(t, q, "--tag", "存在しない"); r.Count != 0 || !r.Semantic {
		t.Errorf("an unused tag: %+v", r)
	}
	// without a tag the answer is what it was
	if again := semSearch(t, q, "--limit", "50"); !reflect.DeepEqual(rels(again), rels(all)) {
		t.Errorf("no tag: %v vs %v", rels(again), rels(all))
	}
}

func TestSemanticSearchWithTagsFiltersTheNotesTheIndexDoesNotHoldYet(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedTaggedScraps(t, dir)
	buildIndex(t)
	// written after the index was made: found by words, and only when the tag is there
	writeFile(t, filepath.Join(dir, "2026-09-10.md"),
		"# 2026-09-10 09:00\n<!-- tags: 建材 -->\n新しく書いた、竹の建材の話。\n\n# 2026-09-10 10:00\n<!-- tags: 日記 -->\n新しく書いた、竹の日記の話。\n")

	r := semSearch(t, "新しく書いた竹", "--tag", "建材", "--limit", "50")
	var fromWords []semHit
	for _, m := range r.Matches {
		if m.Source == "words" {
			fromWords = append(fromWords, m)
		}
	}
	if r.Pending != 1 || len(fromWords) != 1 || fromWords[0].Rel != "2026-09-10.md" || !strings.Contains(fromWords[0].Text, "建材の話") {
		t.Fatalf("the new note's 建材 entry must be found by words, and its 日記 entry not: %+v", r.Matches)
	}
	for _, m := range r.Matches {
		if strings.Contains(m.Text, "日記の話") || m.Rel == "2026-09-02.md" {
			t.Errorf("outside the filter: %+v", m)
		}
	}
	if r = semSearch(t, "新しく書いた竹", "--tag", "存在しない", "--limit", "50"); r.Count != 0 {
		t.Errorf("an unused tag: %v", rels(r))
	}
}

func TestSemanticSearchThatFallsBackToWordsKeepsTheTags(t *testing.T) {
	// the model is gone after the index was made: the ranked word search answers, and it is narrowed as well
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedTaggedScraps(t, dir)
	buildIndex(t)
	srv.Close()

	r := semSearch(t, "竹", "--tag", "建材", "--limit", "50")
	if r.Semantic || !r.Ranked || r.Count != 1 || r.Matches[0].Rel != "2026-09-01.md" || r.Matches[0].Source != "words" {
		t.Fatalf("fallback: %+v", r)
	}
	// the tag above the first heading of 2026-09-02.md reaches its entry that holds the word
	r = semSearch(t, "竹", "--tag", "日記", "--limit", "50")
	if r.Count != 1 || r.Matches[0].Rel != "2026-09-02.md" || !strings.Contains(r.Matches[0].Text, "竹の伐採") {
		t.Errorf("日記: %v", rels(r))
	}
	// the word is in three notes; with no tag all of them
	if r = semSearch(t, "竹", "--limit", "50"); r.Count != 3 {
		t.Errorf("without a tag: %v", rels(r))
	}
	if r = semSearch(t, "竹", "--tag", "存在しない", "--limit", "50"); r.Count != 0 {
		t.Errorf("an unused tag: %v", rels(r))
	}
}

func rels(r semOut) []string {
	var out []string
	for _, m := range r.Matches {
		out = append(out, m.Rel+":"+strconv.Itoa(m.Line))
	}
	return out
}
