// Helpers the smoke flows share (tests/smoke/NN_*.mjs). Everything here reads and drives the page through the exploration kit's
// session `s` (tools/explore/kit.mjs); nothing touches a real config, note, clipboard or program.
//
// Rules the flows follow, so that they stay stable:
//   * They judge the DOM and the app state, never a picture.
//   * They wait for a condition (waitFor), never for a fixed time. The one exception is "nothing more happens" (a sleep of a
//     few hundred ms after something that must NOT happen), kept short and named `settle`.
//   * They find things by element id and by state, not by label text, so they run in both UI languages.
//   * A keyboard shortcut the browser itself reserves (Ctrl+N, Ctrl+T, Ctrl+W) never reaches the page in this headless setup, so
//     a flow uses the "+" button (a real mouse click) or the command palette instead.
import assert from 'node:assert/strict';

export { assert };

const q = (id) => JSON.stringify(id);

// ---- reading the page ----------------------------------------------------------------------------------

// True when the element exists and does not carry the `hidden` class (how the app shows and hides its panels).
export const shown = (s, id) => s.ev(`(function () { var e = document.getElementById(${q(id)}); return !!e && !e.classList.contains('hidden'); })()`);

export const waitShown = (s, id, opts) => s.waitFor(`(function () { var e = document.getElementById(${q(id)}); return !!e && !e.classList.contains('hidden'); })()`, opts);

export const waitHidden = (s, id, opts) => s.waitFor(`(function () { var e = document.getElementById(${q(id)}); return !e || e.classList.contains('hidden'); })()`, opts);

export const waitFocus = (s, id, opts) => s.waitFor(`!!document.activeElement && document.activeElement.id === ${q(id)}`, opts);

export const textOf = (s, id) => s.ev(`(function () { var e = document.getElementById(${q(id)}); return e ? e.textContent : null; })()`);

// The live text of the note in the active tab, and the whole snapshot (see the kit README, s.state()).
export async function noteText(s) {
  const st = await s.state();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  return tab ? tab.content : null;
}

export const activeTab = async (s) => {
  const st = await s.state();
  return st.tabs.find((t) => t.id === st.activeTabId) || null;
};

// Waits until the active note's text satisfies a page-side condition on `text`, e.g. waitNote(s, "text.indexOf('Reply') !== -1").
export const waitNote = (s, cond, opts) => s.waitFor(`(function () {
  var st = window.__explore.state();
  var tab = st.tabs.filter(function (t) { return t.id === st.activeTabId; })[0];
  var text = tab ? tab.content : '';
  return ${cond};
})()`, opts);

// The waiting marker the app writes into a note while the AI works ("[AI Generating: translate...]", in Japanese "[AI 生成中: ...]"):
// a bracketed run that ends in "...]". Language independent, so a check on it is not vacuous in the Japanese run.
export const hasWaitingMarker = (text) => /\[[^\]\n]*\.\.\.\]/.test(String(text));

// The live config object of the app, as a plain copy.
export const liveConfig = (s) => s.ev('JSON.parse(JSON.stringify(MdMemoBridge.getConfig()))');

// The mock records every backend call with its first 3 arguments (window.__docshot.calls).
export const backendCalls = (s, fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${q(fn)}; })`);

// The settings JSON of the newest saveConfig call, parsed, or null when nothing was saved yet.
export async function lastSavedConfig(s) {
  const calls = await backendCalls(s, 'saveConfig');
  if (!calls.length) return null;
  return JSON.parse(calls[calls.length - 1].args[0]);
}

// ---- driving the page ----------------------------------------------------------------------------------

// Where to click an element: its centre once it has stopped moving (a panel that fades or slides in changes its box for a moment,
// and a coordinate measured mid-animation misses). findExpr is a page-side expression that returns the element.
function settledCenter(s, findExpr) {
  return s.ev(`(async function () {
    var find = function () { return ${findExpr}; };
    var e = find();
    if (!e) return null;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    var prev = null;
    for (var i = 0; i < 15; i++) {
      await new Promise(function (resolve) {
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(); } };
        requestAnimationFrame(function () { requestAnimationFrame(finish); });
        setTimeout(finish, 80);
      });
      e = find();
      if (!e) return null;
      var b = e.getBoundingClientRect();
      var cur = { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
      if (prev && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5 && Math.abs(cur.w - prev.w) < 0.5 && Math.abs(cur.h - prev.h) < 0.5) return cur;
      prev = cur;
    }
    return prev;
  })()`);
}

// A real mouse click in the middle of an element (scrolled into view, and waited for until it stands still). The element must
// have a box: a collapsed or hidden control is a failure of the flow, said clearly.
export async function click(s, id) {
  const r = await settledCenter(s, `document.getElementById(${q(id)})`);
  assert.ok(r, `#${id} does not exist`);
  assert.ok(r.w > 0 && r.h > 0, `#${id} has no box on screen (hidden or collapsed)`);
  await s.page.click(r.x, r.y);
  return r;
}

