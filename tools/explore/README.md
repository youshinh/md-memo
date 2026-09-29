# explore: a headless kit for exploring the real frontend

Drives the real `frontend/` (the same files the app ships) in a **headless** Edge, on top of the docshots harness
(`tools/docshots/server.mjs`, `mock/backend.js`, `cdp.mjs`). Meant for exploratory testing by a person or an agent
(see `docs/testing/exploratory-test-plan.md`): open panels, press keys, make the AI fail or answer twice, make a save fail,
put things on a clipboard, and read back what the app did.

- No window. Each session has its own browser with its own temporary profile and its own local server on a dynamic port, so
  many sessions can run at once (three parallel sessions were ready in about 1.8 s).
- Nothing real is touched: `md-memo.exe` is never started, the real `config.json` / notes / clipboard are never read, and
  every request that leaves the local server is blocked by the mock.
- The browser is stopped through its own process id (found via `SystemInfo.getProcessInfo`), never by image name, and its
  profile folder is removed. `process.on('exit')` and Ctrl+C sweep any session that was not closed.
- What it cannot tell you: how the real WebView2 window behaves, native dialogs, IME, the OS clipboard, macOS, screen readers, a
  real Ollama / Gemini. The model, the file system and the dialogs are stand-ins (see below).

Needs Node 24 and Microsoft Edge (`EDGE_PATH` overrides the location); Windows only, like the docshots harness it is built on. No npm packages.

## Quick start

```js
import { startExplore } from './tools/explore/kit.mjs';   // run from the repository root

const s = await startExplore({
  lang: 'en',
  notes: [{ title: 'sync.md', content: '# Team sync\n\nLaunch date is still open.\n' }],
  llm: { mode: 'fail' },
});
try {
  await s.ev('(function(){var e=document.getElementById("editor"); e.focus(); e.setSelectionRange(0, 11);})()');
  await s.key('l', { ctrl: true });                          // the ask bar
  await s.type('make it shorter');
  await s.key('Enter');
  await s.waitFor("!document.getElementById('inline-prompt-error').classList.contains('hidden')");
  console.log(await s.state());
  await s.shot('out/ask-failed.png');
} finally {
  await s.close();                                           // always: stops the browser, removes the profile
}
```

`node tools/explore/smoke.mjs [--ja] [--shot out.png]` runs a short session like this one (an answered ask, then a failed ask)
and prints the state. About 3.5 s.

## API

`startExplore(opts)` resolves when the app is ready and returns a session `s`.

| Option | Meaning |
|---|---|
| `lang` | `'en'` (default) or `'ja'`: the UI language. |
| `notes` | `[{ title, content, path?, cursor? }]` replaces the demo notes. No `path` = an unsaved note. `[]` = no restored tabs. Omitted = the three docshots demo notes. |
| `config` | Deep overrides of the mocked config, e.g. `{ text: { baseUrl: 'https://api.openai.com/v1', apiKey: '' } }` (an unconfigured AI), `{ general: { autoSave: false } }`. Objects merge, arrays and scalars replace. |
| `viewport` | `{ w, h }`, default 1120 x 720. |
| `llm` | Initial LLM mode, see below. Default `{ mode: 'ok' }`. |
| `backend` | Same as `s.setBackend(...)`, applied once at start. |
| `fresh` | `true` = the state of a first launch: nothing saved (no config, so `config` is ignored; no restored notes unless you pass `notes`), the calm header, the language from the browser. For exploring what a new person sees. |

| Method | What it does |
|---|---|
| `s.key(key, {ctrl, shift, alt, meta})` | One real key event through CDP. Names: `Enter Escape Tab Backspace Delete Insert Home End PageUp PageDown Arrow* F1..F12`, `' '`, or one character (`'l'`, `'?'`); aliases `Esc Return Space Del Up Down Left Right`. `Ctrl/Cmd+C/X/V` and `Shift+Insert` never reach the OS clipboard: they run against the fake one (see below). |
| `s.type(text, {delayMs, insert})` | One key event per character (keydown, input, keyup), `\n` is Enter, `\t` is Tab; a character with no US key (Japanese, emoji) is inserted as text. `insert: true` inserts the whole text in one step (fast, no key events). |
| `s.ev(jsExpr)` | Evaluates in the page and returns the value (a promise is awaited). Errors carry the expression. |
| `s.waitFor(jsCond, {timeout})` | Polls until the expression is truthy (default 8 s). A time-out error also says the status text, the last toasts, the open panels and the pending LLM count. |
| `s.state()` | A snapshot, below. |
| `s.shot(path)` | Saves a PNG of the page (creates the folder) and returns the absolute path. |
| `s.setLlm({mode, ...})` | Replaces the LLM mode for requests from now on. |
| `s.setBackend(overrides)` | Fault injection for the mocked `window.backend`, below. |
| `s.close()` | Stops the browser and the server, removes the profile. Returns `{ processGone, profileGone }`. Safe to call twice. |

