// MD-Memo settings package (export / import): which settings, agent definitions and project skills go
// into one .mdmemopack file, and how an imported package is merged back into the live config.
// The zip itself is written and read by the Go side (window.backend.packListExportable / packExport /
// packInspect / packImport); this file owns the choices and the merge.
//
// Cost model: loading this file only defines functions. The dialog shell is static, hidden markup
// (index.html); its contents are built when it opens and dropped when it closes, so nothing runs at
// start-up or while typing.
(function (global) {
  'use strict';

  // ---- settings sections -------------------------------------------------------------------------
  // The single source of truth for what "General", "AI models" ... mean. Ids are written to the package
  // manifest, so they must not change. The flat scrap_* / git_* keys mirror `scraps` (the Go side reads
  // both) and are just as machine specific, so they travel with it.
  const SYNC_FLAT_KEYS = ['scrap_dir', 'git_sync_enabled', 'git_sync_debounce_seconds', 'git_remote_branch', 'max_pipe_size_mb'];

  const CONFIG_SECTIONS = Object.freeze([
    { id: 'general', keys: ['general'], defaultOn: true, labelKey: 'packSecGeneral', descKey: 'packSecGeneralDesc' },
    { id: 'models', keys: ['text', 'autocomplete', 'vision', 'voice', 'cli', 'image'], defaultOn: true, labelKey: 'packSecModels', descKey: 'packSecModelsDesc' },
    {
      id: 'integration',
      keys: ['action', 'default_agent', 'timeout_seconds', 'hover_peek_enabled', 'ghost_diff_duration_ms', 'autoSelector', 'agents', 'slot_profiles', 'recipes'],
      defaultOn: true, labelKey: 'packSecIntegration', descKey: 'packSecIntegrationDesc'
    },
    { id: 'shortcuts', keys: ['shortcuts'], defaultOn: true, labelKey: 'packSecShortcuts', descKey: 'packSecShortcutsDesc' },
    { id: 'sync', keys: ['scraps'].concat(SYNC_FLAT_KEYS), defaultOn: false, thisPcOnly: true, labelKey: 'packSecSync', descKey: 'packSecSyncDesc' },
    { id: 'other', keys: null, defaultOn: true, labelKey: 'packSecOther', descKey: 'packSecOtherDesc' }
  ].map(Object.freeze));

  const SKILL_ROOTS = ['skills', '.claude/skills', '.gemini/skills', '.codex/skills'];
  const SECRET_WORDS = ['apikey', 'api_key', 'api-key', 'token', 'secret', 'password', 'passwd'];
  const MAX_MERGE_DEPTH = 64;

  let keyToSection = null;

  function sectionDef(id) {
    for (let i = 0; i < CONFIG_SECTIONS.length; i++) if (CONFIG_SECTIONS[i].id === id) return CONFIG_SECTIONS[i];
    return null;
  }

  function sectionOfKey(key) {
    if (!keyToSection) {
      keyToSection = Object.create(null);
      CONFIG_SECTIONS.forEach((s) => { (s.keys || []).forEach((k) => { keyToSection[k] = s.id; }); });
    }
    return keyToSection[key] || 'other';
  }

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function errMessage(e) { return (e && e.message) ? e.message : String(e); }

  // Same words as the Go side. Note "maxTokens" matches too, which is harmless here: the merge rule below
  // only looks at keys whose imported value is an empty string.
  function isSecretKey(name) {
    const s = String(name === null || name === undefined ? '' : name).toLowerCase();
    for (let i = 0; i < SECRET_WORDS.length; i++) if (s.indexOf(SECRET_WORDS[i]) !== -1) return true;
    return false;
  }

  // Only the top-level keys that belong to the given sections, as a deep copy.
  function splitConfig(config, sectionIds) {
    const out = {};
    if (!isObj(config)) return out;
    const want = new Set(sectionIds || []);
    Object.keys(config).forEach((key) => {
      if (key === '__proto__' || config[key] === undefined) return;
      if (want.has(sectionOfKey(key))) out[key] = clone(config[key]);
    });
    return out;
  }

  // Ids of the sections that have at least one value in the config, in display order.
  function sectionsPresent(config) {
    const seen = new Set();
    if (isObj(config)) {
      Object.keys(config).forEach((key) => {
        if (config[key] !== undefined && config[key] !== null) seen.add(sectionOfKey(key));
      });
    }
    return CONFIG_SECTIONS.map((s) => s.id).filter((id) => seen.has(id));
  }

  // What the Go side leaves behind when it strips a secret: an empty string (or an array of them) at, or
  // anywhere below, a secret-named key. Such a value means "not included", never "clear it".
  function isBlankedSecret(v, underSecret) {
    return underSecret && (v === '' || (Array.isArray(v) && v.length > 0 && v.every((x) => x === '')));
  }

  function mergeValue(cur, imp, depth, underSecret) {
    if (depth > MAX_MERGE_DEPTH) throw new Error('The settings are nested too deeply');
    if (isObj(cur) && isObj(imp)) {
      const out = {};
      Object.keys(cur).forEach((k) => { if (k !== '__proto__') out[k] = cur[k]; });
      Object.keys(imp).forEach((k) => {
        const v = imp[k];
        if (k === '__proto__' || v === null || v === undefined) return;
        const secret = underSecret || isSecretKey(k);
        if (isBlankedSecret(v, secret)) return;
        out[k] = mergeValue(own(cur, k), v, depth + 1, secret);
      });
      return out;
    }
    return clone(imp);
  }

  // Returns a new config: for each chosen section, imported values are deep-merged over the current ones
  // (objects merge; arrays and scalars are replaced). A null never overwrites, and neither does a blanked
  // secret (see isBlankedSecret), so a package exported without keys cannot wipe the user's own keys.
  // Sections that were not chosen, and keys the package lacks, keep their current values. `current` is not
  // modified (untouched keys are shared with it).
  function mergeImported(current, imported, sectionIds) {
    const out = {};
    if (isObj(current)) Object.keys(current).forEach((k) => { if (k !== '__proto__') out[k] = current[k]; });
    if (!isObj(imported)) return out;
    const chosen = new Set(sectionIds || []);
    Object.keys(imported).forEach((key) => {
      const v = imported[key];
      if (key === '__proto__' || v === null || v === undefined) return;
      if (!chosen.has(sectionOfKey(key))) return;
      const secret = isSecretKey(key);
      if (isBlankedSecret(v, secret)) return;
      out[key] = mergeValue(isObj(current) ? own(current, key) : undefined, v, 1, secret);
    });
    return out;
  }

  // ---- small pure helpers ------------------------------------------------------------------------
  function formatBytes(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function basename(p) {
    const parts = String(p || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(p || '');
  }

  function parseJSON(raw, what) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error('Empty response from ' + what);
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') return v;
    } catch (e) { /* falls through */ }
    throw new Error('Unreadable response from ' + what);
  }

  function hasApi(b, names) {
    return !!b && names.every((n) => typeof b[n] === 'function');
  }

  function splitSkillId(s) {
    const id = String(s.id || '');
    const rest = id.indexOf('skill:') === 0 ? id.slice(6) : id;
    const cut = rest.lastIndexOf('/');
    return {
      root: s.root || (cut > 0 ? rest.slice(0, cut) : ''),
      name: s.name || (cut >= 0 ? rest.slice(cut + 1) : rest)
    };
  }

  // Skills grouped by root, in the documented root order (unknown roots after them), names sorted.
  function groupSkills(list) {
    const byRoot = new Map();
    (list || []).forEach((s) => {
      if (!byRoot.has(s.root)) byRoot.set(s.root, []);
      byRoot.get(s.root).push(s);
    });
    const roots = SKILL_ROOTS.filter((r) => byRoot.has(r)).concat(Array.from(byRoot.keys()).filter((r) => SKILL_ROOTS.indexOf(r) === -1));
    return roots.map((root) => ({
      root,
      items: byRoot.get(root).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
    }));
  }

  // ---- export: state, selection, list ingestion -----------------------------------------------
  function newExportState(config) {
    return {
      mode: 'export',
      busy: false,
      error: '',
      format: 'pack',
      includeSecrets: false,
      projectHint: '',
      sections: sectionsPresent(config).map((id) => ({ id, checked: !!sectionDef(id).defaultOn })),
      list: { status: 'loading', projectRoot: '', agents: [], skills: [], warnings: [], error: '' }
    };
  }

  function ingestList(list, raw) {
    const r = isObj(raw) ? raw : {};
    list.projectRoot = typeof r.projectRoot === 'string' ? r.projectRoot : '';
    list.agents = (Array.isArray(r.agents) ? r.agents : [])
      .filter((a) => a && typeof a.id === 'string')
      .map((a) => ({ id: a.id, scope: a.scope || a.id.replace(/^agents:/, ''), path: a.path || '', bytes: a.bytes, checked: true }));
    list.skills = (Array.isArray(r.skills) ? r.skills : [])
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => Object.assign(splitSkillId(s), { id: s.id, entry: s.entry || 'dir', files: s.files, bytes: s.bytes, checked: false }));
    list.warnings = (Array.isArray(r.warnings) ? r.warnings : []).filter((w) => typeof w === 'string');
    list.error = '';
    list.status = 'ready';
  }

  function buildExportSelection(st, projectHint) {
    const json = st.format === 'json';
    const sections = st.sections.filter((s) => s.checked).map((s) => s.id);
    return {
      format: json ? 'json' : 'pack',
      projectHint: projectHint || '',
      includeSecrets: !!st.includeSecrets,
      configSections: sections,
      includeConfig: sections.length > 0,
      agents: json ? [] : st.list.agents.filter((a) => a.checked).map((a) => a.id),
      skills: json ? [] : st.list.skills.filter((s) => s.checked).map((s) => s.id)
    };
  }

  function canExport(st) {
    if (!st || st.busy) return false;
    const sections = st.sections.some((s) => s.checked);
    if (st.format === 'json') return sections;
    if (st.list.status === 'loading') return false;
    return sections || st.list.agents.some((a) => a.checked) || st.list.skills.some((s) => s.checked);
  }

  // ---- import: state, selection ----------------------------------------------------------------
  function newImportState(info) {
    const i = isObj(info) ? info : {};
    const manifest = isObj(i.manifest) ? i.manifest : {};
    const legacy = i.legacy === true;
    const items = Array.isArray(i.items) ? i.items : (Array.isArray(manifest.items) ? manifest.items : []);
    const projectRoot = typeof i.projectRoot === 'string' ? i.projectRoot : '';

    const known = (id) => !!sectionDef(id);
    let sectionIds = [];
    const cfgItem = items.find((x) => x && x.kind === 'config');
    if (legacy) {
      sectionIds = CONFIG_SECTIONS.map((s) => s.id).filter((id) => id !== 'other');
    } else if (cfgItem) {
      const fromItem = Array.isArray(cfgItem.sections) ? cfgItem.sections : [];
      sectionIds = (fromItem.length ? fromItem : (Array.isArray(manifest.configSections) ? manifest.configSections : [])).filter(known);
    }

    const agents = items.filter((x) => x && x.kind === 'agents' && typeof x.id === 'string').map((x) => {
      const scope = x.scope || x.id.replace(/^agents:/, '');
      const needsProject = scope === 'project' && !projectRoot;
      return { id: x.id, scope, bytes: x.bytes, exists: !!x.exists, needsProject, disabled: needsProject, checked: !needsProject };
    });
    const skills = items.filter((x) => x && x.kind === 'skill' && typeof x.id === 'string').map((x) => {
      const needsProject = !projectRoot;
      return Object.assign(splitSkillId(x), {
        id: x.id, entry: x.entry || 'dir', files: x.files, bytes: x.bytes, exists: !!x.exists,
        needsProject, disabled: needsProject, checked: !needsProject
      });
    });

    return {
      mode: 'import',
      busy: false,
      error: '',
      projectHint: '',
      packPath: typeof i.packPath === 'string' ? i.packPath : '',
      legacy,
      projectRoot,
      includesSecrets: manifest.includesSecrets === true,
      createdAt: manifest.createdAt || '',
      appVersion: manifest.appVersion || '',
      warnings: (Array.isArray(i.warnings) ? i.warnings : []).filter((w) => typeof w === 'string'),
      sections: sectionIds.map((id) => ({ id, checked: !!sectionDef(id).defaultOn })),
      agents,
      skills
    };
  }

  function buildImportSelection(imp) {
    return {
      config: imp.sections.some((s) => s.checked),
      agents: imp.agents.filter((a) => a.checked && !a.disabled).map((a) => a.id),
      skills: imp.skills.filter((s) => s.checked && !s.disabled).map((s) => s.id)
    };
  }

  function canImport(imp) {
    if (!imp || imp.busy) return false;
    const sel = buildImportSelection(imp);
    return sel.config || sel.agents.length > 0 || sel.skills.length > 0;
  }

  // ---- icons (line SVG, same set of attributes as the rest of the app) ----------------------------
  const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICONS = {
    ok: SVG_OPEN + '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    warn: SVG_OPEN + '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: SVG_OPEN + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    pack: SVG_OPEN + '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
  };

  // ---- the dialog ------------------------------------------------------------------------------
  // deps: { doc, keyTarget, getBackend(), host() } where host() -> { getConfig, getProjectHint, applyConfig,
  // refreshAgents?, t, showMessage }. Everything the dialog needs from the app arrives through these.
  function createDialog(deps) {
    const doc = deps.doc;
    const keyTarget = deps.keyTarget || global;
    const getBackend = deps.getBackend || (() => global.backend);
    const HOST = () => deps.host();

    let els = null;
    let st = null;
    let token = 0;
    let opener = null;
    let keyHandler = null;
    let inspecting = false;
    let updaters = [];
    let listUpdaters = [];
    let ui = {};

    const t = (key) => {
      const host = HOST();
      return host && host.t ? host.t(key) : key;
    };
    // Untrusted text (paths, skill names, error messages) is substituted with a function so a "$&" in it
    // is never treated as a replacement pattern.
    const tf = (key, params) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));

    function h(tag, cls, text) {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined && text !== null && text !== '') el.textContent = text;
      return el;
    }

    function icon(name) {
      const span = h('span', 'pack-icon is-' + name);
      span.innerHTML = ICONS[name] || '';
      return span;
    }

    function filesText(n) {
      return tf(n === 1 ? 'packFilesOne' : 'packFilesMany', { count: n });
    }

    function sizeSub(item) {
      const parts = [];
      if (item.entry === 'file') parts.push(t('packSkillSingleFile'));
      else if (typeof item.files === 'number') parts.push(filesText(item.files));
      const size = formatBytes(item.bytes);
      if (size) parts.push(size);
      return parts.join(' · ');
    }

    function grab() {
      if (els) return els;
      const id = (x) => doc.getElementById(x);
      const found = { modal: id('pack-modal'), title: id('pack-title'), body: id('pack-body'), confirm: id('pack-confirm'), cancel: id('pack-cancel'), close: id('pack-close') };
      if (!found.modal || !found.title || !found.body || !found.confirm || !found.cancel || !found.close) {
        throw new Error('The package dialog markup is missing from the page');
      }
      found.close.addEventListener('click', cancel);
      found.cancel.addEventListener('click', cancel);
      found.confirm.addEventListener('click', confirm);
      found.modal.addEventListener('mousedown', (e) => { if (e.target === found.modal) cancel(); });
      els = found;
      return els;
    }

    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      cancel();
    }

    function show() {
      const e = grab();
      opener = doc.activeElement || null;
      e.close.setAttribute('aria-label', t('packBtnClose'));
      e.modal.classList.remove('hidden');
      if (!keyHandler) {
        keyHandler = onKey;
        keyTarget.addEventListener('keydown', keyHandler, true);
      }
    }

    function hide() {
      token++;
      if (keyHandler) {
        keyTarget.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
      }
      if (els) {
        els.modal.classList.add('hidden');
        els.body.textContent = '';
      }
      st = null;
      updaters = [];
      listUpdaters = [];
      ui = {};
      const back = opener;
      opener = null;
      if (back && typeof back.focus === 'function') {
        try { back.focus(); } catch (e) { /* the opener may be gone */ }
      }
    }

    function cancel() {
      if (!st || st.busy) return;
      hide();
    }

    // ---- shared building blocks ----
    function banner(kind, text) {
      const el = h('div', 'pack-note is-' + kind);
      el.appendChild(icon(kind));
      el.appendChild(h('span', 'pack-note-text', text));
      return el;
    }

    function errorSlot() {
      const el = h('div', 'pack-note is-err hidden');
      el.setAttribute('role', 'alert');
      const text = h('span', 'pack-note-text');
      el.appendChild(icon('warn'));
      el.appendChild(text);
      return { el, text };
    }

    function group(title, hint) {
      const box = h('div', 'pack-group');
      const head = h('div', 'settings-section-header pack-group-head');
      head.appendChild(h('h4', '', title));
      box.appendChild(head);
      if (hint) box.appendChild(h('div', 'pack-group-hint', hint));
      return { box, head };
    }

    // "All / None" links; `offWhen` greys them out while the group is inert (JSON format).
    function bulk(parent, onAll, onNone, offWhen, list) {
      const wrap = h('span', 'pack-bulk');
      const mk = (key, fn) => {
        const b = h('button', 'pack-link', t(key));
        b.type = 'button';
        b.addEventListener('click', () => { fn(); sync(); });
        wrap.appendChild(b);
        return b;
      };
      const all = mk('packBtnAll', onAll);
      const none = mk('packBtnNone', onNone);
      parent.appendChild(wrap);
      if (offWhen) {
        list.push(() => {
          const off = offWhen();
          all.disabled = off;
          none.disabled = off;
        });
      }
    }

    // A checkbox row. `item` supplies the state (checked / disabled); sync() keeps the DOM equal to it.
    function checkRow(item, o, updateList) {
      const row = h('label', 'pack-row');
      const input = h('input');
      input.type = 'checkbox';
      if (o.inputId) input.id = o.inputId;
      const main = h('span', 'pack-row-main');
      main.appendChild(h('span', 'pack-row-title', o.title));
      if (o.sub) main.appendChild(h('span', 'pack-row-sub', o.sub));
      row.appendChild(input);
      row.appendChild(main);
      (o.tags || []).forEach((tag) => row.appendChild(h('span', 'pack-tag is-' + (tag.kind || 'muted'), tag.text)));
      input.addEventListener('change', () => {
        item.checked = input.checked;
        sync();
      });
      const upd = () => {
        input.checked = !!item.checked;
        const off = !!item.disabled || (o.offWhen ? o.offWhen() : false);
        input.disabled = off;
        row.classList.toggle('is-disabled', off);
      };
      (updateList || updaters).push(upd);
      if (!ui.firstInput && !item.disabled) ui.firstInput = input;
      return row;
    }

    // Skills, grouped by root, each root with its own all / none.
    function skillGroups(list, title, opts) {
      const g = group(title, opts.hint);
      if (opts.warn) g.box.appendChild(banner('warn', opts.warn));
      if (!list.length) {
        g.box.appendChild(h('div', 'pack-empty', opts.empty));
        return g.box;
      }
      groupSkills(list).forEach((grp) => {
        const box = h('div', 'pack-list');
        const sub = h('div', 'pack-subhead');
        sub.appendChild(h('span', 'pack-subhead-name', grp.root));
        const count = h('span', 'pack-subhead-count');
        sub.appendChild(count);
        const setAll = (val) => () => { grp.items.forEach((s) => { if (!s.disabled) s.checked = val; }); };
        bulk(sub, setAll(true), setAll(false), () => (opts.offWhen ? opts.offWhen() : false) || grp.items.every((s) => s.disabled), listUpdaters);
        box.appendChild(sub);
        grp.items.forEach((s) => {
          const tags = [];
          if (s.exists && !s.needsProject) tags.push({ text: t('packTagOverwrite'), kind: 'warn' });
          if (s.needsProject) tags.push({ text: t('packTagNeedsProject'), kind: 'muted' });
          box.appendChild(checkRow(s, { title: s.name, sub: sizeSub(s), tags, offWhen: opts.offWhen }, listUpdaters));
        });
        listUpdaters.push(() => {
          const n = grp.items.filter((s) => s.checked && !s.disabled).length;
          count.textContent = n + ' / ' + grp.items.length;
        });
        g.box.appendChild(box);
      });
      return g.box;
    }

    function setFooter(confirmText, showConfirm, cancelText) {
      const e = grab();
      e.confirm.textContent = confirmText || '';
      e.confirm.classList.toggle('hidden', !showConfirm);
      e.cancel.textContent = cancelText;
    }

    function sync() {
      if (!st) return;
      updaters.forEach((fn) => fn());
      listUpdaters.forEach((fn) => fn());
      const e = grab();
      if (st.mode === 'export') {
        const json = st.format === 'json';
        e.confirm.disabled = !canExport(st);
        e.confirm.textContent = st.busy ? t('packBtnExporting') : t('packBtnExport');
        if (ui.formatHint) ui.formatHint.classList.toggle('hidden', !json);
        if (ui.listBox) ui.listBox.classList.toggle('is-off', json);
      } else if (st.mode === 'import') {
        e.confirm.disabled = !canImport(st);
        e.confirm.textContent = st.busy ? t('packBtnImporting') : t('packBtnImport');
      }
      e.cancel.disabled = !!st.busy;
      e.close.disabled = !!st.busy;
      if (ui.error) {
        ui.error.text.textContent = st.error || '';
        ui.error.el.classList.toggle('hidden', !st.error);
      }
      e.body.setAttribute('aria-busy', st.busy ? 'true' : 'false');
    }

    function focusFirst() {
      const target = ui.firstInput || (els && els.confirm);
      if (target && typeof target.focus === 'function') {
        try { target.focus(); } catch (e) { /* not focusable yet */ }
      }
    }

    // ---- export ----
    function sectionRows() {
      const box = h('div', 'pack-list');
      st.sections.forEach((s) => {
        const def = sectionDef(s.id);
        const tags = def.thisPcOnly ? [{ text: t('packTagThisPc'), kind: 'muted' }] : [];
        box.appendChild(checkRow(s, { title: t(def.labelKey), sub: t(def.descKey), tags }));
      });
      return box;
    }

    function setAllSections(val) {
      return () => st.sections.forEach((s) => { s.checked = val; });
    }

    function buildExport() {
      const e = grab();
      e.title.textContent = t('packExportTitle');
      e.body.textContent = '';
      updaters = [];
      listUpdaters = [];
      ui = {};

      ui.error = errorSlot();
      e.body.appendChild(ui.error.el);

      const fmt = h('div', 'form-group');
      const lab = h('label', '', t('packFormatLabel'));
      lab.setAttribute('for', 'pack-format');
      const sel = h('select', 'form-select');
      sel.id = 'pack-format';
      [['pack', 'packFormatPack'], ['json', 'packFormatJson']].forEach((pair) => {
        const o = h('option', '', t(pair[1]));
        o.value = pair[0];
        sel.appendChild(o);
      });
      sel.value = st.format;
      sel.addEventListener('change', () => {
        st.format = sel.value === 'json' ? 'json' : 'pack';
        sync();
      });
      ui.formatHint = h('small', '', t('packFormatJsonHint'));
      fmt.appendChild(lab);
      fmt.appendChild(sel);
      fmt.appendChild(ui.formatHint);
      e.body.appendChild(fmt);

      const gSet = group(t('packGroupSettings'), t('packGroupSettingsHint'));
      if (st.sections.length) {
        bulk(gSet.head, setAllSections(true), setAllSections(false));
        gSet.box.appendChild(sectionRows());
      } else {
        gSet.box.appendChild(h('div', 'pack-empty', t('packNoSettings')));
      }
      e.body.appendChild(gSet.box);

      ui.listBox = h('div', 'pack-listbox');
      e.body.appendChild(ui.listBox);
      fillList();

      const gOpt = group(t('packGroupOptions'));
      const keys = { get checked() { return st.includeSecrets; }, set checked(v) { st.includeSecrets = v; } };
      const keyRow = checkRow(keys, { title: t('packIncludeKeys'), sub: t('packIncludeKeysWarn'), inputId: 'pack-include-keys' });
      const keyBox = h('div', 'pack-list');
      keyBox.appendChild(keyRow);
      gOpt.box.appendChild(keyBox);
      updaters.push(() => keyRow.classList.toggle('is-warn', !!st.includeSecrets));
      e.body.appendChild(gOpt.box);
      setFooter(t('packBtnExport'), true, t('btnCancel'));
    }

    // The agent-definition and skill groups: rebuilt when the project scan comes back.
    function fillList() {
      if (!ui.listBox || !st) return;
      const box = ui.listBox;
      box.textContent = '';
      listUpdaters = [];
      const list = st.list;
      const off = () => st.format === 'json';

      if (list.status === 'loading') {
        box.appendChild(h('div', 'pack-empty', t('packScanning')));
        return;
      }
      if (list.status === 'error') {
        box.appendChild(banner('warn', tf('packScanFailed', { err: list.error })));
        return;
      }

      if (!list.projectRoot) box.appendChild(banner('info', t('packNoProjectHint')));

      const gAg = group(t('packGroupAgents'), list.projectRoot ? tf('packProjectLine', { path: list.projectRoot }) : '');
      if (list.agents.length) {
        const setAgents = (val) => () => list.agents.forEach((a) => { a.checked = val; });
        bulk(gAg.head, setAgents(true), setAgents(false), off, listUpdaters);
        const ab = h('div', 'pack-list');
        list.agents.forEach((a) => {
          const size = formatBytes(a.bytes);
          const sub = [a.path, size].filter(Boolean).join(' · ');
          ab.appendChild(checkRow(a, { title: t(a.scope === 'project' ? 'packAgentProject' : 'packAgentApp'), sub, offWhen: off }, listUpdaters));
        });
        gAg.box.appendChild(ab);
      } else {
        gAg.box.appendChild(h('div', 'pack-empty', t('packNoAgents')));
      }
      box.appendChild(gAg.box);

      const gSk = skillGroups(list.skills, t('packGroupSkills'), {
        empty: list.projectRoot ? t('packNoSkills') : t('packNoSkillsNoProject'),
        offWhen: off
      });
      box.appendChild(gSk);

      list.warnings.slice(0, 5).forEach((w) => box.appendChild(banner('warn', w)));
      if (list.warnings.length > 5) box.appendChild(h('div', 'pack-empty', tf('packMoreWarnings', { count: list.warnings.length - 5 })));
    }

    async function openExport() {
      if (st) return;
      const host = HOST();
      const b = getBackend();
      try {
        grab();
      } catch (e) {
        host.showMessage(errMessage(e), 4000);
        return;
      }
      const mine = ++token;
      if (!hasApi(b, ['packListExportable', 'packExport'])) {
        openUnavailable('packExportTitle');
        return;
      }
      st = newExportState(host.getConfig());
      buildExport();
      show();
      sync();
      focusFirst();

      let hint = '';
      try { hint = (await host.getProjectHint()) || ''; } catch (e) { hint = ''; }
      if (mine !== token || !st) return;
      st.projectHint = hint;
      try {
        ingestList(st.list, parseJSON(await b.packListExportable(hint), 'packListExportable'));
      } catch (e) {
        if (mine !== token || !st) return;
        st.list.status = 'error';
        st.list.error = errMessage(e);
      }
      if (mine !== token || !st) return;
      fillList();
      sync();
    }

    async function confirmExport() {
      if (!canExport(st)) return;
      const host = HOST();
      const b = getBackend();
      const mine = token;
      const sel = buildExportSelection(st, st.projectHint);
      const cfg = splitConfig(host.getConfig(), sel.configSections);
      st.busy = true;
      st.error = '';
      sync();
      let res;
      try {
        res = parseJSON(await b.packExport(JSON.stringify(sel), JSON.stringify(cfg)), 'packExport');
        if (res.ok === false && !res.cancelled) throw new Error(res.error || res.message || 'Export failed');
      } catch (e) {
        if (mine !== token || !st) return;
        st.busy = false;
        st.error = tf('packExportFailed', { err: errMessage(e) });
        sync();
        return;
      }
      if (mine !== token || !st) return;
      st.busy = false;
      if (res.cancelled) {
        sync();
        return;
      }
      showResult(exportResult(res, sel));
      host.showMessage(tf(sel.format === 'json' ? 'packExportToastJson' : 'packExportToast', { name: basename(res.path) }), 5000);
    }

    function exportResult(res, sel) {
      const c = res.counts || {};
      const lines = [];
      lines.push({ kind: 'ok', text: t(sel.format === 'json' ? 'packExportSavedJson' : 'packExportSaved'), subs: [res.path || ''] });
      if (sel.includeConfig) {
        lines.push({ kind: 'plain', text: tf('packResultSettings', { sections: sel.configSections.map((id) => t(sectionDef(id).labelKey)).join(', ') }) });
      }
      if (c.agents) lines.push({ kind: 'plain', text: tf('packResultAgents', { count: c.agents }) });
      if (c.skills) lines.push({ kind: 'plain', text: tf('packResultSkills', { count: c.skills }) });
      if (typeof c.files === 'number' || typeof c.bytes === 'number') {
        const parts = [];
        if (typeof c.files === 'number') parts.push(filesText(c.files));
        const size = formatBytes(c.bytes);
        if (size) parts.push(size);
        lines.push({ kind: 'plain', text: tf('packResultSize', { size: parts.join(', ') }) });
      }
      if (sel.includeSecrets) {
        lines.push({ kind: 'warn', text: t('packResultKeysIncluded') });
      } else if (res.secretsStripped > 0) {
        lines.push({ kind: 'info', text: tf('packResultSecretsLeftOut', { count: res.secretsStripped }) });
      }
      if (res.secretWarnings > 0) lines.push({ kind: 'warn', text: tf('packResultSecretWarnings', { count: res.secretWarnings }) });
      (Array.isArray(res.warnings) ? res.warnings : []).filter((w) => typeof w === 'string').slice(0, 5)
        .forEach((w) => lines.push({ kind: 'warn', text: w }));
      return { title: t('packResultTitleExport'), lines };
    }

    // ---- import ----
    function buildImport() {
      const e = grab();
      const imp = st;
      e.title.textContent = t('packImportTitle');
      e.body.textContent = '';
      updaters = [];
      listUpdaters = [];
      ui = {};

      ui.error = errorSlot();
      e.body.appendChild(ui.error.el);

      const src = h('div', 'pack-source');
      src.appendChild(icon('pack'));
      const main = h('div', 'pack-source-main');
      const name = h('div', 'pack-source-name', basename(imp.packPath) || t('packUnnamed'));
      if (imp.packPath) name.title = imp.packPath;
      main.appendChild(name);
      const metaBits = [];
      if (imp.createdAt) {
        const d = new Date(imp.createdAt);
        metaBits.push(isNaN(d.getTime()) ? String(imp.createdAt) : d.toLocaleString());
      }
      if (imp.appVersion) metaBits.push('MD-Memo ' + imp.appVersion);
      if (metaBits.length) main.appendChild(h('div', 'pack-row-sub', metaBits.join(' · ')));
      src.appendChild(main);
      e.body.appendChild(src);

      if (imp.legacy) e.body.appendChild(banner('info', t('packLegacyNote')));
      else if (imp.includesSecrets) e.body.appendChild(banner('warn', t('packIncludesKeysNote')));
      else e.body.appendChild(banner('info', t('packNoKeysNote')));
      imp.warnings.slice(0, 5).forEach((w) => e.body.appendChild(banner('warn', w)));

      const needsProject = imp.agents.some((a) => a.needsProject) || imp.skills.some((s) => s.needsProject);
      if (needsProject) e.body.appendChild(banner('info', t('packNoProjectHint')));

      if (imp.sections.length) {
        const g = group(t('packGroupSettings'));
        bulk(g.head, setAllSections(true), setAllSections(false));
        g.box.appendChild(sectionRows());
        e.body.appendChild(g.box);
      }

      if (imp.agents.length) {
        const g = group(t('packGroupAgents'), imp.projectRoot ? tf('packProjectLine', { path: imp.projectRoot }) : '');
        g.box.appendChild(banner('warn', t('packAgentsWarn')));
        const box = h('div', 'pack-list');
        imp.agents.forEach((a) => {
          const tags = [];
          if (a.exists && !a.needsProject) tags.push({ text: t('packTagOverwrite'), kind: 'warn' });
          if (a.needsProject) tags.push({ text: t('packTagNeedsProject'), kind: 'muted' });
          box.appendChild(checkRow(a, { title: t(a.scope === 'project' ? 'packAgentProject' : 'packAgentApp'), sub: formatBytes(a.bytes), tags }));
        });
        g.box.appendChild(box);
        e.body.appendChild(g.box);
      }

      if (imp.skills.length) {
        e.body.appendChild(skillGroups(imp.skills, t('packGroupSkills'), { warn: t('packSkillsWarn'), empty: '' }));
      }

      if (imp.agents.some((a) => a.exists) || imp.skills.some((s) => s.exists)) {
        e.body.appendChild(h('div', 'pack-footnote', t('packBackupNote')));
      }
      if (!imp.sections.length && !imp.agents.length && !imp.skills.length) {
        e.body.appendChild(h('div', 'pack-empty', t('packNothingInPackage')));
      }
      setFooter(t('packBtnImport'), true, t('btnCancel'));
    }

    async function openImport() {
      if (st || inspecting) return;
      const host = HOST();
      const b = getBackend();
      try {
        grab();
      } catch (e) {
        host.showMessage(errMessage(e), 4000);
        return;
      }
      const mine = ++token;
      if (!hasApi(b, ['packInspect', 'packImport'])) {
        openUnavailable('packImportTitle');
        return;
      }
      inspecting = true;
      let info;
      let hint = '';
      try {
        try { hint = (await host.getProjectHint()) || ''; } catch (e) { hint = ''; }
        info = parseJSON(await b.packInspect(hint), 'packInspect');
      } catch (e) {
        inspecting = false;
        host.showMessage(tf('packImportFailed', { err: errMessage(e) }), 6000);
        return;
      }
      inspecting = false;
      if (mine !== token || st) return;
      if (info.cancelled) return;
      st = newImportState(info);
      st.projectHint = hint;
      buildImport();
      show();
      sync();
      focusFirst();
    }

    async function confirmImport() {
      if (!canImport(st)) return;
      const host = HOST();
      const b = getBackend();
      const mine = token;
      const imp = st;
      const sel = buildImportSelection(imp);
      const chosen = imp.sections.filter((s) => s.checked).map((s) => s.id);
      imp.busy = true;
      imp.error = '';
      sync();
      let res;
      try {
        res = parseJSON(await b.packImport(imp.packPath, JSON.stringify(sel), imp.projectHint), 'packImport');
        if (res.ok === false) throw new Error(res.error || res.message || 'Import failed');
      } catch (e) {
        if (mine !== token || !st) return;
        imp.busy = false;
        imp.error = tf('packImportFailed', { err: errMessage(e) });
        sync();
        return;
      }
      if (mine !== token || !st) return;

      let cfgResult = null;
      if (sel.config && typeof res.configJSON === 'string' && res.configJSON.trim() !== '') {
        try {
          const imported = JSON.parse(res.configJSON);
          const applied = sectionsPresent(imported).filter((id) => chosen.indexOf(id) !== -1);
          if (applied.length) await host.applyConfig(mergeImported(host.getConfig(), imported, chosen));
          cfgResult = { sections: applied };
        } catch (e) {
          cfgResult = { error: errMessage(e) };
        }
      }
      if (mine !== token || !st) return;

      const applied = res.applied || {};
      const appliedAgents = Array.isArray(applied.agents) ? applied.agents : [];
      const appliedSkills = Array.isArray(applied.skills) ? applied.skills : [];
      if (appliedAgents.length && host.refreshAgents) {
        try { host.refreshAgents(); } catch (e) { /* the status line is cosmetic */ }
      }
      showResult(importResult(res, cfgResult, appliedAgents, appliedSkills));
      host.showMessage(tf('packImportToast', { name: basename(imp.packPath) }), 5000);
    }

    function labelOfId(id) {
      if (id === 'config') return t('packGroupSettings');
      if (id === 'agents:app') return t('packAgentApp');
      if (id === 'agents:project') return t('packAgentProject');
      return String(id).replace(/^skill:/, '');
    }

    function importResult(res, cfgResult, agents, skills) {
      const lines = [];
      if (cfgResult && cfgResult.error) {
        lines.push({ kind: 'warn', text: tf('packResultConfigFailed', { err: cfgResult.error }) });
      } else if (cfgResult && cfgResult.sections.length) {
        lines.push({ kind: 'ok', text: tf('packResultConfig', { sections: cfgResult.sections.map((id) => t(sectionDef(id).labelKey)).join(', ') }) });
      } else if (cfgResult) {
        lines.push({ kind: 'info', text: t('packResultConfigNone') });
      }
      if (agents.length) {
        lines.push({ kind: 'ok', text: tf('packResultAgentsWritten', { count: agents.length }), subs: agents.map((a) => a.path).filter(Boolean) });
      }
      if (skills.length) {
        const files = skills.reduce((n, s) => n + (typeof s.files === 'number' ? s.files : 0), 0);
        const names = skills.map((s) => String(s.id || '').replace(/^skill:/, '')).filter(Boolean);
        const shown = names.slice(0, 8);
        if (names.length > shown.length) shown.push(tf('packAndMore', { count: names.length - shown.length }));
        lines.push({ kind: 'ok', text: tf('packResultSkillsWritten', { count: skills.length, files: filesText(files) }), subs: [shown.join(', ')] });
      }
      (Array.isArray(res.skipped) ? res.skipped : []).forEach((s) => {
        if (s && s.id) lines.push({ kind: 'warn', text: tf('packResultSkipped', { name: labelOfId(s.id), reason: s.reason || '' }) });
      });
      if (res.backupDir) lines.push({ kind: 'info', text: t('packResultBackup'), subs: [res.backupDir] });
      if (res.needsRestart) lines.push({ kind: 'info', text: t('packResultRestart') });
      if (!lines.some((l) => l.kind === 'ok')) lines.unshift({ kind: 'info', text: t('packResultNothing') });
      return { title: t('packResultTitleImport'), lines };
    }

    // ---- result and unavailable panels ----
    function showResult(result) {
      const e = grab();
      st = { mode: 'result', busy: false, error: '' };
      updaters = [];
      listUpdaters = [];
      ui = {};
      e.title.textContent = result.title;
      e.body.textContent = '';
      result.lines.forEach((line) => {
        const row = h('div', 'pack-result-line is-' + line.kind);
        row.appendChild(line.kind === 'plain' ? h('span', 'pack-icon-spacer') : icon(line.kind));
        const text = h('div', 'pack-result-text');
        text.appendChild(h('div', '', line.text));
        (line.subs || []).forEach((s) => text.appendChild(h('div', 'pack-row-sub pack-selectable', s)));
        row.appendChild(text);
        e.body.appendChild(row);
      });
      setFooter('', false, t('packBtnClose'));
      e.cancel.disabled = false;
      e.close.disabled = false;
      e.body.setAttribute('aria-busy', 'false');
      ui.firstInput = e.cancel;
      const mine = token;
      // Applying settings re-opens the Settings dialog, which moves focus; take it back afterwards.
      setTimeout(() => { if (mine === token && st) focusFirst(); }, 80);
    }

    function openUnavailable(titleKey) {
      const e = grab();
      st = { mode: 'unavailable', busy: false, error: '' };
      updaters = [];
      listUpdaters = [];
      ui = {};
      e.title.textContent = t(titleKey);
      e.body.textContent = '';
      e.body.appendChild(banner('warn', t('packUnavailable')));
      setFooter('', false, t('packBtnClose'));
      e.cancel.disabled = false;
      e.close.disabled = false;
      show();
      ui.firstInput = e.cancel;
      focusFirst();
    }

    function confirm() {
      if (!st || st.busy) return undefined;
      if (st.mode === 'export') return confirmExport();
      if (st.mode === 'import') return confirmImport();
      return undefined;
    }

    return { openExport, openImport, cancel, confirm };
  }

  // ---- public entry points (used by app.js) ------------------------------------------------------
  let hostRef = null;
  let dialog = null;

  function getDialog(host) {
    if (host) hostRef = host;
    if (!dialog) {
      dialog = createDialog({ doc: global.document, keyTarget: global, getBackend: () => global.backend, host: () => hostRef });
    }
    return dialog;
  }

  function run(host, fn) {
    return Promise.resolve().then(() => fn(getDialog(host))).catch((e) => {
      if (hostRef && hostRef.showMessage) hostRef.showMessage(errMessage(e), 6000);
    });
  }

  function openExport(host) { return run(host, (d) => d.openExport()); }
  function openImport(host) { return run(host, (d) => d.openImport()); }

  const api = {
    CONFIG_SECTIONS,
    SKILL_ROOTS,
    splitConfig,
    sectionsPresent,
    sectionOfKey,
    isSecretKey,
    mergeImported,
    groupSkills,
    formatBytes,
    newExportState,
    ingestList,
    buildExportSelection,
    canExport,
    newImportState,
    buildImportSelection,
    canImport,
    createDialog,
    openExport,
    openImport
  };

  global.ConfigPack = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
