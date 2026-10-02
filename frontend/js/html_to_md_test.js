// Unit tests for html_to_md.js (clipboard HTML -> Markdown, "special paste").
const assert = require('assert');

const HtmlToMd = require('./html_to_md.js');
const convert = HtmlToMd.convert;

// 0. hasStructure: does the clipboard HTML hold anything worth converting?
{
  const has = HtmlToMd.hasStructure;
  assert.strictEqual(typeof has, 'function');
  // structure
  ['<table><tr><td>a</td><td>b</td></tr></table>', '<h2>Title</h2>', '<ul><li>x</li></ul>', '<ol><li>x</li></ol>', '<p>see <a href="https://x">this</a></p>',
    '<img src="a.png">', '<blockquote>q</blockquote>', '<p>a</p><hr>', '<p>one <strong>two</strong></p>', '<p>one <em>two</em></p>', '<p>one <b>two</b></p>',
    '<p>one <i>two</i></p>', '<p><del>old</del></p>', '<P>UPPER <B>CASE</B></P>', '<table>\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n</table>']
    .forEach((h) => assert.strictEqual(has(h), true, h));
  // nothing worth converting: plain paragraphs, line breaks and styled spans (an editor's or a terminal's HTML)
  ['', null, undefined, 'just text', '<p>plain paragraph</p>', '<div><span style="color:#fff">const a = 1;</span></div><div><span>return a;</span></div>',
    '<meta charset="utf-8"><div style="font-family:monospace"><span>line 1</span><br><span>line 2</span></div>',
    '<style>table {mso-x:y} b {font-weight:bold}</style><p>text</p>', '<body><p>x</p></body>', '<abbr title="x">y</abbr>', '<span>a</span><link rel="x">',
    '<iframe src="x"></iframe><input value="a"><embed src="z"><script>var a=1</script>']
    .forEach((h) => assert.strictEqual(has(h), false, String(h)));
  // one copied spreadsheet cell is just text; two cells are a table
  assert.strictEqual(has('<table><tr><td>42</td></tr></table>'), false, 'a single cell');
  assert.strictEqual(has('<table><tr><td>4</td></tr><tr><td>2</td></tr></table>'), true, 'two cells');
  assert.strictEqual(has('<table><tr><td><b>42</b></td></tr></table>'), true, 'a single cell that carries emphasis still has structure');
  // it is cheap on a big spreadsheet range
  const big = '<table>' + '<tr><td>1</td><td>2</td><td>3</td></tr>'.repeat(20000) + '</table>';
  const t0 = process.hrtime.bigint();
  assert.strictEqual(has(big), true);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 20, `hasStructure on 20000 rows took ${ms.toFixed(1)} ms`);
  const noStruct = '<div><span>x</span></div>'.repeat(20000);
  const t1 = process.hrtime.bigint();
  assert.strictEqual(has(noStruct), false);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(ms2 < 40, `hasStructure on 20000 plain divs took ${ms2.toFixed(1)} ms`);
  console.log('PASS: hasStructure finds structure and leaves plain code / log HTML alone');
}

// 1. empty input
{
  assert.strictEqual(convert(''), '');
  assert.strictEqual(convert(null), '');
  assert.strictEqual(convert(undefined), '');
  console.log('PASS: empty input -> empty string');
}

// 2. headings h1-h6
{
  assert.strictEqual(convert('<h1>Title</h1>'), '# Title');
  assert.strictEqual(convert('<h2>Sub</h2>'), '## Sub');
  assert.strictEqual(convert('<h3>a</h3><h4>b</h4><h5>c</h5><h6>d</h6>'), '### a\n\n#### b\n\n##### c\n\n###### d');
  console.log('PASS: headings h1-h6');
}

// 3. paragraphs and <br>
{
  assert.strictEqual(convert('<p>Hello</p><p>World</p>'), 'Hello\n\nWorld');
  assert.strictEqual(convert('<p>Line1<br>Line2</p>'), 'Line1  \nLine2');
  console.log('PASS: paragraphs and br');
}

