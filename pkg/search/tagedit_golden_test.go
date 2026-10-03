package search

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The golden file testdata/tagedit_golden.json is what EditTags answers for a list of requests, written by this test. The window's
// page mock (and any other client that wants to behave like the Go side) reads it: every case has the request (text, op, scope,
// line, tags) and the whole answer, plus new_text, the text that results from applying the answer to the request's text.
//
//	go test ./pkg/search -run TestTagEditGolden -update
//
// rewrites the file; the normal run compares and fails on a difference. Requests that EditTags refuses with an error (an unknown op,
// a line outside the text, ...) are not in it: they are not answers, and tagedit_test.go has them.

var updateGolden = flag.Bool("update", false, "rewrite pkg/search/testdata/tagedit_golden.json")

type goldenCase struct {
	Name  string     `json:"name"`
	Text  string     `json:"text"`
	Op    string     `json:"op"`
	Scope string     `json:"scope"`
	Line  int        `json:"line"`
	Tags  []string   `json:"tags"`
	Want  goldenWant `json:"want"`
}

// goldenWant is the TagEdit of the case and the text it makes.
type goldenWant struct {
	TagEdit
	NewText string `json:"new_text"`
}

// goldenRequests are the requests of the file; the answers are computed.
func goldenRequests() []goldenCase {
	many := func(n int) string { // "t1, t2, ..., tn"
		var s []string
		for i := 1; i <= n; i++ {
			s = append(s, fmt.Sprintf("t%02d", i))
		}
		return strings.Join(s, ", ")
	}
	const bom = "\xEF\xBB\xBF"
	scrap := "# 2026-10-01 09:00\n打ち合わせのメモ。\n\n# 2026-10-01 10:30\n買い物の件。\n"
	daily := "---\n## [10:00:00] 朝の連絡\n本文1\n\n---\n## [10:05:00] ping\n本文2\n"
	tagged := "# 2026-10-01 09:00\n<!-- tags: 仕事, 急ぎ -->\n打ち合わせのメモ。\n\n# 2026-10-01 10:30\n買い物の件。\n"
	front := "<!-- tags: 全体 -->\n前文\n\n# 見出し1\n<!-- tags: 仕事 -->\n本文1\n\n# 見出し2\n本文2\n"
	fm := "---\ntitle: メモ\ntags: [設計, レビュー]\n---\n# 見出し\n本文\n"
	req := func(name, text, op, scope string, line int, tags ...string) goldenCase {
		return goldenCase{Name: name, Text: text, Op: op, Scope: scope, Line: line, Tags: append([]string{}, tags...)}
	}
	return []goldenCase{
		// the plain cases a page mock has to handle
		req("add: entry under a dated heading", scrap, "add", "entry", 2, "仕事"),
		req("add: second entry, caret on its heading", scrap, "add", "entry", 4, "買い物"),
		req("add: two tags at once, written as one list", scrap, "add", "entry", 5, "買い物, 急ぎ"),
		req("add: two tags, as two elements", scrap, "add", "entry", 5, "買い物", "#急ぎ"),
		req("add: entry of a daily file (a rule and a heading)", daily, "add", "entry", 7, "ping"),
		req("add: first entry of a daily file", daily, "add", "entry", 3, "朝"),
		req("add: note on a file that starts with a heading", scrap, "add", "note", 0, "日記"),
		req("add: note on a daily file", daily, "add", "note", 0, "日報"),
		req("add: note on a file with a front part", front, "add", "note", 0, "追加"),
		req("add: a caret in the front part is the whole note", front, "add", "entry", 2, "追加"),
		req("add: a file with no heading and no rule is one note", "メモだけ\n二行目\n", "add", "entry", 2, "メモ"),
		req("add: merged into the comment that is there", tagged, "add", "entry", 6, "仕事", "新規"),
		req("add: merged into the note's comment", front, "add", "note", 0, "全体, 追加"),
		req("add: the caret is on the empty last line", scrap, "add", "entry", 6, "末尾"),
		req("add: a tag in different letters is the same tag", tagged, "add", "entry", 3, "Ｗｏｒｋ", "仕事"),
		req("add: more than 32 tags go to a second line", "# H\n<!-- tags: "+many(31)+" -->\nbody\n", "add", "entry", 3, "x1, x2, x3"),
		req("add: a full comment gets a line under it", "# H\n<!-- tags: "+many(32)+" -->\nbody\n", "add", "entry", 3, "x1"),
		req("add: a comment inside a code fence is not a tag line", "# H\n```\n<!-- tags: fake -->\n```\nbody\n", "add", "entry", 5, "real"),
		req("add: indentation of the comment is kept", "# H\n  <!-- tags: a -->\nbody\n", "add", "entry", 3, "b"),
		req("add: empty text", "", "add", "note", 0, "a"),
		req("add: no newline at the end, after the heading", "# H\nbody", "add", "entry", 2, "a"),
		req("add: no newline at the end, the heading is the last line", "# H", "add", "entry", 1, "a"),
		req("add: CRLF text", "# H\r\nbody\r\n", "add", "entry", 2, "a"),
		req("add: CRLF text, note", "intro\r\n# H\r\nbody\r\n", "add", "note", 0, "a"),
		req("add: byte order mark stays first", bom+"# H\nbody\n", "add", "note", 0, "a"),
		req("add: byte order mark and CRLF", bom+"# H\r\nbody\r\n", "add", "note", 0, "a"),
		req("add: entry of a file with a front matter", fm, "add", "entry", 6, "新規"),

		// removal
		req("remove: the last tag takes the line away", "# H\n<!-- tags: 仕事 -->\n本文\n", "remove", "entry", 3, "仕事"),
		req("remove: one of two tags rewrites the line", tagged, "remove", "entry", 3, "急ぎ"),
		req("remove: the note's tag", front, "remove", "note", 0, "全体"),
		req("remove: a tag on two lines goes from both", "# H\n<!-- tags: a, x -->\nmiddle\n<!-- tags: a -->\nbody\n", "remove", "entry", 2, "a"),
		req("remove: CRLF text, the line goes", "# H\r\n<!-- tags: a -->\r\nbody\r\n", "remove", "entry", 3, "a"),
		req("remove: the last line of a text without a newline", "# H\n<!-- tags: a -->", "remove", "entry", 1, "a"),
		req("remove: byte order mark moves with the first line", bom+"<!-- tags: a -->\ntext\n", "remove", "note", 0, "a"),

		// refusals and no-ops
		req("refused: a note with a front matter", fm, "add", "note", 0, "新規"),
		req("refused: a caret inside the front matter", fm, "add", "entry", 2, "新規"),
		req("refused: a tag only the front matter has", fm, "remove", "note", 0, "設計"),
		req("refused: a front matter tag from an entry", fm, "remove", "entry", 6, "設計"),
		req("refused: the tag is on the whole note", front, "remove", "entry", 6, "全体"),
		req("refused: the tag is on an entry", front, "remove", "note", 0, "仕事"),
		req("nothing: the tag is there already", tagged, "add", "entry", 3, "仕事"),
		req("nothing: the whole note has the tag, so the entry does", front, "add", "entry", 6, "全体"),
		req("nothing: the front matter has the tag, so the entry does", fm, "add", "entry", 6, "設計"),
		req("nothing: no such tag", tagged, "remove", "entry", 3, "存在しない"),
		req("nothing: no tag in a text without any", scrap, "remove", "note", 0, "存在しない"),
		req("nothing: a tag in a code fence is no tag", "# H\n```\n<!-- tags: fake -->\n```\n", "remove", "entry", 1, "fake"),
		req("partly: one removed, one on the whole note", "<!-- tags: n -->\n# H\n<!-- tags: a -->\nbody\n", "remove", "entry", 4, "a", "n"),

		// show
		req("show: an entry", front, "show", "entry", 6),
		req("show: the whole note", front, "show", "note", 0),
		req("show: a file with a front matter", fm, "show", "entry", 6),
		req("show: a text with no tag", scrap, "show", "entry", 2),
	}
}

