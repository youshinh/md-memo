// Regression tests for the panels / input group of the UX review (docs/design/ux-review-2026-09.md): B11 B12 B13 B14 B15 B20.
// Two kinds of test, both hermetic (no browser, no real config, no launches):
//   - pure helpers cut out of app.js (changedSpan, findMarkRects)
//   - the whole of app.js run against a hand-made DOM whose textarea behaves like Chromium's in the two ways these bugs depend on:
//       * `execCommand('insertText')` edits the FOCUSED textarea and can be undone, while assigning `.value` empties the undo history
//       * the focus is one element; `focus()` moves it
// The real-browser counterparts are tests/smoke/61..65 (they need Edge).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appCode = read('frontend/js/app.js');
const i18nCode = read('frontend/js/i18n.js');
const chromeLayoutCode = read('frontend/js/chrome_layout.js');
const mermaidToneCode = read('frontend/js/mermaid_tone.js');
const llmErrorCode = read('frontend/js/llm_error.js');
const htmlCommentsCode = read('frontend/js/html_comments.js');
const commentToggleCode = read('frontend/js/comment_toggle.js');

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

function loadPure(names) {
  const context = vm.createContext({ console });
  vm.runInContext(`${names.map((n) => extractFunction(appCode, n)).join('\n')}\nglobalThis.__h = { ${names.join(', ')} };`, context);
  return context.__h;
}

// ---------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------
check('changedSpan: the stretch between the first and the last difference, so Replace all touches only that much of the note', () => {
  const { changedSpan } = loadPure(['changedSpan']);
  const apply = (text, next) => {
    const s = changedSpan(text, next);
    assert.ok(s.from >= 0 && s.from <= s.oldEnd && s.oldEnd <= text.length, `old range ${JSON.stringify(s)}`);
    assert.ok(s.from <= s.newEnd && s.newEnd <= next.length, `new range ${JSON.stringify(s)}`);
    assert.equal(text.substring(0, s.from) + next.substring(s.from, s.newEnd) + text.substring(s.oldEnd), next, `${JSON.stringify(text)} -> ${JSON.stringify(next)}`);
    return s;
  };
  assert.deepEqual({ ...apply('foo one\nfoo two', 'Q one\nQ two') }, { from: 0, oldEnd: 11, newEnd: 7 }, 'the common " two" at the end is not rewritten');
  assert.deepEqual({ ...apply('aXb', 'aYb') }, { from: 1, oldEnd: 2, newEnd: 2 }, 'one changed character');
  assert.deepEqual({ ...apply('abc', 'abcd') }, { from: 3, oldEnd: 3, newEnd: 4 }, 'text added at the end');
  assert.deepEqual({ ...apply('abcd', 'abc') }, { from: 3, oldEnd: 4, newEnd: 3 }, 'text removed at the end');
  assert.deepEqual({ ...apply('aa', 'aaaa') }, { from: 2, oldEnd: 2, newEnd: 4 }, 'a repeated letter is not double counted');
  assert.deepEqual({ ...apply('aaaa', 'aa') }, { from: 2, oldEnd: 4, newEnd: 2 });
  apply('', 'abc');
  apply('abc', '');
  apply('same', 'same');
  // an emoji that turns into another one shares its first half: the pair must not be cut in two
  const before = 'x😀y';
  const after = 'x😁y';
  const pair = apply(before, after);
  assert.deepEqual([pair.from, pair.oldEnd, pair.newEnd], [1, 3, 3], 'the whole emoji is replaced');
  // random texts: the result always rebuilds the new text
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = ['a', 'b', ' ', '\n', '😀', '😁', 'あ'];
  const word = () => Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]).join('');
  for (let i = 0; i < 400; i++) apply(word(), word());
});

check('findMarkRects: one box for a match on one row; tail, whole rows and head for a wrapped one; an empty last row is left out', () => {
  const { findMarkRects } = loadPure(['findMarkRects']);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(findMarkRects({ top: 12, left: 14 }, { top: 12, left: 38 }, 22.4, 14, 300, 60)), [{ top: 12, left: 14, width: 24, height: 22.4 }]);
  assert.equal(findMarkRects({ top: 12, left: 14 }, { top: 12, left: 14.5 }, 22.4, 14, 300, 60)[0].width, 2, 'never thinner than 2px');
  const wrapped = plain(findMarkRects({ top: 12, left: 200 }, { top: 12 + 22.4 * 2, left: 60 }, 22.4, 14, 300, 60));
  assert.equal(wrapped.length, 3);
  assert.deepEqual(wrapped[0], { top: 12, left: 200, width: 100, height: 22.4 }, 'the first row runs from the match to the right edge');
  assert.deepEqual(wrapped[1], { top: 12 + 22.4, left: 14, width: 286, height: 22.4 }, 'a row in the middle is whole');
  assert.equal(wrapped[2].left, 14);
  assert.equal(wrapped[2].width, 46, 'the last row runs from the left edge to the end of the match');
  const endsAtBreak = plain(findMarkRects({ top: 12, left: 200 }, { top: 12 + 22.4, left: 14 }, 22.4, 14, 300, 60));
  assert.equal(endsAtBreak.length, 1, 'a match that ends exactly at a line break has no box on the empty row after it');
  const long = findMarkRects({ top: 0, left: 14 }, { top: 22.4 * 500, left: 50 }, 22.4, 14, 300, 60);
  assert.equal(long.length, 60, 'a very long match is cut off');
});

