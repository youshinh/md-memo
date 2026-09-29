// Exploration kit: drives the REAL frontend/ (served by tools/docshots/server.mjs, with the docshots mock backend) in a
// HEADLESS Edge that this run starts and stops itself, so a person or an agent can explore the app without a window, without
// the real config / notes / clipboard, and many sessions at once. See tools/explore/README.md.
//
//   import { startExplore } from './tools/explore/kit.mjs';
//   const s = await startExplore({ lang: 'en', llm: { mode: 'fail' } });
//   await s.key('l', { ctrl: true });
//   console.log((await s.state()).panels);
//   await s.close();
//
// Safety: input goes through CDP only; Ctrl/Cmd+C/X/V and Shift+Insert run against a FAKE clipboard (never the OS one); every
// request that leaves the local server is blocked by the mock; the browser is killed by its own process id (and its unique
// profile folder), never by image name.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../docshots/server.mjs';
import { CDP, findEdge, Page, shutdownEdge, sleep } from '../docshots/cdp.mjs';

export { sleep };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_SOURCE = fs.readFileSync(path.join(HERE, 'page_hooks.js'), 'utf8');

// ---- keys ----------------------------------------------------------------------------------------------
const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
for (let i = 1; i <= 12; i++) NAMED['F' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };
const ALIASES = { Esc: 'Escape', Return: 'Enter', Space: ' ', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', PgUp: 'PageUp', PgDn: 'PageDown' };

const SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
const SHIFT_OF = Object.fromEntries(Object.entries(SHIFTED).map(([shifted, base]) => [base, shifted]));
const CODES = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192] };

function modifierBits(m) { return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0); }

// The two Input.dispatchKeyEvent parameter objects (down, up) for a key name and modifiers. Pure: no browser needed.
//   name: 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowDown', 'F5', ' ', a single character, or an alias (Esc, Return, Space...)
export function keyEvents(name, mods = {}) {
  const wanted = ALIASES[name] || name;
  let base;
  let printable = null; // the text a plain press types
  let shift = !!mods.shift;
  if (NAMED[wanted]) {
    const n = NAMED[wanted];
    base = { key: n.key, code: n.code, vk: n.vk };
    printable = n.text || null;
  } else if (typeof wanted === 'string' && Array.from(wanted).length === 1) {
    const isLetter = /^[a-zA-Z]$/.test(wanted);
    const shiftedSymbol = Object.prototype.hasOwnProperty.call(SHIFTED, wanted);
    shift = shift || (isLetter && wanted !== wanted.toLowerCase()) || shiftedSymbol;
    let key = wanted;
    if (isLetter) key = shift ? wanted.toUpperCase() : wanted.toLowerCase();
    else if (mods.shift && !shiftedSymbol && SHIFT_OF[wanted]) key = SHIFT_OF[wanted];
    const lookup = SHIFTED[key] || key;
    let code = '';
    let vk = 0;
    if (/^[a-zA-Z]$/.test(lookup)) { code = 'Key' + lookup.toUpperCase(); vk = lookup.toUpperCase().charCodeAt(0); }
    else if (/^[0-9]$/.test(lookup)) { code = 'Digit' + lookup; vk = lookup.charCodeAt(0); }
    else if (CODES[lookup]) { code = CODES[lookup][0]; vk = CODES[lookup][1]; }
    base = { key, code, vk };
    printable = key;
  } else {
    throw new Error('unsupported key: ' + JSON.stringify(name));
  }
  const modifiers = modifierBits({ ...mods, shift });
  const common = { modifiers, key: base.key, code: base.code, windowsVirtualKeyCode: base.vk, nativeVirtualKeyCode: base.vk };
  const text = !mods.ctrl && !mods.alt && !mods.meta ? printable : null;
  const down = text ? { type: 'keyDown', ...common, text, unmodifiedText: text } : { type: 'rawKeyDown', ...common };
  return [down, { type: 'keyUp', ...common }];
}

// Which clipboard action a shortcut is (or null). These never reach the browser: they run against the fake clipboard.
export function clipboardAction(name, mods = {}) {
  const k = String(name).length === 1 ? String(name).toLowerCase() : (ALIASES[name] || name);
  const mod = !!(mods.ctrl || mods.meta);
  if (mod && !mods.alt && (k === 'v' || k === 'c' || k === 'x')) return k === 'v' ? 'paste' : (k === 'c' ? 'copy' : 'cut');
  if (k === 'Insert' && mods.shift && !mod) return 'paste';
  if (k === 'Insert' && mod) return 'copy';
  if (k === 'Delete' && mods.shift && !mod) return 'cut';
  return null;
}

const isAsciiPrintable = (ch) => ch.length === 1 && ch >= ' ' && ch <= '~';

// ---- browser --------------------------------------------------------------------------------------------
const live = new Set();
let exitHooked = false;

function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
}

