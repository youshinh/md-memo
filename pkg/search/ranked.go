package search

import (
	"bytes"
	"context"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
)

// The ranked search finds a NOTE (one entry of a scrap: the lines between two "---" rules or Markdown headings) by the WORDS of the
// query instead of by one line that holds the whole text. "納期 図面" finds an entry that mentions both, on any lines, in any order;
// the plain search only finds a line that contains "納期 図面" exactly. Entries that hold every word come first (best scoring
// first); when no entry has them all, the entries that hold at least half of the words are listed instead and marked Partial.
//
// It is the lexical half of the planned semantic search (docs/design/semantic-search-2026-10.md): the same words and the same
// BM25 ranking, with no index (the files are read when the search runs, like the plain search).

// maxQueryTerms bounds the words taken from one query (the rest are ignored).
const maxQueryTerms = 8

// maxRankedFileBytes: a file larger than this is not searched by the ranked search (the plain search streams it).
const maxRankedFileBytes = 64 << 20

// Terms splits a search text into the words an entry has to contain. Words are separated by spaces; a "quoted phrase" stays one
// word. Japanese has no spaces, so a run of kanji, katakana or Latin letters and digits is a word and the hiragana between them
// (the particles: の、を、が…) separates them: "取引先との納期の約束" is 取引先, 納期, 約束. One-character kanji are dropped unless
// they are all there is, or a verb or adjective stem with its okurigana ("上げる", "悪い"). Words are lower case and unique.
func Terms(query string) []string {
	var terms []string
	seen := map[string]bool{}
	add := func(t string) {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			return
		}
		seen[t] = true
		terms = append(terms, t)
	}
	for _, part := range splitQuery(query) {
		if part.quoted {
			add(part.text)
			continue
		}
		for _, w := range contentWords(part.text) {
			add(w)
		}
	}
	if len(terms) > maxQueryTerms {
		terms = terms[:maxQueryTerms]
	}
	return terms
}

type queryPart struct {
	text   string
	quoted bool
}

// splitQuery cuts the query at white space (the ideographic space too) and keeps "quoted phrases" together.
func splitQuery(q string) []queryPart {
	var parts []queryPart
	var cur []rune
	quoted := false
	flush := func(isQuoted bool) {
		if len(cur) > 0 {
			parts = append(parts, queryPart{text: string(cur), quoted: isQuoted})
		}
		cur = cur[:0]
	}
	for _, r := range q {
		switch {
		case r == '"' || r == '“' || r == '”':
			flush(quoted)
			quoted = !quoted
		case !quoted && unicode.IsSpace(r):
			flush(false)
		default:
			cur = append(cur, r)
		}
	}
	flush(quoted)
	return parts
}

type runeClass int

const (
	clsSep runeClass = iota
	clsHan
	clsKata
	clsHira
	clsWord
)

func classify(r rune) runeClass {
	switch {
	case r == 'ー' || unicode.Is(unicode.Katakana, r): // ー is not "Katakana" in Unicode's script data, but belongs to the word
		return clsKata
	case unicode.Is(unicode.Han, r) || r == '々' || r == '〆': // 々 〆
		return clsHan
	case unicode.Is(unicode.Hiragana, r):
		return clsHira
	case r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r):
		return clsWord
	}
	return clsSep
}

type run struct {
	cls  runeClass
	text []rune
}

// splitRuns cuts text into runs of one class. A Latin word keeps ". - : / @ _" inside it when a letter or digit follows
// ("128.1.33.254", "foo-bar", "user@host").
func splitRuns(text string) []run {
	rs := []rune(text)
	var out []run
	for i := 0; i < len(rs); {
		c := classify(rs[i])
		j := i + 1
		for j < len(rs) {
			cj := classify(rs[j])
			if cj == c {
				j++
				continue
			}
			if c == clsWord && j+1 < len(rs) && strings.ContainsRune("._-:/@", rs[j]) && classify(rs[j+1]) == clsWord {
				j += 2
				continue
			}
			break
		}
		if c != clsSep {
			out = append(out, run{cls: c, text: rs[i:j]})
		}
		i = j
	}
	return out
}

