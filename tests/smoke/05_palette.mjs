// The command palette (Ctrl+Shift+P): it lists the commands, filters as you type, the arrow keys move the choice, Enter runs the
// entry (here: Settings), an unknown word finds nothing, and Escape closes it and gives the editor the focus back.
// (UX review A4: Settings, Keyboard shortcuts, Help, About, Save, Find ... are in it.)
import { assert, openPalette, paletteTitles, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';

const activeIndex = "Array.prototype.indexOf.call(document.querySelectorAll('#quick-pick-list .quick-pick-item'), document.querySelector('#quick-pick-list .quick-pick-item.active'))";

export default {
  title: 'palette: list, filter, arrows, run Settings, no match, Escape',
  session: { notes: [{ title: 'a.md', content: 'first\n' }, { title: 'b.md', content: 'second\n' }] },

  async run(s, t) {
    const SETTINGS = t.pick('Settings', '設定');

    t.step('open the palette');
    await openPalette(s);
    const all = await paletteTitles(s);
    assert.ok(all.length >= 20, `the palette lists the commands (${all.length} entries)`);
    assert.equal(await s.ev("document.querySelectorAll('#quick-pick-list .quick-pick-item.active').length"), 1, 'exactly one entry is the current choice');
    assert.equal(await s.ev(activeIndex), 0, 'the first entry is the current choice');

    t.step('filter by a word');
    await s.type(SETTINGS);
    await s.waitFor(`document.querySelectorAll('#quick-pick-list .quick-pick-item').length < ${all.length}`);
    const filtered = await paletteTitles(s);
    assert.ok(filtered.length < all.length, `the list got shorter (${all.length} -> ${filtered.length})`);
    const at = filtered.indexOf(SETTINGS);
    assert.ok(at >= 0, `Settings is among the matches: ${JSON.stringify(filtered)}`);

    t.step('the arrow keys move the choice');
    for (let i = 0; i < at; i++) await s.key('ArrowDown');
    await s.waitFor(`${activeIndex} === ${at}`);
    if (at > 0) {
      await s.key('ArrowUp');
      await s.waitFor(`${activeIndex} === ${at - 1}`);
      await s.key('ArrowDown');
      await s.waitFor(`${activeIndex} === ${at}`);
    }

    t.step('Enter runs the entry: Settings opens');
    await s.key('Enter');
    await waitShown(s, 'settings-modal');
    assert.equal(await shown(s, 'quick-pick-modal'), false, 'the palette closed');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('a word that matches nothing');
    await openPalette(s);
    await s.type('zzzqqxx');
    await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length === 0");
    assert.ok((await s.ev("document.getElementById('quick-pick-list').textContent")).trim().length > 0, 'an empty result says so');

    t.step('Escape closes the palette and returns the focus to the editor');
    await s.key('Escape');
    await waitHidden(s, 'quick-pick-modal');
    await waitFocus(s, 'editor');
    assert.equal((await s.state()).tabs.length, 2, 'no note was created or closed on the way');
  },
};
