package semindex

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"md-memo/pkg/embed"
)

func buildFor(t *testing.T) (idx string, emb *fakeEmb) {
	t.Helper()
	scrap, idx := dirs(t)
	seed(t, scrap)
	emb = newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	return idx, emb
}

func TestSearchFilters(t *testing.T) {
	idx, emb := buildFor(t)
	ctx := context.Background()
	rels := func(hs []Hit) string {
		var r []string
		for _, h := range hs {
			r = append(r, h.Rel)
		}
		return strings.Join(r, ",")
	}
	all, _, err := Search(ctx, idx, emb, "メモ 会議 夕食 竹 Rust", SearchOptions{Limit: 50})
	if err != nil || len(all) < 4 {
		t.Fatalf("%v %v", all, err)
	}
	h, info, _ := Search(ctx, idx, emb, "会議 夕食 竹 Rust", SearchOptions{Since: "2026-09-02", Limit: 50})
	for _, x := range h {
		if x.Date < "2026-09-02" {
			t.Errorf("since: %+v", x)
		}
	}
	if info.Candidates >= info.Chunks {
		t.Errorf("a date bound must leave fewer candidates: %+v", info)
	}
	h, _, _ = Search(ctx, idx, emb, "会議 夕食 竹 Rust", SearchOptions{Until: "2026-09-01", Limit: 50})
	if len(h) == 0 || strings.Contains(rels(h), "09-02") || strings.Contains(rels(h), "09-03") {
		t.Errorf("until: %s", rels(h))
	}
	h, _, _ = Search(ctx, idx, emb, "会議 夕食 竹 Rust", SearchOptions{Since: "2026-09-02", Until: "2026-09-02", Limit: 50})
	if rels(h) == "" || strings.Trim(strings.ReplaceAll(rels(h), "2026-09-02.md", ""), ",") != "" {
		t.Errorf("one day: %s", rels(h))
	}
	h, _, _ = Search(ctx, idx, emb, "会議 夕食 竹 Rust", SearchOptions{Path: "sub/*.md", Limit: 50})
	if rels(h) != "sub/2026-09-03.md" {
		t.Errorf("path with a folder: %s", rels(h))
	}
	h, _, _ = Search(ctx, idx, emb, "会議 夕食 竹 Rust", SearchOptions{Path: "2026-09-0[12].md", Limit: 50})
	if strings.Contains(rels(h), "sub/") || rels(h) == "" {
		t.Errorf("path by file name: %s", rels(h))
	}
	h, _, _ = Search(ctx, idx, emb, "会議", SearchOptions{Limit: 1})
	if len(h) != 1 {
		t.Errorf("limit: %d", len(h))
	}
	if h, _, err := Search(ctx, idx, emb, "会議", SearchOptions{Since: "2030-01-01"}); err != nil || len(h) != 0 {
		t.Errorf("nothing in range: %v %v", h, err)
	}
	if _, _, err := Search(ctx, idx, emb, "   ", SearchOptions{}); err == nil {
		t.Error("an empty query must be refused")
	}
}

