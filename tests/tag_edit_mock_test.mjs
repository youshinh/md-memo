// The mock backend's tagEdit (tools/docshots/mock/tag_edit_mock.js) is a port of search.EditTags (pkg/search/tagedit.go): the smoke flows and the
// documentation pictures rely on it answering what the Go side answers (docs/design/tag-filter-2026-10.md section 10.2). Two checks:
//   1. The golden cases of the Go side, pkg/search/testdata/tagedit_golden.json (the Go tests run the same list against EditTags): every field of
//      the TagEdit and the new text must be equal. SKIPPED below is the list of cases the mock is not meant to follow - empty today.
//   2. Cases written here by hand from the contract (so the mock is also checked where the golden list has no case), and the requests the Go side refuses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const Mock = require('../tools/docshots/mock/tag_edit_mock.js');

// case name -> why the mock does not follow it. (CRLF, a byte order mark and a comment of more than 32 tags are all followed.)
const SKIPPED = {};

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

const edit = (text, op, scope, line, tags) => Mock.editTags(text, op, scope, line, tags);
const run = (text, op, scope, line, tags) => {
  const e = edit(text, op, scope, line, tags);
  return { e, text: Mock.apply(text, e) };
};

// ---- 1. the golden cases ------------------------------------------------------------------------------------------

test('the golden cases of the Go side: every field and the new text', () => {
  const file = path.join(HERE, '..', 'pkg', 'search', 'testdata', 'tagedit_golden.json');
  if (!fs.existsSync(file)) {
    console.log('      (no golden file at ' + file + ': only the hand-written cases below are checked)');
    return;
  }
  const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(cases) && cases.length > 0, 'the golden file is a list of cases');
  let compared = 0;
  const skipped = [];
  cases.forEach((c) => {
    if (SKIPPED[c.name]) { skipped.push(c.name + ' - ' + SKIPPED[c.name]); return; }
    const want = Object.assign({}, c.want);
    const newText = want.new_text;
    delete want.new_text;
    let got;
    try {
      got = edit(c.text, c.op, c.scope, c.line, c.tags);
    } catch (err) {
      assert.fail(`${c.name}: the mock threw "${err.message}"`);
    }
    assert.deepEqual(got, want, `${c.name}: the TagEdit differs`);
    assert.equal(Mock.apply(c.text, got), newText === undefined ? c.text : newText, `${c.name}: the new text differs`);
    compared++;
    // idempotent: the same request on the new text changes nothing (an entry's line only means the same line while the patch is below it)
    if (got.changed && c.scope === 'note' || got.changed && c.line < got.start_line) {
      assert.equal(edit(Mock.apply(c.text, got), c.op, c.scope, c.line, c.tags).changed, false, `${c.name}: the same request twice changes the text twice`);
    }
  });
  console.log(`      (${compared} golden cases compared, ${skipped.length} skipped${skipped.length ? ': ' + skipped.join('; ') : ''})`);
  assert.equal(compared + skipped.length, cases.length);
});

// ---- 2. by hand ---------------------------------------------------------------------------------------------------

const NOTE = '# One\nfirst\n\n## Two\nsecond\n\n---\n\n### Three\nthird\n';

test('add under the heading of the entry the line is in; the entries are the headings # to ### and the --- rules', () => {
  assert.equal(run(NOTE, 'add', 'entry', 2, ['x']).text, '# One\n<!-- tags: x -->\nfirst\n\n## Two\nsecond\n\n---\n\n### Three\nthird\n');
  assert.equal(run(NOTE, 'add', 'entry', 5, ['x']).text, '# One\nfirst\n\n## Two\n<!-- tags: x -->\nsecond\n\n---\n\n### Three\nthird\n');
  // the rule starts an entry of its own; its heading (line 9) comes after a blank line, so it starts another
  assert.equal(run(NOTE, 'add', 'entry', 7, ['x']).text, '# One\nfirst\n\n## Two\nsecond\n\n---\n<!-- tags: x -->\n\n### Three\nthird\n');
  assert.equal(run(NOTE, 'add', 'entry', 10, ['x']).text, '# One\nfirst\n\n## Two\nsecond\n\n---\n\n### Three\n<!-- tags: x -->\nthird\n');
  const four = '# One\nfirst\n#### Four\nbody\n';
  assert.equal(run(four, 'add', 'entry', 4, ['x']).text, '# One\n<!-- tags: x -->\nfirst\n#### Four\nbody\n', 'a #### heading starts no entry');
});

test('add: the whole note is a new first line; a note that starts with text has a front part, which is the whole note', () => {
  assert.equal(run(NOTE, 'add', 'note', 1, ['x']).text, '<!-- tags: x -->\n' + NOTE);
  const front = 'intro line\n\n# One\nbody\n';
  assert.equal(run(front, 'add', 'entry', 1, ['x']).e.scope, 'note', 'a caret in the front part: the whole note');
  assert.equal(run(front, 'add', 'entry', 1, ['x']).text, '<!-- tags: x -->\n' + front);
  assert.equal(run(front, 'add', 'entry', 4, ['x']).text, 'intro line\n\n# One\n<!-- tags: x -->\nbody\n');
  const bare = 'just text\nmore\n';
  const r = run(bare, 'add', 'entry', 2, ['x']);
  assert.equal(r.e.scope, 'note', 'a file with no heading and no rule is one note');
  assert.equal(r.text, '<!-- tags: x -->\njust text\nmore\n');
});

