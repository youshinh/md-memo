// Hermetic tests for the exploration kit (tools/explore): the parts that need no browser.
//   - keyEvents / clipboardAction: what a key name and its modifiers become (kit.mjs)
//   - page_hooks.js run in a vm against a stub DOM: the boot overrides, every LLM mode, the backend faults, the fake clipboard,
//     the toast record and the state snapshot
// Nothing here starts Edge, opens a socket or touches the real clipboard, config or notes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { keyEvents, clipboardAction } from '../tools/explore/kit.mjs';

const queue = [];
const check = (name, fn) => queue.push({ name, fn });
// Values built inside the vm have another realm's prototypes: assert.deepEqual (strict) wants them copied into this one first.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- keys ----------------------------------------------------------------------------------------------
check('keyEvents: a plain character types (keyDown with text), a shortcut does not (rawKeyDown without text)', () => {
  const [down, up] = keyEvents('a');
  assert.deepEqual({ type: down.type, key: down.key, code: down.code, vk: down.windowsVirtualKeyCode, text: down.text, modifiers: down.modifiers }, { type: 'keyDown', key: 'a', code: 'KeyA', vk: 65, text: 'a', modifiers: 0 });
  assert.equal(up.type, 'keyUp');
  const [ctrlL] = keyEvents('l', { ctrl: true });
  assert.deepEqual({ type: ctrlL.type, key: ctrlL.key, code: ctrlL.code, modifiers: ctrlL.modifiers, text: ctrlL.text }, { type: 'rawKeyDown', key: 'l', code: 'KeyL', modifiers: 2, text: undefined });
  const [altMeta] = keyEvents('k', { alt: true, meta: true, shift: true });
  assert.equal(altMeta.modifiers, 1 | 4 | 8);
  assert.equal(altMeta.key, 'K', 'shift makes a letter upper case');
});

check('keyEvents: named keys, aliases, shifted symbols, digits, function keys', () => {
  assert.equal(keyEvents('Enter')[0].text, '\r');
  assert.equal(keyEvents('Return')[0].key, 'Enter');
  assert.equal(keyEvents('Esc')[0].key, 'Escape');
  assert.equal(keyEvents('Escape')[0].type, 'rawKeyDown', 'Escape types nothing');
  assert.equal(keyEvents('Tab')[0].windowsVirtualKeyCode, 9);
  assert.equal(keyEvents('Space')[0].text, ' ');
  assert.equal(keyEvents(' ')[0].code, 'Space');
  assert.equal(keyEvents('Delete')[0].windowsVirtualKeyCode, 46);
  assert.equal(keyEvents('PageDown')[0].windowsVirtualKeyCode, 34);
  assert.equal(keyEvents('ArrowLeft')[0].windowsVirtualKeyCode, 37);
  assert.equal(keyEvents('F5')[0].windowsVirtualKeyCode, 116);
  assert.equal(keyEvents('F12')[0].windowsVirtualKeyCode, 123);
  const bang = keyEvents('!')[0];
  assert.deepEqual({ key: bang.key, code: bang.code, modifiers: bang.modifiers, vk: bang.windowsVirtualKeyCode }, { key: '!', code: 'Digit1', modifiers: 8, vk: 49 }, '"!" is Shift+1');
  const one = keyEvents('1', { shift: true })[0];
  assert.equal(one.key, '!', 'Shift+1 gives the shifted symbol');
  assert.equal(keyEvents('A')[0].modifiers, 8, 'an upper case letter implies Shift');
  assert.equal(keyEvents(',', { ctrl: true })[0].code, 'Comma');
  assert.equal(keyEvents('/')[0].code, 'Slash');
  assert.throws(() => keyEvents('NoSuchKey'), /unsupported key/);
});

check('clipboardAction: Ctrl / Cmd + C X V and Shift+Insert never reach the OS clipboard', () => {
  assert.equal(clipboardAction('v', { ctrl: true }), 'paste');
  assert.equal(clipboardAction('V', { ctrl: true, shift: true }), 'paste');
  assert.equal(clipboardAction('v', { meta: true }), 'paste');
  assert.equal(clipboardAction('c', { ctrl: true }), 'copy');
  assert.equal(clipboardAction('x', { meta: true }), 'cut');
  assert.equal(clipboardAction('Insert', { shift: true }), 'paste');
  assert.equal(clipboardAction('Insert', { ctrl: true }), 'copy');
  assert.equal(clipboardAction('Delete', { shift: true }), 'cut');
  for (const [k, m] of [['v', {}], ['a', { ctrl: true }], ['z', { ctrl: true }], ['v', { ctrl: true, alt: true }], ['Enter', { ctrl: true }]]) {
    assert.equal(clipboardAction(k, m), null, `${k} ${JSON.stringify(m)} is a normal key`);
  }
});

