// Notes and files: nothing typed is lost, no dialog answers itself, no file is open twice (UX review, group "notes-data").
//   The real app.js runs in a vm context against a hand-made DOM (textareas, held timers, window key listeners with a capture
//   phase) and a mocked backend. Covered:
//     B01  the Save / Don't save / Cancel dialog: one dialog, one outcome; no key listener is left behind; Ctrl / Alt / Cmd
//          combinations, IME keys and held keys are not answers; Enter presses the focused button
//     B02  the scrap-appended notifications (CLI pipe, Quick Capture, hot folder, Discord, scraps search): a tab is the tab of a
//          PATH (never of a file name), and a tab with unsaved text is never overwritten or marked saved
//     B07  text typed while a save is in flight keeps the tab unsaved; saves of one note are written one at a time
//     B08  a file that is open is not opened twice (Ctrl+O, RPC newTab / openTab, ...); Save As over an open file
//     B27  a start-up file is one more tab after the session is restored; a failing start-up file says so
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const SRC = {
  i18n: read('frontend/js/i18n.js'),
  noteTitle: read('frontend/js/note_title.js'),
  noteHash: read('frontend/js/note_hash.js'),
  firstRun: read('frontend/js/first_run.js'),
  app: read('frontend/js/app.js')
};
const I18N = vm.runInNewContext(SRC.i18n + '\n;I18N');
const tr = (lang, key, vars) => String(I18N[lang][key]).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m));

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));

async function flush() {
  for (let i = 0; i < 24; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A promise the test settles by hand (a slow disk, a dialog the person has not answered yet).
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const HIDDEN = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane'];

// opts: files {path: text} answered by readFileByPath, localStorage {key: value}, backend {fn: impl} overrides, config (the local
// config object), platform.
async function createEnv(opts = {}) {
  const elements = new Map();
  const windowListeners = {};
  const backendCalls = { saveFile: [], saveFileAs: [], readFile: [], saveSession: [], scanFolder: [], closeWindow: 0, getSession: 0, getStartupFile: 0 };
  let documentMock = null;
  const messages = [];

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
  // A key press at the window: the capture-phase listeners first (a stopPropagation ends it), then the ordinary ones.
  function pressAtWindow(init) {
    const e = makeEvent('keydown', Object.assign({ target: documentMock.activeElement || documentMock.body }, init));
    const run = (capture) => {
      (windowListeners.keydown || []).filter((l) => l.capture === capture).slice().forEach((l) => l.fn(e));
      return e.propagationStopped;
    };
    if (run(true)) return e;
    run(false);
    return e;
  }

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
      set textContent(v) { textContent = v; innerHTML = v; if (id === 'stat-message' && v) messages.push(v); },
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
      hasAttribute: (name) => name in attrs,
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
    execCommand: () => false,
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const files = new Map(Object.entries(opts.files || {}));
  const backend = Object.assign({
    getConfig: async () => '',
    saveConfig: async () => {},
    getSession: async () => { backendCalls.getSession++; return null; },
    saveSession: async (json) => { backendCalls.saveSession.push(json); },
    getStartupFile: async () => { backendCalls.getStartupFile++; return null; },
    trimMemory: async () => {},
    saveFile: async (p, content, enc) => { backendCalls.saveFile.push({ path: p, content, enc }); return { path: p, success: true }; },
    saveFileAs: async (content, enc, name) => { backendCalls.saveFileAs.push({ content, enc, name }); return null; },
    watchActiveFile: () => {},
    unwatchActiveFile: () => {},
    closeWindow: () => { backendCalls.closeWindow++; },
    scanFolderFiles: async (folder) => { backendCalls.scanFolder.push(folder); return []; },
    readFileByPath: async (p) => {
      backendCalls.readFile.push(p);
      if (!files.has(p)) throw new Error('not found: ' + p);
      return { path: p, content: files.get(p), encoding: 'UTF-8' };
    }
  }, opts.backend || {});

  // Timers of 100 ms or more (autosave 1500, session save 500, the workspace scan 300, toast clearing) are held until the test fires them.
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

  // A clock the test can move: the Save dialog ignores a plain d / n / s / Enter for its first 400 ms (CONFIRM_KEY_GRACE_MS), so a
  // test that answers it by key lets that time pass first (env.advanceClock). Everything else about Date is the real one.
  let clockSkew = 0;
  class ClockedDate extends Date {
    static now() { return super.now() + clockSkew; }
  }

  const store = new Map(Object.entries(opts.localStorage || {}));
  const windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
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
    setInterval: () => 1, clearInterval: () => {}, Date: ClockedDate,
    Event: class { constructor(type, init) { Object.assign(this, { type, defaultPrevented: false }, init || {}); } },
    console: { log() {}, warn() {}, error(...a) { if (opts.showErrors) console.error(...a); } }
  };
  vm.createContext(context);
  for (const code of [SRC.i18n, SRC.noteTitle, SRC.noteHash, SRC.firstRun, SRC.app]) {
    vm.runInContext(code, context);
    await flush();
  }

  const el = (id) => documentMock.getElementById(id);
  const rpc = windowMock.__mdMemoRPC;
  const env = {
    window: windowMock, rpc, backend, backendCalls, el, documentMock, files, flush, store, messages,
    editor: el('editor'),
    testHelper: windowMock.__testHelper,
    config: windowMock.__testHelper.config,
    heldCount: (ms) => Array.from(heldTimers.values()).filter((t) => t.ms === ms).length,
    fireTimers(ms) {
      for (const [id, t] of Array.from(heldTimers)) if (t.ms === ms) { heldTimers.delete(id); t.fn(); }
    },
    press: pressAtWindow,
    advanceClock: (ms) => { clockSkew += ms; },
    keydownListeners: (capture) => (windowListeners.keydown || []).filter((l) => l.capture === capture).length,
    // what a person typing does: the value changes and the editor's input event fires
    type(text) {
      env.editor.value = text;
      env.editor.selectionStart = env.editor.selectionEnd = text.length;
      dispatchOn(env.editor, 'input', {});
    },
    tabs: () => plain(rpc.getTabs()),
    active: () => plain(rpc.getTabs()).find((t) => t.isActive),
    tab: (id) => plain(rpc.getTabs()).find((t) => t.id === id),
    modalOpen: () => !el('confirm-modal').classList.contains('hidden'),
    lastMessage: () => messages[messages.length - 1] || ''
  };
  return env;
}

// A note with a file, shown in the editor (the first, empty note stays as the tab before it).
function openNote(env, spec) {
  const res = env.rpc.openTab(spec);
  return res.id;
}

// ---------------------------------------------------------------------------------------------------
// B01: the Save / Don't save / Cancel dialog
// ---------------------------------------------------------------------------------------------------
async function dirtyTwoTabs() {
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: 'C:\\d\\a.md', content: 'alpha\n' });
  const b = openNote(env, { title: 'b.md', path: 'C:\\d\\b.md', content: 'beta\n' });
  env.rpc.switchTab(a);
  env.type('alpha\nx'); // a.md is dirty (its autosave timer is held)
  assert.equal(env.tab(a).isModified, true);
  return { env, a, b };
}

const CTRL_W = { key: 'w', code: 'KeyW', ctrlKey: true };

