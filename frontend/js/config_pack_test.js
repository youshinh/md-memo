// Unit tests for config_pack.js (settings package export / import): the pure helpers, and the dialog
// driven against a hand-made DOM and a mocked window.backend.
const assert = require('assert');

const CP = require('./config_pack.js');

let pending = Promise.resolve();
function test(name, fn) {
  pending = pending.then(async () => {
    try {
      await fn();
      console.log('PASS: ' + name);
    } catch (e) {
      console.error('FAIL: ' + name);
      throw e;
    }
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms || 0));
// Let every already-resolved promise chain in the dialog run.
async function settle() { for (let i = 0; i < 6; i++) await wait(0); }

// ---- a minimal DOM: just what the dialog touches ---------------------------------------------------
class FakeEl {
  constructor(doc, tag) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.handlers = {};
    this._text = '';
    this.className = '';
    this.id = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.htmlWrites = [];
    const el = this;
    this.classList = {
      _set() { return new Set(el.className.split(/\s+/).filter(Boolean)); },
      _put(s) { el.className = Array.from(s).join(' '); },
      add(...c) { const s = this._set(); c.forEach((x) => s.add(x)); this._put(s); },
      remove(...c) { const s = this._set(); c.forEach((x) => s.delete(x)); this._put(s); },
      contains(c) { return this._set().has(c); },
      toggle(c, force) {
        const s = this._set();
        const want = force === undefined ? !s.has(c) : !!force;
        if (want) s.add(c); else s.delete(c);
        this._put(s);
        return want;
      }
    };
  }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(v) { this.htmlWrites.push(String(v)); }
  get innerHTML() { return this.htmlWrites.length ? this.htmlWrites[this.htmlWrites.length - 1] : ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn); }
  fire(type, ev) {
    const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, ev || {});
    (this.handlers[type] || []).slice().forEach((fn) => fn(e));
  }
  focus() { this.doc.activeElement = this; }
  // Real browsers toggle a checkbox and fire "change"; a button just fires "click".
  click() {
    if (this.disabled) return;
    if (this.type === 'checkbox') {
      this.checked = !this.checked;
      this.fire('change');
    } else {
      this.fire('click');
    }
  }
  choose(value) { this.value = value; this.fire('change'); }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk(fn)); }
  find(pred) { let hit = null; this.walk((n) => { if (!hit && pred(n)) hit = n; }); return hit; }
  findAll(pred) { const out = []; this.walk((n) => { if (pred(n)) out.push(n); }); return out; }
  hasClass(c) { return this.classList.contains(c); }
}

function makeDoc() {
  const doc = { activeElement: null };
  doc.createElement = (tag) => new FakeEl(doc, tag);
  doc.root = doc.createElement('div');
  doc.getElementById = (id) => doc.root.find((n) => n.id === id);
  const add = (parent, tag, id, cls) => {
    const el = doc.createElement(tag);
    el.id = id || '';
    el.className = cls || '';
    parent.appendChild(el);
    return el;
  };
  const modal = add(doc.root, 'div', 'pack-modal', 'modal-backdrop hidden');
  const card = add(modal, 'div', '', 'modal-card');
  const head = add(card, 'div', '', 'modal-header');
  add(head, 'h3', 'pack-title');
  add(head, 'button', 'pack-close', 'btn-icon');
  add(card, 'div', 'pack-body', 'modal-body');
  const foot = add(card, 'div', '', 'modal-footer');
  add(foot, 'button', 'pack-confirm', 'btn-primary');
  add(foot, 'button', 'pack-cancel', 'btn-secondary');
  doc.opener = add(doc.root, 'button', 'btn-export-settings');
  return doc;
}

// The English dictionary, evaluated straight from i18n.js, so the tests use the real strings.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const i18nCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '; this.I18N = I18N;', i18nCtx);
const EN = i18nCtx.I18N.en;
const JA = i18nCtx.I18N.ja;

function makeHarness(opts) {
  opts = opts || {};
  const doc = makeDoc();
  const keyTarget = {
    listeners: [],
    addEventListener(type, fn, cap) { this.listeners.push({ type, fn, cap }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); },
    press(key) {
      const ev = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      this.listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(ev));
      return ev;
    }
  };
  const config = opts.config || {
    general: { theme: 'olive', language: 'en' },
    text: { model: 'local', apiKey: 'sk-live', maxTokens: 30 },
    autocomplete: { enabled: true },
    shortcuts: { zenMode: 'Shift+F11' },
    scraps: { scrapDir: '~/scraps', gitRemoteUrl: 'https://u:p@example.com/x.git' },
    scrap_dir: '~/scraps',
    default_agent: 'claude-code'
  };
  const messages = [];
  const applied = [];
  let refreshed = 0;
  const host = {
    t: (key) => (opts.dict || EN)[key] !== undefined ? (opts.dict || EN)[key] : key,
    showMessage: (msg) => messages.push(msg),
    getConfig: () => config,
    getProjectHint: () => (opts.hint !== undefined ? opts.hint : 'C:\\proj\\notes'),
    applyConfig: async (next) => { applied.push(next); if (opts.applyThrows) throw new Error(opts.applyThrows); },
    refreshAgents: () => { refreshed++; }
  };
  const calls = [];
  const backend = opts.backend === undefined ? {} : opts.backend;
  const dialog = CP.createDialog({ doc, keyTarget, getBackend: () => backend, host: () => host });
  return { doc, keyTarget, config, messages, applied, calls, backend, dialog, host, refreshed: () => refreshed };
}

function fullBackend(h, over) {
  const o = Object.assign({
    list: { projectRoot: 'C:\\proj', agents: [
      { id: 'agents:app', scope: 'app', path: 'C:\\cfg\\agents.yaml', bytes: 2048 },
      { id: 'agents:project', scope: 'project', path: 'C:\\proj\\.md-memo\\agents.yaml', bytes: 900 }
    ], skills: [
      { id: 'skill:skills/foo', root: 'skills', name: 'foo', entry: 'dir', files: 3, bytes: 5000 },
      { id: 'skill:.claude/skills/bar', root: '.claude/skills', name: 'bar', entry: 'dir', files: 1, bytes: 100 },
      { id: 'skill:skills/note.md', root: 'skills', name: 'note.md', entry: 'file', files: 1, bytes: 300 }
    ], warnings: [] },
    exportResult: { ok: true, path: 'C:\\out\\md-memo-20260921.mdmemopack', counts: { config: 1, agents: 2, skills: 1, files: 7, bytes: 9000 }, secretsStripped: 2 }
  }, over || {});
  h.backend.packListExportable = async (hint) => { h.calls.push(['list', hint]); if (o.listThrows) throw new Error(o.listThrows); return JSON.stringify(o.list); };
  h.backend.packExport = async (sel, cfg) => { h.calls.push(['export', JSON.parse(sel), JSON.parse(cfg)]); if (o.exportThrows) throw new Error(o.exportThrows); return JSON.stringify(o.exportResult); };
  h.backend.packInspect = async (hint) => { h.calls.push(['inspect', hint]); if (o.inspectThrows) throw new Error(o.inspectThrows); return JSON.stringify(o.inspect || { cancelled: true }); };
  h.backend.packImport = async (p, sel, hint) => { h.calls.push(['import', p, JSON.parse(sel), hint]); if (o.importThrows) throw new Error(o.importThrows); return JSON.stringify(o.importResult || { ok: true }); };
  return o;
}

const body = (h) => h.doc.getElementById('pack-body');
const isOpen = (h) => !h.doc.getElementById('pack-modal').hasClass('hidden');
const rowOf = (h, title) => body(h).find((n) => n.hasClass('pack-row') && n.find((c) => c.hasClass('pack-row-title') && c.textContent === title));
const inputOf = (h, title) => { const r = rowOf(h, title); assert(r, 'row not found: ' + title); return r.find((n) => n.type === 'checkbox'); };
const notes = (h) => body(h).findAll((n) => n.hasClass('pack-note') && !n.hasClass('hidden')).map((n) => n.textContent);
const confirmBtn = (h) => h.doc.getElementById('pack-confirm');
const cancelBtn = (h) => h.doc.getElementById('pack-cancel');

// ================================ pure helpers ========================================================
test('sections: every known key maps to one section, the flat scrap keys travel with sync, the rest is "other"', () => {
  assert.deepStrictEqual(CP.CONFIG_SECTIONS.map((s) => s.id), ['general', 'models', 'integration', 'shortcuts', 'sync', 'other']);
  const expect = {
    general: 'general', text: 'models', autocomplete: 'models', vision: 'models', voice: 'models', cli: 'models', image: 'models',
    action: 'integration', default_agent: 'integration', timeout_seconds: 'integration', hover_peek_enabled: 'integration',
    ghost_diff_duration_ms: 'integration', autoSelector: 'integration', agents: 'integration', disabled_agents: 'integration', slot_profiles: 'integration', recipes: 'integration',
    shortcuts: 'shortcuts', scraps: 'sync', scrap_dir: 'sync', git_sync_enabled: 'sync', git_sync_debounce_seconds: 'sync',
    git_remote_branch: 'sync', max_pipe_size_mb: 'sync', somethingNew: 'other', toString: 'other'
  };
  Object.keys(expect).forEach((k) => assert.strictEqual(CP.sectionOfKey(k), expect[k], k));
  assert.strictEqual(CP.sectionOfKey('__proto__'), 'other');
  const sync = CP.CONFIG_SECTIONS.find((s) => s.id === 'sync');
  assert.strictEqual(sync.defaultOn, false, 'sync (machine specific) starts unchecked');
  assert.strictEqual(sync.thisPcOnly, true);
  CP.CONFIG_SECTIONS.filter((s) => s.id !== 'sync').forEach((s) => assert.strictEqual(s.defaultOn, true, s.id));
});

test('splitConfig keeps only the chosen sections, as a deep copy', () => {
  const cfg = { general: { theme: 'olive', toolbarLayout: { order: ['a'], hidden: [] } }, text: { model: 'm' }, shortcuts: { a: 'b' }, scraps: { scrapDir: 'x' }, scrap_dir: 'x', extra: 1 };
  assert.deepStrictEqual(Object.keys(CP.splitConfig(cfg, ['general'])), ['general']);
  assert.deepStrictEqual(CP.splitConfig(cfg, ['sync', 'other']), { scraps: { scrapDir: 'x' }, scrap_dir: 'x', extra: 1 });
  assert.deepStrictEqual(CP.splitConfig(cfg, []), {});
  assert.deepStrictEqual(CP.splitConfig(null, ['general']), {});
  const out = CP.splitConfig(cfg, ['general']);
  out.general.toolbarLayout.order.push('z');
  assert.deepStrictEqual(cfg.general.toolbarLayout.order, ['a'], 'the copy does not alias the live config');
});

