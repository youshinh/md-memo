// MD-Memo chrome layout: which toolbar icons and right-click menu items are shown, and in what order.
//
// Cost model (this runs on every start-up, so it must stay out of the way):
//  * A layout that was never customised is a no-op: apply() returns before it touches the DOM.
//  * Items and their groups are read from the markup itself (a group is the run of items between two
//    dividers), so there is no registry to keep in sync and new buttons become customisable for free.
//  * The settings editor is only built when the user opens it (see renderEditor); nothing here
//    runs while typing or when the context menu opens.
(function (global) {
  'use strict';

  const HIDDEN_CLASS = 'layout-hidden';

  // Drops a trailing "(Ctrl+O)" / "（Ctrl+O）" from a tooltip so it reads as a plain label.
  function stripShortcut(text) {
    return String(text || '').replace(/\s*[(（][^()（）]*[)）]\s*$/, '').trim();
  }

  const SURFACES = {
    toolbar: {
      key: 'toolbarLayout',
      containerId: 'header-actions',
      dividerClass: 'header-divider',
      isItem: (el) => el.tagName === 'BUTTON' && !!el.id,
      // The way back into the very dialog that customises this: it can be moved but never hidden.
      locked: { 'btn-settings': true },
      label: (el) => stripShortcut(el.getAttribute('title')) || el.id
    },
    context: {
      key: 'contextMenuLayout',
      containerId: 'context-menu',
      dividerClass: 'menu-divider',
      isItem: (el) => !!el.classList && el.classList.contains('menu-item') && !!el.id,
      locked: {},
      label: (el) => {
        const span = el.querySelector('.menu-label');
        return (span && span.textContent) || el.id;
      }
    }
  };

  // Per surface: the pristine order (captured before the first change, so "reset" can restore it),
  // the signature of the layout last applied, and whether the DOM currently differs from pristine.
  const state = {
    toolbar: { defaults: null, applied: null, dirty: false, visible: null },
    context: { defaults: null, applied: null, dirty: false, visible: null }
  };

  function hasClass(el, name) {
    return !!el.classList && el.classList.contains(name);
  }

  // groups[i] are the items before dividers[i]; the last group has no divider after it.
  function readGroups(surface, container) {
    const groups = [[]];
    const dividers = [];
    const kids = container.children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (hasClass(el, surface.dividerClass)) {
        dividers.push(el);
        groups.push([]);
      } else if (surface.isItem(el)) {
        groups[groups.length - 1].push(el);
      }
    }
    return { groups, dividers };
  }

  function strings(list) {
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  }

  function normalize(layout) {
    return { order: strings(layout && layout.order), hidden: strings(layout && layout.hidden) };
  }

  // Ids the saved order does not mention (a button added in a newer version) keep their default
  // relative position, after the ones it does.
  function buildRank(defaults, order) {
    const rank = new Map();
    order.forEach((id) => { if (!rank.has(id)) rank.set(id, rank.size); });
    defaults.forEach((id) => { if (!rank.has(id)) rank.set(id, rank.size); });
    return rank;
  }

  // Returns true when the DOM was (re)arranged.
  function apply(name, layoutInput, doc) {
    const surface = SURFACES[name];
    const st = state[name];
    const layout = normalize(layoutInput);
    const signature = JSON.stringify(layout);
    if (signature === st.applied) return false;

    const isDefault = layout.order.length === 0 && layout.hidden.length === 0;
    if (isDefault && !st.dirty) {
      st.applied = signature; // never customised: leave the markup alone
      return false;
    }

    const container = (doc || global.document).getElementById(surface.containerId);
    if (!container) return false;

    const { groups, dividers } = readGroups(surface, container);
    if (!st.defaults) st.defaults = groups.flat().map((el) => el.id);
    const rank = buildRank(st.defaults, layout.order);
    const rankOf = (el) => (rank.has(el.id) ? rank.get(el.id) : Number.MAX_SAFE_INTEGER);
    const hidden = new Set(layout.hidden.filter((id) => !surface.locked[id]));

    let visible = 0;
    groups.forEach((group, gi) => {
      const sorted = group.slice().sort((a, b) => rankOf(a) - rankOf(b)); // stable
      if (sorted.some((el, i) => el !== group[i])) {
        const reference = dividers[gi] || null;
        sorted.forEach((el) => container.insertBefore(el, reference));
      }
      sorted.forEach((el) => {
        const hide = hidden.has(el.id);
        el.classList.toggle(HIDDEN_CLASS, hide);
        if (!hide) visible++;
      });
    });

    // A divider is shown only between two visible runs, and never twice in a row.
    let pendingDivider = null;
    let seenVisible = false;
    const kids = container.children;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (hasClass(el, surface.dividerClass)) {
        el.classList.add(HIDDEN_CLASS);
        if (seenVisible) pendingDivider = el;
      } else if (surface.isItem(el) && !hasClass(el, HIDDEN_CLASS)) {
        if (pendingDivider) {
          pendingDivider.classList.remove(HIDDEN_CLASS);
          pendingDivider = null;
        }
        seenVisible = true;
      }
    }

    st.applied = signature;
    st.dirty = !isDefault;
    st.visible = visible;
    return true;
  }

  function applyAll(config, doc) {
    const general = (config && config.general) || {};
    apply('toolbar', general.toolbarLayout, doc);
    apply('context', general.contextMenuLayout, doc);
  }

  // O(1): lets the right-click handler skip an empty menu without looking at the DOM.
  function hasVisibleItems(name) {
    const visible = state[name] && state[name].visible;
    return visible === null || visible > 0;
  }

  // The layout objects live in config.general and are edited in place.
  function ensureLayout(config, name) {
    const key = SURFACES[name].key;
    if (!config.general) config.general = {};
    const layout = config.general[key];
    if (!layout || typeof layout !== 'object') config.general[key] = { order: [], hidden: [] };
    else {
      layout.order = strings(layout.order);
      layout.hidden = strings(layout.hidden);
    }
    return config.general[key];
  }

  function setVisible(name, layout, id, visible, doc) {
    if (SURFACES[name].locked[id]) return;
    const hidden = new Set(strings(layout.hidden));
    if (visible) hidden.delete(id); else hidden.add(id);
    layout.hidden = Array.from(hidden);
    apply(name, layout, doc);
  }

  // Moves an item up (-1) or down (+1) inside its own group. Returns whether it moved.
  function move(name, layout, id, delta, doc) {
    const surface = SURFACES[name];
    const container = (doc || global.document).getElementById(surface.containerId);
    if (!container) return false;
    const { groups } = readGroups(surface, container);
    for (const group of groups) {
      const i = group.findIndex((el) => el.id === id);
      if (i < 0) continue;
      const j = i + delta;
      if (j < 0 || j >= group.length) return false;
      const swapped = group.slice();
      [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
      const order = [];
      groups.forEach((g) => (g === group ? swapped : g).forEach((el) => order.push(el.id)));
      layout.order = order;
      apply(name, layout, doc);
      return true;
    }
    return false;
  }

  function reset(name, layout, doc) {
    layout.order = [];
    layout.hidden = [];
    apply(name, layout, doc);
  }

  const CHEVRON_ATTRS = 'width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const CHEVRON = {
    up: `<svg ${CHEVRON_ATTRS}><polyline points="18 15 12 9 6 15"></polyline></svg>`,
    down: `<svg ${CHEVRON_ATTRS}><polyline points="6 9 12 15 18 9"></polyline></svg>`
  };

  // Builds the settings rows for one surface: a checkbox (shown/hidden), the item's own icon and
  // name, and up/down arrows that reorder inside its group. Called only when the section is open.
  // opts: { labels: { up, down, locked }, onChange(), doc }
  function renderEditor(name, host, layout, opts) {
    const surface = SURFACES[name];
    const doc = (opts && opts.doc) || global.document;
    const labels = (opts && opts.labels) || {};
    const onChange = (opts && opts.onChange) || function () {};
    const container = doc.getElementById(surface.containerId);
    host.textContent = '';
    if (!container) return;

    const rerender = () => { renderEditor(name, host, layout, opts); onChange(); };
    const { groups } = readGroups(surface, container);

    groups.forEach((group) => {
      if (!group.length) return;
      const groupEl = doc.createElement('div');
      groupEl.className = 'layout-group';

      group.forEach((item, i) => {
        const row = doc.createElement('div');
        row.className = 'layout-row';

        const check = doc.createElement('input');
        check.type = 'checkbox';
        check.checked = !hasClass(item, HIDDEN_CLASS);
        const locked = !!surface.locked[item.id];
        check.disabled = locked;
        if (locked && labels.locked) row.title = labels.locked;
        check.addEventListener('change', () => {
          setVisible(name, layout, item.id, check.checked, doc);
          onChange();
        });

        const icon = doc.createElement('span');
        icon.className = 'layout-icon';
        const svg = item.querySelector('svg');
        if (svg) icon.appendChild(svg.cloneNode(true));

        const label = doc.createElement('span');
        label.className = 'layout-label';
        label.textContent = surface.label(item);

        const arrow = (dir, disabled) => {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'btn-icon layout-move';
          button.innerHTML = CHEVRON[dir];
          if (labels[dir]) button.title = labels[dir];
          button.disabled = disabled;
          button.addEventListener('click', () => {
            if (move(name, layout, item.id, dir === 'up' ? -1 : 1, doc)) rerender();
          });
          return button;
        };

        row.appendChild(check);
        row.appendChild(icon);
        row.appendChild(label);
        row.appendChild(arrow('up', i === 0));
        row.appendChild(arrow('down', i === group.length - 1));
        groupEl.appendChild(row);
      });
      host.appendChild(groupEl);
    });
  }

  global.ChromeLayout = {
    applyAll,
    hasVisibleItems,
    ensureLayout,
    renderEditor,
    reset,
    stripShortcut,
    // exposed for tests
    _apply: apply,
    _move: move,
    _setVisible: setVisible,
    _state: state
  };
})(typeof window !== 'undefined' ? window : globalThis);
