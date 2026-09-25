// Agent safety, end to end: the confirmation before an agent that acts without asking runs (every entry point: a
// hand-written {{ @agent }}, a classic {{ }} slot bound to a profile, a recipe, the auto selector with and without its own
// confirmation), what is remembered (config.agentAck, through a Settings save), the Settings warning and agent list, and
// the one-time start-up message about agent definitions.
// The real app.js, slot_agent.js, agent_risk.js, auto_selector.js, task_manager.js and i18n.js run in one vm context
// against a hand-made DOM and a mocked backend (the slot parser in JS, the agent runner records calls). Nothing here
// starts a process or touches the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const SRC = [
  'frontend/js/i18n.js', 'frontend/js/task_manager.js', 'frontend/js/auto_selector.js', 'frontend/js/slot_snippets.js',
  'frontend/js/agent_risk.js', 'frontend/js/slot_agent.js', 'frontend/js/chrome_layout.js', 'frontend/js/mermaid_tone.js',
  'frontend/js/app.js'
].map(read);

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(read('frontend/js/i18n.js') + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
const plain = (value) => JSON.parse(JSON.stringify(value));

const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane', 'agent-issues', 'agent-auto-approve-warning'];

async function flush() {
  for (let i = 0; i < 16; i++) await new Promise((resolve) => setImmediate(resolve));
}

const NOTE_ARG = '対象ノート: {file}\n指示: {instruction}';
const RISKY_AGY = { command: 'agy', args: ['-p', NOTE_ARG, '--dangerously-skip-permissions'], description: 'Antigravity', aliases: ['antigravity', 'gemini'] };
const SAFE_CLAUDE = { command: 'claude', args: ['-p', NOTE_ARG], description: 'Claude Code', aliases: ['claude', 'cc'] };

function slotConfigWith(extra) {
  return Object.assign({
    version: 2,
    default_agent: 'claude-code',
    agents: { 'claude-code': SAFE_CLAUDE, agy: RISKY_AGY },
    slot_profiles: [{ trigger_open: '{{', trigger_close: '}}', name: 'code', agent: 'claude-code', system_instruction: '' }],
    recipes: [{ trigger_open: '[>>', trigger_close: ']', name: 'deep', description: 'd', steps: ['a', 'b'], requires_approval_step: 0, self_refine: false }],
    snippets: []
  }, extra || {});
}

// The Go side's RunAgentFor, for the mocked parse answer.
function runAgentFor(cfg, slot) {
  const agents = cfg.agents || {};
  const builtin = { key: 'claude-code', def: SAFE_CLAUDE };
  const usable = (k) => !!(agents[k] && agents[k].command);
  if (!slot || slot.type === 'recipe') return usable(cfg.default_agent) ? { key: cfg.default_agent, def: agents[cfg.default_agent] } : builtin;
  if (slot.agentName) return { key: slot.agentName, def: agents[slot.agentName] || { command: '' } };
  let key = (slot.profileAgent) || cfg.default_agent;
  if (!usable(key)) key = cfg.default_agent;
  return usable(key) ? { key: key, def: agents[key] } : builtin;
}

// A JS port of the Go slot parser, enough for {{ ... }} and [>> ... ] (UTF-16 offsets, as the Go side converts to).
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
  for (const m of text.matchAll(/<!-- md-memo:res [\s\S]*?<!-- \/md-memo:res -->/g)) excluded.push([m.index, m.index + m[0].length]);
  const slots = [];
  const kinds = [{ open: '[>>', close: ']', type: 'recipe' }, { open: '{{', close: '}}', type: 'slot' }];
  let idx = 0;
  while (idx < text.length) {
    let best = null;
    for (const k of kinds) {
      const at = text.indexOf(k.open, idx);
      if (at !== -1 && (!best || at < best.at)) best = { at, k };
    }
    if (!best) break;
    const open = best.at;
    const close = text.indexOf(best.k.close, open + best.k.open.length);
    if (close === -1) break;
    const end = close + best.k.close.length;
    idx = open + best.k.open.length;
    if (excluded.some(([s, e]) => open >= s && open < e)) continue;
    const trimmed = text.slice(open + best.k.open.length, close).trim();
    if (trimmed.startsWith('⟳') || trimmed.startsWith('実行中')) { idx = end; continue; }
    const profile = (cfg.slot_profiles || []).find((p) => p.trigger_open === best.k.open);
    const slot = { type: best.k.type, openDelimiter: best.k.open, closeDelim: best.k.close, startOffset: open, endOffset: end, rawContent: trimmed, role: '', skillName: '', agentName: '', outputMode: 'replace', instruction: trimmed, isInline: false, profileAgent: profile ? profile.agent : '' };
    if (best.k.type === 'slot' && trimmed.startsWith('@')) {
      const after = trimmed.slice(1);
      const sep = after.search(/[: \t\r\n]/);
      const name = sep === -1 ? after.trim() : after.slice(0, sep).trim();
      slot.instruction = sep === -1 ? '' : after.slice(sep).replace(/^:/, '').trim();
      slot.role = '@' + name;
      const key = resolve(name);
      if (key) { slot.agentName = key; slot.outputMode = 'below'; } else slot.skillName = name;
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
  const saved = [];
  const store = new Map(Object.entries(opts.localStorage || {}));
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
      scrollHeight: 1000, clientHeight: 500, offsetHeight: 500, offsetWidth: 500, onclick: null, _listeners: {}, options: [],
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
      get textContent() { return textContent + el.children.map((c) => c.textContent || '').join(''); },
      set textContent(v) {
        textContent = v;
        innerHTML = v;
        el.children = [];
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
      appendChild: (child) => { el.children.push(child); child.parentElement = el; if (tagName === 'select') el.options.push(child); return child; },
      insertBefore: (node, ref) => {
        const i = el.children.indexOf(ref);
        if (i !== -1) el.children.splice(i, 0, node); else el.children.push(node);
        node.parentElement = el;
        return node;
      },
      removeChild: (child) => { el.children = el.children.filter((c) => c !== child); return child; },
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
        const tag = (id === 'editor' || id === 'editor-secondary') ? 'textarea' : (id === 'cfg-default-agent' ? 'select' : 'div');
        el = mockElement(id, tag);
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
    execCommand: (cmd, _ui, text) => {
      if (cmd !== 'insertText') return false;
      const ed = documentMock.activeElement;
      if (!ed || typeof ed.value !== 'string') return false;
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      ed.value = ed.value.slice(0, start) + text + ed.value.slice(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      dispatchOn(ed, 'input', {});
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const slotCfg = { current: opts.slotConfig || slotConfigWith() };
  const calls = { parse: [], runAgent: [], confirms: [] };
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async (json) => { saved.push(JSON.parse(json)); },
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    getActiveSlotConfigJSON: async () => JSON.stringify(slotCfg.current),
    getActiveAgentsConfigStatus: async () => ({ is_external: true, default_agent: slotCfg.current.default_agent }),
    checkAgentAvailability: async (name) => ({ available: true, command: name }),
    parseSlotsRPC: async (text, cursor, cfgJson) => {
      calls.parse.push({ text, cursor });
      const cfg = JSON.parse(cfgJson);
      const slots = parseSlots(text, cfg);
      const target = slots.find((s) => cursor >= s.startOffset && cursor <= s.endOffset) || slots.find((s) => s.startOffset >= cursor) || slots[0] || null;
      const res = { targetSlot: target ? Object.assign({ isTarget: true }, target) : null, allSlots: slots, hasWaitingApproval: false };
      if (target && !opts.noRunAgent) {
        const picked = opts.runAgentOverride || runAgentFor(cfg, target);
        res.runAgentKey = picked.key;
        res.runAgent = picked.def;
      }
      return res;
    },
    runSlotAgentAsync: (reqId, filePath, text, cursor, cfgJson) => { calls.runAgent.push({ reqId, text, cursor, cfg: JSON.parse(cfgJson) }); },
    cancelSlotAgent: () => {}
  }, opts.backend || {});

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
    navigator: { platform: 'Win32', userAgent: 'Windows', language: 'en-US', clipboard: { writeText: async (text) => { calls.clipboard = text; } } },
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
  for (const code of SRC) {
    vm.runInContext(code, context);
    await flush();
  }
  windowMock.getCharPixelCoords = () => ({ top: 20, left: 30 });

  const el = (id) => documentMock.getElementById(id);
  const editor = el('editor');
  return {
    window: windowMock, backend, calls, messages, saved, store, el, editor, slotCfg,
    config: windowMock.__testHelper.config,
    AR: windowMock.AgentRisk,
    flush,
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, caret) {
      editor.value = text;
      editor.selectionStart = editor.selectionEnd = caret === undefined ? text.length : caret;
      documentMock.activeElement = editor;
    },
    caretAt(marker, offset = 0) {
      const at = editor.value.indexOf(marker);
      assert.ok(at !== -1, `the note has no "${marker}"`);
      editor.selectionStart = editor.selectionEnd = at + offset;
      documentMock.activeElement = editor;
    },
    press(init) {
      documentMock.activeElement = editor;
      return dispatchOn(editor, 'keydown', Object.assign({ key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true }, init));
    },
    key(target, init) { return dispatchOn(typeof target === 'string' ? el(target) : target, 'keydown', init); },
    dialogOpen: () => !el('confirm-modal').classList.contains('hidden'),
    dialogText: () => el('confirm-modal-message').textContent,
    run: () => el('confirm-modal-ok').onclick(),
    cancel: () => el('confirm-modal-cancel').onclick(),
    activeId: () => documentMock.activeElement && documentMock.activeElement.id,
    toast: () => messages[messages.length - 1],
    fireTimers(ms) {
      for (const [id, t] of Array.from(heldTimers)) if (t.ms === ms) { heldTimers.delete(id); t.fn(); }
    }
  };
}

// ---------------------------------------------------------------------------------------------------
check('a hand-written {{ @agent }} whose agent skips permission prompts: asked before anything changes; Cancel (or Enter on the focused Cancel) runs nothing and leaves the note', async () => {
  const env = await createEnv();
  const note = 'Notes\n{{ @gemini look into it }}\nend';
  env.setNote(note);
  env.caretAt('@gemini', 2);
  env.press();
  await env.flush();

  assert.equal(env.dialogOpen(), true, 'the confirmation is open');
  assert.equal(env.calls.parse.length, 1);
  assert.equal(env.calls.runAgent.length, 0, 'nothing runs yet');
  assert.equal(env.editor.value, note, 'the note is untouched: no marker line');
  const text = env.dialogText();
  assert.ok(text.startsWith(I18N.en.agentRiskIntro.replace('{agent}', 'agy')), text);
  assert.ok(text.includes(I18N.en.agentRiskFlag.replace('{flag}', '--dangerously-skip-permissions')), 'names the flag and what it does');
  assert.ok(text.includes('Command: agy -p "対象ノート: {file}\\n指示: {instruction}" --dangerously-skip-permissions'), text);
  assert.equal(env.el('confirm-modal-ok').textContent, I18N.en.agentRiskRun, 'the buttons read Run / Cancel');
  assert.equal(env.el('confirm-modal-cancel').textContent, I18N.en.btnCancel);
  assert.equal(env.el('confirm-modal-message').style.whiteSpace, 'pre-line');
  assert.equal(env.activeId(), 'confirm-modal-cancel', 'Cancel has the focus');

  const again = env.press();
  assert.equal(again.defaultPrevented, true);
  await env.flush();
  assert.equal(env.dialogOpen(), true, 'a repeated Ctrl+Enter does not confirm');
  assert.equal(env.calls.parse.length, 1, 'and does not start a second run');

  env.key('editor', { key: 'Enter', code: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.dialogOpen(), false);
  assert.equal(env.calls.runAgent.length, 0, 'Enter on the focused Cancel declines');
  assert.equal(env.editor.value, note);
  assert.equal(env.config.agentAck, undefined, 'a No is not remembered');

  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true, 'asked again next time');
  env.key('editor', { key: 'Escape', code: 'Escape' });
  await env.flush();
  assert.equal(env.dialogOpen(), false);
  assert.equal(env.calls.runAgent.length, 0, 'Escape declines');
  assert.equal(env.editor.value, note);
});

check('Run: the run starts and is remembered for this agent and exact command line (saved to config.json); changed arguments ask again', async () => {
  const env = await createEnv();
  env.setNote('{{ @gemini first }}\n\n{{ @agy second }}\n');
  env.caretAt('first');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true);
  env.run();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1, 'the run starts');
  assert.ok(/md-memo:run/.test(env.editor.value), 'with its marker under the task');
  const sig = env.AR.signature(RISKY_AGY);
  assert.deepEqual(plain(env.config.agentAck), { agy: sig });
  assert.deepEqual(env.saved[env.saved.length - 1].agentAck, { agy: sig }, 'kept in config.json');

  env.caretAt('second');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), false, 'the same agent and command line (another alias) is not asked about again');
  assert.equal(env.calls.runAgent.length, 2);

  const changed = Object.assign({}, RISKY_AGY, { args: RISKY_AGY.args.concat('--model', 'x') });
  env.window.SlotAgent.updateConfig({ agents: { 'claude-code': SAFE_CLAUDE, agy: changed } });
  env.setNote('{{ @agy third }}');
  env.caretAt('third');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true, 'a changed command line asks again');
  env.cancel();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 2);
  assert.deepEqual(plain(env.config.agentAck), { agy: sig });
});

