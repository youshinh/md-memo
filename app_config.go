package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"md-memo/pkg/appdir"
	"md-memo/pkg/dialog"
	"md-memo/pkg/encoding"
	"md-memo/pkg/slotagent"

	"gopkg.in/yaml.v3"
)

func getConfigFilePath() string {
	configDir, err := appdir.ConfigDir()
	if err != nil {
		configDir = "."
	}
	appDir := filepath.Join(configDir, "md-memo")
	_ = os.MkdirAll(appDir, 0755)
	return filepath.Join(appDir, "config.json")
}

// configCacheEntry memoises one read of config.json, keyed by the file's (modtime,size) plus
// whether it existed at all.
type configCacheEntry struct {
	exists  bool
	modTime time.Time
	size    int64
	content string
}

// readConfigCached returns the contents of config.json, re-reading from disk only when its
// modtime/size changed since the last call (or SaveConfig invalidated the cache).
//
// config.json used to be read from disk three separate times before the first frame was
// painted (InitScrapEngine, InitJevEngine, getInitialGlobalShortcut) and once more on every
// WM_CLOSE / minimize, from the UI thread, via isResidentConfigEnabled. An os.Stat is an
// order of magnitude cheaper than an open+read+close, and on a cold start those reads land
// on a file Defender has not seen yet.
//
// A missing or unreadable file yields "" - exactly what the previous direct implementation
// returned - so first-run behaviour is unchanged.
func (a *App) readConfigCached() string {
	path := getConfigFilePath()

	var modTime time.Time
	var size int64
	exists := false
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
		modTime = fi.ModTime()
		size = fi.Size()
		exists = true
	}

	a.cfgCacheMu.Lock()
	cached := a.cfgCache
	if cached != nil && cached.exists == exists && cached.size == size && cached.modTime.Equal(modTime) {
		content := cached.content
		a.cfgCacheMu.Unlock()
		return content
	}
	a.cfgCacheMu.Unlock()

	content := ""
	if exists {
		if data, err := os.ReadFile(path); err == nil {
			content = string(data)
		}
	}

	a.cfgCacheMu.Lock()
	a.cfgCache = &configCacheEntry{exists: exists, modTime: modTime, size: size, content: content}
	a.cfgCacheMu.Unlock()

	return content
}

// invalidateConfigCache drops the memoised config.json contents so the next read re-derives
// them from disk, rather than relying on a stat comparison a fast successive write could in
// principle race.
func (a *App) invalidateConfigCache() {
	a.cfgCacheMu.Lock()
	a.cfgCache = nil
	a.cfgCacheMu.Unlock()
}

// GetConfig reads configuration from the persistent local JSON file in AppData / ~/.config.
func (a *App) GetConfig() (string, error) {
	return a.readConfigCached(), nil // "" when no config has been saved yet
}

// defaultGlobalSummonShortcut is used when config.json has no shortcuts.globalSummon entry.
// It must match the frontend defaults (DEFAULT_SHORTCUTS_WIN / DEFAULT_SHORTCUTS_MAC in
// frontend/js/app.js) and the documented shortcut: Ctrl+Alt+M, and Option+Cmd+M on macOS.
var defaultGlobalSummonShortcut = func() string {
	if runtime.GOOS == "darwin" {
		return "Cmd+Alt+M"
	}
	return "Ctrl+Alt+M"
}()

// parseGlobalSummonShortcut extracts shortcuts.globalSummon from a raw config.json string,
// falling back to defaultGlobalSummonShortcut for a missing file, malformed JSON, a missing
// section or a blank value. It is pure (no I/O) so both platforms' getInitialGlobalShortcut
// can share it and it can be unit tested without a config file.
func parseGlobalSummonShortcut(configJSON string) string {
	if strings.TrimSpace(configJSON) == "" {
		return defaultGlobalSummonShortcut
	}
	var cfg struct {
		Shortcuts map[string]string `json:"shortcuts"`
	}
	if err := json.Unmarshal([]byte(configJSON), &cfg); err != nil || cfg.Shortcuts == nil {
		return defaultGlobalSummonShortcut
	}
	if sc, ok := cfg.Shortcuts["globalSummon"]; ok && strings.TrimSpace(sc) != "" {
		return sc
	}
	return defaultGlobalSummonShortcut
}

// jevRelevantSettings captures exactly the subset of config.json that InitJevEngine /
// ReloadJevConfig read (see the "action" block in app_jev.go): API key, model, base URL, and
// the feature's enabled flag. It is comparable with == since all fields are plain scalars.
type jevRelevantSettings struct {
	APIKey  string
	Model   string
	BaseURL string
	Enabled bool
}

