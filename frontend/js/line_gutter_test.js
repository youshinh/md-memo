// Unit tests for line_gutter.js pure helpers (which lines can wrap, and the gutter text for them).
const assert = require('assert');

global.window = global;
global.document = undefined; // the DOM part is checked in a real browser; rowsFor must not need it here

const LG = require('./line_gutter.js');

// ---- wrapUnits ---------------------------------------------------------------------------------

(function testWrapUnits() {
  assert.strictEqual(LG.wrapUnits(1113, 14), 79, 'a 1113 px row holds 79 one-em units at 14 px');
  assert.strictEqual(LG.wrapUnits(100, 16), 6);
  assert.strictEqual(LG.wrapUnits(0, 14), 0);
  assert.strictEqual(LG.wrapUnits(500, 0), 0);
  assert.strictEqual(LG.wrapUnits(NaN, 14), 0);
})();

// ---- findLongLines -----------------------------------------------------------------------------

(function testCountsEveryLogicalLine() {
  assert.strictEqual(LG.findLongLines('', 10, 4).lines, 1, 'an empty note is one line');
  assert.strictEqual(LG.findLongLines('a', 10, 4).lines, 1);
  assert.strictEqual(LG.findLongLines('a\nb', 10, 4).lines, 2);
  assert.strictEqual(LG.findLongLines('a\nb\n', 10, 4).lines, 3, 'a trailing newline starts one more (empty) line');
  assert.strictEqual(LG.findLongLines('\n\n\n', 10, 4).lines, 4);
})();

(function testOnlyLongLinesAreListedWithTheirIndex() {
  const text = 'short\n' + 'x'.repeat(30) + '\nmid ' + 'y'.repeat(6) + '\n' + 'z'.repeat(11);
  const r = LG.findLongLines(text, 10, 4);
  assert.strictEqual(r.lines, 4);
  assert.deepStrictEqual(r.long, [
    { i: 1, s: 'x'.repeat(30) },
    { i: 3, s: 'z'.repeat(11) }
  ]);
  // exactly `units` long still fits on one row
  assert.deepStrictEqual(LG.findLongLines('a'.repeat(10), 10, 4).long, []);
  assert.strictEqual(LG.findLongLines('a'.repeat(11), 10, 4).long.length, 1);
})();

(function testTabsCountAsTabSizeUnits() {
  // 6 characters, two of them tabs: 6 + 2*(4-1) = 12 units
  assert.strictEqual(LG.findLongLines('a\tb\tcd', 11, 4).long.length, 1, 'tabs widen the line');
  assert.strictEqual(LG.findLongLines('a\tb\tcd', 12, 4).long.length, 0);
  // a tab on an earlier line must not be charged to a later line
  const text = '\tx\n' + 'k'.repeat(8);
  assert.deepStrictEqual(LG.findLongLines(text, 9, 4).long, [], 'the second line is 8 units, no tab in it');
  assert.deepStrictEqual(LG.findLongLines(text, 4, 4).long.map((l) => l.i), [0, 1], 'the tab line is 5 units, the other 8');
})();

(function testCrLfFreeAndUnicode() {
  const jp = 'あ'.repeat(40);
  assert.strictEqual(LG.findLongLines(jp, 39, 4).long.length, 1, 'full-width characters count one unit each');
  assert.strictEqual(LG.findLongLines(jp, 40, 4).long.length, 0);
})();

// ---- gutterBlockText ---------------------------------------------------------------------------

(function testGutterBlockTextPutsTheNumberOnTheFirstRow() {
  const rows = Uint32Array.from([1, 3, 1, 2]);
  assert.strictEqual(LG.gutterBlockText(0, 4, rows), '1\n2\n\n\n3\n4\n\n');
  // one number per line, and as many text rows as the lines take together
  const s = LG.gutterBlockText(0, 4, rows);
  assert.strictEqual(s.split('\n').length - 1, 1 + 3 + 1 + 2, 'rows of gutter = rows of text');
  assert.strictEqual(s.split('\n').filter((x) => x !== '').length, 4, 'four numbers');
})();

(function testGutterBlockTextForARange() {
  const rows = Uint32Array.from([1, 1, 2, 1]);
  assert.strictEqual(LG.gutterBlockText(2, 4, rows), '3\n\n4\n', 'numbers keep their own line number, not the position in the block');
  assert.strictEqual(LG.gutterBlockText(0, 0, rows), '');
})();

(function testPlainRowsGiveThePlainGutter() {
  const rows = new Uint32Array(5).fill(1);
  assert.strictEqual(LG.gutterBlockText(0, 5, rows), '1\n2\n3\n4\n5\n');
})();

// ---- rowsFor ---------------------------------------------------------------------------------

(function testRowsForNeedsNoDomWhenThereIsNothingToMeasure() {
  assert.strictEqual(LG.rowsFor(null), null);
  assert.strictEqual(LG.rowsFor({ value: 'text', clientWidth: 800 }), null, 'no document: plain numbering');
})();

console.log('line_gutter_test.js: all assertions passed');
