package search

import (
	"bytes"
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Tags are hints written into a note's own text, as a one-line HTML comment, so they never show in the preview or in print and travel
// with the file (docs/design/tag-filter-2026-10.md):
//
//	<!-- tags: 仕事, 買い物 -->
//
// A tag comment above the first heading or "---" rule (or a YAML front matter "tags:") tags the whole file; anywhere else it tags the
// entry that holds it, the entries being exactly the ones Entries cuts and the searches use, and every smaller heading below that
// entry's heading (outline.go: a tag under "# Article" is a tag of its "##" and "###" sections too). This file only reads: MD-Memo
// writes no tag.

const (
	// maxTagsPerComment bounds the tags one comment (or one front matter) gives; the rest are dropped.
	maxTagsPerComment = 32
	// maxTagRunes bounds one tag; a longer one is dropped, not cut.
	maxTagRunes = 64
	// MaxFilterTags is how many tags one search can ask for at once (all of them have to be there).
	MaxFilterTags = 8
	// maxFrontMatterLines: a front matter is a few lines; a file that opens with "---" and "key: value" but does not close within this
	// many lines is a note, not a front matter.
	maxFrontMatterLines = 200
)

var (
	commentOpen  = []byte("<!--")
	commentClose = []byte("-->")
	utf8BOM      = []byte("\xEF\xBB\xBF")
)

// NormalizeTag is the form tags are compared and shown in: full-width ASCII (！ to ～, the ideographic space) made half-width, the
// surrounding white space and the leading "#" taken off, lower case. Hiragana and katakana are not unified and there are no synonyms.
func NormalizeTag(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			return r - 0xFEE0
		case r == 0x3000:
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(s), "#"))
	return strings.ToLower(s)
}

// isTagSep: tags are separated by white space (the ideographic space too), "," "、" "，" ";" "；".
func isTagSep(r rune) bool {
	switch r {
	case ',', ';', '、', '，', '；':
		return true
	}
	return unicode.IsSpace(r)
}

// scanTagList splits a list of tags into at most max of them, normalized, without duplicates, in the order written. A tag that is
// empty after normalizing is nothing; one longer than maxTagRunes is not taken and tooLong says so; overflow says that there were more
// than max (the rest are not looked at).
func scanTagList(s string, max int) (out []string, tooLong, overflow bool) {
	add := func(f string) {
		t := NormalizeTag(f)
		switch {
		case t == "":
		case utf8.RuneCountInString(t) > maxTagRunes:
			tooLong = true
		case hasTag(out, t):
		case len(out) >= max:
			overflow = true
		default:
			out = append(out, t)
		}
	}
	start := -1
	for i, r := range s {
		if isTagSep(r) {
			if start >= 0 {
				add(s[start:i])
				start = -1
				if overflow {
					return
				}
			}
		} else if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		add(s[start:])
	}
	return
}

// parseTags is scanTagList that keeps the tags only: what a comment in a note says, where too many or too long are dropped quietly.
func parseTags(s string, max int) []string {
	out, _, _ := scanTagList(s, max)
	return out
}

// ParseTagList reads a person's list ("#仕事, 急ぎ"): normalized, de-duplicated, in order. At most MaxFilterTags tags; the rest are
// dropped. A search should use ParseTagFilter, which refuses what this one would drop.
func ParseTagList(s string) []string { return parseTags(s, MaxFilterTags) }

