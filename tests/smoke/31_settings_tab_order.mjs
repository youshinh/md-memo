// Settings with the keyboard only (UX review bug B28): Tab and Shift+Tab walk through EVERY control of a pane, the collapsible
// headings (<summary>) included, and never leave the dialog. The focus trap of a11y.js used to jump back to the first control
// at each heading (a <summary> was not in its list of focusable elements), so only 8 of the 35 controls of General could be
// reached; the AI Models and Agent panes had the same 8-stop loop.
import { assert, click, waitFocus, waitShown } from './lib.mjs';

// Everything the browser can put focus on inside the dialog, that is shown, in document order. It is stored on the page so
// that later reads can turn document.activeElement into an index.
const COLLECT = `(function () {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  var all = Array.prototype.slice.call(document.getElementById('settings-modal').querySelectorAll(sel));
  // checkVisibility(): the content of a closed <details> still reports a box, but Tab skips it.
  window.__tabProbe = all.filter(function (e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!e.checkVisibility || e.checkVisibility()); });
  return window.__tabProbe.length;
})()`;
const WHERE = 'window.__tabProbe.indexOf(document.activeElement)';
const LABEL = `(function () { var a = document.activeElement; return a ? a.tagName + (a.id ? '#' + a.id : '') : 'nothing'; })()`;

async function walk(s, paneButton, shift) {
  await click(s, paneButton);
  await s.waitFor(`document.getElementById('${paneButton}').classList.contains('active')`);
  await s.ev(`document.getElementById('${paneButton}').focus()`);
  const count = await s.ev(COLLECT);
  assert.ok(count > 10, `${paneButton}: the pane has controls to walk through (${count})`);
  const visited = new Set();
  const trail = [];
  for (let i = 0; i < count + 3; i++) {
    await s.key('Tab', shift ? { shift: true } : {});
    const at = await s.ev(WHERE);
    trail.push(await s.ev(LABEL));
    assert.ok(at >= 0, `${paneButton}: focus left the dialog or landed on something the dialog does not list (${trail[trail.length - 1]}) after ${i + 1} presses`);
    visited.add(at);
  }
  const missed = await s.ev(`window.__tabProbe.map(function (e, i) { return i + ':' + e.tagName + (e.id ? '#' + e.id : ''); }).filter(function (_, i) { return ${JSON.stringify([...visited])}.indexOf(i) < 0; })`);
  assert.equal(visited.size, count, `${paneButton} ${shift ? 'Shift+Tab' : 'Tab'}: reached ${visited.size} of ${count} controls, missed ${missed.join(', ')}; the walk was ${trail.slice(0, 14).join(' > ')} ...`);
  return count;
}

export default {
  title: 'settings by keyboard: Tab reaches every control of each pane and stays in the dialog',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },
  timeoutMs: 120000,

  async run(s, t) {
    t.step('open Settings');
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    // The app moves focus to the General tab a moment after the dialog opens; walking before that would be knocked back to it.
    await waitFocus(s, 'tab-btn-general');

    for (const pane of ['tab-btn-general', 'tab-btn-model', 'tab-btn-agent']) {
      t.step(`${pane}: Tab reaches every control`);
      await walk(s, pane, false);
      t.step(`${pane}: Shift+Tab reaches every control`);
      await walk(s, pane, true);
    }
  },
};
