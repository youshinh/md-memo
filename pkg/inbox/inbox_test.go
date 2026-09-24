package inbox

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := map[string]string{
		"photo.png":    "image",
		"PHOTO.PNG":    "image",
		"scan.jpg":     "image",
		"scan.jpeg":    "image",
		"note.bmp":     "image",
		"anim.gif":     "image",
		"pic.webp":     "image",
		"memo.mp3":     "audio",
		"memo.wav":     "audio",
		"memo.m4a":     "audio",
		"memo.ogg":     "audio",
		"memo.flac":    "audio",
		"readme.txt":   "",
		"archive.zip":  "",
		"noextension":  "",
		"nested/x.jpg": "image",
	}
	for path, want := range cases {
		if got := Classify(path); got != want {
			t.Errorf("Classify(%q) = %q, want %q", path, got, want)
		}
	}
}

type recorder struct {
	mu     sync.Mutex
	images []string
	audios []string
}

func (r *recorder) handlers() Handlers {
	return Handlers{
		OnImage: func(path string) {
			r.mu.Lock()
			r.images = append(r.images, path)
			r.mu.Unlock()
		},
		OnAudio: func(path string) {
			r.mu.Lock()
			r.audios = append(r.audios, path)
			r.mu.Unlock()
		},
	}
}

func (r *recorder) snapshot() (images, audios []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.images...), append([]string(nil), r.audios...)
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestWatcherClassifiesAndDispatchesDroppedFiles(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	w, err := NewWatcher(dir, rec.handlers(), 100*time.Millisecond)
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	defer w.Close()

	imgPath := filepath.Join(dir, "shot.png")
	audioPath := filepath.Join(dir, "note.mp3")
	otherPath := filepath.Join(dir, "readme.txt")

	if err := os.WriteFile(imgPath, []byte("fake png"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(audioPath, []byte("fake mp3"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(otherPath, []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 3*time.Second, func() bool {
		images, audios := rec.snapshot()
		return len(images) == 1 && len(audios) == 1
	})

	images, audios := rec.snapshot()
	if len(images) != 1 || images[0] != imgPath {
		t.Errorf("expected exactly one image callback for %q, got %v", imgPath, images)
	}
	if len(audios) != 1 || audios[0] != audioPath {
		t.Errorf("expected exactly one audio callback for %q, got %v", audioPath, audios)
	}
}

func TestWatcherDebouncesRepeatedWritesIntoOneCallback(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	w, err := NewWatcher(dir, rec.handlers(), 200*time.Millisecond)
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	defer w.Close()

	imgPath := filepath.Join(dir, "big.jpg")
	f, err := os.Create(imgPath)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := f.WriteString("chunk"); err != nil {
			t.Fatal(err)
		}
		_ = f.Sync()
		time.Sleep(50 * time.Millisecond) // well under the 200ms debounce, so it keeps resetting
	}
	f.Close()

	waitFor(t, 3*time.Second, func() bool {
		images, _ := rec.snapshot()
		return len(images) >= 1
	})
	time.Sleep(300 * time.Millisecond) // make sure nothing fires a second time afterward

	images, _ := rec.snapshot()
	if len(images) != 1 {
		t.Errorf("expected exactly one callback despite multiple writes, got %d: %v", len(images), images)
	}
}

func TestWatcherIgnoresFileRemovedBeforeDebounceFires(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	w, err := NewWatcher(dir, rec.handlers(), 150*time.Millisecond)
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	defer w.Close()

	imgPath := filepath.Join(dir, "temp.png")
	if err := os.WriteFile(imgPath, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(imgPath); err != nil {
		t.Fatal(err)
	}

	time.Sleep(400 * time.Millisecond)
	images, _ := rec.snapshot()
	if len(images) != 0 {
		t.Errorf("expected no callback for a file removed before the debounce fired, got %v", images)
	}
}

func TestWatcherIgnoresUnrecognizedExtensions(t *testing.T) {
	dir := t.TempDir()
	rec := &recorder{}
	w, err := NewWatcher(dir, rec.handlers(), 100*time.Millisecond)
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	defer w.Close()

	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)

	images, audios := rec.snapshot()
	if len(images) != 0 || len(audios) != 0 {
		t.Errorf("expected no callbacks for a .md file, got images=%v audios=%v", images, audios)
	}
}

func TestNewWatcherFailsForNonexistentDir(t *testing.T) {
	if _, err := NewWatcher(filepath.Join(t.TempDir(), "does-not-exist"), Handlers{}, 0); err == nil {
		t.Fatal("expected an error watching a nonexistent directory")
	}
}

func TestCloseIsIdempotentSafe(t *testing.T) {
	dir := t.TempDir()
	w, err := NewWatcher(dir, Handlers{}, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("NewWatcher failed: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
}
