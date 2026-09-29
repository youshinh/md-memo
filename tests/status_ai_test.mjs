// The AI item of the status bar (frontend/js/status_ai.js), the real <button>s next to it, and their wiring in app.js.
// Pure logic, a DOM-mock run of the popover (open, switches, Esc, outside press, focus, no listeners while closed), the toggles
// of app.js that carry a toast, and static checks of the markup, the CSS and the strings. Nothing here touches a real window.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const StatusAI = require('../frontend/js/status_ai.js');
const html = read('frontend/index.html');
const app = read('frontend/js/app.js');
const css = read('frontend/css/style.css');
const i18nSrc = read('frontend/js/i18n.js');
const moduleSrc = read('frontend/js/status_ai.js');
const ctx = {};
vm.runInNewContext(i18nSrc + '\nthis.I18N = I18N;', ctx);
const I18N = JSON.parse(JSON.stringify(ctx.I18N));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    console.log('FAIL: ' + name + '\n  ' + (e && e.message));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------------------------------
check('hostOf: scheme, credentials, port, path and IPv6 are stripped', () => {
  assert.equal(StatusAI.hostOf('http://localhost:11434'), 'localhost');
  assert.equal(StatusAI.hostOf('https://User:pw@Generativelanguage.googleapis.com/v1beta'), 'generativelanguage.googleapis.com');
  assert.equal(StatusAI.hostOf('localhost:11434/v1'), 'localhost');
  assert.equal(StatusAI.hostOf('http://[::1]:8080/x'), '::1');
  assert.equal(StatusAI.hostOf('  '), '');
  assert.equal(StatusAI.hostOf(null), '');
});

check('fallbackIsLocal: this computer and the local network are local, a public host is cloud', () => {
  for (const url of ['http://localhost:11434', 'http://127.0.0.1:8080', 'http://[::1]:1234', 'http://192.168.1.20:11434', 'http://10.0.0.5', 'http://172.20.1.1', 'http://ollama.local:11434']) {
    assert.equal(StatusAI.fallbackIsLocal(url), true, url);
  }
  for (const url of ['https://generativelanguage.googleapis.com', 'https://openrouter.ai/api/v1', 'https://api.openai.com', 'http://172.32.0.1', 'http://8.8.8.8', '']) {
    assert.equal(StatusAI.fallbackIsLocal(url), false, url);
  }
  // the ask bar's own rule (LlmError.isLocal) is the one the page uses, and the two agree on these
  const LlmError = require('../frontend/js/llm_error.js');
  for (const url of ['http://localhost:11434', 'http://192.168.1.20:11434', 'https://openrouter.ai/api/v1', 'http://172.32.0.1']) {
    assert.equal(StatusAI.fallbackIsLocal(url), LlmError.isLocal(url), 'same answer as LlmError.isLocal for ' + url);
  }
});

check('B18: a name that only starts like a private address, or an address hidden in the user part, is cloud in both rules', () => {
  const LlmError = require('../frontend/js/llm_error.js');
  for (const url of ['https://10.evil.example/v1', 'https://127.evil.com', 'https://192.168.evil.io', 'https://172.20.evil.net', 'https://10.0.0.1@evil.example/v1',
    'https://10.0.0.1:80@evil.example', 'https://alice:p@ss@10.evil.example', 'https://10.0.0.256', 'https://192.168.1.1.nip.io', 'https://localhost.evil.example']) {
    assert.equal(StatusAI.fallbackIsLocal(url), false, 'fallback: ' + url);
    assert.equal(LlmError.isLocal(url), false, 'ask bar: ' + url);
  }
  for (const url of ['http://user:pw@10.0.0.5:1234', 'http://alice:p@ss@192.168.1.5', 'http://my-pc.local:11434']) {
    assert.equal(StatusAI.fallbackIsLocal(url), true, 'fallback: ' + url);
    assert.equal(LlmError.isLocal(url), true, 'ask bar: ' + url);
  }
  assert.equal(StatusAI.hostOf('https://alice:p@ss@llm.example.com:8443/v1'), 'llm.example.com', 'the credentials end at the last @');
  const cfg = { text: { baseUrl: 'https://10.evil.example/v1', model: 'm' } };
  assert.equal(StatusAI.modelState(cfg, true, LlmError.isLocal).kind, 'cloud');
  assert.equal(StatusAI.modelState(cfg, true).kind, 'cloud');
});

