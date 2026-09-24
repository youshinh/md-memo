// Huge notes (80,000 lines / 3 MB pasted through the CLI pipe used to freeze the app):
//  - countNewlines replaces the per-keystroke charCodeAt scans,
//  - the line-number gutter is blocks that are only touched at the tail,
//  - getCharPixelCoords measures a window instead of the whole text before the caret.
// The pure parts are extracted from app.js the way the other suites here do it; getCharPixelCoords
// runs against a tiny fake DOM whose "layout" is exact and known, so every path can be compared
// with the true answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
  }
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
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

function constFromSource(name) {
  const m = appCode.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `const ${name} not found in app.js`);
  return Number(m[1]);
}

function load(names, context = {}) {
  const ctx = vm.createContext(Object.assign({ console, Math }, context));
  const code = names.map((n) => extractFunction(appCode, n)).join('\n');
  vm.runInContext(`${code}\nglobalThis.__api = { ${names.join(', ')} };`, ctx);
  return ctx.__api;
}

const FULL_LIMIT = constFromSource('CHAR_MIRROR_FULL_LIMIT');
const WINDOW_LINES = constFromSource('CHAR_MIRROR_WINDOW_LINES');
const WINDOW_CHARS = constFromSource('CHAR_MIRROR_WINDOW_CHARS');
const BLOCK_LINES = constFromSource('GUTTER_BLOCK_LINES');

// Deterministic pseudo-random numbers (the failures must be reproducible).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// countNewlines
// ---------------------------------------------------------------------------
const { countNewlines } = load(['countNewlines']);

