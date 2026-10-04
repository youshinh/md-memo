// Unit tests for tag_edit.js: the typed text read as tags, the request, the patch put into the text and the caret moved with it (checked
// against the port of the Go side's Apply in tools/docshots/mock/tag_edit_mock.js, on fixed cases and on many generated ones), the list of
// tags to pick from, the sentences for the status line, and that loading the file costs nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
const TE = require('./tag_edit.js');
const Mock = require('../../tools/docshots/mock/tag_edit_mock.js');

const I18N = new Function(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '\nreturn I18N;')();
const tr = (lang) => (key, params) => {
  let s = I18N[lang][key];
  assert.ok(typeof s === 'string', `${lang} has no string for ${key}`);
  Object.keys(params || {}).forEach((k) => { s = s.split('{' + k + '}').join(String(params[k])); });
  return s;
};
const tEn = tr('en');
const tJa = tr('ja');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.error('FAIL: ' + name);
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  }
}

// The change for an edit, with the text it makes.
function change(text, edit) {
  return TE.changeOf(text, Object.assign({ eol: '\n' }, edit));
}

test('loading the module is free: one global, no timers, nothing built, and the picker needs a page', () => {
  const file = require.resolve('./tag_edit.js');
  const saved = require.cache[file];
  const savedGlobal = global.TagEdit;
  delete require.cache[file];
  delete global.TagEdit;
  const before = new Set(Object.getOwnPropertyNames(global));
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  let timers = 0;
  global.setTimeout = function () { timers++; return realSetTimeout.apply(this, arguments); };
  global.setInterval = function () { timers++; return realSetInterval.apply(this, arguments); };
  try {
    require('./tag_edit.js');
  } finally {
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
  }
  const added = Object.getOwnPropertyNames(global).filter((k) => !before.has(k));
  assert.deepStrictEqual(added, ['TagEdit']);
  assert.strictEqual(timers, 0);
  assert.strictEqual(global.TagEdit.openPicker({ editor: {}, backend: {} }), false, 'no document, no picker');
  assert.strictEqual(global.TagEdit.isOpen(), false);
  if (saved) require.cache[file] = saved;
  global.TagEdit = savedGlobal;
});

// ---- the typed text ---------------------------------------------------------------------------------------------

test('normalizeTag: full-width to half-width, # and spaces off, lower case', () => {
  assert.strictEqual(TE.normalizeTag('  #Work '), 'work');
  assert.strictEqual(TE.normalizeTag('##Work'), 'work');
  assert.strictEqual(TE.normalizeTag('Ｗｏｒｋ'), 'work', 'full-width letters');
  assert.strictEqual(TE.normalizeTag('＃仕事'), '仕事', 'a full-width # is taken off too');
  const ideographicSpace = String.fromCharCode(0x3000);
  assert.strictEqual(TE.normalizeTag(ideographicSpace + '仕事' + ideographicSpace), '仕事', 'the ideographic space');
  assert.strictEqual(TE.normalizeTag('#'), '');
  assert.strictEqual(TE.normalizeTag(null), '');
  assert.strictEqual(TE.normalizeTag('A B'), 'a b', 'inside a word nothing changes');
});

test('splitTags: commas, the Japanese comma, semicolons and white space; # off; no duplicates; the order written', () => {
  assert.deepStrictEqual(TE.splitTags('work, urgent').tags, ['work', 'urgent']);
  assert.deepStrictEqual(TE.splitTags('work urgent').tags, ['work', 'urgent']);
  assert.deepStrictEqual(TE.splitTags('#work,#urgent').tags, ['work', 'urgent']);
  assert.deepStrictEqual(TE.splitTags('仕事、急ぎ，買い物；読書;x').tags, ['仕事', '急ぎ', '買い物', '読書', 'x']);
  assert.deepStrictEqual(TE.splitTags('a' + String.fromCharCode(0x3000) + 'b').tags, ['a', 'b'], 'the ideographic space separates');
  assert.deepStrictEqual(TE.splitTags('Work work WORK').tags, ['work']);
  assert.deepStrictEqual(TE.splitTags('  , ; ').tags, []);
  assert.deepStrictEqual(TE.splitTags('#').tags, []);
  assert.deepStrictEqual(TE.splitTags('').tags, []);
  assert.deepStrictEqual(TE.splitTags(undefined).tags, []);
  const r = TE.splitTags('a');
  assert.deepStrictEqual([r.tooMany, r.tooLong, r.bad], [false, false, false]);
});

test('splitTags: a ninth tag, a tag of 65 characters and a comment delimiter are not taken, and it says so', () => {
  const nine = TE.splitTags('a b c d e f g h i');
  assert.strictEqual(nine.tags.length, 8);
  assert.strictEqual(nine.tooMany, true);
  assert.strictEqual(TE.splitTags('a b c d e f g h').tooMany, false, 'eight are fine');
  assert.strictEqual(TE.splitTags('a b c d e f g h a').tooMany, false, 'a ninth word that is a duplicate is no ninth tag');
  const long = TE.splitTags('x'.repeat(65));
  assert.deepStrictEqual(long.tags, []);
  assert.strictEqual(long.tooLong, true);
  assert.strictEqual(TE.splitTags('x'.repeat(64)).tooLong, false);
  assert.strictEqual(TE.splitTags('\u{20BB7}'.repeat(64)).tooLong, false, 'characters, not UTF-16 units');
  assert.strictEqual(TE.splitTags('\u{20BB7}'.repeat(65)).tooLong, true);
  assert.strictEqual(TE.splitTags('a-->b').bad, true);
  assert.deepStrictEqual(TE.splitTags('a-->b ok').tags, ['ok']);
  assert.strictEqual(TE.splitTags('<!--x').bad, true);
});

// ---- the request ------------------------------------------------------------------------------------------------

test('lineOfOffset and lineOfSelection: 1-based, the first line of a selection, the empty line after the last break is the last line', () => {
  const text = 'one\ntwo\nthree\n';
  assert.strictEqual(TE.lineOfOffset(text, 0), 1);
  assert.strictEqual(TE.lineOfOffset(text, 3), 1, 'at the end of line 1, before its break');
  assert.strictEqual(TE.lineOfOffset(text, 4), 2);
  assert.strictEqual(TE.lineOfOffset(text, 9), 3);
  assert.strictEqual(TE.lineOfOffset(text, 999), 4, 'clamped to the end');
  assert.strictEqual(TE.lineOfOffset(text, -5), 1);
  assert.strictEqual(TE.lineOfSelection(text, 5, 5), 2);
  assert.strictEqual(TE.lineOfSelection(text, 5, 12), 2, 'the first line of the selection');
  assert.strictEqual(TE.lineOfSelection(text, 12, 5), 2, 'a backwards selection too');
  assert.strictEqual(TE.lineOfSelection(text, text.length, text.length), 3, 'the empty line after the last break is not a line of the file');
  assert.strictEqual(TE.lineOfSelection('abc', 3, 3), 1);
  assert.strictEqual(TE.lineOfSelection('', 0, 0), 1);
  assert.strictEqual(TE.lineOfSelection('\n', 1, 1), 1);
  assert.strictEqual(TE.lineOfSelection('a\n\n', 3, 3), 2, 'a blank last line is a line');
});

test('request: the object window.backend.tagEdit gets', () => {
  assert.deepStrictEqual(TE.request('t', 'add', 'entry', 3, ['a']), { text: 't', op: 'add', scope: 'entry', tags: ['a'], line: 3 });
  assert.deepStrictEqual(TE.request('t', 'add', 'note', 3, ['a']), { text: 't', op: 'add', scope: 'note', tags: ['a'] }, 'a note needs no line');
  assert.deepStrictEqual(TE.request('t', 'show', 'entry', 1, []), { text: 't', op: 'show', scope: 'entry', tags: [], line: 1 });
  assert.deepStrictEqual(TE.request(null, 'remove', 'whatever', 0, null), { text: '', op: 'remove', scope: 'note', tags: [] });
  const tags = ['a'];
  assert.notStrictEqual(TE.request('t', 'add', 'note', 1, tags).tags, tags, 'a copy');
  assert.strictEqual(TE.request('t', 'add', 'entry', 0, ['a']).line, 1, 'an entry always has a valid line');
});

// ---- a selected word (section 11.7) -------------------------------------------------------------------------------

test('selectionLines: the lines a selection covers; a caret is none; one that ends right after a line break stops at the line before it', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  assert.strictEqual(TE.selectionLines(text, 2, 2), null, 'a caret');
  assert.strictEqual(TE.selectionLines(text, undefined, undefined), null);
  assert.deepStrictEqual(TE.selectionLines(text, 0, 3), { first: 1, last: 1 });
  assert.deepStrictEqual(TE.selectionLines(text, 0, 4), { first: 1, last: 1 }, '"one" and its break: the next line is not selected');
  assert.deepStrictEqual(TE.selectionLines(text, 0, 5), { first: 1, last: 2 });
  assert.deepStrictEqual(TE.selectionLines(text, 5, 14), { first: 2, last: 3 });
  assert.deepStrictEqual(TE.selectionLines(text, 14, 5), { first: 2, last: 3 }, 'offsets in either order');
  assert.deepStrictEqual(TE.selectionLines(text, 0, text.length), { first: 1, last: 4 }, 'all of it: the empty line after the last break is not a line');
  assert.deepStrictEqual(TE.selectionLines('a\nb', 0, 3), { first: 1, last: 2 });
  assert.deepStrictEqual(TE.selectionLines('a\n\nb', 1, 2), { first: 1, last: 1 }, 'just a line break');
});

