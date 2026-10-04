package search

import (
	"fmt"
	"strings"
)

// The answer of EditTags against the plain reference of outline_test.go (used by the property test in tagedit_test.go).

func linesOf(text string) int {
	if text == "" {
		return 0
	}
	return strings.Count(text, "\n") + btoi(!strings.HasSuffix(text, "\n"))
}

// refHeading is the heading line of entry i by the reference levels (0: none) and its text.
func refHeading(text string, entries []Entry, level []int, startsRule []bool, i int) (line int, heading string) {
	if level[i] == 0 {
		return 0, ""
	}
	line = entries[i].StartLine + btoi(startsRule[i])
	l := strings.Split(text, "\n")[line-1]
	l = strings.TrimSuffix(l, "\r")
	if line == 1 {
		l = strings.TrimPrefix(l, testBOM)
	}
	return line, strings.TrimSpace(strings.TrimLeft(strings.TrimLeft(l, " "), "#"))
}

func sameStrings(a, b []string) bool {
	return len(a) == len(b) && (len(a) == 0 || strings.Join(a, "\x00") == strings.Join(b, "\x00"))
}

// checkAnswerAgainstOutline checks what an answer says about the OLD text (range, descendants, path, inherited tags, what a request
// that is not done is told about the headings above): "" when it is right, else what is wrong.
func checkAnswerAgainstOutline(text, op string, line int, want []string, r TagEdit) string {
	n := linesOf(text)
	if r.Path == nil || r.InheritedTags == nil {
		return "path or inherited_tags is nil"
	}
	if r.Scope == "note" {
		if len(r.Path) != 0 || r.Descendants != 0 || len(r.InheritedTags) != 0 || r.RangeStart != 1 || r.RangeEnd != n || r.Heading != "" || r.HeadingLine != 0 {
			return fmt.Sprintf("the whole note has path %v descendants %d inherited %v range %d-%d heading %q", r.Path, r.Descendants, r.InheritedTags, r.RangeStart, r.RangeEnd, r.Heading)
		}
		return ""
	}
	data := []byte(text)
	entries := Entries(data)
	tgt := entryIndexAt(entries, min(line, n))
	if tgt < 0 {
		return "no entry for the line"
	}
	level, parent, startsRule := refOutline(text)
	m := ScanTags(data)
	chain := append([]int{tgt}, refAbove(parent, tgt)...)
	last := refLast(parent, tgt)
	if r.Descendants != last-tgt || r.RangeStart != entries[tgt].StartLine || r.RangeEnd != min(entries[last].EndLine, n) {
		return fmt.Sprintf("descendants %d range %d-%d; the reference: %d, %d-%d", r.Descendants, r.RangeStart, r.RangeEnd, last-tgt, entries[tgt].StartLine, min(entries[last].EndLine, n))
	}
	if hl, h := refHeading(text, entries, level, startsRule, tgt); r.HeadingLine != hl || r.Heading != h {
		return fmt.Sprintf("heading %q at %d; the reference: %q at %d", r.Heading, r.HeadingLine, h, hl)
	}
	if len(r.Path) != len(chain) {
		return fmt.Sprintf("path %+v has %d elements, the reference chain %v", r.Path, len(r.Path), chain)
	}
	for k, i := range chain {
		hl, h := refHeading(text, entries, level, startsRule, i)
		if hl == 0 {
			hl = entries[i].StartLine
		}
		li := refLast(parent, i)
		own := append([]string{}, m.EntryTags(i)...)
		p := r.Path[k]
		if p.Line != hl || p.Level != level[i] || p.Heading != h || p.RangeStart != entries[i].StartLine || p.RangeEnd != min(entries[li].EndLine, n) ||
			p.Descendants != li-i || !sameStrings(p.Tags, own) || p.Tags == nil {
			return fmt.Sprintf("path[%d] = %+v; the reference: line %d level %d heading %q range %d-%d descendants %d tags %v", k, p, hl, level[i], h,
				entries[i].StartLine, min(entries[li].EndLine, n), li-i, own)
		}
	}
	var inherited []string
	for k := len(chain) - 1; k >= 1; k-- {
		inherited = addTags(inherited, m.EntryTags(chain[k]), 1<<30)
	}
	if !sameStrings(r.InheritedTags, inherited) {
		return fmt.Sprintf("inherited_tags %v, the reference %v", r.InheritedTags, inherited)
	}

	_, eff := refEffective(text)
	switch op {
	case "add":
		for _, t := range want {
			if hasTag(eff[tgt], t) != hasTag(r.Unchanged, t) {
				return fmt.Sprintf("tag %q is effective %v but unchanged is %v", t, hasTag(eff[tgt], t), r.Unchanged)
			}
			if hasTag(eff[tgt], t) == hasTag(r.Added, t) {
				return fmt.Sprintf("tag %q is effective %v and added is %v", t, hasTag(eff[tgt], t), r.Added)
			}
		}
	case "remove":
		// Per tag: not in the entry itself, then the first reason that says where it is wins; the first tag with such a reason gives the message.
		own := m.EntryTags(tgt)
		wantCode, wantFrom := "", -1
		for _, t := range want {
			if hasTag(own, t) {
				continue
			}
			from := -1
			for _, a := range chain[1:] {
				if hasTag(m.EntryTags(a), t) {
					from = a
					break
				}
			}
			if from >= 0 {
				wantCode, wantFrom = "on_parent", from
				break
			}
			if hasTag(m.FileTags(), t) {
				wantCode = "file" // on_note or front_matter_tag: either is right, the tests of the editor say which
				break
			}
		}
		if wantCode == "" && len(r.Removed) == 0 {
			wantCode = "none_found"
		}
		switch {
		case wantCode == "file" && r.MessageCode != "on_note" && r.MessageCode != "front_matter_tag":
			return fmt.Sprintf("message_code %q, want on_note or front_matter_tag", r.MessageCode)
		case wantCode != "file" && r.MessageCode != wantCode:
			return fmt.Sprintf("message_code %q, want %q", r.MessageCode, wantCode)
		}
		if wantFrom >= 0 {
			hl, h := refHeading(text, entries, level, startsRule, wantFrom)
			if r.ParentHeading != h || r.ParentLine != hl {
				return fmt.Sprintf("parent %q at %d, want %q at %d", r.ParentHeading, r.ParentLine, h, hl)
			}
		} else if r.ParentHeading != "" || r.ParentLine != 0 {
			return fmt.Sprintf("parent %q at %d with message_code %q", r.ParentHeading, r.ParentLine, r.MessageCode)
		}
	}
	if op != "remove" && (r.ParentHeading != "" || r.ParentLine != 0) {
		return "a parent without a removal"
	}
	return ""
}

