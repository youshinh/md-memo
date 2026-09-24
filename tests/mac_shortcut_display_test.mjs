// Tests for two Mac-related pieces of the shortcuts engine in app.js:
//
//  1. The global summon shortcut's fallback used to be the literal 'Ctrl+Alt+M'
//     at five call sites, even on macOS, where the real default is 'Cmd+Alt+M'
//     (DEFAULT_SHORTCUTS_MAC.globalSummon, matching Go's defaultGlobalSummonShortcut
//     in app_config.go). A blank/legacy config would register the Windows chord
//     with the OS via updateGlobalShortcut, then Go would register the Mac chord
//     on the next restart — the two disagreeing. The fix: every fallback site now
//     reads DEFAULT_SHORTCUTS.globalSummon (already platform-selected) instead of
//     the hardcoded literal. This file pins that fix at the source level and
//     cross-checks the JS platform defaults against the Go source of truth.
//
//  2. formatShortcutForDisplay() (~app.js:8498), which turns a stored combo string
//     ("Ctrl+S") into what the UI shows the user ("Cmd+S" on macOS). Existing
//     behavior is pinned, not redesigned.
//
//  3. comboFromKeyEvent() (~app.js, the shortcut recorder's keydown handler),
//     extracted into a pure top-level function that turns a KeyboardEvent into
//     the combo string the recorder stores. Existing behavior is pinned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const appCode = fs.readFileSync(path.resolve('frontend/js/app.js'), 'utf-8');
const goConfigCode = fs.readFileSync(path.resolve('app_config.go'), 'utf-8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n  ${err.stack || err.message}`);
  }
}

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

// Extracts a top-level `const NAME = { ... };` object literal's source text
// (braces balanced), the same way extractFunction does for functions.
function extractConst(source, name) {
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
  return source.substring(start, i + 1);
}

function loadFn(names, context = {}) {
  const ctx = vm.createContext(Object.assign({ console }, context));
  const code = names.map((n) => extractFunction(appCode, n)).join('\n');
  vm.runInContext(`${code}\nglobalThis.__api = { ${names.join(', ')} };`, ctx);
  return ctx.__api;
}

// ---------------------------------------------------------------------------
// 1a. Source-level: no hardcoded 'Ctrl+Alt+M' fallback literal remains outside
//     the DEFAULT_SHORTCUTS_WIN table itself.
// ---------------------------------------------------------------------------
check("no 'Ctrl+Alt+M' fallback literal remains outside DEFAULT_SHORTCUTS_WIN", () => {
  const winBlock = extractConst(appCode, 'DEFAULT_SHORTCUTS_WIN');
  assert.ok(winBlock.includes("'Ctrl+Alt+M'"), 'sanity: the literal must still live inside DEFAULT_SHORTCUTS_WIN itself');

  const withoutWinBlock = appCode.replace(winBlock, '');
  assert.ok(!withoutWinBlock.includes("'Ctrl+Alt+M'"), "a 'Ctrl+Alt+M' literal was found outside DEFAULT_SHORTCUTS_WIN — the Mac fallback bug is back");

  // And every globalSummon fallback site now reads the platform-selected default.
  const summonFallbackSites = appCode.match(/globalSummon\)\s*\|\|\s*([^;,)]+)/g) || [];
  assert.ok(summonFallbackSites.length >= 5, `expected at least 5 globalSummon fallback sites, found ${summonFallbackSites.length}`);
  for (const site of summonFallbackSites) {
    assert.ok(site.includes('DEFAULT_SHORTCUTS.globalSummon'), `fallback site does not use DEFAULT_SHORTCUTS.globalSummon: ${site}`);
  }
});

// ---------------------------------------------------------------------------
// 1b. Cross-language: DEFAULT_SHORTCUTS_MAC/WIN.globalSummon (frontend) must
//     equal defaultGlobalSummonShortcut's darwin/non-darwin values (Go).
// ---------------------------------------------------------------------------
check('DEFAULT_SHORTCUTS_MAC/WIN.globalSummon match Go defaultGlobalSummonShortcut', () => {
  const code = extractConst(appCode, 'DEFAULT_SHORTCUTS_WIN') + '\n' + extractConst(appCode, 'DEFAULT_SHORTCUTS_MAC') +
    '\nglobalThis.__WIN = DEFAULT_SHORTCUTS_WIN; globalThis.__MAC = DEFAULT_SHORTCUTS_MAC;';
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx);

  const goBlockMatch = goConfigCode.match(/var defaultGlobalSummonShortcut = func\(\) string \{[\s\S]*?\n\}\(\)/);
  assert.ok(goBlockMatch, 'defaultGlobalSummonShortcut function literal not found in app_config.go');
  const goBlock = goBlockMatch[0];
  const goDarwin = goBlock.match(/GOOS == "darwin" \{\s*return "([^"]+)"/);
  const goDefault = goBlock.match(/return "([^"]+)"\s*\}\(\)/);
  assert.ok(goDarwin && goDefault, 'could not extract darwin/default return values from app_config.go');

  assert.equal(ctx.__MAC.globalSummon, goDarwin[1], 'DEFAULT_SHORTCUTS_MAC.globalSummon must match Go\'s darwin default');
  assert.equal(ctx.__WIN.globalSummon, goDefault[1], 'DEFAULT_SHORTCUTS_WIN.globalSummon must match Go\'s non-darwin default');
});

