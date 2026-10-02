package cli

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"unicode"

	"md-memo/pkg/semindex"
)

// fakeOllama is a loopback server that answers Ollama's /api/embed with hashed character-pair vectors, and counts what it is asked.
// It is the only "model" these tests talk to; nothing leaves the machine.
type fakeOllama struct {
	*httptest.Server
	requests int32
	texts    int32
}

func newFakeOllama(t *testing.T) *fakeOllama {
	t.Helper()
	f := &fakeOllama{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The base URL of these tests is a loopback address on a port that is not Ollama's, which the command reads as an
		// OpenAI-compatible server (/v1/embeddings); Ollama's own route is served too.
		if (r.URL.Path != "/api/embed" && r.URL.Path != "/v1/embeddings") || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var req struct {
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		atomic.AddInt32(&f.requests, 1)
		atomic.AddInt32(&f.texts, int32(len(req.Input)))
		out := make([][]float32, len(req.Input))
		data := make([]map[string]interface{}, len(req.Input))
		for i, s := range req.Input {
			out[i] = pairVector(s, 64)
			data[i] = map[string]interface{}{"index": i, "embedding": out[i]}
		}
		if r.URL.Path == "/v1/embeddings" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"data": data})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"embeddings": out})
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeOllama) reqs() int { return int(atomic.LoadInt32(&f.requests)) }
func (f *fakeOllama) sent() int { return int(atomic.LoadInt32(&f.texts)) }

func pairVector(text string, dim int) []float32 {
	rs := []rune(strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, text))
	v := make([]float32, dim)
	for i := 0; i+1 < len(rs); i++ {
		h := fnv.New32a()
		_, _ = h.Write([]byte(string(rs[i : i+2])))
		v[h.Sum32()%uint32(dim)]++
	}
	var n float64
	for _, x := range v {
		n += float64(x * x)
	}
	if n == 0 {
		v[0] = 1
		return v
	}
	n = math.Sqrt(n)
	for i := range v {
		v[i] = float32(float64(v[i]) / n)
	}
	return v
}

// semanticSandbox is a scrap folder and a config.json with the semantic section given.
func semanticSandbox(t *testing.T, sem map[string]interface{}) (scrapDir string) {
	t.Helper()
	t.Setenv(semindex.EnvAPIKey, "")
	scrapDir = scrapSandbox(t)
	cfg := map[string]interface{}{"scraps": map[string]string{"scrapDir": scrapDir}}
	if sem != nil {
		cfg["semantic"] = sem
	}
	b, _ := json.Marshal(cfg)
	writeConfigFile(t, string(b))
	return scrapDir
}

func localModel(base string) map[string]interface{} {
	return map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": base, "model": "bge-m3"}}
}

func seedScraps(t *testing.T, dir string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, "2026-09-01.md"),
		"# 2026-09-01 09:00\n\n竹は成長が早く、三年ほどで伐採できる。建材として使えば環境への負荷が小さい。\n\n# 2026-09-01 15:30\n\nRust の借用チェッカーに怒られた。ライフタイムの書き方を調べる。\n")
	writeFile(t, filepath.Join(dir, "2026-09-02.md"),
		"# 2026-09-02 10:00\n\n夕食はカレーにした。スパイスから煮込むと香りが全然違う。\n\n---\n## [10:05:00] ping\n```text\n128.1.33.254 からの応答: 時間 =5ms\n```\n")
	writeFile(t, filepath.Join(dir, "2026-09-03.md"),
		"# 2026-09-03 08:00\n\n会議の議事録。次回までに見積もりを出す。担当は佐藤さん。\n")
}

type semHit struct {
	Rel     string  `json:"rel"`
	URL     string  `json:"url"`
	Label   string  `json:"label"`
	Link    string  `json:"link"`
	File    string  `json:"file"`
	Date    string  `json:"date"`
	Line    int     `json:"line"`
	EndLine int     `json:"end_line"`
	Text    string  `json:"text"`
	Heading string  `json:"heading"`
	Score   float64 `json:"score"`
	Cosine  float64 `json:"cosine"`
	Kind    string  `json:"kind"`
	Context string  `json:"context"`
	Source  string  `json:"source"`
}

