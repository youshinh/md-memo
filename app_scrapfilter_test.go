package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/cli"
	"md-memo/pkg/ipc"
	"md-memo/pkg/search"
)

// The window's filter row (docs/design/tag-filter-2026-10.md): tags and days narrow the exact, the meaning and the deep search, and the
// tags in use are listed for the row. The Go side only: the page is tested on its own.

// filterNotes writes the notes these tests search into dir:
//
//	2026-09-01.md          three entries; the first and the last are tagged 仕事, the one between them is not (and is short, so the
//	                       first one would bring it as its neighbour into a deep search)
//	2026-09-02_title.md    tagged 仕事 as a whole (front matter); its name starts with a day
//	2026-08-31.md          tagged 仕事, a day earlier
//	notes.md               no day in the name; tagged 仕事
func filterNotes(t *testing.T, dir string) {
	t.Helper()
	w := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	w("2026-09-01.md", "# 2026-09-01 09:00\n<!-- tags: 仕事 -->\n竹の伐採の打ち合わせ。\n\n# 2026-09-01 10:00\n竹の別件。UNTAGGED-NEIGHBOUR-SECRET\n\n# 2026-09-01 11:00\n<!-- tags: 仕事 -->\n竹の追加の件。\n")
	w("2026-09-02_title.md", "---\ntags: [仕事]\n---\n# 2026-09-02\n竹の伐採の続き。\n")
	w("2026-08-31.md", "# 2026-08-31 09:00\n<!-- tags: 仕事 -->\n竹の伐採の前日の話。\n")
	w("notes.md", "<!-- tags: 仕事 -->\n竹の伐採のメモ。日付のない名前。\n")
}

const filterSecret = "UNTAGGED-NEIGHBOUR-SECRET"

// searchAnswer is the result the page got for reqID from the exact search, and the error text.
func searchAnswer(t *testing.T, mock *asyncMockWebView, reqID string) ([]search.SearchResult, string) {
	t.Helper()
	prefix := `__onSearchScrapsResult("` + reqID + `", `
	e := mock.waitFor(t, prefix, 10*time.Second)
	rest := strings.TrimSuffix(e[strings.Index(e, prefix)+len(prefix):], "); }")
	cut := strings.LastIndex(rest, ", ")
	var res []search.SearchResult
	if err := json.Unmarshal([]byte(rest[:cut]), &res); err != nil {
		t.Fatalf("result of %s is not a list of results: %v: %s", reqID, err, rest)
	}
	var msg string
	_ = json.Unmarshal([]byte(rest[cut+2:]), &msg)
	return res, msg
}

func filesOf(rs []search.SearchResult) string {
	var out []string
	for _, r := range rs {
		out = append(out, r.FileName)
	}
	return strings.Join(out, ",")
}

func matchCount(rs []search.SearchResult) int {
	n := 0
	for _, r := range rs {
		n += len(r.Matches)
	}
	return n
}

