// Cancel a running slot from the task panel: the note must be exactly as the user had it before the run (B9).
// The real app.js, slot_agent.js, task_manager.js ... run in one vm context against a hand-made DOM (tests/fixtures/slot_env.mjs).
// What the backend answers after a cancel is not invented here: tests/fixtures/slot_cancel_answers.json holds the answers a real
// run of RunSlotAgentAsync gave (TestRunSlotAgentAsync_CancelAnswersMatchTheRecordedFixture in app_slot_cancel_test.go records
// them and fails when they change). Three kinds of runs: a recipe ([>> ... ]), a classic slot ({{ ... }}) and an agent task
// ({{ @agent ... }}, whose answer goes below its line).
import fs from 'node:fs';
import { createEnv, I18N, assert } from './fixtures/slot_env.mjs';

const FIX = JSON.parse(fs.readFileSync('tests/fixtures/slot_cancel_answers.json', 'utf-8'));

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

// slot: the text a run starts from; make(t): the same kind of slot with another instruction; mark: what the note shows while it runs
const KINDS = {
  recipe: { slot: '[>> instruction ]', make: (t) => `[>> ${t} ]`, mark: '[>> ⟳ 実行中... ]' },
  classic: { slot: '{{ code: x }}', make: (t) => `{{ code: ${t} }}`, mark: '{{ ⟳ 実行中... }}' },
  agentTask: { slot: '{{ @claude x }}', make: (t) => `{{ @claude ${t} }}`, mark: null }
};

// The backend's answer to a cancel for `slotText` at its place in `note`: the recorded answer with the offsets (UTF-16) and the
// texts of this note.
function canceledAnswer(kind, reqId, note, slotText, from = 0) {
  const start = note.indexOf(slotText, from);
  assert.ok(start !== -1, `the note has no ${slotText}`);
  return Object.assign({}, FIX[kind].answer, { reqId, startOffset: start, endOffset: start + slotText.length, oldContent: slotText, newContent: slotText });
}

// Lets the page run what it held back while the user was typing (the merge of a result waits for a 500 ms pause)
async function settle(env) {
  await env.flush();
  env.clock.now += 1000;
  env.fireAllHeldTimers();
  await env.flush();
}

// Ctrl+Enter with the caret in the first `slotText` after `from`; returns the request the page sent to the backend
async function startRun(env, note, slotText, from = 0) {
  if (env.editor.value !== note) env.setNote(note);
  const at = note.indexOf(slotText, from);
  assert.ok(at !== -1, `the note has no ${slotText}`);
  env.editor.selectionStart = env.editor.selectionEnd = at + 3;
  const before = env.calls.runAgent.length;
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, before + 1, `Ctrl+Enter started the run of ${slotText}`);
  assert.notEqual(env.editor.value, note, 'the note shows that the run is going');
  return env.calls.runAgent[before];
}

const notes = (slot) => ({
  lf: `top\n${slot}\nbottom\n`,
  crlf: `top\r\n${slot}\r\nbottom\r\n`,
  unicode: `日本語😀\n二行目 🎉\n${slot}\n末尾😀`
});

