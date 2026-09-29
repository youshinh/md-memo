// The amber "this is what changed" cue after an AI / command / {{ }} result used to be a class on the whole <textarea>:
// the bar ran down the full height of the editor and the whole note glowed, however small the change. It is now a band
// over just the rows of the text that landed (frontend/js/ghost_diff.js). The pixel check needs a real browser (done
// there: a 3-line result gets a 67.4px band = 3 rows, a wrapped paragraph gets one band over its rows, the band
// follows the scroll, and is gone after typing, after the note changes under it and after its time). This test pins the
// rules with a hand-made DOM.
import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== Ghost diff (changed rows only) tests ===');

const require = createRequire(import.meta.url);
const GD = require('../frontend/js/ghost_diff.js');

// --- 1. Which characters get the band.
{
  const v = 'a\n\nresult one\nresult two\n\nz';
  const start = v.indexOf('\n\nresult'), end = v.indexOf('\n\nz');
  const r = GD.markedRange(v, start, end);
  assert.strictEqual(r.text, 'result one\nresult two', 'the line breaks around a result are not marked');
  assert.strictEqual(v.slice(r.from, r.last + 1), 'result one\nresult two');
  // nothing visible added: the place itself is marked
  const e = GD.markedRange('abc\n\ndef', 3, 5);
  assert.strictEqual(e.from, 5, 'only line breaks: mark where it happened');
  assert.deepStrictEqual(GD.markedRange('', 0, 0), { from: 0, last: 0, text: '' });
  // out-of-range offsets are clamped
  assert.strictEqual(GD.markedRange('hello', -4, 99).text, 'hello');
  assert.strictEqual(GD.markedRange('hello', 99, 120).text, '');
  console.log('PASS: markedRange skips the line breaks around a result and clamps its offsets.');
}

// --- 1b. Finding the marked text again after the note changed.
{
  const v = 'xx\nresult\nyy';
  assert.strictEqual(GD.locate(v, 'result', 3, v.length), 3, 'nothing moved');
  assert.strictEqual(GD.locate('NEW\n' + v, 'result', 3, v.length), 7, 'text went in above: shifted by the growth');
  assert.strictEqual(GD.locate(v.slice(3), 'result', 3, v.length), 0, 'text went out above');
  assert.ok(GD.locate('a result b result', 'result', 40, 50) >= 0, 'otherwise it is searched for');
  assert.strictEqual(GD.locate('gone', 'result', 3, 10), -1, 'not there any more');
  console.log('PASS: locate() finds the marked text where it moved, and -1 when it is gone.');
}

// --- 2. The band covers the rows from the first to the last marked character.
{
  assert.deepStrictEqual(GD.bandBox(100, 100, 22.4), { top: 100, height: 22.4 }, 'one row');
  const b = GD.bandBox(100, 144.8, 22.4);
  assert.strictEqual(b.top, 100);
  assert.ok(Math.abs(b.height - 67.2) < 1e-9, 'three rows = 2 row steps + one row, got ' + b.height);
  assert.strictEqual(GD.bandBox(50, 40, 22).height, 22, 'never shorter than one row');
  console.log('PASS: bandBox spans first row top to last row bottom.');
}

// --- 3. The DOM behaviour, on a hand-made page.
function makeDom() {
  const timers = [];
  let now = 0;
  const g = globalThis;
  g.setTimeout = (fn, ms) => { const t = { fn, at: now + ms, id: timers.length, kind: 'timeout' }; timers.push(t); return t; };
  g.clearTimeout = (t) => { if (t) t.dead = true; };
  g.setInterval = (fn, ms) => { const t = { fn, every: ms, at: now + ms, id: timers.length, kind: 'interval' }; timers.push(t); return t; };
  g.clearInterval = (t) => { if (t) t.dead = true; };
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.kind === 'interval') due.at += due.every; else due.dead = true;
      due.fn();
    }
    now = target;
  };
  const mkEl = () => {
    const el = {
      className: '', attrs: {}, children: [], parentNode: null, styleProps: {},
      style: { setProperty(k, v) { el.styleProps[k] = v; } },
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; }
    };
    return el;
  };
  g.document = { createElement: mkEl };
  g.getComputedStyle = () => ({ position: 'relative', lineHeight: '20px', fontSize: '14px' });
  const wrap = mkEl();
  wrap.style.position = 'relative';
  const listeners = {};
  const editor = {
    value: '',
    scrollTop: 0,
    parentElement: wrap,
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    fire(t, e) { (listeners[t] || []).slice().forEach((f) => f(e || {})); },
    listenerCount(t) { return (listeners[t] || []).length; }
  };
  // Row = 20px, one row per '\n'-separated line (no wrapping): the top of an offset is its line index * 20 + 12 (padding).
  const getCoords = (off, ed) => ({ top: ed.value.slice(0, off).split('\n').length * 20 - 20 + 12, left: 0 });
  return { wrap, editor, getCoords, advance };
}

