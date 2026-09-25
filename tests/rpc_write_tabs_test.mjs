// RPC writes to any tab, tab.new / tab.close, buffer.save (the page's half of it).
//   window.__mdMemoRPC of the real app.js runs in a vm context against a hand-made DOM (textareas with a working undo stack
//   and native input events, held timers) and a mocked backend. Covered:
//     - resolveTab: no id = the active tab, an unknown id is a not_found error (getBuffer, switchTab, writeText, ...)
//     - writeText / writeTabText on the tab in the primary pane, in the split editor and on a background tab: text, dirty
//       flag, autosave, session save, no tab switch and no focus change, previous_hash, the hash lock in ONE synchronous call
//     - openTab (tab.new): background, dedupe by path
//     - closeTabChecked (tab.close): clean, dirty (prompt without waiting), if_saved (identical / different / edit during the
//       read / no path / unreadable), an unknown id
//     - prepareSave / commitSave (buffer.save): binding, watcher, autosave to the new path, conflict when edited in between
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const SRC = {
  i18n: read('frontend/js/i18n.js'),
  noteTitle: read('frontend/js/note_title.js'),
  noteHash: read('frontend/js/note_hash.js'),
  app: read('frontend/js/app.js')
};
const indexHtml = read('frontend/index.html');

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));
const nodeHash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

async function flush() {
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setImmediate(resolve));
}