check('B01: a second Ctrl+W while the dialog is open leaves no listener behind; after Cancel plain d / n / s / Enter are ordinary keys', async () => {
  const { env, a } = await dirtyTwoTabs();
  const before = env.keydownListeners(true);
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.modalOpen(), true, 'the dialog is up');
  env.press(CTRL_W); // a repeated Ctrl+W (or the key repeating)
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.keydownListeners(true), before + 1, 'still exactly one dialog key listener');

  env.el('confirm-modal-cancel').onclick();
  await env.flush();
  assert.equal(env.modalOpen(), false, 'Cancel closes it');
  assert.equal(env.keydownListeners(true), before, 'and nothing of the dialog is left on the window');
  const ids = env.tabs().map((t) => t.id);
  assert.ok(ids.includes(a), 'the dirty tab is still there');

  for (const key of ['d', 'n', 's', 'D', 'Enter']) {
    const e = env.press({ key });
    assert.equal(e.defaultPrevented, false, `${key} is not swallowed any more`);
    await env.flush();
  }
  assert.deepEqual(env.tabs().map((t) => t.id), ids, 'no key closed a tab');
  assert.equal(env.tab(a).isModified, true, 'and the unsaved text is still unsaved');
  assert.equal(env.backendCalls.saveFile.length, 0, 'nothing was saved by a stray key');
});

check('B01: closeTab called twice for the same tab asks once and does one thing', async () => {
  const { env, a } = await dirtyTwoTabs();
  const before = env.keydownListeners(true);
  const first = env.rpc.closeTab(a);
  const second = env.rpc.closeTab(a);
  await env.flush();
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(env.modalOpen(), true);
  env.el('confirm-modal-dontsave').onclick();
  await env.flush();
  assert.equal(env.modalOpen(), false);
  assert.ok(!env.tabs().some((t) => t.id === a), "Don't save closed the tab once");
  assert.equal(env.keydownListeners(true), before, 'and no key listener of the dialog is left on the window');
});

check('B01: Ctrl / Alt / Cmd combinations do not answer the dialog; plain d does (Don\'t save)', async () => {
  const { env, a } = await dirtyTwoTabs();
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.modalOpen(), true);
  const ids = env.tabs().map((t) => t.id);
  for (const combo of [
    { key: 'd', ctrlKey: true }, { key: 'D', ctrlKey: true, shiftKey: true }, { key: 'd', altKey: true },
    { key: 's', altKey: true }, { key: 'n', altKey: true }, { key: 'Enter', ctrlKey: true }
  ]) {
    env.press(combo);
    await env.flush();
    assert.equal(env.modalOpen(), true, `${JSON.stringify(combo)} does not answer the dialog`);
  }
  assert.ok(env.tabs().some((t) => t.id === a), 'the tab is still open');
  assert.deepEqual(env.tabs().map((t) => t.id).filter((id) => ids.includes(id)), ids, 'no tab was closed');
  assert.equal(env.backendCalls.saveFile.length, 0);

  env.advanceClock(500); // the first moments are over (see the grace test below)
  const e = env.press({ key: 'd' });
  await env.flush();
  assert.equal(e.defaultPrevented, true, 'a plain d is the dialog\'s Don\'t save key');
  assert.equal(env.modalOpen(), false);
  assert.ok(!env.tabs().some((t) => t.id === a), "Don't save closed it");
});

check('B01: an IME key, a held key and Escape', async () => {
  const { env, a } = await dirtyTwoTabs();
  const before = env.keydownListeners(true);
  env.press(CTRL_W);
  await env.flush();
  env.press({ key: 'd', isComposing: true });
  env.press({ key: 'n', keyCode: 229 });
  env.press({ key: 's', repeat: true });
  env.press({ key: 'Enter', repeat: true });
  await env.flush();
  assert.equal(env.modalOpen(), true, 'an IME key and a key held down are not answers');
  assert.equal(env.backendCalls.saveFile.length, 0);
  env.press({ key: 'Escape' });
  await env.flush();
  assert.equal(env.modalOpen(), false, 'Escape cancels');
  assert.ok(env.tabs().some((t) => t.id === a));
  assert.equal(env.keydownListeners(true), before, 'the dialog took its key listener off again');
});

check('B01: Enter presses the button that has the focus (Save by default, Cancel and Don\'t save when focused)', async () => {
  // Cancel focused: Enter cancels
  let { env, a } = await dirtyTwoTabs();
  env.press(CTRL_W);
  await env.flush();
  env.advanceClock(500);
  env.el('confirm-modal-cancel').focus();
  env.press({ key: 'Enter' });
  await env.flush();
  assert.equal(env.modalOpen(), false);
  assert.ok(env.tabs().some((t) => t.id === a), 'Enter on Cancel kept the tab');
  assert.equal(env.backendCalls.saveFile.length, 0, 'and saved nothing');

  // Don't save focused: Enter discards
  env.press(CTRL_W);
  await env.flush();
  env.advanceClock(500);
  env.el('confirm-modal-dontsave').focus();
  env.press({ key: 'Enter' });
  await env.flush();
  assert.ok(!env.tabs().some((t) => t.id === a), "Enter on Don't save closed the tab");

  // Save focused (the default): Enter saves, then the tab closes
  ({ env, a } = await dirtyTwoTabs());
  env.press(CTRL_W);
  await env.flush();
  env.advanceClock(500);
  env.el('confirm-modal-save').focus();
  env.press({ key: 'Enter' });
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1, 'Enter on Save saved');
  assert.equal(env.backendCalls.saveFile[0].content, 'alpha\nx');
  assert.ok(!env.tabs().some((t) => t.id === a), 'and the tab closed');
});

check('B01: the sole-tab Ctrl+W path is single-flight too (a stray d after Cancel must not close the window)', async () => {
  const env = await createEnv();
  env.type('only note, typed');
  assert.equal(env.tabs().length, 1);
  env.press(CTRL_W);
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.modalOpen(), true);
  env.el('confirm-modal-cancel').onclick();
  await env.flush();
  env.press({ key: 'd' });
  env.press({ key: 'Enter' });
  await env.flush();
  assert.equal(env.backendCalls.closeWindow, 0, 'the window was not closed');
  assert.equal(env.tabs().length, 1);
});

check('B01: a dialog whose modal was hidden behind its back is released by the next request (no stuck modal, one key listener)', async () => {
  const { env, a } = await dirtyTwoTabs();
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.modalOpen(), true);
  const before = env.keydownListeners(true); // the base listeners plus the open dialog's
  env.el('confirm-modal').classList.add('hidden'); // hidden by something else
  env.press(CTRL_W); // asks again
  await env.flush();
  assert.equal(env.modalOpen(), true, 'a new dialog opens');
  assert.equal(env.keydownListeners(true), before, 'the stale owner let go of its listener; exactly one dialog listener');
  env.el('confirm-modal-cancel').onclick();
  await env.flush();
  assert.equal(env.keydownListeners(true), before - 1);
  assert.ok(env.tabs().some((t) => t.id === a));
});

// The two dialogs that share the confirm modal (the Save / Don't save / Cancel dialog and customConfirm, used by the agent safety
// prompts and the shortcut overwrite question): their source is run on its own here, because customConfirm is not reachable from
// outside app.js without going through the whole Settings or agent flow.
function dialogSandbox() {
  const start = SRC.app.indexOf('let confirmModalRelease = null;');
  const end = SRC.app.indexOf('// --- Non-Intrusive Tab-Based IME Guardian');
  assert.ok(start > 0 && end > start, 'the dialog source was found');
  const source = SRC.app.slice(start, end);
  const listeners = [];
  const hidden = new Set(['confirm-modal']);
  const mk = (id) => ({ id, textContent: '', style: {}, onclick: null, focus() { sb.document.activeElement = this; }, classList: {
    add: (c) => { if (id === 'confirm-modal' && c === 'hidden') hidden.add(id); },
    remove: (c) => { if (id === 'confirm-modal' && c === 'hidden') hidden.delete(id); },
    contains: (c) => id === 'confirm-modal' && c === 'hidden' && hidden.has(id)
  } });
  const els = {};
  for (const id of ['modal', 'message', 'save', 'dontsave', 'ok', 'cancel', 'close']) els[id] = mk(id === 'modal' ? 'confirm-modal' : id);
  let now = 1000000;
  const sb = {
    confirmModal: els.modal, confirmModalMessage: els.message, confirmModalSave: els.save, confirmModalDontSave: els.dontsave,
    confirmModalOk: els.ok, confirmModalCancel: els.cancel, confirmModalClose: els.close,
    t: (k) => k, setTimeout: (fn) => { fn(); return 1; },
    Date: { now: () => now },
    document: { activeElement: null },
    window: {
      addEventListener: (type, fn, cap) => { if (type === 'keydown') listeners.push({ fn, cap }); },
      removeEventListener: (type, fn, cap) => {
        const i = listeners.findIndex((l) => l.fn === fn && l.cap === cap);
        if (type === 'keydown' && i >= 0) listeners.splice(i, 1);
      }
    }
  };
  vm.createContext(sb);
  vm.runInContext(source + '\n;this.confirmSaveDialog = confirmSaveDialog; this.customConfirm = customConfirm;', sb);
  const press = (init) => {
    const e = { key: '', ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, preventDefault() {}, stopPropagation() {}, ...init };
    listeners.slice().forEach((l) => l.fn(e));
  };
  return { sb, els, listeners, press, advance: (ms) => { now += ms; }, isOpen: () => !hidden.has('confirm-modal') };
}

