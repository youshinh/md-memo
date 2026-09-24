package slotagent

import (
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// FileWatcher monitors the currently active file for external changes with debouncing.
type FileWatcher struct {
	watcher      *fsnotify.Watcher
	activePath   string
	mu           sync.Mutex
	onChange     func(filePath string)
	debounceMs   time.Duration
	timer        *time.Timer
	timerMu      sync.Mutex
	stopCh       chan struct{}
}

// NewFileWatcher creates a new FileWatcher instance.
func NewFileWatcher(onChange func(filePath string), debounceMs time.Duration) (*FileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	if debounceMs <= 0 {
		debounceMs = 500 * time.Millisecond
	}

	fw := &FileWatcher{
		watcher:    w,
		onChange:   onChange,
		debounceMs: debounceMs,
		stopCh:     make(chan struct{}),
	}

	go fw.loop()

	return fw, nil
}

// Watch changes the active file being monitored.
func (fw *FileWatcher) Watch(filePath string) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	// If already watching a file, remove it
	if fw.activePath != "" {
		_ = fw.watcher.Remove(fw.activePath)
	}

	fw.activePath = filePath
	if filePath != "" {
		// The watched file's directory can be busy (e.g. a git checkout touching many files at once),
		// so keep a bigger buffer than the 4096B inbox watcher while still saving most of the 64KiB
		// Windows default; the option is ignored by non-Windows backends.
		return fw.watcher.AddWith(filePath, fsnotify.WithBufferSize(16384))
	}
	return nil
}

// Unwatch stops watching any active file.
func (fw *FileWatcher) Unwatch() {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	if fw.activePath != "" {
		_ = fw.watcher.Remove(fw.activePath)
		fw.activePath = ""
	}
}

// Close terminates the watcher loop.
func (fw *FileWatcher) Close() error {
	close(fw.stopCh)
	return fw.watcher.Close()
}

func (fw *FileWatcher) loop() {
	for {
		select {
		case <-fw.stopCh:
			return
		case event, ok := <-fw.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
				fw.triggerDebounced(event.Name)
			}
		case <-fw.watcher.Errors:
			// ignore transient fs errors
		}
	}
}

func (fw *FileWatcher) triggerDebounced(path string) {
	fw.timerMu.Lock()
	defer fw.timerMu.Unlock()

	if fw.timer != nil {
		fw.timer.Stop()
	}

	fw.timer = time.AfterFunc(fw.debounceMs, func() {
		if fw.onChange != nil {
			fw.onChange(path)
		}
	})
}
