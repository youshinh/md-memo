// Lifecycle fuzz test for AI requests (ask Ctrl+L, rewrite Ctrl+K): random but seeded sequences of user and model events run
// against the real app.js in a hand-made DOM (the same kind of environment as tests/ask_and_command_bar_test.mjs, plus an
// undo history for the editor), and after each sequence has settled the invariants of the request lifecycle are checked:
//
//   pending      no request is left waiting: the status-bar indicator is hidden and no watchdog timer is armed
//   tasks        every task the panel was given ended exactly once (completed / failed / canceled)
//   placeholder  no "[AI Generating" / "[AI Correcting" anchor and no "[LLM error" line is left in any note
//   text         each note holds exactly what the successful answers imply: its own lines once (a rewritten line replaced by its
//                answer, in the same place), every applied answer once (an ask answer under its target line), nothing else -
//                no answer of a failed, cancelled, late, repeated or closed-tab request, no lost or duplicated user text
//   late         once everything has settled, further answers change nothing
//   exception    nothing threw (also not inside a callback the app swallows) and nothing was logged as an error
//
// Sequences are data (an array of steps), so a failing one can be replayed and shrunk to a minimal one:
//   node tests/ai_lifecycle_fuzz_test.mjs                       300 sequences x 12 steps, fixed seeds (what tools/run_js_tests.mjs runs)
//   node tests/ai_lifecycle_fuzz_test.mjs --seed 20260930       one sequence, with its trace and the note texts (--dump: after every step)
//   node tests/ai_lifecycle_fuzz_test.mjs --ops "ask(0,0) ok(0,0)"    explicit steps (the "minimal steps" a failure prints), guards off
//   node tests/ai_lifecycle_fuzz_test.mjs --count 3000 --steps 30 [--base 7]   a bigger run / a different family of seeds
//   node tests/ai_lifecycle_fuzz_test.mjs --no-guards [--show 40]   let the sequences reach the known bugs below and list what fails
// A step is name(a,b): a and b are the numbers that pick its target (which waiting request, which line, ...) in the state it finds.
// FUZZ_APP_JS=<file> runs against another copy of app.js (see the mutation check note in the environment section).
//
// A real bug the fuzz finds is NOT fixed here. It is written down in KNOWN_FAILURES (a minimal replay, the seed that found it, the
// reason) and the main run avoids triggering it (AVOID), so it keeps finding other things. The test stays green while each listed
// replay still fails the way it is documented, and goes red when one no longer fails ("remove it and its guard") or when any other
// sequence fails.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ---------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argValue = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : Number(argv[i + 1]); };
const SEQUENCES = argValue('--count', 300);
const STEPS = argValue('--steps', 12);
const ONE_SEED = argv.includes('--seed') ? argValue('--seed') : null;
// --ops "rewrite(536,63) rewrite(896,238)": replay explicit steps (the "minimal steps" a failure prints)
function parseOps(text) {
  return String(text).split(/\s+/).filter(Boolean).map((s) => {
    const m = /^(\w+)\((\d+),(\d+)\)$/.exec(s);
    if (!m) throw new Error('bad step ' + s);
    return { op: m[1], a: Number(m[2]), b: Number(m[3]) };
  });
}
const EXPLICIT_OPS = argv.includes('--ops') ? parseOps(argv[argv.indexOf('--ops') + 1]) : null;
const VERBOSE = argv.includes('--trace') || ONE_SEED !== null || EXPLICIT_OPS !== null;
const BASE_SEED = argValue('--base', 20260930); // --base N: a different family of sequences (the fixed one is the default)
const seedFor = (i) => (BASE_SEED + i * 7919) >>> 0;