test('sectionsPresent lists only sections with values, "other" only when non-empty', () => {
  assert.deepStrictEqual(CP.sectionsPresent({ general: {}, text: {} }), ['general', 'models']);
  assert.deepStrictEqual(CP.sectionsPresent({ shortcuts: {}, scrap_dir: 'x', recipes: [] }), ['integration', 'shortcuts', 'sync']);
  assert.deepStrictEqual(CP.sectionsPresent({ foo: 1 }), ['other']);
  assert.deepStrictEqual(CP.sectionsPresent({ general: null, agents: undefined }), []);
  assert.deepStrictEqual(CP.sectionsPresent(null), []);
});

test('isSecretKey uses the same words as the Go side, case-insensitively', () => {
  ['apiKey', 'API_KEY', 'x-api-key', 'ANTHROPIC_API_KEY', 'authToken', 'clientSecret', 'password', 'dbPasswd'].forEach((k) => assert(CP.isSecretKey(k), k));
  ['model', 'baseUrl', 'systemPrompt', 'theme', 'zenMode', ''].forEach((k) => assert(!CP.isSecretKey(k), k));
  assert(!CP.isSecretKey(undefined));
});

test('mergeImported: objects deep-merge, arrays and scalars are replaced', () => {
  const cur = { general: { theme: 'olive', language: 'en', toolbarLayout: { order: ['a', 'b'], hidden: ['c'] } }, text: { model: 'm1', baseUrl: 'u1' } };
  const imp = { general: { theme: 'blue', toolbarLayout: { order: ['b'] } }, text: { model: 'm2' } };
  const out = CP.mergeImported(cur, imp, ['general', 'models']);
  assert.deepStrictEqual(out.general, { theme: 'blue', language: 'en', toolbarLayout: { order: ['b'], hidden: ['c'] } });
  assert.deepStrictEqual(out.text, { model: 'm2', baseUrl: 'u1' });
});

test('mergeImported: sections that were not chosen, and keys the package lacks, keep their current values', () => {
  const cur = { general: { theme: 'olive' }, text: { model: 'm1' }, shortcuts: { a: '1' }, scraps: { scrapDir: 'here' }, scrap_dir: 'here' };
  const imp = { general: { theme: 'blue' }, shortcuts: { a: '2' }, scraps: { scrapDir: 'there' }, scrap_dir: 'there' };
  const out = CP.mergeImported(cur, imp, ['shortcuts']);
  assert.strictEqual(out.general.theme, 'olive');
  assert.strictEqual(out.shortcuts.a, '2');
  assert.strictEqual(out.scraps.scrapDir, 'here', 'sync was not chosen: this PC keeps its scrap folder');
  assert.strictEqual(out.scrap_dir, 'here');
  assert.strictEqual(out.text.model, 'm1');
  assert.deepStrictEqual(CP.mergeImported(cur, imp, []), cur);
});

test('mergeImported: an empty secret never overwrites, a real one does', () => {
  const cur = { text: { apiKey: 'sk-mine', model: 'a' }, vision: { apiKey: 'v-mine' }, action: { apiKey: 'act', enabled: true }, agents: { x: { env: { ANTHROPIC_API_KEY: 'k1', LANG: 'ja' } } } };
  const imp = { text: { apiKey: '', model: 'b' }, vision: { apiKey: 'v-new' }, action: { apiKey: '', enabled: false }, agents: { x: { env: { ANTHROPIC_API_KEY: '', LANG: 'en' } } } };
  const out = CP.mergeImported(cur, imp, ['models', 'integration']);
  assert.strictEqual(out.text.apiKey, 'sk-mine');
  assert.strictEqual(out.text.model, 'b');
  assert.strictEqual(out.vision.apiKey, 'v-new');
  assert.strictEqual(out.action.apiKey, 'act');
  assert.strictEqual(out.action.enabled, false);
  assert.strictEqual(out.agents.x.env.ANTHROPIC_API_KEY, 'k1', 'nested secrets too');
  assert.strictEqual(out.agents.x.env.LANG, 'en');
  assert.strictEqual(CP.mergeImported({ legacyApiKey: 'top' }, { legacyApiKey: '' }, ['other']).legacyApiKey, 'top', 'a top-level secret key too');
  // the Go side blanks every string BELOW a secret-named key, so those are "not included" as well
  const below = CP.mergeImported({ text: { secrets: { openai: 'o1', gemini: 'g1' }, apiKeys: ['a', 'b'], model: 'x' } }, { text: { secrets: { openai: '', gemini: 'g2' }, apiKeys: ['', ''], model: '' } }, ['models']);
  assert.deepStrictEqual(below.text.secrets, { openai: 'o1', gemini: 'g2' });
  assert.deepStrictEqual(below.text.apiKeys, ['a', 'b']);
  assert.strictEqual(below.text.model, '', 'outside a secret, an empty string is a real value');
  assert.deepStrictEqual(CP.mergeImported({ text: { apiKeys: ['a'] } }, { text: { apiKeys: ['new'] } }, ['models']).text.apiKeys, ['new'], 'a real list replaces');
  // "maxTokens" matches the secret words but a number is not an empty string
  assert.strictEqual(CP.mergeImported({ text: { maxTokens: 30 } }, { text: { maxTokens: 50 } }, ['models']).text.maxTokens, 50);
  // an empty NON-secret value is a real value
  assert.strictEqual(CP.mergeImported({ text: { systemPrompt: 'x' } }, { text: { systemPrompt: '' } }, ['models']).text.systemPrompt, '');
});

test('mergeImported: null never overwrites, the input is not modified, untouched keys are shared', () => {
  const cur = { general: { theme: 'olive' }, text: { model: 'm' }, recipes: [1] };
  const snapshot = JSON.stringify(cur);
  const imp = { general: null, recipes: null, text: { model: null } };
  const out = CP.mergeImported(cur, imp, ['general', 'models', 'integration']);
  assert.deepStrictEqual(out, cur);
  const out2 = CP.mergeImported(cur, { text: { model: 'z' } }, ['models']);
  assert.strictEqual(out2.text.model, 'z');
  assert.strictEqual(JSON.stringify(cur), snapshot, 'the live config is not mutated');
  assert.strictEqual(out2.general, cur.general, 'untouched keys are shared, not copied');
  assert.notStrictEqual(out2.text, cur.text);
});

test('general.cloudConsent stays on this PC: not exported, and an import neither adds nor removes it', () => {
  const cfg = { general: { theme: 'olive', checkUpdates: false, cloudConsent: { 'api.openai.com': '2026-09-30' } } };
  const out = CP.splitConfig(cfg, ['general']);
  assert.deepStrictEqual(out, { general: { theme: 'olive', checkUpdates: false } }, 'the update switch travels (an administrator can ship it), the consent does not');
  assert.ok('cloudConsent' in cfg.general, 'the live config is not touched');

  const current = { general: { theme: 'olive', cloudConsent: { 'mine.example': '2026-01-01' } } };
  const imported = { general: { theme: 'blue', checkUpdates: false, cloudConsent: { 'theirs.example': '2026-02-02' } } };
  const merged = CP.mergeImported(current, imported, ['general']);
  assert.strictEqual(merged.general.theme, 'blue');
  assert.strictEqual(merged.general.checkUpdates, false);
  assert.deepStrictEqual(merged.general.cloudConsent, { 'mine.example': '2026-01-01' }, "a colleague's answer never becomes mine");
  assert.ok(imported.general.cloudConsent['theirs.example'], 'the imported object is not modified');
  assert.deepStrictEqual(Object.keys(CP.LOCAL_ONLY_NESTED), ['general']);
});

test('mergeImported: a package cannot pollute prototypes or overflow the stack', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "general": {"__proto__": {"polluted": true}, "theme": "blue"}}');
  const out = CP.mergeImported({ general: { theme: 'olive' } }, evil, ['general', 'other']);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(out.polluted, undefined);
  assert.strictEqual(out.general.polluted, undefined);
  assert.strictEqual(Object.getPrototypeOf(out.general), Object.prototype);
  assert.strictEqual(out.general.theme, 'blue');
  let deep = { v: 1 };
  for (let i = 0; i < 200; i++) deep = { n: deep };
  const base = { general: {} };
  for (let i = 0, p = base.general; i < 200; i++) { p.n = {}; p = p.n; }
  assert.throws(() => CP.mergeImported(base, { general: deep }, ['general']), /nested too deeply/);
});

test('mergeImported tolerates junk', () => {
  assert.deepStrictEqual(CP.mergeImported(null, null, ['general']), {});
  assert.deepStrictEqual(CP.mergeImported({ a: 1 }, 'text', ['other']), { a: 1 });
  assert.deepStrictEqual(CP.mergeImported({ a: 1 }, [1], ['other']), { a: 1 });
  assert.deepStrictEqual(CP.mergeImported(undefined, { general: { theme: 'x' } }, ['general']), { general: { theme: 'x' } });
});

test('groupSkills orders roots as documented and sorts names', () => {
  const g = CP.groupSkills([
    { root: '.codex/skills', name: 'z' }, { root: 'skills', name: 'b' }, { root: 'weird', name: 'w' },
    { root: 'skills', name: 'a' }, { root: '.claude/skills', name: 'c' }
  ]);
  assert.deepStrictEqual(g.map((x) => x.root), ['skills', '.claude/skills', '.codex/skills', 'weird']);
  assert.deepStrictEqual(g[0].items.map((x) => x.name), ['a', 'b']);
  assert.deepStrictEqual(CP.groupSkills([]), []);
});

test('formatBytes', () => {
  assert.strictEqual(CP.formatBytes(0), '0 B');
  assert.strictEqual(CP.formatBytes(900), '900 B');
  assert.strictEqual(CP.formatBytes(2048), '2.0 KB');
  assert.strictEqual(CP.formatBytes(123456), '121 KB');
  assert.strictEqual(CP.formatBytes(5 * 1048576), '5.0 MB');
  assert.strictEqual(CP.formatBytes(undefined), '');
  assert.strictEqual(CP.formatBytes(-1), '');
});

test('export state: defaults, selection and the "something must be selected" rule', () => {
  const st = CP.newExportState({ general: {}, text: {}, scraps: {}, shortcuts: {} });
  assert.deepStrictEqual(st.sections.map((s) => [s.id, s.checked]), [['general', true], ['models', true], ['shortcuts', true], ['sync', false]]);
  assert.strictEqual(st.includeSecrets, false, 'API keys are off by default');
  assert.strictEqual(st.format, 'pack');
  assert.strictEqual(CP.canExport(st), false, 'the project scan has not finished');
  CP.ingestList(st.list, { projectRoot: 'C:\\p', agents: [{ id: 'agents:app', path: 'x', bytes: 1 }], skills: [{ id: 'skill:skills/a', root: 'skills', name: 'a', files: 1, bytes: 1 }], warnings: ['w', 3] });
  assert.strictEqual(st.list.status, 'ready');
  assert.deepStrictEqual(st.list.warnings, ['w']);
  assert.strictEqual(st.list.agents[0].checked, true, 'agent definitions start checked');
  assert.strictEqual(st.list.skills[0].checked, false, 'skills are opt-in');
  assert.strictEqual(CP.canExport(st), true);
  const sel = CP.buildExportSelection(st, 'C:\\p\\n');
  assert.deepStrictEqual(sel, { format: 'pack', projectHint: 'C:\\p\\n', includeSecrets: false, configSections: ['general', 'models', 'shortcuts'], includeConfig: true, agents: ['agents:app'], skills: [] });
  st.sections.forEach((s) => { s.checked = false; });
  st.list.agents[0].checked = false;
  assert.strictEqual(CP.canExport(st), false, 'nothing selected');
  st.list.skills[0].checked = true;
  assert.strictEqual(CP.canExport(st), true);
  st.format = 'json';
  assert.strictEqual(CP.canExport(st), false, 'JSON is settings only: skills do not count');
  const jsonSel = CP.buildExportSelection(st, '');
  assert.strictEqual(jsonSel.format, 'json');
  assert.deepStrictEqual([jsonSel.agents, jsonSel.skills, jsonSel.includeConfig], [[], [], false]);
});

