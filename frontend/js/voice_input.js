// MD-Memo voice input: anchor-protected async voice recording with rescue recovery.
// Spec: 機能 3 (堅牢な非同期バッチ音声入力). Uses window.MdMemoBridge / window.backend only;
// never touches app.js internals directly.
(function (global) {
  'use strict';

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const RMS_THRESHOLD = 0.015;
  const SAMPLE_INTERVAL_MS = 200;
  const DEFAULT_SILENCE_SEC = 5;
  const DEFAULT_MODEL = 'gemini-3.5-transcribe';
  const DEFAULT_PROMPT = 'この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。';
  const CACHE_KEY = 'md_memo_voice_cache_v1';
  // A request that has not answered this long after its own timeout is given up on, so the note never keeps
  // "文字起こし中" for good (a lost callback, or an app restart, would otherwise leave it there for ever).
  const TRANSCRIBE_GRACE_MS = 20000;
  const DEFAULT_REQUEST_TIMEOUT_SEC = 120;
  const MAX_KEPT_AUDIO = 5;
  // Second stage (tidying the transcript, or applying it to a selection as an edit instruction).
  const DEFAULT_REFINE_MODEL = 'gemini-flash-lite-latest';
  const DEFAULT_REFINE_TIMEOUT_SEC = 5;
  const MAX_REFINE_TIMEOUT_SEC = 30;
  // Speak-to-edit sends the whole selection to the model; a bigger one is refused, not cut.
  const MAX_EDIT_SELECTION = 8000;
  const MAX_CONTEXT_LINE = 400;

  const I18N_FALLBACK = {
    ja: {
      voiceMicDenied: 'マイクを使用できませんでした',
      voiceStarting: 'マイクを準備中...',
      voiceWaitingPermission: 'マイクの許可待ちです。許可の確認が表示されていたら「許可」を選んでください',
      voiceMicBlocked: 'マイクの使用が許可されていません。Windows の設定 → プライバシーとセキュリティ → マイク で「デスクトップ アプリがマイクにアクセスできるようにする」を確認してください',
      voiceMicNotFound: 'マイクが見つかりません',
      voiceMicBusy: 'マイクを開けません。他のアプリが使用中かもしれません',
      voiceNeedsEditor: '音声入力はエディタ表示で使えます',
      voiceTranscribeFailed: '文字起こしに失敗しました: {error}',
      voiceTranscribeUnavailable: '文字起こし機能を利用できません',
      voiceTranscribeTimeout: '文字起こしの応答がありません。ノートの [再試行] で送り直せます',
      voiceStaleRestored: '結果が届かなかった文字起こしを、再試行できる状態に戻しました',
      voiceStaleRemoved: '結果が届かなかった文字起こしの表示を削除しました(音声は残っていません)',
      voiceKeepFailed: '音声の保存に失敗しました',
      voiceDiscardFailed: '音声の破棄に失敗しました',
      voiceCacheMissing: '音声キャッシュが見つかりません',
      voiceEscHint: 'ESC で破棄',
      voiceStopLabel: '停止',
      voiceStopTitle: '録音を止めて、文字起こしを始めます',
      voiceRefineFailed: '推敲できなかったため、文字起こしをそのまま入れました: {error}',
      voiceEditFailed: '選択範囲を書き換えられなかったため、元のテキストに戻しました: {error}',
      voiceEditTooLong: '音声で書き換えられる選択範囲は {max} 文字までです。範囲を狭めてください'
    },
    en: {
      voiceMicDenied: 'Could not use the microphone',
      voiceStarting: 'Preparing the microphone...',
      voiceWaitingPermission: 'Waiting for microphone permission. If a permission prompt is showing, choose Allow.',
      voiceMicBlocked: 'Microphone access is blocked. Check Windows Settings -> Privacy & security -> Microphone -> let desktop apps access your microphone.',
      voiceMicNotFound: 'No microphone was found',
      voiceMicBusy: 'The microphone cannot be opened. Another app may be using it.',
      voiceNeedsEditor: 'Voice input works in the editor view',
      voiceTranscribeFailed: 'Transcription failed: {error}',
      voiceTranscribeUnavailable: 'Voice transcription is unavailable',
      voiceTranscribeTimeout: 'No answer to the transcription. Use [再試行] in the note to send it again.',
      voiceStaleRestored: 'A transcription whose result never arrived was put back into a state you can retry',
      voiceStaleRemoved: 'Removed a transcription marker whose result never arrived (the audio is gone)',
      voiceKeepFailed: 'Failed to save the audio',
      voiceDiscardFailed: 'Failed to discard the audio',
      voiceCacheMissing: 'Voice cache not found',
      voiceEscHint: 'ESC to discard',
      voiceStopLabel: 'Stop',
      voiceStopTitle: 'Stop recording and start the transcription',
      voiceRefineFailed: 'Could not tidy the text, so the transcript was inserted as spoken: {error}',
      voiceEditFailed: 'Could not rewrite the selection, so the original text was put back: {error}',
      voiceEditTooLong: 'Speak-to-edit works on selections of up to {max} characters. Select less text.'
    }
  };

  // How long the start-up feedback stays in the status bar: long enough to be noticed, and the
  // explanations of a failure long enough to be read.
  const STARTING_TOAST_MS = 6000;
  const WAITING_TOAST_MS = 10000;
  const ERROR_TOAST_MS = 9000;
  const PERMISSION_WAIT_MS = 5000;

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  function genId() {
    let out = '';
    for (let i = 0; i < 4; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    return out;
  }

  function buildRecordingAnchor(id) { return `⦅音声入力中... [id:${id}]⦆`; }
  function buildTranscribingAnchor(id) { return `⦅文字起こし中... [id:${id}]⦆`; }
  function buildRescueAnchor(id) {
    return `⦅文字起こし失敗: [再試行(id:${id})] [音声保存] [破棄]⦆`;
  }

  // Finds which rescue action (if any) the caret sits on, within the anchor on its own line.
  // text/caret only - no DOM - so it is cheap to call on every editor click and easy to test.
  function findRescueAction(text, caret) {
    if (typeof text !== 'string' || typeof caret !== 'number') return null;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = text.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.indexOf('⦅') === -1 || line.indexOf('⦆') === -1) return null;

    const relCaret = caret - lineStart;
    const openRel = line.lastIndexOf('⦅', relCaret);
    if (openRel === -1) return null;
    const closeRel = line.indexOf('⦆', openRel);
    if (closeRel === -1) return null;
    if (relCaret < openRel || relCaret > closeRel + 1) return null;

    const anchorStart = lineStart + openRel;
    const anchorEnd = lineStart + closeRel + 1;
    const anchorText = text.slice(anchorStart, anchorEnd);
    const idMatch = /\[再試行\(id:([a-z0-9]{4})\)\]/.exec(anchorText);
    const id = idMatch ? idMatch[1] : null;

    const patterns = [
      { action: 'retry', re: /\[再試行\(id:[a-z0-9]{4}\)\]/ },
      { action: 'keep', re: /\[音声保存\]/ },
      { action: 'discard', re: /\[破棄\]/ }
    ];
    for (const p of patterns) {
      const m = p.re.exec(anchorText);
      if (!m) continue;
      const bStart = anchorStart + m.index;
      const bEnd = bStart + m[0].length;
      if (caret >= bStart && caret <= bEnd) {
        return { action: p.action, id: id, anchorStart: anchorStart, anchorEnd: anchorEnd };
      }
    }
    return null;
  }

  // Silence detector: pure state machine, sampled on a plain timer (not rAF) so it stays cheap.
  function createSilenceState(timeoutSec) {
    const sec = (typeof timeoutSec === 'number' && timeoutSec > 0) ? timeoutSec : DEFAULT_SILENCE_SEC;
    return { silenceStartMs: null, timeoutMs: sec * 1000 };
  }

  // Returns true once `timeoutMs` has elapsed with every sample below threshold.
  function silenceUpdate(state, rms, nowMs) {
    if (rms >= RMS_THRESHOLD) {
      state.silenceStartMs = null;
      return false;
    }
    if (state.silenceStartMs === null) state.silenceStartMs = nowMs;
    return (nowMs - state.silenceStartMs) >= state.timeoutMs;
  }

  // Picks the best MediaRecorder mime type via an injected isTypeSupported so this stays testable.
  function chooseMimeType(isSupportedFn) {
    if (typeof isSupportedFn !== 'function') return '';
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2'];
    for (const c of candidates) {
      try { if (isSupportedFn(c)) return c; } catch (e) { /* keep trying */ }
    }
    return '';
  }

  // A list setting as an array of trimmed, non-empty strings. A hand-edited string is split on
  // sepRe (language codes: commas or newlines; vocabulary: newlines only).
  function toStringList(value, sepRe) {
    const items = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(sepRe) : []);
    return items.map((s) => String(s).trim()).filter((s) => s.length > 0);
  }

  // voice.refine with its defaults: on unless switched off, the fast Gemini model, a 5 s budget.
  function resolveRefineConfig(voice) {
    const r = (voice && voice.refine) || {};
    const sec = Math.round(Number(r.timeoutSec));
    return {
      enabled: r.enabled !== false,
      model: (typeof r.model === 'string' && r.model.trim()) || DEFAULT_REFINE_MODEL,
      timeoutSec: (sec >= 1 && sec <= MAX_REFINE_TIMEOUT_SEC) ? sec : DEFAULT_REFINE_TIMEOUT_SEC
    };
  }

  // What the second stage needs to know about the spot being dictated into: the caret's line, and
  // the selection (which then becomes the text the dictation edits). text/caret only, no DOM.
  function editorContext(text, selStart, selEnd) {
    const v = typeof text === 'string' ? text : '';
    const s = Math.max(0, Math.min(v.length, selStart | 0));
    const e = Math.max(s, Math.min(v.length, selEnd | 0));
    // lastIndexOf clamps a negative start to 0, so a caret at 0 needs its own case (the text may open with a newline).
    const lineStart = s === 0 ? 0 : v.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = v.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = v.length;
    return {
      line: v.slice(lineStart, Math.min(lineEnd, lineStart + MAX_CONTEXT_LINE)),
      selection: e > s ? v.slice(s, e) : ''
    };
  }

  // Merges voice config with vision fallback (shared Gemini credentials) and spec defaults.
  // opts.timeout overrides the request timeout in seconds (0 = the backend's own default).
  function resolveVoiceConfig(rawConfig, opts) {
    const cfg = rawConfig || {};
    const voice = cfg.voice || {};
    const vision = cfg.vision || {};
    return {
      refine: resolveRefineConfig(voice),
      baseUrl: voice.baseUrl || vision.baseUrl || 'https://generativelanguage.googleapis.com',
      apiKey: voice.apiKey || vision.apiKey || '',
      model: voice.model || DEFAULT_MODEL,
      apiStyle: voice.apiStyle || 'auto',
      prompt: voice.prompt || DEFAULT_PROMPT,
      languageCodes: toStringList(voice.languageCodes, /[,\n]/),
      mode: String(voice.mode || '').toLowerCase() === 'verbatim' ? 'verbatim' : 'smart',
      customVocabulary: toStringList(voice.customVocabulary, /\n/),
      silence_timeout_sec: (typeof voice.silence_timeout_sec === 'number' && voice.silence_timeout_sec > 0)
        ? voice.silence_timeout_sec : DEFAULT_SILENCE_SEC,
      timeout: (opts && typeof opts.timeout === 'number' && opts.timeout >= 0) ? opts.timeout : 30
    };
  }

  // job (PC dictation only): { refine, line, selection } - whether this request goes through the
  // second stage and what the editor looked like. Without one (Mobile Drop, ...) the request carries
  // no refine block at all and the backend transcribes as before.
  function requestConfigJSON(cfg, job) {
    const req = {
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, apiStyle: cfg.apiStyle, prompt: cfg.prompt,
      languageCodes: cfg.languageCodes, mode: cfg.mode, customVocabulary: cfg.customVocabulary, timeout: cfg.timeout
    };
    if (job) {
      req.refine = { enabled: !!job.refine, model: cfg.refine.model, timeoutSec: cfg.refine.timeoutSec };
      if (job.refine) req.refineContext = { line: job.line || '', selection: job.selection || '' };
    }
    return JSON.stringify(req);
  }

  // The one place the voice config sent to the backend is built: PC recording, retry and
  // Mobile Drop all go through it.
  function configJSON(rawConfig, opts) {
    return requestConfigJSON(resolveVoiceConfig(rawConfig, opts));
  }

  function idFromReqId(reqId) {
    if (typeof reqId !== 'string') return null;
    const idx = reqId.lastIndexOf('_');
    return idx === -1 ? null : reqId.slice(idx + 1);
  }

  // ---- i18n / toast (falls back to a built-in JA/EN table when bridge.t doesn't know the key) --

  function getUILang() {
    try {
      if (global.document && global.document.documentElement && global.document.documentElement.lang === 'en') return 'en';
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  function tr(bridge, key, params) {
    try {
      if (bridge && typeof bridge.t === 'function') {
        const v = bridge.t(key, params);
        if (v && v !== key) return v;
      }
    } catch (e) { /* ignore, fall back below */ }
    const lang = getUILang();
    let text = (I18N_FALLBACK[lang] && I18N_FALLBACK[lang][key]) || I18N_FALLBACK.ja[key] || key;
    if (params) {
      Object.keys(params).forEach((k) => { text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]); });
    }
    return text;
  }

  function toast(bridge, key, params, durationMs) {
    try {
      const text = tr(bridge, key, params);
      if (bridge && typeof bridge.showMessage === 'function') bridge.showMessage(text, durationMs || 4000);
    } catch (e) { /* ignore */ }
  }

  // getUserMedia failure -> the i18n key that says what to do about it.
  function micErrorKey(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'voiceMicBlocked';
    if (name === 'NotFoundError') return 'voiceMicNotFound';
    if (name === 'NotReadableError' || name === 'AbortError') return 'voiceMicBusy';
    return 'voiceMicDenied';
  }

  // ---- rescue cache map (localStorage, keyed by anchor id, survives app restart) --------------

  function loadCacheMap() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  }

  function saveCacheMap(map) {
    try { if (global.localStorage) global.localStorage.setItem(CACHE_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  function setCachePath(id, cachePath) {
    if (!id || !cachePath) return;
    const map = loadCacheMap();
    map[id] = cachePath;
    saveCacheMap(map);
  }

  function getCachePath(id) {
    if (!id) return null;
    return loadCacheMap()[id] || null;
  }

  function clearCacheEntry(id) {
    if (!id) return;
    const map = loadCacheMap();
    if (id in map) { delete map[id]; saveCacheMap(map); }
  }

  // ---- runtime state --------------------------------------------------------------------------

  let recording = false;
  let stopping = false;
  let aborting = false;
  let mediaStreamRef = null;
  let mediaRecorder = null;
  let audioCtx = null;
  let analyser = null;
  let silenceTimer = null;
  let silenceState = null;
  let chunks = [];
  let usedMimeType = 'audio/webm';
  let currentId = null;
  let currentTabId = null;
  let currentAnchor = null;
  let indicatorEl = null;
  let indicatorTimer = null;
  let indicatorStartMs = 0;
  const pending = new Map(); // id -> tabId, while a transcription request is in flight
  // id -> { tabId, base64, mimeType, timer, timedOut }: the recording of a request that has not been answered yet, so a
  // request that goes missing (or whose result could not be cached by the backend) can be sent again from memory.
  const inflight = new Map();
  // id -> { refine, line, selection }: how the dictation was started (see requestConfigJSON). It lives
  // until the note has its result or the marker is discarded, so a retry asks the backend for the same
  // thing, and a rewrite that fails or is cancelled can put the selected text back.
  const jobs = new Map();
  const MAX_KEPT_JOBS = 20;

  function isRecording() { return recording; }

  function rememberJob(id, job) {
    jobs.set(id, job);
    while (jobs.size > MAX_KEPT_JOBS) jobs.delete(jobs.keys().next().value);
  }

  // A dictation this session has no record of (started before an app restart) follows the setting alone.
  function jobFor(id, cfg) {
    return jobs.get(id) || { refine: !!(cfg && cfg.refine && cfg.refine.enabled), line: '', selection: '' };
  }

  // The text the marker stands for when it is removed instead of answered: the selection a spoken rewrite
  // was going to replace, else nothing.
  function markerReplacement(id) {
    const job = jobs.get(id);
    return (job && job.selection) || '';
  }

  // Takes a marker out of the note for good (nothing will answer it) and forgets the dictation.
  function removeMarker(bridge, tabId, anchor, id) {
    if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
      bridge.replaceAnchor(tabId, anchor, markerReplacement(id));
    }
    jobs.delete(id);
  }

  function clearInflightTimer(entry) {
    if (entry && entry.timer) { global.clearTimeout(entry.timer); entry.timer = null; }
  }

  function dropInflight(id) {
    clearInflightTimer(inflight.get(id));
    inflight.delete(id);
  }

  function rememberInflight(id, entry) {
    inflight.set(id, entry);
    while (inflight.size > MAX_KEPT_AUDIO) {
      const oldest = inflight.keys().next().value;
      dropInflight(oldest);
    }
  }

  function watchdogMs(cfg, job) {
    const sec = (cfg && typeof cfg.timeout === 'number' && cfg.timeout > 0) ? cfg.timeout : DEFAULT_REQUEST_TIMEOUT_SEC;
    const refineSec = (job && job.refine && cfg && cfg.refine) ? cfg.refine.timeoutSec : 0;
    return (sec + refineSec) * 1000 + TRANSCRIBE_GRACE_MS;
  }

  // The request never answered: the marker becomes the retry marker, and a late answer is still accepted (see
  // __onVoiceResult).
  function giveUpWaiting(id, toastKey) {
    const entry = inflight.get(id);
    if (!entry || entry.timedOut) return;
    clearInflightTimer(entry);
    entry.timedOut = true;
    const bridge = global.MdMemoBridge;
    const tabId = pending.has(id) ? pending.get(id) : entry.tabId;
    if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
      bridge.replaceAnchor(tabId, buildTranscribingAnchor(id), buildRescueAnchor(id));
    }
    toast(bridge, toastKey, null, ERROR_TOAST_MS);
  }

  function armWatchdog(id, cfg) {
    const entry = inflight.get(id);
    if (!entry) return;
    clearInflightTimer(entry);
    entry.timedOut = false;
    entry.timer = global.setTimeout(() => giveUpWaiting(id, 'voiceTranscribeTimeout'), watchdogMs(cfg, jobFor(id, cfg)));
  }

  // Sends one recording to the backend. A refused call (the bound function rejecting) is treated like silence.
  function sendForTranscription(id, entry, cfg) {
    const backend = global.backend;
    armWatchdog(id, cfg);
    let result;
    try {
      result = backend.transcribeAudioAsync('voice_' + id, entry.base64, entry.mimeType, requestConfigJSON(cfg, jobFor(id, cfg)));
    } catch (e) {
      giveUpWaiting(id, 'voiceTranscribeUnavailable');
      return;
    }
    if (result && typeof result.catch === 'function') {
      result.catch(() => giveUpWaiting(id, 'voiceTranscribeUnavailable'));
    }
  }

  // The toolbar button mirrors the recording state through this single listener.
  let stateListener = null;
  let lastNotified = false;
  function onStateChange(fn) { stateListener = typeof fn === 'function' ? fn : null; }
  function notifyState() {
    if (recording === lastNotified) return; // report changes only
    lastNotified = recording;
    if (!stateListener) return;
    try { stateListener(recording); } catch (e) { /* a UI listener must never break recording */ }
  }

  // ---- recording indicator (lazy CSS, no emoji) ------------------------------------------------

  // The app's line icon for "stop": an outlined square.
  const STOP_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

  function ensureStyles() {
    if (global.document.getElementById('voice-input-styles')) return;
    const style = global.document.createElement('style');
    style.id = 'voice-input-styles';
    style.textContent =
      '.voice-indicator{position:fixed;left:16px;bottom:16px;z-index:9999;display:flex;align-items:center;' +
      'gap:8px;background:var(--bg-modal,#252526);color:var(--text-main,#d4d4d4);' +
      'border:1px solid var(--border-color,#3e3e42);border-radius:999px;padding:6px 12px;' +
      'font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);}' +
      '.voice-dot{width:8px;height:8px;border-radius:50%;background:#e5484d;animation:voice-pulse 1.2s infinite;}' +
      '.voice-stop{display:inline-flex;align-items:center;gap:5px;background:transparent;color:inherit;font:inherit;' +
      'line-height:1.5;border:1px solid var(--border-color,#3e3e42);border-radius:999px;padding:1px 9px;cursor:pointer;}' +
      '.voice-stop:hover{border-color:#e5484d;background:rgba(229,72,77,.16);}' +
      '.voice-stop svg{flex:none;}' +
      '@keyframes voice-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}' +
      '@media (prefers-reduced-motion:reduce){.voice-dot{animation:none;}}';
    global.document.head.appendChild(style);
  }

  function updateIndicator() {
    if (!indicatorEl) return;
    const sec = Math.max(0, Math.floor((Date.now() - indicatorStartMs) / 1000));
    const elapsedEl = indicatorEl.querySelector && indicatorEl.querySelector('.voice-elapsed');
    if (elapsedEl) elapsedEl.textContent = sec + 's';
  }

  function showIndicator(bridge) {
    ensureStyles();
    if (!indicatorEl) {
      indicatorEl = global.document.createElement('div');
      indicatorEl.className = 'voice-indicator';
      indicatorEl.innerHTML =
        '<span class="voice-dot"></span><span class="voice-elapsed"></span>' +
        '<button type="button" class="voice-stop">' + STOP_ICON_SVG + '<span class="voice-stop-label"></span></button>' +
        '<span class="voice-esc"></span>';
      const stopEl = indicatorEl.querySelector && indicatorEl.querySelector('.voice-stop');
      if (stopEl) {
        // A click must not take the focus (and with it the caret) away from the note; it ends the recording
        // exactly as pressing the shortcut again does.
        stopEl.addEventListener('mousedown', (ev) => { ev.preventDefault(); });
        stopEl.addEventListener('click', () => { stop(); });
      }
      global.document.body.appendChild(indicatorEl);
    }
    const escEl = indicatorEl.querySelector && indicatorEl.querySelector('.voice-esc');
    if (escEl) escEl.textContent = tr(bridge, 'voiceEscHint');
    const stopEl = indicatorEl.querySelector && indicatorEl.querySelector('.voice-stop');
    if (stopEl) {
      stopEl.title = tr(bridge, 'voiceStopTitle');
      const labelEl = stopEl.querySelector && stopEl.querySelector('.voice-stop-label');
      if (labelEl) labelEl.textContent = tr(bridge, 'voiceStopLabel');
    }
    indicatorStartMs = Date.now();
    updateIndicator();
    indicatorTimer = global.setInterval(updateIndicator, 1000);
  }

  function hideIndicator() {
    if (indicatorTimer) { global.clearInterval(indicatorTimer); indicatorTimer = null; }
    if (indicatorEl && indicatorEl.parentNode) indicatorEl.parentNode.removeChild(indicatorEl);
    indicatorEl = null;
  }

  // ---- recording lifecycle --------------------------------------------------------------------

  function stopTracks() {
    if (mediaStreamRef) {
      try { mediaStreamRef.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    }
    mediaStreamRef = null;
  }

  function clearSilenceDetection() {
    if (silenceTimer) { global.clearInterval(silenceTimer); silenceTimer = null; }
    try { if (audioCtx && typeof audioCtx.close === 'function') audioCtx.close(); } catch (e) { /* ignore */ }
    audioCtx = null;
    analyser = null;
    silenceState = null;
  }

  function setupSilenceDetection(stream, cfg) {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      silenceState = createSilenceState(cfg.silence_timeout_sec);
      silenceTimer = global.setInterval(() => {
        try {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          if (silenceUpdate(silenceState, rms, Date.now())) stop();
        } catch (e) { /* best effort */ }
      }, SAMPLE_INTERVAL_MS);
    } catch (e) { /* silence auto-stop is best effort; manual stop / ESC still work */ }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new global.FileReader();
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.onload = () => {
          const result = String(reader.result || '');
          const idx = result.indexOf(',');
          resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
  }

  // The rendered preview hides the editor; recording into it would insert text nobody can see.
  function editorIsVisible(bridge) {
    return !(bridge && typeof bridge.isEditorVisible === 'function' && !bridge.isEditorVisible());
  }

  let starting = false; // getUserMedia is pending (possibly on a permission prompt)

  // opts.raw: skip the second stage for this dictation, whatever the setting says.
  async function start(opts) {
    if (recording || starting) return;
    const bridge = global.MdMemoBridge;
    if (!bridge) return;
    if (!global.navigator || !global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia || !global.MediaRecorder) {
      toast(bridge, 'voiceMicDenied', null, ERROR_TOAST_MS);
      return;
    }
    if (!editorIsVisible(bridge)) {
      toast(bridge, 'voiceNeedsEditor', null, ERROR_TOAST_MS);
      return;
    }
    const editor = bridge.getActiveEditor && bridge.getActiveEditor();
    if (!editor) return;

    // With the second stage on, a selection is what the dictation edits (speak-to-edit), and the whole
    // of it goes to the model: refuse one that is too big before the microphone is even asked for.
    const refineOn = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {}).refine.enabled && !(opts && opts.raw);
    if (refineOn && editor.selectionEnd - editor.selectionStart > MAX_EDIT_SELECTION) {
      toast(bridge, 'voiceEditTooLong', { max: MAX_EDIT_SELECTION }, ERROR_TOAST_MS);
      return;
    }

    // Something must show on screen the moment the shortcut / button is used, so the user can tell
    // the press arrived even when the microphone takes a while (or a permission prompt is up).
    starting = true;
    toast(bridge, 'voiceStarting', null, STARTING_TOAST_MS);
    const waitTimer = global.setTimeout(() => toast(bridge, 'voiceWaitingPermission', null, WAITING_TOAST_MS), PERMISSION_WAIT_MS);

    let stream;
    try {
      stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      global.clearTimeout(waitTimer);
      starting = false;
      try { console.warn('[voice] getUserMedia failed', e && e.name, e && e.message); } catch (_) { /* ignore */ }
      toast(bridge, micErrorKey(e), null, ERROR_TOAST_MS);
      return;
    }
    global.clearTimeout(waitTimer);
    starting = false;

    if (!editorIsVisible(bridge)) { // the view changed while the permission prompt was open
      stopTracksOf(stream);
      toast(bridge, 'voiceNeedsEditor', null, ERROR_TOAST_MS);
      return;
    }

    // Read now, after the permission prompt: this is the text the anchor is about to replace.
    const context = editorContext(editor.value, editor.selectionStart, editor.selectionEnd);
    if (refineOn && context.selection.length > MAX_EDIT_SELECTION) {
      stopTracksOf(stream);
      toast(bridge, 'voiceEditTooLong', { max: MAX_EDIT_SELECTION }, ERROR_TOAST_MS);
      return;
    }

    const mimeType = chooseMimeType(global.MediaRecorder.isTypeSupported ? global.MediaRecorder.isTypeSupported.bind(global.MediaRecorder) : null);
    let recorder;
    try {
      recorder = mimeType ? new global.MediaRecorder(stream, { mimeType: mimeType }) : new global.MediaRecorder(stream);
    } catch (e) {
      stopTracksOf(stream);
      toast(bridge, 'voiceMicDenied', null, ERROR_TOAST_MS);
      return;
    }

    const id = genId();
    const tabId = bridge.getTabIdForEditor ? bridge.getTabIdForEditor(editor) : null;
    const anchor = buildRecordingAnchor(id);
    bridge.insertTextWithUndo(anchor, editor);
    rememberJob(id, { refine: refineOn, line: context.line, selection: refineOn ? context.selection : '' });

    recording = true;
    stopping = false;
    aborting = false;
    currentId = id;
    currentTabId = tabId;
    currentAnchor = anchor;
    chunks = [];
    usedMimeType = (recorder.mimeType || mimeType || 'audio/webm');
    mediaRecorder = recorder;
    mediaStreamRef = stream;

    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    recorder.onstop = onRecorderStop;
    recorder.start();

    const cfg = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {});
    setupSilenceDetection(stream, cfg);
    showIndicator(bridge);
    notifyState();
    // The recording indicator takes over from the "preparing" / "waiting" messages.
    try { if (typeof bridge.showMessage === 'function') bridge.showMessage('', 1); } catch (e) { /* ignore */ }
  }

  function stopTracksOf(stream) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  }

  function stop() {
    if (!recording || stopping) return;
    stopping = true;
    stopTracks();
    clearSilenceDetection();
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      else onRecorderStop();
    } catch (e) {
      onRecorderStop();
    }
  }

  function abort() {
    if (!recording) return;
    aborting = true;
    const bridge = global.MdMemoBridge;
    const tabId = currentTabId;
    const anchorText = currentAnchor;
    stopTracks();
    clearSilenceDetection();
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) { /* ignore */ }
    recording = false;
    stopping = false;
    chunks = [];
    hideIndicator();
    notifyState();
    // A spoken rewrite that is cancelled gives the selected text back.
    if (anchorText) removeMarker(bridge, tabId, anchorText, currentId);
  }

  function onRecorderStop() {
    recording = false;
    stopping = false;
    hideIndicator();
    notifyState();
    if (aborting) { aborting = false; return; }

    const bridge = global.MdMemoBridge;
    const id = currentId;
    const tabId = currentTabId;
    const anchorText = currentAnchor;
    const mimeType = usedMimeType;
    const collected = chunks;
    chunks = [];

    if (!id) return;
    const transcribing = buildTranscribingAnchor(id);
    if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
      bridge.replaceAnchor(tabId, anchorText, transcribing);
    }
    pending.set(id, tabId);

    const backend = global.backend;
    if (!backend || typeof backend.transcribeAudioAsync !== 'function') {
      pending.delete(id);
      removeMarker(bridge, tabId, transcribing, id);
      toast(bridge, 'voiceTranscribeUnavailable');
      return;
    }

    let blob;
    try { blob = new global.Blob(collected, { type: mimeType }); } catch (e) { blob = null; }
    if (!blob) {
      pending.delete(id);
      removeMarker(bridge, tabId, transcribing, id);
      toast(bridge, 'voiceTranscribeUnavailable');
      return;
    }

    const cfg = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {});
    blobToBase64(blob).then((base64) => {
      rememberInflight(id, { tabId: tabId, base64: base64, mimeType: mimeType, timer: null, timedOut: false });
      sendForTranscription(id, inflight.get(id), cfg);
    }).catch(() => {
      // The recording could not even be read back: there is nothing to send and nothing to retry.
      pending.delete(id);
      dropInflight(id);
      removeMarker(bridge, tabId, transcribing, id);
      toast(bridge, 'voiceTranscribeUnavailable');
    });
  }

  // opts.raw: when this press starts a recording, skip the second stage for it.
  function toggle(opts) {
    if (recording) stop(); else start(opts);
  }

  // ---- __onVoiceResult callback + rescue click handling ----------------------------------------

  // refineErr: the reason the second stage failed ("" = it worked or was not asked for). text is then the
  // transcript as spoken.
  global.__onVoiceResult = function (reqId, text, err, cachePath, refineErr) {
    const id = idFromReqId(reqId);
    if (!id) return;
    const bridge = global.MdMemoBridge;
    const tabId = pending.has(id) ? pending.get(id) : null;
    pending.delete(id);
    const entry = inflight.get(id);
    // After the watchdog gave up, the note holds the retry marker instead of the "transcribing" one
    const rescueAnchor = buildRescueAnchor(id);
    const waitingAnchor = (entry && entry.timedOut) ? rescueAnchor : buildTranscribingAnchor(id);
    if (err) {
      if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function' && waitingAnchor !== rescueAnchor) {
        bridge.replaceAnchor(tabId, waitingAnchor, rescueAnchor);
      }
      setCachePath(id, cachePath);
      if (cachePath) {
        dropInflight(id); // the backend keeps the audio now
      } else if (entry) {
        clearInflightTimer(entry); // it could not: keep the copy in memory so [再試行] still has something to send
        entry.timedOut = true;
      }
      toast(bridge, 'voiceTranscribeFailed', { error: err });
    } else {
      // A plain dictation whose second stage failed keeps the transcript. A spoken rewrite has nothing
      // useful to insert then (the transcript is an instruction), so the selection is put back.
      const original = markerReplacement(id);
      const editFailed = !!(refineErr && original);
      const finalText = editFailed ? original : String(text || '').trim();
      if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
        bridge.replaceAnchor(tabId, waitingAnchor, finalText);
      }
      jobs.delete(id);
      dropInflight(id);
      clearCacheEntry(id);
      if (refineErr) toast(bridge, editFailed ? 'voiceEditFailed' : 'voiceRefineFailed', { error: refineErr }, ERROR_TOAST_MS);
    }
  };

  async function handleRescueAction(found, anchorText, tabId, bridge) {
    const id = found.id;
    if (!id) { toast(bridge, 'voiceCacheMissing'); return; }

    if (found.action === 'retry') {
      const cachePath = getCachePath(id);
      const memory = inflight.get(id);
      const fromMemory = !cachePath && !!(memory && memory.base64);
      if (!cachePath && !fromMemory) { toast(bridge, 'voiceCacheMissing'); return; }
      const transcribing = buildTranscribingAnchor(id);
      const ok = tabId != null && typeof bridge.replaceAnchor === 'function' && bridge.replaceAnchor(tabId, anchorText, transcribing);
      if (!ok) return;
      pending.set(id, tabId);
      const backend = global.backend;
      const method = fromMemory ? 'transcribeAudioAsync' : 'retryVoiceCacheAsync';
      if (!backend || typeof backend[method] !== 'function') {
        pending.delete(id);
        bridge.replaceAnchor(tabId, transcribing, buildRescueAnchor(id));
        toast(bridge, 'voiceTranscribeUnavailable');
        return;
      }
      const cfg = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {});
      if (fromMemory) {
        memory.tabId = tabId;
        sendForTranscription(id, memory, cfg);
        return;
      }
      // The audio is in the backend's cache: only a marker entry is kept here, so the watchdog still applies
      rememberInflight(id, { tabId: tabId, base64: '', mimeType: '', timer: null, timedOut: false });
      armWatchdog(id, cfg);
      let result;
      try { result = backend.retryVoiceCacheAsync('voice_' + id, cachePath, requestConfigJSON(cfg, jobFor(id, cfg))); } catch (e) { giveUpWaiting(id, 'voiceTranscribeUnavailable'); return; }
      if (result && typeof result.catch === 'function') result.catch(() => giveUpWaiting(id, 'voiceTranscribeUnavailable'));
      return;
    }

    if (found.action === 'keep') {
      const cachePath = getCachePath(id);
      if (!cachePath) { toast(bridge, 'voiceCacheMissing'); return; }
      try {
        const noteDir = bridge.getNoteDir ? await bridge.getNoteDir() : '';
        const backend = global.backend;
        if (!backend || typeof backend.keepVoiceCache !== 'function') { toast(bridge, 'voiceKeepFailed'); return; }
        const res = await backend.keepVoiceCache(cachePath, noteDir);
        const target = (res && (res.relPath || res.fileUrl)) || '';
        if (tabId != null && target) bridge.replaceAnchor(tabId, anchorText, `[audio](${target})`);
        clearCacheEntry(id);
      } catch (e) {
        toast(bridge, 'voiceKeepFailed', { error: String((e && e.message) || e) });
      }
      return;
    }

    if (found.action === 'discard') {
      const cachePath = getCachePath(id);
      try {
        const backend = global.backend;
        if (cachePath && backend && typeof backend.discardVoiceCache === 'function') {
          await backend.discardVoiceCache(cachePath);
        }
        removeMarker(bridge, tabId, anchorText, id);
        clearCacheEntry(id);
      } catch (e) {
        toast(bridge, 'voiceDiscardFailed', { error: String((e && e.message) || e) });
      }
    }
  }

  // A "文字起こし中" marker that no request waits for (the app was closed while it was pending, so the saved note brings it
  // back for ever) is turned into the retry marker when the recording is still around, and removed when it is not. Runs on
  // an editor click; the text is only searched when the marker text is there at all.
  function sweepStaleTranscribing(editor) {
    if (editor.value.indexOf('⦅文字起こし中') === -1) return;
    const bridge = global.MdMemoBridge;
    if (!bridge || typeof bridge.replaceAnchor !== 'function') return;
    const tabId = bridge.getTabIdForEditor ? bridge.getTabIdForEditor(editor) : null;
    if (tabId == null) return;
    const re = /⦅文字起こし中\.\.\. \[id:([a-z0-9]{4})\]⦆/g;
    const stale = [];
    let m;
    while ((m = re.exec(editor.value)) !== null) {
      if (!pending.has(m[1])) stale.push({ id: m[1], text: m[0] });
    }
    let restored = 0;
    let removed = 0;
    stale.forEach((s) => {
      const memory = inflight.get(s.id);
      const recoverable = !!getCachePath(s.id) || !!(memory && memory.base64);
      bridge.replaceAnchor(tabId, s.text, recoverable ? buildRescueAnchor(s.id) : markerReplacement(s.id));
      if (!recoverable) jobs.delete(s.id);
      if (recoverable) restored++; else removed++;
    });
    if (restored) toast(bridge, 'voiceStaleRestored', null, ERROR_TOAST_MS);
    else if (removed) toast(bridge, 'voiceStaleRemoved', null, ERROR_TOAST_MS);
  }

  function handleEditorClick(editor, event) {
    if (!editor || typeof editor.value !== 'string' || typeof editor.selectionStart !== 'number') return false;
    const found = findRescueAction(editor.value, editor.selectionStart);
    if (!found) {
      sweepStaleTranscribing(editor);
      return false;
    }
    const bridge = global.MdMemoBridge;
    if (!bridge) return false;
    const anchorText = editor.value.slice(found.anchorStart, found.anchorEnd);
    const tabId = bridge.getTabIdForEditor ? bridge.getTabIdForEditor(editor) : null;
    handleRescueAction(found, anchorText, tabId, bridge);
    return true;
  }

  function handleKeydown(event) {
    if (!recording) return false;
    if (event && event.key === 'Escape') {
      abort();
      return true;
    }
    return false;
  }

  function init() {
    // Listener wiring is done by the integrator (Ctrl/Cmd+Shift+R -> toggle(), ESC -> handleKeydown,
    // editor click -> handleEditorClick). Nothing here needs to run eagerly.
  }

  global.VoiceInput = {
    init: init,
    toggle: toggle,
    abort: abort,
    isRecording: isRecording,
    onStateChange: onStateChange,
    configJSON: configJSON,
    handleEditorClick: handleEditorClick,
    handleKeydown: handleKeydown
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findRescueAction: findRescueAction,
      buildRecordingAnchor: buildRecordingAnchor,
      buildTranscribingAnchor: buildTranscribingAnchor,
      buildRescueAnchor: buildRescueAnchor,
      createSilenceState: createSilenceState,
      silenceUpdate: silenceUpdate,
      chooseMimeType: chooseMimeType,
      resolveVoiceConfig: resolveVoiceConfig,
      resolveRefineConfig: resolveRefineConfig,
      editorContext: editorContext,
      MAX_EDIT_SELECTION: MAX_EDIT_SELECTION,
      requestConfigJSON: requestConfigJSON,
      configJSON: configJSON,
      onStateChange: onStateChange,
      notifyState: notifyState,
      micErrorKey: micErrorKey,
      start: start,
      idFromReqId: idFromReqId,
      RMS_THRESHOLD: RMS_THRESHOLD
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
