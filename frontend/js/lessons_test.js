// Unit tests for lessons.js: the request for the plan, the plan as the page reads it, the rules the person edits, the sentences for errors,
// and the dialog as a state machine (every path of docs/design/lessons-2026-10.md section 7). The DOM part is covered by the smoke flow
// tests/smoke/105_lessons.mjs; the card's button and line are tested in task_manager_test.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = global;
const L = require('./lessons.js');

// A "t" like the app's: the table of the language, {name} filled in.
const I18N = new Function(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '\nreturn I18N;')();
const tr = (lang) => (key, params) => {
  let s = I18N[lang][key];
  assert.ok(typeof s === 'string', `${lang} has no string for ${key}`);
  Object.keys(params || {}).forEach((k) => { s = s.split('{' + k + '}').join(String(params[k])); });
  return s;
};
const tEn = tr('en');
const tJa = tr('ja');

const TASK = { id: 'slot-1', agent: 'claude-code', instruction: 'Fix the failing build', error: 'Exit Code 1', exitCode: 1, output: 'ADF.h: no such file' };
const planOf = (over) => Object.assign({
  plan_id: 'p1', agent: 'claude',
  destination: { model: 'gemma4:e2b', host: '127.0.0.1:11434', local: true, consent_given: true },
  sent: { instruction_chars: 120, output_chars: 2400, error_chars: 60, note_chars: 0, masked: 1 },
  lessons: { exists: true, count: 3 }
}, over || {});
const norm = (over) => L.normalizePlan(planOf(over));
const cloud = (over) => norm({ plan_id: 'p2', destination: { model: 'gpt-x', host: 'api.example.com', local: false, consent_given: false }, ...(over || {}) });

// Runs events through the machine from the state `from`, returning the last { state, effect } and every effect on the way.
function run(from, events) {
  let state = from;
  const effects = [];
  let last = { state: from, effect: null };
  events.forEach((ev) => {
    const before = JSON.stringify(state);
    last = L.reduce(state, ev);
    assert.strictEqual(JSON.stringify(state), before, 'the old state is never changed: ' + JSON.stringify(ev));
    state = last.state;
    if (last.effect) effects.push(last.effect);
  });
  return { state, effect: last.effect, effects };
}
const begin = (task) => L.start(task || TASK, 'en');
const ready = (plan, task) => run(begin(task).state, [{ type: 'plan', plan: plan || norm() }]).state;

(function testRequest() {
  const r = L.request(TASK, '  the header is not installed  ', 'ja');
  assert.deepStrictEqual(r, { agent: 'claude-code', instruction: 'Fix the failing build', output: 'ADF.h: no such file', error: 'Exit Code 1', exit_code: 1, note: 'the header is not installed', lang: 'ja' });
  assert.strictEqual(L.request({ agentKey: 'claude-code', agent: 'code' }, '', 'en').agent, 'claude-code', 'the key the backend started beats a role name on the card');
  assert.strictEqual(L.request({ agent: '@cc' }, '', 'en').agent, 'cc', 'the "@" a task is written with is not part of the name');
  assert.strictEqual(L.request({}, undefined, 'xx').lang, 'en', 'any language but Japanese is English');
  assert.deepStrictEqual(Object.keys(L.request({}, '', 'en')).sort(), ['agent', 'error', 'exit_code', 'instruction', 'lang', 'note', 'output']);
  assert.strictEqual(L.request({ exitCode: 'x' }, '', 'en').exit_code, 0);
  const long = 'x'.repeat(9000);
  assert.strictEqual(L.request({ output: long }, '', 'en').output.length, 9000, 'the page passes what the card holds: the backend cuts it');
  assert.strictEqual(L.instructionPreview('  a\n\n b  '), 'a b');
  assert.strictEqual(L.instructionPreview('y'.repeat(500)).length, 161);
  assert.ok(L.instructionPreview('y'.repeat(500)).endsWith('\u2026'));
  assert.strictEqual(L.agentName({ agent: 'claude-code' }), 'claude-code');
})();

