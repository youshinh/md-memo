package configpack

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func skillIDs(sk []Skill) []string {
	ids := make([]string, len(sk))
	for i, s := range sk {
		ids[i] = s.ID
	}
	return ids
}

func TestDiscoverSkills_FourRootsAndMarkdownFiles(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{
		"skills/alpha/SKILL.md":         "a",
		"skills/alpha/ref/notes.txt":    "nn",
		"skills/beta.md":                "bbb",
		"skills/notmd.txt":              "ignored: not a folder, not markdown",
		".claude/skills/gamma/SKILL.md": "g",
		".gemini/skills/delta/SKILL.md": "d",
		".codex/skills/eps/SKILL.md":    "e",
		"other/skills/zeta/SKILL.md":    "not under a skill root",
		".hidden/skills/eta/SKILL.md":   "not under a skill root",
	})
	got, warns := DiscoverSkills(proj)
	if len(warns) != 0 {
		t.Errorf("unexpected warnings: %v", warns)
	}
	want := []string{"skill:skills/alpha", "skill:skills/beta.md", "skill:.claude/skills/gamma", "skill:.gemini/skills/delta", "skill:.codex/skills/eps"}
	if fmt.Sprint(skillIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("skills = %v, want %v", skillIDs(got), want)
	}
	alpha, beta := got[0], got[1]
	if alpha.Entry != EntryDir || alpha.Files != 2 || alpha.Bytes != 3 || alpha.Root != "skills" || alpha.Name != "alpha" {
		t.Errorf("alpha = %+v", alpha)
	}
	if beta.Entry != EntryFile || beta.Files != 1 || beta.Bytes != 3 || beta.Name != "beta.md" {
		t.Errorf("beta = %+v", beta)
	}
	if alpha.Path != filepath.Join(proj, "skills", "alpha") {
		t.Errorf("alpha.Path = %q", alpha.Path)
	}
}

func TestDiscoverSkills_NothingWithoutAProjectOrRoots(t *testing.T) {
	if got, w := DiscoverSkills(""); got != nil || w != nil {
		t.Errorf("empty root: %v %v", got, w)
	}
	if got, _ := DiscoverSkills(t.TempDir()); len(got) != 0 {
		t.Errorf("project without skill roots: %v", got)
	}
	if got, _ := DiscoverSkills(filepath.Join(t.TempDir(), "missing")); len(got) != 0 {
		t.Errorf("missing project: %v", got)
	}
	// a file where a root should be
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{"skills": "i am a file"})
	if got, _ := DiscoverSkills(proj); len(got) != 0 {
		t.Errorf("file in place of a root: %v", got)
	}
}