test('ingestList derives root/name from the id when the scan omits them, and drops junk', () => {
  const list = { status: 'loading' };
  CP.ingestList(list, { skills: [{ id: 'skill:.claude/skills/deep-one' }, { nope: 1 }, null], agents: [{ id: 'agents:project' }, { id: 5 }] });
  assert.strictEqual(list.skills.length, 1);
  assert.strictEqual(list.skills[0].root, '.claude/skills');
  assert.strictEqual(list.skills[0].name, 'deep-one');
  assert.strictEqual(list.agents.length, 1);
  assert.strictEqual(list.agents[0].scope, 'project');
  CP.ingestList(list, 'oops');
  assert.deepStrictEqual([list.agents, list.skills, list.projectRoot], [[], [], '']);
});

test('import state: sections come from the manifest, project items need a project, legacy lists every section', () => {
  const info = {
    packPath: 'C:\\in\\p.mdmemopack', legacy: false, projectRoot: '',
    manifest: { createdAt: '2026-09-21T10:00:00+09:00', appVersion: '1.5.5', includesSecrets: true, configSections: ['general', 'sync', 'future-thing'] },
    items: [
      { id: 'config', kind: 'config', sections: ['general', 'sync', 'future-thing'] },
      { id: 'agents:app', kind: 'agents', scope: 'app', bytes: 10, exists: true },
      { id: 'agents:project', kind: 'agents', scope: 'project', bytes: 10, exists: false },
      { id: 'skill:skills/foo', kind: 'skill', root: 'skills', name: 'foo', files: 2, bytes: 5, exists: false }
    ]
  };
  const imp = CP.newImportState(info);
  assert.deepStrictEqual(imp.sections.map((s) => [s.id, s.checked]), [['general', true], ['sync', false]], 'unknown ids are ignored, sync starts unchecked');
  assert.strictEqual(imp.includesSecrets, true);
  const byId = Object.fromEntries(imp.agents.map((a) => [a.id, a]));
  assert.deepStrictEqual([byId['agents:app'].checked, byId['agents:app'].disabled, byId['agents:app'].exists], [true, false, true]);
  assert.deepStrictEqual([byId['agents:project'].checked, byId['agents:project'].disabled], [false, true]);
  assert.deepStrictEqual([imp.skills[0].checked, imp.skills[0].disabled], [false, true]);
  assert.deepStrictEqual(CP.buildImportSelection(imp), { config: true, agents: ['agents:app'], skills: [] });
  imp.sections.forEach((s) => { s.checked = false; });
  imp.agents[0].checked = false;
  assert.strictEqual(CP.canImport(imp), false);

  const withProject = CP.newImportState(Object.assign({}, info, { projectRoot: 'C:\\proj' }));
  assert.deepStrictEqual(CP.buildImportSelection(withProject), { config: true, agents: ['agents:app', 'agents:project'], skills: ['skill:skills/foo'] });

  const legacy = CP.newImportState({ packPath: 'x.json', legacy: true, manifest: {}, items: [{ id: 'config', kind: 'config', sections: [] }] });
  assert.deepStrictEqual(legacy.sections.map((s) => s.id), ['general', 'models', 'integration', 'shortcuts', 'sync']);
  assert.strictEqual(legacy.legacy, true);
  const empty = CP.newImportState({});
  assert.deepStrictEqual([empty.sections, empty.agents, empty.skills], [[], [], []]);
});

// ================================ the dialog ==========================================================
test('export: rows, defaults, and what is sent to packExport / packListExportable', async () => {
  const h = makeHarness();
  fullBackend(h);
  h.doc.activeElement = h.doc.opener;
  const opening = h.dialog.openExport();
  assert(isOpen(h), 'opens straight away, before the scan finishes');
  assert(confirmBtn(h).disabled, 'Export waits for the scan');
  assert(body(h).textContent.includes(EN.packScanning));
  await opening;
  await settle();

  assert.deepStrictEqual(h.calls[0], ['list', 'C:\\proj\\notes']);
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packExportTitle);
  assert.strictEqual(confirmBtn(h).textContent, EN.packBtnExport);
  assert.strictEqual(cancelBtn(h).textContent, EN.btnCancel);
  assert(!confirmBtn(h).disabled);

  const titles = body(h).findAll((n) => n.hasClass('pack-row-title')).map((n) => n.textContent);
  assert.deepStrictEqual(titles, [EN.packSecGeneral, EN.packSecModels, EN.packSecIntegration, EN.packSecShortcuts, EN.packSecSync,
    EN.packAgentApp, EN.packAgentProject, 'foo', 'note.md', 'bar', EN.packIncludeKeys]);
  assert.strictEqual(inputOf(h, EN.packSecSync).checked, false);
  assert.strictEqual(inputOf(h, EN.packSecGeneral).checked, true);
  assert.strictEqual(inputOf(h, 'foo').checked, false);
  assert.strictEqual(inputOf(h, EN.packAgentApp).checked, true);
  assert.strictEqual(inputOf(h, EN.packIncludeKeys).checked, false, 'keys are excluded unless asked for');
  assert(rowOf(h, EN.packSecSync).find((n) => n.hasClass('pack-tag') && n.textContent === EN.packTagThisPc), 'sync is tagged "this PC only"');
  assert.strictEqual(rowOf(h, 'note.md').find((n) => n.hasClass('pack-row-sub')).textContent, EN.packSkillSingleFile + ' · 300 B');
  assert.strictEqual(rowOf(h, 'foo').find((n) => n.hasClass('pack-row-sub')).textContent, '3 files · 4.9 KB');
  assert.deepStrictEqual(body(h).findAll((n) => n.hasClass('pack-subhead-name')).map((n) => n.textContent), ['skills', '.claude/skills']);
  assert(!notes(h).some((t) => t === EN.packNoProjectHint), 'a project exists: no hint');
  assert(body(h).textContent.includes('C:\\proj'), 'the project root is shown');

  inputOf(h, 'foo').click();
  inputOf(h, EN.packSecShortcuts).click();
  const skillsHead = body(h).findAll((n) => n.hasClass('pack-subhead'))[1];
  assert.strictEqual(skillsHead.find((n) => n.hasClass('pack-subhead-count')).textContent, '0 / 1');
  confirmBtn(h).click();
  assert.strictEqual(confirmBtn(h).textContent, EN.packBtnExporting);
  assert(confirmBtn(h).disabled && cancelBtn(h).disabled, 'no double submit, no cancel mid-export');
  await settle();

  const [, sel, cfg] = h.calls.find((c) => c[0] === 'export');
  assert.deepStrictEqual(sel, { format: 'pack', projectHint: 'C:\\proj\\notes', includeSecrets: false, configSections: ['general', 'models', 'integration'], includeConfig: true, agents: ['agents:app', 'agents:project'], skills: ['skill:skills/foo'] });
  assert.deepStrictEqual(Object.keys(cfg).sort(), ['autocomplete', 'default_agent', 'general', 'text']);
  assert.strictEqual(cfg.text.apiKey, 'sk-live', 'stripping is the Go side\'s job; the frontend sends the chosen sections as they are');
  assert(!('shortcuts' in cfg) && !('scraps' in cfg) && !('scrap_dir' in cfg), 'unchosen sections are not even sent');

  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleExport);
  assert(confirmBtn(h).hasClass('hidden'));
  assert.strictEqual(cancelBtn(h).textContent, EN.packBtnClose);
  const text = body(h).textContent;
  assert(text.includes('C:\\out\\md-memo-20260921.mdmemopack'), 'the path is shown');
  assert(text.includes(EN.packResultSecretsLeftOut.replace('{count}', '2')), 'says how many secrets were left out');
  assert(text.includes('7 files, 8.8 KB'));
  assert.strictEqual(h.messages.length, 1);
  assert(h.messages[0].includes('md-memo-20260921.mdmemopack'), 'the toast names the file');

  cancelBtn(h).click();
  assert(!isOpen(h));
  assert.strictEqual(body(h).children.length, 0, 'nothing stays built while the dialog is closed');
  assert.strictEqual(h.keyTarget.listeners.length, 0, 'the Escape listener is gone');
  assert.strictEqual(h.doc.activeElement, h.doc.opener, 'focus returns to the button that opened it');
});

test('export: the API-keys box is honoured and flagged, secret warnings are reported', async () => {
  const h = makeHarness();
  fullBackend(h, { exportResult: { ok: true, path: 'C:\\o\\a.mdmemopack', counts: { config: 1, files: 1, bytes: 10 }, secretsStripped: 0, secretWarnings: 1, warnings: ['heads up'] } });
  await h.dialog.openExport();
  await settle();
  const keys = inputOf(h, EN.packIncludeKeys);
  keys.click();
  assert(rowOf(h, EN.packIncludeKeys).hasClass('is-warn'), 'turning keys on highlights the warning');
  confirmBtn(h).click();
  await settle();
  const [, sel] = h.calls.find((c) => c[0] === 'export');
  assert.strictEqual(sel.includeSecrets, true);
  const text = body(h).textContent;
  assert(text.includes(EN.packResultKeysIncluded));
  assert(text.includes(EN.packResultSecretWarnings.replace('{count}', '1')));
  assert(text.includes('heads up'));
  assert(!text.includes('left out'), 'no "left out" line when keys were included');
});

