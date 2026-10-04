package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// `md-memo scrap tag` (docs/design/tag-filter-2026-10.md section 10.4). The rules for where a tag goes are tested in pkg/search
// (tagedit_test.go); here are the command's own: where the text comes from, what is printed, the exit codes and the safe write.
// Nothing here reads the settings or the real scrap folder: the text is standard input or a file in a temp folder.

// runTag runs `md-memo scrap tag <args>` with the given standard input.
func runTag(t *testing.T, stdin string, args ...string) (stdout, stderr string, code int, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, err = NewHeadlessRunner(&out, &errOut).WithStdin(strings.NewReader(stdin)).Run(append([]string{"scrap", "tag"}, args...))
	return out.String(), errOut.String(), code, err
}

// tagFile writes a note into a fresh folder and returns its path.
func tagFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func readTagFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// onlyFile asserts that the folder of path holds nothing but that file (no temporary file is left behind).
func onlyFile(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(path) {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("the folder holds %v, want only %s", names, filepath.Base(path))
	}
}

func TestScrapTagFromStandardInputPrintsTheNewText(t *testing.T) {
	const note = "# 見出し1\n本文1\n\n# 見出し2\n本文2\n"
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"entry", []string{"add", "仕事", "--line", "2"}, "# 見出し1\n<!-- tags: 仕事 -->\n本文1\n\n# 見出し2\n本文2\n"},
		{"flags after the words", []string{"add", "--line", "5", "仕事, 急ぎ"}, "# 見出し1\n本文1\n\n# 見出し2\n<!-- tags: 仕事, 急ぎ -->\n本文2\n"},
		{"the whole note", []string{"add", "#全体"}, "<!-- tags: 全体 -->\n# 見出し1\n本文1\n\n# 見出し2\n本文2\n"},
		{"after the double dash", []string{"add", "--line=2", "--", "-x"}, "# 見出し1\n<!-- tags: -x -->\n本文1\n\n# 見出し2\n本文2\n"},
	}
	for _, c := range cases {
		out, errOut, code, err := runTag(t, note, c.args...)
		if err != nil || code != 0 || out != c.want || errOut != "" {
			t.Errorf("%s: code %d err %v stdout %q stderr %q; want %q", c.name, code, err, out, errOut, c.want)
		}
	}

	// remove undoes add (the line goes when its last tag does)
	tagged := "# 見出し1\n<!-- tags: 仕事 -->\n本文1\n"
	out, errOut, code, err := runTag(t, tagged, "remove", "仕事", "--line", "3")
	if err != nil || code != 0 || out != "# 見出し1\n本文1\n" || errOut != "" {
		t.Errorf("remove: %d %v %q %q", code, err, out, errOut)
	}
}

func TestScrapTagNothingToDoPrintsTheTextAndSaysWhy(t *testing.T) {
	const note = "# H\n<!-- tags: a -->\nbody\n"
	for _, c := range []struct {
		args []string
		why  string
	}{
		{[]string{"add", "a", "--line", "3"}, "already applies to the entry at line 3"},
		{[]string{"remove", "zz", "--line", "3"}, "zz is not a tag of the entry at line 3"},
	} {
		out, errOut, code, err := runTag(t, note, c.args...)
		if err != nil || code != 0 || out != note || !strings.Contains(errOut, c.why) || strings.Count(errOut, "\n") != 1 {
			t.Errorf("%v: code %d err %v stdout %q stderr %q; want the text unchanged and %q on stderr", c.args, code, err, out, errOut, c.why)
		}
	}
}

