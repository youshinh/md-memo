// A long many-line text landing in the note must not freeze the window (UX/perf review B16). Chromium applies the browser's
// 'insertText' command one line at a time and each line costs a pass over the whole note, so an AI answer, a JSON-RPC write or a
// pasted table of a few thousand lines held the page for 5 to 20 s. Every path that keeps the insertion one Ctrl+Z step now goes
// through bulk_insert.js. This flow watches the page's event loop with a 10 ms heartbeat while each path runs, checks that the
// text that lands is exactly right, and that ONE Ctrl+Z takes it out again (the same number of presses a short answer needs).
import { assert, focusEditor, openAsk, submitAsk, waitNote, waitIdle } from './lib.mjs';

const LINES = 3000;
// The fixed paths take well under 200 ms for this size; the old one took 9 to 12 s. The margin keeps a slow machine from failing it.
const MAX_FREEZE_MS = 2000;
const NOTE = '# Notes\n\nSummarize this line\n';

const HEARTBEAT = `(function () {
  if (window.__hb) return;
  var hb = { max: 0, last: performance.now() };
  window.__hb = hb;
  setInterval(function () { var n = performance.now(); var g = n - hb.last; if (g > hb.max) hb.max = g; hb.last = n; }, 10);
})()`;
const RESET_HEARTBEAT = 'window.__hb.max = 0; window.__hb.last = performance.now(); 1';
const READ_HEARTBEAT = 'Math.round(window.__hb.max)';

const bigLine = (i) => `Result line ${i}: the quick brown fox jumps over the lazy dog, again and again.`;
const bigText = (n) => Array.from({ length: n }, (_, i) => bigLine(i + 1)).join('\n');

async function noteNow(s) {
  const st = await s.state();
  return st.tabs.find((tab) => tab.id === st.activeTabId).content;
}

// Presses Ctrl+Z until the note is `target`; returns how many presses it took (gives up after `max`).
async function undoUntil(s, target, max = 4) {
  let presses = 0;
  while ((await noteNow(s)) !== target && presses < max) {
    const before = await noteNow(s);
    await focusEditor(s);
    await s.key('z', { ctrl: true });
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.id === window.__explore.state().activeTabId; })[0].content !== ${JSON.stringify(before)}`, { timeout: 3000 });
    presses++;
  }
  return presses;
}

async function askOnTheLastLine(s, instruction) {
  await focusEditor(s);
  await s.ev("(function () { var e = document.getElementById('editor'); var i = e.value.indexOf('Summarize'); e.setSelectionRange(i, i + 'Summarize this line'.length); })()");
  await openAsk(s);
  await submitAsk(s, instruction);
}

export default {
  title: 'a long many-line answer, RPC write or pasted table lands without freezing the window, in one undo step',
  session: { notes: [{ title: 'notes.md', content: NOTE, cursor: NOTE.length }], llm: { mode: 'ok', delayMs: 100 } },
  timeoutMs: 90000,

  async run(s, t) {
    await s.ev(HEARTBEAT);

    t.step('a short answer, to learn how many Ctrl+Z presses take an answer out');
    await askOnTheLastLine(s, 'short one');
    await waitNote(s, "text.indexOf('Reply 1.') !== -1");
    await waitIdle(s);
    const shortPresses = await undoUntil(s, NOTE);
    assert.equal(await noteNow(s), NOTE, 'the short answer was taken out again');
    assert.ok(shortPresses >= 1, 'Ctrl+Z changed the note');

    t.step(`an AI answer of ${LINES} lines`);
    await s.setLlm({ mode: 'huge', lines: LINES, delayMs: 100 });
    await s.ev(RESET_HEARTBEAT);
    await askOnTheLastLine(s, 'long one');
    await waitNote(s, `text.indexOf('Line ${LINES}:') !== -1`, { timeout: 60000 });
    await waitIdle(s);
    let frozen = await s.ev(READ_HEARTBEAT);
    assert.ok(frozen < MAX_FREEZE_MS, `the page was blocked for ${frozen} ms while the ${LINES}-line answer landed (limit ${MAX_FREEZE_MS} ms)`);
    let text = await noteNow(s);
    const answerLines = text.split('\n').filter((l) => /^Line \d+: the quick brown fox/.test(l));
    assert.equal(answerLines.length, LINES, 'every line of the answer is in the note');
    assert.ok(answerLines[0].startsWith('Line 1:'), 'in order');
    assert.ok(answerLines[LINES - 1].startsWith(`Line ${LINES}:`), 'in order to the end');
    assert.ok(text.startsWith('# Notes\n\n'), 'the text before the question is intact');
    assert.equal((await s.state()).editor.value, text, 'the editor and the tab hold the same text');
    const longPresses = await undoUntil(s, NOTE);
    assert.equal(await noteNow(s), NOTE, 'Ctrl+Z brings back the note as it was before the question');
    assert.equal(longPresses, shortPresses, 'a long answer takes as many Ctrl+Z presses to take out as a short one');

    t.step(`a JSON-RPC append of ${LINES} lines`);
    const before = await noteNow(s);
    await s.ev(`window.__bigText = ${JSON.stringify(bigText(LINES))}; 1`);
    await s.ev(RESET_HEARTBEAT);
    const rpcMs = await s.ev('(function () { var t0 = performance.now(); window.__mdMemoRPC.appendBuffer(window.__bigText); return Math.round(performance.now() - t0); })()');
    await s.waitFor('window.__explore.state().tabs[0].content.length > 1000');
    frozen = await s.ev(READ_HEARTBEAT);
    assert.ok(rpcMs < MAX_FREEZE_MS && frozen < MAX_FREEZE_MS, `the RPC append blocked the page for ${Math.max(rpcMs, frozen)} ms`);
    text = await noteNow(s);
    assert.equal(text, before + bigText(LINES), 'the appended text is exactly what was sent');
    assert.equal(await undoUntil(s, before), 1, 'one Ctrl+Z takes the whole RPC write out');

    t.step(`a pasted table of ${LINES} rows`);
    let rows = '';
    for (let i = 1; i <= LINES; i++) rows += `<tr><td>r${i}</td><td>name ${i}</td></tr>`;
    await s.setBackend({ clipboard: { text: 'id\tname', html: `<table><thead><tr><th>id</th><th>name</th></tr></thead><tbody>${rows}</tbody></table>` } });
    await focusEditor(s);
    await s.ev("(function () { var e = document.getElementById('editor'); e.setSelectionRange(e.value.length, e.value.length); })()");
    await s.ev(RESET_HEARTBEAT);
    await s.key('v', { ctrl: true });
    await s.waitFor(`window.__explore.state().tabs[0].content.indexOf('| r${LINES} |') !== -1`, { timeout: 60000 });
    frozen = await s.ev(READ_HEARTBEAT);
    assert.ok(frozen < MAX_FREEZE_MS, `the page was blocked for ${frozen} ms while the ${LINES}-row table was pasted`);
    text = await noteNow(s);
    assert.equal(text.split('\n').filter((l) => /^\| r\d+ \| name \d+ \|$/.test(l)).length, LINES, 'every row of the table is in the note');
    assert.equal(await undoUntil(s, before), 1, 'one Ctrl+Z takes the pasted table out');
  },
};
