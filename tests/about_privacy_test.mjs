// UX review I1, I2, I3: About MD-Memo, the update-check setting, and "where does my text go".
//   * I1: the Help button opens a small menu (manual / release notes / About); the palette has "About MD-Memo"; the dialog gets its data from
//         app.js through one host object; Go supplies the folders through backend_getAppInfo (bound on both platforms)
//   * I2: general.checkUpdates (default on, old configs have none) decides whether ANY request is made at start-up; "Check now" always works;
//         the notice says the version and links to the release notes
//   * I3: the ask and rewrite bars name the destination; a cloud host is asked about once (general.cloudConsent), a local model never
// The dialog itself is tested in frontend/js/about_dialog_test.js; here the whole app.js runs against a hand-made DOM.
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
const aboutCode = read('frontend/js/about_dialog.js');

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;
const plain = (value) => JSON.parse(JSON.stringify(value));

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

const API = 'https://api.github.com/repos/youshinh/md-memo/releases/latest';
const DOCS = 'https://youshinh.github.io/md-memo/';
const CLOUD = { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: 'k' };

// ---------------------------------------------------------------------------------------------------
// The page under a hand-made DOM (the same shape as tests/ask_and_command_bar_test.mjs, plus fetch, the document's listeners and a
// Help button that has a size)
// ---------------------------------------------------------------------------------------------------
const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane', 'help-menu', 'help-menu-update', 'about-modal', 'inline-prompt-dest', 'inline-prompt-consent',
  'help-update-badge', 'cfg-cloud-consent-row'];

async function flush() {
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const listeners = { keydown: [] };
  const docListeners = {};
  const messages = [];
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
      scrollIntoView: () => {},
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e) => { el.selectionStart = s; el.selectionEnd = e; },
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
      setAttribute: (name, val) => { attrs[name] = String(val); if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false
    };
    // The Help button has a size unless the toolbar layout hides it (a fresh installation does)
    if (id === 'btn-help') {
      el.getBoundingClientRect = () => (opts.helpHidden ? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } : { top: 0, bottom: 38, left: 1000, right: 1030, width: 30, height: 38 });
    }
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
    addEventListener: (evt, fn, cap) => { (docListeners[evt] = docListeners[evt] || []).push({ fn, cap }); },
    removeEventListener: (evt, fn) => { docListeners[evt] = (docListeners[evt] || []).filter((l) => l.fn !== fn); },
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
  const external = [];
  const opened = [];
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async (json) => { saved.push(JSON.parse(json)); },
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    getAppVersion: async () => opts.version || '1.10.5',
    openExternal: (url) => { external.push(url); },
    queryLLMAsync: (reqId, prompt, cfgJson) => { llmCalls.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); }
  }, opts.backend || {});

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

  // fetch: opts.fetch decides; every call is recorded. No fetch at all (a page where it does not exist) is opts.noFetch.
  const fetches = [];
  const fetchMock = async (url, init) => {
    fetches.push({ url, init });
    if (opts.fetch) return opts.fetch(url, init);
    return { ok: true, json: async () => ({ tag_name: opts.latest || 'v1.10.5' }) };
  };

  const windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows Test/1.0', language: opts.language === 'ja' ? 'ja-JP' : 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { longTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    open: (url) => { opened.push(url); },
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: {
      addTask: (o) => o,
      updateTask: () => {}
    }
  };
  documentMock.defaultView = windowMock;

  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log() {}, warn() {}, error() {} }
  };
  if (!opts.noFetch) context.fetch = fetchMock;
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(chromeLayoutCode, context);
  vm.runInContext(mermaidToneCode, context);
  vm.runInContext(llmErrorCode, context);
  vm.runInContext(aboutCode, context);
  // The dialog's own behaviour is tested in frontend/js/about_dialog_test.js: here only what app.js hands it is looked at.
  const aboutOpens = [];
  windowMock.AboutDialog.open = async (host) => { aboutOpens.push(host); return true; };
  if (opts.beforeApp) opts.beforeApp({ windowMock, documentMock, context });
  vm.runInContext(appCode, context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  const env = {
    window: windowMock, elements, messages, llmCalls, saved, store, el, fetches, external, opened, aboutOpens, docListeners,
    bridge: windowMock.MdMemoBridge,
    config: windowMock.__testHelper.config,
    helper: windowMock.__testHelper,
    editor: el('editor'),
    fire(id, evt, init) {
      const e = Object.assign({ key: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      (el(id)._listeners[evt] || []).forEach((fn) => fn(e));
      return e;
    },
    key(init) {
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, init);
      listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    ctrl(letter, extra) {
      return env.key(Object.assign({ key: letter, code: 'Key' + letter.toUpperCase(), ctrlKey: true }, extra));
    },
    // a keydown / mousedown as the document's own listeners (the Help menu adds them while it is open) see it
    docEvent(type, init) {
      const e = Object.assign({ defaultPrevented: false, stopped: false, target: null, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, init);
      (docListeners[type] || []).slice().forEach((l) => l.fn(e));
      return e;
    },
    docListenerCount: (type) => (docListeners[type] || []).length,
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, start, end) {
      env.editor.value = text;
      env.editor.selectionStart = start === undefined ? text.length : start;
      env.editor.selectionEnd = end === undefined ? env.editor.selectionStart : end;
      env.window.document.activeElement = env.editor;
    },
    // Ctrl+L on `text` selected, the instruction typed, Enter
    ask(instruction, { note = 'hello world\nsecond line', from = 0, to = 5, rewrite = false } = {}) {
      env.setNote(note, from, to);
      env.ctrl(rewrite ? 'k' : 'l');
      env.el('inline-prompt-input').value = instruction;
      env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
    },
    flush
  };
  return env;
}

const cloudConfig = (over) => ({ backendConfig: { text: Object.assign({}, CLOUD, over || {}) } });

// ===================================================================================================
// I2 - the update check
// ===================================================================================================
check('I2: on a new profile and on an old config with no such key the check runs once, against GitHub only, and asks for the release number', async () => {
  for (const env of [
    await createEnv(),
    await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { language: 'en' } }) } }),
    await createEnv({ backendConfig: { general: { language: 'en' } } })
  ]) {
    assert.equal(env.config.general.checkUpdates, true, 'the default is the old behaviour');
    assert.equal(env.fetches.length, 1, 'one request at start-up');
    assert.equal(env.fetches[0].url, API);
    assert.equal(env.fetches[0].init.headers.Accept, 'application/vnd.github.v3+json');
    assert.equal(env.fetches[0].init.cache, 'no-cache');
    assert.deepEqual(Object.keys(env.fetches[0].init).sort(), ['cache', 'headers'], 'a plain GET: no body, no credentials');
  }
});

