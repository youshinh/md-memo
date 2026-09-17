import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log('=== Evaluation Driven Testing for Git Sync Disabled State ===');

const i18nCode = fs.readFileSync(path.resolve('frontend/js/i18n.js'), 'utf-8');
const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

function createDOMEnvironment() {
  const elements = new Map();
  const windowListeners = new Map();

  function createMockElement(id, tagName = 'div') {
    const classList = new Set();
    const style = {};
    const dataset = {};
    let innerHTML = '';
    let textContent = '';
    let value = '';
    let title = '';

    const el = {
      id: id || '',
      tagName: tagName.toUpperCase(),
      dataset,
      style,
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      offsetHeight: 500,
      offsetWidth: 500,
      onclick: null,
      onload: null,
      classList: {
        add: (...cls) => cls.forEach(c => classList.add(c)),
        remove: (...cls) => cls.forEach(c => classList.delete(c)),
        toggle: (c, force) => {
          if (force !== undefined) {
            if (force) classList.add(c); else classList.delete(c);
            return force;
          }
          if (classList.has(c)) { classList.delete(c); return false; }
          classList.add(c); return true;
        },
        contains: (c) => classList.has(c)
      },
      get className() { return Array.from(classList).join(' '); },
      set className(v) {
        classList.clear();
        if (v) v.split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
      },
      get innerHTML() { return innerHTML; },
      set innerHTML(v) {
        innerHTML = v;
        textContent = v;
      },
      get textContent() { return textContent; },
      set textContent(v) {
        textContent = String(v);
        innerHTML = String(v);
      },
      get value() { return value; },
      set value(v) { value = String(v); },
      get title() { return title; },
      set title(v) { title = String(v); },
      focus: () => {},
      blur: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (child) => child,
      removeChild: (child) => child,
      insertBefore: (newNode) => newNode,
      setAttribute: (k, v) => { el[k] = v; },
      getAttribute: (k) => el[k] || null,
      removeAttribute: (k) => { delete el[k]; }
    };

    if (id) elements.set(id, el);
    return el;
  }

  const documentMock = {
    documentElement: createMockElement('html'),
    activeElement: null,
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) || createMockElement(id),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements.get(sel.slice(1)) || createMockElement(sel.slice(1));
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => createMockElement(null, tag),
    body: createMockElement('body'),
    head: createMockElement('head'),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  let triggerGitSyncCalled = false;
  let lastToastMessage = null;

  const windowMock = {
    document: documentMock,
    backend: {
      getLocale: async () => 'ja',
      getPlatform: async () => 'windows',
      loadConfig: async () => '{}',
      saveConfig: async () => {},
      loadSession: async () => '{}',
      saveSession: async () => {},
      openExternal: () => {},
      triggerGitSync: () => {
        triggerGitSyncCalled = true;
      }
    },
    localStorage: {
      _data: {},
      getItem: (k) => windowMock.localStorage._data[k] || null,
      setItem: (k, v) => { windowMock.localStorage._data[k] = String(v); },
      removeItem: (k) => { delete windowMock.localStorage._data[k]; }
    },
    navigator: { platform: 'Win32', userAgent: 'Windows' },
    addEventListener: (evt, handler) => {
      if (!windowListeners.has(evt)) windowListeners.set(evt, []);
      windowListeners.get(evt).push(handler);
    },
    removeEventListener: () => {},
    trigger: (evt, eventObj = {}) => {
      if (windowListeners.has(evt)) {
        for (const handler of windowListeners.get(evt)) {
          handler(eventObj);
        }
      }
    }
  };

  return {
    elements,
    document: documentMock,
    window: windowMock,
    getTriggerGitSyncCalled: () => triggerGitSyncCalled,
    resetTriggerGitSyncCalled: () => { triggerGitSyncCalled = false; },
    getLastToast: () => lastToastMessage,
    setLastToast: (msg) => { lastToastMessage = msg; }
  };
}