(function testPlan() {
  const p = norm();
  assert.deepStrictEqual(p, {
    planId: 'p1', agent: 'claude', model: 'gemma4:e2b', host: '127.0.0.1:11434', local: true, consentKey: '127.0.0.1:11434', consentGiven: true,
    sent: { instruction: 120, output: 2400, error: 60, note: 0, masked: 1 }, lessons: { exists: true, count: 3 }, modelConfigured: true
  });
  assert.deepStrictEqual(L.normalizePlan(JSON.stringify(planOf())), p, 'a JSON text is read');
  assert.strictEqual(L.normalizePlan(null), null);
  assert.strictEqual(L.normalizePlan('not json'), null);
  assert.strictEqual(L.normalizePlan(42), null);
  // what is not said to be local is a cloud destination; a consent not said to be given is not given
  const bare = L.normalizePlan({ plan_id: 'p', destination: { host: 'h' } });
  assert.strictEqual(bare.local, false);
  assert.strictEqual(bare.consentGiven, false);
  assert.strictEqual(L.needsConsent(bare), true);
  assert.strictEqual(L.needsConsent(norm()), false, 'this PC: no question');
  assert.strictEqual(L.needsConsent(cloud()), true);
  assert.strictEqual(L.needsConsent(cloud({ destination: { model: 'm', host: 'h', local: false, consent_given: true } })), false, 'a host that was allowed before');
  assert.strictEqual(L.needsConsent(null), false);
  assert.strictEqual(cloud({ destination: { model: 'm', host: 'h', local: false, consent_key: 'http://h' } }).consentKey, 'http://h', 'the key the backend names is the one remembered');
  assert.strictEqual(L.normalizePlan({ plan_id: 'p', model_configured: false }).modelConfigured, false);
  assert.strictEqual(L.normalizePlan({ plan_id: 7 }).planId, '', 'an id that is not text is no id');
  assert.strictEqual(L.sameDestination(norm(), norm()), true);
  assert.strictEqual(L.sameDestination(norm(), cloud()), false);
  assert.strictEqual(L.sameDestination(norm(), norm({ destination: { model: 'other', host: '127.0.0.1:11434', local: true } })), false);
  assert.strictEqual(L.sameDestination(null, norm()), false);
})();

(function testPlanLines() {
  const en = L.planLines(norm(), '', tEn, 'en');
  assert.strictEqual(en.sent, 'Will be sent: the instruction (120 characters), the agent\'s output (2,400 characters) and the error (60 characters).');
  assert.strictEqual(en.masked, '1 secret (a key, token or password) is blanked out before sending.');
  assert.strictEqual(L.planLines(norm({ sent: { masked: 3 } }), '', tEn, 'en').masked, '3 secrets (keys, tokens, passwords) are blanked out before sending.');
  assert.strictEqual(en.note, '', 'no note, no line about it');
  assert.strictEqual(en.dest, 'To: gemma4:e2b on this PC. Nothing leaves it.');
  assert.strictEqual(en.destKind, 'local');
  assert.strictEqual(en.consent, '', 'a model on this PC is never asked about');
  assert.strictEqual(en.existing, 'Saved for claude so far: 3');
  const ja = L.planLines(norm(), '', tJa, 'ja');
  assert.ok(ja.sent.includes('指示 120 文字') && ja.sent.includes('出力 2,400 文字') && ja.sent.includes('エラー 60 文字'), ja.sent);
  assert.ok(ja.dest.includes('この PC の gemma4:e2b'), ja.dest);

  const c = L.planLines(cloud(), '  because of the header ', tEn, 'en');
  assert.strictEqual(c.destKind, 'cloud');
  assert.strictEqual(c.dest, 'To: gpt-x at api.example.com (cloud), over the internet.');
  assert.strictEqual(c.consent, 'I allow sending this text to api.example.com');
  assert.strictEqual(c.note, 'Your note below (21 characters) is sent too.', 'the note, trimmed, is counted as it will be sent');
  assert.strictEqual(L.planLines(cloud({ destination: { model: 'm', host: 'h', local: false, consent_given: true } }), '', tEn, 'en').consent, '', 'allowed before: no box');
  assert.strictEqual(L.planLines(norm({ sent: { masked: 0 } }), '', tEn, 'en').masked, '', 'nothing blanked, no line');
  assert.strictEqual(L.planLines(norm({ lessons: { exists: false, count: 0 } }), '', tEn, 'en').existing, '');
})();

