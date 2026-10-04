package search

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// Adding and removing tags (docs/design/tag-filter-2026-10.md section 10). The rule for where a tag goes is written once, here: the
// window's command palette, `md-memo scrap tag` and the JSON-RPC method scrap.tag_edit all call EditTags, and none of them copies the
// scope rules of section 2.3. EditTags is a pure function of the text: it reads and writes no file and no window. It answers with a
// patch (which lines of the text are replaced by which), so the window can apply it to the open tab as one undo step, and with
// Apply for everyone who wants the new text.

// MaxTagEditBytes bounds the text EditTags takes: it is read whole, and a note that large is not one a person edits by hand.
const MaxTagEditBytes = 16 << 20

// TagEdit is what EditTags answers. The patch replaces the lines [StartLine, EndLine) of the old text by NewLines. The text is the
// lines joined by newlines, the way an editor shows it: a text that ends with a newline has an empty last line that is not counted
// (so "a\n" has one line, and StartLine == EndLine == 2 appends after it), and a text that does not end with a newline still does not
// when the patch reaches its end. Apply is the reference for the two corners (appending after an unterminated last line, and deleting
// it).
type TagEdit struct {
	Changed   bool     `json:"changed"`
	Scope     string   `json:"scope"`      // "note" or "entry": the range that was used
	StartLine int      `json:"start_line"` // 1-based; the lines [StartLine, EndLine) of the old text are replaced by NewLines
	EndLine   int      `json:"end_line"`   // EndLine == StartLine: lines are only inserted before StartLine
	NewLines  []string `json:"new_lines"`  // no line endings; empty with EndLine > StartLine: lines are deleted. Never nil
	Eol       string   `json:"eol"`        // "\n" or "\r\n": the text's own (that of its first line break), for joining NewLines
	Line      int      `json:"line"`       // 1-based line of the tag comment in the NEW text (the last one that was added to or created); 0 when none is left
	Added     []string `json:"added"`      // never nil
	Removed   []string `json:"removed"`
	Unchanged []string `json:"unchanged"`
	// The tags that apply in the range after the edit, for the screen's feedback: of the whole note and of the entry (empty when the
	// range is the whole note). Both are what ScanTags reads from the new text.
	NoteTags  []string `json:"note_tags"`
	EntryTags []string `json:"entry_tags"`
	// MessageCode says why nothing (or not everything) was done: "" | "already" (add: every tag was there, in the entry, in a heading
	// above it or in the whole note) | "front_matter" (add to a note that has a front matter) | "front_matter_tag" (remove: the tag is
	// in the front matter, which MD-Memo never writes) | "on_parent" (remove: the tag is written under a heading above the entry, see
	// ParentHeading) | "on_note" / "on_entry" (remove: the tag is in the other range) | "none_found" (remove: no such tag anywhere).
	// Of several tags that were not done, the reason that tells the person where to look wins over none_found, and the first tag that
	// has one gives the message. For one tag the reasons are tried in this order: in an entry, on_parent, on_note, front_matter_tag; in
	// the whole note, front_matter_tag, on_entry; then none_found.
	MessageCode string `json:"message_code"`
	// Where the range is in the OLD text, for the screen's sentences ("under "Part A" (line 5)"): its first and last line (the whole
	// note: 1 and the last line) and, for an entry that has a heading, the heading's text without its # marks and its line. An entry that
	// starts with a "---" rule and a heading below it has that heading; a rule alone, a front part and a whole note have none ("", 0).
	// The range of an entry is its subtree: from its own first line to the last line of the last entry under its heading (the entries
	// with a smaller heading below it, docs/design/tag-filter-2026-10.md section 11.1), so it is the lines a tag written there reaches.
	// Every edit goes under the heading or on the first line, so the heading's line is the same in the new text.
	RangeStart  int    `json:"range_start"`
	RangeEnd    int    `json:"range_end"`
	Heading     string `json:"heading"`
	HeadingLine int    `json:"heading_line"`
	// Descendants is how many entries are under the entry's heading (0: a tag written there reaches only that entry; always 0 for the
	// whole note). InheritedTags are the tags written under the headings above the entry, the farthest first, each once (a tag that
	// only the whole note has is not among them; one that a heading above writes is, even if the note has it as well). Path lists the
	// entry and the entries above it, the nearest first, the entry itself at the front: the places a tag can be written to reach it
	// (empty for the whole note). Lines are those of the OLD text, and the two lists are never null.
	Descendants   int            `json:"descendants"`
	InheritedTags []string       `json:"inherited_tags"`
	Path          []TagPathEntry `json:"path"`
	// ParentHeading and ParentLine (the heading's text and line, in the old text) say which heading the tag of an "on_parent" answer is
	// written under: the nearest one above the entry that has it. They are "" and 0 for every other answer.
	ParentHeading string `json:"parent_heading"`
	ParentLine    int    `json:"parent_line"`
}

