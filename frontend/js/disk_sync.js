// MD-Memo: telling whether a note's file still holds the text the tab came from, and keeping a file's own line endings.
//
//   DiskSync.sum(text)               fingerprint of a note's text (line endings do not count); identical to pkg/textsig.Sum in Go
//   DiskSync.detectEol(text)         'crlf' when the file used CRLF for most of its line breaks, else 'lf'
//   DiskSync.applyEol(text, eol)     the text as it is written to a file with that line ending
//   DiskSync.planExternalChange(o)   what to do when the file is seen changed on disk: 'ignore' | 'reload' | 'conflict'
//
// Why. A tab holds a text; the file on disk can change without the tab knowing (another editor, a Git pull, a sync client, an agent,
// the file changing while the app was closed). The next save wrote the tab's text over it and the other change was gone. Each tab
// now remembers the fingerprint of the text it last read from, or wrote to, its file (tab.diskSig); a save sends it along and the
// Go side refuses to write when the file's text no longer matches (SaveFileChecked), so the person is asked instead.
//
// And the textarea hands back LF whatever the file used, so a CRLF file was silently rewritten with LF after one edit (every line
// shows as changed in Git). The tab remembers the file's line ending (tab.eol) and a save writes it back.
//
// Pure functions; nothing runs until a note with a file is opened or saved.
(function (global) {
  'use strict';

  function lf(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  // cyrb53 over UTF-16 code units, two 32-bit lanes (the same arithmetic, in uint32, as pkg/textsig.Sum).
  function sum(text) {
    const s = lf(text);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return s.length.toString(16) + '-' + value.toString(16);
  }

  // The file's own line ending, from its text as read (before the editor turned it into LF).
  function detectEol(text) {
    const s = String(text == null ? '' : text);
    let crlf = 0;
    let bare = 0;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) {
      if (i > 0 && s.charCodeAt(i - 1) === 13) crlf++;
      else bare++;
    }
    return crlf > bare ? 'crlf' : 'lf';
  }

  function applyEol(text, eol) {
    if (eol !== 'crlf' || typeof text !== 'string') return text;
    if (text.indexOf('\n') === -1) return text;
    return lf(text).replace(/\n/g, '\r\n');
  }

  // o: { tabSig, diskSig, hasUnsavedText }. tabSig is what the tab last knew of the file ('' when it never knew), diskSig what the
  // file holds now.
  //   ignore    the file is what the tab knows: the app's own save, or a touch that changed nothing
  //   reload    the tab has nothing unsaved: show the file as it is now
  //   conflict  the tab has unsaved text AND the file changed under it: do not write until the person chooses
  function planExternalChange(o) {
    const tabSig = (o && o.tabSig) || '';
    const diskSig = (o && o.diskSig) || '';
    if (!diskSig || (tabSig && tabSig === diskSig)) return 'ignore';
    if (!(o && o.hasUnsavedText)) return 'reload';
    return tabSig ? 'conflict' : 'ignore'; // unsaved text and no memory of the file: nothing to compare, the old behaviour
  }

  const api = { sum: sum, lf: lf, detectEol: detectEol, applyEol: applyEol, planExternalChange: planExternalChange };
  global.DiskSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
