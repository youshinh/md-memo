// Test Suite for TaskManager frontend module
const assert = require('assert');

// Mock browser environment
const mockListeners = {};
const documentMock = {
  getElementById: (id) => {
    return {
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

console.log("All TaskManager tests PASS!");
