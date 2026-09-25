package slotagent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

type commentVector struct {
	Name     string   `json:"name"`
	Text     string   `json:"text"`
	Comments []string `json:"comments"`
}

// loadCommentVectors reads the vectors frontend/js/html_comments_test.js runs too: the two scanners must agree.
func loadCommentVectors(t *testing.T) []commentVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "html_comment_vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vs []commentVector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(vs) < 30 {
		t.Fatalf("expected at least 30 vectors, got %d", len(vs))
	}
	return vs
}

func TestFindHTMLComments_SharedVectors(t *testing.T) {
	for _, v := range loadCommentVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			got := []string{}
			for _, r := range findHTMLComments(v.Text) {
				got = append(got, v.Text[r.Start:r.End])
			}
			want := v.Comments
			if want == nil {
				want = []string{}
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("comments = %q, want %q", got, want)
			}
		})
	}
}

func TestInsideHTMLComment_AgreesWithRangesAtEveryOffset(t *testing.T) {
	for _, v := range loadCommentVectors(t) {
		rs := findHTMLComments(v.Text)
		for off := 0; off <= len(v.Text); off++ {
			if off < len(v.Text) && !utf8.RuneStart(v.Text[off]) {
				continue
			}
			want := false
			for _, r := range rs {
				if r.Start < off && off < r.End {
					want = true
				}
			}
			if got := InsideHTMLComment(v.Text, off); got != want {
				t.Errorf("%s: InsideHTMLComment(@%d) = %v, want %v", v.Name, off, got, want)
			}
		}
	}
}

func TestInsideHTMLComment_Edges(t *testing.T) {
	doc := "a <!-- x --> b"
	open := strings.Index(doc, "<!--")
	end := strings.Index(doc, "-->") + 3
	cases := []struct {
		off  int
		want bool
	}{{open, false}, {open + 1, true}, {end - 1, true}, {end, false}, {0, false}, {len(doc), false}, {-3, false}, {999, false}}
	for _, c := range cases {
		if got := InsideHTMLComment(doc, c.off); got != c.want {
			t.Errorf("InsideHTMLComment(%q, %d) = %v, want %v", doc, c.off, got, c.want)
		}
	}
	if InsideHTMLComment("<!-- md-memo:run ab -->", 5) {
		t.Errorf("a marker is not a comment")
	}
	if InsideHTMLComment("<!-- never closed", 5) {
		t.Errorf("an unclosed <!-- is not a comment")
	}
}

func TestParseSlots_SkipsCommentedSlots(t *testing.T) {
	cfg := DefaultSlotConfig()
	doc := "<!-- {{ code: hidden }} -->\n" +
		"<!--\n{{ @claude 隠れた依頼 }}\n[? research ]\n-->\n" +
		"{{ code: live <!-- a note inside --> }}\n" +
		"{{ cut <!-- }} -->\n" +
		"`<!--` {{ code: after inline code }}\n" +
		"```\n<!--\n```\n{{ code: after the fence }}\n" +
		"<!-- md-memo:run ab12 -->\n"
	slots := ParseSlots(doc, cfg)
	var got []string
	for _, s := range slots {
		got = append(got, doc[s.StartOffset:s.EndOffset])
	}
	want := []string{
		"{{ code: live <!-- a note inside --> }}",
		"{{ code: after inline code }}",
		"{{ code: after the fence }}",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("slots = %q, want %q", got, want)
	}
}

func TestFindExcludedRanges_IncludesComments(t *testing.T) {
	doc := "x <!-- {{ a }} --> y"
	found := false
	for _, r := range FindExcludedRanges(doc) {
		if doc[r.Start:r.End] == "<!-- {{ a }} -->" {
			found = true
		}
	}
	if !found {
		t.Errorf("the comment is not an excluded range: %+v", FindExcludedRanges(doc))
	}
}

func TestFindApprovalGates_CommentedGatesAreOff(t *testing.T) {
	doc := "<!--\n- [x] 古い承認 // approve\n-->\n" +
		"- [ ] 待ち // approve\n" +
		"<!-- - [x] 一行 // approve -->\n" +
		"- [x] 本物 [docs](https://example.com) // approve\n"
	gates := FindApprovalGates(doc)
	if len(gates) != 2 {
		t.Fatalf("gates = %+v, want the two outside the comments", gates)
	}
	if gates[0].StepDesc != "待ち" || gates[0].IsApproved {
		t.Errorf("first gate = %+v", gates[0])
	}
	if gates[1].StepDesc != "本物 [docs](https://example.com)" || !gates[1].IsApproved {
		t.Errorf("a gate with a link still counts (only comments switch gates off): %+v", gates[1])
	}
	// a gate in a code fence keeps working as before
	if g := FindApprovalGates("```\n- [x] step // approve\n```"); len(g) != 1 {
		t.Errorf("a gate inside a fence = %+v, want it kept", g)
	}
}

// BenchmarkFindHTMLComments_LargeNote: an 80 000-line note, a quarter of its lines holding a comment, with fences.
func BenchmarkFindHTMLComments_LargeNote(b *testing.B) {
	mix := []string{
		"- [ ] item with `code` and {{ slot }}", "ordinary prose line, 日本語のテキスト", "<!-- a comment on its own line -->",
		"text <!-- inline --> more", "```js", `const x = "<!-- in code -->";`, "```", "{{ @claude 要約して }}",
	}
	var sb strings.Builder
	for i := 0; i < 80000; i++ {
		sb.WriteString(mix[i%len(mix)])
		sb.WriteByte('\n')
	}
	doc := sb.String()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if len(findHTMLComments(doc)) != 20000 {
			b.Fatal("unexpected count")
		}
	}
}

func TestScanHTMLComments_NoOpenerIsFree(t *testing.T) {
	doc := strings.Repeat("line with `code` and {{ slot }}\n", 5000)
	allocs := testing.AllocsPerRun(20, func() {
		if findHTMLComments(doc) != nil {
			t.Fatal("no comment expected")
		}
	})
	if allocs != 0 {
		t.Errorf("a note without \"<!--\" must cost no allocation, got %v", allocs)
	}
}
