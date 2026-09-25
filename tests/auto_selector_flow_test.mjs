// Auto selector: the Ctrl+Enter flow end to end.
// The real app.js, slot_agent.js, task_manager.js, auto_selector.js, slot_snippets.js and i18n.js run in one vm context against a
// hand-made DOM (a textarea with a working undo stack, capture / bubble listener order, real toasts) and a mocked backend (LLM,
// slot parser in JS, command runner, agent runner). Nothing here starts a process or touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

// The comment rules the Go parser shares (html_comments.js == pkg/slotagent/comments.go), for the parser port below
const HC = createRequire(import.meta.url)('../frontend/js/html_comments.js');

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const SRC = {
  i18n: read('frontend/js/i18n.js'),
  taskManager: read('frontend/js/task_manager.js'),
  htmlComments: read('frontend/js/html_comments.js'),
  commentToggle: read('frontend/js/comment_toggle.js'),
  autoSelector: read('frontend/js/auto_selector.js'),
  snippets: read('frontend/js/slot_snippets.js'),
  slotAgent: read('frontend/js/slot_agent.js'),
  chromeLayout: read('frontend/js/chrome_layout.js'),
  app: read('frontend/js/app.js')
};

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(SRC.i18n + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------
const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane'];

async function flush() {
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A JS port of the Go slot parser, enough for {{ ... }}: every offset is a UTF-16 index (what the Go side converts to).
// HTML comments are excluded like FindExcludedRanges step 6 does (same scanner, same isOffsetExcluded rule).
function parseSlots(text, cfg) {
  const agents = cfg.agents || {};
  const resolve = (name) => {
    const wanted = name.toLowerCase();
    for (const key of Object.keys(agents)) {
      if (key.toLowerCase() === wanted) return key;
      if ((agents[key].aliases || []).some((a) => a.toLowerCase() === wanted)) return key;
    }
    return null;
  };
  const excluded = [];
  for (const re of [/```[^\n]*\n[\s\S]*?```/g, /`[^`\n]+`/g, /<!-- md-memo:res [\s\S]*?<!-- \/md-memo:res -->/g]) {
    for (const m of text.matchAll(re)) excluded.push([m.index, m.index + m[0].length]);
  }
  excluded.push(...HC.htmlCommentRanges(text));
  const slots = [];
  let idx = 0;
  while (idx < text.length) {
    const open = text.indexOf('{{', idx);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    if (close === -1) break;
    const end = close + 2;
    idx = open + 2;
    if (excluded.some(([s, e]) => (open >= s && open < e) || (end > s && end <= e))) continue;
    const trimmed = text.slice(open + 2, close).trim();
    if (trimmed.startsWith('⟳') || trimmed.startsWith('実行中')) { idx = end; continue; }
    const slot = { type: 'slot', openDelimiter: '{{', closeDelim: '}}', startOffset: open, endOffset: end, rawContent: trimmed, role: '', skillName: '', agentName: '', outputMode: 'replace', instruction: trimmed, isInline: false };
    if (trimmed.startsWith('@')) {
      const after = trimmed.slice(1);
      const sep = after.search(/[: \t\r\n]/);
      const name = sep === -1 ? after.trim() : after.slice(0, sep).trim();
      slot.instruction = sep === -1 ? '' : after.slice(sep).replace(/^:/, '').trim();
      slot.role = '@' + name;
      const key = resolve(name);
      if (key) { slot.agentName = key; slot.outputMode = 'below'; } else slot.skillName = name;
    } else if (trimmed.indexOf(':') !== -1) {
      const role = trimmed.slice(0, trimmed.indexOf(':')).trim();
      if (!/\s/.test(role) && role.length <= 20) { slot.role = role; slot.instruction = trimmed.slice(trimmed.indexOf(':') + 1).trim(); }
    }
    slots.push(slot);
    idx = end;
  }
  return slots;
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const windowListeners = {};
  const messages = [];
  const store = new Map(Object.entries(opts.localStorage || {}));
  const undoStack = [];
  const clock = { now: 1_700_000_000_000 };
  let documentMock = null;
  let windowMock = null;

  const addListener = (map, evt, fn, option) => {
    const capture = option === true || !!(option && typeof option === 'object' && option.capture);
    (map[evt] = map[evt] || []).push({ fn, capture });
  };
  const removeListener = (map, evt, fn, option) => {
    const capture = option === true || !!(option && typeof option === 'object' && option.capture);
    map[evt] = (map[evt] || []).filter((l) => !(l.fn === fn && l.capture === capture));
  };
  const makeEvent = (type, init) => Object.assign({
    type, key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false,
    defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; }
  }, init);
  // window capture -> element capture -> element bubble -> window bubble, stopPropagation ends the walk after the current phase
  function dispatchOn(el, evt, init) {
    const e = makeEvent(evt, init);
    e.target = el;
    const run = (list, capture) => {
      (list || []).filter((l) => l.capture === capture).slice().forEach((l) => l.fn(e));
      return e.propagationStopped;
    };
    if (evt === 'keydown' && run(windowListeners[evt], true)) return e;
    if (run(el._listeners[evt], true)) return e;
    if (run(el._listeners[evt], false)) return e;
    if (evt === 'keydown') run(windowListeners[evt], false);
    return e;
  }

  function mockElement(id, tagName = 'div') {
    const classes = new Set(HIDDEN_AT_START.includes(id) ? ['hidden'] : []);
    const attrs = {};
    let innerHTML = '';
    let textContent = '';
    const el = {
      id, tagName: tagName.toUpperCase(), dataset: {}, style: {}, children: [], checked: false, disabled: false, value: '',
      title: '', placeholder: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0, scrollLeft: 0,
      scrollHeight: 1000, clientHeight: 500, offsetHeight: 500, offsetWidth: 500, onclick: null, _listeners: {},
      classList: {
        add: (...cls) => cls.forEach((c) => classes.add(c)),
        remove: (...cls) => cls.forEach((c) => classes.delete(c)),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c)
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get innerHTML() { return innerHTML; },
      set innerHTML(v) { innerHTML = v; textContent = v; if (v === '') el.children = []; },
      get textContent() { return textContent; },
      set textContent(v) {
        textContent = v;
        innerHTML = v;
        if (id === 'stat-message' && v) messages.push(v);
      },
      addEventListener: (evt, fn, option) => addListener(el._listeners, evt, fn, option),
      removeEventListener: (evt, fn, option) => removeListener(el._listeners, evt, fn, option),
      dispatchEvent: (e) => dispatchOn(el, e.type, e),
      focus: () => { documentMock.activeElement = el; },
      blur: () => {},
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e) => { el.selectionStart = s; el.selectionEnd = e; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 500, right: 600, bottom: 500 }),
      scrollIntoView: () => {},
      appendChild: (child) => { el.children.push(child); child.parentElement = el; return child; },
      insertBefore: (node, ref) => {
        const i = el.children.indexOf(ref);
        if (i !== -1) el.children.splice(i, 0, node); else el.children.push(node);
        node.parentElement = el;
        return node;
      },
      querySelector: (sel) => (sel.startsWith('#') ? elements.get(sel.slice(1)) || null : null),
      querySelectorAll: () => [],
      getAttribute: (name) => (name in attrs ? attrs[name] : (name === 'data-i18n' ? el.dataset.i18n || null : null)),
      setAttribute: (name, val) => { attrs[name] = val; if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false
    };
    return el;
  }

  documentMock = {
    getElementById: (id) => {
      let el = elements.get(id);
      if (!el) {
        el = mockElement(id, (id === 'editor' || id === 'editor-secondary') ? 'textarea' : 'div');
        elements.set(id, el);
      }
      return el;
    },
    querySelector: (sel) => (sel.startsWith('#') ? documentMock.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => mockElement('', tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    // What the browser does for insertText: replace the selection of the focused field, one undo step, a native input event
    execCommand: (cmd, _ui, text) => {
      if (cmd !== 'insertText') return false;
      const ed = documentMock.activeElement;
      if (!ed || typeof ed.value !== 'string') return false;
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      undoStack.push({ ed, value: ed.value, start, end });
      ed.value = ed.value.slice(0, start) + text + ed.value.slice(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      dispatchOn(ed, 'input', {});
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: opts.language === 'ja' ? 'ja' : 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const calls = { llm: [], parse: [], runAgent: [], cancelAgent: [], command: [], cancelCommand: [], validate: [], availability: [], confirms: [] };
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async () => {},
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    queryLLMAsync: (reqId, prompt, cfgJson) => { calls.llm.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); },
    parseSlotsRPC: async (text, cursor, cfgJson) => {
      calls.parse.push({ text, cursor });
      const slots = parseSlots(text, JSON.parse(cfgJson));
      // Go (ParseSlotsRPC): a caret inside a comment targets nothing and never falls back
      if (HC.isInsideComment(text, cursor)) return { targetSlot: null, allSlots: slots, hasWaitingApproval: false, caretInComment: true };
      let target = slots.find((s) => cursor >= s.startOffset && cursor <= s.endOffset) || slots.find((s) => s.startOffset >= cursor) || slots[0] || null;
      return { targetSlot: target ? Object.assign({ isTarget: true }, target) : null, allSlots: slots, hasWaitingApproval: false };
    },
    runSlotAgentAsync: (reqId, filePath, text, cursor, cfgJson) => { calls.runAgent.push({ reqId, filePath, text, cursor, cfg: JSON.parse(cfgJson) }); },
    cancelSlotAgent: (reqId) => { calls.cancelAgent.push(reqId); },
    validateCliCommand: async (cmd) => { calls.validate.push(cmd); return { isSafe: true, isWarning: false, isBlocked: false, reason: '' }; },
    runCommandFilterAsync: (reqId, cmd, input) => { calls.command.push({ reqId, cmd, input }); },
    cancelCommandFilter: (reqId) => { calls.cancelCommand.push(reqId); },
    checkAgentAvailability: async (name) => { calls.availability.push(name); return { available: true, command: name }; }
  }, opts.backend || {});
  calls.cancelCommand = calls.cancelCommand || [];

  // Short timers (focus, one tick) run at once; anything of 100 ms or more (toast clearing, the run button's debounce, the
  // watchdogs, the task panel's badge) is held until the test asks for it, so a frozen clock cannot loop a re-arming timer.
  const heldTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 100) {
      heldTimers.set(id, { fn, ms });
      return id;
    }
    fn();
    return id;
  };

  windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows', language: opts.language === 'ja' ? 'ja-JP' : 'en-US' },
    addEventListener: (evt, fn, option) => addListener(windowListeners, evt, fn, option),
    removeEventListener: (evt, fn, option) => removeListener(windowListeners, evt, fn, option),
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { heldTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800
  };
  documentMock.defaultView = windowMock;

  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.now); }
    static now() { return clock.now; }
  }
  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    setInterval: () => 1, clearInterval: () => {}, Date: FakeDate,
    Event: class { constructor(type, init) { Object.assign(this, { type, defaultPrevented: false }, init || {}); } },
    console: { log() {}, warn() {}, error(...a) { if (opts.showErrors) console.error(...a); } }
  };
  vm.createContext(context);
  // the order of the page: i18n, task manager, the pure modules, slot agent, then the app
  const pageOrder = [SRC.i18n, SRC.taskManager, SRC.htmlComments, SRC.commentToggle, SRC.autoSelector, SRC.snippets, SRC.slotAgent, SRC.chromeLayout, SRC.app];
  for (const code of opts.withoutComments ? pageOrder.filter((c) => c !== SRC.htmlComments && c !== SRC.commentToggle) : pageOrder) {
    vm.runInContext(code, context);
    await flush();
  }
  windowMock.getCharPixelCoords = () => ({ top: 20, left: 30 });

  const el = (id) => documentMock.getElementById(id);
  const editor = el('editor');
  const env = {
    window: windowMock, backend, calls, messages, store, el, editor, clock, undoStack,
    bridge: windowMock.MdMemoBridge,
    config: windowMock.__testHelper.config,
    slotAgent: windowMock.SlotAgent,
    taskManager: windowMock.TaskManager,
    flush,
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, start, end) {
      editor.value = text;
      editor.selectionStart = start === undefined ? text.length : start;
      editor.selectionEnd = end === undefined ? editor.selectionStart : end;
      documentMock.activeElement = editor;
      undoStack.length = 0;
    },
    // the caret at the first occurrence of `marker` in the note (plus offset)
    caretAt(marker, offset = 0) {
      const at = editor.value.indexOf(marker);
      assert.ok(at !== -1, `the note has no "${marker}"`);
      editor.selectionStart = editor.selectionEnd = at + offset;
      documentMock.activeElement = editor;
    },
    // Ctrl+Enter in the editor, the way the browser delivers it; returns the event
    press(init) {
      documentMock.activeElement = editor;
      return dispatchOn(editor, 'keydown', Object.assign({ key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true }, init));
    },
    key(target, init) { return dispatchOn(typeof target === 'string' ? el(target) : target, 'keydown', init); },
    // native undo: the last edit made with insertText
    undo() {
      const entry = undoStack.pop();
      assert.ok(entry, 'nothing to undo');
      entry.ed.value = entry.value;
      entry.ed.selectionStart = entry.start;
      entry.ed.selectionEnd = entry.end;
    },
    toast: () => messages[messages.length - 1],
    activeTasks: () => plain(windowMock.TaskManager.getActiveTasks().map((t) => ({ id: t.id, type: t.type, agent: t.agent, instruction: t.instruction }))),
    // runs the held timers of exactly this delay (a watchdog)
    fireTimers(ms) {
      for (const [id, t] of Array.from(heldTimers)) if (t.ms === ms) { heldTimers.delete(id); t.fn(); }
    },
    fireAllHeldTimers() {
      for (const [id, t] of Array.from(heldTimers)) { heldTimers.delete(id); t.fn(); }
    },
    heldTimerCount: (ms) => Array.from(heldTimers.values()).filter((t) => t.ms === ms).length,
    abort: (id) => windowMock.TaskManager.cancelTask(id),
    llmAnswer: (call, text, error = '') => windowMock.__onLLMResult(call.reqId, text, error),
    cliAnswer: (call, result, error = '') => windowMock.__onCliFilterResult(call.reqId, result, error),
    agentAnswer(run, extra) {
      const slots = parseSlots(run.text, run.cfg);
      const slot = slots.find((s) => run.cursor >= s.startOffset && run.cursor <= s.endOffset) || slots[0];
      windowMock.__onSlotAgentResult(Object.assign({
        reqId: run.reqId, type: 'slot', role: slot.role, instruction: slot.instruction, startOffset: slot.startOffset, endOffset: slot.endOffset,
        oldContent: run.text.slice(slot.startOffset, slot.endOffset), newContent: run.text.slice(slot.startOffset, slot.endOffset), output: '',
        outputMode: slot.outputMode, isInline: false, errorMsg: '', exitCode: 0, status: 'completed'
      }, extra));
    }
  };
  return env;
}

const RUN_MARKER = /<!-- md-memo:run ([a-z0-9]+)((?: [a-z0-9_]+=[a-z0-9_]+)*) -->/;
const idOf = (text) => {
  const m = RUN_MARKER.exec(text) || /<!-- md-memo:res ([a-z0-9]+)/.exec(text);
  assert.ok(m, `no marker in ${JSON.stringify(text)}`);
  return m[1];
};
const run = (id, attrs = '') => `<!-- md-memo:run ${id}${attrs} -->`;
const res = (id, body, attrs = '') => `<!-- md-memo:res ${id}${attrs} -->\n${body}\n<!-- /md-memo:res -->`;

// ---------------------------------------------------------------------------------------------------
// 1. Instruction lines: rewritten into a task and run
// ---------------------------------------------------------------------------------------------------
check('instruction line (Japanese, with text before it): the line becomes [[ @llm ]], the marker goes under it, the answer replaces the marker', async () => {
  const env = await createEnv({ language: 'ja' });
  env.setNote('前の行\nこの文章を要約して\n次の行', 0);
  env.caretAt('この文章を要約して', 4);
  const event = env.press();
  assert.equal(event.defaultPrevented, true, 'the key is taken');
  await env.flush();

  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `前の行\n[[ @llm この文章を要約して ]]\n${run(id)}\n次の行`);
  assert.equal(env.calls.llm.length, 1);
  assert.equal(env.calls.llm[0].prompt, 'この文章を要約して', 'a plain instruction is the whole prompt');
  assert.deepEqual(env.calls.llm[0].cfg, plain(env.config.text), 'the built-in LLM is asked');
  assert.equal(env.calls.parse.length, 0, 'no RPC for the decision');
  assert.deepEqual(env.activeTasks(), [{ id: env.calls.llm[0].reqId, type: 'llm', agent: 'LLM', instruction: 'この文章を要約して' }]);
  assert.equal(env.editor.selectionStart, env.editor.value.indexOf(']]\n') + 2, 'the caret stays at the end of the task line');
  assert.equal(env.slotAgent._runningTaskCount(), 1);

  env.llmAnswer(env.calls.llm[0], '  要約です\n  二行目  \n');
  assert.equal(env.editor.value, `前の行\n[[ @llm この文章を要約して ]]\n${res(id, '要約です\n  二行目')}\n次の行`, 'the instruction line is kept, the answer is trimmed');
  assert.equal(env.editor.selectionStart, env.editor.value.indexOf(']]\n') + 2, 'the caret stays on the task line (not on the closing marker line, where typing would spoil the block)');
  assert.equal(env.editor.selectionEnd, env.editor.selectionStart);
  assert.equal(env.slotAgent._runningTaskCount(), 0);
  assert.equal(env.activeTasks().length, 0);
});

// The marker line and the result block are bookkeeping: a position that was at the end of the line (a caret there, a selected
// line, a line selected together with its line break) must stay on the task line. It used to slide to the end of the marker
// line, so the selection grew over the marker and the answer (and typing or Ctrl+E / Ctrl+L afterwards acted on all of it).
check('the caret at the end of the line, a selected line, a line selected with its line break: the selection stays on the task line, before and after the answer', async () => {
  const line = 'この文章を要約して';
  const rows = [
    ['caret at the end of the line', (ls, le) => [le, le], (ls, taskEnd) => [taskEnd, taskEnd]],
    ['the line selected', (ls, le) => [ls, le], (ls, taskEnd) => [ls, taskEnd]],
    ['the line selected with its line break', (ls, le) => [ls, le + 1], (ls, taskEnd) => [ls, taskEnd]]
  ];
  for (const [label, select, expected] of rows) {
    const env = await createEnv({ language: 'ja' });
    env.setNote(`前の行\n${line}\n次の行`, 0);
    const ls = env.editor.value.indexOf(line);
    const le = ls + line.length;
    const [start, end] = select(ls, le);
    env.editor.selectionStart = start;
    env.editor.selectionEnd = end;
    env.press();
    await env.flush();

    const id = idOf(env.editor.value);
    assert.equal(env.editor.value, `前の行\n[[ @llm ${line} ]]\n${run(id)}\n次の行`, label);
    const taskEnd = env.editor.value.indexOf(']]\n') + 2;
    assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], expected(ls, taskEnd), `${label}: right after the rewrite`);

    env.llmAnswer(env.calls.llm[0], '要約です');
    assert.equal(env.editor.value, `前の行\n[[ @llm ${line} ]]\n${res(id, '要約です')}\n次の行`, label);
    assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], expected(ls, taskEnd), `${label}: after the answer`);
  }
});

check('an agent task that is selected as a line (with its line break) keeps the selection on the task line while it runs and after its answer', async () => {
  const env = await createEnv({ language: 'ja' });
  env.setNote('メモ\n{{ @claude-code テストを実行して }}\nおわり', 0);
  const ls = env.editor.value.indexOf('{{');
  env.editor.selectionStart = ls;
  env.editor.selectionEnd = env.editor.value.indexOf('}}\n') + 3;
  env.press();
  await env.flush();

  const id = idOf(env.editor.value);
  const taskEnd = env.editor.value.indexOf('}}\n') + 2;
  assert.equal(env.editor.value, `メモ\n{{ @claude-code テストを実行して }}\n${run(id)}\nおわり`);
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [ls, taskEnd], 'the selection stops at the end of the task line, before the marker');

  const runCall = env.calls.runAgent[0];
  env.agentAnswer(runCall, { output: '3 passed', newContent: runCall.text.slice(runCall.text.indexOf('{{'), runCall.text.indexOf('}}') + 2) });
  assert.equal(env.editor.value, `メモ\n{{ @claude-code テストを実行して }}\n${res(id, '3 passed')}\nおわり`);
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [ls, taskEnd], 'and it is still there after the answer');
});

check('list, quote and numbered prefixes are kept by the rewrite', async () => {
  const rows = [
    ['- この文章を要約して', '- [[ @llm この文章を要約して ]]'],
    ['> 英語に翻訳してください', '> [[ @llm 英語に翻訳してください ]]'],
    ['1. 校正して', '1. [[ @llm 校正して ]]'],
    ['  - [ ] 箇条書きにして', '  - [ ] [[ @llm 箇条書きにして ]]'],
    ['Summarize the following text in 3 bullet points', '[[ @llm Summarize the following text in 3 bullet points ]]'],
    ['@llm 要約して', '[[ @llm 要約して ]]']
  ];
  for (const [line, task] of rows) {
    const env = await createEnv();
    env.setNote(`top\n${line}\nbottom`);
    env.caretAt(line, 3);
    env.press();
    await env.flush();
    const id = idOf(env.editor.value);
    assert.equal(env.editor.value, `top\n${task}\n${run(id)}\nbottom`, line);
    assert.equal(env.calls.llm.length, 1, line);
  }
});

check('a task already in the note runs as it is; a caret anywhere on a task-only line works', async () => {
  const env = await createEnv();
  env.setNote('intro\n- [[ @llm 3行で要約して ]]  \nouter');
  env.caretAt('- [[', 0);
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `intro\n- [[ @llm 3行で要約して ]]  \n${run(id)}\nouter`, 'the line is not modified, the marker goes after it');
  assert.equal(env.calls.llm[0].prompt, '3行で要約して');
  assert.equal(env.undoStack.length, 1, 'starting a task is one edit');
});

// ---------------------------------------------------------------------------------------------------
// 2. When the selector must step aside (contract section 3, rows 2 and 3, and 3b)
// ---------------------------------------------------------------------------------------------------
check('LLM not configured: a toast, nothing else (the note is untouched, no request)', async () => {
  const env = await createEnv();
  env.config.text = { baseUrl: '', model: '', apiKey: '' };
  const note = 'この文章を要約して';
  env.setNote(note);
  env.press();
  await env.flush();
  assert.equal(env.editor.value, note);
  assert.deepEqual(env.messages.filter((m) => m === I18N.en.askLlmNotConfigured), [I18N.en.askLlmNotConfigured]);
  assert.equal(env.calls.llm.length, 0);
  assert.equal(env.undoStack.length, 0);

  // the same for a task that is already written, and for the ask bar (a line that is not clearly a request)
  env.setNote('[[ @llm 要約して ]]');
  env.press();
  await env.flush();
  assert.equal(env.editor.value, '[[ @llm 要約して ]]');
  env.setNote('今日は会議が長引いてしまった。');
  env.press();
  await env.flush();
  assert.equal(env.hidden('inline-prompt-bar'), true, 'no bar that could not do anything');
  assert.equal(env.editor.value, '今日は会議が長引いてしまった。');
  assert.equal(env.messages.filter((m) => m === I18N.en.askLlmNotConfigured).length, 3);
});

check('auto mode off: the old behaviour (next slot, else the no-slot toast); an explicit task still runs', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled: false } }) } });
  env.setNote('この文章を要約して\n\n{{ calc: 1+1 }}', 0);
  env.press();
  await env.flush();
  assert.equal(env.calls.parse.length, 1, 'the slot parser is asked');
  assert.equal(env.editor.value.split('\n')[0], 'この文章を要約して', 'the line is not rewritten');
  assert.ok(env.editor.value.includes('{{ ⟳ 実行中... }}'), 'the slot after the caret ran, as before');
  assert.equal(env.calls.llm.length, 0);
  assert.equal(env.calls.runAgent.length, 1);

  const none = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled: false } }) } });
  none.setNote('just a line of text');
  none.press();
  await none.flush();
  assert.equal(none.messages[none.messages.length - 1], I18N.en.slotNoTargetFound);
  assert.equal(none.editor.value, 'just a line of text');

  const task = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled: false } }) } });
  task.setNote('[[ @llm 要約して ]]');
  task.press();
  await task.flush();
  assert.equal(task.calls.llm.length, 1, 'a task the user wrote is not a guess');
});

check('a blank line and a code fence fall back to the old behaviour', async () => {
  const blank = await createEnv();
  blank.setNote('text\n\n{{ calc: 1+1 }}', 5);
  blank.press();
  await blank.flush();
  assert.equal(blank.calls.parse.length, 1);
  assert.ok(blank.editor.value.includes('{{ ⟳ 実行中... }}'), 'the next slot after the caret');
  assert.equal(blank.calls.llm.length, 0);
  assert.equal(blank.el('inline-prompt-bar').classList.contains('hidden'), true);

  const fence = await createEnv();
  const note = '```\nこの文章を要約して\n[[ @llm 要約して ]]\n```';
  fence.setNote(note);
  fence.caretAt('この文章を要約して', 2);
  fence.press();
  await fence.flush();
  assert.equal(fence.editor.value, note, 'nothing inside a fence is rewritten');
  fence.caretAt('[[ @llm', 3);
  fence.press();
  await fence.flush();
  assert.equal(fence.editor.value, note, 'and no task inside a fence runs');
  assert.equal(fence.calls.llm.length, 0);
});

check('a recipe\'s approval gate line ("- [x] ... // approve") resumes the recipe the old way: it is not rewritten, not sent to the LLM, no ask bar', async () => {
  for (const gate of ['- [x] 次のステップ（レビューを実行）を実行する // approve', '- [x] 要約して // approve', '- [x] Run the tests and fix failures // approve']) {
    const env = await createEnv();
    const note = `見出し\n${gate}\n末尾`;
    env.setNote(note);
    env.caretAt(gate.slice(6, 12), 2);
    env.press();
    await env.flush();
    assert.equal(env.editor.value, note, `the gate line is left as it is: ${gate}`);
    assert.equal(env.calls.parse.length, 1, 'the old path asked the parser (which knows the gates)');
    assert.equal(env.calls.llm.length, 0, 'nothing was sent to the LLM');
    assert.equal(env.el('inline-prompt-bar').classList.contains('hidden'), true, 'and no ask bar opened');
  }
});

check('an IME confirmation (isComposing / keyCode 229) is left alone: nothing happens and the key is not taken', async () => {
  const env = await createEnv();
  env.setNote('この文章を要約して');
  const a = env.press({ isComposing: true });
  const b = env.press({ keyCode: 229 });
  await env.flush();
  assert.equal(a.defaultPrevented, false);
  assert.equal(b.defaultPrevented, false);
  assert.equal(env.editor.value, 'この文章を要約して');
  assert.equal(env.calls.llm.length, 0);
  const held = env.press({ repeat: true });
  assert.equal(held.defaultPrevented, true, 'a held key is swallowed');
  await env.flush();
  assert.equal(env.calls.llm.length, 0, 'but does not start a run');
});

// ---------------------------------------------------------------------------------------------------
// 3. Agents
// ---------------------------------------------------------------------------------------------------
check('agent instruction: rewritten to {{ @agent }} and stopped (toast, one undo step, Ctrl+Z is not hijacked); the second press runs it below', async () => {
  const env = await createEnv({ language: 'ja' });
  env.setNote('メモ\nテストを実行して\nおわり');
  env.caretAt('テストを実行して', 3);
  env.press();
  await env.flush();
  assert.equal(env.editor.value, 'メモ\n{{ @claude-code テストを実行して }}\nおわり');
  assert.equal(env.calls.runAgent.length, 0, 'it stops after the rewrite');
  assert.equal(env.calls.parse.length, 0);
  assert.equal(env.toast(), I18N.ja.autoSelAgentDecorated.replaceAll('{key}', 'Ctrl'), 'the toast says how to run and how to undo');
  assert.deepEqual(env.calls.availability, ['claude-code'], 'the agent is looked up');
  assert.equal(env.undoStack.length, 1, 'the rewrite is a single undo step');
  const undo = env.key('editor', { key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.equal(undo.defaultPrevented, false, 'Ctrl+Z reaches the browser: nothing was registered as a slot merge');
  env.undo();
  assert.equal(env.editor.value, 'メモ\nテストを実行して\nおわり', 'one undo restores the original line');

  env.press();
  await env.flush();
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `メモ\n{{ @claude-code テストを実行して }}\n${run(id)}\nおわり`, 'the second press runs it: the task line is kept, the marker goes under it');
  assert.equal(env.calls.runAgent.length, 1);
  const runCall = env.calls.runAgent[0];
  assert.equal(runCall.text, env.editor.value, 'the agent gets the note with the marker in it');
  assert.equal(runCall.cursor, env.editor.value.indexOf('{{') + 1, 'the cursor is inside the task, in UTF-16 units');
  assert.deepEqual(env.activeTasks(), [{ id: runCall.reqId, type: 'slot', agent: 'claude-code', instruction: 'テストを実行して' }]);

  env.agentAnswer(runCall, { output: '  3 passed\n', newContent: runCall.text.slice(runCall.text.indexOf('{{'), runCall.text.indexOf('}}') + 2) });
  assert.equal(env.editor.value, `メモ\n{{ @claude-code テストを実行して }}\n${res(id, '3 passed')}\nおわり`, 'the raw output, trimmed, in a result block');
  assert.equal(env.editor.selectionStart, env.editor.value.indexOf('}}\n') + 2, 'the caret stays on the task line here too');
  assert.equal(env.slotAgent._runningTaskCount(), 0);
  assert.equal(env.activeTasks().length, 0);
});

check('agent: an explicit @alias, agentConfirm off (runs at once), a missing agent (warning), a failed run (one-line error block)', async () => {
  const stored = { md_notepad_config_v3: JSON.stringify({ autoSelector: { agentConfirm: false } }) };
  const now = await createEnv({ localStorage: stored });
  now.setNote('@cc 依存パッケージを更新して');
  now.press();
  await now.flush();
  const id = idOf(now.editor.value);
  assert.equal(now.editor.value, `{{ @claude-code 依存パッケージを更新して }}\n${run(id)}`, 'rewritten and run in one press, the alias resolved to the key');
  assert.equal(now.calls.runAgent.length, 1);
  assert.equal(now.calls.runAgent[0].cursor, 1, 'inside the task: start + 1');
  now.agentAnswer(now.calls.runAgent[0], { status: 'failed', exitCode: 1, errorMsg: 'claude: command not found\nsecond line' });
  assert.equal(now.editor.value, `{{ @claude-code 依存パッケージを更新して }}\n${res(id, '[claude-code error: claude: command not found second line]')}`);
  assert.deepEqual(now.activeTasks(), []);

  const missing = await createEnv({ backend: { checkAgentAvailability: async () => ({ available: false, command: 'claude' }) } });
  missing.setNote('バグを修正してください');
  missing.press();
  await missing.flush();
  assert.equal(missing.editor.value, '{{ @claude-code バグを修正してください }}', 'still rewritten: it is only text');
  assert.equal(missing.toast(), I18N.en.autoSelAgentDecoratedMissing.replaceAll('{agent}', 'claude-code').replaceAll('{key}', 'Ctrl'));
  assert.equal(missing.calls.runAgent.length, 0);

  const skill = await createEnv();
  skill.setNote('{{ @code-review src/ を見て }}', 4);
  skill.press();
  await skill.flush();
  assert.equal(skill.calls.parse.length, 1, 'a skill mention is the old slot: replace mode');
  assert.ok(skill.editor.value.includes('{{ ⟳ 実行中... }}'));
  assert.ok(!skill.editor.value.includes('md-memo:run'), 'no marker for a skill');
});

check('agent task typed by hand: a caret before it (multi-line selection) still runs that task; a second press while it runs says so', async () => {
  const env = await createEnv();
  env.setNote('見出し\n{{ @claude READMEを整えて }}\n末尾');
  env.editor.selectionStart = 0;
  env.editor.selectionEnd = env.editor.value.length;
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.calls.runAgent.length, 1);
  assert.equal(env.calls.runAgent[0].cursor, env.editor.value.indexOf('{{') + 1, 'the cursor override names the task, not the selection start');
  assert.equal(env.editor.value, `見出し\n{{ @claude READMEを整えて }}\n${run(id)}\n末尾`);

  env.caretAt('{{ @claude', 4);
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1, 'not started twice');
  assert.equal(env.toast(), I18N.en.slotAlreadyRunning);
  assert.equal(env.editor.value.match(/md-memo:run/g).length, 1, 'no second marker');
});

// ---------------------------------------------------------------------------------------------------
// 4. Commands
// ---------------------------------------------------------------------------------------------------
check('command line: rewritten to [[ $ ]] and stopped; the second press validates, runs with no input, and writes the output in a fence', async () => {
  const env = await createEnv();
  env.setNote('before\ngit status\nafter');
  env.caretAt('git status', 4);
  env.press();
  await env.flush();
  assert.equal(env.editor.value, 'before\n[[ $ git status ]]\nafter');
  assert.equal(env.toast(), I18N.en.autoSelCommandDecorated.replaceAll('{key}', 'Ctrl'));
  assert.equal(env.calls.command.length, 0);
  assert.equal(env.undoStack.length, 1);

  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `before\n[[ $ git status ]]\n${run(id)}\nafter`);
  assert.deepEqual(env.calls.validate, ['git status']);
  assert.equal(env.calls.command.length, 1);
  assert.equal(env.calls.command[0].cmd, 'git status');
  assert.equal(env.calls.command[0].input, '', 'no stdin');
  assert.deepEqual(env.activeTasks(), [{ id: env.calls.command[0].reqId, type: 'command', agent: 'Command', instruction: 'git status' }]);

  env.cliAnswer(env.calls.command[0], { output: 'On branch main\r\nnothing to commit\r\n', error: '', exitCode: 0 });
  assert.equal(env.editor.value, `before\n[[ $ git status ]]\n${res(id, '```\nOn branch main\nnothing to commit\n```')}\nafter`);
  assert.equal(env.slotAgent._runningTaskCount(), 0);
  assert.equal(env.activeTasks().length, 0);
  assert.equal(env.toast(), I18N.en.autoSelCommandDone);
});

check('command output: a fence longer than any backtick run in it; a failing command adds its stderr and an exit code line', async () => {
  const env = await createEnv();
  env.setNote('[[ $ cat notes.md ]]');
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  env.cliAnswer(env.calls.command[0], { output: 'a\n```js\nx\n```\nb\n', error: '', exitCode: 0 });
  assert.equal(env.editor.value, `[[ $ cat notes.md ]]\n${res(id, '````\na\n```js\nx\n```\nb\n````')}`, 'four backticks around three');

  const bad = await createEnv();
  bad.setNote('[[ $ npm test ]]');
  bad.press();
  await bad.flush();
  const badId = idOf(bad.editor.value);
  bad.cliAnswer(bad.calls.command[0], { output: 'partial\n', error: 'npm ERR! missing script', exitCode: 2 });
  assert.equal(bad.editor.value, `[[ $ npm test ]]\n${res(badId, '```\npartial\nnpm ERR! missing script\nexit code 2\n```')}`);
  assert.equal(bad.messages[bad.messages.length - 1], I18N.en.cliError.replace('{err}', 'npm ERR! missing script'));

  const lost = await createEnv();
  lost.setNote('[[ $ ls ]]');
  lost.press();
  await lost.flush();
  const lostId = idOf(lost.editor.value);
  lost.cliAnswer(lost.calls.command[0], null, 'backend went away');
  assert.equal(lost.editor.value, `[[ $ ls ]]\n${res(lostId, '```\nbackend went away\n```')}`, 'an error with no result is still a block');
});

check('command safety: blocked = refused with the reason, warning = a confirm dialog (refused or accepted); the note is untouched until it runs', async () => {
  const blocked = await createEnv({ backend: { validateCliCommand: async () => ({ isBlocked: true, reason: 'formats the disk' }) } });
  blocked.setNote('[[ $ format c: ]]');
  blocked.press();
  await blocked.flush();
  assert.equal(blocked.editor.value, '[[ $ format c: ]]');
  assert.equal(blocked.toast(), I18N.en.cliBlockedError.replace('{reason}', 'formats the disk'));
  assert.equal(blocked.calls.command.length, 0);
  assert.equal(blocked.undoStack.length, 0);

  const warn = await createEnv({ backend: { validateCliCommand: async () => ({ isWarning: true, reason: 'deletes files' }) } });
  warn.setNote('[[ $ rm -rf build ]]');
  warn.press();
  await warn.flush();
  assert.equal(warn.hidden('confirm-modal'), false, 'the confirm dialog is up');
  assert.ok(warn.el('confirm-modal-message').textContent.includes('deletes files') && warn.el('confirm-modal-message').textContent.includes('rm -rf build'));
  assert.equal(warn.editor.value, '[[ $ rm -rf build ]]', 'nothing is written while it waits');
  warn.el('confirm-modal-cancel').onclick();
  await warn.flush();
  assert.equal(warn.editor.value, '[[ $ rm -rf build ]]');
  assert.equal(warn.calls.command.length, 0);
  assert.equal(warn.toast(), I18N.en.cliCancelled);

  warn.press();
  await warn.flush();
  warn.el('confirm-modal-ok').onclick();
  await warn.flush();
  assert.equal(warn.calls.command.length, 1, 'confirmed: it runs');
  assert.ok(RUN_MARKER.test(warn.editor.value));

  const noNative = await createEnv({ backend: { runCommandFilterAsync: undefined } });
  noNative.setNote('[[ $ ls ]]');
  noNative.press();
  await noNative.flush();
  assert.equal(noNative.editor.value, '[[ $ ls ]]', 'no native runner: the note is untouched');
  assert.equal(noNative.toast(), I18N.en.autoSelCommandNativeOnly);
});

check('command with agentConfirm off: one press validates and runs', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { agentConfirm: false } }) } });
  env.setNote('git log --oneline -5');
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `[[ $ git log --oneline -5 ]]\n${run(id)}`);
  assert.equal(env.calls.command.length, 1);
});

// ---------------------------------------------------------------------------------------------------
// 5. The ask bar: text that is not clearly a request
// ---------------------------------------------------------------------------------------------------
check('content line: the ask bar opens on it (note untouched); the instruction is recorded below as a task with ctx=above and run with the line as its subject', async () => {
  const env = await createEnv();
  const line = '今日は会議が長引いてしまった。';
  env.setNote(`# メモ\n${line}\n次の段落`);
  env.caretAt(line, 3);
  env.press();
  await env.flush();
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.el('inline-prompt-target').textContent, I18N.en.askTargetLine);
  assert.equal(env.el('inline-prompt-input').placeholder, I18N.en.askPlaceholderRecord);
  assert.equal(env.editor.value, `# メモ\n${line}\n次の段落`, 'nothing is written before the instruction');
  assert.equal(env.calls.llm.length, 0);

  env.el('inline-prompt-input').value = '要約して';
  env.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `# メモ\n${line}\n[[ @llm 要約して ]]\n${run(id, ' ctx=above n=1')}\n次の段落`, 'the text is untouched; a task and its marker are below it');
  assert.equal(env.calls.llm.length, 1);
  assert.equal(env.calls.llm[0].prompt, `【指示】:\n要約して\n\n【対象テキスト】:\n${line}`);
  assert.equal(env.hidden('inline-prompt-bar'), true);
  assert.equal(env.undoStack.length, 1, 'the task and its marker are one edit');
  assert.deepEqual(env.activeTasks().map((t) => t.instruction), ['要約して']);

  env.llmAnswer(env.calls.llm[0], '会議が長引いた。');
  assert.equal(env.editor.value, `# メモ\n${line}\n[[ @llm 要約して ]]\n${res(id, '会議が長引いた。', ' ctx=above n=1')}\n次の段落`);

  // pressing Ctrl+Enter on the recorded task again: same subject (the text above it), the block replaced, not stacked
  env.caretAt('[[ @llm 要約して', 3);
  env.press();
  await env.flush();
  const id2 = idOf(env.editor.value);
  assert.notEqual(id2, id);
  assert.equal(env.editor.value, `# メモ\n${line}\n[[ @llm 要約して ]]\n${run(id2, ' ctx=above n=1')}\n次の段落`, 'the old block is replaced by the new marker');
  assert.equal(env.calls.llm[1].prompt, `【指示】:\n要約して\n\n【対象テキスト】:\n${line}`, 'the subject is found again above the task');
  env.llmAnswer(env.calls.llm[1], '別の要約');
  assert.equal(env.editor.value.match(/<!-- md-memo:res /g).length, 1, 'exactly one block');
});

