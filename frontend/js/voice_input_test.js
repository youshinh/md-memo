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
// Newer Node versions define navigator as a getter-only global, so a plain assignment is ignored.
function setNavigator(value) {
  Object.defineProperty(global, 'navigator', { value, configurable: true, writable: true });
}
setNavigator({});

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
  assert.strictEqual(cfg.model, 'gemini-3.5-transcribe', 'the default voice model is Gemini 3.5 Transcribe');
  assert.strictEqual(cfg.apiStyle, 'auto');
  assert.deepStrictEqual(cfg.languageCodes, [], 'no language hint = auto-detect');
  assert.strictEqual(cfg.mode, 'smart');
  assert.deepStrictEqual(cfg.customVocabulary, []);
  assert.strictEqual(cfg.silence_timeout_sec, 5);
  assert.strictEqual(cfg.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.strictEqual(cfg.apiKey, '');
  assert.strictEqual(cfg.timeout, 30);
  assert.ok(cfg.prompt.length > 0);
})();

(function testAlreadySavedModelIsRespected() {
  // A config saved by an older build still names gemini-2.5-flash: it must keep working as it was.
  const cfg = VI.resolveVoiceConfig({ voice: { model: 'gemini-2.5-flash', prompt: 'p', silence_timeout_sec: 5 } });
  assert.strictEqual(cfg.model, 'gemini-2.5-flash');
  assert.strictEqual(cfg.apiStyle, 'auto', 'keys missing from an old saved config fall back to the defaults');
  assert.strictEqual(cfg.mode, 'smart');
  assert.deepStrictEqual(cfg.languageCodes, []);
})();

(function testTranscribeOptionsAreNormalised() {
  const cfg = VI.resolveVoiceConfig({
    voice: { apiStyle: 'interactions', languageCodes: [' ja-JP ', '', 'en-US'], mode: 'Verbatim', customVocabulary: ['Kubernetes', '  ', ' BigQuery '] }
  });
  assert.strictEqual(cfg.apiStyle, 'interactions');
  assert.deepStrictEqual(cfg.languageCodes, ['ja-JP', 'en-US']);
  assert.strictEqual(cfg.mode, 'verbatim');
  assert.deepStrictEqual(cfg.customVocabulary, ['Kubernetes', 'BigQuery']);

  const fromText = VI.resolveVoiceConfig({ voice: { languageCodes: 'ja-JP, en-US\nfr-FR', customVocabulary: 'a b\nc', mode: 'nonsense' } });
  assert.deepStrictEqual(fromText.languageCodes, ['ja-JP', 'en-US', 'fr-FR'], 'a hand-edited string is split on commas and newlines');
  assert.deepStrictEqual(fromText.customVocabulary, ['a b', 'c'], 'vocabulary terms may hold spaces, so only newlines split them');
  assert.strictEqual(fromText.mode, 'smart', 'an unknown mode falls back to smart');
  assert.deepStrictEqual(VI.resolveVoiceConfig({ voice: { languageCodes: 42, customVocabulary: null } }).languageCodes, []);
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
  assert.deepStrictEqual(Object.keys(parsed).sort(),
    ['apiKey', 'apiStyle', 'baseUrl', 'customVocabulary', 'languageCodes', 'mode', 'model', 'prompt', 'timeout'].sort());
  assert.strictEqual(parsed.model, 'gemini-3.5-transcribe');
  assert.strictEqual(parsed.apiStyle, 'auto');
  assert.strictEqual(parsed.mode, 'smart');
  assert.deepStrictEqual(parsed.languageCodes, []);
  assert.deepStrictEqual(parsed.customVocabulary, []);
  assert.ok(!('silence_timeout_sec' in parsed), 'the silence timeout is a frontend-only setting');
})();

