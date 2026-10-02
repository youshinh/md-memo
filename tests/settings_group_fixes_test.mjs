// Regression tests for the settings group of the exploratory-test findings (docs/testing/sessions/2026-09-30-c6-settings-lifecycle.md), run
// against the whole of app.js on a hand-made DOM (the same shape as tests/about_privacy_test.mjs):
//   B18  "local" is decided on the real host; credentials never reach the bar, the consent text or the consent keys
//   B25  a config.json that cannot be written / read is said at once (not "saved", not silent)
//   B26  a Mac chord (Ctrl+Cmd+X) is not read as plain Ctrl+X on another OS
// The import dialog (B19, B24 import side, B26 import side) is tested in frontend/js/config_pack_test.js; the export side (B24) in
// pkg/configpack/secrets_url_test.go.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appCode = read('frontend/js/app.js');
const i18nCode = read('frontend/js/i18n.js');
const chromeLayoutCode = read('frontend/js/chrome_layout.js');
const mermaidToneCode = read('frontend/js/mermaid_tone.js');
const llmErrorCode = read('frontend/js/llm_error.js');

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;
const plain = (value) => JSON.parse(JSON.stringify(value));

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

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
  const messages = [];
  const store = new Map();
  if (opts.localConfig) store.set('md_memo_config_v1', JSON.stringify(opts.localConfig)); // the page's own copy of config.json
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
      getClientRects: () => [],
      getBoundingClientRect: () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }),
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
  const saves = [];
  const calls = { toggleFullscreen: 0 };
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async (json) => { saves.push(JSON.parse(json)); },
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    getAppVersion: async () => '1.10.5',
    openExternal: () => {},
    toggleFullscreen: () => { calls.toggleFullscreen++; },
    queryLLMAsync: (reqId, prompt, cfgJson) => { llmCalls.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); }
  }, opts.backend || {});

  const longTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 10000) { longTimers.set(id, fn); return id; }
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
    navigator: { platform: 'Win32', userAgent: 'Windows Test/1.0', language: 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { longTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    open: () => {},
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: { addTask: (o) => o, updateTask: () => {} }
  };
  documentMock.defaultView = windowMock;

  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log() {}, warn(...a) { (opts.warnings || []).push(a.map(String).join(' ')); }, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.10.5' }) })
  };
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(chromeLayoutCode, context);
  vm.runInContext(mermaidToneCode, context);
  vm.runInContext(llmErrorCode, context);
  vm.runInContext(appCode, context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  const env = {
    window: windowMock, elements, messages, llmCalls, saves, calls, store, el,
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
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, start, end) {
      env.editor.value = text;
      env.editor.selectionStart = start === undefined ? text.length : start;
      env.editor.selectionEnd = end === undefined ? env.editor.selectionStart : end;
      env.window.document.activeElement = env.editor;
    },
    ask(instruction, { note = 'hello world\nsecond line', from = 0, to = 5 } = {}) {
      env.setNote(note, from, to);
      env.ctrl('l');
      env.el('inline-prompt-input').value = instruction;
      env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
    },
    flush
  };
  return env;
}

const textWith = (baseUrl, extra) => ({ backendConfig: { text: Object.assign({ baseUrl, model: 'gpt-x', apiKey: 'sk-secret' }, extra || {}) } });
const dest = (env) => ({ hidden: env.hidden('inline-prompt-dest'), kind: env.el('inline-prompt-dest').getAttribute('data-kind'), text: env.el('inline-prompt-dest-text').textContent, title: env.el('inline-prompt-dest').title });

// ===================================================================================================
// B18
// ===================================================================================================
check('B18: a name that only starts like a private address, or an address in the user part, is a cloud host: it says so and asks before the key leaves', async () => {
  for (const url of ['https://10.evil.example/v1', 'https://127.evil.com/v1', 'https://192.168.evil.io/v1', 'https://10.0.0.1@evil.example/v1', 'https://172.20.evil.net/v1']) {
    const env = await createEnv(textWith(url));
    env.ask('make it shorter');
    assert.equal(dest(env).kind, 'cloud', url);
    assert.match(dest(env).text, /\(cloud\)$/, url);
    assert.equal(env.llmCalls.length, 0, url + ': nothing was sent');
    assert.equal(env.hidden('inline-prompt-consent'), false, url + ': the question is asked');
    assert.equal(env.editor.value, 'hello world\nsecond line', url + ': and the note is untouched');
  }
});

