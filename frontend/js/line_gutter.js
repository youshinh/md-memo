// MD-Memo line-number gutter, wrapped lines. The gutter used to list 1..N one number per screen row,
// so as soon as a line wrapped every number below it sat next to the wrong line. This works out how
// many screen rows each logical line takes, so app.js can put its number on the line's first row and
// leave the wrapped rows blank.
//
// A textarea cannot be asked where it wrapped, so the rows are measured on a hidden copy of the long
// lines laid out like the textarea (same font, padding and width). Only lines that can possibly wrap
// are measured, and each result is remembered by the line's text, so typing re-measures the one line
// being edited. Nothing is created until a note has a line that can wrap.
(function (global) {
  'use strict';

  // Notes bigger than this keep the plain 1..N numbering: measuring means laying out a copy of the
  // long lines. Measured: about 0.1 ms per long line (0.8 ms per 1,000 characters of them), once - the
  // result is remembered per line - so a note at this size costs on the order of 100 ms to open or
  // to re-wrap after a resize, and one keystroke costs about 1 ms.
  const MAX_CHARS = 120000;
  const MAX_CACHE = 20000;

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // A UTF-16 unit is at most one em wide (a full-width character is exactly 1em; an emoji is two
  // units for about 1.5em), so a line of at most this many units fits on one row.
  function wrapUnits(contentWidth, fontSize) {
    if (!(contentWidth > 0) || !(fontSize > 0)) return 0;
    return Math.floor(contentWidth / fontSize);
  }

  // Walks the lines of `text` once. Returns { lines, long } where lines is the number of logical
  // lines and long lists the ones that might wrap - { i: 0-based line, s: its text }. A tab counts as
  // tabSize units.
  function findLongLines(text, units, tabSize) {
    const long = [];
    let lines = 0;
    let start = 0;
    let nextTab = text.indexOf('\t');
    const tabExtra = (tabSize > 1 ? tabSize : 4) - 1;
    for (;;) {
      let end = text.indexOf('\n', start);
      if (end === -1) end = text.length;
      let len = end - start;
      if (nextTab !== -1 && nextTab < start) nextTab = text.indexOf('\t', start);
      if (nextTab !== -1 && nextTab < end) {
        for (let p = nextTab; p !== -1 && p < end; p = text.indexOf('\t', p + 1)) len += tabExtra;
      }
      if (len > units) long.push({ i: lines, s: text.slice(start, end) });
      lines++;
      if (end >= text.length) break;
      start = end + 1;
    }
    return { lines: lines, long: long };
  }

  // The gutter text of logical lines from..to-1 (0-based): each number, then one blank row for every
  // extra screen row the line takes. Ends with a newline, which does not add a row.
  function gutterBlockText(from, to, rows) {
    let s = '';
    for (let i = from; i < to; i++) {
      s += (i + 1) + '\n';
      for (let k = rows[i]; k > 1; k--) s += '\n';
    }
    return s;
  }

  // ---- measuring -------------------------------------------------------------------------------

  const states = new WeakMap(); // editor -> { mirror, cache, sig }

  function stateOf(editor) {
    let st = states.get(editor);
    if (!st) {
      st = { mirror: null, cache: new Map(), sig: '' };
      states.set(editor, st);
    }
    return st;
  }

  function makeMirror() {
    const m = global.document.createElement('div');
    m.setAttribute('aria-hidden', 'true');
    const s = m.style;
    s.position = 'absolute';
    s.visibility = 'hidden';
    s.pointerEvents = 'none';
    s.top = '0';
    s.left = '-99999px';
    s.height = 'auto';
    s.overflow = 'visible';
    s.boxSizing = 'border-box';
    global.document.body.appendChild(m);
    return m;
  }

  // Lays the missing lines out at the textarea's width and reads back how many rows each took.
  function measure(editor, st, cs, width, lineHeight, missing, rows) {
    if (!st.mirror) st.mirror = makeMirror();
    const m = st.mirror;
    const s = m.style;
    s.width = width + 'px';
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.fontWeight = cs.fontWeight;
    s.lineHeight = cs.lineHeight;
    s.letterSpacing = cs.letterSpacing;
    s.padding = cs.padding;
    s.tabSize = cs.tabSize;
    s.whiteSpace = cs.whiteSpace;
    s.wordBreak = cs.wordBreak;
    s.overflowWrap = cs.overflowWrap;
    m.textContent = '';
    const frag = global.document.createDocumentFragment();
    for (let k = 0; k < missing.length; k++) {
      const div = global.document.createElement('div');
      div.textContent = missing[k].s;
      frag.appendChild(div);
    }
    m.appendChild(frag);
    const kids = m.children;
    for (let k = 0; k < missing.length; k++) {
      const r = Math.max(1, Math.round(kids[k].getBoundingClientRect().height / lineHeight));
      rows[missing[k].i] = r;
      st.cache.set(missing[k].s, r);
    }
    m.textContent = '';
  }

  // Rows per logical line (Uint32Array, one entry per line) for `editor`'s text as it is laid out now,
  // or null when the plain 1..N numbering is already right: no line can wrap, the note is too big,
  // or the editor is not on screen.
  function rowsFor(editor) {
    if (!editor || !global.document || typeof global.getComputedStyle !== 'function') return null;
    const text = editor.value;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CHARS) return null;
    const width = editor.clientWidth;
    if (!(width > 0)) return null;
    const cs = global.getComputedStyle(editor);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const tabSize = parseInt(cs.tabSize, 10) || 4;
    const scan = findLongLines(text, wrapUnits(width - padX, fontSize), tabSize);
    if (scan.long.length === 0) return null;

    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.6;
    const st = stateOf(editor);
    const sig = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.tabSize,
      cs.padding, cs.whiteSpace, cs.wordBreak, cs.overflowWrap, width].join('|');
    if (st.sig !== sig || st.cache.size > MAX_CACHE) {
      st.cache.clear();
      st.sig = sig;
    }
    const rows = new Uint32Array(scan.lines).fill(1);
    const missing = [];
    for (let k = 0; k < scan.long.length; k++) {
      const hit = st.cache.get(scan.long[k].s);
      if (hit !== undefined) rows[scan.long[k].i] = hit;
      else missing.push(scan.long[k]);
    }
    if (missing.length) measure(editor, st, cs, width, lineHeight, missing, rows);
    return rows;
  }

  global.LineGutter = { rowsFor: rowsFor, gutterBlockText: gutterBlockText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      wrapUnits: wrapUnits,
      findLongLines: findLongLines,
      gutterBlockText: gutterBlockText,
      rowsFor: rowsFor
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
