// MD-Memo voice input: anchor-protected async voice recording with rescue recovery.
// Spec: 機能 3 (堅牢な非同期バッチ音声入力). Uses window.MdMemoBridge / window.backend only;
// never touches app.js internals directly.
(function (global) {
  'use strict';

  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const RMS_THRESHOLD = 0.015;
  const SAMPLE_INTERVAL_MS = 200;
  const DEFAULT_SILENCE_SEC = 5;
  const DEFAULT_PROMPT = 'この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。';
  const CACHE_KEY = 'md_memo_voice_cache_v1';

  const I18N_FALLBACK = {
    ja: {
      voiceMicDenied: 'マイクを使用できませんでした',
      voiceTranscribeFailed: '文字起こしに失敗しました: {error}',
      voiceTranscribeUnavailable: '文字起こし機能を利用できません',
      voiceKeepFailed: '音声の保存に失敗しました',
      voiceDiscardFailed: '音声の破棄に失敗しました',
      voiceCacheMissing: '音声キャッシュが見つかりません',
      voiceEscHint: 'ESC で破棄'
    },
    en: {
      voiceMicDenied: 'Could not use the microphone',
      voiceTranscribeFailed: 'Transcription failed: {error}',
      voiceTranscribeUnavailable: 'Voice transcription is unavailable',
      voiceKeepFailed: 'Failed to save the audio',
      voiceDiscardFailed: 'Failed to discard the audio',
      voiceCacheMissing: 'Voice cache not found',
      voiceEscHint: 'ESC to discard'
    }
  };

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

  // Merges voice config with vision fallback (shared Gemini credentials) and spec defaults.
  function resolveVoiceConfig(rawConfig) {
    const cfg = rawConfig || {};
    const voice = cfg.voice || {};
    const vision = cfg.vision || {};
    return {
      baseUrl: voice.baseUrl || vision.baseUrl || 'https://generativelanguage.googleapis.com',
      apiKey: voice.apiKey || vision.apiKey || '',
      model: voice.model || 'gemini-2.5-flash',
      prompt: voice.prompt || DEFAULT_PROMPT,
      silence_timeout_sec: (typeof voice.silence_timeout_sec === 'number' && voice.silence_timeout_sec > 0)
        ? voice.silence_timeout_sec : DEFAULT_SILENCE_SEC,
      timeout: 30
    };
  }

  function requestConfigJSON(cfg) {
    return JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, prompt: cfg.prompt, timeout: cfg.timeout });
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

  function toast(bridge, key, params) {
    try {
      const text = tr(bridge, key, params);
      if (bridge && typeof bridge.showMessage === 'function') bridge.showMessage(text, 4000);
    } catch (e) { /* ignore */ }
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

  function isRecording() { return recording; }

  // ---- recording indicator (lazy CSS, no emoji) ------------------------------------------------

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
        '<span class="voice-dot"></span><span class="voice-elapsed"></span><span class="voice-esc"></span>';
      global.document.body.appendChild(indicatorEl);
    }
    const escEl = indicatorEl.querySelector && indicatorEl.querySelector('.voice-esc');
    if (escEl) escEl.textContent = tr(bridge, 'voiceEscHint');
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

  async function start() {
    if (recording) return;
    const bridge = global.MdMemoBridge;
    if (!bridge) return;
    if (!global.navigator || !global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia || !global.MediaRecorder) {
      toast(bridge, 'voiceMicDenied');
      return;
    }
    const editor = bridge.getActiveEditor && bridge.getActiveEditor();
    if (!editor) return;

    let stream;
    try {
      stream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast(bridge, 'voiceMicDenied');
      return;
    }

    const mimeType = chooseMimeType(global.MediaRecorder.isTypeSupported ? global.MediaRecorder.isTypeSupported.bind(global.MediaRecorder) : null);
    let recorder;
    try {
      recorder = mimeType ? new global.MediaRecorder(stream, { mimeType: mimeType }) : new global.MediaRecorder(stream);
    } catch (e) {
      stopTracksOf(stream);
      toast(bridge, 'voiceMicDenied');
      return;
    }

    const id = genId();
    const tabId = bridge.getTabIdForEditor ? bridge.getTabIdForEditor(editor) : null;
    const anchor = buildRecordingAnchor(id);
    bridge.insertTextWithUndo(anchor, editor);

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
    if (tabId != null && anchorText && bridge && typeof bridge.replaceAnchor === 'function') {
      bridge.replaceAnchor(tabId, anchorText, '');
    }
  }

  function onRecorderStop() {
    recording = false;
    stopping = false;
    hideIndicator();
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
      if (tabId != null && bridge) bridge.replaceAnchor(tabId, transcribing, '');
      toast(bridge, 'voiceTranscribeUnavailable');
      return;
    }

    let blob;
    try { blob = new global.Blob(collected, { type: mimeType }); } catch (e) { blob = null; }
    if (!blob) {
      pending.delete(id);
      if (tabId != null && bridge) bridge.replaceAnchor(tabId, transcribing, '');
      toast(bridge, 'voiceTranscribeUnavailable');
      return;
    }

    const cfg = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {});
    blobToBase64(blob).then((base64) => {
      backend.transcribeAudioAsync('voice_' + id, base64, mimeType, requestConfigJSON(cfg));
    }).catch(() => {
      pending.delete(id);
      if (tabId != null && bridge) bridge.replaceAnchor(tabId, transcribing, '');
      toast(bridge, 'voiceTranscribeUnavailable');
    });
  }

  function toggle() {
    if (recording) stop(); else start();
  }

  // ---- __onVoiceResult callback + rescue click handling ----------------------------------------

  global.__onVoiceResult = function (reqId, text, err, cachePath) {
    const id = idFromReqId(reqId);
    if (!id) return;
    const bridge = global.MdMemoBridge;
    const tabId = pending.has(id) ? pending.get(id) : null;
    pending.delete(id);
    const transcribingAnchor = buildTranscribingAnchor(id);
    if (err) {
      const rescueAnchor = buildRescueAnchor(id);
      if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
        bridge.replaceAnchor(tabId, transcribingAnchor, rescueAnchor);
      }
      setCachePath(id, cachePath);
      toast(bridge, 'voiceTranscribeFailed', { error: err });
    } else {
      const finalText = String(text || '').trim();
      if (tabId != null && bridge && typeof bridge.replaceAnchor === 'function') {
        bridge.replaceAnchor(tabId, transcribingAnchor, finalText);
      }
      clearCacheEntry(id);
    }
  };

  async function handleRescueAction(found, anchorText, tabId, bridge) {
    const id = found.id;
    if (!id) { toast(bridge, 'voiceCacheMissing'); return; }

    if (found.action === 'retry') {
      const cachePath = getCachePath(id);
      if (!cachePath) { toast(bridge, 'voiceCacheMissing'); return; }
      const transcribing = buildTranscribingAnchor(id);
      const ok = tabId != null && typeof bridge.replaceAnchor === 'function' && bridge.replaceAnchor(tabId, anchorText, transcribing);
      if (!ok) return;
      pending.set(id, tabId);
      const backend = global.backend;
      if (!backend || typeof backend.retryVoiceCacheAsync !== 'function') {
        pending.delete(id);
        bridge.replaceAnchor(tabId, transcribing, buildRescueAnchor(id));
        toast(bridge, 'voiceTranscribeUnavailable');
        return;
      }
      const cfg = resolveVoiceConfig(bridge.getConfig ? bridge.getConfig() : {});
      backend.retryVoiceCacheAsync('voice_' + id, cachePath, requestConfigJSON(cfg));
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
        if (tabId != null) bridge.replaceAnchor(tabId, anchorText, '');
        clearCacheEntry(id);
      } catch (e) {
        toast(bridge, 'voiceDiscardFailed', { error: String((e && e.message) || e) });
      }
    }
  }

  function handleEditorClick(editor, event) {
    if (!editor || typeof editor.value !== 'string' || typeof editor.selectionStart !== 'number') return false;
    const found = findRescueAction(editor.value, editor.selectionStart);
    if (!found) return false;
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
      requestConfigJSON: requestConfigJSON,
      idFromReqId: idFromReqId,
      RMS_THRESHOLD: RMS_THRESHOLD
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
