// The floating input panels (Ctrl+L / K / E / J) fade out shortly after focus leaves them: docs/design/panel-template.md.
// The controller is exercised with fake elements and a manual clock; the wiring in app.js / jev_action.js is checked in the source.
import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== Panel fade tests ===');

const require = createRequire(import.meta.url);
const PF = require('../frontend/js/panel_fade.js');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// ---- a manual clock and fake DOM ----
function makeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of pending) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        pending.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = end;
    },
    count: () => pending.size
  };
}

function makeEl() {
  const classes = new Set();
  const listeners = {};
  const kids = new Set();
  return {
    kids,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { (listeners[type] || []).forEach((f) => f(ev || {})); },
    contains(n) { return n === this || kids.has(n); }
  };
}

function rig(extra) {
  const clock = makeClock();
  const el = makeEl();
  const input = {};
  el.kids.add(input);
  const other = {};
  const doc = { activeElement: input, hasFocus: () => doc.focused, focused: true };
  const winListeners = {};
  const win = { addEventListener: (t, f) => { winListeners[t] = f; }, matchMedia: () => ({ matches: !!(extra && extra.reduce) }) };
  const state = { open: true, value: '', busy: false, closed: 0, refocused: 0 };
  const ctl = PF.create(el, {
    doc, win, timers: clock,
    isOpen: () => state.open,
    close: () => { state.open = false; state.closed++; },
    getValue: () => state.value,
    isBusy: () => state.busy,
    refocus: () => { state.refocused++; doc.activeElement = input; }
  });
  const leave = () => { doc.activeElement = other; el.fire('focusout', { relatedTarget: other }); };
  return { clock, el, input, other, doc, win, winListeners, state, ctl, leave };
}

// 1. the pure decision
{
  const base = { open: true, windowActive: true, focusInside: false, typed: false, busy: false };
  assert.strictEqual(PF.shouldFade(base), true);
  assert.strictEqual(PF.shouldFade({ ...base, open: false }), false, 'already closed');
  assert.strictEqual(PF.shouldFade({ ...base, windowActive: false }), false, 'Alt+Tab away is not moving on');
  assert.strictEqual(PF.shouldFade({ ...base, focusInside: true }), false, 'focus is back');
  assert.strictEqual(PF.shouldFade({ ...base, typed: true }), false, 'typed text would be lost');
  assert.strictEqual(PF.shouldFade({ ...base, busy: true }), false, 'a running command keeps it');
  assert.strictEqual(PF.shouldFade(null), false);
  assert.strictEqual(PF.GRACE_MS, 400);
  assert.strictEqual(PF.FADE_MS, 200);
  console.log('PASS: shouldFade covers open / window / focus / typed / busy; grace 400 ms, fade 200 ms.');
}

// 2. focus leaves: 0.4 s of grace, 0.2 s of fade, then the close
{
  const r = rig();
  r.leave();
  r.clock.tick(399);
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), false, 'nothing visible during the grace');
  r.clock.tick(1);
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), true, 'the fade starts at 0.4 s');
  assert.strictEqual(r.state.closed, 0, 'not closed yet');
  r.clock.tick(199);
  assert.strictEqual(r.state.closed, 0);
  r.clock.tick(1);
  assert.strictEqual(r.state.closed, 1, 'closed 0.2 s after the fade began');
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), false, 'the class is gone so the next open is opaque');
  assert.strictEqual(r.clock.count(), 0, 'no timer left behind');
  console.log('PASS: 0.4 s grace, then a 0.2 s fade, then close.');
}

// 3. focus comes back during the grace or during the fade
{
  const r = rig();
  r.leave();
  r.clock.tick(300);
  r.doc.activeElement = r.input;
  r.el.fire('focusin');
  r.clock.tick(2000);
  assert.strictEqual(r.state.closed, 0, 'back within the grace: stays');

  r.leave();
  r.clock.tick(500);
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), true);
  r.doc.activeElement = r.input;
  r.el.fire('focusin');
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), false, 'back during the fade: it is opaque again');
  r.clock.tick(2000);
  assert.strictEqual(r.state.closed, 0, 'and stays');
  console.log('PASS: focus returning during the grace or the fade cancels the close.');
}

// 4. typed text, a running command, and the window going inactive keep it open
{
  const r = rig();
  r.el.fire('input');
  r.state.value = 'summarize this';
  r.leave();
  r.clock.tick(3000);
  assert.strictEqual(r.state.closed, 0, 'typed text keeps the panel');

  const p = rig();
  p.state.value = 'preloaded from the selection'; // never typed by the user: value alone does not count
  p.leave();
  p.clock.tick(700);
  assert.strictEqual(p.state.closed, 1, 'text that was only preloaded does not keep the panel');

  const c = rig();
  c.state.busy = true;
  c.leave();
  c.clock.tick(3000);
  assert.strictEqual(c.state.closed, 0, 'a running command keeps the panel');

  const w = rig();
  w.doc.focused = false;
  w.leave();
  w.clock.tick(3000);
  assert.strictEqual(w.state.closed, 0, 'Alt+Tab away: nothing closes');
  w.doc.focused = true;
  w.winListeners.focus();
  w.clock.tick(700);
  assert.strictEqual(w.state.closed, 1, 'back in the window with focus still elsewhere: the grace starts then');
  console.log('PASS: typed text, a running command and an inactive window keep the panel; preloaded text does not.');
}

// 5. a press on a blank part of the panel is not "moving on"
{
  const r = rig();
  r.el.fire('mousedown');
  r.doc.activeElement = r.other; // <body> took the focus
  r.el.fire('focusout', { relatedTarget: null });
  r.clock.tick(0);
  assert.strictEqual(r.state.refocused, 1, 'focus is handed back to the input');
  r.clock.tick(3000);
  assert.strictEqual(r.state.closed, 0);
  console.log('PASS: pressing the hint line or a chip keeps the panel and returns focus to the input.');
}

