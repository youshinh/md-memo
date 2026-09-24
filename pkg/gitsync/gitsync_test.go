package gitsync

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// writeHangingFakeGit creates a fake "git" executable on disk that sleeps far longer than any
// short test timeout, and prepends its directory to PATH for the duration of the test so that
// exec.Command("git", ...) resolves to it instead of any real git installation. This lets tests
// exercise the per-step timeout / process-tree-kill path deterministically without depending on
// network conditions or a real hung git process.
func writeHangingFakeGit(t *testing.T) {
	t.Helper()
	dir := t.TempDir()

	var fakePath, sleepScript string
	if runtime.GOOS == "windows" {
		fakePath = filepath.Join(dir, "git.bat")
		sleepScript = "@echo off\r\npowershell -NoProfile -Command \"Start-Sleep -Seconds 30\"\r\n"
	} else {
		fakePath = filepath.Join(dir, "git")
		sleepScript = "#!/bin/sh\nsleep 30\n"
	}
	if err := os.WriteFile(fakePath, []byte(sleepScript), 0755); err != nil {
		t.Fatalf("failed to write fake git script: %v", err)
	}

	origPath := os.Getenv("PATH")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+origPath)
}

func initTestGitRepo(t *testing.T, dir string) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed, skipping git test")
	}

	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		t.Fatalf("git init failed: %v", err)
	}

	cmd = exec.Command("git", "config", "user.email", "test@example.com")
	cmd.Dir = dir
	_ = cmd.Run()

	cmd = exec.Command("git", "config", "user.name", "Test User")
	cmd.Dir = dir
	_ = cmd.Run()
}

func TestGitSyncDebounceAndCommit(t *testing.T) {
	tempDir := t.TempDir()
	initTestGitRepo(t, tempDir)

	var statuses []string
	var mu sync.Mutex
	statusFn := func(status, msg string) {
		mu.Lock()
		statuses = append(statuses, status)
		mu.Unlock()
	}

	engine := NewEngine(Config{
		Enabled:         true,
		ScrapDir:        tempDir,
		DebounceSeconds: 1, // 短縮テスト
		RemoteBranch:    "main",
		StatusCallback:  statusFn,
	})

	// テスト用ファイル作成
	testFile := filepath.Join(tempDir, "test.md")
	_ = os.WriteFile(testFile, []byte("Initial content"), 0644)

	// トリガー
	engine.Trigger()

	// 1秒未満で再トリガー（デバウンスのリセット）
	time.Sleep(300 * time.Millisecond)
	_ = os.WriteFile(testFile, []byte("Updated content"), 0644)
	engine.Trigger()

	// 1.5秒待機（デバウンス完了 & コミット実行）
	time.Sleep(1500 * time.Millisecond)

	// git log でコミットが作成されたか確認
	cmd := exec.Command("git", "log", "-1", "--pretty=%B")
	cmd.Dir = tempDir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git log failed: %v", err)
	}

	commitMsg := string(out)
	if len(commitMsg) == 0 {
		t.Errorf("expected commit message, got empty")
	}

	// The engine goes on in the background after the commit (it tries to push, which fails: there is no
	// remote). Let it finish before the test returns: on a slow Windows runner a git process that is
	// still running holds files in .git, and the temp dir's cleanup then fails with "directory is not
	// empty". A sync ends with a status other than "syncing".
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		last := ""
		if n := len(statuses); n > 0 {
			last = statuses[n-1]
		}
		mu.Unlock()
		if last != "" && last != "syncing" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(statuses) == 0 {
		t.Errorf("expected status updates, got none")
	}
}

func TestGitSyncDisabledOrNotGitRepo(t *testing.T) {
	tempDir := t.TempDir() // not a git repo

	engine := NewEngine(Config{
		Enabled:         true,
		ScrapDir:        tempDir,
		DebounceSeconds: 1,
		RemoteBranch:    "main",
	})

	// .git がないので何もしないはず
	if engine.IsGitRepo() {
		t.Errorf("expected IsGitRepo to be false for non-git dir")
	}

	engine.Trigger()
	time.Sleep(200 * time.Millisecond)
}

