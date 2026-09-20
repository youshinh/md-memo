import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing status-bar Autosave toggle ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

// 1. Markup: the badge is clickable like its neighbours
const badge = indexHtml.match(/<span id="stat-autosave"[^>]*>/);
assert.ok(badge, 'stat-autosave badge must exist');
assert.ok(badge[0].includes('clickable-badge'), 'stat-autosave must have the clickable-badge class');

// 2. Wiring: click handler bound
assert.ok(/statAutosave\.onclick\s*=\s*\(\)\s*=>\s*toggleAutoSave\(\)/.test(appJs), 'statAutosave.onclick must call toggleAutoSave()');

// 3. i18n: tooltips exist in both languages
const ctx = {};
vm.runInNewContext(i18nJs + '\nthis.I18N = I18N;', ctx);
for (const lang of ['en', 'ja']) {
  for (const key of ['statAutosaveOn', 'statAutosaveOff', 'statAutosaveTooltip', 'statAutosaveOffTooltip']) {
    assert.ok(ctx.I18N[lang][key], `i18n key ${key} missing in ${lang}`);
  }
}

// 4. Behavior: extract the functions and run them against mocks
const renderSrc = appJs.match(/function renderAutosaveStatus\(\) \{[\s\S]*?\n  \}/);
const toggleSrc = appJs.match(/function toggleAutoSave\(\) \{[\s\S]*?\n  \}/);
const scheduleSrc = appJs.match(/function scheduleAutoSave\(tab, currentTimer\) \{[\s\S]*?\n  \}/);
assert.ok(renderSrc && toggleSrc, 'renderAutosaveStatus / toggleAutoSave must exist');
assert.ok(scheduleSrc, 'scheduleAutoSave(tab, currentTimer) helper must exist (one timer per pane, tab captured at schedule time)');

// toggleAutoSave must own two independent timers, not a single shared one
assert.ok(/autoSaveTimerPrimary/.test(toggleSrc[0]) && /autoSaveTimerSecondary/.test(toggleSrc[0]),
  'toggleAutoSave must clear/manage both a primary and a secondary autosave timer');

function makeEnv(opts) {
  const {
    initialOn,
    tabs = [],
    activeTabId = null,
    secondaryTabId = null,
    isSplitMode = false,
    secondaryViewMode = 'editor',
  } = opts;

  let nextTimerId = 1;
  const pending = new Map(); // id -> fn
  const clearedIds = [];
  const savedTabs = [];

  const env = {
    config: { general: { autoSave: initialOn } },
    statAutosave: { textContent: '', title: '', style: {} },
    t: (k) => k,
    autoSaveTimerPrimary: null,
    autoSaveTimerSecondary: null,
    tabs,
    activeTabId,
    secondaryTabId,
    isSplitMode,
    secondaryViewMode,
    persisted: 0,
    checkbox: { checked: initialOn },
    clearedIds,
    savedTabs,
    pending,
  };
  env.getTab = (id) => env.tabs.find((tb) => tb.id === id);
  env.saveTab = (tab) => { savedTabs.push(tab); return Promise.resolve(true); };
  env.clearTimeout = (id) => { if (id != null) clearedIds.push(id); pending.delete(id); };
  env.setTimeout = (fn) => { const id = nextTimerId++; pending.set(id, fn); return id; };
  env.fire = (id) => { const fn = pending.get(id); assert.ok(fn, `timer ${id} must still be pending`); pending.delete(id); fn(); };
  env.savePersistentConfig = () => { env.persisted++; };
  env.document = { getElementById: (id) => (id === 'cfg-autosave' ? env.checkbox : null) };
  vm.createContext(env);
  vm.runInContext(`${renderSrc[0]}\n${scheduleSrc[0]}\n${toggleSrc[0]}`, env);
  return env;
}

// ON -> OFF: label, opacity, both pending timers cleared, persisted, settings checkbox synced
let env = makeEnv({
  initialOn: true,
  tabs: [{ id: 't1', path: 'a.md', isDirty: true }],
  activeTabId: 't1',
});
env.autoSaveTimerPrimary = env.setTimeout(() => {});
env.autoSaveTimerSecondary = env.setTimeout(() => {});
const primaryHandleBeforeOff = env.autoSaveTimerPrimary;
const secondaryHandleBeforeOff = env.autoSaveTimerSecondary;
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.config.general.autoSave, false);
assert.strictEqual(env.statAutosave.textContent, 'statAutosaveOff');
assert.strictEqual(env.statAutosave.title, 'statAutosaveOffTooltip');
assert.strictEqual(env.statAutosave.style.opacity, '0.6');
assert.ok(env.clearedIds.includes(primaryHandleBeforeOff), 'pending primary autosave must be cancelled when turning off');
assert.ok(env.clearedIds.includes(secondaryHandleBeforeOff), 'pending secondary autosave must be cancelled when turning off');
assert.strictEqual(env.pending.size, 0, 'no save may be scheduled when turning off');
assert.strictEqual(env.persisted, 1);
assert.strictEqual(env.checkbox.checked, false);

