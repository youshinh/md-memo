// Unit tests for semantic_settings.js: the pure helpers (the section a form makes, what changed, how the index is described, which
// button may be pressed) and the load / save round trip over a small fake DOM. The whole screen (mock backend, real page) is
// tests/smoke/102_settings_semantic.mjs.
const assert = require('assert');

global.window = global;
const S = require('./semantic_settings.js');

const T = {
  semanticIndexOff: 'off', semanticIndexNone: 'none', semanticIndexUpToDate: 'up to date', semanticIndexDamaged: 'damaged',
  semanticIndexRebuildNeeded: 'rebuild', semanticJoin: ' ',
  semanticIndexFolderMissing: 'missing {dir}', semanticIndexBuilt: '{chunks} passages from {files} notes, {size}, {updated}.',
  semanticIndexLag: '{added} new, {changed} changed, {removed} removed.'
};
const t = (key, p) => {
  let s = T[key] === undefined ? key : T[key];
  Object.keys(p || {}).forEach((k) => { s = s.split('{' + k + '}').join(String(p[k])); });
  return s;
};

(function testFormatters() {
  assert.strictEqual(S.formatSize(0), '0 B');
  assert.strictEqual(S.formatSize(2048), '2 KB');
  assert.strictEqual(S.formatSize(3355443), '3.2 MB');
  assert.strictEqual(S.formatSize(5 * 1024 ** 3), '5.0 GB');
  assert.strictEqual(S.formatWhen('2026-10-03T08:37:12+09:00'), '2026-10-03 08:37');
  assert.strictEqual(S.formatWhen(''), '');
  assert.strictEqual(S.today(new Date(2026, 0, 5)), '2026-01-05');
})();

(function testBuildSectionKeepsWhatTheScreenDoesNotShow() {
  const saved = { enabled: false, model: { baseUrl: 'x', model: 'y', dimensions: 256 }, schedule: { settleMinutes: 5 }, privacy: { excludeKinds: ['ai'], cloudConsent: { 'old.example': '2026-09-01' } } };
  const form = { enabled: true, baseUrl: ' http://localhost:11434 ', model: ' bge-m3 ', apiKey: '' };
  const s = S.buildSection(saved, form, '', false, new Date(2026, 9, 3));
  assert.strictEqual(s.enabled, true);
  assert.deepStrictEqual(s.model, { baseUrl: 'http://localhost:11434', model: 'bge-m3', dimensions: 256 }, 'the dimensions stay; the fields are trimmed');
  assert.deepStrictEqual(s.schedule, { settleMinutes: 5 });
  assert.deepStrictEqual(s.privacy.excludeKinds, ['ai']);
  assert.deepStrictEqual(s.privacy.cloudConsent, { 'old.example': '2026-09-01' }, 'no host given: the consents are as they were');
  assert.strictEqual(saved.model.baseUrl, 'x', 'the saved object is not changed');
  // a key typed: kept; a key emptied: removed
  assert.strictEqual(S.buildSection(null, { enabled: true, baseUrl: 'a', model: 'b', apiKey: 'sk-1' }, '', false).model.apiKey, 'sk-1');
  assert.strictEqual('apiKey' in S.buildSection({ model: { apiKey: 'sk-0' } }, { enabled: true, baseUrl: 'a', model: 'b', apiKey: '' }, '', false).model, false);
})();

