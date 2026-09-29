// The floating input panels (Ask Ctrl+L, Rewrite Ctrl+K, Command Ctrl+E, Suggest Ctrl+J) close themselves when the user
// moves on: focus leaves the panel, a short grace passes, then the panel fades out. The rules (docs/design/panel-template.md):
//   * a grace of 0.4 s first, so a click that only passes through the editor, or a mis-click, does not lose the panel;
//   * then a 0.2 s fade; focus coming back during the grace or the fade cancels it and the panel stays;
//   * text the user typed keeps the panel open (it would be lost), and so does work in progress (a running command);
//   * the whole window going inactive (Alt+Tab) is not "moving on": nothing closes until the user is back and still elsewhere;
//   * with the OS "reduce motion" setting the fade is skipped but the grace stays.
// The panel owns its own show/hide; this module only decides when to ask it to close. Unused, it costs nothing: a panel that
// is never focused out never starts a timer.
(function (global) {
  'use strict';

  const GRACE_MS = 400;
  const FADE_MS = 200;
  const FADING_CLASS = 'panel-fading';

  // ---- pure decision (exported for Node tests) ----------------------------------------------

  // Whether a panel whose grace has just run out should now start to fade.
  //   open          the panel is still showing
  //   windowActive  the window (document) has focus
  //   focusInside   focus is on the panel itself or on the element it belongs to (the editor, for the suggest panel)
  //   typed         the user typed something into it that a close would discard
  //   busy          it is running something
  function shouldFade(s) {
    if (!s || !s.open) return false;
    if (s.windowActive === false) return false;
    if (s.focusInside) return false;
    if (s.typed) return false;
    if (s.busy) return false;
    return true;
  }

  // ---- controller ---------------------------------------------------------------------------

  // create(el, opts) → { arm, cancel, reset, isFading }
  //   opts.isOpen()          required. Is the panel showing?
  //   opts.close()           required. Hide the panel (the caller's own close, which restores focus etc.).
  //   opts.isInside(node)    is `node` part of this panel? default: el.contains(node)
  //   opts.getValue()        optional. Current text of the panel's input; empty text never counts as typed.
  //   opts.isBusy()          optional. True while the panel is running something.
  //   opts.refocus()         optional. Put focus back on the panel's input. Used when the user presses on a blank part of the
  //                          panel (the hint line, the chip), which moves focus to <body> although they are still in the panel.
  //   opts.watchFocus        default true. Listen to focusout/focusin on el itself (the panels that own an input). The suggest
  //                          panel has no focusable content and calls arm()/cancel() from the editor's blur/focus instead.
  //   opts.doc / opts.win / opts.timers   test seams.
  function create(el, opts) {
    const o = opts || {};
    const doc = o.doc || (typeof document !== 'undefined' ? document : null);
    const win = o.win || (typeof window !== 'undefined' ? window : null);
    const timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) };
    let graceTimer = null;
    let fadeTimer = null;
    let fading = false;
    let dirty = false;
    let pressedInside = false;

    function reducedMotion() {
      try {
        return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
      } catch (e) {
        return false;
      }
    }

    function inside(node) {
      if (!node) return false;
      if (typeof o.isInside === 'function') return !!o.isInside(node);
      return !!(el && el.contains && el.contains(node));
    }

    // Stop everything and bring a half-faded panel back.
    function cancel() {
      if (graceTimer !== null) { timers.clearTimeout(graceTimer); graceTimer = null; }
      if (fadeTimer !== null) { timers.clearTimeout(fadeTimer); fadeTimer = null; }
      if (fading) {
        fading = false;
        if (el && el.classList) el.classList.remove(FADING_CLASS);
      }
    }

    // A freshly opened panel starts clean: nothing typed, nothing pending.
    function reset() {
      dirty = false;
      cancel();
    }

    function state() {
      const value = typeof o.getValue === 'function' ? String(o.getValue() || '').trim() : '';
      return {
        open: !!o.isOpen(),
        windowActive: doc && typeof doc.hasFocus === 'function' ? doc.hasFocus() : true,
        focusInside: inside(doc ? doc.activeElement : null),
        typed: dirty && value !== '',
        busy: typeof o.isBusy === 'function' ? !!o.isBusy() : false
      };
    }

    function startFade() {
      fading = true;
      if (el && el.classList) el.classList.add(FADING_CLASS);
      fadeTimer = timers.setTimeout(() => {
        fadeTimer = null;
        fading = false;
        if (el && el.classList) el.classList.remove(FADING_CLASS);
        if (o.isOpen()) o.close();
      }, reducedMotion() ? 0 : FADE_MS);
    }

    // Focus left the panel: start the grace. Called again while a grace or fade runs, it starts over.
    function arm() {
      cancel();
      if (!o.isOpen()) return;
      graceTimer = timers.setTimeout(() => {
        graceTimer = null;
        if (shouldFade(state())) startFade();
      }, GRACE_MS);
    }

    if (el && o.watchFocus !== false && typeof el.addEventListener === 'function') {
      el.addEventListener('focusout', (e) => {
        if (e && e.relatedTarget && inside(e.relatedTarget)) return;
        if (pressedInside) return; // a press on a blank part of the panel: handled by the mousedown below
        arm();
      });
      // The focus change of a press happens right after mousedown, before any timer: remember it, then hand focus back.
      el.addEventListener('mousedown', () => {
        pressedInside = true;
        timers.setTimeout(() => {
          pressedInside = false;
          if (typeof o.refocus === 'function' && o.isOpen() && doc && !inside(doc.activeElement)) o.refocus();
        }, 0);
      });
      el.addEventListener('focusin', cancel);
      el.addEventListener('input', () => { dirty = true; });
    }
    // Back in the window with focus still elsewhere: the grace starts then, not while the user was away.
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('focus', () => {
        if (o.isOpen() && !inside(doc ? doc.activeElement : null)) arm();
      });
    }

    return { arm: arm, cancel: cancel, reset: reset, isFading: () => fading };
  }

  const api = { GRACE_MS: GRACE_MS, FADE_MS: FADE_MS, FADING_CLASS: FADING_CLASS, shouldFade: shouldFade, create: create };
  global.PanelFade = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
