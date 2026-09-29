// Unit tests for tab_overflow.js (tab strip overflow: fixed "+" and All tabs button, edge fade, reveal, the tab list).
const assert = require('assert');

const TO = require('./tab_overflow.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS: ' + name);
}

// ---- pure helpers ----------------------------------------------------------------------------------
check('measure: tabs that fit are not overflowing, whatever the 1px rounding', () => {
  assert.deepStrictEqual(TO.measure({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }), { overflowing: false, canScrollLeft: false, canScrollRight: false });
  assert.strictEqual(TO.measure({ scrollLeft: 0, clientWidth: 600, scrollWidth: 601 }).overflowing, false, '1px is rounding, not overflow');
  assert.strictEqual(TO.measure({ scrollLeft: 0, clientWidth: 600, scrollWidth: 603 }).overflowing, true);
});

check('measure: which edges have more tabs behind them', () => {
  const view = { clientWidth: 500, scrollWidth: 1800 };
  assert.deepStrictEqual(TO.measure({ ...view, scrollLeft: 0 }), { overflowing: true, canScrollLeft: false, canScrollRight: true });
  assert.deepStrictEqual(TO.measure({ ...view, scrollLeft: 600 }), { overflowing: true, canScrollLeft: true, canScrollRight: true });
  assert.deepStrictEqual(TO.measure({ ...view, scrollLeft: 1300 }), { overflowing: true, canScrollLeft: true, canScrollRight: false });
  assert.strictEqual(TO.measure({ ...view, scrollLeft: 1299.5 }).canScrollRight, false, 'sub-pixel scroll positions count as the end');
});

check('scrollTargetFor: a tab already in view leaves the scroll where it is', () => {
  const view = { scrollLeft: 400, clientWidth: 500, scrollWidth: 1800 };
  assert.strictEqual(TO.scrollTargetFor(view, { left: 500, width: 150 }), 400);
});

check('scrollTargetFor: a tab off the right edge is brought in with the next tab peeking', () => {
  const view = { scrollLeft: 0, clientWidth: 500, scrollWidth: 1800 };
  // tab 900..1050: its right edge + 32px peek ends at 1082, so the view starts at 582
  assert.strictEqual(TO.scrollTargetFor(view, { left: 900, width: 150 }), 1082 - 500);
});

check('scrollTargetFor: a tab off the left edge is brought in with the previous tab peeking', () => {
  const view = { scrollLeft: 1000, clientWidth: 500, scrollWidth: 1800 };
  assert.strictEqual(TO.scrollTargetFor(view, { left: 300, width: 150 }), 300 - 32);
});

check('scrollTargetFor: a tab near the edge of the fade zone counts as out of view', () => {
  const view = { scrollLeft: 400, clientWidth: 500, scrollWidth: 1800 };
  assert.strictEqual(TO.scrollTargetFor(view, { left: 410, width: 150 }), 410 - 32, 'it would sit under the left fade');
});

check('scrollTargetFor: never scrolls past either end, and nothing scrolls when nothing overflows', () => {
  assert.strictEqual(TO.scrollTargetFor({ scrollLeft: 700, clientWidth: 500, scrollWidth: 1800 }, { left: 10, width: 150 }), 0);
  assert.strictEqual(TO.scrollTargetFor({ scrollLeft: 0, clientWidth: 500, scrollWidth: 1800 }, { left: 1700, width: 100 }), 1300);
  assert.strictEqual(TO.scrollTargetFor({ scrollLeft: 30, clientWidth: 900, scrollWidth: 900 }, { left: 10, width: 150 }), 0);
});

check('scrollTargetFor: a tab wider than the strip shows its start', () => {
  assert.strictEqual(TO.scrollTargetFor({ scrollLeft: 0, clientWidth: 100, scrollWidth: 1000 }, { left: 500, width: 180 }), 468);
});

