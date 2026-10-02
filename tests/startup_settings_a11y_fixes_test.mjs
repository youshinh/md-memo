// Regression tests for the first-run / start-up / settings / accessibility / UI-language group of the exploratory-test findings
// (docs/testing/sessions/2026-09-30-c2, c6, c9, c11, c13, c14). Most of app.js is one IIFE, so the real functions are cut out of the
// source and run against hand-made stand-ins for what they touch (the same way tests/autosave_toggle_test.mjs does); where the
// finding is about the markup, the strings or the order of calls, the source is read instead. The headless-browser side of these
// fixes (real Tab key, real focus, a failing disk) is in tests/smoke/81_keyboard_exits.mjs, 82_unset_setup_focus.mjs and
// 86_failed_save_stays_visible.mjs.
//   C2-09   a failed save stays visible (mark on the tab, "failed" on the autosave item) and is tried again on the next edit
//   C11-09  the update check gives up after 15 s     C11-11  the one-time start-up notices take turns instead of overwriting
//   C11-12  autosave and the session are written at the latest 10 s / 5 s after the first unsaved change
//   C6-08   "Reset to defaults" does not register OS hotkeys     C6-12  the flat scrap_dir / git_sync_enabled keys are read
//   C6-13   the language select leaves a decided IME Guardian alone
//   C9-03 / C9-08 / C14-01 / C14-02 / C14-10   Go's Japanese lines, in the UI language; the AI item follows an Ollama set-up
//   C9-06 / C9-09 / C9-11 / C9-12 / C9-15   words and ways in to the AI settings     C13-09 / 10 / 11 / 13 / 15   keyboard and names
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf-8').replace(/\r\n/g, '\n');
const app = read('frontend/js/app.js');
const html = read('frontend/index.html');
const i18nCode = read('frontend/js/i18n.js');
const goTextCode = read('frontend/js/go_text.js');
const a11yCode = read('frontend/js/a11y.js');
const configPackCode = read('frontend/js/config_pack.js');

const i18nCtx = {};
vm.createContext(i18nCtx);
vm.runInContext(i18nCode + '; this.I18N = I18N;', i18nCtx);
const I18N = i18nCtx.I18N;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

// The source of a function of the app's IIFE (two-space indentation), from "function name(" to its closing brace.
function fnSrc(name) {
  const m = new RegExp('\\n  (?:async )?function ' + name + '\\(').exec(app);
  assert.ok(m, name + ' exists in app.js');
  const start = m.index + 1;
  return app.slice(start, app.indexOf('\n  }\n', start) + 4);
}
// A statement block: from `startText` to the first "\n  };\n" or "\n  }\n" after it.
function blockSrc(startText, closer) {
  const start = app.indexOf(startText);
  assert.ok(start !== -1, startText + ' exists in app.js');
  return app.slice(start, app.indexOf(closer, start) + closer.length);
}
const tOf = (lang) => (key, vars) => {
  let text = I18N[lang][key] !== undefined ? I18N[lang][key] : key;
  Object.keys(vars || {}).forEach((k) => { text = text.split('{' + k + '}').join(String(vars[k])); });
  return text;
};
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

