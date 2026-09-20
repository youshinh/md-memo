import fs from 'fs';
import assert from 'assert';

console.log('=== Ghost text: overlay alignment & stale-suggestion tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');

// The real ghost engine (overlay, IME/LLM suggestion, accept, autocomplete request/response).
const start = appJs.indexOf('  // Ghost Text & Autocomplete Engine\n');
const end = appJs.indexOf('  // LLM Instruction Prompt Modal');
assert(start > 0 && end > start, 'ghost engine section not found in app.js');
const engineSrc = appJs.slice(start, end);

const keyupMatch = appJs.match(/  editorEl\.addEventListener\('keyup', \(\) => \{[\s\S]*?\n  \}\);\n/);
assert(keyupMatch, 'editor keyup handler not found in app.js');

// Regression guard: assigning overlay.scrollTop clamps to the overlay's own (shorter) scroll range.
assert(!/ghostOverlayEl\.scroll(Top|Left)\s*=/.test(appJs),
  'app.js must not assign ghostOverlayEl.scrollTop/scrollLeft: use syncGhostScroll() (transform) instead');

function mockEl(tag) {
  const el = {
    tagName: tag, style: {}, className: '', textContent: '', parentElement: null, children: [],
    appendChild(c) { c.parentElement = el; el.children.push(c); return c; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.forEach((c) => { c.parentElement = null; }); el.children = []; }
  });
  return el;
}

function makeOverlay() {
  const el = mockEl('div');
  for (const p of ['scrollTop', 'scrollLeft']) {
    Object.defineProperty(el, p, {
      get: () => 0,
      set() { throw new Error(`ghost overlay ${p} must not be assigned (it clamps to the overlay's shorter scroll range)`); }
    });
  }
  return el;
}

const factory = new Function(
  'editorEl', 'ghostOverlayEl', 'document', 'config', 'statAutocomplete', 't', 'window',
  'getImeGuardian', 'insertTextWithUndo', 'onEditorInput', 'getTab', 'genReqId',
  'setTimeout', 'clearTimeout', 'scheduleUpdateStatusBar', 'triggerCursorAuraDebounced',
  `
  let isPreviewMode = false, ghostSuggestion = '', ghostTargetCursor = 0, activeImeSuggestion = null;
  let autocompleteTimer = null, currentAutocompleteReqId = null, activeTabId = 'tab-1';
  ${engineSrc}
  ${keyupMatch[0]}
  return {
    renderGhostText, clearGhostText, syncGhostScroll, triggerAutocompleteDebounced,
    onResult: window.__onAutocompleteResult,
    spans: () => ({ inner: ghostInnerEl, prefix: ghostPrefixSpan, suggestion: ghostSuggestionSpan }),
    get ghostSuggestion() { return ghostSuggestion; },
    setImeSuggestion(v) { activeImeSuggestion = v; },
    setActiveTab(id) { activeTabId = id; }
  };
  `
);

