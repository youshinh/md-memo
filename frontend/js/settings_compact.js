// MD-Memo Settings dialog, compact view. The dialog lists every option MD-Memo has (about 80 fields and 50 lines of
// explanation) and a first-time user only needs a handful of them. This module makes it approachable without removing
// anything:
//   * every section that a beginner does not need is folded into a <details> that starts closed (the sections marked
//     data-basic on their header stay open; data-plain leaves a section as it is). The "Show advanced" switch in the
//     dialog header opens them all and is remembered;
//   * the explanatory <small> under a field is hidden behind a small "?" button next to that field. Status and warning
//     lines are never hidden: a <small> that has an id (the code writes to it), starts hidden, or says data-keep stays.
//
// It only moves and hides nodes that already exist (no node is cloned or rebuilt), so every id, listener and
// data-i18n keeps working, and a value is read or saved the same whether its section is open or closed.
(function (global) {
  'use strict';

  const STORE_KEY = 'md_memo_settings_show_advanced';

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // nodes: the children of a pane, as { header, basic, plain }. Returns one entry per section header:
  // { start, end (exclusive), basic, plain } - the nodes after a header, up to the next one, belong to its section.
  // Nodes before the first header (the fields that need no heading) belong to no section and are left alone.
  function planSections(nodes) {
    const heads = [];
    nodes.forEach(function (n, i) { if (n.header) heads.push(i); });
    return heads.map(function (start, k) {
      return {
        start: start,
        end: k + 1 < heads.length ? heads[k + 1] : nodes.length,
        basic: !!nodes[start].basic,
        plain: !!nodes[start].plain
      };
    });
  }

  // True for an explanation that goes behind the "?" button. info: { id, startsHidden, keep, dataHint, text }.
  function isHelpHint(info) {
    if (!info || !String(info.text || '').trim()) return false;
    if (info.dataHint) return true;                 // marked as a plain hint even though it has an id
    if (info.keep || info.startsHidden) return false; // meant to be seen, or shown by code when it applies
    return !info.id;                                // an id means the code writes a status into it
  }

  // ---- DOM ----------------------------------------------------------------------------------

  function wrapSections(pane, doc) {
    const kids = Array.prototype.slice.call(pane.children);
    const plan = planSections(kids.map(function (k) {
      return {
        header: k.classList.contains('settings-section-header'),
        basic: k.hasAttribute('data-basic'),
        plain: k.hasAttribute('data-plain')
      };
    }));
    plan.forEach(function (g) {
      if (g.plain) return;
      const header = kids[g.start];
      const details = doc.createElement('details');
      details.className = 'settings-section' + (g.basic ? ' is-basic' : '');
      details.open = g.basic;
      const summary = doc.createElement('summary');
      pane.insertBefore(details, header);
      summary.appendChild(header);
      details.appendChild(summary);
      const body = doc.createElement('div');
      body.className = 'settings-section-body';
      for (let i = g.start + 1; i < g.end; i++) body.appendChild(kids[i]);
      details.appendChild(body);
    });
  }

  function collapseHints(pane, doc) {
    const groups = [];
    pane.querySelectorAll('small').forEach(function (small) {
      const info = {
        id: small.id,
        startsHidden: small.classList.contains('hidden'),
        keep: small.hasAttribute('data-keep'),
        dataHint: small.hasAttribute('data-hint'),
        text: small.textContent
      };
      if (!isHelpHint(info)) return;
      const group = small.closest('.form-group') || small.parentElement;
      if (!group) return;
      small.classList.add('hint-collapsed');
      if (groups.indexOf(group) === -1) groups.push(group);
    });
    groups.forEach(function (group) {
      group.classList.add('has-hint');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'hint-toggle';
      btn.setAttribute('aria-expanded', 'false');
      const mark = doc.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '?';
      const sr = doc.createElement('span');
      sr.className = 'visually-hidden';
      sr.setAttribute('data-i18n', 'settingsHelpToggle');
      sr.textContent = 'Show help';
      btn.appendChild(mark);
      btn.appendChild(sr);
      btn.addEventListener('click', function () {
        const open = group.classList.toggle('hint-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      group.appendChild(btn);
    });
  }

  function readShowAdvanced() {
    try { return global.localStorage.getItem(STORE_KEY) === '1'; } catch (e) { return false; }
  }

  function saveShowAdvanced(on) {
    try { global.localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) { /* not remembered: still works */ }
  }

  // Opens every section (on) or returns to the default: only the basic ones open (off).
  function applyShowAdvanced(root, on) {
    root.querySelectorAll('details.settings-section').forEach(function (d) {
      d.open = on || d.classList.contains('is-basic');
    });
  }

  function init(doc) {
    doc = doc || global.document;
    if (!doc) return;
    const firstPane = doc.getElementById('pane-general');
    const root = firstPane && firstPane.closest('.modal-card');
    if (!root || root.getAttribute('data-compact') === '1') return;
    root.setAttribute('data-compact', '1');
    root.querySelectorAll('.settings-pane').forEach(function (pane) {
      wrapSections(pane, doc);
      collapseHints(pane, doc);
    });
    const toggle = doc.getElementById('cfg-show-advanced');
    if (toggle) {
      toggle.checked = readShowAdvanced();
      applyShowAdvanced(root, toggle.checked);
      toggle.addEventListener('change', function () {
        saveShowAdvanced(toggle.checked);
        applyShowAdvanced(root, toggle.checked);
      });
    }
  }

  const api = { planSections: planSections, isHelpHint: isHelpHint, init: init };
  global.SettingsCompact = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof document !== 'undefined') {
    init(document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