// ---------------------------------------------------------------------------
// 2. formatShortcutForDisplay — pinning existing behavior (isMac true/false)
// ---------------------------------------------------------------------------
function loadFormatShortcut(isMacValue) {
  const code = extractFunction(appCode, 'formatShortcutForDisplay');
  const ctx = vm.createContext({ isMac: isMacValue });
  vm.runInContext(`${code}\nglobalThis.__fmt = formatShortcutForDisplay;`, ctx);
  return ctx.__fmt;
}

check('formatShortcutForDisplay on macOS: Ctrl-only legacy combo becomes Cmd', () => {
  const fmt = loadFormatShortcut(true);
  assert.equal(fmt('Ctrl+S'), 'Cmd+S');
});

check('formatShortcutForDisplay on macOS: Alt becomes Option', () => {
  const fmt = loadFormatShortcut(true);
  assert.equal(fmt('Alt+C'), 'Option+C');
});

check('formatShortcutForDisplay on macOS: a combo that already has Cmd is left alone (Ctrl+Cmd+F stays sane)', () => {
  const fmt = loadFormatShortcut(true);
  assert.equal(fmt('Ctrl+Cmd+F'), 'Ctrl+Cmd+F');
});

check('formatShortcutForDisplay on macOS: arrow keys and empty input', () => {
  const fmt = loadFormatShortcut(true);
  assert.equal(fmt('Cmd+ArrowUp'), 'Cmd+↑');
  assert.equal(fmt(''), '');
});

check('formatShortcutForDisplay on Windows: Cmd/Option normalize to Ctrl/Alt', () => {
  const fmt = loadFormatShortcut(false);
  assert.equal(fmt('Cmd+Option+V'), 'Ctrl+Alt+V');
});

check('formatShortcutForDisplay on Windows: a plain Windows combo is unchanged', () => {
  const fmt = loadFormatShortcut(false);
  assert.equal(fmt('Ctrl+Shift+F'), 'Ctrl+Shift+F');
});

// ---------------------------------------------------------------------------
// 3. comboFromKeyEvent — pinning existing behavior (extracted from the
//    shortcut recorder's keydown handler)
// ---------------------------------------------------------------------------
function loadCombo(isMacValue) {
  const api = loadFn(['physicalCharFromCode', 'comboFromKeyEvent'], { isMac: isMacValue });
  return api.comboFromKeyEvent;
}

check('comboFromKeyEvent: Option+T on macOS uses the physical code, not the composed key (mojibake guard)', () => {
  const combo = loadCombo(true);
  // On macOS, Option+T reports key '†' (dagger) but code 'KeyT'.
  const result = combo({ altKey: true, key: '†', code: 'KeyT', ctrlKey: false, metaKey: false, shiftKey: false });
  assert.equal(result, 'Option+T');
});

check('comboFromKeyEvent: Ctrl+Cmd+Z on macOS (Zen Mode default)', () => {
  const combo = loadCombo(true);
  const result = combo({ ctrlKey: true, metaKey: true, altKey: false, shiftKey: false, key: 'z', code: 'KeyZ' });
  assert.equal(result, 'Ctrl+Cmd+Z');
});

check('comboFromKeyEvent: Option+Shift+Digit1 on macOS uses the physical digit', () => {
  const combo = loadCombo(true);
  // Option+1 composes key '¡' ('¡') on macOS; code stays 'Digit1'.
  const result = combo({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: '¡', code: 'Digit1' });
  assert.equal(result, 'Option+Shift+1');
});

check('comboFromKeyEvent: Space key', () => {
  const combo = loadCombo(false);
  const result = combo({ key: ' ', code: 'Space', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
  assert.equal(result, 'Space');
});

check('comboFromKeyEvent: a bare modifier press is not filtered by the pure function itself (the caller filters it)', () => {
  const combo = loadCombo(false);
  const result = combo({ key: 'Control', ctrlKey: true, code: 'ControlLeft', metaKey: false, altKey: false, shiftKey: false });
  assert.equal(result, 'Ctrl+Control');
});

check('comboFromKeyEvent: same event always produces the same output (pure)', () => {
  const combo = loadCombo(true);
  const e = { ctrlKey: true, metaKey: false, altKey: true, shiftKey: true, key: 'x', code: 'KeyX' };
  const first = combo(e);
  const second = combo(Object.assign({}, e));
  assert.equal(first, second);
});

if (failures > 0) {
  console.error(`\n${failures} mac shortcut display test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll mac shortcut display tests passed with 0 error(s)!');
