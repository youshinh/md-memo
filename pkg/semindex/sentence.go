package semindex

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Where a sentence ends, in Japanese and in English text. A chunk is packed from whole sentences, so a wrong cut shows in the text
// that is kept and searched: a closing bracket left alone at the start of a chunk, or "Mr." standing as a sentence of its own.

// isTerminator: the marks that end a sentence by themselves.
func isTerminator(r rune) bool { return strings.ContainsRune("。！？!?", r) }

// isCloser: closing quotes and brackets belong to the sentence they close ("...送る。」と言った").
func isCloser(r rune) bool { return strings.ContainsRune("」』）】〕〉》｣)]}\"'”’»", r) }

// titleAbbreviations are words that take a full stop without ending the sentence ("Mr. Smith", "Fig. 3").
var titleAbbreviations = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "dr": true, "prof": true, "sr": true, "jr": true, "st": true, "vs": true,
	"inc": true, "ltd": true, "co": true, "fig": true, "approx": true, "cf": true,
}

// sentenceEnd says whether a sentence ends at rs[i], and returns the index of the last rune that belongs to it (closing brackets and
// repeated marks after it are part of it); -1 when no sentence ends here. A line break always ends one (lists, logs, one-line notes).
func sentenceEnd(rs []rune, i int) int {
	r := rs[i]
	switch {
	case r == '\n':
		return i
	case isTerminator(r):
		end := i
		for end+1 < len(rs) && (isTerminator(rs[end+1]) || isCloser(rs[end+1])) {
			end++
		}
		return end
	case r == '.':
		j := i
		for j+1 < len(rs) && isCloser(rs[j+1]) { // He said "stop." / (see above.)
			j++
		}
		if j+1 < len(rs) && rs[j+1] != ' ' && rs[j+1] != '\t' && rs[j+1] != '\n' { // 3.5, example.com, "..." in the middle
			return -1
		}
		if !dotEndsSentence(rs, i, j) {
			return -1
		}
		return j
	}
	return -1
}

// dotEndsSentence decides on a full stop that is followed by a space (or the end): not when the next word starts in lower case
// ("e.g. the", "etc. and"), not after an initial or a dotted abbreviation ("J. Smith", "e.g.", "U.S."), not after a title ("Mr.").
func dotEndsSentence(rs []rune, dot, last int) bool {
	k := last + 1
	for k < len(rs) && (rs[k] == ' ' || rs[k] == '\t') {
		k++
	}
	if k < len(rs) && unicode.IsLower(rs[k]) {
		return false
	}
	s := dot
	for s > 0 && unicode.IsLetter(rs[s-1]) {
		s--
	}
	if dot-s == 1 && rs[s] < unicode.MaxASCII {
		return false
	}
	return !titleAbbreviations[strings.ToLower(string(rs[s:dot]))]
}

// clauseEnd: where a very long sentence may be cut as a last resort, after a comma.
func clauseEnd(rs []rune, i int) int {
	switch rs[i] {
	case '、', '，', '；', ';':
		return i
	case ',':
		if i+1 == len(rs) || rs[i+1] == ' ' || rs[i+1] == '\n' {
			return i
		}
	}
	return -1
}

// splitSpans cuts text into spans (trimmed of white space, with their byte offsets in the whole body, base being the offset of text
// in it) after every position where the function made by prepare reports an end (the index of the span's last rune, or -1).
func splitSpans(text string, base int, prepare func(rs []rune) func(i int) int) []span {
	rs := []rune(text)
	cutAt := prepare(rs)
	offs := make([]int, len(rs)+1) // byte offset of each rune, to slice the original string
	pos := 0
	for i, r := range rs {
		offs[i] = pos
		pos += utf8.RuneLen(r)
	}
	offs[len(rs)] = pos
	var out []span
	start := 0
	for i := 0; i < len(rs); i++ {
		end := cutAt(i)
		if end < 0 {
			continue
		}
		if sp := trimSpan(base+offs[start], text[offs[start]:offs[end+1]]); sp.text != "" {
			out = append(out, sp)
		}
		start = end + 1
		i = end
	}
	if start < len(rs) {
		if sp := trimSpan(base+offs[start], text[offs[start]:]); sp.text != "" {
			out = append(out, sp)
		}
	}
	return out
}

// quoteDepth[i] is how many Japanese quotation marks (「 『) are open before rune i. A line break closes them all: a quotation that is
// never closed must not join the rest of the note into one sentence.
func quoteDepth(rs []rune) []int8 {
	depth := make([]int8, len(rs))
	var d int8
	for i, r := range rs {
		depth[i] = d
		switch r {
		case '「', '『':
			if d < 100 {
				d++
			}
		case '」', '』':
			if d > 0 {
				d--
			}
		case '\n':
			d = 0
		}
	}
	return depth
}

// sentences cuts a paragraph into sentences (see sentenceEnd). A stop inside a quotation does not end the sentence: 彼は「明日送る。」と
// 言った。 is one sentence.
func sentences(text string, base int) []span {
	return splitSpans(text, base, func(rs []rune) func(int) int {
		depth := quoteDepth(rs)
		return func(i int) int {
			if depth[i] > 0 && rs[i] != '\n' {
				return -1
			}
			return sentenceEnd(rs, i)
		}
	})
}

// units are what a paragraph is packed from: its sentences, except that a sentence longer than twice the chunk size (a run-on of
// clauses, a line with no stops) is cut after its commas, so that one sentence does not make a chunk several times too big. A sentence
// is never cut inside otherwise: its parts only mean something together.
func units(text string, base, max int) []span {
	var out []span
	for _, sn := range sentences(text, base) {
		if utf8.RuneCountInString(sn.text) > 2*max {
			out = append(out, splitSpans(sn.text, sn.off, func(rs []rune) func(int) int { return func(i int) int { return clauseEnd(rs, i) } })...)
			continue
		}
		out = append(out, sn)
	}
	return out
}
