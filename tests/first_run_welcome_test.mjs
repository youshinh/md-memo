// The first-run experience (docs/design/first-run.md; UX review A1 and A2), with the real app.js and first_run.js run against a
// hand-made DOM:
//   - a fresh install (no config.json, no session, no workspace folder) opens one editable Welcome note, once, in the UI language;
//   - nobody else sees it: an existing config, a saved session (local or backend), a remembered folder, a start-up file, a typed-in
//     first note, a backend that cannot tell - and a page without first_run.js behaves exactly as before;
//   - the flag is written as a minimal config.json, and a second start neither shows the note nor duplicates it;
//   - the ask bar's one-time model choice (Set up a local model / Use a cloud key / Later) appears with the untouched default
//     model, leads to Settings > AI Models with the right part in view, and is remembered in general.aiChoiceMade.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appCode = read('frontend/js/app.js');
const i18nCode = read('frontend/js/i18n.js');
const indexHtml = read('frontend/index.html');
const styleCss = read('frontend/css/style.css');
const chromeLayoutCode = read('frontend/js/chrome_layout.js');
const mermaidToneCode = read('frontend/js/mermaid_tone.js');
const llmErrorCode = read('frontend/js/llm_error.js');
const firstRunCode = read('frontend/js/first_run.js');

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));

const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane', 'inline-prompt-setup', 'inline-prompt-choice', 'inline-prompt-error', 'pane-model'];

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
}

// opts: localStorage {key: value}, backendConfig (object | '' for "no config.json"), backendSession (string | null), startupFile,
// language 'ja', firstRun (false = the page does not load first_run.js), backend {overrides}
async function createEnv(opts = {}) {
  const elements = new Map();
  const listeners = { keydown: [] };
  const messages = [];
  const scrolled = [];
  const store = new Map(Object.entries(opts.localStorage || {}));
  let documentMock = null;

  function mockElement(id, tagName = 'div') {
    const classes = new Set(HIDDEN_AT_START.includes(id) ? ['hidden'] : []);
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
      set textContent(v) {
        textContent = v;
        innerHTML = v;
        if (id === 'stat-message' && v) messages.push(v);
      },
      addEventListener: (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
      removeEventListener: () => {},
      focus: () => { documentMock.activeElement = el; },
      blur: () => {},
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e) => { el.selectionStart = s; el.selectionEnd = e; },
      scrollIntoView: (o) => { scrolled.push({ id, options: o }); },
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
    execCommand: (cmd, _, text) => {
      if (cmd !== 'insertText') return false;
      const ed = elements.get('editor');
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      ed.value = ed.value.substring(0, start) + text + ed.value.substring(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const llmCalls = [];
  const saved = [];
  const sessionsSaved = [];
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async (json) => { saved.push(JSON.parse(json)); },
    getSession: async () => (opts.backendSession === undefined ? null : opts.backendSession),
    saveSession: async (json) => { sessionsSaved.push(json); },
    getStartupFile: async () => opts.startupFile || null,
    trimMemory: async () => {},
    queryLLMAsync: (reqId, prompt, cfgJson) => { llmCalls.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); }
  }, opts.backend || {});
  if (opts.noGetConfig) delete backend.getConfig;

  const longTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 10000) {
      longTimers.set(id, fn);
      return id;
    }
    fn();
    return id;
  };

  const windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    backend,
    navigator: opts.platform === 'mac'
      ? { platform: 'MacIntel', userAgent: 'Macintosh', language: opts.language === 'ja' ? 'ja-JP' : 'en-US' }
      : { platform: 'Win32', userAgent: 'Windows', language: opts.language === 'ja' ? 'ja-JP' : 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: { addTask: (o) => o, updateTask: () => {} }
  };
  documentMock.defaultView = windowMock;

  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(chromeLayoutCode, context);
  vm.runInContext(mermaidToneCode, context);
  vm.runInContext(llmErrorCode, context);
  if (opts.firstRun !== false) vm.runInContext(firstRunCode, context);
  vm.runInContext(appCode, context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  const env = {
    window: windowMock, elements, messages, llmCalls, saved, sessionsSaved, store, scrolled, el,
    bridge: windowMock.MdMemoBridge,
    config: windowMock.__testHelper.config,
    editor: el('editor'),
    tab: () => windowMock.MdMemoBridge.getActiveTab(),
    key(init) {
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    ctrl(letter, extra) {
      return env.key(Object.assign({ key: letter, code: 'Key' + letter.toUpperCase(), ctrlKey: true }, extra));
    },
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, start, end) {
      env.editor.value = text;
      env.editor.selectionStart = start === undefined ? text.length : start;
      env.editor.selectionEnd = end === undefined ? env.editor.selectionStart : end;
      env.window.document.activeElement = env.editor;
    },
    focused: () => env.window.document.activeElement,
    flush
  };
  return env;
}

