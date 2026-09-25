// Unit tests for note_title.js: the automatic title of an untitled note and the Save As default file name.
const assert = require('assert');

global.window = global;
const NT = require('./note_title.js');

const title = (s, o) => NT.deriveTitle(s, o);
const cp = (s) => Array.from(s).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const noLoneSurrogate = (s) => !LONE_SURROGATE.test(s);
const DATE = '# 2026-09-25 07:51\n\n'; // what a new note starts with

// ---- the outputs that were wrong before -------------------------------------------------------------------------------------
(function testReportedBadOutputs() {
  // a table header row was cut in the middle of a full-width bracket: "...作成伝票数（"
  const header = '| 実行日 | 元の工場出荷票（入庫計上日） | GNB0480P | 所要 | 作成伝票数（伝票種別ごとの件数） |';
  assert.strictEqual(title(DATE + header + '\n|---|---|---|---|---|\n| 2026-09-01 | a | b | c | d |'), '2026-09-25 07-51', 'table rows are skipped, the date title is all that is left');
  assert.strictEqual(title(header), '', 'a table row is never a title');

  // the same header pasted as tab-separated text: it is a line now, and it must not end inside a bracket
  const tsv = '実行日\t元の工場出荷票（入庫計上日）\tGNB0480P\t所要\t作成伝票数（伝票種別ごとの件数）\t備考';
  assert.strictEqual(title(tsv), '実行日 元の工場出荷票（入庫計上日） GNB0480P 所要', 'backed up to a boundary outside the open bracket');
  assert.strictEqual(title('会議録（二〇二六年九月の定例会議についての詳細な議事録と今後の対応事項をまとめたもの）'), '会議録', 'no boundary but an open bracket: cut before its opener');

  // "|---|---|" -> "------", "---" -> "---"
  assert.strictEqual(title('|---|---|'), '');
  assert.strictEqual(title('|:---:|---:|'), '');
  assert.strictEqual(title('---'), '');
  assert.strictEqual(title('---\n'), '');
  assert.strictEqual(title(DATE + '---'), '2026-09-25 07-51');

  // "<!-- md-memo:res ab12 -->" -> "!-- md-memores ab12 --"
  assert.strictEqual(title('<!-- md-memo:res ab12 -->'), '');
  assert.strictEqual(title('<!-- md-memo:run ab12 -->\n<!-- md-memo:res ab12 -->\nresult text\n<!-- /md-memo:res -->'), 'result text', 'the markers are skipped, what is between them is content');

  // a fenced code line -> "```js"
  assert.strictEqual(title('```js'), '');
  assert.strictEqual(title('```js\nconst x = 1;\n```\nafter'), 'after');

  // 39 characters + an emoji -> a lone surrogate
  const t39 = title('a'.repeat(39) + '\u{1F600}' + 'tail');
  assert.strictEqual(t39, 'a'.repeat(39) + '\u{1F600}');
  assert.ok(noLoneSurrogate(t39));
  assert.strictEqual(cp(t39), 40);
  const t40 = title('a'.repeat(40) + '\u{1F600}');
  assert.strictEqual(t40, 'a'.repeat(40));

  // "[foo](http://x.y/z)" -> "[foo](httpx.yz)"
  assert.strictEqual(title('[foo](http://x.y/z)'), 'foo');
  assert.strictEqual(title('see [the docs](https://example.com/a_(b)) now'), 'see the docs now');

  // illegal characters were deleted (pipes vanished, words merged)
  assert.strictEqual(title('a|b'), 'a b');
  assert.strictEqual(title('Q1:report'), 'Q1 report');
  assert.strictEqual(title('A/B test'), 'A B test');
  assert.strictEqual(title('what? "why" 3 < 5 > 2 a\\b c*d'), 'what why 3 5 2 a b c d');
  assert.strictEqual(title('keep <b>bold</b> text'), 'keep bold text', 'an HTML tag is markup, not a name');
})();

