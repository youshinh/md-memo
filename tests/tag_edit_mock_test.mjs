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

// ---- 3. the outline (docs/design/tag-filter-2026-10.md section 11), written here from the contract ---------------------------------------

const show = (text, line) => edit(text, 'show', 'entry', line, []);
const OUTLINE = [
  '# A', 'a1', '## B', 'b1', '### C', 'c1', '## D', 'd1', '# A2', 'x', '---', '## ping', 'p', '### detail', 'z', '# E', '---', '### F', 'f', ''
].join('\n');
const shape = (text, line) => { const s = show(text, line); return s.path.map((p) => `${p.heading}:${p.level}:${p.line}:${p.range_start}-${p.range_end}:${p.descendants}`).join(' > '); };

test('the parent of an entry: a stack of the heading levels (11.1)', () => {
  assert.equal(shape(OUTLINE, 6), 'C:3:5:5-6:0 > B:2:3:3-6:1 > A:1:1:1-8:3', '# A / ## B / ### C: the parent of C is B, of B is A');
  assert.equal(shape(OUTLINE, 8), 'D:2:7:7-8:0 > A:1:1:1-8:3', '## D comes after B and C, and is a child of A');
  assert.equal(shape(OUTLINE, 10), 'A2:1:9:9-10:0', 'a new # starts another tree');
  assert.equal(shape('# A\n### C\nc\n', 2), 'C:3:2:2-3:0 > A:1:1:1-3:1', 'a level may be skipped: C is a child of A');
  assert.equal(shape('# A\n## B\nb\n# A2\nx\n', 5), 'A2:1:4:4-5:0', '## B under # A, then # A2: A2 is a root, not a child of B');
  assert.equal(shape('## B\nb\n# A\nx\n## B2\n', 5), 'B2:2:5:5-5:0 > A:1:3:3-5:1', 'a smaller heading before a larger one does not make the larger its child');
  assert.equal(shape(OUTLINE, 13), 'ping:2:12:11-15:1', '"---" then a heading starts a tree (its rule line is the first line of the entry)');
  assert.equal(shape(OUTLINE, 15), 'detail:3:14:14-15:0 > ping:2:12:11-15:1', 'and the heading below it is its child');
  assert.equal(shape(OUTLINE, 19), 'F:3:18:17-19:0', '# E / --- / ### F: the rule cuts the chain: F is a root');
  assert.equal(shape(OUTLINE, 16), 'E:1:16:16-16:0', 'E has nobody under it: the rule cut it off');
  assert.equal(shape('# A\na\n---\nrule only\n### C\nc\n', 4), ':0:3:3-4:0', 'a rule alone has no heading: level 0, its own line, no descendants, no parent');
  assert.equal(shape('# A\na\n---\nrule only\n### C\nc\n', 6), 'C:3:5:5-6:0', 'and the chain is cut after it (this heading is a root)');
  assert.equal(shape('# A\n\n---\n\n## C\nc\n', 6), 'C:2:5:5-6:0', 'a rule, a blank line, a heading: the heading starts its own entry, after a rule-only entry: a root');
  assert.equal(shape('# A\na\n#### four\nb\n## B\n', 4), 'A:1:1:1-5:1', 'a #### heading is not an entry: its lines belong to the entry above');
});

