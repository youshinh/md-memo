//go:build darwin && cgo

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
// kAEQuitReason (AERegistry.h). Header only: the constant is an enum, nothing extra is linked.
#import <CoreServices/CoreServices.h>

// gWindow is MD-Memo's one and only NSWindow. It is captured in setupMacWindowDelegate from
// the pointer webview hands back, and is read only from the main queue.
//
// Keeping it here is what makes the window controls work at all: webview's cocoa engine
// exposes no way to miniaturize, zoom or re-front its window, and App.CloseWindow used to be
// wired to every one of minimize / quit / close, which destroyed the webview and left the
// process running with no window and no way to get one back.
static NSWindow *gWindow = nil;

// Forward declaration with external linkage on purpose: hotkey_darwin.go is a separate cgo
// translation unit and its Carbon hot-key handler calls this function.
void mdmemoActivateWindow(void);

// mdmemoActivateWindowOnMain brings the app and its window to the front. It touches AppKit
// and must therefore only ever be called on the main thread.
static void mdmemoActivateWindowOnMain(void) {
    NSApplication *app = [NSApplication sharedApplication];
    [app activateIgnoringOtherApps:YES];
    if (gWindow != nil) {
        if ([gWindow isMiniaturized]) {
            [gWindow deminiaturize:nil];
        }
        [gWindow makeKeyAndOrderFront:nil];
    }
}

// Defined in Go (openfile_darwin.go, //export): hands one path to the app. It is only declared
// here because a Go file with //export directives may not define anything in its preamble, and
// the Objective-C below needs definitions.
extern void mdmemoGoOpenFile(char *path);

// Defined in Go (openfile_darwin.go, //export), declared here for the same reason. It starts the
// same exit App.CloseWindow uses (closePlatformWindow: stop the run loop so webview_run returns
// and main's defers run) and returns 1, or returns 0 when Go has no window to stop yet.
extern int mdmemoGoQuit(void);

// --- Quitting ----------------------------------------------------------------------------------
//
// Cmd+Q, the app menu's Quit item, Dock > Quit and a logout all end in [NSApp terminate:]. Left
// alone, that calls exit() straight away: main's deferred ipcServer.Close() never runs (so
// ipc-session.json is left behind) and the page never saves the edits of the last half second
// (its session save is debounced by 500 ms, and WKWebView fires no beforeunload on exit).
// applicationShouldTerminate: below routes every quit through one path instead:
//
//   1. ask the page to save its session (kMDMemoQuitFlushScript), waiting at most
//      kMDMemoQuitFlushTimeout for the answer;
//   2. a quit the user asked for (Cmd+Q, Dock > Quit) is cancelled as far as AppKit is concerned
//      and finished by Go the way App.CloseWindow does it, so every defer runs. If the process is
//      somehow still alive kMDMemoQuitStopTimeout later, AppKit is told to terminate for real;
//   3. a logout, restart or shutdown must never be cancelled (the system would abandon the
//      logout), so it answers NSTerminateLater and then YES once the page has saved: AppKit exits
//      as before, minus the lost edits. ipc-session.json may stay behind in that case; the next
//      launch purges it (ipc.LoadSession checks the recorded PID).
//
// Every branch ends in the process exiting; none of them can leave the app refusing to quit. A
// second Cmd+Q while the first is still finishing is ignored; a logout during it quits at once.
// No prompt about unsaved changes is added: dirty tabs live on in the saved session, exactly as
// they did when Cmd+Q simply exited.

enum {
    kMDMemoQuitIdle = 0,     // no quit requested yet
    kMDMemoQuitFlushing = 1, // waiting for the page to save (or for the flush timeout)
    kMDMemoQuitStopping = 2, // Go is stopping the run loop
    kMDMemoQuitNow = 3       // let AppKit terminate immediately
};

// Main-thread only, like everything else that touches them.
static int gQuitState = kMDMemoQuitIdle;
static BOOL gQuitFromSystem = NO;
// Set by NSWorkspaceWillPowerOffNotification, which is posted before a logout, restart or shutdown
// asks the apps to quit. A second signal besides the quit event's reason attribute, so a logout
// is never mistaken for Cmd+Q (and cancelled).
static BOOL gPoweringOff = NO;

static const double kMDMemoQuitFlushTimeout = 2.0;
static const double kMDMemoQuitStopTimeout = 3.0;