// ---------------------------------------------------------------------------------------------------
// 1. One run, all three kinds, LF / CRLF / Japanese with surrogate pairs; every order of the two reports
// ---------------------------------------------------------------------------------------------------
for (const [kind, spec] of Object.entries(KINDS)) {
  for (const [noteName, note] of Object.entries(notes(spec.slot))) {
    check(`${kind}, ${noteName} note: the task panel's Cancel, then the backend's answer: the note is exactly as it was`, async () => {
      const env = await createEnv({ language: 'ja' });
      const run = await startRun(env, note, spec.slot);
      if (spec.mark) assert.ok(env.editor.value.includes(spec.mark), 'the running mark is in the note');
      env.abort(run.reqId);
      assert.equal(env.editor.value, note, 'the panel restored the note at once');
      assert.ok(env.calls.cancelAgent.includes(run.reqId), 'the backend was asked to stop the run');
      assert.equal(env.window.TaskManager.getActiveTasks().length, 0);
      assert.equal(env.warnings.length, 0, 'nothing to warn about: ' + env.warnings.join(' | '));
      assert.equal(env.messages.length, 0, 'and nothing to say: ' + env.messages.join(' | '));

      env.window.__onSlotAgentResult(canceledAnswer(kind, run.reqId, note, spec.slot));
      await settle(env);
      assert.equal(env.editor.value, note, "the backend's late answer leaves the note alone");
      assert.equal(env.slotAgent._runningTaskCount(), 0);
      assert.equal(env.messages.length, 0);
    });

    check(`${kind}, ${noteName} note: the backend's answer first (the page did not cancel): the note is put back, the task ends canceled`, async () => {
      const env = await createEnv({ language: 'ja' });
      const run = await startRun(env, note, spec.slot);
      env.window.__onSlotAgentResult(canceledAnswer(kind, run.reqId, note, spec.slot));
      await settle(env);
      assert.equal(env.editor.value, note, 'a run the backend reports as canceled leaves no running mark behind');
      assert.equal(env.window.TaskManager.getActiveTasks().length, 0);
      assert.equal(env.el('stat-tasks-count').textContent, I18N.ja.taskCanceledBadge, 'the task ends as canceled, not as completed');
      assert.equal(env.slotAgent._runningTaskCount(), 0);

      env.abort(run.reqId); // a Cancel click on a card that is gone changes nothing
      assert.equal(env.editor.value, note);
    });
  }

  check(`${kind}: a double cancel (two clicks, or the panel and the status bar) changes nothing the second time`, async () => {
    const env = await createEnv({ language: 'ja' });
    const note = notes(spec.slot).crlf;
    const run = await startRun(env, note, spec.slot);
    env.abort(run.reqId);
    assert.equal(env.editor.value, note);
    // the user types something, then cancels again: the second cancel must not touch it
    env.editor.value = 'typed after\r\n' + env.editor.value;
    const typed = env.editor.value;
    env.abort(run.reqId);
    env.slotAgent.cancelSlotExecution(run.reqId);
    assert.equal(env.editor.value, typed, 'the second cancel finds nothing to restore and touches nothing');
    assert.equal(env.messages.length, 0, 'and says nothing: there is nothing wrong');
    env.window.__onSlotAgentResult(canceledAnswer(kind, run.reqId, note, spec.slot));
    await settle(env);
    assert.equal(env.editor.value, typed);
  });
}

