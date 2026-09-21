// Full screen: F11 is real full screen (no title bar, no taskbar) instead of "maximize", with header buttons for it and for
// Zen mode. Static wiring checks plus the two pure pieces (the shortcut migration, "is the page filling the screen").
import assert from 'node:assert';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const appJs = read('frontend/js/app.js');
const indexHtml = read('frontend/index.html');
const i18nJs = read('frontend/js/i18n.js');
const winGo = read('window_windows.go');
const macGo = read('window_darwin.go');

function extractFn(src, header) {
  const start = src.indexOf(header);
  assert(start >= 0, `${header} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`could not extract ${header}`);
}

// ---- 1. native side --------------------------------------------------------------------------
{
  for (const [name, go] of [['windows', winGo], ['darwin', macGo]]) {
    assert(/_ = w\.Bind\("backend_toggleFullscreen"/.test(go), `${name}: backend_toggleFullscreen is bound`);
    assert(/toggleFullscreen: \(\) => window\.backend_toggleFullscreen\(\)/.test(go), `${name}: the shim exposes toggleFullscreen`);
    assert(/toggleMaximize: \(\) => window\.backend_toggleMaximize\(\)/.test(go), `${name}: maximize is still there`);
  }
  // No native F11 handler any more: it was handed the key code alone, so it took Shift+F11 (Zen mode) too and could not follow a
  // user's own binding. The page decides; the WebView only has to let the keys through.
  assert(!/AcceleratorKeyCallback/.test(winGo) && !/modifierKeyHeld/.test(winGo), 'the native accelerator handler is gone');
  assert(/PutAreBrowserAcceleratorKeysEnabled\(false\)/.test(winGo), 'browser accelerator keys stay off so F11 reaches the page');
  const toggle = extractFn(winGo, 'func toggleWindowFullscreen(');
  assert(/WS_CAPTION\|WS_THICKFRAME/.test(toggle) && /MonitorFromWindow/.test(toggle) && /RcMonitor/.test(toggle), 'the window loses its frame and takes the whole monitor');
  assert(/SC_RESTORE/.test(toggle) && /SC_MAXIMIZE/.test(toggle), 'a maximized window is restored first and maximized again on the way back');
  assert(/fullscreenState\.style/.test(toggle) && /fullscreenState\.rect/.test(toggle), 'the way back restores style and position');
  console.log('PASS: native full screen (Windows toggle, macOS bind, no native F11 handler).');
}

// ---- 2. defaults, key handling ---------------------------------------------------------------
{
  const win = appJs.slice(appJs.indexOf('const DEFAULT_SHORTCUTS_WIN'), appJs.indexOf('const DEFAULT_SHORTCUTS_MAC'));
  const mac = appJs.slice(appJs.indexOf('const DEFAULT_SHORTCUTS_MAC'), appJs.indexOf('const DEFAULT_SHORTCUTS = '));
  assert(/toggleFullscreen: 'F11'/.test(win) && /toggleMaximize: ''/.test(win), 'Windows: F11 is full screen, maximize has no key');
  assert(/toggleFullscreen: 'Ctrl\+Cmd\+F'/.test(mac) && /toggleMaximize: ''/.test(mac), 'macOS: Ctrl+Cmd+F is full screen, maximize has no key');

  const handler = appJs.slice(appJs.indexOf('// Full screen (F11 by default)'), appJs.indexOf('// Minimize Window'));
  assert(/if \(matchShortcut\(e, config\.shortcuts && config\.shortcuts\.toggleFullscreen\)\) \{\s*e\.preventDefault\(\);\s*if \(!e\.repeat\) toggleFullscreen\(\);/.test(handler),
    'the configured key toggles full screen, and holding it does not flip the window back and forth');
  assert(/matchShortcut\(e, config\.shortcuts && config\.shortcuts\.toggleMaximize\)\) \{\s*e\.preventDefault\(\);\s*if \(window\.backend && window\.backend\.toggleMaximize\) window\.backend\.toggleMaximize\(\);/.test(handler),
    'maximize / restore is only the configured key');
  assert(!/'F11'/.test(handler), 'F11 is not hard-wired: it is the default of the configurable key');
  assert(/\{ key: 'toggleFullscreen', labelKey: 'shortcutActionToggleFullscreen' \}/.test(appJs), 'the shortcut list has a row for it');
  assert(!/RESERVED_SYSTEM_SHORTCUTS_WIN = \[[^\]]*'F11'/.test(appJs), 'F11 is an ordinary key again (rebindable, no longer reserved)');

  const toggle = extractFn(appJs, 'function toggleFullscreen()');
  assert(/window\.backend\.toggleFullscreen\(\)/.test(toggle) && /requestFullscreen/.test(toggle), 'native first, the browser API as the fallback');
  console.log('PASS: defaults, key handling, settings row.');
}

// ---- 3. the migration ------------------------------------------------------------------------
{
  const normalize = new Function(`${extractFn(appJs, 'function normalizeComboForCompare(')}; return normalizeComboForCompare;`)();
  const run = (isMac, shortcuts) => {
    const defaults = isMac ? { toggleFullscreen: 'Ctrl+Cmd+F', toggleMaximize: '' } : { toggleFullscreen: 'F11', toggleMaximize: '' };
    const config = { shortcuts: Object.assign({}, defaults, shortcuts) };
    const body = `${extractFn(appJs, 'function migrateFullscreenShortcut()')}; migrateFullscreenShortcut(); return dirty;`;
    const dirty = new Function('config', 'isMac', 'DEFAULT_SHORTCUTS', 'normalizeComboForCompare', 'shortcutMigrationDirty', `let dirty = false; const setDirty = () => { dirty = true; };
      ${body.replace('shortcutMigrationDirty = true;', 'setDirty();')}`)(config, isMac, defaults, normalize, false);
    return { config, dirty };
  };
  let r = run(false, { toggleMaximize: 'F11' });
  assert.strictEqual(r.config.shortcuts.toggleMaximize, '', 'the old default frees maximize');
  assert.strictEqual(r.config.shortcuts.toggleFullscreen, 'F11');
  assert.strictEqual(r.dirty, true, 'and the config is saved once');
  r = run(false, { toggleMaximize: 'Ctrl+F5' });
  assert.strictEqual(r.config.shortcuts.toggleMaximize, 'Ctrl+F5', 'a key the user chose for maximize stays');
  assert.strictEqual(r.config.shortcuts.toggleFullscreen, 'F11', 'and full screen still gets its default');
  assert.strictEqual(r.dirty, false);
  r = run(false, { toggleMaximize: 'f11', toggleFullscreen: 'Ctrl+F12' });
  assert.strictEqual(r.config.shortcuts.toggleFullscreen, 'Ctrl+F12', 'an existing full screen key is not overwritten');
  assert.strictEqual(r.config.shortcuts.toggleMaximize, '');
  r = run(true, { toggleMaximize: 'Ctrl+Cmd+F' });
  assert.strictEqual(r.config.shortcuts.toggleMaximize, '', 'macOS: the same');
  assert.strictEqual(r.config.shortcuts.toggleFullscreen, 'Ctrl+Cmd+F');
  r = run(false, { toggleMaximize: '' });
  assert.strictEqual(r.dirty, false, 'nothing to migrate when maximize is already free');
  assert([...appJs.matchAll(/migrateMacShortcuts\((?:true|false)\);\s*migrateFullscreenShortcut\(\);/g)].length === 3, 'it runs wherever the other shortcut migrations run (after the macOS one)');
  console.log('PASS: the old F11 = maximize binding moves to full screen, other choices stay.');
}

// ---- 4. "the page fills the screen" ----------------------------------------------------------
{
  const isFullscreenNow = (win, scr, doc) => new Function('window', 'screen', 'document', `${extractFn(appJs, 'function isFullscreenNow()')}; return isFullscreenNow();`)(win, scr, doc);
  const scr = { width: 1920, height: 1080 };
  assert.strictEqual(isFullscreenNow({ innerWidth: 1920, innerHeight: 1080 }, scr, {}), true, 'the page is as big as the screen');
  assert.strictEqual(isFullscreenNow({ innerWidth: 1920, innerHeight: 1009 }, scr, {}), false, 'a maximized window leaves room for the title bar and the taskbar');
  assert.strictEqual(isFullscreenNow({ innerWidth: 1050, innerHeight: 720 }, scr, {}), false, 'a normal window');
  assert.strictEqual(isFullscreenNow({ innerWidth: 800, innerHeight: 600 }, scr, { fullscreenElement: {} }), true, 'the browser API counts too');
  assert(/window\.addEventListener\('resize', syncFullscreenState\)/.test(appJs), 'the state follows the window size');
  console.log('PASS: full screen is recognised by the page filling the screen.');
}

// ---- 5. header buttons and texts -------------------------------------------------------------
{
  for (const id of ['btn-zen', 'btn-fullscreen']) {
    const m = new RegExp(`<button id="${id}" class="btn-header-icon" data-i18n-title="[A-Za-z]+"[^>]*>\\s*<svg[\\s\\S]*?</svg>\\s*</button>`).exec(indexHtml);
    assert(m, `${id} is a header icon button with an SVG`);
    assert(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(m[0]), `${id}: a line drawing, no emoji`);
  }
  assert(/btnZen\.onclick = \(\) => \{ toggleZenMode\(\); refocusEditor\(\); \}/.test(appJs) && /btnFullscreen\.onclick = \(\) => \{ toggleFullscreen\(\); refocusEditor\(\); \}/.test(appJs), 'the buttons do what the keys do and hand the focus back');
  assert(/btnFullscreen\.title = titleWithKey\(t\('fullscreenTitle'\), 'toggleFullscreen'\)/.test(appJs) && /btnZen\.title = titleWithKey\(t\('zenToggleTitle'\), 'zenMode'\)/.test(appJs), 'the tooltips carry the configured keys');
  assert(/id: 'cmd_toggle_fullscreen'/.test(appJs), 'the command palette lists it');

  const vm = await import('node:vm');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(i18nJs + '; this.I18N = I18N;', ctx);
  for (const lang of ['en', 'ja']) {
    for (const key of ['shortcutActionToggleFullscreen', 'shortcutActionToggleMaximize', 'zenToggleTitle', 'fullscreenTitle', 'cmdPaletteToggleFullscreen', 'cmdPaletteToggleFullscreenDesc']) {
      assert(ctx.I18N[lang][key] && ctx.I18N[lang][key].length > 3, `${lang}.${key} exists`);
    }
    assert(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(ctx.I18N[lang].fullscreenTitle + ctx.I18N[lang].zenToggleTitle), `${lang}: no emoji in the button titles`);
  }
  assert(/\(F11\)/.test(ctx.I18N.en.fullscreenTitle) && /\(F11\)/.test(ctx.I18N.ja.fullscreenTitle), 'the default key is in the title (replaced by the configured one at run time)');
  console.log('PASS: header buttons, palette entry and texts.');
}

console.log('All fullscreen wiring tests passed.');