func TestGetRepoStatusAndSetupRemote(t *testing.T) {
	tempDir := t.TempDir()

	// Initial check: not a git repo
	info := GetRepoStatus(tempDir)
	if info.IsGit {
		t.Errorf("expected is_git to be false initially")
	}

	// Create bare remote repository
	remoteDir1 := t.TempDir()
	if err := exec.Command("git", "init", "--bare", remoteDir1).Run(); err != nil {
		t.Fatalf("failed to init bare git repo: %v", err)
	}

	// SetupRemote
	err := SetupRemote(tempDir, remoteDir1, "main")
	if err != nil {
		t.Fatalf("SetupRemote failed: %v", err)
	}

	// Check status again
	info = GetRepoStatus(tempDir)
	if !info.IsGit {
		t.Errorf("expected is_git to be true after SetupRemote")
	}
	if info.RemoteURL != remoteDir1 {
		t.Errorf("expected remote URL %s, got %s", remoteDir1, info.RemoteURL)
	}

	// Update remote URL with another bare repo
	remoteDir2 := t.TempDir()
	if err := exec.Command("git", "init", "--bare", remoteDir2).Run(); err != nil {
		t.Fatalf("failed to init bare git repo 2: %v", err)
	}
	err = SetupRemote(tempDir, remoteDir2, "main")
	if err != nil {
		t.Fatalf("SetupRemote update failed: %v", err)
	}
	info = GetRepoStatus(tempDir)
	if info.RemoteURL != remoteDir2 {
		t.Errorf("expected updated remote URL %s, got %s", remoteDir2, info.RemoteURL)
	}
}

func TestCheckGitInstalled(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed, skipping test")
	}

	installed, version := CheckGitInstalled()
	if !installed {
		t.Errorf("expected git to be detected as installed")
	}
	if !strings.Contains(version, "git version") {
		t.Errorf("expected git version string, got: %s", version)
	}
}

