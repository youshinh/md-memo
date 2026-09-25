package skillinstall

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const skillMD = "---\nname: md-memo\ndescription: test\n---\n\n# Skill\n"

func skillV1() fstest.MapFS {
	return fstest.MapFS{
		"SKILL.md":                 {Data: []byte(skillMD)},
		"references/interfaces.md": {Data: []byte("# interfaces v1\n")},
		"references/setup.md":      {Data: []byte("# setup v1\n")},
	}
}

func skillV2() fstest.MapFS {
	return fstest.MapFS{
		"SKILL.md":                 {Data: []byte(skillMD + "more\n")},
		"references/interfaces.md": {Data: []byte("# interfaces v2\n")},
		"references/new.md":        {Data: []byte("# new in v2\n")},
	}
}

func read(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// onlySkillIn checks that base holds exactly the skill folder: no temporary sibling is left.
func onlySkillIn(t *testing.T, base string) {
	t.Helper()
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != SkillName {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("%s holds %v, want only %s", base, names, SkillName)
	}
}

func readMarker(t *testing.T, dir string) Marker {
	t.Helper()
	var m Marker
	if err := json.Unmarshal([]byte(read(t, filepath.Join(dir, MarkerFile))), &m); err != nil {
		t.Fatalf("the marker is not JSON: %v", err)
	}
	return m
}

func TestInstallWritesTheSkillAndAMarker(t *testing.T) {
	base := filepath.Join(t.TempDir(), "nested", "skills") // neither level exists yet
	res, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "md-memo")
	if res.Action != Installed || res.Path != target || res.Files != 3 || res.Version != "1.8.0" {
		t.Errorf("result = %+v", res)
	}
	if got := read(t, filepath.Join(target, "references", "interfaces.md")); got != "# interfaces v1\n" {
		t.Errorf("interfaces.md = %q", got)
	}
	if got := read(t, filepath.Join(target, "SKILL.md")); got != skillMD {
		t.Errorf("SKILL.md = %q", got)
	}
	wantHash, err := Hash(skillV1())
	if err != nil {
		t.Fatal(err)
	}
	m := readMarker(t, target)
	if m.Version != "1.8.0" || m.Hash != wantHash || res.Hash != wantHash || len(m.Files) != 3 {
		t.Errorf("marker = %+v, want version 1.8.0, hash %s and 3 files", m, wantHash)
	}
	onlySkillIn(t, base)
}

func TestHashIsStableAndSensitive(t *testing.T) {
	a, err := Hash(skillV1())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if b, _ := Hash(skillV1()); b != a {
			t.Fatalf("the hash changed between calls: %s vs %s", a, b)
		}
	}
	if !strings.HasPrefix(a, "sha256:") || len(a) != len("sha256:")+64 {
		t.Errorf("hash = %q", a)
	}

	crlf := skillV1()
	for name, f := range crlf {
		f.Data = []byte(strings.ReplaceAll(string(f.Data), "\n", "\r\n"))
		crlf[name] = f
	}
	if b, _ := Hash(crlf); b != a {
		t.Errorf("CRLF line endings changed the hash: %s vs %s", a, b)
	}

	edited := skillV1()
	edited["SKILL.md"] = &fstest.MapFile{Data: []byte(skillMD + "x")}
	if b, _ := Hash(edited); b == a {
		t.Error("an edited file must change the hash")
	}
	renamed := skillV1()
	renamed["references/other.md"] = renamed["references/setup.md"]
	delete(renamed, "references/setup.md")
	if b, _ := Hash(renamed); b == a {
		t.Error("a renamed file must change the hash")
	}
	if _, err := Hash(fstest.MapFS{}); err == nil {
		t.Error("an empty skill must be an error")
	}
}

func TestInstallingTheSameContentIsUpToDate(t *testing.T) {
	base := t.TempDir()
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, SkillName)
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	for _, p := range []string{"SKILL.md", MarkerFile} {
		if err := os.Chtimes(filepath.Join(target, p), past, past); err != nil {
			t.Fatal(err)
		}
	}

	res, err := Install(skillV1(), Options{Base: base, Version: "1.8.1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != UpToDate {
		t.Errorf("action = %q, want %q", res.Action, UpToDate)
	}
	for _, p := range []string{"SKILL.md", MarkerFile} {
		fi, err := os.Stat(filepath.Join(target, p))
		if err != nil || !fi.ModTime().Equal(past) {
			t.Errorf("%s was rewritten although nothing changed (%v)", p, err)
		}
	}
	onlySkillIn(t, base)
}

