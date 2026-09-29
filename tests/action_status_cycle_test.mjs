import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing Suggestions (Quick Actions): the modes behind the switches of the AI item ===');
const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

// The status bar used to cycle one badge On -> Manual -> Off. The AI item now has two switches (Suggestions, and "only when I
// press the key" under it); the three states are the same enabled / manualOnly pair, set by setActionMode(mode).
const names = ['ensureActionConfig', 'updateActionStatus', 'actionMode', 'setActionMode', 'suggestionsKeyLabel', 'toggleSuggestions', 'toggleSuggestionsManual'];
const sources = names.map((name) => {
  const m = appJs.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(m, name + ' must exist');
  return m[0];
});
assert.ok(!/function cycleActionStatus/.test(appJs), 'the one-badge cycle is gone: the popover has real switches');

// i18n: the words of the switches and of the toasts exist in both languages; the manual ones name the real configured key
// ({key}), not a hard-coded "Ctrl+J".
const i18nCtx = {};
vm.runInNewContext(i18nJs + '\nthis.I18N = I18N;', i18nCtx);
for (const lang of ['en', 'ja']) {
  for (const key of ['aiOptSuggestions', 'aiOptSuggestionsHint', 'aiOptSuggestionsManual', 'toastSuggestionsOn', 'toastSuggestionsManual', 'toastSuggestionsOff']) {
    assert.ok(i18nCtx.I18N[lang][key], `i18n key ${key} missing in ${lang}`);
  }
  for (const key of ['aiOptSuggestionsManual', 'toastSuggestionsManual']) {
    assert.ok(i18nCtx.I18N[lang][key].includes('{key}'), `${key} (${lang}) must use the {key} placeholder, not a hardcoded label`);
  }
}

// Objects made inside the vm have another Object.prototype: compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

function makeEnv(actionConfig) {
  const checkboxes = {
    'cfg-action-enabled': { checked: false },
    'cfg-action-manual-only': { checked: false },
  };
  const env = {
    config: { action: actionConfig },
    isMac: false,
    persisted: 0,
    refreshed: 0,
    fieldStatesRecomputed: 0,
    jevConfigCalls: [],
    messages: [],
    t: (key, params) => (params && params.key ? `${key}(${params.key})` : key),
    getShortcutDisplay: (name, fallback) => (name === 'quickActions' ? 'Ctrl+J' : fallback),
    savePersistentConfig: () => { env.persisted++; },
    refreshStatusAI: () => { env.refreshed++; },
    showMessage: (msg) => { env.messages.push(msg); },
    updateQuickActionsFieldStates: () => { env.fieldStatesRecomputed++; },
    document: { getElementById: (id) => checkboxes[id] || null },
    window: { JevAction: { updateConfig: (c) => jevConfigCalls.push(c) } },
    global: {},
  };
  env.global = env;
  const jevConfigCalls = env.jevConfigCalls;
  vm.createContext(env);
  vm.runInContext(sources.join('\n'), env);
  return { env, checkboxes };
}

// Starting from the default (on, not manual): the Suggestions switch is on, the sub-switch is off.
let { env, checkboxes } = makeEnv({ enabled: true, manualOnly: false, delaySec: 1.5 });
assert.strictEqual(vm.runInContext('actionMode()', env), 'auto');

// Sub-switch on: On -> Manual. The checkboxes of Settings follow, the field muting is re-synced, the engine is told, it is saved.
vm.runInContext('toggleSuggestionsManual()', env);
assert.strictEqual(env.config.action.enabled, true);
assert.strictEqual(env.config.action.manualOnly, true, 'auto -> manual');
assert.strictEqual(checkboxes['cfg-action-enabled'].checked, true);
assert.strictEqual(checkboxes['cfg-action-manual-only'].checked, true);
assert.strictEqual(env.fieldStatesRecomputed, 1, 'settings modal field-muting must be re-synced');
assert.strictEqual(env.persisted, 1);
assert.deepStrictEqual(plain(env.jevConfigCalls.pop()), { enabled: true, manualOnly: true, delaySec: 1.5 }, 'the suggestion engine is told the new mode');
assert.ok(env.refreshed >= 1, 'the AI item is redrawn');
assert.deepStrictEqual(plain(env.messages), ['toastSuggestionsManual(Ctrl+J)'], 'the toast names the real configured key');

// Sub-switch off again: manual -> auto.
vm.runInContext('toggleSuggestionsManual()', env);
assert.strictEqual(env.config.action.manualOnly, false, 'manual -> auto');
assert.strictEqual(env.config.action.enabled, true);
assert.strictEqual(env.messages[env.messages.length - 1], 'toastSuggestionsOn(Ctrl+J)');

// Suggestions switch off: everything off, both checkboxes cleared (also from manual).
vm.runInContext('toggleSuggestionsManual()', env);
vm.runInContext('toggleSuggestions()', env);
assert.strictEqual(env.config.action.enabled, false, 'manual -> off');
assert.strictEqual(env.config.action.manualOnly, false);
assert.strictEqual(vm.runInContext('actionMode()', env), 'off');
assert.strictEqual(checkboxes['cfg-action-enabled'].checked, false);
assert.strictEqual(checkboxes['cfg-action-manual-only'].checked, false);
assert.strictEqual(env.messages[env.messages.length - 1], 'toastSuggestionsOff(Ctrl+J)');
assert.deepStrictEqual(plain(env.jevConfigCalls.pop()), { enabled: false, manualOnly: false, delaySec: 1.5 });

// And back on: off -> auto (not manual).
vm.runInContext('toggleSuggestions()', env);
assert.strictEqual(env.config.action.enabled, true, 'off -> on');
assert.strictEqual(env.config.action.manualOnly, false);
assert.strictEqual(env.messages[env.messages.length - 1], 'toastSuggestionsOn(Ctrl+J)');

assert.strictEqual(env.persisted, 5, 'every step is saved');

// A missing config.action must not throw, and must land on a sane state (matches the defaults: enabled, not manual).
({ env, checkboxes } = makeEnv(undefined));
assert.strictEqual(vm.runInContext('actionMode()', env), 'auto', 'no action config = the default, on');
vm.runInContext('toggleSuggestions()', env);
assert.strictEqual(env.config.action.enabled, false);
assert.strictEqual(env.config.action.manualOnly, false);

// updateActionStatus alone (a settings save, a config load) hands the mode to the engine and redraws the item.
({ env } = makeEnv({ enabled: true, manualOnly: true, delaySec: 3 }));
vm.runInContext('updateActionStatus()', env);
assert.deepStrictEqual(plain(env.jevConfigCalls.pop()), { enabled: true, manualOnly: true, delaySec: 3 });
assert.strictEqual(env.refreshed, 1);

console.log('PASS: Suggestions modes (auto / manual / off) behind two switches, syncing the Settings check boxes, the engine and the toast');