check('B01: customConfirm and the Save dialog cannot stack on the shared modal (the second request is declined)', async () => {
  const d = dialogSandbox();
  const first = d.sb.customConfirm('Run it?', { okLabel: 'Run', safeDefault: true });
  const second = d.sb.customConfirm('And this?');
  const third = d.sb.confirmSaveDialog('note.md');
  assert.equal(await second, false, 'a second customConfirm is declined');
  assert.equal(await third, 'cancel', 'and so is a Save dialog request');
  assert.equal(d.listeners.length, 1, 'only the first dialog has a key listener');
  assert.equal(d.isOpen(), true);
  d.els.ok.onclick();
  assert.equal(await first, true, 'the first dialog is still answerable');
  assert.equal(d.listeners.length, 0);
  assert.equal(d.isOpen(), false);

  // the other way round
  const save = d.sb.confirmSaveDialog('note.md');
  const confirm = d.sb.customConfirm('Overwrite?');
  assert.equal(await confirm, false);
  assert.equal(d.listeners.length, 1);
  d.press({ key: 'd', ctrlKey: true });
  assert.equal(d.isOpen(), true, 'Ctrl+D is not an answer');
  d.els.dontsave.onclick();
  assert.equal(await save, 'dontsave');
  assert.equal(d.listeners.length, 0);

  // a settled dialog ignores a late second answer (no double resolve, no error)
  const again = d.sb.confirmSaveDialog('note.md');
  d.advance(500);
  d.press({ key: 's' });
  d.els.dontsave.onclick && d.els.dontsave.onclick();
  assert.equal(await again, 'save');
});

// ---------------------------------------------------------------------------------------------------
// B07: a save in flight
// ---------------------------------------------------------------------------------------------------
check('B07: text typed while a save is in flight keeps the tab unsaved and is saved next', async () => {
  const slow = [];
  const env = await createEnv({
    backend: {
      saveFile: (p, content) => { const g = gate(); slow.push({ path: p, content, g }); return g.promise.then(() => ({ path: p, success: true })); }
    }
  });
  const id = openNote(env, { title: 'a.md', path: 'C:\\Users\\demo\\notes\\a.md', content: 'base\n' });
  env.type('base\nOne');
  env.fireTimers(1500); // the autosave starts
  assert.equal(slow.length, 1);
  assert.equal(slow[0].content, 'base\nOne');

  env.type('base\nOneTwo'); // typed while the write is in flight
  slow[0].g.resolve();
  await env.flush();
  assert.equal(env.tab(id).isModified, true, 'Two was never written: the tab is still unsaved');

  // closing it asks, instead of silently dropping "Two"
  env.rpc.closeTab(id);
  await env.flush();
  assert.equal(env.modalOpen(), true, 'the close asks');
  env.el('confirm-modal-cancel').onclick();
  await env.flush();

  env.fireTimers(1500); // the autosave scheduled by the second edit
  assert.equal(slow.length, 2, 'a second write follows');
  assert.equal(slow[1].content, 'base\nOneTwo');
  slow[1].g.resolve();
  await env.flush();
  assert.equal(env.tab(id).isModified, false, 'now everything is on disk');
  env.fireTimers(1500); // any timer still pending finds nothing new to write
  await env.flush();
  assert.equal(slow.length, 2, 'no redundant third write');
});

check('B07: an autosave that waited for a slow write does not write a tab that was closed with "Don\'t save" meanwhile', async () => {
  const slow = [];
  const env = await createEnv({
    backend: {
      saveFile: (p, content) => { const g = gate(); slow.push({ content, g }); return g.promise.then(() => ({ path: p, success: true })); }
    }
  });
  const id = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'base\n' });
  env.type('base\nOne');
  env.fireTimers(1500);
  env.type('base\nOneTwo');
  env.fireTimers(1500); // waits behind the first write
  env.rpc.closeTab(id);
  await env.flush();
  env.el('confirm-modal-dontsave').onclick();
  await env.flush();
  assert.ok(!env.tabs().some((t) => t.id === id), 'the tab is gone');
  slow[0].g.resolve();
  await env.flush();
  assert.equal(slow.length, 1, 'the discarded text was not written after all');
});

check('B07: an unchanged text is marked saved (the ordinary case still works)', async () => {
  const env = await createEnv();
  const id = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'base\n' });
  env.type('base\nedit');
  assert.equal(env.tab(id).isModified, true);
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1);
  assert.equal(env.tab(id).isModified, false);
});

check('B07: saves of one note are written one at a time, oldest first (an autosave firing during a slow write waits)', async () => {
  const slow = [];
  const env = await createEnv({
    backend: {
      saveFile: (p, content) => { const g = gate(); slow.push({ content, g }); return g.promise.then(() => ({ path: p, success: true })); }
    }
  });
  const id = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'base\n' });
  env.type('base\nOne');
  env.fireTimers(1500);
  assert.equal(slow.length, 1);
  env.type('base\nOneTwo');
  env.fireTimers(1500); // the second autosave fires while the first write has not finished
  await env.flush();
  assert.equal(slow.length, 1, 'the second write does not start before the first one is done');
  slow[0].g.resolve();
  await env.flush();
  assert.equal(slow.length, 2, 'then it does');
  assert.deepEqual(slow.map((s) => s.content), ['base\nOne', 'base\nOneTwo'], 'the newer text is written last');
  slow[1].g.resolve();
  await env.flush();
  assert.equal(env.tab(id).isModified, false);
});

check('B07: a failed write leaves the tab unsaved and the next save still runs', async () => {
  let fail = true;
  const env = await createEnv({
    backend: {
      saveFile: async (p, content) => { env.backendCalls.saveFile.push({ path: p, content }); if (fail) throw new Error('disk full'); return { path: p, success: true }; }
    }
  });
  const id = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'base\n' });
  env.type('base\nedit');
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.tab(id).isModified, true, 'still unsaved after the failure');
  assert.match(env.messages.join('\n'), /disk full/);
  fail = false;
  env.type('base\nedit2');
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 2, 'the queue is not stuck after a failure');
  assert.equal(env.tab(id).isModified, false);
});

