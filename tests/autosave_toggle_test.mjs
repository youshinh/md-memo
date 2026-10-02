import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

console.log('=== Testing status-bar Autosave toggle ===');

const appJs = fs.readFileSync('frontend/js/app.js', 'utf8');
const indexHtml = fs.readFileSync('frontend/index.html', 'utf8');
const i18nJs = fs.readFileSync('frontend/js/i18n.js', 'utf8');

// 1. Markup: a real button (Tab, Enter / Space, aria-pressed), styled like its neighbours
const badge = indexHtml.match(/<button [^>]*id="stat-autosave"[^>]*>/);
assert.ok(badge, 'stat-autosave must be a <button>');
assert.ok(badge[0].includes('clickable-badge'), 'stat-autosave must have the clickable-badge class');
assert.ok(/type="button"/.test(badge[0]) && /aria-pressed="true"/.test(badge[0]), 'a button that says whether it is pressed');

// 2. Wiring: click handler bound
assert.ok(/statAutosave\.onclick\s*=\s*\(\)\s*=>\s*toggleAutoSave\(\)/.test(appJs), 'statAutosave.onclick must call toggleAutoSave()');

// 3. i18n: tooltips exist in both languages
const ctx = {};
vm.runInNewContext(i18nJs + '\nthis.I18N = I18N;', ctx);
for (const lang of ['en', 'ja']) {
  for (const key of ['statAutosaveOn', 'statAutosaveOff', 'statAutosaveTooltip', 'statAutosaveOffTooltip', 'toastAutosaveOn', 'toastAutosaveOff']) {
    assert.ok(ctx.I18N[lang][key], `i18n key ${key} missing in ${lang}`);
  }
}

// 4. Behavior: extract the functions and run them against mocks
const renderSrc = appJs.match(/function renderAutosaveStatus\(\) \{[\s\S]*?\n  \}/);
const toggleSrc = appJs.match(/function toggleAutoSave\(\) \{[\s\S]*?\n  \}/);
const scheduleSrc = appJs.match(/function scheduleAutoSave\(tab, currentTimer\) \{[\s\S]*?\n  \}/);
const armSrc = appJs.match(/function armAutoSave\(tab\) \{[\s\S]*?\n  \}/);
assert.ok(renderSrc && toggleSrc, 'renderAutosaveStatus / toggleAutoSave must exist');
assert.ok(scheduleSrc, 'scheduleAutoSave(tab, currentTimer) helper must exist (tab captured at schedule time)');
assert.ok(armSrc, 'armAutoSave(tab) must exist (one timer per tab)');

// The timers belong to TABS (C2-08): a keystroke in another tab, or the other pane, used to cancel a pending save of this one
// because the timer belonged to the pane. toggleAutoSave must clear the per-tab timers and re-arm every dirty tab, not only the
// ones on screen.
assert.ok(!/autoSaveTimerPrimary|autoSaveTimerSecondary/.test(appJs), 'no per-pane autosave timer is left');
assert.ok(/rpcAutoSaveTimers\.forEach/.test(toggleSrc[0]) && /tabs\.forEach/.test(toggleSrc[0]),
  'toggleAutoSave must clear every tab timer and then go through every tab');

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
    statAutosave: { textContent: '', title: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    messages: [],
    showMessage: (msg) => { env.messages.push(msg); },
    t: (k) => k,
    rpcAutoSaveTimers: null, // the autosave timers, one per tab (tab id -> handle); null until the first edit of a note with a file
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
  vm.runInContext(`${renderSrc[0]}\n${scheduleSrc[0]}\n${armSrc[0]}\n${toggleSrc[0]}`, env);
  return env;
}

// The pending timer handle of a tab (the Map is the page's own `rpcAutoSaveTimers`).
const timerOf = (env, id) => env.rpcAutoSaveTimers && env.rpcAutoSaveTimers.get(id);

// ON -> OFF: label, opacity, every pending per-tab timer cleared, persisted, settings checkbox synced
let env = makeEnv({
  initialOn: true,
  tabs: [{ id: 't1', path: 'a.md', isDirty: true }, { id: 't2', path: 'b.md', isDirty: true }],
  activeTabId: 't1',
});
env.tabA = env.tabs[0];
env.tabB = env.tabs[1];
vm.runInContext('armAutoSave(tabA); armAutoSave(tabB);', env);
const handleBeforeOffA = timerOf(env, 't1');
const handleBeforeOffB = timerOf(env, 't2');
assert.ok(handleBeforeOffA && handleBeforeOffB && handleBeforeOffA !== handleBeforeOffB, 'each tab has its own timer');
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.config.general.autoSave, false);
assert.strictEqual(env.statAutosave.textContent, 'statAutosaveOff');
assert.strictEqual(env.statAutosave.title, 'statAutosaveOffTooltip');
assert.strictEqual(env.statAutosave.style.opacity, '0.6');
assert.strictEqual(env.statAutosave.attrs['aria-pressed'], 'false', 'the button says it is no longer pressed');
assert.deepStrictEqual(env.messages, ['toastAutosaveOff'], 'a toggle says what it did');
assert.ok(env.clearedIds.includes(handleBeforeOffA), 'the pending autosave of the first tab must be cancelled when turning off');
assert.ok(env.clearedIds.includes(handleBeforeOffB), 'the pending autosave of the second tab must be cancelled when turning off');
assert.strictEqual(env.pending.size, 0, 'no save may be scheduled when turning off');
assert.strictEqual(env.persisted, 1);
assert.strictEqual(env.checkbox.checked, false);