check('a second instruction under the same text: the first task and its block are looked through to find the text', async () => {
  const env = await createEnv();
  env.setNote('ノートの本文です。\nとても大事な話。');
  env.caretAt('とても', 2);
  env.press();
  await env.flush();
  env.el('inline-prompt-input').value = '要約して';
  env.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await env.flush();
  env.llmAnswer(env.calls.llm[0], '要約A');

  // the user adds a second task line by hand, right under the first block, and asks for a tone change
  env.editor.value += '\n[[ @llm 敬語に直して ]]';
  env.caretAt('[[ @llm 敬語', 3);
  env.press();
  await env.flush();
  assert.equal(env.calls.llm[1].prompt, '敬語に直して', 'a task typed by hand carries no hidden context');

  // ...whereas re-running the recorded one keeps its subject even with another task in between
  env.caretAt('[[ @llm 要約して', 3);
  env.press();
  await env.flush();
  assert.equal(env.calls.llm[2].prompt, '【指示】:\n要約して\n\n【対象テキスト】:\nとても大事な話。', 'the marker remembers the text was one line: the line above, not the paragraph');
});

check('a partial-line selection and a multi-line selection open the ask bar about the selection', async () => {
  const env = await createEnv();
  env.setNote('alpha beta gamma\ndelta epsilon');
  env.editor.selectionStart = 6;
  env.editor.selectionEnd = 10;
  env.press();
  await env.flush();
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.el('inline-prompt-target').textContent, I18N.en.askTargetSelection.replace('{count}', '4'));
  assert.equal(env.el('inline-prompt-target').title, 'beta');
  env.el('inline-prompt-input').value = 'translate to Japanese';
  env.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `alpha beta gamma\n[[ @llm translate to Japanese ]]\n${run(id, ' ctx=above n=1')}\ndelta epsilon`, 'below the LINE that holds the selection');
  assert.equal(env.calls.llm[0].prompt, '【指示】:\ntranslate to Japanese\n\n【対象テキスト】:\nbeta');

  const multi = await createEnv();
  multi.setNote('one\ntwo\nthree\nfour');
  multi.editor.selectionStart = 0;
  multi.editor.selectionEnd = 7;
  multi.press();
  await multi.flush();
  assert.equal(multi.el('inline-prompt-target').textContent, I18N.en.askTargetSelection.replace('{count}', '7'));
  multi.el('inline-prompt-input').value = 'まとめて';
  multi.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await multi.flush();
  const mid = idOf(multi.editor.value);
  assert.equal(multi.editor.value, `one\ntwo\n[[ @llm まとめて ]]\n${run(mid, ' ctx=above n=2')}\nthree\nfour`, 'never more than one task, below the last selected line');

  // a selection covering the whole line is the line: an instruction runs at once
  const whole = await createEnv();
  whole.setNote('- 英語に翻訳して\nnext');
  whole.editor.selectionStart = 0;
  whole.editor.selectionEnd = whole.editor.value.indexOf('\n') + 1;
  whole.press();
  await whole.flush();
  assert.equal(whole.calls.llm.length, 1);
  assert.ok(whole.editor.value.startsWith('- [[ @llm 英語に翻訳して ]]\n<!-- md-memo:run '));
});

