// Unit tests for disk_sync.js: the fingerprint (shared vectors with pkg/textsig), the file's line ending, and the plan for a file seen
// changed on disk. The behaviour in the real page (save refused, flagged tab, CRLF kept) is tests/smoke/66_file_changed_on_disk.mjs.
const assert = require('assert');
const DS = require('./disk_sync.js');

// The same vectors as pkg/textsig/textsig_test.go: the page and the Go side must agree on one text, or every save would be refused.
const VECTORS = [
  ['', '0-bdcb81aee8d83'],
  ['a', '1-1c2ba782c97901'],
  ['hello\nworld', 'b-6bfbd9b9e5295'],
  ['hello\r\nworld', 'b-6bfbd9b9e5295'],
  ['hello\rworld', 'b-6bfbd9b9e5295'],
  ['日本語のメモ\n二行目', 'a-16fd479b32b673'],
  ['emoji 😀 x', 'a-a2882ef1032fe'],
  ['mix \u{1F600}\r\n日本', '9-3b4fa21a35574'],
  ['# 2026-10-02\n\n- a\n- b\n', '16-11b4cc9cb86841'],
  ['x'.repeat(5000), '1388-c7e5049271672']
];

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

check('the fingerprint is the one Go computes (shared vectors)', () => {
  for (const [text, want] of VECTORS) assert.strictEqual(DS.sum(text), want, JSON.stringify(text.slice(0, 20)));
});

check('a one-character change changes the fingerprint; line endings do not', () => {
  const base = DS.sum('one line\nsecond');
  assert.notStrictEqual(base, DS.sum('one line\nsecond.'));
  assert.notStrictEqual(base, DS.sum('one line\nSecond'));
  assert.notStrictEqual(base, DS.sum('one line\n second'));
  assert.strictEqual(DS.sum('a\nb'), DS.sum('a\r\nb'));
});

check('detectEol: CRLF when most breaks are CRLF, otherwise LF', () => {
  assert.strictEqual(DS.detectEol('a\r\nb\r\nc'), 'crlf');
  assert.strictEqual(DS.detectEol('a\nb\nc'), 'lf');
  assert.strictEqual(DS.detectEol('no break'), 'lf');
  assert.strictEqual(DS.detectEol(''), 'lf');
  assert.strictEqual(DS.detectEol('a\r\nb\nc\nd'), 'lf', 'mostly LF');
  assert.strictEqual(DS.detectEol('a\r\nb\r\nc\nd'), 'crlf', 'mostly CRLF');
  assert.strictEqual(DS.detectEol(undefined), 'lf');
});

check('applyEol writes the file\'s own line ending and never doubles one', () => {
  assert.strictEqual(DS.applyEol('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.strictEqual(DS.applyEol('a\r\nb\r\n', 'crlf'), 'a\r\nb\r\n');
  assert.strictEqual(DS.applyEol('a\nb\n', 'lf'), 'a\nb\n');
  assert.strictEqual(DS.applyEol('a\nb\n', undefined), 'a\nb\n');
  assert.strictEqual(DS.applyEol('no break', 'crlf'), 'no break');
  assert.strictEqual(DS.applyEol('', 'crlf'), '');
});

check('planExternalChange: ignore the app\'s own save, reload a clean note, flag a note with unsaved text', () => {
  const same = DS.sum('text');
  const other = DS.sum('text changed elsewhere');
  assert.strictEqual(DS.planExternalChange({ tabSig: same, diskSig: same, hasUnsavedText: true }), 'ignore');
  assert.strictEqual(DS.planExternalChange({ tabSig: same, diskSig: same, hasUnsavedText: false }), 'ignore');
  assert.strictEqual(DS.planExternalChange({ tabSig: same, diskSig: other, hasUnsavedText: false }), 'reload');
  assert.strictEqual(DS.planExternalChange({ tabSig: same, diskSig: other, hasUnsavedText: true }), 'conflict');
  // a tab that never learned the file: a clean one shows the file, one with unsaved text has nothing to compare (the old behaviour)
  assert.strictEqual(DS.planExternalChange({ tabSig: '', diskSig: other, hasUnsavedText: false }), 'reload');
  assert.strictEqual(DS.planExternalChange({ tabSig: '', diskSig: other, hasUnsavedText: true }), 'ignore');
  assert.strictEqual(DS.planExternalChange({ tabSig: same, diskSig: '', hasUnsavedText: false }), 'ignore', 'no reading, no decision');
  assert.strictEqual(DS.planExternalChange(null), 'ignore');
});

check('a 3.7 MB note is fingerprinted in well under half a second', () => {
  const big = ('line of a note, with some text in it\n').repeat(100000); // ~3.7 MB
  const t0 = Date.now();
  DS.sum(big);
  const ms = Date.now() - t0;
  assert.ok(ms < 400, `fingerprinting 3.7 MB took ${ms} ms`);
  console.log(`      (3.7 MB: ${ms} ms)`);
});

console.log(`\ndisk_sync_test.js: ${passed} passed`);