// Bugs in the app that the fuzz has found and that are not fixed yet (this test does not touch app code). Each entry is replayed on
// every run with its guard off and must still fail with `invariant`; the main run keeps its sequences away from the trigger (AVOID).
//   { id, invariant, ops, seed, reason }   replay: node tests/ai_lifecycle_fuzz_test.mjs --ops "<ops>"   (the minimal steps)
//   or the sequence the fuzz found it in: node tests/ai_lifecycle_fuzz_test.mjs --seed <seed> --no-guards   (12 steps, guards off)
const KNOWN_FAILURES = [
  // (Fixed and removed: two waiting requests of one note sharing one anchor text - each waiting text is numbered now ("[AI Correcting... 2]"); and
  // the bar's offsets going stale between opening it and Enter - the target is found again by its own text. The fuzz runs those cases freely.)
  {
    id: 'rewrite-restore-after-undo',
    invariant: 'text',
    ops: 'rewrite(0,0) undo(0,0) fail(0,0)',
    seed: 20593528,
    reason: 'Ctrl+Z on a waiting rewrite takes the anchor out and brings the original line back. When that request fails (or times out) later, the ' +
      'restore finds no anchor and APPENDS the original text at the end of the note: the line is there twice, and if the line has been rewritten ' +
      'again in the meantime, the old text comes back next to the new one (applyAnchorReplacement: "if anchor was removed/missing, append").'
  }
];
// Bugs the fuzz found that are fixed now: each replay must run clean on every run (a short list of the steps it printed as "minimal steps").
const FIXED_REPLAYS = [
  {
    id: 'ask-anchor-glued-to-line',
    ops: 'ask(901,944) rewrite(439,462) ask(469,779) fail(309,271) retry(958,43) ask(561,380) ask(826,24) fail(199,89) askBusy(723,44) fail(605,352) retry(901,66)',
    reason: 'a second ask waiting right under the first one: when the first failed or was cancelled its line break went with it, and the second waiting text ' +
      '(and later its answer) was glued to the user\'s own line (anchorGap in app.js). Also found by --count 1500 --steps 20 --base 3.'
  }
];
// Each guard keeps the main run away from the trigger of one known bug (the replays above run with all guards off).
//   undoRewrite:     Ctrl+Z is not pressed on a waiting rewrite's anchor (an ask's anchor is fine)
const AVOID = { undoRewrite: true };
const AVOID_KEYS = () => Object.keys(AVOID);

// ---------------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32): the only source of randomness in this file
// ---------------------------------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------
// The environment: app.js in a vm with a hand-made DOM (compiled once, one fresh context per sequence)
// ---------------------------------------------------------------------------------------------------
const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const SCRIPT_FILES = ['frontend/js/i18n.js', 'frontend/js/chrome_layout.js', 'frontend/js/mermaid_tone.js', 'frontend/js/llm_error.js', 'frontend/js/app.js'];
// FUZZ_APP_JS=<file> runs the fuzz against another copy of app.js: how to check that the invariants notice a broken lifecycle (mutation check).
const scripts = SCRIPT_FILES.map((file) => new vm.Script(file === 'frontend/js/app.js' && process.env.FUZZ_APP_JS ? read(process.env.FUZZ_APP_JS) : read(file), { filename: file }));
const i18nCtx = {};
vm.createContext(i18nCtx);
vm.runInContext(read('frontend/js/i18n.js') + '; this.I18N = I18N;', i18nCtx);
const I18N = i18nCtx.I18N;

const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane', 'inline-prompt-error', 'inline-prompt-setup'];

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Errors the app logs or leaves unhandled while a sequence runs are collected here (the sequence that is running owns them).
let currentErrors = null;
process.on('unhandledRejection', (reason) => { if (currentErrors) currentErrors.push('unhandled rejection: ' + (reason && reason.stack ? reason.stack.split('\n')[0] : reason)); });

