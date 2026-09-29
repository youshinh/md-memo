// A5: a new profile starts with a calm header (Open, Save, Find, Ask AI, Preview, Settings, and "+" beside the tabs).
// Everything else stays reachable, and nobody who already has a config or has used this WebView sees their toolbar change.
//   * the list is made of real toolbar ids, keeps Settings, and leaves exactly the intended icons (with the divider between the groups)
//   * every hidden icon has a way back: a palette command or a right-click item, and the Settings list
//   * app.js: only a profile that is new in every way we can see gets it; an existing config keeps its layout (an empty one included)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createEnv, I18N } from './fixtures/slot_env.mjs';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const app = read('frontend/js/app.js');
const require = createRequire(import.meta.url);
require('../frontend/js/chrome_layout.js');
const CL = globalThis.ChromeLayout;

const queue = [];
const check = (name, fn) => queue.push({ name, fn });

const actions = html.slice(html.indexOf('<div id="header-actions">'), html.indexOf('</header>'));
const toolbarIds = Array.from(actions.matchAll(/<button id="(btn-[a-z-]+)"/g)).map((m) => m[1]);

check('the calm list is made of real toolbar buttons, Settings is never in it', () => {
  const hidden = CL.CALM_TOOLBAR_HIDDEN;
  assert.ok(hidden.length >= 8);
  for (const id of hidden) assert.ok(toolbarIds.includes(id), `${id} is a button in #header-actions`);
  assert.equal(new Set(hidden).size, hidden.length, 'no duplicates');
  assert.ok(!hidden.includes('btn-settings'), 'the way back into Settings stays');
  const layout = CL.calmToolbarLayout();
  assert.deepEqual(layout.order, [], 'the order is untouched');
  assert.deepEqual(layout.hidden, hidden);
  layout.hidden.push('x');
  assert.ok(!CL.CALM_TOOLBAR_HIDDEN.includes('x'), 'each call gives a fresh copy');
});

check('what is left visible is exactly Open, Save, Find, Ask AI, Preview and Settings; "+" is outside the layout', () => {
  const visible = toolbarIds.filter((id) => !CL.CALM_TOOLBAR_HIDDEN.includes(id));
  assert.deepEqual(visible, ['btn-open-file', 'btn-save-file', 'btn-find', 'btn-header-llm', 'btn-toggle-preview', 'btn-settings']);
  assert.ok(!toolbarIds.includes('btn-new-tab'), 'New is the "+" beside the tabs, always there');
  assert.ok(html.includes('id="btn-new-tab"'));
});

// The real markup order, as the module sees it: buttons and dividers in a row.
function buildFromMarkup() {
  const make = (tag, id, cls) => {
    const el = { tagName: tag, id, children: [], _classes: new Set(cls ? [cls] : []), parentNode: null };
    el.classList = {
      add: (...n) => n.forEach((x) => el._classes.add(x)),
      remove: (...n) => n.forEach((x) => el._classes.delete(x)),
      contains: (n) => el._classes.has(n),
      toggle: (n, f) => { const on = f === undefined ? !el._classes.has(n) : !!f; if (on) el._classes.add(n); else el._classes.delete(n); return on; }
    };
    el.getAttribute = () => null;
    el.insertBefore = (c, ref) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      const at = ref ? el.children.indexOf(ref) : el.children.length;
      el.children.splice(at, 0, c);
      return c;
    };
    return el;
  };
  const container = make('DIV', 'header-actions');
  for (const m of actions.matchAll(/<button id="(btn-[a-z-]+)"|class="header-divider"/g)) {
    const el = m[1] ? make('BUTTON', m[1]) : make('DIV', '', 'header-divider');
    el.parentNode = container;
    container.children.push(el);
  }
  const doc = { getElementById: (id) => (id === 'header-actions' ? container : null) };
  return { container, doc };
}

