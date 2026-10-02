// Keyboard: leaving a popup with Tab (accessibility session C13-10). The All tabs list and the Help menu hang at the end of the page,
// so a Tab pressed in them used to jump to the top of the page (Shift+Tab to the bottom) instead of going to the control next to
// the button that opened them. Now Tab closes them, hands the focus back to the button, and moves on from there: it ends up
// exactly where Tab from the button itself goes.
import { assert, click, waitFocus, waitHidden, waitShown } from './lib.mjs';

const COUNT = 14; // enough tabs for the All tabs button to show
const notes = [];
for (let i = 1; i <= COUNT; i++) notes.push({ title: `long-named-project-note-number-${i}.md`, content: `# note ${i}\n` });

const where = (s) => s.ev("(function () { var a = document.activeElement; return a ? (a.id || a.tagName + '.' + a.className) : null; })()");
const focusIt = (s, id) => s.ev(`document.getElementById(${JSON.stringify(id)}).focus()`);

export default {
  title: 'keyboard: Tab / Shift+Tab out of the All tabs list and the Help menu go to the neighbour of their button',
  session: { notes },

  async run(s, t) {
    await s.waitFor("document.querySelectorAll('#tabs-list .tab-item').length === " + COUNT);
    await waitShown(s, 'btn-all-tabs');

    t.step('where Tab and Shift+Tab go from the All tabs button itself');
    await focusIt(s, 'btn-all-tabs');
    await s.key('Tab');
    const next = await where(s);
    await focusIt(s, 'btn-all-tabs');
    await s.key('Tab', { shift: true });
    const prev = await where(s);
    assert.notEqual(next, 'btn-all-tabs');
    assert.notEqual(prev, 'btn-all-tabs');

    t.step('Tab from inside the open list ends at the same place, and the list is closed');
    await click(s, 'btn-all-tabs');
    await waitShown(s, 'tab-list-panel');
    await waitFocus(s, 'tab-list-rows');
    await s.key('Tab');
    await waitHidden(s, 'tab-list-panel');
    await s.waitFor(`(function () { var a = document.activeElement; return !!a && (a.id || a.tagName + '.' + a.className) === ${JSON.stringify(next)}; })()`);

    t.step('Shift+Tab from inside the list goes the other way, not to the bottom of the page');
    await click(s, 'btn-all-tabs');
    await waitShown(s, 'tab-list-panel');
    await waitFocus(s, 'tab-list-rows');
    await s.key('Tab', { shift: true });
    await waitHidden(s, 'tab-list-panel');
    await s.waitFor(`(function () { var a = document.activeElement; return !!a && (a.id || a.tagName + '.' + a.className) === ${JSON.stringify(prev)}; })()`);
    assert.notEqual(await where(s), 'stat-encoding', 'not the last control of the page');

    t.step('the Help menu: Tab closes it and moves on from the Help button');
    await focusIt(s, 'btn-help');
    await s.key('Tab');
    const afterHelp = await where(s);
    assert.notEqual(afterHelp, 'btn-help');
    await click(s, 'btn-help');
    await waitShown(s, 'help-menu');
    await s.key('Tab');
    await waitHidden(s, 'help-menu');
    await s.waitFor(`(function () { var a = document.activeElement; return !!a && (a.id || a.tagName + '.' + a.className) === ${JSON.stringify(afterHelp)}; })()`);
    assert.notEqual(await where(s), 'btn-new-tab', 'not the top of the page');
  },
};
