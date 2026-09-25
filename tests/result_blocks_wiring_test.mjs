// Result blocks in the app: the green bars in the line-number gutter (updateResultAccent), the five commands
// (runResultAction, palette entries, shortcuts) and their wiring. The functions are cut out of app.js the way the
// other suites here do it and run against a small fake DOM / fake editor, so the numbers can be compared with the
// exact answer without a browser. (What it looks like on screen is not covered: see the notes in the commit.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');
const modCode = fs.readFileSync(path.resolve('frontend/js/result_blocks.js'), 'utf-8');
const indexHtml = fs.readFileSync(path.resolve('frontend/index.html'), 'utf-8');
const css = fs.readFileSync(path.resolve('frontend/css/style.css'), 'utf-8');
const i18nCode = fs.readFileSync(path.resolve('frontend/js/i18n.js'), 'utf-8');

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
  assert.ok(start !== -1, `function ${name} not found in app.js`);
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

function extractConst(source, name, open, close) {
  const start = source.indexOf(`const ${name} = `);
  assert.ok(start !== -1, `const ${name} not found`);
  const from = source.indexOf(open, start);
  let depth = 0;
  let i = from;
  for (; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1) + ';';
}

const i18nCtx = vm.createContext({});
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nCtx);
const I18N = i18nCtx.I18N;

// The real module, loaded the way the page loads it (a classic script that sets window.ResultBlocks).
function loadModule(ctx) {
  vm.runInContext(modCode, ctx);
  return ctx.window.ResultBlocks;
}

const OPEN = (id) => `<!-- md-memo:res ${id} -->`;
const CLOSE = '<!-- /md-memo:res -->';

// ---------------------------------------------------------------------------------------------------------
// A fake gutter: just enough DOM for updateResultAccent, with a log of every write.
// ---------------------------------------------------------------------------------------------------------
function fakeDom() {
  const log = [];
  let created = 0;
  function node(tag) {
    const n = {
      tag,
      className: '',
      style: new Proxy({}, { set(t, k, v) { t[k] = v; log.push(`style ${String(k)}=${v}`); return true; } }),
      children: [],
      parentNode: null,
      attrs: {},
      setAttribute(k, v) { n.attrs[k] = v; },
      appendChild(c) {
        if (c.tag === '#fragment') {
          for (const k of c.children) { k.parentNode = n; n.children.push(k); }
          c.children = [];
          log.push('append fragment');
          return c;
        }
        c.parentNode = n;
        n.children.push(c);
        log.push(`append ${c.className || c.tag}`);
        return c;
      },
      removeChild(c) {
        const i = n.children.indexOf(c);
        assert.ok(i >= 0, 'removeChild of a foreign node');
        n.children.splice(i, 1);
        c.parentNode = null;
        log.push(`remove ${c.className || c.tag}`);
        return c;
      },
      set textContent(v) { assert.equal(v, ''); for (const c of n.children) c.parentNode = null; n.children = []; log.push('clear'); },
      get textContent() { return ''; },
      clientWidth: 44
    };
    return n;
  }
  const document = {
    createElement(tag) { created++; return node(tag); },
    createDocumentFragment() { return node('#fragment'); }
  };
  return { log, node, document, createdCount: () => created };
}

// updateResultAccent with the two things it reads from the gutter code beside it (lineGutters, GUTTER_BLOCK_LINES).
function accentSource() {
  return [
    'const resultAccents = new WeakMap(); const lineGutters = new WeakMap(); const GUTTER_BLOCK_LINES = 1000;',
    extractFunction(appCode, 'gutterRowPitch'),
    extractFunction(appCode, 'updateResultAccent'),
    'globalThis.__update = updateResultAccent; globalThis.__lineGutters = lineGutters;'
  ].join('\n');
}