check('rowsFor: keeps the order, marks the open tab and the unsaved ones, survives missing fields', () => {
  const rows = TO.rowsFor([{ id: 'a', title: 'one.md', isDirty: true, path: 'C:\\n\\one.md' }, { id: 'b', title: 'two.md' }, { id: 'c' }], 'b');
  assert.deepStrictEqual(rows.map((r) => [r.id, r.index, r.title, r.dirty, r.active]), [
    ['a', 0, 'one.md', true, false], ['b', 1, 'two.md', false, true], ['c', 2, '', false, false]
  ]);
  assert.strictEqual(rows[0].path, 'C:\\n\\one.md');
  assert.deepStrictEqual(TO.rowsFor(null, 'a'), []);
});

check('stepIndex: arrow keys wrap around; an empty list has no position', () => {
  assert.strictEqual(TO.stepIndex(0, 1, 3), 1);
  assert.strictEqual(TO.stepIndex(2, 1, 3), 0);
  assert.strictEqual(TO.stepIndex(0, -1, 3), 2);
  assert.strictEqual(TO.stepIndex(-1, 1, 3), 0, 'from nowhere, Down is the first row');
  assert.strictEqual(TO.stepIndex(-1, -1, 3), 2, 'and Up is the last');
  assert.strictEqual(TO.stepIndex(0, 1, 0), -1);
});

check('panelPosition: hangs under its button, right edges aligned, kept inside the window', () => {
  const pos = TO.panelPosition({ right: 600, bottom: 34 }, { width: 1120, height: 720 });
  assert.deepStrictEqual([pos.left, pos.top, pos.width], [280, 38, 320]);
  assert.strictEqual(pos.maxHeight, 720 - 38 - 8);
  const edge = TO.panelPosition({ right: 200, bottom: 34 }, { width: 1120, height: 720 });
  assert.strictEqual(edge.left, 8, 'never off the left edge');
  const far = TO.panelPosition({ right: 1500, bottom: 34 }, { width: 1120, height: 720 });
  assert.strictEqual(far.left + far.width, 1120 - 8, 'never off the right edge');
  const narrow = TO.panelPosition({ right: 300, bottom: 34 }, { width: 300, height: 600 });
  assert.strictEqual(narrow.width, 284, 'narrower than 320 when the window is');
  assert.ok(TO.panelPosition({ right: 300, bottom: 500 }, { width: 800, height: 520 }).maxHeight >= 140, 'a usable height at least');
});

// ---- a minimal DOM: what the controller touches ------------------------------------------------------
function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(), id: '', children: [], parentNode: null, attrs: {}, handlers: {}, dataset: {}, style: {},
    _classes: new Set(), _text: '', _html: '', title: '', focused: false, rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    scrollLeft: 0, clientWidth: 0, scrollWidth: 0
  };
  el.classList = {
    add: (...n) => n.forEach((x) => el._classes.add(x)),
    remove: (...n) => n.forEach((x) => el._classes.delete(x)),
    contains: (n) => el._classes.has(n),
    toggle: (n, force) => { const on = force === undefined ? !el._classes.has(n) : !!force; if (on) el._classes.add(n); else el._classes.delete(n); return on; }
  };
  Object.defineProperty(el, 'className', {
    get: () => Array.from(el._classes).join(' '),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  Object.defineProperty(el, 'textContent', {
    get: () => el._text + el.children.map((c) => c.textContent).join(''),
    set: (v) => { el._text = String(v); el.children.forEach((c) => { c.parentNode = null; }); el.children = []; }
  });
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = String(v); } });
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.appendChild = (c) => { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = el; el.children.push(c); return c; };
  el.contains = (n) => { for (let x = n; x; x = x.parentNode) if (x === el) return true; return false; };
  el.addEventListener = (type, fn) => { (el.handlers[type] = el.handlers[type] || []).push(fn); };
  el.removeEventListener = (type, fn) => { el.handlers[type] = (el.handlers[type] || []).filter((f) => f !== fn); };
  el.fire = (type, ev) => {
    const e = Object.assign({ target: el, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }, ev);
    (el.handlers[type] || []).slice().forEach((fn) => fn(e));
    return e;
  };
  el.focus = () => { el.focused = true; doc.activeElement = el; };
  el.scrollIntoView = () => { el.scrolledIntoView = (el.scrolledIntoView || 0) + 1; };
  el.getBoundingClientRect = () => el.rect;
  return el;
}