test('selectedTag: a word of one line is the first tag, with the ends cleaned', () => {
  const sel = (text, word) => { const i = text.indexOf(word); return TE.selectedTag(text, i, i + word.length); };
  assert.strictEqual(sel('a work item', 'work'), 'work');
  assert.strictEqual(sel('Work', 'Work'), 'Work', 'the word as it is: the box shows what was selected (the tag is made lower case when it is added)');
  assert.strictEqual(sel('plain 仕事 text', '仕事'), '仕事', 'Japanese');
  assert.strictEqual(sel('買い物リスト', '買い物リスト'), '買い物リスト', 'a whole Japanese phrase with no space is one word');
  assert.strictEqual(sel('see #hashtag now', '#hashtag'), 'hashtag', 'a leading #');
  assert.strictEqual(sel('x ###a', '###a'), 'a', 'any number of them');
  assert.strictEqual(sel('x ＃仕事', '＃仕事'), '＃仕事', 'a full-width # is left to normalizeTag (the box shows what was selected)');
  [['"work"', 'work'], ["'work'", 'work'], ['「仕事」', '仕事'], ['『仕事』', '仕事'], ['(work)', 'work'], ['（仕事）', '仕事'], ['[work]', 'work'],
    ['［work］', 'work'], ['<work>', 'work'], ['＜work＞', 'work']].forEach(([raw, want]) => assert.strictEqual(sel('x ' + raw + ' y', raw), want, raw));
  ['work.', 'work,', 'work;', 'work:', 'work!', 'work?', '仕事。', '仕事、', '仕事，', '仕事．', '仕事；', '仕事：', '仕事！', '仕事？'].forEach((raw) => {
    assert.strictEqual(sel('x ' + raw + ' y', raw), raw.slice(0, -1), 'a mark of a sentence at the end: ' + raw);
  });
  assert.strictEqual(sel('x "#work", y', '"#work",'), 'work', 'several kinds, in any order');
  assert.strictEqual(sel('x （#仕事）。', '（#仕事）。'), '仕事');
  assert.strictEqual(sel('x #(work)', '#(work)'), 'work', 'a # before a bracket');
  assert.strictEqual(sel('use c++ here', 'c++'), 'c++', 'a + at the end stays');
  assert.strictEqual(sel('use c# here', 'c#'), 'c#', 'a # at the end stays');
  assert.strictEqual(sel('use #c# here', '#c#'), 'c#');
  assert.strictEqual(sel('use c++. here', 'c++.'), 'c++');
  assert.strictEqual(sel('a  work  b', '  work  '), 'work', 'white space around it');
  assert.strictEqual(TE.selectedTag('x' + String.fromCharCode(0x3000) + '仕事' + String.fromCharCode(0x3000), 1, 4), '仕事', 'the ideographic space');
  assert.strictEqual(sel('名前 \u{20BB7} です', '\u{20BB7}'), '\u{20BB7}', 'a character of two units');
  assert.strictEqual(sel('see a-b_c', 'a-b_c'), 'a-b_c', 'a word with a dash and an underscore');
});

test('selectedTag: what is not one tag gives an empty string', () => {
  const sel = (text, word) => { const i = text.indexOf(word); return TE.selectedTag(text, i, i + word.length); };
  assert.strictEqual(sel('two words here', 'two words'), '', 'two words');
  assert.strictEqual(sel('仕事 急ぎ', '仕事 急ぎ'), '');
  assert.strictEqual(sel('a,b', 'a,b'), '', 'a comma inside');
  assert.strictEqual(sel('仕事、急ぎ', '仕事、急ぎ'), '', 'the Japanese comma inside');
  assert.strictEqual(sel('a;b', 'a;b'), '');
  assert.strictEqual(TE.selectedTag('a\nb', 0, 3), '', 'a line break');
  assert.strictEqual(TE.selectedTag('work\nnext', 0, 5), '', 'the word and its line break');
  assert.strictEqual(TE.selectedTag('work\r\nnext', 0, 5), '');
  assert.strictEqual(TE.selectedTag('abc', 1, 1), '', 'no selection');
  assert.strictEqual(TE.selectedTag('', 0, 0), '');
  assert.strictEqual(TE.selectedTag(null, 0, 3), '');
  assert.strictEqual(TE.selectedTag('abc', undefined, undefined), '');
  assert.strictEqual(sel('x # y', '#'), '', 'only a #');
  assert.strictEqual(sel('x ... y', '...'), '', 'only marks');
  assert.strictEqual(sel('x 「」 y', '「」'), '');
  assert.strictEqual(TE.selectedTag('   ', 0, 3), '', 'only white space');
  assert.strictEqual(sel('use a-->b ok', 'a-->b'), '', 'a tag that would end the comment');
  assert.strictEqual(sel('use x"-->"y', 'x"-->"y'), '');
  assert.strictEqual(sel('x ' + 'z'.repeat(64) + ' y', 'z'.repeat(64)), 'z'.repeat(64), '64 characters are fine');
  assert.strictEqual(sel('x ' + 'z'.repeat(65) + ' y', 'z'.repeat(65)), '', '65 are too many for a tag');
  assert.strictEqual(sel('x ' + '\u{20BB7}'.repeat(64) + ' y', '\u{20BB7}'.repeat(64)), '\u{20BB7}'.repeat(64), 'characters, not units');
  assert.strictEqual(sel('x ' + '\u{20BB7}'.repeat(65) + ' y', '\u{20BB7}'.repeat(65)), '');
});

test('selectedTag: 200 characters of selection at most, counted before anything is cleaned; offsets in either order or out of range', () => {
  const pad = (n) => ' '.repeat(n);
  const at200 = pad(98) + 'work' + pad(98);
  const at201 = pad(98) + 'work' + pad(99);
  assert.strictEqual(at200.length, 200);
  assert.strictEqual(TE.selectedTag(at200, 0, at200.length), 'work');
  assert.strictEqual(TE.selectedTag(at201, 0, at201.length), '', '201 characters');
  assert.strictEqual(TE.selectedTag('x'.repeat(201), 0, 201), '');
  assert.strictEqual(TE.selectedTag('x'.repeat(5000), 0, 5000), '', 'a long selection is refused without being read');
  assert.strictEqual(TE.selectedTag('a work b', 6, 2), 'work', 'reversed offsets');
  assert.strictEqual(TE.selectedTag('abc', -5, 99), 'abc', 'offsets outside the text are the text');
  const astral200 = '\u{20BB7}'.repeat(58) + ' ' + '\u{20BB7}'.repeat(60) + pad(81);
  assert.strictEqual(Array.from(astral200).length, 200);
  assert.strictEqual(TE.selectedTag(astral200, 0, astral200.length), '', '200 characters, but two words');
  const astralOk = pad(100) + '\u{20BB7}' + pad(99);
  assert.strictEqual(Array.from(astralOk).length, 200);
  assert.strictEqual(TE.selectedTag(astralOk, 0, astralOk.length), '\u{20BB7}', 'characters are counted, not units');
});

test('selectedTag gives a word that splitTags reads as exactly one tag, whatever it is given (a generated check)', () => {
  const rnd = lcg(104);
  const alphabet = ['a', 'B', 'c', '仕', '事', ' ', ' ', '#', '+', '"', '(', ')', '「', '」', '。', ',', ';', '-', '>', '<', '!', '\n', '\u{20BB7}'];
  let found = 0;
  for (let n = 0; n < 4000; n++) {
    let text = '';
    const len = 1 + Math.floor(rnd() * 14);
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    const word = TE.selectedTag(text, 0, text.length);
    if (word === '') continue;
    found++;
    const r = TE.splitTags(word);
    assert.deepStrictEqual([r.tags.length, r.tooMany, r.tooLong, r.bad], [1, false, false, false], JSON.stringify(text) + ' -> ' + JSON.stringify(word));
    assert.ok(!/[\r\n]/.test(word) && word === word.trim(), JSON.stringify(word));
    assert.ok(text.indexOf(word) >= 0, 'a piece of the selection');
  }
  assert.ok(found > 200, 'the generator found words (' + found + ')');
});

// ---- the patch --------------------------------------------------------------------------------------------------

const TAG = '<!-- tags: x -->';

test('changeOf: a line put in after a heading is an insertion of that line', () => {
  const c = change('# A\nbody\n', { start_line: 2, end_line: 2, new_lines: [TAG] });
  assert.strictEqual(c.text, '# A\n' + TAG + '\nbody\n');
  assert.deepStrictEqual([c.kind, c.start, c.end, c.rep], ['insert', 4, 4, TAG + '\n']);
});