// Last resort when the browser's own pid is unknown: stop the processes whose command line carries this run's unique profile folder.
function sweepByProfile(profileDir) {
  const marker = path.basename(profileDir);
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' }); } catch { /* nothing left */ }
}

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const sweep = () => {
    for (const s of live) {
      const b = s._browser;
      if (b.pid) killTree(b.pid);
      else sweepByProfile(b.profileDir);
      try { fs.rmSync(b.profileDir, { recursive: true, force: true }); } catch { /* locked: the OS temp folder gets it */ }
    }
  };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sweep(); process.exit(130); });
}

// Edge's launcher process exits right after it has started the real browser, so the pid that spawn() returns is useless for
// stopping it. The real browser process id comes from the browser itself (SystemInfo.getProcessInfo over its DevTools socket).
async function launchHeadless({ width, height }) {
  const edge = findEdge();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-profile-'));
  const args = [
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-translate',
    '--disable-features=CalculateNativeWinOcclusion,Translate,msEdgeSync,msEdgeShopping',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--hide-crash-restore-bubble',
    '--lang=en-US',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const child = spawn(edge, args, { stdio: 'ignore', windowsHide: true });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  const handle = { edge, args, launcherPid: child.pid, pid: null, profileDir, debugPort: null, browserCdp: null };
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  let browserPath = '';
  for (let i = 0; i < 200 && !spawnError; i++) {
    if (fs.existsSync(portFile)) {
      const [portLine, pathLine] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (portLine && pathLine) { handle.debugPort = Number(portLine); browserPath = pathLine.trim(); break; }
    }
    await sleep(100);
  }
  try {
    if (!handle.debugPort) throw new Error('headless Edge did not open its DevTools port' + (spawnError ? ': ' + spawnError.message : ''));
    handle.browserCdp = await CDP.connect(`ws://127.0.0.1:${handle.debugPort}${browserPath}`);
    const info = await handle.browserCdp.send('SystemInfo.getProcessInfo');
    const main = (info.processInfo || []).find((p) => p.type === 'browser');
    handle.pid = main ? main.id : null;
  } catch (err) {
    await stopBrowser(handle);
    throw err;
  }
  return handle;
}

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Stops only the browser this run started: a graceful Browser.close, then its process tree by pid, then (only if the profile
// folder is still locked) anything still carrying the unique profile folder name. Removes the profile folder.
async function stopBrowser(handle) {
  if (handle.browserCdp) {
    try { await Promise.race([handle.browserCdp.send('Browser.close'), sleep(1500)]); } catch { /* already closing */ }
    handle.browserCdp.close();
  }
  for (let i = 0; i < 20 && pidAlive(handle.pid); i++) await sleep(100);
  if (pidAlive(handle.pid)) killTree(handle.pid);
  for (let i = 0; i < 30; i++) {
    try { fs.rmSync(handle.profileDir, { recursive: true, force: true }); } catch { /* still locked */ }
    if (!fs.existsSync(handle.profileDir)) break;
    await sleep(150);
  }
  if (fs.existsSync(handle.profileDir)) await shutdownEdge(handle);
  return { processGone: !pidAlive(handle.pid), profileGone: !fs.existsSync(handle.profileDir) };
}

// ---- the session -----------------------------------------------------------------------------------------
function formatConsoleArgs(args) {
  return (args || []).map((a) => {
    if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
    return a.description || a.type;
  }).join(' ');
}

// opts: { lang: 'en' | 'ja', notes: [{ title, content, path?, cursor? }], config: {deep overrides of the mocked config},
//         viewport: { w, h }, llm: { mode, ... }, backend: { ...same as s.setBackend }, fresh: true (a first launch: nothing saved yet) }
export async function startExplore(opts = {}) {
  const lang = opts.lang === 'ja' ? 'ja' : 'en';
  const viewport = { w: 1120, h: 720, ...(opts.viewport || {}) };
  const title = 'EXPLORE-' + Math.random().toString(16).slice(2, 8);
  const { server, port } = await startServer({ title });
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  let page = null;
  try {
    browser = await launchHeadless({ width: viewport.w, height: viewport.h });
    page = await Page.attach(browser.debugPort, 'about:blank');
  } catch (err) {
    if (page) page.close();
    if (browser) await stopBrowser(browser);
    server.closeAllConnections?.();
    server.close();
    throw err;
  }

  const cdp = page.cdp;
  const consoleErrors = [];
  const consoleWarnings = [];
  const on = (method, cb) => cdp.listeners.set(method, [...(cdp.listeners.get(method) || []), cb]);
  const isNoise = (text) => /favicon/i.test(text);
  on('Runtime.consoleAPICalled', (p) => {
    const text = formatConsoleArgs(p.args);
    if (p.type === 'error' && !isNoise(text)) consoleErrors.push(text);
    else if (p.type === 'warning') consoleWarnings.push(text);
  });
  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    consoleErrors.push('Uncaught: ' + ((d.exception && d.exception.description) || d.text || 'exception'));
  });
  on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    const text = `${e.source || 'log'}: ${e.text || ''}${e.url ? ' (' + e.url + ')' : ''}`;
    if (e.level === 'error' && !isNoise(text)) consoleErrors.push(text);
  });

  const s = { lang, viewport, title, base, page, _browser: browser };
  let closed = null;

  s.close = async function close() {
    if (closed) return closed;
    closed = (async () => {
      live.delete(s);
      try { page.close(); } catch { /* closed */ }
      const res = await stopBrowser(browser);
      server.closeAllConnections?.();
      server.close();
      return res;
    })();
    return closed;
  };

  try {
    live.add(s);
    hookExit();
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: false });
    // A first launch has no restored notes: the app opens its own new note (unless the caller brings notes).
    const init = { notes: opts.notes !== undefined ? opts.notes : (opts.fresh ? [] : undefined), config: opts.config, llm: opts.llm };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__EXPLORE_INIT = ${JSON.stringify(init)};\n${HOOKS_SOURCE}` });
    await page.navigate(`${base}/?lang=${lang}${opts.fresh ? '&fresh=1' : ''}`);
    await page.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 30000, label: 'the app to be ready' });
    if (!(await page.eval('!!(window.backend && window.backend.__exploreWrapped && window.__explore)'))) {
      throw new Error('the exploration hooks are not active: did tools/docshots/mock/backend.js change how it installs window.backend or __DOCSHOT_BOOT?');
    }
    if (opts.backend) await page.eval(`window.__explore.setBackend(${JSON.stringify(opts.backend)})`);
    await page.eval('window.__explore.reset()'); // records start here
  } catch (err) {
    await s.close();
    throw err;
  }

  // ---- driving ---------------------------------------------------------------------------------------------
  // s.key('l', { ctrl: true }) / s.key('Enter') / s.key('F5'): a real key event through CDP.
  s.key = async function key(name, mods = {}) {
    const action = clipboardAction(name, mods);
    if (action) return page.eval(`window.__explore.clipKey(${JSON.stringify(action)}, ${JSON.stringify(mods)})`);
    const [down, up] = keyEvents(name, mods);
    await cdp.send('Input.dispatchKeyEvent', down);
    await cdp.send('Input.dispatchKeyEvent', up);
    return undefined;
  };

  // s.type('text', { delayMs }): one key event per character (keydown -> input -> keyup), as typing does. Newline is Enter, tab is
  // Tab; a character with no key on a US keyboard (Japanese, emoji) is inserted as text. { insert: true } inserts the whole text at once.
  s.type = async function type(text, { delayMs = 0, insert = false } = {}) {
    const clean = String(text).replace(/\r\n?/g, '\n');
    if (insert) { await cdp.send('Input.insertText', { text: clean }); return; }
    for (const ch of Array.from(clean)) {
      if (ch === '\n') await s.key('Enter');
      else if (ch === '\t') await s.key('Tab');
      else if (isAsciiPrintable(ch)) await s.key(ch);
      else await cdp.send('Input.insertText', { text: ch });
      if (delayMs) await sleep(delayMs);
    }
  };

  // s.ev('expression'): evaluates in the page (awaits a promise) and returns the value.
  s.ev = (expr) => page.eval(expr);

  // s.waitFor('condition', { timeout }): polls until the expression is truthy. On a time-out the error says what the page showed.
  s.waitFor = async function waitFor(cond, { timeout = 8000, interval = 50 } = {}) {
    try {
      return await page.waitFor(cond, { timeout, interval });
    } catch (err) {
      let where = '';
      try {
        const st = await page.eval('window.__explore.state()');
        const open = Object.keys(st.panels).filter((k) => st.panels[k]);
        where = ` | status: ${JSON.stringify(st.statusText)}, toasts: ${JSON.stringify(st.toasts.slice(-3))}, open panels: [${open.join(', ')}], pending LLM: ${st.pendingLlm}`;
      } catch { /* page gone */ }
      throw new Error(err.message + where);
    }
  };

  // s.state(): see the README.
  s.state = async function state() {
    const st = await page.eval('window.__explore.state()');
    st.consoleErrors = consoleErrors.slice();
    st.consoleWarnings = consoleWarnings.slice();
    return st;
  };

  s.shot = async function shot(file) {
    const out = path.resolve(file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await page.screenshot());
    return out;
  };

  // s.setLlm({ mode: 'ok' | 'fail' | 'slow' | 'never' | 'double' | 'think' | 'huge' | 'fenced' | 'empty', ... }): replaces the mode.
  s.setLlm = (spec) => page.eval(`window.__explore.setLlm(${JSON.stringify(spec || {})})`);

  // s.setBackend({ saveFile: { fail: 'disk full' }, saveFileAs: null, readOnlyPaths: [...], clipboard: { text, html, image } })
  s.setBackend = (overrides) => page.eval(`window.__explore.setBackend(${JSON.stringify(overrides || {})})`);

  return s;
}
