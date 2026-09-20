// Automated Unit Test for Jev Action Frontend Integration
const assert = require('assert');

// Mock DOM elements
const elements = {};

function createMockElement(tag, id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id: id,
    _className: '',
    get className() { return this._className; },
    set className(val) {
      this._className = val;
      this.classList._classes = new Set(val.split(/\s+/).filter(Boolean));
    },
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(html) {
      this._innerHTML = html;
      const matches = html.matchAll(/id="([^"]+)"/g);
      for (const m of matches) {
        if (!elements[m[1]]) {
          const child = createMockElement('div', m[1]);
          elements[m[1]] = child;
        }
      }
    },
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); }
    },
    style: {},
    listeners: {},
    addEventListener(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    },
    dispatchEvent(e) {
      const fns = this.listeners[e.type] || [];
      fns.forEach(fn => fn(e));
    },
    appendChild(child) {
      if (!this.children) this.children = [];
      this.children.push(child);
      if (child.id) elements[child.id] = child;
    },
    contains(other) {
      return other === this || (this.children && this.children.includes(other));
    },
    focus() {}
  };
  if (id) elements[id] = el;
  return el;
}

const editorEl = createMockElement('textarea', 'editor');
elements['editor'] = editorEl;

const wrapperEl = createMockElement('div', 'editor-wrapper');
elements['editor-wrapper'] = wrapperEl;

global.document = {
  readyState: 'complete',
  body: createMockElement('body', 'body'),
  activeElement: editorEl,
  getElementById(id) {
    return elements[id] || null;
  },
  createElement(tag) {
    return createMockElement(tag);
  },
  addEventListener() {}
};

global.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};

let executedCandidate = null;

global.window = {
  backend: {
    jevPredict: async (ctx, cursor) => {
      return {
        candidates: [
          { action_type: 'ai', command: 'refactor auth module', description: 'AI Refactor', scope: 'local' },
          { action_type: 'sh', command: 'git diff --stat', description: 'CLI Diff', scope: 'local' },
          { action_type: 'doc', command: 'update docs/spec.md', description: 'Doc update', scope: 'global' }
        ]
      };
    },
    jevExecute: async (candidateJson, ctx) => {
      executedCandidate = JSON.parse(candidateJson);
      return {
        success: true,
        output: 'test output',
        markdown: '\n- [x] ' + executedCandidate.action_type + ' ' + executedCandidate.command + '\n  > test output\n'
      };
    }
  }
};

// Load jev_action.js
require('./jev_action.js');
const JevAction = global.window.JevAction;