// A copy somebody made by hand (identical files, no marker) is up to date, and gets a marker so
// that a later update can tell it is untouched.
func TestIdenticalFolderWithoutMarkerIsUpToDateAndGetsMarked(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, SkillName)
	for name, f := range skillV1() {
		write(t, filepath.Join(target, filepath.FromSlash(name)), string(f.Data))
	}
	res, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != UpToDate {
		t.Errorf("action = %q", res.Action)
	}
	if m := readMarker(t, target); m.Version != "1.8.0" {
		t.Errorf("marker = %+v", m)
	}
	// ... and now an update works without --force.
	if res, err := Install(skillV2(), Options{Base: base, Version: "1.9.0"}); err != nil || res.Action != Updated {
		t.Errorf("update after marking: %+v, %v", res, err)
	}
}

func TestAnOlderUntouchedCopyIsReplaced(t *testing.T) {
	base := t.TempDir()
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.7.0"}); err != nil {
		t.Fatal(err)
	}
	res, err := Install(skillV2(), Options{Base: base, Version: "1.8.0"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != Updated || res.PreviousVersion != "1.7.0" || len(res.Discarded) != 0 {
		t.Errorf("result = %+v", res)
	}
	target := filepath.Join(base, SkillName)
	if got := read(t, filepath.Join(target, "references", "interfaces.md")); got != "# interfaces v2\n" {
		t.Errorf("interfaces.md = %q", got)
	}
	if !exists(filepath.Join(target, "references", "new.md")) {
		t.Error("the file that is new in v2 is missing")
	}
	if exists(filepath.Join(target, "references", "setup.md")) {
		t.Error("the file that v2 dropped is still there")
	}
	if m := readMarker(t, target); m.Version != "1.8.0" || len(m.Files) != 3 {
		t.Errorf("marker = %+v", m)
	}
	onlySkillIn(t, base)
}

func TestLineEndingChangesAreNotEdits(t *testing.T) {
	base := t.TempDir()
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.7.0"}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(base, SkillName, "SKILL.md")
	write(t, p, strings.ReplaceAll(skillMD, "\n", "\r\n"))
	if res, err := Install(skillV2(), Options{Base: base, Version: "1.8.0"}); err != nil || res.Action != Updated {
		t.Errorf("a file with converted line endings counts as edited: %+v, %v", res, err)
	}
}

func TestEditedFilesAreRefusedUnlessForced(t *testing.T) {
	base := t.TempDir()
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.7.0"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, SkillName)
	write(t, filepath.Join(target, "SKILL.md"), skillMD+"my own rule\n")
	write(t, filepath.Join(target, "notes.md"), "mine\n")
	if err := os.Remove(filepath.Join(target, "references", "setup.md")); err != nil {
		t.Fatal(err)
	}

	_, err := Install(skillV2(), Options{Base: base, Version: "1.8.0"})
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want a ConflictError", err)
	}
	want := []string{"extra: notes.md", "missing: references/setup.md", "modified: SKILL.md"}
	if strings.Join(conflict.Files, "|") != strings.Join(want, "|") {
		t.Errorf("files = %v, want %v", conflict.Files, want)
	}
	for _, s := range []string{"--force", "notes.md", "modified: SKILL.md", target} {
		if !strings.Contains(err.Error(), s) {
			t.Errorf("the message does not mention %q: %s", s, err)
		}
	}
	// Left exactly as it was.
	if got := read(t, filepath.Join(target, "SKILL.md")); got != skillMD+"my own rule\n" {
		t.Errorf("the edited file was touched: %q", got)
	}
	if !exists(filepath.Join(target, "notes.md")) {
		t.Error("the user's own file was removed")
	}
	onlySkillIn(t, base)

	res, err := Install(skillV2(), Options{Base: base, Version: "1.8.0", Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Action != Replaced || strings.Join(res.Discarded, "|") != strings.Join(want, "|") {
		t.Errorf("result = %+v", res)
	}
	if got := read(t, filepath.Join(target, "SKILL.md")); got != skillMD+"more\n" {
		t.Errorf("SKILL.md = %q", got)
	}
	if exists(filepath.Join(target, "notes.md")) {
		t.Error("--force must replace the whole folder")
	}
	onlySkillIn(t, base)
}

func TestAFolderWithoutAMarkerIsNotOverwritten(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, SkillName)
	write(t, filepath.Join(target, "SKILL.md"), "somebody else's skill\n")

	_, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"})
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want a ConflictError", err)
	}
	if !strings.Contains(conflict.Reason, MarkerFile) {
		t.Errorf("reason = %q, want it to explain the missing marker", conflict.Reason)
	}
	if strings.Join(conflict.Files, "|") != "missing: references/interfaces.md|missing: references/setup.md|modified: SKILL.md" {
		t.Errorf("files = %v", conflict.Files)
	}
	if got := read(t, filepath.Join(target, "SKILL.md")); got != "somebody else's skill\n" {
		t.Errorf("the folder was touched: %q", got)
	}

	if res, err := Install(skillV1(), Options{Base: base, Version: "1.8.0", Force: true}); err != nil || res.Action != Replaced {
		t.Errorf("forced: %+v, %v", res, err)
	}
	onlySkillIn(t, base)
}

