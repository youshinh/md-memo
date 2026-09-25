// Agents switched off (agents.yaml: enabled: false / disabled_agents) and agents whose program is not installed: the page side.
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

const popup = (env) => env.window.document.body.children.find((c) => c.id === 'slot-quick-selector');

function typeAt(env, text, caretText) {
  env.setNote(text, caretText === undefined ? text.length : caretText);
  env.editor.dispatchEvent({ type: 'input' });
}

// ---------------------------------------------------------------------------------------------------
// Agents switched off (agents.yaml: enabled: false / disabled_agents) and agents whose program is missing.
// What Go sends is faked here: the config with the disabled agents already left out (slotagent.finalizeAgents), and
// ParseSlotsRPC's runProblem. The Go side is tested in pkg/slotagent/enabled_test.go and app_agent_switch_test.go.
// ---------------------------------------------------------------------------------------------------
const DEFAULTS = {
  'claude-code': { command: 'claude', args: ['-p', '{instruction}'], description: 'Claude Code', aliases: ['claude', 'cc'] },
  hermes: { command: 'ollama', args: ['run', 'hermes3', '{instruction}'], description: 'Hermes 3' },
  codex: { command: 'codex', args: ['exec', '{instruction}'], description: 'Codex' },
  agy: { command: 'agy', args: ['-p', '{instruction}'], description: 'Antigravity', aliases: ['antigravity', 'gemini'] }
};
// What GetActiveSlotConfigJSON sends when `disabled` are switched off
function configWithout(disabled, extra) {
  const agents = {};
  for (const k of Object.keys(DEFAULTS)) if (!disabled.includes(k)) agents[k] = DEFAULTS[k];
  return Object.assign({ default_agent: 'claude-code', agents, disabled_agents: disabled.slice().sort() }, extra);
}
const withConfig = (cfg, opts = {}) => createEnv(Object.assign({}, opts, {
  backend: Object.assign({ getActiveSlotConfigJSON: async () => JSON.stringify(cfg) }, opts.backend || {})
}));
const roles = (env) => plain(env.slotAgent._getAvailablePresets().filter((p) => p.type !== 'snippet').map((p) => p.role));

check('the page keeps the disabled list from the backend, drops a stale one, and merges nothing back in', async () => {
  const env = await withConfig(configWithout(['agy', 'hermes']));
  await env.flush();
  const cfg = env.slotAgent.getConfig();
  assert.deepEqual(plain(Object.keys(cfg.agents).sort()), ['claude-code', 'codex']);
  assert.deepEqual(plain(cfg.disabled_agents), ['agy', 'hermes']);

  // config.json may carry an `agents` of its own that still has agy: updateConfig finalises again (and never edits that object)
  const persisted = { agents: { agy: DEFAULTS.agy, mine: { command: 'mine-cli' } } };
  env.slotAgent.updateConfig(persisted);
  assert.deepEqual(plain(Object.keys(env.slotAgent.getConfig().agents).sort()), ['mine'], 'agy is disabled: not taken back from the persisted config');
  assert.deepEqual(Object.keys(persisted.agents), ['agy', 'mine'], 'the persisted config object is left as it was');

  // nothing disabled in the next answer: the old list does not linger
  const fresh = await withConfig(configWithout([]));
  await fresh.flush();
  assert.deepEqual(plain(fresh.slotAgent.getConfig().disabled_agents), []);
  assert.deepEqual(plain(Object.keys(fresh.slotAgent.getConfig().agents).sort()), ['agy', 'claude-code', 'codex', 'hermes']);
});