async function createEnv() {
  const elements = new Map();
  const listeners = { keydown: [] };
  const store = new Map();
  const undoStack = []; // the editor's history: one entry per document.execCommand('insertText')
  let documentMock = null;

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
      set textContent(v) { textContent = v; innerHTML = v; },
      addEventListener: (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
      removeEventListener: () => {},
      focus: () => { documentMock.activeElement = el; },
      blur: () => {},
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e) => { el.selectionStart = s; el.selectionEnd = e; },
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
      hasAttribute: (name) => name in attrs,
      setAttribute: (name, val) => { attrs[name] = val; if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0 })
    };
    if (id === 'editor') {
      // Like a textarea: assigning .value drops the undo history; execCommand edits keep it.
      let text = '';
      Object.defineProperty(el, 'value', { configurable: true, enumerable: true, get: () => text, set: (v) => { text = String(v); undoStack.length = 0; } });
      el._setValueKeepingHistory = (v) => { text = String(v); };
    }
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
    execCommand: (cmd, _, text) => {
      if (cmd !== 'insertText') return false;
      const ed = elements.get('editor');
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      undoStack.push({ before: ed.value, start, end, inserted: text, reqN: null });
      ed._setValueKeepingHistory(ed.value.substring(0, start) + text + ed.value.substring(end));
      ed.selectionStart = ed.selectionEnd = start + text.length;
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const llmCalls = [];
  const backend = {
    getConfig: async () => '',
    saveConfig: async () => {},
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    queryLLMAsync: (reqId, prompt, cfgJson) => { llmCalls.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); }
  };

  // Timers shorter than 10 s run at once (debounces, toast clearing); the long ones (the 180 s request watchdog) wait for fireLongTimers.
  const longTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 10000) { longTimers.set(id, { fn, ms }); return id; }
    fn();
    return id;
  };

  const tasks = { added: [], updated: [] };
  const windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows', language: 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { longTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: {
      addTask: (o) => { tasks.added.push(o); return o; },
      updateTask: (id, u) => { tasks.updated.push(Object.assign({ id }, u)); }
    }
  };
  documentMock.defaultView = windowMock;

  const errors = [];
  const logArgs = (args) => Array.from(args).map((a) => (a && a.stack ? a.stack.split('\n')[0] : String(a))).join(' ');
  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    URL, // llm_error.js reads a base URL with it (is the model on this computer or on the internet?): the local default must count as local
    console: { log() {}, warn: (...a) => errors.push('console.warn: ' + logArgs(a)), error: (...a) => errors.push('console.error: ' + logArgs(a)) }
  };
  vm.createContext(context);
  currentErrors = errors;
  for (const script of scripts) script.runInContext(context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  const env = {
    window: windowMock, llmCalls, tasks, el, errors, undoStack,
    bridge: windowMock.MdMemoBridge,
    rpc: windowMock.__mdMemoRPC,
    editor: el('editor'),
    fire(id, evt, init) {
      const e = Object.assign({ key: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      (el(id)._listeners[evt] || []).forEach((fn) => fn(e));
      return e;
    },
    key(init) {
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    ctrl: (letter) => env.key({ key: letter, code: 'Key' + letter.toUpperCase(), ctrlKey: true }),
    hidden: (id) => el(id).classList.contains('hidden'),
    activeTabId: () => env.bridge.getActiveTab().id,
    fireLongTimers() {
      const fns = Array.from(longTimers.values()).map((t) => t.fn);
      longTimers.clear();
      fns.forEach((fn) => fn());
    },
    longTimerCount: () => longTimers.size,
    // The request watchdogs (LLM_REQUEST_TIMEOUT_MS in app.js, 180 s). Other long timers the app arms for itself are not requests.
    watchdogCount: () => Array.from(longTimers.values()).filter((t) => t.ms === 180000).length,
    // What Ctrl+Z does to the editor: the last execCommand edit is taken back, and the app hears about it through an input event.
    undoLastEdit() {
      const entry = undoStack.pop();
      if (!entry) return false;
      env.editor._setValueKeepingHistory(entry.before);
      env.editor.selectionStart = entry.start;
      env.editor.selectionEnd = entry.end;
      env.fire('editor', 'input', {});
      return true;
    },
    flush
  };
  return env;
}

// ---------------------------------------------------------------------------------------------------
// The model: what the sequence has done, and what each request's fate has to be
// ---------------------------------------------------------------------------------------------------
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const makeLines = (tabNo) => WORDS.map((w, i) => `t${tabNo}l${i + 1} ${w}`);

const INSTRUCTIONS = ['translate', 'summarize', 'shorten', 'fix typos'];

const PLACEHOLDERS = [
  { re: /\[AI Generating/, id: 'placeholder' },
  { re: /\[AI Correcting/, id: 'placeholder' },
  { re: /\[LLM error/, id: 'llm-error-in-note' }
];

function parsePrompt(prompt) {
  let m = /^【指示】:\n([\s\S]*?)\n\n【対象テキスト】:\n([\s\S]*)$/.exec(prompt);
  if (m) return { kind: 'ask', instr: m[1], target: m[2] };
  m = /^Rewrite the following text[\s\S]*?\[Instruction\]:\n([\s\S]*?)\n\n\[Text\]:\n([\s\S]*)$/.exec(prompt);
  if (m) return { kind: 'rewrite', instr: m[1], target: m[2] };
  return null;
}

// The text the app put in a note for the request it has just sent: the one waiting text that was not there before the step. Every
// waiting request has a text of its own ("[AI Correcting...]", then "[AI Correcting... 2]"): an answer, a cancel and a restore find
// their place by it. null = no new text appeared, or it repeats one that is already in the note (two requests would share it).
const ANCHOR_RE = /\[AI (?:Generating|Correcting)[^\]\n]*\]/g;
function newAnchorIn(textBefore, textAfter) {
  const had = new Set(textBefore.match(ANCHOR_RE) || []);
  const fresh = (textAfter.match(ANCHOR_RE) || []).filter((a) => !had.has(a));
  return fresh.length === 1 ? fresh[0] : null;
}

function newSession(env) {
  return {
    env, tabs: [], reqs: [], badTokens: [], failures: [], trace: [], serial: 0, tabSerial: 0, stats: {},
    bump(name) { this.stats[name] = (this.stats[name] || 0) + 1; },
    fail(id, detail) { this.failures.push({ id, detail }); }
  };
}

function addTabRecord(S, id) {
  const rec = { id, no: ++S.tabSerial, lines: null, alive: true };
  rec.lines = makeLines(rec.no);
  S.tabs.push(rec);
  return rec;
}

function refreshTabs(S) {
  const live = new Set(S.env.rpc.getTabs().map((t) => t.id));
  for (const t of S.tabs) t.alive = live.has(t.id);
}

const activeRec = (S) => S.tabs.find((t) => t.alive && t.id === S.env.activeTabId());
const pendingReqs = (S) => S.reqs.filter((r) => !r.outcome);
const settledReqs = (S) => S.reqs.filter((r) => r.outcome);

// Where the app wrote the anchor of a request it has just sent, compared with the line the question is about (null = as it should be).
function placementProblem(S, req) {
  if (!req.anchor) return 'no waiting text of its own appeared in the note (it repeats one that is already there)';
  if (req.line < 0) return null;
  const text = S.env.bridge.getTabText(req.tab.id) || '';
  const lineText = req.tab.lines[req.line];
  if (req.kind === 'ask') {
    const at = text.indexOf(lineText);
    if (at === -1) return `the note no longer holds "${lineText}"`;
    const want = '\n\n' + req.anchor + '\n';
    return text.startsWith(want, at + lineText.length) ? null : `the anchor of the question about "${lineText}" is not right under it: ${JSON.stringify(text.slice(at, at + lineText.length + want.length + 8))}`;
  }
  if (text.split('\n').includes(lineText)) return `the line to rewrite ("${lineText}") is still in the note: something else was replaced`;
  const i = text.indexOf(req.anchor);
  if (i === -1) return 'the rewrite anchor is not in the note';
  const before = i === 0 || text[i - 1] === '\n';
  const after = i + req.anchor.length >= text.length || text[i + req.anchor.length] === '\n';
  return before && after ? null : 'the rewrite anchor is in the middle of a line';
}

// Requests the app has just sent (llmCalls grew): the model learns (kind, target line, tab) from the prompt the app actually built.
function registerNewCalls(S, fromIndex, ownerTab, textBefore) {
  const { env } = S;
  for (let i = fromIndex; i < env.llmCalls.length; i++) {
    const call = env.llmCalls[i];
    const parsed = parsePrompt(call.prompt);
    if (!parsed) { S.fail('unparsed-prompt', call.prompt.slice(0, 80)); continue; }
    // The note a request belongs to is the one the bar was opened for: a Retry runs there even when another note is on screen now.
    const tab = ownerTab;
    // A target that is none of the note's own lines (the bar reopened on the current line, which holds an earlier answer): the request
    // still has to settle cleanly, but where its answer goes is not modelled (the note is "loose").
    const line = tab.lines.indexOf(parsed.target);
    if (line === -1) tab.loose = true;
    const n = ++S.serial;
    const anchor = newAnchorIn(textBefore, env.bridge.getTabText(tab.id) || '');
    const req = { n, reqId: call.reqId, kind: parsed.kind, instr: parsed.instr, anchor, tab, line, token: (parsed.kind === 'ask' ? 'ANS' : 'RW') + n, outcome: null, anchorLost: false };
    S.reqs.push(req);
    // Was the anchor written where the question is about (the bar's offsets may be from before the note changed)?
    const misplaced = placementProblem(S, req);
    if (misplaced) S.fail('placement', misplaced);
    const top = env.undoStack[env.undoStack.length - 1];
    if (top && !top.reqN && /\[AI (Generating|Correcting)/.test(top.inserted)) top.reqN = n;
    S.bump('sent-' + parsed.kind);
  }
}

const deliver = (S, req, text, error) => S.env.window.__onLLMResult(req.reqId, text, error);
const pick = (list, a) => list[a % list.length];

// One step. Returns true when it did something (false = not applicable in the current state, so nothing happened).
async function step(S, op) {
  const { env } = S;
  refreshTabs(S);
  switch (op.op) {
    case 'ask':
    case 'askBusy': // askBusy: an answer arrives while the person is still typing the question
    case 'rewrite': {
      const kind = op.op === 'rewrite' ? 'rewrite' : 'ask';
      const tab = activeRec(S);
      if (!tab) return false;
      const text = env.editor.value;
      const present = tab.lines.map((l, i) => i).filter((i) => text.split('\n').filter((l) => l === tab.lines[i]).length === 1);
      if (!present.length) return false;
      const line = tab.lines[pick(present, op.a)];
      // Often a phrase people really repeat ("translate"), sometimes a one-off: repeated ones would make waiting requests share an anchor.
      const instr = op.b % 4 === 0 ? INSTRUCTIONS[(op.b >> 2) % INSTRUCTIONS.length] : `u${S.serial + 1}`;
      // A bar that is still open from an earlier failure keeps its old target when the shortcut is pressed again: start from a closed one.
      if (!env.hidden('inline-prompt-bar')) env.key({ key: 'Escape', code: 'Escape', keyCode: 27 });
      const start = text.indexOf(line);
      env.editor.selectionStart = start;
      env.editor.selectionEnd = start + line.length;
      env.window.document.activeElement = env.editor;
      const before = env.llmCalls.length;
      env.ctrl(kind === 'ask' ? 'l' : 'k');
      if (env.hidden('inline-prompt-bar')) return false;
      if (op.op === 'askBusy') {
        const mine = pendingReqs(S).filter((r) => r.tab === tab);
        if (mine.length) { const r = pick(mine, op.a); deliver(S, r, r.token, ''); r.outcome = 'applied'; }
      }
      env.el('inline-prompt-input').value = instr;
      // what the note holds when Enter is pressed (an answer may have landed while the question was being typed)
      const textAtEnter = env.bridge.getTabText(tab.id) || '';
      env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
      await env.flush();
      registerNewCalls(S, before, tab, textAtEnter);
      return env.llmCalls.length > before;
    }
    case 'retry': {
      if (env.hidden('inline-prompt-bar') || env.hidden('inline-prompt-error')) return false;
      const tab = S.bar ? S.tabs.find((t) => t.alive && t.id === S.bar.tabId) : activeRec(S);
      if (!tab) return false;
      const before = env.llmCalls.length;
      const textBefore = env.bridge.getTabText(tab.id) || '';
      if (op.a % 2) env.el('btn-inline-prompt-retry').onclick();
      else env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
      await env.flush();
      registerNewCalls(S, before, tab, textBefore);
      return env.llmCalls.length > before;
    }
    case 'ok':
    case 'twice': {
      const list = pendingReqs(S);
      if (!list.length) return false;
      const r = pick(list, op.a);
      deliver(S, r, r.token, '');
      r.outcome = r.tab.alive ? 'applied' : 'dropped';
      if (op.op === 'twice') {
        const dup = 'DUP' + r.n;
        S.badTokens.push(dup);
        deliver(S, r, dup, '');
      }
      await env.flush();
      return true;
    }
    case 'fail': {
      const list = pendingReqs(S);
      if (!list.length) return false;
      const r = pick(list, op.a);
      deliver(S, r, '', 'boom ' + r.n);
      r.outcome = r.tab.alive ? 'failed' : 'dropped';
      await env.flush();
      return true;
    }
    case 'late': {
      const list = settledReqs(S);
      if (!list.length) return false;
      const r = pick(list, op.a);
      const token = 'LATE' + r.n + '_' + S.serial;
      S.badTokens.push(token);
      if (op.b % 2) deliver(S, r, token, ''); else deliver(S, r, '', 'late error');
      await env.flush();
      return true;
    }
    case 'cancel': {
      const list = pendingReqs(S).filter((r) => env.tasks.added.some((t) => t.id === r.reqId));
      if (!list.length) return false;
      const r = pick(list, op.a);
      env.tasks.added.find((t) => t.id === r.reqId).onCancel();
      r.outcome = 'canceled';
      await env.flush();
      return true;
    }
    case 'undo': {
      // Only the case "the last edit is the anchor of a request that is still waiting" is taken back; undoing a finished result
      // brings its anchor back (UX review D5) and is not part of this test.
      const top = env.undoStack[env.undoStack.length - 1];
      if (!top || !top.reqN) return false;
      const r = S.reqs[top.reqN - 1];
      if (!r || r.outcome || !r.tab.alive || r.tab.id !== env.activeTabId()) return false;
      if (AVOID.undoRewrite && r.kind === 'rewrite') return false;
      env.undoLastEdit();
      r.anchorLost = true;
      await env.flush();
      return true;
    }
    case 'switch': {
      const others = S.tabs.filter((t) => t.alive && t.id !== env.activeTabId());
      if (!others.length) return false;
      env.rpc.switchTab(pick(others, op.a).id);
      await env.flush();
      return true;
    }
    case 'close': {
      const alive = S.tabs.filter((t) => t.alive);
      if (alive.length < 2) return false;
      const victim = pick(alive, op.a);
      env.rpc.closeTab(victim.id);
      await env.flush();
      if (!env.hidden('confirm-modal')) { // unsaved changes: "Don't save"
        env.el('confirm-modal-dontsave').onclick();
        await env.flush();
      }
      refreshTabs(S);
      return !victim.alive;
    }
    case 'open': {
      if (S.tabs.filter((t) => t.alive).length >= 4) return false;
      const rec = addTabRecord(S, 'pending');
      env.window.__testHelper.createTab(`t${rec.no}.md`, rec.lines.join('\n'));
      rec.id = env.activeTabId();
      await env.flush();
      return true;
    }
    case 'escape': {
      env.key({ key: 'Escape', code: 'Escape', keyCode: 27 });
      await env.flush();
      return true;
    }
    default:
      throw new Error('unknown step ' + op.op);
  }
}

// ---------------------------------------------------------------------------------------------------
// Settling and the invariants
// ---------------------------------------------------------------------------------------------------
const nonBlank = (text) => text.split('\n').filter((l) => l.trim() !== '');
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

function checkNote(S, tab) {
  const { env } = S;
  const text = env.bridge.getTabText(tab.id);
  const label = `tab ${tab.no}`;
  if (text === null) { S.fail('exception', `${label}: the note vanished`); return; }
  for (const p of PLACEHOLDERS) {
    if (p.re.test(text)) S.fail(p.id, `${label}: ${p.re.source} is in the note: ${JSON.stringify(text)}`);
  }

  const mine = S.reqs.filter((r) => r.tab === tab);
  const lines = nonBlank(text);
  const count = (s) => lines.filter((l) => l === s).length;
  const normalRewrite = (i) => mine.find((r) => r.kind === 'rewrite' && r.line === i && r.outcome === 'applied' && !r.anchorLost);
  const problems = S.failures.length;
  const dump = `note: ${JSON.stringify(lines)}`;

  // Answers that must be there exactly once, answers that must not be there at all, and nothing from late or repeated answers.
  const allowed = new Map();
  for (const r of mine) allowed.set(r.token, r.outcome === 'applied' ? (tab.loose ? [0, 1] : [1]) : [0]);
  for (const t of S.badTokens) allowed.set(t, [0]);
  if (!tab.loose) {
    tab.lines.forEach((l, i) => {
      let want = [1];
      if (normalRewrite(i)) want = [0];
      allowed.set(l, want);
    });
  }
  for (const [s, want] of allowed) {
    if (!want.includes(count(s))) S.fail('text', `${label}: "${s}" appears ${count(s)} time(s), expected ${want.join(' or ')}; ${dump}`);
  }
  if (tab.loose) return;
  const known = new Set(allowed.keys());
  const junk = lines.filter((l) => !known.has(l));
  if (junk.length) S.fail('text', `${label}: unexpected text in the note: ${JSON.stringify(junk)}; ${dump}`);
  // an undone anchor sends its answer to the end of the note, so positions are only checked when every anchor stayed
  if (S.failures.length > problems || mine.some((r) => r.anchorLost)) return;

  // positions: every slot holds its line (or the rewrite answer that replaced it), then the answers of the asks about it
  let p = 0;
  for (let i = 0; i < tab.lines.length; i++) {
    const rw = normalRewrite(i);
    const item = rw ? rw.token : tab.lines[i];
    if (lines[p] !== item) { S.fail('position', `${label}: slot ${i + 1} should hold "${item}" but holds "${lines[p]}"; ${dump}`); return; }
    p++;
    const asks = mine.filter((r) => r.kind === 'ask' && r.line === i && r.outcome === 'applied').map((r) => r.token).sort();
    const got = lines.slice(p, p + asks.length).sort();
    if (JSON.stringify(got) !== JSON.stringify(asks)) { S.fail('position', `${label}: under slot ${i + 1} expected ${JSON.stringify(asks)} but found ${JSON.stringify(got)}; ${dump}`); return; }
    p += asks.length;
  }
}

// What the app says is in flight (the status-bar count, the armed watchdogs) must be exactly the requests nobody has answered yet.
function checkPending(S, where) {
  const { env } = S;
  const waiting = pendingReqs(S).length;
  const shown = env.hidden('stat-llm-indicator') ? 0 : Number((/(\d+)/.exec(env.el('stat-llm-text').textContent) || [0, 1])[1]);
  if (shown !== waiting) S.fail('pending', `${where}: the status bar counts ${shown} request(s) in flight, ${waiting} are`);
  if (env.watchdogCount() !== waiting) S.fail('pending', `${where}: ${env.watchdogCount()} watchdog timer(s) armed for ${waiting} waiting request(s)`);
}

async function settle(S) {
  const { env } = S;
  refreshTabs(S);
  checkPending(S, 'before the watchdog');
  // the watchdog gives up on everything that is still waiting
  env.fireLongTimers();
  await env.flush();
  refreshTabs(S);
  for (const r of pendingReqs(S)) r.outcome = r.tab.alive ? 'failed' : 'dropped';

  // pending
  if (!env.hidden('stat-llm-indicator')) S.fail('pending', `the status bar still shows a request in flight: "${env.el('stat-llm-text').textContent}"`);
  if (env.watchdogCount() !== 0) S.fail('pending', `${env.watchdogCount()} watchdog timer(s) still armed`);

  // tasks
  for (const t of env.tasks.added) {
    const ends = env.tasks.updated.filter((u) => u.id === t.id && TERMINAL.has(u.status));
    if (ends.length !== 1) S.fail('tasks', `task ${t.id} ended ${ends.length} times (${ends.map((u) => u.status).join(', ')})`);
  }

  // late answers change nothing
  const notes = S.tabs.filter((t) => t.alive);
  const before = notes.map((t) => env.bridge.getTabText(t.id));
  for (const r of S.reqs) {
    deliver(S, r, 'LATE-END' + r.n, '');
    deliver(S, r, '', 'late end error');
  }
  await env.flush();
  notes.forEach((t, i) => {
    if (env.bridge.getTabText(t.id) !== before[i]) S.fail('late', `tab ${t.no} changed when answers arrived after everything had settled`);
  });

  // the notes
  for (const t of notes) checkNote(S, t);
  if (env.errors.length) S.fail('exception', env.errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------------------------------
const OPS = [['ask', 15], ['askBusy', 3], ['rewrite', 9], ['ok', 14], ['fail', 9], ['late', 5], ['twice', 5], ['cancel', 10], ['undo', 6],
  ['switch', 9], ['close', 6], ['open', 3], ['escape', 4], ['retry', 6]];
const OP_TOTAL = OPS.reduce((n, [, w]) => n + w, 0);

function generate(seed, steps) {
  const rnd = mulberry32(seed);
  const ops = [];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * OP_TOTAL;
    let name = OPS[0][0];
    for (const [op, w] of OPS) { if (x < w) { name = op; break; } x -= w; }
    // A failure reopens the bar with a Retry button: people press it.
    if (i > 0 && ops[i - 1].op === 'fail' && rnd() < 0.3) name = 'retry';
    ops.push({ op: name, a: Math.floor(rnd() * 1000), b: Math.floor(rnd() * 1000) });
  }
  return ops;
}

const fmtOp = (o) => `${o.op}(${o.a},${o.b})`;

async function runSequence(ops) {
  const env = await createEnv();
  const S = newSession(env);
  const first = addTabRecord(S, env.activeTabId());
  env.editor.value = first.lines.join('\n');
  env.editor.selectionStart = env.editor.selectionEnd = 0;
  const tab0 = env.bridge.getActiveTab();
  tab0.content = env.editor.value;
  tab0.isDirty = false;
  try {
    // two notes to begin with, the first one on screen
    await step(S, { op: 'open', a: 0, b: 0 });
    env.rpc.switchTab(first.id);
    await env.flush();
    for (const op of ops) {
      S.trace.push(fmtOp(op));
      const did = await step(S, op);
      S.bump(did ? 'did-' + op.op : 'skipped-' + op.op);
      if (argv.includes('--dump')) {
        console.log(`  ${fmtOp(op)} ${did ? '' : '(nothing to do)'} active=tab ${(activeRec(S) || {}).no}; waiting: ${pendingReqs(S).map((r) => `${r.token}@tab${r.tab.no}:${r.line + 1}`).join(' ') || '-'}`);
        for (const t of S.tabs.filter((x) => x.alive)) console.log(`      tab ${t.no}: ${JSON.stringify(env.bridge.getTabText(t.id))}`);
      }
      // what the ask bar's offsets refer to: the note as it was when the bar (re)opened
      if (env.hidden('inline-prompt-bar')) S.bar = null;
      else if (!S.bar) S.bar = { tabId: env.activeTabId(), text: env.bridge.getTabText(env.activeTabId()) };
      if (!S.failures.some((f) => f.id === 'pending')) checkPending(S, `after ${fmtOp(op)}`);
      if (S.failures.some((f) => f.id === 'exception')) break;
    }
    await settle(S);
  } catch (err) {
    S.fail('exception', String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
  }
  currentErrors = null;
  return S;
}

// The shortest list of steps that still fails with the same invariant.
async function shrink(ops, invariant) {
  let cur = ops.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const cand = cur.slice(0, i).concat(cur.slice(i + 1));
      const S = await runSequence(cand);
      if (S.failures.some((f) => f.id === invariant)) { cur = cand; changed = true; }
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------
const started = Date.now();
if (EXPLICIT_OPS || argv.includes('--no-guards')) for (const k of AVOID_KEYS()) AVOID[k] = false;
const seeds = EXPLICIT_OPS ? [0] : ONE_SEED !== null ? [ONE_SEED >>> 0] : Array.from({ length: SEQUENCES }, (_, i) => seedFor(i));
const totals = {};
const unexpected = [];

for (const seed of seeds) {
  const ops = EXPLICIT_OPS || generate(seed, STEPS);
  const S = await runSequence(ops);
  for (const [k, v] of Object.entries(S.stats)) totals[k] = (totals[k] || 0) + v;
  if (VERBOSE) {
    console.log(`seed ${seed}: ${S.trace.join(' ')}`);
    for (const t of S.tabs.filter((x) => x.alive)) console.log(`  tab ${t.no}: ${JSON.stringify(nonBlank(S.env.bridge.getTabText(t.id)))}`);
    console.log('  ' + (S.failures.length ? 'FAILURES: ' + S.failures.map((f) => f.id + ': ' + f.detail).join('\n            ') : 'no failures'));
  }
  if (!S.failures.length) continue;
  unexpected.push({ seed, ops, failure: S.failures[0] });
}

// The known bugs: each replay must still fail the documented way (with the guard off).
const fixed = [];
if (ONE_SEED === null && !EXPLICIT_OPS) {
  const saved = { ...AVOID };
  for (const k of AVOID_KEYS()) AVOID[k] = false;
  for (const k of KNOWN_FAILURES) {
    const S = await runSequence(parseOps(k.ops));
    if (!S.failures.some((f) => f.id === k.invariant)) fixed.push(k);
  }
  Object.assign(AVOID, saved);
}

// The fixed bugs stay fixed.
const regressed = [];
if (ONE_SEED === null && !EXPLICIT_OPS) {
  for (const r of FIXED_REPLAYS) {
    const S = await runSequence(parseOps(r.ops));
    if (S.failures.length) regressed.push({ r, failure: S.failures[0] });
  }
}

// The run must really exercise the lifecycle (a harness that silently skips everything would pass forever).
const MIN_DID = { ask: 300, askBusy: 20, rewrite: 180, ok: 170, fail: 100, late: 60, twice: 60, cancel: 70, undo: 20, switch: 150, close: 100, open: 70, escape: 90, retry: 20 };
const coverage = [];
if (ONE_SEED === null && !EXPLICIT_OPS && SEQUENCES >= 300 && STEPS >= 12) {
  for (const [op, min] of Object.entries(MIN_DID)) {
    if ((totals['did-' + op] || 0) < min) coverage.push(`${op}: only ${totals['did-' + op] || 0} step(s) did anything, expected at least ${min}`);
  }
}

const elapsed = Date.now() - started;
console.log(`${seeds.length} sequence(s) x ${STEPS} steps in ${elapsed} ms; steps that did something: ` +
  Object.keys(MIN_DID).map((op) => `${op} ${totals['did-' + op] || 0}`).join(', '));
if (KNOWN_FAILURES.length && !fixed.length && ONE_SEED === null && !EXPLICIT_OPS) console.log(`known bugs still reproduce (${KNOWN_FAILURES.map((k) => k.id).join(', ')})`);

let exitCode = 0;
for (const u of unexpected.slice(0, argValue("--show", 5))) {
  exitCode = 1;
  const small = await shrink(u.ops, u.failure.id);
  console.error(`FAIL: seed ${u.seed} (${u.failure.id}): ${u.failure.detail}`);
  console.error(`  minimal steps: ${small.map(fmtOp).join(' ')}`);
  console.error(`  replay: node tests/ai_lifecycle_fuzz_test.mjs --seed ${u.seed}   or   --ops "${small.map(fmtOp).join(' ')}"`);
}
if (unexpected.length > 5) console.error(`... and ${unexpected.length - 5} more failing sequence(s)`);
for (const k of fixed) {
  exitCode = 1;
  console.error(`FAIL: known bug ${k.id} no longer reproduces (${k.reason}): remove it from KNOWN_FAILURES and its guard from AVOID`);
}
for (const g of regressed) {
  exitCode = 1;
  console.error(`FAIL: fixed bug ${g.r.id} is back (${g.failure.id}: ${g.failure.detail}): ${g.r.reason}`);
}
for (const c of coverage) { exitCode = 1; console.error(`FAIL: coverage: ${c}`); }
if (elapsed > 30000) { exitCode = 1; console.error(`FAIL: ${elapsed} ms is far beyond the budget (about 5 s)`); }
if (exitCode === 0) console.log(`PASS: AI request lifecycle fuzz (${seeds.length} sequences, invariants: pending, tasks, placeholder, text, late, exception)`);
process.exit(exitCode);
