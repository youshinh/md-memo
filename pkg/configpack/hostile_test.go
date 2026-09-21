package configpack

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateEntryName_Rejects(t *testing.T) {
	bad := []string{
		"", "/", "/etc/passwd", "//server/share/x", "../evil", "a/../../evil", "a/..", "..", ".", "./a", "a/./b", "a//b",
		`C:\Windows\x`, "C:/Windows/x", "c:x", `a\b`, `..\..\evil`, "a\x00b", "a\nb", "a\tb", "a\x7fb",
		"CON", "con.txt", "a/NUL", "a/nul.md", "PRN", "AUX.x", "COM1", "lpt9.txt", "COM²", "a/CONIN$", "a/COM0",
		"a/b.", "a/b ", "a/... ", "a/x:y", "a/x:stream", "a/x*y", "a/<x>", `a/"x"`, "a/x|y", "a/x?y", "\xff\xfe",
		strings.Repeat("a", 513), "a/" + strings.Repeat("b", 256),
	}
	for _, n := range bad {
		if err := ValidateEntryName(n); err == nil {
			t.Errorf("ValidateEntryName(%q) accepted a hostile name", n)
		} else if !bytes.Contains([]byte(err.Error()), []byte("/")) {
			t.Errorf("error for %q is not bilingual: %v", n, err)
		}
	}
}

func TestValidateEntryName_Accepts(t *testing.T) {
	for _, n := range []string{
		"manifest.json", "config/config.json", "skills/skills/foo/SKILL.md", "skills/.claude/skills/foo/a b.md",
		"skills/skills/日本語/メモ.md", "skills/skills/foo/", "a.b.c/d", "skills/skills/foo/.env.example", "COMMON.txt",
		"console/x", "LPT10", "com10", "agents/app.yaml",
	} {
		if err := ValidateEntryName(n); err != nil {
			t.Errorf("ValidateEntryName(%q) = %v, want ok", n, err)
		}
	}
}

func TestOpen_RejectsUnsafeEntryNames(t *testing.T) {
	names := []string{
		"../evil.txt", "skills/skills/foo/../../../evil", "/abs/evil", "C:/evil", `C:\evil`,
		`skills\skills\foo\a.md`, "skills/skills/foo\\..\\..\\evil", "a\x00b", "skills/skills/foo/con.md",
		"skills/skills/foo/a.", "skills/skills/foo/..", "skills//x", "skills/skills/foo/x:y", `..\..\evil`,
		"./evil", "skills/./evil", "skills/skills/foo/NUL",
	}
	for _, n := range names {
		// Neither listed nor extracted, and still fatal: the name alone condemns the pack.
		path := packWith(t, testManifest(), zent{name: n, data: []byte("x")})
		_, err := Open(path)
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("Open with entry %q: error = %v, want ErrUnsafePath", n, err)
		}
	}
}