(function testRules() {
  assert.strictEqual(L.cleanRule('  Do not\n use\tADF.h  '), 'Do not use ADF.h');
  assert.strictEqual(L.cleanRule(''), '');
  assert.strictEqual(L.cleanRule(undefined), '');
  assert.strictEqual(Array.from(L.cleanRule('a'.repeat(400))).length, 300, 'at most 300 characters');
  const astral = '\uD83D\uDE00'.repeat(301);
  assert.strictEqual(Array.from(L.cleanRule(astral)).length, 300, 'counted in characters, never cutting a pair in two');
  assert.strictEqual(L.ruleProblem('use <!-- here'), 'marks');
  assert.strictEqual(L.ruleProblem('close --> here'), 'marks');
  assert.strictEqual(L.ruleProblem('a plain rule'), '');

  const rows = [
    { text: ' first ', checked: true },
    { text: 'second', checked: false },
    { text: 'FIRST', checked: true },
    { text: '   ', checked: true },
    { text: 'has <!-- mark', checked: true },
    { text: 'third\nline', checked: true },
    { text: 'four', checked: true }, { text: 'five', checked: true }, { text: 'six', checked: true }, { text: 'seven', checked: true }
  ];
  assert.deepStrictEqual(L.chosenRules(rows), ['first', 'third line', 'four', 'five', 'six'], 'ticked, cleaned, no empties, no marks, no repeats, five at most');
  assert.deepStrictEqual(L.chosenRules([{ text: 'a', checked: false }]), []);
  assert.deepStrictEqual(L.chosenRules(null), []);
  assert.deepStrictEqual(L.chosenRules([{ text: 'a' }]), [], 'a row that is not ticked for sure is not saved');

  assert.deepStrictEqual(L.proposedRows(['  one ', 'ONE', '', 7, null, 'two']), [{ text: 'one', checked: true }, { text: 'two', checked: true }]);
  assert.deepStrictEqual(L.proposedRows(undefined), []);
})();

(function testErrors() {
  assert.strictEqual(L.errorCode(new Error('model_not_configured: no model')), 'model_not_configured');
  assert.strictEqual(L.errorCode(new Error('consent_required: api.example.com')), 'consent_required');
  assert.strictEqual(L.errorCode(new Error('plan_expired')), 'plan_expired');
  assert.strictEqual(L.errorCode(new Error('cancelled')), 'cancelled');
  assert.strictEqual(L.errorCode(new Error('canceled')), 'cancelled', 'both spellings');
  assert.strictEqual(L.errorCode(new Error('too_many: 200')), 'too_many');
  assert.strictEqual(L.errorCode(new Error('the model did not answer')), '', 'a sentence is not a code');
  assert.strictEqual(L.errorCode('plan_expired'), 'plan_expired', 'a bare string too');
  assert.strictEqual(L.errorCode(null), '');
  assert.strictEqual(L.afterCode(new Error('consent_required: api.example.com\nmore')), 'api.example.com');
  assert.strictEqual(L.afterCode(new Error('consent_required')), '');

  [['en', tEn], ['ja', tJa]].forEach(([lang, t]) => {
    const text = (e, ctx) => L.errorText(e, t, ctx);
    assert.strictEqual(text({ kind: 'plan', code: 'model_not_configured' }), t('lessonsNoModel'), lang);
    assert.strictEqual(text({ kind: 'run', code: 'consent_required', detail: 'h1' }), t('lessonsConsentRequired', { host: 'h1' }));
    assert.strictEqual(text({ kind: 'run', code: 'consent_required' }, { host: 'h2' }), t('lessonsConsentRequired', { host: 'h2' }), 'the plan\'s host wins over the message');
    assert.strictEqual(text({ kind: 'run', code: 'plan_expired' }), t('lessonsExpired'));
    assert.strictEqual(text({ kind: 'run', code: 'cancelled' }), t('lessonsCanceled'));
    assert.strictEqual(text({ kind: 'save', code: 'too_many' }), t('lessonsTooMany'));
    assert.strictEqual(text({ kind: 'plan', code: '', detail: 'no such agent' }), t('lessonsPlanFailed', { message: 'no such agent' }));
    assert.strictEqual(text({ kind: 'run', code: '', detail: 'timeout' }), t('lessonsFailed', { message: 'timeout' }));
    assert.strictEqual(text({ kind: 'save', code: '', detail: 'disk full' }), t('lessonsSaveFailed', { message: 'disk full' }));
    assert.strictEqual(text({ kind: 'run' }), t('lessonsFailed', { message: '?' }), 'no detail: a question mark, never "undefined"');
    assert.strictEqual(text(null), t('lessonsFailed', { message: '?' }));
  });

  assert.strictEqual(L.savedText({ path: 'p', count: 5, added: 3 }, 'claude', 3, tEn), 'Lessons saved: claude (3)');
  assert.strictEqual(L.savedText({ path: 'p', count: 5, added: 3 }, 'claude', 3, tJa), '教訓を保存しました: claude（3 件）');
  assert.strictEqual(L.savedText({ added: 0 }, 'claude', 2, tEn), 'Those lessons were already saved for claude. Nothing was added.');
  assert.strictEqual(L.savedText(null, 'claude', 2, tEn), 'Lessons saved: claude (2)', 'an answer that says nothing about the count: what was sent');
})();

