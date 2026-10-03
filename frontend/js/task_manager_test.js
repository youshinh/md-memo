// Test Suite for TaskManager frontend module
const assert = require('assert');

// Mock browser environment
const mockListeners = {};
const mockElements = {};
const documentMock = {
  getElementById: (id) => {
    // Return the SAME object on every call for a given id (like a real DOM),
    // so a property task_manager.js sets on an element (e.g. statTasksEl.title)
    // is observable by a test that looks the element up again afterward.
    if (mockElements[id]) return mockElements[id];
    const el = {
      id: id,
      className: '',
      classList: {
        classes: new Set(),
        add: function(c) { this.classes.add(c); },
        remove: function(c) { this.classes.delete(c); },
        contains: function(c) { return this.classes.has(c); }
      },
      textContent: '',
      innerHTML: '',
      title: '',
      querySelectorAll: () => [],
      addEventListener: function(evt, fn) {
        if (!mockListeners[id]) mockListeners[id] = {};
        mockListeners[id][evt] = fn;
      }
    };
    mockElements[id] = el;
    return el;
  },
  addEventListener: (evt, fn) => {
    mockListeners['doc_' + evt] = fn;
  },
  readyState: 'complete'
};

global.document = documentMock;
global.window = {
  backend: {
    cancelSlotAgent: (id) => {
      global.__canceledBackendId = id;
    },
    getSlotHoverPeek: async (id) => {
      return "Processing step 2/3...";
    }
  }
};

require('./task_manager.js');
const TaskManager = global.window.TaskManager;

console.log("Running TaskManager Test Suite...");

// Test 1: Add Task
console.log("Test 1: addTask registers task correctly");
let canceled = false;
const task = TaskManager.addTask({
  id: 'task-test-1',
  type: 'slot',
  agent: 'agy',
  instruction: '買い物メモの整理',
  onCancel: () => {
    canceled = true;
  }
});

assert(task !== null, 'Task should be created');
assert.strictEqual(task.id, 'task-test-1');
assert.strictEqual(task.agent, 'agy');
assert.strictEqual(task.status, 'running');
assert.strictEqual(TaskManager.getActiveCount(), 1);
console.log("PASS: Test 1");

// Test 2: Cancel Task
console.log("Test 2: cancelTask triggers onCancel and backend RPC");
TaskManager.cancelTask('task-test-1');
assert.strictEqual(canceled, true, 'onCancel callback must be called');
assert.strictEqual(global.__canceledBackendId, 'task-test-1', 'Backend RPC must be invoked');
assert.strictEqual(TaskManager.getActiveCount(), 0, 'No running tasks after cancel');
console.log("PASS: Test 2");

// Test 3: Multiple tasks and updates
console.log("Test 3: Multiple tasks and status updates");
const t2 = TaskManager.addTask({ id: 'task-2', agent: 'claude-code', instruction: 'code task' });
const t3 = TaskManager.addTask({ id: 'task-3', agent: 'cli', instruction: 'git status' });
assert.strictEqual(TaskManager.getActiveCount(), 2);

TaskManager.updateTask('task-2', { status: 'completed' });
assert.strictEqual(TaskManager.getActiveCount(), 1);

TaskManager.updateTask('task-3', { status: 'failed', error: 'exit code 1' });
assert.strictEqual(TaskManager.getActiveCount(), 0);
console.log("PASS: Test 3");

