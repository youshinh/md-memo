// Where the answer of a classic {{ }} slot run is written (B04, B05 of the exploratory review, 2026-09). The real app.js, slot_agent.js ...
// run in one vm context against a hand-made DOM (tests/fixtures/slot_env.mjs); the backend is a stand-in that records what the page
// asks of it and is given results the way the Go side reports them (offsets of the text the run started from).
//
//   B04  the result goes into the NOTE the run started in - not into whatever the pane it started in holds now (a tab switch, a
//        closed split pane): the other note is not touched, nothing is typed into the focused editor
//   B05  two runs at once show the same running mark; each answer replaces its own slot, in any order, and a cancel puts back its own
import { createEnv, assert } from './fixtures/slot_env.mjs';

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

const MARK = '{{ ⟳ 実行中... }}';

// Lets the page run what it held back while the person was typing (a result is merged after a 500 ms pause)
async function settle(env) {
  await env.flush();
  env.clock.now += 1000;
  env.fireAllHeldTimers();
  await env.flush();
}

async function setup() {
  const env = await createEnv({ language: 'ja' });
  env.tabA = env.bridge.getActiveTab();
  return env;
}

// Ctrl+Enter with the caret inside the first `slotText` after `from` of the note on screen; returns the run the page sent
async function startRun(env, slotText, from = 0, editor = env.editor) {
  const at = editor.value.indexOf(slotText, from);
  assert.ok(at !== -1, `the note has no ${slotText}`);
  editor.selectionStart = editor.selectionEnd = at + 3;
  env.window.document.activeElement = editor;
  const before = env.calls.runAgent.length;
  if (editor === env.editor) env.press();
  else env.key(editor, { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true });
  await env.flush();
  assert.equal(env.calls.runAgent.length, before + 1, `Ctrl+Enter started the run of ${slotText}`);
  return env.calls.runAgent[before];
}

// The backend's report of a finished run: the slot at the run's cursor, replaced by `newContent`
const finish = (env, run, newContent) => env.agentAnswer(run, { newContent });

const textOf = (env, tab) => env.bridge.getTabText(tab.id);

// ---------------------------------------------------------------------------------------------------
// B05: several runs of one note
// ---------------------------------------------------------------------------------------------------
check('B05: two runs at once - the answer of the second lands in the second slot, then the first in the first', async () => {
  const env = await setup();
  env.setNote('- {{ code: one }}\n- {{ code: two }}\n', 0);
  const one = await startRun(env, '{{ code: one }}');
  const two = await startRun(env, '{{ code: two }}');
  assert.equal(env.editor.value, `- ${MARK}\n- ${MARK}\n`, 'both show the running mark');

  finish(env, two, 'ANSWER-FOR-TWO');
  await settle(env);
  assert.equal(env.editor.value, `- ${MARK}\n- ANSWER-FOR-TWO\n`, 'slot one still runs');
  finish(env, one, 'ANSWER-FOR-ONE');
  await settle(env);
  assert.equal(env.editor.value, '- ANSWER-FOR-ONE\n- ANSWER-FOR-TWO\n');
  assert.equal(env.slotAgent._runningTaskCount(), 0);
});

check('B05: three runs, every order of the answers, answers of different lengths - each slot gets its own', async () => {
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const answers = ['A', 'B-IS-A-MUCH-LONGER-ANSWER-THAN-THE-SLOT-IT-REPLACES', 'C\nwith\nthree lines'];
  for (const order of orders) {
    const env = await setup();
    env.setNote('a\n{{ code: one }}\nb\n{{ code: two }}\nc\n{{ code: three }}\nd\n', 0);
    const runs = [];
    runs.push(await startRun(env, '{{ code: one }}'));
    runs.push(await startRun(env, '{{ code: two }}'));
    runs.push(await startRun(env, '{{ code: three }}'));
    for (const i of order) {
      finish(env, runs[i], answers[i]);
      await settle(env);
    }
    assert.equal(env.editor.value, `a\n${answers[0]}\nb\n${answers[1]}\nc\n${answers[2]}\nd\n`, 'order ' + order.join(','));
  }
});

