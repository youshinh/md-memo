package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/configpack"
	"md-memo/pkg/encoding"
)

const (
	packTestConfig = `{"general":{"theme":"dark"},"text":{"apiKey":"sk-secret","model":"m"},"autocomplete":{"maxTokens":30},"scraps":{"gitRemoteUrl":"https://u:pw@github.com/a/b.git"},"shortcuts":{"save":"Ctrl+S"}}`

	packTestAppAgents  = "version: 2\ndefault_agent: app-agent\nagents:\n  app-agent:\n    command: echo\n    args: [\"{instruction}\"]\n"
	packTestProjAgents = "version: 2\ndefault_agent: proj-agent\nagents:\n  proj-agent:\n    command: echo\n    args: [\"{instruction}\"]\n    env:\n      PROJ_API_KEY: sk-proj-secret\n"
)

// packEnv isolates one test: its own config and home folders, stubbed dialogs and clock.
type packEnv struct {
	t        *testing.T
	app      *App
	appDir   string // <config>/md-memo
	home     string
	proj     string
	out      string
	saveName string
	saveTo   func(name string) string
	openPath string
	saveN    int
	openN    int
}

func newPackEnv(t *testing.T) *packEnv {
	t.Helper()
	prevCfg, _ := appdir.ConfigDir()
	prevHome, _ := appdir.HomeDir()
	prevSave, prevOpen, prevNow := packSaveDialog, packOpenDialog, packNow

	cfg, home := t.TempDir(), t.TempDir()
	appdir.SetConfigDirOverride(cfg)
	appdir.SetHomeDirOverride(home)
	e := &packEnv{t: t, app: &App{}, appDir: filepath.Join(cfg, "md-memo"), home: home, proj: t.TempDir(), out: t.TempDir()}
	e.saveTo = func(name string) string { return filepath.Join(e.out, name) }
	packSaveDialog = func(title, name string) (string, error) {
		e.saveN++
		e.saveName = name
		return e.saveTo(name), nil
	}
	packOpenDialog = func(title string) (string, error) {
		e.openN++
		return e.openPath, nil
	}
	packNow = func() time.Time { return time.Date(2026, 9, 21, 10, 0, 0, 0, time.FixedZone("JST", 9*3600)) }
	t.Cleanup(func() {
		appdir.SetConfigDirOverride(prevCfg)
		appdir.SetHomeDirOverride(prevHome)
		packSaveDialog, packOpenDialog, packNow = prevSave, prevOpen, prevNow
	})
	if err := os.MkdirAll(filepath.Join(e.proj, ".md-memo"), 0o755); err != nil {
		t.Fatal(err)
	}
	return e
}