func TestOpen_ManifestCannotPointOutsideItsRoots(t *testing.T) {
	cases := map[string]Item{
		"name climbs":        {ID: "skill:skills/../../evil", Kind: KindSkill, Root: "skills", Name: "../../evil", Entry: EntryDir},
		"root climbs":        {ID: "skill:../x/evil", Kind: KindSkill, Root: "../x", Name: "evil", Entry: EntryDir},
		"name has slash":     {ID: "skill:skills/a/b", Kind: KindSkill, Root: "skills", Name: "a/b", Entry: EntryDir},
		"name has backslash": {ID: `skill:skills/a\b`, Kind: KindSkill, Root: "skills", Name: `a\b`, Entry: EntryDir},
		"dot name":           {ID: "skill:skills/.git", Kind: KindSkill, Root: "skills", Name: ".git", Entry: EntryDir},
		"device name":        {ID: "skill:skills/con", Kind: KindSkill, Root: "skills", Name: "con", Entry: EntryDir},
		"absolute root":      {ID: "skill:/etc/x", Kind: KindSkill, Root: "/etc", Name: "x", Entry: EntryDir},
		"root not listed":    {ID: "skill:scripts/x", Kind: KindSkill, Root: "scripts", Name: "x", Entry: EntryDir},
		"root wrong case":    {ID: "skill:SKILLS/x", Kind: KindSkill, Root: "SKILLS", Name: "x", Entry: EntryDir},
		"root trailing /":    {ID: "skill:skills//x", Kind: KindSkill, Root: "skills/", Name: "x", Entry: EntryDir},
		"file skill not md":  {ID: "skill:skills/x.sh", Kind: KindSkill, Root: "skills", Name: "x.sh", Entry: EntryFile},
		"unknown entry kind": {ID: "skill:skills/x", Kind: KindSkill, Root: "skills", Name: "x", Entry: "link"},
		"id disagrees":       {ID: "skill:skills/y", Kind: KindSkill, Root: "skills", Name: "x", Entry: EntryDir},
		"agents path":        {ID: IDAgentsApp, Kind: KindAgents, Scope: ScopeApp, Path: "../../evil.yaml"},
		"agents scope":       {ID: IDAgentsApp, Kind: KindAgents, Scope: ScopeProject, Path: AgentsPath(ScopeProject)},
		"agents unknown id":  {ID: "agents:other", Kind: KindAgents, Scope: "other", Path: AgentsPath("other")},
		"config path":        {ID: IDConfig, Kind: KindConfig, Path: "../config.json"},
		"unknown kind":       {ID: "x", Kind: "script", Path: "x"},
	}
	for name, it := range cases {
		path := packWith(t, testManifest(it), zent{name: "x", data: []byte("x")})
		_, err := Open(path)
		if !errors.Is(err, ErrBadManifest) {
			t.Errorf("%s: error = %v, want ErrBadManifest", name, err)
		}
	}
}

func TestOpen_ManifestValidation(t *testing.T) {
	bigPad := append([]byte(`{"format":"md-memo-pack","version":1,"items":[]}`), bytes.Repeat([]byte(" "), MaxManifestBytes)...)
	many := make([]string, maxSections+1)
	for i := range many {
		many[i] = fmt.Sprint("s", i)
	}
	cases := []struct {
		name string
		ents []zent
		want error
	}{
		{"no manifest", []zent{{name: "config/config.json", data: []byte("{}")}}, ErrBadManifest},
		{"not json", []zent{{name: ManifestName, data: []byte("PK not json")}}, ErrBadManifest},
		{"wrong format", []zent{{name: ManifestName, data: []byte(`{"format":"zip","version":1}`)}}, ErrBadManifest},
		{"version 0", []zent{{name: ManifestName, data: []byte(`{"format":"md-memo-pack","version":0}`)}}, ErrBadManifest},
		{"newer version", []zent{{name: ManifestName, data: []byte(`{"format":"md-memo-pack","version":2}`)}}, ErrNewerVersion},
		{"manifest too big", []zent{{name: ManifestName, data: bigPad}}, ErrTooLarge},
		{"too many sections", []zent{{name: ManifestName, data: mustJSON(t, Manifest{Format: Format, Version: 1, ConfigSections: many})}}, ErrBadManifest},
		{"duplicate item ids", []zent{{name: ManifestName, data: mustJSON(t, testManifest(
			Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath}, Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath}))}}, ErrBadManifest},
	}
	for _, c := range cases {
		_, err := Open(writeZipFile(t, c.ents))
		if !errors.Is(err, c.want) {
			t.Errorf("%s: error = %v, want %v", c.name, err, c.want)
		}
	}
}

func TestOpen_NotAZip(t *testing.T) {
	for name, data := range map[string][]byte{
		"empty":     {},
		"text":      []byte("hello, this is not a pack"),
		"json":      []byte(`{"general":{}}`),
		"pk only":   []byte("PK"),
		"truncated": []byte("PK\x03\x04garbage garbage garbage garbage"),
	} {
		if _, err := Open(saveTemp(t, data)); err == nil {
			t.Errorf("%s: Open accepted a non-zip", name)
		}
	}
	if ok, _ := IsZipFile(saveTemp(t, []byte(`{"a":1}`))); ok {
		t.Error("IsZipFile true for JSON")
	}
	zp := writeZipFile(t, []zent{{name: ManifestName, data: []byte("{}")}})
	if ok, err := IsZipFile(zp); err != nil || !ok {
		t.Errorf("IsZipFile(zip) = %v, %v", ok, err)
	}
}

