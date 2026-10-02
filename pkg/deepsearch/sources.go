// Package deepsearch turns the hits of a semantic search into a note that answers the question and cites its sources: it cuts an
// excerpt out of each hit's file (BuildSources), writes the prompt for a model (BuildPrompt), keeps only the citation numbers that name a
// source and checks its quotations against the notes (Resolve), and lays the note out with a list of linked sources (Compose). Nothing here talks to a model or
// to the window: the functions read the scrap files and compute (docs/design/deep-search-2026-10.md).
package deepsearch

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"md-memo/pkg/lazyre"
	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
)

// Hit is one search hit to be turned into a source. Rel is the file's path inside the scrap folder (with "/"), Line the line of the hit.
type Hit struct {
	Rel     string
	Line    int
	EndLine int
	Score   float64
	Date    string
	Heading string
}

// Source is a numbered excerpt that is sent to the model and cited in the answer.
type Source struct {
	N                  int // 1-based; the number the model cites as [n]
	Rel, Path          string
	URL, Label         string
	Date, Heading      string
	StartLine, EndLine int // the lines of the excerpt in the file
	HitLine            int
	Text               string // what is sent (secrets taken out)
	Chars              int
	Score              float64
	Masked             int // secrets taken out of this excerpt
}

// Stats says what BuildSources used and what it left out.
type Stats struct {
	Used       int // sources
	Ignored    int // hits in files the person excluded (.md-memo-ignore, hidden folders, assets, conflict copies)
	AI         int // hits in an AI's text (a result block, a deep search note)
	Unreadable int // the file is gone, too big, outside the scrap folder, or has no entry at the hit's line
	Merged     int // hits in an entry that is already a source (or the neighbour of one)
	Budget     int // hits left out because of the number of sources or the characters
	TotalChars int
	Masked     int // secrets taken out in all
}

// Options of BuildSources; a zero value takes the defaults of the design.
type Options struct {
	ScrapDir       string
	MaxSources     int // 10
	MaxEntryChars  int // 1500: an entry up to this long is taken whole
	Window         int // 700: a longer entry is cut to about this many characters on each side of the hit
	ShortEntry     int // 300: an entry shorter than this brings its neighbours
	NeighbourChars int // 400: how much of each neighbour
	MaxTotalChars  int // 18000
	MaxFileBytes   int64
	// Excluded says a file (rel) is not to be sent (semindex.Excluded); nil excludes nothing.
	Excluded func(rel string) bool
	// URL and Label make the link of a source (cli.FileURL, cli.LinkLabel); nil leaves them empty.
	URL   func(path string) string
	Label func(date, heading, file string) string
}

func (o Options) withDefaults() Options {
	if o.MaxSources <= 0 {
		o.MaxSources = 10
	}
	if o.MaxEntryChars <= 0 {
		o.MaxEntryChars = 1500
	}
	if o.Window <= 0 {
		o.Window = 700
	}
	if o.ShortEntry <= 0 {
		o.ShortEntry = 300
	}
	if o.NeighbourChars <= 0 {
		o.NeighbourChars = 400
	}
	if o.MaxTotalChars <= 0 {
		o.MaxTotalChars = 18000
	}
	if o.MaxFileBytes <= 0 {
		o.MaxFileBytes = 8 << 20
	}
	return o
}

type fileData struct {
	abs       string
	data      []byte
	entries   []search.Entry
	generated bool // a note a deep search wrote
}

var (
	htmlComment = lazyre.New(`(?s)<!--.*?-->`)
	ruleLine    = lazyre.New(`^-{3,}\s*$`)
	headingLine = lazyre.New(`^#{1,6}\s`)
)

// aiMark opens a result block an AI wrote (and the app put in the note).
const aiMark = "<!-- md-memo:res"

// isAIEntry looks in the entry as it is in the file: entryLines takes the HTML comments out, and the mark is one.
func isAIEntry(fd *fileData, e search.Entry) bool {
	return strings.Contains(string(fd.data[e.StartOff:e.EndOff]), aiMark)
}

