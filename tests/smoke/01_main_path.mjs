// The main path of a day with MD-Memo: a new note, a line typed into it, one question to the AI about that line, the answer landing
// under the line with the change band over it, and the note saved. (UX plan: "new note -> write -> ask -> result -> save".)
import { assert, click, hasWaitingMarker, openAsk, submitAsk, textOf, waitFocus, waitIdle, waitNote } from './lib.mjs';

const LINE = 'Buy oat milk on Friday';
const SAVED_PATH = 'C:\\Users\\demo\\Documents\\notes\\oat-milk.md';

export default {
  title: 'main path: new note, type, ask, answer with the change band, save',
  session: { notes: [{ title: 'existing.md', content: '# Existing\n' }], llm: { mode: 'ok', delayMs: 150 } },

  async run(s, t) {
    t.step('a new note from the + button');
    await click(s, 'btn-new-tab');
    await s.waitFor('window.__explore.state().tabs.length === 2');
    await waitFocus(s, 'editor');

    t.step('type a line');
    await s.type(LINE);
    let st = await s.state();
    const tab = st.tabs[1];
    assert.equal(st.activeTabId, tab.id, 'the new note is the active tab');
    assert.ok(tab.content.includes(LINE), 'the typed line is in the note');
    assert.ok(tab.dirty, 'a note with typed text is marked unsaved');
    assert.equal(st.editor.value, tab.content, 'the editor and the tab hold the same text');
    assert.equal((await s.state()).tabs[0].content, '# Existing\n', 'the other note is untouched');

    t.step('ask about the current line');
    await openAsk(s);
    assert.ok((await textOf(s, 'inline-prompt-target')).trim(), 'the bar says what the question is about');
    await submitAsk(s, 'translate to French');
    await waitNote(s, "text.indexOf('Reply 1.') !== -1");

    t.step('the answer landed under the line');
    st = await s.state();
    const text = st.tabs[1].content;
    assert.equal(text.split(LINE).length - 1, 1, 'the question line is there exactly once');
    assert.ok(text.indexOf(LINE) < text.indexOf('Reply 1.'), 'the answer is below the line');
    assert.ok(!hasWaitingMarker(text), 'no waiting marker is left in the note');
    assert.equal(text.split('Reply 1.').length - 1, 1, 'the answer is in the note once');
    assert.equal(st.panels.ask, false, 'the ask bar closed after the answer');
    assert.equal(st.pendingLlm, 0, 'no AI request is still pending');
    const log = await s.ev('window.__explore.llmLog');
    assert.equal(log.length, 1, 'exactly one AI request was sent');
    assert.ok(log[0].prompt.includes('translate to French') && log[0].prompt.includes(LINE), 'the request carries the instruction and the line');
    assert.equal(log[0].answers.length, 1, 'the request was answered once');

    t.step('the change band marks the answer');
    await s.waitFor("document.querySelectorAll('.ghost-diff-band').length > 0");
    const geo = await s.ev(`(function () {
      var ed = document.getElementById('editor');
      var c = window.getCharPixelCoords(ed.value.indexOf('Reply 1.'), ed);
      var lh = parseFloat(getComputedStyle(ed).lineHeight);
      var bands = Array.prototype.map.call(document.querySelectorAll('.ghost-diff-band'), function (b) { return { top: parseFloat(b.style.top), height: b.offsetHeight, parent: b.parentElement && b.parentElement.id }; });
      return { rowTop: c.top, lh: lh, bands: bands };
    })()`);
    assert.equal(geo.bands.length, 1, 'one band');
    const band = geo.bands[0];
    assert.equal(band.parent, 'editor-wrapper', 'the band lives in the editor wrapper');
    assert.ok(Math.abs(band.top - geo.rowTop) <= geo.lh / 2, `the band starts at the answer's row (band ${band.top}px, row ${geo.rowTop}px)`);
    assert.ok(band.height >= geo.lh * 0.9 && band.height <= geo.lh * 3, `the band covers the answer only (${band.height}px for a ${geo.lh}px line)`);

    t.step('save the note');
    await s.setBackend({ saveFileAs: { result: { path: SAVED_PATH, title: 'oat-milk.md', success: true } } });
    await s.key('s', { ctrl: true });
    await s.waitFor(`(function () { var st = window.__explore.state(); return st.tabs.length === 2 && !st.tabs[1].dirty && st.tabs[1].path === ${JSON.stringify(SAVED_PATH)}; })()`);
    st = await s.state();
    assert.equal(st.tabs[1].title, 'oat-milk.md', 'the tab takes the file name');
    assert.ok(st.toasts.some((m) => m.includes('oat-milk.md')), `a message names the saved file: ${JSON.stringify(st.toasts)}`);
    await waitIdle(s);
  },
};
