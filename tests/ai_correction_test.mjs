import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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
        textContent = v;
        innerHTML = v;
      },
      get value() { return value; },
      set value(v) {
        value = v;
      },
      get title() { return title; },
      set title(v) { title = v; },
      addEventListener: (evt, fn) => {
        if (!el._listeners) el._listeners = new Map();
        if (!el._listeners.has(evt)) el._listeners.set(evt, []);
        el._listeners.get(evt).push(fn);
      },
      removeEventListener: () => {},
      focus: () => { documentMock.activeElement = el; },
      blur: () => {},
      setSelectionRange: (start, end) => {
        el.selectionStart = start;
        el.selectionEnd = end;
      },
      appendChild: (child) => {
        if (!el.children) el.children = [];
        el.children.push(child);
        child.parentElement = el;
        return child;
      },
      insertBefore: (newNode, refNode) => {
        if (!el.children) el.children = [];
        const idx = el.children.indexOf(refNode);
        if (idx !== -1) el.children.splice(idx, 0, newNode);
        else el.children.push(newNode);
        newNode.parentElement = el;
        return newNode;
      },
      querySelector: (sel) => {
        if (sel.startsWith('#')) return elements.get(sel.slice(1)) || null;
        return null;
      },
      querySelectorAll: () => [],
      getAttribute: (name) => {
        if (name === 'data-i18n') return dataset.i18n || null;
        return null;
      },
      setAttribute: (name, val) => {
        if (name === 'data-i18n') dataset.i18n = val;
      }
    };
    return el;
  }

  const ids = [
    'tabs-list', 'btn-new-tab', 'btn-open-file', 'btn-open-folder', 'btn-save-file',
    'btn-toggle-preview', 'btn-toggle-split', 'btn-preview-side', 'btn-find',
    'btn-header-llm', 'btn-settings', 'workspace', 'editor-pane', 'preview-pane',
    'editor', 'cursor-aura', 'line-numbers', 'pane-resizer', 'secondary-pane',
    'editor-secondary', 'preview-secondary', 'line-numbers-secondary', 'secondary-pane-title',
    'btn-close-secondary', 'btn-sync-scroll', 'btn-toggle-pane-mode', 'btn-swap-panes',
    'stat-cursor', 'stat-chars', 'stat-selection', 'stat-autosave', 'stat-encoding',
    'stat-autocomplete', 'stat-ime', 'stat-ambient-container', 'stat-message',
    'stat-llm-indicator', 'stat-llm-text', 'ghost-overlay', 'context-menu',
    'find-replace-bar', 'find-input', 'replace-input', 'find-count',
    'btn-toggle-replace', 'btn-find-prev', 'btn-find-next', 'btn-find-close',
    'btn-replace-one', 'btn-replace-all', 'chk-find-case', 'chk-find-regex',
    'chk-find-word', 'goto-line-modal', 'goto-line-input', 'btn-goto-confirm',
    'btn-goto-cancel', 'modal-goto-close', 'quick-pick-modal', 'quick-pick-input',
    'quick-pick-list', 'llm-modal', 'llm-prompt', 'llm-target-text',
    'btn-llm-send', 'btn-llm-cancel', 'modal-llm-close', 'chk-llm-replace-selection',
    'settings-modal', 'modal-close', 'btn-save-settings', 'btn-cancel-settings',
    'cfg-base-url', 'cfg-model', 'cfg-api-key', 'cfg-system-prompt',
    'cfg-auto-enabled', 'cfg-auto-base-url', 'cfg-auto-model', 'cfg-auto-api-key',
    'cfg-auto-delay', 'cfg-auto-tokens', 'cfg-vision-base-url', 'cfg-vision-model',
    'cfg-vision-api-key', 'cfg-vision-prompt', 'cfg-theme', 'cfg-language',
    'cfg-restore-session', 'cfg-autosave', 'cfg-paste-image-ocr', 'cfg-ime-guardian',
    'cfg-ai-correction', 'cfg-cursor-aura', 'cfg-tray-resident', 'shortcuts-table-body',
    'btn-reset-shortcuts', 'tab-btn-text-llm', 'tab-btn-autocomplete', 'tab-btn-vision-llm',
    'tab-btn-general', 'tab-btn-text', 'tab-btn-image', 'tab-btn-shortcuts',
    'pane-text-llm', 'pane-autocomplete', 'pane-vision-llm', 'pane-general',
    'pane-text', 'pane-image', 'pane-shortcuts',
    'cfg-image-model', 'cfg-image-aspect-ratio', 'cfg-image-resolution',
    'inline-prompt-bar', 'inline-prompt-input', 'btn-inline-prompt-send', 'btn-inline-prompt-close'
  ];

  for (const id of ids) {
    const tagName = (id === 'editor' || id === 'editor-secondary') ? 'textarea' : 'div';
    elements.set(id, createMockElement(id, tagName));
  }

  const documentMock = {
    getElementById: (id) => {
      let el = elements.get(id);
      if (!el) {
        el = createMockElement(id);
        elements.set(id, el);
      }
      return el;
    },
    querySelector: (sel) => {
      if (sel.startsWith('#')) return documentMock.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => createMockElement('', tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: (cmd, _, text) => {
      if (cmd === 'insertText') {
        const activeEd = elements.get('editor');
        const start = activeEd.selectionStart;
        const end = activeEd.selectionEnd;
        activeEd.value = activeEd.value.substring(0, start) + text + activeEd.value.substring(end);
        activeEd.selectionStart = start + text.length;
        activeEd.selectionEnd = start + text.length;
        return true;
      }
      return false;
    },
    activeElement: elements.get('editor'),
    hasFocus: () => true,
    documentElement: { lang: 'en' },
    body: { classList: elements.get('workspace').classList }
  };

  const localStorageStore = new Map();
  const localStorageMock = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
    clear: () => localStorageStore.clear()
  };

  let lastSentQuery = null;

  const backendMock = {
    getConfig: async () => JSON.stringify({ general: { language: 'ja' } }),
    saveConfig: async () => {},
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    openFile: async () => null,
    saveFile: async () => ({ success: true }),
    saveFileAs: async () => ({ success: true }),
    trimMemory: async () => {},
    queryLLMAsync: (reqId, prompt, configJson) => {
      lastSentQuery = { reqId, prompt, configJson };
    }
  };

  // Short timeouts fire synchronously so the tests stay deterministic. Long guard
  // timers (>= 10s, e.g. the LLM watchdog) are parked so they don't fire on their
  // own; a test can fire one deliberately via __fireLongTimers().
  const longTimers = new Map();
  let timerSeq = 0;

  const windowMock = {
    document: documentMock,
    localStorage: localStorageMock,
    backend: backendMock,
    addEventListener: (evt, fn) => {
      if (!windowListeners.has(evt)) windowListeners.set(evt, []);
      windowListeners.get(evt).push(fn);
    },
    removeEventListener: () => {},
    setTimeout: (fn, ms) => {
      const id = ++timerSeq;
      if (typeof ms === 'number' && ms >= 10000) {
        longTimers.set(id, fn);
        return id;
      }
      fn();
      return id;
    },
    clearTimeout: (id) => { longTimers.delete(id); },
    __longTimerCount: () => longTimers.size,
    __fireLongTimers: () => {
      const fns = Array.from(longTimers.values());
      longTimers.clear();
      fns.forEach(fn => fn());
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    navigator: { platform: 'Win32', userAgent: 'Windows' },
    getLastSentQuery: () => lastSentQuery
  };

  return { windowMock, elements, documentMock };
}

function runEnvironment() {
  const { windowMock, elements, documentMock } = createDOMEnvironment();
  const context = {
    window: windowMock,
    document: windowMock.document,
    localStorage: windowMock.localStorage,
    navigator: windowMock.navigator,
    setTimeout: windowMock.setTimeout,
    clearTimeout: windowMock.clearTimeout,
    requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(appCode, context);
  return { context, elements, window: windowMock, documentMock };
}

console.log('=== Evaluation Driven Testing for AI Typo Correction ===');

// Test 1: Japanese Typo Correction & Prompt Adaptation
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  editor.value = '今日はいい天気で、お昼ごはんにラーメソを食べました。';
  editor.selectionStart = 0;
  editor.selectionEnd = editor.value.length;

  context.window.__testHelper.triggerAICorrection();

  const sentQuery = window.getLastSentQuery();
  assert.ok(sentQuery, 'LLM query was dispatched');
  assert.ok(sentQuery.prompt.includes('以下のテキストの誤字・脱字'), 'Prompt is in Japanese for Japanese text');
  assert.ok(sentQuery.prompt.includes('ラーメソ'), 'Prompt includes target text');

  const corrected = '今日はいい天気で、お昼ごはんにラーメンを食べました。';
  context.window.__onLLMResult(sentQuery.reqId, corrected, '');

  assert.equal(editor.value, corrected, 'Editor text successfully replaced with corrected text');
  console.log('PASS: Test 1 (Japanese Typo Correction & Prompt)');
}

// Test 2: English Typo Correction & Prompt Adaptation
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  editor.value = 'Thiss is an exampel of a sentance with typoo.';
  editor.selectionStart = 0;
  editor.selectionEnd = editor.value.length;

  context.window.__testHelper.triggerAICorrection();

  const sentQuery = window.getLastSentQuery();
  assert.ok(sentQuery, 'LLM query was dispatched for English text');
  assert.ok(sentQuery.prompt.includes('Fix all typos, spelling errors'), 'Prompt is in English for English text');
  assert.ok(sentQuery.prompt.includes('exampel'), 'Prompt includes English target text');

  const corrected = 'This is an example of a sentence with typo.';
  context.window.__onLLMResult(sentQuery.reqId, corrected, '');

  assert.equal(editor.value, corrected, 'English text successfully corrected');
  console.log('PASS: Test 2 (English Typo Correction & Prompt)');
}