func TestScrapTagRefusals(t *testing.T) {
	const front = "---\ntitle: T\ntags: [x]\n---\n# H\nbody\n"
	const split = "<!-- tags: n -->\nintro\n# H\n<!-- tags: e -->\nbody\n"
	const nested = "# A\n<!-- tags: p -->\n## B\n### C\ntext\n"
	cases := []struct {
		name, text string
		args       []string
		code       string // message_code
		msg        string
	}{
		{"a whole-note tag on a front matter", front, []string{"add", "a"}, "front_matter", "YAML front matter"},
		{"a front matter tag", front, []string{"remove", "x"}, "front_matter_tag", "front matter"},
		{"the whole note's tag asked for an entry", split, []string{"remove", "n", "--line", "5"}, "on_note", "tag of the whole note"},
		{"an entry's tag asked for the note", split, []string{"remove", "e"}, "on_entry", "tag of an entry"},
		{"a tag that comes from the heading above", nested, []string{"remove", "p", "--line", "5"}, "on_parent", `heading "A" (line 1)`},
	}
	for _, c := range cases {
		out, _, code, err := runTag(t, c.text, c.args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), c.msg) || out != "" || strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: code %d err %v stdout %q", c.name, code, err, out)
		}
		// with --json the edit is printed too, so that a program sees the code
		out, _, code, err = runTag(t, c.text, append([]string{c.args[0], "--json"}, c.args[1:]...)...)
		var edit struct {
			Changed     bool   `json:"changed"`
			MessageCode string `json:"message_code"`
		}
		if json.Unmarshal([]byte(out), &edit) != nil || edit.Changed || edit.MessageCode != c.code || code != 1 || err == nil {
			t.Errorf("%s --json: code %d err %v stdout %q", c.name, code, err, out)
		}
	}
	// a partial success is a success: the line says what was left
	out, errOut, code, err := runTag(t, "<!-- tags: n -->\n# H\n<!-- tags: a -->\nbody\n", "remove", "a, n", "--line", "4")
	if err != nil || code != 0 || out != "<!-- tags: n -->\n# H\nbody\n" || !strings.Contains(errOut, "n is a tag of the whole note") {
		t.Errorf("partly: %d %v %q %q", code, err, out, errOut)
	}
	// the same with a tag that comes from a heading above
	out, errOut, code, err = runTag(t, "# A\n<!-- tags: p -->\n## B\n### C\n<!-- tags: c -->\ntext\n", "remove", "c, p", "--line", "6")
	if err != nil || code != 0 || out != "# A\n<!-- tags: p -->\n## B\n### C\ntext\n" || !strings.Contains(errOut, `p is written under the heading "A" (line 1)`) {
		t.Errorf("partly, from above: %d %v %q %q", code, err, out, errOut)
	}
}

// A tag under a heading reaches the smaller headings below it (section 11): a tag that is there from above is not written again, and
// show says what an entry gets from the headings above it.
func TestScrapTagFromAHeadingAbove(t *testing.T) {
	const nested = "# A\n<!-- tags: p -->\n## B\n### C\ntext\n"
	out, errOut, code, err := runTag(t, nested, "add", "p", "--line", "5")
	if err != nil || code != 0 || out != nested || !strings.Contains(errOut, "p already applies to the entry at line 5") {
		t.Errorf("add: %d %v %q %q", code, err, out, errOut)
	}
	out, _, code, err = runTag(t, nested, "show", "--text", "--line", "5")
	if err != nil || code != 0 || out != "tags of the whole note: (none)\ntags of the entry at line 5: (none)\ntags it gets from the headings above: p\n" {
		t.Errorf("show --text: %d %v %q", code, err, out)
	}
	out, _, _, _ = runTag(t, nested, "show", "--line", "5")
	var edit struct {
		InheritedTags []string `json:"inherited_tags"`
		Descendants   int      `json:"descendants"`
		RangeStart    int      `json:"range_start"`
		RangeEnd      int      `json:"range_end"`
		Path          []struct {
			Line        int      `json:"line"`
			Level       int      `json:"level"`
			Heading     string   `json:"heading"`
			Descendants int      `json:"descendants"`
			Tags        []string `json:"tags"`
		} `json:"path"`
	}
	mustJSON(t, out, &edit)
	if strings.Join(edit.InheritedTags, ",") != "p" || edit.Descendants != 0 || edit.RangeStart != 4 || edit.RangeEnd != 5 || len(edit.Path) != 3 ||
		edit.Path[0].Heading != "C" || edit.Path[2].Heading != "A" || edit.Path[2].Descendants != 2 || strings.Join(edit.Path[2].Tags, ",") != "p" {
		t.Errorf("show JSON: %+v", edit)
	}
	// from the heading itself the tag can be taken, and the answer says how many entries it reached
	out, _, code, err = runTag(t, nested, "remove", "p", "--line", "1", "--json")
	var rm struct {
		Changed     bool `json:"changed"`
		Descendants int  `json:"descendants"`
		RangeEnd    int  `json:"range_end"`
	}
	mustJSON(t, out, &rm)
	if err != nil || code != 0 || !rm.Changed || rm.Descendants != 2 || rm.RangeEnd != 5 {
		t.Errorf("remove at the heading: %d %v %+v", code, err, rm)
	}
}

