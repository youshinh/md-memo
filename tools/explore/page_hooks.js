// In-page half of the exploration kit (tools/explore/kit.mjs). It is injected into every document BEFORE any page script runs
// (Page.addScriptToEvaluateOnNewDocument), right after `window.__EXPLORE_INIT = {...}` (notes / config / llm / backend from
// startExplore). It sits on top of the docshots mock backend (tools/docshots/mock/backend.js); nothing under frontend/ or
// tools/docshots/ is modified.
//
// What it does:
//   - boot data: applies the session's notes and config overrides to window.__DOCSHOT_BOOT the moment the page assigns it
//   - fault injection: wraps window.backend the moment the mock assigns it (LLM modes, failing / delayed / read-only saves)
//   - records: every status-bar message (toast) and every LLM request, in window.__explore
//   - a fake clipboard: navigator.clipboard and synthetic copy / cut / paste never touch the real OS clipboard
//   - window.__explore.state(): the snapshot s.state() returns
(function () {
  'use strict';
  var INIT = window.__EXPLORE_INIT || {};
  var clock = (typeof performance !== 'undefined' && performance.now) ? function () { return Math.round(performance.now()); } : function () { return 0; };

  var X = window.__explore = {
    init: INIT,
    toasts: [],          // [{ text, at }] every non-empty status-bar message, oldest first
    llmLog: [],          // [{ seq, kind, reqId, prompt, cfg, mode, at, answers: [{ at, chars, error }] }]
    seq: 0,
    llm: Object.assign({ mode: 'ok' }, INIT.llm),
    faults: {},          // backend function name -> fault spec (see setBackend)
    readOnlyPaths: [],
    clip: { text: '', html: '', image: '' },   // the fake clipboard; image is a data: URL
    hookErrors: []
  };

  function num(v, dflt) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : dflt; }
  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  // ---- boot data: notes and config -----------------------------------------------------------------------
  function deepMerge(target, src) {
    Object.keys(src || {}).forEach(function (k) {
      var v = src[k];
      if (v === undefined) return;
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepMerge(target[k], v);
      else target[k] = v;
    });
    return target;
  }
  X.deepMerge = deepMerge;

  var NOTE_DIR = 'C:\\Users\\demo\\Documents\\notes\\';

  function transformBoot(B) {
    if (Array.isArray(INIT.notes)) {
      var tabs = INIT.notes.map(function (n, i) {
        var id = 'tab_x' + (i + 1);
        return { id: id, title: n.title || ('note-' + (i + 1) + '.md'), path: n.path || '', content: String(n.content == null ? '' : n.content),
          isDirty: false, encoding: 'UTF-8', cursorPos: typeof n.cursor === 'number' ? n.cursor : 0 };
      });
      B.session.tabs = tabs;
      B.session.activeTabId = tabs.length ? tabs[0].id : null;
      B.session.tabCounter = tabs.length + 1;
      B.noteFiles = tabs.filter(function (t) { return t.path; }).map(function (t) { return { path: t.path, title: t.title, content: t.content }; });
    }
    if (INIT.config) deepMerge(B.config, INIT.config);
  }

  var bootValue;
  Object.defineProperty(window, '__DOCSHOT_BOOT', {
    configurable: true,
    get: function () { return bootValue; },
    set: function (v) {
      bootValue = v;
      try { transformBoot(v); } catch (e) { X.hookErrors.push('boot: ' + e); }
    }
  });

  // ---- fault injection -------------------------------------------------------------------------------------
  var DEFAULT_ERROR = 'ローカルLLM/API接続エラー (http://localhost:11434): Post "http://localhost:11434/v1/chat/completions": dial tcp 127.0.0.1:11434: connectex: No connection could be made because the target machine actively refused it.';

  function hugeText(lines) {
    var out = [];
    for (var i = 1; i <= lines; i++) out.push('Line ' + i + ': the quick brown fox jumps over the lazy dog, again and again.');
    return out.join('\n');
  }

  function fill(text, entry) {
    return String(text).replace(/\{n\}/g, String(entry.seq)).replace(/\{id\}/g, String(entry.reqId));
  }

  // Answers a request the way window_windows.go does: through window.__onLLMResult(reqId, text, errorText).
  function scheduleAnswer(entry, delayMs, text, error) {
    setTimeout(function () {
      entry.answers.push({ at: clock(), chars: String(text).length, error: error || '' });
      if (typeof window.__onLLMResult === 'function') window.__onLLMResult(entry.reqId, text, error || '');
    }, delayMs);
  }

  function llmRequest(kind, reqId, prompt, cfgJson) {
    var m = X.llm || { mode: 'ok' };
    var entry = { seq: ++X.seq, kind: kind, reqId: reqId, prompt: prompt, cfg: safeParse(cfgJson), mode: m.mode || 'ok', at: clock(), answers: [] };
    X.llmLog.push(entry);
    var d = num(m.delayMs, 200);
    var reply = fill(m.reply != null ? m.reply : 'Reply {n}.', entry);
    switch (entry.mode) {
      case 'fail': scheduleAnswer(entry, d, '', m.error != null ? String(m.error) : DEFAULT_ERROR); break;
      case 'slow': scheduleAnswer(entry, num(m.delayMs, 5000), reply, ''); break;
      case 'never': break;
      case 'double':
        scheduleAnswer(entry, d, reply, '');
        scheduleAnswer(entry, d + num(m.gapMs, 100), fill(m.reply2 != null ? m.reply2 : 'Second reply {n}.', entry), '');
        break;
      case 'think': scheduleAnswer(entry, d, '<think>Let me think about this for a moment.</think>', ''); break;
      case 'huge': scheduleAnswer(entry, d, hugeText(num(m.lines, 20000)), ''); break;
      case 'fenced': scheduleAnswer(entry, d, '```markdown\n' + reply + '\n```', ''); break;
      case 'empty': scheduleAnswer(entry, d, '', ''); break;
      default: scheduleAnswer(entry, d, reply, '');
    }
    return Promise.resolve(null);
  }

  function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
  function isReadOnly(p) {
    var n = normPath(p);
    return X.readOnlyPaths.some(function (r) { var q = normPath(r); return n === q || n.indexOf(q.replace(/\/+$/, '') + '/') === 0; });
  }

  function applyFault(f, orig, ctx, args) {
    f.used = (f.used || 0) + 1;
    if (f.times && f.used > f.times) return orig.apply(ctx, args);
    function go() {
      if (f.never) return new Promise(function () {});
      if (f.fail !== undefined && f.fail !== null) return Promise.reject(new Error(String(f.fail)));
      if (Object.prototype.hasOwnProperty.call(f, 'result')) return Promise.resolve(f.result);
      return orig.apply(ctx, args);
    }
    return f.delayMs ? new Promise(function (r) { setTimeout(r, f.delayMs); }).then(go) : go();
  }

  function wrapBackend(b) {
    if (!b || typeof b !== 'object') return b;
    var w = {};
    Object.keys(b).forEach(function (name) {
      var orig = b[name];
      if (typeof orig !== 'function') { w[name] = orig; return; }
      w[name] = function () {
        var args = arguments;
        if (name === 'queryLLMAsync') return llmRequest('llm', args[0], args[1], args[2]);
        if (name === 'queryVisionAsync') return llmRequest('vision', args[0], args[1], args[4]);
        if (name === 'saveFile' && isReadOnly(args[0])) {
          return Promise.reject(new Error('open ' + args[0] + ': Access is denied.'));
        }
        var f = X.faults[name];
        if (f) return applyFault(f, orig, this, args);
        return orig.apply(this, args);
      };
    });
    Object.defineProperty(w, '__exploreWrapped', { value: true });
    return w;
  }

  var backendValue;
  Object.defineProperty(window, 'backend', {
    configurable: true,
    get: function () { return backendValue; },
    set: function (v) { backendValue = wrapBackend(v); }
  });

  X.setLlm = function (spec) { X.llm = Object.assign({ mode: 'ok' }, spec || {}); return X.llm; };

  // spec: { readOnlyPaths?: string[], clipboard?: { text?, html?, image? } | null, <backendFunctionName>: fault | null }
  //   fault: { fail?: string, result?: any, never?: true, delayMs?: number, times?: number }; null removes it.
  X.setBackend = function (spec) {
    Object.keys(spec || {}).forEach(function (k) {
      var v = spec[k];
      if (k === 'readOnlyPaths') X.readOnlyPaths = Array.isArray(v) ? v.slice() : [];
      else if (k === 'clipboard') X.setClipboard(v);
      else if (v === null) delete X.faults[k];
      else X.faults[k] = Object.assign({}, v);
    });
    return { faults: Object.keys(X.faults), readOnlyPaths: X.readOnlyPaths.slice() };
  };

  X.reset = function () { X.toasts.length = 0; X.llmLog.length = 0; };

  // ---- toasts: every non-empty status-bar message ----------------------------------------------------------
  function watchToasts() {
    var el = document.getElementById('stat-message');
    if (!el) return false;
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'characterData') { if (r.target.data) X.toasts.push({ text: r.target.data, at: clock() }); return; }
        for (var i = 0; i < r.addedNodes.length; i++) {
          var text = r.addedNodes[i].textContent;
          if (text) X.toasts.push({ text: text, at: clock() });
        }
      });
    }).observe(el, { childList: true, characterData: true, subtree: true });
    return true;
  }
  if (!watchToasts()) {
    var waiter = new MutationObserver(function () { if (watchToasts()) waiter.disconnect(); });
    waiter.observe(document, { childList: true, subtree: true });
  }

  // ---- the fake clipboard ---------------------------------------------------------------------------------
  // A 16x16 checkerboard PNG: what `image: true` puts on the fake clipboard.
  var TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJUlEQVR4nGMIzdaHow+f38MRLnGGQaiBGEXI4oNRwyAM1pEYDwAFsOCQg89cjwAAAABJRU5ErkJggg==';

  X.setClipboard = function (c) {
    c = c || {};
    X.clip = { text: c.text ? String(c.text) : '', html: c.html ? String(c.html) : '', image: c.image === true ? TINY_PNG : (c.image ? String(c.image) : '') };
    return X.clip;
  };

  function dataUrlToFile(url) {
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(url);
    if (!m) return null;
    var mime = m[1] || 'image/png', bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], 'clipboard.' + (mime.split('/')[1] || 'png'), { type: mime });
  }

  function isEditable(t) { return !!t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text') || t.isContentEditable); }

  var fakeClipboard = {
    readText: function () { return Promise.resolve(X.clip.text || ''); },
    writeText: function (t) { X.clip = { text: String(t), html: '', image: '' }; return Promise.resolve(); },
    read: function () {
      var types = {};
      if (X.clip.text) types['text/plain'] = new Blob([X.clip.text], { type: 'text/plain' });
      if (X.clip.html) types['text/html'] = new Blob([X.clip.html], { type: 'text/html' });
      var file = X.clip.image ? dataUrlToFile(X.clip.image) : null;
      if (file) types[file.type] = file;
      return Promise.resolve(Object.keys(types).length ? [new ClipboardItem(types)] : []);
    },
    write: function (items) {
      var next = { text: '', html: '', image: '' };
      var jobs = [];
      (items || []).forEach(function (item) {
        item.types.forEach(function (type) {
          jobs.push(item.getType(type).then(function (blob) {
            if (type === 'text/plain') return blob.text().then(function (s) { next.text = s; });
            if (type === 'text/html') return blob.text().then(function (s) { next.html = s; });
            if (type.indexOf('image/') === 0) return new Promise(function (res) { var r = new FileReader(); r.onloadend = function () { next.image = String(r.result); res(); }; r.readAsDataURL(blob); });
          }));
        });
      });
      return Promise.all(jobs).then(function () { X.clip = next; });
    }
  };
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: function () { return fakeClipboard; } }); } catch (e) { X.hookErrors.push('clipboard: ' + e); }

  // Synthetic paste / copy / cut: what the browser would do for the shortcut, against the fake clipboard.
  X.paste = function () {
    var target = document.activeElement || document.body;
    var dt = new DataTransfer();
    if (X.clip.text) dt.setData('text/plain', X.clip.text);
    if (X.clip.html) dt.setData('text/html', X.clip.html);
    var file = X.clip.image ? dataUrlToFile(X.clip.image) : null;
    if (file) dt.items.add(file);
    var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ev.__explore = true;
    var proceed = target.dispatchEvent(ev);
    if (proceed && isEditable(target) && X.clip.text) document.execCommand('insertText', false, X.clip.text);
    return { defaultPrevented: !proceed };
  };

  X.copy = function (cut) {
    var target = document.activeElement || document.body;
    var text = '';
    if (target && typeof target.selectionStart === 'number') text = String(target.value).slice(target.selectionStart, target.selectionEnd);
    else text = String(window.getSelection());
    var dt = new DataTransfer();
    var ev = new ClipboardEvent(cut ? 'cut' : 'copy', { clipboardData: dt, bubbles: true, cancelable: true });
    ev.__explore = true;
    var proceed = target.dispatchEvent(ev);
    if (!proceed) {
      X.clip = { text: dt.getData('text/plain'), html: dt.getData('text/html'), image: '' };
    } else if (text) {
      X.clip = { text: text, html: '', image: '' };
      if (cut && isEditable(target)) document.execCommand('delete');
    }
    return { defaultPrevented: !proceed };
  };

  // The shortcut itself: key events for the app's own key handlers, then the clipboard action unless the app took the key.
  X.clipKey = function (action, mods) {
    mods = mods || {};
    var target = document.activeElement || document.body;
    var init = { key: action === 'paste' ? 'v' : (action === 'cut' ? 'x' : 'c'), ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, bubbles: true, cancelable: true };
    var cont = target.dispatchEvent(new KeyboardEvent('keydown', init));
    var res = { keyHandled: !cont };
    if (cont) res.result = action === 'paste' ? X.paste() : X.copy(action === 'cut');
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return res;
  };

  // Safety net: a real (trusted) clipboard event would carry the user's real OS clipboard. Swallow it.
  ['paste', 'copy', 'cut'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (e.isTrusted && !e.__explore) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
  });

  // ---- snapshot ---------------------------------------------------------------------------------------------
  function isOpen(id) {
    var e = document.getElementById(id);
    if (!e || e.classList.contains('hidden')) return false;
    var cs = window.getComputedStyle ? window.getComputedStyle(e) : null;
    return !cs || cs.display !== 'none';
  }

  X.state = function () {
    var rpc = window.__mdMemoRPC;
    var rows = [];
    try { rows = rpc ? rpc.getTabs() : []; } catch (e) { rows = []; }
    var activeTabId = null;
    var tabs = rows.map(function (t) {
      if (t.isActive) activeTabId = t.id;
      var content = null;
      try { content = rpc.getBuffer(t.id).content; } catch (e) { /* tab vanished */ }
      return { id: t.id, title: t.title, dirty: !!t.isModified, path: t.path, content: content };
    });
    var ed = document.getElementById('editor');
    var msg = document.getElementById('stat-message');
    var ind = document.getElementById('stat-llm-indicator');
    var pending = 0;
    if (ind && !ind.classList.contains('hidden')) {
      var txt = document.getElementById('stat-llm-text');
      var m = /(\d+)/.exec(txt ? txt.textContent : '');
      pending = m ? parseInt(m[1], 10) : 1;
    }
    return {
      tabs: tabs,
      activeTabId: activeTabId,
      editor: ed ? { value: ed.value, selectionStart: ed.selectionStart, selectionEnd: ed.selectionEnd } : null,
      panels: {
        ask: isOpen('inline-prompt-bar'),
        cli: isOpen('cli-filter-bar'),
        quickActions: isOpen('jev-action-panel'),
        palette: isOpen('quick-pick-modal'),
        search: isOpen('find-replace-bar') || isOpen('scraps-search-modal'),
        settings: isOpen('settings-modal'),
        confirm: isOpen('confirm-modal'),
        tasks: isOpen('running-tasks-panel')
      },
      statusText: msg ? msg.textContent : '',
      toasts: X.toasts.slice(-20).map(function (t) { return t.text; }),
      pendingLlm: pending
    };
  };
})();