function harness(opts = {}) {
  const raf = [];
  const doc = {
    activeElement: null,
    handlers: {},
    createElement: (tag) => makeEl(tag, doc),
    addEventListener: (type, fn) => { (doc.handlers[type] = doc.handlers[type] || []).push(fn); },
    removeEventListener: (type, fn) => { doc.handlers[type] = (doc.handlers[type] || []).filter((f) => f !== fn); },
    fire: (type, ev) => (doc.handlers[type] || []).slice().forEach((fn) => fn(ev))
  };
  doc.body = makeEl('body', doc);
  const win = {
    innerWidth: 1120, innerHeight: 720, handlers: {},
    addEventListener: (type, fn) => { (win.handlers[type] = win.handlers[type] || []).push(fn); },
    removeEventListener: (type, fn) => { win.handlers[type] = (win.handlers[type] || []).filter((f) => f !== fn); },
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; }
  };
  const scrollEl = makeEl('div', doc);
  scrollEl.rect = { left: 40, top: 0, right: 540, bottom: 38, width: 500, height: 38 };
  scrollEl.clientWidth = 500;
  scrollEl.scrollWidth = 500;
  const listEl = makeEl('div', doc);
  const newBtn = makeEl('button', doc);
  const allBtn = makeEl('button', doc);
  allBtn.classList.add('hidden');
  allBtn.rect = { left: 570, top: 4, right: 596, bottom: 34, width: 26, height: 30 };
  const tabs = opts.tabs || [];
  let activeId = opts.activeId !== undefined ? opts.activeId : (tabs[0] && tabs[0].id) || null;
  tabs.forEach((t, i) => {
    const tabEl = makeEl('div', doc);
    tabEl.dataset.tabId = t.id;
    // 150px tabs laid out from the strip's left edge (40), scrolled by scrollLeft
    tabEl.getBoundingClientRect = () => ({ left: 40 + i * 150 - scrollEl.scrollLeft, width: 150 });
    listEl.appendChild(tabEl);
  });
  scrollEl.scrollWidth = opts.scrollWidth !== undefined ? opts.scrollWidth : Math.max(500, tabs.length * 150);
  const selected = [];
  const observers = [];
  function FakeRO(cb) { this.cb = cb; this.targets = []; observers.push(this); this.observe = (t) => this.targets.push(t); }
  const labels = { allTabsTitle: 'All tabs', allTabsHead: 'Tabs', allTabsUnsaved: 'Unsaved changes', allTabsHint: 'hint' };
  const controller = TO.create({
    doc, win, scrollEl, listEl, newBtn, allBtn, ResizeObserver: opts.noObserver ? undefined : FakeRO,
    getTabs: () => tabs, getActiveId: () => activeId,
    onSelect: (id) => { selected.push(id); activeId = id; },
    focusFallback: opts.focusFallback,
    label: (k) => labels[k] || k
  });
  const flush = () => { while (raf.length) raf.shift()(); };
  return { doc, win, scrollEl, listEl, newBtn, allBtn, tabs, controller, raf, flush, selected, observers, labels, setActive: (id) => { activeId = id; } };
}

const twelve = Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, title: 'note ' + i + '.md', isDirty: i % 3 === 0, path: '' }));

// ---- controller: the strip ------------------------------------------------------------------------------
check('create: nothing to attach to gives null, not a crash', () => {
  assert.strictEqual(TO.create({ doc: {}, scrollEl: null, listEl: null }), null);
});

