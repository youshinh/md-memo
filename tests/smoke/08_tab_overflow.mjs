// Many tabs: the "+" button stays on screen, the "All tabs" button appears and lists every tab (the open one marked), choosing a
// row opens that tab and scrolls it into view, Escape closes the list and gives the focus back to its button, the palette
// opens the same list, and with a window wide enough for all the tabs the button goes away again. (UX review B2.)
import { assert, click, openPalette, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';

const COUNT = 14;
const notes = [];
for (let i = 1; i <= COUNT; i++) notes.push({ title: `long-named-project-note-number-${i}.md`, content: `# note ${i}\n` });

const activeTabInStrip = `(function () {
  var a = document.querySelector('#tabs-list .tab-item.active');
  var sc = document.getElementById('tabs-scroll');
  if (!a) return false;
  var r = a.getBoundingClientRect(), b = sc.getBoundingClientRect();
  return r.left >= b.left - 1 && r.right <= b.right + 1;
})()`;

const newButtonOnScreen = `(function () {
  var r = document.getElementById('btn-new-tab').getBoundingClientRect();
  return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
})()`;

export default {
  title: 'tab overflow: + stays, All tabs list, choose a row, Escape, palette, wide window',
  session: { notes },

  async run(s, t) {
    t.step('14 tabs do not fit: + stays on screen, All tabs shows');
    await s.waitFor("document.querySelectorAll('#tabs-list .tab-item').length === " + COUNT);
    await waitShown(s, 'btn-all-tabs');
    assert.equal(await s.ev(newButtonOnScreen), true, 'the + button is on screen');
    assert.equal(await s.ev("(function () { var e = document.getElementById('tabs-scroll'); return e.scrollWidth > e.clientWidth; })()"), true, 'the strip scrolls inside its own box');

    t.step('the list shows every tab, the open one marked');
    await click(s, 'btn-all-tabs');
    await waitShown(s, 'tab-list-panel');
    assert.equal(await s.ev("document.querySelectorAll('#tab-list-rows .tab-list-row').length"), COUNT, 'one row per tab');
    assert.equal(await s.ev("document.querySelectorAll('#tab-list-rows .tab-list-row.is-current').length"), 1, 'exactly one row is marked as the open tab');
    assert.equal(await s.ev("document.getElementById('btn-all-tabs').getAttribute('aria-expanded')"), 'true');
    await waitFocus(s, 'tab-list-rows');

    t.step('choose the last tab from the list');
    await s.key('End');
    await s.key('Enter');
    await waitHidden(s, 'tab-list-panel');
    const st = await s.state();
    assert.equal(st.activeTabId, st.tabs[COUNT - 1].id, 'the last tab is the open one');
    await s.waitFor(activeTabInStrip);
    assert.equal(await s.ev(newButtonOnScreen), true, 'the + button is still on screen');
    assert.equal(await s.ev("document.getElementById('btn-all-tabs').getAttribute('aria-expanded')"), 'false');

    t.step('a new tab from + is scrolled into view');
    await click(s, 'btn-new-tab');
    await s.waitFor(`window.__explore.state().tabs.length === ${COUNT + 1}`);
    await s.waitFor(activeTabInStrip);

    t.step('Escape closes the list and the focus goes back to its button');
    await click(s, 'btn-all-tabs');
    await waitShown(s, 'tab-list-panel');
    await s.key('Escape');
    await waitHidden(s, 'tab-list-panel');
    await waitFocus(s, 'btn-all-tabs');

    t.step('the palette opens the same list');
    await openPalette(s);
    await s.type(t.pick('all tabs', 'すべてのタブ'));
    await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
    await s.key('Enter');
    await waitShown(s, 'tab-list-panel');
    assert.equal(await s.ev("document.querySelectorAll('#tab-list-rows .tab-list-row').length"), COUNT + 1);
    await s.key('Escape');
    await waitHidden(s, 'tab-list-panel');

    t.step('a wide window fits all the tabs: the All tabs button goes away');
    await s.page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 4400, height: 720, deviceScaleFactor: 1, mobile: false });
    await waitHidden(s, 'btn-all-tabs');
    await s.page.cdp.send('Emulation.setDeviceMetricsOverride', { width: s.viewport.w, height: s.viewport.h, deviceScaleFactor: 1, mobile: false });
    await waitShown(s, 'btn-all-tabs');
    assert.equal(await shown(s, 'tab-list-panel'), false, 'and the list itself stayed closed');
  },
};
