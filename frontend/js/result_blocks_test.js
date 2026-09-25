// Unit tests for result_blocks.js: finding result blocks in a note (LF and CRLF, fences, unclosed openers),
// the caret helpers, the delete / confirm edits, and the position math of the gutter bars.
const assert = require('assert');

global.window = global;
const RB = require('./result_blocks.js');

const OPEN = (id, attrs) => '<!-- md-memo:res ' + id + (attrs ? ' ' + attrs : '') + ' -->';
const CLOSE = '<!-- /md-memo:res -->';

function apply(text, edit) {
  return text.slice(0, edit.start) + (edit.replacement || '') + text.slice(edit.end);
}

// Where a string sits in a text, for exact-offset expectations.
function at(text, needle, from) {
  const i = text.indexOf(needle, from || 0);
  assert.ok(i >= 0, 'test setup: ' + JSON.stringify(needle) + ' not in text');
  return i;
}

(function testNothingToFind() {
  assert.deepStrictEqual(RB.findResultBlocks(''), []);
  assert.deepStrictEqual(RB.findResultBlocks('plain note\nwith [[ @llm x ]] in it\n'), []);
  assert.deepStrictEqual(RB.findResultBlocks(null), [], 'not a string');
  assert.deepStrictEqual(RB.findResultBlocks(undefined), []);
  // a run marker alone is not a result block
  assert.deepStrictEqual(RB.findResultBlocks('task\n<!-- md-memo:run a1b2 -->\n'), []);
  // a closer alone is not one either
  assert.deepStrictEqual(RB.findResultBlocks('x\n' + CLOSE + '\ny'), []);
  assert.deepStrictEqual(RB.blockAt('plain', 2), null);
  assert.strictEqual(RB.nextBlock('plain', 2, 1), null);
  assert.strictEqual(RB.nextBlock('plain', 2, -1), null);
  assert.strictEqual(RB.nextBlock('', 0, 1), null);
})();

(function testOneBlockLf() {
  const text = ['before', OPEN('a1b2'), 'result', CLOSE, 'after'].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.strictEqual(blocks.length, 1);
  const b = blocks[0];
  assert.strictEqual(b.id, 'a1b2');
  assert.strictEqual(b.closed, true);
  assert.strictEqual(b.openLine, 1);
  assert.strictEqual(b.closeLine, 3);
  assert.strictEqual(b.openStart, at(text, '<!-- md-memo:res'));
  assert.strictEqual(b.openEnd, b.openStart + OPEN('a1b2').length, 'the opener line without its line break');
  assert.strictEqual(text.slice(b.openStart, b.openEnd), OPEN('a1b2'));
  assert.strictEqual(text.slice(b.bodyStart, b.bodyEnd), 'result', 'the body without the breaks next to the markers');
  assert.strictEqual(text.slice(b.closeStart, b.closeEnd), CLOSE);
  assert.strictEqual(text.charAt(b.openEnd), '\n');
  assert.strictEqual(text.charAt(b.closeEnd), '\n');
  assert.strictEqual(RB.bodyText(text, b), 'result');
})();

(function testOneBlockCrlf() {
  const text = ['before', OPEN('a1b2'), 'line one', 'line two', CLOSE, 'after'].join('\r\n');
  const blocks = RB.findResultBlocks(text);
  assert.strictEqual(blocks.length, 1);
  const b = blocks[0];
  assert.strictEqual(b.openLine, 1);
  assert.strictEqual(b.closeLine, 4);
  assert.strictEqual(text.slice(b.openStart, b.openEnd), OPEN('a1b2'), 'no \\r in the opener line');
  assert.strictEqual(text.slice(b.closeStart, b.closeEnd), CLOSE, 'no \\r in the closer line');
  assert.strictEqual(text.slice(b.bodyStart, b.bodyEnd), 'line one\r\nline two', 'the breaks inside the body stay, the outer ones are gone');
  assert.strictEqual(text.slice(b.openEnd, b.openEnd + 2), '\r\n');
  assert.strictEqual(text.slice(b.closeEnd, b.closeEnd + 2), '\r\n');
  assert.strictEqual(RB.bodyText(text, b), 'line one\r\nline two');
})();

(function testMixedEndings() {
  // an opener with CRLF, a closer with LF (a file edited by two programs)
  const text = 'x\r\n' + OPEN('a1b2') + '\r\nbody\n' + CLOSE + '\n';
  const b = RB.findResultBlocks(text)[0];
  assert.strictEqual(b.closed, true);
  assert.strictEqual(text.slice(b.bodyStart, b.bodyEnd), 'body');
  assert.strictEqual(text.slice(b.openStart, b.openEnd), OPEN('a1b2'));
})();

