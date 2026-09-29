// Smoke tests for the main flows of MD-Memo: the real frontend/ in a headless Edge with the mocked backend (the exploration kit,
// tools/explore/kit.mjs), judged on the DOM and the app state - no pictures.
//
//   node tests/smoke/run.mjs                 run every flow (about 30 s), print PASS / FAIL for each, exit 1 if any failed
//   node tests/smoke/run.mjs --only ask      only the flows whose file name or title contains "ask"
//   node tests/smoke/run.mjs --lang ja       the same flows in the Japanese UI
//   node tests/smoke/run.mjs --jobs 1        one flow at a time (default 3 at a time)
//   node tests/smoke/run.mjs --list          list the flows
//   node tests/smoke/run.mjs --shots dir     save a screenshot of every failed flow to dir (for a person to look at; never compared)
//
// Every flow gets its own session (its own browser process, temporary profile and local server), started for it and stopped
// after it. Nothing real is touched: no md-memo.exe, no real config or notes or clipboard, no network.
//
// A flow file (NN_name.mjs) exports default:
//   { title, session?: startExplore options (or a function of lang), timeoutMs?: 30000, allowConsoleErrors?: [RegExp],
//     knownFailing?: 'why the whole flow is expected to fail', async run(s, t) }
// `s` is the kit session; `t` = { lang, pick(en, ja), step(label), knownIssue(reason, fn), soft }:
//   t.step('label')             names the step for the failure message ("failed at: ...")
//   t.pick(en, ja)              the value for the UI language of this run
//   t.knownIssue(reason, fn)    runs fn; if it throws, the reason is listed as a known app problem and the flow goes on; if it
//                               passes, the run says the mark can go. For a check that fails today because of an app bug.
// A flow also fails when the page logged an uncaught error or console.error (except those allowed by allowConsoleErrors).
//
// Exit status: 0 = every flow passed (known problems do not count), 1 = a flow failed, 2 = this machine cannot run the kit
// (no Edge / not Windows).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startExplore } from '../../tools/explore/kit.mjs';
import { findEdge } from '../../tools/docshots/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- arguments -----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const LANG = option('--lang', 'en') === 'ja' ? 'ja' : 'en';
const JOBS = Math.max(1, Number(option('--jobs', '3')) || 3);
const ONLY = option('--only', '');
const SHOTS = option('--shots', '');

// ---- finding the flows ----------------------------------------------------------------------------------
const files = fs.readdirSync(HERE).filter((f) => /^\d\d_.+\.mjs$/.test(f)).sort();
if (!files.length) {
  console.error('no flows found in ' + HERE);
  process.exit(2);
}

async function loadFlows() {
  const flows = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(HERE, file)).href);
    const flow = mod.default;
    if (!flow || typeof flow.run !== 'function') throw new Error(`${file}: no default export with run()`);
    flows.push({ file, id: file.replace(/\.mjs$/, ''), ...flow });
  }
  return flows;
}

// ---- running one flow -----------------------------------------------------------------------------------
const fmtSeconds = (ms) => (ms / 1000).toFixed(1) + ' s';

function firstLines(text, n) {
  return String(text).split('\n').slice(0, n).join('\n');
}

