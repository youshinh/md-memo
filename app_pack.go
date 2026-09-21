package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/configpack"
	"md-memo/pkg/dialog"
	"md-memo/pkg/encoding"
	"md-memo/pkg/scrap"
	"md-memo/pkg/slotagent"
)

// Dialogs and the clock sit behind variables so tests never open a window or depend on time.
var (
	packSaveDialog = dialog.SaveFileDialog
	packOpenDialog = dialog.OpenFileDialog
	packNow        = time.Now
)

func packErr(ja, en string, err error) error {
	if err != nil {
		return fmt.Errorf("%s / %s: %w", ja, en, err)
	}
	return fmt.Errorf("%s / %s", ja, en)
}

func packJSON(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func packIsDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

func packLinkLike(m fs.FileMode) bool { return m&(fs.ModeSymlink|fs.ModeIrregular) != 0 }

func packUnique(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// packProjectRoot: the hint's project, else the scraps folder, else "" (nothing project-level).
func (a *App) packProjectRoot(hint string) string {
	root, _ := a.packProjectRootNote(hint)
	return root
}

const packNoteHomeIsNotProject = "ホームフォルダはプロジェクトとして扱いません（.claude/skills などは全体設定のため）/ the home folder is not treated as a project: its .claude/skills and similar folders are global"

// FindProjectRoot climbs and counts .git, so a dotfiles repo makes the home folder a "project"
// whose .claude/skills are the user's global ones, which a package must never carry.
func (a *App) packProjectRootNote(hint string) (root, note string) {
	target := strings.TrimSpace(hint)
	if target == "" {
		target = scrap.ResolveScrapDir(a.parseScrapConfig(a.readConfigCached()).ScrapDir)
		if !packIsDir(target) {
			return "", ""
		}
	}
	root = slotagent.FindProjectRoot(target)
	if !packIsDir(root) {
		return "", ""
	}
	if home, err := appdir.HomeDir(); err == nil {
		if rel, err := filepath.Rel(root, home); err == nil && !strings.HasPrefix(rel, "..") {
			return "", packNoteHomeIsNotProject
		}
	}
	return root, ""
}

func packFirstAgentsFile(dir string, followLinks bool) string {
	for _, n := range configpack.AgentsFileNames {
		p := filepath.Join(dir, n)
		stat := os.Lstat
		if followLinks {
			stat = os.Stat
		}
		if fi, err := stat(p); err == nil && fi.Mode().IsRegular() {
			return p
		}
	}
	return ""
}

// A link in the user's own config folder is honoured.
func packAppAgentsFile() string {
	dir, err := inputsAppDir()
	if err != nil {
		return ""
	}
	return packFirstAgentsFile(dir, true)
}

// packProjectAgentsFile is <project>/.md-memo/agents.*. A project can be someone else's
// checkout, so links are refused: a link there must not pull an arbitrary file into a pack.
func packProjectAgentsFile(projectRoot string) string {
	if projectRoot == "" || packLinkOnPath(projectRoot, ".md-memo") != nil {
		return ""
	}
	return packFirstAgentsFile(filepath.Join(projectRoot, ".md-memo"), false)
}

func packLinkOnPath(base, rel string) error {
	cur := base
	for _, part := range strings.Split(rel, "/") {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if err != nil {
			return nil
		}
		if packLinkLike(fi.Mode()) {
			return fmt.Errorf("%s is a symbolic link", cur)
		}
	}
	return nil
}

func packReadCapped(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, configpack.ErrTooLarge
	}
	return data, nil
}

func packWriteFile(path string, data []byte, perm fs.FileMode) error {
	return packWriteAtomic(path, perm, func(w io.Writer) error {
		_, err := w.Write(data)
		return err
	})
}

// packWriteAtomic renames over path so a failed write never leaves a half-written file.
func packWriteAtomic(path string, perm fs.FileMode, fill func(io.Writer) error) (err error) {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".mdmemo-pack-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(name)
		}
	}()
	bw := bufio.NewWriterSize(tmp, 256<<10)
	if err = fill(bw); err != nil {
		return err
	}
	if err = bw.Flush(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, perm); err != nil {
		return err
	}
	return os.Rename(name, path)
}

