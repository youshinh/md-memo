package notesave

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"md-memo/pkg/encoding"
)

func rule(t *testing.T, err error) string {
	t.Helper()
	var re *RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("expected a *RefusedError, got %T: %v", err, err)
	}
	return re.Rule
}

// --- CleanPath / ValidatePath: rules that need no disk ------------------------------------------

func TestCleanPathRefusalsThatHoldOnEverySystem(t *testing.T) {
	base := t.TempDir()
	j := func(parts ...string) string { return filepath.Join(append([]string{base}, parts...)...) }

	cases := []struct {
		name string
		path string
		rule string
	}{
		{"empty", "", RuleEmpty},

		// network and device paths, every slash style, on every host
		{"UNC backslashes", `\\host\share\note.md`, RuleNetworkPath},
		{"UNC forward slashes", `//host/share/note.md`, RuleNetworkPath},
		{"UNC mixed slashes", `\/host/share/note.md`, RuleNetworkPath},
		{"UNC mixed slashes 2", `/\host\share\note.md`, RuleNetworkPath},
		{"extended UNC", `\\?\UNC\host\share\note.md`, RuleNetworkPath},
		{"extended local", `\\?\C:\Users\me\note.md`, RuleNetworkPath},
		{"device namespace", `\\.\pipe\note.md`, RuleNetworkPath},
		{"forward device namespace", `//./pipe/note.md`, RuleNetworkPath},

		// not absolute
		{"bare name", `note.md`, RuleNotAbsolute},
		{"dot relative", `.` + string(filepath.Separator) + `note.md`, RuleNotAbsolute},
		{"dot dot relative", `..` + string(filepath.Separator) + `note.md`, RuleNotAbsolute},
		{"sub folder relative", `sub/note.md`, RuleNotAbsolute},
		{"tilde", `~/note.md`, RuleNotAbsolute},
		{"drive relative", `C:note.md`, RuleNotAbsolute},

		// alternate data streams
		{"stream", j("note.md:secret"), RuleStream},
		{"stream data", j("note.md::$DATA"), RuleStream},
		{"colon in a folder", j("a:b", "note.md"), RuleStream},

		// device names
		{"NUL", j("NUL"), RuleDeviceName},
		{"nul with extension", j("nul.md"), RuleDeviceName},
		{"CON txt", j("CON.txt"), RuleDeviceName},
		{"Com1 mixed case", j("Com1.md"), RuleDeviceName},
		{"lpt9 markdown", j("lpt9.markdown"), RuleDeviceName},
		{"aux", j("aux"), RuleDeviceName},
		{"PRN", j("PRN.md"), RuleDeviceName},
		{"device with a space before the dot", j("con .md"), RuleDeviceName},
		{"device as a folder", j("nul", "note.md"), RuleDeviceName},
		{"device double extension", j("aux.tar.md"), RuleDeviceName},

		// characters and endings Windows does not keep
		{"question mark", j("what?.md"), RuleInvalidChar},
		{"asterisk", j("a*.md"), RuleInvalidChar},
		{"angle", j("a<b.md"), RuleInvalidChar},
		{"quote", j(`a"b.md`), RuleInvalidChar},
		{"pipe", j("a|b.md"), RuleInvalidChar},
		{"control character", j("a\x01b.md"), RuleInvalidChar},
		{"newline", j("a\nb.md"), RuleInvalidChar},
		{"NUL byte", j("a\x00b.md"), RuleInvalidChar},
		{"trailing dot", j("note.md."), RuleTrailing},
		{"trailing space", j("note.md "), RuleTrailing},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := CleanPath(c.path)
			if err == nil {
				t.Fatalf("CleanPath(%q) = %q, want a refusal (%s)", c.path, got, c.rule)
			}
			if r := rule(t, err); r != c.rule {
				t.Errorf("CleanPath(%q) refused by rule %q (%v), want %q", c.path, r, err, c.rule)
			}
			if err.Error() == "" {
				t.Errorf("a refusal must say why")
			}
		})
	}
}

