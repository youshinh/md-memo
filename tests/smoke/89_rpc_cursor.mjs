// The JSON-RPC cursor calls of the page (window.__mdMemoRPC.getCursor / setCursor, behind `cursor.get` / `cursor.set`): where the caret
// or selection of a tab is, in UTF-16 offsets into its LF text with 1-based line / column, and moving it without taking the focus
// or moving the caret the person is typing at. A tab on screen is changed in place; another tab only has its remembered caret
// changed (it is brought forward, like getSelection does, only when focus is asked for).
import { assert, click, focusEditor, rpc, shown, waitShown } from './lib.mjs';

// "alpha\nbeta <emoji> gamma\ndelta\n": the emoji is two UTF-16 units, so "gamma" starts at offset 14 on line 2, column 9.
const NOTE_A = 'alpha\nbeta \u{1F600} gamma\ndelta\n';
const NOTE_B = 'one\ntwo\nthree\n';
const NOTE_C = '\nx\n\ny';
const LONG = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');

const live = (s) => s.ev(`(function () {
  var e = document.getElementById('editor');
  return { start: e.selectionStart, end: e.selectionEnd, focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '', scrollTop: e.scrollTop };
})()`);

const activeId = (s) => s.ev('window.__explore.state().activeTabId');

export default {
  title: 'cursor RPC: getCursor / setCursor read and move the caret of any tab without taking the focus or moving the typing position',
  session: {
    notes: [
      { title: 'a.md', content: NOTE_A, cursor: 3 },
      { title: 'b.md', content: NOTE_B, cursor: 5 },
      { title: 'c.md', content: NOTE_C, cursor: 2 },
      { title: 'long.md', content: LONG, cursor: 0 }
    ]
  },
  timeoutMs: 40000,

  async run(s, t) {
    const [A, B, C, L] = ['tab_x1', 'tab_x2', 'tab_x3', 'tab_x4'];
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(A)}`);

    t.step('getCursor of the tab on screen: a caret, then a selection, with UTF-16 offsets and 1-based line / column');
    await focusEditor(s);
    await s.ev("document.getElementById('editor').setSelectionRange(3, 3)");
    let r = await rpc(s, 'getCursor()');
    assert.deepEqual(r.ok, { tabId: A, start: 3, end: 3, hasSelection: false, line: 1, col: 4, endLine: 1, endCol: 4, length: NOTE_A.length });
    await s.ev("document.getElementById('editor').setSelectionRange(14, 19)"); // "gamma"
    r = await rpc(s, `getCursor(${JSON.stringify(A)})`);
    assert.deepEqual(r.ok, { tabId: A, start: 14, end: 19, hasSelection: true, line: 2, col: 9, endLine: 2, endCol: 14, length: NOTE_A.length });
    assert.equal(NOTE_A.slice(14, 19), 'gamma');
    await s.ev(`document.getElementById('editor').setSelectionRange(0, ${NOTE_A.length})`);
    r = await rpc(s, 'getCursor()');
    assert.equal(r.ok.endLine, 4, 'the end of a note that ends with a newline is on the empty last line');
    assert.equal(r.ok.endCol, 1);

    t.step('getCursor of a tab that is not on screen: its remembered caret, collapsed; nothing is selected, focused or scrolled');
    const before = await live(s);
    r = await rpc(s, `getCursor(${JSON.stringify(B)})`);
    assert.deepEqual(r.ok, { tabId: B, start: 5, end: 5, hasSelection: false, line: 2, col: 2, endLine: 2, endCol: 2, length: NOTE_B.length });
    assert.equal(await activeId(s), A, 'the active tab did not change');
    assert.deepEqual(await live(s), before, 'the editor, its selection, its scroll and the focus are as they were');
    // a leading newline: offset 0 is line 1 column 1, not column 0 (lastIndexOf clamps a negative start)
    r = await rpc(s, `getCursor(${JSON.stringify(C)})`);
    assert.deepEqual([r.ok.start, r.ok.line, r.ok.col], [2, 2, 2]);

    t.step('an unknown tab is a not_found error, a bad offset is invalid_params, and nothing moved');
    r = await rpc(s, "getCursor('bogus')");
    assert.equal(r.kind, 'not_found');
    assert.equal(r.err, '[not_found] no such tab: bogus');
    r = await rpc(s, "setCursor('bogus', 1)");
    assert.equal(r.kind, 'not_found');
    r = await rpc(s, `setCursor(${JSON.stringify(A)})`);
    assert.equal(r.kind, 'invalid_params');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 'x')`);
    assert.equal(r.kind, 'invalid_params');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 1, 'y')`);
    assert.equal(r.kind, 'invalid_params');
    assert.equal(await activeId(s), A);

    t.step('setCursor on a tab that is not on screen stores its caret and does not switch, focus or move the typing position');
    await focusEditor(s);
    await s.ev("document.getElementById('editor').setSelectionRange(6, 10)");
    const typing = await live(s);
    r = await rpc(s, `setCursor(${JSON.stringify(B)}, 4, 8)`);
    assert.deepEqual(r.ok, { tabId: B, start: 4, end: 4, line: 2, col: 1 }, 'a tab with no textarea keeps one offset, so the range comes back collapsed');
    assert.equal(await activeId(s), A, 'still the same tab');
    assert.deepEqual(await live(s), typing, 'the user\'s selection, scroll and focus did not move');
    r = await rpc(s, `getCursor(${JSON.stringify(B)})`);
    assert.deepEqual([r.ok.start, r.ok.end, r.ok.line, r.ok.col], [4, 4, 2, 1], 'it reads back');
    // the offset a hidden tab is stored at is what it shows when it is next brought forward
    r = await rpc(s, `setCursor(${JSON.stringify(C)}, 1)`);
    assert.deepEqual([r.ok.start, r.ok.line, r.ok.col], [1, 2, 1], 'a leading newline: offset 1 is the start of line 2');
    r = await rpc(s, `setCursor(${JSON.stringify(C)}, 0)`);
    assert.deepEqual([r.ok.start, r.ok.line, r.ok.col], [0, 1, 1]);
    r = await rpc(s, `setCursor(${JSON.stringify(C)}, 9999)`);
    assert.deepEqual([r.ok.start, r.ok.end], [NOTE_C.length, NOTE_C.length], 'clamped to the text');

    t.step('setCursor on the tab on screen: selection, caret only, clamping, swapping; the focus stays where it was');
    await s.ev("document.getElementById('btn-new-tab').focus()");
    await s.waitFor("document.activeElement && document.activeElement.id === 'btn-new-tab'");
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 14, 19)`);
    assert.deepEqual(r.ok, { tabId: A, start: 14, end: 19, line: 2, col: 9 });
    let l = await live(s);
    assert.deepEqual([l.start, l.end], [14, 19]);
    assert.equal(l.focus, 'btn-new-tab', 'the focus was not taken');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 7)`);
    assert.deepEqual([r.ok.start, r.ok.end], [7, 7], 'a caret only: end defaults to start');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 7, null)`);
    assert.deepEqual([r.ok.start, r.ok.end], [7, 7], 'a null end is the same');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, -5, 9999)`);
    assert.deepEqual([r.ok.start, r.ok.end], [0, NOTE_A.length], 'clamped to the text');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 10, 4)`);
    assert.deepEqual([r.ok.start, r.ok.end], [4, 10], 'start > end is swapped');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 2.9)`);
    assert.equal(r.ok.start, 2, 'a fraction is cut');
    l = await live(s);
    assert.deepEqual([l.start, l.end], [2, 2]);
    assert.equal(l.focus, 'btn-new-tab');
    assert.equal(await s.ev("document.getElementById('stat-cursor').textContent.replace(/\\D+/g, ' ').trim()"), '1 3', 'the status bar shows the new line and column');

    t.step('focus:true takes the focus into the editor');
    r = await rpc(s, `setCursor(${JSON.stringify(A)}, 6, 10, { focus: true })`);
    assert.deepEqual([r.ok.start, r.ok.end], [6, 10]);
    await s.waitFor("document.activeElement && document.activeElement.id === 'editor'");
    l = await live(s);
    assert.deepEqual([l.start, l.end], [6, 10]);

    t.step('scroll: into view by default, left alone with scroll:false, and never a focus change');
    await s.ev(`window.__mdMemoRPC.switchTab(${JSON.stringify(L)})`);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(L)}`);
    await s.ev("document.getElementById('btn-new-tab').focus()");
    const lastLine = LONG.lastIndexOf('line 300');
    r = await rpc(s, `setCursor(${JSON.stringify(L)}, ${lastLine}, undefined, { scroll: false })`);
    assert.equal(r.ok.line, 300);
    l = await live(s);
    assert.equal(l.scrollTop, 0, 'scroll:false does not scroll');
    r = await rpc(s, `setCursor(${JSON.stringify(L)}, ${lastLine})`);
    await s.waitFor("document.getElementById('editor').scrollTop > 1000");
    l = await live(s);
    assert.equal(l.focus, 'btn-new-tab', 'scrolling does not take the focus');
    r = await rpc(s, `setCursor(${JSON.stringify(L)}, 0)`);
    await s.waitFor("document.getElementById('editor').scrollTop < 50");

    t.step('a tab in the split editor is changed in place, with the primary pane left alone');
    await s.ev(`window.__mdMemoRPC.switchTab(${JSON.stringify(A)})`);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(A)}`);
    await click(s, 'btn-toggle-split');
    await waitShown(s, 'secondary-pane');
    // the split shows another tab than the active one: the first of the others
    const secondary = await s.ev("window.__mdMemoRPC.getUiState().secondaryTabId");
    assert.ok(secondary && secondary !== A, 'the split editor shows another tab');
    const secLen = await s.ev("document.getElementById('editor-secondary').value.length");
    await focusEditor(s);
    await s.ev("document.getElementById('editor').setSelectionRange(1, 3)");
    const typing2 = await live(s);
    r = await rpc(s, `setCursor(${JSON.stringify(secondary)}, 2, ${Math.min(5, secLen)})`);
    assert.deepEqual([r.ok.start, r.ok.end], [2, Math.min(5, secLen)], 'a tab on screen keeps its whole range');
    assert.deepEqual(await s.ev("(function () { var e = document.getElementById('editor-secondary'); return [e.selectionStart, e.selectionEnd]; })()"), [2, Math.min(5, secLen)]);
    assert.deepEqual(await live(s), typing2, 'the primary editor\'s selection and the focus are as they were');
    r = await rpc(s, `getCursor(${JSON.stringify(secondary)})`);
    assert.deepEqual([r.ok.start, r.ok.end], [2, Math.min(5, secLen)], 'it is read from the split editor');
    assert.equal(await shown(s, 'secondary-pane'), true);

    t.step('focus:true on a tab that is not on screen brings it forward, as getSelection does, with the range kept');
    await click(s, 'btn-toggle-split');
    await s.waitFor("document.getElementById('secondary-pane').classList.contains('hidden')");
    r = await rpc(s, `setCursor(${JSON.stringify(B)}, 2, 6, { focus: true })`);
    assert.deepEqual([r.ok.start, r.ok.end], [2, 6]);
    assert.equal(await activeId(s), B, 'the tab was brought forward');
    await s.waitFor("document.activeElement && document.activeElement.id === 'editor'");
    l = await live(s);
    assert.deepEqual([l.start, l.end], [2, 6]);
  }
};
