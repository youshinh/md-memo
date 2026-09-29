// Two fixes of the 2026-09 exploratory test (docs/design/ux-review-2026-09.md follow-up), pinned without a browser:
//
//   B28  Settings could not be walked with Tab: the focus trap of a11y.js did not know a <summary>, so at every collapsible
//        heading it sent focus back to the first control (8 of 35 controls reachable).
//   B29  After the UI language changed, four things kept the old language: the AI item of the status bar (its redraw was skipped
//        because the cache key held only i18n KEYS), the tooltip of a tab's close button, the aria-label that a11y.js had given
//        a button under the other language, and the "Protocol: ..." line of the AI Models pane.
//
// The real-browser versions of both are tests/smoke/31_settings_tab_order.mjs and 32_language_switch_live.mjs (node tests/smoke/run.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const A11y = require('../frontend/js/a11y.js');
const StatusAI = require('../frontend/js/status_ai.js');
const app = read('frontend/js/app.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.log('FAIL: ' + name + '\n  ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n  ') : e));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------------
// B28: the focus trap
// ---------------------------------------------------------------------------------------------------

// A dialog made of `spec` entries, in document order: { name, listed: false } is a control the trap's selector does not find
// (a kind of control it has not heard of), { hidden: true } is a control that has a box but cannot take focus (the content of
// a closed <details>: checkVisibility() says false).
function makeDialog(spec) {
  const doc = { activeElement: null };
  const nodes = spec.map((s, order) => {
    const node = {
      name: s.name,
      order,
      listed: s.listed !== false,
      getBoundingClientRect: () => ({ width: 10, height: 10 }),
      compareDocumentPosition: (other) => (other.order > order ? 4 : other.order < order ? 2 : 0),
      focus() { doc.activeElement = node; }
    };
    if (s.hidden) node.checkVisibility = () => false;
    else if (s.checkable) node.checkVisibility = () => true;
    return node;
  });
  const top = {
    classList: { contains: () => false },
    querySelectorAll: (sel) => (sel === A11y.FOCUSABLE ? nodes.filter((n) => n.listed) : []),
    contains: (n) => nodes.includes(n)
  };
  doc.querySelectorAll = (sel) => (sel === '.modal-backdrop' ? [top] : []);
  const by = Object.fromEntries(nodes.map((n) => [n.name, n]));
  // Presses Tab (or Shift+Tab) with focus on `from`; returns the name of the element that gets focus, 'native' when the trap
  // leaves it to the browser, or 'left' if the trap sent focus nowhere.
  function press(from, shift) {
    doc.activeElement = from === null ? { order: -1, name: 'outside' } : by[from];
    const e = { key: 'Tab', shiftKey: !!shift, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    A11y.trapTab(doc, e);
    if (!e.defaultPrevented) return 'native';
    return doc.activeElement && doc.activeElement.name ? doc.activeElement.name : 'left';
  }
  return { press, by };
}

check('B28: FOCUSABLE lists the things Tab stops on without a tabindex: summary and contenteditable, next to the form controls', () => {
  const parts = A11y.FOCUSABLE.split(',').map((p) => p.trim());
  assert.ok(parts.some((p) => /(^|\s)summary\b/.test(p)), 'a <summary> (the heading of a collapsible <details>) is focusable');
  assert.ok(parts.some((p) => /^\[contenteditable\]/.test(p)), 'a contenteditable box is focusable');
  for (const tag of ['a[href]', 'button', 'input', 'select', 'textarea']) assert.ok(parts.some((p) => p.startsWith(tag)), tag);
});

check('B28: neighbourIndex - the next listed element after one the list does not know, wrapping at the ends', () => {
  const items = [{ order: 0 }, { order: 1 }, { order: 3 }, { order: 4 }];
  const at = (order) => ({ order, compareDocumentPosition: (o) => (o.order > order ? 4 : o.order < order ? 2 : 0) });
  assert.equal(A11y.neighbourIndex(items, at(2), false), 2, 'forward: the first one after it');
  assert.equal(A11y.neighbourIndex(items, at(2), true), 1, 'backward: the last one before it');
  assert.equal(A11y.neighbourIndex(items, at(5), false), 0, 'after the last one: wrap to the first');
  assert.equal(A11y.neighbourIndex(items, at(-1), true), 3, 'before the first one: wrap to the last');
  assert.equal(A11y.neighbourIndex([], at(2), false), null, 'nothing to move to');
});

check('B28: focus on a control the trap does not list moves to its neighbour, not back to the first control of the dialog', () => {
  // first, second, [a control of a kind the selector misses], third, last
  const d = makeDialog([{ name: 'first' }, { name: 'second' }, { name: 'unknown', listed: false }, { name: 'third' }, { name: 'last' }]);
  assert.equal(d.press('unknown', false), 'third', 'Tab goes to the element after it (it used to jump to "first")');
  assert.equal(d.press('unknown', true), 'second', 'Shift+Tab goes to the element before it');
});

check('B28: the ends still wrap, the middle is left to the browser, and focus outside comes in at the first element', () => {
  const d = makeDialog([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  assert.equal(d.press('c', false), 'a');
  assert.equal(d.press('a', true), 'c');
  assert.equal(d.press('b', false), 'native');
  assert.equal(d.press('b', true), 'native');
  assert.equal(d.press(null, false), 'a', 'focus behind the dialog comes back to its first element');
  assert.equal(d.press(null, true), 'c');
});

check('B28: a control with a box that cannot take focus (closed <details> content) is not counted, so the wrap still happens at the last real stop', () => {
  const d = makeDialog([{ name: 'a', checkable: true }, { name: 'b', checkable: true }, { name: 'hidden-one', hidden: true }]);
  assert.equal(d.press('b', false), 'a', 'the last reachable control wraps to the first');
  assert.equal(d.press('a', true), 'b', 'and Shift+Tab from the first goes to the last reachable one');
});

// ---------------------------------------------------------------------------------------------------
// B29-3: button names follow the language (a11y.js)
// ---------------------------------------------------------------------------------------------------

function makeButton(attrs, text) {
  const map = Object.assign({}, attrs);
  return {
    textContent: text,
    getAttribute: (k) => (k in map ? map[k] : null),
    setAttribute: (k, v) => { map[k] = String(v); },
    removeAttribute: (k) => { delete map[k]; },
    hasAttribute: (k) => k in map,
    // The page changes the text and the title together when the language changes (applyLanguage).
    say(textNow, titleNow) { this.textContent = textNow; map.title = titleNow; }
  };
}

check('B29: a button named by a11y.js loses that name once its visible text names it (Japanese "置換" -> English "Replace"), and gets it back', () => {
  const replace = makeButton({ title: '置換' }, '置換'); // a two-character name is not enough for a screen reader
  const send = makeButton({ title: '実行 (Enter)' }, '実行');
  const keep = makeButton({ 'aria-label': 'By hand', title: 'x' }, 'x'); // named by hand: never touched
  const keepFlag = makeButton({ 'data-a11y-keep': '', title: 'x' }, 'x');
  const doc = { querySelectorAll: (sel) => (sel === 'button, [role="button"]' ? [replace, send, keep, keepFlag] : []) };
  A11y.refresh(doc);
  assert.equal(replace.getAttribute('aria-label'), '置換');
  assert.equal(send.getAttribute('aria-label'), '実行 (Enter)');
  assert.equal(replace.getAttribute('data-a11y-label'), '1');

  replace.say('Replace', 'Replace');
  send.say('Run', 'Run (Enter)');
  A11y.refresh(doc);
  assert.equal(replace.getAttribute('aria-label'), null, 'the old Japanese label is gone: "Replace" names the button');
  assert.equal(replace.hasAttribute('data-a11y-label'), false);
  assert.equal(send.getAttribute('aria-label'), null);
  assert.equal(keep.getAttribute('aria-label'), 'By hand', 'a label set by hand is left alone');
  assert.equal(keepFlag.hasAttribute('aria-label'), false);

  replace.say('置換', '置換');
  send.say('実行', '実行 (Enter)');
  A11y.refresh(doc);
  assert.equal(replace.getAttribute('aria-label'), '置換', 'and it comes back when the text is short again');
  assert.equal(send.getAttribute('aria-label'), '実行 (Enter)');
});

// ---------------------------------------------------------------------------------------------------
// B29-1: the AI item of the status bar follows the language
// ---------------------------------------------------------------------------------------------------

check('B29: the AI item is redrawn when only the UI language changed, and not redrawn when nothing changed', () => {
  const TEXT = {
    en: { statAiLocal: 'AI: local', statAiTitleLocal: 'AI model: {model}, on this computer.' },
    ja: { statAiLocal: 'AI: ローカル', statAiTitleLocal: 'AIモデル: {model}（このパソコン上）。' }
  };
  let lang = 'en';
  const t = (key, vars) => TEXT[lang][key].replace('{model}', (vars && vars.model) || '');
  const attrs = {};
  let writes = 0;
  let text = '';
  const trigger = {
    id: 'stat-ai',
    title: '',
    get textContent() { return text; },
    set textContent(v) { text = String(v); writes++; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })
  };
  const doc = { body: {}, documentElement: {}, getElementById: (id) => (id === 'stat-ai' ? trigger : null) };
  const item = StatusAI.create({
    doc, t,
    isLocal: (url) => StatusAI.fallbackIsLocal(url),
    getConfig: () => ({ text: { baseUrl: 'http://localhost:11434', model: 'qwen' } }),
    isConfigured: () => true
  });
  item.refresh();
  assert.equal(trigger.textContent, 'AI: local');
  assert.equal(trigger.title, 'AI model: qwen, on this computer.');

  const before = writes;
  item.refresh();
  assert.equal(writes, before, 'an unchanged state is not written again (the cache still works)');

  lang = 'ja'; // applyLanguage() -> updateActionStatus() -> StatusAI.refresh()
  item.refresh();
  assert.equal(trigger.textContent, 'AI: ローカル', 'the label follows the language');
  assert.equal(trigger.title, 'AIモデル: qwen（このパソコン上）。', 'and so does the tooltip');
  lang = 'en';
  item.refresh();
  assert.equal(trigger.textContent, 'AI: local');
});

// ---------------------------------------------------------------------------------------------------
// B29-2 and B29-4: app.js (tab close tooltip, protocol line)
// ---------------------------------------------------------------------------------------------------

// The source of `[async] function <name>(...) { ... }` at two-space indentation inside app.js's closure.
function functionSource(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists in app.js');
  const end = app.indexOf('\n  }\n', start);
  assert.ok(end > start, name + ' has a body');
  return app.slice(start, end + 4);
}

check('B29: renderProviderDetectLine writes the protocol line again from the provider it remembers, in the current language', () => {
  const src = functionSource('renderProviderDetectLine');
  let lang = 'en';
  const TEXT = {
    en: { llmProtocolDetected: 'Protocol: {protocol}', llmProtocolUnknown: 'Protocol: unknown', providerOllama: 'Ollama', providerGemini: 'Gemini', providerOpenAICompatible: 'OpenAI-compatible' },
    ja: { llmProtocolDetected: '接続方式: {protocol}', llmProtocolUnknown: '接続方式: 不明', providerOllama: 'Ollama', providerGemini: 'Gemini', providerOpenAICompatible: 'OpenAI互換' }
  };
  const t = (key, vars) => TEXT[lang][key].replace('{protocol}', (vars && vars.protocol) || '');
  const line = { textContent: '' };
  const document = { getElementById: (id) => (id === 'text-provider-detect-line' ? line : null) };
  // The function reads the app's variable of the same name; the test sets it the way updateLLMProviderDetection() does.
  const probe = new Function('document', 't', ['var lastDetectedProvider;', src, 'return { render: renderProviderDetectLine, set: function (v) { lastDetectedProvider = v; } };'].join('\n'))(document, t);
  const render = probe.render;
  const detected = (provider) => probe.set(provider);

  render();
  assert.equal(line.textContent, '', 'nothing detected yet (the variable is still undefined at start-up): nothing is written, nothing throws');
  detected(null);
  render();
  assert.equal(line.textContent, '', 'a hidden line is not written either');

  detected('ollama');
  render();
  assert.equal(line.textContent, 'Protocol: Ollama');
  lang = 'ja';
  render();
  assert.equal(line.textContent, '接続方式: Ollama', 'the same provider, in the new language');
  detected('openai-compatible');
  render();
  assert.equal(line.textContent, '接続方式: OpenAI互換');
  detected('');
  render();
  assert.equal(line.textContent, '接続方式: 不明', 'an unrecognised provider says so');
  lang = 'en';
  render();
  assert.equal(line.textContent, 'Protocol: unknown');
});

check('B29: applyLanguage redraws the protocol line; detection stores the provider instead of writing text once; a tab close button follows the language', () => {
  const apply = functionSource('applyLanguage');
  assert.ok(/renderProviderDetectLine\(\);/.test(apply), 'applyLanguage() re-renders the protocol line');
  const detect = functionSource('updateLLMProviderDetection');
  assert.ok(/lastDetectedProvider = provider/.test(detect) && /renderProviderDetectLine\(\)/.test(detect), 'detection remembers the provider and renders through the one function');
  assert.ok(/\n  var lastDetectedProvider = null;/.test(app), 'the remembered provider is a var: applyLanguage() may read it before its declaration has run');
  assert.ok(!/lineEl\.textContent = /.test(detect), 'detection no longer writes translated text that a language change cannot redo');
  const tabs = app.slice(app.indexOf("closeEl.className = 'tab-close';"), app.indexOf("closeEl.className = 'tab-close';") + 400);
  assert.ok(/closeEl\.setAttribute\('data-i18n-title', 'closeTabTitle'\)/.test(tabs), 'the close button carries data-i18n-title, so the language loop of applyLanguage() retitles it');
  assert.ok(/document\.querySelectorAll\('\[data-i18n-title\]'\)/.test(apply), 'and that loop is there');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) console.log('Some checks FAILED.');