// Hands the page's current session to Go (SaveSession) before the app goes away. The listener
// app.js registers for beforeunload does exactly that, synchronously, so it is simply fired; a
// window.__mdmemoBeforeQuit function, if the page ever defines one, is preferred. The
// saveSession message is posted before this script returns, so it reaches Go before the
// completion handler of evaluateJavaScript runs.
static NSString *const kMDMemoQuitFlushScript =
    @"(function () {"
    @"  try {"
    @"    if (typeof window.__mdmemoBeforeQuit === 'function') {"
    @"      window.__mdmemoBeforeQuit();"
    @"    } else {"
    @"      window.dispatchEvent(new Event('beforeunload'));"
    @"    }"
    @"  } catch (e) {}"
    @"  return true;"
    @"})();";

// mdmemoQuitIsFromSystem reports whether the quit being handled comes from a logout, restart or
// shutdown. Cmd+Q and the Quit menu item call terminate: directly (no current Apple Event);
// Dock > Quit sends a plain quit event; the system's quit event carries a kAEQuitReason
// attribute. Any reason at all counts as "system": misreading a user quit that way only costs the
// ipc-session.json cleanup, while misreading a logout as a user quit would cancel the logout.
static BOOL mdmemoQuitIsFromSystem(void) {
    if (gPoweringOff) {
        return YES;
    }
    NSAppleEventDescriptor *event = [[NSAppleEventManager sharedAppleEventManager] currentAppleEvent];
    if (event == nil) {
        return NO;
    }
    return [event attributeDescriptorForKeyword:kAEQuitReason] != nil;
}

// mdmemoFinishQuitOnMain runs once the page has saved, or once the flush timeout fires, whichever
// comes first; the second call finds the state already moved on and does nothing.
static void mdmemoFinishQuitOnMain(void) {
    if (gQuitState != kMDMemoQuitFlushing) {
        return;
    }
    NSApplication *app = [NSApplication sharedApplication];
    if (gQuitFromSystem) {
        gQuitState = kMDMemoQuitNow;
        [app replyToApplicationShouldTerminate:YES];
        return;
    }
    gQuitState = kMDMemoQuitStopping;
    if (mdmemoGoQuit() == 0) {
        gQuitState = kMDMemoQuitNow;
        [app terminate:nil];
        return;
    }
    // Normally the run loop has returned long before this fires (and a stopped run loop never
    // runs it). It is only here so that "the app quits" holds even if stopping failed, e.g.
    // because a modal panel swallowed the stop.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kMDMemoQuitStopTimeout * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        @autoreleasepool {
            gQuitState = kMDMemoQuitNow;
            [[NSApplication sharedApplication] terminate:nil];
        }
    });
}

// mdmemoFlushPageThenFinishQuit asks the page to save and arranges for mdmemoFinishQuitOnMain to
// run afterwards. It never calls it synchronously: applicationShouldTerminate: has to return
// NSTerminateLater before replyToApplicationShouldTerminate: may be sent.
static void mdmemoFlushPageThenFinishQuit(void) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kMDMemoQuitFlushTimeout * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        @autoreleasepool {
            mdmemoFinishQuitOnMain();
        }
    });

    WKWebView *webView = nil;
    if (gWindow != nil) {
        NSView *content = [gWindow contentView];
        if (content != nil && [content isKindOfClass:[WKWebView class]]) {
            webView = (WKWebView *)content;
        }
    }
    if (webView == nil) {
        dispatch_async(dispatch_get_main_queue(), ^{
            @autoreleasepool {
                mdmemoFinishQuitOnMain();
            }
        });
        return;
    }
    [webView evaluateJavaScript:kMDMemoQuitFlushScript completionHandler:^(id result, NSError *error) {
        mdmemoFinishQuitOnMain();
    }];
}

@interface MDMemoAppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@end

