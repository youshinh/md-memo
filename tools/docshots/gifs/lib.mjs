// Shared pieces for the demo GIF recorder: the isolated harness page, human-looking input, the key-cap
// overlay and the frame recorder. Nothing here starts md-memo.exe or reads the real config, agents or notes:
// the page is the frontend served by tools/docshots/server.mjs with the mock backend (tools/docshots/mock/backend.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { launchEdge, shutdownEdge, leftoverProcesses, Page, sleep } from '../cdp.mjs';

export { sleep };

export const VIEWPORT = [1120, 720];

// ---- harness -------------------------------------------------------------------------------------------
// One isolated Edge window (own temporary profile) on a local static server. Returns helpers to (re)load the
// demo page in a language and to shut everything down (only the browser this run started).
export async function launchHarness({ lang = 'en' } = {}) {
  const title = 'DOCSHOT-' + Math.random().toString(16).slice(2, 6);
  const { server, port } = await startServer({ title });
  const base = `http://127.0.0.1:${port}`;
  let edge = null;
  let page = null;
  try {
    edge = await launchEdge({ url: `${base}/?lang=${lang}`, width: VIEWPORT[0] + 16, height: VIEWPORT[1] + 39 });
    page = await Page.attach(edge.debugPort, title);
  } catch (err) {
    if (page) page.close();
    if (edge) await shutdownEdge(edge);
    server.close();
    throw err;
  }
  const h = {
    page, edge, base, title, lang,
    async load() {
      await page.setInnerSize(VIEWPORT[0], VIEWPORT[1]);
      await page.navigate(`${base}/?lang=${lang}`);
      await page.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 30000, label: 'demo page ready' });
      await sleep(300);
    },
    async close() {
      page.close();
      await shutdownEdge(edge);
      server.close();
      const left = leftoverProcesses(edge);
      return { left, profileGone: !fs.existsSync(edge.profileDir), pid: edge.pid };
    },
  };
  return h;
}

// ---- human-looking input -------------------------------------------------------------------------------
// Deterministic pseudo random numbers (so a re-record types with the same rhythm).
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
const CODES = { ' ': ['Space', 32], '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192] };

function charKey(c) {
  const isUpper = c >= 'A' && c <= 'Z';
  const base = SHIFTED[c] || c;
  const shift = isUpper || Object.prototype.hasOwnProperty.call(SHIFTED, c);
  let code, vk;
  if (/^[a-zA-Z]$/.test(base)) { code = 'Key' + base.toUpperCase(); vk = base.toUpperCase().charCodeAt(0); }
  else if (/^[0-9]$/.test(base)) { code = 'Digit' + base; vk = base.charCodeAt(0); }
  else if (CODES[base]) { code = CODES[base][0]; vk = CODES[base][1]; }
  else { code = ''; vk = 0; }
  return { key: c, code, vk, shift, base };
}

const NAMED = {
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
};

export class Human {
  constructor(page, { seed = 7, minMs = 45, maxMs = 80 } = {}) {
    this.page = page;
    this.rng = makeRng(seed);
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.keycap = null; // set by the recorder: (label) => Promise
  }

  jitter() { return this.minMs + this.rng() * (this.maxMs - this.minMs); }

  // One printable character as a real key event (keyDown with text -> keypress/beforeinput/input, then keyUp).
  async char(c) {
    const p = this.page.cdp;
    if (c === '\n') {
      const info = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 0, ...info, text: '\r', unmodifiedText: '\r' });
      await p.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...info });
      return;
    }
    const k = charKey(c);
    const base = { modifiers: k.shift ? 8 : 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: c, unmodifiedText: k.base });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  // Types text one key at a time, 45-80 ms apart (a scenario can narrow that), a little slower after punctuation and
  // line breaks. extra:false leaves those longer pauses out (a fast typist finishing a block without stopping).
  async type(text, { extra = true } = {}) {
    for (const c of Array.from(text)) {
      await this.char(c);
      let d = this.jitter();
      if (extra) {
        if (c === '\n') d += 90 + this.rng() * 60;
        else if (c === '.' || c === ',' || c === ':' || c === ';') d += 40 + this.rng() * 50;
      }
      await sleep(d);
    }
  }

  // A shortcut or a single key as a real key event with modifiers. label: what the key-cap pill shows (none = no pill).
  async press(name, mods = {}, label = null) {
    if (label && this.keycap) {
      await this.keycap(label);
      await sleep(70); // the pill is drawn a moment before the key takes effect, as a viewer would read it
    }
    await this.key(name, mods);
  }

  // Key down + key up. Plain printable keys carry their text (so they type); with Ctrl or Alt they do not (a shortcut).
  async key(name, mods = {}) {
    let info;
    if (NAMED[name]) info = NAMED[name];
    else if (name.length === 1) {
      const k = charKey(mods.shift ? name.toUpperCase() : name);
      info = { key: k.key, code: k.code, vk: k.vk };
    } else throw new Error('unsupported key: ' + name);
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const base = { modifiers, key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk };
    const printable = !mods.ctrl && !mods.alt && (info.text || info.key.length === 1);
    const text = printable ? (info.text || info.key) : undefined;
    const p = this.page.cdp;
    await p.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async pause(ms) { await sleep(ms); }
}