check('applied to the real header: the seven stay, the rest hide, and the one divider sits between the two groups that remain', () => {
  const { container, doc } = buildFromMarkup();
  // a page that has never had a layout applied: state starts pristine in a fresh module instance
  const fresh = createRequire(import.meta.url);
  delete fresh.cache[fresh.resolve('../frontend/js/chrome_layout.js')];
  fresh('../frontend/js/chrome_layout.js');
  const module = globalThis.ChromeLayout;
  assert.equal(module._apply('toolbar', module.calmToolbarLayout(), doc), true);
  const shown = container.children.filter((c) => !c._classes.has('layout-hidden')).map((c) => c.id || 'divider');
  assert.deepEqual(shown, ['btn-open-file', 'btn-save-file', 'btn-find', 'btn-header-llm', 'divider', 'btn-toggle-preview', 'btn-settings']);
  assert.equal(module.hasVisibleItems('toolbar'), true);
  // the user can bring one back through the ordinary list, and take the divider logic with it
  const layout = module.calmToolbarLayout();
  module._setVisible('toolbar', layout, 'btn-help', true, doc);
  assert.ok(!container.children.find((c) => c.id === 'btn-help')._classes.has('layout-hidden'));
});

check('every hidden icon has a way back besides Settings: a palette command or a right-click item', () => {
  const route = {
    'btn-open-folder': { cmd: 'cmd_open_folder', ctx: 'ctx-open-folder' },
    'btn-search-scraps': { cmd: 'cmd_search_scraps' },
    'btn-mobile-drop': { cmd: 'cmd_mobile_drop' },
    'btn-voice-input': { cmd: 'cmd_voice_input', ctx: 'ctx-voice-input' },
    'btn-quick-capture': { cmd: 'cmd_quick_capture' },
    'btn-toggle-split': { cmd: 'cmd_toggle_split' },
    'btn-preview-side': { cmd: 'cmd_preview_side', ctx: 'ctx-open-to-side' },
    'btn-zen': { cmd: 'cmd_toggle_zen', ctx: 'ctx-zen' },
    'btn-fullscreen': { cmd: 'cmd_toggle_fullscreen', ctx: 'ctx-fullscreen' },
    'btn-help': { cmd: 'cmd_help' }
  };
  for (const id of CL.CALM_TOOLBAR_HIDDEN) {
    assert.ok(route[id], `${id} needs a route in this test: add its palette command or right-click item`);
    assert.ok(app.includes(`id: '${route[id].cmd}'`), `${route[id].cmd} is a palette command`);
    if (route[id].ctx) assert.ok(html.includes(`id="${route[id].ctx}"`), `${route[id].ctx} is in the right-click menu`);
  }
  assert.equal(Object.keys(route).length, CL.CALM_TOOLBAR_HIDDEN.length, 'no stale routes');
  assert.ok(html.includes('id="ctx-quick-pick"'), 'and the right-click menu itself offers the command palette');
});

check('the palette commands added for this exist in both languages, with no emoji, and the hint says where hidden icons went', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
  const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
  const keys = ['cmdPalettePreviewSide', 'cmdPalettePreviewSideDesc', 'cmdPaletteSearchNotes', 'cmdPaletteSearchNotesDesc', 'cmdPaletteAllTabs', 'cmdPaletteAllTabsDesc'];
  for (const lang of ['en', 'ja']) {
    for (const key of keys) assert.ok(I18N[lang][key] && !EMOJI.test(I18N[lang][key]), `${lang}.${key}`);
    assert.ok(/palette|\u30d1\u30ec\u30c3\u30c8/.test(I18N[lang].layoutHint), `${lang}.layoutHint mentions the command palette`);
  }
  for (const key of keys) {
    assert.ok(!JAPANESE.test(I18N.en[key]), `en.${key} has no Japanese`);
    assert.ok(JAPANESE.test(I18N.ja[key]), `ja.${key} is Japanese`);
  }
});