check('the default agent: a disabled default (from the backend or from the persisted config) is the first enabled agent', async () => {
  const env = await withConfig(configWithout(['claude-code', 'hermes'], { default_agent: 'codex' }));
  await env.flush();
  assert.equal(env.slotAgent.getConfig().default_agent, 'codex');
  env.slotAgent.updateConfig({ default_agent: 'claude-code' }); // an old default_agent in config.json
  assert.equal(env.slotAgent.getConfig().default_agent, 'codex', 'claude-code is disabled: the first enabled agent in the fixed order');
  assert.equal(env.slotAgent._defaultAgentKey(), 'codex');
  env.slotAgent.updateConfig({ default_agent: 'nobody' });
  assert.equal(env.slotAgent.getConfig().default_agent, 'codex', 'a default that names nothing usable would fall back to claude-code: not when it is disabled');
});

// ---- the quick selector ----------------------------------------------------------------------------------------
check('quick selector: profiles whose agent is disabled are not offered, the number keys stay contiguous, recipes run the default agent', async () => {
  const env = await withConfig(configWithout(['hermes']));
  await env.flush();
  assert.deepEqual(roles(env), ['code', 'research', 'adversarial', 'deep-research-and-code'], 'writing (hermes) is gone');
  const rows = env.slotAgent._getAvailablePresets().slice(0, 4);
  assert.deepEqual(plain(rows.map((p) => p.numKey)), ['1', '2', '3', '4'], 'no gap where writing was');

  typeAt(env, '前置き {{');
  const html = popup(env).innerHTML;
  assert.ok(!html.includes('writing:'), 'the popup has no writing row');
  assert.ok(html.includes('code:') && html.includes('deep-research-and-code:'));
  env.key('editor', { key: '3' });
  assert.equal(env.editor.value, '前置き [! adversarial:  !]', 'number 3 is the third row that is offered (the third profile has its own brackets)');

  // claude-code disabled: its three profiles are gone; writing (hermes) stays, and so does the recipe: it runs the default agent,
  // which is hermes now
  const noClaude = await withConfig(configWithout(['claude-code']));
  await noClaude.flush();
  assert.deepEqual(roles(noClaude), ['writing', 'deep-research-and-code']);
  assert.equal(noClaude.slotAgent._getAvailablePresets().find((p) => p.type === 'recipe').agentKey, 'hermes');
});

check('quick selector: every agent disabled offers no profile and no recipe (snippets stay)', async () => {
  const env = await withConfig(configWithout(['claude-code', 'hermes', 'codex', 'agy'], { default_agent: '' }));
  await env.flush();
  assert.deepEqual(roles(env), []);
  typeAt(env, '{{');
  assert.ok(popup(env).classList.contains('active'), 'the snippets are still listed');
  assert.ok(!popup(env).innerHTML.includes('code:'));
});

check('quick selector: a row whose agent program is not on PATH gets a short tag, after the list is shown; one lookup per agent', async () => {
  const asked = [];
  const env = await createEnv({
    backend: {
      checkAgentAvailability: async (name) => {
        asked.push(name);
        if (name === 'claude-code') return { available: false, command: 'claude' };
        if (name === 'hermes') return { available: true, command: 'ollama' };
        return { available: false, command: '' }; // unknown to the backend: no tag
      }
    }
  });
  await env.flush();
  assert.deepEqual(asked, [], 'nothing is looked up at start-up');
  typeAt(env, '{{');
  const before = popup(env).innerHTML;
  assert.ok(!before.includes('not found'), 'the list opens at once, without the tags');
  await env.flush();
  assert.deepEqual(plain(asked.slice().sort()), ['claude-code', 'hermes'], 'one lookup per agent of the rows, not one per row');
  const html = popup(env).innerHTML;
  const rowOf = (role) => html.slice(html.indexOf(role + ':'), html.indexOf('</li>', html.indexOf(role + ':')));
  for (const role of ['code', 'research', 'adversarial', 'deep-research-and-code']) {
    assert.ok(rowOf(role).includes('>not found<'), role + ' runs claude-code: tagged');
  }
  assert.ok(!rowOf('writing').includes('not found'), 'hermes is installed: no tag');
  assert.ok(rowOf('code').includes('title="Agent &quot;claude-code&quot; needs &quot;claude&quot;, which was not found in PATH. Install it or choose another agent in agents.yaml."'), 'the tooltip is the full sentence');
  assert.equal(popup(env).classList.contains('active'), true);

  const ja = await createEnv({ language: 'ja', backend: { checkAgentAvailability: async () => ({ available: false, command: 'x' }) } });
  await ja.flush();
  typeAt(ja, '{{');
  await ja.flush();
  assert.ok(popup(ja).innerHTML.includes('>未検出<'));
});

