package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sync/atomic"
	"time"

	"md-memo/pkg/gitsync"
	"md-memo/pkg/scrap"
	"md-memo/pkg/search"
)

// ScrapSettings models the configuration for daily scraps and git sync.
type ScrapSettings struct {
	ScrapDir               string `json:"scrap_dir"`
	GitSyncEnabled         bool   `json:"git_sync_enabled"`
	GitSyncDebounceSeconds int    `json:"git_sync_debounce_seconds"`
	GitRemoteBranch        string `json:"git_remote_branch"`
	MaxPipeSizeMB          int    `json:"max_pipe_size_mb"`
}

func (a *App) parseScrapConfig(configJSON string) ScrapSettings {
	cfg := ScrapSettings{
		ScrapDir:               "~/Documents/md-memo/scraps",
		GitSyncEnabled:         true,
		GitSyncDebounceSeconds: 30,
		GitRemoteBranch:        "main",
		MaxPipeSizeMB:          10,
	}
	if configJSON == "" {
		return cfg
	}

	var raw map[string]interface{}
	if err := json.Unmarshal([]byte(configJSON), &raw); err != nil {
		return cfg
	}

	// Check top-level fields
	if v, ok := raw["scrap_dir"].(string); ok && v != "" {
		cfg.ScrapDir = v
	}
	if v, ok := raw["git_sync_enabled"].(bool); ok {
		cfg.GitSyncEnabled = v
	}
	if v, ok := raw["git_sync_debounce_seconds"].(float64); ok && v > 0 {
		cfg.GitSyncDebounceSeconds = int(v)
	}
	if v, ok := raw["git_remote_branch"].(string); ok && v != "" {
		cfg.GitRemoteBranch = v
	}
	if v, ok := raw["max_pipe_size_mb"].(float64); ok && v > 0 {
		cfg.MaxPipeSizeMB = int(v)
	}

	// Also check nested scraps object if present
	if scrapsMap, ok := raw["scraps"].(map[string]interface{}); ok {
		if v, ok := scrapsMap["scrapDir"].(string); ok && v != "" {
			cfg.ScrapDir = v
		}
		if v, ok := scrapsMap["gitSyncEnabled"].(bool); ok {
			cfg.GitSyncEnabled = v
		}
		if v, ok := scrapsMap["gitSyncDebounceSeconds"].(float64); ok && v > 0 {
			cfg.GitSyncDebounceSeconds = int(v)
		}
		if v, ok := scrapsMap["gitRemoteBranch"].(string); ok && v != "" {
			cfg.GitRemoteBranch = v
		}
		if v, ok := scrapsMap["maxPipeSizeMB"].(float64); ok && v > 0 {
			cfg.MaxPipeSizeMB = int(v)
		}
	}

	return cfg
}

// InitScrapEngine initializes or updates the background Git sync engine and scrap directory.
func (a *App) InitScrapEngine() {
	cfgStr, _ := a.GetConfig()
	s := a.parseScrapConfig(cfgStr)

	resolvedDir := scrap.ResolveScrapDir(s.ScrapDir)

	a.gitMu.Lock()
	a.scrapDir = resolvedDir
	gitCfg := gitsync.Config{
		Enabled:         s.GitSyncEnabled,
		ScrapDir:        resolvedDir,
		DebounceSeconds: s.GitSyncDebounceSeconds,
		RemoteBranch:    s.GitRemoteBranch,
		StatusCallback: func(status, message string) {
			a.notifyGitStatus(status, message)
		},
	}
	if a.gitEngine == nil {
		a.gitEngine = gitsync.NewEngine(gitCfg)
	} else {
		a.gitEngine.UpdateConfig(gitCfg)
	}
	engine := a.gitEngine
	enabled := s.GitSyncEnabled
	a.gitMu.Unlock()

	// Startup background pull if enabled, otherwise notify disabled status
	if engine != nil && enabled {
		engine.PullRebaseAsync()
	} else {
		a.notifyGitStatus("disabled", "Git sync is disabled in settings")
	}
}

func (a *App) notifyGitStatus(status, message string) {
	if a.w == nil {
		return
	}
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			msgJSON, _ := json.Marshal(message)
			js := fmt.Sprintf("if (window.onGitSyncStatus) { window.onGitSyncStatus({ status: %q, message: %s }); }", status, string(msgJSON))
			a.w.Eval(js)
		}
	})
}

// GetScrapDir returns the resolved absolute directory for daily scraps.
func (a *App) GetScrapDir() string {
	a.gitMu.RLock()
	defer a.gitMu.RUnlock()
	if a.scrapDir == "" {
		return scrap.ResolveScrapDir("~/Documents/md-memo/scraps")
	}
	return a.scrapDir
}

// TriggerGitSync restarts debounce timer for auto committing and pushing scraps.
func (a *App) TriggerGitSync() {
	a.gitMu.RLock()
	engine := a.gitEngine
	a.gitMu.RUnlock()
	if engine != nil {
		engine.Trigger()
	}
}