const DATE_HEADER = /^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n$/;
const EXISTING_CONFIG = { general: { language: 'en' } };
const SESSION = {
  activeTabId: 't1', tabCounter: 2, isSplitMode: false, secondaryTabId: null, secondaryViewMode: 'editor', activePane: 'primary', isPreviewMode: false,
  tabs: [{ id: 't1', title: 'mine.md', path: '', content: 'my own words', isDirty: false, encoding: 'UTF-8', cursorPos: 12 }]
};

// ---------------------------------------------------------------------------------------------------
// A1: the Welcome note
// ---------------------------------------------------------------------------------------------------
check('a fresh install opens one editable Welcome note, at the top, and writes only the flag and the toolbar layout in effect', async () => {
  const env = await createEnv();
  const tab = env.tab();
  assert.equal(tab.title, 'Welcome');
  assert.equal(tab.isAutoTitle, false, 'the title stays "Welcome" while the person edits');
  assert.equal(tab.isDirty, false, 'closing it untouched asks nothing');
  assert.equal(tab.path, '');
  assert.ok(tab.content.startsWith('# Welcome to MD-Memo'), 'the note itself');
  assert.equal(env.editor.value, tab.content, 'and it is what the editor shows');
  assert.equal(env.editor.selectionStart, 0, 'read from the top');
  assert.equal(env.editor.selectionEnd, 0);
  for (const shown of ['`Ctrl+L`', '`Ctrl+Shift+P`', '`Ctrl+,`', '`Ctrl+Shift+F`']) assert.ok(tab.content.includes(shown), shown + ' is in the note');
  assert.ok(tab.content.includes('`~/Documents/md-memo/scraps`'), 'where daily notes are stored');
  assert.equal(env.config.general.welcomeShown, true, 'remembered in memory');
  assert.equal(env.saved.length, 1, 'one write');
  assert.deepEqual(Object.keys(env.saved[0]), ['general'], 'only the general section');
  assert.deepEqual(Object.keys(env.saved[0].general).sort(), ['toolbarLayout', 'welcomeShown'], 'the flag, and the toolbar layout in effect - no other default (language, IME, model) is frozen');
  assert.equal(env.saved[0].general.welcomeShown, true);
  assert.deepEqual(plain(env.saved[0].general.toolbarLayout), plain(env.window.ChromeLayout.calmToolbarLayout()), 'the calm first-start toolbar is written down, not lost');
  assert.equal(env.store.has('md_notepad_config_v3'), false, 'no settings copy is left in browser storage (that would read as a used profile)');
  assert.equal(env.bridge.getActiveTab().id, tab.id);
});

check('the Welcome note follows the UI language', async () => {
  const env = await createEnv({ language: 'ja' });
  assert.equal(env.config.general.language, 'ja');
  assert.equal(env.tab().title, 'ようこそ');
  assert.ok(env.tab().content.startsWith('# MD-Memo へようこそ'));
  assert.ok(env.tab().content.includes('`Ctrl+L`'));
});

check('the Welcome note names the shortcuts of this machine (Cmd on a Mac)', async () => {
  const env = await createEnv({ platform: 'mac' });
  assert.equal(env.tab().title, 'Welcome');
  for (const shown of ['`Cmd+L`', '`Cmd+Shift+P`', '`Cmd+,`', '`Cmd+Shift+F`', '`Cmd+P`', '`Cmd+S`']) assert.ok(env.tab().content.includes(shown), shown);
  assert.ok(!env.tab().content.includes('Ctrl+'), 'no Windows key names on a Mac');
});

check('an existing user (config.json exists) never sees it, and nothing is written', async () => {
  const env = await createEnv({ backendConfig: EXISTING_CONFIG });
  assert.notEqual(env.tab().title, 'Welcome');
  assert.ok(DATE_HEADER.test(env.editor.value), 'the usual new note: the date heading');
  assert.deepEqual(plain(env.saved), [], 'no config write');
  assert.equal(env.config.general.welcomeShown, false, 'the default: not shown');
});

