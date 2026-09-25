package slotagent

import (
	"strings"
	"unicode/utf8"
)

// HTML comments (<!-- ... -->) in a note are hidden text: a slot or task inside one never runs, and the preview
// does not show it. findHTMLComments and frontend/js/html_comments.js (htmlCommentRanges) implement the SAME rules,
// so the frontend and this parser always agree on what is commented out; tests/fixtures/html_comment_vectors.json
// is run by both test suites. Offsets here are byte offsets, the frontend's are UTF-16 indexes of the same text:
// every character the rules look at is ASCII, so both describe the same spans.
//
// The rules:
//   - A comment runs from "<!--" to the first "-->" after it (comments do not nest). "<!-->" and "<!--->" are
//     complete, empty comments, as in HTML. A "<!--" with no "-->" anywhere after it is not a comment, and nothing
//     after it can be one either.
//   - A "<!--" inside a fenced code block does not start a comment. The fence rules are those of auto_selector.js:
//     at most 3 spaces, then 3 or more backticks or tildes (a backtick fence may not have a backtick after it),
//     closed by a line of the same character at least as long with only whitespace after it; an unclosed fence runs
//     to the end.
//   - A "<!--" inside inline code does not start a comment either. Inline code is read as CommonMark reads it, on
//     one line: a run of n backticks opens a code span when a later run of exactly n backticks on the same line
//     closes it, otherwise it is plain text. The runs are read from the line start, or from the end of the last
//     comment on that line (backticks inside a comment are not code).
//   - md-memo's own markers ("<!-- md-memo:run id -->", "<!-- md-memo:res id -->", "<!-- /md-memo:res -->") are
//     the note's structure (result blocks), not hidden text: they are not reported.
// Whitespace means what JavaScript's \s means, so both sides read the same characters as blank.

// findHTMLComments returns the byte ranges of the comments in content, in order.
func findHTMLComments(content string) []ExcludedRange {
	return scanHTMLComments(content, -1)
}

// InsideHTMLComment reports whether the byte offset lies strictly inside a comment (between its "<" and its last
// ">"): a caret right before "<!--" or right after "-->" is outside. Only the text before offset is read.
func InsideHTMLComment(content string, offset int) bool {
	if offset <= 0 || offset >= len(content) {
		return false
	}
	rs := scanHTMLComments(content, offset)
	if len(rs) == 0 {
		return false
	}
	last := rs[len(rs)-1]
	return last.Start < offset && offset < last.End
}

// scanHTMLComments is the one pass behind both. With stopAt >= 0 only the comments that start before stopAt are
// looked for. It mirrors scan() in html_comments.js statement for statement.
func scanHTMLComments(content string, stopAt int) []ExcludedRange {
	next := strings.Index(content, "<!--")
	if next < 0 {
		return nil
	}
	limited := stopAt >= 0
	n := len(content)
	fences := strings.Contains(content, "```") || strings.Contains(content, "~~~")
	var ranges []ExcludedRange
	var openCh byte
	openLen := 0
	ls := 0
	for ls < n {
		if limited && ls >= stopAt {
			break
		}
		if next >= 0 && next < ls {
			next = indexFrom(content, "<!--", ls)
		}
		if next < 0 {
			break
		}
		le := lineEndFrom(content, ls)
		if fences {
			ch, length, rest, ok := fenceAt(content, ls, le)
			if openLen > 0 {
				if ok && ch == openCh && length >= openLen && isJSBlank(rest) {
					openLen = 0
				}
				ls = le + 1
				continue
			}
			if ok {
				openCh, openLen = ch, length
				ls = le + 1
				continue
			}
		}
		// The comments that start on this line. Inline code is read from the line start, then from the end of
		// each comment.
		from := ls
		for next >= 0 && next < le {
			p := next
			if limited && p >= stopAt {
				return ranges
			}
			code, walked := codeSpanEnd(content, from, p, le)
			from = walked
			if code >= 0 {
				next = indexFrom(content, "<!--", code)
				continue
			}
			closeAt := indexFrom(content, "-->", p+2)
			if closeAt < 0 {
				return ranges
			}
			end := closeAt + 3
			if !isMarkerComment(content, p) {
				ranges = append(ranges, ExcludedRange{Start: p, End: end})
			}
			next = indexFrom(content, "<!--", end)
			if end > le {
				// The comment went on past this line: carry on after it, on the line where it ends.
				le = lineEndFrom(content, end)
			}
			from = end
		}
		ls = le + 1
	}
	return ranges
}

