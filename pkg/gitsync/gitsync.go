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

	"md-memo/pkg/procutil"
	"md-memo/pkg/scrap"
)

// gitCmd creates a git command with hidden window flags and disables interactive prompts to avoid hanging.
func gitCmd(args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	procutil.HideWindow(cmd)
	return cmd
}

// gitCmdContext creates a git command with context timeout and hidden window flags. When ctx
// is canceled (e.g. its deadline elapses), the whole process tree spawned by this command is
// terminated, not just the immediate git process (see procutil.KillTreeOnCancel).
func gitCmdContext(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	procutil.KillTreeOnCancel(cmd)
	return cmd
}

// Per-step timeouts applied to the individual git invocations that make up a sync cycle.
// Network-facing steps (pull/push/fetch) get a longer budget than purely local steps
// (add/status/commit), so a stalled network operation can no longer wedge the engine's
// isBusy flag for the rest of the session.
const (
	gitNetworkStepTimeout = 120 * time.Second
	gitLocalStepTimeout   = 30 * time.Second
)

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
	// StepTimeout, when non-zero, overrides BOTH the local and network per-step git command
	// timeout (gitLocalStepTimeout / gitNetworkStepTimeout). Production code leaves this unset;
	// it exists so tests can exercise the timeout/kill path without waiting a full 30s-120s.
	StepTimeout time.Duration
}