test('export: JSON format is settings only and dims the agent and skill groups', async () => {
  const h = makeHarness();
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  inputOf(h, 'foo').click();
  const fmt = h.doc.getElementById('pack-format');
  assert.deepStrictEqual(fmt.children.map((o) => o.value), ['pack', 'json']);
  const hint = body(h).find((n) => n.textContent === EN.packFormatJsonHint);
  assert(hint.hasClass('hidden'), 'the JSON hint only shows for JSON');
  fmt.choose('json');
  assert(!hint.hasClass('hidden'));
  assert(inputOf(h, 'foo').disabled && inputOf(h, EN.packAgentApp).disabled, 'agents and skills are disabled');
  assert(!inputOf(h, EN.packSecGeneral).disabled);
  assert(body(h).findAll((n) => n.tagName === 'BUTTON' && n.hasClass('pack-link')).slice(2).every((b) => b.disabled), 'group all/none links are off, the settings ones are not');
  confirmBtn(h).click();
  await settle();
  const [, sel] = h.calls.find((c) => c[0] === 'export');
  assert.strictEqual(sel.format, 'json');
  assert.deepStrictEqual([sel.agents, sel.skills], [[], []]);
  assert.deepStrictEqual(sel.configSections, ['general', 'models', 'integration', 'shortcuts']);
  assert(body(h).textContent.includes(EN.packExportSavedJson) && !body(h).textContent.includes(EN.packExportSaved), 'a JSON export is not called a package');
  assert(h.messages[0].startsWith(EN.packExportToastJson.split('{')[0]));
  cancelBtn(h).click();

  // JSON with every section unchecked cannot be exported
  await h.dialog.openExport();
  await settle();
  h.doc.getElementById('pack-format').choose('json');
  ['General', 'AI Models', 'Agent & Quick Actions', 'Shortcuts'].forEach((t) => inputOf(h, t).click());
  assert(confirmBtn(h).disabled);
  h.doc.getElementById('pack-format').choose('pack');
  assert(!confirmBtn(h).disabled, 'agents are still ticked in package format');
});

test('export: all / none per group', async () => {
  const h = makeHarness();
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  const links = (head) => head.findAll((n) => n.hasClass('pack-link'));
  const heads = body(h).findAll((n) => n.hasClass('pack-subhead'));
  links(heads[0])[0].click();
  assert(inputOf(h, 'foo').checked && inputOf(h, 'note.md').checked && !inputOf(h, 'bar').checked, 'only the "skills" root');
  assert.strictEqual(heads[0].find((n) => n.hasClass('pack-subhead-count')).textContent, '2 / 2');
  links(heads[0])[1].click();
  assert(!inputOf(h, 'foo').checked);
  const settingsHead = body(h).find((n) => n.hasClass('settings-section-header'));
  links(settingsHead)[1].click();
  assert(['General', 'AI Models', 'Agent & Quick Actions', 'Shortcuts', 'Sync'].every((t) => !inputOf(h, t).checked));
  links(settingsHead)[0].click();
  assert(['General', 'AI Models', 'Agent & Quick Actions', 'Shortcuts', 'Sync'].every((t) => inputOf(h, t).checked));
});

test('export: with no project the agent and skill lists say why, and only the app agents file is offered', async () => {
  const h = makeHarness({ hint: '' });
  fullBackend(h, { list: { projectRoot: '', agents: [{ id: 'agents:app', scope: 'app', path: 'C:\\cfg\\agents.yaml', bytes: 5 }], skills: [], warnings: [] } });
  await h.dialog.openExport();
  await settle();
  assert.deepStrictEqual(h.calls[0], ['list', ''], 'an empty hint is passed through');
  assert(notes(h).includes(EN.packNoProjectHint));
  assert(body(h).textContent.includes(EN.packNoSkillsNoProject));
  assert.strictEqual(body(h).findAll((n) => n.hasClass('pack-subhead')).length, 0);
  assert(!confirmBtn(h).disabled);
  cancelBtn(h).click();

  const h2 = makeHarness();
  fullBackend(h2, { list: { projectRoot: 'C:\\p', agents: [], skills: [], warnings: [] } });
  await h2.dialog.openExport();
  await settle();
  assert(body(h2).textContent.includes(EN.packNoAgents));
  assert(body(h2).textContent.includes(EN.packNoSkills));
  assert(!confirmBtn(h2).disabled, 'settings alone can still be exported');
});

test('export: many skills stay in one scrollable body (nothing is truncated)', async () => {
  const h = makeHarness();
  const skills = [];
  for (let i = 0; i < 250; i++) skills.push({ id: 'skill:skills/s' + String(i).padStart(3, '0'), root: 'skills', name: 's' + String(i).padStart(3, '0'), entry: 'dir', files: 2, bytes: 100 });
  fullBackend(h, { list: { projectRoot: 'C:\\p', agents: [], skills, warnings: Array.from({ length: 8 }, (_, i) => 'warn ' + i) } });
  await h.dialog.openExport();
  await settle();
  assert.strictEqual(body(h).findAll((n) => n.hasClass('pack-row-title') && /^s\d{3}$/.test(n.textContent)).length, 250);
  body(h).findAll((n) => n.hasClass('pack-link'))[2].click();
  assert.strictEqual(body(h).findAll((n) => n.hasClass('pack-subhead-count'))[0].textContent, '250 / 250');
  assert(body(h).textContent.includes(EN.packMoreWarnings.replace('{count}', '3')), 'long warning lists are folded');
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.calls.find((c) => c[0] === 'export')[1].skills.length, 250);
});

test('export: native dialog cancelled -> the dialog stays open; a failure shows an error and can be retried', async () => {
  const h = makeHarness();
  const o = fullBackend(h, { exportResult: { ok: false, cancelled: true } });
  await h.dialog.openExport();
  await settle();
  confirmBtn(h).click();
  await settle();
  assert(isOpen(h));
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packExportTitle);
  assert(!confirmBtn(h).disabled && !cancelBtn(h).disabled && confirmBtn(h).textContent === EN.packBtnExport);
  assert.strictEqual(h.messages.length, 0);

  o.exportThrows = 'disk full: $& $1';
  h.backend.packExport = async () => { throw new Error('disk full: $& $1'); };
  confirmBtn(h).click();
  await settle();
  assert(isOpen(h));
  assert.deepStrictEqual(notes(h), [EN.packExportFailed.replace('{err}', () => 'disk full: $& $1')], 'error text is shown verbatim, "$&" is not a replacement pattern');
  assert(!confirmBtn(h).disabled);

  h.backend.packExport = async () => JSON.stringify({ ok: true, path: 'C:\\x\\ok.mdmemopack', counts: {} });
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleExport);
});

test('export: a backend answer that is not JSON is reported, not thrown', async () => {
  const h = makeHarness();
  fullBackend(h);
  h.backend.packExport = async () => 'not json';
  await h.dialog.openExport();
  await settle();
  confirmBtn(h).click();
  await settle();
  assert(isOpen(h));
  assert(notes(h)[0].includes('Unreadable response from packExport'));
});

test('export: if the project scan fails, settings can still be exported', async () => {
  const h = makeHarness();
  fullBackend(h, { listThrows: 'access denied' });
  await h.dialog.openExport();
  await settle();
  assert(notes(h).some((t) => t === EN.packScanFailed.replace('{err}', 'access denied')));
  assert(!confirmBtn(h).disabled);
  confirmBtn(h).click();
  await settle();
  const [, sel] = h.calls.find((c) => c[0] === 'export');
  assert.deepStrictEqual([sel.agents, sel.skills], [[], []]);
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleExport);
});

test('export: an older backend without the pack bindings gets a clear message and nothing throws', async () => {
  for (const backend of [undefined, {}, { exportConfig() {}, importConfig() {} }]) {
    const h = makeHarness();
    const d = CP.createDialog({ doc: h.doc, keyTarget: h.keyTarget, getBackend: () => backend, host: () => h.host });
    await d.openExport();
    assert(isOpen(h));
    assert.deepStrictEqual(notes(h), [EN.packUnavailable]);
    assert(confirmBtn(h).hasClass('hidden'), 'there is nothing to confirm');
    assert.strictEqual(cancelBtn(h).textContent, EN.packBtnClose);
    d.cancel();
    assert(!isOpen(h));
    await d.openImport();
    assert.deepStrictEqual(notes(h), [EN.packUnavailable]);
    assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packImportTitle);
    d.cancel();
  }
  // half of the bindings is as good as none: the export dialog needs both the scan and the export call
  const h = makeHarness();
  const half = { packListExportable() {}, packInspect() {}, packImport() {} };
  const d = CP.createDialog({ doc: h.doc, keyTarget: h.keyTarget, getBackend: () => half, host: () => h.host });
  await d.openExport();
  assert.deepStrictEqual(notes(h), [EN.packUnavailable]);
});

test('export: a page without the dialog markup reports it instead of throwing', async () => {
  const h = makeHarness();
  fullBackend(h);
  const empty = { getElementById: () => null, createElement: () => ({}) };
  const d = CP.createDialog({ doc: empty, keyTarget: h.keyTarget, getBackend: () => h.backend, host: () => h.host });
  await d.openExport();
  await d.openImport();
  assert.strictEqual(h.messages.length, 2);
  assert(h.messages[0].includes('markup is missing'));
});

test('Escape closes only this dialog (and swallows the key), but not while an export is running', async () => {
  const h = makeHarness();
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  assert.strictEqual(h.keyTarget.listeners.length, 1);
  assert.strictEqual(h.keyTarget.listeners[0].cap, true, 'capture phase: it runs before the Settings dialog\'s own Escape handler');
  const other = h.keyTarget.press('a');
  assert(!other.prevented && isOpen(h), 'other keys are left alone');

  let release;
  h.backend.packExport = () => new Promise((r) => { release = () => r(JSON.stringify({ ok: true, path: 'C:\\a.mdmemopack', counts: {} })); });
  confirmBtn(h).click();
  await settle();
  const busy = h.keyTarget.press('Escape');
  assert(busy.prevented && busy.stopped);
  assert(isOpen(h), 'Escape does nothing while the native dialog is up');
  cancelBtn(h).click();
  assert(isOpen(h), 'so does Cancel');
  release();
  await settle();
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleExport);
  const ev = h.keyTarget.press('Escape');
  assert(ev.prevented && ev.stopped);
  assert(!isOpen(h));
  assert.strictEqual(h.keyTarget.listeners.length, 0);
});

test('clicking the backdrop closes it, clicking inside does not; the close button works', async () => {
  const h = makeHarness();
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  const modal = h.doc.getElementById('pack-modal');
  modal.fire('mousedown', { target: body(h) });
  assert(isOpen(h));
  modal.fire('mousedown', { target: modal });
  assert(!isOpen(h));
  await h.dialog.openExport();
  await settle();
  h.doc.getElementById('pack-close').click();
  assert(!isOpen(h));
});

test('closing while the scan is running drops the late answer', async () => {
  const h = makeHarness();
  fullBackend(h);
  let release;
  h.backend.packListExportable = () => new Promise((r) => { release = () => r(JSON.stringify({ projectRoot: 'C:\\p', agents: [], skills: [] })); });
  const opening = h.dialog.openExport();
  await settle();
  cancelBtn(h).click();
  release();
  await opening;
  await settle();
  assert(!isOpen(h));
  assert.strictEqual(body(h).children.length, 0, 'nothing is rebuilt into a closed dialog');
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  assert(isOpen(h), 'and it can be opened again');
});

test('export never puts package text into markup (only static icons are written as HTML)', async () => {
  const h = makeHarness();
  const evil = '<img src=x onerror=alert(1)>';
  fullBackend(h, { list: { projectRoot: evil, agents: [{ id: 'agents:app', scope: 'app', path: evil, bytes: 1 }], skills: [{ id: 'skill:skills/' + evil, root: 'skills', name: evil, entry: 'dir', files: 1, bytes: 1 }], warnings: [evil] } });
  await h.dialog.openExport();
  await settle();
  const writes = [];
  body(h).walk((n) => n.htmlWrites.forEach((w) => writes.push(w)));
  assert(writes.length > 0 && writes.every((w) => w.startsWith('<svg') && !w.includes('onerror')), 'innerHTML only ever receives the fixed SVG icons');
  assert(body(h).textContent.includes(evil), 'the text is shown as text');
});