// The error an RPC call throws for the Go side: "[kind] message"
async function rejection(fnOrPromise) {
  try {
    await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
  } catch (e) {
    return e;
  }
  assert.fail('expected an error');
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const windowListeners = {};
  const undoStack = [];
  const execCalls = [];
  const backendCalls = { saveFile: [], saveFileAs: [], watch: [], unwatch: [], readFile: [], saveSession: 0 };
  let documentMock = null;

  const addListener = (map, evt, fn, option) => {
    const capture = option === true || !!(option && typeof option === 'object' && option.capture);
    (map[evt] = map[evt] || []).push({ fn, capture });
  };
  const removeListener = (map, evt, fn, option) => {
    const capture = option === true || !!(option && typeof option === 'object' && option.capture);
    map[evt] = (map[evt] || []).filter((l) => !(l.fn === fn && l.capture === capture));
  };
  const makeEvent = (type, init) => Object.assign({
    type, key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; }
  }, init);
  function dispatchOn(el, evt, init) {
    const e = makeEvent(evt, init);
    e.target = el;
    const run = (list, capture) => {
      (list || []).filter((l) => l.capture === capture).slice().forEach((l) => l.fn(e));
      return e.propagationStopped;
    };
    if (run(el._listeners[evt], true)) return e;
    run(el._listeners[evt], false);
    return e;
  }

  const HIDDEN = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
    'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
    'secondary-pane', 'pane-resizer', 'preview-pane'];

  function mockElement(id, tagName = 'div') {
    const classes = new Set(HIDDEN.includes(id) ? ['hidden'] : []);
    const attrs = {};
    let innerHTML = '';
    let textContent = '';
    const el = {
      id, tagName: tagName.toUpperCase(), dataset: {}, style: {}, children: [], checked: false, disabled: false, value: '',
      title: '', placeholder: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0, scrollLeft: 0,
      scrollHeight: 1000, clientHeight: 500, offsetHeight: 500, offsetWidth: 500, onclick: null, _listeners: {},
      classList: {
        add: (...cls) => cls.forEach((c) => classes.add(c)),
        remove: (...cls) => cls.forEach((c) => classes.delete(c)),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c)
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get innerHTML() { return innerHTML; },
      set innerHTML(v) { innerHTML = v; textContent = v; if (v === '') el.children = []; },
      get textContent() { return textContent; },
      set textContent(v) { textContent = v; innerHTML = v; },
      addEventListener: (evt, fn, option) => addListener(el._listeners, evt, fn, option),
      removeEventListener: (evt, fn, option) => removeListener(el._listeners, evt, fn, option),
      dispatchEvent: (e) => dispatchOn(el, e.type, e),
      focus: () => { documentMock.activeElement = el; dispatchOn(el, 'focus', {}); },
      blur: () => { if (documentMock.activeElement === el) documentMock.activeElement = documentMock.body; },
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e, dir) => { el.selectionStart = s; el.selectionEnd = e; if (dir) el.selectionDirection = dir; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 500, right: 600, bottom: 500 }),
      scrollIntoView: () => {},
      appendChild: (child) => { el.children.push(child); child.parentElement = el; return child; },
      insertBefore: (node, ref) => {
        const i = el.children.indexOf(ref);
        if (i !== -1) el.children.splice(i, 0, node); else el.children.push(node);
        node.parentElement = el;
        return node;
      },
      querySelector: (sel) => (sel.startsWith('#') ? elements.get(sel.slice(1)) || null : null),
      querySelectorAll: () => [],
      getAttribute: (name) => (name in attrs ? attrs[name] : (name === 'data-i18n' ? el.dataset.i18n || null : null)),
      setAttribute: (name, val) => { attrs[name] = val; if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false
    };
    return el;
  }

  documentMock = {
    getElementById: (id) => {
      let el = elements.get(id);
      if (!el) {
        el = mockElement(id, (id === 'editor' || id === 'editor-secondary') ? 'textarea' : 'div');
        elements.set(id, el);
      }
      return el;
    },
    querySelector: (sel) => (sel.startsWith('#') ? documentMock.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => mockElement('', tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    // What the browser does for insertText: replace the selection of the focused field as one undo step, with a native input event.
    // 'delete' is refused here (the app then sets the value directly), like a browser that will not run the command.
    execCommand: (cmd, _ui, text) => {
      execCalls.push(cmd);
      if (cmd !== 'insertText' || opts.refuseExecCommand) return false;
      const ed = documentMock.activeElement;
      if (!ed || typeof ed.value !== 'string' || !ed.tagName || ed.tagName !== 'TEXTAREA') return false;
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      undoStack.push({ ed, value: ed.value, start, end });
      ed.value = ed.value.slice(0, start) + text + ed.value.slice(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      dispatchOn(ed, 'input', {});
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const files = new Map(Object.entries(opts.files || {})); // path -> content the mocked reader returns
  const backend = Object.assign({
    getConfig: async () => '',
    saveConfig: async () => {},
    getSession: async () => null,
    saveSession: async () => { backendCalls.saveSession++; },
    getStartupFile: async () => null,
    trimMemory: async () => {},
    saveFile: async (p, content, enc) => { backendCalls.saveFile.push({ path: p, content, enc }); return { path: p, success: true }; },
    saveFileAs: async (content, enc, name) => { backendCalls.saveFileAs.push({ content, enc, name }); return null; },
    watchActiveFile: (p) => { backendCalls.watch.push(p); },
    unwatchActiveFile: () => { backendCalls.unwatch.push(true); },
    readFileByPath: async (p) => {
      backendCalls.readFile.push(p);
      if (opts.onRead) await opts.onRead(p);
      if (!files.has(p)) throw new Error('not found: ' + p);
      return { path: p, content: files.get(p), encoding: 'UTF-8' };
    }
  }, opts.backend || {});

  // Timers of 100 ms or more (autosave 1500, session save 500, toast clearing) are held until the test fires them; short ones run at once.
  const heldTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 100) {
      heldTimers.set(id, { fn, ms });
      return id;
    }
    fn();
    return id;
  };

  const windowMock = {
    document: documentMock,
    localStorage: {
      _s: new Map(),
      getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
      setItem(k, v) { this._s.set(k, String(v)); },
      removeItem(k) { this._s.delete(k); }
    },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows', language: 'en-US' },
    addEventListener: (evt, fn, option) => addListener(windowListeners, evt, fn, option),
    removeEventListener: (evt, fn, option) => removeListener(windowListeners, evt, fn, option),
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { heldTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800
  };
  documentMock.defaultView = windowMock;
  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    setInterval: () => 1, clearInterval: () => {},
    Event: class { constructor(type, init) { Object.assign(this, { type, defaultPrevented: false }, init || {}); } },
    console: { log() {}, warn() {}, error(...a) { if (opts.showErrors) console.error(...a); } }
  };
  vm.createContext(context);
  const order = opts.withoutHash ? [SRC.i18n, SRC.noteTitle, SRC.app] : [SRC.i18n, SRC.noteTitle, SRC.noteHash, SRC.app];
  for (const code of order) {
    vm.runInContext(code, context);
    await flush();
  }

  const el = (id) => documentMock.getElementById(id);
  const rpc = windowMock.__mdMemoRPC;
  const env = {
    window: windowMock, rpc, backend, backendCalls, undoStack, execCalls, el, documentMock, files, flush,
    editor: el('editor'),
    secEditor: el('editor-secondary'),
    config: windowMock.__testHelper.config,
    testHelper: windowMock.__testHelper,
    heldCount: (ms) => Array.from(heldTimers.values()).filter((t) => t.ms === ms).length,
    fireTimers(ms) {
      for (const [id, t] of Array.from(heldTimers)) if (t.ms === ms) { heldTimers.delete(id); t.fn(); }
    },
    // what a user typing does: the value changes and the editor's input event fires
    type(editor, text) {
      editor.value = text;
      editor.selectionStart = editor.selectionEnd = text.length;
      dispatchOn(editor, 'input', {});
    },
    tabs: () => plain(rpc.getTabs()),
    active: () => plain(rpc.getTabs()).find((t) => t.isActive),
    // a second and third tab that are NOT on screen: a background tab is created without selecting it
    newBackground(spec) {
      return rpc.openTab(Object.assign({ background: true }, spec));
    },
    isDirty: (id) => plain(rpc.getTabs()).find((t) => t.id === id).isModified
  };
  return env;
}

// ---------------------------------------------------------------------------------------------------
// resolveTab and reads
// ---------------------------------------------------------------------------------------------------
check('getBuffer: no id is the active tab, an id is that tab (also one that is not on screen), an unknown id is a not_found error', async () => {
  const env = await createEnv();
  env.type(env.editor, 'first note');
  const bg = env.newBackground({ content: 'second note', title: 'Second.md' });

  assert.equal(env.rpc.getBuffer().content, 'first note');
  assert.equal(env.rpc.getBuffer('').content, 'first note');
  assert.equal(env.rpc.getBuffer(env.active().id).content, 'first note');
  const b = env.rpc.getBuffer(bg.id);
  assert.equal(b.content, 'second note');
  assert.equal(b.tabId, bg.id);
  assert.equal(b.isActive, false);

  const err = await rejection(() => env.rpc.getBuffer('bogus'));
  assert.equal(err.rpcKind, 'not_found');
  assert.equal(err.message, '[not_found] no such tab: bogus');
});

check('switchTab: an unknown id is not_found and the active tab stays; a known id switches', async () => {
  const env = await createEnv();
  const before = env.active().id;
  const bg = env.newBackground({ content: 'b' });
  const err = await rejection(() => env.rpc.switchTab('bogus'));
  assert.equal(err.rpcKind, 'not_found');
  assert.equal(env.active().id, before, 'the failed switch must leave the active tab alone');
  assert.equal(env.rpc.switchTab(bg.id), true);
  assert.equal(env.active().id, bg.id);
});

check('selectTab does nothing for an id that names no tab (it used to store the id first)', async () => {
  assert.match(SRC.app, /function selectTab\(tabId\) \{\n    \/\/[^\n]*\n[^\n]*\n    if \(!getTab\(tabId\)\) return;\n    clearGhostText\(\);/);
  // getSelection with an unknown id must fail before anything is selected
  const env = await createEnv();
  const before = env.active().id;
  const err = await rejection(() => env.rpc.getSelection('bogus'));
  assert.equal(err.rpcKind, 'not_found');
  const err2 = await rejection(() => env.rpc.replaceSelection('x', 'bogus', 0, 1));
  assert.equal(err2.rpcKind, 'not_found');
  assert.equal(env.active().id, before);
});

// ---------------------------------------------------------------------------------------------------
// writeText on the tab in the primary pane
// ---------------------------------------------------------------------------------------------------
check('writeText set on the active tab: through the editor (undoable), dirty, previous_hash and hash, generation-free result', async () => {
  const env = await createEnv();
  env.type(env.editor, 'old text\nline two');
  env.undoStack.length = 0;
  const id = env.active().id;
  const res = plain(env.rpc.writeText({ mode: 'set', content: 'new text\nline 2' }));

  assert.equal(env.editor.value, 'new text\nline 2');
  assert.equal(env.undoStack.length, 1, 'one undo step: the edit went through the editing command');
  assert.deepEqual(res, { tab_id: id, previous_hash: nodeHash('old text\nline two'), hash: nodeHash('new text\nline 2') });
  assert.equal(env.isDirty(id), true);
  assert.equal(env.rpc.getBuffer().content, 'new text\nline 2');
});

check('writeText append and replace on the active tab; replace clamps and defaults like the old replaceRange', async () => {
  const env = await createEnv();
  env.type(env.editor, 'abc\ndef\nghi');

  env.rpc.writeText({ mode: 'append', content: '\njkl' });
  assert.equal(env.editor.value, 'abc\ndef\nghi\njkl');

  env.rpc.writeText({ mode: 'replace', content: 'X', range: { startLine: 2, startCol: 2, endLine: 2, endCol: 3 } });
  assert.equal(env.editor.value, 'abc\ndXf\nghi\njkl');

  // both positions default to 1:1 on the CLI, so a replace without an end inserts at the start
  env.rpc.writeText({ mode: 'replace', content: '>> ', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 } });
  assert.equal(env.editor.value, '>> abc\ndXf\nghi\njkl');

  // out of range is clamped: everything from 3:2 to the end
  env.rpc.writeText({ mode: 'replace', content: '!', range: { startLine: 3, startCol: 2, endLine: 99, endCol: 99 } });
  assert.equal(env.editor.value, '>> abc\ndXf\ng!');

  // an empty replacement of an empty range changes nothing and never asks the browser to delete a character
  env.execCalls.length = 0;
  env.rpc.writeText({ mode: 'replace', content: '', range: { startLine: 1, startCol: 3, endLine: 1, endCol: 3 } });
  assert.equal(env.editor.value, '>> abc\ndXf\ng!');
  assert.ok(!env.execCalls.includes('delete'), 'an empty edit of an empty range must not run the delete command');
});

check('writeText set to the empty text clears the note (the command that is refused falls back to setting the value)', async () => {
  const env = await createEnv();
  env.type(env.editor, 'something');
  env.rpc.writeText({ mode: 'set', content: '' });
  assert.equal(env.editor.value, '');
  assert.equal(env.rpc.getBuffer().content, '');
});

check('writeText normalises CRLF and CR to LF (what the textarea would hold), so hash and text agree everywhere', async () => {
  const env = await createEnv();
  env.type(env.editor, 'x');
  const res = plain(env.rpc.writeText({ mode: 'set', content: 'a\r\nb\rc\n' }));
  assert.equal(env.editor.value, 'a\nb\nc\n');
  assert.equal(res.hash, nodeHash('a\nb\nc\n'));
  const bg = env.newBackground({ content: '' });
  const res2 = plain(env.rpc.writeText({ tabId: bg.id, mode: 'set', content: 'a\r\nb' }));
  assert.equal(env.rpc.getBuffer(bg.id).content, 'a\nb');
  assert.equal(res2.hash, nodeHash('a\nb'));
});

check('writeText with the editing command refused sets the value directly and still marks the tab dirty', async () => {
  const env = await createEnv({ refuseExecCommand: true });
  env.type(env.editor, 'x');
  const id = env.active().id;
  env.rpc.writeText({ mode: 'append', content: 'yz' });
  assert.equal(env.editor.value, 'xyz');
  assert.equal(env.isDirty(id), true);
});

check('writeText on the active tab keeps the focus, the caret and the active pane where the user had them', async () => {
  const env = await createEnv();
  env.type(env.editor, 'hello world');
  const findBox = env.el('find-input');
  findBox.value = 'wor';
  env.documentMock.activeElement = findBox; // the user is typing in the find box
  env.editor.selectionStart = 6;
  env.editor.selectionEnd = 11;
  env.editor.scrollTop = 42;

  env.rpc.writeText({ mode: 'replace', content: 'AAAA', range: { startLine: 1, startCol: 1, endLine: 1, endCol: 3 } }); // "he" -> "AAAA"
  assert.equal(env.editor.value, 'AAAAllo world');
  assert.equal(env.documentMock.activeElement, findBox, 'the focus goes back to where it was');
  assert.equal(env.editor.selectionStart, 8, 'a caret after the edit moves by the length change');
  assert.equal(env.editor.selectionEnd, 13);
  assert.equal(env.editor.scrollTop, 42);
});

check('writeText on the active tab does not take the focus from the other pane', async () => {
  const env = await createEnv();
  env.type(env.editor, 'primary text');
  env.newBackground({ content: 'second' });
  const secondId = env.tabs()[1].id;
  await env.testHelper.openSplitEditor(secondId); // the split editor is now the focused pane
  const paneFocused = (id) => env.el(id).classList.contains('pane-focused');
  assert.equal(paneFocused('secondary-pane'), true);
  assert.equal(env.documentMock.activeElement, env.secEditor);

  env.rpc.writeText({ tabId: env.tabs()[0].id, mode: 'append', content: '!' });
  assert.equal(env.editor.value, 'primary text!');
  assert.equal(paneFocused('secondary-pane'), true, 'the split editor stays the focused pane');
  assert.equal(paneFocused('editor-pane'), false);
  assert.equal(env.documentMock.activeElement, env.secEditor, 'and keeps the keyboard focus');
});

check('writeText on the active tab restores which pane is the focused one even when the keyboard focus was in a box, not an editor', async () => {
  const env = await createEnv();
  env.type(env.editor, 'primary text');
  env.newBackground({ content: 'second' });
  await env.testHelper.openSplitEditor(env.tabs()[1].id); // the split editor is the focused pane
  const box = env.el('find-input');
  env.documentMock.activeElement = box; // ...but the user is typing in the find box
  const paneFocused = (id) => env.el(id).classList.contains('pane-focused');
  assert.equal(paneFocused('secondary-pane'), true);

  env.rpc.writeText({ tabId: env.tabs()[0].id, mode: 'append', content: '!' });
  assert.equal(env.editor.value, 'primary text!');
  assert.equal(paneFocused('secondary-pane'), true, 'the pane the user was in is still the focused pane');
  assert.equal(paneFocused('editor-pane'), false);
  assert.equal(env.documentMock.activeElement, box);
});

// ---------------------------------------------------------------------------------------------------
// writeText on a tab that is not on screen
// ---------------------------------------------------------------------------------------------------
check('writeText --tab: a background tab is written without selecting it, touching the editor, the focus or the file watcher', async () => {
  const env = await createEnv();
  env.type(env.editor, 'active note');
  const activeId = env.active().id;
  const bg = env.newBackground({ title: 'Other.md', content: 'other body' });
  env.backendCalls.watch.length = 0;
  env.backendCalls.unwatch.length = 0;
  env.documentMock.activeElement = env.editor;
  env.undoStack.length = 0;

  const res = plain(env.rpc.writeText({ tabId: bg.id, mode: 'append', content: '\nmore' }));
  assert.equal(env.rpc.getBuffer(bg.id).content, 'other body\nmore');
  assert.deepEqual(res, { tab_id: bg.id, previous_hash: nodeHash('other body'), hash: nodeHash('other body\nmore') });
  assert.equal(env.active().id, activeId, 'the active tab did not change');
  assert.equal(env.editor.value, 'active note', 'the editor of the active tab was not touched');
  assert.equal(env.undoStack.length, 0, 'a background tab has no undo history and no editor command ran');
  assert.equal(env.backendCalls.watch.length + env.backendCalls.unwatch.length, 0, 'selectTab would have re-pointed the file watcher');
  assert.equal(env.documentMock.activeElement, env.editor);
  assert.equal(env.isDirty(bg.id), true, 'marked dirty like a user edit');
});

check('writeText on a background tab: set and replace; previous_hash lets a caller undo it', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: 'line one\nline two' });
  const original = env.rpc.getBuffer(bg.id).content;
  const r1 = plain(env.rpc.writeText({ tabId: bg.id, mode: 'replace', content: 'LINE', range: { startLine: 2, startCol: 1, endLine: 2, endCol: 5 } }));
  assert.equal(env.rpc.getBuffer(bg.id).content, 'line one\nLINE two');
  assert.equal(r1.previous_hash, nodeHash(original));
  const r2 = plain(env.rpc.writeText({ tabId: bg.id, mode: 'set', content: original, expectedHash: r1.hash }));
  assert.equal(r2.hash, nodeHash(original), 'writing the old text back with the hash of the last write restores it exactly');
});

