// MD-Memo Shared Platform Info
// -----------------------------------------------------------------------------
// app.js keeps its own `isMac` as a private const inside its IIFE, so files that
// live outside that closure (jev_action.js, slot_agent.js, task_manager.js)
// previously had no reliable way to branch on platform and ended up hardcoding
// Windows-flavored hints (e.g. "Alt+1..3", "Alt+T"). This file is loaded FIRST
// in index.html and exposes a small, read-only platform surface on
// `window.MDMemoPlatform` that every other frontend file can consult.
//
// Every consumer must degrade gracefully when `window.MDMemoPlatform` is
// undefined: the Node unit tests for jev_action.js / slot_agent.js /
// task_manager.js load those files standalone (no index.html, no script load
// order), so `window.MDMemoPlatform` simply won't exist there.
(function (global) {
  'use strict';

  // Kept byte-identical to the expression app.js uses for its own private
  // `isMac` constant so the two can never disagree about the current platform.
  // (app.js also keeps a local fallback copy of this same expression in case it
  // is ever evaluated before this file, or extracted standalone the way some of
  // the tests under tests/*.mjs do.)
  var isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);

  // True when the platform's own "primary" modifier is held: Cmd on macOS,
  // Ctrl everywhere else. Deliberately does NOT fold Ctrl->Cmd on macOS (unlike
  // some of app.js's legacy shortcut-matching helpers) — this is for new call
  // sites that want an unambiguous, platform-correct single check.
  function isModKey(e) {
    if (!e) return false;
    return isMac ? !!e.metaKey : !!e.ctrlKey;
  }

  // Extracts the physical letter from a KeyboardEvent's `.code`, e.g.
  // 'KeyT' -> 'T'. Unlike `.key`, `.code` is unaffected by Option/Alt
  // composing a different character on macOS (Option+T -> key '†', code
  // still 'KeyT'). Returns '' when `code` isn't a letter key.
  function codeLetter(e) {
    var code = e && e.code;
    if (typeof code !== 'string' || code.slice(0, 3) !== 'Key' || code.length !== 4) return '';
    return code.slice(3);
  }

  // Extracts the physical digit from a KeyboardEvent's `.code`, e.g.
  // 'Digit1' -> '1', 'Numpad1' -> '1'. Same rationale as codeLetter(): on
  // macOS, Option+1/2/3 compose '¡'/'™'/'£' into `.key`, but `.code` still
  // reports the physical digit key. Returns '' when `code` isn't a digit key.
  function codeDigit(e) {
    var code = e && e.code;
    if (typeof code !== 'string') return '';
    if (code.slice(0, 5) === 'Digit' && code.length === 6) return code.slice(5);
    if (code.slice(0, 6) === 'Numpad' && code.length === 7 && code[6] >= '0' && code[6] <= '9') return code.slice(6);
    return '';
  }

  global.MDMemoPlatform = {
    isMac: isMac,
    modLabel: isMac ? 'Cmd' : 'Ctrl',
    altLabel: isMac ? 'Option' : 'Alt',
    isModKey: isModKey,
    codeLetter: codeLetter,
    codeDigit: codeDigit
  };
})(typeof window !== 'undefined' ? window : this);
