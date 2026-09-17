package gitsync

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"md-memo/pkg/scrap"
)

// gitCmd creates a git command with hidden window flags and disables interactive prompts to avoid hanging.
func gitCmd(args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	hideWindow(cmd)
	return cmd
}

// gitCmdContext creates a git command with context timeout and hidden window flags.
func gitCmdContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	hideWindow(cmd)
	return cmd
}

// CheckGitInstalled checks if git is available on the system PATH and returns version info.
func CheckGitInstalled() (bool, string) {
	if _, err := exec.LookPath("git"); err != nil {
		return false, ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	cmd := gitCmdContext(ctx, "--version")
	out, err := cmd.Output()
	if err != nil {
		return false, ""
	}
	return true, strings.TrimSpace(string(out))
}


// Config holds settings for background Git synchronization.
type Config struct {
	Enabled         bool
	ScrapDir        string
	DebounceSeconds int
	RemoteBranch    string
	StatusCallback  func(status string, message string) // "syncing", "synced", "error", "skipped"
}

// Engine coordinates automatic pull on startup and debounced push after edits.
type Engine struct {
	mu     sync.Mutex
	cfg    Config
	timer  *time.Timer
	isBusy bool
}

// NewEngine creates a new git synchronization engine.
func NewEngine(cfg Config) *Engine {
	if cfg.DebounceSeconds <= 0 {
		cfg.DebounceSeconds = 30
	}
	if cfg.RemoteBranch == "" {
		cfg.RemoteBranch = "main"
	}
	return &Engine{
		cfg: cfg,
	}
}

// UpdateConfig dynamically updates the sync engine settings.
func (e *Engine) UpdateConfig(cfg Config) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if cfg.DebounceSeconds <= 0 {
		cfg.DebounceSeconds = 30
	}
	if cfg.RemoteBranch == "" {
		cfg.RemoteBranch = "main"
	}
	e.cfg = cfg
}

// IsGitRepo verifies whether the configured scrap directory is a valid git repository.
func (e *Engine) IsGitRepo() bool {
	e.mu.Lock()
	dir := scrap.ResolveScrapDir(e.cfg.ScrapDir)
	e.mu.Unlock()

	if dir == "" {
		return false
	}
	if _, err := exec.LookPath("git"); err != nil {
		return false
	}

	gitDir := filepath.Join(dir, ".git")
	if info, err := os.Stat(gitDir); err == nil && (info.IsDir() || !info.IsDir()) {
		return true
	}

	// Also verify via git rev-parse
	cmd := gitCmd("-C", dir, "rev-parse", "--is-inside-work-tree")
	if out, err := cmd.Output(); err == nil && strings.TrimSpace(string(out)) == "true" {
		return true
	}

	return false
}

// PullRebaseAsync pulls latest changes asynchronously on app startup.
func (e *Engine) PullRebaseAsync() {
	go func() {
		if !e.IsGitRepo() {
			return
		}

		e.mu.Lock()
		cfg := e.cfg
		e.mu.Unlock()

		if !cfg.Enabled {
			return
		}

		dir := scrap.ResolveScrapDir(cfg.ScrapDir)

		if cfg.StatusCallback != nil {
			cfg.StatusCallback("syncing", "Pulling latest changes...")
		}

		cmd := gitCmd("-C", dir, "pull", "--rebase", "origin", cfg.RemoteBranch)
		out, err := cmd.CombinedOutput()
		if err != nil {
			outStr := string(out)
			// If empty remote repo or ref not found yet, skip gracefully without error toast
			if strings.Contains(outStr, "couldn't find remote ref") || strings.Contains(outStr, "no tracking information") {
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("synced", "Initial repository")
				}
				return
			}
			log.Printf("[GitSync] startup pull failed: %v, output: %s", err, outStr)
			if cfg.StatusCallback != nil {
				cfg.StatusCallback("error", fmt.Sprintf("Pull failed: %v", err))
			}
			return
		}

		if cfg.StatusCallback != nil {
			cfg.StatusCallback("synced", "Up to date")
		}
	}()
}