check('app.js: the default stays "show everything"; the calm layout is applied only to a profile that is new in every way we can see', () => {
  assert.ok(/toolbarLayout:\s*\{ order: \[\], hidden: \[\] \}/.test(app), 'config.general still defaults to the empty layout');
  const load = app.slice(app.indexOf('function loadLocalConfigSync('), app.indexOf('async function syncBackendConfig('));
  assert.ok(/if \(saved\) \{\s*hasSavedConfig = true;/.test(load), 'a stored config marks the profile as not new, before it is parsed');
  assert.ok(load.indexOf('applyCalmToolbarForNewProfile()') > load.indexOf('} catch (e) {}') && load.indexOf('applyCalmToolbarForNewProfile()') < load.indexOf('applyChromeLayout()'),
    'the calm layout goes in before the first paint, after the stored config had its say');
  const sync = app.slice(app.indexOf('async function syncBackendConfig('));
  assert.ok(sync.indexOf('hasSavedConfig = true') > 0 && sync.indexOf('hasSavedConfig = true') < sync.indexOf('applyChromeLayout()'), 'config.json marks it too');
  const start = app.indexOf('function applyCalmToolbarForNewProfile() {');
  const fn = app.slice(start, app.indexOf('\n  }\n', start));
  assert.ok(/md_memo_session_v1[\s\S]*md_notepad_session_v1[\s\S]*md_memo_workspace_folder/.test(fn), 'a session or a workspace folder in this WebView means it was used before');
  assert.ok(/catch \(e\) \{\s*return;/.test(fn), 'and with no storage to tell, nothing changes');
});

// ---- behaviour, with the real app.js on a hand-made DOM --------------------------------------------------
const layoutOf = (env) => JSON.parse(JSON.stringify(env.config.general.toolbarLayout));
const MARK = 'md_memo_calm_toolbar_v1';
const SESSION = JSON.stringify({ tabs: [] });

check('a new profile (nothing in storage, no config.json) gets the calm layout, and it survives the backend load', async () => {
  const env = await createEnv();
  assert.deepEqual(layoutOf(env), { order: [], hidden: CL.CALM_TOOLBAR_HIDDEN });
  assert.deepEqual(layoutOf(await createEnv({ backendConfig: null })), { order: [], hidden: CL.CALM_TOOLBAR_HIDDEN });
  assert.equal(env.store.get(MARK), '1', 'it leaves its own mark, and nothing that reads as a saved config');
  assert.ok(!env.store.has('md_notepad_config_v3') && !env.store.has('md_memo_config_v1'));
});

check('someone who never saved a setting but has used this WebView (a session, or a workspace folder) keeps every icon', async () => {
  for (const [key, value] of [['md_memo_session_v1', SESSION], ['md_notepad_session_v1', SESSION], ['md_memo_workspace_folder', 'C:\\notes']]) {
    const env = await createEnv({ localStorage: { [key]: value } });
    assert.deepEqual(layoutOf(env), { order: [], hidden: [] }, key);
    assert.ok(!env.store.has(MARK), key + ': no mark is made for a profile that is not new');
  }
});

check('the second start of a new profile (a session now, the mark, still no saved config) is calm at the first paint', async () => {
  const second = await createEnv({ localStorage: { [MARK]: '1', md_memo_session_v1: SESSION, md_memo_workspace_folder: 'C:\\notes' } });
  assert.deepEqual(layoutOf(second), { order: [], hidden: CL.CALM_TOOLBAR_HIDDEN });
  // the same with what the first run itself left behind
  const first = await createEnv();
  const back = await createEnv({ localStorage: Object.fromEntries([...first.store, ['md_memo_session_v1', SESSION]]) });
  assert.deepEqual(layoutOf(back), { order: [], hidden: CL.CALM_TOOLBAR_HIDDEN });
});

check('a stored config without a layout (from before layouts existed) keeps every icon', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { language: 'en' } }) } });
  assert.deepEqual(layoutOf(env), { order: [], hidden: [] });
  const named = await createEnv({ localStorage: { md_memo_config_v1: JSON.stringify({ shortcuts: {} }) } });
  assert.deepEqual(layoutOf(named), { order: [], hidden: [] }, 'the newer storage key counts too');
});

check('a stored layout is never touched: empty ("show everything"), or the user\'s own', async () => {
  const empty = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { toolbarLayout: { order: [], hidden: [] } } }) } });
  assert.deepEqual(layoutOf(empty), { order: [], hidden: [] });
  const own = { order: ['btn-find', 'btn-open-file'], hidden: ['btn-zen'] };
  const custom = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify({ general: { toolbarLayout: own } }) } });
  assert.deepEqual(layoutOf(custom), own);
});