// OFF -> ON, single pane, with a dirty saved file: schedules one primary save after 1.5s
env = makeEnv({
  initialOn: false,
  tabs: [{ id: 't1', path: 'a.md', isDirty: true }],
  activeTabId: 't1',
});
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.config.general.autoSave, true);
assert.strictEqual(env.statAutosave.textContent, 'statAutosaveOn');
assert.strictEqual(env.statAutosave.style.opacity, '1');
assert.strictEqual(env.pending.size, 1);
assert.notStrictEqual(env.autoSaveTimerPrimary, null);
assert.strictEqual(env.autoSaveTimerSecondary, null);
env.fire(env.autoSaveTimerPrimary);
assert.strictEqual(env.savedTabs.length, 1);
assert.strictEqual(env.savedTabs[0].id, 't1');
assert.strictEqual(env.checkbox.checked, true);

// OFF -> ON with an unsaved scratch tab (no path) or a clean tab: nothing scheduled
env = makeEnv({ initialOn: false, tabs: [{ id: 't1', path: '', isDirty: true }], activeTabId: 't1' });
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.pending.size, 0);
env = makeEnv({ initialOn: false, tabs: [{ id: 't1', path: 'a.md', isDirty: false }], activeTabId: 't1' });
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.pending.size, 0);

// OFF -> ON in split view with a DIFFERENT dirty file-backed tab in each pane:
// both panes must get their own pending save, each for its own tab.
env = makeEnv({
  initialOn: false,
  tabs: [
    { id: 'p1', path: 'primary.md', isDirty: true },
    { id: 's1', path: 'secondary.md', isDirty: true },
  ],
  activeTabId: 'p1',
  secondaryTabId: 's1',
  isSplitMode: true,
  secondaryViewMode: 'editor',
});
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.pending.size, 2, 'both panes must schedule an independent save');
env.fire(env.autoSaveTimerPrimary);
env.fire(env.autoSaveTimerSecondary);
assert.deepStrictEqual(env.savedTabs.map((tb) => tb.id).sort(), ['p1', 's1']);

// Cross-pane independence: scheduling a save in one pane must never cancel or
// touch the other pane's pending timer (the historical bug: one shared
// autoSaveTimer meant typing in either pane cancelled the other's save).
env = makeEnv({
  initialOn: true,
  tabs: [
    { id: 'p1', path: 'primary.md', isDirty: true },
    { id: 's1', path: 'secondary.md', isDirty: true },
  ],
});
// Drive the real extracted scheduleAutoSave through the vm context directly.
env.tabA = env.tabs[0];
env.tabB = env.tabs[1];
vm.runInContext('autoSaveTimerPrimary = scheduleAutoSave(tabA, autoSaveTimerPrimary)', env);
const primaryHandleAfterFirstType = env.autoSaveTimerPrimary;
assert.notStrictEqual(primaryHandleAfterFirstType, null);

// User now types in the OTHER pane: this must schedule (and later clear/replace)
// only the secondary timer, leaving the primary timer completely untouched.
vm.runInContext('autoSaveTimerSecondary = scheduleAutoSave(tabB, autoSaveTimerSecondary)', env);
assert.ok(!env.clearedIds.includes(primaryHandleAfterFirstType), 'typing in the secondary pane must not cancel the primary pane\'s pending save');
assert.ok(env.pending.has(primaryHandleAfterFirstType), 'primary pane save must still be pending after secondary pane edits');

// Firing the still-pending primary timer must save the primary tab (tabA),
// proving the earlier "type in A, then type in B" sequence did not lose A's save.
env.fire(primaryHandleAfterFirstType);
assert.strictEqual(env.savedTabs.length, 1);
assert.strictEqual(env.savedTabs[0].id, 'p1');

// A second edit in the primary pane correctly replaces its OWN prior timer only.
vm.runInContext('autoSaveTimerPrimary = scheduleAutoSave(tabA, autoSaveTimerPrimary)', env);
const secondaryHandle = env.autoSaveTimerSecondary;
env.fire(env.autoSaveTimerPrimary);
assert.strictEqual(env.savedTabs.length, 2);
assert.ok(env.pending.has(secondaryHandle), 'secondary pane save must be unaffected by a second primary-pane edit');

// A no-op check: scheduleAutoSave re-validates at fire time (tab closed / no
// longer dirty / path cleared in between) and must NOT save in that case.
env = makeEnv({ initialOn: true, tabs: [{ id: 't1', path: 'a.md', isDirty: true }] });
env.tabA = env.tabs[0];
vm.runInContext('autoSaveTimerPrimary = scheduleAutoSave(tabA, autoSaveTimerPrimary)', env);
env.tabA.isDirty = false; // e.g. a manual Ctrl+S happened before the timer fired
env.fire(env.autoSaveTimerPrimary);
assert.strictEqual(env.savedTabs.length, 0, 'a stale timer must not re-save a tab that is no longer dirty');

console.log('PASS: autosave status-bar toggle');
console.log('PASS: cross-pane autosave timers are independent (typing in one pane cannot cancel the other\'s pending save)');
