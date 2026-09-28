// Ctrl+Z on a completed {{ }} / {{ @agent }} slot result reverts it via trySlotUndo (slot_agent.js): a
// content-search revert, not the browser's own native undo, so it still finds its target even after other
// edits happened in between. Because Ctrl+Z's own preventDefault() stops the browser's native undo from
// ever running, the browser's native redo has nothing to redo afterwards: pressing Ctrl+Y used to do
// nothing at all, and the only way back to the generated text was running the generation again. This
// file is the regression guard for trySlotRedo, which restores that symmetry.
import { createEnv } from './fixtures/slot_env.mjs';
import assert from 'node:assert/strict';

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

async function settle(env) {
  await env.flush();
  env.clock.now += 1000;
  env.fireAllHeldTimers();
  await env.flush();
}

// Ctrl+Enter on the slot, then the backend's answer merging in (a completed run, not a cancel).
async function runToCompletion(env, note, slotText, newContent) {
  env.setNote(note);
  const at = note.indexOf(slotText);
  assert.ok(at !== -1, `the note has no ${slotText}`);
  env.editor.selectionStart = env.editor.selectionEnd = at + 3;
  const before = env.calls.runAgent.length;
  env.press();
  await env.flush();
  const run = env.calls.runAgent[before];
  assert.ok(run, 'Ctrl+Enter started the run');
  env.window.__onSlotAgentResult({ reqId: run.reqId, newContent });
  await settle(env);
  assert.ok(env.editor.value.includes(newContent), 'the result merged into the note');
  return run;
}

const ctrlZ = (env) => env.key(env.editor, { key: 'z', code: 'KeyZ', ctrlKey: true });
const ctrlY = (env) => env.key(env.editor, { key: 'y', code: 'KeyY', ctrlKey: true });
const ctrlShiftZ = (env) => env.key(env.editor, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });

check('Ctrl+Z reverts a completed slot result, and Ctrl+Y restores it (previously a no-op)', async () => {
  const env = await createEnv({ language: 'ja' });
  const note = 'Result: {{ calc: 40 + 2 }}\nMore notes';
  await runToCompletion(env, note, '{{ calc: 40 + 2 }}', '42 (The answer)');
  const afterMerge = env.editor.value;

  const undoEvent = ctrlZ(env);
  assert.equal(undoEvent.defaultPrevented, true, 'Ctrl+Z was claimed by trySlotUndo');
  assert.ok(env.editor.value.includes('{{ calc: 40 + 2 }}'), 'reverted to the original slot text');
  assert.ok(!env.editor.value.includes('42 (The answer)'));
  const afterUndo = env.editor.value;

  const redoEvent = ctrlY(env);
  assert.equal(redoEvent.defaultPrevented, true, 'Ctrl+Y was claimed by trySlotRedo');
  assert.equal(env.editor.value, afterMerge, 'Ctrl+Y restored exactly the merged result');

  // Toggleable back and forth, not a one-shot: trySlotUndo re-pushes the entry it reverted, and
  // trySlotRedo does the same, so either key keeps working after the other fires.
  assert.equal(ctrlZ(env).defaultPrevented, true);
  assert.equal(env.editor.value, afterUndo, 'Ctrl+Z reverts it again');
  assert.equal(ctrlY(env).defaultPrevented, true);
  assert.equal(env.editor.value, afterMerge, 'Ctrl+Y restores it again');
});

check('Cmd+Shift+Z (Ctrl+Shift+Z) redoes too, the conventional alternate redo combo', async () => {
  const env = await createEnv({ language: 'ja' });
  const note = 'Result: {{ calc: 1 + 1 }}\n';
  await runToCompletion(env, note, '{{ calc: 1 + 1 }}', '2');
  const afterMerge = env.editor.value;
  ctrlZ(env);
  assert.ok(env.editor.value.includes('{{ calc: 1 + 1 }}'), 'reverted to the original slot text');
  const e = ctrlShiftZ(env);
  assert.equal(e.defaultPrevented, true);
  assert.equal(env.editor.value, afterMerge, 'Ctrl+Shift+Z redid the revert');
});

check('Ctrl+Y with nothing to redo is left alone (not claimed, falls through)', async () => {
  const env = await createEnv({ language: 'ja' });
  env.setNote('just some text, never any slot activity\n');
  const e = ctrlY(env);
  assert.equal(e.defaultPrevented, false, 'Ctrl+Y is not swallowed when trySlotRedo has nothing to do');
});

check('typing after Ctrl+Z drops the pending redo: Ctrl+Y no longer reinserts stale AI text', async () => {
  const env = await createEnv({ language: 'ja' });
  const note = 'Result: {{ calc: 5 + 5 }}\nMore notes';
  await runToCompletion(env, note, '{{ calc: 5 + 5 }}', '10 (The answer)');
  ctrlZ(env);
  assert.ok(env.editor.value.includes('{{ calc: 5 + 5 }}'));

  // The user types something else instead of pressing Ctrl+Y right away: mutate the value the way
  // execCommand's mock does, then dispatch the 'input' event the browser would fire for it.
  env.editor.value = 'edited by hand\n' + env.editor.value;
  env.editor.dispatchEvent({ type: 'input' });

  const e = ctrlY(env);
  assert.equal(e.defaultPrevented, false, 'nothing left to redo once the text has moved on');
  assert.ok(env.editor.value.startsWith('edited by hand'), 'the hand edit is untouched');
});

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
  console.error(`\n${failed} of ${queue.length} slot undo/redo test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} slot undo/redo tests passed.`);
