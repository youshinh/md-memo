package search

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Costs of reading the tags of a note and asking them, for the shapes of note that matter: no comment at all (what almost every note
// is: it must stay one bytes.Contains), a comment that is not a tag, tags on a flat list of entries, and an article that is cut into
// many entries by its own headings with the tags on its top headings (docs/design/tag-filter-2026-10.md section 11).

// benchNote builds a note: sections "# H", each with subs "## S" that each hold subsubs "### T". tagFn says what tag line (or "") a
// heading gets; level is 1 to 3.
func benchNote(sections, subs, subsubs int, tagFn func(level, n int) string) string {
	var b strings.Builder
	n := 0
	add := func(level int, title string) {
		n++
		b.WriteString(strings.Repeat("#", level) + " " + title + "\n")
		if tl := tagFn(level, n); tl != "" {
			b.WriteString(tl + "\n")
		}
		b.WriteString("body of " + title + " with a few words of text in it\nanother line of body\n\n")
	}
	for i := 0; i < sections; i++ {
		add(1, fmt.Sprintf("Section %d", i))
		for j := 0; j < subs; j++ {
			add(2, fmt.Sprintf("Sub %d.%d", i, j))
			for k := 0; k < subsubs; k++ {
				add(3, fmt.Sprintf("Subsub %d.%d.%d", i, j, k))
			}
		}
	}
	return b.String()
}

func BenchmarkScanTags(b *testing.B) {
	none := func(level, n int) string { return "" }
	notes := map[string]string{
		"no_comment": benchNote(200, 4, 3, none),
		"comment_but_no_tag": benchNote(200, 4, 3, func(level, n int) string {
			if n%50 == 0 {
				return "<!-- just a note to myself -->"
			}
			return ""
		}),
		"flat_tags": benchNote(2600, 0, 0, func(level, n int) string {
			if n%10 == 0 {
				return "<!-- tags: 仕事, 急ぎ -->"
			}
			return ""
		}),
		"article_tags_on_top": benchNote(200, 4, 3, func(level, n int) string {
			if level == 1 {
				return "<!-- tags: 記事, 竹 -->"
			}
			return ""
		}),
	}
	for _, name := range []string{"no_comment", "comment_but_no_tag", "flat_tags", "article_tags_on_top"} {
		data := []byte(notes[name])
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(data)))
			for i := 0; i < b.N; i++ {
				_ = ScanTags(data)
			}
		})
	}
}

// BenchmarkTagMapHasLine is what a tag-filtered search asks of the map: every line of the note, once.
func BenchmarkTagMapHasLine(b *testing.B) {
	text := benchNote(200, 4, 3, func(level, n int) string {
		if level == 1 {
			return "<!-- tags: 記事, 竹 -->"
		}
		return ""
	})
	m := ScanTags([]byte(text))
	lines := strings.Count(text, "\n")
	want := []string{"竹"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		hits := 0
		for l := 1; l <= lines; l++ {
			if m.HasLine(l, want) {
				hits++
			}
		}
		_ = hits
	}
}

func BenchmarkCollectTags(b *testing.B) {
	dir := b.TempDir()
	for i := 0; i < 50; i++ {
		var text string
		switch i % 3 {
		case 0: // an article with tags on its top headings
			text = benchNote(20, 4, 3, func(level, n int) string {
				if level == 1 {
					return "<!-- tags: 記事, 竹 -->"
				}
				return ""
			})
		case 1: // flat tags
			text = benchNote(200, 0, 0, func(level, n int) string {
				if n%10 == 0 {
					return "<!-- tags: 仕事, 急ぎ -->"
				}
				return ""
			})
		default: // no tag at all
			text = benchNote(20, 4, 3, func(level, n int) string { return "" })
		}
		name := filepath.Join(dir, fmt.Sprintf("2026-01-%02d_%d.md", i%30+1, i))
		if err := os.WriteFile(name, []byte(text), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := CollectTags(ctx, dir); err != nil {
			b.Fatal(err)
		}
	}
}