check('I2: general.checkUpdates = false (from config.json or from the stored copy) means no request at all at start-up', async () => {
  const fromFile = await createEnv({ backendConfig: { general: { checkUpdates: false } } });
  assert.equal(fromFile.fetches.length, 0, 'config.json says off');
  const fromStore = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { checkUpdates: false } }) } });
  assert.equal(fromStore.fetches.length, 0, 'the stored copy says off');
  await fromStore.flush();
  assert.equal(fromStore.fetches.length, 0, 'and nothing arrives later');
  assert.equal(fromFile.config.general.checkUpdates, false);
  // only an explicit false turns it off: junk values keep today's behaviour
  for (const junk of [null, 0, '', 'false', undefined]) {
    const env = await createEnv({ backendConfig: { general: { checkUpdates: junk } } });
    assert.equal(env.fetches.length, 1, JSON.stringify(junk) + ' is not "off"');
  }
});

check('I2: the timer is not even armed when the setting is off, and is checked again when it fires', () => {
  const start = appCode.indexOf('// Check for app updates asynchronously in background');
  assert.ok(start > 0);
  const block = appCode.slice(start, appCode.indexOf('})();', start));
  assert.ok(/if \(updateCheckAtStartup\(\)\) \{\s*setTimeout\(\(\) => \{\s*if \(updateCheckAtStartup\(\)\) checkForAppUpdates\(\);\s*\}, 2500\);\s*\}/.test(block), block);
  const fetches = appCode.match(/fetch\(/g) || [];
  const gh = appCode.split('\n').filter((l) => l.includes('api.github.com') && !l.trim().startsWith('//'));
  assert.equal(gh.length, 1, 'the URL is written once: ' + gh.join(' | '));
  assert.ok(/const UPDATE_API_URL = 'https:\/\/api\.github\.com\/repos\/youshinh\/md-memo\/releases\/latest';/.test(appCode));
  assert.ok(fetches.length >= 1);
  assert.ok(/await fetch\(UPDATE_API_URL,/.test(appCode), 'the update request is the only user of that URL');
});

check('I2: a newer release shows the dot with the version in its tooltip; the Help menu states the version and links to the release notes', async () => {
  const env = await createEnv({ latest: 'v9.9.9', helpHidden: false });
  assert.equal(env.hidden('help-update-badge'), false, 'the dot');
  assert.equal(env.el('help-update-badge').title, 'New update available: v9.9.9');
  assert.equal(env.el('btn-help').title, 'New update available: v9.9.9');
  assert.equal(env.hidden('help-menu'), true);

  env.el('btn-help').onclick();
  assert.equal(env.hidden('help-menu'), false, 'the button opens the menu');
  assert.equal(env.hidden('help-menu-update'), false, 'with the update notice on top');
  assert.equal(env.el('help-menu-update-text').textContent, 'MD-Memo v9.9.9 is available. You have v1.10.5.');
  assert.equal(env.hidden('help-update-badge'), true, 'having seen it, the dot goes');
  assert.equal(env.store.get('mdmemo_dismissed_update_version'), '9.9.9', 'and stays gone for this version');
  assert.equal(env.window.document.activeElement, env.el('help-menu-notes'), 'the notes button has the focus');

  env.el('help-menu-notes').onclick();
  assert.deepEqual(env.external, ['https://github.com/youshinh/md-memo/releases/tag/v9.9.9'], 'release notes of that version');
  assert.equal(env.hidden('help-menu'), true, 'and the menu closes');

  // the notice is still there the next time the menu opens (it is only the dot that was dismissed)
  env.el('btn-help').onclick();
  assert.equal(env.hidden('help-menu-update'), false);
  assert.equal(env.hidden('help-update-badge'), true);
});

check('I2: a version the person already dismissed does not bring the dot back; the same or an older release shows nothing', async () => {
  const dismissed = await createEnv({ latest: 'v9.9.9', localStorage: { mdmemo_dismissed_update_version: '9.9.9' } });
  assert.equal(dismissed.hidden('help-update-badge'), true);
  const same = await createEnv({ latest: 'v1.10.5' });
  assert.equal(same.hidden('help-update-badge'), true);
  same.el('btn-help').onclick();
  assert.equal(same.hidden('help-menu-update'), true, 'no notice when there is nothing to say');
  const older = await createEnv({ latest: 'v1.2.0' });
  assert.equal(older.hidden('help-update-badge'), true);
});

check('I2: with the Help button hidden (a fresh installation) the dot has nowhere to sit, so a newer version is announced once, in a message, naming the version', async () => {
  const env = await createEnv({ latest: 'v9.9.9', helpHidden: true });
  assert.equal(env.hidden('help-update-badge'), true, 'no dot on a hidden button');
  const said = env.messages.filter((m) => /9\.9\.9/.test(m));
  assert.deepEqual(said, ['MD-Memo v9.9.9 is available. See About MD-Memo in the command palette.']);
  assert.equal(env.store.get('mdmemo_dismissed_update_version'), '9.9.9', 'once per version');
  // the next start, same version: quiet. A still newer one is announced again.
  const again = await createEnv({ latest: 'v9.9.9', helpHidden: true, localStorage: { mdmemo_dismissed_update_version: '9.9.9' } });
  assert.deepEqual(again.messages.filter((m) => /9\.9\.9/.test(m)), []);
  const newer = await createEnv({ latest: 'v9.9.10', helpHidden: true, localStorage: { mdmemo_dismissed_update_version: '9.9.9' } });
  assert.equal(newer.messages.filter((m) => /9\.9\.10/.test(m)).length, 1);
  // a visible button gets the dot and no message; nothing is said when there is nothing newer
  const visible = await createEnv({ latest: 'v9.9.9' });
  assert.deepEqual(visible.messages.filter((m) => /9\.9\.9/.test(m)), []);
  const none = await createEnv({ latest: 'v1.10.5', helpHidden: true });
  assert.deepEqual(none.messages.filter((m) => /available/i.test(m)), []);
  // in Japanese
  const ja = await createEnv({ latest: 'v9.9.9', helpHidden: true, language: 'ja', backendConfig: { general: { language: 'ja' } } });
  assert.deepEqual(ja.messages.filter((m) => /9\.9\.9/.test(m)), ['MD-Memo v9.9.9 が利用できます。コマンドパレットの「MD-Memo について」をご確認ください。']);
  // About open when the answer comes: the dialog already says it, no message
  const dialog = await createEnv({ backendConfig: { general: { checkUpdates: false } }, latest: 'v9.9.9', helpHidden: true });
  dialog.window.AboutDialog.isOpen = () => true;
  dialog.helper.openAboutDialog();
  await dialog.flush();
  await dialog.aboutOpens[0].checkNow();
  assert.deepEqual(dialog.messages.filter((m) => /9\.9\.9/.test(m)), [], 'the open dialog is the notice');
  assert.equal(dialog.aboutOpens[0].getUpdateState().status, 'newer');
});

check('I2: About > Check now works whatever the setting says, reports each outcome, and one check at a time', async () => {
  const env = await createEnv({ backendConfig: { general: { checkUpdates: false } }, latest: 'v1.11.0' });
  assert.equal(env.fetches.length, 0);
  env.helper.openAboutDialog();
  await env.flush();
  const host = env.aboutOpens[0];
  assert.ok(host, 'the palette / menu path calls the dialog with a host');
  assert.equal(host.isCheckAtStartup(), false);
  assert.equal(host.getUpdateState().status, 'idle');

  const first = host.checkNow();
  assert.equal(host.getUpdateState().status, 'checking', 'the state is "checking" the moment the call returns');
  const second = host.checkNow();
  assert.equal(first, second, 'a second click while one is running shares it');
  await first;
  assert.equal(env.fetches.length, 1);
  assert.deepEqual(plain(host.getUpdateState()), { status: 'newer', latest: '1.11.0', current: '1.10.5', url: 'https://github.com/youshinh/md-memo/releases/tag/v1.11.0' });
  assert.equal(env.hidden('help-update-badge'), false, 'the dot follows a manual check too');

  // the same version -> current
  const same = await createEnv({ latest: 'v1.10.5' });
  same.helper.openAboutDialog();
  await same.flush();
  await same.aboutOpens[0].checkNow();
  assert.deepEqual(plain(same.aboutOpens[0].getUpdateState()), { status: 'current', latest: '1.10.5', current: '1.10.5', url: 'https://github.com/youshinh/md-memo/releases/tag/v1.10.5' });

  // failures: offline, a rate-limited answer, a page without a tag, junk JSON, no fetch at all
  for (const [label, o] of [
    ['offline', { fetch: async () => { throw new TypeError('Failed to fetch'); } }],
    ['403', { fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }) }],
    ['no tag', { fetch: async () => ({ ok: true, json: async () => ({}) }) }],
    ['junk', { fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }) }],
    ['no fetch', { noFetch: true }]
  ]) {
    const e = await createEnv(Object.assign({ backendConfig: { general: { checkUpdates: false } } }, o));
    e.helper.openAboutDialog();
    await e.flush();
    const h = e.aboutOpens[0];
    assert.doesNotThrow(() => h.checkNow(), label);
    await h.checkNow();
    assert.equal(h.getUpdateState().status, 'error', label);
    assert.equal(e.hidden('help-update-badge'), true, label + ': no dot for a failed check');
    await h.checkNow();
    assert.equal(h.getUpdateState().status, 'error', label + ': and it can be tried again');
  }
});