// TagPathEntry is one entry of TagEdit.Path: where it is, how far a tag written there reaches and the tags it has itself.
type TagPathEntry struct {
	Line        int      `json:"line"`        // its heading's line; for an entry with no heading (a rule alone) its first line
	Level       int      `json:"level"`       // 1 to 3 for a heading ("#" to "###"), 0 for an entry with none
	Heading     string   `json:"heading"`     // the heading's text without its # marks; "" when there is none
	RangeStart  int      `json:"range_start"` // its subtree: its first line ...
	RangeEnd    int      `json:"range_end"`   // ... to the last line of the last entry under its heading
	Descendants int      `json:"descendants"` // how many entries are under its heading
	Tags        []string `json:"tags"`        // the tags written in this entry itself, not those it inherits; never null
}

const (
	tagOpAdd    = "add"
	tagOpRemove = "remove"
	tagOpShow   = "show"
)

// EditTags works out how to add tags to (op "add"), take tags off (op "remove") or just read (op "show") the tags of a note.
//
// scope "note" is the whole file, "entry" the entry (the unit Entries cuts) that holds the 1-based line. An entry that is the front
// part of the file (above its first heading or "---" rule), the front matter, or the whole of a file that has no heading and no rule,
// is the whole file: then the answer's Scope is "note". The tags are read the way a search reads them (section 2); a new tag is written
// as a one-line comment, "<!-- tags: a, b -->", under the entry's heading (at the top of the file for a note), or into the first tag
// comment the range already has. A comment that is left without a tag is deleted. Text the reading rules would drop (a tag longer than
// 64 characters, the tags past the 32nd of a comment) is not kept when MD-Memo rewrites that comment line.
//
// A tag written under an entry's heading also applies to every smaller heading below it (outline.go), so the edit of an entry is about
// that whole subtree: the answer's range, Descendants, InheritedTags and Path say how far it reaches. A tag that an entry gets from a
// heading above it (or from the note) is not written again, and one that is only written under a heading above is not taken from the
// entry (MessageCode "on_parent": the caller is told which heading, and asks again with that heading's line). The text that is edited
// is always the entry's own lines.
//
// Asking for a tag that is already there, or for the removal of one that is not, is not an error: Changed is false and MessageCode
// says why. An error is a bad request (an unknown op or scope, a line outside the text, no tag, more than MaxFilterTags tags, a tag
// longer than 64 characters or containing a comment delimiter, a text over MaxTagEditBytes).
func EditTags(data []byte, op, scope string, line int, tags []string) (TagEdit, error) {
	switch op {
	case tagOpAdd, tagOpRemove, tagOpShow:
	default:
		return TagEdit{}, fmt.Errorf("unknown op %q (add, remove or show)", op)
	}
	switch scope {
	case "note", "entry":
	default:
		return TagEdit{}, fmt.Errorf("unknown scope %q (note or entry)", scope)
	}
	if len(data) > MaxTagEditBytes {
		return TagEdit{}, errors.New("the text is over 16 MB")
	}
	var want []string
	if op != tagOpShow {
		var err error
		if want, err = ParseTagFilter(tags); err != nil {
			return TagEdit{}, err
		}
		if len(want) == 0 {
			return TagEdit{}, errors.New("no tag given")
		}
		for _, t := range want {
			// the comment would end (or a second one begin) inside the tag, and the line would no longer be read as tags
			if strings.Contains(t, "-->") || strings.Contains(t, "<!--") {
				return TagEdit{}, fmt.Errorf("a tag cannot contain %q or %q", "<!--", "-->")
			}
		}
	}
	if scope == "entry" {
		if lastLine := bytes.Count(data, []byte("\n")) + 1; line < 1 || line > lastLine {
			return TagEdit{}, fmt.Errorf("line %d is outside the text (1 to %d)", line, lastLine)
		}
	}

	d := scanTagDoc(data)
	res := TagEdit{
		Scope: scope, Eol: eolOf(data),
		NewLines: []string{}, Added: []string{}, Removed: []string{}, Unchanged: []string{},
	}
	ent := -1 // the entry the edit is about; -1: the whole note
	if scope == "entry" {
		if ent = d.entryAtLine(line); ent < 0 {
			res.Scope = "note"
		}
	}
	res.RangeStart, res.RangeEnd = 1, d.lineCount()
	res.InheritedTags, res.Path = []string{}, []TagPathEntry{}
	if ent >= 0 {
		p, hl := d.placeOf(ent)
		res.RangeStart, res.RangeEnd, res.Heading, res.HeadingLine, res.Descendants = p.RangeStart, p.RangeEnd, p.Heading, hl, p.Descendants
		res.Path = append(res.Path, p)
		chain := d.outline().chain(ent) // the nearest first
		for _, a := range chain {
			up, _ := d.placeOf(a)
			res.Path = append(res.Path, up)
		}
		for k := len(chain) - 1; k >= 0; k-- { // the farthest heading's tags come first
			res.InheritedTags = addTags(res.InheritedTags, d.own[chain[k]], math.MaxInt)
		}
	}
	switch op {
	case tagOpAdd:
		d.add(&res, want, ent)
	case tagOpRemove:
		d.remove(&res, want, ent)
	}

	// What applies in the range after the edit is what ScanTags reads from the text that results, so the screen and a search agree.
	text := data
	if res.Changed {
		text = res.Apply(data)
	}
	fb := scanTags(text, false)
	res.NoteTags = append([]string{}, fb.FileTags()...)
	res.EntryTags = []string{}
	if ent >= 0 && fb != nil {
		// the entry's first line is above every line an edit touches, so it finds the entry again in the new text
		start := d.entries[ent].StartLine
		if i := sort.Search(len(fb.entries), func(i int) bool { return fb.entries[i].StartLine > start }) - 1; i >= 0 {
			res.EntryTags = append(res.EntryTags, fb.EntryTags(i)...)
		}
	}
	return res, nil
}

