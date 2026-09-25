package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"

	"md-memo/pkg/skillinstall"
	"md-memo/skills"
)

// skillEnv makes the install target hermetic: a fresh home folder and no CLAUDE_CONFIG_DIR /
// CODEX_HOME from the developer's shell.
func skillEnv(t *testing.T) (home string) {
	t.Helper()
	home = withTempHome(t)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	return home
}

func installSkill(t *testing.T, version string, args ...string) (stdout, stderr string, code int, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	code, err = NewHeadlessRunner(&out, &errOut).WithVersion(version).Run(append([]string{"agent", "install-skill"}, args...))
	return out.String(), errOut.String(), code, err
}

type installJSON struct {
	Action  string   `json:"action"`
	Path    string   `json:"path"`
	Version string   `json:"version"`
	Hash    string   `json:"hash"`
	Files   int      `json:"files"`
	Bytes   int64    `json:"bytes"`
	Names   []string `json:"names"`
	Target  string   `json:"target"`
	Base    string   `json:"base"`
}

func installSkillJSON(t *testing.T, version string, args ...string) installJSON {
	t.Helper()
	stdout, stderr, code, err := installSkill(t, version, append([]string{"--json"}, args...)...)
	if err != nil || code != 0 {
		t.Fatalf("install-skill %v: code %d, err %v, stderr %q", args, code, err, stderr)
	}
	var res installJSON
	if err := json.Unmarshal([]byte(stdout), &res); err != nil {
		t.Fatalf("stdout is not JSON: %q", stdout)
	}
	return res
}

// embeddedFileCount is how many files the embedded skill has (the marker is not one of them).
func embeddedFileCount(t *testing.T) int {
	t.Helper()
	n := 0
	err := fs.WalkDir(skills.Skill(), ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return err
	})
	if err != nil || n < 4 {
		t.Fatalf("the embedded skill has %d files (%v)", n, err)
	}
	return n
}

// The real embedded skill is complete: every file of skills/md-memo is in the binary.
func TestEmbeddedSkillHasTheWholeSkill(t *testing.T) {
	for _, name := range []string{"SKILL.md", "references/interfaces.md", "references/setup-guide.md", "references/troubleshooting.md"} {
		data, err := fs.ReadFile(skills.Skill(), name)
		if err != nil || len(data) < 1000 {
			t.Errorf("%s is not embedded properly: %v (%d bytes)", name, err, len(data))
		}
	}
}

func TestInstallSkillDefaultsToClaudeCodeInTheHomeFolder(t *testing.T) {
	home := skillEnv(t)
	res := installSkillJSON(t, "9.9.9")

	want := filepath.Join(home, ".claude", "skills", "md-memo")
	if res.Action != "installed" || res.Path != want || res.Target != "claude" || res.Base != filepath.Dir(want) {
		t.Errorf("result = %+v, want it installed at %s for claude", res, want)
	}
	n := embeddedFileCount(t)
	if res.Files != n || res.Version != "9.9.9" || !strings.HasPrefix(res.Hash, "sha256:") || res.Bytes < 100000 {
		t.Errorf("result = %+v", res)
	}
	for _, name := range []string{"SKILL.md", "references/interfaces.md", "references/setup-guide.md", "references/troubleshooting.md", skillinstall.MarkerFile} {
		if !exists(filepath.Join(want, filepath.FromSlash(name))) {
			t.Errorf("%s is missing from the installed skill", name)
		}
	}
	// Exactly the embedded bytes.
	embedded, _ := fs.ReadFile(skills.Skill(), "SKILL.md")
	if got, _ := os.ReadFile(filepath.Join(want, "SKILL.md")); !bytes.Equal(got, embedded) {
		t.Error("SKILL.md differs from the embedded copy")
	}
	var marker skillinstall.Marker
	data, _ := os.ReadFile(filepath.Join(want, skillinstall.MarkerFile))
	if err := json.Unmarshal(data, &marker); err != nil || marker.Version != "9.9.9" || marker.Hash != res.Hash || len(marker.Files) != n {
		t.Errorf("marker = %s (%v)", data, err)
	}
	// Same as saying --claude.
	if again := installSkillJSON(t, "9.9.9", "--claude"); again.Action != "up-to-date" || again.Path != want {
		t.Errorf("--claude = %+v", again)
	}
}