test('changeOf: appended after the last line - with and without a line break at the end of the text, and in an empty text', () => {
  assert.strictEqual(change('# A\n', { start_line: 2, end_line: 2, new_lines: [TAG] }).text, '# A\n' + TAG + '\n');
  const open = change('# A', { start_line: 2, end_line: 2, new_lines: [TAG] });
  assert.strictEqual(open.text, '# A\n' + TAG, 'the text still ends without a break');
  assert.deepStrictEqual([open.start, open.end, open.rep], [3, 3, '\n' + TAG]);
  assert.strictEqual(change('', { start_line: 1, end_line: 1, new_lines: [TAG] }).text, TAG + '\n');
  assert.strictEqual(change('# A', { start_line: 2, end_line: 2, new_lines: [TAG], eol: '\r\n' }).text, '# A\r\n' + TAG);
});

test('changeOf: a changed line writes only what changed', () => {
  const text = '# A\n<!-- tags: a -->\nbody\n';
  const c = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: a, b -->'] });
  assert.strictEqual(c.text, '# A\n<!-- tags: a, b -->\nbody\n');
  assert.strictEqual(c.kind, 'replace');
  assert.deepStrictEqual([c.rep, text.slice(c.start, c.end)], [', b', ''], 'only ", b" goes in');
  const c2 = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: z -->'] });
  assert.strictEqual(c2.text, '# A\n<!-- tags: z -->\nbody\n');
  assert.strictEqual(text.slice(c2.start, c2.end), 'a');
  assert.strictEqual(c2.rep, 'z');
  const same = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: a -->'] });
  assert.strictEqual(same.kind, 'none', 'a patch that rewrites a line to itself changes nothing');
  assert.strictEqual(same.text, text);
});

test('changeOf: lines taken out; the last line of a text that has no break takes the break before it along', () => {
  assert.strictEqual(change('# A\n<!-- tags: a -->\nbody\n', { start_line: 2, end_line: 3, new_lines: [] }).text, '# A\nbody\n');
  const tail = change('# A\n<!-- tags: a -->', { start_line: 2, end_line: 3, new_lines: [] });
  assert.strictEqual(tail.text, '# A');
  assert.strictEqual(tail.kind, 'delete');
  assert.strictEqual(change('# A\r\n<!-- tags: a -->', { start_line: 2, end_line: 3, new_lines: [], eol: '\r\n' }).text, '# A');
  assert.strictEqual(change('<!-- tags: a -->', { start_line: 1, end_line: 2, new_lines: [] }).text, '');
  assert.strictEqual(change('<!-- tags: a -->\n', { start_line: 1, end_line: 2, new_lines: [] }).text, '');
});

test('changeOf: the text\'s own line break joins the new lines', () => {
  const c = change('# A\r\nbody\r\n', { start_line: 2, end_line: 2, new_lines: [TAG, 'y'], eol: '\r\n' });
  assert.strictEqual(c.text, '# A\r\n' + TAG + '\r\ny\r\nbody\r\n');
  assert.strictEqual(change('a\nb\nc', { start_line: 2, end_line: 4, new_lines: ['B', 'C'] }).text, 'a\nB\nC', 'the run reaches the end of a text that has no break: so does the new one');
});

test('changeOf: a high surrogate shared at the edge of a rewritten line is not split', () => {
  const text = '# A\n<!-- tags: \u{20BB7}a -->\nbody';
  const c = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: \u{20BB7}b -->'] });
  assert.strictEqual(c.text, '# A\n<!-- tags: \u{20BB7}b -->\nbody');
  const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  assert.ok(!lone(c.rep) && !lone(text.slice(c.start, c.end)), 'neither side of the edit holds half a character');
  const c2 = change('<!-- tags: \u{20BB7} -->', { start_line: 1, end_line: 2, new_lines: ['<!-- tags: \u{20BB8} -->'] });
  assert.strictEqual(c2.text, '<!-- tags: \u{20BB8} -->');
  assert.ok(!lone(c2.rep));
});

// A deterministic generator, so a failure can be replayed.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('changeOf makes the text Apply of the Go side makes - on 4000 generated notes and requests', () => {
  const rnd = lcg(20261003);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const lines = ['# Title', '## Sub', '### Deep', '---', 'body text', '', '```', '# in a fence', '<!-- tags: old, x -->', '<!-- tags: b -->', '  <!-- Tag: c -->', 'plain'];
  const tags = ['a', 'b', 'c', 'x', 'old', 'new', '仕事'];
  let changed = 0;
  for (let n = 0; n < 4000; n++) {
    const count = Math.floor(rnd() * 9);
    const eol = rnd() < 0.2 ? '\r\n' : '\n';
    let text = '';
    for (let i = 0; i < count; i++) text += pick(lines) + (i === count - 1 && rnd() < 0.4 ? '' : eol);
    const op = pick(['add', 'add', 'remove']);
    const scope = rnd() < 0.5 ? 'note' : 'entry';
    const line = 1 + Math.floor(rnd() * (text.split('\n').length));
    const want = [pick(tags)].concat(rnd() < 0.3 ? [pick(tags)] : []);
    let edit;
    try {
      edit = Mock.editTags(text, op, scope, line, want);
    } catch (e) {
      continue;
    }
    if (!edit.changed) continue;
    changed++;
    const c = TE.changeOf(text, edit);
    assert.strictEqual(c.text, Mock.apply(text, edit), `text ${JSON.stringify(text)} op ${op} scope ${scope} line ${line} tags ${want} edit ${JSON.stringify(edit)}`);
    assert.strictEqual(text.slice(0, c.start) + c.rep + text.slice(c.end), c.text, 'start, end and rep make the same text');
  }
  assert.ok(changed > 800, 'the generator made enough changes (' + changed + ')');
});

// ---- the caret --------------------------------------------------------------------------------------------------

test('selectionAfter: behind the change it moves by the difference, before it it stays', () => {
  const text = 'abc\n# A\nbody\n';
  const c = change(text, { start_line: 3, end_line: 3, new_lines: [TAG] }); // inserted before "body"
  const at = text.indexOf('body');
  assert.deepStrictEqual(TE.selectionAfter(c, 0, 0), [0, 0], 'a caret above stays');
  assert.deepStrictEqual(TE.selectionAfter(c, at - 1, at - 1), [at - 1, at - 1], 'the end of the line above stays');
  assert.deepStrictEqual(TE.selectionAfter(c, at, at), [at + TAG.length + 1, at + TAG.length + 1], 'the start of the line the new line goes before goes with its line');
  assert.deepStrictEqual(TE.selectionAfter(c, at + 2, at + 4), [at + 2 + TAG.length + 1, at + 4 + TAG.length + 1], 'a selection below moves whole');
  assert.deepStrictEqual(TE.selectionAfter(c, 1, at + 2), [1, at + 2 + TAG.length + 1], 'a selection across it grows');
  assert.strictEqual(c.text.slice(TE.selectionAfter(c, at, at)[0]), 'body\n', 'the caret is before the same word');
});

test('selectionAfter: a caret at the end of a text that has no break stays before the line that is appended', () => {
  const c = change('# A', { start_line: 2, end_line: 2, new_lines: [TAG] });
  assert.deepStrictEqual(TE.selectionAfter(c, 3, 3), [3, 3], 'typing goes on at the end of the heading');
  const c2 = change('# A\n', { start_line: 2, end_line: 2, new_lines: [TAG] });
  assert.deepStrictEqual(TE.selectionAfter(c2, 4, 4), [4 + TAG.length + 1, 4 + TAG.length + 1], 'on the empty last line it goes with the line');
});

test('selectionAfter: in the tag line the caret stays when the rewrite is behind it, and goes behind the new text when it is inside it', () => {
  const text = '# A\n<!-- tags: a -->\nbody';
  const c = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: a, b -->'] }); // ", b" goes in after "a"
  const tag = text.indexOf(': a') + 2; // where the tag "a" is
  const col = tag + 1;                 // just behind it
  assert.deepStrictEqual(TE.selectionAfter(c, col - 3, col - 3), [col - 3, col - 3], 'before the change');
  assert.deepStrictEqual(TE.selectionAfter(c, col, col), [col, col], 'at the point where text goes in: before it');
  assert.deepStrictEqual(TE.selectionAfter(c, col + 1, col + 1), [col + 1 + 3, col + 1 + 3], 'after it');
  const z = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: zz -->'] }); // "a" becomes "zz"
  assert.deepStrictEqual(TE.selectionAfter(z, tag, tag + 1), [tag, tag + 2], 'a selection of what was rewritten ends behind the new text');
});

test('selectionAfter: lines taken out - a caret in them goes to where they were, below them it moves up', () => {
  const text = '# A\n<!-- tags: a -->\nbody\n';
  const c = change(text, { start_line: 2, end_line: 3, new_lines: [] });
  const line2 = text.indexOf('<!--');
  assert.deepStrictEqual(TE.selectionAfter(c, line2 + 5, line2 + 5), [line2, line2]);
  assert.deepStrictEqual(TE.selectionAfter(c, line2, line2), [line2, line2]);
  const body = text.indexOf('body');
  assert.deepStrictEqual(TE.selectionAfter(c, body + 2, body + 2), [line2 + 2, line2 + 2]);
  assert.strictEqual(c.text.slice(TE.selectionAfter(c, body, body)[0]), 'body\n');
  const none = change(text, { start_line: 2, end_line: 3, new_lines: ['<!-- tags: a -->'] });
  assert.deepStrictEqual(TE.selectionAfter(none, 7, 9), [7, 9], 'nothing changed: the selection is the same');
});