// ---------------------------------------------------------------------------------------------------
// app.js against a hand-made DOM
// ---------------------------------------------------------------------------------------------------
const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane'];
const FIND_BAR_IDS = ['find-input', 'replace-input', 'btn-find-next', 'btn-find-prev', 'btn-replace-one', 'btn-replace-all', 'btn-find-close'];

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const listeners = { keydown: [] };
  const messages = [];
  let documentMock = null;

  function mockElement(id, tagName = 'div') {
    const classes = new Set(HIDDEN_AT_START.includes(id) ? ['hidden'] : []);
    const attrs = {};
    let innerHTML = '';
    let textContent = '';
    const isTextarea = tagName === 'textarea';
    let raw = '';
    const el = {
      id, tagName: tagName.toUpperCase(), dataset: {}, style: {}, children: [], checked: false, disabled: false,
      title: '', placeholder: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0, scrollLeft: 0,
      scrollHeight: 1000, clientHeight: 500, offsetHeight: 500, offsetWidth: 500, onclick: null, _listeners: {},
      assignments: 0, undoSteps: [],
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
      addEventListener: (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
      removeEventListener: () => {},
      // As in a browser: moving the focus fires blur on the old element and focus on the new one (the app tracks the working pane by it).
      focus: () => {
        const prev = documentMock.activeElement;
        if (prev === el) return;
        documentMock.activeElement = el;
        if (prev) (prev._listeners.blur || []).forEach((fn) => fn({ target: prev }));
        (el._listeners.focus || []).forEach((fn) => fn({ target: el }));
      },
      blur: () => {},
      scrollIntoView: () => {},
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
      setAttribute: (name, val) => { attrs[name] = val; if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false
    };
    if (isTextarea) {
      // Like Chromium: assigning .value empties the undo history and puts the caret at the end; an editing command keeps the history.
      Object.defineProperty(el, 'value', {
        get: () => raw,
        set: (v) => { raw = String(v); el.undoSteps = []; el.assignments++; el.selectionStart = el.selectionEnd = raw.length; },
        enumerable: true
      });
      el.setRaw = (v) => { raw = String(v); };
    } else {
      el.value = '';
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
    // execCommand('insertText') edits the FOCUSED textarea, as one undoable step, and fires an input event.
    execCommand: (cmd, _, text) => {
      if (cmd !== 'insertText') return false;
      const ed = documentMock.activeElement;
      if (!ed || ed.tagName !== 'TEXTAREA') return false;
      const before = ed.value;
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      ed.undoSteps.push({ value: before, start, end });
      ed.setRaw(before.substring(0, start) + text + before.substring(end));
      ed.selectionStart = ed.selectionEnd = start + text.length;
      (ed._listeners.input || []).forEach((fn) => fn({ target: ed }));
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const backend = Object.assign({
    getConfig: async () => '',
    saveConfig: async () => {},
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    queryLLMAsync: () => {}
  }, opts.backend || {});

  // Short timers fire at once and answer 0 ("nothing pending", as a timer that already fired is): a debounced search then leaves no
  // half-pending timer behind for flushPendingSearch to find.
  const setTimeoutMock = (fn, ms) => {
    if (typeof ms === 'number' && ms >= 10000) return 1;
    fn();
    return 0;
  };

  const windowMock = {
    document: documentMock,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows', language: 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: { addTask: (o) => o, updateTask: () => {} }
  };
  documentMock.defaultView = windowMock;

  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, setInterval: () => 1, clearInterval: () => {},
    requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(chromeLayoutCode, context);
  vm.runInContext(mermaidToneCode, context);
  vm.runInContext(llmErrorCode, context);
  vm.runInContext(htmlCommentsCode, context);
  vm.runInContext(commentToggleCode, context);
  vm.runInContext(appCode, context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  // The find bar's inputs and buttons are inside it (the mock's contains() knows nothing about a tree).
  el('find-replace-bar').contains = (n) => !!n && FIND_BAR_IDS.includes(n.id);

  const env = {
    window: windowMock, messages, el, backend,
    bridge: windowMock.MdMemoBridge,
    config: windowMock.__testHelper.config,
    editor: el('editor'),
    doc: documentMock,
    // An event as the DOM delivers it: the element's own listeners, then (unless stopPropagation was called) the window's.
    press(id, init) {
      let stopped = false;
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; e.propagationStopped = true; } }, init);
      e.target = el(id);
      (el(id)._listeners.keydown || []).forEach((fn) => fn(e));
      if (!stopped) listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    fire(id, evt, init) {
      const e = Object.assign({ key: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      (el(id)._listeners[evt] || []).forEach((fn) => fn(e));
      return e;
    },
    key(init) {
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    hidden: (id) => el(id).classList.contains('hidden'),
    // The note as if the person had typed it: the text, the selection and the focus.
    setNote(text, start, end) {
      env.editor.setRaw(text);
      env.editor.undoSteps = [];
      env.editor.selectionStart = start === undefined ? text.length : start;
      env.editor.selectionEnd = end === undefined ? env.editor.selectionStart : end;
      documentMock.activeElement = env.editor;
    },
    // Ctrl+Z in the focused textarea: false when there is nothing to undo.
    undo() {
      const ed = documentMock.activeElement;
      const step = ed && ed.undoSteps && ed.undoSteps.pop();
      if (!step) return false;
      ed.setRaw(step.value);
      ed.selectionStart = step.start;
      ed.selectionEnd = step.end;
      return true;
    },
    activeId: () => (documentMock.activeElement && documentMock.activeElement.id) || '',
    flush
  };
  return env;
}

const tabKey = (shift) => ({ key: 'Tab', code: 'Tab', shiftKey: !!shift });

// ---- B15 ------------------------------------------------------------------------------------------
check('B15: Tab on several lines is one undo step and does not assign .value (which would empty the undo history)', async () => {
  const env = await createEnv();
  env.setNote('alpha\nbeta\ngamma', 0, 16);
  env.editor.assignments = 0;
  const e = env.fire('editor', 'keydown', tabKey(false));
  assert.equal(e.defaultPrevented, true);
  assert.equal(env.editor.value, '    alpha\n    beta\n    gamma');
  assert.equal(env.editor.assignments, 0, 'the block went in through the editing command');
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [0, 28], 'the indented block stays selected');
  assert.equal(env.undo(), true, 'there is something to undo');
  assert.equal(env.editor.value, 'alpha\nbeta\ngamma', 'one Ctrl+Z takes the whole indent back');
});

check('B15: Shift+Tab on several lines and on a single caret are undoable too, and a blank line keeps its line break', async () => {
  const env = await createEnv();
  env.setNote('    alpha\n\tbeta\n  gamma', 0, 21);
  env.editor.assignments = 0;
  env.fire('editor', 'keydown', tabKey(true));
  assert.equal(env.editor.value, 'alpha\nbeta\ngamma', 'four spaces, a tab, and up to three spaces come off');
  assert.equal(env.editor.assignments, 0);
  assert.equal(env.undo(), true);
  assert.equal(env.editor.value, '    alpha\n\tbeta\n  gamma');

  env.setNote('x\n    y', 7, 7);
  env.fire('editor', 'keydown', tabKey(true));
  assert.equal(env.editor.value, 'x\ny', 'the caret line lost its four spaces');
  assert.equal(env.editor.selectionStart, 3, 'and the caret stays after the y');
  assert.equal(env.editor.assignments, 0);
  assert.equal(env.undo(), true);
  assert.equal(env.editor.value, 'x\n    y');

  // a line of blanks followed by another line: only the blanks of THAT line come off
  env.setNote('x\n  \nz', 4, 4);
  env.fire('editor', 'keydown', tabKey(true));
  assert.equal(env.editor.value, 'x\n\nz', 'the line break after the blanks is still there');
  // nothing to unindent: nothing happens
  env.setNote('plain\ntext', 0, 10);
  env.editor.assignments = 0;
  env.fire('editor', 'keydown', tabKey(true));
  assert.equal(env.editor.value, 'plain\ntext');
  assert.equal(env.editor.undoSteps.length, 0, 'no empty undo step');
});

function startFind(env, note, find, replace, caret) {
  env.setNote(note, caret, caret);
  env.el('find-input').value = find;
  env.el('replace-input').value = replace;
  env.fire('find-input', 'input'); // (the mock runs the debounced search at once)
}

check('B15: Replace and Replace all are one undo step each, keep the undo history, and give the focus back', async () => {
  const one = await createEnv();
  startFind(one, 'foo one\nfoo two', 'foo', 'Q', 0);
  one.el('replace-input').focus();
  one.editor.assignments = 0;
  one.press('replace-input', { key: 'Enter' });
  assert.equal(one.editor.value, 'Q one\nfoo two');
  assert.equal(one.editor.assignments, 0, 'no .value assignment');
  assert.equal(one.activeId(), 'replace-input', 'the focus is back in the Replace box');
  one.editor.focus();
  assert.equal(one.undo(), true);
  assert.equal(one.editor.value, 'foo one\nfoo two', 'one Ctrl+Z per replacement');

  const all = await createEnv();
  startFind(all, 'foo one\nfoo two\nbar', 'foo', 'Q', 0);
  all.el('btn-replace-all').focus();
  all.editor.assignments = 0;
  all.el('btn-replace-all').onclick();
  assert.equal(all.editor.value, 'Q one\nQ two\nbar');
  assert.equal(all.editor.assignments, 0);
  assert.equal(all.activeId(), 'btn-replace-all');
  assert.equal(all.editor.undoSteps.length, 1, 'all the replacements are one step');
  all.editor.focus();
  assert.equal(all.undo(), true);
  assert.equal(all.editor.value, 'foo one\nfoo two\nbar');
  // only the stretch that changes goes through the editor: the note before the first and after the last match is not rewritten
  const big = await createEnv();
  startFind(big, 'a'.repeat(50000) + ' foo ' + 'b'.repeat(50000), 'foo', 'Q', 0);
  big.el('btn-replace-all').onclick();
  assert.equal(big.editor.undoSteps.length, 1);
  assert.equal(big.editor.undoSteps[0].value.length, 100005, 'the step remembers the note as it was');
  assert.equal(big.editor.value, 'a'.repeat(50000) + ' Q ' + 'b'.repeat(50000));
});

// ---- B12 ------------------------------------------------------------------------------------------
check('B12: Replace after the note was edited replaces the match that is there now, not whatever sits at the old offsets', async () => {
  const env = await createEnv();
  startFind(env, 'foo bar foo\nsecond line', 'foo', 'Z', 0);
  assert.equal(env.el('find-count').textContent, '1/2');
  // type XXXX at the start of the note: the search result is out of date (nothing ran a new search)
  env.setNote('XXXXfoo bar foo\nsecond line', 4, 4);
  env.el('replace-input').focus();
  env.press('replace-input', { key: 'Enter' });
  assert.equal(env.editor.value, 'XXXXZ bar foo\nsecond line', 'the first foo became Z and the typed text is intact');
  env.press('replace-input', { key: 'Enter' });
  assert.equal(env.editor.value, 'XXXXZ bar Z\nsecond line', 'Enter again goes on with the next match');
});

check('B12: Next / Previous after an edit go to a real match, not to the stale range', async () => {
  const env = await createEnv();
  startFind(env, 'foo bar foo\nsecond line', 'foo', '', 0);
  env.setNote('XXXXfoo bar foo\nsecond line', 4, 4);
  env.el('find-input').focus();
  env.press('find-input', { key: 'Enter' });
  const at = (ed) => ed.value.substring(ed.selectionStart, ed.selectionEnd);
  assert.equal(at(env.editor), 'foo', 'a match is selected, not the stale [0,3] that now holds XXX');
  assert.equal(env.editor.selectionStart, 4);
  env.press('find-input', { key: 'Enter' });
  assert.equal(env.editor.selectionStart, 12, 'the next one');
  // deleting text shifts the matches the other way
  env.setNote('foo bar foo', 0, 0);
  env.fire('find-input', 'input');
  env.setNote('o bar foo', 0, 0);
  env.press('find-input', { key: 'Enter', shiftKey: true });
  assert.equal(at(env.editor), 'foo');
  assert.equal(env.editor.value.length, 9);
});

check('B12: a list that is still good is left alone, so the match the person navigated to stays current', async () => {
  const env = await createEnv();
  startFind(env, 'foo foo foo', 'foo', 'Z', 0);
  env.el('find-input').focus();
  env.press('find-input', { key: 'Enter' });
  env.press('find-input', { key: 'Enter' });
  assert.equal(env.editor.selectionStart, 4, 'the second foo is current');
  env.el('replace-input').focus();
  env.press('replace-input', { key: 'Enter' });
  assert.equal(env.editor.value, 'foo Z foo', 'Replace replaced the current match, not the first one');
});

// ---- B13 ------------------------------------------------------------------------------------------
check('B13: Enter and Shift+Enter in the Find box move between matches, keep the focus there and leave the note alone', async () => {
  const env = await createEnv();
  startFind(env, 'fox one\nfox two\nfox three', 'fox', '', 0);
  env.el('find-input').focus();
  const before = env.editor.value;
  env.editor.assignments = 0;
  const e1 = env.press('find-input', { key: 'Enter' });
  assert.equal(e1.defaultPrevented, true);
  assert.equal(e1.propagationStopped, true, 'the note\'s line shortcuts never see the key');
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [0, 3]);
  assert.equal(env.activeId(), 'find-input', 'the focus stays in the Find box');
  env.press('find-input', { key: 'Enter' });
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [8, 11]);
  assert.equal(env.activeId(), 'find-input');
  assert.equal(env.editor.value, before, 'a second Enter does not replace the match with a line break');
  env.press('find-input', { key: 'Enter', shiftKey: true });
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [0, 3], 'Shift+Enter goes back');
  assert.equal(env.editor.value, before, 'and adds no blank line');
  assert.equal(env.activeId(), 'find-input');
  assert.equal(env.editor.assignments, 0);
});

check('B13: Shift+Enter that reaches the window handler while the focus is in the Find box is not the note\'s "line below" shortcut', async () => {
  const env = await createEnv();
  startFind(env, 'fox one\nfox two', 'fox', '', 0);
  env.el('find-input').focus();
  const before = env.editor.value;
  env.key({ key: 'Enter', code: 'Enter', shiftKey: true });
  assert.equal(env.editor.value, before, 'the focus is in the box, not in the note: no line is inserted');
});

check('B13: the arrow buttons and F3 from the Find bar keep the focus; F3 from the note puts the focus in the note', async () => {
  const env = await createEnv();
  startFind(env, 'fox one\nfox two\nfox three', 'fox', '', 0);
  env.el('btn-find-next').focus();
  env.el('btn-find-next').onclick();
  assert.equal(env.activeId(), 'btn-find-next', 'the button keeps the focus');
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [0, 3]);
  env.el('btn-find-prev').focus();
  env.el('btn-find-prev').onclick();
  assert.equal(env.activeId(), 'btn-find-prev');
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [16, 19], 'previous wraps to the last');

  env.editor.focus();
  env.key({ key: 'F3', code: 'F3' });
  assert.equal(env.activeId(), 'editor', 'F3 in the note: the note stays the focus (its selection is painted)');
  assert.deepEqual([env.editor.selectionStart, env.editor.selectionEnd], [0, 3]);
  env.doc.activeElement = env.doc.body;
  env.key({ key: 'F3', code: 'F3' });
  assert.equal(env.activeId(), 'editor', 'F3 from nowhere: the note takes the focus');
});

