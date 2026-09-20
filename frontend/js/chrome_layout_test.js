// Unit tests for chrome_layout.js (toolbar / right-click menu visibility and order).
const assert = require('assert');

require('./chrome_layout.js');
const CL = globalThis.ChromeLayout;

// ---- a minimal DOM: just what the module touches -------------------------------------------
class ClassList {
  constructor(owner) { this.owner = owner; this.set = new Set(); }
  add(...names) { names.forEach((n) => { if (!this.set.has(n)) { this.set.add(n); this.owner.mutations++; } }); }
  remove(...names) { names.forEach((n) => { if (this.set.delete(n)) this.owner.mutations++; }); }
  contains(n) { return this.set.has(n); }
  toggle(n, force) {
    const want = force === undefined ? !this.set.has(n) : !!force;
    if (want) this.add(n); else this.remove(n);
    return want;
  }
}

function makeDoc() {
  const byId = new Map();
  const doc = {
    mutations: 0,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeEl(tag),
    register(el) { byId.set(el.id, el); return el; }
  };
  function makeEl(tag, id, opts = {}) {
    const el = {
      tagName: tag.toUpperCase(), id: id || '', children: [], parentNode: null, attrs: {}, handlers: {},
      mutations: 0, className: '', innerHTML: '', type: '', checked: false, disabled: false, title: '',
      _text: opts.text || ''
    };
    el.classList = new ClassList(el);
    if (opts.className) opts.className.split(' ').forEach((c) => el.classList.set.add(c));
    if (opts.title) el.attrs.title = opts.title;
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.appendChild = (child) => {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      child.parentNode = el; el.children.push(child); return child;
    };
    el.insertBefore = (child, ref) => {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      child.parentNode = el;
      const at = ref ? el.children.indexOf(ref) : el.children.length;
      el.children.splice(at, 0, child);
      el.mutations++; doc.mutations++;
      return child;
    };
    el.querySelector = (sel) => {
      const walk = (node) => {
        for (const c of node.children) {
          if ((sel === 'svg' && c.tagName === 'SVG') || (sel === '.menu-label' && c.classList.contains('menu-label'))) return c;
          const deeper = walk(c); if (deeper) return deeper;
        }
        return null;
      };
      return walk(el);
    };
    el.cloneNode = () => makeEl(el.tagName.toLowerCase(), '', { className: Array.from(el.classList.set).join(' ') });
    el.addEventListener = (type, fn) => { (el.handlers[type] = el.handlers[type] || []).push(fn); };
    el.fire = (type) => (el.handlers[type] || []).forEach((fn) => fn({ target: el }));
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) { el._text = v; if (v === '') el.children.length = 0; }
    });
    return el;
  }
  doc.makeEl = makeEl;
  return doc;
}

// Toolbar: [a b c] | [d settings help]; context menu: [1 2] | [3] | [4 5]
function build() {
  const doc = makeDoc();
  const toolbar = doc.register(doc.makeEl('div', 'header-actions'));
  const mk = (tag, id, opts) => {
    const e = doc.makeEl(tag, id, opts);
    if (tag === 'button') e.appendChild(doc.makeEl('svg', ''));
    return e;
  };
  const divider = (cls) => doc.makeEl('div', '', { className: cls });
  const btn = (id, title) => mk('button', id, { title });
  [btn('btn-a', 'Open File (Ctrl+O)'), btn('btn-b', 'ファイルを開く（Ctrl+B）'), btn('btn-c', 'Split Editor Right (Ctrl+\\)'),
    divider('header-divider'),
    btn('btn-d', 'Mobile Drop (QR sync) (Ctrl+Shift+U)'), btn('btn-settings', 'Settings'), btn('btn-help', 'Help & Documentation')]
    .forEach((e) => { toolbar.appendChild(e); doc.register(e); });

  const menu = doc.register(doc.makeEl('div', 'context-menu'));
  const item = (id, text) => {
    const e = doc.makeEl('div', id, { className: 'menu-item' });
    e.appendChild(doc.makeEl('svg', ''));
    e.appendChild(doc.makeEl('span', '', { className: 'menu-label', text }));
    return e;
  };
  [item('ctx-1', 'Undo'), item('ctx-2', 'Redo'), divider('menu-divider'), item('ctx-3', 'Cut'),
    divider('menu-divider'), item('ctx-4', 'Find...'), item('ctx-5', 'Replace...')]
    .forEach((e) => { menu.appendChild(e); doc.register(e); });
  return { doc, toolbar, menu };
}