(function testConsentIsPerHost() {
  const base = { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' };
  const allowed = S.buildSection({ privacy: { cloudConsent: { 'other.example': '2026-09-01' } } }, base, 'api.example.com', true, new Date(2026, 9, 3));
  assert.deepStrictEqual(allowed.privacy.cloudConsent, { 'other.example': '2026-09-01', 'api.example.com': '2026-10-03' });
  // allowed before: the date stays (it is the day it was allowed)
  const again = S.buildSection(allowed, base, 'api.example.com', true, new Date(2026, 11, 24));
  assert.strictEqual(again.privacy.cloudConsent['api.example.com'], '2026-10-03');
  // taken back: only that host goes
  const withdrawn = S.buildSection(allowed, base, 'api.example.com', false);
  assert.deepStrictEqual(withdrawn.privacy.cloudConsent, { 'other.example': '2026-09-01' });
})();

(function testEssenceTellsWhetherAnythingChanged() {
  const a = { enabled: true, model: { baseUrl: 'u', model: 'm' }, privacy: { cloudConsent: { h: '2026-10-03' } } };
  const sameButOtherKeys = { enabled: true, model: { baseUrl: ' u ', model: 'm', dimensions: 9 }, schedule: {}, privacy: { cloudConsent: { h: '2026-12-01' } } };
  assert.strictEqual(S.essence(a), S.essence(sameButOtherKeys), 'keys the screen does not show, and the date of a consent, are not changes');
  assert.notStrictEqual(S.essence(a), S.essence(Object.assign({}, a, { enabled: false })));
  assert.notStrictEqual(S.essence(a), S.essence({ enabled: true, model: { baseUrl: 'u', model: 'm' }, privacy: { cloudConsent: {} } }), 'a consent withdrawn is a change');
  assert.strictEqual(S.essence(null), S.essence({}), 'no section is an off section with nothing in it');
})();

(function testParseCode() {
  assert.deepStrictEqual(S.parseCode(new Error('cancelled')).code, 'cancelled');
  assert.deepStrictEqual(S.parseCode(new Error('locked')).code, 'locked');
  assert.deepStrictEqual(S.parseCode(new Error('not_enabled')).code, 'not_enabled');
  const c = S.parseCode(new Error('consent_required: api.example.com'));
  assert.deepStrictEqual([c.code, c.rest], ['consent_required', 'api.example.com']);
  const q = S.parseCode(new Error('confirm_required: 1500 chunk texts to api.example.com'));
  assert.strictEqual(q.code, 'confirm_required');
  assert.deepStrictEqual(S.parseConfirm(q.rest), { texts: 1500, host: 'api.example.com' });
  assert.strictEqual(S.parseCode(new Error('the model answered 500')).code, '', 'a sentence is not a code');
  assert.strictEqual(S.parseCode(new Error('cancelled by the user, probably')).code, '', 'a code is the whole first word before a colon, nothing else');
  assert.strictEqual(S.parseCode(null).code, '');
})();

(function testDescribeIndex() {
  const built = { enabled: true, exists: true, chunks: 412, files: 53, size_bytes: 3355443, updated: '2026-10-03T08:37:00+09:00' };
  assert.deepStrictEqual(S.describeIndex({ enabled: false }, t), { text: 'off', kind: 'note' });
  assert.strictEqual(S.describeIndex({ enabled: true, folder_missing: true, scrap_dir: 'D:\\n' }, t).kind, 'warn');
  assert.deepStrictEqual(S.describeIndex({ enabled: true }, t), { text: 'none', kind: 'note' });
  assert.strictEqual(S.describeIndex({ enabled: true, corrupt: true }, t).text, 'damaged');
  assert.deepStrictEqual(S.describeIndex(built, t), { text: '412 passages from 53 notes, 3.2 MB, 2026-10-03 08:37. up to date', kind: 'ok' });
  const lag = S.describeIndex(Object.assign({ new_files: 2, changed_files: 1, removed_files: 0 }, built), t);
  assert.strictEqual(lag.kind, 'note');
  assert.ok(lag.text.endsWith('2 new, 1 changed, 0 removed.'), lag.text);
  const old = S.describeIndex(Object.assign({ rebuild_needed: true, new_files: 5 }, built), t);
  assert.strictEqual(old.kind, 'warn');
  assert.ok(old.text.endsWith('rebuild'), 'a rebuild is said before the lag: it is the thing to do');
  assert.ok(!S.describeIndex(built, (k, p) => (k === 'semanticJoin' ? '' : t(k, p))).text.includes('. up'), 'the join is the language\'s own (Japanese has no space)');
})();

(function testAllowedActions() {
  const ok = { enabled: true, model: 'ollama:bge-m3', local: true, exists: true };
  assert.deepStrictEqual(S.allowedActions(ok, false), { update: true, rebuild: true });
  assert.deepStrictEqual(S.allowedActions(ok, true), { update: false, rebuild: false }, 'nothing while it runs');
  assert.deepStrictEqual(S.allowedActions({ enabled: true, model: 'm', local: true }, false), { update: true, rebuild: false }, 'nothing to make again before the first update');
  assert.deepStrictEqual(S.allowedActions({ enabled: true, model: 'm', local: true, corrupt: true }, false), { update: false, rebuild: true }, 'a damaged index is made again, not updated');
  assert.deepStrictEqual(S.allowedActions(Object.assign({}, ok, { enabled: false }), false), { update: false, rebuild: false });
  assert.deepStrictEqual(S.allowedActions(Object.assign({}, ok, { model: '' }), false), { update: false, rebuild: false });
  assert.deepStrictEqual(S.allowedActions({ enabled: true, model: 'm', local: false, consent_given: false, exists: true }, false), { update: false, rebuild: false }, 'a host that is not allowed: nothing is sent');
  assert.deepStrictEqual(S.allowedActions({ enabled: true, model: 'm', local: false, consent_given: true, exists: true }, false), { update: true, rebuild: true });
  assert.deepStrictEqual(S.allowedActions(null, false), { update: false, rebuild: false });
})();

// ---- load and save over a fake DOM ---------------------------------------------------------------

function fakeEl(initial) {
  const classes = new Set(['hidden']);
  return Object.assign({
    value: '', checked: false, textContent: '', disabled: false,
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    addEventListener() {}
  }, initial || {});
}
const IDS = ['cfg-semantic-enabled', 'cfg-semantic-base-url', 'cfg-semantic-model', 'cfg-semantic-api-key', 'cfg-semantic-consent', 'semantic-consent-group',
  'semantic-consent-label', 'semantic-consent-note', 'semantic-destination', 'semantic-index-status', 'semantic-index-progress', 'semantic-index-result',
  'btn-semantic-update', 'btn-semantic-rebuild', 'btn-semantic-go', 'btn-semantic-cancel'];
function fakeDoc() {
  const els = {};
  IDS.forEach((id) => { els[id] = fakeEl(); });
  return { els, getElementById: (id) => els[id] || null };
}

(function testLoadAndSaveRoundTrip() {
  const doc = fakeDoc();
  const status = { enabled: true, model: 'ollama:bge-m3', local: true, consent_given: true, destination: '127.0.0.1:11434', exists: false };
  const asked = [];
  const backend = { semanticStatus: (section) => { asked.push(JSON.parse(JSON.stringify(section))); return Promise.resolve(status); } };
  S.init({ t, backend, doc });

  // nothing saved: the screen is empty and off, and saving without touching writes nothing
  const config = {};
  S.load(config);
  assert.strictEqual(doc.els['cfg-semantic-enabled'].checked, false);
  assert.strictEqual(doc.els['cfg-semantic-base-url'].value, '');
  S.save(config);
  assert.ok(!('semantic' in config), 'untouched: no semantic key');

  // typed: written, and the key the screen does not show survives
  const config2 = { semantic: { enabled: false, model: { baseUrl: 'http://h:1', model: 'm1' }, schedule: { settleMinutes: 7 } } };
  S.load(config2);
  assert.strictEqual(doc.els['cfg-semantic-base-url'].value, 'http://h:1');
  doc.els['cfg-semantic-enabled'].checked = true;
  doc.els['cfg-semantic-model'].value = 'bge-m3';
  S.save(config2);
  assert.strictEqual(config2.semantic.enabled, true);
  assert.strictEqual(config2.semantic.model.model, 'bge-m3');
  assert.deepStrictEqual(config2.semantic.schedule, { settleMinutes: 7 });
  // saved again with nothing new: left as it is (the same object content, no churn)
  const snapshot = JSON.stringify(config2.semantic);
  S.save(config2);
  assert.strictEqual(JSON.stringify(config2.semantic), snapshot);
  // loading looks at the index with the section the screen holds
  assert.ok(asked.some((sec) => sec.model.baseUrl === 'http://h:1' && sec.enabled === false), 'the look at the index was for the section as saved');
})();

console.log('semantic_settings tests passed');