func TestOpen_PackFileTooLarge(t *testing.T) {
	path := packWith(t, testManifest())
	if err := os.Truncate(path, MaxPackBytes+1); err != nil {
		t.Fatal(err)
	}
	_, err := Open(path)
	wantErr(t, err, ErrTooLarge)
}

func manyEntries(t *testing.T, n int) []zent {
	ents := make([]zent, 0, n)
	for i := 0; i < n; i++ {
		ents = append(ents, zent{name: fmt.Sprintf("e%05d", i), store: true})
	}
	return ents
}

func TestOpen_TooManyEntries(t *testing.T) {
	// manifest + 3000 entries = 3001
	path := writeZipFile(t, append([]zent{{name: ManifestName, data: mustJSON(t, testManifest())}}, manyEntries(t, MaxEntries)...))
	_, err := Open(path)
	wantErr(t, err, ErrTooManyEntries)

	// exactly at the limit is fine
	path = writeZipFile(t, append([]zent{{name: ManifestName, data: mustJSON(t, testManifest())}}, manyEntries(t, MaxEntries-1)...))
	p := mustOpen(t, path)
	if p.Ignored != MaxEntries-1 {
		t.Errorf("Ignored = %d, want %d", p.Ignored, MaxEntries-1)
	}
}

// archive/zip only compares entry counts modulo 65536, so an end record claiming 5 entries
// over a directory holding 65541 is accepted by it. Go's own writer would emit zip64 here, so
// the file is patched into the shape an attacker would hand-craft.
func TestOpen_EntryCountWrappingInEndRecord(t *testing.T) {
	real := 65541
	path := writeZipFile(t, append([]zent{{name: ManifestName, data: mustJSON(t, testManifest())}}, manyEntries(t, real-1)...))
	data, _ := os.ReadFile(path)
	eocd := len(data) - 22
	locator := eocd - 20
	if string(data[locator:locator+4]) != "PK\x06\x07" {
		t.Fatal("expected a zip64 locator")
	}
	z64 := int(binary.LittleEndian.Uint64(data[locator+8:]))
	cdSize := binary.LittleEndian.Uint64(data[z64+40:])
	cdOff := binary.LittleEndian.Uint64(data[z64+48:])
	binary.LittleEndian.PutUint16(data[eocd+8:], uint16(real))
	binary.LittleEndian.PutUint16(data[eocd+10:], uint16(real))
	binary.LittleEndian.PutUint32(data[eocd+12:], uint32(cdSize))
	binary.LittleEndian.PutUint32(data[eocd+16:], uint32(cdOff))
	path = saveTemp(t, data)

	// Prove the premise: the standard reader really does accept it.
	f, _ := os.Open(path)
	defer f.Close()
	fi, _ := f.Stat()
	if zr, err := zip.NewReader(f, fi.Size()); err != nil || len(zr.File) != real {
		t.Fatalf("archive/zip did not accept the wrapped count: %v", err)
	}
	if err := precheckZip(f, fi.Size()); err != nil {
		t.Fatalf("premise: the pre-check alone should let this through (it claims 5 entries): %v", err)
	}
	_, err := Open(path)
	wantErr(t, err, ErrTooManyEntries)
}

func TestOpen_CentralDirectoryTooBigForItsEntryCount(t *testing.T) {
	// A few dozen entries with enormous names: a small entry count, a huge directory.
	ents := []zent{{name: ManifestName, data: mustJSON(t, testManifest())}}
	for i := 0; i < 80; i++ {
		ents = append(ents, zent{name: fmt.Sprintf("%05d", i) + strings.Repeat("n", 60000), store: true})
	}
	path := writeZipFile(t, ents)
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, _ := f.Stat()
	// Directly, so the assertion is about the pre-check and not about the name length rule
	// that would reject the same pack a moment later.
	wantErr(t, precheckZip(f, fi.Size()), ErrTooManyEntries)
	_, err = Open(path)
	wantErr(t, err, ErrTooManyEntries)
}

