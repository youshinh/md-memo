// Lessons: a finished agent run becomes a short rule the person approves (frontend/js/lessons.js; docs/design/lessons-2026-10.md section 7). The
// backend is the mock (tools/docshots/mock/backend.js: lessonPlan / lessonRun / cancelLesson / lessonSave / lessonsInfo, with knobs on
// window.__docshot.lessons and addCard to put a card in the task list).
//   - a failed or completed agent card has the Lessons button; a running, canceled or never-started one has none; a real run that ends with
//     lessonsApplied / lessonsSkipped shows the line on its card
//   - the button opens the dialog: what will be sent (counts, blanked secrets), to whom, a note; nothing goes to the model before Create
//   - a proposal: edit one rule, untick the other, Save: the mock gets the edited rule only, the status line says so, Esc closes one panel
//   - a cloud host: the box has to be ticked, the answer is saved BEFORE the model is asked, Create waits for it
//   - no model set up, nothing worth keeping (and ask again with a note), cancel while the model works, a failure, an expired plan,
//     a host the backend does not know as allowed, a save that fails
//   - the palette entry opens the lessons file as a tab (one agent) or after a small picker (several); nothing with an older backend
import { activeTab, assert, click, clickSelector, openPalette, paletteTitles, settle, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { asked, phrase, textOf, visible } from './semantic_lib.mjs';

const NOTE = '{{ @cc fix the build }}\n';
const RUN_OUTPUT = 'cc1: fatal error: ADF.h: No such file or directory\ncompilation terminated.';

export default {
  title: 'lessons: the card button, the dialog (what is sent and to whom), propose, edit, save, cloud consent, no model, nothing found, cancel, failures, the lessons file from the palette, an older backend',
  session: { notes: [{ title: 'a.md', content: NOTE }] },
  timeoutMs: 150000,

  async run(s, t) {
    const word = t.pick('lessons', '教訓');
    const knobs = (patch) => s.ev(`Object.assign(window.__docshot.lessons, ${JSON.stringify(patch)}); 1`);
    const lessons = (expr) => s.ev(`window.__docshot.lessons.${expr}`);
    const waitStatus = (text) => s.waitFor(`window.__explore.state().statusText === ${JSON.stringify(text)}`);
    const val = (id) => s.ev(`document.getElementById(${JSON.stringify(id)}).value`);
    const sel = (id) => `#tasks-panel-list [data-lessons-id="${id}"]`;
    const buttons = () => s.ev("Array.from(document.querySelectorAll('#tasks-panel-list .btn-task-lessons')).map(function (b) { return b.getAttribute('data-lessons-id'); })");
    const activeId = () => s.ev('document.activeElement && document.activeElement.id');
    const addCard = (opts) => s.ev(`window.__docshot.lessons.addCard(${JSON.stringify(opts)})`);
    const runs = () => lessons('runs.length');
    const plans = () => lessons('plans');
    const tabs = async () => (await s.state()).tabs;

    // phases of the dialog, told by what is on screen
    const waitReady = () => waitShown(s, 'lesson-prepare');
    const waitResult = () => waitShown(s, 'lesson-result');
    const banner = () => textOf(s, '#lesson-banner');
    const openFor = async (id) => {
      if (!(await visible(s, 'running-tasks-panel'))) { // (Esc in Settings, which this flow visits once, also closes the task panel behind it)
        await s.key('t', { alt: true });
        await waitShown(s, 'running-tasks-panel');
      }
      await clickSelector(s, sel(id));
      await waitShown(s, 'lesson-modal');
    };
    // Esc closes the dialog and only the dialog: the task panel stays, and the focus is on the card's Lessons button again
    const closeWithEsc = async (id) => {
      await s.key('Escape');
      await waitHidden(s, 'lesson-modal');
      assert.equal(await visible(s, 'running-tasks-panel'), true, 'one Esc closes one panel: the task panel is still there');
      if (id) await s.waitFor(`!!document.activeElement && document.activeElement.getAttribute('data-lessons-id') === ${JSON.stringify(id)}`);
    };

    t.step('a failed and a completed agent card have the Lessons button; a running, a canceled and a never-started one have none');
    await addCard({ id: 'c-canceled', status: 'canceled' });
    await addCard({ id: 'c-nostart', status: 'failed', error: 'the program is not installed', noResult: true });
    await addCard({ id: 'c-done', status: 'completed', output: 'built with warnings', lessonsApplied: 1 });
    await addCard({ id: 'c-failed', status: 'failed', lessonsSkipped: 3 });
    await addCard({ id: 'c-running', status: 'running' });
    await s.key('t', { alt: true });
    await waitShown(s, 'running-tasks-panel');
    await s.waitFor("document.querySelectorAll('#tasks-panel-list .btn-task-lessons').length > 0");
    assert.deepEqual((await buttons()).sort(), ['c-done', 'c-failed'], 'only the failed and the completed run');
    assert.equal(await s.ev("document.querySelectorAll('#tasks-panel-list .task-card-running .btn-task-lessons').length"), 0, 'none on the running card');
    assert.equal(await textOf(s, `${sel('c-failed')} span`), await phrase(s, 'taskLessonsButton'));
    assert.equal(await s.ev(`document.querySelector(${JSON.stringify(sel('c-failed'))}).title`), await phrase(s, 'taskLessonsTitle'));
    assert.equal(await s.ev(`document.querySelectorAll(${JSON.stringify(sel('c-failed') + ' svg')}).length`), 1, 'a line-art icon, no emoji');

    t.step('the card says how many lessons went into the run: applied, and the ones that did not fit; nothing when there is none');
    const lineOf = (id) => s.ev(`(function () { var b = document.querySelector(${JSON.stringify(sel(id))}); var l = b && b.parentElement.querySelector('.task-lessons-line'); return l ? l.textContent : null; })()`);
    assert.equal(await lineOf('c-done'), await phrase(s, 'taskLessonsAppliedOne', { n: 1 }));
    assert.equal(await lineOf('c-failed'), await phrase(s, 'taskLessonsSkipped', { n: 3 }));
    assert.equal(await s.ev('typeof window.Lessons'), 'undefined', 'nothing of the dialog is loaded until a button is pressed');
    assert.equal(await s.ev("Array.from(document.scripts).some(function (x) { return /lessons\\.js/.test(x.src); })"), false);

    t.step('a real run: the result of the backend (lessonsApplied / lessonsSkipped) shows on its card, and the button works from what the run left');
    await s.ev("(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(5, 5); })()");
    await s.key('Enter', { ctrl: true });
    await s.waitFor('window.__docshot.slotRuns.length > 0');
    const run = await s.ev('window.__docshot.slotRuns[0]');
    await s.ev(`window.__onSlotAgentResult({ reqId: ${JSON.stringify(run.reqId)}, type: 'slot', status: 'failed', exitCode: 1, errorMsg: 'Exit Code 1', output: ${JSON.stringify(RUN_OUTPUT)}, outputMode: 'below', lessonsApplied: 2, lessonsSkipped: 1 }); 1`);
    await s.waitFor(`!!document.querySelector(${JSON.stringify(sel(run.reqId))})`);
    assert.equal(await lineOf(run.reqId), `${await phrase(s, 'taskLessonsApplied', { n: 2 })} \u00b7 ${await phrase(s, 'taskLessonsSkipped', { n: 1 })}`, 'both numbers, on one line');

    t.step('the button opens the dialog: the agent, the start of the instruction, what is sent and to whom; nothing is asked of the model yet');
    await openFor(run.reqId);
    await waitReady();
    await waitFocus(s, 'lesson-note');
    assert.equal(await s.ev('typeof window.Lessons'), 'object', 'loaded by the press');
    assert.equal(await textOf(s, '#lesson-agent'), 'claude-code', 'the agent the run used');
    assert.equal(await textOf(s, '#lesson-context'), 'fix the build', 'the start of the instruction');
    const request = (await plans())[0];
    assert.deepEqual(request, { agent: 'claude-code', instruction: 'fix the build', output: RUN_OUTPUT, error: 'Exit Code 1', exit_code: 1, note: '', lang: t.pick('en', 'ja') }, 'the plan is asked for with what the card holds');
    const fmt = (n) => String(n);
    assert.equal(await textOf(s, '#lesson-sent'), await phrase(s, 'lessonsSent', { instruction: fmt(13), output: fmt(RUN_OUTPUT.length), error: fmt(11) }));
    assert.equal(await textOf(s, '#lesson-masked'), await phrase(s, 'lessonsMaskedOne', { n: '1' }), 'the number of blanked secrets');
    assert.equal(await textOf(s, '#lesson-dest'), await phrase(s, 'lessonsDestLocal', { model: 'gemma4:e2b' }), 'a model on this PC');
    assert.equal(await s.ev("document.getElementById('lesson-dest').getAttribute('data-kind')"), 'local');
    assert.equal(await visible(s, 'lesson-consent-row'), false, 'a model on this PC is never asked about');
    assert.equal(await textOf(s, '#lesson-existing'), await phrase(s, 'lessonsExisting', { agent: 'claude-code', n: '3' }));
    assert.equal(await textOf(s, '#lesson-primary'), await phrase(s, 'lessonsCreate'));
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false);
    assert.equal(await textOf(s, '#lesson-hint'), await phrase(s, 'lessonsHintReady', { mod: 'Ctrl' }));
    assert.equal(await runs(), 0, 'opening the dialog sends nothing to the model');
    assert.equal(await s.ev("document.getElementById('lesson-card').getAttribute('role')"), 'dialog');

    t.step('the editor\'s shortcuts stand back while the dialog is up: Ctrl+L and Ctrl+K open nothing behind it');
    for (const k of ['l', 'k']) await s.key(k, { ctrl: true });
    await settle(300);
    assert.equal(await s.ev("['inline-prompt-bar', 'cli-filter-bar'].some(function (id) { var e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); })"), false);
    assert.equal(await visible(s, 'lesson-modal'), true);

    t.step('Esc closes the dialog and nothing else, sends nothing, and the focus is on the same card\'s button (the list is rebuilt while a task runs)');
    await closeWithEsc(run.reqId);
    assert.equal(await runs(), 0);
    assert.equal(await visible(s, 'lesson-modal'), false);
    assert.deepEqual(await lessons('cancels'), [], 'nothing was started, so there is nothing to cancel');
    await s.ev('TaskManager.cancelTask("c-running"); 1'); // the list is calm from here on

    t.step('a typed note keeps the dialog open when the dimmed window is pressed; with no note the same press closes it');
    await openFor(run.reqId);
    await waitReady();
    await s.type('the header is missing');
    await s.page.click(8, 300);
    await settle(300);
    assert.equal(await visible(s, 'lesson-modal'), true, 'what was typed is not lost to a stray press');
    assert.equal(await val('lesson-note'), 'the header is missing');
    await s.key('a', { ctrl: true });
    await s.key('Backspace');
    await s.page.click(8, 300);
    await waitHidden(s, 'lesson-modal');

    t.step('Create: the note is part of what is sent, so the plan is made again with it; then the model proposes two rules, both ticked, each in a field');
    await openFor(run.reqId);
    await waitReady();
    await s.type('the header is missing');
    assert.equal(await textOf(s, '#lesson-sent-note'), await phrase(s, 'lessonsSentNote', { n: '21' }), 'the note is counted as it will be sent');
    const plansBefore = (await plans()).length;
    await s.key('Enter', { ctrl: true }); // Ctrl+Enter is the main button
    await waitResult();
    assert.equal((await plans()).length, plansBefore + 1, 'a new plan, made with the note');
    assert.equal((await plans())[plansBefore].note, 'the header is missing');
    assert.equal(await runs(), 1, 'the model was asked once');
    assert.equal(await s.ev("document.querySelectorAll('#lesson-rules .lesson-rule').length"), 2);
    assert.equal(await val('lesson-rule-input-0'), 'Do not include ADF.h: the build fails on this machine.');
    assert.equal(await val('lesson-rule-input-1'), 'Run the build with --no-color: the log is read by a program.');
    assert.equal(await s.ev("Array.from(document.querySelectorAll('.lesson-rule-check')).map(function (b) { return b.checked; }).join()"), 'true,true');
    assert.equal(await textOf(s, '#lesson-primary'), await phrase(s, 'btnSave'));
    assert.equal(await textOf(s, '#lesson-result-intro'), await phrase(s, 'lessonsResultIntro', { model: 'gemma4:e2b', agent: 'claude-code' }));
    await waitFocus(s, 'lesson-rule-input-0');

    t.step('edit the first rule, untick the second, Save: the backend gets the edited rule alone; the status line says so; the dialog closes');
    await s.key('a', { ctrl: true });
    await s.type('Do not include ADF.h: it is not installed here.');
    assert.equal(await val('lesson-rule-input-0'), 'Do not include ADF.h: it is not installed here.');
    await click(s, 'lesson-rule-check-1');
    assert.equal(await s.ev("document.getElementById('lesson-rule-check-1').checked"), false);
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false);
    assert.deepEqual(await lessons('saved'), [], 'nothing is written before Save');
    await click(s, 'lesson-primary');
    await waitHidden(s, 'lesson-modal');
    assert.deepEqual(await lessons('saved'), [{ agent: 'claude-code', rules: ['Do not include ADF.h: it is not installed here.'] }], 'the edited rule, not the proposed one, and not the unticked one');
    await waitStatus(await phrase(s, 'lessonsSaved', { agent: 'claude-code', n: '1' }));
    assert.equal(await visible(s, 'running-tasks-panel'), true);

    t.step('a rule with nothing ticked cannot be saved, and a rule with a comment mark says it is left out');
    await knobs({ none: false });
    await openFor(run.reqId);
    await waitReady();
    await s.key('Enter', { ctrl: true });
    await waitResult();
    await click(s, 'lesson-rule-check-0');
    await click(s, 'lesson-rule-check-1');
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), true, 'nothing ticked: Save is off');
    await click(s, 'lesson-rule-check-1');
    await s.ev("document.getElementById('lesson-rule-input-1').focus(); 1");
    await s.key('a', { ctrl: true });
    await s.type('use <!-- here');
    await s.waitFor("!document.getElementById('lesson-rule-warn-1').classList.contains('hidden')");
    assert.equal(await textOf(s, '#lesson-rule-warn-1'), await phrase(s, 'lessonsRuleBad'));
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), true, 'the only ticked rule cannot be saved');
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');
    assert.equal((await lessons('saved')).length, 1, 'nothing more was saved');

    t.step('a cloud host that was not allowed: the destination names it, the box is shown, Create waits for the tick, and the answer is saved BEFORE the model is asked');
    await knobs({ local: false, host: 'api.example.com', model: 'gpt-x', consent: false });
    const runsBeforeCloud = await runs();
    await openFor(run.reqId);
    await waitReady();
    assert.equal(await textOf(s, '#lesson-dest'), await phrase(s, 'lessonsDestCloud', { model: 'gpt-x', host: 'api.example.com' }));
    assert.equal(await s.ev("document.getElementById('lesson-dest').getAttribute('data-kind')"), 'cloud');
    assert.equal(await visible(s, 'lesson-consent-row'), true);
    assert.equal(await textOf(s, '#lesson-consent-text'), await phrase(s, 'lessonsConsent', { host: 'api.example.com' }));
    assert.equal(await s.ev("document.getElementById('lesson-consent').checked"), false);
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), true, 'Create waits for the box');
    await s.key('Enter', { ctrl: true });
    await click(s, 'lesson-primary');
    await settle(300);
    assert.equal(await runs(), runsBeforeCloud, 'without the tick nothing is sent');
    assert.equal(await visible(s, 'lesson-prepare'), true);
    await click(s, 'lesson-consent');
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false, 'ticked: Create works');
    await click(s, 'lesson-primary');
    await waitResult();
    const order = await s.ev('window.__docshot.calls.map(function (c) { return c.fn; })');
    const lastSave = order.lastIndexOf('saveConfig');
    const lastRun = order.lastIndexOf('lessonRun');
    assert.ok(lastSave > -1 && lastSave < lastRun, `the answer is saved before the model is asked: ${order.slice(-6)}`);
    const saved = await s.ev('window.__docshot.savedConfig');
    assert.ok(saved && saved.general && saved.general.cloudConsent && saved.general.cloudConsent['api.example.com'], 'general.cloudConsent holds the host');
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');

    t.step('the host is allowed now: the next dialog shows the cloud destination and no box');
    await openFor(run.reqId);
    await waitReady();
    assert.equal(await s.ev("document.getElementById('lesson-dest').getAttribute('data-kind')"), 'cloud');
    assert.equal(await visible(s, 'lesson-consent-row'), false);
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false);
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');

    t.step('a host the backend does not know as allowed refuses the run: the box comes back and nothing is shown as a proposal');
    await knobs({ host: 'other.example.com', consent: true });
    await openFor(run.reqId);
    await waitReady();
    assert.equal(await visible(s, 'lesson-consent-row'), false, 'the plan said the host was allowed');
    await knobs({ consent: false });
    await click(s, 'lesson-primary');
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsConsentRequired', { host: 'other.example.com' }));
    assert.equal(await visible(s, 'lesson-prepare'), true);
    assert.equal(await visible(s, 'lesson-consent-row'), true);
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), true);
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');
    await knobs({ local: true, host: '127.0.0.1:11434', model: 'gemma4:e2b' });

    t.step('the answer cannot be saved (config.json is not writable): nothing is sent, and the sentence says so; once it can be saved, Create goes on');
    await knobs({ local: false, host: 'nosave.example.com', model: 'gpt-x', consent: false });
    await s.setBackend({ saveConfig: { fail: 'disk full' } });
    const runsBeforeNoSave = await runs();
    await openFor(run.reqId);
    await waitReady();
    await click(s, 'lesson-consent');
    await click(s, 'lesson-primary');
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsConsentSaveFailed'));
    assert.equal(await runs(), runsBeforeNoSave, 'the model was not asked');
    assert.equal(await visible(s, 'lesson-prepare'), true, 'the dialog stays where it was');
    await s.setBackend({ saveConfig: null });
    await click(s, 'lesson-primary');
    await waitResult();
    assert.equal(await runs(), runsBeforeNoSave + 1);
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');
    await knobs({ local: true, host: '127.0.0.1:11434', model: 'gemma4:e2b' });

    t.step('no model set up: one sentence, and the button that goes to Settings; nothing is asked');
    await knobs({ modelConfigured: false });
    const runsBeforeNoModel = await runs();
    await openFor(run.reqId);
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsNoModel'));
    assert.equal(await visible(s, 'lesson-prepare'), false);
    assert.equal(await textOf(s, '#lesson-primary'), await phrase(s, 'askSetupButton'));
    await click(s, 'lesson-primary');
    await waitHidden(s, 'lesson-modal');
    await waitShown(s, 'settings-modal');
    assert.equal(await runs(), runsBeforeNoModel);
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');
    await knobs({ modelConfigured: true });

    t.step('nothing worth keeping: the sentence, a note to add, and Ask again that waits for a new note');
    await knobs({ none: true });
    await openFor(run.reqId);
    await waitReady();
    await click(s, 'lesson-primary');
    await waitShown(s, 'lesson-none');
    assert.equal(await textOf(s, '#lesson-none-text'), await phrase(s, 'lessonsNone'));
    assert.equal(await visible(s, 'lesson-note-row'), true, 'a way to say what went wrong');
    assert.equal(await textOf(s, '#lesson-primary'), await phrase(s, 'lessonsAskAgain'));
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), true, 'the same words would find the same: it waits for a note');
    await waitFocus(s, 'lesson-note');
    await s.type('it used the wrong compiler');
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false);
    const runsBeforeAgain = await runs();
    await knobs({ none: false });
    await click(s, 'lesson-primary');
    await waitResult();
    assert.equal(await runs(), runsBeforeAgain + 1);
    assert.equal((await plans()).pop().note, 'it used the wrong compiler', 'asked again with the note');
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');

    t.step('cancel while the model works: the working line, Cancel stops the run and closes the dialog; Esc does the same; a late answer changes nothing');
    await knobs({ hold: true });
    await openFor(run.reqId);
    await waitReady();
    await click(s, 'lesson-primary');
    await waitShown(s, 'lesson-working');
    assert.equal(await textOf(s, '#lesson-working-text'), await phrase(s, 'lessonsAsking', { model: 'gemma4:e2b' }));
    assert.equal(await visible(s, 'lesson-primary'), false, 'only Cancel while it works');
    assert.equal(await textOf(s, '#lesson-secondary'), await phrase(s, 'btnCancel'));
    await s.waitFor('!!window.__docshot.lessons.held');
    const heldPlan = await lessons('held.planId');
    await click(s, 'lesson-secondary');
    await waitHidden(s, 'lesson-modal');
    assert.ok((await lessons('cancels')).includes(heldPlan), 'the backend was told to stop that run');
    await settle(300);
    assert.equal(await visible(s, 'lesson-modal'), false, 'its answer (cancelled) does not bring the dialog back');
    await openFor(run.reqId);
    await waitReady();
    await click(s, 'lesson-primary');
    await waitShown(s, 'lesson-working');
    await s.waitFor('!!window.__docshot.lessons.held');
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');
    assert.equal((await lessons('cancels')).length, 2, 'Esc stops it too');
    await knobs({ hold: false });

    t.step('a failure is one sentence with Try again; an old plan is prepared again and nothing is asked until Create is pressed again');
    await knobs({ runReject: 'the model did not answer in 90 seconds' });
    await openFor(run.reqId);
    await waitReady();
    await click(s, 'lesson-primary');
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsFailed', { message: 'the model did not answer in 90 seconds' }));
    assert.equal(await textOf(s, '#lesson-primary'), await phrase(s, 'lessonsRetry'));
    await knobs({ runReject: '' });
    await click(s, 'lesson-primary');
    await waitReady();
    await s.ev('window.__docshot.lessons.expire(); 1');
    const runsBeforeExpired = await runs();
    const plansBeforeExpired = (await plans()).length;
    await click(s, 'lesson-primary');
    await s.waitFor(`window.__docshot.lessons.plans.length === ${plansBeforeExpired + 1}`);
    await waitReady();
    assert.equal(await runs(), runsBeforeExpired + 1, 'the expired plan was tried once and not again');
    assert.equal(await visible(s, 'lesson-result'), false, 'no proposal from nothing');
    await click(s, 'lesson-primary');
    await waitResult();
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');

    t.step('a plan that fails: the sentence, and Try again prepares it again');
    await knobs({ planReject: 'no such agent' });
    await openFor(run.reqId);
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsPlanFailed', { message: 'no such agent' }));
    await knobs({ planReject: '' });
    await click(s, 'lesson-primary');
    await waitReady();
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');

    t.step('a save that fails keeps the rules on screen with the reason; a full file says so in words');
    await knobs({ saveReject: 'disk is full' });
    await openFor(run.reqId);
    await waitReady();
    await s.key('Enter', { ctrl: true });
    await waitResult();
    await click(s, 'lesson-primary');
    await s.waitFor("!document.getElementById('lesson-banner').classList.contains('hidden')");
    assert.equal(await banner(), await phrase(s, 'lessonsSaveFailed', { message: 'disk is full' }));
    assert.equal(await visible(s, 'lesson-result'), true, 'the rules are still there');
    assert.equal(await s.ev("document.getElementById('lesson-primary').disabled"), false, 'and can be saved again');
    await knobs({ saveReject: '', full: 199 });
    await click(s, 'lesson-primary');
    await s.waitFor("document.getElementById('lesson-banner').textContent === " + JSON.stringify(await phrase(s, 'lessonsTooMany')));
    await knobs({ full: 3 });
    await click(s, 'lesson-primary');
    await waitHidden(s, 'lesson-modal');
    await waitStatus(await phrase(s, 'lessonsSaved', { agent: 'claude-code', n: '2' }));

    t.step('rules that are on file already are not added again, and the status line says so');
    await openFor(run.reqId);
    await waitReady();
    await s.key('Enter', { ctrl: true });
    await waitResult();
    await click(s, 'lesson-primary');
    await waitHidden(s, 'lesson-modal');
    await waitStatus(await phrase(s, 'lessonsSavedNothing', { agent: 'claude-code' }));

    t.step('the palette entry: one agent with lessons opens its file as an ordinary tab');
    const before = (await tabs()).length;
    const runEntry = async () => {
      await openPalette(s);
      await s.type(word);
      await s.waitFor("document.querySelectorAll('#quick-pick-list .quick-pick-item').length > 0");
      const titles = await paletteTitles(s);
      const at = titles.indexOf(await phrase(s, 'cmdPaletteLessonsFile'));
      assert.ok(at >= 0, `"${await phrase(s, 'cmdPaletteLessonsFile')}" is among the matches of "${word}": ${JSON.stringify(titles)}`);
      for (let i = 0; i < at; i++) await s.key('ArrowDown');
      await s.key('Enter');
    };
    await s.key('t', { alt: true }); // (the task panel is not in the way)
    await runEntry();
    await s.waitFor("window.__explore.state().tabs.some(function (x) { return x.title === 'claude-code.md'; })");
    const opened = (await tabs()).find((x) => x.title === 'claude-code.md');
    assert.equal((await tabs()).length, before + 1);
    assert.ok(opened.content.includes('# Lessons for claude-code'), 'the file\'s text: ' + opened.content.slice(0, 80));
    assert.equal(opened.path, 'C:\\Users\\demo\\AppData\\Roaming\\md-memo\\lessons\\claude-code.md');
    assert.equal((await s.state()).activeTabId, opened.id, 'and it is the tab in front');
    assert.equal(await visible(s, 'lesson-modal'), false, 'no picker for one file');

    t.step('several agents: a small picker, by name, with the count; the arrow keys and Enter open the file; Esc opens nothing');
    await knobs({ files: [
      { agent: 'hermes', path: 'C:\\Users\\demo\\AppData\\Roaming\\md-memo\\lessons\\hermes.md', exists: true, count: 1, applied: 1, skipped: 0, disabled: true },
      { agent: 'claude-code', path: 'C:\\Users\\demo\\AppData\\Roaming\\md-memo\\lessons\\claude-code.md', exists: true, count: 4, applied: 4, skipped: 0, disabled: false }
    ] });
    await runEntry();
    await waitShown(s, 'lesson-modal');
    assert.equal(await visible(s, 'lesson-pick'), true);
    assert.equal(await visible(s, 'lesson-footer'), false, 'a picker has no buttons');
    assert.deepEqual(await s.ev("Array.from(document.querySelectorAll('#lesson-pick-list .quick-pick-item-title')).map(function (e) { return e.textContent; })"), ['claude-code', 'hermes']);
    assert.deepEqual(await s.ev("Array.from(document.querySelectorAll('#lesson-pick-list .quick-pick-item-desc')).map(function (e) { return e.textContent; })"),
      [await phrase(s, 'lessonsPickCount', { n: 4 }), `${await phrase(s, 'lessonsPickCountOne', { n: 1 })} \u00b7 ${await phrase(s, 'lessonsPickOff')}`]);
    assert.equal(await textOf(s, '#lesson-hint'), await phrase(s, 'lessonsHintPick'));
    const tabCount = (await tabs()).length;
    await s.key('Escape');
    await waitHidden(s, 'lesson-modal');
    assert.equal((await tabs()).length, tabCount, 'Esc opens nothing');
    await waitFocus(s, 'editor');
    await runEntry();
    await waitShown(s, 'lesson-pick');
    await s.key('ArrowDown');
    await s.waitFor("document.querySelector('#lesson-pick-list .lesson-pick-item.active').getAttribute('data-row') === '1'");
    await s.key('Enter');
    await waitHidden(s, 'lesson-modal');
    await s.waitFor("window.__explore.state().tabs.some(function (x) { return x.title === 'hermes.md'; })");
    assert.equal((await tabs()).length, tabCount + 1);
    assert.equal((await activeTab(s)).title, 'hermes.md', 'the second row, hermes');

    t.step('a mouse press on a row of the picker opens it too');
    await runEntry();
    await waitShown(s, 'lesson-pick');
    await clickSelector(s, '#lesson-pick-list .lesson-pick-item[data-row="0"]');
    await waitHidden(s, 'lesson-modal');
    assert.equal((await activeTab(s)).title, 'claude-code.md', 'the first row, claude-code, is in front (its tab was open already: not opened twice)');
    assert.equal((await tabs()).filter((x) => x.title === 'claude-code.md').length, 1);

    t.step('no lessons yet: a sentence; a backend that cannot list them: a sentence');
    await knobs({ files: [] });
    await runEntry();
    await waitStatus(await phrase(s, 'lessonsNoneYet', { alt: 'Alt' }));
    assert.equal(await visible(s, 'lesson-modal'), false);
    await knobs({ infoReject: 'the folder cannot be read' });
    await runEntry();
    await waitStatus(await phrase(s, 'lessonsInfoFailed', { message: 'the folder cannot be read' }));
    await knobs({ infoReject: '' });

    t.step('an older backend (no lessonPlan, no lessonsInfo): no button on a card, no palette entry');
    await s.ev('window.__savedLessonPlan = window.backend.lessonPlan; window.__savedLessonsInfo = window.backend.lessonsInfo; delete window.backend.lessonPlan; delete window.backend.lessonsInfo; TaskManager.showPanel(); TaskManager.renderUI(); 1');
    await waitShown(s, 'running-tasks-panel');
    assert.equal(await s.ev("document.querySelectorAll('#tasks-panel-list .task-card-history').length > 0"), true, 'the cards are there');
    assert.deepEqual(await buttons(), [], 'but no button');
    assert.ok((await s.ev("document.querySelectorAll('#tasks-panel-list .task-lessons-line').length")) > 0, 'the line about the lessons that went into a run is still there');
    await openPalette(s);
    await s.type(word);
    await settle(300);
    const without = await paletteTitles(s);
    assert.ok(!without.includes(await phrase(s, 'cmdPaletteLessonsFile')), `not offered: ${JSON.stringify(without)}`);
    await s.key('Escape');
    await waitHidden(s, 'quick-pick-modal');
    await s.ev('window.backend.lessonPlan = window.__savedLessonPlan; window.backend.lessonsInfo = window.__savedLessonsInfo; 1');
    assert.equal((await asked(s, 'lessonsInfo')).length > 0, true, 'lessonsInfo was asked for the lists above');
  },
};
