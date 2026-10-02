// Regressions of the editor / find and replace / paste group of the exploratory review (docs/testing/sessions, 2026-09-30). Every check
// failed before its fix. Two kinds, both hermetic (no browser, no real config, nothing launched):
//   - pure helpers cut out of app.js and run in a vm context (the find regex, the character count, the gutter digits ...)
//   - the real app.js against the hand-made DOM of tests/fixtures/slot_env.mjs, with textareas that behave like Chromium's in the two
//     ways these bugs depend on (assigning .value puts the caret at the end; setRangeText keeps it in step)
//
//   C4-05  ^ and $ in the find regex are the start and end of a LINE
//   C4-06  "whole word" works for Japanese words and emoji (it is not \b)
//   C4-16  an emoji is one character to the find regex (unicode mode); a pattern that is only valid without it still works
//   C4-07  the line-number gutter widens from five digits on (10,000 lines), so the last digit is not cut off
//   C4-09  the live preview waits longer after a slow render
//   C4-12  the other pane's caret stays where it was when the same note is changed in this pane (typing, an answer)  [C5-05 is the same]
//   C4-18  "N chars" counts characters, not UTF-16 units (an emoji is one)
//   C4-19  the cursor aura is skipped when the caret's own line is huge
//   C3-10  the Enter that confirms an IME conversion does not search / replace / run a palette command
//   C8-10  the waiting text of a pasted image names the model that reads it
//   C8-11  an image being read is in the task panel and can be cancelled there
//   C8-12  a dropped file that is not text does not become a note
//   C8-13  files copied in a file manager and pasted are handled like a drop of the same files
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createEnv, assert, I18N } from './fixtures/slot_env.mjs';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appCode = read('frontend/js/app.js');
const cssCode = read('frontend/css/style.css');

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

const constOf = (name) => {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(appCode);
  assert.ok(m, `const ${name} not found`);
  return Number(m[1]);
};

// names: functions of app.js to load; extra: globals / let-declarations the functions use; returns what they export
function loadPure(names, extra = {}, prelude = '') {
  const context = vm.createContext(Object.assign({ console }, extra));
  vm.runInContext(`${prelude}\n${names.map((n) => extractFunction(appCode, n)).join('\n')}\nglobalThis.__h = { ${names.join(', ')} };`, context);
  return context.__h;
}

const FIND = ['buildFindRegex', 'isWholeWordMatch', 'scanFindMatches', 'expandReplacement'];
const find = loadPure(FIND);

// every [index, text] of a search, the way searchMatches collects them (a hung loop is cut off by the vm timeout)
function search(text, query, { regex = false, caseSensitive = false, word = false } = {}) {
  const context = vm.createContext({ find, text, query, regex, caseSensitive, word });
  const result = vm.runInContext(`
    const out = [];
    find.scanFindMatches(text, find.buildFindRegex(query, regex, caseSensitive), word, (m) => out.push([m.index, m[0]]));
    out;`, context, { timeout: 3000 });
  return Array.from(result, (m) => [m[0], m[1]]); // (host arrays: deepEqual compares prototypes)
}

check('C4-05: ^ and $ are the start and end of a line', () => {
  const note = 'Line one\nLine two\nLine three';
  assert.deepEqual(search(note, '^Line', { regex: true }).map((m) => m[0]), [0, 9, 18], '^Line is on every line');
  assert.deepEqual(search('Line one\nLine two\n', 'one$', { regex: true }), [[5, 'one']], 'one$ is the end of the first line');
  assert.equal(search('a\n\nb', '^$', { regex: true }).length, 1, 'an empty line is ^$');
  // the plain mode is not touched by it (the query is escaped)
  assert.deepEqual(search('a^b\na$c', '^', {}).map((m) => m[0]), [1], 'a ^ typed in plain mode is a character');
});