// 4. hr
{
  assert.strictEqual(convert('<p>a</p><hr><p>b</p>'), 'a\n\n---\n\nb');
  console.log('PASS: hr');
}

// 5. strong/b, em/i, del/s/strike
{
  assert.strictEqual(convert('<p><b>bold</b> <i>italic</i> <strong>s</strong> <em>e</em></p>'), '**bold** *italic* **s** *e*');
  assert.strictEqual(convert('<p><del>gone</del> <s>x</s> <strike>y</strike></p>'), '~~gone~~ ~~x~~ ~~y~~');
  console.log('PASS: bold, italic, strikethrough');
}

// 6. inline code, with backtick escaping fence growth
{
  assert.strictEqual(convert('<p>Use <code>foo()</code> here</p>'), 'Use `foo()` here');
  assert.strictEqual(convert('<p><code>a`b</code></p>'), '`` a`b ``');
  console.log('PASS: inline code fencing');
}

// 7. pre + fenced code block with language, fence longer than embedded backticks
{
  assert.strictEqual(convert('<pre><code class="language-js">const x = 1;</code></pre>'), '```js\nconst x = 1;\n```');
  assert.strictEqual(convert('<pre><code>plain</code></pre>'), '```\nplain\n```');
  const withTicks = convert('<pre><code class="language-md">```inner```</code></pre>');
  assert.strictEqual(withTicks, '````md\n```inner```\n````');
  console.log('PASS: fenced code blocks');
}

// 8. blockquote, including nesting
{
  assert.strictEqual(convert('<blockquote><p>Quoted</p></blockquote>'), '> Quoted');
  assert.strictEqual(
    convert('<blockquote><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>'),
    '> Outer\n>\n> > Inner'
  );
  console.log('PASS: blockquote nesting');
}

// 9. unordered list
{
  assert.strictEqual(convert('<ul><li>One</li><li>Two</li></ul>'), '- One\n- Two');
  console.log('PASS: unordered list');
}

// 10. ordered list honouring start
{
  assert.strictEqual(convert('<ol start="3"><li>a</li><li>b</li></ol>'), '3. a\n4. b');
  console.log('PASS: ordered list start');
}

// 11. nested lists (4-space indent)
{
  const html = '<ul><li>Top<ul><li>Nested</li></ul></li><li>Second</li></ul>';
  assert.strictEqual(convert(html), '- Top\n\n    - Nested\n- Second');
  console.log('PASS: nested lists indent 4 spaces');
}

// 12. task list checkboxes
{
  const html = '<ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Todo</li></ul>';
  assert.strictEqual(convert(html), '- [x] Done\n- [ ] Todo');
  console.log('PASS: task list checkboxes');
}

// 13. links: basic, with title, javascript:/data: dropped, text-equals-href
{
  assert.strictEqual(convert('<p><a href="https://x.com">click</a></p>'), '[click](https://x.com)');
  assert.strictEqual(convert('<p><a href="https://x.com" title="X">click</a></p>'), '[click](https://x.com "X")');
  assert.strictEqual(convert('<p><a href="javascript:alert(1)">bad</a></p>'), 'bad');
  assert.strictEqual(convert('<p><a href="data:text/html,x">bad</a></p>'), 'bad');
  assert.strictEqual(convert('<p><a href="https://x.com">https://x.com</a></p>'), '[https://x.com](https://x.com)');
  console.log('PASS: link handling');
}

// 14. images: alt/src, data: dropped entirely
{
  assert.strictEqual(convert('<p><img src="https://x.com/a.png" alt="pic"></p>'), '![pic](https://x.com/a.png)');
  assert.strictEqual(convert('<p><img src="data:image/png;base64,AAAA" alt="pic"></p>'), '');
  console.log('PASS: image handling');
}