// ---- English-only cosmetics (recording only) ----------------------------------------------------------
// A few strings of the application are Japanese even in the English UI (hard-coded, not in the language tables):
// the task panel's "clear history" button and its elapsed time ("2秒"), and the running line of the Quick Actions panel.
// The GIFs must be English only, so the recording page rewrites exactly these strings as they appear. Nothing else is
// touched; remove this once the application localises them. (The report of the recording run lists them.)
const COSMETICS_JS = `(function () {
  if (window.__cosmetics) return;
  var ROOTS = '#running-tasks-panel, #jev-action-panel';
  var RULES = [[/(\\d+)分(\\d+)秒/g, '$1m $2s'], [/(\\d+)秒/g, '$1s'], [/実行中:/g, 'Running:'], [/エラー:/g, 'Error:'], [/^\\s*クリア\\s*$/g, 'Clear']];
  var busy = false;
  function fix(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) {
      var t = n.nodeValue, u = t;
      for (var i = 0; i < RULES.length; i++) u = u.replace(RULES[i][0], RULES[i][1]);
      if (u !== t) n.nodeValue = u;
    }
  }
  function run() {
    if (busy) return;
    busy = true;
    try { document.querySelectorAll(ROOTS).forEach(fix); } finally { busy = false; }
  }
  new MutationObserver(run).observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__cosmetics = { run: run };
  run();
})()`;

export async function installCosmetics(page) {
  await page.eval(COSMETICS_JS);
}

// Recorder-only style tweaks (for example a larger task panel so its small text survives the scale-down to 860 px).
export async function addStyle(page, id, css) {
  await page.eval(`(function(){var s=document.getElementById(${JSON.stringify(id)});if(!s){s=document.createElement('style');s.id=${JSON.stringify(id)};document.head.appendChild(s);}s.textContent=${JSON.stringify(css)};})()`);
}

// ---- key-cap overlay (recording only) ------------------------------------------------------------------
// A small dark pill that names the shortcut being pressed. It lives only in the recorder's page (injected here,
// never in frontend/), uses no images and takes no input.
const KEYCAP_JS = `(function () {
  if (window.__kc) return;
  var st = document.createElement('style');
  st.id = '__kc_style';
  st.textContent = '#__kc{position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:2147483647;pointer-events:none;' +
    'display:none;background:#2b2b2b;color:#f2f2f2;border:1px solid #555;border-radius:8px;padding:5px 14px;' +
    'font:600 13px/18px "Segoe UI",system-ui,-apple-system,sans-serif;letter-spacing:.2px;white-space:nowrap;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35)}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = '__kc';
  document.body.appendChild(el);
  var timer = null;
  window.__kc = {
    // rect = the recorded area in viewport pixels: the pill sits at its bottom centre.
    place: function (rect) {
      el.style.left = (rect.x + rect.w * (rect.fx || 0.5)) + 'px';
      el.style.top = (rect.y + rect.h - (rect.by || 44)) + 'px';
    },
    show: function (label, ms) {
      el.textContent = label;
      el.style.display = 'block';
      clearTimeout(timer);
      timer = setTimeout(function () { el.style.display = 'none'; }, ms || 800);
    },
    hide: function () { clearTimeout(timer); el.style.display = 'none'; }
  };
})()`;

