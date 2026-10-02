// Tests for go_text.js: the Go side words its messages in Japanese (or in both languages at once), and an English UI says them in
// English without the Go sources being touched (exploratory test C14-01 / C14-02, and the Ollama set-up lines of C9-03).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const GoText = require('./go_text.js');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'i18n.js'), 'utf8') + '; this.I18N = I18N;', ctx);
const I18N = ctx.I18N;
const tr = (lang) => (key) => (I18N[lang][key] !== undefined ? I18N[lang][key] : key);
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

check('pickLang: "日本語 (English)" (the command guard) keeps the half of the UI language', () => {
  const s = 'フォーク爆弾パターンを検知しました (Fork bomb detected)';
  assert.strictEqual(GoText.pickLang(s, 'en'), 'Fork bomb detected');
  assert.strictEqual(GoText.pickLang(s, 'ja'), 'フォーク爆弾パターンを検知しました');
  // the reasons that name something in the middle keep it in the Japanese half
  const w = 'システムディレクトリ "/etc" への書き込みの可能性があります (Write into a system directory)';
  assert.strictEqual(GoText.pickLang(w, 'en'), 'Write into a system directory');
  assert.strictEqual(GoText.pickLang(w, 'ja'), 'システムディレクトリ "/etc" への書き込みの可能性があります');
});

check('pickLang: "日本語 / English: detail" (settings packages) keeps the half of the UI language and the detail', () => {
  const s = 'ファイルを開けません / cannot open the file: open C:\\x\\a.mdmemopack: The system cannot find the file specified.';
  assert.strictEqual(GoText.pickLang(s, 'en'), 'cannot open the file: open C:\\x\\a.mdmemopack: The system cannot find the file specified.');
  assert.strictEqual(GoText.pickLang(s, 'ja'), 'ファイルを開けません: open C:\\x\\a.mdmemopack: The system cannot find the file specified.');
  assert.strictEqual(GoText.pickLang('ファイルが大きすぎます / file is too large', 'en'), 'file is too large');
  assert.strictEqual(GoText.pickLang('ファイルが大きすぎます / file is too large', 'ja'), 'ファイルが大きすぎます');
});

check('pickLang: text that is not in a two-language form comes back as it was', () => {
  for (const s of ['', 'plain English (with a note)', 'ファイルが見つかりません', 'Access is denied.', '日本語 / にほんご', 'ファイルが見つかりません (ファイル名)', 'タイムアウトしました (25s)', 'APIが失敗しました (HTTP 500)']) {
    assert.strictEqual(GoText.pickLang(s, 'en'), s);
    assert.strictEqual(GoText.pickLang(s, 'ja'), s);
  }
  assert.strictEqual(GoText.pickLang(null, 'en'), '');
  assert.strictEqual(GoText.pickLang(undefined, 'ja'), '');
});

check('localize: a known Japanese opening is said in English; the operating system\'s own words after it stay', () => {
  const en = tr('en');
  assert.strictEqual(
    GoText.localize('ファイルの保存に失敗しました: open C:\\Users\\a\\n.md: Access is denied.', 'en', en),
    'Could not save the file: open C:\\Users\\a\\n.md: Access is denied.');
  assert.strictEqual(GoText.localize('ファイルが見つかりません: CreateFile x: The system cannot find the file specified.', 'en', en), 'File not found: CreateFile x: The system cannot find the file specified.');
  assert.strictEqual(GoText.localize('ディレクトリは開けません: C:\\notes', 'en', en), 'That is a folder, not a file: C:\\notes');
  assert.strictEqual(GoText.localize('パスが空です', 'en', en), 'The file path is empty');
});

check('localize: two openings in a row (a dialog error that wraps a read error) are both said', () => {
  const out = GoText.localize('ファイルダイアログエラー: ファイルの読み込みに失敗しました: boom', 'en', tr('en'));
  assert.strictEqual(out, 'File dialog error: Could not read the file: boom');
});

check('localize: the Ollama set-up lines of the Go side (ollama_ops.go) are said in English, step by step', () => {
  const en = tr('en');
  const lines = [
    'Ollamaのインストール状況を確認しています...',
    'Ollamaを自動インストールしています (数分かかる場合があります)...',
    'Ollamaはすでにインストールされています',
    'Ollamaサービスを起動・ヘルスチェックしています...',
    'Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...',
    'Ollama & Gemma 4 E2B のセットアップが完了しました！',
    'Ollamaのインストールに失敗しました',
    'Ollamaサービスの起動に失敗しました',
    'Gemma 4 E2B モデルのダウンロードに失敗しました'
  ];
  for (const line of lines) {
    const said = GoText.localize(line, 'en', en);
    assert.ok(!CJK.test(said), 'no Japanese is left: ' + said);
    assert.ok(said.length > 10, said);
  }
  assert.strictEqual(GoText.localize('Ollamaサービスの起動待機がタイムアウトしました (25s)', 'en', en), 'Timed out waiting for the Ollama service to start (25s)');
  // the same lines in a Japanese UI are the Go side's own words
  for (const line of lines) assert.strictEqual(GoText.localize(line, 'ja', tr('ja')), line);
});

check('localize: the Japanese UI keeps the Japanese; a two-language string loses its English half', () => {
  assert.strictEqual(GoText.localize('ファイルの保存に失敗しました: x', 'ja', tr('ja')), 'ファイルの保存に失敗しました: x');
  assert.strictEqual(GoText.localize('コマンドが空です (Empty command)', 'ja', tr('ja')), 'コマンドが空です');
  assert.strictEqual(GoText.localize('コマンドが空です (Empty command)', 'en', tr('en')), 'Empty command');
});

check('localize: what it does not know is never lost', () => {
  const en = tr('en');
  for (const s of ['exit status 1: \'winget\' is not recognized as an internal or external command', 'ネットワークに接続できません', 'C:\\ノート\\メモ.md', '']) {
    assert.strictEqual(GoText.localize(s, 'en', en), s);
  }
  // no translator: the text comes back
  assert.strictEqual(GoText.localize('ファイルが見つかりません: x', 'en'), 'ファイルが見つかりません: x');
  // a key the table lacks: the text is left alone, not replaced by the key
  assert.strictEqual(GoText.localize('ファイルが見つかりません: x', 'en', (k) => k), 'ファイルが見つかりません: x');
});

check('every phrase the table points to exists in both languages; the English holds no Japanese', () => {
  for (const [prefix, key] of GoText.PREFIXES) {
    assert.ok(I18N.en[key] && I18N.ja[key], key + ' (for "' + prefix + '") is in both tables');
    assert.ok(!CJK.test(I18N.en[key]), key + ' in English holds no Japanese: ' + I18N.en[key]);
  }
});

check('every opening in the table is still what the Go sources say (a reworded Go message must come here too)', () => {
  const root = path.join(__dirname, '..', '..');
  const go = ['app_files.go', 'ollama_ops.go'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const [prefix] of GoText.PREFIXES) {
    assert.ok(go.includes(prefix), 'not in app_files.go / ollama_ops.go any more: ' + prefix);
  }
});

if (failed) {
  console.log(failed + ' go_text check(s) failed');
  process.exit(1);
}
console.log('All go_text tests passed.');