Also on the session: `s.page` (the docshots `Page`, for anything the kit does not cover: mouse clicks with `s.page.click(x, y)`),
`s.lang`, `s.viewport`, `s.base` (the local URL).

### `s.state()`

```js
{
  tabs: [{ id, title, dirty, path, content }],   // content is the live text of every tab
  activeTabId,
  editor: { value, selectionStart, selectionEnd }, // the primary editor (#editor)
  panels: { ask, cli, quickActions, palette, search, settings,   // true = visible
            confirm, tasks },                                    // confirm = the Save / Don't save dialog, tasks = the task panel (Alt+T)
  statusText,                // the status-bar message right now
  toasts: [ ... ],           // the last 20 status-bar messages (every showMessage), oldest first
  pendingLlm,                // AI requests the app is still waiting for (the status-bar count)
  consoleErrors: [ ... ],    // console.error, uncaught exceptions, failed resource loads, since the session started
  consoleWarnings: [ ... ],  // console.warn
}
```

`panels.search` is true for the find / replace bar and for the scraps search dialog. Anything else is one `s.ev(...)` away, for
example the ask bar's banner: `s.ev("document.getElementById('inline-prompt-error-text').textContent")`.

### LLM modes (`llm` option, `s.setLlm`)

The mocked `queryLLMAsync` (and `queryVisionAsync`, for pasted images) answers through `window.__onLLMResult`, like the Go side.
`delayMs` defaults to 200; `reply` defaults to `Reply {n}.` (`{n}` = the request number, `{id}` = the request id).