// stepTimeouts resolves the effective (local, network) per-step timeouts for this engine's
// current config, honoring the test-only StepTimeout override when set.
func (e *Engine) stepTimeouts() (local, network time.Duration) {
	local, network = gitLocalStepTimeout, gitNetworkStepTimeout
	if e.cfg.StepTimeout > 0 {
		local, network = e.cfg.StepTimeout, e.cfg.StepTimeout
	}
	return local, network
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

		_, networkTimeout := e.stepTimeouts()
		ctx, cancel := context.WithTimeout(context.Background(), networkTimeout)
		defer cancel()

		cmd := gitCmdContext(ctx, "-C", dir, "pull", "--rebase", "origin", cfg.RemoteBranch)
		out, err := cmd.CombinedOutput()
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				log.Printf("[GitSync] startup pull timed out after %s", networkTimeout)
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("error", fmt.Sprintf("Pull timed out after %s", networkTimeout))
				}
				return
			}
			outStr := string(out)
			// If empty remote repo or ref not found yet, skip gracefully without error toast
			if strings.Contains(outStr, "couldn't find remote ref") || strings.Contains(outStr, "no tracking information") {
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("synced", "Initial repository")
				}
				return
			}
			// No remote configured at all yet (git sync enabled but not linked) — nothing to
			// reconcile, so don't waste time on a doomed merge attempt.
			if strings.Contains(outStr, "does not appear to be a git repository") || strings.Contains(outStr, "No remote repository specified") {
				log.Printf("[GitSync] startup pull skipped, no remote configured: %s", outStr)
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("error", "No remote configured")
				}
				return
			}

			// A plain rebase typically fails here because the same note was edited in another
			// environment since the last sync. Abort it and fall back to a merge that keeps both
			// versions of any conflicting file, then push the reconciled history back so other
			// environments see the resolution too.
			log.Printf("[GitSync] startup pull failed, attempting conflict-safe merge: %v, output: %s", err, outStr)
			_ = gitCmd("-C", dir, "rebase", "--abort").Run()

			if mergeErr := attemptMergeRescue(dir, cfg.RemoteBranch, networkTimeout); mergeErr != nil {
				log.Printf("[GitSync] merge rescue failed: %v", mergeErr)
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("error", fmt.Sprintf("Sync conflict could not be resolved automatically: %v", mergeErr))
				}
				return
			}

			pushCtx, pushCancel := context.WithTimeout(context.Background(), networkTimeout)
			pushCmd := gitCmdContext(pushCtx, "-C", dir, "push", "origin", cfg.RemoteBranch)
			pushOut, pushErr := pushCmd.CombinedOutput()
			pushCancel()
			if pushErr != nil {
				log.Printf("[GitSync] push after conflict resolution failed: %s", string(pushOut))
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("error", "Resolved a sync conflict locally, but could not push yet — will retry")
				}
				return
			}

			if cfg.StatusCallback != nil {
				cfg.StatusCallback("synced", "Resolved a sync conflict — check for '(sync conflict ...)' files")
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

	localTimeout, networkTimeout := e.stepTimeouts()

	// 1. git add .
	addCtx, addCancel := context.WithTimeout(context.Background(), localTimeout)
	addCmd := gitCmdContext(addCtx, "-C", dir, "add", ".")
	out, err := addCmd.CombinedOutput()
	addTimedOut := addCtx.Err() == context.DeadlineExceeded
	addCancel()
	if err != nil {
		if addTimedOut {
			log.Printf("[GitSync] git add timed out after %s", localTimeout)
			if cfg.StatusCallback != nil {
				cfg.StatusCallback("error", fmt.Sprintf("Add timed out after %s", localTimeout))
			}
			return
		}
		log.Printf("[GitSync] git add failed: %v, output: %s", err, string(out))
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("error", fmt.Sprintf("Add failed: %v", err))
		}
		return
	}

	// 2. git status --porcelain
	statusCtx, statusCancel := context.WithTimeout(context.Background(), localTimeout)
	statusCmd := gitCmdContext(statusCtx, "-C", dir, "status", "--porcelain")
	statusOut, err := statusCmd.Output()
	statusCancel()
	if err != nil || len(strings.TrimSpace(string(statusOut))) == 0 {
		// Nothing to commit (this also covers the timeout case: treat as a no-op rather than
		// an error toast, matching the pre-existing "nothing to commit" behavior on any error)
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("synced", "Clean working tree")
		}
		return
	}

	// 3. git commit -m "chore(scrap): sync YYYY-MM-DD HH:mm"
	commitCtx, commitCancel := context.WithTimeout(context.Background(), localTimeout)
	commitMsg := fmt.Sprintf("chore(scrap): sync %s", time.Now().Format("2006-01-02 15:04"))
	commitCmd := gitCmdContext(commitCtx, "-C", dir, "commit", "-m", commitMsg)
	out, err = commitCmd.CombinedOutput()
	commitTimedOut := commitCtx.Err() == context.DeadlineExceeded
	commitCancel()
	if err != nil {
		if commitTimedOut {
			log.Printf("[GitSync] git commit timed out after %s", localTimeout)
			if cfg.StatusCallback != nil {
				cfg.StatusCallback("error", fmt.Sprintf("Commit timed out after %s", localTimeout))
			}
			return
		}
		log.Printf("[GitSync] git commit failed: %v, output: %s", err, string(out))
		if cfg.StatusCallback != nil {
			cfg.StatusCallback("error", fmt.Sprintf("Commit failed: %v", err))
		}
		return
	}

	// 4. git pull --rebase origin <branch> — bring in remote changes before pushing our new
	// commit, so a note edited concurrently in another environment doesn't just get rejected.
	pullCtx, pullCancel := context.WithTimeout(context.Background(), networkTimeout)
	pullCmd := gitCmdContext(pullCtx, "-C", dir, "pull", "--rebase", "origin", cfg.RemoteBranch)
	pullOut, pullErr := pullCmd.CombinedOutput()
	pullTimedOut := pullCtx.Err() == context.DeadlineExceeded
	pullCancel()
	if pullErr != nil {
		if pullTimedOut {
			log.Printf("[GitSync] pre-push pull timed out after %s", networkTimeout)
			if cfg.StatusCallback != nil {
				cfg.StatusCallback("error", fmt.Sprintf("Pull timed out after %s", networkTimeout))
			}
			return
		}
		pullOutStr := string(pullOut)
		if strings.Contains(pullOutStr, "couldn't find remote ref") || strings.Contains(pullOutStr, "no tracking information") {
			// Nothing to pull yet (e.g. remote branch doesn't exist until our first push) — fine.
		} else if strings.Contains(pullOutStr, "does not appear to be a git repository") || strings.Contains(pullOutStr, "No remote repository specified") {
			// No remote configured at all yet — nothing to reconcile, just try the push (which
			// will fail the same way and report clearly) rather than attempt a doomed merge.
		} else {
			log.Printf("[GitSync] pre-push pull failed, attempting conflict-safe merge: %v, output: %s", pullErr, pullOutStr)
			_ = gitCmd("-C", dir, "rebase", "--abort").Run()
			if mergeErr := attemptMergeRescue(dir, cfg.RemoteBranch, networkTimeout); mergeErr != nil {
				log.Printf("[GitSync] merge rescue failed: %v", mergeErr)
				if cfg.StatusCallback != nil {
					cfg.StatusCallback("error", fmt.Sprintf("Sync conflict could not be resolved automatically: %v", mergeErr))
				}
				return
			}
		}
	}

	// 5. git push origin <branch>
	pushCtx, pushCancel := context.WithTimeout(context.Background(), networkTimeout)
	pushCmd := gitCmdContext(pushCtx, "-C", dir, "push", "origin", cfg.RemoteBranch)
	out, err = pushCmd.CombinedOutput()
	pushTimedOut := pushCtx.Err() == context.DeadlineExceeded
	pushCancel()
	if err != nil {
		if pushTimedOut {
			log.Printf("[GitSync] git push timed out after %s", networkTimeout)
			if cfg.StatusCallback != nil {
				cfg.StatusCallback("error", fmt.Sprintf("Push timed out after %s", networkTimeout))
			}
			return
		}
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

// resolveConflictsKeepBoth resolves every currently-unmerged path in dir by keeping the local
// ("ours") content at its original path and writing the remote ("theirs") content to a new
// sibling file, instead of attempting a line-level merge. Line merging has no sensible meaning
// for prose notes (it produces interleaved fragments, not a readable note), so when the same
// note was edited independently in two environments the safest behavior is to keep both copies
// and let the user reconcile them by hand. Must be called while a `git merge` is in progress
// with unmerged paths present in the index; leaves all conflicts staged (resolved) on return.
func resolveConflictsKeepBoth(dir string) error {
	out, err := gitCmd("-C", dir, "diff", "--name-only", "--diff-filter=U").Output()
	if err != nil {
		return fmt.Errorf("failed to list conflicted files: %w", err)
	}
	paths := strings.Fields(strings.TrimSpace(string(out)))
	if len(paths) == 0 {
		return fmt.Errorf("merge failed but no conflicted files were found")
	}

	hostname, _ := os.Hostname()
	if strings.TrimSpace(hostname) == "" {
		hostname = "device"
	}
	stamp := time.Now().Format("20060102-150405")

	for _, p := range paths {
		theirs, err := gitCmd("-C", dir, "show", ":3:"+p).Output()
		if err != nil {
			return fmt.Errorf("could not read the remote version of %s (this usually means it was renamed or deleted on one side, which auto-resolve doesn't handle): %w", p, err)
		}
		if out, err := gitCmd("-C", dir, "checkout", "--ours", "--", p).CombinedOutput(); err != nil {
			return fmt.Errorf("failed to restore local version of %s: %s", p, strings.TrimSpace(string(out)))
		}

		ext := filepath.Ext(p)
		base := strings.TrimSuffix(p, ext)
		conflictPath := fmt.Sprintf("%s (sync conflict %s %s)%s", base, hostname, stamp, ext)
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(conflictPath)), theirs, 0644); err != nil {
			return fmt.Errorf("failed to write conflicting copy for %s: %w", p, err)
		}

		if out, err := gitCmd("-C", dir, "add", "--", p, conflictPath).CombinedOutput(); err != nil {
			return fmt.Errorf("failed to stage resolved copies of %s: %s", p, strings.TrimSpace(string(out)))
		}
	}

	return nil
}

