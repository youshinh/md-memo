// Unit tests for html_comments.js: where the HTML comments of a note are (shared vectors with the Go parser),
// the caret test, masking, the exclusion rule the Go parser uses, and what the preview renders.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const HC = require('./html_comments.js');

// ---- the shared vectors: tests/fixtures/html_comment_vectors.json (pkg/slotagent/comments_test.go reads the same file) ----

(function testSharedVectors() {
  const file = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'html_comment_vectors.json');
  const vectors = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(vectors.length >= 30, 'at least 30 vectors, got ' + vectors.length);
  const names = new Set();
  for (const v of vectors) {
    assert.ok(!names.has(v.name), 'vector names are unique: ' + v.name);
    names.add(v.name);
    const got = HC.htmlCommentRanges(v.text).map(([s, e]) => v.text.slice(s, e));
    assert.deepStrictEqual(got, v.comments, 'vector "' + v.name + '"');
    // ranges are in order and do not overlap
    const rs = HC.htmlCommentRanges(v.text);
    for (let i = 1; i < rs.length; i++) assert.ok(rs[i - 1][1] <= rs[i][0], 'ordered: ' + v.name);
  }
})();

// ---- isInsideComment: strictly inside, the text after pos is not read ----------------------------

(function testIsInsideComment() {
  const t = 'a <!-- x --> b';
  const open = t.indexOf('<!--');
  const end = t.indexOf('-->') + 3;
  assert.strictEqual(HC.isInsideComment(t, open), false, 'right before <!-- is outside');
  assert.strictEqual(HC.isInsideComment(t, open + 1), true, 'between < and !');
  assert.strictEqual(HC.isInsideComment(t, open + 6), true, 'on the x');
  assert.strictEqual(HC.isInsideComment(t, end - 1), true, 'before the last >');
  assert.strictEqual(HC.isInsideComment(t, end), false, 'right after --> is outside');
  assert.strictEqual(HC.isInsideComment(t, 0), false);
  assert.strictEqual(HC.isInsideComment(t, t.length), false);
  assert.strictEqual(HC.isInsideComment(t, -1), false);
  assert.strictEqual(HC.isInsideComment(t, NaN), false);
  assert.strictEqual(HC.isInsideComment(null, 3), false);
  // multi-line
  const m = 'x\n<!--\n{{ @claude a }}\n-->\ny';
  assert.strictEqual(HC.isInsideComment(m, m.indexOf('{{')), true);
  assert.strictEqual(HC.isInsideComment(m, m.indexOf('y')), false);
  // code and markers are not comments
  assert.strictEqual(HC.isInsideComment('`<!-- x -->`', 5), false);
  assert.strictEqual(HC.isInsideComment('```\n<!-- x -->\n```', 8), false);
  assert.strictEqual(HC.isInsideComment('<!-- md-memo:run ab -->', 5), false);
  // the second of two comments; a caret between them
  const two = '<!-- a --> mid <!-- b -->';
  assert.strictEqual(HC.isInsideComment(two, two.indexOf('mid')), false);
  assert.strictEqual(HC.isInsideComment(two, two.indexOf('b')), true);
  // unterminated: never a comment
  assert.strictEqual(HC.isInsideComment('<!-- open', 5), false);
  // agrees with the ranges for every position of every vector
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'html_comment_vectors.json'), 'utf8'));
  for (const v of vectors) {
    const rs = HC.htmlCommentRanges(v.text);
    for (let p = 0; p <= v.text.length; p++) {
      const want = rs.some(([s, e]) => s < p && p < e);
      assert.strictEqual(HC.isInsideComment(v.text, p), want, v.name + ' @' + p);
    }
  }
})();

// ---- isRangeExcluded: the Go rule (isOffsetExcluded) --------------------------------------------

(function testIsRangeExcluded() {
  const rs = [[10, 20]];
  assert.strictEqual(HC.isRangeExcluded(rs, 12, 15), true, 'inside');
  assert.strictEqual(HC.isRangeExcluded(rs, 12, 25), true, 'starts inside');
  assert.strictEqual(HC.isRangeExcluded(rs, 5, 15), true, 'ends inside');
  assert.strictEqual(HC.isRangeExcluded(rs, 5, 20), true, 'ends exactly at the end');
  assert.strictEqual(HC.isRangeExcluded(rs, 10, 20), true, 'the comment itself');
  assert.strictEqual(HC.isRangeExcluded(rs, 5, 25), false, 'holds the whole comment: not excluded (same as Go)');
  assert.strictEqual(HC.isRangeExcluded(rs, 0, 10), false, 'ends right before it');
  assert.strictEqual(HC.isRangeExcluded(rs, 20, 30), false, 'starts right after it');
  assert.strictEqual(HC.isRangeExcluded([], 0, 5), false);
  assert.strictEqual(HC.isRangeExcluded(null, 0, 5), false);
})();

// ---- maskComments / unclosedCommentAt -------------------------------------------------------------

(function testMaskComments() {
  const t = 'a <!-- x\r\ny --> b `<!-- code -->` <!-- md-memo:run ab -->';
  const m = HC.maskComments(t);
  assert.strictEqual(m.length, t.length, 'same length');
  assert.strictEqual(m, 'a       \r\n      b `<!-- code -->` <!-- md-memo:run ab -->', 'line breaks kept, code and markers untouched');
  assert.strictEqual(HC.maskComments('no comment'), 'no comment');
  assert.strictEqual(HC.maskComments(''), '');
  assert.strictEqual(HC.maskComments(null), '');
  const emoji = '😀<!-- 😀 -->😀';
  assert.strictEqual(HC.maskComments(emoji), '😀' + ' '.repeat(11) + '😀', 'a surrogate pair becomes two spaces: indexes stay');
})();