function accentEnv(styleOverride) {
  const dom = fakeDom();
  const style = Object.assign({ fontSize: '14px', lineHeight: '22.4px', paddingTop: '12px' }, styleOverride || {});
  const ctx = vm.createContext({ console, document: dom.document });
  ctx.window = ctx;
  ctx.getComputedStyle = () => style;
  loadModule(ctx);
  vm.runInContext(accentSource(), ctx);
  return { dom, style, ctx, update: ctx.__update, lineGutters: ctx.__lineGutters };
}

const barsOf = (el) => {
  const overlay = el.children.find((c) => c.className === 'result-accent');
  return overlay ? overlay.children.map((c) => ({ cls: c.className, top: c.style.top, height: c.style.height })) : null;
};

check('a note with no result block costs nothing: no element is created, nothing is measured or written', () => {
  const { dom, update, ctx } = accentEnv();
  let measured = 0;
  ctx.getComputedStyle = () => { measured++; return {}; };
  const gutter = dom.node('div');
  const editor = { value: 'plain note\nwith a [[ @llm task ]]\n<!-- md-memo:run a1 -->\nand no block' };
  update(gutter, editor, null);
  assert.equal(dom.createdCount(), 0);
  assert.equal(gutter.children.length, 0);
  assert.deepEqual(dom.log, []);
  assert.equal(measured, 0, 'the style is not even read');
});