check('an ask-bar task recorded after the note changed: the text is found again, or the task is not written', async () => {
  const env = await createEnv();
  const line = 'これは説明です。';
  env.setNote(`先頭\n${line}\n末尾`);
  env.caretAt(line, 2);
  env.press();
  await env.flush();
  env.editor.value = `新しい行\n先頭\n${line}\n末尾`;
  env.el('inline-prompt-input').value = '要約して';
  env.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `新しい行\n先頭\n${line}\n[[ @llm 要約して ]]\n${run(id, ' ctx=above n=1')}\n末尾`, 'the text moved: the task follows it');

  const gone = await createEnv();
  gone.setNote(`先頭\n${line}\n末尾`);
  gone.caretAt(line, 2);
  gone.press();
  await gone.flush();
  gone.editor.value = '全部書き換えた';
  gone.el('inline-prompt-input').value = '要約して';
  gone.key('inline-prompt-input', { key: 'Enter', keyCode: 13 });
  await gone.flush();
  assert.equal(gone.editor.value, '全部書き換えた');
  assert.equal(gone.calls.llm.length, 0);
  assert.equal(gone.toast(), I18N.en.autoSelNoteChanged);
});

// ---------------------------------------------------------------------------------------------------
// 6. Re-run, cancel, closing, adjacency, guards
// ---------------------------------------------------------------------------------------------------
check('re-run replaces a finished block and an orphan marker; a marker that is really running says so', async () => {
  const env = await createEnv();
  env.setNote(`[[ @llm 要約して ]]\n${res('aaaa', '古い答え')}\n後ろ`);
  env.caretAt('[[', 3);
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.notEqual(id, 'aaaa');
  assert.equal(env.editor.value, `[[ @llm 要約して ]]\n${run(id)}\n後ろ`, 'the old block is gone, never stacked');
  env.llmAnswer(env.calls.llm[0], '新しい答え');
  assert.equal(env.editor.value, `[[ @llm 要約して ]]\n${res(id, '新しい答え')}\n後ろ`);

  const orphan = await createEnv();
  orphan.setNote(`[[ $ ls ]]\n${run('zzzz')}\nend`);
  orphan.caretAt('[[', 3);
  orphan.press();
  await orphan.flush();
  const orphanId = idOf(orphan.editor.value);
  assert.notEqual(orphanId, 'zzzz');
  assert.equal(orphan.editor.value, `[[ $ ls ]]\n${run(orphanId)}\nend`, 'a marker left by a crash is replaced');
  assert.equal(orphan.editor.value.match(/md-memo:run/g).length, 1);

  const running = await createEnv();
  running.setNote('[[ @llm 要約して ]]');
  running.press();
  await running.flush();
  running.press();
  await running.flush();
  assert.equal(running.calls.llm.length, 1, 'no second request');
  assert.equal(running.toast(), I18N.en.slotAlreadyRunning);
  assert.equal(running.editor.value.match(/md-memo:run/g).length, 1);

  const indented = await createEnv();
  indented.setNote(`[[ @llm 要約して ]]\n   ${res('bbbb', 'x')}`);
  indented.caretAt('[[', 3);
  indented.press();
  await indented.flush();
  assert.ok(!indented.editor.value.includes('   <!--'), 'an indented old block goes too');
  assert.equal(indented.editor.value.match(/md-memo:(run|res)/g).length, 1);
});