// ---- what is skipped ---------------------------------------------------------------------------------------------------------
(function testSkippedLines() {
  assert.strictEqual(title('\n\n   \n\t\nfirst'), 'first', 'blank lines');
  assert.strictEqual(title('\u3000\u3000\nfirst'), 'first', 'a full-width space line is blank');

  // front matter
  assert.strictEqual(title('---\ntitle: Foo\ntags: [a, b]\n---\nBody line'), 'Body line');
  assert.strictEqual(title('---\ntitle: Foo\n...\nBody line'), 'Body line', '"..." closes it too');
  assert.strictEqual(title('---\r\ntitle: Foo\r\n---\r\nBody line'), 'Body line', 'CRLF');
  assert.strictEqual(title('\uFEFF---\ntitle: Foo\n---\nBody line'), 'Body line', 'after a BOM');
  assert.strictEqual(title('---\ntags:\n  - a\n  - b\n# comment\n---\nBody'), 'Body', 'lists, indentation and comments are YAML');
  assert.strictEqual(title('---\n週報 2026-09\n---\n本文'), '週報 2026-09', 'a title between two rules is not front matter');
  assert.strictEqual(title('---\ntitle: Foo\nBody without a closing rule'), 'title Foo', 'never closed: only the rule is skipped');
  assert.strictEqual(title('text\n---\ntitle: Foo\n---\nBody'), 'text', 'front matter only counts at the very top');

  // fenced code
  assert.strictEqual(title('```\ncode\n```\nafter'), 'after');
  assert.strictEqual(title('~~~python\ncode\n~~~\nafter'), 'after', 'tilde fence');
  assert.strictEqual(title('````\n```\ninner\n```\n````\nafter'), 'after', 'a shorter fence does not close a longer one');
  assert.strictEqual(title('```\ncode\n~~~\nstill code\n```\nafter'), 'after', 'the other fence character does not close it');
  assert.strictEqual(title('```\nnever closed\n# heading in code'), '', 'an open fence swallows the rest');
  assert.strictEqual(title('before\n```\ncode\n```\n# Heading'), 'Heading', 'a heading after the fence still counts');
  assert.strictEqual(title('```\n# not a heading\n```\ntext'), 'text', 'a "heading" inside a fence is code');
  assert.strictEqual(title('```inline``` and more'), 'inline and more', 'three backticks in one line are inline code, not a fence');
  assert.strictEqual(title('> ```js\n> code\n> ```\n> after'), 'after', 'a fence inside a quote');
  assert.strictEqual(title('```\r\ncode\r\n```\r\nafter'), 'after', 'CRLF');

  // HTML comments
  assert.strictEqual(title('<!-- note -->\ntext'), 'text');
  assert.strictEqual(title('<!--\nmulti\nline\n-->\ntext'), 'text', 'multi-line');
  assert.strictEqual(title('<!-- a\n# not a heading\nb -->\ntext'), 'text', 'a heading inside a comment');
  assert.strictEqual(title('<!-- note --> after it'), 'after it', 'text after a one-line comment stays');
  assert.strictEqual(title('before <!-- note --> after'), 'before after', 'a comment in the middle');
  assert.strictEqual(title('<!-- a --> x <!-- b --> y'), 'x y', 'several comments');
  assert.strictEqual(title('start <!--\nhidden\n--> end\nnext'), 'start', 'a comment that opens after text');
  assert.strictEqual(title('<!-- never closed\ntext'), '', 'an open comment swallows the rest');
  assert.strictEqual(title('<!--' + 'x'.repeat(5000) + '--> after'), 'after', 'a very long comment on one line');
  assert.strictEqual(title('```\n<!-- literal in code\n```\ntext'), 'text', 'a comment marker inside a fence does not open a comment');

  // tables and rules
  assert.strictEqual(title('| a | b |\n|---|---|\n| 1 | 2 |\ntext'), 'text');
  assert.strictEqual(title('a | b\n--|--\n1 | 2'), 'a b', 'a table without an outer pipe is an ordinary line');
  for (const rule of ['---', '***', '___', '- - -', '* * *', '===', '=====', ':--:|:--:', '+---+---+', '───', '―――', '-']) {
    assert.strictEqual(title(rule + '\ntext'), 'text', 'skipped: ' + rule);
  }
  assert.strictEqual(title('> | a | b |\n> |---|---|\ntext'), 'text', 'a quoted table');

  // slot and task notation
  const slots = ['{{ write a function }}', '{{}}', '[? what is ESP32 ?]', '【? 要約して 】', '[! find the flaws !]', '[>> research then code ]', '[[ @llm summarise this ]]', '[[ $ ls -la ]]', '[[ anything ]]', '[[$ ls]]', '{{ a }} {{ b }}'];
  for (const slot of slots) {
    assert.strictEqual(title(slot + '\ntext'), 'text', 'skipped: ' + slot);
  }
  assert.strictEqual(title('- [ ] [? what is ESP32 ?]\ntext'), 'text', 'a task item holding only a slot');
  assert.strictEqual(title('# [? what ?]\ntext'), 'text', 'a heading holding only a slot');
  assert.strictEqual(title('Question: [? what ?]'), 'Question [ what ]', 'a slot inside a sentence is text (the "?" and ":" are made file-name safe)');
  assert.strictEqual(title('[[Note name]]'), '[[Note name]]', 'a wiki link (no space after the brackets) is not a task');
  assert.strictEqual(title('[link](http://x.y)\ntext'), 'link', 'a link line is a line');

  // empty things after the cleaning
  assert.strictEqual(title('- [ ]\n-\n>\n#\n**\n``\n<br>\ntext'), 'text');
  assert.strictEqual(title('\\/:*?"<>|\nclean title'), 'clean title', 'nothing usable left after making it file-name safe: the next line');
})();