check('a classic {{ }} slot bound to a risky profile agent: Cancel leaves no running placeholder', async () => {
  const danger = { command: 'danger-cli', args: ['--yolo'] };
  const env = await createEnv({ slotConfig: slotConfigWith({ agents: { 'claude-code': SAFE_CLAUDE, danger: danger }, slot_profiles: [{ trigger_open: '{{', trigger_close: '}}', name: 'code', agent: 'danger', system_instruction: '' }] }) });
  const note = 'x\n{{ code: tidy this }}\ny';
  env.setNote(note);
  env.caretAt('tidy');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true);
  assert.ok(env.dialogText().includes('danger') && env.dialogText().includes('--yolo'));
  env.cancel();
  await env.flush();
  assert.equal(env.editor.value, note, 'no "running" placeholder');
  assert.equal(env.calls.runAgent.length, 0);

  env.press();
  await env.flush();
  env.run();
  await env.flush();
  assert.equal(env.calls.runAgent.length, 1);
  assert.ok(env.editor.value.includes('{{ ⟳ 実行中... }}'), 'the slot runs as before once confirmed');
});

check('a recipe runs the default agent: asked about it', async () => {
  const danger = { command: 'danger-cli', args: ['--auto-approve'] };
  const env = await createEnv({ slotConfig: slotConfigWith({ default_agent: 'danger', agents: { 'claude-code': SAFE_CLAUDE, danger: danger } }) });
  const note = '[>> research and build ]';
  env.setNote(note, 4);
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true);
  assert.ok(env.dialogText().includes('"danger"'));
  env.cancel();
  await env.flush();
  assert.equal(env.editor.value, note);
  assert.equal(env.calls.runAgent.length, 0);
});

