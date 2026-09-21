# MD-Memo interface reference (for agents)

Basis: app version 1.5.5 (`AppVersion` in `app.go`), read from the working tree on 2026-09-21. Everything below was checked in source; statements that could not be checked are marked `(unverified)`. Areas that were being edited by other people while this was written are marked `(in flux)`: the voice schema, Mobile Drop retry/fallback, `/ping?grace`. Re-check those in the files named in "Source of truth" before relying on them.

Conventions: `<cfg>` = the per-user data folder `<ConfigDir>/md-memo/` (Windows `%AppData%\md-memo\`, macOS `~/Library/Application Support/md-memo/`; Linux would be `$XDG_CONFIG_HOME` or `~/.config` but Linux has no window layer and is not a supported platform). `md-memo` = the binary (winget alias `md-memo`; Homebrew symlink `md-memo`; in a dev tree `md-memo.exe` / `MD-Memo.app/Contents/MacOS/MD-Memo`).

Shape of the product: a Go core hosting an OS WebView (Windows WebView2, macOS WKWebView). The editor is a plain `<textarea>` (no CodeMirror). The UI is served from an embedded filesystem at `http://127.0.0.1:41739/` (random port if busy). One process at a time (single instance). Tray-resident on Windows by default.

---

## 0. Which surface for which job

| Job | Surface | Needs running GUI |
|---|---|---|
| Read/replace/append note text, list/switch tabs | CLI `buffer` / `tab` (section 1) or raw JSON-RPC (section 2) | yes |
| Append text to today's scrap file | `cmd \| md-memo` | no (cold-starts the GUI if closed) |
| Check a shell command for danger | `md-memo jev verify` (section 1.4, 7) | no |
| Trim a Markdown file to relevant sections | `md-memo agent prune` | no |
| Run arbitrary UI code | `md-memo ui eval` (dangerous, section 1.3) | yes |
| Change settings, agents, shortcuts | edit files while the app is closed (see `setup-guide.md`) | no |

---

## 1. Headless CLI

Entry point: `main.go` (`main`, `isSubcommand`), `pkg/cli/client.go`, `pkg/cli/headless.go`, `pkg/cli/format.go`.

### 1.0 How the binary is dispatched

| Invocation | Effect | Notes |
|---|---|---|
| `md-memo buffer ...`, `md-memo tab ...`, `md-memo ui ...` | JSON-RPC client against the running GUI | Needs `<cfg>/ipc-session.json` and a live process. Otherwise: stderr `Error: md-memo is not running. Launch md-memo first or use --headless.`, exit 1 (the hint is misleading: `--headless` does not support these three). |
| `md-memo jev ...`, `md-memo agent ...` | Local computation, no GUI | Also reachable as `md-memo --headless jev ...`. |
| `md-memo --headless help` (also `--help`, `-h`) | Prints the headless usage (only jev and agent) | There is no top-level `md-memo --help` or `--version`: unknown flags fall through to a normal GUI start. |
| `md-memo` (no args) | Starts the GUI, or fronts the running instance | Never run this from an agent unless the user asked to start MD-Memo. |
| `md-memo <path>` | Opens the file in a new tab (running instance: legacy IPC `open`; cold start: `GetStartupFile`) | The first non-flag argument that is an existing file wins. |
| `cmd \| md-memo [title words]` | Appends stdin (max 10 MB, hard constant `maxPipeBytes`) to today's scrap; title words become the heading | Running instance: legacy IPC `pipe`. Not running: starts the GUI, waits up to 3 s for the page to signal ready, then appends once. |

`jev` and `agent` never build the Jev HTTP client unless the subcommand needs it (`predict`, `dispatch`), so `verify`, `score`, `prune` are local and cheap.

### 1.1 Output format and exit codes (all subcommands)

- Format resolution (`pkg/cli/format.go`): `--json` wins, then `--text`, otherwise text when stdout is a terminal (char device) and JSON when it is not. Piped or redirected stdout therefore yields JSON by default.
- JSON is pretty-printed (2-space indent), one document, trailing newline.
- Exit code `0` success. `1` any error (message on stderr as `Error: <text>`), including flag-parse errors and RPC errors. `jev verify` additionally returns `2` for "warn".
- Flag parsing uses Go's `flag` package: `-x` and `--x` are equivalent; flags must come BEFORE positional text; parsing stops at the first non-flag. Put `--` before content that starts with `-`. (`buffer set/append/replace/replace-selection` additionally auto-insert `--` before the first unknown flag-like word, e.g. Markdown `- [ ] item`; `jev verify` does not.)
- Content rule for `buffer set|append|replace|replace-selection` (`readRemainingInput`): positional args joined with single spaces; if there are none, stdin is read when it is not a terminal; otherwise the content is the empty string. Consequence: `buffer set` with no args and an empty/closed non-terminal stdin sets the buffer to EMPTY (undo restores it). Always pass content explicitly.
- Windows PowerShell 5.1 pipes to native programs in the console/ANSI encoding by default (general PowerShell behaviour, unverified in this repo); non-ASCII content is safer through the JSON-RPC route (section 2) or PowerShell 7 with UTF-8.

### 1.2 `buffer`

Requires a running GUI. Each call is one RPC with a 3 s client timeout.

| Command | Flags | Result (text mode / JSON mode) | Errors |
|---|---|---|---|
| `buffer get` | `--tab <id>` (honoured), `--json`, `--text` | text: raw note content, no trailing newline added. JSON: `{tab_id, title, file_path?, content, hash, generation, length, line_count, is_active, is_modified}` | unknown `--tab` id: returns an EMPTY buffer without error (JS returns null; Go accepts it) |
| `buffer get --selection` | `--tab` (honoured) | text: selected text only. JSON: `{text, start, end}` (UTF-16 offsets). | none selected: stderr `Error: no active selection`, exit 1 (RPC code -32003) |
| `buffer set` | `--expected-hash <16hex>`, `--expected-gen <uint>`, `--tab` (IGNORED) | text: `Buffer updated (Generation: N, Hash: H)`. JSON: `{success, hash, generation, length}` (`length` is UTF-8 bytes here) | hash/generation mismatch: `conflict: expected hash X but buffer is at Y`, exit 1 |
| `buffer append` | `--tab` (IGNORED) | text: `Content appended to buffer`. JSON: `{success: true}` | none. No optimistic lock. |
| `buffer replace` | `--start L:C` (default `1:1`), `--end L:C` (default `1:1`), `--expected-hash`, `--tab` (IGNORED) | text: `Range replaced (New Generation: N)`. JSON: `{success, generation}` | hash mismatch -> conflict. `--expected-gen` does not exist for this command. |
| `buffer replace-selection` | `--tab` (honoured) | text: `Selection replaced (New Generation: N)`. JSON: `{success, generation, start, end}` (start/end select the inserted text). CRLF in content is normalised to LF. | no selection: stderr `Error: no active selection`; caret moved between read and write: conflict `selection changed before replace could be applied` |

Semantics that matter:
- Line/column are 1-based; a column is a UTF-16 code-unit offset in the line; lines are split on `\n` only; out-of-range positions are clamped; `--end` before `--start` is clamped to `--start`; malformed `L:C` falls back to `1:1`. Because `--end` defaults to `1:1`, `buffer replace` without `--end` INSERTS at the start of the note. To replace everything use `buffer set`.
- `hash` = first 8 bytes (16 hex characters) of SHA-256 of the buffer text as UTF-8, computed by the Go side. `generation` is one process-wide counter starting at 1 that increments only on RPC writes (`set`, `append`, `replace`, `replace-selection`); it does not change when the user types and is not per tab. Use `hash` to detect any change, `generation` only to detect other RPC writers.
- `buffer.get`, `buffer.set`, `buffer.append`, `buffer.replace` act on the tab that is active in the PRIMARY pane (`activeTabId`); if the split editor's right pane is focused they still act on the primary pane's tab. The two selection commands act on the focused pane's editor.
- The optimistic-lock check is skipped silently if the pre-check RPC into the WebView fails (`if err == nil` in `app_rpc.go`), so a lock is a best-effort guard, not a guarantee.
- Writes go through the editor's normal input path (`execCommand insertText` with fallback), so they are undoable (Ctrl+Z) and behave like typing: the tab becomes dirty; with `general.autoSave` true (default) and a tab bound to a file, the FILE IS REWRITTEN about 1.5 s later; ghost-text autocomplete and Quick Actions prediction are also triggered by the resulting `input` event (which can send note text to a configured LLM).
- `tab_id` inside `buffer get --json` is always `0` (the Go struct field is never filled). Take ids from `tab list`.

Optimistic-lock recipe: `md-memo buffer get --json` -> keep `hash` -> compute the edit -> `md-memo buffer set --expected-hash <hash> "<new text>"` -> on `conflict` re-read and redo.

### 1.3 `tab` and `ui`

| Command | Behaviour | Output | Notes |
|---|---|---|---|
| `tab list` | RPC `tab.list` | text: `Open Tabs:` then ` * [id] title (path)` (`*` marks the active tab). JSON: array of `{id, title, path, isActive, isModified}` | ids look like `tab_<ms>_<rand6>`. |
| `tab switch <id>` | RPC `tab.switch` | `Switched to tab: <id>` (always text) | HAZARD: `selectTab` assigns `activeTabId` BEFORE checking the tab exists (`app.js` `selectTab`). An unknown id is not rejected and leaves the app with no valid active tab until the user clicks a tab. Use only ids from `tab list`. |
| `ui activate` | RPC `ui.activate`, fronts the window | `Window activated` | Works even when hidden to the tray. |
| `ui toggle-split` | RPC `ui.toggle_split` | `Split view toggled` | |
| `ui eval <js...>` | RPC `ui.eval`: JS runs in the page (global scope only) | prints the JSON-serialised value; `undefined` prints `null` | DANGEROUS. Full control of the UI and of every bound Go function via `window.backend` (including reading the config with API keys). `eval(code)` runs first; if it throws for ANY reason the code is retried as a function body via `new Function`, so a side-effecting expression that throws executes twice. `await` is not usable at top level; return a Promise instead. 3 s client / 5 s server timeout. |

`tab new` / `tab close` are named in an error string but not implemented (`unknown tab action`). Equivalents through `ui eval`: `window.__mdMemoRPC.newTab(title, content, path)` and `window.__mdMemoRPC.closeTab(id)` (`closeTab` shows a save prompt for a dirty tab and waits for the user).

### 1.4 `jev` (local guard and scoring) and `agent prune`

Local unless noted. Flags for `jev *`: `--json`, `--text`, `--quiet` (text mode prints nothing; the exit code still speaks).

| Command | Behaviour | Output |
|---|---|---|
| `jev verify [--mode strict\|reviewed\|unattended] <cmd...>` | Runs `jev.VerifyCommand(cmd, mode, nil)`. Default mode `strict`. Unknown mode: error, exit 1. Empty command: error. | Exit `0` safe, `1` blocked, `2` warn. Text: `[SAFE] Command passed AST validation: <cmd>` on stdout; `[WARN] <reason> (Command: <cmd>)` or `[BLOCKED] <reason> (Command: <cmd>)` on stderr. JSON (stdout, also default when piped): `{isSafe, reason, command, parseFailed?, rule?, subject?, level}` where `level` is `safe`/`warn`/`block`. `isSafe` is true only for `safe`. |
| `jev score <cmd...>` | Expected destructive impact on a 3-step scale from the strict verdict plus keyword heuristics. Always exit 0 unless error. | JSON `{score, probabilities:[safe, modifying, destructive]}`. Text `[SAFE\|MODIFYING\|DESTRUCTIVE] Expected Risk Score: x (Probabilities: Safe=, Mod=, Dest=)` (labels: score >= 1.5 destructive, >= 0.5 modifying). |
| `jev predict --input <task>` (or trailing words) | Candidate next actions (3 orthogonal picks). May use the network: with `OPENROUTER_API_KEY` set (allowed in the CLI only), or `TYPESAFE_API_KEY`/`JEV_API_KEY`, or `JEV_API_URL`, the task text is sent to that service; with none set it is local rules. | JSON array of `{action_type, command, description, scope, confidence?}`. Text: `Input: ...` then `  [n] (type) command`. |
| `jev dispatch <input...>` | Routing decision direct vs escalate (System One primitives, or heuristics when no key/endpoint). Same network rule as `predict`. 5 s timeout. | JSON `{action_type, confidence, selected_command, target_agent, pruned_context, should_escalate}`. |
| `agent prune [--query q] [--file path]` (flags `--json`, `--query`, `--file`) | Keeps Markdown sections (split on `#` headings) that match query keywords (words >= 3 chars, minus a small stop list; +2 for sections containing `- [ ]`/`- [x]`); if nothing matches returns the first 500 chars + `...(pruned)`. Reads stdin when `--file` is absent (blocks if stdin is a terminal). | Text: pruned Markdown. JSON: `{original_length, pruned_length, ratio, content}`. |

`--mode` and other flags must precede the command text. Commands whose first word starts with `-` need `--` first.

Not implemented (design documents only, verified absent from the code): `md-memo share`, `md-memo agent init-skill`, `md-memo config ...`, `filters.json`, `prompts.json`, `hooks/`, and reading of `jev.json` / `.jev.json` (the rules engine `jev.NewRules` exists but no production code loads any file; every caller passes `nil`). See `docs/design/agent-malleable-architecture.md`.

---

## 2. JSON-RPC 2.0 over local TCP (what the CLI uses)

Source: `pkg/ipc/ipc.go`, `pkg/ipc/rpc_types.go`, `app_rpc.go`, `window.__mdMemoRPC` in `frontend/js/app.js`.

### 2.1 Transport and discovery

- Loopback TCP, newline-delimited JSON (one request per line, one response line). Server binds `127.0.0.1` only. Preferred port 49152; if busy a random free port is used, so ALWAYS read the port from the session file.
- Session file: `<cfg>/ipc-session.json`, mode 0600, `{"pid": int, "port": int, "token": "<64 hex>", "started_at": "<RFC3339>"}`. Removed on graceful exit. A stale file (PID dead, or port refuses within 200 ms) is deleted by the next CLI call.
- Limits: 11 MB per line, 10 s deadline per connection, 5 s per RPC inside the app (`context.WithTimeout`). Several requests may share one connection.
- Auth: the request may carry `"auth": "<token>"`. It is rejected (`-32000`) ONLY when a token is supplied and is wrong. A request with no `auth` field is accepted. Treat the port as open to every local program; `ui.eval` can do anything the UI can.
- Always send an `id`. A request without `id` is a notification: it is executed but no response is written.

Request: `{"jsonrpc":"2.0","id":1,"method":"buffer.get","params":{...},"auth":"<token>"}`. Response: `{"jsonrpc":"2.0","id":1,"result":...}` or `{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"..."}}`.

Minimal client (Python):

```python
import json, os, socket
sess = json.load(open(os.path.join(os.environ["APPDATA"], "md-memo", "ipc-session.json")))  # macOS: ~/Library/Application Support/md-memo/ipc-session.json
s = socket.create_connection(("127.0.0.1", sess["port"]), timeout=3)
req = {"jsonrpc": "2.0", "id": 1, "method": "tab.list", "auth": sess["token"]}
s.sendall((json.dumps(req) + "\n").encode("utf-8"))
print(json.loads(s.makefile("r", encoding="utf-8").readline()))
```

### 2.2 Methods

`tab_id` accepts the string ids from `tab.list`; empty or absent = active tab.

| Method | Params | Result | Notes |
|---|---|---|---|
| `buffer.get` | `{tab_id?}` | `{tab_id:0, title, file_path?, content, hash, generation, length, line_count, is_active, is_modified}` (`length` = JS string length = UTF-16 units) | honours `tab_id`. |
| `buffer.set` | `{content, expected_hash?, expected_generation?, tab_id?(ignored)}` | `{success:true, hash, generation, length}` | -32001 on mismatch; -32602 on bad params. |
| `buffer.append` | `{content, tab_id?(ignored)}` | `{success:true}` | |
| `buffer.replace` | `{start_line, start_col, end_line, end_col, content, expected_hash?, tab_id?(ignored)}` | `{success:true, generation}` | `expected_generation` is accepted by the struct but not checked here. |
| `buffer.get_selection` | `{tab_id?}` | `{tab_id, text, start, end}` (UTF-16 offsets) | -32003 when nothing is selected. Honours `tab_id`. |
| `buffer.replace_selection` | `{content, tab_id?}` | `{success:true, generation, start, end}` | Re-reads the selection, re-checks bounds inside JS; -32003 no selection; -32001 selection changed. Honours `tab_id`. |
| `tab.list` | none | `[{id, title, path, isActive, isModified}]` | `isModified` = tab dirty flag. |
| `tab.switch` | `{tab_id}` | `{success:true}` | Same unknown-id hazard as the CLI. |
| `ui.toggle_split` | none | `{success:true}` | |
| `ui.activate` | none | `{success:true}` | |
| `ui.eval` | `{expression}` | a JSON string holding the JSON text of the value | see 1.3. |

### 2.3 Error codes

| Code | Meaning in this app |
|---|---|
| -32700 | line was not valid JSON (`Parse error: invalid JSON`); connection is closed |
| -32600 | JSON did not fit a request object |
| -32601 | unknown method (`method not found: X`) |
| -32602 | params missing/invalid (`invalid buffer.set params`, ...) |
| -32603 | internal: JS threw, `webview is not running`, timeout (`context deadline exceeded`), panic |
| -32000 | wrong `auth` token |
| -32001 | conflict: hash/generation mismatch, or selection changed |
| -32002 | defined (`ErrCodeNotFound`), never returned |
| -32003 | `no active selection` |

### 2.4 Legacy one-line messages (used by `md-memo`, `cmd | md-memo`, `md-memo file`)

A JSON line with an `action` field and no `method`: `{"action":"pipe","content":"...","command":"git diff","cwd":"...","timestamp":"..."}`, `{"action":"activate"}`, `{"action":"open","path":"<absolute path>"}`. The reply is one line `{"ok":true,"app":"md-memo"}` sent BEFORE the handler runs. `pipe` appends to today's scrap and fronts the window; `open` opens the file in a new tab; `activate` fronts the window. Prefer the CLI for these.

---

## 3. In-note syntax the app understands

### 3.1 Slots (delegate work to an external agent CLI) and recipes

Source: `pkg/slotagent/parser.go`, `config.go`, `runner.go`, `pipeline.go`, `skill.go`, `app_slot.go`, `frontend/js/slot_agent.js`.

Default notations (`DefaultSlotConfig`; replaced wholesale if `slot_profiles` / `recipes` are configured, see `setup-guide.md`):

| Open ... close | Profile | Default agent | Standing instruction (abridged) |
|---|---|---|---|
| `{{ ... }}` | `code` | `claude-code` | no preamble, runnable code only |
| `[? ... ]` | `research` | `claude-code` | web research with figures and primary-source URLs |
| `【? ... 】` | `writing` | `hermes` | fully local, business-Japanese bullets |
| `[! ... !]` | `adversarial` | `claude-code` | name three risks / vulnerabilities / bottlenecks |
| `[>> ... ]` | recipe `deep-research-and-code` | config default agent | 3 steps, pause before step 3 (`requires_approval_step: 2`), `self_refine: true` |

Parsing rules:
- The earliest open delimiter in the text starts a candidate; its slot ends at the FIRST closing delimiter after it. No nesting. `]` inside a `[? ]` slot ends it.
- Ranges inside fenced code blocks (backtick or tilde fences), inline code, Markdown links `[t](u)` and bare `http(s)://` URLs are never slots. A slot that overlaps one of those ranges is skipped.
- Content starting `⟳`, `実行中...` or `(実行中...)` is a running placeholder and is skipped.
- Role: content starting `@name` names a skill (`@name: instruction` or `@name instruction`); otherwise `role: instruction` when the text before the first `:` has no whitespace and is <= 20 characters; otherwise the profile name. The role is only a label (and the skill selector); it does not change the agent.
- Which slot runs (`ParseSlotsRPC` / `RunSlotAgentAsync`): the slot containing the caret, else the NEAREST slot AFTER the caret, else the FIRST slot in the note. So Ctrl+Enter anywhere in a note that contains any slot runs one of them. "No slot found" appears only when the note has no slot at all.
- Full-width `｛｛`, `［？`, `【？` typed by an IME are converted to `{{`, `[?`, `【?`. Typing an open delimiter opens a quick selector (Up/Down, Tab/Enter, 1-9, Esc); confirming inserts `{{ code: ` ... ` }}`.
- Trigger: Ctrl+Enter (Cmd+Enter on macOS) with the caret in the editor, or the floating Run button that appears beside a complete, not-running slot. Concurrency guard: a slot already replaced by the placeholder, or another run within 30 characters of the same offset, is refused with a toast.

What happens on run:
1. The slot text is replaced by `<open> ⟳ 実行中... <close>` (undoable), a task card is created (task panel, section 4).
2. The note file is prepared for the agent: an unsaved note is written to a temp file `md-memo-slot-*.md`; a note with a path is OVERWRITTEN on disk with the current in-memory text (UTF-8, whatever the tab's encoding, and even if autosave is off).
3. The agent is started without a shell: `exec(command, args...)`. `{file}` = note path, `{instruction}` = `"<system_instruction>\n\nTask: <instruction>"` (or just the instruction). If no arg contains `{instruction}` it is appended as the last argument. If no arg contains `{file}` and the instruction mentions `このメモ` / `このノート` / `カレントメモ`, a Japanese line with the file path is prepended. Working directory = the project root (nearest ancestor of the note containing `.md-memo`, `agents.yaml|yml|json`, `AGENTS.md`, `skills`, or `.git`; else the note's folder; for an unsaved note the temp file's location). `<projectRoot>/.env` (only that file) is merged into the environment for this process only.
4. stdout (trimmed, capped at 10 MB) replaces the slot. Inline slots (text before/after on the same line) have newlines flattened to spaces. Nonzero exit or stderr: the slot becomes `<open> [U+26A0] エラー: <first 1000 chars of stderr or Exit Code N> (再試行: Ctrl+Enter) <close>`; timeout is exit 124 with `[U+26A0] エラー: タイムアウト (再試行: Ctrl+Enter)`; cancel is 130. (`[U+26A0]` stands for the single warning-sign character U+26A0 that the app really writes, followed by one space; it is spelled out here only to keep these files free of pictographs. To detect a failed slot, match the text `エラー:` inside the slot.)
5. Merging waits until the user has been idle for 500 ms, then applies the result, keeps the caret and scroll, and flashes the editor for `ghost_diff_duration_ms` (Ghost Diff). Esc during the flash (and 1 s after) restores the original slot text; Ctrl+Z does too.
6. `@skill` slots: `skills/<name>/SKILL.md`, `skills/<name>.md`, `skills/<name>/README.md`, `.gemini/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md` under the project root; YAML frontmatter is stripped and the body is appended to the system instruction (and used as the instruction if the slot has none). Missing skill: the slot becomes `<open> [U+26A0] スキル '<name>' が見つかりません (skills/<name>/SKILL.md) <close>`. (This very folder, `skills/md-memo/SKILL.md`, is therefore usable as `{{ @md-memo: ... }}` in a note inside this repository.)
7. Recipes: steps run in order through the default agent with no system instruction. With `self_refine`, step 1 becomes draft -> critique -> revise (max 2 passes). If `requires_approval_step` = N, after step N the slot is replaced by the step output plus a gate line `- [ ] 次のステップ（<next step, first 30 chars>...）を実行する // approve`. The user changes `[ ]` to `[x]` and presses Ctrl+Enter to resume. Resume always uses the first configured recipe when the caret is not inside a recipe slot.

### 3.2 Ghost text (inline completion)

- Shown as dimmed text after the caret. Requested after typing pauses `max(autocomplete.delayMs || 600, 300)` ms, only when `autocomplete.enabled`, no selection, not composing an IME, not in preview, the note is non-empty and the text before the caret has >= 2 non-space characters. The last 1200 bytes before the caret are sent (the text after the caret is not used).
- Accept all: Tab or Right Arrow (only while the caret is where the suggestion was made); accept one word: Ctrl+Right (Alt+Right / Cmd+Right also accepted); dismiss: Esc or keep typing. Secondary pane has no ghost text.
- Endpoint choice (`llm.QueryAutocomplete`): Gemini if the URL contains `googleapis.com` or the model contains `gemini`; OpenAI-style (`/v1/completions` first, then `/v1/chat/completions`) if the URL contains `/v1`, `:1234`, `:8080`, `:5000`, `:8000`, `openai.com`, `groq.com`, or an API key is set on a non-localhost URL; otherwise Ollama `/api/generate` with an OpenAI-style fallback. `maxTokens` <= 0 or > 250 becomes 30. HTTP timeout 30 s.
- If the URL is `127.0.0.1:11434` / `localhost:11434` and Ollama does not answer `GET /api/tags` within 1.5 s, the app tries to start Ollama and waits up to 4 s.
- A second ghost source is the IME Guardian (Japanese UI only): `[Tab: <hiragana>]` offering a romaji-to-kana replacement.

### 3.3 File links

`[label](target)` and `![label](target)` on one line. `target` may be a `file://` URL, an absolute path, or a path relative to the note's folder (or the open workspace folder); it may be wrapped in `<...>`. `http(s):` and `mailto:` targets are ignored by this feature.
- Ctrl+Click (Cmd+Click on macOS) with the caret on the link: opens with the OS default app (`rundll32 url.dll,FileProtocolHandler` / `open` / `xdg-open`). Alt+Click (Option+Click) without Ctrl/Cmd: reveals in Explorer (`explorer.exe /select,`) / Finder (`open -R`). The target must exist. Only plain paths and `file:` URLs are accepted; other schemes are refused.
- Hovering an image link for 300 ms shows a thumbnail (<= 240x180) served by `/api/image?path=` (image extensions only).
- Dropping files on the editor text inserts one link per line: with a known `file.path` a `file://` link, otherwise the file is copied to `<note folder>/assets/<sanitised original name>` (<= 25 MB; `-2`, `-3` on name clash) and linked relatively; spaces and parentheses in targets are percent-encoded. Dropping on the tab bar or header opens the file as a tab instead.
- Special paste (Ctrl+Shift+V): clipboard HTML is converted to Markdown by the built-in converter (`html_to_md.js`); an image-only clipboard is saved to `assets/YYYY-MM-DD-HHmmss.<png|jpg|gif|webp>` and linked as `![image](./assets/...)`. Plain Ctrl+V with an image-only clipboard runs vision OCR when `general.pasteImageOcr` is true.

### 3.4 Voice-input markers

The `voiceInput` shortcut (default Ctrl+Shift+R, Cmd+Shift+R on macOS; `(in flux)`: rebindable and no longer a fixed key in the working tree, older builds hard-coded it) toggles recording. Other entry points in the working tree: the toolbar microphone button `btn-voice-input` (shows an active state while recording), the context-menu item `ctx-voice-input`, and the command palette. Recording needs the editor view (not the rendered preview). Start-up feedback in the status bar: "Preparing the microphone...", after 5 s "Waiting for microphone permission...", and specific failure messages (blocked, no microphone found, microphone busy) instead of one generic error. The marker is written at the caret and replaced in place, so the user can keep typing:

| State | Marker text |
|---|---|
| recording | `⦅音声入力中... [id:xxxx]⦆` (`xxxx` = 4 random `[a-z0-9]`) |
| transcribing | `⦅文字起こし中... [id:xxxx]⦆` |
| failed | `⦅文字起こし失敗: [再試行(id:xxxx)] [音声保存] [破棄]⦆` |

Clicking with the caret inside `[再試行(...)]` retries; `[音声保存]` moves the recording to `assets/voice_note.webm` and replaces the marker with `[audio](<link>)`; `[破棄]` deletes it. Failed recordings are cached in `<cfg>/voice_cache/<YYYY-MM-DD-HHmmss>_<id>.webm` (mode 0600); the id-to-file map lives in browser storage key `md_memo_voice_cache_v1`. Esc while recording aborts and removes the marker. Auto-stop after `voice.silence_timeout_sec` of silence (default 5, UI range 1-30; RMS threshold 0.015). Recording format: `audio/webm;codecs=opus`, else `audio/webm`, else `audio/mp4`. The microphone prompt is the WebView's own one-time prompt; nothing is granted silently. Model/API selection: see `setup-guide.md` (voice schema `(in flux)`; PC recording, retry and Mobile Drop all build the request through `VoiceInput.configJSON`).

### 3.5 Mobile Drop headings

A phone submission is appended to the END of the active note. Each item gets `\n\n## Mobile Drop [HH:MM:SS]` + ` — <filename>` (when a filename exists; control characters flattened, max 120 runes) + ` (<lat>, <lon>)` on the FIRST item only when the phone attached a location (tunnel/HTTPS only), then a blank line and the body:
- photo: vision-OCR Markdown (one outer ```markdown/```md/```text fence removed);
- voice: transcription text;
- text file: `.md`/`.markdown`/`.txt` verbatim, other text files in a fenced block with a language from the extension (Shift_JIS decoded);
- typed text: as typed; a lone `http(s)` URL becomes `[url](url)`.
A failed item is `[Mobile Drop: <name>の処理に失敗しました: <error>]`. `(in flux)`: the working tree adds a fallback that keeps a photo or voice note whose OCR/transcription failed as a file under `assets/` with a link and a one-line reason instead.

### 3.6 AI answer handling

- Anchors: while a model call runs the app inserts a bracketed placeholder in the note's UI language and replaces it when the call ends: `[AI Generating: <first 20 chars of instruction>...]` / `[AI 生成中: ...]` (Ctrl+K), `[LLM Generating...]` / `[LLM 生成中...]` (Ctrl+L), `[AI Correcting...]` / `[AI補正中...]` (Alt+C), `[Transcribing Image (Gemini)...]` / `[画像マークダウン変換中 (Gemini)...]` (OCR), plus diagram anchors. If the app dies mid-call the anchor stays in the note. Errors replace the anchor with `[LLM error: <text>]` / `[LLMエラー: ...]`. A 180 s watchdog resolves stuck requests as a timeout error.
- Unwrapping (`stripMarkdownCodeFences`, `app.js`): `<think>...</think>` blocks (and an unclosed `<think>` tail) are removed. Inline-AI and other free-form answers: only a single wrapper fenced ```markdown or ```md around the WHOLE answer is removed, and only if it is a true wrapper (inner fences properly nested); a real ```python block, an untagged block, or several blocks with prose between them are left exactly as returned. Vision/OCR results and Alt+C corrections use the broader rule (untagged and ```text wrappers are also removed); corrections also strip intro phrases ("Corrected text:", "修正後のテキスト:") and surrounding quotes, and roll back to the original text on an empty or failed result.

---

## 4. GUI surfaces

### 4.1 Shortcuts

Registry: `config.shortcuts.<action>` = combo string (`Ctrl+Shift+P`, `Cmd+Option+F`, ...; modifiers `Ctrl|Control|Cmd|Command|Shift|Alt|Option`, then one key: a letter/digit, `F1`-`F24`, `ArrowUp` ..., `\`, `,`, punctuation; empty string = unassigned). On macOS a bare `Ctrl` is treated as Cmd unless `Cmd` is also present. Defaults are `DEFAULT_SHORTCUTS_WIN` / `DEFAULT_SHORTCUTS_MAC` in `app.js`. Configurable in Settings -> Shortcuts (click a key button, press the combo, Backspace clears, Esc cancels; a clash asks to steal the combo and clears the other action). Reserved combos are refused by the recorder but are NOT validated when written by hand in `config.json`.

| Action key | Windows default | macOS default |
|---|---|---|
| newTab / openFile / openFolder | Ctrl+N / Ctrl+O / Ctrl+Shift+O | Cmd+N / Cmd+O / Cmd+Shift+O |
| saveFile / saveFileAs / closeTab | Ctrl+S / Ctrl+Shift+S / Ctrl+W | Cmd+S / Cmd+Shift+S / Cmd+W |
| exportPlainText, minimize (Win), convertMermaid, mermaidToImage | unassigned | exportPlainText, convertMermaid, mermaidToImage unassigned; minimize Cmd+M |
| find / replace / gotoLine | Ctrl+F / Ctrl+H / Ctrl+G | Cmd+F / Cmd+Option+F / Cmd+G |
| searchScraps / quickPick | Ctrl+Shift+F / Ctrl+Shift+P | Cmd+Shift+F / Cmd+Shift+P |
| insertDate | F5 | Cmd+Shift+I |
| togglePreview / toggleSplit | Ctrl+P / Ctrl+\ | Cmd+P / Cmd+\ |
| zenMode / toggleMaximize | Ctrl+Shift+Z / F11 | Ctrl+Cmd+Z / Ctrl+Cmd+F |
| globalSummon (OS-wide) | Ctrl+Alt+M | Cmd+Alt+M (Option+Cmd+M) |
| inlinePrompt / llmModal / aiCorrection | Ctrl+K / Ctrl+L / Alt+C | Cmd+K / Cmd+L / Cmd+Shift+C |
| quickActions | Ctrl+J | Cmd+J |
| runCliFilter / runAiCli / mobileDrop | Ctrl+Shift+B / Ctrl+Shift+E / Ctrl+Shift+U | Cmd+Shift+B / Cmd+Shift+E / Cmd+Shift+U |
| voiceInput `(in flux: working-tree key)` | Ctrl+Shift+R | Cmd+Shift+R |
| moveLineUp/Down | Alt+ArrowUp / Alt+ArrowDown | Option+ArrowUp / Option+ArrowDown |
| duplicateLineUp/Down | Shift+Alt+ArrowUp / Shift+Alt+ArrowDown | Shift+Option+ArrowUp / Shift+Option+ArrowDown |
| deleteLine | Ctrl+Shift+K | Cmd+Shift+K |
| insertLineBelow / insertLineAbove | Ctrl+Enter / Ctrl+Shift+Enter | Cmd+Enter / Cmd+Shift+Enter |
| openSettings | Ctrl+, | Cmd+, |

Fixed (not rebindable; handled before the registry): Ctrl+Enter inside the editor (SlotAgent captures it first, so `insertLineBelow` on Ctrl+Enter never fires in the editor), Alt+T (Option+T) task panel, Ctrl+Alt+V (Cmd+Option+V) preview to the side, Ctrl+Shift+V special paste (Cmd+Shift+V), Ctrl+Right accept-word, Ctrl+Tab next tab (literal Ctrl on macOS), Ctrl+, / Cmd+, settings, F11 maximize (Windows), Ctrl+1 / Ctrl+2 focus pane, Ctrl+= / Ctrl+- / Ctrl+0 zoom, F3 / Shift+F3 find next/prev, Esc layered close order, Ctrl+1..3 (and Alt+1..3) and Ctrl+Tab + Enter inside the Quick Actions panel, Ctrl+Z / Ctrl+Y and clipboard keys. Ctrl+T is printed in the New Tab tooltip text but has no handler. `globalSummon` on Windows accepts Ctrl/Alt/Shift/Win + one of `A-Z 0-9 F1-F24 Space Enter Esc`; macOS accepts more (arrows, punctuation, Tab) via `pkg/hotkey`; registration failure reverts the value and shows a toast. The hotkey only brings the window forward; it never hides it.

### 4.2 Command palette (Ctrl+Shift+P)

Substring filter (case-insensitive) over each entry's title and description; Up/Down/Enter/Esc. Entries: New Tab, Open File, Open Folder, CLI filter bar, AI CLI bar, Mobile Drop, Voice Input, three prompt presets (Polish, Bullet points, Action items: they open the Ctrl+K bar pre-filled), Convert to Mermaid, Mermaid to image, Mermaid to image prompt, AI proofread, Export plain text, Zen mode, Toggle split; plus every note found in the open workspace folder (title, relative path and first line; Enter opens it in a new tab). It has no settings entries.

### 4.3 Command bar (Ctrl+Shift+B CLI mode, Ctrl+Shift+E AI CLI mode)

One bar, two modes; clicking the badge (`CLI` / `AI CLI`) switches. Esc closes (and cancels a running command).
- CLI mode: the input is a shell command (datalist of presets and the last 15 commands from browser storage `md_memo_cli_history`). Before running, `ValidateCliCommand` (guard in `reviewed` mode): blocked -> refused, badge `BLOCKED`; warn -> confirm dialog. Input to the command's stdin = the selection if any, otherwise the WHOLE note. Runs in the app's own working directory (no `Dir` is set), 30 s timeout, output capped at 10 MB (both streams), ANSI stripped, exit code 126 = blocked, 124 = timeout, 130 = cancelled. Windows: `cmd.exe /c "chcp 65001 >nul & <cmd>"`, but PowerShell first (`pwsh.exe` if on PATH, else `powershell.exe`, with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`) when the text looks like PowerShell (`IsPowerShellSyntax`: cmdlet verb-noun names, `$_`, `$(`, `${`, any `{...}`, `1..5`, a leading `|`, and the exact commands `sort -r`, `sort -u`, `uniq`, which are mapped to `Sort-Object`/`Get-Unique`), with a fallback to the other shell on "not recognized"-type errors. macOS: `sh -c`.
- Result handling (`config.cli.openResultInNewTab`, default true): with a selection the selection is replaced by the output AND a `[CLI] <cmd>.md` result tab is opened; with no selection only the result tab opens. With the option false: a selection is replaced; with no selection the ENTIRE note is replaced by the output. Failures (`cli.openErrorInNewTab`, default true) open an `[Error] <cmd>.md` tab and keep the bar open with the command for editing.
- AI CLI mode: Enter asks the LLM (`cli.*`, falling back per field to `text.*`) to write ONE command for the OS (temperature 0.2, active file path/dir/name given as context), strips fences/prompts/shell-name headers, validates in `reviewed` mode, puts the command back into the bar in CLI mode (badge `WARN` for warnings, refused with `BLOCKED` when blocked) for the user to read and press Enter. Nothing runs automatically.

### 4.4 Quick Actions (Ctrl+J)

Up to three cards (one per orthogonal slot: generative/local, deterministic/local, generative/global). Auto-appears after `action.delaySec` (default 1.5 s) of no typing unless `action.manualOnly` or `action.enabled` is false; not while composing an IME. The status-bar `Action` badge cycles On -> Manual (key hint) -> Off. Context sent to prediction: up to 1500 characters before and 500 after the caret. With no `action.apiKey`/`baseUrl`(non-default)/env key, prediction is local rules and nothing leaves the machine.
- Keys: Ctrl+1..3 (Cmd on macOS; Alt+1..3 also) runs a card; Ctrl+Tab moves the highlight, then Enter confirms (plain Enter never runs a card); Esc closes.
- Card kinds: delegate (`ai` action or a command that begins with a configured slot open delimiter) inserts the slot on the line after the caret and runs it; run (`sh`) is verified with the STRICT guard then executed (Windows `powershell -NoProfile -NonInteractive -Command`, else `sh -c`; app working directory; 20 s; 2 MB output cap) and appended as `- [x] sh <cmd>` plus the output as a blockquote (<= 3 lines) or fenced block, or `> (出力なし)`; write (`doc` action that is not a slot) calls the built-in LLM, see the Go note in `troubleshooting.md`.

### 4.5 Task panel (Alt+T / Option+T, or click the running-task badge)

Lists running agent/action tasks and the last 10 finished ones (done / failed / canceled). The status-bar badge `stat-tasks` is visible only while something runs (and 4 s after it ends). Each running slot card has a cancel button (kills the agent process tree and restores the slot to the original text) and, when `hover_peek_enabled`, shows the agent's latest output line, polled every second (Hover Peek).

### 4.6 Settings dialog

Open with Ctrl+, (Cmd+,), the toolbar sliders icon, or the context menu. Five tabs. Save closes at once and persists in the background; Cancel/Esc discards live changes (theme, language, shortcuts, toolbar layout are applied live and restored).
1. General: theme (`olive`, `blue`, `forest`, `charcoal`), language (`ja`/`en`), restore session, 2-pane on startup, tray resident, autosave, IME Guardian, AI correction, cursor aura, toolbar and right-click layout editor (show/hide/reorder; the Settings icon cannot be hidden).
2. AI Models: Ollama status/start/stop/"Install Gemma 4" card; Text LLM; Ghost Text; Image OCR/Vision (+ paste-OCR toggle); Voice input (working tree: model with suggestions, API style, language codes, mode, custom vocabulary, silence timeout, prompt; there is no voice key/URL field, it falls back to the Vision ones); Image generation.
3. Agent and CLI (three sections): Commands (Run): CLI model, open result in new tab, Max Pipe Input Size (stored but not enforced); Agents (Delegate): Open agents.yaml button + availability badge, default agent, timeout, Ghost Diff duration, Hover Peek; Suggestions (Quick Actions): enabled, manual only, delay, base URL/model/API key.
4. Sync: scraps folder (+ Browse), Git sync toggle/debounce/branch, Git remote URL with Test Connection and Link/Init, git repo status badge.
5. Shortcuts: table of section 4.1.
Footer: Export... / Import... (native dialogs; JSON of the whole config), Save, Cancel.

### 4.7 Status bar (left to right)

Cursor `Ln, Col`; character count; selection length (when selecting); related-notes pills; LLM activity indicator with count; transient message; task badge; Git sync status (click = trigger a sync now; shows a toast if disabled); `IME: ON/OFF` (Japanese UI only; click toggles); `Action: ON/Ctrl+J/OFF` (click cycles); `Predict: ON/OFF` (click toggles ghost text; shows an error state with the message as tooltip when a request fails); `Autosave: ON/OFF` (click toggles); encoding `UTF-8` / `Shift_JIS` (click toggles the tab's save encoding and marks it dirty). Clicking Predict, Autosave, IME or Action REWRITES `config.json` immediately (`savePersistentConfig`).

Related-notes pills ("Serendipity Recall"): appear only after a workspace folder was opened (Ctrl+Shift+O; restored from browser storage `md_memo_workspace_folder`). `ScanFolderFiles` indexes `.md`, `.markdown`, `.txt` to depth 3, at most 300 entries / 1500 files / 2.5 s, skipping dot-folders, `node_modules`, `vendor`, `appdata`, `$recycle.bin`, `windows`. 1.2 s after edits the app takes keywords from the current line and the previous 250 characters (up to 8 words of >= 2 characters, minus a stop list) and scores other notes (title x3, first-line snippet x1.5, relative path x1); the top 2 become pills; a click opens that note in a new tab.

### 4.8 Ghost Diff, split view, other

Ghost Diff = the amber glow described in 3.1 step 5. Split view (Ctrl+\) shows two editors (or editor + live preview, Ctrl+Alt+V) with synchronised scrolling. Scrap search (Ctrl+Shift+F): 150 ms debounce, case-insensitive plain-substring search over all `.md` files under the scraps folder (dot-folders skipped), newest file name first, up to 100 matches; Enter/click jumps to the line. The toolbar (`header-actions`) and right-click menu items can be hidden/reordered through `general.toolbarLayout` / `contextMenuLayout`.

### 4.9 Mobile Drop dialog

Ctrl+Shift+U, the phone icon, or the palette. `StartMobileDropWithVoice(visionConfigJSON, voiceConfigJSON)` starts the one-shot server (section 6.2) and returns `{url, qrDataUri?, qrError?, idleTimeoutSeconds}`. The dialog shows the QR code and URL, a countdown, the text currently shared to the phone (selection, else clipboard once), and a "switch to external network" button that starts the Cloudflare tunnel. Closing/cancelling the dialog stops the server. On receipt the content is appended to the active note (`__onMobileDropReceived`).

---

## 5. Files and folders on disk

All under `<cfg>` unless stated. Never read `session.json`, `config.json` or `.env` files to "look around": they hold private notes and API keys.

| Path | Format | Purpose / rules |
|---|---|---|
| `<cfg>/config.json` | JSON, mode 0600 | Whole app configuration; schema in `setup-guide.md`. Written by the app (`SaveConfig`) on Settings Save, on status-bar toggles, and after Ollama setup. Frontend reads it ONCE at startup (after a browser-storage copy); Go reads parts of it directly. |
| `<cfg>/agents.yaml` (`.yml`, `.md`, `.json`) | YAML/JSON/Markdown with an embedded fenced block | Slot agents/notations/recipes. Search order and schema in `setup-guide.md`. Picked up on the next slot run (mtime/size cache). |
| `<scrapDir>/.md-memo/agents.yaml` (or `.yml`, `.md`, `.json`) | same | Per-project agents file; searched BEFORE `<cfg>`. |
| `<cfg>/session.json` | JSON, 0600 | Open tabs and unsaved buffers (restore session). Private. |
| `<cfg>/ipc-session.json` | JSON, 0600 | `{pid, port, token, started_at}` of the running instance (section 2). |
| `<cfg>/instance.lock` | flock file (macOS/Linux only) | Single-instance lock. Windows uses the named mutex `Local\MDMemo_SingleInstance_Mutex_v1` instead. |
| `<cfg>/voice_cache/` | `<stamp>_<id>.webm`, 0600 | Failed voice recordings awaiting retry/keep/discard. |
| `<cfg>/assets/` | images | Generated diagram images (`diagram_<ns>.png`, `.jpg` or `.webp`) when the note has no absolute path; pasted/imported assets when the note has no folder and no workspace is open. Links are then absolute (`file://` for pasted assets). |
| `<note folder>/assets/` | files | `SaveAsset`: `YYYY-MM-DD-HHmmss.<ext>` (extensions png jpg jpeg gif webp webm ogg m4a mp3 wav pdf txt md; <= 25 MB); `ImportAssetFile`: sanitised original name; `KeepVoiceCache`: `voice_note.webm`; generated diagrams: `diagram_<ns>.<ext>`. Name clashes get `-2`, `-3`. Base = the note's folder, else the open workspace folder, else `<cfg>`. |
| `<scrapDir>/YYYY-MM-DD.md` | Markdown | Daily scrap, local date. Entry format appended by a pipe: a line `---`, then `## [HH:MM:SS] <command or "CLI Pipe">`, then a fenced code block tagged `text` holding the (right-trimmed) content; a blank line separates entries. Default `<scrapDir>` = `~/Documents/md-memo/scraps` (`~` = user home). Created on first pipe. |
| `<scrapDir>/.git` | git repo | Enables Git sync. `git add .` adds EVERYTHING in the scraps folder, including `.md-memo/agents.yaml` and any `.env` there. |
| project-root `.env` | dotenv | Environment for slot agents only (never for MD-Memo itself). See `setup-guide.md`. |
| `<UserCacheDir>/md-memo/webview/` (Windows `%LOCALAPPDATA%\md-memo\webview`) | WebView2 profile | Browser storage: cached config copy, session copy, CLI history, voice-cache map, workspace folder, font size. Browser storage is per ORIGIN, and the origin includes the port (41739 or a random one). |
| `jev.json` / `.jev.json` | (planned) | Not read by any released code path. See 1.4 and `setup-guide.md`. |

### 5.1 Git sync (`pkg/gitsync`)

Active only when `scraps.gitSyncEnabled` (default true) and `<scrapDir>` is a git work tree (`.git` exists or `git rev-parse --is-inside-work-tree`). On startup, and again whenever scrap/git settings change on Settings Save or after Link/Init: `git pull --rebase origin <branch>` (120 s limit; "couldn't find remote ref"/"no tracking information" are treated as an empty remote). After any save (`SaveFile`, `SaveFileAs`) or scrap append the debounce timer restarts (default 30 s; UI range 5-3600): then `git add .`, `git status --porcelain`, `git commit -m "chore(scrap): sync YYYY-MM-DD HH:mm"`, `git push origin <branch>` (local steps 30 s, network steps 120 s). `GIT_TERMINAL_PROMPT=0` is set, so credentials must already work non-interactively (credential helper or SSH key). No remote is required for local commits, but the push then fails and the status turns to error. `SetupRemote` (Settings -> Sync -> Link/Init) runs `git init` if needed, sets local `user.name=MD-Memo` / `user.email=md-memo@local` when unset, `git branch -M <branch>`, creates `README.md` and an initial commit if none exist, sets/updates `origin`, and `push -u`, with an automatic `pull --rebase --allow-unrelated-histories` retry when the remote already has commits.

---

## 6. Network surfaces

| Surface | Bind / target | Auth | Lifetime |
|---|---|---|---|
| Embedded UI server | `127.0.0.1:41739` (random port if taken) | none; serves the embedded frontend and `/api/image?path=<abs path>` (GET/HEAD; Host header must be `127.0.0.1:<port>` or `localhost:<port>`; image extensions only; content sniffed as `image/*` except SVG) | while the app runs |
| IPC JSON-RPC | `127.0.0.1:49152` (random if taken) | optional token (section 2) | while the app runs |
| Mobile Drop server | `0.0.0.0:8765` (random if taken), LAN-visible | one-time 128-bit token in the URL query, constant-time compared before any body is read | only while the dialog is open (6.2) |
| Cloudflare Quick Tunnel | `cloudflared tunnel --url http://127.0.0.1:<mobile-drop-port>` | same token, embedded in the public URL | 6.3 |
| Outbound LLM calls | text, ghost text, vision, voice, image generation, AI CLI generation | API key from `config.json` (Gemini keys travel in the URL query for `generateContent`, in `x-goog-api-key` for the Interactions API; OpenAI-style in `Authorization: Bearer`) | per request (120 s general, 30 s ghost text) |
| Quick Actions engine | OpenRouter fixed endpoint `https://openrouter.ai/api/v1/chat/completions` when `action.apiKey` is set (the same key is also stored as the TypeSafe key); then `<action.baseUrl>/predict` when that URL is not an openrouter host; TypeSafe `https://api.typesafe.ai/v1/systemone` only for CLI `jev dispatch` with a key and endpoint | `action.apiKey` (GUI); env keys per `setup-guide.md` section (d) | only when configured; sends about 2,000 characters of context |
| Update check | `GET https://api.github.com/repos/youshinh/md-memo/releases/latest` from the page, 2.5 s after start; no note content; no setting disables it | none | once per start |
| Git | the configured remote | the user's git credentials | per sync |
| Ollama | `http://127.0.0.1:11434` | none | see 3.2 |

### 6.1 Loopback servers are unauthenticated for local programs

Any local process can call IPC (unless it sends a wrong token), fetch `/api/image` for any image path, and read `ipc-session.json` if it runs as the same user.

### 6.2 Mobile Drop server (`pkg/dropzone`)

- Start: picks a LAN IPv4 (RFC 1918) from the interface that carries the default route (virtual adapters such as WSL/Docker/Hyper-V/VPN are skipped in the fallback scan), listens on all interfaces, URL `http://<ip>:<port>/?token=<32 hex>`. QR PNG is rendered by `pkg/qrgen`.
- Routes (all require `?token=`; wrong/missing -> 403 before the body is read): `GET /` (phone page), `POST /upload` (one file, legacy), `POST /upload-text`, `POST /upload-batch` (multipart `file` parts, optional `text`; up to 10 files), `GET /shared` (PC-to-phone text card `{text, rev}`, does not extend the session), `POST /ping` (heartbeat that extends the session; `(in flux)` `?grace=N` seconds, capped at 180, asks the PC to hold the session open at least that long before the phone hands control to the camera/recorder).
- Limits: single upload 20 MB; batch request 60 MB; per item image <= 20 MB, audio <= 25 MB, other files <= 2 MB and must not contain NUL bytes; typed text <= 2 MB; shared text <= 64 KB. File kind is decided by the bytes (content sniffing), not the declared type; HEIC/HEIF accepted as images.
- One submission only: the first valid one is claimed (`409 already used` for later ones) and then the server shuts down. Idle timeout 60 s, re-armed by any authenticated request except `/shared`. Cancelling the dialog stops it at once.
- Location: the phone page requests geolocation only when `location.protocol === 'https:'` (i.e. through the tunnel) and sends `X-Geo-Lat`/`X-Geo-Lon`; only finite in-range values are kept.
- Security headers: `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, CSP `default-src 'none'`.

### 6.3 Cloudflare Quick Tunnel

Started only when the user presses the button in the Mobile Drop dialog (`RequestMobileDropTunnelAsync`); never automatically, and cloudflared is never downloaded or installed by MD-Memo. Discovery order: `cloudflared` on PATH; Windows `%ProgramFiles(x86)%\cloudflared\cloudflared.exe`, `%ProgramFiles%\cloudflared\cloudflared.exe`, `%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe`; macOS `/opt/homebrew/bin/cloudflared`, `/usr/local/bin/cloudflared`; (no fallback list elsewhere). The app waits up to 15 s for a `https://<name>.trycloudflare.com` URL on cloudflared's stderr; the pairing URL becomes `<tunnel>/?token=<token>` and the idle timeout switches to 90 s (re-armed by activity). Missing binary: dialog error code `cloudflared_missing` with the install command (`winget install --id Cloudflare.cloudflared -e` / `brew install cloudflared` / the download page). A failed attempt may be retried; a successful one cannot be repeated for the same session. While the tunnel is up, transferred data passes through Cloudflare.

---

## 7. Command-safety guard (`pkg/jev/guard*.go`)

One judgement function, `jev.VerifyCommand(cmd, mode, rules)`, is used by `md-memo jev verify`, the command-bar run gate (`reviewed`), AI CLI validation (`reviewed`), and Quick Actions execution (`strict`, via `ASTCommandVerifier`). It is a static check of BASH text (`mvdan.cc/sh` parser), not a sandbox: it cannot see inside scripts or binaries and reports run-time-built strings as `opaque`.

Modes: `strict` = one-click paths where nobody reviews (Quick Actions, CLI default); `reviewed` = a person sees the command first; `unattended` = no person (hooks).

| Finding (tier) | strict | reviewed | unattended |
|---|---|---|---|
| Disk-level destruction: `dd`, `mkfs*`, `fdisk`, `wipefs`, `format`, `parted`, `mkswap`, `sfdisk`, `diskpart`; a `block_commands` user rule | block | block | block |
| `rm`, `find -delete`, redirect into a system directory (`/`, `/etc`, `/bin`, `/sbin`, `/usr`, `/boot`, `/dev` except `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/proc`, `/sys`, `/var/run`, `/lib`, `/lib64`, `C:\Windows`, `C:\Program Files`) | block | warn (ask first) | block |
| Unquoted variable expansion (`unquoted-var`) | block | not applied | block |
| A network fetcher (`curl`, `wget`, `iwr`, `irm`, `nc`, ...) piped into a shell or script interpreter (`pipe-to-shell`); a string that cannot be analysed (`opaque`); a `warn_commands` user rule | warn | warn | block |
| `sudo`, `su`, `doas`, `pkexec` (`privilege`), `eval` | safe | safe | block |
| Always-refuse regex list: `format X:`, `diskpart`, `rm -rf` aimed at `/`, `/*` or `~`, `mkfs`, `dd if=... of=/dev/sdX`, fork bombs, `chmod -R 777 /`, `reg delete` on HKLM/HKCR/HKU, `%0` piped to `%0` | block | block | block |
| Reviewed-only warnings: `shutdown`, `Stop-Computer`, `Restart-Computer`; recursive delete (`Remove-Item`, `rm`, `del`, `rmdir`, `rd` with `-r`, `-Recurse` or `/s`); `del` or `erase` with `/f`, `/q` or `/s`; `drop database`, `truncate table`; `ssh`, `telnet`, `ftp`; `nano`, `vi`, `vim`, `pico`; `git commit` without `-m` | n/a | warn | n/a |
| Parse failure (not valid bash, e.g. PowerShell syntax) | block (`parse`, `parseFailed: true`) | falls back to the regex lists | block |

Wrapper-aware: `sudo env timeout xargs nohup nice command exec time watch busybox ...` are looked through; `sh|bash|zsh|dash|ksh|fish|ash|su|runuser -c '<literal>'` and `eval '<literal>'` are analysed recursively (depth <= 3); `find -exec|-execdir|-ok|-okdir` bodies and `$(...)` inside double quotes are analysed. `rule` values in the JSON verdict: `empty`, `fork-bomb`, `parse`, `destructive`, `wrapper`, `protected-redirect`, `unquoted-var`, `pipe-to-shell`, `opaque`, `eval`, `privilege`, `user-rule`, or a pattern id (`format-drive`, `diskpart`, `rm-rf-root`, `mkfs`, `dd-device`, `batch-fork-bomb`, `chmod-root`, `reg-delete`, `power-state`, `recursive-delete`, `batch-delete`, `db-drop`, `interactive-remote`, `interactive-editor`, `interactive-git-commit`). Verdict reason strings are Japanese followed by English in parentheses.

Exit codes of `jev verify`: `0` safe, `1` blocked, `2` warn. Passing the guard does not mean a command is harmless: it covers known dangerous patterns only.

---

## 8. Internal Go-to-JS bridge (not a public interface)

`window.backend.*` (defined in `window_windows.go` / `window_darwin.go`) wraps Go methods bound as `window.backend_<name>`; results arrive through globals such as `window.__onLLMResult`, `__onAutocompleteResult`, `__onSlotAgentResult`, `__onVoiceResult`, `__onMobileDrop*`, `__onCliFilterResult`, `onGitSyncStatus`, `onScrapAppended`. `window.__mdMemoRPC` (section 2) is the only bridge object meant for tooling. Other page globals reachable through `ui eval`: `SlotAgent`, `JevAction`, `TaskManager`, `VoiceInput`, `FileAnchor`, `ChromeLayout`, `HtmlToMd`, `MdMemoBridge` (its `getConfig()` returns the live config including API keys), `__testHelper`. Do not use them for normal work.

---

## Source of truth

- `main.go` (dispatch, pipe, single instance, UI server, `/api/image`), `app.go`, `app_cli.go`, `cli_ai.go`, `app_rpc.go`, `app_config.go`, `app_scrap.go`, `app_files.go`, `app_inputs.go`, `app_slot.go`, `app_jev.go`, `app_llm.go`, `app_mobiledrop.go`, `ollama_ops*.go`, `window_windows.go`, `window_darwin.go`, `hotkey_darwin.go`, `console_windows.go`
- `pkg/cli/{client,headless,format}.go`, `pkg/ipc/{ipc,rpc_types}.go`, `pkg/appdir`, `pkg/scrap`, `pkg/search`, `pkg/gitsync`, `pkg/slotagent/*`, `pkg/jev/*` (`guard*.go`, `verifier.go`, `runner.go`, `agent_bridge.go`, `jev_client.go`, `types.go`), `pkg/llm/{llm,audio,ollama}.go`, `pkg/dropzone/{server,dropzone,tunnel,html}.go`, `pkg/hotkey`, `pkg/singleinstance`, `pkg/shellenv`, `pkg/encoding`
- `frontend/index.html`, `frontend/js/{app,slot_agent,jev_action,task_manager,voice_input,file_anchor,chrome_layout,i18n,html_to_md}.js`
- Existing docs are orientation only and contain errors: `manual.html`, `manual_ja.html`, `README.md`, `docs/design/*.md` (the design documents describe unimplemented work).