check('quick selector: a lookup that answers after the list was closed changes nothing, and a failing lookup is silent', async () => {
  let release;
  const env = await createEnv({ backend: { checkAgentAvailability: () => new Promise((resolve) => { release = () => resolve({ available: false, command: 'claude' }); }) } });
  await env.flush();
  typeAt(env, '{{');
  await env.flush(); // the lookup is asked and pending
  env.key('editor', { key: 'Escape' });
  const closed = popup(env).innerHTML;
  release();
  await env.flush();
  assert.equal(popup(env).innerHTML, closed, 'the closed list is not re-rendered');
  assert.equal(popup(env).classList.contains('active'), false);

  const broken = await createEnv({ backend: { checkAgentAvailability: async () => { throw new Error('rpc down'); } } });
  await broken.flush();
  typeAt(broken, '{{');
  await broken.flush();
  assert.ok(popup(broken).classList.contains('active') && !popup(broken).innerHTML.includes('not found'));
});

// ---- Ctrl+Enter ----------------------------------------------------------------------------------------------------
const disabledText = (lang, agent) => I18N[lang].agentRunDisabled.replaceAll('{agent}', agent);

check('{{ @agy ... }} with agy disabled: the message, the note untouched, no run, no other agent', async () => {
  const problem = { kind: 'disabled', agent: 'agy', message: 'Agent "agy" is disabled in agents.yaml (enabled: false) / ...' };
  const env = await withConfig(configWithout(['agy']), {
    backend: {
      parseSlotsRPC: async (text, cursor) => {
        const start = text.indexOf('{{');
        // what Go answers: the mention is neither a skill nor an agent; the run cannot start
        return {
          targetSlot: { type: 'slot', role: '@agy', skillName: '', agentName: '', openDelimiter: '{{', closeDelim: '}}', startOffset: start, endOffset: text.indexOf('}}') + 2, outputMode: 'below', instruction: 'fix', isTarget: true },
          allSlots: [], hasWaitingApproval: false, runProblem: problem
        };
      }
    }
  });
  await env.flush();
  const note = '前\n{{ @agy fix }}\n後';
  env.setNote(note);
  env.caretAt('@agy', 2);
  env.press();
  await env.flush();
  assert.equal(env.toast(), disabledText('en', 'agy'));
  assert.equal(env.toast(), 'Agent "agy" is disabled in agents.yaml (enabled: false)');
  assert.equal(env.editor.value, note, 'the note is not rewritten');
  assert.equal(env.calls.runAgent.length, 0, 'nothing started');
  assert.equal(env.calls.llm.length, 0);
  assert.deepEqual(env.activeTasks(), []);
  assert.equal(env.undoStack.length, 0);

  const ja = await withConfig(configWithout(['agy']), { language: 'ja', backend: { parseSlotsRPC: async (text) => ({ targetSlot: { type: 'slot', role: '@agy', openDelimiter: '{{', closeDelim: '}}', startOffset: 0, endOffset: text.length, outputMode: 'below', instruction: 'fix' }, runProblem: problem }) } });
  await ja.flush();
  ja.setNote('{{ @agy fix }}', 4);
  ja.press();
  await ja.flush();
  assert.equal(ja.toast(), 'エージェント「agy」は agents.yaml で無効です (enabled: false)');
});

