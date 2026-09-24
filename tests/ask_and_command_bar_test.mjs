// Ask bar (Ctrl+L), LLM tasks, command bar (Ctrl+E), the Auto selector settings and the shortcut migrations.
//   - defaults, reserved lists and the shortcut editor
//   - migrateAskShortcuts (saved Ctrl+K moves, the prompt dialog's binding is dropped)
//   - the whole of app.js run against a hand-made DOM: keys, ask-bar target chip, quick ask, startLlmTask /
//     cancelLlmTask, openAskBar(onSubmit), the command bar's remembered mode, presets, settings defaults
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const appCode = read('frontend/js/app.js');
const i18nCode = read('frontend/js/i18n.js');
const indexHtml = read('frontend/index.html');
const styleCss = read('frontend/css/style.css');
const chromeLayoutCode = read('frontend/js/chrome_layout.js');
const mermaidToneCode = read('frontend/js/mermaid_tone.js');

const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const queue = [];
function check(name, fn) {
  queue.push({ name, fn });
}
class Skip extends Error {}

// Objects and arrays built inside a vm context have another realm's prototypes: assert.deepEqual (strict) would
// reject them, so they are copied into this realm first.
const plain = (value) => JSON.parse(JSON.stringify(value));

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

function extractConst(source, name, open, close) {
  const start = source.indexOf(`const ${name} = ${open}`);
  assert.ok(start !== -1, `const ${name} not found in source`);
  const from = source.indexOf(open, start);
  let depth = 0;
  let i = from;
  for (; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1) + ';';
}
const extractConstObject = (source, name) => extractConst(source, name, '{', '}');
const extractConstArray = (source, name) => extractConst(source, name, '[', ']');

function evalConst(code, name) {
  const context = vm.createContext({ console });
  vm.runInContext(`${code}\nglobalThis.__out = ${name};`, context);
  return context.__out;
}

