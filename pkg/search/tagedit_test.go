package search

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The tag editor (docs/design/tag-filter-2026-10.md section 10): where a tag goes, what the patch is, and that a search reads the
// result the way the person asked for it.

// refApply applies a patch a different way than TagEdit.Apply: the text as lines that each remember their own ending, spliced, and
// then the one rule about the end of the text (a text that did not end with a newline still does not; one that did, still does).
func refApply(data string, e TagEdit) string {
	type ln struct{ text, term string }
	var lines []ln
	for rest := data; rest != ""; {
		i := strings.IndexByte(rest, '\n')
		if i < 0 {
			lines = append(lines, ln{rest, ""})
			break
		}
		text, term := rest[:i], "\n"
		if strings.HasSuffix(text, "\r") {
			text, term = text[:len(text)-1], "\r\n"
		}
		lines = append(lines, ln{text, term})
		rest = rest[i+1:]
	}
	unterminated := len(lines) > 0 && lines[len(lines)-1].term == ""
	s, en := min(e.StartLine-1, len(lines)), min(e.EndLine-1, len(lines))
	out := append([]ln(nil), lines[:s]...)
	for _, l := range e.NewLines {
		out = append(out, ln{l, e.Eol})
	}
	out = append(out, lines[en:]...)
	var b strings.Builder
	for i, l := range out {
		term := l.term
		switch {
		case i == len(out)-1 && unterminated:
			term = ""
		case term == "":
			term = e.Eol
		}
		b.WriteString(l.text + term)
	}
	return b.String()
}

// mapLine is where a line of the old text is in the new one (a line the patch replaced maps to the start of the patch).
func mapLine(e TagEdit, line int) int {
	switch {
	case !e.Changed || line < e.StartLine:
		return line
	case line >= e.EndLine:
		return line + len(e.NewLines) - (e.EndLine - e.StartLine)
	}
	return e.StartLine
}

// editTags runs EditTags and checks what has to hold for every call: the patch applied in two ways gives the same text, a second
// identical request changes nothing, the line endings are the text's, and the answer's lists are never nil.
func editTags(t *testing.T, text, op, scope string, line int, tags string) (TagEdit, string) {
	t.Helper()
	r, err := EditTags([]byte(text), op, scope, line, []string{tags})
	if err != nil {
		t.Fatalf("%s %s %q line %d on %q: %v", op, scope, tags, line, text, err)
	}
	got := string(r.Apply([]byte(text)))
	if r.Changed {
		if want := refApply(text, r); got != want {
			t.Fatalf("%s %s %q on %q: Apply gives %q, the line splice gives %q (%+v)", op, scope, tags, text, got, want, r)
		}
	}
	if !r.Changed && got != text {
		t.Fatalf("an edit that changes nothing changed the text: %q", got)
	}
	if r.Added == nil || r.Removed == nil || r.Unchanged == nil || r.NoteTags == nil || r.EntryTags == nil || r.NewLines == nil || r.InheritedTags == nil || r.Path == nil {
		t.Errorf("a list is nil: %+v", r)
	}
	if op == "show" && (r.Changed || r.MessageCode != "") {
		t.Errorf("show changed something: %+v", r)
	}
	if r.Changed != (len(r.Added) > 0 || len(r.Removed) > 0) {
		t.Errorf("Changed %v with added %q removed %q", r.Changed, r.Added, r.Removed)
	}
	if r.Changed {
		again, err := EditTags([]byte(got), op, r.Scope, mapLine(r, line), []string{tags})
		if err != nil || again.Changed {
			t.Errorf("%s %s %q is not idempotent on %q: %+v %v", op, scope, tags, got, again, err)
		}
		// the new text carries no other line ending than the old one's
		if strings.Contains(text, "\r\n") && !strings.Contains(strings.ReplaceAll(text, "\r\n", ""), "\n") {
			if strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
				t.Errorf("a bare newline in a CRLF text: %q", got)
			}
		}
	}
	return r, got
}

type editCase struct {
	name, text, op, scope string
	line                  int
	tags                  string
	want                  string // the new text
	code                  string // message_code
	scopeOut              string // the scope used (default: the one asked for)
	added, removed, kept  string // comma-joined
	at                    int    // TagEdit.Line
	noteTags, entryTags   string // comma-joined; "" for not checked, none for "must be empty"
}

func (c editCase) run(t *testing.T) {
	t.Helper()
	r, got := editTags(t, c.text, c.op, c.scope, c.line, c.tags)
	if got != c.want {
		t.Errorf("new text:\n%q\nwant\n%q\n%+v", got, c.want, r)
	}
	if r.MessageCode != c.code {
		t.Errorf("message_code %q, want %q", r.MessageCode, c.code)
	}
	if want := c.scopeOut; (want == "" && r.Scope != c.scope) || (want != "" && r.Scope != want) {
		t.Errorf("scope %q, want %q%q", r.Scope, c.scope, want)
	}
	for _, p := range []struct {
		name string
		got  []string
		want string
	}{{"added", r.Added, c.added}, {"removed", r.Removed, c.removed}, {"unchanged", r.Unchanged, c.kept}} {
		if g := strings.Join(p.got, ","); g != p.want {
			t.Errorf("%s = %q, want %q", p.name, g, p.want)
		}
	}
	if r.Line != c.at {
		t.Errorf("line %d, want %d", r.Line, c.at)
	}
	for _, p := range []struct {
		name string
		got  []string
		want string
	}{{"note_tags", r.NoteTags, c.noteTags}, {"entry_tags", r.EntryTags, c.entryTags}} {
		want := p.want
		if want == "" {
			continue
		}
		if want == none {
			want = ""
		}
		if g := strings.Join(p.got, ","); g != want {
			t.Errorf("%s = %q, want %q", p.name, g, want)
		}
	}
}

// none in noteTags or entryTags says that the list must be empty (the empty string says it is not looked at).
const none = "(none)"