check('B13: Replace keeps the focus in the Replace box, so Enter can go on to the next match', async () => {
  const env = await createEnv();
  startFind(env, 'fox 1 fox 2 fox 3', 'fox', 'cat', 0);
  env.el('replace-input').focus();
  env.press('replace-input', { key: 'Enter' });
  env.press('replace-input', { key: 'Enter' });
  env.press('replace-input', { key: 'Enter' });
  assert.equal(env.editor.value, 'cat 1 cat 2 cat 3', 'three Enters, three replacements, no line break anywhere');
  assert.equal(env.activeId(), 'replace-input');
});

// ---- B14 ------------------------------------------------------------------------------------------
async function splitWithRightPaneInUse() {
  const env = await createEnv();
  env.setNote('alpha line one\nalpha line two\n', 0, 0);
  env.window.__testHelper.createTab('b.md', 'beta line one\nbeta line two\n');
  const rightTab = env.bridge.getActiveTab().id;
  env.window.__testHelper.createTab('c.md', 'gamma\n'); // (the left pane shows this one; the right pane gets b.md below)
  await env.window.__testHelper.openSplitEditor(rightTab); // the split editor is the focused pane now
  const right = env.el('editor-secondary');
  assert.equal(env.window.__testHelper.getActiveEditor(), right);
  right.focus();
  right.setSelectionRange(0, 9);
  return { env, right };
}