// ---- the list of tags -------------------------------------------------------------------------------------------

const FOLDER = TE.folderTags({ tags: [{ tag: 'work', files: 8 }, { tag: 'reading', files: 5 }, { tag: 'urgent', files: 4 }, { tag: 'idea', files: 1 }], files: 9, undated: 0 });
const NOSHOW = { scope: 'entry', note: [], entry: [] };
const titles = (view) => view.rows.map((r) => (r.kind === 'tag' ? r.tag : r.kind + ':' + r.tags.join(',')));

test('folderTags and shownTags read the backend\'s answers', () => {
  assert.deepStrictEqual(FOLDER, [{ tag: 'work', files: 8 }, { tag: 'reading', files: 5 }, { tag: 'urgent', files: 4 }, { tag: 'idea', files: 1 }]);
  assert.deepStrictEqual(TE.folderTags(JSON.stringify({ tags: [{ tag: ' B ', files: 1 }, { tag: 'a', files: 1 }, { tag: 'A', files: 7 }, { tag: '', files: 3 }, { tag: 5 }] })),
    [{ tag: 'a', files: 1 }, { tag: 'b', files: 1 }], 'normalized, one row per tag, by use and then by name');
  assert.deepStrictEqual(TE.folderTags(null), []);
  assert.deepStrictEqual(TE.folderTags('not json'), []);
  assert.deepStrictEqual(TE.folderTags({ tags: 'no' }), []);
  const none = { range_start: 0, range_end: 0, heading: '', descendants: 0, inherited: [], path: [] };
  assert.deepStrictEqual(TE.shownTags({ scope: 'entry', note_tags: ['Work', 'work'], entry_tags: ['#x'] }), Object.assign({ scope: 'entry', note: ['work'], entry: ['x'] }, none));
  assert.deepStrictEqual(TE.shownTags({ scope: 'note', note_tags: null }), Object.assign({ scope: 'note', note: [], entry: [] }, none));
  assert.deepStrictEqual(TE.shownTags(null), Object.assign({ scope: 'note', note: [], entry: [] }, none));
  // where the entry is (the context row): taken as sent, a bad number is 0
  assert.deepStrictEqual(TE.shownTags({ scope: 'entry', range_start: 4, range_end: 66, heading: 'Part A' }), Object.assign({}, none, { scope: 'entry', note: [], entry: [], range_start: 4, range_end: 66, heading: 'Part A' }));
  assert.deepStrictEqual(TE.shownTags({ scope: 'entry', range_start: -1, range_end: 'x', heading: 5 }), Object.assign({}, none, { scope: 'entry', note: [], entry: [] }));
});

test('shownTags reads the outline of the answer: descendants, inherited tags and the path, nearest first (section 11.2)', () => {
  const raw = {
    scope: 'entry', note_tags: ['n'], entry_tags: ['a'], range_start: 10, range_end: 13, heading: 'Processing', descendants: 2, inherited_tags: ['Top', 'mid', 'top'],
    path: [
      { line: 10, level: 3, heading: 'Processing', range_start: 10, range_end: 13, descendants: 2, tags: ['A'] },
      { line: 5, level: 2, heading: 'Bamboo', range_start: 5, range_end: 20, descendants: 5, tags: [] },
      { line: 1, level: 1, heading: 'Article', range_start: 1, range_end: 30, descendants: 9, tags: ['#Top', 'mid'] }
    ]
  };
  const s = TE.shownTags(raw);
  assert.strictEqual(s.descendants, 2);
  assert.deepStrictEqual(s.inherited, ['top', 'mid'], 'normalized, no duplicates');
  assert.deepStrictEqual(s.path.map((p) => [p.line, p.level, p.heading, p.range_start, p.range_end, p.descendants, p.tags.join('+')]),
    [[10, 3, 'Processing', 10, 13, 2, 'a'], [5, 2, 'Bamboo', 5, 20, 5, ''], [1, 1, 'Article', 1, 30, 9, 'top+mid']]);
  // a note has no path, whatever the answer holds; a place without a line is dropped; a bad level or range is repaired
  assert.deepStrictEqual(TE.shownTags({ scope: 'note', path: raw.path }).path, []);
  const odd = TE.shownTags({ scope: 'entry', path: [null, 5, { line: 0 }, { line: 7, level: 9, heading: 3, range_end: 2, tags: 'x' }] });
  assert.deepStrictEqual(odd.path, [{ line: 7, level: 3, heading: '', range_start: 7, range_end: 7, descendants: 0, tags: [] }]);
  assert.deepStrictEqual(TE.shownTags({ scope: 'entry', path: 'no' }).path, [], 'an older backend sends no path');
});

test('addRows: nothing typed lists the folder\'s tags by use, then the note\'s own; a tag that is on in the range is left out', () => {
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: FOLDER, shown: NOSHOW })), ['work', 'reading', 'urgent', 'idea']);
  const shown = { scope: 'entry', note: ['work'], entry: ['mine'] };
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: FOLDER, shown: shown })), ['reading', 'urgent', 'idea'], 'work is on the note, mine on the entry: both are on');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'note', folder: FOLDER, shown: shown })), ['reading', 'urgent', 'idea', 'mine'], 'for the whole note only its own tags are on; the entry\'s tag is offered, last');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: [], shown: { scope: 'entry', note: [], entry: ['mine'] } })), [], 'a tag of the entry is on it');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'note', folder: [], shown: { scope: 'entry', note: [], entry: ['mine'] } })), ['mine']);
  // an entry that is the front of the note is the whole note: the backend says so, and the entry's tags are not a thing there
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: FOLDER, shown: { scope: 'note', note: ['work'], entry: [] } })), ['reading', 'urgent', 'idea']);
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: FOLDER, shown: null })), ['work', 'reading', 'urgent', 'idea'], 'while the note is being read');
  const view = TE.addRows('', { scope: 'entry', folder: FOLDER, shown: shown });
  assert.deepStrictEqual(view.rows[0], { kind: 'tag', tag: 'reading', files: 5, inText: false, tags: ['reading'] });
  assert.strictEqual(view.more, 0);
  assert.strictEqual(view.problem, '');
});

test('addRows: what is typed is the first row; prefix matches come before the others; case and width do not matter', () => {
  const ctx = { scope: 'entry', folder: FOLDER, shown: NOSHOW };
  assert.deepStrictEqual(titles(TE.addRows('wo', ctx)), ['new:wo', 'work']);
  assert.deepStrictEqual(titles(TE.addRows('ＷO', ctx)), ['new:wo', 'work'], 'full-width capital letters');
  assert.deepStrictEqual(titles(TE.addRows('#rk', ctx)), ['new:rk', 'work'], 'a substring matches too');
  assert.deepStrictEqual(titles(TE.addRows('e', ctx)), ['new:e', 'reading', 'urgent', 'idea'], 'no tag starts with "e": the ones that hold it, in the order of use');
  assert.deepStrictEqual(titles(TE.addRows('r', ctx)), ['new:r', 'reading', 'work', 'urgent'], 'the tag that starts with "r" comes before the ones that only hold it');
  assert.deepStrictEqual(titles(TE.addRows('zzz', ctx)), ['new:zzz']);
  assert.deepStrictEqual(titles(TE.addRows('work', ctx)), ['work'], 'a typed tag that is in the list is that row, not a new one');
  assert.deepStrictEqual(titles(TE.addRows('WORK', ctx)), ['work']);
  const two = TE.addRows('work', { scope: 'entry', folder: FOLDER.concat([{ tag: 'work-log', files: 9 }]), shown: NOSHOW });
  assert.deepStrictEqual(titles(two), ['work', 'work-log'], 'the exact tag first, even where another with the same start is used more');
});

test('addRows: several tags typed at once; a word before the last separator is finished, the list follows the one being typed', () => {
  const ctx = { scope: 'entry', folder: FOLDER, shown: NOSHOW };
  assert.deepStrictEqual(titles(TE.addRows('work, newone', ctx)), ['new:work,newone']);
  assert.deepStrictEqual(TE.addRows('work, newone', ctx).rows[0].tags, ['work', 'newone']);
  const mid = TE.addRows('work, ur', ctx);
  assert.deepStrictEqual(titles(mid), ['new:work,ur', 'urgent']);
  assert.deepStrictEqual(mid.rows[1].tags, ['work', 'urgent'], 'the finished words and the tag picked');
  const after = TE.addRows('work, ', ctx);
  assert.deepStrictEqual(titles(after), ['typed:work', 'reading', 'urgent', 'idea'], 'after a separator the whole list comes back, without what is typed already');
  assert.deepStrictEqual(after.rows[1].tags, ['work', 'reading']);
  const known = TE.addRows('work, reading', ctx);
  assert.deepStrictEqual(titles(known), ['reading'], 'the word being typed is a tag of the list: that row does what a typed row would');
  assert.deepStrictEqual(known.rows[0].tags, ['work', 'reading']);
  assert.deepStrictEqual(titles(TE.addRows('newone, reading', ctx)), ['reading']);
  assert.deepStrictEqual(TE.addRows('newone, reading', ctx).rows[0].tags, ['newone', 'reading']);
});

