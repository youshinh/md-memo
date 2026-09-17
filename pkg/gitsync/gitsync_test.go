package gitsync

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

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