const ids = (container) => container.children.map((c) => c.id || (c.classList.contains('layout-hidden') ? '|(hidden)' : '|'));
const order = (container) => container.children.filter((c) => c.id).map((c) => c.id);
const fresh = () => { for (const k of ['toolbar', 'context']) Object.assign(CL._state[k], { defaults: null, applied: null, dirty: false, visible: null }); };
const dividerStates = (container, cls) => container.children.filter((c) => c.classList.contains(cls)).map((c) => !c.classList.contains('layout-hidden'));

// 1. A never-customised layout must not touch the DOM at all (the start-up cost promise).
{
  fresh();
  const { doc, toolbar, menu } = build();
  const before = doc.mutations + toolbar.children.reduce((n, c) => n + c.mutations, 0) + menu.children.reduce((n, c) => n + c.mutations, 0);
  assert.strictEqual(CL._apply('toolbar', { order: [], hidden: [] }, doc), false);
  assert.strictEqual(CL._apply('toolbar', undefined, doc), false);
  CL.applyAll({ general: {} }, doc);
  CL.applyAll({}, doc);
  CL.applyAll(null, doc);
  const after = doc.mutations + toolbar.children.reduce((n, c) => n + c.mutations, 0) + menu.children.reduce((n, c) => n + c.mutations, 0);
  assert.strictEqual(after, before, 'default layouts must leave the markup untouched');
  assert.strictEqual(CL.hasVisibleItems('toolbar'), true);
  console.log('PASS: a default layout is a no-op');
}

// 2. Hiding: items get the class, the locked Settings button can never be hidden, unknown ids are ignored.
{
  fresh();
  const { doc, toolbar } = build();
  CL._apply('toolbar', { order: [], hidden: ['btn-b', 'btn-settings', 'btn-does-not-exist'] }, doc);
  const hiddenIds = toolbar.children.filter((c) => c.id && c.classList.contains('layout-hidden')).map((c) => c.id);
  assert.deepStrictEqual(hiddenIds, ['btn-b'], 'only btn-b is hidden; btn-settings is locked');
  assert.deepStrictEqual(dividerStates(toolbar, 'header-divider'), [true], 'both sides still have icons: the divider stays');
  console.log('PASS: hiding works and Settings is never hidden');
}

// 3. Dividers only sit between two visible runs.
{
  fresh();
  const { doc, toolbar } = build();
  CL._apply('toolbar', { order: [], hidden: ['btn-a', 'btn-b', 'btn-c'] }, doc);
  assert.deepStrictEqual(dividerStates(toolbar, 'header-divider'), [false], 'nothing visible before it: no divider');
  CL._apply('toolbar', { order: [], hidden: ['btn-d', 'btn-help'] }, doc);
  assert.deepStrictEqual(dividerStates(toolbar, 'header-divider'), [true], 'Settings (locked) keeps the second group alive');

  const ctx = build();
  CL._apply('context', { order: [], hidden: ['ctx-3'] }, ctx.doc);
  assert.strictEqual(dividerStates(ctx.menu, 'menu-divider').filter(Boolean).length, 1, 'two dividers must not end up adjacent');
  CL._apply('context', { order: [], hidden: ['ctx-1', 'ctx-2'] }, ctx.doc);
  assert.deepStrictEqual(dividerStates(ctx.menu, 'menu-divider'), [false, true], 'no divider above the first visible item');
  CL._apply('context', { order: [], hidden: ['ctx-4', 'ctx-5'] }, ctx.doc);
  assert.deepStrictEqual(dividerStates(ctx.menu, 'menu-divider'), [true, false], 'no divider below the last visible item');
  console.log('PASS: dividers collapse correctly');
}

// 4. The menu can be emptied: the right-click handler is told in O(1).
{
  fresh();
  const { doc } = build();
  CL._apply('context', { order: [], hidden: ['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4', 'ctx-5'] }, doc);
  assert.strictEqual(CL.hasVisibleItems('context'), false);
  CL._apply('context', { order: [], hidden: ['ctx-1'] }, doc);
  assert.strictEqual(CL.hasVisibleItems('context'), true);
  console.log('PASS: an empty menu is reported');
}