export async function installKeycap(page, rect, fx = 0.5, by = 44) {
  await page.eval(KEYCAP_JS);
  await page.eval(`window.__kc.place(${JSON.stringify({ x: rect[0], y: rect[1], w: rect[2], h: rect[3], fx, by })})`);
}

export function keycapFn(page, holdMs = 800) {
  return (label) => page.eval(`window.__kc.show(${JSON.stringify(label)}, ${holdMs})`);
}

// ---- frame recorder ------------------------------------------------------------------------------------
// Page.startScreencast (PNG, acknowledged frame by frame) with a compositor timestamp per frame, or a timed
// Page.captureScreenshot loop (mode 'shots'). Frames go to disk as they arrive; frames.json lists them.
export class Recorder {
  constructor(page, dir, { mode = 'screencast', viewport = VIEWPORT } = {}) {
    this.page = page;
    this.dir = dir;
    this.mode = mode;
    this.viewport = viewport;
    this.frames = [];
    this.running = false;
    this.t0 = 0;
    this.pending = [];
    this.events = [];
    this.loop = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  async start() {
    const cdp = this.page.cdp;
    this.running = true;
    this.t0 = performance.now();
    if (this.mode === 'screencast') {
      this.handler = (p) => {
        const now = performance.now();
        const ts = p.metadata && p.metadata.timestamp ? p.metadata.timestamp * 1000 : null;
        if (this.epoch === undefined && ts !== null) this.epoch = ts - (now - this.t0);
        // The compositor timestamp is the truer time; fall back to the arrival time.
        let t = ts !== null && this.epoch !== undefined ? ts - this.epoch : now - this.t0;
        if (t < 0) t = 0;
        const idx = this.frames.length;
        const file = `f${String(idx).padStart(5, '0')}.png`;
        this.frames.push({ t: Math.round(t), file });
        const buf = Buffer.from(p.data, 'base64');
        this.pending.push(fs.promises.writeFile(path.join(this.dir, file), buf));
        cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      };
      cdp.listeners.set('Page.screencastFrame', [...(cdp.listeners.get('Page.screencastFrame') || []), this.handler]);
      await cdp.send('Page.startScreencast', { format: 'png', maxWidth: this.viewport[0], maxHeight: this.viewport[1], everyNthFrame: 1 });
      // A still page sends nothing: make sure the state at the start is in the clip.
      await sleep(120);
      if (this.frames.length === 0) await this.snap();
    } else {
      this.loop = (async () => {
        while (this.running) {
          await this.snap();
        }
      })();
    }
  }

  async snap() {
    const t = Math.round(performance.now() - this.t0);
    const buf = await this.page.screenshot();
    const idx = this.frames.length;
    const file = `f${String(idx).padStart(5, '0')}.png`;
    this.frames.push({ t, file });
    this.pending.push(fs.promises.writeFile(path.join(this.dir, file), buf));
  }

  now() { return Math.round(performance.now() - this.t0); }

  // A key-cap label shown at this moment (used by assemble.py --preview to pick frames worth looking at).
  mark(label) { if (this.running) this.events.push({ t: this.now(), label }); }

  async stop() {
    const endMs = this.now();
    this.running = false;
    if (this.mode === 'screencast') {
      try { await this.page.cdp.send('Page.stopScreencast'); } catch { /* page gone */ }
      const arr = this.page.cdp.listeners.get('Page.screencastFrame') || [];
      this.page.cdp.listeners.set('Page.screencastFrame', arr.filter((f) => f !== this.handler));
      // The final state: one more frame, in case the last change was not repainted before the stop.
      await this.snap();
    } else if (this.loop) {
      await this.loop;
    }
    await Promise.all(this.pending);
    this.frames.sort((a, b) => a.t - b.t);
    const meta = { end: endMs, frames: this.frames, events: this.events };
    fs.writeFileSync(path.join(this.dir, 'frames.json'), JSON.stringify(meta));
    return meta;
  }
}

export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---- clipboard card (recording only) -------------------------------------------------------------------
// The clipboard cannot be seen in a recording. This card (same look as the key-cap pill) shows what a scenario has put
// "on the clipboard": the picture in window.__gifClip.url with a file-name label. It sits at the top right of the recorded
// area, takes no input and exists only in the recording page.
const CLIPBOARD_CARD_JS = `(function (rect) {
  if (window.__gifCard) return;
  var st = document.createElement('style');
  st.id = '__gifcard_style';
  st.textContent = '#__gifcard{position:fixed;z-index:2147483647;pointer-events:none;display:none;background:#2b2b2b;color:#f2f2f2;' +
    'border:1px solid #555;border-radius:8px;padding:8px 8px 6px;box-shadow:0 2px 8px rgba(0,0,0,.35);' +
    'font:600 13px/18px "Segoe UI",system-ui,-apple-system,sans-serif;letter-spacing:.2px}' +
    '#__gifcard img{display:block;width:290px;border-radius:4px;background:#fff}' +
    '#__gifcard div{margin-top:6px;padding-left:2px;white-space:nowrap}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = '__gifcard';
  el.style.top = (rect.y + 12) + 'px';
  el.style.right = (innerWidth - (rect.x + rect.w) + 16) + 'px';
  document.body.appendChild(el);
  window.__gifCard = {
    show: function () {
      el.innerHTML = '';
      var img = document.createElement('img');
      img.src = window.__gifClip.url;
      var label = document.createElement('div');
      label.textContent = 'Clipboard: screenshot.png';
      el.appendChild(img);
      el.appendChild(label);
      el.style.display = 'block';
    },
    hide: function () { el.style.display = 'none'; }
  };
})`;

export async function installClipboardCard(page, crop) {
  await page.eval(`${CLIPBOARD_CARD_JS}(${JSON.stringify({ x: crop[0], y: crop[1], w: crop[2], h: crop[3] })})`);
}

// ---- caption pill (recording only) ---------------------------------------------------------------------
// A short caption for a whole stretch of a clip, in the same family as the key-cap pill, at the top centre of the recorded
// area: window.__gifCaption.show(text) / hide(). It exists only in the recording page and takes no input.
const CAPTION_JS = `(function (rect) {
  if (window.__gifCaption) return;
  var st = document.createElement('style');
  st.id = '__gifcap_style';
  st.textContent = '#__gifcap{position:fixed;transform:translateX(-50%);z-index:2147483647;pointer-events:none;display:none;' +
    'background:#2b2b2b;color:#f2f2f2;border:1px solid #555;border-radius:8px;padding:5px 14px;' +
    'font:600 13px/18px "Segoe UI",system-ui,-apple-system,sans-serif;letter-spacing:.2px;white-space:nowrap;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.35)}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = '__gifcap';
  el.style.left = (rect.x + rect.w / 2) + 'px';
  el.style.top = (rect.y + 8) + 'px';
  document.body.appendChild(el);
  window.__gifCaption = {
    show: function (text) { el.textContent = text; el.style.display = 'block'; },
    hide: function () { el.style.display = 'none'; }
  };
})`;

export async function installCaption(page, crop) {
  await page.eval(`${CAPTION_JS}(${JSON.stringify({ x: crop[0], y: crop[1], w: crop[2], h: crop[3] })})`);
}
