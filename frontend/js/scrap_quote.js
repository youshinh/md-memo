// MD-Memo: what to put in a search box when Ctrl+F or Ctrl+Shift+F opens it, and what to insert when a
// scrap-search result is quoted into the note (Tab).
//
//  - The selection wins: the first non-empty line of it (both searches are line searches, so a
//    multi-line selection cannot match as a whole).
//  - Ctrl+Shift+F, with nothing selected, takes the word just before the caret ("ESP32|" -> ESP32),
//    so typing a term and pressing the key searches for it.
//
// Pure functions only: no DOM, nothing runs until one of the two searches is opened.
(function (global) {
  'use strict';

  const SEED_MAX = 200; // characters (code points) of a selection used as a query
  const WORD_MAX = 60;

  function clip(text, max) {
    const chars = Array.from(text);
    return chars.length > max ? chars.slice(0, max).join('') : text;
  }

  // The first non-empty line of a selection, trimmed and cut to SEED_MAX; '' when there is none.
  function seedFromSelection(text) {
    if (!text) return '';
    const lines = String(text).split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t) return clip(t, SEED_MAX);
    }
    return '';
  }

  // Characters that end a word but carry no meaning of their own (spaces, punctuation, brackets, quotes),
  // ASCII and full-width alike.
  const SEPARATORS = /[\s　、。，．,.;:；：!?！？…・「」『』（）()\[\]{}"'`<>“”‘’]+$/;
  const LATIN_WORD = /[A-Za-z0-9_À-ɏ０-９Ａ-Ｚａ-ｚ][A-Za-z0-9_À-ɏ０-９Ａ-Ｚａ-ｚ.\-+#@\/:]*$/;
  // Katakana, kanji (and the iteration marks): the parts of a Japanese phrase worth searching for.
  const CJK_WORD = /[゠-ヿ㐀-鿿豈-﫿々]+$/;
  const HIRAGANA_TAIL = /[぀-ゟ]{1,12}$/;

  // The word that ends at (or just before) `pos` on its line, or ''. "ESP32|" and "ESP32 |" give ESP32;
  // "ピン配置なんだっけ？|" gives ピン配置 (the trailing hiragana is skipped: it is usually a particle or an
  // ending); text that has no such word gives ''.
  function wordBeforeCaret(value, pos) {
    const text = String(value == null ? '' : value);
    const end = Math.max(0, Math.min(text.length, pos == null ? text.length : pos));
    const lineStart = text.lastIndexOf('\n', end - 1) + 1;
    let head = text.slice(lineStart, end).replace(SEPARATORS, '');
    if (HIRAGANA_TAIL.test(head)) {
      head = head.replace(HIRAGANA_TAIL, '').replace(SEPARATORS, '');
    }
    let m = LATIN_WORD.exec(head);
    if (m) {
      const word = m[0].replace(/[.:\/\-+]+$/, '');
      return word ? clip(word, WORD_MAX) : '';
    }
    m = CJK_WORD.exec(head);
    if (m) return Array.from(m[0]).slice(-30).join('');
    return '';
  }

  // The query for a search opened with the caret/selection (start, end) of `value`. `allowWord` is true for
  // the scrap search, which may fall back to the word before the caret; the in-note find only uses a selection.
  function searchSeed(value, start, end, allowWord) {
    if (end > start) return seedFromSelection(String(value).slice(start, end));
    return allowWord ? wordBeforeCaret(value, start) : '';
  }

  // What Tab inserts for a result: the matching line, without its line ending or trailing spaces.
  function quoteText(match) {
    if (!match) return '';
    return String(match.lineText == null ? '' : match.lineText).replace(/[\r\n]+/g, ' ').replace(/\s+$/, '');
  }

  global.ScrapQuote = {
    seedFromSelection: seedFromSelection,
    wordBeforeCaret: wordBeforeCaret,
    searchSeed: searchSeed,
    quoteText: quoteText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.ScrapQuote;
  }
})(typeof window !== 'undefined' ? window : globalThis);