// ---- the date heading --------------------------------------------------------------------------------------------------------
(function testDateHeading() {
  assert.strictEqual(title('# 2026-09-25 07:51\n\n'), '2026-09-25 07-51', 'alone, it becomes the title');
  assert.strictEqual(title('# 2026-09-25 07:51'), '2026-09-25 07-51');
  assert.strictEqual(title('2026-09-20\n'), '2026-09-20');
  assert.strictEqual(title('# 2026-09-20'), '2026-09-20');
  assert.strictEqual(title('## 2026/01/02'), '2026-01-02', 'slashes become hyphens');
  assert.strictEqual(title('2026/09/11 18:28:30'), '2026-09-11 18-28-30', 'seconds are kept');
  assert.strictEqual(title('   \n# 2026/01/02\n   \n'), '2026-01-02');
  assert.strictEqual(title('# 2026-09-25 07:51\n2026/09/11 18:28:30'), '2026-09-25 07-51', 'the first date line is the fallback');

  assert.strictEqual(title(DATE + 'Real title here\nmore'), 'Real title here', 'the date is skipped when there is a title');
  assert.strictEqual(title('# 2026-09-20\n\nReal title here\nmore'), 'Real title here');
  assert.strictEqual(title(DATE + '# Heading\ntext'), 'Heading');
  assert.strictEqual(title('# 2026-09-25 (Fri)'), '2026-09-25 (Fri)', 'more than a date is a normal heading');
  assert.strictEqual(title('# 2026-09-25 meeting'), '2026-09-25 meeting');
  assert.strictEqual(title('2026-09-25 07:51:33:44'), '2026-09-25 07 51 33 44', 'not a date line: a normal line, colons made safe');

  const a = NT.analyze;
  assert.deepStrictEqual({ ...a(DATE + 'text') }, { title: 'text', dateTitle: '2026-09-25 07-51', date: '2026-09-25' });
  assert.deepStrictEqual({ ...a('# 2026-13-45') }, { title: '', dateTitle: '2026-13-45', date: '' }, 'not a calendar date: kept as a title, not used as the date');
  assert.deepStrictEqual({ ...a('text') }, { title: 'text', dateTitle: '', date: '' });
})();

// ---- heading first, then the first meaningful line ---------------------------------------------------------------------------
(function testHeadingOrLine() {
  assert.strictEqual(title('First line\n\n# Heading later'), 'Heading later', 'a heading beats an earlier plain line');
  assert.strictEqual(title('First line\nSecond line'), 'First line');
  assert.strictEqual(title('# One\n# Two'), 'One', 'the first heading');
  assert.strictEqual(title('text\n## Second level'), 'Second level', 'any level');
  assert.strictEqual(title('#\n## \n### Heading three'), 'Heading three', 'empty headings are skipped');
  assert.strictEqual(title('#tag not a heading\ntext'), '#tag not a heading', '#tag is a line');
  assert.strictEqual(title('#\u3000Full-width space heading'), 'Full-width space heading');
  assert.strictEqual(title('####### seven hashes'), '####### seven hashes', 'more than six # is not a heading');
  assert.strictEqual(title('> # Quoted heading\ntext'), 'Quoted heading');
  assert.strictEqual(title('- # Listed heading'), 'Listed heading');
  assert.strictEqual(title('# ' + '（' + 'x'.repeat(60) + '\n# Second\n'), 'Second', 'a heading that leaves nothing falls to the next candidate');
  assert.strictEqual(title('（' + 'x'.repeat(60) + '\nsecond line'), 'second line', 'a line that leaves nothing falls to the next line');
  assert.strictEqual(title('- item one\n- item two'), 'item one');
  assert.strictEqual(title('1. numbered title\nrest'), 'numbered title');
  assert.strictEqual(title('   \n# 2026/01/02\n   \n* [ ] buy milk\n'), 'buy milk');
  assert.strictEqual(title('* [x] Task title\nbody'), 'Task title');
  assert.strictEqual(title('- [ ] a\n## Heading'), 'Heading');

  // only the first 200 lines are read
  const blank = '\n'.repeat(199);
  assert.strictEqual(title(blank + '# On line 200'), 'On line 200');
  assert.strictEqual(title(blank + '\n# On line 201'), '', 'line 201 is not read');
  assert.strictEqual(title(blank + '\nplain line 201'), '');
  assert.strictEqual(title('\n\n\nx', { maxLines: 3 }), '', 'maxLines');
  assert.strictEqual(title('\n\nx', { maxLines: 3 }), 'x');
  assert.strictEqual(title('a'.repeat(50), { maxChars: 10 }), 'a'.repeat(10), 'maxChars');
})();

