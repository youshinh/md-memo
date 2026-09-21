// Wiring tests for the settings package (export / import) feature:
//   - the dialog markup in index.html (ids, stacking, script order)
//   - app.js hands the dialog what it needs and no longer uses the old single-file bindings
//   - applyImportedConfig (the one place a merged config is put into the live app), run against stubs
//   - i18n: en/ja parity for every pack* string, every key used exists, no emoji
//   - CSS: every pack-* class the script uses is styled, long lists scroll inside the dialog
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const appJs = read('frontend/js/app.js');
const i18nJs = read('frontend/js/i18n.js');
const packJs = read('frontend/js/config_pack.js');
const css = read('frontend/css/style.css');

let failures = 0;
let chain = Promise.resolve();
function check(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (err) {
      failures++;
      console.error(`FAIL: ${name}\n  ${err.message}`);
    }
  });
}

const context = vm.createContext({});
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found`);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.slice(start, i + 1);
}

// ---------------------------------------------------------------------------------------------------
check('index.html: the dialog shell exists once, hidden, and stacks above the Settings dialog', () => {
  for (const id of ['pack-modal', 'pack-title', 'pack-body', 'pack-confirm', 'pack-cancel', 'pack-close']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} must exist exactly once`);
  }
  assert.match(html, /<div id="pack-modal" class="modal-backdrop hidden">/, 'starts hidden, styled like every other modal');
  const settingsAt = html.indexOf('id="settings-modal"');
  const packAt = html.indexOf('id="pack-modal"');
  assert.ok(settingsAt > 0 && packAt > settingsAt, 'placed after the Settings modal, so it stacks above it (same z-index, later in the DOM)');
  assert.ok(packAt < html.indexOf('<script'), 'inside the app container, before the scripts');
  const shell = html.slice(packAt, html.indexOf('<!-- Go To Line Modal -->'));
  assert.doesNotMatch(shell.replace('✕', ''), EMOJI, 'no emoji in the markup (the close glyph is the only symbol)');
  assert.match(shell, /id="pack-close"[^>]*>✕</, 'the allowed close glyph, like the other small modals');
  assert.doesNotMatch(shell, /data-i18n/, 'the dialog texts are set when it opens, not by the page-wide translator');
  assert.ok(html.includes('id="btn-export-settings"') && html.includes('id="btn-import-settings"'), 'the two Settings buttons stay');
});

check('index.html: config_pack.js loads after i18n.js and before app.js, with the usual ?v= pattern', () => {
  const at = (f) => html.indexOf(`js/${f}?v=`);
  assert.ok(at('config_pack.js') > 0, 'script tag present');
  assert.ok(at('i18n.js') < at('config_pack.js') && at('config_pack.js') < at('app.js'));
  assert.match(html, /<script src="js\/config_pack\.js\?v=\d+\.\d+\.\d+"><\/script>/);
});