// ---- page_hooks.js in a stub DOM ------------------------------------------------------------------------
const HOOKS = fs.readFileSync(path.resolve('tools/explore/page_hooks.js'), 'utf-8');

function loadHooks(init = {}, dom = {}) {
  const timers = [];
  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const elements = dom.elements || {};
  const sandbox = {
    console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    performance: { now: () => 7 },
    document: {
      getElementById: (id) => elements[id] || null,
      addEventListener() {},
      activeElement: null,
      execCommand: () => true,
      body: {}
    },
    navigator: {},
    MutationObserver,
    Blob, File: globalThis.File, atob,
    window: null
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.getComputedStyle = () => ({ display: 'block' });
  vm.createContext(sandbox);
  vm.runInContext(`window.__EXPLORE_INIT = ${JSON.stringify(init)};\n${HOOKS}`, sandbox);
  return {
    win: sandbox, X: sandbox.__explore, timers, observers,
    // runs the timers in order of their delay (as a clock would)
    runTimers() {
      const due = timers.splice(0).sort((a, b) => a.ms - b.ms);
      due.forEach((t) => t.fn());
      return due.map((t) => t.ms);
    }
  };
}

function withBackend(h, extra = {}) {
  const results = [];
  h.win.__onLLMResult = (id, text, err) => results.push({ id, text, err });
  const calls = [];
  h.win.backend = Object.assign({
    queryLLMAsync: () => { calls.push('llm'); return Promise.resolve(null); },
    queryVisionAsync: () => Promise.resolve(null),
    saveFile: (p) => { calls.push('saveFile ' + p); return Promise.resolve({ path: p, success: true }); },
    saveFileAs: () => Promise.resolve(null)
  }, extra);
  return { results, calls };
}

check('boot data: notes replace the demo tabs, config is deep-merged, both when the page assigns __DOCSHOT_BOOT', () => {
  const h = loadHooks({
    notes: [{ title: 'a.md', content: 'A', path: 'C:\\n\\a.md' }, { content: 'B' }],
    config: { text: { model: 'm2' }, general: { autoSave: false } }
  });
  const boot = { session: { tabs: [{ id: 'old' }], activeTabId: 'old', tabCounter: 9 }, noteFiles: [{ path: 'x' }], config: { text: { baseUrl: 'u', model: 'm' }, general: { autoSave: true, theme: 'olive' } } };
  h.win.__DOCSHOT_BOOT = boot;
  assert.equal(h.win.__DOCSHOT_BOOT, boot, 'the page still reads the same object');
  assert.deepEqual(plain(boot.session.tabs.map((t) => [t.id, t.title, t.path, t.content, t.isDirty])), [['tab_x1', 'a.md', 'C:\\n\\a.md', 'A', false], ['tab_x2', 'note-2.md', '', 'B', false]]);
  assert.equal(boot.session.activeTabId, 'tab_x1');
  assert.equal(boot.session.tabCounter, 3);
  assert.deepEqual(plain(boot.noteFiles.map((n) => n.path)), ['C:\\n\\a.md'], 'only notes with a path can be read back');
  assert.equal(boot.config.text.model, 'm2');
  assert.equal(boot.config.text.baseUrl, 'u', 'untouched keys stay');
  assert.equal(boot.config.general.autoSave, false);
  assert.equal(boot.config.general.theme, 'olive');

  const untouched = loadHooks({});
  const demo = { session: { tabs: [{ id: 'd' }] }, noteFiles: [], config: { a: 1 } };
  untouched.win.__DOCSHOT_BOOT = demo;
  assert.deepEqual(plain(demo.session.tabs), [{ id: 'd' }], 'no notes option: the demo notes stay');
});

check('LLM modes: ok / fail / slow / never / double / think / huge / fenced / empty answer through __onLLMResult', () => {
  const run = (llm, id = 'r1') => {
    const h = loadHooks({ llm });
    const { results } = withBackend(h);
    h.win.backend.queryLLMAsync(id, 'the prompt', JSON.stringify({ model: 'm' }));
    const delays = h.runTimers();
    return { h, results, delays };
  };
  let r = run({ mode: 'ok' });
  assert.deepEqual(plain(r.results), [{ id: 'r1', text: 'Reply 1.', err: '' }]);
  assert.deepEqual(plain(r.delays), [200]);
  assert.deepEqual(plain(r.h.X.llmLog.map((e) => [e.seq, e.kind, e.reqId, e.prompt, e.mode, e.cfg.model])), [[1, 'llm', 'r1', 'the prompt', 'ok', 'm']]);
  assert.equal(r.h.X.llmLog[0].answers.length, 1);

  r = run({ mode: 'ok', reply: 'Answer {n}/{id}', delayMs: 5 });
  assert.equal(r.results[0].text, 'Answer 1/r1');
  assert.deepEqual(plain(r.delays), [5]);

  r = run({ mode: 'fail' });
  assert.equal(r.results[0].text, '');
  assert.match(r.results[0].err, /connectex/, 'the default is an absent Ollama');
  r = run({ mode: 'fail', error: 'APIエラー (401): bad key', delayMs: 3 });
  assert.equal(r.results[0].err, 'APIエラー (401): bad key');

  r = run({ mode: 'slow' });
  assert.deepEqual(plain(r.delays), [5000]);
  assert.equal(r.results[0].text, 'Reply 1.');

  r = run({ mode: 'never' });
  assert.deepEqual(plain(r.delays), []);
  assert.deepEqual(plain(r.results), []);
  assert.equal(r.h.X.llmLog[0].answers.length, 0);

  r = run({ mode: 'double', gapMs: 40 });
  assert.deepEqual(plain(r.results.map((x) => x.text)), ['Reply 1.', 'Second reply 1.']);
  assert.deepEqual(plain(r.delays), [200, 240]);

  r = run({ mode: 'think' });
  assert.match(r.results[0].text, /^<think>[^<]*<\/think>$/, 'only a think block');

  r = run({ mode: 'huge', lines: 500 });
  assert.equal(r.results[0].text.split('\n').length, 500);
  assert.equal(run({ mode: 'huge' }).results[0].text.split('\n').length, 20000);

  r = run({ mode: 'fenced', reply: 'body' });
  assert.equal(r.results[0].text, '```markdown\nbody\n```');

  r = run({ mode: 'empty' });
  assert.deepEqual(plain(r.results), [{ id: 'r1', text: '', err: '' }]);
});

check('setLlm replaces the mode; requests are numbered; a pasted image asks the vision function the same way', () => {
  const h = loadHooks({ llm: { mode: 'fail', error: 'x' } });
  const { results } = withBackend(h);
  h.win.backend.queryLLMAsync('a', 'p1', '{}');
  h.X.setLlm({ mode: 'ok' });
  h.win.backend.queryLLMAsync('b', 'p2', '{}');
  h.win.backend.queryVisionAsync('vision_c', 'describe', 'BASE64', 'image/png', JSON.stringify({ model: 'v' }));
  h.runTimers();
  assert.deepEqual(plain(results.map((x) => [x.id, x.text || x.err])), [['a', 'x'], ['b', 'Reply 2.'], ['vision_c', 'Reply 3.']]);
  assert.deepEqual(plain(h.X.llmLog.map((e) => [e.seq, e.kind, e.mode])), [[1, 'llm', 'fail'], [2, 'llm', 'ok'], [3, 'vision', 'ok']]);
  assert.equal(h.X.llmLog[2].cfg.model, 'v');
  h.X.reset();
  assert.equal(h.X.llmLog.length, 0);
});

check('backend faults: fail / result / never / delay / times, removal with null, read-only paths, the original otherwise', async () => {
  const h = loadHooks({});
  const { calls } = withBackend(h);
  const b = () => h.win.backend;
  assert.deepEqual(await b().saveFile('C:\\a.md'), { path: 'C:\\a.md', success: true }, 'no fault: the original');
  h.X.setBackend({ saveFile: { fail: 'disk full' } });
  await assert.rejects(b().saveFile('C:\\a.md'), /disk full/);
  h.X.setBackend({ saveFile: { fail: 'busy', times: 1 } });
  await assert.rejects(b().saveFile('x'), /busy/);
  assert.equal((await b().saveFile('x')).success, true, 'only the first call fails');
  h.X.setBackend({ saveFileAs: { result: { path: 'C:\\z.md', title: 'z.md', success: true } } });
  assert.equal((await b().saveFileAs()).title, 'z.md');
  h.X.setBackend({ saveFileAs: null, saveFile: null });
  assert.equal(await b().saveFileAs(), null, 'removed: the original again');

  let settled = false;
  h.X.setBackend({ saveFile: { never: true } });
  b().saveFile('q').then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'never settles');
  h.X.setBackend({ saveFile: null });

  h.X.setBackend({ saveFile: { delayMs: 50 } });
  const slow = b().saveFile('slow.md');
  assert.equal(h.timers[h.timers.length - 1].ms, 50);
  h.runTimers();
  assert.equal((await slow).path, 'slow.md');
  h.X.setBackend({ saveFile: null });

  h.X.setBackend({ readOnlyPaths: ['C:\\Users\\demo\\Notes\\', 'D:/x/locked.md'] });
  await assert.rejects(b().saveFile('c:/users/demo/notes/deep/a.md'), /Access is denied/);
  await assert.rejects(b().saveFile('D:\\X\\locked.md'), /Access is denied/);
  assert.equal((await b().saveFile('C:\\Users\\demo\\Notes2\\a.md')).success, true, 'a sibling folder is not below the folder');
  h.X.setBackend({ readOnlyPaths: [] });
  assert.equal((await b().saveFile('c:/users/demo/notes/deep/a.md')).success, true);
  assert.ok(calls.length >= 4);
});