let reqCounter = 0;
function setup({ value = '# title\n\nおはよう', caret, scrollTop = 0, clientWidth = 545 } = {}) {
  const timers = [];
  const overlay = makeOverlay();
  const listeners = {};
  const pos = caret === undefined ? value.length : caret;
  const editor = {
    value, selectionStart: pos, selectionEnd: pos,
    scrollTop, scrollLeft: 0, offsetWidth: 560, clientWidth,
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const status = { textContent: '', title: '', style: {} };
  const requests = [];
  const win = { backend: { autocompleteAsync: (reqId, prefix, suffix) => requests.push({ reqId, prefix, suffix }) } };
  const config = { autocomplete: { enabled: true, delayMs: 300 }, general: { imeGuardian: false } };
  const engine = factory(
    editor, overlay, { createElement: mockEl }, config, status, (k) => k, win,
    () => null, () => {}, () => {}, () => null, (p) => `${p}${++reqCounter}`,
    (fn) => { timers.push(fn); return timers.length; }, () => { timers.length = 0; }, () => {}, () => {}
  );
  return { engine, editor, overlay, status, requests, listeners, flushTimer() { const fn = timers.pop(); if (fn) fn(); } };
}

function requestSuggestion(s) {
  s.engine.triggerAutocompleteDebounced();
  s.flushTimer();
  assert.strictEqual(s.requests.length, 1, 'a suggestion request must have been sent');
  return s.requests[0].reqId;
}

// 1. The overlay follows the textarea's scroll with a transform, never with scrollTop, and
//    reserves the textarea's scrollbar gutter so both wrap at the same width.
{
  const s = setup({ value: 'x'.repeat(10), scrollTop: 865 });
  s.engine.renderGhostText('x'.repeat(10), ' GHOST'); // throws if overlay.scrollTop is assigned
  const { inner, prefix, suggestion } = s.engine.spans();
  assert.strictEqual(inner.parentElement, s.overlay, 'spans live in an inner block inside the overlay');
  assert.strictEqual(prefix.parentElement, inner);
  assert.strictEqual(suggestion.parentElement, inner);
  assert.strictEqual(suggestion.textContent, ' GHOST');
  assert.strictEqual(inner.style.transform, 'translate(0px, -865px)', 'inner block is translated by the editor scroll');
  assert.strictEqual(s.overlay.style.right, '15px', 'overlay reserves the 15px scrollbar gutter');

  s.editor.scrollTop = 120;
  s.engine.syncGhostScroll();
  assert.strictEqual(inner.style.transform, 'translate(0px, -120px)', 'scrolling re-syncs the transform');

  s.editor.clientWidth = 560; // note got short: scrollbar gone
  s.engine.renderGhostText('x', 'y');
  assert.strictEqual(s.overlay.style.right, '0px', 'gutter follows the scrollbar');
  console.log('PASS: overlay follows scroll via transform and matches the textarea wrap width.');
}

// 2. A suggestion is only shown if the note still looks like it did when it was requested.
{
  const s = setup();
  const id = requestSuggestion(s);
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, 'ございます', 'unchanged note: suggestion is shown');
  assert.strictEqual(s.engine.spans().prefix.textContent, '# title\n\nおはよう');
}
{
  const s = setup(); // Enter pressed while the request was in flight -> caret on the next line
  const id = requestSuggestion(s);
  s.editor.value += '\n';
  s.editor.selectionStart = s.editor.selectionEnd = s.editor.value.length;
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'stale suggestion must not be drawn on the new line');
  assert.strictEqual(s.status.textContent, 'statAutocompleteOn', 'status must leave "predicting" when a response is dropped');
}
{
  const s = setup(); // caret moved with the arrow keys
  const id = requestSuggestion(s);
  s.editor.selectionStart = s.editor.selectionEnd = 3;
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'caret moved: dropped');
}
{
  const s = setup(); // a selection was made
  const id = requestSuggestion(s);
  s.editor.selectionStart = s.editor.value.length - 2;
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'selection made: dropped');
}
{
  const s = setup(); // another note became active
  const id = requestSuggestion(s);
  s.engine.setActiveTab('tab-2');
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'tab switched: dropped');
}
{
  const s = setup(); // same length, different text before the caret
  const id = requestSuggestion(s);
  s.editor.value = '# title\n\nおはよっ';
  s.engine.onResult(id, 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'prefix edited: dropped');
}
{
  const s = setup(); // a superseded request id is ignored outright
  requestSuggestion(s);
  s.engine.onResult('some-older-request', 'ございます', '');
  assert.strictEqual(s.engine.ghostSuggestion, '', 'unknown request id: ignored');
}
{
  const s = setup(); // errors still surface
  const id = requestSuggestion(s);
  s.engine.onResult(id, '', 'boom');
  assert.strictEqual(s.status.textContent, 'statAutocompleteError');
  assert.strictEqual(s.engine.ghostSuggestion, '');
}
console.log('PASS: stale LLM suggestions are dropped instead of being drawn at the new caret.');

// 3. A suggestion is taken down when the caret leaves the spot it was drawn at.
{
  const s = setup({ value: 'hello world', caret: 5, scrollTop: 40 });
  s.engine.renderGhostText('hello', ' there');
  s.listeners.keyup();
  assert.strictEqual(s.engine.ghostSuggestion, ' there', 'caret unchanged: suggestion stays');

  s.editor.scrollTop = 90;
  s.listeners.keyup();
  assert.strictEqual(s.engine.spans().inner.style.transform, 'translate(0px, -90px)', 'keyup keeps the overlay glued to the scroll');

  s.editor.selectionStart = s.editor.selectionEnd = 2;
  s.listeners.keyup();
  assert.strictEqual(s.engine.ghostSuggestion, '', 'caret moved away: suggestion removed');
}
{
  const s = setup({ value: 'kinou', caret: 5 });
  s.engine.renderGhostText('kinou', ' [Tab: きのう]');
  s.engine.setImeSuggestion({ startPos: 0, endPos: 5, hiragana: 'きのう' });
  s.listeners.keyup();
  assert.strictEqual(s.engine.ghostSuggestion, ' [Tab: きのう]', 'IME suggestion stays while the caret is at its end');
  s.editor.selectionStart = s.editor.selectionEnd = 3;
  s.listeners.keyup();
  assert.strictEqual(s.engine.ghostSuggestion, '', 'IME suggestion removed when the caret moves');
}
console.log('PASS: suggestions do not linger after the caret moves.');

console.log('\nAll ghost overlay tests PASSED!');