check('modelState: not set up when the app says no model can answer, otherwise local or cloud with the model name', () => {
  const cfg = { text: { baseUrl: 'http://localhost:11434', model: ' qwen2.5:latest ' } };
  assert.deepEqual(StatusAI.modelState(cfg, false), { kind: 'unset', model: '' });
  assert.deepEqual(StatusAI.modelState(cfg, true), { kind: 'local', model: 'qwen2.5:latest' });
  assert.deepEqual(StatusAI.modelState({ text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest' } }, true), { kind: 'cloud', model: 'gemini-flash-lite-latest' });
  assert.equal(StatusAI.modelState(cfg, true, () => false).kind, 'cloud', 'the locality rule can be injected');
  assert.deepEqual(StatusAI.modelState(undefined, true).kind, 'cloud', 'a missing text group does not throw');
});

check('optionStates: read defensively from an old config; defaults are prediction as saved, suggestions on, voice tidy-up on', () => {
  assert.deepEqual(StatusAI.optionStates({}), { prediction: false, suggestions: true, suggestionsManual: false, voice: true });
  assert.deepEqual(StatusAI.optionStates({ autocomplete: { enabled: true }, action: { enabled: true, manualOnly: true }, voice: { refine: { enabled: false } } }),
    { prediction: true, suggestions: true, suggestionsManual: true, voice: false });
  assert.deepEqual(StatusAI.optionStates({ action: { enabled: false, manualOnly: true } }).suggestionsManual, false, 'manual only counts while suggestions are on');
  assert.deepEqual(StatusAI.optionStates(null), { prediction: false, suggestions: true, suggestionsManual: false, voice: true });
});

check('itemView: label, tooltip and what a click does, per state', () => {
  const unset = StatusAI.itemView({ kind: 'unset', model: '' }, null);
  assert.deepEqual([unset.level, unset.labelKey, unset.opensSettings], ['unset', 'statAiNotSet', true]);
  const local = StatusAI.itemView({ kind: 'local', model: 'm' }, { state: 'ok' });
  assert.deepEqual([local.level, local.labelKey, local.opensSettings, local.titleVars.model], ['ok', 'statAiLocal', false, 'm']);
  const cloud = StatusAI.itemView({ kind: 'cloud', model: 'g' }, null);
  assert.equal(cloud.labelKey, 'statAiCloud');
  const err = StatusAI.itemView({ kind: 'local', model: 'm' }, { state: 'error', message: 'boom' });
  assert.deepEqual([err.level, err.labelKey, err.titleVars.error], ['error', 'statAiError', 'boom']);
  assert.equal(StatusAI.itemView({ kind: 'unset' }, { state: 'error', message: 'x' }).level, 'unset', 'not set up wins over an old error');
  assert.equal(StatusAI.itemView({ kind: 'local', model: 'm' }, { state: 'busy' }).level, 'ok', 'a pending request does not change the label');
});

check('place: above the item, right edges together, never off the window', () => {
  const wide = StatusAI.place({ left: 900, right: 960, top: 696 }, { width: 1120, height: 720 }, 320);
  assert.deepEqual(wide, { right: 160, bottom: 30, width: 320 });
  const edge = StatusAI.place({ left: 1090, right: 1118, top: 696 }, { width: 1120, height: 720 }, 320);
  assert.equal(edge.right, 8, 'at least the 8px margin');
  const narrow = StatusAI.place({ left: 50, right: 90, top: 576 }, { width: 400, height: 600 }, 320);
  assert.ok(400 - narrow.right - narrow.width >= 8, 'the left edge stays inside the window');
  const tiny = StatusAI.place({ left: 10, right: 40, top: 300 }, { width: 200, height: 320 }, 320);
  assert.equal(tiny.width, 184, 'narrower than the window minus its margins');
});

check('nextIndex wraps both ways; oneLine flattens and cuts', () => {
  assert.equal(StatusAI.nextIndex(4, 3, 1), 0);
  assert.equal(StatusAI.nextIndex(4, 0, -1), 3);
  assert.equal(StatusAI.nextIndex(4, -1, 1), 0);
  assert.equal(StatusAI.nextIndex(4, -1, -1), 3);
  assert.equal(StatusAI.nextIndex(0, 0, 1), -1);
  assert.equal(StatusAI.oneLine('a\n  b\t c ', 50), 'a b c');
  assert.equal(StatusAI.oneLine('x'.repeat(200), 160).length, 161);
  assert.equal(StatusAI.oneLine(null, 10), '');
});

// ---------------------------------------------------------------------------------------------------
// 2. The popover against a hand-made DOM
// ---------------------------------------------------------------------------------------------------
function makeDom() {
  const registry = new Map();
  const docListeners = [];
  const winListeners = [];
  const doc = {
    body: null,
    documentElement: null,
    activeElement: null,
    getElementById: (id) => registry.get(id) || null,
    addEventListener: (type, fn, capture) => docListeners.push({ type, fn, capture: !!capture }),
    removeEventListener: (type, fn, capture) => {
      const i = docListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) docListeners.splice(i, 1);
    },
    createElement: (tag) => makeEl(tag)
  };
  function makeEl(tag) {
    const classes = new Set();
    const attrs = {};
    const listeners = [];
    let text = '';
    const el = {
      tagName: String(tag).toUpperCase(),
      id: '',
      type: '',
      title: '',
      style: {},
      children: [],
      parentNode: null,
      textWrites: 0,
      disabled: false,
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return text; },
      set textContent(v) { text = String(v); el.textWrites++; if (v === '') el.children = []; },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        }
      },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      removeAttribute(k) { delete attrs[k]; },
      hasAttribute(k) { return k in attrs; },
      appendChild(child) { child.parentNode = el; el.children.push(child); if (child.id) registry.set(child.id, child); adopt(child); return child; },
      contains(node) { for (let n = node; n; n = n.parentNode) if (n === el) return true; return false; },
      querySelectorAll(sel) {
        const out = [];
        (function walk(n) { n.children.forEach((c) => { if (sel === 'button' && c.tagName === 'BUTTON') out.push(c); walk(c); }); })(el);
        return out;
      },
      addEventListener(type, fn) { listeners.push({ type, fn }); },
      dispatch(type, ev) {
        const event = Object.assign({ type, target: el, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, ev || {});
        listeners.filter((l) => l.type === type).forEach((l) => l.fn(event));
        return event;
      },
      focus() { doc.activeElement = el; },
      click() { el.dispatch('click'); },
      getBoundingClientRect() { return el._rect || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; },
      listenerCount() { return listeners.length; }
    };
    return el;
  }
  function adopt(node) {
    if (node.id) registry.set(node.id, node);
    node.children.forEach(adopt);
  }
  doc.body = makeEl('body');
  doc.documentElement = makeEl('html');
  const win = {
    innerWidth: 1120,
    innerHeight: 720,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); }
  };
  return { doc, win, makeEl, registry, docListeners, winListeners };
}