// ---- import ------------------------------------------------------------------------------------------
function packInspectInfo(over) {
  return Object.assign({
    packPath: 'C:\\in\\team.mdmemopack', legacy: false, projectRoot: 'C:\\proj',
    manifest: { format: 'md-memo-pack', version: 1, createdAt: '2026-09-21T10:00:00+09:00', appVersion: '1.5.5', includesSecrets: false, configSections: ['general', 'models', 'sync'] },
    items: [
      { id: 'config', kind: 'config', sections: ['general', 'models', 'sync'] },
      { id: 'agents:app', kind: 'agents', scope: 'app', bytes: 2048, exists: true },
      { id: 'agents:project', kind: 'agents', scope: 'project', bytes: 900, exists: false },
      { id: 'skill:skills/foo', kind: 'skill', root: 'skills', name: 'foo', files: 3, bytes: 5000, exists: true },
      { id: 'skill:.claude/skills/bar', kind: 'skill', root: '.claude/skills', name: 'bar', files: 1, bytes: 100, exists: false }
    ],
    warnings: []
  }, over || {});
}

test('import: cancelling the native dialog opens nothing; an unreadable file becomes a toast', async () => {
  const h = makeHarness();
  const o = fullBackend(h, { inspect: { cancelled: true } });
  await h.dialog.openImport();
  assert(!isOpen(h));
  assert.strictEqual(h.messages.length, 0);
  h.backend.packInspect = async () => { throw new Error('Not a package / パッケージではありません'); };
  await h.dialog.openImport();
  assert(!isOpen(h));
  assert.strictEqual(h.messages.length, 1);
  assert.strictEqual(h.messages[0], EN.packImportFailed.replace('{err}', 'Not a package / パッケージではありません'));
  assert(o);
});

test('import: lists the package with overwrite badges, and sends the chosen items to packImport', async () => {
  const h = makeHarness();
  fullBackend(h, {
    inspect: packInspectInfo(),
    importResult: {
      ok: true,
      configJSON: JSON.stringify({ general: { theme: 'blue' }, text: { model: 'pkg-model', apiKey: '' }, scraps: { scrapDir: 'D:\\other-pc' }, scrap_dir: 'D:\\other-pc' }),
      configSections: ['general', 'models', 'sync'],
      applied: { agents: [{ id: 'agents:app', path: 'C:\\cfg\\agents.yaml' }], skills: [{ id: 'skill:skills/foo', path: 'C:\\proj\\skills\\foo', files: 3 }] },
      backupDir: 'C:\\cfg\\pack_backups\\20260921-104500',
      skipped: [{ id: 'skill:.claude/skills/bar', reason: 'unsafe entry name' }],
      needsRestart: true
    }
  });
  h.doc.activeElement = h.doc.opener;
  await h.dialog.openImport();
  assert(isOpen(h));
  assert.deepStrictEqual(h.calls[0], ['inspect', 'C:\\proj\\notes']);
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packImportTitle);
  assert.strictEqual(confirmBtn(h).textContent, EN.packBtnImport);
  const text = body(h).textContent;
  assert(text.includes('team.mdmemopack') && text.includes('MD-Memo 1.5.5'));
  assert(notes(h).includes(EN.packNoKeysNote), 'a package without keys says your keys stay');
  assert(notes(h).includes(EN.packSkillsWarn), 'skills come with the trust warning');
  assert(notes(h).includes(EN.packAgentsWarn), 'agent definitions come with the trust warning (they contain commands that will run)');
  assert(text.includes(EN.packBackupNote));
  const badge = (title) => rowOf(h, title).findAll((n) => n.hasClass('pack-tag')).map((n) => n.textContent);
  assert.deepStrictEqual(badge('foo'), [EN.packTagOverwrite]);
  assert.deepStrictEqual(badge('bar'), []);
  assert.deepStrictEqual(badge(EN.packAgentApp), [EN.packTagOverwrite]);
  assert.deepStrictEqual(badge(EN.packSecSync), [EN.packTagThisPc]);
  assert.strictEqual(inputOf(h, EN.packSecSync).checked, false, 'sync starts unchecked on import too');
  assert.strictEqual(inputOf(h, 'foo').checked, true);
  assert.deepStrictEqual(body(h).findAll((n) => n.hasClass('pack-row-title')).map((n) => n.textContent).slice(0, 4), [EN.packSecGeneral, EN.packSecModels, EN.packSecSync, EN.packAgentApp]);

  inputOf(h, 'bar').click();
  h.config.text.apiKey = 'sk-live';
  confirmBtn(h).click();
  assert.strictEqual(confirmBtn(h).textContent, EN.packBtnImporting);
  assert(confirmBtn(h).disabled);
  await settle();

  const [, packPath, sel, hint] = h.calls.find((c) => c[0] === 'import');
  assert.strictEqual(packPath, 'C:\\in\\team.mdmemopack');
  assert.deepStrictEqual(sel, { config: true, agents: ['agents:app', 'agents:project'], skills: ['skill:skills/foo'] });
  assert.strictEqual(hint, 'C:\\proj\\notes');

  assert.strictEqual(h.applied.length, 1, 'the merged config goes through the app once');
  const next = h.applied[0];
  assert.strictEqual(next.general.theme, 'blue');
  assert.strictEqual(next.text.model, 'pkg-model');
  assert.strictEqual(next.text.apiKey, 'sk-live', 'the package had no key: the local one is kept');
  assert.strictEqual(next.scraps.scrapDir, '~/scraps', 'sync was left unchecked: this PC\'s scrap folder is untouched');
  assert.strictEqual(next.scrap_dir, '~/scraps');
  assert.strictEqual(h.config.general.theme, 'olive', 'the live config object is modified only by the app\'s apply step, never by the dialog');
  assert.strictEqual(h.refreshed(), 1, 'the agent list is refreshed');

  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleImport);
  const result = body(h).textContent;
  assert(result.includes(EN.packResultConfig.replace('{sections}', 'General, AI Models')));
  assert(result.includes(EN.packResultAgentsWritten.replace('{count}', '1')) && result.includes('C:\\cfg\\agents.yaml'));
  assert(result.includes(EN.packResultSkillsWritten.replace('{count}', '1').replace('{files}', '3 files')) && result.includes('skills/foo'));
  assert(result.includes(EN.packResultSkipped.replace('{name}', '.claude/skills/bar').replace('{reason}', 'unsafe entry name')));
  assert(result.includes('C:\\cfg\\pack_backups\\20260921-104500'));
  assert(result.includes(EN.packResultRestart));
  assert.strictEqual(h.messages.length, 1);
  cancelBtn(h).click();
  assert(!isOpen(h));
  assert.strictEqual(h.doc.activeElement, h.doc.opener);
});

test('import: a package that includes API keys says so, and its keys do overwrite', async () => {
  const h = makeHarness();
  const info = packInspectInfo();
  info.manifest.includesSecrets = true;
  fullBackend(h, { inspect: info, importResult: { ok: true, configJSON: JSON.stringify({ text: { apiKey: 'sk-from-pack' } }), applied: {}, skipped: [] } });
  await h.dialog.openImport();
  assert(notes(h).includes(EN.packIncludesKeysNote));
  assert(!notes(h).includes(EN.packNoKeysNote));
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.applied[0].text.apiKey, 'sk-from-pack');
  assert(body(h).textContent.includes(EN.packResultConfig.replace('{sections}', 'AI Models')));
});

test('import: with no project, project agents and skills are disabled, unchecked and not sent', async () => {
  const h = makeHarness({ hint: '' });
  fullBackend(h, { inspect: packInspectInfo({ projectRoot: '' }), importResult: { ok: true, configJSON: '{}', applied: {}, skipped: [] } });
  await h.dialog.openImport();
  assert(notes(h).includes(EN.packNoProjectHint));
  assert(inputOf(h, 'foo').disabled && !inputOf(h, 'foo').checked);
  assert(inputOf(h, EN.packAgentProject).disabled);
  assert(!inputOf(h, EN.packAgentApp).disabled, 'the app-wide agents file needs no project');
  assert(rowOf(h, 'foo').findAll((n) => n.hasClass('pack-tag')).some((n) => n.textContent === EN.packTagNeedsProject));
  assert(!rowOf(h, 'foo').findAll((n) => n.hasClass('pack-tag')).some((n) => n.textContent === EN.packTagOverwrite), 'no "will overwrite" on a row that cannot be imported');
  const skillLinks = body(h).findAll((n) => n.hasClass('pack-subhead')).flatMap((s) => s.findAll((n) => n.hasClass('pack-link')));
  assert(skillLinks.length > 0 && skillLinks.every((l) => l.disabled), 'all / none is off for groups that cannot be ticked');
  const links = body(h).findAll((n) => n.hasClass('pack-link'));
  links.forEach((l) => l.click());
  assert(!inputOf(h, 'foo').checked, 'even "all" cannot tick a disabled row');
  confirmBtn(h).click();
  await settle();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'import')[2].skills, []);
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'import')[2].agents, ['agents:app']);
});

test('import: Import is disabled when nothing is ticked, and settings can be skipped entirely', async () => {
  const h = makeHarness();
  fullBackend(h, { inspect: packInspectInfo(), importResult: { ok: true, configJSON: '', applied: { agents: [{ id: 'agents:app', path: 'p' }] }, skipped: [] } });
  await h.dialog.openImport();
  const links = body(h).findAll((n) => n.hasClass('pack-link'));
  links.filter((l) => l.textContent === EN.packBtnNone).forEach((l) => l.click());
  ['foo', 'bar', EN.packAgentApp, EN.packAgentProject].forEach((t) => { if (inputOf(h, t).checked) inputOf(h, t).click(); });
  assert(confirmBtn(h).disabled);
  inputOf(h, EN.packAgentApp).click();
  assert(!confirmBtn(h).disabled);
  confirmBtn(h).click();
  await settle();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'import')[2], { config: false, agents: ['agents:app'], skills: [] });
  assert.strictEqual(h.applied.length, 0, 'no config was requested, so none is applied');
  assert(!body(h).textContent.includes(EN.packResultNothing));
});