type semOut struct {
	Query     string   `json:"query"`
	Ranked    bool     `json:"ranked"`
	Semantic  bool     `json:"semantic"`
	Count     int      `json:"count"`
	Truncated bool     `json:"truncated"`
	Pending   int      `json:"pending"`
	LeftOut   int      `json:"left_out"`
	Notes     []string `json:"notes"`
	Matches   []semHit `json:"matches"`
}

func semSearch(t *testing.T, args ...string) semOut {
	t.Helper()
	// These tests are about what the search finds, not about the default cut-off of the notes far below the best one: it is off unless
	// a test says --cutoff itself (TestSemanticSearchShowsTenAndLeavesOutTheNotesFarBelowTheBest is about it).
	hasCutoff := false
	for _, a := range args {
		hasCutoff = hasCutoff || a == "--cutoff"
	}
	if !hasCutoff {
		args = append([]string{"--cutoff", "0"}, args...)
	}
	out, errOut, code, err := runHeadless(t, append([]string{"scrap", "search", "--json", "--semantic"}, args...)...)
	if err != nil || code != 0 {
		t.Fatalf("%v: code %d err %v stderr %q", args, code, err, errOut)
	}
	var res semOut
	mustJSON(t, out, &res)
	return res
}

func buildIndex(t *testing.T, args ...string) map[string]interface{} {
	t.Helper()
	out, errOut, code, err := runHeadless(t, append([]string{"scrap", "index", "--json"}, args...)...)
	if err != nil || code != 0 {
		t.Fatalf("scrap index %v: code %d err %v stderr %q", args, code, err, errOut)
	}
	var res map[string]interface{}
	mustJSON(t, out, &res)
	return res
}

func num(m map[string]interface{}, k string) int { f, _ := m[k].(float64); return int(f) }

func TestSemanticCommandsAreOffUnlessEnabled(t *testing.T) {
	semanticSandbox(t, nil)
	for _, args := range [][]string{{"scrap", "index"}, {"scrap", "search", "--semantic", "竹"}} {
		_, _, code, err := runHeadless(t, args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), "semantic search is off") {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	// a model without "enabled" is still off
	semanticSandbox(t, map[string]interface{}{"model": map[string]interface{}{"model": "bge-m3"}})
	if _, _, code, err := runHeadless(t, "scrap", "index"); code != 1 || err == nil || !strings.Contains(err.Error(), "off") {
		t.Errorf("not enabled: code %d err %v", code, err)
	}
	// but --status still tells what is what
	out, _, code, err := runHeadless(t, "scrap", "index", "--status", "--text")
	if err != nil || code != 0 || !strings.Contains(out, "semantic search: off") || !strings.Contains(out, "not built yet") {
		t.Errorf("status: %q %v", out, err)
	}
}

func TestScrapIndexThenSemanticSearch(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)

	first := buildIndex(t)
	if num(first, "files") != 3 || num(first, "chunks") == 0 || num(first, "embedded") != num(first, "chunks_new") || first["local"] != true {
		t.Fatalf("first run: %v", first)
	}
	if srv.sent() != num(first, "embedded") || !strings.HasPrefix(first["model"].(string), "openai|bge-m3|") {
		t.Errorf("the server saw %d texts; result %v", srv.sent(), first)
	}
	if idx := first["index_dir"].(string); strings.HasPrefix(idx, dir) {
		t.Errorf("the index is inside the scrap folder: %s", idx)
	}
	// nothing inside the scrap folder was written
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Errorf("scrap folder holds %d entries, want its 3 notes", len(entries))
	}

	sentBefore := srv.sent()
	again := buildIndex(t)
	if num(again, "files_changed") != 0 || num(again, "embedded") != 0 || srv.sent() != sentBefore {
		t.Errorf("a second run must cost nothing: %v (server saw %d texts, was %d)", again, srv.sent(), sentBefore)
	}

	res := semSearch(t, "竹の伐採と建材")
	if !res.Semantic || res.Ranked || res.Count == 0 || res.Pending != 0 || len(res.Notes) != 0 {
		t.Fatalf("result = %+v", res)
	}
	m := res.Matches[0]
	if filepath.Base(m.File) != "2026-09-01.md" || filepath.Dir(m.File) != dir || m.Date != "2026-09-01" || m.Line != 3 || m.Kind != "note" ||
		m.Source != "semantic" || m.Score <= 0 || m.Cosine <= 0 || !strings.Contains(m.Text, "竹") || !strings.Contains(m.Context, "竹") {
		t.Errorf("match = %+v", m)
	}
	if m.Heading != "2026-09-01 09:00" {
		t.Errorf("heading = %q", m.Heading)
	}
	// how to cite it: the file's URL (the semantic search's heading already starts with the day, so it is the label)
	if m.Rel != "2026-09-01.md" || m.URL != FileURL(m.File) || m.Label != "2026-09-01 09:00" || m.Link != "[2026-09-01 09:00]("+m.URL+")" {
		t.Errorf("link fields = %q %q %q %q", m.Rel, m.URL, m.Label, m.Link)
	}
}