// ParseTagFilter reads the tags a search is asked to narrow to: each element of list may itself be a list ("仕事, 急ぎ"). The answer is
// normalized, de-duplicated and in order, nil for no tag. It is an error to name more than MaxFilterTags tags, a tag longer than
// maxTagRunes characters, or text that holds no tag at all ("#"): a filter that quietly dropped one of the tags asked for would let
// more through than the person meant.
func ParseTagFilter(list []string) ([]string, error) {
	var nonEmpty bool
	for _, s := range list {
		nonEmpty = nonEmpty || strings.TrimSpace(s) != ""
	}
	if !nonEmpty {
		return nil, nil
	}
	tags, tooLong, overflow := scanTagList(strings.Join(list, ","), MaxFilterTags)
	switch {
	case overflow:
		return nil, errors.New("too many tags (at most " + strconv.Itoa(MaxFilterTags) + ")")
	case tooLong:
		return nil, errors.New("a tag is longer than " + strconv.Itoa(maxTagRunes) + " characters")
	case len(tags) == 0:
		return nil, errors.New("no tag in " + strconv.Quote(strings.Join(list, ",")))
	}
	return tags, nil
}

// addTags appends to dst the tags of src that dst does not hold yet, up to max in all.
func addTags(dst, src []string, max int) []string {
	for _, t := range src {
		if len(dst) >= max {
			break
		}
		if !hasTag(dst, t) {
			dst = append(dst, t)
		}
	}
	return dst
}

func hasTag(list []string, t string) bool {
	for _, x := range list {
		if x == t {
			return true
		}
	}
	return false
}

// TagMap holds the tags of one file: the ones of the whole file and the ones of each entry (the entries of Entries(data)). The nil map
// is a file that carries no tag: every method answers for it, so a caller does not have to test for nil.
type TagMap struct {
	file    []string   // the tags of the whole file
	entries []Entry    // Entries(data)
	own     [][]string // per entry: its own tags only (nil until the file has one); empty when no entry has any
	ol      *outline   // which entry is under which heading; made only when some entry has a tag of its own (nil: nothing to inherit)
}

// ScanTags reads the tags of a file. It returns nil when the file cannot carry a tag (no "<!--" and no front matter with tags): a cheap
// check before any parsing, which is all that most notes cost a tag search. HasEntry and HasLine count the tags that an entry gets from
// the headings above it; the map holds the tree of the headings for that, but only when some entry has a tag of its own to hand down.
func ScanTags(data []byte) *TagMap { return scanTags(data, true) }

// scanTags is ScanTags; without withOutline the tree of the headings is left out (EditTags reads only the tags written in the text, to
// say what they are after an edit, and has its own tree).
func scanTags(data []byte, withOutline bool) *TagMap {
	fm := frontMatterTags(data)
	hasComment := bytes.Contains(data, commentOpen)
	if !hasComment && len(fm) == 0 {
		return nil
	}
	m := &TagMap{file: fm, entries: Entries(data)}
	if !hasComment || len(m.entries) == 0 {
		return m
	}

	// Entry 0 is the front part of the file (above the first heading or rule) unless the file opens with a heading or a rule itself.
	first := firstLine(data)
	preamble := !isRuleLine(first) && !isEntryHeading(first)

	var tr headingTracker // the same fence rule the entry splitter follows, so a comment in a code block is code
	ei, lineNo := 0, 0
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
		off = next

		t := bytes.TrimLeft(line, " ")
		if len(t) > 0 && (t[0] == '`' || t[0] == '~') {
			tr.feed(string(line), lineNo) // exactly the lines Entries gives the tracker
			continue
		}
		if tr.fenceChar != 0 {
			continue
		}
		if lineNo == 1 {
			t = bytes.TrimPrefix(t, utf8BOM)
		}
		t = bytes.TrimLeft(t, " \t") // a comment may be indented
		if !bytes.HasPrefix(t, commentOpen) {
			continue
		}
		tags := commentTags(t)
		if len(tags) == 0 {
			continue
		}
		for ei+1 < len(m.entries) && m.entries[ei+1].StartLine <= lineNo {
			ei++
		}
		if ei == 0 && preamble {
			m.file = addTags(m.file, tags, math.MaxInt)
			continue
		}
		if m.own == nil {
			m.own = make([][]string, len(m.entries))
		}
		m.own[ei] = addTags(m.own[ei], tags, math.MaxInt)
	}
	if m.own != nil && withOutline {
		m.ol = newOutline(data, m.entries, false) // a file with no tag of its own to hand down never pays for this
	}
	return m
}