func TestPrecheck_BadEndRecords(t *testing.T) {
	good := packWith(t, testManifest())
	data, _ := os.ReadFile(good)
	eocd := len(data) - 22
	if string(data[eocd:eocd+4]) != "PK\x05\x06" {
		t.Fatal("test assumes a comment-less end record")
	}
	patch := func(f func(b []byte)) string {
		b := append([]byte{}, data...)
		f(b)
		return saveTemp(t, b)
	}
	cases := map[string]string{
		"zip64 count":       patch(func(b []byte) { b[eocd+10], b[eocd+11] = 0xFF, 0xFF }),
		"zip64 offset":      patch(func(b []byte) { copy(b[eocd+16:], []byte{0xFF, 0xFF, 0xFF, 0xFF}) }),
		"offset past eocd":  patch(func(b []byte) { copy(b[eocd+16:], []byte{0xFF, 0xFF, 0xFF, 0x7F}) }),
		"comment too long":  patch(func(b []byte) { b[eocd+20], b[eocd+21] = 0x10, 0x00 }),
		"huge directory":    patch(func(b []byte) { copy(b[eocd+12:], []byte{0x00, 0x00, 0x00, 0x10}) }),
		"count over limit":  patch(func(b []byte) { b[eocd+10], b[eocd+11] = 0xB9, 0x0B }), // 3001
		"signature removed": patch(func(b []byte) { b[eocd+2] = 0 }),
	}
	for name, path := range cases {
		if _, err := Open(path); err == nil {
			t.Errorf("%s: Open accepted a corrupt end record", name)
		}
	}
}

func repeatBytes(n int) []byte { return make([]byte, n) }

func TestOpen_DeclaredSizesOverLimits(t *testing.T) {
	t.Run("one entry over the per-entry cap", func(t *testing.T) {
		path := packWith(t, testManifest(skillItem("skills", "big", EntryDir)),
			zent{name: "skills/skills/big/blob.bin", data: repeatBytes(MaxEntryBytes + 1)})
		_, err := Open(path)
		wantErr(t, err, ErrTooLarge)
	})
	t.Run("entries that only exceed the cap together", func(t *testing.T) {
		ents := make([]zent, 0, 11)
		for i := 0; i < 11; i++ {
			ents = append(ents, zent{name: fmt.Sprintf("skills/skills/bomb/f%02d.bin", i), data: repeatBytes(MaxEntryBytes)})
		}
		_, err := Open(packWith(t, testManifest(skillItem("skills", "bomb", EntryDir)), ents...))
		wantErr(t, err, ErrTooLarge)
	})
	t.Run("config over its cap", func(t *testing.T) {
		big := append([]byte(`{"a":"`), append(bytes.Repeat([]byte("x"), MaxConfigBytes), []byte(`"}`)...)...)
		m := testManifest(Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath})
		_, err := Open(packWith(t, m, zent{name: ConfigPath, data: big}))
		wantErr(t, err, ErrTooLarge)
	})
	t.Run("agents over its cap", func(t *testing.T) {
		m := testManifest(Item{ID: IDAgentsApp, Kind: KindAgents, Scope: ScopeApp, Path: AgentsPath(ScopeApp)})
		_, err := Open(packWith(t, m, zent{name: AgentsPath(ScopeApp), data: repeatBytes(MaxAgentsBytes + 1)}))
		wantErr(t, err, ErrTooLarge)
	})
	t.Run("unlisted bulk is never read", func(t *testing.T) {
		// Not part of any item, so it costs nothing and is only counted as ignored.
		p := mustOpen(t, packWith(t, testManifest(), zent{name: "junk/huge.bin", data: repeatBytes(MaxTotalBytes)}))
		if p.Ignored != 1 {
			t.Errorf("Ignored = %d, want 1", p.Ignored)
		}
	})
}

