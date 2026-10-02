// Deep search, up to the point where something is sent: the button asks the backend for a PLAN (nothing goes to the AI yet), and the
// confirmation dialog says how many notes and characters go, to which model and host, which secrets were blanked, what was left out and
// the sources. Cancel (and Esc, and the corner button) send nothing; the focus starts on Cancel and an Enter right after the dialog
// appeared is ignored; a cloud host that is not allowed yet shows the question and "Allow and run" saves the answer BEFORE the run asks
// the backend; a plan that already has the answer shows none; a local model never shows it. The backend is the mock (fixed plans).
import { assert, click, lastSavedConfig, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { SEMANTIC_ON, asked, deepKnobs, openDeepDialog, openMeaning, phrase, textOf, visible, waitMeaningList } from './semantic_lib.mjs';

export default {
  title: 'Deep search dialog: what is sent and to whom, Cancel sends nothing, Enter right after it opens is ignored, cloud consent is asked once and saved before the run',
  session: { ...SEMANTIC_ON, notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 60000,

  async run(s, t) {
    const dialogShown = () => shown(s, 'deep-search-modal');
    const facts = () => s.ev("Array.from(document.querySelectorAll('#deep-search-facts > div')).map(function (e) { return e.textContent; })");
    const runCalls = () => asked(s, 'deepSearchRun');
    const planCalls = () => asked(s, 'deepSearchPlan');
    // closes the dialog with Cancel by a real click and checks where the focus went
    const cancelByClick = async () => {
      await click(s, 'deep-search-cancel');
      await waitHidden(s, 'deep-search-modal');
      await waitFocus(s, 'scraps-search-input');
    };

    t.step('Meaning list, then Deep search: the backend is asked for a plan of 10 and the dialog opens with the focus on Cancel');
    await deepKnobs(s, { notes: ['4 hits are older than the index.'] });
    await openMeaning(s, 'bamboo');
    assert.equal(await s.ev("sessionStorage.getItem('md_memo_scraps_search_mode')"), 'meaning', 'the mode is kept for the session');
    await openDeepDialog(s);
    assert.deepEqual(await planCalls(), [['bamboo', 10]]);
    assert.deepEqual(await runCalls(), [], 'nothing was sent to the AI by opening the dialog');
    assert.equal(await shown(s, 'scraps-search-modal'), true, 'the search panel stays behind the dialog');

    t.step('local model: the sentence names the count, the characters and the model; no consent wording; Run, not "Allow and run"');
    const summary = await phrase(s, 'deepSearchSummary', { count: '3', chars: '2,430', dest: await phrase(s, 'deepSearchDestLocal', { model: 'gemma4:latest' }) });
    assert.equal(await textOf(s, '#deep-search-summary'), summary);
    assert.equal(await textOf(s, '#deep-search-query'), await phrase(s, 'deepSearchQuery', { query: 'bamboo' }));
    assert.equal(await s.ev("document.getElementById('deep-search-summary').getAttribute('data-kind')"), 'local');
    assert.equal(await visible(s, 'deep-search-consent'), false, 'a model on this computer is never asked about');
    assert.equal(await textOf(s, '#deep-search-run'), await phrase(s, 'deepSearchRun'));

    t.step('what was blanked out, what was left out, the size, the backend\'s own note; the sources are listed and folded');
    const lines = await facts();
    assert.ok(lines.includes(await phrase(s, 'deepSearchMasked', { n: '2' })), `secrets blanked: ${lines}`);
    assert.ok(lines.includes(await phrase(s, 'deepSearchLeftOut', { list: await phrase(s, 'deepSearchLeftIgnored', { n: '1' }) })), `left out: ${lines}`);
    assert.ok(lines.includes(await phrase(s, 'deepSearchTokens', { tokens: '1,620' })), `size: ${lines}`);
    assert.ok(lines.includes('4 hits are older than the index.'), `the backend's note, as it is: ${lines}`);
    assert.ok(!lines.includes(await phrase(s, 'deepSearchWordsOnly')), 'meaning search worked: no "picked by words" line');
    assert.equal(await s.ev("document.getElementById('deep-search-sources').open"), false, 'the list is folded');
    assert.equal(await textOf(s, '#deep-search-sources-summary'), await phrase(s, 'deepSearchSources', { count: '3' }));
    const sources = await s.ev("Array.from(document.querySelectorAll('#deep-search-source-list li')).map(function (e) { return e.textContent; })");
    assert.equal(sources.length, 3);
    assert.ok(sources[0].includes('2026-09-28 09:00') && sources[0].includes(await phrase(s, 'deepSearchSourceChars', { chars: '800' })), sources[0]);

    t.step('Cancel (a real click): nothing is sent, the focus goes back to the search box, the panel is still open');
    await cancelByClick();
    assert.deepEqual(await runCalls(), []);
    assert.equal(await shown(s, 'scraps-search-modal'), true);

    t.step('the backend fell back to words: the dialog says so; Esc closes ONLY the dialog; the corner button closes it too');
    await deepKnobs(s, { semantic: false, notes: [] });
    await openDeepDialog(s);
    assert.ok((await facts()).includes(await phrase(s, 'deepSearchWordsOnly')));
    await s.key('Escape');
    await waitHidden(s, 'deep-search-modal');
    assert.equal(await shown(s, 'scraps-search-modal'), true, 'one Esc closes one panel');
    await waitFocus(s, 'scraps-search-input');
    await openDeepDialog(s);
    await click(s, 'deep-search-close');
    await waitHidden(s, 'deep-search-modal');
    await waitFocus(s, 'scraps-search-input');
    assert.deepEqual(await runCalls(), [], 'cancelling three times sent nothing');
    await deepKnobs(s, { semantic: true });

    t.step('Ctrl+Enter in the search box is the same as the button');
    await s.key('Enter', { ctrl: true });
    await waitShown(s, 'deep-search-modal');
    await waitFocus(s, 'deep-search-cancel');
    assert.equal((await planCalls()).length, 4);
    await s.key('Escape');
    await waitHidden(s, 'deep-search-modal');

    t.step('an Enter (or Space) right after the dialog appeared is ignored, on Cancel and on Run; a moment later Enter on Cancel cancels');
    await s.ev('window.__docshot.freezeClock(); 1'); // the dialog's 350 ms guard counts on the page's clock: stopped, it has just appeared
    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'deep-search-modal');
    await waitFocus(s, 'deep-search-cancel');
    await s.key('Enter');
    assert.equal(await dialogShown(), true, 'Enter on Cancel, right after it appeared, did not cancel');
    await s.key(' ');
    assert.equal(await dialogShown(), true, 'nor did Space');
    await s.ev("document.getElementById('deep-search-run').focus()");
    await s.key('Enter');
    assert.equal(await dialogShown(), true);
    assert.deepEqual(await runCalls(), [], 'Enter on Run, right after it appeared, ran nothing');
    await s.ev('window.__docshot.unfreezeClock(); window.__t0 = Date.now(); 1');
    await s.waitFor('Date.now() - window.__t0 > 400');
    await s.ev("document.getElementById('deep-search-cancel').focus()");
    await s.key('Enter');
    await waitHidden(s, 'deep-search-modal');
    await waitFocus(s, 'scraps-search-input');
    assert.deepEqual(await runCalls(), []);

    t.step('a plan that comes back after the text was changed opens nothing; while it is prepared the button waits');
    await s.ev(`window.__plans = [];
      window.__origPlan = window.backend.deepSearchPlan;
      window.backend.deepSearchPlan = function (q, limit) {
        return new Promise(function (resolve, reject) {
          window.__plans.push({ q: q, release: async function () {
            window.__origPlan(q, limit).then(resolve, reject);
            for (var i = 0; i < 20; i++) await Promise.resolve();
          } });
        });
      };
      1`);
    await click(s, 'btn-scraps-deep');
    await s.waitFor('window.__plans.length === 1');
    assert.equal(await s.ev("document.getElementById('btn-scraps-deep').disabled"), true, 'the button waits while the plan is prepared');
    assert.equal(await textOf(s, '#btn-scraps-deep'), await phrase(s, 'deepSearchPreparing'));
    await s.ev("document.getElementById('scraps-search-input').focus()"); // (the click left the focus on the button)
    await s.key('s'); // the text changes: what is being prepared is for the old text
    await s.ev('window.__plans[0].release()');
    assert.equal(await dialogShown(), false, 'no dialog for a plan of the old text');
    await s.waitFor("document.getElementById('scraps-search-input').value === 'bamboos'");
    await waitMeaningList(s);
    assert.equal(await s.ev("document.getElementById('btn-scraps-deep').disabled"), false);
    assert.equal(await textOf(s, '#btn-scraps-deep'), await phrase(s, 'deepSearchButton'));
    await s.ev('window.backend.deepSearchPlan = window.__origPlan; 1');

    t.step('a cloud host that is not allowed yet: the sentence names it, the question is shown, the button says "Allow and run"');
    await deepKnobs(s, { local: false, host: 'api.example.com', model: 'gpt-mini', consentGiven: false, hold: true });
    await openDeepDialog(s);
    assert.equal(await s.ev("document.getElementById('deep-search-summary').getAttribute('data-kind')"), 'cloud');
    assert.equal(await textOf(s, '#deep-search-summary'), await phrase(s, 'deepSearchSummary', {
      count: '3', chars: '2,430', dest: await phrase(s, 'deepSearchDestCloud', { model: 'gpt-mini', host: 'api.example.com' })
    }));
    assert.equal(await visible(s, 'deep-search-consent'), true);
    assert.equal(await textOf(s, '#deep-search-consent'), await phrase(s, 'deepSearchConsent', { host: 'api.example.com' }));
    assert.equal(await textOf(s, '#deep-search-run'), await phrase(s, 'deepSearchAllowRun'));
    assert.equal(await visible(s, 'deep-search-modal'), true);

    t.step('Cancel there saves no consent; "Allow and run" saves the host to the settings BEFORE the run is asked of the backend');
    await cancelByClick();
    assert.equal(await s.ev("(MdMemoBridge.getConfig().general.cloudConsent || {})['api.example.com']"), undefined, 'cancelling allowed nothing');
    await openDeepDialog(s);
    // the settings file is slow to answer: the run must wait for it (the backend reads the answer from there and refuses without it)
    await s.ev(`window.__saves = [];
      window.__origSave = window.backend.saveConfig;
      window.backend.saveConfig = function (json) { return new Promise(function (resolve) { window.__saves.push(function () { window.__origSave(json).then(resolve); }); }); };
      1`);
    await click(s, 'deep-search-run');
    await s.waitFor('window.__saves.length === 1');
    assert.deepEqual(await runCalls(), [], 'the run was not asked while the answer was still being written');
    assert.equal(await dialogShown(), true);
    assert.equal(await s.ev("document.getElementById('deep-search-run').disabled"), true, 'a second press cannot start it twice');
    await s.ev('window.__saves.forEach(function (write) { write(); }); window.backend.saveConfig = window.__origSave; 1');
    await waitHidden(s, 'deep-search-modal');
    await waitHidden(s, 'scraps-search-modal');
    const saved = await lastSavedConfig(s);
    assert.match(saved.general.cloudConsent['api.example.com'], /^\d{4}-\d\d-\d\d$/, 'the answer is in the saved settings, under the host');
    const order = await s.ev('window.__docshot.calls.map(function (c) { return c.fn; })');
    assert.ok(order.lastIndexOf('saveConfig') < order.indexOf('deepSearchRun'), 'the settings were written first, then the run was asked');
    const runs = await runCalls();
    assert.equal(runs.length, 1);
    assert.equal(runs[0][0], 'p_mock_' + (await planCalls()).length, 'the run is for the plan that was shown');
    assert.equal(runs[0][1], t.lang);
    await s.ev('window.__docshot.deep.finish(); 1'); // the held run answers: a note appears (the run flows check that)
    await s.waitFor("window.__explore.state().tabs.length === 2");

    t.step('the same host again: the plan says it is allowed, so no question and "Run"');
    await deepKnobs(s, { consentGiven: true, hold: false });
    await openMeaning(s, 'bamboo');
    await openDeepDialog(s);
    assert.equal(await s.ev("document.getElementById('deep-search-summary').getAttribute('data-kind')"), 'cloud', 'still a cloud host');
    assert.equal(await visible(s, 'deep-search-consent'), false);
    assert.equal(await textOf(s, '#deep-search-run'), await phrase(s, 'deepSearchRun'));
    await cancelByClick();
    assert.equal((await runCalls()).length, 1, 'cancelling sent nothing more');
  }
};