test('import: legacy single-JSON files show every section and merge like a package', async () => {
  const h = makeHarness();
  const info = { packPath: 'C:\\in\\md-memo-config.json', legacy: true, projectRoot: '', manifest: {}, items: [{ id: 'config', kind: 'config', sections: [] }], warnings: [] };
  fullBackend(h, { inspect: info, importResult: { ok: true, configJSON: JSON.stringify({ general: { theme: 'charcoal' }, text: { model: 'old', apiKey: 'sk-old' }, mystery: 1 }), configSections: [], applied: {}, skipped: [] } });
  await h.dialog.openImport();
  assert(notes(h).includes(EN.packLegacyNote));
  assert.deepStrictEqual(body(h).findAll((n) => n.hasClass('pack-row-title')).map((n) => n.textContent), [EN.packSecGeneral, EN.packSecModels, EN.packSecIntegration, EN.packSecShortcuts, EN.packSecSync]);
  assert.strictEqual(inputOf(h, EN.packSecSync).checked, false);
  assert(!notes(h).includes(EN.packNoProjectHint), 'no project items, no project hint');
  confirmBtn(h).click();
  await settle();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'import')[2], { config: true, agents: [], skills: [] });
  const next = h.applied[0];
  assert.strictEqual(next.general.theme, 'charcoal');
  assert.strictEqual(next.text.apiKey, 'sk-old');
  assert(!('mystery' in next), 'a key outside the known sections is not applied unless "other" is offered');
  assert(body(h).textContent.includes(EN.packResultConfig.replace('{sections}', 'General, AI Models')));
});

test('import: a settings file with none of the chosen sections says so', async () => {
  const h = makeHarness();
  fullBackend(h, { inspect: { packPath: 'C:\\x.json', legacy: true, projectRoot: '', manifest: {}, items: [{ id: 'config', kind: 'config' }] }, importResult: { ok: true, configJSON: '{"unrelated":1}', applied: {}, skipped: [] } });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.applied.length, 0);
  const text = body(h).textContent;
  assert(text.includes(EN.packResultConfigNone));
  assert(text.includes(EN.packResultNothing));
});

test('import: a failing packImport keeps the dialog open with the error; a failing config apply is reported next to what did work', async () => {
  const h = makeHarness();
  const o = fullBackend(h, { inspect: packInspectInfo(), importThrows: 'The package is damaged' });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert(isOpen(h));
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packImportTitle);
  assert(notes(h).includes(EN.packImportFailed.replace('{err}', 'The package is damaged')));
  assert(!confirmBtn(h).disabled && !cancelBtn(h).disabled);

  h.backend.packImport = async () => JSON.stringify({ ok: true, configJSON: '{"general":{"theme":"blue"}}', applied: { agents: [{ id: 'agents:app', path: 'C:\\a.yaml' }] }, skipped: [] });
  h.host.applyConfig = async () => { throw new Error('storage is full'); };
  confirmBtn(h).click();
  await settle();
  const text = body(h).textContent;
  assert(text.includes(EN.packResultConfigFailed.replace('{err}', 'storage is full')));
  assert(text.includes(EN.packResultAgentsWritten.replace('{count}', '1')), 'the agent file that was written is still reported');
  assert(o);
});

test('import: a config that is not valid JSON is reported as a settings failure, not a crash', async () => {
  const h = makeHarness();
  fullBackend(h, { inspect: packInspectInfo(), importResult: { ok: true, configJSON: '{oops', applied: {}, skipped: [] } });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert(body(h).textContent.includes(EN.packResultConfigFailed.replace('{err}', '')));
  assert.strictEqual(h.applied.length, 0);
});

test('import: a package path or name with "$&" or markup is shown as plain text', async () => {
  const h = makeHarness();
  const evil = 'C:\\in\\<b onmouseover=alert(1)>x $& $1.mdmemopack';
  fullBackend(h, { inspect: packInspectInfo({ packPath: evil }), importResult: { ok: true, configJSON: '', applied: {}, skipped: [] } });
  await h.dialog.openImport();
  const writes = [];
  body(h).walk((n) => n.htmlWrites.forEach((w) => writes.push(w)));
  assert(writes.every((w) => w.startsWith('<svg')));
  assert(body(h).textContent.includes('<b onmouseover=alert(1)>x $& $1.mdmemopack'));
  confirmBtn(h).click();
  await settle();
  assert(h.messages[0].includes('$& $1.mdmemopack'), 'the toast keeps "$&" literally');
});

test('import: an empty package says there is nothing to import', async () => {
  const h = makeHarness();
  fullBackend(h, { inspect: { packPath: 'C:\\e.mdmemopack', legacy: false, projectRoot: '', manifest: { includesSecrets: false }, items: [] } });
  await h.dialog.openImport();
  assert(body(h).textContent.includes(EN.packNothingInPackage));
  assert(confirmBtn(h).disabled);
});

test('the dialog can be reopened for export after an import, with fresh state', async () => {
  const h = makeHarness();
  fullBackend(h, { inspect: packInspectInfo(), importResult: { ok: true, configJSON: '', applied: {}, skipped: [] } });
  await h.dialog.openImport();
  cancelBtn(h).click();
  await h.dialog.openExport();
  await settle();
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packExportTitle);
  assert.strictEqual(inputOf(h, EN.packIncludeKeys).checked, false);
  assert(!confirmBtn(h).hasClass('hidden'));
  await h.dialog.openExport();
  assert.strictEqual(body(h).findAll((n) => n.hasClass('pack-row-title') && n.textContent === EN.packSecGeneral).length, 1, 'opening twice does not build twice');
});

test('the dialog speaks Japanese when the host does', async () => {
  const h = makeHarness({ dict: JA });
  fullBackend(h);
  await h.dialog.openExport();
  await settle();
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, JA.packExportTitle);
  assert(rowOf(h, JA.packSecGeneral));
  assert(body(h).textContent.includes(JA.packIncludeKeysWarn));
  assert.strictEqual(rowOf(h, 'foo').find((n) => n.hasClass('pack-row-sub')).textContent, '3 ファイル · 4.9 KB');
});

// ================================ B19: destinations, safety switches and integrations ================================
// One PC with a key for api.openai.com, agent confirmation on, and the Discord bridge and the hot folder off ...
const localSetup = () => ({
  text: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-LOCAL-SECRET' },
  vision: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'g', apiKey: 'g-LOCAL' },
  autoSelector: { enabled: true, agentConfirm: true },
  discordBridge: { enabled: false, botToken: 'LOCALBOT', allowedUserId: '111', pollIntervalSeconds: 45 },
  inbox: { enabled: false, dir: '' },
  general: { theme: 'olive', cloudConsent: { 'api.openai.com': '2026-09-01' } }
});
// ... and a colleague's package that points at its own gateway, turns confirmation off and switches the integrations on.
const partnerPackage = () => ({
  text: { baseUrl: 'https://llm.partner-gateway.example/v1', model: 'partner-model', apiKey: '', systemPrompt: 'Be brief.' },
  autoSelector: { enabled: true, agentConfirm: false },
  discordBridge: { enabled: true, botToken: '', allowedUserId: '999999', pollIntervalSeconds: 30 },
  inbox: { enabled: true, dir: 'C:\\drop' },
  general: { theme: 'blue' }
});
const ALL_SECTIONS = ['general', 'models', 'integration', 'shortcuts', 'other'];

test('B19: guardedChanges lists the server, agent confirmation, Discord and hot folder changes, with before and after', () => {
  const changes = CP.guardedChanges(localSetup(), partnerPackage(), ALL_SECTIONS);
  assert.deepStrictEqual(changes.map((c) => c.id), ['server:text', 'agentConfirm', 'discord', 'inbox']);
  const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
  assert.strictEqual(byId['server:text'].before, 'https://api.openai.com/v1');
  assert.strictEqual(byId['server:text'].after, 'https://llm.partner-gateway.example/v1');
  assert.strictEqual(byId['server:text'].clearsKey, true, 'a new host, a key saved for the old one');
  assert.deepStrictEqual([byId.agentConfirm.before, byId.agentConfirm.after], [true, false]);
  assert.deepStrictEqual(byId.discord.before, { enabled: false, user: '111' });
  assert.deepStrictEqual(byId.discord.after, { enabled: true, user: '999999' });
  assert.deepStrictEqual(byId.inbox.after, { enabled: true, dir: 'C:\\drop' });
});

test('B19: without a tick nothing that decides where text goes or what runs unasked is taken; the rest of the package still is', () => {
  const cur = localSetup();
  const imp = partnerPackage();
  const snapshot = JSON.stringify(imp);
  const out = CP.mergeImported(cur, imp, ALL_SECTIONS);
  assert.strictEqual(out.text.baseUrl, 'https://api.openai.com/v1', 'the destination stays');
  assert.strictEqual(out.text.apiKey, 'sk-LOCAL-SECRET', 'and so does the key that belongs to it');
  assert.strictEqual(out.text.model, 'gpt-4o-mini', 'the model name belongs to the server and stays with it');
  assert.strictEqual(out.text.systemPrompt, 'Be brief.', 'taste is imported as before');
  assert.strictEqual(out.general.theme, 'blue');
  assert.strictEqual(out.autoSelector.agentConfirm, true, 'agents still ask');
  assert.deepStrictEqual(out.discordBridge, cur.discordBridge, 'no other person may talk to the bot');
  assert.deepStrictEqual(out.inbox, cur.inbox, 'the hot folder stays off');
  assert.strictEqual(JSON.stringify(imp), snapshot, 'the package object is not modified');
  assert.strictEqual(cur.text.baseUrl, 'https://api.openai.com/v1', 'nor is the live config');
});

test('B19: a ticked server takes the address and drops the key saved for the old host, unless the package brings its own', () => {
  const cur = localSetup();
  const out = CP.mergeImported(cur, partnerPackage(), ALL_SECTIONS, { allow: ['server:text'] });
  assert.strictEqual(out.text.baseUrl, 'https://llm.partner-gateway.example/v1');
  assert.strictEqual(out.text.apiKey, '', 'the OpenAI key is not sent to the partner');
  assert.strictEqual(out.text.model, 'partner-model');
  assert.strictEqual(out.vision.apiKey, 'g-LOCAL', 'other groups keep their keys');
  assert.strictEqual(out.autoSelector.agentConfirm, true, 'ticking one row ticks only that row');
  assert.strictEqual(cur.text.apiKey, 'sk-LOCAL-SECRET', 'the live config is untouched');

  const withKey = partnerPackage();
  withKey.text.apiKey = 'sk-PARTNER';
  assert.strictEqual(CP.mergeImported(cur, withKey, ALL_SECTIONS, { allow: ['server:text'] }).text.apiKey, 'sk-PARTNER', "the package's own key is kept");

  const sameHost = partnerPackage();
  sameHost.text.baseUrl = 'https://api.openai.com/v2';
  const c2 = CP.guardedChanges(cur, sameHost, ['models']);
  assert.strictEqual(c2[0].clearsKey, false, 'same host, another path: the key is still the right one');
  assert.strictEqual(CP.mergeImported(cur, sameHost, ['models'], { allow: ['server:text'] }).text.apiKey, 'sk-LOCAL-SECRET');
});

test('B19: everything ticked applies the whole package (a blank bot token still never wipes the saved one)', () => {
  const out = CP.mergeImported(localSetup(), partnerPackage(), ALL_SECTIONS, { allow: ['server:text', 'agentConfirm', 'discord', 'inbox'] });
  assert.strictEqual(out.autoSelector.agentConfirm, false);
  assert.deepStrictEqual(out.discordBridge, { enabled: true, botToken: 'LOCALBOT', allowedUserId: '999999', pollIntervalSeconds: 30 });
  assert.deepStrictEqual(out.inbox, { enabled: true, dir: 'C:\\drop' });
});