// A Node "t": the key, then the variables, so the assertions read the keys.
const tKey = (key, vars) => key + (vars && Object.keys(vars).length ? '(' + Object.values(vars).join(',') + ')' : '');

function makeItem(opts = {}) {
  const dom = makeDom();
  const trigger = dom.makeEl('button');
  trigger.id = 'stat-ai';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger._rect = { left: 1000, right: 1060, top: 696, bottom: 720, width: 60, height: 24 };
  dom.registry.set('stat-ai', trigger);
  dom.doc.body.appendChild(trigger);
  const state = {
    config: {
      text: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest' },
      autocomplete: { enabled: true },
      action: { enabled: true, manualOnly: false },
      voice: { refine: { enabled: true } }
    },
    configured: true,
    calls: []
  };
  Object.assign(state.config, opts.config || {});
  if (opts.configured === false) state.configured = false;
  const flip = (name, mutate) => () => {
    state.calls.push(name);
    mutate(state.config);
    item.refresh(); // what app.js does through refreshStatusAI()
  };
  const item = StatusAI.create({
    doc: dom.doc,
    win: dom.win,
    t: tKey,
    isLocal: (url) => StatusAI.fallbackIsLocal(url),
    getConfig: () => state.config,
    isConfigured: () => state.configured,
    getManualKey: () => 'Ctrl+J',
    actions: {
      prediction: flip('prediction', (c) => { c.autocomplete.enabled = !c.autocomplete.enabled; }),
      suggestions: flip('suggestions', (c) => { c.action.enabled = !c.action.enabled; if (!c.action.enabled) c.action.manualOnly = false; }),
      suggestionsManual: flip('suggestionsManual', (c) => { c.action.manualOnly = !c.action.manualOnly; }),
      voice: flip('voice', (c) => { c.voice.refine.enabled = !c.voice.refine.enabled; }),
      openSettings: () => state.calls.push('openSettings')
    }
  });
  item.refresh();
  return { dom, trigger, state, item, pop: () => dom.registry.get('status-ai-pop') || null, row: (id) => dom.registry.get(id) };
}

check('the item says where the model runs, and "not set up" opens Settings instead of the popover', () => {
  let m = makeItem();
  assert.equal(m.trigger.textContent, 'statAiLocal');
  assert.match(m.trigger.title, /^statAiTitleLocal\(qwen2\.5:latest\)$/);
  assert.equal(m.trigger.getAttribute('aria-haspopup'), 'dialog');

  m = makeItem({ config: { text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: 'k' } } });
  assert.equal(m.trigger.textContent, 'statAiCloud');

  m = makeItem({ configured: false });
  assert.equal(m.trigger.textContent, 'statAiNotSet');
  assert.ok(m.trigger.classList.contains('status-ai-unset'));
  assert.equal(m.trigger.getAttribute('aria-haspopup'), null, 'a plain button while it only leads to Settings');
  m.trigger.click();
  assert.deepEqual(m.state.calls, ['openSettings'], 'the click sets a model up');
  assert.equal(m.pop(), null, 'no popover was even built');
  assert.equal(m.item.isOpen(), false);

  // A model appears (Settings saved): the label and the popover behaviour follow
  m.state.configured = true;
  m.item.refresh();
  assert.equal(m.trigger.textContent, 'statAiLocal');
  assert.equal(m.trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(m.trigger.classList.contains('status-ai-unset'), false);
});