(function testHappyPathLocal() {
  const first = begin();
  assert.strictEqual(first.state.phase, 'planning');
  assert.strictEqual(first.state.agent, 'claude-code');
  assert.deepStrictEqual(first.effect, { call: 'plan', request: L.request(TASK, '', 'en') }, 'opening asks for the plan with nothing but the card (no note, no model call)');

  let r = run(first.state, [{ type: 'plan', plan: norm() }]);
  assert.strictEqual(r.state.phase, 'ready');
  assert.strictEqual(r.effect, null, 'the plan alone sends nothing to the model');
  assert.strictEqual(L.canCreate(r.state), true, 'a model on this PC needs no tick');
  assert.deepStrictEqual(L.controls(r.state), { primary: { key: 'lessonsCreate', event: 'create', enabled: true }, secondary: { key: 'btnCancel' }, hint: 'lessonsHintReady' });

  r = run(r.state, [{ type: 'create' }]);
  assert.strictEqual(r.state.phase, 'running');
  assert.deepStrictEqual(r.effect, { call: 'run', planId: 'p1' });
  assert.strictEqual(L.controls(r.state).primary, null, 'nothing to press but Cancel while the model works');
  assert.strictEqual(L.controls(r.state).hint, 'lessonsHintWorking');

  r = run(r.state, [{ type: 'ran', rules: ['  Do not include ADF.h. ', 'Use --no-color', 'Do not include ADF.h.'], model: 'gemma4:e2b' }]);
  assert.strictEqual(r.state.phase, 'result');
  assert.deepStrictEqual(r.state.rules, [{ text: 'Do not include ADF.h.', checked: true }, { text: 'Use --no-color', checked: true }]);
  assert.strictEqual(r.state.model, 'gemma4:e2b');
  assert.strictEqual(L.controls(r.state).primary.enabled, true);

  // edit the first rule, untick the second
  r = run(r.state, [{ type: 'editRule', index: 0, text: 'Do not include ADF.h: the build fails here.' }, { type: 'toggleRule', index: 1 }]);
  assert.deepStrictEqual(r.state.rules.map((x) => x.checked), [true, false]);
  r = run(r.state, [{ type: 'save' }]);
  assert.strictEqual(r.state.saving, true);
  assert.deepStrictEqual(r.effect, { call: 'save', request: { agent: 'claude', rules: ['Do not include ADF.h: the build fails here.'] } }, 'the edited rule is saved, the unticked one is not, under the name the backend resolved');
  assert.strictEqual(L.controls(r.state).primary.enabled, false, 'no second press while it is being written');
  assert.deepStrictEqual(run(r.state, [{ type: 'save' }]).effects, [], 'a second Save does nothing');
  assert.strictEqual(run(r.state, [{ type: 'toggleRule', index: 0 }]).state, r.state, 'and the rows are frozen while it is written');
  assert.strictEqual(run(r.state, [{ type: 'cancel' }]).state, r.state, 'and the dialog stays until the write is done');

  r = run(r.state, [{ type: 'saved', result: { path: 'p', count: 4, added: 1 } }]);
  assert.strictEqual(r.state.phase, 'closed');
  assert.deepStrictEqual(r.state.result, { path: 'p', count: 4, added: 1 });
})();

