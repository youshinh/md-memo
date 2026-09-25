package main

import (
	"context"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"md-memo/pkg/discordbridge"
	"md-memo/pkg/dropzone"
	"md-memo/pkg/gitsync"
	"md-memo/pkg/inbox"
	"md-memo/pkg/jev"
	"md-memo/pkg/slotagent"
)

// WebViewInstance represents any platform-specific webview window capable of dispatching JS evaluations.
type WebViewInstance interface {
	Dispatch(func())
	Eval(string)
}

// App provides Go methods callable from JS inside WebView.
type App struct {
	w              WebViewInstance
	isDestroyed    int32
	cliCancels     sync.Map // reqID -> context.CancelFunc
	gitEngine      *gitsync.Engine
	gitMu          sync.RWMutex
	scrapDir       string
	slotRunner     *slotagent.Runner
	pipelineEngine *slotagent.PipelineEngine
	// slotEngineMu guards slotRunner / pipelineEngine themselves (their creation in
	// slotEngine(), below). fileWatcher has its own watcherMu because it is initialized and
	// torn down independently of the runner/pipeline pair.
	slotEngineMu   sync.Mutex
	fileWatcher    *slotagent.FileWatcher
	watcherMu      sync.Mutex
	jevClient      *jev.Client
	jevVerifier    *jev.ASTCommandVerifier
	jevSelector    *jev.OrthogonalSelector
	jevRunner      *jev.PipelineRunner
	jevAgentRouter *jev.AgentRouter
	jevMu          sync.Mutex

	// osOpen holds files the OS asked us to open before the page had started (app_openfiles.go).
	osOpen osOpenQueue

	// settingsMu guards lastScrapSettings / lastJevSettings, used by SaveConfig to skip
	// re-initializing the git-sync engine / Jev client when the relevant settings haven't
	// actually changed since the last save.
	settingsMu          sync.Mutex
	lastScrapSettings   *ScrapSettings
	lastJevSettings     *jevRelevantSettings
	lastDiscordSettings *DiscordBridgeSettings
	lastInboxSettings   *InboxSettings

	// slotCfgMu guards slotCfgCache, used by resolveActiveSlotConfig to avoid re-reading and
	// re-parsing the external agents config file on every call when nothing on disk changed.
	slotCfgMu    sync.Mutex
	slotCfgCache *slotConfigCacheEntry

	// searchMu guards the in-flight scrap search. SearchScrapsAsync cancels the previous
	// scan before starting a new one, so typing quickly in the search box does not queue up
	// N full directory scans. searchSeq lets the finishing goroutine tell whether the cancel
	// func still stored is its own before clearing it.
	searchMu     sync.Mutex
	searchSeq    uint64
	searchCancel context.CancelFunc

	// cfgCacheMu guards cfgCache, the memoised contents of config.json (see
	// readConfigCached). Invalidated by SaveConfig and re-validated by a stat on every read.
	cfgCacheMu sync.Mutex
	cfgCache   *configCacheEntry

	// dropzoneMu guards dropzoneServer, the single active Mobile Drop session (see
	// app_mobiledrop.go). At most one session exists at a time.
	dropzoneMu     sync.Mutex
	dropzoneServer *dropzone.Server

	// discordMu guards discordPoller, the single running Discord bridge poller (see
	// app_discordbridge.go). Re-initializing swaps it out: the old one is stopped before a new
	// one (or none, when disabled) takes its place.
	discordMu     sync.Mutex
	discordPoller *discordbridge.Poller

	// inboxMu guards inboxWatcher, the single running hot-folder watcher (see app_inbox.go).
	// Re-initializing swaps it out: the old one is stopped before a new one (or none, when
	// disabled) takes its place.
	inboxMu      sync.Mutex
	inboxWatcher *inbox.Watcher
}

const AppVersion = "1.9.0"

func (a *App) GetAppVersion() string {
	return AppVersion
}

// workingSetTrimDelay is how long after the window is hidden the process working set is
// emptied. Emptying it evicts every page, so doing it the instant the window disappears is
// exactly wrong: the user very often summons the window back within a second or two, and
// every one of those pages then has to be faulted back in, which is what would break the
// "<15ms summon" promise. Waiting a few seconds means only a genuinely idle, tray-resident
// process pays the eviction.
const workingSetTrimDelay = 3 * time.Second

var (
	// windowVisible tracks whether the native window is currently on screen. It is set by
	// the platform show/hide paths and read by the delayed working-set trim.
	windowVisible int32 = 1
	// freeOSMemoryPending / workingSetTrimPending coalesce bursts: the frontend fires
	// TrimMemory from both 'blur' and 'visibilitychange', which arrive together, and hiding
	// to the tray schedules a trim of its own.
	freeOSMemoryPending   int32
	workingSetTrimPending int32
)

// setWindowVisible records the native window's visibility. Called from the platform
// show/hide paths.
func setWindowVisible(visible bool) {
	if visible {
		atomic.StoreInt32(&windowVisible, 1)
	} else {
		atomic.StoreInt32(&windowVisible, 0)
	}
}

func isWindowVisible() bool {
	return atomic.LoadInt32(&windowVisible) != 0
}

