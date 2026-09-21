// Evaluation-driven tests for the settings-screen mistake-proofing pass:
//   - clampNumber() behavior (every numeric settings field is saved through it)
//   - shortcut duplicate/reserved-combo detection while recording
//   - Cancel/Esc/x restoring language/theme/default_agent/shortcuts applied live
//   - Quick Actions enabled/manual-only field coupling
//   - presence of the new i18n keys this pass introduced, in both languages
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Normalize line endings: this file has a mix of LF and CRLF (Windows
// checkout + cross-platform edits), and exact multi-line substring checks
// below would otherwise be fragile against \r\n.
const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8').replace(/\r\n/g, '\n');
const i18nCode = fs.readFileSync(path.resolve('frontend/js/i18n.js'), 'utf-8').replace(/\r\n/g, '\n');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

// Extract a top-level `function name(...) { ... }` block from source text by
// brace matching (same technique as tests/hot_path_parity_test.mjs).
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `function ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1);
}

// Extract a top-level `const NAME = [ ... ];` or `const NAME = ' ... ';`
// style declaration (bracket-matched, terminated by the matching `]`/`}` then `;`).
function extractConstArray(source, name) {
  const marker = `const ${name} = [`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `const ${name} not found in source`);
  const bracketStart = source.indexOf('[', start);
  let depth = 0;
  let i = bracketStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1) + ';';
}

// Same as extractConstArray but for a `const NAME = { ... };` object literal.
function extractConstObject(source, name) {
  const marker = `const ${name} = {`;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `const ${name} not found in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.substring(start, i + 1) + ';';
}

function evalInSandbox(code, exportName) {
  const context = vm.createContext({ console });
  vm.runInContext(`${code}\nglobalThis.__out = ${exportName};`, context);
  return context.__out;
}

// ---------------------------------------------------------------------------
// clampNumber: every numeric settings save site routes through this
// ---------------------------------------------------------------------------
const clampNumber = evalInSandbox(extractFunction(appCode, 'clampNumber'), 'clampNumber');

check('clampNumber clamps below min, above max, and passes through in-range values', () => {
  assert.equal(clampNumber('-50', 10, 600, 180), 10, 'negative value clamps to min');
  assert.equal(clampNumber('99999', 10, 600, 180), 600, 'over-max value clamps to max');
  assert.equal(clampNumber('300', 10, 600, 180), 300, 'in-range value passes through');
  assert.equal(clampNumber('', 10, 600, 180), 180, 'empty value falls back');
  assert.equal(clampNumber('abc', 10, 600, 180), 180, 'garbage value falls back');
  assert.equal(clampNumber('0.5', 200, 2000, 500), 200, 'float string on an integer field truncates then clamps to min');
});

check('clampNumber supports float fields (e.g. Quick Actions delay, step 0.5)', () => {
  assert.equal(clampNumber('-1', 0.5, 10.0, 1.5, true), 0.5, 'negative float clamps to min');
  assert.equal(clampNumber('999', 0.5, 10.0, 1.5, true), 10.0, 'over-max float clamps to max');
  assert.equal(clampNumber('3.5', 0.5, 10.0, 1.5, true), 3.5, 'in-range float passes through unrounded');
  assert.equal(clampNumber('', 0.5, 10.0, 1.5, true), 1.5, 'empty float falls back');
});

check('every numeric settings save site uses clampNumber with the input\'s own min/max', () => {
  const expectedCalls = [
    "clampNumber(document.getElementById('cfg-auto-delay').value, 200, 2000, 500)",
    "clampNumber(document.getElementById('cfg-auto-tokens').value, 10, 100, 30)",
    "clampNumber(saveActDelayEl.value, 0.5, 10.0, 1.5, true)",
    "clampNumber(saveSlotTimeoutEl.value, 10, 600, 180)",
    "clampNumber(saveGhostDiffEl.value, 1000, 10000, 4000)",
    "clampNumber(saveGitDebounceEl.value, 5, 3600, 30)",
    "clampNumber(saveMaxPipeSizeEl.value, 1, 100, 10)"
  ];
  for (const snippet of expectedCalls) {
    assert.ok(appCode.includes(snippet), `expected save-site call missing: ${snippet}`);
  }
  assert.ok(!appCode.includes("parseInt(saveSlotTimeoutEl.value, 10) || 180"), 'old unclamped timeout parse should be gone');
  assert.ok(!appCode.includes("parseFloat(saveActDelayEl.value)"), 'old unclamped delay parseFloat should be gone');
});

check('numeric settings inputs are reflected/clamped on blur', () => {
  assert.ok(appCode.includes('function wireNumberInputClamp('), 'wireNumberInputClamp helper exists');
  ['cfg-auto-delay', 'cfg-auto-tokens', 'cfg-max-pipe-size', 'cfg-slot-timeout', 'cfg-slot-ghost-diff-ms', 'cfg-action-delay', 'cfg-git-debounce'].forEach((id) => {
    assert.ok(appCode.includes(`wireNumberInputClamp('${id}'`), `${id} should be wired for blur-clamp`);
  });
});

// ---------------------------------------------------------------------------
// Shortcut recorder: reserved combos + duplicate-binding detection + clearing
// ---------------------------------------------------------------------------
const normalizeAndReservedCode = [
  extractFunction(appCode, 'normalizeComboForCompare'),
  extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_WIN'),
  extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_MAC'),
  extractFunction(appCode, 'getReservedSystemShortcuts'),
  extractFunction(appCode, 'isReservedSystemShortcut')
].join('\n');

// isMac is injected into the sandbox exactly like matchShortcut's own tests do
// (see tests/hot_path_parity_test.mjs), so both the Windows and macOS reserved
// lists can be exercised without loading all of app.js.
function loadShortcutReservedFns(isMac = false) {
  const context = vm.createContext({ console, isMac });
  vm.runInContext(`${normalizeAndReservedCode}\nglobalThis.__isReserved = isReservedSystemShortcut;\nglobalThis.__normalize = normalizeComboForCompare;`, context);
  return { isReservedSystemShortcut: context.__isReserved, normalizeComboForCompare: context.__normalize };
}

check('Windows/Linux: reserved system combos (Ctrl+Tab, Ctrl+comma) are recognized regardless of Cmd/Ctrl or key order', () => {
  const { isReservedSystemShortcut } = loadShortcutReservedFns(false);
  assert.equal(isReservedSystemShortcut('Ctrl+Tab'), true);
  assert.equal(isReservedSystemShortcut('Cmd+Tab'), true, 'Cmd is treated as Ctrl for this comparison');
  assert.equal(isReservedSystemShortcut('Ctrl+,'), true);
  // F11 is the default of the full screen action and can be rebound like any other key
  assert.equal(isReservedSystemShortcut('F11'), false, 'F11 is an ordinary, rebindable key');
  assert.equal(isReservedSystemShortcut('Ctrl+S'), false, 'an ordinary combo is not reserved');
  assert.equal(isReservedSystemShortcut(''), false, 'an empty combo is never reserved');
});

check('macOS: native menu/system combos are reserved instead of the Windows set', () => {
  const { isReservedSystemShortcut } = loadShortcutReservedFns(true);
  // Native app/Edit menu equivalents that consume the keydown before the
  // WKWebView ever sees it.
  ['Cmd+Q', 'Cmd+H', 'Cmd+Option+H', 'Cmd+M', 'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A', 'Cmd+Tab', 'Cmd+Space'].forEach((combo) => {
    assert.equal(isReservedSystemShortcut(combo), true, `${combo} should be reserved on macOS`);
  });
  // Ctrl+Tab is hardcoded for tab cycling on every platform, including macOS.
  assert.equal(isReservedSystemShortcut('Ctrl+Tab'), true, 'Ctrl+Tab stays reserved on macOS (hardcoded tab cycling)');
  // Cmd+, is reserved because the app itself hardcodes a Cmd/Ctrl+, fallback to
  // open Settings (see the global keydown handler), independent of platform.
  assert.equal(isReservedSystemShortcut('Cmd+,'), true, 'Cmd+, is reserved on macOS (app-hardcoded Settings fallback)');
  // F11 is NOT reserved on macOS: Mission Control eats it before the WKWebView
  // ever sees it, and the mac default for toggleMaximize is Ctrl+Cmd+F, not F11.
  assert.equal(isReservedSystemShortcut('F11'), false, 'F11 is not reserved on macOS');
  assert.equal(isReservedSystemShortcut('Cmd+S'), false, 'an ordinary combo is not reserved on macOS');
});

check('app-fixed shortcuts and browser editing keys cannot be assigned on either platform', () => {
  const fixed = ['Ctrl+Shift+V', 'Ctrl+Alt+V', 'Alt+T', 'Ctrl+ArrowRight'];
  const win = loadShortcutReservedFns(false);
  for (const combo of [...fixed, 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y']) {
    assert.equal(win.isReservedSystemShortcut(combo), true, `${combo} should be reserved on Windows/Linux`);
  }
  const mac = loadShortcutReservedFns(true);
  for (const combo of ['Cmd+Shift+V', 'Cmd+Option+V', 'Option+T', 'Cmd+ArrowRight']) {
    assert.equal(mac.isReservedSystemShortcut(combo), true, `${combo} should be reserved on macOS`);
  }
  assert.equal(win.isReservedSystemShortcut('Ctrl+Shift+B'), false, 'a free combo stays assignable');
});

check('voice input is a configurable shortcut, not an app-fixed one', () => {
  // Ctrl/Cmd+Shift+R used to be handled outside the registry and was reserved; now it is the
  // default of the voiceInput action and must be assignable (and re-assignable) like any other.
  const win = loadShortcutReservedFns(false);
  const mac = loadShortcutReservedFns(true);
  assert.equal(win.isReservedSystemShortcut('Ctrl+Shift+R'), false, 'Ctrl+Shift+R is not reserved on Windows/Linux');
  assert.equal(mac.isReservedSystemShortcut('Cmd+Shift+R'), false, 'Cmd+Shift+R is not reserved on macOS');
  const winDefaults = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'), 'DEFAULT_SHORTCUTS_WIN');
  const macDefaults = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'), 'DEFAULT_SHORTCUTS_MAC');
  assert.equal(winDefaults.voiceInput, 'Ctrl+Shift+R');
  assert.equal(macDefaults.voiceInput, 'Cmd+Shift+R');
  assert.equal(win.isReservedSystemShortcut(winDefaults.voiceInput), false, 'the default itself must not be reserved');
  assert.equal(mac.isReservedSystemShortcut(macDefaults.voiceInput), false);
  const groups = evalInSandbox(extractConstArray(appCode, 'SHORTCUT_GROUPS'), 'SHORTCUT_GROUPS');
  const aiGroup = groups.find((g) => g.titleKey === 'shortcutGroupAI');
  assert.ok(aiGroup && aiGroup.actions.some((a) => a.key === 'voiceInput' && a.labelKey === 'shortcutActionVoiceInput'),
    'voiceInput must be listed in the AI group of the shortcut editor');
});

check('no default shortcut collides with an app-fixed combo', () => {
  const fixedNorm = ['Ctrl+Shift+V', 'Ctrl+Alt+V', 'Alt+T', 'Ctrl+ArrowRight'];
  for (const [name, isMac] of [['DEFAULT_SHORTCUTS_WIN', false], ['DEFAULT_SHORTCUTS_MAC', true]]) {
    const { normalizeComboForCompare } = loadShortcutReservedFns(isMac);
    const defaults = evalInSandbox(extractConstObject(appCode, name), name);
    const fixedSet = new Set(fixedNorm.map(normalizeComboForCompare));
    for (const [action, combo] of Object.entries(defaults)) {
      assert.equal(fixedSet.has(normalizeComboForCompare(combo)) && !!combo, false, `${name}.${action} (${combo}) collides with an app-fixed shortcut`);
    }
  }
});

check('every default shortcut is assignable: none is reserved except the deliberate ones', () => {
  // zenMode on macOS is Ctrl+Cmd+Z: the comparison folds Ctrl into Cmd, so it reads as the reserved Cmd+Z.
  const deliberate = { DEFAULT_SHORTCUTS_WIN: ['toggleMaximize', 'openSettings'], DEFAULT_SHORTCUTS_MAC: ['minimize', 'openSettings', 'zenMode'] };
  for (const [name, isMac] of [['DEFAULT_SHORTCUTS_WIN', false], ['DEFAULT_SHORTCUTS_MAC', true]]) {
    const { isReservedSystemShortcut } = loadShortcutReservedFns(isMac);
    const defaults = evalInSandbox(extractConstObject(appCode, name), name);
    for (const [action, combo] of Object.entries(defaults)) {
      if (!combo || deliberate[name].includes(action)) continue;
      assert.equal(isReservedSystemShortcut(combo), false, `${name}.${action} (${combo}) is a reserved combo, so the action could never fire`);
    }
  }
});

check('Ctrl/Cmd+Enter in every variant is reserved (SlotAgent takes them all), so nothing can be bound to them', () => {
  for (const [isMac, combos] of [[false, ['Ctrl+Enter', 'Ctrl+Shift+Enter', 'Ctrl+Alt+Enter', 'Ctrl+Shift+Alt+Enter']],
                                 [true, ['Cmd+Enter', 'Cmd+Shift+Enter', 'Cmd+Option+Enter', 'Cmd+Shift+Option+Enter']]]) {
    const { isReservedSystemShortcut } = loadShortcutReservedFns(isMac);
    for (const combo of combos) assert.equal(isReservedSystemShortcut(combo), true, `${combo} must be reserved`);
    assert.equal(isReservedSystemShortcut(isMac ? 'Option+Enter' : 'Alt+Enter'), false, 'Alt/Option+Enter stays free');
  }
});

check('Insert line below/above default to Shift+Enter / Shift+Alt+Enter, not the Ctrl+Enter family', () => {
  const win = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'), 'DEFAULT_SHORTCUTS_WIN');
  const mac = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'), 'DEFAULT_SHORTCUTS_MAC');
  assert.equal(win.insertLineBelow, 'Shift+Enter');
  assert.equal(win.insertLineAbove, 'Shift+Alt+Enter');
  assert.equal(mac.insertLineBelow, 'Shift+Enter');
  assert.equal(mac.insertLineAbove, 'Shift+Option+Enter');
});

check('Zen mode defaults to Shift+F11 on Windows/Linux (Ctrl+Shift+Z is Redo) and keeps Ctrl+Cmd+Z on macOS', () => {
  const win = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'), 'DEFAULT_SHORTCUTS_WIN');
  const mac = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'), 'DEFAULT_SHORTCUTS_MAC');
  assert.equal(win.zenMode, 'Shift+F11');
  assert.equal(mac.zenMode, 'Ctrl+Cmd+Z');
  // Redo must never be bindable to an action on Windows/Linux (macOS already reserves Cmd+Shift+Z).
  assert.equal(loadShortcutReservedFns(false).isReservedSystemShortcut('Ctrl+Shift+Z'), true);
});

check('the keydown handler no longer hard-wires Ctrl+Shift+Z to Zen mode, and F11 is only ever the configured full screen key', () => {
  assert.ok(!/isCtrl && e\.shiftKey && \(e\.key === 'z'/.test(appCode), 'the hard-wired Ctrl+Shift+Z Zen fallback is gone');
  assert.match(appCode, /matchShortcut\(e, config\.shortcuts && config\.shortcuts\.zenMode\)\) \{\s*e\.preventDefault\(\);\s*toggleZenMode\(\);/);
  assert.ok(!appCode.includes("e.key === 'F11'"), 'F11 is not hard-wired to anything: Shift+F11 belongs to Zen mode, a plain F11 to the configurable full screen key');
  assert.match(appCode, /matchShortcut\(e, config\.shortcuts && config\.shortcuts\.toggleFullscreen\)\) \{\s*e\.preventDefault\(\);\s*if \(!e\.repeat\) toggleFullscreen\(\);/);
});

function runShortcutMigrations(isMac, shortcuts, showToast = false) {
  const code = [
    extractConstObject(appCode, 'DEFAULT_SHORTCUTS_WIN'),
    extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'),
    'const DEFAULT_SHORTCUTS = isMac ? DEFAULT_SHORTCUTS_MAC : DEFAULT_SHORTCUTS_WIN;',
    'let shortcutMigrationDirty = false;',
    extractFunction(appCode, 'normalizeComboForCompare'),
    extractFunction(appCode, 'migrateInsertLineShortcuts'),
    extractFunction(appCode, 'migrateZenShortcut'),
  ].join('\n');
  const config = { shortcuts };
  const messages = [];
  const context = vm.createContext({
    console, isMac, config,
    showMessage: (msg) => messages.push(msg),
    t: (key, params) => `${key}:${params && params.sc}`,
    formatShortcutForDisplay: (combo) => combo,
  });
  vm.runInContext(`${code}\nglobalThis.__run = (toast) => { migrateInsertLineShortcuts(); migrateZenShortcut(toast); return shortcutMigrationDirty; };`, context);
  const dirty = context.__run(showToast);
  return { shortcuts: config.shortcuts, messages, dirty };
}

check('a saved config that still holds an old insert-line default is moved to the current one; custom bindings are kept', () => {
  const win = runShortcutMigrations(false, { insertLineBelow: 'Ctrl+Enter', insertLineAbove: 'Ctrl+Shift+Enter', newTab: 'Ctrl+N' });
  assert.equal(win.shortcuts.insertLineBelow, 'Shift+Enter');
  assert.equal(win.shortcuts.insertLineAbove, 'Shift+Alt+Enter');
  assert.equal(win.shortcuts.newTab, 'Ctrl+N', 'unrelated shortcuts are untouched');
  assert.equal(win.dirty, true, 'a change asks for the config to be saved once');

  const previous = runShortcutMigrations(false, { insertLineBelow: 'Alt+Enter' });
  assert.equal(previous.shortcuts.insertLineBelow, 'Shift+Enter', 'the short-lived Alt+Enter default moves too');

  const mac = runShortcutMigrations(true, { insertLineBelow: 'Cmd+Enter', insertLineAbove: 'Cmd+Shift+Enter' });
  assert.equal(mac.shortcuts.insertLineBelow, 'Shift+Enter');
  assert.equal(mac.shortcuts.insertLineAbove, 'Shift+Option+Enter');
  const mac2 = runShortcutMigrations(true, { insertLineBelow: 'Option+Enter' });
  assert.equal(mac2.shortcuts.insertLineBelow, 'Shift+Enter');

  const custom = runShortcutMigrations(false, { insertLineBelow: 'Ctrl+Alt+J', insertLineAbove: '' });
  assert.equal(custom.shortcuts.insertLineBelow, 'Ctrl+Alt+J', 'a binding the user chose is kept');
  assert.equal(custom.shortcuts.insertLineAbove, '', 'a cleared binding stays cleared');
  assert.equal(custom.dirty, false, 'nothing changed, nothing to save');

  const already = runShortcutMigrations(false, { insertLineBelow: 'Shift+Enter', insertLineAbove: 'Shift+Alt+Enter' });
  assert.equal(already.shortcuts.insertLineBelow, 'Shift+Enter');
  assert.equal(already.dirty, false);
});

check('a saved Ctrl+Shift+Z Zen binding moves to Shift+F11 on Windows/Linux with one notice; other bindings and macOS are left alone', () => {
  const moved = runShortcutMigrations(false, { zenMode: 'Ctrl+Shift+Z' }, true);
  assert.equal(moved.shortcuts.zenMode, 'Shift+F11');
  assert.deepEqual(moved.messages, ['zenShortcutMoved:Shift+F11'], 'exactly one notice, naming the new key');
  assert.equal(moved.dirty, true);

  const quiet = runShortcutMigrations(false, { zenMode: 'Ctrl+Shift+Z' }, false);
  assert.equal(quiet.shortcuts.zenMode, 'Shift+F11');
  assert.equal(quiet.messages.length, 0, 'the synchronous start-up load never toasts');

  const custom = runShortcutMigrations(false, { zenMode: 'Ctrl+Alt+Z' }, true);
  assert.equal(custom.shortcuts.zenMode, 'Ctrl+Alt+Z', 'a binding the user chose is kept');
  assert.equal(custom.messages.length, 0);

  const cleared = runShortcutMigrations(false, { zenMode: '' }, true);
  assert.equal(cleared.shortcuts.zenMode, '', 'a cleared Zen binding stays cleared');

  const mac = runShortcutMigrations(true, { zenMode: 'Ctrl+Cmd+Z' }, true);
  assert.equal(mac.shortcuts.zenMode, 'Ctrl+Cmd+Z');
  assert.equal(mac.messages.length, 0);
});

check('the migrations run on every config load path, before the macOS one, and the backend load saves the result once', () => {
  const calls = [...appCode.matchAll(/migrateInsertLineShortcuts\(\);\s*migrateZenShortcut\((?:true|false)\);\s*migrateAskShortcuts\((?:true|false)\);\s*(?:\/\/[^\n]*\n\s*)*migrateMacShortcuts\((?:true|false)\);/g)];
  assert.equal(calls.length, 3, 'local sync, import and backend load all migrate before migrateMacShortcuts');
  assert.match(appCode, /if \(shortcutMigrationDirty\) \{\s*shortcutMigrationDirty = false;\s*savePersistentConfig\(\);/);
});

// ---------------------------------------------------------------------------
// migrateMacShortcuts: zenMode default fix + reserved-combo fallback,
// run on every macOS config load (see app.js's loadLocalConfigSync,
// syncBackendConfig, and applyImportedConfig).
// ---------------------------------------------------------------------------
function loadMigrateMacShortcuts() {
  const code = [
    extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'),
    extractConstArray(appCode, 'SHORTCUT_GROUPS'),
    extractFunction(appCode, 'getAllShortcutActionKeys'),
    extractFunction(appCode, 'normalizeComboForCompare'),
    extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_WIN'),
    extractConstArray(appCode, 'RESERVED_SYSTEM_SHORTCUTS_MAC'),
    extractFunction(appCode, 'getReservedSystemShortcuts'),
    extractFunction(appCode, 'isReservedSystemShortcut'),
    extractFunction(appCode, 'migrateMacShortcuts')
  ].join('\n');

  return function run(shortcuts) {
    const messages = [];
    const config = { shortcuts };
    const context = vm.createContext({
      console,
      isMac: true,
      config,
      showMessage: (msg) => messages.push(msg),
      t: (key) => key
    });
    vm.runInContext(`${code}\nglobalThis.__migrate = migrateMacShortcuts;`, context);
    context.__migrate(true);
    return { shortcuts: config.shortcuts, messages };
  };
}

check('DEFAULT_SHORTCUTS_MAC.zenMode is Ctrl+Cmd+Z, not the Redo-colliding Cmd+Shift+Z', () => {
  const macDefaults = evalInSandbox(extractConstObject(appCode, 'DEFAULT_SHORTCUTS_MAC'), 'DEFAULT_SHORTCUTS_MAC');
  assert.equal(macDefaults.zenMode, 'Ctrl+Cmd+Z', 'zenMode must no longer default to Cmd+Shift+Z (native Redo)');
});

check('migrateMacShortcuts moves a stale Cmd+Shift+Z zenMode onto the new default, one-time and toast-free by itself', () => {
  const run = loadMigrateMacShortcuts();
  const result = run({ zenMode: 'Cmd+Shift+Z', newTab: 'Cmd+N' });
  assert.equal(result.shortcuts.zenMode, 'Ctrl+Cmd+Z', 'stale zenMode should be migrated to the new mac default');
  assert.equal(result.shortcuts.newTab, 'Cmd+N', 'unrelated shortcuts must be left alone');
});

check('migrateMacShortcuts leaves an already-correct zenMode untouched', () => {
  const run = loadMigrateMacShortcuts();
  const result = run({ zenMode: 'Ctrl+Cmd+Z' });
  assert.equal(result.shortcuts.zenMode, 'Ctrl+Cmd+Z');
  assert.equal(result.messages.length, 0, 'no fallback happened, so no toast');
});

check('migrateMacShortcuts falls back a Windows-imported combo that folds to a mac-reserved shortcut, and toasts once', () => {
  const run = loadMigrateMacShortcuts();
  // replace: 'Ctrl+H' folds to Cmd+H (Hide App) on macOS via matchShortcut's own
  // Ctrl->Cmd remap, which is reserved — must fall back to the mac default.
  const result = run({ replace: 'Ctrl+H' });
  assert.notEqual(result.shortcuts.replace, 'Ctrl+H', 'the reserved-folding combo must not survive migration');
  assert.equal(result.messages.length, 1, 'exactly one toast for the fallback');
});

check('migrateMacShortcuts leaves an intentional mac-reserved default alone (e.g. minimize: Cmd+M)', () => {
  const run = loadMigrateMacShortcuts();
  // minimize's own mac default (Cmd+M) IS in the reserved list on purpose
  // (handled natively) — migrateMacShortcuts must not "fall back" a shortcut
  // that already equals its own intended default, or it would toast on every
  // single untouched install.
  const result = run({ minimize: 'Cmd+M' });
  assert.equal(result.shortcuts.minimize, 'Cmd+M', 'an already-default reserved combo must be left alone');
  assert.equal(result.messages.length, 0, 'no toast for an untouched default');
});

check('normalizeComboForCompare treats modifier order/case and Ctrl/Cmd as equivalent', () => {
  const { normalizeComboForCompare } = loadShortcutReservedFns(false);
  assert.equal(normalizeComboForCompare('Ctrl+Shift+S'), normalizeComboForCompare('Shift+Ctrl+S'));
  assert.equal(normalizeComboForCompare('Ctrl+K'), normalizeComboForCompare('Cmd+K'));
  assert.equal(normalizeComboForCompare('Ctrl+k'), normalizeComboForCompare('Ctrl+K'), 'target key is case-insensitive');
  assert.notEqual(normalizeComboForCompare('Ctrl+K'), normalizeComboForCompare('Ctrl+Shift+K'));
});

check('customConfirm makes its OK button visible even though the markup ships it with class "hidden" (display: none !important)', () => {
  const fakeEl = (hidden) => {
    const classes = new Set(hidden ? ['hidden'] : []);
    return {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      style: { display: '' },
      textContent: '',
      focus() {},
      // what the browser would render: the .hidden rule wins over any inline display
      get visible() { return !classes.has('hidden') && this.style.display !== 'none'; },
    };
  };
  const els = {
    confirmModal: fakeEl(true), confirmModalMessage: fakeEl(false), confirmModalSave: fakeEl(false),
    confirmModalDontSave: fakeEl(false), confirmModalOk: fakeEl(true), confirmModalCancel: fakeEl(false), confirmModalClose: fakeEl(false),
  };
  const context = vm.createContext({
    ...els, console, t: (key) => key, setTimeout: () => 1, clearTimeout: () => {},
    window: { addEventListener() {}, removeEventListener() {} },
  });
  vm.runInContext(`${extractFunction(appCode, 'customConfirm')}\nglobalThis.__confirm = customConfirm;`, context);
  const pending = context.__confirm('Already assigned. Overwrite?');
  assert.equal(els.confirmModalOk.visible, true, 'the OK button must be visible while the dialog is open');
  assert.equal(els.confirmModalCancel.visible, true, 'Cancel stays visible');
  assert.equal(els.confirmModalSave.visible, false, 'the Save button of the unsaved-tab dialog stays hidden');
  els.confirmModalOk.onclick();
  assert.equal(els.confirmModal.classList.contains('hidden'), true, 'clicking OK closes the dialog');
  assert.ok(pending && typeof pending.then === 'function', 'customConfirm returns a promise');
});

check('the recorder detects a combo already bound to another action and offers to overwrite via the existing customConfirm dialog (not window.confirm)', () => {
  assert.ok(appCode.includes('function findShortcutConflict('), 'findShortcutConflict exists');
  assert.ok(appCode.includes("customConfirm(t('shortcutOverwriteConfirm'"), 'conflict prompts through the existing in-app confirm modal');
  assert.ok(!/window\.confirm\(/.test(appCode.match(/window\.addEventListener\('keydown', \(e\) => \{\s*if \(activeRecordingAction\)[\s\S]{0,3000}/)?.[0] || ''), 'the recorder must not use a blocking window.confirm()');
});

check('Backspace/Delete clears the recording action\'s binding, and Esc still cancels', () => {
  const recorderSection = appCode.slice(appCode.indexOf("window.addEventListener('keydown', (e) => {\n    if (activeRecordingAction)"));
  assert.ok(recorderSection.slice(0, 3000).includes("e.key === 'Backspace' || e.key === 'Delete'"), 'Backspace/Delete branch exists in the recorder');
  assert.ok(recorderSection.slice(0, 3000).includes("commitShortcutAssignment(recordingKey, '', null)"), 'clearing commits an empty string, which the registry already supports');
  assert.ok(recorderSection.slice(0, 500).includes("e.key === 'Escape'"), 'Esc still cancels recording');
});

check('recorder hint text updates while recording (Press keys to set / Backspace to clear / Esc to cancel)', () => {
  assert.ok(appCode.includes("t('shortcutRecordingHint')"), 'the recording hint key is used');
  assert.ok(appCode.includes("activeRecordingAction ? t('shortcutRecordingHint') : t('shortcutsHint')"), 'the hint toggles based on recording state');
});

// ---------------------------------------------------------------------------
// Settings Cancel/Esc/x restores anything applied live (language, theme,
// default_agent, and shortcuts mutated in-memory while recording)
// ---------------------------------------------------------------------------
check('a dedicated restore function reverts language/theme/default_agent/shortcuts from the open-time snapshot', () => {
  assert.ok(appCode.includes('function restoreLiveConfigFromSnapshot()'), 'restoreLiveConfigFromSnapshot exists');
  const fn = extractFunction(appCode, 'restoreLiveConfigFromSnapshot');
  assert.ok(fn.includes('config.general.language'), 'restores language');
  assert.ok(fn.includes('config.general.theme'), 'restores theme');
  assert.ok(fn.includes('config.default_agent'), 'restores default_agent (agents.yaml write is deferred to Save)');
  assert.ok(fn.includes('config.shortcuts'), 'restores shortcuts mutated live while recording');
  assert.ok(fn.includes('applyLanguage()'), 'reverted language is actually re-applied');
});

check('Cancel/x/Esc call cancelSettings() (restore + close), never a bare closeSettings() that skips the restore', () => {
  assert.ok(appCode.includes('function cancelSettings()'), 'cancelSettings exists');
  assert.ok(appCode.includes("restoreLiveConfigFromSnapshot();\n    closeSettings();"), 'cancelSettings restores before closing');
  assert.ok(appCode.includes("document.getElementById('modal-close').onclick = cancelSettings;"), 'the × button cancels (not a bare close)');
  assert.ok(appCode.includes("document.getElementById('btn-cancel-settings').onclick = cancelSettings;"), 'the Cancel button cancels (not a bare close)');
  assert.ok(/if \(!settingsModal\.classList\.contains\('hidden'\)\) \{\s*cancelSettings\(\);/.test(appCode), 'Esc cancels (not a bare close)');
});

check('Save never calls the cancel/restore path (a real Save must not be undone)', () => {
  const saveHandlerStart = appCode.indexOf("document.getElementById('btn-save-settings').onclick");
  assert.ok(saveHandlerStart !== -1, 'save button handler assignment found');
  const nextHandlerStart = appCode.indexOf('function applyImportedConfig', saveHandlerStart);
  assert.ok(nextHandlerStart !== -1, 'end-of-save-handler marker found');
  const saveHandlerBody = appCode.substring(saveHandlerStart, nextHandlerStart);
  assert.ok(!saveHandlerBody.includes('cancelSettings()'), 'Save handler must not call cancelSettings()');
  assert.ok(saveHandlerBody.includes('closeSettings();'), 'Save still closes the dialog directly');
});

check('the default agent select only updates in-memory config on change; agents.yaml is written from Save, not onchange', () => {
  const onchangeStart = appCode.indexOf('defaultAgentSelectEl.onchange = ()');
  assert.ok(onchangeStart !== -1, 'default agent onchange handler exists');
  const onchangeBody = appCode.substring(onchangeStart, onchangeStart + 400);
  assert.ok(!onchangeBody.includes('updateActiveAgentsConfigDefaultAgent'), 'onchange must not persist to agents.yaml immediately');
  assert.ok(appCode.includes('window.backend.updateActiveAgentsConfigDefaultAgent(scrapDirInput, config.default_agent)'), 'agents.yaml is still written, but only from the Save handler');
});

// ---------------------------------------------------------------------------
// Quick Actions "enabled" / "manual-only" field coupling
// ---------------------------------------------------------------------------
check('Quick Actions enabled=false mutes manual-only/base-url/model/api-key, and manual-only=true mutes the delay field', () => {
  assert.ok(appCode.includes('function updateQuickActionsFieldStates()'), 'updateQuickActionsFieldStates exists');
  const fn = extractFunction(appCode, 'updateQuickActionsFieldStates');
  assert.ok(fn.includes("setFieldMuted(manualOnlyEl, !enabled)"));
  assert.ok(fn.includes("setFieldMuted(baseUrlEl, !enabled)"));
  assert.ok(fn.includes("setFieldMuted(modelEl, !enabled)"));
  assert.ok(fn.includes("setFieldMuted(apiKeyEl, !enabled)"));
  assert.ok(fn.includes("setFieldMuted(delayEl, !enabled || manualOnly)"));
  assert.ok(appCode.includes("qaEnabledToggleEl.addEventListener('change', updateQuickActionsFieldStates)"), 'enabled checkbox re-evaluates coupling on change');
  assert.ok(appCode.includes("qaManualOnlyToggleEl.addEventListener('change', updateQuickActionsFieldStates)"), 'manual-only checkbox re-evaluates coupling on change');
  // At least one call site must sit after openSettings()'s definition starts. Uses indexOf in
  // a loop rather than a single indexOf (which only finds the FIRST occurrence in the whole
  // file) because a legitimate second call site - e.g. the status-bar badge's cycle handler
  // re-syncing the dialog's field states if it happens to be open - can appear earlier in the
  // file without invalidating this check.
  const openSettingsStart = appCode.indexOf('function openSettings()');
  assert.ok(openSettingsStart !== -1, 'openSettings function exists');
  let callSiteAfterOpen = false;
  let searchFrom = 0;
  for (;;) {
    const idx = appCode.indexOf('updateQuickActionsFieldStates();', searchFrom);
    if (idx === -1) break;
    if (idx > openSettingsStart) { callSiteAfterOpen = true; break; }
    searchFrom = idx + 1;
  }
  assert.ok(callSiteAfterOpen, 'field states are (re)computed when the dialog opens');
});

check('saved values are unchanged by muting — this is presentation-only coupling', () => {
  // The save handler must still read the raw checked/value state regardless
  // of the (possibly muted/disabled) field, i.e. muting must not itself zero
  // out or skip persistence of a field's value.
  assert.ok(appCode.includes("if (saveActManualOnlyEl) config.action.manualOnly = saveActManualOnlyEl.checked;"));
  assert.ok(appCode.includes("if (saveActBaseUrlEl) config.action.baseUrl = saveActBaseUrlEl.value.trim();"));
});

// ---------------------------------------------------------------------------
// New i18n keys exist in both languages
// ---------------------------------------------------------------------------
const i18nContext = {};
vm.createContext(i18nContext);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nContext);
const I18N = i18nContext.I18N;

const newSettingsKeys = [
  'languageImeGuardianHint', 'statusChecking', 'modelSummaryTitle', 'modelSummaryRowWrite',
  'modelSummaryRowCli', 'modelSummaryRowGhost', 'modelSummaryRowVision', 'modelSummaryRowImageGen',
  'modelSummaryRowActions', 'textModelFallbackHint', 'cliModelHint', 'actionApiBlockHint',
  'actionModelHint', 'slotTimeoutLabel', 'slotTimeoutHint', 'slotGhostDiffLabel', 'slotGhostDiffHint',
  'slotHoverPeekLabel', 'slotHoverPeekHint', 'gitRemoteUrlRequired', 'shortcutReservedByApp',
  'shortcutOverwriteConfirm', 'shortcutRecordingHint', 'agentAutoApproveWarning', 'agentInstalledBadge',
  'agentNotFoundBadge', 'llmProtocolDetected', 'llmProtocolUnknown', 'providerOllama', 'providerGemini',
  'providerOpenAICompatible'
];

// task_manager.js routes its own strings through I18N directly (not t()/data-i18n),
// so tests/i18n_test.mjs's generic HTML/app.js scan can't see these — check them here.
const taskManagerKeys = [
  'taskRunningBadge', 'taskRunningTooltip', 'taskDoneBadge', 'taskCanceledBadge', 'taskFailedBadge',
  'taskSectionRunning', 'taskSectionHistory', 'taskRunningStatus', 'taskStatusDone', 'taskStatusCanceled',
  'taskStatusFailed', 'taskNoInstruction', 'taskWaitingProcess', 'taskCancelTitle', 'taskCancelLabel',
  'taskCancelingLabel', 'taskEmptyState'
];

check('every new settings-screen i18n key has both an EN and a JA translation', () => {
  for (const key of newSettingsKeys) {
    assert.ok(I18N.en[key], `missing EN: ${key}`);
    assert.ok(I18N.ja[key], `missing JA: ${key}`);
  }
});

check('every new Task Manager i18n key has both an EN and a JA translation', () => {
  for (const key of taskManagerKeys) {
    assert.ok(I18N.en[key], `missing EN: ${key}`);
    assert.ok(I18N.ja[key], `missing JA: ${key}`);
  }
});

check('Ghost Text and Quick Actions delay labels name their feature (no more ambiguous "delay")', () => {
  assert.match(I18N.en.autoDelayLabel, /Ghost text/i);
  assert.match(I18N.en.actionDelayLabel, /Quick Actions/i);
  assert.match(I18N.ja.autoDelayLabel, /ゴーストテキスト/);
  assert.match(I18N.ja.actionDelayLabel, /アクション候補/);
});

if (failures > 0) {
  console.error(`\n${failures} settings mistake-proofing test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll settings mistake-proofing tests passed with 0 error(s)!');