check('the bars sit on the opener, the body and the closer line, below the gutter padding', () => {
  const { dom, update } = accentEnv();
  const gutter = dom.node('div');
  const editor = { value: ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\n') };
  update(gutter, editor, null);
  const overlay = gutter.children[0];
  assert.equal(overlay.className, 'result-accent');
  assert.equal(overlay.style.top, '12px', 'the overlay starts where the first number does');
  assert.equal(overlay.attrs['aria-hidden'], 'true');
  assert.deepEqual(barsOf(gutter), [
    { cls: 'result-accent-bar result-accent-open', top: '22.4px', height: '22.4px' },
    { cls: 'result-accent-bar result-accent-body', top: '44.8px', height: '44.8px' },
    { cls: 'result-accent-bar result-accent-close', top: '89.6px', height: '22.4px' }
  ]);
});

check('an unclosed block gets only its opener bar', () => {
  const { dom, update } = accentEnv();
  const gutter = dom.node('div');
  update(gutter, { value: ['a', OPEN('u'), 'half a result'].join('\n') }, null);
  assert.deepEqual(barsOf(gutter).map((b) => b.cls), ['result-accent-bar result-accent-open']);
});

check('nothing is rewritten while the bars stay where they are (typing inside a line, an unchanged layout)', () => {
  const { dom, update } = accentEnv();
  const gutter = dom.node('div');
  const editor = { value: ['a', OPEN('x'), 'one', CLOSE].join('\n') };
  update(gutter, editor, null);
  dom.log.length = 0;
  update(gutter, editor, null);
  editor.value = ['a more typed line', OPEN('x'), 'one more word', CLOSE].join('\n');
  update(gutter, editor, null);
  assert.deepEqual(dom.log, [], 'no DOM write');
  assert.equal(gutter.children.length, 1, 'one overlay');
});

check('a line added above moves the bars, a zoom changes their size, wrapped rows push them down', () => {
  const { dom, update, style } = accentEnv();
  const gutter = dom.node('div');
  const editor = { value: [OPEN('x'), 'one', CLOSE].join('\n') };
  update(gutter, editor, null);
  assert.equal(barsOf(gutter)[0].top, '0px');

  editor.value = 'new first line\n' + editor.value;
  update(gutter, editor, null);
  assert.equal(barsOf(gutter)[0].top, '22.4px', 'one line down');
  assert.equal(gutter.children.filter((c) => c.className === 'result-accent').length, 1, 'the same overlay is reused');

  style.fontSize = '20px';
  style.lineHeight = '32px'; // zoom
  update(gutter, editor, null);
  assert.deepEqual(barsOf(gutter).map((b) => [b.top, b.height]), [['32px', '32px'], ['64px', '32px'], ['96px', '32px']]);

  // the first line wraps onto three rows
  update(gutter, editor, new Uint32Array([3, 1, 1, 1]));
  assert.deepEqual(barsOf(gutter).map((b) => [b.top, b.height]), [['96px', '32px'], ['128px', '32px'], ['160px', '32px']]);
});

check('the bars use the row height the layout really gives (numbers block height / its rows), so they do not drift from the text', () => {
  const { dom, update, lineGutters } = accentEnv();
  // 14px * 1.6 is 22.4px in CSS, but the layout engine stacks rows of 1433/64 = 22.390625px: over 2,500 lines that is 23px
  const pitch = 22.390625;
  const px = (n) => Math.round(n * 100) / 100 + 'px';
  const gutter = dom.node('div');
  const numbers = dom.node('div');
  const setNumbers = (rowsInBlock, lines) => {
    numbers.getBoundingClientRect = () => ({ height: pitch * rowsInBlock });
    lineGutters.set(gutter, { blocks: [numbers], lines });
  };
  setNumbers(6, 6);
  update(gutter, { value: ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\n') }, null);
  assert.deepEqual(barsOf(gutter).map((b) => [b.top, b.height]), [[px(pitch), px(pitch)], [px(2 * pitch), px(2 * pitch)], [px(4 * pitch), px(pitch)]]);

  // wrapped rows: the block holds the sum of the rows
  setNumbers(1 + 1 + 3 + 1 + 2 + 1, 6);
  const rows = new Uint32Array([1, 1, 3, 1, 2, 1]);
  update(gutter, { value: ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\n') }, rows);
  assert.deepEqual(barsOf(gutter).map((b) => [b.top, b.height]), [[px(pitch), px(pitch)], [px(2 * pitch), px(4 * pitch)], [px(6 * pitch), px(2 * pitch)]]);

  // a long note: only the first block of 1000 numbers is measured, and it gives the pitch for every line
  const filler = Array.from({ length: 2500 }, (_, i) => 'line ' + i);
  const long = filler.concat([OPEN('z'), 'r', CLOSE]).join('\n');
  setNumbers(1000, 2503);
  update(gutter, { value: long }, null);
  assert.equal(barsOf(gutter)[0].top, px(2500 * pitch));
  assert.notEqual(barsOf(gutter)[0].top, px(2500 * 22.4), 'not the CSS line height times the line');

  // nothing measurable (no numbers yet, or a block with no height): the CSS line height is the fallback
  lineGutters.delete(gutter);
  update(gutter, { value: long }, null);
  assert.equal(barsOf(gutter)[0].top, px(2500 * 22.4));
  numbers.getBoundingClientRect = () => ({ height: 0 });
  lineGutters.set(gutter, { blocks: [numbers], lines: 2503 });
  update(gutter, { value: long }, null);
  assert.equal(barsOf(gutter)[0].top, px(2500 * 22.4));
});

check('a line-height that is not in px falls back to 1.6 times the font size, and a hidden gutter is left alone', () => {
  const { dom, update } = accentEnv({ lineHeight: 'normal', fontSize: '10px' });
  const gutter = dom.node('div');
  update(gutter, { value: [OPEN('x'), CLOSE].join('\n') }, null);
  assert.equal(barsOf(gutter)[0].height, '16px');

  const hidden = dom.node('div');
  hidden.clientWidth = 0;
  dom.log.length = 0;
  update(hidden, { value: [OPEN('x'), CLOSE].join('\n') }, null);
  assert.deepEqual(dom.log, []);
  assert.equal(hidden.children.length, 0);
});

check('the overlay goes when the last block does, and the number blocks beside it are untouched', () => {
  const { dom, update } = accentEnv();
  const gutter = dom.node('div');
  const numbers = dom.node('div'); // what renderLineGutter keeps in the gutter
  gutter.appendChild(numbers);
  const editor = { value: [OPEN('x'), 'one', CLOSE].join('\n') };
  update(gutter, editor, null);
  assert.equal(gutter.children.length, 2);
  assert.ok(gutter.children.includes(numbers));
  editor.value = 'one'; // the block was deleted by hand
  update(gutter, editor, null);
  assert.deepEqual(gutter.children, [numbers], 'only the numbers remain');
  dom.log.length = 0;
  update(gutter, editor, null);
  assert.deepEqual(dom.log, [], 'and a second look does nothing');
  // it comes back with the next block
  editor.value = [OPEN('y'), CLOSE].join('\n');
  update(gutter, editor, null);
  assert.equal(gutter.children.length, 2);
});

check('the primary and the secondary gutter keep their own overlays', () => {
  const { dom, update } = accentEnv();
  const g1 = dom.node('div');
  const g2 = dom.node('div');
  update(g1, { value: [OPEN('x'), CLOSE].join('\n') }, null);
  update(g2, { value: 'no block here' }, null);
  assert.equal(g1.children.length, 1);
  assert.equal(g2.children.length, 0);
  update(g2, { value: 'a\nb\n' + [OPEN('x'), CLOSE].join('\n') }, null);
  assert.equal(barsOf(g2)[0].top, '44.8px');
  assert.equal(barsOf(g1)[0].top, '0px', 'the first one is not disturbed');
});

check('without the module (a page that could not load it) the gutter just works', () => {
  const dom = fakeDom();
  const ctx = vm.createContext({ console, document: dom.document });
  ctx.window = ctx;
  vm.runInContext(accentSource(), ctx);
  const gutter = dom.node('div');
  ctx.__update(gutter, { value: [OPEN('x'), CLOSE].join('\n') }, null);
  ctx.__update(null, null, null);
  assert.equal(gutter.children.length, 0);
});

// ---------------------------------------------------------------------------------------------------------
// The commands, on a fake editor. insertTextWithUndo and execCommand('delete') edit the selection like the
// browser does, so the resulting text and caret can be compared.
// ---------------------------------------------------------------------------------------------------------
function commandEnv(text, caret, opts) {
  const o = opts || {};
  const messages = [];
  const calls = { goto: [], clipboard: [], notified: 0, undoSteps: 0, deleted: 0 };
  const editor = {
    value: text,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange(s, e) { editor.selectionStart = s; editor.selectionEnd = e; },
    focus() {}
  };
  const ctx = vm.createContext({
    console, Math, Promise,
    isPreviewMode: !!o.preview,
    editorEl: editor,
    document: {
      execCommand(cmd) {
        if (o.refuseEdits) return false;
        if (cmd !== 'delete') return false;
        editor.value = editor.value.slice(0, editor.selectionStart) + editor.value.slice(editor.selectionEnd);
        editor.selectionEnd = editor.selectionStart;
        calls.undoSteps++;
        calls.deleted++;
        return true;
      }
    },
    getActiveEditor: () => editor,
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    showMessage: (msg) => messages.push(msg),
    gotoLineNumber: (line) => calls.goto.push(line),
    scheduleUpdateStatusBar: () => {},
    // a thenable that answers at once, so the tests stay synchronous
    copyTextToClipboard: (s) => { calls.clipboard.push(s); return { then: (cb) => cb(!o.copyFails) }; },
    insertTextWithUndo: (s) => {
      if (o.refuseEdits) return;
      editor.value = editor.value.slice(0, editor.selectionStart) + s + editor.value.slice(editor.selectionEnd);
      editor.selectionStart = editor.selectionEnd = editor.selectionStart + s.length;
      calls.undoSteps++;
    },
    onEditorInput: () => { calls.notified++; },
    hideCursorAura: () => {},
    triggerCursorAuraDebounced: () => {},
    paletteDescWithShortcut: (descKey, actionKey) => `${descKey}|${actionKey}`
  });
  ctx.window = ctx;
  loadModule(ctx);
  vm.runInContext([
    extractFunction(appCode, 'replaceEditorRange'),
    extractFunction(appCode, 'runResultAction'),
    extractFunction(appCode, 'resultBlockPaletteCommands'),
    'globalThis.__run = runResultAction; globalThis.__palette = resultBlockPaletteCommands;'
  ].join('\n'), ctx);
  return { editor, messages, calls, run: ctx.__run, palette: ctx.__palette, ctx };
}

const NOTE = ['intro', OPEN('a'), 'first', 'result', CLOSE, 'middle', OPEN('b'), 'second', CLOSE, 'end'].join('\n');

check('next / previous go to the opener line (1-based), wrap around, and say which block it is', () => {
  const at = (needle) => NOTE.indexOf(needle);
  let env = commandEnv(NOTE, 0);
  env.run('resultNext');
  assert.deepEqual(env.calls.goto, [2]);
  assert.deepEqual(env.messages, ['resultAt:{"n":1,"total":2}']);

  env = commandEnv(NOTE, at('first'));
  env.run('resultNext');
  assert.deepEqual(env.calls.goto, [7], 'from inside block a: block b');

  env = commandEnv(NOTE, at('end'));
  env.run('resultNext');
  assert.deepEqual(env.calls.goto, [2], 'after the last one it wraps to the first');
  assert.deepEqual(env.messages, ['resultAt:{"n":1,"total":2}']);

  env = commandEnv(NOTE, at('middle'));
  env.run('resultPrev');
  assert.deepEqual(env.calls.goto, [2]);
  env = commandEnv(NOTE, 0);
  env.run('resultPrev');
  assert.deepEqual(env.calls.goto, [7], 'before the first it wraps to the last');
  assert.deepEqual(env.messages, ['resultAt:{"n":2,"total":2}']);
  assert.equal(env.editor.value, NOTE, 'the text is not touched');

  env = commandEnv('no block in this note', 3);
  env.run('resultNext');
  env.run('resultPrev');
  assert.deepEqual(env.calls.goto, []);
  assert.deepEqual(env.messages, ['resultNone', 'resultNone']);
});

check('copy puts the body, without the marker lines, on the clipboard', () => {
  const env = commandEnv(NOTE, NOTE.indexOf('result'));
  env.run('resultCopy');
  assert.deepEqual(env.calls.clipboard, ['first\nresult']);
  assert.deepEqual(env.messages, ['resultCopied']);
  assert.equal(env.editor.value, NOTE);
  // the caret on a marker line counts
  const onMarker = commandEnv(NOTE, NOTE.indexOf(OPEN('b')) + 4);
  onMarker.run('resultCopy');
  assert.deepEqual(onMarker.calls.clipboard, ['second']);
  const failing = commandEnv(NOTE, NOTE.indexOf('result'), { copyFails: true });
  failing.run('resultCopy');
  assert.deepEqual(failing.messages, ['resultCopyFailed']);
  const empty = commandEnv([OPEN('e'), CLOSE].join('\n'), 3);
  empty.run('resultCopy');
  assert.deepEqual(empty.calls.clipboard, [], 'nothing to copy: the clipboard is left alone');
  assert.deepEqual(empty.messages, ['resultEmptyBody']);
});

check('delete removes the whole block in ONE editing step and puts the caret where it stood', () => {
  const env = commandEnv(NOTE, NOTE.indexOf('result'));
  env.run('resultDelete');
  assert.equal(env.editor.value, ['intro', 'middle', OPEN('b'), 'second', CLOSE, 'end'].join('\n'));
  assert.equal(env.calls.undoSteps, 1);
  assert.equal(env.editor.selectionStart, 'intro\n'.length);
  assert.equal(env.editor.selectionEnd, env.editor.selectionStart);
  assert.ok(env.calls.notified >= 1, 'the app is told the text changed');
  assert.deepEqual(env.messages, ['resultDeleted']);

  // the last block of the note, no final line break: the break before it goes
  const last = commandEnv(['head', OPEN('z'), 'x', CLOSE].join('\n'), 12);
  last.run('resultDelete');
  assert.equal(last.editor.value, 'head');
  assert.equal(last.editor.selectionStart, 4);
});

check('confirm replaces the block by its body in ONE editing step', () => {
  const env = commandEnv(NOTE, NOTE.indexOf('first'));
  env.run('resultConfirm');
  assert.equal(env.editor.value, ['intro', 'first', 'result', 'middle', OPEN('b'), 'second', CLOSE, 'end'].join('\n'));
  assert.equal(env.calls.undoSteps, 1);
  assert.equal(env.editor.selectionStart, 'intro\n'.length, 'the caret is at the start of the kept text');
  assert.deepEqual(env.messages, ['resultConfirmed']);
  // an empty block: confirming removes it
  const empty = commandEnv(['a', OPEN('e'), CLOSE, 'b'].join('\n'), 4);
  empty.run('resultConfirm');
  assert.equal(empty.editor.value, 'a\nb');
  assert.equal(empty.calls.undoSteps, 1);
});

check('if the browser refuses the editing command, the text is still right (and the app is told)', () => {
  const env = commandEnv(NOTE, NOTE.indexOf('result'), { refuseEdits: true });
  env.run('resultDelete');
  assert.equal(env.editor.value, ['intro', 'middle', OPEN('b'), 'second', CLOSE, 'end'].join('\n'));
  assert.ok(env.calls.notified >= 1);
  const c = commandEnv(NOTE, NOTE.indexOf('result'), { refuseEdits: true });
  c.run('resultConfirm');
  assert.equal(c.editor.value, ['intro', 'first', 'result', 'middle', OPEN('b'), 'second', CLOSE, 'end'].join('\n'));
});

check('copy, delete and confirm with the caret outside a block, or in an unclosed one, do nothing but say so', () => {
  for (const action of ['resultCopy', 'resultDelete', 'resultConfirm']) {
    const outside = commandEnv(NOTE, NOTE.indexOf('middle'));
    outside.run(action);
    assert.equal(outside.editor.value, NOTE);
    assert.deepEqual(outside.messages, ['resultNoneAtCaret'], action);
    assert.deepEqual(outside.calls.clipboard, []);

    const text = ['top', OPEN('u'), 'half a result'].join('\n');
    const unclosed = commandEnv(text, 6);
    unclosed.run(action);
    assert.equal(unclosed.editor.value, text);
    assert.deepEqual(unclosed.messages, ['resultUnclosed'], action);
    assert.equal(unclosed.calls.undoSteps, 0);
  }
});

check('with the preview covering the editor every command only says so', () => {
  for (const action of ['resultNext', 'resultPrev', 'resultCopy', 'resultDelete', 'resultConfirm']) {
    const env = commandEnv(NOTE, NOTE.indexOf('result'), { preview: true });
    env.run(action);
    assert.equal(env.editor.value, NOTE);
    assert.deepEqual(env.messages, ['resultNeedsEditor'], action);
    assert.deepEqual(env.calls.goto, []);
    assert.deepEqual(env.calls.clipboard, []);
  }
});

check('the palette has the five commands, each with a line icon and the current key in its description', () => {
  const { palette } = commandEnv('x', 0);
  const items = Array.from(palette()); // (an array from the page's own realm: copy it for the strict comparisons)
  assert.deepEqual(items.map((i) => i.id), ['cmd_result_next', 'cmd_result_prev', 'cmd_result_copy', 'cmd_result_delete', 'cmd_result_confirm']);
  assert.deepEqual(items.map((i) => i.desc), [
    'cmdPaletteResultNextDesc|resultNext', 'cmdPaletteResultPrevDesc|resultPrev', 'cmdPaletteResultCopyDesc|resultCopy',
    'cmdPaletteResultDeleteDesc|resultDelete', 'cmdPaletteResultConfirmDesc|resultConfirm'
  ]);
  for (const item of items) {
    assert.ok(item.iconSvg.startsWith('<svg class="menu-icon"') && item.iconSvg.includes('stroke="currentColor"'), `${item.id} has a line icon`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(item.iconSvg + item.title), `${item.id}: no emoji`);
    assert.equal(typeof item.action, 'function');
  }
  const env = commandEnv(NOTE, 0);
  env.palette()[0].action();
  assert.deepEqual(env.calls.goto, [2], 'the entry runs its command');
});

// ---------------------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------------------
check('the gutter refresh paths of both editors draw the bars', () => {
  const primary = extractFunction(appCode, 'updateLineNumbers');
  assert.ok(primary.includes('updateResultAccent(lineNumbersEl, editorEl, rows)'));
  assert.ok(primary.includes('renderLineGutter(lineNumbersEl, lines, rows)'), 'the numbers are still rendered there');
  const secondary = extractFunction(appCode, 'updateSecondaryLineNumbers');
  assert.ok(secondary.includes('updateResultAccent(secondaryLineNumbers, editorSecondary, rows)'));
  // the bars follow the numbers even when the numbers themselves need no work (same line count, nothing wrapped)
  assert.ok(/if \(rows \|\| lines !== cachedLineCount \|\| isGutterWrapped\(lineNumbersEl\)\) \{[\s\S]*?\}\s*updateResultAccent\(/.test(primary));
  assert.ok(!/lineNumbersEl\.children/.test(appCode), 'nothing indexes the gutter children (the overlay is one of them)');
});

check('result_blocks.js is a script of the page, loaded before app.js', () => {
  const m = indexHtml.indexOf('<script src="js/result_blocks.js?v=1.0.0"></script>');
  const a = indexHtml.indexOf('<script src="js/app.js');
  assert.ok(m > 0 && a > m, 'result_blocks.js comes before app.js');
});

check('every theme has the three bar colors, and the gutter is the bars\' positioned parent', () => {
  for (const v of ['--result-open', '--result-body', '--result-close']) {
    for (const sel of ['body.dark-theme', 'body.theme-olive', 'body.theme-blue', 'body.theme-forest', 'body.theme-charcoal']) {
      const re = new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{[^}]*${v}:\\s*#[0-9a-fA-F]{6}`);
      assert.ok(re.test(css), `${sel} sets ${v}`);
    }
  }
  assert.ok(/#line-numbers \{[^}]*position: relative;/.test(css), '#line-numbers is position: relative');
  assert.ok(/\.secondary-editor-pane \.line-numbers \{[^}]*position: relative;/.test(css), 'and so is the secondary gutter');
  assert.ok(/\.result-accent \{[^}]*position: absolute;[^}]*left: 0;[^}]*width: 3px;/.test(css));
  assert.ok(/\.result-accent-open \{ background: var\(--result-open\); \}/.test(css));
  assert.ok(/\.result-accent-body \{ background: var\(--result-body\); \}/.test(css));
  assert.ok(/\.result-accent-close \{ background: var\(--result-close\); \}/.test(css));
  // the digits are right-aligned inside 6px of padding: a bar in the first 3px cannot touch one
  assert.ok(/#line-numbers \{[^}]*padding: 12px 6px;[^}]*text-align: right;/.test(css));
  // nothing is drawn behind or over the text: the bars are only in the gutter
  assert.ok(!/result-accent[^{]*\{[^}]*z-index/.test(css));
});

check('shortcuts: five actions, unassigned by default, listed in Settings, dispatched inside the editor branch', () => {
  const win = vm.runInNewContext(`(${extractConst(appCode, 'DEFAULT_SHORTCUTS_WIN', '{', '}').replace(/^const DEFAULT_SHORTCUTS_WIN = /, '').replace(/;$/, '')})`);
  const mac = vm.runInNewContext(`(${extractConst(appCode, 'DEFAULT_SHORTCUTS_MAC', '{', '}').replace(/^const DEFAULT_SHORTCUTS_MAC = /, '').replace(/;$/, '')})`);
  const keys = ['resultNext', 'resultPrev', 'resultCopy', 'resultDelete', 'resultConfirm'];
  for (const k of keys) {
    assert.equal(win[k], '', `Windows: ${k} has no default (Alt+Shift+Up/Down are the duplicate-line keys)`);
    assert.equal(mac[k], '', `macOS: ${k} has no default`);
  }
  assert.equal(win.duplicateLineUp, 'Shift+Alt+ArrowUp', 'the reason the pair is left unassigned');
  const groups = vm.runInNewContext(`(${extractConst(appCode, 'SHORTCUT_GROUPS', '[', ']').replace(/^const SHORTCUT_GROUPS = /, '').replace(/;$/, '')})`);
  const group = groups.find((g) => g.titleKey === 'shortcutGroupResult');
  assert.ok(group, 'a Result Blocks group');
  assert.deepEqual(Array.from(group.actions, (a) => a.key), keys);
  assert.match(appCode, /const RESULT_ACTIONS = \['resultNext', 'resultPrev', 'resultCopy', 'resultDelete', 'resultConfirm'\];/);
  const handler = appCode.slice(appCode.indexOf('if (isEditorActive) {'));
  const branch = handler.slice(0, handler.indexOf('// Escape priority order'));
  assert.match(branch, /RESULT_ACTIONS\.find\(\(a\) => matchShortcut\(e, config\.shortcuts && config\.shortcuts\[a\]\)\)/);
  assert.match(branch, /runResultAction\(resultAction\)/);
  assert.ok(appCode.includes('...resultBlockPaletteCommands(),'), 'the palette list includes the entries');
});

check('every string the feature uses exists in English and Japanese, without emoji', () => {
  const shortcutKeys = ['shortcutGroupResult', 'shortcutActionResultNext', 'shortcutActionResultPrev', 'shortcutActionResultCopy', 'shortcutActionResultDelete', 'shortcutActionResultConfirm'];
  const paletteKeys = ['Next', 'Prev', 'Copy', 'Delete', 'Confirm'].flatMap((n) => [`cmdPaletteResult${n}`, `cmdPaletteResult${n}Desc`]);
  const messageKeys = ['resultNone', 'resultAt', 'resultNoneAtCaret', 'resultUnclosed', 'resultEmptyBody', 'resultCopied', 'resultCopyFailed', 'resultDeleted', 'resultConfirmed', 'resultNeedsEditor'];
  for (const key of [...shortcutKeys, ...paletteKeys, ...messageKeys]) {
    for (const lang of ['en', 'ja']) {
      const v = I18N[lang][key];
      assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${key} exists`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(v), `${lang}.${key} has no emoji`);
    }
  }
  for (const n of ['Next', 'Prev', 'Copy', 'Delete', 'Confirm']) {
    for (const lang of ['en', 'ja']) assert.ok(I18N[lang][`cmdPaletteResult${n}Desc`].includes('{sc}'), `${lang} ${n}: the description shows the key`);
  }
  // every key used by the code is one of them
  const used = new Set();
  const sources = [extractFunction(appCode, 'runResultAction')];
  for (const src of sources) for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(m[1]);
  for (const key of used) assert.ok(I18N.en[key] && I18N.ja[key], `t('${key}') exists in both languages`);
  assert.equal(used.size, messageKeys.length, 'each message is used, and only those');
  // the confirm entry warns that task notation becomes live again
  assert.match(I18N.en.cmdPaletteResultConfirmDesc, /\[\[ @llm \.\.\. \]\]/);
  assert.match(I18N.en.cmdPaletteResultConfirmDesc, /live again/);
  assert.match(I18N.ja.cmdPaletteResultConfirmDesc, /\[\[ @llm \.\.\. \]\]/);
  assert.match(I18N.ja.cmdPaletteResultConfirmDesc, /また実行できる状態/);
  assert.match(I18N.en.resultConfirmed, /live again/);
});

if (failures > 0) {
  console.error(`\n${failures} result-block wiring test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll result-block wiring tests passed with 0 error(s)!');
