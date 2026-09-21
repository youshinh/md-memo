#!/usr/bin/env node
// Documentation screenshot harness for MD-Memo.
//
//   node tools/docshots/run.mjs [--lang ja|en|both] [--only name[,name...]] [--method auto|uwscr|cdp]
//                               [--list] [--no-md] [--keep-profile]
//
// It NEVER starts md-memo.exe and never touches the running MD-Memo: the frontend is served from a
// local static server with a mocked window.backend and demo data, opened in an isolated Edge window
// (own temporary profile), driven through CDP, and photographed with UWSCR (Windows Graphics Capture,
// by window id, found only through the unique title token DOCSHOT-xxxx).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, REPO } from './server.mjs';
import { launchEdge, shutdownEdge, leftoverProcesses, Page, sleep } from './cdp.mjs';
import { SETUPS } from './setups.mjs';
import { writeShotsMd } from './shots_md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UWSCR = process.env.UWSCR_PATH || 'C:\\Users\\yoush\\Documents\\uwscr.exe';
let IMG_ROOT = path.join(REPO, 'img', 'manual');
const SHOTS = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8'));
const STATE_FILE = path.join(os.tmpdir(), 'docshots-edge.json');
const FRONTEND_HTML = fs.readFileSync(path.join(REPO, 'frontend', 'index.html'), 'utf8');
let activeEdge = null;
process.on('SIGINT', async () => {
  if (activeEdge) await shutdownEdge(activeEdge);
  process.exit(130);
});

function parseArgs(argv) {
  const a = { lang: 'both', only: null, method: 'auto', list: false, md: true, keepProfile: false, cleanup: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--cleanup') a.cleanup = true;
    else if (k === '--lang') a.lang = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--method') a.method = argv[++i];
    else if (k === '--list') a.list = true;
    else if (k === '--no-md') a.md = false;
    else if (k === '--keep-profile') a.keepProfile = true;
    else if (k === '--out') a.out = argv[++i];
    else throw new Error('unknown argument: ' + k);
  }
  if (!['ja', 'en', 'both'].includes(a.lang)) throw new Error('--lang must be ja, en or both');
  if (!['auto', 'uwscr', 'cdp'].includes(a.method)) throw new Error('--method must be auto, uwscr or cdp');
  return a;
}

