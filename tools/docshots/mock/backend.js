// Mock backend for the documentation screenshots. Injected by tools/docshots/server.mjs into an
// in-memory copy of frontend/index.html, before any app script runs.
//
// It replaces window.backend (normally bound by window_windows.go), fixes the clock, blocks every
// request that leaves the local server and seeds localStorage. It never opens files, launches
// programs or talks to a real service.
(function () {
  'use strict';
  var B = window.__DOCSHOT_BOOT;
  var D = window.__docshot = {
    boot: B,
    calls: [],
    ghost: '',
    jev: [],
    slotRuns: [],
    workspaceScanned: false,
    llmReply: 'Demo reply.',
  };

  // ---- fixed clock: advances normally from a fixed start, or stops on demand ----------------------
  var RealDate = Date;
  var base = new RealDate(B.clock.y, B.clock.m, B.clock.d, B.clock.h, B.clock.mi, 0).getTime();
  var t0 = RealDate.now();
  var frozen = null;
  function nowMs() { return frozen !== null ? frozen : base + (RealDate.now() - t0); }
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs()); else super(...args); }
    static now() { return nowMs(); }
  }
  window.Date = FakeDate;
  D.freezeClock = function () { frozen = nowMs(); return frozen; };
  D.unfreezeClock = function () { if (frozen !== null) { t0 = RealDate.now(); base = frozen; frozen = null; } };

  // ---- nothing leaves the local server ------------------------------------------------------------
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var raw = typeof input === 'string' ? input : (input && input.url) || '';
    var abs = new URL(raw, location.href);
    if (abs.origin !== location.origin) {
      D.calls.push({ fn: 'fetch(blocked)', args: [abs.origin] });
      return Promise.reject(new TypeError('docshot: network blocked'));
    }
    return realFetch(input, init);
  };

  var FRESH = !!(B.query && B.query.fresh === '1');
  // ?nosession=1 (with fresh=1): nothing was ever opened either - no saved tabs, no remembered folder - the very first launch (the Welcome note).
  var NOSESSION = !!(B.query && B.query.nosession === '1');
  // ?nomodel=1 (a shot's "boot"): no AI model can answer (a cloud model with no key), so the status bar says "AI: not set up".
  if (B.query && B.query.nomodel === '1' && B.config && B.config.text) {
    B.config.text.baseUrl = 'https://generativelanguage.googleapis.com';
    B.config.text.model = 'gemini-flash-lite-latest';
    B.config.text.apiKey = '';
  }
  // ?semantic=1 (a shot's "boot"): Semantic search is on (config.json's "semantic"), so the notes search shows Exact | Meaning.
  if (B.query && B.query.semantic === '1' && B.config) {
    B.config.semantic = { enabled: true, model: { baseUrl: 'http://localhost:11434', model: 'bge-m3' } };
  }

  // ---- seed storage so the first paint already has the demo state ---------------------------------
  try {
    localStorage.clear();
    // ?fresh=1 (a shot's "boot"): a profile with nothing saved, as on the first launch (the calm header). The language then comes from the
    // browser, so the browser is told to speak the picture's language.
    if (FRESH) {
      try { Object.defineProperty(navigator, 'language', { get: function () { return B.lang === 'ja' ? 'ja-JP' : 'en-US'; } }); } catch (e) { /* keep the browser's */ }
    } else {
      localStorage.setItem('md_notepad_config_v3', JSON.stringify(B.config));
    }
    if (!NOSESSION) {
      localStorage.setItem('md_memo_session_v1', JSON.stringify(B.session));
      localStorage.setItem('md_memo_workspace_folder', B.workspace.root);
      // fresh=1 without nosession is the SECOND start of a new profile: no settings saved, a session left behind, and the mark the first
      // start made (app.js CALM_TOOLBAR_MARK) - so the short first-launch toolbar is still there, next to the demo tabs.
      if (FRESH) localStorage.setItem('md_memo_calm_toolbar_v1', '1');
    }
    localStorage.setItem('md_memo_cli_history', JSON.stringify(B.cliHistory));
  } catch (e) { /* storage unavailable: the backend mock below still supplies everything */ }

  // ---- backend ------------------------------------------------------------------------------------
  var resolve = function (v) { return Promise.resolve(v); };
  // The notes search functions take the filter as their last argument (search panel: a period and tags): it is kept apart as `filter` (null when
  // none), so that `args` stays the text and the count/limit the flows have always compared.
  var FILTERED = { searchScraps: 1, searchScrapsSemantic: 1, deepSearchPlan: 1 };
  var log = function (fn, args) {
    var entry = { fn: fn, args: Array.prototype.slice.call(args, 0, 3) };
    if (FILTERED[fn]) {
      entry.args = entry.args.slice(0, 2);
      entry.filter = args[2] == null ? null : JSON.parse(JSON.stringify(args[2]));
    }
    D.calls.push(entry);
  };

  function findNote(p) {
    for (var i = 0; i < B.noteFiles.length; i++) if (B.noteFiles[i].path === p) return B.noteFiles[i];
    return null;
  }

  // `{{ @name ... }}`: an agents.yaml key or one of its aliases (case-insensitive) picks that agent and the result goes below.
  function resolveAgent(name) {
    var n = String(name).toLowerCase(), agents = (B.slotConfig && B.slotConfig.agents) || {};
    return Object.keys(agents).filter(function (k) {
      return k.toLowerCase() === n || (agents[k].aliases || []).some(function (a) { return String(a).toLowerCase() === n; });
    })[0] || null;
  }

  function parseSlots(text, cursor) {
    var re = /\{\{([\s\S]*?)\}\}/g;
    var m, slots = [];
    while ((m = re.exec(text))) {
      var inner = m[1].trim(), agentName = '', role = 'code', instr = inner;
      var mm = /^@(\S+)\s*([\s\S]*)$/.exec(inner);
      var key = mm && resolveAgent(mm[1]);
      if (key) { agentName = key; role = '@' + mm[1]; instr = mm[2]; }
      slots.push({
        type: 'slot', openDelimiter: '{{', closeDelim: '}}',
        startOffset: m.index, endOffset: m.index + m[0].length, rawContent: m[0],
        role: role, instruction: instr, agentName: agentName || undefined, outputMode: agentName ? 'below' : 'replace',
        isInline: true, isTarget: false,
      });
    }
    var target = null;
    for (var i = 0; i < slots.length; i++) {
      if (cursor >= slots[i].startOffset && cursor <= slots[i].endOffset) { target = slots[i]; break; }
    }
    if (!target && slots.length) target = slots[0];
    if (target) target.isTarget = true;
    return { targetSlot: target || undefined, allSlots: slots, hasWaitingApproval: false };
  }

  // ---- the search filter (docs/design/tag-filter-2026-10.md section 4.6; frontend/js/scraps_filter.js) ----------------------------------------
  // D.filter: the tags of the mock notes and the knobs of scrapFilterOptions.
  //   tags     { file name: { file: [tags of the whole file], lines: [{ from, to, tags }] } } - what the Go side reads out of the notes; the tags of a
  //            line are the file's and those of the range that holds it. The notes of the manual's pictures (and the meaning hits) have some by default.
  //   extra    more notes the plain search finds and the options count: [{ fileName, lines, tags: { file, lines } }]. None by default (the pictures list three).
  //   options  a fixed answer for scrapFilterOptions (null = counted from the notes); reject: a message the call fails with; delayMs: it answers late.
  D.filter = { tags: {}, extra: [], options: null, reject: '', delayMs: 0 };
  D.filter.tags['2026-09-17.md'] = { file: ['work', 'idea'] };
  D.filter.tags['2026-09-15.md'] = { file: ['work', 'urgent'] };
  D.filter.tags['2026-09-12.md'] = { file: ['reading'] };
  (function () { // the days of the meaning hits (2026-09-28 down to 2026-09-17)
    for (var day = 18; day <= 28; day++) {
      var own = [];
      if (day % 2 === 0) own.push('work');
      if (day % 3 === 0) own.push('reading');
      if (day % 4 === 0) own.push('urgent');
      if (own.length) D.filter.tags['2026-09-' + day + '.md'] = { file: own };
    }
  })();
  // The day a file name starts with (a real YYYY-MM-DD, not followed by a digit), or '' - scrap.DayOfName on the Go side.
  function dayOfName(name) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(String(name || ''));
    if (!m) return '';
    var dt = new RealDate(RealDate.UTC(+m[1], +m[2] - 1, +m[3]));
    return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3] ? m[1] + '-' + m[2] + '-' + m[3] : '';
  }
  function tagInfo(name) {
    if (D.filter.tags[name]) return D.filter.tags[name];
    for (var i = 0; i < D.filter.extra.length; i++) if (D.filter.extra[i].fileName === name) return D.filter.extra[i].tags || null;
    return null;
  }
  function tagsOfLine(name, line) {
    var info = tagInfo(name), out = info && info.file ? info.file.slice() : [];
    ((info && info.lines) || []).forEach(function (r) { if (line >= r.from && line <= r.to) out = out.concat(r.tags); });
    return out;
  }
  // What the bind would answer to a filter it cannot use: the search fails with one line (a malformed date, more than 8 tags).
  function badFilter(f) {
    if (!f) return '';
    if (f.tags != null && (!Array.isArray(f.tags) || f.tags.length > 8)) return 'filter: at most 8 tags';
    var re = /^\d{4}-\d{2}-\d{2}$/;
    if ((f.from != null && !re.test(f.from)) || (f.to != null && !re.test(f.to))) return 'filter: dates are written YYYY-MM-DD';
    return '';
  }
  // Does the note's line pass the filter? A period leaves out the notes with no date in their name; tags must ALL be on the line's entry.
  function passes(name, line, f) {
    if (!f) return true;
    if (f.from || f.to) {
      var day = dayOfName(name);
      if (!day || (f.from && day < f.from) || (f.to && day > f.to)) return false;
    }
    var want = f.tags || [];
    if (want.length) {
      var have = tagsOfLine(name, line);
      for (var i = 0; i < want.length; i++) if (have.indexOf(want[i]) === -1) return false;
    }
    return true;
  }
  // The notes the filter options count: the plain search's, the extra ones, and the days of the meaning hits.
  function allNoteNames() {
    var seen = {}, names = [];
    var add = function (n) { if (!seen[n]) { seen[n] = true; names.push(n); } };
    B.scraps.forEach(function (f) { add(f.fileName); });
    D.filter.extra.forEach(function (f) { add(f.fileName); });
    for (var i = 0; i < D.semantic.total; i++) add('2026-09-' + pad2(28 - i) + '.md');
    return names;
  }
  function scrapFilterOptions() {
    if (D.filter.reject) return Promise.reject(new Error(D.filter.reject));
    var answer = D.filter.options;
    if (!answer) {
      var names = allNoteNames(), counts = {}, undated = 0;
      names.forEach(function (n) {
        if (!dayOfName(n)) undated++;
        var info = tagInfo(n), mine = {};
        ((info && info.file) || []).forEach(function (t) { mine[t] = 1; });
        ((info && info.lines) || []).forEach(function (r) { r.tags.forEach(function (t) { mine[t] = 1; }); });
        Object.keys(mine).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      });
      answer = {
        tags: Object.keys(counts).map(function (t) { return { tag: t, files: counts[t], entries: counts[t] }; })
          .sort(function (a, b) { return b.files - a.files || (a.tag < b.tag ? -1 : 1); }),
        files: names.length, undated: undated
      };
    }
    var copy = JSON.parse(JSON.stringify(answer));
    return D.filter.delayMs > 0 ? new Promise(function (res) { setTimeout(function () { res(copy); }, D.filter.delayMs); }) : resolve(copy);
  }

  // ---- tags: adding and removing (docs/design/tag-filter-2026-10.md section 10; frontend/js/tag_edit.js) -----------------------------------------
  // tagEdit(request) answers what search.EditTags answers for the text the page sends: the work is tag_edit_mock.js (a port of the Go code, which node
  // tests check against the Go side's golden cases), loaded before this file. D.tagEdit: reject = a message the call fails with; delayMs = it answers late.
  D.tagEdit = { reject: '', delayMs: 0 };
  function tagEdit(request) {
    var req = request;
    if (typeof req === 'string') { try { req = JSON.parse(req); } catch (e) { req = null; } }
    if (D.tagEdit.reject) return Promise.reject(new Error(D.tagEdit.reject));
    if (!req || typeof req !== 'object') return Promise.reject(new Error('tagEdit: the request is not an object'));
    var answer;
    try {
      answer = window.TagEditMock.editTags(req.text, req.op, req.scope || 'note', req.line, req.tags);
    } catch (err) {
      return Promise.reject(err);
    }
    return D.tagEdit.delayMs > 0 ? new Promise(function (res) { setTimeout(function () { res(answer); }, D.tagEdit.delayMs); }) : resolve(answer);
  }

  function searchScraps(query, filter) {
    var q = String(query || '').toLowerCase();
    var out = [];
    B.scraps.concat(D.filter.extra.map(function (f) {
      return { filePath: 'C:\\Users\\demo\\Documents\\md-memo\\scraps\\' + f.fileName, fileName: f.fileName, content: f.lines.join('\n') };
    })).forEach(function (f) {
      var lines = f.content.split('\n');
      var matches = [];
      lines.forEach(function (line, i) {
        if (q && line.toLowerCase().indexOf(q) !== -1 && passes(f.fileName, i + 1, filter)) {
          var parts = [];
          if (i > 0) parts.push(lines[i - 1]);
          parts.push(line);
          if (i + 1 < lines.length) parts.push(lines[i + 1]);
          matches.push({ lineNumber: i + 1, lineText: line, snippet: parts.join('\n') });
        }
      });
      if (matches.length) out.push({ filePath: f.filePath, fileName: f.fileName, matches: matches });
    });
    return out;
  }

  // ---- meaning search and deep search (docs/design/deep-search-2026-10.md section 3): fixed answers, knobs on window.__docshot ------------
  // D.semantic: the hits of searchScrapsSemantic (total of them, `limit` of them returned, truncated when there were more), the backend's
  // `notes`, and `reject` (a message: the call rejects with it). D.deep: the plan (dest, consent, sources, stats, notes), the run
  // (reject message, or `hold` to keep the answer pending until D.deep.finish() / cancelDeepSearch, like a slow model).
  D.semantic = { total: 12, notes: [], semantic: true, pending: 0, leftOut: 0, reject: '' };
  D.deep = {
    modelConfigured: true, sources: 3, ignored: 1, masked: 2, semantic: true, notes: [],
    model: 'gemma4:latest', host: 'localhost:11434', local: true, consentGiven: false,
    planReject: '', runReject: '', hold: false, held: null, planSeq: 0,
  };
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // D.semantic.lines: the text of each hit, in order (the manual's pictures use readable ones); otherwise one generic sentence.
  function hitText(i) {
    var lines = D.semantic.lines;
    return lines && lines[i] ? lines[i] : 'Meaning hit ' + (i + 1) + ': bamboo grows fast and can be cut after about three years';
  }
  function semanticHit(i) {
    var name = '2026-09-' + pad2(28 - i) + '.md';
    return {
      filePath: 'C:\\Users\\demo\\Documents\\md-memo\\scraps\\' + name, fileName: name,
      matches: [{
        lineNumber: 3, lineText: hitText(i),
        snippet: hitText(i),
        heading: '2026-09-' + pad2(28 - i) + ' 09:00', headingLine: 1, endLine: 5 + (i % 3),
        score: Number((0.9 - i * 0.02).toFixed(2)), source: 'semantic',
      }],
    };
  }
  // The hits that pass the filter, best first (the filter narrows the notes before the best ones are taken, as the backend does).
  function semanticHits(filter) {
    var hits = [];
    for (var i = 0; i < D.semantic.total; i++) {
      var hit = semanticHit(i);
      if (passes(hit.fileName, hit.matches[0].lineNumber, filter)) hits.push(hit);
    }
    return hits;
  }
  function searchScrapsSemantic(q, limit, filter) {
    if (D.semantic.reject) return Promise.reject(new Error(D.semantic.reject));
    var bad = badFilter(filter);
    if (bad) return Promise.reject(new Error(bad));
    var all = semanticHits(filter), n = Math.min(Number(limit) || 10, all.length);
    return resolve({ semantic: D.semantic.semantic, pending: D.semantic.pending, leftOut: D.semantic.leftOut, truncated: all.length > n, notes: D.semantic.notes.slice(), results: all.slice(0, n) });
  }
  function deepSearchPlan(q, limit, filter) {
    if (D.deep.planReject) return Promise.reject(new Error(D.deep.planReject));
    var bad = badFilter(filter);
    if (bad) return Promise.reject(new Error(bad));
    var hits = semanticHits(filter), n = Math.min(Number(limit) || 10, D.deep.sources, hits.length), sources = [], total = 0;
    for (var i = 0; i < n; i++) {
      var day = hits[i].fileName.slice(0, 10), chars = 800 + i * 10;
      total += chars;
      sources.push({ n: i + 1, label: day + ' 09:00', date: day, rel: day + '.md', chars: chars, start_line: 3, end_line: 5 + (i % 3) });
    }
    return resolve({
      // no note found: plan_id "" and no sources, like the backend
      plan_id: n ? 'p_mock_' + (++D.deep.planSeq) : '', query: String(q || ''), model_configured: D.deep.modelConfigured, semantic: D.deep.semantic,
      notes: D.deep.notes.slice(), sources: sources,
      stats: { used: n, ignored: D.deep.ignored, ai: 0, unreadable: 0, budget: 0, total_chars: total, masked: D.deep.masked },
      est_tokens: Math.round(total / 1.5),
      destination: { model: D.deep.model, host: D.deep.host, local: D.deep.local, consent_key: D.deep.host, consent_given: D.deep.local || D.deep.consentGiven },
    });
  }
  function deepSearchResult(lang) {
    return {
      title: lang === 'ja' ? '深掘り 竹の話' : 'Deep search bamboo',
      markdown: '<!-- md-memo:deepsearch -->\n# ' + (lang === 'ja' ? '深掘り: 竹の話' : 'Deep search: bamboo') + '\n\nBamboo grows fast and can be cut after about three years [1][2]. Used as a building material, it has a small environmental load [2].\n\n## Evidence\n> Bamboo grows fast and can be cut after about three years. [1]\n\n## Sources\n\n1. [2026-09-28 09:00](file:///C:/Users/demo/Documents/md-memo/scraps/2026-09-28.md) — lines 3-5\n2. [2026-09-27 10:15](file:///C:/Users/demo/Documents/md-memo/scraps/2026-09-27.md) — lines 3-6\n',
      stats: { sources: D.deep.sources, cited: 1, unverified: 0, verified: 1, invalid_refs: 0, model: D.deep.model },
    };
  }
  function deepSearchRun(planId, lang) {
    if (D.deep.runReject) return Promise.reject(new Error(D.deep.runReject));
    if (!D.deep.hold) return resolve(deepSearchResult(lang));
    return new Promise(function (res, rej) { D.deep.held = { planId: planId, resolve: res, reject: rej, result: deepSearchResult(lang) }; });
  }
  // The held run answers (a person's wait is over) or fails with a message.
  D.deep.finish = function (errorMessage) {
    var h = D.deep.held;
    if (!h) return false;
    D.deep.held = null;
    if (errorMessage) h.reject(new Error(errorMessage)); else h.resolve(h.result);
    return true;
  };
  function cancelDeepSearch(planId) {
    var h = D.deep.held;
    if (h && h.planId === planId) { D.deep.held = null; h.reject(new Error('cancelled')); }
    return resolve(null);
  }

  // ---- the print panel (print_panel.js): the PDF of the preview, and saving it. window.__docshot.print: the number of pages, `reject` (a
  // message: the preview fails with it), `pickPath` ('' = the Save dialog is cancelled), `saveReject`. The PDF is a blank page (a data: address).
  var BLANK_PDF = 'data:application/pdf;base64,' + btoa(['%PDF-1.1', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj', '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF', ''].join(String.fromCharCode(10)));
  D.print = { pages: 4, reject: '', pickPath: ['C:', 'Users', 'demo', 'Documents', 'note.pdf'].join(String.fromCharCode(92)), saveReject: '', seq: 0, saved: [], closed: 0 };
  // D.print.delays: milliseconds that the next previews take, one per call (a slow answer that a newer request overtakes)
  function printPreview(opts) {
    if (D.print.reject) return Promise.reject(new Error(D.print.reject));
    var n = ++D.print.seq, wait = (D.print.delays || []).length ? D.print.delays.shift() : 0;
    var answer = { url: BLANK_PDF + '#mock' + n, pages: D.print.pages, bytes: 1234 };
    return wait > 0 ? new Promise(function (res) { setTimeout(function () { res(answer); }, wait); }) : resolve(answer);
  }
  function printPickPdfPath() { return resolve(D.print.pickPath); }
  function printSavePdf(opts, path) {
    if (D.print.saveReject) return Promise.reject(new Error(D.print.saveReject));
    D.print.saved.push(path);
    (D.print.requests = D.print.requests || []).push(JSON.parse(JSON.stringify(opts || {}))); // what the engine was asked, to check in tests
    var answer = { path: path, bytes: 1234, pages: D.print.pages };
    var wait = D.print.saveDelay || 0; // milliseconds the write takes (a second call while one runs)
    return wait > 0 ? new Promise(function (res) { setTimeout(function () { res(answer); }, wait); }) : resolve(answer);
  }
  function printPreviewClose() { D.print.closed++; return resolve(null); }
  // A Mac's native print dialog (backend.printSystem): the note's name it was opened with is recorded; it answers after
  // D.print.systemDelay milliseconds with true (printed or saved) or, with D.print.systemReject set, fails with that message.
  D.print.system = [];
  function printSystem(title) {
    D.print.system.push(title);
    if (D.print.systemReject) return Promise.reject(new Error(D.print.systemReject));
    var wait = D.print.systemDelay || 0;
    return wait > 0 ? new Promise(function (res) { setTimeout(function () { res(true); }, wait); }) : resolve(true);
  }

  // ---- Settings > AI Models > Semantic search (js/semantic_settings.js): the index and its state. window.__docshot.semanticIndex:
  // `index` (what the index holds: exists, chunks, files, size_bytes, updated, new_files, changed_files, removed_files, rebuild_needed,
  // corrupt), `updateDelay` (ms; > 0 keeps the update running until it ends or is cancelled), `updateReject` (a message the update fails
  // with), `bigRun` (a run to a host that is not this PC asks first: confirm_required), `updates` (what the screen asked), `statuses`.
  D.semanticIndex = {
    index: { exists: false, chunks: 0, files: 0, size_bytes: 0, updated: '', new_files: 53, changed_files: 0, removed_files: 0, rebuild_needed: false, corrupt: false },
    updateDelay: 0, updateReject: '', bigRun: false, statuses: 0, updates: [], held: null
  };
  function semanticDest(section) {
    var m = (section && section.model) || {}, base = String(m.baseUrl || '').trim();
    var host = base.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    return { host: host || '127.0.0.1:11434', local: !host || /^(localhost|127\.|\[::1\])/.test(host), model: String(m.model || '').trim() };
  }
  function semanticAllowed(section, d) {
    return d.local || !!(section && section.privacy && section.privacy.cloudConsent && section.privacy.cloudConsent[d.host]);
  }
  function semanticStatus(section) {
    D.semanticIndex.statuses++;
    var s = section || { enabled: true, model: { baseUrl: 'http://localhost:11434', model: 'bge-m3' } }, d = semanticDest(s);
    return resolve(Object.assign({
      enabled: s.enabled === true, model: d.model ? 'ollama:' + d.model : '', model_error: d.model ? '' : 'the embedding model is not set',
      destination: d.host, local: d.local, consent_given: semanticAllowed(s, d), scrap_dir: 'C:\Users\demo\Documents\md-memo\scraps',
      index_dir: 'C:\Users\demo\AppData\Roaming\md-memo\index\demo', files_in_folder: 53, index_model: d.model ? 'ollama:' + d.model : '', dim: 1024
    }, D.semanticIndex.index));
  }
  function semanticUpdate(section, rebuild, yes) {
    var s = section || {}, d = semanticDest(s), st = D.semanticIndex;
    st.updates.push({ rebuild: !!rebuild, yes: !!yes, enabled: s.enabled === true, host: d.host, model: d.model });
    if (s.enabled !== true) return Promise.reject(new Error('not_enabled'));
    if (!semanticAllowed(s, d)) return Promise.reject(new Error('consent_required: ' + d.host));
    if (st.updateReject) return Promise.reject(new Error(st.updateReject));
    if (st.bigRun && !d.local && !yes) return Promise.reject(new Error('confirm_required: 1500 chunk texts to ' + d.host));
    var before = st.index.new_files + st.index.changed_files;
    var finish = function () {
      st.index = Object.assign({}, st.index, { exists: true, chunks: 412, files: 53, size_bytes: 3355443, updated: '2026-09-18T10:24:00+09:00', new_files: 0, changed_files: 0, removed_files: 0, rebuild_needed: false, corrupt: false });
      return { files: 53, files_changed: before, files_removed: 0, chunks: 412, chunks_new: before * 8, chunks_reused: 0, embedded: before * 8, seconds: 1.4, rebuilt: !!rebuild, local: d.local, model: d.model };
    };
    if (typeof window.__semanticProgress === 'function') {
      window.__semanticProgress(0, 53, 0, 424);
      window.__semanticProgress(21, 53, 168, 424);
    }
    if (!(st.updateDelay > 0)) return resolve(finish());
    return new Promise(function (res, rej) {
      var timer = setTimeout(function () { st.held = null; res(finish()); }, st.updateDelay);
      st.held = { cancel: function () { clearTimeout(timer); st.held = null; rej(new Error('cancelled')); } };
    });
  }
  function cancelSemanticUpdate() {
    var h = D.semanticIndex.held;
    if (!h) return resolve(false);
    h.cancel();
    return resolve(true);
  }

  // ---- Lessons: a finished agent run becomes a rule the person approves (frontend/js/lessons.js; docs/design/lessons-2026-10.md sections 4.5, 5, 6) ----
  // window.__docshot.lessons: the destination (model, host, local; consent = the host is allowed already - the page saving the answer in
  // config.general.cloudConsent counts too), modelConfigured, rules (what lessonRun proposes; none: true proposes nothing), masked (secrets blanked in
  // the excerpt), count (rules already in the agent's file), full (rules in the file for the 200 limit), files (what lessonsInfo('') lists),
  // planReject / runReject / saveReject / infoReject (a message the call fails with), delayMs (the plan answers late), hold (lessonRun waits until
  // D.lessons.finish(), cancelLesson or expire()). Seen by the tests: plans (the requests), runs, cancels, saved ({ agent, rules }).
  // D.lessons.addCard(opts) puts a card in the task list the way slot_agent.js does when a run ends (status 'failed' | 'completed' | 'canceled' | 'running').
  var LESSONS_DIR = 'C:\\Users\\demo\\AppData\\Roaming\\md-memo\\lessons\\';
  D.lessons = {
    model: 'gemma4:e2b', host: '127.0.0.1:11434', local: true, consent: false, modelConfigured: true,
    rules: ['Do not include ADF.h: the build fails on this machine.', 'Run the build with --no-color: the log is read by a program.'], none: false,
    masked: 1, count: 3, full: 3, planReject: '', runReject: '', saveReject: '', infoReject: '', delayMs: 0, hold: false, held: null,
    plans: [], runs: [], cancels: [], saved: [], planSeq: 0, live: {}, byPlan: {}, cardSeq: 0,
    files: [{ agent: 'claude-code', path: LESSONS_DIR + 'claude-code.md', exists: true, count: 3, applied: 3, skipped: 0, disabled: false }]
  };
  function lessonCharLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function lessonsAgent(name) {
    var n = String(name == null ? '' : name).replace(/^@+/, '');
    return resolveAgent(n) || n;
  }
  function lessonsAllowed() {
    var c = D.savedConfig && D.savedConfig.general && D.savedConfig.general.cloudConsent;
    return D.lessons.local || D.lessons.consent || !!(c && c[D.lessons.host]);
  }
  function lessonsAnswer(value) {
    var copy = JSON.parse(JSON.stringify(value));
    return D.lessons.delayMs > 0 ? new Promise(function (res) { setTimeout(function () { res(copy); }, D.lessons.delayMs); }) : resolve(copy);
  }
  function lessonsRequest(request) {
    var req = request;
    if (typeof req === 'string') { try { req = JSON.parse(req); } catch (e) { req = null; } }
    return req && typeof req === 'object' ? req : null;
  }
  function lessonPlan(request) {
    var req = lessonsRequest(request), L = D.lessons;
    if (L.planReject) return Promise.reject(new Error(L.planReject));
    if (!L.modelConfigured) return Promise.reject(new Error('model_not_configured: no text model is set up'));
    if (!req || !String(req.agent || '').trim()) return Promise.reject(new Error('lessons: the agent is not named'));
    L.plans.push(JSON.parse(JSON.stringify(req)));
    var id = 'lp_mock_' + (++L.planSeq), agent = lessonsAgent(req.agent);
    L.live[id] = true;
    L.byPlan[id] = agent;
    return lessonsAnswer({
      plan_id: id, agent: agent,
      destination: { model: L.model, host: L.host, local: L.local, consent_given: lessonsAllowed() },
      sent: {
        instruction_chars: Math.min(1500, lessonCharLen(req.instruction)), output_chars: Math.min(4000, lessonCharLen(req.output)),
        error_chars: Math.min(800, lessonCharLen(req.error)), note_chars: Math.min(500, lessonCharLen(req.note)), masked: L.masked
      },
      lessons: { exists: L.count > 0, count: L.count }
    });
  }
  function lessonRun(planId) {
    var L = D.lessons;
    L.runs.push(planId);
    if (!L.live[planId]) return Promise.reject(new Error('plan_expired: the prepared text expired'));
    if (L.runReject) return Promise.reject(new Error(L.runReject));
    if (!lessonsAllowed()) return Promise.reject(new Error('consent_required: ' + L.host));
    delete L.live[planId];
    var answer = { agent: L.byPlan[planId], rules: L.none ? [] : L.rules.slice(), model: L.model };
    if (!L.hold) return lessonsAnswer(answer);
    return new Promise(function (res, rej) { L.held = { planId: planId, resolve: res, reject: rej, answer: answer }; });
  }
  // The held run answers (the model's wait is over) or fails with a message.
  D.lessons.finish = function (errorMessage) {
    var h = D.lessons.held;
    if (!h) return false;
    D.lessons.held = null;
    if (errorMessage) h.reject(new Error(errorMessage)); else h.resolve(JSON.parse(JSON.stringify(h.answer)));
    return true;
  };
  // The prepared texts are gone (they live five minutes): the next run is refused with plan_expired.
  D.lessons.expire = function () { D.lessons.live = {}; };
  function cancelLesson(planId) {
    var h = D.lessons.held;
    D.lessons.cancels.push(planId);
    if (h && h.planId === planId) { D.lessons.held = null; h.reject(new Error('cancelled')); }
    return resolve(null);
  }
  function lessonSave(request) {
    var req = lessonsRequest(request), L = D.lessons;
    if (L.saveReject) return Promise.reject(new Error(L.saveReject));
    if (!req || !Array.isArray(req.rules) || !req.rules.length || req.rules.length > 5) return Promise.reject(new Error('lessons: 1 to 5 rules are saved at a time'));
    var rules = req.rules.map(function (r) { return String(r).replace(/\s+/g, ' ').trim(); });
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i] || lessonCharLen(rules[i]) > 300 || /<!--|-->/.test(rules[i])) return Promise.reject(new Error('lessons: a rule is empty, over 300 characters or holds a comment mark'));
    }
    var agent = lessonsAgent(req.agent), entry = L.files.filter(function (f) { return f.agent === agent; })[0];
    if (!entry) { entry = { agent: agent, path: LESSONS_DIR + agent + '.md', exists: true, count: 0, applied: 0, skipped: 0, disabled: false }; L.files.push(entry); }
    var have = (entry.rules = entry.rules || []).map(function (r) { return r.toLowerCase(); });
    var fresh = rules.filter(function (r, k) { return have.indexOf(r.toLowerCase()) === -1 && rules.indexOf(r) === k; });
    if (L.full + fresh.length > 200) return Promise.reject(new Error('too_many: the file would hold more than 200 rules'));
    L.saved.push({ agent: req.agent, rules: rules });
    fresh.forEach(function (r) { entry.rules.push(r); });
    entry.count += fresh.length;
    L.full += fresh.length;
    return lessonsAnswer({ path: entry.path, count: entry.count, added: fresh.length });
  }
  function lessonsInfo(agent) {
    var L = D.lessons;
    if (L.infoReject) return Promise.reject(new Error(L.infoReject));
    var rows = L.files.map(function (f) { return { agent: f.agent, path: f.path, exists: f.exists, count: f.count, applied: f.applied, skipped: f.skipped, disabled: f.disabled }; });
    if (!String(agent || '').trim()) return lessonsAnswer(rows);
    var key = lessonsAgent(agent), one = rows.filter(function (f) { return f.agent === key; })[0];
    return lessonsAnswer(one || { agent: key, path: LESSONS_DIR + key + '.md', exists: false, count: 0, applied: 0, skipped: 0, disabled: false });
  }
  // The text readFileByPath gives for a lessons file the mock lists.
  function lessonsFileText(path) {
    var entry = D.lessons.files.filter(function (f) { return f.path === path; })[0];
    if (!entry) return null;
    var lines = ['# Lessons for ' + entry.agent, '<!-- md-memo lessons: one rule per "- " line. Edit or delete freely; other lines are ignored. -->'];
    (entry.rules && entry.rules.length ? entry.rules : ['Do not include ADF.h: the build fails on this machine. <!-- 2026-10-03 -->']).forEach(function (r) { lines.push('- ' + r); });
    return lines.join('\n') + '\n';
  }
  // opts: id, status, agent, agentKey, instruction, error, output, exitCode, lessonsApplied, lessonsSkipped; noResult: true = a run that never started (no output, no exit code).
  D.lessons.addCard = function (o) {
    o = o || {};
    var id = o.id || 'lesson_card_' + (++D.lessons.cardSeq), status = o.status || 'failed';
    TaskManager.addTask({
      id: id, type: o.type || 'slot', agent: o.agent || 'claude-code', agentKey: o.agentKey || '',
      instruction: o.instruction == null ? 'Fix the failing build of the demo project' : o.instruction, startTime: Date.now() - 9000, onCancel: function () {}
    });
    if (status === 'running') return id;
    var update = { status: status, endTime: Date.now() };
    if (status !== 'canceled') {
      update.error = o.error == null ? (status === 'failed' ? 'Exit Code 1' : '') : o.error;
      if (!o.noResult) {
        update.output = o.output == null ? 'cc1: fatal error: ADF.h: No such file or directory\ncompilation terminated.' : o.output;
        update.exitCode = o.exitCode == null ? (status === 'failed' ? 1 : 0) : o.exitCode;
        if (o.lessonsApplied != null) update.lessonsApplied = o.lessonsApplied;
        if (o.lessonsSkipped != null) update.lessonsSkipped = o.lessonsSkipped;
      }
    }
    TaskManager.updateTask(id, update);
    return id;
  };

  var impl = {
    getAppVersion: function () { return resolve(B.version); },
    getAppInfo: function () {
      return resolve({
        version: B.aboutVersion || B.version, commit: 'a8bfea5', builtAt: '2026-09-18T09:00:00Z', os: 'windows', arch: 'amd64',
        executable: 'C:\\Program Files\\MD-Memo\\md-memo.exe',
        configDir: 'C:\\Users\\demo\\AppData\\Roaming\\md-memo', configFile: 'C:\\Users\\demo\\AppData\\Roaming\\md-memo\\config.json',
        scrapDir: 'C:\\Users\\demo\\Documents\\md-memo\\scraps', signing: 'unsigned'
      });
    },
    getPlatformCapabilities: function () { return resolve({ os: 'win32', nativeImeSwitch: true, tray: true, globalHotkey: true }); },
    getConfig: function () { return resolve(FRESH ? '' : JSON.stringify(B.config)); },
    // (the last config the page saved is kept for the mock backends that act on it, e.g. the cloud consent of the lessons)
    saveConfig: function (json) { try { D.savedConfig = JSON.parse(json); } catch (e) { /* not JSON: nothing to keep */ } return resolve(null); },
    getSession: function () { return resolve(NOSESSION ? '' : JSON.stringify(B.session)); },
    saveSession: function () { return resolve(null); },
    getStartupFile: function () { return resolve(null); },
    scanFolderFiles: function () {
      return resolve(B.workspace.notes).then(function (v) { setTimeout(function () { D.workspaceScanned = true; }, 400); return v; });
    },
    readFileByPath: function (p) {
      var lessonsText = lessonsFileText(p);
      if (lessonsText !== null) return resolve({ path: p, title: String(p).split(/[\\/]/).pop(), content: lessonsText, encoding: 'UTF-8' });
      var n = findNote(p);
      return resolve(n ? { path: n.path, title: n.title, content: n.content, encoding: 'UTF-8' } : { path: p, title: String(p).split(/[\\/]/).pop(), content: '', encoding: 'UTF-8' });
    },
    saveFile: function (p) { return resolve({ path: p, title: String(p).split(/[\\/]/).pop(), success: true }); },
    saveFileAs: function () { return resolve(null); },
    queryLLMAsync: function (reqId) {
      setTimeout(function () { if (window.__onLLMResult) window.__onLLMResult(reqId, D.llmReply, ''); }, 600);
      return resolve(null);
    },
    autocompleteAsync: function (reqId) {
      setTimeout(function () { if (window.__onAutocompleteResult) window.__onAutocompleteResult(reqId, D.ghost || '', ''); }, 40);
      return resolve(null);
    },
    jevPredict: function () { return resolve({ candidates: D.jev || [] }); },
    parseSlotsRPC: function (text, cursor) { return resolve(parseSlots(text, cursor)); },
    runSlotAgentAsync: function (reqId, filePath, text, cursor) {
      D.slotRuns.push({ reqId: reqId, filePath: filePath, cursor: cursor });
      return resolve(null);
    },
    getSlotHoverPeek: function (reqId) { return resolve((D.peek && D.peek[reqId]) || ''); },
    getActiveSlotConfigJSON: function () { return resolve(JSON.stringify(B.slotConfig)); },
    getActiveAgentsConfigStatus: function () { return resolve({ is_external: false, default_agent: 'claude-code' }); },
    checkAgentAvailability: function (name) { return resolve({ available: true, command: name === 'hermes' ? 'ollama' : (name || 'claude') }); },
    detectLLMProvider: function () { return resolve('ollama'); },
    checkOllamaRunning: function () { return resolve(true); },
    checkGitInstalled: function () { return resolve({ installed: true }); },
    getGitRepoStatus: function () { return resolve({ is_git: true, remote_url: 'https://github.com/demo-user/scraps.git' }); },
    testGitRemote: function () { return resolve({ success: true, message: 'ok' }); },
    testDiscordBridgeConnection: function () { return resolve({ botUsername: 'md-memo-demo-bot' }); },
    triggerGitSync: function () { return resolve({ success: true, message: 'up to date' }); },
    searchScraps: function (q, max, filter) {
      var bad = badFilter(filter);
      return bad ? Promise.reject(new Error(bad)) : resolve(searchScraps(q, filter));
    },
    searchScrapsSemantic: searchScrapsSemantic,
    deepSearchPlan: deepSearchPlan,
    scrapFilterOptions: scrapFilterOptions,
    tagEdit: tagEdit,
    lessonPlan: lessonPlan,
    lessonRun: lessonRun,
    cancelLesson: cancelLesson,
    lessonSave: lessonSave,
    lessonsInfo: lessonsInfo,
    deepSearchRun: deepSearchRun,
    cancelDeepSearch: cancelDeepSearch,
    printPreview: printPreview,
    printPickPdfPath: printPickPdfPath,
    printSavePdf: printSavePdf,
    printPreviewClose: printPreviewClose,
    printSystem: printSystem,
    semanticStatus: semanticStatus,
    semanticUpdate: semanticUpdate,
    cancelSemanticUpdate: cancelSemanticUpdate,
    startMobileDrop: function () { return resolve({ qrDataUri: B.qrDataUri, url: B.phoneUrl, idleTimeoutSeconds: 60 }); },
    startMobileDropWithVoice: function () { return resolve({ qrDataUri: B.qrDataUri, url: B.phoneUrl, idleTimeoutSeconds: 60 }); },
    saveAsset: function (dir, ext) { return resolve({ relPath: './assets/pasted-1.' + (ext || 'png'), fileUrl: '' }); },
    importAssetFile: function (dir, name) { return resolve({ relPath: './assets/' + name, fileUrl: '' }); },
    updateGlobalShortcut: function () { return resolve(true); },
    validateCliCommand: function (cmd) { return resolve({ isSafe: true, reason: '', command: cmd }); },
    exportConfig: function () { return resolve(null); },
    importConfig: function () { return resolve(null); },
    // Settings package: the same JSON strings app_pack.go returns. Nothing is written or read; the native
    // file dialogs are represented by the canned answers in the boot data (data/demo.mjs, packDemo).
    packListExportable: function () { return resolve(JSON.stringify(B.pack.list)); },
    packExport: function () { return resolve(JSON.stringify(B.pack.exportResult)); },
    packInspect: function () { return resolve(JSON.stringify(B.pack.inspect)); },
    packImport: function () { return resolve(JSON.stringify(B.pack.importResult)); },
  };

  // Every other backend function exists (the app checks for it) and does nothing.
  var names = ('runCommandFilter runCommandFilterAsync cancelCommandFilter openFile openFolder saveFileAs exportPlainTextAs ' +
    'queryVisionAsync generateImageAsync trimMemory closeWindow minimizeWindow toggleMaximize toggleFullscreen forceQuit openExternal setIMEMode ' +
    'startOllamaService stopOllamaService setupOllamaGemma4Async cancelOllamaSetup generateCliCommandAsync setupGitRemote ' +
    'cancelSlotAgent watchActiveFile unwatchActiveFile getDefaultAgentsConfigYAML getDefaultAgentsConfigMarkdown ' +
    'updateActiveAgentsConfigDefaultAgent exportAgentsConfigFile importAgentsConfigFile openAgentsConfigFile jevExecute ' +
    'jevExecuteAsync jevVerify jevDispatchAgent jevPruneContext setMobileDropSharedText cancelMobileDrop requestMobileDropTunnel ' +
    'openPath revealPath transcribeAudioAsync retryVoiceCacheAsync keepVoiceCache discardVoiceCache meetingRecordingSupported checkMeetingAudioAsync startMeetingRecording stopMeetingRecordingAsync abortMeetingRecording').split(' ');

  var backend = {};
  Object.keys(impl).forEach(function (k) {
    backend[k] = function () { log(k, arguments); return impl[k].apply(null, arguments); };
  });
  names.forEach(function (k) {
    if (!backend[k]) backend[k] = function () { log(k, arguments); return resolve(null); };
  });
  window.backend = backend;

  // ---- helpers for the harness (never used by the app) --------------------------------------------
  // Re-asserts a piece of text that the app clears on a timer, so a picture taken a moment later still has it.
  D.pin = function (selector, text) {
    var el = document.querySelector(selector);
    if (!el) return false;
    var want = text === undefined ? el.textContent : text;
    el.textContent = want;
    var obs = new MutationObserver(function () { if (el.textContent !== want) el.textContent = want; });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    D.pins = (D.pins || []).concat([obs]);
    return true;
  };

  // ---- editor helpers (coordinates are viewport pixels, i.e. picture pixels at scale 1) -------------
  D.editor = function () { return document.getElementById('editor'); };
  D.lineHeight = function () { return parseFloat(getComputedStyle(D.editor()).lineHeight) || 22; };
  D.charXY = function (index) {
    var ed = D.editor();
    var c = window.getCharPixelCoords(index, ed);
    var r = ed.getBoundingClientRect();
    return { x: r.left + c.left - ed.scrollLeft, y: r.top + c.top - ed.scrollTop };
  };
  D.find = function (str, from) { return D.editor().value.indexOf(str, from || 0); };
  D.lineStart = function (line) { // 1-based line number -> offset of its first character
    var lines = D.editor().value.split('\n'), off = 0;
    for (var i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    return off;
  };
  D.lineEnd = function (line) { return D.lineStart(line) + (D.editor().value.split('\n')[line - 1] || '').length; };
  // Rect of the first occurrence of `str` (single line).
  D.textRect = function (str, from) {
    var i = D.find(str, from);
    if (i < 0) return null;
    var a = D.charXY(i), b = D.charXY(i + str.length);
    return { x: a.x, y: a.y, w: Math.max(b.x - a.x, 8), h: D.lineHeight() };
  };
  D.lineRect = function (line) { // rect of the text on a (non-wrapped) line
    var a = D.charXY(D.lineStart(line)), b = D.charXY(D.lineEnd(line));
    return { x: a.x, y: a.y, w: Math.max(b.x - a.x, 8), h: D.lineHeight() };
  };
  D.setCaret = function (start, end) {
    var ed = D.editor();
    ed.focus();
    ed.setSelectionRange(start, end === undefined ? start : end);
    ed.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  };
  // Scroll so that `line` is `linesFromTop` lines below the top of the editor.
  D.scrollToLine = function (line, linesFromTop) {
    var ed = D.editor();
    var g = document.getElementById('line-numbers');
    ed.scrollTop = Math.max(0, (line - 1 - (linesFromTop || 0)) * D.lineHeight());
    ed.dispatchEvent(new Event('scroll'));
    // The line-number gutter is refreshed a moment after an edit; re-sync it once it has its full height.
    setTimeout(function () { if (g) g.scrollTop = ed.scrollTop; }, 300);
  };
  // Crop rectangles (viewport pixels): a band of editor lines around the caret / around a line.
  D.cropCaret = function (before, after, width, x) {
    var p = D.charXY(D.editor().selectionStart), lh = D.lineHeight();
    return { x: x || 0, y: p.y - before * lh, w: width, h: (before + after + 1) * lh };
  };
  D.cropLine = function (line, before, after, width, x) {
    var p = D.charXY(D.lineStart(line)), lh = D.lineHeight();
    return { x: x || 0, y: p.y - before * lh, w: width, h: (before + after + 1) * lh };
  };
  D.ghostRect = function () {
    var s = document.querySelector('#ghost-overlay .ghost-suggestion');
    if (!s || !s.textContent) return null;
    var r = s.getClientRects()[0];
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };

  // Ready = the session is restored and the workspace scan (which feeds the related-note pills) is done.
  D.isReady = function () {
    var tabs = document.querySelectorAll('#tabs-list .tab-item').length;
    var msg = document.getElementById('stat-message');
    return document.readyState === 'complete' && tabs >= 1 && (D.workspaceScanned || NOSESSION) && !(msg && msg.textContent.trim());
  };
})();
