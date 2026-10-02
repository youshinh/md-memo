// Package semindex is the semantic index of the scraps (docs/design/semantic-search-2026-10.md): the scrap files are cut into small
// chunks, each chunk is turned into a vector by an embed.Embedder, and a query finds the chunks whose vectors are closest to its own
// (plus a small boost for chunks that share its characters). The index is a derived copy that lives outside the scrap folder; the
// Markdown stays the only source of truth.
package semindex

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"

	"md-memo/pkg/lazyre"
	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
)

// ChunkerVersion changes whenever the way text is cut changes: an index made with another version is rebuilt.
const ChunkerVersion = 4

const (
	// DefaultMaxChars is the chunk size the experiments of the design favoured (150): a fact is usually one sentence, and a small chunk
	// keeps it from being diluted by its neighbours.
	DefaultMaxChars = 150
	// logHeadChars: a piped log (ping, build output) is embedded by its head only.
	logHeadChars = 1000
	// hardMaxChars bounds a chunk made of one very long sentence or line.
	hardMaxChars = 2000
)

// ChunkOptions says how files are cut.
type ChunkOptions struct {
	MaxChars  int  // 0 = DefaultMaxChars
	Header    bool // put "date > heading" in front of the text that is embedded (not of the text that is kept)
	IncludeAI bool // keep the AI result blocks (md-memo:res); by default they are not indexed: an AI's own words searched again only echo
}

func (o ChunkOptions) maxChars() int {
	if o.MaxChars <= 0 {
		return DefaultMaxChars
	}
	return o.MaxChars
}

// Chunk is one piece of one entry of a scrap file.
type Chunk struct {
	Rel     string `json:"rel"`               // path inside the scrap folder, with "/" separators
	Entry   int    `json:"entry"`             // which entry of the file (0-based)
	Line    int    `json:"line"`              // 1-based first line of the chunk's text in the file
	EndLine int    `json:"end"`               // 1-based last line
	Date    string `json:"date,omitempty"`    // YYYY-MM-DD when the file is named so
	Heading string `json:"heading,omitempty"` // the entry's heading, without the # marks
	Kind    string `json:"kind"`              // "note", "log" (piped output) or "ai"
	Text    string `json:"text"`
	Hash    string `json:"hash"` // of the text that is embedded
}

// Kinds of chunk.
const (
	KindNote = "note"
	KindLog  = "log"
	KindAI   = "ai"
)

var (
	dateInName   = lazyre.New(`^(\d{4}-\d{2}-\d{2})`)
	htmlComment  = lazyre.New(`(?s)<!--.*?-->`)
	paraBreak    = lazyre.New(`\n[ \t]*\n(?:[ \t]*\n)*`)
	headingMarks = lazyre.New(`^#{1,6}\s*`)
)

// dateOfName is the YYYY-MM-DD a file name starts with, or "".
func dateOfName(rel string) string {
	base := rel
	if i := strings.LastIndexByte(rel, '/'); i >= 0 {
		base = rel[i+1:]
	}
	if m := dateInName.FindStringSubmatch(base); m != nil {
		return m[1]
	}
	return ""
}

// EmbedText is what is sent to the model for a chunk.
func EmbedText(text, date, heading string, header bool) string {
	if !header {
		return text
	}
	h := strings.TrimSpace(date)
	if hd := strings.TrimSpace(heading); hd != "" {
		if h != "" {
			h += " > "
		}
		h += hd
	}
	if h == "" {
		return text
	}
	return h + "\n" + text
}

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:16])
}

func isRule(line string) bool {
	t := strings.TrimSpace(line)
	return len(t) >= 3 && strings.Trim(t, "-") == ""
}

func isHeading(line string) bool {
	t := strings.TrimLeft(line, " ")
	if len(line)-len(t) > 3 {
		return false
	}
	n := 0
	for n < len(t) && t[n] == '#' {
		n++
	}
	return n >= 1 && n <= 6 && (len(t) == n || t[n] == ' ' || t[n] == '\t')
}