// eolOf is the line ending a text uses, taken from its first line break: "\r\n" or "\n" (also for a text without a line break).
func eolOf(data []byte) string {
	if i := bytes.IndexByte(data, '\n'); i > 0 && data[i-1] == '\r' {
		return "\r\n"
	}
	return "\n"
}

// ---- reading the text ----------------------------------------------------------------------------

// tagLine is one tag comment line (outside code fences), as ScanTags reads it.
type tagLine struct {
	line   int
	prefix string   // what stands before the "<!--": spaces, tabs and, on the first line, a byte order mark
	tags   []string // what ScanTags reads from it; none for "<!-- tags: -->"
	entry  int      // index into entries
}

// tagDoc is a text cut into lines, entries and tag comments: what the edit decides from.
type tagDoc struct {
	data     []byte
	offs     []int // offs[i] is where line i+1 starts; the last element is len(data), so there are len(offs)-1 lines
	entries  []Entry
	lines    []tagLine // in line order
	preamble bool      // the first entry is the front part of the file (the file does not open with a heading or a rule)
	fmTags   []string
	fmEnd    int        // the line of the front matter's closing "---", 0 for none
	note     []string   // the tags of the whole file (ScanTags's FileTags)
	own      [][]string // per entry: its own tags (ScanTags's EntryTags)
	ol       *outline   // the headings' tree; made on first use (outline())
}

// outline is which entry is under which heading. Reading and writing a tag of the whole note never needs it, so it is made only when an
// entry is asked about.
func (d *tagDoc) outline() *outline {
	if d.ol == nil {
		d.ol = newOutline(d.data, d.entries, true)
	}
	return d.ol
}