// checkEditReach checks what an edit of an entry did to the tags that reach the entries, from the old and the new text (the same entries):
// "" when it is right. An add makes the tag reach exactly the entry's subtree (and wherever it already reached); a remove never makes a
// tag reach anything new and does not touch what is outside the subtree; no other tag changes anywhere; and what a remove took out
// of an entry that does not get it from elsewhere can be added again with the same result.
func checkEditReach(before, after, op string, line int, r TagEdit, stats map[string]int) string {
	bd, ad := []byte(before), []byte(after)
	bE, aE := Entries(bd), Entries(ad)
	if len(bE) != len(aE) {
		return ""
	}
	tgt := entryIndexAt(bE, min(line, linesOf(before)))
	if tgt < 0 {
		return "no entry for the line"
	}
	bm, am := ScanTags(bd), ScanTags(ad)
	_, parentA, _ := refOutline(after)
	inSub := func(j int) bool {
		if j == tgt {
			return true
		}
		for _, a := range refAbove(parentA, j) {
			if a == tgt {
				return true
			}
		}
		return false
	}
	probes := append(append([]string{}, propertyTags...), "z", "nothing")
	for j := range bE {
		for _, p := range probes {
			was, is := bm.HasEntry(j, []string{p}), am.HasEntry(j, []string{p})
			switch {
			case op == "add" && hasTag(r.Added, p):
				if is != (was || inSub(j)) {
					return fmt.Sprintf("added %q: entry %d had it %v, has it %v, in the subtree %v", p, j, was, is, inSub(j))
				}
			case op == "remove" && hasTag(r.Removed, p):
				if is && !was || !inSub(j) && is != was {
					return fmt.Sprintf("removed %q: entry %d had it %v, has it %v, in the subtree %v", p, j, was, is, inSub(j))
				}
			default:
				if is != was {
					return fmt.Sprintf("tag %q was not asked for: entry %d had it %v, has it %v", p, j, was, is)
				}
			}
		}
	}
	stats["reach: "+op+" checked"]++

	if op != "remove" {
		return ""
	}
	// remove, then add again what no other heading or the note gives the entry
	var back []string
	for _, x := range r.Removed {
		if !am.HasEntry(tgt, []string{x}) {
			back = append(back, x)
		}
	}
	if len(back) == 0 {
		return ""
	}
	// a line of the entry in the new text: its first line may be in a front matter (that is the note), and the line that was asked about may
	// be the one the removal took away
	probe := 0
	for _, c := range []int{min(aE[tgt].EndLine, linesOf(after)), aE[tgt].StartLine} {
		if sh, err := EditTags(ad, "show", "entry", c, nil); err == nil && sh.Scope == "entry" && sh.RangeStart == aE[tgt].StartLine {
			probe = c
			break
		}
	}
	if probe == 0 {
		return ""
	}
	again, err := EditTags(ad, "add", "entry", probe, back)
	if err != nil || !again.Changed || !sameStrings(again.Added, back) {
		return fmt.Sprintf("adding back %v after the removal: %+v %v", back, again, err)
	}
	third := string(again.Apply(ad))
	tm := ScanTags([]byte(third))
	if !sameTagSet(tm.FileTags(), bm.FileTags()) {
		return fmt.Sprintf("the note's tags after remove and add: %v, before %v", tm.FileTags(), bm.FileTags())
	}
	for j := range bE {
		want := append([]string{}, bm.EntryTags(j)...)
		if j == tgt {
			want = nil
			for _, x := range bm.EntryTags(j) {
				if !hasTag(r.Removed, x) || hasTag(back, x) {
					want = append(want, x)
				}
			}
		}
		if !sameTagSet(tm.EntryTags(j), want) {
			return fmt.Sprintf("entry %d has %v after remove and add, want %v (removed %v, added back %v)", j, tm.EntryTags(j), want, r.Removed, back)
		}
	}
	stats["reach: remove and add again"]++
	return ""
}

func sameTagSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, x := range a {
		if !hasTag(b, x) {
			return false
		}
	}
	return true
}