check('a settings copy in localStorage means the app was used: no Welcome, even if config.json cannot be found', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { language: 'en' } }) } });
  assert.ok(DATE_HEADER.test(env.editor.value));
  assert.deepEqual(plain(env.saved), []);
});

check('a saved session (localStorage or the backend file) is restored as it was, without a Welcome note', async () => {
  const local = await createEnv({ localStorage: { md_memo_session_v1: JSON.stringify(SESSION) } });
  assert.equal(local.tab().content, 'my own words');
  assert.equal(local.editor.value, 'my own words');
  assert.deepEqual(plain(local.saved), []);

  const remote = await createEnv({ backendSession: JSON.stringify(SESSION) });
  assert.equal(remote.tab().content, 'my own words', 'restored from the backend session.json');
  assert.deepEqual(plain(remote.saved), []);
});

check('a remembered workspace folder means it is not the first start', async () => {
  const env = await createEnv({ localStorage: { md_memo_workspace_folder: 'C:\\Users\\me\\notes' }, backend: { scanFolderFiles: async () => [] } });
  assert.ok(DATE_HEADER.test(env.editor.value));
  assert.deepEqual(plain(env.saved), []);
});

check('a file handed over by the OS (double click, Open with) is not covered by a Welcome note', async () => {
  const env = await createEnv({ startupFile: { path: 'C:\\Users\\me\\todo.md', title: 'todo.md', content: '- [ ] one\n', encoding: 'UTF-8' } });
  assert.notEqual(env.tab().title, 'Welcome');
  assert.equal(env.tab().path, 'C:\\Users\\me\\todo.md', 'the file is the note on screen');
  assert.deepEqual(plain(env.saved), []);
});

check('a first note the person already typed into is never replaced', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await createEnv({ backend: { getConfig: async () => { await gate; return ''; } } });
  assert.ok(DATE_HEADER.test(env.editor.value), 'until the backend answers it is the usual empty note');
  env.editor.value += 'a thought I had already started writing';
  release();
  await env.flush();
  assert.ok(env.editor.value.includes('a thought I had already started'), 'kept');
  assert.notEqual(env.tab().title, 'Welcome');
  assert.deepEqual(plain(env.saved), [], 'and not marked as shown');
});

check('a second note opened before the backend answered also stops it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await createEnv({ backend: { getConfig: async () => { await gate; return ''; } } });
  env.bridge.getActiveTab(); // the first note exists
  env.window.__testHelper.createTab();
  release();
  await env.flush();
  assert.equal(env.window.MdMemoBridge.getActiveTab().title === 'Welcome', false);
  assert.deepEqual(plain(env.saved), []);
});

check('a backend that cannot tell (no getConfig, or it fails) shows nothing', async () => {
  const none = await createEnv({ noGetConfig: true });
  assert.ok(DATE_HEADER.test(none.editor.value));
  assert.deepEqual(plain(none.saved), []);

  const failing = await createEnv({ backend: { getConfig: async () => { throw new Error('disk error'); } } });
  assert.ok(DATE_HEADER.test(failing.editor.value));
  assert.deepEqual(plain(failing.saved), [], 'and the unreadable-config guard is not bypassed');
});

check('a page without first_run.js behaves exactly as before (an empty note with the date heading, no write)', async () => {
  const env = await createEnv({ firstRun: false });
  assert.ok(DATE_HEADER.test(env.editor.value));
  assert.deepEqual(plain(env.saved), []);
});