// 6. focus moving to another control inside the panel is not leaving; closing by hand or reopening resets
{
  const r = rig();
  const button = {};
  r.el.kids.add(button);
  r.el.fire('focusout', { relatedTarget: button });
  r.clock.tick(3000);
  assert.strictEqual(r.state.closed, 0);

  r.leave();
  r.clock.tick(500);
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), true);
  r.ctl.cancel();
  assert.strictEqual(r.el.classList.contains(PF.FADING_CLASS), false, 'cancel() brings a fading panel back');
  assert.strictEqual(r.clock.count(), 0);

  r.state.open = false;
  r.leave();
  assert.strictEqual(r.clock.count(), 0, 'a closed panel starts no timer');
  console.log('PASS: moving between the panel\'s own controls is fine; cancel() and a closed panel leave nothing running.');
}

// 7. reduce motion: no fade, the grace stays
{
  const r = rig({ reduce: true });
  r.leave();
  r.clock.tick(399);
  assert.strictEqual(r.state.closed, 0);
  r.clock.tick(1);
  assert.strictEqual(r.state.closed, 1, 'closes at once after the grace when motion is reduced');
  console.log('PASS: reduced motion skips the fade only.');
}

// 7b. text the page puts in itself (a preset prompt from the palette) raises no input event: markTyped counts it, isTyped says so
{
  const r = rig();
  r.state.value = 'a preset prompt';
  assert.strictEqual(r.ctl.isTyped(), false, 'a value set by the page is not typed text (no input event)');
  r.leave();
  r.clock.tick(600);
  assert.strictEqual(r.state.closed, 1, 'so the bar fades away when focus leaves it');

  const kept = rig();
  kept.state.value = 'a preset prompt';
  kept.ctl.markTyped();
  assert.strictEqual(kept.ctl.isTyped(), true, 'markTyped counts it');
  kept.leave();
  kept.clock.tick(1000);
  assert.strictEqual(kept.state.closed, 0, 'and the bar stays, like for typed text');
  kept.state.value = '';
  assert.strictEqual(kept.ctl.isTyped(), false, 'an emptied input is not text to keep');
  kept.state.value = 'again';
  assert.strictEqual(kept.ctl.isTyped(), true, 'markTyped lasts until reset');
  kept.ctl.reset();
  assert.strictEqual(kept.ctl.isTyped(), false, 'a freshly opened panel starts clean');
  console.log('PASS: markTyped / isTyped: text the page put in counts as typed until the panel is reset.');
}

// 8. the wiring
{
  const app = read('frontend/js/app.js');
  const jev = read('frontend/js/jev_action.js');
  const html = read('frontend/index.html');
  const css = read('frontend/css/style.css');

  assert.ok(html.indexOf('js/panel_fade.js') !== -1 && html.indexOf('js/panel_fade.js') < html.indexOf('js/jev_action.js') && html.indexOf('js/panel_fade.js') < html.indexOf('js/app.js'), 'panel_fade.js loads before its users');
  assert.ok(/\.panel-fading\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity 0\.2s/.test(css), 'the fade class fades opacity over 0.2 s');

  assert.ok(/const askBarFade = window\.PanelFade && inlinePromptBar \? window\.PanelFade\.create\(inlinePromptBar,/.test(app), 'ask / rewrite bar has a controller');
  assert.ok(/const cliBarFade = window\.PanelFade && cliFilterBar \? window\.PanelFade\.create\(cliFilterBar,/.test(app), 'command bar has a controller');
  assert.ok(/isBusy: \(\) => isCliFilterRunning \|\| isAiCliGenerating/.test(app), 'a running or generating command keeps the command bar');
  assert.ok(/if \(askBarFade\) askBarFade\.reset\(\);\s*inlinePromptBar\.classList\.remove\('hidden'\)/.test(app), 'opening the ask bar starts clean');
  assert.ok(/function closeInlinePromptBar\(\) \{\s*if \(askBarFade\) askBarFade\.cancel\(\);/.test(app), 'closing the ask bar cancels a pending fade');
  assert.ok(/if \(cliBarFade\) cliBarFade\.reset\(\);\s*cliFilterBar\.classList\.remove\('hidden'\)/.test(app), 'opening the command bar starts clean');
  assert.ok(/function closeCliFilterBar\(\) \{\s*if \(cliBarFade\) cliBarFade\.cancel\(\);/.test(app), 'closing the command bar cancels a pending fade');

  assert.ok(/global\.PanelFade \? global\.PanelFade\.create\(jevPanelEl,\s*\{\s*watchFocus: false,/.test(jev), 'the suggest panel is driven by the editor, not by its own focus');
  assert.ok(/ed\.addEventListener\('blur', \(\) => \{\s*if \(!isPanelVisible\) return;\s*if \(panelFade\) panelFade\.arm\(\); else hidePanel\(\);/.test(jev), 'the editor losing focus arms the fade');
  assert.ok(/ed\.addEventListener\('focus', \(\) => \{\s*if \(panelFade\) panelFade\.cancel\(\);/.test(jev), 'the editor regaining focus cancels it');
  assert.ok(/function hidePanel\(\) \{\s*if \(!jevPanelEl\) return;\s*if \(panelFade\) panelFade\.cancel\(\);/.test(jev), 'hiding the suggest panel cancels a pending fade');
  console.log('PASS: script order, the CSS class, and the wiring of the four panels.');
}

console.log('\nAll panel fade tests PASSED!');