// parseJevRelevantSettings extracts the Jev-relevant fields from a raw config.json string,
// mirroring the field lookups InitJevEngine performs. It is a pure function (no I/O) so the
// settings-changed comparison in SaveConfig can be unit tested without touching any config file.
func parseJevRelevantSettings(configJSON string) jevRelevantSettings {
	settings := jevRelevantSettings{Enabled: true}
	if configJSON == "" {
		return settings
	}
	var rootCfg map[string]interface{}
	if err := json.Unmarshal([]byte(configJSON), &rootCfg); err != nil {
		return settings
	}
	actRaw, ok := rootCfg["action"]
	if !ok {
		return settings
	}
	actMap, ok := actRaw.(map[string]interface{})
	if !ok {
		return settings
	}
	if k, ok := actMap["apiKey"].(string); ok {
		settings.APIKey = k
	}
	if m, ok := actMap["model"].(string); ok {
		settings.Model = m
	}
	if u, ok := actMap["baseUrl"].(string); ok {
		settings.BaseURL = u
	}
	if e, ok := actMap["enabled"].(bool); ok {
		settings.Enabled = e
	}
	return settings
}

// diffConfigSettings parses the scrap/git-sync and Jev-relevant settings out of configJSON and
// compares them against the previously cached values, reporting whether each subsystem actually
// needs to be reinitialized. It performs no I/O beyond parsing the given string, so it can be
// unit tested directly with an App{} zero value (parseScrapConfig does not read receiver state).
func diffConfigSettings(a *App, prevScrap *ScrapSettings, prevJev *jevRelevantSettings, configJSON string) (newScrap ScrapSettings, scrapChanged bool, newJev jevRelevantSettings, jevChanged bool) {
	newScrap = a.parseScrapConfig(configJSON)
	scrapChanged = prevScrap == nil || *prevScrap != newScrap

	newJev = parseJevRelevantSettings(configJSON)
	jevChanged = prevJev == nil || *prevJev != newJev

	return newScrap, scrapChanged, newJev, jevChanged
}

// SaveConfig saves configuration to the persistent local JSON file in AppData / ~/.config.
// It re-initializes the git-sync engine and/or the Jev client only when the settings each one
// actually reads have changed since the last save - previously every save unconditionally
// re-ran both, which meant every keystroke-adjacent settings save (auto-save, optimistic UI
// round-trips, etc.) triggered a redundant `git pull --rebase` and Jev client rebuild.
func (a *App) SaveConfig(configJSON string) (bool, error) {
	path := getConfigFilePath()
	if err := os.WriteFile(path, []byte(configJSON), 0600); err != nil {
		return false, fmt.Errorf("設定ファイルの書き込みに失敗しました: %w", err)
	}
	// Everything below (and every later GetConfig) must see the new contents, not a copy
	// memoised from a stat that a same-tick rewrite could make look unchanged.
	a.invalidateConfigCache()

	a.settingsMu.Lock()
	newScrap, scrapChanged, newJev, jevChanged := diffConfigSettings(a, a.lastScrapSettings, a.lastJevSettings, configJSON)
	a.lastScrapSettings = &newScrap
	a.lastJevSettings = &newJev
	a.settingsMu.Unlock()

	if scrapChanged {
		a.InitScrapEngine()
		// The scrap directory (and therefore where the external agents.yaml may live) may have
		// changed; force resolveActiveSlotConfig to re-probe rather than trusting a stale cache.
		a.invalidateSlotConfigCache()
	}
	if jevChanged {
		a.ReloadJevConfig()
	}
	return true, nil
}

// ExportConfig exports current settings to a user-chosen JSON file using native save file dialog.
func (a *App) ExportConfig(configJSON string) (bool, error) {
	path, err := dialog.SaveFileDialog("設定をエクスポート", "md-memo-config.json")
	if err != nil {
		return false, fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return false, nil // User cancelled
	}
	if err := os.WriteFile(path, []byte(configJSON), 0600); err != nil {
		return false, fmt.Errorf("設定ファイルのエクスポートに失敗しました: %w", err)
	}
	return true, nil
}

// ImportConfig imports settings from a user-chosen JSON file using native open file dialog.
func (a *App) ImportConfig() (string, error) {
	path, err := dialog.OpenFileDialog("設定をインポート")
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return "", nil // User cancelled
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("設定ファイルの読み込みに失敗しました: %w", err)
	}
	content, _, err := encoding.DetectAndDecode(data)
	if err != nil {
		return "", fmt.Errorf("設定ファイルのデコードに失敗しました: %w", err)
	}
	return content, nil
}

// GetDefaultAgentsConfigYAML returns the commented, AI-agent-friendly default agents.yaml template.
func (a *App) GetDefaultAgentsConfigYAML() string {
	return slotagent.GenerateDefaultAgentsYAML()
}

// GetDefaultAgentsConfigMarkdown returns the AGENTS.md document containing embedded YAML.
func (a *App) GetDefaultAgentsConfigMarkdown() string {
	return slotagent.GenerateDefaultAgentsMarkdown()
}

// GetActiveAgentsConfigStatus returns the source status and path of active agent configuration.
func (a *App) GetActiveAgentsConfigStatus(scrapDir string) map[string]interface{} {
	foundPath := slotagent.FindAgentConfigFile(scrapDir)
	isExternal := (foundPath != "")
	canonicalPath := slotagent.GetDefaultAgentConfigPath()
	defaultAgent := ""

	if isExternal {
		if data, err := os.ReadFile(foundPath); err == nil {
			ext := filepath.Ext(foundPath)
			if parsed, err := slotagent.ParseAgentConfigFile(data, ext); err == nil {
				defaultAgent = parsed.DefaultAgent
			}
		}
	}

	return map[string]interface{}{
		"is_external":    isExternal,
		"active_path":    foundPath,
		"canonical_path": canonicalPath,
		"format":         filepath.Ext(foundPath),
		"default_agent":  defaultAgent,
	}
}