// The declared size in a zip header is attacker-controlled. What matters is what actually
// comes out of the decompressor.
func TestRead_HeaderThatUnderstatesTheContent(t *testing.T) {
	comp, crc := deflatedZeros(t, 20<<20)

	t.Run("config", func(t *testing.T) {
		m := testManifest(Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath})
		p := mustOpen(t, writeRawZip(t, m, rawEntry{name: ConfigPath, method: zip.Deflate, comp: comp, crc: crc, declaredSize: 100}))
		if _, err := p.ReadConfig(); err == nil {
			t.Fatal("ReadConfig accepted 20 MB behind a 100 byte header")
		}
	})
	t.Run("skill file", func(t *testing.T) {
		m := testManifest(skillItem("skills", "liar", EntryDir))
		p := mustOpen(t, writeRawZip(t, m, rawEntry{name: "skills/skills/liar/a.bin", method: zip.Deflate, comp: comp, crc: crc, declaredSize: 1024}))
		dest := t.TempDir()
		if _, _, err := p.ExtractSkill(SkillID("skills", "liar"), dest); err == nil {
			t.Fatal("ExtractSkill accepted 20 MB behind a 1 KB header")
		}
		if fi, err := os.Stat(filepath.Join(dest, "liar", "a.bin")); err == nil && fi.Size() > 1024 {
			t.Errorf("wrote %d bytes past the declared 1024", fi.Size())
		}
	})
	t.Run("header within the cap but content over it", func(t *testing.T) {
		m := testManifest(skillItem("skills", "liar", EntryDir))
		p := mustOpen(t, writeRawZip(t, m, rawEntry{name: "skills/skills/liar/a.bin", method: zip.Deflate, comp: comp, crc: crc, declaredSize: MaxEntryBytes}))
		dest := t.TempDir()
		if _, _, err := p.ExtractSkill(SkillID("skills", "liar"), dest); err == nil {
			t.Fatal("ExtractSkill accepted 20 MB behind a 10 MB header")
		}
		if fi, err := os.Stat(filepath.Join(dest, "liar", "a.bin")); err == nil && fi.Size() > MaxEntryBytes {
			t.Errorf("wrote %d bytes, more than the per-entry cap", fi.Size())
		}
	})
}

func TestExtract_TotalBudgetIsShared(t *testing.T) {
	m := testManifest(skillItem("skills", "s", EntryDir))
	p := mustOpen(t, packWith(t, m, zent{name: "skills/skills/s/a.txt", data: []byte("0123456789")}))
	p.budget = 5
	if _, _, err := p.ExtractSkill(SkillID("skills", "s"), t.TempDir()); err == nil {
		t.Fatal("extraction ignored the remaining byte budget")
	}
}

func TestOpen_RejectsEntriesThatAreNotPlainFiles(t *testing.T) {
	for name, mode := range map[string]fs.FileMode{
		"symlink": fs.ModeSymlink | 0o777,
		"device":  fs.ModeDevice | 0o666,
		"pipe":    fs.ModeNamedPipe | 0o666,
		"socket":  fs.ModeSocket | 0o666,
		"dir bit": fs.ModeDir | 0o755,
	} {
		m := testManifest(skillItem("skills", "evil", EntryDir))
		_, err := Open(packWith(t, m, zent{name: "skills/skills/evil/link", data: []byte("../../../../etc/passwd"), mode: mode}))
		if !errors.Is(err, ErrBadEntry) {
			t.Errorf("%s: error = %v, want ErrBadEntry", name, err)
		}
	}
}

func TestOpen_RejectsEncryptedAndExoticCompression(t *testing.T) {
	m := testManifest(skillItem("skills", "s", EntryDir))
	_, err := Open(packWith(t, m, zent{name: "skills/skills/s/a.txt", data: []byte("x"), flags: 0x1}))
	wantErr(t, err, ErrBadEntry)

	_, err = Open(writeRawZip(t, m, rawEntry{name: "skills/skills/s/a.txt", method: 99, comp: []byte("x"), declaredSize: 1}))
	wantErr(t, err, ErrBadEntry)
}