check('writeText on a background tab with a file: the autosave is scheduled (and writes the file); without a file nothing is', async () => {
  const env = await createEnv();
  const withFile = env.newBackground({ title: 'a.md', path: 'C:\\notes\\a.md', content: 'a' });
  const noFile = env.newBackground({ title: 'b.md', content: 'b' });
  assert.equal(env.config.general.autoSave, true);
  const before = env.heldCount(1500);

  env.rpc.writeText({ tabId: noFile.id, mode: 'append', content: '2' });
  assert.equal(env.heldCount(1500), before, 'no path, no autosave');

  env.rpc.writeText({ tabId: withFile.id, mode: 'append', content: '2' });
  env.rpc.writeText({ tabId: withFile.id, mode: 'append', content: '3' });
  assert.equal(env.heldCount(1500), before + 1, 'one debounced timer per tab, not one per write');
  assert.equal(env.backendCalls.saveFile.length, 0);
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1);
  assert.deepEqual(plain(env.backendCalls.saveFile[0]), { path: 'C:\\notes\\a.md', content: 'a23', enc: 'UTF-8' });
  assert.equal(env.isDirty(withFile.id), false, 'the autosave cleaned the tab');
});

check('writeText with general.autoSave off schedules no autosave', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ title: 'a.md', path: '/notes/a.md', content: 'a' });
  env.config.general.autoSave = false;
  const before = env.heldCount(1500);
  env.rpc.writeText({ tabId: bg.id, mode: 'append', content: 'x' });
  assert.equal(env.heldCount(1500), before);
});

