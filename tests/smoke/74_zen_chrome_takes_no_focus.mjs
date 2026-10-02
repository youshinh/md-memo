// Zen mode and the keyboard (accessibility session C13-03): the permanent Zen mode hides the header and the status bar with
// zero height and zero opacity, and Tab used to walk through the buttons in them; Enter on "Autosave" there switched the setting
// off with nothing on screen to show it. Hidden chrome must take no focus. The typing dimmer (body.zen-active) only dims, so
// what is merely faint stays reachable.
import { assert } from './lib.mjs';

const IN_CHROME = `(function () { var a = document.activeElement; return !!a && !!a.closest && !!a.closest('#header, #status-bar'); })()`;
const blurAll = `(function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return document.activeElement === document.body; })()`;
const vis = (id) => `getComputedStyle(document.getElementById('${id}')).visibility`;

// Presses Tab (or Shift+Tab) up to `max` times from the page body and says whether focus ever landed in the header / status bar.
async function walkReachesChrome(s, max, shift) {
  assert.ok(await s.ev(blurAll), 'focus starts on the page body');
  const trail = [];
  for (let i = 0; i < max; i++) {
    await s.key('Tab', shift ? { shift: true } : {});
    trail.push(await s.ev(`(function () { var a = document.activeElement; return a ? a.tagName + (a.id ? '#' + a.id : '') : 'nothing'; })()`));
    if (await s.ev(IN_CHROME)) return { reached: true, trail };
  }
  return { reached: false, trail };
}

export default {
  title: 'Zen mode: the hidden header and status bar take no focus; the typing dimmer only dims',
  session: { notes: [{ title: 'a.md', content: 'text\n' }] },
  timeoutMs: 90000,

  async run(s, t) {
    t.step('baseline: without Zen mode, Tab does reach the chrome (so the later check is not vacuous)');
    const baseline = await walkReachesChrome(s, 40, false);
    assert.ok(baseline.reached, `Tab never reached the header or the status bar in 40 presses: ${baseline.trail.join(' > ')}`);

    t.step('typing dims the chrome (zen-active) but it stays visible and focusable');
    await s.ev(`document.getElementById('editor').focus()`);
    await s.type('x');
    await s.waitFor(`document.body.classList.contains('zen-active')`);
    await s.waitFor(`parseFloat(getComputedStyle(document.getElementById('status-bar')).opacity) < 0.5`);
    assert.equal(await s.ev(vis('status-bar')), 'visible', 'the dimmed status bar is still visible to the accessibility tree and Tab');
    assert.equal(await s.ev(vis('header')), 'visible');
    await s.ev(`document.getElementById('stat-autosave').focus()`);
    assert.equal(await s.ev('document.activeElement.id'), 'stat-autosave', 'a dimmed control still takes focus');

    t.step('Shift+F11: Zen mode hides the chrome, and hidden means out of reach');
    await s.ev(`document.getElementById('editor').focus()`);
    await s.key('F11', { shift: true });
    await s.waitFor(`document.body.classList.contains('zen-mode')`);
    // the fade-out runs first; visibility follows it
    await s.waitFor(`${vis('header')} === 'hidden' && ${vis('status-bar')} === 'hidden'`);
    await s.ev(`document.getElementById('stat-autosave').focus()`);
    assert.notEqual(await s.ev('document.activeElement.id'), 'stat-autosave', 'a control in the hidden status bar cannot be focused');
    const forward = await walkReachesChrome(s, 25, false);
    assert.ok(!forward.reached, `Tab walked into the hidden chrome: ${forward.trail.join(' > ')}`);
    const backward = await walkReachesChrome(s, 25, true);
    assert.ok(!backward.reached, `Shift+Tab walked into the hidden chrome: ${backward.trail.join(' > ')}`);

    t.step('Shift+F11 again: the chrome is back at once and reachable');
    await s.ev(`document.getElementById('editor').focus()`);
    await s.key('F11', { shift: true });
    await s.waitFor(`!document.body.classList.contains('zen-mode')`);
    assert.equal(await s.ev(vis('status-bar')), 'visible');
    assert.equal(await s.ev(vis('header')), 'visible');
    await s.ev(`document.getElementById('stat-autosave').focus()`);
    assert.equal(await s.ev('document.activeElement.id'), 'stat-autosave', 'out of Zen mode the control takes focus again');
  },
};