// 15. GFM table basics + acceptance case "a table copied from a web page becomes a Markdown table"
{
  const html =
    '<table><thead><tr><th>Name</th><th>Age</th></tr></thead>' +
    '<tbody><tr><td>Alice</td><td>30</td></tr><tr><td>Bob</td><td>25</td></tr></tbody></table>';
  const expected = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
  assert.strictEqual(convert(html), expected);
  console.log('PASS: a table copied from a web page becomes a Markdown table');
}

// 16. table with no thead: the first row still becomes the header (GFM requires one);
//     a table with zero cell rows synthesizes an empty header instead of throwing.
{
  const html = '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>';
  assert.strictEqual(convert(html), '| a | b |\n| --- | --- |\n| c | d |');
  assert.strictEqual(convert('<table></table>'), '');
  console.log('PASS: table without a thead uses the first row as header');
}

// 17. table alignment via align attr and inline style
{
  const html =
    '<table><thead><tr><th align="center">C</th><th style="text-align:right">R</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  assert.strictEqual(convert(html), '| C | R |\n| :---: | ---: |\n| 1 | 2 |');
  console.log('PASS: table alignment');
}

// 18. table cell escaping: pipes and newlines
{
  const html = '<table><tr><th>H</th></tr><tr><td>a | b<br>c</td></tr></table>';
  assert.strictEqual(convert(html), '| H |\n| --- |\n| a \\| b<br>c |');
  console.log('PASS: table cell pipe/newline escaping');
}

// 19. div/section/article are transparent but still break paragraphs
{
  assert.strictEqual(convert('<div>A</div><div>B</div>'), 'A\n\nB');
  assert.strictEqual(convert('<section><p>x</p><article>y</article></section>'), 'x\n\ny');
  console.log('PASS: transparent block containers');
}

// 20. Google Docs style wrapper: b/strong font-weight:normal is transparent, span weight/style
{
  assert.strictEqual(convert('<p><b style="font-weight:normal">plain</b></p>'), 'plain');
  assert.strictEqual(convert('<p><b style="font-weight:400">plain2</b></p>'), 'plain2');
  assert.strictEqual(convert('<p><span style="font-weight:700">bold</span></p>'), '**bold**');
  assert.strictEqual(convert('<p><span style="font-style:italic">it</span></p>'), '*it*');
  assert.strictEqual(convert('<p><span style="font-weight:bold;font-style:italic">bi</span></p>'), '***bi***');
  assert.strictEqual(convert('<p><span>plain</span></p>'), 'plain');
  console.log('PASS: Google Docs style wrapper quirks');
}

// 21. Chromium clipboard StartFragment/EndFragment wrapper
{
  const html =
    '<html><body><!--StartFragment--><p>Only this</p><!--EndFragment--></body></html>' +
    '<p>outside, ignored</p>';
  assert.strictEqual(convert(html), 'Only this');
  console.log('PASS: StartFragment/EndFragment fragment extraction');
}

// 22. leading <meta charset> prefix is ignored harmlessly
{
  assert.strictEqual(convert('<meta charset=\'utf-8\'><b>bold</b>'), '**bold**');
  console.log('PASS: meta charset prefix ignored');
}

// 23. malformed/unclosed tags never throw
{
  assert.doesNotThrow(() => convert('<p>unclosed paragraph'));
  assert.doesNotThrow(() => convert('<ul><li>a<li>b<li>c</ul>'));
  assert.doesNotThrow(() => convert('<table><tr><td>a<td>b<tr><td>c</table>'));
  assert.doesNotThrow(() => convert('<div><span><b>oops</div>'));
  assert.doesNotThrow(() => convert('<<<not a tag>>>'));
  assert.doesNotThrow(() => convert('<p>text</p'));
  console.log('PASS: malformed/unclosed markup does not throw');
}

// 24. script/style content is never emitted, even with hostile embedded markup
{
  const html = '<p>before</p><script>if (1<2) { document.write("<b>x</b>"); }</script><style>.a{color:red}</style><p>after</p>';
  const out = convert(html);
  assert.strictEqual(out, 'before\n\nafter');
  assert.ok(out.indexOf('document.write') === -1);
  assert.ok(out.indexOf('color:red') === -1);
  console.log('PASS: script/style content never appears in output');
}