(function testSaveNeedsARule() {
  let s = run(ready(), [{ type: 'create' }, { type: 'ran', rules: ['a'], model: 'm' }, { type: 'toggleRule', index: 0 }]).state;
  assert.strictEqual(L.controls(s).primary.enabled, false, 'nothing ticked: Save is off');
  assert.deepStrictEqual(run(s, [{ type: 'save' }]).effects, []);
  s = run(s, [{ type: 'toggleRule', index: 0 }, { type: 'editRule', index: 0, text: 'bad <!-- rule' }]).state;
  assert.strictEqual(L.controls(s).primary.enabled, false, 'a rule with a comment mark is not saved: nothing left to save');
  s = run(s, [{ type: 'editRule', index: 0, text: '   ' }]).state;
  assert.strictEqual(L.controls(s).primary.enabled, false, 'an emptied rule is not saved');
  // a failed save keeps the rows and says why
  s = run(s, [{ type: 'editRule', index: 0, text: 'fine' }, { type: 'save' }, { type: 'saveFailed', code: 'too_many', detail: '' }]).state;
  assert.strictEqual(s.phase, 'result');
  assert.strictEqual(s.saving, false);
  assert.deepStrictEqual(s.error, { kind: 'save', code: 'too_many', detail: '' });
  assert.strictEqual(L.errorText(s.error, tEn), tEn('lessonsTooMany'));
  assert.strictEqual(L.controls(s).primary.enabled, true, 'and Save can be pressed again');
})();

(function testCloudConsent() {
  let s = ready(cloud());
  assert.strictEqual(s.phase, 'ready');
  assert.strictEqual(L.canCreate(s), false, 'a host that was not allowed: Create waits for the box');
  assert.strictEqual(L.controls(s).primary.enabled, false);
  assert.deepStrictEqual(run(s, [{ type: 'create' }]).effects, [], 'pressing it anyway sends nothing');
  s = run(s, [{ type: 'consent', checked: true }]).state;
  assert.strictEqual(L.canCreate(s), true);
  assert.strictEqual(L.controls(s).primary.enabled, true);
  s = run(s, [{ type: 'consent', checked: false }]).state;
  assert.strictEqual(L.canCreate(s), false, 'unticking takes it back');
  // an allowed host: no box
  assert.strictEqual(L.canCreate(ready(cloud({ destination: { model: 'm', host: 'h', local: false, consent_given: true } }))), true);
  // the box means nothing for a model on this PC, and in other phases
  assert.strictEqual(run(begin().state, [{ type: 'consent', checked: true }]).state.consent, false, 'not while the plan is being prepared');
})();

(function testNoteReplansBeforeTheRun() {
  const withNote = run(ready(), [{ type: 'note', text: 'the header is not installed' }]).state;
  assert.strictEqual(withNote.note, 'the header is not installed');
  let r = run(withNote, [{ type: 'create' }]);
  assert.strictEqual(r.state.phase, 'planning', 'a note written after the plan changes what is sent: the plan is made again first');
  assert.strictEqual(r.effect.call, 'plan');
  assert.strictEqual(r.effect.request.note, 'the header is not installed');
  assert.strictEqual(r.state.thenRun, true);
  // the same destination: straight on to the model, with the new plan
  r = run(r.state, [{ type: 'plan', plan: norm({ plan_id: 'p9' }) }]);
  assert.strictEqual(r.state.phase, 'running');
  assert.deepStrictEqual(r.effect, { call: 'run', planId: 'p9' });
  assert.strictEqual(r.state.plannedNote, 'the header is not installed');

  // another destination: the person looks again
  r = run(withNote, [{ type: 'create' }, { type: 'plan', plan: norm({ plan_id: 'p9', destination: { model: 'other', host: 'api.example.com', local: false, consent_given: true } }) }]);
  assert.strictEqual(r.state.phase, 'ready');
  assert.strictEqual(r.state.notice, 'changed');
  assert.strictEqual(r.effect, null);
  assert.strictEqual(r.state.consent, false);
  // a cloud host whose answer the new plan does not hold: back to the box
  r = run(run(ready(cloud()), [{ type: 'consent', checked: true }, { type: 'note', text: 'x' }]).state, [{ type: 'create' }, { type: 'plan', plan: cloud({ plan_id: 'p8' }) }]);
  assert.strictEqual(r.state.phase, 'ready');
  assert.strictEqual(r.state.consent, true, 'the tick stays for the same host');
  assert.strictEqual(L.canCreate(r.state), true);

  // a note that is only spaces, or the same as the plan's, needs no new plan
  assert.strictEqual(run(ready(), [{ type: 'note', text: '   ' }, { type: 'create' }]).state.phase, 'running');
  // the note is cut at 500 characters, and only typed in the two phases that show it
  assert.strictEqual(Array.from(run(ready(), [{ type: 'note', text: 'n'.repeat(900) }]).state.note).length, 500);
  assert.strictEqual(run(begin().state, [{ type: 'note', text: 'x' }]).state.note, '');
})();