// Test 3: Zero Data Loss on Empty Response (Rollback to Original Text)
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  const original = 'Critical note content that must never be deleted.';
  editor.value = original;
  editor.selectionStart = 0;
  editor.selectionEnd = original.length;

  context.window.__testHelper.triggerAICorrection();
  const sentQuery = window.getLastSentQuery();

  // Simulate LLM returning an empty string
  context.window.__onLLMResult(sentQuery.reqId, '', '');

  assert.equal(editor.value, original, 'Original text was 100% restored when LLM returned empty string!');

  // Simulate LLM returning only whitespace
  context.window.__testHelper.triggerAICorrection();
  const sentQuery2 = window.getLastSentQuery();
  context.window.__onLLMResult(sentQuery2.reqId, '   \n\n  \t ', '');

  assert.equal(editor.value, original, 'Original text was 100% restored when LLM returned whitespace!');
  console.log('PASS: Test 3 (Zero Data Loss on Empty Response)');
}

// Test 4: Zero Data Loss on API Error (Rollback to Original Text)
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  const original = 'Important business meeting notes 2026-09-13.';
  editor.value = original;
  editor.selectionStart = 0;
  editor.selectionEnd = original.length;

  context.window.__testHelper.triggerAICorrection();
  const sentQuery = window.getLastSentQuery();

  // Simulate network timeout or 500 internal server error
  context.window.__onLLMResult(sentQuery.reqId, '', '500 Internal Server Error: Model overloaded');

  assert.equal(editor.value, original, 'Original text was 100% restored when API returned error!');
  assert.ok(!editor.value.includes('500 Internal Server Error'), 'Editor was not overwritten with error text');
  console.log('PASS: Test 4 (Zero Data Loss on API Error)');
}