(function testBodies() {
  // no body line at all
  let text = ['a', OPEN('e1'), CLOSE, 'b'].join('\n');
  let b = RB.findResultBlocks(text)[0];
  assert.strictEqual(b.closeLine, b.openLine + 1);
  assert.strictEqual(b.bodyStart, b.bodyEnd, 'an empty range');
  assert.strictEqual(b.bodyStart, b.closeStart);
  assert.strictEqual(RB.bodyText(text, b), '');

  // one empty body line: still an empty body text, but the block has a body line
  text = ['a', OPEN('e2'), '', CLOSE, 'b'].join('\n');
  b = RB.findResultBlocks(text)[0];
  assert.strictEqual(b.closeLine, b.openLine + 2);
  assert.strictEqual(b.bodyStart, b.bodyEnd);
  assert.strictEqual(RB.bodyText(text, b), '');
  text = ['a', OPEN('e3'), '', CLOSE, 'b'].join('\r\n');
  b = RB.findResultBlocks(text)[0];
  assert.strictEqual(b.bodyStart, b.bodyEnd, 'CRLF: the empty line is an empty range too');
  assert.strictEqual(b.closeLine, b.openLine + 2);

  // several lines, blank lines inside, markdown and code
  text = [OPEN('m1'), '# Title', '', '- item', '', '```js', 'const x = 1;', '```', CLOSE].join('\n');
  b = RB.findResultBlocks(text)[0];
  assert.strictEqual(RB.bodyText(text, b), '# Title\n\n- item\n\n```js\nconst x = 1;\n```');
  assert.strictEqual(b.openLine, 0);
  assert.strictEqual(b.closeLine, 8);

  // trailing and leading blank lines of the body are kept as they are
  text = [OPEN('m2'), '', 'x', '', CLOSE].join('\n');
  assert.strictEqual(RB.bodyText(text, RB.findResultBlocks(text)[0]), '\nx\n');
})();

(function testAttributesAndIds() {
  const text = [
    OPEN('a1b2', 'ctx=above n=1'), 'x', CLOSE,
    '<!--   md-memo:res   zz9    -->', 'y', '<!--/md-memo:res-->',
    '  ' + OPEN('c3'), 'z', '  ' + CLOSE + '  '
  ].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.deepStrictEqual(blocks.map((b) => b.id), ['a1b2', 'zz9', 'c3']);
  assert.ok(blocks.every((b) => b.closed));
  assert.strictEqual(text.slice(blocks[0].openStart, blocks[0].openEnd), OPEN('a1b2', 'ctx=above n=1'));
  assert.strictEqual(text.slice(blocks[2].openStart, blocks[2].openEnd), '  ' + OPEN('c3'), 'the indent is inside the line');
  assert.strictEqual(text.slice(blocks[2].closeStart, blocks[2].closeEnd), '  ' + CLOSE + '  ', 'and so is trailing space');
  assert.strictEqual(RB.bodyText(text, blocks[2]), 'z');

  // an ideographic-space indent (typed by a Japanese IME)
  const ja = '　' + OPEN('j1') + '\nx\n　' + CLOSE;
  assert.strictEqual(RB.findResultBlocks(ja).length, 1);

  // an opener without an id is still an opener
  const noId = ['<!-- md-memo:res -->', 'x', CLOSE].join('\n');
  const nb = RB.findResultBlocks(noId);
  assert.strictEqual(nb.length, 1);
  assert.strictEqual(nb[0].id, '');
})();

(function testLinesThatAreNotMarkers() {
  const notMarkers = [
    'text <!-- md-memo:res a1b2 --> in a line',
    '<!-- md-memo:result a1b2 -->',
    '<!-- md-memo:res a1b2',
    'md-memo:res a1b2',
    '<!-- md-memo:res a1b2 --> trailing',
    '&lt;!-- md-memo:res a1b2 --&gt;',
    '> <!-- md-memo:res a1b2 -->',
    '<!-- md-memo:ress a1b2 -->'
  ];
  for (const line of notMarkers) {
    const text = [line, 'body', CLOSE].join('\n');
    assert.deepStrictEqual(RB.findResultBlocks(text), [], 'not an opener: ' + line);
  }
  // an opener whose closer has trailing text is unclosed
  const text = [OPEN('a1'), 'body', '<!-- /md-memo:res --> more'].join('\n');
  const b = RB.findResultBlocks(text);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].closed, false);
})();