// OFF -> ON, single pane, with a dirty saved file: schedules one save after 1.5s
env = makeEnv({
  initialOn: false,
  tabs: [{ id: 't1', path: 'a.md', isDirty: true }],
  activeTabId: 't1',
});
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.config.general.autoSave, true);
assert.strictEqual(env.statAutosave.textContent, 'statAutosaveOn');
assert.strictEqual(env.statAutosave.style.opacity, '1');
assert.strictEqual(env.statAutosave.attrs['aria-pressed'], 'true');
assert.deepStrictEqual(env.messages, ['toastAutosaveOn']);
assert.strictEqual(env.pending.size, 1);
assert.ok(timerOf(env, 't1'), 'the dirty note has its timer');
env.fire(timerOf(env, 't1'));
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
// both must get their own pending save, each for its own tab.
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
assert.strictEqual(env.pending.size, 2, 'both tabs must schedule an independent save');
env.fire(timerOf(env, 'p1'));
env.fire(timerOf(env, 's1'));
assert.deepStrictEqual(env.savedTabs.map((tb) => tb.id).sort(), ['p1', 's1']);

// OFF -> ON picks up EVERY dirty note that has a file, not only the ones on screen (C2-08): three notes edited while autosave was
// off, one of them shown, one in the other pane's place, one in neither; a clean one and one without a file stay untouched.
env = makeEnv({
  initialOn: false,
  tabs: [
    { id: 'a', path: 'a.md', isDirty: true },
    { id: 'b', path: 'b.md', isDirty: true },
    { id: 'c', path: 'c.md', isDirty: true },
    { id: 'clean', path: 'clean.md', isDirty: false },
    { id: 'scratch', path: '', isDirty: true },
  ],
  activeTabId: 'c',
});
vm.runInContext('toggleAutoSave()', env);
assert.strictEqual(env.pending.size, 3, 'a, b and c: every dirty note with a file, whichever tab is shown');
for (const id of ['a', 'b', 'c']) env.fire(timerOf(env, id));
assert.deepStrictEqual(env.savedTabs.map((tb) => tb.id).sort(), ['a', 'b', 'c']);

// Per-tab independence: arming the save of one tab must never cancel or touch the pending timer of another (the historical
// bug, C2-08: the timer belonged to the pane, so typing in b.md within 1.5 s of typing in a.md cancelled a.md's save for good).
env = makeEnv({
  initialOn: true,
  tabs: [
    { id: 'p1', path: 'primary.md', isDirty: true },
    { id: 's1', path: 'secondary.md', isDirty: true },
  ],
});
// Drive the real extracted armAutoSave through the vm context directly.
env.tabA = env.tabs[0];
env.tabB = env.tabs[1];
vm.runInContext('armAutoSave(tabA)', env);
const handleOfAAfterFirstType = timerOf(env, 'p1');
assert.ok(handleOfAAfterFirstType);

// The user now types in ANOTHER tab: only that tab's timer is armed; the first one is completely untouched.
vm.runInContext('armAutoSave(tabB)', env);
assert.ok(!env.clearedIds.includes(handleOfAAfterFirstType), 'typing in another tab must not cancel the pending save of this one');
assert.ok(env.pending.has(handleOfAAfterFirstType), 'the first save must still be pending after the other tab\'s edit');

// Firing the still-pending first timer must save the first tab,
// proving the earlier "type in A, then type in B" sequence did not lose A's save.
env.fire(handleOfAAfterFirstType);
assert.strictEqual(env.savedTabs.length, 1);
assert.strictEqual(env.savedTabs[0].id, 'p1');

// A second edit of the first tab replaces its OWN prior timer only.
vm.runInContext('armAutoSave(tabA)', env);
const handleOfB = timerOf(env, 's1');
env.fire(timerOf(env, 'p1'));
assert.strictEqual(env.savedTabs.length, 2);
assert.ok(env.pending.has(handleOfB), 'the other tab\'s save must be unaffected by a second edit of this one');

// Nothing is armed with autosave off or for a note without a file.
env = makeEnv({ initialOn: false, tabs: [{ id: 't1', path: 'a.md', isDirty: true }, { id: 't2', path: '', isDirty: true }] });
env.tabA = env.tabs[0];
env.tabB = env.tabs[1];
vm.runInContext('armAutoSave(tabA); armAutoSave(tabB);', env);
assert.strictEqual(env.pending.size, 0, 'autosave is off: no timer');
env.config.general.autoSave = true;
vm.runInContext('armAutoSave(tabB)', env);
assert.strictEqual(env.pending.size, 0, 'a note without a file has nothing to save to');

// A no-op check: scheduleAutoSave re-validates at fire time (tab closed / no
// longer dirty / path cleared in between) and must NOT save in that case.
env = makeEnv({ initialOn: true, tabs: [{ id: 't1', path: 'a.md', isDirty: true }] });
env.tabA = env.tabs[0];
vm.runInContext('armAutoSave(tabA)', env);
env.tabA.isDirty = false; // e.g. a manual Ctrl+S happened before the timer fired
env.fire(timerOf(env, 't1'));
assert.strictEqual(env.savedTabs.length, 0, 'a stale timer must not re-save a tab that is no longer dirty');

// ... and a note whose close prompt is open is not written either (C11-13: "Don't save" could still be answered after the file
// had been written with the very text being thrown away).
env = makeEnv({ initialOn: true, tabs: [{ id: 't1', path: 'a.md', isDirty: true }] });
env.tabA = env.tabs[0];
vm.runInContext('armAutoSave(tabA)', env);
env.tabA.closePrompt = true;
env.fire(timerOf(env, 't1'));
assert.strictEqual(env.savedTabs.length, 0, 'a note being closed is not autosaved while the question is open');

console.log('PASS: autosave status-bar toggle');
console.log('PASS: autosave timers are per tab (typing in another tab or pane cannot cancel a pending save; switching on picks up every dirty note)');
