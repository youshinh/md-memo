// Things the exploratory review found in the editor that only a real browser can confirm (tests/editor_find_paste_fixes_test.mjs
// holds the same fixes against a hand-made DOM):
//   - the find box: ^ and $ are line starts and ends in regex mode (C4-05), an emoji is one character (C4-16), and "whole word" works
//     for a Japanese word (C4-06)
//   - the gutter: a number of five digits is not cut off (C4-07), and a line of very wide characters that wraps does not pull the
//     numbers below it up (C4-15)
//   - a note open on both sides of a split: typing in one pane leaves the caret of the other where it was (C4-12)
import { assert, focusEditor, waitShown } from './lib.mjs';

const setNote = (s, expr) => s.ev(`(function () {
  var e = document.getElementById('editor');
  e.focus();
  e.value = ${expr};
  e.setSelectionRange(0, 0);
  e.dispatchEvent(new Event('input', { bubbles: true }));
})()`);

const count = (s) => s.ev("document.getElementById('find-count').textContent.trim()");

// types a query into the find box (cleared first) and waits for the count to settle on `expected`
async function searchFor(s, query, expected) {
  await s.ev("(function () { var f = document.getElementById('find-input'); f.focus(); f.select(); })()");
  await s.key('Backspace');
  await s.type(query, { insert: true });
  await s.waitFor(`document.getElementById('find-count').textContent.trim() === ${JSON.stringify(expected)}`);
}

export default {
  title: 'editor: regex ^ and emoji and Japanese whole word in find, five-digit gutter, wide-character wrap, the other pane keeps its caret',
  session: { notes: [{ title: 'one.md', content: 'Line one\nLine two\nLine three\n', cursor: 0 }] },

  async run(s, t) {
    t.step('regex mode: ^Line is the start of every line, one$ the end of a line');
    await focusEditor(s);
    await s.key('f', { ctrl: true });
    await waitShown(s, 'find-replace-bar');
    await s.ev("document.getElementById('btn-find-regex').click()");
    await searchFor(s, '^Line', '1/3');
    await searchFor(s, 'one$', '1/1');

    t.step('an emoji is one character to the regex; Replace all puts the replacement in once');
    await setNote(s, JSON.stringify('a\u{1F600}b'));
    await searchFor(s, '[\u{1F600}]', '1/1');
    await s.ev("document.getElementById('replace-input').value = 'X'");
    await s.ev("document.getElementById('btn-replace-all').click()");
    await s.waitFor("document.getElementById('editor').value === 'aXb'");

    t.step('whole word finds a Japanese word that stands apart, and not the one inside a sentence');
    await setNote(s, JSON.stringify('これは日本語です。 a 日本語 b'));
    await s.ev("document.getElementById('btn-find-regex').click()");
    await s.ev("document.getElementById('btn-find-word').click()");
    await searchFor(s, '日本語', '1/1');
    await s.key('Escape');

    t.step('a note of 12,000 lines: the five-digit numbers fit in the gutter');
    await setNote(s, "Array.from({ length: 12000 }, function (_, i) { return 'line ' + i; }).join('\\n')");
    await s.waitFor("document.getElementById('line-numbers').lastElementChild && /12000/.test(document.getElementById('line-numbers').lastElementChild.textContent)");
    const cut = await s.ev(`(function () {
      var g = document.getElementById('line-numbers');
      var worst = 0;
      for (var i = 0; i < g.children.length; i++) worst = Math.max(worst, g.children[i].scrollWidth - g.children[i].clientWidth);
      return worst;
    })()`);
    assert.ok(cut <= 1, 'the numbers overflow their column by ' + cut + 'px');

    t.step('a line of very wide characters wraps, and the next number stays on the next line of the note');
    await setNote(s, "'\\uFDFD'.repeat(40) + '\\nnext line\\nthird'");
    await s.waitFor("/^1\\n\\n+2\\n/.test(document.getElementById('line-numbers').textContent)");

    t.step('the same note on both sides of a split: typing in the left pane leaves the right caret where it was');
    await setNote(s, "'line one\\nline two\\nline three\\nline four'");
    await s.key('\\', { ctrl: true });
    await waitShown(s, 'secondary-pane');
    await s.waitFor("document.getElementById('editor-secondary').value === document.getElementById('editor').value");
    await s.ev(`(function () {
      var r = document.getElementById('editor-secondary');
      r.focus();
      r.setSelectionRange(14, 14);
      var e = document.getElementById('editor');
      e.focus();
      e.setSelectionRange(e.value.length, e.value.length);
    })()`);
    await s.type('XY');
    await s.waitFor("document.getElementById('editor-secondary').value.slice(-2) === 'XY'");
    const caret = await s.ev("document.getElementById('editor-secondary').selectionStart");
    assert.equal(caret, 14, 'the right pane caret jumped to ' + caret);
  },
};