async function runFlow(flow) {
  const started = Date.now();
  const result = { flow, status: 'pass', ms: 0, message: '', step: '', known: [], fixed: [], consoleErrors: [], shot: '' };
  let step = '(starting the session)';
  const t = {
    lang: LANG,
    pick: (en, ja) => (LANG === 'ja' ? ja : en),
    step: (label) => { step = label; },
    knownIssue: async (reason, fn) => {
      try {
        await fn();
        result.fixed.push(reason);
      } catch (err) {
        result.known.push(`${reason} [${firstLines(err && err.message ? err.message : err, 1)}]`);
      }
    },
  };

  let session = null;
  try {
    const spec = typeof flow.session === 'function' ? flow.session(LANG) : (flow.session || {});
    session = await startExplore({ lang: LANG, ...spec });
    step = '(the flow started)';
    const timeoutMs = flow.timeoutMs || 30000;
    let timer = null;
    const run = Promise.resolve().then(() => flow.run(session, t));
    run.catch(() => {}); // a flow abandoned by the time-out must not become an unhandled rejection later
    await Promise.race([
      run,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the flow did not finish in ${fmtSeconds(timeoutMs)}`)), timeoutMs); }),
    ]);
    clearTimeout(timer);
    step = '(after the flow: the browser console)';
    const st = await session.state();
    const allowed = flow.allowConsoleErrors || [];
    result.consoleErrors = st.consoleErrors.filter((e) => !allowed.some((re) => re.test(e)));
    if (result.consoleErrors.length) throw new Error('the page logged errors:\n  ' + result.consoleErrors.join('\n  '));
  } catch (err) {
    result.status = 'fail';
    result.message = err && err.message ? err.message : String(err);
    result.step = step;
    if (session) {
      try {
        const st = await session.state();
        const open = Object.keys(st.panels).filter((k) => st.panels[k]);
        result.message += `\n  page: open panels [${open.join(', ')}], status "${st.statusText}", last toasts ${JSON.stringify(st.toasts.slice(-3))}, pending AI ${st.pendingLlm}`;
        if (SHOTS) result.shot = await session.shot(path.join(SHOTS, `${flow.id}-${LANG}.png`));
      } catch { /* the page is gone: the message above is all there is */ }
    }
  } finally {
    if (session) {
      try {
        const res = await session.close();
        if (!res.processGone || !res.profileGone) result.leftovers = `browser left behind: ${JSON.stringify(res)}`;
      } catch (err) {
        result.leftovers = 'closing the session failed: ' + err.message;
      }
    }
    result.ms = Date.now() - started;
  }
  if (flow.knownFailing) {
    if (result.status === 'fail') { result.status = 'xfail'; }
    else { result.status = 'xpass'; }
  }
  return result;
}

// ---- main -----------------------------------------------------------------------------------------------
const all = await loadFlows();
const selected = all.filter((f) => !ONLY || f.id.includes(ONLY) || String(f.title).toLowerCase().includes(ONLY.toLowerCase()));

if (flag('--list')) {
  for (const f of all) console.log(`${f.id}  ${f.title}${f.knownFailing ? '  [known failing]' : ''}`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`no flow matches --only "${ONLY}"`);
  process.exit(2);
}

try {
  findEdge();
} catch (err) {
  console.error('The smoke tests need Microsoft Edge (Windows): ' + err.message);
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error('The smoke tests run on Windows only (the exploration kit drives Edge and stops it through Windows tools).');
  process.exit(2);
}

const T0 = Date.now();
console.log(`MD-Memo smoke: ${selected.length} flow(s), UI language ${LANG}, ${Math.min(JOBS, selected.length)} at a time\n`);

const results = new Array(selected.length);
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= selected.length) return;
    const r = await runFlow(selected[i]);
    results[i] = r;
    report(r);
  }
}

function report(r) {
  const label = { pass: 'PASS ', fail: 'FAIL ', xfail: 'XFAIL', xpass: 'XPASS' }[r.status];
  console.log(`${label} ${r.flow.id}  ${r.flow.title}  (${fmtSeconds(r.ms)})`);
  if (r.status === 'fail') {
    console.log(`      failed at: ${r.step}`);
    console.log(r.message.split('\n').filter((l) => l.trim()).map((l) => '      ' + l).join('\n'));
    if (r.shot) console.log(`      screenshot: ${r.shot}`);
  }
  if (r.status === 'xfail') console.log(`      known failing: ${r.flow.knownFailing}\n      (it failed at "${r.step}": ${firstLines(r.message, 1)})`);
  if (r.status === 'xpass') console.log(`      known failing but it PASSED: ${r.flow.knownFailing}\n      -> the app problem looks fixed: remove knownFailing from ${r.flow.file}`);
  for (const k of r.known) console.log(`      known issue: ${k}`);
  for (const k of r.fixed) console.log(`      known issue now passes, remove its mark: ${k}`);
  if (r.leftovers) console.log(`      WARNING ${r.leftovers}`);
}

await Promise.all(Array.from({ length: Math.min(JOBS, selected.length) }, worker));

const count = (status) => results.filter((r) => r.status === status).length;
const failed = count('fail');
const knownIssues = results.reduce((n, r) => n + r.known.length, 0);
const leftovers = results.filter((r) => r.leftovers).length;
console.log(`\n${results.length} flow(s) in ${fmtSeconds(Date.now() - T0)}: ${count('pass')} passed, ${failed} failed, ${count('xfail')} known failing` +
  `${count('xpass') ? `, ${count('xpass')} known-failing that now pass` : ''}${knownIssues ? `, ${knownIssues} known issue(s) noted inside passing flows` : ''}` +
  `${leftovers ? `, ${leftovers} with a browser left behind` : ''}`);
process.exit(failed || leftovers ? 1 : 0);