func scanTagDoc(data []byte) *tagDoc {
	d := &tagDoc{data: data, entries: Entries(data)}
	d.offs = make([]int, 0, bytes.Count(data, []byte("\n"))+2)
	for off := 0; off < len(data); {
		d.offs = append(d.offs, off)
		i := bytes.IndexByte(data[off:], '\n')
		if i < 0 {
			break
		}
		off += i + 1
	}
	d.offs = append(d.offs, len(data))
	d.own = make([][]string, len(d.entries))
	d.fmTags, d.fmEnd = frontMatterOf(data)
	d.note = append([]string(nil), d.fmTags...)
	if len(d.entries) == 0 {
		return d
	}
	first := firstLine(data)
	d.preamble = !isRuleLine(first) && !isEntryHeading(first)

	if !bytes.Contains(data, commentOpen) {
		return d
	}
	// The same walk as ScanTags, so a comment in a code block is code; this one also keeps where each comment is.
	var tr headingTracker
	ei := 0
	for k := 1; k <= d.lineCount(); k++ {
		line := []byte(d.text(k))
		t := bytes.TrimLeft(line, " ")
		if len(t) > 0 && (t[0] == '`' || t[0] == '~') {
			tr.feed(string(line), k)
			continue
		}
		if tr.fenceChar != 0 {
			continue
		}
		if k == 1 {
			t = bytes.TrimPrefix(t, utf8BOM)
		}
		t = bytes.TrimLeft(t, " \t")
		if !bytes.HasPrefix(t, commentOpen) {
			continue
		}
		body, ok := tagCommentBody(t)
		if !ok {
			continue
		}
		for ei+1 < len(d.entries) && d.entries[ei+1].StartLine <= k {
			ei++
		}
		tags := parseTags(string(body), maxTagsPerComment)
		d.lines = append(d.lines, tagLine{line: k, prefix: string(line[:len(line)-len(t)]), tags: tags, entry: ei})
		if ei == 0 && d.preamble {
			d.note = addTags(d.note, tags, math.MaxInt)
		} else {
			d.own[ei] = addTags(d.own[ei], tags, math.MaxInt)
		}
	}
	return d
}

func (d *tagDoc) lineCount() int { return len(d.offs) - 1 }

// text is line k (1-based) without its line ending.
func (d *tagDoc) text(k int) string {
	b := bytes.TrimSuffix(d.data[d.offs[k-1]:d.offs[k]], []byte("\n"))
	return string(bytes.TrimSuffix(b, []byte("\r")))
}

// entryAtLine is the index of the entry that holds the line, or -1 when the range is the whole note: a line of the front part, of
// the front matter, or in a text that has no entry at all. The empty last line an editor shows after a final newline belongs to the
// last line of the text.
func (d *tagDoc) entryAtLine(line int) int {
	n := d.lineCount()
	if n == 0 || len(d.entries) == 0 {
		return -1
	}
	l := min(line, n)
	if d.fmEnd > 0 && l <= d.fmEnd {
		return -1
	}
	i := sort.Search(len(d.entries), func(i int) bool { return d.entries[i].StartLine > l }) - 1
	if i < 0 || (i == 0 && d.preamble) {
		return -1
	}
	return i
}

// placeOf says where entry i is (see TagEdit.RangeStart and TagPathEntry): its heading, when the line anchor() points at is one (its
// line is headingLine, 0 for none), its subtree range and how many entries are under it.
func (d *tagDoc) placeOf(i int) (p TagPathEntry, headingLine int) {
	n := d.lineCount()
	e, o := d.entries[i], d.outline()
	last := int(o.lasts()[i])
	p = TagPathEntry{
		Line: e.StartLine, Level: int(o.level[i]), RangeStart: e.StartLine, RangeEnd: min(d.entries[last].EndLine, n),
		Descendants: last - i, Tags: append([]string{}, d.own[i]...),
	}
	if a := d.anchor(i); a >= 1 && a <= n {
		line := d.text(a)
		if a == 1 {
			line = strings.TrimPrefix(line, string(utf8BOM)) // as the outline reads it
		}
		if isEntryHeading(line) {
			headingLine, p.Line, p.Heading = a, a, headingText(line)
		}
	}
	return p, headingLine
}

// headingText is a heading line without its # marks and the white space around them (the screen shortens a long one itself).
func headingText(line string) string {
	return strings.TrimSpace(strings.TrimLeft(strings.TrimLeft(line, " "), "#"))
}

// scope returns the tag comment lines of the range, in line order.
func (d *tagDoc) scope(ent int) []tagLine {
	var out []tagLine
	for _, c := range d.lines {
		if ent < 0 && c.entry == 0 && d.preamble || ent >= 0 && c.entry == ent {
			out = append(out, c)
		}
	}
	return out
}

// anchor is the line after which the first tag comment of an entry goes: its heading (the line after the rule when the entry starts
// with a rule and a heading follows it), or the rule itself. Not inside a front matter that the entry holds.
func (d *tagDoc) anchor(ent int) int {
	e := d.entries[ent]
	if ent == 0 && d.fmEnd > 0 {
		return d.fmEnd // the front matter closes with "..." and the entry goes on below it
	}
	if isRuleLine(d.text(e.StartLine)) && e.StartLine+1 <= e.EndLine && isEntryHeading(d.text(e.StartLine+1)) {
		return e.StartLine + 1
	}
	return e.StartLine
}