check('the second start: the flag is on disk, so nothing is shown or written again, and the Welcome tab is not duplicated', async () => {
  const first = await createEnv();
  const flag = first.saved[0];
  assert.equal(flag.general.welcomeShown, true);
  await first.flush();
  const session = first.sessionsSaved[first.sessionsSaved.length - 1];
  assert.ok(session && session.includes('Welcome'), 'the session holds the tab like any unsaved note');

  // Restart with what the first run left behind.
  const second = await createEnv({ backendConfig: flag, backendSession: session, localStorage: Object.fromEntries(first.store) });
  assert.deepEqual(plain(second.saved), [], 'nothing is written on the second start');
  assert.equal(second.config.general.welcomeShown, true);
  // The calm toolbar of a new profile must survive the config file that now exists (it would read "no layout = show everything").
  assert.deepEqual(plain(second.config.general.toolbarLayout), plain(second.window.ChromeLayout.calmToolbarLayout()), 'the toolbar does not change on the second start');
  assert.ok(second.config.general.toolbarLayout.hidden.length > 0, 'and it is the calm one, not "show everything"');
  assert.equal(second.tab().title, 'Welcome', 'the note is still there, restored like any unsaved note');
  const after = JSON.parse(second.sessionsSaved[second.sessionsSaved.length - 1]);
  assert.equal(after.tabs.length, 1, 'one tab, not two');
  assert.equal(after.tabs[0].title, 'Welcome');

  // Closed in between: the next start has no Welcome at all, and the flag alone keeps it away.
  const closed = await createEnv({ backendConfig: flag, backendSession: JSON.stringify(SESSION) });
  assert.equal(closed.tab().content, 'my own words');
  assert.deepEqual(plain(closed.saved), []);
});

check('even with the flag lost, a config file on disk keeps the note away (no config.json is the one hard condition)', async () => {
  const env = await createEnv({ backendConfig: { general: {} } });
  assert.ok(DATE_HEADER.test(env.editor.value));
  assert.deepEqual(plain(env.saved), []);
});

// ---------------------------------------------------------------------------------------------------
// A2: the one-time model choice in the ask bar
// ---------------------------------------------------------------------------------------------------
async function withNote(opts) {
  const env = await createEnv(opts);
  env.setNote('hello world', 0, 5);
  return env;
}
const DEFAULT_MODEL_CONFIG = { general: { language: 'en' } }; // an existing user whose text model is still the built-in default

check('Ctrl+L with the untouched default model offers the choice inside the ask bar (Ctrl+K too)', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  assert.equal(env.config.text.model, 'qwen2.5:latest');
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar opens as always');
  assert.equal(env.hidden('inline-prompt-choice'), false, 'with the choice');
  assert.equal(env.hidden('inline-prompt-setup'), true, 'not the "no model" banner: Ollama needs no key');
  assert.equal(env.hidden('inline-prompt-error'), true);
  assert.equal(env.focused(), env.el('inline-prompt-input'), 'the caret is still in the field: the choice does not take over');
  env.key({ key: 'Escape' });
  assert.equal(env.config.general.aiChoiceMade, false, 'closing the bar is not a choice');

  env.ctrl('k');
  assert.equal(env.hidden('inline-prompt-choice'), false, 'the rewrite bar is the same bar');
});

check('"Later" records the choice, hides the banner, keeps the caret in the field and is never offered again', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  env.ctrl('l');
  env.el('btn-ai-choice-later').onclick();
  assert.equal(env.config.general.aiChoiceMade, true);
  assert.equal(env.hidden('inline-prompt-choice'), true);
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar stays open: it is not a modal step');
  assert.equal(env.focused(), env.el('inline-prompt-input'));
  assert.equal(env.saved.length, 1);
  assert.equal(env.saved[0].general.aiChoiceMade, true, 'persisted with the config');

  env.key({ key: 'Escape' });
  env.setNote('hello world', 0, 5);
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-choice'), true, 'not the second time');
});

check('"Set up a local model" saves the choice, then opens Settings > AI Models with the local AI card in view', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  env.ctrl('l');
  env.el('btn-ai-choice-local').onclick();
  assert.equal(env.config.general.aiChoiceMade, true);
  assert.equal(env.saved[0].general.aiChoiceMade, true, 'saved');
  assert.equal(env.hidden('inline-prompt-bar'), true, 'the ask bar makes room');
  assert.equal(env.hidden('settings-modal'), false, 'Settings is open');
  assert.equal(env.hidden('pane-model'), false, 'on AI Models');
  assert.equal(env.hidden('pane-general'), true);
  assert.deepEqual(plain(env.scrolled.filter((s) => s.id === 'local-ai-card')), [{ id: 'local-ai-card', options: { block: 'nearest' } }], 'the local AI card is scrolled to');
  assert.equal(env.focused(), env.el('btn-setup-ollama'), 'and its install button is the focus, after Settings has taken its own');
});

