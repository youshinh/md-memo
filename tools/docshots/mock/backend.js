// Mock backend for the documentation screenshots. Injected by tools/docshots/server.mjs into an
// in-memory copy of frontend/index.html, before any app script runs.
//
// It replaces window.backend (normally bound by window_windows.go), fixes the clock, blocks every
// request that leaves the local server and seeds localStorage. It never opens files, launches
// programs or talks to a real service.
(function () {
  'use strict';
  var B = window.__DOCSHOT_BOOT;
  var D = window.__docshot = {
    boot: B,
    calls: [],
    ghost: '',
    jev: [],
    slotRuns: [],
    workspaceScanned: false,
    llmReply: 'Demo reply.',
  };

  // ---- fixed clock: advances normally from a fixed start, or stops on demand ----------------------
  var RealDate = Date;
  var base = new RealDate(B.clock.y, B.clock.m, B.clock.d, B.clock.h, B.clock.mi, 0).getTime();
  var t0 = RealDate.now();
  var frozen = null;
  function nowMs() { return frozen !== null ? frozen : base + (RealDate.now() - t0); }
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs()); else super(...args); }
    static now() { return nowMs(); }
  }
  window.Date = FakeDate;
  D.freezeClock = function () { frozen = nowMs(); return frozen; };
  D.unfreezeClock = function () { if (frozen !== null) { t0 = RealDate.now(); base = frozen; frozen = null; } };

  // ---- nothing leaves the local server ------------------------------------------------------------
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var raw = typeof input === 'string' ? input : (input && input.url) || '';
    var abs = new URL(raw, location.href);
    if (abs.origin !== location.origin) {
      D.calls.push({ fn: 'fetch(blocked)', args: [abs.origin] });
      return Promise.reject(new TypeError('docshot: network blocked'));
    }
    return realFetch(input, init);
  };

  // ---- seed storage so the first paint already has the demo state ---------------------------------
  try {
    localStorage.clear();
    localStorage.setItem('md_notepad_config_v3', JSON.stringify(B.config));
    localStorage.setItem('md_memo_session_v1', JSON.stringify(B.session));
    localStorage.setItem('md_memo_workspace_folder', B.workspace.root);
    localStorage.setItem('md_memo_cli_history', JSON.stringify(B.cliHistory));
  } catch (e) { /* storage unavailable: the backend mock below still supplies everything */ }

  // ---- backend ------------------------------------------------------------------------------------
  var resolve = function (v) { return Promise.resolve(v); };
  var log = function (fn, args) { D.calls.push({ fn: fn, args: Array.prototype.slice.call(args, 0, 3) }); };

  function findNote(p) {
    for (var i = 0; i < B.noteFiles.length; i++) if (B.noteFiles[i].path === p) return B.noteFiles[i];
    return null;
  }

  function parseSlots(text, cursor) {
    var re = /\{\{([\s\S]*?)\}\}/g;
    var m, slots = [];
    while ((m = re.exec(text))) {
      slots.push({
        type: 'slot', openDelimiter: '{{', closeDelim: '}}',
        startOffset: m.index, endOffset: m.index + m[0].length, rawContent: m[0],
        role: 'code', instruction: m[1].trim(), isInline: true, isTarget: false,
      });
    }
    var target = null;
    for (var i = 0; i < slots.length; i++) {
      if (cursor >= slots[i].startOffset && cursor <= slots[i].endOffset) { target = slots[i]; break; }
    }
    if (!target && slots.length) target = slots[0];
    if (target) target.isTarget = true;
    return { targetSlot: target || undefined, allSlots: slots, hasWaitingApproval: false };
  }

  function searchScraps(query) {
    var q = String(query || '').toLowerCase();
    var out = [];
    B.scraps.forEach(function (f) {
      var lines = f.content.split('\n');
      var matches = [];
      lines.forEach(function (line, i) {
        if (q && line.toLowerCase().indexOf(q) !== -1) {
          var parts = [];
          if (i > 0) parts.push(lines[i - 1]);
          parts.push(line);
          if (i + 1 < lines.length) parts.push(lines[i + 1]);
          matches.push({ lineNumber: i + 1, lineText: line, snippet: parts.join('\n') });
        }
      });
      if (matches.length) out.push({ filePath: f.filePath, fileName: f.fileName, matches: matches });
    });
    return out;
  }

  var impl = {
    getAppVersion: function () { return resolve(B.version); },
    getPlatformCapabilities: function () { return resolve({ os: 'win32', nativeImeSwitch: true, tray: true, globalHotkey: true }); },
    getConfig: function () { return resolve(JSON.stringify(B.config)); },
    saveConfig: function () { return resolve(null); },
    getSession: function () { return resolve(JSON.stringify(B.session)); },
    saveSession: function () { return resolve(null); },
    getStartupFile: function () { return resolve(null); },
    scanFolderFiles: function () {
      return resolve(B.workspace.notes).then(function (v) { setTimeout(function () { D.workspaceScanned = true; }, 400); return v; });
    },
    readFileByPath: function (p) {
      var n = findNote(p);
      return resolve(n ? { path: n.path, title: n.title, content: n.content, encoding: 'UTF-8' } : { path: p, title: String(p).split(/[\\/]/).pop(), content: '', encoding: 'UTF-8' });
    },
    saveFile: function (p) { return resolve({ path: p, title: String(p).split(/[\\/]/).pop(), success: true }); },
    saveFileAs: function () { return resolve(null); },
    queryLLMAsync: function (reqId) {
      setTimeout(function () { if (window.__onLLMResult) window.__onLLMResult(reqId, D.llmReply, ''); }, 600);
      return resolve(null);
    },
    autocompleteAsync: function (reqId) {
      setTimeout(function () { if (window.__onAutocompleteResult) window.__onAutocompleteResult(reqId, D.ghost || '', ''); }, 40);
      return resolve(null);
    },
    jevPredict: function () { return resolve({ candidates: D.jev || [] }); },
    parseSlotsRPC: function (text, cursor) { return resolve(parseSlots(text, cursor)); },
    runSlotAgentAsync: function (reqId, filePath, text, cursor) {
      D.slotRuns.push({ reqId: reqId, filePath: filePath, cursor: cursor });
      return resolve(null);
    },
    getSlotHoverPeek: function (reqId) { return resolve((D.peek && D.peek[reqId]) || ''); },
    getActiveSlotConfigJSON: function () { return resolve(JSON.stringify(B.slotConfig)); },
    getActiveAgentsConfigStatus: function () { return resolve({ is_external: false, default_agent: 'claude-code' }); },
    checkAgentAvailability: function (name) { return resolve({ available: true, command: name === 'hermes' ? 'ollama' : (name || 'claude') }); },
    detectLLMProvider: function () { return resolve('ollama'); },
    checkOllamaRunning: function () { return resolve(true); },
    checkGitInstalled: function () { return resolve({ installed: true }); },
    getGitRepoStatus: function () { return resolve({ is_git: true, remote_url: 'https://github.com/demo-user/scraps.git' }); },
    testGitRemote: function () { return resolve({ success: true, message: 'ok' }); },
    triggerGitSync: function () { return resolve({ success: true, message: 'up to date' }); },
    searchScraps: function (q) { return resolve(searchScraps(q)); },
    startMobileDrop: function () { return resolve({ qrDataUri: B.qrDataUri, url: B.phoneUrl, idleTimeoutSeconds: 60 }); },
    startMobileDropWithVoice: function () { return resolve({ qrDataUri: B.qrDataUri, url: B.phoneUrl, idleTimeoutSeconds: 60 }); },
    saveAsset: function (dir, ext) { return resolve({ relPath: './assets/pasted-1.' + (ext || 'png'), fileUrl: '' }); },
    importAssetFile: function (dir, name) { return resolve({ relPath: './assets/' + name, fileUrl: '' }); },
    updateGlobalShortcut: function () { return resolve(true); },
    validateCliCommand: function (cmd) { return resolve({ isSafe: true, reason: '', command: cmd }); },
    exportConfig: function () { return resolve(null); },
    importConfig: function () { return resolve(null); },
  };

  // Every other backend function exists (the app checks for it) and does nothing.
  var names = ('runCommandFilter runCommandFilterAsync cancelCommandFilter openFile openFolder saveFileAs exportPlainTextAs ' +
    'queryVisionAsync generateImageAsync trimMemory closeWindow minimizeWindow toggleMaximize forceQuit openExternal setIMEMode ' +
    'startOllamaService stopOllamaService setupOllamaGemma4Async cancelOllamaSetup generateCliCommandAsync setupGitRemote ' +
    'cancelSlotAgent watchActiveFile unwatchActiveFile getDefaultAgentsConfigYAML getDefaultAgentsConfigMarkdown ' +
    'updateActiveAgentsConfigDefaultAgent exportAgentsConfigFile importAgentsConfigFile openAgentsConfigFile jevExecute ' +
    'jevExecuteAsync jevVerify jevDispatchAgent jevPruneContext setMobileDropSharedText cancelMobileDrop requestMobileDropTunnel ' +
    'openPath revealPath transcribeAudioAsync retryVoiceCacheAsync keepVoiceCache discardVoiceCache').split(' ');

  var backend = {};
  Object.keys(impl).forEach(function (k) {
    backend[k] = function () { log(k, arguments); return impl[k].apply(null, arguments); };
  });
  names.forEach(function (k) {
    if (!backend[k]) backend[k] = function () { log(k, arguments); return resolve(null); };
  });
  window.backend = backend;

  // ---- helpers for the harness (never used by the app) --------------------------------------------
  // Re-asserts a piece of text that the app clears on a timer, so a picture taken a moment later still has it.
  D.pin = function (selector, text) {
    var el = document.querySelector(selector);
    if (!el) return false;
    var want = text === undefined ? el.textContent : text;
    el.textContent = want;
    var obs = new MutationObserver(function () { if (el.textContent !== want) el.textContent = want; });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    D.pins = (D.pins || []).concat([obs]);
    return true;
  };

  // ---- editor helpers (coordinates are viewport pixels, i.e. picture pixels at scale 1) -------------
  D.editor = function () { return document.getElementById('editor'); };
  D.lineHeight = function () { return parseFloat(getComputedStyle(D.editor()).lineHeight) || 22; };
  D.charXY = function (index) {
    var ed = D.editor();
    var c = window.getCharPixelCoords(index, ed);
    var r = ed.getBoundingClientRect();
    return { x: r.left + c.left - ed.scrollLeft, y: r.top + c.top - ed.scrollTop };
  };
  D.find = function (str, from) { return D.editor().value.indexOf(str, from || 0); };
  D.lineStart = function (line) { // 1-based line number -> offset of its first character
    var lines = D.editor().value.split('\n'), off = 0;
    for (var i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    return off;
  };
  D.lineEnd = function (line) { return D.lineStart(line) + (D.editor().value.split('\n')[line - 1] || '').length; };
  // Rect of the first occurrence of `str` (single line).
  D.textRect = function (str, from) {
    var i = D.find(str, from);
    if (i < 0) return null;
    var a = D.charXY(i), b = D.charXY(i + str.length);
    return { x: a.x, y: a.y, w: Math.max(b.x - a.x, 8), h: D.lineHeight() };
  };
  D.lineRect = function (line) { // rect of the text on a (non-wrapped) line
    var a = D.charXY(D.lineStart(line)), b = D.charXY(D.lineEnd(line));
    return { x: a.x, y: a.y, w: Math.max(b.x - a.x, 8), h: D.lineHeight() };
  };
  D.setCaret = function (start, end) {
    var ed = D.editor();
    ed.focus();
    ed.setSelectionRange(start, end === undefined ? start : end);
    ed.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  };
  // Scroll so that `line` is `linesFromTop` lines below the top of the editor.
  D.scrollToLine = function (line, linesFromTop) {
    var ed = D.editor();
    var g = document.getElementById('line-numbers');
    ed.scrollTop = Math.max(0, (line - 1 - (linesFromTop || 0)) * D.lineHeight());
    ed.dispatchEvent(new Event('scroll'));
    // The line-number gutter is refreshed a moment after an edit; re-sync it once it has its full height.
    setTimeout(function () { if (g) g.scrollTop = ed.scrollTop; }, 300);
  };
  // Crop rectangles (viewport pixels): a band of editor lines around the caret / around a line.
  D.cropCaret = function (before, after, width, x) {
    var p = D.charXY(D.editor().selectionStart), lh = D.lineHeight();
    return { x: x || 0, y: p.y - before * lh, w: width, h: (before + after + 1) * lh };
  };
  D.cropLine = function (line, before, after, width, x) {
    var p = D.charXY(D.lineStart(line)), lh = D.lineHeight();
    return { x: x || 0, y: p.y - before * lh, w: width, h: (before + after + 1) * lh };
  };
  D.ghostRect = function () {
    var s = document.querySelector('#ghost-overlay .ghost-suggestion');
    if (!s || !s.textContent) return null;
    var r = s.getClientRects()[0];
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };

  // Ready = the session is restored and the workspace scan (which feeds the related-note pills) is done.
  D.isReady = function () {
    var tabs = document.querySelectorAll('#tabs-list .tab-item').length;
    var msg = document.getElementById('stat-message');
    return document.readyState === 'complete' && tabs >= 1 && D.workspaceScanned && !(msg && msg.textContent.trim());
  };
})();