// ---------------------------------------------------------------------------------------------------------------
// C2-09: a failed save does not vanish with its toast
// ---------------------------------------------------------------------------------------------------------------
function saveEnv(opts = {}) {
  const env = {
    window: { backend: { saveFile: opts.saveFile || (async () => ({})) } },
    I18N,
    config: { general: { autoSave: true, language: 'en' } },
    t: tOf('en'),
    goErr: (x) => String(x),
    messages: [], renders: 0, timers: [],
    tabs: [],
    statAutosave: { textContent: '', title: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    activeTabId: null, editorEl: null, isSplitMode: false, secondaryTabId: null, editorSecondary: null, secondaryViewMode: 'editor',
    rpcAutoSaveTimers: null,
    showMessage: (m) => { env.messages.push(m); },
    renderTabs: () => { env.renders++; },
    persistedContent: (tab) => tab.content,
    getTab: (id) => env.tabs.find((tb) => tb.id === id),
    getTabText: (id) => { const tb = env.tabs.find((x) => x.id === id); return tb ? tb.content : null; },
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
    clearTimeout: () => {}
  };
  vm.createContext(env);
  vm.runInContext(`const saveInFlight = new WeakMap();\n${['saveTab', 'saveTabNow', 'writeTabToItsFile', 'rememberWritten', 'markSavedUpTo', 'scheduleAutoSave', 'armAutoSave', 'renderAutosaveStatus'].map(fnSrc).join('\n')}`, env);
  return env;
}

check('C2-09: a save that fails leaves a mark on the tab and "failed" on the autosave item, not only a toast', async () => {
  let calls = 0;
  const env = saveEnv({ saveFile: async () => { calls++; throw new Error('disk full'); } });
  const tab = { id: 't1', path: 'C:/n/a.md', title: 'a.md', content: 'v1', isDirty: true, encoding: 'utf-8' };
  env.tabs.push(tab);
  assert.equal(await vm.runInContext('saveTab(tab, false, { auto: true })', Object.assign(env, { tab })), false);
  assert.equal(calls, 1);
  assert.match(env.messages[0], /Save error: disk full/);
  assert.equal(tab.saveFailed, true, 'the tab remembers that its last save failed');
  assert.ok(env.renders >= 1, 'and is drawn again so that the mark shows');
  vm.runInContext('renderAutosaveStatus()', env);
  assert.equal(env.statAutosave.textContent, I18N.en.statAutosaveFailed, 'the item no longer says ON while the text is only in the tab');
  assert.equal(env.statAutosave.title, I18N.en.statAutosaveFailedTooltip);
  assert.notEqual(env.statAutosave.textContent, I18N.en.statAutosaveOn);
});

check('C2-09: the next edit arms the autosave again (tab.saveFailed does not stop it), and the save that works clears the state', async () => {
  let fail = true;
  let calls = 0;
  const env = saveEnv({ saveFile: async () => { calls++; if (fail) throw new Error('share is gone'); return {}; } });
  const tab = { id: 't1', path: 'C:/n/a.md', title: 'a.md', content: 'v1', isDirty: true, encoding: 'utf-8' };
  env.tabs.push(tab);
  Object.assign(env, { tab });
  await vm.runInContext('saveTab(tab, false, { auto: true })', env);
  assert.equal(tab.saveFailed, true);
  // the person types: onEditorInput arms the autosave of the tab
  tab.content = 'v1 and more';
  vm.runInContext('armAutoSave(tab)', env);
  assert.equal(env.timers.length, 1, 'a timer is armed although the last save failed');
  fail = false; // the share is back
  env.timers[0].fn();
  await flush();
  assert.equal(calls, 2, 'the autosave tried again');
  assert.equal(tab.saveFailed, false, 'a save that works clears the state');
  assert.equal(tab.isDirty, false);
  vm.runInContext('renderAutosaveStatus()', env);
  assert.equal(env.statAutosave.textContent, I18N.en.statAutosaveOn);
});

check('C2-09: the state is only for a note that still has unsaved text, and not for a cancelled Save As', async () => {
  const env = saveEnv();
  env.tabs.push({ id: 't1', saveFailed: true, isDirty: false }); // saved by hand since
  vm.runInContext('renderAutosaveStatus()', env);
  assert.equal(env.statAutosave.textContent, I18N.en.statAutosaveOn);
  const env2 = saveEnv();
  env2.window.backend.saveFileAs = async () => null; // the person cancelled the dialog
  const scratch = { id: 's1', path: '', title: 'x.md', content: 'x', isDirty: true };
  env2.tabs.push(scratch);
  env2.withNativeDialog = (fn) => fn();
  env2.releasePathFromOtherTabs = () => '';
  Object.assign(env2, { scratch });
  assert.equal(await vm.runInContext('saveTab(scratch, false)', env2), false);
  assert.ok(!scratch.saveFailed, 'cancelling is not a failure');
});

check('C2-09: renderTabs draws the mark (the conflict mark wins when both hold) and redraws the item; both languages have the words', () => {
  const render = blockSrc('  function renderTabs() {', '\n  }\n');
  assert.match(render, /tab\.diskConflict \|\| \(tab\.saveFailed && tab\.isDirty\)/);
  assert.match(render, /t\(tab\.diskConflict \? 'diskConflictTabTitle' : 'saveFailedTabTitle'\)/);
  assert.match(render, /renderAutosaveStatus\(\);[^\n]*\n\s*notifyTabOverflow\(\);\s*\}/, 'the item follows the tabs, and the overflow module is still told last');
  for (const lang of ['en', 'ja']) for (const key of ['statAutosaveFailed', 'statAutosaveFailedTooltip', 'saveFailedTabTitle']) assert.ok(I18N[lang][key], key + ' in ' + lang);
  assert.ok(!CJK.test(I18N.en.statAutosaveFailed + I18N.en.statAutosaveFailedTooltip + I18N.en.saveFailedTabTitle));
});

