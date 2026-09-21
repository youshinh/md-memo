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
  assert.strictEqual(TaskManager.getActiveCount(), 3);
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
    console.log("All TaskManager tests PASS!");
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
