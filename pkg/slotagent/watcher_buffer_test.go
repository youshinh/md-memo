package slotagent

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestFileWatcherDeliversWriteAfterBufferSizeChange pins that FileWatcher still delivers change
// notifications for the actively watched file once Watch() started using fsnotify.AddWith with a
// larger ReadDirectoryChangesW buffer (16384 bytes) instead of the default Add(). The buffer size
// only affects Windows behaviour under event bursts; this test just needs the ordinary single-file
// notify path to keep working everywhere.
func TestFileWatcherDeliversWriteAfterBufferSizeChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("initial"), 0644); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	var mu sync.Mutex
	var notified []string
	fw, err := NewFileWatcher(func(filePath string) {
		mu.Lock()
		notified = append(notified, filePath)
		mu.Unlock()
	}, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("NewFileWatcher failed: %v", err)
	}
	defer fw.Close()

	if err := fw.Watch(path); err != nil {
		t.Fatalf("Watch failed: %v", err)
	}

	if err := os.WriteFile(path, []byte("updated content"), 0644); err != nil {
		t.Fatalf("failed to write test file: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := len(notified) > 0
		mu.Unlock()
		if got {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(notified) == 0 {
		t.Fatal("expected at least one onChange callback for the watched file's write, got none within 5s")
	}
	if notified[0] != path {
		t.Errorf("expected notified path %q, got %q", path, notified[0])
	}
}

// TestFileWatcherWatchSwitchesBetweenFilesAfterBufferSizeChange pins that re-Watch()ing a
// different file still unwatches the previous one and correctly reports changes only for the
// newly active path, unaffected by the AddWith buffer-size option.
func TestFileWatcherWatchSwitchesBetweenFilesAfterBufferSizeChange(t *testing.T) {
	dir := t.TempDir()
	pathA := filepath.Join(dir, "a.md")
	pathB := filepath.Join(dir, "b.md")
	for _, p := range []string{pathA, pathB} {
		if err := os.WriteFile(p, []byte("x"), 0644); err != nil {
			t.Fatalf("failed to create %s: %v", p, err)
		}
	}

	var mu sync.Mutex
	var notified []string
	fw, err := NewFileWatcher(func(filePath string) {
		mu.Lock()
		notified = append(notified, filePath)
		mu.Unlock()
	}, 100*time.Millisecond)
	if err != nil {
		t.Fatalf("NewFileWatcher failed: %v", err)
	}
	defer fw.Close()

	if err := fw.Watch(pathA); err != nil {
		t.Fatalf("Watch(pathA) failed: %v", err)
	}
	if err := fw.Watch(pathB); err != nil {
		t.Fatalf("Watch(pathB) failed: %v", err)
	}

	// A write to the now-unwatched file must not trigger a callback.
	if err := os.WriteFile(pathA, []byte("changed"), 0644); err != nil {
		t.Fatalf("failed to write pathA: %v", err)
	}
	// A write to the active file must.
	if err := os.WriteFile(pathB, []byte("changed"), 0644); err != nil {
		t.Fatalf("failed to write pathB: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := len(notified) > 0
		mu.Unlock()
		if got {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, p := range notified {
		if p == pathA {
			t.Errorf("did not expect a callback for unwatched pathA, got notifications: %v", notified)
		}
	}
	if len(notified) == 0 {
		t.Fatal("expected at least one onChange callback for the actively watched pathB, got none within 5s")
	}
}