check('C4-16: an emoji is one character: [😀] and . do not see its halves', () => {
  assert.deepEqual(search('a😀b', '[😀]', { regex: true }), [[1, '😀']], 'one match, the whole emoji');
  assert.deepEqual(search('a😀b', '.', { regex: true }).map((m) => m[1]), ['a', '😀', 'b']);
  assert.deepEqual(search('😀😀', 'x*', { regex: true }).map((m) => m[0]), [0, 2, 4], 'empty matches step over a whole emoji (no endless loop)');
  assert.equal(search('😀', '😀', {}).length, 1, 'a plain search is as before');
  // a pattern that is only valid without the u flag still works (an unnecessary escape, a bare {)
  assert.equal(search('a-b', '\\-', { regex: true }).length, 1, 'a stray \\- is fine');
  assert.equal(search('a{b', '{', { regex: true }).length, 1, 'a bare { is fine');
  assert.throws(() => search('x', '(', { regex: true }), 'a broken pattern still throws (the box shows "!")');
  // the case switch
  assert.equal(search('Foo foo', 'foo', {}).length, 2);
  assert.equal(search('Foo foo', 'foo', { caseSensitive: true }).length, 1);
});

check('C4-06: whole word is not \\b: Japanese words and emoji count', () => {
  const note = 'これは日本語です。 a 日本語 b 😀 😀x';
  assert.deepEqual(search(note, '日本語', { word: true }).map((m) => m[0]), [12], 'only the one that stands apart: the other sits inside a sentence');
  assert.ok(search(note, '😀', { word: true }).length >= 1, 'an emoji between spaces is a word');
  assert.equal(search(note, '日本語', {}).length, 2, 'without the switch both are found');
  // the ASCII behaviour is kept
  assert.deepEqual(search('foo foobar barfoo foo', 'foo', { word: true }).map((m) => m[0]), [0, 18]);
  assert.deepEqual(search('foo_bar foo', 'foo', { word: true }).map((m) => m[0]), [8], '_ is a word character');
  assert.deepEqual(search('x.foo .foo', '.foo', { word: true }).map((m) => m[0]), [1, 6], 'an edge that is not a word character is always a boundary');
  assert.deepEqual(search('東京都 京都', '京都', { word: true }).map((m) => m[0]), [4], '京都 inside 東京都 is not a word');
  assert.deepEqual(search('café cafe', 'cafe', { word: true }).map((m) => m[0]), [5], 'é is a letter');
  assert.equal(search('abc', '', { word: true, regex: true }).length, 0, 'empty matches are never words');
  // regex mode: the match found is checked, the pattern is not wrapped (so an alternation is not cut in two)
  assert.deepEqual(search('cat dog cats', 'cat|dog', { regex: true, word: true }).map((m) => m[1]), ['cat', 'dog']);
});

check('Replace all (whole word) expands $1 / $& like String.replace, and leaves plain text alone', () => {
  const { expandReplacement } = find;
  const m = /(\w+)@(\w+)/.exec('mail bob@host now');
  assert.equal(expandReplacement('$2:$1', m, 'mail bob@host now'), 'host:bob');
  assert.equal(expandReplacement('[$&]', m, 'mail bob@host now'), '[bob@host]');
  assert.equal(expandReplacement('$$ $0 $3 $`|$\'', m, 'mail bob@host now'), '$ $0 $3 mail | now');
  assert.equal(expandReplacement('$11', m, 'mail bob@host now'), 'bob1', 'no group 11: group 1, then a 1 (as String.replace)');
  const named = /(?<user>\w+)@/.exec('bob@x');
  assert.equal(expandReplacement('<$<user>>', named, 'bob@x'), '<bob>');
  assert.equal(expandReplacement('$<nope>', m, 'x'), '$<nope>', 'no named groups: literal');
});

check('C4-18: the character count is characters, not UTF-16 units', () => {
  const { countChars } = loadPure(['countChars']);
  assert.equal(countChars(''), 0);
  assert.equal(countChars('hello\nあい'), 8);
  assert.equal(countChars('😀'.repeat(300) + '\nnext'), 305, 'the finding: 300 emoji and "next" read "605 chars"');
  assert.equal(countChars('a😀b'), 3);
  assert.equal(countChars('\uD83D'), 1, 'a lone half counts as one');
  assert.equal(countChars('\uD83Dx'), 2);
  assert.equal(countChars('👨‍👩‍👧'), 5, 'a ZWJ family is its five code points');
});

