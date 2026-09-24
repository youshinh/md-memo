package inbox

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".bmp": true, ".gif": true, ".webp": true,
}

var audioExts = map[string]bool{
	".mp3": true, ".wav": true, ".m4a": true, ".ogg": true, ".flac": true,
}

// Classify returns "image", "audio", or "" for a path this watcher does not act on.
func Classify(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if imageExts[ext] {
		return "image"
	}
	if audioExts[ext] {
		return "audio"
	}
	return ""
}

// Handlers receives one callback per file dropped into the watched directory, once it has been
// classified and its write has settled. Neither callback fires for an unrecognized extension.
type Handlers struct {
	OnImage func(path string)
	OnAudio func(path string)
}

const defaultDebounce = 1500 * time.Millisecond

// Watcher watches one directory, non-recursively, for new or modified files. A per-file debounce
// timer (reset on every event for that path) means a slow copy/move into the folder is only
// processed once its write has settled, instead of mid-write.
type Watcher struct {
	fsw      *fsnotify.Watcher
	handlers Handlers
	debounce time.Duration

	mu     sync.Mutex
	timers map[string]*time.Timer

	stopCh chan struct{}
	doneCh chan struct{}
}

// NewWatcher starts watching dir immediately. debounce <= 0 uses a 1.5s default.
func NewWatcher(dir string, handlers Handlers, debounce time.Duration) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	if err := fsw.Add(dir); err != nil {
		_ = fsw.Close()
		return nil, err
	}
	if debounce <= 0 {
		debounce = defaultDebounce
	}

	w := &Watcher{
		fsw:      fsw,
		handlers: handlers,
		debounce: debounce,
		timers:   make(map[string]*time.Timer),
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
	go w.loop()

	// One-time startup scan: a file dropped in while md-memo wasn't running would otherwise
	// never be noticed, since fsnotify only reports events from here on. This is a single pass
	// over the directory listing, not a recurring poll.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			w.scheduleProcess(filepath.Join(dir, e.Name()))
		}
	}

	return w, nil
}

// Close stops the watcher and waits for its goroutine to exit. Pending debounce timers are
// stopped without firing.
func (w *Watcher) Close() error {
	close(w.stopCh)
	<-w.doneCh
	w.mu.Lock()
	for _, t := range w.timers {
		t.Stop()
	}
	w.timers = nil
	w.mu.Unlock()
	return w.fsw.Close()
}

func (w *Watcher) loop() {
	defer close(w.doneCh)
	for {
		select {
		case <-w.stopCh:
			return
		case event, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Create) || event.Has(fsnotify.Write) {
				w.scheduleProcess(event.Name)
			}
		case _, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
		}
	}
}

func (w *Watcher) scheduleProcess(path string) {
	kind := Classify(path)
	if kind == "" {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timers == nil {
		return // Close already ran
	}
	if t, ok := w.timers[path]; ok {
		t.Stop()
	}
	w.timers[path] = time.AfterFunc(w.debounce, func() {
		w.mu.Lock()
		delete(w.timers, path)
		w.mu.Unlock()
		w.process(path, kind)
	})
}

func (w *Watcher) process(path, kind string) {
	if _, err := os.Stat(path); err != nil {
		return // moved/deleted again before the debounce fired
	}
	switch kind {
	case "image":
		if w.handlers.OnImage != nil {
			w.handlers.OnImage(path)
		}
	case "audio":
		if w.handlers.OnAudio != nil {
			w.handlers.OnAudio(path)
		}
	}
}