func packWrite(t *testing.T, base string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(base, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func (e *packEnv) fill() {
	e.t.Helper()
	packWrite(e.t, e.proj, map[string]string{
		"skills/alpha/SKILL.md":         "# alpha\n日本語\n",
		"skills/alpha/ref/n.txt":        "notes",
		"skills/beta.md":                "beta",
		".claude/skills/gamma/SKILL.md": "gamma",
		".md-memo/agents.yaml":          packTestProjAgents,
	})
	packWrite(e.t, e.appDir, map[string]string{"agents.yaml": packTestAppAgents})
}

func (e *packEnv) hint() string { return filepath.Join(e.proj, "notes", "today.md") }

func decodeMap(t *testing.T, s string) map[string]any {
	t.Helper()
	m := map[string]any{}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not a JSON object: %v\n%s", err, s)
	}
	return m
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func asList(t *testing.T, v any) []any {
	t.Helper()
	l, ok := v.([]any)
	if !ok {
		t.Fatalf("%#v is not a JSON array", v)
	}
	return l
}

func mustJSONString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", p, err)
	}
	return string(b)
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func (e *packEnv) exportSel(over map[string]any) string {
	sel := map[string]any{
		"format": "pack", "projectHint": e.hint(), "includeSecrets": false, "includeConfig": true,
		"configSections": []string{"general", "models"},
		"agents":         []string{"agents:app", "agents:project"},
		"skills":         []string{"skill:skills/alpha", "skill:skills/beta.md", "skill:.claude/skills/gamma"},
	}
	for k, v := range over {
		sel[k] = v
	}
	return mustJSONString(e.t, sel)
}

func (e *packEnv) export(over map[string]any) map[string]any {
	e.t.Helper()
	out, err := e.app.PackExport(e.exportSel(over), packTestConfig)
	if err != nil {
		e.t.Fatalf("PackExport: %v", err)
	}
	return decodeMap(e.t, out)
}

// --- listing ------------------------------------------------------------------------------

func TestPackList_ProjectAgentsAndSkills(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	out, err := e.app.PackListExportable(e.hint())
	if err != nil {
		t.Fatal(err)
	}
	res := decodeMap(t, out)
	if res["projectRoot"] != e.proj {
		t.Errorf("projectRoot = %v, want %s", res["projectRoot"], e.proj)
	}
	agents := asList(t, res["agents"])
	if len(agents) != 2 {
		t.Fatalf("agents = %v", agents)
	}
	app, proj := agents[0].(map[string]any), agents[1].(map[string]any)
	if app["id"] != "agents:app" || app["scope"] != "app" || app["path"] != filepath.Join(e.appDir, "agents.yaml") || app["bytes"] != float64(len(packTestAppAgents)) {
		t.Errorf("app agents = %v", app)
	}
	if proj["id"] != "agents:project" || proj["scope"] != "project" || proj["path"] != filepath.Join(e.proj, ".md-memo", "agents.yaml") {
		t.Errorf("project agents = %v", proj)
	}
	if len(app) != 4 {
		t.Errorf("agent entries have keys %v, want id/scope/path/bytes", keysOf(app))
	}
	skills := asList(t, res["skills"])
	var ids []string
	for _, s := range skills {
		m := s.(map[string]any)
		ids = append(ids, m["id"].(string))
		if len(m) != 6 {
			t.Errorf("skill entry keys %v, want id/root/name/entry/files/bytes", keysOf(m))
		}
	}
	if strings.Join(ids, ",") != "skill:skills/alpha,skill:skills/beta.md,skill:.claude/skills/gamma" {
		t.Errorf("skill ids = %v", ids)
	}
	if alpha := skills[0].(map[string]any); alpha["files"] != float64(2) || alpha["entry"] != "dir" || alpha["root"] != "skills" || alpha["name"] != "alpha" {
		t.Errorf("alpha = %v", alpha)
	}
	if w := asList(t, res["warnings"]); len(w) != 0 {
		t.Errorf("warnings = %v", w)
	}
}

func TestPackList_EmptyEverywhere(t *testing.T) {
	e := newPackEnv(t)
	out, err := e.app.PackListExportable("")
	if err != nil {
		t.Fatal(err)
	}
	res := decodeMap(t, out)
	if res["projectRoot"] != "" {
		t.Errorf("projectRoot = %v with no hint and no scraps folder", res["projectRoot"])
	}
	for _, k := range []string{"agents", "skills", "warnings"} {
		if l, ok := res[k].([]any); !ok || len(l) != 0 {
			t.Errorf("%s = %#v, want an empty array", k, res[k])
		}
	}
}

func TestPackList_FallsBackToTheScrapsFolder(t *testing.T) {
	for name, cfg := range map[string]string{
		"tilde":  `{"scrap_dir":"~/my-scraps"}`,
		"nested": `{"scraps":{"scrapDir":"~/my-scraps"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			e := newPackEnv(t)
			scraps := filepath.Join(e.home, "my-scraps")
			packWrite(t, scraps, map[string]string{"skills/note-skill/SKILL.md": "s", ".md-memo/agents.yaml": packTestAppAgents})
			packWrite(t, e.appDir, map[string]string{"config.json": cfg})

			res := decodeMap(t, mustString(e.app.PackListExportable("")))
			if res["projectRoot"] != scraps {
				t.Fatalf("projectRoot = %v, want %s", res["projectRoot"], scraps)
			}
			if len(asList(t, res["skills"])) != 1 || len(asList(t, res["agents"])) != 1 {
				t.Errorf("skills/agents = %v / %v", res["skills"], res["agents"])
			}
		})
	}

	t.Run("folder does not exist", func(t *testing.T) {
		e := newPackEnv(t)
		packWrite(t, e.appDir, map[string]string{"config.json": `{"scrap_dir":"~/never-created"}`, "agents.yaml": packTestAppAgents})
		res := decodeMap(t, mustString(e.app.PackListExportable("")))
		if res["projectRoot"] != "" || len(asList(t, res["skills"])) != 0 {
			t.Errorf("got %v", res)
		}
		if len(asList(t, res["agents"])) != 1 {
			t.Error("the app-level agents file is still listed without a project")
		}
	})
}

func mustString(s string, err error) string {
	if err != nil {
		panic(err)
	}
	return s
}

// A dotfiles repo makes FindProjectRoot answer with the home folder, whose .claude/skills is
// the user's global set. Those must never be offered.
func TestPackList_HomeFolderIsNeverAProject(t *testing.T) {
	e := newPackEnv(t)
	packWrite(t, e.home, map[string]string{".git/HEAD": "ref", ".claude/skills/global-one/SKILL.md": "g", "skills/also-global/SKILL.md": "g"})
	if err := os.MkdirAll(filepath.Join(e.home, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	res := decodeMap(t, mustString(e.app.PackListExportable(filepath.Join(e.home, "notes", "a.md"))))
	if res["projectRoot"] != "" || len(asList(t, res["skills"])) != 0 {
		t.Fatalf("home folder offered as a project: %v", res)
	}
	if w := asList(t, res["warnings"]); len(w) != 1 || !strings.Contains(w[0].(string), "home") {
		t.Errorf("warnings = %v, want the home-folder note", w)
	}

	// and the same through the scraps fallback
	packWrite(t, e.appDir, map[string]string{"config.json": `{"scrap_dir":"~/scraps"}`})
	if err := os.MkdirAll(filepath.Join(e.home, "scraps"), 0o755); err != nil {
		t.Fatal(err)
	}
	if root := e.app.packProjectRoot(""); root != "" {
		t.Errorf("scraps fallback resolved to %q", root)
	}
}

// --- export -------------------------------------------------------------------------------

func TestPackExport_WritesAPackWithoutSecrets(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	res := e.export(nil)

	if res["ok"] != true || e.saveName != "md-memo-20260921.mdmemopack" {
		t.Fatalf("result = %v, default name %q", res, e.saveName)
	}
	path := res["path"].(string)
	if path != filepath.Join(e.out, "md-memo-20260921.mdmemopack") {
		t.Errorf("path = %s", path)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	counts := res["counts"].(map[string]any)
	want := map[string]float64{"config": 1, "agents": 2, "skills": 3, "files": 7, "bytes": float64(fi.Size())}
	for k, v := range want {
		if counts[k] != v {
			t.Errorf("counts.%s = %v, want %v (counts: %v)", k, counts[k], v, counts)
		}
	}
	if res["secretsStripped"] != float64(3) || res["secretWarnings"] != float64(0) {
		t.Errorf("secretsStripped=%v secretWarnings=%v, want 3 and 0", res["secretsStripped"], res["secretWarnings"])
	}
	if w, ok := res["warnings"].([]any); !ok || len(w) != 0 {
		t.Errorf("warnings = %#v", res["warnings"])
	}

	pk, err := configpack.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pk.Close()
	m := pk.Manifest
	if m.IncludesSecrets || m.AppVersion != AppVersion || strings.Join(m.ConfigSections, ",") != "general,models" {
		t.Errorf("manifest = %+v", m)
	}
	cfg, err := pk.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"sk-secret", "pw@"} {
		if strings.Contains(string(cfg), leak) {
			t.Errorf("config still contains %q: %s", leak, cfg)
		}
	}
	for _, keep := range []string{`"maxTokens":30`, `"model":"m"`, `"theme":"dark"`, `https://github.com/a/b.git`} {
		if !strings.Contains(string(cfg), keep) {
			t.Errorf("config lost %q: %s", keep, cfg)
		}
	}
	proj, _, err := pk.ReadAgents("agents:project")
	if err != nil || strings.Contains(string(proj), "sk-proj-secret") || !strings.Contains(string(proj), `PROJ_API_KEY: ""`) {
		t.Errorf("project agents = %q, %v", proj, err)
	}
	app, _, _ := pk.ReadAgents("agents:app")
	if string(app) != packTestAppAgents {
		t.Errorf("a clean agents file must be stored unchanged, got %q", app)
	}
	// the source files on disk are never touched
	if !strings.Contains(readFile(t, filepath.Join(e.proj, ".md-memo", "agents.yaml")), "sk-proj-secret") {
		t.Error("export modified the source agents file")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(e.out, "*.tmp")); len(leftovers) != 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}
}