// indexFrom is strings.Index starting at from (-1 when absent).
func indexFrom(s, sub string, from int) int {
	if from > len(s) {
		return -1
	}
	i := strings.Index(s[from:], sub)
	if i < 0 {
		return -1
	}
	return from + i
}

// lineEndFrom is the index of the next '\n' at or after from, or len(s).
func lineEndFrom(s string, from int) int {
	if from >= len(s) {
		return len(s)
	}
	i := strings.IndexByte(s[from:], '\n')
	if i < 0 {
		return len(s)
	}
	return from + i
}

// fenceAt reads the line [ls, le) as a fence line (fenceLine in auto_selector.js): the fence character, the length
// of its run, and the text after it. One CR before the line break is not part of the line.
func fenceAt(s string, ls, le int) (byte, int, string, bool) {
	line := s[ls:le]
	if strings.HasSuffix(line, "\r") {
		line = line[:len(line)-1]
	}
	i := 0
	for i < 3 && i < len(line) && line[i] == ' ' {
		i++
	}
	if i >= len(line) || (line[i] != '`' && line[i] != '~') {
		return 0, 0, "", false
	}
	ch := line[i]
	j := i
	for j < len(line) && line[j] == ch {
		j++
	}
	if j-i < 3 {
		return 0, 0, "", false
	}
	rest := line[j:]
	// The JS pattern ends in (.*)$ without the m flag: "." never matches CR, U+2028 or U+2029.
	if strings.ContainsAny(rest, "\r  ") {
		return 0, 0, "", false
	}
	if ch == '`' && strings.IndexByte(rest, '`') >= 0 {
		return 0, 0, "", false
	}
	return ch, j - i, rest, true
}

// backtickRunEnd is the end of the run of backticks that starts at q (le: end of the line).
func backtickRunEnd(s string, q, le int) int {
	k := q
	for k < le && s[k] == '`' {
		k++
	}
	return k
}

// codeSpanEnd walks the backtick runs of the line from `from` up to p. It returns the end of the code span that
// holds p (or -1 when p is not in one) and where the next walk starts.
func codeSpanEnd(s string, from, p, le int) (int, int) {
	i := from
	for i < p {
		q := indexFrom(s, "`", i)
		if q < 0 || q >= p {
			break
		}
		k := backtickRunEnd(s, q, le)
		closeAt := -1
		for j := k; j < le; {
			r := indexFrom(s, "`", j)
			if r < 0 || r >= le {
				break
			}
			e := backtickRunEnd(s, r, le)
			if e-r == k-q {
				closeAt = e
				break
			}
			j = e
		}
		if closeAt < 0 {
			i = k
			continue
		}
		if closeAt > p {
			return closeAt, closeAt
		}
		i = closeAt
	}
	return -1, i
}

// isMarkerComment: the comment at p is an md-memo marker (the JS pattern /<!--\s*\/?md-memo:/).
func isMarkerComment(s string, p int) bool {
	i := p + 4
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if !isJSSpace(r) {
			break
		}
		i += size
	}
	if i < len(s) && s[i] == '/' {
		i++
	}
	return strings.HasPrefix(s[i:], "md-memo:")
}

// isJSSpace is JavaScript's \s: the characters a JS regular expression counts as whitespace.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// isJSBlank is /^\s*$/.
func isJSBlank(s string) bool {
	for _, r := range s {
		if !isJSSpace(r) {
			return false
		}
	}
	return true
}