// Trigger restarts the debounce timer to commit and push changes.
func (e *Engine) Trigger() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.cfg.Enabled {
		return
	}

	if e.timer != nil {
		e.timer.Stop()
	}

	debounceDuration := time.Duration(e.cfg.DebounceSeconds) * time.Second
	e.timer = time.AfterFunc(debounceDuration, func() {
		e.executeSync()
	})
}

// TriggerNow immediately executes sync without debouncing.
func (e *Engine) TriggerNow() {
	go e.executeSync()
}

func (e *Engine) executeSync() {
	e.mu.Lock()
	if e.isBusy {
		e.mu.Unlock()
		return
	}
	if !e.cfg.Enabled {
		e.mu.Unlock()
		return
	}
	e.isBusy = true
	cfg := e.cfg
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		e.isBusy = false
		e.mu.Unlock()
	}()

	dir := scrap.ResolveScrapDir(cfg.ScrapDir)

	if !e.IsGitRepo() {
		return
	}

	if cfg.StatusCallback != nil {
		cfg.StatusCallback("syncing", "Syncing to remote...")
	}

	// 1. git add .
	addCmd := gitCmd("-C", dir, "add", ".")
	if out, err := addCmd.CombinedOutput(); err != nil {
		log.Printf("[GitSync] git add failed: %v, output: %s", err, string(out))
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("error", fmt.Sprintf("Add failed: %v", err))
		}
		return
	}

	// 2. git status --porcelain
	statusCmd := gitCmd("-C", dir, "status", "--porcelain")
	statusOut, err := statusCmd.Output()
	if err != nil || len(strings.TrimSpace(string(statusOut))) == 0 {
		// Nothing to commit
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("synced", "Clean working tree")
		}
		return
	}

	// 3. git commit -m "chore(scrap): sync YYYY-MM-DD HH:mm"
	commitMsg := fmt.Sprintf("chore(scrap): sync %s", time.Now().Format("2006-01-02 15:04"))
	commitCmd := gitCmd("-C", dir, "commit", "-m", commitMsg)
	if out, err := commitCmd.CombinedOutput(); err != nil {
		log.Printf("[GitSync] git commit failed: %v, output: %s", err, string(out))
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("error", fmt.Sprintf("Commit failed: %v", err))
		}
		return
	}

	// 4. git push origin <branch>
	pushCmd := gitCmd("-C", dir, "push", "origin", cfg.RemoteBranch)
	if out, err := pushCmd.CombinedOutput(); err != nil {
		log.Printf("[GitSync] git push failed: %v, output: %s", err, string(out))
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("error", fmt.Sprintf("Push failed: %v", err))
		}
		return
	}

	if cfg.StatusCallback != nil {
		cfg.StatusCallback("synced", fmt.Sprintf("Synced at %s", time.Now().Format("15:04:05")))
	}
}

// RepoInfo holds Git status for a repository folder.
type RepoInfo struct {
	IsGit     bool   `json:"is_git"`
	RemoteURL string `json:"remote_url"`
	Branch    string `json:"branch"`
	Clean     bool   `json:"clean"`
}

