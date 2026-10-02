// Unit tests for print_panel.js: the parts that are plain functions (what is remembered, the folder and name of a file, and what the backend
// is asked for). The panel itself is checked in a browser (tests/smoke/98_print_panel.mjs).
const assert = require('assert');

global.window = global;
const PP = require('./print_panel.js');

(function testNormalizeKeepsOnlyWhatIsValidAndHeaderIsOffByDefault() {
  assert.deepStrictEqual(PP.normalize(undefined), { paper: 'a4', landscape: false, margin: 'normal', scale: 100, pages: '', headerFooter: false });
  assert.deepStrictEqual(PP.normalize('x'), PP.normalize(null));
  assert.strictEqual(PP.normalize({}).headerFooter, false, 'the header and footer are off unless they were switched on');
  assert.strictEqual(PP.normalize({ headerFooter: 'yes' }).headerFooter, false, 'only a real true switches it on');
  assert.strictEqual(PP.normalize({ headerFooter: true }).headerFooter, true);
  assert.deepStrictEqual(PP.normalize({ paper: 'b5', landscape: true, margin: 'narrow', scale: 125, pages: ' 1-3, 5 ' }),
    { paper: 'b5', landscape: true, margin: 'narrow', scale: 125, pages: '1-3, 5', headerFooter: false });
  for (const paper of PP.PAPERS) assert.strictEqual(PP.normalize({ paper }).paper, paper);
  assert.strictEqual(PP.normalize({ paper: 'a0' }).paper, 'a4', 'an unknown paper falls back');
  assert.strictEqual(PP.normalize({ margin: 'huge' }).margin, 'normal');
  assert.strictEqual(PP.normalize({ scale: 33 }).scale, 100, 'only the scales of the list');
  assert.strictEqual(PP.normalize({ scale: '150' }).scale, 150);
  assert.strictEqual(PP.normalize({ pages: '1; drop' }).pages, '', 'a range is digits, commas, spaces and dashes only');
  assert.strictEqual(PP.normalize({ pages: '1,'.repeat(80) }).pages, '', 'and not too long');
  assert.strictEqual(PP.normalize({ landscape: 'true' }).landscape, false);
})();

(function testFolderAndNameOfAFile() {
  assert.strictEqual(PP.dirname('C:\\Users\\me\\notes\\a.md'), 'C:\\Users\\me\\notes');
  assert.strictEqual(PP.dirname('/home/me/notes/a.md'), '/home/me/notes');
  assert.strictEqual(PP.dirname('C:\\a.md'), 'C:\\', 'the root of a drive keeps its backslash');
  assert.strictEqual(PP.dirname('/a.md'), '/');
  assert.strictEqual(PP.dirname('a.md'), '');
  assert.strictEqual(PP.dirname(''), '');
  assert.strictEqual(PP.dirname(undefined), '');
  assert.strictEqual(PP.basename('C:\\Users\\me\\a b.md'), 'a b.md');
  assert.strictEqual(PP.basename('/x/y.md'), 'y.md');
  assert.strictEqual(PP.basename('y.md'), 'y.md');
  assert.strictEqual(PP.basename(''), '');
})();

(function testWhatTheBackendIsAsked() {
  const saved = PP.requestOf({ paper: 'a3', landscape: true, headerFooter: true }, { title: 'a.md', path: 'C:\\n\\sub\\a.md' }, '(not saved yet)');
  assert.deepStrictEqual(saved, { paper: 'a3', landscape: true, margin: 'normal', scale: 100, pages: '', headerFooter: true, title: 'a.md', location: 'C:\\n\\sub' },
    'the file\'s name above and its folder below');
  const unsaved = PP.requestOf(null, { title: 'Deep search x.md', path: '' }, '(not saved yet)');
  assert.strictEqual(unsaved.title, 'Deep search x.md');
  assert.strictEqual(unsaved.location, '(not saved yet)', 'a note that is not a file says so');
  assert.strictEqual(unsaved.headerFooter, false);
  const noTitle = PP.requestOf(null, { path: 'C:\\n\\b.md' }, 'u');
  assert.strictEqual(noTitle.title, 'b.md', 'the name comes from the path when the tab has no title');
  assert.strictEqual(PP.requestOf(null, null, 'u').title, '');
  const bare = PP.requestOf(null, { title: 'c.md', path: 'c.md' }, 'u');
  assert.strictEqual(bare.location, 'c.md', 'a path with no folder is shown as it is');
})();

(function testTheSheetIsShownWithAGreyMarginAroundIt() {
  // pane 705 px: less the scroll bar (16) and a margin of 20 on each side = 649 px for an A4 sheet of 794 px -> 81 %
  assert.strictEqual(PP.viewHash('a4', false, 705), '#zoom=81');
  assert.strictEqual(PP.viewHash('a4', true, 705), '#zoom=57', 'landscape: the sheet is as wide as the paper is long');
  assert.strictEqual(PP.viewHash('a3', false, 705), '#zoom=57');
  assert.strictEqual(PP.viewHash('nope', false, 705), '#zoom=81', 'an unknown paper is shown as A4');
  assert.strictEqual(PP.viewHash('a4', false, 0), '#view=FitH', 'no width yet: fitted to the width, as before');
  assert.strictEqual(PP.viewHash('a4', false, 50), '#view=FitH', 'a pane too narrow for any margin');
  assert.strictEqual(PP.viewHash('b5', false, 4000), '#zoom=200', 'never above 200 %');
  assert.strictEqual(PP.viewHash('a3', true, 100), '#zoom=25', 'never below 25 %');
})();

(function testTheDefaultsAreFrozenAndOff() {
  assert.ok(Object.isFrozen(PP.DEFAULTS));
  assert.strictEqual(PP.DEFAULTS.headerFooter, false);
  assert.strictEqual(typeof PP.open, 'function');
})();

console.log('print_panel tests passed');
