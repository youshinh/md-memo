// MD-Memo settings: the on-device speech engine (Whisper) panel - engine choice, download / remove of
// the program and the model, a custom model (a file on disk or a URL) and advanced options.
// It talks to window.backend only; app.js calls init() once and load()/save() around the Settings dialog.
(function (global) {
  'use strict';

  const LOCAL_ENGINE = 'whisper-local';
  const MODEL_CUSTOM_PATH = 'custom-path';
  const MODEL_CUSTOM_URL = 'custom-url';

  // 1024-based, like Explorer, so a size matches what the file shows on disk.
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
    if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function percent(done, total) {
    return total > 0 ? Math.max(0, Math.min(100, Math.floor((done * 100) / total))) : 0;
  }

  // The whisper block of config.voice, with every field present and typed.
  function normalizeWhisper(w) {
    const src = w || {};
    const threads = parseInt(src.threads, 10);
    return {
      model: typeof src.model === 'string' ? src.model : '',
      modelPath: typeof src.modelPath === 'string' ? src.modelPath : '',
      customUrl: typeof src.customUrl === 'string' ? src.customUrl : '',
      customSha256: typeof src.customSha256 === 'string' ? src.customSha256 : '',
      language: typeof src.language === 'string' ? src.language : '',
      threads: Number.isFinite(threads) && threads > 0 ? threads : 0,
      prompt: typeof src.prompt === 'string' ? src.prompt : '',
      cloudFallback: !!src.cloudFallback
    };
  }

  function normalizeEngine(e) {
    return e === LOCAL_ENGINE ? LOCAL_ENGINE : 'gemini';
  }

  let t = (key) => key;
  let backend = null;
  let doc = null;
  let lastStatus = null;
  let refreshTimer = null;
  let bound = false;
  // The saved model id, used until the <select> has been filled from the backend's catalog (and kept
  // when there is no backend at all, so saving never wipes it).
  let savedModel = '';
  const installs = { runtime: null, model: null };

  const $ = (id) => (doc ? doc.getElementById(id) : null);
  const setHidden = (el, hidden) => { if (el) el.classList.toggle('hidden', !!hidden); };
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

  function hasBackend() {
    return !!(backend && typeof backend.getSpeechStatus === 'function');
  }

  // What the settings screen currently shows, in the shape config.voice stores it.
  function readUI() {
    const get = (id) => { const el = $(id); return el ? el.value : ''; };
    const checked = (id) => { const el = $(id); return !!(el && el.checked); };
    return {
      engine: normalizeEngine(get('cfg-speech-engine')),
      whisper: normalizeWhisper({
        model: modelValue(),
        modelPath: get('cfg-speech-model-path').trim(),
        customUrl: get('cfg-speech-model-url').trim(),
        customSha256: get('cfg-speech-model-sha').trim(),
        language: get('cfg-speech-language').trim(),
        threads: get('cfg-speech-threads'),
        prompt: get('cfg-speech-prompt').trim(),
        cloudFallback: checked('cfg-speech-cloud-fallback')
      })
    };
  }

  function modelValue() {
    const sel = $('cfg-speech-model');
    return sel && sel.options && sel.options.length > 0 ? sel.value : savedModel;
  }

  function configJSON() {
    return JSON.stringify(readUI());
  }

  function load(config) {
    const voice = (config && config.voice) || {};
    const w = normalizeWhisper(voice.whisper);
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    set('cfg-speech-engine', normalizeEngine(voice.engine));
    set('cfg-speech-model-path', w.modelPath);
    set('cfg-speech-model-url', w.customUrl);
    set('cfg-speech-model-sha', w.customSha256);
    set('cfg-speech-language', w.language);
    set('cfg-speech-threads', String(w.threads));
    set('cfg-speech-prompt', w.prompt);
    const cf = $('cfg-speech-cloud-fallback');
    if (cf) cf.checked = w.cloudFallback;
    savedModel = w.model;
    const sel = $('cfg-speech-model');
    if (sel && sel.options && sel.options.length > 0) {
      const known = Array.from(sel.options).some((o) => o.value === w.model);
      sel.value = known ? w.model : ((lastStatus && lastStatus.defaultModel) || sel.value);
    }
    refresh();
  }

  function save(config) {
    if (!config) return;
    if (!config.voice) config.voice = {};
    const ui = readUI();
    config.voice.engine = ui.engine;
    config.voice.whisper = ui.whisper;
  }

  function refresh() {
    updatePanelVisibility();
    if (!hasBackend()) return Promise.resolve();
    let raw;
    try {
      raw = backend.getSpeechStatus(configJSON());
    } catch (e) {
      return Promise.resolve();
    }
    return Promise.resolve(raw).then((json) => {
      try { lastStatus = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      render();
    }).catch(() => {});
  }

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 350);
  }

  function updatePanelVisibility() {
    const block = $('speech-engine-block');
    if (block) setHidden(block, !hasBackend());
    const engine = normalizeEngine(($('cfg-speech-engine') || {}).value);
    setHidden($('speech-whisper-panel'), engine !== LOCAL_ENGINE);
  }

  function findPart(status, id) {
    if (!status) return null;
    const all = (status.models || []).slice();
    if (status.custom) all.push(status.custom);
    return all.find((m) => m.part && m.part.id === id) || null;
  }

  function fillModelSelect(status) {
    const sel = $('cfg-speech-model');
    if (!sel || !doc) return;
    const wanted = sel.options.length === 0 ? savedModel : sel.value;
    while (sel.options.length > 0) sel.remove(0);
    const add = (value, label) => {
      const o = doc.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    };
    (status.models || []).forEach((m) => add(m.part.id, m.part.title + ' (' + formatSize(m.part.size) + ')'));
    add(MODEL_CUSTOM_PATH, t('speechModelCustomPath'));
    add(MODEL_CUSTOM_URL, t('speechModelCustomUrl'));
    const known = Array.from(sel.options).some((o) => o.value === wanted);
    sel.value = known ? wanted : (status.defaultModel || '');
  }

  function renderRow(prefix, entry, downloading) {
    const statusEl = $('speech-' + prefix + '-status');
    const installBtn = $('btn-speech-' + prefix + '-install');
    const removeBtn = $('btn-speech-' + prefix + '-remove');
    const cancelBtn = $('btn-speech-' + prefix + '-cancel');
    const progress = $('speech-' + prefix + '-progress');
    const supported = !!(lastStatus && lastStatus.supported);
    const installed = !!(entry && entry.status && entry.status.installed);
    if (statusEl && !downloading) {
      if (!entry) statusEl.textContent = '';
      else if (installed) statusEl.textContent = t('speechInstalled') + ' (' + formatSize(entry.status.size) + ')';
      else statusEl.textContent = t('speechNotInstalled') + (entry.part.size ? ' (' + formatSize(entry.part.size) + ')' : '');
    }
    setHidden(installBtn, downloading || installed || !entry || !supported);
    setHidden(removeBtn, downloading || !installed);
    setHidden(cancelBtn, !downloading);
    setHidden(progress, !downloading);
  }

  function render() {
    const status = lastStatus;
    if (!status) return;
    updatePanelVisibility();
    setHidden($('speech-unsupported'), !!status.supported);

    fillModelSelect(status);
    const modelId = ($('cfg-speech-model') || {}).value;
    const isPath = modelId === MODEL_CUSTOM_PATH;
    const isUrl = modelId === MODEL_CUSTOM_URL;
    setHidden($('speech-custom-path'), !isPath);
    setHidden($('speech-custom-url'), !isUrl);
    setHidden($('speech-model-actions'), isPath);

    renderRow('runtime', status.runtime, installs.runtime !== null);
    const modelEntry = isPath ? null : (isUrl ? status.custom : findPart(status, modelId));
    renderRow('model', modelEntry, installs.model !== null);
    setText('speech-model-note', modelEntry && modelEntry.part.note ? modelEntry.part.note : '');
    if (isUrl && !status.custom) setText('speech-model-status', '');

    const local = status.local || {};
    let hint = local.ready ? t('speechReady') : (local.reason || '');
    if (local.modelWarning) hint += (hint ? ' ' : '') + local.modelWarning;
    setText('speech-ready-hint', hint);
    setText('speech-storage-dir', status.storageDir || '');
  }

  function newReqId(which) {
    return 'speech_' + which + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function startInstall(which) {
    if (!hasBackend() || typeof backend.installSpeechPartAsync !== 'function' || installs[which]) return;
    const reqId = newReqId(which);
    installs[which] = reqId;
    setText('speech-ready-hint', '');
    setText('speech-' + which + '-status', t('speechDownloading', { done: formatSize(0), total: '…' }));
    render();
    try {
      const p = backend.installSpeechPartAsync(reqId, which, configJSON());
      if (p && typeof p.catch === 'function') p.catch((e) => finishInstall(reqId, 'error', String((e && e.message) || e)));
    } catch (e) {
      finishInstall(reqId, 'error', String((e && e.message) || e));
    }
  }

  function whichForReq(reqId) {
    return Object.keys(installs).find((k) => installs[k] === reqId) || null;
  }

  function finishInstall(reqId, state, message) {
    const which = whichForReq(reqId);
    if (!which) return;
    installs[which] = null;
    if (state === 'error') setText('speech-ready-hint', t('speechInstallFailed', { error: message || '' }));
    else if (state === 'canceled') setText('speech-ready-hint', t('speechCanceled'));
    refresh();
  }

  // Called by the Go backend: window.__onSpeechInstall(reqId, state, done, total, message).
  function onInstallEvent(reqId, state, done, total, message) {
    const which = whichForReq(reqId);
    if (!which) return;
    if (state === 'progress') {
      const bar = $('speech-' + which + '-progress');
      if (bar) bar.value = percent(done, total);
      setText('speech-' + which + '-status', t('speechDownloading', { done: formatSize(done), total: total ? formatSize(total) : '…' }));
      return;
    }
    finishInstall(reqId, state, message);
  }

  function cancelInstall(which) {
    const reqId = installs[which];
    if (reqId && backend && typeof backend.cancelSpeechInstall === 'function') backend.cancelSpeechInstall(reqId);
  }

  function removePart(which) {
    if (!hasBackend() || typeof backend.removeSpeechPart !== 'function') return;
    Promise.resolve(backend.removeSpeechPart(which, configJSON())).then((err) => {
      if (err) setText('speech-ready-hint', String(err));
      refresh();
    }).catch(() => refresh());
  }

  function validateChosenPath() {
    const path = (($('cfg-speech-model-path') || {}).value || '').trim();
    const out = $('speech-model-path-result');
    if (!out) return;
    if (!path || !backend || typeof backend.validateWhisperModelFile !== 'function') { out.textContent = ''; return; }
    Promise.resolve(backend.validateWhisperModelFile(path)).then((raw) => {
      let res = {};
      try { res = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (e) { /* leave empty */ }
      out.textContent = res.ok ? t('speechModelOk') : (res.error || '');
      refresh();
    }).catch(() => {});
  }

  function browseModelFile() {
    if (!backend || typeof backend.pickFilePath !== 'function') return;
    Promise.resolve(backend.pickFilePath(t('speechModelPathLabel'))).then((picked) => {
      if (!picked) return;
      const input = $('cfg-speech-model-path');
      if (input) input.value = picked;
      validateChosenPath();
    }).catch(() => { /* cancelled */ });
  }

  function bind() {
    const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };
    on('cfg-speech-engine', 'change', refresh);
    on('cfg-speech-model', 'change', refresh);
    ['cfg-speech-model-url', 'cfg-speech-model-sha', 'cfg-speech-language', 'cfg-speech-threads'].forEach((id) => on(id, 'input', scheduleRefresh));
    on('cfg-speech-model-path', 'change', validateChosenPath);
    on('btn-speech-model-browse', 'click', browseModelFile);
    on('btn-speech-runtime-install', 'click', () => startInstall('runtime'));
    on('btn-speech-model-install', 'click', () => startInstall('model'));
    on('btn-speech-runtime-cancel', 'click', () => cancelInstall('runtime'));
    on('btn-speech-model-cancel', 'click', () => cancelInstall('model'));
    on('btn-speech-runtime-remove', 'click', () => removePart('runtime'));
    on('btn-speech-model-remove', 'click', () => removePart('model'));
  }

  // opts: { t: (key, params) => string, backend: window.backend, doc: document }
  function init(opts) {
    const o = opts || {};
    if (typeof o.t === 'function') t = o.t;
    backend = o.backend || global.backend || null;
    doc = o.doc || (typeof document !== 'undefined' ? document : null);
    global.__onSpeechInstall = onInstallEvent;
    if (!bound) {
      bind();
      bound = true;
    }
    updatePanelVisibility();
  }

  const api = { init, load, save, refresh, onInstallEvent, formatSize, percent, normalizeWhisper, normalizeEngine };
  global.SpeechSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
