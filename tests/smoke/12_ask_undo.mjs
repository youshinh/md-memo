// Ctrl+Z after an answer: whatever the number of steps, undo must bring back the note as it was before the question - never a
// half state, never lose the person's own text. Today the FIRST Ctrl+Z only takes the answer out and leaves the "[AI Generating: ...]"
// waiting marker in the note; a second Ctrl+Z is needed (UX review D5, "the anchor and the result should be one undo step").
// The data-safety part is checked hard; the one-step part is a known issue that turns into a notice when it gets fixed.
import { assert, hasWaitingMarker, openAsk, submitAsk, focusEditor, waitNote, waitIdle } from './lib.mjs';

const LINE = 'Buy oat milk on Friday';
const NOTE = `# Shopping\n\n${LINE}`;

// One Ctrl+Z, and wait until the note changed (an undo that changes nothing is a failure of this flow, not a silent pass).
async function undoOnce(s) {
  const before = (await s.state()).tabs[0].content;
  await s.key('z', { ctrl: true });
  await s.waitFor(`window.__explore.state().tabs[0].content !== ${JSON.stringify(before)}`, { timeout: 2000 });
}

export default {
  title: 'ask, then Ctrl+Z: the note comes back as it was (one step is a known issue)',
  session: { notes: [{ title: 'shop.md', content: NOTE, cursor: NOTE.length }], llm: { mode: 'ok', delayMs: 120 } },

  async run(s, t) {
    t.step('ask about the last line');
    await focusEditor(s);
    await s.ev("(function () { var e = document.getElementById('editor'); e.setSelectionRange(e.value.length, e.value.length); })()");
    await openAsk(s);
    await submitAsk(s, 'translate');
    await waitNote(s, "text.indexOf('Reply 1.') !== -1");
    await waitIdle(s);
    assert.ok((await s.state()).tabs[0].content.startsWith(NOTE), 'the answer arrived under the line');

    t.step('Ctrl+Z once');
    await focusEditor(s);
    await s.key('z', { ctrl: true });
    await s.waitFor("window.__explore.state().tabs[0].content.indexOf('Reply 1.') === -1");
    let text = (await s.state()).tabs[0].content;
    assert.ok(text.startsWith(NOTE), 'the person\'s own text is intact after one undo');
    await t.knownIssue('UX review D5: the first Ctrl+Z leaves the [AI Generating: ...] marker in the note (it takes a second Ctrl+Z)', async () => {
      assert.ok(!hasWaitingMarker(text), `one Ctrl+Z should take back the whole answer, but the note is ${JSON.stringify(text)}`);
    });

    t.step('Ctrl+Z as many times as it takes: exactly the note from before the question');
    for (let i = 0; i < 3 && (await s.state()).tabs[0].content !== NOTE; i++) await undoOnce(s);
    text = (await s.state()).tabs[0].content;
    assert.equal(text, NOTE, 'the note is back to what it was before the question');
    assert.ok(!hasWaitingMarker(text) && !text.includes('Reply 1.'));
    assert.equal((await s.state()).pendingLlm, 0);
  },
};