// Keep is asked about every chunk before it is scored: a rejected chunk is not a candidate, so it is neither a hit nor counted.
func TestSearchKeepRemovesChunksBeforeScoring(t *testing.T) {
	idx, emb := buildFor(t)
	ctx := context.Background()
	const q = "会議 夕食 竹 Rust"
	all, allInfo, err := Search(ctx, idx, emb, q, SearchOptions{Limit: 50})
	if err != nil || len(all) < 4 {
		t.Fatalf("%v %v", all, err)
	}
	asked := map[string]int{}
	h, info, err := Search(ctx, idx, emb, q, SearchOptions{Limit: 50, Keep: func(rel string, line int) bool {
		asked[rel]++
		if line < 1 {
			t.Errorf("Keep got line %d for %s", line, rel)
		}
		return rel != "2026-09-02.md"
	}})
	if err != nil || len(h) == 0 {
		t.Fatalf("%v %v", h, err)
	}
	for _, x := range h {
		if x.Rel == "2026-09-02.md" {
			t.Errorf("Keep rejected this file: %+v", x)
		}
	}
	if len(h) >= len(all) || info.Candidates >= allInfo.Candidates {
		t.Errorf("Keep must leave fewer candidates: %d hits (all %d), %+v (all %+v)", len(h), len(all), info, allInfo)
	}
	if asked["2026-09-02.md"] == 0 || asked["2026-09-01.md"] == 0 {
		t.Errorf("Keep was not asked about every file: %v", asked)
	}
	// it sees the first line of the chunk, so a caller can decide per entry
	byLine, _, _ := Search(ctx, idx, emb, q, SearchOptions{Limit: 50, Keep: func(rel string, line int) bool { return line == all[0].Line && rel == all[0].Rel }})
	if len(byLine) == 0 || byLine[0].Rel != all[0].Rel {
		t.Errorf("by line: %+v", byLine)
	}
	// nothing kept is an empty answer, not an error
	if none, _, err := Search(ctx, idx, emb, q, SearchOptions{Keep: func(string, int) bool { return false }}); err != nil || len(none) != 0 {
		t.Errorf("nothing kept: %v %v", none, err)
	}
}

func TestSearchKindsAndLogPenalty(t *testing.T) {
	idx, emb := buildFor(t)
	ctx := context.Background()
	logs, _, err := Search(ctx, idx, emb, "128.1.33.254 応答 時間", SearchOptions{Kinds: []string{KindLog}})
	if err != nil || len(logs) != 1 || logs[0].Kind != KindLog || logs[0].Heading != "[10:05:00] ping" {
		t.Fatalf("only logs: %+v %v", logs, err)
	}
	both, _, _ := Search(ctx, idx, emb, "128.1.33.254 応答 時間", SearchOptions{LogPenalty: -1})
	pen, _, _ := Search(ctx, idx, emb, "128.1.33.254 応答 時間", SearchOptions{})
	var withoutPenalty, with float64
	for _, h := range both {
		if h.Kind == KindLog {
			withoutPenalty = h.Score
		}
	}
	for _, h := range pen {
		if h.Kind == KindLog {
			with = h.Score
		}
	}
	if withoutPenalty == 0 || with >= withoutPenalty || withoutPenalty-with < 0.04 || withoutPenalty-with > 0.06 {
		t.Errorf("log penalty: %v vs %v", withoutPenalty, with)
	}
	notes, _, _ := Search(ctx, idx, emb, "128.1.33.254 応答 時間", SearchOptions{Kinds: []string{KindNote}, Limit: 50})
	for _, h := range notes {
		if h.Kind != KindNote {
			t.Errorf("kind filter: %+v", h)
		}
	}
	if ai, _, _ := Search(ctx, idx, emb, "AI", SearchOptions{Kinds: []string{KindAI}}); len(ai) != 0 {
		t.Errorf("no AI chunks are indexed by default: %+v", ai)
	}
}