check('B14: a palette command acts on the pane that was being worked in, not on the left pane', async () => {
  const { env, right } = await splitWithRightPaneInUse();
  const leftBefore = env.editor.value;
  env.window.__testHelper.openQuickPick();
  env.doc.activeElement = env.el('quick-pick-input'); // (the palette input takes the focus a moment after it opens)
  env.el('quick-pick-input').value = 'Toggle comment';
  env.fire('quick-pick-input', 'input');
  env.fire('quick-pick-input', 'keydown', { key: 'Enter' });
  assert.equal(right.value, '<!-- beta line one -->\nbeta line two\n', 'the right note got the comment');
  assert.equal(env.editor.value, leftBefore, 'the left note is untouched');
  assert.equal(env.activeId(), 'editor-secondary', 'and the right pane is still the working pane');
});

check('B14: closing the palette with Escape leaves the working pane as it was', async () => {
  const { env } = await splitWithRightPaneInUse();
  env.window.__testHelper.openQuickPick();
  env.doc.activeElement = env.el('quick-pick-input');
  env.fire('quick-pick-input', 'keydown', { key: 'Escape' });
  assert.equal(env.activeId(), 'editor-secondary', 'Escape: the right pane is still the one being worked in');
  assert.equal(env.window.__testHelper.getActiveEditor(), env.el('editor-secondary'), 'and it is still the pane commands go to');
});