// Test 5: DeepSeek R1 <think> Tag Cleansing
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  editor.value = 'User typed teh following text.';
  editor.selectionStart = 0;
  editor.selectionEnd = editor.value.length;

  context.window.__testHelper.triggerAICorrection();
  const sentQuery = window.getLastSentQuery();

  // Simulate DeepSeek-R1 output with <think> reasoning process
  const r1Output = '<think>\nThe user made a typo "teh". I will replace it with "the".\n</think>\nUser typed the following text.';
  context.window.__onLLMResult(sentQuery.reqId, r1Output, '');

  assert.equal(editor.value, 'User typed the following text.', 'Thinking process tags were stripped cleanly');
  console.log('PASS: Test 5 (DeepSeek R1 <think> Tag Cleansing)');
}

// Test 6: Conversational Filler & Markdown Fence Stripping
{
  const { context, elements, window } = runEnvironment();
  const editor = elements.get('editor');
  editor.value = 'Fix mee please';
  editor.selectionStart = 0;
  editor.selectionEnd = editor.value.length;

  context.window.__testHelper.triggerAICorrection();
  const sentQuery = window.getLastSentQuery();

  // Simulate LLM returning with markdown quote and intro
  const fillerOutput = 'Here is the corrected text:\n```markdown\nFix me please\n```';
  context.window.__onLLMResult(sentQuery.reqId, fillerOutput, '');

  assert.equal(editor.value, 'Fix me please', 'Conversational intro and fences were stripped');
  console.log('PASS: Test 6 (Conversational Filler & Markdown Fence Stripping)');
}

// --- Non-obstruction of an arriving result (replaceAnchorWithUndo) ---
// The anchor string is i18n-dependent, so read it back out of the note.
function startCorrectionOnLine(env, text, lineStart, lineEnd) {
  const editor = env.elements.get('editor');
  editor.value = text;
  editor.selectionStart = lineStart;
  editor.selectionEnd = lineEnd;
  env.context.window.__testHelper.triggerAICorrection();
  const m = editor.value.match(/\[[^\]\n]*\]/);
  assert.ok(m, 'an in-flight anchor was inserted into the note');
  return { query: env.window.getLastSentQuery(), anchor: m[0] };
}