func TestOpen_RejectsDuplicateNames(t *testing.T) {
	m := mustJSON(t, testManifest())
	for name, ents := range map[string][]zent{
		"same name twice":        {{name: ManifestName, data: m}, {name: "a/b", data: []byte("1")}, {name: "a/b", data: []byte("2")}},
		"differs by case":        {{name: ManifestName, data: m}, {name: "config/config.json", data: []byte("1")}, {name: "Config/Config.json", data: []byte("2")}},
		"file and folder":        {{name: ManifestName, data: m}, {name: "a", data: []byte("1")}, {name: "a/", data: nil}},
		"second manifest":        {{name: ManifestName, data: m}, {name: ManifestName, data: []byte(`{"format":"md-memo-pack","version":1,"items":[]}`)}},
		"manifest in wrong case": {{name: ManifestName, data: m}, {name: "MANIFEST.json", data: m}},
	} {
		if _, err := Open(writeZipFile(t, ents)); !errors.Is(err, ErrDuplicate) {
			t.Errorf("%s: error = %v, want ErrDuplicate", name, err)
		}
	}
}

func TestOpen_ListedEntriesMustExist(t *testing.T) {
	for name, m := range map[string]Manifest{
		"config":                     testManifest(Item{ID: IDConfig, Kind: KindConfig, Path: ConfigPath}),
		"agents":                     testManifest(Item{ID: IDAgentsProject, Kind: KindAgents, Scope: ScopeProject, Path: AgentsPath(ScopeProject)}),
		"skill":                      testManifest(skillItem("skills", "ghost", EntryDir)),
		"file":                       testManifest(skillItem("skills", "ghost.md", EntryFile)),
		"only .env inside the skill": testManifest(skillItem("skills", "envonly", EntryDir)),
	} {
		_, err := Open(packWith(t, m, zent{name: "skills/skills/envonly/.env", data: []byte("KEY=1")}))
		if !errors.Is(err, ErrBadEntry) {
			t.Errorf("%s: error = %v, want ErrBadEntry", name, err)
		}
	}
}

func TestOpen_UnlistedEntriesAreIgnored(t *testing.T) {
	m := testManifest(skillItem("skills", "foo", EntryDir))
	path := packWith(t, m,
		zent{name: "skills/skills/foo/SKILL.md", data: []byte("listed")},
		zent{name: "skills/skills/other/SKILL.md", data: []byte("unlisted skill")},
		zent{name: "skills/.claude/skills/foo/SKILL.md", data: []byte("same name, other root")},
		zent{name: "skills/skills/foo.md", data: []byte("file skill sharing the folder's name")},
		zent{name: "agents/app.yaml", data: []byte("unlisted agents")},
		zent{name: "config/config.json", data: []byte(`{"unlisted":true}`)},
		zent{name: "notes/readme.txt", data: []byte("stray")},
	)
	p := mustOpen(t, path)
	if p.Ignored != 6 {
		t.Errorf("Ignored = %d, want 6", p.Ignored)
	}
	if cfg, err := p.ReadConfig(); err != nil || cfg != nil {
		t.Errorf("ReadConfig = %q, %v; an unlisted config must not be readable", cfg, err)
	}
	if _, _, err := p.ReadAgents(IDAgentsApp); err == nil {
		t.Error("ReadAgents returned an unlisted agents file")
	}
	dest := t.TempDir()
	if _, _, err := p.ExtractSkill(SkillID("skills", "foo"), dest); err != nil {
		t.Fatal(err)
	}
	var got []string
	_ = filepath.WalkDir(dest, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dest, p)
			got = append(got, filepath.ToSlash(rel))
		}
		return nil
	})
	if len(got) != 1 || got[0] != "foo/SKILL.md" {
		t.Errorf("extracted %v, want only foo/SKILL.md", got)
	}
}