// particles end a hiragana run that follows a kanji stem; they are not part of the word. Longest first.
var particles = []string{"から", "まで", "より", "では", "には", "とは", "への", "での", "など", "とか", "けど", "ので", "のに", "でも", "だけ", "しか",
	"が", "は", "を", "に", "で", "と", "も", "の", "な", "へ", "や", "か"}

func stripParticles(h string) string {
	for changed := true; changed && h != ""; {
		changed = false
		for _, p := range particles {
			if strings.HasSuffix(h, p) {
				h = strings.TrimSuffix(h, p)
				changed = true
				break
			}
		}
	}
	return h
}

// contentWords gives the words of one white-space free piece of a query.
func contentWords(piece string) []string {
	runs := splitRuns(piece)
	var words, singles []string
	for i, r := range runs {
		switch r.cls {
		case clsKata, clsWord:
			if len(r.text) >= 2 {
				words = append(words, string(r.text))
			} else {
				singles = append(singles, string(r.text))
			}
		case clsHan:
			if len(r.text) >= 2 {
				words = append(words, string(r.text))
				continue
			}
			// one kanji: a verb or adjective stem when its okurigana follow ("上げる", "悪い"), else only a last resort
			if i+1 < len(runs) && runs[i+1].cls == clsHira {
				if rest := stripParticles(string(runs[i+1].text)); rest != "" && len([]rune(rest)) <= 4 {
					words = append(words, string(r.text)+rest)
					continue
				}
			}
			singles = append(singles, string(r.text))
		}
	}
	if len(words) > 0 {
		return words
	}
	if len(singles) > 0 {
		return singles
	}
	// nothing but hiragana (or symbols): the piece itself is the word
	if s := strings.TrimSpace(piece); s != "" {
		return []string{s}
	}
	return nil
}

// entryStat is what the first pass keeps of one entry: where it is and how often each word occurs in it. The text is not kept.
type entryStat struct {
	file    int
	start   int // 1-based first line
	end     int // 1-based last line
	counts  []int32
	length  int
	matched int
	phrase  bool
	score   float64
	partial bool
}

// entrySplitter finds where the entries of a file start: a "---" rule or an ATX heading (# to ###), outside fenced code. A heading
// right after a rule belongs to the rule's entry ("---" then "## [10:09:51] CLI Pipe" is one entry).
type entrySplitter struct {
	tracker headingTracker
	onlyRul bool // the entry being built is just a rule line so far
}

func isRuleLine(line string) bool {
	t := strings.TrimSpace(line)
	return len(t) >= 3 && strings.Trim(t, "-") == ""
}

func isEntryHeading(line string) bool {
	i := 0
	for i < len(line) && line[i] == ' ' {
		i++
	}
	if i > 3 {
		return false
	}
	n := 0
	for i+n < len(line) && line[i+n] == '#' {
		n++
	}
	if n < 1 || n > 3 {
		return false
	}
	rest := line[i+n:]
	return rest == "" || rest[0] == ' ' || rest[0] == '\t'
}

// startsEntry reports whether this line begins a new entry, and takes the line into the fence state.
func (s *entrySplitter) startsEntry(line string, num int) bool {
	inFence := s.tracker.fenceChar != 0
	s.tracker.feed(line, num)
	if inFence {
		return false
	}
	rule := isRuleLine(line)
	heading := isEntryHeading(line)
	if !rule && !heading {
		s.onlyRul = false
		return false
	}
	if heading && s.onlyRul {
		s.onlyRul = false
		return false
	}
	s.onlyRul = rule
	return true
}

// Entry is one entry of a Markdown scrap: the lines between two "---" rules or headings (# to ###), outside fenced code. Lines and
// byte offsets are for the data that was split (StartLine and EndLine are 1-based and inclusive, EndOff is exclusive). The semantic
// index (pkg/semindex) cuts the scraps into the same entries.
type Entry struct {
	StartLine, EndLine int
	StartOff, EndOff   int
}