// attemptMergeRescue reconciles dir's local history with origin/branch after a plain
// `git pull --rebase` has already failed and been aborted by the caller. It falls back to a
// merge so that any genuine content conflicts (the same note edited independently in two
// environments) are resolved by keeping both versions via resolveConflictsKeepBoth, rather than
// surfacing a raw git conflict. On success, dir's HEAD is a new commit incorporating
// origin/branch (either a clean merge, or one with the conflicting files split into "ours" +
// a "(sync conflict ...)" sibling). Does not push.
func attemptMergeRescue(dir, branch string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	mergeCmd := gitCmdContext(ctx, "-C", dir, "merge", "--no-ff", "--no-edit", "--allow-unrelated-histories", "origin/"+branch)
	out, mergeErr := mergeCmd.CombinedOutput()
	if mergeErr == nil {
		return nil
	}

	if resolveErr := resolveConflictsKeepBoth(dir); resolveErr != nil {
		_ = gitCmd("-C", dir, "merge", "--abort").Run()
		return fmt.Errorf("%v (merge output: %s)", resolveErr, strings.TrimSpace(string(out)))
	}

	commitCmd := gitCmd("-C", dir, "commit", "--no-edit")
	if cOut, cErr := commitCmd.CombinedOutput(); cErr != nil {
		_ = gitCmd("-C", dir, "merge", "--abort").Run()
		return fmt.Errorf("failed to commit resolved conflicts: %s", strings.TrimSpace(string(cOut)))
	}
	return nil
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

	// Create an initial commit only when the repo truly has no history yet. Running `git add .`
	// unconditionally here would silently stage whatever pending edits happen to be sitting in
	// an already-initialized scrap dir (e.g. the user's own notes) every time this is called to
	// just re-point the remote URL, which then confuses the push-rejection recovery below.
	headCheck := gitCmd("-C", expanded, "rev-parse", "HEAD")
	if err := headCheck.Run(); err != nil {
		readmePath := filepath.Join(expanded, "README.md")
		if _, err := os.Stat(readmePath); os.IsNotExist(err) {
			_ = os.WriteFile(readmePath, []byte("# Daily Scraps\n\nAutomated personal troubleshooting scraps powered by [MD-Memo](https://github.com/youshinh/md-memo).\n"), 0644)
		}
		_ = gitCmd("-C", expanded, "add", ".").Run()
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
			// Check if remote has conflicting/existing commits (e.g. user created repo with README on GitHub,
			// or this scrap dir was already linked to this remote from another environment)
			if strings.Contains(outStr, "fetch first") || strings.Contains(outStr, "non-fast-forward") || strings.Contains(outStr, "[rejected]") {
				// Any pending local edits (e.g. notes written before this link/re-link) must not
				// block or get lost in the rebase/merge below, so stash them first and restore
				// them once history is reconciled.
				stashCmd := gitCmd("-C", expanded, "stash", "push", "-u", "-m", "md-memo: pre-link auto-stash")
				stashOut, stashErr := stashCmd.CombinedOutput()
				stashed := stashErr == nil && !strings.Contains(string(stashOut), "No local changes to save")

				pullCtx, pullCancel := context.WithTimeout(context.Background(), 20*time.Second)
				pullCmd := gitCmdContext(pullCtx, "-C", expanded, "pull", "--rebase", "--allow-unrelated-histories", "origin", branch)
				pullOut, pullErr := pullCmd.CombinedOutput()
				pullCancel()

				if pullErr != nil {
					// Plain rebase failed (typically a genuine content conflict). Abort it and
					// fall back to a merge that keeps both versions of any conflicting file
					// rather than giving up.
					log.Printf("[GitSync] auto-rebase failed, falling back to merge: %s", string(pullOut))
					_ = gitCmd("-C", expanded, "rebase", "--abort").Run()
					if mergeErr := attemptMergeRescue(expanded, branch, 20*time.Second); mergeErr != nil {
						if stashed {
							_ = gitCmd("-C", expanded, "stash", "pop").Run()
						}
						return fmt.Errorf("could not automatically reconcile local and remote history: %v", mergeErr)
					}
				}

				if stashed {
					if popOut, popErr := gitCmd("-C", expanded, "stash", "pop").CombinedOutput(); popErr != nil {
						return fmt.Errorf("history was reconciled, but restoring your pending edits failed: %s (they are safely kept — run 'git stash list' in %s to recover them)", strings.TrimSpace(string(popOut)), expanded)
					}
					if statusOut, _ := gitCmd("-C", expanded, "status", "--porcelain").Output(); strings.Contains(string(statusOut), "UU") {
						return fmt.Errorf("history was reconciled, but restoring your pending edits produced a conflict — resolve it manually in %s", expanded)
					}
				}

				rePushCtx, rePushCancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer rePushCancel()
				rePushCmd := gitCmdContext(rePushCtx, "-C", expanded, "push", "-u", "origin", branch)
				if reOut, reErr := rePushCmd.CombinedOutput(); reErr == nil {
					return nil
				} else {
					return fmt.Errorf("initial push failed after reconciling history: %s", strings.TrimSpace(string(reOut)))
				}
			}
			return fmt.Errorf("initial push failed: %s", strings.TrimSpace(outStr))
		}
	}

	return nil
}

