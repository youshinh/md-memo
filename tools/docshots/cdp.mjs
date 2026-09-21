// Isolated Edge launcher and a minimal Chrome DevTools Protocol client (Node 24: global WebSocket/fetch).
//
// The browser is started with its own temporary --user-data-dir, so it never touches the user's
// browser profile or any running MD-Memo. Input is sent through CDP only (never OS-level keyboard or
// mouse). Paste shortcuts are deliberately NOT sent as real key events: Blink would execute a native
// paste from the real clipboard.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

export function findEdge() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('msedge.exe not found (set EDGE_PATH)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

// ---- launcher -----------------------------------------------------------------------------------
export async function launchEdge({ url, width, height, x = 40, y = 40 }) {
  const edge = findEdge();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docshot-profile-'));
  const args = [
    `--user-data-dir=${profileDir}`,
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
    `--window-position=${x},${y}`,
    `--window-size=${width},${height}`,
    `--app=${url}`,
  ];
  const child = spawn(edge, args, { stdio: 'ignore', windowsHide: false });
  const handle = { edge, args, child, pid: child.pid, profileDir, debugPort: null };

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 120; i++) {
    if (fs.existsSync(portFile)) {
      const lines = fs.readFileSync(portFile, 'utf8').split('\n');
      if (lines[0]) { handle.debugPort = Number(lines[0]); break; }
    }
    await sleep(250);
  }
  if (!handle.debugPort) {
    await shutdownEdge(handle);
    throw new Error('Edge did not open its DevTools port');
  }
  return handle;
}

// Kills only the browser this harness started: its process tree, then anything still carrying its
// unique profile folder name on the command line. Never kills by image name.
export async function shutdownEdge(handle) {
  if (!handle) return;
  try { if (handle.pid) spawnSync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  const marker = path.basename(handle.profileDir);
  try {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  } catch { /* nothing left */ }
  await sleep(800);
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(handle.profileDir, { recursive: true, force: true }); } catch { /* still locked */ }
    if (!fs.existsSync(handle.profileDir)) break;
    await sleep(500);
  }
}

export function leftoverProcesses(handle) {
  const marker = path.basename(handle.profileDir);
  const ps = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'msedge*' -and $_.CommandLine -like '*${marker}*' } | Measure-Object).Count`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return Number((r.stdout || '0').trim()) || 0;
}

// ---- CDP client ---------------------------------------------------------------------------------
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const cb = (p) => {
        const arr = this.listeners.get(method) || [];
        this.listeners.set(method, arr.filter((f) => f !== cb));
        resolve(p);
      };
      this.listeners.set(method, [...(this.listeners.get(method) || []), cb]);
    });
  }

  close() { try { this.ws.close(); } catch { /* closed */ } }
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  End: { key: 'End', code: 'End', vk: 35 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  ',': { key: ',', code: 'Comma', vk: 188 },
  '\\': { key: '\\', code: 'Backslash', vk: 220 },
};

function keyInfo(name) {
  if (KEYS[name]) return KEYS[name];
  if (/^[a-zA-Z]$/.test(name)) return { key: name, code: 'Key' + name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(name)) return { key: name, code: 'Digit' + name, vk: name.charCodeAt(0) };
  throw new Error('unsupported key: ' + name);
}

export class Page {
  constructor(cdp, windowId) {
    this.cdp = cdp;
    this.windowId = windowId;
  }

  static async attach(debugPort, titleToken) {
    let target = null;
    for (let i = 0; i < 80 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && String(t.title).includes(titleToken)) || null;
      } catch { /* not up yet */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('page target not found');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // The window is not the foreground window while it is driven: behave as focused (active selection
    // colour, focus rings, blinking caret) like the real app does when a user works in it.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const w = await cdp.send('Browser.getWindowForTarget');
    return new Page(cdp, w.windowId);
  }

  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page eval failed: ' + ((d.exception && d.exception.description) || d.text) + '\n' + expression.slice(0, 200));
    }
    return r.result.value;
  }

  async navigate(url) {
    const loaded = this.cdp.once('Page.loadEventFired');
    await this.cdp.send('Page.navigate', { url });
    await loaded;
  }

  async setInnerSize(w, h) {
    let cur = await this.eval('({iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight})');
    let width = w + (cur.ow - cur.iw);
    let height = h + (cur.oh - cur.ih);
    for (let i = 0; i < 4; i++) {
      await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal', width, height } });
      await sleep(400);
      cur = await this.eval('({iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight})');
      if (cur.iw === w && cur.ih === h) return cur;
      width += w - cur.iw;
      height += h - cur.ih;
    }
    return cur;
  }

  async setPosition(x, y) {
    await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal', left: x, top: y } });
  }

  // name: 'k', 'Enter', ...; mods: { ctrl, alt, shift }
  async key(name, mods = {}) {
    const info = keyInfo(name);
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const base = { modifiers, key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk };
    const printable = !mods.ctrl && !mods.alt && (info.text || info.key.length === 1);
    const text = printable ? (info.text || (mods.shift ? info.key.toUpperCase() : info.key)) : undefined;
    await this.cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text) {
    await this.cdp.send('Input.insertText', { text });
  }

  async mouseMove(x, y) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  }

  async click(x, y, { button = 'left', clickCount = 1 } = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  }

  async screenshot() {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(r.data, 'base64');
  }

  async waitFor(expression, { timeout = 8000, interval = 100, label = expression } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await this.eval(expression)) return true; } catch { /* page still loading */ }
      await sleep(interval);
    }
    throw new Error('timed out waiting for: ' + label);
  }

  close() { this.cdp.close(); }
}