(function testNone() {
  let r = run(ready(), [{ type: 'create' }, { type: 'ran', rules: [], model: 'm' }]);
  assert.strictEqual(r.state.phase, 'none');
  assert.deepStrictEqual(L.controls(r.state), { primary: { key: 'lessonsAskAgain', event: 'again', enabled: false }, secondary: { key: 'dialogClose' }, hint: 'lessonsHintNone' }, 'asking again with the same words is no use: it waits for a note');
  assert.deepStrictEqual(run(r.state, [{ type: 'again' }]).effects, []);
  r = run(r.state, [{ type: 'note', text: 'it used the wrong compiler' }]);
  assert.strictEqual(L.controls(r.state).primary.enabled, true);
  r = run(r.state, [{ type: 'again' }]);
  assert.strictEqual(r.state.phase, 'planning');
  assert.strictEqual(r.effect.request.note, 'it used the wrong compiler');
  r = run(r.state, [{ type: 'plan', plan: norm({ plan_id: 'p5' }) }]);
  assert.deepStrictEqual(r.effect, { call: 'run', planId: 'p5' }, 'the destination is the one already seen: it goes on');
  r = run(r.state, [{ type: 'ran', rules: ['A rule.'], model: 'm' }]);
  assert.strictEqual(r.state.phase, 'result');
  // rules that are all empty after cleaning are none
  assert.strictEqual(run(ready(), [{ type: 'create' }, { type: 'ran', rules: ['  ', 3], model: 'm' }]).state.phase, 'none');
  assert.strictEqual(run(ready(), [{ type: 'create' }, { type: 'ran' }]).state.phase, 'none', 'an answer without rules is none, not a failure');
})();

(function testFailures() {
  // no model: at the plan (as a code or as a plan that says so), or at the run
  let r = run(begin().state, [{ type: 'planFailed', code: 'model_not_configured', detail: '' }]);
  assert.strictEqual(r.state.phase, 'model');
  assert.deepStrictEqual(L.controls(r.state).primary, { key: 'askSetupButton', event: 'settings', enabled: true });
  assert.strictEqual(run(begin().state, [{ type: 'plan', plan: L.normalizePlan({ plan_id: 'x', model_configured: false }) }]).state.phase, 'model');
  assert.strictEqual(run(ready(), [{ type: 'create' }, { type: 'runFailed', code: 'model_not_configured' }]).state.phase, 'model');

  // any other failure of the plan: a sentence and a way to try again
  r = run(begin().state, [{ type: 'planFailed', code: '', detail: 'no such agent' }]);
  assert.strictEqual(r.state.phase, 'error');
  assert.strictEqual(L.errorText(r.state.error, tEn), 'Could not prepare the proposal: no such agent');
  assert.strictEqual(L.controls(r.state).primary.key, 'lessonsRetry');
  r = run(r.state, [{ type: 'retry' }]);
  assert.strictEqual(r.state.phase, 'planning');
  assert.strictEqual(r.effect.call, 'plan');
  assert.strictEqual(r.state.plan, null);
  assert.strictEqual(run(begin().state, [{ type: 'plan', plan: null }]).state.phase, 'error', 'an answer that is no plan is a failure');
  assert.strictEqual(run(begin().state, [{ type: 'plan', plan: L.normalizePlan({ plan_id: '' }) }]).state.phase, 'error');

  // a failed run
  r = run(ready(), [{ type: 'create' }, { type: 'runFailed', code: '', detail: 'the model did not answer in 90 s' }]);
  assert.strictEqual(r.state.phase, 'error');
  assert.strictEqual(L.errorText(r.state.error, tEn), 'Could not make a proposal: the model did not answer in 90 s');
  assert.strictEqual(r.state.error.kind, 'run');

  // the prepared text expired: prepared again, and the person presses Create again (nothing more is sent on its own)
  r = run(ready(), [{ type: 'create' }, { type: 'runFailed', code: 'plan_expired' }]);
  assert.strictEqual(r.state.phase, 'planning');
  assert.strictEqual(r.state.notice, 'expired');
  assert.strictEqual(r.effect.call, 'plan');
  assert.strictEqual(r.state.thenRun, false);
  r = run(r.state, [{ type: 'plan', plan: norm({ plan_id: 'p7' }) }]);
  assert.strictEqual(r.state.phase, 'ready');
  assert.strictEqual(r.effect, null);
  assert.strictEqual(r.state.notice, '');

  // the backend has no answer for the host: the box comes back and nothing was sent
  r = run(ready(cloud()), [{ type: 'consent', checked: true }, { type: 'create' }, { type: 'runFailed', code: 'consent_required', detail: 'api.example.com' }]);
  assert.strictEqual(r.state.phase, 'ready');
  assert.strictEqual(r.state.consent, false);
  assert.strictEqual(r.state.notice, 'consent');
  assert.strictEqual(L.canCreate(r.state), false);
  // even a plan that called the model local is asked again
  r = run(ready(), [{ type: 'create' }, { type: 'runFailed', code: 'consent_required' }]);
  assert.strictEqual(L.needsConsent(r.state.plan), true);
  assert.strictEqual(L.canCreate(r.state), false);

  // late or stray events change nothing
  const idle = ready();
  ['ran', 'runFailed', 'saved', 'saveFailed', 'toggleRule', 'editRule', 'save', 'retry', 'again', 'planFailed', 'plan'].forEach((type) => {
    assert.strictEqual(run(idle, [{ type, rules: ['x'], index: 0, plan: norm(), code: 'x' }]).state, idle, `${type} in the ready phase changes nothing`);
  });
  assert.strictEqual(run(idle, [{ type: 'no-such-event' }]).state, idle);
  assert.strictEqual(L.reduce(idle, null).state, idle);
})();