check('tabs that fit: no button, no fade, no scroll, no list built (it costs nothing)', () => {
  const h = harness({ tabs: twelve.slice(0, 3) });
  h.controller.update({ focusedId: 't2', count: 3 });
  h.flush();
  assert.ok(h.allBtn.classList.contains('hidden'), 'the All tabs button stays hidden');
  assert.ok(!h.scrollEl.classList.contains('tabs-fade-left') && !h.scrollEl.classList.contains('tabs-fade-right'));
  assert.strictEqual(h.scrollEl.scrollLeft, 0);
  assert.strictEqual(h.doc.body.children.length, 0, 'the list panel is not built until it is opened');
  assert.strictEqual(h.controller.isListOpen(), false);
});

check('too many tabs: the button appears, the newest tab is revealed, the left edge fades', () => {
  const h = harness({ tabs: twelve, activeId: 't11' });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  assert.ok(!h.allBtn.classList.contains('hidden'), 'the All tabs button shows');
  // tab 11 sits at 1650..1800 in a 1800px strip seen through 500px; the end is 1300
  assert.strictEqual(h.scrollEl.scrollLeft, 1300);
  assert.ok(h.scrollEl.classList.contains('tabs-fade-left'));
  assert.ok(!h.scrollEl.classList.contains('tabs-fade-right'), 'the end of the strip does not fade');
});

check('switching to a tab at the far left scrolls back to it and moves the fade', () => {
  const h = harness({ tabs: twelve, activeId: 't11' });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  h.setActive('t0');
  h.controller.update({ focusedId: 't0', count: 12 });
  h.flush();
  assert.strictEqual(h.scrollEl.scrollLeft, 0);
  assert.ok(!h.scrollEl.classList.contains('tabs-fade-left'));
  assert.ok(h.scrollEl.classList.contains('tabs-fade-right'));
});

check('update with nothing new schedules nothing (a click in the editor must not cost a frame)', () => {
  const h = harness({ tabs: twelve, activeId: 't11' });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  h.controller.update({ focusedId: 't11', count: 12 });
  assert.strictEqual(h.raf.length, 0);
  h.controller.update({ focusedId: 't10', count: 12 });
  assert.strictEqual(h.raf.length, 1, 'a different tab in focus does');
  h.controller.update({ focusedId: 't9', count: 12 });
  assert.strictEqual(h.raf.length, 1, 'and several changes in one frame share one pass');
});

check('a render that changes nothing does not snap a manual scroll back', () => {
  const h = harness({ tabs: twelve, activeId: 't11' });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  h.scrollEl.scrollLeft = 200; // the user wheeled away
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  assert.strictEqual(h.scrollEl.scrollLeft, 200);
});

check('closing tabs until they fit hides the button again and clears the scroll and fades', () => {
  const h = harness({ tabs: twelve, activeId: 't11' });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  h.allBtn.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  h.scrollEl.scrollWidth = 450;
  h.controller.update({ focusedId: 't2', count: 3 });
  h.flush();
  assert.ok(h.allBtn.classList.contains('hidden'));
  assert.strictEqual(h.scrollEl.scrollLeft, 0);
  assert.ok(!h.scrollEl.classList.contains('tabs-fade-left') && !h.scrollEl.classList.contains('tabs-fade-right'));
});

check('a resize of the strip reveals the focused tab again; a resize of the tab list alone only re-measures', () => {
  const h = harness({ tabs: twelve, activeId: 't5' });
  h.controller.update({ focusedId: 't5', count: 12 });
  h.flush();
  const shown = h.scrollEl.scrollLeft;
  assert.ok(shown > 0);
  h.scrollEl.clientWidth = 250; // the window got narrower
  h.observers[0].cb([{ target: h.scrollEl }]);
  h.flush();
  const tab5 = 5 * 150;
  assert.ok(tab5 - 32 >= h.scrollEl.scrollLeft && tab5 + 150 + 32 <= h.scrollEl.scrollLeft + 250, 'the tab is inside the narrower strip: ' + h.scrollEl.scrollLeft);
  h.scrollEl.scrollLeft = 60;
  h.observers[0].cb([{ target: h.listEl }]);
  h.flush();
  assert.strictEqual(h.scrollEl.scrollLeft, 60, 'a title change does not move the view');
});

