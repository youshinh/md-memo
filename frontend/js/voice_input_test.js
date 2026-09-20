// Unit tests for voice_input.js pure helpers (anchor parsing, silence state machine, mime/config).
const assert = require('assert');

global.window = global;
global.document = {
  documentElement: { lang: 'ja' },
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector: () => null }),
  head: { appendChild() {} },
  body: { appendChild() {} }
};
global.localStorage = (function () {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _reset: () => { store = {}; }
  };
})();
global.backend = {};
global.navigator = {};

const VI = require('./voice_input.js');

// ---- findRescueAction --------------------------------------------------------------------------

function rescueAnchor(id) {
  return `⦅文字起こし失敗: [再試行(id:${id})] [音声保存] [破棄]⦆`;
}

(function testRetryClick() {
  const anchor = rescueAnchor('vx9a');
  const text = `line before\n${anchor}\nline after`;
  const retryStart = text.indexOf('[再試行');
  const caret = retryStart + 3; // inside "再試行"
  const found = VI.findRescueAction(text, caret);
  assert.ok(found, 'expected a match inside [再試行(...)]');
  assert.strictEqual(found.action, 'retry');
  assert.strictEqual(found.id, 'vx9a');
  assert.strictEqual(text.slice(found.anchorStart, found.anchorEnd), anchor);
})();

(function testKeepAndDiscardClicks() {
  const anchor = rescueAnchor('ab12');
  const text = anchor;
  const keepStart = text.indexOf('[音声保存]');
  const keepFound = VI.findRescueAction(text, keepStart + 2);
  assert.strictEqual(keepFound.action, 'keep');
  assert.strictEqual(keepFound.id, 'ab12', 'id is recovered from the same anchor even though [音声保存] has no id itself');

  const discardStart = text.indexOf('[破棄]');
  const discardFound = VI.findRescueAction(text, discardStart + 1);
  assert.strictEqual(discardFound.action, 'discard');
  assert.strictEqual(discardFound.id, 'ab12');
})();

(function testBracketEdges() {
  const anchor = rescueAnchor('zz99');
  const start = anchor.indexOf('[破棄]');
  const end = start + '[破棄]'.length;
  assert.ok(VI.findRescueAction(anchor, start), 'caret at opening bracket counts as inside');
  assert.ok(VI.findRescueAction(anchor, end), 'caret at closing bracket counts as inside');
  // Well inside the "文字起こし失敗:" prefix, long before any bracket opens - unambiguously outside.
  assert.strictEqual(VI.findRescueAction(anchor, 1), null, 'caret in the anchor prefix text is outside every bracket');
})();

(function testTwoAnchorsOnOneLine() {
  const a1 = rescueAnchor('aaaa');
  const a2 = rescueAnchor('bbbb');
  const text = `${a1} ${a2}`;
  const secondRetryStart = text.lastIndexOf('[再試行');
  const found = VI.findRescueAction(text, secondRetryStart + 2);
  assert.strictEqual(found.id, 'bbbb', 'the closer anchor on the line must win');

  const between = text.indexOf('⦆') + 1; // right after first anchor closes, before second opens
  assert.strictEqual(VI.findRescueAction(text, between), null, 'caret in the gap between two anchors is outside both');
})();

(function testAnchorWithoutRescueActions() {
  const recording = `⦅音声入力中... [id:vx9a]⦆`;
  assert.strictEqual(VI.findRescueAction(recording, 5), null, 'the in-progress anchor has no rescue actions to click');
})();

(function testCaretOutsideAnyAnchor() {
  const text = 'plain text with no anchors at all';
  assert.strictEqual(VI.findRescueAction(text, 10), null);
  assert.strictEqual(VI.findRescueAction('', 0), null);
})();

(function testAnchorBuilders() {
  assert.strictEqual(VI.buildRecordingAnchor('vx9a'), '⦅音声入力中... [id:vx9a]⦆');
  assert.strictEqual(VI.buildTranscribingAnchor('vx9a'), '⦅文字起こし中... [id:vx9a]⦆');
  assert.strictEqual(VI.buildRescueAnchor('vx9a'), rescueAnchor('vx9a'));
  // no emoji anywhere in generated strings
  [VI.buildRecordingAnchor('abcd'), VI.buildTranscribingAnchor('abcd'), VI.buildRescueAnchor('abcd')].forEach((s) => {
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(s), 'anchor text must not contain emoji: ' + s);
  });
})();

// ---- silence state machine ----------------------------------------------------------------------