const defaultsWin = evalConst(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'), 'DEFAULT_SHORTCUTS_WIN');
const defaultsMac = evalConst(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'), 'DEFAULT_SHORTCUTS_MAC');
const shortcutGroups = evalConst(extractConstArray(appCode, 'SHORTCUT_GROUPS'), 'SHORTCUT_GROUPS');

function loadReserved(isMac) {
  const code = [
    extractFunction(appCode, 'normalizeComboForCompare'),
    extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_WIN'),
    extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_MAC'),
    extractFunction(appCode, 'getReservedSystemShortcuts'),
    extractFunction(appCode, 'isReservedSystemShortcut')
  ].join('\n');
  const context = vm.createContext({ console, isMac });
  vm.runInContext(`${code}\nglobalThis.__reserved = isReservedSystemShortcut;\nglobalThis.__norm = normalizeComboForCompare;`, context);
  return { isReserved: context.__reserved, norm: context.__norm };
}

// ---------------------------------------------------------------------------------------------------
// 1. Defaults, reserved lists, shortcut editor
// ---------------------------------------------------------------------------------------------------
check('defaults: the ask bar is on Ctrl/Cmd+L, the prompt dialog action is gone, the command bar is on Ctrl/Cmd+E', () => {
  assert.equal(defaultsWin.inlinePrompt, 'Ctrl+L');
  assert.equal(defaultsMac.inlinePrompt, 'Cmd+L');
  assert.equal(defaultsWin.commandBar, 'Ctrl+E');
  assert.equal(defaultsMac.commandBar, 'Cmd+E');
  assert.ok(!('llmModal' in defaultsWin) && !('llmModal' in defaultsMac), 'llmModal is not an action any more');
  assert.equal(defaultsWin.runCliFilter, '', 'the mode-specific keys are empty on a new install');
  assert.equal(defaultsWin.runAiCli, '');
  assert.equal(defaultsMac.runCliFilter, '');
  assert.equal(defaultsMac.runAiCli, '');
});

check('defaults: no two actions share a default combo, and Ctrl+K is free again', () => {
  // Ctrl and Cmd are different keys on macOS (Ctrl+Cmd+F is not Cmd+F), so they are compared as written there.
  const exact = (combo) => combo.split('+').map((p) => p.trim().toLowerCase()).sort().join('+');
  for (const [name, defaults, isMac] of [['win', defaultsWin, false], ['mac', defaultsMac, true]]) {
    const { norm, isReserved } = loadReserved(isMac);
    const same = isMac ? exact : norm;
    const seen = new Map();
    for (const [action, combo] of Object.entries(defaults)) {
      if (!combo) continue;
      const key = same(combo);
      assert.ok(!seen.has(key), `${name}: ${action} and ${seen.get(key)} both default to ${combo}`);
      seen.set(key, action);
    }
    for (const combo of ['Ctrl+K', 'Ctrl+L', 'Ctrl+E']) {
      assert.equal(isReserved(combo), false, `${name}: ${combo} must stay assignable`);
    }
    assert.ok(!seen.has(same(isMac ? 'Cmd+K' : 'Ctrl+K')), `${name}: nothing defaults to Ctrl/Cmd+K any more`);
    assert.equal(seen.get(same(isMac ? 'Cmd+L' : 'Ctrl+L')), 'inlinePrompt');
    assert.equal(seen.get(same(isMac ? 'Cmd+E' : 'Ctrl+E')), 'commandBar');
  }
});

check('the shortcut editor lists the ask bar and the command bar, and no prompt dialog', () => {
  const byGroup = plain(Object.fromEntries(shortcutGroups.map((g) => [g.titleKey, g.actions.map((a) => a.key)])));
  assert.ok(byGroup.shortcutGroupAI.includes('inlinePrompt'));
  assert.ok(!Object.values(byGroup).some((keys) => keys.includes('llmModal')), 'llmModal is gone from every group');
  assert.deepEqual(byGroup.shortcutGroupCLI.slice(0, 3), ['commandBar', 'runCliFilter', 'runAiCli']);
  for (const group of shortcutGroups) {
    for (const act of group.actions) {
      assert.ok(I18N.en[act.labelKey] && I18N.ja[act.labelKey], `label ${act.labelKey} exists in en and ja`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------
// 2. migrateAskShortcuts
// ---------------------------------------------------------------------------------------------------
function runAskMigration(isMac, shortcuts, showToast = false) {
  const code = [
    extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'),
    extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'),
    'const DEFAULT_SHORTCUTS = isMac ? DEFAULT_SHORTCUTS_MAC : DEFAULT_SHORTCUTS_WIN;',
    'let shortcutMigrationDirty = false;',
    extractFunction(appCode, 'normalizeComboForCompare'),
    extractFunction(appCode, 'migrateAskShortcuts')
  ].join('\n');
  const config = { shortcuts };
  const messages = [];
  const context = vm.createContext({
    console, isMac, config,
    showMessage: (msg) => messages.push(msg),
    t: (key, params) => `${key}:${params && params.sc}`,
    formatShortcutForDisplay: (combo) => combo
  });
  vm.runInContext(`${code}\nglobalThis.__run = (toast) => { migrateAskShortcuts(toast); return shortcutMigrationDirty; };`, context);
  const dirty = context.__run(showToast);
  return { shortcuts: config.shortcuts, messages, dirty };
}

check('a saved Ctrl+K on the ask action moves to Ctrl+L with one notice, and the dialog binding is dropped', () => {
  const moved = runAskMigration(false, { inlinePrompt: 'Ctrl+K', llmModal: 'Ctrl+L', newTab: 'Ctrl+N' }, true);
  assert.equal(moved.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.ok(!('llmModal' in moved.shortcuts), 'the saved llmModal value is dropped');
  assert.equal(moved.shortcuts.newTab, 'Ctrl+N', 'unrelated shortcuts are untouched');
  assert.deepEqual(moved.messages, ['askShortcutMoved:Ctrl+L'], 'exactly one notice, naming the new key');
  assert.equal(moved.dirty, true, 'a change asks for the config to be saved once');

  const mac = runAskMigration(true, { inlinePrompt: 'Cmd+K', llmModal: 'Cmd+L' }, true);
  assert.equal(mac.shortcuts.inlinePrompt, 'Cmd+L');
  assert.deepEqual(mac.messages, ['askShortcutMoved:Cmd+L']);

  const quiet = runAskMigration(false, { inlinePrompt: 'Ctrl+K', llmModal: 'Ctrl+L' }, false);
  assert.equal(quiet.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.equal(quiet.messages.length, 0, 'the synchronous start-up load never toasts');
  assert.equal(quiet.dirty, true, 'but it still asks for the save');
});

check('a binding the user chose is kept, an already migrated config is left alone, and a taken Ctrl+L keeps Ctrl+K', () => {
  const custom = runAskMigration(false, { inlinePrompt: 'Ctrl+Alt+K', llmModal: 'Ctrl+Alt+L' }, true);
  assert.equal(custom.shortcuts.inlinePrompt, 'Ctrl+Alt+K', 'a custom ask binding is kept');
  assert.ok(!('llmModal' in custom.shortcuts), 'the dialog binding goes either way');
  assert.equal(custom.messages.length, 0, 'no notice when the ask key did not move');

  const cleared = runAskMigration(false, { inlinePrompt: '' }, true);
  assert.equal(cleared.shortcuts.inlinePrompt, '', 'a cleared binding stays cleared');
  assert.equal(cleared.dirty, false);

  const already = runAskMigration(false, { inlinePrompt: 'Ctrl+L' }, true);
  assert.equal(already.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.equal(already.dirty, false, 'nothing to change, nothing to save');
  assert.equal(already.messages.length, 0);

  const taken = runAskMigration(false, { inlinePrompt: 'Ctrl+K', find: 'Ctrl+L' }, true);
  assert.equal(taken.shortcuts.inlinePrompt, 'Ctrl+K', 'Ctrl+L belongs to Find here: the working Ctrl+K stays');
  assert.equal(taken.messages.length, 0);

  const twice = runAskMigration(false, { inlinePrompt: 'Ctrl+K', llmModal: 'Ctrl+L' }, true);
  const again = runAskMigration(false, twice.shortcuts, true);
  assert.equal(again.dirty, false, 'a second run is a no-op');
  assert.equal(again.messages.length, 0, 'so the notice is shown once');

  const chosen = runAskMigration(false, again.shortcuts, true);
  chosen.shortcuts.inlinePrompt = 'Ctrl+K';
  const restart = runAskMigration(false, chosen.shortcuts, true);
  assert.equal(restart.shortcuts.inlinePrompt, 'Ctrl+K', 'a Ctrl+K the user assigned after the migration survives the next start');
  assert.equal(restart.dirty, false);
  assert.equal(restart.messages.length, 0);
});

check('the migration runs on every config load path, right after the Zen one', () => {
  const calls = [...appCode.matchAll(/migrateZenShortcut\((?:true|false)\);\s*migrateAskShortcuts\((?:true|false)\);/g)];
  assert.equal(calls.length, 3, 'local sync, import and backend load');
  assert.match(appCode, /if \(shortcutMigrationDirty\) \{\s*shortcutMigrationDirty = false;\s*savePersistentConfig\(\);/);
});

// ---------------------------------------------------------------------------------------------------
// 3. Static wiring: markup, removed pieces, strings
// ---------------------------------------------------------------------------------------------------
check('the LLM prompt modal is gone from the markup and from app.js', () => {
  for (const id of ['llm-prompt-modal', 'llm-target-preview', 'llm-custom-instruction', 'btn-send-llm', 'btn-cancel-llm', 'modal-llm-close', 'ctx-llm-modal', 'sc-ctx-llm-modal', 'ctx-cli-filter', 'ctx-ai-cli']) {
    assert.ok(!indexHtml.includes(`id="${id}"`), `#${id} must be gone from index.html`);
  }
  assert.ok(!indexHtml.includes('LLM Prompt & Instruction Modal'));
  for (const name of ['llmModal', 'openLLMInstructionModal', 'closeLLMPromptModal', 'executeLLMQueryFromModal', 'llmPromptModal', 'currentLLMPromptContext', 'openCliFilterBar', 'openAiCliBar']) {
    const uses = appCode.split(name).length - 1;
    // migrateAskShortcuts names the old action three times (the check, the delete and its comment-free guard)
    assert.ok(name === 'llmModal' ? uses <= 3 : uses === 0, `${name} must not be used by app.js (found ${uses})`);
  }
  assert.ok(!styleCss.includes('.code-preview-box'), 'the dialog-only preview style is gone');
});

check('the ask bar has its target chip and hint, the command bar its badge hint, and the menu one command entry', () => {
  const bar = indexHtml.slice(indexHtml.indexOf('id="inline-prompt-bar"'), indexHtml.indexOf('id="cli-filter-bar"'));
  assert.ok(bar.includes('id="inline-prompt-input"') && bar.includes('id="btn-inline-prompt-send"') && bar.includes('id="btn-inline-prompt-close"'));
  assert.ok(/id="inline-prompt-target"[^>]*class="inline-prompt-chip"/.test(bar), 'the target chip');
  assert.ok(/id="inline-prompt-hint"/.test(bar), 'the hint line');
  assert.ok(/id="cli-filter-badge"[^>]*data-i18n-title="commandBarBadgeHint"/.test(indexHtml), 'the badge explains Tab / click');
  assert.ok(indexHtml.includes('id="ctx-command-bar"') && indexHtml.includes('id="sc-ctx-command-bar"'));
  assert.ok(indexHtml.includes('id="ctx-llm-query"') && indexHtml.includes('id="sc-ctx-inline-prompt"'), 'the ask entry stays');
  for (const cls of ['.inline-prompt-meta', '.inline-prompt-chip', '.inline-prompt-hint']) {
    assert.ok(styleCss.includes(cls), `${cls} is styled`);
  }
});

check('the Auto selector group sits in the Integration tab with both checkboxes', () => {
  const pane = indexHtml.slice(indexHtml.indexOf('id="pane-agent"'), indexHtml.indexOf('id="pane-sync"'));
  assert.ok(pane.includes('data-i18n="sectionAutoSelector"'));
  assert.ok(/<input type="checkbox" id="cfg-autosel-enabled" checked>/.test(pane));
  assert.ok(/<input type="checkbox" id="cfg-autosel-agent-confirm" checked>/.test(pane));
  assert.ok(pane.indexOf('sectionAutoSelector') > pane.indexOf('sectionAgentDelegate') && pane.indexOf('sectionAutoSelector') < pane.indexOf('sectionAgentSuggestions'),
    'between the agent section and the suggestions');
});

const NEW_KEYS = [
  'askKeysHint', 'askTargetSelection', 'askTargetLine', 'askTargetNote', 'askTargetNone', 'askPlaceholderRecord', 'askRecordHint',
  'askLlmNotConfigured', 'askShortcutMoved', 'llmTaskCanceled', 'commandBarBadgeHint', 'cmdPaletteAskAi', 'cmdPaletteAskAiDesc',
  'cmdPaletteCommandBar', 'cmdPaletteCommandBarDesc', 'ctxCommandBar', 'shortcutActionCommandBar', 'sectionAutoSelector',
  'autoSelEnabledLabel', 'autoSelEnabledHint', 'autoSelAgentConfirmLabel', 'autoSelAgentConfirmHint'
];
const REMOVED_KEYS = [
  'llmModalTitle', 'llmTargetLabel', 'llmInstructionLabel', 'llmInstructionPlaceholder', 'llmModalHint', 'llmSendBtn', 'llmCancelBtn',
  'llmNoText', 'llmGeneratingAnchor', 'inlinePromptSelectionPlaceholder', 'ctxPromptLLMModal', 'shortcutActionLLMModal', 'ctxCliFilter', 'ctxAiCli'
];

check('i18n: the new keys exist in en and ja, the removed ones are gone, both languages have the same keys, no emoji', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  for (const lang of ['en', 'ja']) {
    for (const key of NEW_KEYS) {
      assert.ok(typeof I18N[lang][key] === 'string' && I18N[lang][key].length > 0, `${lang}.${key} exists`);
      assert.ok(!EMOJI.test(I18N[lang][key]), `${lang}.${key} has no emoji`);
    }
    for (const key of REMOVED_KEYS) assert.ok(!(key in I18N[lang]), `${lang}.${key} is gone`);
  }
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.ja).sort(), 'en and ja carry the same keys');
  assert.ok(I18N.en.askTargetSelection.includes('{count}') && I18N.ja.askTargetSelection.includes('{count}'));
  assert.ok(I18N.en.askShortcutMoved.includes('{sc}') && I18N.ja.askShortcutMoved.includes('{sc}'));
  for (const key of ['cmdPaletteAskAiDesc', 'cmdPaletteCommandBarDesc', 'cmdPaletteCliFilterDesc', 'cmdPaletteAiCliDesc']) {
    assert.ok(/\(\{sc\}\)$/.test(I18N.en[key]) && /\(\{sc\}\)$/.test(I18N.ja[key]), `${key} ends with the "({sc})" that an unassigned key drops`);
  }
  for (const key of ['llmTitle', 'editorPlaceholder']) {
    assert.ok(!/Ctrl\+K/.test(I18N.en[key] + I18N.ja[key]), `${key} no longer mentions Ctrl+K`);
  }
  assert.equal(I18N.en.llmTitle, 'Ask AI (Ctrl+L)');
});

check('the palette offers Ask AI and the Command Bar, and the two mode entries pick their mode explicitly', () => {
  for (const id of ['cmd_ask_ai', 'cmd_command_bar', 'cmd_cli_filter', 'cmd_ai_cli']) assert.ok(appCode.includes(`id: '${id}'`), `${id} exists`);
  assert.ok(/id: 'cmd_command_bar'[\s\S]{0,700}action: \(\) => openCommandBar\(\)/.test(appCode));
  assert.ok(/id: 'cmd_cli_filter'[\s\S]{0,900}action: \(\) => openCommandBar\('cli'\)/.test(appCode));
  assert.ok(/id: 'cmd_ai_cli'[\s\S]{0,900}action: \(\) => openCommandBar\('ai'\)/.test(appCode));
  assert.ok(/id: 'cmd_ask_ai'[\s\S]{0,700}action: \(\) => openInlinePromptBar\(\)/.test(appCode));
  assert.ok(!/getShortcutDisplay\('run(Cli|Ai)/.test(appCode), 'the palette no longer invents a Ctrl+Shift+B / E label for an unassigned key');
});

// ---------------------------------------------------------------------------------------------------
// 4. Pure helpers, extracted from app.js
// ---------------------------------------------------------------------------------------------------
function loadAskHelpers() {
  const code = [extractFunction(appCode, 'resolveAskTarget'), extractFunction(appCode, 'askInsertPos')].join('\n');
  const context = vm.createContext({ console });
  vm.runInContext(`${code}\nglobalThis.__h = { resolveAskTarget, askInsertPos };`, context);
  return context.__h;
}

check('resolveAskTarget: the selection, else the current line, else the whole note, else nothing', () => {
  const { resolveAskTarget } = loadAskHelpers();
  const doc = 'first line\n\nthird line here';
  assert.deepEqual({ ...resolveAskTarget(doc, 0, 5) }, { kind: 'selection', text: 'first', start: 0, end: 5 });
  assert.deepEqual({ ...resolveAskTarget('  padded  ', 0, 10) }, { kind: 'selection', text: 'padded', start: 0, end: 10 }, 'the prompt text is trimmed, the range is not');
  assert.deepEqual({ ...resolveAskTarget(doc, 3, 3) }, { kind: 'line', text: 'first line', start: 0, end: 10 });
  assert.deepEqual({ ...resolveAskTarget(doc, 15, 15) }, { kind: 'line', text: 'third line here', start: 12, end: 27 });
  assert.equal(resolveAskTarget(doc, 11, 11).kind, 'note', 'the empty line falls back to the whole note');
  assert.equal(resolveAskTarget(doc, 11, 11).text, doc.trim());
  assert.equal(resolveAskTarget('\nabc', 0, 0).kind, 'note', 'an empty FIRST line is empty, not the second line');
  assert.equal(resolveAskTarget('a\n   \nb', 3, 3).kind, 'note', 'a blank (spaces only) line counts as empty');
  assert.equal(resolveAskTarget('   ', 1, 1).kind, 'none', 'nothing at all to ask about');
  assert.equal(resolveAskTarget('', 0, 0).kind, 'none');
  assert.equal(resolveAskTarget('one\ntwo\nthree', 2, 9).kind, 'selection');
  assert.deepEqual({ ...resolveAskTarget('word   more', 4, 7) }, { kind: 'line', text: 'word   more', start: 0, end: 11 },
    'a whitespace-only selection acts like no selection: the line it sits on');
});

check('askInsertPos: the end of the target\'s last line; the caret line for the whole note', () => {
  const { resolveAskTarget, askInsertPos } = loadAskHelpers();
  const doc = 'alpha beta\ngamma\n\ndelta';
  const sel = resolveAskTarget(doc, 2, 4);
  assert.equal(askInsertPos(doc, sel, 4), 10, 'a selection inside a line: the end of that line, not the caret');
  const line = resolveAskTarget(doc, 12, 12);
  assert.equal(askInsertPos(doc, line, 12), 16);
  const lineSel = resolveAskTarget(doc, 0, 11);
  assert.equal(lineSel.end, 11);
  assert.equal(askInsertPos(doc, lineSel, 11), 10, 'a selection that swallowed the line break ends on the line it selected, not the next one');
  const note = resolveAskTarget(doc, 17, 17);
  assert.equal(note.kind, 'note');
  assert.equal(askInsertPos(doc, note, 17), 17, 'the answer takes the empty line the caret is on');
  const last = resolveAskTarget('one\ntwo', 5, 5);
  assert.equal(askInsertPos('one\ntwo', last, 5), 7, 'the last line has no line break: the end of the text');
});

check('isLlmConfigured mirrors what pkg/llm can answer: local needs no key, hosted services do', () => {
  const messages = [];
  const config = { text: {} };
  const context = vm.createContext({ console, config, showMessage: (m) => messages.push(m), t: (k) => k });
  vm.runInContext(`${extractConstArray(appCode, 'LLM_KEY_HOSTS')}\n${extractFunction(appCode, 'isLlmConfigured')}\nglobalThis.__f = isLlmConfigured;`, context);
  const ok = (text, toast) => { config.text = text; return context.__f(toast); };
  assert.equal(ok({ baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest', apiKey: '' }), true, 'Ollama, no key');
  assert.equal(ok({ baseUrl: 'http://192.168.1.5:1234/v1', model: 'local', apiKey: '' }), true, 'a LAN OpenAI-compatible box');
  assert.equal(ok({ baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: '' }), false, 'Gemini needs a key');
  assert.equal(ok({ baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: 'k' }), true);
  assert.equal(ok({ baseUrl: 'http://localhost:11434', model: 'gemini-x', apiKey: '' }), false, 'a gemini model is the Gemini protocol');
  for (const host of ['https://api.openai.com/v1', 'https://api.groq.com/openai/v1', 'https://api.together.xyz/v1', 'https://openrouter.ai/api/v1']) {
    assert.equal(ok({ baseUrl: host, model: 'm', apiKey: '' }), false, `${host} needs a key`);
    assert.equal(ok({ baseUrl: host, model: 'm', apiKey: 'sk' }), true);
  }
  assert.equal(ok({ baseUrl: '', model: 'm', apiKey: 'k' }), false, 'no URL');
  assert.equal(ok({ baseUrl: 'http://localhost:11434', model: '  ', apiKey: '' }), false, 'no model');
  assert.equal(messages.length, 0, 'no toast unless asked');
  assert.equal(ok({ baseUrl: '', model: '', apiKey: '' }, true), false);
  assert.deepEqual(messages, ['askLlmNotConfigured']);
});

// ---------------------------------------------------------------------------------------------------
// 5. app.js against a hand-made DOM
// ---------------------------------------------------------------------------------------------------
const HIDDEN_AT_START = ['find-replace-bar', 'goto-line-modal', 'settings-modal', 'quick-pick-modal', 'inline-prompt-bar', 'cli-filter-bar',
  'cli-filter-preview', 'stat-llm-indicator', 'mobile-drop-modal', 'confirm-modal', 'context-menu', 'scraps-search-modal', 'stat-selection',
  'secondary-pane', 'pane-resizer', 'preview-pane'];

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function createEnv(opts = {}) {
  const elements = new Map();
  const listeners = { keydown: [] };
  const messages = [];
  const store = new Map(Object.entries(opts.localStorage || {}));
  let documentMock = null;

  function mockElement(id, tagName = 'div') {
    const classes = new Set(HIDDEN_AT_START.includes(id) ? ['hidden'] : []);
    const attrs = {};
    let innerHTML = '';
    let textContent = '';
    const el = {
      id, tagName: tagName.toUpperCase(), dataset: {}, style: {}, children: [], checked: false, disabled: false, value: '',
      title: '', placeholder: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0, scrollLeft: 0,
      scrollHeight: 1000, clientHeight: 500, offsetHeight: 500, offsetWidth: 500, onclick: null, _listeners: {},
      classList: {
        add: (...cls) => cls.forEach((c) => classes.add(c)),
        remove: (...cls) => cls.forEach((c) => classes.delete(c)),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c) => classes.has(c)
      },
      get className() { return Array.from(classes).join(' '); },
      set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
      get innerHTML() { return innerHTML; },
      set innerHTML(v) { innerHTML = v; textContent = v; if (v === '') el.children = []; },
      get textContent() { return textContent; },
      set textContent(v) {
        textContent = v;
        innerHTML = v;
        if (id === 'stat-message' && v) messages.push(v);
      },
      addEventListener: (evt, fn) => { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
      removeEventListener: () => {},
      focus: () => { documentMock.activeElement = el; },
      blur: () => {},
      select: () => { el.selectionStart = 0; el.selectionEnd = String(el.value || '').length; },
      setSelectionRange: (s, e) => { el.selectionStart = s; el.selectionEnd = e; },
      appendChild: (child) => { el.children.push(child); child.parentElement = el; return child; },
      insertBefore: (node, ref) => {
        const i = el.children.indexOf(ref);
        if (i !== -1) el.children.splice(i, 0, node); else el.children.push(node);
        node.parentElement = el;
        return node;
      },
      querySelector: (sel) => (sel.startsWith('#') ? elements.get(sel.slice(1)) || null : null),
      querySelectorAll: () => [],
      getAttribute: (name) => (name in attrs ? attrs[name] : (name === 'data-i18n' ? el.dataset.i18n || null : null)),
      setAttribute: (name, val) => { attrs[name] = val; if (name === 'data-i18n') el.dataset.i18n = val; },
      removeAttribute: (name) => { delete attrs[name]; },
      closest: () => null,
      contains: () => false
    };
    return el;
  }

  documentMock = {
    getElementById: (id) => {
      let el = elements.get(id);
      if (!el) {
        el = mockElement(id, (id === 'editor' || id === 'editor-secondary') ? 'textarea' : 'div');
        elements.set(id, el);
      }
      return el;
    },
    querySelector: (sel) => (sel.startsWith('#') ? documentMock.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => mockElement('', tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: (cmd, _, text) => {
      if (cmd !== 'insertText') return false;
      const ed = elements.get('editor');
      const start = ed.selectionStart;
      const end = ed.selectionEnd;
      ed.value = ed.value.substring(0, start) + text + ed.value.substring(end);
      ed.selectionStart = ed.selectionEnd = start + text.length;
      return true;
    },
    activeElement: null,
    hasFocus: () => true,
    hidden: false,
    documentElement: { lang: 'en' }
  };
  documentMock.body = mockElement('body');
  documentMock.activeElement = documentMock.getElementById('editor');

  const llmCalls = [];
  const saved = [];
  const backend = Object.assign({
    getConfig: async () => (opts.backendConfig ? JSON.stringify(opts.backendConfig) : ''),
    saveConfig: async (json) => { saved.push(JSON.parse(json)); },
    getSession: async () => null,
    saveSession: async () => {},
    getStartupFile: async () => null,
    trimMemory: async () => {},
    queryLLMAsync: (reqId, prompt, cfgJson) => { llmCalls.push({ reqId, prompt, cfg: JSON.parse(cfgJson) }); }
  }, opts.backend || {});

  const longTimers = new Map();
  let timerSeq = 0;
  const setTimeoutMock = (fn, ms) => {
    const id = ++timerSeq;
    if (typeof ms === 'number' && ms >= 10000) {
      longTimers.set(id, fn);
      return id;
    }
    fn();
    return id;
  };

  const tasks = { added: [], updated: [] };
  const windowMock = {
    document: documentMock,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    },
    backend,
    navigator: { platform: 'Win32', userAgent: 'Windows', language: opts.language === 'ja' ? 'ja-JP' : 'en-US' },
    addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
    removeEventListener: () => {},
    setTimeout: setTimeoutMock,
    clearTimeout: (id) => { longTimers.delete(id); },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    innerWidth: 1200,
    innerHeight: 800,
    TaskManager: {
      addTask: (o) => { tasks.added.push(o); return o; },
      updateTask: (id, u) => { tasks.updated.push(Object.assign({ id }, u)); }
    }
  };
  if (opts.SlotSnippets) windowMock.SlotSnippets = opts.SlotSnippets;
  documentMock.defaultView = windowMock;

  const context = {
    window: windowMock, document: documentMock, localStorage: windowMock.localStorage, navigator: windowMock.navigator,
    setTimeout: setTimeoutMock, clearTimeout: windowMock.clearTimeout, requestAnimationFrame: windowMock.requestAnimationFrame,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(i18nCode, context);
  vm.runInContext(chromeLayoutCode, context);
  vm.runInContext(mermaidToneCode, context);
  vm.runInContext(appCode, context);
  await flush();

  const el = (id) => documentMock.getElementById(id);
  const env = {
    window: windowMock, elements, messages, llmCalls, saved, tasks, store, el,
    bridge: windowMock.MdMemoBridge,
    config: windowMock.__testHelper.config,
    editor: el('editor'),
    fire(id, evt, init) {
      const e = Object.assign({ key: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      (el(id)._listeners[evt] || []).forEach((fn) => fn(e));
      return e;
    },
    key(init) {
      const e = Object.assign({ key: '', code: '', keyCode: 0, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, init);
      listeners.keydown.forEach((fn) => fn(e));
      return e;
    },
    ctrl(letter, extra) {
      return env.key(Object.assign({ key: letter, code: 'Key' + letter.toUpperCase(), ctrlKey: true }, extra));
    },
    hidden: (id) => el(id).classList.contains('hidden'),
    setNote(text, start, end) {
      env.editor.value = text;
      env.editor.selectionStart = start === undefined ? text.length : start;
      env.editor.selectionEnd = end === undefined ? env.editor.selectionStart : end;
      env.window.document.activeElement = env.editor;
    },
    fireLongTimers() {
      const fns = Array.from(longTimers.values());
      longTimers.clear();
      fns.forEach((fn) => fn());
    },
    longTimerCount: () => longTimers.size,
    activeTabId: () => env.bridge.getActiveTab().id,
    flush
  };
  return env;
}

const OLD_SHORTCUTS = { newTab: 'Ctrl+N', find: 'Ctrl+F', inlinePrompt: 'Ctrl+K', llmModal: 'Ctrl+L', runCliFilter: 'Ctrl+Shift+B', runAiCli: 'Ctrl+Shift+E' };
const oldConfigStore = () => ({ md_notepad_config_v3: JSON.stringify({ general: { language: 'en' }, shortcuts: OLD_SHORTCUTS }) });

check('a new install: Ctrl+L asks, Ctrl+E opens the command bar, and the mode-specific keys are unassigned', async () => {
  const env = await createEnv();
  assert.equal(env.config.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.equal(env.config.shortcuts.commandBar, 'Ctrl+E');
  assert.equal(env.config.shortcuts.runCliFilter, '');
  assert.equal(env.config.shortcuts.runAiCli, '');
  assert.ok(!('llmModal' in env.config.shortcuts));

  env.setNote('hello world', 0, 5);
  const e = env.ctrl('l');
  assert.equal(e.defaultPrevented, true);
  assert.equal(env.hidden('inline-prompt-bar'), false, 'Ctrl+L opens the ask bar');
  assert.equal(env.window.document.activeElement, env.el('inline-prompt-input'), 'and puts the caret in it');
  env.key({ key: 'Escape' });
  assert.equal(env.hidden('inline-prompt-bar'), true, 'Esc closes it');

  env.key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
  env.key({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
  assert.equal(env.hidden('cli-filter-bar'), true, 'Ctrl+Shift+B / E are not bound on a new install');

  const cmd = env.ctrl('e');
  assert.equal(cmd.defaultPrevented, true);
  assert.equal(env.hidden('cli-filter-bar'), false, 'Ctrl+E opens the command bar');
  assert.equal(env.el('cli-filter-badge').textContent, 'CLI', 'first run = manual CLI mode');
});

check('an old config: Ctrl+K opens nothing after the migration, Ctrl+L asks, and saved Ctrl+Shift+B / E keep working', async () => {
  const env = await createEnv({ localStorage: oldConfigStore() });
  assert.equal(env.config.shortcuts.inlinePrompt, 'Ctrl+L', 'moved');
  assert.ok(!('llmModal' in env.config.shortcuts), 'dropped');
  assert.equal(env.config.shortcuts.runCliFilter, 'Ctrl+Shift+B', 'no migration for the mode keys');
  assert.equal(env.config.shortcuts.commandBar, 'Ctrl+E', 'the new action gets its default');

  env.setNote('some text', 0, 4);
  const k = env.ctrl('k');
  assert.equal(k.defaultPrevented, false, 'Ctrl+K is not handled at all any more');
  assert.equal(env.hidden('inline-prompt-bar'), true);
  assert.equal(env.hidden('cli-filter-bar'), true);

  env.ctrl('l');
  assert.equal(env.hidden('inline-prompt-bar'), false);
  env.key({ key: 'Escape' });

  env.key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
  assert.equal(env.hidden('cli-filter-bar'), false);
  assert.equal(env.el('cli-filter-badge').textContent, 'CLI');
  env.key({ key: 'Escape' });
  env.key({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
  assert.equal(env.hidden('cli-filter-bar'), false);
  assert.equal(env.el('cli-filter-badge').textContent, 'AI CLI', 'the saved AI key opens the AI mode');
});

check('the backend config load migrates once: one notice, and the migrated config is saved without llmModal', async () => {
  const env = await createEnv({ localStorage: oldConfigStore(), backendConfig: { shortcuts: OLD_SHORTCUTS } });
  const notice = I18N.en.askShortcutMoved.replace('{sc}', 'Ctrl+L');
  assert.equal(env.messages.filter((m) => m === notice).length, 1, `exactly one notice: ${JSON.stringify(env.messages)}`);
  assert.equal(env.config.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.ok(env.saved.length >= 1, 'the migrated config was written back');
  const last = env.saved[env.saved.length - 1];
  assert.equal(last.shortcuts.inlinePrompt, 'Ctrl+L');
  assert.ok(!('llmModal' in last.shortcuts), 'and the stale binding is not written again');

  const quiet = await createEnv({ localStorage: oldConfigStore() });
  assert.equal(quiet.messages.filter((m) => m === notice).length, 0, 'no backend copy, no toast (the synchronous load never toasts)');
});

check('the ask bar names its target: selection N chars / current line / whole note / no text', async () => {
  const env = await createEnv();
  const chip = () => env.el('inline-prompt-target').textContent;

  env.setNote('hello world\nsecond line', 0, 5);
  env.ctrl('l');
  assert.equal(chip(), 'Selection: 5 chars');
  assert.equal(env.el('inline-prompt-target').title, 'hello', 'hover shows the text');
  assert.equal(env.el('inline-prompt-hint').textContent, I18N.en.askKeysHint, 'the keys are named next to the chip');
  assert.equal(env.el('inline-prompt-input').placeholder, I18N.en.inlinePromptPlaceholder);
  env.key({ key: 'Escape' });

  env.setNote('hello world\nsecond line', 14, 14);
  env.ctrl('l');
  assert.equal(chip(), 'Current line');
  env.key({ key: 'Escape' });

  env.setNote('note one\n\nnote two', 9, 9);
  env.ctrl('l');
  assert.equal(chip(), 'Whole note', 'an empty line falls back to the whole note');
  env.key({ key: 'Escape' });

  env.setNote('', 0, 0);
  env.ctrl('l');
  assert.equal(chip(), 'No target text (free question)');
  env.key({ key: 'Escape' });

  env.config.general.language = 'ja';
  env.setNote('こんにちは世界', 0, 3);
  env.ctrl('l');
  assert.equal(chip(), '選択範囲: 3文字', 'the chip follows the UI language');
  assert.equal(env.el('inline-prompt-input').placeholder, I18N.ja.inlinePromptPlaceholder);
});

check('the quick ask: the answer lands below the target, the instruction line is not written, the task is listed and can be aborted', async () => {
  const env = await createEnv();
  const original = 'hello world\nsecond line';
  env.setNote(original, 0, 5);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'translate';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });

  assert.equal(env.hidden('inline-prompt-bar'), true, 'the bar closes on submit');
  assert.equal(env.llmCalls.length, 1);
  const call = env.llmCalls[0];
  assert.equal(call.prompt, '【指示】:\ntranslate\n\n【対象テキスト】:\nhello');
  assert.deepEqual(call.cfg, plain(env.config.text), 'the built-in LLM is asked');
  const anchor = `[${I18N.en.aiGeneratingAnchor.replace('{instruction}', 'translate')}]`;
  assert.equal(env.editor.value, `hello world\n\n${anchor}\n\nsecond line`, 'the anchor is below the target LINE, not at the caret');
  assert.equal(env.tasks.added.length, 1);
  assert.equal(env.tasks.added[0].type, 'llm');
  assert.equal(env.tasks.added[0].id, call.reqId);
  assert.equal(env.tasks.added[0].instruction, 'translate');
  assert.equal(env.el('stat-llm-indicator').classList.contains('hidden'), false, 'the status bar shows a request in flight');

  env.window.__onLLMResult(call.reqId, 'Answer text', '');
  assert.equal(env.editor.value, 'hello world\n\nAnswer text\n\nsecond line', 'the anchor is replaced by the answer');
  assert.deepEqual(env.tasks.updated.map((u) => u.status), ['completed']);
  assert.equal(env.el('stat-llm-indicator').classList.contains('hidden'), true);
  assert.ok(env.messages.includes(I18N.en.llmResponseInserted));

  // abort from the task panel: the note is restored exactly and the late answer is dropped
  env.setNote(original, 0, 5);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'summarize';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  const second = env.llmCalls[1];
  assert.notEqual(env.editor.value, original, 'the anchor is in the note while waiting');
  env.tasks.added[1].onCancel();
  assert.equal(env.editor.value, original, 'cancel takes the anchor out, line breaks included');
  assert.equal(env.tasks.updated[env.tasks.updated.length - 1].status, 'canceled');
  assert.equal(env.longTimerCount(), 0, 'the watchdog is disarmed');
  assert.equal(env.el('stat-llm-indicator').classList.contains('hidden'), true);
  env.window.__onLLMResult(second.reqId, 'too late', '');
  assert.equal(env.editor.value, original, 'a late answer finds nothing waiting for it');
  assert.ok(env.messages.includes(I18N.en.llmTaskCanceled));
});

check('a failed quick ask leaves a one-line note where the answer would have gone, line breaks intact', async () => {
  const env = await createEnv();
  env.setNote('hello world\nsecond line', 0, 5);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'translate';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  env.window.__onLLMResult(env.llmCalls[0].reqId, '', 'boom');
  assert.equal(env.editor.value, `hello world\n\n[${I18N.en.llmError}boom]\n\nsecond line`);
  assert.equal(env.tasks.updated[0].status, 'failed');

  env.setNote('a\n\nb', 2, 2);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'summarize';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  env.fireLongTimers();
  assert.equal(env.editor.value, `a\n[${I18N.en.llmError}${I18N.en.llmTimeout}]\n\nb`, 'the watchdog leaves the same note on the empty line');
});

check('the quick ask on an empty line asks about the whole note and answers on that empty line', async () => {
  const env = await createEnv();
  env.setNote('note one\n\nnote two', 9, 9);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'summarize';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  const call = env.llmCalls[0];
  assert.equal(call.prompt, '【指示】:\nsummarize\n\n【対象テキスト】:\nnote one\n\nnote two');
  env.window.__onLLMResult(call.reqId, 'Summary', '');
  assert.equal(env.editor.value, 'note one\nSummary\n\nnote two');

  const empty = await createEnv();
  empty.setNote('', 0, 0);
  empty.ctrl('l');
  empty.el('inline-prompt-input').value = 'say hi';
  empty.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(empty.llmCalls[0].prompt, 'say hi', 'no target: the instruction is the whole prompt');
  empty.window.__onLLMResult(empty.llmCalls[0].reqId, 'hi', '');
  assert.equal(empty.editor.value, 'hi\n');
});

check('a quick ask with no instruction sends the target as it is; nothing to send closes the bar quietly', async () => {
  const env = await createEnv();
  env.setNote('just this line', 3, 3);
  env.ctrl('l');
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(env.llmCalls[0].prompt, 'just this line');

  env.setNote('', 0, 0);
  env.ctrl('l');
  const before = env.llmCalls.length;
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(env.llmCalls.length, before);
  assert.equal(env.hidden('inline-prompt-bar'), true);
});

check('an Enter that confirms an IME conversion does not submit (Safari reports it as Enter with keyCode 229)', async () => {
  const env = await createEnv();
  env.setNote('line', 0, 4);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'yaku';
  const e = env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(e.defaultPrevented, false, 'left to the IME');
  assert.equal(env.llmCalls.length, 0);
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar stays open');
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', isComposing: true });
  assert.equal(env.llmCalls.length, 0);
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(env.llmCalls.length, 1);
});

check('MdMemoBridge.openAskBar with onSubmit only collects the instruction: no request, the note is untouched', async () => {
  const env = await createEnv();
  env.setNote('# Title\nplain paragraph text', 0, 0);
  const calls = [];
  const tabId = env.activeTabId();
  env.bridge.openAskBar({
    target: { text: 'plain paragraph text', start: 8, end: 28 },
    recordInstruction: true,
    onSubmit: (instruction, ctx) => calls.push({ instruction, ctx })
  });
  assert.equal(env.hidden('inline-prompt-bar'), false);
  assert.equal(env.el('inline-prompt-target').textContent, 'Selection: 20 chars');
  assert.equal(env.el('inline-prompt-hint').textContent, I18N.en.askRecordHint);
  assert.equal(env.el('inline-prompt-input').placeholder, I18N.en.askPlaceholderRecord);

  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(calls.length, 0, 'an empty instruction is not handed back');
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the bar waits');

  env.el('inline-prompt-input').value = 'translate to English';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].instruction, 'translate to English');
  assert.equal(calls[0].ctx.tabId, tabId);
  assert.deepEqual({ ...calls[0].ctx.target }, { kind: 'selection', text: 'plain paragraph text', start: 8, end: 28 });
  assert.equal(calls[0].ctx.insertPos, 28, 'the end of the target line: where a new line below it starts');
  assert.equal(calls[0].ctx.recordInstruction, true);
  assert.equal(env.hidden('inline-prompt-bar'), true);
  assert.equal(env.llmCalls.length, 0, 'nothing was sent');
  assert.equal(env.editor.value, '# Title\nplain paragraph text', 'the note is the caller\'s to change');
  assert.equal(env.tasks.added.length, 0);

  env.setNote('x', 0, 0);
  env.bridge.openAskBar({ onSubmit: () => { throw new Error('boom'); } });
  env.el('inline-prompt-input').value = 'go';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(env.hidden('inline-prompt-bar'), true, 'a throwing callback does not leave the bar stuck');
});

check('openAskBar works from a non-editor focus, for a note that is not on screen, and refuses recordInstruction without a usable LLM', async () => {
  const env = await createEnv();
  env.setNote('focus elsewhere', 0, 5);
  env.el('find-input').focus();
  env.bridge.openAskBar();
  assert.equal(env.hidden('inline-prompt-bar'), false, 'the toolbar / palette / context menu open it from anywhere');
  assert.equal(env.el('inline-prompt-target').textContent, 'Selection: 5 chars');
  env.key({ key: 'Escape' });

  // a background tab: open a second note, then ask about the first
  const firstId = env.activeTabId();
  env.window.__testHelper.createTab('B.md', 'second note text');
  assert.notEqual(env.activeTabId(), firstId);
  const calls = [];
  env.bridge.openAskBar({ tabId: firstId, target: { text: 'first note', start: 0, end: 10, kind: 'line' }, onSubmit: (i, ctx) => calls.push(ctx) });
  assert.equal(env.hidden('inline-prompt-bar'), false, 'a note that is not on screen can be asked about');
  assert.equal(env.el('inline-prompt-target').textContent, 'Current line', 'the caller may name the kind');
  env.el('inline-prompt-input').value = 'go';
  env.fire('inline-prompt-input', 'keydown', { key: 'Enter', keyCode: 13 });
  assert.equal(calls[0].tabId, firstId);

  env.config.text = { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: '', systemPrompt: '' };
  env.messages.length = 0;
  const noteBefore = env.editor.value;
  env.bridge.openAskBar({ recordInstruction: true, onSubmit: () => calls.push('never') });
  assert.equal(env.hidden('inline-prompt-bar'), true, 'no bar for a request that could not run');
  assert.deepEqual(env.messages, [I18N.en.askLlmNotConfigured], 'the toast says what to fix');
  assert.equal(env.editor.value, noteBefore, 'and the note is not modified');
  env.messages.length = 0;
  env.bridge.openAskBar();
  assert.equal(env.hidden('inline-prompt-bar'), true, 'the plain quick ask needs a usable LLM too: no bar that would only write an error line into the note');
  assert.deepEqual(env.messages, [I18N.en.askLlmNotConfigured], 'with the same toast');
  assert.equal(env.editor.value, noteBefore, 'and the note is not modified');
  assert.equal(env.bridge.isLlmConfigured(), false);

  env.config.text = { baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest', apiKey: '', systemPrompt: '' };
  env.bridge.openAskBar();
  assert.equal(env.hidden('inline-prompt-bar'), false, 'a local model needs no key: the bar opens');
});

check('the shortcut pressed again in the open ask bar keeps what was typed', async () => {
  const env = await createEnv();
  env.setNote('some text', 0, 4);
  env.ctrl('l');
  env.el('inline-prompt-input').value = 'half typed';
  env.ctrl('l');
  assert.equal(env.el('inline-prompt-input').value, 'half typed');
  assert.equal(env.window.document.activeElement, env.el('inline-prompt-input'));
});

check('startLlmTask: returns a request id, sends the built-in LLM config, and swaps the anchor via wrapResult', async () => {
  const env = await createEnv();
  const tabId = env.activeTabId();
  env.setNote('line one\n<!-- run 1 -->\nline three', 0, 0);
  const finished = [];
  const reqId = env.bridge.startLlmTask({
    tabId, prompt: 'the prompt', anchorText: '<!-- run 1 -->', label: 'a label',
    wrapResult: (text) => `<!-- res 1 -->\n${text}\n<!-- /res -->`,
    onFinish: (status) => finished.push(status)
  });
  assert.equal(typeof reqId, 'string');
  assert.ok(reqId.startsWith('llm_'));
  assert.deepEqual(env.llmCalls.map((c) => ({ reqId: c.reqId, prompt: c.prompt })), [{ reqId, prompt: 'the prompt' }]);
  assert.deepEqual(env.llmCalls[0].cfg, plain(env.config.text));
  assert.equal(env.tasks.added[0].type, 'llm');
  assert.equal(env.tasks.added[0].instruction, 'a label');
  assert.equal(env.longTimerCount(), 1, 'the watchdog is armed');

  env.window.__onLLMResult(reqId, '```markdown\nbody text\n```', '');
  assert.equal(env.editor.value, 'line one\n<!-- res 1 -->\nbody text\n<!-- /res -->\nline three', 'thinking / fences are cleaned, then wrapped');
  assert.deepEqual(finished, ['completed']);
  assert.deepEqual(env.tasks.updated.map((u) => u.status), ['completed']);
  assert.equal(env.longTimerCount(), 0);
  env.window.__onLLMResult(reqId, 'again', '');
  assert.equal(env.editor.value, 'line one\n<!-- res 1 -->\nbody text\n<!-- /res -->\nline three', 'a request settles once');
});

check('startLlmTask: an error becomes a one-line note (or the caller\'s wrapError), the watchdog fails it, bad input returns null', async () => {
  const env = await createEnv();
  const tabId = env.activeTabId();
  env.setNote('a\n<!-- run 2 -->\nb', 0, 0);
  const finished = [];
  const reqId = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 2 -->', wrapResult: () => 'NEVER', onFinish: (s) => finished.push(s) });
  env.window.__onLLMResult(reqId, '', 'boom');
  assert.equal(env.editor.value, `a\n[${I18N.en.llmError}boom]\nb`, 'the default error note is one line');
  assert.deepEqual(finished, ['failed']);
  assert.equal(env.tasks.updated[0].status, 'failed');
  assert.equal(env.tasks.updated[0].error, 'boom');

  env.setNote('x\n<!-- run 3 -->\ny', 0, 0);
  const wrapped = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 3 -->', wrapError: (m) => `<!-- failed: ${m} -->` });
  env.window.__onLLMResult(wrapped, '', 'nope');
  assert.equal(env.editor.value, 'x\n<!-- failed: nope -->\ny');

  env.setNote('x\n<!-- run 3b -->\ny', 0, 0);
  const multi = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 3b -->' });
  env.window.__onLLMResult(multi, '', 'Gemini API error (403):\n{\n  "error": {"code": 403}\n}');
  assert.equal(env.editor.value, `x\n[${I18N.en.llmError}Gemini API error (403): { "error": {"code": 403} }]\ny`, 'a multi-line provider error stays on one line');

  env.setNote('m\n<!-- run 4 -->\nn', 0, 0);
  const timed = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 4 -->', onFinish: (s) => finished.push(s) });
  assert.ok(timed);
  env.fireLongTimers();
  assert.equal(env.editor.value, `m\n[${I18N.en.llmError}${I18N.en.llmTimeout}]\nn`, 'a dropped callback is resolved by the watchdog');
  assert.equal(finished[finished.length - 1], 'failed');

  assert.equal(env.bridge.startLlmTask({ tabId: 'no-such-tab', prompt: 'p', anchorText: 'x' }), null);
  assert.equal(env.bridge.startLlmTask({ tabId, prompt: 'p' }), null, 'no anchor, no task');
  assert.equal(env.bridge.startLlmTask({ tabId, anchorText: 'x' }), null, 'no prompt, no task');
  assert.equal(env.bridge.startLlmTask(), null);

  env.setNote('q\n<!-- run 5 -->\nr', 0, 0);
  const throwing = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 5 -->', wrapResult: () => { throw new Error('bad wrapper'); } });
  env.window.__onLLMResult(throwing, 'plain answer', '');
  assert.equal(env.editor.value, 'q\nplain answer\nr', 'a throwing wrapper falls back to the plain answer');
});

check('cancelLlmTask: removes the anchor, drops the late result, reports canceled, and only knows its own tasks', async () => {
  const env = await createEnv();
  const tabId = env.activeTabId();
  env.setNote('first\n<!-- run 9 -->\nlast', 0, 0);
  const finished = [];
  const reqId = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 9 -->\n', onFinish: (s) => finished.push(s) });
  assert.equal(env.bridge.cancelLlmTask(reqId), true);
  assert.equal(env.editor.value, 'first\nlast', 'the anchor (with its line break) is gone');
  assert.deepEqual(finished, ['canceled']);
  assert.equal(env.tasks.updated[0].status, 'canceled');
  assert.equal(env.longTimerCount(), 0);
  env.window.__onLLMResult(reqId, 'late', '');
  assert.equal(env.editor.value, 'first\nlast', 'the late answer is dropped');
  assert.deepEqual(finished, ['canceled'], 'and does not report again');
  assert.equal(env.bridge.cancelLlmTask(reqId), false, 'a settled task cannot be cancelled twice');
  assert.equal(env.bridge.cancelLlmTask('llm_unknown'), false);

  // the anchor was already deleted by the user: cancel must not append anything
  env.setNote('only text', 0, 0);
  const orphan = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 10 -->' });
  assert.equal(env.bridge.cancelLlmTask(orphan), true);
  assert.equal(env.editor.value, 'only text', 'nothing is appended for a vanished anchor');

  env.setNote('a\n<!-- run 11 -->\nb', 0, 0);
  const custom = env.bridge.startLlmTask({ tabId, prompt: 'p', anchorText: '<!-- run 11 -->', cancelReplacement: '<!-- canceled -->' });
  env.bridge.cancelLlmTask(custom);
  assert.equal(env.editor.value, 'a\n<!-- canceled -->\nb', 'the caller may leave a note instead');

  // a request that is not a task (the AI correction) is not cancellable through this door
  env.setNote('teh text', 0, 8);
  env.window.__testHelper.triggerAICorrection();
  const correction = env.llmCalls[env.llmCalls.length - 1].reqId;
  assert.equal(env.bridge.cancelLlmTask(correction), false);
});

check('a note closed while its request runs: the answer is dropped and the task still settles', async () => {
  const env = await createEnv();
  env.window.__testHelper.createTab('B.md', 'b text');
  const tabB = env.activeTabId();
  env.setNote('b\n<!-- run 12 -->', 0, 0);
  const finished = [];
  const reqId = env.bridge.startLlmTask({ tabId: tabB, prompt: 'p', anchorText: '<!-- run 12 -->', onFinish: (s) => finished.push(s) });
  env.window.__mdMemoRPC.closeTab(tabB);
  env.window.__onLLMResult(reqId, 'answer', '');
  assert.deepEqual(finished, ['canceled']);
  assert.equal(env.tasks.updated[env.tasks.updated.length - 1].status, 'canceled');
});

// ---- command bar -----------------------------------------------------------------------------------
const badge = (env) => env.el('cli-filter-badge').textContent;
const MODE_KEY = 'md_memo_cmdbar_mode';

check('command bar: opens in the last used mode, Tab and the badge switch and remember it', async () => {
  const env = await createEnv();
  env.setNote('lines to filter', 0, 5);
  env.ctrl('e');
  assert.equal(env.hidden('cli-filter-bar'), false);
  assert.equal(badge(env), 'CLI', 'first run: manual');
  assert.equal(env.el('cli-filter-input').getAttribute('list'), 'cli-snippets', 'the manual mode has the preset list');
  assert.equal(env.window.document.activeElement, env.el('cli-filter-input'));

  const tab = env.fire('cli-filter-input', 'keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, true, 'Tab does not move focus away');
  assert.equal(badge(env), 'AI CLI');
  assert.equal(env.el('cli-filter-input').placeholder, I18N.en.aiCliFilterPlaceholder);
  assert.equal(env.el('cli-filter-input').getAttribute('list'), null, 'no presets in the AI mode');
  assert.equal(env.store.get(MODE_KEY), 'ai', 'remembered');
  env.key({ key: 'Escape' });
  assert.equal(env.hidden('cli-filter-bar'), true);

  env.setNote('other text', 0, 0);
  env.ctrl('e');
  assert.equal(badge(env), 'AI CLI', 'reopened in the mode used last');
  env.el('cli-filter-badge')._listeners.click.forEach((fn) => fn({}));
  assert.equal(badge(env), 'CLI', 'the badge click switches back');
  assert.equal(env.store.get(MODE_KEY), 'cli');
  env.fire('cli-filter-input', 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(badge(env), 'CLI', 'Shift+Tab is left alone');
  env.fire('cli-filter-input', 'keydown', { key: 'Tab', isComposing: true });
  assert.equal(badge(env), 'CLI', 'and so is a Tab pressed during IME composition');
  env.key({ key: 'Escape' });
  env.ctrl('e');
  assert.equal(badge(env), 'CLI');
});

check('command bar: the remembered mode survives a restart, and a garbage value means manual', async () => {
  const ai = await createEnv({ localStorage: { [MODE_KEY]: 'ai' } });
  ai.setNote('x', 0, 0);
  ai.ctrl('e');
  assert.equal(badge(ai), 'AI CLI');
  const junk = await createEnv({ localStorage: { [MODE_KEY]: 'banana' } });
  junk.setNote('x', 0, 0);
  junk.ctrl('e');
  assert.equal(badge(junk), 'CLI');
});

check('command bar: the mode keys open their own mode and remember it; a second press keeps what was typed', async () => {
  const env = await createEnv({ localStorage: oldConfigStore() });
  env.setNote('pre-selected request', 0, 12);
  env.key({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
  assert.equal(badge(env), 'AI CLI');
  assert.equal(env.el('cli-filter-input').value, 'pre-selected', 'the selection is preloaded as the request in the AI mode');
  assert.equal(env.store.get(MODE_KEY), 'ai');

  env.el('cli-filter-input').value = 'half typed';
  env.ctrl('e');
  assert.equal(env.el('cli-filter-input').value, 'half typed', 'Ctrl+E in the open bar does not wipe it');
  env.key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true });
  assert.equal(badge(env), 'CLI', 'an explicit mode key switches the open bar');
  assert.equal(env.el('cli-filter-input').value, 'half typed');
  env.key({ key: 'Escape' });
});

check('command bar: the automatic switch back to manual after AI wrote a command is not remembered as a choice', async () => {
  const env = await createEnv({
    backend: {
      generateCliCommandAsync: (reqID) => setImmediate(() => env.window.__onCliCommandGenerated(reqID, 'echo hi', '', { isSafe: true }))
    }
  });
  env.setNote('x', 0, 0);
  env.ctrl('e');
  env.fire('cli-filter-input', 'keydown', { key: 'Tab' });
  assert.equal(env.store.get(MODE_KEY), 'ai');
  env.el('cli-filter-input').value = 'say hi';
  env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(env.el('cli-filter-input').value, 'echo hi', 'the generated command is in the input');
  assert.equal(badge(env), 'CLI', 'the bar shows the manual mode so the command can be reviewed and run');
  assert.equal(env.store.get(MODE_KEY), 'ai', 'but the next Ctrl+E still opens the AI mode');
});

check('command bar: Enter that confirms an IME conversion does not run or generate', async () => {
  const env = await createEnv({
    backend: {
      validateCliCommand: async () => ({ isBlocked: false }),
      runCommandFilterAsync: (id) => { env.ran = (env.ran || 0) + 1; },
      generateCliCommandAsync: () => { env.generated = (env.generated || 0) + 1; }
    }
  });
  env.setNote('x', 0, 0);
  env.ctrl('e');
  env.el('cli-filter-input').value = 'sort';
  env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 229 });
  await env.flush();
  assert.equal(env.ran || 0, 0);
  assert.equal(env.generated || 0, 0);
});

check('the two bars make room for each other, and Esc closes the one that is open', async () => {
  const env = await createEnv();
  env.setNote('some text', 0, 4);
  env.ctrl('l');
  env.ctrl('e');
  assert.equal(env.hidden('inline-prompt-bar'), true, 'opening the command bar closes the ask bar');
  assert.equal(env.hidden('cli-filter-bar'), false);
  env.ctrl('l');
  assert.equal(env.hidden('cli-filter-bar'), true, 'and the other way round');
  assert.equal(env.hidden('inline-prompt-bar'), false);
  env.key({ key: 'Escape' });
  assert.equal(env.hidden('inline-prompt-bar'), true);
});

check('command presets: the fixed filters stay; the SlotSnippets library adds to them (the user\'s own first)', async () => {
  const basic = await createEnv();
  basic.setNote('x', 0, 0);
  basic.ctrl('e');
  const fixed = basic.el('cli-snippets').children.map((o) => o.value);
  assert.ok(fixed.includes('sort -u') && fixed.includes('jq .'), 'the built-in list without the library');

  const seen = [];
  const SlotSnippets = {
    list: (o) => {
      seen.push(o);
      return [
        { id: 'mine', label: 'Mine', kind: 'command', body: 'echo mine', builtin: false },
        { id: 'a', label: 'Git status', kind: 'command', body: 'git status', builtin: true },
        { id: 'b', label: 'Search a word', kind: 'command', body: 'rg -n "${selection}" .' },
        { id: 'c', label: 'Today', kind: 'command', body: 'Get-Date -Format yyyy-MM-dd' },
        { id: 'd', label: 'Caret marker', kind: 'command', body: 'git commit -m "$0"' },
        { id: 'e', label: 'Awk column', kind: 'command', body: "awk '{print $$0}'" },
        { id: 'f', label: 'Literal brace', kind: 'command', body: 'echo $${HOME}' }
      ];
    }
  };
  const userSnippets = [{ id: 'mine', label: 'Mine', kind: 'command', body: 'echo mine' }];
  const rich = await createEnv({
    SlotSnippets,
    backend: { getActiveSlotConfigJSON: async () => JSON.stringify({ snippets: userSnippets }) }
  });
  rich.setNote('x', 0, 0);
  rich.ctrl('e');
  await rich.flush();
  const options = rich.el('cli-snippets').children;
  assert.deepEqual(options.map((o) => o.value), ['echo mine'].concat(fixed, ['git status', 'Get-Date -Format yyyy-MM-dd', "awk '{print $0}'", 'echo ${HOME}']),
    'the user\'s snippets, then the fixed filters (sort -u, jq . ...), then the library; a task template with a ${...} or $0 placeholder is not offered, and the library\'s $$0 / $${ escapes become the literal text');
  assert.equal(options[0].label, 'Mine');
  assert.deepEqual(options.slice(-4).map((o) => o.label), ['Git status', 'Today', 'Awk column', 'Literal brace']);
  assert.equal(seen[0].kind, 'command');
  assert.equal(seen[0].os, 'win', 'the Windows variants on Windows');
  assert.equal(seen[0].lang, 'en');
  assert.deepEqual(plain(seen[seen.length - 1].user), userSnippets, 'agents.yaml snippets are passed in once the config arrives');

  const aiFirst = await createEnv({ SlotSnippets, localStorage: { [MODE_KEY]: 'ai' } });
  aiFirst.setNote('x', 0, 0);
  aiFirst.ctrl('e');
  assert.equal(aiFirst.el('cli-snippets').children.length, 0, 'the AI mode does not build the list');
  aiFirst.fire('cli-filter-input', 'keydown', { key: 'Tab' });
  assert.equal(aiFirst.el('cli-snippets').children[0].value, 'echo mine', 'switching to the manual mode shows the presets');
  assert.equal(aiFirst.el('cli-snippets').children.length, fixed.length + 5);

  const broken = await createEnv({ SlotSnippets: { list: () => { throw new Error('nope'); } } });
  broken.setNote('x', 0, 0);
  broken.ctrl('e');
  assert.deepEqual(broken.el('cli-snippets').children.map((o) => o.value), fixed, 'a failing library falls back to the fixed list');
  const empty = await createEnv({ SlotSnippets: { list: () => [] } });
  empty.setNote('x', 0, 0);
  empty.ctrl('e');
  assert.deepEqual(empty.el('cli-snippets').children.map((o) => o.value), fixed, 'an empty library leaves exactly the fixed list');
});

// ---- where the output goes ---------------------------------------------------------------------------
async function runCommandBar(configure, note, start, end, output) {
  const runs = [];
  const env = await createEnv({
    backend: {
      validateCliCommand: async () => ({ isBlocked: false }),
      runCommandFilterAsync: (reqID, cmd, input) => { runs.push({ reqID, cmd, input }); }
    }
  });
  env.config.cli.openResultInNewTab = false; // put the output into the note itself
  configure(env.config);
  env.setNote(note, start, end);
  const tabId = env.bridge.getTabIdForEditor(env.editor); // the note the command ran on (a result tab may take over the editor)
  env.ctrl('e');
  env.el('cli-filter-input').value = 'sort';
  env.fire('cli-filter-input', 'keydown', { key: 'Enter', keyCode: 13 });
  await env.flush();
  assert.equal(runs.length, 1, 'the command ran once');
  env.window.__onCliFilterResult(runs[0].reqID, { output, error: '', exitCode: 0 }, '');
  await env.flush();
  return { env, run: runs[0], tabId };
}

check('command bar output goes BELOW the selected text by default: the selection stays', async () => {
  const { env, run } = await runCommandBar(() => {}, 'b\na\nc', 0, 3, 'a\nb\n');
  assert.equal(run.input, 'b\na', 'the selection was the input');
  assert.equal(env.editor.value, 'b\na\na\nb\nc', 'the selected lines stay and the output follows them');

  const partial = await runCommandBar(() => {}, 'xx b\na yy\nc', 3, 6, 'OUT\n');
  assert.equal(partial.env.editor.value, 'xx b\na yy\nOUT\nc', 'a selection ending inside a line: the output goes under that whole line');

  const withBreak = await runCommandBar(() => {}, 'b\na\nc', 0, 4, 'a\nb\n');
  assert.equal(withBreak.env.editor.value, 'b\na\na\nb\nc', 'a selection that took its last line break with it: the output still goes right below the text');

  const last = await runCommandBar(() => {}, 'b\na', 0, 3, 'a\nb');
  assert.equal(last.env.editor.value, 'b\na\na\nb', 'the selection is the end of the note');

  const nothing = await runCommandBar(() => {}, 'b\na', 0, 3, '\n');
  assert.equal(nothing.env.editor.value, 'b\na', 'no output: nothing is inserted');
});

check('command bar output over the selection when the setting says "replace" (the classic filter)', async () => {
  const { env } = await runCommandBar((cfg) => { cfg.cli.resultPlacement = 'replace'; }, 'b\na\nc', 0, 3, 'a\nb\n');
  assert.equal(env.editor.value, 'a\nb\n\nc', 'the selection is replaced by the output, as before');

  const junk = await runCommandBar((cfg) => { cfg.cli.resultPlacement = 'sideways'; }, 'b\na\nc', 0, 3, 'a\nb\n');
  assert.equal(junk.env.editor.value, 'b\na\na\nb\nc', 'an unknown value means the default (below)');
});

check('command bar with no selection and results kept out of a tab: below adds to the end of the note, replace overwrites it', async () => {
  const below = await runCommandBar(() => {}, 'abc\n', 0, 0, 'X\n');
  assert.equal(below.run.input, 'abc\n', 'the whole note was the input');
  assert.equal(below.env.editor.value, 'abc\nX\n', 'the note stays and the output is added after its last line');

  const replace = await runCommandBar((cfg) => { cfg.cli.resultPlacement = 'replace'; }, 'abc\n', 0, 0, 'X\n');
  assert.equal(replace.env.editor.value, 'X\n', 'the classic behaviour: the whole note is replaced');

  const empty = await runCommandBar(() => {}, '', 0, 0, 'X\n');
  assert.equal(empty.env.editor.value, 'X\n', 'an empty note has nothing to keep');
});

check('command bar: output that is the very text the command ran on is not added below it (no second copy of the selection or of the note)', async () => {
  const notice = I18N.en.cliNoChange.replace('{cmd}', 'sort');

  const same = await runCommandBar(() => {}, 'a\nb\nc', 0, 3, 'a\nb\n');
  assert.equal(same.run.input, 'a\nb', 'the selection was the input');
  assert.equal(same.env.editor.value, 'a\nb\nc', 'lines that were sorted already: the note is left alone');
  assert.ok(same.env.messages.includes(notice), `and a message says why: ${JSON.stringify(same.env.messages)}`);

  const crlf = await runCommandBar(() => {}, 'a\nb\nc', 0, 3, 'a\r\nb\r\n');
  assert.equal(crlf.env.editor.value, 'a\nb\nc', 'Windows line breaks and a trailing line break do not make it another text');

  const whole = await runCommandBar(() => {}, 'abc\n', 0, 0, 'abc\n');
  assert.equal(whole.env.editor.value, 'abc\n', 'nothing selected: the note is not appended to itself');
  assert.ok(whole.env.messages.includes(notice));

  const changed = await runCommandBar(() => {}, 'b\na\nc', 0, 3, 'a\nb\n');
  assert.equal(changed.env.editor.value, 'b\na\na\nb\nc', 'a different output is still added below');
  assert.ok(!changed.env.messages.includes(notice), 'without the message');

  const indent = await runCommandBar(() => {}, ' a\nb', 0, 4, 'a\nb\n');
  assert.equal(indent.env.editor.value, ' a\nb\na\nb', 'leading white space is content: that output is another text and is added');

  const replace = await runCommandBar((cfg) => { cfg.cli.resultPlacement = 'replace'; }, 'a\nb\nc', 0, 3, 'a\nb\n');
  assert.equal(replace.env.editor.value, 'a\nb\n\nc', 'the classic replace is untouched: the output still goes over the selection');
  assert.ok(!replace.env.messages.includes(notice));

  const tab = await runCommandBar((cfg) => { cfg.cli.openResultInNewTab = true; }, 'a\nb\nc', 0, 3, 'a\nb\n');
  assert.equal(tab.env.bridge.getTabText(tab.tabId), 'a\nb\nc', 'with a result tab the note is left alone as well');
  assert.ok(tab.env.messages.includes(I18N.en.cliSuccessTabOpened), 'and the tab still opens');
});

check('the placement is a setting: default below, the select is in Settings and is saved and loaded', async () => {
  const fresh = await createEnv();
  assert.equal(fresh.config.cli.resultPlacement, 'below', 'the default');
  const html = read('frontend/index.html');
  assert.match(html, /<select id="cfg-cli-result-placement"[^>]*>[\s\S]*value="below"[\s\S]*value="replace"[\s\S]*<\/select>/);
  const app = read('frontend/js/app.js');
  assert.match(app, /cfg-cli-result-placement'\);\s*if \(cliResultPlacementEl\) cliResultPlacementEl\.value = cliResultPlacement\(\);/, 'loaded into the dialog');
  assert.match(app, /config\.cli\.resultPlacement = saveCliResultPlacementEl\.value === 'replace' \? 'replace' : 'below'/, 'saved from the dialog');
  for (const lang of ['en', 'ja']) {
    for (const key of ['cliResultPlacementLabel', 'cliResultPlacementBelow', 'cliResultPlacementReplace', 'cliResultPlacementHint']) {
      assert.ok(I18N[lang][key] && I18N[lang][key].length > 3, `${lang}.${key}`);
    }
  }
});

check('command history entries are labelled in the UI language (the label used to be Japanese in every language)', async () => {
  const store = () => ({ md_memo_cli_history: JSON.stringify(['ls -la']) });
  const en = await createEnv({ localStorage: store() });
  en.setNote('x', 0, 0);
  en.ctrl('e');
  assert.equal(en.el('cli-snippets').children[0].value, 'ls -la');
  assert.equal(en.el('cli-snippets').children[0].label, '(history) ls -la');

  const ja = await createEnv({ localStorage: store() });
  ja.config.general.language = 'ja';
  ja.setNote('x', 0, 0);
  ja.ctrl('e');
  assert.equal(ja.el('cli-snippets').children[0].label, '(履歴) ls -la');
});

// The module belongs to another agent and may not load yet (its own test suite reports that): then this is skipped.
check('command presets from the real SlotSnippets module: only commands that can run as they are, in the platform\'s variant', async () => {
  const lib = vm.createContext({});
  try {
    vm.runInContext(read('frontend/js/slot_snippets.js'), lib);
  } catch (err) {
    throw new Skip(`frontend/js/slot_snippets.js does not load: ${err.message}`);
  }
  assert.equal(typeof lib.SlotSnippets.list, 'function', 'the module is a plain script that defines SlotSnippets');
  const env = await createEnv({ SlotSnippets: lib.SlotSnippets });
  env.setNote('x', 0, 0);
  env.ctrl('e');
  const values = env.el('cli-snippets').children.map((o) => o.value);
  assert.ok(values.includes('git status'), 'the shared command snippets appear');
  assert.ok(values.some((v) => v.startsWith('Get-Date')), 'the PowerShell variant on Windows');
  assert.ok(!values.some((v) => v.startsWith('date ')), 'not the Unix one');
  assert.ok(values.length >= 5);
  assert.ok(!values.some((v) => /\$\{|\$0/.test(v)), 'no ${selection} / $0 placeholder reaches the input');
  assert.ok(env.el('cli-snippets').children.every((o) => o.label && o.label.length > 0), 'every preset has a label');
});

// ---- settings --------------------------------------------------------------------------------------
check('Auto selector settings: defaults for an old config, saved values win, and the bridge reports them', async () => {
  const fresh = await createEnv();
  assert.deepEqual({ ...fresh.bridge.getAutoSelectorConfig() }, { enabled: true, agentConfirm: true });
  assert.deepEqual({ ...fresh.config.autoSelector }, { enabled: true, agentConfirm: true }, 'the default is in the config object too');

  const old = await createEnv({ localStorage: oldConfigStore() });
  assert.deepEqual({ ...old.bridge.getAutoSelectorConfig() }, { enabled: true, agentConfirm: true }, 'an old config (no such group) gets the defaults');

  const off = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled: false } }) } });
  assert.deepEqual({ ...off.bridge.getAutoSelectorConfig() }, { enabled: false, agentConfirm: true }, 'a partial group keeps the other default');

  const backend = await createEnv({ backendConfig: { autoSelector: { agentConfirm: false } } });
  assert.deepEqual({ ...backend.bridge.getAutoSelectorConfig() }, { enabled: true, agentConfirm: false }, 'the backend copy is merged too');

  const junk = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: 'yes' }) }, backendConfig: { autoSelector: 42 } });
  assert.deepEqual({ ...junk.bridge.getAutoSelectorConfig() }, { enabled: true, agentConfirm: true }, 'garbage is ignored');

  const snapshot = fresh.bridge.getAutoSelectorConfig();
  snapshot.enabled = false;
  assert.equal(fresh.bridge.getAutoSelectorConfig().enabled, true, 'the returned object is a copy');
});

check('Auto selector settings: the dialog shows the saved values and Save writes them back', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ autoSelector: { enabled: false, agentConfirm: false } }) } });
  const enabled = env.el('cfg-autosel-enabled');
  const confirm = env.el('cfg-autosel-agent-confirm');
  enabled.checked = true;
  confirm.checked = true;
  env.ctrl(',');
  assert.equal(env.hidden('settings-modal'), false, 'Ctrl+, opens the settings');
  assert.equal(enabled.checked, false);
  assert.equal(confirm.checked, false);
  assert.equal(confirm.disabled, true, 'the confirm option is muted while the selector is off');

  enabled.checked = true;
  enabled._listeners.change.forEach((fn) => fn({}));
  assert.equal(confirm.disabled, false);
  confirm.checked = true;
  await env.el('btn-save-settings').onclick();
  assert.deepEqual({ ...env.config.autoSelector }, { enabled: true, agentConfirm: true });
  assert.deepEqual({ ...env.bridge.getAutoSelectorConfig() }, { enabled: true, agentConfirm: true });
  await env.flush();
  assert.deepEqual({ ...env.saved[env.saved.length - 1].autoSelector }, { enabled: true, agentConfirm: true }, 'and it is persisted with the rest of the config');
});

check('the palette, the toolbar tooltip and the context-menu label follow the configured keys', async () => {
  const env = await createEnv();
  assert.equal(env.el('sc-ctx-command-bar').textContent, 'Ctrl+E');
  assert.equal(env.el('btn-header-llm').title, 'Ask AI (Ctrl+L)');
  env.config.shortcuts.commandBar = '';
  env.window.__testHelper.applyLanguage();
  assert.equal(env.el('sc-ctx-command-bar').textContent, '', 'an unassigned command-bar key shows no stale label');
  assert.equal(env.el('sc-ctx-inline-prompt').textContent, 'Ctrl+L');
  env.config.shortcuts.inlinePrompt = 'Ctrl+Alt+L';
  env.window.__testHelper.applyLanguage();
  assert.equal(env.el('btn-header-llm').title, 'Ask AI (Ctrl+Alt+L)');
  assert.equal(env.el('sc-ctx-inline-prompt').textContent, 'Ctrl+Alt+L');
  env.config.shortcuts.inlinePrompt = '';
  env.window.__testHelper.applyLanguage();
  assert.equal(env.el('sc-ctx-inline-prompt').textContent, '', 'a cleared ask key leaves no stale label in the menu');
});

check('no emoji anywhere in the new markup, styles and strings', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const bar = indexHtml.slice(indexHtml.indexOf('id="inline-prompt-bar"'), indexHtml.indexOf('<!-- Primary Pane (Left) -->'));
  assert.ok(!EMOJI.test(bar.replace(/✕/g, '')), 'the two bars');
  const chipCss = styleCss.slice(styleCss.indexOf('.inline-prompt-meta'), styleCss.indexOf('#inline-prompt-input,'));
  assert.ok(!EMOJI.test(chipCss));
  const bridge = appCode.slice(appCode.indexOf('// --- LLM tasks:'), appCode.indexOf('// Vision / Image LLM Query'));
  assert.ok(!EMOJI.test(bridge), 'the LLM task engine');
  const askBar = appCode.slice(appCode.indexOf('// --- Ask Bar (Ctrl+L)'), appCode.indexOf('// AI Typo, Mistake & Context Correction'));
  assert.ok(!EMOJI.test(askBar), 'the ask bar code');
});

// ---------------------------------------------------------------------------------------------------
let failed = 0;
let skipped = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    if (err instanceof Skip) {
      skipped++;
      console.warn(`SKIP: ${name}\n  ${err.message}`);
      continue;
    }
    failed++;
    console.error(`FAIL: ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n  ') : err}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${queue.length} ask / command bar test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${queue.length - skipped} ask bar / command bar tests passed with 0 error(s)!${skipped ? ` (${skipped} skipped, see above)` : ''}`);
