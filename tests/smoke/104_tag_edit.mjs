// Adding and removing tags from the command palette: "Add a tag to this entry", "Add a tag to the whole note", "Remove a tag"
// (frontend/js/tag_edit.js; docs/design/tag-filter-2026-10.md section 10). The backend is the mock: its tagEdit is a port of search.EditTags
// (tools/docshots/mock/tag_edit_mock.js, checked against the Go side's golden cases by tests/tag_edit_mock_test.mjs), and scrapFilterOptions lists
// the folder's tags (work 8, reading 5, urgent 4, idea 1).
//   - the three commands are in the palette for the words "tag" / "タグ", and are not offered when the backend has no tagEdit (an older one)
//   - the picker lists the folder's tags, what is typed is "New tag: x"; Enter writes `<!-- tags: x -->` directly under the entry's heading and
//     NOTHING else changes; the status line says so; one Ctrl+Z gives the text back byte for byte; the caret stays on its words and the scroll stays
//   - the whole note takes the line at the top; a tag that is on already is told and the text is left; several tags can be typed at once
//   - Remove lists the entry's tags and the whole note's, marks them, and a line left with no tag is deleted
//   - a note that starts with a front matter refuses the whole-note command with the sentence
//   - Ctrl+/ leaves a tag line alone; the editor's shortcuts are stopped while the picker is up; Esc closes it and the caret is back in the editor
import { assert, clickSelector, focusEditor, noteText, openPalette, paletteTitles, selectInEditor, settle, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { phrase, visible } from './semantic_lib.mjs';

const NOTE = [
  '# 2026-10-01 09:00', 'Meeting notes.', '', '# 2026-10-01 10:30', 'Shopping list.', 'milk',
  ...Array.from({ length: 60 }, (_, i) => `filler line ${i + 1}`),
  ''
].join('\n');
const FRONT = '---\ntitle: T\n---\n# One\nbody\n';
const TAG_X = '<!-- tags: x -->';

export default {
  title: 'tags from the palette: add to an entry (under its heading, one Ctrl+Z, caret and scroll stay), to the whole note, several at once, already there, remove (the line goes), front matter, Ctrl+/ leaves the line, keys stop, Esc, split view, a failing backend, an old backend',
  session: { notes: [{ title: 'a.md', content: NOTE }, { title: 'fm.md', content: FRONT }] },
  timeoutMs: 90000,

  async run(s, t) {
    const word = t.pick('tag', 'タグ');
    const editor = (expr) => s.ev(`(function () { var e = document.getElementById('editor'); return ${expr}; })()`);
    const waitStatus = (text) => s.waitFor(`window.__explore.state().statusText === ${JSON.stringify(text)}`);
    const rowTitles = () => s.ev("Array.from(document.querySelectorAll('#tag-pick-list .quick-pick-item-title')).map(function (e) { return e.textContent; })");
    const rowDescs = () => s.ev("Array.from(document.querySelectorAll('#tag-pick-list .tag-pick-item')).map(function (e) { var d = e.querySelector('.quick-pick-item-desc'); return d ? d.textContent : ''; })");
    const activeRow = () => s.ev("Array.prototype.indexOf.call(document.querySelectorAll('#tag-pick-list .tag-pick-item'), document.querySelector('#tag-pick-list .tag-pick-item.active'))");
    const waitRows = (n) => s.waitFor(`document.querySelectorAll('#tag-pick-list .tag-pick-item').length === ${n}`);
    const picker = (id) => visible(s, id);

    // Opens the palette, filters by the word, and runs the command with this title (found among the matches, whatever else matches the word)
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

    t.step('the three commands are in the palette for the word "' + word + '", with their titles');
    await focusEditor(s);
    await openPalette(s);
    await s.type(word);
    await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
    const found = await paletteTitles(s);
    for (const key of ['cmdPaletteTagEntry', 'cmdPaletteTagNote', 'cmdPaletteTagRemove']) {
      assert.ok(found.includes(await phrase(s, key)), `${key} is listed: ${JSON.stringify(found)}`);
    }
    await s.key('Escape');
    await waitHidden(s, 'quick-pick-modal');

    t.step('add to the entry: the picker opens with the folder\'s tags, most used first, the first one chosen');
    await caretAt('Shopping');
    const original = await noteText(s);
    const caretWord = original.indexOf('Shopping');
    await editor('e.scrollTop = 40; 1');
    const scrollBefore = await editor('e.scrollTop');
    assert.equal(scrollBefore, 40, 'the note scrolls (so that the scroll position is something to keep)');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    assert.deepEqual(await rowTitles(), ['work', 'reading', 'urgent', 'idea']);
    assert.equal(await activeRow(), 0);
    assert.deepEqual((await rowDescs()).slice(0, 2), [await phrase(s, 'tagEditFiles', { n: 8 }), await phrase(s, 'tagEditFiles', { n: 5 })], 'the number of notes at the right');
    assert.equal(await s.ev("document.getElementById('tag-pick-context').textContent"), await phrase(s, 'tagEditCtxEntry', { line: 5 }), 'the line of the caret');
    assert.equal(await s.ev("document.getElementById('tag-pick-input').getAttribute('placeholder')"), await phrase(s, 'tagEditPlaceholderAdd'));
    assert.equal(await s.ev("document.getElementById('tag-pick-hint').textContent"), await phrase(s, 'tagEditHintAdd'));
    assert.equal(await noteText(s), original, 'opening the picker changes nothing');

    t.step('the editor\'s shortcuts stand back while the picker is up: Ctrl+L, Ctrl+K and Ctrl+E open nothing behind it');
    for (const k of ['l', 'k', 'e']) await s.key(k, { ctrl: true });
    await settle(400);
    assert.equal(await s.ev("['inline-prompt-bar', 'cli-filter-bar'].some(function (id) { var e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); })"), false, 'no bar opened');
    assert.equal(await picker('tag-pick-modal'), true, 'and the picker is still there');
    assert.equal(await s.ev("document.activeElement && document.activeElement.id"), 'tag-pick-input');

    t.step('typing a tag: what is typed is the first row ("New tag: x"); the arrow keys move the choice');
    await s.type('x');
    await s.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && document.querySelector('#tag-pick-list .quick-pick-item-title').textContent !== 'work'");
    assert.deepEqual(await rowTitles(), [await phrase(s, 'tagEditNew', { tags: 'x' })]);
    await s.key('Backspace');
    await waitRows(4);
    await s.key('ArrowDown');
    await s.waitFor('Array.prototype.indexOf.call(document.querySelectorAll("#tag-pick-list .tag-pick-item"), document.querySelector("#tag-pick-list .tag-pick-item.active")) === 1');
    await s.key('ArrowUp');
    await s.key('ArrowUp');
    await s.waitFor('Array.prototype.indexOf.call(document.querySelectorAll("#tag-pick-list .tag-pick-item"), document.querySelector("#tag-pick-list .tag-pick-item.active")) === 3');
    await s.type('wo');
    await s.waitFor("document.querySelectorAll('#tag-pick-list .tag-pick-item').length === 2");
    assert.deepEqual(await rowTitles(), [await phrase(s, 'tagEditNew', { tags: 'wo' }), 'work'], 'a prefix finds the tag (case and width do not matter)');
    await s.key('a', { ctrl: true });
    await s.type('x');

    t.step('Enter: the line is written directly under the heading and nothing else changes; the status line says so; the caret and the scroll stay');
    await s.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && document.querySelector('#tag-pick-list .quick-pick-item-title').textContent.indexOf('x') !== -1");
    await s.key('Enter');
    await closed();
    const lines = original.split('\n');
    const expected = [...lines.slice(0, 4), TAG_X, ...lines.slice(4)].join('\n');
    assert.equal(await noteText(s), expected, 'only the one line is new');
    await waitStatus(await phrase(s, 'tagEditAddedEntry', { tags: 'x' }));
    assert.equal(await editor('e.selectionStart'), caretWord + TAG_X.length + 1, 'the caret is on the same words (the line went in before them)');
    assert.equal(await editor('e.selectionEnd'), caretWord + TAG_X.length + 1);
    assert.equal(await editor('e.scrollTop'), scrollBefore, 'the scroll did not move');
    assert.equal(await s.ev("(function () { var tab = window.__explore.state().tabs[0]; return tab.dirty; })()"), true, 'the note is marked as changed');

    t.step('one Ctrl+Z gives the text back, byte for byte');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original, 'one undo step');
    await s.key('y', { ctrl: true });
    assert.equal(await noteText(s), expected, 'and Redo brings the line back');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('the whole note: the line goes to the top; Ctrl+Z; then again, and a tag that is on already is told and the text is left');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagNote');
    assert.equal(await s.ev("document.getElementById('tag-pick-context').textContent"), await phrase(s, 'tagEditCtxNote'));
    await s.type('y');
    await s.key('Enter');
    await closed();
    const withNote = '<!-- tags: y -->\n' + original;
    assert.equal(await noteText(s), withNote);
    await waitStatus(await phrase(s, 'tagEditAddedNote', { tags: 'y' }));
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original, 'one Ctrl+Z');
    await s.key('y', { ctrl: true });
    assert.equal(await noteText(s), withNote);
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagNote');
    await s.type('y');
    await s.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && document.querySelector('#tag-pick-list .quick-pick-item-title').textContent === " + JSON.stringify(await phrase(s, 'tagEditOnAlready', { tags: 'y' })));
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditAlready', { tags: 'y' }));
    assert.equal(await noteText(s), withNote, 'the text is not touched');
    assert.equal(await s.ev('window.__docshot.calls.filter(function (c) { return c.fn === "tagEdit"; }).length > 0'), true);

    t.step('an entry takes a tag the whole note has as already there; several tags typed at once go in one comment; the folder\'s tag is taken with the mouse');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagEntry');
    await s.type('y');
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditAlready', { tags: 'y' }));
    assert.equal(await noteText(s), withNote);
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    assert.deepEqual((await rowTitles()).includes('y'), false, 'y is on the whole note, so on every entry: it is not offered (and it is not one of the folder tags either)');
    await s.type('x, Work idea');
    await s.waitFor("document.querySelectorAll('#tag-pick-list .tag-pick-item').length >= 1");
    await s.key('Enter');
    await closed();
    const withEntry = withNote.split('\n');
    withEntry.splice(5, 0, '<!-- tags: x, work, idea -->');
    assert.equal(await noteText(s), withEntry.join('\n'), 'one comment with the three tags, lower case, in the order written');
    await waitStatus(await phrase(s, 'tagEditAddedEntry', { tags: 'x, work, idea' }));
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), withNote);
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await clickSelector(s, '#tag-pick-list [data-row="1"]'); // reading: a real mouse press on the row
    await closed();
    const mouse = withNote.split('\n');
    mouse.splice(5, 0, '<!-- tags: reading -->');
    assert.equal(await noteText(s), mouse.join('\n'));

    t.step('a second tag goes into the same comment line, not a new one');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagEntry');
    await s.type('x');
    await s.key('Enter');
    await closed();
    const merged = withNote.split('\n');
    merged.splice(5, 0, '<!-- tags: reading, x -->');
    assert.equal(await noteText(s), merged.join('\n'));

    t.step('Ctrl+/ over a tag line does nothing (and says why); the lines around it are commented');
    await caretAt('<!-- tags: reading, x -->');
    const beforeToggle = await noteText(s);
    await s.key('/', { ctrl: true });
    await waitStatus(await phrase(s, 'commentToggleTagsOnly'));
    assert.equal(await noteText(s), beforeToggle, 'a tag line is neither uncommented nor commented again');
    const tagLineAt = beforeToggle.indexOf('<!-- tags: reading, x -->');
    await s.ev(`(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(${tagLineAt}, ${tagLineAt} + '<!-- tags: reading, x -->'.length + 1 + 'Shopping list.'.length); })()`);
    await s.key('/', { ctrl: true });
    await s.waitFor(`document.getElementById('editor').value.indexOf('<!-- Shopping list. -->') !== -1`);
    const toggled = await noteText(s);
    assert.ok(toggled.includes('\n<!-- tags: reading, x -->\n<!-- Shopping list. -->\n'), 'the tag line stayed as it was, the next line became a comment: ' + JSON.stringify(toggled.slice(tagLineAt - 5, tagLineAt + 80)));
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), beforeToggle);

    t.step('Remove: the entry\'s tags and the whole note\'s, marked; taking the last tag of a line away deletes the line');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagRemove');
    await waitRows(3);
    assert.deepEqual(await rowTitles(), ['reading', 'x', 'y']);
    assert.deepEqual(await rowDescs(), [await phrase(s, 'tagEditWhereEntry'), await phrase(s, 'tagEditWhereEntry'), await phrase(s, 'tagEditWhereNote')], 'the entry\'s tags, then the whole note\'s');
    assert.equal(await s.ev("document.getElementById('tag-pick-hint').textContent"), await phrase(s, 'tagEditHintRemove'));
    await s.type('rea');
    await waitRows(1);
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditRemovedEntry', { tags: 'reading' }));
    const afterOne = withNote.split('\n');
    afterOne.splice(5, 0, '<!-- tags: x -->');
    assert.equal(await noteText(s), afterOne.join('\n'), 'one tag of the comment is gone');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagRemove');
    await waitRows(2);
    await s.key('Enter'); // x: the last of the comment
    await closed();
    await waitStatus(await phrase(s, 'tagEditRemovedEntry', { tags: 'x' }));
    assert.equal(await noteText(s), withNote, 'the line with no tag left is deleted, not left empty');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), afterOne.join('\n'), 'and one Ctrl+Z brings it back');
    await s.key('y', { ctrl: true });
    assert.equal(await noteText(s), withNote, 'Redo takes the line away again');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagRemove');
    await waitRows(1);
    assert.deepEqual(await rowTitles(), ['y']);
    assert.deepEqual(await rowDescs(), [await phrase(s, 'tagEditWhereNote')]);
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditRemovedNote', { tags: 'y' }));
    assert.equal(await noteText(s), original, 'the whole note\'s tag is gone: the text is the first one, byte for byte');

    t.step('Remove with no tag at all says so in the list and does nothing on Enter');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagRemove');
    await s.waitFor("document.querySelector('#tag-pick-list .tag-pick-note') !== null");
    assert.equal(await s.ev("document.querySelector('#tag-pick-list .tag-pick-note').textContent"), await phrase(s, 'tagEditNoRemovable'));
    await s.key('Enter');
    await settle(200);
    assert.equal(await picker('tag-pick-modal'), true, 'Enter on an empty list keeps the picker');
    await s.key('Escape');
    await closed();
    assert.equal(await noteText(s), original);

    t.step('Esc closes the picker, the caret is back in the editor where it was, and nothing changed');
    await caretAt('milk');
    const caretBefore = await editor('e.selectionStart');
    await openPicker('cmdPaletteTagEntry');
    await s.type('half typed');
    await s.key('Escape');
    await closed();
    assert.equal(await editor('e.selectionStart'), caretBefore, 'the caret is where it was');
    assert.equal(await noteText(s), original);
    assert.equal(await picker('quick-pick-modal'), false, 'one Esc closes one panel');
    assert.equal(await picker('tag-pick-modal'), false);

    t.step('the typed text that cannot be a tag is told in the list and on Enter (nine tags)');
    await openPicker('cmdPaletteTagEntry');
    await s.type('a b c d e f g h i');
    await s.waitFor("document.querySelector('#tag-pick-list .tag-pick-note') !== null");
    assert.equal(await s.ev("document.querySelector('#tag-pick-list .tag-pick-note').textContent"), await phrase(s, 'tagEditTooMany', { n: 8 }));
    await s.key('Enter');
    await waitStatus(await phrase(s, 'tagEditTooMany', { n: 8 }));
    assert.equal(await picker('tag-pick-modal'), true, 'the picker stays so that the text can be fixed');
    await s.key('Escape');
    await closed();
    assert.equal(await noteText(s), original);

    t.step('Tab does not leave the panel: Shift+Tab stays in it, Tab takes the chosen row as Enter does (as in the snippet list)');
    await caretAt('Shopping');
    await openPicker('cmdPaletteTagEntry');
    await waitRows(4);
    await s.key('Tab', { shift: true });
    await settle(150);
    assert.equal(await s.ev('document.activeElement && document.activeElement.id'), 'tag-pick-input', 'the focus is where it was');
    assert.equal(await picker('tag-pick-modal'), true);
    await s.key('ArrowDown');
    await s.key('Tab');
    await closed();
    const tabbed = original.split('\n');
    tabbed.splice(4, 0, '<!-- tags: reading -->');
    assert.equal(await noteText(s), tabbed.join('\n'), 'the second row, reading, was taken');
    await s.key('z', { ctrl: true });
    assert.equal(await noteText(s), original);

    t.step('a note that starts with a front matter refuses the whole-note command, in words, and is not changed');
    const fmId = (await s.state()).tabs.find((x) => x.title === 'fm.md').id;
    await clickSelector(s, `.tab-item[data-tab-id="${fmId}"]`);
    await s.waitFor(`document.getElementById('editor').value === ${JSON.stringify(FRONT)}`);
    await focusEditor(s);
    await caretAt('body');
    await openPicker('cmdPaletteTagNote');
    await s.type('z');
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditFrontMatter'));
    assert.equal(await editor('e.value'), FRONT, 'the front matter is not written');
    await caretAt('body');
    await openPicker('cmdPaletteTagEntry');
    await s.type('z');
    await s.key('Enter');
    await closed();
    assert.equal(await editor('e.value'), '---\ntitle: T\n---\n# One\n<!-- tags: z -->\nbody\n', 'an entry of it takes the tag');

    t.step('in a split view the command goes to the pane that has the focus (the right one), and Ctrl+Z there takes it back');
    const leftNow = await editor('e.value');
    await s.key(String.fromCharCode(92), { ctrl: true });
    await waitShown(s, 'secondary-pane');
    const rightText = () => s.ev("document.getElementById('editor-secondary').value");
    assert.equal(await rightText(), original, 'the right pane shows a.md');
    await s.ev(`(function () { var b = document.getElementById('editor-secondary'); b.focus(); var i = b.value.indexOf('Shopping'); b.setSelectionRange(i, i); })()`);
    await waitFocus(s, 'editor-secondary');
    await runCommand('cmdPaletteTagEntry');
    await waitShown(s, 'tag-pick-modal');
    await waitFocus(s, 'tag-pick-input');
    assert.equal(await s.ev("document.getElementById('tag-pick-context').textContent"), await phrase(s, 'tagEditCtxEntry', { line: 5 }), 'the line is the right pane\'s caret line');
    await s.type('q');
    await s.key('Enter');
    await waitHidden(s, 'tag-pick-modal');
    await waitFocus(s, 'editor-secondary');
    const rightLines = original.split('\n');
    rightLines.splice(4, 0, '<!-- tags: q -->');
    assert.equal(await rightText(), rightLines.join('\n'), 'the right note got the line, under the second heading');
    assert.equal(await editor('e.value'), leftNow, 'the left note is as it was');
    await s.key('z', { ctrl: true });
    assert.equal(await rightText(), original, 'one Ctrl+Z in the right pane');
    await s.key(String.fromCharCode(92), { ctrl: true });
    await waitHidden(s, 'secondary-pane');

    t.step('a backend that fails: the list says so in one line, and Enter says it too and changes nothing');
    const beforeFail = await editor('e.value');
    await s.ev("window.__docshot.tagEdit.reject = 'the text is over 16 MB'; 1");
    await caretAt('body');
    await openPicker('cmdPaletteTagEntry');
    await s.waitFor("document.querySelector('#tag-pick-list .tag-pick-note-warn') !== null");
    assert.equal(await s.ev("document.querySelector('#tag-pick-list .tag-pick-note-warn').textContent"), await phrase(s, 'tagEditShowFailed', { message: 'the text is over 16 MB' }));
    await s.type('w');
    await s.key('Enter');
    await closed();
    await waitStatus(await phrase(s, 'tagEditFailed', { message: 'the text is over 16 MB' }));
    assert.equal(await editor('e.value'), beforeFail, 'nothing was written');
    await s.ev("window.__docshot.tagEdit.reject = ''; 1");

    t.step('an older backend (no tagEdit): none of the three commands is offered');
    await s.ev('window.__savedTagEdit = window.backend.tagEdit; delete window.backend.tagEdit; 1');
    await openPalette(s);
    await s.type(word);
    await settle(300);
    const without = await paletteTitles(s);
    for (const key of ['cmdPaletteTagEntry', 'cmdPaletteTagNote', 'cmdPaletteTagRemove']) {
      assert.ok(!without.includes(await phrase(s, key)), `${key} is not offered: ${JSON.stringify(without)}`);
    }
    await s.key('Escape');
    await waitHidden(s, 'quick-pick-modal');
    await s.ev('window.backend.tagEdit = window.__savedTagEdit; 1');
  },
};