(function testSeveralBlocks() {
  const text = ['intro', OPEN('a'), 'one', CLOSE, '', 'middle', OPEN('b'), 'two', 'three', CLOSE, OPEN('c'), CLOSE, 'end'].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.deepStrictEqual(blocks.map((b) => b.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(blocks.map((b) => b.openLine), [1, 6, 10]);
  assert.deepStrictEqual(blocks.map((b) => b.closeLine), [3, 9, 11]);
  assert.deepStrictEqual(blocks.map((b) => RB.bodyText(text, b)), ['one', 'two\nthree', '']);
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].openStart > blocks[i - 1].closeEnd, 'in order, never overlapping');
})();

(function testNonAscii() {
  const body = '日本語の結果 😀 with emoji\n二行目';
  const text = '見出し 😀\n' + OPEN('ja1') + '\n' + body + '\n' + CLOSE + '\n後ろ';
  const b = RB.findResultBlocks(text)[0];
  assert.strictEqual(b.openLine, 1);
  assert.strictEqual(RB.bodyText(text, b), body);
  assert.strictEqual(b.openStart, '見出し 😀\n'.length, 'offsets count UTF-16 units: the emoji is two');
  assert.strictEqual(apply(text, RB.deleteRange(text, b)), '見出し 😀\n後ろ');
  assert.strictEqual(apply(text, RB.confirmEdit(text, b)), '見出し 😀\n' + body + '\n後ろ');
})();

(function testEdges() {
  // the block is the whole text, with and without a final line break
  for (const text of [[OPEN('a'), 'x', CLOSE].join('\n'), [OPEN('a'), 'x', CLOSE, ''].join('\n')]) {
    const b = RB.findResultBlocks(text)[0];
    assert.strictEqual(b.openStart, 0);
    assert.strictEqual(b.openLine, 0);
    assert.strictEqual(b.closeLine, 2);
    assert.deepStrictEqual(RB.blockAt(text, 0), b, 'the caret at the very start of the note is on the opener');
    assert.deepStrictEqual(RB.blockAt(text, b.closeEnd), b);
  }
  // right at the start, then text
  let text = [OPEN('a'), 'x', CLOSE, 'tail'].join('\n');
  let blocks = RB.findResultBlocks(text);
  assert.strictEqual(blocks[0].openStart, 0);
  // at the very end, no final line break
  text = ['head', OPEN('a'), 'x', CLOSE].join('\n');
  blocks = RB.findResultBlocks(text);
  assert.strictEqual(blocks[0].closeEnd, text.length);
  // an opener as the very last line: unclosed
  text = 'head\n' + OPEN('a');
  blocks = RB.findResultBlocks(text);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].closed, false);
  assert.strictEqual(blocks[0].openEnd, text.length);
})();

(function testUnclosed() {
  const text = ['top', OPEN('u1'), 'half a resu'].join('\n');
  const [b] = RB.findResultBlocks(text);
  assert.strictEqual(b.closed, false);
  assert.strictEqual(b.id, 'u1');
  assert.strictEqual(b.openLine, 1);
  assert.strictEqual(b.closeLine, -1);
  assert.strictEqual(b.closeStart, -1);
  assert.strictEqual(b.closeEnd, -1);
  assert.strictEqual(text.slice(b.openStart, b.openEnd), OPEN('u1'));
  assert.strictEqual(RB.bodyText(text, b), '', 'no body is known');
  assert.strictEqual(RB.deleteRange(text, b), null);
  assert.strictEqual(RB.confirmEdit(text, b), null);

  // an opener followed by another opener: the first never finished, the second is a whole block
  const two = [OPEN('u1'), 'partial', OPEN('ok'), 'done', CLOSE, 'after'].join('\n');
  const blocks = RB.findResultBlocks(two);
  assert.deepStrictEqual(blocks.map((x) => [x.id, x.closed]), [['u1', false], ['ok', true]]);
  assert.strictEqual(RB.bodyText(two, blocks[1]), 'done', 'the second block is not swallowed by the first');
  assert.strictEqual(blocks[0].openLine, 0);
  assert.strictEqual(blocks[1].openLine, 2);

  // a run marker (a second run started below a crashed one) also ends it
  const withRun = [OPEN('u1'), 'partial', '<!-- md-memo:run r1 -->', 'more text', CLOSE].join('\n');
  const wr = RB.findResultBlocks(withRun);
  assert.strictEqual(wr.length, 1);
  assert.strictEqual(wr[0].closed, false, 'a lone closer after a run marker closes nothing');

  // only the opener line is "in" an unclosed block for blockAt
  assert.deepStrictEqual(RB.blockAt(two, 3), blocks[0]);
  assert.deepStrictEqual(RB.blockAt(two, two.indexOf('partial') + 2), null);
})();

