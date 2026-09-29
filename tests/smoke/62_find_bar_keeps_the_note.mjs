// The find bar must never change the note by itself (UX review B12, B13).
//   - Enter / Shift+Enter in the Find box go to the next / previous match and the focus STAYS in the box. The focus used to move
//     into the note, so the second Enter replaced the selected match with a line break and Shift+Enter added a blank line.
//     (A textarea paints its selection only while it is focused, so the current match is drawn behind the text: .find-match-rect.)
//   - Replace works on the text as it is now, not on the offsets of the last search: typing in the note between the search and
//     the Replace used to overwrite unrelated characters.
import { assert, focusEditor, settle, waitFocus, waitHidden, waitShown } from './lib.mjs';

const NOTE = 'fox one\nfox two\nfox three';
const noteText = async (s) => (await s.state()).tabs[0].content;
const selection = (s) => s.ev('[document.getElementById("editor").selectionStart, document.getElementById("editor").selectionEnd]');
const activeId = (s) => s.ev('document.activeElement && document.activeElement.id');
const marks = (s) => s.ev('document.querySelectorAll(".find-match-rect").length');

export default {
  title: 'find bar: Enter keeps the focus in the box and the note untouched; Replace uses the current text',
  session: { notes: [{ title: 'fox.md', content: NOTE, cursor: 0 }] },

  async run(s, t) {
    t.step('search for a word that occurs three times');
    await focusEditor(s);
    await s.ev('document.getElementById("editor").setSelectionRange(0, 0)');
    await s.key('f', { ctrl: true });
    await waitShown(s, 'find-replace-bar');
    await waitFocus(s, 'find-input');
    await s.type('fox');
    await s.waitFor("/\\/3$/.test(document.getElementById('find-count').textContent.trim())");

    t.step('Enter goes to the first match, and the focus stays in the box');
    await s.key('Enter');
    assert.deepEqual(await selection(s), [0, 3], 'the first match is selected');
    assert.equal(await activeId(s), 'find-input', 'the focus is still in the Find box');
    assert.ok((await marks(s)) >= 1, 'the match is drawn, since the note does not paint its selection while it is not focused');

    t.step('a second Enter goes to the next match; it must not touch the note');
    await s.key('Enter');
    assert.deepEqual(await selection(s), [8, 11], 'the second match is selected');
    assert.equal(await noteText(s), NOTE, 'the note is unchanged');
    assert.equal(await activeId(s), 'find-input');

    t.step('Shift+Enter goes back, and adds no blank line');
    await s.key('Enter', { shift: true });
    assert.deepEqual(await selection(s), [0, 3], 'back on the first match');
    assert.equal(await noteText(s), NOTE, 'no blank line was inserted');
    assert.equal(await activeId(s), 'find-input');

    t.step('the arrow buttons move on as well and keep the focus where it is');
    await s.ev('document.getElementById("btn-find-next").click()');
    assert.deepEqual(await selection(s), [8, 11]);
    assert.equal(await noteText(s), NOTE);

    t.step('changing the note takes the drawn match away (it would point at other text)');
    await focusEditor(s);
    await s.type('!');
    await settle(100);
    assert.equal(await marks(s), 0, 'no match box is left over after typing in the note');

    t.step('Escape closes the bar, removes the box and gives the note the focus');
    await s.ev('document.getElementById("find-input").focus()');
    await s.key('Enter');
    assert.ok((await marks(s)) >= 1);
    await s.key('Escape');
    await waitHidden(s, 'find-replace-bar');
    await waitFocus(s, 'editor');
    assert.equal(await marks(s), 0, 'the box is gone with the bar');

    t.step('Replace after the note was edited: the replacement lands on the match, not on the old offsets');
    await s.ev('document.getElementById("editor").focus(); document.getElementById("editor").value = ""; document.getElementById("editor").dispatchEvent(new Event("input", { bubbles: true }))');
    await s.type('foo bar foo');
    await s.ev('document.getElementById("editor").setSelectionRange(0, 3)');
    await s.key('h', { ctrl: true });
    await waitShown(s, 'replace-row');
    await waitFocus(s, 'replace-input');
    assert.equal(await s.ev('document.getElementById("find-input").value'), 'foo', 'the selected word seeded the Find box');
    await s.type('Z');
    // Type at the start of the note while the bar stays open: the earlier search is now out of date.
    await s.ev('(function () { var e = document.getElementById("editor"); e.focus(); e.setSelectionRange(0, 0); })()');
    await s.type('XXXX');
    await s.ev('document.getElementById("replace-input").focus()');
    await s.key('Enter');
    assert.equal(await noteText(s), 'XXXXZ bar foo', 'the first foo became Z and the typed XXXX is intact');
    assert.equal(await activeId(s), 'replace-input', 'the focus stays in the Replace box, so Enter goes on to the next match');
    await s.key('Enter');
    assert.equal(await noteText(s), 'XXXXZ bar Z', 'the second Enter replaced the next foo (and did not put a line break over it)');
  },
};