(function testSilenceUpdateStopsAfterTimeout() {
  const st = VI.createSilenceState(5);
  let t = 0;
  assert.strictEqual(VI.silenceUpdate(st, 0.001, t), false);
  t += 4000;
  assert.strictEqual(VI.silenceUpdate(st, 0.001, t), false, 'not yet at 5s of continuous silence');
  t += 1001;
  assert.strictEqual(VI.silenceUpdate(st, 0.001, t), true, '5s of continuous silence should trigger stop');
})();

(function testSilenceResetsOnSpeech() {
  const st = VI.createSilenceState(5);
  let t = 0;
  VI.silenceUpdate(st, 0.001, t);
  t += 4500;
  VI.silenceUpdate(st, 0.001, t); // still silent, close to timeout
  t += 100;
  assert.strictEqual(VI.silenceUpdate(st, 0.5, t), false, 'a loud sample must reset the silence clock');
  // First silent sample after the reset restarts the clock at this instant, not at reset time.
  t += 100;
  VI.silenceUpdate(st, 0.001, t);
  t += 4900;
  assert.strictEqual(VI.silenceUpdate(st, 0.001, t), false, 'less than 5s since the post-reset silence began');
  t += 200;
  assert.strictEqual(VI.silenceUpdate(st, 0.001, t), true);
})();

(function testSilenceThresholdBoundary() {
  const st = VI.createSilenceState(5);
  assert.strictEqual(VI.silenceUpdate(st, VI.RMS_THRESHOLD, 0), false, 'exactly-at-threshold counts as speech, not silence');
})();

(function testSilenceDefaultTimeout() {
  const st = VI.createSilenceState(undefined);
  assert.strictEqual(st.timeoutMs, 5000, 'default silence timeout is 5s per spec');
})();

// ---- chooseMimeType -------------------------------------------------------------------------

(function testChooseMimeTypePrefersOpus() {
  const supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
  const pick = VI.chooseMimeType((t) => supported.has(t));
  assert.strictEqual(pick, 'audio/webm;codecs=opus');
})();

(function testChooseMimeTypeFallsBackToMp4() {
  const supported = new Set(['audio/mp4']);
  const pick = VI.chooseMimeType((t) => supported.has(t));
  assert.strictEqual(pick, 'audio/mp4');
})();

(function testChooseMimeTypeNoneSupported() {
  assert.strictEqual(VI.chooseMimeType(() => false), '');
  assert.strictEqual(VI.chooseMimeType(undefined), '');
})();

// ---- resolveVoiceConfig ------------------------------------------------------------------------

(function testConfigDefaults() {
  const cfg = VI.resolveVoiceConfig({});
  assert.strictEqual(cfg.model, 'gemini-2.5-flash');
  assert.strictEqual(cfg.silence_timeout_sec, 5);
  assert.strictEqual(cfg.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.strictEqual(cfg.apiKey, '');
  assert.ok(cfg.prompt.length > 0);
})();

(function testConfigFallsBackToVisionCredentials() {
  const cfg = VI.resolveVoiceConfig({ vision: { baseUrl: 'https://vision.example', apiKey: 'vk-1' } });
  assert.strictEqual(cfg.baseUrl, 'https://vision.example');
  assert.strictEqual(cfg.apiKey, 'vk-1');
})();

(function testConfigPrefersOwnVoiceSection() {
  const cfg = VI.resolveVoiceConfig({
    voice: { baseUrl: 'https://voice.example', apiKey: 'vk-2', model: 'gemini-2.5-pro', silence_timeout_sec: 8 },
    vision: { baseUrl: 'https://vision.example', apiKey: 'vk-1' }
  });
  assert.strictEqual(cfg.baseUrl, 'https://voice.example');
  assert.strictEqual(cfg.apiKey, 'vk-2');
  assert.strictEqual(cfg.model, 'gemini-2.5-pro');
  assert.strictEqual(cfg.silence_timeout_sec, 8);
})();

(function testRequestConfigJSONShape() {
  const cfg = VI.resolveVoiceConfig({});
  const parsed = JSON.parse(VI.requestConfigJSON(cfg));
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['apiKey', 'baseUrl', 'model', 'prompt', 'timeout'].sort());
})();

(function testIdFromReqId() {
  assert.strictEqual(VI.idFromReqId('voice_vx9a'), 'vx9a');
  assert.strictEqual(VI.idFromReqId('voice_retry_ab12'), 'ab12');
  assert.strictEqual(VI.idFromReqId('noUnderscore'), null);
  assert.strictEqual(VI.idFromReqId(undefined), null);
})();

console.log('voice_input_test.js: all assertions passed');
