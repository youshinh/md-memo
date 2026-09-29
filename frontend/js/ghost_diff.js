// MD-Memo "ghost diff": the few seconds of amber glow and left-edge bar that confirm where a result landed
// (an AI answer, a rewrite, a command's output, a {{ }} / {{ @agent }} result, a Quick Actions insert).
//
// It used to be a class on the whole <textarea>, so the bar ran down the full height of the editor and the whole
// note glowed, however small the change. It is now a band over just the rows that changed. A textarea cannot be
// asked where a range is, so the rows come from the same hidden-mirror measurement the caret aura uses
// (window.getCharPixelCoords, defined by app.js); the band is an absolutely positioned <div> in the editor's wrapper.
//
// The band is a transient cue and must never point at the wrong text. It is bound to the text it marks: whenever the
// note changes (typing, another result landing, an undo, a note loaded into this textarea) the marked text is looked
// for again, the band moves with it, and it goes away when that text is no longer there or after its time. Several
// results in flight each keep their own band. It follows the editor's scroll while it lasts. Nothing exists until a
// result lands.
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

  // Where the marked text is now, or -1. `was` is where it started and `wasLength` how long the note was when that was
  // known. The common cases cost one comparison: nothing moved, or text went in/out above it (the note grew or shrank
  // by delta and the marked text moved by the same amount). Anything else is searched for.
  function locate(value, text, was, wasLength) {
    if (value.startsWith(text, was)) return was;
    const shifted = was + (value.length - wasLength);
    if (shifted >= 0 && shifted !== was && value.startsWith(text, shifted)) return shifted;
    return value.indexOf(text);
  }

  // ---- DOM ----------------------------------------------------------------------------------

  const states = new WeakMap(); // editor -> { bands: Set<band>, listening, timer, onScroll, onChange }

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
      editor.removeEventListener('input', st.onChange);
    }
    st.listening = false;
  }

  // Puts the band over the rows of `pos`..`pos + text.length - 1`. False when the rows cannot be measured (a huge note
  // whose row positions are only estimated).
  function place(editor, band, pos) {
    const c0 = band.getCoords(pos, editor);
    const lastPos = pos + band.text.length - 1;
    const c1 = lastPos > pos ? band.getCoords(lastPos, editor) : c0;
    if (!c0 || !c1 || c0.estimated || c1.estimated) return false;
    const box = bandBox(c0.top, c1.top, band.lineHeight || lineHeightOf(editor));
    band.top = box.top;
    band.from = pos;
    band.scrollHeight = editor.scrollHeight;
    band.el.style.top = (box.top - (editor.scrollTop || 0)) + 'px';
    band.el.style.height = box.height + 'px';
    return true;
  }

  // Runs on every change of the note: keeps each band on its text, and drops the ones whose text is gone.
  function refresh(editor, st) {
    const value = String(editor.value || '');
    Array.from(st.bands).forEach(function (b) {
      const pos = locate(value, b.text, b.from, b.noteLength);
      b.noteLength = value.length;
      if (pos < 0) { removeBand(editor, st, b); return; }
      // Measuring costs a layout of the text before the band: only when it moved or the rows above changed.
      if (pos !== b.from || editor.scrollHeight !== b.scrollHeight) {
        if (!place(editor, b, pos)) removeBand(editor, st, b);
      }
    });
  }

  function stateOf(editor) {
    let st = states.get(editor);
    if (st) return st;
    st = { bands: new Set(), listening: false, timer: null, onScroll: null, onChange: null };
    st.onScroll = function () {
      st.bands.forEach(function (b) { b.el.style.top = (b.top - (editor.scrollTop || 0)) + 'px'; });
    };
    st.onChange = function () { refresh(editor, st); };
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
      const duration = opts.durationMs > 0 ? opts.durationMs : DEFAULT_MS;

      // A band is positioned against the wrapper; the two editor panes' wrappers are already positioned.
      try {
        if (global.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      } catch (e) { /* keep going */ }

      const st = stateOf(editor);
      const el = document.createElement('div');
      el.className = BAND_CLASS;
      el.setAttribute('aria-hidden', 'true');
      el.style.setProperty('--ghost-diff-duration', duration + 'ms');
      const band = {
        el: el, text: r.text, from: r.from, top: 0, scrollHeight: 0, noteLength: value.length,
        getCoords: getCoords, lineHeight: opts.lineHeight || 0, timeout: null
      };
      if (!place(editor, band, r.from)) return false;
      wrap.appendChild(el);
      band.timeout = setTimeout(function () { removeBand(editor, st, band); }, duration);
      st.bands.add(band);

      if (!st.listening) {
        st.listening = true;
        editor.addEventListener('scroll', st.onScroll, { passive: true });
        editor.addEventListener('input', st.onChange);
        // Changes that send no input event (another note loaded into this textarea, a value set by code).
        st.timer = setInterval(st.onChange, CHECK_MS);
      }
      return true;
    } catch (e) {
      return false; // a visual nicety: never worth failing a merge over
    }
  }

  const api = { flash: flash, clear: clear, markedRange: markedRange, bandBox: bandBox, locate: locate };
  global.GhostDiff = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