// 25. entity decoding: named and numeric (decimal + hex)
{
  assert.strictEqual(convert('<p>Tom &amp; Jerry</p>'), 'Tom & Jerry');
  assert.strictEqual(convert('<p>&lt;tag&gt; &quot;q&quot; &apos;a&apos;</p>'), '<tag> "q" \'a\'');
  assert.strictEqual(convert('<p>&nbsp;&copy;&reg;&hellip;&mdash;&ndash;&laquo;&raquo;&yen;</p>').length > 0, true);
  assert.strictEqual(convert('<p>&#65;&#66;&#x43;</p>'), 'ABC');
  console.log('PASS: entity decoding');
}

// 26. whitespace collapsing and inline/line-start escaping
{
  assert.strictEqual(convert('<p>a   b\n\n  c</p>'), 'a b c');
  assert.strictEqual(convert('<p># not a heading</p>'), '\\# not a heading');
  assert.strictEqual(convert('<p>- not a list</p>'), '\\- not a list');
  assert.strictEqual(convert('<p>&gt; not a quote</p>'), '\\> not a quote');
  assert.strictEqual(convert('<p>1. not a list</p>'), '1\\. not a list');
  assert.strictEqual(convert('<p>Use *stars* and _underscores_ and [brackets]</p>'), 'Use \\*stars\\* and \\_underscores\\_ and \\[brackets]');
  console.log('PASS: whitespace collapsing and markdown-significant escaping');
}

// 26b. a bare web address is not escaped (C8-08: `a\_b\_c` made Ctrl+click open a cut address); snake_case needs no escape either
{
  assert.strictEqual(convert('<p>See <b>this</b> https://example.com/a_b_c?d=1</p>'), 'See **this** https://example.com/a_b_c?d=1');
  assert.strictEqual(convert('<p>Link: https://example.com/a_b*c[1] and _x_ here</p>'), 'Link: https://example.com/a_b*c[1] and \\_x\\_ here');
  assert.strictEqual(convert('<p>file_name.md and snake_case_name but _lead and trail_</p>'), 'file_name.md and snake_case_name but \\_lead and trail\\_');
  assert.strictEqual(convert('<p>x * y [z] `c`</p>'), 'x \\* y \\[z] \\`c\\`', 'the other marks are still escaped outside addresses');
  console.log('PASS: bare URLs and snake_case keep their underscores');
}

// 27. no leading/trailing blank lines, no doubled blank lines in output
{
  const html = '<p>a</p>\n\n\n<p>b</p>\n\n\n\n<p>c</p>';
  assert.strictEqual(convert(html), 'a\n\nb\n\nc');
  assert.strictEqual(convert('<p></p><p>only</p><p></p>'), 'only');
  console.log('PASS: blank line normalization');
}

// 28. performance: ~1MB of generated table + paragraph HTML converts well under budget
{
  const rows = [];
  rows.push('<table><thead><tr><th>Col A</th><th>Col B</th><th>Col C</th></tr></thead><tbody>');
  for (let i = 0; i < 6500; i++) {
    rows.push('<tr><td>Row ' + i + ' value with <b>some bold</b> text</td><td>' + i + '</td><td>data &amp; more</td></tr>');
  }
  rows.push('</tbody></table>');
  const paras = [];
  for (let i = 0; i < 5000; i++) {
    paras.push('<p>Paragraph number ' + i + ' with <em>emphasis</em> and a <a href="https://example.com/' + i + '">link</a>.</p>');
  }
  const html = rows.join('') + paras.join('');
  assert.ok(html.length > 900000, 'generated fixture should be close to 1MB, was ' + html.length);

  const started = Date.now();
  const out = convert(html);
  const elapsed = Date.now() - started;
  assert.ok(out.length > 0);
  assert.ok(elapsed < 2000, 'conversion took ' + elapsed + 'ms, expected < 2000ms');
  console.log('PASS: converts ~1MB of HTML in ' + elapsed + 'ms (< 2000ms budget)');
}