check('a run whose program is not installed: the message in the UI language, and the note stays as it was', async () => {
  const problem = { kind: 'missing', agent: 'hermes', command: 'ollama', message: '...' };
  const env = await withConfig(configWithout([]), {
    backend: { parseSlotsRPC: async (text) => ({ targetSlot: { type: 'slot', role: 'writing', openDelimiter: '【?', closeDelim: '】', startOffset: 0, endOffset: text.length, outputMode: 'replace', instruction: '整えて' }, runProblem: problem }) }
  });
  await env.flush();
  const note = '【? 整えて 】';
  env.setNote(note, 4);
  env.press();
  await env.flush();
  assert.equal(env.toast(), 'Agent "hermes" needs "ollama", which was not found in PATH. Install it or choose another agent in agents.yaml.');
  assert.equal(env.editor.value, note, 'the placeholder is not put in');
  assert.equal(env.calls.runAgent.length, 0);

  const none = await withConfig(configWithout(['claude-code', 'hermes', 'codex', 'agy'], { default_agent: '' }), {
    backend: { parseSlotsRPC: async (text) => ({ targetSlot: { type: 'recipe', role: 'r', openDelimiter: '[>>', closeDelim: ']', startOffset: 0, endOffset: text.length, outputMode: 'replace', instruction: 'x' }, runProblem: { kind: 'none-enabled', message: '' } }) }
  });
  await none.flush();
  none.setNote('[>> x ]', 4);
  none.press();
  await none.flush();
  assert.equal(none.toast(), 'No agent is enabled: every agent is disabled in agents.yaml (enabled: false)');
  assert.equal(none.editor.value, '[>> x ]');
  assert.equal(none.calls.runAgent.length, 0);
});

check('a problem that only the run finds (a result with `problem`): the running placeholder or the marker line goes away, the task fails, the user is told', async () => {
  const problem = { kind: 'missing', agent: 'claude-code', command: 'claude', message: 'x' };
  // a classic slot: the placeholder is put back as the original text
  const env = await createEnv();
  env.setNote('前\n{{ code: A }}\n後');
  env.caretAt('code:', 2);
  env.press();
  await env.flush();
  assert.ok(env.editor.value.includes('{{ ⟳ 実行中... }}'), 'the run started (the parse answer had no problem)');
  const call = env.calls.runAgent[0];
  env.agentAnswer(call, { status: 'failed', exitCode: 1, problem, errorMsg: 'x', newContent: '{{ code: A }}' });
  await env.flush();
  assert.equal(env.editor.value, '前\n{{ code: A }}\n後', 'the slot is as it was');
  assert.equal(env.toast(), 'Agent "claude-code" needs "claude", which was not found in PATH. Install it or choose another agent in agents.yaml.');
  assert.deepEqual(env.activeTasks(), []);
  assert.equal(env.slotAgent._runningTaskCount(), 0);

  // an agent task: the marker line under it is dropped
  const task = await createEnv();
  task.setNote('{{ @codex 直して }}', 4);
  task.press();
  await task.flush();
  const id = idOf(task.editor.value);
  assert.equal(task.editor.value, `{{ @codex 直して }}\n${run(id)}`);
  task.agentAnswer(task.calls.runAgent[0], { status: 'failed', exitCode: 1, problem: { kind: 'disabled', agent: 'codex', message: 'x' }, errorMsg: 'x' });
  await task.flush();
  assert.equal(task.editor.value, '{{ @codex 直して }}', 'no marker, no error block: the note is as it was');
  assert.equal(task.toast(), 'Agent "codex" is disabled in agents.yaml (enabled: false)');
  assert.equal(task.slotAgent._runningTaskCount(), 0);
});

// ---- the Auto selector never picks a disabled agent ---------------------------------------------------------------
check('Auto selector: a line that asks for an agent runs with the default agent, which is never a disabled one', async () => {
  const env = await withConfig(configWithout(['claude-code']));
  await env.flush();
  assert.equal(env.slotAgent.getConfig().default_agent, 'hermes');
  env.setNote('テストを実行して');
  env.press();
  await env.flush();
  assert.equal(env.editor.value, '{{ @hermes テストを実行して }}', 'rewritten for hermes, the first enabled agent');
  assert.deepEqual(env.calls.availability, ['hermes']);
  assert.equal(env.calls.llm.length, 0);
});