@implementation MDMemoAppDelegate
// Finder's "Open With", a double-click on a .md file and a drop on the Dock icon arrive here (as
// an Apple Event, never as a command-line argument). Info.plist declares the document types, so
// without this method AppKit answers "MD-Memo cannot open files in the "Markdown Document" format".
// The path goes to Go, which shows it in a tab (app_openfiles.go).
- (void)application:(NSApplication *)sender openFiles:(NSArray<NSString *> *)filenames {
    for (NSString *name in filenames) {
        const char *path = [name fileSystemRepresentation];
        if (path != NULL) {
            mdmemoGoOpenFile((char *)path);
        }
    }
    [sender replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}

// See "Quitting" above.
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (gQuitState == kMDMemoQuitNow) {
        return NSTerminateNow;
    }
    BOOL fromSystem = mdmemoQuitIsFromSystem();
    if (gQuitState != kMDMemoQuitIdle) {
        // A quit is already under way. A logout must not wait for it; anything else just lets
        // the one in progress finish.
        return fromSystem ? NSTerminateNow : NSTerminateCancel;
    }
    gQuitState = kMDMemoQuitFlushing;
    gQuitFromSystem = fromSystem;
    mdmemoFlushPageThenFinishQuit();
    return fromSystem ? NSTerminateLater : NSTerminateCancel;
}

- (void)workspaceWillPowerOff:(NSNotification *)notification {
    gPoweringOff = YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    // This used to walk [sender windows] and order each one front, which did nothing after
    // the window had been hidden (and nothing at all once it had been destroyed) and never
    // activated the app. Go through the one real activation path instead.
    mdmemoActivateWindowOnMain();
    return YES;
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [sender orderOut:nil];
    return NO;
}
@end

static MDMemoAppDelegate *gAppDelegate = nil;

// mdmemoInstallAppDelegate makes MDMemoAppDelegate NSApp's delegate. It must run synchronously on
// the main thread BEFORE webview.New, never from a dispatch_async block:
//
// When NSApp has no delegate, webview's cocoa engine installs its own (WebviewAppDelegate, which
// has no application:openFiles:) and spins [NSApp run] inside webview.New until
// applicationDidFinishLaunching: arrives. AppKit delivers the file a cold launch was started with
// (Finder "Open With", a double-click, a drop on the Dock icon) BEFORE
// applicationDidFinishLaunching:, so while our delegate was installed from a dispatch_async block
// that file always reached webview's delegate and AppKit answered "MD-Memo cannot open files in
// the "Markdown Document" format". (It had to come later than that, too: had the block ever won
// the race, webview's delegate would never have seen applicationDidFinishLaunching: and
// webview.New would have spun forever.)
//
// With a delegate already set, webview.New skips that temporary run loop and builds the window at
// once. Everything the skipped applicationDidFinishLaunching: did is covered: the window is set up
// by the constructor itself, and setupMacEditMenu sets the activation policy and activates the
// app. The first [NSApp run] is then w.Run(), after every Bind, and the launch file reaches
// application:openFiles: there, to wait in the osOpen queue for GetStartupFile.
static void mdmemoInstallAppDelegate(void) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        if (gAppDelegate == nil) {
            gAppDelegate = [[MDMemoAppDelegate alloc] init];
            [[[NSWorkspace sharedWorkspace] notificationCenter] addObserver:gAppDelegate
                                                                   selector:@selector(workspaceWillPowerOff:)
                                                                       name:NSWorkspaceWillPowerOffNotification
                                                                     object:nil];
        }
        [app setDelegate:gAppDelegate];
    }
}

// mdmemoActivateWindow is the thread-safe entry point used from Go and from the hot-key
// handler.
void mdmemoActivateWindow(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            mdmemoActivateWindowOnMain();
        }
    });
}

// mdmemoMinimizeWindow miniaturizes the window to the Dock. There is no tray on macOS, so
// "minimize" means exactly that.
static void mdmemoMinimizeWindow(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            if (gWindow != nil) {
                [gWindow miniaturize:nil];
            }
        }
    });
}

// mdmemoToggleFullScreen is the macOS counterpart of the Windows maximize/restore toggle.
// It needs NSWindowStyleMaskResizable, which setupMacWindowDelegate guarantees.
static void mdmemoToggleFullScreen(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            if (gWindow != nil) {
                [gWindow toggleFullScreen:nil];
            }
        }
    });
}

