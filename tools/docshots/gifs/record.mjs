#!/usr/bin/env node
// Demo GIF recorder for the README.
//
//   node tools/docshots/gifs/record.mjs [--only name,name] [--out dir] [--list]
//                                       [--capture screencast|shots] [--tmp dir] [--keep-frames]
//                                       [--width 860] [--fps 10] [--colors 128] [--hold 1500]
//                                       [--preview dir] [--preview-count 6] [--skip a-b,c-d]
//
// It NEVER starts md-memo.exe and never touches a running MD-Memo. The real frontend/ is served by the docshots
// static server (tools/docshots/server.mjs) with the mocked window.backend, opened in an isolated Edge window with its
// own temporary profile (tools/docshots/cdp.mjs), in English (general.language 'en'), and driven with real CDP key
// events. Frames are recorded with Page.startScreencast; assemble.py (Pillow) writes the GIF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchHarness, Human, Recorder, installKeycap, installCosmetics, keycapFn, sleep, VIEWPORT } from './lib.mjs';
import { SCENARIOS } from './scenarios.mjs';

let activeHarness = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    // Ctrl+C: stop only the browser this run started (its own process tree), then leave.
    if (activeHarness) { try { await activeHarness.close(); } catch { /* already gone */ } }
    process.exit(130);
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

function parseArgs(argv) {
  const a = {
    only: null, out: path.join(REPO, 'img', 'demo'), list: false, capture: 'screencast', tmp: os.tmpdir(),
    keepFrames: false, width: 860, fps: 10, colors: 128, hold: 1500, preview: '', previewCount: 6, skip: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--list') a.list = true;
    else if (k === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--capture') a.capture = argv[++i];
    else if (k === '--tmp') a.tmp = path.resolve(argv[++i]);
    else if (k === '--keep-frames') a.keepFrames = true;
    else if (k === '--width') a.width = Number(argv[++i]);
    else if (k === '--fps') a.fps = Number(argv[++i]);
    else if (k === '--colors') a.colors = Number(argv[++i]);
    else if (k === '--hold') a.hold = Number(argv[++i]);
    else if (k === '--preview') a.preview = path.resolve(argv[++i]);
    else if (k === '--preview-count') a.previewCount = Number(argv[++i]);
    else if (k === '--skip') a.skip = argv[++i];
    else throw new Error('unknown argument: ' + k);
  }
  if (!['screencast', 'shots'].includes(a.capture)) throw new Error('--capture must be screencast or shots');
  return a;
}

function assemble(args, name, sc, framesDir) {
  const out = path.join(args.out, name + '.gif');
  const cmd = [
    path.join(HERE, 'assemble.py'), '--frames', framesDir, '--out', out,
    '--crop', sc.crop.join(','), '--width', String(sc.width || args.width), '--fps', String(args.fps),
    '--colors', String(sc.colors || args.colors), '--hold', String(args.hold),
  ];
  if (args.preview) cmd.push('--preview', args.preview, '--preview-count', String(args.previewCount));
  if (sc.skip || args.skip) cmd.push('--skip', sc.skip || args.skip);
  const r = spawnSync('python', cmd, { encoding: 'utf8', timeout: 300000 });
  let res;
  try { res = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch { res = { ok: false, error: (r.stderr || r.stdout || 'assemble.py produced no result').trim() }; }
  return { out, ...res };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const [name, sc] of Object.entries(SCENARIOS)) console.log(name.padEnd(16), '-', sc.title);
    return 0;
  }
  const names = args.only || Object.keys(SCENARIOS);
  const unknown = names.filter((n) => !SCENARIOS[n]);
  if (unknown.length) throw new Error('unknown scenario(s): ' + unknown.join(', '));
  fs.mkdirSync(args.out, { recursive: true });
  fs.mkdirSync(args.tmp, { recursive: true });

  const h = await launchHarness({ lang: 'en' });
  activeHarness = h;
  console.log(`edge pid ${h.edge.pid}, debug port ${h.edge.debugPort}, title token ${h.title}`);
  let failed = 0;
  const results = [];
  try {
    for (const name of names) {
      const sc = SCENARIOS[name];
      const t0 = Date.now();
      const framesDir = fs.mkdtempSync(path.join(args.tmp, `gifframes-${name}-`));
      try {
        await h.load();
        const page = h.page;
        // Some scenarios show a panel that sits at the bottom of the window: a shorter window keeps it next to the text.
        const vp = sc.viewport || VIEWPORT;
        if (vp[0] !== VIEWPORT[0] || vp[1] !== VIEWPORT[1]) {
          const got = await page.setInnerSize(vp[0], vp[1]);
          if (got.iw !== vp[0] || got.ih !== vp[1]) throw new Error(`could not size the window to ${vp.join('x')} (got ${got.iw}x${got.ih})`);
          await sleep(300);
        }
        const human = new Human(page, { seed: 11, ...(sc.typing || {}) });
        const env = {
          page, human, lang: 'en', sleep, pause: sleep,
          ev: (expr) => page.eval(expr),
          size: VIEWPORT,
        };
        await installCosmetics(page);
        await installKeycap(page, sc.crop, sc.keycapX || 0.5, sc.keycapBottom || 44);
        const showKeys = keycapFn(page, 800);
        const rec = new Recorder(page, framesDir, { mode: args.capture, viewport: vp });
        human.keycap = async (label) => { rec.mark(label); await showKeys(label); };
        await sc.prepare(env);
        await sleep(300);
        await rec.start();
        let meta;
        try {
          await sc.run(env);
          await sleep(200);
        } finally {
          meta = await rec.stop();
        }
        const res = assemble(args, name, sc, framesDir);
        results.push({ name, ...res, recordedMs: meta.end, source: meta.frames.length, seconds: Math.round((Date.now() - t0) / 100) / 10 });
        if (res.ok) console.log(`${name.padEnd(16)} ${res.bytes} bytes  ${res.seconds}s  ${res.frames} frames  ${res.width}x${res.height}  (${meta.frames.length} source frames, ${meta.end} ms recorded)`);
        else { failed++; console.log(`${name.padEnd(16)} FAIL ${res.error}`); }
      } catch (err) {
        failed++;
        console.log(`${name.padEnd(16)} FAIL ${err && err.stack || err}`);
      } finally {
        if (!args.keepFrames) { try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch { /* leave it */ } }
        else console.log(`  frames kept in ${framesDir}`);
      }
    }
  } finally {
    const end = await h.close();
    console.log(`edge processes left from this run: ${end.left}; profile folder ${end.profileGone ? 'deleted' : 'STILL PRESENT'}`);
  }
  console.log(`done: ${results.length - failed} ok, ${failed} failed`);
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(2); });
