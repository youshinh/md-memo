package cli

import (
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileURLIsWrittenLikeTheEditorWritesOne(t *testing.T) {
	cases := []struct{ path, want string }{
		{`C:\Users\yoush\my scraps\2026-09-01.md`, "file:///C:/Users/yoush/my%20scraps/2026-09-01.md"},
		{`C:\Users\yoush\メモ\日本語 (1) [a]#b%c.md`, "file:///C:/Users/yoush/%E3%83%A1%E3%83%A2/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%281%29%20%5Ba%5D%23b%25c.md"},
		{`C:/already/forward.md`, "file:///C:/already/forward.md"},
		{`/Users/me/Documents/md-memo/scraps/2026-09-01.md`, "file:///Users/me/Documents/md-memo/scraps/2026-09-01.md"},
		{`/home/me/my notes/x.md`, "file:///home/me/my%20notes/x.md"},
		{`\\nas\share\scraps\a b.md`, "file://nas/share/scraps/a%20b.md"},
		{``, ""},
	}
	for _, c := range cases {
		got := FileURL(c.path)
		if got != c.want {
			t.Errorf("FileURL(%q)\n got  %s\n want %s", c.path, got, c.want)
		}
		// what the editor does with a file URL (decodeURIComponent of what follows "file:///") gives the path back
		if c.path != "" && strings.HasPrefix(got, "file:///") {
			back, err := url.PathUnescape(strings.TrimPrefix(got, "file:///"))
			if err != nil || back != strings.ReplaceAll(strings.TrimPrefix(c.path, "/"), `\`, "/") {
				t.Errorf("FileURL(%q) does not decode back: %q %v", c.path, back, err)
			}
		}
		// nothing in it can end a Markdown link or a bracketed label
		if strings.ContainsAny(got, " ()[]<>\"") {
			t.Errorf("FileURL(%q) = %s holds a character that breaks a Markdown link", c.path, got)
		}
	}
}

func TestLinkLabelAndMarkdownLink(t *testing.T) {
	cases := []struct{ date, heading, file, want string }{
		{"2026-09-01", "## [09:00:00] 打ち合わせ", "x/2026-09-01.md", "2026-09-01 [09:00:00] 打ち合わせ"},
		{"2026-09-01", "2026-09-01 09:00", "x/2026-09-01.md", "2026-09-01 09:00"}, // the semantic search's heading already has the day
		{"2026-09-01", "", "x/2026-09-01.md", "2026-09-01"},
		{"", "# Notes", filepath.Join("x", "readme.md"), "readme.md Notes"},
		{"", "", filepath.Join("x", "readme.md"), "readme.md"},
	}
	for _, c := range cases {
		if got := linkLabel(c.date, c.heading, c.file); got != c.want {
			t.Errorf("linkLabel(%q, %q, %q) = %q, want %q", c.date, c.heading, c.file, got, c.want)
		}
	}
	if got := markdownLink(`a [b] \c`, "file:///x.md"); got != `[a (b) \c](file:///x.md)` { // the editor's link pattern cannot read a "]" in a label
		t.Errorf("markdownLink = %s", got)
	}
}

// Every hit of every kind of search carries what is needed to cite it, and the link points at the file the hit is in.
func TestSearchHitsCarryRelURLLabelAndLink(t *testing.T) {
	dir := scrapSandbox(t)
	writeFile(t, filepath.Join(dir, "2026-09-24.md"), "---\n## [09:00:00] 打ち合わせ\n図面は来週までに送る。\nそれが遅れると\n納期もずれる。\n")
	writeFile(t, filepath.Join(dir, "sub dir", "2026-09-25.md"), "# 別件\n納期の話だけ。\n")

	type hit struct {
		File, Rel, URL, Label, Link string
		Date                        string
		Line                        int
	}
	check := func(name string, hits []hit) {
		t.Helper()
		if len(hits) == 0 {
			t.Fatalf("%s: no hits", name)
		}
		for _, h := range hits {
			rel, _ := filepath.Rel(dir, h.File)
			if h.Rel != filepath.ToSlash(rel) || h.URL != FileURL(h.File) || !strings.HasPrefix(h.URL, "file:///") || h.Label == "" || h.Link != markdownLink(h.Label, h.URL) {
				t.Errorf("%s: hit %+v", name, h)
			}
			if strings.Contains(h.URL, " ") {
				t.Errorf("%s: a space in the URL %s", name, h.URL)
			}
		}
	}
	for name, p := range map[string]ScrapSearchParams{
		"plain":  {Text: "納期"},
		"ranked": {Text: "納期 図面", Ranked: true},
	} {
		res, err := ScrapSearch(t.Context(), p)
		if err != nil {
			t.Fatal(err)
		}
		var hits []hit
		for _, m := range res.Matches {
			hits = append(hits, hit{m.File, m.Rel, m.URL, m.Label, m.Link, m.Date, m.Line})
		}
		check(name, hits)
		for _, m := range res.Matches {
			if filepath.Base(m.File) == "2026-09-25.md" && m.Rel != "sub dir/2026-09-25.md" {
				t.Errorf("%s: rel of a file in a sub-folder = %q", name, m.Rel)
			}
			if filepath.Base(m.File) == "2026-09-24.md" && !strings.HasPrefix(m.Label, "2026-09-24 ") {
				t.Errorf("%s: label = %q", name, m.Label)
			}
		}
	}
}