check('B05: cancelling the first of two runs puts the first slot back - the second keeps its mark and gets its answer', async () => {
  const env = await setup();
  env.setNote('- {{ code: one }}\n- {{ code: two }}\n', 0);
  const one = await startRun(env, '{{ code: one }}');
  const two = await startRun(env, '{{ code: two }}');
  env.abort(one.reqId);
  assert.equal(env.editor.value, `- {{ code: one }}\n- ${MARK}\n`, 'slot one is back in slot one');
  finish(env, two, 'ANSWER-FOR-TWO');
  await settle(env);
  assert.equal(env.editor.value, '- {{ code: one }}\n- ANSWER-FOR-TWO\n');
});

check('B05: cancelling the second run after the first one has been answered restores the second slot, not the answer', async () => {
  const env = await setup();
  env.setNote('- {{ code: one }}\n- {{ code: two }}\n', 0);
  const one = await startRun(env, '{{ code: one }}');
  const two = await startRun(env, '{{ code: two }}');
  finish(env, one, 'ANSWER-FOR-ONE');
  await settle(env);
  assert.equal(env.editor.value, `- ANSWER-FOR-ONE\n- ${MARK}\n`);
  env.abort(two.reqId);
  assert.equal(env.editor.value, '- ANSWER-FOR-ONE\n- {{ code: two }}\n');
});

check('B05: a run whose mark the person deleted leaves the rest of the note alone (no write at the old offsets)', async () => {
  const env = await setup();
  env.setNote('start\n{{ code: one }}\nend\n', 0);
  const one = await startRun(env, '{{ code: one }}');
  env.editor.value = 'something else entirely, no mark here\n';
  finish(env, one, 'ANSWER');
  await settle(env);
  assert.equal(env.editor.value, 'something else entirely, no mark here\n');
});

// ---------------------------------------------------------------------------------------------------
// B04: the note the run started in
// ---------------------------------------------------------------------------------------------------
const NOTE_A = 'Intro\n\n{{ write a haiku }}\n\nend of a\n';
const NOTE_B = '# Notes B\n\nSome unrelated content in b.md that must not change.\nAnother line here.\n';

check('B04: the person switches to another note while the run goes - the answer lands in the first note only', async () => {
  const env = await setup();
  env.setNote(NOTE_A, 0);
  env.tabA.content = NOTE_A;
  const run = await startRun(env, '{{ write a haiku }}');
  assert.ok(env.editor.value.includes(MARK));
  const tabB = env.window.__testHelper.createTab('b.md', NOTE_B); // becomes the note on screen
  await env.flush();
  assert.equal(env.editor.value, NOTE_B, 'b.md is on screen');
  const typedInto = [];
  const realExec = env.window.document.execCommand;
  env.window.document.execCommand = (cmd, ui, text) => { typedInto.push(env.window.document.activeElement && env.window.document.activeElement.id); return realExec(cmd, ui, text); };

  finish(env, run, 'ANSWER-HAIKU-TEXT-HERE');
  await settle(env);
  assert.equal(env.editor.value, NOTE_B, 'b.md on screen is untouched');
  assert.equal(textOf(env, tabB), NOTE_B);
  assert.equal(textOf(env, env.tabA), 'Intro\n\nANSWER-HAIKU-TEXT-HERE\n\nend of a\n', 'the answer is in a.md, in place of the running mark');
  assert.equal(tabB.isDirty, false, 'b.md is not marked as changed (nothing would be autosaved)');
  assert.equal(env.tabA.isDirty, true, 'a.md is');
  assert.equal(env.slotAgent._runningTaskCount(), 0);
  assert.deepEqual(typedInto, [], 'nothing was typed into an editor');
  // coming back: the note shows the answer
  env.window.__mdMemoRPC.switchTab(env.tabA.id);
  await env.flush();
  assert.equal(env.editor.value, 'Intro\n\nANSWER-HAIKU-TEXT-HERE\n\nend of a\n');
});

check('B04: the same, when the result arrives after the person is back in the first note', async () => {
  const env = await setup();
  env.setNote(NOTE_A, 0);
  env.tabA.content = NOTE_A;
  const run = await startRun(env, '{{ write a haiku }}');
  const tabB = env.window.__testHelper.createTab('b.md', NOTE_B);
  await env.flush();
  env.window.__mdMemoRPC.switchTab(env.tabA.id);
  await env.flush();
  assert.ok(env.editor.value.includes(MARK), 'the running mark is on screen again');
  finish(env, run, 'ANSWER-HAIKU-TEXT-HERE');
  await settle(env);
  assert.equal(env.editor.value, 'Intro\n\nANSWER-HAIKU-TEXT-HERE\n\nend of a\n');
  assert.equal(textOf(env, tabB), NOTE_B);
});

