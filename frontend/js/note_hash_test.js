// Unit tests for note_hash.js: the page's copy of computeHash (app_rpc.go), used by the RPC writes to check
// expected_hash and write in one synchronous step. Node's own crypto is the oracle.
const assert = require('assert');
const crypto = require('crypto');

global.window = global;
const NH = require('./note_hash.js');

const oracle = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

(function knownVectors() {
  // The same two values are pinned in app_rpc_test.go (TestComputeHashKnownValues) against the Go function.
  assert.strictEqual(NH.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(NH.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(NH.hash16(''), 'e3b0c44298fc1c14');
  assert.strictEqual(NH.hash16('abc'), 'ba7816bf8f01cfea');
  // a text with Japanese, an astral character and both line endings (pinned in the Go test as well)
  assert.strictEqual(NH.hash16('# 見出し \u{1F916}\nline\r\nend'), 'de75cb63e13bbb54');
})();

(function matchesTheOracle() {
  const samples = [
    '', 'a', 'abc', 'hello world', '\n', '\r\n', ' '.repeat(63), ' '.repeat(64), ' '.repeat(65), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(119), 'x'.repeat(120),
    '日本語のメモ\n二行目\n', '# Title\n\n- [ ] task\n', 'éèê', '€', '\u{1F600}\u{1F916}', 'a\u{10FFFF}b', '\u0000', 'tab\tsep',
    'a'.repeat(1000), '日本語'.repeat(1000)
  ];
  for (const s of samples) {
    assert.strictEqual(NH.sha256Hex(s), oracle(s), 'sha256 of ' + JSON.stringify(s.slice(0, 20)) + ' (' + s.length + ' units)');
    assert.strictEqual(NH.hash16(s), oracle(s).slice(0, 16));
  }
  // every length across a block boundary, so the padding is right in all cases
  for (let n = 0; n < 200; n++) {
    const s = 'あ'.repeat(n % 7) + 'z'.repeat(n);
    assert.strictEqual(NH.hash16(s), oracle(s).slice(0, 16), 'length ' + n);
  }
})();

(function loneSurrogatesAreHashedAsReplacementCharacters() {
  // Node encodes a lone surrogate as U+FFFD, and so does Go when the text crosses the RPC as JSON.
  for (const s of ['\ud800', 'a\udc00b', '\ud83d', '\ud83dx', 'x\ude00', '\ud83d😀']) {
    assert.strictEqual(NH.sha256Hex(s), oracle(s), JSON.stringify(s));
  }
})();

(function bigText() {
  // A note of a few megabytes must hash in a fraction of a second (it happens inside an RPC write).
  const line = '# 見出しと本文 The quick brown fox jumps over the lazy dog 0123456789\n';
  const big = line.repeat(80000); // 80,000 lines, the size the app is tuned for
  const started = Date.now();
  const got = NH.hash16(big);
  const took = Date.now() - started;
  assert.strictEqual(got, oracle(big).slice(0, 16));
  assert.ok(took < 3000, 'hashing 80,000 lines took ' + took + ' ms');
  console.log('  (80,000 lines, ' + Buffer.byteLength(big) + ' bytes hashed in ' + took + ' ms)');
})();

(function utf8BytesMatchNode() {
  for (const s of ['', 'abc', '日本語', '\u{1F916}', 'a\ud800b']) {
    const mine = Buffer.from(NH.utf8Bytes(s));
    assert.ok(mine.equals(Buffer.from(s, 'utf8')), JSON.stringify(s));
  }
})();

console.log('note_hash tests passed');
