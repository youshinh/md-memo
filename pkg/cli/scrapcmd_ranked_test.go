package cli

import (
	"path/filepath"
	"strings"
	"testing"
)

type rankedHit struct {
	File    string  `json:"file"`
	Date    string  `json:"date"`
	Line    int     `json:"line"`
	Text    string  `json:"text"`
	Heading string  `json:"heading"`
	Score   float64 `json:"score"`
	Partial bool    `json:"partial"`
}

type rankedOut struct {
	Query     string      `json:"query"`
	Ranked    bool        `json:"ranked"`
	Count     int         `json:"count"`
	Truncated bool        `json:"truncated"`
	Matches   []rankedHit `json:"matches"`
}

func rankedJSON(t *testing.T, args ...string) rankedOut {
	t.Helper()
	out, _, code, err := runHeadless(t, append([]string{"scrap", "search", "--json", "--ranked"}, args...)...)
	if err != nil || code != 0 {
		t.Fatalf("%v: code %d err %v", args, code, err)
	}
	var res rankedOut
	mustJSON(t, out, &res)
	return res
}

func TestScrapSearchRankedFindsTheWordsOfOneNote(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"), "---\n## [09:00:00] 打ち合わせ\n図面は来週までに送る。\nそれが遅れると\n納期もずれる。\n")
	writeFile(t, filepath.Join(dir, "2026-09-25.md"), "---\n## [10:00:00] 別件\n納期の話だけ。\n")

	// the plain search finds no line that holds "納期 図面"
	if plain := searchJSON(t, "納期 図面"); plain.Count != 0 {
		t.Fatalf("plain search: %+v", plain)
	}
	res := rankedJSON(t, "納期 図面")
	if !res.Ranked || res.Query != "納期 図面" || res.Count != 1 || res.Truncated {
		t.Fatalf("result = %+v", res)
	}
	m := res.Matches[0]
	if filepath.Base(m.File) != "2026-09-24.md" || m.Date != "2026-09-24" || m.Partial || m.Score <= 0 || m.Heading != "## [09:00:00] 打ち合わせ" {
		t.Errorf("match = %+v", m)
	}
}

func TestScrapSearchRankedPartialLimitAndRange(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"), "# a\n納期だけ\n")
	writeFile(t, filepath.Join(dir, "2026-09-25.md"), "# b\n図面だけ\n")
	res := rankedJSON(t, "納期 図面")
	if res.Count != 2 || !res.Matches[0].Partial || !res.Matches[1].Partial {
		t.Fatalf("no note holds both words: both hits must be partial, got %+v", res)
	}
	if one := rankedJSON(t, "納期 図面", "--limit", "1"); one.Count != 1 || !one.Truncated {
		t.Errorf("--limit 1: %+v", one)
	}
	if ranged := rankedJSON(t, "納期 図面", "--from", "2026-09-25"); ranged.Count != 1 || filepath.Base(ranged.Matches[0].File) != "2026-09-25.md" {
		t.Errorf("--from: %+v", ranged)
	}
}

func TestScrapSearchRankedTextOutput(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"), "# a\n納期だけ\n")
	out, _, code, err := runHeadless(t, "scrap", "search", "--text", "--ranked", "納期 図面")
	if err != nil || code != 0 {
		t.Fatalf("code %d err %v", code, err)
	}
	for _, want := range []string{"2026-09-24.md:2: 納期だけ", "score: ", "not every word"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
}

func TestScrapSearchWithoutRankedIsUnchanged(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"), "# a\n納期 図面\n")
	res := searchJSON(t, "納期 図面")
	if res.Count != 1 {
		t.Fatalf("plain: %+v", res)
	}
	out, _, _, _ := runHeadless(t, "scrap", "search", "--json", "納期 図面")
	if strings.Contains(out, `"ranked"`) || strings.Contains(out, `"score"`) {
		t.Errorf("the plain search's JSON must not carry the ranked fields: %s", out)
	}
}
