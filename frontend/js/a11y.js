// MD-Memo accessibility layer. The markup grew without ARIA: the icon-only buttons are named only by their tooltip, the
// dialogs are not dialogs to a screen reader, Tab leaves an open dialog for the toolbar behind it, and the status-bar
// toggles cannot be reached from the keyboard. This module adds what is missing on the elements that already exist; it
// creates no visible UI and changes no behaviour for a mouse user.
//
//   * buttons that show only an icon or a glyph get aria-label from their title (kept in step with the UI language);
//   * every .modal-backdrop > .modal-card is a role=dialog, aria-modal, named by its heading or its first field;
//   * Tab and Shift+Tab stay inside the topmost open dialog, and when it closes focus goes back to where it was (only when
//     it would otherwise be lost on <body>: the dialogs that already hand focus to the editor keep doing that);
//   * the status-bar toggles (.clickable-badge) are role=button, in the tab order, and answer Enter and Space;
//   * #stat-message and the LLM indicator are polite live regions; the tab strip is a tablist with role=tab items.
(function (global) {
  'use strict';

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // True for a control whose visible text does not name it: nothing, only symbols/glyphs (x, an arrow, a check), or an
  // abbreviation of one or two characters (Aa, ab) when the control has a title that says what it is.
  function needsLabel(text, hasTitle) {
    const t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!t) return true;
    if (!/[\p{L}\p{N}]/u.test(t)) return true;
    return t.length <= 1 || (hasTitle === true && t.length <= 2);
  }

  // The name of a close button that has no title: a bare x (or the check glyph) in the UI language.
  function closeText() {
    let text = 'Close';
    try {
      const lang = global.document.documentElement.lang === 'ja' ? 'ja' : 'en';
      if (typeof I18N !== 'undefined' && I18N[lang] && I18N[lang].dialogClose) text = I18N[lang].dialogClose;
    } catch (e) { /* keep the English default */ }
    return text;
  }

  // Where Tab goes next inside a dialog with `count` focusable elements: `index` is where focus is now (-1 = outside).
  // Returns the index to focus, or null to let the browser move focus normally.
  function nextTrapIndex(count, index, shift) {
    if (count <= 0) return null;
    if (index < 0) return shift ? count - 1 : 0;
    if (shift && index === 0) return count - 1;
    if (!shift && index === count - 1) return 0;
    return null;
  }

  // ---- DOM ----------------------------------------------------------------------------------

  let applyTabs = null;   // relabels the tab strip (set by markTabs)
  let lastOutside = null; // the last focused element that was not inside an open dialog

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function openDialogs(doc) {
    return Array.prototype.filter.call(doc.querySelectorAll('.modal-backdrop'), function (b) { return !b.classList.contains('hidden'); });
  }

  function labelButtons(doc) {
    doc.querySelectorAll('button, [role="button"]').forEach(function (b) {
      if (b.hasAttribute('data-a11y-keep')) return;
      if (b.getAttribute('aria-label') && !b.hasAttribute('data-a11y-label')) return; // named by hand
      const title = b.getAttribute('title');
      let name = '';
      if (needsLabel(b.textContent, !!title)) {
        // A title names it; a bare close glyph without one is a close button.
        name = title || (/^[\s×✕✖xX]+$/.test(b.textContent || '') ? closeText() : '');
      }
      if (name) {
        b.setAttribute('aria-label', name);
        b.setAttribute('data-a11y-label', '1'); // ours: refreshed when the language changes
      }
    });
  }

  function markDialogs(doc) {
    let n = 0;
    doc.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
      const card = backdrop.querySelector('.modal-card') || backdrop.firstElementChild;
      if (!card || card.getAttribute('role')) return;
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const heading = card.querySelector('h1, h2, h3, h4, [id$="-title"]');
      if (heading) {
        if (!heading.id) heading.id = (backdrop.id || 'dialog') + '-heading-' + (++n);
        card.setAttribute('aria-labelledby', heading.id);
      } else {
        const input = card.querySelector('input, textarea');
        const name = input && (input.getAttribute('aria-label') || input.getAttribute('placeholder'));
        if (name) card.setAttribute('aria-label', name);
      }
    });
  }

  function markLiveRegions(doc) {
    const msg = doc.getElementById('stat-message');
    if (msg) { msg.setAttribute('role', 'status'); msg.setAttribute('aria-live', 'polite'); }
    const llm = doc.getElementById('stat-llm-indicator');
    if (llm) { llm.setAttribute('role', 'status'); llm.setAttribute('aria-live', 'polite'); }
  }

  function markStatusToggles(doc) {
    doc.querySelectorAll('#status-bar .clickable-badge').forEach(function (el) {
      if (el.getAttribute('role')) return;
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
      });
    });
  }

  // "Close <note>" in the UI language (the tables load before this file; English when they are not there).
  function closeLabel(name) {
    let text = 'Close {name}';
    try {
      const lang = global.document.documentElement.lang === 'ja' ? 'ja' : 'en';
      if (typeof I18N !== 'undefined' && I18N[lang] && I18N[lang].tabCloseLabel) text = I18N[lang].tabCloseLabel;
    } catch (e) { /* keep the English default */ }
    return text.replace('{name}', name);
  }

  function markTabs(doc) {
    const list = doc.getElementById('tabs-list');
    if (!list) return;
    list.setAttribute('role', 'tablist');
    const apply = function () {
      list.querySelectorAll('.tab-item').forEach(function (t) {
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-selected', t.classList.contains('active') ? 'true' : 'false');
        const close = t.querySelector('.tab-close');
        if (close) {
          close.setAttribute('role', 'button');
          const name = (t.querySelector('.tab-title') || t).textContent.replace(/[●×\s]+$/g, '').trim();
          close.setAttribute('aria-label', closeLabel(name));
        }
      });
    };
    applyTabs = apply;
    apply();
    if (global.MutationObserver) new global.MutationObserver(apply).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  function trapTab(doc, e) {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const dialogs = openDialogs(doc);
    if (!dialogs.length) return;
    const top = dialogs[dialogs.length - 1];
    const items = Array.prototype.filter.call(top.querySelectorAll(FOCUSABLE), isVisible);
    const idx = items.indexOf(doc.activeElement);
    const next = nextTrapIndex(items.length, idx, e.shiftKey);
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
    }
  }

  function watchDialogs(doc) {
    doc.addEventListener('focusin', function (e) {
      const t = e.target;
      if (t && t.closest && !t.closest('.modal-backdrop')) lastOutside = t;
    });
    doc.addEventListener('keydown', function (e) { trapTab(doc, e); }, true);
    if (!global.MutationObserver) return;
    doc.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
      let wasOpen = !backdrop.classList.contains('hidden');
      let opener = null;
      new global.MutationObserver(function () {
        const open = !backdrop.classList.contains('hidden');
        if (open === wasOpen) return;
        wasOpen = open;
        if (open) { opener = lastOutside; return; }
        // Closed: if focus would be lost on <body> (or is still inside the hidden dialog), give it back.
        global.requestAnimationFrame(function () {
          const a = doc.activeElement;
          if (a && a !== doc.body && !backdrop.contains(a)) return;
          const target = (opener && opener.isConnected && isVisible(opener)) ? opener : (doc.getElementById('editor'));
          if (target && target.focus) target.focus();
        });
      }).observe(backdrop, { attributes: true, attributeFilter: ['class'] });
    });
  }

  // Everything that depends on the current text: call again after the UI language changes.
  function refresh(doc) {
    doc = doc || global.document;
    if (!doc) return;
    labelButtons(doc);
    if (applyTabs) applyTabs();
  }

  function init(doc) {
    doc = doc || global.document;
    if (!doc || doc.documentElement.getAttribute('data-a11y') === '1') return;
    doc.documentElement.setAttribute('data-a11y', '1');
    markDialogs(doc);
    markLiveRegions(doc);
    markStatusToggles(doc);
    markTabs(doc);
    watchDialogs(doc);
    refresh(doc);
  }

  const api = { init: init, refresh: refresh, needsLabel: needsLabel, nextTrapIndex: nextTrapIndex };
  global.A11y = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof document !== 'undefined') {
    init(document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