// 5. Ordering happens inside a group and never across dividers.
{
  fresh();
  const { doc, toolbar } = build();
  CL._apply('toolbar', { order: ['btn-c', 'btn-a', 'btn-b', 'btn-help', 'btn-settings', 'btn-d'], hidden: [] }, doc);
  assert.deepStrictEqual(ids(toolbar), ['btn-c', 'btn-a', 'btn-b', '|', 'btn-help', 'btn-settings', 'btn-d']);

  // an order that tries to pull a group-2 button into group 1 is honoured only inside its own group
  fresh();
  const other = build();
  CL._apply('toolbar', { order: ['btn-d', 'btn-a', 'btn-b', 'btn-c'], hidden: [] }, other.doc);
  assert.deepStrictEqual(ids(other.toolbar), ['btn-a', 'btn-b', 'btn-c', '|', 'btn-d', 'btn-settings', 'btn-help']);
  console.log('PASS: order is per group');
}

// 6. Items the saved order does not know keep their default place, after the known ones.
{
  fresh();
  const { doc, toolbar } = build();
  CL._apply('toolbar', { order: ['btn-b', 'btn-a'], hidden: [] }, doc); // btn-c (added later) not mentioned
  assert.deepStrictEqual(ids(toolbar).slice(0, 3), ['btn-b', 'btn-a', 'btn-c']);
  console.log('PASS: newly added items are not lost');
}

// 7. Repeating the same layout is free; changing it applies again.
{
  fresh();
  const { doc, toolbar } = build();
  const layout = { order: ['btn-b', 'btn-a', 'btn-c'], hidden: ['btn-help'] };
  assert.strictEqual(CL._apply('toolbar', layout, doc), true);
  const settled = toolbar.children.reduce((n, c) => n + c.mutations, 0) + doc.mutations;
  assert.strictEqual(CL._apply('toolbar', layout, doc), false, 'same signature: nothing to do');
  assert.strictEqual(toolbar.children.reduce((n, c) => n + c.mutations, 0) + doc.mutations, settled);
  layout.hidden = [];
  assert.strictEqual(CL._apply('toolbar', layout, doc), true);
  console.log('PASS: applying is idempotent and change-aware');
}

// 8. Reset brings back the original order and shows everything.
{
  fresh();
  const { doc, toolbar } = build();
  const layout = CL.ensureLayout({ general: {} }, 'toolbar');
  CL._apply('toolbar', { order: ['btn-c', 'btn-b', 'btn-a', 'btn-help', 'btn-settings', 'btn-d'], hidden: ['btn-a', 'btn-help'] }, doc);
  assert.notDeepStrictEqual(order(toolbar), ['btn-a', 'btn-b', 'btn-c', 'btn-d', 'btn-settings', 'btn-help']);
  CL.reset('toolbar', layout, doc);
  assert.deepStrictEqual(ids(toolbar), ['btn-a', 'btn-b', 'btn-c', '|', 'btn-d', 'btn-settings', 'btn-help'], 'default order is restored');
  assert(toolbar.children.every((c) => !c.classList.contains('layout-hidden')), 'everything is visible again');
  // after a reset the layout is pristine again: the next default apply is a no-op
  assert.strictEqual(CL._state.toolbar.dirty, false);
  console.log('PASS: reset restores the default layout');
}

// 9. move(): swaps inside the group, refuses at the edges, records the whole order.
{
  fresh();
  const { doc, toolbar } = build();
  const layout = { order: [], hidden: [] };
  assert.strictEqual(CL._move('toolbar', layout, 'btn-b', -1, doc), true);
  assert.deepStrictEqual(order(toolbar).slice(0, 3), ['btn-b', 'btn-a', 'btn-c']);
  assert.strictEqual(layout.order.length, 6, 'the whole order is stored, all groups');
  assert.strictEqual(CL._move('toolbar', layout, 'btn-b', -1, doc), false, 'already first in its group');
  assert.strictEqual(CL._move('toolbar', layout, 'btn-d', -1, doc), false, 'first of the second group: cannot cross the divider');
  assert.strictEqual(CL._move('toolbar', layout, 'btn-c', 1, doc), false, 'last of its group');
  assert.strictEqual(CL._move('toolbar', layout, 'nope', 1, doc), false);
  assert.strictEqual(CL._move('toolbar', layout, 'btn-settings', 1, doc), true, 'Settings can be moved');
  assert.deepStrictEqual(order(toolbar).slice(3), ['btn-d', 'btn-help', 'btn-settings']);
  console.log('PASS: move() swaps within a group only');
}