check('I2: a failed start-up check is silent (no toast, no dot) and an error never hides a dot that was already shown', async () => {
  const env = await createEnv({ fetch: async () => { throw new TypeError('offline'); } });
  assert.equal(env.hidden('help-update-badge'), true);
  assert.deepEqual(env.messages.filter((m) => /update|GitHub/i.test(m)), []);

  // the first answer says 9.9.9, then GitHub becomes unreachable
  let answers = 0;
  const shown = await createEnv({
    fetch: async () => {
      if (answers++ === 0) return { ok: true, json: async () => ({ tag_name: 'v9.9.9' }) };
      throw new TypeError('offline');
    }
  });
  assert.equal(shown.hidden('help-update-badge'), false);
  shown.helper.openAboutDialog();
  await shown.flush();
  const h = shown.aboutOpens[0];
  assert.equal(h.getUpdateState().status, 'newer');
  await h.checkNow();
  assert.equal(h.getUpdateState().status, 'error', 'the failed check is reported to the dialog');
  assert.equal(h.getUpdateState().latest, '9.9.9', 'what was learnt before is kept');
  assert.equal(shown.hidden('help-update-badge'), false, 'and the dot stays');
});

check('I2: Settings > General has the switch; it shows the stored value, is saved, and defaults to on for a config that never heard of it', async () => {
  const env = await createEnv();
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.hidden('settings-modal'), false);
  assert.equal(env.el('cfg-check-updates').checked, true, 'on by default');
  env.el('cfg-check-updates').checked = false;
  await env.el('btn-save-settings').onclick();
  assert.equal(env.config.general.checkUpdates, false);
  assert.equal(env.saved[env.saved.length - 1].general.checkUpdates, false, 'written to config.json');

  const off = await createEnv({ backendConfig: { general: { checkUpdates: false } } });
  off.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(off.el('cfg-check-updates').checked, false, 'the stored "off" is shown');
  off.el('cfg-check-updates').checked = true;
  await off.el('btn-save-settings').onclick();
  assert.equal(off.saved[off.saved.length - 1].general.checkUpdates, true);
});