check('cancel from the task panel: the note is restored byte for byte, the late answer is dropped (LLM, command, agent)', async () => {
  const llm = await createEnv();
  const original = 'a\n[[ @llm 要約して ]]\nb';
  llm.setNote(original);
  llm.caretAt('[[', 3);
  llm.press();
  await llm.flush();
  assert.notEqual(llm.editor.value, original);
  llm.abort(llm.calls.llm[0].reqId);
  assert.equal(llm.editor.value, original, 'marker and its line break are gone');
  llm.llmAnswer(llm.calls.llm[0], 'too late');
  assert.equal(llm.editor.value, original, 'a late answer finds nothing waiting');
  assert.equal(llm.slotAgent._runningTaskCount(), 0);
  assert.equal(llm.activeTasks().length, 0);
  llm.caretAt('[[', 3);
  llm.press();
  await llm.flush();
  assert.equal(llm.calls.llm.length, 2, 'and the task can be started again');

  const cmd = await createEnv();
  const cmdNote = 'x\n[[ $ ls -la ]]\ny';
  cmd.setNote(cmdNote);
  cmd.caretAt('[[', 3);
  cmd.press();
  await cmd.flush();
  const call = cmd.calls.command[0];
  cmd.abort(call.reqId);
  assert.deepEqual(cmd.calls.cancelCommand, [call.reqId], 'the command is stopped');
  assert.equal(cmd.editor.value, cmdNote);
  cmd.cliAnswer(call, { output: 'late', error: '', exitCode: 130 });
  assert.equal(cmd.editor.value, cmdNote, 'the answer of a stopped command is dropped');
  assert.equal(cmd.slotAgent._runningTaskCount(), 0);
  assert.equal(cmd.calls.cancelAgent.length, 0, 'the slot-agent RPC is not used for a command');

  const agent = await createEnv();
  const agentNote = 'top\n{{ @claude READMEを整えて }}\nbottom';
  agent.setNote(agentNote);
  agent.caretAt('{{', 4);
  agent.press();
  await agent.flush();
  const runCall = agent.calls.runAgent[0];
  agent.abort(runCall.reqId);
  assert.ok(agent.calls.cancelAgent.includes(runCall.reqId), 'the agent process is asked to stop');
  assert.equal(agent.editor.value, agentNote);
  agent.agentAnswer(runCall, { output: 'late output' });
  assert.equal(agent.editor.value, agentNote, 'a late result is ignored');
  agent.agentAnswer(runCall, { status: 'canceled' });
  assert.equal(agent.editor.value, agentNote, 'and so is the "canceled" report');
  assert.equal(agent.slotAgent._runningTaskCount(), 0);
});

