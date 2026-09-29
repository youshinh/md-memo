// No AI model set up (a cloud model without a key): the status bar says so, Ctrl+L still opens the bar with a plain "not set up"
// note and a Set up button, Enter sends nothing and the note stays as it was, and Set up leads to Settings > AI Models.
// (UX review D3 and A2.)
import { assert, click, openAsk, submitAsk, selectInEditor, shown, waitShown, waitHidden, settle } from './lib.mjs';

const NOTE = 'banana\napple\ncherry\n';

export default {
  title: 'ask without a model: setup note, nothing sent, Set up opens AI Models',
  session: {
    notes: [{ title: 'fruit.md', content: NOTE }],
    config: { text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: '' } },
  },

  async run(s, t) {
    t.step('the status bar item says no model is set up');
    const cls = await s.ev("document.getElementById('stat-ai').className");
    assert.ok(/status-ai-unset/.test(cls), `the AI item is in its "not set up" state: ${cls}`);

    t.step('Ctrl+L opens the bar with the setup note');
    await selectInEditor(s, 'banana');
    await openAsk(s);
    assert.equal(await shown(s, 'inline-prompt-setup'), true, 'the "no model" note is shown');
    assert.equal(await shown(s, 'btn-inline-prompt-setup'), true, 'the Set up button is there');
    assert.equal(await shown(s, 'inline-prompt-error'), false, 'it is not shown as a failure');

    t.step('Enter sends nothing and leaves the note alone');
    await submitAsk(s, 'translate');
    await settle(400);
    const st = await s.state();
    assert.equal((await s.ev('window.__explore.llmLog')).length, 0, 'no request was sent');
    assert.equal(st.tabs[0].content, NOTE, 'the note is exactly as before');
    assert.equal(st.pendingLlm, 0);
    assert.equal(st.panels.ask, true, 'the bar stays open');

    t.step('Set up opens Settings on the AI Models tab');
    await click(s, 'btn-inline-prompt-setup');
    await waitShown(s, 'settings-modal');
    assert.equal(await s.ev("document.getElementById('tab-btn-model').classList.contains('active')"), true, 'the AI Models tab is the open one');
    assert.equal(await shown(s, 'inline-prompt-bar'), false, 'the ask bar got out of the way');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('the status bar item goes to the same place');
    await click(s, 'stat-ai');
    await waitShown(s, 'settings-modal');
    assert.equal(await s.ev("document.getElementById('tab-btn-model').classList.contains('active')"), true, 'AI Models again');
    assert.equal(await shown(s, 'status-ai-pop'), false, 'there is no popover to switch anything yet');
  },
};