{
  const { wrap, editor, getCoords, advance } = makeDom();
  editor.value = 'l1\nl2\nl3\nresult A\nresult B\nl6\nl7';
  const s = editor.value.indexOf('result A'), e = editor.value.indexOf('\nl6');

  assert.strictEqual(GD.flash(editor, s, e, { durationMs: 1000, getCoords }), true);
  assert.strictEqual(wrap.children.length, 1, 'one band');
  const band = wrap.children[0];
  assert.strictEqual(band.className, 'ghost-diff-band');
  assert.strictEqual(band.style.top, (3 * 20 + 12) + 'px', 'starts at the first changed row, not at the top of the editor');
  assert.strictEqual(band.style.height, '40px', 'covers the two changed rows only');
  assert.strictEqual(band.styleProps['--ghost-diff-duration'], '1000ms', 'the configured duration reaches the animation');
  assert.strictEqual(band.attrs['aria-hidden'], 'true');

  // follows the scroll
  editor.scrollTop = 30;
  editor.fire('scroll');
  assert.strictEqual(band.style.top, (3 * 20 + 12 - 30) + 'px');

  // A scripted input event (the merge dispatching its own) leaves it where it is
  editor.fire('input', { isTrusted: false });
  assert.strictEqual(wrap.children.length, 1, 'a scripted input event must not end the cue');

  // Text typed ABOVE the marked rows: the band moves down with its text and stays
  editor.value = 'new line\n' + editor.value;
  editor.fire('input', { isTrusted: true });
  assert.strictEqual(wrap.children.length, 1, 'typing elsewhere does not end the cue');
  assert.strictEqual(band.style.top, (4 * 20 + 12 - 30) + 'px', 'the band follows its text one row down');
  assert.strictEqual(band.style.height, '40px');

  // Text typed INSIDE the marked rows: the marked text is not there any more
  editor.value = editor.value.replace('result A', 'result AX');
  editor.fire('input', { isTrusted: true });
  assert.strictEqual(wrap.children.length, 0, 'editing the marked text ends the cue');
  assert.strictEqual(editor.listenerCount('scroll') + editor.listenerCount('input'), 0, 'listeners are released with the last band');
  console.log('PASS: the band covers only the changed rows, follows the scroll and its text, and ends when the text is edited.');
}

{
  const { wrap, editor, getCoords, advance } = makeDom();
  editor.value = 'l1\nresult\nl3';
  GD.flash(editor, 3, 9, { durationMs: 1000, getCoords });
  assert.strictEqual(wrap.children.length, 1);
  // the note under the band is replaced (another tab loaded into the textarea)
  editor.value = 'other\nnote\nentirely';
  advance(250);
  assert.strictEqual(wrap.children.length, 0, 'a band over text that is no longer what was marked goes away');

  editor.value = 'l1\nresult\nl3';
  GD.flash(editor, 3, 9, { durationMs: 1000, getCoords });
  advance(900);
  assert.strictEqual(wrap.children.length, 1, 'still there before its time is up');
  advance(200);
  assert.strictEqual(wrap.children.length, 0, 'gone after its duration');
  assert.strictEqual(editor.listenerCount('scroll') + editor.listenerCount('input'), 0);
  console.log('PASS: the band ends when the note changes under it and after its duration.');
}