test('add: merged into the comment that is there; the tags that are on already are not added again', () => {
  const t = '# One\n<!-- tags: a -->\nbody\n';
  const r = run(t, 'add', 'entry', 1, ['b', 'A']);
  assert.equal(r.text, '# One\n<!-- tags: a, b -->\nbody\n');
  assert.deepEqual([r.e.added, r.e.unchanged, r.e.changed, r.e.message_code], [['b'], ['a'], true, '']);
  assert.deepEqual([r.e.start_line, r.e.end_line, r.e.line], [2, 3, 2]);
  const same = run(t, 'add', 'entry', 1, ['a']);
  assert.deepEqual([same.e.changed, same.e.message_code, same.e.unchanged, same.text], [false, 'already', ['a'], t]);
  // a tag of the whole note is on every entry
  const both = '<!-- tags: n -->\n# One\nbody\n';
  assert.equal(run(both, 'add', 'entry', 3, ['n']).e.message_code, 'already');
  assert.equal(run(both, 'add', 'note', 1, ['n']).e.message_code, 'already');
  assert.equal(run(both, 'add', 'note', 1, ['m']).text, '<!-- tags: n, m -->\n# One\nbody\n');
});

test('add: a comment in a code fence is code, not a tag line; a comment that is not a whole tag comment is left alone', () => {
  const fenced = '# One\n```\n<!-- tags: hidden -->\n```\n';
  assert.equal(run(fenced, 'add', 'entry', 1, ['hidden']).text, '# One\n<!-- tags: hidden -->\n```\n<!-- tags: hidden -->\n```\n');
  const other = '# One\n<!-- note: x -->\ntext <!-- tags: z --> more\n';
  assert.equal(run(other, 'add', 'entry', 1, ['z']).text, '# One\n<!-- tags: z -->\n<!-- note: x -->\ntext <!-- tags: z --> more\n');
});

test('remove: a line left with no tag goes; the tags in the other range are not taken, and the answer says where they are', () => {
  const t = '<!-- tags: n -->\n# One\n<!-- tags: a, b -->\nbody\n';
  const one = run(t, 'remove', 'entry', 4, ['a']);
  assert.equal(one.text, '<!-- tags: n -->\n# One\n<!-- tags: b -->\nbody\n');
  assert.deepEqual([one.e.removed, one.e.changed], [['a'], true]);
  const both = run(t, 'remove', 'entry', 4, ['a', 'b']);
  assert.equal(both.text, '<!-- tags: n -->\n# One\nbody\n', 'the comment has no tag left: its line is deleted');
  assert.deepEqual([both.e.start_line, both.e.end_line, both.e.new_lines, both.e.line], [3, 4, [], 0]);
  const onNote = run(t, 'remove', 'entry', 4, ['n']);
  assert.deepEqual([onNote.e.changed, onNote.e.message_code, onNote.e.unchanged, onNote.text], [false, 'on_note', ['n'], t]);
  const onEntry = run(t, 'remove', 'note', 1, ['a']);
  assert.deepEqual([onEntry.e.changed, onEntry.e.message_code], [false, 'on_entry']);
  const none = run(t, 'remove', 'entry', 4, ['zz']);
  assert.deepEqual([none.e.changed, none.e.message_code], [false, 'none_found']);
  const part = run(t, 'remove', 'entry', 4, ['a', 'n']);
  assert.deepEqual([part.e.changed, part.e.removed, part.e.unchanged, part.e.message_code], [true, ['a'], ['n'], 'on_note']);
  assert.equal(run(t, 'remove', 'note', 1, ['n']).text, '# One\n<!-- tags: a, b -->\nbody\n');
});

test('remove: a tag on two lines of the range goes from both', () => {
  const t = '# One\n<!-- tags: a, b -->\ntext\n<!-- tags: b, c -->\n';
  assert.equal(run(t, 'remove', 'entry', 1, ['b']).text, '# One\n<!-- tags: a -->\ntext\n<!-- tags: c -->\n');
});

test('a note with a front matter: the whole note is refused, an entry is not, a front matter tag cannot be taken off', () => {
  const fm = '---\ntitle: T\ntags: [a, b]\n---\n# One\nbody\n';
  const note = run(fm, 'add', 'note', 1, ['x']);
  assert.deepEqual([note.e.changed, note.e.message_code, note.text], [false, 'front_matter', fm]);
  assert.equal(run(fm, 'add', 'entry', 1, ['x']).e.message_code, 'front_matter', 'a caret inside the front matter is the whole note');
  assert.equal(run(fm, 'add', 'entry', 5, ['x']).text, '---\ntitle: T\ntags: [a, b]\n---\n# One\n<!-- tags: x -->\nbody\n');
  assert.equal(run(fm, 'add', 'entry', 5, ['a']).e.message_code, 'already', 'the front matter\'s tags are on every entry');
  assert.equal(run(fm, 'remove', 'note', 1, ['a']).e.message_code, 'front_matter_tag');
  assert.equal(run(fm, 'remove', 'entry', 5, ['a']).e.message_code, 'front_matter_tag');
  // "---" then a heading is a daily file's rule, not a front matter: the whole note can take a tag
  const daily = '---\n## [10:00:00] a\nbody\n';
  assert.equal(run(daily, 'add', 'note', 1, ['x']).text, '<!-- tags: x -->\n' + daily);
});