// Test 3b (C7-06): the card of a failed task says why. The task is copied into the history when its status changes, so the reason
// has to be on the task before that copy is made.
console.log("Test 3b: a failed task's history card shows the reason, in the same update that failed it");
{
  TaskManager.clearHistory(); // (Test 3's task-3 failed with a reason too: its card shows it now)
  TaskManager.showPanel();
  TaskManager.addTask({ id: 'task-fail-reason', agent: 'claude-code', instruction: 'will fail' });
  TaskManager.updateTask('task-fail-reason', { status: 'failed', error: 'agent exploded <b>', lastOutput: 'last words' });
  const list = documentMock.getElementById('tasks-panel-list').innerHTML;
  assert(list.includes('class="task-card-error">agent exploded &lt;b&gt;</div>'), 'the reason is on the card, and is escaped: ' + list.slice(0, 600));
  // a task that fails with no reason shows no empty line, and a completed one none either
  TaskManager.addTask({ id: 'task-fail-silent', agent: 'claude-code', instruction: 'no reason' });
  TaskManager.updateTask('task-fail-silent', { status: 'failed' });
  TaskManager.addTask({ id: 'task-done', agent: 'claude-code', instruction: 'fine' });
  TaskManager.updateTask('task-done', { status: 'completed', error: '' });
  const after = documentMock.getElementById('tasks-panel-list').innerHTML;
  assert.strictEqual((after.match(/class="task-card-error"/g) || []).length, 1, 'only the card that has a reason shows one');
  TaskManager.hidePanel();
  TaskManager.clearHistory();
}
console.log("PASS: Test 3b");

// Test 3c: snapshot() is what the JSON-RPC task.list returns: a plain read-only copy with the kind and label of each task, never
// its instruction or output text, and `cancellable` says whether Cancel really stops the work.
console.log("Test 3c: snapshot lists running tasks and the history without the instruction text");
{
  TaskManager.clearHistory();
  assert.deepStrictEqual(TaskManager.snapshot(), { running: [], recent: [] }, 'nothing running and no history');

  TaskManager.addTask({ id: 'snap-slot', type: 'slot', agent: 'claude-code', instruction: 'secret prompt text', onCancel: () => {} });
  TaskManager.addTask({ id: 'snap-llm', type: 'llm', agent: 'LLM', instruction: 'summarize', onCancel: () => {} });
  TaskManager.addTask({ id: 'snap-slot-no-cancel', type: 'slot', agent: 'agy', instruction: 'x' });
  TaskManager.addTask({ id: 'snap-action', type: 'action', agent: 'CLI', instruction: 'rm -rf somewhere --token abc' });
  TaskManager.updateTask('snap-slot', { lastOutput: 'private output' });

  let snap = TaskManager.snapshot();
  assert.deepStrictEqual(snap.recent, []);
  assert.deepStrictEqual(snap.running.map((x) => x.id).sort(), ['snap-action', 'snap-llm', 'snap-slot', 'snap-slot-no-cancel']);
  const byId = (id) => snap.running.find((x) => x.id === id);
  assert.deepStrictEqual(Object.keys(byId('snap-slot')).sort(), ['cancellable', 'id', 'kind', 'label', 'startedAt', 'status'].sort(), 'no finishedAt or error while running');
  assert.strictEqual(byId('snap-slot').kind, 'slot');
  assert.strictEqual(byId('snap-slot').label, 'claude-code');
  assert.strictEqual(byId('snap-slot').status, 'running');
  assert.strictEqual(typeof byId('snap-slot').startedAt, 'number');
  assert.strictEqual(byId('snap-slot').cancellable, true, 'a task with its own cancel');
  assert.strictEqual(byId('snap-slot-no-cancel').cancellable, true, 'an agent run: the backend stops the process');
  assert.strictEqual(byId('snap-action').cancellable, false, 'a task nothing can stop');
  const text = JSON.stringify(snap);
  assert(!text.includes('secret prompt text') && !text.includes('private output') && !text.includes('rm -rf'), 'no instruction or output text leaves: ' + text);

  // a copy: changing it changes nothing in the manager
  snap.running[0].status = 'tampered';
  assert.strictEqual(TaskManager.snapshot().running.every((x) => x.status === 'running'), true);

  TaskManager.updateTask('snap-llm', { status: 'failed', error: 'HTTP 401: bad key sk-abcdefghijklmnopqrstuvwxyz0123456789\nsecond line' });
  TaskManager.updateTask('snap-action', { status: 'completed', error: '' });
  TaskManager.cancelTask('snap-slot');
  snap = TaskManager.snapshot();
  assert.deepStrictEqual(snap.running.map((x) => x.id), ['snap-slot-no-cancel']);
  assert.deepStrictEqual(snap.recent.map((x) => x.id), ['snap-slot', 'snap-action', 'snap-llm'], 'newest first');
  assert.deepStrictEqual(snap.recent.map((x) => x.status), ['canceled', 'completed', 'failed']);
  assert(snap.recent.every((x) => x.cancellable === false && typeof x.finishedAt === 'number'), 'finished tasks are not cancellable and have a finish time');
  const failed = snap.recent.find((x) => x.id === 'snap-llm');
  assert.strictEqual(failed.error, 'HTTP 401: bad key [masked] second line', 'one line, the key-like run masked');
  assert.strictEqual('error' in snap.recent.find((x) => x.id === 'snap-action'), false, 'no empty error key');

  TaskManager.cancelTask('snap-slot-no-cancel');
  TaskManager.clearHistory();
  assert.strictEqual(TaskManager.getActiveCount(), 0);
}
console.log("PASS: Test 3c");

