// Unit tests for first_run.js: when the Welcome note appears (UX review A1), what it says in both languages, and when the ask bar
// offers the one-time model choice (A2). The functions are pure, so these run without a DOM.
const assert = require('assert');

global.window = global;
const FR = require('./first_run.js');

// The signals of a genuinely first start: the backend said "no config.json", nothing else exists.
const fresh = () => ({ welcomeShown: false, configFileFound: false, localConfigFound: false, sessionFound: false, workspaceFolder: null, startupFile: null });

(function firstRunNeedsEveryConditionAtOnce() {
  assert.strictEqual(FR.isFirstRun(fresh()), true, 'nothing exists: the first start');
  assert.strictEqual(FR.isFirstRun({ configFileFound: false }), true, 'unset signals count as absent');

  // Each thing that shows the app has been used before switches the note off, alone.
  const blockers = {
    welcomeShown: true,
    localConfigFound: true,
    sessionFound: true,
    workspaceFolder: 'C:\\Users\\me\\notes',
    startupFile: { path: 'C:\\a.md' },
    configFileFound: true
  };
  for (const [name, value] of Object.entries(blockers)) {
    const s = fresh();
    s[name] = value;
    assert.strictEqual(FR.isFirstRun(s), false, name + ' alone stops the welcome note');
  }

  // "Could not tell" is never a first run: a missing backend (a browser, a test) or a failed read must not show the note.
  for (const unknown of [null, undefined, 0, '', 'false']) {
    const s = fresh();
    s.configFileFound = unknown;
    assert.strictEqual(FR.isFirstRun(s), false, 'configFileFound=' + JSON.stringify(unknown) + ' is not a definite "no config file"');
  }
  assert.strictEqual(FR.isFirstRun(), false, 'no signals at all');
  assert.strictEqual(FR.isFirstRun(null), false);
})();

(function anUntouchedNewTabIsEmptyOrJustTheDateHeader() {
  const header = '# 2026-09-30 10:24\n\n';
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: header }), true, 'the date header a new note starts with');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: '' }), true, 'nothing in it');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: '  \n' }), true, 'only blanks');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: '# 2026-09-30 10:24\n' }), true, 'header with one line break');

  // The editor is the truth (the tab is only synced on a switch): typing under the header makes the note the person's.
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: header }, header + 'hello'), false, 'the person typed');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: 'x' }, header), true, 'the live editor value wins over a stale tab');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: header }, ''), true);

  assert.strictEqual(FR.isUntouchedNewTab({ path: 'C:\\n.md', isDirty: false, content: header }), false, 'a note with a file is never replaced');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: true, content: header }), false, 'unsaved changes are never replaced');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: '# My plan\n\n' }), false, 'a heading of the person\'s own');
  assert.strictEqual(FR.isUntouchedNewTab({ path: '', isDirty: false, content: '# 2026-09-30 10:24\n\nx' }), false);
  assert.strictEqual(FR.isUntouchedNewTab(null), false);
  assert.strictEqual(FR.isUntouchedNewTab(undefined, header), false);
})();

(function onlyTheFlagIsWrittenToConfigJson() {
  const parsed = JSON.parse(FR.welcomeConfigJson());
  assert.deepStrictEqual(parsed, { general: { welcomeShown: true } }, 'no default (language, IME, model) is frozen into config.json');

  // A value the first start decided (the toolbar layout in effect) can go with it; the flag cannot be overridden or dropped.
  const layout = { order: [], hidden: ['btn-a', 'btn-b'] };
  assert.deepStrictEqual(JSON.parse(FR.welcomeConfigJson({ toolbarLayout: layout })), { general: { toolbarLayout: layout, welcomeShown: true } });
  assert.strictEqual(JSON.parse(FR.welcomeConfigJson({ welcomeShown: false })).general.welcomeShown, true, 'welcomeShown is always true');
  assert.deepStrictEqual(JSON.parse(FR.welcomeConfigJson({ toolbarLayout: undefined, x: undefined })), { general: { welcomeShown: true } }, 'undefined values are left out');
  assert.deepStrictEqual(JSON.parse(FR.welcomeConfigJson(null)), { general: { welcomeShown: true } });
  assert.deepStrictEqual(JSON.parse(FR.welcomeConfigJson('x')), { general: { welcomeShown: true } }, 'not an object: ignored');
  const hostile = JSON.parse('{"__proto__": {"polluted": true}, "toolbarLayout": 1}');
  assert.strictEqual(({}).polluted, undefined);
  assert.deepStrictEqual(JSON.parse(FR.welcomeConfigJson(hostile)), { general: { toolbarLayout: 1, welcomeShown: true } }, '__proto__ is not copied');
})();