func TestRemoteConnectionAndPushRescue(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed, skipping test")
	}

	// 1. Empty URL test
	ok, _, err := TestRemoteConnection("")
	if ok || err == nil {
		t.Errorf("expected empty URL to fail")
	}

	// 2. Setup local bare repository as remote
	remoteBareDir := t.TempDir()
	initBareCmd := exec.Command("git", "init", "--bare", remoteBareDir)
	if err := initBareCmd.Run(); err != nil {
		t.Fatalf("failed to init bare git repo: %v", err)
	}

	// Test connection to local bare repo
	ok, msg, err := TestRemoteConnection(remoteBareDir)
	if !ok || err != nil {
		t.Errorf("expected local bare repo connection to succeed, got msg: %s, err: %v", msg, err)
	}

	// 3. Test SetupRemote syncing with local bare repo
	workDir := t.TempDir()
	err = SetupRemote(workDir, remoteBareDir, "main")
	if err != nil {
		t.Fatalf("SetupRemote with bare repo failed: %v", err)
	}

	// Verify commit was pushed to bare repo
	checkCmd := exec.Command("git", "-C", remoteBareDir, "rev-parse", "HEAD")
	if out, err := checkCmd.CombinedOutput(); err != nil {
		t.Errorf("expected bare repo to have HEAD after SetupRemote push, out: %s, err: %v", string(out), err)
	}

	// 4. Test Unrelated Histories Clean Rescue:
	// Remote has an existing commit with non-conflicting file (e.g. LICENSE or notes)
	remoteBareWithCommitDir := t.TempDir()
	_ = exec.Command("git", "init", "--bare", remoteBareWithCommitDir).Run()

	seederDir := t.TempDir()
	_ = exec.Command("git", "init", seederDir).Run()
	_ = exec.Command("git", "-C", seederDir, "config", "user.name", "GitHub User").Run()
	_ = exec.Command("git", "-C", seederDir, "config", "user.email", "gh@example.com").Run()
	_ = os.WriteFile(filepath.Join(seederDir, "LICENSE.txt"), []byte("MIT License"), 0644)
	_ = exec.Command("git", "-C", seederDir, "add", ".").Run()
	_ = exec.Command("git", "-C", seederDir, "commit", "-m", "Add LICENSE").Run()
	_ = exec.Command("git", "-C", seederDir, "branch", "-M", "main").Run()
	_ = exec.Command("git", "-C", seederDir, "remote", "add", "origin", remoteBareWithCommitDir).Run()
	_ = exec.Command("git", "-C", seederDir, "push", "-u", "origin", "main").Run()

	localWorkDir := t.TempDir()
	err = SetupRemote(localWorkDir, remoteBareWithCommitDir, "main")
	if err != nil {
		t.Fatalf("expected SetupRemote to succeed with auto-rebase rescue for non-conflicting files, got: %v", err)
	}

	// 5. Test Conflicting File Handling:
	// Remote has README.md with different content than the placeholder SetupRemote creates
	// locally. Rather than failing, SetupRemote should now keep both versions: the local one
	// stays at README.md, the remote one is saved alongside it as a "(sync conflict ...)" file.
	remoteBareConflictDir := t.TempDir()
	_ = exec.Command("git", "init", "--bare", remoteBareConflictDir).Run()

	seederConflictDir := t.TempDir()
	_ = exec.Command("git", "init", seederConflictDir).Run()
	_ = exec.Command("git", "-C", seederConflictDir, "config", "user.name", "GitHub User").Run()
	_ = exec.Command("git", "-C", seederConflictDir, "config", "user.email", "gh@example.com").Run()
	_ = os.WriteFile(filepath.Join(seederConflictDir, "README.md"), []byte("Conflicting remote content"), 0644)
	_ = exec.Command("git", "-C", seederConflictDir, "add", ".").Run()
	_ = exec.Command("git", "-C", seederConflictDir, "commit", "-m", "Add conflicting README").Run()
	_ = exec.Command("git", "-C", seederConflictDir, "branch", "-M", "main").Run()
	_ = exec.Command("git", "-C", seederConflictDir, "remote", "add", "origin", remoteBareConflictDir).Run()
	_ = exec.Command("git", "-C", seederConflictDir, "push", "-u", "origin", "main").Run()

	localConflictDir := t.TempDir()
	err = SetupRemote(localConflictDir, remoteBareConflictDir, "main")
	if err != nil {
		t.Fatalf("expected SetupRemote to auto-resolve the conflicting README by keeping both versions, got error: %v", err)
	}

	localReadme, readErr := os.ReadFile(filepath.Join(localConflictDir, "README.md"))
	if readErr != nil {
		t.Fatalf("expected local README.md to still exist: %v", readErr)
	}
	if !strings.Contains(string(localReadme), "Daily Scraps") {
		t.Errorf("expected local README.md to keep its own (local) content, got: %s", string(localReadme))
	}

	entries, _ := os.ReadDir(localConflictDir)
	foundConflictCopy := false
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "sync conflict") {
			foundConflictCopy = true
			copyContent, _ := os.ReadFile(filepath.Join(localConflictDir, entry.Name()))
			if !strings.Contains(string(copyContent), "Conflicting remote content") {
				t.Errorf("expected conflict-copy file to contain the remote's content, got: %s", string(copyContent))
			}
			break
		}
	}
	if !foundConflictCopy {
		t.Errorf("expected a '(sync conflict ...)' file to be created for the remote's README.md, got entries: %v", entries)
	}

	// The reconciled history (including the "keep both" resolution commit) must have reached
	// the bare remote too, not just be sitting locally.
	remoteHasReadme := exec.Command("git", "-C", remoteBareConflictDir, "cat-file", "-e", "main:README.md")
	if err := remoteHasReadme.Run(); err != nil {
		t.Errorf("expected pushed remote to still have README.md: %v", err)
	}
}