(function testFences() {
  const inBackticks = ['```md', OPEN('a'), 'x', CLOSE, '```'].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(inBackticks), [], 'a block written inside a ``` fence is only text');
  const inTildes = ['~~~', OPEN('a'), 'x', CLOSE, '~~~'].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(inTildes), [], 'and inside ~~~');
  const indented = ['  ```', OPEN('a'), CLOSE, '  ```'].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(indented), [], 'an indented fence (a list item)');
  const crlf = ['```', OPEN('a'), 'x', CLOSE, '```'].join('\r\n');
  assert.deepStrictEqual(RB.findResultBlocks(crlf), [], 'CRLF');

  // after the fence has closed, a block is real again
  const after = ['```', 'code', '```', OPEN('real'), 'x', CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(after).map((b) => b.id), ['real']);
  assert.strictEqual(RB.findResultBlocks(after)[0].openLine, 3);

  // before the fence: real; inside: not; after: real
  const three = [OPEN('a'), 'x', CLOSE, '```', OPEN('b'), 'y', CLOSE, '```', OPEN('c'), 'z', CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(three).map((b) => b.id), ['a', 'c']);
  assert.deepStrictEqual(RB.findResultBlocks(three).map((b) => b.openLine), [0, 8]);

  // a fence that never closes runs to the end of the note
  const open = ['```', 'code', OPEN('a'), 'x', CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(open), []);

  // the closing fence has to be the same character and at least as long; other runs are just content
  const mixed = ['````', '```', OPEN('a'), CLOSE, '```', '````', OPEN('real'), CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(mixed).map((b) => b.id), ['real'], 'a shorter ``` inside ```` does not close it');
  const tildeInTicks = ['```', '~~~', OPEN('a'), CLOSE, '~~~', '```', OPEN('real'), CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(tildeInTicks).map((b) => b.id), ['real']);
  const closerNeedsBlank = ['```', 'x', '```js', OPEN('a'), CLOSE, '```'].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(closerNeedsBlank), [], '```js is not a closing fence, so the fence stays open');

  // inline triple backticks in a line are not a fence
  const inline = ['use ``` to fence code', OPEN('a'), 'x', CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(inline).map((b) => b.id), ['a']);
  const info = ['```js `x`', OPEN('a'), CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(info).map((b) => b.id), ['a'], 'a backtick fence has no backtick in its info string, so this line is no fence');

  // a result whose body holds a whole code block (an agent answer): the block is found, and what follows it is read normally
  const withCode = [OPEN('a'), 'here:', '```js', 'let x;', '```', 'done', CLOSE, OPEN('b'), 'y', CLOSE].join('\n');
  assert.deepStrictEqual(RB.findResultBlocks(withCode).map((b) => b.id), ['a', 'b']);
  assert.strictEqual(RB.bodyText(withCode, RB.findResultBlocks(withCode)[0]), 'here:\n```js\nlet x;\n```\ndone');

  // a body with a fence it never closes (a cut-off answer) still ends at the closer, and does not swallow the rest of the note
  const cut = [OPEN('a'), 'here:', '```js', 'let x;', CLOSE, 'plain text', OPEN('b'), 'y', CLOSE].join('\n');
  const cutBlocks = RB.findResultBlocks(cut);
  assert.deepStrictEqual(cutBlocks.map((b) => [b.id, b.closed]), [['a', true], ['b', true]]);
})();

(function testBlockAt() {
  const text = ['head', OPEN('a'), 'body', CLOSE, 'mid', OPEN('b'), CLOSE, 'tail'].join('\n');
  const [a, b] = RB.findResultBlocks(text);
  assert.deepStrictEqual(RB.blockAt(text, 0), null, 'before everything');
  assert.deepStrictEqual(RB.blockAt(text, a.openStart - 1), null, 'the end of the line above the opener is on that line');
  assert.deepStrictEqual(RB.blockAt(text, a.openStart), a, 'the start of the opener line');
  assert.deepStrictEqual(RB.blockAt(text, a.openStart + 5), a, 'inside the opener line');
  assert.deepStrictEqual(RB.blockAt(text, a.openEnd), a, 'the end of the opener line');
  assert.deepStrictEqual(RB.blockAt(text, a.bodyStart), a, 'the start of the body');
  assert.deepStrictEqual(RB.blockAt(text, a.bodyStart + 2), a, 'inside the body');
  assert.deepStrictEqual(RB.blockAt(text, a.closeStart), a, 'the start of the closer line');
  assert.deepStrictEqual(RB.blockAt(text, a.closeEnd), a, 'the end of the closer line');
  assert.deepStrictEqual(RB.blockAt(text, a.closeEnd + 1), null, 'the line below the closer');
  assert.deepStrictEqual(RB.blockAt(text, text.indexOf('mid') + 1), null, 'between the blocks');
  assert.deepStrictEqual(RB.blockAt(text, b.openStart), b);
  assert.deepStrictEqual(RB.blockAt(text, b.closeEnd), b);
  assert.deepStrictEqual(RB.blockAt(text, text.length), null, 'the end of the note');
  assert.deepStrictEqual(RB.blockAt(text, -5), null);

  // an empty body: the caret between the two marker lines is on the closer
  assert.deepStrictEqual(RB.blockAt(text, b.closeStart), b);
})();

