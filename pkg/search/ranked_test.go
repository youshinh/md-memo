package search

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTermsJapaneseAndLatin(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"   ", nil},
		{"納期 図面", []string{"納期", "図面"}},
		{"納期　図面", []string{"納期", "図面"}}, // the ideographic space
		{"取引先との納期の約束", []string{"取引先", "納期", "約束"}},
		{"サステナブルな建材のアイデア", []string{"サステナブル", "建材", "アイデア"}},
		{"寝つきが悪い", []string{"寝つき", "悪い"}},           // verb/adjective stems keep their okurigana, the particle が goes
		{"睡眠の質を上げる工夫", []string{"睡眠", "上げる", "工夫"}}, // 質 (one kanji + を) is dropped
		{"竹", []string{"竹"}},                                             // a single kanji is kept when it is all there is
		{"ひらがな", []string{"ひらがな"}},                                       // so is a hiragana-only word
		{"128.1.33.254 のping結果", []string{"128.1.33.254", "ping", "結果"}}, // a Latin word and kanji are different scripts
		{"Go言語 goroutine", []string{"go", "言語", "goroutine"}},
		{"user@host foo-bar", []string{"user@host", "foo-bar"}},
		{`"納期は来月末" 見積`, []string{"納期は来月末", "見積"}}, // a quoted phrase stays one word, particles included
		{"納期 納期 納期", []string{"納期"}},              // unique
		{"ミリ秒", []string{"ミリ"}},                   // a lone kanji is only a last resort: the katakana word stands
	}
	for _, c := range cases {
		got := Terms(c.in)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("Terms(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTermsAreCapped(t *testing.T) {
	got := Terms("aa bb cc dd ee ff gg hh ii jj")
	if len(got) != maxQueryTerms {
		t.Errorf("got %d terms, want the first %d", len(got), maxQueryTerms)
	}
}

func writeScrap(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func firstMatch(t *testing.T, r []SearchResult, i int) SearchMatch {
	t.Helper()
	if i >= len(r) || len(r[i].Matches) == 0 {
		t.Fatalf("no result %d in %+v", i, r)
	}
	return r[i].Matches[0]
}

func TestRankedFindsWordsOnDifferentLinesOfOneEntry(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-09-01.md", "# 2026-09-01 10:00\n\n図面は来週までに送る。\nそれが遅れると\n納期もずれる。\n\n# 2026-09-01 11:00\n\n納期の話だけ。\n")
	// the plain search finds nothing for the two words together
	if plain, _ := SearchScrapsContext(context.Background(), dir, "納期 図面", 50); len(plain) != 0 {
		t.Fatalf("the plain search was expected to find no single line holding both: %+v", plain)
	}
	got, err := SearchScrapsRanked(context.Background(), dir, "納期 図面", 50, Options{Headings: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("results = %+v, want the one entry that holds both words", got)
	}
	m := firstMatch(t, got, 0)
	if m.Partial || m.Score <= 0 {
		t.Errorf("match = %+v, want a full (not partial) hit with a score", m)
	}
	if m.Heading != "# 2026-09-01 10:00" {
		t.Errorf("heading = %q", m.Heading)
	}
}

func TestRankedWordsInDifferentEntriesDoNotCountTogether(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-09-01.md", "# a\n\n納期だけ\n\n# b\n\n図面だけ\n")
	got, _ := SearchScrapsRanked(context.Background(), dir, "納期 図面", 50, Options{})
	for _, r := range got {
		if !r.Matches[0].Partial {
			t.Fatalf("an entry with only one of the words must not be a full hit: %+v", r)
		}
	}
	// no entry holds both, so the half-or-more fallback lists the two entries, marked partial
	if len(got) != 2 {
		t.Errorf("results = %d, want the two partial entries", len(got))
	}
}

func TestRankedEntriesAreSplitAtRulesAndHeadingsButNotInsideFences(t *testing.T) {
	dir := t.TempDir()
	// the "# comment" line sits inside a code fence: it does not start an entry, so 納期 and 図面 are in one entry
	writeScrap(t, dir, "2026-09-02.md", "# 2026-09-02 09:00\n\n```sh\n# 納期 を確認\nls\n```\n図面を見る\n\n---\n## [10:00:00] CLI Pipe\n```text\nlog line\n```\n")
	got, _ := SearchScrapsRanked(context.Background(), dir, "納期 図面", 50, Options{})
	if len(got) != 1 || got[0].Matches[0].Partial {
		t.Errorf("results = %+v, want one full hit (the fenced comment is part of the entry)", got)
	}
	// "---" then a heading is one entry: "CLI Pipe" and "log" are found together
	got, _ = SearchScrapsRanked(context.Background(), dir, "pipe log", 50, Options{})
	if len(got) != 1 || got[0].Matches[0].Partial {
		t.Errorf("rule + heading entry: %+v", got)
	}
}

func TestRankedOrdersByScoreThenNewestFile(t *testing.T) {
	dir := t.TempDir()
	// the rarer word and more occurrences rank higher; equal scores keep newest file first
	writeScrap(t, dir, "2026-01-01.md", "# x\n\n竹 竹 竹 の話。竹材 の加工。\n")
	writeScrap(t, dir, "2026-02-01.md", "# y\n\n竹 の話を少し。\n")
	writeScrap(t, dir, "2026-03-01.md", "# z\n\n竹 の話を少し。\n")
	writeScrap(t, dir, "2026-04-01.md", "# w\n\n関係ない話。\n")
	got, _ := SearchScrapsRanked(context.Background(), dir, "竹", 50, Options{})
	var names []string
	for _, r := range got {
		names = append(names, r.FileName)
	}
	want := []string{"2026-01-01.md", "2026-03-01.md", "2026-02-01.md"}
	if !reflect.DeepEqual(names, want) {
		t.Errorf("order = %v, want %v", names, want)
	}
}

func TestRankedPhraseInOrderRanksFirst(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-01-01.md", "# a\n\nfoo and bar are separate here.\n")
	writeScrap(t, dir, "2026-01-02.md", "# b\n\nthe bar and then foo in another order.\n")
	writeScrap(t, dir, "2026-01-03.md", "# c\n\nplain foo bar together.\n")
	got, _ := SearchScrapsRanked(context.Background(), dir, "foo bar", 50, Options{})
	if len(got) != 3 || got[0].FileName != "2026-01-03.md" {
		t.Errorf("results = %+v, want the entry holding the exact phrase first", got)
	}
}

func TestRankedLimitKeepAndHeadings(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"2026-01-01.md", "2026-01-02.md", "2026-01-03.md"} {
		writeScrap(t, dir, n, "# top\n\n## sec\n\n建材 の話\n")
	}
	got, _ := SearchScrapsRanked(context.Background(), dir, "建材", 2, Options{Headings: true})
	if len(got) != 2 {
		t.Fatalf("limit not applied: %d", len(got))
	}
	if h := firstMatch(t, got, 0).Heading; h != "## sec" {
		t.Errorf("heading = %q", h)
	}
	kept, _ := SearchScrapsRanked(context.Background(), dir, "建材", 50, Options{Keep: func(p string) bool { return strings.HasSuffix(p, "01-02.md") }})
	if len(kept) != 1 || kept[0].FileName != "2026-01-02.md" {
		t.Errorf("Keep not honoured: %+v", kept)
	}
}

func TestRankedHandlesCRLFAndEmptyAndMissing(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-01-01.md", "# a\r\n\r\n納期 と 図面\r\n")
	if got, _ := SearchScrapsRanked(context.Background(), dir, "納期 図面", 50, Options{}); len(got) != 1 || strings.Contains(got[0].Matches[0].LineText, "\r") {
		t.Errorf("CRLF: %+v", got)
	}
	if got, err := SearchScrapsRanked(context.Background(), dir, "   ", 50, Options{}); err != nil || len(got) != 0 {
		t.Errorf("empty query: %+v %v", got, err)
	}
	if got, err := SearchScrapsRanked(context.Background(), filepath.Join(dir, "nope"), "x1", 50, Options{}); err != nil || len(got) != 0 {
		t.Errorf("missing folder: %+v %v", got, err)
	}
	if got, _ := SearchScrapsRanked(context.Background(), dir, "存在しない語", 50, Options{}); len(got) != 0 {
		t.Errorf("no match must be empty: %+v", got)
	}
}

func TestRankedStopsWhenCancelled(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-01-01.md", "# a\n\n納期\n")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, _ := SearchScrapsRanked(ctx, dir, "納期", 50, Options{}); len(got) != 0 {
		t.Errorf("a cancelled search must return nothing: %+v", got)
	}
}

func TestFallbackKeepsThePlainSearchExactlyAsItWas(t *testing.T) {
	dir := t.TempDir()
	writeScrap(t, dir, "2026-01-01.md", "# a\n\n納期 図面 が一緒の行\n\n# b\n\n納期だけ\n")
	res, _ := SearchScrapsWithFallback(context.Background(), dir, "納期 図面", 50)
	if len(res) != 1 || res[0].Matches[0].Score != 0 || res[0].Matches[0].LineNumber != 3 {
		t.Fatalf("a query the plain search answers must be answered by it (no score): %+v", res)
	}
	// nothing holds the whole text: the ranked search steps in and its matches carry a score
	res, _ = SearchScrapsWithFallback(context.Background(), dir, "図面 納期 来週", 50)
	if len(res) == 0 || res[0].Matches[0].Score <= 0 {
		t.Errorf("fallback not used or not scored: %+v", res)
	}
}
