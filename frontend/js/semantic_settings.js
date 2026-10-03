// MD-Memo settings: the "Semantic search" section of the AI Models tab - the switch, the embedding model, where the notes go (and the
// consent for a host that is not this PC), and the index (its state, "Update now", "Rebuild"). docs/design/semantic-search-2026-10.md
// section 9. It talks to window.backend only (semanticStatus, semanticUpdate, cancelSemanticUpdate: app_semantic.go, which uses the
// same code as `md-memo scrap index`); app.js calls init() and load() when the Settings dialog opens, and save() when it is saved.
//
// The buttons act on the section AS IT IS ON THE SCREEN (it is passed to the backend), so they work before Save. Nothing here is
// written to config.json until Save, and nothing is written at all when the person did not touch the section (a person who never uses
// the feature gets no "semantic" key).
(function (global) {
  'use strict';

  const DEFAULT_BASE_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'bge-m3';
  const REFRESH_DELAY_MS = 400;

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // 1024-based, like the other sizes in the settings.
  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // "2026-10-03T08:37:00+09:00" -> "2026-10-03 08:37" (the person's own clock: the backend wrote it in local time).
  function formatWhen(rfc3339) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(rfc3339 || ''));
    return m ? m[1] + ' ' + m[2] : String(rfc3339 || '');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function today(now) {
    const d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // What the form says, in the shape of config.semantic: the saved section is the base (the keys the screen does not show - schedule,
  // privacy.excludeKinds - are kept as they are), the form's fields go over it. host is the key a consent is stored under (the status
  // says it); consent is whether the person allows sending notes there.
  function buildSection(saved, form, host, consent, now) {
    const prev = saved && typeof saved === 'object' ? saved : {};
    const section = Object.assign({}, prev);
    section.enabled = !!form.enabled;
    const model = Object.assign({}, prev.model && typeof prev.model === 'object' ? prev.model : {});
    model.baseUrl = String(form.baseUrl || '').trim();
    model.model = String(form.model || '').trim();
    const key = String(form.apiKey || '').trim();
    if (key) model.apiKey = key; else delete model.apiKey;
    section.model = model;
    if (host) {
      const privacy = Object.assign({}, prev.privacy && typeof prev.privacy === 'object' ? prev.privacy : {});
      const consents = Object.assign({}, privacy.cloudConsent && typeof privacy.cloudConsent === 'object' ? privacy.cloudConsent : {});
      if (consent) { if (!consents[host]) consents[host] = today(now); } else delete consents[host];
      privacy.cloudConsent = consents;
      section.privacy = privacy;
    }
    return section;
  }

  // The fields a person can change here, to tell whether anything changed (the section is then saved; otherwise left alone).
  function essence(section) {
    const s = section && typeof section === 'object' ? section : {};
    const m = s.model && typeof s.model === 'object' ? s.model : {};
    const c = s.privacy && s.privacy.cloudConsent && typeof s.privacy.cloudConsent === 'object' ? s.privacy.cloudConsent : {};
    return JSON.stringify({
      enabled: s.enabled === true,
      baseUrl: String(m.baseUrl || '').trim(),
      model: String(m.model || '').trim(),
      apiKey: String(m.apiKey || '').trim(),
      consent: Object.keys(c).filter(function (h) { return !!c[h]; }).sort()
    });
  }

  // The code at the start of a backend message ("cancelled", "locked", "confirm_required: 1500 chunk texts to host"), and the rest.
  function parseCode(err) {
    const msg = String((err && err.message) || err || '');
    const m = /^([a-z_]+)(?::\s*(.*))?$/s.exec(msg);
    if (m && /^(cancelled|not_enabled|consent_required|confirm_required|rebuild_needed|locked)$/.test(m[1])) return { code: m[1], rest: (m[2] || '').trim(), message: msg };
    return { code: '', rest: '', message: msg };
  }

  // "1500 chunk texts to api.example.com" -> { texts: 1500, host: 'api.example.com' }
  function parseConfirm(rest) {
    const m = /^(\d+) chunk texts to (.+)$/.exec(String(rest || '').trim());
    return m ? { texts: Number(m[1]), host: m[2] } : { texts: 0, host: String(rest || '') };
  }

  // The line that says how the index stands: { text, kind } with kind ok / warn / note.
  function describeIndex(status, t) {
    const st = status || {};
    if (!st.enabled) return { text: t('semanticIndexOff'), kind: 'note' };
    if (st.folder_missing) return { text: t('semanticIndexFolderMissing', { dir: st.scrap_dir || '' }), kind: 'warn' };
    if (st.corrupt) return { text: t('semanticIndexDamaged'), kind: 'warn' };
    if (!st.exists) return { text: t('semanticIndexNone'), kind: 'note' };
    const built = t('semanticIndexBuilt', { chunks: st.chunks || 0, files: st.files || 0, size: formatSize(st.size_bytes), updated: formatWhen(st.updated) });
    const join = t('semanticJoin');
    if (st.rebuild_needed) return { text: built + join + t('semanticIndexRebuildNeeded'), kind: 'warn' };
    const lag = (st.new_files || 0) + (st.changed_files || 0) + (st.removed_files || 0);
    if (lag > 0) {
      return { text: built + join + t('semanticIndexLag', { added: st.new_files || 0, changed: st.changed_files || 0, removed: st.removed_files || 0 }), kind: 'note' };
    }
    return { text: built + join + t('semanticIndexUpToDate'), kind: 'ok' };
  }

  // What the buttons may do for a status: { update, rebuild }. Nothing without the switch, a usable model and (for a host that is not this
  // PC) the consent; Rebuild only when there is an index to make again (or a damaged one).
  function allowedActions(status, running) {
    const st = status || {};
    const usable = !!(st.enabled && st.model && !st.folder_missing && (st.local || st.consent_given));
    return {
      update: usable && !running && !st.corrupt,
      rebuild: usable && !running && !!(st.exists || st.corrupt)
    };
  }

  // ---- the section --------------------------------------------------------------------------

  let t = (key) => key;
  let backend = null;
  let doc = null;
  let oneLine = (e) => String((e && e.message) || e || '');
  let saved = null;          // config.semantic as it was when the dialog opened (or null: none)
  let savedEssence = '';
  let lastStatus = null;
  let consentChecked = false;
  let statusSeq = 0;
  let timer = null;
  let running = false;
  let pendingConfirm = null; // { rebuild } of a large run that waits for "Go ahead"
  let bound = false;
  let loaded = false;

  const $ = (id) => (doc ? doc.getElementById(id) : null);
  const setHidden = (el, hidden) => { if (el) el.classList.toggle('hidden', !!hidden); };
  const hasBackend = () => !!(backend && typeof backend.semanticStatus === 'function');

  function setLine(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('semantic-ok', 'semantic-warn', 'semantic-note');
    if (kind) el.classList.add('semantic-' + kind);
    setHidden(el, !text);
  }

  function formFields() {
    const g = (id) => { const el = $(id); return el ? el.value : ''; };
    const en = $('cfg-semantic-enabled');
    return { enabled: !!(en && en.checked), baseUrl: g('cfg-semantic-base-url'), model: g('cfg-semantic-model'), apiKey: g('cfg-semantic-api-key') };
  }

  // The section as the screen holds it now.
  function currentSection() {
    const host = lastStatus && !lastStatus.local ? lastStatus.destination : '';
    return buildSection(saved, formFields(), host, consentChecked);
  }

  function setBusy(on) {
    running = !!on;
    renderButtons();
  }

  function renderButtons() {
    const act = allowedActions(lastStatus, running);
    const set = (id, enabled) => { const el = $(id); if (el) el.disabled = !enabled; };
    set('btn-semantic-update', act.update && !pendingConfirm);
    set('btn-semantic-rebuild', act.rebuild && !pendingConfirm);
    setHidden($('btn-semantic-cancel'), !running);
    setHidden($('btn-semantic-go'), !pendingConfirm);
    setHidden($('btn-semantic-update'), running);
    setHidden($('btn-semantic-rebuild'), running);
  }

  function render(status) {
    lastStatus = status;
    const form = formFields();
    // where the notes go
    const dest = $('semantic-destination');
    const consentGroup = $('semantic-consent-group');
    if (status && status.model) {
      if (status.local) {
        setLine('semantic-destination', t('semanticDestLocal'), 'ok');
        setHidden(consentGroup, true);
      } else {
        setLine('semantic-destination', t('semanticDestCloud', { host: status.destination || '' }), 'warn');
        setHidden(consentGroup, false);
        const label = $('semantic-consent-label');
        if (label) label.textContent = t('semanticConsentLabel', { host: status.destination || '' });
        const box = $('cfg-semantic-consent');
        consentChecked = !!status.consent_given;
        if (box) box.checked = consentChecked;
        setHidden($('semantic-consent-note'), consentChecked);
      }
    } else if (status && status.model_error && form.enabled) {
      setLine('semantic-destination', t('semanticModelProblem', { message: status.model_error }), 'warn');
      setHidden(consentGroup, true);
    } else {
      if (dest) setHidden(dest, true);
      setHidden(consentGroup, true);
    }
    const idx = describeIndex(status, t);
    setLine('semantic-index-status', idx.text, idx.kind);
    renderButtons();
  }

  async function refresh() {
    if (!hasBackend() || !doc) return;
    const seq = ++statusSeq;
    if (!lastStatus) setLine('semantic-index-status', t('semanticIndexChecking'), 'note');
    let status;
    try {
      status = await backend.semanticStatus(currentSection());
    } catch (err) {
      if (seq !== statusSeq) return;
      setLine('semantic-index-status', t('semanticFailed', { message: oneLine(err) }), 'warn');
      return;
    }
    if (seq !== statusSeq) return; // a newer look has been asked for
    if (typeof status === 'string') {
      try { status = JSON.parse(status); } catch (e) { status = null; }
    }
    render(status || {});
  }

  function scheduleRefresh() {
    global.clearTimeout(timer);
    timer = global.setTimeout(refresh, REFRESH_DELAY_MS);
  }

  function showResult(text, kind) { setLine('semantic-index-result', text, kind); }

  async function runUpdate(rebuild, yes) {
    if (running || !hasBackend()) return;
    pendingConfirm = null;
    showResult('', '');
    setLine('semantic-index-progress', t('semanticProgress', { files: 0, filesTotal: 0, texts: 0, textsTotal: 0 }), 'note');
    setBusy(true);
    try {
      let res = await backend.semanticUpdate(currentSection(), !!rebuild, !!yes);
      if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
      res = res || {};
      const nothing = !res.embedded && !res.files_changed && !res.files_removed && !res.rebuilt;
      showResult(nothing ? t('semanticDoneNothing') : t('semanticDone', { seconds: res.seconds || 0, embedded: res.embedded || 0, changed: res.files_changed || 0 }), 'ok');
    } catch (err) {
      const c = parseCode(err);
      if (c.code === 'cancelled') showResult(t('semanticCancelled'), 'note');
      else if (c.code === 'locked') showResult(t('semanticLocked'), 'warn');
      else if (c.code === 'not_enabled') showResult(t('semanticNotEnabled'), 'warn');
      else if (c.code === 'consent_required') showResult(t('semanticConsentRequired', { host: c.rest }), 'warn');
      else if (c.code === 'rebuild_needed') showResult(t('semanticIndexRebuildNeeded'), 'warn');
      else if (c.code === 'confirm_required') {
        const q = parseConfirm(c.rest);
        pendingConfirm = { rebuild: !!rebuild };
        showResult(t('semanticConfirmLarge', { texts: q.texts, host: q.host }), 'warn');
      } else showResult(t('semanticFailed', { message: oneLine(err) }), 'warn');
    } finally {
      setLine('semantic-index-progress', '', '');
      setBusy(false);
      refresh();
    }
  }

  function onProgress(files, filesTotal, texts, textsTotal) {
    if (!running) return;
    setLine('semantic-index-progress', t('semanticProgress', { files: files, filesTotal: filesTotal, texts: texts, textsTotal: textsTotal }), 'note');
  }

  function bind() {
    if (bound || !doc) return;
    bound = true;
    const on = (id, type, fn) => { const el = $(id); if (el) el.addEventListener(type, fn); };
    on('cfg-semantic-enabled', 'change', function () {
      const box = $('cfg-semantic-enabled');
      if (box && box.checked) { // turned on: the usual local model is filled in, so that the switch alone is enough
        const url = $('cfg-semantic-base-url');
        const model = $('cfg-semantic-model');
        if (url && !url.value.trim()) url.value = DEFAULT_BASE_URL;
        if (model && !model.value.trim()) model.value = DEFAULT_MODEL;
      }
      pendingConfirm = null;
      scheduleRefresh();
    });
    ['cfg-semantic-base-url', 'cfg-semantic-model', 'cfg-semantic-api-key'].forEach(function (id) {
      on(id, 'input', function () { pendingConfirm = null; scheduleRefresh(); });
    });
    on('cfg-semantic-consent', 'change', function () {
      const box = $('cfg-semantic-consent');
      consentChecked = !!(box && box.checked);
      setHidden($('semantic-consent-note'), consentChecked);
      scheduleRefresh();
    });
    on('btn-semantic-update', 'click', function () { runUpdate(false, false); });
    on('btn-semantic-rebuild', 'click', function () { runUpdate(true, false); });
    on('btn-semantic-go', 'click', function () { const p = pendingConfirm; if (p) runUpdate(p.rebuild, true); });
    on('btn-semantic-cancel', 'click', function () {
      if (backend && typeof backend.cancelSemanticUpdate === 'function') Promise.resolve(backend.cancelSemanticUpdate()).catch(function () {});
    });
  }

  // ---- called by app.js ---------------------------------------------------------------------

  function init(opts) {
    t = (opts && opts.t) || t;
    backend = (opts && opts.backend) || backend;
    doc = (opts && opts.doc) || doc;
    if (opts && typeof opts.oneLine === 'function') oneLine = opts.oneLine;
    bind();
    if (global) global.__semanticProgress = onProgress; // the backend reports a run's progress here
  }

  // The dialog opened: the fields from config.semantic, and a look at the index.
  function load(config) {
    if (!doc) return;
    saved = config && config.semantic && typeof config.semantic === 'object' ? JSON.parse(JSON.stringify(config.semantic)) : null;
    savedEssence = essence(saved);
    const s = saved || {};
    const m = s.model && typeof s.model === 'object' ? s.model : {};
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    const en = $('cfg-semantic-enabled');
    if (en) en.checked = s.enabled === true;
    set('cfg-semantic-base-url', m.baseUrl || '');
    set('cfg-semantic-model', m.model || '');
    set('cfg-semantic-api-key', m.apiKey || '');
    pendingConfirm = null;
    lastStatus = null;
    consentChecked = false;
    loaded = true;
    setLine('semantic-index-result', '', '');
    setLine('semantic-index-progress', '', '');
    renderButtons();
    refresh();
  }

  // The dialog is saved: config.semantic is set when the section was changed, and left alone otherwise.
  function save(config) {
    if (!loaded || !config || !doc) return;
    const section = currentSection();
    if (essence(section) === savedEssence) return;
    config.semantic = section;
    saved = JSON.parse(JSON.stringify(section));
    savedEssence = essence(saved);
  }

  const api = {
    init: init, load: load, save: save, refresh: refresh,
    formatSize: formatSize, formatWhen: formatWhen, today: today, buildSection: buildSection, essence: essence,
    parseCode: parseCode, parseConfirm: parseConfirm, describeIndex: describeIndex, allowedActions: allowedActions,
    DEFAULT_BASE_URL: DEFAULT_BASE_URL, DEFAULT_MODEL: DEFAULT_MODEL
  };
  global.SemanticSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