func TestDiscoverSkills_SkipRules(t *testing.T) {
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{
		"skills/.hidden/SKILL.md":            "x",
		"skills/node_modules/x/SKILL.md":     "x",
		"skills/__pycache__/a.pyc":           "x",
		"skills/.DS_Store":                   "x",
		"skills/.hidden.md":                  "x",
		"skills/real/SKILL.md":               "ok",
		"skills/real/.env":                   "SECRET=1",
		"skills/real/sub/.env.production":    "SECRET=2",
		"skills/real/.env.example":           "SECRET=",
		"skills/real/.git/config":            "x",
		"skills/real/node_modules/m.js":      "x",
		"skills/real/sub/__pycache__/m.pyc":  "x",
		"skills/real/Thumbs.db":              "x",
		"skills/real/.DS_Store":              "x",
		"skills/onlyenv/.env":                "SECRET=3",
		"skills/emptyfolder/keep/.gitkeep.x": "",
	})
	if err := os.MkdirAll(filepath.Join(proj, "skills", "emptydir"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, warns := DiscoverSkills(proj)
	if fmt.Sprint(skillIDs(got)) != "[skill:skills/emptyfolder skill:skills/real]" {
		t.Fatalf("skills = %v", skillIDs(got))
	}
	for _, s := range got {
		if s.Name == "real" && s.Files != 2 {
			t.Errorf("real has %d files, want SKILL.md and .env.example only", s.Files)
		}
	}
	// a folder with nothing packageable is reported, not silently listed as an empty skill
	var mentioned []string
	for _, w := range warns {
		for _, n := range []string{"onlyenv", "emptydir"} {
			if strings.Contains(w, "skills/"+n) {
				mentioned = append(mentioned, n)
			}
		}
	}
	if len(mentioned) != 2 {
		t.Errorf("warnings %v should name onlyenv and emptydir", warns)
	}
}

func TestDiscoverSkills_LinksAreNeverFollowed(t *testing.T) {
	proj := t.TempDir()
	outside := t.TempDir()
	writeTree(t, outside, map[string]string{"secret/SKILL.md": "outside the project"})
	writeTree(t, proj, map[string]string{"skills/real/SKILL.md": "ok", "skills/real/data.txt": "d"})

	links := map[string]string{
		filepath.Join(proj, "skills", "linked"):          filepath.Join(outside, "secret"),
		filepath.Join(proj, "skills", "real", "escape"):  outside,
		filepath.Join(proj, ".claude", "skills"):         filepath.Join(proj, "skills"),
		filepath.Join(proj, "skills", "real", "file.md"): filepath.Join(outside, "secret", "SKILL.md"),
	}
	_ = os.MkdirAll(filepath.Join(proj, ".claude"), 0o755)
	made := 0
	for link, target := range links {
		if err := os.Symlink(target, link); err == nil {
			made++
		}
	}
	if made == 0 {
		t.Skip("cannot create symlinks here")
	}
	got, warns := DiscoverSkills(proj)
	if fmt.Sprint(skillIDs(got)) != "[skill:skills/real]" {
		t.Fatalf("skills = %v (warnings %v)", skillIDs(got), warns)
	}
	if got[0].Files != 2 {
		t.Errorf("real.Files = %d, want 2 (links inside a skill are skipped)", got[0].Files)
	}
}

func TestDiscoverSkills_OverLimitSkillIsSkippedWithAWarning(t *testing.T) {
	sparse := func(path string, size int64) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := f.Truncate(size); err != nil {
			t.Fatal(err)
		}
	}
	proj := t.TempDir()
	writeTree(t, proj, map[string]string{"skills/fine/SKILL.md": "ok"})
	sparse(filepath.Join(proj, "skills", "bigfile", "blob.bin"), MaxEntryBytes+1)
	sparse(filepath.Join(proj, "skills", "bigfile.md"), MaxEntryBytes+1)
	for i := 0; i < 11; i++ {
		sparse(filepath.Join(proj, "skills", "bigtotal", fmt.Sprintf("f%02d.bin", i)), MaxEntryBytes)
	}
	got, warns := DiscoverSkills(proj)
	if fmt.Sprint(skillIDs(got)) != "[skill:skills/fine]" {
		t.Fatalf("skills = %v", skillIDs(got))
	}
	if len(warns) != 3 {
		t.Errorf("want 3 warnings (bigfile, bigfile.md, bigtotal), got %v", warns)
	}
}

func TestDiscoverSkills_FileCountLimit(t *testing.T) {
	proj := t.TempDir()
	dir := filepath.Join(proj, "skills", "many")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	limit := MaxEntries - 3
	for i := 0; i <= limit; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%04d", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, warns := DiscoverSkills(proj)
	if len(got) != 0 || len(warns) != 1 {
		t.Fatalf("%d files: skills=%v warnings=%v; want it skipped with one warning", limit+1, skillIDs(got), warns)
	}
	if err := os.Remove(filepath.Join(dir, "f0000")); err != nil {
		t.Fatal(err)
	}
	got, warns = DiscoverSkills(proj)
	if len(got) != 1 || got[0].Files != limit || len(warns) != 0 {
		t.Fatalf("%d files: skills=%+v warnings=%v; want it accepted", limit, got, warns)
	}
}