// GetRepoStatus inspects whether dir is a git repo, its current remote origin URL, and current branch.
func GetRepoStatus(dir string) RepoInfo {
	info := RepoInfo{}
	if dir == "" {
		return info
	}
	expanded := scrap.ResolveScrapDir(dir)
	if _, err := os.Stat(expanded); err != nil {
		return info
	}

	// Check if git repo
	cmd := gitCmd("-C", expanded, "rev-parse", "--is-inside-work-tree")
	if out, err := cmd.Output(); err == nil && strings.TrimSpace(string(out)) == "true" {
		info.IsGit = true
	} else {
		return info
	}

	// Get remote URL
	cmdRemote := gitCmd("-C", expanded, "remote", "get-url", "origin")
	if out, err := cmdRemote.Output(); err == nil {
		info.RemoteURL = strings.TrimSpace(string(out))
	}

	// Get current branch
	cmdBranch := gitCmd("-C", expanded, "rev-parse", "--abbrev-ref", "HEAD")
	if out, err := cmdBranch.Output(); err == nil {
		info.Branch = strings.TrimSpace(string(out))
	}

	// Check if clean
	cmdStatus := gitCmd("-C", expanded, "status", "--porcelain")
	if out, err := cmdStatus.Output(); err == nil {
		info.Clean = len(strings.TrimSpace(string(out))) == 0
	}

	return info
}

// TestRemoteConnection checks if the given remote repository URL is reachable and accessible.
func TestRemoteConnection(remoteURL string) (bool, string, error) {
	cleanURL := strings.TrimSpace(remoteURL)
	if cleanURL == "" {
		return false, "Remote URL cannot be empty", fmt.Errorf("empty remote URL")
	}

	installed, _ := CheckGitInstalled()
	if !installed {
		return false, "Git is not installed on this system. Please install Git to use synchronization.", fmt.Errorf("git not installed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := gitCmdContext(ctx, "ls-remote", "--heads", cleanURL)
	out, err := cmd.CombinedOutput()
	outStr := strings.TrimSpace(string(out))

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return false, "Connection timed out (10s). Check your network, proxy, or firewall settings.", ctx.Err()
		}
		lowerOut := strings.ToLower(outStr)
		if strings.Contains(lowerOut, "authentication failed") ||
			strings.Contains(lowerOut, "permission denied") ||
			strings.Contains(lowerOut, "terminal prompts disabled") ||
			strings.Contains(lowerOut, "could not read username") {
			return false, "Authentication failed. Make sure Git Credential Manager, Personal Access Token (PAT), or SSH keys are configured.", fmt.Errorf("auth failed: %s", outStr)
		}
		if strings.Contains(lowerOut, "repository not found") ||
			strings.Contains(lowerOut, "not found") ||
			strings.Contains(lowerOut, "could not resolve host") {
			return false, "Repository not found or host unreachable. Check the repository URL and ensure it is created on GitHub/GitLab.", fmt.Errorf("repo not found: %s", outStr)
		}
		return false, fmt.Sprintf("Git connection error: %s", outStr), fmt.Errorf("ls-remote failed: %w (%s)", err, outStr)
	}

	return true, "Connection successful! Remote repository is reachable and authenticated.", nil
}