func TestSemanticSearchTextOutput(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	buildIndex(t)
	out, _, code, err := runHeadless(t, "scrap", "search", "--text", "--semantic", "竹の伐採と建材")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	for _, want := range []string{"2026-09-01.md:3: 竹は成長が早く", "under: 2026-09-01 09:00", "score: ", "(meaning)"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	out, _, _, _ = runHeadless(t, "scrap", "search", "--text", "--semantic", "存在しない話題ゼロ")
	if strings.Contains(out, "No matches") {
		t.Errorf("a semantic search always has a nearest note: %s", out)
	}
}

func TestSemanticSearchFilters(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	writeFile(t, filepath.Join(dir, "sub", "2026-09-04.md"), "# 2026-09-04 09:00\n\n別の場所のメモ。\n")
	buildIndex(t)

	rels := func(r semOut) []string {
		var s []string
		for _, m := range r.Matches {
			s = append(s, filepath.Base(m.File))
		}
		return s
	}
	q := "メモ 会議 夕食 竹 Rust ping"
	all := semSearch(t, q, "--limit", "50")
	if all.Count < 5 {
		t.Fatalf("all = %v", rels(all))
	}
	if r := semSearch(t, q, "--from", "2026-09-02", "--to", "2026-09-03", "--limit", "50"); len(r.Matches) == 0 {
		t.Error("range")
	} else {
		for _, m := range r.Matches {
			if m.Date < "2026-09-02" || m.Date > "2026-09-03" {
				t.Errorf("range: %+v", m)
			}
		}
	}
	for _, m := range semSearch(t, q, "--kind", "log", "--limit", "50").Matches {
		if m.Kind != "log" {
			t.Errorf("--kind log: %+v", m)
		}
	}
	for _, m := range semSearch(t, q, "--kind", "note", "--limit", "50").Matches {
		if m.Kind != "note" {
			t.Errorf("--kind note: %+v", m)
		}
	}
	if r := semSearch(t, q, "--path", "sub/*.md", "--limit", "50"); len(r.Matches) != 1 || filepath.Base(r.Matches[0].File) != "2026-09-04.md" {
		t.Errorf("--path: %v", rels(r))
	}
	if r := semSearch(t, q, "--limit", "2"); r.Count != 2 || !r.Truncated {
		t.Errorf("--limit 2: count %d truncated %v", r.Count, r.Truncated)
	}
	if r := semSearch(t, q, "--limit", "50"); r.Truncated {
		t.Errorf("a limit above the number of notes is not truncated")
	}

	for _, bad := range [][]string{
		{"scrap", "search", "--semantic", "--kind", "photo", "x"},
		{"scrap", "search", "--semantic", "--ranked", "x"},
		{"scrap", "search", "--kind", "note", "x"},
		{"scrap", "search", "--path", "*.md", "x"},
		{"scrap", "search", "--update", "x"},
		{"scrap", "search", "--semantic", "--from", "2026-13-01", "x"},
	} {
		if _, _, code, err := runHeadless(t, bad...); code != 1 || err == nil {
			t.Errorf("%v must be refused: code %d err %v", bad, code, err)
		}
	}
}

func TestSemanticSearchReachesNotesTheIndexDoesNotHoldYetByWords(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	buildIndex(t)
	writeFile(t, filepath.Join(dir, "2026-09-10.md"), "# 2026-09-10 09:00\n\nつい今しがた書いた、ヨーグルトメーカーの話。\n")

	res := semSearch(t, "ヨーグルトメーカー")
	if res.Pending != 1 || !res.Semantic {
		t.Fatalf("%+v", res)
	}
	var fromWords *semHit
	for i, m := range res.Matches {
		if m.Source == "words" {
			fromWords = &res.Matches[i]
		}
	}
	if fromWords == nil || filepath.Base(fromWords.File) != "2026-09-10.md" || !strings.Contains(fromWords.Text, "ヨーグルト") {
		t.Fatalf("the new note must be found by words: %+v", res.Matches)
	}
	if len(res.Notes) != 1 || !strings.Contains(res.Notes[0], "1 files are not indexed yet") {
		t.Errorf("notes = %v", res.Notes)
	}
	// a note that holds every word of the text comes first, even when the semantic hits would fill --limit
	if one := semSearch(t, "ヨーグルトメーカー", "--limit", "1"); one.Count != 1 || one.Matches[0].Source != "words" || filepath.Base(one.Matches[0].File) != "2026-09-10.md" || !one.Truncated {
		t.Errorf("--limit 1: %+v", one)
	}
	// a note that holds only some of the words does not: it comes after the meaning hits
	part := semSearch(t, "ヨーグルトメーカー 竹", "--limit", "50")
	seenSemantic := false
	for _, m := range part.Matches {
		if m.Source == "semantic" {
			seenSemantic = true
		}
		if m.Source == "words" && !seenSemantic {
			t.Errorf("a partial word match must not come before the semantic hits: %+v", part.Matches)
		}
	}
	// --update brings it into the index within the time budget, so it is found by meaning (and nothing is pending)
	res = semSearch(t, "ヨーグルトメーカー", "--update")
	if res.Pending != 0 || len(res.Notes) != 0 || filepath.Base(res.Matches[0].File) != "2026-09-10.md" || res.Matches[0].Source != "semantic" {
		t.Errorf("after --update: %+v", res)
	}
}

func TestSemanticSearchFallsBackToWordsWhenTheModelIsDown(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	buildIndex(t)
	srv.Close() // the model is gone

	res := semSearch(t, "借用チェッカー ライフタイム")
	if res.Semantic || !res.Ranked || res.Count != 1 || res.Matches[0].Source != "words" || filepath.Base(res.Matches[0].File) != "2026-09-01.md" {
		t.Fatalf("%+v", res)
	}
	if len(res.Notes) != 1 || !strings.Contains(res.Notes[0], "searched by words, not by meaning") || !strings.Contains(res.Notes[0], "could not be used") {
		t.Errorf("notes = %v", res.Notes)
	}
	// a path filter and a range still apply to the fallback
	if r := semSearch(t, "借用チェッカー", "--from", "2026-09-02"); r.Count != 0 {
		t.Errorf("range on the fallback: %+v", r)
	}
	if r := semSearch(t, "借用チェッカー", "--path", "nothing*"); r.Count != 0 {
		t.Errorf("path on the fallback: %+v", r)
	}
}

func TestSemanticSearchWithNoIndexFallsBackAndSaysSo(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	res := semSearch(t, "夕食 カレー")
	if res.Semantic || res.Count != 1 || len(res.Notes) != 1 || !strings.Contains(res.Notes[0], "index is empty") || !strings.Contains(res.Notes[0], "md-memo scrap index") {
		t.Errorf("%+v", res)
	}
	if srv.reqs() != 1 { // the query was embedded before the empty index was noticed... or not at all: either way at most the query
		t.Logf("requests: %d", srv.reqs())
	}
}

func TestSemanticSearchNeedsTheSameModelAsTheIndex(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	buildIndex(t)
	// the settings now name another model
	semanticSandboxRewrite(t, dir, map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": srv.URL, "model": "nomic-embed-text"}})

	res := semSearch(t, "夕食 カレー")
	if res.Semantic || len(res.Notes) != 1 || !strings.Contains(res.Notes[0], "another model") {
		t.Errorf("%+v", res)
	}
	if _, _, code, err := runHeadless(t, "scrap", "index"); code != 1 || err == nil || !strings.Contains(err.Error(), "--rebuild") {
		t.Errorf("update with another model: code %d err %v", code, err)
	}
	out, _, _, _ := runHeadless(t, "scrap", "index", "--status", "--json")
	var st map[string]interface{}
	mustJSON(t, out, &st)
	if st["rebuild_needed"] != true {
		t.Errorf("status: %v", st)
	}
	rb := buildIndex(t, "--rebuild")
	if rb["rebuilt"] != true || num(rb, "chunks") == 0 {
		t.Errorf("rebuild: %v", rb)
	}
	if res := semSearch(t, "夕食 カレー"); !res.Semantic || len(res.Notes) != 0 {
		t.Errorf("after the rebuild: %+v", res)
	}
}

func semanticSandboxRewrite(t *testing.T, scrapDir string, sem map[string]interface{}) {
	t.Helper()
	b, _ := json.Marshal(map[string]interface{}{"scraps": map[string]string{"scrapDir": scrapDir}, "semantic": sem})
	writeConfigFile(t, string(b))
}

func TestScrapIndexStatusAndDryRun(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)

	stat := func() map[string]interface{} {
		out, _, code, err := runHeadless(t, "scrap", "index", "--status", "--json")
		if err != nil || code != 0 {
			t.Fatalf("status: %v", err)
		}
		var m map[string]interface{}
		mustJSON(t, out, &m)
		return m
	}
	before := stat()
	if before["enabled"] != true || before["exists"] == true || num(before, "new_files") != 3 || num(before, "files_in_folder") != 3 || before["local"] != true {
		t.Fatalf("before: %v", before)
	}

	// a dry run counts, writes nothing, asks nothing
	d := buildIndex(t, "--dry-run")
	if d["dry_run"] != true || num(d, "chunks_new") == 0 || num(d, "embedded") != 0 || srv.reqs() != 0 {
		t.Errorf("dry run: %v, requests %d", d, srv.reqs())
	}
	if _, err := os.Stat(before["index_dir"].(string)); !os.IsNotExist(err) {
		t.Error("a dry run created the index folder")
	}
	rd := buildIndex(t, "--rebuild", "--dry-run")
	if rd["dry_run"] != true || num(rd, "chunks_new") != num(d, "chunks_new") || srv.reqs() != 0 {
		t.Errorf("rebuild dry run: %v", rd)
	}

	buildIndex(t)
	after := stat()
	if after["exists"] != true || num(after, "chunks") == 0 || num(after, "files") != 3 || num(after, "new_files") != 0 || num(after, "changed_files") != 0 || after["updated"] == "" || num(after, "size_bytes") == 0 {
		t.Errorf("after: %v", after)
	}
	writeFile(t, filepath.Join(dir, "2026-09-03.md"), "# 2026-09-03 08:00\n\n書き換えた。\n")
	if st := stat(); num(st, "changed_files") != 1 {
		t.Errorf("a changed file is pending: %v", st)
	}
	out, _, _, _ := runHeadless(t, "scrap", "index", "--status", "--text")
	for _, want := range []string{"semantic search: on", "this machine", "chunks from 3 files", "not up to date: 0 new, 1 changed, 0 removed"} {
		if !strings.Contains(out, want) {
			t.Errorf("status text lacks %q:\n%s", want, out)
		}
	}
}

func TestScrapIndexOptionsAreChecked(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	for _, args := range [][]string{
		{"scrap", "index", "extra"},
		{"scrap", "index", "--settle", "-1"},
		{"scrap", "index", "--status", "--rebuild"},
		{"scrap", "index", "--status", "--dry-run"},
		{"scrap", "index", "--nope"},
	} {
		if _, _, code, err := runHeadless(t, args...); code != 1 || err == nil {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	if srv.reqs() != 0 {
		t.Errorf("a refused command must not call the model")
	}
	// --settle leaves files that were changed just now
	r := buildIndex(t, "--settle", "10")
	if num(r, "files_settling") != 3 || num(r, "chunks") != 0 || srv.reqs() != 0 {
		t.Errorf("settle: %v", r)
	}
}

func TestScrapIndexTextOutput(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	out, _, code, err := runHeadless(t, "scrap", "index", "--text")
	if err != nil || code != 0 || !strings.HasPrefix(out, "Indexed 3 files (3 read, 0 removed): ") || !strings.Contains(out, " new texts embedded, 0 reused.") {
		t.Errorf("%q %v", out, err)
	}
	out, _, _, _ = runHeadless(t, "scrap", "index", "--text", "--dry-run")
	if !strings.HasPrefix(out, "Would index 3 files (0 read") {
		t.Errorf("%q", out)
	}
}

func TestScrapIndexReportsAnUnreachableModelAndKeepsWhatItDid(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	seedScraps(t, dir)
	srv.Close()
	_, _, code, err := runHeadless(t, "scrap", "index")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "run the command again to continue") {
		t.Errorf("code %d err %v", code, err)
	}
	if err != nil && strings.Contains(err.Error(), "key") {
		t.Errorf("error mentions a key: %v", err)
	}
}

// ---- the cloud ----------------------------------------------------------------------------------------------------------------------

func TestCloudModelIsRefusedWithoutConsent(t *testing.T) {
	dir := semanticSandbox(t, map[string]interface{}{"enabled": true, "model": map[string]interface{}{"baseUrl": "https://api.example.com/v1", "model": "text-embedding-3-small", "apiKey": "sk-secret-123456"}})
	seedScraps(t, dir)
	for _, args := range [][]string{{"scrap", "index"}, {"scrap", "index", "--rebuild"}, {"scrap", "search", "--semantic", "竹"}, {"scrap", "search", "--semantic", "--update", "竹"}} {
		_, _, code, err := runHeadless(t, args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), "has not been allowed") || !strings.Contains(err.Error(), "api.example.com") || strings.Contains(err.Error(), "sk-secret") {
			t.Errorf("%v: code %d err %v", args, code, err)
		}
	}
	// status shows it too, and never the key
	out, _, code, err := runHeadless(t, "scrap", "index", "--status", "--text")
	if err != nil || code != 0 || !strings.Contains(out, "NOT allowed yet") || strings.Contains(out, "sk-secret") {
		t.Errorf("status: %q %v", out, err)
	}
	if out, _, _, _ = runHeadless(t, "scrap", "index", "--status", "--json"); strings.Contains(out, "sk-secret") {
		t.Errorf("the key leaked into the JSON status: %s", out)
	}
}

func TestLargeCloudRunAsksForYes(t *testing.T) {
	// the host does not exist (.invalid); every step below must stop before any request, so the test needs no network
	dir := semanticSandbox(t, map[string]interface{}{
		"enabled": true,
		"model":   map[string]interface{}{"baseUrl": "https://embed.invalid/v1", "model": "text-embedding-3-small", "apiKey": "sk-test-key-000"},
		"privacy": map[string]interface{}{"cloudConsent": map[string]interface{}{"embed.invalid": "2026-10-02"}},
	})
	var sb strings.Builder
	for i := 0; i < cloudIndexConfirmTexts+100; i++ {
		fmt.Fprintf(&sb, "# 2026-09-01 %02d:%02d\n\nメモ番号 %d の本文。固有の語 w%d。\n\n", i/60%24, i%60, i, i*7919)
	}
	writeFile(t, filepath.Join(dir, "2026-09-01.md"), sb.String())

	_, _, code, err := runHeadless(t, "scrap", "index")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "--yes") || !strings.Contains(err.Error(), "embed.invalid") || !strings.Contains(err.Error(), "1100") {
		t.Fatalf("code %d err %v", code, err)
	}
	if _, _, code, err := runHeadless(t, "scrap", "index", "--rebuild"); code != 1 || err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Errorf("rebuild: code %d err %v", code, err)
	}
	// counting is free and needs no --yes
	out, _, code, err := runHeadless(t, "scrap", "index", "--dry-run", "--json")
	if err != nil || code != 0 || !strings.Contains(out, `"chunks_new": 1100`) || !strings.Contains(out, `"local": false`) {
		t.Errorf("dry run: %q %v", out, err)
	}
}