// scheduleWorkingSetTrim requests a working-set trim workingSetTrimDelay from now, skipping
// it if the window has become visible again by then. It always runs on its own goroutine, so
// it is safe to call from the UI thread (WM_CLOSE, the tray handler, a bound function).
// Overlapping requests share the single pending timer.
func scheduleWorkingSetTrim() {
	if !atomic.CompareAndSwapInt32(&workingSetTrimPending, 0, 1) {
		return
	}
	go func() {
		defer atomic.StoreInt32(&workingSetTrimPending, 0)
		time.Sleep(workingSetTrimDelay)
		if isWindowVisible() {
			return
		}
		trimProcessWorkingSet()
	}()
}

// TrimMemory releases OS memory and schedules process working set compression.
//
// This is a bound function, which means it runs INLINE ON THE UI THREAD. debug.FreeOSMemory
// is a stop-the-world GC plus a scavenge, and the Windows working-set trim is an
// EmptyWorkingSet syscall - neither belongs on the thread that pumps the window's messages,
// so both are moved off it here. The frontend calls this from 'blur' and 'visibilitychange',
// which fire together; the CAS coalesces that burst into a single trim.
func (a *App) TrimMemory() error {
	if atomic.CompareAndSwapInt32(&freeOSMemoryPending, 0, 1) {
		go func() {
			defer atomic.StoreInt32(&freeOSMemoryPending, 0)
			debug.FreeOSMemory()
		}()
	}
	scheduleWorkingSetTrim()
	return nil
}

// CloseWindow requests the host window to shut the application down.
//
// What that means is genuinely per-platform, which is why the work happens in
// closePlatformWindow (window_windows.go / window_darwin.go) rather than here. On Windows
// destroying the WebView2 window is enough: its WM_DESTROY handler posts a quit message and
// the message loop unwinds. On macOS it is not - the Cocoa backend closes the NSWindow but
// leaves NSApp running, which used to leave MD-Memo alive with no window, no way back, and
// its HTTP and IPC listeners still bound.
//
// Only a real shutdown may mark the App destroyed (the flag makes every async result - OCR,
// voice, Quick Actions, LLM - skip the page), so closePlatformWindow sets it itself: on Windows
// with the tray resident "closing" just hides the window and the app keeps running, and a
// flag set here would have left every later result undelivered until the next restart.
func (a *App) CloseWindow() error {
	closePlatformWindow(a)
	return nil
}

// PlatformCapabilities tells the frontend which native features actually exist on the host,
// so it can stop offering (or silently relying on) ones that do not.
//
// It exists because the IME Guardian assumed backend_setIMEMode really switches the OS input
// source. On Windows it does; on macOS the bind is a no-op, so the Guardian would convert
// romaji and then ask for an input-source switch that never happened, leaving the next
// keystroke latin again. Reporting the capability honestly is better than a silent lie.
type PlatformCapabilities struct {
	OS              string `json:"os"`
	NativeImeSwitch bool   `json:"nativeImeSwitch"`
	Tray            bool   `json:"tray"`
	GlobalHotkey    bool   `json:"globalHotkey"`
}

// platformCapabilitiesFor is the pure, GOOS-parameterised body of GetPlatformCapabilities.
// Extracted so a Windows `go test` run can exercise the darwin/linux branches directly instead
// of only whichever branch runtime.GOOS happens to select on the host running the test.
func platformCapabilitiesFor(goos string) PlatformCapabilities {
	switch goos {
	case "windows":
		return PlatformCapabilities{
			OS:              "windows",
			NativeImeSwitch: true,
			Tray:            true,
			GlobalHotkey:    true,
		}
	case "darwin":
		return PlatformCapabilities{
			OS:              "darwin",
			NativeImeSwitch: false,
			Tray:            false,
			GlobalHotkey:    true,
		}
	default:
		return PlatformCapabilities{OS: goos}
	}
}

// GetPlatformCapabilities is bound as backend_getPlatformCapabilities on every platform.
func (a *App) GetPlatformCapabilities() PlatformCapabilities {
	return platformCapabilitiesFor(runtime.GOOS)
}

// dispatchEval runs js on the UI thread via a.w.Dispatch, evaluating it only if the window is
// still alive by the time the dispatched closure actually runs (isDestroyed can flip between
// enqueue and run, so the check has to happen inside the closure, not before it). It is a no-op
// if a.w is nil; callers that need to distinguish "no window" from "dispatched" should keep
// their own nil check instead of relying on this one.
func (a *App) dispatchEval(js string) {
	// The early isDestroyed check keeps a torn-down webview from receiving a Dispatch at all
	// (some call sites, such as the file watcher, did this before the helper existed).
	if a.w == nil || atomic.LoadInt32(&a.isDestroyed) != 0 {
		return
	}
	a.w.Dispatch(func() {
		if atomic.LoadInt32(&a.isDestroyed) == 0 {
			a.w.Eval(js)
		}
	})
}

// UpdateGlobalShortcut dynamically updates OS-level global shortcut for summoning window.
func (a *App) UpdateGlobalShortcut(shortcutStr string) (bool, error) {
	ok := updateGlobalHotKeyNative(shortcutStr)
	return ok, nil
}
