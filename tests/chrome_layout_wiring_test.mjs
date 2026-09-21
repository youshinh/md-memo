import fs from 'fs';
import vm from 'vm';
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== Toolbar / right-click layout: wiring tests ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8').replace(/\r\n/g, '\n');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8').replace(/\r\n/g, '\n');

// ---- markup ---------------------------------------------------------------------------------
const scriptAt = (name) => indexHtml.indexOf(`src="js/${name}`);
assert(scriptAt('chrome_layout.js') > 0, 'chrome_layout.js must be loaded');
assert(scriptAt('chrome_layout.js') < scriptAt('app.js'), 'it must load before app.js, which calls it');

const actionsStart = indexHtml.indexOf('<div id="header-actions">');
const actionsEnd = indexHtml.indexOf('</header>', actionsStart);
const actions = indexHtml.slice(actionsStart, actionsEnd);
const at = (id) => actions.indexOf(`id="${id}"`);
assert(at('btn-mobile-drop') > at('btn-header-llm') && at('btn-mobile-drop') < actions.indexOf('header-divider'),
  'the Mobile Drop button sits at the end of the first toolbar group');
assert(/id="btn-mobile-drop"[^>]*class="btn-header-icon"/.test(actions), 'it looks like the other toolbar icons');
assert(!/id="btn-mobile-drop"[^>]*data-i18n-title/.test(actions), 'its tooltip is built in JS, with the configured shortcut');
assert(/id="btn-mobile-drop"[\s\S]{0,400}<svg/.test(actions), 'it carries a line SVG icon');
assert(at('btn-settings') > 0, 'the Settings button stays in the toolbar');

const generalPane = indexHtml.slice(indexHtml.indexOf('id="pane-general"'), indexHtml.indexOf('id="pane-model"'));
for (const id of ['cfg-layout-details', 'cfg-layout-toolbar', 'cfg-layout-context', 'btn-layout-reset']) {
  assert(generalPane.includes(`id="${id}"`), `the General settings pane must contain #${id}`);
}
assert(/<details id="cfg-layout-details"/.test(generalPane), 'the editor is a collapsed <details>: nothing is built until it is opened');
assert(!/cfg-layout-toolbar[^>]*>\s*<[a-z]/.test(generalPane), 'the lists start empty in the markup (rows are built lazily)');

// ---- app.js wiring --------------------------------------------------------------------------
assert(/toolbarLayout:\s*\{ order: \[\], hidden: \[\] \}/.test(appJs) && /contextMenuLayout:\s*\{ order: \[\], hidden: \[\] \}/.test(appJs),
  'config.general defaults carry both layouts');

const body = (name) => {
  const start = appJs.indexOf(`function ${name}(`);
  assert(start > 0, `${name} not found`);
  const end = appJs.indexOf('\n  }\n', start);
  return appJs.slice(start, end);
};
for (const fn of ['loadLocalConfigSync', 'syncBackendConfig', 'applyImportedConfig', 'restoreLiveConfigFromSnapshot']) {
  assert(body(fn).includes('applyChromeLayout()'), `${fn} must (re)apply the layout`);
}
assert(/toolbarLayout[\s\S]{0,120}contextMenuLayout/.test(body('restoreLiveConfigFromSnapshot')), 'Cancel restores both layouts');
const ctxStart = appJs.indexOf("window.addEventListener('contextmenu'");
assert(ctxStart > 0, 'the window-level contextmenu handler must exist');
assert(/hasVisibleItems\('context'\)[\s\S]{0,160}return;/.test(appJs.slice(ctxStart, ctxStart + 500)),
  'the right-click handler skips a menu whose items are all hidden');
assert(appJs.includes("btnMobileDrop.onclick = () => startMobileDrop()"), 'the toolbar button starts Mobile Drop');

// Lazy: the editor is built only from its toggle, the reset button, and a language change while open.
const renderCalls = appJs.match(/renderLayoutEditors\(\)/g) || [];
assert.strictEqual(renderCalls.length, 4, 'renderLayoutEditors: definition + toggle + reset + language redraw, nothing at start-up');
assert(/layoutDetailsEl && layoutDetailsEl\.open\) renderLayoutEditors\(\)/.test(appJs), 'a language redraw only happens while the section is open');

// ---- i18n ------------------------------------------------------------------------------------
const context = { window: {} };
vm.createContext(context);
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const lang of ['en', 'ja']) {
  for (const key of ['sectionLayout', 'layoutSummary', 'layoutHint', 'layoutToolbar', 'layoutContext', 'layoutReset',
    'layoutMoveUp', 'layoutMoveDown', 'layoutAlwaysShown', 'mobileDropToolbarTitle']) {
    assert(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `I18N.${lang}.${key} must exist`);
    assert(!EMOJI.test(I18N[lang][key]), `I18N.${lang}.${key} must not contain an emoji`);
  }
}
for (const id of ['sectionLayout', 'layoutSummary', 'layoutHint', 'layoutToolbar', 'layoutContext', 'layoutReset']) {
  assert(indexHtml.includes(`data-i18n="${id}"`), `index.html must use ${id}`);
}
console.log('PASS: markup, wiring and strings are in place.');

// ---- the tooltip fix: the shortcut must appear once, and be the configured one -----------------
const require = createRequire(import.meta.url);
require('../frontend/js/chrome_layout.js');
const ChromeLayout = globalThis.ChromeLayout;