// ---- the edits -------------------------------------------------------------------------------------

func renderTags(tags []string) string { return "<!-- tags: " + strings.Join(tags, ", ") + " -->" }

// render is the comment line of c with the given tags: its own indentation and byte order mark are kept.
func (c tagLine) render(tags []string) string { return c.prefix + renderTags(tags) }

// below is a new comment line to go under c: indented like c, but only the first line of a file starts with a byte order mark.
func (c tagLine) below(tags []string) string {
	return strings.ReplaceAll(c.prefix, string(utf8BOM), "") + renderTags(tags)
}

func (d *tagDoc) add(res *TagEdit, want []string, ent int) {
	if ent < 0 && d.fmEnd > 0 {
		// a comment cannot go above the front matter, and under it it would tag the entry that follows, not the file
		res.Unchanged = want
		res.MessageCode = "front_matter"
		return
	}
	// what applies to the range already: the whole note's tags and, for an entry, its own and those of the headings above it
	var have []string
	have = append(have, d.note...)
	if ent >= 0 {
		have = append(have, d.own[ent]...)
		for _, a := range d.outline().chain(ent) {
			have = append(have, d.own[a]...)
		}
	}
	var add []string
	for _, t := range want {
		if hasTag(have, t) {
			res.Unchanged = append(res.Unchanged, t)
		} else {
			add = append(add, t)
		}
	}
	if len(add) == 0 {
		res.MessageCode = "already"
		return
	}
	res.Changed, res.Added = true, add

	if in := d.scope(ent); len(in) > 0 {
		c := in[0]
		room := maxTagsPerComment - len(c.tags)
		if room <= 0 {
			// the first comment is full: the new tags get a line of their own under it
			res.StartLine, res.EndLine = c.line+1, c.line+1
			res.NewLines = []string{c.below(add)}
			res.Line = c.line + 1
			return
		}
		n := min(room, len(add))
		res.StartLine, res.EndLine = c.line, c.line+1
		res.NewLines = []string{c.render(append(append([]string(nil), c.tags...), add[:n]...))}
		if n < len(add) {
			res.NewLines = append(res.NewLines, c.below(add[n:]))
		}
		res.Line = c.line + len(res.NewLines) - 1
		return
	}

	line := renderTags(add)
	if ent >= 0 {
		a := d.anchor(ent)
		res.StartLine, res.EndLine, res.NewLines, res.Line = a+1, a+1, []string{line}, a+1
		return
	}
	// the whole note: a new first line. The byte order mark stays the first thing in the file, so the old first line is replaced too.
	res.Line = 1
	if d.lineCount() > 0 && bytes.HasPrefix(d.data, utf8BOM) {
		res.StartLine, res.EndLine = 1, 2
		res.NewLines = []string{string(utf8BOM) + line, strings.TrimPrefix(d.text(1), string(utf8BOM))}
		if res.NewLines[1] == "" && d.data[len(d.data)-1] != '\n' {
			res.NewLines = res.NewLines[:1] // the file was nothing but the mark: it still does not end with a newline
		}
		return
	}
	res.StartLine, res.EndLine, res.NewLines = 1, 1, []string{line}
}