// Several results in flight: each keeps its own band, and a result landing above moves the ones below it (it does not remove them).
{
  const { wrap, editor, getCoords, advance } = makeDom();
  editor.value = 'A1\nA2\n\nB1\nB2';
  const bStart = editor.value.indexOf('B1');
  GD.flash(editor, bStart, editor.value.length, { durationMs: 2000, getCoords });   // B is marked first
  assert.strictEqual(wrap.children.length, 1);
  // a second result is inserted above B (through the browser: a trusted input event)
  editor.value = 'A1\nsummary line\nA2\n\nB1\nB2';
  const sStart = editor.value.indexOf('summary line');
  editor.fire('input', { isTrusted: true });
  GD.flash(editor, sStart, sStart + 'summary line'.length, { durationMs: 2000, getCoords });
  assert.strictEqual(wrap.children.length, 2, 'the earlier band survives the later insert');
  const bandB = wrap.children[0];
  const bandS = wrap.children[1];
  assert.strictEqual(bandB.style.top, (4 * 20 + 12) + 'px', 'the earlier band moved down one row with its text');
  assert.strictEqual(bandS.style.top, (1 * 20 + 12) + 'px');
  advance(2100);
  assert.strictEqual(wrap.children.length, 0, 'both go after their time');
  console.log('PASS: results landing one after another each keep their band; an earlier one moves with its text.');
}

{
  const { wrap, editor, getCoords } = makeDom();
  editor.value = 'l1\nresult\nl3';
  GD.flash(editor, 3, 9, { durationMs: 1000, getCoords });
  GD.clear(editor);
  assert.strictEqual(wrap.children.length, 0, 'clear() drops the band now (Ctrl+Z put the old text back)');
  // a huge note: only estimated row positions -> no cue rather than a cue in the wrong place
  assert.strictEqual(GD.flash(editor, 3, 9, { getCoords: () => ({ top: 500, left: 0, estimated: true }) }), false);
  // nothing to lay out (no coordinates function, or an empty result): no cue, no error
  assert.strictEqual(GD.flash(editor, 3, 9, { getCoords: null }), false);
  assert.strictEqual(GD.flash(editor, 5, 5, { getCoords }), true, 'an empty result still marks the place it happened');
  GD.clear(editor);
  assert.strictEqual(GD.flash(null, 0, 1), false);
  assert.strictEqual(GD.flash({ value: 'abc' }, 0, 1, { getCoords }), false, 'an editor with no wrapper');
  console.log('PASS: clear(), huge notes, and missing pieces are handled without a cue or an error.');
}

// --- 4. Nobody puts the glow on the whole textarea any more; every call passes the range.
{
  const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const app = read('frontend/js/app.js');
  const slot = read('frontend/js/slot_agent.js');
  const css = read('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = read('frontend/index.html');
  assert(!/classList\.add\('slot-ghost-diff'\)/.test(app + slot), 'the whole-editor glow class must not be added any more');
  assert(!/\.slot-ghost-diff\s*\{/.test(css), 'the whole-editor glow rule is gone');
  const calls = [...app.matchAll(/flashGhostDiff\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => a !== 'editor, start, end');
  assert(calls.length >= 2 && calls.every((a) => a.split(',').length >= 3), 'every flashGhostDiff call passes the range: ' + calls.join(' | '));
  assert(/triggerGhostDiff\(editor, replaceStart, replaceStart \+ insertedLen\)/.test(slot), 'the slot merge passes the inserted range');
  // A command's output and a Quick Actions insert are results too: they get the same band.
  const cliBelow = app.slice(app.indexOf('function insertCliOutputBelow'), app.indexOf('function replaceWithCliOutput'));
  assert(/flashGhostDiff\(editor, pos,/.test(cliBelow), 'the Command Bar output placed below the input is marked');
  const cliReplace = app.slice(app.indexOf('function replaceWithCliOutput'), app.indexOf('async function executeCliFilter'));
  assert(/flashGhostDiff\(editor, start,/.test(cliReplace), 'the Command Bar output that replaces text is marked');
  assert(!/insertTextWithUndo\(res\.output, editor\)/.test(app), 'every Command Bar insert goes through the marking helpers');
  const jev = read('frontend/js/jev_action.js');
  assert(/global\.flashGhostDiff\(ed, insertPos, insertPos \+ insertion\.length\)/.test(jev), 'a Quick Actions insert is marked');
  assert(/window\.flashGhostDiff = flashGhostDiff/.test(app), 'app.js shares flashGhostDiff with the sibling modules');
  assert(/\.ghost-diff-band\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/.test(css.replace(/\n/g, ' ')), 'the band is an overlay that takes no input');
  assert(/js\/ghost_diff\.js/.test(html) && html.indexOf('js/ghost_diff.js') < html.indexOf('js/slot_agent.js'), 'ghost_diff.js is loaded before slot_agent.js');
  console.log('PASS: the whole-editor glow is gone and every caller passes the range.');
}

console.log('\nAll ghost diff tests PASSED!');
