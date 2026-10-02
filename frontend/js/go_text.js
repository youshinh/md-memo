// Words that the Go side builds itself. Go does not know the UI language, so it words its messages in Japanese (or in both
// languages at once), and the page used to show them as they came: an English UI showed "ファイルの保存に失敗しました: ..." after
// "Save error:", and "フォーク爆弾パターンを検知しました (Fork bomb detected)" when the command guard refused something. Two
// things say them in the UI language without touching the Go sources:
//   * pickLang(text, lang): a message of the form "日本語 (English)" (the command guard) or "日本語 / English: detail" (settings
//     packages) is cut into its two halves and the half for the UI language is kept;
//   * localize(text, lang, tr): in an English UI a known Japanese opening ("ファイルの保存に失敗しました", "Ollamaのインストールに
//     失敗しました", ...) is replaced by its i18n phrase; what follows it (the operating system's own words, a path) stays as it is.
// A text this does not know comes back unchanged, so nothing is ever lost.
(function (global) {
  'use strict';

  // Hiragana, katakana (also the prolonged-sound mark), kanji and half-width katakana: what an English half never holds.
  const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
  const SLASH_FORM = /^([\s\S]+?) \/ ([^:\n]+?)(?:: ([\s\S]*))?$/; // "日本語 / English" or "日本語 / English: detail" (packErr in app_pack.go)
  const PAREN_FORM = /^([\s\S]*?)\s*\(([^()]+)\)$/; // "日本語 (English)" (the reasons of pkg/jev)

  // The Japanese openings of the messages of app_files.go and ollama_ops.go that reach the screen, and the i18n key of the phrase
  // that replaces each in an English UI.
  const PREFIXES = [
    ['ファイルの保存に失敗しました', 'goFileSaveFailed'],
    ['ファイルが見つかりません', 'goFileNotFound'],
    ['ファイルの読み込みに失敗しました', 'goFileReadFailed'],
    ['ディレクトリは開けません', 'goFileIsFolder'],
    ['文字コードのデコードに失敗しました', 'goDecodeFailed'],
    ['エンコードエラー', 'goEncodeFailed'],
    ['ファイルダイアログエラー', 'goDialogFailed'],
    ['保存ダイアログエラー', 'goSaveDialogFailed'],
    ['エクスポートダイアログエラー', 'goExportDialogFailed'],
    ['テキストエクスポートに失敗しました', 'goExportTextFailed'],
    ['開くファイルのパスが空です', 'goPathEmpty'],
    ['パスが空です', 'goPathEmpty'],
    ['指定されたフォルダにアクセスできません', 'goFolderDenied'],
    ['Ollamaのインストール状況を確認しています...', 'goOllamaChecking'],
    ['Ollamaを自動インストールしています (数分かかる場合があります)...', 'goOllamaInstalling'],
    ['Ollamaはすでにインストールされています', 'goOllamaInstalled'],
    ['Ollamaサービスを起動・ヘルスチェックしています...', 'goOllamaStarting'],
    ['Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...', 'goOllamaPulling'],
    ['Ollama & Gemma 4 E2B のセットアップが完了しました！', 'goOllamaDone'],
    ['Ollamaのインストールに失敗しました', 'goOllamaInstallFailed'],
    ['Ollamaサービスの起動に失敗しました', 'goOllamaStartFailed'],
    ['Ollamaサービスの起動待機がタイムアウトしました', 'goOllamaStartTimeout'],
    ['Gemma 4 E2B モデルのダウンロードに失敗しました', 'goOllamaPullFailed']
  ].sort((a, b) => b[0].length - a[0].length);

  function pickLang(text, lang) {
    const s = String(text == null ? '' : text);
    if (!CJK.test(s)) return s;
    let m = SLASH_FORM.exec(s);
    if (m && CJK.test(m[1]) && !CJK.test(m[2])) return (lang === 'ja' ? m[1] : m[2]) + (m[3] ? ': ' + m[3] : '');
    m = PAREN_FORM.exec(s.trim());
    // the English half is a phrase ("Fork bomb detected"), not a number with a unit or a code: "... タイムアウトしました (25s)" is whole
    if (m && CJK.test(m[1]) && !CJK.test(m[2]) && /^[A-Z][a-z]/.test(m[2].trim())) return lang === 'ja' ? m[1] : m[2];
    return s;
  }

  function localize(text, lang, tr) {
    let s = pickLang(text, lang);
    if (lang === 'ja' || !CJK.test(s) || typeof tr !== 'function') return s;
    let out = '';
    // "ファイルダイアログエラー: ファイルの読み込みに失敗しました: ..." has two openings: say both, then the rest as it is
    for (let i = 0; i < 3; i++) {
      const hit = PREFIXES.find((p) => s.startsWith(p[0]));
      if (!hit) break;
      const phrase = tr(hit[1]);
      if (!phrase || phrase === hit[1]) break; // no phrase for it: leave the text alone
      out += phrase;
      s = s.slice(hit[0].length);
      const sep = /^:\s*/.exec(s);
      const rest = sep ? s.slice(sep[0].length) : '';
      if (sep && PREFIXES.some((p) => rest.startsWith(p[0]))) {
        out += ': ';
        s = rest;
        continue;
      }
      break;
    }
    return out + s;
  }

  const api = { pickLang: pickLang, localize: localize, PREFIXES: PREFIXES };
  global.GoText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