// entryLines is an entry as lines, line breaks LF, HTML comments taken out (their line breaks kept, so that line numbers stay right).
func entryLines(fd *fileData, e search.Entry) []string {
	text := strings.ReplaceAll(string(fd.data[e.StartOff:e.EndOff]), "\r\n", "\n")
	text = htmlComment.ReplaceAllStringFunc(text, func(m string) string { return strings.Repeat("\n", strings.Count(m, "\n")) })
	return strings.Split(strings.TrimRight(text, "\n"), "\n")
}

func runes(s string) int { return utf8.RuneCountInString(s) }

// BuildSources cuts an excerpt out of the file of each hit (hits are in the order the search gave them, best first): the entry the
// hit is in (taken whole up to MaxEntryChars, else the lines around the hit), with the end of the entry before it and the start of the
// entry after it when the entry is short. A hit in an entry that is already a source is merged into it. Hits in excluded files and in
// an AI's text are left out, secrets in the text are taken out (Redact), and at most MaxSources sources and MaxTotalChars characters
// are used.
func BuildSources(hits []Hit, o Options) ([]Source, Stats) {
	o = o.withDefaults()
	var out []Source
	var st Stats
	files := map[string]*fileData{}
	used := map[[2]interface{}]bool{} // (rel, entry index) of every entry that is, or sits in, a source
	root := filepath.Clean(o.ScrapDir)

	load := func(rel string) *fileData {
		if fd, ok := files[rel]; ok {
			return fd
		}
		files[rel] = nil
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if !strings.HasPrefix(abs, root+string(filepath.Separator)) { // ".." and absolute paths do not leave the scrap folder
			return nil
		}
		info, err := os.Stat(abs)
		if err != nil || !info.Mode().IsRegular() || info.Size() > o.MaxFileBytes {
			return nil
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return nil
		}
		fd := &fileData{abs: abs, data: data, entries: search.Entries(data), generated: scrap.IsDeepSearchNote(data)}
		files[rel] = fd
		return fd
	}

	for i, h := range hits {
		if len(out) >= o.MaxSources {
			st.Budget += len(hits) - i
			break
		}
		rel := strings.TrimPrefix(filepath.ToSlash(h.Rel), "/")
		if rel == "" {
			st.Unreadable++
			continue
		}
		if o.Excluded != nil && o.Excluded(rel) {
			st.Ignored++
			continue
		}
		fd := load(rel)
		if fd == nil {
			st.Unreadable++
			continue
		}
		if fd.generated {
			st.AI++
			continue
		}
		ei := entryAt(fd.entries, h.Line)
		if ei < 0 {
			st.Unreadable++
			continue
		}
		if used[[2]interface{}{rel, ei}] {
			st.Merged++
			continue
		}
		lines := entryLines(fd, fd.entries[ei])
		first := 0
		if len(lines) > 0 && ruleLine.MatchString(lines[0]) {
			first = 1
		}
		if isAIEntry(fd, fd.entries[ei]) {
			st.AI++
			continue
		}
		startLine := fd.entries[ei].StartLine
		text, lo, hi := excerpt(lines, first, h.Line-startLine, o)
		if strings.TrimSpace(text) == "" {
			continue
		}
		used[[2]interface{}{rel, ei}] = true
		lineLo, lineHi := startLine+lo, startLine+hi

		if runes(text) < o.ShortEntry { // a short entry says little by itself: the end of the one before, the start of the one after
			var before, after string
			if ei > 0 && !used[[2]interface{}{rel, ei - 1}] {
				if t, ok := neighbour(fd, ei-1, false, o); ok {
					before = t
					used[[2]interface{}{rel, ei - 1}] = true
					lineLo = fd.entries[ei-1].StartLine
				}
			}
			if ei+1 < len(fd.entries) && !used[[2]interface{}{rel, ei + 1}] {
				if t, ok := neighbour(fd, ei+1, true, o); ok {
					after = t
					used[[2]interface{}{rel, ei + 1}] = true
					lineHi = fd.entries[ei+1].EndLine
				}
			}
			parts := []string{}
			for _, p := range []string{before, text, after} {
				if strings.TrimSpace(p) != "" {
					parts = append(parts, p)
				}
			}
			text = strings.Join(parts, "\n\n")
		}

		text, masked := Redact(text)
		room := o.MaxTotalChars - st.TotalChars
		if n := runes(text); n > room {
			if room < 400 {
				st.Budget += len(hits) - i
				break
			}
			text = string([]rune(text)[:room]) + "…"
		}
		heading := h.Heading
		if heading == "" {
			for _, l := range lines {
				if headingLine.MatchString(l) {
					heading = strings.TrimSpace(strings.TrimLeft(l, "# "))
					break
				}
			}
		}
		s := Source{
			N: len(out) + 1, Rel: rel, Path: fd.abs, Date: h.Date, Heading: heading, StartLine: lineLo, EndLine: lineHi,
			HitLine: h.Line, Text: text, Chars: runes(text), Score: h.Score, Masked: masked,
		}
		if o.URL != nil {
			s.URL = o.URL(fd.abs)
		}
		if o.Label != nil {
			s.Label = o.Label(h.Date, heading, fd.abs)
		} else {
			s.Label = rel
		}
		out = append(out, s)
		st.TotalChars += s.Chars
		st.Masked += masked
		st.Used++
	}
	// Numbered oldest first (notes of one day: in file order), not in the search's order of relevance: the answer, the list of sources
	// and "which one is newer" are then read as a timeline, and a question about what happened is answered in order.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Date == "") != (b.Date == "") {
			return a.Date != "" // notes with a day first
		}
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if a.Rel != b.Rel {
			return a.Rel < b.Rel
		}
		return a.StartLine < b.StartLine
	})
	for i := range out {
		out[i].N = i + 1
	}
	return out, st
}