check('cancel right after a rewrite leaves the rewritten line (the rewrite is the user\'s to undo)', async () => {
  const env = await createEnv();
  env.setNote('この文章を要約して\nnext', 0);
  env.press();
  await env.flush();
  env.abort(env.calls.llm[0].reqId);
  assert.equal(env.editor.value, '[[ @llm この文章を要約して ]]\nnext');
});

check('a note closed while its task runs: the answer is dropped and everything settles; a switched-away note still gets its answer', async () => {
  const env = await createEnv();
  env.window.__testHelper.createTab('B.md', 'b');
  const tabB = env.bridge.getActiveTab().id;
  env.setNote('B の行\n[[ @llm 要約して ]]');
  env.caretAt('[[', 3);
  env.press();
  await env.flush();
  assert.equal(env.slotAgent._runningTaskCount(), 1);
  env.window.__mdMemoRPC.closeTab(tabB);
  env.llmAnswer(env.calls.llm[0], 'answer');
  assert.equal(env.slotAgent._runningTaskCount(), 0, 'the running entry is released');
  assert.equal(env.activeTasks().length, 0);

  const other = await createEnv();
  const tabA = other.bridge.getActiveTab().id;
  other.setNote('A の行\n[[ @llm 要約して ]]');
  other.caretAt('[[', 3);
  other.press();
  await other.flush();
  const id = idOf(other.editor.value);
  other.window.__mdMemoRPC.newTab('B.md', 'B text');
  assert.notEqual(other.bridge.getActiveTab().id, tabA);
  other.llmAnswer(other.calls.llm[0], '別ノートの答え');
  assert.equal(other.slotAgent._runningTaskCount(), 0);
  other.window.__mdMemoRPC.switchTab(tabA);
  assert.equal(other.window.__mdMemoRPC.getBuffer(tabA).content, `A の行\n[[ @llm 要約して ]]\n${res(id, '別ノートの答え')}`, 'the note it was started in got the block');
});

check('UTF-16 end to end: Japanese and emoji before the task, on the line and inside it', async () => {
  const env = await createEnv();
  const smiley = String.fromCodePoint(0x1F600);
  const note = `${smiley}日本語${smiley}${smiley}\n${smiley} [[ @llm ${smiley}を要約して ]] ${smiley}\nおわり${smiley}`;
  env.setNote(note);
  env.caretAt('[[ @llm', 4);
  env.press();
  await env.flush();
  const id = idOf(env.editor.value);
  assert.equal(env.editor.value, `${smiley}日本語${smiley}${smiley}\n${smiley} [[ @llm ${smiley}を要約して ]] ${smiley}\n${run(id)}\nおわり${smiley}`, 'the marker is under the LINE, whatever is on it');
  assert.equal(env.calls.llm[0].prompt, `${smiley}を要約して`);
  env.llmAnswer(env.calls.llm[0], `${smiley}要約`);
  assert.equal(env.editor.value, `${smiley}日本語${smiley}${smiley}\n${smiley} [[ @llm ${smiley}を要約して ]] ${smiley}\n${res(id, `${smiley}要約`)}\nおわり${smiley}`);

  const agent = await createEnv();
  const agentNote = `${smiley}${smiley}あいう\n{{ @claude ${smiley}を直して }}\nend`;
  agent.setNote(agentNote);
  agent.caretAt('{{', 5);
  agent.press();
  await agent.flush();
  const agentId = idOf(agent.editor.value);
  assert.equal(agent.calls.runAgent[0].cursor, agentNote.indexOf('{{') + 1, 'the cursor names the task: its start + 1');
  assert.equal(agent.calls.runAgent[0].cursor, 2 + 2 + 3 + 1 + 1, 'in UTF-16 code units: two emoji count 4');
  agent.agentAnswer(agent.calls.runAgent[0], { output: 'ok' });
  assert.equal(agent.editor.value, `${smiley}${smiley}あいう\n{{ @claude ${smiley}を直して }}\n${res(agentId, 'ok')}\nend`);
});

