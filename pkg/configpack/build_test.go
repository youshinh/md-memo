package configpack

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
)

func buildToFile(t *testing.T, in Input) (string, Result) {
	t.Helper()
	var buf bytes.Buffer
	res, err := Build(&buf, in)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return saveTemp(t, buf.Bytes()), res
}

func TestRoundTrip(t *testing.T) {
	proj := t.TempDir()
	// project-relative path -> content
	tree := map[string]string{
		"skills/alpha/SKILL.md":         "# alpha\n日本語のスキル\n",
		"skills/alpha/ref/notes.txt":    "notes",
		"skills/alpha/ref/deep/x.json":  `{"a":1}`,
		"skills/beta.md":                "beta as a single file",
		".claude/skills/gamma/SKILL.md": "gamma",
		".gemini/skills/delta/SKILL.md": "delta",
		".codex/skills/eps/SKILL.md":    "eps",
	}
	// where each of those lands under a stage folder
	staged := map[string]string{
		"alpha/SKILL.md":        tree["skills/alpha/SKILL.md"],
		"alpha/ref/notes.txt":   "notes",
		"alpha/ref/deep/x.json": `{"a":1}`,
		"beta.md":               "beta as a single file",
		"gamma/SKILL.md":        "gamma",
		"delta/SKILL.md":        "delta",
		"eps/SKILL.md":          "eps",
	}
	writeTree(t, proj, tree)
	writeTree(t, proj, map[string]string{"skills/alpha/.env": "SECRET=never packed"})
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(filepath.Join(proj, "skills", "alpha", "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		staged["alpha/run.sh"] = "#!/bin/sh\n"
	}
	skills, warns := DiscoverSkills(proj)
	if len(skills) != 5 || len(warns) != 0 {
		t.Fatalf("discovered %v, warnings %v", skillIDs(skills), warns)
	}

	cfg := []byte("{\n  \"general\": {\"theme\": \"dark\"},\n  \"shortcuts\": {\"save\": \"Ctrl+S\"}\n}\n")
	appAgents := []byte("version: 2\n# app level\nagents:\n  a:\n    command: x\n")
	projAgents := []byte("version: 2\nagents:\n  p:\n    command: y\n")
	path, res := buildToFile(t, Input{
		AppVersion:     "1.5.5",
		CreatedAt:      fixedTime,
		ConfigSections: []string{"general", "shortcuts", "general", ""},
		Config:         cfg,
		Agents:         []AgentsInput{{Scope: ScopeApp, OrigName: "agents.md", Data: appAgents}, {Scope: ScopeProject, OrigName: "AGENTS.YML", Data: projAgents}},
		Skills:         skills,
	})

	wantFiles, wantBytes := 3+len(staged), int64(len(cfg)+len(appAgents)+len(projAgents))
	for _, c := range staged {
		wantBytes += int64(len(c))
	}
	if res.Files != wantFiles || res.Bytes != wantBytes {
		t.Errorf("result = %d files / %d bytes, want %d / %d", res.Files, res.Bytes, wantFiles, wantBytes)
	}

	p := mustOpen(t, path)
	m := p.Manifest
	if m.Format != Format || m.Version != 1 || m.AppVersion != "1.5.5" || m.IncludesSecrets || m.CreatedAt != "2026-09-21T10:00:00Z" {
		t.Errorf("manifest header = %+v", m)
	}
	if len(m.ConfigSections) != 2 || m.ConfigSections[0] != "general" || m.ConfigSections[1] != "shortcuts" {
		t.Errorf("configSections = %v", m.ConfigSections)
	}
	var ids []string
	for _, it := range m.Items {
		ids = append(ids, it.ID)
	}
	wantIDs := []string{"config", "agents:app", "agents:project", "skill:skills/alpha", "skill:skills/beta.md", "skill:.claude/skills/gamma", "skill:.gemini/skills/delta", "skill:.codex/skills/eps"}
	if len(ids) != len(wantIDs) {
		t.Fatalf("item ids = %v", ids)
	}
	for i := range ids {
		if ids[i] != wantIDs[i] {
			t.Fatalf("item ids = %v, want %v", ids, wantIDs)
		}
	}
	if it := m.Item("agents:app"); it.OrigName != "agents.md" || it.Path != "agents/app.yaml" || it.Bytes != int64(len(appAgents)) {
		t.Errorf("agents:app = %+v", it)
	}
	if it := m.Item("agents:project"); it.OrigName != "agents.yml" {
		t.Errorf("origName is normalised to one of the four known names: %+v", it)
	}

	if got, err := p.ReadConfig(); err != nil || !bytes.Equal(got, cfg) {
		t.Errorf("ReadConfig = %q, %v", got, err)
	}
	if d, ext, err := p.ReadAgents("agents:app"); err != nil || ext != ".md" || !bytes.Equal(d, appAgents) {
		t.Errorf("ReadAgents(app) = %q, %q, %v", d, ext, err)
	}
	if d, ext, err := p.ReadAgents("agents:project"); err != nil || ext != ".yml" || !bytes.Equal(d, projAgents) {
		t.Errorf("ReadAgents(project) = %q, %q, %v", d, ext, err)
	}

	// The names are distinct, so all five skills can share one stage folder here.
	stage := t.TempDir()
	for _, s := range skills {
		files, _, err := p.ExtractSkill(s.ID, stage)
		if err != nil {
			t.Fatalf("ExtractSkill(%s): %v", s.ID, err)
		}
		if sf, _, ok := p.SkillStats(s.ID); !ok || sf != files || files != s.Files {
			t.Errorf("%s: extracted %d, stats %d/%v, discovered %d", s.ID, files, sf, ok, s.Files)
		}
	}
	got := map[string]string{}
	_ = filepath.WalkDir(stage, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(stage, path)
			b, _ := os.ReadFile(path)
			got[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	if len(got) != len(staged) {
		t.Errorf("extracted %d files, want %d (%v)", len(got), len(staged), sortedKeys(got))
	}
	for rel, want := range staged {
		if got[rel] != want {
			t.Errorf("%s = %q, want %q", rel, got[rel], want)
		}
	}
	if _, ok := got["alpha/.env"]; ok {
		t.Error(".env was packed and restored")
	}
	if runtime.GOOS != "windows" {
		if fi, err := os.Stat(filepath.Join(stage, "alpha", "run.sh")); err != nil || fi.Mode()&0o111 == 0 {
			t.Errorf("exec bit lost: %v %v", fi, err)
		}
		if fi, err := os.Stat(filepath.Join(stage, "alpha", "SKILL.md")); err != nil || fi.Mode().Perm() != 0o644 {
			t.Errorf("SKILL.md mode: %v %v", fi, err)
		}
	}
}

// Non-ASCII names need the zip UTF-8 flag; a reader that guessed Shift_JIS would mangle them,
// and the name check would then refuse the whole pack.
func TestRoundTrip_JapaneseNames(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{
		"skills/日本語スキル/メモ.md":             "本文",
		"skills/日本語スキル/資料/一覧 表.txt":       "表",
		"skills/単体ファイル.md":                "単体",
		".claude/skills/ｶﾀｶﾅ ﾌﾙ/SKILL.md": "半角",
	})
	skills, warns := DiscoverSkills(proj)
	if len(skills) != 3 || len(warns) != 0 {
		t.Fatalf("discovered %v, warnings %v", skillIDs(skills), warns)
	}
	path, _ := buildToFile(t, Input{CreatedAt: fixedTime, Skills: skills})
	p := mustOpen(t, path)
	stage := t.TempDir()
	for _, s := range skills {
		if _, _, err := p.ExtractSkill(s.ID, stage); err != nil {
			t.Fatalf("%s: %v", s.ID, err)
		}
	}
	for rel, want := range map[string]string{
		"日本語スキル/メモ.md":       "本文",
		"日本語スキル/資料/一覧 表.txt": "表",
		"単体ファイル.md":          "単体",
		"ｶﾀｶﾅ ﾌﾙ/SKILL.md":   "半角",
	} {
		if b, err := os.ReadFile(filepath.Join(stage, filepath.FromSlash(rel))); err != nil || string(b) != want {
			t.Errorf("%s = %q, %v", rel, b, err)
		}
	}
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestBuild_ManifestJSONKeys(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{"skills/foo/SKILL.md": "x", "skills/bar.md": "y"})
	skills, _ := DiscoverSkills(proj)
	path, _ := buildToFile(t, Input{
		AppVersion: "1.5.5", CreatedAt: fixedTime, Config: []byte("{}"),
		Agents: []AgentsInput{{Scope: ScopeApp, OrigName: "agents.yaml", Data: []byte("a")}},
		Skills: skills,
	})
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var raw []byte
	for _, f := range zr.File {
		if f.Name == ManifestName {
			rc, _ := f.Open()
			raw, _ = io.ReadAll(rc)
			rc.Close()
		}
	}
	got := map[string]any{}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"format", "version", "createdAt", "appVersion", "includesSecrets", "configSections", "items"} {
		if _, ok := got[k]; !ok {
			t.Errorf("manifest lacks %q", k)
		}
	}
	if s, ok := got["configSections"].([]any); !ok || len(s) != 0 {
		t.Errorf("configSections = %#v, want an empty array (not null)", got["configSections"])
	}
	wantKeys := map[string][]string{
		"config": {"id", "kind", "path", "bytes"},
		"agents": {"id", "kind", "scope", "path", "origName", "bytes"},
		"skill":  {"id", "kind", "root", "name", "entry", "files", "bytes"},
	}
	for _, it := range got["items"].([]any) {
		m := it.(map[string]any)
		want := wantKeys[m["kind"].(string)]
		if len(m) != len(want) {
			t.Errorf("%v item has %d keys, want exactly %v: %v", m["kind"], len(m), want, m)
		}
		for _, k := range want {
			if _, ok := m[k]; !ok {
				t.Errorf("%v item lacks %q", m["kind"], k)
			}
		}
	}
}

func TestBuild_RejectsBadInput(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{"skills/foo/SKILL.md": "x"})
	skills, _ := DiscoverSkills(proj)
	bigCfg := append([]byte(`{"a":"`), append(bytes.Repeat([]byte("x"), MaxConfigBytes), []byte(`"}`)...)...)
	cases := map[string]Input{
		"config not an object":    {Config: []byte(`[1,2]`)},
		"config not json":         {Config: []byte(`nope`)},
		"config over cap":         {Config: bigCfg},
		"agents scope":            {Agents: []AgentsInput{{Scope: "team", Data: []byte("x")}}},
		"agents over cap":         {Agents: []AgentsInput{{Scope: ScopeApp, Data: make([]byte, MaxAgentsBytes+1)}}},
		"skill root not allowed":  {Skills: []Skill{{Root: "etc", Name: "foo", Entry: EntryDir, Path: skills[0].Path}}},
		"skill name climbs":       {Skills: []Skill{{Root: "skills", Name: "../foo", Entry: EntryDir, Path: skills[0].Path}}},
		"skill folder is missing": {Skills: []Skill{{Root: "skills", Name: "gone", Entry: EntryDir, Path: filepath.Join(proj, "skills", "gone")}}},
		"file skill is a folder":  {Skills: []Skill{{Root: "skills", Name: "foo.md", Entry: EntryFile, Path: skills[0].Path}}},
	}
	for name, in := range cases {
		in.CreatedAt = fixedTime
		if _, err := Build(io.Discard, in); err == nil {
			t.Errorf("%s: Build succeeded", name)
		}
	}
}