// UpdateActiveAgentsConfigDefaultAgent updates the default_agent in active external agents.yaml.
func (a *App) UpdateActiveAgentsConfigDefaultAgent(scrapDir, agentName string) error {
	foundPath := slotagent.FindAgentConfigFile(scrapDir)
	if foundPath == "" {
		foundPath = slotagent.GetDefaultAgentConfigPath()
	}
	if foundPath == "" {
		return fmt.Errorf("agent config file not found")
	}

	data, err := os.ReadFile(foundPath)
	if err != nil {
		return err
	}

	content := string(data)
	re := regexp.MustCompile(`(?m)^(\s*default_agent\s*:\s*)[^\r\n#]+`)
	if re.MatchString(content) {
		content = re.ReplaceAllString(content, fmt.Sprintf("${1}%s", agentName))
	} else {
		verRe := regexp.MustCompile(`(?m)^(\s*version\s*:\s*[^\r\n]+)`)
		if verRe.MatchString(content) {
			content = verRe.ReplaceAllString(content, fmt.Sprintf("${1}\ndefault_agent: %s", agentName))
		} else {
			content = fmt.Sprintf("default_agent: %s\n", agentName) + content
		}
	}

	return os.WriteFile(foundPath, []byte(content), 0644)
}

// ExportAgentsConfigFile exports a commented agents config file (.yaml, .md, or .json) via SaveFileDialog.
func (a *App) ExportAgentsConfigFile(format string) (string, error) {
	defaultName := "agents.yaml"
	content := slotagent.GenerateDefaultAgentsYAML()

	if strings.EqualFold(format, "md") || strings.EqualFold(format, "markdown") {
		defaultName = "AGENTS.md"
		content = slotagent.GenerateDefaultAgentsMarkdown()
	} else if strings.EqualFold(format, "json") {
		defaultName = "agents.json"
		cfg := slotagent.DefaultSlotConfig()
		b, _ := json.MarshalIndent(cfg, "", "  ")
		content = string(b)
	}

	path, err := dialog.SaveFileDialog("エージェント設定テンプレートを書き出し", defaultName)
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return "", nil // Cancelled
	}

	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("設定ファイルの書き込みに失敗しました: %w", err)
	}

	return path, nil
}

// ImportAgentsConfigFile opens a file dialog, parses the chosen agent config (.yaml, .yml, .json, .md),
// validates it, saves a copy to user AppData/agents.yaml, and returns the parsed config as JSON.
func (a *App) ImportAgentsConfigFile() (string, error) {
	path, err := dialog.OpenFileDialog("エージェント設定ファイルをインポート (YAML / JSON / Markdown)")
	if err != nil {
		return "", fmt.Errorf("ファイルダイアログエラー: %w", err)
	}
	if path == "" {
		return "", nil // Cancelled
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("設定ファイルの読み込みに失敗しました: %w", err)
	}

	ext := filepath.Ext(path)
	parsedCfg, err := slotagent.ParseAgentConfigFile(data, ext)
	if err != nil {
		return "", fmt.Errorf("設定ファイルの構文エラー: %w", err)
	}

	// Save copy to canonical AppData location
	canonicalPath := slotagent.GetDefaultAgentConfigPath()
	_ = os.MkdirAll(filepath.Dir(canonicalPath), 0755)
	yamlBytes, err := yaml.Marshal(&parsedCfg)
	if err == nil {
		_ = os.WriteFile(canonicalPath, yamlBytes, 0644)
	}
	// The canonical agents file just changed on disk; force resolveActiveSlotConfig to re-probe
	// rather than potentially reusing a cached result keyed by its old mtime/size.
	a.invalidateSlotConfigCache()

	// Return json representation for frontend
	jsonBytes, err := json.Marshal(parsedCfg)
	if err != nil {
		return "", fmt.Errorf("JSONシリアライズ失敗: %w", err)
	}

	return string(jsonBytes), nil
}

// OpenAgentsConfigFile ensures the external agents.yaml exists (generating default with comments if missing)
// and returns the canonical absolute path so MD-Memo can open it directly in its own editor tab.
func (a *App) OpenAgentsConfigFile(scrapDir string) (string, error) {
	targetPath := slotagent.FindAgentConfigFile(scrapDir)
	if targetPath == "" {
		targetPath = slotagent.GetDefaultAgentConfigPath()
		_ = os.MkdirAll(filepath.Dir(targetPath), 0755)
		content := slotagent.GenerateDefaultAgentsYAML()
		if err := os.WriteFile(targetPath, []byte(content), 0644); err != nil {
			return "", fmt.Errorf("初期設定ファイルの生成に失敗しました: %w", err)
		}
	}

	return targetPath, nil
}
