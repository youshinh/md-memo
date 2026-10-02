package semindex

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

const sampleDay = "# 2026-09-10 09:00\n\n竹は成長が早く、3年ほどで伐採できる。建材として使えば環境への負荷がかなり小さいはず。\n\n" +
	"---\n## [10:09:51] ping\n```text\n\n128.1.33.254 に ping を送信しています\n128.1.33.254 からの応答: 時間 =5ms\n```\n\n" +
	"# 2026-09-10 11:00\n\n[[ @llm 要約して ]]\n<!-- md-memo:res 1 -->\nAI の答えです。\n<!-- /md-memo:res -->\n\n" +
	"# 2026-09-10 12:00\n\n<!-- メモの下書き\n二行目 -->\n本当のメモ。\n"

func chunksByKind(cs []Chunk) map[string][]Chunk {
	m := map[string][]Chunk{}
	for _, c := range cs {
		m[c.Kind] = append(m[c.Kind], c)
	}
	return m
}

func TestChunkFileKindsHeadingsAndLines(t *testing.T) {
	cs := ChunkFile("2026-09-10.md", []byte(sampleDay), ChunkOptions{MaxChars: 150, Header: true})
	by := chunksByKind(cs)
	if len(by[KindAI]) != 0 {
		t.Errorf("AI result blocks must not be indexed by default: %+v", by[KindAI])
	}
	if len(by[KindLog]) == 0 || !strings.Contains(by[KindLog][0].Text, "128.1.33.254") {
		t.Fatalf("the piped output must be a log chunk: %+v", cs)
	}
	if by[KindLog][0].Heading != "[10:09:51] ping" {
		t.Errorf("log heading = %q", by[KindLog][0].Heading)
	}
	for _, c := range cs {
		if c.Rel != "2026-09-10.md" || c.Date != "2026-09-10" || c.Hash == "" {
			t.Errorf("chunk metadata: %+v", c)
		}
	}
	// the note keeps its heading and its line (line 3 of the file is the sentence)
	note := by[KindNote][0]
	if note.Heading != "2026-09-10 09:00" || note.Line != 3 || note.Entry != 0 {
		t.Errorf("note chunk = %+v", note)
	}
	// every chunk's text stands where it says it does
	lines := strings.Split(sampleDay, "\n")
	for _, c := range cs {
		first := strings.Split(c.Text, "\n")[0]
		if c.Line < 1 || c.Line > len(lines) || !strings.Contains(lines[c.Line-1], strings.TrimSpace(first)) {
			t.Errorf("chunk %q claims line %d, which holds %q", first, c.Line, lines[c.Line-1])
		}
	}
	// a comment is not text, and its line breaks are kept (so "本当のメモ。" is at line 24, not 22)
	var real Chunk
	for _, c := range cs {
		if strings.Contains(c.Text, "本当のメモ") {
			real = c
		}
		if strings.Contains(c.Text, "下書き") {
			t.Errorf("a comment was indexed: %q", c.Text)
		}
	}
	if real.Line != 24 {
		t.Errorf("the line after a two-line comment: got %d, want 24", real.Line)
	}
}

func TestChunkFileIncludeAIAndHeaderChangeTheHash(t *testing.T) {
	with := ChunkFile("2026-09-10.md", []byte(sampleDay), ChunkOptions{Header: true, IncludeAI: true})
	if len(chunksByKind(with)[KindAI]) == 0 {
		t.Error("IncludeAI must keep the AI blocks")
	}
	on := ChunkFile("2026-09-10.md", []byte(sampleDay), ChunkOptions{Header: true})
	off := ChunkFile("2026-09-10.md", []byte(sampleDay), ChunkOptions{Header: false})
	if len(on) != len(off) || on[0].Hash == off[0].Hash || on[0].Text != off[0].Text {
		t.Errorf("the header is in the embedded text (the hash), not in the kept text: %+v / %+v", on[0], off[0])
	}
	if got := EmbedText("本文", "2026-09-10", "見出し", true); got != "2026-09-10 > 見出し\n本文" {
		t.Errorf("EmbedText = %q", got)
	}
	if got := EmbedText("本文", "", "", true); got != "本文" {
		t.Errorf("EmbedText without a header = %q", got)
	}
	if got := EmbedText("本文", "2026-09-10", "", true); got != "2026-09-10\n本文" {
		t.Errorf("EmbedText with a date only = %q", got)
	}
}