check('Auto selector: with every agent disabled a line that asks for an agent is not rewritten', async () => {
  const env = await withConfig(configWithout(['claude-code', 'hermes', 'codex', 'agy'], { default_agent: '' }));
  await env.flush();
  env.setNote('テストを実行して');
  env.press();
  await env.flush();
  assert.equal(env.editor.value, 'テストを実行して', 'the line stays');
  assert.equal(env.toast(), 'No agent is enabled: every agent is disabled in agents.yaml (enabled: false)');
  assert.equal(env.calls.availability.length, 0);
  assert.equal(env.slotAgent._defaultAgentKey(), null);
});

check('Auto selector: "@agy fix it" typed as a plain line with agy disabled says so: not the ask bar, not another agent', async () => {
  const env = await withConfig(configWithout(['agy']));
  await env.flush();
  env.setNote('@agy fix it');
  env.press();
  await env.flush();
  assert.equal(env.toast(), 'Agent "agy" is disabled in agents.yaml (enabled: false)');
  assert.equal(env.editor.value, '@agy fix it');
  assert.equal(env.calls.llm.length, 0);
  assert.equal(env.calls.runAgent.length, 0);
  assert.equal(env.calls.parse.length, 0);
  assert.equal(env.hidden('inline-prompt-bar'), true, 'the ask bar stays closed');

  // an alias of the disabled agent is free again: an ordinary line (the ask bar), as any other @name
  env.setNote('@gemini fix it');
  env.press();
  await env.flush();
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the ask bar opens');
  assert.equal(env.calls.runAgent.length, 0);
});

check('Auto selector: {{ @agy ... }} typed by hand is not taken for a task once agy is disabled (Go words the run), {{ @claude ... }} still is', async () => {
  const env = await withConfig(configWithout(['agy']));
  await env.flush();
  const AS = env.window.AutoSelector;
  const opts = { agents: env.slotAgent.getConfig().agents };
  assert.equal(AS.findTaskAt('{{ @agy fix }}', 3, undefined, opts), null);
  assert.equal(AS.findTaskAt('{{ @gemini fix }}', 3, undefined, opts), null, 'freed aliases do not resolve to agy either');
  assert.equal(AS.findTaskAt('{{ @claude fix }}', 3, undefined, opts).agent, 'claude-code');
});

check('snippets: an agent snippet never names a disabled agent (the snippet\'s own, or the default)', async () => {
  const env = await withConfig(configWithout(['agy']), {
    backend: {
      getActiveSlotConfigJSON: async () => JSON.stringify(Object.assign(configWithout(['agy']), { snippets: [{ id: 'mine', label: 'My agent task', kind: 'agent', agent: 'agy', trigger: ';mine', body: 'do it$0' }] }))
    }
  });
  await env.flush();
  typeAt(env, ';mine');
  env.key('editor', { key: 'Tab' });
  assert.equal(env.editor.value, '{{ @claude-code do it }}', "agy is switched off: the default agent is used instead");
});

// ---- other agents keep working ---------------------------------------------------------------------------------------
check('a plain {{ }} slot of an enabled agent still runs when another agent is disabled', async () => {
  const env = await withConfig(configWithout(['agy']));
  await env.flush();
  env.setNote('{{ code: A }}', 5);
  env.press();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1, 'a slot of an enabled agent runs as before');
  assert.equal(env.calls.runAgent[0].cfg.disabled_agents.join(','), 'agy', 'the page sends the list with every run (the Go side reads it when there is no agents.yaml)');
  assert.ok(!('agy' in env.calls.runAgent[0].cfg.agents));
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
  console.error(`\n${failed} of ${queue.length} agent switch flow test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} agent switch flow tests passed.`);
