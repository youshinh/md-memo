// Unit tests for comment_toggle.js: Ctrl+/ on lines (one comment per line, or one around them), the lines that are
// left alone, the refusals, line breaks, the selection afterwards, and round trips.
const assert = require('assert');

global.window = global;
require('./html_comments.js');
const CT = require('./comment_toggle.js');
const HC = global.HtmlComments;

// Applies a result to the text; returns { text, selStart, selEnd }.
function apply(text, r) {
  return { text: text.slice(0, r.start) + r.replacement + text.slice(r.end), selStart: r.selStart, selEnd: r.selEnd };
}

// Toggles with the selection written into the text: « and » around a selection, ¦ for a caret.
function toggle(marked, style) {
  let a;
  let b;
  let text = marked;
  if (text.indexOf('¦') !== -1) {
    a = b = text.indexOf('¦');
    text = text.replace('¦', '');
  } else {
    a = text.indexOf('«');
    text = text.replace('«', '');
    b = text.indexOf('»');
    text = text.replace('»', '');
  }
  assert.ok(a >= 0 && b >= 0, 'the test text marks a selection: ' + marked);
  const r = CT.toggleComment(text, a, b, style);
  return Object.assign({ r }, apply(text, r));
}

// The text with the selection written back in.
function show(o) {
  if (o.selStart === o.selEnd) return o.text.slice(0, o.selStart) + '¦' + o.text.slice(o.selStart);
  return o.text.slice(0, o.selStart) + '«' + o.text.slice(o.selStart, o.selEnd) + '»' + o.text.slice(o.selEnd);
}

// ---- line style ----------------------------------------------------------------------------------------------------

(function testSingleLineCaret() {
  let o = toggle('first\nsec¦ond\nthird');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(show(o), 'first\n<!-- sec¦ond -->\nthird', 'the caret moves with the text');
  o = toggle('first\n<!-- sec¦ond -->\nthird');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(show(o), 'first\nsec¦ond\nthird');
  // caret at the very start and at the very end of the line
  assert.strictEqual(show(toggle('¦abc')), '<!-- ¦abc -->');
  assert.strictEqual(show(toggle('abc¦')), '<!-- abc¦ -->', 'the caret stays before " -->"');
  assert.strictEqual(show(toggle('<!-- abc -->¦')), 'abc¦');
  assert.strictEqual(show(toggle('¦<!-- abc -->')), '¦abc');
  // one replaced range: only the caret's line
  const r = CT.toggleComment('a\nb\nc', 2, 2);
  assert.deepStrictEqual([r.start, r.end, r.replacement], [2, 3, '<!-- b -->']);
  // the default style is 'line'; an unknown style too
  assert.strictEqual(apply('a\nb', CT.toggleComment('a\nb', 0, 3)).text, '<!-- a -->\n<!-- b -->');
  assert.strictEqual(apply('a\nb', CT.toggleComment('a\nb', 0, 3, 'weird')).text, '<!-- a -->\n<!-- b -->');
})();

(function testMultiLineSelection() {
  let o = toggle('«a\nb\nc»');
  assert.strictEqual(o.text, '<!-- a -->\n<!-- b -->\n<!-- c -->');
  assert.strictEqual(show(o), '«<!-- a -->\n<!-- b -->\n<!-- c -->»', 'the selection holds what was written at its edges');
  o = toggle(show(o));
  assert.strictEqual(show(o), '«a\nb\nc»', 'and back');
  // a selection that ends at the start of a line does not take that line
  o = toggle('«a\nb\n»c');
  assert.strictEqual(o.text, '<!-- a -->\n<!-- b -->\nc');
  assert.strictEqual(show(o), '«<!-- a -->\n<!-- b -->\n»c');
  // a selection inside lines takes the whole lines
  o = toggle('xa«b\ncd»y');
  assert.strictEqual(o.text, '<!-- xab -->\n<!-- cdy -->');
  assert.strictEqual(show(o), '<!-- xa«b -->\n<!-- cd»y -->');
  // the selection given backwards
  const r = CT.toggleComment('a\nb', 3, 0);
  assert.strictEqual(apply('a\nb', r).text, '<!-- a -->\n<!-- b -->');
})();