check('two adjacent tasks run independently (no false "already running"), and their answers find their own markers in any order', async () => {
  const llm = await createEnv();
  llm.setNote('[[ @llm 一つ目 ]]\n[[ @llm 二つ目 ]]\n終わり');
  llm.caretAt('[[ @llm 一つ目', 3);
  llm.press();
  await llm.flush();
  llm.caretAt('[[ @llm 二つ目', 3);
  llm.press();
  await llm.flush();
  assert.equal(llm.calls.llm.length, 2);
  assert.equal(llm.slotAgent._runningTaskCount(), 2);
  const ids = [...llm.editor.value.matchAll(/md-memo:run ([a-z0-9]+)/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  llm.llmAnswer(llm.calls.llm[1], '答え二');
  llm.llmAnswer(llm.calls.llm[0], '答え一');
  assert.equal(llm.editor.value, `[[ @llm 一つ目 ]]\n${res(ids[0], '答え一')}\n[[ @llm 二つ目 ]]\n${res(ids[1], '答え二')}\n終わり`);

  const agents = await createEnv();
  agents.setNote('{{ @claude one }}\n{{ @claude two }}');
  agents.caretAt('{{ @claude one', 4);
  agents.press();
  await agents.flush();
  agents.caretAt('{{ @claude two', 4);
  agents.press();
  await agents.flush();
  assert.equal(agents.calls.runAgent.length, 2, 'the offset-distance guard is gone: two different slots are two runs');
  assert.equal(agents.messages.filter((m) => m === I18N.en.slotAlreadyRunning).length, 0);
  const agentIds = [...agents.editor.value.matchAll(/md-memo:run ([a-z0-9]+)/g)].map((m) => m[1]);
  agents.agentAnswer(agents.calls.runAgent[1], { output: 'second' });
  agents.agentAnswer(agents.calls.runAgent[0], { output: 'first' });
  assert.equal(agents.editor.value, `{{ @claude one }}\n${res(agentIds[0], 'first')}\n{{ @claude two }}\n${res(agentIds[1], 'second')}`);

  const legacy = await createEnv();
  legacy.setNote('{{ a: 1 }}{{ b: 2 }}');
  legacy.caretAt('{{ a', 3);
  legacy.press();
  await legacy.flush();
  legacy.caretAt('{{ b', 3);
  legacy.press();
  await legacy.flush();
  assert.equal(legacy.calls.runAgent.length, 2, 'two adjacent legacy slots are two runs too');
  assert.equal(legacy.editor.value, '{{ ⟳ 実行中... }}{{ ⟳ 実行中... }}');
});

check('double press: a second Ctrl+Enter while the parse RPC is pending does not start a second run', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await createEnv({
    backend: {
      parseSlotsRPC: async (text, cursor, cfg) => {
        await gate;
        const slots = parseSlots(text, JSON.parse(cfg));
        return { targetSlot: slots[0] || null, allSlots: slots };
      }
    }
  });
  env.setNote('{{ @claude READMEを整えて }}', 5);
  const first = env.press();
  const second = env.press();
  assert.equal(first.defaultPrevented, true);
  assert.equal(second.defaultPrevented, true, 'the key is still taken');
  release();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1);
  assert.equal(env.editor.value.match(/md-memo:run/g).length, 1);
  env.press();
  await env.flush();
  assert.equal(env.toast(), I18N.en.slotAlreadyRunning, 'after the first has started, the guard is the marker id');
});

check('a stale double-press guard (an RPC that never answered) does not lock the key for good', async () => {
  const env = await createEnv({ backend: { parseSlotsRPC: () => new Promise(() => {}) } });
  env.setNote('{{ calc: 1 }}', 4);
  env.press();
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 0);
  env.clock.now += 11000;
  env.backend.parseSlotsRPC = async (text) => ({ targetSlot: parseSlots(text, { agents: {} })[0] });
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1, 'ten seconds later the key works again');
});

check('text that only looks like notation is left alone: [[Wiki Link]], legacy {{ }} slots, a result block', async () => {
  const wiki = await createEnv();
  wiki.setNote('see [[Project A]] for details\n[[Project A]]');
  wiki.caretAt('[[Project A]] for', 4);
  wiki.press();
  await wiki.flush();
  assert.equal(wiki.editor.value, 'see [[Project A]] for details\n[[Project A]]', 'a wiki link is not a task');
  assert.equal(wiki.calls.llm.length, 0);
  assert.equal(wiki.hidden('inline-prompt-bar'), false, 'it is just text: the ask bar');

  const legacy = await createEnv();
  legacy.setNote('前置き\n{{ calc: 40 + 2 }}\n後書き');
  legacy.caretAt('{{ calc', 4);
  legacy.press();
  await legacy.flush();
  assert.equal(legacy.calls.parse.length, 1);
  assert.equal(legacy.editor.value, '前置き\n{{ ⟳ 実行中... }}\n後書き', 'replace mode, exactly as before');
  legacy.agentAnswer(legacy.calls.runAgent[0], { outputMode: 'replace', newContent: '42', output: '42' });
  legacy.clock.now += 1000;
  legacy.fireAllHeldTimers();
  await legacy.flush();
  assert.equal(legacy.editor.value, '前置き\n42\n後書き', 'the answer replaces the slot');

  const inside = await createEnv();
  const block = `[[ @llm 要約して ]]\n${res('aaaa', 'この文章を要約して\n[[ @llm 入れ子 ]]')}`;
  inside.setNote(block);
  inside.caretAt('この文章', 2);
  inside.press();
  inside.caretAt('[[ @llm 入れ子', 3);
  inside.press();
  await inside.flush();
  assert.equal(inside.editor.value, block, 'nothing runs or is written inside a result block');
  assert.equal(inside.toast(), I18N.en.autoSelInResult);
  assert.equal(inside.calls.llm.length, 0);
  assert.equal(inside.slotAgent._insideResultBlock(block, block.indexOf('[[ @llm 入れ子')), true);
  assert.equal(inside.slotAgent._insideResultBlock(block, 3), false, 'the task line above the block is outside it');
  assert.equal(inside.slotAgent._insideResultBlock('<!-- md-memo:res a -->\nx\n\ntext\n<!-- md-memo:res b -->\ny\n<!-- /md-memo:res -->', 30), false, 'text between an unclosed opener and a later block');
});

check('undo: the rewrite is one step; the answer replaces the marker in one more; nothing is hijacked', async () => {
  const env = await createEnv();
  env.setNote('この文章を要約して');
  env.press();
  await env.flush();
  assert.equal(env.undoStack.length, 1, 'rewrite + marker: one step');
  env.llmAnswer(env.calls.llm[0], 'answer');
  assert.equal(env.undoStack.length, 2, 'the answer: one more');
  const z = env.key('editor', { key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.equal(z.defaultPrevented, false, 'Ctrl+Z is the browser\'s');
  env.undo();
  env.undo();
  assert.equal(env.editor.value, 'この文章を要約して', 'two steps take it all back');
});

check('Ctrl+Z right after a rewrite undoes the rewrite even when an old slot result is still in the note (the toast promises it)', async () => {
  const env = await createEnv();
  env.setNote('前置き\n{{ calc: 40 + 2 }}\n後書き');
  env.caretAt('{{ calc', 4);
  env.press();
  await env.flush();
  env.agentAnswer(env.calls.runAgent[0], { outputMode: 'replace', newContent: '42', output: '42' });
  env.clock.now += 1000;
  env.fireAllHeldTimers();
  await env.flush();
  assert.equal(env.editor.value, '前置き\n42\n後書き', 'an old slot result (with its undo history) is in the note');

  env.setNote('前置き\n42\n後書き\nテストを実行して');
  env.caretAt('テストを実行して', 3);
  env.press();
  await env.flush();
  assert.match(env.editor.value, /\{\{ @claude-code テストを実行して \}\}$/, 'the line is rewritten as an agent task');

  const first = env.key('editor', { key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.equal(first.defaultPrevented, false, 'the first Ctrl+Z is the browser\'s: it undoes the rewrite');
  assert.ok(env.editor.value.includes('\n42\n'), 'the old result was not touched');
  const second = env.key('editor', { key: 'z', code: 'KeyZ', ctrlKey: true });
  assert.equal(second.defaultPrevented, true, 'after that the old behaviour is back: Ctrl+Z restores the slot');
  assert.ok(env.editor.value.includes('{{ calc: 40 + 2 }}'));
});

// ---------------------------------------------------------------------------------------------------
// 7. Run button
// ---------------------------------------------------------------------------------------------------
check('the run button appears on a task in the new notation (not while it runs) and its click runs the task through the same routine', async () => {
  const env = await createEnv();
  const button = () => env.window.document.body.children.find((c) => c.id === 'slot-run-button');
  env.setNote('前\n[[ $ dir ]]\n後');
  env.caretAt('[[ $', 4);
  env.slotAgent._updateRunButton(env.editor);
  assert.ok(button(), 'the button exists');
  assert.ok(button().innerHTML.includes('<svg') && !button().innerHTML.includes('▶'), 'the play mark is a line icon, not a text glyph');
  assert.equal(button().classList.contains('active'), true, 'shown for [[ $ ]]');

  env.caretAt('前', 0);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), false, 'hidden away from the task');

  env.caretAt('[[ $', 4);
  env.slotAgent._updateRunButton(env.editor);
  button()._listeners.click[0].fn({});
  await env.flush();
  assert.equal(env.calls.command.length, 1, 'the click ran the task');
  assert.equal(button().classList.contains('active'), false);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), false, 'not offered while it runs');

  env.setNote('[[ @llm a ]]');
  env.caretAt('[[', 3);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), true);
  env.setNote('[[Wiki]] {{ x: 1 }}');
  env.caretAt('[[Wiki', 3);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), false, 'a wiki link gets no button');
  env.caretAt('{{ x', 3);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), true, 'a legacy slot still does');
});