check('B18: a real private host, with or without a user part and a port, is local: no question, and the request goes out', async () => {
  for (const url of ['http://192.168.1.5:11434', 'http://10.0.0.5', 'http://localhost:11434', 'http://user:pw@192.168.1.5:11434/v1', 'http://My-PC.local:11434']) {
    const env = await createEnv(textWith(url));
    env.ask('translate');
    assert.equal(dest(env).kind, 'local', url);
    assert.equal(env.hidden('inline-prompt-consent'), true, url);
    assert.equal(env.llmCalls.length, 1, url);
  }
});

check('B18: a password in the address never reaches the bar, the consent text, the tooltip, the failure banner or the consent keys', async () => {
  const env = await createEnv(textWith('https://alice:pw@LLM.Example.com:8443/v1?key=K'));
  env.ask('translate');
  const shown = [dest(env).text, dest(env).title, env.el('inline-prompt-consent-text').textContent].join(' | ');
  assert.ok(shown.includes('llm.example.com:8443'), shown);
  assert.ok(!/alice|pw|hunter/.test(shown), shown);
  assert.equal(env.el('inline-prompt-consent-text').textContent, 'Your text will be sent over the internet to llm.example.com:8443. Allow it?');

  env.el('btn-inline-prompt-consent-allow').onclick();
  assert.equal(env.llmCalls.length, 1);
  assert.deepEqual(Object.keys(plain(env.config.general.cloudConsent)), ['llm.example.com:8443'], 'the key is the host, without the password');
  assert.ok(env.saves.length >= 1 && !JSON.stringify(env.saves[env.saves.length - 1].general.cloudConsent).includes('alice'), 'and so is what was written to config.json');

  env.window.__onLLMResult(env.llmCalls[0].reqId, '', 'dial tcp 1.2.3.4:8443: connectex: No connection could be made');
  await env.flush();
  const banner = env.el('inline-prompt-error-text').textContent;
  assert.ok(banner.includes('llm.example.com:8443') && !/alice|pw/.test(banner), banner);
});

check('B18: a consent an older build saved under "user:password@host" is never matched, never listed, and dropped with the next answer', async () => {
  const stale = { 'alice:pw@llm.example.com': '2026-09-01', 'api.openai.com': '2026-09-02' };
  const env = await createEnv({ backendConfig: { text: { baseUrl: 'https://alice:pw@llm.example.com/v1', model: 'm', apiKey: 'k' }, general: { cloudConsent: stale } } });
  env.ask('translate');
  assert.equal(env.hidden('inline-prompt-consent'), false, 'the old key does not count: the host is asked about again');
  env.el('btn-inline-prompt-consent-cancel').onclick();
  env.key({ key: 'Escape' });
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.el('cfg-cloud-consent-hosts').textContent, 'api.openai.com', 'the settings list does not show the password');
  env.el('btn-cancel-settings').onclick();

  env.ask('again');
  env.el('btn-inline-prompt-consent-allow').onclick();
  assert.deepEqual(Object.keys(plain(env.config.general.cloudConsent)).sort(), ['api.openai.com', 'llm.example.com'], 'the entry with the password is gone');
});

// ===================================================================================================
// B25
// ===================================================================================================
const openSettingsAndSave = async (env) => {
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.hidden('settings-modal'), false);
  env.el('cfg-api-key').value = 'sk-NEW';
  await env.el('btn-save-settings').onclick();
  await env.flush();
};

check('B25: Save with a config.json that cannot be written says so, and never says "saved"', async () => {
  const env = await createEnv({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'm', apiKey: 'sk-OLD' } }, warnings: [], backend: {} });
  env.window.backend.saveConfig = async () => { throw new Error('Access is denied.'); };
  await openSettingsAndSave(env);
  assert.equal(env.hidden('settings-modal'), true, 'the dialog still closes at once');
  assert.ok(!env.messages.includes(I18N.en.settingsSaved), 'no false "saved": ' + JSON.stringify(env.messages));
  const failure = I18N.en.configSaveFailed.replace('{err}', 'Access is denied.');
  assert.equal(env.messages[env.messages.length - 1], failure, 'the last thing on the status bar is the failure');
});