(function testMixedLines() {
  // not all commented: comment the rest, leave the commented ones
  let o = toggle('«a\n<!-- b -->\nc»');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(o.text, '<!-- a -->\n<!-- b -->\n<!-- c -->');
  // all commented: uncomment them all
  o = toggle('«<!-- a -->\n<!--b-->\n  <!--  c  -->»');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(o.text, 'a\nb\n   c ', 'one space inside each delimiter is ours; any more is the text');
})();

(function testIndentationListsQuotes() {
  assert.strictEqual(toggle('«  - item\n    - nested»').text, '  <!-- - item -->\n    <!-- - nested -->', 'indentation stays outside');
  assert.strictEqual(toggle('\t¦code').text, '\t<!-- code -->');
  assert.strictEqual(toggle('«- [ ] task\n1. first»').text, '<!-- - [ ] task -->\n<!-- 1. first -->');
  assert.strictEqual(toggle('«> quote\n> more»').text, '<!-- > quote -->\n<!-- > more -->');
  assert.strictEqual(toggle('¦  <!-- - item -->').text, '  - item');
  assert.strictEqual(toggle('«- {{ @claude do it }}\n[[ @llm x ]]»').text, '<!-- - {{ @claude do it }} -->\n<!-- [[ @llm x ]] -->');
})();

(function testEmptyLinesAndMarkers() {
  let o = toggle('«a\n\n   \nb»');
  assert.strictEqual(o.text, '<!-- a -->\n\n   \n<!-- b -->', 'blank lines are left alone');
  o = toggle('«<!-- a -->\n\n<!-- b -->»');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(o.text, 'a\n\nb');
  const block = '[[ @llm x ]]\n<!-- md-memo:res ab12 -->\nanswer\n<!-- /md-memo:res -->';
  o = toggle('«' + block + '»');
  assert.strictEqual(o.text, '<!-- [[ @llm x ]] -->\n<!-- md-memo:res ab12 -->\n<!-- answer -->\n<!-- /md-memo:res -->', 'markers are never wrapped');
  assert.deepStrictEqual(o.r.skipped, [], 'and not reported: they are structure');
  o = toggle(show(o));
  assert.strictEqual(o.text, block, 'nor unwrapped');
  o = toggle('<!-- md-memo:run ab12 -->¦');
  assert.strictEqual(o.r.status, 'nothing');
  o = toggle('¦');
  assert.strictEqual(o.r.status, 'nothing');
  o = toggle('a\n¦');
  assert.strictEqual(o.r.status, 'nothing', 'the empty last line');
})();

(function testArrowInsideIsSkipped() {
  let o = toggle('«a\nx --> y\nb»');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(o.text, '<!-- a -->\nx --> y\n<!-- b -->');
  assert.deepStrictEqual(o.r.skipped, [2], '1-based line numbers of the text');
  o = toggle('top\n\n«x --> y»');
  assert.strictEqual(o.r.status, 'nothing');
  assert.deepStrictEqual(o.r.skipped, [3]);
  // a line with an inline comment has a "-->": skipped
  o = toggle('¦text <!-- c --> more');
  assert.strictEqual(o.r.status, 'nothing');
  assert.deepStrictEqual(o.r.skipped, [1]);
  // two comments on a line are not one comment: skipped either way
  o = toggle('¦<!-- a --> <!-- b -->');
  assert.strictEqual(o.r.status, 'nothing');
  assert.deepStrictEqual(o.r.skipped, [1]);
  // lines of a comment that spans several lines are skipped (wrapping them would cut it)
  o = toggle('«<!-- start\nmiddle\nend -->\nplain»');
  assert.strictEqual(o.text, '<!-- start\nmiddle\nend -->\n<!-- plain -->');
  assert.deepStrictEqual(o.r.skipped, [1, 2, 3]);
  // uncomment, with a skipped line among them
  o = toggle('«<!-- a -->\nx --> y\n<!-- b -->»');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(o.text, 'a\nx --> y\nb');
  assert.deepStrictEqual(o.r.skipped, [2]);
})();