check('B07: Save As: text typed while the dialog is open keeps the tab unsaved, and autosave then picks it up', async () => {
  const dialog = gate();
  const env = await createEnv({ backend: { saveFileAs: (content) => { env.backendCalls.saveFileAs.push({ content }); return dialog.promise; } } });
  env.type('draft one');
  const id = env.active().id;
  env.press({ key: 's', code: 'KeyS', ctrlKey: true }); // an unsaved note: Save As
  await env.flush();
  assert.equal(env.backendCalls.saveFileAs.length, 1);
  env.type('draft one two'); // typed while the dialog is open
  dialog.resolve({ path: 'C:\\n\\draft.md', title: 'draft.md', success: true });
  await env.flush();
  assert.equal(env.tab(id).path, 'C:\\n\\draft.md');
  assert.equal(env.tab(id).isModified, true, 'the text typed during the dialog is not in the file');
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1, 'autosave writes it');
  assert.equal(env.backendCalls.saveFile[0].content, 'draft one two');
  assert.equal(env.tab(id).isModified, false);
});

// ---------------------------------------------------------------------------------------------------
// B08: a file is never open in two tabs
// ---------------------------------------------------------------------------------------------------
check('B08: Ctrl+O on a file that is already open brings its tab forward instead of opening a second one', async () => {
  const P = 'C:\\Users\\demo\\notes\\a.md';
  const env = await createEnv({
    backend: { openFile: async () => ({ path: P, title: 'a.md', content: '# A\n\noriginal\n', encoding: 'UTF-8' }) }
  });
  const a = openNote(env, { title: 'a.md', path: P, content: '# A\n\noriginal\n' });
  const b = openNote(env, { title: 'b.md', path: 'C:\\Users\\demo\\notes\\b.md', content: 'b\n' });
  assert.equal(env.active().id, b);
  const before = env.tabs().length;

  env.press({ key: 'o', code: 'KeyO', ctrlKey: true });
  await env.flush();
  assert.equal(env.tabs().length, before, 'no second tab');
  assert.equal(env.active().id, a, 'the open tab is the one shown');
  assert.equal(env.tabs().filter((t) => t.path === P).length, 1);
  assert.equal(env.lastMessage(), tr('en', 'tabAlreadyOpen', { title: 'a.md' }));

  // the stale-copy overwrite of the review: every save comes from the one tab
  env.type('# A\n\noriginal\nEDIT');
  env.press({ key: 's', code: 'KeyS', ctrlKey: true });
  await env.flush();
  const writes = env.backendCalls.saveFile.filter((c) => c.path === P);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, '# A\n\noriginal\nEDIT');
});

check('B08: the same file spelled differently (slashes, drive letter case) is the same file', async () => {
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: 'C:\\Users\\demo\\notes\\a.md', content: 'A\n' });
  const before = env.tabs().length;
  const again = env.testHelper.createTab('a.md', 'A\n', 'c:/users/demo/notes/a.md');
  assert.equal(again.id, a, 'createTab hands back the existing tab');
  assert.equal(env.tabs().length, before);
  assert.equal(env.active().id, a);
  // a different file, a different folder with the same name, is another note
  env.testHelper.createTab('a.md', 'A2\n', 'C:\\Users\\demo\\other\\a.md');
  assert.equal(env.tabs().length, before + 1);
});

check('B08: the open request of a running instance (RPC newTab) and openTab do not duplicate; a background request does not switch', async () => {
  const P = 'C:\\n\\a.md';
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: P, content: 'A\n' });
  const other = openNote(env, { title: 'b.md', path: 'C:\\n\\b.md', content: 'B\n' });
  const before = env.tabs().length;
  env.rpc.newTab('a.md', 'A\n', P); // the same text: nothing to load
  assert.equal(env.tabs().length, before);
  assert.equal(env.active().id, a, 'newTab shows the tab that has the file');
  assert.equal(env.lastMessage(), tr('en', 'tabAlreadyOpen', { title: 'a.md' }));

  env.rpc.switchTab(other);
  const res = plain(env.rpc.openTab({ path: P, title: 'a.md', content: 'x', background: true }));
  assert.equal(res.existing, true);
  assert.equal(env.active().id, other, 'a background open does not take the screen');
  assert.equal(env.tabs().length, before);
});

check('B08: opening a file that is already open in a clean tab loads the newer text from disk, so a later save cannot write the old text over it', async () => {
  const P = 'C:\n\a.md';
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: P, content: 'A\n' });
  const other = openNote(env, { title: 'b.md', path: 'C:\n\b.md', content: 'B\n' });
  assert.equal(env.active().id, other);
  const before = env.tabs().length;

  // the file changed on disk (a Git pull, another editor): the running instance is asked to open it (md-memo a.md, a drop, Ctrl+O)
  env.rpc.newTab('a.md', 'A changed on disk\n', P);
  assert.equal(env.tabs().length, before, 'no second tab');
  assert.equal(env.active().id, a, 'the tab is shown');
  assert.equal(env.window.__mdMemoRPC.getBuffer(a).content, 'A changed on disk\n', 'with the text that is on disk now');
  assert.equal(env.editor.value, 'A changed on disk\n', 'in the editor too');
  assert.equal(env.tab(a).isModified, false, 'it is still a clean tab');
  assert.equal(env.lastMessage(), tr('en', 'tabAlreadyOpenReloaded', { title: 'a.md' }));

  // a later edit and save carry the newer text, not the old one
  env.type('A changed on disk\nplus mine');
  env.press({ key: 's', code: 'KeyS', ctrlKey: true });
  await env.flush();
  const writes = env.backendCalls.saveFile.filter((c) => c.path === P);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, 'A changed on disk\nplus mine');

  // the other entrance, RPC tab.new with a path (background: the tab is refreshed and nothing is brought forward)
  env.rpc.switchTab(other);
  const res = plain(env.rpc.openTab({ path: P, content: 'A changed again\n', background: true }));
  assert.equal(res.existing, true);
  assert.equal(env.active().id, other, 'a background open does not take the screen');
  assert.equal(env.window.__mdMemoRPC.getBuffer(a).content, 'A changed again\n', 'a tab that is not on screen is refreshed');
});

check('B08: opening a file that is already open in a tab with unsaved text keeps that text and says so', async () => {
  const P = 'C:\n\a.md';
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: P, content: 'A\n' });
  env.rpc.switchTab(a);
  env.type('A\nMY UNSAVED EDIT');
  assert.equal(env.tab(a).isModified, true);
  const other = openNote(env, { title: 'b.md', path: 'C:\n\b.md', content: 'B\n' });
  assert.equal(env.active().id, other);

  env.rpc.newTab('a.md', 'A changed on disk\n', P);
  assert.equal(env.active().id, a);
  assert.equal(env.window.__mdMemoRPC.getBuffer(a).content, 'A\nMY UNSAVED EDIT', 'what was typed is not replaced');
  assert.equal(env.tab(a).isModified, true);
  assert.equal(env.lastMessage(), tr('en', 'tabAlreadyOpenUnsaved', { title: 'a.md' }));

  // typed into again while the tab is on screen: the live editor text is what is kept
  env.type('A\nMY UNSAVED EDIT, more');
  env.rpc.newTab('a.md', 'A changed on disk\n', P);
  assert.equal(env.editor.value, 'A\nMY UNSAVED EDIT, more');
});

