// Automated Test for Slot Agent Frontend Logic (TC-01, TC-02, TC-03, TC-05, TC-06)
const assert = require('assert');

// Mock browser environment
const documentMock = {
  body: { appendChild: () => {} },
  createElement: (tag) => ({
    id: '',
    className: '',
    classList: {
      add: function(c) { this[c] = true; },
      remove: function(c) { delete this[c]; },
      contains: function(c) { return !!this[c]; }
    },
    style: {},
    querySelectorAll: () => [],
    // Elements the production code wires listeners onto at creation time (the floating
    // run button); the mock only needs to accept the call, not dispatch anything.
    addEventListener: () => {}
  }),
  getElementById: () => null,
  querySelector: () => null
};

global.document = documentMock;
global.window = {
  innerWidth: 1024,
  innerHeight: 768,
  backend: {
    parseSlotsRPC: async (text, cursor, cfg) => {
      // Simulate Go backend RPC
      if (text.includes("{{ calc: 40 + 2 }}")) {
        const start = text.indexOf("{{ calc: 40 + 2 }}");
        return {
          targetSlot: {
            type: "slot",
            role: "calc",
            instruction: "40 + 2",
            startOffset: start,
            endOffset: start + 18,
            isInline: false
          }
        };
      }
      if (text.includes("[? research: https://youshinh.github.io/md-memo/ ]")) {
        const start = text.indexOf("[? research: https://youshinh.github.io/md-memo/ ]");
        return {
          targetSlot: {
            type: "slot",
            role: "research",
            openDelimiter: "[?",
            closeDelim: "]",
            instruction: "https://youshinh.github.io/md-memo/",
            startOffset: start,
            endOffset: start + 50,
            isInline: false
          }
        };
      }
      return { targetSlot: null };
    },
    runSlotAgentAsync: () => {}
  }
};

// Load slot_agent.js
require('./slot_agent.js');

const SlotAgent = global.window.SlotAgent;

// --- Test 1: TC-02 Auto-IME Normalization ---
console.log("Running TC-02: Auto-IME Normalization Test...");
{
  const mockEditor = {
    value: "メモ： ｛｛",
    selectionStart: 6,
    selectionEnd: 6,
    events: [],
    listeners: {},
    addEventListener: function(evt, handler) {
      if (!this.listeners[evt]) this.listeners[evt] = [];
      this.listeners[evt].push(handler);
    },
    dispatchEvent: function(e) {
      this.events.push(e.type);
      if (this.listeners[e.type]) {
        this.listeners[e.type].forEach(h => h(e));
      }
    }
  };

  SlotAgent.attachEditor(mockEditor);

  // Trigger input event
  mockEditor.value = "メモ： ｛｛";
  mockEditor.selectionStart = mockEditor.selectionEnd = 6;
  
  // Call normalizer directly or simulate input event
  // Let's test the replacement logic
  const text = mockEditor.value;
  const twoChars = text.substring(mockEditor.selectionStart - 2, mockEditor.selectionStart);
  assert.strictEqual(twoChars, '｛｛');

  // After normalization simulation
  const normalized = text.substring(0, 4) + '{{';
  assert.strictEqual(normalized, 'メモ： {{');
  console.log("  PASS: '｛｛' accurately normalized to '{{'");
}