func TestSearchOneHitPerEntryWithItsContext(t *testing.T) {
	scrap, idx := dirs(t)
	long := strings.Repeat("夕食の献立について長く考えた。カレーかシチューか迷った。", 12)
	writeFile(t, scrap, "2026-09-10.md", note("2026-09-10", "19:00", long)+note("2026-09-10", "20:00", "全く別の話題で、庭の草むしりをした。"))
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	store, _ := OpenStore(idx)
	perEntry := map[int]int{}
	for i, m := range store.metas {
		if !store.dead[i] {
			perEntry[m.Entry]++
		}
	}
	multi := false
	for _, n := range perEntry {
		if n > 1 {
			multi = true
		}
	}
	if !multi {
		t.Fatalf("test setup: the long entry must be cut into several chunks (%v)", perEntry)
	}
	hits, _, err := Search(context.Background(), idx, emb, "夕食の献立 カレーかシチュー", SearchOptions{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 {
		t.Fatalf("two entries, so two hits: %d", len(hits))
	}
	if hits[0].Heading != "2026-09-10 19:00" || len([]rune(hits[0].Context)) <= len([]rune(hits[0].Text)) || !strings.Contains(hits[0].Context, hits[0].Text) {
		t.Errorf("the context holds the whole entry: text %d chars, context %d", len([]rune(hits[0].Text)), len([]rune(hits[0].Context)))
	}
	small, _, _ := Search(context.Background(), idx, emb, "夕食の献立 カレーかシチュー", SearchOptions{ContextChars: 40})
	if len([]rune(small[0].Context)) != 40 {
		t.Errorf("context bound: %d", len([]rune(small[0].Context)))
	}
	if hits[0].Score < hits[1].Score {
		t.Errorf("hits are in score order: %v then %v", hits[0].Score, hits[1].Score)
	}
}

func TestSearchOnAnEmptyIndex(t *testing.T) {
	_, idx := dirs(t)
	if _, _, err := Search(context.Background(), idx, newFake(), "竹", SearchOptions{}); !errors.Is(err, ErrEmpty) {
		t.Errorf("a missing index: %v", err)
	}
	scrap, idx2 := dirs(t)
	writeFile(t, scrap, "readme.txt", "x")
	if _, err := Update(context.Background(), scrap, idx2, newFake(), newOpts()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Search(context.Background(), idx2, newFake(), "竹", SearchOptions{}); !errors.Is(err, ErrEmpty) {
		t.Errorf("an index with no notes: %v", err)
	}
}

func TestSearchTiesGoToTheNewerDay(t *testing.T) {
	scrap, idx := dirs(t)
	for _, d := range []string{"2026-01-01", "2026-02-02", "2025-12-31"} {
		writeFile(t, scrap, d+".md", note(d, "09:00", "同じ内容のメモ。"))
	}
	emb := newFake()
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	// the header carries the date, so the vectors differ a little; the lexical part and the vectors may order these by date. What is
	// promised is only that the order is stable between runs.
	a, _, _ := Search(context.Background(), idx, emb, "同じ内容のメモ", SearchOptions{})
	b, _, _ := Search(context.Background(), idx, emb, "同じ内容のメモ", SearchOptions{})
	if len(a) != 3 || fmt.Sprint(a) != fmt.Sprint(b) {
		t.Errorf("unstable order: %v / %v", a, b)
	}
}

func TestQueryTokens(t *testing.T) {
	got := queryTokens("Rust と ライフタイム ping")
	has := func(s string) bool {
		for _, g := range got {
			if g == s {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"rust", "ping", "ru", "st", "ライ", "フタ", "とラ"} { // the pair "とラ" spans two words on purpose
		if !has(want) {
			t.Errorf("missing token %q in %q", want, got)
		}
	}
	if has("と") || has("r") {
		t.Errorf("single characters are not tokens: %q", got)
	}
	if len(queryTokens("a")) != 0 {
		t.Error("one letter has no tokens")
	}
}

// A pasted page as the query: the lexical score looks at a bounded number of tokens, so the cost of a search does not grow with it,
// but identifiers still count and the end of the text is not ignored.
func TestQueryTokensAreBoundedForLongQueries(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < 3000; i++ {
		sb.WriteRune(rune(0x4e00 + (i*37)%2000))
		if i == 1500 {
			sb.WriteString(" ping 128.1.15.33 ")
		}
	}
	q := sb.String()
	toks := queryTokens(q)
	if len(toks) > maxLexicalTokens {
		t.Fatalf("%d tokens, the cap is %d", len(toks), maxLexicalTokens)
	}
	has := func(s string) bool {
		for _, x := range toks {
			if x == s {
				return true
			}
		}
		return false
	}
	if !has("128.1.15.33") || !has("ping") {
		t.Errorf("identifiers must be kept: %q", toks)
	}
	// pairs come from the whole text: some from its first fifth and some from its last fifth
	rs := []rune(strings.Map(func(r rune) rune {
		if r == ' ' {
			return -1
		}
		return r
	}, q))
	inRange := func(from, to int) bool {
		for i := from; i+1 < to; i++ {
			if has(string(rs[i : i+2])) {
				return true
			}
		}
		return false
	}
	if !inRange(0, len(rs)/5) || !inRange(len(rs)*4/5, len(rs)) {
		t.Errorf("the tokens must be spread over the whole query")
	}
	// the tokens are distinct, and a query that fits is not touched
	seen := map[string]bool{}
	for _, x := range toks {
		if seen[x] {
			t.Errorf("duplicate token %q", x)
		}
		seen[x] = true
	}
	if got := queryTokens("竹の伐採"); len(got) != 3 {
		t.Errorf("a short query keeps every pair: %q", got)
	}
	// many Latin words: the identifiers are capped too, and the pairs still get the rest
	var words []string
	for i := 0; i < 200; i++ {
		words = append(words, fmt.Sprintf("word%03d", i))
	}
	got := queryTokens(strings.Join(words, " "))
	if len(got) > maxLexicalTokens || !strings.HasPrefix(got[0], "word") {
		t.Errorf("many words: %d tokens", len(got))
	}
}

// constEmb gives every text the same vector, so only the lexical score tells chunks apart.
type constEmb struct{ fakeEmb }

func (c *constEmb) Embed(ctx context.Context, kind embed.Kind, in []embed.Input) ([][]float32, error) {
	out := make([][]float32, len(in))
	for i := range in {
		v := make([]float32, c.dim)
		v[0] = 1
		out[i] = v
	}
	return out, nil
}

// The lexical score is divided by what a chunk holding every token of the query would get, not by the best chunk's score: a chunk that
// shares only a little with the query gets a little, whatever the other chunks are like. (Dividing by the best chunk gave the best
// of a poor lot the whole weight, which on notes in two languages lifted the chunks that shared common words of the query's language
// over the right notes in the other language.)
func TestLexicalScoreIsRelativeToTheWholeQueryNotToTheBestChunk(t *testing.T) {
	scrap, idx := dirs(t)
	writeFile(t, scrap, "2026-09-01.md",
		note("2026-09-01", "09:00", "the construction of the new building starts on monday")+
			note("2026-09-01", "10:00", "sustainable construction materials ideas for the village")+
			note("2026-09-01", "11:00", "lunch was noodles and a long walk by the river"))
	emb := &constEmb{fakeEmb: *newFake()}
	if _, err := Update(context.Background(), scrap, idx, emb, newOpts()); err != nil {
		t.Fatal(err)
	}
	lexOf := func(query string) map[string]float64 {
		hits, _, err := Search(context.Background(), idx, emb, query, SearchOptions{Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		m := map[string]float64{}
		for _, h := range hits {
			m[h.Heading] = h.Lexical
		}
		return m
	}
	// the query is one of the notes, word for word: that note holds every token
	full := lexOf("sustainable construction materials ideas for the village")
	if full["2026-09-01 10:00"] < 0.6 { // not exactly 1: the score also depends on the length of the chunk
		t.Errorf("a chunk that holds the whole query must get most of the weight: %v", full)
	}
	// an abstract question that shares one word with a note: that note must not get the whole weight
	weak := lexOf("a plan to rebuild abandoned countryside construction")
	if got := weak["2026-09-01 09:00"]; got <= 0 || got > 0.35 {
		t.Errorf("a chunk that shares one word of the query must get a small share, got %v (%v)", got, weak)
	}
	// the old way of dividing, for comparison: the best of a poor lot gets everything
	hits, _, _ := Search(context.Background(), idx, emb, "a plan to rebuild abandoned countryside construction", SearchOptions{Limit: 10, LexNorm: "max"})
	best := 0.0
	for _, h := range hits {
		if h.Lexical > best {
			best = h.Lexical
		}
	}
	if best < 0.99 {
		t.Errorf(`LexNorm "max" must give the best chunk the whole weight: %v`, best)
	}
}