func TestANewerCopyIsNotDowngraded(t *testing.T) {
	base := t.TempDir()
	if _, err := Install(skillV2(), Options{Base: base, Version: "2.0.0"}); err != nil {
		t.Fatal(err)
	}
	_, err := Install(skillV1(), Options{Base: base, Version: "1.9.0"})
	var conflict *ConflictError
	if !errors.As(err, &conflict) || !strings.Contains(conflict.Reason, "newer") || len(conflict.Files) != 0 {
		t.Fatalf("err = %v, want a ConflictError about a newer copy", err)
	}
	if strings.Contains(err.Error(), "changes listed above") {
		t.Errorf("nothing is lost in a downgrade, the message must not say so: %s", err)
	}
	if res, err := Install(skillV1(), Options{Base: base, Version: "1.9.0", Force: true}); err != nil || res.Action != Replaced {
		t.Errorf("forced downgrade: %+v, %v", res, err)
	}

	// A development build ("dev") has no order: it replaces an untouched copy.
	if _, err := Install(skillV2(), Options{Base: base, Version: "2.0.0"}); err != nil {
		t.Fatal(err)
	}
	if res, err := Install(skillV1(), Options{Base: base, Version: "dev"}); err != nil || res.Action != Updated {
		t.Errorf("dev build: %+v, %v", res, err)
	}
}

func TestAPlainFileInTheWayIsRefusedUnlessForced(t *testing.T) {
	base := t.TempDir()
	write(t, filepath.Join(base, SkillName), "not a folder")
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"}); err == nil {
		t.Fatal("a file where the folder belongs must be refused")
	}
	if got := read(t, filepath.Join(base, SkillName)); got != "not a folder" {
		t.Errorf("the file was touched: %q", got)
	}
	if res, err := Install(skillV1(), Options{Base: base, Version: "1.8.0", Force: true}); err != nil || res.Action != Replaced {
		t.Errorf("forced: %+v, %v", res, err)
	}
	if !exists(filepath.Join(base, SkillName, "SKILL.md")) {
		t.Error("the skill was not installed over the file")
	}
	onlySkillIn(t, base)
}

func TestNoTargetOrBrokenBaseIsAnError(t *testing.T) {
	if _, err := Install(skillV1(), Options{}); err == nil {
		t.Error("no base must be an error")
	}
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	write(t, blocker, "a file")
	if _, err := Install(skillV1(), Options{Base: filepath.Join(blocker, "skills")}); err == nil {
		t.Error("a base below a file must be an error")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("a failed install left %d entries behind", len(entries)-1)
	}
}

func TestConflictErrorTruncatesLongLists(t *testing.T) {
	var files []string
	for i := 0; i < 25; i++ {
		files = append(files, "modified: f"+string(rune('a'+i%26))+".md")
	}
	msg := (&ConflictError{Path: "P", Reason: "edited", Files: files}).Error()
	if !strings.Contains(msg, "... and 5 more") || strings.Count(msg, "modified:") != 20 {
		t.Errorf("message = %s", msg)
	}
}