check('writeText schedules the (debounced) session save and refreshes the tab bar', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: 'a' });
  env.fireTimers(500);
  await env.flush();
  const saved = env.backendCalls.saveSession;
  env.rpc.writeText({ tabId: bg.id, mode: 'append', content: 'b' });
  assert.ok(env.heldCount(500) >= 1, 'a session save is pending');
  env.fireTimers(500);
  await env.flush();
  assert.equal(env.backendCalls.saveSession, saved + 1);
  assert.ok(env.el('tabs-list').children.length >= 2, 'the tab bar is drawn');
});

check('writeText on an untitled background tab updates its automatic title like typing does', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: '' });
  env.rpc.writeText({ tabId: bg.id, mode: 'set', content: '# Weekly plan\nbody' });
  assert.equal(plain(env.rpc.getTabs()).find((t) => t.id === bg.id).title, 'Weekly plan.md');
});

check('writeText on the tab in the split editor: through that editor, dirty, the focus and the active pane stay', async () => {
  const env = await createEnv();
  env.type(env.editor, 'primary');
  const bg = env.newBackground({ title: 'S.md', path: '/notes/s.md', content: 'secondary text' });
  await env.testHelper.openSplitEditor(bg.id);
  assert.equal(env.secEditor.value, 'secondary text');
  env.documentMock.activeElement = env.secEditor;
  env.undoStack.length = 0;
  const activeBefore = env.active().id;
  const timers = env.heldCount(1500);

  const res = plain(env.rpc.writeText({ tabId: bg.id, mode: 'append', content: '!' }));
  assert.equal(env.secEditor.value, 'secondary text!');
  assert.equal(env.undoStack.length, 1);
  assert.equal(env.undoStack[0].ed, env.secEditor, 'the split editor took the edit (undoable there)');
  assert.equal(env.rpc.getBuffer(bg.id).content, 'secondary text!');
  assert.equal(env.editor.value, 'primary', 'the primary editor is untouched');
  assert.equal(env.active().id, activeBefore);
  assert.equal(env.isDirty(bg.id), true);
  assert.equal(res.previous_hash, nodeHash('secondary text'));
  assert.equal(env.heldCount(1500), timers + 1, 'the tab has a file: its autosave is scheduled');
  assert.equal(env.el('secondary-pane').classList.contains('pane-focused'), true);
  assert.equal(env.documentMock.activeElement, env.secEditor);
});

