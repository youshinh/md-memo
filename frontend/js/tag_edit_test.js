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
  assert.deepStrictEqual(TE.shownTags({ scope: 'entry', note_tags: ['Work', 'work'], entry_tags: ['#x'] }), { scope: 'entry', note: ['work'], entry: ['x'] });
  assert.deepStrictEqual(TE.shownTags({ scope: 'note', note_tags: null }), { scope: 'note', note: [], entry: [] });
  assert.deepStrictEqual(TE.shownTags(null), { scope: 'note', note: [], entry: [] });
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

test('every sentence and label of the picker exists in English and in Japanese, with the same {placeholders}', () => {
  const used = ['cmdPaletteTagEntry', 'cmdPaletteTagEntryDesc', 'cmdPaletteTagNote', 'cmdPaletteTagNoteDesc', 'cmdPaletteTagRemove', 'cmdPaletteTagRemoveDesc', 'badgeTag',
    'tagEditPlaceholderAdd', 'tagEditPlaceholderRemove', 'tagEditCtxEntry', 'tagEditCtxNote', 'tagEditNew', 'tagEditAddThese', 'tagEditOnAlready', 'tagEditWhereEntry', 'tagEditWhereNote',
    'tagEditFiles', 'tagEditFilesOne', 'tagEditInText', 'tagEditLoading', 'tagEditShowFailed', 'tagEditTypeATag', 'tagEditNoRemovable', 'tagEditMore', 'tagEditHintAdd', 'tagEditHintRemove',
    'tagEditTooMany', 'tagEditTooLong', 'tagEditBadChars', 'tagEditNeedsEditor', 'tagEditStale', 'tagEditFailed', 'tagEditAddedEntry', 'tagEditAddedNote', 'tagEditAlsoThere',
    'tagEditAlready', 'tagEditRemovedEntry', 'tagEditRemovedNote', 'tagEditFrontMatter', 'tagEditFrontMatterTag', 'tagEditOnNote', 'tagEditOnEntry', 'tagEditNoneFound', 'tagEditNothing',
    'commentToggleTags', 'commentToggleTagsOnly'];
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
