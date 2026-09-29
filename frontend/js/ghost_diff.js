// MD-Memo "ghost diff": the few seconds of amber glow and left-edge bar that confirm where a result landed
// (an AI answer, a rewrite, a command's output, a {{ }} / {{ @agent }} result).
//
// It used to be a class on the whole <textarea>, so the bar ran down the full height of the editor and the whole
// note glowed, however small the change. It is now a band over just the rows that changed. A textarea cannot be
// asked where a range is, so the rows come from the same hidden-mirror measurement the caret aura uses
// (window.getCharPixelCoords, defined by app.js); the band is an absolutely positioned <div> in the editor's wrapper.
//
// The band is a transient cue and must never point at the wrong text, so it goes away as soon as the text under it is
// not what was marked: on the user's own typing, when the note changes under it (a tab switch, an undo), and after
// its time. It follows the editor's scroll while it lasts. Nothing exists until a result lands.
(function (global) {
  'use strict';

  const BAND_CLASS = 'ghost-diff-band';
  const DEFAULT_MS = 4000;
  const CHECK_MS = 200;

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // The characters of [start, end) that get the band: the line breaks around a result (it usually lands between blank
  // lines) do not count. Returns { from, last, text }: the first and the last marked character and their text. When
  // nothing visible was added (an empty result, only line breaks) the one character at `start` stands for the place.
  function markedRange(value, start, end) {
    const len = value.length;
    let a = Math.min(Math.max(Number(start) || 0, 0), len);
    let b = Math.min(Math.max(Number(end) || 0, a), len);
    while (a < b && (value.charCodeAt(a) === 10 || value.charCodeAt(a) === 13)) a++;
    while (b > a && (value.charCodeAt(b - 1) === 10 || value.charCodeAt(b - 1) === 13)) b--;
    if (b === a) b = Math.min(a + 1, len);
    return { from: a, last: Math.max(a, b - 1), text: value.slice(a, b) };
  }

  // The band's box in content pixels: from the top of the row that holds the first marked character to the bottom of
  // the row that holds the last one. `top` is the row's top as the mirror measures it (top padding included).
  function bandBox(topOfFirst, topOfLast, lineHeight) {
    return { top: topOfFirst, height: Math.max(lineHeight, topOfLast - topOfFirst + lineHeight) };
  }

  // ---- DOM ----------------------------------------------------------------------------------

  const states = new WeakMap(); // editor -> { bands: Set<band>, onScroll, onInput, timer }

  function lineHeightOf(editor) {
    try {
      const cs = global.getComputedStyle(editor);
      const px = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : NaN;
      if (px > 0) return px;
      const fs = parseFloat(cs.fontSize);
      if (fs > 0) return fs * 1.6;
    } catch (e) { /* no layout here */ }
    return 22.4;
  }

  function removeBand(editor, st, band) {
    if (!st.bands.delete(band)) return;
    if (band.el && band.el.parentNode && typeof band.el.parentNode.removeChild === 'function') {
      band.el.parentNode.removeChild(band.el);
    }
    clearTimeout(band.timeout);
    if (st.bands.size === 0) release(editor, st);
  }

  function release(editor, st) {
    if (st.timer) clearInterval(st.timer);
    st.timer = null;
    if (typeof editor.removeEventListener === 'function') {
      editor.removeEventListener('scroll', st.onScroll);
      editor.removeEventListener('input', st.onInput);
    }
    st.listening = false;
  }

  function stateOf(editor) {
    let st = states.get(editor);
    if (st) return st;
    st = { bands: new Set(), listening: false, timer: null, onScroll: null, onInput: null };
    st.onScroll = function () {
      st.bands.forEach(function (b) { b.el.style.top = (b.top - (editor.scrollTop || 0)) + 'px'; });
    };
    // The user's own typing (isTrusted) moves or replaces the marked text. The scripted 'input' events that follow a
    // result being merged are not the user's and must not end the cue.
    st.onInput = function (e) {
      if (e && e.isTrusted === true) clear(editor);
    };
    states.set(editor, st);
    return st;
  }

  // Drops every band of this editor now.
  function clear(editor) {
    const st = states.get(editor);
    if (!st) return;
    Array.from(st.bands).forEach(function (b) { removeBand(editor, st, b); });
  }

  // Marks [start, end) of the editor's current text. opts: { durationMs, getCoords, lineHeight }.
  // Returns true when a band was drawn; false when it could not be placed (no layout, a huge note whose row positions
  // are only estimated, a stand-in editor in a test): then there is simply no cue.
  function flash(editor, start, end, opts) {
    try {
      opts = opts || {};
      if (!editor || typeof document === 'undefined') return false;
      const wrap = editor.parentElement;
      if (!wrap || typeof wrap.appendChild !== 'function') return false;
      const getCoords = opts.getCoords || global.getCharPixelCoords;
      if (typeof getCoords !== 'function') return false;

      const value = String(editor.value || '');
      const r = markedRange(value, start, end);
      if (!r.text) return false;
      const c0 = getCoords(r.from, editor);
      const c1 = r.last > r.from ? getCoords(r.last, editor) : c0;
      if (!c0 || !c1 || c0.estimated || c1.estimated) return false;
      const box = bandBox(c0.top, c1.top, opts.lineHeight || lineHeightOf(editor));
      const duration = opts.durationMs > 0 ? opts.durationMs : DEFAULT_MS;

      // A band is positioned against the wrapper; the two editor panes' wrappers are already positioned.
      try {
        if (global.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      } catch (e) { /* keep going */ }

      const st = stateOf(editor);
      const el = document.createElement('div');
      el.className = BAND_CLASS;
      el.setAttribute('aria-hidden', 'true');
      el.style.top = (box.top - (editor.scrollTop || 0)) + 'px';
      el.style.height = box.height + 'px';
      el.style.setProperty('--ghost-diff-duration', duration + 'ms');
      wrap.appendChild(el);

      const band = { el: el, top: box.top, from: r.from, text: r.text, timeout: null };
      band.timeout = setTimeout(function () { removeBand(editor, st, band); }, duration);
      st.bands.add(band);

      if (!st.listening) {
        st.listening = true;
        editor.addEventListener('scroll', st.onScroll, { passive: true });
        editor.addEventListener('input', st.onInput);
        // The text under the band changed without the user typing (another note loaded into this textarea, an undo):
        // the band would sit over the wrong text.
        st.timer = setInterval(function () {
          const now = String(editor.value || '');
          st.bands.forEach(function (b) {
            if (now.substr(b.from, b.text.length) !== b.text) removeBand(editor, st, b);
          });
        }, CHECK_MS);
      }
      return true;
    } catch (e) {
      return false; // a visual nicety: never worth failing a merge over
    }
  }

  const api = { flash: flash, clear: clear, markedRange: markedRange, bandBox: bandBox };
  global.GhostDiff = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
