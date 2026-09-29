// MD-Memo: putting a long, many-line text into a note without freezing the window.
//
//   BulkInsert.wanted(text, noteText) -> boolean   is the plain insert too slow for this text in this note?
//   BulkInsert.exec(editor, text) -> boolean       inserts `text` at the selection of the focused editor, in one step
//
// Why. Every insertion that must stay one Ctrl+Z step (an AI answer, an agent or command result, a pasted table, a write over the
// JSON-RPC port) goes through document.execCommand('insertText'). Chromium applies that command one line at a time, and each
// line costs a pass over the whole textarea plus its own `input` event (which the app answers each time): the time grows with
// (new lines) x (lines already in the note). Measured in Edge: 2,000 lines into an empty note ~2.2 s (~5.8 s in the app, where
// every event runs the app's handlers), 100 lines into a 20,000-line note ~2 s, 4,000 lines ~20 s, 100,000 lines never ends.
// The 'insertHTML' command with the text escaped inserts the very same characters as ONE editing step: a native undo entry, no
// per-line work (2,000 lines ~25 ms, 100,000 lines ~0.9 s), and ONE input event.
//
// A short text, or a long one into a short note, keeps the plain command (wanted() says no): that path is the proven one and is
// already instant, and typing never comes here. The callers still compare the note with what it must be afterwards and set
// it directly if the command changed a character, exactly as they do for 'insertText'.
//
// Pure apart from exec(); nothing runs until a long text is inserted, so it costs nothing at start-up.
(function (global) {
  'use strict';

  // Fewer new lines than this never count as "long", whatever the size of the note (a Tab, an Enter, a pasted sentence).
  const MIN_NEWLINES = 8;
  // The plain command's cost is about newlines x (lines in the note + newlines) microseconds (see above); this is ~20 ms of it.
  const WORK_LIMIT = 20000;

  function countNewlines(text) {
    let n = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
    return n;
  }

  // text: what is about to be inserted; noteText: what the editor holds now (before the insertion).
  function wanted(text, noteText) {
    if (typeof text !== 'string' || text.length < MIN_NEWLINES) return false;
    const added = countNewlines(text);
    if (added < MIN_NEWLINES) return false;
    return added * (countNewlines(String(noteText || '')) + added) >= WORK_LIMIT;
  }

  // Text -> the HTML that reads back as exactly that text. Line breaks stay as they are: the editor keeps them (white-space: pre-wrap),
  // and this way the command needs no <br> elements to unwrap.
  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Replaces the selection of the focused `editor` with `text`. False when the browser refused the command; it may throw.
  // The app relies on the `input` event (dirty mark, autosave, line numbers, the tab's copy of the text). Chromium sends one for this
  // command; where an engine sends none, exactly one is sent here, so the caller can count on it either way.
  function exec(editor, text) {
    let seen = false;
    const mark = function () { seen = true; };
    const canListen = !!editor && typeof editor.addEventListener === 'function';
    if (canListen) editor.addEventListener('input', mark, true);
    let ok;
    try {
      ok = global.document.execCommand('insertHTML', false, escapeHtml(text));
    } finally {
      if (canListen) editor.removeEventListener('input', mark, true);
    }
    if (ok && !seen && editor && typeof editor.dispatchEvent === 'function') {
      const Ev = typeof global.InputEvent === 'function' ? global.InputEvent : global.Event;
      if (typeof Ev === 'function') editor.dispatchEvent(new Ev('input', { bubbles: true, inputType: 'insertText' }));
    }
    return ok;
  }

  const api = { wanted: wanted, exec: exec, escapeHtml: escapeHtml, MIN_NEWLINES: MIN_NEWLINES, WORK_LIMIT: WORK_LIMIT };
  global.BulkInsert = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