check('B08: Save As onto a file another tab has open: a tab without unsaved text is closed, one with unsaved text keeps it as a note without a file', async () => {
  const P = 'C:\\n\\shared.md';
  // clean twin: closed
  let env = await createEnv({ backend: { saveFileAs: async () => ({ path: P, title: 'shared.md', success: true }) } });
  const twin = openNote(env, { title: 'shared.md', path: P, content: 'old\n' });
  env.rpc.switchTab(env.tabs()[0].id);
  env.type('new text');
  const saving = env.active().id;
  env.press({ key: 's', code: 'KeyS', ctrlKey: true });
  await env.flush();
  assert.equal(env.tab(saving).path, P);
  assert.ok(!env.tabs().some((t) => t.id === twin), 'the clean twin was closed');
  assert.equal(env.tabs().filter((t) => t.path === P).length, 1);
  assert.equal(env.lastMessage(), tr('en', 'saveSuccess') + 'shared.md');

  // dirty twin: kept, detached from the file
  env = await createEnv({ backend: { saveFileAs: async () => ({ path: P, title: 'shared.md', success: true }) } });
  const twin2 = openNote(env, { title: 'shared.md', path: P, content: 'old\n' });
  env.type('old\nMY UNSAVED EDIT');
  assert.equal(env.tab(twin2).isModified, true);
  env.rpc.switchTab(env.tabs()[0].id);
  env.type('other note');
  const saving2 = env.active().id;
  env.press({ key: 's', code: 'KeyS', ctrlKey: true });
  await env.flush();
  assert.equal(env.tab(saving2).path, P);
  const kept = env.tab(twin2);
  assert.ok(kept, 'the dirty twin is still there');
  assert.equal(kept.path, '', 'but it no longer owns the file');
  assert.equal(kept.isModified, true);
  assert.equal(env.window.__mdMemoRPC.getBuffer(twin2).content, 'old\nMY UNSAVED EDIT', 'with its text');
  assert.equal(env.tabs().filter((t) => t.path === P).length, 1);
  assert.equal(env.lastMessage(), tr('en', 'saveAsOtherTabKept', { title: 'shared.md' }));
});

check('B08: buffer.save (commitSave) onto a file another tab has open releases that file from the other tab too', async () => {
  const P = 'C:\\n\\shared.md';
  const env = await createEnv();
  const twin = openNote(env, { title: 'shared.md', path: P, content: 'old\n' });
  const bg = plain(env.rpc.openTab({ title: 'Draft', content: 'draft text', background: true }));
  const prep = plain(env.rpc.prepareSave(bg.id));
  env.rpc.commitSave(bg.id, { path: P, encoding: 'UTF-8', hash: prep.hash });
  assert.equal(env.tabs().filter((t) => t.path === P).length, 1);
  assert.equal(env.tab(bg.id).path, P);
  assert.ok(!env.tabs().some((t) => t.id === twin), 'the clean twin is gone');
});

// ---------------------------------------------------------------------------------------------------
// B02: scrap-appended notifications
// ---------------------------------------------------------------------------------------------------
const SCRAP = 'C:/Users/demo/Documents/md-memo/scraps/2026-09-30.md';

check('B02: a scrap tab with unsaved typing is not overwritten by an append notification (CLI pipe / Quick Capture / hot folder)', async () => {
  const env = await createEnv({ files: { [SCRAP]: '# scrap\n\nline A\n' } });
  env.config.general.autoSave = false;
  const id = openNote(env, { title: '2026-09-30.md', path: SCRAP, content: '# scrap\n\nline A\n' });
  env.type('# scrap\n\nline A\ntyped by user');
  assert.equal(env.tab(id).isModified, true);
  env.files.set(SCRAP, '# scrap\n\nline A\nappended by CLI pipe\n'); // the append reached the disk

  await env.window.onScrapAppended({ filePath: SCRAP, fileName: '2026-09-30.md', command: 'pipe' });
  await env.flush();
  assert.equal(env.window.__mdMemoRPC.getBuffer(id).content, '# scrap\n\nline A\ntyped by user', 'the typed text is still the tab text');
  assert.equal(env.editor.value, '# scrap\n\nline A\ntyped by user');
  assert.equal(env.tab(id).isModified, true, 'and it is still unsaved (it was not "saved" by a refresh)');
  assert.equal(env.lastMessage(), tr('en', 'scrapKeptUnsavedEdits'));
});

check('B02: a clean scrap tab is refreshed from the file', async () => {
  const env = await createEnv({ files: { [SCRAP]: '# scrap\n\nline A\n' } });
  const id = openNote(env, { title: '2026-09-30.md', path: SCRAP, content: '# scrap\n\nline A\n' });
  env.files.set(SCRAP, '# scrap\n\nline A\nappended by CLI pipe\n');
  await env.window.onScrapAppended({ filePath: SCRAP, fileName: '2026-09-30.md', command: 'pipe' });
  await env.flush();
  assert.equal(env.active().id, id, 'the scrap tab is shown');
  assert.equal(env.editor.value, '# scrap\n\nline A\nappended by CLI pipe\n');
  assert.equal(env.window.__mdMemoRPC.getBuffer(id).content, '# scrap\n\nline A\nappended by CLI pipe\n');
  assert.equal(env.tab(id).isModified, false);
});

check('B02: a clean tab whose file has CRLF line endings is refreshed (the textarea holds LF, the tab holds the file text: not "unsaved")', async () => {
  const env = await createEnv({ files: { [SCRAP]: 'a\r\nb\r\nc\r\n' } });
  const tab = env.testHelper.createTab('2026-09-30.md', 'a\r\nb\r\n', SCRAP);
  env.editor.value = 'a\nb\n'; // what a real textarea holds for that text
  await env.window.onScrapAppended({ filePath: SCRAP, fileName: '2026-09-30.md', command: 'pipe' });
  await env.flush();
  assert.equal(env.editor.value, 'a\r\nb\r\nc\r\n', 'the new file text is shown');
  assert.equal(env.tab(tab.id).isModified, false);
  assert.notEqual(env.lastMessage(), tr('en', 'scrapKeptUnsavedEdits'));
});

check('B02: text typed while the scrap file is being read is kept (the check is repeated after the read)', async () => {
  const read = gate();
  const env = await createEnv({
    backend: { readFileByPath: async () => { await read.promise; return { path: SCRAP, content: 'DISK TEXT\n', encoding: 'UTF-8' }; } }
  });
  env.config.general.autoSave = false;
  const id = openNote(env, { title: '2026-09-30.md', path: SCRAP, content: 'line A\n' });
  const pending = env.window.onScrapAppended({ filePath: SCRAP, fileName: '2026-09-30.md', command: 'pipe' });
  await env.flush();
  env.type('line A\ntyped during the read');
  read.resolve();
  await pending;
  await env.flush();
  assert.equal(env.editor.value, 'line A\ntyped during the read');
  assert.equal(env.tab(id).isModified, true);
});

check('B02: a note with the same NAME in another folder is another note (append notification)', async () => {
  const OTHER = 'D:/projects/x/2026-09-30.md';
  const env = await createEnv({ files: { [SCRAP]: 'SCRAP CONTENT\n' } });
  const id = openNote(env, { title: '2026-09-30.md', path: OTHER, content: 'project notes\n' });
  env.type('project notes\nmy edit');
  await env.window.onScrapAppended({ filePath: SCRAP, fileName: '2026-09-30.md', command: 'pipe' });
  await env.flush();
  assert.equal(env.window.__mdMemoRPC.getBuffer(id).content, 'project notes\nmy edit', 'the project note is untouched');
  assert.equal(env.tab(id).isModified, true);
  const scrapTab = env.tabs().find((t) => t.path === SCRAP);
  assert.ok(scrapTab, 'the scrap opened as its own tab');
  assert.notEqual(scrapTab.id, id);

  // saving the project note writes the project note to the project path
  env.rpc.switchTab(id);
  env.press({ key: 's', code: 'KeyS', ctrlKey: true });
  await env.flush();
  const writes = env.backendCalls.saveFile;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, OTHER);
  assert.equal(writes[0].content, 'project notes\nmy edit');
});