check('the mouse wheel scrolls the strip sideways only when there is something to scroll', () => {
  const h = harness({ tabs: twelve, activeId: 't0' });
  h.controller.update({ focusedId: 't0', count: 12 });
  h.flush();
  const e = h.scrollEl.fire('wheel', { deltaY: 120, deltaX: 0, ctrlKey: false });
  assert.strictEqual(h.scrollEl.scrollLeft, 120);
  assert.strictEqual(e.prevented, true);
  const pinch = h.scrollEl.fire('wheel', { deltaY: 120, deltaX: 0, ctrlKey: true });
  assert.strictEqual(h.scrollEl.scrollLeft, 120, 'Ctrl+wheel is a zoom, not ours');
  assert.ok(!pinch.prevented);
  const sideways = h.scrollEl.fire('wheel', { deltaY: 0, deltaX: 40 });
  assert.ok(!sideways.prevented, 'a trackpad that scrolls sideways already does the job');
  const fits = harness({ tabs: twelve.slice(0, 2) });
  const f = fits.scrollEl.fire('wheel', { deltaY: 120, deltaX: 0 });
  assert.ok(!f.prevented && fits.scrollEl.scrollLeft === 0, 'with tabs that fit the wheel is left alone');
});

// ---- controller: the list ---------------------------------------------------------------------------------
check('the list opens on the button: rows for every tab, the open one marked, unsaved ones with a dot, focus inside', () => {
  const h = harness({ tabs: twelve, activeId: 't4' });
  h.allBtn.fire('click');
  assert.ok(h.controller.isListOpen());
  const panel = h.doc.body.children[0];
  assert.ok(panel && !panel.classList.contains('hidden'));
  assert.strictEqual(panel.attrs.role, 'dialog');
  const rows = panel.children.find((c) => c.attrs.role === 'listbox');
  assert.strictEqual(rows.children.length, 12);
  const current = rows.children.filter((r) => r.classList.contains('is-current'));
  assert.deepStrictEqual(current.map((r) => r.dataset.tabId), ['t4']);
  assert.strictEqual(current[0].attrs['aria-selected'], 'true');
  assert.strictEqual(rows.children.filter((r) => r.attrs['aria-selected'] === 'true').length, 1);
  assert.ok(current[0].children[0].innerHTML.includes('<svg'), 'the open tab carries the check mark');
  const dots = rows.children.filter((r) => r.children.some((c) => c.classList.contains('tab-list-dot')));
  assert.strictEqual(dots.length, 4, 'tabs 0, 3, 6, 9 are unsaved');
  assert.strictEqual(rows.children[0].children[1].textContent, 'note 0.md', 'titles are set as text');
  assert.strictEqual(h.doc.activeElement, rows, 'the keyboard goes to the list');
  assert.strictEqual(h.allBtn.attrs['aria-expanded'], 'true');
  assert.strictEqual(panel.children[0].children[1].textContent, '12', 'the count chip');
  assert.strictEqual(rows.children[4].classList.contains('is-cursor'), true, 'the highlight starts on the open tab');
  assert.ok(rows.children[4].scrolledIntoView >= 1, 'and is scrolled into view');
});

check('the list stays inside the window: right edges aligned with the button', () => {
  const h = harness({ tabs: twelve });
  h.allBtn.fire('click');
  const panel = h.doc.body.children[0];
  assert.strictEqual(panel.style.width, '320px');
  assert.strictEqual(panel.style.left, (596 - 320) + 'px');
  assert.strictEqual(panel.style.top, '38px');
});

check('titles with markup are shown as text, never as HTML', () => {
  const nasty = [{ id: 'x', title: '<img src=x onerror=alert(1)>.md', isDirty: false }];
  const h = harness({ tabs: nasty, activeId: 'x' });
  h.allBtn.fire('click');
  const rows = h.doc.body.children[0].children.find((c) => c.attrs.role === 'listbox');
  assert.strictEqual(rows.children[0].children[1].textContent, '<img src=x onerror=alert(1)>.md');
  assert.strictEqual(rows.children[0]._html, '');
});

