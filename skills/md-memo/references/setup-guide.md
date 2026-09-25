# Configuring MD-Memo on the user's behalf

Basis: app 1.7.2, source of 2026-09-21 (commit a85494c or later); the keys and checklist rows for the hot folder (`inbox.*`), `vision.ocrMode`, `voice.engine`, `voice.whisper.*`, `shortcuts.quickCapture` and `md-memo ocr` come from the source of 2026-09-24. `(unverified)` = not checked in this repository's source (OS behaviour or an external tool). Read `interfaces.md` first for what each surface does.

Notation: `<cfg>` = `%AppData%\md-memo\` (Windows, i.e. `C:\Users\<user>\AppData\Roaming\md-memo\`) or `~/Library/Application Support/md-memo/` (macOS). Linux has no window layer and is not supported.

---

## (a) Procedure

1. Find out the state.
   - Files: `<cfg>/config.json` (may not exist on a fresh install), `<cfg>/agents.yaml` (may not exist), `<cfg>/ipc-session.json` (exists only while running).
   - Running? Windows: `Get-Process md-memo -ErrorAction SilentlyContinue`; macOS: `pgrep -x MD-Memo`. Do not use `md-memo` commands with side effects to probe (a bare `md-memo` would START the app). `md-memo tab list` is a safe probe: it fails with `md-memo is not running` when nothing runs.
   - Windows closes to the tray by default (`general.trayResident: true`): closing the window does NOT quit. To really quit the user must use tray icon -> Quit (or Ctrl+W on the last tab, which exits). macOS: the close button hides the window; Cmd+Q quits. Ask the user to do it. Do not kill the process. (A graceful quit exists, `md-memo ui eval "window.backend.forceQuit()"`, but it is `ui eval`; use it only with the user's explicit consent. Whether unsaved buffers survive is unverified; the session file is written continuously, about 500 ms after each edit.)
2. Back up before every edit: copy `config.json` and `agents.yaml` next to the originals as `config.json.bak-<yyyymmdd-hhmmss>` / `agents.yaml.bak-...`. Backups contain API keys: keep them in `<cfg>`, never in a repository, never in a report.
3. Edit `config.json` ONLY while MD-Memo is fully closed. If it is running, do not edit; tell the user to restart. Reasons (all verified):
   - The frontend copies `config.json` into memory once at startup. Browser storage holds an older copy that is applied first; the file then overrides it key by key (shallow `Object.assign` per section). Deleting a key from the file therefore does NOT reset it (the browser-storage value survives and is written back): set the explicit default value instead.
   - Any UI save rewrites the whole file from the in-memory config: Settings -> Save, and also clicking the status-bar `Predict`, `Autosave`, `IME` or `Action` badges, and the Ollama setup completion. Edits made on disk while running are lost at the next of those. Top-level keys the frontend does not know are dropped by such a save (unknown keys INSIDE known sections survive).
   - Go reads some keys straight from the file: scraps/git settings (`InitScrapEngine`: at start-up and on Settings Save), `action.*` (Jev client: same), `shortcuts.globalSummon` and, on Windows, `shortcuts.quickCapture` (both registered at start; later changes go through the Settings UI), `inbox.*` (the hot folder watcher: at start and whenever a Settings Save changes them; the `vision` and `voice` settings are read again for every file it handles), and `general.trayResident` (re-read from a stat-checked cache on every window close, so an on-disk change is seen without a restart, until the next UI save overwrites it). `md-memo ocr` also reads `config.json` itself, on every call (`scrap_dir` and `vision`).
4. `agents.yaml` may be edited while running, with one caveat. The backend re-stats it on every slot run (mtime/size cache), so changed `agents` commands/args take effect on the next run. The frontend keeps its own copy (quick selector list, floating Run-button delimiter detection, the alias names Ctrl+Enter recognises, the snippet list) loaded at startup: restart after changing notations (`slot_profiles` / `recipes`), `aliases` or `snippets` so that the `{{` list, the palette list and short-word (Tab) expansion see them. Running a `{{ @alias }}` task does not need the restart (Go resolves the agent from the file at run time), and the command bar's candidate list re-reads the file each time the bar opens.
5. Write valid, BOM-free UTF-8. `config.json` is parsed by Go `encoding/json` and by `JSON.parse`; a BOM breaks both. Keep mode 0600 on macOS. Pretty-printing is fine (the app re-serialises as one compact line on its next save; comments are impossible in JSON).
6. Validate after editing: JSON - `python -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" <file>` or `jq . <file>`; YAML - any YAML linter. A broken `agents.yaml` is silently ignored and the built-in defaults are used (no error is shown), so a lint pass is mandatory, and after the restart confirm in Settings -> Agent that your custom agents appear.
7. Ask the user to start MD-Memo normally (Start menu, Finder, tray). Then verify each feature with the checklist in (e).
8. Report what changed with keys redacted (`apiKey: set (...last4)`), which items need a restart, and what could not be verified.

File locations:

| Item | Windows | macOS |
|---|---|---|
| `<cfg>` | `%AppData%\md-memo` | `~/Library/Application Support/md-memo` |
| default scraps folder | `%USERPROFILE%\Documents\md-memo\scraps` | `~/Documents/md-memo/scraps` |
| default hot folder (`inbox.dir` empty) | `%USERPROFILE%\Documents\md-memo\inbox` | `~/Documents/md-memo/inbox` |
| Whisper program and models (on-device speech engine) | `%LOCALAPPDATA%\md-memo\components` (Windows x64 only) | not available |
| WebView profile (browser storage) | `%LOCALAPPDATA%\md-memo\webview` | WKWebView default store (path unverified) |
| binary | unzipped from the release zip `md-memo-windows-x64.zip` into any folder (a winget manifest exists in `packaging/winget` but is not published to winget-pkgs yet; dev tree: `md-memo.exe`) | `/Applications/MD-Memo.app/Contents/MacOS/MD-Memo`, symlinked to `md-memo` by the Homebrew cask |
| process name | `md-memo.exe` | `MD-Memo` |

---

## (b) `config.json` schema

One JSON object. Sections are shallow-merged over the defaults below, so a file may contain only the keys it changes. "UI" = editable in Settings; "file only" = no UI control. Defaults are the `config` object at the top of `frontend/js/app.js` unless another source is named.

### Text LLM, ghost text, vision, CLI, image

| Key | Type | Default | Meaning / notes |
|---|---|---|---|
| `text.baseUrl` | string | `http://localhost:11434` | Endpoint for Ask AI (Ctrl+L) / Alt+C / Mermaid conversion / prompt presets / the Auto selector's LLM tasks (`[[ @llm ]]`, Ctrl+Enter). Protocol is inferred (`llm.DetectProvider`): Gemini if the URL contains `googleapis.com` or the model contains `gemini`; else OpenAI-compatible (`/chat/completions` under `<base>/v1`) if the URL contains `/v1`, `:1234`, `:8080`, `openai.com`, `groq.com`, `together.xyz`, or ANY API key is set; else Ollama `/api/generate` (with an OpenAI-shape fallback). Note: setting an API key on a non-Gemini URL forces the OpenAI shape. |
| `text.model` | string | `qwen2.5:latest` | Model name (Go uses the same default when blank). |
| `text.apiKey` | string | `""` | Secret. Empty is fine for local servers. |
| `text.systemPrompt` | string | `You are a helpful assistant. Provide concise, accurate markdown responses.` | Sent as system prompt (Gemini: prepended to the prompt). |
| `text.temperature` | number | unused | Accepted by `llm.Config` but never sent in text requests. |
| `autocomplete.enabled` | bool | `true` | Ghost text on/off (also toggled by the status-bar `Predict` badge). |
| `autocomplete.baseUrl` | string | `http://localhost:11434` | Same protocol inference; completion endpoints are chosen by `QueryAutocomplete` (see `interfaces.md` 3.2). |
| `autocomplete.model` | string | `qwen2.5:latest` | Small/fast model recommended. |
| `autocomplete.apiKey` | string | `""` | Secret. |
| `autocomplete.delayMs` | number | `500` | Pause before a request. UI range 200-2000, but the effective floor is 300 ms (`Math.max(delayMs \|\| 600, 300)`). |
| `autocomplete.maxTokens` | number | `30` | UI range 10-100; Go replaces values <= 0 or > 250 with 30. |
| `vision.baseUrl` | string | `https://generativelanguage.googleapis.com` | OCR endpoint (paste OCR, Mobile Drop photos). Local if the URL contains `11434`, `:1234` or `:8080` (and not `/v1beta`): OpenAI-vision shape at `<base>/v1/chat/completions`; Gemini if the URL contains `googleapis.com`/`/v1beta`, the model contains `gemini`, or the URL is empty; else OpenAI-vision shape. |
| `vision.model` | string | `gemini-flash-lite-latest` | Suggestions in UI: `qwen2.5-vl:latest` (Ollama). |
| `vision.apiKey` | string | `""` | Secret. Also the fallback key for voice and (after `image.apiKey`) image generation. Required for Gemini; the app also refuses keyless calls to `openai.com`, `groq.com`, `together.xyz`, `openrouter.ai` with a "not configured" error, while local servers still work without a key. |
| `vision.prompt` | string | `Transcribe the content of this image (text, diagrams, tables, code, etc.) into structured, faithful Markdown format.` | If empty Go uses a Japanese equivalent. |
| `vision.systemPrompt` | string | unused | Accepted, not sent. |
| `vision.ocrMode` | `""` \| `"on-device"` | `""` | Who reads images in the hot folder, Screen Capture, the Send To entry and `md-memo ocr` (NOT the paste OCR of Ctrl+V, which always uses the vision model above). `""` (or `"auto"`) = the cloud vision model of `vision.*` first, the on-device engine as the fallback; `"on-device"` = the on-device engine only, the image never leaves the PC (less accurate). Windows only: macOS has no on-device engine, the Settings checkbox "Keep images on this PC" (Settings -> Sync -> Hot Folder) is hidden there and Settings Save leaves the key alone. |
| `cli.model` | string | `""` | Model that writes the command when the Command Bar is in AI mode (Ctrl+E opens the bar, Tab or the badge switches modes); empty = `text.model`. UI: Settings -> Agent -> "Commands (Run)". |
| `cli.baseUrl` | string | `""` | Empty = `text.baseUrl`. File only. |
| `cli.apiKey` | string | `""` | Empty = `text.apiKey`. File only. Secret. |
| `cli.systemPrompt` | string | `""` | Appended after the built-in command-writer prompt as "User Custom Instruction". File only. |
| `cli.openResultInNewTab` | bool | `true` | Command-bar success: open a result tab (a selection still gets the output, placed as `cli.resultPlacement` says). UI. |
| `cli.resultPlacement` | string | `"below"` | Command-bar output placement when it goes into the note: `below` = on a new line under the input, which stays (nothing is added when the output is the same text as the input); `replace` = over the input (the classic filter). Anything else counts as `below`. Settings -> Agent -> Commands. |
| `cli.openErrorInNewTab` | bool | `true` | Command-bar failure: open an error tab. File only. |
| `image.apiKey` | string | (absent) | Gemini key for "Render Image"; empty -> `vision.apiKey` -> `text.apiKey`. Secret. |
| `image.model` | string | `gemini-3.1-flash-lite-image` | Also `gemini-3.1-flash-image`, `gemini-3-pro-image`; a model starting `imagen-` uses the `:predict` endpoint. |
| `image.aspectRatio` | string | `16:9` | UI: 16:9, 1:1, 4:3, 3:4, 9:16 (Go maps more). |
| `image.resolution` | string | `1024` | `512`, `1024`, `2048`, `4096`; ignored for `flash-lite` models. |
| `image.baseUrl` | string | (absent) | File only. Local or `http://` values are ignored: falls back to `vision.baseUrl` when that is https and non-local, else Google. |

### Voice input (`voice`)

The maintainer's shape for this change (Go side `pkg/llm/audio.go` and the frontend `app.js` / `voice_input.js` / `index.html`; builds before commit a85494c had the old shape `model`, `silence_timeout_sec`, `prompt`, `baseUrl`, `apiKey` with an older Flash model as the default, and a config saved by such a build keeps its stored `model`, which stops working when Google retires that model: change it to `gemini-3.5-transcribe`):

```json
"voice": {
  "model": "gemini-3.5-transcribe",
  "apiStyle": "auto",
  "baseUrl": "",
  "apiKey": "",
  "languageCodes": [],
  "mode": "smart",
  "customVocabulary": [],
  "prompt": "...",
  "silence_timeout_sec": 5
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `voice.model` | string | `gemini-3.5-transcribe` | Go default when blank (`llm.DefaultVoiceModel`). `gemini-3.5-transcribe-live` (WebSocket Live API) is NOT usable for recorded clips; `QueryAudio` refuses any model with a `live` token. Builds before that change defaulted to an older Flash model that Google is retiring: a config that still names it should be changed to this default. |
| `voice.apiStyle` | `auto` \| `interactions` \| `generateContent` | `auto` | `auto` picks `interactions` when the model name contains `transcribe`, else `generateContent`. Anything else is an error ("not configured"). |
| `voice.baseUrl`, `voice.apiKey` | string | `""` | Empty falls back individually to `vision.baseUrl` / `vision.apiKey` (frontend `resolveVoiceConfig`, and the Mobile Drop starter). Both empty everywhere = no key: error. Only Gemini hosts/models are accepted. |
| `voice.languageCodes` | string[] | `[]` | BCP-47 hints such as `["ja-JP"]`; empty = auto-detect. Interactions style only. |
| `voice.mode` | `smart` \| `verbatim` | `smart` | Interactions style only. |
| `voice.customVocabulary` | string[] | `[]` | Terms to bias recognition; interactions only; blank and duplicate entries dropped; Go caps at 1000; keep it at 100 or fewer (maintainer guidance, not enforced). |
| `voice.prompt` | string | Japanese "transcribe accurately, no preamble" prompt | Used ONLY by the `generateContent` style. |
| `voice.silence_timeout_sec` | number | `5` | Frontend auto-stop after this much silence; UI range 1-30. |
| `voice.refine.enabled` | boolean | `true` | Second stage of live voice input (Ctrl+Shift+R only; not the hot folder, Discord or Mobile Drop): a Gemini model tidies the transcript (fillers, self-corrections, the caret line's list/task/table syntax; `voice.customVocabulary` is a spelling hint). With text selected, the transcript is an edit instruction for the selection, which is sent to Gemini (up to 8000 characters). On failure or timeout the transcript is inserted as spoken; a failed rewrite restores the selection. Toggled by the status-bar badge or the `voiceRefineToggle` shortcut; `voiceInputRaw` skips it for one recording. |
| `voice.refine.model` | string | `gemini-flash-lite-latest` | Gemini models only (`llm.DefaultRefineModel`). |
| `voice.refine.timeoutSec` | number | `5` | UI range 1-30 (`llm.DefaultRefineTimeoutSec`). |
| `voice.engine` | `""` \| `"gemini"` \| `"whisper-local"` | `""` (= Gemini) | Who transcribes audio files: the hot folder and the Discord bridge only. Live voice input (Ctrl+Shift+R) and Mobile Drop always use Gemini and ignore this. `"whisper-local"` = on-device Whisper, Windows x64 only (Settings -> AI Models -> Voice -> Engine, "Whisper (on this PC, offline)"); nothing is sent out then unless `voice.whisper.cloudFallback` is true. The Whisper program and a model must be downloaded first, from the Settings panel only (checklist (e), row "On-device Whisper"). |
| `voice.whisper.model` | string | `""` (= `kotoba-v2.0-q5_0`) | Catalog id: `kotoba-v2.0-q5_0` (kotoba-whisper v2.0 quantized, Japanese-specialised, about 513 MB), `kotoba-v2.0` (full precision, about 1.4 GB), `large-v3-turbo-q5_0` (multilingual, about 547 MB), `small-q5_1` (about 181 MB), `base` (about 141 MB, lowest accuracy); or `custom-path` (use `modelPath`) / `custom-url` (download `customUrl`). |
| `voice.whisper.modelPath` | string | `""` | `custom-path` only: a ggml `.bin` Whisper model file already on the PC. |
| `voice.whisper.customUrl`, `voice.whisper.customSha256` | string | `""` | `custom-url` only: an `https` URL of a ggml model and an optional expected SHA-256 (hex) that the download is verified against. |
| `voice.whisper.language` | string | `""` | Empty or `auto` = detect; otherwise a Whisper language code such as `ja` or `en`. |
| `voice.whisper.threads` | number | `0` | 0 = automatic. |
| `voice.whisper.prompt` | string | `""` | Initial prompt: names or terms to bias recognition toward. |
| `voice.whisper.cloudFallback` | bool | `false` | When true and the local engine fails or is not installed, the audio is retried with Gemini (it is sent out; that is why it is off). |

Wire formats (from `pkg/llm/audio.go`, verified in source):
- `interactions`: `POST {baseUrl}/v1beta/interactions` (default host `https://generativelanguage.googleapis.com`), header `x-goog-api-key: <key>`, body `{"model":"gemini-3.5-transcribe","store":false,"input":[{"type":"audio","data":"<base64>","mime_type":"audio/webm"}],"generation_config":{"transcription_config":{"mode":"smart"|{"type":"verbatim"},"language_codes":[...],"custom_vocabulary":[...]}}}`. `store` is always `false` so Google does not keep the recording. Success needs `status` empty or `completed`; text is `output_text`, else the `text` items of `model_output` steps.
- `generateContent`: `POST {baseUrl}/v1beta/models/<model>:generateContent?key=<key>` with an inline-data audio part plus `voice.prompt`.
- Frontend: `VoiceInput.resolveVoiceConfig` fills defaults (`model` `gemini-3.5-transcribe`, `apiStyle` `auto`, `mode` `smart`, empty lists; a hand-edited string in `languageCodes` is split on commas/newlines, in `customVocabulary` on newlines) and `requestConfigJSON` forwards `baseUrl, apiKey, model, apiStyle, prompt, languageCodes, mode, customVocabulary, timeout` (PC recording uses `timeout` 30 s, Mobile Drop 0 = backend default). The Settings pane has fields for model, API style, language codes (comma separated), mode, custom vocabulary (one per line, "up to 100 recommended"), silence timeout and prompt; there is no voice key/URL field, so a separate voice key exists only if written into `config.json`. Saving the pane writes `languageCodes` and `customVocabulary` back as arrays. If you find any of this missing when you read the code, trust the code.

### Quick Actions, general, scraps, shortcuts

| Key | Type | Default | Meaning / notes |
|---|---|---|---|
| `action.enabled` | bool | `true` | Quick Actions master switch (badge in the status bar). |
| `action.manualOnly` | bool | `false` | No auto popup; Ctrl+J only. |
| `action.delaySec` | number | `1.5` | Pause before the auto popup; UI 0.5-10. |
| `action.baseUrl` | string | `https://openrouter.ai/api/v1` | With the default and no key nothing leaves the machine. `https://api.typesafe.ai` (also `/v1`, `/v1/systemone`) plus a TypeSafe key uses Jev at TypeSafe (System One). Any other URL receives `POST <url>/predict` with ~2,000 chars of context. Keep the default for an OpenRouter key. |
| `action.model` | string | `jev-latest` | Model name sent to the engine. A Jev name (`jev-latest`, `jev-*`, `typesafe/jev-*`) makes an OpenRouter key use OpenRouter's System One API; any other name with an OpenRouter key means chat completions (the model writes the candidates). |
| `action.apiKey` | string | `""` | Secret. One field for both services: an `sk-or-...` key is an OpenRouter key, anything else is a TypeSafe key, and it is only sent where the Base URL says (a TypeSafe key next to the OpenRouter Base URL is sent nowhere). The Go side stores it into the Jev client as API key, OpenRouter key and TypeSafe key. Read by Go at start and on Settings Save. |
| `general.language` | `ja` \| `en` | `ja` if the WebView language starts with `ja`, else `en` | UI language; also decides the default of `imeGuardian`. |
| `general.theme` | string | `olive` | `olive`, `blue`, `forest`, `charcoal`. |
| `general.autoSave` | bool | `true` | Save notes bound to a file 1.5 s after the last edit. Applies to RPC writes too. |
| `general.pasteHtmlAsMarkdown` | bool | `true` | Ctrl+V converts clipboard HTML that has structure (table, heading, list, link, ...) to Markdown; code / logs / VS Code content stay plain, and Ctrl+Shift+V always pastes as it is (plain text; an image-only clipboard is saved to `assets/`). false = the old split: Ctrl+V plain, Ctrl+Shift+V converts. Settings -> General. |
| `general.pasteImageOcr` | bool | `true` | Plain Ctrl+V on an image-only clipboard runs OCR. When it is false, or the vision model has no API setup (no `vision.apiKey` for Gemini / hosted services), the image is saved to `assets/` and linked instead, like Ctrl+Shift+V. |
| `general.restoreSession` | bool | `true` | Restore tabs/unsaved buffers from `session.json`. |
| `general.trayResident` | bool | `true` | Windows: close hides to the tray. Read by Go on every close (`isResidentConfigEnabled`). No effect on macOS. |
| `general.splitViewOnStartup` | bool | `false` | Only honoured when `restoreSession` is false. |
| `general.imeGuardian` | bool | `true` when the WebView language starts with `ja`, else `false` (and forced `false` on first run where the OS cannot switch input source, i.e. macOS) | Romaji-to-kana guard, Japanese UI only. |
| `general.aiCorrection` | bool | `true` | Alt+C on/off. |
| `general.cursorAura` | bool | `true` | Idle caret glow. |
| `general.toolbarLayout`, `general.contextMenuLayout` | `{order: string[], hidden: string[]}` | `{order:[], hidden:[]}` | Element ids of toolbar buttons (`btn-mobile-drop`, `btn-search-scraps`, ...) or context-menu items (`ctx-find`, ...). `btn-settings` cannot be hidden. Unknown ids ignored. File or UI. |
| `scraps.scrapDir` | string | `~/Documents/md-memo/scraps` | Folder for daily scraps, search, per-project `.md-memo/agents.yaml`, and Git sync. `~` = user home. DANGER: Git sync runs `git add .` / commit / push in this folder. |
| `scraps.gitSyncEnabled` | bool | `true` | Only acts when the folder is a git repo. |
| `scraps.gitSyncDebounceSeconds` | number | `30` | UI 5-3600. |
| `scraps.gitRemoteBranch` | string | `main` | |
| `scraps.gitRemoteUrl` | string | `""` | Stored only; the remote is configured by the UI's "Link / Init" (runs when this value or the branch changes on Save), not by editing the file. |
| `scraps.maxPipeSizeMB` | number | `10` | NO EFFECT: nothing reads it; the stdin limit is the constant 10 MB. |
| `scrap_dir`, `git_sync_enabled`, `git_sync_debounce_seconds`, `git_remote_branch`, `max_pipe_size_mb` | mirrors | - | Top-level copies written by every Settings Save. Go reads them first and then lets the nested `scraps.*` values override; the frontend reads nested first. Edit the nested key and mirror it here so both sides agree. If `scraps` is absent Go uses the top-level key but the frontend falls back to its built-in default folder: always write both. |
| `inbox.enabled` | bool | `false` | Master switch for the hot folder: images in the watched folder are OCR'd and audio is transcribed, both appended to today's scrap, and the files are MOVED to `<scrapDir>/assets/` (never deleted, even on failure). Windows and macOS (on macOS: cloud OCR and Gemini only). Settings -> Sync -> "Hot Folder (auto OCR & transcription)". Off by default because it moves files and may send them to a cloud model. Read by Go at start and whenever a Settings Save changes `inbox.*` (`InitInboxWatcher`). Details: `interfaces.md` 4.10. |
| `inbox.dir` | string | `""` (= `~/Documents/md-memo/inbox`) | The watched folder; `~` = the user's home. The folder is created if missing. Settings -> Sync (path field with Browse). |
| `discordBridge.enabled` | bool | `false` | Master switch for the Discord bridge: a paired Discord account's DMs to the user's own bot get appended to today's scrap. Polling only (outbound HTTPS, no inbound port, no hosted relay); works even while md-memo is closed, since the poller runs in the Go backend and catches up on the next launch. Settings -> Sync -> "Mobile capture via Discord". |
| `discordBridge.botToken` | string | `""` | Secret, from the Discord Developer Portal (the user's own free bot application) -> Bot -> Reset Token. Stored in `config.json` like the other API keys; never written into `scraps.scrapDir` (which Git sync may push to a remote). |
| `discordBridge.allowedUserId` | string | `""` | The Discord user id (numeric snowflake) allowed to write into the scrap; every other author is silently ignored even if it somehow reaches the bot's DM channel. Found via Discord -> User Settings -> Advanced -> Developer Mode, then right-click the user's own name -> Copy User ID. |
| `discordBridge.pollIntervalSeconds` | number | `45` | How often the running app checks the bot's DM channel for new messages. UI clamps to 15-600; `InitDiscordBridge` applies the same clamp to a value read directly from a hand-edited file. |
| `shortcuts.<action>` | string | see `interfaces.md` 4.1 | Combo such as `Ctrl+Shift+P`. Missing keys get defaults; `""` unassigns. Reserved combos are not rejected in the file (they just do not work; on macOS reserved combos are reset to the default at load). `shortcuts.globalSummon` is registered at start by Go (Windows: one of Ctrl/Alt/Shift/Win plus `A-Z 0-9 F1-F24 Space Enter Esc`; failures are silent at start-up). `shortcuts.quickCapture` is the second OS-wide key, Windows only: it opens the Quick Capture popup (`interfaces.md` 4.10). Default `Ctrl+Shift+Q`; a MISSING key means the default and an explicit empty string `""` means no hotkey; Go registers it at start, and if another program already owns the combination the registration silently fails at start (in Settings it is refused with a toast and the old key comes back). macOS has no such key (default empty, no Settings row). The Command Bar key is `shortcuts.commandBar` (default `Ctrl+E`); on load, a config that still holds the old `llmModal` entry gets its saved `inlinePrompt` of `Ctrl+K` moved to `Ctrl+L` once and `llmModal` dropped; a Ctrl+K assigned afterwards is kept (`interfaces.md` 4.1). |
| `default_agent`, `timeout_seconds`, `hover_peek_enabled`, `ghost_diff_duration_ms` | string, number, bool, number | `claude-code`, `180`, `true`, `4000` | Slot settings the Settings UI writes at top level (timeout UI 10-600, ghost diff 1000-10000). See the precedence note below. |
| `agents`, `slot_profiles`, `recipes` | as in agents.yaml | (built-ins) | Same shape as agents.yaml. Prefer agents.yaml; when an external agents file exists these are only merged as additions. |
| `autoSelector.enabled` | bool | `true` | The Auto selector of Ctrl+Enter (`interfaces.md` 4.1). `false`: Ctrl+Enter only runs `{{ }}`-style slots as before (hand-written `[[ @llm ]]`, `[[ $ ]]` and `{{ @agent }}` tasks still run). UI: Settings -> Agent -> group "Auto selector (Ctrl+Enter)", label "Let Ctrl+Enter decide: ask the AI, hand over to an agent, or run a command". An older config without the `autoSelector` key gets both defaults (a key that holds only one of the two gets the other default). Only the page reads it, Go does not. It travels in the settings package's "Agent & Quick Actions" section (`interfaces.md` 5.2). |
| `autoSelector.agentConfirm` | bool | `true` | `true`: an auto-detected agent or command request is only rewritten (`{{ @agent ... }}` / `[[ $ ... ]]`) and needs a second Ctrl+Enter; `false`: it runs at once after the rewrite. UI: same group, label "Confirm before an auto-detected agent or command runs". |
| `agentAck` | object | absent | Written by the page, not by hand: `{"<agents key>": "v1:<hash>"}`, one entry per agent the user allowed with Run in the confirmation before a risky agent runs (`interfaces.md` 3.1.3). The hash covers the command, the arguments and `append_instruction`, so a changed definition is asked about again. Deleting an entry (app closed) makes the app ask again. Never exported in a settings package, and an imported one is ignored. |
| `agentNotice` | object | absent | Written by the page: `shown` / `dismissed` hold the signature of the set of agent definitions to review for which the start-up message was shown / the Settings box was hidden (`interfaces.md` 3.1.3). Never exported or imported. |
| `llm` | object | absent | Not written by the UI. Go reads it (else the top level) as the model config for the built-in-LLM branch of Quick Actions cards of kind `doc`; see `troubleshooting.md`. |

Precedence for slot settings (verified, `app_slot.go` + `slot_agent.js`):
- Backend runner: if an external agents file exists and parses, it is the base; from config.json only agents that the file lacks and profiles with new `trigger_open` values are added. `timeout_seconds`, `hover_peek_enabled`, `ghost_diff_duration_ms` and `recipes` come from the file alone, so the Settings "Agent timeout" has no effect once an agents file exists (and "Open agents.yaml" creates one). Without an external file the runner uses the frontend's merged config (JS defaults, overlaid by the Go-resolved config loaded at start, overlaid by config.json), with Go defaults filling any empty part.
- Frontend copy: JS defaults, overlaid by the Go-resolved config at start, overlaid by the slot keys present in `config.json`. It drives the quick selector (with its snippet rows), Run-button detection, the agent names and aliases that Ctrl+Enter recognises, Ghost Diff length and Hover Peek.
- If `agents.yaml` omits `hover_peek_enabled` the Go struct's zero value (`false`) is what the app sees: always write `hover_peek_enabled: true`.

Browser-storage keys (WebView profile, per origin incl. port): `md_memo_config_v1` / `md_notepad_config_v3` (config copy), `md_memo_session_v1`, `md_memo_font_size`, `md_memo_cli_history`, `md_memo_cmdbar_mode` (last Command Bar mode, `cli` or `ai`), `md_memo_voice_cache_v1`, `md_memo_workspace_folder`, `mdmemo_dismissed_update_version`.

---

## (c) `agents.yaml`, `jev.json`, `.env`

### Search order and formats

First existing file wins, in this order (a file that exists but is broken is NOT skipped; the app then falls back to built-in defaults):
1. `<scrapDir>/.md-memo/agents.yaml`, `.yml`, `.md`, `.json` (`<scrapDir>` = `scraps.scrapDir` resolved; per-project)
2. `<cfg>/agents.yaml`, `.yml`, `.md`, `.json` (global; "Open agents.yaml" in Settings creates a commented template here if none exists)

This is `FindAgentConfigFile` in `pkg/slotagent/loader.go`: the four names of item 1 are probed in the order yaml, yml, md, json, then the four of item 2, and the first regular file that exists is the only one read. `aliases` and `snippets` come from that file (they are not merged across files). The generated template (written by Settings -> Agent -> "Open agents.yaml" to `<cfg>/agents.yaml` when no file exists) documents `@name` / `aliases` and `snippets` in its header comment and ships them as commented-out examples: `# aliases: [...]` under `claude-code` and `agy`, and a `# snippets:` block at the end (`weekly`, `run-tests`, `disk-free`, `meeting`); remove the leading `# ` to use one.

`.md` files must contain a fenced ```yaml / ```yml / ```json block (or a plain fence containing `agents:` or `slot_profiles:`). On case-insensitive file systems `agents.md` also matches `AGENTS.md`.

### Schema (`pkg/slotagent/config.go`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `version` | int | `2` | |
| `default_agent` | string | `claude-code` | Agent for a notation that names none, and for recipes. |
| `timeout_seconds` | int | `180` | Per agent process (per step for recipes). |
| `hover_peek_enabled` | bool | (false if omitted) | Write it explicitly. |
| `ghost_diff_duration_ms` | int | `4000` | |
| `agents.<name>.command` | string | required | Resolved through PATH by `exec`; no shell. |
| `agents.<name>.args` | string[] | `[]` | `{instruction}` and `{file}` are substituted inside any element; `{instruction}` is appended as the last argument if it appears nowhere (unless `append_instruction: false`). Each element is one argv entry (no quoting needed). Permission-skipping flags (`--dangerously-skip-permissions`, `--yolo`, ...) make MD-Memo ask the user once before the agent runs (`interfaces.md` 3.1.3). |
| `agents.<name>.append_instruction` | bool | absent (= `true`) | `false`: the instruction is not appended when no element holds `{instruction}` (an agent that works from `{file}` alone). Required in practice for a shell command line (`powershell`, `pwsh`, `cmd`, `sh`, `bash`, `zsh`, or a `-Command` / `/c` / `-c` argument): appended note text would run as code there, and Settings -> Agent warns about such a definition until it is set. |
| `agents.<name>.description` | string | `""` | |
| `agents.<name>.aliases` | string[] | built-ins: `claude-code` -> `claude`, `cc`; `agy` -> `antigravity`, `gemini`; others none | Extra names accepted after `@` in `{{ @name ... }}` (case-insensitive); an `agents` key beats an alias. Omitted on a built-in agent: the defaults apply (a default alias that is already another agent's key or alias is skipped). An explicit list, even `[]`, replaces them. See `interfaces.md` 3.1.2. |
| `slot_profiles[].trigger_open`, `trigger_close` | string | required | Choose pairs that do not collide with Markdown. |
| `slot_profiles[].name` | string | | Label / default role. |
| `slot_profiles[].agent` | string | | Key of `agents`. |
| `slot_profiles[].system_instruction` | string | | Prepended as `"<text>\n\nTask: <instruction>"`. |
| `recipes[].trigger_open`, `trigger_close`, `name`, `description` | string | | |
| `recipes[].steps` | string[] | | Run in order by the default agent. |
| `recipes[].requires_approval_step` | int | `0` | 1-based; 0 = never pause. |
| `recipes[].self_refine` | bool | `false` | Step 1 becomes draft -> critique -> revise (max 2 passes). |
| `snippets[]` | list of `{id, label, kind, trigger, body, os, agent}` | `[]` | Ready-made tasks for the `{{` popup, the palette entry "Insert task snippet" and trigger + Tab. `kind` is `llm`, `agent`, `command` or `text`; `os` is `win`, `unix` or `any` (default); `trigger` and `agent` are optional. An item whose `id` equals a built-in's replaces it, a new `id` is added; an item with another `kind` or an empty `body` is dropped. Placeholders in `body`: `${selection}`, `${line}`, `${date}`, `${agent}`, `$0` (`$$0` and `$${` for a literal `$0` and `${`). Field rules, wrapping and the built-in list: `interfaces.md` 3.1.2. |

Merge rules when a file is loaded: missing built-in agents (`claude-code`, `hermes`, `codex`, `agy`) are ADDED with today's built-in definition; an agent the file defines is used exactly as written, even when it is a copy of a built-in definition that has since been replaced (the app then lists it under Settings -> Agent -> "Agent definitions to review" and never rewrites the file, `interfaces.md` 3.1.3); a non-empty `slot_profiles` or `recipes` list REPLACES the built-in list (copy any built-in notation you still want); `version`, `default_agent`, `timeout_seconds`, `ghost_diff_duration_ms` fall back to defaults when 0/empty; a built-in agent that the file redefines without `aliases` still gets its default aliases; no `snippets` means none from the file (the built-in snippets belong to the app, not to the file). A `.json` file (or content starting with `{`) is tried as JSON first and then as YAML; everything else is parsed as YAML (a JSON superset). An empty file yields the built-in defaults.

### Complete worked example

Agents named here were checked against the installed CLIs on the development machine on 2026-09-21 only where noted; check `--help` of every CLI you configure. Findings there: `agy --help` lists `-p`/`--print`/`--prompt` (non-interactive) and `--dangerously-skip-permissions`; `codex --help` lists `codex exec [PROMPT]` for non-interactive runs and no `--execute` or `--file` option (so the built-in `codex` entry up to v1.8.0, `--execute --file {file}`, did not match that CLI); `claude` was not installed there, so its flags are unverified (Claude Code's print mode is `-p`, as reported by the maintainer: it has no `--prompt`, and `--file` takes `file_id:path` resources).

The built-in definitions after v1.8.0 follow these findings (none was run on the maintainer's machine; on 2026-09-25 `agy --help` there still listed `-p` as "Run a single prompt non-interactively", and `codex exec --help` listed `[PROMPT]` and `--skip-git-repo-check`, "Allow running Codex outside a Git repository", which a note outside a Git repository may need): `claude-code` `claude -p "対象ノート: {file}\n指示: {instruction}"`, `codex` `codex exec {instruction}`, `agy` `agy -p "対象ノート: {file}\n指示: {instruction}"` without `--dangerously-skip-permissions` (agy may therefore stop to ask for permissions in print mode). An agents file written before (from the old template, or copied from the old defaults) keeps its old entries until the user edits them; the app lists them under Settings -> Agent with a "Copy the new definition" button (`interfaces.md` 3.1.3).

```yaml
version: 2
default_agent: agy
timeout_seconds: 300
hover_peek_enabled: true
ghost_diff_duration_ms: 4000

agents:
  agy:
    command: "agy"
    args: ["-p", "Target note: {file}\nInstruction: {instruction}"]
    description: "Antigravity, print mode, WITHOUT --dangerously-skip-permissions"
  codex:
    command: "codex"
    args: ["exec", "{instruction}"]
    description: "Codex CLI, non-interactive"
  claude-code:
    command: "claude"
    args: ["-p", "{instruction}"]
    description: "Claude Code print mode (verify flags with claude --help)"
  local-llm:
    command: "ollama"
    args: ["run", "qwen2.5:latest", "{instruction}"]
    description: "Local model through Ollama"

slot_profiles:
  - trigger_open: "{{"
    trigger_close: "}}"
    name: "code"
    agent: "agy"
    system_instruction: "Output only the result. No preamble."
  - trigger_open: "[?"
    trigger_close: "]"
    name: "research"
    agent: "claude-code"
    system_instruction: "Search the web. Cite primary sources and concrete numbers."
  - trigger_open: "【?"
    trigger_close: "】"
    name: "writing"
    agent: "local-llm"
    system_instruction: "Rewrite as concise Japanese bullet points. Make no external calls."
  - trigger_open: "[!"
    trigger_close: "!]"
    name: "adversarial"
    agent: "codex"
    system_instruction: "List three concrete risks. Do not agree by default."

recipes:
  - trigger_open: "[>>"
    trigger_close: "]"
    name: "deep-research-and-code"
    description: "Research -> risks -> implementation"
    steps:
      - "Research the official specification and best practices"
      - "Point out migration risks and breaking changes"
      - "Generate the implementation based on the above"
    requires_approval_step: 2
    self_refine: true
```

Rules of thumb: do not add permission-skipping flags (`--dangerously-skip-permissions`, `--full-auto`, `--yolo` ...) unless the user explicitly asks (MD-Memo then asks the user once before that agent runs, and again whenever its command line changes); for an agent that is a shell command line (PowerShell, cmd, sh ...) put `{instruction}` where it belongs or write `append_instruction: false`; the note text itself is NOT passed to the agent (only the instruction and the file path), so agents that read `{file}` work on the on-disk copy that MD-Memo just overwrote from the editor; agent stdout becomes the note text, so keep agents in a quiet/print mode.

Aliases and snippets (an addition to the example above, using the alias line and the snippet example of the generated template; `interfaces.md` 3.1.2 has the field rules). `{{ @claude ... }}` / `{{ @cc ... }}` then name the `claude-code` agent and put the result under the line; the snippet is offered in the `{{` popup, in the palette ("Insert task snippet") and as `/weekly` + Tab. Restart MD-Memo after editing them:

```yaml
agents:
  claude-code:
    command: "claude"
    args: ["-p", "{instruction}"]
    description: "Claude Code print mode (verify flags with claude --help)"
    aliases: ["claude", "cc"]

snippets:
  - id: "weekly"
    label: "今週の振り返り"
    kind: "llm"
    trigger: "/weekly"
    body: "この内容を今週の振り返りとして3点に要約して: ${selection}"
```

### `.env` (slot agents only)

- Which file: only `<projectRoot>/.env`, where the project root is the nearest ancestor of the note holding `.md-memo`, `agents.yaml|yml|json`, `AGENTS.md`, `skills`, or `.git`; else the note's own folder. It is loaded for each slot run and merged over MD-Memo's own environment for that child process only. MD-Memo itself never reads any `.env`.
- Syntax (`pkg/slotagent/env.go`): one `KEY=value` per line; blank lines and lines starting `#` ignored; optional `export ` prefix; value may be wrapped in matching `"..."` or `'...'` (quotes removed, no escape processing); for unquoted values ` #` starts a comment; no `${VAR}` expansion; no multi-line values; whitespace around key and value trimmed. Save as UTF-8 without BOM (a BOM would end up in the first key).
- If the file is empty or absent the child simply inherits MD-Memo's environment.
- Use this for keys the agent CLIs read (their own variables), not for MD-Memo settings. If the project root is the scraps folder and Git sync is on, `git add .` will commit and push `.env`: add `.env` to `<scrapDir>/.gitignore` first, or keep the project root elsewhere.

### `jev.json` / `.jev.json` (NOT ACTIVE)

No released code reads these files: `jev.NewRules` (`pkg/jev/guard_rules.go`) exists and is unit-tested, but every production caller of `VerifyCommand` passes `nil`, and grep finds no loader. Do not create them expecting an effect, and do not tell the user the guard has been tightened. The planned format (only ever stricter; there is no allow key), from `docs/design/agent-malleable-architecture.md`:

```json
{
  "version": 1,
  "block_commands": ["terraform"],
  "warn_commands": ["kubectl"],
  "protected_paths": ["~/work/prod"],
  "block_patterns": [
    { "id": "force-push", "regex": "git\\s+push\\b.*--force", "reason": "force push is forbidden" }
  ]
}
```

Planned limits in code: <= 100 entries per list, <= 32 patterns, regex <= 256 characters (RE2), pattern ids `[A-Za-z0-9_.:-]{1,64}`, command names without spaces <= 64 characters.

---

## (d) Environment variables

Verified by grepping every `os.Getenv` / `os.Setenv` / `os.Environ` in the Go sources.

### Read by MD-Memo

| Variable | Who reads it | Effect |
|---|---|---|
| `TYPESAFE_API_KEY`, then `JEV_API_KEY` | `pkg/jev/jev_client.go` (GUI and CLI) | TypeSafe/Jev key when none is configured. With a key and no endpoint the default `https://api.typesafe.ai` is used (Jev on System One, for Quick Actions and CLI `jev dispatch`/`predict`). In the GUI a configured `action.baseUrl` and `action.apiKey` shadow it, and with the default OpenRouter Base URL a TypeSafe key is not used. |
| `OPENROUTER_API_KEY` | headless CLI only (`AllowGenericEnvKeys`) | `md-memo jev predict` and `md-memo jev dispatch` will send the task text to OpenRouter (System One API for a Jev model, else chat completions) if this is set in the calling shell. The GUI never reads it (so unrelated exported keys do not leak note excerpts). |
| `JEV_MODEL` | Jev client | Model name when none configured (default `jev-latest`). |
| `JEV_API_URL` | Jev client | Endpoint when none configured. In the GUI `action.baseUrl` is normally already set (default `https://openrouter.ai/api/v1`), which shadows it. |
| `PATH` | every external tool lookup: `git`, `ollama`, agent CLIs, `cloudflared`, `pwsh`/`powershell`/`cmd`/`sh`, Command Bar commands | Must be the PATH of the process that started MD-Memo. |
| `SHELL` | macOS PATH repair only | Login shell to probe; must be an absolute existing path, else `/bin/zsh`. |
| `APPDATA` (Windows), `HOME` (macOS), `XDG_CONFIG_HOME`/`HOME` (Linux) | `os.UserConfigDir` | Where `<cfg>` is. |
| `USERPROFILE` (Windows), `HOME` | `os.UserHomeDir` | Meaning of `~` in `scrapDir` and the default scraps folder. |
| `LOCALAPPDATA` | `os.UserCacheDir` and cloudflared discovery | WebView2 profile `%LOCALAPPDATA%\md-memo\webview`; on-device Whisper files `%LOCALAPPDATA%\md-memo\components`; the Send To helper script `%LOCALAPPDATA%\md-memo\scripts`; `%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe`. |
| `APPDATA` (Windows Send To) | `sendto_windows.go` | `%APPDATA%\Microsoft\Windows\SendTo\MD-Memo (OCR).lnk` (the same `APPDATA` as `<cfg>` above). |
| `ProgramFiles`, `ProgramFiles(x86)` | cloudflared discovery | `...\cloudflared\cloudflared.exe`. |
| `TEMP` / `TMP` / `TMPDIR` | `os.CreateTemp` | Location of `md-memo-slot-*.md` temp notes. |

### Set by MD-Memo (do not try to override)

`WEBVIEW2_DEFAULT_BACKGROUND_COLOR` and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` are OVERWRITTEN at start-up on Windows (so user values are lost); `NO_COLOR=1` and `TERM=dumb` for command-bar children; `GIT_TERMINAL_PROMPT=0` for git.

### NOT read (common mistake)

`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_HOST`. MD-Memo's own LLM features take their keys and URLs only from `config.json`. Setting those variables helps only the external agent CLIs that read them.

### Setting variables persistently (for things MD-Memo or its child processes must see)

- Windows: `setx NAME "value"` or `[Environment]::SetEnvironmentVariable('NAME','value','User')` writes the user environment; only processes started afterwards see it. A GUI app started from the Start menu takes its environment from Explorer; after changing it, fully quit MD-Memo (tray -> Quit) and start it again, and if it still does not see the variable, sign out and in `(unverified: general Windows behaviour)`. `$env:NAME = ...` in a terminal affects only that terminal and its children.
- macOS: a `.app` launched from Finder, the Dock or Spotlight does NOT inherit shell-profile variables. MD-Memo repairs only `PATH` (`pkg/shellenv`, macOS only, run once in a background goroutine right after start): it runs the login shell (`$SHELL`, else `/bin/zsh`) as `-l -i -c` and, if that fails, `-l -c`, 3 s each, prints `$PATH` between markers, merges that list IN FRONT of the current PATH (absolute entries only, de-duplicated), falls back to `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:~/.local/bin` when the shell cannot be asked, then drops the cached "is this command installed" answers. No other variable is imported. For other variables use the agent project's `.env` (verified route), or `launchctl setenv NAME value` (visible to apps launched afterwards, lost at reboot) or a LaunchAgent for persistence `(unverified: general macOS behaviour)`.
- Linux: not supported.

Recommendation: for slot agents put their keys in `<projectRoot>/.env`; put MD-Memo's own keys in `config.json`; use OS-level variables only for PATH additions and the Jev variables above.

---

## (e) Per-feature prerequisites and verification

Do each step, then verify. "UI check" = ask the user to do it (or do it if you are driving a browser session for them).

| Feature | Install / set | Keys and variables | Verify |
|---|---|---|---|
| Text LLM: Ask AI (Ctrl+L), Alt+C, prompt presets | Local: Ollama (`winget install -e --id Ollama.Ollama`; macOS `brew install --cask ollama` if Homebrew exists) and `ollama pull qwen2.5:latest` (or Settings -> AI Models -> "Install Gemma 4" which installs Ollama if missing, pulls `gemma4:e2b`, and points `text` and `autocomplete` at it). Cloud: a Gemini/OpenAI-compatible key. | `text.baseUrl`, `text.model`, `text.apiKey`. Ollama needs no key. | Local: `curl http://127.0.0.1:11434/api/tags` returns 200 and lists the model. Cloud: a smoke test with the provider's own tooling; never echo the key. UI: Settings -> AI Models shows the detected protocol line and the Ollama badge; select a sentence, Ctrl+L, type "translate to English", Enter: a placeholder `[AI Generating: translate to English...]` appears BELOW the sentence and is replaced by the answer (the selected sentence itself stays; a failure at run time leaves one `[LLM error: ...]` line there). With no model, URL or (for Gemini / hosted services) key, Ctrl+L does not open the bar at all: a toast says "LLM is not configured (Settings -> AI Models)"; the Ctrl+Enter paths that use the built-in LLM give the same toast and leave the note untouched. |
| Ghost text | same as above, a small model | `autocomplete.*` | Type two or more characters and pause 0.5 s: dimmed suggestion; status bar `Predict: ON`; Tab accepts. If it says an error, hover the badge for the message. |
| Ollama lifecycle | MD-Memo starts Ollama automatically when a request targets `127.0.0.1:11434` / `localhost:11434` and `/api/tags` fails (Windows `cmd /c start /b ollama serve`; macOS `open -a Ollama` if `/Applications/Ollama.app` exists else `ollama serve`). Saving Settings after moving text/autocomplete away from `11434` runs `stopOllamaService` (Windows `taskkill /F /IM ollama.exe /T` and `"ollama app.exe"`; Unix `pkill`): this kills every Ollama process the user has. | - | `ollama list`. Warning: on some installs any `ollama` CLI command starts the Ollama app as a side effect. |
| Vision OCR (Ctrl+V image, Mobile Drop photos) | Gemini key, or a local vision model (`ollama pull qwen2.5-vl:latest`) with `vision.baseUrl` `http://localhost:11434` | `vision.*`, `general.pasteImageOcr: true` | Copy an image only (no text), Ctrl+V in the editor: `[Transcribing Image (Gemini)...]` becomes Markdown. |
| Voice input | Gemini key (`voice.apiKey`, or `vision.apiKey` as fallback); model `gemini-3.5-transcribe` (interactions style); microphone access | `voice.*` (see (b)); no env variables | Press the voice-input shortcut (default Ctrl+Shift+R; working tree also has a toolbar microphone button): a `⦅音声入力中... [id:xxxx]⦆` marker appears, speak, press it again (or stay silent for `silence_timeout_sec`): the marker becomes `⦅文字起こし中...⦆` and then the text. A failure toast carries the API error; the rescue marker keeps the audio. |
| Microphone permission | WebView2 shows its own one-time prompt at the first recording; nothing is granted silently (`configureWebViewSettings`). Windows Settings -> Privacy and security -> Microphone must allow desktop apps `(unverified)`. macOS: `NSMicrophoneUsageDescription` is in the app bundle; grant in System Settings -> Privacy and security -> Microphone; macOS behaviour is not yet verified by the maintainers. | - | If recording says the microphone could not be used, the prompt was denied or the OS blocks it. How WebView2 stores a denial is unverified; do not delete `%LOCALAPPDATA%\md-memo\webview` to "reset" it without the user's consent (it also holds cached config, CLI history and the voice rescue map). |
| Clipboard permission | The Ctrl+Shift+V fallback (only when `general.pasteHtmlAsMarkdown` is false) and Mobile Drop's first "text from PC" push read the async clipboard; WebView2 may show a one-time prompt. Denial is handled (plain text is pasted / the card stays empty). | - | Ctrl+V with a copied web table on the clipboard yields a Markdown table and a "Pasted as Markdown" toast. |
| Mermaid to image | Gemini key; network | `image.apiKey` (else `vision.apiKey`, else `text.apiKey`), `image.model`, `image.aspectRatio`, `image.resolution` | Put the caret in a ` ```mermaid ` block, palette -> "Diagram: Generate Image with Gemini" (ja: 図解: MermaidからGeminiで画像生成): `[Generating Diagram Image (Gemini)...]` becomes `![Generated Diagram](assets/diagram_<ns>.png)`. Save the note first for a relative `assets/` link (otherwise an absolute path under `<cfg>/assets/` is used). |
| Mermaid from text | Text LLM | `text.*` | Select text, palette -> "Diagram: Convert Selection to Mermaid" (ja: 図解: 選択範囲をMermaid図に変換). |
| Command Bar, CLI mode (Ctrl+E) | The tools you pipe through on PATH (`jq`, `sort`, `tr`, `duckdb`, ...) | - | Select lines, Ctrl+E (a fresh profile opens the manual CLI mode; otherwise the mode used last, and Tab switches), `sort -u`, Enter. Commands run in the app's working directory. |
| Command Bar, AI mode (Tab or a click on the badge switches to it) | Text LLM (or `cli.*`) | `cli.model` etc. | Ctrl+E; if the badge reads `CLI`, press Tab (it becomes `AI CLI`); type "list files here", Enter: a command lands in the bar; read it, press Enter to run. |
| Slot agents | Install and log in to each CLI named in `agents` (Claude Code `claude`, `codex`, `ollama`, `agy`, or your own); PATH must be visible to the GUI (macOS: see (d)). | agent keys in `<projectRoot>/.env` or the CLI's own login | Settings -> Agent shows availability for the selected agent (PATH lookup, cached 30 s). Write `{{ say hello }}` and press Ctrl+Enter: `{{ ⟳ 実行中... }}` then the result. With `{{ @<agent key or alias> say hello }}` the line stays and a `<!-- md-memo:run id -->` marker, then a result block, appear under it (`interfaces.md` 3.1.1). `[U+26A0] エラー: エージェント起動失敗: ...` (`[U+26A0]` = the warning-sign character the app writes) means the command is not on the GUI's PATH. An agent whose definition skips permission prompts shows a confirmation dialog first (Run starts it; asked once per definition, `interfaces.md` 3.1.3); Settings -> Agent lists agent definitions to review. |
| Auto selector (Ctrl+Enter, `[[ @llm ]]`, `[[ $ ]]`, `{{ @agent }}`, snippets) | Nothing to install for the feature itself. Its parts need: the LLM part (an instruction line runs on the built-in LLM at once; the ask bar) needs the Text LLM row above set up; the agent part (`{{ @agent ... }}`) needs that agent's CLI on the GUI's PATH and logged in, as in the Slot agents row; the command part (`[[ $ ... ]]`) needs the desktop app only (each command still passes the safety guard); notations and snippets need nothing. | `autoSelector.enabled`, `autoSelector.agentConfirm` (both default `true`), `text.*` for the LLM part, `aliases` / `snippets` in the agents file | Do not press Ctrl+Enter on the user's live note without saying so (it can send text to a cloud LLM, start an agent or run a command). Without running anything: (1) the two boxes in Settings -> Agent -> "Auto selector (Ctrl+Enter)" are ticked (ask the user; do not read `config.json` for this); (2) agent part: `Get-Command <command>` (Windows) or `command -v <command>` (macOS) for the agent's `command` from the agents file (read only the `command` values, never `env:`), and Settings -> Agent shows the availability badge of the default agent; (3) LLM part: the Text LLM row above. Optionally, and only in a scratch note the user has agreed to use, with the confirm setting on: ONE Ctrl+Enter on a line such as `テストを実行して` or `please run the tests` only rewrites it to `{{ @<agent> ... }}` and shows a toast (a second toast says when the agent is not found); Ctrl+Z restores the line. It starts no agent as long as the second press is NOT made. |
| Quick Actions | Nothing for local rules; remote engine only if wanted | `action.*` | Ctrl+J in a note with some text: up to three cards. A `sh` card runs in the app's working directory, so `git status -s` reports on whatever folder MD-Memo was launched from. |
| Git sync | `git` on PATH; an EMPTY remote repository; non-interactive credentials (credential manager or SSH key; prompts are disabled) | `scraps.scrapDir`, `scraps.gitSyncEnabled`, `scraps.gitRemoteUrl`, `scraps.gitRemoteBranch` | `git -C <scrapDir> remote -v`; `git -C <scrapDir> ls-remote --heads origin`. UI: Settings -> Sync -> Test Connection, then Link / Init (this UI action is what initialises the repo, sets identity, makes the first commit and pushes). Status bar shows `Git: ...`; clicking it forces a sync. Add `.env` to `.gitignore` first. |
| Mobile Drop | Phone and PC on one LAN (no AP isolation, no VPN in the way); allow MD-Memo through the Windows firewall for private networks when prompted | none | Ctrl+Shift+U: QR code and a URL `http://<lan-ip>:<port>/?token=...`. Open the URL on the phone. Photos need `vision.*`; voice needs `voice.*`. |
| Mobile Drop over the internet (Cloudflare Quick Tunnel) | Install `cloudflared` yourself: Windows `winget install --id Cloudflare.cloudflared -e`; macOS `brew install cloudflared`; elsewhere the Cloudflare downloads page. MD-Memo looks on PATH, then the fallback folders in `interfaces.md` 6.3, at the moment the button is pressed (no restart needed if it is in one of those places). | none | `cloudflared --version`. Then press the tunnel button in the dialog: a `https://...trycloudflare.com/?token=...` URL appears within 15 s. Data then passes through Cloudflare: only on the user's explicit request. |
| Discord Bridge (mobile capture into today's scrap, works even while MD-Memo is closed) | Create the user's own free Discord application/bot: https://discord.com/developers/applications -> New Application -> Bot tab -> Reset Token (copy it once, it is shown only that once). Then invite that bot to one server the user is in (Discord will not let a bot open a DM with someone it shares no server with - error 50007 "Cannot send messages to this user" - so a personal/private server the user already owns, or a new one created just for this, is enough): OAuth2 tab -> Scopes -> check `bot` -> Bot Permissions -> check `Send Messages` (`View Channels` too is harmless) -> open the generated URL -> pick that server -> Authorize. No slash command is registered and the bot has no ongoing presence in the server beyond being a member; it only ever polls its own DM channel with one user over plain HTTPS - no Cloudflare account, no self-hosted server. | `discordBridge.enabled`, `discordBridge.botToken`, `discordBridge.allowedUserId`, `discordBridge.pollIntervalSeconds` | Settings -> Sync -> "Mobile capture via Discord": paste the bot token and the user's own Discord user id - the NUMERIC snowflake from Developer Mode -> right-click the user's own name -> Copy User ID, NOT the visible username (`EnsureDMChannel`/`isSnowflake` rejects a non-numeric value locally with a clear message before it would otherwise fail as Discord's generic `status 400`) - tick enabled, press Test Connection (shows the bot's username on success; `DMチャンネルを開けません` after a valid-looking numeric id usually means the bot has not been invited to a shared server yet). Then DM the bot from the phone's Discord app: within `pollIntervalSeconds` (default 45s, or on the next launch if MD-Memo was closed) the message appears in `scraps/YYYY-MM-DD.md` under a `## Discord [HH:MM:SS]` heading. Photos/voice notes go through the same `vision.*`/`voice.*` pipeline as Mobile Drop; a message from any Discord account other than `allowedUserId` is silently ignored. |
| Hot folder (images to text, audio to text) | Nothing to install. Images need the Image OCR setup (a Gemini key or a local vision model; on Windows the on-device engine is the fallback and needs nothing); audio needs Gemini (`voice.apiKey`, or `vision.apiKey` as the fallback key) or, on Windows x64, on-device Whisper (next row). macOS: cloud OCR and Gemini only. | `inbox.enabled`, `inbox.dir`, `vision.*`, `vision.ocrMode`, `voice.*` | Ask the user to tick Settings -> Sync -> Hot Folder and Save (the folder is created). A check puts a file into it, which MOVES the file and may send it to a cloud model: only with the user's consent and only a throwaway image or a short clip. Expected within a few seconds: an entry with the OCR text as a blockquote and `![name](./assets/...)` (for audio `**[HH:MM:SS]**`, the transcript as a blockquote and a link) at the end of today's scrap, and the file moved to `<scrapDir>/assets/`. A failure leaves `> (OCRでテキストを抽出できませんでした: <reason>)` or `> (文字起こしに失敗しました: <reason>)` (troubleshooting section 4). |
| On-device Whisper (Windows x64 only) | Settings -> AI Models -> Voice -> Engine -> "Whisper (on this PC, offline)", then Download for the Whisper program (about 9 MB) and for a model (default: kotoba-whisper quantized, about 513 MB; smaller ones exist). Both come only from that panel, so the user presses Download: it fetches from github.com and huggingface.co, and an agent must not trigger it. | `voice.engine` `"whisper-local"`, `voice.whisper.*` | The panel shows "Ready: audio is transcribed on this PC." once both parts are installed. The files sit in `%LOCALAPPDATA%\md-memo\components` (list file names only). A short audio file in the hot folder (consent as above) then becomes a transcript without a network call, unless `cloudFallback` is on. macOS: the panel says on-device Whisper is only available on Windows (x64) for now. |
| `md-memo ocr <image>` and the Send To entry | The Image OCR setup as above. Send To is Windows only and is added by the user in Settings -> Agent -> "OS Integration (Send To)" -> Add. | `vision.*`, `vision.ocrMode`, `scraps.scrapDir` (or top-level `scrap_dir`) | `md-memo help ocr` shows its usage. Running it appends to the user's scrap and may send the image to the cloud: only on a throwaway image with the user's consent, e.g. `md-memo ocr C:\path\test.png`; expected `OCR text appended to <scrapDir>\YYYY-MM-DD.md` or `(no text recognized)`, exit 0; `OCR failed: ...` with exit 1 means no engine could read it. Send To: `%APPDATA%\Microsoft\Windows\SendTo\MD-Memo (OCR).lnk` exists once added; right-click an image in Explorer -> Send to -> MD-Memo (OCR) (the user does that). |
| Quick Capture popup (Windows only) | Nothing to install. macOS: not available (no toolbar button, no shortcut row). | `shortcuts.quickCapture` (default `Ctrl+Shift+Q`; `""` = no hotkey); AI Send uses `text.*` and `general.aiCorrection` | Ask the user to press the hotkey from another app: a small popup opens; type a line and press Enter: the line is at the end of today's scrap (with `> [context: <window title>]` first when the hotkey opened it). If nothing opens, another program owns the combination (troubleshooting section 2). |
| Screen Capture (Windows only) | Nothing to install; OCR as in the hot folder row. | as the hot folder | Only the user can do it: Capture (or Ctrl+Shift+Enter) in the popup, then click a window. A PNG appears in `<scrapDir>/assets/` and an entry `**[HH:MM:SS] 画面キャプチャ**` with the image link and the recognized text at the end of today's scrap. |
| Global summon hotkey | - | `shortcuts.globalSummon` | Press it from another app. Registration conflicts are silent at start-up; changing it in Settings reverts and toasts when the OS refuses. |
| Windows prerequisite | Microsoft Edge WebView2 Runtime (MD-Memo cannot start without it) | - | Start the app. |
| macOS prerequisites | macOS 10.15+; first launch of the build without Apple notarization: macOS 15+ = System Settings -> Privacy & Security -> Security -> Open Anyway (shown for about an hour after the first attempt, asks for the login password); macOS 14 and earlier = right-click -> Open; any version = `xattr -dr com.apple.quarantine "MD-Memo.app"` (OS behaviour, from Apple's support page: unverified in source) | - | The tray is absent by design; Dock icon and the hotkey bring the window back. |

---

## (f) Ready-to-paste instructions for the user

Each pair is EN then JA. They are safe to give to an agent verbatim.

1. Gemini bundle

EN: "Set up MD-Memo for Gemini: image OCR, voice input and Mermaid-to-image. Read skills/md-memo/references/setup-guide.md first. Ask me to quit MD-Memo (tray -> Quit) before editing config.json, back it up, and put the Gemini key I give you into vision.apiKey only (voice and image inherit it). Use voice.model gemini-3.5-transcribe with apiStyle auto and languageCodes [\"ja-JP\"], image.model gemini-3.1-flash-lite-image. Never print or commit the key. After I restart MD-Memo, verify each feature with the checklist and report what you could and could not verify."

JA: 「MD-Memo を Gemini 向けに設定してください（画像 OCR、音声入力、Mermaid の画像化）。まず skills/md-memo/references/setup-guide.md を読んでください。config.json を編集する前に、MD-Memo を終了する（トレイ → 終了）ようこちらに依頼し、バックアップを取ってから、渡す Gemini キーは vision.apiKey にだけ入れてください（音声と画像はそれを引き継ぎます）。音声は voice.model を gemini-3.5-transcribe、apiStyle は auto、languageCodes は [\"ja-JP\"]、画像は image.model を gemini-3.1-flash-lite-image にしてください。キーは表示もコミットもしないでください。再起動後に各機能をチェックリストで確認し、確認できたこと・できなかったことを報告してください。」

2. Add a Codex agent

EN: "Add a Codex agent to my MD-Memo agents.yaml (global file in the MD-Memo config folder). Back it up, keep every existing agent and notation, add an agent named codex that runs `codex exec` with {instruction}, run `codex --help` and `codex exec --help` first to confirm the flags, do not add any permission-skipping flag, validate the YAML, and tell me to restart MD-Memo if you changed notations."

JA: 「MD-Memo の agents.yaml（設定フォルダ直下のグローバルなもの）に Codex エージェントを追加してください。バックアップを取り、既存のエージェントと記法はすべて残し、`codex exec` に {instruction} を渡す codex エージェントを追加してください。先に `codex --help` と `codex exec --help` でフラグを確認し、権限確認をスキップするフラグは付けず、YAML を検証してください。記法（slot_profiles / recipes）を変えた場合は MD-Memo の再起動が必要だと伝えてください。」

3. Change a shortcut (state honestly what is possible)

EN: "Change the MD-Memo shortcut for <action> to <combo>. This can be done by editing shortcuts.<action> in config.json while MD-Memo is closed (restart needed); the file is not validated, so check the combo is not reserved (Ctrl+Tab, Ctrl+,, Ctrl+Shift+V, Ctrl+Alt+V, Alt+T, Ctrl+Right, every Ctrl+Enter variant (the Auto selector takes them all), clipboard/undo keys) and not already used by another action. Only the Settings -> Shortcuts recorder resolves conflicts for you. For the global summon key on Windows use one modifier plus A-Z, 0-9, F1-F24, Space, Enter or Esc."

JA: 「MD-Memo の <アクション> のショートカットを <キー> に変更してください。MD-Memo を終了している間に config.json の shortcuts.<アクション> を書き換えれば可能です（再起動が必要）。ファイル編集では検証されないため、予約キー（Ctrl+Tab、Ctrl+,、Ctrl+Shift+V、Ctrl+Alt+V、Alt+T、Ctrl+→、Ctrl+Enter 系のすべて（自動セレクターが取ります）、コピー/元に戻す系）や他の操作と重複していないかを自分で確認してください。競合の自動解消は 設定 → ショートカット の記録画面だけが行います。Windows のグローバル呼び出しキーは、修飾キー 1 つ以上と A-Z / 0-9 / F1-F24 / Space / Enter / Esc の組み合わせにしてください。」

4. Move scraps to a vault

EN: "Point MD-Memo's scraps folder at <path>. Check first that <path> is not a Git repository I care about: MD-Memo runs git add ., commit and push in that folder when Git sync is on. Set scraps.scrapDir AND the top-level scrap_dir to the same value with MD-Memo closed; if I want Git sync there, tell me to use Settings -> Sync -> Link / Init instead of running git yourself."

JA: 「MD-Memo のスクラップフォルダを <パス> に変更してください。先に、<パス> が自動コミットされて困る Git リポジトリでないことを確認してください（Git 同期が有効だと MD-Memo はそのフォルダで git add .・commit・push を実行します）。MD-Memo を終了した状態で scraps.scrapDir と最上位の scrap_dir を同じ値にしてください。Git 同期も使いたい場合は、自分で git を実行せず 設定 → 同期 → 連携/初期化 を使うよう案内してください。」

5. Diagnose "Quick Actions does nothing"

EN: "Quick Actions (Ctrl+J) does nothing. Follow troubleshooting.md: check the status-bar Action badge, the caret focus, the shortcut binding and the action settings; do not change any file until you know the cause."

JA: 「Quick Actions（Ctrl+J）が反応しません。troubleshooting.md の手順で、ステータスバーの Action 表示、カーソルのフォーカス、ショートカット割り当て、アクション設定を確認してください。原因が分かるまでファイルは変更しないでください。」

6. Set up the Discord Bridge

EN: "Help me set up MD-Memo's Discord Bridge so I can send myself notes from my phone. I need to create the Discord bot myself (discord.com/developers/applications -> New Application -> Bot -> Reset Token), invite it to one server I'm in (OAuth2 tab -> Scopes: bot -> Bot Permissions: Send Messages -> open the generated URL -> pick a server -> Authorize; Discord refuses a DM from a bot that shares no server with me, so a private server just for this is fine), and find my own numeric Discord user id (User Settings -> Advanced -> Developer Mode, then right-click my name -> Copy User ID - the number, not my visible username). Walk me through all of that, then tell me exactly what to paste into Settings -> Sync -> 'Mobile capture via Discord' and what Test Connection should show on success. Never ask me to paste the token anywhere else, and never print it back to me once I've entered it."

JA: 「MD-Memo の Discord Bridge を設定して、スマホから自分にメモを送れるようにしたいです。Discord Bot は自分で作成する必要があるので（discord.com/developers/applications → New Application → Bot → Reset Token）、それを自分がいるサーバーに1つ招待し（OAuth2タブ → Scopes で bot にチェック → Bot Permissions で Send Messages にチェック → 生成されたURLを開く → サーバーを選んで Authorize。DiscordはBotと1つもサーバーを共有していない相手へのDMを許さないため、この用途だけの非公開サーバーで構いません）、自分の数字だけの Discord ユーザーID の調べ方（ユーザー設定 → 詳細設定 → デベロッパーモードを有効化 → 自分の名前を右クリック → ユーザーIDをコピー。表示されているユーザー名ではなく数字の方です）を案内してください。そのうえで 設定 → 同期 → 「Discordからのモバイル入力」に何を貼り付ければよいか、接続テストが成功すると何が表示されるかを教えてください。トークンをそれ以外の場所に貼るよう案内せず、入力後にトークンを画面に表示し直さないでください。」

What can be done by editing files vs only in the UI:

| Change | File edit (app closed) | UI only |
|---|---|---|
| API keys, models, URLs, prompts | `config.json` | |
| Theme, language, autosave, tray, layout | `config.json` | |
| Shortcuts (incl. global summon and, on Windows, Quick Capture `shortcuts.quickCapture`) | `config.json` `shortcuts` (unvalidated; a combination another program owns fails silently at start) | recorder with conflict handling (it also refuses a combination the OS cannot register) |
| Hot folder (`inbox.enabled`, `inbox.dir`), `vision.ocrMode`, `voice.engine`, `voice.whisper.*` | `config.json` (explicit values, app closed) | Settings -> Sync (Hot Folder), Settings -> AI Models -> Voice (Engine). The Whisper program and model DOWNLOADS exist only as the Settings panel's Download buttons, pressed by the user |
| The Send To entry "MD-Memo (OCR)" (Windows) | none | Settings -> Agent -> "OS Integration (Send To)" -> Add / Remove |
| Agents, aliases, notations, recipes, task snippets | `agents.yaml` (restart to make the page re-read aliases, notations and snippets) | |
| Auto selector on/off and its confirmation (`autoSelector.*`) | `config.json` (explicit `true` / `false`, app closed) | Settings -> Agent -> "Auto selector (Ctrl+Enter)" |
| Git remote linking / first commit / push | none (config stores the URL only) | Settings -> Sync -> Link / Init |
| Ollama install, start, stop, model pull | shell commands | Settings -> AI Models buttons |
| Import / Export of settings (`.mdmemopack`) | | Settings -> Export... / Import... (section (h)) |
| Microphone / clipboard permission | | WebView prompt |
| Cloudflare tunnel | | button in the Mobile Drop dialog |
| Re-initialising Git/Jev engines without restart | | Settings Save |

---

## (g) Never do

1. Never print, log, echo, paste into chat, or commit an API key, `config.json`, a backup of it, `.env`, or `session.json`. Redact to `set (...last4)`. To look at the settings without touching the file, run `md-memo config get [key.path]` (interfaces.md 1.8): it prints them with every key, token and password replaced by `<set>` / `<unset>`.
2. Never start another MD-Memo (bare `md-memo`, `md-memo <file>` when not running) unless the user asked to start it; never kill the process; ask the user to quit from the tray.
3. Never edit `config.json` while MD-Memo runs; never delete a key to "reset" it (write the explicit default); never rely on `max_pipe_size_mb`, `text.temperature`, `vision.systemPrompt` or `jev.json` (no effect).
4. Never use `md-memo ui eval` for reading configuration or calling `window.backend.*`/`MdMemoBridge`; never use it to type into the user's notes without a reason they know about.
5. Never run `md-memo buffer set` (or `replace`) without explicit content and, when the user may be typing, `--expected-hash`; never `tab switch` to an id not returned by `tab list`. RPC writes mark the tab dirty and, with autosave, rewrite the file.
6. Never point `scraps.scrapDir` at a repository, home folder or drive root; Git sync runs `git add .`, commit and push there. Never place `.env` or secrets in the scraps folder unless it is git-ignored.
7. Never add permission-skipping flags to agent definitions, and never register an agent whose non-interactive flags you have not confirmed with `--help`.
8. Never start the Cloudflare tunnel, install `cloudflared`, change OS microphone/firewall/privacy settings, or run `ollama` commands (they may start the Ollama app) unless the user asked.
9. Never change a shortcut to a reserved combination, and never assume a shortcut edit was validated.
10. Never claim a feature works without a verification step from (e); state `(unverified)` instead.
11. Never "import" a settings package by writing `config.json`, unzipping it into `<cfg>` or a project, or copying its files by hand; never import one the user has not confirmed as trusted; never put API keys into a package. See (h).
12. Never press Ctrl+Enter or the Run button in the user's live note without saying so: since the Auto selector it can send the line to a cloud LLM, start an agent CLI (which overwrites the note's file) or run a shell command. Writing a task line into a note runs nothing by itself; only that key press (or the Run button) does.
13. Never put files into the user's hot folder (`inbox.dir`) to "test" it, run `md-memo ocr` on the user's own images, or press Download for Whisper without asking: the hot folder MOVES the files it handles and may send them to a cloud model, `ocr` writes to the user's scrap and may send the image out, and the Whisper download fetches 9 MB to 1.4 GB from github.com and huggingface.co. Use a throwaway file the user agreed to.

---

## (h) Moving a setup to another PC

A `.mdmemopack` settings package is the supported way to carry a working setup (settings, the app-wide and the project agents file, project skills) to another PC. Format, limits and what is never included: `interfaces.md` 5.2. Only the running app creates and applies a package, and only when the user asks it to in the Settings dialog.

What the user does (tell them; do not do it for them):
1. Old PC: Settings -> Export... -> tick what to take -> Export. Leave "Include API keys" off unless the file stays private. Sync (scraps folder path and Git remote, "this PC only") and skills are unticked by default.
2. Move the `.mdmemopack` file to the new PC by a channel the user trusts, and install MD-Memo there.
3. New PC: open the project that the skills and the project agents file belong to first (open its folder, or save the note into it), otherwise those rows show "needs a project" and stay disabled. Then Settings -> Import... -> pick the file -> tick what to apply -> Import.
4. Read the result panel. Restart MD-Memo if it says some settings take effect after a restart. Re-enter API keys in Settings -> AI Models: a package made without keys carries none, and an import never erases keys that are already there. The confirmations given for risky agents (`agentAck`) stay on the old PC: the new one asks once again before each such agent runs.
5. Verify features with the checklist in (e).

An agent MAY:
- Explain what a package holds by reading its `manifest.json` with a zip reader, without extracting anything:

```python
import json, zipfile
with zipfile.ZipFile(r"C:\path\to\md-memo-20260921.mdmemopack") as z:
    if z.getinfo("manifest.json").file_size > 256 * 1024:   # the app's own manifest limit
        raise SystemExit("manifest too large: not a genuine package")
    manifest = json.loads(z.read("manifest.json"))
print(manifest["format"], manifest["version"], manifest["appVersion"], manifest["includesSecrets"])
for item in manifest["items"]:
    print(item["id"], item.get("bytes"))
```

- Tell the user which sections, agents files and skills to tick, and what "will overwrite" means: the old version is copied first to `<cfg>/pack_backups/<YYYYMMDD-HHmmss>/`.
- After the user has imported: help verify with (e), lint the agents file (do not print it if it may hold secrets), and tell the user where the backup folder is (list folder names only).

An agent MUST NOT:
- Unzip a package into `<cfg>`, a project folder or any place the app reads from, or copy skills or agents files by hand instead of the Import dialog.
- Write `config.json` (or `.env`) to "import" settings: the running app owns `config.json` and merges the settings itself (`interfaces.md` 5.2).
- Put API keys into a package, or ask for "Include API keys" on a file that will be shared or stored anywhere but a private place. Never print `config/config.json` or `agents/*.yaml` from a package: they may hold keys, and `includesSecrets: false` is no proof that they do not.
- Import, or tell the user to import, a package the user has not confirmed as trusted. Skills are instructions that an agent will follow and agents files contain commands that MD-Memo will run: read the manifest first, list what would be written, and flag anything unexpected.
- Drive the Export / Import dialogs itself (`ui eval`, `window.backend.pack*`): that is full control of the UI (`SKILL.md` safety rules).

---

## Source of truth

- `frontend/js/app.js` (`config` defaults, `DEFAULT_SHORTCUTS_*`, `syncBackendConfig`, `loadLocalConfigSync`, `savePersistentConfig`, `btn-save-settings` handler, `generateImageFromMermaid`, reserved shortcut lists), `frontend/js/{slot_agent,auto_selector,slot_snippets,voice_input,jev_action,chrome_layout,config_pack}.js`, `frontend/index.html`
- `app_config.go`, `app_scrap.go`, `app_slot.go`, `app_jev.go`, `app_llm.go`, `app_inputs.go`, `app_mobiledrop.go`, `app_pack.go`, `app_inbox.go`, `app_speech.go`, `quickcapture.go`, `quickcapture_windows.go`, `sendto_windows.go`, `cli_ai.go`, `main.go`, `window_windows.go`, `window_darwin.go`, `ollama_ops*.go`, `build_mac.sh`, `packaging/*`
- `pkg/slotagent/{config,loader,parser,mention,runner,env,skill,pipeline}.go`, `pkg/llm/{llm,audio,ollama}.go`, `pkg/cli/ocr.go`, `pkg/ocr`, `pkg/inbox`, `pkg/speech`, `pkg/components`, `pkg/jev/{jev_client,guard_rules,guard}.go`, `pkg/shellenv/shellenv.go`, `pkg/dropzone/tunnel.go`, `pkg/gitsync/gitsync.go`, `pkg/configpack/*`, `pkg/hotkey/hotkey.go`, `pkg/appdir/appdir.go`
- `docs/design/agent-malleable-architecture.md` (planned, unimplemented items only)