check('the fake clipboard: readText / writeText / setClipboard; nothing reaches a real one', async () => {
  const h = loadHooks({});
  const clip = h.win.navigator.clipboard;
  assert.equal(await clip.readText(), '');
  await clip.writeText('hello');
  assert.equal(await clip.readText(), 'hello');
  assert.deepEqual(plain(h.X.clip), { text: 'hello', html: '', image: '' });
  h.X.setBackend({ clipboard: { text: 'T', html: '<b>T</b>', image: true } });
  assert.equal(h.X.clip.text, 'T');
  assert.equal(h.X.clip.html, '<b>T</b>');
  assert.match(h.X.clip.image, /^data:image\/png;base64,/);
  h.X.setBackend({ clipboard: null });
  assert.deepEqual(plain(h.X.clip), { text: '', html: '', image: '' }, 'null empties it');
});

check('toasts: every non-empty status-bar message is recorded, in order; clearing is not a message', () => {
  const statMessage = { id: 'stat-message', textContent: '' };
  const h = loadHooks({}, { elements: { 'stat-message': statMessage } });
  assert.equal(h.observers.length, 1, 'the observer is on the status message right away');
  h.observers[0].cb([
    { type: 'childList', addedNodes: [{ textContent: 'Saved: a.md' }] },
    { type: 'childList', addedNodes: [] },
    { type: 'characterData', target: { data: 'LLM response inserted' }, addedNodes: [] },
    { type: 'childList', addedNodes: [{ textContent: '' }] }
  ]);
  assert.deepEqual(plain(h.X.toasts.map((t) => t.text)), ['Saved: a.md', 'LLM response inserted']);

  const late = loadHooks({});
  assert.equal(late.observers.length, 1, 'the element is not there yet: a watcher waits for it');
});