func TestOpen_SkipsEnvFilesAndGitFolders(t *testing.T) {
	m := testManifest(skillItem("skills", "s", EntryDir))
	p := mustOpen(t, packWith(t, m,
		zent{name: "skills/skills/s/SKILL.md", data: []byte("ok")},
		zent{name: "skills/skills/s/.env", data: []byte("SECRET=1")},
		zent{name: "skills/skills/s/sub/.env.local", data: []byte("SECRET=2")},
		zent{name: "skills/skills/s/.env.example", data: []byte("SECRET=")},
		zent{name: "skills/skills/s/.git/hooks/pre-commit", data: []byte("#!/bin/sh")},
		zent{name: "skills/skills/s/node_modules/x/index.js", data: []byte("x")},
		zent{name: "skills/skills/s/__pycache__/a.pyc", data: []byte("x")},
		zent{name: "skills/skills/s/.DS_Store", data: []byte("x")},
	))
	if p.Skipped != 6 {
		t.Errorf("Skipped = %d, want 6", p.Skipped)
	}
	if p.Ignored != 0 {
		t.Errorf("Ignored = %d; skipped files must not be counted twice", p.Ignored)
	}
	dest := t.TempDir()
	files, _, err := p.ExtractSkill(SkillID("skills", "s"), dest)
	if err != nil || files != 2 {
		t.Fatalf("ExtractSkill = %d files, %v; want 2 (SKILL.md and .env.example)", files, err)
	}
	for _, gone := range []string{".env", "sub/.env.local", ".git", "node_modules", "__pycache__", ".DS_Store"} {
		if _, err := os.Lstat(filepath.Join(dest, "s", filepath.FromSlash(gone))); err == nil {
			t.Errorf("%s was extracted", gone)
		}
	}
}

func TestExtract_StaysInsideDestination(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "stage")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	m := testManifest(skillItem("skills", "s", EntryDir), skillItem("skills", "n.md", EntryFile))
	p := mustOpen(t, packWith(t, m,
		zent{name: "skills/skills/s/a/b/c.txt", data: []byte("deep")},
		zent{name: "skills/skills/s/top.txt", data: []byte("top")},
		zent{name: "skills/skills/n.md", data: []byte("file skill")},
	))
	for _, id := range []string{SkillID("skills", "s"), SkillID("skills", "n.md")} {
		if _, _, err := p.ExtractSkill(id, dest); err != nil {
			t.Fatal(err)
		}
	}
	_ = filepath.WalkDir(base, func(path string, d fs.DirEntry, err error) error {
		if err == nil && path != base && path != dest && !strings.HasPrefix(path, dest+string(filepath.Separator)) {
			t.Errorf("wrote outside the stage folder: %s", path)
		}
		return nil
	})
	if b, _ := os.ReadFile(filepath.Join(dest, "n.md")); string(b) != "file skill" {
		t.Errorf("file skill content = %q", b)
	}
}

// Defence in depth: even if a name got past ValidateEntryName, os.Root refuses to follow a
// link that leaves the extraction folder.
func TestExtract_DoesNotFollowLinksOutOfDestination(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "stage")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{dest, outside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(dest, "s")); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	for name, entry := range map[string]string{"direct file": "skills/skills/s/pwned.txt", "nested file": "skills/skills/s/d/pwned.txt"} {
		m := testManifest(skillItem("skills", "s", EntryDir))
		p := mustOpen(t, packWith(t, m, zent{name: entry, data: []byte("x")}))
		if _, _, err := p.ExtractSkill(SkillID("skills", "s"), dest); err == nil {
			t.Errorf("%s: extraction through a link to an outside folder succeeded", name)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("files landed outside the destination: %v", entries)
	}
}

func TestExtract_RefusesToOverwrite(t *testing.T) {
	m := testManifest(skillItem("skills", "s", EntryDir))
	p := mustOpen(t, packWith(t, m, zent{name: "skills/skills/s/a.txt", data: []byte("new")}))
	dest := t.TempDir()
	writeTree(t, dest, map[string]string{"s/a.txt": "existing"})
	if _, _, err := p.ExtractSkill(SkillID("skills", "s"), dest); err == nil {
		t.Error("ExtractSkill overwrote an existing file; the caller must hand it an empty folder")
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "s", "a.txt")); string(b) != "existing" {
		t.Errorf("existing file changed to %q", b)
	}
}