// SetupRemote initializes git in dir if needed, configures git user, sets remote origin, creates initial commit, and pushes upstream synchronously.
func SetupRemote(dir, remoteURL, branch string) error {
	installed, _ := CheckGitInstalled()
	if !installed {
		return fmt.Errorf("Git is not installed on this system. Please install Git first.")
	}

	expanded := scrap.ResolveScrapDir(dir)
	if err := os.MkdirAll(expanded, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	if branch == "" {
		branch = "main"
	}

	// Check if git repo exists
	checkCmd := gitCmd("-C", expanded, "rev-parse", "--is-inside-work-tree")
	if err := checkCmd.Run(); err != nil {
		// git init
		initCmd := gitCmd("-C", expanded, "init")
		if out, err := initCmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git init failed: %v (%s)", err, string(out))
		}
	}

	// Ensure git user.name & user.email are set (fallback for commit if not globally configured)
	nameCheck := gitCmd("-C", expanded, "config", "user.name")
	if out, err := nameCheck.Output(); err != nil || len(strings.TrimSpace(string(out))) == 0 {
		_ = gitCmd("-C", expanded, "config", "user.name", "MD-Memo").Run()
	}
	emailCheck := gitCmd("-C", expanded, "config", "user.email")
	if out, err := emailCheck.Output(); err != nil || len(strings.TrimSpace(string(out))) == 0 {
		_ = gitCmd("-C", expanded, "config", "user.email", "md-memo@local").Run()
	}

	// Set branch
	_ = gitCmd("-C", expanded, "branch", "-M", branch).Run()

	cleanURL := strings.TrimSpace(remoteURL)
	if cleanURL != "" {
		// Check if remote origin already exists
		remoteCheck := gitCmd("-C", expanded, "remote")
		remotes, _ := remoteCheck.Output()
		hasOrigin := false
		for _, r := range strings.Fields(string(remotes)) {
			if r == "origin" {
				hasOrigin = true
				break
			}
		}

		if hasOrigin {
			setCmd := gitCmd("-C", expanded, "remote", "set-url", "origin", cleanURL)
			if out, err := setCmd.CombinedOutput(); err != nil {
				return fmt.Errorf("git remote set-url failed: %v (%s)", err, string(out))
			}
		} else {
			addCmd := gitCmd("-C", expanded, "remote", "add", "origin", cleanURL)
			if out, err := addCmd.CombinedOutput(); err != nil {
				return fmt.Errorf("git remote add failed: %v (%s)", err, string(out))
			}
		}
	}

	// Create initial file & commit if no commits exist
	readmePath := filepath.Join(expanded, "README.md")
	if _, err := os.Stat(readmePath); os.IsNotExist(err) {
		_ = os.WriteFile(readmePath, []byte("# Daily Scraps\n\nAutomated personal troubleshooting scraps powered by [MD-Memo](https://github.com/youshinh/md-memo).\n"), 0644)
	}

	_ = gitCmd("-C", expanded, "add", ".").Run()
	headCheck := gitCmd("-C", expanded, "rev-parse", "HEAD")
	if err := headCheck.Run(); err != nil {
		// No commits yet, commit initial files
		commitCmd := gitCmd("-C", expanded, "commit", "-m", "chore: initialize scraps repository")
		_ = commitCmd.Run()
	}

	// Synchronously push to remote if remoteURL is configured
	if cleanURL != "" {
		pushCtx, pCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer pCancel()

		pushCmd := gitCmdContext(pushCtx, "-C", expanded, "push", "-u", "origin", branch)
		out, err := pushCmd.CombinedOutput()
		if err != nil {
			outStr := string(out)
			// Check if remote has conflicting/existing commits (e.g. user created repo with README on GitHub)
			if strings.Contains(outStr, "fetch first") || strings.Contains(outStr, "non-fast-forward") || strings.Contains(outStr, "[rejected]") {
				// Attempt auto-rescue with --allow-unrelated-histories
				pullCtx, pullCancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer pullCancel()

				pullCmd := gitCmdContext(pullCtx, "-C", expanded, "pull", "--rebase", "--allow-unrelated-histories", "origin", branch)
				pullOut, pullErr := pullCmd.CombinedOutput()
				if pullErr == nil {
					// Re-try push after successful rebase
					rePushCtx, rePushCancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer rePushCancel()
					rePushCmd := gitCmdContext(rePushCtx, "-C", expanded, "push", "-u", "origin", branch)
					if reOut, reErr := rePushCmd.CombinedOutput(); reErr == nil {
						return nil
					} else {
						return fmt.Errorf("initial push failed after rebase: %s", string(reOut))
					}
				} else {
					// Abort conflicted rebase to keep working tree clean
					log.Printf("[GitSync] auto-rebase failed: %s", string(pullOut))
					_ = gitCmd("-C", expanded, "rebase", "--abort").Run()
					return fmt.Errorf("Remote repository already has existing conflicting files (like README.md). Please create an empty repository on GitHub (uncheck 'Add a README file') and try again.")
				}
			}
			return fmt.Errorf("initial push failed: %s", strings.TrimSpace(outStr))
		}
	}

	return nil
}