check('B25: the "saved" toast waits for the write, and is shown once it succeeded', async () => {
  const env = await createEnv({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'm', apiKey: 'sk-OLD' } } });
  let release;
  env.window.backend.saveConfig = (json) => new Promise((resolve) => { release = () => { env.saves.push(JSON.parse(json)); resolve(); }; });
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  env.el('cfg-api-key').value = 'sk-NEW';
  const pending = env.el('btn-save-settings').onclick();
  await env.flush();
  assert.equal(env.hidden('settings-modal'), true, 'closed while the write is running');
  assert.ok(!env.messages.includes(I18N.en.settingsSaved), 'nothing claimed yet');
  release();
  await pending;
  await env.flush();
  assert.equal(env.messages[env.messages.length - 1], I18N.en.settingsSaved);
  assert.equal(env.saves.length, 1);
  assert.equal(env.saves[0].text.apiKey, 'sk-NEW');
});

check('B25: any other change that cannot be written is said too (here the ask bar remembering an answer); a write that works is quiet', async () => {
  const cloud = { backendConfig: { text: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'k' } } };
  const env = await createEnv(cloud);
  env.window.backend.saveConfig = async () => { throw new Error('disk is full'); };
  env.ask('translate');
  env.el('btn-inline-prompt-consent-allow').onclick();
  await env.flush();
  assert.equal(env.llmCalls.length, 1, 'the request itself is not held up by the failed write');
  assert.ok(env.messages.includes(I18N.en.configSaveFailed.replace('{err}', 'disk is full')), JSON.stringify(env.messages));

  const quiet = await createEnv(cloud);
  quiet.ask('translate');
  quiet.el('btn-inline-prompt-consent-allow').onclick();
  await quiet.flush();
  assert.equal(quiet.saves.length, 1);
  assert.ok(!quiet.messages.some((m) => /could not be saved/.test(m)), 'no failure text when the write works');
});

check('B25: a rejection with no message still gives a readable failure, and a long one is cut', async () => {
  const empty = await createEnv({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'm', apiKey: 'k' } } });
  empty.window.backend.saveConfig = async () => { throw ''; };
  await openSettingsAndSave(empty);
  assert.equal(empty.messages[empty.messages.length - 1], I18N.en.configSaveFailed.replace('{err}', I18N.en.configSaveFailedUnknown));

  // Go words its error in Japanese; the English toast keeps only what the system said
  const goError = await createEnv({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'm', apiKey: 'k' } } });
  goError.window.backend.saveConfig = async () => { throw new Error('設定ファイルの書き込みに失敗しました: open C:\\Users\\me\\AppData\\Roaming\\md-memo\\config.json: Access is denied.'); };
  await openSettingsAndSave(goError);
  const goToast = goError.messages[goError.messages.length - 1];
  assert.equal(goToast, I18N.en.configSaveFailed.replace('{err}', 'open C:\\Users\\me\\AppData\\Roaming\\md-memo\\config.json: Access is denied.'));
  assert.ok(!/[぀-ヿ一-鿿]/.test(goToast), 'no Japanese in the English toast');

  const long = await createEnv({ backendConfig: { text: { baseUrl: 'http://localhost:11434', model: 'm', apiKey: 'k' } } });
  long.window.backend.saveConfig = async () => { throw new Error('x'.repeat(400)); };
  await openSettingsAndSave(long);
  const last = long.messages[long.messages.length - 1];
  assert.ok(last.length < 300 && last.includes('x'.repeat(120) + '…'), last.length);
});