test('addRows: a typed tag that is on already is said so (Enter then tells the person); problems are named', () => {
  const ctx = { scope: 'entry', folder: FOLDER, shown: { scope: 'entry', note: ['work'], entry: [] } };
  assert.deepStrictEqual(titles(TE.addRows('work', ctx)), ['on:work']);
  assert.deepStrictEqual(titles(TE.addRows('Work', ctx)), ['on:work']);
  assert.strictEqual(TE.addRows('a b c d e f g h i', ctx).problem, 'tooMany');
  assert.strictEqual(TE.addRows('x'.repeat(65), ctx).problem, 'tooLong');
  assert.strictEqual(TE.addRows('a-->b', ctx).problem, 'bad');
  ['a b c d e f g h i', 'x'.repeat(65), 'a-->b'].forEach((typed) => {
    assert.deepStrictEqual(TE.addRows(typed, ctx).rows, [], 'a text that cannot be added offers no row: ' + typed.slice(0, 20));
  });
  const eight = TE.addRows('a b c d e f g ', ctx);
  assert.strictEqual(eight.problem, '', 'seven finished words and the list: up to eight in all is fine');
  assert.ok(eight.rows.every((r) => r.tags.length <= 8) && eight.rows.length > 0);
  assert.ok(eight.rows.some((r) => r.kind === 'tag' && r.tags.length === 8), 'a row that makes eight');
  assert.strictEqual(TE.addRows('fine', ctx).problem, '');
});

test('addRows: at most 8 rows, and how many were left out', () => {
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ tag: 't' + String(i).padStart(2, '0'), files: 20 - i });
  const view = TE.addRows('', { scope: 'entry', folder: many, shown: NOSHOW });
  assert.strictEqual(view.rows.length, 8);
  assert.strictEqual(view.more, 12);
  assert.deepStrictEqual(view.rows.map((r) => r.tag), ['t00', 't01', 't02', 't03', 't04', 't05', 't06', 't07'], 'the most used');
  const typed = TE.addRows('t', { scope: 'entry', folder: many, shown: NOSHOW });
  assert.strictEqual(typed.rows.length, 8);
  assert.strictEqual(typed.rows[0].kind, 'new', 'what was typed takes one of the 8');
  assert.strictEqual(typed.more, 13);
});

test('removeRows: the entry\'s own tags, then the whole note\'s, each marked; the box narrows them', () => {
  const ctx = { shown: { scope: 'entry', note: ['work', 'idea'], entry: ['urgent', 'work'] } };
  const view = TE.removeRows('', ctx);
  assert.deepStrictEqual(view.rows.map((r) => r.where + ':' + r.tag), ['entry:urgent', 'entry:work', 'note:work', 'note:idea'], 'the same tag on both is two rows: each is taken from its own range');
  assert.deepStrictEqual(view.rows[0], { kind: 'tag', tag: 'urgent', where: 'entry', tags: ['urgent'] });
  assert.deepStrictEqual(TE.removeRows('WO', ctx).rows.map((r) => r.where + ':' + r.tag), ['entry:work', 'note:work']);
  assert.deepStrictEqual(TE.removeRows('de', ctx).rows.map((r) => r.tag), ['idea'], 'a substring');
  assert.deepStrictEqual(TE.removeRows('zzz', ctx).rows, []);
  assert.deepStrictEqual(TE.removeRows('', { shown: { scope: 'note', note: ['a'], entry: ['ignored'] } }).rows.map((r) => r.where + ':' + r.tag), ['note:a'], 'the front of the note has no entry of its own');
  assert.deepStrictEqual(TE.removeRows('', { shown: null }).rows, [], 'before the note is read');
  assert.deepStrictEqual(TE.removeRows('', {}).rows, []);
  const many = { shown: { scope: 'entry', note: [], entry: Array.from({ length: 12 }, (_, i) => 'e' + i) } };
  assert.strictEqual(TE.removeRows('', many).rows.length, 8);
  assert.strictEqual(TE.removeRows('', many).more, 4);
});

// ---- the place a tag goes to (section 11.4) ---------------------------------------------------------------------

// A Web article under a heading, with smaller headings of its own: lines 1 to 14. Level 1 "Bamboo" holds level 2 "Uses" (holding level 3
// "Processing") and level 2 "Growth"; "Other" is another root.
const ARTICLE = [
  '# Bamboo', 'intro', '## Uses', 'uses text', '### Processing', 'split it', 'dry it', '## Growth', 'grows fast', '', '# Other', 'other text', '', ''
].join('\n');
const showArticle = (line, text) => TE.shownTags(Mock.editTags(text || ARTICLE, 'show', 'entry', line, []));

test('the path of the mock\'s answer: the entry, then the headings above it, with their subtrees', () => {
  const s = showArticle(5); // in "Processing"
  assert.deepStrictEqual(s.path.map((p) => [p.line, p.level, p.heading, p.range_start, p.range_end, p.descendants]),
    [[5, 3, 'Processing', 5, 7, 0], [3, 2, 'Uses', 3, 7, 1], [1, 1, 'Bamboo', 1, 10, 3]]);
  assert.deepStrictEqual([s.scope, s.range_start, s.range_end, s.heading, s.descendants], ['entry', 5, 7, 'Processing', 0]);
  const top = showArticle(1);
  assert.strictEqual(top.path.length, 1, 'the top heading has nobody above it');
  assert.strictEqual(top.descendants, 3);
  assert.deepStrictEqual(showArticle(11).path.map((p) => p.heading), ['Other']);
  assert.deepStrictEqual(showArticle(11).path.map((p) => p.descendants), [0]);
});

test('defaultPlace: the lowest heading the entries of the first and the last selected line have in common, else the first entry', () => {
  const first = [{ line: 10 }, { line: 5 }, { line: 1 }]; // the entry of the first line, its parent, its root
  assert.strictEqual(TE.defaultPlace(first, null), 0, 'a caret or a line: no second path');
  assert.strictEqual(TE.defaultPlace(first, []), 0, 'a note: no path');
  assert.strictEqual(TE.defaultPlace(first, undefined), 0);
  assert.strictEqual(TE.defaultPlace(first, [{ line: 10 }, { line: 5 }, { line: 1 }]), 0, 'the same entry');
  assert.strictEqual(TE.defaultPlace(first, [{ line: 20 }, { line: 5 }, { line: 1 }]), 1, 'two children of the parent: the parent');
  assert.strictEqual(TE.defaultPlace(first, [{ line: 30 }, { line: 25 }, { line: 1 }]), 2, 'two branches of the root: the root');
  assert.strictEqual(TE.defaultPlace(first, [{ line: 25 }, { line: 10 }, { line: 5 }, { line: 1 }]), 0, 'the last entry is below the first one: the first entry (self)');
  assert.strictEqual(TE.defaultPlace(first, [{ line: 60 }, { line: 55 }]), 0, 'separate trees: nothing in common, the first entry');
  assert.strictEqual(TE.defaultPlace(first, [{ line: 1 }]), 2, 'the last line is in the root\'s own text');
  assert.strictEqual(TE.defaultPlace([{ line: 3 }], [{ line: 3 }, { line: 1 }]), 0, 'one place: nothing to choose');
  assert.strictEqual(TE.defaultPlace([], [{ line: 3 }]), 0);
  assert.strictEqual(TE.defaultPlace(undefined, [{ line: 3 }]), 0);
  assert.strictEqual(TE.defaultPlace(first, [{ line: 5 }, { line: 10 }]), 0, 'the order of the second path does not matter: the first one\'s own is found first');
});

test('defaultPlace on the answers of the backend: a selection that starts at a sub-heading and ends in a sibling starts at the heading above both', () => {
  const at = (line) => showArticle(line).path;
  const heads = (i, line) => (i === null ? null : at(line)[i].heading);
  // [first line, last line, the place chosen (a heading), why]
  [[4, 9, 'Bamboo', 'from the text of "Uses" to the text of "Growth": both under Bamboo'],
    [6, 9, 'Bamboo', 'from "Processing" (under Uses) to "Growth": Bamboo'],
    [3, 9, 'Bamboo', 'from the heading "## Uses" through "Growth"'],
    [4, 6, 'Uses', 'from "Uses" into its own "Processing": the first entry is the common one'],
    [6, 7, 'Processing', 'inside one section'],
    [5, 7, 'Processing', 'the whole section from its heading'],
    [1, 10, 'Bamboo', 'from the top heading itself: it has nothing above it'],
    [2, 9, 'Bamboo', 'from the top\'s own text'],
    [6, 12, 'Processing', 'across two trees: nothing in common, the first entry'],
    [9, 12, 'Growth', 'across two trees from "Growth"']].forEach(([first, last, heading, why]) => {
    const i = TE.defaultPlace(at(first), at(last));
    assert.strictEqual(heads(i, first), heading, `lines ${first}-${last}: ${why}`);
  });
  // an independent rule for every pair of lines: the nearest heading of the first entry whose subtree reaches the last line, else the entry
  let n = 0;
  for (let first = 1; first <= 13; first++) {
    for (let last = first; last <= 13; last++) {
      const pf = at(first);
      const pl = at(last);
      const want = pf.length < 2 ? 0 : Math.max(0, pf.findIndex((p) => p.range_end >= last));
      assert.strictEqual(TE.defaultPlace(pf, pl), want, `lines ${first}-${last}`);
      if (pf.length > 1 && pf.findIndex((p) => p.range_end >= last) >= 0) assert.ok(pf[want].range_start <= first && pf[want].range_end >= last, 'the place holds both lines');
      n++;
    }
  }
  assert.strictEqual(n, 91);
});