// SearchScraps concurrently scans all .md files in the scrap directory.
func (a *App) SearchScraps(query string, maxResults int) ([]search.SearchResult, error) {
	scrapDir := a.GetScrapDir()
	return search.SearchScraps(scrapDir, query, maxResults)
}

// SearchScrapsAsync runs the scan on a background goroutine and delivers the result through
// window.__onSearchScrapsResult, so the UI thread is never blocked. The frontend fires a
// search 150ms after each keystroke, and a synchronous bind made every one of those scans
// freeze the window (no caret, no keys) for its whole duration. Starting a new search also
// cancels the previous one, so fast typing cannot queue N full directory scans.
func (a *App) SearchScrapsAsync(reqID, query string, maxResults int) {
	ctx, cancel := context.WithCancel(context.Background())

	a.searchMu.Lock()
	if a.searchCancel != nil {
		a.searchCancel()
	}
	a.searchSeq++
	seq := a.searchSeq
	a.searchCancel = cancel
	a.searchMu.Unlock()

	go func() {
		defer cancel()

		results, err := search.SearchScrapsContext(ctx, a.GetScrapDir(), query, maxResults)

		a.searchMu.Lock()
		if a.searchSeq == seq {
			a.searchCancel = nil
		}
		a.searchMu.Unlock()

		// A superseded search returns whatever partial results it had; reject instead of
		// resolving so the (now stale) promise never overwrites the newer search's output.
		// The frontend's catch simply logs, leaving the newer results on screen.
		if ctx.Err() != nil {
			a.dispatchSearchScrapsResult(reqID, nil, "検索が新しい入力により中断されました")
			return
		}
		if err != nil {
			a.dispatchSearchScrapsResult(reqID, nil, err.Error())
			return
		}
		a.dispatchSearchScrapsResult(reqID, results, "")
	}()
}

func (a *App) dispatchSearchScrapsResult(reqID string, res []search.SearchResult, errMsg string) {
	if atomic.LoadInt32(&a.isDestroyed) != 0 || a.w == nil {
		return
	}
	if res == nil {
		res = []search.SearchResult{}
	}
	resJSON, _ := json.Marshal(res)
	errJSON, _ := json.Marshal(errMsg)

	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			js := fmt.Sprintf("if (window.__onSearchScrapsResult) { window.__onSearchScrapsResult(%q, %s, %s); }", reqID, string(resJSON), string(errJSON))
			a.w.Eval(js)
		}
	})
}

// AppendDailyScrap appends piped or text content into scraps/YYYY-MM-DD.md and notifies WebView.
func (a *App) AppendDailyScrap(content, command, cwd string) (string, error) {
	scrapDir := a.GetScrapDir()
	now := time.Now()
	filePath, err := scrap.AppendScrap(scrapDir, content, command, now)
	if err != nil {
		return "", err
	}

	a.TriggerGitSync()

	// Dispatch notification to WebView
	if a.w != nil {
		a.w.Dispatch(func() {
			if atomic.LoadInt32(&a.isDestroyed) == 0 {
				payload, _ := json.Marshal(map[string]interface{}{
					"filePath":  filePath,
					"fileName":  filepath.Base(filePath),
					"date":      now.Format("2006-01-02"),
					"timestamp": now.Format("15:04:05"),
					"content":   content,
					"command":   command,
					"cwd":       cwd,
				})
				js := fmt.Sprintf("if (window.onScrapAppended) { window.onScrapAppended(%s); }", string(payload))
				a.w.Eval(js)
			}
		})
	}

	return filePath, nil
}

// GetGitRepoStatus returns the Git status and remote URL of the specified or default scrap directory.
func (a *App) GetGitRepoStatus(dir string) map[string]interface{} {
	targetDir := dir
	if targetDir == "" {
		targetDir = a.GetScrapDir()
	}
	info := gitsync.GetRepoStatus(targetDir)
	return map[string]interface{}{
		"is_git":     info.IsGit,
		"remote_url": info.RemoteURL,
		"branch":     info.Branch,
		"clean":      info.Clean,
	}
}

// CheckGitInstalled returns whether git is installed and its version.
func (a *App) CheckGitInstalled() map[string]interface{} {
	installed, ver := gitsync.CheckGitInstalled()
	return map[string]interface{}{
		"installed": installed,
		"version":   ver,
	}
}

// TestGitRemote tests reachability and authentication to the given remote URL.
func (a *App) TestGitRemote(remoteURL string) map[string]interface{} {
	ok, msg, err := gitsync.TestRemoteConnection(remoteURL)
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	return map[string]interface{}{
		"success": ok,
		"message": msg,
		"error":   errMsg,
	}
}

// SetupGitRemote initializes a git repository and sets up the remote origin URL.
func (a *App) SetupGitRemote(dir, remoteURL, branch string) (map[string]interface{}, error) {
	targetDir := dir
	if targetDir == "" {
		targetDir = a.GetScrapDir()
	}
	if branch == "" {
		branch = "main"
	}
	err := gitsync.SetupRemote(targetDir, remoteURL, branch)
	if err != nil {
		return nil, err
	}
	// Re-initialize git engine with updated repository settings
	a.InitScrapEngine()
	return a.GetGitRepoStatus(targetDir), nil
}
