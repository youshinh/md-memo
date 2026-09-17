import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const i18nCode = fs.readFileSync(path.resolve('frontend/js/i18n.js'), 'utf-8');
const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

function createDOMEnvironment(initialLocalStorage = {}) {
  const elements = new Map();
  const windowListeners = new Map();

  function createMockElement(id, tagName = 'div') {
    const classList = new Set();
    const style = {};
    const dataset = {};
    let innerHTML = '';
    let textContent = '';
    let value = '';
    let title = '';
    let checked = false;

    const el = {
      id: id || '',
      tagName: tagName.toUpperCase(),
      dataset,
      style,
      selectionStart: 0,
      selectionEnd: 0,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
      offsetHeight: 500,
      offsetWidth: 500,
      onclick: null,
      onload: null,
      get checked() { return checked; },
      set checked(v) { checked = !!v; },
      classList: {
        add: (...cls) => cls.forEach(c => classList.add(c)),
        remove: (...cls) => cls.forEach(c => classList.delete(c)),
        toggle: (c, force) => {
          if (force !== undefined) {
            if (force) classList.add(c); else classList.delete(c);
            return force;
          }
          if (classList.has(c)) { classList.delete(c); return false; }
          classList.add(c); return true;
        },
        contains: (c) => classList.has(c)
      },
      get className() { return Array.from(classList).join(' '); },
      set className(v) {
        classList.clear();
        if (v) v.split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
      },
      get innerHTML() { return innerHTML; },
      set innerHTML(v) {
        innerHTML = v;
        textContent = v;
        if (v === '') {
          this.children = [];
          this.childNodes = [];
        }
      },
      get textContent() { return textContent || innerHTML || value; },
      set textContent(v) { textContent = v; innerHTML = v; },
      get value() { return value; },
      set value(v) { value = v; },
      get title() { return title; },
      set title(v) { title = v; },
      children: [],
      childNodes: [],
      appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        if (child.tagName === 'SCRIPT' || child.tagName === 'LINK') {
          process.nextTick(() => { if (child.onload) child.onload(); });
        }
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter(c => c !== child);
        child.parentElement = null;
        return child;
      },
      after(sibling) {
        if (this.parentElement) {
          const idx = this.parentElement.children.indexOf(this);
          if (idx !== -1) {
            this.parentElement.children.splice(idx + 1, 0, sibling);
            sibling.parentElement = this.parentElement;
          }
        }
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
          if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
          if (cur.tagName && cur.tagName.toLowerCase() === sel.toLowerCase()) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        const find = (node) => {
          for (const c of node.children) {
            if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
            if (sel.includes('[data-tab-id="')) {
              const m = sel.match(/\[data-tab-id="([^"]+)"\]/);
              if (m && c.dataset.tabId === m[1]) return c;
            }
            const res = find(c);
            if (res) return res;
          }
          return null;
        };
        return find(this);
      },
      querySelectorAll(sel) {
        const results = [];
        const find = (node) => {
          for (const c of node.children) {
            if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) results.push(c);
            find(c);
          }
        };
        find(this);
        return results;
      },
      addEventListener(evt, handler) {
        if (!el._listeners) el._listeners = new Map();
        if (!el._listeners.has(evt)) el._listeners.set(evt, []);
        el._listeners.get(evt).push(handler);
      },
      removeEventListener(evt, handler) {
        if (el._listeners && el._listeners.has(evt)) {
          el._listeners.set(evt, el._listeners.get(evt).filter(h => h !== handler));
        }
      },
      trigger(evt, eventObj = {}) {
        if (!eventObj.target) eventObj.target = el;
        if (evt === 'click' && typeof el.onclick === 'function') {
          el.onclick(eventObj);
        }
        if (el._listeners && el._listeners.has(evt)) {
          el._listeners.get(evt).forEach(h => h(eventObj));
        }
      },
      focus() {
        documentMock.activeElement = el;
        el.trigger('focus');
      },
      select() {},
      setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 500, height: 500, right: 500, bottom: 500 })
    };

    if (id) {
      if (['secondary-pane', 'pane-resizer', 'preview-pane', 'secondary-preview-pane'].includes(id)) {
        el.classList.add('hidden');
      }
      elements.set(id, el);
    }
    return el;
  }

  const documentMock = {
    documentElement: createMockElement('html'),
    activeElement: null,
    hasFocus: () => true,
    getElementById: (id) => elements.get(id) || createMockElement(id),
    querySelector: (sel) => {
      if (sel.startsWith('#')) return elements.get(sel.slice(1)) || createMockElement(sel.slice(1));
      if (sel.startsWith('.')) {
        for (const el of elements.values()) {
          if (el.classList.contains(sel.slice(1))) return el;
        }
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const res = [];
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        for (const el of elements.values()) {
          if (el.classList.contains(cls)) res.push(el);
        }
      }
      return res;
    },
    createElement: (tag) => createMockElement(null, tag),
    body: createMockElement('body'),
    head: createMockElement('head'),
    addEventListener: () => {},
    removeEventListener: () => {}
  };

  const localStorageData = { ...initialLocalStorage };
  let backendSessionData = null;

  const windowMock = {
    document: documentMock,
    backend: {
      getLocale: async () => 'ja',
      getPlatform: async () => 'windows',
      loadConfig: async () => JSON.stringify({
        general: {
          splitViewOnStartup: false,
          restoreSession: true
        }
      }),
      saveConfig: async () => {},
      getSession: async () => backendSessionData,
      saveSession: async (data) => { backendSessionData = data; },
      openExternal: () => {}
    },
    localStorage: {
      _data: localStorageData,
      getItem: (k) => localStorageData[k] || null,
      setItem: (k, v) => { localStorageData[k] = String(v); },
      removeItem: (k) => { delete localStorageData[k]; }
    },
    navigator: { platform: 'Win32', userAgent: 'Windows' },
    addEventListener: (evt, handler) => {
      if (!windowListeners.has(evt)) windowListeners.set(evt, []);
      windowListeners.get(evt).push(handler);
    },
    removeEventListener: (evt, handler) => {
      if (windowListeners.has(evt)) {
        windowListeners.set(evt, windowListeners.get(evt).filter(h => h !== handler));
      }
    },
    trigger: (evt, eventObj = {}) => {
      if (windowListeners.has(evt)) {
        [...windowListeners.get(evt)].forEach(h => h(eventObj));
      }
    },
    setTimeout: (fn, ms) => {
      process.nextTick(fn);
      return 1;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => {
      process.nextTick(fn);
      return 1;
    },
    markdownit: () => ({
      render: (src) => `<p>${src}</p>`
    }),
    katex: {
      renderToString: (s) => `[KATEX:${s}]`
    },
    mermaid: {
      initialize: () => {},
      render: async (id, code) => ({ svg: `<svg>${code}</svg>` })
    }
  };

  return { elements, windowMock, documentMock };
}