check('app.js: Export / Import open the dialog and nothing else touches ConfigPack (it costs nothing until then)', () => {
  const lines = appJs.split('\n').filter((l) => l.includes('ConfigPack') && !l.trim().startsWith('//'));
  assert.deepEqual(lines.map((l) => l.trim()), [
    'if (window.ConfigPack) window.ConfigPack.openExport(packHost());',
    'if (window.ConfigPack) window.ConfigPack.openImport(packHost());'
  ]);
  assert.match(appJs, /btnExportSettings\.onclick = \(\) => \{\s*if \(window\.ConfigPack\)/);
  assert.match(appJs, /btnImportSettings\.onclick = \(\) => \{\s*if \(window\.ConfigPack\)/);
  const host = extractFunction(appJs, 'packHost');
  for (const piece of ['getConfig: () => config', 'getProjectHint: getNoteDir', 'applyConfig: applyImportedConfig', 't: t', 'showMessage: showMessage']) {
    assert.ok(host.includes(piece), `packHost must provide ${piece}`);
  }
  assert.ok(host.includes('refreshAgents: checkActiveAgentsConfigStatus'), 'agent list refresh after an import');
});

check('app.js: the old single-file bindings are no longer called by the buttons', () => {
  assert.doesNotMatch(appJs, /backend\.exportConfig|backend\.importConfig/);
  assert.doesNotMatch(appJs, /md-memo-config\.json/, 'the browser blob-download fallback went with them');
});

check('config_pack.js: nothing is created at load, everything is behind the dialog', () => {
  const top = packJs.split('\n').filter((l) => /^  [A-Za-z]/.test(l) && !/^  (const|let|function|\/\/|'use strict')/.test(l));
  assert.deepEqual(top.filter((l) => !/^  (global\.|if \(typeof module|const api)/.test(l)), [], 'no top-level statements besides the definitions and the export');
  assert.doesNotMatch(packJs, /setInterval|requestAnimationFrame|MutationObserver|localStorage|fetch\(/);
  assert.doesNotMatch(packJs.replace(/global\.document/g, ''), /\bdocument\./, 'the DOM is reached only through the injected doc');
});

// ---------------------------------------------------------------------------------------------------
// applyImportedConfig: the merged config goes into the live app here.
function runApply(opts) {
  opts = opts || {};
  const calls = [];
  const rec = (name) => (...a) => { calls.push(name); return opts[name] ? opts[name](...a) : undefined; };
  const config = opts.config || {
    general: { theme: 'olive', language: 'en' },
    text: { model: 'a', apiKey: 'keep' },
    shortcuts: { globalSummon: 'Ctrl+Alt+M', zenMode: 'Shift+F11' }
  };
  const messages = [];
  const globals = {
    config,
    DEFAULT_SHORTCUTS: { globalSummon: 'Ctrl+Alt+M', zenMode: 'Shift+F11', newDefault: 'Ctrl+Q' },
    hasPersistedImeGuardianSetting: false,
    migrateInsertLineShortcuts: rec('migrateInsertLineShortcuts'),
    migrateZenShortcut: rec('migrateZenShortcut'),
    migrateAskShortcuts: rec('migrateAskShortcuts'),
    migrateMacShortcuts: rec('migrateMacShortcuts'),
    migrateFullscreenShortcut: rec('migrateFullscreenShortcut'),
    applyTheme: rec('applyTheme'),
    applyLanguage: rec('applyLanguage'),
    applyChromeLayout: rec('applyChromeLayout'),
    openSettings: rec('openSettings'),
    updateShortcutLabels: rec('updateShortcutLabels'),
    updateActionStatus: rec('updateActionStatus'),
    clearShortcutParseCache: rec('clearShortcutParseCache'),
    renderShortcutsTable: rec('renderShortcutsTable'),
    savePersistentConfig: () => { calls.push('savePersistentConfig'); return Promise.resolve('saved'); },
    showMessage: (m) => messages.push(m),
    t: (k) => k,
    console: { warn() {} },
    Promise,
    window: {
      SlotAgent: { updateConfig: (c) => { calls.push('SlotAgent.updateConfig'); globals.slotConfigSeen = c; } },
      backend: opts.noBackend ? undefined : { updateGlobalShortcut: (c) => { calls.push('updateGlobalShortcut:' + c); return Promise.resolve(opts.registerOk === false ? false : true); } }
    }
  };
  const ctx = vm.createContext(globals);
  vm.runInContext(`${extractFunction(appJs, 'applyImportedConfig')}\nthis.__apply = applyImportedConfig;`, ctx);
  return { ctx, calls, config, messages, globals };
}

check('applyImportedConfig: puts changed top-level keys into the live config and re-applies everything once', async () => {
  const r = runApply();
  const next = { general: { theme: 'forest', language: 'en' }, text: r.config.text, shortcuts: { zenMode: 'Ctrl+Alt+Z' }, added: 1 };
  const promise = r.ctx.__apply(next);
  assert.ok(promise && typeof promise.then === 'function', 'returns the save promise');
  assert.equal(r.config.general.theme, 'forest');
  assert.strictEqual(r.config.text, next.text, 'unchanged keys are left alone');
  assert.equal(r.config.added, 1);
  assert.equal(r.config.shortcuts.zenMode, 'Ctrl+Alt+Z');
  assert.equal(r.config.shortcuts.newDefault, 'Ctrl+Q', 'shortcuts are laid over the defaults, so a newer action keeps its default');
  const order = ['migrateInsertLineShortcuts', 'migrateZenShortcut', 'migrateAskShortcuts', 'migrateMacShortcuts', 'migrateFullscreenShortcut', 'SlotAgent.updateConfig', 'applyTheme', 'applyLanguage', 'applyChromeLayout', 'openSettings', 'updateShortcutLabels', 'updateActionStatus', 'savePersistentConfig'];
  assert.deepEqual(r.calls, order, 'every re-apply hook, in order, exactly once');
  assert.strictEqual(r.globals.slotConfigSeen, r.config);
  assert.equal(await promise, 'saved');
});

check('applyImportedConfig: a changed global shortcut is re-registered with the OS, and rolled back if refused', async () => {
  const r = runApply();
  await r.ctx.__apply({ shortcuts: { globalSummon: 'Ctrl+Shift+M' } });
  assert.ok(r.calls.includes('updateGlobalShortcut:Ctrl+Shift+M'));

  const same = runApply();
  await same.ctx.__apply({ shortcuts: { globalSummon: 'Ctrl+Alt+M' } });
  assert.ok(!same.calls.some((c) => c.startsWith('updateGlobalShortcut')), 'unchanged: no OS call');

  const refused = runApply({ registerOk: false });
  await refused.ctx.__apply({ shortcuts: { globalSummon: 'Ctrl+Shift+M' } });
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(refused.config.shortcuts.globalSummon, 'Ctrl+Alt+M', 'the previous summon key comes back');
  assert.deepEqual(refused.messages, ['globalShortcutRegisterFailed']);
  assert.ok(refused.calls.filter((c) => c === 'savePersistentConfig').length === 2, 'and the rollback is saved');

  const none = runApply({ noBackend: true });
  await none.ctx.__apply({ shortcuts: { globalSummon: 'Ctrl+Shift+M' } });
});

check('applyImportedConfig: rejects a non-object, and never writes __proto__ into the live config', () => {
  const r = runApply();
  assert.throws(() => r.ctx.__apply(null), /Invalid config format/);
  assert.throws(() => r.ctx.__apply('{"a":1}'), /Invalid config format/);
  assert.deepEqual(r.calls, [], 'nothing was touched');
  r.ctx.__apply(JSON.parse('{"__proto__": {"polluted": 1}, "general": {"theme": "blue", "language": "en"}}'));
  assert.equal(r.config.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(r.config.general.theme, 'blue');
});

// ---------------------------------------------------------------------------------------------------
check('i18n: every pack* string exists in en and ja with the same placeholders, and none has an emoji', () => {
  const keys = (lang) => Object.keys(I18N[lang]).filter((k) => k.startsWith('pack'));
  const en = keys('en');
  const ja = keys('ja');
  assert.ok(en.length >= 60, 'the strings are there');
  assert.deepEqual([...en].sort(), [...ja].sort(), 'en and ja have exactly the same pack* keys');
  const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of en) {
    assert.equal(typeof I18N.en[k], 'string');
    assert.ok(I18N.en[k].trim() && I18N.ja[k].trim(), `${k} is not empty`);
    assert.equal(placeholders(I18N.en[k]), placeholders(I18N.ja[k]), `${k}: same {placeholders} in both languages`);
    assert.doesNotMatch(I18N.en[k] + I18N.ja[k], EMOJI, `${k} has no emoji`);
    assert.doesNotMatch(I18N.en[k], /[\u3040-\u30ff\u4e00-\u9fff]/, `${k}: the English text is English`);
  }
  assert.match(I18N.ja.packExportTitle, /パッケージ/);
});

check('i18n: every key config_pack.js asks for exists, and every pack* key is used', () => {
  const backendNames = new Set(['packListExportable', 'packExport', 'packInspect', 'packImport']);
  const used = new Set([...packJs.matchAll(/'((?:pack[A-Z]\w*)|btnCancel)'/g)].map((m) => m[1]).filter((k) => !backendNames.has(k)));
  assert.ok(used.size >= 60);
  for (const k of used) {
    assert.ok(I18N.en[k] !== undefined, `en.${k} is used by config_pack.js but missing`);
    assert.ok(I18N.ja[k] !== undefined, `ja.${k} is used by config_pack.js but missing`);
  }
  for (const k of Object.keys(I18N.en).filter((x) => x.startsWith('pack'))) {
    assert.ok(used.has(k), `${k} is defined but never used`);
  }
  assert.ok(I18N.en.btnCancel && I18N.ja.btnCancel);
});

check('no emoji anywhere in the new code (icons are inline line SVG)', () => {
  assert.doesNotMatch(packJs, EMOJI);
  assert.doesNotMatch(read('frontend/js/config_pack_test.js'), EMOJI);
  const block = css.slice(css.indexOf('Settings package (export / import) dialog'));
  assert.doesNotMatch(block, EMOJI);
  const svgs = [...packJs.matchAll(/SVG_OPEN \+ '([^']*)'/g)];
  assert.equal(svgs.length, 4, 'four icons: ok, warn, info, pack');
  assert.match(packJs, /viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/);
});

// ---------------------------------------------------------------------------------------------------
check('css: every pack-* class the script uses is styled, and long lists scroll inside the dialog', () => {
  const ids = new Set(['pack-modal', 'pack-title', 'pack-body', 'pack-confirm', 'pack-cancel', 'pack-close', 'pack-format', 'pack-include-keys']);
  const classes = new Set([...packJs.matchAll(/'([^']*\bpack-[a-z-]+[^']*)'/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('pack-') && !ids.has(c)));
  assert.ok(classes.size >= 20, 'found the class names');
  for (const c of classes) assert.ok(css.includes(`.${c}`), `.${c} is used by config_pack.js but has no CSS rule`);
  const card = css.match(/#pack-modal \.modal-card \{[^}]*\}/)[0];
  assert.match(card, /max-height:\s*\d+vh/);
  assert.match(card, /display:\s*flex/);
  assert.match(card, /flex-direction:\s*column/);
  const bodyRule = css.match(/#pack-body \{[^}]*\}/)[0];
  assert.match(bodyRule, /overflow-y:\s*auto/);
  assert.match(bodyRule, /min-height:\s*0/, 'the flex child can shrink, so it scrolls instead of overflowing');
  assert.match(css, /\.pack-row-sub \{[^}]*overflow-wrap:\s*anywhere/, 'long paths wrap instead of widening the dialog');
  assert.match(css, /\.pack-selectable \{[^}]*user-select:\s*text/, 'result paths can be selected and copied');
});

await chain;
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll config pack wiring checks PASSED!');