// ---- Markdown removed --------------------------------------------------------------------------------------------------------
(function testStripMarkdown() {
  const s = NT.stripMarkdown;
  assert.strictEqual(s('> quote'), 'quote');
  assert.strictEqual(s('>> nested'), 'nested');
  assert.strictEqual(s('>quote no space'), 'quote no space');
  assert.strictEqual(s('- item'), 'item');
  assert.strictEqual(s('* item'), 'item');
  assert.strictEqual(s('+ item'), 'item');
  assert.strictEqual(s('1. one'), 'one');
  assert.strictEqual(s('12) twelve'), 'twelve');
  assert.strictEqual(s('３． 全角'), '全角', 'full-width number');
  assert.strictEqual(s('2026. plan'), '2026. plan', 'a year is not a list number');
  assert.strictEqual(s('- [x] done'), 'done');
  assert.strictEqual(s('- [ ] todo'), 'todo');
  assert.strictEqual(s('[X] boxed'), 'boxed');
  assert.strictEqual(s('- > - [x] deep'), 'deep');
  assert.strictEqual(s('・中黒'), '中黒', 'Japanese bullets');
  assert.strictEqual(s('●丸'), '丸');
  assert.strictEqual(s('-\u3000full-width space'), 'full-width space');
  assert.strictEqual(s('## Heading ##'), 'Heading');
  assert.strictEqual(s('# Heading #'), 'Heading');
  assert.strictEqual(s('Issue #'), 'Issue');
  assert.strictEqual(s('C#'), 'C#');
  assert.strictEqual(s('#tag'), '#tag');
  assert.strictEqual(s('**bold** and __also__ and *it* and _it_ and ~~gone~~'), 'bold and also and it and it and gone');
  assert.strictEqual(s('***both***'), 'both');
  assert.strictEqual(s('snake_case_name stays'), 'snake_case_name stays');
  assert.strictEqual(s('2 * 3 * 4'), '2 * 3 * 4', 'stray stars are not emphasis');
  assert.strictEqual(s('**unclosed'), '**unclosed');
  assert.strictEqual(s('`code`'), 'code');
  assert.strictEqual(s('use ``a`b`` here'), 'use ab here');
  assert.strictEqual(s('[t](u)'), 't');
  assert.strictEqual(s('[t](u "title")'), 't');
  assert.strictEqual(s('![alt](img.png)'), 'alt');
  assert.strictEqual(s('![](x.png) after'), 'after');
  assert.strictEqual(s('[![badge](i.svg)](http://l)'), 'badge');
  assert.strictEqual(s('[a](http://x/(y)) b'), 'a b');
  assert.strictEqual(s('[a](x) and [b](y)'), 'a and b');
  assert.strictEqual(s('[not a link] (x)'), '[not a link] (x)');
  assert.strictEqual(s('<b>bold</b> text<br>next'), 'bold text next');
  assert.strictEqual(s('<div class="x">hi</div>'), 'hi');
  assert.strictEqual(s('<https://ex.com/a>'), 'ex.com/a');
  assert.strictEqual(s('a < b and c > d'), 'a < b and c > d');
  assert.strictEqual(s('https://example.com/x'), 'example.com/x');
  assert.strictEqual(s('a <!-- c --> b'), 'a b');
  assert.strictEqual(s('  spaced \t  out  '), 'spaced out');
  assert.strictEqual(s('a\u200Bb'), 'ab', 'zero-width characters');
  assert.strictEqual(s(''), '');
  assert.strictEqual(s(null), '');
  assert.strictEqual(s(undefined), '');
})();