check('the mark never overrides a config: a saved layout, or a config.json without one, still wins', async () => {
  const saved = await createEnv({ localStorage: { [MARK]: '1', md_notepad_config_v3: JSON.stringify({ general: { toolbarLayout: { order: [], hidden: [] } } }) } });
  assert.deepEqual(layoutOf(saved), { order: [], hidden: [] });
  const file = await createEnv({ localStorage: { [MARK]: '1' }, backendConfig: { general: { language: 'en' } } });
  assert.deepEqual(layoutOf(file), { order: [], hidden: [] }, 'config.json without a layout means show everything');
});

check('a corrupt stored config still counts as "not new": nobody\'s icons vanish because of it', async () => {
  const env = await createEnv({ localStorage: { md_notepad_config_v3: '{not json' } });
  assert.deepEqual(layoutOf(env), { order: [], hidden: [] });
});

check('storage empty but config.json exists (a reinstall, a cleared WebView profile): its own layout wins', async () => {
  const own = { order: [], hidden: ['btn-help'] };
  const withLayout = await createEnv({ backendConfig: { general: { toolbarLayout: own, language: 'en' } } });
  assert.deepEqual(layoutOf(withLayout), own);
  const showAll = await createEnv({ backendConfig: { general: { toolbarLayout: { order: [], hidden: [] } } } });
  assert.deepEqual(layoutOf(showAll), { order: [], hidden: [] });
  const old = await createEnv({ backendConfig: { general: { language: 'en' } } });
  assert.deepEqual(layoutOf(old), { order: [], hidden: [] }, 'an old config.json without a layout means show everything');
  const noGeneral = await createEnv({ backendConfig: { shortcuts: {} } });
  assert.deepEqual(layoutOf(noGeneral), { order: [], hidden: [] });
});

check('with no usable storage the toolbar stays as it always was', () => {
  const start = app.indexOf('function applyCalmToolbarForNewProfile() {');
  const source = app.slice(start, app.indexOf('\n  }\n', start) + 4);
  const run = (localStorage) => {
    const context = vm.createContext({ window: { ChromeLayout: CL }, localStorage, config: { general: { toolbarLayout: { order: [], hidden: [] } } } });
    vm.runInContext(
      `const CALM_TOOLBAR_MARK = 'md_memo_calm_toolbar_v1'; let hasSavedConfig = false; let calmToolbarApplied = false;\n${source}\n` +
      'applyCalmToolbarForNewProfile(); globalThis.out = { hidden: config.general.toolbarLayout.hidden.length, applied: calmToolbarApplied };',
      context
    );
    return JSON.parse(JSON.stringify(context.out));
  };
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(run(broken), { hidden: 0, applied: false });
  const readOnly = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.deepEqual(run(readOnly), { hidden: 0, applied: false }, 'if the mark cannot be written the profile is not changed either (it would flip on the next start)');
  const fine = { getItem: () => null, setItem() {} };
  assert.deepEqual(run(fine), { hidden: CL.CALM_TOOLBAR_HIDDEN.length, applied: true });
});

check('the calm layout round-trips: a config saved from a new profile is read back as a saved layout and left alone', async () => {
  const env = await createEnv();
  const saved = JSON.parse(JSON.stringify(env.config)); // what savePersistentConfig writes: the whole config object
  assert.deepEqual(saved.general.toolbarLayout.hidden, CL.CALM_TOOLBAR_HIDDEN);
  const next = await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify(saved) } });
  assert.deepEqual(layoutOf(next), { order: [], hidden: CL.CALM_TOOLBAR_HIDDEN });
  const edited = JSON.parse(JSON.stringify(saved));
  edited.general.toolbarLayout.hidden = [];
  assert.deepEqual(layoutOf(await createEnv({ localStorage: { md_notepad_config_v3: JSON.stringify(edited) } })), { order: [], hidden: [] }, 'and ticking everything back sticks');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of queue) {
    try {
      await fn();
      console.log('PASS: ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL: ' + name + '\n  ' + (err && err.stack || err));
    }
  }
  if (failed) { console.log(`\n${failed} check(s) failed.`); process.exit(1); }
  console.log(`\n${queue.length} checks passed.`);
})();