static void setupMacWindowDelegate(void *nsWindow) {
    if (nsWindow == NULL) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSWindow *win = (NSWindow *)nsWindow;
            // Retained for the lifetime of the process: this file is compiled without ARC,
            // and the pointer has to stay valid for every later miniaturize / activate.
            gWindow = [win retain];

            if (gAppDelegate != nil) {
                [win setDelegate:gAppDelegate];
            }

            // Some webview releases create the NSWindow with NSWindowStyleMaskTitled alone.
            // Without these bits miniaturize:, zoom: and toggleFullScreen: are silent no-ops,
            // and the window has no minimize/zoom buttons at all. OR-ing is idempotent, so
            // this is harmless on the releases that already set them.
            [win setStyleMask:([win styleMask] |
                               NSWindowStyleMaskClosable |
                               NSWindowStyleMaskMiniaturizable |
                               NSWindowStyleMaskResizable)];

            // Dark base colour (#1e1e1e), the same value applyNativeDarkMode uses on Windows
            // and the default theme's background in style.css. Without it the window paints
            // white for the frames before the page renders.
            [win setBackgroundColor:[NSColor colorWithCalibratedRed:(30.0 / 255.0)
                                                              green:(30.0 / 255.0)
                                                               blue:(30.0 / 255.0)
                                                              alpha:1.0]];

            // The WKWebView (webview installs it as the content view) draws an opaque white
            // backdrop of its own, which would cover the colour set above and cause a white
            // flash before the page loads. underPageBackgroundColor is the public, documented
            // WebKit API for exactly this, but only exists on macOS 12+; guard with @available
            // (which also silences -Wunguarded-availability-new) rather than a private KVC key
            // + @try/@catch, since Go's cgo does not allow the -fobjc-exceptions flag that
            // non-ARC exception handling would otherwise need. respondsToSelector: is kept as a
            // second, redundant guard in case a future SDK ever ships the selector without the
            // matching deployment-target availability annotation.
            NSView *content = [win contentView];
            if (content != nil && [content respondsToSelector:@selector(setUnderPageBackgroundColor:)]) {
                if (@available(macOS 12.0, *)) {
                    WKWebView *webView = (WKWebView *)content;
                    [webView setUnderPageBackgroundColor:[NSColor colorWithCalibratedRed:(30.0 / 255.0)
                                                                                    green:(30.0 / 255.0)
                                                                                     blue:(30.0 / 255.0)
                                                                                    alpha:1.0]];
                }
            }
        }
    });
}