// ---- in-page geometry ---------------------------------------------------------------------------
function targetFn(spec) {
  if (spec.js) return eval(spec.js); // eslint-disable-line no-eval
  var els = document.querySelectorAll(spec.selector);
  var el = els[spec.index || 0];
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

async function rectOf(page, spec) {
  const r = await page.eval(`(${targetFn.toString()})(${JSON.stringify(spec)})`);
  if (!r) throw new Error('target not found: ' + JSON.stringify(spec));
  return r;
}

function anchorPoint(r, at = 'c') {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const map = {
    tl: [r.x, r.y], t: [cx, r.y], tr: [r.x + r.w, r.y],
    l: [r.x, cy], c: [cx, cy], r: [r.x + r.w, cy],
    bl: [r.x, r.y + r.h], b: [cx, r.y + r.h], br: [r.x + r.w, r.y + r.h],
  };
  return map[at] || map.c;
}

async function resolveMarkers(page, shot) {
  const out = [];
  for (const m of shot.markers || []) {
    const r = await rectOf(page, m);
    const [x, y] = anchorPoint(r, m.at);
    out.push({ n: m.n, x: x + (m.dx || 0), y: y + (m.dy || 0) });
  }
  return out;
}

async function resolveCrop(page, shot, viewport) {
  const c = shot.crop;
  if (!c) return null;
  let rect;
  if (c.rect) rect = c.rect;
  else {
    const r = await rectOf(page, c);
    const pad = c.pad || [0, 0, 0, 0];
    rect = [r.x - pad[0], r.y - pad[1], r.w + pad[0] + pad[2], r.h + pad[1] + pad[3]];
  }
  const [vw, vh] = viewport;
  let [x, y, w, h] = rect;
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(vw - x, Math.round(w)); h = Math.min(vh - y, Math.round(h));
  return [x, y, w, h];
}

// ---- capture ------------------------------------------------------------------------------------
function runUwscr({ title, outfile, pid, fore, timeout = 25000 }) {
  const args = [path.join(HERE, 'capture.uws'), title, outfile, String(pid)];
  if (fore) args.push('fore');
  const r = spawnSync(UWSCR, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  const info = {};
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) info[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { code: r.status, info, stderr: (r.stderr || '').trim(), timedOut: r.status === null };
}

// The Windows session that owns the screen: Windows Graphics Capture only delivers frames while it is
// connected (a disconnected Remote Desktop session makes UWSCR's saveimg wait forever).
function sessionState() {
  const r = spawnSync('qwinsta', { encoding: 'utf8' });
  const rows = (r.stdout || '').split(/\r?\n/).slice(1).filter((l) => l.trim());
  const states = rows.map((l) => l.replace(/^>/, ' ').trim().split(/\s+/)).filter((c) => /^(Active|Conn|Disc|Idle)$/.test(c[c.length - 1]) || /^(Active|Conn|Disc|Idle)$/.test(c[c.length - 2] || ''))
    .map((c) => c.filter((x) => /^(Active|Conn|Disc|Idle)$/.test(x))[0]);
  return states.length ? states.join(', ') : 'unknown';
}

function runPost(spec, specPath) {
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const r = spawnSync('python', [path.join(HERE, 'postprocess.py'), specPath], { encoding: 'utf8', timeout: 60000 });
  let res;
  try { res = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { res = { ok: false, error: 'postprocess produced no result: ' + (r.stderr || r.stdout) }; }
  return res;
}

// Windows Graphics Capture only delivers a frame when the window repaints. Most states have a blinking caret, but a
// page without a focused text field (the phone page, a static dialog) would leave saveimg waiting, so a 1x1 px element in
// the top-left corner (opacity 0 -> 0.01 over the background) keeps frames coming while a UWSCR capture is running.
const KEEPALIVE_ON = "(function(){if(document.getElementById('__ds_ka'))return;var s=document.createElement('style');s.id='__ds_ka_s';s.textContent='@keyframes dsKa{from{opacity:0}to{opacity:.01}}#__ds_ka{position:fixed;left:0;top:0;width:1px;height:1px;background:#000;pointer-events:none;z-index:2147483647;animation:dsKa .5s linear infinite alternate}';document.head.appendChild(s);var e=document.createElement('div');e.id='__ds_ka';document.body.appendChild(e);})()";
const KEEPALIVE_OFF = "(function(){['__ds_ka','__ds_ka_s'].forEach(function(i){var e=document.getElementById(i);if(e)e.remove();});})()";

async function captureShot({ page, args, edge, title, shot, lang, viewport, tmp, markers, crop, state }) {
  const outDir = path.join(IMG_ROOT, lang);
  const out = path.join(outDir, shot.name + '.png');
  const refPath = path.join(tmp, `${shot.name}-${lang}-ref.png`);
  const rawPath = path.join(tmp, `${shot.name}-${lang}-raw.png`);
  const specPath = path.join(tmp, `${shot.name}-${lang}-spec.json`);
  const base = {
    viewport, ref: refPath, out, crop, scale: shot.scale || 1, markers,
    marker_diameter: shot.markerDiameter || (crop && Math.min(crop[2], crop[3]) < 260 ? 22 : 26),
  };

  // The app fades its toolbar and status bar for ~3 s after typing; documentation shows the resting look.
  await page.eval("document.body.classList.remove('zen-active')");
  await sleep(500);
  await page.eval('window.__docshot && window.__docshot.freezeClock && window.__docshot.freezeClock()');
  const useUwscr = args.method !== 'cdp' && state.uwscrOk;
  if (useUwscr) { await page.eval(KEEPALIVE_ON); await sleep(250); }
  fs.writeFileSync(refPath, await page.screenshot());

  const attempts = useUwscr ? [{ front: false }, { front: true }] : [];
  const log = [];
  try {
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i].front) { await page.cdp.send('Page.bringToFront'); await sleep(500); fs.writeFileSync(refPath, await page.screenshot()); }
      try { fs.rmSync(rawPath, { force: true }); } catch { /* none */ }
      const u = runUwscr({ title, outfile: rawPath.replace(/\\/g, '/'), pid: edge.pid });
      if (u.code !== 0 || !fs.existsSync(rawPath)) {
        log.push(`attempt ${i + 1}: uwscr ${u.timedOut ? 'timed out' : 'exit ' + u.code} ${u.info.error || u.stderr}`);
        if (u.timedOut) { state.uwscrOk = false; state.reason = 'UWSCR timed out during a capture'; break; }
        continue;
      }
      const res = runPost({ ...base, method: 'uwscr', raw: rawPath }, specPath);
      if (res.ok) return { ...res, method: 'uwscr', uwscr: u.info, attempts: i + 1, log };
      log.push(`attempt ${i + 1}: ${res.error} (diff ${res.diff_mean}/${res.diff_frac})`);
    }
  } finally {
    if (useUwscr) await page.eval(KEEPALIVE_OFF);
  }
  if (useUwscr) { await sleep(150); fs.writeFileSync(refPath, await page.screenshot()); } // clean reference for the fallback

  if (args.method === 'uwscr') return { ok: false, method: 'uwscr', error: 'UWSCR capture failed: ' + log.join(' | '), log };
  const res = runPost({ ...base, method: 'cdp' }, specPath);
  return { ...res, method: args.method === 'cdp' ? 'cdp' : 'cdp-fallback', log };
}