check('B02: the Discord bridge notification follows the same rules (path only; unsaved text kept; no tab switch)', async () => {
  const OTHER = 'D:/projects/x/2026-09-30.md';
  const env = await createEnv({ files: { [SCRAP]: 'disk after Discord\n' } });
  env.config.general.autoSave = false;
  const scrapTab = openNote(env, { title: '2026-09-30.md', path: SCRAP, content: 'before\n' });
  const otherTab = openNote(env, { title: '2026-09-30.md', path: OTHER, content: 'project\n' });
  assert.equal(env.active().id, otherTab);

  // clean scrap tab: refreshed in the background, the active tab does not change
  await env.window.onDiscordBridgeMessage({ filePath: SCRAP, fileName: '2026-09-30.md' });
  await env.flush();
  assert.equal(env.window.__mdMemoRPC.getBuffer(scrapTab).content, 'disk after Discord\n');
  assert.equal(env.window.__mdMemoRPC.getBuffer(otherTab).content, 'project\n', 'the same-named note in another folder is not touched');
  assert.equal(env.active().id, otherTab, 'no focus stealing');
  assert.equal(env.lastMessage(), tr('en', 'discordBridgeMessageToast'));

  // now the scrap tab has unsaved typing
  env.rpc.switchTab(scrapTab);
  env.type('disk after Discord\nmine');
  env.files.set(SCRAP, 'disk after Discord\nsecond message\n');
  await env.window.onDiscordBridgeMessage({ filePath: SCRAP, fileName: '2026-09-30.md' });
  await env.flush();
  assert.equal(env.editor.value, 'disk after Discord\nmine');
  assert.equal(env.tab(scrapTab).isModified, true);
  assert.equal(env.lastMessage(), tr('en', 'scrapKeptUnsavedEdits'));
});

check('B02: the scraps search jumps to the tab of the result\'s path, not to a note with the same name', async () => {
  const OTHER = 'D:/projects/x/2026-09-30.md';
  const env = await createEnv({
    files: { [SCRAP]: 'line 1\nline 2\n' },
    backend: { searchScraps: async () => [{ filePath: SCRAP, fileName: '2026-09-30.md', matches: [{ lineNumber: 2, lineText: 'line 2', snippet: 'line 2' }] }] }
  });
  const otherTab = openNote(env, { title: '2026-09-30.md', path: OTHER, content: 'project\n' });
  env.el('scraps-search-input').value = 'line';
  env.el('scraps-search-input').dispatchEvent({ type: 'input' });
  env.fireTimers(150);
  await env.flush();
  env.el('scraps-search-input').dispatchEvent({ type: 'keydown', key: 'Enter' });
  await env.flush();
  const shown = env.active();
  assert.notEqual(shown.id, otherTab, 'the project note with the same name is not the jump target');
  assert.equal(shown.path, SCRAP);
  assert.equal(env.editor.value, 'line 1\nline 2\n');
});

// ---------------------------------------------------------------------------------------------------
// B27: a start-up file
// ---------------------------------------------------------------------------------------------------
const OPENED = { path: 'C:/Users/demo/Documents/notes/opened.md', title: 'opened.md', content: '# Opened from Explorer\nhello', encoding: 'UTF-8' };
const SESSION = (tabs, extra) => JSON.stringify(Object.assign({
  activeTabId: tabs[0].id, tabCounter: tabs.length + 1, isSplitMode: false,
  tabs: tabs.map((t) => Object.assign({ path: '', isDirty: false, encoding: 'UTF-8', isAutoTitle: false, cursorPos: 0 }, t))
}, extra || {}));

check('B27: a start-up file opens as one more tab; the backend session, the workspace and the update check still happen', async () => {
  const session = SESSION([
    { id: 'tab_s1', title: 'scratch.md', content: '# scratch\nunsaved', isDirty: true },
    { id: 'tab_s2', title: 'huge.md', content: 'Line 1\nLine 2\n' }
  ]);
  const withFile = await createEnv({
    localStorage: { md_memo_workspace_folder: 'C:\\Users\\demo\\notes' },
    backend: {
      getStartupFile: async () => OPENED,
      getSession: async () => session
    }
  });
  const without = await createEnv({
    localStorage: { md_memo_workspace_folder: 'C:\\Users\\demo\\notes' },
    backend: { getSession: async () => session }
  });

  assert.deepEqual(withFile.tabs().map((t) => t.title), ['scratch.md', 'huge.md', 'opened.md'], 'the restored tabs stay, the file is added');
  assert.deepEqual(without.tabs().map((t) => t.title), ['scratch.md', 'huge.md']);
  assert.equal(withFile.active().title, 'opened.md', 'and it is the one shown');
  assert.equal(withFile.editor.value, OPENED.content);
  assert.equal(withFile.tabs().find((t) => t.title === 'scratch.md').isModified, true, 'unsaved restored text is still unsaved');

  withFile.fireTimers(300);
  without.fireTimers(300);
  await withFile.flush();
  assert.deepEqual(withFile.backendCalls.scanFolder, ['C:\\Users\\demo\\notes'], 'the saved workspace folder is loaded');
  assert.deepEqual(without.backendCalls.scanFolder, ['C:\\Users\\demo\\notes']);
  assert.equal(withFile.heldCount(2500), without.heldCount(2500), 'the update check timer is set exactly as in a start without a file');
  assert.ok(without.heldCount(2500) >= 1);

  // the session written afterwards holds every note, not just the start-up file
  withFile.fireTimers(500);
  await withFile.flush();
  const last = JSON.parse(withFile.backendCalls.saveSession[withFile.backendCalls.saveSession.length - 1]);
  assert.deepEqual(last.tabs.map((t) => t.title), ['scratch.md', 'huge.md', 'opened.md']);
});

check('B27: a restored untitled note that starts with "# " is not treated as an empty note and replaced', async () => {
  const session = SESSION([{ id: 'tab_m1', title: 'Meeting.md', content: '# Meeting notes\nthings I wrote\n', isAutoTitle: true }]);
  const env = await createEnv({ backend: { getStartupFile: async () => OPENED, getSession: async () => session } });
  assert.deepEqual(env.tabs().map((t) => t.title), ['Meeting.md', 'opened.md']);
  assert.equal(env.window.__mdMemoRPC.getBuffer('tab_m1').content, '# Meeting notes\nthings I wrote\n');
});

check('B27: the empty first note gives way to the start-up file, and the file text is what the editor holds (no content loss)', async () => {
  const env = await createEnv({ backend: { getStartupFile: async () => OPENED } });
  assert.deepEqual(env.tabs().map((t) => t.title), ['opened.md'], 'the empty placeholder note is gone');
  assert.equal(env.editor.value, OPENED.content, 'the editor shows the file, not the old placeholder text');
  assert.equal(env.active().path, OPENED.path);

  env.type(OPENED.content + '!');
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1);
  assert.equal(env.backendCalls.saveFile[0].path, OPENED.path);
  assert.equal(env.backendCalls.saveFile[0].content, OPENED.content + '!', 'what is saved is the file text plus the edit');
});

check('B27: a start-up file that is already in the restored session is not opened twice', async () => {
  const session = SESSION([
    { id: 'tab_o', title: 'opened.md', path: OPENED.path, content: '# Opened from Explorer\nhello' },
    { id: 'tab_x', title: 'x.md', content: 'x' }
  ], { activeTabId: 'tab_x' });
  const env = await createEnv({ backend: { getStartupFile: async () => OPENED, getSession: async () => session } });
  assert.deepEqual(env.tabs().map((t) => t.id), ['tab_o', 'tab_x']);
  assert.equal(env.active().id, 'tab_o', 'the open tab is brought forward');
});

check('B27: the local (localStorage) session is kept too when a start-up file is given', async () => {
  const local = SESSION([{ id: 'tab_l1', title: 'local.md', content: 'from localStorage' }]);
  const env = await createEnv({
    localStorage: { md_memo_session_v1: local },
    backend: { getStartupFile: async () => OPENED }
  });
  assert.deepEqual(env.tabs().map((t) => t.title), ['local.md', 'opened.md']);
});