check('the auto selector with its confirmation off: asked before the line is rewritten; Cancel keeps the line; Run rewrites and runs with one question', async () => {
  const riskyDefault = { command: 'claude', args: ['-p', '{instruction}', '--dangerously-skip-permissions'] };
  const env = await createEnv({
    localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { agentConfirm: false } }) },
    slotConfig: slotConfigWith({ agents: { 'claude-code': riskyDefault, agy: RISKY_AGY } })
  });
  env.setNote('メモ\nテストを実行して\nおわり');
  env.caretAt('テストを実行して', 3);
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true, 'asked first');
  assert.equal(env.editor.value, 'メモ\nテストを実行して\nおわり', 'the line is not rewritten yet');
  env.cancel();
  await env.flush();
  assert.equal(env.editor.value, 'メモ\nテストを実行して\nおわり', 'declining leaves the line');
  assert.equal(env.calls.parse.length, 0);
  assert.equal(env.calls.runAgent.length, 0);

  env.caretAt('テストを実行して', 3);
  env.press();
  await env.flush();
  env.run();
  await env.flush();
  assert.equal(env.dialogOpen(), false, 'the run\'s own check does not ask twice');
  assert.equal(env.calls.runAgent.length, 1);
  assert.ok(env.editor.value.startsWith('メモ\n{{ @claude-code テストを実行して }}\n<!-- md-memo:run '), env.editor.value);
});