// ---------------------------------------------------------------------------------------------------
// The lock: check and write in one call
// ---------------------------------------------------------------------------------------------------
check('writeText lock: expected_hash right writes, wrong is a conflict and writes nothing; the check and the write are one synchronous call', async () => {
  const env = await createEnv();
  env.type(env.editor, 'v1');
  const h1 = nodeHash('v1');

  const ret = env.rpc.writeText({ mode: 'set', content: 'v2', expectedHash: h1 });
  assert.equal(typeof ret.then, 'undefined', 'no await between the check and the write: a keystroke cannot slip in');
  assert.equal(env.editor.value, 'v2');

  const err = await rejection(() => env.rpc.writeText({ mode: 'set', content: 'v3', expectedHash: h1 }));
  assert.equal(err.rpcKind, 'conflict');
  assert.equal(err.message, `[conflict] conflict: expected hash ${h1} but buffer is at ${nodeHash('v2')}`);
  assert.equal(env.editor.value, 'v2', 'nothing was written');
  assert.equal(env.rpc.getBuffer().content, 'v2');
});

check('writeText lock on a background tab: a stale hash is refused there too', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: 'base' });
  const stale = nodeHash('base');
  env.rpc.writeText({ tabId: bg.id, mode: 'append', content: '+1' }); // someone else wrote
  const err = await rejection(() => env.rpc.writeText({ tabId: bg.id, mode: 'set', content: 'mine', expectedHash: stale }));
  assert.equal(err.rpcKind, 'conflict');
  assert.equal(env.rpc.getBuffer(bg.id).content, 'base+1');
});

check('writeText lock: expected_generation is compared with the counter the Go side passes', async () => {
  const env = await createEnv();
  env.type(env.editor, 'g');
  const err = await rejection(() => env.rpc.writeText({ mode: 'set', content: 'x', expectedGeneration: 5, currentGeneration: 6 }));
  assert.equal(err.rpcKind, 'conflict');
  assert.equal(err.message, '[conflict] conflict: expected generation 5 but buffer is at 6');
  assert.equal(env.editor.value, 'g');
  env.rpc.writeText({ mode: 'set', content: 'x', expectedGeneration: 6, currentGeneration: 6 });
  assert.equal(env.editor.value, 'x');
  // no expectation, no check
  env.rpc.writeText({ mode: 'set', content: 'y', currentGeneration: 99 });
  assert.equal(env.editor.value, 'y');
});

check('writeText with an unknown tab id is a not_found error and writes nothing anywhere', async () => {
  const env = await createEnv();
  env.type(env.editor, 'keep');
  const err = await rejection(() => env.rpc.writeText({ tabId: 'bogus', mode: 'set', content: 'x' }));
  assert.equal(err.rpcKind, 'not_found');
  assert.equal(err.message, '[not_found] no such tab: bogus');
  assert.equal(env.editor.value, 'keep');
});

check('a write whose screen refresh fails afterwards still reports success (so the caller does not retry an append); a write that never happened reports the error', async () => {
  const env = await createEnv();
  env.type(env.editor, 'x');
  const bg = env.newBackground({ content: 'base' });

  // the tab bar cannot be redrawn: the text was already written
  const bar = env.el('tabs-list');
  Object.defineProperty(bar, 'innerHTML', { configurable: true, get: () => '', set: () => { throw new Error('render failed'); } });
  const res = plain(env.rpc.writeText({ tabId: bg.id, mode: 'append', content: '+1' }));
  assert.equal(res.hash, nodeHash('base+1'));
  assert.equal(env.rpc.getBuffer(bg.id).content, 'base+1', 'written exactly once');
  assert.equal(env.isDirty(bg.id), true);
  delete bar.innerHTML;

  // the editor refuses the edit before anything changed: a real error, nothing written
  env.editor.focus = () => { throw new Error('focus refused'); };
  const err = await rejection(() => env.rpc.writeText({ mode: 'append', content: 'never' }));
  assert.match(err.message, /focus refused/);
  assert.equal(env.editor.value, 'x');
});

check('the older positional setBuffer / appendBuffer / replaceRange also write any tab without switching', async () => {
  const env = await createEnv();
  env.type(env.editor, 'active');
  const activeId = env.active().id;
  const bg = env.newBackground({ content: 'bg' });
  env.rpc.setBuffer('set', bg.id);
  env.rpc.appendBuffer('+', bg.id);
  env.rpc.replaceRange(1, 1, 1, 2, 'S', bg.id);
  assert.equal(env.rpc.getBuffer(bg.id).content, 'Set+');
  assert.equal(env.active().id, activeId);
});

// ---------------------------------------------------------------------------------------------------
// openTab (tab.new)
// ---------------------------------------------------------------------------------------------------
check('openTab: a new note; background adds a tab and moves nothing, otherwise it becomes the active tab', async () => {
  const env = await createEnv();
  env.type(env.editor, 'first');
  const first = env.active().id;
  env.documentMock.activeElement = env.editor;
  env.backendCalls.watch.length = env.backendCalls.unwatch.length = 0;

  const bg = plain(env.rpc.openTab({ title: 'Scratch.md', content: 'hi', background: true }));
  assert.deepEqual(Object.keys(bg).sort(), ['existing', 'id', 'path', 'title']);
  assert.equal(bg.title, 'Scratch.md');
  assert.equal(bg.path, '');
  assert.equal(bg.existing, false);
  assert.equal(env.tabs().length, 2);
  assert.equal(env.active().id, first, 'a background tab is not selected');
  assert.equal(env.editor.value, 'first');
  assert.equal(env.backendCalls.watch.length + env.backendCalls.unwatch.length, 0);
  assert.equal(env.rpc.getBuffer(bg.id).content, 'hi');
  assert.equal(env.isDirty(bg.id), false, 'a fresh tab is clean');

  const fg = plain(env.rpc.openTab({ content: 'shown' }));
  assert.equal(env.active().id, fg.id, 'without background the new tab is shown');
  assert.equal(env.editor.value, 'shown');
});

check('openTab without content is the usual new note (its date heading); content "" is an empty note', async () => {
  const env = await createEnv();
  const a = plain(env.rpc.openTab({ background: true }));
  assert.match(env.rpc.getBuffer(a.id).content, /^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n$/);
  const b = plain(env.rpc.openTab({ background: true, content: '' }));
  assert.equal(env.rpc.getBuffer(b.id).content, '');
});

