// Automated Unit Test for Jev Action Frontend Integration
const assert = require('assert');

// Mock DOM elements
const elements = {};
const windowCaptureListeners = { keydown: [], other: [] };

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
      if (html === '') this.children = [];
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
      if (!e.target) e.target = this;
      // Emulate the browser's ordering for keydown: window CAPTURE listeners first; if one
      // of them calls stopPropagation() the element's own listeners never see the event.
      if (e.type === 'keydown') {
        let stopped = false;
        const origStop = e.stopPropagation;
        e.stopPropagation = function () { stopped = true; if (origStop) origStop.call(e); };
        windowCaptureListeners.keydown.forEach(fn => fn(e));
        if (stopped) return;
      }
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
  addEventListener(type, fn, capture) {
    if (type === 'keydown' && capture) windowCaptureListeners.keydown.push(fn);
    else windowCaptureListeners.other.push(fn);
  },
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

  // 2c. Key hints: the header lists the Ctrl-based keys (Cmd+1..3 on macOS via platform.js),
  // does not advertise Alt+Enter, and the old "アクション候補" sub-label is gone.
  const hintsHtml = elements['jev-hints'].innerHTML;
  assert(hintsHtml.includes('Ctrl+1..3') && hintsHtml.includes('Ctrl+Tab') && hintsHtml.includes('Enter') && hintsHtml.includes('Esc'),
    'hint strip must list Ctrl+1..3 / Ctrl+Tab / Enter / Esc');
  assert(!hintsHtml.includes('Alt+'), 'hint strip must not advertise the Alt keys');
  assert(!panel.innerHTML.includes('アクション候補') && !panel.innerHTML.includes('jev-sub'),
    'the "アクション候補" sub-label must be gone from the header');
  console.log('✔ Key hints show Ctrl+1..3 / Ctrl+Tab / Enter / Esc and the redundant sub-label is gone');

  // Stand-in for everything that runs AFTER the panel's window-capture handler (app.js's editor
  // Tab-indent, SlotAgent's Ctrl+Enter, the window-level Ctrl+Tab note switch and Ctrl+1..2 pane
  // focus): a key the panel handles must never reach it, a key it does not handle must.
  let reachedEditor = 0;
  editorEl.addEventListener('keydown', () => { reachedEditor++; });
  function press(el, ev) {
    const rec = { prevented: false };
    el.dispatchEvent(Object.assign({
      type: 'keydown', key: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault() { rec.prevented = true; },
      stopPropagation() {}
    }, ev));
    return rec;
  }
  const selectedFlags = () => Array.from(slotsContainer.children).map(c => c.classList.contains('selected'));

  // 3. Ctrl+Tab moves the highlight (Ctrl+Shift+Tab goes back) and is owned by the panel.
  assert.deepStrictEqual(selectedFlags(), [true, false, false], 'first candidate is highlighted initially');
  reachedEditor = 0;
  let r = press(editorEl, { key: 'Tab', ctrlKey: true });
  assert(r.prevented, 'Ctrl+Tab must be prevented');
  assert.strictEqual(reachedEditor, 0, 'Ctrl+Tab must not reach the editor-level handlers (Tab indent / note switch)');
  assert.deepStrictEqual(selectedFlags(), [false, true, false], 'Ctrl+Tab moves the highlight to candidate 2');
  press(editorEl, { key: 'Tab', ctrlKey: true, shiftKey: true });
  assert.deepStrictEqual(selectedFlags(), [true, false, false], 'Ctrl+Shift+Tab moves back');
  press(editorEl, { key: 'Tab', ctrlKey: true, shiftKey: true });
  assert.deepStrictEqual(selectedFlags(), [false, false, true], 'Ctrl+Shift+Tab wraps to the last candidate');
  press(editorEl, { key: 'Tab', ctrlKey: true, shiftKey: true });
  assert.deepStrictEqual(selectedFlags(), [false, true, false], 'back on candidate 2');
  console.log('✔ Ctrl+Tab / Ctrl+Shift+Tab move the highlight and never reach editor-level handlers');

  // 3b. A plain Tab is NOT the panel's: it stays an ordinary indent (reaches the editor handler)
  // and leaves the highlight alone.
  reachedEditor = 0;
  r = press(editorEl, { key: 'Tab' });
  assert(!r.prevented, 'plain Tab must not be prevented by the panel');
  assert.strictEqual(reachedEditor, 1, 'plain Tab must reach the editor handler');
  assert.deepStrictEqual(selectedFlags(), [false, true, false], 'plain Tab must not move the highlight');
  console.log('✔ Plain Tab is left to the editor (indent), highlight unchanged');

  // 4a. After navigating with Ctrl+Tab, a plain Enter confirms the highlighted candidate
  // (and, being consumed, does not also insert a newline).
  reachedEditor = 0;
  r = press(editorEl, { key: 'Enter' });
  assert(r.prevented, 'Enter after Ctrl+Tab navigation must be prevented (consumed as "confirm")');
  assert.strictEqual(reachedEditor, 0, 'confirming Enter must not reach the editor (no stray newline)');

  // Wait for async execution
  await new Promise(resolve => setTimeout(resolve, 50));

  assert(executedCandidate != null, 'Candidate should be executed via Enter after Ctrl+Tab');
  assert(executedCandidate.action_type === 'sh', 'Slot 2 (sh) should be executed after 1 Ctrl+Tab');
  assert(editorEl.value.includes('- [x] sh git diff --stat'), 'Markdown output appended to editor');
  console.log('✔ Ctrl+Tab then Enter executed the highlighted candidate and inserted Markdown');

  // 4b. Plain Enter WITHOUT navigating must NOT execute anything (it is the newline key):
  // the panel just dismisses and the newline goes through to the editor.
  executedCandidate = null;
  await JevAction.triggerJevPrediction();
  reachedEditor = 0;
  r = press(editorEl, { key: 'Enter' });
  assert(executedCandidate == null, 'Plain Enter must NOT execute candidate');
  assert(panel.classList.contains('hidden'), 'Plain Enter should dismiss panel');
  assert(!r.prevented && reachedEditor === 1, 'Plain Enter must still reach the editor as a normal newline');
  console.log('✔ Plain Enter dismissed panel without accidental execution');

  // 4c. The "navigated" state must not survive closing / re-opening the panel, and Shift+Enter
  // (a soft newline) never confirms.
  await JevAction.triggerJevPrediction();
  press(editorEl, { key: 'Tab', ctrlKey: true });
  JevAction.hidePanel();
  await JevAction.triggerJevPrediction();
  r = press(editorEl, { key: 'Enter' });
  assert(executedCandidate == null && panel.classList.contains('hidden') && !r.prevented,
    'Enter on a re-opened panel must dismiss, not confirm a stale navigation');
  await JevAction.triggerJevPrediction();
  press(editorEl, { key: 'Tab', ctrlKey: true });
  r = press(editorEl, { key: 'Enter', shiftKey: true });
  assert(executedCandidate == null && panel.classList.contains('hidden') && !r.prevented,
    'Shift+Enter must never confirm a candidate');
  console.log('✔ Navigation state resets per opening; Shift+Enter never confirms');

  // 4d. Ctrl+Enter / Cmd+Enter keep meaning "run the slot in the note" (SlotAgent): the panel
  // must not take them - not even after navigating - and the legacy Alt+Enter no longer confirms.
  await JevAction.triggerJevPrediction();
  press(editorEl, { key: 'Tab', ctrlKey: true });
  for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const which = Object.keys(mods)[0];
    reachedEditor = 0;
    r = press(editorEl, Object.assign({ key: 'Enter' }, mods));
    assert(!r.prevented, 'Enter with ' + which + ' must not be prevented by the panel');
    assert.strictEqual(reachedEditor, 1, 'Enter with ' + which + ' must reach SlotAgent / the editor');
    assert(executedCandidate == null, 'Enter with ' + which + ' must not execute a candidate');
    assert(!panel.classList.contains('hidden'), 'the panel stays open for Enter with ' + which);
  }
  JevAction.hidePanel();
  console.log('✔ Ctrl+Enter / Cmd+Enter / Alt+Enter are not taken by the panel');

  // 4e. The panel only reacts to keys typed in a note editor: Ctrl+1 / Esc in another input
  // (find bar, settings field, ...) must pass through untouched.
  await JevAction.triggerJevPrediction();
  const otherInput = createMockElement('input', 'find-input');
  r = press(otherInput, { key: '1', code: 'Digit1', ctrlKey: true });
  assert(!r.prevented && executedCandidate == null, 'Ctrl+1 in a non-editor input must not run a candidate');
  r = press(otherInput, { key: 'Escape' });
  assert(!r.prevented && !panel.classList.contains('hidden'), 'Esc in a non-editor input must not close the panel');
  JevAction.hidePanel();
  console.log('✔ Keys typed outside the note editors are ignored by the panel');

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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
    key: '1',
    code: 'Digit1',
    ctrlKey: true,
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
  executedCandidate = null;
  reachedEditor = 0;
  r = press(editorEl, { key: '2', code: 'Digit2', metaKey: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(r.prevented, 'Cmd+2 (mac) must be prevented');
  assert.strictEqual(reachedEditor, 0, 'Cmd+2 must not reach the pane-focus shortcut');
  assert(executedCandidate && executedCandidate.command === 'mac candidate two', 'Cmd+2 (mac) runs candidate 2 immediately');
  assert(panel.classList.contains('hidden'), 'panel closed after Cmd+2 execution');
  console.log('✔ macOS Cmd+2 runs candidate 2 immediately');

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
  reachedEditor = 0;
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
  assert.strictEqual(reachedEditor, 0, 'Ctrl+1 must not reach the window-level pane-focus shortcut');
  console.log('✔ Windows-style Ctrl+1 runs the candidate immediately and is not passed on');

  console.log('\nAll Jev Frontend Action tests PASSED!');
}

runTests().catch(err => {
  console.error('Test FAILED:', err);
  process.exit(1);
});