func TestSearchScrapsAsyncWithAFilter(t *testing.T) {
	dir := scrapConfig(t, nil)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	filterNotes(t, dir)
	mock := &asyncMockWebView{}
	app := &App{w: mock, scrapDir: dir}

	n := 0
	ask := func(query, filter string) ([]search.SearchResult, string) {
		n++
		id := "f" + string(rune('a'+n))
		app.SearchScrapsAsync(id, query, 100, filter)
		return searchAnswer(t, mock, id)
	}
	// no filter: the search that always ran, byte for byte, whatever way "none" is written
	all, msg := ask("竹", "")
	want, _ := app.SearchScraps("竹", 100)
	wantJSON, _ := json.Marshal(want)
	if gotJSON, _ := json.Marshal(all); msg != "" || string(gotJSON) != string(wantJSON) || matchCount(all) != 6 {
		t.Errorf("no filter must be the search that always ran:\n%s\n%s (%q)", gotJSON, wantJSON, msg)
	}
	for _, none := range []string{"null", "{}", `{"tags":[],"from":"","to":""}`} {
		if res, msg := ask("竹", none); msg != "" || !reflect.DeepEqual(res, all) {
			t.Errorf("%s: %s (%q)", none, filesOf(res), msg)
		}
	}

	// tags: the entries that have them. The untagged entry of 2026-09-01.md is not a hit.
	res, msg := ask("竹", `{"tags":["仕事"]}`)
	if msg != "" || matchCount(res) != 5 { // 2026-09-01.md's two tagged entries, and one in each of the other three notes
		t.Fatalf("tag filter: %s %d (%q)", filesOf(res), matchCount(res), msg)
	}
	if b, _ := json.Marshal(res); strings.Contains(string(b), "別件") {
		t.Errorf("a line of the untagged entry is a hit: %s", b)
	}
	// the shape is the exact search's: no heading, no score
	if b, _ := json.Marshal(res[0]); strings.Contains(string(b), `"heading"`) || strings.Contains(string(b), `"score"`) {
		t.Errorf("the exact search's JSON gained fields: %s", b)
	}
	// days: the name starts with a day in the range; a note with no day is never in a range
	if res, msg := ask("竹", `{"from":"2026-09-01","to":"2026-09-02"}`); msg != "" || filesOf(res) != "2026-09-02_title.md,2026-09-01.md" {
		t.Errorf("days: %s (%q)", filesOf(res), msg)
	}
	// both
	if res, msg := ask("竹", `{"tags":["仕事"],"from":"2026-09-02"}`); msg != "" || filesOf(res) != "2026-09-02_title.md" {
		t.Errorf("tags and days: %s (%q)", filesOf(res), msg)
	}
	// nothing matches: an empty list, not an error
	if res, msg := ask("竹", `{"tags":["存在しない"]}`); msg != "" || len(res) != 0 {
		t.Errorf("an unused tag: %s (%q)", filesOf(res), msg)
	}
	// no line holds the whole text, so the ranked search answers (its matches carry a score), narrowed in the same way
	res, msg = ask("竹 打ち合わせ 前日", `{"tags":["仕事"],"to":"2026-09-01"}`)
	if msg != "" || len(res) != 2 || res[0].Matches[0].Score <= 0 || strings.Contains(filesOf(res), "notes.md") || strings.Contains(filesOf(res), "title") {
		t.Errorf("ranked fallback: %s (%q) %+v", filesOf(res), msg, res)
	}

	// a filter that is not valid fails the search with one line, and finds nothing
	for _, filter := range []string{
		`{"tags":["a","b","c","d","e","f","g","h","i"]}`, `{"from":"2026-9-1"}`, `{"tags":"仕事"}`, `{"from":"2026-09-03","to":"2026-09-01"}`, `not json`,
	} {
		res, msg := ask("竹", filter)
		if msg == "" || strings.Contains(msg, "\n") || len(res) != 0 {
			t.Errorf("%s: %q, %d results", filter, msg, len(res))
		}
	}
}