func TestScrapTagJSON(t *testing.T) {
	out, errOut, code, err := runTag(t, "# H\nbody\n", "add", "a", "--line", "2", "--json")
	if err != nil || code != 0 || errOut != "" {
		t.Fatalf("%d %v %q", code, err, errOut)
	}
	var edit struct {
		Changed   bool     `json:"changed"`
		Scope     string   `json:"scope"`
		StartLine int      `json:"start_line"`
		EndLine   int      `json:"end_line"`
		NewLines  []string `json:"new_lines"`
		Eol       string   `json:"eol"`
		Line      int      `json:"line"`
		Added     []string `json:"added"`
	}
	mustJSON(t, out, &edit)
	if !edit.Changed || edit.Scope != "entry" || edit.StartLine != 2 || edit.EndLine != 2 || len(edit.NewLines) != 1 || edit.NewLines[0] != "<!-- tags: a -->" ||
		edit.Eol != "\n" || edit.Line != 2 || len(edit.Added) != 1 {
		t.Errorf("edit = %+v", edit)
	}
	if strings.Contains(out, "body") {
		t.Errorf("--json printed the text as well: %s", out)
	}
}

func TestScrapTagShow(t *testing.T) {
	const note = "<!-- tags: n1, n2 -->\nintro\n# H\n<!-- tags: e -->\nbody\n\n# I\nbody\n"
	out, _, code, err := runTag(t, note, "show", "--text", "--line", "5")
	if err != nil || code != 0 || out != "tags of the whole note: n1, n2\ntags of the entry at line 5: e\n" {
		t.Errorf("show --line: %d %v %q", code, err, out)
	}
	out, _, _, _ = runTag(t, note, "show", "--text")
	if out != "tags of the whole note: n1, n2\n" {
		t.Errorf("show: %q", out)
	}
	out, _, _, _ = runTag(t, note, "show", "--text", "--line", "8")
	if out != "tags of the whole note: n1, n2\ntags of the entry at line 8: (none)\n" {
		t.Errorf("show an entry without tags: %q", out)
	}
	out, _, _, _ = runTag(t, note, "show", "--text", "--line", "2")
	if !strings.Contains(out, "tags of the whole note: n1, n2\n") || strings.Contains(out, "entry") {
		t.Errorf("show a line of the front part: %q", out)
	}
	// the standard output is not a terminal here, so JSON is the default
	out, _, _, _ = runTag(t, note, "show", "--line", "5")
	var edit struct {
		Scope     string   `json:"scope"`
		NoteTags  []string `json:"note_tags"`
		EntryTags []string `json:"entry_tags"`
		Changed   bool     `json:"changed"`
	}
	mustJSON(t, out, &edit)
	if edit.Changed || edit.Scope != "entry" || strings.Join(edit.NoteTags, ",") != "n1,n2" || strings.Join(edit.EntryTags, ",") != "e" {
		t.Errorf("show JSON: %+v", edit)
	}
	// from a file; and a file is only read
	path := tagFile(t, "n.md", note)
	out, _, code, err = runTag(t, "", "show", path, "--text")
	if err != nil || code != 0 || out != "tags of the whole note: n1, n2\n" || readTagFile(t, path) != note {
		t.Errorf("show a file: %d %v %q", code, err, out)
	}
}

func TestScrapTagFromAFileKeepsEveryByte(t *testing.T) {
	const bom = "\xEF\xBB\xBF"
	note := bom + "# 見出し\r\n本文  \r\n\r\n# 二つ目\r\n本文2"
	path := tagFile(t, "crlf.md", note)
	out, errOut, code, err := runTag(t, "", "add", "仕事", path, "--line", "5")
	want := bom + "# 見出し\r\n本文  \r\n\r\n# 二つ目\r\n<!-- tags: 仕事 -->\r\n本文2"
	if err != nil || code != 0 || out != want || errOut != "" {
		t.Errorf("code %d err %v stdout %q stderr %q; want %q", code, err, out, errOut, want)
	}
	if got := readTagFile(t, path); got != note {
		t.Errorf("a command without --write changed the file: %q", got)
	}
	// the whole note moves the byte order mark on to the new first line
	out, _, _, _ = runTag(t, "", "add", "全体", path)
	if want := bom + "<!-- tags: 全体 -->\r\n# 見出し\r\n本文  \r\n\r\n# 二つ目\r\n本文2"; out != want {
		t.Errorf("whole note: %q, want %q", out, want)
	}
}