// entryAt is the index of the entry that holds line (1-based), or -1.
func entryAt(entries []search.Entry, line int) int {
	for i, e := range entries {
		if line >= e.StartLine && line <= e.EndLine {
			return i
		}
	}
	return -1
}

// excerpt cuts the lines of an entry (lines[first:] are its text; hit is the 0-based index of the hit's line in lines) to at most
// about MaxEntryChars: the whole text when it is that short, otherwise the lines around the hit, with the entry's heading kept in
// front and "…" where text was left out. It returns the text and the 0-based indexes (into lines) of its first and last line.
func excerpt(lines []string, first, hit int, o Options) (string, int, int) {
	body := lines[first:]
	if len(body) == 0 {
		return "", first, first
	}
	hitIdx := hit - first
	if hitIdx < 0 {
		hitIdx = 0
	}
	if hitIdx >= len(body) {
		hitIdx = len(body) - 1
	}
	total := 0
	for _, l := range body {
		total += runes(l) + 1
	}
	if total <= o.MaxEntryChars {
		return strings.Join(body, "\n"), first, first + len(body) - 1
	}
	lo, hi := hitIdx, hitIdx
	chars := runes(body[hitIdx])
	for chars < 2*o.Window && (lo > 0 || hi < len(body)-1) {
		if lo > 0 && (hi >= len(body)-1 || hitIdx-lo <= hi-hitIdx) {
			lo--
			chars += runes(body[lo]) + 1
		} else {
			hi++
			chars += runes(body[hi]) + 1
		}
	}
	var sb strings.Builder
	if lo > 0 && headingLine.MatchString(body[0]) {
		sb.WriteString(body[0] + "\n")
	}
	if lo > 0 {
		sb.WriteString("…\n")
	}
	sb.WriteString(strings.Join(body[lo:hi+1], "\n"))
	if hi < len(body)-1 {
		sb.WriteString("\n…")
	}
	text := sb.String()
	if runes(text) > o.MaxEntryChars { // one very long line: keep the middle of it
		rs := []rune(text)
		text = string(rs[:o.MaxEntryChars]) + "…"
	}
	return text, first + lo, first + hi
}

// neighbour is the end (before) or the start (after) of the entry at index i, at most NeighbourChars characters, whole lines; it is
// not given for an entry that is empty, an AI's text or a rule only.
// isPipedLog is true for an entry whose text is a code fence right after its heading: piped output (a build log, a ping), which the
// semantic index also treats as a log.
func isPipedLog(lines []string) bool {
	for i, l := range lines {
		if i == 0 && headingLine.MatchString(l) {
			continue
		}
		if strings.TrimSpace(l) == "" {
			continue
		}
		return strings.HasPrefix(strings.TrimSpace(l), "```")
	}
	return false
}