check('B14: with the left pane in use the palette returns the focus to it', async () => {
  const env = await createEnv();
  env.setNote('left note', 0, 0);
  env.doc.activeElement = env.el('quick-pick-input');
  env.fire('quick-pick-input', 'keydown', { key: 'Escape' });
  assert.equal(env.activeId(), 'editor');
});

// ---- B20 ------------------------------------------------------------------------------------------
async function askRiskyCommand() {
  const runs = [];
  const env = await createEnv({
    backend: {
      validateCliCommand: async () => ({ isBlocked: false, isWarning: true, reason: 'deletes files' }),
      runCommandFilterAsync: (reqID, cmd, input) => { runs.push({ reqID, cmd, input }); }
    }
  });
  env.setNote('hello', 5, 5);
  env.key({ key: 'e', code: 'KeyE', ctrlKey: true });
  env.el('cli-filter-input').value = 'del /q *.tmp';
  env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.hidden('confirm-modal'), false, 'the question is up');
  return { env, runs };
}

check('B20: the dangerous-command question defaults to Cancel and keeps the line breaks of the reason', async () => {
  const { env, runs } = await askRiskyCommand();
  assert.equal(env.activeId(), 'confirm-modal-cancel', 'Cancel has the focus');
  assert.equal(env.el('confirm-modal-message').style.whiteSpace, 'pre-line', 'the reason keeps its line breaks');
  assert.equal(env.el('confirm-modal-ok').textContent, I18N.en.agentRiskRun, 'the confirming button says what it does');
  assert.match(env.el('confirm-modal-message').textContent, /deletes files/);

  env.key({ key: 'Enter', repeat: true });
  env.key({ key: 'Enter', repeat: true });
  assert.equal(env.hidden('confirm-modal'), false, 'a repeated Enter (a key held down) does not answer');
  env.key({ key: 'Enter', ctrlKey: true });
  assert.equal(env.hidden('confirm-modal'), false, 'Ctrl+Enter does not answer either');
  assert.equal(runs.length, 0);

  env.key({ key: 'Enter' });
  await env.flush();
  assert.equal(env.hidden('confirm-modal'), true, 'Enter with Cancel focused closes the question');
  assert.equal(runs.length, 0, 'and the command did not run');
  assert.ok(env.messages.includes(I18N.en.cliCancelled), 'it says so');
});