check('"Use a cloud key" opens the Text model fields (URL, name, key) and puts the caret in the key field', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  // The compact view folds sections into <details>; the fields must be visible whatever the person closed before.
  const folded = { tagName: 'DETAILS', open: false, parentElement: null, scrollIntoView(o) { env.scrolled.push({ id: 'section', options: o }); } };
  env.el('cfg-base-url').parentElement = folded;
  env.ctrl('l');
  env.el('btn-ai-choice-cloud').onclick();
  assert.equal(env.config.general.aiChoiceMade, true);
  assert.equal(env.hidden('settings-modal'), false);
  assert.equal(env.hidden('pane-model'), false);
  assert.equal(folded.open, true, 'a folded section is opened');
  assert.deepEqual(plain(env.scrolled.filter((s) => s.id === 'section')), [{ id: 'section', options: { block: 'start' } }], 'the group of fields is scrolled to the top');
  assert.equal(env.focused(), env.el('cfg-api-key'), 'the key field has the caret');
});

check('running the bar with the default model counts as the choice (Ollama works for them)', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'translate to English';
  env.el('btn-inline-prompt-send').onclick();
  assert.equal(env.llmCalls.length, 1, 'the request went out');
  assert.equal(env.config.general.aiChoiceMade, true);
  assert.equal(env.saved.length, 1);
  env.setNote('hello world', 0, 5);
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-choice'), true);
});

check('a failed request shows its own banner alone: the choice is never next to it', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG });
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'summarize';
  env.el('btn-inline-prompt-send').onclick();
  assert.equal(env.llmCalls.length, 1);
  env.config.general.aiChoiceMade = false; // as if the choice were still open when the request fails
  env.window.__onLLMResult(env.llmCalls[0].reqId, '', 'ローカルLLM/API接続エラー: connectex: actively refused');
  await env.flush();
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar is open again (D1)');
  assert.equal(env.hidden('inline-prompt-error'), false, 'with the failure');
  assert.equal(env.hidden('inline-prompt-choice'), true, 'and without the choice');
});

check('it is not offered once the model was changed, once a choice is on file, or when there is no model at all', async () => {
  const changed = await withNote({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'gemma4:latest', apiKey: '' } } });
  changed.ctrl('l');
  assert.equal(changed.hidden('inline-prompt-bar'), false);
  assert.equal(changed.hidden('inline-prompt-choice'), true, 'another model: a choice was made');

  const made = await withNote({ backendConfig: { general: { aiChoiceMade: true } } });
  made.ctrl('l');
  assert.equal(made.hidden('inline-prompt-choice'), true, 'aiChoiceMade');

  const cloudNoKey = await withNote({ backendConfig: { text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest', apiKey: '' } } });
  cloudNoKey.ctrl('l');
  assert.equal(cloudNoKey.hidden('inline-prompt-setup'), false, 'the "no model" banner instead');
  assert.equal(cloudNoKey.hidden('inline-prompt-choice'), true, 'never both');
});

check('a page without first_run.js never shows the choice (the ask bar is exactly what it was)', async () => {
  const env = await withNote({ backendConfig: DEFAULT_MODEL_CONFIG, firstRun: false });
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.hidden('inline-prompt-choice'), true);
});

check('a fresh install: the Welcome note is up, and its first Ctrl+L then offers the choice', async () => {
  const env = await createEnv();
  env.editor.selectionStart = env.editor.selectionEnd = 0;
  env.window.document.activeElement = env.editor;
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.hidden('inline-prompt-choice'), false);
});

// ---------------------------------------------------------------------------------------------------
// The markup, the strings and the styles
// ---------------------------------------------------------------------------------------------------
check('first_run.js loads before app.js, and the choice sits inside the ask bar next to the existing banners', () => {
  const at = indexHtml.indexOf('js/first_run.js');
  assert.ok(at !== -1 && at < indexHtml.indexOf('js/app.js'), 'first_run.js is loaded before app.js');
  const bar = indexHtml.slice(indexHtml.indexOf('id="inline-prompt-bar"'), indexHtml.indexOf('<!-- Primary Pane (Left) -->'));
  assert.ok(/<div id="inline-prompt-choice" class="inline-prompt-setup inline-prompt-choice hidden"/.test(bar), 'the banner reuses .inline-prompt-setup and starts hidden');
  assert.ok(bar.indexOf('id="inline-prompt-setup"') < bar.indexOf('id="inline-prompt-choice"') && bar.indexOf('id="inline-prompt-choice"') < bar.indexOf('id="inline-prompt-error"'), 'in the banner area of the bar');
  for (const id of ['btn-ai-choice-local', 'btn-ai-choice-cloud', 'btn-ai-choice-later']) assert.ok(bar.includes('id="' + id + '"'), id);
  assert.ok(/id="btn-ai-choice-local" class="btn-action"/.test(bar), 'primary = filled');
  assert.ok(/id="btn-ai-choice-cloud" class="btn-action btn-outline"/.test(bar), 'secondary = outline');
  assert.ok(/id="btn-ai-choice-later" class="btn-action btn-pale"/.test(bar), 'tertiary = pale fill');
  assert.ok(/role="group" aria-labelledby="inline-prompt-choice-text"/.test(bar), 'named for a screen reader');
  assert.ok(!/<dialog|modal-backdrop/.test(bar), 'no modal dialog');
  assert.ok(/<div id="local-ai-card" class="local-ai-card"/.test(indexHtml), 'the local AI card can be scrolled to');
});