test('tagsOn and addRows: what is on at a place is worked out again from the path, and the answer of the backend agrees', () => {
  const withTags = TE.shownTags({ scope: 'entry', note_tags: ['n'], entry_tags: ['a'], path: [
    { line: 5, level: 3, heading: 'Processing', range_start: 5, range_end: 7, descendants: 0, tags: ['a'] },
    { line: 3, level: 2, heading: 'Uses', range_start: 3, range_end: 7, descendants: 1, tags: ['b'] },
    { line: 1, level: 1, heading: 'Bamboo', range_start: 1, range_end: 9, descendants: 3, tags: ['top'] }] });
  assert.deepStrictEqual([0, 1, 2].map((p) => TE.tagsOn(withTags, p).sort().join('+')), ['a+b+n+top', 'b+n+top', 'n+top']);
  assert.deepStrictEqual(TE.tagsOn(withTags, 9).sort(), ['n', 'top'], 'a place past the end is the last');
  assert.deepStrictEqual(TE.tagsOn({ note: ['n'], entry: ['e'] }, 0), ['n', 'e'], 'no path: the entry alone');
  assert.deepStrictEqual(TE.tagsOn(null, 0), []);
  const folder = TE.folderTags({ tags: [{ tag: 'a', files: 5 }, { tag: 'b', files: 4 }, { tag: 'top', files: 3 }, { tag: 'n', files: 2 }, { tag: 'work', files: 1 }] });
  const ctx = (place) => ({ scope: 'entry', folder: folder, shown: withTags, place: place });
  assert.deepStrictEqual(titles(TE.addRows('', ctx(0))), ['work'], 'on the entry: a, b and top are on it, n on the whole note');
  assert.deepStrictEqual(titles(TE.addRows('', ctx(1))), ['a', 'work'], 'on "Uses": a is on the entry below it only, so it can still go here');
  assert.deepStrictEqual(titles(TE.addRows('', ctx(2))), ['a', 'b', 'work'], 'on "Bamboo"');
  assert.deepStrictEqual(titles(TE.addRows('b', ctx(0))), ['on:b'], 'typed, and on already at the entry (it comes from its parent)');
  assert.deepStrictEqual(titles(TE.addRows('b', ctx(2))), ['b'], 'typed, and not on the top heading yet: the tag of the list');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'note', folder: folder, shown: withTags, place: 2 })), ['a', 'b', 'top', 'work'], 'the whole-note command has no place: only the note\'s tags are on');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: [], shown: withTags, place: 0 })), [], 'from the text only: everything it has is on at the entry');
  assert.deepStrictEqual(titles(TE.addRows('', { scope: 'entry', folder: [], shown: withTags, place: 2 })), ['a', 'b'], 'the tags of the places below are offered from the text, the nearest first');
  // the backend's own answer agrees with the page's sum, for every place and a few tags (the page does not ask again when the place changes)
  const text = '<!-- tags: n -->\n# Bamboo\n<!-- tags: top -->\nintro\n## Uses\n<!-- tags: b -->\nuses text\n### Processing\n<!-- tags: a -->\nsplit it\n';
  const shown = showArticle(10, text);
  assert.deepStrictEqual(shown.path.map((p) => p.heading), ['Processing', 'Uses', 'Bamboo']);
  assert.deepStrictEqual(shown.inherited, ['top', 'b'], 'the farthest first');
  shown.path.forEach((p, i) => {
    ['n', 'top', 'b', 'a', 'zz'].forEach((tag) => {
      const said = Mock.editTags(text, 'add', 'entry', p.line, [tag]).message_code === 'already';
      assert.strictEqual(TE.tagsOn(shown, i).indexOf(tag) >= 0, said, `place ${i} (${p.heading}), tag ${tag}`);
    });
  });
});

test('removeRows with a path: the place\'s own tags, the ones from the headings above it with where they come from, then the whole note\'s', () => {
  const shown = TE.shownTags({ scope: 'entry', note_tags: ['n'], entry_tags: ['a'], path: [
    { line: 5, level: 3, heading: 'Processing', range_start: 5, range_end: 7, descendants: 0, tags: ['a'] },
    { line: 3, level: 2, heading: 'Uses', range_start: 3, range_end: 7, descendants: 1, tags: ['b', 'x'] },
    { line: 1, level: 1, heading: 'Bamboo', range_start: 1, range_end: 9, descendants: 3, tags: ['top', 'x'] }] });
  const flat = (place, query) => TE.removeRows(query || '', { shown: shown, place: place }).rows.map((r) => `${r.where}:${r.tag}${r.at === undefined ? '' : '@' + r.at}`);
  assert.deepStrictEqual(flat(0), ['entry:a@0', 'parent:b@1', 'parent:x@1', 'parent:top@2', 'parent:x@2', 'note:n'], 'the same tag on two headings is two rows, each taken off at its own heading');
  assert.deepStrictEqual(flat(1), ['entry:b@1', 'entry:x@1', 'parent:top@2', 'parent:x@2', 'note:n'], 'on "Uses": its own tags, then those of "Bamboo"');
  assert.deepStrictEqual(flat(2), ['entry:top@2', 'entry:x@2', 'note:n']);
  assert.deepStrictEqual(flat(0, 'x'), ['parent:x@1', 'parent:x@2'], 'the box narrows them');
  const row = TE.removeRows('top', { shown: shown, place: 0 }).rows[0];
  assert.deepStrictEqual(row, { kind: 'tag', tag: 'top', where: 'parent', tags: ['top'], at: 2, heading: 'Bamboo', line: 1 });
  assert.deepStrictEqual(TE.removeRows('', { shown: shown, place: 7 }).rows.map((r) => r.at), [2, 2, undefined], 'a place past the end is the last');
  // no path (an older backend, or an entry with nothing above it that did not send one): as before, no `at`
  assert.deepStrictEqual(TE.removeRows('', { shown: { scope: 'entry', note: ['n'], entry: ['a'] }, place: 0 }).rows, [
    { kind: 'tag', tag: 'a', where: 'entry', tags: ['a'] }, { kind: 'tag', tag: 'n', where: 'note', tags: ['n'] }]);
});

// ---- what to say ------------------------------------------------------------------------------------------------

const keys = (list) => list.map((m) => m.key);

test('describe: added to the entry or the note, already there, removed, and one sentence per message_code', () => {
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', added: ['a', 'b'], unchanged: [] }, 'add'), [{ key: 'tagEditAddedEntry', params: { tags: 'a, b' } }]);
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'note', added: ['a'], unchanged: [] }, 'add'), [{ key: 'tagEditAddedNote', params: { tags: 'a' } }]);
  assert.deepStrictEqual(keys(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: ['b'] }, 'add')), ['tagEditAddedEntry', 'tagEditAlsoThere'], 'one new, one already there');
  assert.deepStrictEqual(TE.describe({ changed: false, scope: 'entry', unchanged: ['a'], message_code: 'already' }, 'add'), [{ key: 'tagEditAlready', params: { tags: 'a' } }]);
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', removed: ['a'], unchanged: [] }, 'remove'), [{ key: 'tagEditRemovedEntry', params: { tags: 'a' } }]);
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'note', removed: ['a'], unchanged: [] }, 'remove'), [{ key: 'tagEditRemovedNote', params: { tags: 'a' } }]);
  assert.deepStrictEqual(keys(TE.describe({ changed: true, scope: 'entry', removed: ['a'], unchanged: ['b'], message_code: 'on_note' }, 'remove')), ['tagEditRemovedEntry', 'tagEditOnNote'], 'some taken off, one that is on the note');
  const codes = { front_matter: 'tagEditFrontMatter', front_matter_tag: 'tagEditFrontMatterTag', on_note: 'tagEditOnNote', on_entry: 'tagEditOnEntry', none_found: 'tagEditNoneFound' };
  Object.keys(codes).forEach((code) => {
    assert.deepStrictEqual(TE.describe({ changed: false, scope: 'note', message_code: code }, 'add'), [{ key: codes[code], params: {} }], code);
  });
  assert.deepStrictEqual(keys(TE.describe({ changed: false, scope: 'note', message_code: '' }, 'add')), ['tagEditNothing']);
  assert.deepStrictEqual(keys(TE.describe({ changed: false, scope: 'note', message_code: 'something new' }, 'add')), ['tagEditNothing'], 'a code from a newer backend');
  assert.deepStrictEqual(keys(TE.describe(null, 'add')), ['tagEditNothing']);
});

