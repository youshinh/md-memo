// A palette command acts on the pane the person was working in (UX review B14). Closing the palette used to focus #editor, the
// LEFT pane, before the command ran, so in a split view "Toggle comment" (and the result-block commands, and Ask) went to the
// left note. Ctrl+/ on the same selection has always gone to the right one.
import { assert, openPalette, waitFocus, waitHidden, waitShown } from './lib.mjs';

const LEFT = 'alpha line one\nalpha line two\n';
const RIGHT = 'beta line one\nbeta line two\n';
const text = (s, id) => s.ev(`document.getElementById(${JSON.stringify(id)}).value`);

// The right pane has the focus and its first line selected.
async function workInRightPane(s) {
  await s.ev('(function () { var b = document.getElementById("editor-secondary"); b.focus(); b.setSelectionRange(0, 9); })()');
  await waitFocus(s, 'editor-secondary');
}

export default {
  title: 'palette: the command runs on the focused (right) pane, not on the left one',
  session: { notes: [{ title: 'a.md', content: LEFT }, { title: 'b.md', content: RIGHT }] },

  async run(s, t) {
    const COMMENT = t.pick('Toggle comment', 'コメントの切り替え');

    t.step('split the view: a.md on the left, b.md on the right');
    await s.key(String.fromCharCode(92), { ctrl: true });
    await waitShown(s, 'secondary-pane');
    assert.equal(await text(s, 'editor'), LEFT);
    assert.equal(await text(s, 'editor-secondary'), RIGHT, 'the right pane shows b.md');

    t.step('work in the right pane, run "Toggle comment" from the palette');
    await workInRightPane(s);
    await openPalette(s);
    await s.type(COMMENT);
    await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
    await s.key('Enter');
    await waitHidden(s, 'quick-pick-modal');
    await s.waitFor("document.getElementById('editor-secondary').value.indexOf('<!--') !== -1");
    assert.equal(await text(s, 'editor'), LEFT, 'the left note is untouched');
    assert.equal(await text(s, 'editor-secondary'), '<!-- beta line one -->\nbeta line two\n', 'the right note got the comment');
    assert.equal(await s.ev('document.activeElement && document.activeElement.id'), 'editor-secondary', 'and the right pane is still the working pane');

    t.step('the same when the palette is closed with Escape: the right pane stays the working pane');
    await openPalette(s);
    await s.key('Escape');
    await waitHidden(s, 'quick-pick-modal');
    await waitFocus(s, 'editor-secondary');

    t.step('control: with the left pane focused the command goes to the left note');
    await s.ev('(function () { var a = document.getElementById("editor"); a.focus(); a.setSelectionRange(0, 5); })()');
    await waitFocus(s, 'editor');
    await openPalette(s);
    await s.type(COMMENT);
    await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
    await s.key('Enter');
    await waitHidden(s, 'quick-pick-modal');
    await s.waitFor("document.getElementById('editor').value.indexOf('<!--') !== -1");
    assert.equal(await text(s, 'editor'), '<!-- alpha line one -->\nalpha line two\n');
    assert.equal(await text(s, 'editor-secondary'), '<!-- beta line one -->\nbeta line two\n', 'the right note is as it was');
  },
};
