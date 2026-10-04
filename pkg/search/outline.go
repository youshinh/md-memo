package search

import "bytes"

// The outline of a note (docs/design/tag-filter-2026-10.md section 11.1): which entry is under which heading. A tag written under a
// heading reaches every smaller heading below it, so a pasted article that its own headings cut into many entries is tagged by the one
// comment under its top heading. The entries are the ones Entries cuts; nothing here splits the text again.
//
// The level of an entry is the number of "#" of its heading (1 to 3). An entry that starts with a "---" rule has the heading on its
// next line, if there is one (the daily scrap's "---" and "## [10:05:00] title" are one entry); a rule alone, the front part of the
// file and an entry that opens with anything else have level 0.
//
// The parent of an entry is the nearest earlier entry with a smaller level, reached without crossing a break: an entry of level 0, or
// an entry that starts with a rule, ends every chain before it ("---" separates outlines, and a rule with no heading is a wall). A
// level may be skipped ("# A" then "### C": A is the parent of C). Headings of four "#" or more are not entries at all, so they are
// text of the entry above them.

// outline is the heading tree of one note, indexed like the entries it was built from.
type outline struct {
	parent []int32 // the entry that holds this one, -1 for none
	level  []int8  // 0 to 3; only when it was asked for (a tag search needs the parents only)
	last   []int32 // the last entry of the subtree (the entry itself when it has no descendants; a subtree is contiguous); see lasts
}

// newOutline reads the first line (two for an entry that starts with a rule) of each entry from data and works out the tree with a
// stack of the open headings: their levels strictly increase, so it never holds more than three. data is the text the entries were cut
// from. withLevels keeps the level of every entry too.
func newOutline(data []byte, entries []Entry, withLevels bool) *outline {
	o := &outline{parent: make([]int32, len(entries))}
	if withLevels {
		o.level = make([]int8, len(entries))
	}
	type open struct {
		entry int32
		level int8
	}
	var stack [4]open
	depth := 0
	for i := range entries {
		lv, rule := entryLevel(data, entries[i])
		if o.level != nil {
			o.level[i] = lv
		}
		o.parent[i] = -1
		if lv == 0 || rule {
			depth = 0 // a rule alone, a front part, or a rule that opens its own outline: nothing before it is above it
		} else {
			for depth > 0 && stack[depth-1].level >= lv {
				depth--
			}
			if depth > 0 {
				o.parent[i] = stack[depth-1].entry
			}
		}
		if lv > 0 {
			stack[depth] = open{int32(i), lv}
			depth++
		}
	}
	return o
}

// lasts is the last entry of every subtree, made on the first call: a heading reaches as far as its last child does, and the children
// come after it, so going from the end every entry is final when it hands its reach to its parent.
func (o *outline) lasts() []int32 {
	if o.last == nil {
		last := make([]int32, len(o.parent))
		for j := len(o.parent) - 1; j >= 0; j-- {
			if last[j] < int32(j) {
				last[j] = int32(j)
			}
			if p := o.parent[j]; p >= 0 && last[p] < last[j] {
				last[p] = last[j]
			}
		}
		o.last = last
	}
	return o.last
}

// entryLevel is the heading level of an entry and whether it starts with a "---" rule. The file's first line may carry a byte order
// mark (Entries does not look past one, but the tags of such a file are read as if it were not there, see ScanTags).
func entryLevel(data []byte, e Entry) (level int8, rule bool) {
	first, rest := cutLine(data[e.StartOff:e.EndOff])
	if e.StartOff == 0 {
		first = bytes.TrimPrefix(first, utf8BOM)
	}
	if lv := headingLevel(first); lv > 0 {
		return lv, false
	}
	if !isRuleBytes(first) {
		return 0, false
	}
	if e.EndLine > e.StartLine { // the splitter keeps a heading on the line right after a rule in the rule's entry
		next, _ := cutLine(rest)
		return headingLevel(next), true
	}
	return 0, true
}

// cutLine is the first line of b without its line ending, and what follows it.
func cutLine(b []byte) (line, rest []byte) {
	i := bytes.IndexByte(b, '\n')
	if i < 0 {
		return bytes.TrimSuffix(b, []byte("\r")), nil
	}
	return bytes.TrimSuffix(b[:i], []byte("\r")), b[i+1:]
}

// headingLevel is 1 to 3 for an entry heading (isEntryHeading: up to three spaces, one to three "#", then a space or the end), else 0.
func headingLevel(line []byte) int8 {
	i := 0
	for i < len(line) && line[i] == ' ' {
		i++
	}
	if i > 3 {
		return 0
	}
	n := 0
	for i+n < len(line) && line[i+n] == '#' {
		n++
	}
	if n < 1 || n > 3 {
		return 0
	}
	if rest := line[i+n:]; len(rest) == 0 || rest[0] == ' ' || rest[0] == '\t' {
		return int8(n)
	}
	return 0
}

// isRuleBytes is isRuleLine for bytes: three or more "-" and nothing else but white space.
func isRuleBytes(line []byte) bool {
	t := bytes.TrimSpace(line)
	return len(t) >= 3 && len(bytes.Trim(t, "-")) == 0
}

// chain is the entries above i in the outline, the nearest first (empty for a root).
func (o *outline) chain(i int) []int {
	var out []int
	for p := int(o.parent[i]); p >= 0; p = int(o.parent[p]) {
		out = append(out, p)
	}
	return out
}
