// Package configpack reads and writes .mdmemopack settings packages: a zip of a manifest, an
// optional config.json, agents files and project skills. Every pack is hostile input; see Open.
package configpack

import (
	"errors"
	"fmt"
	"strings"
)

const (
	Format  = "md-memo-pack"
	Version = 1

	ManifestName = "manifest.json"
	ConfigPath   = "config/config.json"

	MaxPackBytes     = 50 << 20
	MaxEntries       = 3000
	MaxEntryBytes    = 10 << 20
	MaxTotalBytes    = 100 << 20
	MaxConfigBytes   = 2 << 20
	MaxAgentsBytes   = 1 << 20
	MaxManifestBytes = 256 << 10

	// A real pack's central directory is a few hundred KB; this bounds what archive/zip may parse.
	maxCentralDirBytes = 4 << 20

	maxSections = 64
)

const (
	KindConfig = "config"
	KindAgents = "agents"
	KindSkill  = "skill"

	ScopeApp     = "app"
	ScopeProject = "project"

	EntryDir  = "dir"
	EntryFile = "file"

	IDConfig        = "config"
	IDAgentsApp     = "agents:app"
	IDAgentsProject = "agents:project"
)

var SkillRoots = []string{"skills", ".claude/skills", ".gemini/skills", ".codex/skills"}

// AgentsFileNames is in slotagent.FindAgentConfigFile's priority order.
var AgentsFileNames = []string{"agents.yaml", "agents.yml", "agents.md", "agents.json"}

func biErr(ja, en string) error { return errors.New(ja + " / " + en) }

var (
	ErrNotZip         = biErr("zipファイルではありません", "not a zip file")
	ErrTooLarge       = biErr("サイズが上限を超えています", "size limit exceeded")
	ErrTooManyEntries = biErr("ファイル数が上限を超えています", "too many entries")
	ErrUnsafePath     = biErr("危険なパスを含むため拒否しました", "unsafe path in package")
	ErrBadManifest    = biErr("マニフェストが不正です", "invalid manifest")
	ErrNewerVersion   = biErr("新しいバージョンのパッケージです。アプリを更新してください", "package is from a newer version; update the app")
	ErrBadEntry       = biErr("パッケージ内のファイルが不正です", "invalid entry in package")
	ErrDuplicate      = biErr("同名のエントリが重複しています", "duplicate entry names")
)

type Item struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Scope    string `json:"scope,omitempty"`
	Path     string `json:"path,omitempty"`
	OrigName string `json:"origName,omitempty"`
	Root     string `json:"root,omitempty"`
	Name     string `json:"name,omitempty"`
	Entry    string `json:"entry,omitempty"`
	Files    int    `json:"files,omitempty"`
	Bytes    int64  `json:"bytes"`
}

type Manifest struct {
	Format          string   `json:"format"`
	Version         int      `json:"version"`
	CreatedAt       string   `json:"createdAt"`
	AppVersion      string   `json:"appVersion"`
	IncludesSecrets bool     `json:"includesSecrets"`
	ConfigSections  []string `json:"configSections"`
	Items           []Item   `json:"items"`
}

func (m *Manifest) Item(id string) *Item {
	for i := range m.Items {
		if m.Items[i].ID == id {
			return &m.Items[i]
		}
	}
	return nil
}

func SkillID(root, name string) string { return "skill:" + root + "/" + name }

func AgentsPath(scope string) string { return "agents/" + scope + ".yaml" }

func IsSkillRoot(root string) bool {
	for _, r := range SkillRoots {
		if r == root {
			return true
		}
	}
	return false
}

// AgentsExt maps a stored file name to one of the four extensions the app reads (default .yaml).
func AgentsExt(origName string) string {
	l := strings.ToLower(origName)
	for _, n := range AgentsFileNames {
		if l == n {
			return n[len("agents"):]
		}
	}
	return ".yaml"
}

func agentsOrigName(origName string) string { return "agents" + AgentsExt(origName) }

// ValidateSkillIdent: a dir skill is one folder name, a file skill one *.md name; neither starts with a dot.
func ValidateSkillIdent(root, name, entry string) error {
	if !IsSkillRoot(root) {
		return fmt.Errorf("%w: skill root %q", ErrBadManifest, clip(root))
	}
	if strings.Contains(name, "/") || strings.HasPrefix(name, ".") || ValidateEntryName(name) != nil {
		return fmt.Errorf("%w: skill name %q", ErrBadManifest, clip(name))
	}
	switch entry {
	case EntryDir:
	case EntryFile:
		if !strings.EqualFold(pathExt(name), ".md") {
			return fmt.Errorf("%w: skill file %q", ErrBadManifest, clip(name))
		}
	default:
		return fmt.Errorf("%w: skill entry %q", ErrBadManifest, clip(entry))
	}
	return nil
}

func pathExt(name string) string {
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		return name[i:]
	}
	return ""
}

func CleanSections(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		if s == "" || len(s) > 64 || seen[s] || strings.ContainsAny(s, "\x00\r\n") {
			continue
		}
		seen[s] = true
		out = append(out, s)
		if len(out) == maxSections {
			break
		}
	}
	return out
}

func validateManifest(m *Manifest) error {
	if m.Format != Format {
		return fmt.Errorf("%w: format %q", ErrBadManifest, clip(m.Format))
	}
	if m.Version > Version {
		return ErrNewerVersion
	}
	if m.Version < 1 {
		return fmt.Errorf("%w: version %d", ErrBadManifest, m.Version)
	}
	if len(m.Items) > MaxEntries {
		return ErrTooManyEntries
	}
	if len(m.ConfigSections) > maxSections {
		return fmt.Errorf("%w: too many config sections", ErrBadManifest)
	}
	for _, s := range m.ConfigSections {
		if len(s) > 64 || strings.ContainsAny(s, "\x00\r\n") {
			return fmt.Errorf("%w: config section", ErrBadManifest)
		}
	}
	if m.ConfigSections == nil {
		m.ConfigSections = []string{}
	}
	if m.Items == nil {
		m.Items = []Item{}
	}
	if len(m.CreatedAt) > 64 || len(m.AppVersion) > 64 {
		return fmt.Errorf("%w: header fields", ErrBadManifest)
	}

	seen := map[string]bool{}
	for i := range m.Items {
		it := &m.Items[i]
		if seen[it.ID] {
			return fmt.Errorf("%w: duplicate id %q", ErrBadManifest, clip(it.ID))
		}
		seen[it.ID] = true
		switch it.Kind {
		case KindConfig:
			if it.ID != IDConfig || it.Path != ConfigPath {
				return fmt.Errorf("%w: config item", ErrBadManifest)
			}
		case KindAgents:
			if (it.ID != IDAgentsApp && it.ID != IDAgentsProject) || it.ID != "agents:"+it.Scope || it.Path != AgentsPath(it.Scope) {
				return fmt.Errorf("%w: agents item %q", ErrBadManifest, clip(it.ID))
			}
			it.OrigName = agentsOrigName(it.OrigName)
		case KindSkill:
			if err := ValidateSkillIdent(it.Root, it.Name, it.Entry); err != nil {
				return err
			}
			if it.ID != SkillID(it.Root, it.Name) {
				return fmt.Errorf("%w: skill id %q", ErrBadManifest, clip(it.ID))
			}
		default:
			return fmt.Errorf("%w: kind %q", ErrBadManifest, clip(it.Kind))
		}
	}
	return nil
}

func clip(s string) string {
	if len(s) > 80 {
		return s[:80] + "..."
	}
	return s
}
