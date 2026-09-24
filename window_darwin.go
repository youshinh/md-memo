//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

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

            if (gAppDelegate == nil) {
                gAppDelegate = [[MDMemoAppDelegate alloc] init];
                [app setDelegate:gAppDelegate];
            }

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
	"time"

	"md-memo/pkg/ipc"
	"md-memo/pkg/singleinstance"

	"github.com/webview/webview_go"
)

func runPlatformWindow(app *App, serverURL string) {
	// Before the run loop starts: a file that launched the app is delivered as soon as it runs.
	setOSOpenHandler(app.OpenFromOS)

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

	w.SetTitle("MD-Memo")
	w.SetSize(1050, 720, webview.HintNone)

	C.setupMacWindowDelegate(w.Window())

	// Register the configured global summon shortcut, exactly as the Windows path does. This
	// runs on the main thread (webview_go locks the main goroutine to it in its init) and
	// after webview.New, so NSApp already exists.
	if !updateGlobalHotKeyNative(initialGlobalShortcut(app)) {
		log.Printf("global summon hotkey could not be registered")
	}

	// Bind Go RPC methods
	_ = w.Bind("backend_getAppVersion", app.GetAppVersion)
	_ = w.Bind("backend_getPlatformCapabilities", app.GetPlatformCapabilities)
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
	_ = w.Bind("backend_exportConfig", app.ExportConfig)
	_ = w.Bind("backend_importConfig", app.ImportConfig)
	_ = w.Bind("backend_packListExportable", app.PackListExportable)
	_ = w.Bind("backend_packExport", app.PackExport)
	_ = w.Bind("backend_packInspect", app.PackInspect)
	_ = w.Bind("backend_packImport", app.PackImport)
	_ = w.Bind("backend_runCommandFilter", app.RunCommandFilter)
	_ = w.Bind("backend_runCommandFilterAsync", app.RunCommandFilterAsync)
	_ = w.Bind("backend_generateCliCommandAsync", app.GenerateCliCommandAsync)
	_ = w.Bind("backend_validateCliCommand", app.ValidateCliCommand)
	_ = w.Bind("backend_cancelCommandFilter", app.CancelCommandFilter)
	_ = w.Bind("backend_getSession", app.GetSession)
	_ = w.Bind("backend_saveSession", app.SaveSession)
	_ = w.Bind("backend_getStartupFile", app.GetStartupFile)
	_ = w.Bind("backend_openFile", app.OpenFile)
	_ = w.Bind("backend_saveFile", app.SaveFile)
	_ = w.Bind("backend_saveFileAs", app.SaveFileAs)
	_ = w.Bind("backend_exportPlainTextAs", app.ExportPlainTextAs)
	_ = w.Bind("backend_openFolder", app.OpenFolder)
	_ = w.Bind("backend_scanFolderFiles", app.ScanFolderFiles)
	_ = w.Bind("backend_readFileByPath", app.ReadFileByPath)
	_ = w.Bind("backend_queryLLMAsync", app.QueryLLMAsync)
	_ = w.Bind("backend_queryVisionAsync", app.QueryVisionAsync)
	_ = w.Bind("backend_generateImageAsync", app.GenerateImageAsync)
	_ = w.Bind("backend_autocompleteAsync", app.AutocompleteAsync)
	_ = w.Bind("backend_trimMemory", app.TrimMemory)
	_ = w.Bind("backend_uiReady", app.MarkUIReady)
	_ = w.Bind("backend_closeWindow", app.CloseWindow)
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
	_ = w.Bind("backend_openExternal", app.OpenExternal)
	// There is no honest native IME switch on macOS yet (see F9 / GetPlatformCapabilities):
	// TIS input-source switching is a separate, riskier piece of work. The bind stays a
	// no-op, and backend_getPlatformCapabilities now tells the frontend so explicitly
	// instead of letting the IME Guardian assume it worked.
	_ = w.Bind("backend_setIMEMode", func(enableJapanese bool) error { return nil })
	_ = w.Bind("backend_updateGlobalShortcut", app.UpdateGlobalShortcut)
	_ = w.Bind("backend_reportRPCResult", app.ReportRPCResult)
	_ = w.Bind("backend_searchScraps", app.SearchScraps)
	_ = w.Bind("backend_searchScrapsAsync", app.SearchScrapsAsync)
	_ = w.Bind("backend_triggerGitSync", app.TriggerGitSync)
	_ = w.Bind("backend_getGitRepoStatus", app.GetGitRepoStatus)
	_ = w.Bind("backend_setupGitRemote", app.SetupGitRemote)
	_ = w.Bind("backend_checkGitInstalled", app.CheckGitInstalled)
	_ = w.Bind("backend_testGitRemote", app.TestGitRemote)
	_ = w.Bind("backend_testDiscordBridgeConnection", app.TestDiscordBridgeConnection)
	_ = w.Bind("backend_startMobileDrop", app.StartMobileDrop)
	_ = w.Bind("backend_startMobileDropWithVoice", app.StartMobileDropWithVoice)
	_ = w.Bind("backend_setMobileDropSharedText", app.SetMobileDropSharedText)
	_ = w.Bind("backend_cancelMobileDrop", app.CancelMobileDrop)
	_ = w.Bind("backend_requestMobileDropTunnelAsync", app.RequestMobileDropTunnelAsync)
	_ = w.Bind("backend_saveAsset", app.SaveAsset)
	_ = w.Bind("backend_importAssetFile", app.ImportAssetFile)
	_ = w.Bind("backend_openPath", app.OpenPath)
	_ = w.Bind("backend_revealPath", app.RevealPath)
	_ = w.Bind("backend_transcribeAudioAsync", app.TranscribeAudioAsync)
	_ = w.Bind("backend_getSpeechStatus", app.GetSpeechStatus)
	_ = w.Bind("backend_installSpeechPartAsync", app.InstallSpeechPartAsync)
	_ = w.Bind("backend_cancelSpeechInstall", app.CancelSpeechInstall)
	_ = w.Bind("backend_removeSpeechPart", app.RemoveSpeechPart)
	_ = w.Bind("backend_validateWhisperModelFile", app.ValidateWhisperModelFile)
	_ = w.Bind("backend_pickFilePath", app.PickFilePath)
	_ = w.Bind("backend_openInboxFolder", app.OpenInboxFolder)
	_ = w.Bind("backend_retryVoiceCacheAsync", app.RetryVoiceCacheAsync)
	_ = w.Bind("backend_keepVoiceCache", app.KeepVoiceCache)
	_ = w.Bind("backend_discardVoiceCache", app.DiscardVoiceCache)
	_ = w.Bind("backend_checkOllamaRunning", app.CheckOllamaRunning)
	_ = w.Bind("backend_startOllamaService", app.StartOllamaService)
	_ = w.Bind("backend_stopOllamaService", app.StopOllamaService)
	_ = w.Bind("backend_setupOllamaGemma4Async", app.SetupOllamaGemma4Async)
	_ = w.Bind("backend_cancelOllamaSetup", app.CancelOllamaSetup)
	_ = w.Bind("backend_parseSlotsRPC", app.ParseSlotsRPC)
	_ = w.Bind("backend_runSlotAgentAsync", app.RunSlotAgentAsync)
	_ = w.Bind("backend_cancelSlotAgent", app.CancelSlotAgent)
	_ = w.Bind("backend_getSlotHoverPeek", app.GetSlotHoverPeek)
	_ = w.Bind("backend_watchActiveFile", app.WatchActiveFile)
	_ = w.Bind("backend_unwatchActiveFile", app.UnwatchActiveFile)
	_ = w.Bind("backend_getDefaultAgentsConfigYAML", app.GetDefaultAgentsConfigYAML)
	_ = w.Bind("backend_getDefaultAgentsConfigMarkdown", app.GetDefaultAgentsConfigMarkdown)
	_ = w.Bind("backend_getActiveAgentsConfigStatus", app.GetActiveAgentsConfigStatus)
	_ = w.Bind("backend_getActiveSlotConfigJSON", app.GetActiveSlotConfigJSON)
	_ = w.Bind("backend_checkAgentAvailability", app.CheckAgentAvailability)
	_ = w.Bind("backend_detectLLMProvider", app.DetectLLMProvider)
	_ = w.Bind("backend_updateActiveAgentsConfigDefaultAgent", app.UpdateActiveAgentsConfigDefaultAgent)
	_ = w.Bind("backend_exportAgentsConfigFile", app.ExportAgentsConfigFile)
	_ = w.Bind("backend_importAgentsConfigFile", app.ImportAgentsConfigFile)
	_ = w.Bind("backend_openAgentsConfigFile", app.OpenAgentsConfigFile)
	_ = w.Bind("backend_jevPredict", app.JevPredict)
	_ = w.Bind("backend_jevPredictAsync", app.JevPredictAsync)
	_ = w.Bind("backend_jevExecute", app.JevExecute)
	_ = w.Bind("backend_jevExecuteAsync", app.JevExecuteAsync)
	_ = w.Bind("backend_jevVerify", app.JevVerify)
	_ = w.Bind("backend_jevDispatchAgent", app.JevDispatchAgent)
	_ = w.Bind("backend_jevPruneContext", app.JevPruneContext)

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

// trimProcessWorkingSet is a no-op on macOS: there is no EmptyWorkingSet equivalent, and the
// kernel reclaims pages from an idle process on its own. App.TrimMemory still runs
// debug.FreeOSMemory off the UI thread on this platform, which is the part that matters here.
//
// Because this is a no-op, the windowVisible flag that gates the delayed trim has no effect
// on macOS, so the Cocoa show/hide paths (applicationShouldHandleReopen / windowShouldClose,
// both implemented in Objective-C above) deliberately do not call back into Go just to set
// it - that would mean exporting Go callbacks through cgo for no behavioural gain.
func trimProcessWorkingSet() {}

// closePlatformWindow implements App.CloseWindow for macOS.
//
// It stops the Cocoa run loop rather than destroying the webview. webview's cocoa engine
// closes the NSWindow on Destroy but never terminates NSApp, so the old behaviour left the
// process alive with no window: applicationShouldHandleReopen had nothing to show, the Dock
// icon did nothing, and the HTTP server and IPC listener stayed bound to their ports.
//
// Terminating this way (rather than [NSApp terminate:nil]) lets webview_run return normally,
// so runPlatformWindow's deferred Destroy and main's deferred ipcServer.Close() /
// listener.Close() all still run - which is what removes ipc-session.json on exit.
func closePlatformWindow(a *App) {
	if a.w == nil {
		return
	}
	// On macOS closing always ends the process (Terminate below), so the App is destroyed from here on.
	atomic.StoreInt32(&a.isDestroyed, 1)
	a.w.Dispatch(func() {
		if term, ok := a.w.(interface{ Terminate() }); ok {
			term.Terminate()
			return
		}
		if closer, ok := a.w.(interface{ Destroy() }); ok {
			closer.Destroy()
		}
	})
}

// checkSingleInstance reports whether this process may continue starting up.
//
// macOS had no check at all: it returned true unconditionally. Since the IPC handoff gained
// an acknowledgement handshake, a handoff that is not acknowledged deliberately falls through
// to a normal startup, so "no check" really did mean two full instances could run - and the
// second one overwrote ipc-session.json and then deleted it on exit, breaking the CLI for the
// first one.
func checkSingleInstance() bool {
	acquired, err := singleinstance.Acquire()
	if err != nil {
		// The lock file itself is unusable (unwritable config dir, a filesystem without
		// flock). Refusing to launch over that would be a worse failure than the duplicate
		// instance it guards against.
		log.Printf("single-instance lock unavailable, starting anyway: %v", err)
		return true
	}
	if acquired {
		return true
	}

	// Another live instance holds the lock. Bring it to the front - the same courtesy the
	// Windows mutex path performs with its broadcast activate message - and exit quietly.
	targetPort := ipc.DefaultPort
	if session, sessErr := ipc.LoadSession(); sessErr == nil && session != nil && session.Port > 0 {
		targetPort = session.Port
	}
	_ = ipc.Send(targetPort, &ipc.Message{
		Action:    ipc.ActionActivate,
		Timestamp: time.Now().Format(time.RFC3339),
	}, 300*time.Millisecond)

	return false
}

// activatePlatformWindow fronts the window for the "pipe" and "activate" IPC actions. It was
// an empty function, so `md-memo` launched a second time, or `something | md-memo`, appended
// the scrap and left the window exactly where it was - usually behind whatever the user was
// looking at, or miniaturized in the Dock.
func activatePlatformWindow() {
	C.mdmemoActivateWindow()
}

// initialGlobalShortcut reads shortcuts.globalSummon from the config, going through the App's
// cached reader so config.json is not read from disk again on the critical path. It mirrors
// getInitialGlobalShortcut in window_windows.go and shares its parsing.
func initialGlobalShortcut(app *App) string {
	var raw string
	if app != nil {
		raw, _ = app.GetConfig()
	}
	return parseGlobalSummonShortcut(raw)
}