check('B20: the command runs only when OK has the focus (or is clicked) and Enter is pressed', async () => {
  const { env, runs } = await askRiskyCommand();
  env.el('confirm-modal-ok').focus();
  env.key({ key: 'Enter' });
  await env.flush();
  assert.equal(env.hidden('confirm-modal'), true);
  assert.equal(runs.length, 1, 'ran once');
  assert.equal(runs[0].cmd, 'del /q *.tmp');

  const clicked = await askRiskyCommand();
  clicked.env.el('confirm-modal-ok').onclick();
  await clicked.env.flush();
  assert.equal(clicked.runs.length, 1, 'clicking OK runs it');

  const escaped = await askRiskyCommand();
  escaped.env.key({ key: 'Escape' });
  await escaped.env.flush();
  assert.equal(escaped.runs.length, 0, 'Escape cancels');
});

check('B20: the command-task gate (confirmCommand, used by [[ $ command ]]) asks the same safe question', async () => {
  const env = await createEnv({ backend: { validateCliCommand: async () => ({ isBlocked: false, isWarning: true, reason: 'formats a disk' }) } });
  env.setNote('x', 1, 1);
  const answer = env.bridge.confirmCommand('format c:');
  await env.flush();
  assert.equal(env.hidden('confirm-modal'), false);
  assert.equal(env.activeId(), 'confirm-modal-cancel');
  assert.equal(env.el('confirm-modal-message').style.whiteSpace, 'pre-line');
  env.key({ key: 'Enter', repeat: true });
  assert.equal(env.hidden('confirm-modal'), false);
  env.key({ key: 'Enter' });
  assert.equal(await answer, false, 'Enter on Cancel refuses the command');
});

check('B20: the two other default-mode confirmations are unchanged (the shortcut overwrite question still answers OK on Enter)', () => {
  // customConfirm without options keeps its old behaviour; only the two dangerous-command sites opt in.
  const sites = appCode.match(/customConfirm\(t\('cliWarningConfirm'[^\n]*\n/g) || [];
  assert.equal(sites.length, 2, 'the two dangerous-command call sites');
  for (const site of sites) assert.match(site, /safeDefault: true/);
  assert.match(appCode, /customConfirm\(t\('shortcutOverwriteConfirm', \{ action: conflictLabel \}\)\)/, 'the shortcut question is as it was');
});

// ---- B11 ------------------------------------------------------------------------------------------
async function runCommandThenSwitch(configure) {
  const runs = [];
  const env = await createEnv({
    backend: {
      validateCliCommand: async () => ({ isBlocked: false }),
      runCommandFilterAsync: (reqID, cmd, input) => { runs.push({ reqID, cmd, input }); }
    }
  });
  configure(env.config);
  const A = 'zeta\nalpha\nmike\nyankee\nbravo\n';
  const B = 'B-line-1\nB-line-2\nB-line-3\nB-line-4\nB-line-5\nB-line-6\n';
  env.setNote(A, 5, 22);
  const tabA = env.bridge.getTabIdForEditor(env.editor);
  env.key({ key: 'e', code: 'KeyE', ctrlKey: true });
  env.el('cli-filter-input').value = 'sort';
  env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].input, 'alpha\nmike\nyankee');
  env.window.__testHelper.createTab('b.md', B); // the person opens another note while the command runs
  const tabB = env.bridge.getTabIdForEditor(env.editor);
  assert.notEqual(tabA, tabB);
  env.window.__onCliFilterResult(runs[0].reqID, { output: 'alpha\nmike\nyankee\nSORTED-EXTRA\n', error: '', exitCode: 0 }, '');
  await env.flush();
  return { env, A, B, tabA, tabB };
}