func (d *tagDoc) remove(res *TagEdit, want []string, ent int) {
	in := d.scope(ent)
	var inTags, noteComment []string // the tags of the range's comments; those of the comments that tag the whole file
	for _, c := range in {
		inTags = addTags(inTags, c.tags, math.MaxInt)
	}
	if d.preamble {
		for _, c := range d.scope(-1) {
			noteComment = addTags(noteComment, c.tags, math.MaxInt)
		}
	}
	var above []int // the entries above the target, the nearest first: a tag written under one of their headings reaches the target
	if ent >= 0 {
		above = d.outline().chain(ent)
	}
	// why a tag that is not in the range cannot be taken from it; for on_parent also the nearest entry above that has it
	elsewhere := func(t string) (code string, parent int) {
		if ent >= 0 {
			for _, a := range above {
				if hasTag(d.own[a], t) {
					return "on_parent", a
				}
			}
			switch {
			case hasTag(noteComment, t):
				return "on_note", -1
			case hasTag(d.fmTags, t):
				return "front_matter_tag", -1
			}
			return "none_found", -1
		}
		if hasTag(d.fmTags, t) {
			return "front_matter_tag", -1
		}
		for _, own := range d.own {
			if hasTag(own, t) {
				return "on_entry", -1
			}
		}
		return "none_found", -1
	}
	rank := func(code string) int { // the reason that says where the tag is wins over "there is none"
		switch code {
		case "":
			return 0
		case "none_found":
			return 1
		}
		return 2
	}
	rm := map[string]bool{}
	code := ""
	for _, t := range want {
		if hasTag(inTags, t) {
			rm[t] = true
			res.Removed = append(res.Removed, t)
			continue
		}
		res.Unchanged = append(res.Unchanged, t)
		if why, from := elsewhere(t); rank(why) > rank(code) {
			code = why
			if from >= 0 {
				up, _ := d.placeOf(from)
				res.ParentHeading, res.ParentLine = up.Heading, up.Line
			}
		}
	}
	if len(res.Removed) == 0 {
		res.MessageCode = code
		return
	}
	if rank(code) == 2 {
		res.MessageCode = code // some tag could not be taken from the range; a tag that is simply not there is not worth a message
	}

	// the comments that lose a tag, rewritten or (when nothing is left) deleted; the lines between them stay as they are
	type change struct {
		c    tagLine
		keep []string
	}
	var changes []change
	for _, c := range in {
		var keep []string
		for _, t := range c.tags {
			if !rm[t] {
				keep = append(keep, t)
			}
		}
		if len(keep) != len(c.tags) {
			changes = append(changes, change{c, keep})
		}
	}
	res.Changed = true
	res.StartLine, res.EndLine = changes[0].c.line, changes[len(changes)-1].c.line+1
	bom := "" // the byte order mark of a first line that goes moves to the line that becomes the first
	put := func(s string) {
		res.NewLines = append(res.NewLines, bom+s)
		bom = ""
	}
	next := 0
	for k := res.StartLine; k < res.EndLine; k++ {
		if next < len(changes) && changes[next].c.line == k {
			ch := changes[next]
			next++
			if len(ch.keep) == 0 {
				if k == 1 && strings.Contains(ch.c.prefix, string(utf8BOM)) {
					bom = string(utf8BOM)
				}
				continue // the comment has no tag left: the line goes
			}
			if res.Line == 0 {
				res.Line = res.StartLine + len(res.NewLines)
			}
			put(ch.c.render(ch.keep))
			continue
		}
		put(d.text(k))
	}
	if bom != "" && res.EndLine <= d.lineCount() {
		put(d.text(res.EndLine)) // the patch takes in the line after it, which gets the mark
		res.EndLine++
	}
}

// ---- applying a patch ------------------------------------------------------------------------------

// Apply returns the text with the patch applied: the lines before StartLine, NewLines each ended with Eol, and the lines from EndLine
// on, every other byte as it was. A patch that changes nothing returns data itself. A text that did not end with a newline still does
// not when the patch reaches its end (appending after its last line gives that line a line break; deleting the last line takes the
// line break before it away).
func (e TagEdit) Apply(data []byte) []byte {
	if !e.Changed {
		return data
	}
	eol := e.Eol
	if eol == "" {
		eol = "\n"
	}
	lineStart := func(n int) int { // the offset where line n starts; len(data) past the last line
		off := 0
		for ; n > 1; n-- {
			i := bytes.IndexByte(data[off:], '\n')
			if i < 0 {
				return len(data)
			}
			off += i + 1
		}
		return off
	}
	start := lineStart(e.StartLine)
	end := start
	if e.EndLine > e.StartLine {
		end = lineStart(e.EndLine)
	}
	head, tail := data[:start], data[end:]
	terminated := len(data) == 0 || data[len(data)-1] == '\n'

	out := make([]byte, 0, len(data)+len(eol)*len(e.NewLines)+64)
	switch {
	case len(e.NewLines) == 0:
		if len(tail) == 0 && !terminated {
			// the unterminated last line is gone, and the text still has no newline at its end
			head = bytes.TrimSuffix(head, []byte("\n"))
			head = bytes.TrimSuffix(head, []byte("\r"))
		}
		out = append(append(out, head...), tail...)
	case len(tail) > 0 || terminated:
		out = append(out, head...)
		for _, l := range e.NewLines {
			out = append(append(out, l...), eol...)
		}
		out = append(out, tail...)
	default: // the patch reaches the end of a text that has no newline at its end
		if start == len(data) {
			out = append(append(out, data...), eol...) // appended after the last line
		} else {
			out = append(out, head...)
		}
		out = append(out, strings.Join(e.NewLines, eol)...)
	}
	return out
}