test('the outline in the answer: descendants, range of the subtree, inherited tags, path; the whole note and a front part have none', () => {
  const t = '<!-- tags: n -->\n# A\n<!-- tags: ta -->\na\n## B\n<!-- tags: tb, ta -->\nb\n### C\n<!-- tags: tc -->\nc\n## D\nd\n';
  const c = show(t, 10);
  assert.deepEqual([c.scope, c.range_start, c.range_end, c.heading, c.heading_line, c.descendants], ['entry', 8, 10, 'C', 8, 0]);
  assert.deepEqual(c.inherited_tags, ['ta', 'tb'], 'the farthest ancestor first, without duplicates, not the whole note\'s');
  assert.deepEqual(c.entry_tags, ['tc'], 'entry_tags is the entry\'s own');
  assert.deepEqual(c.note_tags, ['n']);
  assert.deepEqual(c.path.map((p) => [p.heading, p.tags]), [['C', ['tc']], ['B', ['tb', 'ta']], ['A', ['ta']]]);
  assert.deepEqual([c.parent_heading, c.parent_line], ['', 0]);
  const b = show(t, 5);
  assert.deepEqual([b.range_start, b.range_end, b.descendants], [5, 10, 1], 'B: its own lines and C\'s');
  const a = show(t, 2);
  assert.deepEqual([a.range_start, a.range_end, a.descendants, a.inherited_tags], [2, 12, 3, []]);
  assert.deepEqual(a.path, [{ line: 2, level: 1, heading: 'A', range_start: 2, range_end: 12, descendants: 3, tags: ['ta'] }]);
  const front = show(t, 1);
  assert.deepEqual([front.scope, front.descendants, front.inherited_tags, front.path], ['note', 0, [], []], 'the front part is the whole note');
  const note = edit(t, 'show', 'note', 1, []);
  assert.deepEqual([note.scope, note.descendants, note.inherited_tags, note.path, note.range_start, note.range_end], ['note', 0, [], [], 1, 12]);
  const bare = show('just text\nmore\n', 2);
  assert.deepEqual([bare.scope, bare.path, bare.inherited_tags, bare.descendants], ['note', [], [], 0]);
  const empty = edit('', 'show', 'note', 1, []);
  assert.deepEqual([empty.path, empty.inherited_tags, empty.descendants, empty.parent_heading, empty.parent_line], [[], [], 0, '', 0]);
  const fm = show('---\ntitle: T\n---\n# One\n## Two\nbody\n', 6);
  assert.deepEqual(fm.path.map((p) => p.heading), ['Two', 'One'], 'an entry of a note with a front matter has its path too');
  // a heading is a place by its own line, wherever the caret was: any line of the subtree gives the same entry
  assert.deepEqual(show(t, 9).path[0].line, 8);
});

test('add: the tags the entry gets from above, and the whole note\'s, are on already; a tag put on a heading covers its subtree', () => {
  const t = '# A\n<!-- tags: top -->\na\n## B\nb\n### C\nc\n## D\nd\n';
  assert.deepEqual([run(t, 'add', 'entry', 7, ['top']).e.changed, run(t, 'add', 'entry', 7, ['top']).e.message_code, run(t, 'add', 'entry', 7, ['top']).e.unchanged], [false, 'already', ['top']], 'C gets top from A');
  const mixed = run(t, 'add', 'entry', 7, ['top', 'x']);
  assert.deepEqual([mixed.e.added, mixed.e.unchanged, mixed.e.message_code], [['x'], ['top'], '']);
  assert.equal(mixed.text, '# A\n<!-- tags: top -->\na\n## B\nb\n### C\n<!-- tags: x -->\nc\n## D\nd\n', 'the new tag goes under C\'s own heading');
  const onTop = run(t, 'add', 'entry', 1, ['x']);
  assert.equal(onTop.text, '# A\n<!-- tags: top, x -->\na\n## B\nb\n### C\nc\n## D\nd\n', 'put on the top heading: into its comment line');
  assert.deepEqual([onTop.e.descendants, onTop.e.range_start, onTop.e.range_end, onTop.e.heading, onTop.e.entry_tags], [3, 1, 9, 'A', ['top', 'x']], 'the answer is about the subtree');
  assert.deepEqual(show(onTop.text, 7).inherited_tags, ['top', 'x'], 'and C now gets it');
  assert.equal(run(onTop.text, 'add', 'entry', 7, ['x']).e.message_code, 'already');
  assert.equal(run(onTop.text, 'add', 'entry', 9, ['x']).e.message_code, 'already', 'D too');
  // what the entry has of its own is not what its parent has: the tag below does not make the parent "already"
  assert.equal(run('# A\na\n## B\n<!-- tags: low -->\nb\n', 'add', 'entry', 1, ['low']).e.changed, true);
  // the whole note's tags are on every entry, as before
  assert.equal(run('<!-- tags: n -->\n# A\n## B\nb\n', 'add', 'entry', 4, ['n']).e.message_code, 'already');
});

