import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing status-bar Quick Actions cycle (On -> Manual -> Off -> On) ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

const updateSrc = appJs.match(/function updateActionStatus\(\) \{[\s\S]*?\n  \}/);
const cycleSrc = appJs.match(/function cycleActionStatus\(\) \{[\s\S]*?\n  \}/);
assert.ok(updateSrc, 'updateActionStatus must exist');
assert.ok(cycleSrc, 'cycleActionStatus must exist');

// i18n: both languages have all three states' strings, and the manual ones take a {key} param
// (naming the actual configured shortcut) rather than a hardcoded "Ctrl+J"/"Manual" label.
const i18nCtx = {};
vm.runInNewContext(i18nJs + '\nthis.I18N = I18N;', i18nCtx);
for (const lang of ['en', 'ja']) {
  for (const key of ['statActionOn', 'statActionOff', 'statActionManual', 'statActionTooltip', 'statActionOffTooltip', 'statActionManualTooltip']) {
    assert.ok(i18nCtx.I18N[lang][key], `i18n key ${key} missing in ${lang}`);
  }
  assert.ok(i18nCtx.I18N[lang].statActionManual.includes('{key}'), `statActionManual (${lang}) must use the {key} placeholder, not a hardcoded label`);
}

function makeEnv(actionConfig) {
  const checkboxes = {
    'cfg-action-enabled': { checked: false },
    'cfg-action-manual-only': { checked: false },
  };
  const env = {
    config: { action: actionConfig },
    statAction: { textContent: '', title: '', style: {} },
    isMac: false,
    persisted: 0,
    fieldStatesRecomputed: 0,
    jevConfigCalls: [],
    t: (key, params) => (params && params.key ? `${key}(${params.key})` : key),
    getShortcutDisplay: (name, fallback) => (name === 'quickActions' ? 'Ctrl+J' : fallback),
    savePersistentConfig: () => { env.persisted++; },
    updateQuickActionsFieldStates: () => { env.fieldStatesRecomputed++; },
    document: { getElementById: (id) => checkboxes[id] || null },
    window: { JevAction: { updateConfig: (c) => jevConfigCalls.push(c) } },
    global: {},
  };
  env.global = env;
  const jevConfigCalls = env.jevConfigCalls;
  vm.createContext(env);
  vm.runInContext(`${updateSrc[0]}\n${cycleSrc[0]}`, env);
  return { env, checkboxes };
}

// Starting from the default (on, not manual): cycles On -> Manual -> Off -> On.
let { env, checkboxes } = makeEnv({ enabled: true, manualOnly: false, delaySec: 1.5 });

vm.runInContext('cycleActionStatus()', env);
assert.strictEqual(env.config.action.enabled, true);
assert.strictEqual(env.config.action.manualOnly, true, 'On -> Manual');
assert.strictEqual(env.statAction.textContent, 'statActionManual(Ctrl+J)', 'manual label must name the real configured key');
assert.strictEqual(checkboxes['cfg-action-enabled'].checked, true);
assert.strictEqual(checkboxes['cfg-action-manual-only'].checked, true);
assert.strictEqual(env.fieldStatesRecomputed, 1, 'settings modal field-muting must be re-synced');
assert.strictEqual(env.persisted, 1);

vm.runInContext('cycleActionStatus()', env);
assert.strictEqual(env.config.action.enabled, false, 'Manual -> Off');
assert.strictEqual(env.config.action.manualOnly, false);
assert.strictEqual(env.statAction.textContent, 'statActionOff');
assert.strictEqual(checkboxes['cfg-action-enabled'].checked, false);
assert.strictEqual(checkboxes['cfg-action-manual-only'].checked, false);

vm.runInContext('cycleActionStatus()', env);
assert.strictEqual(env.config.action.enabled, true, 'Off -> On');
assert.strictEqual(env.config.action.manualOnly, false);
assert.strictEqual(env.statAction.textContent, 'statActionOn');

assert.strictEqual(env.persisted, 3, 'every cycle step must persist');

// A missing config.action must not throw, and must land on a sane state (matches
// updateActionStatus's own default: enabled, not manual).
({ env, checkboxes } = makeEnv(undefined));
vm.runInContext('cycleActionStatus()', env);
assert.strictEqual(env.config.action.enabled, true);
assert.strictEqual(env.config.action.manualOnly, true, 'default action config starts non-manual, so the first cycle step is On -> Manual');

console.log('PASS: Quick Actions status-bar badge cycles On -> Manual -> Off -> On, syncing checkboxes and field-muting');