// ===================================================================================================
// I1 - the Help menu, the palette, the host
// ===================================================================================================
check('I1: the Help button opens a menu with the manual and About; a hidden button (toolbar layout) still opens the manual as it always did', async () => {
  const env = await createEnv();
  const btn = env.el('btn-help');
  assert.equal(btn.getAttribute('aria-haspopup'), 'true');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  btn.onclick();
  assert.equal(env.hidden('help-menu'), false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(env.hidden('help-menu-update'), true, 'no update, no notice');
  assert.equal(env.el('help-menu').getAttribute('aria-label'), I18N.en.helpTitle);
  assert.equal(env.el('help-menu').style.top, '44px', 'under the button');
  assert.equal(env.el('help-menu').style.right, '170px', 'right edges line up');
  assert.equal(env.window.document.activeElement, env.el('help-menu-manual'));
  assert.equal(env.docListenerCount('keydown'), 1, 'listeners exist only while it is open');
  assert.equal(env.docListenerCount('mousedown'), 1);

  env.el('help-menu-manual').onclick();
  assert.deepEqual(env.external, [DOCS]);
  assert.equal(env.hidden('help-menu'), true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(env.docListenerCount('keydown'), 0);
  assert.equal(env.docListenerCount('mousedown'), 0);

  btn.onclick();
  btn.onclick();
  assert.equal(env.hidden('help-menu'), true, 'a second click closes it');

  const hiddenBtn = await createEnv({ helpHidden: true });
  hiddenBtn.el('btn-help').onclick();
  assert.equal(hiddenBtn.hidden('help-menu'), true, 'nothing to anchor a menu to');
  assert.deepEqual(hiddenBtn.external, [DOCS], 'so the click opens the manual');

  const noBridge = await createEnv({ backend: { openExternal: undefined } });
  noBridge.el('btn-help').onclick();
  noBridge.el('help-menu-manual').onclick();
  assert.deepEqual(noBridge.opened, [DOCS], 'a page without the native bridge uses window.open');
});

check('I1: the menu closes on Esc (swallowing the key), on a click outside, and on Tab; a click inside stays', async () => {
  const env = await createEnv();
  const open = () => { env.el('btn-help').onclick(); assert.equal(env.hidden('help-menu'), false); };
  open();
  const esc = env.docEvent('keydown', { key: 'Escape' });
  assert.ok(esc.defaultPrevented && esc.stopped, 'Esc does not also close a bar behind it');
  assert.equal(env.hidden('help-menu'), true);
  assert.equal(env.window.document.activeElement, env.el('btn-help'), 'focus goes back to the button');
  open();
  env.docEvent('mousedown', { target: env.el('editor') });
  assert.equal(env.hidden('help-menu'), true, 'outside');
  open();
  env.docEvent('keydown', { key: 'Tab' });
  assert.equal(env.hidden('help-menu'), true, 'Tab');
  open();
  env.docEvent('keydown', { key: 'a' });
  assert.equal(env.hidden('help-menu'), false, 'other keys are left alone');
  env.el('help-menu-about').onclick();
  assert.equal(env.hidden('help-menu'), true, 'choosing About closes the menu');
  assert.equal(env.aboutOpens.length, 1);
});

check('I1: the palette has "About MD-Memo" and "Help" (the manual, directly), each with a line icon', async () => {
  assert.ok(/id: 'cmd_about',\s*title: t\('cmdPaletteAbout'\),\s*desc: t\('cmdPaletteAboutDesc'\),\s*iconSvg: icon\('<circle/.test(appCode));
  assert.ok(/id: 'cmd_help',[\s\S]{0,300}action: \(\) => openHelpDocs\(\)/.test(appCode), 'the palette entry for the manual does not go through the button (which now opens a menu)');
  assert.equal(I18N.en.cmdPaletteAbout, 'About MD-Memo');
  assert.equal(I18N.ja.cmdPaletteAbout, 'MD-Memo について');

  const env = await createEnv();
  env.ctrl('p', { shiftKey: true });
  assert.equal(env.hidden('quick-pick-modal'), false, 'the palette opens');
  const input = env.el('quick-pick-input');
  input.value = 'about md';
  env.fire('quick-pick-input', 'input', {});
  env.fire('quick-pick-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.aboutOpens.length, 1, 'Enter on "about md" opens About');

  const help = await createEnv();
  help.ctrl('p', { shiftKey: true });
  help.el('quick-pick-input').value = 'help and manual';
  help.fire('quick-pick-input', 'input', {});
  help.fire('quick-pick-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await help.flush();
  assert.deepEqual(help.external, [DOCS], 'the palette Help opens the manual');
  assert.equal(help.hidden('help-menu'), true, 'and never the menu');
});

check('I1: the host app.js gives the dialog: version and AppInfo from the backend, the folders opened by path, the clipboard, the language', async () => {
  const info = { version: '1.10.5', commit: 'a8bfea5', builtAt: '2026-09-30T05:12:34Z', os: 'windows', arch: 'amd64', executable: 'C:\\x\\md-memo.exe', configDir: 'C:\\c', configFile: 'C:\\c\\config.json', scrapDir: 'C:\\n', signing: 'unsigned' };
  const opened = [];
  const env = await createEnv({ backend: { getAppInfo: async () => info, openPath: async (p, base) => { opened.push([p, base]); } } });
  await env.helper.openAboutDialog();
  const host = env.aboutOpens[0];
  assert.equal(typeof host.t, 'function');
  assert.equal(host.t('aboutVersion', { version: '2.0' }), 'Version 2.0');
  assert.equal(host.language, 'en');
  assert.equal(host.userAgent, 'Windows Test/1.0');
  assert.deepEqual(plain(await host.getInfo()), info);
  await host.openFolder('C:\\c');
  assert.deepEqual(opened, [['C:\\c', '']]);
  assert.equal(typeof host.copyText, 'function');
  assert.equal(typeof host.openExternal, 'function');
  host.openExternal('https://example.com/');
  assert.deepEqual(env.external, ['https://example.com/']);

  // a backend built before getAppInfo existed: still a version
  const old = await createEnv({ version: '1.9.0' });
  await old.helper.openAboutDialog();
  assert.deepEqual(plain(await old.aboutOpens[0].getInfo()), { version: '1.9.0' });
  assert.equal(old.aboutOpens[0].getVersion(), '1.9.0');
  await assert.rejects(() => old.aboutOpens[0].openFolder('x'), /openPath/, 'the dialog turns that into its plain sentence');
  // a backend that throws does not stop the dialog
  const broken = await createEnv({ backend: { getAppInfo: async () => { throw new Error('x'); } } });
  await broken.helper.openAboutDialog();
  assert.deepEqual(plain(await broken.aboutOpens[0].getInfo()), { version: '1.10.5' });
  // no dialog module: the menu entry falls back to the manual instead of doing nothing
  const bare = await createEnv({ beforeApp: ({ windowMock }) => { delete windowMock.AboutDialog; } });
  assert.equal(bare.helper.openAboutDialog(), null);
});

check('I1: the Japanese UI passes the Japanese language and strings to the dialog', async () => {
  const env = await createEnv({ backendConfig: { general: { language: 'ja' } }, language: 'ja' });
  await env.helper.openAboutDialog();
  const host = env.aboutOpens[0];
  assert.equal(host.language, 'ja');
  assert.equal(host.t('aboutTitle'), 'MD-Memo について');
  env.el('btn-help').onclick();
  assert.equal(env.el('help-menu').getAttribute('aria-label'), I18N.ja.helpTitle);
});

// ===================================================================================================
// I3 - where the text goes
// ===================================================================================================
const dest = (env) => ({ hidden: env.hidden('inline-prompt-dest'), text: env.el('inline-prompt-dest-text').textContent, kind: env.el('inline-prompt-dest').getAttribute('data-kind'), title: env.el('inline-prompt-dest').title });

check('I3: the ask bar says "Local Ollama (model)" for the default, "Local server" for another local box, and "model (cloud)" for the internet', async () => {
  const env = await createEnv();
  env.setNote('hello world', 0, 5);
  env.ctrl('l');
  assert.deepEqual(dest(env), { hidden: false, text: 'Local Ollama (qwen2.5:latest)', kind: 'local', title: 'Your text goes to localhost:11434, on this computer or your network.' });
  env.key({ key: 'Escape' });

  env.config.text.baseUrl = 'http://localhost:1234/v1';
  env.config.text.model = 'local-model';
  env.ctrl('l');
  assert.deepEqual(dest(env), { hidden: false, text: 'Local server (local-model)', kind: 'local', title: 'Your text goes to localhost:1234, on this computer or your network.' });
  env.key({ key: 'Escape' });

  env.config.text.baseUrl = 'http://192.168.1.5:11434';
  env.ctrl('l');
  assert.equal(dest(env).text, 'Local Ollama (local-model)', 'a box on the local network running Ollama');
  assert.equal(dest(env).kind, 'local');
  env.key({ key: 'Escape' });

  Object.assign(env.config.text, CLOUD);
  env.ctrl('l');
  assert.deepEqual(dest(env), { hidden: false, text: 'gemini-flash-lite-latest (cloud)', kind: 'cloud', title: 'Your text goes over the internet to generativelanguage.googleapis.com.' });
  assert.ok(env.el('inline-prompt-bar').classList.contains('hidden') === false);
});

check('I3: the Rewrite bar says it too; the Japanese UI says it in Japanese; no model set up hides the line (the setup banner shows instead)', async () => {
  const env = await createEnv(cloudConfig());
  env.setNote('hello world', 0, 5);
  env.ctrl('k');
  assert.equal(env.el('inline-prompt-badge').textContent, 'Rewrite');
  assert.equal(dest(env).text, 'gemini-flash-lite-latest (cloud)');
  env.key({ key: 'Escape' });

  const ja = await createEnv({ backendConfig: { general: { language: 'ja' } }, language: 'ja' });
  ja.setNote('こんにちは', 0, 3);
  ja.ctrl('l');
  assert.equal(dest(ja).text, 'ローカルの Ollama（qwen2.5:latest）');
  assert.equal(dest(ja).title, '文章は、このパソコンかネットワーク内の localhost:11434 に送られます。');
  ja.key({ key: 'Escape' });
  Object.assign(ja.config.text, CLOUD);
  ja.ctrl('l');
  assert.equal(dest(ja).text, 'gemini-flash-lite-latest（クラウド）');
  assert.equal(dest(ja).title, '文章はインターネットを通して generativelanguage.googleapis.com に送られます。');

  const none = await createEnv();
  none.config.text.baseUrl = '';
  none.setNote('hello', 0, 5);
  none.ctrl('l');
  assert.equal(dest(none).hidden, true, 'no URL');
  assert.equal(none.hidden('inline-prompt-setup'), false, 'the setup banner is what shows');
  none.key({ key: 'Escape' });
  none.config.text.baseUrl = 'http://localhost:11434';
  none.config.text.model = '';
  none.ctrl('l');
  assert.equal(dest(none).hidden, true, 'no model');
});

check('I3: a bar that only collects a task instruction does not name a destination (the task decides), and the line does not linger', async () => {
  const env = await createEnv(cloudConfig());
  env.setNote('do this thing', 0, 5);
  env.bridge.openAskBar({ onSubmit: () => {} });
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.hidden('inline-prompt-dest'), true);
  env.key({ key: 'Escape' });
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-dest'), false, 'and the next ordinary ask names it again');
});

check('I3: a local model is never asked: the request goes straight out, and nothing is written into general.cloudConsent', async () => {
  const env = await createEnv();
  env.ask('translate');
  assert.equal(env.llmCalls.length, 1);
  assert.equal(env.hidden('inline-prompt-consent'), true);
  assert.deepEqual(plain(env.config.general.cloudConsent), {});
  assert.equal(env.saved.length, 0);
});

check('I3: the first ask to a cloud host asks first, in the bar, before anything is written into the note; Cancel keeps the text', async () => {
  const env = await createEnv(cloudConfig());
  const before = 'hello world\nsecond line';
  env.ask('translate');
  assert.equal(env.llmCalls.length, 0, 'nothing was sent');
  assert.equal(env.editor.value, before, 'and the note was not touched (no anchor)');
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar stays');
  assert.equal(env.hidden('inline-prompt-consent'), false, 'with the question');
  assert.equal(env.el('inline-prompt-consent-text').textContent, 'Your text will be sent over the internet to generativelanguage.googleapis.com. Allow it?');
  assert.equal(I18N.en.askConsentAllow, 'Allow and send', 'the button text comes from the markup (data-i18n)');
  assert.equal(env.window.document.activeElement, env.el('btn-inline-prompt-consent-allow'));
  assert.equal(env.el('inline-prompt-input').value, 'translate', 'the instruction is kept');

  env.el('btn-inline-prompt-consent-cancel').onclick();
  assert.equal(env.hidden('inline-prompt-consent'), true);
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.window.document.activeElement, env.el('inline-prompt-input'), 'back to the field');
  assert.equal(env.el('inline-prompt-input').value, 'translate');
  assert.equal(env.llmCalls.length, 0);
  assert.deepEqual(plain(env.config.general.cloudConsent), {}, 'no is not remembered: it asks again');

  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(env.hidden('inline-prompt-consent'), false, 'the next Enter asks again');
  env.key({ key: 'Escape' });
  assert.equal(env.hidden('inline-prompt-bar'), true, 'Esc closes the bar');
  env.setNote(before, 0, 5);
  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-consent'), true, 'and the question does not come back with a new bar');
});

check('I3: Allow sends the request, remembers the host (lower case, with the date), saves it, and never asks that host again', async () => {
  const env = await createEnv(cloudConfig({ baseUrl: 'https://Generativelanguage.GoogleAPIs.com/v1beta' }));
  env.ask('translate');
  assert.equal(env.hidden('inline-prompt-consent'), false);
  env.el('btn-inline-prompt-consent-allow').onclick();
  assert.equal(env.llmCalls.length, 1, 'the request goes out');
  assert.equal(env.llmCalls[0].cfg.model, CLOUD.model);
  assert.equal(env.hidden('inline-prompt-bar'), true, 'the bar closes as for any request');
  assert.ok(env.editor.value.includes('translate'), 'the anchor is in the note now');
  const consent = plain(env.config.general.cloudConsent);
  assert.deepEqual(Object.keys(consent), ['generativelanguage.googleapis.com']);
  assert.match(consent['generativelanguage.googleapis.com'], /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(env.saved.length >= 1, 'written to config.json');
  assert.deepEqual(Object.keys(env.saved[env.saved.length - 1].general.cloudConsent), ['generativelanguage.googleapis.com']);

  env.window.__onLLMResult(env.llmCalls[0].reqId, 'ok', '');
  env.ask('again');
  assert.equal(env.hidden('inline-prompt-consent'), true, 'the second ask goes straight through');
  assert.equal(env.llmCalls.length, 2);

  env.window.__onLLMResult(env.llmCalls[1].reqId, 'ok', '');
  Object.assign(env.config.text, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' });
  env.ask('other host');
  assert.equal(env.hidden('inline-prompt-consent'), false, 'another host asks again');
  assert.equal(env.el('inline-prompt-consent-text').textContent, 'Your text will be sent over the internet to api.openai.com. Allow it?');
  assert.equal(env.llmCalls.length, 2);
});

check('I3: rewrite asks too, and after Allow the selection is replaced as usual; Retry after a failure does not ask again', async () => {
  const env = await createEnv(cloudConfig());
  env.ask('shorter', { rewrite: true });
  assert.equal(env.llmCalls.length, 0);
  assert.equal(env.hidden('inline-prompt-consent'), false);
  assert.equal(env.editor.value, 'hello world\nsecond line');
  env.el('btn-inline-prompt-consent-allow').onclick();
  assert.equal(env.llmCalls.length, 1);
  assert.ok(env.llmCalls[0].prompt.includes('shorter') && env.llmCalls[0].prompt.includes('hello'), 'the rewrite prompt');
  env.window.__onLLMResult(env.llmCalls[0].reqId, '', 'boom');
  assert.equal(env.editor.value, 'hello world\nsecond line', 'the failure put the note back');
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.hidden('inline-prompt-consent'), true, 'the reopened bar shows the failure, not the question');
  env.el('btn-inline-prompt-retry').onclick();
  assert.equal(env.llmCalls.length, 2, 'Retry goes straight out');
});

check('I3: an Enter still held down does not answer the question; a real click does; junk in general.cloudConsent is treated as "nothing allowed"', async () => {
  const env = await createEnv(cloudConfig());
  env.ask('translate');
  env.el('btn-inline-prompt-consent-allow').onclick({ detail: 0 });
  assert.equal(env.llmCalls.length, 0, 'a key press within a third of a second is ignored');
  assert.equal(env.hidden('inline-prompt-consent'), false);
  const repeat = env.fire('btn-inline-prompt-consent-allow', 'keydown', { key: 'Enter', repeat: true });
  assert.equal(repeat.defaultPrevented, true, 'and an auto-repeated Enter into the focused button does not activate it, however long it was held');
  const first = env.fire('btn-inline-prompt-consent-allow', 'keydown', { key: 'Enter', repeat: false });
  assert.equal(first.defaultPrevented, false, 'a deliberate first press is left alone');
  env.el('btn-inline-prompt-consent-allow').onclick({ detail: 1 });
  assert.equal(env.llmCalls.length, 1, 'a mouse click is what it takes');

  for (const junk of [['generativelanguage.googleapis.com'], 'generativelanguage.googleapis.com', null, 5, { 'generativelanguage.googleapis.com': '' }, { 'generativelanguage.googleapis.com': false }, { '__proto__': 'x' }]) {
    const e = await createEnv(cloudConfig());
    e.config.general.cloudConsent = junk;
    e.ask('translate');
    assert.equal(e.llmCalls.length, 0, JSON.stringify(junk) + ' is not consent');
    assert.equal(e.hidden('inline-prompt-consent'), false);
    e.el('btn-inline-prompt-consent-allow').onclick();
    assert.equal(e.llmCalls.length, 1);
    assert.equal(typeof e.config.general.cloudConsent, 'object');
    assert.ok(!Array.isArray(e.config.general.cloudConsent), 'repaired into a map');
    assert.ok(e.config.general.cloudConsent['generativelanguage.googleapis.com']);
  }

  // consent already in config.json from an earlier session
  const kept = await createEnv({ backendConfig: { text: CLOUD, general: { cloudConsent: { 'generativelanguage.googleapis.com': '2026-09-01' } } } });
  kept.ask('translate');
  assert.equal(kept.llmCalls.length, 1);
  assert.equal(kept.hidden('inline-prompt-consent'), true);
});

check('I3: the bar does not fade away while the question is open, and the fade rule knows it', () => {
  assert.ok(/isBusy: \(\) => askErrorShown \|\| askConsentShown,/.test(appCode));
});

check('I3: Settings > General lists the allowed hosts with a button that forgets them; Cancel puts them back, Save keeps the change', async () => {
  const env = await createEnv({ backendConfig: { general: { cloudConsent: { 'b.example': '2026-01-02', 'a.example': '2026-01-01', 'gone.example': '' } } } });
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.hidden('cfg-cloud-consent-row'), false);
  assert.equal(env.el('cfg-cloud-consent-hosts').textContent, 'a.example, b.example', 'sorted, and only hosts that are actually allowed');
  env.el('btn-forget-cloud-consent').onclick();
  assert.equal(env.hidden('cfg-cloud-consent-row'), true);
  assert.deepEqual(plain(env.config.general.cloudConsent), {});
  assert.ok(env.messages.includes(I18N.en.cloudConsentForgotten));
  assert.equal(env.saved.length, 0, 'nothing is written yet');
  env.el('btn-cancel-settings').onclick();
  assert.deepEqual(Object.keys(plain(env.config.general.cloudConsent)).sort(), ['a.example', 'b.example', 'gone.example'], 'Cancel undoes it');

  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  env.el('btn-forget-cloud-consent').onclick();
  await env.el('btn-save-settings').onclick();
  assert.deepEqual(plain(env.saved[env.saved.length - 1].general.cloudConsent), {}, 'Save writes the empty list');

  const none = await createEnv();
  none.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(none.hidden('cfg-cloud-consent-row'), true, 'nothing allowed, nothing to show');
});

// ===================================================================================================
// The pieces the tests above do not run
// ===================================================================================================
check('the page: about_dialog.js loads before app.js; the dialog, the menu and the switch are in the markup once; nothing new sits in the header', () => {
  const at = (f) => indexHtml.indexOf(`js/${f}?v=`);
  assert.ok(at('about_dialog.js') > 0 && at('about_dialog.js') < at('app.js') && at('i18n.js') < at('about_dialog.js'));
  assert.match(indexHtml, /<script src="js\/about_dialog\.js\?v=\d+\.\d+\.\d+"><\/script>/);
  for (const id of ['about-modal', 'about-title', 'about-body', 'about-close', 'about-copy', 'about-done', 'help-menu', 'help-menu-update', 'help-menu-update-text',
    'help-menu-notes', 'help-menu-manual', 'help-menu-about', 'cfg-check-updates', 'cfg-cloud-consent-row', 'cfg-cloud-consent-hosts', 'btn-forget-cloud-consent',
    'inline-prompt-dest', 'inline-prompt-dest-text', 'inline-prompt-consent', 'inline-prompt-consent-text', 'btn-inline-prompt-consent-allow', 'btn-inline-prompt-consent-cancel']) {
    assert.equal((indexHtml.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} exists once`);
  }
  assert.match(indexHtml, /<div id="about-modal" class="modal-backdrop hidden">\s*<div class="modal-card about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">/);
  assert.match(indexHtml, /<div id="inline-prompt-consent" class="[^"]*hidden" role="alert">/, 'announced when it appears');
  assert.match(indexHtml, /<div id="help-menu" class="help-menu hidden"/);
  const header = indexHtml.slice(indexHtml.indexOf('<header id="header">'), indexHtml.indexOf('</header>'));
  assert.ok(!/about/i.test(header.replace(/about:blank/g, '')), 'no About icon in the header');
  assert.ok(indexHtml.indexOf('id="about-modal"') > indexHtml.indexOf('<!-- Go To Line Modal -->'), 'after the Go To Line dialog (the pack dialog test slices up to it)');
  // the destination line sits in the meta row, between the chip and the hint; the first-run chooser's banner is untouched
  const meta = indexHtml.slice(indexHtml.indexOf('<div class="inline-prompt-meta">'), indexHtml.indexOf('<div id="inline-prompt-setup"'));
  assert.ok(meta.indexOf('id="inline-prompt-target"') < meta.indexOf('id="inline-prompt-dest"') && meta.indexOf('id="inline-prompt-dest"') < meta.indexOf('id="inline-prompt-hint"'), meta);
  assert.match(indexHtml, /<div id="inline-prompt-setup" class="inline-prompt-setup hidden">\s*<span data-i18n="askSetupNeeded">/);
  const pane = indexHtml.slice(indexHtml.indexOf('id="pane-general"'), indexHtml.indexOf('id="pane-model"'));
  assert.ok(pane.includes('id="cfg-check-updates"') && pane.includes('id="cfg-cloud-consent-row"'), 'in Settings > General');
  assert.match(pane, /<input type="checkbox" id="cfg-check-updates" checked>/, 'a switch like its neighbours (the checkbox is styled as one)');
});

check('i18n: every new string exists in English and Japanese with the same placeholders; English has no Japanese; Japanese has no English sentence', () => {
  const CJK = /[぀-ヿ一-鿿＀-￯]/;
  const keys = Object.keys(I18N.en).filter((k) => /^(about[A-Z]|helpMenu|checkUpdates|cloudConsent|askDest|askConsent|cmdPaletteAbout|sectionUpdatesPrivacy)/.test(k));
  assert.ok(keys.length >= 50, 'found ' + keys.length);
  const ph = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  const properNouns = new Set(['aboutLinkGitHub', 'aboutLicenseLine']);
  for (const k of keys) {
    assert.equal(typeof I18N.ja[k], 'string', k + ' has a Japanese string');
    assert.equal(ph(I18N.en[k]), ph(I18N.ja[k]), k + ': same placeholders');
    assert.ok(!CJK.test(I18N.en[k]), k + ': no Japanese in English: ' + I18N.en[k]);
    if (!properNouns.has(k)) assert.ok(CJK.test(I18N.ja[k]), k + ': Japanese text: ' + I18N.ja[k]);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u.test(I18N.en[k] + I18N.ja[k]), k + ': no emoji');
    assert.ok(!/->|=>/.test(I18N.en[k] + I18N.ja[k]), k + ': no ASCII arrow');
  }
  // every key the new code asks for exists
  const asked = new Set();
  for (const src of [appCode, aboutCode]) for (const m of src.matchAll(/\bt\(\s*'([^']+)'|host\.t\(\s*'([^']+)'/g)) asked.add(m[1] || m[2]);
  for (const k of asked) if (/^(about[A-Z]|helpMenu|checkUpdates|cloudConsent|askDest|askConsent|cmdPaletteAbout)/.test(k)) assert.ok(I18N.en[k] && I18N.ja[k], k + ' is used and translated');
  // and every markup key
  for (const m of indexHtml.matchAll(/data-i18n(?:-title)?="((?:about|helpMenu|checkUpdates|cloudConsent|askConsent|sectionUpdatesPrivacy)[A-Za-z]*)"/g)) assert.ok(I18N.en[m[1]] && I18N.ja[m[1]], m[1]);
});

check('css: every class the new markup and script use is styled, and the destination line gives way to the hint last', () => {
  for (const cls of ['inline-prompt-dest', 'inline-prompt-dest-arrow', 'inline-prompt-consent', 'help-menu', 'help-menu-item', 'help-menu-update', 'help-menu-label', 'help-menu-update-text',
    'about-card', 'about-hero', 'about-icon', 'about-name', 'about-version', 'about-sub', 'about-section', 'about-label', 'about-row', 'about-key', 'about-path', 'about-status',
    'about-actions', 'about-note', 'about-license', 'about-links', 'about-link', 'about-error', 'cfg-consent-row', 'cfg-consent-hosts']) {
    assert.ok(new RegExp('(^|[\\s,>~+}])\\.' + cls + '([\\s,{:.\\[>~+]|$)', 'm').test(styleCss), '.' + cls + ' is styled');
  }
  assert.ok(/#about-modal .modal-card \{[^}]*width: min\(var\(--panel-width, 560px\)/.test(styleCss), 'the same 560px as the other dialogs');
  assert.ok(/\.inline-prompt-dest \{[^}]*flex: 1 1 0;[^}]*min-width: 96px;/.test(styleCss));
  assert.ok(/\.inline-prompt-dest ~ \.inline-prompt-hint \{\s*flex: 0 1 auto;/.test(styleCss));
  assert.ok(/\.inline-prompt-dest\[data-kind="cloud"\] \{\s*color: #e8b04a;/.test(styleCss), 'cloud is warm; the word "cloud" is in the text too');
  assert.ok(/#about-modal #about-copy,\s*#about-modal #about-release-notes \{[^}]*border: 1px solid #4a4a4e/.test(styleCss), 'outlined secondary buttons');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(styleCss.slice(styleCss.indexOf('Help menu (the ? button)'))), 'no emoji');
});

check('about_dialog.js: loading it does nothing (no listener, no DOM access, no timer); no emoji; the only network address is the project', () => {
  const touched = [];
  const sandbox = {
    console,
    document: new Proxy({}, { get(_, prop) { touched.push('document.' + String(prop)); return undefined; } }),
    setTimeout() { touched.push('setTimeout'); },
    addEventListener() { touched.push('window.addEventListener'); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(aboutCode, sandbox);
  assert.deepEqual(touched, [], 'nothing runs at load');
  assert.equal(typeof sandbox.window.AboutDialog.open, 'function');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(aboutCode.replace(/\u2713/g, '')), 'no emoji');
  const urls = Array.from(new Set(aboutCode.match(/https?:\/\/[^'"\s)]+/g) || []));
  assert.deepEqual(urls.sort(), ['https://github.com/youshinh/md-memo', 'https://youshinh.github.io/md-memo/'].sort());
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(aboutCode), 'the module makes no request itself; app.js does the one check');
});

check('Go: backend_getAppInfo is bound once for both platforms and reaches the page as window.backend.getAppInfo with no arguments', () => {
  const common = read('bind_common.go');
  assert.equal((common.match(/w\.Bind\("backend_getAppInfo", app\.GetAppInfo\)/g) || []).length, 1);
  for (const f of ['window_windows.go', 'window_darwin.go']) {
    const src = read(f);
    assert.ok(/getAppInfo: \(\) => window\.backend_getAppInfo\(\),/.test(src), f);
    assert.ok(!/w\.Bind\("backend_getAppInfo"/.test(src), f + ' does not bind it a second time');
  }
  const go = read('app_about.go');
  assert.ok(/func \(a \*App\) GetAppInfo\(\) AppInfo/.test(go));
  const code = go.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/[Aa]pi[Kk]ey|[Tt]oken|[Pp]assword|ReadFile|LoadConfig/.test(code), 'nothing secret can be read by it');
});

check('docs: the manuals and the agent reference name the setting, the menu and the consent line; nothing tells an administrator to edit anything else', () => {
  const en = read('manual.html');
  const ja = read('manual_ja.html');
  for (const [name, doc] of [['manual.html', en], ['manual_ja.html', ja]]) {
    assert.ok(doc.includes('checkUpdates'), name + ' names general.checkUpdates');
    assert.ok(doc.includes('cloudConsent'), name + ' names general.cloudConsent');
    assert.ok(doc.includes('api.github.com'), name + ' says where the request goes');
  }
  assert.ok(/About MD-Memo/.test(en) && /MD-Memo について/.test(ja), 'the dialog is documented in both');
  const ref = read('skills/md-memo/references/interfaces.md');
  assert.ok(ref.includes('checkUpdates') && ref.includes('cloudConsent') && ref.includes('getAppInfo'), 'interfaces.md');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log('  ' + String(e && e.stack ? e.stack : e).split('\n').slice(0, 8).join('\n  '));
  }
}
if (failed) {
  console.log(failed + ' check(s) failed.');
  process.exit(1);
}
console.log('All about / update-check / cloud-consent checks PASSED!');