check('C4-19: the cursor aura gives up when the caret line is huge', () => {
  const api = loadPure(['charMirrorWindowStart', 'caretLineTooLong'], {
    CHAR_MIRROR_FULL_LIMIT: constOf('CHAR_MIRROR_FULL_LIMIT'),
    CHAR_MIRROR_WINDOW_CHARS: constOf('CHAR_MIRROR_WINDOW_CHARS')
  });
  const huge = 'x'.repeat(200000);
  assert.equal(api.caretLineTooLong(huge, huge.length), true, 'one 200,000 character line, caret at its end');
  assert.equal(api.caretLineTooLong(huge, 100000), true, 'or in the middle of it');
  assert.equal(api.caretLineTooLong(huge, 100), false, 'near the start of the line the window is small');
  assert.equal(api.caretLineTooLong('short line\n'.repeat(30000), 150000), false, 'a big note of short lines is as before');
  assert.equal(api.caretLineTooLong(huge + '\nshort', huge.length + 7), false, 'the caret on a short line after a huge one');
  assert.equal(api.caretLineTooLong('x'.repeat(100000), 100000), false, 'a note under the huge limit is never skipped');
});

check('C4-09: the live preview waits three times what the last render cost', async () => {
  let clock = 0;
  const timers = [];
  const rendered = [];
  const context = {
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    isPreviewMode: false,
    isSplitMode: true,
    secondaryViewMode: 'preview',
    renderPreview: async () => {},
    renderSecondaryPreview: async () => { rendered.push(clock); clock += context.__cost; }
  };
  context.__cost = 0;
  const api = loadPure(['livePreviewDelay', 'debouncedLivePreview'], context, 'let livePreviewTimer = null; let livePreviewCostMs = 0;');
  assert.equal(api.livePreviewDelay(0), 120, 'a small note: as before');
  assert.equal(api.livePreviewDelay(10), 120);
  assert.equal(api.livePreviewDelay(500), 1500);
  assert.equal(api.livePreviewDelay(5000), 2000, 'but never more than two seconds');
  api.debouncedLivePreview();
  assert.equal(timers[0].ms, 120);
  context.__cost = 1500; // the render of a 40,000-line note
  await timers[0].fn();
  api.debouncedLivePreview();
  assert.equal(timers[1].ms, 2000, 'the next one waits (1500 ms x 3, at most 2000)');
  context.__cost = 5;
  await timers[1].fn();
  api.debouncedLivePreview();
  assert.equal(timers[2].ms, 120, 'and a fast render brings it back');
});