// firstLine is the first line of data without its line ending and without a byte order mark.
func firstLine(data []byte) string {
	data = bytes.TrimPrefix(data, utf8BOM)
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		data = data[:i]
	}
	return strings.TrimSuffix(string(data[:min(len(data), 256)]), "\r")
}

// commentTags reads one line that is one whole comment, "<!-- tags: a, b -->" (t starts with "<!--"; white space around it is
// allowed). It gives nil for anything else: another kind of comment, text after the comment, a comment that goes on to the next line.
func commentTags(t []byte) []string {
	body, ok := tagCommentBody(t)
	if !ok {
		return nil
	}
	return parseTags(string(body), maxTagsPerComment)
}

// tagCommentBody is what follows the colon of a tag comment line (see commentTags for what such a line is), and whether t is one.
func tagCommentBody(t []byte) ([]byte, bool) {
	t = bytes.TrimRight(t, " \t\r")
	if len(t) < len(commentOpen)+len(commentClose) || !bytes.HasSuffix(t, commentClose) {
		return nil, false
	}
	inner := t[len(commentOpen) : len(t)-len(commentClose)]
	if bytes.Contains(inner, commentClose) || bytes.Contains(inner, commentOpen) {
		return nil, false // two comments on the line, or text between them
	}
	colon := bytes.IndexByte(inner, ':')
	if colon < 0 {
		return nil, false
	}
	key := strings.TrimSpace(string(inner[:colon]))
	if !strings.EqualFold(key, "tags") && !strings.EqualFold(key, "tag") {
		return nil, false
	}
	return inner[colon+1:], true
}

// IsTagCommentLine reports whether line is one whole tag comment, "<!-- tags: a, b -->" (an empty list too, white space around it
// allowed). Such a line is metadata, not text: the preview and the print hide it, so a search leaves it out of the context it shows
// around a hit (it is still a line of the file: it can match, and it counts in the line numbers).
func IsTagCommentLine(line string) bool {
	t := strings.TrimLeft(line, " \t")
	if !strings.HasPrefix(t, "<!--") {
		return false
	}
	_, ok := tagCommentBody([]byte(t))
	return ok
}

// frontMatterTags reads the "tags:" / "tag:" of a YAML front matter at the very start of the file: tags: [a, b], tags: a, b, or
// "tags:" followed by "- a" lines. A file only has a front matter when its first line is "---", the first line after it that is not
// empty looks like "key: value" (a daily scrap's "---" is followed by a "## [time] title" heading: that is a rule, not a front
// matter), and a closing "---" (or "...") follows within maxFrontMatterLines lines.
func frontMatterTags(data []byte) []string {
	tags, _ := frontMatterOf(data)
	return tags
}

// frontMatterOf is frontMatterTags that also says where the front matter ends: the 1-based line of its closing "---" (or "..."), 0 when
// the file has no front matter. The tag editor needs to know a front matter is there even when it carries no tag.
func frontMatterOf(data []byte) (tags []string, closeLine int) {
	data = bytes.TrimPrefix(data, utf8BOM)
	if !bytes.HasPrefix(data, []byte("---")) {
		return nil, 0
	}
	seenKey, inList := false, false
	for off, n := 0, 0; off < len(data); n++ {
		end := bytes.IndexByte(data[off:], '\n')
		next := len(data)
		if end >= 0 {
			end += off
			next = end + 1
		} else {
			end = len(data)
		}
		raw := data[off:end]
		off = next
		if n > maxFrontMatterLines {
			return nil, 0
		}
		s := strings.TrimRight(string(raw), " \t\r")
		if n == 0 {
			if s != "---" {
				return nil, 0
			}
			continue
		}
		trimmed := strings.TrimSpace(s)
		if !seenKey {
			if trimmed == "" {
				continue
			}
			if !isKeyLine(s) {
				return nil, 0
			}
			seenKey = true
		}
		if s == "---" || s == "..." {
			return tags, n + 1
		}
		if inList {
			if strings.HasPrefix(trimmed, "-") {
				tags = addTags(tags, parseTags(yamlValue(trimmed[1:]), maxTagsPerComment), maxTagsPerComment)
				continue
			}
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			inList = false
		}
		if s == "" || s[0] == ' ' || s[0] == '\t' {
			continue // an empty line, or a nested key
		}
		colon := strings.IndexByte(s, ':')
		if colon <= 0 {
			continue
		}
		if key := strings.TrimSpace(s[:colon]); strings.EqualFold(key, "tags") || strings.EqualFold(key, "tag") {
			if val := strings.TrimSpace(s[colon+1:]); val == "" {
				inList = true
			} else {
				tags = addTags(tags, parseTags(yamlValue(val), maxTagsPerComment), maxTagsPerComment)
			}
		}
	}
	return nil, 0 // never closed: not a front matter
}