check('the backend resolves another (risky) definition than the loaded config: declining at the run puts the rewritten line back', async () => {
  const env = await createEnv({
    localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { agentConfirm: false } }) },
    runAgentOverride: { key: 'claude-code', def: { command: 'claude', args: ['{instruction}', '--yolo'] } }
  });
  env.setNote('テストを実行して');
  env.press();
  await env.flush();
  assert.equal(env.calls.parse.length, 1, 'the loaded definition was safe: rewritten and parsed');
  assert.equal(env.dialogOpen(), true, 'the definition the run would start is risky');
  env.cancel();
  await env.flush();
  assert.equal(env.editor.value, 'テストを実行して', 'the line is put back');
  assert.equal(env.calls.runAgent.length, 0);
});

check('a parse answer without runAgent (an older backend): the loaded definitions decide', async () => {
  const env = await createEnv({ noRunAgent: true });
  env.setNote('{{ @gemini x }}');
  env.caretAt('x');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), true);
  env.cancel();
  await env.flush();

  env.setNote('{{ @cc y }}');
  env.caretAt('y');
  env.press();
  await env.flush();
  assert.equal(env.dialogOpen(), false, 'a safe agent never asks');
  assert.equal(env.calls.runAgent.length, 1);
});

check('the acknowledgement survives a Settings save and a restart', async () => {
  const env = await createEnv();
  env.setNote('{{ @agy go }}');
  env.caretAt('go');
  env.press();
  await env.flush();
  env.run();
  await env.flush();
  env.el('btn-settings').onclick();
  await env.flush();
  await env.el('btn-save-settings').onclick();
  await env.flush();
  const last = env.saved[env.saved.length - 1];
  assert.deepEqual(last.agentAck, { agy: env.AR.signature(RISKY_AGY) }, 'Save keeps it');

  const restarted = await createEnv({ backendConfig: last });
  restarted.setNote('{{ @agy again }}');
  restarted.caretAt('again');
  restarted.press();
  await restarted.flush();
  assert.equal(restarted.dialogOpen(), false, 'not asked after a restart');
  assert.equal(restarted.calls.runAgent.length, 1);

  const local = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ agentAck: last.agentAck }) } });
  local.setNote('{{ @agy local }}');
  local.caretAt('local');
  local.press();
  await local.flush();
  assert.equal(local.dialogOpen(), false, 'the local copy of the config carries it too');
});