check('openTab with a path: the file text and encoding are used; a file that is already open is not opened twice', async () => {
  const env = await createEnv();
  env.type(env.editor, 'x');
  const first = env.active().id;

  const opened = plain(env.rpc.openTab({ path: 'C:\\Users\\me\\Note.md', title: 'Note.md', content: 'from disk\r\nline', encoding: 'Shift_JIS', background: true }));
  assert.equal(opened.existing, false);
  assert.equal(opened.path, 'C:\\Users\\me\\Note.md');
  assert.equal(env.rpc.getBuffer(opened.id).content, 'from disk\nline');
  assert.equal(plain(env.rpc.prepareSave(opened.id)).encoding, 'Shift_JIS');

  const count = env.tabs().length;
  // the same file, spelled with other slashes and another case (a Windows path)
  for (const again of ['C:\\Users\\me\\Note.md', 'c:/users/ME/note.md', 'C:\\Users\\me\\Note.md\\']) {
    const dup = plain(env.rpc.openTab({ path: again, content: 'from disk', background: true }));
    assert.equal(dup.existing, true, again);
    assert.equal(dup.id, opened.id, again);
    assert.equal(dup.path, 'C:\\Users\\me\\Note.md');
  }
  assert.equal(env.tabs().length, count, 'no second tab');
  assert.equal(env.active().id, first, 'background: the existing tab is not brought forward');

  const shown = plain(env.rpc.openTab({ path: 'C:\\Users\\me\\Note.md', content: 'from disk' }));
  assert.equal(shown.existing, true);
  assert.equal(env.active().id, opened.id, 'without background the existing tab is shown');
  assert.equal(env.tabs().length, count);
});

check('openTab dedupe is case-sensitive for a POSIX path and treats no-path tabs as never matching', async () => {
  const env = await createEnv();
  const a = plain(env.rpc.openTab({ path: '/home/me/Note.md', content: 'a', background: true }));
  const b = plain(env.rpc.openTab({ path: '/home/me/note.md', content: 'b', background: true }));
  assert.notEqual(a.id, b.id, 'two files that differ only in case are two files on a case-sensitive system');
  const untitled = plain(env.rpc.openTab({ content: 'u', background: true }));
  const again = plain(env.rpc.openTab({ content: 'u2', background: true }));
  assert.notEqual(untitled.id, again.id);
});

// ---------------------------------------------------------------------------------------------------
// closeTabChecked (tab.close)
// ---------------------------------------------------------------------------------------------------
check('closeTabChecked: an unknown id is not_found, a missing id is invalid_params', async () => {
  const env = await createEnv();
  const e1 = await rejection(env.rpc.closeTabChecked('bogus', false));
  assert.equal(e1.rpcKind, 'not_found');
  assert.equal(e1.message, '[not_found] no such tab: bogus');
  const e2 = await rejection(env.rpc.closeTabChecked('', false));
  assert.equal(e2.rpcKind, 'invalid_params');
  assert.equal(env.tabs().length, 1);
});

check('closeTabChecked: a clean tab is closed (a background one without touching the active tab)', async () => {
  const env = await createEnv();
  env.type(env.editor, 'keep');
  const activeId = env.active().id;
  const bg = env.newBackground({ content: 'gone soon' });
  const res = plain(await env.rpc.closeTabChecked(bg.id, false));
  assert.deepEqual(res, { closed: true });
  assert.deepEqual(env.tabs().map((t) => t.id), [activeId]);
  assert.equal(env.active().id, activeId);
});

check('closeTabChecked: a dirty tab shows the save prompt and the call does NOT wait for it: closed:false, reason prompt', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ title: 'Dirty.md', content: 'x' });
  env.rpc.writeText({ tabId: bg.id, mode: 'append', content: 'y' });
  assert.equal(env.isDirty(bg.id), true);

  const settled = await Promise.race([
    env.rpc.closeTabChecked(bg.id, false),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))
  ]);
  assert.deepEqual(plain(settled), { closed: false, reason: 'prompt' });
  assert.equal(env.el('confirm-modal').classList.contains('hidden'), false, 'the GUI prompt is showing');
  assert.equal(env.tabs().length, 2, 'nothing was closed');

  // the user answering "Don't save" closes it afterwards
  env.el('confirm-modal-dontsave').onclick();
  await env.flush();
  assert.equal(env.tabs().length, 1);
});

check('closeTab (the GUI path) removes the tab it asked about even if other tabs came and went while the prompt was open', async () => {
  const env = await createEnv();
  const a = env.active().id;
  const b = env.newBackground({ title: 'B.md', content: 'b' });
  const c = env.newBackground({ title: 'C.md', content: 'c' });
  env.rpc.writeText({ tabId: b.id, mode: 'append', content: '!' }); // B is dirty

  env.rpc.closeTab(b.id); // the prompt for B opens
  await env.flush();
  assert.equal(env.el('confirm-modal').classList.contains('hidden'), false);
  assert.deepEqual(plain(await env.rpc.closeTabChecked(a, false)), { closed: true }); // A (index 0) goes meanwhile
  env.el('confirm-modal-dontsave').onclick();
  await env.flush();
  assert.deepEqual(env.tabs().map((t) => t.id), [c.id], 'B was removed, not the tab that took its old index');
});

check('closeTabChecked if_saved: the tab text equals the file (line endings ignored) -> closed, no prompt', async () => {
  const env = await createEnv({ files: { 'C:\\n\\a.md': 'line 1\r\nline 2\r\n' } });
  const bg = env.newBackground({ title: 'a.md', path: 'C:\\n\\a.md', content: 'line 1\nline 2\n' });
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: true });
  assert.equal(env.tabs().length, 1);
  assert.equal(env.el('confirm-modal').classList.contains('hidden'), true, 'no prompt was shown');
  assert.deepEqual(env.backendCalls.readFile, ['C:\\n\\a.md']);
});