// Test 3d: the Lessons button and line of a finished agent run (docs/design/lessons-2026-10.md section 7). A card keeps the end of the output, the
// exit code and the numbers of lessons that went into the run; the button is offered on a failed or completed agent run only, and only when the
// backend can make the proposal; the line says how many lessons were applied and how many did not fit.
console.log("Test 3d: the Lessons button, the lessons line, and what a card keeps for the dialog");
{
  const had = global.window.backend.lessonPlan;
  TaskManager.clearHistory();
  TaskManager.showPanel();
  const finish = (id, update, opts) => {
    TaskManager.addTask(Object.assign({ id, type: 'slot', agent: 'claude-code', instruction: 'fix <it>' }, opts || {}));
    TaskManager.updateTask(id, update);
  };
  const list = () => documentMock.getElementById('tasks-panel-list').innerHTML;
  const buttonCount = () => (list().match(/class="btn-task-lessons"/g) || []).length;

  // an older backend: no button at all, and the line still tells what went into a run
  delete global.window.backend.lessonPlan;
  finish('old-1', { status: 'failed', error: 'Exit Code 1', output: 'log', exitCode: 1, lessonsApplied: 2 });
  assert.strictEqual(buttonCount(), 0, 'no lessonPlan in the backend: no button');
  assert(list().includes('<span class="task-lessons-line">教訓 2 件を適用</span>'), 'but the line is there: ' + list().slice(0, 900));
  TaskManager.clearHistory();

  global.window.backend.lessonPlan = () => {};
  finish('les-failed', { status: 'failed', error: 'Exit Code 1', output: 'ADF.h: no such file', exitCode: 1 });
  finish('les-done', { status: 'completed', output: 'done', exitCode: 0 });
  finish('les-canceled', { status: 'canceled' });
  finish('les-noresult', { status: 'failed', error: 'the agent is not installed' }); // never ran: no exit code
  finish('les-llm', { status: 'failed', error: 'x', output: 'y', exitCode: 1 }, { type: 'llm', agent: 'LLM' });
  assert.strictEqual(TaskManager.offersLessons({ type: 'slot', status: 'failed', exitCode: 1, agent: '' }), false, 'no name, no proposal');
  assert.strictEqual(TaskManager.offersLessons({ type: 'slot', status: 'failed', exitCode: 1, agent: '', agentKey: 'claude-code' }), true, 'the key is a name');
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-failed')), true);
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-done')), true, 'a completed run can have gone wrong too');
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-canceled')), false, 'a canceled run: no button');
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-noresult')), false, 'a run that never ended with a result: no button');
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-llm')), false, 'only agent runs');
  assert.strictEqual(TaskManager.offersLessons(null), false);
  assert.strictEqual(buttonCount(), 2, 'one button per card that offers it (the failed run and the completed one): ' + buttonCount());
  assert(list().includes('data-lessons-id="les-failed"'), 'the button carries the task id');
  // a running card gets none
  TaskManager.addTask({ id: 'les-running', type: 'slot', agent: 'claude-code', instruction: 'still going' });
  assert.strictEqual(TaskManager.offersLessons({ id: 'x', type: 'slot', status: 'running', exitCode: 0, agent: 'a' }), false);
  assert(!list().includes('data-lessons-id="les-running"'), 'no button on a running card');
  TaskManager.cancelTask('les-running');
  assert.strictEqual(TaskManager.offersLessons(TaskManager.historyTask('les-running')), false, 'and none once it is canceled');

  // what the card keeps: the LAST 4000 characters of the output, whole characters only
  const long = 'a'.repeat(5000) + 'END';
  finish('les-long', { status: 'failed', output: long, exitCode: 2 });
  const kept = TaskManager.historyTask('les-long');
  assert.strictEqual(kept.output.length, 4000);
  assert(kept.output.endsWith('aaaEND') && !kept.output.startsWith('END'), 'the end of the output is what stays');
  assert.strictEqual(kept.exitCode, 2);
  const pair = '😀'; // an astral character is two units: the cut never starts in the middle of it
  finish('les-pair', { status: 'failed', output: 'z' + pair.repeat(2500), exitCode: 1 });
  const keptPair = TaskManager.historyTask('les-pair').output;
  assert(keptPair.length <= 4000 && keptPair.charCodeAt(0) === 0xD83D, 'the cut starts at the start of a pair');
  finish('les-short', { status: 'failed', output: 'short', exitCode: 1 });
  assert.strictEqual(TaskManager.historyTask('les-short').output, 'short');
  // the copy is a copy
  const copy = TaskManager.historyTask('les-short');
  copy.output = 'tampered';
  assert.strictEqual(TaskManager.historyTask('les-short').output, 'short');
  assert.strictEqual(TaskManager.historyTask('no-such-card'), null);
  // the RPC listing never carries the output
  assert(!JSON.stringify(TaskManager.snapshot()).includes('ADF.h'), 'task.list shows no output text');
  // a running task keeps nothing for the dialog
  const running = TaskManager.addTask({ id: 'les-run2', type: 'slot', agent: 'claude-code', instruction: 'x' });
  assert.deepStrictEqual(['output', 'exitCode', 'lessonsApplied', 'lessonsSkipped'].filter((k) => k in running), [], 'nothing extra on a running task');
  TaskManager.cancelTask('les-run2');

  // the key of the agent the card was started with
  finish('les-key', { status: 'failed', output: 'o', exitCode: 1 }, { agent: 'code', agentKey: 'claude-code' });
  assert.strictEqual(TaskManager.historyTask('les-key').agentKey, 'claude-code');
  assert.strictEqual(TaskManager.historyTask('les-short').agentKey, '', 'none when the caller gave none');

  // the line: applied, skipped, both, neither
  const line = (applied, skipped) => TaskManager.lessonsLine({ lessonsApplied: applied, lessonsSkipped: skipped });
  assert.strictEqual(line(3, 0), '教訓 3 件を適用');
  assert.strictEqual(line(0, 2), '2 件は多すぎて適用していません');
  assert.strictEqual(line(30, 4), '教訓 30 件を適用 · 4 件は多すぎて適用していません');
  assert.strictEqual(line(0, 0), '');
  assert.strictEqual(line(undefined, undefined), '');
  assert.strictEqual(line(-1, 'x'), '', 'a number that is not above zero says nothing');
  assert.strictEqual(TaskManager.lessonsLine(null), '');
  TaskManager.clearHistory();
  finish('les-line', { status: 'completed', output: 'ok', exitCode: 0, lessonsApplied: 2, lessonsSkipped: 1 });
  assert(list().includes('<span class="task-lessons-line">教訓 2 件を適用 · 1 件は多すぎて適用していません</span>'), 'the line is on the card: ' + list().slice(0, 1200));
  // no numbers and no button (older backend): no row at all
  delete global.window.backend.lessonPlan;
  TaskManager.clearHistory();
  finish('les-bare', { status: 'completed', output: 'ok', exitCode: 0 });
  assert(!list().includes('task-card-lessons'), 'nothing to say, nothing to press: no row');
  // the text of a task is escaped in the title and the id in the attribute
  global.window.backend.lessonPlan = () => {};
  TaskManager.clearHistory();
  finish('a"b', { status: 'failed', output: 'o', exitCode: 1 });
  assert(list().includes('data-lessons-id="a&quot;b"'), 'the id is escaped');

  if (had) global.window.backend.lessonPlan = had; else delete global.window.backend.lessonPlan;
  TaskManager.hidePanel();
  TaskManager.clearHistory();
}
console.log("PASS: Test 3d");