check('C4-07: the gutter widens from five digits on', () => {
  const fake = () => {
    const el = { style: {}, children: [] };
    Object.defineProperty(el, 'textContent', { set(v) { el.children = []; }, get() { return ''; } });
    el.appendChild = (c) => { el.children.push(c); return c; };
    el.removeChild = (c) => { el.children.splice(el.children.indexOf(c), 1); return c; };
    return el;
  };
  const document = { createElement: () => ({ textContent: '' }) };
  const { renderLineGutter } = loadPure(['renderLineGutter'], { document, GUTTER_BLOCK_LINES: constOf('GUTTER_BLOCK_LINES'), lineGutters: new WeakMap() });
  const el = fake();
  renderLineGutter(el, 1, null);
  assert.equal(el.style.minWidth, '', 'a short note: the 44px of the stylesheet');
  renderLineGutter(el, 9999, null);
  assert.equal(el.style.minWidth, '', 'four digits fit in 44px');
  renderLineGutter(el, 10000, null);
  assert.equal(el.style.minWidth, 'calc(13px + 5ch)', 'five digits: padding, border and five characters');
  renderLineGutter(el, 99999, null);
  assert.equal(el.style.minWidth, 'calc(13px + 5ch)');
  renderLineGutter(el, 1000000, null);
  assert.equal(el.style.minWidth, 'calc(13px + 7ch)');
  renderLineGutter(el, 20, null);
  assert.equal(el.style.minWidth, '', 'and back again');
  // the fixed width the stylesheet gives both gutters is what this widens
  assert.ok(/#line-numbers \{[^}]*width: 44px;/.test(cssCode) && /\.secondary-editor-pane \.line-numbers \{[^}]*width: 44px;/.test(cssCode));
  // a gutter with no style object (a test's stand-in) is left alone
  renderLineGutter({ children: [], appendChild(c) { return c; }, set textContent(v) {} }, 50000, null);
});

check('C8-10: the image wait names Gemini or the model that is set', () => {
  const label = (vision) => loadPure(['visionTargetLabel'], { config: { vision } }).visionTargetLabel();
  assert.equal(label({ baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest' }), 'Gemini');
  assert.equal(label({ baseUrl: '', model: '' }), 'Gemini', 'an empty URL is Gemini (the default)');
  assert.equal(label({ baseUrl: 'http://localhost:11434', model: 'qwen2.5vl:7b' }), 'qwen2.5vl:7b');
  assert.equal(label({ baseUrl: 'http://192.168.0.5:1234/v1', model: '' }), '192.168.0.5:1234', 'no model name: the host');
  assert.equal(label(undefined), 'Gemini');
  for (const lang of ['en', 'ja']) assert.ok(I18N[lang].ocrTranscribingAnchor.includes('{target}'), `${lang}: the text has the place for the name`);
  assert.ok(!/Gemini/.test(I18N.en.ocrTranscribingAnchor + I18N.ja.ocrTranscribingAnchor), 'and does not hard-code it');
});

check('C8-13: files alone on the clipboard are an action of their own', () => {
  const { decidePasteAction } = loadPure(['decidePasteAction']);
  const files = { types: ['Files'], hasFiles: true, canReadClipboard: true, htmlAsMarkdown: true };
  assert.equal(decidePasteAction(files), 'insertFiles', 'Explorer copy of a PDF');
  assert.equal(decidePasteAction(Object.assign({}, files, { special: true })), 'insertFiles', 'also with Ctrl+Shift+V');
  assert.equal(decidePasteAction(Object.assign({}, files, { htmlAsMarkdown: false })), 'insertFiles');
  assert.equal(decidePasteAction(Object.assign({}, files, { types: ['Files', 'text/plain'] })), 'default', 'with text beside them: text');
  assert.equal(decidePasteAction(Object.assign({}, files, { types: ['Files', 'text/html'], structured: true })), 'htmlToMd', 'with HTML beside them: the HTML');
  assert.equal(decidePasteAction(Object.assign({}, files, { hasImage: true, ocrEnabled: true, visionReady: true })), 'ocr', 'a picture file is still read');
  assert.equal(decidePasteAction({ types: ['Files'], hasFiles: false }), 'default', 'a clipboard that says Files but has none');
  assert.equal(decidePasteAction({ types: ['text/plain'] }), 'default');
});

check('C8-12: a dropped file is opened as a note only when it looks like text', async () => {
  const { looksLikeTextFile } = loadPure(['looksLikeTextFile'], { Uint8Array });
  const file = (name, type, bytes) => ({ name, type, slice: () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }) });
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D];
  assert.equal(await looksLikeTextFile(file('shot.png', 'image/png', png)), false, 'a picture by its type');
  assert.equal(await looksLikeTextFile(file('shot', '', png)), false, 'a picture with no type: its bytes');
  assert.equal(await looksLikeTextFile(file('zeros.bin', '', new Array(8192).fill(0))), false, 'zeros');
  assert.equal(await looksLikeTextFile(file('a.md', 'text/markdown', [...Buffer.from('# Title\nbody あ')])), true);
  assert.equal(await looksLikeTextFile(file('a.txt', '', [])), true, 'an empty file is a note');
  assert.equal(await looksLikeTextFile(file('u16.txt', 'text/plain', [0xFF, 0xFE, 0x41, 0x00])), true, 'UTF-16 with its byte order mark is let through');
  assert.equal(await looksLikeTextFile({ name: 'x', type: '' }), true, 'a file that cannot be sniffed is left to the read that follows');
  // the drop handler asks before it reads, and says so when it declines
  const handler = appCode.slice(appCode.indexOf("window.addEventListener('drop'"));
  const asks = handler.indexOf('looksLikeTextFile(file)');
  assert.ok(asks !== -1 && asks < handler.indexOf('file.text()'), 'looksLikeTextFile is asked before file.text()');
  assert.ok(handler.slice(asks, handler.indexOf('file.text()')).includes("t('dropNotTextFile'"), 'and the person is told');
  for (const lang of ['en', 'ja']) assert.ok(I18N[lang].dropNotTextFile.includes('{name}'), `${lang}: the message names the file`);
});

// ---------------------------------------------------------------------------------------------------
// The real app.js
// ---------------------------------------------------------------------------------------------------
class FileReaderStub {
  readAsDataURL(blob) {
    this.result = 'data:' + (blob.type || 'image/png') + ';base64,AAAA';
    Promise.resolve().then(() => { if (this.onloadend) this.onloadend(); });
  }
}

// A textarea the way Chromium has it, where the tests depend on it: assigning .value puts the caret at the end, and setRangeText with
// 'preserve' moves a selection that lies after the replaced stretch by the change and one inside it to the start of it.
function chromiumTextarea(el) {
  let raw = String(el.value || '');
  Object.defineProperty(el, 'value', {
    get: () => raw,
    set: (v) => { raw = String(v); el.selectionStart = el.selectionEnd = raw.length; },
    configurable: true
  });
  el.assignments = 0;
  el.setRangeText = (text, start, end, mode) => {
    const delta = text.length - (end - start);
    const move = (p) => (p > end ? p + delta : p > start ? start : p);
    const s = el.selectionStart;
    const e = el.selectionEnd;
    raw = raw.slice(0, start) + text + raw.slice(end);
    el.assignments++;
    if (mode === 'preserve') {
      el.selectionStart = move(s);
      el.selectionEnd = move(e);
    } else {
      el.selectionStart = el.selectionEnd = raw.length;
    }
  };
  return el;
}

async function setup(opts = {}) {
  const vision = [];
  const env = await createEnv({
    language: opts.language || 'en',
    globals: { FileReader: FileReaderStub },
    backend: Object.assign({
      saveFile: async () => {},
      queryVisionAsync: (reqId, prompt, base64, mime) => { vision.push({ reqId, prompt, base64, mime }); }
    }, opts.backend)
  });
  env.vision = vision;
  env.window.ScrapQuote = { searchSeed: () => '', seedFromSelection: () => '' }; // (the find box starts empty; the page's module is not part of the fixture)
  chromiumTextarea(env.editor);
  chromiumTextarea(env.el('editor-secondary'));
  for (const ed of [env.editor, env.el('editor-secondary')]) ed.getClientRects = () => [{ width: 600, height: 400 }]; // shown, not hidden
  env.tab = env.bridge.getActiveTab();
  env.setNote(opts.note === undefined ? '' : opts.note);
  env.tab.content = env.editor.value;
  return env;
}

const noteText = (env) => env.bridge.getTabText(env.tab.id);
const KEYS = {
  find: { key: 'f', code: 'KeyF', keyCode: 70, ctrlKey: true },
  replace: { key: 'h', code: 'KeyH', keyCode: 72, ctrlKey: true },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 }
};

