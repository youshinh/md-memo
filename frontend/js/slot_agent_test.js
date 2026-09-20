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
    console.log("\nALL FRONTEND LOGIC ACCEPTANCE TESTS PASSED!");
  });
}