func TestInstallSkillHonoursClaudeConfigDir(t *testing.T) {
	home := skillEnv(t)
	cfg := filepath.Join(t.TempDir(), "claude-cfg")
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)

	res := installSkillJSON(t, "9.9.9")
	if want := filepath.Join(cfg, "skills", "md-memo"); res.Path != want {
		t.Errorf("path = %s, want %s", res.Path, want)
	}
	if exists(filepath.Join(home, ".claude")) {
		t.Error("the default folder was touched although CLAUDE_CONFIG_DIR is set")
	}
}

func TestInstallSkillCodex(t *testing.T) {
	home := skillEnv(t)

	res := installSkillJSON(t, "9.9.9", "--codex")
	if want := filepath.Join(home, ".codex", "skills", "md-memo"); res.Path != want || res.Target != "codex" {
		t.Errorf("result = %+v, want %s", res, want)
	}
	if exists(filepath.Join(home, ".claude")) {
		t.Error("--codex must not touch the Claude Code folder")
	}

	codexHome := filepath.Join(t.TempDir(), "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	res = installSkillJSON(t, "9.9.9", "--codex")
	if want := filepath.Join(codexHome, "skills", "md-memo"); res.Path != want {
		t.Errorf("path = %s, want %s", res.Path, want)
	}

	// The text output says the path is unverified.
	stdout, _, code, err := installSkill(t, "9.9.9", "--codex", "--text")
	if err != nil || code != 0 || !strings.Contains(stdout, "UNVERIFIED") {
		t.Errorf("text output = %q (code %d, err %v), want the UNVERIFIED note", stdout, code, err)
	}
}

func TestInstallSkillDir(t *testing.T) {
	home := skillEnv(t)
	dest := filepath.Join(t.TempDir(), "agents", "skills")

	res := installSkillJSON(t, "9.9.9", "--dir", dest)
	if want := filepath.Join(dest, "md-memo"); res.Path != want || res.Target != "dir" || res.Base != dest {
		t.Errorf("result = %+v, want %s", res, want)
	}
	if exists(filepath.Join(home, ".claude")) {
		t.Error("--dir must not touch the Claude Code folder")
	}

	// A relative folder is taken from the current folder.
	cwd := t.TempDir()
	t.Chdir(cwd)
	res = installSkillJSON(t, "9.9.9", "--dir", "rel")
	if !exists(filepath.Join(cwd, "rel", "md-memo", "SKILL.md")) || !filepath.IsAbs(res.Path) {
		t.Errorf("relative --dir: %+v", res)
	}

	// A leading ~ is the home folder (PowerShell passes it on unexpanded).
	res = installSkillJSON(t, "9.9.9", "--dir", "~/mine")
	if want := filepath.Join(home, "mine", "md-memo"); res.Path != want {
		t.Errorf("--dir ~/mine: path = %s, want %s", res.Path, want)
	}
}

func TestInstallSkillFlagErrors(t *testing.T) {
	home := skillEnv(t)
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--claude", "--codex"}, "choose one of"},
		{[]string{"--codex", "--dir", "x"}, "choose one of"},
		{[]string{"--claude", "--dir", "x"}, "choose one of"},
		{[]string{"--dir", ""}, "--dir needs a folder"},
		{[]string{"stray"}, `unexpected argument "stray"`},
		{[]string{"--nonsense"}, "flag provided but not defined"},
	} {
		_, _, code, err := installSkill(t, "9.9.9", c.args...)
		if code != 1 || err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: code %d, err %v, want exit 1 with %q", c.args, code, err, c.want)
		}
	}
	if exists(filepath.Join(home, ".claude")) {
		t.Error("a refused command line must write nothing")
	}
}