check('the popover is built on the first click; it lists the three helpers as real switches with their state', () => {
  const m = makeItem();
  assert.equal(m.pop(), null, 'nothing is built until it is used');
  assert.equal(m.dom.docListeners.length, 0, 'nothing listens on the document while it is closed');
  m.trigger.click();
  const pop = m.pop();
  assert.ok(pop, 'built');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.ok(pop.getAttribute('aria-label'));
  assert.equal(pop.classList.contains('hidden'), false);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(m.item.isOpen(), true);
  const ids = ['stat-autocomplete', 'stat-action', 'stat-action-manual', 'stat-voice-refine'];
  for (const id of ids) {
    const b = m.row(id);
    assert.equal(b.tagName, 'BUTTON', id + ' is a real button');
    assert.equal(b.getAttribute('role'), 'switch', id + ' is a switch');
    assert.ok(['true', 'false'].includes(b.getAttribute('aria-checked')), id + ' says whether it is on');
    assert.ok(b.getAttribute('aria-labelledby') && b.getAttribute('aria-describedby'), id + ' has a name and a description');
  }
  assert.equal(m.row('stat-autocomplete-name').textContent, 'aiOptPrediction');
  assert.equal(m.row('stat-action-name').textContent, 'aiOptSuggestions');
  assert.equal(m.row('stat-voice-refine-name').textContent, 'aiOptVoice');
  assert.equal(m.row('stat-action-manual-name').textContent, 'aiOptSuggestionsManual(Ctrl+J)', 'the sub-switch names the real key');
  assert.deepEqual(ids.map((id) => m.row(id).getAttribute('aria-checked')), ['true', 'true', 'false', 'true']);
  assert.equal(m.row('stat-action-manual').classList.contains('hidden'), false, 'the sub-switch shows while suggestions are on');
  assert.equal(m.dom.doc.activeElement, m.row('stat-autocomplete'), 'focus moves into the popover, onto the first switch');
  assert.match(pop.children[0].children[1].textContent, /^aiPopModelLocal\(qwen2\.5:latest\)$/, 'the model in use is named at the top');
  assert.equal(m.dom.docListeners.length, 2, 'while open: one press listener and one key listener on the document');
});

check('a switch flips its setting through the app function, and the popover shows the new state at once', () => {
  const m = makeItem();
  m.trigger.click();
  m.row('stat-autocomplete').click();
  assert.deepEqual(m.state.calls, ['prediction']);
  assert.equal(m.state.config.autocomplete.enabled, false);
  assert.equal(m.row('stat-autocomplete').getAttribute('aria-checked'), 'false');
  assert.equal(m.dom.doc.activeElement, m.row('stat-autocomplete'), 'focus stays on the switch you pressed');

  m.row('stat-action-manual').click();
  assert.equal(m.row('stat-action-manual').getAttribute('aria-checked'), 'true');
  m.row('stat-action').click(); // suggestions off: the sub-switch goes away and is off
  assert.equal(m.row('stat-action').getAttribute('aria-checked'), 'false');
  assert.equal(m.row('stat-action-manual').classList.contains('hidden'), true, 'the sub-switch hides while suggestions are off');
  assert.equal(m.row('stat-action-manual').getAttribute('aria-checked'), 'false');
  m.row('stat-voice-refine').click();
  assert.equal(m.row('stat-voice-refine').getAttribute('aria-checked'), 'false');
  assert.deepEqual(m.state.calls, ['prediction', 'suggestionsManual', 'suggestions', 'voice']);
});

