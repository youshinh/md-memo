// The page under a hand-made DOM, for the tests that run the real frontend modules end to end (a copy of the harness of
// tests/auto_selector_flow_test.mjs, plus a parser port that knows the recipe notation [>> ... ]). Import it from a test:
//   import { createEnv, plain, I18N } from './fixtures/slot_env.mjs';
// Nothing here starts a process or touches the network. Run from the repository root (the sources are read relative to it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

// The comment rules the Go parser shares (html_comments.js == pkg/slotagent/comments.go), for the parser port below
const HC = createRequire(import.meta.url)('../../frontend/js/html_comments.js');

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
  // The recipes (Go: a recipe's own delimiters, type "recipe", replace mode, role = the recipe's name)
  for (const recipe of cfg.recipes || []) {
    const openD = recipe.trigger_open || '[>>';
    const closeD = recipe.trigger_close || ']';
    let at = 0;
    while (at < text.length) {
      const open = text.indexOf(openD, at);
      if (open === -1) break;
      const close = text.indexOf(closeD, open + openD.length);
      if (close === -1) break;
      const end = close + closeD.length;
      at = open + openD.length;
      if (excluded.some(([s, e]) => (open >= s && open < e) || (end > s && end <= e))) continue;
      const trimmed = text.slice(open + openD.length, close).trim();
      if (trimmed.startsWith('⟳') || trimmed.startsWith('実行中')) { at = end; continue; }
      slots.push({ type: 'recipe', openDelimiter: openD, closeDelim: closeD, startOffset: open, endOffset: end, rawContent: trimmed, role: recipe.name || '', skillName: '', agentName: '', outputMode: 'replace', instruction: trimmed, isInline: false });
      at = end;
    }
  }
  return slots.sort((a, b) => a.startOffset - b.startOffset);
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const windowListeners = {};
  const messages = [];
  const warnings = []; // console.warn of the page
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
    console: { log() {}, warn(...a) { warnings.push(a.map(String).join(' ')); }, error(...a) { if (opts.showErrors) console.error(...a); } }
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
    window: windowMock, backend, calls, messages, warnings, store, el, editor, clock, undoStack,
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

export { createEnv, parseSlots, flush, plain, I18N, assert };