(function testNextBlock() {
  const text = ['top', OPEN('a'), 'x', CLOSE, 'mid', OPEN('b'), 'y', CLOSE, OPEN('c'), CLOSE, 'end'].join('\n');
  const [a, b, c] = RB.findResultBlocks(text);
  const id = (blk) => (blk ? blk.id : null);
  // forward: the first opener that starts after the caret
  assert.strictEqual(id(RB.nextBlock(text, 0, 1)), 'a');
  assert.strictEqual(id(RB.nextBlock(text, a.openStart - 1, 1)), 'a');
  assert.strictEqual(id(RB.nextBlock(text, a.openStart, 1)), 'b', 'on the opener of a: the next one is b');
  assert.strictEqual(id(RB.nextBlock(text, a.bodyStart, 1)), 'b', 'inside a: b');
  assert.strictEqual(id(RB.nextBlock(text, b.openStart, 1)), 'c');
  assert.strictEqual(id(RB.nextBlock(text, c.openStart, 1)), 'a', 'after the last opener it wraps to the first');
  assert.strictEqual(id(RB.nextBlock(text, text.length, 1)), 'a', 'at the end of the note it wraps');
  // backward: the last opener that starts before the caret
  assert.strictEqual(id(RB.nextBlock(text, text.length, -1)), 'c');
  assert.strictEqual(id(RB.nextBlock(text, c.openStart + 1, -1)), 'c', 'inside c, "previous" is c itself (by opener)');
  assert.strictEqual(id(RB.nextBlock(text, c.openStart, -1)), 'b');
  assert.strictEqual(id(RB.nextBlock(text, b.openStart, -1)), 'a');
  assert.strictEqual(id(RB.nextBlock(text, a.openStart, -1)), 'c', 'before the first opener it wraps to the last');
  assert.strictEqual(id(RB.nextBlock(text, 0, -1)), 'c');
  // a note with one block: both directions land on it
  const one = 'x\n' + OPEN('only') + '\n' + CLOSE + '\n';
  assert.strictEqual(id(RB.nextBlock(one, 0, 1)), 'only');
  assert.strictEqual(id(RB.nextBlock(one, one.length, 1)), 'only');
  assert.strictEqual(id(RB.nextBlock(one, 3, 1)), 'only', 'on its own opener line: itself, after wrapping');
  assert.strictEqual(id(RB.nextBlock(one, one.length, -1)), 'only');
  // an unclosed opener is a stop as well
  const un = ['a', OPEN('u'), 'b', OPEN('ok'), CLOSE].join('\n');
  assert.strictEqual(id(RB.nextBlock(un, 0, 1)), 'u');
  assert.strictEqual(id(RB.nextBlock(un, un.indexOf('b\n') + 1, 1)), 'ok');
  // pickBlock takes an array a caller already has
  assert.deepStrictEqual(RB.pickBlock([], 3, 1), null);
  assert.deepStrictEqual(RB.pickBlock(null, 3, -1), null);
  assert.deepStrictEqual(RB.pickBlock([a, b, c], a.openStart, 1), b);
})();