func TestScrapTagWriteReplacesTheFileAndNothingElse(t *testing.T) {
	const bom = "\xEF\xBB\xBF"
	note := bom + "# 見出し\r\n本文\r\n\r\n# 二つ目\r\n本文2\r\n"
	path := tagFile(t, "n.md", note)
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}

	out, errOut, code, err := runTag(t, "", "add", "仕事, 急ぎ", path, "--line", "2", "--write")
	if err != nil || code != 0 || out != "" || !strings.Contains(errOut, "added 仕事, 急ぎ") || !strings.Contains(errOut, "the entry at line 2") || strings.Count(errOut, "\n") != 1 {
		t.Fatalf("add: code %d err %v stdout %q stderr %q", code, err, out, errOut)
	}
	want := bom + "# 見出し\r\n<!-- tags: 仕事, 急ぎ -->\r\n本文\r\n\r\n# 二つ目\r\n本文2\r\n"
	if got := readTagFile(t, path); got != want {
		t.Errorf("written %q, want %q", got, want)
	}
	onlyFile(t, path)
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o640 {
			t.Errorf("the mode became %v", fi.Mode().Perm())
		}
	}

	// the same request again changes nothing and does not touch the file
	before, _ := os.Stat(path)
	out, errOut, code, err = runTag(t, "", "add", "仕事", path, "--line", "2", "--write")
	after, _ := os.Stat(path)
	if err != nil || code != 0 || out != "" || !strings.Contains(errOut, "already applies") || !before.ModTime().Equal(after.ModTime()) || readTagFile(t, path) != want {
		t.Errorf("again: code %d err %v stdout %q stderr %q", code, err, out, errOut)
	}

	// remove takes the file back to the bytes it had
	_, errOut, code, err = runTag(t, "", "remove", "急ぎ,仕事", path, "--line", "2", "--write")
	if err != nil || code != 0 || !strings.Contains(errOut, "removed 急ぎ, 仕事") || readTagFile(t, path) != note {
		t.Errorf("remove: code %d err %v stderr %q file %q", code, err, errOut, readTagFile(t, path))
	}
	onlyFile(t, path)

	// a refusal writes nothing
	front := "---\ntitle: T\n---\nbody\n"
	fpath := tagFile(t, "front.md", front)
	if _, _, code, err := runTag(t, "", "add", "a", fpath, "--write"); code != 1 || err == nil || readTagFile(t, fpath) != front {
		t.Errorf("front matter: %d %v", code, err)
	}
	onlyFile(t, fpath)
}

func TestScrapTagWriteFollowsALink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.md")
	link := filepath.Join(dir, "link.md")
	if err := os.WriteFile(target, []byte("# H\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("no symbolic links here: %v", err)
	}
	if _, _, code, err := runTag(t, "", "add", "a", link, "--line", "2", "--write"); code != 0 || err != nil {
		t.Fatalf("%d %v", code, err)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced by a file: %v %v", fi, err)
	}
	if got := readTagFile(t, target); got != "# H\n<!-- tags: a -->\nbody\n" {
		t.Errorf("the file the link points to: %q", got)
	}
}