test('show: changes nothing and tells the tags of the note and of the entry', () => {
  const t = '<!-- tags: n -->\n# One\n<!-- tags: a -->\nbody\n# Two\n';
  const s = run(t, 'show', 'entry', 4, []);
  assert.deepEqual([s.e.changed, s.e.scope, s.e.note_tags, s.e.entry_tags, s.text], [false, 'entry', ['n'], ['a'], t]);
  const w = run(t, 'show', 'entry', 1, []);
  assert.deepEqual([w.e.scope, w.e.note_tags, w.e.entry_tags], ['note', ['n'], []], 'the front part: the whole note');
  assert.deepEqual(run(t, 'show', 'entry', 5, []).e.entry_tags, []);
  assert.deepEqual(run('', 'show', 'note', 0, []).e.note_tags, []);
});

test('the corners: no line break at the end, an empty text, the empty last line', () => {
  assert.equal(run('# A', 'add', 'entry', 1, ['x']).text, '# A\n<!-- tags: x -->');
  assert.equal(run('# A\n', 'add', 'entry', 2, ['x']).text, '# A\n<!-- tags: x -->\n', 'a caret on the empty last line belongs to the last line');
  assert.equal(run('', 'add', 'note', 1, ['x']).text, '<!-- tags: x -->\n');
  assert.equal(run('# A\n<!-- tags: x -->', 'remove', 'entry', 1, ['x']).text, '# A', 'the last line of a text without a break goes with its break');
  assert.equal(run('# A\r\nbody\r\n', 'add', 'entry', 1, ['x']).text, '# A\r\n<!-- tags: x -->\r\nbody\r\n');
});

test('what the Go side refuses, the mock refuses', () => {
  const t = '# A\nbody\n';
  assert.throws(() => edit(t, 'frobnicate', 'note', 1, ['a']), /unknown op/);
  assert.throws(() => edit(t, 'add', 'file', 1, ['a']), /unknown scope/);
  assert.throws(() => edit(t, 'add', 'entry', 99, ['a']), /outside the text/);
  assert.throws(() => edit(t, 'add', 'entry', 0, ['a']), /outside the text/);
  assert.throws(() => edit(t, 'add', 'entry', undefined, ['a']), /outside the text/);
  assert.doesNotThrow(() => edit(t, 'add', 'note', 99, ['a']), 'a note needs no line');
  assert.throws(() => edit(t, 'add', 'note', 1, []), /no tag/);
  assert.throws(() => edit(t, 'add', 'note', 1, ['  ']), /no tag/);
  assert.throws(() => edit(t, 'add', 'note', 1, ['#']), /no tag/);
  assert.throws(() => edit(t, 'add', 'note', 1, ['a b c d e f g h i']), /too many tags/);
  assert.throws(() => edit(t, 'add', 'note', 1, ['x'.repeat(65)]), /longer than 64/);
  assert.throws(() => edit(t, 'add', 'note', 1, ['a-->b']), /cannot contain/);
  assert.doesNotThrow(() => edit(t, 'show', 'note', 1, []), 'show needs no tag');
  assert.equal(edit(t, 'add', 'note', 1, 'x, y').added.length, 2, 'a list in one string works as in the JSON-RPC method');
});

test('applying a patch twice changes nothing the second time, on generated notes', () => {
  let n = 0;
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const lines = ['# Title', '## Sub', '---', 'body', '', '```', '<!-- tags: old -->', '<!-- tags: b, c -->', 'plain'];
  for (let i = 0; i < 1500; i++) {
    let text = '';
    const count = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < count; k++) text += pick(lines) + (k === count - 1 && rnd() < 0.4 ? '' : '\n');
    const scope = rnd() < 0.5 ? 'note' : 'entry';
    const line = 1 + Math.floor(rnd() * text.split('\n').length);
    const tags = [pick(['a', 'b', 'old', 'z'])];
    const op = pick(['add', 'remove']);
    const first = edit(text, op, scope, line, tags);
    if (!first.changed) continue;
    n++;
    const next = Mock.apply(text, first);
    const lineAfter = scope === 'entry' ? Math.min(line + (first.new_lines.length - (first.end_line - first.start_line)) * (line >= first.end_line ? 1 : 0), next.split('\n').length) : line;
    const again = edit(next, op, scope, Math.max(1, lineAfter), tags);
    assert.equal(again.changed, false, `${JSON.stringify(text)} ${op} ${scope}@${line} ${tags}`);
  }
  assert.ok(n > 300, 'enough changes were made (' + n + ')');
});

console.log(passed + ' tests passed');