func TestChunkFilePacksByParagraphsThenSentencesWithOverlap(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("# 長い日\n\n")
	for i := 0; i < 8; i++ {
		sb.WriteString("これは一つの文です、番号は")
		sb.WriteString(string(rune('０' + i)))
		sb.WriteString("。")
	}
	sb.WriteString("\n\n短い段落。\n")
	cs := ChunkFile("x.md", []byte(sb.String()), ChunkOptions{MaxChars: 50})
	if len(cs) < 4 {
		t.Fatalf("a long paragraph must be cut into several chunks: %d", len(cs))
	}
	for _, c := range cs {
		if n := utf8.RuneCountInString(c.Text); n > 60 { // a chunk is a little over max only because of the repeated sentence
			t.Errorf("chunk too long (%d): %q", n, c.Text)
		}
	}
	// the sentence at a join is repeated at the start of the next chunk
	if !strings.HasPrefix(cs[1].Text, "これは一つの文です") {
		t.Errorf("no overlap: %q then %q", cs[0].Text, cs[1].Text)
	}
	if last := cs[len(cs)-1]; last.Text != "短い段落。" {
		t.Errorf("the short paragraph is its own chunk: %q", last.Text)
	}
}

// A chunk cut from a long paragraph is a stretch of what was written: the line breaks and spaces between its sentences stay (a piped
// log is read line by line, and "Hello. World" must not become "Hello.World"), and EndLine counts them.
func TestChunkFileKeepsTheWhiteSpaceBetweenSentences(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("# 2026-01-01 00:00\n\n")
	for i := 0; i < 12; i++ {
		fmt.Fprintf(&sb, "line number %02d of a log\n", i)
	}
	sb.WriteString("\n")
	for i := 0; i < 8; i++ {
		fmt.Fprintf(&sb, "This is sentence %d. ", i)
	}
	sb.WriteString("\n")
	src := sb.String()
	cs := ChunkFile("2026-01-01.md", []byte(src), ChunkOptions{MaxChars: 80})
	if len(cs) < 4 {
		t.Fatalf("chunks: %d", len(cs))
	}
	lines := strings.Split(src, "\n")
	for _, c := range cs {
		if strings.Contains(c.Text, "log\nline") != strings.Contains(c.Text, "of a log") || strings.Contains(c.Text, "log line") || strings.Contains(c.Text, "logline") {
			t.Errorf("line breaks were lost or turned into something else: %q", c.Text)
		}
		if strings.Contains(c.Text, ".This") {
			t.Errorf("the space after a full stop was lost: %q", c.Text)
		}
		// the chunk is the very text of the lines it says it covers
		if c.EndLine < c.Line || c.EndLine > len(lines) {
			t.Fatalf("lines %d-%d of %d", c.Line, c.EndLine, len(lines))
		}
		want := strings.Join(lines[c.Line-1:c.EndLine], "\n")
		if !strings.Contains(want, strings.Split(c.Text, "\n")[0]) || strings.Count(c.Text, "\n") != c.EndLine-c.Line {
			t.Errorf("chunk %q claims lines %d-%d, which hold %q", c.Text, c.Line, c.EndLine, want)
		}
	}
	// chunks that follow each other inside one paragraph share a sentence (its text and its spacing), so that what a sentence says is
	// never cut off from the one before it
	overlaps := 0
	for i := 1; i < len(cs); i++ {
		if cs[i].Line > cs[i-1].EndLine {
			continue // another paragraph
		}
		overlaps++
		if n := overlapLen(cs[i-1].Text, cs[i].Text); n < len("line number 00 of a log") && n < len("This is sentence 0.") {
			t.Errorf("chunks %q and %q overlap by only %d bytes", cs[i-1].Text, cs[i].Text, n)
		}
	}
	if overlaps == 0 {
		t.Error("test setup: no two chunks followed each other inside a paragraph")
	}
}