(function testCancel() {
  // while the model works: the run is stopped, and the dialog closes
  let r = run(ready(), [{ type: 'create' }, { type: 'cancel' }]);
  assert.strictEqual(r.state.phase, 'closed');
  assert.deepStrictEqual(r.effect, { call: 'cancel', planId: 'p1' });
  // at any other time: it just closes
  r = run(ready(), [{ type: 'cancel' }]);
  assert.strictEqual(r.state.phase, 'closed');
  assert.strictEqual(r.effect, null);
  assert.strictEqual(run(begin().state, [{ type: 'cancel' }]).effect, null, 'while the plan is prepared too');
  // the answer of a run that was canceled is dropped
  r = run(ready(), [{ type: 'create' }, { type: 'cancel' }, { type: 'runFailed', code: 'cancelled' }, { type: 'ran', rules: ['x'] }]);
  assert.strictEqual(r.state.phase, 'closed');
  // the proposal on screen is dropped by Cancel
  r = run(ready(), [{ type: 'create' }, { type: 'ran', rules: ['x'] }, { type: 'cancel' }]);
  assert.strictEqual(r.state.phase, 'closed');
  assert.strictEqual(r.effect, null);
})();

(function testControls() {
  assert.deepStrictEqual(L.controls(begin().state), { primary: null, secondary: { key: 'btnCancel' }, hint: 'lessonsHintWorking' });
  const err = run(begin().state, [{ type: 'planFailed', code: '', detail: 'x' }]).state;
  assert.deepStrictEqual(L.controls(err), { primary: { key: 'lessonsRetry', event: 'retry', enabled: true }, secondary: { key: 'dialogClose' }, hint: 'lessonsHintBanner' });
  const res = run(ready(), [{ type: 'create' }, { type: 'ran', rules: ['a'] }]).state;
  assert.deepStrictEqual(L.controls(res), { primary: { key: 'btnSave', event: 'save', enabled: true }, secondary: { key: 'btnCancel' }, hint: 'lessonsHintResult' });
})();