func TestInstallSkillTextOutputSaysWhatWasInstalledWhere(t *testing.T) {
	home := skillEnv(t)
	stdout, stderr, code, err := installSkill(t, "9.9.9", "--text")
	if err != nil || code != 0 || stderr != "" {
		t.Fatalf("code %d, err %v, stderr %q", code, err, stderr)
	}
	target := filepath.Join(home, ".claude", "skills", "md-memo")
	for _, want := range []string{"Installed the md-memo skill: " + target, fmt.Sprintf("%d files", embeddedFileCount(t)), "md-memo 9.9.9", "SKILL.md", "references/interfaces.md", skillinstall.MarkerFile, "Claude Code"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("the output does not mention %q:\n%s", want, stdout)
		}
	}

	stdout, _, code, err = installSkill(t, "9.9.9", "--text")
	if err != nil || code != 0 || !strings.Contains(stdout, "already up to date: "+target) {
		t.Errorf("second run: code %d, err %v, output %q", code, err, stdout)
	}
}

// Same content again is "up to date" (exit 0) and the hash is the same across targets and runs.
func TestInstallSkillHashIsStable(t *testing.T) {
	skillEnv(t)
	a := installSkillJSON(t, "9.9.9", "--dir", filepath.Join(t.TempDir(), "a"))
	b := installSkillJSON(t, "9.9.9", "--dir", filepath.Join(t.TempDir(), "b"))
	again := installSkillJSON(t, "9.9.9", "--dir", a.Base)
	want, err := skillinstall.Hash(skills.Skill())
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash != b.Hash || a.Hash != again.Hash || a.Hash != want {
		t.Errorf("hashes differ: %s %s %s (embedded: %s)", a.Hash, b.Hash, again.Hash, want)
	}
	if again.Action != "up-to-date" {
		t.Errorf("action = %s", again.Action)
	}
}

func withSkillSource(t *testing.T, src fs.FS) {
	t.Helper()
	prev := skillSource
	skillSource = func() fs.FS { return src }
	t.Cleanup(func() { skillSource = prev })
}

const cliSkillMD = "---\nname: md-memo\ndescription: test\n---\n"

