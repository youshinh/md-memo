// A save that fails (exploratory finding C2-09): the toast is gone in four seconds and the autosave item went on saying "ON", so the
// only thing left was the small dot on the tab. Now the tab gets a "!" mark and the item says it failed, for as long as the text is
// not on disk; the next edit tries again, and the save that works clears both.
import { assert, focusEditor, textOf } from './lib.mjs';

const PATH = 'C:\\notes\\a.md';

export default {
  title: 'a failed autosave stays visible (mark on the tab, "failed" on the item) until a save works',
  session: { notes: [{ title: 'a.md', content: 'base\n', path: PATH }] },

  async run(s, t) {
    const word = (key) => s.ev(`I18N[${JSON.stringify(t.lang)}][${JSON.stringify(key)}]`);
    const itemSays = (key) => word(key).then((text) => s.waitFor(`document.getElementById('stat-autosave').textContent === ${JSON.stringify(text)}`, { timeout: 9000 }));
    const mark = "document.querySelector('#tabs-list .tab-item.active .tab-conflict-mark')";

    t.step('typing, with a disk that refuses: the automatic save fails and says so');
    await s.setBackend({ saveFile: { fail: 'disk full' } });
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type('x');
    await s.waitFor("window.__explore.toasts.some(function (m) { return /disk full/.test(m.text); })", { timeout: 9000 });

    t.step('the tab carries the mark and the item says it failed');
    await s.waitFor(`${mark} !== null`);
    await itemSays('statAutosaveFailed');

    t.step('the toast runs out, and the state stays');
    await s.waitFor("document.getElementById('stat-message').textContent === ''", { timeout: 9000 });
    assert.equal(await s.ev(`${mark} !== null`), true, 'the mark is still on the tab');
    assert.equal(await textOf(s, 'stat-autosave'), await word('statAutosaveFailed'), 'and the item still says it failed');

    t.step('the disk is back; the next edit tries again, and a save that works clears both');
    await s.setBackend({ saveFile: null });
    await s.type('y');
    await s.waitFor(`${mark} === null`, { timeout: 9000 });
    await itemSays('statAutosaveOn');
    const tab = (await s.state()).tabs[0];
    assert.equal(tab.dirty, false, 'the note is saved');
  },
};