// A real mouse click on an element found by a CSS selector (the first match).
export async function clickSelector(s, selector) {
  const r = await settledCenter(s, `document.querySelector(${q(selector)})`);
  assert.ok(r, `nothing matches ${selector}`);
  assert.ok(r.w > 0 && r.h > 0, `${selector} has no box on screen`);
  await s.page.click(r.x, r.y);
  return r;
}

// Puts the caret in the editor and selects the first occurrence of `needle` (or just parks the caret at its start when
// `caretOnly`). Returns the [start, end) range.
export async function selectInEditor(s, needle, { caretOnly = false } = {}) {
  const range = await s.ev(`(function () {
    var e = document.getElementById('editor');
    e.focus();
    var i = e.value.indexOf(${q(needle)});
    if (i < 0) return null;
    var end = ${caretOnly ? 'i' : `i + ${q(needle)}.length`};
    e.setSelectionRange(i, end);
    return [i, end];
  })()`);
  assert.ok(range, `"${needle}" is not in the editor`);
  return range;
}

export const focusEditor = (s) => s.ev("document.getElementById('editor').focus()");

// Calls a function of window.__mdMemoRPC (the page half of the JSON-RPC server) with a page-side argument list, e.g.
// rpc(s, 'getCursor("tab_x1")'). Resolves to { ok: result } or, when the call threw, { err: message, kind } where kind is the
// "[kind] " prefix the Go side maps to a JSON-RPC error code (not_found, invalid_params, conflict). A promise result is awaited.
export const rpc = (s, call) => s.ev(`(async function () {
  try { return { ok: await window.__mdMemoRPC.${call} }; }
  catch (e) { return { err: String((e && e.message) || e), kind: e && e.rpcKind }; }
})()`);

// Opens the ask bar (Ctrl+L) and waits until it is usable.
export async function openAsk(s) {
  await s.key('l', { ctrl: true });
  await waitShown(s, 'inline-prompt-bar');
  await waitFocus(s, 'inline-prompt-input');
}

// Types the instruction and presses Enter.
export async function submitAsk(s, instruction) {
  await s.type(instruction);
  await s.key('Enter');
}

// Opens the command palette (Ctrl+Shift+P) and waits until its input has the focus (it takes it a moment after it appears).
export async function openPalette(s) {
  await s.key('p', { ctrl: true, shift: true });
  await waitShown(s, 'quick-pick-modal');
  await waitFocus(s, 'quick-pick-input');
}

// The titles the palette lists right now.
export const paletteTitles = (s) => s.ev("Array.from(document.querySelectorAll('#quick-pick-list .quick-pick-item-title')).map(function (e) { return e.textContent; })");

// Palette: open it, filter by `query`, press Enter on the first match.
export async function runPaletteCommand(s, query) {
  await openPalette(s);
  await s.type(query);
  await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
  await s.key('Enter');
}

// Lets the page run for a short moment, for "and nothing else happens". Use only after an event that must NOT cause anything.
export const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the session's status-bar/async work to be quiet: no pending AI request.
export const waitIdle = (s) => s.waitFor('window.__explore.state().pendingLlm === 0');

// Reloads the mocked app as a first launch (no settings, no saved tabs, no remembered folder: the Welcome note appears) or as
// the second start of a profile (`session: true`: settings still unsaved, a session left behind). The exploration hooks stay
// installed across the reload.
export async function reloadAs(s, { firstLaunch = false } = {}) {
  await s.page.navigate(`${s.base}/?lang=${s.lang}&fresh=1${firstLaunch ? '&nosession=1' : ''}`);
  await s.page.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 30000, label: 'the app to be ready after the reload' });
  await s.ev('window.__explore.reset()');
}