(function testDeleteRange() {
  // in the middle
  let text = ['a', OPEN('x'), 'body', CLOSE, 'b'].join('\n');
  let b = RB.findResultBlocks(text)[0];
  let r = RB.deleteRange(text, b);
  assert.strictEqual(text.slice(r.start, r.end), OPEN('x') + '\nbody\n' + CLOSE + '\n', 'the block and its closer line break');
  assert.strictEqual(apply(text, r), 'a\nb', 'no empty line left');

  // first in the note
  text = [OPEN('x'), 'body', CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.deleteRange(text, RB.findResultBlocks(text)[0])), 'b');

  // last line without a final line break: the break before the opener goes
  text = ['a', OPEN('x'), 'body', CLOSE].join('\n');
  b = RB.findResultBlocks(text)[0];
  r = RB.deleteRange(text, b);
  assert.strictEqual(r.start, b.openStart - 1);
  assert.strictEqual(r.end, text.length);
  assert.strictEqual(apply(text, r), 'a');

  // last line WITH a final line break: it is the closer's own break that goes
  text = ['a', OPEN('x'), 'body', CLOSE, ''].join('\n');
  assert.strictEqual(apply(text, RB.deleteRange(text, RB.findResultBlocks(text)[0])), 'a\n');

  // the whole note is the block
  text = [OPEN('x'), 'body', CLOSE].join('\n');
  r = RB.deleteRange(text, RB.findResultBlocks(text)[0]);
  assert.deepStrictEqual(r, { start: 0, end: text.length });
  assert.strictEqual(apply(text, r), '');

  // CRLF, in the middle and at the end
  text = ['a', OPEN('x'), 'body', CLOSE, 'b'].join('\r\n');
  assert.strictEqual(apply(text, RB.deleteRange(text, RB.findResultBlocks(text)[0])), 'a\r\nb');
  text = ['a', OPEN('x'), 'body', CLOSE].join('\r\n');
  assert.strictEqual(apply(text, RB.deleteRange(text, RB.findResultBlocks(text)[0])), 'a', 'CRLF before the opener goes whole');

  // two blocks in a row: deleting the first leaves the second
  text = [OPEN('x'), 'one', CLOSE, OPEN('y'), 'two', CLOSE].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.strictEqual(apply(text, RB.deleteRange(text, blocks[0])), [OPEN('y'), 'two', CLOSE].join('\n'));
  assert.strictEqual(apply(text, RB.deleteRange(text, blocks[1])), [OPEN('x'), 'one', CLOSE].join('\n'));

  // an empty block
  text = ['a', OPEN('x'), CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.deleteRange(text, RB.findResultBlocks(text)[0])), 'a\nb');

  // not a block
  assert.strictEqual(RB.deleteRange(text, null), null);
})();

(function testConfirmEdit() {
  // in the middle: the two marker lines go, the body stays with its own line break
  let text = ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\n');
  let b = RB.findResultBlocks(text)[0];
  let e = RB.confirmEdit(text, b);
  assert.strictEqual(apply(text, e), 'a\none\ntwo\nb');
  assert.strictEqual(e.start, b.openStart);
  assert.strictEqual(e.replacement, 'one\ntwo\n', 'body followed by the line break the block had');
  assert.strictEqual(text.slice(e.start, e.end), OPEN('x') + '\none\ntwo\n' + CLOSE + '\n');

  // CRLF keeps CRLF
  text = ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\r\n');
  e = RB.confirmEdit(text, RB.findResultBlocks(text)[0]);
  assert.strictEqual(apply(text, e), ['a', 'one', 'two', 'b'].join('\r\n'));
  assert.strictEqual(e.replacement, 'one\r\ntwo\r\n');

  // last line, no final break: nothing is added, nothing before is eaten
  text = ['a', OPEN('x'), 'one', CLOSE].join('\n');
  e = RB.confirmEdit(text, RB.findResultBlocks(text)[0]);
  assert.strictEqual(apply(text, e), 'a\none');

  // last line with a final break
  text = ['a', OPEN('x'), 'one', CLOSE, ''].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'a\none\n');

  // the whole note
  text = [OPEN('x'), 'one', CLOSE].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'one');

  // no body line: confirming is deleting
  text = ['a', OPEN('x'), CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'a\nb');
  text = ['a', OPEN('x'), CLOSE].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'a');

  // an empty body LINE is a line of the note and stays
  text = ['a', OPEN('x'), '', CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'a\n\nb');

  // blank lines around the body stay too
  text = ['a', OPEN('x'), '', 'one', '', CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), 'a\n\none\n\nb');

  // a task notation in the body is in the note as it was written (it is live again: that is the caller's warning to give)
  text = [OPEN('x'), '[[ @llm again ]]', CLOSE, 'b'].join('\n');
  assert.strictEqual(apply(text, RB.confirmEdit(text, RB.findResultBlocks(text)[0])), '[[ @llm again ]]\nb');

  // several blocks: only the chosen one changes
  text = [OPEN('x'), 'one', CLOSE, OPEN('y'), 'two', CLOSE].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.strictEqual(apply(text, RB.confirmEdit(text, blocks[1])), [OPEN('x'), 'one', CLOSE, 'two'].join('\n'));

  assert.strictEqual(RB.confirmEdit(text, null), null);
})();