func TestInstallSkillUpdatesAnUntouchedOlderCopyAndRefusesEdits(t *testing.T) {
	skillEnv(t)
	dest := filepath.Join(t.TempDir(), "skills")

	withSkillSource(t, fstest.MapFS{"SKILL.md": {Data: []byte(cliSkillMD)}, "references/a.md": {Data: []byte("old a")}})
	first := installSkillJSON(t, "1.7.0", "--dir", dest)
	target := first.Path

	// The next release ships different text: an update, no --force needed.
	withSkillSource(t, fstest.MapFS{"SKILL.md": {Data: []byte(cliSkillMD + "new\n")}, "references/a.md": {Data: []byte("new a")}})
	stdout, _, code, err := installSkill(t, "1.8.0", "--text", "--dir", dest)
	if err != nil || code != 0 || !strings.Contains(stdout, "Updated the md-memo skill (it was installed by md-memo 1.7.0)") {
		t.Fatalf("update: code %d, err %v, output %q", code, err, stdout)
	}
	if got, _ := os.ReadFile(filepath.Join(target, "references", "a.md")); string(got) != "new a" {
		t.Errorf("a.md = %q", got)
	}

	// The user edits a file; the release after that ships more changes.
	if err := os.WriteFile(filepath.Join(target, "references", "a.md"), []byte("my edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	withSkillSource(t, fstest.MapFS{"SKILL.md": {Data: []byte(cliSkillMD + "newer\n")}, "references/a.md": {Data: []byte("newer a")}})
	_, _, code, err = installSkill(t, "1.9.0", "--dir", dest)
	if code != 1 || err == nil {
		t.Fatalf("an edited folder must be refused: code %d, err %v", code, err)
	}
	for _, want := range []string{"modified: references/a.md", "--force", target} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not mention %q: %s", want, err)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(target, "references", "a.md")); string(got) != "my edit" {
		t.Errorf("the edit was overwritten: %q", got)
	}

	stdout, _, code, err = installSkill(t, "1.9.0", "--text", "--force", "--dir", dest)
	if err != nil || code != 0 || !strings.Contains(stdout, "Replaced") || !strings.Contains(stdout, "discarded: modified: references/a.md") {
		t.Fatalf("--force: code %d, err %v, output %q", code, err, stdout)
	}
	if got, _ := os.ReadFile(filepath.Join(target, "references", "a.md")); string(got) != "newer a" {
		t.Errorf("a.md after --force = %q", got)
	}
}

func TestInstallSkillLeavesAForeignFolderAlone(t *testing.T) {
	skillEnv(t)
	dest := t.TempDir()
	foreign := filepath.Join(dest, "md-memo", "SKILL.md")
	writeFile(t, foreign, "somebody's own skill")

	_, _, code, err := installSkill(t, "9.9.9", "--dir", dest)
	if code != 1 || err == nil || !strings.Contains(err.Error(), skillinstall.MarkerFile) {
		t.Fatalf("code %d, err %v, want a refusal that explains the missing marker", code, err)
	}
	if got, _ := os.ReadFile(foreign); string(got) != "somebody's own skill" {
		t.Errorf("the folder was touched: %q", got)
	}
}

func TestInstallSkillLink(t *testing.T) {
	skillEnv(t)
	source := filepath.Join(t.TempDir(), "skills", "md-memo")
	writeFile(t, filepath.Join(source, "SKILL.md"), cliSkillMD)
	prev := skillFinder
	skillFinder = func() string { return source }
	t.Cleanup(func() { skillFinder = prev })
	dest := filepath.Join(t.TempDir(), "agent-skills")

	if runtime.GOOS == "windows" {
		_, _, code, err := installSkill(t, "9.9.9", "--link", "--dir", dest)
		if code != 1 || err == nil || !strings.Contains(err.Error(), "not supported on Windows") {
			t.Errorf("code %d, err %v, want a clear refusal on Windows", code, err)
		}
		if exists(dest) {
			t.Error("a refused --link must create nothing")
		}
		return
	}
	res := installSkillJSON(t, "9.9.9", "--link", "--dir", dest)
	if res.Action != "linked" {
		t.Fatalf("result = %+v", res)
	}
	if got, err := os.Readlink(filepath.Join(dest, "md-memo")); err != nil || got != source {
		t.Errorf("Readlink = %q, %v; want %q", got, err, source)
	}
}

func TestInstallSkillLinkNeedsASkillOnDisk(t *testing.T) {
	skillEnv(t)
	prev := skillFinder
	skillFinder = func() string { return "" }
	t.Cleanup(func() { skillFinder = prev })
	dest := filepath.Join(t.TempDir(), "agent-skills")

	_, _, code, err := installSkill(t, "9.9.9", "--link", "--dir", dest)
	if code != 1 || err == nil {
		t.Fatalf("code %d, err %v", code, err)
	}
	if runtime.GOOS != "windows" && !strings.Contains(err.Error(), "skills/md-memo folder on disk") {
		t.Errorf("err = %v", err)
	}
	if exists(dest) {
		t.Error("nothing may be created")
	}
}

// Through the shared entry point: the command is standalone and its help is found.
func TestInstallSkillThroughMain(t *testing.T) {
	skillEnv(t)
	dest := t.TempDir()
	stdout, stderr, code, handled := runMain(t, "", "agent", "install-skill", "--dir", dest, "--json")
	if !handled || code != 0 || stderr != "" {
		t.Fatalf("handled=%v code=%d stderr=%q", handled, code, stderr)
	}
	var res installJSON
	if err := json.Unmarshal([]byte(stdout), &res); err != nil || res.Version != "9.9.9" || res.Action != "installed" {
		t.Errorf("stdout = %q (%v)", stdout, err)
	}

	stdout, _, code, handled = runMain(t, "", "agent", "install-skill", "--help")
	if !handled || code != 0 || stdout != SubcommandUsage("agent") {
		t.Errorf("--help: handled=%v code=%d", handled, code)
	}
	for _, want := range []string{"install-skill", "--claude", "--codex", "--dir", "--force", "--link", "UNVERIFIED", ".md-memo-skill-version"} {
		if !strings.Contains(SubcommandUsage("agent"), want) {
			t.Errorf("the agent help does not mention %q", want)
		}
	}
}