// 10. Labels: shortcut hints are stripped from tooltips.
{
  assert.strictEqual(CL.stripShortcut('Open File (Ctrl+O)'), 'Open File');
  assert.strictEqual(CL.stripShortcut('ファイルを開く（Ctrl+O）'), 'ファイルを開く');
  assert.strictEqual(CL.stripShortcut('Split Editor Right (Ctrl+\\)'), 'Split Editor Right');
  assert.strictEqual(CL.stripShortcut('Mobile Drop (QR sync) (Ctrl+Shift+U)'), 'Mobile Drop (QR sync)');
  assert.strictEqual(CL.stripShortcut('Settings'), 'Settings');
  assert.strictEqual(CL.stripShortcut('Help & Documentation'), 'Help & Documentation');
  console.log('PASS: tooltip shortcuts are stripped from labels');
}

// 11. The settings editor: rows, icons, labels, locked / edge states, and it drives the layout.
{
  fresh();
  const { doc, toolbar, menu } = build();
  const layout = { order: [], hidden: [] };
  const host = doc.makeEl('div', 'host');
  let changes = 0;
  const opts = { doc, labels: { up: 'Move up', down: 'Move down', locked: 'Always shown' }, onChange: () => { changes++; } };

  CL.renderEditor('toolbar', host, layout, opts);
  assert.strictEqual(host.children.length, 2, 'one block per group');
  const rows = host.children.flatMap((g) => g.children);
  assert.strictEqual(rows.length, 6, 'one row per icon');
  const rowLabel = (row) => row.children[2].textContent;
  assert.deepStrictEqual(rows.map(rowLabel), ['Open File', 'ファイルを開く', 'Split Editor Right', 'Mobile Drop (QR sync)', 'Settings', 'Help & Documentation']);
  assert(rows.every((r) => r.children[1].children.length === 1), 'each row shows a copy of the real icon');
  const checkOf = (row) => row.children[0];
  const upOf = (row) => row.children[3];
  const downOf = (row) => row.children[4];
  assert(checkOf(rows[4]).disabled && rows[4].title === 'Always shown', 'Settings cannot be unticked');
  assert(upOf(rows[0]).disabled && !downOf(rows[0]).disabled, 'first row: no up');
  assert(downOf(rows[2]).disabled && upOf(rows[3]).disabled, 'group edges: no crossing over the divider');
  assert(rows.every((r) => checkOf(r).checked));

  // unticking hides the real button immediately
  checkOf(rows[1]).checked = false;
  checkOf(rows[1]).fire('change');
  assert(toolbar.children.find((c) => c.id === 'btn-b').classList.contains('layout-hidden'));
  assert.deepStrictEqual(layout.hidden, ['btn-b']);
  assert.strictEqual(changes, 1);

  // the down arrow reorders the real toolbar and redraws the rows
  downOf(rows[0]).fire('click');
  assert.deepStrictEqual(order(toolbar).slice(0, 3), ['btn-b', 'btn-a', 'btn-c']);
  const rowsAfter = host.children.flatMap((g) => g.children);
  assert.strictEqual(rowLabel(rowsAfter[0]), 'ファイルを開く');
  assert(!checkOf(rowsAfter[0]).checked, 'the redrawn row keeps its hidden state');
  assert.strictEqual(changes, 2);

  // context menu: labels come from the menu's own text
  const menuHost = doc.makeEl('div', 'menu-host');
  CL.renderEditor('context', menuHost, { order: [], hidden: [] }, opts);
  assert.deepStrictEqual(menuHost.children.flatMap((g) => g.children).map(rowLabel), ['Undo', 'Redo', 'Cut', 'Find...', 'Replace...']);
  assert.strictEqual(menuHost.children.length, 3);
  console.log('PASS: the editor lists, hides and reorders real items');
}

// 12. ensureLayout tolerates whatever is in a saved config.
{
  const config = { general: { toolbarLayout: { order: ['a', 1, null], hidden: 'oops' } } };
  const layout = CL.ensureLayout(config, 'toolbar');
  assert.deepStrictEqual(layout, { order: ['a'], hidden: [] });
  assert.deepStrictEqual(CL.ensureLayout({}, 'context'), { order: [], hidden: [] });
  console.log('PASS: malformed saved layouts are sanitised');
}

console.log('\nAll chrome layout tests PASSED!');
