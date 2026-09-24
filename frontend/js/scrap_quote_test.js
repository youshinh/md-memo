// Unit tests for scrap_quote.js: the search seed (selection, or the word before the caret) and the text a
// scrap-search result inserts.
const assert = require('assert');

global.window = global;
const SQ = require('./scrap_quote.js');

(function testSeedFromSelection() {
  assert.strictEqual(SQ.seedFromSelection('ESP32'), 'ESP32');
  assert.strictEqual(SQ.seedFromSelection('  ESP32 pin  '), 'ESP32 pin', 'trimmed');
  assert.strictEqual(SQ.seedFromSelection(''), '');
  assert.strictEqual(SQ.seedFromSelection(null), '');
  assert.strictEqual(SQ.seedFromSelection(undefined), '');
  assert.strictEqual(SQ.seedFromSelection('\n\n  \n'), '', 'only blank lines: nothing to search for');
  assert.strictEqual(SQ.seedFromSelection('first line\nsecond line'), 'first line', 'a line search: the first line of a multi-line selection');
  assert.strictEqual(SQ.seedFromSelection('\n\n  second\nthird'), 'second', 'leading blank lines are skipped');
  assert.strictEqual(SQ.seedFromSelection('a\r\nb'), 'a', 'CRLF');
  const long = 'x'.repeat(500);
  assert.strictEqual(SQ.seedFromSelection(long).length, 200, 'cut to 200 characters');
  const emoji = '😀'.repeat(300);
  assert.strictEqual(Array.from(SQ.seedFromSelection(emoji)).length, 200, 'cut on code points, never inside a surrogate pair');
})();

(function testWordBeforeCaret() {
  const w = SQ.wordBeforeCaret;
  assert.strictEqual(w('ESP32', 5), 'ESP32');
  assert.strictEqual(w('ESP32 ', 6), 'ESP32', 'a space after the word');
  assert.strictEqual(w('pin of ESP32', 12), 'ESP32', 'the last word only');
  assert.strictEqual(w('pin of ESP32, ', 14), 'ESP32', 'punctuation after the word');
  assert.strictEqual(w('see foo/bar.go:', 15), 'foo/bar.go', 'a path keeps its slashes and dots, not the trailing colon');
  assert.strictEqual(w('call my_func()', 14), 'my_func', 'brackets are separators');
  assert.strictEqual(w('user@example.com', 16), 'user@example.com');
  assert.strictEqual(w('v1.2.', 5), 'v1.2', 'a trailing dot is dropped');
  assert.strictEqual(w('ESP32のピン配置', 10), 'ピン配置', 'katakana and kanji run, stopped by the hiragana particle');
  assert.strictEqual(w('ESP32のピン配置なんだっけ？', 17), 'ピン配置', 'trailing hiragana and the question mark are skipped');
  assert.strictEqual(w('会議メモ', 4), '会議メモ');
  assert.strictEqual(w('今日は', 3), '今日', 'a lone particle at the end is skipped');
  assert.strictEqual(w('ＥＳＰ３２', 5), 'ＥＳＰ３２', 'full-width Latin counts as a word');
  assert.strictEqual(w('', 0), '');
  assert.strictEqual(w('   ', 3), '');
  assert.strictEqual(w('。。。', 3), '');
  assert.strictEqual(w('ひらがなだけ', 6), '', 'hiragana alone is not a searchable word');
  // only the caret's own line counts
  assert.strictEqual(w('first ESP32\n', 12), '', 'the caret is on an empty line');
  assert.strictEqual(w('first ESP32\nsecond', 18), 'second');
  // the caret in the middle of the text: what follows it is ignored
  assert.strictEqual(w('alpha beta gamma', 10), 'beta');
  assert.strictEqual(w('alpha beta gamma', 0), '');
  assert.strictEqual(w('alpha', 99), 'alpha', 'a position past the end is clamped');
  assert.strictEqual(w('alpha', -3), '');
  assert.strictEqual(w('x'.repeat(200), 200).length, 60, 'a very long token is cut');
})();

(function testSearchSeed() {
  const text = 'note about ESP32 pins\nnext line';
  // a selection wins over the word before the caret
  assert.strictEqual(SQ.searchSeed(text, 11, 16, true), 'ESP32');
  assert.strictEqual(SQ.searchSeed(text, 11, 16, false), 'ESP32');
  // no selection: the scrap search takes the word, the in-note find does not
  assert.strictEqual(SQ.searchSeed(text, 16, 16, true), 'ESP32');
  assert.strictEqual(SQ.searchSeed(text, 16, 16, false), '');
  // a selection across lines seeds with its first line
  assert.strictEqual(SQ.searchSeed(text, 11, 30, true), 'ESP32 pins');
  // a selection that is only whitespace falls back to nothing (not to the word: the user did select something)
  assert.strictEqual(SQ.searchSeed('a   b', 1, 4, true), '');
})();

(function testQuoteText() {
  assert.strictEqual(SQ.quoteText({ lineText: '- GPIO21 = SDA' }), '- GPIO21 = SDA');
  assert.strictEqual(SQ.quoteText({ lineText: 'line   ' }), 'line', 'trailing spaces dropped');
  assert.strictEqual(SQ.quoteText({ lineText: 'line\r' }), 'line', 'a CR from a CRLF file');
  assert.strictEqual(SQ.quoteText({ lineText: '  indented' }), '  indented', 'leading indentation is kept');
  assert.strictEqual(SQ.quoteText({}), '');
  assert.strictEqual(SQ.quoteText(null), '');
})();

console.log('scrap_quote tests passed');