// ---- file-name safety --------------------------------------------------------------------------------------------------------
(function testSanitizeFileName() {
  const f = NT.sanitizeFileName;
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    assert.strictEqual(f('a' + ch + 'b'), 'a b', 'replaced, not deleted: ' + ch);
  }
  assert.strictEqual(f('a\u0000b\u0007c\u001Fd\u007Fe\nf\tg'), 'a b c d e f g', 'control characters');
  assert.strictEqual(f('a||||b'), 'a b', 'spaces collapse');
  assert.strictEqual(f('  padded  '), 'padded');
  assert.strictEqual(f('a : b'), 'a b');
  assert.strictEqual(f('name.'), 'name');
  assert.strictEqual(f('name. . '), 'name');
  assert.strictEqual(f('name...'), 'name');
  assert.strictEqual(f('.hidden'), '.hidden', 'a leading dot is kept');
  assert.strictEqual(f('...'), '');
  assert.strictEqual(f('\\/:*?"<>|'), '');
  assert.strictEqual(f(''), '');
  assert.strictEqual(f(null), '');
  assert.strictEqual(f('日本語 名前'), '日本語 名前', 'CJK stays');

  for (const name of ['CON', 'con', 'Con', 'PRN', 'aux', 'NUL', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.strictEqual(f(name), '_' + name, 'reserved: ' + name);
  }
  assert.strictEqual(f('CON.txt'), '_CON.txt', 'with an extension');
  assert.strictEqual(f('nul.tar.gz'), '_nul.tar.gz');
  assert.strictEqual(f('CON .txt'), '_CON .txt', 'spaces before the dot');
  assert.strictEqual(f('CON:'), '_CON', 'the reserved name shows after the cleaning');
  assert.strictEqual(f('CONSOLE'), 'CONSOLE');
  assert.strictEqual(f('COM0'), 'COM0');
  assert.strictEqual(f('COM10'), 'COM10');
  assert.strictEqual(f('LPT'), 'LPT');
  assert.strictEqual(f('my CON'), 'my CON');
  assert.strictEqual(f('_CON'), '_CON');

  // through the title
  assert.strictEqual(title('CON'), '_CON');
  assert.strictEqual(title('# aux'), '_aux');
  assert.strictEqual(title('COM1.md'), '_COM1.md');
})();

// ---- truncation --------------------------------------------------------------------------------------------------------------
(function testTruncateTitle() {
  const tr = NT.truncateTitle;
  assert.strictEqual(tr('short'), 'short');
  assert.strictEqual(tr(''), '');
  assert.strictEqual(tr(null), '');
  assert.strictEqual(tr('a'.repeat(39)), 'a'.repeat(39));
  assert.strictEqual(tr('a'.repeat(40)), 'a'.repeat(40), 'exactly 40 is kept whole');
  assert.strictEqual(tr('a'.repeat(41)), 'a'.repeat(40), 'no boundary at all: a hard cut at 40');
  assert.strictEqual(tr('a'.repeat(200)), 'a'.repeat(40));
  assert.strictEqual(tr('a'.repeat(20), 10), 'a'.repeat(10), 'a custom limit');

  // whitespace boundary
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  assert.strictEqual(tr(words), 'alpha beta gamma delta epsilon zeta eta', 'backed up to the last whole word (39 characters)');
  assert.strictEqual(tr('a'.repeat(39) + ' bbb'), 'a'.repeat(39), 'the cut falls on a space');
  assert.strictEqual(tr('a'.repeat(38) + ' bbbbbbbb'), 'a'.repeat(38), 'a word that would be cut is dropped');
  assert.strictEqual(tr('word ' + 'x'.repeat(60)), 'word ' + 'x'.repeat(35), 'a short first word must not become the whole title: hard cut instead');
  assert.strictEqual(tr('a'.repeat(19) + ' ' + 'x'.repeat(60)), 'a'.repeat(19) + ' ' + 'x'.repeat(20), 'a boundary before half of the limit: hard cut');
  assert.strictEqual(tr('a'.repeat(20) + ' ' + 'x'.repeat(60)), 'a'.repeat(20), 'a boundary at half of the limit is used');
  assert.strictEqual(tr('one, two, three, four, five, six, seven, eight, nine'), 'one, two, three, four, five, six, seven', 'trailing commas do not dangle');
  assert.ok(!/ellipsis|…|\.\.\./.test(tr('x '.repeat(60))), 'no ellipsis');

  // brackets
  assert.strictEqual(tr('x'.repeat(30) + '（' + 'y'.repeat(20) + '）'), 'x'.repeat(30), 'an open full-width bracket: cut before its opener');
  assert.strictEqual(tr('x'.repeat(30) + '(' + 'y'.repeat(20) + ')'), 'x'.repeat(30), 'ASCII');
  assert.strictEqual(tr('x'.repeat(30) + '「' + 'y'.repeat(20) + '」'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '『' + 'y'.repeat(20) + '』'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '【' + 'y'.repeat(20) + '】'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '［' + 'y'.repeat(20) + '］'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '〈' + 'y'.repeat(20) + '〉'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '《' + 'y'.repeat(20) + '》'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '[' + 'y'.repeat(20) + ']'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(30) + '{' + 'y'.repeat(20) + '}'), 'x'.repeat(30));
  assert.strictEqual(tr('x'.repeat(10) + '（a「b」' + 'y'.repeat(40)), 'x'.repeat(10), 'nested: before the outermost open opener');
  assert.strictEqual(tr('x'.repeat(5) + '(a) ' + 'y'.repeat(20) + '(b' + 'z'.repeat(20)), 'x'.repeat(5) + '(a) ' + 'y'.repeat(20), 'a closed bracket before an open one stays');
  assert.strictEqual(tr('x'.repeat(10) + '(a b c d e f g h i j k l m n o p q r s t u v w x y z)'), 'x'.repeat(10), 'the boundary is a space inside the bracket: still cut before the opener');
  assert.strictEqual(tr('(' + 'x'.repeat(60) + ')'), '', 'the opener is the first character: nothing is left');
  assert.strictEqual(tr('【重要】' + 'あ'.repeat(60)), '【重要】' + 'あ'.repeat(36), 'closed brackets are fine; a hard cut after them');
  assert.strictEqual(tr('【重要】会議の' + '議事録'.repeat(20)).slice(0, 4), '【重要】');
  assert.strictEqual(tr(') stray closer ' + 'x'.repeat(40)), ') stray closer ' + 'x'.repeat(25), 'a closer with no opener is ignored');
  // a short text with an unclosed bracket is left as the user wrote it
  assert.strictEqual(tr('note (draft'), 'note (draft');
  // the boundary after a closing bracket
  assert.strictEqual(tr('（' + 'a'.repeat(30) + '）' + 'b'.repeat(30)), '（' + 'a'.repeat(30) + '）', 'back up to just after a closing bracket');

  // code points, never inside a surrogate pair
  const emoji = '\u{1F600}';
  assert.strictEqual(tr(emoji.repeat(50)), emoji.repeat(40));
  assert.strictEqual(tr('\u{20BB7}'.repeat(60)), '\u{20BB7}'.repeat(40), 'a CJK extension B character is one code point');
  assert.strictEqual(cp(tr(emoji.repeat(50))), 40);
  for (let pad = 0; pad <= 45; pad++) {
    for (const tail of ['', ' tail words here', 'x'.repeat(30), '（open bracket text goes on and on and on']) {
      const out = tr('a'.repeat(pad) + emoji.repeat(6) + tail);
      assert.ok(noLoneSurrogate(out), 'well-formed for pad ' + pad + ' tail ' + JSON.stringify(tail));
      assert.ok(cp(out) <= 40, 'at most 40 code points for pad ' + pad);
    }
  }
})();