// opens the find (and replace) bar, types the query / replacement, sets the toggles; returns the count text
function openFind(env, { replace = false, query = '', replacement = '', regex = false, word = false, caseSensitive = false } = {}) {
  env.key(env.editor, replace ? KEYS.replace : KEYS.find);
  assert.ok(!env.hidden('find-replace-bar'), 'the find bar opened');
  const on = (id) => env.el(id).classList.contains('active');
  if (regex !== on('btn-find-regex')) env.el('btn-find-regex').onclick();
  if (word !== on('btn-find-word')) env.el('btn-find-word').onclick();
  if (caseSensitive !== on('btn-find-case')) env.el('btn-find-case').onclick();
  env.el('find-input').value = query;
  env.el('replace-input').value = replacement;
  env.el('find-input').dispatchEvent({ type: 'input' });
  env.fireTimers(120);
  return env.el('find-count').textContent;
}

check('C4-05 / C4-16 / C4-06 through the find bar: the counts, and Replace all', async () => {
  const env = await setup({ note: 'Line one\nLine two\nLine three' });
  assert.equal(openFind(env, { query: '^Line', regex: true }), '1/3', 'the finding: 3 lines, 3 matches');
  env.el('find-input').value = 'one$';
  env.el('find-input').dispatchEvent({ type: 'input' });
  env.fireTimers(120);
  assert.equal(env.el('find-count').textContent, '1/1');
  env.el('find-input').value = '^Line';
  env.el('replace-input').value = 'X';
  env.el('btn-replace-all').onclick();
  assert.equal(noteText(env), 'X one\nX two\nX three');

  const emoji = await setup({ note: 'a😀b' });
  assert.equal(openFind(emoji, { query: '[😀]', replacement: 'X', regex: true }), '1/1', 'one emoji, one match');
  emoji.el('btn-replace-all').onclick();
  assert.equal(noteText(emoji), 'aXb', 'not aXXb');

  const words = await setup({ note: 'これは日本語です。 a 日本語 b 😀' });
  assert.equal(openFind(words, { query: '日本語', word: true }), '1/1');
  words.el('find-input').value = '😀';
  words.el('find-input').dispatchEvent({ type: 'input' });
  words.fireTimers(120);
  assert.equal(words.el('find-count').textContent, '1/1', 'an emoji between a space and the end');
  words.el('find-input').value = '日本語';
  words.el('replace-input').value = 'JP';
  words.el('btn-replace-all').onclick();
  assert.equal(noteText(words), 'これは日本語です。 a JP b 😀', 'Replace all takes the same one match the search counted');

  const regexWord = await setup({ note: 'ab 12 cd34 56' });
  openFind(regexWord, { query: '(\\d)(\\d)', replacement: '$2$1', regex: true, word: true });
  regexWord.el('btn-replace-all').onclick();
  assert.equal(noteText(regexWord), 'ab 21 cd34 65', 'regex + whole word: $1 $2 are expanded, cd34 is not a word');
});