check('Settings > Agent: the warning uses the shared flag list, and the agent definitions to review are listed', async () => {
  const codex = { command: 'codex', args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '{instruction}'], description: 'Codex' };
  const issues = [{ agent: 'claude-code', kind: 'outdated-default', detail: 'claude-code', suggested: SAFE_CLAUDE }, { agent: 'sh-agent', kind: 'shell-append', detail: 'bash' }];
  const env = await createEnv({ slotConfig: slotConfigWith({ default_agent: 'codex', agents: { 'claude-code': SAFE_CLAUDE, codex: codex }, agent_issues: issues }) });
  env.el('btn-settings').onclick();
  await env.flush();
  assert.equal(env.hidden('agent-auto-approve-warning'), false, 'a flag the old Settings list did not know is warned about');
  assert.equal(env.hidden('agent-issues'), false, 'the list is shown');
  const text = env.el('agent-issues').textContent;
  assert.ok(text.includes(I18N.en.agentIssuesTitle), text);
  assert.ok(text.includes('sh-agent'), text);

  env.el('cfg-default-agent').value = 'claude-code';
  env.el('cfg-default-agent').onchange();
  assert.equal(env.hidden('agent-auto-approve-warning'), true, 'a safe agent: no warning');
});

check('start-up: one status-bar message per set of agent definitions to review, a few seconds in', async () => {
  const issues = [{ agent: 'claude-code', kind: 'outdated-default', detail: 'claude-code', suggested: SAFE_CLAUDE }];
  const env = await createEnv({ slotConfig: slotConfigWith({ agent_issues: issues }) });
  assert.ok(!env.messages.some((m) => m === I18N.en.agentIssuesStartup.replace('{count}', '1')), 'nothing before the delay');
  env.fireTimers(4000);
  await env.flush();
  assert.equal(env.toast(), I18N.en.agentIssuesStartup.replace('{count}', '1'));
  const sig = env.AR.issuesSignature(issues);
  assert.equal(env.config.agentNotice.shown, sig);
  assert.equal(env.saved[env.saved.length - 1].agentNotice.shown, sig, 'remembered in config.json');

  const next = await createEnv({ slotConfig: slotConfigWith({ agent_issues: issues }), backendConfig: env.saved[env.saved.length - 1] });
  next.fireTimers(4000);
  await next.flush();
  assert.ok(!next.messages.includes(I18N.en.agentIssuesStartup.replace('{count}', '1')), 'not shown twice for the same set');

  const quiet = await createEnv();
  quiet.fireTimers(4000);
  await quiet.flush();
  assert.equal(quiet.config.agentNotice, undefined, 'no issues: nothing said, nothing saved');
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
  console.error(`\n${failed} of ${queue.length} agent safety flow test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} agent safety flow tests passed.`);