// Entries cuts a file into its entries. The file is walked line by line without copying a line: only a line that starts with "-", "#",
// "`" or "~" (a rule, a heading, a fence) is looked at as text, the rest cannot change where an entry starts.
func Entries(data []byte) []Entry {
	var out []Entry
	var sp entrySplitter
	startOff, startLine, lineNo := 0, 1, 0

	flush := func(endOff, endLine int) {
		if endOff > startOff {
			out = append(out, Entry{StartLine: startLine, EndLine: endLine, StartOff: startOff, EndOff: endOff})
		}
	}

	for off := 0; off < len(data); {
		end := bytes.IndexByte(data[off:], '\n')
		next := len(data)
		if end >= 0 {
			end += off
			next = end + 1
		} else {
			end = len(data)
		}
		lineNo++
		line := bytes.TrimSuffix(data[off:end], []byte("\r"))
		first := byte(0)
		for _, c := range line {
			if c != ' ' {
				first = c
				break
			}
		}
		switch first {
		case '-', '#', '`', '~':
			if sp.startsEntry(string(line), lineNo) && lineNo > startLine {
				flush(off, lineNo-1)
				startOff, startLine = off, lineNo
			}
		default:
			sp.onlyRul = false // a plain line: no rule is waiting for its heading any more
		}
		off = next
	}
	flush(len(data), lineNo)
	return out
}

// scanEntries is the first pass over one file: it counts the words in each entry (the text itself is not kept) and returns the
// entries that hold at least one of them.
func scanEntries(data []byte, fi int, termBytes [][]byte, phrase []byte) []entryStat {
	var out []entryStat
	for _, e := range Entries(data) {
		low := bytes.ToLower(data[e.StartOff:e.EndOff])
		st := entryStat{file: fi, start: e.StartLine, end: e.EndLine, counts: make([]int32, len(termBytes)), length: len(low)}
		for ti, tb := range termBytes {
			if c := bytes.Count(low, tb); c > 0 {
				st.counts[ti] = int32(c)
				st.matched++
			}
		}
		if st.matched == 0 {
			continue
		}
		if len(termBytes) > 1 && len(phrase) > 0 {
			st.phrase = bytes.Contains(low, phrase)
		}
		out = append(out, st)
	}
	return out
}

func splitLines(data []byte) [][]byte {
	lines := bytes.Split(data, []byte("\n"))
	if n := len(lines); n > 0 && len(lines[n-1]) == 0 {
		lines = lines[:n-1]
	}
	for i, l := range lines {
		lines[i] = bytes.TrimSuffix(l, []byte("\r"))
	}
	return lines
}