// ---------------------------------------------------------------------------------------------------
// 2. The running mark reads the same for every run: the right one is put back
// ---------------------------------------------------------------------------------------------------
for (const [kind, spec] of Object.entries(KINDS).filter(([, s]) => s.mark)) {
  check(`${kind}: a running mark that an earlier run left behind (above or below) is not mistaken for this run's`, async () => {
    for (const note of [
      `x\n${spec.mark}\ny\n${spec.slot}\nz`, // a leftover above
      `x\n${spec.slot}\ny\n${spec.mark}\nz`, // a leftover below
      `${spec.mark}${spec.mark}\n${spec.slot}`, // leftovers stacked on one line
      `x\n${spec.mark}\n${spec.slot}\n${spec.mark}\nz`, // on both sides, next to the slot
      `x\r\n${spec.mark}\r\ny\r\n${spec.slot}\r\nz\r\n` // CRLF
    ]) {
      const env = await createEnv({ language: 'ja' });
      const run = await startRun(env, note, spec.slot);
      env.abort(run.reqId);
      assert.equal(env.editor.value, note, 'the leftover is left alone and this run\'s slot is back: ' + JSON.stringify(note));
      env.window.__onSlotAgentResult(canceledAnswer(kind, run.reqId, note, spec.slot));
      await settle(env);
      assert.equal(env.editor.value, note);
    }
  });

  check(`${kind}: two runs at once show the same mark; canceling one puts back that one, in either order`, async () => {
    const note = `a\n${spec.slot.replace('instruction', 'one').replace('x', 'one')}\nb\n${spec.slot.replace('instruction', 'two').replace('x', 'two')}\nc`;
    const one = spec.slot.replace('instruction', 'one').replace('x', 'one');
    const two = spec.slot.replace('instruction', 'two').replace('x', 'two');
    for (const order of [['second', 'first'], ['first', 'second']]) {
      const env = await createEnv({ language: 'ja' });
      const runOne = await startRun(env, note, one);
      const runTwo = await startRun(env, env.editor.value, two);
      assert.equal(env.editor.value, `a\n${spec.mark}\nb\n${spec.mark}\nc`, 'both runs show the same mark');
      const runs = { first: [runOne, one], second: [runTwo, two] };
      const mid = order[0] === 'first' ? `a\n${one}\nb\n${spec.mark}\nc` : `a\n${spec.mark}\nb\n${two}\nc`;
      env.abort(runs[order[0]][0].reqId);
      assert.equal(env.editor.value, mid, `${order[0]} canceled first: only its slot is back`);
      env.abort(runs[order[1]][0].reqId);
      assert.equal(env.editor.value, note, `then the other`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// 3. The note is edited while the run goes
// ---------------------------------------------------------------------------------------------------
for (const [kind, spec] of Object.entries(KINDS).filter(([, s]) => s.mark)) {
  check(`${kind}: the note edited while the run goes (above, on the same line, below, CRLF): the cancel puts the instruction back and keeps every edit`, async () => {
    for (const eol of ['\n', '\r\n']) {
      const note = `top${eol}line two${eol}${spec.slot}${eol}bottom${eol}`;
      const cases = [
        ['text added at the top', (v) => 'NEW' + eol + v, 'NEW' + eol + note],
        ['text added at the end', (v) => v + 'more' + eol, note + 'more' + eol],
        ['a line added right above', (v) => v.replace(`line two${eol}`, `line two${eol}inserted${eol}`), `top${eol}line two${eol}inserted${eol}${spec.slot}${eol}bottom${eol}`],
        ['text typed in front of the mark, on its line', (v) => v.replace(spec.mark, 'lead ' + spec.mark), `top${eol}line two${eol}lead ${spec.slot}${eol}bottom${eol}`],
        ['text typed behind the mark, on its line', (v) => v.replace(spec.mark, spec.mark + ' tail'), `top${eol}line two${eol}${spec.slot} tail${eol}bottom${eol}`],
        ['the lines around it rewritten', (v) => v.replace('line two', 'LINE 2').replace('bottom', 'BOTTOM'), `top${eol}LINE 2${eol}${spec.slot}${eol}BOTTOM${eol}`],
        ['the whole note pushed down by 400 characters', (v) => 'x'.repeat(400) + v, 'x'.repeat(400) + note]
      ];
      for (const [label, edit, expected] of cases) {
        const env = await createEnv({ language: 'ja' });
        const run = await startRun(env, note, spec.slot);
        env.editor.value = edit(env.editor.value);
        env.abort(run.reqId);
        assert.equal(env.editor.value, expected, `${kind}, ${JSON.stringify(eol)}, ${label}`);
        assert.equal(env.messages.length, 0, label + ': ' + env.messages.join(' | '));
      }
    }
  });

  check(`${kind}: a leftover mark above and an edit above at once`, async () => {
    const note = `x\n${spec.mark}\ny\n${spec.slot}\nz`;
    const env = await createEnv({ language: 'ja' });
    const run = await startRun(env, note, spec.slot);
    env.editor.value = 'NEW LINE\n' + env.editor.value.replace('y\n', 'y changed\n');
    env.abort(run.reqId);
    assert.equal(env.editor.value, `NEW LINE\nx\n${spec.mark}\ny changed\n${spec.slot}\nz`);
  });
}

// ---------------------------------------------------------------------------------------------------
// 4. The note is not the one on screen
// ---------------------------------------------------------------------------------------------------
for (const [kind, spec] of Object.entries(KINDS)) {
  check(`${kind}: another note is on screen when the run is canceled: the run's own note is put back, the one shown is not touched`, async () => {
    const note = notes(spec.slot).lf;
    const env = await createEnv({ language: 'ja' });
    const rpc = env.window.__mdMemoRPC;
    const tabA = env.bridge.getActiveTab().id;
    const run = await startRun(env, note, spec.slot);
    rpc.newTab('B.md', 'B の内容\nsecond line');
    const tabB = env.bridge.getActiveTab().id;
    assert.notEqual(tabB, tabA);
    const shownB = env.editor.value;
    assert.equal(shownB, 'B の内容\nsecond line');

    env.abort(run.reqId);
    assert.equal(env.editor.value, shownB, 'the note on screen is not touched');
    assert.equal(rpc.getBuffer(tabA).content, note, "the run's own note is exactly as it was");
    assert.equal(env.messages.length, 0);

    env.window.__onSlotAgentResult(canceledAnswer(kind, run.reqId, note, spec.slot));
    await settle(env);
    assert.equal(env.editor.value, shownB);
    assert.equal(rpc.getBuffer(tabA).content, note);
    rpc.switchTab(tabA);
    assert.equal(env.editor.value, note, 'and it is what the user finds on going back');
  });
}

check('a note that holds a dollar sign pattern in its instruction comes back as written, also from a background tab', async () => {
  const slot = '[>> price is $& then $$ and $` and $\' ]';
  const note = `top\n${slot}\nbottom`;
  const env = await createEnv({ language: 'ja' });
  const rpc = env.window.__mdMemoRPC;
  const tabA = env.bridge.getActiveTab().id;
  const run = await startRun(env, note, slot);
  env.abort(run.reqId);
  assert.equal(env.editor.value, note, 'on screen');

  const env2 = await createEnv({ language: 'ja' });
  const rpc2 = env2.window.__mdMemoRPC;
  const tabA2 = env2.bridge.getActiveTab().id;
  const run2 = await startRun(env2, note, slot);
  rpc2.newTab('B.md', 'b');
  env2.abort(run2.reqId);
  assert.equal(rpc2.getBuffer(tabA2).content, note, 'in a background tab');
  assert.ok(tabA && rpc);
});

check('a note that was closed while its run went: the cancel has nothing to restore and says nothing', async () => {
  const note = notes(KINDS.recipe.slot).lf;
  const env = await createEnv({ language: 'ja' });
  const rpc = env.window.__mdMemoRPC;
  const tabA = env.bridge.getActiveTab().id;
  const run = await startRun(env, note, KINDS.recipe.slot);
  const tabAObject = env.bridge.getActiveTab();
  rpc.newTab('B.md', 'b');
  tabAObject.isDirty = false; // closing a note with unsaved changes asks first
  rpc.closeTab(tabA);
  await env.flush();
  assert.equal(env.bridge.getTabText(tabA), null, 'the note is gone');
  env.abort(run.reqId);
  assert.equal(env.editor.value, 'b');
  assert.equal(env.messages.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// 5. A restore that cannot be done is never silent
// ---------------------------------------------------------------------------------------------------
for (const language of ['en', 'ja']) {
  check(`the running mark was typed over: the cancel says so and gives the instruction back as text (${language})`, async () => {
    const spec = KINDS.recipe;
    const note = `top\n${spec.slot}\nbottom`;
    const env = await createEnv({ language });
    const run = await startRun(env, note, spec.slot);
    const edited = env.editor.value.replace('実行中', '実 X 行中');
    env.editor.value = edited;
    env.abort(run.reqId);
    assert.equal(env.editor.value, edited, 'the note (with what the user typed) is not touched');
    const text = I18N[language].slotCancelNotRestored;
    assert.ok(text && text.includes('{text}'), 'the message exists in this language, with the instruction in it');
    assert.equal(env.toast(), text.replace('{text}', spec.slot), 'a message tells what happened and what the text was');
    assert.equal(env.warnings.length, 1, 'and the console has the warning: ' + env.warnings.join(' | '));
    assert.ok(env.warnings[0].includes(spec.slot), 'with the text: ' + env.warnings[0]);
    assert.equal(env.window.TaskManager.getActiveTasks().length, 0, 'the task ends canceled all the same');
  });
}

check('the running mark is gone because the user undid the start of the run: the text is back already, nothing to say', async () => {
  for (const spec of [KINDS.recipe, KINDS.classic]) {
    const note = `top\n${spec.slot}\nbottom`;
    const env = await createEnv({ language: 'ja' });
    const run = await startRun(env, note, spec.slot);
    env.undo();
    assert.equal(env.editor.value, note, 'the native undo took the mark away');
    env.abort(run.reqId);
    assert.equal(env.editor.value, note);
    assert.equal(env.messages.length, 0);
    assert.equal(env.warnings.length, 0);
  }
});

check('a long or multi-line instruction is shortened to one line in the message', async () => {
  const slot = '[>> ' + 'very long instruction '.repeat(12) + '\nsecond line ]';
  const note = `a\n${slot}\nb`;
  const env = await createEnv({ language: 'en' });
  const run = await startRun(env, note, slot);
  env.editor.value = env.editor.value.replace('実行中', '実 X 行中');
  env.abort(run.reqId);
  const shown = env.toast();
  assert.ok(shown.startsWith(I18N.en.slotCancelNotRestored.split('{text}')[0]), shown);
  assert.ok(!shown.includes('\n'), 'one line');
  assert.ok(shown.length < 260, 'short: ' + shown.length);
});

// ---------------------------------------------------------------------------------------------------
// 6. What the backend's own file write does to a running slot
// ---------------------------------------------------------------------------------------------------
check('the backend writes the note file when a run starts and the file watcher reports it: a running mark is never replaced by the whole file', async () => {
  for (const kind of ['classic', 'recipe']) {
    const spec = KINDS[kind];
    const note = `top\n${spec.slot}\nbottom`;
    const env = await createEnv({ language: 'ja', backend: { readFileByPath: async () => ({ content: note }), watchActiveFile: () => {}, unwatchActiveFile: () => {} } });
    env.window.__mdMemoRPC.newTab('A.md', note, 'C:\\notes\\A.md');
    const run = await startRun(env, note, spec.slot);
    const running = env.editor.value;
    env.window.__onExternalFileChanged('C:\\notes\\A.md');
    await settle(env);
    assert.equal(env.editor.value, running, `${kind}: the file report does not touch the note`);
    env.abort(run.reqId);
    assert.equal(env.editor.value, note);
  }
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 8).join('\n  ') : err}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${queue.length} slot cancel test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} slot cancel tests passed.`);
