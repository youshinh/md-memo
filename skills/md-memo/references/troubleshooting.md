# MD-Memo troubleshooting (symptom -> cause -> fix)

Every cause below was traced in source (file named in "Source of truth"). `(unverified)` marks a step that rests on general OS or browser behaviour rather than this repository. Do not change files until you know the cause; back up before any edit (see `setup-guide.md` (a)). `<cfg>` = `%AppData%\md-memo\` (Windows) or `~/Library/Application Support/md-memo/` (macOS).

---

## 1. Command line and JSON-RPC

| Symptom | Cause | Fix |
|---|---|---|
| `Error: md-memo is not running. Launch md-memo first or use --headless.` | `<cfg>/ipc-session.json` is missing, its PID is dead, or its port refuses a connection (the CLI deletes a stale file). The hint about `--headless` is wrong for `buffer`/`tab`/`ui`. | Ask the user to start MD-Memo normally. A tray-resident Windows instance is still running with its window hidden; then the file exists. Do not run bare `md-memo` yourself. |
| `failed to connect to running instance at 127.0.0.1:PORT` | The session file points at a port nothing listens on any more (crash between the liveness check and the call), or a local firewall driver blocks loopback. | Retry once; if it persists ask the user to restart MD-Memo. |
| `i/o timeout`, `context deadline exceeded`, `failed to get buffer: ...` | The CLI waits 3 s, the app 5 s; the WebView was busy or the page is not running (`webview is not running`). If the window is hidden in the tray try `md-memo ui activate` first (unverified whether hidden pages are slower). | Retry after `ui activate`; avoid long `ui eval` code. |
| `no active selection` (exit 1, RPC -32003) | Nothing is selected in the FOCUSED editor pane (start == end), or `--tab` names another tab (the tab is selected first and its selection is empty). | Ask the user to select text (or select it through the UI), then call again without `--tab` or with the active tab. |
| `conflict: expected hash X but buffer is at Y` (exit 1, -32001) | The buffer changed since you read it (any edit, including the user typing), or another RPC writer bumped `generation`. | `buffer get --json` again, redo the edit, retry with the new hash. Do not drop `--expected-hash` to "make it work". |
| `selection changed before replace could be applied` | The caret moved between the two internal round trips of `replace-selection`. | Re-read the selection and retry. |
| `--tab <id>` seems ignored by `buffer set/append/replace` | It is ignored: those RPCs always act on the primary pane's active tab (`app_rpc.go`). Only `buffer get`, `get --selection`, `replace-selection` honour it. | `tab switch <id>` (valid ids only), write, switch back. Tell the user, because switching changes what they see. |
| `buffer get --tab bogus` returns an empty buffer | Unknown ids are not errors (JS returns null, Go accepts it). | Take ids from `tab list`. |
| After `tab switch <bad id>` typing seems to go nowhere, tab bar shows no active tab | `selectTab` sets `activeTabId` before checking the tab exists (`app.js`), leaving no valid active tab. | Ask the user to click any tab. Prevent by using only ids from `tab list`. |
| `buffer set` emptied the note | No content argument and stdin was a pipe with no data (or a closed stdin) -> empty content. | Ctrl+Z in the editor restores it (writes are undoable). Always pass content explicitly. |
| My `buffer set` changed the file on disk | RPC writes fire the editor's `input` event: with `general.autoSave` true and a tab bound to a file, the file is saved ~1.5 s later. | Expected. Turn autosave off first only if the user agrees. |
| Non-ASCII text arrives garbled from PowerShell 5.1 | Windows PowerShell 5.1 encodes text piped to native programs in the legacy code page (unverified, general PowerShell behaviour). | Use PowerShell 7, or call the JSON-RPC route with UTF-8 bytes. |
| `md-memo buffer get` prints nothing / returns immediately in PowerShell | The Windows build is a GUI-subsystem executable; PowerShell may not wait for it or capture its console output (unverified). Output is preserved when stdout is piped or redirected (`console_windows.go`). | Pipe: `md-memo buffer get --text \| Out-String`, or use a Bash tool, or `Start-Process -Wait -NoNewWindow -RedirectStandardOutput`. |
| `md-memo help` / `md-memo --version` starts the app | They are not subcommands: unknown words/flags fall through to the normal start. | Use `md-memo --headless help`. There is no version flag; the version is `AppVersion` in `app.go`. |
| `jev verify` exit `2` | "warn": the guard cannot vouch for the command (pipe to an interpreter, run-time-built string) but it is not known to be destructive. | Read the command; do not treat 2 as safe. `--json` gives `rule` and `reason`. |
| `jev verify` blocks a harmless `for f in *.txt; do echo $f; done` | `strict` (default) rejects unquoted variable expansion (`unquoted-var`). | Quote the variable, or judge with `--mode reviewed` if a person will read it. |
| `jev verify` says `parse` / `parseFailed` for PowerShell | The guard parses bash; PowerShell syntax may fail to parse; strict and unattended treat that as a block. `reviewed` falls back to the regex lists only. | Do not present a parse failure as "unsafe" or "safe": it is "not analysed". |
| `md-memo jev verify -rf` -> flag error | Text starting with `-` is parsed as a flag. | `md-memo jev verify -- "-rf ..."` (flags such as `--mode` go before the `--`). |
| CLI JSON when I wanted text | stdout is not a terminal, so JSON is the default. | `--text`. |

---

## 2. Window, tray, hotkey, single instance

| Symptom | Cause | Fix |
|---|---|---|
| Launching MD-Memo again "does nothing" / the existing window appears | By design: one instance. Windows: named mutex `Local\MDMemo_SingleInstance_Mutex_v1` plus a broadcast message; macOS: `flock` on `<cfg>/instance.lock` plus an IPC `activate`. `md-memo <file>` opens the file in the running instance's new tab; `cmd \| md-memo` appends to today's scrap in it. | Nothing to fix. There is no way to open a second window/instance. |
| Closing the window leaves a process running (Windows) | `general.trayResident` defaults to true: WM_CLOSE hides to the tray. | Tray icon -> Quit, or set `general.trayResident` false (app closed) so close exits. Ctrl+W on the last tab exits regardless. |
| No tray icon on macOS | None exists by design; the close button hides the window (always); Cmd+Q quits; the Dock icon or the hotkey brings it back. `trayResident` has no effect there. | - |
| Global hotkey does nothing | Another program owns the combination (Windows `RegisterHotKey` fails silently at start), or the configured string cannot be parsed (Windows: a non-letter/digit/F-key/Space/Enter/Esc key such as ArrowUp). The hotkey only brings the window forward; it never hides it. | Change it in Settings -> Shortcuts (a refused registration reverts the value and shows a toast), or edit `shortcuts.globalSummon` with the app closed. |
| Port 41739 is busy | MD-Memo silently binds a random port for its embedded UI. Browser storage is per origin (host AND port), so the cached config copy, session copy, CLI history, voice-rescue map, workspace folder and font size from earlier runs are not visible (unverified web-platform rule). `config.json` and `session.json` are still read from disk. Symptoms: voice rescue links say the cache is missing although `<cfg>/voice_cache` holds the file; the workspace folder is forgotten. | Free the port and restart MD-Memo (find the owner with `netstat -ano \| findstr 41739` on Windows or `lsof -i :41739` on macOS, unverified commands of the OS). |
| Port 49152 is busy | The IPC server takes a random port and writes it to `ipc-session.json`. | Always read the port from that file (the CLI does). |
| Windows: nothing starts / no window | The Microsoft Edge WebView2 Runtime is missing (`Failed to initialize WebView2`, only visible when started from a console). | Install the runtime. |
| macOS: "damaged" or "unidentified developer" | Releases are ad-hoc signed, not notarized. | Right-click -> Open, or `xattr -dr com.apple.quarantine "MD-Memo.app"`. |
| macOS: agent CLIs, `git`, `jq`, `cloudflared` "not found" right after launch | A GUI-launched app gets launchd's tiny PATH. `pkg/shellenv` repairs PATH in a background goroutine after start (login shell probe, 3 s per attempt, static fallback list) and then clears the 30 s "is it installed" cache. | Wait a few seconds and retry; if a tool lives outside the login shell's PATH, launch MD-Memo from a terminal that has it, or use absolute paths in `agents.yaml`. |
| Windows: a CLI I just installed is "not found" | The process keeps the PATH it started with (`exec.LookPath` reads the process environment; general Windows behaviour). | Fully quit MD-Memo (tray -> Quit) and start it again. `cloudflared` is the exception: fallback install folders are searched at click time. |

---

## 3. Settings and files

| Symptom | Cause | Fix |
|---|---|---|
| My edit of `config.json` has no effect | Any of: (1) MD-Memo was running: the frontend read the file once at start; (2) invalid JSON: `JSON.parse` failure is swallowed (`console.warn`) and Go's parsers fall back to defaults, so the WHOLE file is ignored silently; (3) a BOM; (4) you deleted a key and the browser-storage copy re-supplied the old value; (5) you edited only top-level `scrap_dir` while nested `scraps.scrapDir` exists (Go: nested wins; frontend: nested first) or the reverse when `scraps` is absent; (6) an unknown top-level key (dropped at the next UI save); (7) a slot key while `agents.yaml` exists (see below). | Quit MD-Memo, validate the JSON, write explicit values, keep nested and mirrored keys equal, restart. |
| My edit was overwritten | The app rewrote `config.json` from memory: Settings Save, or a click on the `Predict`, `Autosave`, `IME`, `Action` badges, or Ollama setup finishing. | Edit only while closed. |
| A shortcut I typed into `config.json` does not work | Not validated: reserved combos (Ctrl+Tab, Ctrl+Comma, F11, Ctrl+Shift+V, Ctrl+Alt+V, Alt+T, Ctrl+Right, every Ctrl+Enter variant, clipboard/undo keys) are shadowed by fixed handlers; a duplicate is not resolved (the first match in handler order wins); on macOS reserved combos are reset to the default at load; `Ctrl+Enter` inside the editor always runs a slot. | Pick another combination; use the Settings recorder for conflict handling. |
| The Settings "Agent timeout" seems ignored | With an external `agents.yaml` present the Go runner takes `timeout_seconds` from that file only (default 180); the UI value is used only when no agents file exists. "Open agents.yaml" creates one. | Edit `timeout_seconds` in the agents file. |
| `agents.yaml` edit ignored / my custom agent missing | (1) YAML/JSON syntax error: the file is silently skipped and built-in defaults are used; (2) an earlier candidate exists and shadows yours (`<scrapDir>/.md-memo/agents.*` beats `<cfg>/agents.*`; a broken first file does not fall through); (3) notations changed but the frontend copy is stale until restart; (4) `slot_profiles`/`recipes` REPLACE the built-ins (your list must contain everything you want). | Lint the file, check `<scrapDir>/.md-memo/`, restart after changing notations. |
| Hover Peek never shows text | `hover_peek_enabled` omitted from `agents.yaml` reads as `false` (Go zero value). | Add `hover_peek_enabled: true`. |
| "Max Pipe Input Size" does nothing | The value is stored but no code reads it; the limit is the constant 10 MB (`main.go`). | Nothing to fix; do not promise it. |
| `jev.json` has no effect | Not implemented: no loader exists. | Do not create it. |
| Settings Save stopped my Ollama | Saving after moving both text and ghost-text URLs away from `11434` calls `stopOllamaService` (Windows `taskkill /F /IM ollama.exe /T` and `"ollama app.exe"`; Unix `pkill -f 'ollama serve'`), which kills every Ollama process. | Warn the user before changing those URLs in the UI; a file edit while closed does not trigger it. |
| Toolbar icon / context-menu item disappeared | `general.toolbarLayout.hidden` / `contextMenuLayout.hidden` lists its element id. | Settings -> General -> Toolbar and right-click menu -> reset, or remove the id (app closed). The Settings icon cannot be hidden. |

---

## 4. AI features

| Symptom | Cause | Fix |
|---|---|---|
| Quick Actions (Ctrl+J) does nothing | Check in order: the status-bar badge reads `Action: OFF` (`action.enabled` false; Ctrl+J is disabled then); focus is not inside a note textarea (the trigger requires `document.activeElement` to be an editor, so the Find bar, tab bar or a dialog blocks it); `shortcuts.quickActions` changed or empty; an IME composition is active (suppressed); in Manual mode only Ctrl+J opens it (auto popup off). | Click the badge to cycle On -> Manual -> Off, click into the note, check the shortcut in Settings -> Shortcuts. |
| Quick Actions opens but a card fails or shows the wrong folder | `sh` cards run in MD-Memo's own working directory (no `Dir` is set), so `git status -s` reports on whatever folder MD-Memo was started from, and the strict guard refuses unquoted variables, `rm`, `sudo`-wrapped destructive commands and more. Windows runs them through `powershell -NoProfile -NonInteractive -Command`; timeout 20 s. | Use a card whose command does not depend on the folder, or run the command in a terminal. |
| A `write`-kind Quick Actions card fails with a connection error | Derived from code, not run: a `doc` card whose command is not a slot goes to the generative branch, whose LLM handler reads an `llm` object (or top-level `baseUrl`/`model`/`apiKey`) from `config.json` (`app_jev.go`), while the UI stores its LLM under `text`; with neither present the request has an empty base URL. Local rules only produce slot-style `doc` cards, so this needs a remote engine. | Report as a bug; do not paper over it with an `llm` key (the next UI save drops unknown top-level keys). |
| Ctrl+Enter ran a slot elsewhere in the note (or on a slot I did not mean) | The slot under the caret is chosen if there is one; otherwise the NEAREST slot after the caret; otherwise the FIRST slot in the note. "No slot found" appears only when the note has no slot at all. Ctrl+Enter is captured by the slot handler everywhere in the editor. | Move the caret into the intended slot; Esc within the Ghost Diff window reverts. |
| `{{ ⟳ 実行中... }}` stays after a restart | The placeholder is ordinary note text; the run died with the app. The parser skips placeholders, so it will not re-run. | Replace it with the original instruction (Ctrl+Z may work within the session). |
| Slot says `[U+26A0] エラー: エージェント起動失敗: ... (再試行: Ctrl+Enter)` (`[U+26A0]` = the warning-sign character the app writes; match on `エラー:`) | `exec` could not start the command: not on the GUI process's PATH, or the executable name is wrong. Agents run without a shell, so shell built-ins, aliases and `~` do not work. | Install the CLI, fix PATH (see section 2), or give an absolute path in `command`. Retry with Ctrl+Enter in the same slot. |
| Slot says `[U+26A0] エラー: <stderr text>` | The agent exited non-zero; the first 1000 characters of stderr are shown. Wrong flags are the usual cause: the shipped `codex` entry uses `--execute --file` while `codex --help` on the development machine lists `codex exec` and no such options. | Run the command by hand with the same arguments; fix `args`. |
| Slot says `[U+26A0] エラー: タイムアウト (再試行: Ctrl+Enter)` | 180 s default elapsed (or the agents file's `timeout_seconds`). | Raise `timeout_seconds` in the agents file. |
| A slot run overwrote my file or changed its encoding | Before running, the app writes the editor text to the note's path (UTF-8, ignoring a Shift_JIS tab encoding, even with autosave off) so the agent sees the latest text. | Tell the user before running slots on notes with unsaved intent or non-UTF-8 encodings. |
| `{{ [U+26A0] スキル 'x' が見つかりません ... }}` | `@x` skill file not found under the project root (`skills/x/SKILL.md`, `skills/x.md`, `skills/x/README.md`, `.gemini/skills/x/SKILL.md`, `.claude/skills/x/SKILL.md`). | Create the file or fix the name. |
| An `[AI Generating: ...]` / `[Transcribing Image ...]` / `[Generating Diagram ...]` anchor stays in the note | The app closed or crashed mid-call, or the callback never came (the 180 s watchdog only runs while the app lives). | Delete the bracketed text. |
| Ghost text never appears | `Predict: OFF`; fewer than 2 typed characters; a selection exists; composing; preview mode; the secondary pane (no ghost there); delay floor 300 ms; the model is not pulled or Ollama is down (MD-Memo tries to start Ollama for `127.0.0.1:11434`/`localhost:11434` and waits up to 4 s); a key on an Ollama URL forces the OpenAI-style `/v1` endpoints. | Hover the badge for the error text; `curl http://127.0.0.1:11434/api/tags`; check the model name. |
| Inline AI (Ctrl+K) returns `LLM error: ...` | The error text is the provider's (`Gemini APIエラー (403)` bad key, `Ollama接続エラー` server down, empty base URL). Non-Gemini keyless hosted APIs reject the call. | Fix key/URL/model in Settings -> AI Models; the protocol line under the URL shows what was inferred. |
| Ctrl+V of an image does not OCR | `general.pasteImageOcr` false; the clipboard also carries text (Excel/Word: text wins, the image is ignored); no `vision.apiKey`. | Use Ctrl+Shift+V to save the image to `assets/` instead, or fix the key. |
| Ctrl+Shift+V pastes plain text | The clipboard has no `text/html`, or the event carried none and the async clipboard read was denied (one-time WebView prompt). | Accept the prompt or paste plain. |
| Voice: nothing happens, or `Could not use the microphone` | `getUserMedia` failed or is pending. Older builds show only the generic message. Current builds distinguish: "Preparing the microphone..." (pending), after 5 s "Waiting for microphone permission..." (a WebView prompt may be showing), "Microphone access is blocked..." (permission denied at the prompt or by the OS), "No microphone was found", "The microphone cannot be opened" (busy), and "Voice input works in the editor view" (the rendered preview is showing). The generic message remains for a missing `MediaRecorder`/`mediaDevices`. | Allow the microphone (WebView prompt; Windows Settings -> Privacy and security -> Microphone, which the app's own message names; macOS System Settings), unverified where a denial is stored; switch out of preview mode. |
| Voice: marker becomes `⦅文字起こし失敗 ...⦆` and a toast shows an error | The API said no: no key (`Gemini API Keyが設定されていません`), a non-Gemini model/URL (`voice transcription needs a Gemini model`), a Live model (`...Live API...` message; use `gemini-3.5-transcribe`), an unknown `apiStyle` or `mode`, a 4xx/5xx (`Gemini APIエラー (code)`), or an empty transcript. | Fix `voice.*` (see `setup-guide.md`), then click `[再試行]`. The audio stays in `<cfg>/voice_cache`. |
| Voice: `[再試行]` says the cache is missing | The id-to-file map lives in browser storage, which is per origin (port change) or was cleared; the file may still exist. | Look in `<cfg>/voice_cache/` for `*_<id>.webm`. |
| "Render Image" does nothing / errors | No Gemini key (image -> vision -> text order); no ```` ```mermaid ```` block found; model without image output; network. | Set a key; put the caret in a mermaid block. |
| AI CLI generates a command but nothing runs | By design: the command is placed in the bar for review (badge `WARN`/`BLOCKED` reflects the guard). Enter runs it. | Read it, then press Enter. |
| CLI-bar output shows `?` for Japanese (Windows) | `cmd` built-ins pipe text in the system ANSI code page; only code pages 932 and 65001 round-trip Japanese (`console_windows.go`). | Use PowerShell syntax/tools that write UTF-8, or enable the UTF-8 system locale (unverified where in Windows settings). |
| CLI bar replaced my whole note | `cli.openResultInNewTab` is false and nothing was selected: the ENTIRE note is replaced by the output. (With the option true and no selection only a result tab opens; with a selection the selection is replaced AND a tab opens.) | Ctrl+Z; select first, or turn the option on. |

---

## 5. Sync, Mobile Drop, network

| Symptom | Cause | Fix |
|---|---|---|
| Git status stays `disabled` / nothing syncs | `scraps.gitSyncEnabled` false, or `<scrapDir>` is not a git work tree (the engine returns silently), or `git` is not on PATH. | Settings -> Sync: Link / Init; check `git --version`. |
| `Git: Push failed` / `Pull failed` | No remote or wrong branch, or credentials need a prompt (`GIT_TERMINAL_PROMPT=0` disables prompts), or a 120 s network timeout. Local commits still happen (`chore(scrap): sync YYYY-MM-DD HH:mm`). | `git -C <scrapDir> remote -v` and `git -C <scrapDir> push origin <branch>` by hand to see the real error; set up a credential helper or SSH key. |
| Link / Init: "Remote repository already has existing conflicting files" | The remote is not empty and the automatic `pull --rebase --allow-unrelated-histories` conflicted. | Use an EMPTY remote (no README). |
| Secrets appeared in the remote | `git add .` commits everything in the scraps folder, including `.env` and `.md-memo/agents.yaml`. | Add them to `<scrapDir>/.gitignore` BEFORE enabling sync; rotate any leaked key. |
| Phone cannot open the Mobile Drop page | Different network or AP isolation (guest Wi-Fi), a VPN, the Windows firewall prompt was declined (allow private networks; unverified OS behaviour), or the QR encodes the adapter that carries the default route while the phone is on another network. The server binds `0.0.0.0` on 8765 (random port if taken). | Same Wi-Fi, allow the firewall, or use the tunnel. |
| Phone page: `forbidden` (403) | Missing/wrong token: the URL must carry `?token=` exactly as shown; a new dialog issues a new token. | Rescan the current QR. |
| Phone page: session expired / `already used` (409) | 60 s without activity (90 s in tunnel mode), the dialog was closed, or one submission was already accepted (one per session). | Reopen Mobile Drop and rescan. |
| Upload refused: `payload too large` (413) / `unsupported file` (415) / `too many files` | Limits: single upload 20 MB, batch 60 MB, image 20 MB, audio 25 MB, other files 2 MB, no NUL bytes in text files, at most 10 files. | Send smaller or text files. |
| Photo/voice item shows `[Mobile Drop: <name>の処理に失敗しました: ...]` (only if saving to `assets/` also failed; otherwise the file is kept there with a link) | OCR/transcription failed for that item (key, model, network); the rest of the batch still arrived. | Fix `vision.*` / `voice.*`; resend. |
| Tunnel button: cloudflared missing | `cloudflared` is not on PATH nor in the fallback locations (`interfaces.md` 6.3); the dialog offers the install command with Copy. MD-Memo never installs it. | Install it (Windows `winget install --id Cloudflare.cloudflared -e`, macOS `brew install cloudflared`), press the button again. |
| Tunnel: timed out / exited before printing a URL | No `https://*.trycloudflare.com` URL on cloudflared's stderr within 15 s: network, proxy or firewall. | Check connectivity; retry (a failed attempt may be retried). |
| Update badge appears on the help button | MD-Memo asks `api.github.com` for the latest release 2.5 s after start; no setting disables it. | Nothing to fix. |

---

## 6. Interpreting other people's reports

- "It worked yesterday": check whether a UI save or status-bar toggle rewrote `config.json`, and whether the tray-resident instance was started before your edit (then it never re-read the file).
- "The manual says X": the manuals are orientation only. This reference is derived from source; where they disagree, source wins (see the list in the final report for known differences).

---

## Source of truth

`pkg/cli/client.go`, `pkg/cli/headless.go`, `pkg/ipc/ipc.go`, `app_rpc.go`, `main.go`, `console_windows.go`, `window_windows.go`, `window_darwin.go`, `hotkey_darwin.go`, `pkg/shellenv/shellenv.go`, `app_config.go`, `app_scrap.go`, `app_slot.go`, `app_jev.go`, `app_cli.go`, `cli_ai.go`, `ollama_ops*.go`, `pkg/slotagent/*`, `pkg/jev/*`, `pkg/llm/*`, `pkg/gitsync/gitsync.go`, `pkg/dropzone/*`, `frontend/js/app.js` (`selectTab`, `syncBackendConfig`, status-bar handlers, CLI bar, ghost text), `frontend/js/{slot_agent,jev_action,voice_input,file_anchor,task_manager}.js`, `frontend/index.html`.