// ---- grapheme clusters: only when Intl.Segmenter exists -----------------------------------------------------------------------
(function testGraphemeClusters() {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // 5 code points, one grapheme
  const flags = '\u{1F1EF}\u{1F1F5}'.repeat(30); // regional indicator pairs
  const combining = 'é'.repeat(30); // e + combining acute
  const savedSegmenter = Intl.Segmenter;
  try {
    if (typeof savedSegmenter === 'function') {
      assert.strictEqual(NT.truncateTitle('a'.repeat(38) + family + 'tail'), 'a'.repeat(38), 'a ZWJ sequence is not split');
      const f = NT.truncateTitle(flags);
      assert.strictEqual(cp(f), 40, 'flags: 20 whole pairs');
      assert.ok(noLoneSurrogate(f));
      const c = NT.truncateTitle('a' + combining);
      assert.strictEqual(cp(c) <= 40, true);
      assert.ok(!/^[̀-ͯ]/.test(c.slice(-1)) || cp(c) % 2 === 1, 'a base letter keeps its combining mark');
      assert.strictEqual(c.slice(-1), '́', 'ends after a whole "e + accent"');
    }
    // without Intl.Segmenter: still valid code-point cuts
    Intl.Segmenter = undefined;
    const t = NT.truncateTitle('a'.repeat(38) + family + 'tail');
    assert.ok(noLoneSurrogate(t));
    assert.ok(cp(t) <= 40);
    assert.strictEqual(NT.truncateTitle('a'.repeat(60)), 'a'.repeat(40));
    assert.strictEqual(title('a'.repeat(39) + '\u{1F600}tail'), 'a'.repeat(39) + '\u{1F600}');
  } finally {
    Intl.Segmenter = savedSegmenter;
  }
})();