// ---- main ---------------------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cleanup) {
    // After a crashed run: stop the harness browser recorded in the state file (only that process tree).
    if (!fs.existsSync(STATE_FILE)) { console.log('nothing to clean up'); return 0; }
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    await shutdownEdge({ pid: st.pid, profileDir: st.profileDir });
    fs.rmSync(STATE_FILE, { force: true });
    console.log('cleaned up harness browser', st.pid);
    return 0;
  }
  if (args.out) IMG_ROOT = path.resolve(args.out);
  // Shots marked "last" (they depend on a frontend change that may still be landing) run at the end.
  const shots = SHOTS.shots.filter((s) => !args.only || args.only.includes(s.name))
    .sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  if (args.list) {
    for (const s of SHOTS.shots) console.log(s.name.padEnd(22), s.size || 'full', '-', s.description);
    return 0;
  }
  if (args.only) {
    const unknown = args.only.filter((n) => !SHOTS.shots.some((s) => s.name === n));
    if (unknown.length) throw new Error('unknown shot(s): ' + unknown.join(', '));
  }
  const langs = args.lang === 'both' ? ['ja', 'en'] : [args.lang];
  const viewportFull = SHOTS.viewport;

  const title = 'DOCSHOT-' + Math.random().toString(16).slice(2, 6);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docshot-run-'));
  const { server, port } = await startServer({ title });
  const base = `http://127.0.0.1:${port}`;

  let edge = null;
  let page = null;
  const results = [];
  const started = Date.now();
  try {
    edge = await launchEdge({ url: `${base}/?lang=en`, width: viewportFull[0] + 16, height: viewportFull[1] + 39 });
    activeEdge = edge;
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: edge.pid, profileDir: edge.profileDir }));
    page = await Page.attach(edge.debugPort, title);
    console.log(`edge pid ${edge.pid}, debug port ${edge.debugPort}, title token ${title}`);
    console.log('edge command line: ' + `"${edge.edge}" ` + edge.args.map((a) => (a.startsWith('--app=') ? '--app=' + base + '/?lang=<lang>' : a)).join(' '));

    // Is UWSCR usable right now? One probe capture of the freshly loaded page decides for the whole run.
    const state = { uwscrOk: args.method !== 'cdp', reason: '' };
    console.log(`interactive Windows session state: ${sessionState()}`);
    if (state.uwscrOk) {
      await page.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 20000, label: 'demo page ready' });
      const probeRaw = path.join(tmp, 'probe-raw.png');
      await page.eval(KEEPALIVE_ON);
      await sleep(300);
      const u = runUwscr({ title, outfile: probeRaw.replace(/\\/g, '/'), pid: edge.pid, timeout: 20000 });
      await page.eval(KEEPALIVE_OFF);
      if (u.code === 0 && fs.existsSync(probeRaw)) {
        console.log(`UWSCR probe ok: ${u.info.client} client area, window "${u.info.title}", pid ${u.info.pid}`);
      } else {
        state.uwscrOk = false;
        state.reason = u.timedOut ? 'UWSCR saveimg produced no frame within 20 s (the Windows session is disconnected or locked)' : `UWSCR exit ${u.code}: ${u.info.error || u.stderr}`;
        console.log('UWSCR is not usable: ' + state.reason);
        if (args.method === 'uwscr') throw new Error('--method uwscr requested but ' + state.reason);
        console.log('falling back to CDP Page.captureScreenshot for this run');
      }
    }

    for (const lang of langs) {
      for (const shot of shots) {
        const t0 = Date.now();
        const setup = SETUPS[shot.setup || shot.name];
        if (!setup) { results.push({ shot: shot.name, lang, ok: false, error: 'no setup function' }); console.log(`[${lang}] ${shot.name}: no setup`); continue; }
        const viewport = shot.viewport || viewportFull;
        try {
          const q = new URLSearchParams({ lang, ...(shot.boot || {}) });
          const url = shot.page ? `${base}${shot.page}?${q}` : `${base}/?${q}`;
          if (shot.viewport) await page.setInnerSize(viewport[0], viewport[1]);
          else await page.setInnerSize(viewportFull[0], viewportFull[1]);
          await page.navigate(url);
          if (!shot.page) await page.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 20000, label: 'demo page ready' });
          await sleep(200);
          const ctx = makeCtx(page, lang, shot);
          await setup(ctx);
          await sleep(shot.settleMs ?? 350);

          const markers = await resolveMarkers(page, shot);
          const crop = await resolveCrop(page, shot, viewport);
          const res = await captureShot({ page, args, edge, title, shot, lang, viewport, tmp, markers, crop, state });
          const missing = (shot.requires || []).filter((id) => !FRONTEND_HTML.includes(id));
          if (missing.length) {
            res.stale = `the frontend does not contain ${missing.join(', ')} yet (its change had not landed when this picture was taken); re-run this shot: node tools/docshots/run.mjs --only ${shot.name}`;
            console.log(`[${lang}] ${shot.name}: WARNING ${res.stale}`);
          }
          results.push({ shot: shot.name, lang, ...res, seconds: Math.round((Date.now() - t0) / 100) / 10 });
          const flag = res.ok ? 'ok ' : 'FAIL';
          console.log(`[${lang}] ${shot.name.padEnd(20)} ${flag} ${res.method}  ${res.ok ? `${res.size.join('x')} ${(res.bytes / 1024).toFixed(1)}KB diff=${res.diff_mean}` : res.error}`);
        } catch (err) {
          results.push({ shot: shot.name, lang, ok: false, error: String(err && err.message || err) });
          console.log(`[${lang}] ${shot.name.padEnd(20)} FAIL ${err && err.message || err}`);
        }
      }
    }
  } finally {
    if (page) page.close();
    if (edge) await shutdownEdge(edge);
    try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* none */ }
    server.close();
    const left = edge ? leftoverProcesses(edge) : 0;
    console.log(`edge processes left from this run: ${left}; profile folder ${edge && fs.existsSync(edge.profileDir) ? 'STILL PRESENT ' + edge.profileDir : 'deleted'}`);
    if (!args.keepProfile) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  fs.writeFileSync(path.join(os.tmpdir(), 'docshots-last-run.json'), JSON.stringify({ title, results }, null, 2));
  if (args.md) writeShotsMd({ shots: SHOTS, imgRoot: IMG_ROOT, results });
  const failed = results.filter((r) => !r.ok);
  console.log(`done in ${Math.round((Date.now() - started) / 1000)}s: ${results.length - failed.length} ok, ${failed.length} failed`);
  const methods = {};
  for (const r of results) if (r.ok) methods[r.method] = (methods[r.method] || 0) + 1;
  console.log('capture methods: ' + JSON.stringify(methods));
  return failed.length ? 1 : 0;
}

function makeCtx(page, lang, shot) {
  const ja = lang === 'ja';
  return {
    page, lang, ja, shot,
    pick: (en, jp) => (ja ? jp : en),
    ev: (expr) => page.eval(expr),
    key: (k, mods) => page.key(k, mods),
    type: (t) => page.type(t),
    click: (x, y, o) => page.click(x, y, o),
    move: (x, y) => page.mouseMove(x, y),
    sleep,
    waitFor: (expr, o) => page.waitFor(expr, o),
    async clickSel(sel) {
      const r = await page.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      if (!r) throw new Error('clickSel: not found ' + sel);
      await page.click(r.x, r.y);
    },
  };
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