check('closeTabChecked if_saved: a tab marked dirty but equal to its file is closed (isDirty is not the test), a clean-looking tab that differs is not', async () => {
  const env = await createEnv({ files: { '/n/a.md': 'same', '/n/b.md': 'on disk' } });
  const same = env.newBackground({ path: '/n/a.md', content: 'same' });
  env.rpc.writeText({ tabId: same.id, mode: 'set', content: 'other' });
  env.rpc.writeText({ tabId: same.id, mode: 'set', content: 'same' }); // dirty flag stays set
  assert.equal(env.isDirty(same.id), true);
  assert.deepEqual(plain(await env.rpc.closeTabChecked(same.id, true)), { closed: true });

  const differs = env.newBackground({ path: '/n/b.md', content: 'in the tab' }); // not dirty, but not what the file holds
  assert.equal(env.isDirty(differs.id), false);
  assert.deepEqual(plain(await env.rpc.closeTabChecked(differs.id, true)), { closed: false, reason: 'unsaved' });
  assert.ok(env.tabs().some((t) => t.id === differs.id));
});

check('closeTabChecked if_saved: text that differs from the file -> unsaved and the tab stays, still no prompt', async () => {
  const env = await createEnv({ files: { '/n/a.md': 'on disk' } });
  const bg = env.newBackground({ path: '/n/a.md', content: 'edited' });
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: false, reason: 'unsaved' });
  assert.ok(env.tabs().some((t) => t.id === bg.id));
  assert.equal(env.el('confirm-modal').classList.contains('hidden'), true);
});

check('closeTabChecked if_saved: an edit while the file is being read cancels the close', async () => {
  let env;
  env = await createEnv({
    files: { '/n/a.md': 'same text' },
    onRead: async () => { env.rpc.writeText({ tabId: env.target, mode: 'append', content: ' +typed' }); }
  });
  const bg = env.newBackground({ path: '/n/a.md', content: 'same text' });
  env.target = bg.id;
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: false, reason: 'unsaved' });
  assert.equal(env.rpc.getBuffer(bg.id).content, 'same text +typed', 'the edit is still there');
});

check('closeTabChecked if_saved: an edit during the read cancels the close even if it makes the text equal to the file', async () => {
  let env;
  env = await createEnv({
    files: { '/n/a.md': 'new text' },
    onRead: async () => { env.rpc.writeText({ tabId: env.target, mode: 'set', content: 'new text' }); }
  });
  const bg = env.newBackground({ path: '/n/a.md', content: 'old text' });
  env.target = bg.id;
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: false, reason: 'unsaved' }, 'the text was not what it was when the read began');
  assert.ok(env.tabs().some((t) => t.id === bg.id));
});

check('closeTabChecked if_saved: a tab of the active editor is compared by its live text', async () => {
  const env = await createEnv({ files: { '/n/live.md': 'typed just now' } });
  const only = env.active().id;
  env.type(env.editor, 'typed just now');
  // bind the active tab to the file first (buffer.save does this)
  const prep = plain(env.rpc.prepareSave(only));
  env.rpc.commitSave(only, { path: '/n/live.md', encoding: 'UTF-8', hash: prep.hash, bytes: 14 });
  env.type(env.editor, 'typed just now, more');
  assert.deepEqual(plain(await env.rpc.closeTabChecked(only, true)), { closed: false, reason: 'unsaved' });
  env.type(env.editor, 'typed just now');
  const res = plain(await env.rpc.closeTabChecked(only, true));
  assert.deepEqual(res, { closed: true });
  assert.equal(env.tabs().length, 1, 'closing the last tab leaves a fresh one, as the GUI does');
  assert.notEqual(env.active().id, only);
});

check('closeTabChecked if_saved: a tab without a file is never closed this way, and the reader is not asked', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: 'no file' });
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: false, reason: 'unsaved' });
  assert.equal(env.backendCalls.readFile.length, 0);
});

check('closeTabChecked if_saved: a file that cannot be read cannot show the tab is saved', async () => {
  const env = await createEnv({ files: {} });
  const bg = env.newBackground({ path: '/n/missing.md', content: 'x' });
  assert.deepEqual(plain(await env.rpc.closeTabChecked(bg.id, true)), { closed: false, reason: 'unsaved' });
  assert.ok(env.tabs().some((t) => t.id === bg.id));
});

check('closeTabChecked if_saved: a tab closed by someone else while the file is read is reported as gone', async () => {
  let env;
  env = await createEnv({
    files: { '/n/a.md': 'x' },
    onRead: async () => { env.rpc.closeTab(env.target); }
  });
  const bg = env.newBackground({ path: '/n/a.md', content: 'x' });
  env.target = bg.id;
  const res = plain(await env.rpc.closeTabChecked(bg.id, true));
  assert.deepEqual(res, { closed: false, reason: 'gone' });
});

// ---------------------------------------------------------------------------------------------------
// prepareSave / commitSave (buffer.save)
// ---------------------------------------------------------------------------------------------------
check('prepareSave returns the live text, its hash, and what the tab is bound to', async () => {
  const env = await createEnv();
  env.type(env.editor, '# 見出し\ntext');
  const id = env.active().id;
  const prep = plain(env.rpc.prepareSave());
  assert.deepEqual(prep, { tab_id: id, content: '# 見出し\ntext', hash: nodeHash('# 見出し\ntext'), path: '', encoding: 'UTF-8', title: env.active().title });

  const bg = env.newBackground({ title: 'Bound.md', path: '/n/Bound.md', content: 'bound', encoding: 'Shift_JIS' });
  const prepBg = plain(env.rpc.prepareSave(bg.id));
  assert.equal(prepBg.path, '/n/Bound.md');
  assert.equal(prepBg.encoding, 'Shift_JIS');
  assert.equal(prepBg.content, 'bound');

  const err = await rejection(() => env.rpc.prepareSave('bogus'));
  assert.equal(err.rpcKind, 'not_found');
});