func goldenAnswers(t *testing.T) []goldenCase {
	t.Helper()
	cases := goldenRequests()
	for i, c := range cases {
		r, err := EditTags([]byte(c.Text), c.Op, c.Scope, c.Line, c.Tags)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		cases[i].Want = goldenWant{TagEdit: r, NewText: string(r.Apply([]byte(c.Text)))}
	}
	return cases
}

// goldenJSON is the file's bytes: fixed field order, UTF-8, no HTML escaping, a byte order mark written as a JSON escape so it can be seen.
func goldenJSON(t *testing.T, cases []goldenCase) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	return bytes.ReplaceAll(buf.Bytes(), []byte("\xEF\xBB\xBF"), []byte{'\\', 'u', 'f', 'e', 'f', 'f'})
}

func TestTagEditGolden(t *testing.T) {
	path := filepath.Join("testdata", "tagedit_golden.json")
	cases := goldenAnswers(t)
	if len(cases) < 30 {
		t.Fatalf("only %d cases", len(cases))
	}
	seen := map[string]bool{}
	for _, c := range cases {
		if seen[c.Name] {
			t.Errorf("two cases are called %q", c.Name)
		}
		seen[c.Name] = true
	}
	got := goldenJSON(t, cases)
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s: %d cases", path, len(cases))
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test ./pkg/search -run TestTagEditGolden -update writes it)", err)
	}
	// a checkout may have turned the file's line breaks into CRLF (the texts inside the JSON are escaped, so they are untouched)
	want = bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n"))
	if bytes.Equal(got, want) {
		return
	}
	// say which case differs: decode the file and compare case by case
	var old []goldenCase
	if err := json.Unmarshal(want, &old); err != nil {
		t.Fatalf("the golden file is not valid: %v", err)
	}
	if len(old) != len(cases) {
		t.Errorf("the golden file has %d cases, the requests are %d", len(old), len(cases))
	}
	for i := range cases {
		if i >= len(old) {
			break
		}
		a, _ := json.Marshal(cases[i])
		b, _ := json.Marshal(old[i])
		if !bytes.Equal(a, b) {
			t.Errorf("case %q differs:\nnow  %s\nfile %s", cases[i].Name, a, b)
			break
		}
	}
	t.Fatal("tagedit_golden.json is out of date: go test ./pkg/search -run TestTagEditGolden -update, and look at the diff")
}

// Every case in the file is what the answer says when it is applied by the two reference routes: the line splice and Apply agree.
func TestTagEditGoldenAnswersAreConsistent(t *testing.T) {
	for _, c := range goldenAnswers(t) {
		w := c.Want
		if w.Changed {
			if ref := refApply(c.Text, w.TagEdit); ref != w.NewText {
				t.Errorf("%s: the line splice gives %q, Apply %q", c.Name, ref, w.NewText)
			}
		} else if w.NewText != c.Text {
			t.Errorf("%s: nothing changed but new_text differs", c.Name)
		}
	}
}