// SearchScrapsRanked is the ranked, word-based search (see the top of this file). Every hit is one entry: its result holds one
// match, the line of the entry with the most of the words, with Score (higher is a better hit) and Partial (not every word is in
// the entry). Hits come best first; equal scores keep the file order of opts (newest file first by default). opts.Keep and
// opts.Headings work as in SearchScrapsOrdered; opts.Less orders the files for equal scores. It stops at maxResults hits (100 when
// maxResults <= 0).
func SearchScrapsRanked(ctx context.Context, scrapDir, query string, maxResults int, opts Options) ([]SearchResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	terms := Terms(query)
	if len(terms) == 0 {
		return []SearchResult{}, nil
	}
	if maxResults <= 0 {
		maxResults = 100
	}
	cleanDir := filepath.Clean(scrapDir)
	if info, err := os.Stat(cleanDir); err != nil || !info.IsDir() {
		return []SearchResult{}, nil
	}

	var files []string
	for _, p := range collectMarkdownFiles(cleanDir) {
		if opts.Keep == nil || opts.Keep(p) {
			files = append(files, p)
		}
	}
	less := opts.Less
	if less == nil {
		less = newestNameFirst
	}
	sort.Slice(files, func(i, j int) bool { return less(files[i], files[j]) })

	phraseLower := []byte(strings.ToLower(strings.Join(strings.Fields(query), " ")))
	termBytes := make([][]byte, len(terms))
	for i, t := range terms {
		termBytes[i] = []byte(t)
	}

	// pass 1: how often each word occurs in each entry. The files are read in parallel; the per-file answers are put back in file
	// order, so the result does not depend on which worker was faster.
	perFile := make([][]entryStat, len(files))
	workers := runtime.NumCPU()
	if workers > len(files) {
		workers = len(files)
	}
	if workers < 1 {
		workers = 1
	}
	var next int64 = -1
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				fi := int(atomic.AddInt64(&next, 1))
				if fi >= len(files) || ctx.Err() != nil {
					return
				}
				path := files[fi]
				if info, err := os.Stat(path); err != nil || info.Size() > maxRankedFileBytes {
					continue
				}
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				perFile[fi] = scanEntries(data, fi, termBytes, phraseLower)
			}
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return []SearchResult{}, nil
	}
	var entries []entryStat
	df := make([]int, len(terms))
	totalLen := 0
	for _, fe := range perFile {
		for _, e := range fe {
			for ti, c := range e.counts {
				if c > 0 {
					df[ti]++
				}
			}
			totalLen += e.length
			entries = append(entries, e)
		}
	}
	if len(entries) == 0 {
		return []SearchResult{}, nil
	}

	// the entries that hold every word; when there are none, those that hold at least half of them
	need := len(terms)
	full := 0
	for _, e := range entries {
		if e.matched == len(terms) {
			full++
		}
	}
	partial := false
	if full == 0 {
		if len(terms) < 2 {
			return []SearchResult{}, nil
		}
		need = (len(terms) + 1) / 2
		partial = true
	}

	// BM25 over the words found (the document is an entry; the statistics are those of the entries that hold a word)
	n := float64(len(entries))
	avg := float64(totalLen) / n
	const k1, b = 1.2, 0.75
	var hits []entryStat
	for _, e := range entries {
		if e.matched < need {
			continue
		}
		s := 0.0
		for ti, c := range e.counts {
			if c == 0 {
				continue
			}
			idf := math.Log(1 + (n-float64(df[ti])+0.5)/(float64(df[ti])+0.5))
			f := float64(c)
			s += idf * f * (k1 + 1) / (f + k1*(1-b+b*float64(e.length)/avg))
		}
		if e.phrase {
			s *= 1.5 // the words in the very order and place the query has them
		}
		e.score = s
		e.partial = partial
		hits = append(hits, e)
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		if hits[i].file != hits[j].file {
			return hits[i].file < hits[j].file // files are already in the caller's order
		}
		return hits[i].start < hits[j].start
	})
	if len(hits) > maxResults {
		hits = hits[:maxResults]
	}

	// pass 2: for the hits only, the best line, its snippet and heading
	results := make([]SearchResult, len(hits))
	byFile := map[int][]int{}
	for i, h := range hits {
		byFile[h.file] = append(byFile[h.file], i)
	}
	for fi, idxs := range byFile {
		path := files[fi]
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := splitLines(data)
		for _, hi := range idxs {
			h := hits[hi]
			best, bestN := h.start, -1
			for ln := h.start; ln <= h.end && ln <= len(lines); ln++ {
				low := bytes.ToLower(lines[ln-1])
				c := 0
				for _, tb := range termBytes {
					if bytes.Contains(low, tb) {
						c++
					}
				}
				if c > bestN {
					best, bestN = ln, c
				}
			}
			m := SearchMatch{LineNumber: best, LineText: string(lines[best-1]), Score: round3(h.score), Partial: h.partial}
			var parts []string
			if best > 1 {
				parts = append(parts, string(lines[best-2]))
			}
			parts = append(parts, m.LineText)
			if best < len(lines) {
				parts = append(parts, string(lines[best]))
			}
			m.Snippet = strings.Join(parts, "\n")
			if opts.Headings {
				var tr headingTracker
				for ln := 1; ln <= best; ln++ {
					tr.feed(string(lines[ln-1]), ln)
				}
				m.Heading, m.HeadingLine = tr.heading, tr.line
			}
			results[hi] = SearchResult{FilePath: path, FileName: filepath.Base(path), Matches: []SearchMatch{m}}
		}
	}
	out := results[:0]
	for _, r := range results {
		if len(r.Matches) > 0 {
			out = append(out, r)
		}
	}
	return out, nil
}

func round3(x float64) float64 { return math.Round(x*1000) / 1000 }

// SearchScrapsWithFallback is what the GUI search runs: the plain search first, exactly as before, and only when it finds nothing
// the ranked word search, so a query that has no line holding all of it still finds the notes that talk about it. The matches of
// the fallback carry a Score; the plain ones do not.
func SearchScrapsWithFallback(ctx context.Context, scrapDir, query string, maxResults int) ([]SearchResult, error) {
	res, err := SearchScrapsContext(ctx, scrapDir, query, maxResults)
	if err != nil || len(res) > 0 || ctx == nil || ctx.Err() != nil {
		return res, err
	}
	return SearchScrapsRanked(ctx, scrapDir, query, maxResults, Options{})
}
