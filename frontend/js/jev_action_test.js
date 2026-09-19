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

  // 4. Test execution via Enter
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {}
  });

  // Wait for async execution
  await new Promise(r => setTimeout(r, 50));

  assert(executedCandidate != null, 'Candidate should be executed');
  assert(executedCandidate.action_type === 'sh', 'Slot 2 (sh) should be executed after 1 Tab');
  assert(editorEl.value.includes('- [x] sh git diff --stat'), 'Markdown output appended to editor');
  console.log('✔ Enter key executed candidate and inserted Markdown');

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

  console.log('\nAll Jev Frontend Action tests PASSED!');
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
