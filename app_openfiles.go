package main

import (
	"strings"
	"sync"
)

// Files the operating system asks MD-Memo to open: on macOS "Open With", a double-click in Finder
// and a file dropped on the Dock icon arrive as an Apple Event (window_darwin.go hands each path
// to OpenFromOS), never as a command-line argument. Without a handler for it, macOS answers
// "MD-Memo cannot open files in the "Markdown Document" format".
//
// Two situations have to work:
//   - the app is already running: the page is up, so the file goes to a new tab at once;
//   - the app was started by the file itself: the event arrives before the page has asked what to
//     show, so the path waits here and GetStartupFile hands it over (the same route a path on the
//     command line takes), which also lets the page replace its empty first tab with it.
type osOpenQueue struct {
	mu      sync.Mutex
	claimed bool     // GetStartupFile has run: later paths go straight to a new tab
	pending []string // paths that arrived before that
}

// add records path. It reports true when the page is already past its start-up and the caller
// should open the path itself; false when the path was queued for GetStartupFile.
func (q *osOpenQueue) add(path string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.claimed {
		q.pending = append(q.pending, path)
		return false
	}
	return true
}

// claim marks the start-up as done and returns the paths queued so far (in arrival order).
func (q *osOpenQueue) claim() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.claimed = true
	paths := q.pending
	q.pending = nil
	return paths
}

// OpenFromOS is called (on any thread) for every file the OS asks the app to open. It never
// blocks: the file is read and shown from a goroutine.
func (a *App) OpenFromOS(path string) {
	if strings.TrimSpace(path) == "" {
		return
	}
	if a.osOpen.add(path) {
		a.openWhenUIReady(path)
	}
}

// openWhenUIReady shows each path in a new tab once the page has signalled that it is loaded (at
// once for a running app), then brings the window to the front. A file that cannot be read is
// skipped: the page has nothing to show for it.
func (a *App) openWhenUIReady(paths ...string) {
	if len(paths) == 0 {
		return
	}
	go func() {
		defer func() { _ = recover() }()
		waitUIReady(uiReadyFallback)
		opened := false
		for _, p := range paths {
			if err := a.OpenPathInNewTab(p); err == nil {
				opened = true
			}
		}
		if opened {
			activatePlatformWindow()
		}
	}()
}