check('C3-10: the Enter that confirms an IME conversion belongs to the IME (find, replace, palette)', async () => {
  const env = await setup({ note: 'foo bar foo' });
  openFind(env, { query: 'foo', replace: true, replacement: 'X' });
  env.editor.selectionStart = env.editor.selectionEnd = 11;
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    const ev = env.key('find-input', Object.assign({}, KEYS.enter, ime));
    assert.ok(!ev.defaultPrevented, 'not handled: ' + JSON.stringify(ime));
    assert.equal(env.editor.selectionStart, 11, 'the match was not selected: ' + JSON.stringify(ime));
    const rev = env.key('replace-input', Object.assign({}, KEYS.enter, ime));
    assert.ok(!rev.defaultPrevented);
    assert.equal(noteText(env), 'foo bar foo', 'nothing was replaced: ' + JSON.stringify(ime));
  }
  // the same keys without a composition are answered
  const next = env.key('find-input', KEYS.enter);
  assert.ok(next.defaultPrevented, 'Enter finds the next match');
  assert.equal(env.editor.selectionStart, 0);
  const rep = env.key('replace-input', KEYS.enter);
  assert.ok(rep.defaultPrevented);
  assert.equal(noteText(env), 'X bar foo', 'and Enter in the replace box replaces');

  env.window.__testHelper.openQuickPick();
  assert.ok(!env.hidden('quick-pick-modal'), 'the palette is open');
  env.key('quick-pick-input', Object.assign({}, KEYS.enter, { isComposing: true }));
  assert.ok(!env.hidden('quick-pick-modal'), 'a conversion Enter does not run (and close) it');
  env.key('quick-pick-input', Object.assign({}, KEYS.enter, { keyCode: 229 }));
  assert.ok(!env.hidden('quick-pick-modal'), 'on macOS too');
});

