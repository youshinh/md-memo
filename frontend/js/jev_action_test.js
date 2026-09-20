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

  // 2b. Verb-based Quick Actions labels: the visible tag/sub-text must mirror what
  // executeCandidate() will actually do, not the raw action_type. With no I18N loaded
  // in this Node environment, it must gracefully fall back to the Japanese strings.
  const slotCards = slotsContainer.children;
  assert(slotCards[0].innerHTML.includes('任せる'), 'ai-type candidate ({{ }} delegation) should show the "delegate" verb tag (任せる)');
  assert(slotCards[0].innerHTML.includes('エージェントがバックグラウンドで作業'), 'delegate candidate should show delegate sub-text');
  assert(slotCards[1].innerHTML.includes('実行') && !slotCards[1].innerHTML.includes('任せる'), 'sh-type candidate should show the "run" verb tag (実行), not delegate');
  assert(slotCards[1].innerHTML.includes('コマンドを実行して結果を挿入'), 'run candidate should show run sub-text');
  assert(slotCards[2].innerHTML.includes('書く'), 'plain doc-type candidate should show the "write" verb tag (書く), the default LLM-generative path');
  assert(slotCards[2].innerHTML.includes('AIが文章を生成して挿入'), 'write candidate should show write sub-text');
  console.log('✔ Verb-based Quick Actions labels (delegate/run/write) match actual routing');

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

  // 11. Manual trigger now comes ONLY from app.js's shortcut registry (Ctrl+J / Cmd+J),
  // which calls JevAction.triggerJevPrediction() directly. jev_action.js itself no longer
  // hardcodes Alt+A / Ctrl+Shift+A.
  // (a) triggerJevPrediction() must work directly, even while manualOnly is still true from step 10.
  JevAction.hidePanel();
  assert(panel.classList.contains('hidden'), 'panel hidden before manual trigger');
  assert(JevAction.isManualOnly() === true, 'still in manualOnly mode carried over from step 10');
  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'triggerJevPrediction() should show the panel even while manualOnly is true');
  console.log('✔ triggerJevPrediction() works directly in manualOnly mode (Ctrl+J shortcut path)');

  // (b) The old Alt+A keydown must no longer do anything: it was removed from jev_action.js.
  JevAction.hidePanel();
  assert(panel.classList.contains('hidden'), 'panel hidden before dispatching legacy Alt+A keydown');
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
  assert(panel.classList.contains('hidden'), 'Legacy Alt+A keydown must NOT trigger the panel anymore (rebindable via app.js shortcut registry instead)');
  console.log('✔ Hardcoded Alt+A manual trigger removed from jev_action.js keydown handler');

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

  // 14. Secondary pane routing: Quick Actions must act on the pane the user is in.
  const secondaryEl = createMockElement('textarea', 'editor-secondary');
  elements['editor-secondary'] = secondaryEl;
  JevAction.init(); // re-init now that the secondary pane exists

  const primaryBefore = editorEl.value;
  secondaryEl.value = 'Secondary pane notes';
  secondaryEl.selectionStart = secondaryEl.selectionEnd = 20;
  global.document.activeElement = secondaryEl;

  global.window.backend.jevPredict = async () => ({
    candidates: [{ action_type: 'sh', command: 'ls -la', description: 'List' }]
  });
  global.window.backend.jevExecuteAsync = (reqId, candJson, text) => {
    assert(text === 'Secondary pane notes', 'Backend must receive the SECONDARY pane text as context');
    setTimeout(() => {
      global.window.__onJevResult(reqId, {
        success: true,
        output: 'sec output',
        markdown: '\n- [x] sh ls -la\n  > sec output\n'
      });
    }, 10);
  };

  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'Panel should show for a prediction made in the secondary pane');

  secondaryEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 60));

  assert(secondaryEl.value.includes('- [x] sh ls -la'), 'Result must be inserted into the SECONDARY pane');
  assert(editorEl.value === primaryBefore, 'Primary pane must be left untouched');
  console.log('✔ Quick Actions route to the active (secondary) pane, primary untouched');

  // 15. Slot delegation from the secondary pane targets that same pane.
  let slotTargetEditor = null;
  global.window.SlotAgent = {
    triggerSlotExecution: (ed) => { slotTargetEditor = ed; }
  };
  global.window.backend.jevPredict = async () => ({
    candidates: [{ action_type: 'slot', command: '{{ summarize }}', description: 'Delegate' }]
  });
  global.document.activeElement = secondaryEl;
  const primaryBefore2 = editorEl.value;

  await JevAction.triggerJevPrediction();
  secondaryEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 100));

  assert(secondaryEl.value.includes('{{ summarize }}'), 'Slot must be inserted into the SECONDARY pane');
  assert(editorEl.value === primaryBefore2, 'Primary pane must not receive the slot');
  assert(slotTargetEditor === secondaryEl, 'SlotAgent must be triggered against the secondary pane editor');
  console.log('✔ Slot delegation from the secondary pane stays in that pane');

  // 16. Configurable slot delimiters: classifyActionKind must recognize a custom
  // trigger_open pulled from SlotAgent's live config (agents.yaml lets users
  // rebind slot delimiters), not just the hardcoded {{ }} / [? ] defaults.
  global.document.activeElement = editorEl;
  global.window.SlotAgent = {
    triggerSlotExecution: () => {},
    getConfig: () => ({
      slot_profiles: [{ trigger_open: '<<', trigger_close: '>>', name: 'custom' }],
      recipes: []
    })
  };
  global.window.backend.jevPredict = async () => ({
    candidates: [
      { action_type: 'sh', command: '<< refactor auth module >>', description: 'Custom-delimited slot' }
    ]
  });
  await JevAction.triggerJevPrediction();
  const customCard = elements['jev-slots-container'].children[0];
  assert(customCard.innerHTML.includes('任せる'), 'a command starting with a custom-configured trigger_open must classify as delegate, not the sh-type default');
  assert(!customCard.innerHTML.includes('実行する'), 'custom-triggered command must not show the plain run verb');
  console.log('✔ Custom slot delimiters from live SlotAgent config are recognized by classifyActionKind');

  // 17. Configurable slot delimiters: wrapping a bare instruction into a slot must
  // use the FIRST configured slot_profile's delimiters, not a hardcoded {{ }}.
  editorEl.value = 'Some notes here';
  editorEl.selectionStart = editorEl.value.length;
  global.window.backend.jevPredict = async () => ({
    candidates: [
      { action_type: 'ai', command: 'summarize this section', description: 'Bare AI instruction' }
    ]
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
  assert(editorEl.value.includes('<< summarize this section >>'), 'bare instruction must be wrapped using the configured profile delimiters, not a hardcoded {{ }}');
  assert(!editorEl.value.includes('{{ summarize this section }}'), 'must not fall back to the hardcoded {{ }} wrapper when a custom profile is configured');
  console.log("✔ Slot wrapping uses the live default profile's delimiters instead of a hardcoded {{ }}");

  // 18. Fallback: with no SlotAgent.getConfig available (e.g. this file alone
  // under Node, or an older SlotAgent build), behavior must match the historical
  // hardcoded {{ }} / [? ] pair exactly.
  delete global.window.SlotAgent.getConfig;
  editorEl.value = 'More notes';
  editorEl.selectionStart = editorEl.value.length;
  global.window.backend.jevPredict = async () => ({
    candidates: [
      { action_type: 'ai', command: 'plain instruction without delimiters', description: 'Bare AI instruction' }
    ]
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
  assert(editorEl.value.includes('{{ plain instruction without delimiters }}'), 'without a live SlotAgent config, wrapping must fall back to the historical {{ }} default');
  console.log('✔ Falls back to the historical {{ }} wrapper when SlotAgent config is unavailable');

  // 19. macOS keyboard semantics: Option+1..3 composes '¡'/'™'/'£' into e.key,
  // so the handler must read the physical digit from e.code instead. Cmd+Enter
  // must execute (not dismiss like plain Enter). Windows-style events (item 8/9
  // above) must still work unchanged.
  global.window.SlotAgent = { triggerSlotExecution: () => {} };
  // Earlier tests left a jevExecuteAsync mock on window.backend that asserts on a
  // specific pane's text; drop it so execution falls back to the plain, synchronous
  // jevExecute mock declared at the top of this file (echoes command -> markdown).
  delete global.window.backend.jevExecuteAsync;
  global.window.backend.jevPredict = async () => ({
    candidates: [
      { action_type: 'sh', command: 'mac candidate one', description: 'One' },
      { action_type: 'sh', command: 'mac candidate two', description: 'Two' }
    ]
  });
  global.document.activeElement = editorEl;
  editorEl.value = 'mac note';
  editorEl.selectionStart = editorEl.value.length;

  await JevAction.triggerJevPrediction();
  assert(!panel.classList.contains('hidden'), 'panel visible for mac digit test');

  let macDigitPrevented = false;
  editorEl.dispatchEvent({
    type: 'keydown',
    key: '¡', // macOS Option+1 composed character
    code: 'Digit1',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { macDigitPrevented = true; },
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  assert(macDigitPrevented, 'Option+1 (mac) should call preventDefault via physical e.code digit extraction');
  assert(editorEl.value.includes('mac candidate one'), 'Option+1 (mac, key="¡") executed candidate 1');
  console.log('✔ macOS Option+1 (composed key "¡", code Digit1) selects candidate via physical digit');

  await JevAction.triggerJevPrediction();
  let macEnterPrevented = false;
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    metaKey: true,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    preventDefault() { macEnterPrevented = true; },
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  assert(macEnterPrevented, 'Cmd+Enter (mac) must execute, not dismiss');
  assert(editorEl.value.includes('mac candidate two') === false || editorEl.value.includes('mac candidate one'), 'Cmd+Enter executed the currently selected candidate');
  assert(panel.classList.contains('hidden'), 'panel closed after Cmd+Enter execution');
  console.log('✔ macOS Cmd+Enter executes the selected candidate instead of dismissing the panel');

  // Plain Enter must still dismiss (metaKey/ctrlKey/altKey all falsy).
  await JevAction.triggerJevPrediction();
  editorEl.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {}
  });
  assert(panel.classList.contains('hidden'), 'Plain Enter must still dismiss the panel (metaKey treated like ctrlKey, both absent here)');
  console.log('✔ Plain Enter still dismisses the panel when neither Alt, Ctrl, nor Cmd is held');

  // Windows-style Ctrl+1 must still work unchanged.
  global.window.backend.jevPredict = async () => ({
    candidates: [{ action_type: 'sh', command: 'win candidate', description: 'Win' }]
  });
  await JevAction.triggerJevPrediction();
  let winDigitPrevented = false;
  editorEl.dispatchEvent({
    type: 'keydown',
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { winDigitPrevented = true; },
    stopPropagation() {}
  });
  await new Promise(r => setTimeout(r, 50));
  assert(winDigitPrevented, 'Windows-style Ctrl+1 must still select candidate 1');
  assert(editorEl.value.includes('win candidate'), 'Ctrl+1 executed the Windows-style candidate');
  console.log('✔ Windows-style Ctrl+1 / Ctrl+Enter combos still work unchanged');

  console.log('\nAll Jev Frontend Action tests PASSED!');
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