(function testCrlf() {
  let o = toggle('«a\r\nb\r\n»c\r\n');
  assert.strictEqual(o.text, '<!-- a -->\r\n<!-- b -->\r\nc\r\n', 'the CR stays at the end of the line');
  o = toggle(show(o));
  assert.strictEqual(o.text, 'a\r\nb\r\nc\r\n');
  o = toggle('a\r\nb¦\r\nc');
  assert.strictEqual(show(o), 'a\r\n<!-- b¦ -->\r\nc');
  o = toggle('«x\r\n\r\ny»', 'block');
  assert.strictEqual(o.text, '<!-- x\r\n\r\ny -->');
  assert.strictEqual(toggle(show(o), 'block').text, 'x\r\n\r\ny');
})();

(function testNonAscii() {
  let o = toggle('日本語の¦メモ 😀');
  assert.strictEqual(show(o), '<!-- 日本語の¦メモ 😀 -->');
  o = toggle('😀\n«ー 項目\n　字下げ»\n𠮷');
  assert.strictEqual(o.text, '😀\n<!-- ー 項目 -->\n<!-- 　字下げ -->\n𠮷');
  assert.strictEqual(toggle(show(o)).text, '😀\nー 項目\n　字下げ\n𠮷');
})();

(function testUnclosedAndCode() {
  // an unclosed "<!--" before the lines: the new "-->" would hide everything in between
  let o = toggle('<!-- never closed\ntext\n¦line');
  assert.strictEqual(o.r.status, 'refused');
  assert.strictEqual(o.r.reason, 'unclosed');
  assert.strictEqual(o.text, '<!-- never closed\ntext\nline', 'nothing changed');
  o = toggle('<!-- never closed\n«text»', 'block');
  assert.deepStrictEqual([o.r.status, o.r.reason], ['refused', 'unclosed']);
  // inside the lines it is taken into the new comment, which is fine
  o = toggle('«<!-- never closed\ntext»', 'block');
  assert.strictEqual(o.text, '<!-- <!-- never closed\ntext -->');
  // an unclosed "<!--" on the line itself is wrapped with it
  o = toggle('¦x <!-- y');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(o.text, '<!-- x <!-- y -->');
  assert.strictEqual(toggle(show(o)).text, 'x <!-- y');
  // inside a fenced code block "<!--" is plain text: refused
  o = toggle('```\n¦code\n```');
  assert.strictEqual(o.r.status, 'refused');
  assert.strictEqual(o.r.reason, 'unsafe');
  o = toggle('```\n«a\nb»\n```', 'block');
  assert.strictEqual(o.r.reason, 'unsafe');
  // a literal "<!-- x -->" in code can still be taken off
  o = toggle('```\n¦<!-- x -->\n```');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(o.text, '```\nx\n```');
  // commenting a fence line alone would turn what follows into text: refused
  o = toggle('¦```\n<!-- x -->\n```\n');
  assert.strictEqual(o.r.status, 'refused');
  // the whole fenced block is fine
  o = toggle('«```\ncode\n```»');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(o.text, '<!-- ``` -->\n<!-- code -->\n<!-- ``` -->');
})();

// ---- block style ---------------------------------------------------------------------------------------------------