check('C4-12: typing in one pane leaves the caret of the other pane where it was', async () => {
  const env = await setup({ note: 'line one\nline two\nline three\nline four' });
  const right = env.el('editor-secondary');
  await env.window.__testHelper.openSplitEditor(env.tab.id); // the same note on both sides
  assert.equal(right.value, env.editor.value, 'the same note on both sides');
  right.selectionStart = right.selectionEnd = 14;
  env.editor.selectionStart = env.editor.selectionEnd = env.editor.value.length;
  env.window.document.activeElement = env.editor;
  const assignments = right.assignments;
  env.editor.value = env.editor.value + 'XY'; // typed at the end of the left pane
  env.editor.dispatchEvent({ type: 'input' });
  await env.flush();
  assert.ok(right.value.endsWith('line fourXY'), 'the right pane shows the new text');
  assert.equal(right.selectionStart, 14, 'the right caret did not jump to the end');
  assert.equal(right.selectionEnd, 14);
  assert.ok(right.assignments > assignments, 'it went through setRangeText');
  // typing before the right caret moves it along with the text
  env.editor.setRangeText('>>', 0, 0, 'end');
  env.editor.dispatchEvent({ type: 'input' });
  await env.flush();
  assert.equal(right.selectionStart, 16, 'text before the caret pushes it along');
  // and the other way round: typing in the right pane keeps the left caret
  env.editor.selectionStart = env.editor.selectionEnd = 3;
  right.selectionStart = right.selectionEnd = right.value.length;
  env.window.document.activeElement = right;
  right.value = right.value + 'Z';
  right.dispatchEvent({ type: 'input' });
  await env.flush();
  assert.ok(env.editor.value.endsWith('XYZ'));
  assert.equal(env.editor.selectionStart, 3, 'the left caret stayed too');
});

check('C5-05: an answer for the left pane leaves the right pane caret in step, not at the end', async () => {
  const env = await setup({ note: 'question\nsecond line here\nthird line here\n' });
  const right = env.el('editor-secondary');
  await env.window.__testHelper.openSplitEditor(env.tab.id);
  env.editor.selectionStart = 0;
  env.editor.selectionEnd = 8;
  env.window.document.activeElement = env.editor;
  env.editor.dispatchEvent({ type: 'focus' }); // the left pane is the one being worked in (opening the split had put the work in the right one)
  env.key(env.editor, { key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true });
  env.el('inline-prompt-input').value = 'answer it';
  env.key('inline-prompt-input', KEYS.enter);
  await env.flush();
  assert.equal(env.calls.llm.length, 1, 'the question went out');
  const at = right.value.indexOf('third');
  right.selectionStart = right.selectionEnd = at; // the person went to the right pane and put the caret on "third"
  env.llmAnswer(env.calls.llm[0], 'A long answer of several words');
  await env.flush();
  assert.ok(noteText(env).includes('A long answer'), 'the answer is in the note');
  assert.equal(right.value, env.editor.value, 'both panes show it');
  assert.equal(right.selectionStart, right.value.indexOf('third'), 'the right caret is still on "third"');
});