func TestEditTagsAddAndRemove(t *testing.T) {
	const bom = "\xEF\xBB\xBF"   // written as bytes: a byte order mark typed into a source file is rejected by the compiler
	many := func(n int) string { // "t1, t2, ..." n tags
		var s []string
		for i := 1; i <= n; i++ {
			s = append(s, "t"+strconv.Itoa(i))
		}
		return strings.Join(s, ", ")
	}
	cases := []editCase{
		// ---- where a new comment goes
		{name: "entry under a heading", text: "# 2026-10-01 09:00\nbody\n\n# 2026-10-01 10:00\nsecond\n", op: "add", scope: "entry", line: 2, tags: "仕事",
			want: "# 2026-10-01 09:00\n<!-- tags: 仕事 -->\nbody\n\n# 2026-10-01 10:00\nsecond\n", added: "仕事", at: 2, noteTags: none, entryTags: "仕事"},
		{name: "second entry, caret on its heading", text: "# a\nbody\n# b\nsecond\n", op: "add", scope: "entry", line: 3, tags: "x",
			want: "# a\nbody\n# b\n<!-- tags: x -->\nsecond\n", added: "x", at: 4, entryTags: "x"},
		{name: "entry that starts with a rule and a heading", text: "---\n## [10:00:00] one\nbody\n\n---\n## [10:05:00] ping\nbody2\n", op: "add", scope: "entry", line: 7, tags: "急ぎ",
			want: "---\n## [10:00:00] one\nbody\n\n---\n## [10:05:00] ping\n<!-- tags: 急ぎ -->\nbody2\n", added: "急ぎ", at: 7},
		{name: "the first entry of a daily file is its rule and heading, not a front part", text: "---\n## [10:00:00] one\nbody\n", op: "add", scope: "entry", line: 3, tags: "a",
			want: "---\n## [10:00:00] one\n<!-- tags: a -->\nbody\n", added: "a", at: 3, noteTags: none, entryTags: "a"},
		{name: "entry that starts with a rule only", text: "text\n\n---\nrule body\nmore\n", op: "add", scope: "entry", line: 5, tags: "a",
			want: "text\n\n---\n<!-- tags: a -->\nrule body\nmore\n", added: "a", at: 4},
		{name: "rule, a blank line, then a heading: the heading is another entry", text: "---\n\n## h\nbody\n", op: "add", scope: "entry", line: 1, tags: "a",
			want: "---\n<!-- tags: a -->\n\n## h\nbody\n", added: "a", at: 2},
		{name: "note on a file that starts with a heading", text: "# Title\nbody\n", op: "add", scope: "note", tags: "a",
			want: "<!-- tags: a -->\n# Title\nbody\n", added: "a", at: 1, noteTags: "a", entryTags: none},
		{name: "note on a daily file that starts with a rule", text: "---\n## [10:00:00] one\nbody\n", op: "add", scope: "note", tags: "a",
			want: "<!-- tags: a -->\n---\n## [10:00:00] one\nbody\n", added: "a", at: 1},
		{name: "note on a file with a front part", text: "intro\n\n# H\nbody\n", op: "add", scope: "note", tags: "a, b",
			want: "<!-- tags: a, b -->\nintro\n\n# H\nbody\n", added: "a,b", at: 1},
		{name: "entry in the front part is the whole note", text: "intro\n\n# H\nbody\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: "<!-- tags: a -->\nintro\n\n# H\nbody\n", scopeOut: "note", added: "a", at: 1, noteTags: "a", entryTags: none},
		{name: "a file with no heading and no rule is one note", text: "just text\nmore\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: "<!-- tags: a -->\njust text\nmore\n", scopeOut: "note", added: "a", at: 1},
		{name: "the empty last line after the final newline belongs to the last entry", text: "# a\nx\n# b\ny\n", op: "add", scope: "entry", line: 5, tags: "z",
			want: "# a\nx\n# b\n<!-- tags: z -->\ny\n", added: "z", at: 4},
		{name: "a heading inside a code fence is not an entry", text: "# a\n```\n# not a heading\n```\nbody\n", op: "add", scope: "entry", line: 3, tags: "z",
			want: "# a\n<!-- tags: z -->\n```\n# not a heading\n```\nbody\n", added: "z", at: 2},

		// ---- the text does not carry the tag in front matter
		{name: "note of a file with a front matter is refused", text: "---\ntitle: T\ntags: [x]\n---\n# H\nbody\n", op: "add", scope: "note", tags: "a",
			want: "---\ntitle: T\ntags: [x]\n---\n# H\nbody\n", code: "front_matter", kept: "a", noteTags: "x"},
		{name: "a caret inside the front matter is the note, refused", text: "---\ntitle: T\n---\nbody\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: "---\ntitle: T\n---\nbody\n", code: "front_matter", scopeOut: "note", kept: "a"},
		{name: "entry of a file with a front matter", text: "---\ntitle: T\ntags: [x]\n---\n# H\nbody\n", op: "add", scope: "entry", line: 6, tags: "a",
			want: "---\ntitle: T\ntags: [x]\n---\n# H\n<!-- tags: a -->\nbody\n", added: "a", at: 6, noteTags: "x", entryTags: "a"},
		{name: "entry right under a front matter without a heading", text: "---\ntitle: T\n---\nbody\n", op: "add", scope: "entry", line: 4, tags: "a",
			want: "---\ntitle: T\n---\n<!-- tags: a -->\nbody\n", added: "a", at: 4},
		{name: "a front matter closed by three dots keeps its entry below it", text: "---\ntitle: T\n...\nbody\n", op: "add", scope: "entry", line: 4, tags: "a",
			want: "---\ntitle: T\n...\n<!-- tags: a -->\nbody\n", added: "a", at: 4},
		{name: "a file tag from the front matter is effective for the entry", text: "---\ntags: x\n---\n# H\nbody\n", op: "add", scope: "entry", line: 5, tags: "x",
			want: "---\ntags: x\n---\n# H\nbody\n", code: "already", kept: "x", noteTags: "x"},
		{name: "remove a tag that only the front matter has: note", text: "---\ntags: x\n---\n# H\nbody\n", op: "remove", scope: "note", tags: "x",
			want: "---\ntags: x\n---\n# H\nbody\n", code: "front_matter_tag", kept: "x", noteTags: "x"},
		{name: "remove a tag that only the front matter has: entry", text: "---\ntags: x\n---\n# H\nbody\n", op: "remove", scope: "entry", line: 5, tags: "x",
			want: "---\ntags: x\n---\n# H\nbody\n", code: "front_matter_tag", kept: "x", noteTags: "x"},

		// ---- the other range, and what is effective already
		{name: "remove from the entry a tag the note has", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", op: "remove", scope: "entry", line: 5, tags: "n",
			want: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", code: "on_note", kept: "n", noteTags: "n", entryTags: "e"},
		{name: "remove from the note a tag an entry has", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", op: "remove", scope: "note", tags: "e",
			want: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", code: "on_entry", kept: "e", noteTags: "n"},
		{name: "add to the entry a tag the note has", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", op: "add", scope: "entry", line: 5, tags: "n",
			want: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", code: "already", kept: "n"},
		{name: "add to the note a tag an entry has", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n", op: "add", scope: "note", tags: "e",
			want: "<!-- tags: n, e -->\nintro\n# H\n<!-- tags: e -->\nbody\n", added: "e", at: 1, noteTags: "n,e"},
		{name: "remove a tag that is nowhere", text: "# H\n<!-- tags: e -->\nbody\n", op: "remove", scope: "entry", line: 3, tags: "q",
			want: "# H\n<!-- tags: e -->\nbody\n", code: "none_found", kept: "q", entryTags: "e"},
		{name: "remove from a file with no tag at all", text: "# H\nbody\n", op: "remove", scope: "note", tags: "q",
			want: "# H\nbody\n", code: "none_found", kept: "q"},
		{name: "two tags, one there and one nowhere: no message", text: "# H\n<!-- tags: a -->\nbody\n", op: "remove", scope: "entry", line: 3, tags: "a, q",
			want: "# H\nbody\n", removed: "a", kept: "q", code: ""},
		{name: "two tags, one removed and one on the note: the message says where", text: "<!-- tags: n -->\n# H\n<!-- tags: a -->\nbody\n", op: "remove", scope: "entry", line: 4, tags: "q, n, a",
			want: "<!-- tags: n -->\n# H\nbody\n", removed: "a", kept: "q,n", code: "on_note", noteTags: "n", entryTags: none},
		{name: "two tags, one there already: no message", text: "# H\n<!-- tags: a -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "a, b",
			want: "# H\n<!-- tags: a, b -->\nbody\n", added: "b", kept: "a", at: 2},

		// ---- merging into the comment that is there
		{name: "merge keeps the order and adds at the end", text: "# H\n<!-- tags: b, a -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "c, #D",
			want: "# H\n<!-- tags: b, a, c, d -->\nbody\n", added: "c,d", at: 2, entryTags: "b,a,c,d"},
		{name: "merge, de-duplicated after normalizing", text: "# H\n<!-- tags: a -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "A, ＡＢ, ab",
			want: "# H\n<!-- tags: a, ab -->\nbody\n", added: "ab", kept: "a", at: 2},
		{name: "the comment is anywhere in the entry, not only under the heading", text: "# H\nbody\n\nmore\n<!-- tags: a -->\n", op: "add", scope: "entry", line: 2, tags: "b",
			want: "# H\nbody\n\nmore\n<!-- tags: a, b -->\n", added: "b", at: 5},
		{name: "an empty tag comment is filled", text: "# H\n<!-- tags: -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "a",
			want: "# H\n<!-- tags: a -->\nbody\n", added: "a", at: 2},
		{name: "the key is written tags whatever it was", text: "# H\n<!--TAG: Old-->\nbody\n", op: "add", scope: "entry", line: 3, tags: "n",
			want: "# H\n<!-- tags: old, n -->\nbody\n", added: "n", at: 2},
		{name: "leading spaces are kept", text: "# H\n  <!-- tags: a -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "b",
			want: "# H\n  <!-- tags: a, b -->\nbody\n", added: "b", at: 2},
		{name: "a leading tab is kept", text: "# H\n\t<!-- tags: a -->\nbody\n", op: "remove", scope: "entry", line: 3, tags: "zz, a",
			want: "# H\nbody\n", removed: "a", kept: "zz"},
		{name: "a comment in a code fence is code: neither read nor merged into", text: "# H\n```\n<!-- tags: fake -->\n```\nbody\n", op: "add", scope: "entry", line: 5, tags: "a",
			want: "# H\n<!-- tags: a -->\n```\n<!-- tags: fake -->\n```\nbody\n", added: "a", at: 2, entryTags: "a"},
		{name: "a tag in a code fence is not found", text: "# H\n```\n<!-- tags: fake -->\n```\nbody\n", op: "remove", scope: "entry", line: 5, tags: "fake",
			want: "# H\n```\n<!-- tags: fake -->\n```\nbody\n", code: "none_found", kept: "fake"},
		{name: "a comment that is not a whole line is not a tag line", text: "# H\n<!-- tags: a --> and more\nbody\n", op: "add", scope: "entry", line: 3, tags: "b",
			want: "# H\n<!-- tags: b -->\n<!-- tags: a --> and more\nbody\n", added: "b", at: 2},
		{name: "31 tags and 3 more: the line is filled and the rest goes under it", text: "# H\n<!-- tags: " + many(31) + " -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "x, y, z",
			want: "# H\n<!-- tags: " + many(31) + ", x -->\n<!-- tags: y, z -->\nbody\n", added: "x,y,z", at: 3},
		{name: "a full line: the new tags get a line under it", text: "# H\n<!-- tags: " + many(32) + " -->\nbody\n", op: "add", scope: "entry", line: 3, tags: "x",
			want: "# H\n<!-- tags: " + many(32) + " -->\n<!-- tags: x -->\nbody\n", added: "x", at: 3},

		// ---- removing
		{name: "remove the last tag: the line goes", text: "# H\n<!-- tags: a -->\nbody\n", op: "remove", scope: "entry", line: 3, tags: "a",
			want: "# H\nbody\n", removed: "a", at: 0, noteTags: none, entryTags: none},
		{name: "remove one of two: the line is rewritten", text: "# H\n<!-- tags: a, b -->\nbody\n", op: "remove", scope: "entry", line: 3, tags: "a",
			want: "# H\n<!-- tags: b -->\nbody\n", removed: "a", at: 2, entryTags: "b"},
		{name: "remove from the note", text: "<!-- tags: a, b -->\nintro\n# H\nbody\n", op: "remove", scope: "note", tags: "b",
			want: "<!-- tags: a -->\nintro\n# H\nbody\n", removed: "b", at: 1, noteTags: "a"},
		{name: "remove the note's only tag", text: "<!-- tags: a -->\nintro\n# H\nbody\n", op: "remove", scope: "note", tags: "a",
			want: "intro\n# H\nbody\n", removed: "a", noteTags: none},
		{name: "a tag on two comment lines goes from both, the lines between stay", text: "# H\n<!-- tags: a, x -->\nmiddle\n<!-- tags: a -->\n<!-- tags: y -->\nbody\n", op: "remove", scope: "entry", line: 2, tags: "a",
			want: "# H\n<!-- tags: x -->\nmiddle\n<!-- tags: y -->\nbody\n", removed: "a", at: 2, entryTags: "x,y"},
		{name: "two tags from two lines", text: "# H\n<!-- tags: a -->\nmiddle\n<!-- tags: b, c -->\nbody\n", op: "remove", scope: "entry", line: 2, tags: "b, a",
			want: "# H\nmiddle\n<!-- tags: c -->\nbody\n", removed: "b,a", at: 3, entryTags: "c"},
		{name: "a comment between a rule and its heading belongs to the rule's entry; merging into it", text: "---\n<!-- tags: a -->\n## H\nbody\n", op: "add", scope: "entry", line: 1, tags: "b",
			want: "---\n<!-- tags: a, b -->\n## H\nbody\n", added: "b", at: 2, entryTags: "a,b"},
		{name: "taking that comment away lets the heading rejoin its rule", text: "---\n<!-- tags: a -->\n## H\nbody\n", op: "remove", scope: "entry", line: 1, tags: "a",
			want: "---\n## H\nbody\n", removed: "a"},
		{name: "remove with the entry in a daily file", text: "---\n## [10:00:00] one\n<!-- tags: a -->\nbody\n\n---\n## [10:05:00] two\n<!-- tags: a -->\nbody\n", op: "remove", scope: "entry", line: 7, tags: "a",
			want: "---\n## [10:00:00] one\n<!-- tags: a -->\nbody\n\n---\n## [10:05:00] two\nbody\n", removed: "a"},

		// ---- line endings, byte order mark, the end of the text
		{name: "CRLF: a new line", text: "# H\r\nbody\r\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: "# H\r\n<!-- tags: a -->\r\nbody\r\n", added: "a", at: 2},
		{name: "CRLF: a rewritten line", text: "# H\r\n  <!-- tags: a -->  \r\nbody\r\n", op: "add", scope: "entry", line: 3, tags: "b",
			want: "# H\r\n  <!-- tags: a, b -->\r\nbody\r\n", added: "b", at: 2},
		{name: "CRLF: a deleted line", text: "# H\r\n<!-- tags: a -->\r\nbody\r\n", op: "remove", scope: "entry", line: 3, tags: "a",
			want: "# H\r\nbody\r\n", removed: "a"},
		{name: "CRLF: a note", text: "intro\r\n# H\r\n", op: "add", scope: "note", tags: "a",
			want: "<!-- tags: a -->\r\nintro\r\n# H\r\n", added: "a", at: 1},
		{name: "CRLF: two new lines for 33 tags", text: "# H\r\n<!-- tags: " + many(32) + " -->\r\nbody\r\n", op: "add", scope: "entry", line: 3, tags: "x",
			want: "# H\r\n<!-- tags: " + many(32) + " -->\r\n<!-- tags: x -->\r\nbody\r\n", added: "x", at: 3},
		{name: "BOM: a note keeps the mark first", text: bom + "# H\nbody\n", op: "add", scope: "note", tags: "a",
			want: bom + "<!-- tags: a -->\n# H\nbody\n", added: "a", at: 1, noteTags: "a"},
		{name: "BOM: a note with CRLF", text: bom + "# H\r\nbody\r\n", op: "add", scope: "note", tags: "a",
			want: bom + "<!-- tags: a -->\r\n# H\r\nbody\r\n", added: "a", at: 1},
		{name: "BOM: merging into the first line", text: bom + "<!-- tags: a -->\ntext\n", op: "add", scope: "note", tags: "b",
			want: bom + "<!-- tags: a, b -->\ntext\n", added: "b", at: 1},
		{name: "BOM: overflow under the first line has no second mark", text: bom + "<!-- tags: " + many(32) + " -->\ntext\n", op: "add", scope: "note", tags: "b",
			want: bom + "<!-- tags: " + many(32) + " -->\n<!-- tags: b -->\ntext\n", added: "b", at: 2},
		{name: "BOM: deleting the first line moves the mark", text: bom + "<!-- tags: a -->\ntext\n", op: "remove", scope: "note", tags: "a",
			want: bom + "text\n", removed: "a"},
		{name: "BOM: an entry", text: bom + "# H\nbody\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: bom + "# H\n<!-- tags: a -->\nbody\n", added: "a", at: 2, entryTags: "a"},
		{name: "no newline at the end: after a heading in the middle", text: "# H\nbody", op: "add", scope: "entry", line: 2, tags: "a",
			want: "# H\n<!-- tags: a -->\nbody", added: "a", at: 2},
		{name: "no newline at the end: the heading is the last line", text: "# H", op: "add", scope: "entry", line: 1, tags: "a",
			want: "# H\n<!-- tags: a -->", added: "a", at: 2},
		{name: "no newline at the end: the comment is the last line, rewritten", text: "# H\n<!-- tags: a -->", op: "add", scope: "entry", line: 1, tags: "b",
			want: "# H\n<!-- tags: a, b -->", added: "b", at: 2},
		{name: "no newline at the end: the comment is the last line, deleted", text: "# H\n<!-- tags: a -->", op: "remove", scope: "entry", line: 1, tags: "a",
			want: "# H", removed: "a"},
		{name: "no newline at the end, CRLF: the comment is the last line, deleted", text: "# H\r\n<!-- tags: a -->", op: "remove", scope: "entry", line: 1, tags: "a",
			want: "# H", removed: "a"},
		{name: "the only line is the comment, deleted", text: "<!-- tags: a -->", op: "remove", scope: "note", tags: "a",
			want: "", removed: "a"},
		{name: "empty text", text: "", op: "add", scope: "note", tags: "a",
			want: "<!-- tags: a -->\n", added: "a", at: 1, noteTags: "a"},
		{name: "empty text, entry", text: "", op: "add", scope: "entry", line: 1, tags: "a",
			want: "<!-- tags: a -->\n", scopeOut: "note", added: "a", at: 1},
		{name: "empty text, remove", text: "", op: "remove", scope: "note", tags: "a",
			want: "", code: "none_found", kept: "a"},
		{name: "a text of one newline", text: "\n", op: "add", scope: "note", tags: "a",
			want: "<!-- tags: a -->\n\n", added: "a", at: 1},
		{name: "mixed line endings: the first break decides", text: "# H\nbody\r\n# I\r\n", op: "add", scope: "entry", line: 2, tags: "a",
			want: "# H\n<!-- tags: a -->\nbody\r\n# I\r\n", added: "a", at: 2},

		// ---- show
		{name: "show an entry", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e, f -->\nbody\n", op: "show", scope: "entry", line: 5, tags: "",
			want: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e, f -->\nbody\n", noteTags: "n", entryTags: "e,f"},
		{name: "show the note", text: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e, f -->\nbody\n", op: "show", scope: "note", tags: "",
			want: "<!-- tags: n -->\nintro\n# H\n<!-- tags: e, f -->\nbody\n", noteTags: "n", entryTags: none},
		{name: "show the front part as an entry", text: "<!-- tags: n -->\nintro\n# H\nbody\n", op: "show", scope: "entry", line: 2, tags: "",
			want: "<!-- tags: n -->\nintro\n# H\nbody\n", scopeOut: "note", noteTags: "n", entryTags: none},
		{name: "show a file with a front matter", text: "---\ntags: [x, y]\n---\n# H\n<!-- tags: e -->\nbody\n", op: "show", scope: "entry", line: 6, tags: "",
			want: "---\ntags: [x, y]\n---\n# H\n<!-- tags: e -->\nbody\n", noteTags: "x,y", entryTags: "e"},
		{name: "show a text with no tag", text: "# H\nbody\n", op: "show", scope: "entry", line: 2, tags: "",
			want: "# H\nbody\n", noteTags: none, entryTags: none},
	}
	for _, c := range cases {
		t.Run(c.name, c.run)
	}
}

func TestEditTagsShowWithNoTagsAnswersEmptyLists(t *testing.T) {
	r, err := EditTags([]byte("# H\nbody\n"), "show", "entry", 2, nil)
	if err != nil || r.Changed || len(r.NoteTags) != 0 || len(r.EntryTags) != 0 || r.NoteTags == nil || r.EntryTags == nil {
		t.Errorf("%+v %v", r, err)
	}
	b, _ := json.Marshal(r)
	if strings.Contains(string(b), "null") {
		t.Errorf("the JSON has a null: %s", b)
	}
	var back map[string]interface{}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"changed", "scope", "start_line", "end_line", "new_lines", "eol", "line", "added", "removed", "unchanged", "note_tags", "entry_tags", "message_code", "range_start", "range_end", "heading", "heading_line",
		"descendants", "inherited_tags", "path", "parent_heading", "parent_line"} {
		if _, ok := back[k]; !ok {
			t.Errorf("the JSON has no %q: %s", k, b)
		}
	}
	if len(back) != 22 {
		t.Errorf("the JSON has %d keys: %s", len(back), b)
	}
}

func TestEditTagsRefusesABadRequest(t *testing.T) {
	text := []byte("# H\nbody\n")
	long := strings.Repeat("x", 65)
	bad := []struct {
		name         string
		op, scope    string
		line         int
		tags         []string
		wantInErrMsg string
	}{
		{"unknown op", "set", "note", 0, []string{"a"}, "unknown op"},
		{"empty op", "", "note", 0, []string{"a"}, "unknown op"},
		{"unknown scope", "add", "file", 0, []string{"a"}, "unknown scope"},
		{"empty scope", "add", "", 0, []string{"a"}, "unknown scope"},
		{"no tags", "add", "note", 0, nil, "no tag"},
		{"empty tags", "add", "note", 0, []string{"", " "}, "no tag"},
		{"only a hash", "remove", "note", 0, []string{"#"}, "no tag"},
		{"nine tags", "add", "note", 0, []string{"a,b,c,d,e,f,g,h,i"}, "too many tags"},
		{"nine tags in a list", "add", "note", 0, []string{"a,b,c,d", "e,f,g,h", "i"}, "too many tags"},
		{"a tag of 65 characters", "add", "note", 0, []string{long}, "longer than 64"},
		{"a comment end in a tag", "add", "note", 0, []string{"a-->b"}, "cannot contain"},
		{"a comment end in a full-width tag", "add", "note", 0, []string{"a－－＞b"}, "cannot contain"},
		{"a comment start in a tag", "add", "note", 0, []string{"x<!--y"}, "cannot contain"},
		{"entry without a line", "add", "entry", 0, []string{"a"}, "outside the text"},
		{"entry with a negative line", "add", "entry", -1, []string{"a"}, "outside the text"},
		{"line past the end", "add", "entry", 4, []string{"a"}, "outside the text (1 to 3)"},
		{"show with a bad line", "show", "entry", 99, nil, "outside the text"},
	}
	for _, c := range bad {
		r, err := EditTags(text, c.op, c.scope, c.line, c.tags)
		if err == nil || !strings.Contains(err.Error(), c.wantInErrMsg) || strings.Contains(err.Error(), "\n") || r.Changed {
			t.Errorf("%s: %+v, %v; want an error with %q", c.name, r, err, c.wantInErrMsg)
		}
	}
	// 8 tags are fine, a tag of 64 characters is fine, a tag with a colon is fine
	for _, tags := range []string{"a,b,c,d,e,f,g,h", strings.Repeat("日", 64), "a:b", "x-y--z"} {
		if r, err := EditTags(text, "add", "note", 0, []string{tags}); err != nil || !r.Changed {
			t.Errorf("%q: %+v, %v", tags, r, err)
		}
	}
	// 16 MB is the bound
	big := make([]byte, MaxTagEditBytes+1)
	if _, err := EditTags(big, "show", "note", 0, nil); err == nil || !strings.Contains(err.Error(), "16 MB") {
		t.Errorf("a text over 16 MB: %v", err)
	}
	if _, err := EditTags(big[:MaxTagEditBytes], "show", "note", 0, nil); err != nil {
		t.Errorf("a text of 16 MB: %v", err)
	}
	// a line outside the text does not matter to the note scope (it is not used)
	if _, err := EditTags(text, "add", "note", 99, []string{"a"}); err != nil {
		t.Errorf("note with a line: %v", err)
	}
}

// Tags a person writes by hand in all the ways ParseTagList accepts end up as plain normalized tags in the comment.
func TestEditTagsWritesNormalizedTags(t *testing.T) {
	_, got := editTags(t, "# H\nbody\n", "add", "entry", 2, "#仕事、 Ｒｅｐｏｒｔ；急ぎ  ＃買い物")
	if want := "# H\n<!-- tags: 仕事, report, 急ぎ, 買い物 -->\nbody\n"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// What the patch says (start, end, new lines) is a contract the window depends on; pin the shape of the common ones.
func TestEditTagsPatchShape(t *testing.T) {
	r, _ := editTags(t, "# H\nbody\n", "add", "entry", 2, "a")
	if !reflect.DeepEqual(r, TagEdit{Changed: true, Scope: "entry", StartLine: 2, EndLine: 2, NewLines: []string{"<!-- tags: a -->"}, Eol: "\n", Line: 2,
		Added: []string{"a"}, Removed: []string{}, Unchanged: []string{}, NoteTags: []string{}, EntryTags: []string{"a"},
		RangeStart: 1, RangeEnd: 2, Heading: "H", HeadingLine: 1, InheritedTags: []string{},
		Path: []TagPathEntry{{Line: 1, Level: 1, Heading: "H", RangeStart: 1, RangeEnd: 2, Tags: []string{}}}}) {
		t.Errorf("insert: %+v", r)
	}
	r, _ = editTags(t, "# H\n<!-- tags: a -->\nbody\n", "add", "entry", 3, "b")
	if r.StartLine != 2 || r.EndLine != 3 || !reflect.DeepEqual(r.NewLines, []string{"<!-- tags: a, b -->"}) {
		t.Errorf("rewrite: %+v", r)
	}
	r, _ = editTags(t, "# H\n<!-- tags: a -->\nbody\n", "remove", "entry", 3, "a")
	if r.StartLine != 2 || r.EndLine != 3 || len(r.NewLines) != 0 || r.Line != 0 {
		t.Errorf("delete: %+v", r)
	}
	r, _ = editTags(t, "# H\r\nbody\r\n", "add", "note", 0, "a")
	if r.Eol != "\r\n" || r.StartLine != 1 || r.EndLine != 1 {
		t.Errorf("CRLF note: %+v", r)
	}
}

func TestTagEditApplyAtTheEndOfTheText(t *testing.T) {
	cases := []struct {
		name, text string
		e          TagEdit
		want       string
	}{
		{"append after a terminated line", "a\n", TagEdit{Changed: true, StartLine: 2, EndLine: 2, NewLines: []string{"x"}, Eol: "\n"}, "a\nx\n"},
		{"append after an unterminated line", "a", TagEdit{Changed: true, StartLine: 2, EndLine: 2, NewLines: []string{"x"}, Eol: "\n"}, "a\nx"},
		{"append after an unterminated line, CRLF", "a", TagEdit{Changed: true, StartLine: 2, EndLine: 2, NewLines: []string{"x", "y"}, Eol: "\r\n"}, "a\r\nx\r\ny"},
		{"replace an unterminated last line", "a\nb", TagEdit{Changed: true, StartLine: 2, EndLine: 3, NewLines: []string{"x"}, Eol: "\n"}, "a\nx"},
		{"delete an unterminated last line", "a\nb", TagEdit{Changed: true, StartLine: 2, EndLine: 3, Eol: "\n"}, "a"},
		{"delete an unterminated last line, CRLF", "a\r\nb", TagEdit{Changed: true, StartLine: 2, EndLine: 3, Eol: "\r\n"}, "a"},
		{"delete a terminated last line", "a\nb\n", TagEdit{Changed: true, StartLine: 2, EndLine: 3, Eol: "\n"}, "a\n"},
		{"delete every line", "a", TagEdit{Changed: true, StartLine: 1, EndLine: 2, Eol: "\n"}, ""},
		{"insert into an empty text", "", TagEdit{Changed: true, StartLine: 1, EndLine: 1, NewLines: []string{"x"}, Eol: "\n"}, "x\n"},
		{"the first line", "a\nb\n", TagEdit{Changed: true, StartLine: 1, EndLine: 2, NewLines: []string{"x", "y"}, Eol: "\n"}, "x\ny\nb\n"},
		{"a missing Eol is a newline", "a\n", TagEdit{Changed: true, StartLine: 1, EndLine: 1, NewLines: []string{"x"}}, "x\na\n"},
		{"a patch past the end appends", "a\n", TagEdit{Changed: true, StartLine: 9, EndLine: 9, NewLines: []string{"x"}, Eol: "\n"}, "a\nx\n"},
		{"unchanged", "a\n", TagEdit{StartLine: 1, EndLine: 2, NewLines: []string{"x"}, Eol: "\n"}, "a\n"},
	}
	for _, c := range cases {
		if got := string(c.e.Apply([]byte(c.text))); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
		if c.e.Changed {
			if ref := refApply(c.text, c.e); ref != c.want && c.name != "a missing Eol is a newline" && c.name != "a patch past the end appends" {
				t.Errorf("%s: the line splice gives %q, want %q", c.name, ref, c.want)
			}
		}
	}
	// Apply does not write into the text it is given
	src := []byte("# H\nbody\n")
	keep := string(src)
	_ = TagEdit{Changed: true, StartLine: 2, EndLine: 2, NewLines: []string{"x"}, Eol: "\n"}.Apply(src)
	if string(src) != keep {
		t.Errorf("Apply wrote into its input: %q", src)
	}
}

// A comment edit changes only its own lines: every other byte of the text is as it was.
func TestEditTagsKeepsEveryOtherByte(t *testing.T) {
	text := "\xEF\xBB\xBFintro \t \r\n\r\n# 見出し\t\r\n<!--  tags :  a ,b  -->  \r\n  indented  \r\n```\r\n<!-- tags: fake -->\r\n```\r\n\r\n---\r\n## [10:05:00] ping  \r\nbody without end"
	r, got := editTags(t, text, "add", "entry", 4, "c")
	lines := strings.Split(text, "\r\n")
	newLines := strings.Split(got, "\r\n")
	if len(newLines) != len(lines) {
		t.Fatalf("the line count changed: %d to %d", len(lines), len(newLines))
	}
	for i := range lines {
		if i == 3 {
			if newLines[i] != "<!-- tags: a, b, c -->" {
				t.Errorf("rewritten: %q (%+v)", newLines[i], r)
			}
			continue
		}
		if newLines[i] != lines[i] {
			t.Errorf("line %d changed: %q to %q", i+1, lines[i], newLines[i])
		}
	}
}

// ---- the property test ------------------------------------------------------------------------------------------------------------

// propertyCases is how many random notes TestEditTagsProperty tries; a longer run (-tagedit.cases=200000) is for after a change to the editor.
var propertyCases = flag.Int("tagedit.cases", 2000, "random notes for TestEditTagsProperty")

// A small set, so that a request often meets a tag that is there already, and a removal often finds its tag.
var propertyTags = []string{"a", "b", "c", "仕事", "急ぎ"}

// randomNote builds a note out of the things the reader cares about: headings, rules, fences, tag comments (some inside a fence),
// a front matter, a byte order mark, CRLF or LF, a missing final newline.
func randomNote(rng *rand.Rand) string {
	var lines []string
	tagLine := func() string {
		n := 1 + rng.Intn(3)
		var tags []string
		for i := 0; i < n; i++ {
			tags = append(tags, propertyTags[rng.Intn(len(propertyTags))])
		}
		key := []string{"tags", "tags", "tags", "Tag", "TAGS"}[rng.Intn(5)]
		ind := []string{"", "", "", "  ", "\t"}[rng.Intn(5)]
		return ind + "<!-- " + key + ": " + strings.Join(tags, []string{", ", " ", "、"}[rng.Intn(3)]) + " -->"
	}
	switch rng.Intn(8) {
	case 0:
		lines = append(lines, "---", "title: t", "tags: ["+propertyTags[rng.Intn(len(propertyTags))]+", z]", "---")
	case 1:
		lines = append(lines, "---", "title: t", "---")
	case 2, 3:
		lines = append(lines, tagLine(), "a front part with tags for the whole note") // above every heading: tags of the note
	}
	pieces := []func(){
		func() { lines = append(lines, "# 見出し"+strconv.Itoa(rng.Intn(9))) },
		func() { lines = append(lines, "## [10:0"+strconv.Itoa(rng.Intn(9))+":00] title") },
		func() { lines = append(lines, "---", "## [11:00:00] after a rule") },
		func() { lines = append(lines, "---") },
		func() { lines = append(lines, "plain text "+strconv.Itoa(rng.Intn(99))) },
		func() { lines = append(lines, "") },
		func() { lines = append(lines, tagLine()) },
		func() { lines = append(lines, tagLine()) },
		func() { lines = append(lines, "## [10:30:00] heading and its tags", tagLine()) },
		func() { lines = append(lines, "# 見出し", tagLine(), "text", tagLine()) },
		func() { lines = append(lines, "### 小見出し"+strconv.Itoa(rng.Intn(9))) },
		func() { lines = append(lines, "## 中見出し"+strconv.Itoa(rng.Intn(9))) },
		func() { lines = append(lines, "#### 深い見出し", "text") }, // not an entry: part of the one above
		func() { lines = append(lines, "  ## 字下げの見出し") },
		func() { lines = append(lines, "---", "### after a rule") },
		func() { lines = append(lines, "# 記事", tagLine(), "## 章", "### 節", tagLine(), "text") }, // an article: tags above and below its headings
		func() { lines = append(lines, "## 章", "### 節", "text", "## 章2", tagLine()) },
		func() { lines = append(lines, "<!-- just a comment -->") },
		func() { lines = append(lines, "<!-- tags: a --> trailing") },
		func() { lines = append(lines, "```", "# not a heading", tagLine(), "---", "```") },
		func() { lines = append(lines, "~~~~", "<!-- tags: fake -->", "~~~~~") },
		func() {
			if rng.Intn(4) == 0 {
				lines = append(lines, "~~~~", "<!-- tags: fake -->") // never closed: the rest of the note is code
			}
		},
		func() { lines = append(lines, "<!-- tags:") }, // a comment that goes on
		func() { lines = append(lines, "-->") },
	}
	for i, n := 0, 2+rng.Intn(14); i < n; i++ {
		pieces[rng.Intn(len(pieces))]()
	}
	eol := []string{"\n", "\n", "\r\n"}[rng.Intn(3)]
	text := strings.Join(lines, eol)
	if len(lines) > 0 && rng.Intn(4) > 0 {
		text += eol
	}
	if rng.Intn(6) == 0 {
		text = "\xEF\xBB\xBF" + text
	}
	return text
}

// ownTags reads what ScanTags says of a text: the tags of the whole file, and for every entry that is a real entry (not the front part
// of the file) its first line and its own tags, in order.
func ownTags(data []byte) (file []string, starts []int, own [][]string) {
	m := ScanTags(data)
	file = m.FileTags()
	es := Entries(data)
	preamble := false
	if len(es) > 0 {
		first := firstLine(data)
		preamble = !isRuleLine(first) && !isEntryHeading(first)
	}
	for i, e := range es {
		if i == 0 && preamble {
			continue
		}
		starts = append(starts, e.StartLine)
		own = append(own, m.EntryTags(i))
	}
	return
}

// sameOwnTags: two lists of the entries' own tags are the same, leaving out the entry at index skip (-1: none).
func sameOwnTags(a, b [][]string, skip int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if i != skip && !sameTags(a[i], b[i]) {
			return false
		}
	}
	return true
}

func sameTags(a, b []string) bool {
	return len(a) == len(b) && (len(a) == 0 || reflect.DeepEqual(a, b))
}

func TestEditTagsProperty(t *testing.T) {
	cases := *propertyCases
	stats := map[string]int{}
	for seed := int64(0); seed < int64(cases); seed++ {
		rng := rand.New(rand.NewSource(seed))
		text := randomNote(rng)
		data := []byte(text)
		op := []string{"add", "add", "remove", "remove", "show"}[rng.Intn(5)]
		scope := []string{"entry", "entry", "note"}[rng.Intn(3)]
		nl := strings.Count(text, "\n")
		line := 1 + rng.Intn(nl+1)
		var tags []string
		for i, n := 0, 1+rng.Intn(3); i < n; i++ {
			tags = append(tags, propertyTags[rng.Intn(len(propertyTags))])
		}
		if rng.Intn(10) == 0 {
			tags = append(tags, "#Ｚ") // normalized to "z", which the notes only have in a front matter
		}
		fail := func(format string, args ...interface{}) {
			t.Helper()
			t.Fatalf("seed %d: %s %s line %d tags %q on %q: %s", seed, op, scope, line, tags, text, fmt.Sprintf(format, args...))
		}

		r, err := EditTags(data, op, scope, line, tags)
		if err != nil {
			fail("%v", err)
		}
		want := ParseTagList(strings.Join(tags, ","))
		got := r.Apply(data)
		stats[op+"/"+r.Scope]++
		if msg := checkAnswerAgainstOutline(text, op, line, want, r); msg != "" {
			fail("%s", msg) // the range, the descendants, the path, what a request is told about the headings above
		}

		if r.Changed {
			if ref := refApply(text, r); string(got) != ref {
				fail("Apply %q, line splice %q (%+v)", got, ref, r)
			}
		}
		if !r.Changed && string(got) != text {
			fail("unchanged but Apply gives %q", got)
		}
		if r.Changed {
			stats["changed/"+op]++
			// every line ends the way the text's lines do
			if r.Eol == "\r\n" && strings.Contains(strings.ReplaceAll(string(got), "\r\n", ""), "\n") && !strings.Contains(strings.ReplaceAll(text, "\r\n", ""), "\n") {
				fail("a bare newline in %q", got)
			}
			if r.Eol == "\n" && !strings.Contains(text, "\r") && strings.Contains(string(got), "\r") {
				fail("a carriage return in %q", got)
			}
			if strings.HasPrefix(text, string(utf8BOM)) != strings.HasPrefix(string(got), string(utf8BOM)) && string(got) != "" {
				fail("the byte order mark moved: %q", got)
			}
			// (taking the last line away from "a\n\nb" leaves "a\n" + "": an empty line is now the last, and it reads as a final newline)
			lastLine := strings.Count(text, "\n") + btoi(!strings.HasSuffix(text, "\n"))
			if !(op == "remove" && r.EndLine > lastLine) && strings.HasSuffix(text, "\n") != strings.HasSuffix(string(got), "\n") && text != "" && string(got) != "" {
				fail("the final newline changed: %q", got)
			}
		} else {
			if r.MessageCode == "" && op != "show" {
				fail("nothing changed and no message_code: %+v", r)
			}
			stats["code/"+r.MessageCode]++
		}
		if r.Line != 0 && r.Changed {
			if lines := strings.Split(strings.ReplaceAll(string(got), "\r\n", "\n"), "\n"); r.Line > len(lines) || !strings.Contains(lines[r.Line-1], "<!--") {
				fail("Line %d is not the tag comment: %q", r.Line, got)
			}
		}

		// ---- what ScanTags says before and after
		beforeFile, beforeStarts, beforeOwn := ownTags(data)
		afterFile, afterStarts, afterOwn := ownTags(got)
		if !sameTags(r.NoteTags, afterFile) {
			fail("note_tags %q, ScanTags %q", r.NoteTags, afterFile)
		}
		if op == "show" || !r.Changed {
			continue
		}
		for _, a := range r.Added {
			if !hasTag(want, a) {
				fail("added %q, which was not asked for", a)
			}
		}
		if bomHidesStructure(text) || bomHidesStructure(string(got)) {
			// Entries (like the searches) does not look past a byte order mark: a heading, rule or fence on the first line goes unseen
			// while the mark is there. An edit that moves the mark on or off such a line changes what the entries are.
			stats["byte order mark in front of a structural line"]++
			continue
		}
		idx := -1 // the entry the edit was about, among the real entries (by its first line, which an edit never moves)
		if r.Scope == "entry" {
			l := min(line, strings.Count(text, "\n")+btoi(!strings.HasSuffix(text, "\n")))
			for _, e := range Entries(data) {
				if e.StartLine <= l && l <= e.EndLine {
					for j, s := range beforeStarts {
						if s == e.StartLine {
							idx = j
						}
					}
				}
			}
			if idx < 0 {
				fail("no entry for line %d", line)
			}
		}
		structureSame := len(beforeStarts) == len(afterStarts)
		if !structureSame {
			// Taking a comment out from between a rule and its heading makes them one entry; that is the only way an edit changes the
			// entries, and it makes a statement about "the entry" meaningless.
			if r.Scope != "entry" || op != "remove" {
				fail("the entries changed: %v to %v", beforeStarts, afterStarts)
			}
			stats["entry structure changed"]++
			continue
		}
		if r.Scope == "note" {
			for _, a := range r.Added {
				if !hasTag(afterFile, a) || hasTag(beforeFile, a) {
					fail("added %q: note tags %q to %q", a, beforeFile, afterFile)
				}
			}
			for _, x := range r.Removed {
				if hasTag(afterFile, x) || !hasTag(beforeFile, x) {
					fail("removed %q: note tags %q to %q", x, beforeFile, afterFile)
				}
			}
			if !sameOwnTags(beforeOwn, afterOwn, -1) {
				fail("an entry's tags changed: %v to %v", beforeOwn, afterOwn)
			}
			stats["checked note"]++
		} else {
			if !sameTags(beforeFile, afterFile) {
				fail("the note's tags changed: %q to %q", beforeFile, afterFile)
			}
			for _, a := range r.Added {
				if !hasTag(afterOwn[idx], a) {
					fail("added %q is not in the entry afterwards: %q", a, afterOwn[idx])
				}
			}
			for _, x := range r.Removed {
				if hasTag(afterOwn[idx], x) || !hasTag(beforeOwn[idx], x) {
					fail("removed %q: the entry's tags %q to %q", x, beforeOwn[idx], afterOwn[idx])
				}
			}
			if !sameTags(r.EntryTags, afterOwn[idx]) {
				fail("entry_tags %q, ScanTags %q", r.EntryTags, afterOwn[idx])
			}
			if !sameOwnTags(beforeOwn, afterOwn, idx) {
				fail("another entry's tags changed: %v to %v", beforeOwn, afterOwn)
			}
			stats["checked entry"]++
			if msg := checkEditReach(text, string(got), op, line, r, stats); msg != "" {
				fail("%s", msg) // a tag written in an entry reaches exactly the entries under its heading
			}
		}

		// ---- a second identical request changes nothing
		probe := line
		if r.Scope == "entry" {
			probe = beforeStarts[idx]
		}
		again, err := EditTags(got, op, r.Scope, probe, tags)
		if err != nil {
			fail("second run: %v", err)
		}
		if again.Changed {
			fail("not idempotent: the second run changed %q with %+v", got, again)
		}
	}
	t.Logf("%d cases: %v", cases, stats)
	for _, k := range []string{"changed/add", "changed/remove", "checked entry", "checked note", "code/already", "code/none_found", "code/front_matter",
		"code/on_note", "code/on_entry", "code/front_matter_tag", "code/on_parent", "reach: add checked", "reach: remove checked",
		"reach: remove and add again"} {
		if stats[k] < 20 {
			t.Errorf("only %d cases reached %q; the generator is not covering it", stats[k], k)
		}
	}
}

// bomHidesStructure: the text starts with a byte order mark and a line that is a heading, a rule or a fence.
func bomHidesStructure(text string) bool {
	rest := strings.TrimPrefix(text, string(utf8BOM))
	if rest == text {
		return false
	}
	first := strings.TrimLeft(strings.SplitN(rest, "\n", 2)[0], " ")
	return first != "" && strings.ContainsRune("#-`~", rune(first[0]))
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// The screen words where a tag goes ("under "Part A" (line 5)", "Entry "Part A" (lines 4-8)"): the answer says where the range is and
// which heading it has, for every op (show too), in the OLD text.
func TestEditTagsReportsWhereTheRangeIs(t *testing.T) {
	text := "# Title\nintro\n\n## Part A\na1\na2\n\n#### deep\nd1\n\n---\n## [10:05:00] ping\nlog\n\n---\nbare rule\n"
	cases := []struct {
		name        string
		scope       string
		line        int
		start, end  int
		heading     string
		headingLine int
		wantScope   string
	}{
		{"an entry with a heading", "entry", 5, 4, 10, "Part A", 4, "entry"},
		{"a deeper heading is not a boundary: the caret under #### is still Part A", "entry", 9, 4, 10, "Part A", 4, "entry"},
		{"the first entry (the title): its range is the subtree, down to the end of Part A", "entry", 2, 1, 10, "Title", 1, "entry"},
		{"a rule followed by a heading: the heading is the heading", "entry", 13, 11, 14, "[10:05:00] ping", 12, "entry"},
		{"a rule with no heading below it has none", "entry", 16, 15, 16, "", 0, "entry"},
		{"the whole note", "note", 1, 1, 16, "", 0, "note"},
	}
	for _, c := range cases {
		for _, op := range []string{"show", "add"} {
			var tags []string
			if op == "add" {
				tags = []string{"x"}
			}
			r, err := EditTags([]byte(text), op, c.scope, c.line, tags)
			if err != nil {
				t.Fatalf("%s %s: %v", c.name, op, err)
			}
			if r.Scope != c.wantScope || r.RangeStart != c.start || r.RangeEnd != c.end || r.Heading != c.heading || r.HeadingLine != c.headingLine {
				t.Errorf("%s (%s): scope %s range %d-%d heading %q at %d; want scope %s range %d-%d heading %q at %d", c.name, op,
					r.Scope, r.RangeStart, r.RangeEnd, r.Heading, r.HeadingLine, c.wantScope, c.start, c.end, c.heading, c.headingLine)
			}
		}
	}
	// a front part is the whole note, so an entry request there reports the whole note
	r, _ := EditTags([]byte("intro\n# H\nbody\n"), "show", "entry", 1, nil)
	if r.Scope != "note" || r.RangeStart != 1 || r.RangeEnd != 3 || r.Heading != "" {
		t.Errorf("front part: %+v", r)
	}
	// the heading's line is the same in the new text (the tag line goes under it)
	add, newText := editTags(t, text, "add", "entry", 5, "x")
	if got := strings.Split(newText, "\n")[add.HeadingLine-1]; !strings.HasPrefix(got, "## Part A") {
		t.Errorf("the heading line %d of the new text is %q", add.HeadingLine, got)
	}
}