// Test 4: Alt+T keyboard shortcut toggles the panel, including macOS's composed
// key ('†' when Option+T is held, with e.code staying the physical 'KeyT').
console.log("Test 4: Alt+T (and macOS Option+T composed key) toggles the tasks panel");
const keydownHandler = mockListeners['doc_keydown'];
assert(typeof keydownHandler === 'function', 'a document keydown listener must be registered');

let preventedPlain = false;
keydownHandler({ key: 't', code: 'KeyT', altKey: true, preventDefault() { preventedPlain = true; } });
assert(preventedPlain, 'plain Alt+T (Windows/Linux) must call preventDefault and toggle the panel');

let preventedMac = false;
// macOS: Option+T composes '†' into e.key; e.code stays the physical 'KeyT'.
keydownHandler({ key: '†', code: 'KeyT', altKey: true, preventDefault() { preventedMac = true; } });
assert(preventedMac, 'macOS Option+T (composed key "†", code KeyT) must also toggle the panel');
console.log("PASS: Test 4");

// Test 5: taskRunningTooltip substitutes {alt} using MDMemoPlatform.altLabel when
// present, and degrades gracefully (falls back to 'Alt') when it is not — the
// module must not throw either way (this Node harness never sets window.MDMemoPlatform).
console.log("Test 5: taskRunningTooltip substitutes {alt} and degrades gracefully without MDMemoPlatform");
assert(global.window.MDMemoPlatform === undefined, 'this harness intentionally does not define window.MDMemoPlatform');
const t4 = TaskManager.addTask({ id: 'task-alt-label', agent: 'claude-code', instruction: 'check alt label' });
assert(t4 !== null, 'task for alt-label check should be created');
const statTasksElAfter = documentMock.getElementById('stat-tasks');
assert(statTasksElAfter.title.includes('Alt+T') || statTasksElAfter.title.includes('Alt') , `tooltip should fall back to 'Alt' without MDMemoPlatform, got: ${statTasksElAfter.title}`);
TaskManager.cancelTask('task-alt-label');
console.log("PASS: Test 5");