check('B11: a command-bar result is not spliced into the note that is on screen when it arrives (result tab setting on)', async () => {
  const { env, A, B, tabA, tabB } = await runCommandThenSwitch((cfg) => { cfg.cli.openResultInNewTab = true; });
  assert.equal(env.bridge.getTabText(tabA), A, 'the note it was run on is as it was');
  assert.equal(env.bridge.getTabText(tabB), B, 'the note that was on screen is as it was');
  assert.ok(env.messages.includes(I18N.en.cliNoteLeft), 'and a message says what happened');
});

check('B11: the same with the setting that keeps the output out of a result tab: the output is not lost, it opens one', async () => {
  const { env, A, B, tabA, tabB } = await runCommandThenSwitch((cfg) => { cfg.cli.openResultInNewTab = false; });
  assert.equal(env.bridge.getTabText(tabA), A);
  assert.equal(env.bridge.getTabText(tabB), B);
  assert.ok(env.messages.includes(I18N.en.cliNoteLeft));
  assert.match(env.editor.value, /SORTED-EXTRA/, 'the result note holds the output, so a slow command is never wasted');
});


// ---- C10-20 / C7-13 / C7-14 / C10-14 --------------------------------------------------------------
async function commandBarWith(backend, language) {
  const runs = [];
  const validated = [];
  const env = await createEnv({
    backend: Object.assign({
      runCommandFilterAsync: (reqID, cmd, input) => { runs.push({ reqID, cmd, input }); }
    }, backend)
  });
  if (language) env.config.general.language = language;
  env.setNote('hello', 5, 5);
  env.key({ key: 'e', code: 'KeyE', ctrlKey: true });
  env.el('cli-filter-input').value = 'del /q *.tmp';
  return { env, runs, validated };
}
const pressEnter = (env) => env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 13 });
const badgeText = (env) => env.el('cli-filter-badge').textContent;

check('C10-20: a safety check that fails (or says nothing) does not let the command run unchecked: it is asked about like a risky one', async () => {
  for (const [label, validateCliCommand] of [
    ['rejected', async () => { throw new Error('ipc glitch'); }],
    ['empty answer', async () => undefined]
  ]) {
    const { env, runs } = await commandBarWith({ validateCliCommand });
    pressEnter(env);
    await env.flush();
    assert.equal(env.hidden('confirm-modal'), false, label + ': the question is up');
    assert.equal(env.activeId(), 'confirm-modal-cancel', label + ': Cancel has the focus');
    assert.ok(env.el('confirm-modal-message').textContent.includes(I18N.en.cliCheckFailed), label + ': it says the check could not be completed');
    assert.ok(env.el('confirm-modal-message').textContent.includes('del /q *.tmp'), label + ': and shows the command');
    assert.equal(runs.length, 0, label + ': nothing ran');

    env.key({ key: 'Enter' });
    await env.flush();
    assert.equal(runs.length, 0, label + ': Enter on Cancel refuses');
    assert.equal(env.el('cli-filter-input').disabled, false, label + ': and the bar can be used again');
    assert.equal(badgeText(env), I18N.en.cliFilterBadge, label + ': it is not left on "running"');

    pressEnter(env);
    await env.flush();
    env.el('confirm-modal-ok').onclick();
    await env.flush();
    assert.equal(runs.length, 1, label + ': a deliberate OK still runs it');
  }
});

check('C7-13: the command-task gate (confirmCommand, [[ $ command ]]) fails closed too', async () => {
  const env = await createEnv({ backend: { validateCliCommand: async () => { throw new Error('ipc glitch'); } } });
  env.setNote('x', 1, 1);
  const answer = env.bridge.confirmCommand('rm old.txt');
  await env.flush();
  assert.equal(env.hidden('confirm-modal'), false, 'it asks instead of letting the command through');
  assert.ok(env.el('confirm-modal-message').textContent.includes(I18N.en.cliCheckFailed));
  env.key({ key: 'Enter' }); // Cancel has the focus
  assert.equal(await answer, false);

  const ok = await createEnv({ backend: { validateCliCommand: async () => ({ isBlocked: false, isWarning: false }) } });
  ok.setNote('x', 1, 1);
  assert.equal(await ok.bridge.confirmCommand('sort'), true, 'a clean verdict still passes without a question');
  assert.equal(ok.hidden('confirm-modal'), true);
});