async function runTests() {
  console.log('Testing Jev Frontend Action Integration...');

  // 1. Initial DOM creation
  const panel = elements['jev-action-panel'];
  assert(panel != null, 'jev-action-panel should be created');
  assert(panel.classList.contains('hidden'), 'panel should initially be hidden');
  console.log('✔ Panel DOM initialized');

  // 2. Trigger prediction
  editorEl.value = '# Bug in payment\nFix nil pointer in charge.';
  editorEl.selectionStart = 20;
  global.document.activeElement = editorEl;

  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'panel should be visible after prediction');

  const slotsContainer = elements['jev-slots-container'];
  assert(slotsContainer != null, 'slots container exists');
  assert(slotsContainer.children && slotsContainer.children.length === 3, '3 slots rendered');
  console.log('✔ Prediction triggered and 3 slots rendered');

  // 3. Test Tab key navigation
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    preventDefault() {},
    stopPropagation() {}
  });
  console.log('✔ Tab key navigation handled');

  // 4a. Test plain Enter does NOT execute candidate (preserves normal editor typing newline)
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: false,
    ctrlKey: false,
    preventDefault() {},
    stopPropagation() {}
  });
  assert(executedCandidate == null, 'Plain Enter must NOT execute candidate');
  assert(panel.classList.contains('hidden'), 'Plain Enter should dismiss panel');
  console.log('✔ Plain Enter dismissed panel without accidental execution');

  // 4b. Re-trigger and test execution via Alt+Enter
  await JevAction.triggerJevPrediction();
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    preventDefault() {},
    stopPropagation() {}
  });
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: true,
    preventDefault() {},
    stopPropagation() {}
  });

  // Wait for async execution
  await new Promise(r => setTimeout(r, 50));

  assert(executedCandidate != null, 'Candidate should be executed via Alt+Enter');
  assert(executedCandidate.action_type === 'sh', 'Slot 2 (sh) should be executed after 1 Tab');
  assert(editorEl.value.includes('- [x] sh git diff --stat'), 'Markdown output appended to editor');
  console.log('✔ Alt+Enter executed candidate and inserted Markdown');

  // 5. Test Escape key dismissal
  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'panel shown again');

  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {}
  });
  assert(panel.classList.contains('hidden'), 'panel hidden on Escape');
  console.log('✔ Escape key dismissed panel');

  // 6. Test Quick Actions branding (no icons or proper names)
  assert(panel.innerHTML.includes('Quick Actions'), 'panel header should display Quick Actions');
  assert(!panel.innerHTML.includes('⚡'), 'panel header should not contain emoji icons');
  console.log('✔ Quick Actions header verified (icon-free)');

  // 7. Test setEnabled toggle
  JevAction.setEnabled(false);
  assert(!JevAction.isEnabled(), 'action should be disabled');
  await JevAction.triggerJevPrediction();
  assert(panel.classList.contains('hidden'), 'panel should stay hidden when action is disabled');

  JevAction.setEnabled(true);
  assert(JevAction.isEnabled(), 'action should be enabled');
  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'panel should show when re-enabled');
  console.log('✔ setEnabled(false/true) toggle verified');

  // 8. Plain '1', '2', '3' key safety test (must NEVER trigger action or preventDefault)
  let plainPreventDefaultCalled = false;
  executedCandidate = null;
  editorEl.dispatchEvent({
    type: 'keydown',
    key: '1',
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    preventDefault() { plainPreventDefaultCalled = true; },
    stopPropagation() {}
  });
  assert(!plainPreventDefaultCalled, 'Plain 1 key should NOT call preventDefault');
  assert(executedCandidate === null, 'Plain 1 key should NOT execute candidate');
  console.log('✔ Plain number keys do not hijack typing (safety verified)');

  // 9. Alt+1 key DOES trigger action
  let altPreventDefaultCalled = false;
  editorEl.dispatchEvent({
    type: 'keydown',
    key: '1',
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    preventDefault() { altPreventDefaultCalled = true; },
    stopPropagation() {}
  });
  assert(altPreventDefaultCalled, 'Alt+1 key SHOULD call preventDefault');
  assert(editorEl.value.includes('refactor auth module'), 'Alt+1 executed candidate 1 and inserted slot');
  console.log('✔ Alt+1 shortcut executed candidate');

  // 10. updateConfig test (manualOnly and delaySec)
  JevAction.updateConfig({
    enabled: true,
    manualOnly: true,
    delaySec: 2.0
  });
  assert(JevAction.isManualOnly() === true, 'manualOnly should be true');
  assert(JevAction.getDelayMs() === 2000, 'delayMs should be 2000');
  console.log('✔ updateConfig correctly updated manualOnly and delay');

  // 11. Alt+A manual trigger
  JevAction.hidePanel();
  assert(panel.classList.contains('hidden'), 'panel hidden before Alt+A');
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'a',
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  assert(!panel.classList.contains('hidden'), 'Alt+A should manually trigger prediction panel');
  // 12. Slot candidate execution (delegation to SlotAgent)
  let slotTriggered = false;
  global.window.SlotAgent = {
    triggerSlotExecution: (ed) => {
      slotTriggered = true;
    }
  };

  const slotCandidate = {
    action_type: 'slot',
    command: '{{ このメモの内容からアクションプランとタスクを立案 }}',
    description: 'Antigravity に計画立案を依頼 (agy)'
  };
  editorEl.value = 'My schedule notes';
  editorEl.selectionStart = 17;

  global.window.backend.jevPredict = async () => ({
    candidates: [slotCandidate]
  });

  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'Panel should be visible for slot candidate');

  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: true,
    preventDefault() {},
    stopPropagation() {}
  });

  await new Promise(r => setTimeout(r, 100));
  assert(editorEl.value.includes('{{ このメモの内容からアクションプランとタスクを立案 }}'), 'Slot must be inserted into editor');
  assert(slotTriggered === true, 'SlotAgent.triggerSlotExecution must be triggered for slot candidate');
  assert(panel.classList.contains('hidden'), 'Panel should be closed when slot is inserted');
  console.log('✔ Slot candidate cleanly delegates to SlotAgent without console or UI freeze');

  // 13. Async Jev Execution via jevExecuteAsync
  let asyncCalled = false;
  global.window.backend.jevExecuteAsync = (reqId, candJson, text) => {
    asyncCalled = true;
    setTimeout(() => {
      global.window.__onJevResult(reqId, {
        success: true,
        output: 'async output',
        markdown: '\n- [x] sh git status -s\n  > async output\n'
      });
    }, 10);
  };

  global.window.backend.jevPredict = async () => ({
    candidates: [{ action_type: 'sh', command: 'git status -s', description: 'Git Status' }]
  });
  await JevAction.triggerJevPrediction();
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: true,
    preventDefault() {},
    stopPropagation() {}
  });

  await new Promise(r => setTimeout(r, 60));
  assert(asyncCalled === true, 'jevExecuteAsync should be called');
  assert(editorEl.value.includes('- [x] sh git status -s'), 'Async result should be inserted into editor');
  console.log('✔ jevExecuteAsync asynchronous non-blocking RPC verified');

  console.log('\nAll Jev Frontend Action tests PASSED!');
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