// overlapLen is the length of the longest tail of a that is also the head of b.
func overlapLen(a, b string) int {
	for n := min(len(a), len(b)); n > 0; n-- {
		if a[len(a)-n:] == b[:n] {
			return n
		}
	}
	return 0
}

func TestChunkFileHardLimitAndCRLFAndEmpty(t *testing.T) {
	long := "# a\r\n\r\n" + strings.Repeat("あ", 5000) + "\r\n"
	cs := ChunkFile("x.md", []byte(long), ChunkOptions{MaxChars: 100})
	if len(cs) != 1 || utf8.RuneCountInString(cs[0].Text) != hardMaxChars {
		t.Errorf("one endless sentence is cut at the hard limit: %d chunks, %d chars", len(cs), utf8.RuneCountInString(cs[0].Text))
	}
	if strings.Contains(cs[0].Text, "\r") {
		t.Error("CRLF must not leak into chunks")
	}
	if got := ChunkFile("x.md", nil, ChunkOptions{}); len(got) != 0 {
		t.Errorf("an empty file has no chunks: %+v", got)
	}
	if got := ChunkFile("x.md", []byte("# only a heading\n"), ChunkOptions{}); len(got) != 0 {
		t.Errorf("a heading alone is not a chunk: %+v", got)
	}
}

func TestChunkFileLogsAreCutFromTheirHead(t *testing.T) {
	body := "---\n## [01:02:03] build\n```text\n" + strings.Repeat("ok  md-memo/pkg/x 0.1s\n", 300) + "```\n"
	cs := ChunkFile("2026-01-01.md", []byte(body), ChunkOptions{MaxChars: 150})
	total := 0
	for _, c := range cs {
		if c.Kind != KindLog {
			t.Fatalf("kind = %s", c.Kind)
		}
		total += utf8.RuneCountInString(c.Text)
	}
	if total > logHeadChars+200 { // the head, plus the sentence repeats
		t.Errorf("a log is embedded by its first %d characters only, got %d", logHeadChars, total)
	}
}

func TestDateOfName(t *testing.T) {
	cases := map[string]string{"2026-09-10.md": "2026-09-10", "a/b/2026-01-02 (x).md": "2026-01-02", "notes.md": "", "x/2026-1-2.md": ""}
	for in, want := range cases {
		if got := dateOfName(in); got != want {
			t.Errorf("dateOfName(%q) = %q, want %q", in, got, want)
		}
	}
}

// What a deep search wrote is an AI's text, whole: it is not indexed (or, when AI text is asked for, it is of the AI kind), so that the
// next search finds the notes, not a summary of them.
func TestChunkFileLeavesOutANoteADeepSearchWrote(t *testing.T) {
	src := "<!-- md-memo:deepsearch -->\n# 深掘り: 竹\n\n竹は成長が早い [1](file:///x.md)。\n\n---\n作成: 2026-10-02\n"
	if got := ChunkFile("2026-10-02.md", []byte(src), ChunkOptions{Header: true}); len(got) != 0 {
		t.Errorf("a deep search note was indexed: %+v", got)
	}
	got := ChunkFile("2026-10-02.md", []byte(src), ChunkOptions{Header: true, IncludeAI: true})
	if len(got) == 0 {
		t.Fatal("with AI text asked for, the note is kept")
	}
	for _, c := range got {
		if c.Kind != KindAI {
			t.Errorf("kind = %s", c.Kind)
		}
	}
	// a note of the person's own that mentions the mark further down is not one
	if got := ChunkFile("a.md", []byte("# 自分のメモ\n\n本文 <!-- md-memo:deepsearch -->\n"), ChunkOptions{}); len(got) == 0 {
		t.Error("the mark counts only as the first line")
	}
}