type packListAgents struct {
	ID    string `json:"id"`
	Scope string `json:"scope"`
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

func (a *App) PackListExportable(projectHint string) (string, error) {
	res := struct {
		ProjectRoot string             `json:"projectRoot"`
		Agents      []packListAgents   `json:"agents"`
		Skills      []configpack.Skill `json:"skills"`
		Warnings    []string           `json:"warnings"`
	}{Agents: []packListAgents{}, Skills: []configpack.Skill{}, Warnings: []string{}}

	var note string
	res.ProjectRoot, note = a.packProjectRootNote(projectHint)
	if note != "" {
		res.Warnings = append(res.Warnings, note)
	}
	add := func(id, scope, path string) {
		if path == "" {
			return
		}
		fi, err := os.Stat(path)
		if err != nil {
			return
		}
		if fi.Size() > configpack.MaxAgentsBytes {
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s は1MBを超えるため対象外です / %s is over 1 MB and was left out", path, path))
			return
		}
		res.Agents = append(res.Agents, packListAgents{ID: id, Scope: scope, Path: path, Bytes: fi.Size()})
	}
	add(configpack.IDAgentsApp, configpack.ScopeApp, packAppAgentsFile())
	if res.ProjectRoot != "" {
		add(configpack.IDAgentsProject, configpack.ScopeProject, packProjectAgentsFile(res.ProjectRoot))
		skills, warns := configpack.DiscoverSkills(res.ProjectRoot)
		res.Skills = append(res.Skills, skills...)
		res.Warnings = append(res.Warnings, warns...)
	}
	return packJSON(res)
}

type packExportSelection struct {
	Format         string   `json:"format"`
	ProjectHint    string   `json:"projectHint"`
	IncludeSecrets bool     `json:"includeSecrets"`
	ConfigSections []string `json:"configSections"`
	IncludeConfig  bool     `json:"includeConfig"`
	Agents         []string `json:"agents"`
	Skills         []string `json:"skills"`
}

// PackExport: configJSON is already reduced to the chosen sections; it is only scanned for credentials here.
func (a *App) PackExport(selectionJSON, configJSON string) (string, error) {
	var sel packExportSelection
	if err := json.Unmarshal([]byte(selectionJSON), &sel); err != nil {
		return "", packErr("選択内容が不正です", "invalid selection", err)
	}
	if sel.Format == "" {
		sel.Format = "pack"
	}
	if sel.Format != "pack" && sel.Format != "json" {
		return "", packErr("書き出し形式が不正です", "unknown export format", nil)
	}
	if len(sel.Agents) > 8 || len(sel.Skills) > configpack.MaxEntries {
		return "", packErr("選択数が多すぎます", "too many items selected", nil)
	}

	warnings := []string{}
	stripped, secretWarnings, secretsFound := 0, 0, 0

	var cfg []byte
	if sel.IncludeConfig || sel.Format == "json" {
		if len(configJSON) > configpack.MaxConfigBytes {
			return "", packErr("設定が大きすぎます", "settings are too large", configpack.ErrTooLarge)
		}
		cfg = []byte(configJSON)
		if !strings.HasPrefix(strings.TrimSpace(configJSON), "{") || !json.Valid(cfg) {
			return "", packErr("設定のJSONが不正です", "settings are not a JSON object", nil)
		}
		if sel.IncludeSecrets {
			n, _ := configpack.CountSecrets(cfg)
			secretsFound += n
		} else {
			out, n, err := configpack.StripJSON(cfg)
			if err != nil {
				return "", packErr("設定のJSONが不正です", "settings are not valid JSON", err)
			}
			cfg, stripped = out, stripped+n
		}
	}

	if sel.Format == "json" {
		path, err := packSaveDialog("設定をエクスポート", "md-memo-config.json")
		if err != nil {
			return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
		}
		if path == "" {
			return `{"ok":false,"cancelled":true}`, nil
		}
		if err := packWriteFile(path, cfg, 0o600); err != nil {
			return "", packErr("書き出しに失敗しました", "export failed", err)
		}
		return packExportResult(path, 1, 0, 0, 1, int64(len(cfg)), stripped, 0, warnings)
	}

	root := a.packProjectRoot(sel.ProjectHint)
	var agents []configpack.AgentsInput
	for _, id := range packUnique(sel.Agents) {
		var scope, path string
		switch id {
		case configpack.IDAgentsApp:
			scope, path = configpack.ScopeApp, packAppAgentsFile()
		case configpack.IDAgentsProject:
			scope, path = configpack.ScopeProject, packProjectAgentsFile(root)
		default:
			warnings = append(warnings, "不明な項目を無視しました / ignored unknown item: "+id)
			continue
		}
		if path == "" {
			warnings = append(warnings, id+" が見つかりません / not found")
			continue
		}
		data, err := packReadCapped(path, configpack.MaxAgentsBytes)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("%s を読み込めません / cannot read %s: %v", path, path, err))
			continue
		}
		out, n, warned := configpack.StripAgents(data, filepath.Base(path))
		if sel.IncludeSecrets {
			secretsFound += n
		} else {
			data, stripped = out, stripped+n
			if warned {
				secretWarnings++
				warnings = append(warnings, fmt.Sprintf("%s に秘密情報が残っている可能性があります / %s may still contain secrets (left unchanged)", path, path))
			}
		}
		agents = append(agents, configpack.AgentsInput{Scope: scope, OrigName: filepath.Base(path), Data: data})
	}

	var skills []configpack.Skill
	if len(sel.Skills) > 0 {
		found, warns := configpack.DiscoverSkills(root)
		warnings = append(warnings, warns...)
		byID := make(map[string]configpack.Skill, len(found))
		for _, s := range found {
			byID[s.ID] = s
		}
		for _, id := range packUnique(sel.Skills) {
			if s, ok := byID[id]; ok {
				skills = append(skills, s)
			} else {
				warnings = append(warnings, id+" が見つかりません / not found")
			}
		}
	}

	if cfg == nil && len(agents) == 0 && len(skills) == 0 {
		return "", packErr("書き出す項目がありません", "nothing selected to export", nil)
	}

	path, err := packSaveDialog("パッケージを書き出し", "md-memo-"+packNow().Format("20060102")+".mdmemopack")
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return `{"ok":false,"cancelled":true}`, nil
	}

	in := configpack.Input{
		AppVersion:      AppVersion,
		CreatedAt:       packNow(),
		IncludesSecrets: sel.IncludeSecrets && secretsFound > 0,
		ConfigSections:  sel.ConfigSections,
		Config:          cfg,
		Agents:          agents,
		Skills:          skills,
	}
	var built configpack.Result
	err = packWriteAtomic(path, 0o600, func(w io.Writer) error {
		var berr error
		built, berr = configpack.Build(w, in)
		return berr
	})
	if err != nil {
		return "", packErr("パッケージの作成に失敗しました", "could not build the package", err)
	}
	size := int64(0)
	if fi, err := os.Stat(path); err == nil {
		size = fi.Size()
	}
	nCfg := 0
	if cfg != nil {
		nCfg = 1
	}
	return packExportResult(path, nCfg, len(agents), len(skills), built.Files, size, stripped, secretWarnings, warnings)
}