// ---------------------------------------------------------------------------------------------------------------
// C11-09 / C11-11 / C11-12
// ---------------------------------------------------------------------------------------------------------------
check('C11-09: an update check that gets no answer ends as an error after 15 s, and can be asked again', async () => {
  const limit = /const UPDATE_CHECK_TIMEOUT_MS = (\d+);/.exec(app);
  assert.ok(limit && Number(limit[1]) === 15000, '15 s');
  const env = {
    UPDATE_API_URL: 'https://example.invalid/latest', UPDATE_CHECK_TIMEOUT_MS: 15000,
    AbortController, timers: [], fetches: [], badges: 0, version: '1.0.0',
    setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; },
    clearTimeout: (id) => { if (env.timers[id - 1]) env.timers[id - 1].cleared = true; },
    fetch: (url, init) => { env.fetches.push(init); return env.answer(); },
    answer: () => new Promise(() => {}), // a proxy that never answers
    applyUpdateBadge: () => { env.badges++; },
    appVersionString: async () => env.version,
    releaseNotesUrlFor: (v) => 'https://example.invalid/' + v
  };
  vm.createContext(env);
  vm.runInContext(`let updateState = { status: 'idle', latest: '', current: '', url: '' }; let updateCheckPromise = null;\n${fnSrc('isNewerVersion')}\n${fnSrc('checkForAppUpdates')}`, env);
  const first = vm.runInContext('checkForAppUpdates()', env);
  assert.equal(vm.runInContext('updateState.status', env), 'checking');
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 15000);
  assert.equal(vm.runInContext('checkForAppUpdates()', env), first, 'while it waits, a second call gets the same promise');
  env.timers[0].fn(); // 15 s pass
  const state = await first;
  assert.equal(state.status, 'error');
  assert.equal(env.fetches[0].signal.aborted, true, 'the hanging request is cancelled too');
  assert.equal(vm.runInContext('updateCheckPromise', env), null, 'so a new check is possible');
  assert.equal(env.badges, 1);
  // ... and an answer in time is still taken, with the timer let go
  env.version = '1.0.0';
  env.answer = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9' }) });
  const second = await vm.runInContext('checkForAppUpdates()', env);
  assert.equal(second.status, 'newer');
  assert.equal(second.latest, '9.9.9');
  assert.equal(env.timers[1].cleared, true, 'the 15 s timer is let go once the answer is in');
});

