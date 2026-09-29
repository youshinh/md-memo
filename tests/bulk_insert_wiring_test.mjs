// Large many-line insertions (UX/perf review B16): Chromium's 'insertText' command is (new lines) x (lines in the note), so an AI answer,
// an agent or command result, a pasted table or a JSON-RPC write of a few thousand lines froze the window for 5 to 20 s. Those paths
// all end in execInsertTextExact (app.js) or replaceRangeWithUndo (slot_agent.js); a long text there now goes through bulk_insert.js
// (one 'insertHTML' command, still one undo step). Checked here with stubs, no browser:
//   - which command each function issues for a short text, a long text, and a short text into a huge note
//   - the note ends up exactly right (a stub that mangles the result is repaired), the caret, the refused-command path
//   - the page loads bulk_insert.js
// The time itself, the undo step and the pasted table are measured in Edge by tests/smoke/41_large_insert.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8');
const appCode = read('frontend/js/app.js');
const slotCode = read('frontend/js/slot_agent.js');
const bulkCode = read('frontend/js/bulk_insert.js');

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

const unescapeHtml = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lines = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}: a < b && c`).join('\n');

// A textarea with a selection, and a document.execCommand that replaces the selection the way the browser does. `mangle` lets a
// test make the browser change a character (it has dropped the space after the caret before), `refuse` makes it say no.
function makeEnv({ value = '', start = 0, end = 0, mangle = null, refuse = false } = {}) {
  const env = { commands: [], events: [] };
  const editor = {
    value,
    selectionStart: start,
    selectionEnd: end,
    listeners: [],
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
    focus() {},
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => l.fn !== fn); },
    dispatchEvent(ev) { env.events.push(ev.type); this.listeners.filter((l) => l.type === ev.type).forEach((l) => l.fn(ev)); return true; },
  };
  class Event { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }
  const document = {
    execCommand(name, ui, text) {
      env.commands.push(name);
      if (refuse) return false;
      const plain = name === 'insertHTML' ? unescapeHtml(text) : text;
      const s = editor.selectionStart;
      const e = editor.selectionEnd;
      let next = editor.value.slice(0, s) + plain + editor.value.slice(e);
      if (mangle) next = mangle(next, s, plain);
      editor.value = next;
      const caret = s + plain.length;
      editor.selectionStart = editor.selectionEnd = caret;
      editor.dispatchEvent(new Event('input')); // the browser tells the page once per command
      return true;
    },
  };
  const window = { document, Event };
  window.window = window;
  Object.assign(env, { editor, document, window, Event });
  return env;
}

function load(env, source, names, extra = '') {
  const ctx = vm.createContext({ console, Math, document: env.document, window: env.window, Event: env.Event, global: env.window });
  vm.runInContext(bulkCode, ctx); // sets window.BulkInsert (window is the context's own object for the module)
  vm.runInContext(`${names.map((n) => extractFunction(source, n)).join('\n')}\n${extra}\nglobalThis.__api = { ${names.join(', ')} };`, ctx);
  return ctx.__api;
}

// ---- app.js: execInsertTextExact -------------------------------------------------------------------------
check('execInsertTextExact: a long text goes in as one insertHTML step, never as insertText', () => {
  const text = lines(500);
  const env = makeEnv({ value: 'before\nafter', start: 7, end: 7 });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  assert.equal(execInsertTextExact(env.editor, text), true);
  assert.deepEqual(env.commands, ['insertHTML']);
  assert.equal(env.editor.value, 'before\n' + text + 'after');
  assert.equal(env.editor.selectionStart, 7 + text.length);
  assert.equal(env.editor.selectionEnd, 7 + text.length);
});

check('execInsertTextExact: a short text keeps the plain insertText command', () => {
  const env = makeEnv({ value: 'abc', start: 1, end: 2 });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  assert.equal(execInsertTextExact(env.editor, 'x\ny\nz'), true);
  assert.deepEqual(env.commands, ['insertText']);
  assert.equal(env.editor.value, 'ax\ny\nzc');
  assert.equal(env.editor.selectionStart, 1 + 5);
});

check('execInsertTextExact: a few lines into a huge note are long too (the cost is lines x note lines)', () => {
  const note = lines(30000);
  const env = makeEnv({ value: note, start: 10, end: 10 });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  execInsertTextExact(env.editor, lines(12));
  assert.deepEqual(env.commands, ['insertHTML']);
  const short = makeEnv({ value: lines(100), start: 10, end: 10 });
  load(short, appCode, ['execInsertTextExact']).execInsertTextExact(short.editor, lines(12));
  assert.deepEqual(short.commands, ['insertText'], 'the same 12 lines into a 100-line note are instant the plain way');
});

check('execInsertTextExact: a replaced selection and text with < & > come out exactly', () => {
  const text = lines(300) + '\n<b>&amp;</b> -->';
  const env = makeEnv({ value: 'head [old\nold] tail', start: 5, end: 14 });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  execInsertTextExact(env.editor, text);
  assert.equal(env.editor.value, 'head ' + text + ' tail');
  assert.deepEqual(env.commands, ['insertHTML']);
});

check('execInsertTextExact: a result the browser changed is set directly, and the caret is after the text', () => {
  const text = lines(400);
  // the browser drops the space that follows the caret when the text has whitespace (seen before with insertText)
  const env = makeEnv({ value: 'ab cd', start: 2, end: 2, mangle: (next, s, plain) => next.slice(0, s + plain.length) + next.slice(s + plain.length + 1) });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  assert.equal(execInsertTextExact(env.editor, text), true);
  assert.equal(env.editor.value, 'ab' + text + ' cd');
  assert.equal(env.editor.selectionStart, 2 + text.length);
  assert.equal(env.editor.selectionEnd, 2 + text.length);
});

check('execInsertTextExact: a refused command reports false and does not retry the slow way', () => {
  const env = makeEnv({ value: 'a b', start: 1, end: 1, refuse: true });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  assert.equal(execInsertTextExact(env.editor, lines(300)), false);
  assert.deepEqual(env.commands, ['insertHTML'], 'no insertText attempt behind it');
  assert.equal(env.editor.value, 'a b', 'the caller\'s own fallback decides what happens next');
  assert.equal(env.editor.selectionStart, 1, 'the selection is put back (the space guard had widened it)');
  assert.equal(env.editor.selectionEnd, 1);
});

check('execInsertTextExact: the input event is sent exactly once, whichever way the text went in', () => {
  const env = makeEnv({ value: '', start: 0, end: 0 });
  const { execInsertTextExact } = load(env, appCode, ['execInsertTextExact']);
  execInsertTextExact(env.editor, lines(300));
  assert.deepEqual(env.events, ['input']);
});

// ---- slot_agent.js: replaceRangeWithUndo (the {{ @agent }} result) ------------------------------------------
check('replaceRangeWithUndo: an agent\'s long result is one insertHTML step, a short one stays insertText', () => {
  const text = lines(600);
  const slot = '{{ @agent do it }}';
  const env = makeEnv({ value: slot + ' rest', start: 0, end: 0 });
  const { replaceRangeWithUndo } = load(env, slotCode, ['replaceRangeWithUndo']);
  assert.equal(replaceRangeWithUndo(env.editor, 0, slot.length, text), true);
  assert.deepEqual(env.commands, ['insertHTML']);
  assert.equal(env.editor.value, text + ' rest');
  assert.ok(env.events.length >= 1 && env.events.every((e) => e === 'input'), 'the note is told it changed');

  const small = makeEnv({ value: '{{ x }} rest', start: 0, end: 0 });
  const api = load(small, slotCode, ['replaceRangeWithUndo']);
  api.replaceRangeWithUndo(small.editor, 0, 7, 'one\ntwo');
  assert.deepEqual(small.commands, ['insertText']);
  assert.equal(small.editor.value, 'one\ntwo rest');
});

check('replaceRangeWithUndo: a refused long insert falls back to setting the value', () => {
  const text = lines(600);
  const env = makeEnv({ value: 'AB', start: 0, end: 0, refuse: true });
  const { replaceRangeWithUndo } = load(env, slotCode, ['replaceRangeWithUndo']);
  replaceRangeWithUndo(env.editor, 1, 1, text);
  assert.equal(env.editor.value, 'A' + text + 'B');
  assert.deepEqual(env.commands, ['insertHTML']);
});

// ---- the page ---------------------------------------------------------------------------------------------
check('index.html loads bulk_insert.js, before app.js', () => {
  const html = read('frontend/index.html');
  const bulk = html.indexOf('js/bulk_insert.js');
  const app = html.indexOf('js/app.js');
  assert.ok(bulk !== -1, 'bulk_insert.js is not loaded by index.html');
  assert.ok(bulk < app, 'bulk_insert.js must be loaded before app.js');
});

check('the only insertText inside execInsertTextExact is the short-text branch', () => {
  const body = extractFunction(appCode, 'execInsertTextExact');
  assert.equal((body.match(/execCommand\('insertText'/g) || []).length, 1);
  assert.ok(/BulkInsert\.wanted\(/.test(body) && /BulkInsert\.exec\(/.test(body));
});

let failures = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
  }
}
if (failures) {
  console.error(`${failures} of ${queue.length} failed`);
  process.exit(1);
}
console.log(`bulk_insert_wiring_test.mjs: ${queue.length} passed`);