(function testFileList() {
  const rows = [
    { agent: 'hermes', path: 'C:\\c\\lessons\\hermes.md', exists: true, count: 1, applied: 1, skipped: 0, disabled: true },
    { agent: 'claude', path: 'C:\\c\\lessons\\claude.md', exists: true, count: 3, applied: 3, skipped: 0, disabled: false },
    { agent: 'gone', path: 'C:\\c\\lessons\\gone.md', exists: false, count: 0 },
    { agent: 'nopath', exists: true }, null, 'x'
  ];
  const list = L.fileList(rows);
  assert.deepStrictEqual(list.map((x) => x.agent), ['claude', 'hermes'], 'by name; a file that is not there and a row without a path are left out');
  assert.deepStrictEqual(list[0], { agent: 'claude', path: 'C:\\c\\lessons\\claude.md', count: 3, applied: 3, skipped: 0, disabled: false });
  assert.strictEqual(list[1].disabled, true);
  assert.deepStrictEqual(L.fileList(JSON.stringify(rows)), list, 'a JSON text');
  assert.deepStrictEqual(L.fileList({ files: rows }), list, 'a list inside an object');
  assert.deepStrictEqual(L.fileList({ lessons: rows }), list);
  assert.deepStrictEqual(L.fileList(null), []);
  assert.deepStrictEqual(L.fileList('nonsense'), []);
  assert.deepStrictEqual(L.fileList({}), []);
  assert.strictEqual(L.pickDesc(list[0], tEn), '3 lessons');
  assert.strictEqual(L.pickDesc(list[1], tEn), '1 lesson \u00b7 off in agents.yaml');
  assert.strictEqual(L.pickDesc(list[1], tJa), '1 件 \u00b7 agents.yaml で無効');
})();

(function testWords() {
  // every sentence the dialog, the card and the palette use exists in both languages, without emoji, and the English has no Japanese
  const src = fs.readFileSync(path.join(__dirname, 'lessons.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bkey: '([A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bhint: '([A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\? '([a-z]+[A-Z][A-Za-z]*)' : '([a-z]+[A-Z][A-Za-z]*)'/g)) { keys.add(m[1]); keys.add(m[2]); } // (a ternary between two keys)
  ['lessonsPickCountOne', 'lessonsPickCount', 'lessonsPlanFailed', 'lessonsFailed', 'lessonsSaveFailed', 'lessonsExpired', 'lessonsPlanning',
    'taskLessonsButton', 'taskLessonsTitle', 'taskLessonsApplied', 'taskLessonsAppliedOne', 'taskLessonsSkipped', 'cmdPaletteLessonsFile', 'cmdPaletteLessonsFileDesc',
    'badgeLessons', 'lessonsHintPick', 'lessonsInfoFailed', 'lessonsOpenFailed', 'lessonsNoneYet', 'lessonsSavedNothing'].forEach((k) => keys.add(k));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const markup = html.slice(html.indexOf('id="lesson-modal"'), html.indexOf('<!-- Print / save as PDF'));
  for (const m of markup.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) keys.add(m[1]);
  const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
  const EMOJI = /\p{Extended_Pictographic}/u;
  assert.ok(keys.size > 40, 'the keys were found: ' + keys.size);
  keys.forEach((k) => {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], `en is missing ${k}`);
    assert.ok(typeof I18N.ja[k] === 'string' && I18N.ja[k], `ja is missing ${k}`);
    assert.ok(!CJK.test(I18N.en[k]), `the English ${k} has Japanese in it: ${I18N.en[k]}`);
    assert.ok(!EMOJI.test(I18N.en[k]) && !EMOJI.test(I18N.ja[k]), `${k} has an emoji`);
    // the same {names} in both languages
    const names = (s) => (s.match(/\{[A-Za-z]+\}/g) || []).sort().join(',');
    assert.strictEqual(names(I18N.ja[k]), names(I18N.en[k]), `${k}: the {names} differ between en and ja`);
  });
  assert.ok(!EMOJI.test(src), 'no emoji in lessons.js');
  // the two words of the spec, as they are
  assert.strictEqual(I18N.ja.lessonsNone, '残すほどの教訓はありませんでした。');
  assert.strictEqual(I18N.ja.cmdPaletteLessonsFile, '教訓のファイルを開く');
  assert.strictEqual(I18N.en.cmdPaletteLessonsFile, 'Open the lessons file');
})();

(function testTheScriptHasNoDomAtLoad() {
  // loaded under node with no document: nothing ran, nothing was built, and the dialog says it cannot open
  assert.strictEqual(L.isOpen(), false);
  assert.strictEqual(L.open({ task: TASK, backend: { lessonPlan() {} }, t: tEn }), false, 'without the page\'s markup it does not open');
  assert.strictEqual(L.openPicker({ rows: [{ agent: 'a', path: 'p' }], t: tEn }), false);
})();

console.log('lessons_test.js: all tests passed');