// Test 7: caret parked AFTER the anchor slides by the length delta only
{
  const env = runEnvironment();
  const editor = env.elements.get('editor');
  const doc = 'Typoo line.\nSecond line.\nThird line.';
  const { query: q, anchor } = startCorrectionOnLine(env, doc, 0, 11);

  // User has moved on and is typing far below the anchor.
  const caretBefore = editor.value.indexOf('Third line.') + 5;
  editor.selectionStart = editor.selectionEnd = caretBefore;

  const corrected = 'Typo line.';
  env.context.window.__onLLMResult(q.reqId, corrected, '');

  const delta = corrected.length - anchor.length;
  assert.equal(editor.value, 'Typo line.\nSecond line.\nThird line.', 'text merged correctly');
  assert.equal(editor.selectionStart, caretBefore + delta, 'caret after the anchor slides by exactly the length delta');
  assert.equal(editor.selectionEnd, caretBefore + delta, 'collapsed caret stays collapsed');
  console.log('PASS: Test 7 (caret after anchor is preserved, not yanked to the merge point)');
}

// Test 8: caret parked BEFORE the anchor is left completely alone
{
  const env = runEnvironment();
  const editor = env.elements.get('editor');
  const doc = 'First line.\nTypoo line.\nThird line.';
  const { query: q, anchor } = startCorrectionOnLine(env, doc, 12, 23);

  assert.ok(editor.value.indexOf(anchor) > 0, 'anchor is not at the start of the document');

  const caretBefore = 4; // inside "First line."
  editor.selectionStart = editor.selectionEnd = caretBefore;

  env.context.window.__onLLMResult(q.reqId, 'Typo line.', '');

  assert.equal(editor.value, 'First line.\nTypo line.\nThird line.', 'text merged correctly');
  assert.equal(editor.selectionStart, caretBefore, 'caret before the anchor is untouched');
  assert.equal(editor.selectionEnd, caretBefore, 'caret before the anchor is untouched');
  console.log('PASS: Test 8 (caret before anchor is untouched)');
}

// Test 9: focus parked elsewhere (Find box) is given back
{
  const env = runEnvironment();
  const editor = env.elements.get('editor');
  const findInput = env.elements.get('find-input');
  const { query: q } = startCorrectionOnLine(env, 'Typoo line.\nSecond line.', 0, 11);

  // User moved to the Find box while the request was in flight.
  findInput.focus();
  assert.equal(env.documentMock.activeElement, findInput, 'find box has focus before the result arrives');

  env.context.window.__onLLMResult(q.reqId, 'Typo line.', '');

  assert.equal(editor.value, 'Typo line.\nSecond line.', 'text merged correctly');
  assert.equal(env.documentMock.activeElement, findInput, 'focus is returned to the Find box, not stolen by the editor');
  console.log('PASS: Test 9 (focus is returned to whatever the user was using)');
}

// Test 10: dropped backend callback is resolved by the request watchdog
{
  const env = runEnvironment();
  const editor = env.elements.get('editor');
  const original = 'Typoo line.';
  const { anchor } = startCorrectionOnLine(env, original + '\nSecond line.', 0, 11);

  assert.ok(editor.value.includes(anchor), 'anchor sits in the note while waiting');
  assert.equal(env.window.__longTimerCount(), 1, 'a watchdog timer is armed for the pending request');
  assert.ok(!env.elements.get('stat-llm-indicator').classList.contains('hidden'), 'LLM indicator is spinning');

  // Backend never calls back.
  env.window.__fireLongTimers();

  assert.ok(!editor.value.includes(anchor), 'anchor is removed once the watchdog fires');
  assert.equal(editor.value, original + '\nSecond line.', 'original text is restored (zero data loss)');
  assert.ok(env.elements.get('stat-llm-indicator').classList.contains('hidden'), 'LLM indicator is cleared');
  console.log('PASS: Test 10 (dropped LLM callback is resolved by the watchdog)');
}

// Test 11: a normal completion disarms the watchdog
{
  const env = runEnvironment();
  const editor = env.elements.get('editor');
  const { query: q } = startCorrectionOnLine(env, 'Typoo line.', 0, 11);
  assert.equal(env.window.__longTimerCount(), 1, 'watchdog armed');

  env.context.window.__onLLMResult(q.reqId, 'Typo line.', '');
  assert.equal(env.window.__longTimerCount(), 0, 'watchdog cleared on normal completion');

  const settled = editor.value;
  env.window.__fireLongTimers();
  assert.equal(editor.value, settled, 'no late watchdog can disturb a settled note');
  console.log('PASS: Test 11 (watchdog is disarmed on normal completion)');
}

console.log('\nAll 11 AI Typo Correction evaluation tests completed with 0 failure(s).');
