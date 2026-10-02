// "Open the preview to the side" has a shortcut of its own (Ctrl+Alt+V, Cmd+Option+V on a Mac), listed in Settings > Shortcuts next to
// the split view's, and the person can change it. It used to be a fixed key that Settings did not show.
import { assert, focusEditor, settle, shown, waitHidden, waitShown } from './lib.mjs';

const secondaryOpen = (s) => shown(s, 'secondary-pane');

export default {
  title: 'preview to the side: Ctrl+Alt+V opens it, it is listed in Settings > Shortcuts, and it can be rebound',
  session: { notes: [{ title: 'a.md', content: '# Title\n\nsome text\n' }] },

  async run(s, t) {
    t.step('the default is Ctrl+Alt+V and Settings > Shortcuts lists it');
    const cfg = await s.ev('JSON.parse(JSON.stringify(MdMemoBridge.getConfig().shortcuts))');
    assert.equal(cfg.previewToSide, 'Ctrl+Alt+V');
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    const row = await s.ev(`Array.from(document.querySelectorAll('#shortcuts-list-body tr')).map(function (tr) { return tr.textContent; }).filter(function (x) { return x.indexOf('Ctrl+Alt+V') !== -1; })`);
    assert.equal(row.length, 1, 'exactly one row shows Ctrl+Alt+V in the shortcut list');
    assert.ok(/プレビュー|Preview/.test(row[0]), `that row is the preview one: ${row[0]}`);
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('Ctrl+Alt+V opens the preview in the right-hand pane');
    await focusEditor(s);
    await s.key('v', { ctrl: true, alt: true });
    await waitShown(s, 'secondary-pane');

    t.step('rebound to Ctrl+Alt+P: the new key opens it and the old one does nothing');
    await s.ev('document.getElementById("btn-toggle-split") && document.getElementById("btn-toggle-split").click()');
    await s.waitFor('!document.getElementById("secondary-pane") || document.getElementById("secondary-pane").classList.contains("hidden")');
    await s.ev('MdMemoBridge.getConfig().shortcuts.previewToSide = "Ctrl+Alt+P"');
    await focusEditor(s);
    await s.key('v', { ctrl: true, alt: true });
    await settle(300); // "nothing happens": give the key time to be handled
    assert.equal(await secondaryOpen(s), false, 'the old combo no longer opens it');
    await s.key('p', { ctrl: true, alt: true });
    await waitShown(s, 'secondary-pane');

    t.step('cleared: no key opens it');
    await s.ev('document.getElementById("btn-toggle-split") && document.getElementById("btn-toggle-split").click()');
    await s.waitFor('!document.getElementById("secondary-pane") || document.getElementById("secondary-pane").classList.contains("hidden")');
    await s.ev('MdMemoBridge.getConfig().shortcuts.previewToSide = ""');
    await focusEditor(s);
    await s.key('v', { ctrl: true, alt: true });
    await s.key('p', { ctrl: true, alt: true });
    await settle(300);
    assert.equal(await secondaryOpen(s), false, 'a cleared shortcut opens nothing');
  }
};