// TestExecuteSyncPullsBeforePush verifies that executeSync brings in a non-conflicting commit
// pushed by another environment before pushing its own new commit, instead of just failing with
// a rejected push (the gap that let two environments' scraps repos silently diverge).
func TestExecuteSyncPullsBeforePush(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed, skipping git test")
	}

	bareDir := t.TempDir()
	if err := exec.Command("git", "init", "--bare", bareDir).Run(); err != nil {
		t.Fatalf("failed to init bare repo: %v", err)
	}

	// Seed the remote with a shared starting commit.
	seedDir := t.TempDir()
	initTestGitRepo(t, seedDir)
	_ = os.WriteFile(filepath.Join(seedDir, "shared.md"), []byte("shared"), 0644)
	_ = exec.Command("git", "-C", seedDir, "add", ".").Run()
	_ = exec.Command("git", "-C", seedDir, "commit", "-m", "seed").Run()
	_ = exec.Command("git", "-C", seedDir, "branch", "-M", "main").Run()
	_ = exec.Command("git", "-C", seedDir, "remote", "add", "origin", bareDir).Run()
	if out, err := exec.Command("git", "-C", seedDir, "push", "-u", "origin", "main").CombinedOutput(); err != nil {
		t.Fatalf("failed to push seed commit: %v (%s)", err, string(out))
	}

	// "Environment A": clones the remote and pushes its own new file. `git clone`'s initial
	// checked-out branch follows the bare repo's HEAD symref, which may not be "main" depending
	// on git version/config even though we pushed a "main" branch above — pin it explicitly.
	envA := t.TempDir()
	if out, err := exec.Command("git", "clone", bareDir, envA).CombinedOutput(); err != nil {
		t.Fatalf("failed to clone env A: %v (%s)", err, string(out))
	}
	_ = exec.Command("git", "-C", envA, "config", "user.name", "Env A").Run()
	_ = exec.Command("git", "-C", envA, "config", "user.email", "a@example.com").Run()
	if out, err := exec.Command("git", "-C", envA, "checkout", "-B", "main", "origin/main").CombinedOutput(); err != nil {
		t.Fatalf("failed to check out main in env A: %v (%s)", err, string(out))
	}
	_ = os.WriteFile(filepath.Join(envA, "a.md"), []byte("from A"), 0644)
	_ = exec.Command("git", "-C", envA, "add", ".").Run()
	_ = exec.Command("git", "-C", envA, "commit", "-m", "from A").Run()
	if out, err := exec.Command("git", "-C", envA, "push", "origin", "main").CombinedOutput(); err != nil {
		t.Fatalf("failed to push from env A: %v (%s)", err, string(out))
	}

	// "Environment B": a separate clone that hasn't seen A's commit yet, with its own pending
	// (uncommitted) note — mirrors this session's exact scenario.
	envB := t.TempDir()
	if out, err := exec.Command("git", "clone", bareDir, envB).CombinedOutput(); err != nil {
		t.Fatalf("failed to clone env B: %v (%s)", err, string(out))
	}
	_ = exec.Command("git", "-C", envB, "config", "user.name", "Env B").Run()
	_ = exec.Command("git", "-C", envB, "config", "user.email", "b@example.com").Run()
	if out, err := exec.Command("git", "-C", envB, "checkout", "-B", "main", "origin/main").CombinedOutput(); err != nil {
		t.Fatalf("failed to check out main in env B: %v (%s)", err, string(out))
	}
	_ = os.WriteFile(filepath.Join(envB, "b.md"), []byte("from B"), 0644)

	var statuses []string
	var mu sync.Mutex
	engine := NewEngine(Config{
		Enabled:        true,
		ScrapDir:       envB,
		RemoteBranch:   "main",
		StatusCallback: func(status, msg string) { mu.Lock(); statuses = append(statuses, status+":"+msg); mu.Unlock() },
	})

	engine.executeSync()

	if _, err := os.Stat(filepath.Join(envB, "a.md")); err != nil {
		t.Errorf("expected env B to have pulled a.md from env A, got: %v", err)
	}
	if _, err := os.Stat(filepath.Join(envB, "b.md")); err != nil {
		t.Errorf("expected env B's own b.md to still exist: %v", err)
	}

	checkRemote := exec.Command("git", "-C", bareDir, "cat-file", "-e", "main:b.md")
	if err := checkRemote.Run(); err != nil {
		t.Errorf("expected b.md to have been pushed to the remote, got: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, s := range statuses {
		if strings.HasPrefix(s, "error:") {
			t.Errorf("expected no error status, got: %v (all statuses: %v)", s, statuses)
		}
	}
}