test('describe names the heading the tag went under and how far it is from the caret; shortHeading and relation', () => {
  // under a heading: the heading and the line the tag was written at
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 5, heading: 'Part A', range_start: 4, range_end: 8 }, 'add'),
    [{ key: 'tagEditAddedEntryHead', params: { tags: 'a', heading: 'Part A', line: 5 } }]);
  // an entry with no heading (a rule alone): the line only
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 16, heading: '', range_start: 15, range_end: 16 }, 'add'),
    [{ key: 'tagEditAddedEntryLine', params: { tags: 'a', line: 16 } }]);
  // the whole note and an older backend (no heading fields) keep the old sentences
  assert.deepStrictEqual(keys(TE.describe({ changed: true, scope: 'note', added: ['a'], unchanged: [], line: 1, heading: '' }, 'add')), ['tagEditAddedNote']);
  assert.deepStrictEqual(keys(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [] }, 'add')), ['tagEditAddedEntry']);
  // removal names the heading
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', removed: ['a'], unchanged: [], heading: 'Part A' }, 'remove'),
    [{ key: 'tagEditRemovedEntryHead', params: { tags: 'a', heading: 'Part A' } }]);
  // far from the caret: one more sentence, above or below, with the distance; near: nothing
  const far = TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 5, heading: 'H' }, 'add', { caretLine: 60 });
  assert.deepStrictEqual(far[1], { key: 'tagEditPlaceAbove', params: { n: 55 } });
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 70, heading: 'H' }, 'add', { caretLine: 10 })[1], { key: 'tagEditPlaceBelow', params: { n: 60 } });
  assert.strictEqual(TE.describe({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 5, heading: 'H' }, 'add', { caretLine: 12 }).length, 1, '7 lines away is near');
  assert.ok(TE.relation(5, 14), 'more than 8 lines (9) is far');
  assert.strictEqual(TE.relation(5, 13), null, '8 lines is near');
  assert.strictEqual(TE.relation(0, 50), null, 'no line, nothing to say');
  // a long heading is cut at 40 characters on a code point, one line
  assert.strictEqual(TE.shortHeading('  a   b\tc '), 'a b c');
  const long = 'x'.repeat(60);
  assert.strictEqual(TE.shortHeading(long), 'x'.repeat(40) + '…');
  const astral = String.fromCodePoint(0x1f600).repeat(45);
  assert.ok(!/[\ud800-\udbff]$/.test(TE.shortHeading(astral).replace('…', '')), 'never a lone surrogate');
  assert.strictEqual(Array.from(TE.shortHeading(astral)).length, 41);
  // in both languages the sentences read well
  assert.strictEqual(tEn('tagEditAddedEntryHead', { tags: 'a, b', heading: 'Part A', line: 5 }), 'Tag added: a, b, under "Part A" (line 5).');
  assert.strictEqual(tJa('tagEditAddedEntryHead', { tags: 'a, b', heading: '節A', line: 5 }), 'タグ「a, b」を付けました（「節A」の下、5 行目）。');
  assert.strictEqual(tJa('tagEditPlaceAbove', { n: 55 }), 'カーソルより 55 行上です。');
  assert.strictEqual(tEn('tagEditCtxEntryHead', { heading: 'Part A', start: 4, end: 8 }), 'Entry, lines 4-8: "Part A"');
  assert.strictEqual(tJa('tagEditCtxEntryRange', { start: 15, end: 16 }), '書き込み 15〜16 行目');
});

test('describe: a tag under a heading says how many entries under it it applies to; on_parent names the heading it comes from', () => {
  const added = (extra) => Object.assign({ changed: true, scope: 'entry', added: ['a'], unchanged: [], line: 5, heading: 'Part A', range_start: 4, range_end: 20 }, extra);
  assert.deepStrictEqual(TE.describe(added({ descendants: 3 }), 'add'), [
    { key: 'tagEditAddedEntryHead', params: { tags: 'a', heading: 'Part A', line: 5 } }, { key: 'tagEditAlsoUnder', params: { n: 3 } }]);
  assert.deepStrictEqual(keys(TE.describe(added({ descendants: 1 }), 'add')), ['tagEditAddedEntryHead', 'tagEditAlsoUnderOne']);
  assert.deepStrictEqual(keys(TE.describe(added({ descendants: 0 }), 'add')), ['tagEditAddedEntryHead'], 'nothing under it: nothing more to say');
  assert.deepStrictEqual(keys(TE.describe(added({}), 'add')), ['tagEditAddedEntryHead'], 'an older backend');
  assert.deepStrictEqual(keys(TE.describe(added({ descendants: 4, line: 5 }), 'add', { caretLine: 60 })), ['tagEditAddedEntryHead', 'tagEditPlaceAbove', 'tagEditAlsoUnder'], 'the distance, then the entries under it');
  assert.deepStrictEqual(keys(TE.describe(added({ descendants: 4, unchanged: ['b'] }), 'add')), ['tagEditAddedEntryHead', 'tagEditAlsoUnder', 'tagEditAlsoThere']);
  assert.deepStrictEqual(keys(TE.describe(added({ descendants: 4, removed: ['a'] }), 'remove')), ['tagEditRemovedEntryHead'], 'taking a tag off says nothing about the entries under it');
  assert.deepStrictEqual(keys(TE.describe({ changed: true, scope: 'note', added: ['a'], unchanged: [], descendants: 4 }, 'add')), ['tagEditAddedNote']);
  // on_parent: the heading and line the tag comes from, in one sentence of its own
  const parent = { changed: false, scope: 'entry', message_code: 'on_parent', parent_heading: 'Bamboo', parent_line: 1, unchanged: ['top'] };
  assert.deepStrictEqual(TE.describe(parent, 'remove'), [{ key: 'tagEditOnParent', params: { heading: 'Bamboo', line: 1 } }]);
  assert.deepStrictEqual(TE.describe(Object.assign({}, parent, { parent_heading: 'x'.repeat(60) }), 'remove')[0].params.heading, 'x'.repeat(40) + '…', 'a long heading is cut');
  assert.deepStrictEqual(TE.describe(Object.assign({}, parent, { parent_heading: '', parent_line: 0 }), 'remove')[0].params, { heading: '#', line: 0 });
  assert.deepStrictEqual(TE.describe({ changed: true, scope: 'entry', removed: ['a'], unchanged: ['top'], heading: 'Part A', message_code: 'on_parent', parent_heading: 'Bamboo', parent_line: 1 }, 'remove'), [
    { key: 'tagEditRemovedEntryHead', params: { tags: 'a', heading: 'Part A' } }, { key: 'tagEditOnParent', params: { heading: 'Bamboo', line: 1 } }], 'some taken off, one that comes from above');
  // the backend's own answers say the same (the mock is a port of the Go code)
  const text = '# Bamboo\n<!-- tags: top -->\nintro\n## Uses\nbody\n## Growth\nmore\n';
  const added1 = Mock.editTags(text, 'add', 'entry', 1, ['x']);
  assert.deepStrictEqual([added1.descendants, added1.range_start, added1.range_end, added1.heading], [2, 1, 7, 'Bamboo']);
  assert.deepStrictEqual(keys(TE.describe(added1, 'add')), ['tagEditAddedEntryHead', 'tagEditAlsoUnder']);
  const refused = Mock.editTags(text, 'remove', 'entry', 5, ['top']);
  assert.deepStrictEqual(TE.describe(refused, 'remove'), [{ key: 'tagEditOnParent', params: { heading: 'Bamboo', line: 1 } }]);
  assert.strictEqual(tEn('tagEditAlsoUnder', { n: 3 }), 'It also applies to the 3 entries under it.');
  assert.strictEqual(tEn('tagEditAlsoUnderOne'), 'It also applies to the 1 entry under it.');
  assert.strictEqual(tJa('tagEditAlsoUnder', { n: 3 }), 'その下の 3 個の書き込みにも効きます。');
  assert.strictEqual(tEn('tagEditOnParent', { heading: 'Bamboo', line: 1 }), 'That tag comes from the heading "Bamboo" (line 1), above this entry. Take it off there.');
  assert.strictEqual(tJa('tagEditOnParent', { heading: '竹', line: 1 }), 'そのタグは、この書き込みの上の見出し「竹」（1 行目）から届いています。そちらから外してください。');
});