check('C8-10 / C8-11: an image being read names its model, is in the task panel, and can be cancelled there', async () => {
  const env = await setup({ note: 'top\n' });
  env.config.general.pasteImageOcr = true;
  env.config.vision.baseUrl = 'http://localhost:11434';
  env.config.vision.model = 'qwen2.5vl:7b';
  env.config.vision.apiKey = '';
  env.editor.selectionStart = env.editor.selectionEnd = env.editor.value.length;
  const blob = { type: 'image/png' };
  const paste = () => env.editor.dispatchEvent({
    type: 'paste',
    clipboardData: { types: ['Files'], items: [{ type: 'image/png', getAsFile: () => blob }], getData: () => '' },
    preventDefault() { this.defaultPrevented = true; }
  });
  paste();
  await env.flush();
  assert.equal(env.vision.length, 1, 'the image was sent');
  assert.ok(noteText(env).includes('[Transcribing Image (qwen2.5vl:7b)...]'), 'the wait names the local model: ' + JSON.stringify(noteText(env)));
  assert.ok(!noteText(env).includes('Gemini'));
  const tasks = env.activeTasks();
  assert.equal(tasks.length, 1, 'the task panel lists it');
  assert.equal(tasks[0].id, env.vision[0].reqId);
  env.abort(env.vision[0].reqId);
  assert.equal(noteText(env), 'top\n', 'cancelling takes the waiting text out with its line breaks');
  assert.equal(env.activeTasks().length, 0, 'and the list is empty');
  env.window.__onLLMResult(env.vision[0].reqId, 'LATE TEXT', '');
  await env.flush();
  assert.equal(noteText(env), 'top\n', 'a late answer finds nothing waiting for it');
  assert.ok(env.toast() === I18N.en.llmTaskCanceled || env.messages.includes(I18N.en.llmTaskCanceled), 'the person is told');

  // an answer settles the task; Gemini keeps its name
  const second = await setup({ note: 'top\n' });
  second.config.general.pasteImageOcr = true;
  second.config.vision.apiKey = 'test-key';
  second.editor.selectionStart = second.editor.selectionEnd = second.editor.value.length;
  second.editor.dispatchEvent({
    type: 'paste',
    clipboardData: { types: ['Files'], items: [{ type: 'image/png', getAsFile: () => blob }], getData: () => '' },
    preventDefault() { this.defaultPrevented = true; }
  });
  await second.flush();
  assert.ok(noteText(second).includes('[Transcribing Image (Gemini)...]'));
  assert.equal(second.activeTasks().length, 1);
  second.window.__onLLMResult(second.vision[0].reqId, 'THE TEXT', '');
  await second.flush();
  assert.ok(noteText(second).includes('THE TEXT') && !noteText(second).includes('Transcribing'));
  assert.equal(second.activeTasks().length, 0, 'an answer settles it');
});

check('C8-13: pasting copied files does what dropping them does', async () => {
  const env = await setup({ note: 'note\n' });
  const dropped = [];
  env.window.FileAnchor = { handleDrop: async (ev, editor) => { dropped.push({ ev, editor }); return true; } };
  const file = { name: 'contract.pdf', type: 'application/pdf' };
  const clipboardData = { types: ['Files'], files: [file], items: [{ type: 'application/pdf', kind: 'file', getAsFile: () => file }], getData: () => '' };
  const event = env.editor.dispatchEvent({ type: 'paste', clipboardData });
  await env.flush();
  assert.equal(dropped.length, 1, 'the files went to the drop handler');
  assert.equal(dropped[0].ev.dataTransfer, clipboardData, 'with the clipboard as the data transfer');
  assert.equal(dropped[0].editor, env.editor);
  assert.ok(event.defaultPrevented, 'the browser does not paste it as well');
  // a copy that also carries text is an ordinary paste
  const text = { type: 'paste', clipboardData: { types: ['Files', 'text/plain'], files: [file], items: [], getData: () => 'a path' }, preventDefault() { this.defaultPrevented = true; } };
  env.editor.dispatchEvent(text);
  await env.flush();
  assert.equal(dropped.length, 1, 'text on the clipboard: the browser pastes it');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 7).join('\n  ') : err));
  }
}
console.log(failed ? `${failed} of ${queue.length} editor / find / paste fix test(s) FAILED.` : `All ${queue.length} editor / find / paste fix tests passed.`);
process.exit(failed ? 1 : 0);
