// A tag under a heading applies to every smaller heading below it (docs/design/tag-filter-2026-10.md section 11), and a selected word is the
// first tag in the box (11.7). The backend is the mock: its tagEdit is a port of search.EditTags with the outline (tools/docshots/mock/
// tag_edit_mock.js, checked against the Go side's golden cases by tests/tag_edit_mock_test.mjs). The note is a Web article under a heading
// with smaller headings of its own:  # Bamboo { ## Growth, ## Uses { ### Processing, ### Tools } }  and  # Shopping  (another tree).
//   - from a sub-section the picker has a "where" row: the sub-section, "Uses", "Bamboo", each with its lines, the nearest first and chosen;
//     the chip says the chosen place, its subtree range and, when something is under it, "and everything under it" with how many entries
//   - a click on a place and Ctrl+Up / Ctrl+Down (parent / child) change it, stop at the ends, and leave the list's own row alone
//   - a selection of several lines starts at the lowest heading its first and last line's entries have in common (from "## Growth" through the
//     end of "### Tools": Bamboo; from the top heading: Bamboo; inside one section: that section; across two trees: the first entry); the last
//     line is asked for only then, the default waits for both answers, never takes back a place the person chose, and a failed answer is silent
//   - a tag put on "Bamboo" is written under its heading (line 1), the status line says it also applies to 4 entries, one Ctrl+Z gives the
//     text back; every sub-section then has it (the backend's answer, and the picker: it is on already there and not offered)
//   - the tag on the sub-sections is taken off at the heading it is on (Remove lists it "from Bamboo (line 1)"), and the on_parent sentence
//     names the heading and its line when the backend refuses a removal on the sub-section itself
//   - an entry with nothing above or under it (the other tree) has no "where" row, the plain hint and the plain chip
//   - a selected word is the first thing in the box, all selected: Enter adds it, typing replaces it, Backspace empties it; two words, several
//     lines, and the Remove command give an empty box
//   - the whole-note command and an older backend (no outline in the answer) have no "where" row
import { assert, clickSelector, focusEditor, noteText, openPalette, paletteTitles, selectInEditor, settle, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { phrase, visible } from './semantic_lib.mjs';

const NOTE = [
  '# Bamboo',          // 1
  'Collected from the web.',
  '## Growth',         // 3
  'Bamboo grows fast.',
  '## Uses',           // 5
  'Used in building.',
  '### Processing',    // 7
  'Split it then dry it.',
  'Dry for weeks.',
  '### Tools',         // 10
  'sharp knife',
  '# Shopping',        // 12
  'milk',
  ''
].join('\n');
const TAG = (tags) => `<!-- tags: ${tags} -->`;

export default {
  title: 'tags under a heading: the where row (click, Ctrl+Up/Down, chip with the subtree), a tag on the top heading covers every sub-section, taking an inherited tag off at its heading, on_parent, a selected word as the first tag',
  session: { notes: [{ title: 'a.md', content: NOTE }] },
  timeoutMs: 120000,

  async run(s, t) {
    const word = t.pick('tag', 'タグ');
    const editor = (expr) => s.ev(`(function () { var e = document.getElementById('editor'); return ${expr}; })()`);
    const waitStatus = (text) => s.waitFor(`window.__explore.state().statusText === ${JSON.stringify(text)}`);
    const rowTitles = () => s.ev("Array.from(document.querySelectorAll('#tag-pick-list .quick-pick-item-title')).map(function (e) { return e.textContent; })");
    const rowDescs = () => s.ev("Array.from(document.querySelectorAll('#tag-pick-list .tag-pick-item')).map(function (e) { var d = e.querySelector('.quick-pick-item-desc'); return d ? d.textContent : ''; })");
    const waitRows = (n) => s.waitFor(`document.querySelectorAll('#tag-pick-list .tag-pick-item').length === ${n}`);
    const activeRow = () => s.ev("Array.prototype.indexOf.call(document.querySelectorAll('#tag-pick-list .tag-pick-item'), document.querySelector('#tag-pick-list .tag-pick-item.active'))");
    const chip = () => s.ev("document.getElementById('tag-pick-context').textContent");
    const hint = () => s.ev("document.getElementById('tag-pick-hint').textContent");
    const inputValue = () => s.ev("document.getElementById('tag-pick-input').value");
    const inputSelection = () => s.ev("(function () { var i = document.getElementById('tag-pick-input'); return [i.selectionStart, i.selectionEnd]; })()");
    const whereShown = () => visible(s, 'tag-pick-where');
    const choices = () => s.ev("Array.from(document.querySelectorAll('#tag-pick-where [data-place]')).map(function (e) { return e.textContent; })");
    const chosen = () => s.ev("Array.prototype.indexOf.call(document.querySelectorAll('#tag-pick-where [data-place]'), document.querySelector('#tag-pick-where [data-place][aria-checked=\"true\"]'))");
    const noWhereLabel = () => s.ev("(document.querySelector('#tag-pick-where .tag-pick-where-label') || { textContent: null }).textContent");
    const waitChip = async (text) => { await s.waitFor(`document.getElementById('tag-pick-context').textContent === ${JSON.stringify(text)}`); };

    const runCommand = async (key) => {
      const title = await phrase(s, key);
      await openPalette(s);
      await s.type(word);
      await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
      const titles = await paletteTitles(s);
      const at = titles.indexOf(title);
      assert.ok(at >= 0, `"${title}" is among the matches of "${word}": ${JSON.stringify(titles)}`);
      for (let i = 0; i < at; i++) await s.key('ArrowDown');
      await s.waitFor(`Array.prototype.indexOf.call(document.querySelectorAll('#quick-pick-list .quick-pick-item'), document.querySelector('#quick-pick-list .quick-pick-item.active')) === ${at}`);
      await s.key('Enter');
    };
    // The picker is open once it is shown and has the focus (the backend's answer comes a moment later: a flow waits for what it reads)
    const openPicker = async (key) => {
      await runCommand(key);
      await waitShown(s, 'tag-pick-modal');
      await waitFocus(s, 'tag-pick-input');
    };
    const closed = async () => {
      await waitHidden(s, 'tag-pick-modal');
      await waitFocus(s, 'editor');
    };
    const caretAt = async (needle) => { await selectInEditor(s, needle, { caretOnly: true }); };
    const ctx = (heading, start, end) => phrase(s, 'tagEditCtxEntryHead', { heading, start, end });
    const tree = async (heading, start, end, n) => phrase(s, 'tagEditCtxTreeHead', { heading, start, end, under: await phrase(s, n === 1 ? 'tagEditUnderOne' : 'tagEditUnder', { n }) });
    const choice = (heading, start, end) => phrase(s, 'tagEditPlaceChoice', { heading, start, end });
    const askBackend = (req) => s.ev(`window.backend.tagEdit(${JSON.stringify(req)}).then(function (r) { return JSON.parse(JSON.stringify(r)); })`);
    const lineOf = (text, needle) => text.split('\n').indexOf(needle) + 1;

    await focusEditor(s);

    t.step('from a sub-section the picker has a "where" row: the sub-section, "Uses", "Bamboo", each with its lines, the nearest first and chosen');
    await caretAt('Split it');
    const original = await noteText(s);
    assert.equal(original, NOTE);
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await waitShown(s, 'tag-pick-where');
    assert.equal(await whereShown(), true, 'the row is there: there is more than one place to choose from');
    assert.deepEqual(await choices(), [await choice('Processing', 7, 9), await choice('Uses', 5, 11), await choice('Bamboo', 1, 11)]);
    assert.equal(await chosen(), 0, 'the entry itself is chosen');
    assert.equal(await noWhereLabel(), await phrase(s, 'tagEditPlaceLabelAdd'));
    assert.equal(await chip(), await ctx('Processing', 7, 9), 'nothing is under Processing: the chip is the plain one');
    assert.equal(await hint(), await phrase(s, 'tagEditHintAddWhere'), 'the hint line tells the keys');
    assert.deepEqual(await rowTitles(), ['work', 'reading', 'urgent', 'idea']);

    t.step('Ctrl+Up goes to the parent heading, Ctrl+Down back to the child, both stop at the ends; the list keeps its own row');
    await s.key('ArrowDown');
    await s.waitFor('Array.prototype.indexOf.call(document.querySelectorAll("#tag-pick-list .tag-pick-item"), document.querySelector("#tag-pick-list .tag-pick-item.active")) === 1');
    await s.key('ArrowUp', { ctrl: true });
    await waitChip(await tree('Uses', 5, 11, 2));
    assert.equal(await chosen(), 1);
    assert.equal(await activeRow(), 0, 'a new place starts the list again at its first row');
    await s.key('ArrowUp', { ctrl: true });
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.equal(await chosen(), 2);
    await s.key('ArrowUp', { ctrl: true });
    await settle(150);
    assert.equal(await chosen(), 2, 'there is nothing above the top heading');
    await s.key('ArrowDown', { ctrl: true });
    await waitChip(await tree('Uses', 5, 11, 2));
    await s.key('ArrowDown', { ctrl: true });
    await waitChip(await ctx('Processing', 7, 9));
    await s.key('ArrowDown', { ctrl: true });
    await settle(150);
    assert.equal(await chosen(), 0, 'and nothing below the entry');
    assert.equal(await noteText(s), original, 'choosing a place changes nothing in the note');

    t.step('a click on a place chooses it as well (the box keeps the focus)');
    await clickSelector(s, '#tag-pick-where [data-place="1"]');
    await waitChip(await tree('Uses', 5, 11, 2));
    assert.equal(await s.ev('document.activeElement && document.activeElement.id'), 'tag-pick-input');
    await clickSelector(s, '#tag-pick-where [data-place="2"]');
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.equal(await chosen(), 2);

    t.step('Enter on the top heading: the line goes under that heading, the status line says it also applies to the 4 entries under it; one Ctrl+Z');
    await s.type('bamboo');
    await s.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && document.querySelector('#tag-pick-list .quick-pick-item-title').textContent.indexOf('bamboo') !== -1");
    await s.key('Enter');
    await closed();
    const withTop = original.split('\n');
    withTop.splice(1, 0, TAG('bamboo'));
    const tagged = withTop.join('\n');
    assert.equal(await noteText(s), tagged, 'one line, directly under "# Bamboo"');
    await waitStatus(`${await phrase(s, 'tagEditAddedEntryHead', { tags: 'bamboo', heading: 'Bamboo', line: 2 })} ${await phrase(s, 'tagEditAlsoUnder', { n: 4 })}`);
    const asked = await s.ev('window.__docshot.calls.filter(function (c) { return c.fn === "tagEdit"; }).map(function (c) { return c.args[0]; })');
    const add = asked.filter((r) => r && r.op === 'add').pop();
    assert.deepEqual([add.scope, add.line, add.tags], ['entry', 1, ['bamboo']], 'the request names the heading of the chosen place, not the caret\'s line');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original, 'one Ctrl+Z gives the text back');
    await s.key('y', { ctrl: true });
    assert.equal(await noteText(s), tagged, 'and Redo writes it again');

    t.step('every sub-section has the tag now (the backend\'s answer), and the other tree does not');
    for (let line = 1; line <= 12; line++) {
      const a = await askBackend({ text: tagged, op: 'show', scope: 'entry', line, tags: [] });
      assert.equal([].concat(a.entry_tags, a.inherited_tags).includes('bamboo'), true, `line ${line} (${JSON.stringify(tagged.split('\n')[line - 1])}) has the tag`);
    }
    const shop = await askBackend({ text: tagged, op: 'show', scope: 'entry', line: lineOf(tagged, 'milk'), tags: [] });
    assert.deepEqual([shop.entry_tags, shop.inherited_tags, shop.path.length, shop.descendants], [[], [], 1, 0], 'the other tree has nothing');
    const again = await askBackend({ text: tagged, op: 'add', scope: 'entry', line: lineOf(tagged, 'Dry for weeks.'), tags: ['bamboo'] });
    assert.deepEqual([again.changed, again.message_code, again.unchanged], [false, 'already', ['bamboo']]);

    t.step('the picker on a sub-section: the tag is on already (not offered; typed, it says so), and Remove lists it as coming from "Bamboo"');
    await caretAt('Dry for weeks.');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await waitShown(s, 'tag-pick-where');
    assert.deepEqual(await rowTitles(), ['work', 'reading', 'urgent', 'idea'], 'bamboo is on it, so it is not offered from the note\'s own tags');
    await s.type('bamboo');
    await s.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && document.querySelector('#tag-pick-list .quick-pick-item-title').textContent === " + JSON.stringify(await phrase(s, 'tagEditOnAlready', { tags: 'bamboo' })));
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditAlready', { tags: 'bamboo' }));
    assert.equal(await noteText(s), tagged, 'the text is not touched');
    await caretAt('Dry for weeks.');
    await openPicker('cmdPaletteTagRemove');
    await waitRows(1);
    await waitShown(s, 'tag-pick-where');
    assert.equal(await whereShown(), true, 'Remove has the row too');
    assert.equal(await noWhereLabel(), await phrase(s, 'tagEditPlaceLabelRemove'));
    assert.equal(await hint(), await phrase(s, 'tagEditHintRemoveWhere'));
    assert.deepEqual(await rowTitles(), ['bamboo']);
    assert.deepEqual(await rowDescs(), [await phrase(s, 'tagEditWhereParent', { heading: 'Bamboo', line: 1 })], 'where it comes from');
    await s.key('ArrowUp', { ctrl: true }); // "Uses": it gets the tag from Bamboo as well
    await waitChip(await tree('Uses', 6, 12, 2)); // (the tag line made every line below it one further down)
    assert.deepEqual(await rowDescs(), [await phrase(s, 'tagEditWhereParent', { heading: 'Bamboo', line: 1 })]);
    await s.key('ArrowUp', { ctrl: true }); // "Bamboo" itself: the tag is its own
    await waitChip(await tree('Bamboo', 1, 12, 4));
    assert.deepEqual(await rowDescs(), [await phrase(s, 'tagEditWhereHeading', { heading: 'Bamboo' })], 'on Bamboo itself it is its own tag, said with its name');
    await s.key('ArrowDown', { ctrl: true });
    await s.key('ArrowDown', { ctrl: true });
    await waitChip(await ctx('Processing', 8, 10));

    t.step('Enter on it takes the tag off at the heading it comes from: the line goes, the text is the first one again');
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditRemovedEntryHead', { tags: 'bamboo', heading: 'Bamboo' }));
    assert.equal(await noteText(s), original, 'the line with no tag left is deleted: byte for byte the first text');
    const removed = await s.ev('window.__docshot.calls.filter(function (c) { return c.fn === "tagEdit"; }).map(function (c) { return c.args[0]; })');
    const rm = removed.filter((r) => r && r.op === 'remove').pop();
    assert.deepEqual([rm.scope, rm.line], ['entry', 1], 'asked at the heading it comes from (Bamboo, line 1), not at the caret');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), tagged, 'one Ctrl+Z puts it back');
    await s.key('y', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('on_parent: when the backend is asked to take it off the sub-section itself, the sentence names the heading and its line');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), tagged);
    await s.ev(`(function () {
      window.__savedTagEditForce = window.backend.tagEdit;
      window.backend.tagEdit = function (req) {
        if (req && req.op === 'remove' && req.scope === 'entry') req = Object.assign({}, req, { line: ${tagged.split('\n').indexOf('Dry for weeks.') + 1} });
        return window.__savedTagEditForce.call(this, req);
      };
      return 1;
    })()`);
    await caretAt('Dry for weeks.');
    await openPicker('cmdPaletteTagRemove');
    await waitRows(1);
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditOnParent', { heading: 'Bamboo', line: 1 }));
    assert.equal(await noteText(s), tagged, 'nothing was changed');
    await s.ev('window.backend.tagEdit = window.__savedTagEditForce; 1');
    await caretAt('Dry for weeks.'); // and with the real backend the same pick takes the tag off, at the heading it comes from
    await openPicker('cmdPaletteTagRemove');
    await waitRows(1);
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditRemovedEntryHead', { tags: 'bamboo', heading: 'Bamboo' }));
    assert.equal(await noteText(s), original);

    t.step('an entry with nothing above or under it (the other tree): no "where" row, the plain hint, the plain chip');
    await caretAt('milk');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await waitChip(await ctx('Shopping', 12, 13));
    assert.equal(await whereShown(), false, 'nothing to choose between');
    assert.equal(await s.ev("document.getElementById('tag-pick-where').innerHTML"), '', 'and nothing was built');
    assert.equal(await hint(), await phrase(s, 'tagEditHintAdd'));
    assert.equal(await chip(), await ctx('Shopping', 12, 13));
    await s.key('ArrowUp', { ctrl: true });
    await settle(150);
    assert.equal(await chip(), await ctx('Shopping', 12, 13), 'Ctrl+Up has nothing to do');
    await s.key('Escape');
    await closed();
    // a top heading with nothing above it but something under it: no row (one place), and the chip says what it covers
    await caretAt('Collected');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await waitChip(await tree('Bamboo', 1, 11, 4)); // the chip says "and everything under it" and how many
    assert.equal(await whereShown(), false, 'one place only');
    await s.key('Escape');
    await closed();

    t.step('a selection of several lines starts at the lowest heading the entries of its first and last line have in common');
    const at = (needle) => original.indexOf(needle);
    const select = (from, to) => s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(${from}, ${to}); })()`);
    const showCount = () => s.ev('window.__docshot.calls.filter(function (c) { return c.fn === "tagEdit" && c.args[0] && c.args[0].op === "show"; }).length');
    const wrapShow = (line, mode) => s.ev(`(function () {
      if (!window.__savedTagEditSel) window.__savedTagEditSel = window.backend.tagEdit;
      window.backend.tagEdit = function (req) {
        var self = this;
        if (req && req.op === 'show' && req.line === ${line}) {
          ${mode === 'hold' ? "return new Promise(function (res) { window.__releaseLast = function () { res(window.__savedTagEditSel.call(self, req)); }; });" : "return Promise.reject(new Error('the last line cannot be read'));"}
        }
        return window.__savedTagEditSel.call(this, req);
      };
      return 1;
    })()`);
    const unwrapShow = () => s.ev('if (window.__savedTagEditSel) { window.backend.tagEdit = window.__savedTagEditSel; delete window.__savedTagEditSel; } 1');
    const openWith = async (from, to, key = 'cmdPaletteTagEntry') => {
      await select(from, to);
      const before = await showCount();
      await openPicker(key);
      return before;
    };
    const growthToTools = [at('## Growth'), at('sharp knife') + 'sharp knife'.length];

    // from "## Growth" through the end of "### Tools": Bamboo holds both, so it is the default
    let before = await openWith(...growthToTools);
    await waitRows(4);
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.deepEqual(await choices(), [await choice('Growth', 3, 4), await choice('Bamboo', 1, 11)]);
    assert.equal(await chosen(), 1, 'the common heading is chosen, not the first entry');
    assert.equal(await inputValue(), '', 'several lines are not a word');
    assert.equal((await showCount()) - before, 2, 'the first and the last line were asked for');
    await s.key('Escape');
    await closed();

    // the same selection ending right after the line break of its last line (the start of the next line): that line is not in it
    await openWith(growthToTools[0], at('# Shopping'));
    await waitRows(4);
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.equal(await chosen(), 1, 'the selection still ends in "Tools"');
    await s.key('Escape');
    await closed();

    // one character into "# Shopping": the other tree. Nothing in common: the entry of the first line
    await openWith(growthToTools[0], at('# Shopping') + 3);
    await waitRows(4);
    await waitChip(await phrase(s, 'tagEditCtxEntryHead', { heading: 'Growth', start: 3, end: 4 }));
    assert.equal(await chosen(), 0);
    await s.key('Escape');
    await closed();

    // from a sub-section into its sibling's sub-section: Uses holds both
    await openWith(at('Split it'), at('sharp knife') + 5);
    await waitRows(4);
    await waitChip(await tree('Uses', 5, 11, 2));
    assert.deepEqual(await choices(), [await choice('Processing', 7, 9), await choice('Uses', 5, 11), await choice('Bamboo', 1, 11)]);
    assert.equal(await chosen(), 1);
    await s.key('Escape');
    await closed();

    // inside one section (two lines of "Processing"): the section, as with a caret
    before = await openWith(at('Split it'), at('Dry for weeks.') + 4);
    await waitRows(4);
    await waitChip(await ctx('Processing', 7, 9));
    assert.equal(await chosen(), 0);
    assert.equal((await showCount()) - before, 2, 'it is not known before the answer that both lines are in one entry');
    await s.key('Escape');
    await closed();

    // from the top heading itself: it has nothing above it, so no row, and the chip says what it covers
    await openWith(at('# Bamboo'), at('Dry for weeks.') + 4);
    await waitRows(4);
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.equal(await whereShown(), false);
    await s.key('Escape');
    await closed();

    // from "## Uses" down into its own "Processing": Uses holds both (the first entry itself)
    await openWith(at('## Uses'), at('Dry for weeks.') + 4);
    await waitRows(4);
    await waitChip(await tree('Uses', 5, 11, 2));
    assert.deepEqual(await choices(), [await choice('Uses', 5, 11), await choice('Bamboo', 1, 11)]);
    assert.equal(await chosen(), 0);
    await s.key('Escape');
    await closed();

    t.step('only one answer for a caret, a one-line selection and the whole-note command; Remove has the same default');
    before = await openWith(at('Split it'), at('Split it') + 8);
    await waitRows(4);
    await waitChip(await ctx('Processing', 7, 9));
    assert.equal((await showCount()) - before, 1, 'a selection inside one line asks once');
    await s.key('Escape');
    await closed();
    before = await openWith(at('Split it'), at('Split it'));
    await waitRows(4);
    await waitChip(await ctx('Processing', 7, 9));
    assert.equal((await showCount()) - before, 1, 'a caret asks once');
    await s.key('Escape');
    await closed();
    before = await openWith(...growthToTools, 'cmdPaletteTagNote');
    await waitChip(await phrase(s, 'tagEditCtxNote'));
    assert.equal((await showCount()) - before, 1, 'the whole-note command has no place to choose: it asks once');
    await s.key('Escape');
    await closed();
    before = await openWith(...growthToTools, 'cmdPaletteTagRemove');
    await waitChip(await tree('Bamboo', 1, 11, 4));
    assert.equal(await chosen(), 1, 'Remove starts at the common heading too');
    assert.equal(await noWhereLabel(), await phrase(s, 'tagEditPlaceLabelRemove'));
    assert.equal((await showCount()) - before, 2);
    await s.key('Escape');
    await closed();

    t.step('the default waits for both answers and never takes back a place the person chose before the second one came');
    await wrapShow(at('sharp knife') >= 0 ? original.slice(0, at('sharp knife')).split('\n').length : 0, 'hold');
    await openWith(at('Split it'), at('sharp knife') + 5);
    await waitRows(4);
    await waitShown(s, 'tag-pick-where');
    assert.equal(await chosen(), 0, 'while the last line\'s answer is awaited the entry\'s own place is shown');
    await s.ev('window.__releaseLast(); 1');
    await waitChip(await tree('Uses', 5, 11, 2));
    assert.equal(await chosen(), 1, 'and when it is in, the common heading is chosen');
    await s.key('Escape');
    await closed();
    await openWith(at('Split it'), at('sharp knife') + 5);
    await waitRows(4);
    await waitShown(s, 'tag-pick-where');
    await s.key('ArrowUp', { ctrl: true });
    await s.key('ArrowUp', { ctrl: true });
    await waitChip(await tree('Bamboo', 1, 11, 4));
    await s.ev('window.__releaseLast(); 1');
    await settle(250);
    assert.equal(await chosen(), 2, 'the place the person chose stays');
    assert.equal(await chip(), await tree('Bamboo', 1, 11, 4));
    await s.key('Escape');
    await closed();
    await unwrapShow();

    t.step('when the last line cannot be read the first entry\'s own place stays, with no complaint');
    await wrapShow(original.slice(0, at('sharp knife')).split('\n').length, 'fail');
    await openWith(at('Split it'), at('sharp knife') + 5);
    await waitRows(4);
    await waitShown(s, 'tag-pick-where');
    await waitChip(await ctx('Processing', 7, 9));
    await settle(250);
    assert.equal(await chosen(), 0);
    assert.equal(await s.ev("document.querySelector('#tag-pick-list .tag-pick-note-warn') !== null"), false, 'no warning: the choice is only a help');
    await s.key('Escape');
    await closed();
    await unwrapShow();
    assert.equal(await noteText(s), original);

    t.step('a selected word is the first thing in the box, all selected: Enter adds it, in lower case, under the heading it is in');
    await selectInEditor(s, 'Collected');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(1);
    assert.equal(await inputValue(), 'Collected');
    assert.deepEqual(await inputSelection(), [0, 'Collected'.length], 'all of it is selected');
    assert.deepEqual(await rowTitles(), [await phrase(s, 'tagEditNew', { tags: 'collected' })], 'treated as typed: a new tag');
    await waitChip(await tree('Bamboo', 1, 11, 4));
    await s.key('Enter');
    await closed();
    const withWord = original.split('\n');
    withWord.splice(1, 0, TAG('collected'));
    assert.equal(await noteText(s), withWord.join('\n'));
    await waitStatus(`${await phrase(s, 'tagEditAddedEntryHead', { tags: 'collected', heading: 'Bamboo', line: 2 })} ${await phrase(s, 'tagEditAlsoUnder', { n: 4 })}`);
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('typing replaces the word; Backspace empties the box; a known tag is the one of the list; the word of a heading line, with its marks cleaned');
    await selectInEditor(s, 'milk');
    await openPicker('cmdPaletteTagEntry');
    assert.equal(await inputValue(), 'milk');
    await s.type('zz');
    assert.equal(await inputValue(), 'zz', 'typing replaced the selected word');
    await s.key('Escape');
    await closed();
    await selectInEditor(s, 'milk');
    await openPicker('cmdPaletteTagEntry');
    await s.key('Backspace');
    await s.waitFor("document.getElementById('tag-pick-input').value === ''");
    await waitRows(4);
    await s.key('Escape');
    await closed();
    await s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); var i = e.value.indexOf('Bamboo grows'); e.setSelectionRange(i, i + 'Bamboo'.length); })()`);
    await openPicker('cmdPaletteTagEntry');
    assert.equal(await inputValue(), 'Bamboo');
    await s.key('Escape');
    await closed();
    // "# Bamboo": the selection starts at the # marks; they are not part of the tag
    await s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(0, '# Bamboo'.length); })()`);
    await openPicker('cmdPaletteTagEntry');
    assert.equal(await inputValue(), 'Bamboo', 'the heading\'s # is taken off');
    await s.key('Enter');
    await closed();
    const heads = original.split('\n');
    heads.splice(1, 0, TAG('bamboo'));
    assert.equal(await noteText(s), heads.join('\n'), 'the selection was the heading line: the entry is the top heading');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('two words, a selection over a line break, and the Remove command leave the box empty; the whole-note command takes the word');
    await selectInEditor(s, 'Split it');
    await openPicker('cmdPaletteTagEntry');
    assert.equal(await inputValue(), '', 'two words are not one tag');
    await s.key('Escape');
    await closed();
    const cross = original.indexOf('Used in building.');
    await s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(${cross}, ${cross + 'Used in building.'.length + 1}); })()`);
    await openPicker('cmdPaletteTagEntry');
    assert.equal(await inputValue(), '');
    await s.key('Escape');
    await closed();
    await selectInEditor(s, 'milk');
    await openPicker('cmdPaletteTagRemove');
    assert.equal(await inputValue(), '', 'Remove does not take the word');
    await s.key('Escape');
    await closed();
    await selectInEditor(s, 'milk');
    await openPicker('cmdPaletteTagNote');
    assert.equal(await inputValue(), 'milk', 'the whole-note command takes it too');
    assert.deepEqual(await inputSelection(), [0, 4]);
    assert.equal(await whereShown(), false, 'and has no "where" row: the whole note is the place');
    assert.equal(await chip(), await phrase(s, 'tagEditCtxNote'));
    await s.key('Enter');
    await closed();
    assert.equal(await noteText(s), TAG('milk') + '\n' + original);
    await waitStatus(`${await phrase(s, 'tagEditAddedNote', { tags: 'milk' })} ${await phrase(s, 'tagEditPlaceAbove', { n: 12 })}`); // (the line is at the top, the caret is on line 13)
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('an older backend that sends no outline: no "where" row, the plain hint, the entry\'s own chip');
    await s.ev(`(function () {
      window.__savedTagEditOld = window.backend.tagEdit;
      window.backend.tagEdit = function (req) {
        return window.__savedTagEditOld.call(this, req).then(function (a) {
          var b = Object.assign({}, a);
          delete b.path; delete b.descendants; delete b.inherited_tags; delete b.parent_heading; delete b.parent_line;
          return b;
        });
      };
      return 1;
    })()`);
    await caretAt('Split it');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await waitChip(await ctx('Processing', 7, 9)); // the older answer: the entry's own range, as the backend says it
    assert.equal(await whereShown(), false);
    assert.equal(await hint(), await phrase(s, 'tagEditHintAdd'));
    await s.key('Escape');
    await closed();
    await s.ev('window.backend.tagEdit = window.__savedTagEditOld; 1');
    assert.equal(await noteText(s), original);
  },
};