test('remove: a tag that comes from a heading above is not taken off the entry - on_parent names the heading and its line', () => {
  const t = '<!-- tags: n -->\n# A\n<!-- tags: top, mid -->\na\n## B\n<!-- tags: mid -->\nb\n### C\nc\n';
  const own = run(t, 'remove', 'entry', 9, ['top']);
  assert.deepEqual([own.e.changed, own.e.message_code, own.e.parent_heading, own.e.parent_line, own.e.unchanged, own.text], [false, 'on_parent', 'A', 2, ['top'], t]);
  const nearest = run(t, 'remove', 'entry', 9, ['mid']);
  assert.deepEqual([nearest.e.message_code, nearest.e.parent_heading, nearest.e.parent_line], ['on_parent', 'B', 5], 'the nearest ancestor that has it of its own');
  const note = run(t, 'remove', 'entry', 9, ['n']);
  assert.deepEqual([note.e.message_code, note.e.parent_heading, note.e.parent_line], ['on_note', '', 0], 'the whole note\'s is on_note, as before');
  const both = run(t, 'remove', 'entry', 9, ['n', 'top']);
  assert.deepEqual([both.e.message_code, both.e.parent_heading, both.e.parent_line], ['on_note', '', 0], 'with several: the first one that has a place to look at');
  const both2 = run(t, 'remove', 'entry', 9, ['top', 'n']);
  assert.deepEqual([both2.e.message_code, both2.e.parent_heading, both2.e.parent_line], ['on_parent', 'A', 2]);
  const none = run(t, 'remove', 'entry', 9, ['zz', 'top']);
  assert.deepEqual([none.e.message_code, none.e.parent_line], ['on_parent', 2], 'a reason with a place beats none_found');
  assert.deepEqual(run(t, 'remove', 'entry', 9, ['zz']).e.message_code, 'none_found');
  // it is taken off at the heading it is on: the answer is about that heading and the subtree
  const at = run(t, 'remove', 'entry', 2, ['top']);
  assert.equal(at.text, '<!-- tags: n -->\n# A\n<!-- tags: mid -->\na\n## B\n<!-- tags: mid -->\nb\n### C\nc\n');
  assert.deepEqual([at.e.changed, at.e.descendants, at.e.range_start, at.e.range_end, at.e.message_code, at.e.parent_heading], [true, 2, 2, 9, '', '']);
  // the entry has it of its own and so does a heading above: it comes off the entry, and still reaches it from above (no message)
  const twice = run('# A\n<!-- tags: m -->\n## B\n<!-- tags: m -->\nb\n', 'remove', 'entry', 5, ['m']);
  assert.deepEqual([twice.e.changed, twice.e.message_code, twice.e.removed], [true, '', ['m']]);
  assert.equal(twice.text, '# A\n<!-- tags: m -->\n## B\nb\n');
  // a part taken off, a part from above: the sentence for the part that was not
  const part = run(t, 'remove', 'entry', 6, ['mid', 'top']);
  assert.deepEqual([part.e.changed, part.e.removed, part.e.unchanged, part.e.message_code, part.e.parent_heading, part.e.parent_line], [true, ['mid'], ['top'], 'on_parent', 'A', 2]);
  // a tag that is only on something below is not found here, and the whole-note command still says on_entry for it
  const below = '# A\na\n## B\n<!-- tags: low -->\nb\n';
  assert.equal(run(below, 'remove', 'entry', 1, ['low']).e.message_code, 'none_found');
  assert.equal(run(below, 'remove', 'note', 1, ['low']).e.message_code, 'on_entry');
  // the front matter: a tag of it is front_matter_tag, after the places above
  assert.equal(run('---\ntags: [fm]\n---\n# A\n## B\nb\n', 'remove', 'entry', 6, ['fm']).e.message_code, 'front_matter_tag');
});

test('a tag put on a heading is on every line of its subtree and on no other line (generated notes)', () => {
  let s = 20261004;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pool = ['# T', '## S', '### D', '#### four', '---', 'body', '', '```', '<!-- tags: b -->', 'plain', '## S2'];
  const linesOf = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
  let checked = 0;
  for (let n = 0; n < 1500; n++) {
    let text = '';
    const count = 1 + Math.floor(rnd() * 12);
    for (let k = 0; k < count; k++) text += pick(pool) + (k === count - 1 && rnd() < 0.3 ? '' : '\n');
    const line = 1 + Math.floor(rnd() * Math.max(1, linesOf(text)));
    const r = edit(text, 'add', 'entry', line, ['x']);
    if (r.scope !== 'entry' || !r.changed) continue;
    const next = Mock.apply(text, r);
    const grew = r.new_lines.length - (r.end_line - r.start_line); // 1 for a new line, 0 for a tag put into the comment that was there
    const covered = (L) => L >= r.range_start && L <= r.range_end + grew;
    for (let L = 1; L <= linesOf(next); L++) {
      const a = show(next, L);
      const has = a.note_tags.concat(a.scope === 'entry' ? a.entry_tags.concat(a.inherited_tags) : []).includes('x');
      assert.equal(has, covered(L), `${JSON.stringify(text)} add x @${line}: line ${L} of ${JSON.stringify(next)}, subtree ${r.range_start}-${r.range_end}+${grew}`);
    }
    // and the second time nothing happens, from the line of the heading it went under
    assert.equal(edit(next, 'add', 'entry', r.heading_line > 0 ? r.heading_line : r.range_start, ['x']).changed, false);
    checked++;
  }
  assert.ok(checked > 300, 'enough notes were checked (' + checked + ')');
});

console.log(passed + ' tests passed');