check('B27: a start-up file that cannot be read says so (naming the file) and the rest of the start is normal', async () => {
  const goErr = '起動ファイルの読み込みに失敗しました: open C:\\Users\\demo\\Documents\\notes\\opened.md: Access is denied.';
  const session = SESSION([{ id: 'tab_s1', title: 'scratch.md', content: 'kept' }]);
  const env = await createEnv({
    backend: {
      getStartupFile: async () => { throw new Error(goErr); },
      getSession: async () => session
    }
  });
  assert.deepEqual(env.tabs().map((t) => t.title), ['scratch.md'], 'the session is restored');
  const shown = env.messages.find((m) => m.startsWith(tr('en', 'startupFileFailed', { err: '' })));
  assert.ok(shown, 'a status message was shown: ' + JSON.stringify(env.messages));
  assert.ok(shown.includes('opened.md') && shown.includes('Access is denied.'), 'it names the file and the reason');

  // the Japanese UI says it in Japanese
  const ja = await createEnv({
    localStorage: { md_memo_config_v1: JSON.stringify({ general: { language: 'ja' } }) },
    backend: { getStartupFile: async () => { throw new Error('locked'); } }
  });
  const jaShown = ja.messages.find((m) => m.startsWith(tr('ja', 'startupFileFailed', { err: '' })));
  assert.ok(jaShown && jaShown.includes('locked'), 'Japanese message: ' + JSON.stringify(ja.messages));
});

check('B27: a first launch with a start-up file still gets no Welcome note over it', async () => {
  const env = await createEnv({ backend: { getStartupFile: async () => OPENED, getConfig: async () => '' } });
  assert.deepEqual(env.tabs().map((t) => t.title), ['opened.md']);
});

// ---------------------------------------------------------------------------------------------------
// Closing, autosave and the session file (exploratory sessions C2 / C11: C2-08, C2-11, C11-02, C11-06, C11-07, C11-08, C11-13)
// ---------------------------------------------------------------------------------------------------
check('C11-02: a plain d / n / s / Enter typed in the first moments of the Save dialog is swallowed, not an answer; clicks and Esc work at once', async () => {
  const { env, a } = await dirtyTwoTabs();
  // opened by something other than a keystroke of the person (an agent's tab.close while they type)
  assert.equal(env.rpc.closeTab(a), true);
  await env.flush();
  assert.equal(env.modalOpen(), true);
  for (const key of ['d', 'n', 's', 'D', 'Enter']) {
    const e = env.press({ key });
    assert.equal(e.defaultPrevented, true, `${key} is swallowed (so it cannot press the focused button either)`);
  }
  await env.flush();
  assert.equal(env.modalOpen(), true, 'the dialog is still asking');
  assert.equal(env.backendCalls.saveFile.length, 0, 'nothing was saved by a typed letter');
  assert.ok(env.tabs().some((t) => t.id === a), 'and no tab was closed');

  env.advanceClock(300); // still inside the 400 ms
  env.press({ key: 'd' });
  await env.flush();
  assert.equal(env.modalOpen(), true, 'still not an answer');

  env.advanceClock(300); // past it: the key is an answer again
  env.press({ key: 'd' });
  await env.flush();
  assert.equal(env.modalOpen(), false);
  assert.ok(!env.tabs().some((t) => t.id === a), "d is Don't save once the dialog could have been read");

  // Esc and the buttons answer at once
  const second = await dirtyTwoTabs();
  second.env.press(CTRL_W);
  await second.env.flush();
  second.env.press({ key: 'Escape' });
  assert.equal(second.env.modalOpen(), false, 'Esc cancels at once');
  second.env.press(CTRL_W);
  await second.env.flush();
  second.env.el('confirm-modal-dontsave').onclick();
  await second.env.flush();
  assert.ok(!second.env.tabs().some((t) => t.id === second.a), "a click on Don't save answers at once");
});

check('C11-08: the sole tab, Ctrl+W, "Don\'t save": the discarded text is not left in the session, and the window closes after the session was written', async () => {
  const order = [];
  const env = await createEnv({
    backend: {
      saveSession: async (json) => { order.push({ kind: 'session', json }); },
      closeWindow: () => { order.push({ kind: 'close' }); }
    }
  });
  env.type('only note, typed and then thrown away');
  env.press(CTRL_W);
  await env.flush();
  assert.equal(env.modalOpen(), true);
  env.el('confirm-modal-dontsave').onclick();
  await env.flush();

  const closeAt = order.findIndex((o) => o.kind === 'close');
  assert.ok(closeAt >= 0, 'the window was closed');
  const before = order.slice(0, closeAt).filter((o) => o.kind === 'session');
  assert.ok(before.length >= 1, 'the session was written before the window went');
  assert.ok(!before[before.length - 1].json.includes('thrown away'), 'and what it holds is not the discarded text');
  assert.ok(!(env.store.get('md_memo_session_v1') || '').includes('thrown away'), 'the page\'s own copy neither');
  assert.ok(!env.editor.value.includes('thrown away'), 'a hidden window comes back to a fresh note');
  assert.equal(env.tabs().length, 1);
});

check('C11-08: the sole tab, Ctrl+W, "Save" keeps its text and closes the window; Cancel does neither', async () => {
  const env = await createEnv();
  const id = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'A\n' });
  env.rpc.closeTab(env.tabs().find((t) => t.id !== id).id); // only the file note is left
  assert.equal(env.tabs().length, 1);
  env.type('A\nedit');
  env.press(CTRL_W);
  await env.flush();
  env.el('confirm-modal-cancel').onclick();
  await env.flush();
  assert.equal(env.backendCalls.closeWindow, 0, 'Cancel does not close the window');
  assert.equal(env.tab(id).isModified, true, 'and the text is still there');

  env.press(CTRL_W);
  await env.flush();
  env.el('confirm-modal-save').onclick();
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1);
  assert.equal(env.backendCalls.saveFile[0].content, 'A\nedit');
  assert.equal(env.backendCalls.closeWindow, 1, 'saved, then the window closes');
  assert.equal(env.tab(id).path, 'C:\\n\\a.md', 'the note itself is not discarded');
});

const BAD_SESSION = JSON.stringify({
  activeTabId: 5,
  tabCounter: 'seven',
  tabs: [
    null,
    { id: 'tab_ok', title: 'ok.md', path: '', content: 'kept text', isDirty: true, encoding: 'UTF-8', cursorPos: 4, diskSig: 'sig1', eol: 'crlf' },
    'a string', 7, [],
    { id: 'tab_nocontent', title: 'nocontent.md' },
    { id: 'tab_ok', title: 'dup.md', content: 'second tab with a repeated id', isDirty: true },
    { title: 'noid.md', content: 'no id', cursorPos: 'x', encoding: 3, path: 9, isDirty: 'yes', diskSig: 12, eol: null },
    { id: 5, title: 'numeric id', content: 'n' }
  ]
});

