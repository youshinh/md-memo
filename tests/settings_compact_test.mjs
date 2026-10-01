// The Settings dialog listed every option and about 50 lines of explanation at once, which is a lot for a first-time user.
// settings_compact.js folds the sections a beginner does not need, puts the explanation behind a "?" button, and adds a
// "Show advanced" switch. It only moves and hides existing nodes, so it must never hide something the code writes a status into
// and never change which fields exist. The pixel check needs a real browser (done there: 13 sections, 38 explanations folded,
// the switch opens everything); this test pins the rules.
import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';

console.log('=== Settings compact view tests ===');

const require = createRequire(import.meta.url);
const SC = require('../frontend/js/settings_compact.js');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');

// 1. Which nodes make up a section.
{
  const nodes = [
    { header: false }, { header: false },                 // fields with no heading stay as they are
    { header: true, basic: true }, { header: false }, { header: false },
    { header: true }, { header: false },
    { header: true, plain: true }
  ];
  assert.deepStrictEqual(SC.planSections(nodes), [
    { start: 2, end: 5, basic: true, plain: false },
    { start: 5, end: 7, basic: false, plain: false },
    { start: 7, end: 8, basic: false, plain: true }
  ]);
  assert.deepStrictEqual(SC.planSections([{ header: false }]), [], 'no header, no section');
  console.log('PASS: planSections groups the nodes after each header and leaves the ones before the first alone.');
}

// 2. Which explanations are folded: plain static hints only; anything the code writes to, or that shows by itself, stays.
{
  const h = SC.isHelpHint;
  assert.strictEqual(h({ id: '', text: 'How long to wait.' }), true);
  assert.strictEqual(h({ id: 'speech-ready-hint', text: 'Stored in:' }), false, 'a status line the code writes to stays');
  assert.strictEqual(h({ id: '', startsHidden: true, text: 'Not available here.' }), false, 'a note that code shows when it applies stays');
  assert.strictEqual(h({ id: '', keep: true, text: 'Important.' }), false, 'data-keep stays');
  assert.strictEqual(h({ id: 'x', dataHint: true, text: 'Plain hint with an id.' }), true, 'data-hint forces it');
  assert.strictEqual(h({ id: '', text: '   ' }), false, 'an empty line has nothing to fold');
  console.log('PASS: isHelpHint folds static explanations and keeps status and warning lines.');
}

// 3. Against the real markup: every <small> with an id or the hidden class is kept; the sections are annotated as planned.
{
  const smalls = [...html.matchAll(/<small\b([^>]*)>/g)].map((m) => m[1]);
  const kept = smalls.filter((a) => /\bid="/.test(a) || /class="[^"]*\bhidden\b/.test(a));
  assert.ok(kept.length >= 10, 'expected the status / conditional lines, found ' + kept.length);
  for (const a of kept) {
    const info = { id: (/\bid="([^"]*)"/.exec(a) || [])[1] || '', startsHidden: /class="[^"]*\bhidden\b/.test(a), dataHint: /\bdata-hint\b/.test(a), text: 'x' };
    assert.strictEqual(SC.isHelpHint(info), false, 'this line would be folded although code writes to it or shows it: <small ' + a + '>');
  }

  const headers = [...html.matchAll(/<div\b([^>]*class="settings-section-header"[^>]*)>\s*<h4[^>]*data-i18n="([^"]+)"/g)];
  const byKey = Object.fromEntries(headers.map((m) => [m[2], m[1]]));
  for (const key of ['sectionAppearance', 'sectionEditor', 'sectionTextLLM', 'sectionAgentDelegate']) {
    assert.ok(/\bdata-basic\b/.test(byKey[key] || ''), key + ' must stay open in the basic view');
  }
  for (const key of ['sectionLayout']) assert.ok(byKey[key] && !/\bdata-plain\b/.test(byKey[key]), key + ' folds like every other section (it is wrapped too)');
  assert.ok(/id="sendto-section"[^>]*\bdata-plain\b/.test(html), 'the Send To header is shown and hidden by code: it must not be wrapped');
  const advanced = headers.filter((m) => !/\bdata-basic\b|\bdata-plain\b/.test(m[1])).map((m) => m[2]);
  for (const key of ['sectionLayout', 'sectionAutocomplete', 'sectionVisionOCR', 'sectionVoiceInput', 'sectionImageGen', 'sectionAgentCommands', 'sectionAutoSelector', 'sectionAgentSuggestions', 'sectionDiscordBridge', 'sectionInbox']) {
    assert.ok(advanced.includes(key), key + ' is an advanced section (folded in the basic view)');
  }
  // (The speech engine header sits inside a wrapper that belongs to the Voice input section: folded with it, not on its own.)
  const topLevel = advanced.filter((k) => k !== 'sectionSpeechEngine');
  assert.strictEqual(topLevel.length, 10, 'exactly the ten advanced sections start folded: ' + topLevel.join(', '));
  console.log('PASS: the real markup keeps every status line visible and marks ' + topLevel.length + ' sections as advanced.');
}

// 4. The switch, the strings, the script order, and the folded summary card.
{
  assert.ok(/<input type="checkbox" id="cfg-show-advanced">/.test(html) && /data-i18n="settingsShowAdvanced"/.test(html), 'the Show advanced switch is in the dialog header');
  assert.ok(html.indexOf('js/settings_compact.js') !== -1 && html.indexOf('js/settings_compact.js') < html.indexOf('js/app.js'),
    'settings_compact.js must load before app.js so the first applyLanguage translates the nodes it adds');
  const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();
  for (const k of ['settingsShowAdvanced', 'settingsHelpToggle']) {
    assert.ok(I18N.en[k] && I18N.ja[k], k + ' must exist in both languages');
  }
  assert.ok(/<details class="model-summary-card"/.test(html) && /<\/details>/.test(html.slice(html.indexOf('modelSummaryRowActions'))), 'the "which model does what" card starts folded');
  console.log('PASS: the switch, its strings, the script order and the folded summary card are in place.');
}

console.log('\nAll settings compact view tests PASSED!');