(function testRoundTrips() {
  // Build notes from known parts, in LF and CRLF, then check that every block is found where it was put and
  // that delete and confirm give the same text as taking the block out of the parts.
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const freeLines = ['plain', '', '- item', '# head', '日本語', 'x < y', '`code`', '[[ @llm question ]]', '<!-- other comment -->'];
  for (let round = 0; round < 300; round++) {
    const eol = rnd(2) ? '\r\n' : '\n';
    const parts = []; // { kind: 'line'|'block', lines: [...] }
    const count = 1 + rnd(6);
    for (let i = 0; i < count; i++) {
      if (rnd(2)) {
        parts.push({ kind: 'line', lines: [freeLines[rnd(freeLines.length)]] });
      } else {
        const body = [];
        for (let k = rnd(4); k > 0; k--) body.push(freeLines[rnd(freeLines.length)]);
        parts.push({ kind: 'block', id: 'b' + i, body: body, lines: [OPEN('b' + i)].concat(body, [CLOSE]) });
      }
    }
    const endBreak = rnd(2) ? eol : '';
    const build = (ps) => ps.map((p) => p.lines.join(eol)).join(eol) + (ps.length ? endBreak : '');
    const text = build(parts);
    const found = RB.findResultBlocks(text);
    const expected = parts.filter((p) => p.kind === 'block');
    assert.deepStrictEqual(found.map((b) => b.id), expected.map((p) => p.id), 'ids in round ' + round + ': ' + JSON.stringify(text));
    let line = 0;
    let bi = 0;
    for (const p of parts) {
      if (p.kind === 'block') {
        const b = found[bi++];
        assert.strictEqual(b.openLine, line, 'openLine');
        assert.strictEqual(b.closeLine, line + p.lines.length - 1, 'closeLine');
        assert.strictEqual(RB.bodyText(text, b), p.body.join(eol), 'body of ' + p.id + ' in ' + JSON.stringify(text));
        assert.strictEqual(text.slice(b.openStart, b.openEnd), OPEN(p.id));
        assert.strictEqual(text.slice(b.closeStart, b.closeEnd), CLOSE);
      }
      line += p.lines.length;
    }
    // delete each block in turn
    for (let k = 0; k < expected.length; k++) {
      const without = parts.filter((p) => p !== expected[k]);
      const want = build(without);
      const got = apply(text, RB.deleteRange(text, found[k]));
      assert.strictEqual(got, want, 'delete ' + expected[k].id + ' from ' + JSON.stringify(text));
      // confirm: the marker lines go, the rest stays
      const confirmed = parts.map((p) => (p === expected[k] ? { kind: 'line', lines: p.body } : p)).filter((p) => p.lines.length);
      const gotC = apply(text, RB.confirmEdit(text, found[k]));
      assert.strictEqual(gotC, build(confirmed), 'confirm ' + expected[k].id + ' in ' + JSON.stringify(text));
    }
  }
})();

