package semindex

import (
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func texts(sp []span) []string {
	out := make([]string, len(sp))
	for i, s := range sp {
		out[i] = s.text
	}
	return out
}

func TestSentencesJapanese(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"竹は早く育つ。三年で伐採できる。", []string{"竹は早く育つ。", "三年で伐採できる。"}},
		{"本当ですか？はい！そうです。", []string{"本当ですか？", "はい！", "そうです。"}},
		// a closing bracket stays with the sentence it closes; the next sentence does not start with one
		{"彼は「明日送る。」と言った。次は月曜だ。", []string{"彼は「明日送る。」と言った。", "次は月曜だ。"}},
		{"（詳しくは後で。）それから、続き。", []string{"（詳しくは後で。）", "それから、続き。"}},
		// a stop inside a quotation does not end the sentence; a quotation never closed does not swallow the next line
		{"「一つ。二つ。」と言った。次。", []string{"「一つ。二つ。」と言った。", "次。"}},
		{"「始まり。\n次の行。", []string{"「始まり。", "次の行。"}},
		{"『題名。』を読んだ。", []string{"『題名。』を読んだ。"}},
		{"えっ！？まさか。。。本当に", []string{"えっ！？", "まさか。。。", "本当に"}},
		// a comma is not the end of a sentence
		{"天気がよく、風も弱いので、散歩に行った。", []string{"天気がよく、風も弱いので、散歩に行った。"}},
		// a line break always ends one: lists, logs, one-line notes
		{"- 牛乳\n- 卵\n- パン", []string{"- 牛乳", "- 卵", "- パン"}},
		// Latin letters and numbers inside Japanese text
		{"含水率は8.5%に揃える。Version 3.2.1 を使う。example.com を見る。", []string{"含水率は8.5%に揃える。", "Version 3.2.1 を使う。", "example.com を見る。"}},
	}
	for _, c := range cases {
		if got := texts(sentences(c.in, 0)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q\n  got  %q\n  want %q", c.in, got, c.want)
		}
	}
}

func TestSentencesEnglish(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"Bamboo grows fast. It is cheap! Is it strong? Yes.", []string{"Bamboo grows fast.", "It is cheap!", "Is it strong?", "Yes."}},
		// titles, initials and dotted abbreviations do not end a sentence
		{"Mr. Smith met Dr. Jones. They left.", []string{"Mr. Smith met Dr. Jones.", "They left."}},
		{"J. R. R. Tolkien wrote it. Fine.", []string{"J. R. R. Tolkien wrote it.", "Fine."}},
		{"Use a tool, e.g. a saw. Then stop.", []string{"Use a tool, e.g. a saw.", "Then stop."}},
		{"Made in the U.S. Sold in Japan.", []string{"Made in the U.S. Sold in Japan."}}, // an acceptable merge: both halves stay together
		{"We bought wood, nails, etc. and left.", []string{"We bought wood, nails, etc. and left."}},
		{"It ended in 2019. Then it began.", []string{"It ended in 2019.", "Then it began."}},
		// numbers, hosts and ellipses are not stops
		{"Version 3.2.1 is out. See example.com/a.b now.", []string{"Version 3.2.1 is out.", "See example.com/a.b now."}},
		{"Wait... what happened? Nothing.", []string{"Wait... what happened?", "Nothing."}},
		// a quotation or a bracket after the stop stays with its sentence
		{`He said "stop." Then he left (quietly.) The end.`, []string{`He said "stop."`, "Then he left (quietly.)", "The end."}},
	}
	for _, c := range cases {
		if got := texts(sentences(c.in, 0)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q\n  got  %q\n  want %q", c.in, got, c.want)
		}
	}
}

func TestSentenceSpansPointIntoTheBody(t *testing.T) {
	body := "彼は「明日送る。」と言った。\nNext one, e.g. this. Last."
	for _, sp := range sentences(body, 0) {
		if !strings.HasPrefix(body[sp.off:], sp.text) {
			t.Errorf("span %q is not at byte %d of the body", sp.text, sp.off)
		}
	}
	// base shifts every offset
	for _, sp := range sentences(body, 100) {
		if !strings.HasPrefix(body[sp.off-100:], sp.text) {
			t.Errorf("span %q: base not applied", sp.text)
		}
	}
}

func TestVeryLongSentenceIsCutAtClausesOnly(t *testing.T) {
	clause := "竹は成長が早く三年ほどで伐採できるため"
	long := strings.Repeat(clause+"、", 12) + "来月提案する。" // 1 sentence, well over twice the size below
	max := 50
	if got := texts(units(long, 0, max)); len(got) < 6 {
		t.Fatalf("a run-on sentence must be cut at its commas: %q", got)
	} else {
		for _, g := range got[:len(got)-1] {
			if !strings.HasSuffix(g, "、") {
				t.Errorf("cut inside a clause: %q", g)
			}
		}
	}
	// at most twice the size: left whole, even though it is longer than max
	mid := strings.Repeat(clause+"、", 3) + "来月提案する。"
	if utf8.RuneCountInString(mid) <= max || utf8.RuneCountInString(mid) > 2*max {
		t.Fatalf("test setup: %d characters", utf8.RuneCountInString(mid))
	}
	if got := texts(units(mid, 0, max)); len(got) != 1 {
		t.Errorf("a sentence up to twice the size stays whole: %q", got)
	}
	// English: commas followed by a space; a number with a comma is not cut
	en := strings.Repeat("the supplier, which was late, ", 8) + "delivered 1,200 boards."
	got := texts(units(en, 0, 30))
	if len(got) < 4 {
		t.Errorf("English run-on: %q", got)
	}
	for _, g := range got {
		if strings.HasSuffix(g, "1,") || strings.HasPrefix(g, "200") {
			t.Errorf("cut inside a number: %q", got)
		}
	}
}

// Chunks cut from text with brackets and abbreviations begin with a sentence, not with the rest of one.
func TestChunksDoNotStartWithAClosingBracketOrAnAbbreviationTail(t *testing.T) {
	body := "彼は「明日までに図面を送る。」と言ったが、まだ届いていない。次の打ち合わせは来週の月曜日だ。その前に確認したい。\n\n" +
		"Mr. Smith said the supplier, e.g. the one in Osaka, can deliver by the 10th. We should check the moisture content before installation. Above 12% gaps appear later."
	cs := ChunkFile("2026-01-01.md", []byte("# 2026-01-01 00:00\n\n"+body+"\n"), ChunkOptions{MaxChars: 40})
	if len(cs) < 4 {
		t.Fatalf("chunks: %d", len(cs))
	}
	for _, c := range cs {
		first, _ := utf8.DecodeRuneInString(c.Text)
		if isCloser(first) || strings.HasPrefix(c.Text, "the one in Osaka") || strings.HasPrefix(c.Text, "Smith") {
			t.Errorf("a chunk starts in the middle of a sentence: %q", c.Text)
		}
		if strings.HasSuffix(c.Text, "Mr.") || strings.HasSuffix(c.Text, "e.g.") {
			t.Errorf("a chunk ends after an abbreviation: %q", c.Text)
		}
	}
}
