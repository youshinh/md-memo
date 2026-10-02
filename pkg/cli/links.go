package cli

import (
	"path/filepath"
	"strings"
)

// Links to what a search found. Every hit of `scrap search` and scrap.search carries what a summary (or any note) needs to cite it as a
// clickable link, in the forms the editor's own links take (docs: skills/md-memo/references/interfaces.md 3.3):
//
//	url    the file:// URL of the file, written like the editor writes one (file_anchor.js pathToFileUrl: every path segment percent-
//	       encoded, so spaces, Japanese and brackets round-trip and nothing breaks a Markdown link);
//	rel    the file's path inside the scrap folder, with "/": for a note that is itself in the scrap folder, a relative link such as
//	       ./2026-09-01.md does not break when the folder lives under another path on another PC (a Git-synced scrap folder does);
//	label  a short name for the link text: the day and the nearest heading;
//	link   [label](url), ready to paste (the label's brackets are escaped).
//
// The editor opens a link's FILE (Ctrl+Click); it does not take a line from the link, so the line (and end_line) stay separate fields.

// FileURL is the file:// URL of an absolute path, written the way the editor writes one: every path segment is percent-encoded except
// the unreserved characters (letters, digits, - _ . ~), so the URL contains no space, bracket or parenthesis. A Windows path becomes
// file:///C:/..., a POSIX path file:///...; a network path (\\server\share\...) file://server/share/....
func FileURL(path string) string {
	if path == "" {
		return ""
	}
	norm := strings.ReplaceAll(path, `\`, "/")
	segments := strings.Split(norm, "/")
	for i, seg := range segments {
		if i == 0 && len(seg) == 2 && seg[1] == ':' && isASCIILetter(seg[0]) { // the drive: C:
			continue
		}
		segments[i] = encodeURLSegment(seg)
	}
	switch {
	case strings.HasPrefix(norm, "//"): // \\server\share\x: the server is the host of the URL
		return "file:" + strings.Join(segments, "/")
	case len(segments[0]) == 2 && segments[0][1] == ':': // C:/x
		return "file:///" + strings.Join(segments, "/")
	case strings.HasPrefix(norm, "/"):
		return "file://" + strings.Join(segments, "/")
	}
	return "file:///" + strings.Join(segments, "/")
}

func isASCIILetter(b byte) bool { return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }

// encodeURLSegment percent-encodes every byte of a path segment except A-Z a-z 0-9 - _ . ~.
func encodeURLSegment(s string) string {
	const hex = "0123456789ABCDEF"
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isASCIILetter(c) || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			sb.WriteByte(c)
			continue
		}
		sb.WriteByte('%')
		sb.WriteByte(hex[c>>4])
		sb.WriteByte(hex[c&15])
	}
	return sb.String()
}

// linkLabel is the text of a link to a hit: the day and the nearest heading ("2026-09-01 [09:00:00] ping"), the heading alone when it
// already starts with the day (the semantic search's headings are "2026-09-01 09:00"), the day or the file name when there is none.
func linkLabel(date, heading, file string) string {
	base := date
	if base == "" {
		base = filepath.Base(file)
	}
	h := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(heading), "#"))
	switch {
	case h == "":
		return base
	case date != "" && strings.HasPrefix(h, date):
		return h
	}
	return base + " " + h
}

// markdownLink is [label](url) with the characters that would end the label escaped.
func markdownLink(label, url string) string {
	r := strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`)
	return "[" + r.Replace(label) + "](" + url + ")"
}

// decorateHits fills rel, url, label and link of every hit (see above). A file outside the scrap folder gets no rel.
func decorateHits(hits []scrapHit, scrapDir string) {
	for i := range hits {
		h := &hits[i]
		if h.File == "" {
			continue
		}
		if rel, err := filepath.Rel(scrapDir, h.File); err == nil && !strings.HasPrefix(rel, "..") {
			h.Rel = filepath.ToSlash(rel)
		}
		h.URL = FileURL(h.File)
		h.Label = linkLabel(h.Date, h.Heading, h.File)
		h.Link = markdownLink(h.Label, h.URL)
	}
}
