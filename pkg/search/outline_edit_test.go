package search

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// EditTags and the outline (docs/design/tag-filter-2026-10.md sections 11.2 and 11.6): where a tag reaches, what a tag that comes from
// a heading above is told, and the new fields of the answer.

// pathString shows a path in one line: line/level/heading/range/descendants/own tags, the elements joined by " | ".
func pathString(path []TagPathEntry) string {
	var parts []string
	for _, p := range path {
		tags := strings.Join(p.Tags, ",")
		if tags == "" {
			tags = "-"
		}
		parts = append(parts, fmt.Sprintf("L%d/h%d/%s/%d-%d/d%d/%s", p.Line, p.Level, p.Heading, p.RangeStart, p.RangeEnd, p.Descendants, tags))
	}
	return strings.Join(parts, " | ")
}

type outlineCase struct {
	name, text, op   string
	line             int // 0: the whole note
	tags             string
	code             string // message_code
	added, removed   string // comma-joined
	unchanged        string
	parent           string // "heading@line" of parent_heading and parent_line, "" for none
	rng              string // "start-end" (range_start and range_end of the OLD text)
	desc             int
	inherited        string
	path             string
	scopeOut         string // "" for the scope asked for
	newText          string // the text after the edit (not looked at when empty; the old text is meant when changed is false: use same)
	same             bool   // the text is unchanged
	heading          string // "heading@line"
	noBOM            bool   // not with a byte order mark: the rule on the first line would not be seen (Entries does not look past the mark)
	entryTags        string // comma-joined, "-" for none, "" for not looked at
	noteTags         string // likewise
	changedIsPartial bool   // something was done and something was not (changed with a message_code)
}

// the article note of outline_test.go: lines and entries are written there
const (
	articlePath3 = "L7/h3/乾燥/7-8/d0/- | L4/h2/加工/4-8/d1/工程 | L1/h1/記事/1-10/d3/素材"
	articlePath2 = "L4/h2/加工/4-8/d1/工程 | L1/h1/記事/1-10/d3/素材"
)