const fnStart = appJs.indexOf('  function updateShortcutLabels() {');
const fnEnd = appJs.indexOf('  let activeRecordingAction = null;', fnStart);
assert(fnStart > 0 && fnEnd > fnStart, 'updateShortcutLabels not found');
const updateSrc = appJs.slice(fnStart, fnEnd);

function runTooltips(lang, shortcuts, isPreviewMode = false) {
  const t = (key, params) => {
    let text = (I18N[lang] && I18N[lang][key]) || key;
    for (const [k, v] of Object.entries(params || {})) text = text.split(`{${k}}`).join(v);
    return text;
  };
  const buttons = Object.fromEntries(['btnNewTab', 'btnOpenFile', 'btnOpenFolder', 'btnSaveFile', 'btnFind', 'btnSearchScraps',
    'btnHeaderLLM', 'btnToggleSplit', 'btnTogglePreview', 'btnMobileDrop', 'btnVoiceInput', 'btnPreviewSide'].map((k) => [k, { title: '' }]));
  const factory = new Function('config', 't', 'isMac', 'formatShortcutForDisplay', 'window', 'document', 'isPreviewMode',
    'btnNewTab', 'btnOpenFile', 'btnOpenFolder', 'btnSaveFile', 'btnFind', 'btnSearchScraps', 'btnHeaderLLM', 'btnToggleSplit',
    'btnTogglePreview', 'btnMobileDrop', 'btnVoiceInput', 'btnPreviewSide', `${updateSrc}; return updateShortcutLabels;`);
  const update = factory({ shortcuts }, t, false, (s) => s, { ChromeLayout }, { getElementById: () => null }, isPreviewMode,
    buttons.btnNewTab, buttons.btnOpenFile, buttons.btnOpenFolder, buttons.btnSaveFile, buttons.btnFind, buttons.btnSearchScraps,
    buttons.btnHeaderLLM, buttons.btnToggleSplit, buttons.btnTogglePreview, buttons.btnMobileDrop, buttons.btnVoiceInput, buttons.btnPreviewSide);
  update();
  return Object.fromEntries(Object.entries(buttons).map(([k, v]) => [k, v.title]));
}

const shortcuts = { openFile: 'Ctrl+O', find: 'Ctrl+F', inlinePrompt: 'Ctrl+K', llmModal: 'Ctrl+L', mobileDrop: 'Ctrl+Shift+U', voiceInput: 'Ctrl+Shift+R', togglePreview: 'Ctrl+P' };
const en = runTooltips('en', shortcuts);
assert.strictEqual(en.btnOpenFile, 'Open File (Ctrl+O)', 'one shortcut, not "(Ctrl+O) (Ctrl+O)"');
assert.strictEqual(en.btnFind, 'Find & Replace (Ctrl+F)');
assert.strictEqual(en.btnHeaderLLM, 'Inline AI Assist (Ctrl+K / Ctrl+L)');
assert.strictEqual(en.btnMobileDrop, 'Mobile Drop (QR sync) (Ctrl+Shift+U)', 'the new button shows its shortcut');
const ja = runTooltips('ja', shortcuts);
assert.strictEqual(ja.btnOpenFile, 'ファイルを開く (Ctrl+O)');
assert.strictEqual(ja.btnMobileDrop, 'Mobile Drop（QR同期） (Ctrl+Shift+U)');
for (const title of [...Object.values(en), ...Object.values(ja)]) {
  assert(!/\(([^()]+)\) \(\1\)/.test(title), `a shortcut is repeated in the tooltip: ${title}`);
}
// a rebound shortcut is what the tooltip shows
assert.strictEqual(runTooltips('en', { ...shortcuts, openFile: 'Ctrl+Alt+O' }).btnOpenFile, 'Open File (Ctrl+Alt+O)');
// the voice-input button: one shortcut (the current binding, not the one baked into the i18n text), and none when cleared
assert.strictEqual(en.btnVoiceInput, 'Voice input (Ctrl+Shift+R)', 'the microphone button shows its shortcut once');
assert.strictEqual(ja.btnVoiceInput, '音声入力 (Ctrl+Shift+R)');
assert.strictEqual(runTooltips('en', { ...shortcuts, voiceInput: 'Ctrl+Alt+8' }).btnVoiceInput, 'Voice input (Ctrl+Alt+8)', 'a rebound shortcut is what the tooltip shows');
assert.strictEqual(runTooltips('ja', { ...shortcuts, voiceInput: 'Ctrl+Alt+9' }).btnVoiceInput, '音声入力 (Ctrl+Alt+9)');
assert.strictEqual(runTooltips('en', { ...shortcuts, voiceInput: '' }).btnVoiceInput, 'Voice input', 'an unassigned shortcut leaves the bare label, not a stale default');
assert.strictEqual(ChromeLayout.stripShortcut(en.btnVoiceInput), 'Voice input', 'the layout editor label is clean');
assert.strictEqual(ChromeLayout.stripShortcut(ja.btnVoiceInput), '音声入力');
// ...and the settings editor's labels (the tooltip minus its shortcut) come out clean
assert.strictEqual(ChromeLayout.stripShortcut(en.btnHeaderLLM), 'Inline AI Assist');
assert.strictEqual(ChromeLayout.stripShortcut(en.btnMobileDrop), 'Mobile Drop (QR sync)');
assert.strictEqual(ChromeLayout.stripShortcut(ja.btnMobileDrop), 'Mobile Drop（QR同期）');
console.log('PASS: toolbar tooltips show one, configured shortcut and yield clean labels.');

console.log('\nAll toolbar / right-click layout wiring tests PASSED!');
