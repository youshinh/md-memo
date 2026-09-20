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
	// Remote has README.md with different content
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
	if err == nil {
		t.Fatalf("expected SetupRemote to return error on conflicting README, got nil")
	}
	if !strings.Contains(err.Error(), "existing conflicting files") {
		t.Errorf("expected friendly conflict error message, got: %v", err)
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