static void setupMacEditMenu(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSApplication *app = [NSApplication sharedApplication];
            [app setActivationPolicy:NSApplicationActivationPolicyRegular];

            // The app delegate is not installed here any more: see mdmemoInstallAppDelegate.

            NSMenu *mainMenu = [[NSMenu alloc] init];

            // 1. Application Menu
            NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
            NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"MD-Memo"];
            NSString *appName = @"MD-Memo";
            [appMenu addItemWithTitle:[NSString stringWithFormat:@"About %@", appName]
                               action:@selector(orderFrontStandardAboutPanel:)
                        keyEquivalent:@""];
            [appMenu addItem:[NSMenuItem separatorItem]];
            [appMenu addItemWithTitle:[NSString stringWithFormat:@"Hide %@", appName]
                               action:@selector(hide:)
                        keyEquivalent:@"h"];
            NSMenuItem *hideOthers = [[NSMenuItem alloc] initWithTitle:@"Hide Others"
                                                                action:@selector(hideOtherApplications:)
                                                         keyEquivalent:@"h"];
            [hideOthers setKeyEquivalentModifierMask:(NSEventModifierFlagOption | NSEventModifierFlagCommand)];
            [appMenu addItem:hideOthers];
            [appMenu addItemWithTitle:@"Show All"
                               action:@selector(unhideAllApplications:)
                        keyEquivalent:@""];
            [appMenu addItem:[NSMenuItem separatorItem]];
            // terminate: is answered by MDMemoAppDelegate's applicationShouldTerminate:, which
            // saves the session and exits through the same path as App.CloseWindow.
            [appMenu addItemWithTitle:[NSString stringWithFormat:@"Quit %@", appName]
                               action:@selector(terminate:)
                        keyEquivalent:@"q"];
            [appMenuItem setSubmenu:appMenu];
            [mainMenu addItem:appMenuItem];

            // 2. Edit Menu (Crucial for Cut, Copy, Paste, Select All, Undo, Redo)
            NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
            NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];

            [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
            NSMenuItem *redoItem = [[NSMenuItem alloc] initWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
            [editMenu addItem:redoItem];
            [editMenu addItem:[NSMenuItem separatorItem]];
            [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
            [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
            [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
            [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];

            [editMenuItem setSubmenu:editMenu];
            [mainMenu addItem:editMenuItem];

            // 3. Window Menu. Its only job is to let AppKit handle Cmd+M itself: the
            // frontend's own minimize shortcut goes through backend_minimizeWindow, but a Mac
            // user expects Cmd+M to work whether or not the web page has focus, and without a
            // Window menu AppKit has nothing to route it to.
            NSMenuItem *windowMenuItem = [[NSMenuItem alloc] init];
            NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
            [windowMenu addItemWithTitle:@"Minimize"
                                  action:@selector(performMiniaturize:)
                           keyEquivalent:@"m"];
            [windowMenu addItemWithTitle:@"Zoom"
                                  action:@selector(performZoom:)
                           keyEquivalent:@""];
            [windowMenuItem setSubmenu:windowMenu];
            [mainMenu addItem:windowMenuItem];

            [app setMainMenu:mainMenu];
            [app setWindowsMenu:windowMenu];
            [app activateIgnoringOtherApps:YES];
        }
    });
}
*/
import "C"

import (
	"log"
	"sync/atomic"

	"github.com/webview/webview_go"
)

func runPlatformWindow(app *App, serverURL string) {
	// Before the run loop starts: a file that launched the app is delivered as soon as it runs.
	setOSOpenHandler(app.OpenFromOS)

	// Synchronously and before webview.New, so a file that launched the app reaches our
	// application:openFiles: (see mdmemoInstallAppDelegate). webview_go's init has locked this
	// goroutine to the main thread.
	C.mdmemoInstallAppDelegate()
	C.setupMacEditMenu()

	w := webview.New(false)
	if w == nil {
		return
	}
	defer func() {
		atomic.StoreInt32(&app.isDestroyed, 1)
		w.Destroy()
	}()

	app.w = w

	// Cmd+Q, the Quit menu item and Dock > Quit end here once the page has saved its session
	// (applicationShouldTerminate: in the preamble): the same exit as App.CloseWindow, so this
	// function's and main's defers run and ipc-session.json is removed.
	setOSQuitHandler(func() { closePlatformWindow(app) })

	w.SetTitle("MD-Memo")
	w.SetSize(1050, 720, webview.HintNone)

	C.setupMacWindowDelegate(w.Window())

	// Register the configured global summon shortcut, exactly as the Windows path does. It is
	// dispatched onto the main queue so it still runs once [NSApp run] has started (webview.New
	// no longer spins a temporary run loop, see mdmemoInstallAppDelegate), i.e. after
	// finishLaunching, as it always did.
	w.Dispatch(func() {
		if !updateGlobalHotKeyNative(initialGlobalShortcut(app)) {
			log.Printf("global summon hotkey could not be registered")
		}
	})

	// Bind Go RPC methods. bindCommonBackend (bind_common.go) covers every backend_X -> app.Y
	// bind that is identical on Windows and macOS; only the inline-closure and platform-specific
	// binds are listed here.
	bindCommonBackend(w, app)
	// Minimize really minimizes, and quit really quits. Both were wired to App.CloseWindow,
	// which destroyed the webview: the NSWindow went away, NSApp kept running, and the
	// process survived with no window, no Dock reopen path and its HTTP/IPC listeners still
	// bound - unreachable and unkillable short of Activity Monitor.
	_ = w.Bind("backend_minimizeWindow", func() error {
		C.mdmemoMinimizeWindow()
		return nil
	})
	_ = w.Bind("backend_toggleMaximize", func() error {
		C.mdmemoToggleFullScreen()
		return nil
	})
	// macOS has one "full screen" (its own space, no title bar, the Dock and menu bar tucked away): the same call.
	_ = w.Bind("backend_toggleFullscreen", func() error {
		C.mdmemoToggleFullScreen()
		return nil
	})
	_ = w.Bind("backend_forceQuit", app.CloseWindow)
	// There is no honest native IME switch on macOS yet (see F9 / GetPlatformCapabilities):
	// TIS input-source switching is a separate, riskier piece of work. The bind stays a
	// no-op, and backend_getPlatformCapabilities now tells the frontend so explicitly
	// instead of letting the IME Guardian assume it worked.
	_ = w.Bind("backend_setIMEMode", func(enableJapanese bool) error { return nil })

	w.Init(`
		// --- Async bridge -------------------------------------------------------------
		// Some backend calls (Jev prediction, scrap search) used to be synchronous binds,
		// which run INLINE ON THE UI THREAD and froze the window for the duration of the
		// call. They are now started with a backend_xxxAsync(reqID, ...) bind and completed
		// by a window.__onXxxResult(reqID, result, errMsg) callback. This helper keeps the
		// frontend-facing API identical: window.backend.<fn>(args) still returns a Promise
		// that resolves to the same shape and rejects on error. Pending entries are always
		// removed on resolve, reject, or the safety timeout, so the map cannot leak.
		window.__mdmemoPending = window.__mdmemoPending || {};
		window.__mdmemoSeq = 0;
		window.__mdmemoSettle = function (reqID, result, errMsg) {
			var p = window.__mdmemoPending[reqID];
			if (!p) { return; }
			delete window.__mdmemoPending[reqID];
			if (p.timer) { clearTimeout(p.timer); }
			if (errMsg) { p.reject(new Error(errMsg)); } else { p.resolve(result); }
		};
		window.__mdmemoAsync = function (prefix, timeoutMs, invoke) {
			var reqID = prefix + (++window.__mdmemoSeq) + '_' + Date.now();
			return new Promise(function (resolve, reject) {
				var entry = { resolve: resolve, reject: reject, timer: null };
				var fail = function (e) {
					if (!window.__mdmemoPending[reqID]) { return; }
					delete window.__mdmemoPending[reqID];
					if (entry.timer) { clearTimeout(entry.timer); }
					reject(e);
				};
				entry.timer = setTimeout(function () {
					fail(new Error(prefix + 'request timed out'));
				}, timeoutMs);
				window.__mdmemoPending[reqID] = entry;
				var r;
				try {
					r = invoke(reqID);
				} catch (e) {
					fail(e);
					return;
				}
				if (r && typeof r.catch === 'function') { r.catch(fail); }
			});
		};
		window.__onJevPredictResult = function (reqID, result, errMsg) {
			window.__mdmemoSettle(reqID, result, errMsg);
		};
		window.__onSearchScrapsResult = function (reqID, result, errMsg) {
			window.__mdmemoSettle(reqID, result, errMsg);
		};

		// Tell Go the document is loaded. A cold boot with piped stdin waits for this
		// signal (with a short fallback timeout) before appending the scrap, instead of
		// guessing with a fixed sleep. backend_uiReady is idempotent, so signalling from
		// both events is harmless.
		(function () {
			var signalReady = function () {
				try { window.backend_uiReady(); } catch (e) { /* binding not ready yet */ }
			};
			if (document.readyState === 'complete' || document.readyState === 'interactive') {
				signalReady();
			} else {
				document.addEventListener('DOMContentLoaded', signalReady, { once: true });
				window.addEventListener('load', signalReady, { once: true });
			}
		})();

		window.backend = {
			getAppVersion: () => window.backend_getAppVersion(),
			getPlatformCapabilities: () => window.backend_getPlatformCapabilities(),
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
			exportConfig: (configJson) => window.backend_exportConfig(configJson),
			importConfig: () => window.backend_importConfig(),
			packListExportable: (projectHint) => window.backend_packListExportable(projectHint || ""),
			packExport: (selectionJson, configJson) => window.backend_packExport(selectionJson || "", configJson || ""),
			packInspect: (projectHint) => window.backend_packInspect(projectHint || ""),
			packImport: (packPath, selectionJson, projectHint) => window.backend_packImport(packPath || "", selectionJson || "", projectHint || ""),
			runCommandFilter: (cmdStr, input) => window.backend_runCommandFilter(cmdStr, input),
			runCommandFilterAsync: (reqID, cmdStr, input) => window.backend_runCommandFilterAsync(reqID, cmdStr, input),
			cancelCommandFilter: (reqID) => window.backend_cancelCommandFilter(reqID),
			getSession: () => window.backend_getSession(),
			saveSession: (sessionJson) => window.backend_saveSession(sessionJson),
			getStartupFile: () => window.backend_getStartupFile(),
			openFile: () => window.backend_openFile(),
			openFolder: () => window.backend_openFolder(),
			scanFolderFiles: (rootPath) => window.backend_scanFolderFiles(rootPath),
			readFileByPath: (path) => window.backend_readFileByPath(path),
			saveFile: (path, content, enc) => window.backend_saveFile(path, content, enc),
			saveFileAs: (content, enc, defaultName) => window.backend_saveFileAs(content, enc, defaultName || ""),
			exportPlainTextAs: (content, enc, defaultName) => window.backend_exportPlainTextAs(content, enc, defaultName || ""),
			queryLLMAsync: (reqID, prompt, configJson) => window.backend_queryLLMAsync(reqID, prompt, configJson),
			queryVisionAsync: (reqID, prompt, imageBase64, mimeType, configJson) => window.backend_queryVisionAsync(reqID, prompt, imageBase64, mimeType, configJson),
			generateImageAsync: (reqID, prompt, configJson, notePath) => window.backend_generateImageAsync(reqID, prompt, configJson, notePath || ""),
			autocompleteAsync: (reqID, prefix, suffix, configJson) => window.backend_autocompleteAsync(reqID, prefix, suffix, configJson),
			trimMemory: () => window.backend_trimMemory(),
			closeWindow: () => window.backend_closeWindow(),
			minimizeWindow: () => window.backend_minimizeWindow(),
			toggleFullscreen: () => window.backend_toggleFullscreen(),
			toggleMaximize: () => window.backend_toggleMaximize(),
			forceQuit: () => window.backend_forceQuit(),
			openExternal: (url) => window.backend_openExternal(url),
			setIMEMode: (enableJapanese) => window.backend_setIMEMode(!!enableJapanese),
			updateGlobalShortcut: (sc) => window.backend_updateGlobalShortcut(sc || ""),
			checkOllamaRunning: () => window.backend_checkOllamaRunning(),
			startOllamaService: () => window.backend_startOllamaService(),
			stopOllamaService: () => window.backend_stopOllamaService(),
			setupOllamaGemma4Async: (reqID) => window.backend_setupOllamaGemma4Async(reqID),
			cancelOllamaSetup: (reqID) => window.backend_cancelOllamaSetup(reqID),
			generateCliCommandAsync: (reqID, prompt, configJson, contextJson) => window.backend_generateCliCommandAsync(reqID, prompt, configJson, contextJson || ""),
			validateCliCommand: (cmdStr) => window.backend_validateCliCommand(cmdStr),
			searchScraps: (query, maxResults) => window.__mdmemoAsync('searchScraps_', 30000, (reqID) => window.backend_searchScrapsAsync(reqID, query, maxResults || 100)),
			triggerGitSync: () => window.backend_triggerGitSync(),
			getGitRepoStatus: (dir) => window.backend_getGitRepoStatus(dir || ""),
			setupGitRemote: (dir, remoteUrl, branch) => window.backend_setupGitRemote(dir || "", remoteUrl || "", branch || ""),
			checkGitInstalled: () => window.backend_checkGitInstalled(),
			testGitRemote: (remoteUrl) => window.backend_testGitRemote(remoteUrl || ""),
			testDiscordBridgeConnection: (botToken, allowedUserId) => window.backend_testDiscordBridgeConnection(botToken || "", allowedUserId || ""),
			parseSlotsRPC: (fullText, cursorOffset, configJson) => window.backend_parseSlotsRPC(fullText, cursorOffset, configJson),
			runSlotAgentAsync: (reqID, filePath, fullText, cursorOffset, configJson) => window.backend_runSlotAgentAsync(reqID, filePath, fullText, cursorOffset, configJson),
			cancelSlotAgent: (reqID) => window.backend_cancelSlotAgent(reqID),
			getSlotHoverPeek: (reqID) => window.backend_getSlotHoverPeek(reqID),
			watchActiveFile: (filePath) => window.backend_watchActiveFile(filePath),
			unwatchActiveFile: () => window.backend_unwatchActiveFile(),
			getDefaultAgentsConfigYAML: () => window.backend_getDefaultAgentsConfigYAML(),
			getDefaultAgentsConfigMarkdown: () => window.backend_getDefaultAgentsConfigMarkdown(),
			getActiveAgentsConfigStatus: (scrapDir) => window.backend_getActiveAgentsConfigStatus(scrapDir || ""),
			getActiveSlotConfigJSON: () => window.backend_getActiveSlotConfigJSON(),
			checkAgentAvailability: (agentName) => window.backend_checkAgentAvailability(agentName || ""),
			detectLLMProvider: (baseUrl, apiKey) => window.backend_detectLLMProvider(baseUrl || "", apiKey || ""),
			updateActiveAgentsConfigDefaultAgent: (scrapDir, agentName) => window.backend_updateActiveAgentsConfigDefaultAgent(scrapDir || "", agentName || ""),
			exportAgentsConfigFile: (format) => window.backend_exportAgentsConfigFile(format || "yaml"),
			importAgentsConfigFile: () => window.backend_importAgentsConfigFile(),
			openAgentsConfigFile: (scrapDir) => window.backend_openAgentsConfigFile(scrapDir || ""),
			jevPredict: (contextText, cursorOffset) => window.__mdmemoAsync('jevPredict_', 15000, (reqID) => window.backend_jevPredictAsync(reqID, contextText, cursorOffset || 0)),
			jevExecute: (candidateJson, contextText) => window.backend_jevExecute(candidateJson, contextText || ""),
			jevExecuteAsync: (reqID, candidateJson, contextText) => window.backend_jevExecuteAsync(reqID, candidateJson, contextText || ""),
			jevVerify: (cmdStr) => window.backend_jevVerify(cmdStr),
			jevDispatchAgent: (input) => window.backend_jevDispatchAgent(input || ""),
			jevPruneContext: (rawMarkdown, query) => window.backend_jevPruneContext(rawMarkdown || "", query || ""),
			startMobileDrop: (visionConfigJson) => window.backend_startMobileDrop(visionConfigJson || ""),
			startMobileDropWithVoice: (visionConfigJson, voiceConfigJson) => window.backend_startMobileDropWithVoice(visionConfigJson || "", voiceConfigJson || ""),
			setMobileDropSharedText: (text) => window.backend_setMobileDropSharedText(text || ""),
			cancelMobileDrop: () => window.backend_cancelMobileDrop(),
			requestMobileDropTunnel: () => window.backend_requestMobileDropTunnelAsync(),
			saveAsset: (baseDir, ext, dataBase64) => window.backend_saveAsset(baseDir || "", ext || "", dataBase64 || ""),
			importAssetFile: (baseDir, fileName, dataBase64) => window.backend_importAssetFile(baseDir || "", fileName || "", dataBase64 || ""),
			openPath: (target, baseDir) => window.backend_openPath(target || "", baseDir || ""),
			revealPath: (target, baseDir) => window.backend_revealPath(target || "", baseDir || ""),
			transcribeAudioAsync: (reqID, audioBase64, mimeType, voiceConfigJson) => window.backend_transcribeAudioAsync(reqID, audioBase64 || "", mimeType || "", voiceConfigJson || ""),
			getSpeechStatus: (voiceConfigJson) => window.backend_getSpeechStatus(voiceConfigJson || ""),
			installSpeechPartAsync: (reqID, which, voiceConfigJson) => window.backend_installSpeechPartAsync(reqID, which || "", voiceConfigJson || ""),
			cancelSpeechInstall: (reqID) => window.backend_cancelSpeechInstall(reqID),
			removeSpeechPart: (which, voiceConfigJson) => window.backend_removeSpeechPart(which || "", voiceConfigJson || ""),
			validateWhisperModelFile: (path) => window.backend_validateWhisperModelFile(path || ""),
			pickFilePath: (title) => window.backend_pickFilePath(title || ""),
			openInboxFolder: () => window.backend_openInboxFolder(),
			retryVoiceCacheAsync: (reqID, cachePath, voiceConfigJson) => window.backend_retryVoiceCacheAsync(reqID, cachePath || "", voiceConfigJson || ""),
			keepVoiceCache: (cachePath, baseDir) => window.backend_keepVoiceCache(cachePath || "", baseDir || ""),
			discardVoiceCache: (cachePath) => window.backend_discardVoiceCache(cachePath || "")
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}

// activatePlatformWindow fronts the window for the "pipe" and "activate" IPC actions. It was
// an empty function, so `md-memo` launched a second time, or `something | md-memo`, appended
// the scrap and left the window exactly where it was - usually behind whatever the user was
// looking at, or miniaturized in the Dock.
//
// trimProcessWorkingSet, closePlatformWindow, checkSingleInstance and initialGlobalShortcut used
// to live below this function. They call no C.* function, so they were moved to
// platform_darwin.go (no import "C", `//go:build darwin` only) so they - and the rest of this
// package - still type-check with CGO_ENABLED=0 (see platform_darwin_nocgo.go for the stubs that
// replace the cgo-only functions that remain here).
func activatePlatformWindow() {
	C.mdmemoActivateWindow()
}