check('state(): tabs with their live text, panels, status text, last 20 toasts, pending count from the status-bar indicator', () => {
  const cls = (hidden) => ({ contains: (c) => c === 'hidden' && hidden });
  const el = (o) => Object.assign({ classList: cls(false) }, o);
  const elements = {
    editor: el({ value: 'hello', selectionStart: 1, selectionEnd: 3 }),
    'stat-message': el({ textContent: 'Saved' }),
    'stat-llm-indicator': el({ classList: cls(false) }),
    'stat-llm-text': el({ textContent: 'AI working (2)... (typing enabled)' }),
    'inline-prompt-bar': el({}),
    'cli-filter-bar': el({ classList: cls(true) }),
    'scraps-search-modal': el({}),
    'confirm-modal': el({ classList: cls(true) })
  };
  const h = loadHooks({}, { elements });
  h.win.__mdMemoRPC = {
    getTabs: () => [{ id: 't1', title: 'a.md', path: 'C:\\a.md', isActive: false, isModified: true }, { id: 't2', title: 'b.md', path: '', isActive: true, isModified: false }],
    getBuffer: (id) => { if (id === 't2') throw new Error('gone'); return { content: 'text of ' + id }; }
  };
  for (let i = 1; i <= 25; i++) h.X.toasts.push({ text: 'toast ' + i, at: i });
  const st = h.X.state();
  assert.deepEqual(plain(st.tabs), [
    { id: 't1', title: 'a.md', dirty: true, path: 'C:\\a.md', content: 'text of t1' },
    { id: 't2', title: 'b.md', dirty: false, path: '', content: null }
  ]);
  assert.equal(st.activeTabId, 't2');
  assert.deepEqual(plain(st.editor), { value: 'hello', selectionStart: 1, selectionEnd: 3 });
  assert.deepEqual(plain(st.panels), { ask: true, cli: false, quickActions: false, palette: false, search: true, settings: false, confirm: false, tasks: false });
  assert.equal(st.statusText, 'Saved');
  assert.equal(st.toasts.length, 20);
  assert.equal(st.toasts[19], 'toast 25');
  assert.equal(st.pendingLlm, 2);
  elements['stat-llm-indicator'].classList = cls(true);
  assert.equal(h.X.state().pendingLlm, 0, 'indicator hidden: nothing pending');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}`);
  }
}
if (failed) {
  console.error(`\n${failed} of ${queue.length} exploration kit test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} exploration kit tests passed with 0 error(s)!`);