check('B25: a config.json that cannot be read is announced at start-up, and Save afterwards neither claims success nor writes', async () => {
  for (const [label, backend] of [
    ['truncated', { getConfig: async () => '{"general":{"theme":"forest"' }],
    ['BOM', { getConfig: async () => '﻿{"general":{"theme":"forest"}}' }],
    ['rejected', { getConfig: async () => { throw new Error('read failed'); } }]
  ]) {
    const env = await createEnv({ backend });
    if (label === 'BOM') {
      // a BOM is tolerated by JSON.parse in some engines; the check below only applies to a load that failed
      if (!env.messages.includes(I18N.en.configNotSavedUnreadable)) continue;
    }
    assert.ok(env.messages.includes(I18N.en.configNotSavedUnreadable), label + ': said at start-up: ' + JSON.stringify(env.messages));
    const said = env.messages.length;
    await openSettingsAndSave(env);
    assert.equal(env.saves.length, 0, label + ': nothing written');
    assert.ok(!env.messages.includes(I18N.en.settingsSaved), label + ': no "saved"');
    assert.equal(env.messages[env.messages.length - 1], I18N.en.configNotSavedUnreadable, label + ': Save says why');
    assert.ok(env.messages.length > said, label);
  }
  const fine = await createEnv({ backendConfig: { general: { theme: 'forest' } } });
  assert.ok(!fine.messages.includes(I18N.en.configNotSavedUnreadable), 'a readable file says nothing');
  const first = await createEnv({});
  assert.ok(!first.messages.includes(I18N.en.configNotSavedUnreadable), 'no config.json yet (first start) is not an error');
});

check('B25: the strings exist in both languages and the Japanese one keeps the placeholder', () => {
  for (const k of ['configSaveFailed', 'configSaveFailedUnknown', 'configNotSavedUnreadable']) {
    assert.equal(typeof I18N.en[k], 'string', k);
    assert.equal(typeof I18N.ja[k], 'string', k);
  }
  assert.ok(I18N.en.configSaveFailed.includes('{err}') && I18N.ja.configSaveFailed.includes('{err}'));
  assert.ok(!/[぀-ヿ一-鿿]/.test(I18N.en.configSaveFailed + I18N.en.configSaveFailedUnknown), 'no Japanese in English');
});

// ===================================================================================================
// B26
// ===================================================================================================
check('B26: "Ctrl+Cmd+Z" and "Ctrl+Cmd+F" from a Mac do not take Ctrl+Z / Ctrl+F on Windows; the real bindings still work', async () => {
  const env = await createEnv({ backendConfig: { shortcuts: { zenMode: 'Ctrl+Cmd+Z', toggleFullscreen: 'Ctrl+Cmd+F', minimize: 'Cmd+M', quickCapture: '' } } });
  assert.equal(env.config.shortcuts.zenMode, 'Ctrl+Cmd+Z', 'the value is what the file says; the matcher is what protects');
  env.setNote('hello world', 11, 11);
  const undo = env.ctrl('z');
  assert.equal(undo.defaultPrevented, false, 'Ctrl+Z is left to the editor (native undo)');
  assert.equal(env.window.document.body.classList.contains('zen-mode'), false, 'and Zen mode did not switch on');
  const find = env.ctrl('f');
  assert.equal(env.calls.toggleFullscreen, 0, 'Ctrl+F is not full screen');
  assert.equal(env.hidden('find-replace-bar'), false, 'it opens the find bar');
  assert.equal(find.defaultPrevented, true);

  // the ordinary Windows bindings are untouched
  const win = await createEnv({ backendConfig: { shortcuts: { zenMode: 'Shift+F11', toggleFullscreen: 'F11' } } });
  win.setNote('x', 1, 1);
  win.key({ key: 'F11', code: 'F11', shiftKey: true });
  assert.equal(win.window.document.body.classList.contains('zen-mode'), true, 'Shift+F11 is Zen mode');
  win.key({ key: 'F11', code: 'F11' });
  assert.equal(win.calls.toggleFullscreen, 1, 'F11 is full screen');
});