test('B19: changes that need no question are not listed: same address, agents asking MORE, switches turned off, unchosen sections', () => {
  const cur = localSetup();
  const quiet = {
    text: { baseUrl: 'https://api.openai.com/v1/', model: 'x' },
    autoSelector: { agentConfirm: true },
    discordBridge: { enabled: false, botToken: '', allowedUserId: '111' },
    inbox: { enabled: false, dir: '' }
  };
  assert.deepStrictEqual(CP.guardedChanges(cur, quiet, ALL_SECTIONS), [], 'a trailing slash is the same address');
  const cur2 = localSetup();
  cur2.autoSelector.agentConfirm = false;
  cur2.discordBridge.enabled = true;
  cur2.inbox.enabled = true;
  const safer = { autoSelector: { agentConfirm: true }, discordBridge: { enabled: false }, inbox: { enabled: false } };
  assert.deepStrictEqual(CP.guardedChanges(cur2, safer, ALL_SECTIONS), []);
  const out = CP.mergeImported(cur2, safer, ALL_SECTIONS);
  assert.strictEqual(out.autoSelector.agentConfirm, true, 'turning agent confirmation ON is applied');
  assert.strictEqual(out.discordBridge.enabled, false);
  assert.strictEqual(out.inbox.enabled, false);
  // a section that was not chosen brings no question and no change
  assert.deepStrictEqual(CP.guardedChanges(cur, partnerPackage(), ['general']), []);
  assert.deepStrictEqual(CP.guardedChanges(cur, partnerPackage(), ['models']).map((c) => c.id), ['server:text']);
  assert.deepStrictEqual(CP.guardedChanges(cur, partnerPackage(), ['other']).map((c) => c.id), ['discord', 'inbox']);
  assert.deepStrictEqual(CP.guardedChanges(null, null, ALL_SECTIONS), []);
  assert.deepStrictEqual(CP.guardedChanges(cur, { text: 'junk', discordBridge: [1] }, ALL_SECTIONS), []);
});

test('B19: every model server group is guarded, and a package cannot smuggle a change past it with __proto__', () => {
  const groups = ['text', 'autocomplete', 'vision', 'voice', 'cli', 'action', 'image'];
  const imp = {};
  groups.forEach((g) => { imp[g] = { baseUrl: 'https://evil.example/' + g }; });
  assert.deepStrictEqual(CP.guardedChanges({}, imp, ['models', 'integration']).map((c) => c.id), groups.map((g) => 'server:' + g));
  const out = CP.mergeImported({ text: { baseUrl: 'http://localhost:11434', apiKey: 'k' } }, imp, ['models', 'integration']);
  assert.strictEqual(out.text.baseUrl, 'http://localhost:11434');
  groups.slice(1).forEach((g) => assert.ok(!out[g] || !out[g].baseUrl, g + ' was not given the address'));
  const evil = JSON.parse('{"text":{"__proto__":{"polluted":1},"baseUrl":"https://evil.example"},"discordBridge":{"__proto__":{"polluted":1},"enabled":true}}');
  const merged = CP.mergeImported({ text: { baseUrl: 'http://localhost:11434' } }, evil, ['models', 'other']);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(merged.text.polluted, undefined);
  assert.strictEqual(merged.text.baseUrl, 'http://localhost:11434');
  assert.strictEqual(merged.discordBridge, undefined);
});

// ---- B24 (import side): an address whose key was left out of the export is "not included", not a new address ----
test('B24: "https://host/v1?key=" from a package without keys keeps the address (and the key) this PC has; a real change still asks', () => {
  const cur = { text: { baseUrl: 'https://h.example/v1?key=MINE&alt=json', model: 'm' }, scraps: { gitRemoteUrl: 'https://github.com/a/b.git?token=MINE' } };
  const blank = { text: { baseUrl: 'https://h.example/v1?key=&alt=json' }, scraps: { gitRemoteUrl: 'https://github.com/a/b.git?token=' } };
  assert.deepStrictEqual(CP.guardedChanges(cur, blank, ['models', 'sync']), [], 'the same address, without its secret');
  const out = CP.mergeImported(cur, blank, ['models', 'sync']);
  assert.strictEqual(out.text.baseUrl, 'https://h.example/v1?key=MINE&alt=json');
  assert.strictEqual(out.scraps.gitRemoteUrl, 'https://github.com/a/b.git?token=MINE', 'any string, not only the guarded ones');
  // another path, another parameter, or a value that is not blank: those are different addresses
  for (const url of ['https://h.example/v2?key=&alt=json', 'https://h.example/v1?key=&alt=xml', 'https://h.example/v1?key=NEW&alt=json', 'https://h.example/v1?alt=json', 'https://h.example/v1?key=&alt=json&x=1']) {
    assert.deepStrictEqual(CP.guardedChanges(cur, { text: { baseUrl: url } }, ['models']).map((c) => c.id), ['server:text'], url);
  }
  assert.strictEqual(CP.mergeImported({ scraps: { gitRemoteUrl: 'https://g/a?token=MINE' } }, { scraps: { gitRemoteUrl: 'https://g/b?token=' } }, ['sync']).scraps.gitRemoteUrl, 'https://g/b?token=', 'a different path is a real change');
});

// ---- B26: a package made on a Mac ----
const MAC_SHORTCUTS = {
  newTab: 'Cmd+N', find: 'Cmd+F', zenMode: 'Ctrl+Cmd+Z', toggleFullscreen: 'Ctrl+Cmd+F', minimize: 'Cmd+M', quickCapture: '', openSettings: 'Cmd+,', moveLineUp: 'Option+ArrowUp'
};
test('B26: on a PC that is not a Mac, shortcuts made on a Mac are not taken; Ctrl+Z, Ctrl+F and the quick-capture key stay', () => {
  const cur = { shortcuts: { zenMode: 'Shift+F11', toggleFullscreen: 'F11', find: 'Ctrl+F', quickCapture: 'Ctrl+Shift+Q', newTab: 'Ctrl+N' }, general: { theme: 'olive' } };
  const imp = { shortcuts: MAC_SHORTCUTS, general: { theme: 'blue' } };
  assert.strictEqual(CP.foreignShortcuts(imp, ['shortcuts'], { isMac: false }), true);
  const out = CP.mergeImported(cur, imp, ['general', 'shortcuts'], { isMac: false });
  assert.deepStrictEqual(out.shortcuts, cur.shortcuts, 'not one binding of the Mac package applies');
  assert.strictEqual(out.general.theme, 'blue', 'the rest of the package does');
  // on a Mac, and where the host does not say, the package is taken as before
  assert.strictEqual(CP.mergeImported(cur, imp, ['shortcuts'], { isMac: true }).shortcuts.zenMode, 'Ctrl+Cmd+Z');
  assert.strictEqual(CP.mergeImported(cur, imp, ['shortcuts']).shortcuts.zenMode, 'Ctrl+Cmd+Z');
  assert.strictEqual(CP.foreignShortcuts(imp, ['shortcuts'], { isMac: true }), false);
  assert.strictEqual(CP.foreignShortcuts(imp, ['general'], { isMac: false }), false, 'shortcuts were not chosen');
  // Windows-style shortcuts are ordinary
  const win = { shortcuts: { zenMode: 'Shift+F11', find: 'Ctrl+F', quickCapture: '', deleteLine: 'Ctrl+Shift+K', moveLineUp: 'Alt+ArrowUp' } };
  assert.strictEqual(CP.foreignShortcuts(win, ['shortcuts'], { isMac: false }), false);
  assert.strictEqual(CP.mergeImported(cur, win, ['shortcuts'], { isMac: false }).shortcuts.quickCapture, '', 'a Windows user may clear it on purpose');
  assert.strictEqual(CP.foreignShortcuts({ shortcuts: { a: '\u2318+S' } }, ['shortcuts'], { isMac: false }), true, 'the command sign counts');
  assert.strictEqual(CP.foreignShortcuts({ shortcuts: { a: 5, b: null, c: 'Ctrl+S' } }, ['shortcuts'], { isMac: false }), false, 'junk is not a Mac');
});

// ---- the dialog ----
const partnerInspect = () => packInspectInfo({
  manifest: { format: 'md-memo-pack', version: 1, createdAt: '2026-09-18T09:40:00+09:00', appVersion: '1.10.5', includesSecrets: false, configSections: ['models', 'integration', 'other'] },
  items: [{ id: 'config', kind: 'config', sections: ['models', 'integration', 'other'] }]
});
const partnerHarness = (over) => {
  const h = makeHarness(Object.assign({ config: localSetup() }, over || {}));
  fullBackend(h, { inspect: partnerInspect(), importResult: { ok: true, configJSON: JSON.stringify(partnerPackage()), applied: {}, skipped: [], needsRestart: true } });
  return h;
};
const titlesOf = (h) => body(h).findAll((n) => n.hasClass('pack-row-title')).map((n) => n.textContent);
const subOf = (h, title) => rowOf(h, title).find((n) => n.hasClass('pack-row-sub')).textContent;

test('B19: the import dialog says up front that these settings are never applied silently', async () => {
  const h = partnerHarness();
  await h.dialog.openImport();
  assert(body(h).textContent.includes(EN.packGuardHint));
});

test('B19: after Import the person sees the changes that need an OK, unticked, with before and after; the package is not applied yet', async () => {
  const h = partnerHarness();
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert(isOpen(h));
  assert.strictEqual(h.applied.length, 0, 'nothing has been applied while the question is open');
  assert(notes(h).includes(EN.packGuardIntro));
  const server = EN.packGuardServer.replace('{name}', EN.packGuardNameText);
  assert.deepStrictEqual(titlesOf(h), [server, EN.packGuardAgentConfirm, EN.sectionDiscordBridge, EN.sectionInbox]);
  titlesOf(h).forEach((t) => assert.strictEqual(inputOf(h, t).checked, false, t + ' starts unticked'));
  assert.strictEqual(subOf(h, server), 'https://api.openai.com/v1 \u2192 https://llm.partner-gateway.example/v1 \u00b7 gpt-4o-mini \u2192 partner-model');
  assert.strictEqual(subOf(h, EN.packGuardAgentConfirm), 'On \u2192 Off');
  assert.strictEqual(subOf(h, EN.sectionDiscordBridge), 'Off \u00b7 user 111 \u2192 On \u00b7 user 999999');
  assert.strictEqual(subOf(h, EN.sectionInbox), 'Off \u2192 On \u00b7 C:\\drop');
  assert.deepStrictEqual(rowOf(h, server).findAll((n) => n.hasClass('pack-tag')).map((n) => n.textContent), [EN.packGuardKeyTag], 'the key that would be removed is said');
  assert.strictEqual(confirmBtn(h).textContent, EN.packGuardApply);
  assert.strictEqual(cancelBtn(h).textContent, EN.packGuardSkip);
  assert(!confirmBtn(h).disabled);
});