// 29. separateBlock: pasted Markdown blocks stay apart from the words around the caret (C8-04)
{
  const sep = HtmlToMd.separateBlock;
  assert.strictEqual(typeof sep, 'function');
  const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  // glued to a line of text on either side: one blank line each way
  assert.strictEqual(sep(table, 'Sales figures', ''), '\n\n' + table, 'caret at the end of a line');
  assert.strictEqual(sep(table, '', 'Intro line.'), table + '\n\n', 'caret at the start of a line of text');
  assert.strictEqual(sep(table, 'Intro ', ' line.'), '\n\n' + table + '\n\n', 'caret inside a line');
  // already on a line of its own: only what is missing is added
  assert.strictEqual(sep(table, 'Sales figures\n', ''), '\n' + table, 'one line break before already');
  assert.strictEqual(sep(table, 'Sales figures\n\n', ''), table, 'a blank line before already');
  assert.strictEqual(sep(table, 'a\n', '\nb'), '\n' + table + '\n', 'one break on each side');
  assert.strictEqual(sep(table, 'a\n\n', '\n\nb'), table, 'blank lines on both sides');
  // a caret on an empty note / empty line gets nothing added
  assert.strictEqual(sep(table, '', ''), table);
  assert.strictEqual(sep(table, '\n', '\n'), table, 'only line breaks around: nothing to separate');
  // the table pasted twice in a row (the second one lands right behind the first)
  assert.strictEqual(sep('| 1 | 2 |', '| 1 | 2 |', ''), '\n\n| 1 | 2 |', 'a table behind a table');
  // the other blocks
  assert.strictEqual(sep('## Heading', 'text', ''), '\n\n## Heading');
  assert.strictEqual(sep('## Heading', '', 'text'), '## Heading\n\n');
  assert.strictEqual(sep('- one\n- two', 'x', ''), '\n\n- one\n- two');
  assert.strictEqual(sep('1. one\n2. two', 'x', ''), '\n\n1. one\n2. two');
  assert.strictEqual(sep('> quote', 'x', ''), '\n\n> quote');
  assert.strictEqual(sep('---', 'x', ''), '\n\n---', 'a rule glued under text would turn it into a heading');
  assert.strictEqual(sep('```js\nlet a;\n```', 'x', ''), '\n\n```js\nlet a;\n```');
  assert.strictEqual(sep('![image](./assets/a.png)', '![image](./assets/b.png)', ''), '\n\n![image](./assets/a.png)', 'a picture behind a picture');
  // text that is just words stays inside the sentence: a phrase, a link or an image in the middle of a line is not a block
  ['plain words', 'a [link](https://x.example) in a line', '**bold** text', 'a ![img](x.png) caption', '#hashtag', '-5 degrees', '|x', '']
    .forEach((s) => assert.strictEqual(sep(s, 'before ', ' after'), s, JSON.stringify(s)));
  // the converter's own output: a pasted HTML table keeps apart from the line it was pasted behind
  assert.strictEqual(sep(convert('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), 'Sales figures', ''),
    '\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  // robust to missing arguments
  assert.strictEqual(sep(table), table);
  assert.strictEqual(sep(null, 'x', 'y'), '');
  console.log('PASS: separateBlock keeps pasted blocks apart from the words around the caret');
}

// 30. merged cells keep every value under its own heading (C8-05)
{
  const cols = (md) => md.split('\n').map((l) => l.split('|').length - 2);
  const colspan = convert('<table><tr><th>Item</th><th>Q1</th><th>Q2</th><th>Q3</th></tr><tr><td>A</td><td>1</td><td>2</td><td>3</td></tr>'
    + '<tr><td colspan=2>Total</td><td>4</td><td>5</td></tr></table>');
  assert.strictEqual(colspan.split('\n')[3], '| Total |  | 4 | 5 |', 'colspan: the spanned column is an empty cell, 4 and 5 stay under Q2 and Q3');
  assert.deepStrictEqual(cols(colspan), [4, 4, 4, 4]);
  const rowspan = convert('<table><tr><th>Region</th><th>Shop</th><th>Sales</th></tr><tr><td rowspan=2>East</td><td>S1</td><td>10</td></tr>'
    + '<tr><td>S2</td><td>20</td></tr><tr><td>West</td><td>S3</td><td>30</td></tr></table>');
  assert.deepStrictEqual(rowspan.split('\n').slice(2), ['| East | S1 | 10 |', '|  | S2 | 20 |', '| West | S3 | 30 |'], 'rowspan: S2 stays under Shop, 20 under Sales');
  // a header cell with colspan, a cell that spans both ways, and a bogus span
  assert.strictEqual(convert('<table><tr><th colspan=2>Name</th><th>Age</th></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>').split('\n')[0], '| Name |  | Age |');
  const both = convert('<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td rowspan=2 colspan=2>X</td><td>1</td></tr><tr><td>2</td></tr></table>');
  assert.deepStrictEqual(both.split('\n').slice(2), ['| X |  | 1 |', '|  |  | 2 |']);
  assert.ok(cols(convert('<table><tr><td colspan=999999>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'))[0] <= 52, 'a bogus colspan is capped');
  // a table without spans is unchanged
  assert.strictEqual(convert('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), '| A | B |\n| --- | --- |\n| 1 | 2 |');
  console.log('PASS: colspan and rowspan keep the values in their columns');
}

// 31. a table inside a table cell reads as its words, not as an escaped Markdown table (C8-16)
{
  const nested = convert('<table><tr><td>Outer</td><td><table><tr><td>in1</td><td>in2</td></tr></table></td></tr><tr><td>B</td><td>C</td></tr></table>');
  assert.strictEqual(nested, '| Outer | in1 in2 |\n| --- | --- |\n| B | C |');
  const deeper = convert('<table><tr><td>x</td><td>pre <table><tr><td>a</td><td><table><tr><td>b|c</td></tr></table></td></tr></table> post</td></tr></table>');
  assert.ok(deeper.indexOf('a b\\|c') !== -1 && deeper.split('---').length === 3, 'nested twice: one separator line (two columns), the pipe escaped once: ' + deeper);
  // a table that is not in a cell is still a table afterwards (the depth is back to zero)
  assert.strictEqual(convert('<table><tr><th>A</th></tr><tr><td>1</td></tr></table><table><tr><th>B</th></tr><tr><td>2</td></tr></table>'),
    '| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |');
  console.log('PASS: a nested table is flattened into its cell');
}

// 32. no-break spaces are ordinary spaces (C8-15)
{
  assert.strictEqual(convert('<p>a&nbsp;b</p>'), 'a b');
  assert.strictEqual(convert('<p>a&#160;&nbsp; b\xa0c</p>'), 'a b c', 'all spellings, and runs of them, fold into one space');
  assert.ok(convert('<p><b>x&nbsp;y</b></p>').indexOf('\xa0') === -1);
  console.log('PASS: &nbsp; becomes a plain space');
}

// 33. the time does not grow with the square of the number of <style> / <script> elements (C8-19)
{
  const proto = String.prototype;
  const original = proto.toLowerCase;
  let bigCopies = 0;
  proto.toLowerCase = function () {
    if (this.length > 5000) bigCopies++;
    return original.call(this);
  };
  try {
    const html = '<style>.a{color:red}</style><p>text</p><script>var a = 1;</script>'.repeat(4000);
    assert.strictEqual(convert(html).split('\n\n').length, 4000);
    assert.ok(bigCopies <= 1, 'the whole page was lower-cased ' + bigCopies + ' times');
  } finally {
    proto.toLowerCase = original;
  }
  console.log('PASS: <style> / <script> lookup copies the page once');
}

console.log('\nAll html_to_md tests PASSED!');