func TestSemanticSearchShowsTenAndLeavesOutTheNotesFarBelowTheBest(t *testing.T) {
	srv := newFakeOllama(t)
	dir := semanticSandbox(t, localModel(srv.URL))
	// 13 notes that talk about the question, in different amounts, and one that does not
	for i := 0; i < 13; i++ {
		writeFile(t, filepath.Join(dir, fmt.Sprintf("2026-08-%02d.md", i+1)),
			fmt.Sprintf("# 2026-08-%02d 09:00\n\n竹の伐採と建材の話。%s\n", i+1, strings.Repeat("竹の話。", i%4)+fmt.Sprintf("メモ番号%d。", i*17)))
	}
	writeFile(t, filepath.Join(dir, "2026-08-20.md"), "# 2026-08-20 09:00\n\nカレーを煮込む。スパイスと玉ねぎ、トマト缶。\n")
	buildIndex(t)
	q := "竹の伐採と建材"

	// without a cut-off, the default is ten notes, and it says there were more
	ten := semSearch(t, q)
	if ten.Count != 10 || !ten.Truncated {
		t.Fatalf("the default is 10 notes: %d truncated=%v", ten.Count, ten.Truncated)
	}
	if more := semSearch(t, q, "--limit", "30"); more.Count != 14 || more.Truncated {
		t.Fatalf("--limit 30: %d truncated=%v", more.Count, more.Truncated)
	}

	// the default cut-off: nothing below 0.85 of the best, and the curry note is not among them
	def := semSearch(t, q, "--cutoff", "0.85", "--limit", "30")
	if def.Count == 0 || def.Count >= 14 {
		t.Fatalf("a cut-off must take some notes away: %d", def.Count)
	}
	best := def.Matches[0].Score
	for _, m := range def.Matches {
		if m.Score < 0.85*best-1e-9 || strings.Contains(m.Text, "カレー") {
			t.Errorf("below the cut-off: %+v", m)
		}
	}
	if len(def.Notes) != 1 || !strings.Contains(def.Notes[0], "lower-scoring notes were left out") || !strings.Contains(def.Notes[0], "--cutoff 0") {
		t.Errorf("the cut-off says what it did: %v", def.Notes)
	}
	if def.LeftOut < 1 || !strings.HasPrefix(def.Notes[0], fmt.Sprintf("%d lower-scoring", def.LeftOut)) { // the same count as a number, for the window to word itself
		t.Errorf("left_out = %d, note %q", def.LeftOut, def.Notes[0])
	}
	// a higher share keeps fewer; 0 keeps all
	if strict := semSearch(t, q, "--cutoff", "0.99", "--limit", "30"); strict.Count > def.Count || strict.Count == 0 {
		t.Errorf("0.99 keeps no more than 0.85: %d vs %d", strict.Count, def.Count)
	}
	// with nothing typed the command's own defaults hold: 10 at most, and the cut-off of 0.85
	out, _, code, err := runHeadless(t, "scrap", "search", "--json", "--semantic", q)
	var plain semOut
	mustJSON(t, out, &plain)
	if err != nil || code != 0 || plain.Count > 10 || plain.Count == 0 {
		t.Fatalf("defaults: %d %v", plain.Count, err)
	}
	for _, m := range plain.Matches {
		if m.Score < 0.85*plain.Matches[0].Score-1e-9 {
			t.Errorf("the default cut-off was not applied: %+v", m)
		}
	}

	for _, bad := range [][]string{
		{"scrap", "search", "--semantic", "--cutoff", "1.5", q},
		{"scrap", "search", "--semantic", "--cutoff", "-0.1", q},
		{"scrap", "search", "--cutoff", "0.5", q}, // not a semantic search
		{"scrap", "search", "--semantic", "--limit", "0", q},
	} {
		if _, _, code, err := runHeadless(t, bad...); code != 1 || err == nil {
			t.Errorf("%v must be refused: code %d err %v", bad, code, err)
		}
	}
}
