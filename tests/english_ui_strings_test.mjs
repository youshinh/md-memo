// The English UI still showed some Japanese: the Active Tasks panel's "クリア" button and its tooltips, elapsed times like
// "2秒" / "1分3秒", the Quick Actions panel's "実行中:" / "エラー:" lines and timeout messages, and the fixed Command Bar
// presets labelled "日本語 (English)". Each is now a string in the i18n tables, chosen by the UI language.
//
// Not covered on purpose: markers that live inside the note text and are matched by code in both languages (the
// "{{ ⟳ 実行中... }}" running placeholder that the Go parser and the frontend both look for, and the voice input anchors
// "⦅文字起こし中...⦆" / "[再試行]"), and error messages that come from the Go backend.
import fs from 'fs';
import assert from 'assert';

console.log('=== English UI strings tests ===');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const CJK = /[぀-ヿ一-鿿＀-￯]/;
const I18N = new Function(read('frontend/js/i18n.js') + '\nreturn I18N;')();

const KEYS = [
  'taskElapsedSec', 'taskElapsedMinSec', 'taskClearButton', 'taskClearTitle', 'taskCloseTitle', 'taskListTitle', 'cliExpandTitle',
  'jevRunning', 'jevError', 'jevExecFailed', 'jevTaskTimeout', 'jevTimeout', 'jevBackendUnavailable'
];

// 1. Every new string exists in both languages, and the English one is English.
{
  for (const k of KEYS) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k], 'en is missing ' + k);
    assert.ok(typeof I18N.ja[k] === 'string' && I18N.ja[k], 'ja is missing ' + k);
    assert.ok(!CJK.test(I18N.en[k]), 'the English string for ' + k + ' contains Japanese: ' + I18N.en[k]);
  }
  console.log('PASS: the ' + KEYS.length + ' new strings exist in en and ja, and the English ones have no Japanese.');
}

// 2. Elapsed time follows the language (the function is private to task_manager.js: run its source with the real tables).
{
  const src = read('frontend/js/task_manager.js');
  const m = /  function formatElapsed\(ms\) \{[\s\S]*?\n  \}/.exec(src);
  assert(m, 'formatElapsed must exist');
  assert(!CJK.test(m[0]), 'formatElapsed must not hard-code Japanese: ' + m[0]);
  const make = (lang) => new Function('tt', m[0] + '\nreturn formatElapsed;')((key, params) => {
    let s = I18N[lang][key];
    Object.keys(params || {}).forEach((k) => { s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]); });
    return s;
  });
  assert.strictEqual(make('en')(2000), '2s');
  assert.strictEqual(make('en')(63000), '1m 3s');
  assert.strictEqual(make('ja')(2000), '2秒');
  assert.strictEqual(make('ja')(63000), '1分3秒');
  assert.ok(/taskElapsedSec: '\{n\}秒'/.test(src) && /taskElapsedMinSec: '\{min\}分\{sec\}秒'/.test(src), 'the standalone fallback keeps the Japanese wording');
  console.log('PASS: elapsed times read "2s" / "1m 3s" in English and "2秒" / "1分3秒" in Japanese.');
}

// 3. The Quick Actions panel takes its status and error text from the tables; Japanese is left only in the fallback tables.
{
  const whole = read('frontend/js/jev_action.js');
  let src = whole.replace(/const HINT_FALLBACK = \{[\s\S]*?\n  \};/, '').replace(/const VERB_LABEL_FALLBACK = \{[\s\S]*?\n  \};/, '');
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;,{}(\s])\/\/.*$/gm, '$1');
  const left = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => CJK.test(l)).map(([n, l]) => n + ': ' + l.trim());
  assert.deepStrictEqual(left, [], 'hard-coded Japanese outside the fallback tables in jev_action.js:\n' + left.join('\n'));
  for (const k of ['jevRunning', 'jevError', 'jevExecFailed', 'jevTaskTimeout', 'jevTimeout', 'jevBackendUnavailable']) {
    assert.ok(new RegExp("getHintText\\('" + k + "'\\)").test(whole), k + ' must be used through getHintText');
  }
  console.log('PASS: jev_action.js has no hard-coded Japanese outside its fallback tables.');
}

// 4. The panel and toolbar markup is translated by the language switch.
{
  const html = read('frontend/index.html');
  const el = (id) => new RegExp('<[a-z]+ id="' + id + '"[^>]*>').exec(html);
  assert.ok(/data-i18n="taskClearButton"/.test(el('btn-tasks-clear-history')[0]) && /data-i18n-title="taskClearTitle"/.test(el('btn-tasks-clear-history')[0]));
  assert.ok(/data-i18n-title="taskCloseTitle"/.test(el('btn-tasks-close')[0]));
  assert.ok(/data-i18n-title="taskListTitle"/.test(el('stat-tasks')[0]));
  assert.ok(/data-i18n-title="cliExpandTitle"/.test(el('btn-cli-filter-expand')[0]));
  for (const id of ['btn-tasks-clear-history', 'btn-tasks-close', 'stat-tasks', 'btn-cli-filter-expand']) {
    assert.ok(!CJK.test(el(id)[0]), id + ' must not carry Japanese in its own tag (English default, translated by data-i18n)');
  }
  assert.ok(/id="btn-tasks-clear-history"[^>]*>Clear<\/button>/.test(html), 'the clear button reads "Clear" before the language is applied');
  console.log('PASS: the task panel buttons, the task badge and the command-preview toggle are translated.');
}

// 5. The fixed Command Bar presets show one language in the English UI.
{
  const src = read('frontend/js/app.js');
  const m = /  function cliPresetLabel\(label\) \{[\s\S]*?\n  \}/.exec(src);
  assert(m, 'cliPresetLabel must exist');
  const make = (lang) => new Function('config', m[0] + '\nreturn cliPresetLabel;')({ general: { language: lang } });
  assert.strictEqual(make('en')('行を昇順ソート (Sort ascending)'), 'Sort ascending');
  assert.strictEqual(make('en')('SQL実行: DuckDB 表形式 (DuckDB query)'), 'DuckDB query');
  assert.strictEqual(make('en')('Base64デコード (Decode base64)'), 'Decode base64');
  assert.strictEqual(make('en')('plain label'), 'plain label');
  assert.strictEqual(make('ja')('行を昇順ソート (Sort ascending)'), '行を昇順ソート (Sort ascending)', 'the Japanese UI is unchanged');
  const from = src.indexOf('const CLI_PRESET_SNIPPETS');
  const presets = [...src.slice(from, src.indexOf('];', from)).matchAll(/label: '([^']+)'/g)].map((x) => x[1]);
  assert.ok(presets.length >= 15, 'presets found: ' + presets.length);
  for (const p of presets) assert.ok(!CJK.test(make('en')(p)), 'the English label still has Japanese: ' + p);
  assert.ok(/cliPresetSnippets\(\)/.test(src) && !/return CLI_PRESET_SNIPPETS;/.test(src) && !/concat\(CLI_PRESET_SNIPPETS/.test(src), 'the presets are always read through cliPresetSnippets()');
  console.log('PASS: the ' + presets.length + ' fixed presets read in English in the English UI and are unchanged in Japanese.');
}

console.log('\nAll English UI strings tests PASSED!');