// isKeyLine: "key: value" or "key:" with a plain key (letters, digits, "_", "-", "."), the form a front matter's lines have.
func isKeyLine(s string) bool {
	colon := strings.IndexByte(s, ':')
	if colon <= 0 || (colon+1 < len(s) && s[colon+1] != ' ' && s[colon+1] != '\t') {
		return false
	}
	key := strings.TrimRight(s[:colon], " \t")
	if key == "" {
		return false
	}
	for _, r := range key {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' && r != '.' {
			return false
		}
	}
	return key[0] != '-' && key[0] != '.'
}

// yamlValue takes the brackets and quotes of a YAML flow list or scalar away, so what is left is a list of words.
func yamlValue(v string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '[', ']', '"', '\'':
			return ' '
		}
		return r
	}, v)
}

// FileTags are the tags of the whole file: the ones above its first heading or rule, and a front matter's.
func (m *TagMap) FileTags() []string {
	if m == nil {
		return nil
	}
	return m.file
}

// EntryTags are the tags that entry i (of Entries) carries itself; neither the file's nor those it gets from the headings above it are
// included (HasEntry and HasLine count them).
func (m *TagMap) EntryTags(i int) []string {
	if m == nil || i < 0 || i >= len(m.own) {
		return nil
	}
	return m.own[i]
}

// HasEntry reports whether entry i (of Entries) has every tag of want: the tags of the whole file, its own, and those of the headings
// above it (a tag of "# A" is a tag of the "## B" and "### C" below it). No wanted tag is true.
func (m *TagMap) HasEntry(i int, want []string) bool {
	if len(want) == 0 {
		return true
	}
	if m == nil || i < 0 || i >= len(m.entries) {
		return false
	}
	return m.entryHasAll(i, want)
}

// HasLine is HasEntry for the entry that holds the 1-based line (a line past the end of the file is in no entry).
func (m *TagMap) HasLine(line int, want []string) bool {
	if len(want) == 0 {
		return true
	}
	if m == nil {
		return false
	}
	i := sort.Search(len(m.entries), func(i int) bool { return m.entries[i].StartLine > line }) - 1
	if i < 0 || line > m.entries[i].EndLine {
		return false
	}
	return m.entryHasAll(i, want)
}

func (m *TagMap) entryHasAll(i int, want []string) bool {
	for _, w := range want {
		if !hasTag(m.file, w) && !m.ownOrAbove(i, w) {
			return false
		}
	}
	return true
}

// ownOrAbove reports whether entry i or one of the entries above it in the outline has tag t of its own (the file's tags are not
// looked at).
func (m *TagMap) ownOrAbove(i int, t string) bool {
	if m.ol == nil {
		return false
	}
	for ; i >= 0 && i < len(m.own); i = int(m.ol.parent[i]) {
		if hasTag(m.own[i], t) {
			return true
		}
	}
	return false
}