func TestSemanticSearchAndTheDeepPlanKeepToTheFilter(t *testing.T) {
	srv := newDeepFakeServer(t)
	app, dir, mock := deepSandbox(t, srv.URL+"/v1", srv.URL, nil)
	for _, name := range []string{"2026-09-01.md", "2026-09-02.md", "2026-09-03.md"} {
		_ = os.Remove(filepath.Join(dir, name))
	}
	filterNotes(t, dir)
	buildDeepIndex(t)

	files := func(m map[string]interface{}) string {
		var out []string
		for _, r := range m["results"].([]interface{}) {
			out = append(out, r.(map[string]interface{})["fileName"].(string))
		}
		return strings.Join(out, ",")
	}
	// the meaning search finds the untagged entry when nothing narrows it, and not when a tag does
	app.SearchScrapsSemanticAsync("s0", "竹の別件 "+filterSecret, 30, "")
	res, msg := resultOf(t, mock, "s0")
	if msg != "" || res["semantic"] != true || !strings.Contains(mustMarshal(res), filterSecret) {
		t.Fatalf("without a filter (this test would prove nothing): %v (%q)", res, msg)
	}
	app.SearchScrapsSemanticAsync("s1", "竹の別件 "+filterSecret, 30, `{"tags":["仕事"]}`)
	res, msg = resultOf(t, mock, "s1")
	if msg != "" || res["semantic"] != true || strings.Contains(mustMarshal(res), filterSecret) || files(res) == "" {
		t.Errorf("semantic with a tag: %v (%q)", files(res), msg)
	}
	app.SearchScrapsSemanticAsync("s2", "竹の伐採の続き", 30, `{"tags":["仕事"],"from":"2026-09-02"}`)
	res, _ = resultOf(t, mock, "s2")
	if got := files(res); got != "2026-09-02_title.md" {
		t.Errorf("semantic with a tag and a day: %s", got)
	}
	app.SearchScrapsSemanticAsync("s3", "竹の伐採", 30, `{"tags":["存在しない"]}`)
	if res, msg := resultOf(t, mock, "s3"); msg != "" || len(res["results"].([]interface{})) != 0 {
		t.Errorf("an unused tag: %v (%q)", res, msg)
	}
	app.SearchScrapsSemanticAsync("s4", "竹", 30, `{"tags":["a","b","c","d","e","f","g","h","i"]}`)
	if _, msg := resultOf(t, mock, "s4"); !strings.Contains(msg, "too many tags") || strings.Contains(msg, "\n") {
		t.Errorf("a bad filter: %q", msg)
	}

	// The deep search plan gathers its excerpts under the same filter, the neighbours a short entry brings included: a note outside the
	// filter is never planned for sending.
	unfiltered, err := app.buildDeepPlan(context.Background(), "竹の伐採の打ち合わせ", 10, cli.ScrapFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !planHolds(unfiltered.PlanID, filterSecret) {
		t.Fatalf("without a filter the short entry brings its neighbour (this test would prove nothing): %+v", unfiltered)
	}
	app.DeepSearchPlanAsync("d1", "竹の伐採の打ち合わせ", 10, `{"tags":["仕事"]}`)
	plan, msg := resultOf(t, mock, "d1")
	id, _ := plan["plan_id"].(string)
	if msg != "" || id == "" {
		t.Fatalf("plan: %v (%q)", plan, msg)
	}
	if planHolds(id, filterSecret) || planHolds(id, "別件") {
		t.Errorf("an entry outside the filter is planned for sending")
	}
	if !planHolds(id, "竹の伐採の打ち合わせ") {
		t.Errorf("the tagged entry must be a source")
	}
	// the days of the filter
	app.DeepSearchPlanAsync("d2", "竹の伐採", 10, `{"tags":["仕事"],"from":"2026-09-02","to":"2026-09-02"}`)
	plan, _ = resultOf(t, mock, "d2")
	srcs := plan["sources"].([]interface{})
	if len(srcs) != 1 || srcs[0].(map[string]interface{})["rel"] != "2026-09-02_title.md" {
		t.Errorf("sources of one day: %v", srcs)
	}
	// a tag that nothing has plans nothing
	app.DeepSearchPlanAsync("d3", "竹の伐採", 10, `{"tags":["存在しない"]}`)
	plan, msg = resultOf(t, mock, "d3")
	if msg != "" || plan["plan_id"] != "" || len(plan["sources"].([]interface{})) != 0 {
		t.Errorf("an unused tag: %v (%q)", plan, msg)
	}
	// a filter that is not valid fails the plan with a sentence
	app.DeepSearchPlanAsync("d4", "竹", 10, `{"from":"nope"}`)
	if _, msg := resultOf(t, mock, "d4"); !strings.Contains(msg, "invalid date") || strings.Contains(msg, "\n") {
		t.Errorf("a bad filter: %q", msg)
	}
	// the RPC dry run has no filter and plans the whole folder
	got := rpcOK(t, rpcDo(app, "deepsearch.plan", map[string]interface{}{"query": "竹の伐採の打ち合わせ"}))
	if len(got["sources"].([]interface{})) == 0 {
		t.Errorf("the dry run: %v", got)
	}
}

func mustMarshal(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// planHolds reports whether a kept plan has a source with s in its text.
func planHolds(planID, s string) bool {
	p := deepPlans.get(planID, time.Now())
	if p == nil {
		return false
	}
	for _, src := range p.sources {
		if strings.Contains(src.Text, s) {
			return true
		}
	}
	return false
}

func TestScrapFilterOptionsAsyncListsTheTagsForTheRow(t *testing.T) {
	dir := scrapConfig(t, nil)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mock := &asyncMockWebView{}
	app := &App{w: mock, scrapDir: dir}

	// no notes at all: an empty list (never null)
	app.ScrapFilterOptionsAsync("o0")
	e := mock.waitFor(t, `__onDeepSearchResult("o0"`, 5*time.Second)
	if !strings.HasPrefix(e, "if (window.__onDeepSearchResult)") || !strings.Contains(e, `{"tags":[],"files":0,"undated":0}, ""); }`) {
		t.Errorf("empty folder: %s", e)
	}

	filterNotes(t, dir)
	app.ScrapFilterOptionsAsync("o1")
	res, msg := resultOf(t, mock, "o1")
	if msg != "" {
		t.Fatal(msg)
	}
	if res["files"] != float64(4) || res["undated"] != float64(1) {
		t.Errorf("counts: %v", res)
	}
	tags := res["tags"].([]interface{})
	if len(tags) != 1 {
		t.Fatalf("tags: %v", tags)
	}
	// 仕事 is in all four notes; its entries: 2 of 2026-09-01.md, both of the front matter file's, the one of 2026-08-31.md and of notes.md
	if tc := tags[0].(map[string]interface{}); tc["tag"] != "仕事" || tc["files"] != float64(4) || tc["entries"] != float64(6) || len(tc) != 3 {
		t.Errorf("the tag: %v", tc)
	}
}

func TestRPCScrapSearchTagAndScrapTags(t *testing.T) {
	dir := scrapConfig(t, nil)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	filterNotes(t, dir)
	app := &App{}

	count := func(params map[string]interface{}) int {
		params["text"] = "竹"
		return num(rpcOK(t, rpcDo(app, "scrap.search", params)), "count")
	}
	if all := count(map[string]interface{}{}); all != 6 { // 3 entries of 2026-09-01.md and one line in each of the other three
		t.Fatalf("no tag: %d", all)
	}
	// a string "a,b", a list, and the one-element forms are the same filter
	for _, tag := range []interface{}{"仕事", []string{"仕事"}, "#仕事", " 仕事 , ", []string{"仕事", "仕事"}} {
		if n := count(map[string]interface{}{"tag": tag}); n != 5 {
			t.Errorf("tag %v: %d hits, want 5", tag, n)
		}
	}
	if n := count(map[string]interface{}{"tag": "仕事,存在しない"}); n != 0 {
		t.Errorf("all of the tags: %d", n)
	}
	if n := count(map[string]interface{}{"tag": nil}); n != 6 {
		t.Errorf("null tag: %d", n)
	}
	if n := count(map[string]interface{}{"tag": "仕事", "from": "2026-09-02"}); n != 1 {
		t.Errorf("tag and from: %d", n)
	}
	// the ranked search answers like the function the command uses
	r := rpcOK(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹 打ち合わせ", "ranked": true, "tag": []string{"仕事"}}))
	cres, err := cli.ScrapSearch(context.Background(), cli.ScrapSearchParams{Text: "竹 打ち合わせ", Ranked: true, Tags: []string{"仕事"}})
	if err != nil || num(r, "count") != cres.Count || cres.Count == 0 {
		t.Errorf("RPC %v, CLI %+v %v", r, cres, err)
	}
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹", "tag": 3}), ipc.ErrCodeInvalidParams, "tag must be a string or a list of strings")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹", "tag": map[string]int{"a": 1}}), ipc.ErrCodeInvalidParams, "tag must be")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹", "tag": "a,b,c,d,e,f,g,h,i"}), ipc.ErrCodeInvalidParams, "too many tags")
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹", "tag": []string{strings.Repeat("x", 70)}}), ipc.ErrCodeInvalidParams, "longer than 64")
	// the semantic search is off here: a tag does not make it an error of its own
	rpcErr(t, rpcDo(app, "scrap.search", map[string]interface{}{"text": "竹", "semantic": true, "tag": "仕事"}), ipc.ErrCodeInvalidParams, "semantic search is off")

	// scrap.tags: the same answer as the command, with no parameters
	tags := rpcOK(t, rpcDo(app, "scrap.tags", nil))
	want, err := cli.ScrapTags(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var wantMap map[string]interface{}
	wantJSON, _ := json.Marshal(want)
	_ = json.Unmarshal(wantJSON, &wantMap)
	if !reflect.DeepEqual(tags, wantMap) || num(tags, "files") != 4 || num(tags, "undated") != 1 {
		t.Errorf("scrap.tags\n%v\nwant\n%v", tags, wantMap)
	}
	list, ok := tags["tags"].([]interface{})
	if !ok || len(list) != 1 || list[0].(map[string]interface{})["tag"] != "仕事" {
		t.Errorf("tags: %v", tags["tags"])
	}
	// it needs the token like every method that is not one of the three old reads
	if ipc.IsReadOnlyMethod("scrap.tags") {
		t.Error("scrap.tags must need the session token")
	}

	// no notes at all: [] and zeros (and the walk creates nothing)
	missing := scrapConfig(t, nil)
	none := rpcOK(t, rpcDo(app, "scrap.tags", map[string]interface{}{}))
	if l, ok := none["tags"].([]interface{}); !ok || len(l) != 0 || num(none, "files") != 0 || num(none, "undated") != 0 {
		t.Errorf("a folder that does not exist: %v", none)
	}
	if _, err := os.Stat(missing); err == nil {
		t.Error("scrap.tags created the scrap folder")
	}
}