// ---- realistic invariants over many inputs ------------------------------------------------------------------------------------
(function testInvariants() {
  // Every bracket group is closed in the source, so a title that still has an open bracket was cut inside one.
  const pieces = ['alpha', 'beta', '会議', '議事録', '(x y z)', '（件 数 の内訳）', '「q r s」', '[a b c]', '【重要】',
    '（a（b）c）', '{k v}', '\u{1F600}', 'a|b', 'c:d', 'CON', ' ', '  ', '.', 'long' + 'z'.repeat(25), '[link](http://q.r/s)', '**b**', '`c`'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const illegal = /[\\/:*?"<>|\u0000-\u001F\u007F]/;
  for (let i = 0; i < 2000; i++) {
    let line = '';
    const n = 1 + rnd(30);
    for (let k = 0; k < n; k++) line += pieces[rnd(pieces.length)] + (rnd(3) === 0 ? '' : ' ');
    const text = (rnd(2) ? '# ' : '') + line;
    const t = title(text);
    assert.ok(noLoneSurrogate(t), 'well-formed: ' + JSON.stringify(text));
    assert.ok(cp(t) <= 41, 'about 40 code points (41 with a "_" guard): ' + JSON.stringify(t));
    assert.ok(!illegal.test(t), 'file-name safe: ' + JSON.stringify(t));
    assert.ok(!/[. ]$/.test(t) && !/^ /.test(t) && !/ {2}/.test(t), 'clean edges: ' + JSON.stringify(t));
    // no bracket is left open, however the title was cut
    let depth = 0;
    for (const ch of Array.from(t)) {
      if ('([{（「『【［〈《'.indexOf(ch) !== -1) depth++;
      else if (')]}）」』】］〉》'.indexOf(ch) !== -1) depth--;
      assert.ok(depth >= 0, 'a closer without its opener: ' + JSON.stringify(t));
    }
    assert.strictEqual(depth, 0, 'no open bracket: ' + JSON.stringify(t));
  }
})();

// ---- line endings, size, empties ---------------------------------------------------------------------------------------------
(function testLineEndings() {
  assert.strictEqual(title('# Title\r\nbody\r\n'), 'Title');
  assert.strictEqual(title('\r\n\r\nHello\r\n'), 'Hello');
  assert.strictEqual(title('a\r\nb\r\nc'), 'a');
  assert.strictEqual(title('# 2026-09-25 07:51\r\n\r\n'), '2026-09-25 07-51', 'the date heading with CRLF');
  assert.strictEqual(title('<!--\r\nx\r\n-->\r\ntext'), 'text');
  assert.strictEqual(title('| a |\r\n|---|\r\ntext'), 'text');
  assert.strictEqual(NT.defaultSaveName('# 2026-09-25 07:51\r\n\r\nPlan\r\n', '2030-01-01'), '2026-09-25_Plan.md');
})();

(function testLongLinesAndPerformance() {
  assert.strictEqual(title('a'.repeat(20000)), 'a'.repeat(40));
  assert.strictEqual(title('a'.repeat(20000) + '\ntail'), 'a'.repeat(40));
  assert.strictEqual(title('word '.repeat(5000)), 'word word word word word word word word', 'a very long line');
  assert.ok(noLoneSurrogate(title('\u{1F600}'.repeat(5000))));
  // marker soup must not make the scan slow (each line is cleaned only up to 1000 characters)
  const soup = ['**'.repeat(5000) + 'x', '*a '.repeat(5000), '_a '.repeat(5000), '[x]('.repeat(5000), '![a]('.repeat(3000), '<a '.repeat(5000), '`'.repeat(9000), '~~a '.repeat(3000), '<!-- '.repeat(3000), '--> ' + '<!-- '.repeat(4000), '<!--x-->'.repeat(3000) + 'end', '(['.repeat(5000)];
  for (const line of soup) {
    const t0 = process.hrtime.bigint();
    const t = title(line);
    NT.defaultSaveName(line, '2026-09-25');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, 'marker soup ' + JSON.stringify(line.slice(0, 12)) + ' took ' + ms.toFixed(1) + ' ms');
    assert.ok(cp(t) <= 41 && noLoneSurrogate(t));
  }
  assert.strictEqual(title('[x](' + 'u'.repeat(800) + ') after'), 'x after', 'a link with a long address');
  assert.strictEqual(title('[x](' + 'u'.repeat(3000) + ') after'), 'x', 'an address that runs past the cleaned part keeps the link text');
  assert.strictEqual(title('![alt](' + 'u'.repeat(3000) + ')'), 'alt');

  // 5000 lines: a note without a heading, one of skipped lines only, one of table rows
  const plain = Array.from({ length: 5000 }, (_, i) => 'line number ' + i + ' of a long note').join('\n');
  const skipped = Array.from({ length: 5000 }, () => '| a | b |').join('\n');
  const blanks = '\n'.repeat(5000);
  const fenced = '```\n' + Array.from({ length: 5000 }, () => 'code').join('\n');
  const huge = Array.from({ length: 200000 }, (_, i) => 'line ' + i).join('\n'); // about 2 MB
  const inputs = { plain, skipped, blanks, fenced, huge };
  for (const name of Object.keys(inputs)) {
    const text = inputs[name];
    title(text); // warm up
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const t0 = process.hrtime.bigint();
      title(text);
      NT.defaultSaveName(text, '2026-09-25');
      runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    runs.sort((x, y) => x - y);
    const median = runs[3];
    assert.ok(median < 50, name + ': a 200-line scan window must finish well under 50 ms (median ' + median.toFixed(2) + ' ms)');
  }
  assert.strictEqual(title(plain), 'line number 0 of a long note');
  assert.strictEqual(title(skipped), '');
  assert.strictEqual(title(huge), 'line 0');
})();

(function testEmptyNotes() {
  for (const empty of ['', null, undefined, '\n', '\n\n\n', '   ', '   \n\t\n  ', '\uFEFF', '\r\n', '<!-- -->', '---\n---\n', '```\n```\n']) {
    assert.strictEqual(title(empty), '', 'empty: ' + JSON.stringify(empty));
    assert.strictEqual(NT.defaultSaveName(empty, '2026-09-25'), '', 'no save name for ' + JSON.stringify(empty));
  }
  assert.strictEqual(title(123), '123', 'not a string');
})();

// ---- the Save As default -----------------------------------------------------------------------------------------------------
(function testDefaultSaveName() {
  const n = NT.defaultSaveName;
  // the note's own date heading
  assert.strictEqual(n(DATE + 'Weekly plan', '2030-01-01'), '2026-09-25_Weekly plan.md');
  assert.strictEqual(n('# 2026-09-25 07:51\n\n# Weekly plan\nbody', '2030-01-01'), '2026-09-25_Weekly plan.md');
  assert.strictEqual(n('# 2026/09/11\nx', '2030-01-01'), '2026-09-11_x.md', 'slashes in the heading');
  assert.strictEqual(n('Title first\n\n# 2026-01-02 10:00', '2030-01-01'), '2026-01-02_Title first.md', 'a date heading after the title is still found');
  assert.strictEqual(n('# Heading\n# 2026-01-02', '2030-01-01'), '2026-01-02_Heading.md', 'even after the heading that names the note');
  // no date heading: today
  assert.strictEqual(n('Weekly plan', '2026-10-01'), '2026-10-01_Weekly plan.md');
  assert.strictEqual(n('Weekly plan', new Date(2026, 8, 5, 12, 30)), '2026-09-05_Weekly plan.md', 'a Date');
  assert.ok(/^\d{4}-\d{2}-\d{2}_Weekly plan\.md$/.test(n('Weekly plan')), 'today by default');
  assert.ok(/^\d{4}-\d{2}-\d{2}_Weekly plan\.md$/.test(n('Weekly plan', 'garbage')), 'a bad "today" falls back to now');
  assert.ok(/^\d{4}-\d{2}-\d{2}_Weekly plan\.md$/.test(n('Weekly plan', new Date(NaN))));
  assert.strictEqual(n('Weekly plan', new Date(5, 0, 2)).slice(0, 4), '1905', 'years are padded to four digits');
  // an impossible date heading is not used as the date
  assert.strictEqual(n('# 2026-13-45\nplan', '2026-10-01'), '2026-10-01_plan.md');
  // only a date heading: named after it, no doubled date
  assert.strictEqual(n(DATE, '2030-01-01'), '2026-09-25 07-51.md');
  assert.strictEqual(n('2026-09-20\n', '2030-01-01'), '2026-09-20.md');
  // the summary is the same one the tab shows, made file-name safe
  assert.strictEqual(n('a|b: c?', '2026-10-01'), '2026-10-01_a b c.md');
  assert.strictEqual(n('CON', '2026-10-01'), '2026-10-01_CON.md', 'the date already makes a reserved name safe');
  assert.strictEqual(n('a'.repeat(60), '2026-10-01'), '2026-10-01_' + 'a'.repeat(40) + '.md');
  // the tab label stays the plain summary
  assert.strictEqual(title(DATE + 'Weekly plan'), 'Weekly plan');
  assert.ok(!/^\d{4}-\d{2}-\d{2}_/.test(title('Weekly plan')));
})();

console.log('note_title tests passed');