check('every string exists in both languages, the English UI has no Japanese and the Japanese UI no English sentence', () => {
  const keys = ['aiChoiceText', 'aiChoiceLocal', 'aiChoiceCloud', 'aiChoiceLater'];
  const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;
  for (const k of keys) {
    assert.ok(I18N.en[k] && I18N.ja[k], k + ' in both languages');
    assert.ok(!JAPANESE.test(I18N.en[k]), k + ' (en) has no Japanese');
    assert.ok(indexHtml.includes('data-i18n="' + k + '"'), k + ' is wired to the markup');
  }
  assert.equal(I18N.en.aiChoiceLocal, 'Set up a local model (Ollama)');
  assert.equal(I18N.en.aiChoiceCloud, 'Use a cloud key');
  assert.equal(I18N.en.aiChoiceLater, 'Later');
  assert.ok(!/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/.test(I18N.ja.aiChoiceText + I18N.ja.aiChoiceLocal + I18N.ja.aiChoiceCloud + I18N.ja.aiChoiceLater), 'no English sentence in the Japanese strings');
});

check('the styles: neutral (not amber), a pale third button, 28px buttons; no emoji anywhere in the new text', () => {
  const rule = (sel) => {
    const m = styleCss.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, sel + ' exists');
    return m[1];
  };
  assert.ok(/border-color:\s*var\(--border-color\)/.test(rule('.inline-prompt-choice')) && !/245,\s*158,\s*11/.test(rule('.inline-prompt-choice')), 'a choice is not a warning');
  assert.ok(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.07\)/.test(rule('.inline-prompt-bar .btn-action.btn-pale')), 'pale fill');
  assert.ok(/height:\s*28px/.test(rule('.inline-prompt-choice .btn-action')), 'buttons are 28px');
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const welcome = fs.readFileSync(path.resolve('frontend/js/first_run.js'), 'utf8');
  assert.ok(!EMOJI.test(welcome), 'first_run.js');
  assert.ok(!EMOJI.test(indexHtml.slice(indexHtml.indexOf('id="inline-prompt-choice"'), indexHtml.indexOf('id="inline-prompt-error"')).replace(/✕/g, '')), 'the markup');
  assert.ok(!EMOJI.test(I18N.en.aiChoiceText + I18N.ja.aiChoiceText + I18N.en.aiChoiceLocal + I18N.ja.aiChoiceLocal));
});

check('the hooks in app.js stay small: a guarded call at start-up, one flag test when the ask bar opens', () => {
  assert.ok(/const configFileFound = await syncBackendConfig\(\);\s*\n\s*\/\/[^\n]*\n\s*showWelcomeOnFirstRun\(\{ configFileFound: configFileFound, sessionFound: restored \|\| backendSessionFound, workspaceFolder: savedFolder \}\);/.test(appCode), 'one call, after the config was read');
  assert.ok(/const FR = window\.FirstRun;\s*\n(\s*\/\/[^\n]*\n)?\s*if \(!FR \|\| !editorEl \|\| !signals \|\| signals\.configFileFound !== false\) return false;/.test(appCode),
    'nothing happens without the module, and every start after the first ends on the first boolean test');
  assert.ok(/setInlinePromptChoiceState\(llmReady && aiChoiceNeeded\(\)\);/.test(appCode), 'the ask bar asks once per open');
  assert.ok(/function aiChoiceNeeded\(\) \{\s*\n\s*return !!\(window\.FirstRun && window\.FirstRun\.shouldOfferAiChoice\(config\.general, config\.text\)\);/.test(appCode));
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n  ') : err}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${queue.length} first-run test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} first-run tests passed!`);