(function testUnclosedCommentAt() {
  assert.strictEqual(HC.unclosedCommentAt('a <!-- b'), 2);
  assert.strictEqual(HC.unclosedCommentAt('<!-- a --> b <!-- c'), 13);
  assert.strictEqual(HC.unclosedCommentAt('<!-- a -->'), -1);
  assert.strictEqual(HC.unclosedCommentAt('`<!-- code` x'), -1, 'in code: not a comment start');
  assert.strictEqual(HC.unclosedCommentAt('```\n<!-- a\n```'), -1);
  assert.strictEqual(HC.unclosedCommentAt(''), -1);
})();

// ---- removeComments: what the preview renders -----------------------------------------------------

(function testRemoveComments() {
  const r = HC.removeComments;
  assert.strictEqual(r('no comment'), 'no comment');
  assert.strictEqual(r('para 1\n<!-- hidden -->\npara 2'), 'para 1\npara 2', 'a comment line goes with its line break: one paragraph');
  assert.strictEqual(r('para 1\n<!--\nmulti\n-->\npara 2'), 'para 1\npara 2', 'a multi-line comment too');
  assert.strictEqual(r('a <!-- x --> b'), 'a  b', 'inline: cut out in place');
  assert.strictEqual(r('text <!-- a\nb -->\nnext'), 'text \nnext', 'a comment that starts after text keeps the line break after it');
  assert.strictEqual(r('para 1\n  <!-- a --> <!-- b -->  \npara 2'), 'para 1\npara 2', 'several comments and spaces: the line goes');
  assert.strictEqual(r('> quote\n> <!-- c -->\n> more'), '> quote\n> more', 'a blockquote line with only a comment goes');
  assert.strictEqual(r('- item\n  <!-- note -->\n- next'), '- item\n- next');
  assert.strictEqual(r('para 1\n\n<!-- c -->\n\npara 2'), 'para 1\n\n\npara 2', 'blank lines that were there stay');
  assert.strictEqual(r('para\r\n<!-- c -->\r\nnext'), 'para\r\nnext', 'CRLF');
  assert.strictEqual(r('<!-- only -->'), '');
  assert.strictEqual(r('last\n<!-- c -->'), 'last\n');
  assert.strictEqual(r('```\n<!-- code -->\n```'), '```\n<!-- code -->\n```', 'code is untouched');
  assert.strictEqual(r('`<!-- code -->`'), '`<!-- code -->`');
  assert.strictEqual(r('a <!-- open'), 'a <!-- open', 'an unclosed <!-- stays');
  const block = '[[ @llm x ]]\n<!-- md-memo:res ab12 -->\nanswer\n<!-- /md-memo:res -->';
  assert.strictEqual(r(block), block, 'markers are left for stripMarkers');
  assert.strictEqual(r('<!-- ``` -->\ntext\n```\ncode\n```'), 'text\n```\ncode\n```', 'a fence inside a comment cannot pair with a real one');
})();

// ---- the real markdown-it the app ships, configured like app.js ------------------------------------

(function testPreviewWithMarkdownIt() {
  const ctx = {};
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'markdown-it.min.js'), 'utf8'), ctx);
  const md = ctx.markdownit({ html: false, linkify: true, typographer: true, breaks: true });
  const render = (text) => md.render(HC.removeComments(text));

  // Before: html:false shows a comment as escaped text
  assert.ok(md.render('<!-- hidden -->').indexOf('&lt;!--') !== -1, 'stock rendering shows the comment (why removeComments exists)');

  assert.strictEqual(render('<!-- hidden -->'), '', 'a comment alone renders nothing');
  assert.strictEqual(render('para 1\n<!-- hidden -->\npara 2'), '<p>para 1<br>\npara 2</p>\n', 'one paragraph, no gap');
  assert.strictEqual(render('a <!-- x --> b'), '<p>a  b</p>\n');
  const multi = render('# Title\n<!--\n{{ @claude secret }}\n-->\ntext');
  assert.ok(multi.indexOf('secret') === -1 && multi.indexOf('&lt;!--') === -1, multi);
  assert.ok(multi.indexOf('<h1>Title</h1>') !== -1 && multi.indexOf('<p>text</p>') !== -1, multi);
  // code keeps its comments, as text
  const fenced = render('```html\n<!-- shown -->\n```');
  assert.ok(fenced.indexOf('&lt;!-- shown --&gt;') !== -1, fenced);
  const inline = render('use `<!-- -->` and ``<!-- x -->`` here');
  assert.strictEqual(inline, '<p>use <code>&lt;!-- --&gt;</code> and <code>&lt;!-- x --&gt;</code> here</p>\n');
  // an unclosed comment stays visible text
  assert.ok(render('a <!-- open').indexOf('&lt;!-- open') !== -1);
  // a list item and a quote keep their structure
  assert.strictEqual(render('- a\n  <!-- n -->\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n');
  assert.strictEqual(render('> q\n> <!-- c -->\n> r'), '<blockquote>\n<p>q<br>\nr</p>\n</blockquote>\n');
})();

// ---- cost: no "<!--", no work ----------------------------------------------------------------------

(function testCheapWithoutComments() {
  const big = 'line of text with `code` and {{ slot }}\n'.repeat(20000);
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) HC.htmlCommentRanges(big);
  assert.ok(Date.now() - t0 < 500, 'a note without "<!--" is an indexOf, not a scan');
  assert.deepStrictEqual(HC.htmlCommentRanges(big), []);
  assert.strictEqual(HC.removeComments(big), big);
})();

console.log('html_comments tests passed');