// TestPullRebaseAsyncResolvesRealConflictByKeepingBoth verifies that when the same file was
// edited independently in two environments, the startup pull no longer leaves the repo stuck
// mid-rebase with raw conflict markers: it falls back to a merge, keeps both versions as
// separate files, commits, and pushes the resolution back to the remote.
func TestPullRebaseAsyncResolvesRealConflictByKeepingBoth(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed, skipping git test")
	}

	bareDir := t.TempDir()
	if err := exec.Command("git", "init", "--bare", bareDir).Run(); err != nil {
		t.Fatalf("failed to init bare repo: %v", err)
	}

	seedDir := t.TempDir()
	initTestGitRepo(t, seedDir)
	_ = os.WriteFile(filepath.Join(seedDir, "notes.md"), []byte("original"), 0644)
	_ = exec.Command("git", "-C", seedDir, "add", ".").Run()
	_ = exec.Command("git", "-C", seedDir, "commit", "-m", "seed").Run()
	_ = exec.Command("git", "-C", seedDir, "branch", "-M", "main").Run()
	_ = exec.Command("git", "-C", seedDir, "remote", "add", "origin", bareDir).Run()
	if out, err := exec.Command("git", "-C", seedDir, "push", "-u", "origin", "main").CombinedOutput(); err != nil {
		t.Fatalf("failed to push seed commit: %v (%s)", err, string(out))
	}

	// Both environments clone the remote while it only has the seed commit, so their edits
	// below are genuine siblings (both children of "seed") rather than one being a descendant
	// of the other — otherwise there'd be nothing to actually conflict over.
	envA := t.TempDir()
	_ = exec.Command("git", "clone", bareDir, envA).Run()
	_ = exec.Command("git", "-C", envA, "config", "user.name", "Env A").Run()
	_ = exec.Command("git", "-C", envA, "config", "user.email", "a@example.com").Run()
	if out, err := exec.Command("git", "-C", envA, "checkout", "-B", "main", "origin/main").CombinedOutput(); err != nil {
		t.Fatalf("failed to check out main in env A: %v (%s)", err, string(out))
	}

	envB := t.TempDir()
	_ = exec.Command("git", "clone", bareDir, envB).Run()
	_ = exec.Command("git", "-C", envB, "config", "user.name", "Env B").Run()
	_ = exec.Command("git", "-C", envB, "config", "user.email", "b@example.com").Run()
	if out, err := exec.Command("git", "-C", envB, "checkout", "-B", "main", "origin/main").CombinedOutput(); err != nil {
		t.Fatalf("failed to check out main in env B: %v (%s)", err, string(out))
	}

	// Env A edits notes.md and pushes first.
	_ = os.WriteFile(filepath.Join(envA, "notes.md"), []byte("edited by A"), 0644)
	_ = exec.Command("git", "-C", envA, "add", ".").Run()
	_ = exec.Command("git", "-C", envA, "commit", "-m", "A's edit").Run()
	if out, err := exec.Command("git", "-C", envA, "push", "origin", "main").CombinedOutput(); err != nil {
		t.Fatalf("failed to push from env A: %v (%s)", err, string(out))
	}

	// Env B independently edited the same file and already committed it locally (but hasn't
	// pulled A's change yet), then its engine runs the startup pull.
	_ = os.WriteFile(filepath.Join(envB, "notes.md"), []byte("edited by B"), 0644)
	_ = exec.Command("git", "-C", envB, "add", ".").Run()
	_ = exec.Command("git", "-C", envB, "commit", "-m", "B's edit").Run()

	done := make(chan struct{})
	var once sync.Once
	engine := NewEngine(Config{
		Enabled:      true,
		ScrapDir:     envB,
		RemoteBranch: "main",
		StatusCallback: func(status, msg string) {
			if status == "synced" || status == "error" {
				once.Do(func() { close(done) })
			}
		},
	})

	engine.PullRebaseAsync()

	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for PullRebaseAsync to finish")
	}

	// B's own version must still be readable at its original path...
	localContent, err := os.ReadFile(filepath.Join(envB, "notes.md"))
	if err != nil {
		t.Fatalf("expected notes.md to still exist locally: %v", err)
	}
	if string(localContent) != "edited by B" {
		t.Errorf("expected local notes.md to keep B's content, got: %q", string(localContent))
	}

	// ...and A's version must have been preserved alongside it, not silently dropped.
	entries, _ := os.ReadDir(envB)
	var conflictContent []byte
	for _, entry := range entries {
		if strings.Contains(entry.Name(), "sync conflict") {
			conflictContent, _ = os.ReadFile(filepath.Join(envB, entry.Name()))
			break
		}
	}
	if conflictContent == nil {
		t.Fatalf("expected a '(sync conflict ...)' file preserving A's edit, entries: %v", entries)
	}
	if string(conflictContent) != "edited by A" {
		t.Errorf("expected conflict-copy to contain A's content, got: %q", string(conflictContent))
	}

	// The resolution must have been pushed back, not left stranded locally.
	if err := exec.Command("git", "-C", bareDir, "rev-parse", "refs/heads/main").Run(); err != nil {
		t.Fatalf("remote main ref missing: %v", err)
	}
	// Address by the "main" branch explicitly: the bare repo's HEAD symref may still point at
	// whatever git's default branch name is (e.g. "master"), which never had anything pushed to it.
	remoteLog, _ := exec.Command("git", "-C", bareDir, "log", "--oneline", "-1", "main").CombinedOutput()
	localLog, _ := exec.Command("git", "-C", envB, "log", "--oneline", "-1").CombinedOutput()
	if strings.TrimSpace(string(remoteLog)) == "" || string(remoteLog) != string(localLog) {
		t.Errorf("expected remote HEAD to match local HEAD after push, remote=%q local=%q", remoteLog, localLog)
	}

	// The repo must not be left mid-rebase/mid-merge.
	if out, _ := exec.Command("git", "-C", envB, "status", "--porcelain").CombinedOutput(); len(strings.TrimSpace(string(out))) != 0 {
		t.Errorf("expected clean working tree after conflict resolution, got: %s", string(out))
	}
}

