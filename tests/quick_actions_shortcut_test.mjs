import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing Quick Actions (Ctrl+J / Cmd+J) Shortcut Wiring ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');
const jevActionJs = fs.readFileSync('frontend/js/jev_action.js', 'utf8');

// --- helpers ---------------------------------------------------------------

function extractShortcutBlock(source, varName) {
  const startIdx = source.indexOf(`const ${varName} = {`);
  assert(startIdx !== -1, `${varName} block must exist in app.js`);
  const endIdx = source.indexOf('};', startIdx);
  assert(endIdx !== -1, `${varName} block must be closed with '};' in app.js`);
  return source.substring(startIdx, endIdx);
}

function parseShortcutEntries(block) {
  const entries = {};
  const re = /(\w+):\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    entries[m[1]] = m[2];
  }
  return entries;
}

// 1. Defaults contain quickActions bound to Ctrl+J (Windows) / Cmd+J (macOS)
const winBlock = extractShortcutBlock(appJs, 'DEFAULT_SHORTCUTS_WIN');
const macBlock = extractShortcutBlock(appJs, 'DEFAULT_SHORTCUTS_MAC');
const winEntries = parseShortcutEntries(winBlock);
const macEntries = parseShortcutEntries(macBlock);

assert.strictEqual(winEntries.quickActions, 'Ctrl+J', 'DEFAULT_SHORTCUTS_WIN.quickActions must be Ctrl+J');
assert.strictEqual(macEntries.quickActions, 'Cmd+J', 'DEFAULT_SHORTCUTS_MAC.quickActions must be Cmd+J');
console.log('PASS: quickActions defaults registered (Ctrl+J / Cmd+J).');

// 2. No other default shortcut already occupies Ctrl+J / Cmd+J (no silent collision)
for (const [key, value] of Object.entries(winEntries)) {
  if (key === 'quickActions') continue;
  assert.notStrictEqual(value, 'Ctrl+J', `Windows default shortcut "${key}" must not already be bound to Ctrl+J (would collide with quickActions)`);
}
for (const [key, value] of Object.entries(macEntries)) {
  if (key === 'quickActions') continue;
  assert.notStrictEqual(value, 'Cmd+J', `Mac default shortcut "${key}" must not already be bound to Cmd+J (would collide with quickActions)`);
}
console.log('PASS: No other default shortcut collides with Ctrl+J / Cmd+J.');

// 3. The keydown chain routes the quickActions shortcut to JevAction.triggerJevPrediction()
const keydownBranchMatch = appJs.match(/else if \(matchShortcut\(e, config\.shortcuts && config\.shortcuts\.quickActions\)\) \{[\s\S]*?\n {4}\}/);
assert(keydownBranchMatch, 'keydown chain must have a branch for config.shortcuts.quickActions');
assert(
  keydownBranchMatch[0].includes('window.JevAction.triggerJevPrediction()'),
  'the config.shortcuts.quickActions branch must call window.JevAction.triggerJevPrediction()'
);
console.log('PASS: keydown chain calls window.JevAction.triggerJevPrediction() for the quickActions shortcut.');

// 4. SHORTCUT_GROUPS (customizable shortcut registry UI) lists quickActions
assert(
  /\{\s*key:\s*'quickActions',\s*labelKey:\s*'shortcutActionQuickActions'\s*\}/.test(appJs),
  'SHORTCUT_GROUPS must list { key: "quickActions", labelKey: "shortcutActionQuickActions" }'
);
console.log('PASS: SHORTCUT_GROUPS includes the quickActions entry.');

// 5. i18n has shortcutActionQuickActions in both English and Japanese
const context = {};
vm.createContext(context);
vm.runInContext(i18nJs + '; this.I18N = I18N;', context);
const I18N = context.I18N;

assert(I18N.en && typeof I18N.en.shortcutActionQuickActions === 'string' && I18N.en.shortcutActionQuickActions.length > 0, 'EN shortcutActionQuickActions must exist');
assert(I18N.ja && typeof I18N.ja.shortcutActionQuickActions === 'string' && I18N.ja.shortcutActionQuickActions.length > 0, 'JA shortcutActionQuickActions must exist');
console.log(`PASS: i18n keys present -> EN: "${I18N.en.shortcutActionQuickActions}", JA: "${I18N.ja.shortcutActionQuickActions}"`);

// 6. jev_action.js no longer hardcodes its own Alt+A / Ctrl+Shift+A manual trigger.
// The manual trigger is now exclusively owned by the app.js shortcut registry above,
// so users can rebind it via Settings > Shortcuts.
assert(
  !/e\.altKey\s*&&\s*\(e\.key === 'a' \|\| e\.key === 'A'\)/.test(jevActionJs),
  'jev_action.js must not hardcode an Alt+A manual trigger check anymore'
);
assert(
  !jevActionJs.includes("e.ctrlKey && e.shiftKey && (e.key === 'a' || e.key === 'A')"),
  'jev_action.js must not hardcode a Ctrl+Shift+A manual trigger check anymore'
);
console.log('PASS: jev_action.js no longer contains the hardcoded Alt+A / Ctrl+Shift+A manual trigger.');

console.log('\nAll Quick Actions shortcut wiring tests PASSED!');