(function testAccentBars() {
  const lh = 20;
  // no rows: every line is one row
  const text = ['a', OPEN('x'), 'one', 'two', CLOSE, 'b'].join('\n');
  const blocks = RB.findResultBlocks(text);
  assert.deepStrictEqual(RB.accentBars(blocks, null, lh), [
    { kind: 'open', top: 20, height: 20 },
    { kind: 'body', top: 40, height: 40 },
    { kind: 'close', top: 80, height: 20 }
  ]);
  // an empty body has no body bar
  const empty = ['a', OPEN('x'), CLOSE].join('\n');
  assert.deepStrictEqual(RB.accentBars(RB.findResultBlocks(empty), null, lh).map((b) => b.kind), ['open', 'close']);
  // one body line
  const one = [OPEN('x'), 'y', CLOSE].join('\n');
  assert.deepStrictEqual(RB.accentBars(RB.findResultBlocks(one), null, lh), [
    { kind: 'open', top: 0, height: 20 },
    { kind: 'body', top: 20, height: 20 },
    { kind: 'close', top: 40, height: 20 }
  ]);
  // an unclosed block: only its opener line
  const un = ['a', 'b', OPEN('u'), 'half'].join('\n');
  assert.deepStrictEqual(RB.accentBars(RB.findResultBlocks(un), null, lh), [{ kind: 'open', top: 40, height: 20 }]);
  // a fractional line height (14px * 1.6)
  const frac = RB.accentBars(blocks, null, 22.4);
  assert.deepStrictEqual(frac.map((b) => b.top), [22.4, 44.8, 89.6]);
  assert.deepStrictEqual(frac.map((b) => b.height), [22.4, 44.8, 22.4]);

  // wrapped lines: rows[i] screen rows for logical line i
  const rows = new Uint32Array([1, 1, 3, 1, 2, 1]); // a, opener, "one" (3 rows), "two", closer (2 rows), b
  assert.deepStrictEqual(RB.accentBars(blocks, rows, lh), [
    { kind: 'open', top: 20, height: 20 },
    { kind: 'body', top: 40, height: 80 }, // rows 2..5 (3 + 1)
    { kind: 'close', top: 120, height: 40 } // the closer wraps onto two rows
  ]);
  // wrapped rows above the block push it down
  const rowsAbove = new Uint32Array([4, 1, 1, 1, 1, 1]);
  assert.deepStrictEqual(RB.accentBars(blocks, rowsAbove, lh)[0], { kind: 'open', top: 80, height: 20 });
  // a wrapped opener line is a taller bar
  const rowsOpen = new Uint32Array([1, 2, 1, 1, 1, 1]);
  assert.deepStrictEqual(RB.accentBars(blocks, rowsOpen, lh)[0], { kind: 'open', top: 20, height: 40 });
  // a rows array that is shorter than the note counts the missing lines as one row
  assert.deepStrictEqual(RB.accentBars(blocks, [1, 1], lh), RB.accentBars(blocks, null, lh));
  // wrapped body of one line
  const rowsOne = new Uint32Array([1, 5, 1]);
  assert.deepStrictEqual(RB.accentBars(RB.findResultBlocks(one), rowsOne, lh), [
    { kind: 'open', top: 0, height: 20 },
    { kind: 'body', top: 20, height: 100 },
    { kind: 'close', top: 120, height: 20 }
  ]);
  // several blocks, wrapping between them
  const many = [OPEN('a'), 'x', CLOSE, 'gap', OPEN('b'), 'y', CLOSE].join('\n');
  const manyBars = RB.accentBars(RB.findResultBlocks(many), new Uint32Array([1, 1, 1, 3, 1, 1, 1]), lh);
  assert.deepStrictEqual(manyBars.map((b) => b.top), [0, 20, 40, 120, 140, 160]);
  // the same bars from a plain Array
  assert.deepStrictEqual(RB.accentBars(RB.findResultBlocks(many), [1, 1, 1, 3, 1, 1, 1], lh), manyBars);

  // nothing to draw
  assert.deepStrictEqual(RB.accentBars([], null, lh), []);
  assert.deepStrictEqual(RB.accentBars(null, null, lh), []);
  assert.deepStrictEqual(RB.accentBars(blocks, null, 0), [], 'no usable line height');
  assert.deepStrictEqual(RB.accentBars(blocks, null, NaN), []);

  // the number of blocks drawn is capped
  const lots = [];
  for (let i = 0; i < 30; i++) lots.push(OPEN('n' + i), 'x', CLOSE);
  const lotsBlocks = RB.findResultBlocks(lots.join('\n'));
  assert.strictEqual(lotsBlocks.length, 30);
  assert.strictEqual(RB.accentBars(lotsBlocks, null, lh, 4).length, 12);
  assert.strictEqual(RB.accentBars(lotsBlocks, null, lh).length, 90);

  // bars never overlap and stay in line order
  let prevEnd = -1;
  for (const bar of RB.accentBars(lotsBlocks, null, lh)) {
    assert.ok(bar.top >= prevEnd, 'no overlap');
    prevEnd = bar.top + bar.height;
  }
})();

(function testCheapWhenAbsent() {
  // The common case must stay one indexOf: a huge note without the marker comes back at once.
  const big = 'line of text that is not a marker\n'.repeat(90000); // about 3 MB
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) assert.deepStrictEqual(RB.findResultBlocks(big), []);
  const ms = (Date.now() - t0) / 20;
  assert.ok(ms < 50, 'a 3 MB note with no marker took ' + ms + ' ms per call');
  // and a big note with one block in it is found right
  const withBlock = big + OPEN('z9') + '\nresult\n' + CLOSE + '\n' + big;
  const found = RB.findResultBlocks(withBlock);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].openLine, 90000);
  assert.strictEqual(found[0].closeLine, 90002);
})();

(function testWindowExport() {
  assert.strictEqual(global.ResultBlocks, RB, 'exposed as window.ResultBlocks');
  for (const name of ['findResultBlocks', 'blockAt', 'nextBlock', 'bodyText', 'deleteRange', 'confirmEdit', 'accentBars']) {
    assert.strictEqual(typeof RB[name], 'function', name);
  }
})();

console.log('result_blocks_test.js: all tests passed');