func TestCleanPathAcceptsPlainAbsolutePaths(t *testing.T) {
	base := t.TempDir()
	good := []string{
		filepath.Join(base, "note.md"),
		filepath.Join(base, "console.md"), // starts like CON, is not it
		filepath.Join(base, "com10.md"),   // COM10 is not a device
		filepath.Join(base, "nul-x.md"),
		filepath.Join(base, "communal.txt"),
		filepath.Join(base, "sub folder", "日本語のメモ.md"),
		filepath.Join(base, "a.b.c.md"),
		filepath.Join(base, ".hidden.md"),
	}
	for _, p := range good {
		got, err := CleanPath(p)
		if err != nil {
			t.Errorf("CleanPath(%q): %v", p, err)
			continue
		}
		if got != filepath.Clean(p) {
			t.Errorf("CleanPath(%q) = %q, want the cleaned path", p, got)
		}
	}
}

func TestCleanPathCleansDotDot(t *testing.T) {
	base := t.TempDir()
	got, err := CleanPath(filepath.Join(base, "a", "..", "b", ".", "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "b", "note.md"); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestCleanPathBothSlashStylesOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("drive-letter paths are absolute only on Windows")
	}
	for _, p := range []string{`C:\Users\me\note.md`, `C:/Users/me/note.md`, `c:\Users\me\note.md`} {
		got, err := CleanPath(p)
		if err != nil {
			t.Errorf("CleanPath(%q): %v", p, err)
			continue
		}
		if !strings.Contains(got, `Users\me\note.md`) {
			t.Errorf("CleanPath(%q) = %q, want backslashes after cleaning", p, got)
		}
	}
	// A stream after the drive part is refused; the drive colon itself is fine.
	if _, err := CleanPath(`C:\Users\me\note.md:hidden`); err == nil || rule(t, err) != RuleStream {
		t.Errorf("stream on a drive path: %v", err)
	}
	if _, err := CleanPath(`\note.md`); err == nil || rule(t, err) != RuleNotAbsolute {
		t.Errorf("rooted path without a drive: %v", err)
	}
}

func TestExtensionAllowList(t *testing.T) {
	base := t.TempDir()
	ok := []string{"a.md", "a.MD", "a.Markdown", "a.markdown", "a.txt", "a.TXT", "a.md.txt", "a.b.md"}
	for _, name := range ok {
		if _, err := ValidatePath(filepath.Join(base, name)); err != nil {
			t.Errorf("%s should be allowed: %v", name, err)
		}
	}
	bad := []string{"a", "a.docx", "a.md.exe", "a.json", "a.html", "a.mdx", "a.md~", "a.bat", "a.ps1", "a.lnk"}
	for _, name := range bad {
		_, err := ValidatePath(filepath.Join(base, name))
		if err == nil {
			t.Errorf("%s should be refused", name)
			continue
		}
		if rule(t, err) != RuleExtension {
			t.Errorf("%s refused by %v, want the extension rule", name, err)
		}
		if !strings.Contains(err.Error(), ".md, .markdown, .txt") {
			t.Errorf("the error should list the allowed extensions, got %q", err)
		}
	}
}

func TestErrorsNeverQuoteNoteText(t *testing.T) {
	base := t.TempDir()
	_, err := Save(Request{Path: filepath.Join(base, "nope", "x.md"), Text: "SECRET-NOTE-TEXT"})
	if err == nil || strings.Contains(err.Error(), "SECRET-NOTE-TEXT") {
		t.Errorf("error = %v", err)
	}
}

// --- CheckTarget: the disk ----------------------------------------------------------------------

func TestCheckTarget(t *testing.T) {
	base := t.TempDir()
	existing := filepath.Join(base, "exists.md")
	if err := os.WriteFile(existing, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "adir.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(base, "fresh.md")

	t.Run("new file in an existing folder", func(t *testing.T) {
		tg, err := CheckTarget(fresh, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if tg.Exists || tg.Own || tg.Path != fresh {
			t.Errorf("target = %+v", tg)
		}
	})
	t.Run("existing file, no overwrite", func(t *testing.T) {
		_, err := CheckTarget(existing, "", false)
		if err == nil || rule(t, err) != RuleExists {
			t.Fatalf("err = %v", err)
		}
		if !strings.Contains(err.Error(), "refused overwrite") {
			t.Errorf("message = %q", err)
		}
	})
	t.Run("existing file, overwrite", func(t *testing.T) {
		tg, err := CheckTarget(existing, "", true)
		if err != nil || !tg.Exists || tg.Own {
			t.Fatalf("target = %+v, err = %v", tg, err)
		}
	})
	t.Run("own bound file needs no flag", func(t *testing.T) {
		tg, err := CheckTarget(existing, existing, false)
		if err != nil || !tg.Own {
			t.Fatalf("target = %+v, err = %v", tg, err)
		}
	})
	t.Run("another file is not own", func(t *testing.T) {
		other := filepath.Join(base, "other.md")
		if err := os.WriteFile(other, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := CheckTarget(existing, other, false); err == nil || rule(t, err) != RuleExists {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a bound file that is gone does not make another path own", func(t *testing.T) {
		gone := filepath.Join(base, "gone.md")
		if _, err := CheckTarget(existing, gone, false); err == nil || rule(t, err) != RuleExists {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("own path spelled with another case", func(t *testing.T) {
		if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
			t.Skip("case-insensitive volumes only")
		}
		upper := filepath.Join(base, "EXISTS.md")
		tg, err := CheckTarget(upper, existing, false)
		if err != nil {
			t.Skipf("the volume is case sensitive here: %v", err)
		}
		if !tg.Own {
			t.Errorf("the same file spelled with another case is still its own file: %+v", tg)
		}
	})
	t.Run("a directory, even with overwrite", func(t *testing.T) {
		for _, ow := range []bool{false, true} {
			_, err := CheckTarget(filepath.Join(base, "adir.md"), "", ow)
			if err == nil || rule(t, err) != RuleDirectory {
				t.Fatalf("overwrite=%v err = %v", ow, err)
			}
		}
	})
	t.Run("parent folder missing", func(t *testing.T) {
		p := filepath.Join(base, "no", "such", "note.md")
		_, err := CheckTarget(p, "", true)
		if err == nil || rule(t, err) != RuleParentMissing {
			t.Fatalf("err = %v", err)
		}
		if _, statErr := os.Stat(filepath.Join(base, "no")); statErr == nil {
			t.Error("a folder was created")
		}
	})
	t.Run("parent is a file", func(t *testing.T) {
		p := filepath.Join(existing, "note.md")
		_, err := CheckTarget(p, "", true)
		if err == nil || rule(t, err) != RuleParentMissing {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestCheckTargetFollowsALinkAndRefusesABrokenOne(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real.md")
	if err := os.WriteFile(real, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link.md")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
	tg, err := CheckTarget(link, link, false)
	if err != nil {
		t.Fatal(err)
	}
	if !tg.Own {
		t.Error("the note's own (linked) file needs no overwrite flag")
	}
	wantReal, _ := filepath.EvalSymlinks(real)
	gotReal, _ := filepath.EvalSymlinks(tg.Real)
	if gotReal != wantReal {
		t.Errorf("Real = %q, want %q", tg.Real, real)
	}

	broken := filepath.Join(base, "broken.md")
	if err := os.Symlink(filepath.Join(base, "missing.md"), broken); err != nil {
		t.Skip(err)
	}
	if _, err := CheckTarget(broken, "", true); err == nil || rule(t, err) != RuleBrokenLink {
		t.Fatalf("err = %v", err)
	}
}

// --- Save: the whole thing ----------------------------------------------------------------------

func tmpLeftovers(t *testing.T, dir string) []string {
	t.Helper()
	var left []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			left = append(left, e.Name())
		}
	}
	return left
}

func TestSaveNewFileUTF8(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "new note.md")
	text := "# 見出し\nline two\r\nline three\n"
	res, err := Save(Request{Path: path, Text: text})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Encoding != encoding.NameUTF8 || res.Path != path || res.Bytes != len(text) {
		t.Errorf("result = %+v", res)
	}
	got, _ := os.ReadFile(path)
	if string(got) != text {
		t.Errorf("file = %q, want the text as it is (no BOM, no line-ending change)", got)
	}
	if bytes.HasPrefix(got, []byte{0xEF, 0xBB, 0xBF}) {
		t.Error("a BOM was written")
	}
	if left := tmpLeftovers(t, base); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}
}

func TestSaveShiftJIS(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "sjis.txt")
	text := "日本語のメモ\nabc\n"
	for _, name := range []string{"sjis", "Shift_JIS", "shift-jis", "CP932"} {
		res, err := Save(Request{Path: path, Text: text, Encoding: name, Overwrite: true})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if res.Encoding != encoding.NameShiftJIS {
			t.Errorf("%s: encoding = %q", name, res.Encoding)
		}
		raw, _ := os.ReadFile(path)
		if utf8Valid(raw) {
			t.Errorf("%s: the file must hold Shift_JIS bytes, not UTF-8: %x", name, raw)
		}
		back, err := encoding.DecodeWith(raw, "Shift_JIS")
		if err != nil || back != text {
			t.Errorf("%s: decoded %q, %v", name, back, err)
		}
	}
}

func utf8Valid(b []byte) bool {
	s := string(b)
	for _, r := range s {
		if r == 0xFFFD {
			return false
		}
	}
	return true
}

func TestSaveUnrepresentableCharacterWritesNothing(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "sjis.md")
	_, err := Save(Request{Path: path, Text: "ok\nno \U0001F916 here", Encoding: "sjis"})
	var ue *encoding.UnrepresentableError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %T %v, want *encoding.UnrepresentableError", err, err)
	}
	if ue.Chars[0].Line != 2 || ue.Chars[0].Column != 4 {
		t.Errorf("position = %+v", ue.Chars[0])
	}
	if _, statErr := os.Stat(path); statErr == nil {
		t.Error("the file must not exist")
	}
	if left := tmpLeftovers(t, base); len(left) != 0 {
		t.Errorf("temporary files left: %v", left)
	}

	// An existing file stays as it was.
	if err := os.WriteFile(path, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(Request{Path: path, Text: "\U0001F916", Encoding: "sjis", Overwrite: true}); err == nil {
		t.Fatal("expected an error")
	}
	if got, _ := os.ReadFile(path); string(got) != "keep me" {
		t.Errorf("the old file was changed: %q", got)
	}
}

func TestSaveUnknownEncoding(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "x.md")
	if _, err := Save(Request{Path: path, Text: "x", Encoding: "latin1"}); err == nil {
		t.Fatal("expected an error for an unknown encoding")
	}
	if _, err := os.Stat(path); err == nil {
		t.Error("nothing may be written")
	}
}

func TestSaveOverwriteRules(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "note.md")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Save(Request{Path: path, Text: "new"}); err == nil || rule(t, err) != RuleExists {
		t.Fatalf("without overwrite: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "old" {
		t.Fatalf("the file changed despite the refusal: %q", got)
	}

	res, err := Save(Request{Path: path, Text: "own", Own: path})
	if err != nil || res.Created {
		t.Fatalf("own path: %+v, %v", res, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "own" {
		t.Fatalf("content = %q", got)
	}

	res, err = Save(Request{Path: path, Text: "forced", Overwrite: true})
	if err != nil || res.Created {
		t.Fatalf("overwrite: %+v, %v", res, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "forced" {
		t.Fatalf("content = %q", got)
	}
}

func TestSaveKeepsPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits are not meaningful on Windows")
	}
	base := t.TempDir()
	path := filepath.Join(base, "private.md")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(Request{Path: path, Text: "new", Own: path}); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
}

func TestSaveThroughALinkKeepsTheLink(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real.md")
	if err := os.WriteFile(real, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link.md")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
	if _, err := Save(Request{Path: link, Text: "via link", Own: link}); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link was replaced by a regular file: %v %v", fi, err)
	}
	if got, _ := os.ReadFile(real); string(got) != "via link" {
		t.Errorf("the linked file = %q", got)
	}
}

func TestSaveRefusesBadPathsBeforeTouchingAnything(t *testing.T) {
	base := t.TempDir()
	for _, p := range []string{
		"note.md",
		filepath.Join(base, "note.docx"),
		filepath.Join(base, "missing-folder", "note.md"),
		filepath.Join(base, "nul.md"),
	} {
		if _, err := Save(Request{Path: p, Text: "x", Overwrite: true}); err == nil {
			t.Errorf("Save(%q) should be refused", p)
		}
	}
	entries, _ := os.ReadDir(base)
	if len(entries) != 0 {
		t.Errorf("the folder should be untouched, has %d entries", len(entries))
	}
}