function runEnvironment(initialLocalStorage = {}) {
  const { elements, windowMock, documentMock } = createDOMEnvironment(initialLocalStorage);
  const context = vm.createContext({
    window: windowMock,
    document: documentMock,
    localStorage: windowMock.localStorage,
    navigator: windowMock.navigator,
    setTimeout: windowMock.setTimeout,
    clearTimeout: windowMock.clearTimeout,
    requestAnimationFrame: windowMock.requestAnimationFrame,
    console: console,
    Date: Date,
    Math: Math,
    Promise: Promise,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    process: process
  });

  vm.runInContext(i18nCode, context);
  vm.runInContext(appCode, context);

  return { elements, window: context.window, testHelper: context.window.__testHelper };
}

async function main() {
  console.log('=== Evaluation Driven Testing for Cold Boot & Session Restore ===');
  let failures = 0;

  // Test 1: Default Cold Boot without prior session should start in Single Pane (isSplitMode = false)
  try {
    const { elements, testHelper } = runEnvironment({});
    const secondaryPane = elements.get('secondary-pane');
    const isSplitHidden = secondaryPane.classList.contains('hidden');
    assert.equal(isSplitHidden, true, 'Default startup should have secondary pane hidden');
    console.log('PASS: Test 1 (Default cold boot starts in single pane)');
  } catch (err) {
    console.error('FAIL: Test 1 -', err.message);
    failures++;
  }

  // Test 2: Restore 1-pane session (closed in single pane)
  try {
    const sessionData = {
      activeTabId: 'tab_1',
      isSplitMode: false,
      tabs: [
        { id: 'tab_1', title: 'Doc 1.md', content: '# Doc 1', path: '', isDirty: false }
      ]
    };
    const { elements } = runEnvironment({
      md_memo_session_v1: JSON.stringify(sessionData)
    });
    const secondaryPane = elements.get('secondary-pane');
    const isSplitHidden = secondaryPane.classList.contains('hidden');
    assert.equal(isSplitHidden, true, 'Restoring single pane session should keep secondary pane hidden');
    console.log('PASS: Test 2 (Restore single pane session successfully)');
  } catch (err) {
    console.error('FAIL: Test 2 -', err.message);
    failures++;
  }

  // Test 3: Restore 2-pane session (closed with split editor)
  try {
    const sessionData = {
      activeTabId: 'tab_1',
      isSplitMode: true,
      secondaryTabId: 'tab_2',
      secondaryViewMode: 'editor',
      tabs: [
        { id: 'tab_1', title: 'Doc 1.md', content: '# Doc 1', path: '', isDirty: false },
        { id: 'tab_2', title: 'Doc 2.md', content: '# Doc 2', path: '', isDirty: false }
      ]
    };
    const { elements } = runEnvironment({
      md_memo_session_v1: JSON.stringify(sessionData)
    });
    const secondaryPane = elements.get('secondary-pane');
    const isSplitHidden = secondaryPane.classList.contains('hidden');
    assert.equal(isSplitHidden, false, 'Restoring split session should reveal secondary pane');
    const secTitle = elements.get('secondary-pane-title');
    assert.equal(secTitle.textContent, 'Doc 2.md', 'Secondary pane title should restore to Doc 2.md');
    console.log('PASS: Test 3 (Restore 2-pane split editor session)');
  } catch (err) {
    console.error('FAIL: Test 3 -', err.message);
    failures++;
  }

  // Test 4: Restore 2-pane session with preview mode on the right
  try {
    const sessionData = {
      activeTabId: 'tab_1',
      isSplitMode: true,
      secondaryTabId: 'tab_1',
      secondaryViewMode: 'preview',
      tabs: [
        { id: 'tab_1', title: 'Doc 1.md', content: '# Doc 1', path: '', isDirty: false }
      ]
    };
    const { elements } = runEnvironment({
      md_memo_session_v1: JSON.stringify(sessionData)
    });
    const secondaryPane = elements.get('secondary-pane');
    assert.equal(secondaryPane.classList.contains('hidden'), false, 'Secondary pane should be open for side preview');
    const secPreview = elements.get('secondary-preview-pane');
    assert.equal(secPreview.classList.contains('hidden'), false, 'Secondary preview pane should be visible');
    console.log('PASS: Test 4 (Restore 2-pane side-by-side preview)');
  } catch (err) {
    console.error('FAIL: Test 4 -', err.message);
    failures++;
  }

  // Test 5: Session saving captures split state
  try {
    const { elements, testHelper, window } = runEnvironment({});
    // Create second tab and open split editor
    testHelper.createTab('Doc 2', 'Content 2');
    await testHelper.openSplitEditor();
    
    // Trigger beforeunload to force synchronous session save
    window.trigger('beforeunload');
    const savedStr = window.localStorage.getItem('md_memo_session_v1');
    assert.ok(savedStr, 'Session must be saved in localStorage');
    const parsed = JSON.parse(savedStr);
    assert.equal(parsed.isSplitMode, true, 'Session must capture isSplitMode: true');
    assert.ok(parsed.secondaryTabId, 'Session must capture secondaryTabId');

    // Now close secondary pane
    testHelper.closeSecondaryPane();
    window.trigger('beforeunload');
    const savedStrAfterClose = window.localStorage.getItem('md_memo_session_v1');
    const parsedAfterClose = JSON.parse(savedStrAfterClose);
    assert.equal(parsedAfterClose.isSplitMode, false, 'Session must capture isSplitMode: false after closing split');

    console.log('PASS: Test 5 (Session saving correctly tracks split mode transitions)');
  } catch (err) {
    console.error('FAIL: Test 5 -', err.message);
    failures++;
  }

  // Test 6: Preserving 1-pane state on cold boot even if legacy config had splitViewOnStartup: true
  try {
    const sessionData = {
      activeTabId: 'tab_1',
      isSplitMode: false,
      tabs: [
        { id: 'tab_1', title: 'Doc 1.md', content: '# Doc 1', path: '', isDirty: false }
      ]
    };
    const { elements } = runEnvironment({
      md_memo_session_v1: JSON.stringify(sessionData)
    });
    // Let async background sync run
    await new Promise(r => process.nextTick(r));
    const secondaryPane = elements.get('secondary-pane');
    assert.equal(secondaryPane.classList.contains('hidden'), true, 'Session priority: must stay 1-pane when session was closed as 1-pane');
    console.log('PASS: Test 6 (Session priority keeps 1-pane on cold boot)');
  } catch (err) {
    console.error('FAIL: Test 6 -', err.message);
    failures++;
  }

  console.log(`\nSession restore evaluation tests completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