for (const via of ['localStorage', 'session.json']) {
  check(`C11-06: malformed elements of a saved session (${via}) are dropped or repaired and the rest is restored`, async () => {
    const env = await createEnv(via === 'localStorage' ? { localStorage: { md_memo_session_v1: BAD_SESSION } } : { backend: { getSession: async () => BAD_SESSION } });
    const tabs = env.tabs();
    assert.deepEqual(tabs.map((t) => t.title), ['ok.md', 'nocontent.md', 'dup.md', 'noid.md', 'numeric id'], 'only the objects are tabs');
    const ids = tabs.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'every tab has its own id (the repeated and the missing one got new ones)');
    assert.equal(ids[0], 'tab_ok');
    assert.equal(ids[4], '5');
    assert.equal(env.active().title, 'numeric id', 'a numeric activeTabId finds the tab with that id');
    assert.equal(env.editor.value, 'n');

    const text = (i) => env.window.__mdMemoRPC.getBuffer(ids[i]).content;
    assert.equal(text(0), 'kept text');
    assert.equal(text(1), '', 'a tab without content is an empty note, not the text "undefined"');
    assert.equal(text(2), 'second tab with a repeated id', 'the second tab with the same id keeps its own text');
    assert.equal(text(3), 'no id');
    assert.deepEqual(tabs.map((t) => t.isModified), [true, false, true, false, false], 'only a literal true is an unsaved note');
    assert.equal(tabs[3].path, '', 'a path that is not a string is no path');

    // what is written back is clean too
    env.fireTimers(500);
    await env.flush();
    const saved = env.backendCalls.saveSession[env.backendCalls.saveSession.length - 1];
    assert.ok(saved && !saved.includes('undefined'), 'the next session write has no "undefined" in it');
    const back = JSON.parse(saved);
    assert.equal(back.tabs.length, 5);
    assert.ok(back.tabs.every((t) => typeof t.id === 'string' && typeof t.content === 'string' && typeof t.title === 'string'));
  });
}

check('C11-06: a session whose tabs are all malformed starts a fresh, usable note (no dead window)', async () => {
  const env = await createEnv({ localStorage: { md_memo_session_v1: JSON.stringify({ tabs: [null, 'x', 3, []] }) } });
  assert.equal(env.tabs().length, 1);
  env.type('works');
  assert.equal(env.window.__mdMemoRPC.getBuffer(env.active().id).content, 'works');
});

check('C2-11: a session.json that cannot be read is said so (the file itself is kept by the Go side); no message when nothing was lost', async () => {
  const whole = SESSION([{ id: 'tab_1', title: 'idea.md', content: 'my idea', isDirty: true }]);
  const cut = whole.slice(0, Math.floor(whole.length / 2)); // what a crash in the middle of a write leaves
  const said = tr('en', 'sessionUnreadable');

  const lost = await createEnv({ backend: { getSession: async () => cut } });
  assert.ok(lost.messages.includes(said), 'the person is told: ' + JSON.stringify(lost.messages));
  assert.equal(lost.tabs().length, 1, 'a fresh note starts');

  // the page's own copy brought everything back: nothing is missing, nothing is said
  const rescued = await createEnv({ localStorage: { md_memo_session_v1: whole }, backend: { getSession: async () => cut } });
  assert.deepEqual(rescued.tabs().map((t) => t.title), ['idea.md']);
  assert.ok(!rescued.messages.includes(said));

  for (const [name, getSession] of [['no session yet', async () => null], ['an empty answer', async () => ''], ['a fine session', async () => whole],
    ['a call that fails', async () => { throw new Error('boom'); }]]) {
    const env = await createEnv({ backend: { getSession } });
    assert.ok(!env.messages.includes(said), `${name}: nothing to report`);
  }

  const ja = await createEnv({ localStorage: { md_memo_config_v1: JSON.stringify({ general: { language: 'ja' } }) }, backend: { getSession: async () => cut } });
  assert.ok(ja.messages.includes(tr('ja', 'sessionUnreadable')), 'the Japanese UI says it in Japanese: ' + JSON.stringify(ja.messages));
});

check('C2-08: typing in another tab within 1.5 s does not cancel the pending autosave of the first (one timer per tab)', async () => {
  const env = await createEnv();
  const a = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'A\n' });
  const b = openNote(env, { title: 'b.md', path: 'C:\\n\\b.md', content: 'B\n' });
  env.rpc.switchTab(a);
  env.type('A\nedit a');
  env.rpc.switchTab(b); // before the 1.5 s are over
  env.type('B\nedit b');
  env.fireTimers(1500);
  await env.flush();
  const written = Object.fromEntries(env.backendCalls.saveFile.map((c) => [c.path, c.content]));
  assert.deepEqual(written, { 'C:\\n\\a.md': 'A\nedit a', 'C:\\n\\b.md': 'B\nedit b' }, 'both notes were written');
  assert.equal(env.tab(a).isModified, false);
  assert.equal(env.tab(b).isModified, false);
});

check('C2-08: switching autosave on picks up every dirty note with a file, not only the one on screen; a restored dirty note is not re-armed by the restore', async () => {
  const env = await createEnv();
  env.config.general.autoSave = false;
  const a = openNote(env, { title: 'a.md', path: 'C:\\n\\a.md', content: 'A\n' });
  const b = openNote(env, { title: 'b.md', path: 'C:\\n\\b.md', content: 'B\n' });
  const c = openNote(env, { title: 'c.md', path: 'C:\\n\\c.md', content: 'C\n' });
  env.rpc.switchTab(a);
  env.type('A\nedit a');
  env.rpc.switchTab(b);
  env.type('B\nedit b');
  env.rpc.switchTab(c); // c is shown and clean
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 0, 'autosave is off: nothing is written');

  env.el('stat-autosave').onclick(); // the status-bar switch: on
  env.fireTimers(1500);
  await env.flush();
  const written = env.backendCalls.saveFile.map((cl) => cl.path).sort();
  assert.deepEqual(written, ['C:\\n\\a.md', 'C:\\n\\b.md'], 'the two edited notes were picked up although neither is on screen');

  // a dirty note that comes back from the last session is not saved just because the app started (the file may have changed meanwhile)
  const restored = await createEnv({
    localStorage: { md_memo_session_v1: SESSION([{ id: 'tab_r', title: 'r.md', path: 'C:\\n\\r.md', content: 'unsaved from last time', isDirty: true }]) }
  });
  assert.equal(restored.heldCount(1500), 0, 'no autosave timer after a restore');
  restored.fireTimers(1500);
  await restored.flush();
  assert.equal(restored.backendCalls.saveFile.length, 0);
});

check('C11-13: an autosave that comes due while the close prompt is open does not write the text "Don\'t save" is about to discard', async () => {
  const { env, a } = await dirtyTwoTabs(); // a.md is dirty, its autosave is pending
  env.rpc.closeTab(a);
  env.rpc.closeTab(a); // a second request for the same note is declined and must not lift the mark of the first
  await env.flush();
  assert.equal(env.modalOpen(), true);
  env.fireTimers(1500); // the person is still reading the question
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 0, 'nothing was written while the question is open');

  env.el('confirm-modal-dontsave').onclick();
  await env.flush();
  assert.ok(!env.tabs().some((t) => t.id === a), 'the tab is gone');
  env.fireTimers(1500);
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 0, "and the file never got the discarded text");
});

check('C11-13: after Cancel the skipped autosave runs again; "Save" in the prompt still writes', async () => {
  const { env, a } = await dirtyTwoTabs();
  env.rpc.closeTab(a);
  await env.flush();
  env.fireTimers(1500); // due while the question is up: skipped
  env.el('confirm-modal-cancel').onclick();
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 0);
  assert.equal(env.tab(a).isModified, true);
  env.fireTimers(1500); // the note is still unsaved: its autosave was started again
  await env.flush();
  assert.equal(env.backendCalls.saveFile.length, 1, 'the cancelled close does not leave the note without its autosave');
  assert.equal(env.backendCalls.saveFile[0].content, 'alpha\nx');
  assert.equal(env.tab(a).isModified, false);

  const second = await dirtyTwoTabs();
  second.env.rpc.closeTab(second.a);
  await second.env.flush();
  second.env.el('confirm-modal-save').onclick();
  await second.env.flush();
  assert.equal(second.env.backendCalls.saveFile.length, 1, 'the prompt\'s own Save is not blocked by the mark');
  assert.ok(!second.env.tabs().some((t) => t.id === second.a), 'and the tab closed');
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
    console.error('  ' + (err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n  ') : err));
  }
}
console.log(`\n${queue.length - failures}/${queue.length} notes-data integrity tests passed.`);
process.exit(failures > 0 ? 1 : 0);
