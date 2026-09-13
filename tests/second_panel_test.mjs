import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const i18nCode = fs.readFileSync(path.resolve('frontend/js/i18n.js'), 'utf-8');
const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');

function createDOMEnvironment() {
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

    if (id) elements.set(id, el);
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

  const windowMock = {
    document: documentMock,
    backend: {
      getLocale: async () => 'en',
      getPlatform: async () => 'windows',
      loadConfig: async () => '{}',
      saveConfig: async () => {},
      loadSession: async () => '{}',
      saveSession: async () => {},
      openExternal: () => {}
    },
    localStorage: {
      _data: {},
      getItem: (k) => windowMock.localStorage._data[k] || null,
      setItem: (k, v) => { windowMock.localStorage._data[k] = String(v); },
      removeItem: (k) => { delete windowMock.localStorage._data[k]; }
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

function runEnvironment() {
  const { elements, windowMock, documentMock } = createDOMEnvironment();
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

function clickTabItem(window, tabItem) {
  tabItem.trigger('pointerdown', { button: 0, clientX: 10, clientY: 10, target: tabItem });
  window.trigger('pointerup', { button: 0, clientX: 10, clientY: 10, target: tabItem });
}

async function main() {
  console.log('=== Evaluation Driven Testing for Second Panel ===');
  let failures = 0;

  // Test 1: Secondary pane preview switch before renderer libs loaded
  try {
    const { elements, testHelper } = runEnvironment();
    await testHelper.openSplitEditor();
    const btnSecondaryMode = elements.get('btn-secondary-mode');
    
    const secEditor = elements.get('editor-secondary');
    secEditor.value = '# Hello World\nSome preview test';

    btnSecondaryMode.trigger('click');
    const previewPane = elements.get('secondary-preview-pane');
    if (previewPane.innerHTML.startsWith('<pre>')) {
      throw new Error('Preview pane rendered raw <pre> tag because renderer libraries were not loaded');
    }
    console.log('PASS: Test 1 (Secondary pane preview rendering)');
  } catch (err) {
    console.error('FAIL: Test 1 -', err.message);
    failures++;
  }

  // Test 2: Side preview tab sync when active tab changes
  try {
    const { elements, testHelper, window } = runEnvironment();
    const editor = elements.get('editor');
    editor.value = '# Document Alpha\nBody of Doc Alpha';
    editor.trigger('input');

    const btnNewTab = elements.get('btn-new-tab');
    btnNewTab.trigger('click');
    editor.value = '# Document Beta\nBody of Doc Beta';
    editor.trigger('input');

    await testHelper.openPreviewToSide();
    const titleEl = elements.get('secondary-pane-title');
    assert.equal(titleEl.textContent, 'Document Beta.md');

    // Switch primary editor to Tab 1 (Document Alpha)
    const tabsList = elements.get('tabs-list');
    const tab1Item = tabsList.children[0];
    clickTabItem(window, tab1Item);

    assert.equal(titleEl.textContent, 'Document Alpha.md', 'Side preview should follow active tab');
    console.log('PASS: Test 2 (Side preview tab sync)');
  } catch (err) {
    console.error('FAIL: Test 2 -', err.message);
    failures++;
  }

  // Test 3: Select tab in secondary pane when tab is already open in primary
  try {
    const { elements, testHelper, window } = runEnvironment();
    const editor = elements.get('editor');
    editor.value = '# Tab Alpha\nContent Alpha';
    editor.trigger('input');

    const btnNewTab = elements.get('btn-new-tab');
    btnNewTab.trigger('click');
    editor.value = '# Tab Beta\nContent Beta';
    editor.trigger('input');

    // Primary has Tab Beta, now open Tab Beta in secondary
    const tabsList = elements.get('tabs-list');
    const tab1Id = tabsList.children[0].dataset.tabId;
    const tab2Id = tabsList.children[1].dataset.tabId;

    // Open Tab Beta on right explicitly
    await testHelper.openSplitEditor(tab2Id);
    const titleEl = elements.get('secondary-pane-title');
    assert.equal(titleEl.textContent, 'Tab Beta.md');

    // Now click Tab Alpha while secondary pane is active: secondary pane should switch to Tab Alpha!
    const tab1Item = tabsList.children[0];
    clickTabItem(window, tab1Item);

    assert.equal(titleEl.textContent, 'Tab Alpha.md', 'Secondary pane should now show Tab Alpha');
    console.log('PASS: Test 3 (Secondary pane tab selection)');
  } catch (err) {
    console.error('FAIL: Test 3 -', err.message);
    failures++;
  }

  // Test 4: Select tab in primary pane when tab is open in secondary
  try {
    const { elements, testHelper, window } = runEnvironment();
    const editor = elements.get('editor');
    editor.value = '# Tab Alpha\nContent Alpha';
    editor.trigger('input');

    const btnNewTab = elements.get('btn-new-tab');
    btnNewTab.trigger('click');
    editor.value = '# Tab Beta\nContent Beta';
    editor.trigger('input');

    const tabsList = elements.get('tabs-list');
    const tab2Id = tabsList.children[1].dataset.tabId;

    // Open Tab Beta on secondary
    await testHelper.openSplitEditor(tab2Id);

    // Switch focus back to primary editor
    editor.focus();

    // Now click Tab Beta in tab bar: primary pane should switch to Tab Beta!
    const tab2Item = tabsList.children[1];
    clickTabItem(window, tab2Item);

    assert.equal(editor.value, '# Tab Beta\nContent Beta', 'Primary pane should switch to Tab Beta');
    console.log('PASS: Test 4 (Primary pane tab selection)');
  } catch (err) {
    console.error('FAIL: Test 4 -', err.message);
    failures++;
  }

  // Test 5: Auto-title updating in secondary pane (Zero-Taxonomy)
  try {
    const { elements, testHelper } = runEnvironment();
    await testHelper.openSplitEditor();

    const secEditor = elements.get('editor-secondary');
    secEditor.value = '# Project Meeting Notes\nDiscussion about split panel';
    secEditor.trigger('input');

    const titleEl = elements.get('secondary-pane-title');
    assert.equal(titleEl.textContent, 'Project Meeting Notes.md');
    console.log('PASS: Test 5 (Zero-Taxonomy in secondary pane)');
  } catch (err) {
    console.error('FAIL: Test 5 -', err.message);
    failures++;
  }

  // Test 6: Click on secondary header switches active pane
  try {
    const { elements, testHelper } = runEnvironment();
    await testHelper.openSplitEditor();

    // Set focus to primary
    elements.get('editor').focus();
    assert.equal(elements.get('secondary-pane').classList.contains('pane-focused'), false);

    // Click secondary header
    const secHeader = elements.get('secondary-pane-header');
    secHeader.trigger('click', { target: secHeader });

    const isFocused = elements.get('secondary-pane').classList.contains('pane-focused');
    assert.equal(isFocused, true);
    console.log('PASS: Test 6 (Header click switches focus)');
  } catch (err) {
    console.error('FAIL: Test 6 -', err.message);
    failures++;
  }

  // Test 7: New Tab creation while secondary pane is active opens in secondary
  try {
    const { elements, testHelper } = runEnvironment();
    // Tab 1 (Alpha)
    const editor = elements.get('editor');
    editor.value = '# Original Doc\nContent';
    editor.trigger('input');

    await testHelper.openSplitEditor();
    const titleBefore = elements.get('secondary-pane-title').textContent;
    assert.equal(titleBefore, 'Original Doc.md');

    // Active pane is secondary. Now click new tab!
    const btnNewTab = elements.get('btn-new-tab');
    btnNewTab.trigger('click');

    const titleAfter = elements.get('secondary-pane-title').textContent;
    const isSecFocused = elements.get('secondary-pane').classList.contains('pane-focused');
    assert.equal(isSecFocused, true);
    assert.notEqual(titleBefore, titleAfter);
    console.log('PASS: Test 7 (New tab in active secondary pane)');
  } catch (err) {
    console.error('FAIL: Test 7 -', err.message);
    failures++;
  }

  // Test 8: Bidirectional editing sync when same note is open in both panes
  try {
    const { elements, testHelper } = runEnvironment();
    const editor = elements.get('editor');
    editor.value = '# Note Alpha\nInitial text';
    editor.trigger('input');

    // Open same note in secondary pane
    await testHelper.openSplitEditor();
    const secEditor = elements.get('editor-secondary');
    assert.equal(secEditor.value, '# Note Alpha\nInitial text');

    // Type in secondary editor
    secEditor.value = '# Note Alpha\nUpdated from secondary';
    secEditor.trigger('input');

    // Primary editor must be synced
    assert.equal(editor.value, '# Note Alpha\nUpdated from secondary', 'Primary editor should sync from secondary editor');

    // Type in primary editor
    editor.value = '# Note Alpha\nUpdated from primary';
    editor.trigger('input');

    // Secondary editor must be synced
    assert.equal(secEditor.value, '# Note Alpha\nUpdated from primary', 'Secondary editor should sync from primary editor');

    console.log('PASS: Test 8 (Bidirectional sync between panes for same note)');
  } catch (err) {
    console.error('FAIL: Test 8 -', err.message);
    failures++;
  }

  console.log(`\nAll evaluation tests completed with ${failures} failure(s).`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