const env = createDOMEnvironment();
const context = {
  window: env.window,
  document: env.document,
  navigator: env.window.navigator,
  localStorage: env.window.localStorage,
  console,
  setTimeout: (cb) => { cb(); return 1; },
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: (cb) => { cb(); return 1; },
  cancelAnimationFrame: () => {},
  Blob: class {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => '' }
};

vm.createContext(context);
vm.runInContext(i18nCode + '; this.I18N = I18N;', context);
vm.runInContext(appCode, context);

// 1. Verify i18n keys
assert(context.I18N.ja.gitSyncDisabledToast, 'JA gitSyncDisabledToast must exist');
assert(context.I18N.en.gitSyncDisabledToast, 'EN gitSyncDisabledToast must exist');
assert(context.I18N.ja.gitSyncStatusDisabled, 'JA gitSyncStatusDisabled must exist');
assert(context.I18N.en.gitSyncStatusDisabled, 'EN gitSyncStatusDisabled must exist');
assert(context.I18N.ja.gitSyncEnabledHint, 'JA gitSyncEnabledHint must exist');
assert(context.I18N.en.gitSyncEnabledHint, 'EN gitSyncEnabledHint must exist');
console.log('PASS: i18n keys for Git sync disabled & hints exist');

const statGitSync = env.elements.get('stat-gitsync');
assert(statGitSync, 'stat-gitsync element must exist');

const { config, applyLanguage, updateGitSyncStatusUI } = context.window.__testHelper;

// Set language to JA
config.general.language = 'ja';
applyLanguage();

// Test 1: Enabled state
config.scraps.gitSyncEnabled = true;
config.git_sync_enabled = true;
context.window.onGitSyncStatus({ status: 'synced', message: 'Up to date' });

assert.strictEqual(statGitSync.classList.contains('status-disabled'), false);
assert.strictEqual(statGitSync.textContent, 'Git: Synced');
assert.strictEqual(statGitSync.style.opacity, '1');
console.log('PASS: Enabled state correctly sets Synced and opacity 1');

// On click when enabled triggers sync
env.resetTriggerGitSyncCalled();
statGitSync.onclick();
assert.strictEqual(env.getTriggerGitSyncCalled(), true, 'triggerGitSync must be called when enabled');
console.log('PASS: Clicking stat-gitsync triggers sync when enabled');

// Test 2: Disable Git sync
config.scraps.gitSyncEnabled = false;
config.git_sync_enabled = false;
updateGitSyncStatusUI();

assert.strictEqual(statGitSync.classList.contains('status-disabled'), true);
assert.strictEqual(statGitSync.textContent, 'Git: 無効');
assert.strictEqual(statGitSync.style.opacity, '0.55');
console.log('PASS: Disabling Git sync grays out badge, adds status-disabled, and sets text "Git: 無効"');

// Test 3: Clicking when disabled does NOT trigger sync
env.resetTriggerGitSyncCalled();
statGitSync.onclick();
assert.strictEqual(env.getTriggerGitSyncCalled(), false, 'triggerGitSync must NOT be called when disabled');
console.log('PASS: Clicking stat-gitsync does NOT trigger sync when disabled');

// Test 4: Re-enabling Git sync
config.scraps.gitSyncEnabled = true;
config.git_sync_enabled = true;
context.window.onGitSyncStatus({ status: 'synced', message: 'Synced at 12:00' });

assert.strictEqual(statGitSync.classList.contains('status-disabled'), false);
assert.strictEqual(statGitSync.textContent, 'Git: Synced');
assert.strictEqual(statGitSync.style.opacity, '1');
console.log('PASS: Re-enabling Git sync restores status to normal');

// Test 5: Switch to English when disabled
config.scraps.gitSyncEnabled = false;
config.git_sync_enabled = false;
config.general.language = 'en';
applyLanguage();

assert.strictEqual(statGitSync.textContent, 'Git: Disabled');
console.log('PASS: Language toggle dynamically updates disabled badge to English ("Git: Disabled")');

console.log('All Git sync disabled evaluation tests passed with 0 error(s)!');