// canHaveAll reports whether every wanted tag is in the file somewhere: a file that is missing one cannot have an entry with all of
// them, so the searches leave it without looking at its entries.
func (m *TagMap) canHaveAll(want []string) bool {
	if m == nil {
		return false
	}
	for _, w := range want {
		if hasTag(m.file, w) {
			continue
		}
		found := false
		for _, own := range m.own {
			if hasTag(own, w) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// tagMapFor is what a tag-filtered search keeps of a file it has read: its tags, or nil when the file cannot have an entry with every
// wanted tag.
func tagMapFor(data []byte, want []string) *TagMap {
	m := ScanTags(data)
	if !m.canHaveAll(want) {
		return nil
	}
	return m
}

// readTaggedFile reads a file for a tag-filtered search (a file larger than the ranked search's bound is left out, as there).
func readTaggedFile(path string) ([]byte, bool) {
	info, err := os.Stat(path)
	if err != nil || info.Size() > maxRankedFileBytes {
		return nil, false
	}
	data, err := os.ReadFile(path)
	return data, err == nil
}

// ScanTagsFile is ScanTags of the file at path: nil when the file cannot be read (or is too large for the searches to read), or
// carries no tag.
func ScanTagsFile(path string) *TagMap {
	data, ok := readTaggedFile(path)
	if !ok {
		return nil
	}
	return ScanTags(data)
}

// TagCount is how often a tag is used.
type TagCount struct {
	Tag     string `json:"tag"`
	Files   int    `json:"files"`   // files that carry the tag in any scope
	Entries int    `json:"entries"` // entries the tag applies to: all of its file for a whole-file tag, else the entries it is written in and those under their headings
}

// CollectTags walks the scrap folder (the same files the search reads: .md, no dot folders) and counts the tags. Sorted by Files
// descending, then Tag. It honours ctx: a cancelled walk gives ctx.Err() and nothing else. No tag at all is an empty list, not nil.
func CollectTags(ctx context.Context, scrapDir string) ([]TagCount, error) {
	return CollectTagsVisit(ctx, scrapDir, nil)
}

// CollectTagsVisit is CollectTags that also tells visit (when set) the path of every markdown file it walks, so that a caller who
// wants to count the files too does not walk the folder a second time.
func CollectTagsVisit(ctx context.Context, scrapDir string, visit func(path string)) ([]TagCount, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	counts := map[string]*TagCount{}
	bump := func(tag string, entries int) {
		c := counts[tag]
		if c == nil {
			c = &TagCount{Tag: tag}
			counts[tag] = c
		}
		c.Files++
		c.Entries += entries
	}
	for _, path := range collectMarkdownFiles(filepath.Clean(scrapDir)) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if visit != nil {
			visit(path)
		}
		data, ok := readTaggedFile(path)
		if !ok {
			continue
		}
		m := ScanTags(data)
		if m == nil {
			continue
		}
		for _, t := range m.file {
			bump(t, len(m.entries))
		}
		// A tag that only some entries carry reaches those entries and everything under their headings (a tag the whole file carries
		// already counts them all). A subtree is a run of entries, and two subtrees are nested or apart, so walking the entries in
		// order and skipping one that an earlier subtree with the same tag already covers counts each entry once.
		type reach struct{ n, until int } // entries counted so far; the last entry the latest counted subtree covers
		var perTag map[string]*reach
		var lasts []int32
		for i, own := range m.own {
			for _, t := range own {
				if hasTag(m.file, t) {
					continue
				}
				if perTag == nil {
					perTag = map[string]*reach{}
				}
				r := perTag[t]
				if r == nil {
					r = &reach{until: -1}
					perTag[t] = r
				}
				if r.until < i {
					if lasts == nil {
						lasts = m.ol.lasts()
					}
					last := int(lasts[i])
					r.n += last - i + 1
					r.until = last
				}
			}
		}
		for t, r := range perTag {
			bump(t, r.n)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make([]TagCount, 0, len(counts))
	for _, c := range counts {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Files != out[j].Files {
			return out[i].Files > out[j].Files
		}
		return out[i].Tag < out[j].Tag
	})
	return out, nil
}