(function theWelcomeNoteIsTheSameDocumentInBothLanguages() {
  const keys = { ask: 'Cmd+L', palette: 'Cmd+Shift+P', settings: 'Cmd+,', search: 'Cmd+Shift+F', preview: 'Cmd+P', save: 'Cmd+S', scrapDir: '~/Documents/md-memo/scraps' };
  const en = FR.welcomeNote('en', keys);
  const ja = FR.welcomeNote('ja', keys);

  assert.strictEqual(en.title, 'Welcome');
  assert.strictEqual(ja.title, 'ようこそ');
  assert.strictEqual(en.cursorPos, 0, 'read from the top');
  assert.strictEqual(ja.cursorPos, 0);

  const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
  assert.ok(!JAPANESE.test(en.title + en.content), 'the English note has no Japanese');
  assert.ok(JAPANESE.test(ja.content), 'the Japanese note is Japanese');
  assert.ok(!/[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/.test(ja.content.replace(/`[^`]*`/g, '')), 'no leftover English sentence in the Japanese note');
  assert.ok(!/\p{Extended_Pictographic}/u.test(en.content + ja.content), 'no emoji');

  for (const note of [en, ja]) {
    assert.ok(/^# /.test(note.content), 'it starts with a heading');
    assert.ok(!/\{(ask|palette|settings|search|preview|save|scrapDir)\}/.test(note.content), 'every placeholder was filled');
    // What the request asks it to say: how to write, ask the AI, the palette, Settings, search, and where notes are.
    for (const shown of ['`Cmd+L`', '`Cmd+Shift+P`', '`Cmd+,`', '`Cmd+Shift+F`', '`Cmd+P`', '`Cmd+S`', '`~/Documents/md-memo/scraps`']) {
      assert.ok(note.content.indexOf(shown) !== -1, shown + ' is in the note');
    }
    assert.ok(note.content.split('\n').filter((l) => /^## /.test(l)).length >= 4, 'four sections: write, ask, around, where');
  }
  assert.ok(/AI Models/.test(en.content) && /Ollama/.test(en.content), 'the English note points at the model set-up');
  assert.ok(/AIモデル/.test(ja.content) && /Ollama/.test(ja.content), 'and so does the Japanese one');
  assert.ok(/Settings > Sync/.test(en.content) && /設定 > 同期/.test(ja.content), 'both name the tab that holds the folder');
})();

(function aMissingShortcutFallsBackToTheDefault() {
  const note = FR.welcomeNote('en', { ask: '', palette: '   ', settings: undefined });
  assert.ok(note.content.indexOf('`Ctrl+L`') !== -1, 'blank -> default');
  assert.ok(note.content.indexOf('`Ctrl+Shift+P`') !== -1);
  assert.ok(note.content.indexOf('`Ctrl+,`') !== -1);
  assert.ok(note.content.indexOf('`Ctrl+Shift+F`') !== -1, 'unset -> default');
  assert.ok(note.content.indexOf('`~/Documents/md-memo/scraps`') !== -1, 'the folder falls back too');
  assert.ok(FR.welcomeNote('fr', {}).title === 'Welcome', 'an unknown language gets English');
  assert.ok(FR.welcomeNote(undefined, undefined).content.length > 300);
  // A shortcut is text to put into the note: it must not be read as a replacement pattern.
  const odd = FR.welcomeNote('en', { ask: '$&$1', scrapDir: 'C:\\Users\\me\\$notes' });
  assert.ok(odd.content.indexOf('`$&$1`') !== -1 && odd.content.indexOf('`C:\\Users\\me\\$notes`') !== -1, 'inserted as it is');
})();

(function theDefaultModelIsExactlyOllamaQwen() {
  const def = { baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest', apiKey: '' };
  assert.strictEqual(FR.isDefaultTextModel(def), true);
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'http://localhost:11434/', model: 'qwen2.5:latest' }), true, 'a trailing slash');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: ' HTTP://LOCALHOST:11434 ', model: ' Qwen2.5:Latest ', apiKey: '  ' }), true, 'case and blanks');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'http://localhost:11434', model: 'gemma4:latest', apiKey: '' }), false, 'another local model');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'http://192.168.1.5:11434', model: 'qwen2.5:latest', apiKey: '' }), false, 'another server');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:latest', apiKey: '' }), false, 'typed by hand: not untouched');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest', apiKey: 'sk-x' }), false, 'a key means a choice was made');
  assert.strictEqual(FR.isDefaultTextModel({ baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: 'k' }), false);
  assert.strictEqual(FR.isDefaultTextModel({}), false, 'an empty model is the "not set up" banner, not this choice');
  assert.strictEqual(FR.isDefaultTextModel(null), false);
})();

(function theChoiceIsOfferedUntilOneIsMade() {
  const def = { baseUrl: 'http://localhost:11434', model: 'qwen2.5:latest', apiKey: '' };
  assert.strictEqual(FR.shouldOfferAiChoice({}, def), true, 'no choice yet, default model');
  assert.strictEqual(FR.shouldOfferAiChoice(undefined, def), true, 'an old config has no general.aiChoiceMade');
  assert.strictEqual(FR.shouldOfferAiChoice({ aiChoiceMade: false }, def), true);
  assert.strictEqual(FR.shouldOfferAiChoice({ aiChoiceMade: true }, def), false, 'made: never again');
  assert.strictEqual(FR.shouldOfferAiChoice({}, { baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' }), false, 'the model was changed: a choice was made');
  assert.strictEqual(FR.shouldOfferAiChoice({}, { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-latest', apiKey: 'k' }), false);
})();

console.log('first_run tests passed');
