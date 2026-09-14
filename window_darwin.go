//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa

#import <Cocoa/Cocoa.h>

@interface MDMemoAppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate>
@end

@implementation MDMemoAppDelegate
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    for (NSWindow *win in [sender windows]) {
        [win makeKeyAndOrderFront:nil];
    }
    return YES;
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [sender orderOut:nil];
    return NO;
}
@end

static MDMemoAppDelegate *gAppDelegate = nil;

static void setupMacWindowDelegate(void *nsWindow) {
    if (nsWindow == NULL) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSWindow *win = (__bridge NSWindow *)nsWindow;
            if (gAppDelegate != nil) {
                [win setDelegate:gAppDelegate];
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

            [app setMainMenu:mainMenu];
            [app activateIgnoringOtherApps:YES];
        }
    });
}
*/
import "C"

import (
	"sync/atomic"

	"github.com/webview/webview_go"
)

func runPlatformWindow(app *App, serverURL string) {
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

	// Bind Go RPC methods
	_ = w.Bind("backend_getConfig", app.GetConfig)
	_ = w.Bind("backend_saveConfig", app.SaveConfig)
	_ = w.Bind("backend_exportConfig", app.ExportConfig)
	_ = w.Bind("backend_importConfig", app.ImportConfig)
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
	_ = w.Bind("backend_closeWindow", app.CloseWindow)
	_ = w.Bind("backend_minimizeWindow", app.CloseWindow)
	_ = w.Bind("backend_forceQuit", app.CloseWindow)
	_ = w.Bind("backend_openExternal", app.OpenExternal)
	_ = w.Bind("backend_setIMEMode", func(enableJapanese bool) error { return nil })
	_ = w.Bind("backend_updateGlobalShortcut", app.UpdateGlobalShortcut)
	_ = w.Bind("backend_checkOllamaRunning", app.CheckOllamaRunning)
	_ = w.Bind("backend_startOllamaService", app.StartOllamaService)
	_ = w.Bind("backend_stopOllamaService", app.StopOllamaService)
	_ = w.Bind("backend_setupOllamaGemma4Async", app.SetupOllamaGemma4Async)
	_ = w.Bind("backend_cancelOllamaSetup", app.CancelOllamaSetup)

	w.Init(`
		window.backend = {
			getConfig: () => window.backend_getConfig(),
			saveConfig: (configJson) => window.backend_saveConfig(configJson),
			exportConfig: (configJson) => window.backend_exportConfig(configJson),
			importConfig: () => window.backend_importConfig(),
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
			validateCliCommand: (cmdStr) => window.backend_validateCliCommand(cmdStr)
		};
	`)

	w.Navigate(serverURL)
	w.Run()
}

func trimProcessWorkingSet() {}

func checkSingleInstance() bool {
	return true
}

func updateGlobalHotKeyNative(shortcutStr string) bool {
	return true
}