// Discovery is a snapshot; Build must look at the tree again.
func TestBuild_RereadsTheTreeInsteadOfTrustingDiscovery(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{"skills/foo/SKILL.md": "x", "skills/foo/data.bin": "y"})
	skills, _ := DiscoverSkills(proj)
	data := filepath.Join(proj, "skills", "foo", "data.bin")

	f, _ := os.OpenFile(data, os.O_WRONLY, 0)
	if err := f.Truncate(MaxEntryBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := Build(io.Discard, Input{CreatedAt: fixedTime, Skills: skills}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a file that grew past the cap after discovery: error = %v, want ErrTooLarge", err)
	}

	if err := os.Remove(data); err != nil {
		t.Fatal(err)
	}
	res, err := Build(io.Discard, Input{CreatedAt: fixedTime, Skills: skills})
	if err != nil || res.Files != 1 {
		t.Errorf("a file that vanished: %d files, %v; want the remaining one", res.Files, err)
	}

	secret := filepath.Join(t.TempDir(), "secret.txt")
	_ = os.WriteFile(secret, []byte("private"), 0o644)
	if err := os.Symlink(secret, data); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	var buf bytes.Buffer
	res, err = Build(&buf, Input{CreatedAt: fixedTime, Skills: skills})
	if err != nil || res.Files != 1 || bytes.Contains(buf.Bytes(), []byte("private")) {
		t.Errorf("a file replaced by a link was followed: %d files, %v", res.Files, err)
	}

	// and the last-moment check between listing a file and opening it
	b := &builder{zw: zip.NewWriter(io.Discard), maxEntries: 10}
	if _, err := b.addFile("skills/skills/foo/data.bin", skillFile{abs: data}); err == nil {
		t.Error("addFile followed a symlink")
	}
}