test('the picker\'s words for the place: the chip, the choices, the rows and the hint, in both languages', () => {
  const under3 = tEn('tagEditUnder', { n: 3 });
  assert.strictEqual(tEn('tagEditCtxTreeHead', { under: under3, start: 4, end: 14, heading: 'Bamboo' }), 'Entry and everything under it (3 entries), lines 4-14: "Bamboo"');
  assert.strictEqual(tEn('tagEditCtxTreeRange', { under: tEn('tagEditUnderOne'), start: 4, end: 14 }), 'Entry and everything under it (1 entry), lines 4-14');
  assert.strictEqual(tJa('tagEditCtxTreeHead', { under: tJa('tagEditUnder', { n: 3 }), start: 4, end: 14, heading: '竹' }), '書き込みと、その下すべて（3 個の書き込み）4〜14 行目「竹」');
  assert.strictEqual(tEn('tagEditPlaceChoice', { heading: 'Processing', start: 10, end: 13 }), 'Processing (10-13)');
  assert.strictEqual(tJa('tagEditPlaceChoice', { heading: '加工', start: 10, end: 13 }), '加工（10〜13 行）');
  assert.strictEqual(tEn('tagEditWhereParent', { heading: 'Bamboo', line: 1 }), 'From "Bamboo" (line 1)');
  assert.strictEqual(tJa('tagEditWhereParent', { heading: '竹', line: 1 }), '「竹」（1 行目）から');
  assert.strictEqual(tEn('tagEditHintAddWhere'), 'Enter: add the tag · Ctrl+↑/↓: parent / child heading · Esc: close');
  assert.strictEqual(tJa('tagEditHintRemoveWhere'), 'Enter: 外す · Ctrl+↑/↓: 親の見出し / 子の見出し · Esc: 閉じる');
  assert.ok(tEn('tagEditHintAddWhere').indexOf(tEn('tagEditHintAdd').split(' · ')[0]) === 0, 'the hint starts the same way as the one without the choice');
});

test('every sentence and label of the picker exists in English and in Japanese, with the same {placeholders}', () => {
  const used = ['cmdPaletteTagEntry', 'cmdPaletteTagEntryDesc', 'cmdPaletteTagNote', 'cmdPaletteTagNoteDesc', 'cmdPaletteTagRemove', 'cmdPaletteTagRemoveDesc', 'badgeTag',
    'tagEditPlaceholderAdd', 'tagEditPlaceholderRemove', 'tagEditCtxEntry', 'tagEditCtxEntryHead', 'tagEditCtxEntryRange', 'tagEditCtxNote', 'tagEditNew', 'tagEditAddThese', 'tagEditOnAlready', 'tagEditWhereEntry', 'tagEditWhereNote',
    'tagEditFiles', 'tagEditFilesOne', 'tagEditInText', 'tagEditLoading', 'tagEditShowFailed', 'tagEditTypeATag', 'tagEditNoRemovable', 'tagEditMore', 'tagEditHintAdd', 'tagEditHintRemove',
    'tagEditTooMany', 'tagEditTooLong', 'tagEditBadChars', 'tagEditNeedsEditor', 'tagEditStale', 'tagEditFailed', 'tagEditAddedEntry', 'tagEditAddedEntryHead', 'tagEditAddedEntryLine', 'tagEditPlaceAbove', 'tagEditPlaceBelow', 'tagEditAddedNote', 'tagEditAlsoThere',
    'tagEditAlready', 'tagEditRemovedEntry', 'tagEditRemovedEntryHead', 'tagEditRemovedNote', 'tagEditFrontMatter', 'tagEditFrontMatterTag', 'tagEditOnNote', 'tagEditOnEntry', 'tagEditNoneFound', 'tagEditNothing',
    'commentToggleTags', 'commentToggleTagsOnly',
    // section 11: a tag under a heading applies to the headings below it
    'tagEditUnder', 'tagEditUnderOne', 'tagEditCtxTreeHead', 'tagEditCtxTreeRange', 'tagEditAlsoUnder', 'tagEditAlsoUnderOne', 'tagEditOnParent',
    'tagEditPlaceLabelAdd', 'tagEditPlaceLabelRemove', 'tagEditPlaceChoice', 'tagEditWhereParent', 'tagEditWhereHeading', 'tagEditHintAddWhere', 'tagEditHintRemoveWhere'];
  const holes = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(',');
  const range = (a, b) => String.fromCharCode(a) + '-' + String.fromCharCode(b);
  const CJK = new RegExp('[' + range(0x3040, 0x30ff) + range(0x4e00, 0x9fff) + ']'); // kana and kanji
  used.forEach((k) => {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], 'en: ' + k);
    assert.ok(typeof I18N.ja[k] === 'string' && I18N.ja[k], 'ja: ' + k);
    assert.strictEqual(holes(I18N.en[k]), holes(I18N.ja[k]), 'the same placeholders in ' + k);
    assert.ok(!CJK.test(I18N.en[k]), 'no Japanese in the English ' + k);
    assert.ok(CJK.test(I18N.ja[k]) || /^[A-Za-z .]+$/.test(I18N.ja[k]), 'the Japanese ' + k + ' is Japanese');
  });
  // the sentences read well with the tags in them, in both languages
  assert.strictEqual(tEn('tagEditAddedEntry', { tags: 'a, b' }), 'Tag added to this entry: a, b.');
  assert.strictEqual(tJa('tagEditAddedNote', { tags: 'a, b' }), 'ノート全体にタグ「a, b」を付けました。');
  assert.strictEqual(TE.describe({ changed: true, scope: 'entry', added: ['x'], unchanged: ['y'] }, 'add').map((m) => tJa(m.key, m.params)).join(' '), 'この書き込みにタグ「x」を付けました。 「y」はすでに付いていました。');
  // problemText
  assert.strictEqual(TE.problemText(tEn, 'tooMany'), 'Up to 8 tags at a time.');
  assert.strictEqual(TE.problemText(tEn, 'tooLong'), 'A tag can have up to 64 characters.');
  assert.strictEqual(TE.problemText(tJa, 'bad'), 'タグに <!-- や --> は使えません。');
});

test('every key the picker\'s code names (in the source of tag_edit.js) is a string in both languages, and the two languages have the same tag keys', () => {
  const source = fs.readFileSync(path.join(__dirname, 'tag_edit.js'), 'utf8');
  const used = new Set((source.match(/'(?:tagEdit|cmdPaletteTag)[A-Za-z]*'/g) || []).map((k) => k.slice(1, -1)));
  ['tagEditAdded', 'tagEditRemoved'].forEach((prefix) => used.delete(prefix)); // (these two are written with "Entry" or "Note" after them)
  assert.ok(used.size > 40, 'the source names its keys (' + used.size + ')');
  used.forEach((k) => {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], 'en: ' + k);
    assert.ok(typeof I18N.ja[k] === 'string' && I18N.ja[k], 'ja: ' + k);
  });
  const own = (lang) => Object.keys(I18N[lang]).filter((k) => /^tagEdit/.test(k)).sort();
  assert.deepStrictEqual(own('en'), own('ja'), 'the same keys in English and Japanese');
  // no emoji in any of them (the app uses thin line icons)
  own('en').concat(['commentToggleTags']).forEach((k) => ['en', 'ja'].forEach((lang) => {
    assert.ok(!/\p{Extended_Pictographic}/u.test(I18N[lang][k]), `no emoji in ${lang} ${k}`);
  }));
});

test('commands: all three when the backend can edit tags, none for an older backend', () => {
  assert.deepStrictEqual(TE.commands({ tagEdit() {} }), ['entry', 'note', 'remove']);
  assert.deepStrictEqual(TE.commands({}), []);
  assert.deepStrictEqual(TE.commands({ tagEdit: 'no' }), []);
  assert.deepStrictEqual(TE.commands(null), []);
  assert.deepStrictEqual(TE.commands(undefined), []);
});

// ---- the golden cases of the Go side, when the file is there -----------------------------------------------------------

test('the page\'s patch makes the Go side\'s new_text on every golden case (when pkg/search/testdata/tagedit_golden.json exists)', () => {
  const file = path.join(__dirname, '..', '..', 'pkg', 'search', 'testdata', 'tagedit_golden.json');
  if (!fs.existsSync(file)) {
    console.log('      (no golden file yet: skipped)');
    return;
  }
  const list = JSON.parse(fs.readFileSync(file, 'utf8')); // [{ name, text, op, scope, line, tags, want: { ...the TagEdit, new_text } }]
  assert.ok(Array.isArray(list) && list.length > 0);
  let n = 0;
  list.forEach((c) => {
    const w = c.want;
    if (!w.changed) {
      assert.ok(w.new_text === undefined || w.new_text === c.text, c.name + ': a request that changes nothing leaves the text');
      return;
    }
    n++;
    const ch = TE.changeOf(c.text, w);
    assert.strictEqual(ch.text, w.new_text, c.name);
    assert.strictEqual(c.text.slice(0, ch.start) + ch.rep + c.text.slice(ch.end), w.new_text, c.name + ': start, end and rep');
    // the caret: every offset of the old text lands inside the new one, in the same order, and text that was not touched keeps its caret on the same character
    let prev = -1;
    for (let p = 0; p <= c.text.length; p++) {
      const q = TE.mapOffset(ch, p);
      assert.ok(q >= prev && q >= 0 && q <= w.new_text.length, c.name + ': offset ' + p + ' went to ' + q);
      prev = q;
      if (p < ch.start || p >= ch.end) assert.strictEqual(w.new_text.slice(q, q + 3).charAt(0) === c.text.charAt(p) || p === c.text.length || (q === p && p === ch.start), true, c.name + ': offset ' + p + ' is on another character');
    }
  });
  assert.ok(n > 20, 'the golden file has patches to check (' + n + ')');
  console.log('      (' + n + ' golden patches checked)');
});

console.log(passed + ' tests passed');
