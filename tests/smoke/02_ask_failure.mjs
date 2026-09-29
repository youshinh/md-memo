// An AI request that fails: the note is left exactly as it was, the ask bar stays open with the input kept and says why in plain
// words (the raw error only under "Details"), and Retry works. Escape leaves no stale failure behind. (UX review D1.)
import { assert, click, hasWaitingMarker, openAsk, submitAsk, selectInEditor, shown, textOf, waitHidden, waitNote, waitShown, settle } from './lib.mjs';

const NOTE = '# Team sync\n\nLaunch date is still open.\nBeta invites keep bouncing.\n';

export default {
  title: 'ask failure: banner, note untouched, retry works',
  session: { notes: [{ title: 'sync.md', content: NOTE }], llm: { mode: 'fail', delayMs: 100 } },

  async run(s, t) {
    t.step('ask with a model that cannot be reached');
    await selectInEditor(s, 'Launch date is still open.');
    await openAsk(s);
    await submitAsk(s, 'make it shorter');
    await waitShown(s, 'inline-prompt-error');

    t.step('the banner says why, the note is untouched');
    let st = await s.state();
    const banner = (await textOf(s, 'inline-prompt-error-text')).trim();
    assert.ok(banner.length > 0, 'the banner has a message');
    assert.ok(!/connectex|dial tcp|\[LLM error/i.test(banner), `the banner is plain words, not the raw error: "${banner}"`);
    assert.ok((await textOf(s, 'inline-prompt-error-detail')).trim().length > 0, 'the raw error is kept under Details');
    assert.equal(st.tabs[0].content, NOTE, 'the note text is exactly as before');
    assert.equal(st.editor.value, NOTE, 'the editor shows the same text');
    assert.ok(!hasWaitingMarker(st.tabs[0].content) && !/connectex|dial tcp/i.test(st.tabs[0].content), 'no marker or error text is written into the note');
    assert.equal(st.panels.ask, true, 'the ask bar stays open');
    assert.equal(await s.ev("document.getElementById('inline-prompt-input').value"), 'make it shorter', 'the typed instruction is kept');
    assert.equal(await shown(s, 'btn-inline-prompt-retry'), true, 'Retry is offered (it is inside the visible banner)');
    assert.equal(st.pendingLlm, 0, 'no request is left pending');
    assert.equal((await s.ev('window.__explore.llmLog')).length, 1, 'one request was sent');

    t.step('Escape closes the bar and the note is still untouched');
    await s.key('Escape');
    await waitHidden(s, 'inline-prompt-bar');
    assert.equal((await s.state()).tabs[0].content, NOTE);

    t.step('reopened, no stale failure is shown');
    await openAsk(s);
    assert.equal(await shown(s, 'inline-prompt-error'), false, 'the old failure banner is gone');

    t.step('fail again, then Retry with a working model');
    await submitAsk(s, 'make it shorter');
    await waitShown(s, 'inline-prompt-error');
    await s.setLlm({ mode: 'ok', delayMs: 100 });
    await click(s, 'btn-inline-prompt-retry');
    await waitNote(s, "/Reply \\d+\\./.test(text)");
    await waitHidden(s, 'inline-prompt-bar');
    await settle();
    st = await s.state();
    assert.equal(st.tabs[0].content.split(/Reply \d+\./).length - 1, 1, 'the answer is in the note once');
    assert.ok(st.tabs[0].content.includes('Launch date is still open.'), 'the original line is still there');
    assert.ok(!hasWaitingMarker(st.tabs[0].content), 'no waiting marker is left');
    assert.equal(st.pendingLlm, 0);
    assert.equal((await s.ev('window.__explore.llmLog')).length, 3, 'three requests in all: fail, fail, retry');
  },
};