func TestScrapTagWriteRefusesAFileThatChangedMeanwhile(t *testing.T) {
	path := tagFile(t, "n.md", "# H\nbody\n")
	tagWriteHook = func() {
		// the app saves the note while the new file is being written
		if err := os.WriteFile(path, []byte("# H\nbody\nsomething typed meanwhile\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { tagWriteHook = nil })

	out, _, code, err := runTag(t, "", "add", "a", path, "--line", "2", "--write")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "changed while") || out != "" || strings.Contains(err.Error(), "\n") {
		t.Errorf("code %d err %v stdout %q", code, err, out)
	}
	if got := readTagFile(t, path); got != "# H\nbody\nsomething typed meanwhile\n" {
		t.Errorf("the person's text was overwritten: %q", got)
	}
	onlyFile(t, path)

	// a file removed meanwhile is not created again
	path2 := tagFile(t, "gone.md", "# H\nbody\n")
	tagWriteHook = func() { _ = os.Remove(path2) }
	if _, _, code, err := runTag(t, "", "add", "a", path2, "--line", "2", "--write"); code != 1 || err == nil {
		t.Errorf("a vanished file: %d %v", code, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path2))
	if len(entries) != 0 {
		t.Errorf("the folder of a vanished file holds %v", entries)
	}
}

func TestScrapTagFileRefusals(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.md")
	for _, write := range []bool{false, true} {
		args := []string{"add", "a", missing}
		if write {
			args = append(args, "--write")
		}
		if _, _, code, err := runTag(t, "", args...); code != 1 || err == nil || !strings.Contains(err.Error(), "cannot read") || strings.Contains(err.Error(), "\n") {
			t.Errorf("a missing file (write %v): %d %v", write, code, err)
		}
	}
	if exists(missing) {
		t.Error("a file was created")
	}
	if _, _, code, err := runTag(t, "", "add", "a", dir, "--write"); code != 1 || err == nil || !strings.Contains(err.Error(), "not a file") {
		t.Errorf("a folder: %d %v", code, err)
	}

	// not UTF-8 (Shift_JIS): never read as it is, never rewritten
	sjis := []byte{0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, '\n'}
	spath := filepath.Join(dir, "sjis.md")
	if err := os.WriteFile(spath, sjis, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, write := range []bool{false, true} {
		args := []string{"add", "a", spath}
		if write {
			args = append(args, "--write")
		}
		if out, _, code, err := runTag(t, "", args...); code != 1 || err == nil || !strings.Contains(err.Error(), "not valid UTF-8") || out != "" {
			t.Errorf("a Shift_JIS file (write %v): %d %v %q", write, code, err, out)
		}
	}
	if b, _ := os.ReadFile(spath); !bytes.Equal(b, sjis) {
		t.Errorf("the file was changed: %q", b)
	}

	// over 16 MB is not read at all (the size is looked at first)
	bigPath := filepath.Join(dir, "big.md")
	f, err := os.Create(bigPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(16<<20 + 1); err != nil {
		t.Skipf("cannot make a large file: %v", err)
	}
	f.Close()
	if _, _, code, err := runTag(t, "", "add", "a", bigPath, "--write"); code != 1 || err == nil || !strings.Contains(err.Error(), "over 16 MB") {
		t.Errorf("a large file: %d %v", code, err)
	}
	// and standard input is bound the same way
	if _, _, code, err := runTag(t, strings.Repeat("a", 16<<20+1), "add", "a"); code != 1 || err == nil || !strings.Contains(err.Error(), "over 16 MB") {
		t.Errorf("large standard input: %d %v", code, err)
	}
}

func TestScrapTagBadArguments(t *testing.T) {
	path := tagFile(t, "n.md", "# H\nbody\n")
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no action", nil, "action required"},
		{"unknown action", []string{"set", "a"}, "unknown scrap tag action"},
		{"no tags", []string{"add"}, "tags required"},
		{"no tags for remove", []string{"remove", "--line", "2"}, "tags required"},
		{"empty tags", []string{"add", " , "}, "no tag"},
		{"nine tags", []string{"add", "a,b,c,d,e,f,g,h,i"}, "too many tags"},
		{"a long tag", []string{"add", strings.Repeat("x", 65)}, "longer than 64"},
		{"a comment end in a tag", []string{"add", "a-->b"}, "cannot contain"},
		{"too many words", []string{"add", "a", path, "extra"}, `got "extra"`},
		{"line 0", []string{"add", "a", "--line", "0"}, "invalid --line 0"},
		{"line -1", []string{"add", "a", "--line=-1"}, "invalid --line -1"},
		{"line not a number", []string{"add", "a", "--line", "x"}, `invalid value "x" for flag -line`},
		{"line past the end", []string{"add", "a", "--line", "9"}, "outside the text (1 to 3)"},
		{"write without a file", []string{"add", "a", "--write"}, "--write needs a <file>"},
		{"write with show", []string{"show", path, "--write"}, "--write has no meaning"},
		{"show with two files", []string{"show", path, path}, "at most a file"},
		{"unknown flag", []string{"add", "a", "--nope"}, "flag provided but not defined"},
	}
	for _, c := range cases {
		out, _, code, err := runTag(t, "# H\nbody\n", c.args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), c.want) || out != "" || strings.Contains(err.Error(), "\n") {
			t.Errorf("%s: code %d err %v stdout %q; want an error with %q", c.name, code, err, out, c.want)
		}
	}
	if got := readTagFile(t, path); got != "# H\nbody\n" {
		t.Errorf("a refused call changed the file: %q", got)
	}
	// -h prints the usage of scrap, exit 0
	out, _, code, err := runTag(t, "", "add", "-h")
	if err != nil || code != 0 || !strings.Contains(out, "scrap tag add") {
		t.Errorf("-h: %d %v %q", code, err, out)
	}
}

// Text on standard input is decoded the way a pipe is (here: a byte order mark is dropped, as `cmd | md-memo` does).
func TestScrapTagStandardInputIsDecodedLikeAPipe(t *testing.T) {
	out, _, code, err := runTag(t, "\xEF\xBB\xBF# H\nbody\n", "add", "a", "--line", "2")
	if err != nil || code != 0 || out != "# H\n<!-- tags: a -->\nbody\n" {
		t.Errorf("%d %v %q", code, err, out)
	}
	// an empty text can still be tagged as a whole
	out, _, code, err = runTag(t, "", "add", "a")
	if err != nil || code != 0 || out != "<!-- tags: a -->\n" {
		t.Errorf("empty input: %d %v %q", code, err, out)
	}
}

func TestScrapRequiresAKnownAction(t *testing.T) {
	_, _, code, err := runHeadless(t, "scrap")
	if code != 1 || err == nil || !strings.Contains(err.Error(), "tag") {
		t.Errorf("scrap with no action should list tag: %d %v", code, err)
	}
}

// The shared entry point the JSON-RPC method and the window's bind use.
func TestScrapTagEditChecksItsArguments(t *testing.T) {
	ok, err := ScrapTagEdit(ScrapTagEditRequest{Text: "# H\nbody\n", Op: "add", Scope: "entry", Line: 2, Tags: TagList{"a"}, ReturnText: true})
	if err != nil || !ok.Changed || ok.Text == nil || *ok.Text != "# H\n<!-- tags: a -->\nbody\n" {
		t.Fatalf("%+v %v", ok, err)
	}
	b, _ := json.Marshal(ok)
	var asMap map[string]interface{}
	mustJSON(t, string(b), &asMap)
	if asMap["text"] != "# H\n<!-- tags: a -->\nbody\n" || asMap["scope"] != "entry" || asMap["start_line"] != float64(2) {
		t.Errorf("JSON = %s", b)
	}
	// no text unless asked for, even when it is empty
	plain, _ := ScrapTagEdit(ScrapTagEditRequest{Text: "x\n", Op: "show"})
	if b, _ := json.Marshal(plain); strings.Contains(string(b), `"text"`) {
		t.Errorf("text without return_text: %s", b)
	}
	empty, _ := ScrapTagEdit(ScrapTagEditRequest{Op: "remove", Tags: TagList{"a"}, ReturnText: true})
	if b, _ := json.Marshal(empty); !strings.Contains(string(b), `"text":""`) {
		t.Errorf("an empty new text must still be sent: %s", b)
	}
	// scope defaults to note
	def, err := ScrapTagEdit(ScrapTagEditRequest{Text: "# H\n", Op: "add", Tags: TagList{"a"}})
	if err != nil || def.Scope != "note" {
		t.Errorf("default scope: %+v %v", def, err)
	}

	for _, req := range []ScrapTagEditRequest{
		{Op: "", Tags: TagList{"a"}},
		{Op: "toggle", Tags: TagList{"a"}},
		{Op: "add", Scope: "file", Tags: TagList{"a"}},
		{Op: "add", Scope: "entry", Tags: TagList{"a"}},
		{Op: "add", Scope: "entry", Line: 5, Text: "x", Tags: TagList{"a"}},
		{Op: "add"},
		{Op: "add", Tags: TagList{"a,b,c,d,e,f,g,h,i"}},
	} {
		if _, err := ScrapTagEdit(req); err == nil || !IsParamError(err) || strings.Contains(err.Error(), "\n") {
			t.Errorf("%+v: %v is not a one-line ParamError", req, err)
		}
	}
}

func TestTagListReadsAStringOrAList(t *testing.T) {
	for in, want := range map[string]string{`"a, b"`: "a, b", `["a","b"]`: "a|b", `null`: "", `[]`: "", `"a"`: "a"} {
		var got TagList
		if err := json.Unmarshal([]byte(in), &got); err != nil || strings.Join(got, "|") != want {
			t.Errorf("%s: %q %v, want %q", in, got, err, want)
		}
	}
	for _, in := range []string{`3`, `{"a":1}`, `[1]`, `true`} {
		var got TagList
		if err := json.Unmarshal([]byte(in), &got); err == nil || !strings.Contains(err.Error(), "tags must be a string or a list of strings") {
			t.Errorf("%s: %v", in, err)
		}
	}
}