// packExportResult's bytes is the size of the file that was written.
func packExportResult(path string, cfg, agents, skills, files int, bytes int64, stripped, secretWarnings int, warnings []string) (string, error) {
	return packJSON(map[string]any{
		"ok":   true,
		"path": path,
		"counts": map[string]any{
			"config": cfg, "agents": agents, "skills": skills, "files": files, "bytes": bytes,
		},
		"secretsStripped": stripped,
		"secretWarnings":  secretWarnings,
		"warnings":        warnings,
	})
}

func packReadLegacy(path string) (string, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", packErr("ファイルを開けません", "cannot open the file", err)
	}
	if !fi.Mode().IsRegular() {
		return "", packErr("ファイルを開けません", "not a regular file", nil)
	}
	if fi.Size() > configpack.MaxConfigBytes {
		return "", packErr("ファイルが大きすぎます", "file is too large", configpack.ErrTooLarge)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", packErr("ファイルを読み込めません", "cannot read the file", err)
	}
	content, _, err := encoding.DetectAndDecode(data)
	if err != nil {
		return "", packErr("設定ファイルのデコードに失敗しました", "cannot decode the file", err)
	}
	content = strings.TrimSpace(content)
	if !strings.HasPrefix(content, "{") || !json.Valid([]byte(content)) {
		return "", packErr("パッケージでも設定JSONでもありません", "not a settings package or a settings JSON file", nil)
	}
	return content, nil
}

type packInspectConfig struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Sections []string `json:"sections"`
}

type packInspectAgents struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Scope  string `json:"scope"`
	Bytes  int64  `json:"bytes"`
	Exists bool   `json:"exists"`
}