// TestExecuteSyncStepTimeoutClearsBusyFlag verifies that a git step which hangs past its
// per-step timeout is killed (whole process tree, not just the immediate process) and that
// executeSync returns promptly and clears isBusy, instead of wedging the engine's isBusy flag
// for the rest of the session (the bug this fix addresses).
func TestExecuteSyncStepTimeoutClearsBusyFlag(t *testing.T) {
	writeHangingFakeGit(t)

	tempDir := t.TempDir()
	// Make IsGitRepo() report true without invoking (the now-fake) git at all, by creating a
	// literal ".git" directory - see Engine.IsGitRepo's fast os.Stat path.
	if err := os.Mkdir(filepath.Join(tempDir, ".git"), 0755); err != nil {
		t.Fatalf("failed to create fake .git dir: %v", err)
	}
	// A file so `git status --porcelain` would (if it ran for real) have something to commit;
	// irrelevant here since our fake git never reaches that logic, but keeps the setup realistic.
	_ = os.WriteFile(filepath.Join(tempDir, "test.md"), []byte("content"), 0644)

	var statuses []string
	var mu sync.Mutex
	statusFn := func(status, msg string) {
		mu.Lock()
		statuses = append(statuses, status+":"+msg)
		mu.Unlock()
	}

	engine := NewEngine(Config{
		Enabled:         true,
		ScrapDir:        tempDir,
		DebounceSeconds: 1,
		RemoteBranch:    "main",
		StatusCallback:  statusFn,
		StepTimeout:     300 * time.Millisecond, // far shorter than the fake git's 30s sleep
	})

	start := time.Now()
	engine.executeSync()
	elapsed := time.Since(start)

	if engine.isBusy {
		t.Errorf("expected isBusy to be cleared after a timed-out step, but it is still true")
	}

	// The fake "git add ." sleeps 30s; a correctly-wired timeout+kill must return in a small
	// fraction of that. Give generous headroom for slow CI/taskkill spawning while still proving
	// we did not wait out the full sleep.
	if elapsed > 10*time.Second {
		t.Errorf("expected executeSync to return quickly after step timeout, took %s", elapsed)
	}

	mu.Lock()
	defer mu.Unlock()
	foundTimeoutStatus := false
	for _, s := range statuses {
		if strings.Contains(s, "error") && strings.Contains(strings.ToLower(s), "timed out") {
			foundTimeoutStatus = true
			break
		}
	}
	if !foundTimeoutStatus {
		t.Errorf("expected a timeout error status callback, got: %v", statuses)
	}
}