func TestPackExport_IncludeSecrets(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	res := e.export(map[string]any{"includeSecrets": true})
	if res["secretsStripped"] != float64(0) {
		t.Errorf("secretsStripped = %v with includeSecrets", res["secretsStripped"])
	}
	pk, err := configpack.Open(res["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer pk.Close()
	cfg, _ := pk.ReadConfig()
	proj, _, _ := pk.ReadAgents("agents:project")
	if !strings.Contains(string(cfg), "sk-secret") || !strings.Contains(string(cfg), "u:pw@") || !strings.Contains(string(proj), "sk-proj-secret") {
		t.Errorf("secrets were dropped although asked for: %s / %s", cfg, proj)
	}
	if !pk.Manifest.IncludesSecrets {
		t.Error("manifest.includesSecrets should be true")
	}

	// ticking the box for a package that holds no secrets does not label it as carrying some
	e2 := newPackEnv(t)
	packWrite(t, e2.appDir, map[string]string{"agents.yaml": packTestAppAgents})
	out, err := e2.app.PackExport(e2.exportSel(map[string]any{"includeSecrets": true, "agents": []string{"agents:app"}, "skills": []string{}, "includeConfig": false}), packTestConfig)
	if err != nil {
		t.Fatal(err)
	}
	pk2, err := configpack.Open(decodeMap(t, out)["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer pk2.Close()
	if pk2.Manifest.IncludesSecrets {
		t.Error("includesSecrets true for a pack without secrets")
	}
	if pk2.Manifest.Item("config") != nil {
		t.Error("config was packed although includeConfig is false")
	}
}

func TestPackExport_JSONFormatIsSettingsOnly(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	res := e.export(map[string]any{"format": "json"})
	if e.saveName != "md-memo-config.json" || res["ok"] != true {
		t.Fatalf("name %q result %v", e.saveName, res)
	}
	got := readFile(t, res["path"].(string))
	want := strings.NewReplacer(`"sk-secret"`, `""`, `u:pw@`, ``).Replace(packTestConfig)
	if got != want {
		t.Errorf("file = %s\nwant   %s", got, want)
	}
	counts := res["counts"].(map[string]any)
	if counts["agents"] != float64(0) || counts["skills"] != float64(0) || counts["config"] != float64(1) || res["secretsStripped"] != float64(2) {
		t.Errorf("counts %v stripped %v", counts, res["secretsStripped"])
	}
	// with secrets it is exactly what the frontend sent
	res = e.export(map[string]any{"format": "json", "includeSecrets": true})
	if readFile(t, res["path"].(string)) != packTestConfig {
		t.Error("includeSecrets json export altered the settings")
	}
}

func TestPackExport_CancelWritesNothing(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	e.saveTo = func(string) string { return "" }
	for _, format := range []string{"pack", "json"} {
		out, err := e.app.PackExport(e.exportSel(map[string]any{"format": format}), packTestConfig)
		if err != nil || out != `{"ok":false,"cancelled":true}` {
			t.Errorf("%s: %q, %v", format, out, err)
		}
	}
	if entries, _ := os.ReadDir(e.out); len(entries) != 0 {
		t.Errorf("cancelled export left files: %v", entries)
	}
}

func TestPackExport_RejectsBadRequestsBeforeAnyDialog(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	bigCfg := `{"a":"` + strings.Repeat("x", configpack.MaxConfigBytes) + `"}`
	cases := map[string][2]string{
		"selection is not json": {`nope`, packTestConfig},
		"unknown format":        {e.exportSel(map[string]any{"format": "zip"}), packTestConfig},
		"config missing":        {e.exportSel(nil), ``},
		"config not an object":  {e.exportSel(nil), `[1]`},
		"config not json":       {e.exportSel(nil), `{oops`},
		"config too large":      {e.exportSel(nil), bigCfg},
		"json format no config": {e.exportSel(map[string]any{"format": "json"}), ``},
		"nothing selected":      {e.exportSel(map[string]any{"includeConfig": false, "agents": []string{}, "skills": []string{}}), packTestConfig},
		"only unknown items":    {e.exportSel(map[string]any{"includeConfig": false, "agents": []string{"agents:other"}, "skills": []string{"skill:skills/ghost"}}), packTestConfig},
	}
	for name, c := range cases {
		out, err := e.app.PackExport(c[0], c[1])
		if err == nil {
			t.Errorf("%s: no error (%s)", name, out)
			continue
		}
		if !strings.Contains(err.Error(), " / ") {
			t.Errorf("%s: error is not bilingual: %v", name, err)
		}
	}
	if e.saveN != 0 {
		t.Errorf("the save dialog opened %d time(s) for a request that was invalid", e.saveN)
	}
}

func TestPackExport_UnknownItemsAreWarningsNotErrors(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	res := e.export(map[string]any{"agents": []string{"agents:app", "agents:other"}, "skills": []string{"skill:skills/alpha", "skill:skills/ghost", "skill:../../etc"}})
	if w := asList(t, res["warnings"]); len(w) != 3 {
		t.Errorf("warnings = %v, want one per unknown item", w)
	}
	counts := res["counts"].(map[string]any)
	if counts["agents"] != float64(1) || counts["skills"] != float64(1) {
		t.Errorf("counts = %v", counts)
	}
}

func TestPackExport_UnreliableAgentsSecretsAreFlagged(t *testing.T) {
	e := newPackEnv(t)
	tricky := "version: 2\nagents: {}\nenv:\n  A_TOKEN: |\n    multi\n"
	packWrite(t, e.appDir, map[string]string{"agents.yaml": tricky})
	res := e.export(map[string]any{"includeConfig": false, "agents": []string{"agents:app"}, "skills": []string{}})
	if res["secretWarnings"] != float64(1) || len(asList(t, res["warnings"])) != 1 {
		t.Errorf("secretWarnings=%v warnings=%v", res["secretWarnings"], res["warnings"])
	}
	pk, err := configpack.Open(res["path"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer pk.Close()
	if d, _, _ := pk.ReadAgents("agents:app"); string(d) != tricky {
		t.Errorf("an unreliable file must be stored unchanged, got %q", d)
	}
}

func TestPackExport_ReplacesAnExistingFileAtomically(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	target := filepath.Join(e.out, "chosen.mdmemopack")
	if err := os.WriteFile(target, []byte("old contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.saveTo = func(string) string { return target }
	res := e.export(nil)
	if res["path"] != target {
		t.Fatalf("path = %v", res["path"])
	}
	if ok, _ := configpack.IsZipFile(target); !ok {
		t.Error("the existing file was not replaced")
	}

	// A build that fails half-way must leave the old file alone. The skill is fine when it is
	// listed; the save dialog (which runs between listing and building) is where it grows.
	if err := os.WriteFile(target, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	packWrite(t, e.proj, map[string]string{"skills/grows/SKILL.md": "x", "skills/grows/data.bin": "y"})
	e.saveTo = func(string) string {
		if err := os.Truncate(filepath.Join(e.proj, "skills", "grows", "data.bin"), configpack.MaxEntryBytes+1); err != nil {
			t.Fatal(err)
		}
		return target
	}
	_, err := e.app.PackExport(e.exportSel(map[string]any{"skills": []string{"skill:skills/grows"}, "agents": []string{}, "includeConfig": false}), packTestConfig)
	if err == nil {
		t.Fatal("a skill that outgrew the limit was exported")
	}
	if got := readFile(t, target); got != "precious" {
		t.Errorf("a failed export clobbered the existing file: %q", got)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(e.out, "*.tmp")); len(leftovers) != 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}
}

// --- inspect ------------------------------------------------------------------------------

func (e *packEnv) exportedPack() string {
	e.t.Helper()
	res := e.export(nil)
	return res["path"].(string)
}

func TestPackInspect_ListsItemsAndWhatWouldBeOverwritten(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()

	dst := newPackEnv(t)
	packWrite(t, dst.proj, map[string]string{"skills/alpha/SKILL.md": "already here", ".md-memo/agents.yaml": "version: 2\n"})
	dst.openPath = pack
	out, err := dst.app.PackInspect(dst.hint())
	if err != nil {
		t.Fatal(err)
	}
	res := decodeMap(t, out)
	if res["packPath"] != pack || res["legacy"] != false || res["projectRoot"] != dst.proj {
		t.Errorf("header = %v", res)
	}
	man := res["manifest"].(map[string]any)
	if man["format"] != "md-memo-pack" || man["version"] != float64(1) || man["appVersion"] != AppVersion {
		t.Errorf("manifest = %v", man)
	}
	items := map[string]map[string]any{}
	for _, it := range asList(t, res["items"]) {
		m := it.(map[string]any)
		items[m["id"].(string)] = m
	}
	if len(items) != 6 {
		t.Fatalf("items = %v", items)
	}
	if sec := items["config"]["sections"].([]any); len(sec) != 2 || sec[0] != "general" || len(items["config"]) != 3 {
		t.Errorf("config item = %v", items["config"])
	}
	check := func(id string, wantExists bool, wantKeys int) {
		t.Helper()
		it := items[id]
		if it == nil {
			t.Errorf("missing item %s", id)
			return
		}
		if it["exists"] != wantExists || len(it) != wantKeys {
			t.Errorf("%s = %v, want exists=%v with %d keys", id, it, wantExists, wantKeys)
		}
	}
	check("agents:project", true, 5)
	check("agents:app", false, 5)
	check("skill:skills/alpha", true, 7)
	check("skill:skills/beta.md", false, 7)
	check("skill:.claude/skills/gamma", false, 7)
	if items["skill:skills/alpha"]["files"] != float64(2) || items["skill:skills/beta.md"]["files"] != float64(1) {
		t.Errorf("file counts = %v / %v", items["skill:skills/alpha"], items["skill:skills/beta.md"])
	}
	if w := asList(t, res["warnings"]); len(w) != 0 {
		t.Errorf("warnings = %v", w)
	}
	if dst.openN != 1 {
		t.Errorf("open dialog calls = %d", dst.openN)
	}
}

func TestPackInspect_NoProjectIsExplained(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()

	dst := newPackEnv(t)
	dst.openPath = pack
	res := decodeMap(t, mustString(dst.app.PackInspect("")))
	if res["projectRoot"] != "" || len(asList(t, res["warnings"])) == 0 {
		t.Errorf("projectRoot=%v warnings=%v", res["projectRoot"], res["warnings"])
	}
	for _, it := range asList(t, res["items"]) {
		if m := it.(map[string]any); m["kind"] == "skill" && m["exists"] != false {
			t.Errorf("%v claims to exist without a project", m)
		}
	}
}

func TestPackInspect_CancelAndDialogError(t *testing.T) {
	e := newPackEnv(t)
	e.openPath = ""
	if out, err := e.app.PackInspect(""); err != nil || out != `{"cancelled":true}` {
		t.Errorf("cancel: %q %v", out, err)
	}
}

func TestPackInspect_LegacyJSON(t *testing.T) {
	e := newPackEnv(t)
	dir := t.TempDir()
	sjis, err := encoding.Encode(`{"general":{"lang":"日本語"},"text":{"apiKey":"sk-legacy"}}`, "Shift_JIS")
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"plain.json": []byte(`{"general":{"theme":"dark"}}`),
		"bom.json":   append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"general":{"theme":"dark"},"text":{"apiKey":"sk-x"}}`)...),
		"sjis.json":  sjis,
	}
	for name, data := range files {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		e.openPath = p
		res := decodeMap(t, mustString(e.app.PackInspect("")))
		if res["legacy"] != true || res["packPath"] != p {
			t.Errorf("%s: %v", name, res)
		}
		items := asList(t, res["items"])
		if len(items) != 1 {
			t.Fatalf("%s: items = %v", name, items)
		}
		it := items[0].(map[string]any)
		if sec, ok := it["sections"].([]any); it["id"] != "config" || it["kind"] != "config" || !ok || len(sec) != 0 {
			t.Errorf("%s: config item = %v, want sections: []", name, it)
		}
		man := res["manifest"].(map[string]any)
		wantSecrets := name != "plain.json"
		if man["includesSecrets"] != wantSecrets {
			t.Errorf("%s: includesSecrets = %v", name, man["includesSecrets"])
		}
		if s, ok := man["configSections"].([]any); !ok || len(s) != 0 {
			t.Errorf("%s: manifest.configSections = %#v", name, man["configSections"])
		}

		imp := decodeMap(t, mustString(e.app.PackImport(p, `{"config":true}`, "")))
		var back map[string]any
		if err := json.Unmarshal([]byte(imp["configJSON"].(string)), &back); err != nil {
			t.Errorf("%s: imported config is not JSON: %v", name, err)
		}
		if name == "sjis.json" && !strings.Contains(imp["configJSON"].(string), "日本語") {
			t.Errorf("Shift_JIS was not decoded: %s", imp["configJSON"])
		}
	}
}

func TestPackInspect_RejectsWhatIsNeitherAPackNorSettings(t *testing.T) {
	e := newPackEnv(t)
	dir := t.TempDir()
	cases := map[string][]byte{
		"text.txt":    []byte("hello"),
		"array.json":  []byte(`[1,2,3]`),
		"broken.json": []byte(`{"a":`),
		"empty":       {},
		"bin":         {0x00, 0x01, 0x02},
	}
	for name, data := range cases {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		e.openPath = p
		if out, err := e.app.PackInspect(""); err == nil || !strings.Contains(err.Error(), " / ") {
			t.Errorf("%s: %q, %v", name, out, err)
		}
	}
	e.openPath = filepath.Join(dir, "missing.mdmemopack")
	if _, err := e.app.PackInspect(""); err == nil {
		t.Error("missing file accepted")
	}
	big := filepath.Join(dir, "big.json")
	if err := os.WriteFile(big, []byte(`{"a":"`+strings.Repeat("x", configpack.MaxConfigBytes)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	e.openPath = big
	if _, err := e.app.PackInspect(""); err == nil {
		t.Error("oversized settings JSON accepted")
	}
}

func TestPackInspect_HostilePackIsRefused(t *testing.T) {
	e := newPackEnv(t)
	// a pack whose manifest points a skill at ../..
	dir := t.TempDir()
	evil := filepath.Join(dir, "evil.mdmemopack")
	writeEvilPack(t, evil, "../../evil")
	e.openPath = evil
	if _, err := e.app.PackInspect(""); err == nil || !strings.Contains(err.Error(), " / ") {
		t.Fatalf("hostile pack accepted or error not bilingual: %v", err)
	}
	if _, err := e.app.PackImport(evil, `{"skills":["skill:skills/../../evil"]}`, e.hint()); err == nil {
		t.Fatal("PackImport accepted a hostile pack without PackInspect having run")
	}
	if exists(filepath.Join(filepath.Dir(e.proj), "evil")) {
		t.Error("something was written outside the project")
	}
}

// --- import -------------------------------------------------------------------------------

func TestPackImport_RoundTripIntoAFreshMachine(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()
	all := `{"config":true,"agents":["agents:app","agents:project"],"skills":["skill:skills/alpha","skill:skills/beta.md","skill:.claude/skills/gamma"]}`

	dst := newPackEnv(t)
	dst.app.slotCfgCache = &slotConfigCacheEntry{}
	out, err := dst.app.PackImport(pack, all, dst.hint())
	if err != nil {
		t.Fatal(err)
	}
	res := decodeMap(t, out)
	if res["ok"] != true || res["backupDir"] != "" || res["needsRestart"] != true {
		t.Errorf("result = %v", res)
	}
	if sk := asList(t, res["skipped"]); len(sk) != 0 {
		t.Errorf("skipped = %v", sk)
	}
	if secs := asList(t, res["configSections"]); len(secs) != 2 || secs[0] != "general" || secs[1] != "models" {
		t.Errorf("configSections = %v", secs)
	}
	cfg := res["configJSON"].(string)
	if !strings.Contains(cfg, `"maxTokens":30`) || strings.Contains(cfg, "sk-secret") {
		t.Errorf("configJSON = %s", cfg)
	}

	applied := res["applied"].(map[string]any)
	ag := asList(t, applied["agents"])
	if len(ag) != 2 {
		t.Fatalf("applied agents = %v", ag)
	}
	if ag[0].(map[string]any)["path"] != filepath.Join(dst.appDir, "agents.yaml") || ag[1].(map[string]any)["path"] != filepath.Join(dst.proj, ".md-memo", "agents.yaml") {
		t.Errorf("agents paths = %v", ag)
	}
	if got := readFile(t, filepath.Join(dst.appDir, "agents.yaml")); got != packTestAppAgents {
		t.Errorf("app agents = %q", got)
	}
	if got := readFile(t, filepath.Join(dst.proj, ".md-memo", "agents.yaml")); !strings.Contains(got, "proj-agent") || strings.Contains(got, "sk-proj-secret") {
		t.Errorf("project agents = %q", got)
	}
	if dst.app.slotCfgCache != nil {
		t.Error("the slot config cache was not invalidated")
	}
	if cfg := dst.app.resolveActiveSlotConfig(""); cfg.DefaultAgent != "app-agent" {
		t.Errorf("the imported app-level agents are not what the app now resolves: %q", cfg.DefaultAgent)
	}

	sk := asList(t, applied["skills"])
	if len(sk) != 3 {
		t.Fatalf("applied skills = %v", sk)
	}
	for _, s := range sk {
		m := s.(map[string]any)
		if m["id"] == "skill:skills/alpha" && (m["files"] != float64(2) || m["path"] != filepath.Join(dst.proj, "skills", "alpha")) {
			t.Errorf("alpha applied = %v", m)
		}
	}
	for rel, want := range map[string]string{
		"skills/alpha/SKILL.md":         "# alpha\n日本語\n",
		"skills/alpha/ref/n.txt":        "notes",
		"skills/beta.md":                "beta",
		".claude/skills/gamma/SKILL.md": "gamma",
	} {
		if got := readFile(t, filepath.Join(dst.proj, filepath.FromSlash(rel))); got != want {
			t.Errorf("%s = %q, want %q", rel, got, want)
		}
	}
	for _, root := range []string{"skills", ".claude/skills"} {
		entries, _ := os.ReadDir(filepath.Join(dst.proj, filepath.FromSlash(root)))
		for _, en := range entries {
			if strings.HasPrefix(en.Name(), ".mdmemo-import-") {
				t.Errorf("working folder left behind in %s: %s", root, en.Name())
			}
		}
	}
}

func TestPackImport_OnlyWhatWasSelected(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()
	dst := newPackEnv(t)
	res := decodeMap(t, mustString(dst.app.PackImport(pack, `{"config":false,"agents":[],"skills":["skill:skills/beta.md"]}`, dst.hint())))
	if res["configJSON"] != "" || res["needsRestart"] != false || len(asList(t, res["configSections"])) != 0 {
		t.Errorf("config was returned although not selected: %v", res)
	}
	if !exists(filepath.Join(dst.proj, "skills", "beta.md")) || exists(filepath.Join(dst.proj, "skills", "alpha")) || exists(filepath.Join(dst.appDir, "agents.yaml")) {
		t.Error("unselected items were imported")
	}
}

func TestPackImport_OverwritingKeepsABackup(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()
	all := `{"agents":["agents:app","agents:project"],"skills":["skill:skills/alpha","skill:skills/beta.md"]}`

	dst := newPackEnv(t)
	packWrite(t, dst.proj, map[string]string{
		"skills/alpha/SKILL.md":    "OLD alpha",
		"skills/alpha/old-only.md": "only in the old skill",
		"skills/beta.md":           "OLD beta",
		".md-memo/agents.yaml":     "version: 2\ndefault_agent: old-proj\n",
	})
	packWrite(t, dst.appDir, map[string]string{"agents.yaml": "version: 2\ndefault_agent: old-app\n"})

	res := decodeMap(t, mustString(dst.app.PackImport(pack, all, dst.hint())))
	bk, _ := res["backupDir"].(string)
	if bk == "" || filepath.Base(bk) != "20260921-100000" || filepath.Dir(filepath.Dir(bk)) != dst.appDir {
		t.Fatalf("backupDir = %q", bk)
	}
	if strings.HasPrefix(bk, dst.proj) {
		t.Error("the backup lives inside the project")
	}
	for rel, want := range map[string]string{
		"project/skills/alpha/SKILL.md":    "OLD alpha",
		"project/skills/alpha/old-only.md": "only in the old skill",
		"project/skills/beta.md":           "OLD beta",
		"project/.md-memo/agents.yaml":     "version: 2\ndefault_agent: old-proj\n",
		"app/agents.yaml":                  "version: 2\ndefault_agent: old-app\n",
	} {
		if got := readFile(t, filepath.Join(bk, filepath.FromSlash(rel))); got != want {
			t.Errorf("backup %s = %q, want %q", rel, got, want)
		}
	}
	if exists(filepath.Join(dst.proj, "skills", "alpha", "old-only.md")) {
		t.Error("the skill folder was merged instead of replaced")
	}
	if got := readFile(t, filepath.Join(dst.proj, "skills", "alpha", "SKILL.md")); got == "OLD alpha" {
		t.Error("skill not replaced")
	}
	if got := readFile(t, filepath.Join(dst.proj, "skills", "beta.md")); got != "beta" {
		t.Errorf("file skill = %q", got)
	}

	// a second import in the same second must not reuse the folder
	res2 := decodeMap(t, mustString(dst.app.PackImport(pack, all, dst.hint())))
	if bk2, _ := res2["backupDir"].(string); bk2 == "" || bk2 == bk || filepath.Base(bk2) != "20260921-100000-2" {
		t.Errorf("second backupDir = %q", res2["backupDir"])
	}
	if got := readFile(t, filepath.Join(bk, "project", "skills", "alpha", "SKILL.md")); got != "OLD alpha" {
		t.Error("the first backup was overwritten")
	}
}

func TestPackImport_AgentsExtensionRule(t *testing.T) {
	src := newPackEnv(t)
	mdAgents := "# Agents\n\n```yaml\nversion: 2\ndefault_agent: from-md\nagents:\n  from-md:\n    command: echo\n```\n"
	packWrite(t, src.appDir, map[string]string{"agents.md": mdAgents})
	res := src.export(map[string]any{"includeConfig": false, "agents": []string{"agents:app"}, "skills": []string{}})
	pack := res["path"].(string)

	t.Run("no existing file: agents.yaml", func(t *testing.T) {
		dst := newPackEnv(t)
		r := decodeMap(t, mustString(dst.app.PackImport(pack, `{"agents":["agents:app"]}`, "")))
		if len(asList(t, r["skipped"])) != 0 || !exists(filepath.Join(dst.appDir, "agents.yaml")) || exists(filepath.Join(dst.appDir, "agents.md")) {
			t.Errorf("result %v", r)
		}
		if cfg := dst.app.resolveActiveSlotConfig(""); cfg.DefaultAgent != "from-md" {
			t.Errorf("markdown agents written as yaml are not understood: %q", cfg.DefaultAgent)
		}
	})
	t.Run("same extension exists: keep it", func(t *testing.T) {
		dst := newPackEnv(t)
		packWrite(t, dst.appDir, map[string]string{"agents.md": "# old\n"})
		decodeMap(t, mustString(dst.app.PackImport(pack, `{"agents":["agents:app"]}`, "")))
		if got := readFile(t, filepath.Join(dst.appDir, "agents.md")); got != mdAgents || exists(filepath.Join(dst.appDir, "agents.yaml")) {
			t.Errorf("agents.md = %q", got)
		}
	})
	t.Run("a higher-priority file would shadow it: use agents.yaml", func(t *testing.T) {
		dst := newPackEnv(t)
		packWrite(t, dst.appDir, map[string]string{"agents.md": "# old\n", "agents.yaml": "version: 2\ndefault_agent: shadow\n"})
		decodeMap(t, mustString(dst.app.PackImport(pack, `{"agents":["agents:app"]}`, "")))
		if cfg := dst.app.resolveActiveSlotConfig(""); cfg.DefaultAgent != "from-md" {
			t.Errorf("the import is shadowed by agents.yaml: %q", cfg.DefaultAgent)
		}
	})
}

func TestPackImport_SkipsWithAReasonInsteadOfFailing(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()

	t.Run("no project", func(t *testing.T) {
		dst := newPackEnv(t)
		res := decodeMap(t, mustString(dst.app.PackImport(pack, `{"agents":["agents:project","agents:app"],"skills":["skill:skills/alpha"]}`, "")))
		skipped := asList(t, res["skipped"])
		if len(skipped) != 2 {
			t.Fatalf("skipped = %v", skipped)
		}
		for _, s := range skipped {
			if m := s.(map[string]any); m["reason"] == "" || !strings.Contains(m["reason"].(string), " / ") {
				t.Errorf("skip without a bilingual reason: %v", m)
			}
		}
		if len(asList(t, res["applied"].(map[string]any)["agents"])) != 1 {
			t.Error("the app-level agents should still apply without a project")
		}
	})

	t.Run("ids that are not in the pack", func(t *testing.T) {
		dst := newPackEnv(t)
		res := decodeMap(t, mustString(dst.app.PackImport(pack, `{"config":true,"agents":["agents:other","config"],"skills":["skill:skills/ghost","skill:skills/../x"]}`, dst.hint())))
		if len(asList(t, res["skipped"])) != 4 {
			t.Errorf("skipped = %v", res["skipped"])
		}
	})

	t.Run("agents file that does not parse", func(t *testing.T) {
		bad := newPackEnv(t)
		packWrite(t, bad.appDir, map[string]string{"agents.yaml": "version: [unclosed\n  agents: {"})
		bp := bad.export(map[string]any{"includeConfig": false, "agents": []string{"agents:app"}, "skills": []string{}})["path"].(string)
		dst := newPackEnv(t)
		packWrite(t, dst.appDir, map[string]string{"agents.yaml": packTestAppAgents})
		res := decodeMap(t, mustString(dst.app.PackImport(bp, `{"agents":["agents:app"]}`, "")))
		if len(asList(t, res["skipped"])) != 1 || readFile(t, filepath.Join(dst.appDir, "agents.yaml")) != packTestAppAgents || res["backupDir"] != "" {
			t.Errorf("a file that does not parse must be skipped and leave the old one alone: %v", res)
		}
	})

	t.Run("empty agents file", func(t *testing.T) {
		bad := newPackEnv(t)
		packWrite(t, bad.appDir, map[string]string{"agents.yaml": "  \n"})
		bp := bad.export(map[string]any{"includeConfig": false, "agents": []string{"agents:app"}, "skills": []string{}})["path"].(string)
		dst := newPackEnv(t)
		res := decodeMap(t, mustString(dst.app.PackImport(bp, `{"agents":["agents:app"]}`, "")))
		if len(asList(t, res["skipped"])) != 1 || exists(filepath.Join(dst.appDir, "agents.yaml")) {
			t.Errorf("empty agents file: %v", res)
		}
	})
}

func TestPackImport_RefusesToWriteThroughLinks(t *testing.T) {
	src := newPackEnv(t)
	src.fill()
	pack := src.exportedPack()

	dst := newPackEnv(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dst.proj, "skills")); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	res := decodeMap(t, mustString(dst.app.PackImport(pack, `{"skills":["skill:skills/alpha"]}`, dst.hint())))
	if len(asList(t, res["skipped"])) != 1 {
		t.Errorf("skipped = %v", res["skipped"])
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Errorf("wrote through the link: %v", entries)
	}

	// an existing entry that is itself a link is not replaced
	dst2 := newPackEnv(t)
	target := t.TempDir()
	packWrite(t, target, map[string]string{"keep.txt": "keep"})
	packWrite(t, dst2.proj, map[string]string{"skills/other/SKILL.md": "x"})
	if err := os.Symlink(target, filepath.Join(dst2.proj, "skills", "alpha")); err != nil {
		t.Skip(err)
	}
	res = decodeMap(t, mustString(dst2.app.PackImport(pack, `{"skills":["skill:skills/alpha"]}`, dst2.hint())))
	if len(asList(t, res["skipped"])) != 1 || readFile(t, filepath.Join(target, "keep.txt")) != "keep" {
		t.Errorf("a linked skill was replaced: %v", res["skipped"])
	}

	// .md-memo as a link
	dst3 := newPackEnv(t)
	elsewhere := t.TempDir()
	if err := os.Remove(filepath.Join(dst3.proj, ".md-memo")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(dst3.proj, ".md-memo")); err != nil {
		t.Skip(err)
	}
	packWrite(t, dst3.proj, map[string]string{"skills/x/SKILL.md": "x"})
	res = decodeMap(t, mustString(dst3.app.PackImport(pack, `{"agents":["agents:project"]}`, dst3.hint())))
	if len(asList(t, res["skipped"])) != 1 {
		t.Errorf("skipped = %v", res["skipped"])
	}
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Errorf("wrote through .md-memo: %v", entries)
	}
}

// The import tests above only prove something where the OS lets a write through a link succeed;
// this one checks the guard itself, wherever links can be created.
func TestPackLinkOnPath(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := packLinkOnPath(base, "real/sub"); err != nil {
		t.Errorf("plain folders: %v", err)
	}
	if err := packLinkOnPath(base, "missing/deeper"); err != nil {
		t.Errorf("components that do not exist yet: %v", err)
	}
	if err := os.Symlink(real, filepath.Join(base, "link")); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	for _, rel := range []string{"link", "link/sub", "link/not/there/yet"} {
		if err := packLinkOnPath(base, rel); err == nil {
			t.Errorf("packLinkOnPath(%q) followed a link", rel)
		}
	}
	if err := packLinkOnPath(base, "real/sub/x"); err != nil {
		t.Errorf("a real path next to a link: %v", err)
	}
}

func TestPackImport_RequestValidation(t *testing.T) {
	e := newPackEnv(t)
	for name, args := range map[string][3]string{
		"selection not json": {"x", `nope`, ""},
		"empty path":         {"  ", `{}`, ""},
		"missing file":       {filepath.Join(t.TempDir(), "none.mdmemopack"), `{}`, ""},
		"a folder":           {t.TempDir(), `{}`, ""},
	} {
		if out, err := e.app.PackImport(args[0], args[1], args[2]); err == nil {
			t.Errorf("%s: no error (%s)", name, out)
		}
	}
}

// --- bindings and hygiene -------------------------------------------------------------------

func TestPackBindingsOnBothPlatforms(t *testing.T) {
	read := func(name string) string {
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		return strings.ReplaceAll(string(b), "\r\n", "\n")
	}
	win, mac := read("window_windows.go"), read("window_darwin.go")
	for _, name := range []string{"PackListExportable", "PackExport", "PackInspect", "PackImport"} {
		bind := `w.Bind("backend_` + strings.ToLower(name[:1]) + name[1:] + `", app.` + name + `)`
		if !strings.Contains(win, bind) || !strings.Contains(mac, bind) {
			t.Errorf("%s must be bound on both platforms", bind)
		}
		js := strings.ToLower(name[:1]) + name[1:] + ":"
		var lines [2]string
		for i, src := range []string{win, mac} {
			for _, l := range strings.Split(src, "\n") {
				if tl := strings.TrimSpace(l); strings.HasPrefix(tl, js) {
					lines[i] = tl
				}
			}
		}
		if lines[0] == "" || lines[0] != lines[1] {
			t.Errorf("shim for %s differs between platforms:\n win: %s\n mac: %s", name, lines[0], lines[1])
		}
	}
}

func TestPackTestsAreIsolatedFromTheRealConfigFolder(t *testing.T) {
	e := newPackEnv(t)
	e.fill()
	e.export(nil)
	cfg, _ := appdir.ConfigDir()
	if !strings.HasPrefix(e.appDir, cfg) {
		t.Fatalf("the test env is not isolated: %s not under %s", e.appDir, cfg)
	}
	if home, _ := appdir.HomeDir(); home != e.home {
		t.Errorf("home override lost: %s", home)
	}
}

// writeEvilPack writes a pack whose manifest names a skill that climbs out of the project.
func writeEvilPack(t *testing.T, path, name string) {
	t.Helper()
	m := configpack.Manifest{Format: configpack.Format, Version: 1, ConfigSections: []string{}, Items: []configpack.Item{
		{ID: "skill:skills/" + name, Kind: configpack.KindSkill, Root: "skills", Name: name, Entry: configpack.EntryDir},
	}}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct{ name, data string }{
		{configpack.ManifestName, mustJSONString(t, m)},
		{"skills/skills/" + name + "/SKILL.md", "pwned"},
	} {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(f.data))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
}