check('B04: the note was closed while its run went - the answer is dropped and nothing else changes', async () => {
  const env = await setup();
  env.setNote(NOTE_A, 0);
  env.tabA.content = NOTE_A;
  const run = await startRun(env, '{{ write a haiku }}');
  const tabB = env.window.__testHelper.createTab('b.md', NOTE_B);
  await env.flush();
  env.window.__mdMemoRPC.closeTab(env.tabA.id);
  await env.flush();
  if (!env.hidden('confirm-modal')) { env.el('confirm-modal-dontsave').onclick(); await env.flush(); }
  finish(env, run, 'ANSWER-HAIKU-TEXT-HERE');
  await settle(env);
  assert.equal(env.editor.value, NOTE_B);
  assert.equal(textOf(env, tabB), NOTE_B);
  assert.equal(tabB.isDirty, false);
});

check('B04: a run started in the second pane, the pane closed - the answer is not typed into the note that stays on screen', async () => {
  const env = await setup();
  const tabB = env.window.__testHelper.createTab('b.md', NOTE_B);
  await env.flush();
  env.window.__mdMemoRPC.switchTab(env.tabA.id);
  await env.flush();
  env.setNote(NOTE_A, 0);
  env.tabA.content = NOTE_A;
  env.window.__mdMemoRPC.switchTab(tabB.id); // b.md is the note in the main pane
  await env.flush();
  env.window.__testHelper.openSplitEditor(env.tabA.id); // a.md on the right
  await env.flush();
  const second = env.el('editor-secondary');
  assert.equal(second.value, NOTE_A, 'the right pane shows a.md');
  const run = await startRun(env, '{{ write a haiku }}', 0, second);
  assert.ok(second.value.includes(MARK), 'the run started in the right pane');
  const typedInto = [];
  const realExec = env.window.document.execCommand;
  env.window.document.execCommand = (cmd, ui, text) => { typedInto.push(env.window.document.activeElement && env.window.document.activeElement.id); return realExec(cmd, ui, text); };

  env.window.__testHelper.closeSecondaryPane();
  await env.flush();
  finish(env, run, 'ANSWER-HAIKU-TEXT-HERE');
  await settle(env);
  assert.equal(env.editor.value, NOTE_B, 'the note on screen is untouched');
  assert.equal(textOf(env, tabB), NOTE_B);
  assert.equal(textOf(env, env.tabA), 'Intro\n\nANSWER-HAIKU-TEXT-HERE\n\nend of a\n', 'the answer is in a.md');
  assert.deepEqual(typedInto, [], 'nothing was typed into an editor');
  assert.equal(tabB.isDirty, false);
});

check('B04: the split pane stays open - the answer goes into the pane that shows the note, wherever the focus is', async () => {
  const env = await setup();
  const tabB = env.window.__testHelper.createTab('b.md', NOTE_B);
  await env.flush();
  env.window.__mdMemoRPC.switchTab(env.tabA.id);
  await env.flush();
  env.setNote(NOTE_A, 0);
  env.tabA.content = NOTE_A;
  env.window.__mdMemoRPC.switchTab(tabB.id);
  await env.flush();
  env.window.__testHelper.openSplitEditor(env.tabA.id);
  await env.flush();
  const second = env.el('editor-secondary');
  const run = await startRun(env, '{{ write a haiku }}', 0, second);
  env.editor.focus();
  finish(env, run, 'ANSWER-HAIKU-TEXT-HERE');
  await settle(env);
  assert.equal(second.value, 'Intro\n\nANSWER-HAIKU-TEXT-HERE\n\nend of a\n', 'the right pane shows the answer');
  assert.equal(env.editor.value, NOTE_B, 'the left pane is untouched');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL: ' + name + '\n  ' + (err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err));
  }
}
console.log(failed ? `${failed} of ${queue.length} slot merge target test(s) FAILED.` : `All ${queue.length} slot merge target tests passed.`);
process.exit(failed ? 1 : 0);