func TestVersionOrder(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"1.9.0", "1.8.0", true},
		{"1.8.0", "1.9.0", false},
		{"1.8.0", "1.8.0", false},
		{"1.10.0", "1.9.0", true},
		{"2.0", "1.9.9", true},
		{"1.8.1", "1.8", true},
		{"dev", "1.8.0", false},
		{"1.8.0", "dev", false},
		{"", "1.8.0", false},
		{"1.x", "1.0", false},
	} {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func writeSkillFolder(t *testing.T, dir string) {
	t.Helper()
	write(t, filepath.Join(dir, "SKILL.md"), skillMD)
	write(t, filepath.Join(dir, "references", "x.md"), "x")
}

func TestFindSourceFindsTheSkillAboveAStartFolder(t *testing.T) {
	root := t.TempDir()
	writeSkillFolder(t, filepath.Join(root, "skills", "md-memo"))
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(root, "skills", "md-memo")
	if got := FindSource(deep); got != want {
		t.Errorf("FindSource(%s) = %q, want %q", deep, got, want)
	}
	if got := FindSource("", filepath.Join(t.TempDir(), "elsewhere"), deep); got != want {
		t.Errorf("later start folders are tried too: %q", got)
	}
	if got := FindSource(t.TempDir()); got != "" {
		// A temp folder with no skills below it (an ancestor of the temp folder could hold one only
		// if the machine had a skills/md-memo there; be tolerant of that, but not of a wrong answer).
		if !looksLikeSkill(got) {
			t.Errorf("FindSource found %q, which is not the skill", got)
		}
	}

	// Another skill named otherwise is not ours.
	other := t.TempDir()
	write(t, filepath.Join(other, "skills", "md-memo", "SKILL.md"), "---\nname: something-else\n---\n")
	if looksLikeSkill(filepath.Join(other, "skills", "md-memo")) {
		t.Error("a SKILL.md named something else must not be taken for ours")
	}
	// Six levels up is the limit.
	far := t.TempDir()
	writeSkillFolder(t, filepath.Join(far, "skills", "md-memo"))
	tooDeep := filepath.Join(far, "1", "2", "3", "4", "5", "6", "7")
	if err := os.MkdirAll(tooDeep, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := FindSource(tooDeep); got == filepath.Join(far, "skills", "md-memo") {
		t.Error("the search must stop after a few levels")
	}
}

func TestLink(t *testing.T) {
	src := filepath.Join(t.TempDir(), "skills", "md-memo")
	writeSkillFolder(t, src)
	base := filepath.Join(t.TempDir(), "agent", "skills")

	if runtime.GOOS == "windows" {
		if _, err := Link(src, Options{Base: base}); !errors.Is(err, ErrLinkUnsupported) {
			t.Errorf("err = %v, want ErrLinkUnsupported on Windows", err)
		}
		if exists(base) {
			t.Error("a refused link must not create anything")
		}
		// The rest of Link, where this account is allowed to make symbolic links at all.
		probe := filepath.Join(t.TempDir(), "probe")
		if err := os.Symlink(src, probe); err != nil {
			t.Skipf("cannot create symbolic links here: %v", err)
		}
		linksAllowed = true
		t.Cleanup(func() { linksAllowed = false })
	}

	res, err := Link(src, Options{Base: base, Version: "1.8.0"})
	if err != nil {
		t.Skipf("cannot create symbolic links here: %v", err)
	}
	target := filepath.Join(base, SkillName)
	if res.Action != Linked || res.LinkTarget != src || res.Path != target {
		t.Errorf("result = %+v", res)
	}
	if got, err := os.Readlink(target); err != nil || got != src {
		t.Errorf("Readlink = %q, %v", got, err)
	}
	if got := read(t, filepath.Join(target, "references", "x.md")); got != "x" {
		t.Errorf("the link does not show the source: %q", got)
	}
	if exists(filepath.Join(src, MarkerFile)) {
		t.Error("a link must not write a marker into the source folder")
	}

	// Again: already linked, nothing changes.
	if res, err := Link(src, Options{Base: base}); err != nil || res.Action != Linked {
		t.Errorf("second link: %+v, %v", res, err)
	}

	// A link to somewhere else, and an installed copy, are left alone unless forced.
	other := filepath.Join(t.TempDir(), "skills", "md-memo")
	writeSkillFolder(t, other)
	if _, err := Link(other, Options{Base: base}); err == nil {
		t.Error("a link elsewhere must be refused without --force")
	}
	if _, err := Link(other, Options{Base: base, Force: true}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(target); got != other {
		t.Errorf("after --force the link points to %q, want %q", got, other)
	}
	if !exists(filepath.Join(src, "SKILL.md")) {
		t.Error("replacing the link must not touch the folder it pointed to")
	}

	// Install over a link needs --force too, and never follows it.
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.8.0"}); err == nil {
		t.Error("installing a copy over a link must be refused without --force")
	}
	if _, err := Install(skillV1(), Options{Base: base, Version: "1.8.0", Force: true}); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(target); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Errorf("the link was not replaced by a folder: %v %v", fi, err)
	}
	if got := read(t, filepath.Join(other, "SKILL.md")); got != skillMD {
		t.Errorf("the folder the link pointed to was modified: %q", got)
	}
	onlySkillIn(t, base)

	// A copy is refused by Link, replaced with --force.
	if _, err := Link(src, Options{Base: base}); err == nil {
		t.Error("a link over an installed copy must be refused without --force")
	}
	if _, err := Link(src, Options{Base: base, Force: true}); err != nil {
		t.Fatal(err)
	}
	onlySkillIn(t, base)

	// Not the skill: refused.
	empty := t.TempDir()
	if _, err := Link(empty, Options{Base: base}); err == nil {
		t.Error("a folder that is not the skill must be refused")
	}
}