function countNewlinesRef(text, end) {
  let n = 0;
  const limit = end === undefined ? text.length : end;
  for (let i = 0; i < limit && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

check('countNewlines matches the charCodeAt loop it replaced', () => {
  const docs = ['', '\n', '\n\n\n', 'abc', 'abc\n', '\nabc', 'a\nb\nc', 'a\r\nb\r\n', 'x'.repeat(5000), 'x'.repeat(5000) + '\n' + 'y'.repeat(5000)];
  const r = rng(7);
  let big = '';
  for (let i = 0; i < 3000; i++) big += (r() < 0.3 ? '' : 'w'.repeat(Math.floor(r() * 40))) + '\n';
  docs.push(big);
  for (const doc of docs) {
    const ends = [undefined, -5, -1, 0, 1, 2, doc.length - 1, doc.length, doc.length + 1, doc.length + 100, Math.floor(doc.length / 2)];
    for (const end of ends) {
      assert.equal(countNewlines(doc, end), countNewlinesRef(doc, end), `end=${end} in ${JSON.stringify(doc.slice(0, 20))} (len ${doc.length})`);
    }
  }
  assert.equal(countNewlines(''), 0);
  assert.equal(countNewlines('\n'), 1);
  assert.equal(countNewlines('a\nb\nc', 1), 0, 'a newline AT the end offset is not before it');
  assert.equal(countNewlines('a\nb\nc', 2), 1);
  assert.equal(countNewlines('a\nb\nc', 4), 2);
});

// ---------------------------------------------------------------------------
// Gutter blocks
// ---------------------------------------------------------------------------
function fakeGutterDom() {
  const log = [];
  function textNode(s) {
    let d = s;
    return { get data() { return d; }, set data(v) { d = v; log.push('write'); } };
  }
  function node(name) {
    const n = {
      name,
      children: [],
      set textContent(v) { n.children = v === '' ? [] : [textNode(String(v))]; log.push('set'); },
      get textContent() { return n.children.map((c) => (c.children ? c.textContent : c.data)).join(''); },
      get firstChild() { return n.children[0] || null; },
      appendChild(c) { n.children.push(c); log.push('append'); return c; },
      removeChild(c) { const i = n.children.indexOf(c); assert.ok(i >= 0, 'removeChild of a foreign node'); n.children.splice(i, 1); log.push('remove'); return c; },
    };
    return n;
  }
  return { log, node, document: { createElement: (tag) => node(tag) } };
}

function expectedGutterText(lines) {
  let s = '';
  for (let n = 1; n <= lines; n++) s += n + '\n';
  return s;
}

function gutterApi() {
  const dom = fakeGutterDom();
  const api = load(['renderLineGutter'], { GUTTER_BLOCK_LINES: BLOCK_LINES, lineGutters: new WeakMap(), document: dom.document });
  return { render: api.renderLineGutter, dom };
}

check('gutter shows 1..N for growing, shrinking and equal line counts, in blocks', () => {
  const { render, dom } = gutterApi();
  const el = dom.node('gutter');
  const r = rng(11);
  let lines = 1;
  const steps = [1, 2, 999, 1000, 1001, 1002, 2000, 2001, 5500, 5501, 5500, 5000, 4999, 1001, 1000, 999, 1, 3, 12345, 12345, 40000, 39999, 1];
  for (let i = 0; i < 60; i++) steps.push(1 + Math.floor(r() * 9000));
  for (const n of steps) {
    render(el, n);
    lines = n;
    assert.equal(el.textContent, expectedGutterText(lines), `text after render(${n})`);
    assert.equal(el.children.length, Math.ceil(lines / BLOCK_LINES), `block count after render(${n})`);
  }
});

check('gutter: a re-render with the same count touches nothing, +1 line touches one block', () => {
  const { render, dom } = gutterApi();
  const el = dom.node('gutter');
  render(el, 5500);
  dom.log.length = 0;
  render(el, 5500);
  assert.deepEqual(dom.log, [], 'same count: no DOM work');
  render(el, 5501);
  assert.deepEqual(dom.log, ['set'], 'one more line inside the last block: one text assignment');
  dom.log.length = 0;
  render(el, 6000);
  assert.deepEqual(dom.log, ['set'], 'filling the last block: one text assignment');
  dom.log.length = 0;
  render(el, 6001);
  assert.deepEqual(dom.log, ['set', 'append'], 'first line of a new block: one new block');
  dom.log.length = 0;
  render(el, 6000);
  assert.deepEqual(dom.log, ['remove'], 'dropping the last block: nothing else is rewritten');
  dom.log.length = 0;
  render(el, 5999);
  assert.deepEqual(dom.log, ['set'], 'shrinking inside the last block: one text assignment');
});

check('gutter: two gutters keep separate state', () => {
  const { render, dom } = gutterApi();
  const a = dom.node('a');
  const b = dom.node('b');
  render(a, 1500);
  render(b, 3);
  render(a, 1600);
  assert.equal(a.textContent, expectedGutterText(1600));
  assert.equal(b.textContent, expectedGutterText(3));
});

// ---------------------------------------------------------------------------
// charMirrorWindowStart / estimateSkippedHeight
// ---------------------------------------------------------------------------
const { charMirrorWindowStart, estimateSkippedHeight } = load(['charMirrorWindowStart', 'estimateSkippedHeight']);

// Reference: split into lines, walk up from the caret's line while the budget holds.
function windowStartRef(text, caret, maxLines, maxChars) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  let li = 0;
  while (li + 1 < starts.length && starts[li + 1] <= caret) li++;
  let up = 0;
  while (up < maxLines && li > 0 && caret - starts[li - 1] <= maxChars) {
    li--;
    up++;
  }
  return starts[li];
}

check('charMirrorWindowStart matches a split-based reference on tricky and random documents', () => {
  const r = rng(3);
  const docs = ['', '\n', '\n\n\n\n', 'abc', 'abc\ndef\nghi', '\nabc\n\ndef\n', 'a\n'.repeat(50), 'x'.repeat(200) + '\n' + 'y'.repeat(200) + '\nz'];
  for (let d = 0; d < 6; d++) {
    let s = '';
    const n = 20 + Math.floor(r() * 400);
    for (let i = 0; i < n; i++) s += (r() < 0.2 ? '' : 'q'.repeat(Math.floor(r() * 60))) + (i < n - 1 || r() < 0.5 ? '\n' : '');
    docs.push(s);
  }
  for (const doc of docs) {
    const carets = new Set([0, 1, doc.length, Math.max(0, doc.length - 1), Math.floor(doc.length / 2)]);
    for (let k = 0; k < 25; k++) carets.add(Math.floor(r() * (doc.length + 1)));
    for (const caret of carets) {
      if (caret < 0 || caret > doc.length) continue;
      for (const [maxLines, maxChars] of [[0, 1e9], [1, 1e9], [5, 1e9], [300, 1e9], [300, 40], [300, 500], [2, 3]]) {
        assert.equal(
          charMirrorWindowStart(doc, caret, maxLines, maxChars),
          windowStartRef(doc, caret, maxLines, maxChars),
          `caret ${caret}, maxLines ${maxLines}, maxChars ${maxChars} in ${JSON.stringify(doc.slice(0, 30))} (len ${doc.length})`
        );
      }
    }
  }
});

check('charMirrorWindowStart always keeps the caret line whole and starts on a line start', () => {
  const doc = 'a'.repeat(100) + '\n' + 'b'.repeat(100) + '\n' + 'c'.repeat(100);
  assert.equal(charMirrorWindowStart(doc, doc.length, 300, 10), 202, 'the caret line is kept even when it is longer than the budget');
  assert.equal(charMirrorWindowStart(doc, 150, 0, 1e9), 101, 'maxLines 0 = the caret line only');
  assert.equal(charMirrorWindowStart(doc, 0, 300, 1e9), 0);
  assert.equal(charMirrorWindowStart('\nabc', 4, 300, 1e9), 0, 'a leading empty line is reached (lastIndexOf clamps negatives to 0)');
  assert.equal(charMirrorWindowStart('\nabc', 4, 0, 1e9), 1);
});

check('estimateSkippedHeight is the average line height times the skipped lines', () => {
  assert.equal(estimateSkippedHeight(100, 1000, 22000), 2200);
  assert.equal(estimateSkippedHeight(0, 1000, 22000), 0);
  assert.equal(estimateSkippedHeight(100, 0, 22000), 0);
  assert.equal(estimateSkippedHeight(100, 1000, 0), 0, 'an editor that is not laid out (hidden) contributes nothing');
  assert.equal(estimateSkippedHeight(100, 1000, -5), 0);
  assert.equal(estimateSkippedHeight(NaN, 1000, 22000), 0);
  assert.equal(estimateSkippedHeight(100, 1000, NaN), 0);
});

// ---------------------------------------------------------------------------
// getCharPixelCoords against a fake DOM with an exact layout
// ---------------------------------------------------------------------------
const ROW = 20;
const PAD = 12; // top and bottom padding
const COLS = 80; // a logical line of n characters takes ceil(n / COLS) rows (at least one)

const rowsOfLine = (len, cols) => Math.max(1, Math.ceil(len / cols));
// Exact top of the caret for a plain text: rows of every line above + the wrapped rows before the caret in its line.
function trueTop(text, caret, cols) {
  const before = text.substring(0, caret).split('\n');
  let rows = 0;
  for (let i = 0; i < before.length - 1; i++) rows += rowsOfLine(before[i].length, cols);
  rows += Math.floor(before[before.length - 1].length / cols);
  return PAD + rows * ROW;
}
function trueHeight(text, cols) {
  let rows = 0;
  for (const line of text.split('\n')) rows += rowsOfLine(line.length, cols);
  return PAD + rows * ROW + PAD;
}

function fakeMirrorDom(cols) {
  const created = [];
  function el(tag) {
    const e = {
      tag,
      style: {},
      children: [],
      _text: '',
      setAttribute() {},
      appendChild(c) { e.children.push(c); return c; },
      set textContent(v) { e._text = String(v); e.children = []; },
      get textContent() { return e._text + e.children.map((c) => c.textContent).join(''); },
    };
    created.push(e);
    return e;
  }
  const mirrors = [];
  const document = {
    createElement(tag) {
      const e = el(tag);
      if (tag === 'div') {
        mirrors.push(e);
        // Height of the mirror = its whole content laid out (the caret span counts as a character on its line).
        Object.defineProperty(e, 'offsetHeight', { get: () => trueHeight(e.textContent, cols) });
      } else {
        Object.defineProperty(e, 'offsetLeft', { get: () => 14 });
        Object.defineProperty(e, 'offsetTop', {
          get: () => {
            // The span sits at the end of the mirror's own text (before any tail text that follows it).
            const parent = mirrors.find((m) => m.children.includes(e));
            return trueTop(parent._text, parent._text.length, cols);
          },
        });
      }
      return e;
    },
    createTextNode(t) { return { textContent: String(t) }; },
    body: { appendChild() {} },
  };
  return { document, mirrors };
}

function coordsHarness(text, cols = COLS) {
  const dom = fakeMirrorDom(cols);
  const editor = {
    value: text,
    clientWidth: 1000,
    get scrollHeight() { return trueHeight(editor.value, cols); },
  };
  const context = {
    document: dom.document,
    window: { getComputedStyle: () => ({ fontFamily: 'x', fontSize: '14px', lineHeight: '20px', padding: '12px 14px', paddingTop: '12px', paddingBottom: '12px', boxSizing: 'border-box', whiteSpace: 'pre-wrap', wordWrap: 'break-word', tabSize: '4' }) },
    charMirrors: new WeakMap(),
    charMirrorGeneration: 0,
    getActiveEditor: () => editor,
    CHAR_MIRROR_FULL_LIMIT: FULL_LIMIT,
    CHAR_MIRROR_WINDOW_LINES: WINDOW_LINES,
    CHAR_MIRROR_WINDOW_CHARS: WINDOW_CHARS,
  };
  const api = load(['countNewlines', 'charMirrorWindowStart', 'estimateSkippedHeight', 'getCharPixelCoords'], context);
  return { editor, mirrors: dom.mirrors, coords: (i) => api.getCharPixelCoords(i, editor) };
}

function lineDoc(lines, lineLen, trailingNewline) {
  const r = rng(lines * 31 + lineLen);
  const out = [];
  for (let i = 0; i < lines; i++) out.push('L' + i + ' ' + 'x'.repeat(Math.max(0, Math.floor(lineLen * (0.5 + r()) - 8))));
  return out.join('\n') + (trailingNewline ? '\n' : '');
}

check('small notes take the exact path unchanged (whole prefix in the mirror, no estimate flag)', () => {
  const text = lineDoc(400, 30, false);
  assert.ok(text.length < FULL_LIMIT);
  const h = coordsHarness(text);
  for (const caret of [0, 1, 500, text.length - 1, text.length]) {
    const c = h.coords(caret);
    assert.equal(c.top, trueTop(text, caret, COLS), `top at ${caret}`);
    assert.equal(c.left, 14);
    assert.equal(c.estimated, undefined);
    assert.equal(h.mirrors[0]._text, text.substring(0, caret), 'the whole text before the caret is mirrored');
  }
});

check('huge note, no wrapping: every position is exact (window, bottom anchor and start alike)', () => {
  for (const trailing of [false, true]) {
    const text = lineDoc(6000, 40, trailing);
    assert.ok(text.length > FULL_LIMIT, 'the document must be over the limit');
    const h = coordsHarness(text, 1e9);
    const r = rng(5);
    const carets = [0, 1, text.length, text.length - 1, text.length - 10, text.indexOf('\n') + 1, text.length - WINDOW_CHARS - 5, text.length - WINDOW_CHARS, text.length - WINDOW_CHARS + 5];
    for (let k = 0; k < 60; k++) carets.push(Math.floor(r() * (text.length + 1)));
    for (const caret of carets) {
      if (caret < 0 || caret > text.length) continue;
      assert.equal(h.coords(caret).top, trueTop(text, caret, 1e9), `top at ${caret} (trailing newline: ${trailing})`);
    }
  }
});

check('huge note: only a window is mirrored, not the text before the caret', () => {
  const text = lineDoc(6000, 40, false);
  const h = coordsHarness(text, 1e9);
  const caret = Math.floor(text.length / 2);
  const c = h.coords(caret);
  const mirror = h.mirrors[0];
  assert.ok(mirror._text.length <= WINDOW_CHARS + 100, `mirrored ${mirror._text.length} characters`);
  assert.ok(mirror._text.length > 0);
  assert.equal(c.estimated, true, 'a mid-note position is flagged as an estimate');
  assert.ok(text.substring(0, caret).endsWith(mirror._text), 'the window ends at the caret');
  const windowStart = caret - mirror._text.length;
  assert.ok(windowStart === 0 || text[windowStart - 1] === '\n', 'the window starts on a line start');
  const lines = mirror._text.split('\n').length;
  assert.ok(lines <= WINDOW_LINES + 1, `window has ${lines} lines`);
  assert.equal(mirror.children.length, 1, 'no tail text after the caret span in the estimate path');
});

check('huge note near the end: the caret line plus the tail are mirrored and the position is exact even with wrapped lines', () => {
  const cols = 60;
  const text = lineDoc(5000, 90, false); // a good share of the lines wraps
  const h = coordsHarness(text, cols);
  for (const back of [0, 3, 200, 5000, WINDOW_CHARS - 10]) {
    const caret = text.length - back;
    const c = h.coords(caret);
    // (The mirror holds the caret marker "|" as a character, so a caret line that exactly fills its
    // last row measures one row more than the textarea: one row of difference, only for such a line.)
    const lineLen = text.split('\n')[text.substring(0, caret).split('\n').length - 1].length;
    const tolerance = lineLen % cols === 0 ? ROW : 0;
    assert.ok(Math.abs(c.top - trueTop(text, caret, cols)) <= tolerance, `top ${back} characters before the end: ${c.top} vs ${trueTop(text, caret, cols)}`);
    assert.equal(c.estimated, undefined, 'counted from the bottom, so not an estimate');
    assert.ok(h.mirrors[0]._text.length < WINDOW_CHARS, 'only the caret line is mirrored before the caret');
  }
});

check('huge note in the middle with wrapped lines: an estimate that follows the average line height', () => {
  const cols = 60;
  const text = lineDoc(5000, 90, false);
  const h = coordsHarness(text, cols);
  const caret = Math.floor(text.length * 0.4);
  const c = h.coords(caret);
  const mirror = h.mirrors[0];
  const windowStart = caret - mirror._text.length;
  const skippedLines = text.substring(0, windowStart).split('\n').length - 1;
  const totalLines = text.split('\n').length;
  const contentHeight = trueHeight(text, cols) - 2 * PAD;
  const expected = Math.round(trueTop(mirror._text, mirror._text.length, cols) + skippedLines * (contentHeight / totalLines));
  assert.equal(c.top, expected);
  assert.equal(c.estimated, true);
  // ... and it is close to the truth for a document whose lines are alike.
  assert.ok(Math.abs(c.top - trueTop(text, caret, cols)) < 40 * ROW, `off by ${c.top - trueTop(text, caret, cols)} px`);
});

check('huge note: out-of-range and NaN carets behave like substring() did', () => {
  const text = lineDoc(6000, 40, false);
  const h = coordsHarness(text, 1e9);
  assert.equal(h.coords(text.length + 500).top, trueTop(text, text.length, 1e9));
  assert.equal(h.coords(-3).top, PAD);
  assert.equal(h.coords(NaN).top, PAD);
});

// ---------------------------------------------------------------------------
// keepCoordsInView / revealCaretInHugeNote
// ---------------------------------------------------------------------------
check('keepCoordsInView leaves exact coordinates alone and pins estimated ones to the visible band', () => {
  const { keepCoordsInView } = load(['keepCoordsInView'], { currentFontSize: 14 });
  const editor = { scrollTop: 5000, clientHeight: 600 };
  const exact = { top: 123456, left: 30 };
  assert.equal(keepCoordsInView(exact, editor), exact, 'the very same object, untouched');
  assert.equal(keepCoordsInView({ top: 1, left: 30, estimated: true }, editor).top, 5000);
  assert.equal(keepCoordsInView({ top: 999999, left: 31, estimated: true }, editor).top, 5000 + 600 - 22);
  assert.equal(keepCoordsInView({ top: 5300, left: 32, estimated: true }, editor).top, 5300, 'a position inside the band is kept');
  assert.equal(keepCoordsInView({ top: 5300, left: 32, estimated: true }, editor).left, 32);
});

check('revealCaretInHugeNote refocuses only a note over the limit', () => {
  const { revealCaretInHugeNote } = load(['revealCaretInHugeNote'], { CHAR_MIRROR_FULL_LIMIT: FULL_LIMIT });
  const calls = [];
  const mk = (n, start, end, direction) => ({
    value: 'x'.repeat(n),
    selectionStart: start,
    selectionEnd: end,
    selectionDirection: direction,
    setSelectionRange: (s, e, d) => calls.push(`select ${s}-${e}${d ? ' ' + d : ''}`),
    blur: () => calls.push('blur'),
    focus: () => calls.push('focus'),
  });
  revealCaretInHugeNote(mk(FULL_LIMIT, 5, 9, 'forward'));
  assert.deepEqual(calls, [], 'at the limit: untouched');
  revealCaretInHugeNote(mk(FULL_LIMIT + 1, 5, 9, 'backward'));
  // Chromium scrolls to a collapsed caret on focus but not to a range: collapse, refocus, restore the range.
  assert.deepEqual(calls, ['select 5-5', 'blur', 'focus', 'select 5-9 backward']);
});

// ---------------------------------------------------------------------------
// Wiring: the hot paths use the shared helpers
// ---------------------------------------------------------------------------
check('updateLineNumbers, updateSecondaryLineNumbers and updateStatusBar use the shared helpers', () => {
  const lineNumbers = extractFunction(appCode, 'updateLineNumbers');
  assert.ok(lineNumbers.includes('countNewlines(editorEl.value)') && lineNumbers.includes('renderLineGutter(lineNumbersEl, lines, rows)'));
  assert.ok(!lineNumbers.includes('charCodeAt'), 'no per-character scan left');
  const secondary = extractFunction(appCode, 'updateSecondaryLineNumbers');
  assert.ok(secondary.includes('countNewlines(editorSecondary.value)') && secondary.includes('renderLineGutter(secondaryLineNumbers, lines, rows)'));
  assert.ok(!secondary.includes('charCodeAt'));
  const status = extractFunction(appCode, 'updateStatusBar');
  assert.ok(status.includes('1 + countNewlines(text, start)'));
  assert.ok(!status.includes('charCodeAt'));
  // The cachedLineCount = 0 "force a rebuild" call sites still work: the gutter compares with what it shows.
  assert.ok(/cachedLineCount = 0;\s*updateLineNumbers\(\)/.test(appCode));
});

check('the gutter is not rebuilt as one string any more, and nothing looks for per-line children in it', () => {
  assert.ok(!/lineNumbersEl\.textContent\s*=/.test(appCode), 'the gutter is only written through renderLineGutter');
  assert.ok(!/lineNumbersEl\.children/.test(appCode), 'flashEditorLine no longer indexes the gutter (its children are blocks of 1000 lines)');
});

check('position-based callers are hardened for estimated coordinates', () => {
  assert.ok(extractFunction(appCode, 'goToMatch').includes('revealCaretInHugeNote(editor)'));
  assert.ok(extractFunction(appCode, 'gotoLineNumber').includes('revealCaretInHugeNote(editor)'));
  assert.ok(appCode.includes('keepCoordsInView(getCharPixelCoords(targetCursor, editor), editor)'), 'inline prompt bar');
  assert.ok(appCode.includes('keepCoordsInView(getCharPixelCoords(editor.selectionEnd, editor), editor)'), 'Command Bar');
});

if (failures > 0) {
  console.error(`\n${failures} huge-note test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll huge-note tests passed with 0 error(s)!');