(function testBlock() {
  let o = toggle('«a\nb\nc»', 'block');
  assert.strictEqual(o.r.status, 'commented');
  assert.strictEqual(show(o), '«<!-- a\nb\nc -->»');
  o = toggle(show(o), 'block');
  assert.strictEqual(o.r.status, 'uncommented');
  assert.strictEqual(show(o), '«a\nb\nc»');
  // indentation and blank lines around stay outside
  o = toggle('«\n  - a\n  - b\n\n»x', 'block');
  assert.strictEqual(o.text, '\n  <!-- - a\n  - b -->\n\nx');
  assert.strictEqual(toggle('«\n  <!-- - a\n  - b -->\n\n»x', 'block').text, '\n  - a\n  - b\n\nx');
  // caret only: the caret's line
  assert.strictEqual(show(toggle('x\nab¦c\ny', 'block')), 'x\n<!-- ab¦c -->\ny');
  // a comment written with "<!--" and "-->" on lines of their own comes off with those lines
  assert.strictEqual(toggle('«<!--\na\nb\n-->»', 'block').text, 'a\nb');
  assert.strictEqual(toggle('«<!--\r\na\r\n-->»', 'block').text, 'a');
  assert.strictEqual(toggle('«<!--\n-->»', 'block').text, '');
  assert.strictEqual(toggle('¦<!---->', 'block').text, '');
  // a one-line comment is one block
  assert.strictEqual(toggle('<!-- x -->¦', 'block').text, 'x');
  // refusals
  o = toggle('«a\nb --> c»', 'block');
  assert.deepStrictEqual([o.r.status, o.r.reason, o.text], ['refused', 'terminator', 'a\nb --> c']);
  o = toggle('«a\n<!-- b -->\nc»', 'block');
  assert.strictEqual(o.r.reason, 'terminator', 'two comments are not one block: -->');
  o = toggle('«x\n<!-- md-memo:run ab12 -->»', 'block');
  assert.strictEqual(o.r.reason, 'marker');
  o = toggle('<!-- start\n«middle»\nend -->', 'block');
  assert.strictEqual(o.r.reason, 'overlap', 'inside a comment that goes on outside the lines');
  o = toggle('«a <!-- b»\nc -->', 'block');
  assert.strictEqual(o.r.reason, 'overlap');
  assert.strictEqual(toggle('«\n  \n»', 'block').r.status, 'nothing');
})();

// ---- round trips: toggling twice gives the text back ------------------------------------------------------------------

(function testRoundTrips() {
  const texts = [
    'a', 'a\nb\nc', '  - item\n    - nested\n', '> q\n> r', 'x\r\ny\r\n', '日本語\n😀 emoji\n𠮷', '- [x] done // approve',
    '{{ @claude do it }}', 'a -\nb --\n- c', '->\n>x\n-x-', 'it`s `code` here', 'x <!-- y', 'line\n\n\nline',
    'a\t\n\tb  ', '<!', '<!-', '--', '<!-- a -->', '<!-- a -->\n<!-- b -->', '　全角スペース', '[ ] and [[x]]'
  ];
  let checked = 0;
  for (const style of ['line', 'block']) {
    for (const text of texts) {
      // every caret position and the whole text
      const sels = [[0, text.length]];
      for (let p = 0; p <= text.length; p++) sels.push([p, p]);
      for (const [a, b] of sels) {
        const r1 = CT.toggleComment(text, a, b, style);
        if (r1.status !== 'commented' && r1.status !== 'uncommented') continue;
        const once = apply(text, r1);
        assert.ok(once.text !== text, style + ': changed ' + JSON.stringify(text));
        assert.ok(once.selStart >= 0 && once.selEnd <= once.text.length && once.selStart <= once.selEnd, 'selection in range');
        const r2 = CT.toggleComment(once.text, once.selStart, once.selEnd, style);
        const twice = apply(once.text, r2);
        assert.strictEqual(twice.text, text, style + ' round trip of ' + JSON.stringify(text) + ' at ' + a + '..' + b);
        // A caret in the text comes back where it was (one that sat on "<!-- " itself cannot: that text went away)
        if (a === b && r1.status === 'commented') {
          assert.strictEqual(twice.selStart, a, style + ': the caret comes back to ' + a + ' in ' + JSON.stringify(text));
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 200, 'round trips checked: ' + checked);
})();

// ---- what it writes is what the parsers and the preview see as a comment --------------------------------------------

(function testWrittenCommentsAreComments() {
  const text = '- {{ @claude a }}\n  [[ @llm b ]]\n[[ $ ls ]]';
  for (const style of ['line', 'block']) {
    const out = apply(text, CT.toggleComment(text, 0, text.length, style)).text;
    const masked = HC.maskComments(out);
    assert.ok(masked.indexOf('{{') === -1 && masked.indexOf('[[') === -1, style + ': nothing runnable is left outside the comments: ' + out);
    assert.strictEqual(HC.removeComments(out), '', style + ': the preview shows nothing: ' + JSON.stringify(HC.removeComments(out)));
  }
})();

console.log('comment_toggle tests passed');