check('an {{ @agent }} task: its run button sits on the task line like the other tasks, and is not offered while it runs', async () => {
  const env = await createEnv();
  const button = () => env.window.document.body.children.find((c) => c.id === 'slot-run-button');
  env.setNote('前\n{{ @claude READMEを整えて }}\n後');
  env.caretAt('{{ @claude', 4);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), true, 'offered');
  const onTaskLine = button().style.top;

  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1, 'the key started it');
  env.caretAt('{{ @claude', 4);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), false, 'not offered while it runs (its result line is not to be covered)');

  env.setNote('前\n{{ x: 1 }}\n後');
  env.caretAt('{{ x', 3);
  env.slotAgent._updateRunButton(env.editor);
  assert.equal(button().classList.contains('active'), true, 'a hand-written slot still gets it');
  assert.notEqual(button().style.top, onTaskLine, 'and keeps its place one line below the slot');
});

// ---------------------------------------------------------------------------------------------------
// 8. Snippets in the {{ popup, the palette picker and the Tab trigger
// ---------------------------------------------------------------------------------------------------
const popup = (env) => env.window.document.body.children.find((c) => c.id === 'slot-quick-selector');

function typeAt(env, text, caretText) {
  env.setNote(text, caretText === undefined ? text.length : caretText);
  env.editor.dispatchEvent({ type: 'input' });
}

check('typing {{ lists the profiles and recipes first, then the snippets with a kind tag, label and one-line preview; number keys keep their meaning', async () => {
  const env = await createEnv();
  typeAt(env, '前置き {{');
  const box = popup(env);
  assert.ok(box && box.classList.contains('active'), 'the popup is open');
  const html = box.innerHTML;
  assert.ok(html.indexOf('code:') < html.indexOf('research:') && html.indexOf('research:') < html.indexOf('deep-research-and-code:'), 'profiles, then the recipe');
  assert.ok(html.indexOf('[RECIPE]') < html.indexOf('slot-item-kind'), 'snippets come after the recipes');
  for (const tag of ['>LLM<', '>AGENT<', '>CMD<', '>TEXT<']) assert.ok(html.includes(tag), `a ${tag} row`);
  assert.ok(html.includes('Summarize'), 'English labels in the English UI');
  assert.ok(!/\$\{selection\}|\$0/.test(html), 'placeholders are not shown raw');
  assert.ok(html.includes('data-index="' + 5 + '"'), 'snippet rows follow the 5 preset rows');

  // 1 still means the first profile: {{ code:  }}
  env.key('editor', { key: '1' });
  assert.equal(env.editor.value, '前置き {{ code:  }}');
  assert.equal(env.editor.selectionStart, '前置き {{ code: '.length, 'as before: right after the role');
  assert.equal(box.classList.contains('active'), false);

  // 6 is the first snippet: the typed {{ becomes [[ @llm ... ]], the caret lands where $0 says
  typeAt(env, 'text {{');
  env.key('editor', { key: '6' });
  assert.equal(env.editor.value, 'text [[ @llm Summarize the following text in 3 lines:  ]]');
  assert.equal(env.editor.selectionStart, 'text [[ @llm Summarize the following text in 3 lines: '.length);
  assert.equal(env.undoStack.length, 1, 'one undo step');

  // arrows + Enter reach any row; the selected row scrolls into view (no error without a real layout)
  typeAt(env, '{{');
  for (let i = 0; i < 20; i++) env.key('editor', { key: 'ArrowDown' });
  env.key('editor', { key: 'Enter' });
  assert.ok(env.editor.value !== '{{' && !env.editor.value.startsWith('{{ '), 'a snippet row was committed: ' + env.editor.value);
});

check('a snippet is inserted where {{ was typed, keeps the text after it, and uses the line / the selection placeholders', async () => {
  const env = await createEnv({
    backend: {
      getActiveSlotConfigJSON: async () => JSON.stringify({
        snippets: [
          { id: 'mine', label: 'My rewrite', kind: 'llm', body: 'Rewrite "${line}": ${selection}$0' },
          { id: 'sh', label: 'Grep it', kind: 'command', body: 'rg -n "${selection}$0" .' }
        ]
      })
    }
  });
  await env.flush();
  assert.ok(env.slotAgent.getConfig().snippets.length === 2, 'agents.yaml snippets reach the slot config');
  typeAt(env, 'アルファ {{ 後ろの文字', 'アルファ {{'.length);
  const rows = popup(env).innerHTML;
  assert.ok(rows.includes('My rewrite') && rows.includes('Grep it'), 'user snippets are listed');
  const rowNumber = (label) => {
    const at = popup(env).innerHTML.indexOf(label);
    return popup(env).innerHTML.slice(0, at).match(/data-index="(\d+)"/g).length - 1;
  };
  for (let i = 0; i < rowNumber('My rewrite'); i++) env.key('editor', { key: 'ArrowDown' });
  env.key('editor', { key: 'Enter' });
  assert.equal(env.editor.value, 'アルファ [[ @llm Rewrite "アルファ  後ろの文字":  ]] 後ろの文字', '${line} is the line without the typed trigger, the text after the caret stays');
  assert.equal(env.editor.selectionStart, 'アルファ [[ @llm Rewrite "アルファ  後ろの文字": '.length);

  // a snippet about the selection wraps it (from the palette picker: nothing typed to replace)
  env.setNote('選んだ語を検索', 0, 4);
  env.slotAgent.openSnippetPicker();
  assert.equal(popup(env).classList.contains('active'), true);
  const picker = popup(env).innerHTML;
  assert.ok(picker.includes(I18N.en.autoSelSnippetsHeader) && !picker.includes('code:'), 'only snippets, with their own header');
  const at = rowNumber('Grep it');
  for (let i = 0; i < at; i++) env.key('editor', { key: 'ArrowDown' });
  env.key('editor', { key: 'Enter' });
  assert.equal(env.editor.value, '[[ $ rg -n "選んだ語" . ]]を検索', 'the selection went into the command, the rest of the note stays');
  assert.equal(env.editor.selectionStart, '[[ $ rg -n "選んだ語'.length, 'the caret is at $0, inside the quotes');
});

check('snippet text from agents.yaml is escaped in the popup (labels and bodies are untrusted)', async () => {
  const env = await createEnv({
    backend: {
      getActiveSlotConfigJSON: async () => JSON.stringify({
        snippets: [{ id: 'x', label: '<img src=x onerror=alert(1)>', kind: 'text', body: '"><script>alert(2)</script> & more' }],
        slot_profiles: [{ trigger_open: '{{', trigger_close: '}}', name: '<b>code</b>', agent: 'claude-code', system_instruction: '<i>x</i>' }]
      })
    }
  });
  await env.flush();
  typeAt(env, '{{');
  const html = popup(env).innerHTML;
  assert.ok(!/<img|<script|<b>|<i>/.test(html), 'no markup from config text survives: ' + html.slice(0, 300));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&lt;script&gt;'));
});

check('the {{ popup header and key hint follow the UI language (they used to be Japanese in every language)', async () => {
  const en = await createEnv();
  typeAt(en, '前置き {{');
  const enHtml = popup(en).innerHTML;
  assert.ok(enHtml.includes(I18N.en.slotSelectorHeader) && enHtml.includes(I18N.en.slotSelectorKeys), 'English header and hint');
  assert.ok(!enHtml.includes('エージェントに任せる') && !enHtml.includes('移動'), 'no Japanese text in the English UI');

  const ja = await createEnv({ language: 'ja' });
  typeAt(ja, '前置き {{');
  const jaHtml = popup(ja).innerHTML;
  assert.ok(jaHtml.includes('エージェントに任せる') && jaHtml.includes('↑/↓ 移動 • Enter/Tab/1-9 確定 • Esc 閉じる'), 'the Japanese wording is the one it always had');
});

check('a list opened right after the editor lost focus (the palette closing) is not closed by that blur\'s timer', async () => {
  const env = await createEnv();
  env.setNote('前置き', 0, 0);
  env.editor.dispatchEvent({ type: 'blur' });
  assert.equal(env.heldTimerCount(200), 1, 'the blur schedules one hide');
  env.slotAgent.openSnippetPicker();
  assert.equal(popup(env).classList.contains('active'), true, 'the picker is open');
  env.fireTimers(200);
  assert.equal(popup(env).classList.contains('active'), true, 'and stays open');

  env.editor.dispatchEvent({ type: 'blur' });
  env.fireTimers(200);
  assert.equal(popup(env).classList.contains('active'), false, 'a blur with nothing opened after it still closes the list');
});

check('[[ opens nothing (wiki links are not hijacked)', async () => {
  const env = await createEnv();
  typeAt(env, 'see [[');
  assert.ok(!popup(env) || !popup(env).classList.contains('active'));
  typeAt(env, '[[Note');
  assert.ok(!popup(env) || !popup(env).classList.contains('active'));
});

check('Tab after an exact trigger expands the snippet; every other Tab is untouched', async () => {
  const env = await createEnv();
  env.setNote('first line\n;sum');
  const tab = env.key('editor', { key: 'Tab', code: 'Tab', keyCode: 9 });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(env.editor.value, 'first line\n[[ @llm Summarize the following text in 3 lines:  ]]');
  assert.equal(env.editor.selectionStart, env.editor.value.length - ' ]]'.length, 'the caret is at $0');
  assert.equal(env.undoStack.length, 1);

  env.setNote('memo ;gst');
  env.key('editor', { key: 'Tab', code: 'Tab' });
  assert.equal(env.editor.value, 'memo [[ $ git status ]]', 'after whitespace');

  // Everywhere else Tab is exactly what it is without the snippet library (the editor's own indent)
  const plainTab = await createEnv();
  plainTab.window.SlotSnippets = undefined;
  const outcome = (e, text, start, end, init) => {
    e.setNote(text, start, end);
    const event = e.key('editor', Object.assign({ key: 'Tab', code: 'Tab' }, init));
    return { value: e.editor.value, caret: e.editor.selectionStart, prevented: event.defaultPrevented };
  };
  const others = [
    ['foo'], ['x;sum'], [';summary'], [';sum '], [';nope'], [';'], ['a'.repeat(40) + ';sum'],
    [';sum', 4, 2], [';sum', 4, 4, { shiftKey: true }], [';sum', 4, 4, { isComposing: true }], [';sum', 4, 4, { ctrlKey: true }], ['```\n;sum']
  ];
  for (const [text, start, end, init] of others) {
    assert.deepEqual(outcome(env, text, start, end, init), outcome(plainTab, text, start, end, init), JSON.stringify([text, start, end, init]) + ' is left to the editor');
  }
  assert.ok(!outcome(env, ';sum', 4, 4, { shiftKey: true }).value.includes('[['));
  const wide = outcome(env, '；ｓｕｍ');
  assert.equal(wide.prevented, true, 'a full-width trigger from an IME works too');
  assert.ok(wide.value.startsWith('[[ @llm '), wide.value);
});