check('keys: arrows and Home/End move the highlight (wrapping), Enter switches and closes, Esc closes and gives the button its focus back', () => {
  const h = harness({ tabs: twelve, activeId: 't4' });
  h.allBtn.fire('click');
  const rows = h.doc.body.children[0].children.find((c) => c.attrs.role === 'listbox');
  const cursor = () => rows.children.findIndex((r) => r.classList.contains('is-cursor'));
  const press = (key) => rows.fire('keydown', { key });
  press('ArrowDown'); assert.strictEqual(cursor(), 5);
  press('ArrowUp'); press('ArrowUp'); assert.strictEqual(cursor(), 3);
  press('Home'); assert.strictEqual(cursor(), 0);
  press('ArrowUp'); assert.strictEqual(cursor(), 11, 'wraps to the last');
  press('End'); assert.strictEqual(cursor(), 11);
  press('Home'); press('ArrowDown'); press('ArrowDown');
  const enter = press('Enter');
  assert.deepStrictEqual(h.selected, ['t2']);
  assert.ok(enter.prevented && enter.stopped, 'the key is ours, the app does not also see it');
  assert.strictEqual(h.controller.isListOpen(), false);
  assert.ok(h.doc.body.children[0].classList.contains('hidden'));
  assert.strictEqual(h.allBtn.attrs['aria-expanded'], 'false');

  h.allBtn.fire('click');
  const esc = rows.fire('keydown', { key: 'Escape' });
  assert.ok(esc.stopped, 'Esc does not also reach app-level handlers');
  assert.strictEqual(h.controller.isListOpen(), false);
  assert.strictEqual(h.doc.activeElement, h.allBtn, 'focus returns to the button');
  assert.deepStrictEqual(h.selected, ['t2'], 'Esc chooses nothing');
});

check('a click on a row switches to that tab; a click on the button again closes; an outside press closes', () => {
  const h = harness({ tabs: twelve, activeId: 't4' });
  h.allBtn.fire('click');
  const panel = h.doc.body.children[0];
  const rows = panel.children.find((c) => c.attrs.role === 'listbox');
  rows.children[7].fire('click');
  assert.deepStrictEqual(h.selected, ['t7']);
  assert.strictEqual(h.controller.isListOpen(), false);

  h.allBtn.fire('click');
  assert.strictEqual(h.controller.isListOpen(), true);
  h.allBtn.fire('click');
  assert.strictEqual(h.controller.isListOpen(), false, 'the button toggles');

  h.allBtn.fire('click');
  h.doc.fire('mousedown', { target: h.scrollEl });
  assert.strictEqual(h.controller.isListOpen(), false, 'a press elsewhere closes it');
  h.allBtn.fire('click');
  h.doc.fire('mousedown', { target: rows.children[2] });
  assert.strictEqual(h.controller.isListOpen(), true, 'a press inside does not');
  h.doc.fire('mousedown', { target: h.allBtn });
  assert.strictEqual(h.controller.isListOpen(), true, 'a press on the button is left to its own click');
});

check('the list follows the tabs while it is open, and stops listening when closed', () => {
  const h = harness({ tabs: twelve.slice(0, 3), activeId: 't0' });
  h.controller.openList();
  assert.ok(!h.allBtn.classList.contains('hidden'), 'the button shows while the list hangs from it (opened from the palette)');
  h.tabs.push({ id: 'n', title: 'brand new.md', isDirty: true });
  h.controller.update({ focusedId: 't0', count: 4 });
  const rows = h.doc.body.children[0].children.find((c) => c.attrs.role === 'listbox');
  assert.strictEqual(rows.children.length, 4);
  h.controller.closeList(false);
  assert.strictEqual((h.doc.handlers.mousedown || []).length, 0, 'the outside-press listener is gone');
  assert.strictEqual((h.win.handlers.resize || []).length, 0);
  h.allBtn.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  h.flush();
  assert.ok(h.allBtn.classList.contains('hidden'), 'and with tabs that fit the button goes away again');
});