func TestBuilder_Limits(t *testing.T) {
	b := &builder{zw: zip.NewWriter(io.Discard), maxEntries: 3}
	for _, n := range []string{"a", "b", "c"} {
		if _, err := b.add(n, fixedTime, 0o644, bytes.NewReader(nil), 10); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.add("d", fixedTime, 0o644, bytes.NewReader(nil), 10); !errors.Is(err, ErrTooManyEntries) {
		t.Errorf("fourth entry: %v", err)
	}
	b.maxEntries = 10
	if _, err := b.add("e", fixedTime, 0o644, bytes.NewReader([]byte("12345678901")), 10); !errors.Is(err, ErrTooLarge) {
		t.Errorf("entry over its own limit: %v", err)
	}
	if _, err := b.add("../x", fixedTime, 0o644, bytes.NewReader(nil), 10); !errors.Is(err, ErrUnsafePath) {
		t.Errorf("Build would write an unsafe name: %v", err)
	}
	b = &builder{zw: zip.NewWriter(io.Discard), maxEntries: 10, bytes: MaxTotalBytes}
	if _, err := b.add("f", fixedTime, 0o644, bytes.NewReader([]byte("x")), 10); !errors.Is(err, ErrTooLarge) {
		t.Errorf("total over the cap: %v", err)
	}
}

func TestBuild_PackSizeIsCapped(t *testing.T) {
	cw := &capWriter{w: io.Discard, left: 10}
	if _, err := cw.Write(make([]byte, 6)); err != nil {
		t.Fatal(err)
	}
	if _, err := cw.Write(make([]byte, 5)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("write past the cap: %v", err)
	}

	// end to end: incompressible data that cannot fit in 50 MB
	proj := t.TempDir()
	rng := rand.New(rand.NewSource(1))
	chunk := make([]byte, 9<<20)
	for i := 0; i < 6; i++ {
		rng.Read(chunk)
		p := filepath.Join(proj, "skills", "big", string(rune('a'+i))+".bin")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, chunk, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	skills, warns := DiscoverSkills(proj)
	if len(skills) != 1 {
		t.Fatalf("discovery: %v %v", skills, warns)
	}
	var counted countingWriter
	if _, err := Build(&counted, Input{CreatedAt: fixedTime, Skills: skills}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Build = %v, want ErrTooLarge", err)
	}
	if counted.n > MaxPackBytes {
		t.Errorf("wrote %d bytes, over the %d cap", counted.n, MaxPackBytes)
	}
}

type countingWriter struct{ n int64 }

func (c *countingWriter) Write(p []byte) (int, error) { c.n += int64(len(p)); return len(p), nil }

func TestOpen_RejectsNonRegularPaths(t *testing.T) {
	if _, err := Open(t.TempDir()); err == nil {
		t.Error("Open accepted a directory")
	}
	if _, err := Open(filepath.Join(t.TempDir(), "missing.mdmemopack")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing file: %v", err)
	}
}