// ChunkFile cuts one scrap file into chunks: entry by entry (the same entries the ranked search uses), each entry's body packed into
// pieces of at most MaxChars characters (paragraphs together; a longer paragraph by sentences, one sentence repeated at the join).
// Piped output (a code fence right after the entry's heading) is cut from its first logHeadChars characters only; AI result blocks
// are left out unless asked for; HTML comments are not text.
func ChunkFile(rel string, data []byte, opts ChunkOptions) []Chunk {
	max := opts.maxChars()
	date := dateOfName(rel)
	var out []Chunk
	generated := scrap.IsDeepSearchNote(data) // a note a deep search wrote is an AI's text, whole
	for idx, e := range search.Entries(data) {
		text := strings.ReplaceAll(string(data[e.StartOff:e.EndOff]), "\r\n", "\n")
		kind := KindNote
		if generated || strings.Contains(text, "<!-- md-memo:res") {
			kind = KindAI
			if !opts.IncludeAI {
				continue
			}
		}
		lines := strings.Split(text, "\n")
		i := 0
		if i < len(lines) && isRule(lines[i]) {
			i++
		}
		heading := ""
		if i < len(lines) && isHeading(lines[i]) {
			heading = strings.TrimSpace(headingMarks.ReplaceAllString(strings.TrimSpace(lines[i]), ""))
			i++
		}
		body := strings.Join(lines[i:], "\n")
		bodyLine := e.StartLine + i
		// comments are not text, but they keep their line breaks so that line numbers stay right
		body = htmlComment.ReplaceAllStringFunc(body, func(m string) string { return strings.Repeat("\n", strings.Count(m, "\n")) })
		if strings.HasPrefix(strings.TrimSpace(body), "```") && kind == KindNote {
			kind = KindLog
			if utf8.RuneCountInString(body) > logHeadChars {
				body = string([]rune(body)[:logHeadChars])
			}
		}
		if strings.TrimSpace(body) == "" {
			continue
		}
		for _, p := range pack(body, max) {
			line := bodyLine + strings.Count(body[:p.off], "\n")
			emb := EmbedText(p.text, date, heading, opts.Header)
			out = append(out, Chunk{
				Rel: rel, Entry: idx, Line: line, EndLine: line + strings.Count(p.text, "\n"),
				Date: date, Heading: heading, Kind: kind, Text: p.text, Hash: hashOf(emb),
			})
		}
	}
	return out
}

type piece struct {
	off  int // byte offset of the text in the body
	text string
}

type span struct {
	off  int
	text string
}

// trimSpan trims white space off a span and moves its offset to the first character left.
func trimSpan(off int, s string) span {
	t := strings.TrimLeft(s, " \t\r\n　")
	off += len(s) - len(t)
	return span{off: off, text: strings.TrimRight(t, " \t\r\n　")}
}

func paragraphs(body string) []span {
	var out []span
	last := 0
	for _, m := range paraBreak.FindAllStringIndex(body, -1) {
		if sp := trimSpan(last, body[last:m[0]]); sp.text != "" {
			out = append(out, sp)
		}
		last = m[1]
	}
	if sp := trimSpan(last, body[last:]); sp.text != "" {
		out = append(out, sp)
	}
	return out
}

// pack cuts a body into pieces of at most max characters.
func pack(body string, max int) []piece {
	var out []piece
	var cur strings.Builder
	curOff := 0
	push := func() {
		t := strings.TrimSpace(cur.String())
		cur.Reset()
		if t == "" {
			return
		}
		if utf8.RuneCountInString(t) > hardMaxChars {
			t = string([]rune(t)[:hardMaxChars])
		}
		out = append(out, piece{off: curOff, text: t})
	}
	runes := func(s string) int { return utf8.RuneCountInString(s) }
	for _, p := range paragraphs(body) {
		n := runes(p.text)
		switch {
		case n > max:
			push()
			var prev *span
			for _, sn := range units(p.text, p.off, max) {
				if cur.Len() > 0 && runes(cur.String())+runes(sn.text) > max {
					push()
					if prev != nil { // one sentence of overlap inside a long paragraph
						cur.WriteString(prev.text)
						curOff = prev.off
					}
				}
				if cur.Len() == 0 {
					curOff = sn.off
				} else if prev != nil { // what stood between the two sentences (a line break, a space), as it was written
					cur.WriteString(body[prev.off+len(prev.text) : sn.off])
				}
				cur.WriteString(sn.text)
				s := sn
				prev = &s
			}
			push()
		case cur.Len() > 0 && runes(cur.String())+2+n > max:
			push()
			cur.WriteString(p.text)
			curOff = p.off
		default:
			if cur.Len() > 0 {
				cur.WriteString("\n\n")
			} else {
				curOff = p.off
			}
			cur.WriteString(p.text)
		}
	}
	push()
	return out
}