func outlineCases() []outlineCase {
	return []outlineCase{
		// ---- show: the range, the descendants, the path
		{name: "show a ### two levels down", text: articleNote, op: "show", line: 8, rng: "7-8", desc: 0, inherited: "素材,工程", path: articlePath3,
			heading: "乾燥@7", same: true, entryTags: "-"},
		{name: "show the middle heading", text: articleNote, op: "show", line: 5, rng: "4-8", desc: 1, inherited: "素材", path: articlePath2, heading: "加工@4", same: true,
			entryTags: "工程"},
		{name: "show the top heading: its range is the subtree", text: articleNote, op: "show", line: 3, rng: "1-10", desc: 3, inherited: "",
			path: "L1/h1/記事/1-10/d3/素材", heading: "記事@1", same: true, entryTags: "素材"},
		{name: "show the next article: not under the first", text: articleNote, op: "show", line: 12, rng: "11-12", desc: 0, inherited: "",
			path: "L11/h1/別の記事/11-12/d0/-", heading: "別の記事@11", same: true},
		{name: "show a sibling of the middle heading", text: articleNote, op: "show", line: 10, rng: "9-10", desc: 0, inherited: "素材",
			path: "L9/h2/利用/9-10/d0/- | L1/h1/記事/1-10/d3/素材", heading: "利用@9", same: true},
		{name: "show the whole note", text: articleNote, op: "show", line: 0, rng: "1-12", desc: 0, path: "", scopeOut: "note", same: true},
		{name: "a line in the front part is the whole note", text: "intro\n# A\n<!-- tags: a -->\n## B\n", op: "show", line: 1, rng: "1-4", desc: 0, path: "", scopeOut: "note", same: true},
		{name: "a skipped level: the ### is under the #", text: "# A\n<!-- tags: a -->\n### C\ntext\n", op: "show", line: 4, rng: "3-4", desc: 0, inherited: "a",
			path: "L3/h3/C/3-4/d0/- | L1/h1/A/1-4/d1/a", heading: "C@3", same: true},
		{name: "a #### is text of the entry above and not a boundary", text: "# A\n<!-- tags: a -->\n#### deep\ntext\n## B\nb\n", op: "show", line: 3, rng: "1-6", desc: 1,
			path: "L1/h1/A/1-6/d1/a", heading: "A@1", same: true},
		{name: "a rule alone breaks the chain: the ### after it is a root", text: "# A\n<!-- tags: a -->\n## B\n---\ntext\n### C\n", op: "show", line: 6, rng: "6-6", desc: 0,
			path: "L6/h3/C/6-6/d0/-", heading: "C@6", same: true},
		{name: "the rule alone is an entry of level 0 with no heading", text: "# A\n<!-- tags: a -->\n## B\n---\ntext\n### C\n", op: "show", line: 5, rng: "4-5", desc: 0,
			path: "L4/h0//4-5/d0/-", heading: "@0", same: true},
		{name: "A is the top of its own subtree down to the rule", text: "# A\n<!-- tags: a -->\n## B\n---\ntext\n### C\n", op: "show", line: 1, rng: "1-3", desc: 1,
			path: "L1/h1/A/1-3/d1/a", heading: "A@1", same: true},
		{name: "a rule and its heading: the heading's line, the rule's entry", noBOM: true, text: "---\n## ping\n<!-- tags: 急ぎ -->\n### 詳細\n本文\n---\n### 別\n", op: "show", line: 5, rng: "4-5", desc: 0,
			inherited: "急ぎ", path: "L4/h3/詳細/4-5/d0/- | L2/h2/ping/1-5/d1/急ぎ", heading: "詳細@4", same: true},
		{name: "the next outline that opens with a rule is a root", noBOM: true, text: "---\n## ping\n<!-- tags: 急ぎ -->\n### 詳細\n本文\n---\n### 別\n", op: "show", line: 7, rng: "6-7", desc: 0,
			path: "L7/h3/別/6-7/d0/-", heading: "別@7", same: true},
		{name: "a # under a ## log heading is its own outline", noBOM: true, text: "---\n## [10:05:00] clip\n<!-- tags: 記事 -->\n# Title\n## Chapter\ntext\n", op: "show", line: 6, rng: "5-6", desc: 0,
			inherited: "", path: "L5/h2/Chapter/5-6/d0/- | L4/h1/Title/4-6/d1/-", heading: "Chapter@5", same: true},
		{name: "a front matter note: the heading below it is a root", text: "---\ntags: [x]\n---\n# A\n<!-- tags: a -->\n## B\ntext\n", op: "show", line: 7, rng: "6-7", desc: 0, inherited: "a",
			path: "L6/h2/B/6-7/d0/- | L4/h1/A/3-7/d1/a", heading: "B@6", same: true, noteTags: "x"},
		{name: "a heading right after a rule is that entry's heading, its ### is a child", text: "# A\n---\n## B\n<!-- tags: b -->\n### C\ntext\n", op: "show", line: 6, rng: "5-6", desc: 0,
			inherited: "b", path: "L5/h3/C/5-6/d0/- | L3/h2/B/2-6/d1/b", heading: "C@5", same: true},

		// ---- add: what an entry has already, from above
		{name: "add a tag the heading above has: already", text: articleNote, op: "add", line: 8, tags: "素材", code: "already", unchanged: "素材", rng: "7-8", inherited: "素材,工程",
			path: articlePath3, heading: "乾燥@7", same: true},
		{name: "add two tags that come from two headings above: already", text: articleNote, op: "add", line: 8, tags: "工程, 素材", code: "already", unchanged: "工程,素材", rng: "7-8",
			inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", same: true},
		{name: "add a new tag: the entry's own lines are edited, the answer is about the old text", text: articleNote, op: "add", line: 8, tags: "新", added: "新", rng: "7-8",
			inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", entryTags: "新",
			newText: "# 記事\n<!-- tags: 素材 -->\n竹の導入\n## 加工\n<!-- tags: 工程 -->\n竹を加工する\n### 乾燥\n<!-- tags: 新 -->\n竹を乾燥する\n## 利用\n竹の利用\n# 別の記事\n竹とは別の話\n"},
		{name: "add one that is above and one that is new: the first is unchanged", text: articleNote, op: "add", line: 8, tags: "素材, 新", added: "新", unchanged: "素材", rng: "7-8",
			inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", entryTags: "新"},
		{name: "the next article does not have the first one's tag", text: articleNote, op: "add", line: 12, tags: "素材", added: "素材", rng: "11-12", path: "L11/h1/別の記事/11-12/d0/-",
			heading: "別の記事@11", entryTags: "素材",
			newText: "# 記事\n<!-- tags: 素材 -->\n竹の導入\n## 加工\n<!-- tags: 工程 -->\n竹を加工する\n### 乾燥\n竹を乾燥する\n## 利用\n竹の利用\n# 別の記事\n<!-- tags: 素材 -->\n竹とは別の話\n"},
		{name: "a sibling does not have the tag of the other: it is written", text: articleNote, op: "add", line: 10, tags: "工程", added: "工程", rng: "9-10", inherited: "素材",
			path: "L9/h2/利用/9-10/d0/- | L1/h1/記事/1-10/d3/素材", heading: "利用@9", entryTags: "工程"},
		{name: "a parent does not have the tag of its child: it is written", text: articleNote, op: "add", line: 3, tags: "工程", added: "工程", rng: "1-10", desc: 3,
			path: "L1/h1/記事/1-10/d3/素材", heading: "記事@1", entryTags: "素材,工程",
			newText: "# 記事\n<!-- tags: 素材, 工程 -->\n竹の導入\n## 加工\n<!-- tags: 工程 -->\n竹を加工する\n### 乾燥\n竹を乾燥する\n## 利用\n竹の利用\n# 別の記事\n竹とは別の話\n"},
		{name: "add under the top heading: the answer says how far it reaches", text: "# A\n## B\n### C\n# D\n", op: "add", line: 1, tags: "x", added: "x", rng: "1-3", desc: 2,
			path: "L1/h1/A/1-3/d2/-", heading: "A@1", entryTags: "x", newText: "# A\n<!-- tags: x -->\n## B\n### C\n# D\n"},
		{name: "a tag of the whole note is already there for every entry", text: "<!-- tags: n -->\nintro\n# A\n## B\n", op: "add", line: 4, tags: "n", code: "already", unchanged: "n", rng: "4-4",
			path: "L4/h2/B/4-4/d0/- | L3/h1/A/3-4/d1/-", inherited: "", heading: "B@4", same: true, noteTags: "n"},
		{name: "a tag of the front matter is already there for every entry", text: "---\ntags: [x]\n---\n# A\n## B\n", op: "add", line: 5, tags: "x", code: "already", unchanged: "x", rng: "5-5",
			path: "L5/h2/B/5-5/d0/- | L4/h1/A/3-5/d1/-", heading: "B@5", same: true, noteTags: "x"},
		{name: "adding to the note a tag that is under a heading still writes it", text: articleNote, op: "add", line: 0, tags: "素材", added: "素材", rng: "1-12", scopeOut: "note",
			newText: "<!-- tags: 素材 -->\n" + articleNote},

		// ---- remove: the entry's own lines only, and what is told when the tag is above
		{name: "remove a tag that a heading above has: on_parent, naming it", text: articleNote, op: "remove", line: 8, tags: "素材", code: "on_parent", unchanged: "素材",
			parent: "記事@1", rng: "7-8", inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", same: true},
		{name: "the nearest of the headings above that has it", text: articleNote, op: "remove", line: 8, tags: "工程", code: "on_parent", unchanged: "工程",
			parent: "加工@4", rng: "7-8", inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", same: true},
		{name: "the entry has another tag, the asked one is above", text: articleNote, op: "remove", line: 5, tags: "素材", code: "on_parent", unchanged: "素材",
			parent: "記事@1", rng: "4-8", desc: 1, inherited: "素材", path: articlePath2, heading: "加工@4", same: true, entryTags: "工程"},
		{name: "two tags above from two headings: the first tag gives the parent", text: articleNote, op: "remove", line: 8, tags: "素材, 工程", code: "on_parent", unchanged: "素材,工程",
			parent: "記事@1", rng: "7-8", inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", same: true},
		{name: "two tags above, the other way round", text: articleNote, op: "remove", line: 8, tags: "工程, 素材", code: "on_parent", unchanged: "工程,素材",
			parent: "加工@4", rng: "7-8", inherited: "素材,工程", path: articlePath3, heading: "乾燥@7", same: true},
		{name: "a tag the entry has itself is removed (and says nothing)", text: articleNote, op: "remove", line: 3, tags: "素材", removed: "素材", rng: "1-10", desc: 3,
			path: "L1/h1/記事/1-10/d3/素材", heading: "記事@1", entryTags: "-",
			newText: "# 記事\n竹の導入\n## 加工\n<!-- tags: 工程 -->\n竹を加工する\n### 乾燥\n竹を乾燥する\n## 利用\n竹の利用\n# 別の記事\n竹とは別の話\n"},
		{name: "a tag only a descendant has: none_found", text: articleNote, op: "remove", line: 3, tags: "工程", code: "none_found", unchanged: "工程", rng: "1-10", desc: 3,
			path: "L1/h1/記事/1-10/d3/素材", heading: "記事@1", same: true, entryTags: "素材"},
		{name: "one removed and one above: both said", text: "# A\n<!-- tags: p -->\n## B\n### C\n<!-- tags: c -->\ntext\n", op: "remove", line: 6, tags: "c, p", removed: "c", unchanged: "p",
			code: "on_parent", parent: "A@1", rng: "4-6", inherited: "p", path: "L4/h3/C/4-6/d0/c | L3/h2/B/3-6/d1/- | L1/h1/A/1-6/d2/p", heading: "C@4", entryTags: "-",
			newText: "# A\n<!-- tags: p -->\n## B\n### C\ntext\n", changedIsPartial: true},
		{name: "one removed, one that is nowhere: no message", text: "# A\n<!-- tags: p -->\n## B\n<!-- tags: c -->\n", op: "remove", line: 3, tags: "c, q", removed: "c", unchanged: "q", code: "",
			rng: "3-4", inherited: "p", path: "L3/h2/B/3-4/d0/c | L1/h1/A/1-4/d1/p", heading: "B@3", newText: "# A\n<!-- tags: p -->\n## B\n"},
		{name: "the same tag above twice: the nearest heading", text: "# A\n<!-- tags: s -->\n## B\n<!-- tags: s -->\n### C\ntext\n", op: "remove", line: 6, tags: "s", code: "on_parent", unchanged: "s", parent: "B@3",
			rng: "5-6", inherited: "s", path: "L5/h3/C/5-6/d0/- | L3/h2/B/3-6/d1/s | L1/h1/A/1-6/d2/s", heading: "C@5", same: true},
		{name: "a tag above and in the whole note: on_parent wins", text: "<!-- tags: s -->\nintro\n# A\n<!-- tags: s -->\n## B\ntext\n", op: "remove", line: 6, tags: "s", code: "on_parent",
			unchanged: "s", parent: "A@3", rng: "5-6", inherited: "s", path: "L5/h2/B/5-6/d0/- | L3/h1/A/3-6/d1/s", heading: "B@5", same: true, noteTags: "s"},
		{name: "a tag of the whole note only: on_note as before", text: "<!-- tags: n -->\nintro\n# A\n## B\ntext\n", op: "remove", line: 5, tags: "n", code: "on_note", unchanged: "n",
			rng: "4-5", path: "L4/h2/B/4-5/d0/- | L3/h1/A/3-5/d1/-", heading: "B@4", same: true, noteTags: "n"},
		{name: "a tag of the front matter only: front_matter_tag as before", text: "---\ntags: [x]\n---\n# A\n## B\ntext\n", op: "remove", line: 6, tags: "x", code: "front_matter_tag",
			unchanged: "x", rng: "5-6", path: "L5/h2/B/5-6/d0/- | L4/h1/A/3-6/d1/-", heading: "B@5", same: true, noteTags: "x"},
		{name: "the first tag with a place gives the message: on_note first, so no parent", text: "<!-- tags: n -->\nintro\n# A\n<!-- tags: p -->\n## B\ntext\n", op: "remove", line: 6, tags: "n, p",
			code: "on_note", unchanged: "n,p", rng: "5-6", inherited: "p", path: "L5/h2/B/5-6/d0/- | L3/h1/A/3-6/d1/p", heading: "B@5", same: true, noteTags: "n"},
		{name: "the first tag with a place gives the message: on_parent first", text: "<!-- tags: n -->\nintro\n# A\n<!-- tags: p -->\n## B\ntext\n", op: "remove", line: 6, tags: "p, n",
			code: "on_parent", unchanged: "p,n", parent: "A@3", rng: "5-6", inherited: "p", path: "L5/h2/B/5-6/d0/- | L3/h1/A/3-6/d1/p", heading: "B@5", same: true, noteTags: "n"},
		{name: "a tag nowhere before one above: the one above is told", text: "# A\n<!-- tags: p -->\n## B\ntext\n", op: "remove", line: 4, tags: "q, p", code: "on_parent", unchanged: "q,p",
			parent: "A@1", rng: "3-4", inherited: "p", path: "L3/h2/B/3-4/d0/- | L1/h1/A/1-4/d1/p", heading: "B@3", same: true},
		{name: "the parent is a rule and its heading: the heading's line", noBOM: true, text: "---\n## ping\n<!-- tags: 急ぎ -->\n### 詳細\n本文\n", op: "remove", line: 5, tags: "急ぎ", code: "on_parent",
			unchanged: "急ぎ", parent: "ping@2", rng: "4-5", inherited: "急ぎ", path: "L4/h3/詳細/4-5/d0/- | L2/h2/ping/1-5/d1/急ぎ", heading: "詳細@4", same: true},
		{name: "the whole note's remove of a tag under a heading: on_entry as before", text: articleNote, op: "remove", line: 0, tags: "工程", code: "on_entry", unchanged: "工程",
			rng: "1-12", scopeOut: "note", same: true},
		{name: "what the rule alone says: its break leaves the tag above out of reach", text: "# A\n<!-- tags: a -->\n## B\n---\ntext\n", op: "remove", line: 5, tags: "a", code: "none_found",
			unchanged: "a", rng: "4-5", path: "L4/h0//4-5/d0/-", heading: "@0", same: true},
	}
}

func splitRef(s string) (string, int) {
	if s == "" {
		return "", 0
	}
	i := strings.LastIndexByte(s, '@')
	var n int
	fmt.Sscanf(s[i+1:], "%d", &n)
	return s[:i], n
}

func (c outlineCase) run(t *testing.T, variant string) {
	t.Helper()
	text, newText := c.text, c.newText
	switch variant {
	case "crlf":
		text, newText = strings.ReplaceAll(text, "\n", "\r\n"), strings.ReplaceAll(newText, "\n", "\r\n")
	case "bom":
		text = testBOM + text
		if newText != "" {
			newText = testBOM + newText
		}
	}
	scope := "entry"
	if c.line == 0 {
		scope = "note"
	}
	r, got := editTags(t, text, c.op, scope, c.line, c.tags)
	fail := func(format string, args ...interface{}) { t.Errorf("%s: %s", variant, fmt.Sprintf(format, args...)) }
	if c.same && got != text {
		fail("the text changed: %q", got)
	}
	if newText != "" && got != newText {
		fail("new text %q, want %q", got, newText)
	}
	wantScope := c.scopeOut
	if wantScope == "" {
		wantScope = scope
	}
	if r.Scope != wantScope {
		fail("scope %q, want %q", r.Scope, wantScope)
	}
	if r.MessageCode != c.code {
		fail("message_code %q, want %q", r.MessageCode, c.code)
	}
	for _, p := range []struct {
		name string
		got  []string
		want string
	}{{"added", r.Added, c.added}, {"removed", r.Removed, c.removed}, {"unchanged", r.Unchanged, c.unchanged}, {"inherited_tags", r.InheritedTags, c.inherited}} {
		if g := strings.Join(p.got, ","); g != p.want {
			fail("%s = %q, want %q", p.name, g, p.want)
		}
	}
	if c.entryTags != "" {
		want := c.entryTags
		if want == "-" {
			want = ""
		}
		if g := strings.Join(r.EntryTags, ","); g != want {
			fail("entry_tags = %q, want %q", g, want)
		}
	}
	if c.noteTags != "" {
		if g := strings.Join(r.NoteTags, ","); g != c.noteTags {
			fail("note_tags = %q, want %q", g, c.noteTags)
		}
	}
	if g := fmt.Sprintf("%d-%d", r.RangeStart, r.RangeEnd); g != c.rng {
		fail("range %s, want %s", g, c.rng)
	}
	if r.Descendants != c.desc {
		fail("descendants %d, want %d", r.Descendants, c.desc)
	}
	if g := pathString(r.Path); g != c.path {
		fail("path\n%s\nwant\n%s", g, c.path)
	}
	wantParent, wantParentLine := splitRef(c.parent)
	if r.ParentHeading != wantParent || r.ParentLine != wantParentLine {
		fail("parent %q at %d, want %q at %d", r.ParentHeading, r.ParentLine, wantParent, wantParentLine)
	}
	if c.heading != "" {
		h, hl := splitRef(c.heading)
		if r.Heading != h || r.HeadingLine != hl {
			fail("heading %q at %d, want %q at %d", r.Heading, r.HeadingLine, h, hl)
		}
	}
	if c.changedIsPartial != (r.Changed && r.MessageCode != "") {
		fail("changed %v with message_code %q", r.Changed, r.MessageCode)
	}
	if msg := checkAnswerAgainstOutline(text, c.op, c.line, ParseTagList(c.tags), r); msg != "" {
		fail("against the reference: %s", msg)
	}
}

func TestEditTagsOutline(t *testing.T) {
	for _, c := range outlineCases() {
		t.Run(c.name, func(t *testing.T) {
			c.run(t, "lf")
			c.run(t, "crlf")
			if !c.noBOM {
				c.run(t, "bom")
			}
		})
	}
}

// The answer is one JSON object whatever the note: the lists are arrays and never null, the new keys are always there.
func TestEditTagsOutlineAnswerShape(t *testing.T) {
	for _, c := range []struct {
		name, text, op, scope string
		line                  int
		tags                  []string
	}{
		{"entry", articleNote, "show", "entry", 8, nil},
		{"note", articleNote, "show", "note", 0, nil},
		{"on_parent", articleNote, "remove", "entry", 8, []string{"素材"}},
		{"empty text", "", "show", "note", 0, nil},
		{"front part", "intro\n# A\n", "show", "entry", 1, nil},
	} {
		r, err := EditTags([]byte(c.text), c.op, c.scope, c.line, c.tags)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		b, _ := json.Marshal(r)
		if strings.Contains(string(b), "null") {
			t.Errorf("%s: a null in %s", c.name, b)
		}
		var back map[string]json.RawMessage
		if err := json.Unmarshal(b, &back); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{"descendants", "inherited_tags", "path", "parent_heading", "parent_line"} {
			if _, ok := back[k]; !ok {
				t.Errorf("%s: no %q in %s", c.name, k, b)
			}
		}
		if string(back["path"]) == "[]" != (c.scope == "note" || c.name == "front part") {
			t.Errorf("%s: path %s", c.name, back["path"])
		}
		var path []map[string]json.RawMessage
		if err := json.Unmarshal(back["path"], &path); err != nil {
			t.Fatal(err)
		}
		for _, p := range path {
			if len(p) != 7 {
				t.Errorf("%s: a path element has %d keys: %v", c.name, len(p), p)
			}
			for _, k := range []string{"line", "level", "heading", "range_start", "range_end", "descendants", "tags"} {
				if _, ok := p[k]; !ok {
					t.Errorf("%s: a path element has no %q", c.name, k)
				}
			}
		}
	}
	// the answer for the entry two levels down, whole (this is what the page's mock has to give back)
	r, _ := EditTags([]byte(articleNote), "show", "entry", 8, nil)
	b, _ := json.Marshal(r)
	const want = `{"changed":false,"scope":"entry","start_line":0,"end_line":0,"new_lines":[],"eol":"\n","line":0,"added":[],"removed":[],"unchanged":[],"note_tags":[],"entry_tags":[],` +
		`"message_code":"","range_start":7,"range_end":8,"heading":"乾燥","heading_line":7,"descendants":0,"inherited_tags":["素材","工程"],"path":[` +
		`{"line":7,"level":3,"heading":"乾燥","range_start":7,"range_end":8,"descendants":0,"tags":[]},` +
		`{"line":4,"level":2,"heading":"加工","range_start":4,"range_end":8,"descendants":1,"tags":["工程"]},` +
		`{"line":1,"level":1,"heading":"記事","range_start":1,"range_end":10,"descendants":3,"tags":["素材"]}],"parent_heading":"","parent_line":0}`
	if string(b) != want {
		t.Errorf("show:\n%s\nwant\n%s", b, want)
	}
}
