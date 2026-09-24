// Unit tests for speech_settings.js: pure helpers and the config <-> form round trip.
const assert = require('assert');

global.window = global;
const S = require('./speech_settings.js');

function fakeEl(initial) {
  const classes = new Set();
  return Object.assign({
    value: '', checked: false, textContent: '', options: [],
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    addEventListener() {}
  }, initial || {});
}

function fakeDoc(ids) {
  const els = {};
  ids.forEach((id) => { els[id] = fakeEl(); });
  return { els, getElementById: (id) => els[id] || null };
}

const FORM_IDS = [
  'speech-engine-block', 'speech-whisper-panel', 'cfg-speech-engine', 'cfg-speech-model', 'cfg-speech-model-path',
  'cfg-speech-model-url', 'cfg-speech-model-sha', 'cfg-speech-language', 'cfg-speech-threads', 'cfg-speech-prompt',
  'cfg-speech-cloud-fallback'
];

// formatSize / percent
assert.strictEqual(S.formatSize(0), '0 B');
assert.strictEqual(S.formatSize(2048), '2 KB');
assert.strictEqual(S.formatSize(8573270), '8 MB');
assert.strictEqual(S.formatSize(537819875), '513 MB');
assert.strictEqual(S.formatSize(1519521155), '1.4 GB');
assert.strictEqual(S.percent(50, 200), 25);
assert.strictEqual(S.percent(300, 200), 100);
assert.strictEqual(S.percent(5, 0), 0);
assert.strictEqual(S.percent(-5, 100), 0);

// normalizers
assert.strictEqual(S.normalizeEngine('whisper-local'), 'whisper-local');
assert.strictEqual(S.normalizeEngine('anything else'), 'gemini');
assert.strictEqual(S.normalizeEngine(undefined), 'gemini');
assert.deepStrictEqual(S.normalizeWhisper(undefined), {
  model: '', modelPath: '', customUrl: '', customSha256: '', language: '', threads: 0, prompt: '', cloudFallback: false
});
assert.strictEqual(S.normalizeWhisper({ threads: '6' }).threads, 6);
assert.strictEqual(S.normalizeWhisper({ threads: -3 }).threads, 0);
assert.strictEqual(S.normalizeWhisper({ threads: 'abc' }).threads, 0);
assert.strictEqual(S.normalizeWhisper({ cloudFallback: 1 }).cloudFallback, true);
assert.strictEqual(S.normalizeWhisper({ model: 5 }).model, '');

// load -> save round trip through the form, with no backend (the panel is hidden)
{
  const doc = fakeDoc(FORM_IDS);
  S.init({ t: (k) => k, backend: null, doc });
  const config = {
    voice: {
      model: 'gemini-3.5-transcribe',
      engine: 'whisper-local',
      whisper: {
        model: 'kotoba-v2.0-q5_0', modelPath: 'C:\\m\\x.bin', customUrl: 'https://h/x.bin', customSha256: 'ab12',
        language: 'ja', threads: 6, prompt: '田中, MD-Memo', cloudFallback: true
      }
    }
  };
  S.load(config);
  assert.strictEqual(doc.els['cfg-speech-engine'].value, 'whisper-local');
  assert.strictEqual(doc.els['cfg-speech-threads'].value, '6');
  assert.strictEqual(doc.els['cfg-speech-cloud-fallback'].checked, true);
  assert.ok(doc.els['speech-engine-block'].classList.contains('hidden'), 'no backend: the whole block is hidden');

  const out = { voice: { model: 'gemini-3.5-transcribe', apiKey: 'keep-me' } };
  S.save(out);
  assert.strictEqual(out.voice.apiKey, 'keep-me', 'other voice settings are untouched');
  assert.strictEqual(out.voice.model, 'gemini-3.5-transcribe');
  assert.strictEqual(out.voice.engine, 'whisper-local');
  // The <select> was never filled (no backend), so the saved model must survive rather than become ''.
  assert.deepStrictEqual(out.voice.whisper, config.voice.whisper);
}

// defaults for a config that has never seen the feature
{
  const doc = fakeDoc(FORM_IDS);
  S.init({ t: (k) => k, backend: null, doc });
  S.load({});
  const out = {};
  S.save(out);
  assert.strictEqual(out.voice.engine, 'gemini');
  assert.strictEqual(out.voice.whisper.threads, 0);
  assert.strictEqual(out.voice.whisper.cloudFallback, false);
}

// the backend callback is a no-op for an unknown request id
S.onInstallEvent('nope', 'progress', 1, 2, '');

console.log('speech_settings_test.js: all assertions passed');