type packInspectSkill struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Root   string `json:"root"`
	Name   string `json:"name"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
	Exists bool   `json:"exists"`
}

func (a *App) PackInspect(projectHint string) (string, error) {
	path, err := packOpenDialog("パッケージを開く")
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return `{"cancelled":true}`, nil
	}
	root, rootNote := a.packProjectRootNote(projectHint)
	zipped, err := configpack.IsZipFile(path)
	if err != nil {
		return "", packErr("ファイルを開けません", "cannot open the file", err)
	}

	res := struct {
		PackPath    string              `json:"packPath"`
		Legacy      bool                `json:"legacy"`
		ProjectRoot string              `json:"projectRoot"`
		Manifest    configpack.Manifest `json:"manifest"`
		Items       []any               `json:"items"`
		Warnings    []string            `json:"warnings"`
	}{PackPath: path, ProjectRoot: root, Items: []any{}, Warnings: []string{}}

	if !zipped {
		content, err := packReadLegacy(path)
		if err != nil {
			return "", err
		}
		n, _ := configpack.CountSecrets([]byte(content))
		res.Legacy = true
		res.Manifest = configpack.Manifest{
			Format: configpack.Format, Version: configpack.Version, IncludesSecrets: n > 0,
			ConfigSections: []string{},
			Items:          []configpack.Item{{ID: configpack.IDConfig, Kind: configpack.KindConfig, Path: configpack.ConfigPath, Bytes: int64(len(content))}},
		}
		res.Items = append(res.Items, packInspectConfig{ID: configpack.IDConfig, Kind: configpack.KindConfig, Sections: []string{}})
		return packJSON(res)
	}

	pk, err := configpack.Open(path)
	if err != nil {
		return "", packErr("パッケージを開けません", "cannot open the package", err)
	}
	defer pk.Close()
	res.Manifest = pk.Manifest

	projectItems := false
	for _, it := range pk.Manifest.Items {
		switch it.Kind {
		case configpack.KindConfig:
			res.Items = append(res.Items, packInspectConfig{ID: it.ID, Kind: it.Kind, Sections: pk.Manifest.ConfigSections})
		case configpack.KindAgents:
			exists := false
			if it.Scope == configpack.ScopeApp {
				exists = packAppAgentsFile() != ""
			} else {
				projectItems = true
				exists = packProjectAgentsFile(root) != ""
			}
			res.Items = append(res.Items, packInspectAgents{ID: it.ID, Kind: it.Kind, Scope: it.Scope, Bytes: it.Bytes, Exists: exists})
		case configpack.KindSkill:
			projectItems = true
			files, bytes, _ := pk.SkillStats(it.ID)
			exists := false
			if root != "" {
				_, err := os.Lstat(filepath.Join(root, filepath.FromSlash(it.Root), it.Name))
				exists = err == nil
			}
			res.Items = append(res.Items, packInspectSkill{ID: it.ID, Kind: it.Kind, Root: it.Root, Name: it.Name, Files: files, Bytes: bytes, Exists: exists})
		}
	}
	if projectItems && root == "" {
		res.Warnings = append(res.Warnings, "プロジェクトが見つからないため、プロジェクトの項目は取り込めません / no project folder: project agents and skills cannot be imported")
		if rootNote != "" {
			res.Warnings = append(res.Warnings, rootNote)
		}
	}
	if pk.Ignored > 0 {
		res.Warnings = append(res.Warnings, fmt.Sprintf("マニフェストにないファイル %d 件は無視します / ignoring %d file(s) not listed in the manifest", pk.Ignored, pk.Ignored))
	}
	if pk.Skipped > 0 {
		res.Warnings = append(res.Warnings, fmt.Sprintf(".env や .git などのファイル %d 件は取り込みません / %d file(s) such as .env or .git are never restored", pk.Skipped, pk.Skipped))
	}
	return packJSON(res)
}

type packImportSelection struct {
	Config bool     `json:"config"`
	Agents []string `json:"agents"`
	Skills []string `json:"skills"`
}

type packApplied struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Files int    `json:"files,omitempty"`
}

type packSkipped struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// packBackup copies what an import overwrites into <config>/md-memo/pack_backups/<timestamp>/,
// outside the project so skill folders never pick up clutter.
type packBackup struct {
	dir string
	now time.Time
}

func (b *packBackup) ensure() error {
	if b.dir != "" {
		return nil
	}
	app, err := inputsAppDir()
	if err != nil {
		return err
	}
	base := filepath.Join(app, "pack_backups")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return err
	}
	stamp := b.now.Format("20060102-150405")
	for i := 1; i <= 100; i++ {
		name := stamp
		if i > 1 {
			name = fmt.Sprintf("%s-%d", stamp, i)
		}
		err := os.Mkdir(filepath.Join(base, name), 0o700)
		if err == nil {
			b.dir = filepath.Join(base, name)
			return nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return err
		}
	}
	return errors.New("no free backup folder name")
}

func (b *packBackup) save(src, rel string) error {
	if err := b.ensure(); err != nil {
		return err
	}
	dst := filepath.Join(b.dir, rel)
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		sub, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, sub)
		switch {
		case packLinkLike(d.Type()):
			return nil
		case d.IsDir():
			return os.MkdirAll(out, 0o700)
		case !d.Type().IsRegular():
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
			return err
		}
		return packCopyFile(p, out)
	})
}

func packCopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// PackImport re-validates the file itself. Settings come back in configJSON rather than being
// written: the running app owns config.json.
func (a *App) PackImport(packPath, selectionJSON, projectHint string) (string, error) {
	var sel packImportSelection
	if err := json.Unmarshal([]byte(selectionJSON), &sel); err != nil {
		return "", packErr("選択内容が不正です", "invalid selection", err)
	}
	packPath = strings.TrimSpace(packPath)
	if packPath == "" {
		return "", packErr("パッケージが指定されていません", "no package path", nil)
	}
	zipped, err := configpack.IsZipFile(packPath)
	if err != nil {
		return "", packErr("ファイルを開けません", "cannot open the file", err)
	}

	res := struct {
		OK             bool     `json:"ok"`
		ConfigJSON     string   `json:"configJSON"`
		ConfigSections []string `json:"configSections"`
		Applied        struct {
			Agents []packApplied `json:"agents"`
			Skills []packApplied `json:"skills"`
		} `json:"applied"`
		BackupDir    string        `json:"backupDir"`
		Skipped      []packSkipped `json:"skipped"`
		NeedsRestart bool          `json:"needsRestart"`
	}{OK: true, ConfigSections: []string{}, Skipped: []packSkipped{}}
	res.Applied.Agents = []packApplied{}
	res.Applied.Skills = []packApplied{}
	skip := func(id, reason string) { res.Skipped = append(res.Skipped, packSkipped{ID: id, Reason: reason}) }

	if !zipped {
		if sel.Config {
			content, err := packReadLegacy(packPath)
			if err != nil {
				return "", err
			}
			res.ConfigJSON = content
		}
		res.NeedsRestart = res.ConfigJSON != ""
		return packJSON(res)
	}

	pk, err := configpack.Open(packPath)
	if err != nil {
		return "", packErr("パッケージを開けません", "cannot open the package", err)
	}
	defer pk.Close()

	root := a.packProjectRoot(projectHint)
	bk := &packBackup{now: packNow()}

	if sel.Config {
		if pk.Manifest.Item(configpack.IDConfig) == nil {
			skip(configpack.IDConfig, "パッケージに設定が含まれていません / the package has no settings")
		} else if data, err := pk.ReadConfig(); err != nil {
			skip(configpack.IDConfig, err.Error())
		} else {
			res.ConfigJSON = string(data)
			res.ConfigSections = pk.Manifest.ConfigSections
		}
	}

	for _, id := range packUnique(sel.Agents) {
		it := pk.Manifest.Item(id)
		if it == nil || it.Kind != configpack.KindAgents {
			skip(id, "パッケージにありません / not in the package")
			continue
		}
		if applied, reason := packImportAgents(pk, it, root, bk); reason != "" {
			skip(id, reason)
		} else {
			res.Applied.Agents = append(res.Applied.Agents, applied)
		}
	}
	if len(res.Applied.Agents) > 0 {
		a.invalidateSlotConfigCache()
	}

	for _, id := range packUnique(sel.Skills) {
		it := pk.Manifest.Item(id)
		if it == nil || it.Kind != configpack.KindSkill {
			skip(id, "パッケージにありません / not in the package")
			continue
		}
		if applied, reason := packImportSkill(pk, it, root, bk); reason != "" {
			skip(id, reason)
		} else {
			res.Applied.Skills = append(res.Applied.Skills, applied)
		}
	}

	res.BackupDir = bk.dir
	res.NeedsRestart = res.ConfigJSON != ""
	return packJSON(res)
}

const packReasonNoProject = "プロジェクトが見つかりません / no project folder"

func packImportAgents(pk *configpack.Pack, it *configpack.Item, root string, bk *packBackup) (packApplied, string) {
	data, ext, err := pk.ReadAgents(it.ID)
	if err != nil {
		return packApplied{}, err.Error()
	}
	if strings.TrimSpace(string(data)) == "" {
		return packApplied{}, "空のファイルです / the file is empty"
	}
	if _, err := slotagent.ParseAgentConfigFile(data, ext); err != nil {
		return packApplied{}, "構文エラー / does not parse: " + err.Error()
	}

	var target, backupRel string
	if it.Scope == configpack.ScopeApp {
		dir, err := inputsAppDir()
		if err != nil {
			return packApplied{}, err.Error()
		}
		target = packAppAgentsTarget(dir, ext)
		backupRel = filepath.Join("app", filepath.Base(target))
	} else {
		if root == "" {
			return packApplied{}, packReasonNoProject
		}
		if err := packLinkOnPath(root, ".md-memo/agents.yaml"); err != nil {
			return packApplied{}, "シンボリックリンクの中には書き込みません / refusing to write through a symbolic link"
		}
		target = filepath.Join(root, ".md-memo", "agents.yaml")
		backupRel = filepath.Join("project", ".md-memo", "agents.yaml")
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return packApplied{}, "フォルダを作れません / cannot create the folder: " + err.Error()
	}
	if _, err := os.Stat(target); err == nil {
		if err := bk.save(target, backupRel); err != nil {
			return packApplied{}, "バックアップに失敗しました / backup failed: " + err.Error()
		}
	}
	if err := packWriteFile(target, data, 0o644); err != nil {
		return packApplied{}, "書き込みに失敗しました / write failed: " + err.Error()
	}
	return packApplied{ID: it.ID, Path: target}, ""
}

// packAppAgentsTarget keeps the pack's original extension only when that file already exists
// and nothing of higher priority shadows it; otherwise agents.yaml, which always wins the lookup.
func packAppAgentsTarget(dir, ext string) string {
	yaml := filepath.Join(dir, "agents.yaml")
	if ext == ".yaml" {
		return yaml
	}
	for _, n := range configpack.AgentsFileNames {
		p := filepath.Join(dir, n)
		exists := false
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			exists = true
		}
		if n == "agents"+ext {
			if exists {
				return p
			}
			break
		}
		if exists {
			return yaml
		}
	}
	return yaml
}

func packImportSkill(pk *configpack.Pack, it *configpack.Item, root string, bk *packBackup) (packApplied, string) {
	if root == "" {
		return packApplied{}, packReasonNoProject
	}
	if err := packLinkOnPath(root, it.Root); err != nil {
		return packApplied{}, "シンボリックリンクの中には書き込みません / refusing to write through a symbolic link"
	}
	rootDir := filepath.Join(root, filepath.FromSlash(it.Root))
	target := filepath.Join(rootDir, it.Name)
	existing, statErr := os.Lstat(target)
	if statErr == nil && packLinkLike(existing.Mode()) {
		return packApplied{}, "既存のシンボリックリンクは置き換えません / the existing entry is a symbolic link"
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return packApplied{}, "フォルダを作れません / cannot create the folder: " + err.Error()
	}

	// Unpack beside the target first (same volume, dot-named so skill discovery ignores it), so a
	// failure half-way leaves the existing skill untouched.
	stage, err := os.MkdirTemp(rootDir, ".mdmemo-import-*")
	if err != nil {
		return packApplied{}, "作業フォルダを作れません / cannot create a working folder: " + err.Error()
	}
	defer os.RemoveAll(stage)
	files, _, err := pk.ExtractSkill(it.ID, stage)
	if err != nil {
		return packApplied{}, "展開に失敗しました / extraction failed: " + err.Error()
	}

	fresh := filepath.Join(stage, it.Name)
	if statErr == nil {
		if err := bk.save(target, filepath.Join("project", filepath.FromSlash(it.Root), it.Name)); err != nil {
			return packApplied{}, "バックアップに失敗しました / backup failed: " + err.Error()
		}
		old := filepath.Join(stage, ".replaced")
		if err := os.Rename(target, old); err != nil {
			return packApplied{}, "置き換えできません（使用中の可能性）/ cannot replace it (in use?): " + err.Error()
		}
		if err := os.Rename(fresh, target); err != nil {
			_ = os.Rename(old, target)
			return packApplied{}, "置き換えに失敗しました / replace failed: " + err.Error()
		}
	} else if err := os.Rename(fresh, target); err != nil {
		return packApplied{}, "配置に失敗しました / placing failed: " + err.Error()
	}
	return packApplied{ID: it.ID, Path: target, Files: files}, ""
}