check('C10-20: Enter pressed again while the check is still out starts the command once, not once per press', async () => {
  let release;
  const verdict = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const { env, runs } = await commandBarWith({ validateCliCommand: () => { checks++; return verdict; } });
  env.el('cli-filter-input').value = 'sort';
  pressEnter(env);
  pressEnter(env);
  env.el('btn-cli-filter-send').onclick();
  pressEnter(env);
  assert.equal(checks, 1, 'the check was asked for once');
  assert.ok(badgeText(env).endsWith(I18N.en.cliRunningShort), 'the bar shows it is busy');
  release({ isBlocked: false, isWarning: false });
  await env.flush();
  assert.equal(runs.length, 1, 'one run');
  assert.equal(runs[0].cmd, 'sort');
});

check('C7-14: the BLOCKED badge is in the UI language and goes away as soon as the command is edited', async () => {
  for (const [language, dict] of [['en', I18N.en], ['ja', I18N.ja]]) {
    const { env, runs } = await commandBarWith({ validateCliCommand: async () => ({ isBlocked: true, reason: 'formats the disk' }) }, language);
    env.el('cli-filter-input').value = 'mkfs /dev/sda';
    pressEnter(env);
    await env.flush();
    assert.equal(badgeText(env), dict.cliBadgeBlocked, language + ': the badge says so in the UI language');
    assert.equal(runs.length, 0);
    assert.equal(env.el('cli-filter-input').disabled, false);

    env.el('cli-filter-input').value = 'sort';
    env.fire('cli-filter-input', 'input');
    assert.equal(badgeText(env), dict.cliFilterBadge, language + ': editing the command takes the verdict away');
  }
  const { env } = await commandBarWith({ validateCliCommand: async () => ({ isBlocked: true, reason: 'x' }) });
  assert.equal(env.el('btn-cli-filter-send').title, I18N.en.tipRunEnter, 'the run button tooltip comes from the tables');
});

check('C7-14: a failed run shows ERROR in the UI language, and editing the command clears it', async () => {
  const { env } = await commandBarWith({ validateCliCommand: async () => ({ isBlocked: false }) }, 'ja');
  env.config.cli.openErrorInNewTab = false;
  pressEnter(env);
  await env.flush();
  const run = env.window.__cliCallbacks;
  const reqID = Array.from(run.keys())[0];
  env.window.__onCliFilterResult(reqID, { output: '', error: 'boom', exitCode: 1 }, '');
  await env.flush();
  assert.equal(badgeText(env), I18N.ja.cliBadgeError);
  env.el('cli-filter-input').value = 'sort';
  env.fire('cli-filter-input', 'input');
  assert.equal(badgeText(env), I18N.ja.cliFilterBadge);
});

check('C10-14: the command-bar AI sends the text model\'s key only to the text model\'s host', async () => {
  const sent = [];
  const make = async (cli) => {
    const env = await createEnv({ backend: { generateCliCommandAsync: (reqID, prompt, cfgJson) => { sent.push(JSON.parse(cfgJson)); } } });
    env.config.text.baseUrl = 'https://api.openai.com/v1';
    env.config.text.apiKey = 'OPENAIKEY';
    Object.assign(env.config.cli, cli);
    env.setNote('hello', 5, 5);
    env.key({ key: 'e', code: 'KeyE', ctrlKey: true });
    env.fire('cli-filter-input', 'keydown', { key: 'Tab' }); // AI mode
    env.el('cli-filter-input').value = 'list the files';
    pressEnter(env);
    await env.flush();
    return sent[sent.length - 1];
  };
  const other = await make({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' });
  assert.equal(other.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(other.apiKey, '', 'the OpenAI key is not sent to OpenRouter');
  const same = await make({ baseUrl: '', apiKey: '' });
  assert.equal(same.baseUrl, 'https://api.openai.com/v1', 'no address of its own: the text model\'s');
  assert.equal(same.apiKey, 'OPENAIKEY', 'and so its key follows');
  const sameHost = await make({ baseUrl: 'https://API.openai.com/v1/', apiKey: '' });
  assert.equal(sameHost.apiKey, 'OPENAIKEY', 'the same host written another way');
  const own = await make({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'ORKEY' });
  assert.equal(own.apiKey, 'ORKEY', 'its own key is always used');
});

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
  console.error(`\n${failed} of ${queue.length} panels / input regression test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length} panels / input regression tests passed with 0 error(s)!`);