check('C11-11: start-up notices take turns: the second waits for the first to run out, and counts as seen only when shown', () => {
  const env = { clock: 1000, shown: [], timers: [], seen: [] };
  env.Date = { now: () => env.clock };
  env.showMessage = (m, d) => env.shown.push([m, d]);
  env.setTimeout = (fn, ms) => { env.timers.push({ fn, ms }); };
  vm.createContext(env);
  vm.runInContext(`let startupNoticeFreeAt = 0;\n${fnSrc('showStartupNotice')}`, env);
  vm.runInContext(`showStartupNotice('update', 9000, () => seen.push('update'));`, env);
  vm.runInContext(`showStartupNotice('agents', 8000, () => seen.push('agents'));`, env); // 1.5 s later, in effect
  assert.deepEqual(env.shown, [['update', 9000]], 'the second does not replace the first');
  assert.deepEqual(env.seen, ['update'], 'and it is not marked as seen yet');
  assert.equal(env.timers.length, 1);
  assert.ok(env.timers[0].ms >= 9000, 'it waits for the first one\'s time');
  env.clock += 9100;
  env.timers[0].fn();
  assert.deepEqual(env.shown, [['update', 9000], ['agents', 8000]]);
  assert.deepEqual(env.seen, ['update', 'agents']);
  // wired in: both notices go through it, and the "seen" marks are set when they are shown
  assert.match(fnSrc('announceAgentIssues'), /showStartupNotice\(t\('agentIssuesStartup'[^]*?\(\) => \{\s*config\.agentNotice = due\.state;/);
  const badge = fnSrc('applyUpdateBadge');
  assert.match(badge, /showStartupNotice\(t\('updateFoundHidden'[^]*?mdmemo_dismissed_update_version/);
  assert.match(badge, /updateNoticeQueuedFor !== updateState\.latest/, 'a second check while it waits does not queue it twice');
  assert.ok(!/showMessage\(t\('updateFoundHidden'/.test(app));
});

check('C11-12: autosave and the session have a longest wait; steady typing no longer postpones them for good', () => {
  const env = { clock: 0, timers: [], saved: 0, sessions: 0, autoTimer: null };
  env.Date = { now: () => env.clock };
  env.setTimeout = (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; };
  env.clearTimeout = () => {};
  env.getTab = () => env.tab;
  env.saveTab = () => { env.saved++; };
  env.savePersistentSession = () => { env.sessions++; };
  env.tab = { id: 't1', path: 'a.md', isDirty: true };
  vm.createContext(env);
  vm.runInContext(`let sessionSaveTimer = null; let sessionSaveAskedAt = 0;\n${fnSrc('scheduleAutoSave')}\n${fnSrc('saveSessionDebounced')}`, env);
  // Keystrokes at a fixed rhythm; `arm` is what each keystroke calls. A timer fires when its time comes before the next keystroke
  // (which would replace it). Returns the time of the first firing, or -1 when typing for `maxKeys` keystrokes never let one fire.
  const typeUntilFired = (everyMs, arm, maxKeys) => {
    const start = env.clock + 1_000_000; // a real clock is never 0 (0 means "no unsaved edit yet" in the code under test)
    let pending = null;
    for (let i = 0; i < maxKeys; i++) {
      const now = start + i * everyMs;
      if (pending && pending.at <= now) { env.clock = pending.at; pending.timer.fn(); return pending.at - start; }
      env.clock = now;
      const before = env.timers.length;
      arm();
      pending = { at: now + env.timers[before].ms, timer: env.timers[before] };
    }
    return -1;
  };
  // a key a second (autosave waits 1.5 s: each key replaces its timer)
  const autosaveAt = typeUntilFired(1000, () => { env.autoTimer = vm.runInContext('scheduleAutoSave(tab, autoTimer)', env); }, 30);
  assert.ok(autosaveAt > 0 && autosaveAt <= 10000, 'autosave is written by 10 s of steady typing, not only after the typing stops: ' + autosaveAt);
  assert.equal(env.saved, 1);
  // a key every 400 ms: the case of the finding (14 characters in 5.6 s wrote nothing)
  env.timers.length = 0;
  const sessionAt = typeUntilFired(400, () => vm.runInContext('saveSessionDebounced()', env), 40);
  assert.ok(sessionAt > 0 && sessionAt <= 5000, 'the session is written by 5 s of steady typing: ' + sessionAt);
  assert.equal(env.sessions, 1);
  env.clock = sessionAt + 10;
  const before = env.timers.length;
  vm.runInContext('saveSessionDebounced()', env);
  assert.equal(env.timers[before].ms, 500, 'after a write the plain 0.5 s wait starts again');
  // a note saved and edited again later starts a new wait: the time of its first unsaved edit is let go when its timer fires
  assert.match(fnSrc('scheduleAutoSave'), /tab\.autoSaveSince = 0;/);
  assert.equal(env.tab.autoSaveSince, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// C6-08, C6-12, C6-13
// ---------------------------------------------------------------------------------------------------------------
check('C6-08: "Reset to defaults" changes only the page: the OS hotkeys are registered by Save, never here', () => {
  const block = blockSrc('  if (btnResetShortcuts) {', '\n  }\n');
  const calls = [];
  const env = {
    btnResetShortcuts: {}, calls,
    DEFAULT_SHORTCUTS: { globalSummon: 'Ctrl+Alt+M', quickCapture: 'Ctrl+Shift+Q', find: 'Ctrl+F' },
    config: { shortcuts: { globalSummon: 'Ctrl+Alt+K', quickCapture: '', find: 'Ctrl+L' } },
    window: { backend: { updateGlobalShortcut: (s) => { calls.push(['summon', s]); return true; }, updateQuickCaptureShortcut: (s) => { calls.push(['capture', s]); return true; } } },
    syncQuickCaptureShortcut: (prev) => { calls.push(['syncQuickCapture', prev]); },
    quickCaptureShortcutOf: (sc) => sc.quickCapture,
    clearShortcutParseCache: () => {}, renderShortcutsTable: () => {}, updateShortcutLabels: () => {}, showMessage: () => {}, t: (k) => k,
    activeRecordingAction: 'find'
  };
  vm.createContext(env);
  vm.runInContext(block, env);
  env.btnResetShortcuts.onclick();
  assert.deepEqual(calls, [], 'the OS was told nothing: Cancel cannot take that back');
  assert.deepEqual(JSON.parse(JSON.stringify(env.config.shortcuts)), env.DEFAULT_SHORTCUTS, 'the page shows the defaults');
  // Save still registers what changed against the snapshot taken when the dialog opened
  const save = blockSrc("  document.getElementById('btn-save-settings').onclick = async () => {", '\n  };\n');
  assert.match(save, /curShortcut !== prevShortcut && window\.backend && window\.backend\.updateGlobalShortcut/);
  assert.match(save, /syncQuickCaptureShortcut\(prevQuickCapture\)/);
});

check('C6-12: the flat scrap_dir / git_sync_enabled keys of config.json are read, and the nested object overrides them only with a usable value', () => {
  const env = {};
  vm.createContext(env);
  vm.runInContext(fnSrc('legacyScrapSettings'), env);
  const legacy = (cfg) => JSON.parse(JSON.stringify(vm.runInContext('legacyScrapSettings(' + JSON.stringify(cfg) + ')', env)));
  assert.deepEqual(legacy({ scrap_dir: 'D:\\scraps', git_sync_enabled: false }), { scrapDir: 'D:\\scraps', gitSyncEnabled: false });
  assert.deepEqual(legacy({ git_sync_debounce_seconds: 90, git_remote_branch: 'dev', max_pipe_size_mb: 4 }), { gitSyncDebounceSeconds: 90, gitRemoteBranch: 'dev', maxPipeSizeMB: 4 });
  assert.deepEqual(legacy({ scrap_dir: 'D:\\old', scraps: { scrapDir: 'E:\\new' } }), {}, 'the nested value wins');
  assert.deepEqual(legacy({ scrap_dir: 'D:\\old', scraps: { scrapDir: '' } }), { scrapDir: 'D:\\old' }, 'an empty nested value does not (the backend reads it the same way)');
  assert.deepEqual(legacy({ git_sync_enabled: false, scraps: { gitSyncEnabled: true } }), {}, 'a nested false/true is a decision');
  assert.deepEqual(legacy({ scrap_dir: 5, git_sync_enabled: 'false', max_pipe_size_mb: 0 }), {}, 'wrong types and zero are ignored');
  assert.deepEqual(legacy(null), {});
  // and syncBackendConfig puts them into config.scraps, over what the nested object says
  assert.match(fnSrc('syncBackendConfig'), /const flatScraps = legacyScrapSettings\(fileConfig\);\s*if \(fileConfig\.scraps \|\| Object\.keys\(flatScraps\)\.length\) \{\s*if \(!config\.scraps\) config\.scraps = \{\};\s*Object\.assign\(config\.scraps, fileConfig\.scraps \|\| \{\}, flatScraps\);/);
});

check('C6-13: the language select does not rewrite an IME Guardian choice that is already made (only a profile that never saved one follows the language)', () => {
  const block = blockSrc('  if (cfgLanguageSelect) {', '\n  }\n');
  const run = ({ persisted, language, checked, nativeImeSwitch = true }) => {
    const box = { checked };
    const select = { value: language, onchange: null };
    const env = {
      cfgLanguageSelect: select, config: { general: { language: 'en' } }, hasPersistedImeGuardianSetting: persisted,
      platformCapabilities: { nativeImeSwitch }, applyLanguage: () => {},
      document: { getElementById: (id) => (id === 'cfg-ime-guardian' ? box : null) }
    };
    vm.createContext(env);
    vm.runInContext(block, env);
    select.onchange();
    return { checked: box.checked, language: env.config.general.language };
  };
  assert.deepEqual(run({ persisted: true, language: 'ja', checked: false }), { checked: false, language: 'ja' }, 'a saved "off" survives a try of the Japanese UI');
  assert.deepEqual(run({ persisted: true, language: 'en', checked: true }), { checked: true, language: 'en' }, 'and a saved "on" survives English');
  assert.equal(run({ persisted: false, language: 'ja', checked: false }).checked, true, 'a new profile still gets it on with Japanese');
  assert.equal(run({ persisted: false, language: 'en', checked: true }).checked, false);
  assert.equal(run({ persisted: false, language: 'ja', checked: false, nativeImeSwitch: false }).checked, false, 'never on an OS that cannot switch the input source');
});

// ---------------------------------------------------------------------------------------------------------------
// C9-03 / C9-08 / C14-01 / C14-02 / C14-10: the Go side's Japanese, in the UI language
// ---------------------------------------------------------------------------------------------------------------
function goTextEnv(lang) {
  const env = { config: { general: { language: lang } }, t: tOf(lang) };
  env.window = env;
  vm.createContext(env);
  vm.runInContext(goTextCode, env);
  vm.runInContext(fnSrc('goErr'), env);
  return env;
}

check('C14-01: goErr says the Go messages in the English UI, leaves the Japanese UI and unknown text alone, and survives a page without go_text.js', () => {
  const en = goTextEnv('en');
  const say = (e, s) => vm.runInContext('goErr(' + JSON.stringify(s) + ')', e);
  assert.equal(say(en, 'ファイルの保存に失敗しました: open C:\\a.md: Access is denied.'), 'Could not save the file: open C:\\a.md: Access is denied.');
  assert.equal(say(en, 'ファイルが見つかりません: CreateFile x'), 'File not found: CreateFile x');
  assert.equal(say(en, 'exit status 1'), 'exit status 1');
  assert.equal(say(en, undefined), '');
  assert.equal(say(goTextEnv('ja'), 'ファイルの保存に失敗しました: x'), 'ファイルの保存に失敗しました: x');
  const bare = { config: { general: { language: 'en' } }, t: tOf('en'), window: {} };
  vm.createContext(bare);
  vm.runInContext(fnSrc('goErr'), bare);
  assert.equal(vm.runInContext("goErr('ファイルが見つかりません: x')", bare), 'ファイルが見つかりません: x', 'no go_text.js: the text as it came');
});

check('C14-01: every place that shows a Go error or reason goes through goErr (save, open, export, folder, reload; the guard reasons)', () => {
  assert.ok(!/\$\{e\.message \|\| e\}/.test(app), 'no error text is shown as it came');
  assert.ok(!/showMessage\(`\$\{t\('(?:saveError|openError|exportPlainTextError|diskConflictLoadFailed)'\)\}\$\{(?!goErr|tab\.path)/.test(app));
  assert.ok(!/reason: (?:val|valResult|check)\.reason/.test(app), 'the command guard\'s reason is said in the UI language');
  assert.ok(!/showMessage\(valResult\.reason/.test(app));
  assert.equal((app.match(/goErr\((?:val|valResult|check)\.reason\)/g) || []).length, 6, 'the six places that show the guard\'s reason');
  assert.ok((app.match(/\$\{t\('openError'\)\}\$\{goErr\(e\.message \|\| e\)\}/g) || []).length >= 4);
  assert.match(html, /<script src="js\/go_text\.js\?v=[^"]+"><\/script>/, 'the page loads go_text.js');
  const at = (file) => html.indexOf('<script src="js/' + file);
  assert.ok(at('go_text.js') > 0 && at('go_text.js') < at('config_pack.js') && at('go_text.js') < at('app.js'), 'before the files that use it');
});

check('C14-02: a settings-package failure shows the half of "日本語 / English" for the UI language; the import date follows it too (C14-10)', () => {
  const run = (lang, e) => {
    const ctx = { document: { documentElement: { lang } } };
    vm.createContext(ctx);
    vm.runInContext(goTextCode, ctx);
    vm.runInContext(configPackCode, ctx);
    return ctx.ConfigPack.errMessage(e);
  };
  const failure = new Error('ファイルを開けません / cannot open the file: open C:\\a.mdmemopack: no such file');
  assert.equal(run('en', failure), 'cannot open the file: open C:\\a.mdmemopack: no such file');
  assert.equal(run('ja', failure), 'ファイルを開けません: open C:\\a.mdmemopack: no such file');
  assert.equal(run('en', 'plain text'), 'plain text', 'a string, not an Error');
  assert.match(configPackCode, /d\.toLocaleString\(uiLang\(\) === 'ja' \? 'ja-JP' : 'en-US'\)/, 'the created-at line is formatted for the UI language, not the operating system\'s');
  assert.ok(!/\.toLocaleString\(\)/.test(configPackCode));
});

check('C9-03 / C9-08: the Ollama set-up shows its steps in the UI language, a failure says what to do next, and success redraws the AI item', () => {
  const block = blockSrc('  window.__onOllamaSetupProgress = (prog) => {', '\n  };\n');
  const make = (lang) => {
    const el = () => ({ textContent: '', style: {}, classList: { add() {}, remove() {} } });
    const env = Object.assign(goTextEnv(lang), {
      activeOllamaSetupReqId: null, ollamaProgressMsg: el(), ollamaProgressStep: el(), ollamaProgressBar: el(), btnSetupOllama: el(),
      btnCancelOllamaSetup: el(), ollamaProgressBox: el(), refreshes: 0, saved: 0, messages: [],
      config: { general: { language: lang }, text: {}, autocomplete: {} },
      document: { getElementById: () => ({ value: '' }) },
      savePersistentConfig: () => { env.saved++; }, updateOllamaStatus: () => {}, refreshStatusAI: () => { env.refreshes++; },
      showMessage: (m) => env.messages.push(m), setTimeout: () => 0
    });
    vm.runInContext(block, env);
    return env;
  };
  const en = make('en');
  en.window.__onOllamaSetupProgress({ step: 4, total: 5, message: 'Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...' });
  assert.ok(!CJK.test(en.ollamaProgressMsg.textContent), en.ollamaProgressMsg.textContent);
  assert.match(en.ollamaProgressMsg.textContent, /Downloading the Gemma 4 E2B model/);
  assert.equal(en.ollamaProgressStep.textContent, 'Step 4/5');
  en.window.__onOllamaSetupProgress({ step: 2, total: 5, isDone: true, success: false, message: 'Ollamaのインストールに失敗しました', error: "exit status 1: 'winget' is not recognized as an internal or external command" });
  assert.equal(en.ollamaProgressMsg.textContent, 'Could not install Ollama');
  assert.ok(!CJK.test(en.messages.join('')), 'the toast has no Japanese: ' + en.messages.join(' | '));
  assert.match(en.messages.join(''), /winget/);
  assert.match(en.messages.join(''), /ollama\.com\/download/, 'and says what to do next');
  assert.equal(en.refreshes, 0, 'a failed set-up changes no model');
  en.window.__onOllamaSetupProgress({ step: 5, total: 5, isDone: true, success: true, message: 'Ollama & Gemma 4 E2B のセットアップが完了しました！' });
  assert.equal(en.refreshes, 1, 'the AI item of the status bar is drawn again with the new model (C9-08)');
  assert.equal(en.config.text.model, 'gemma4:e2b');
  const ja = make('ja');
  ja.window.__onOllamaSetupProgress({ step: 1, total: 5, message: 'Ollamaのインストール状況を確認しています...' });
  assert.equal(ja.ollamaProgressMsg.textContent, 'Ollamaのインストール状況を確認しています...');
  assert.equal(ja.ollamaProgressStep.textContent, 'ステップ 1/5');
  assert.equal(I18N.en.ollamaStepOf, 'Step {step}/{total}');
});

check('C9-05: the failed text prediction is put into words before it reaches the AI item (asked about the prediction\'s own model)', () => {
  const handler = blockSrc('  window.__onAutocompleteResult = function (reqId, suggestion, errMsg) {', '\n  };\n');
  assert.match(handler, /setPredictStatus\('error', describeLlmFailure\(errMsg, config\.autocomplete\)\.summary\)/);
  assert.ok(!/setPredictStatus\('error', errMsg\)/.test(handler));
});

// ---------------------------------------------------------------------------------------------------------------
// C9-06 / C9-09 / C9-11 / C9-12 / C9-15 / C13-09
// ---------------------------------------------------------------------------------------------------------------
check('C9-06: the tooltip of the "AI: local" item does not claim that the model is running', () => {
  assert.ok(!/\brunning\b/i.test(I18N.en.statAiTitleLocal), I18N.en.statAiTitleLocal);
  assert.ok(!/動作/.test(I18N.ja.statAiTitleLocal) && !/動いています/.test(I18N.ja.statAiTitleLocal), I18N.ja.statAiTitleLocal);
});

check('C9-09: the words a newcomer types in the palette (model, ollama, api key, cloud, language, theme, toolbar, update) are found', () => {
  const ids = ['cmd_ai_settings', 'cmd_general_settings'];
  for (const id of ids) assert.ok(new RegExp("id: '" + id + "'").test(app), id + ' is a palette command');
  assert.match(app, /action: \(\) => openAiModelsSettings\('text'\)/);
  assert.match(app, /id: 'cmd_general_settings'[^]*?action: \(\) => \{ openSettings\(\); switchSettingsTab\('general'\); \}/);
  const haystack = ['cmdPaletteAiSetup', 'cmdPaletteAiSetupDesc', 'cmdPaletteGeneralSettings', 'cmdPaletteGeneralSettingsDesc', 'cmdPaletteSettings', 'cmdPaletteSettingsDesc'].map((k) => I18N.en[k]).join(' | ').toLowerCase();
  for (const word of ['model', 'ollama', 'api key', 'cloud', 'language', 'theme', 'toolbar', 'update']) assert.ok(haystack.includes(word), '"' + word + '" is in a title or description');
  for (const lang of ['en', 'ja']) for (const key of ['cmdPaletteAiSetup', 'cmdPaletteAiSetupDesc', 'cmdPaletteGeneralSettings', 'cmdPaletteGeneralSettingsDesc']) assert.ok(I18N[lang][key], key);
  assert.ok(!CJK.test(I18N.en.cmdPaletteAiSetup + I18N.en.cmdPaletteAiSetupDesc + I18N.en.cmdPaletteGeneralSettings + I18N.en.cmdPaletteGeneralSettingsDesc));
});

check('C9-11: "no AI model is set up" is one sentence everywhere (the toast, the bar, the status item), in both languages', () => {
  assert.ok(I18N.en.askLlmNotConfigured.startsWith(I18N.en.askSetupNeeded), I18N.en.askLlmNotConfigured);
  assert.ok(I18N.ja.askLlmNotConfigured.startsWith(I18N.ja.askSetupNeeded), I18N.ja.askLlmNotConfigured);
  assert.ok(I18N.en.statAiTitleNotSet.startsWith(I18N.en.askSetupNeeded));
  assert.ok(I18N.ja.statAiTitleNotSet.startsWith(I18N.ja.askSetupNeeded.replace(/。$/, '')));
  for (const lang of ['en', 'ja']) {
    assert.ok(!/LLM/.test(I18N[lang].askLlmNotConfigured), 'the old wording ("LLM is not configured") is gone');
    assert.ok(!/->|→/.test(I18N[lang].askLlmNotConfigured), 'and so is its arrow: the path is written with ›');
    assert.ok(I18N[lang].askLlmNotConfigured.includes('›'));
  }
});

check('C9-12 / C13-09: Set up goes through openAiModelsSettings (first field gets the focus); Settings focuses the tab that is showing', () => {
  assert.match(app, /btnInlinePromptSetup\.onclick = \(\) => openAiModelsSettings\('text'\);/);
  const open = fnSrc('openAiModelsSettings');
  assert.match(open, /const cloud = part === 'cloud' \|\| part === 'text';/);
  assert.match(open, /part === 'text' \? 'cfg-base-url' : cloud \? 'cfg-api-key' : 'btn-setup-ollama'/);
  const settings = fnSrc('openSettings');
  assert.match(settings, /\[tabBtnGeneral, tabBtnModel, tabBtnAgent, tabBtnSync, tabBtnShortcuts\]\.find\(\(b\) => b && b\.classList && b\.classList\.contains\('active'\)\)/);
  assert.ok(!/setTimeout\(\(\) => \{\s*if \(tabBtnGeneral\) tabBtnGeneral\.focus\(\);\s*\}, 50\);/.test(settings), 'not always the General tab');
});

check('C9-15: once the last task has ended the tooltip says so, not "Running tasks: 1"', () => {
  const tm = read('frontend/js/task_manager.js');
  assert.match(tm, /statTasksEl\.title = tt\('taskFinishedTooltip', \{ alt: getAltLabel\(\) \}\);/);
  for (const lang of ['en', 'ja']) {
    assert.ok(I18N[lang].taskFinishedTooltip.includes('{alt}'), lang);
    assert.ok(!/Running tasks|実行中タスク/.test(I18N[lang].taskFinishedTooltip));
  }
  assert.ok(!CJK.test(I18N.en.taskFinishedTooltip));
});

// ---------------------------------------------------------------------------------------------------------------
// C13-10 / C13-11 / C13-13 / C13-15
// ---------------------------------------------------------------------------------------------------------------
check('C13-10: Tab leaves the All tabs list and the Help menu through their buttons (the browser then moves on from the button)', () => {
  const overflow = read('frontend/js/tab_overflow.js');
  assert.match(overflow, /case 'Tab': closeList\(true\); handled = false; break;/);
  const help = blockSrc("      key: (e) => {\n        if (e.key === 'Escape') {", "\n      }\n    };");
  assert.match(help, /else if \(e\.key === 'Tab'\) \{[^}]*closeHelpMenu\(true\);/);
});

check('C13-11: a tab is named by its note and "unsaved changes", not "title ● Close title"; the tablist has a name', () => {
  const mkEl = (attrs = {}, kids = {}) => {
    const map = Object.assign({}, attrs);
    const el = {
      classList: { contains: (c) => (map['class'] || '').split(' ').includes(c) },
      getAttribute: (k) => (k in map ? map[k] : null), setAttribute: (k, v) => { map[k] = String(v); }, hasAttribute: (k) => k in map,
      removeAttribute: (k) => { delete map[k]; }, querySelector: (sel) => kids[sel] || null, addEventListener() {}
    };
    return el;
  };
  const build = (lang, dirty) => {
    const title = Object.assign(mkEl(), { textContent: 'project-notes.md' });
    const close = mkEl();
    const kids = { '.tab-title': title, '.tab-close': close };
    if (dirty) kids['.tab-dirty-dot'] = mkEl();
    const tab = mkEl({ class: 'tab-item active' }, kids);
    const list = Object.assign(mkEl(), { querySelectorAll: (sel) => (sel === '.tab-item' ? [tab] : []) });
    const doc = {
      documentElement: { lang, getAttribute: () => null, setAttribute() {} },
      getElementById: (id) => (id === 'tabs-list' ? list : null),
      querySelectorAll: () => [], addEventListener() {}
    };
    const ctx = { document: doc, I18N };
    vm.createContext(ctx);
    vm.runInContext(a11yCode, ctx); // the page file initialises itself when it loads
    return { tab, close, list };
  };
  let page = build('en', true);
  assert.equal(page.tab.getAttribute('aria-label'), 'project-notes.md, Unsaved changes');
  assert.equal(page.tab.getAttribute('role'), 'tab');
  assert.equal(page.close.getAttribute('aria-label'), 'Close project-notes.md');
  assert.equal(page.list.getAttribute('aria-label'), 'Tabs', 'the tablist has a name');
  page = build('en', false);
  assert.equal(page.tab.getAttribute('aria-label'), 'project-notes.md', 'a saved note is just its title');
  page = build('ja', true);
  assert.equal(page.tab.getAttribute('aria-label'), 'project-notes.md, 未保存の変更あり');
  assert.equal(page.list.getAttribute('aria-label'), 'タブ');
});

check('C13-13: the two "Open" buttons of About say which folder; the AI popover is named "AI options"; the destination line is read as "Sent to: ..."', () => {
  const about = read('frontend/js/about_dialog.js');
  assert.match(about, /open\.setAttribute\('aria-label', host\.t\('aboutOpenFolderAria', \{ name: keyText \}\)\)/);
  for (const lang of ['en', 'ja']) {
    assert.ok(I18N[lang].aboutOpenFolderAria.includes('{name}'), lang);
    assert.ok(I18N[lang].askDestAria, lang);
  }
  assert.ok(!CJK.test(I18N.en.aboutOpenFolderAria + I18N.en.askDestAria));
  const statusAi = read('frontend/js/status_ai.js');
  assert.ok(!/pop\.setAttribute\('aria-labelledby'/.test(statusAi), 'a labelledby on the heading "AI" would win over the aria-label');
  assert.match(statusAi, /pop\.setAttribute\('aria-label', t\('aiPopAria'\)\)/);
  assert.match(html, /<span id="inline-prompt-dest"[^>]*>[^]*?aria-hidden="true">[^]*?<\/svg><span class="visually-hidden" data-i18n="askDestAria">Sent to: <\/span><span id="inline-prompt-dest-text"><\/span><\/span>/);
});

check('C13-15: the find bar\'s Aa / \\b / .* buttons say whether they are on (aria-pressed), from the start and after each press', () => {
  for (const id of ['btn-find-case', 'btn-find-word', 'btn-find-regex']) {
    assert.match(html, new RegExp('<button id="' + id + '"[^>]*aria-pressed="false"'), id + ' starts as "not pressed"');
  }
  const start = app.indexOf('  btnFindCase.onclick = () => {');
  const block = app.slice(start, app.indexOf('  btnFindPrev.onclick = findPrev;'));
  const button = () => { const b = { attrs: {}, classes: new Set(), setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle: (c, on) => { if (on) b.classes.add(c); else b.classes.delete(c); } } }; return b; };
  const env = { btnFindCase: button(), btnFindWord: button(), btnFindRegex: button(), searches: 0, searchMatches() { env.searches++; } };
  vm.createContext(env);
  vm.runInContext('let isCaseSensitive = false, isWholeWord = false, isRegex = false;\n' + block, env);
  env.btnFindCase.onclick();
  env.btnFindRegex.onclick();
  assert.equal(env.btnFindCase.attrs['aria-pressed'], 'true');
  assert.equal(env.btnFindWord.attrs['aria-pressed'], undefined, 'the one not touched is as it was in the markup');
  assert.equal(env.btnFindRegex.attrs['aria-pressed'], 'true');
  env.btnFindCase.onclick();
  env.btnFindWord.onclick();
  assert.equal(env.btnFindCase.attrs['aria-pressed'], 'false');
  assert.equal(env.btnFindWord.attrs['aria-pressed'], 'true');
  assert.equal(env.btnFindCase.classes.has('active'), false, 'the colour and the state agree');
  assert.equal(env.searches, 4);
});

// ---------------------------------------------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of queue) {
  try {
    await fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}
if (failed) {
  console.log(failed + ' of ' + queue.length + ' check(s) failed');
  process.exit(1);
}
console.log('All ' + queue.length + ' check(s) passed.');