// The single builder every caller uses (PC recording, retry, Mobile Drop).
(function testConfigJSONIsTheOneBuilder() {
  const raw = {
    vision: { baseUrl: 'https://vision.example', apiKey: 'vk-1' },
    voice: { model: 'gemini-2.5-flash', apiStyle: 'generateContent', languageCodes: ['ja-JP'], mode: 'verbatim', customVocabulary: ['x'], prompt: 'my prompt' }
  };
  assert.strictEqual(VI.configJSON(raw), VI.requestConfigJSON(VI.resolveVoiceConfig(raw)));
  const parsed = JSON.parse(VI.configJSON(raw));
  assert.strictEqual(parsed.apiKey, 'vk-1', 'the vision key is the fallback credential');
  assert.strictEqual(parsed.baseUrl, 'https://vision.example');
  assert.strictEqual(parsed.timeout, 30, 'PC recording keeps its 30 s timeout');
  assert.strictEqual(JSON.parse(VI.configJSON(raw, { timeout: 0 })).timeout, 0, 'Mobile Drop asks for the backend default (0)');
  assert.strictEqual(JSON.parse(VI.configJSON(raw, { timeout: -5 })).timeout, 30, 'a nonsense override is ignored');
  assert.strictEqual(typeof global.VoiceInput.configJSON, 'function', 'exposed for app.js (Mobile Drop)');
})();

(function testMicErrorKey() {
  const named = (name) => ({ name, message: 'x' });
  assert.strictEqual(VI.micErrorKey(named('NotAllowedError')), 'voiceMicBlocked');
  assert.strictEqual(VI.micErrorKey(named('SecurityError')), 'voiceMicBlocked');
  assert.strictEqual(VI.micErrorKey(named('NotFoundError')), 'voiceMicNotFound');
  assert.strictEqual(VI.micErrorKey(named('NotReadableError')), 'voiceMicBusy');
  assert.strictEqual(VI.micErrorKey(named('AbortError')), 'voiceMicBusy');
  assert.strictEqual(VI.micErrorKey(named('TypeError')), 'voiceMicDenied', 'anything else keeps the generic message');
  assert.strictEqual(VI.micErrorKey(undefined), 'voiceMicDenied');
  assert.strictEqual(VI.micErrorKey(null), 'voiceMicDenied');
})();

(function testIdFromReqId() {
  assert.strictEqual(VI.idFromReqId('voice_vx9a'), 'vx9a');
  assert.strictEqual(VI.idFromReqId('voice_retry_ab12'), 'ab12');
  assert.strictEqual(VI.idFromReqId('noUnderscore'), null);
  assert.strictEqual(VI.idFromReqId(undefined), null);
})();