func neighbour(fd *fileData, i int, fromStart bool, o Options) (string, bool) {
	if isAIEntry(fd, fd.entries[i]) {
		return "", false
	}
	lines := entryLines(fd, fd.entries[i])
	if len(lines) > 0 && ruleLine.MatchString(lines[0]) {
		lines = lines[1:]
	}
	if len(lines) == 0 {
		return "", false
	}
	heading := ""
	if headingLine.MatchString(lines[0]) {
		heading = lines[0]
	}
	if isPipedLog(lines) { // command output the person piped in says nothing about the note beside it
		return "", false
	}
	var picked []string
	chars := 0
	if fromStart {
		for _, l := range lines {
			if chars+runes(l) > o.NeighbourChars && len(picked) > 0 {
				break
			}
			picked = append(picked, l)
			chars += runes(l) + 1
		}
	} else {
		for j := len(lines) - 1; j >= 0; j-- {
			if chars+runes(lines[j]) > o.NeighbourChars && len(picked) > 0 {
				break
			}
			picked = append([]string{lines[j]}, picked...)
			chars += runes(lines[j]) + 1
		}
	}
	text := strings.Join(picked, "\n")
	if rs := []rune(text); len(rs) > o.NeighbourChars+100 { // one long line: its end (before) or its start (after)
		if fromStart {
			text = string(rs[:o.NeighbourChars]) + "…"
		} else {
			text = "…" + string(rs[len(rs)-o.NeighbourChars:])
		}
	}
	if strings.TrimSpace(text) == "" {
		return "", false
	}
	if !fromStart && heading != "" && !strings.HasPrefix(text, heading) { // the end of an entry, under its own heading
		text = heading + "\n…\n" + strings.TrimPrefix(text, "…")
	}
	return text, true
}

// ---- secrets ---------------------------------------------------------------------------------------------------------------------

type secretPattern struct {
	re   *regexp.Regexp
	with string
}

// patternsOnce builds the patterns on first use: a person who never runs a deep search pays nothing for them.
var patternsOnce = func() func() []secretPattern {
	var built []secretPattern
	done := false
	return func() []secretPattern {
		if !done {
			for _, p := range []struct{ re, with string }{
				{`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`, "[removed: private key]"},
				{`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, "[removed: token]"},
				{`\bsk-[A-Za-z0-9_\-]{16,}`, "[removed: key]"},
				{`\bAIza[0-9A-Za-z_\-]{30,}`, "[removed: key]"},
				{`\bgh[pousr]_[A-Za-z0-9]{30,}`, "[removed: token]"},
				{`\bxox[baprs]-[A-Za-z0-9-]{10,}`, "[removed: token]"},
				{`\bAKIA[0-9A-Z]{16}\b`, "[removed: key]"},
				{`(?i)\bBearer\s+[A-Za-z0-9._~+/=\-]{20,}`, "Bearer [removed]"},
				{`(?i)\b((?:api[_-]?key|secret|token|passw(?:or)?d|passwd)\w*)(\s*[:=]\s*)["']?[^\s"'<>]{6,}["']?`, "${1}${2}[removed]"},
			} {
				built = append(built, secretPattern{regexp.MustCompile(p.re), p.with})
			}
			done = true
		}
		return built
	}
}()

// Redact takes the secrets out of text before it is sent to a model: private key blocks, JSON web tokens, the keys and tokens that
// providers issue (sk-..., AIza..., ghp_..., xox..., AKIA...), "Bearer ..." and the value of key=value pairs whose name says api key,
// secret, token or password. It returns the text and how many were taken out. It is a net, not a guarantee: a secret in a shape it does
// not know goes through, which is one more reason the person sees what is sent before it is.
func Redact(text string) (string, int) {
	n := 0
	for _, p := range patternsOnce() {
		text = p.re.ReplaceAllStringFunc(text, func(m string) string {
			n++
			return p.re.ReplaceAllString(m, p.with)
		})
	}
	return text, n
}
