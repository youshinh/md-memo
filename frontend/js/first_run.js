// MD-Memo first run (docs/design/first-run.md; UX review A1 and A2).
//
//   * A1 - the very first start shows one editable "Welcome" note instead of a note that holds only a date heading. "The very
//     first start" means all of: no config.json on disk, no saved session (localStorage or the backend file), no remembered
//     workspace folder, no file handed over by the OS, and no general.welcomeShown. Anyone who upgrades has a config file, so
//     they never see it. app.js asks isFirstRun() once, after the backend config was read, and swaps the still untouched first
//     note for welcomeNote(); it then writes welcomeConfigJson() so the note never comes back.
//   * A2 - the first time the ask bar opens while the text model is still the untouched default (local Ollama, qwen2.5), the bar
//     offers a one-time choice (set up Ollama / use a cloud key / later). shouldOfferAiChoice() says when; general.aiChoiceMade
//     records that a choice was made.
//
// Pure functions only: no DOM, no storage, no timers, nothing runs until app.js calls it (a note that is not the first start
// costs one boolean test). The text of the welcome note lives here, in both languages, because it is a document, not a label.
(function (global) {
  'use strict';

  // The text model a fresh config has (keep in step with the `config.text` defaults in app.js).
  const DEFAULT_TEXT_URL = 'http://localhost:11434';
  const DEFAULT_TEXT_MODEL = 'qwen2.5:latest';

  // The header a new note starts with ("# 2026-09-25 07:51" and a blank line): an untouched first note still holds only this.
  const DATE_HEADER_ONLY = /^# \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n?$/;

  // ---- A1: the welcome note -------------------------------------------------------------------

  // signals: { welcomeShown, configFileFound, localConfigFound, sessionFound, workspaceFolder, startupFile }
  //   localConfigFound: the settings copy this WebView keeps in localStorage (it exists once the person has saved anything).
  //   configFileFound: true / false from the backend, anything else (null, undefined) = it could not be told. Only a definite
  //   "there is no config file" counts: a missing backend (a browser, a test) or a failed read must never show the note.
  function isFirstRun(signals) {
    const s = signals || {};
    if (s.configFileFound !== false) return false;
    if (s.welcomeShown) return false;
    if (s.localConfigFound) return false;
    if (s.sessionFound) return false;
    if (s.workspaceFolder) return false;
    if (s.startupFile) return false;
    return true;
  }

  // True for a note the person has not started: no file, no unsaved change, and either nothing in it or only the date header
  // that a new note starts with. `live` is what the editor shows right now (the tab object is only synced on a switch).
  function isUntouchedNewTab(tab, live) {
    if (!tab || tab.path || tab.isDirty) return false;
    const text = typeof live === 'string' ? live : String(tab.content == null ? '' : tab.content);
    if (text.trim() === '') return true;
    return DATE_HEADER_ONLY.test(text);
  }

  // What is written to config.json on the first start: the flag, so no default is frozen into the file (the language and the IME
  // default of an OS that cannot switch its input source are still worked out fresh on every start until the person saves
  // Settings). Loaded like any other config: a missing section falls back to its default everywhere.
  //
  // keep: general.* values to write with it, for the few settings whose first-start default is decided by "there is no config file
  // yet" (the calm toolbar: a config file without a layout reads as "show everything"). The file must not change what the person
  // sees on the second start, so app.js passes the value in effect. welcomeShown itself cannot be overridden.
  function welcomeConfigJson(keep) {
    const general = {};
    if (keep && typeof keep === 'object') {
      Object.keys(keep).forEach(function (k) {
        if (k !== 'welcomeShown' && k !== '__proto__' && keep[k] !== undefined) general[k] = keep[k];
      });
    }
    general.welcomeShown = true;
    return JSON.stringify({ general: general });
  }

  const WELCOME = {
    en: {
      title: 'Welcome',
      body: [
        '# Welcome to MD-Memo',
        '',
        'MD-Memo is a plain Markdown notepad. This note is yours: edit it, or close it. It only appears once.',
        '',
        '## Write',
        '',
        '- Just start typing. Notes are Markdown: `# Heading`, `- list item`, `**bold**`.',
        '- Press `{preview}` to see the note formatted, and again to go back to writing.',
        '- Press `{save}` to save it as a .md file. Notes you have not saved are still here when you restart.',
        '',
        '## Ask the AI',
        '',
        '- Put the cursor on a line (or select some text) and press `{ask}`. Type what you want, for example "translate to English", then press Enter. The answer is written below.',
        '- The AI needs a model. The first time you press `{ask}`, MD-Memo lets you pick one: run it on this computer (Ollama) or use a cloud key. You can change it any time in Settings > AI Models (`{settings}`).',
        '',
        '## Find your way around',
        '',
        '- `{palette}` opens the command palette. Every command is there: just start typing.',
        '- `{settings}` opens Settings.',
        '- `{search}` searches your daily notes.',
        '',
        '## Where your notes are',
        '',
        '- A note you save is an ordinary .md file, wherever you save it.',
        '- Daily notes are one file per day in `{scrapDir}`. Text you send in from the terminal or your phone is added to today\'s file. You can change the folder in Settings > Sync.',
        '- Your notes stay on this computer unless you set up a cloud model, Git sync or Mobile Drop.',
        ''
      ].join('\n')
    },
    ja: {
      title: 'ようこそ',
      body: [
        '# MD-Memo へようこそ',
        '',
        'MD-Memo は、Markdown で書くシンプルなメモ帳です。このノートは自由に編集でき、閉じても構いません。表示されるのは今回だけです。',
        '',
        '## 書く',
        '',
        '- そのまま打ち始めます。書式は Markdown です: `# 見出し`、`- 箇条書き`、`**太字**`。',
        '- `{preview}` で整形した表示になり、もう一度押すと書く画面に戻ります。',
        '- `{save}` で .md ファイルとして保存します。保存していないノートは、再起動しても残っています。',
        '',
        '## AI に聞く',
        '',
        '- 行にカーソルを置く（または文章を選ぶ）と、`{ask}` で聞けます。やりたいことを、たとえば「英語に翻訳」のように入力して Enter を押すと、答えがその下に書き込まれます。',
        '- AI にはモデルが必要です。初めて `{ask}` を押したときに、このパソコンで動かす（Ollama）か、クラウドのキーを使うかを選べます。あとから、設定 > AIモデル（`{settings}`）でいつでも変えられます。',
        '',
        '## 使い方の入口',
        '',
        '- `{palette}` でコマンドパレットが開きます。すべてのコマンドがあるので、打ち始めるだけで探せます。',
        '- `{settings}` で設定が開きます。',
        '- `{search}` で日付ノートを検索します。',
        '',
        '## ノートの保存先',
        '',
        '- 保存したノートは、選んだ場所にある普通の .md ファイルです。',
        '- 日付ノートは、`{scrapDir}` に 1 日 1 ファイルで置かれます。ターミナルやスマホから送った文章が、その日のファイルに追記されます。フォルダは 設定 > 同期 で変えられます。',
        '- クラウドのモデル、Git 同期、Mobile Drop を設定しない限り、ノートはこのパソコンの外に出ません。',
        ''
      ].join('\n')
    }
  };

  const FALLBACK_KEYS = { ask: 'Ctrl+L', palette: 'Ctrl+Shift+P', settings: 'Ctrl+,', search: 'Ctrl+Shift+F', preview: 'Ctrl+P', save: 'Ctrl+S', scrapDir: '~/Documents/md-memo/scraps' };

  // The welcome note for the UI language. keys: what the shortcuts are called on this computer ({ ask, palette, settings, search,
  // preview, save } as shown to the person, e.g. "Cmd+L" on a Mac) and the daily notes folder ({ scrapDir }). A missing value
  // falls back to the Windows default. Returns { title, content, cursorPos }: the cursor stays at the top so it reads from the top.
  function welcomeNote(lang, keys) {
    const doc = WELCOME[lang === 'ja' ? 'ja' : 'en'];
    const k = keys || {};
    const content = doc.body.replace(/\{(ask|palette|settings|search|preview|save|scrapDir)\}/g, function (_, name) {
      const v = k[name];
      return typeof v === 'string' && v.trim() ? v.trim() : FALLBACK_KEYS[name];
    });
    return { title: doc.title, content: content, cursorPos: 0 };
  }

  // ---- A2: the one-time model choice in the ask bar -----------------------------------------------

  function normalizedUrl(url) {
    return String(url == null ? '' : url).trim().toLowerCase().replace(/\/+$/, '');
  }

  // True while the text model is exactly what a fresh install has: local Ollama, qwen2.5, no key.
  function isDefaultTextModel(text) {
    const t = text || {};
    if (normalizedUrl(t.baseUrl) !== DEFAULT_TEXT_URL) return false;
    if (String(t.model == null ? '' : t.model).trim().toLowerCase() !== DEFAULT_TEXT_MODEL) return false;
    return String(t.apiKey == null ? '' : t.apiKey).trim() === '';
  }

  // general: config.general (aiChoiceMade is true once a choice was made); text: config.text.
  function shouldOfferAiChoice(general, text) {
    if (general && general.aiChoiceMade) return false;
    return isDefaultTextModel(text);
  }

  const api = {
    isFirstRun: isFirstRun,
    isUntouchedNewTab: isUntouchedNewTab,
    welcomeConfigJson: welcomeConfigJson,
    welcomeNote: welcomeNote,
    isDefaultTextModel: isDefaultTextModel,
    shouldOfferAiChoice: shouldOfferAiChoice
  };
  global.FirstRun = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