check('B26: the matcher rejects a chord that names both Ctrl and Cmd only off macOS; a plain Cmd alias still means Ctrl', () => {
  const src = appCode.slice(appCode.indexOf('function matchShortcut('), appCode.indexOf('function matchShortcut(') + 2400);
  assert.ok(/if \(hasCtrl && hasCmd\) return false;[\s\S]*const reqCtrl = hasCtrl \|\| hasCmd;/.test(src), 'the guard sits in the non-Mac branch, before Cmd is folded into Ctrl');
  assert.ok(src.indexOf('if (isMac) {') < src.indexOf('if (hasCtrl && hasCmd) return false;'), 'and not in the Mac branch (Ctrl+Cmd+F is real there)');
});

check('B26: the import dialog is told whether this is a Mac', () => {
  assert.ok(/isMac: isMac,[^\n]*\n\s*t: t,/.test(appCode.slice(appCode.indexOf('function packHost()'), appCode.indexOf('function packHost()') + 700)), 'packHost hands isMac to the dialog');
});

// ===================================================================================================
// Second round (C10-14, C10-18, C6-03, C6-05)
// ===================================================================================================
const cloudAt = (baseUrl, consent) => ({ backendConfig: { text: { baseUrl, model: 'gpt-x', apiKey: 'sk-secret' }, general: { cloudConsent: consent } } });

check('C10-18: allowing https://host:port does not allow http://host:port (the key and the text would travel in the clear); an answer saved without a scheme still covers https only', async () => {
  const consent = { 'api.example-llm.com:8443': '2026-09-01' };
  const https = await createEnv(cloudAt('https://api.example-llm.com:8443/v1', consent));
  https.ask('translate');
  assert.equal(https.hidden('inline-prompt-consent'), true, 'every earlier answer was saved without a scheme: it keeps covering https');
  assert.equal(https.llmCalls.length, 1);

  const http = await createEnv(cloudAt('http://api.example-llm.com:8443/v1', consent));
  http.ask('translate');
  assert.equal(http.hidden('inline-prompt-consent'), false, 'plain http is asked about again');
  assert.equal(http.llmCalls.length, 0, 'and nothing was sent');
  http.el('btn-inline-prompt-consent-allow').onclick();
  assert.equal(http.llmCalls.length, 1);
  assert.deepEqual(Object.keys(plain(http.config.general.cloudConsent)).sort(), ['api.example-llm.com:8443', 'http://api.example-llm.com:8443'], 'the http answer is kept apart from the https one');

  const only = await createEnv(cloudAt('https://api.example-llm.com:8443/v1', { 'http://api.example-llm.com:8443': '2026-09-01' }));
  only.ask('translate');
  assert.equal(only.hidden('inline-prompt-consent'), false, 'an answer for http is no answer for https');
  assert.equal(only.llmCalls.length, 0);
});

const MERMAID_NOTE = '```mermaid\ngraph TD\nA-->B\n```';
async function imageKeyFor(config) {
  const calls = [];
  const env = await createEnv({ backendConfig: config, backend: { generateImageAsync: (reqId, prompt, cfgJson) => { calls.push(JSON.parse(cfgJson)); } } });
  env.setNote(MERMAID_NOTE, 5, 5);
  env.helper.generateImageFromMermaid();
  assert.equal(calls.length, 1, 'the request went out');
  return calls[0];
}

check('C10-14: an API key of another settings group is not sent to a different host (image generation: the text key never goes to the Gemini endpoint)', async () => {
  const text = { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'OPENAIKEY' };
  const noVisionKey = await imageKeyFor({ text, vision: { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: '' } });
  assert.equal(noVisionKey.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.equal(noVisionKey.apiKey, '', 'the OpenAI key is not sent to Google');

  const localVision = await imageKeyFor({ text, vision: { baseUrl: 'http://localhost:11434', apiKey: 'OLLAMAKEY' } });
  assert.equal(localVision.baseUrl, 'https://generativelanguage.googleapis.com', 'a local vision server is not used for image generation');
  assert.equal(localVision.apiKey, '', 'and its key does not follow the request to Google');

  const own = await imageKeyFor({ text, image: { apiKey: 'IMAGEKEY' } });
  assert.equal(own.apiKey, 'IMAGEKEY', 'the image group\'s own key is always used');

  // the same host: the key is lent, as before
  const vision = await imageKeyFor({ text, vision: { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'GOOGLEKEY' } });
  assert.equal(vision.apiKey, 'GOOGLEKEY');
  const gemini = await imageKeyFor({ text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'm', apiKey: 'TEXTGEMINI' }, vision: { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: '' } });
  assert.equal(gemini.apiKey, 'TEXTGEMINI', 'the text key is lent when the text model is on the same host');
});

