// A short exploration session as a check that the kit works: Ctrl+L, one answered ask, one failed ask, then the state.
//   node tools/explore/smoke.mjs [--ja] [--shot <png>]
// Starts a headless Edge with its own temporary profile and stops it again; touches no real config, notes or clipboard.
import { startExplore } from './kit.mjs';

const args = process.argv.slice(2);
const lang = args.includes('--ja') ? 'ja' : 'en';
const shotAt = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
const T0 = Date.now();
const log = (msg) => console.log(`[${String(Date.now() - T0).padStart(5)} ms] ${msg}`);

const s = await startExplore({
  lang,
  notes: [{ title: 'sync.md', content: '# Team sync\n\nLaunch date is still open.\nBeta invites keep bouncing.\n' }],
  llm: { mode: 'ok', delayMs: 150 },
});
try {
  log('session ready');
  // select line 3 ("Launch date is still open.") and ask about it
  await s.ev('(function(){var e=document.getElementById("editor"); e.focus(); e.setSelectionRange(e.value.indexOf("Launch"), e.value.indexOf("Launch") + 26);})()');
  await s.key('l', { ctrl: true });
  await s.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')");
  await s.type('make it shorter');
  await s.key('Enter');
  await s.waitFor('window.__explore.state().tabs[0].content.indexOf("Reply 1.") !== -1');
  log('ok request answered');
  const afterOk = await s.state();
  console.log('note after the answer:', JSON.stringify(afterOk.tabs[0].content));

  await s.setLlm({ mode: 'fail', error: 'APIエラー (401): Incorrect API key provided', delayMs: 100 });
  await s.ev('(function(){var e=document.getElementById("editor"); e.focus(); e.setSelectionRange(0, 6);})()');
  await s.key('l', { ctrl: true });
  await s.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')");
  await s.type('translate');
  await s.key('Enter');
  await s.waitFor("!document.getElementById('inline-prompt-error').classList.contains('hidden')");
  log('failed request answered');

  const st = await s.state();
  console.log(JSON.stringify({ ...st, tabs: st.tabs.map((t) => ({ ...t, content: t.content.length + ' chars' })), editor: { ...st.editor, value: st.editor.value.length + ' chars' } }, null, 2));
  console.log('ask bar error text:', await s.ev("document.getElementById('inline-prompt-error-text').textContent"));
  if (shotAt) console.log('screenshot:', await s.shot(shotAt));
} finally {
  const res = await s.close();
  log(`closed: ${JSON.stringify(res)}`);
}
