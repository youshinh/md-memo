// The right-click menu of the editor has the three tag commands: "Add a Tag to This Entry...", "Add a Tag to the Whole Note...", "Remove a Tag..."
// (frontend/index.html #ctx-tag-entry / #ctx-tag-note / #ctx-tag-remove, wired in app.js to the same openTagPicker as the palette's commands).
//   - a real right click on the editor shows the menu with the three items, labelled in the UI language
//   - a real click on each opens the tag picker (the entry's one says which entry), and Esc closes it with the focus back in the editor
//   - under a heading with a smaller heading below it, the entry item's picker has the "where" row (section 11.4)
//   - with a backend that has no tagEdit (an older one) the three items are not shown
import { assert, clickSelector, selectInEditor, settle, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { phrase } from './semantic_lib.mjs';

// (a right click lands on line 4 of the editor, so line 4 is where the entries are told apart: a sub-heading of the first one)
const NOTE = '# 2026-10-01 09:00\nMeeting notes.\n\n## Shopping\nShopping list.\nmilk\n';
const ITEMS = [
  ['ctx-tag-entry', 'ctxTagEntry'],
  ['ctx-tag-note', 'ctxTagNote'],
  ['ctx-tag-remove', 'ctxTagRemove']
];

export default {
  title: 'right-click menu: the three tag commands open the tag picker, and are not shown when the backend has no tagEdit',
  session: { notes: [{ title: 'a.md', content: NOTE }] },
  timeoutMs: 60000,

  async run(s, t) {
    const itemShown = (id) => s.ev(`(function () { var e = document.getElementById(${JSON.stringify(id)}); if (!e || e.classList.contains('hidden')) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
    const menuShown = () => s.ev("(function () { var m = document.getElementById('context-menu'); return !!m && !m.classList.contains('hidden'); })()");
    // A real right click (the mouse down and up of the right button), inside the editor
    const rightClickEditor = async () => {
      const pt = await s.ev("(function () { var r = document.getElementById('editor').getBoundingClientRect(); return { x: Math.round(r.left + 180), y: Math.round(r.top + 90) }; })()");
      const cdp = s.page.cdp;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', clickCount: 1 });
      await s.waitFor("(function () { var m = document.getElementById('context-menu'); return !!m && !m.classList.contains('hidden'); })()");
    };
    const labelOf = (id) => s.ev(`(function () { var e = document.querySelector('#${id} .menu-label'); return e ? e.textContent : null; })()`);

    t.step('a right click shows the menu with the three tag items, labelled in the UI language');
    await selectInEditor(s, 'Shopping list', { caretOnly: true });
    await rightClickEditor();
    assert.equal(await menuShown(), true, 'the context menu is up');
    for (const [id, key] of ITEMS) {
      assert.equal(await itemShown(id), true, `#${id} is in the menu`);
      assert.equal(await labelOf(id), await phrase(s, key), `#${id} says what it does`);
    }

    t.step('each item opens the tag picker; Esc closes it and the focus is back in the editor');
    for (const [id] of ITEMS) {
      if (!(await menuShown())) await rightClickEditor();
      await clickSelector(s, `#${id}`);
      await waitShown(s, 'tag-pick-modal');
      assert.equal(await menuShown(), false, `the menu is closed after #${id}`);
      await waitFocus(s, 'tag-pick-input');
      await s.key('Escape');
      await waitHidden(s, 'tag-pick-modal');
      await waitFocus(s, 'editor');
    }

    t.step('the entry item names the entry the caret was in');
    await selectInEditor(s, 'milk', { caretOnly: true });
    await rightClickEditor();
    await clickSelector(s, '#ctx-tag-entry');
    await waitShown(s, 'tag-pick-modal');
    const chip = await s.ev("document.getElementById('tag-pick-context').textContent");
    assert.ok(/\d/.test(String(chip)), `the picker says which entry it is for: ${JSON.stringify(chip)}`);
    await waitFocus(s, 'tag-pick-input');
    await s.key('Escape');
    await waitHidden(s, 'tag-pick-modal');

    t.step('under a heading with a sub-heading: the entry item opens the picker with the "where" row, the sub-section chosen first');
    await rightClickEditor();
    await clickSelector(s, '#ctx-tag-entry');
    await waitShown(s, 'tag-pick-modal');
    await waitShown(s, 'tag-pick-where');
    const places = await s.ev("Array.from(document.querySelectorAll('#tag-pick-where [data-place]')).map(function (e) { return e.textContent; })");
    assert.deepEqual(places, [await phrase(s, 'tagEditPlaceChoice', { heading: 'Shopping', start: 4, end: 6 }), await phrase(s, 'tagEditPlaceChoice', { heading: '2026-10-01 09:00', start: 1, end: 6 })]);
    assert.equal(await s.ev("document.querySelector('#tag-pick-where [data-place][aria-checked=\"true\"]').getAttribute('data-place')"), '0');
    await waitFocus(s, 'tag-pick-input');
    await s.key('Escape');
    await waitHidden(s, 'tag-pick-modal');

    t.step('an older backend (no tagEdit): the three items are not shown');
    await s.ev('window.__savedTagEdit = window.backend.tagEdit; delete window.backend.tagEdit; 1');
    await rightClickEditor();
    for (const [id] of ITEMS) assert.equal(await itemShown(id), false, `#${id} is not shown`);
    await s.ev('window.backend.tagEdit = window.__savedTagEdit; 1');
    await settle(200);
  }
};