check('the palette picker with no snippet module says so; a missing module never breaks the popup or Ctrl+Enter', async () => {
  const env = await createEnv();
  env.window.SlotSnippets = undefined;
  env.slotAgent.openSnippetPicker();
  assert.equal(env.toast(), I18N.en.autoSelSnippetsNone);
  typeAt(env, '{{');
  assert.ok(popup(env).innerHTML.includes('code:') && !popup(env).innerHTML.includes('slot-item-kind'), 'profiles only');
  env.setNote(';sum');
  env.key('editor', { key: 'Tab' });
  assert.ok(!env.editor.value.includes('[['), 'no library, no expansion');

  env.window.AutoSelector = undefined;
  env.setNote('この文章を要約して\n\n{{ calc: 1 }}', 0);
  env.press();
  await env.flush();
  assert.equal(env.calls.parse.length, 1, 'without the selector module Ctrl+Enter is the old key');
  assert.equal(env.editor.value.split('\n')[0], 'この文章を要約して');
});

// ---------------------------------------------------------------------------------------------------
// 9. Cost
// ---------------------------------------------------------------------------------------------------
check('the decision is synchronous and cheap on a note of 130 000 characters', async () => {
  const env = await createEnv();
  const paragraph = '普通の行です。これは説明文であり、命令ではありません。\n'.repeat(40);
  let note = '';
  while (note.length < 129000) note += paragraph + '```\ncode\n```\n[[ @llm 古い ]]\n' + res('aaaa', '答え') + '\n\n';
  note += 'この文章を要約して\n最後の行';
  env.setNote(note);
  env.caretAt('この文章を要約して', 3);
  // warm-up on the same note (regexps are built on first use), then measure the whole synchronous part of the key
  const cases = [];
  for (const [label, prepare] of [
    ['a request line (rewrite, marker, task start)', () => { env.setNote(note); env.caretAt('この文章を要約して', 3); }],
    ['a line that is not a request (ask bar)', () => { env.setNote(note.replace('この文章を要約して', '今日は天気が良かった'), 0); env.caretAt('今日は天気が良かった', 3); }],
    ['a task already there', () => { env.setNote(note.replace('この文章を要約して', '[[ @llm 要約して ]]')); env.caretAt('[[ @llm 要約して', 3); }]
  ]) {
    prepare();
    env.press();
    await env.flush();
    if (!env.hidden('inline-prompt-bar')) env.key('editor', { key: 'Escape' });
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      prepare();
      const t0 = process.hrtime.bigint();
      env.press();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      await env.flush();
      if (!env.hidden('inline-prompt-bar')) env.key('editor', { key: 'Escape' });
      best = Math.min(best, ms);
    }
    cases.push(`${label}: ${best.toFixed(2)} ms`);
    assert.ok(best < 5, `${label} took ${best} ms`);
  }
  console.log(`  synchronous part of Ctrl+Enter on a ${note.length} char note (best of 5, includes the mock edit and app.js input handling): ${cases.join('; ')}`);
});

// ---------------------------------------------------------------------------------------------------
// 9. HTML comments: commented-out text never runs; Ctrl+/ comments lines out and back
// ---------------------------------------------------------------------------------------------------
const slashKey = (init) => Object.assign({ key: '/', code: 'Slash', keyCode: 191, ctrlKey: true }, init);

check('Ctrl+Enter inside a comment: nothing runs (no parse RPC, so no fallback to another slot), one toast, the note is untouched', async () => {
  const note = '{{ calc: 1+1 }}\n<!-- {{ calc: 2+2 }} [[ @llm この文章を要約して ]] -->\n<!--\nテストを実行して\n-->\n{{ calc: 3+3 }}';
  for (const [marker, offset] of [['2+2', 1], ['@llm', 2], ['テスト', 2], ['<!--\nテスト', 1]]) {
    for (const enabled of [true, false]) {
      const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled } }) } });
      env.setNote(note);
      env.caretAt(marker, offset);
      const e = env.press();
      await env.flush();
      assert.equal(e.defaultPrevented, true, 'the key is taken');
      assert.equal(env.editor.value, note, `untouched (${marker}, auto ${enabled})`);
      assert.equal(env.calls.parse.length + env.calls.llm.length + env.calls.runAgent.length, 0, `nothing asked or run (${marker}, auto ${enabled})`);
      assert.equal(env.toast(), I18N.en.commentNoRun);
      assert.equal(env.hidden('inline-prompt-bar'), true, 'no ask bar');
    }
  }
  // the caret right after "-->" on a line that is only a comment: the same (it is not a blank line for the old path)
  const env = await createEnv();
  env.setNote(note);
  env.caretAt(' -->', 4);
  env.press();
  await env.flush();
  assert.equal(env.calls.parse.length, 0);
  assert.equal(env.toast(), I18N.en.commentNoRun);
  // and the live slots around it still run, each its own
  env.caretAt('3+3', 1);
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1);
  assert.ok(env.editor.value.endsWith('{{ ⟳ 実行中... }}'), 'the slot under the caret');
});

check('Ctrl+/ comments the current line out and back, in one undo step each; the caret stays on the text', async () => {
  const env = await createEnv();
  env.setNote('first\n- [[ @llm この文章を要約して ]]\nlast');
  env.caretAt('この文章', 2);
  const caret = env.editor.selectionStart;
  const e = env.key('editor', slashKey());
  assert.equal(e.defaultPrevented, true);
  assert.equal(env.editor.value, 'first\n<!-- - [[ @llm この文章を要約して ]] -->\nlast');
  assert.equal(env.editor.selectionStart, caret + 5, 'the caret moved with the text');
  assert.equal(env.undoStack.length, 1, 'one undo step');
  // a commented-out task: Ctrl+Enter on it does nothing
  env.press();
  await env.flush();
  assert.equal(env.calls.llm.length, 0);
  assert.equal(env.toast(), I18N.en.commentNoRun);
  // back
  env.key('editor', slashKey());
  assert.equal(env.editor.value, 'first\n- [[ @llm この文章を要約して ]]\nlast');
  assert.equal(env.editor.selectionStart, caret);
  assert.equal(env.undoStack.length, 2);
  env.undo();
  assert.equal(env.editor.value, 'first\n<!-- - [[ @llm この文章を要約して ]] -->\nlast', 'undo takes back one toggle');
});

check('Ctrl+/ with a selection comments every line it touches, per line by default and in one block when the setting says so', async () => {
  const env = await createEnv();
  env.setNote('a\n  - b\n\nc\nd');
  env.editor.selectionStart = 0;
  env.editor.selectionEnd = env.editor.value.indexOf('d');
  env.key('editor', slashKey());
  assert.equal(env.editor.value, '<!-- a -->\n  <!-- - b -->\n\n<!-- c -->\nd', 'the line the selection ends at the start of is left out');
  assert.equal(env.editor.value.slice(env.editor.selectionStart, env.editor.selectionEnd), '<!-- a -->\n  <!-- - b -->\n\n<!-- c -->\n');

  const block = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { commentStyle: 'block' } }) } });
  block.setNote('a\n  - b\nc');
  block.editor.selectionStart = 0;
  block.editor.selectionEnd = block.editor.value.length;
  block.key('editor', slashKey());
  assert.equal(block.editor.value, '<!-- a\n  - b\nc -->');
  block.key('editor', slashKey());
  assert.equal(block.editor.value, 'a\n  - b\nc');
  assert.equal(block.undoStack.length, 2);
});

check('Ctrl+/ is only the chord: "/" typed alone, Ctrl+Shift+/, an IME composition and a held key do nothing', async () => {
  const env = await createEnv();
  env.setNote('text');
  for (const init of [{ ctrlKey: false }, { shiftKey: true, key: '?' }, { isComposing: true }, { keyCode: 229 }]) {
    const e = env.key('editor', slashKey(init));
    assert.equal(e.defaultPrevented, false, JSON.stringify(init));
    assert.equal(env.editor.value, 'text');
  }
  const held = env.key('editor', slashKey({ repeat: true }));
  assert.equal(held.defaultPrevented, true, 'a held chord is swallowed');
  assert.equal(env.editor.value, 'text', 'but does not flip the line back and forth');
  // outside the editor the chord is not taken
  env.el('find-input').focus();
  const other = env.key('find-input', slashKey());
  assert.equal(other.defaultPrevented, false);
  assert.equal(env.editor.value, 'text');
});

check('Ctrl+/ says what it left alone or would not do', async () => {
  const env = await createEnv();
  env.setNote('a\nx --> y\nb');
  env.editor.selectionStart = 0;
  env.editor.selectionEnd = env.editor.value.length;
  env.key('editor', slashKey());
  assert.equal(env.editor.value, '<!-- a -->\nx --> y\n<!-- b -->');
  assert.equal(env.toast(), I18N.en.commentToggleSkipped.replace('{lines}', '2'));

  const unclosed = await createEnv();
  unclosed.setNote('<!-- never closed\ntext');
  unclosed.caretAt('text');
  unclosed.key('editor', slashKey());
  assert.equal(unclosed.editor.value, '<!-- never closed\ntext', 'refused: the note is untouched');
  assert.equal(unclosed.undoStack.length, 0);
  assert.equal(unclosed.toast(), I18N.en.commentToggleUnclosed);

  const empty = await createEnv();
  empty.setNote('a\n\nb');
  empty.caretAt('\n\n', 1);
  empty.key('editor', slashKey());
  assert.equal(empty.editor.value, 'a\n\nb');
  assert.equal(empty.toast(), I18N.en.commentToggleNothing);
});

check('the Mac chord is Cmd+/ (Ctrl+/ there is left to the system)', async () => {
  const src = read('frontend/js/app.js');
  const mac = /const DEFAULT_SHORTCUTS_MAC = \{[\s\S]*?\n {2}\};/.exec(src)[0];
  const win = /const DEFAULT_SHORTCUTS_WIN = \{[\s\S]*?\n {2}\};/.exec(src)[0];
  assert.match(mac, /commentToggle: 'Cmd\+\/'/);
  assert.match(win, /commentToggle: 'Ctrl\+\/'/);
});

check('without html_comments.js / comment_toggle.js loaded nothing breaks: Ctrl+Enter works as before, Ctrl+/ does nothing', async () => {
  const env = await createEnv({ withoutComments: true });
  env.setNote('[[ @llm 要約して ]]');
  env.press();
  await env.flush();
  assert.equal(env.calls.llm.length, 1);
  const bare = await createEnv({ withoutComments: true });
  bare.setNote('text');
  bare.key('editor', slashKey());
  assert.equal(bare.editor.value, 'text');
});

// ---------------------------------------------------------------------------------------------------
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
  console.error(`\n${failed} of ${queue.length} auto selector flow test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} auto selector flow tests passed.`);