// ---- start(): immediate feedback, specific errors, preview guard, state hook -------------------
(async function startFlowTests() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realWarn = console.warn;

  function makeBridge(overrides) {
    const log = { messages: [], inserted: [], replaced: [] };
    const editor = { value: '', selectionStart: 0, selectionEnd: 0 };
    const bridge = Object.assign({
      t: (key) => 'T:' + key,
      showMessage: (text, ms) => log.messages.push([text, ms]),
      isEditorVisible: () => true,
      getActiveEditor: () => editor,
      getTabIdForEditor: () => 'tab-1',
      insertTextWithUndo: (text) => log.inserted.push(text),
      replaceAnchor: (tabId, from, to) => { log.replaced.push([tabId, from, to]); return true; },
      getConfig: () => ({})
    }, overrides);
    global.MdMemoBridge = bridge;
    return { bridge, log };
  }

  function useFakeTimers() {
    const timers = [];
    global.setTimeout = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
    global.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
    return timers;
  }

  function restore() {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    console.warn = realWarn;
  }

  const micError = (name) => Object.assign(new Error(name + ' happened'), { name });
  const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

  // 1. Something is on screen the moment start() runs, before the microphone answers.
  {
    const { log } = makeBridge();
    const timers = useFakeTimers();
    let settle;
    let calls = 0;
    setNavigator({ mediaDevices: { getUserMedia: () => { calls++; return new Promise((_, reject) => { settle = reject; }); } } });
    global.MediaRecorder = function () {};
    const pendingStart = VI.start();
    await tick();
    assert.strictEqual(log.messages.length, 1, 'the press must be acknowledged immediately');
    assert.strictEqual(log.messages[0][0], 'T:voiceStarting');
    assert.ok(log.messages[0][1] >= 6000, 'the start-up message stays long enough to be noticed: ' + log.messages[0][1]);

    // 5 s without an answer -> tell the user a permission prompt may be waiting.
    const waiting = timers.find((t) => t.ms === 5000);
    assert.ok(waiting, 'a 5 s timer must be armed for the permission hint');
    waiting.fn();
    assert.strictEqual(log.messages.at(-1)[0], 'T:voiceWaitingPermission');
    assert.ok(log.messages.at(-1)[1] >= 6000);

    // A second press while the first is still waiting must not open a second request.
    await VI.start();
    assert.strictEqual(calls, 1, 'a press during a pending request is ignored');

    console.warn = () => {};
    settle(micError('NotAllowedError'));
    await pendingStart;
    assert.ok(waiting.cleared, 'the permission hint is cancelled once the request settles');
    restore();
    console.log('PASS: start() acknowledges the press at once and hints at a pending permission prompt.');
  }

  // 2. Each failure explains itself, stays on screen long enough to read, and is logged.
  {
    const cases = [
      ['NotAllowedError', 'voiceMicBlocked'], ['SecurityError', 'voiceMicBlocked'], ['NotFoundError', 'voiceMicNotFound'],
      ['NotReadableError', 'voiceMicBusy'], ['AbortError', 'voiceMicBusy'], ['TypeError', 'voiceMicDenied']
    ];
    for (const [name, key] of cases) {
      const { log } = makeBridge();
      useFakeTimers();
      const warned = [];
      console.warn = (...args) => warned.push(args);
      setNavigator({ mediaDevices: { getUserMedia: () => Promise.reject(micError(name)) } });
      global.MediaRecorder = function () {};
      await VI.start();
      restore();
      assert.strictEqual(log.messages[0][0], 'T:voiceStarting');
      const last = log.messages.at(-1);
      assert.strictEqual(last[0], 'T:' + key, `${name} must show ${key}`);
      assert.ok(last[1] >= 8000, `${key} must stay >= 8 s, got ${last[1]}`);
      assert.deepStrictEqual(warned[0].slice(0, 2), ['[voice] getUserMedia failed', name], 'the failure is logged with its name');
      assert.strictEqual(log.inserted.length, 0, 'nothing is inserted into the note when the microphone failed');
    }
    console.log('PASS: getUserMedia failures show a specific, long-lived message.');
  }

  // 3. A missing MediaRecorder / getUserMedia keeps the generic message (also long-lived).
  {
    const { log } = makeBridge();
    setNavigator({});
    await VI.start();
    assert.strictEqual(log.messages.at(-1)[0], 'T:voiceMicDenied');
    assert.ok(log.messages.at(-1)[1] >= 8000);
    console.log('PASS: no microphone API -> voiceMicDenied.');
  }

  // 4. The rendered preview hides the editor: say so, and never touch the microphone.
  {
    const { log } = makeBridge({ isEditorVisible: () => false });
    let asked = 0;
    setNavigator({ mediaDevices: { getUserMedia: () => { asked++; return Promise.resolve({}); } } });
    global.MediaRecorder = function () {};
    await VI.start();
    assert.strictEqual(asked, 0, 'no microphone request while the editor is hidden');
    assert.deepStrictEqual(log.messages.map((m) => m[0]), ['T:voiceNeedsEditor']);
    assert.ok(log.messages[0][1] >= 8000);
    assert.strictEqual(log.inserted.length, 0, 'nothing is inserted into the hidden editor');
    console.log('PASS: preview mode shows voiceNeedsEditor instead of recording into a hidden textarea.');
  }

  // 4b. The view switched to preview while the permission prompt was open.
  {
    let visible = true;
    const { log } = makeBridge({ isEditorVisible: () => visible });
    let stopped = 0;
    setNavigator({ mediaDevices: { getUserMedia: () => { visible = false; return Promise.resolve({ getTracks: () => [{ stop() { stopped++; } }] }); } } });
    global.MediaRecorder = function () {};
    await VI.start();
    assert.strictEqual(stopped, 1, 'the microphone is released again');
    assert.strictEqual(log.messages.at(-1)[0], 'T:voiceNeedsEditor');
    assert.strictEqual(log.inserted.length, 0);
    console.log('PASS: a view change during the permission prompt releases the microphone.');
  }

  // 5. Success: the anchor goes in, the state hook fires true/false, the "preparing" message is cleared.
  {
    const { log } = makeBridge();
    const states = [];
    VI.onStateChange((recording) => states.push(recording));
    class FakeRecorder {
      constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || ''; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
      static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    }
    global.MediaRecorder = FakeRecorder;
    setNavigator({ mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } });

    await VI.start();
    assert.deepStrictEqual(states, [true], 'the button turns active when recording starts');
    assert.strictEqual(log.inserted.length, 1);
    assert.ok(/⦅音声入力中\.\.\. \[id:[a-z0-9]{4}\]⦆/.test(log.inserted[0]));
    assert.deepStrictEqual(log.messages.at(-1), ['', 1], 'the recording indicator takes over from the "preparing" message');
    assert.strictEqual(global.VoiceInput.isRecording(), true);

    global.VoiceInput.abort();
    assert.deepStrictEqual(states, [true, false], 'an abort clears the active state');
    assert.strictEqual(global.VoiceInput.isRecording(), false);

    // stop() path: recording ends through the recorder's own stop event.
    global.backend = {};
    await VI.start();
    assert.deepStrictEqual(states, [true, false, true]);
    global.VoiceInput.toggle();
    assert.deepStrictEqual(states, [true, false, true, false], 'a normal stop clears the active state too');

    // A throwing listener must never break recording.
    VI.onStateChange(() => { throw new Error('ui bug'); });
    await VI.start();
    assert.strictEqual(global.VoiceInput.isRecording(), true, 'recording still started');
    global.VoiceInput.abort();
    VI.onStateChange(null);
    console.log('PASS: the state hook reports start, stop and abort (and cannot break recording).');
  }

  // 6. The recording indicator carries a stop button that ends the recording the way the shortcut does.
  {
    const realCreate = global.document.createElement;
    const realBody = global.document.body;
    const parts = {};
    let pill = null;
    const part = (sel) => {
      if (!parts[sel]) {
        parts[sel] = {
          textContent: '', title: '', listeners: {},
          addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
          querySelector: (inner) => part(sel + ' ' + inner)
        };
      }
      return parts[sel];
    };
    global.document.createElement = (tag) => {
      const el = { tag, className: '', innerHTML: '', style: {}, parentNode: null, querySelector: (sel) => part(sel) };
      if (tag === 'div') pill = el;
      return el;
    };
    global.document.body = { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } };

    const { log } = makeBridge();
    class FakeRecorder {
      constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || ''; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
      static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    }
    global.MediaRecorder = FakeRecorder;
    global.backend = {};
    setNavigator({ mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } });

    await VI.start();
    assert.strictEqual(global.VoiceInput.isRecording(), true);
    assert.ok(pill && pill.innerHTML.includes('class="voice-stop"'), 'the indicator holds a stop button');
    assert.ok(/<svg[\s\S]*<rect[\s\S]*<\/svg>/.test(pill.innerHTML) && !/[■▪◼⏹]/.test(pill.innerHTML), 'its icon is a line SVG, not a text glyph');
    assert.ok(pill.innerHTML.indexOf('voice-elapsed') < pill.innerHTML.indexOf('voice-stop') && pill.innerHTML.indexOf('voice-stop') < pill.innerHTML.indexOf('voice-esc'),
      'the button sits between the elapsed time and the ESC hint');
    const stopButton = part('.voice-stop');
    assert.strictEqual(stopButton.title, 'T:voiceStopTitle', 'a tooltip says what it does');
    assert.strictEqual(part('.voice-stop .voice-stop-label').textContent, 'T:voiceStopLabel');

    let prevented = 0;
    stopButton.listeners.mousedown.forEach((fn) => fn({ preventDefault() { prevented++; } }));
    assert.strictEqual(prevented, 1, 'pressing the button does not take the focus away from the note');
    assert.strictEqual(global.VoiceInput.isRecording(), true, 'pressing down alone does not stop');
    stopButton.listeners.click.forEach((fn) => fn({}));
    assert.strictEqual(global.VoiceInput.isRecording(), false, 'a click ends the recording');
    assert.strictEqual(pill.parentNode, null, 'and the indicator goes away');
    assert.ok(log.replaced.length >= 1, 'the recording anchor is handed on to the transcription');
    stopButton.listeners.click.forEach((fn) => fn({}));
    assert.strictEqual(global.VoiceInput.isRecording(), false, 'a second click on the vanished button changes nothing');

    global.document.createElement = realCreate;
    global.document.body = realBody;
    console.log('PASS: the recording indicator has a stop button (line icon, keeps the focus, ends the recording).');
  }

  // 7. A transcription that never answers must not leave "文字起こし中" in the note for ever.
  {
    class FakeFileReader {
      readAsDataURL() { Promise.resolve().then(() => { this.result = 'data:audio/webm;base64,QUJD'; if (this.onload) this.onload(); }); }
    }
    class FakeRecorder {
      constructor(stream, opts) { this.state = 'inactive'; this.mimeType = (opts && opts.mimeType) || ''; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
      static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    }
    const realReader = global.FileReader;
    global.FileReader = FakeFileReader;
    global.MediaRecorder = FakeRecorder;
    setNavigator({ mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } });

    // records once and returns the request id the backend was given
    async function recordOnce() {
      await VI.start();
      global.VoiceInput.toggle();
      await tick();
      await tick();
      return calls.at(-1)[0].replace(/^voice_/, '');
    }
    let calls = [];
    let rejectNext = false;
    global.backend = {
      transcribeAudioAsync: (...args) => { calls.push(args); return rejectNext ? Promise.reject(new Error('rpc refused')) : Promise.resolve(); },
      retryVoiceCacheAsync: (...args) => { calls.push(['RETRY'].concat(args)); return Promise.resolve(); }
    };

    // 7a. The request is armed with a watchdog (its own 30 s timeout + a grace period); firing it leaves the retry marker
    {
      const { bridge, log } = makeBridge();
      const timers = useFakeTimers();
      const id = await recordOnce();
      assert.strictEqual(calls.length, 1, 'the recording was sent once');
      assert.strictEqual(calls[0][1], 'QUJD', 'the audio goes along');
      assert.strictEqual(calls[0][2], 'audio/webm;codecs=opus');
      const dog = timers.find((t) => t.ms === 50000);
      assert.ok(dog, 'a watchdog is armed: 30 s request timeout + 20 s grace');
      assert.deepStrictEqual(log.replaced.at(-1).slice(1), [VI.buildRecordingAnchor(id), VI.buildTranscribingAnchor(id)], 'the recording marker became the transcribing marker');
      dog.fn();
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor(id), VI.buildRescueAnchor(id)], 'after the watchdog the note holds the retry marker');
      assert.strictEqual(log.messages.at(-1)[0], 'T:voiceTranscribeTimeout');
      const replacedBefore = log.replaced.length;
      dog.fn();
      assert.strictEqual(log.replaced.length, replacedBefore, 'a second firing is harmless');

      // the answer that comes late still lands in the note, in place of the retry marker
      global.__onVoiceResult('voice_' + id, 'こんにちは', '', '');
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildRescueAnchor(id), 'こんにちは'], 'a late result replaces the retry marker');
      restore();
    }

    // 7b. [再試行] after a watchdog sends the recording again from memory (no backend cache exists for it)
    {
      const { bridge, log } = makeBridge();
      const timers = useFakeTimers();
      calls = [];
      const id = await recordOnce();
      timers.find((t) => t.ms === 50000).fn();
      const editor = bridge.getActiveEditor();
      editor.value = 'x\n' + VI.buildRescueAnchor(id) + '\ny';
      editor.selectionStart = editor.value.indexOf('[再試行') + 3;
      assert.strictEqual(global.VoiceInput.handleEditorClick(editor, {}), true, 'the click on [再試行] is handled');
      assert.strictEqual(calls.length, 2, 'the recording is sent again');
      assert.strictEqual(calls[1][0], 'voice_' + id);
      assert.strictEqual(calls[1][1], calls[0][1], 'with the same audio');
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildRescueAnchor(id), VI.buildTranscribingAnchor(id)]);
      assert.ok(timers.filter((t) => t.ms === 50000).length >= 2, 'and it is watched again');
      global.__onVoiceResult('voice_' + id, 'ok', '', '');
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor(id), 'ok'], 'the answer replaces the transcribing marker');
      assert.ok(timers.filter((t) => t.ms === 50000).every((t) => t.cleared), 'every watchdog is cancelled once the answer is in');
      restore();
    }

    // 7c. A refused call (the bound function rejecting) does not strand the marker either
    {
      const { log } = makeBridge();
      useFakeTimers();
      calls = [];
      rejectNext = true;
      const id = await recordOnce();
      await tick();
      rejectNext = false;
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor(id), VI.buildRescueAnchor(id)], 'the marker becomes the retry marker');
      assert.strictEqual(log.messages.at(-1)[0], 'T:voiceTranscribeUnavailable');
      restore();
    }

    // 7d. An answer with an error but no cache path keeps the recording in memory for [再試行]
    {
      const { bridge, log } = makeBridge();
      const timers = useFakeTimers();
      calls = [];
      const id = await recordOnce();
      global.__onVoiceResult('voice_' + id, '', 'no speech', '');
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor(id), VI.buildRescueAnchor(id)]);
      assert.ok(timers.find((t) => t.ms === 50000).cleared, 'the watchdog is off once an answer (even a failure) is in');
      const editor = bridge.getActiveEditor();
      editor.value = VI.buildRescueAnchor(id);
      editor.selectionStart = editor.value.indexOf('[再試行') + 3;
      global.VoiceInput.handleEditorClick(editor, {});
      assert.strictEqual(calls.length, 2, 'the retry works from memory');
      restore();
    }

    // 7e. A marker no request waits for (the app was closed while it was pending) is cleaned up by a click in the note
    {
      const { bridge, log } = makeBridge();
      const editor = bridge.getActiveEditor();
      editor.value = 'top\n' + VI.buildTranscribingAnchor('zu6l') + '\nbottom';
      editor.selectionStart = 0;
      assert.strictEqual(global.VoiceInput.handleEditorClick(editor, {}), false, 'the click itself is not consumed');
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor('zu6l'), ''], 'a dead marker with nothing behind it is removed');
      assert.strictEqual(log.messages.at(-1)[0], 'T:voiceStaleRemoved');

      // ... turned into the retry marker when the backend still holds the recording
      global.__onVoiceResult('voice_qq11', '', 'boom', 'C:/cache/2026_qq11.webm');
      log.replaced.length = 0;
      editor.value = VI.buildTranscribingAnchor('qq11');
      global.VoiceInput.handleEditorClick(editor, {});
      assert.deepStrictEqual(log.replaced.at(-1), ['tab-1', VI.buildTranscribingAnchor('qq11'), VI.buildRescueAnchor('qq11')]);
      assert.strictEqual(log.messages.at(-1)[0], 'T:voiceStaleRestored');

      // a request that is still running is left alone
      log.replaced.length = 0;
      const timers = useFakeTimers();
      calls = [];
      const live = await recordOnce();
      const before = log.replaced.length;
      editor.value = 'a ' + VI.buildTranscribingAnchor(live) + ' b';
      global.VoiceInput.handleEditorClick(editor, {});
      assert.strictEqual(log.replaced.length, before, 'a marker that is waiting for its answer stays');
      global.__onVoiceResult('voice_' + live, 'done', '', '');
      restore();

      // and text without any marker costs nothing
      const other = makeBridge();
      const plain = other.bridge.getActiveEditor();
      plain.value = 'just a note';
      assert.strictEqual(global.VoiceInput.handleEditorClick(plain, {}), false);
      assert.strictEqual(other.log.replaced.length, 0);
    }

    global.FileReader = realReader;
    console.log('PASS: a transcription that never answers ends in a retry marker (watchdog, refused call, late answer, dead marker).');
  }

  restore();
})().then(() => {
  console.log('voice_input_test.js: all assertions passed');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