// Test 6: a command task (Auto selector: [[ $ cmd ]]) is listed like an LLM task: its badge is the label
// it was given, the card carries its type, the hover-peek poll skips it, and Cancel runs its own onCancel
// without the slot-agent RPC (a command has no slot process).
console.log("Test 6: command tasks are listed, are not hover-peeked and cancel through onCancel only");
{
  const realSetInterval = global.setInterval;
  let pollFn = null;
  global.setInterval = (fn) => { pollFn = fn; return 42; };
  const realClearInterval = global.clearInterval;
  global.clearInterval = () => {};
  const peeked = [];
  const realPeek = global.window.backend.getSlotHoverPeek;
  global.window.backend.getSlotHoverPeek = async (id) => { peeked.push(id); return 'peek ' + id; };
  global.__canceledBackendId = null;

  TaskManager.showPanel();
  let commandCanceled = 0;
  TaskManager.addTask({ id: 'cmd-1', type: 'command', agent: 'Command', instruction: 'git status', onCancel: () => { commandCanceled++; } });
  TaskManager.addTask({ id: 'llm-1', type: 'llm', agent: 'LLM', instruction: 'summarize' });
  TaskManager.addTask({ id: 'slot-1', type: 'slot', agent: 'claude-code', instruction: 'fix it' });
  let deepCanceled = 0; // a Deep search is cancelled through its own onCancel too (cancelDeepSearch), never as a slot agent
  TaskManager.addTask({ id: 'deep-1', type: 'deepsearch', agent: 'Deep search', instruction: 'bamboo', onCancel: () => { deepCanceled++; } });
  assert.strictEqual(TaskManager.getActiveCount(), 4);
  const html = documentMock.getElementById('tasks-panel-list').innerHTML;
  assert(html.includes('data-task-id="cmd-1" data-task-type="command"'), 'the command card carries its type');
  assert(html.includes('data-task-id="llm-1" data-task-type="llm"') && html.includes('data-task-id="slot-1" data-task-type="slot"'), 'the other types are unchanged');
  assert(html.includes('<span class="task-agent-badge">Command</span>'), 'the badge shows the label the caller gave');

  assert.strictEqual(typeof pollFn, 'function', 'the running tasks start the poll');
  pollFn().then(() => {
    assert.deepStrictEqual(peeked, ['slot-1'], 'only the slot task is hover-peeked');

    TaskManager.cancelTask('cmd-1');
    assert.strictEqual(commandCanceled, 1, 'the command task cancels through its own onCancel');
    assert.strictEqual(global.__canceledBackendId, null, 'and the slot-agent RPC is not called for it');
    TaskManager.cancelTask('deep-1');
    assert.strictEqual(deepCanceled, 1, 'the deep search task cancels through its own onCancel');
    assert.strictEqual(global.__canceledBackendId, null, 'and the slot-agent RPC is not called for it either');
    TaskManager.cancelTask('llm-1');
    assert.strictEqual(global.__canceledBackendId, 'llm-1', 'an LLM task keeps its old behavior (RPC called)');
    TaskManager.cancelTask('slot-1');
    assert.strictEqual(global.__canceledBackendId, 'slot-1');
    assert.strictEqual(TaskManager.getActiveCount(), 0);
    const history = documentMock.getElementById('tasks-panel-list').innerHTML;
    assert(history.includes('task-card-history') && history.includes('data-task-type="command"'), 'history cards carry the type too');

    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    global.window.backend.getSlotHoverPeek = realPeek;
    TaskManager.hidePanel();
    console.log("PASS: Test 6");

    // Test 7: the list (and every Cancel button in it) is rebuilt by the 1 s poll; a press that is held across a rebuild would end
    // on a new button and no click would follow, so a Cancel would be lost. While a mouse button is down on the list it is left alone.
    console.log("Test 7: a press held on the list keeps it from being rebuilt under the pointer");
    TaskManager.showPanel();
    TaskManager.addTask({ id: 'press-1', type: 'slot', agent: 'claude-code', instruction: 'long run' });
    const list = documentMock.getElementById('tasks-panel-list');
    const mousedown = mockListeners['tasks-panel-list'] && mockListeners['tasks-panel-list'].mousedown;
    const mouseup = mockListeners['doc_mouseup'];
    assert(typeof mousedown === 'function' && typeof mouseup === 'function', 'the list listens for a press and the document for its release');
    list.innerHTML = 'BUTTON-UNDER-THE-POINTER';
    mousedown();
    TaskManager.renderUI(); // what the poll does every second
    assert.strictEqual(list.innerHTML, 'BUTTON-UNDER-THE-POINTER', 'not rebuilt while the button is down');
    mouseup();
    setTimeout(() => {
      assert(list.innerHTML.includes('data-task-id="press-1"'), 'rebuilt after the release');

      // a release that never came (the pointer left the window): the list must not stay frozen
      list.innerHTML = 'STALE';
      mousedown();
      const realNow = Date.now;
      Date.now = () => realNow() + 4000;
      TaskManager.renderUI();
      Date.now = realNow;
      assert(list.innerHTML.includes('data-task-id="press-1"'), 'a release that never arrives does not freeze the list for good');

      TaskManager.cancelTask('press-1');
      TaskManager.hidePanel();
      console.log("PASS: Test 7");
      console.log("All TaskManager tests PASS!");
    }, 5);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
