// Deep search, from "Run" to the note: the run is a background task (listed, cancellable) that ends in ONE new unsaved tab holding the
// answer, with the search panel gone and a toast; a cancelled run creates nothing, any other failure is one line and creates nothing;
// the codes the backend answers with (consent_required, plan_expired, model_not_configured) lead back to the right question; without a
// text model there is no dialog, only the way to set one up. The backend is the mock (tools/docshots/mock/backend.js).
import { assert, clickSelector, click, rpc, waitHidden, waitShown } from './lib.mjs';
import { SEMANTIC_ON, asked, deepKnobs, openDeepDialog, openMeaning, phrase, textOf, visible, waitMeaningList } from './semantic_lib.mjs';

export default {
  title: 'Deep search run: one new unsaved tab and a toast, a task that can be cancelled, nothing created on cancel or failure, the backend\'s codes lead back to the right question',
  session: { ...SEMANTIC_ON, notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 90000,

  async run(s, t) {
    const TITLE = t.pick('Deep search bamboo.md', '深掘り 竹の話.md');
    const tabs = async () => (await s.state()).tabs;
    const tasks = () => s.ev('window.TaskManager.snapshot()');
    const runCalls = () => asked(s, 'deepSearchRun');
    const planCalls = () => asked(s, 'deepSearchPlan');
    const toasts = () => s.ev('window.__explore.toasts.map(function (x) { return x.text; })');
    const waitRuns = (n) => s.waitFor(`window.__docshot.calls.filter(function (c) { return c.fn === 'deepSearchRun'; }).length === ${n}`);
    const waitTask = (status) => s.waitFor(`window.TaskManager.snapshot().running.length === 0 && window.TaskManager.snapshot().recent.length > 0 && window.TaskManager.snapshot().recent[0].status === ${JSON.stringify(status)}`);
    const failedPrefix = await phrase(s, 'deepSearchFailed', { message: '' });
    // Meaning list -> Deep search -> Run (a real click on the dialog's button); the search panel and the dialog are gone afterwards
    // (a run that is refused with a code the screen answers by asking again shows the dialog again within a moment: there is no
    // closed dialog to wait for then, so those steps ask only for the panel to be gone)
    const startRun = async ({ asksAgain = false } = {}) => {
      await openMeaning(s, 'bamboo');
      await openDeepDialog(s);
      await click(s, 'deep-search-run');
      if (!asksAgain) await waitHidden(s, 'deep-search-modal');
      await waitHidden(s, 'scraps-search-modal');
    };

    t.step('Run: the task is listed, then ONE new unsaved note holds the answer, is selected with the focus, the panel is gone, a toast says so');
    await startRun();
    await waitRuns(1);
    const firstRun = (await runCalls())[0];
    assert.equal(firstRun[0], 'p_mock_1');
    assert.equal(firstRun[1], t.lang, 'the answer is asked for in the language of the screen');
    await s.waitFor('window.__explore.state().tabs.length === 2');
    const created = (await tabs()).find((tab) => tab.title === TITLE);
    assert.ok(created, `a tab named ${TITLE}: ${JSON.stringify((await tabs()).map((x) => x.title))}`);
    assert.equal((await tabs()).length, 2, 'exactly one tab was added');
    assert.equal(created.path, '', 'it is not a file');
    assert.equal(created.dirty, true, 'it is unsaved, so closing it asks first');
    assert.ok(created.content.startsWith('<!-- md-memo:deepsearch -->\n# '), created.content);
    assert.equal((await s.state()).activeTabId, created.id, 'it is the selected tab');
    assert.deepEqual(await s.ev("({ id: document.activeElement.id, start: document.getElementById('editor').selectionStart, same: document.getElementById('editor').value === window.__explore.state().tabs.filter(function (x) { return x.title === " + JSON.stringify(TITLE) + "; })[0].content })"),
      { id: 'editor', start: 0, same: true }, 'the editor has the focus, with the caret at the top of the answer');
    assert.ok((await toasts()).includes(await phrase(s, 'deepSearchDone')), 'the toast says it was written to a new note');
    assert.deepEqual(await asked(s, 'saveFile'), [], 'nothing was saved to a file');
    assert.deepEqual(await asked(s, 'saveFileAs'), []);
    const done = await tasks();
    assert.deepEqual([done.running.length, done.recent[0].kind, done.recent[0].status, done.recent[0].label], [0, 'deepsearch', 'completed', await phrase(s, 'deepSearchButton')]);

    t.step('a run that is cancelled (the backend says "cancelled") creates nothing and is not an error');
    await deepKnobs(s, { runReject: 'cancelled' });
    await startRun();
    await waitRuns(2);
    await waitTask('canceled');
    assert.equal((await tabs()).length, 2);
    assert.ok(!(await toasts()).some((x) => x.startsWith(failedPrefix)), 'no failure message for a cancel');

    t.step('another failure: one line, nothing created, the task says why');
    await deepKnobs(s, { runReject: 'embedding service exploded\n  second line of the same failure' });
    await startRun();
    await waitRuns(3);
    await s.waitFor("window.__explore.toasts.some(function (x) { return x.text.indexOf('exploded') !== -1; })");
    const failure = (await toasts()).filter((x) => x.includes('exploded')).pop();
    assert.equal(failure, await phrase(s, 'deepSearchFailed', { message: 'embedding service exploded second line of the same failure' }));
    assert.equal((await tabs()).length, 2);
    await waitTask('failed');
    assert.ok((await tasks()).recent[0].error.includes('exploded'));

    t.step('a long run is a task: listed while it runs, and Cancel in the task list calls cancelDeepSearch for its plan and creates nothing');
    await deepKnobs(s, { runReject: '', hold: true });
    await startRun();
    await waitRuns(4);
    const running = (await tasks()).running;
    assert.equal(running.length, 1);
    assert.deepEqual([running[0].kind, running[0].label, running[0].cancellable], ['deepsearch', await phrase(s, 'deepSearchButton'), true]);
    await s.ev('window.TaskManager.showPanel(); 1');
    await clickSelector(s, `.btn-task-cancel[data-cancel-id="${running[0].id}"]`);
    await waitTask('canceled');
    assert.deepEqual((await asked(s, 'cancelDeepSearch')).map((a) => a[0]), [(await runCalls())[3][0]], 'the backend was told which plan to drop');
    assert.deepEqual(await asked(s, 'cancelSlotAgent'), [], 'a deep search is not a slot agent: nothing asked it to stop');
    assert.equal((await tabs()).length, 2);
    await s.ev('window.TaskManager.hidePanel(); 1');

    t.step('an answer that arrives after the task was cancelled is thrown away');
    await s.ev(`window.__origCancel = window.backend.cancelDeepSearch;
      window.backend.cancelDeepSearch = function () { return Promise.resolve(null); }; // this backend cannot stop the request: its answer still comes
      1`);
    await startRun();
    await waitRuns(5);
    const late = (await tasks()).running[0];
    assert.deepEqual((await rpc(s, `cancelTask(${JSON.stringify(late.id)})`)).ok, { cancelled: true });
    await s.ev('window.__docshot.deep.finish(); (async function () { for (var i = 0; i < 20; i++) await Promise.resolve(); return 1; })()');
    assert.equal((await tabs()).length, 2, 'the late answer made no note');
    await s.ev('window.backend.cancelDeepSearch = window.__origCancel; 1');
    await deepKnobs(s, { hold: false });

    t.step('no text model: no dialog, the same words as the ask bar and a button to set one up, which closes the panel and opens the settings');
    await deepKnobs(s, { modelConfigured: false });
    await openMeaning(s, 'bamboo');
    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'scraps-search-status');
    assert.equal(await textOf(s, '#scraps-search-status-text'), await phrase(s, 'askSetupNeeded'));
    assert.equal(await textOf(s, '#btn-scraps-status-action'), await phrase(s, 'askSetupButton'));
    assert.equal(await visible(s, 'deep-search-modal'), false);
    assert.equal((await runCalls()).length, 5, 'nothing was run');
    await click(s, 'btn-scraps-status-action');
    await waitShown(s, 'settings-modal');
    await waitHidden(s, 'scraps-search-modal');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');
    await deepKnobs(s, { modelConfigured: true });

    t.step('the plan cannot be made (an error), or finds no note: one line under the header, no dialog; typing clears it');
    await deepKnobs(s, { planReject: 'embedding model unreachable' });
    await openMeaning(s, 'bamboo');
    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'scraps-search-status');
    assert.equal(await textOf(s, '#scraps-search-status-text'), await phrase(s, 'deepSearchFailed', { message: 'embedding model unreachable' }));
    assert.equal(await visible(s, 'deep-search-modal'), false);
    await s.ev("document.getElementById('scraps-search-input').focus()");
    await s.key('s');
    await waitHidden(s, 'scraps-search-status');
    await waitMeaningList(s);
    await deepKnobs(s, { planReject: '', sources: 0 });
    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'scraps-search-status');
    assert.equal(await textOf(s, '#scraps-search-status-text'), await phrase(s, 'deepSearchNoSources'));
    assert.equal(await visible(s, 'deep-search-modal'), false);
    await deepKnobs(s, { sources: 3 });

    t.step('consent_required from the run: nothing was sent, the dialog comes back with the question, and "Allow and run" runs it');
    await deepKnobs(s, { local: false, host: 'api.example.com', model: 'gpt-mini', consentGiven: true, runReject: 'consent_required' });
    await s.key('Escape');
    await waitHidden(s, 'scraps-search-modal');
    await startRun({ asksAgain: true });
    await waitRuns(6);
    await waitShown(s, 'deep-search-modal');
    assert.equal(await visible(s, 'deep-search-consent'), true, 'the question is asked, though the plan said the host was allowed');
    assert.equal(await textOf(s, '#deep-search-run'), await phrase(s, 'deepSearchAllowRun'));
    await waitTask('failed');
    assert.equal((await tabs()).length, 2);
    await deepKnobs(s, { runReject: '' });
    await s.waitFor("document.activeElement && document.activeElement.id === 'deep-search-cancel'");
    await click(s, 'deep-search-run');
    await waitHidden(s, 'deep-search-modal');
    await waitRuns(7);
    await s.waitFor('window.__explore.state().tabs.length === 3');
    assert.match((await s.ev("MdMemoBridge.getConfig().general.cloudConsent['api.example.com']")), /^\d{4}-\d\d-\d\d$/);

    t.step('plan_expired from the run: the plan is made again from the same text and the dialog asks again');
    await deepKnobs(s, { local: true, consentGiven: false, runReject: 'plan_expired' });
    const plansBefore = (await planCalls()).length;
    await startRun({ asksAgain: true });
    await waitRuns(8);
    await waitShown(s, 'deep-search-modal');
    assert.equal((await planCalls()).length, plansBefore + 2, 'a second plan was asked for (the first one was shown, then used up)');
    assert.equal((await planCalls()).pop()[0], 'bamboo', 'for the same text');
    assert.equal((await tabs()).length, 3);
    await deepKnobs(s, { runReject: '' });
    await click(s, 'deep-search-run');
    await waitHidden(s, 'deep-search-modal');
    await s.waitFor('window.__explore.state().tabs.length === 4');

    t.step('model_not_configured from the run: the ask bar\'s words as a toast, nothing created');
    await deepKnobs(s, { runReject: 'model_not_configured' });
    await startRun();
    await waitRuns(10);
    await s.waitFor(`window.__explore.toasts.filter(function (x) { return x.text === ${JSON.stringify(await phrase(s, 'askLlmNotConfigured'))}; }).length > 0`);
    assert.equal((await tabs()).length, 4);
  }
};