| `mode` | Answer |
|---|---|
| `ok` | `reply` after `delayMs`. |
| `fail` | An error after `delayMs`: `error` (default: the Japanese "connection refused" line an absent Ollama gives). |
| `slow` | `reply` after `delayMs` (default 5000). |
| `never` | No answer at all (the app's own 180 s watchdog eventually fails it). |
| `double` | `reply`, then `reply2` (default `Second reply {n}.`) `gapMs` (default 100) later. |
| `think` | Only `<think>...</think>`. |
| `huge` | `lines` (default 20000) lines of text. |
| `fenced` | `reply` wrapped in a ` ```markdown ` fence. |
| `empty` | An empty string. |

### `s.setBackend(overrides)`

Keys are backend function names (`saveFile`, `saveFileAs`, `openFile`, `readFileByPath`, ...) with a fault, or `null` to remove it:

```js
await s.setBackend({ saveFile: { fail: 'disk full' } });                    // rejects with Error('disk full')
await s.setBackend({ saveFile: { fail: 'busy', times: 2 } });                // only the first 2 calls fail, then the original
await s.setBackend({ saveFileAs: { result: { path: 'C:\\x\\a.md', title: 'a.md', success: true } } });   // resolves this (the mock's default is "cancelled")
await s.setBackend({ readFileByPath: { delayMs: 3000 } });                   // slow, then the original
await s.setBackend({ checkOllamaRunning: { never: true } });                 // never settles
await s.setBackend({ saveFile: null });                                      // fault removed
await s.setBackend({ readOnlyPaths: ['C:\\Users\\demo\\Documents\\notes\\'] });   // saveFile to these paths (or below a folder) rejects "Access is denied."
await s.setBackend({ clipboard: { text: 'plain', html: '<b>rich</b>', image: true } });   // image: true = a 16x16 PNG, or a data: URL
```

Several keys can go in one call. A fault is `{ fail: 'message' }`, `{ result: value }`, `{ never: true }`, optionally with `delayMs` and `times`.

The fake clipboard is what `navigator.clipboard.readText / read / writeText / write`, Ctrl+V, Ctrl+C and Ctrl+X use. A paste is a
synthetic `paste` event carrying the `text/plain`, `text/html` and image file (like the docshots `smartPaste` setup); when the app
does not take it, the text is inserted the way the browser would. Read the clipboard back with `s.ev('__explore.clip')`.

### Records inside the page (`window.__explore`)

`toasts` (`[{text, at}]`, every status-bar message), `llmLog` (`[{seq, kind, reqId, prompt, cfg, mode, answers: [{at, chars, error}]}]`, every
LLM request and how it was answered), `clip`, `faults`, `reset()` (clears `toasts` and `llmLog`), `hookErrors`. Recording starts when
`startExplore` resolves. The mock's own call log is `__docshot.calls`.

## Recipes

```js
// The AI answers twice and the note must not be written twice
await s.setLlm({ mode: 'double' });

// The first Ctrl+L on a machine with no model
const s = await startExplore({ config: { text: { baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: '' } } });

// A note the disk refuses to save
await s.setBackend({ saveFile: { fail: 'disk full' } });   // then Ctrl+S, then read s.state().toasts and tabs[0].dirty

// Two sessions at once (dynamic ports, separate profiles)
const [a, b] = await Promise.all([startExplore({ lang: 'en' }), startExplore({ lang: 'ja' })]);
```

## Notes for whoever explores with it

- Explore, do not fix: write down what you see (the plan's "noticing types"), keep the evidence (`s.shot`, the `s.state()` dump).
- A `never` request stays pending in the app until its 180 s watchdog; for a clean second run start a new session.
- The clock is the docshots one (2026-09-18 10:24, running). The mock has no real file system: `readFileByPath` answers from the notes
  you passed (`path` set), `saveFile` succeeds unless you inject a fault.
- `s.key` cannot reach the page with the shortcuts the browser itself reserves: **Ctrl+N, Ctrl+T (and Ctrl+W)** are swallowed before the
  page sees a keydown (checked with a capturing `keydown` listener; Ctrl+P, Ctrl+L, Ctrl+, and the rest arrive). Open a note with the
  "+" button (`#btn-new-tab`, a real click through `s.page.click`) or the palette entry instead. `s.key('n', { ctrl: true })` does nothing.
- If a run is killed hard, look for leftovers by their profile folder name:
  `Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*explore-profile-*' }` (PowerShell) and remove `%TEMP%\explore-profile-*`.

## Related: the request lifecycle fuzz test

`tests/ai_lifecycle_fuzz_test.mjs` does not use this kit (no browser): it runs the real `app.js` in a hand-made DOM (the harness of
`tests/ask_and_command_bar_test.mjs`, plus an undo history) and drives random, seeded sequences of ask, rewrite, answer, failure, late or
repeated answer, cancel, undo, tab switch / close / open, Escape and Retry, then checks that nothing is left behind and the notes hold exactly
what the answers imply. About 1 s for 300 sequences. `--seed N` replays one with its trace (`--dump` shows every step), `--ops "..."`
replays explicit steps, `--count` / `--steps` / `--base` make a bigger or different run. The bugs it has found are listed at the top of that
file (KNOWN_FAILURES) with a minimal replay each.

## Related: the smoke tests

`tests/smoke/` holds 12 short flows on top of this kit, judged on the DOM and the app state (no pictures): the main path (new note, type,
ask, answer with the change band, save), a failed ask, an ask with no model, the command bar, the palette, search, Settings, the tab
overflow list, About, the Welcome note on a first start, the status-bar AI popover, and Ctrl+Z after an answer.
`node tests/smoke/run.mjs` runs each flow in its own session (3 at a time, about 20 s in all; `--jobs 1` about 35 s), prints PASS / FAIL and
exits 1 on a failure; `--lang ja` runs them in the Japanese UI, `--only <text>` picks flows, `--shots <dir>` saves a screenshot of a failed
flow, `--list` lists them. A flow also fails when the page logs an uncaught error. An app problem a flow already knows about is marked with
`t.knownIssue(reason, fn)` (the flow still passes, the run lists it, and says when it starts passing) or `knownFailing` on the whole flow.
They are not part of `tools/run_js_tests.mjs`; `tests/smoke_suite_shape_test.mjs` (no browser) only checks the flow files are well formed.
The helpers are in `tests/smoke/lib.mjs`; `reloadAs(s, { firstLaunch })` reloads the mocked app as a first launch (Welcome note) or the
second start of a profile.

## Files

| File | Purpose |
|---|---|
| `kit.mjs` | `startExplore`, key events, the headless launcher, the session API. Also exports `keyEvents` and `clipboardAction` (pure, tested). |
| `page_hooks.js` | Injected before any page script: boot overrides, fault injection, toast / LLM records, fake clipboard, `state()`. |
| `smoke.mjs` | The short session above. |
| `../../tests/ai_lifecycle_fuzz_test.mjs` | The lifecycle fuzz test (see above). |
| `../../tests/explore_kit_test.mjs` | Hermetic tests (no browser): key mapping, the in-page hooks in a stub DOM. |
| `../../tests/smoke/` | The smoke flows and their runner (see above): `run.mjs`, `lib.mjs`, `NN_*.mjs`. |
| `../../tests/smoke_suite_shape_test.mjs` | Hermetic check (no browser) that every smoke flow file is well formed. |
