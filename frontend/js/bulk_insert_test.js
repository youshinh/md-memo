// Unit tests for bulk_insert.js: when a many-line insertion skips the browser's line-by-line 'insertText' command, what it sends
// instead, and the single input event. The real cost (Chromium's 'insertText' is (new lines) x (lines in the note)) is measured in
// the browser by tests/smoke/41_large_insert.mjs; here the pieces are checked with stubs, no DOM.
const assert = require('assert');

let commands = [];
let listeners = [];
let execImpl = () => true;
class FakeEvent {
  constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
}
global.window = global;
global.Event = FakeEvent;
global.document = {
  execCommand(name, showUi, value) {
    commands.push({ name, showUi, value });
    return execImpl(name, value);
  }
};
const BI = require('./bulk_insert.js');

const lines = (n) => Array.from({ length: n }, (_, i) => 'Line ' + (i + 1)).join('\n');

function fakeEditor() {
  const seen = [];
  const handlers = [];
  return {
    seen,
    handlers,
    addEventListener(type, fn, capture) { if (type === 'input') handlers.push({ fn, capture }); },
    removeEventListener(type, fn) { const i = handlers.findIndex((h) => h.fn === fn); if (i >= 0) handlers.splice(i, 1); },
    dispatchEvent(ev) { seen.push(ev); handlers.slice().forEach((h) => h.fn(ev)); return true; }
  };
}

(function wantedOnlyForLongTextsThatAreSlowToInsert() {
  assert.strictEqual(BI.wanted('', ''), false);
  assert.strictEqual(BI.wanted('one line', 'x'.repeat(1e6)), false);
  assert.strictEqual(BI.wanted(lines(BI.MIN_NEWLINES), ''), false, 'a short text into a short note is instant the plain way');
  // 141 new lines into an empty note is still under the ~20 ms budget of the plain command, 142 is over it
  assert.strictEqual(BI.wanted(lines(141), ''), false);
  assert.strictEqual(BI.wanted(lines(143), ''), true);
  assert.strictEqual(BI.wanted(lines(2000), ''), true);
  // the same few lines cost more in a big note: 20 lines into 20,000 lines (~0.4 s the plain way) is bulk, into 100 lines it is not
  assert.strictEqual(BI.wanted(lines(20), lines(20000)), true);
  assert.strictEqual(BI.wanted(lines(20), lines(100)), false);
  // never for a text with fewer new lines than MIN_NEWLINES, however large the note (an Enter, a Tab, a pasted sentence)
  assert.strictEqual(BI.wanted(lines(BI.MIN_NEWLINES - 1), lines(200000)), false);
  assert.strictEqual(BI.wanted('a\nb\n', lines(200000)), false);
  assert.strictEqual(BI.wanted(lines(BI.MIN_NEWLINES + 1), lines(200000)), true);
  // one very long line has no new lines to pay for
  assert.strictEqual(BI.wanted('x'.repeat(1e6), lines(20000)), false);
  // not a string, no note text: no crash
  assert.strictEqual(BI.wanted(null, ''), false);
  assert.strictEqual(BI.wanted(lines(2000), undefined), true);
})();

(function escapeKeepsTheTextExactly() {
  assert.strictEqual(BI.escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
  assert.strictEqual(BI.escapeHtml('&amp; <script>x</script>\n\ttab  two'), '&amp;amp; &lt;script&gt;x&lt;/script&gt;\n\ttab  two');
  assert.strictEqual(BI.escapeHtml('plain\n\nlines'), 'plain\n\nlines', 'line breaks stay as they are');
  assert.strictEqual(BI.escapeHtml('日本語 \u{1F600}'), '日本語 \u{1F600}');
})();

(function execSendsTheEscapedTextAsOneInsertHtmlCommand() {
  commands = [];
  execImpl = () => true;
  const ed = fakeEditor();
  assert.strictEqual(BI.exec(ed, 'a < b\n&\nc'), true);
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].name, 'insertHTML');
  assert.strictEqual(commands[0].showUi, false);
  assert.strictEqual(commands[0].value, 'a &lt; b\n&amp;\nc');
})();

(function execGuaranteesExactlyOneInputEvent() {
  // an engine that sends the event itself (Chromium): nothing more is sent
  const own = fakeEditor();
  execImpl = () => { own.dispatchEvent(new FakeEvent('input')); return true; };
  assert.strictEqual(BI.exec(own, lines(50)), true);
  assert.strictEqual(own.seen.length, 1, 'the engine\'s own event is the only one');
  assert.strictEqual(own.handlers.length, 0, 'the counting listener is removed again');

  // an engine that sends none: one is sent, after the command
  const silent = fakeEditor();
  execImpl = () => true;
  assert.strictEqual(BI.exec(silent, lines(50)), true);
  assert.strictEqual(silent.seen.length, 1);
  assert.strictEqual(silent.seen[0].type, 'input');
  assert.strictEqual(silent.seen[0].bubbles, true);
  assert.strictEqual(silent.handlers.length, 0);
})();

(function execWhenTheCommandIsRefusedOrThrows() {
  const refused = fakeEditor();
  execImpl = () => false;
  assert.strictEqual(BI.exec(refused, lines(50)), false);
  assert.strictEqual(refused.seen.length, 0, 'no event for an insertion that did not happen');
  assert.strictEqual(refused.handlers.length, 0);

  const boom = fakeEditor();
  execImpl = () => { throw new Error('no editing here'); };
  assert.throws(() => BI.exec(boom, lines(50)), /no editing here/);
  assert.strictEqual(boom.handlers.length, 0, 'the listener is removed even when the command throws');
  assert.strictEqual(boom.seen.length, 0);
})();

(function execWithoutAnEditor() {
  execImpl = () => true;
  assert.strictEqual(BI.exec(null, 'x\ny'), true, 'no editor to listen on: the command still runs');
})();

console.log('bulk_insert_test.js: all tests passed');