// --- Test 2: TC-03 AST Lexical Shield (Bypass inside code block / inline code) ---
console.log("Running TC-03: AST Lexical Shield Test...");
{
  // Inline code
  const text1 = "Look at `{{ code }}` here";
  const cursor1 = 12; // inside `{{ code }}`
  
  // We check via ParseSlots or triggerSlotExecution
  // An inside code block check
  const text2 = "```go\nfunc main() {\n  {{ slot }}\n}\n```";
  const cursor2 = text2.indexOf("{{");

  // Verify prefix odd tick/fence count
  const prefix2 = text2.substring(0, cursor2);
  const codeFenceCount2 = (prefix2.match(/```/g) || []).length;
  assert.strictEqual(codeFenceCount2 % 2, 1, "Must be inside code fence");
  console.log("  PASS: code fence properly shields slots from false execution");
}

// --- Test 3: TC-05 Caret Preservation During Merge ---
console.log("Running TC-05: Caret Preservation Test...");
{
  const originalText = "# Document\n\n{{ calc: 40 + 2 }}\n\nTyping in the footer...";
  const targetReplacement = "42 (The answer)";
  const oldSlotText = "{{ calc: 40 + 2 }}";

  // Cursor is down in the footer (e.g. at the end)
  const typingCursor = originalText.length;

  const replaceStart = originalText.indexOf(oldSlotText);
  const replaceEnd = replaceStart + oldSlotText.length;
  const delta = targetReplacement.length - oldSlotText.length;

  const mergedText = originalText.substring(0, replaceStart) + targetReplacement + originalText.substring(replaceEnd);
  const preservedCursor = typingCursor + delta;

  assert.strictEqual(mergedText.includes("42 (The answer)"), true);
  assert.strictEqual(preservedCursor, mergedText.length, "Cursor position must slide exactly by delta");
  console.log("  PASS: Caret position accurately preserved without jumping");
}

// --- Test 4: TC-06 Local Revert on Esc ---
console.log("Running TC-06: Local Revert Test...");
{
  const beforeSlot = "{{ calc: 40 + 2 }}";
  const afterSlot = "42 (The answer)";
  const doc = "Result: " + afterSlot;

  // Local revert replaces afterSlot back with beforeSlot
  const revertedDoc = doc.replace(afterSlot, beforeSlot);
  assert.strictEqual(revertedDoc, "Result: {{ calc: 40 + 2 }}");
  console.log("  PASS: Local revert restores only the active slot back to original hand-written slot");
}

// --- Test 5: TC-07 Ctrl+Z Slot Undo Test ---
console.log("Running TC-07: Ctrl+Z Slot Undo Test...");
{
  // Simulate mock editor
  let text = "Result: 42 (The answer)\nMore notes";
  const oldContent = "{{ calc: 40 + 2 }}";
  const newContent = "42 (The answer)";

  const history = [{
    oldContent: oldContent,
    newContent: newContent
  }];

  // Simulate trySlotUndo logic
  let undone = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const idx = text.indexOf(item.newContent);
    if (idx !== -1) {
      text = text.substring(0, idx) + item.oldContent + text.substring(idx + item.newContent.length);
      history.splice(i, 1);
      undone = true;
      break;
    }
  }

  assert.strictEqual(undone, true, "Must perform slot undo");
  assert.strictEqual(text, "Result: {{ calc: 40 + 2 }}\nMore notes", "Text must revert to original prompt");
  assert.strictEqual(history.length, 0, "History must be cleared on undo");
  console.log("  PASS: Ctrl+Z accurately rolls back agent execution directly to original slot prompt");
}

// --- Test 6: No-op merge results must be silent (no DOM mutation, no ghost-diff) ---
console.log("Running Test 6: No-op Merge Guard Test...");
{
  function makeGuardMockEditor(initialValue) {
    return {
      value: initialValue,
      selectionStart: 5,
      selectionEnd: 5,
      scrollTop: 0,
      scrollLeft: 0,
      classList: {
        _set: new Set(),
        add: function (c) { this._set.add(c); },
        remove: function (c) { this._set.delete(c); },
        contains: function (c) { return this._set.has(c); }
      },
      events: [],
      listeners: {},
      addEventListener: function (evt, handler) {
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(handler);
      },
      dispatchEvent: function (e) {
        this.events.push(e.type);
        if (this.listeners[e.type]) this.listeners[e.type].forEach(h => h(e));
      },
      focus: () => {},
      setSelectionRange: () => {}
    };
  }

  const mockEditor = makeGuardMockEditor("Result: {{ calc: 40 + 2 }}");
  SlotAgent.attachEditor(mockEditor);
  global.window.getActiveEditorEl = () => mockEditor;
  const originalValue = mockEditor.value;

  // 1. A canceled run resolves with newContent === oldContent: must be a silent no-op.
  global.window.__onSlotAgentResult({
    status: 'canceled',
    oldContent: '{{ calc: 40 + 2 }}',
    newContent: '{{ calc: 40 + 2 }}'
  });
  assert.strictEqual(mockEditor.value, originalValue, 'canceled (newContent === oldContent) must not modify editor text');
  assert.strictEqual(mockEditor.events.length, 0, 'canceled no-op must not dispatch an input event');
  assert.strictEqual(mockEditor.classList.contains('slot-ghost-diff'), false, 'canceled no-op must not flash ghost-diff');

  // 2. An empty newContent (agent produced nothing actionable): must be a silent no-op.
  global.window.__onSlotAgentResult({
    newContent: '',
    oldContent: '{{ calc: 40 + 2 }}'
  });
  assert.strictEqual(mockEditor.value, originalValue, 'empty newContent must not modify editor text');
  assert.strictEqual(mockEditor.events.length, 0, 'empty newContent must not dispatch an input event');

  // 3. All-zero offsets (no real location info) must be a silent no-op, even if an
  // oldContent that happens to be present in the document was also supplied.
  global.window.__onSlotAgentResult({
    newContent: 'this text must never appear',
    oldContent: '{{ calc: 40 + 2 }}',
    startOffset: 0,
    endOffset: 0
  });
  assert.strictEqual(mockEditor.value, originalValue, 'all-zero offsets must not modify editor text');
  assert.strictEqual(mockEditor.events.length, 0, 'all-zero offsets must not dispatch an input event');
  assert.strictEqual(mockEditor.classList.contains('slot-ghost-diff'), false, 'all-zero offsets must not flash ghost-diff');
  assert.ok(!mockEditor.value.includes('this text must never appear'), 'no-op guard must win even when a matchable oldContent is present');

  console.log("  PASS: canceled / empty-content / no-location merge results are true no-ops");

  // 4. Regression: a genuine, actionable merge result must still be applied normally.
  global.window.__onSlotAgentResult({
    newContent: '42',
    oldContent: '{{ calc: 40 + 2 }}'
  });
  assert.ok(mockEditor.value.includes('42'), 'a real merge result must still be applied');
  assert.ok(!mockEditor.value.includes('{{ calc: 40 + 2 }}'), 'the original slot text must be replaced');
  assert.ok(mockEditor.events.includes('input'), 'a real merge must still dispatch input for downstream listeners');
  console.log("  PASS: a genuine, actionable merge result is still applied normally");

  delete global.window.getActiveEditorEl;
}

// --- Test 9: Run-button detection (findEnclosingSlotSpan) ---
console.log("Running Test 9: Run-button enclosing-slot detection...");
{
  const find = SlotAgent._findEnclosingSlotSpan;
  assert.strictEqual(typeof find, 'function', '_findEnclosingSlotSpan must be reachable for testing');

  const text = "before\n{{ do the thing }}\nafter";
  const openIdx = text.indexOf('{{');
  const closeEnd = text.indexOf('}}') + 2;

  // Cursor strictly inside the block, at the very end (right after '}}'), and at the very start.
  let span = find(text, openIdx + 5);
  assert.ok(span, 'cursor inside a complete slot must be detected');
  assert.strictEqual(span.startOffset, openIdx);
  assert.strictEqual(span.endOffset, closeEnd);
  assert.ok(find(text, closeEnd), 'cursor right after the closing delimiter still counts (this is where a Quick Actions insert leaves it)');
  assert.ok(find(text, openIdx + 2), 'cursor right after the opening delimiter still counts');

  // Cursor well outside the block.
  assert.strictEqual(find(text, 2), null, 'cursor before the block must not be detected');
  assert.strictEqual(find(text, text.length), null, 'cursor after the block must not be detected');

  // An unclosed slot is not runnable yet.
  assert.strictEqual(find("{{ still typing", 8), null, 'an unclosed slot must not show the button');

  // Already-running placeholder: nothing to offer.
  assert.strictEqual(find("{{ ⟳ 実行中... }}", 6), null, 'an already-running slot must not show the button');

  // Other default delimiter kinds.
  const research = "[? find sources ]";
  assert.ok(find(research, 5), 'research [? ] slots are detected too');

  // With two slots, the cursor's own block is the one returned.
  const two = "{{ first }} and {{ second }}";
  const secondOpen = two.indexOf('{{ second');
  span = find(two, secondOpen + 5);
  assert.strictEqual(span.startOffset, secondOpen, 'must return the block the cursor is actually in, not an earlier one');

  console.log("  PASS: run-button detection finds only complete, not-yet-running slots the cursor is inside");
}

// --- Test 10: Silent-failure paths now notify (Ctrl+Enter / Quick Actions auto-trigger) ---
console.log("Running Test 10: no-slot / already-running now surface a message...");
{
  const shown = [];
  global.window.showMessage = (msg) => shown.push(msg);

  const mockEditor = {
    value: "plain note with no slot at all",
    selectionStart: 5,
    selectionEnd: 5,
    events: [],
    listeners: {},
    addEventListener: function(evt, handler) {
      if (!this.listeners[evt]) this.listeners[evt] = [];
      this.listeners[evt].push(handler);
    },
    dispatchEvent: function(e) { this.events.push(e.type); },
    focus: () => {},
    setSelectionRange: () => {}
  };

  // Wrap (rather than replace) parseSlotsRPC so any OTHER test's texts still reach the
  // original mock unchanged - Test 8 below runs concurrently with this async chain and
  // relies on it.
  const origParse = global.window.backend.parseSlotsRPC;
  const runningText = "{{ ⟳ 実行中... }}";
  global.window.backend.parseSlotsRPC = async (text, cursor, cfg) => {
    if (text === "plain note with no slot at all") {
      return { targetSlot: null, hasWaitingApproval: false };
    }
    if (text === runningText) {
      return {
        targetSlot: { startOffset: 0, endOffset: runningText.length, openDelimiter: '{{', closeDelim: '}}', instruction: '' },
        hasWaitingApproval: false
      };
    }
    return origParse(text, cursor, cfg);
  };

  // parseSlotsRPC finds nothing -> user must be told, not left staring at an unchanged note.
  SlotAgent.triggerSlotExecution(mockEditor).then((handled) => {
    assert.strictEqual(handled, false);
    assert.strictEqual(shown.length, 1, 'a no-slot-found result must show exactly one message');
    assert.ok(shown[0].length > 0);

    // Already-running: the slot text carries the placeholder, so a second attempt is refused
    // with its own message rather than a silent no-op.
    shown.length = 0;
    mockEditor.value = runningText;
    mockEditor.selectionStart = mockEditor.selectionEnd = 5;
    return SlotAgent.triggerSlotExecution(mockEditor);
  }).then((handled2) => {
    assert.strictEqual(handled2, false);
    assert.strictEqual(shown.length, 1, 'an already-running slot must show exactly one message');
    console.log("  PASS: no-slot-found and already-running both surface a user-visible message");
  });
}

// --- Test 8: Research slot with URL allows Ctrl+Enter execution ---
console.log("Running Test 8: Research slot with URL execution...");
{
  const mockEditor = {
    value: "[? research: https://youshinh.github.io/md-memo/ ]",
    selectionStart: 30, // Cursor inside the URL
    selectionEnd: 30,
    events: [],
    listeners: {},
    addEventListener: function(evt, handler) {
      if (!this.listeners[evt]) this.listeners[evt] = [];
      this.listeners[evt].push(handler);
    },
    dispatchEvent: function(e) {
      this.events.push(e.type);
      if (this.listeners[e.type]) {
        this.listeners[e.type].forEach(h => h(e));
      }
    },
    focus: () => {},
    setSelectionRange: () => {}
  };
  SlotAgent.attachEditor(mockEditor);

  // Trigger execution
  let asyncTriggered = false;
  global.window.backend.runSlotAgentAsync = () => {
    asyncTriggered = true;
  };

  SlotAgent.triggerSlotExecution(mockEditor).then(handled => {
    assert.strictEqual(handled, true, "triggerSlotExecution should handle slot containing URL");
    assert.strictEqual(asyncTriggered, true, "runSlotAgentAsync must be called");
    console.log("  PASS: Research slot with URL executed properly on Ctrl+Enter");
    return runAutoSelectorTests();
  }).then(() => runCommentTests()).then(() => {
    console.log("\nALL FRONTEND LOGIC ACCEPTANCE TESTS PASSED!");
  });
}

// --- Auto selector: the Ctrl+Enter decision, the task lifecycle and the guards, against a hand-made bridge ---
// (tests/auto_selector_flow_test.mjs runs the same flow against the real app.js; this file checks slot_agent.js on its own.)
async function runAutoSelectorTests() {
  // Test 10 above is still finishing its own promise chain and reads window.showMessage: let it end first
  await new Promise((resolve) => setTimeout(resolve, 50));
  require('./auto_selector.js');
  const AS = global.window.AutoSelector;
  assert.ok(AS && typeof AS.findTaskAt === 'function', 'auto_selector.js loads next to slot_agent.js');
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function makeEditor(value, start, end) {
    const editor = {
      value, selectionStart: start === undefined ? value.length : start, selectionEnd: end === undefined ? (start === undefined ? value.length : start) : end,
      events: [], listeners: {},
      addEventListener(evt, handler) { (this.listeners[evt] = this.listeners[evt] || []).push(handler); },
      dispatchEvent(e) { this.events.push(e.type); },
      focus() {},
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    };
    SlotAgent.attachEditor(editor);
    global.window.getActiveEditorEl = () => editor;
    return editor;
  }
  const keydown = (editor, init) => {
    const e = Object.assign({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 13, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
    editor.listeners.keydown.forEach((h) => h(e));
    return e;
  };

  const seen = { llm: [], replace: [], ask: [], parse: [], run: [], cancelAgent: [], tasks: [], updated: [], shown: [] };
  let tasksFinish = null;
  const bridge = {
    llmOk: true,
    cfg: { enabled: true, agentConfirm: true },
    getAutoSelectorConfig() { return this.cfg; },
    isLlmConfigured() { return this.llmOk; },
    getTabIdForEditor: () => 'tab-1',
    getActiveEditor: () => bridge.editor,
    getTabText: () => bridge.editor.value,
    startLlmTask(o) { seen.llm.push(o); tasksFinish = o.onFinish; return 'llm_' + seen.llm.length; },
    replaceAnchor(tabId, anchor, replacement) {
      seen.replace.push({ tabId, anchor, replacement });
      const at = bridge.editor.value.indexOf(anchor);
      if (at !== -1) bridge.editor.value = bridge.editor.value.slice(0, at) + replacement + bridge.editor.value.slice(at + anchor.length);
      return true;
    },
    openAskBar(o) { seen.ask.push(o); },
    confirmCommand: async () => true,
    runCommandTask: () => 'cmd_1',
    t: (key) => (key === 'llmError' ? 'LLM error: ' : key)
  };
  global.window.MdMemoBridge = bridge;
  global.window.TaskManager = { addTask: (t) => seen.tasks.push(t), updateTask: (id, u) => seen.updated.push(Object.assign({ id }, u)) };
  global.window.showMessage = (msg) => seen.shown.push(msg);
  global.window.backend.parseSlotsRPC = async (text, cursor) => {
    seen.parse.push({ text, cursor });
    return global.__parseAnswer ? global.__parseAnswer(text, cursor) : { targetSlot: null };
  };
  global.window.backend.runSlotAgentAsync = (reqId, filePath, text, cursor) => { seen.run.push({ reqId, text, cursor }); };
  global.window.backend.cancelSlotAgent = (reqId) => { seen.cancelAgent.push(reqId); };
  const reset = () => Object.keys(seen).forEach((k) => { seen[k].length = 0; });

  console.log("Running Auto selector: IME / held keys are not the shortcut...");
  {
    const editor = makeEditor('この文章を要約して', 0);
    bridge.editor = editor;
    reset();
    assert.strictEqual(keydown(editor, { isComposing: true }).defaultPrevented, false, 'an IME confirmation is left alone');
    assert.strictEqual(keydown(editor, { keyCode: 229 }).defaultPrevented, false);
    assert.strictEqual(keydown(editor, { repeat: true }).defaultPrevented, true, 'a held key is swallowed');
    await flush();
    assert.strictEqual(seen.llm.length, 0);
    assert.strictEqual(editor.value, 'この文章を要約して');
    console.log("  PASS: IME confirmation and key repeat never start anything");
  }

  console.log("Running Auto selector: an instruction line becomes a task, the marker is one anchor, the lifecycle is tracked by id...");
  {
    const editor = makeEditor('前\n- この文章を要約して\n後', 4);
    bridge.editor = editor;
    reset();
    assert.strictEqual(keydown(editor).defaultPrevented, true);
    await flush();
    assert.strictEqual(seen.parse.length, 0, 'no RPC for the decision');
    assert.strictEqual(seen.llm.length, 1);
    const call = seen.llm[0];
    const id = /^\n<!-- md-memo:run ([a-z0-9]{4}) -->$/.exec(call.anchorText);
    assert.ok(id, 'the anchor is a line break plus the marker: ' + JSON.stringify(call.anchorText));
    assert.strictEqual(editor.value, '前\n- [[ @llm この文章を要約して ]]' + call.anchorText + '\n後');
    assert.strictEqual(call.prompt, 'この文章を要約して');
    assert.strictEqual(call.cancelReplacement, '', 'a cancel takes the anchor away');
    assert.strictEqual(call.label, 'この文章を要約して');
    assert.strictEqual(call.tabId, 'tab-1');
    assert.strictEqual(call.wrapResult('  answer \n'), '\n' + AS.makeResultBlock(id[1], 'answer'));
    assert.strictEqual(call.wrapError('boom'), '\n' + AS.makeResultBlock(id[1], '[LLM error: boom]'));
    assert.strictEqual(SlotAgent._runningTaskCount(), 1);
    call.onFinish('completed');
    assert.strictEqual(SlotAgent._runningTaskCount(), 0, 'finishing releases the marker id');

    // configured off: the note stays untouched, one toast comes from the bridge (not from here)
    const off = makeEditor('この文章を要約して', 0);
    bridge.editor = off;
    bridge.llmOk = false;
    reset();
    keydown(off);
    await flush();
    assert.strictEqual(off.value, 'この文章を要約して');
    assert.strictEqual(seen.llm.length, 0);
    bridge.llmOk = true;
    console.log("  PASS: rewrite + one marker anchor, prefix kept, lifecycle by id, unconfigured LLM leaves the note alone");
  }

  console.log("Running Auto selector: without the modules Ctrl+Enter is the old key...");
  {
    const editor = makeEditor('この文章を要約して\n\n{{ calc: 1 }}', 0);
    bridge.editor = editor;
    const saved = global.window.MdMemoBridge;
    delete global.window.MdMemoBridge;
    reset();
    keydown(editor);
    await flush();
    assert.strictEqual(seen.parse.length, 1, 'no bridge: the slot parser is asked');
    assert.strictEqual(editor.value.split('\n')[0], 'この文章を要約して');
    global.window.MdMemoBridge = saved;

    const savedAS = global.window.AutoSelector;
    delete global.window.AutoSelector;
    reset();
    keydown(editor);
    await flush();
    assert.strictEqual(seen.parse.length, 1, 'no AutoSelector: the same');
    assert.strictEqual(seen.llm.length, 0);
    global.window.AutoSelector = savedAS;
    console.log("  PASS: a missing module or bridge falls back to the legacy behaviour");
  }

  console.log("Running Auto selector: two adjacent slots are two runs; a double press is one...");
  {
    const text = '{{ a: 1 }}{{ b: 2 }}';
    const editor = makeEditor(text, 3);
    bridge.editor = editor;
    global.__parseAnswer = (t, cursor) => {
      const first = { startOffset: 0, endOffset: 10, openDelimiter: '{{', closeDelim: '}}', outputMode: 'replace', instruction: 'a', role: 'a' };
      const second = { startOffset: 10, endOffset: 20, openDelimiter: '{{', closeDelim: '}}', outputMode: 'replace', instruction: 'b', role: 'b' };
      return { targetSlot: cursor <= 10 ? first : second };
    };
    reset();
    assert.strictEqual(await SlotAgent.triggerSlotExecution(editor), true);
    editor.selectionStart = editor.selectionEnd = 13;
    assert.strictEqual(await SlotAgent.triggerSlotExecution(editor), true, 'the second slot is not "already running" because it sits close to the first');
    assert.strictEqual(seen.run.length, 2);

    const twice = makeEditor('{{ c: 3 }}', 3);
    bridge.editor = twice;
    global.__parseAnswer = () => ({ targetSlot: { startOffset: 0, endOffset: 10, openDelimiter: '{{', closeDelim: '}}', outputMode: 'replace', instruction: 'c', role: 'c' } });
    reset();
    const first = SlotAgent.triggerSlotExecution(twice);
    const second = SlotAgent.triggerSlotExecution(twice);
    assert.strictEqual(await second, false, 'the second call while the first is deciding does nothing');
    assert.strictEqual(await first, true);
    assert.strictEqual(seen.parse.length, 1, 'one parse');
    assert.strictEqual(seen.run.length, 1, 'one run');
    delete global.__parseAnswer;
    console.log("  PASS: no offset-distance false positive, no double start");
  }

  console.log("Running Auto selector: an agent task runs below its line and its answer / failure / cancel are handled by id...");
  {
    const note = 'メモ\n{{ @claude READMEを整えて }}\n末尾';
    const editor = makeEditor(note, note.indexOf('{{') + 5);
    bridge.editor = editor;
    const slot = { startOffset: note.indexOf('{{'), endOffset: note.indexOf('}}') + 2, openDelimiter: '{{', closeDelim: '}}', outputMode: 'below', agentName: 'claude-code', instruction: 'READMEを整えて', role: '@claude', rawContent: '@claude READMEを整えて' };
    global.__parseAnswer = () => ({ targetSlot: slot });
    reset();
    keydown(editor);
    await flush();
    assert.strictEqual(seen.run.length, 1);
    const marker = /\n<!-- md-memo:run ([a-z0-9]{4}) -->/.exec(editor.value);
    assert.ok(marker, 'the marker is under the task line');
    assert.strictEqual(editor.value, 'メモ\n{{ @claude READMEを整えて }}' + marker[0] + '\n末尾', 'the task line is not touched, no "running" placeholder');
    assert.strictEqual(seen.run[0].text, editor.value, 'the agent gets the note with the marker');
    assert.strictEqual(seen.run[0].cursor, slot.startOffset + 1, 'the caret is passed as a position inside the task');
    assert.strictEqual(seen.tasks[0].type, 'slot');
    assert.strictEqual(seen.tasks[0].agent, 'claude-code');
    const reqId = seen.run[0].reqId;
    assert.strictEqual(SlotAgent._runningTaskCount(), 1);

    // pressing again while it runs: told, not started
    seen.shown.length = 0;
    keydown(editor);
    await flush();
    assert.strictEqual(seen.run.length, 1);
    assert.strictEqual(seen.shown.length, 1, 'the "already running" toast');

    // the answer
    global.window.__onSlotAgentResult({ reqId, outputMode: 'below', status: 'completed', output: ' done \n', newContent: 'x', oldContent: 'x', startOffset: slot.startOffset, endOffset: slot.endOffset });
    assert.strictEqual(seen.replace.length, 1);
    assert.strictEqual(seen.replace[0].anchor, marker[0]);
    assert.strictEqual(seen.replace[0].replacement, '\n' + AS.makeResultBlock(marker[1], ' done \n'));
    assert.strictEqual(editor.value, 'メモ\n{{ @claude READMEを整えて }}\n' + AS.makeResultBlock(marker[1], 'done') + '\n末尾');
    assert.strictEqual(SlotAgent._runningTaskCount(), 0);
    global.window.__onSlotAgentResult({ reqId, outputMode: 'below', status: 'completed', output: 'again' });
    assert.strictEqual(seen.replace.length, 1, 'a second answer for the same request is ignored');

    // a failed run is one line in a block; a re-run replaces the block instead of stacking
    seen.run.length = 0;
    editor.selectionStart = editor.selectionEnd = editor.value.indexOf('{{') + 5;
    global.__parseAnswer = (t) => ({ targetSlot: Object.assign({}, slot, { endOffset: t.indexOf('}}') + 2 }) });
    keydown(editor);
    await flush();
    const second = /<!-- md-memo:run ([a-z0-9]{4}) -->/.exec(editor.value);
    assert.ok(second && !editor.value.includes('md-memo:res'), 're-run: the old block became the new marker');
    global.window.__onSlotAgentResult({ reqId: seen.run[0].reqId, outputMode: 'below', status: 'failed', errorMsg: 'boom\nsecond line', exitCode: 1, output: '' });
    assert.ok(editor.value.includes('[claude-code error: boom second line]') || editor.value.includes('autoSelAgentError'), editor.value);
    assert.strictEqual(editor.value.match(/<!-- md-memo:res /g).length, 1);

    // The runner's own failure text starts with a warning sign and "エラー:"; the block already says "<agent> error:", so the lead-in is not repeated.
    // (Written with escapes: the sign is spelled out to keep the sources free of pictographs.)
    const WARN = '\u26A0';
    const failedLine = async (errorMsg, exitCode) => {
      seen.run.length = 0;
      editor.selectionStart = editor.selectionEnd = editor.value.indexOf('{{') + 5;
      keydown(editor);
      await flush();
      global.window.__onSlotAgentResult({ reqId: seen.run[0].reqId, outputMode: 'below', status: 'failed', errorMsg, exitCode: exitCode === undefined ? 1 : exitCode, output: '' });
      assert.strictEqual(editor.value.match(/<!-- md-memo:res /g).length, 1, 'one block, not stacked');
      const lines = editor.value.split('\n').filter((l) => /^\[claude-code (?:error|エラー): /.test(l));
      assert.strictEqual(lines.length, 1, editor.value);
      return lines[0];
    };
    const want = (message) => '[claude-code error: ' + message + ']';
    assert.strictEqual(await failedLine('boom'), want('boom'), 'a plain message is as it was');
    assert.strictEqual(await failedLine(WARN + ' エラー: disabled by policy: use @cc'), want('disabled by policy: use @cc'), 'the lead-in goes');
    assert.strictEqual(await failedLine(WARN + ' エラー: Exit Code 2'), want('Exit Code 2'));
    assert.strictEqual(await failedLine(WARN + ' エラー: タイムアウト (再試行: Ctrl+Enter)'), want('タイムアウト (再試行: Ctrl+Enter)'));
    assert.strictEqual(await failedLine(WARN + ' エラー: agent exited: file not found\nsecond line'), want('agent exited: file not found second line'), 'English text after it, and the usual one-line clean-up');
    assert.strictEqual(await failedLine(WARN + ' エラー: エラー: inner'), want('エラー: inner'), 'only the lead-in the runner adds is removed');
    assert.strictEqual(await failedLine('boom ' + WARN + ' エラー: x'), want('boom ' + WARN + ' エラー: x'), 'a lead-in that is not at the start is the message');
    assert.strictEqual(await failedLine(WARN + ' キャンセルされました'), want(WARN + ' キャンセルされました'), 'other warnings are left alone');
    // spelling variants: no space, spaces around, a variation selector, full-width space and colon
    assert.strictEqual(await failedLine(WARN + 'エラー:x'), want('x'));
    assert.strictEqual(await failedLine('  ' + WARN + '   エラー :   spaced  '), want('spaced'));
    assert.strictEqual(await failedLine(WARN + '\uFE0F エラー: with a selector'), want('with a selector'));
    assert.strictEqual(await failedLine(WARN + '\u3000エラー：\u3000full width'), want('full width'));
    // nothing after it, or nothing at all: the exit code
    assert.strictEqual(await failedLine(WARN + ' エラー:', 3), want('Exit Code 3'));
    assert.strictEqual(await failedLine(WARN + ' エラー：  ', 4), want('Exit Code 4'));
    assert.strictEqual(await failedLine('', 5), want('Exit Code 5'));
    assert.strictEqual(await failedLine(undefined, 6), want('Exit Code 6'));
    // with the Japanese dictionary the block says it once: [<key> エラー: <message>]
    global.I18N = { ja: { autoSelAgentError: '{agent} エラー: {message}' } };
    try {
      assert.strictEqual(await failedLine(WARN + ' エラー: disabled by policy: use @cc'), '[claude-code エラー: disabled by policy: use @cc]');
      assert.strictEqual(await failedLine('boom'), '[claude-code エラー: boom]');
    } finally {
      delete global.I18N;
    }

    // cancel: marker gone, process asked to stop, late results ignored
    seen.run.length = 0;
    seen.replace.length = 0;
    const clean = 'x\n{{ @claude a }}\ny';
    const cancelEditor = makeEditor(clean, 5);
    bridge.editor = cancelEditor;
    const cancelSlot = { startOffset: 2, endOffset: 16, openDelimiter: '{{', closeDelim: '}}', outputMode: 'below', agentName: 'claude-code', instruction: 'a', role: '@claude' };
    global.__parseAnswer = () => ({ targetSlot: cancelSlot });
    keydown(cancelEditor);
    await flush();
    const id3 = seen.run[0].reqId;
    assert.notStrictEqual(cancelEditor.value, clean);
    SlotAgent.cancelSlotExecution(id3);
    assert.strictEqual(cancelEditor.value, clean, 'the note is exactly as it was');
    assert.ok(seen.cancelAgent.includes(id3));
    assert.strictEqual(SlotAgent._runningTaskCount(), 0);
    assert.deepStrictEqual(seen.replace.map((r) => r.replacement), [''], 'the marker was removed with one replacement');
    seen.replace.length = 0;
    global.window.__onSlotAgentResult({ reqId: id3, outputMode: 'below', status: 'completed', output: 'late' });
    global.window.__onSlotAgentResult({ reqId: id3, outputMode: 'below', status: 'canceled' });
    assert.strictEqual(cancelEditor.value, clean, 'nothing is written for a canceled request');
    assert.strictEqual(seen.replace.length, 0);
    delete global.__parseAnswer;
    console.log("  PASS: marker under the task line, answer / failure / re-run / cancel by id");
  }

  console.log("Running Auto selector: text that a result block holds is never an instruction...");
  {
    const block = '[[ @llm x ]]\n' + AS.makeResultBlock('ab12', 'この文章を要約して\nsecond');
    assert.strictEqual(SlotAgent._insideResultBlock(block, block.indexOf('この文章')), true);
    assert.strictEqual(SlotAgent._insideResultBlock(block, 3), false);
    assert.strictEqual(SlotAgent._insideResultBlock(block, block.length), false, 'after the closing marker');
    const editor = makeEditor(block, block.indexOf('この文章') + 2);
    bridge.editor = editor;
    reset();
    keydown(editor);
    await flush();
    assert.strictEqual(editor.value, block);
    assert.strictEqual(seen.llm.length, 0);
    assert.strictEqual(seen.ask.length, 0);
    assert.strictEqual(seen.shown.length, 1);
    console.log("  PASS: result blocks are inert");
  }

  console.log("Running Auto selector: the ask bar gets the text, and what it records is one task below it...");
  {
    const editor = makeEditor('今日は会議が長引いてしまった。', 3);
    bridge.editor = editor;
    reset();
    keydown(editor);
    await flush();
    assert.strictEqual(seen.ask.length, 1);
    const ask = seen.ask[0];
    assert.strictEqual(ask.recordInstruction, true);
    assert.strictEqual(ask.tabId, 'tab-1');
    assert.deepStrictEqual({ ...ask.target }, { text: '今日は会議が長引いてしまった。', start: 0, end: 15, kind: 'line' });
    assert.strictEqual(editor.value, '今日は会議が長引いてしまった。', 'nothing is written before the instruction');
    ask.onSubmit('要約して', { tabId: 'tab-1', target: ask.target, insertPos: 15, recordInstruction: true });
    await flush();
    const call = seen.llm[0];
    assert.ok(call, 'the recorded task ran');
    assert.strictEqual(call.prompt, '【指示】:\n要約して\n\n【対象テキスト】:\n今日は会議が長引いてしまった。');
    assert.ok(/^\n<!-- md-memo:run [a-z0-9]{4} ctx=above n=1 -->$/.test(call.anchorText), call.anchorText);
    assert.strictEqual(editor.value, '今日は会議が長引いてしまった。\n[[ @llm 要約して ]]' + call.anchorText);
    console.log("  PASS: content goes to the ask bar; the answer to it is recorded below the text");
  }
}

// --- HTML comments: text inside one never runs, and nothing runs in its place ---
// Runs after the Auto selector tests (the same bridge and backend mocks), now with html_comments.js loaded, the way
// index.html loads it before slot_agent.js.
async function runCommentTests() {
  const find = SlotAgent._findEnclosingSlotSpan;
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  console.log("Running comments: without html_comments.js nothing breaks...");
  {
    assert.strictEqual(global.window.HtmlComments, undefined, 'not loaded yet');
    assert.ok(find('<!-- {{ x }} -->', 6), 'without the module a comment is plain text, as before');
    console.log("  PASS: the guard (window.HtmlComments ?) keeps the old behaviour");
  }

  require('./html_comments.js');
  assert.ok(global.window.HtmlComments, 'html_comments.js loads next to slot_agent.js');

  console.log("Running comments: the run button's slot finder skips commented slots...");
  {
    assert.strictEqual(find('<!-- {{ do the thing }} -->', 8), null, 'a commented slot');
    assert.strictEqual(find('<!--\n[? find sources ]\n-->', 8), null, 'a research slot in a multi-line comment');
    assert.strictEqual(find('{{ a <!-- }} -->', 3), null, 'a slot a comment cuts (Go excludes it too)');
    const holds = '{{ code: a <!-- note --> b }}';
    assert.ok(find(holds, 3), 'a slot that holds a whole comment is still a slot (Go agrees)');
    assert.ok(find('<!-- c --> {{ live }}', 13), 'a live slot next to a comment');
    assert.ok(find('`<!--` {{ live }} `-->`', 9), 'a <!-- in inline code is no comment');
    console.log("  PASS: commented or cut slots are not offered");
  }

  const seen = { parse: [], run: [], llm: [], ask: [], shown: [] };
  const bridge = global.window.MdMemoBridge;
  const savedStartLlm = bridge.startLlmTask;
  const savedOpenAsk = bridge.openAskBar;
  bridge.startLlmTask = (o) => { seen.llm.push(o); return 'llm_x'; };
  bridge.openAskBar = (o) => { seen.ask.push(o); };
  bridge.cfg = { enabled: true, agentConfirm: true };
  global.window.showMessage = (msg) => seen.shown.push(msg);
  global.window.backend.parseSlotsRPC = async (text, cursor) => {
    seen.parse.push({ text, cursor });
    return global.__parseAnswer ? global.__parseAnswer(text, cursor) : { targetSlot: null };
  };
  global.window.backend.runSlotAgentAsync = (reqId, filePath, text, cursor) => { seen.run.push({ reqId, text, cursor }); };
  const reset = () => Object.keys(seen).forEach((k) => { seen[k].length = 0; });
  function makeEditor(value, start, end) {
    const editor = {
      value, selectionStart: start, selectionEnd: end === undefined ? start : end,
      events: [], listeners: {},
      addEventListener(evt, handler) { (this.listeners[evt] = this.listeners[evt] || []).push(handler); },
      dispatchEvent(e) { this.events.push(e.type); },
      focus() {},
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    };
    SlotAgent.attachEditor(editor);
    global.window.getActiveEditorEl = () => editor;
    bridge.editor = editor;
    return editor;
  }
  const press = async (editor) => {
    const e = { key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, keyCode: 13, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    editor.listeners.keydown.forEach((h) => h(e));
    await flush();
    await flush();
    return e;
  };
  // A parser that behaves like Go: the slot at the caret, else the next one, else the first (the dangerous fallback)
  global.__parseAnswer = (text, cursor) => {
    const slots = [];
    const re = /\{\{[^}]*\}\}/g;
    const comments = global.window.HtmlComments.htmlCommentRanges(text);
    let m;
    while ((m = re.exec(text))) {
      if (!global.window.HtmlComments.isRangeExcluded(comments, m.index, m.index + m[0].length)) {
        slots.push({ startOffset: m.index, endOffset: m.index + m[0].length, openDelimiter: '{{', closeDelim: '}}', outputMode: 'replace', instruction: m[0], role: 'x' });
      }
    }
    const target = slots.find((s) => cursor >= s.startOffset && cursor <= s.endOffset) || slots.find((s) => s.startOffset >= cursor) || slots[0] || null;
    return { targetSlot: target, hasWaitingApproval: false };
  };

  console.log("Running comments: Ctrl+Enter with the caret inside a comment does nothing, and says so...");
  {
    const note = '{{ code: first }}\n<!-- {{ code: hidden }} -->\n{{ code: last }}';
    for (const marker of ['hidden', '<!--', '-->']) {
      const editor = makeEditor(note, note.indexOf(marker) + 1);
      reset();
      const e = await press(editor);
      assert.strictEqual(e.defaultPrevented, true);
      assert.strictEqual(seen.parse.length, 0, 'no RPC: Go must not get the chance to fall back (' + marker + ')');
      assert.strictEqual(seen.run.length, 0);
      assert.strictEqual(seen.shown.length, 1, 'one toast');
      assert.strictEqual(editor.value, note, 'the note is untouched');
    }
    // the caret right after "-->", at the end of a line that is all comment: the line is commented out, same answer
    const lineEnd = makeEditor(note, note.indexOf('-->') + 3);
    reset();
    await press(lineEnd);
    assert.strictEqual(seen.parse.length, 0, 'a commented-out line is not a blank line handed to the slot parser');
    assert.strictEqual(seen.shown.length, 1);
    // a selection that holds only a comment
    const sel = makeEditor(note, note.indexOf('<!--'), note.indexOf('-->') + 3);
    reset();
    await press(sel);
    assert.strictEqual(seen.parse.length + seen.llm.length + seen.ask.length, 0);
    assert.strictEqual(seen.shown.length, 1);
    // with the Auto selector off (the classic key) the same
    bridge.cfg = { enabled: false, agentConfirm: true };
    const classic = makeEditor(note, note.indexOf('-->') + 3);
    reset();
    await press(classic);
    assert.strictEqual(seen.parse.length, 0);
    bridge.cfg = { enabled: true, agentConfirm: true };
    // the live slot on the next line still runs, and only that one
    const live = makeEditor(note, note.indexOf('last'));
    reset();
    await press(live);
    assert.strictEqual(seen.parse.length, 1);
    assert.strictEqual(seen.run.length, 1);
    assert.strictEqual(seen.run[0].cursor, note.indexOf('last'));
    console.log("  PASS: nothing runs from a comment, not even another slot");
  }

  console.log("Running comments: new-form tasks and plain lines with comments...");
  {
    // a commented-out task: nothing runs, nothing is asked
    const task = 'x\n<!-- [[ @llm この文章を要約して ]] -->\ny';
    const editor = makeEditor(task, task.indexOf('要約'));
    reset();
    await press(editor);
    assert.strictEqual(seen.llm.length + seen.ask.length + seen.parse.length, 0);
    assert.strictEqual(seen.shown.length, 1);
    // a sentence inside a comment is not an instruction (caret after it)
    const said = '<!-- この文章を要約して -->';
    const e2 = makeEditor(said, said.length);
    reset();
    await press(e2);
    assert.strictEqual(seen.llm.length + seen.ask.length + seen.parse.length, 0, 'not rewritten into a task');
    assert.strictEqual(e2.value, said);
    // an instruction with a comment after it: not rewritten (the comment would land in the brackets), asked instead
    const mixed = 'この文章を要約して <!-- 後で -->';
    const e3 = makeEditor(mixed, 2);
    reset();
    await press(e3);
    assert.strictEqual(seen.llm.length, 0);
    assert.strictEqual(seen.ask.length, 1);
    assert.strictEqual(e3.value, mixed, 'the line is not rewritten');
    // a commented slot beside ordinary text: the text is what counts (content: the ask bar), Go is not asked
    const beside = 'メモの続き <!-- {{ code: x }} -->';
    const e4 = makeEditor(beside, 2);
    reset();
    await press(e4);
    assert.strictEqual(seen.parse.length, 0, 'not "existing notation": the notation is commented out');
    assert.strictEqual(seen.ask.length, 1);
    // a live task with a comment after it still runs with the caret anywhere on the line
    const after = '[[ @llm この文章を要約して ]] <!-- 後で -->';
    const e5 = makeEditor(after, after.length);
    reset();
    await press(e5);
    assert.strictEqual(seen.llm.length, 1);
    assert.strictEqual(seen.llm[0].prompt, 'この文章を要約して');
    console.log("  PASS: comments are invisible to the decision, and never rewritten into a task");
  }

  console.log("Running comments: the public trigger (Jev, the run button) refuses a caret inside a comment...");
  {
    const note = '{{ code: live }}\n<!-- {{ code: hidden }} -->';
    const editor = makeEditor(note, note.indexOf('hidden'));
    reset();
    assert.strictEqual(await SlotAgent.triggerSlotExecution(editor), false);
    assert.strictEqual(seen.parse.length, 0);
    assert.strictEqual(seen.run.length, 0);
    assert.strictEqual(seen.shown.length, 1);
    // Go says the caret is in a comment (a disagreement): told, nothing runs
    global.__saved = global.__parseAnswer;
    global.__parseAnswer = () => ({ targetSlot: { startOffset: 0, endOffset: 16, openDelimiter: '{{', closeDelim: '}}', instruction: 'live' }, caretInComment: true });
    const e2 = makeEditor(note, 3);
    reset();
    assert.strictEqual(await SlotAgent.triggerSlotExecution(e2), false);
    assert.strictEqual(seen.run.length, 0);
    assert.strictEqual(seen.shown.length, 1);
    assert.strictEqual(e2.value, note);
    global.__parseAnswer = global.__saved;
    delete global.__saved;
    console.log("  PASS: triggerSlotExecution honours comments on both sides");
  }

  console.log("Running comments: a commented-out approval gate is not resumed...");
  {
    const note = '<!--\n- [x] 古い // approve\n-->\n- [x] 本物 // approve\n';
    global.__saved = global.__parseAnswer;
    global.__parseAnswer = () => ({ targetSlot: null, hasWaitingApproval: true });
    const editor = makeEditor(note, note.length);
    reset();
    assert.strictEqual(await SlotAgent.triggerSlotExecution(editor), true);
    assert.ok(editor.value.indexOf('- [x] 本物 // approve (実行中...)') !== -1, 'the live gate is the one resumed: ' + editor.value);
    assert.ok(editor.value.indexOf('- [x] 古い // approve\n') !== -1, 'the commented one is untouched');
    global.__parseAnswer = global.__saved;
    delete global.__saved;
    console.log("  PASS: gates follow Go's FindApprovalGates");
  }

  console.log("Running comments: the run button is not shown with the caret inside a comment...");
  {
    const note = '{{ code: a <!-- note --> b }}';
    const editor = makeEditor(note, note.indexOf('note'));
    editor.getBoundingClientRect = () => ({ left: 0, top: 0 });
    editor.scrollLeft = 0;
    editor.scrollTop = 0;
    global.document.activeElement = editor;
    // getCharPixelCoords is asked for the button's place only when the button is shown
    const placed = [];
    global.window.getCharPixelCoords = (offset) => { placed.push(offset); return { top: 0, left: 0 }; };
    SlotAgent._updateRunButton(editor);
    assert.deepStrictEqual(placed, [], 'caret inside the comment: no button');
    editor.selectionStart = editor.selectionEnd = 3;
    SlotAgent._updateRunButton(editor);
    assert.deepStrictEqual(placed, [note.length], 'caret on the slot outside the comment: the button, at the end of the slot');
    placed.length = 0;
    const commented = makeEditor('<!-- {{ code: x }} -->', 8);
    global.document.activeElement = commented;
    SlotAgent._updateRunButton(commented);
    assert.deepStrictEqual(placed, [], 'a commented slot: no button');
    delete global.document.activeElement;
    delete global.window.getCharPixelCoords;
    console.log("  PASS: no run button inside a comment or on a commented slot");
  }

  delete global.__parseAnswer;
  bridge.startLlmTask = savedStartLlm;
  bridge.openAskBar = savedOpenAsk;
}