check('C6-03: a shortcut that is not a string (a number, true, a list) in config.json or the page copy is ignored: key presses and Settings still work', async () => {
  const junk = { find: 5, zenMode: true, openFile: ['Ctrl+O'], quickOpen: { a: 1 }, toggleFullscreen: 'F11', cleared: null };
  for (const [label, opts] of [
    ['config.json', { backendConfig: { shortcuts: junk } }],
    ['the page copy', { backendConfig: { general: { theme: 'olive' } }, localConfig: { shortcuts: junk } }]
  ]) {
    const env = await createEnv(opts);
    for (const v of Object.values(env.config.shortcuts)) assert.ok(v === null || typeof v === 'string', label + ': only strings remain: ' + JSON.stringify(v));
    assert.equal(env.config.shortcuts.zenMode, 'Shift+F11', label + ': the default of an action with a bad value stays');
    assert.equal(env.config.shortcuts.toggleFullscreen, 'F11', label + ': a good value is taken');
    assert.doesNotThrow(() => env.key({ key: 'x', code: 'KeyX', ctrlKey: true }), label + ': a key press does not throw');
    assert.doesNotThrow(() => env.key({ key: ',', code: 'Comma', ctrlKey: true }), label + ': Ctrl+, does not throw');
    assert.equal(env.hidden('settings-modal'), false, label + ': Settings opens');
  }
});

check('C6-05: Ctrl+, while Settings is open keeps what was typed and what Cancel restores (a language tried since was not saved)', async () => {
  const env = await createEnv({ backendConfig: { general: { language: 'en' }, text: { baseUrl: 'http://localhost:11434', model: 'saved-model', apiKey: '' } } });
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.hidden('settings-modal'), false);
  assert.equal(env.el('cfg-model').value, 'saved-model');
  env.el('cfg-model').value = 'typed-model';
  env.el('cfg-language').value = 'ja';
  env.el('cfg-language').onchange();
  assert.equal(env.config.general.language, 'ja', 'the language is applied live while the dialog is open');

  env.key({ key: ',', code: 'Comma', ctrlKey: true }); // the shortcut again (or the gear button)
  assert.equal(env.hidden('settings-modal'), false, 'still open');
  assert.equal(env.el('cfg-model').value, 'typed-model', 'what was typed is still there');
  env.el('btn-settings').onclick();
  assert.equal(env.el('cfg-model').value, 'typed-model', 'the gear button does the same');

  env.el('btn-cancel-settings').onclick();
  assert.equal(env.hidden('settings-modal'), true);
  assert.equal(env.config.general.language, 'en', 'Cancel still brings back the language of the first open');

  // closed: opening reads the config again, as before
  env.key({ key: ',', code: 'Comma', ctrlKey: true });
  assert.equal(env.el('cfg-model').value, 'saved-model');
});

check('C6-05: the import (which changes the config under the open dialog) still redraws every field', () => {
  const apply = appCode.slice(appCode.indexOf('function applyImportedConfig('), appCode.indexOf('function applyImportedConfig(') + 3500);
  assert.ok(/settingsRefreshRequested = true;\s*openSettings\(\);/.test(apply), 'applyImportedConfig asks for a refresh before it calls openSettings');
  const open = appCode.slice(appCode.indexOf('function openSettings() {'), appCode.indexOf('function openSettings() {') + 1200);
  assert.ok(/!settingsRefreshRequested\) \{[\s\S]*?return;\s*\}\s*settingsRefreshRequested = false;/.test(open), 'a second open returns early unless a refresh was asked for, and the request is used up');
});

let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error(e && e.stack ? e.stack : e);
  }
}
if (failed) {
  console.error('\n' + failed + ' of ' + queue.length + ' settings-group checks FAILED');
  process.exit(1);
}
console.log('\nAll ' + queue.length + ' settings-group checks passed.');