test('B19: "Keep mine" (and Esc, and the close button) applies the rest of the package and holds the guarded settings back, and says which - also when rows were ticked', async () => {
  for (const how of ['button', 'escape', 'close']) {
    const h = partnerHarness();
    await h.dialog.openImport();
    confirmBtn(h).click();
    await settle();
    // Two rows are ticked before the person backs out: "no" is the safe answer, so leaving by any way applies none of what was ticked.
    inputOf(h, EN.packGuardServer.replace('{name}', EN.packGuardNameText)).click();
    inputOf(h, EN.sectionInbox).click();
    assert.strictEqual(inputOf(h, EN.packGuardServer.replace('{name}', EN.packGuardNameText)).checked, true, how + ': the server row is ticked');
    assert.strictEqual(inputOf(h, EN.sectionInbox).checked, true, how + ': the inbox row is ticked');
    if (how === 'button') cancelBtn(h).click();
    else if (how === 'escape') h.keyTarget.press('Escape');
    else h.doc.getElementById('pack-close').click();
    await settle();
    assert.strictEqual(h.applied.length, 1, how);
    const next = h.applied[0];
    assert.strictEqual(next.text.baseUrl, 'https://api.openai.com/v1', how);
    assert.strictEqual(next.text.apiKey, 'sk-LOCAL-SECRET', how);
    assert.strictEqual(next.text.model, 'gpt-4o-mini', how);
    assert.strictEqual(next.text.systemPrompt, 'Be brief.', how);
    assert.strictEqual(next.autoSelector.agentConfirm, true, how);
    assert.strictEqual(next.discordBridge.enabled, false, how);
    assert.strictEqual(next.inbox.enabled, false, how);
    const result = body(h).textContent;
    assert(result.includes(EN.packResultConfig.replace('{sections}', 'AI Models')), how + ': ' + result);
    const kept = EN.packResultGuardKept.replace('{names}', [EN.packGuardServer.replace('{name}', EN.packGuardNameText), EN.packGuardAgentConfirm, EN.sectionDiscordBridge, EN.sectionInbox].join(', '));
    assert(result.includes(kept), how + ': ' + result);
    assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleImport);
  }
});

test('B19: ticked rows are applied and only those; the result lists what was kept', async () => {
  const h = partnerHarness();
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  const server = EN.packGuardServer.replace('{name}', EN.packGuardNameText);
  inputOf(h, server).click();
  inputOf(h, EN.sectionInbox).click();
  confirmBtn(h).click();
  assert(confirmBtn(h).disabled && confirmBtn(h).textContent === EN.packBtnImporting, 'busy while it is applied');
  await settle();
  const next = h.applied[0];
  assert.strictEqual(next.text.baseUrl, 'https://llm.partner-gateway.example/v1');
  assert.strictEqual(next.text.apiKey, '', 'the key of the old host is gone');
  assert.deepStrictEqual(next.inbox, { enabled: true, dir: 'C:\\drop' });
  assert.strictEqual(next.autoSelector.agentConfirm, true);
  assert.strictEqual(next.discordBridge.enabled, false);
  const result = body(h).textContent;
  assert(result.includes(EN.packResultGuardKept.replace('{names}', EN.packGuardAgentConfirm + ', ' + EN.sectionDiscordBridge)), result);
  assert(result.includes(EN.packResultRestart));
  assert.strictEqual(h.messages.length, 1, 'one toast, after the whole import');
});

test('B19: the review shows addresses without credentials or query keys, and the package\'s own text only as text', async () => {
  const cfg = localSetup();
  cfg.text.baseUrl = 'https://alice:pw@old.example/v1?key=OLDSECRET';
  const h = makeHarness({ config: cfg });
  const evil = partnerPackage();
  evil.text.baseUrl = 'https://bob:hunter2@new.example/v1?api_key=NEWSECRET#x';
  evil.discordBridge.allowedUserId = '<b onmouseover=alert(1)>$&';
  fullBackend(h, { inspect: partnerInspect(), importResult: { ok: true, configJSON: JSON.stringify(evil), applied: {}, skipped: [] } });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  const text = body(h).textContent;
  assert(text.includes('https://old.example/v1 \u2192 https://new.example/v1'), text);
  ['alice', 'pw@', 'OLDSECRET', 'bob', 'hunter2', 'NEWSECRET'].forEach((s) => assert(!text.includes(s), s + ' must not be shown'));
  assert(text.includes('<b onmouseover=alert(1)>$&'), 'shown literally');
  const writes = [];
  body(h).walk((n) => n.htmlWrites.forEach((w) => writes.push(w)));
  assert(writes.every((w) => w.startsWith('<svg')), 'nothing from the package went through innerHTML');
});

test('B19: a package with no guarded change applies straight away, as before', async () => {
  const h = makeHarness({ config: localSetup() });
  fullBackend(h, { inspect: partnerInspect(), importResult: { ok: true, configJSON: JSON.stringify({ general: { theme: 'blue' }, text: { model: 'm2' } }), applied: {}, skipped: [] } });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.applied.length, 1);
  assert.strictEqual(h.doc.getElementById('pack-title').textContent, EN.packResultTitleImport);
  assert(!body(h).textContent.includes(EN.packResultGuardKept.replace('{names}', '')));
});

test('B19: the review speaks Japanese when the host does', async () => {
  const h = partnerHarness({ dict: JA });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert(notes(h).includes(JA.packGuardIntro));
  assert(rowOf(h, JA.packGuardServer.replace('{name}', JA.packGuardNameText)));
  assert.strictEqual(subOf(h, JA.packGuardAgentConfirm), 'オン \u2192 オフ');
  assert.strictEqual(cancelBtn(h).textContent, JA.packGuardSkip);
});

test('B19: if the settings cannot be written the result says so; if the app refuses them the error is reported', async () => {
  const h = partnerHarness();
  h.host.applyConfig = async (next) => { h.applied.push(next); return false; };
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  cancelBtn(h).click();
  await settle();
  assert(body(h).textContent.includes(EN.packResultConfigNotSaved));

  const h2 = partnerHarness({ applyThrows: 'storage is full' });
  await h2.dialog.openImport();
  confirmBtn(h2).click();
  await settle();
  cancelBtn(h2).click();
  await settle();
  assert(body(h2).textContent.includes(EN.packResultConfigFailed.replace('{err}', 'storage is full')));
});

test('B26: importing a Mac package on a PC that is not a Mac leaves the shortcuts alone and says so; on a Mac they are taken', async () => {
  const cfg = { shortcuts: { zenMode: 'Shift+F11', toggleFullscreen: 'F11', find: 'Ctrl+F', quickCapture: 'Ctrl+Shift+Q' }, general: { theme: 'olive' } };
  const info = packInspectInfo({
    manifest: { format: 'md-memo-pack', version: 1, configSections: ['shortcuts'] },
    items: [{ id: 'config', kind: 'config', sections: ['shortcuts'] }]
  });
  const mac = JSON.stringify({ shortcuts: MAC_SHORTCUTS });

  const h = makeHarness({ config: JSON.parse(JSON.stringify(cfg)) });
  fullBackend(h, { inspect: info, importResult: { ok: true, configJSON: mac, applied: {}, skipped: [] } });
  await h.dialog.openImport();
  confirmBtn(h).click();
  await settle();
  assert.strictEqual(h.applied.length, 0, 'nothing to apply: the only section was the Mac shortcuts');
  const text = body(h).textContent;
  assert(text.includes(EN.packResultShortcutsOtherOs), text);
  assert(!text.includes(EN.packResultConfigNone), 'the package did have shortcuts; they were not taken');

  const withGeneral = makeHarness({ config: JSON.parse(JSON.stringify(cfg)) });
  fullBackend(withGeneral, {
    inspect: packInspectInfo({ manifest: { format: 'md-memo-pack', version: 1, configSections: ['general', 'shortcuts'] }, items: [{ id: 'config', kind: 'config', sections: ['general', 'shortcuts'] }] }),
    importResult: { ok: true, configJSON: JSON.stringify({ general: { theme: 'blue' }, shortcuts: MAC_SHORTCUTS }), applied: {}, skipped: [] }
  });
  await withGeneral.dialog.openImport();
  confirmBtn(withGeneral).click();
  await settle();
  assert.deepStrictEqual(withGeneral.applied[0].shortcuts, cfg.shortcuts);
  assert.strictEqual(withGeneral.applied[0].general.theme, 'blue');
  assert(body(withGeneral).textContent.includes(EN.packResultConfig.replace('{sections}', 'General')));
  assert(body(withGeneral).textContent.includes(EN.packResultShortcutsOtherOs));

  const onMac = makeHarness({ config: JSON.parse(JSON.stringify(cfg)) });
  onMac.host.isMac = true;
  fullBackend(onMac, { inspect: info, importResult: { ok: true, configJSON: mac, applied: {}, skipped: [] } });
  await onMac.dialog.openImport();
  confirmBtn(onMac).click();
  await settle();
  assert.strictEqual(onMac.applied[0].shortcuts.zenMode, 'Ctrl+Cmd+Z');
  assert(!body(onMac).textContent.includes(EN.packResultShortcutsOtherOs));
});

test('every string the pack dialog asks for exists in English and Japanese with the same placeholders', () => {
  const src = fs.readFileSync(path.join(__dirname, 'config_pack.js'), 'utf8');
  const keys = new Set();
  const backendCalls = ['packListExportable', 'packExport', 'packInspect', 'packImport']; // methods of window.backend, not strings
  for (const m of src.matchAll(/'(pack[A-Za-z]+)'/g)) if (backendCalls.indexOf(m[1]) === -1) keys.add(m[1]);
  assert(keys.size > 60, 'found ' + keys.size);
  const ph = (s) => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keys) {
    assert.strictEqual(typeof EN[k], 'string', k + ' in English');
    assert.strictEqual(typeof JA[k], 'string', k + ' in Japanese');
    assert.strictEqual(ph(EN[k]), ph(JA[k]), k + ': same placeholders');
    assert(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(EN[k]), k + ': no Japanese in English');
  }
});

test('loading the module costs nothing: no globals touched but ConfigPack, no timers, no DOM', () => {
  const src = fs.readFileSync(path.join(__dirname, 'config_pack.js'), 'utf8');
  const touched = [];
  const win = new Proxy({}, {
    get(target, key) { touched.push(String(key)); throw new Error('the module read window.' + String(key) + ' at load time'); },
    set(target, key, value) { touched.push('set:' + String(key)); target[key] = value; return true; }
  });
  vm.runInNewContext(src, { window: win, setTimeout() { throw new Error('timer at load'); }, setInterval() { throw new Error('timer at load'); } });
  assert.deepStrictEqual(touched, ['set:ConfigPack']);
  assert.strictEqual(typeof CP.openExport, 'function');
});

pending.then(() => console.log('\nAll config pack tests PASSED!')).catch((e) => {
  console.error(e);
  process.exit(1);
});