check('commitSave binds the active tab: path, title (both slash styles), encoding, clean, watcher, autosave goes to the new path', async () => {
  const env = await createEnv();
  env.type(env.editor, 'note to save');
  const id = env.active().id;
  const prep = plain(env.rpc.prepareSave(id));
  assert.equal(env.isDirty(id), true);
  env.backendCalls.watch.length = 0;

  const out = plain(env.rpc.commitSave(id, { path: 'C:\\Users\\me\\docs\\saved note.md', encoding: 'Shift_JIS', hash: prep.hash, bytes: 12 }));
  assert.deepEqual(out, { tab_id: id, path: 'C:\\Users\\me\\docs\\saved note.md', title: 'saved note.md' });
  const tab = env.active();
  assert.equal(tab.path, 'C:\\Users\\me\\docs\\saved note.md');
  assert.equal(tab.title, 'saved note.md');
  assert.equal(tab.isModified, false, 'saved is clean');
  assert.equal(plain(env.rpc.prepareSave(id)).encoding, 'Shift_JIS');
  assert.deepEqual(env.backendCalls.watch, ['C:\\Users\\me\\docs\\saved note.md'], 'the file is watched like an opened one');
  assert.equal(env.el('stat-encoding').textContent, 'Shift_JIS');

  // the auto title no longer follows the text, and the autosave now targets the new file
  env.type(env.editor, '# Another heading\nedited');
  assert.equal(env.active().title, 'saved note.md');
  assert.equal(env.heldCount(1500), 1);
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1);
  assert.equal(env.backendCalls.saveFile[0].path, 'C:\\Users\\me\\docs\\saved note.md');
  assert.equal(env.backendCalls.saveFile[0].content, '# Another heading\nedited');
  assert.equal(env.backendCalls.saveFile[0].enc, 'Shift_JIS');
});

check('commitSave of a background tab binds it without watching it and without selecting it; a POSIX path gives the file name', async () => {
  const env = await createEnv();
  const activeId = env.active().id;
  const bg = env.newBackground({ content: 'bg note' });
  const prep = plain(env.rpc.prepareSave(bg.id));
  env.backendCalls.watch.length = 0;
  env.rpc.commitSave(bg.id, { path: '/home/me/notes/bg.md', encoding: 'UTF-8', hash: prep.hash, bytes: 7 });
  const tab = plain(env.rpc.getTabs()).find((t) => t.id === bg.id);
  assert.equal(tab.title, 'bg.md');
  assert.equal(tab.path, '/home/me/notes/bg.md');
  assert.equal(env.active().id, activeId);
  assert.equal(env.backendCalls.watch.length, 0, 'only the active file is watched');
});

check('commitSave is a conflict when the note was edited after prepareSave: nothing is bound and the message says the file has the older text', async () => {
  const env = await createEnv();
  env.type(env.editor, 'text at prepare time');
  const id = env.active().id;
  const prep = plain(env.rpc.prepareSave(id));
  env.type(env.editor, 'text at prepare time, then the user typed');
  env.backendCalls.watch.length = 0;

  const err = await rejection(() => env.rpc.commitSave(id, { path: '/n/x.md', encoding: 'UTF-8', hash: prep.hash, bytes: 1 }));
  assert.equal(err.rpcKind, 'conflict');
  assert.match(err.message, /^\[conflict\] the note was edited while it was being saved \(the file holds the earlier text\)$/);
  const tab = env.active();
  assert.equal(tab.path, '', 'not bound');
  assert.equal(tab.isModified, true, 'still dirty: the unsaved edit is not lost');
  assert.equal(env.backendCalls.watch.length, 0);

  // a write by another RPC client in between conflicts the same way, on a background tab
  const bg = env.newBackground({ content: 'bg' });
  const prepBg = plain(env.rpc.prepareSave(bg.id));
  env.rpc.writeText({ tabId: bg.id, mode: 'append', content: '2' });
  const err2 = await rejection(() => env.rpc.commitSave(bg.id, { path: '/n/y.md', encoding: 'UTF-8', hash: prepBg.hash, bytes: 2 }));
  assert.equal(err2.rpcKind, 'conflict');
  assert.equal(plain(env.rpc.getTabs()).find((t) => t.id === bg.id).path, '');
});

check('commitSave for a tab that was closed meanwhile is not_found and says the file was written', async () => {
  const env = await createEnv();
  const bg = env.newBackground({ content: 'x' });
  const prep = plain(env.rpc.prepareSave(bg.id));
  await env.rpc.closeTabChecked(bg.id, false);
  const err = await rejection(() => env.rpc.commitSave(bg.id, { path: '/n/x.md', encoding: 'UTF-8', hash: prep.hash, bytes: 1 }));
  assert.equal(err.rpcKind, 'not_found');
  assert.match(err.message, /the file was written/);
});

// ---------------------------------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------------------------------
check('wiring: index.html loads note_hash.js before app.js; toggling autosave off also clears the RPC timers; closeTab ends in removeTab', () => {
  const hashTag = indexHtml.indexOf('js/note_hash.js');
  const appTag = indexHtml.indexOf('js/app.js');
  assert.ok(hashTag !== -1 && appTag !== -1 && hashTag < appTag, 'note_hash.js is registered before app.js');
  const toggle = SRC.app.match(/function toggleAutoSave\(\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/rpcAutoSaveTimers\.forEach/.test(toggle) && /rpcAutoSaveTimers\.clear\(\)/.test(toggle));
  const closeTabSrc = SRC.app.match(/async function closeTab\(tabId, e\) \{[\s\S]*?\n  \}/)[0];
  assert.ok(/removeTab\(tabId\);\n  \}$/.test(closeTabSrc), 'closeTab prompts, then removes');
  assert.ok(!/tabs\.splice/.test(closeTabSrc), 'closeTab no longer keeps an index across the prompt');
  const rpcBlock = SRC.app.slice(SRC.app.indexOf('window.__mdMemoRPC = {'));
  assert.ok(/writeText: function \(req\)/.test(rpcBlock) && !/writeText: async/.test(rpcBlock), 'writeText is synchronous');
});

check('without note_hash.js the writes fail loudly instead of skipping the lock', async () => {
  const env = await createEnv({ withoutHash: true });
  env.type(env.editor, 'x');
  const err = await rejection(() => env.rpc.writeText({ mode: 'set', content: 'y', expectedHash: 'abc' }));
  assert.match(err.message, /note_hash\.js/);
  assert.equal(env.editor.value, 'x');
});

// ---------------------------------------------------------------------------------------------------
let failures = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL: ' + name);
    console.error('  ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err));
  }
}
console.log(`\n${queue.length - failures}/${queue.length} rpc write / tab tests passed.`);
process.exit(failures > 0 ? 1 : 0);