check('Esc closes it and returns focus to the item; a press outside closes it without taking focus; a press inside does not', () => {
  const m = makeItem();
  m.trigger.click();
  const docKey = m.dom.docListeners.find((l) => l.type === 'keydown');
  const docPress = m.dom.docListeners.find((l) => l.type === 'pointerdown');
  assert.ok(docKey.capture && docPress.capture, 'both run before the note sees the event');

  docPress.fn({ target: m.row('stat-action') });
  assert.equal(m.item.isOpen(), true, 'a press inside keeps it open');
  docPress.fn({ target: m.trigger });
  assert.equal(m.item.isOpen(), true, 'the item toggles on its own click, the press handler leaves it');

  const esc = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  docKey.fn(esc);
  assert.equal(m.item.isOpen(), false);
  assert.ok(esc.defaultPrevented && esc.stopped, 'the Esc is used up: it does not also reach the note');
  assert.equal(m.dom.doc.activeElement, m.trigger, 'focus returns to the item');
  assert.equal(m.pop().classList.contains('hidden'), true);
  assert.equal(m.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(m.dom.docListeners.length, 0, 'the document listeners are removed on close');
  assert.equal(m.dom.winListeners.length, 0, 'and the resize listener');

  m.trigger.click();
  m.dom.doc.activeElement = m.dom.doc.body; // the user clicked into the note
  m.dom.docListeners.find((l) => l.type === 'pointerdown').fn({ target: m.dom.doc.body });
  assert.equal(m.item.isOpen(), false, 'a press elsewhere closes it');
  assert.equal(m.dom.doc.activeElement, m.dom.doc.body, 'and does not pull focus back');

  m.trigger.click();
  m.trigger.click();
  assert.equal(m.item.isOpen(), false, 'the item toggles');
  assert.equal(m.dom.doc.activeElement, m.trigger);
});

check('Tab stays inside (it wraps), arrows move between the switches, focus leaving the popover closes it', () => {
  const m = makeItem();
  m.trigger.click();
  const pop = m.pop();
  const ids = ['stat-autocomplete', 'stat-action', 'stat-action-manual', 'stat-voice-refine', 'btn-status-ai-settings'];
  const focusOrder = () => ids.map((id) => m.row(id));
  // Tab forward through all of them, then wrap
  for (let i = 1; i < ids.length; i++) {
    const ev = pop.dispatch('keydown', { key: 'Tab', shiftKey: false });
    assert.equal(m.dom.doc.activeElement, focusOrder()[i], 'Tab #' + i);
    assert.ok(ev.defaultPrevented);
  }
  pop.dispatch('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(m.dom.doc.activeElement, focusOrder()[0], 'Tab from the last control wraps to the first');
  pop.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(m.dom.doc.activeElement, focusOrder()[ids.length - 1], 'Shift+Tab from the first wraps to the last');
  pop.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(m.dom.doc.activeElement, m.row('stat-voice-refine'));
  pop.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(m.dom.doc.activeElement, m.row('btn-status-ai-settings'));

  // the hidden sub-switch is skipped
  m.row('stat-action').click();
  m.row('stat-action').focus();
  pop.dispatch('keydown', { key: 'Tab', shiftKey: false });
  assert.equal(m.dom.doc.activeElement, m.row('stat-voice-refine'), 'a hidden switch is not in the Tab order');

  // focus moved to something else on the page
  const other = m.dom.makeEl('button');
  pop.dispatch('focusout', { relatedTarget: m.row('stat-action') });
  assert.equal(m.item.isOpen(), true, 'focus moving inside the popover keeps it');
  pop.dispatch('focusout', { relatedTarget: null });
  assert.equal(m.item.isOpen(), true, 'focus going nowhere (the window lost focus) keeps it; the press handler decides');
  pop.dispatch('focusout', { relatedTarget: other });
  assert.equal(m.item.isOpen(), false, 'focus moving to another control closes it');
});

check('"AI settings" in the popover closes it and opens Settings', () => {
  const m = makeItem();
  m.trigger.click();
  m.row('btn-status-ai-settings').click();
  assert.equal(m.item.isOpen(), false);
  assert.deepEqual(m.state.calls, ['openSettings']);
  assert.equal(m.row('btn-status-ai-settings').textContent, 'askErrSettings');
});

check('the last text prediction: busy is a mark, an error changes the label and shows in the popover, ok clears it', () => {
  const m = makeItem();
  m.item.setPredict('busy');
  assert.equal(m.trigger.getAttribute('data-busy'), '1');
  assert.equal(m.trigger.textContent, 'statAiLocal', 'the label does not change while a request is out (the bar does not shift)');
  m.item.setPredict('error', 'dial tcp\n127.0.0.1:11434: connectex');
  assert.equal(m.trigger.textContent, 'statAiError');
  assert.ok(m.trigger.classList.contains('status-ai-error'));
  assert.equal(m.trigger.title, 'statAiTitleError(dial tcp 127.0.0.1:11434: connectex)', 'one line');
  assert.equal(m.trigger.getAttribute('data-busy'), '0');
  m.trigger.click();
  const line = m.pop().children[1].children[4];
  assert.equal(line.classList.contains('hidden'), false, 'the error is explained inside the popover');
  assert.equal(line.textContent, 'aiPopPredictError(dial tcp 127.0.0.1:11434: connectex)');
  m.item.setPredict('ok');
  assert.equal(m.trigger.textContent, 'statAiLocal');
  assert.equal(m.trigger.classList.contains('status-ai-error'), false);
  assert.equal(line.classList.contains('hidden'), true);
});

check('losing the model while the popover is open closes it; a redraw with nothing changed writes nothing', () => {
  const m = makeItem();
  m.trigger.click();
  m.state.configured = false;
  m.item.refresh();
  assert.equal(m.item.isOpen(), false);
  assert.equal(m.trigger.textContent, 'statAiNotSet');

  const n = makeItem();
  const writes = n.trigger.textWrites;
  for (let i = 0; i < 5; i++) n.item.refresh();
  n.item.setPredict('ok');
  assert.equal(n.trigger.textWrites, writes, 'refresh is cheap: no DOM write when nothing changed');
});

check('a page without the item gets an inert controller (older markup, test pages)', () => {
  const dom = makeDom();
  const inert = StatusAI.create({ doc: dom.doc, win: dom.win, t: tKey, getConfig: () => ({}), isConfigured: () => true });
  inert.refresh(); inert.open(); inert.close(); inert.setPredict('error', 'x');
  assert.equal(inert.isOpen(), false);
  StatusAI.refresh(); StatusAI.setPredict('busy'); StatusAI.close(); // the singleton before init
  assert.equal(StatusAI.isOpen(), false);
});

// ---------------------------------------------------------------------------------------------------
// 3. The toggles in app.js: one function each, a toast, aria-pressed, a save
// ---------------------------------------------------------------------------------------------------
function extract(name) {
  const m = app.match(new RegExp('  function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(m, name + ' must exist in app.js');
  return m[0];
}
const attrsOf = () => ({ attrs: {}, style: {}, textContent: '', title: '', setAttribute(k, v) { this.attrs[k] = v; } });

check('Text prediction toggle: toast, forgets the last error, redraws the item, saves', () => {
  const log = [];
  const env = {
    config: { autocomplete: { enabled: true } },
    t: (k) => k,
    setPredictStatus: (s, d) => log.push(['predict', s, d]),
    refreshStatusAI: () => log.push(['refresh']),
    showMessage: (m) => log.push(['toast', m]),
    clearGhostText: () => log.push(['clearGhost']),
    savePersistentConfig: () => log.push(['save'])
  };
  vm.createContext(env);
  vm.runInContext(extract('toggleAutocomplete'), env);
  vm.runInContext('toggleAutocomplete()', env);
  assert.equal(env.config.autocomplete.enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(log)), [['predict', 'ok', null], ['refresh'], ['toast', 'toastPredictionOff'], ['clearGhost'], ['save']]);
  log.length = 0;
  vm.runInContext('toggleAutocomplete()', env);
  assert.equal(env.config.autocomplete.enabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(log)), [['predict', 'ok', null], ['refresh'], ['toast', 'toastPredictionOn'], ['save']]);
});

check('IME toggle (Japanese UI): shown only in Japanese, aria-pressed, toast', () => {
  const statIme = attrsOf();
  const toasts = [];
  const env = {
    statIme,
    config: { general: { language: 'ja', imeGuardian: true } },
    imeGuardianInstance: { reset() { toasts.push('reset'); } },
    t: (k) => k,
    showMessage: (m) => toasts.push(m),
    savePersistentConfig: () => {}
  };
  vm.createContext(env);
  vm.runInContext(extract('renderImeStatus') + '\n' + extract('toggleIME'), env);
  vm.runInContext('renderImeStatus()', env);
  assert.equal(statIme.attrs['aria-pressed'], 'true');
  assert.equal(statIme.style.display, '');
  vm.runInContext('toggleIME()', env);
  assert.equal(env.config.general.imeGuardian, false);
  assert.equal(statIme.attrs['aria-pressed'], 'false');
  assert.equal(statIme.style.opacity, '0.6');
  assert.deepEqual(toasts, ['toastImeOff', 'reset']);
  env.config.general.language = 'en';
  vm.runInContext('renderImeStatus()', env);
  assert.equal(statIme.style.display, 'none', 'hidden in the English UI');
});

check('every status-bar toggle shows a toast with its own words in both languages', () => {
  for (const key of ['toastAutosaveOn', 'toastAutosaveOff', 'toastPredictionOn', 'toastPredictionOff', 'toastSuggestionsOn', 'toastSuggestionsManual', 'toastSuggestionsOff', 'toastImeOn', 'toastImeOff', 'voiceRefineOnToast', 'voiceRefineOffToast', 'encodingSwitched', 'gitSyncTriggeredToast']) {
    for (const lang of ['en', 'ja']) assert.ok(I18N[lang][key], key + ' in ' + lang);
  }
  assert.equal(I18N.en.toastAutosaveOff, 'Autosave: off', 'the wording the review asked for');
  assert.ok(/toggleAutoSave\(\) \{[\s\S]*?showMessage\(t\(config\.general\.autoSave \? 'toastAutosaveOn' : 'toastAutosaveOff'\)/.test(app), 'autosave says what it did');
  assert.ok(/function toggleIME\(\) \{[\s\S]*?showMessage\(t\(config\.general\.imeGuardian \? 'toastImeOn' : 'toastImeOff'\)/.test(app), 'IME says what it did');
  assert.ok(/function toggleVoiceRefine\(\) \{[\s\S]*?showMessage\(t\(config\.voice\.refine\.enabled \? 'voiceRefineOnToast' : 'voiceRefineOffToast'\)/.test(app), 'voice tidy-up says what it did');
  assert.ok(/function toggleEncoding\(\) \{[\s\S]*?showMessage\(t\('encodingSwitched'/.test(app), 'the encoding says what it did');
});

// ---------------------------------------------------------------------------------------------------
// 4. Markup, wiring, CSS, strings
// ---------------------------------------------------------------------------------------------------
check('markup: the whole right side of the bar is real buttons; the on/off ones say aria-pressed; the three old badges are gone', () => {
  const bar = html.slice(html.indexOf('<footer id="status-bar">'), html.indexOf('</footer>'));
  const right = bar.slice(bar.indexOf('class="status-right"'));
  assert.ok(!/<span[^>]*class="clickable-badge/.test(bar), 'no span badge is left in the bar');
  const ids = [...right.matchAll(/<button type="button" id="(stat-[a-z-]+)" class="clickable-badge[^"]*"([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['stat-tasks', 'stat-gitsync', 'stat-ime', 'stat-ai', 'stat-autosave', 'stat-encoding']);
  for (const id of ['stat-autosave', 'stat-ime']) assert.ok(new RegExp('id="' + id + '"[^>]*aria-pressed="(true|false)"').test(right), id + ' has aria-pressed');
  for (const gone of ['stat-voice-refine', 'stat-action', 'stat-autocomplete']) assert.ok(!right.includes('id="' + gone + '"'), gone + ' moved into the popover');
  assert.ok(/id="stat-ai"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/.test(right), 'the AI item announces its popover');
  assert.ok(/id="stat-ai"[^>]*data-a11y-keep/.test(right), 'a11y.js leaves its name alone (it is named by its text)');
  assert.ok(html.indexOf('js/status_ai.js') > html.indexOf('js/llm_error.js') && html.indexOf('js/status_ai.js') < html.indexOf('js/app.js'), 'status_ai.js loads after llm_error.js and before app.js');
  assert.ok(html.indexOf('js/status_ai.js') > html.indexOf('js/a11y.js'), 'and after a11y.js');
});

check('a11y.js does not give a real button a second Enter / Space handler', () => {
  const a11y = read('frontend/js/a11y.js');
  assert.ok(/if \(el\.tagName === 'BUTTON'\) return;/.test(a11y));
});

check('app.js: the AI item is created once, every toggle is the app function, nothing reads the old badges', () => {
  assert.ok(/initStatusAI\(\);/.test(app) && /window\.StatusAI\.init\(\{/.test(app));
  assert.ok(/prediction: toggleAutocomplete,\s*suggestions: toggleSuggestions,\s*suggestionsManual: toggleSuggestionsManual,\s*voice: toggleVoiceRefine,/.test(app));
  assert.ok(/isConfigured: \(\) => isLlmConfigured\(false\),/.test(app), 'the model state reuses isLlmConfigured');
  assert.ok(/openSettings: \(\) => \{\s*openSettings\(\);\s*switchSettingsTab\('model'\);/.test(app), 'Set up opens Settings > AI Models');
  for (const gone of ['statAction', 'statAutocomplete', 'statVoiceRefine', 'renderVoiceRefineStatus', 'cycleActionStatus']) {
    assert.ok(!new RegExp('\\b' + gone + '\\b').test(app), gone + ' is gone from app.js');
  }
  assert.ok(/statAutosave\.setAttribute\('aria-pressed'/.test(app), 'autosave carries aria-pressed');
  assert.ok(/if \(config\.autocomplete\.enabled\) setPredictStatus\('busy'\);/.test(app), 'a pending prediction is reported');
  assert.ok(/setPredictStatus\('error', errMsg\);/.test(app) && /setPredictStatus\('ok'\);/.test(app), 'a failed and a finished prediction are reported');
  assert.ok(!/new StatusAI|StatusAI\.create/.test(app), 'app.js only hands over hooks');
});

check('style.css: 24px buttons with the pill inside, the popover as a panel, the switch as in Settings, Zen keeps the bar visible', () => {
  const block = (sel) => { const at = css.indexOf(sel + ' {'); assert.ok(at >= 0, sel + ' missing'); return css.slice(at, css.indexOf('}', at)); };
  assert.match(block('.clickable-badge'), /height: 24px;/, 'a 24px target');
  assert.match(block('.clickable-badge'), /border: 0;/, 'a reset <button>');
  assert.match(block('.clickable-badge::before'), /inset: 3px;/, 'the pill is drawn inside');
  assert.match(block('.status-ai-pop'), /background: var\(--bg-modal/);
  assert.match(block('.status-ai-pop'), /border-radius: 8px;/);
  assert.match(block('.status-ai-pop'), /box-shadow: var\(--panel-shadow/);
  assert.match(block('.status-ai-label'), /color: var\(--accent-label/, 'the label is bright accent text');
  assert.doesNotMatch(block('.status-ai-label'), /background/, 'never a filled shape');
  assert.match(block('.status-ai-head'), /border-bottom: 1px solid/, 'with a divider');
  assert.match(block('.status-ai-row'), /min-height: 36px;/);
  assert.match(block('.status-ai-track'), /width: 32px;[\s\S]*height: 18px;/);
  assert.match(block('.status-ai-settings'), /height: 28px;/);
  for (const probe of ['#stat-message:not(:empty)', '#stat-llm-indicator:not(.hidden)', '#stat-tasks:not(.hidden)', '#stat-ai[aria-expanded="true"]']) {
    assert.ok(css.includes('body.zen-active #status-bar:has(' + probe + ')'), 'Zen keeps the bar visible: ' + probe);
  }
  assert.ok(css.includes('body.zen-active #status-bar:focus-within'), 'and while the keyboard is on it');
  assert.ok(/prefers-reduced-motion: reduce\)\s*\{\s*\.status-ai-pop \{ animation: none; \}/.test(css), 'no motion when the OS asks for none');
  assert.doesNotMatch(css.slice(css.indexOf('.status-ai-pop {')), /[\u{1F300}-\u{1FAFF}]/u, 'no emoji');
});

check('strings: everything status_ai.js asks for exists in both languages; English has no Japanese; Japanese has no English sentences', () => {
  const keys = new Set();
  for (const m of moduleSrc.matchAll(/\bt\('([A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of moduleSrc.matchAll(/(?:labelKey|titleKey): '([A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of moduleSrc.matchAll(/'(stat(?:Ai)[A-Za-z]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size >= 18, 'found the keys (' + keys.size + ')');
  const CJK = /[぀-ヿ㐀-鿿]/;
  for (const key of keys) {
    for (const lang of ['en', 'ja']) assert.ok(typeof I18N[lang][key] === 'string' && I18N[lang][key], key + ' in ' + lang);
    assert.ok(!CJK.test(I18N.en[key]), key + ' (en) has no Japanese: ' + I18N.en[key]);
    const placeholders = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join();
    assert.equal(placeholders(I18N.ja[key]), placeholders(I18N.en[key]), key + ' has the same placeholders in both languages');
  }
  const all = [...keys, 'toastAutosaveOn', 'toastAutosaveOff', 'toastPredictionOn', 'toastPredictionOff', 'toastSuggestionsOn', 'toastSuggestionsManual', 'toastSuggestionsOff', 'toastImeOn', 'toastImeOff',
    'gitStatusReady', 'gitStatusSyncing', 'gitStatusSynced', 'gitStatusError', 'gitSyncReadyTooltip', 'gitSyncSyncingTooltip', 'gitSyncSyncedTooltip', 'gitSyncErrorTooltip', 'gitSyncTriggeredToast'];
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  // Words that stay in English in a Japanese sentence: product names and key names
  const KEEP = /\b(AI|Git|Tab|Esc|Ctrl|Cmd|Enter|Quick|Actions?)\b|\{[a-z]+\}/g;
  for (const key of all) {
    assert.ok(I18N.en[key] && I18N.ja[key], key + ' in both languages');
    assert.ok(!EMOJI.test(I18N.en[key]) && !EMOJI.test(I18N.ja[key]), key + ' has no emoji');
    if (!/^(en)$/.test('ja')) {
      const left = I18N.ja[key].replace(KEEP, '').match(/[A-Za-z]{3,}/g);
      assert.equal(left, null, key + ' (ja) still has English words: ' + (left || []).join(' '));
    }
  }
  // One plain name per helper, used the same everywhere it is named
  assert.equal(I18N.en.aiOptPrediction, 'Text prediction');
  assert.equal(I18N.en.aiOptSuggestions, 'Suggestions');
  assert.equal(I18N.en.aiOptVoice, 'Voice tidy-up');
  assert.match(I18N.en.sectionAutocomplete, /^Text prediction/, 'Settings uses the same name');
  assert.match(I18N.en.shortcutActionVoiceRefineToggle, /^Voice tidy-up/, 'the shortcut list uses the same name');
  assert.match(I18N.en.sectionAgentSuggestions, /^Suggestions/);
  assert.equal(I18N.ja.aiOptPrediction, '入力予測');
  assert.match(I18N.ja.sectionAutocomplete, /^入力予測/);
  assert.match(I18N.ja.sectionAgentSuggestions, /^提案/);
  assert.match(I18N.ja.shortcutActionVoiceRefineToggle, /^音声の整形/);
  assert.match(I18N.ja.voiceRefineOnToast, /^音声の整形/);
  // The old internal names do not come back in the visible strings of the bar
  for (const key of all) assert.ok(!/\b(Predict|Mic: Refine|Action: )/.test(I18N.en[key]), key + ' uses a plain name');
});

check('the unused strings of the old badges are gone', () => {
  for (const key of ['statAutocompleteOn', 'statAutocompleteOff', 'statPredicting', 'statAutocompleteError', 'statAutocompleteTooltip', 'statVoiceRefineOn', 'statVoiceRefineOff', 'statActionOn', 'statActionOff', 'statActionManual', 'statActionTooltip']) {
    assert.ok(!(key in I18N.en) && !(key in I18N.ja), key + ' was removed');
  }
});

console.log(process.exitCode ? '\nSome status_ai checks failed.' : `\nAll ${passed} status_ai checks passed.`);
