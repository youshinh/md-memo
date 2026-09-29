// Ctrl+Z after Tab / Shift+Tab on several lines, Replace and Replace all (UX review B15). Those edits assigned `editor.value`, and
// in Chromium that throws away the textarea's undo history: Ctrl+Z then did nothing, not even for what had been typed before.
// Now each is ONE undo step and the earlier typing stays undoable.
import { assert, focusEditor, waitFocus, waitShown } from './lib.mjs';

const noteText = async (s) => (await s.state()).tabs[0].content;
const undo = (s) => s.key('z', { ctrl: true });

export default {
  title: 'indent, unindent, Replace and Replace all are one Ctrl+Z each, and typing before them stays undoable',
  session: { notes: [{ title: 'a.md', content: '' }] },

  async run(s, t) {
    t.step('type three lines and indent them all with Tab');
    await focusEditor(s);
    await s.type('alpha\nbeta\ngamma');
    await s.key('a', { ctrl: true });
    await s.key('Tab');
    assert.equal(await noteText(s), '    alpha\n    beta\n    gamma', 'indented');

    t.step('one Ctrl+Z takes the indent back');
    await undo(s);
    assert.equal(await noteText(s), 'alpha\nbeta\ngamma', 'one undo step');

    t.step('indent again, then Shift+Tab: unindented, and one Ctrl+Z brings the indent back');
    await s.key('a', { ctrl: true });
    await s.key('Tab');
    await s.key('Tab', { shift: true });
    assert.equal(await noteText(s), 'alpha\nbeta\ngamma', 'unindented');
    await undo(s);
    assert.equal(await noteText(s), '    alpha\n    beta\n    gamma', 'the unindent was one undo step');

    t.step('the typing before all this is still in the undo history');
    await undo(s);
    await undo(s);
    const after = await noteText(s);
    assert.ok(after.length < 16 && after !== 'alpha\nbeta\ngamma', `Ctrl+Z went on into the typing: ${JSON.stringify(after)}`);

    t.step('Shift+Tab with just a caret takes four spaces off the line, in one undo step');
    await s.ev('document.getElementById("editor").focus(); document.getElementById("editor").value = ""; document.getElementById("editor").dispatchEvent(new Event("input", { bubbles: true }))');
    await s.type('x\n');
    await s.key('Tab');
    await s.type('y');
    await s.key('Tab', { shift: true });
    assert.equal(await noteText(s), 'x\ny');
    assert.equal(await s.ev('document.getElementById("editor").selectionStart'), 3, 'the caret is where it was, after the y');
    await undo(s);
    assert.equal(await noteText(s), 'x\n    y');

    t.step('Replace all: one Ctrl+Z, and the typing before it is still undoable');
    await s.ev('document.getElementById("editor").focus(); document.getElementById("editor").value = ""; document.getElementById("editor").dispatchEvent(new Event("input", { bubbles: true }))');
    await s.type('foo one\nfoo two');
    await s.key('h', { ctrl: true });
    await waitShown(s, 'replace-row');
    // (set the two boxes without typing into them: typing there would be undo steps of its own)
    await s.ev('document.getElementById("find-input").value = "foo"; document.getElementById("replace-input").value = "Q"');
    await s.ev('document.getElementById("btn-replace-all").click()');
    assert.equal(await noteText(s), 'Q one\nQ two');
    await focusEditor(s);
    await undo(s);
    assert.equal(await noteText(s), 'foo one\nfoo two', 'one undo step for all the replacements');
    await undo(s);
    assert.notEqual(await noteText(s), 'foo one\nfoo two', 'and the typing before it is still there to undo');

    t.step('Replace (one match): one Ctrl+Z');
    await s.ev('document.getElementById("editor").focus(); document.getElementById("editor").value = ""; document.getElementById("editor").dispatchEvent(new Event("input", { bubbles: true }))');
    await s.type('foo one\nfoo two');
    await s.ev('document.getElementById("editor").setSelectionRange(0, 0)');
    await s.ev('document.getElementById("find-input").value = "foo"; document.getElementById("replace-input").value = "Q"');
    await s.ev('document.getElementById("btn-replace-one").click()');
    assert.equal(await noteText(s), 'Q one\nfoo two', 'only the first match');
    await focusEditor(s);
    await undo(s);
    assert.equal(await noteText(s), 'foo one\nfoo two');
    await undo(s);
    assert.notEqual(await noteText(s), 'foo one\nfoo two', 'the typing before it is still there to undo');
    await s.key('Escape');
    await waitFocus(s, 'editor');
  },
};
