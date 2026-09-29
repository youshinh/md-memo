// About MD-Memo (from the palette): the version and build, the folders, the update check (offline here: it must end with a plain
// "could not reach" line, not hang), Copy details puts the text on the clipboard, a link goes to the outside world through the app
// (never navigates the window), and Escape closes it and empties its body. (UX review I1.)
import { assert, backendCalls, click, clickSelector, runPaletteCommand, shown, textOf, waitFocus, waitHidden, waitShown } from './lib.mjs';

export default {
  title: 'about: opens from the palette, update check offline, copy details, link, Escape',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },

  async run(s, t) {
    t.step('open About from the palette');
    await runPaletteCommand(s, t.pick('about', 'について'));
    await waitShown(s, 'about-modal');
    assert.equal(await shown(s, 'quick-pick-modal'), false, 'the palette closed');
    const body = await textOf(s, 'about-body');
    assert.ok(body.includes('MD-Memo'), 'the dialog names the app');
    assert.ok(/\d+\.\d+\.\d+/.test(body), 'and shows a version number');
    assert.ok(/[A-Za-z]:\\/.test(body), 'and shows the folders that hold settings and notes');
    await waitFocus(s, 'about-done');

    t.step('the update check, offline, ends with an error line');
    await click(s, 'about-check');
    await s.waitFor("(function () { var b = document.getElementById('about-check'); var st = document.getElementById('about-update-status'); return !!b && !b.disabled && !!st && /is-error/.test(st.className); })()");
    assert.ok((await textOf(s, 'about-update-status')).trim().length > 0, 'the error line has words');
    assert.ok((await backendCalls(s, 'fetch(blocked)')).some((c) => /github/.test(c.args[0])), 'the check asked only GitHub (blocked here)');

    t.step('Copy details puts the version text on the clipboard');
    await click(s, 'about-copy');
    await s.waitFor("__explore.clip.text.indexOf('MD-Memo ') === 0");
    const clip = await s.ev('__explore.clip.text');
    assert.ok(/^MD-Memo \d+\.\d+\.\d+/.test(clip), `the copied text starts with the version: ${JSON.stringify(clip.slice(0, 40))}`);
    assert.ok(!/api[_-]?key|token/i.test(clip), 'and holds no secret');

    t.step('a link opens through the app, the window does not navigate');
    await clickSelector(s, '#about-modal a.about-link');
    await s.waitFor("window.__docshot.calls.some(function (c) { return c.fn === 'openExternal'; })");
    const opened = (await backendCalls(s, 'openExternal'))[0].args[0];
    assert.ok(/^https:\/\//.test(opened), `openExternal got an https address: ${opened}`);
    assert.equal(await s.ev('location.pathname'), '/', 'the window itself stayed on the app');

    t.step('Escape closes it, empties the body, and the editor has the focus');
    await s.key('Escape');
    await waitHidden(s, 'about-modal');
    assert.equal(await s.ev("document.getElementById('about-body').children.length"), 0, 'the body is emptied');
    await waitFocus(s, 'editor');
  },
};