check('Esc in the list opened from the palette with tabs that fit: the button hides, so focus goes to the fallback (the editor), not to the page', () => {
  const editor = { id: 'editor' };
  let fallbackCalls = 0;
  let h = null;
  h = harness({ tabs: twelve.slice(0, 3), activeId: 't0', focusFallback: () => { fallbackCalls++; h.doc.activeElement = editor; } });
  h.controller.openList(); // the palette entry: the tabs fit, the button is shown for the list only
  assert.ok(!h.allBtn.classList.contains('hidden'));
  const rows = h.doc.body.children[0].children.find((c) => c.attrs.role === 'listbox');
  rows.fire('keydown', { key: 'Escape' });
  assert.strictEqual(h.controller.isListOpen(), false);
  assert.strictEqual(h.doc.activeElement, h.allBtn, 'Esc first gives the button its focus back (it is still visible)');
  h.allBtn.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; // once hidden, a button has no size
  h.flush();
  assert.ok(h.allBtn.classList.contains('hidden'), 'the button went away');
  assert.strictEqual(fallbackCalls, 1, 'and the focus was handed on once');
  assert.strictEqual(h.doc.activeElement, editor, 'to the editor');

  // with tabs that overflow the button stays and keeps the focus (Esc gives it back to the button)
  let calls2 = 0;
  const o = harness({ tabs: twelve, activeId: 't4', focusFallback: () => { calls2++; } });
  o.allBtn.fire('click');
  o.doc.body.children[0].children.find((c) => c.attrs.role === 'listbox').fire('keydown', { key: 'Escape' });
  o.controller.update({ focusedId: 't4', count: 12 });
  o.flush();
  assert.strictEqual(o.doc.activeElement, o.allBtn);
  assert.strictEqual(calls2, 0, 'the fallback is not used while the button stays');

  // a focused button that hides for another reason (tabs closed until they fit) hands the focus on too
  const c = harness({ tabs: twelve, activeId: 't4', focusFallback: () => { calls2++; } });
  c.controller.update({ focusedId: 't4', count: 12 });
  c.flush();
  c.allBtn.focus();
  c.scrollEl.scrollWidth = 450;
  c.controller.update({ focusedId: 't2', count: 3 });
  c.flush();
  assert.ok(c.allBtn.classList.contains('hidden'));
  assert.strictEqual(calls2, 1);
});

check('the list words come from the UI language every time it opens', () => {
  const h = harness({ tabs: twelve.slice(0, 2), activeId: 't0' });
  h.controller.openList();
  const panel = h.doc.body.children[0];
  assert.strictEqual(panel.children[0].children[0].textContent, 'Tabs');
  assert.strictEqual(panel.attrs['aria-label'], 'All tabs');
  h.controller.closeList(false);
  h.labels.allTabsHead = 'タブ';
  h.labels.allTabsTitle = 'すべてのタブ';
  h.controller.openList();
  assert.strictEqual(panel.children[0].children[0].textContent, 'タブ');
  assert.strictEqual(panel.attrs['aria-label'], 'すべてのタブ');
  assert.strictEqual(h.doc.body.children.length, 1, 'the same panel is reused');
});

check('a window resize closes the list (its place would be wrong)', () => {
  const h = harness({ tabs: twelve, activeId: 't4' });
  h.allBtn.fire('click');
  (h.win.handlers.resize || []).forEach((fn) => fn({}));
  assert.strictEqual(h.controller.isListOpen(), false);
});

check('without a ResizeObserver it still works (older WebView)', () => {
  const h = harness({ tabs: twelve, activeId: 't11', noObserver: true });
  h.controller.update({ focusedId: 't11', count: 12 });
  h.flush();
  assert.strictEqual(h.scrollEl.scrollLeft, 1300);
});

console.log('\n' + passed + ' checks passed');
