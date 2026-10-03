package semindex

import (
	"strings"
	"testing"

	"md-memo/pkg/search"
)

// The tag editor (docs/design/tag-filter-2026-10.md section 10) writes "<!-- tags: ... -->" on the line under an entry's heading. That
// is where ChunkFile looks for the code fence that makes an entry a "log": the comment must not hide it, must not change what is
// embedded (so no chunk is embedded again for it), and must not touch any other entry. Only the line numbers move.
func TestChunkFileIgnoresATagCommentUnderTheHeading(t *testing.T) {
	for _, eol := range []string{"\n", "\r\n"} {
		src := strings.ReplaceAll(sampleDay, "\n", eol)
		lineOf := func(text, prefix string) int {
			for i, l := range strings.Split(text, "\n") {
				if strings.HasPrefix(l, prefix) {
					return i + 1
				}
			}
			t.Fatalf("no line starts with %q", prefix)
			return 0
		}

		// the editor's own output: a tag on the piped log (a fence follows its heading), on a plain entry, and on the whole note
		edited := []byte(src)
		for _, req := range []struct {
			scope, prefix string
		}{{"entry", "## [10:09:51] ping"}, {"entry", "# 2026-09-10 12:00"}, {"note", ""}} {
			line := 0
			if req.prefix != "" {
				line = lineOf(string(edited), req.prefix)
			}
			r, err := search.EditTags(edited, "add", req.scope, line, []string{"仕事"})
			if err != nil || !r.Changed {
				t.Fatalf("%s %q: %+v %v", req.scope, req.prefix, r, err)
			}
			edited = r.Apply(edited)
		}
		if n := strings.Count(string(edited), "<!-- tags: 仕事 -->"); n != 3 {
			t.Fatalf("expected 3 tag comments, found %d in %q", n, edited)
		}

		opts := ChunkOptions{MaxChars: 150, Header: true}
		before, after := ChunkFile("2026-09-10.md", []byte(src), opts), ChunkFile("2026-09-10.md", edited, opts)
		if len(before) != len(after) {
			t.Fatalf("%q: %d chunks became %d", eol, len(before), len(after))
		}
		logs := 0
		for i := range before {
			b, a := before[i], after[i]
			if a.Kind != b.Kind || a.Text != b.Text || a.Hash != b.Hash || a.Heading != b.Heading || a.Date != b.Date {
				t.Errorf("%q: chunk %d changed by a tag comment:\n%+v\n%+v", eol, i, b, a)
			}
			if a.Kind == KindLog {
				logs++
			}
			// only the line moves: by the tag comments above the chunk
			above := 0
			for k, l := range strings.Split(string(edited), "\n") {
				if k+1 < a.Line && search.IsTagCommentLine(strings.TrimSuffix(l, "\r")) {
					above++
				}
			}
			if a.Line != b.Line+above || a.EndLine != b.EndLine+above {
				t.Errorf("%q: chunk %d lines %d-%d, want %d-%d (+%d)", eol, i, a.Line, a.EndLine, b.Line, b.EndLine, above)
			}
		}
		if logs == 0 {
			t.Errorf("%q: the piped output is not a log any more", eol)
		}
	}
}
