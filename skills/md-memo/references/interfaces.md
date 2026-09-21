# MD-Memo interface reference (for agents)

Basis: app version 1.6.0 (`AppVersion` in `app.go`), read from the source on 2026-09-21 (commit a85494c or later). Everything below was checked in source; statements that could not be checked are marked `(unverified)`.

Conventions: `<cfg>` = the per-user data folder `<ConfigDir>/md-memo/` (Windows `%AppData%\md-memo\`, macOS `~/Library/Application Support/md-memo/`; Linux would be `$XDG_CONFIG_HOME` or `~/.config` but Linux has no window layer and is not a supported platform). `md-memo` = the binary (Homebrew symlink `md-memo`; the winget alias `md-memo` exists only once the package is published; in a dev tree `md-memo.exe` / `MD-Memo.app/Contents/MacOS/MD-Memo`).

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
| Move settings, agents files and project skills to another PC | the user's Settings -> Export... / Import... dialogs (`.mdmemopack`, section 5.2); an agent may only read the package's manifest | yes (the user drives it) |
| Run a one-line task (built-in LLM, shell command or agent) from a note | the Auto selector: the user presses Ctrl+Enter on a task line (sections 3.1.1 and 4.1). It can send text to an LLM, run a command or start an agent CLI, so do not press it for the user without saying so | yes (the user drives it) |

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

### 3.1 Slots (delegate work to an external agent CLI), recipes and the Auto selector's task notations

Source: `pkg/slotagent/parser.go`, `config.go`, `mention.go`, `loader.go`, `runner.go`, `pipeline.go`, `skill.go`, `app_slot.go`, `frontend/js/slot_agent.js`, `auto_selector.js`, `slot_snippets.js`.

Two families of notation share this section. The classic notations below REPLACE the slot with the agent's output. The task notations of 3.1.1 (`[[ @llm ... ]]`, `[[ $ ... ]]`, `{{ @agent ... }}`) keep their instruction line and put the result BELOW it. What Ctrl+Enter does with a given line is decided by the Auto selector (section 4.1).

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
- `@name` (`@name: instruction` or `@name instruction`) is resolved AGENT FIRST (`slotagent.ResolveAgentName`): an exact `agents` key, else an `agents` key compared case-insensitively, else an alias from `aliases` (case-insensitive; a tie is broken by the alphabetically smallest key). On a hit `SlotMatch.AgentName` holds the `agents` key, `SkillName` stays empty and `OutputMode` is `below` (the result goes under the line, see 3.1.1); the profile's system instruction is not applied. Any other `@name` names a skill (`SkillName`, `OutputMode` `replace`). This holds for every non-recipe delimiter pair, not only `{{ }}`; a recipe never takes the mention form.
- Otherwise `role: instruction` when the text before the first `:` has no whitespace and is <= 20 characters; otherwise the profile name. The role is only a label (and the skill selector); it does not change the agent.
- Which slot the Go side picks (`ParseSlotsRPC` / `RunSlotAgentAsync`): the slot containing the caret, else the NEAREST slot AFTER the caret, else the FIRST slot in the note; "no slot found" only when the note has no slot at all. Ctrl+Enter reaches this rule only when the Auto selector hands over to it: the setting is off, the line is blank, the caret is in a code fence, the caret is inside (or touching) a classic slot, or the line already holds a classic slot notation (section 4.1).
- Positions across the Go/JS bridge (`ParseSlotsRPC(fullText, cursorUTF16, configJSON)`, `RunSlotAgentAsync(reqID, filePath, fullText, cursorUTF16, configJSON)` and the offsets in `SlotParseMatch` / `SlotExecutionResult`) are UTF-16 code-unit indices into the text the page sent, i.e. what a textarea reports. Go converts to bytes internally, so Japanese text or emoji before a slot shift nothing. (A build from before the Auto selector change handed the UTF-16 caret to the byte-based parser and returned UTF-8 byte offsets, so a slot behind Japanese text was located at a wrong position.)
- `SlotParseMatch` (JSON): `type`, `openDelimiter`, `closeDelim`, `startOffset`, `endOffset`, `rawContent`, `role`, `skillName?`, `agentName?`, `outputMode` (`replace` or `below`), `instruction`, `isInline`, `isTarget`. `SlotExecutionResult` also carries `output` (the agent's stdout, untrimmed) and `outputMode`; in `below` mode Go replaces nothing (`newContent` equals `oldContent`) and the page writes `output` under the task line.
- Full-width `｛｛`, `［？`, `【？` typed by an IME are converted to `{{`, `[?`, `【?`. Typing an open delimiter (`{{`, `[?`, `【?`, `[!`, `[>>`) opens the quick selector (Up/Down, Tab/Enter, 1-9, Esc): the slot profiles and recipes first, then the snippets of 3.1.2 (kind tags LLM / AGENT / CMD / TEXT). The number keys 1-9 address the first nine rows, so the profiles keep the keys they always had. Confirming a profile inserts `{{ code: ` ... ` }}`. The popup's header and key hint follow the UI language (EN "Hand over to an agent"). Typing `[[` opens nothing (wiki links are not disturbed).
- Trigger: Ctrl+Enter (Cmd+Enter on macOS) with the caret in the editor (what it does with a given line is decided in section 4.1), or the small Run button that appears beside a complete, not-running slot or task (a task's button sits at the end of its own line). Concurrency guard: a classic slot whose text already holds the running placeholder is refused with the toast "This slot is already running." (ja 「このスロットはすでに実行中です」); a task is refused while the run marker under it (3.1.1) belongs to a live run; a second Ctrl+Enter that arrives while the first is still being handled is ignored (that guard lapses after 10 s).

What happens on run (classic slots; the output REPLACES the slot. A `{{ @agent }}` task starts its agent the same way, steps 2 and 3 included, but skips the placeholder and the merge: see 3.1.1):
1. The slot text is replaced by `<open> ⟳ 実行中... <close>` (undoable), a task card is created (task panel, section 4).
2. The note file is prepared for the agent: an unsaved note is written to a temp file `md-memo-slot-*.md`; a note with a path is OVERWRITTEN on disk with the current in-memory text (UTF-8, whatever the tab's encoding, and even if autosave is off).
3. The agent is started without a shell: `exec(command, args...)`. `{file}` = note path, `{instruction}` = `"<system_instruction>\n\nTask: <instruction>"` (or just the instruction). If no arg contains `{instruction}` it is appended as the last argument. If no arg contains `{file}` and the instruction mentions `このメモ` / `このノート` / `カレントメモ`, a Japanese line with the file path is prepended. Working directory = the project root (nearest ancestor of the note containing `.md-memo`, `agents.yaml|yml|json`, `AGENTS.md`, `skills`, or `.git`; else the note's folder; for an unsaved note the temp file's location). `<projectRoot>/.env` (only that file) is merged into the environment for this process only.
4. stdout (trimmed, capped at 10 MB) replaces the slot. Inline slots (text before/after on the same line) have newlines flattened to spaces. Nonzero exit or stderr: the slot becomes `<open> [U+26A0] エラー: <first 1000 chars of stderr or Exit Code N> (再試行: Ctrl+Enter) <close>`; timeout is exit 124 with `[U+26A0] エラー: タイムアウト (再試行: Ctrl+Enter)`; cancel is 130. (`[U+26A0]` stands for the single warning-sign character U+26A0 that the app really writes, followed by one space; it is spelled out here only to keep these files free of pictographs. To detect a failed slot, match the text `エラー:` inside the slot.)
5. Merging waits until the user has been idle for 500 ms, then applies the result, keeps the caret and scroll, and flashes the editor for `ghost_diff_duration_ms` (Ghost Diff). Esc during the flash (and 1 s after) restores the original slot text; Ctrl+Z does too.
6. `@skill` slots: `skills/<name>/SKILL.md`, `skills/<name>.md`, `skills/<name>/README.md`, `.gemini/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md` under the project root; YAML frontmatter is stripped and the body is appended to the system instruction (and used as the instruction if the slot has none). Missing skill: the slot becomes `<open> [U+26A0] スキル '<name>' が見つかりません (skills/<name>/SKILL.md) <close>`. (This very folder, `skills/md-memo/SKILL.md`, is therefore usable as `{{ @md-memo: ... }}` in a note inside this repository.)
7. Recipes: steps run in order through the default agent with no system instruction. With `self_refine`, step 1 becomes draft -> critique -> revise (max 2 passes). If `requires_approval_step` = N, after step N the slot is replaced by the step output plus a gate line `- [ ] 次のステップ（<next step, first 30 chars>...）を実行する // approve`. The user changes `[ ]` to `[x]` and presses Ctrl+Enter to resume. Resume always uses the first configured recipe when the caret is not inside a recipe slot. With the Auto selector on (4.1) the gate line is recognised as an existing notation (`AutoSelector.classify` returns the reason `existing-notation` for `- [x] ... // approve`), so Ctrl+Enter pressed on it resumes the recipe as before: no rewrite and no ask bar.

#### 3.1.1 Task notations and result blocks (Auto selector)

Three notations keep the instruction line and write the result BELOW it. Recognition, rewriting and result markers live in the page (`frontend/js/auto_selector.js`, `slot_agent.js`); the Go side knows only the `{{ @agent }}` form (3.1).

| Notation | Runs on | Result |
|---|---|---|
| `[[ @llm instruction ]]` | the built-in text LLM (Settings -> AI Models, `text.*`; it may be a cloud service) | a result block under the line |
| `[[ $ command ]]` | a shell command, run like the command bar's manual mode but with EMPTY stdin (guard, shells and 30 s limit: 4.3, 7) | a result block under the line, holding a fenced code block |
| `{{ @agent instruction }}` | an agents-file agent: key or alias, case-insensitive (3.1.2), through the slot runner | a result block under the line |

A hand-written classic `{{ ... }}` (profiles, `{{ @skill ... }}`) is none of these: it still REPLACES the slot with the result.

Recognition (`AutoSelector.findTaskAt`):
- `[[ ... ]]` counts only when its content starts with `@llm` (any case) or `$`, followed by whitespace or the end. `[[Wiki Link]]` and every other `[[ ]]` are left alone; a wiki link nested inside an instruction is balanced.
- `{{ @name ... }}` counts only when `name` resolves to an agent (key or alias, case-insensitive; the name `llm` never does). `{{ @claude: text }}` with a colon is accepted. Any other `@name` is a skill and stays classic.
- One task per line: the notation must close on the same line. The line may start with an indent, a `>` quote prefix and/or a list marker (`- `, `* `, `+ `, `1. `, `1) `, a checkbox `- [ ] `, `・`); a rewrite keeps that prefix. Not recognised inside code fences or inline code.
- The caret is "in" a task from its first bracket to just after its last one. When the task is all that is on its line (after the prefix) the caret may be anywhere on that line. Ctrl+Enter runs exactly ONE task: the one under the caret; with a selection the one under its start, else the first one inside it.
- An empty instruction: `[[ @llm ]]` and `[[ $ ]]` give the toast "This task has no instruction: write it inside the brackets." An agent whose `args` contain `{instruction}` is refused with the block text `指示が空です。{{ @<key> 指示 }} の形で書いてください`; an agent that does not use `{instruction}` (the shipped `codex` entry, for one) runs with an empty instruction.

Result block (the id is an example):

```text
[[ @llm translate to English ]]
<!-- md-memo:res a1b2 -->
Result text
<!-- /md-memo:res -->
```

- While the run is in progress one line `<!-- md-memo:run a1b2 -->` sits directly under the task line; when the run ends it is replaced by the block. The id is four lowercase letters or digits that no other marker in the note uses (five or six only if four keep clashing). A run never changes the task line itself.
- The markers are plain HTML comment text. The editor shows them; the preview hides them (`AutoSelector.stripMarkers` removes the `md-memo:run`, `md-memo:res` and `/md-memo:res` lines before markdown-it renders, after fenced code has been set aside; markdown-it itself runs with `html: false`, which would otherwise print them as literal text).
- The result is trimmed and no blank line is added inside. An LLM answer gets the usual clean-up first (`<think>` removed, one whole-answer ```` ```markdown ```` wrapper removed, section 3.6). A `<!-- md-memo:` inside a result is written as `&lt;!-- md-memo:` so it cannot end the block.
- A command result is a fenced code block whose fence is longer than any backtick run in the output (three at least). A failed command puts stdout, stderr and a last line `exit code N` into the same block.
- A failure is one line inside the block: `[LLM error: <message>]` (ja UI `[LLMエラー: <message>]`, message cut to 300 characters) or `[<agents key> error: <message>]` (ja `[<key> エラー: <message>]`). The agent message is the runner's own, the same text a classic slot shows (3.1 step 4, `エージェント起動失敗: ...`, stderr, `Exit Code N`, timeout).
- `ctx=above n=N`: when the instruction was typed into the ask bar that Ctrl+Enter opened (4.1), both markers carry it (`<!-- md-memo:res a1b2 ctx=above n=1 -->`; N = the number of lines of the text the instruction is about). A re-run then sends that text again: the N nearest non-blank lines directly above the task line, looking through other task lines, result blocks and markers in between (at most 80 lines and 8000 characters). Hand-written tasks, snippet-made tasks and automatically rewritten lines carry no `ctx`: only the words inside the brackets are sent, never the surrounding text. With a text the LLM receives `【指示】:`, the instruction, `【対象テキスト】:` and the text (Japanese labels in every UI language, as in the ask bar); without one, the instruction alone.
- Re-run: Ctrl+Enter on the task line again REPLACES the block under it (or a left-over marker), so results never pile up. While the run is live the toast is "This slot is already running.".
- Cancel: task panel (Alt+T) -> Cancel removes the marker line and the note is as before. An LLM request cannot be aborted on the Go side, so it is only forgotten and a late answer is dropped; a command is stopped; an agent's process tree is killed. Cancelling a re-run does not bring back the block it replaced; cancelling right after an automatic rewrite leaves the rewritten line (Ctrl+Z undoes that). If the note is closed the answer is dropped; if the marker was deleted while running, the answer is appended at the end of the note.
- A left-over marker or block can be deleted by hand (the comment lines and what lies between them); nothing else refers to them. The Go parser skips complete result blocks (`FindExcludedRanges`), so a `{{ }}` inside a result is never run; an opener with no closing line hides nothing.
- Ctrl+Enter with the caret inside a result block gives the toast "This is a result block. Write your instruction outside of it." and nothing else.

How each kind runs:
- `[[ @llm ]]`: `queryLLMAsync` with `config.text`. It needs a configured LLM (the precondition in 4.3); otherwise the toast "LLM is not configured (Settings -> AI Models)" and the note is not touched (no rewrite, no marker). Task panel: type `llm`, label "LLM". Toast when done: "LLM response inserted".
- `[[ $ ]]`: desktop app only (a browser build says "Commands can only run in the desktop app"). Before anything is written the command goes through the command bar's guard (`ValidateCliCommand`, `reviewed` mode, section 7): blocked -> the toast "Security Block: <reason>" (ja 「セキュリティ制限: <reason>」); a warning -> a confirm dialog, and declining gives "CLI command cancelled"; in both cases the note is untouched. It runs with empty stdin in the app's working directory, 30 s limit (the page gives up after 40 s with "No answer from the command (timed out)"). Task panel: type `command`, label "Command". Toast when done: "Command output inserted", or "CLI error: <message>".
- `{{ @agent }}`: the same `RunSlotAgentAsync` path as a classic slot. The note file on disk is overwritten with the editor text, which already holds the run marker, before the agent starts; the agent gets `{file}` and the instruction as written (no profile system instruction); `.env` and `timeout_seconds` apply as in 3.1; a named agent is never swapped for another, so a broken one reports its error in the block. Task panel: type `slot`, label = the agents key; Hover Peek works as before.

#### 3.1.2 Aliases and snippets (agents file)

Both belong in the agents file (search order and schema in `setup-guide.md` (c)), not in `config.json`: the Settings dialog never writes them there, and a UI save drops unknown top-level keys. The page reads them once at start, like the notations, so restart MD-Memo after editing them; the Go side re-reads the file at the next run.

- `agents.<name>.aliases`: a list of extra names accepted after `@`, compared case-insensitively; an `agents` key beats an alias (rule in 3.1). When omitted, the built-in agents keep their default aliases: `claude-code` -> `claude`, `cc`; `agy` -> `antigravity`, `gemini`; `hermes` and `codex` have none. A default alias that is already another agent's key or explicit alias is skipped, and an explicit list (even `aliases: []`) replaces the defaults. `CheckAgentAvailability` (the "agent not found" warning, the Settings availability badge) resolves aliases too.
- `snippets:` (top level): a list of ready-made tasks, item fields:

| Field | Meaning |
|---|---|
| `id` | name of the snippet; default `user-<n>`. The same `id` as a built-in replaces that built-in in place (both rows of an OS-split built-in); a new `id` is appended after the built-ins; for two items with the same `id` and `os` the later one wins |
| `label` | the text in the list (default: the `id`) |
| `kind` | `llm`, `agent`, `command` or `text`; an item with another kind or an empty `body` is dropped |
| `trigger` | optional short word for trigger + Tab: one word without spaces, 2 to 30 characters, compared exactly after folding case and full-width letters (`normalizeTrigger`). Built-ins start with `;`; the shipped template's example uses `/weekly` |
| `body` | the text, with the placeholders below |
| `os` | `win`, `unix` or `any` (default). `windows` / `powershell` and `linux` / `mac` / `macos` / `darwin` / `sh` are accepted as synonyms, anything else counts as `any`. Only items for the running OS are listed |
| `agent` | for kind `agent`: the agent key or alias to name; when omitted or unknown, `default_agent` is tried, then the first configured agent |

Placeholders in `body`: `${selection}`, `${line}`, `${date}`, `${agent}`, `$0`; `$$0` and `$${` write a literal `$0` and `${`.
- `${selection}`: the selected text. It is filled only when the snippet is inserted from the palette with text selected (that selection is replaced); otherwise it is empty. `${line}`: the current line without the text the insertion replaces. `${date}`: today, `YYYY-MM-DD` (local time). `${agent}`: the agent key, chosen as for the `agent` field. `$0`: where the caret lands (the first `$0`, else the end).
- Wrapping by kind: `llm` -> `[[ @llm <body> ]]`, `command` -> `[[ $ <body> ]]`, `agent` -> `{{ @<agent key> <body> }}`, `text` -> inserted as written. Inserting a snippet never runs it: the user presses Ctrl+Enter on the new line.
- Safety: in the wrapped kinds the newlines of the body become spaces and each substituted value is made one line, cut at 2000 characters (300 in a command), with any `[[`, `]]`, `{{`, `}}` spaced apart so the notation cannot break. In a `command` snippet a substituted value also loses control characters, quotes, backtick, `$`, `%`, `;`, `&`, `|`, `<`, `>`, `^`, `!` and (unless `os: win`) backslash. No built-in snippet deletes, overwrites or installs anything.

Two fragments, taken from the template that "Open agents.yaml" writes (the template ships both commented out, and documents `@name`, `aliases` and `snippets` in its header). The first line goes inside an agent's entry under `agents:`, the rest at the top level of the file:

```yaml
    aliases: ["claude", "cc"]

snippets:
  - id: "weekly"
    label: "今週の振り返り"
    kind: "llm"
    trigger: "/weekly"
    body: "この内容を今週の振り返りとして3点に要約して: ${selection}"
```

Three ways in:
1. Type `{{` (or another slot open delimiter): the quick selector lists the profiles and recipes, then the snippets. Enter, Tab or 1-9 inserts, replacing the typed delimiter.
2. Command palette -> "Insert task snippet" (ja 「タスクのひな形を挿入」): a list of the snippets only (header "Task snippets"), inserted at the caret; with none available the toast is "No snippets available".
3. Trigger + Tab: an exact trigger such as `;sum` at the start of a line or after whitespace, with no selection and outside code; Tab turns it into the snippet. Every other Tab is untouched.

Built-in snippets (labels follow the UI language; only the versions for the running OS are listed: Windows gets PowerShell, macOS sh):

| Kind | id and trigger |
|---|---|
| LLM | `llm-summarize` `;sum`, `llm-translate-en` `;en`, `llm-translate-ja` `;ja`, `llm-proofread` `;proof`, `llm-rephrase` `;rephrase`, `llm-bullets` `;bullets`, `llm-table` `;table`, `llm-ideas` `;ideas` |
| Agent | `agent-research` `;research`, `agent-implement` `;impl`, `agent-test` `;test`, `agent-review` `;review`, `agent-refactor` `;refactor` |
| Command | `cmd-date` `;date`, `cmd-git-status` `;gst`, `cmd-git-diff-stat` `;gdiff`, `cmd-git-log` `;glog`, `cmd-grep-word` `;grep`, `cmd-rg-word` `;rg`, `cmd-count-lines` `;wc`, `cmd-sort-unique` `;uniq`, `cmd-jq` `;jq`, `cmd-large-files` `;big`, `cmd-list-files` `;ls` (the ones for date, grep, count lines, sort unique, large files and list files exist as a Windows and a Unix version) |
| Text | `text-llm-task` `;llm` (`[[ @llm $0 ]]`), `text-agent-task` `;agent` (`{{ @${agent} $0 }}`), `text-command-task` `;cmd` (`[[ $ $0 ]]`) |

The command bar's manual-mode preset list (4.3) offers, after the recent commands, the agents file's own `command` snippets, the fixed filters and then the built-in `command` snippets that match the OS; snippets with a placeholder in the body are left out (`$$0` and `$${` count as plain text); the agents file's own command snippets are re-read each time the bar opens.

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
- Paste (`decidePasteAction` in `app.js`; the split is set by `general.pasteHtmlAsMarkdown`, default true, Settings -> General "Ctrl+V turns web, Word and Excel content into Markdown"). Ctrl+V makes Markdown: clipboard `text/html` that has structure (`HtmlToMd.hasStructure`: a table of more than one cell, heading, list, link, image, quote, rule, bold / italic / strike) is converted by the built-in converter (`html_to_md.js`) and a "Pasted as Markdown" toast appears; HTML without structure, and anything from VS Code (`vscode-editor-data` type on the clipboard), is pasted as plain text. Ctrl+Shift+V (fixed key) pastes as it is: plain text with no conversion, and an image-only clipboard is saved to `assets/YYYY-MM-DD-HHmmss.<png|jpg|gif|webp>` and linked as `![image](./assets/...)` without OCR; text next to an image (Excel, Word) pastes the text. With `pasteHtmlAsMarkdown` false the old split applies: Ctrl+V plain, Ctrl+Shift+V converts (and reads the async clipboard when the event carries no HTML). Ctrl+V with an image-only clipboard (no `text/plain`) runs vision OCR when `general.pasteImageOcr` is true AND the vision model can answer (`isVisionConfigured` in `app.js`, the rules of `QueryVision` in `pkg/llm`: Gemini, also the default with an empty URL, and the hosted OpenAI-style services need `vision.apiKey`; a local server does not). Otherwise it saves the image exactly like Ctrl+Shift+V and the toast says why: "Image saved to assets (automatic image transcription is off)" or "... (transcription needs an API key: Settings -> AI Models)". `decidePasteAction` is the pure decision table (`ocr`, `saveImage`, `htmlToMd`, `readClipboard`, `default`).

### 3.4 Voice-input markers

The `voiceInput` shortcut (default Ctrl+Shift+R, Cmd+Shift+R on macOS; rebindable in Settings -> Shortcuts, older builds hard-coded it) toggles recording. Other entry points: the toolbar microphone button `btn-voice-input` (shows an active state while recording), the context-menu item `ctx-voice-input`, and the command palette. Recording needs the editor view (not the rendered preview). While it records, an indicator (`.voice-indicator`, fixed at the bottom left) shows a red dot, the elapsed seconds, a Stop button (`.voice-stop`) and the hint "ESC to discard". A click on Stop ends the recording and starts the transcription exactly like the shortcut toggling it, and does not take the focus from the note; Esc discards the recording (nothing is sent). Start-up feedback in the status bar: "Preparing the microphone...", after 5 s "Waiting for microphone permission...", and specific failure messages (blocked, no microphone found, microphone busy) instead of one generic error. The marker is written at the caret and replaced in place, so the user can keep typing:

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
A failed item is `[Mobile Drop: <name>の処理に失敗しました: <error>]`. When a photo or voice note cannot be OCR'd / transcribed (nothing configured, or any error) it is kept as a file under `assets/` with a link and a one-line reason instead, and the item counts toward the `fallbackCount` toast; the failure line above appears only if saving the file also fails.

### 3.6 AI answer handling

- Anchors: while a model call runs the app inserts a bracketed placeholder in the note's UI language and replaces it when the call ends: `[AI Generating: <first 20 chars of instruction>...]` / `[AI 生成中: ...]` (Ask AI, Ctrl+L; `Processing` / `処理中` stands in when the instruction is empty), `[AI Correcting...]` / `[AI補正中...]` (Alt+C), `[Transcribing Image (Gemini)...]` / `[画像マークダウン変換中 (Gemini)...]` (OCR), plus diagram anchors. If the app dies mid-call the anchor stays in the note. Errors replace the anchor with `[LLM error: <text>]` / `[LLMエラー: ...]` (Ask AI: one line, message cut to 300 characters, in the answer's place below the target, section 4.3). A 180 s watchdog resolves stuck requests as a timeout error.
- Unwrapping (`stripMarkdownCodeFences`, `app.js`): `<think>...</think>` blocks (and an unclosed `<think>` tail) are removed. Ask AI and other free-form answers: only a single wrapper fenced ```markdown or ```md around the WHOLE answer is removed, and only if it is a true wrapper (inner fences properly nested); a real ```python block, an untagged block, or several blocks with prose between them are left exactly as returned. Vision/OCR results and Alt+C corrections use the broader rule (untagged and ```text wrappers are also removed); corrections also strip intro phrases ("Corrected text:", "修正後のテキスト:") and surrounding quotes, and roll back to the original text on an empty or failed result.

---

## 4. GUI surfaces

### 4.1 Shortcuts

Registry: `config.shortcuts.<action>` = combo string (`Ctrl+Shift+P`, `Cmd+Option+F`, ...; modifiers `Ctrl|Control|Cmd|Command|Shift|Alt|Option`, then one key: a letter/digit, `F1`-`F24`, `ArrowUp` ..., `\`, `,`, punctuation; empty string = unassigned). On macOS a bare `Ctrl` is treated as Cmd unless `Cmd` is also present. Defaults are `DEFAULT_SHORTCUTS_WIN` / `DEFAULT_SHORTCUTS_MAC` in `app.js`. Configurable in Settings -> Shortcuts (click a key button, press the combo, Backspace clears, Esc cancels; a clash asks to steal the combo and clears the other action). Reserved combos are refused by the recorder but are NOT validated when written by hand in `config.json`. The Settings table is grouped as File Operations, Edit & Search, Line Operations, Command Bar, View & Window, AI Assist & Conversion and Application; the keys below are exactly the `shortcuts.<action>` keys of `DEFAULT_SHORTCUTS_WIN` / `DEFAULT_SHORTCUTS_MAC`.

| Action key | Windows default | macOS default |
|---|---|---|
| newTab / openFile / openFolder | Ctrl+N / Ctrl+O / Ctrl+Shift+O | Cmd+N / Cmd+O / Cmd+Shift+O |
| saveFile / saveFileAs / closeTab | Ctrl+S / Ctrl+Shift+S / Ctrl+W | Cmd+S / Cmd+Shift+S / Cmd+W |
| exportPlainText, minimize (Win), convertMermaid, mermaidToImage | unassigned | exportPlainText, convertMermaid, mermaidToImage unassigned; minimize Cmd+M |
| find / replace / gotoLine | Ctrl+F / Ctrl+H / Ctrl+G | Cmd+F / Cmd+Option+F / Cmd+G |
| searchScraps / quickPick | Ctrl+Shift+F / Ctrl+Shift+P | Cmd+Shift+F / Cmd+Shift+P |
| insertDate | F5 | Cmd+Shift+I |
| togglePreview / toggleSplit | Ctrl+P / Ctrl+\ | Cmd+P / Cmd+\ |
| zenMode / toggleFullscreen | Shift+F11 / F11 | Ctrl+Cmd+Z / Ctrl+Cmd+F |
| toggleMaximize (maximize / restore the window; no key by default. A saved config that still holds the old default F11 (Ctrl+Cmd+F on macOS) hands it to toggleFullscreen on load) | (none) | (none) |
| globalSummon (OS-wide) | Ctrl+Alt+M | Cmd+Alt+M (Option+Cmd+M) |
| inlinePrompt (label "Ask AI") / aiCorrection | Ctrl+L / Alt+C | Cmd+L / Cmd+Shift+C |
| quickActions | Ctrl+J | Cmd+J |
| commandBar (label "Command Bar (opens in the mode you used last)") | Ctrl+E | Cmd+E |
| runCliFilter ("Command Bar: CLI mode") / runAiCli ("Command Bar: AI mode") | unassigned | unassigned |
| mobileDrop | Ctrl+Shift+U | Cmd+Shift+U |
| voiceInput | Ctrl+Shift+R | Cmd+Shift+R |
| moveLineUp/Down | Alt+ArrowUp / Alt+ArrowDown | Option+ArrowUp / Option+ArrowDown |
| duplicateLineUp/Down | Shift+Alt+ArrowUp / Shift+Alt+ArrowDown | Shift+Option+ArrowUp / Shift+Option+ArrowDown |
| deleteLine | Ctrl+Shift+K | Cmd+Shift+K |
| insertLineBelow / insertLineAbove | Shift+Enter / Shift+Alt+Enter | Shift+Enter / Shift+Option+Enter |
| openSettings | Ctrl+, | Cmd+, |

Notes on the input keys:
- `Ctrl+K` / `Cmd+K` is assigned to nothing by default and is not reserved: it can be given to any action in Settings -> Shortcuts. `Ctrl+Shift+B` and `Ctrl+Shift+E` are no longer defaults (the two mode keys are empty on a new install), but their rows stay in Settings -> Shortcuts (group "Command Bar") and a config that already saved them keeps them and they keep working (each opens the command bar in its mode).
- Migration on load (`migrateAskShortcuts`, run on every config load path but effective only once): it acts only on a saved `shortcuts` object that still holds the old `llmModal` entry, i.e. a config from before the dialog was merged into the bar. In that case a saved `inlinePrompt` of `Ctrl+K` / `Cmd+K` becomes `Ctrl+L` / `Cmd+L` with one notice ("Ask AI is now {sc}. The separate prompt dialog was merged into it.", `{sc}` = the new key), unless another action already holds that combo (then Ctrl+K stays, no notice); the `llmModal` entry is then dropped (that key no longer exists), so the move never repeats. A Ctrl+K that a user assigns to Ask AI later, or that a new install saves, is kept.
- `commandBar` is checked last in the key-handler chain, so a key that a user already gave to another action wins over the new default. The old `insertLineAbove` default `Ctrl+Shift+Enter` is moved to the current default on load, like `insertLineBelow` (below).

Fixed (not rebindable; handled before the registry): every Ctrl/Cmd+Enter variant inside the editor (Ctrl+Enter, +Shift, +Alt: SlotAgent captures all of them first for the Auto selector below, so the Settings recorder still refuses them; older builds defaulted `insertLineBelow` to Ctrl+Enter, which never fired, and a saved config holding that old default, or the short-lived Alt+Enter, is moved to Shift+Enter on load; likewise a saved Ctrl+Shift+Z Zen binding on Windows/Linux is moved to Shift+F11 with one notice, because Ctrl+Shift+Z is Redo and is reserved in the recorder), Alt+T (Option+T) task panel, Ctrl+Alt+V (Cmd+Option+V) preview to the side, Ctrl+Shift+V paste as it is (Cmd+Shift+V), Ctrl+Right accept-word, Ctrl+Tab next tab (literal Ctrl on macOS), Ctrl+, / Cmd+, settings, Ctrl+1 / Ctrl+2 focus pane, Ctrl+= / Ctrl+- / Ctrl+0 zoom, F3 / Shift+F3 find next/prev, Esc layered close order, Ctrl+1..3 (and Alt+1..3) and Ctrl+Tab + Enter inside the Quick Actions panel, Ctrl+Z / Ctrl+Y and clipboard keys. Ctrl+T is not a shortcut (there is no handler; older builds printed it in the New Tab tooltip and the palette text). `globalSummon` on Windows accepts Ctrl/Alt/Shift/Win + one of `A-Z 0-9 F1-F24 Space Enter Esc`; macOS accepts more (arrows, punctuation, Tab) via `pkg/hotkey`; registration failure reverts the value and shows a toast. The hotkey only brings the window forward; it never hides it.

#### Ctrl+Enter (Cmd+Enter on macOS): the Auto selector

Any Ctrl/Cmd+Enter variant in the editor, and the small Run button, run `ctrlEnterFlow` (`frontend/js/slot_agent.js`). It acts on ONE line or task: the one under the caret, or the selection. The decision is plain synchronous JavaScript over the note text: no RPC, no network and no model take part (`tests/auto_selector_flow_test.mjs` asserts under 5 ms for the synchronous part on a note of about 130,000 characters, measured there at 1 to 2 ms). The first match wins:

1. An Enter that confirms an IME conversion: nothing happens and the key is not taken. A held key does not repeat the run.
2. The caret is inside a result block (3.1.1): the toast "This is a result block. Write your instruction outside of it." and nothing else.
3. A task notation (3.1.1) under the caret (with a selection: under its start, else the first one inside it): that ONE task runs. This works even when `autoSelector.enabled` is false.
4. The caret is inside (or touching) a classic `{{ }}`-style slot: the classic rule of 3.1 (the caret's slot, else the next slot after the caret, else the first one in the note; the toast "No slot found to run (place the cursor inside a {{ }}-style block)." when the note has none).
5. `autoSelector.enabled` is false, or the target (the selection, else the current line) is blank: the same classic rule. If the selection start is inside a code fence the classic path is taken too, but inside a fence or inline code it does nothing (silently).
6. A selection that covers only part of a line, or several lines: the ask bar opens on that selection, never a guess (route below).
7. The whole line (or a selection that covers it) is the target. When the line already holds a classic slot notation elsewhere on it, or is a recipe's approval gate line (`- [x] ... // approve`, the reason `existing-notation`), the classic path runs (a gate line resumes the recipe: no rewrite, no ask bar). Otherwise fixed rules judge the line:
   - A clear request for the built-in LLM (summarise, translate, proofread, rephrase, bullet points, a table, ideas, ...): the line becomes `[[ @llm <line> ]]` and runs AT ONCE. With no LLM configured: the toast "LLM is not configured (Settings -> AI Models)" and the note is not touched.
   - A clear request for an agent (implement, refactor, "please run the tests", commit, PR, build, investigate, fix, an error log, ...): the line becomes `{{ @<agent> <line> }}` and the flow STOPS. The agent is the one the line names (`@claude ...`), else `default_agent`. Toast: "Rewritten as an agent task. Ctrl+Enter runs it, Ctrl+Z undoes." When the agent cannot be found (not in the agents file, or its command is not on PATH) a second toast follows: `Agent "<name>" not found (check agents.yaml and PATH). Rewritten anyway; Ctrl+Z undoes.` A second Ctrl+Enter then runs the task (3.1.1).
   - A shell command (`git status`, `ls -la`, `rg word .`, a pipeline of such commands, a read-only PowerShell cmdlet such as `Get-ChildItem`): the line becomes `[[ $ <line> ]]` and the flow STOPS with the toast "Rewritten as a command. Ctrl+Enter runs it, Ctrl+Z undoes." The command guard runs at the second press.
   - Anything else (an ordinary sentence, a note, an unclear question, a heading, a URL, code, a table row, a line over 240 characters, or a line that looks like a command but writes or destroys, such as `rm ...` or one with a redirect `>`): the ask bar opens on the line. Nothing is rewritten.
   - A line that starts with `@llm `, `@<agent or alias> ` or `$ ` is taken as written.

The rewrite is one undo step (Ctrl+Z restores the line) and keeps an indent, quote or list prefix. In the toasts the key is Cmd on macOS.

The ask bar route (steps 6 and 7): the Ask AI bar (4.3) opens on the target with the chip "Current line" or "Selection: N chars", the placeholder "What should the AI do with this text?" (ja 「このテキストをAIにどうさせますか？」) and the hint "The instruction is saved in the note as [[ @llm ... ]]". Enter writes `[[ @llm <what was typed> ]]` on a NEW line directly below the target and runs it at once with the target text as its subject (`【指示】:` / `【対象テキスト】:`). The target text itself is not changed, and the markers carry `ctx=above n=<lines>` (3.1.1). If the note changed while the bar was open and the target text can no longer be found, the toast "The note changed in the meantime. Press the key again." appears and nothing is written. With no LLM configured the bar does not open (the toast above).

What the fixed rules look at (`AutoSelector.classify`, word tables in `RULES`; nothing is sent anywhere): request phrasing (Japanese endings such as -して, -してください, お願いします; verbs such as 要約して, 翻訳して, 教えて; nouns such as 翻訳, 校正; English imperatives such as translate, summarize, rewrite, explain, or `please ...`; a question mark with a question word), then the subject words. Text-work words point to the built-in LLM. Code and repository words (implement, refactor, commit, PR, build, test, debug, investigate, git, error log, ...) or "run <tests, build, script>" point to an agent. A known command word followed by an argument that looks like one points to a command. If nothing fits, the built-in LLM is the target (a text-only answer, the safe side). Lines that write or destroy (`rm`, `del`, `mv`, `cp`, `sudo`, `kill`, `mkdir`, `tee`, `sed`, a redirect `>` or `<`, `| sh`, the list is `RULES.blockedBinaries`) are never turned into a command automatically. The rules can be wrong: the polite note 「資料は事前に共有してください」 is judged an instruction for the LLM, for example. When unsure, the flow opens the ask bar and never changes the note by itself.

Settings (Settings -> Agent tab, group "Auto selector (Ctrl+Enter)", section 4.6). Both keys live in `config.json` under `autoSelector`, are read only by the page (never by Go), default to true, are filled in when an old config lacks them, and travel in the settings package's "Agent & Quick Actions" section (5.2):
- `autoSelector.enabled`, label "Let Ctrl+Enter decide: ask the AI, hand over to an agent, or run a command" (hint "When off, Ctrl+Enter only runs {{ }} slots, as before."): off turns steps 5 to 7 into the classic rule. Hand-written tasks still run (step 3).
- `autoSelector.agentConfirm`, label "Confirm before an auto-detected agent or command runs" (hint "The line is rewritten first; press Ctrl+Enter again to run it (Ctrl+Z undoes the rewrite)."): on, the agent and command branches stop after the rewrite; off, they run at once after it (a command still passes the guard first).

Strings an agent may meet in toasts (`{key}` is Ctrl, or Cmd on macOS):

| English | Japanese UI |
|---|---|
| This is a result block. Write your instruction outside of it. | これは実行結果のブロックです。指示はブロックの外に書いてください。 |
| Rewritten as an agent task. {key}+Enter runs it, {key}+Z undoes. | エージェント依頼に書き換えました。{key}+Enter で実行、{key}+Z で取り消し |
| Agent "{agent}" not found (check agents.yaml and PATH). Rewritten anyway; {key}+Z undoes. | エージェント「{agent}」が見つかりません（agents.yaml と PATH を確認）。書き換え済み、{key}+Z で取り消し |
| Rewritten as a command. {key}+Enter runs it, {key}+Z undoes. | コマンドに書き換えました。{key}+Enter で実行、{key}+Z で取り消し |
| LLM is not configured (Settings -> AI Models) | LLMが未設定です（設定 → AIモデル） |
| This slot is already running. | このスロットはすでに実行中です |
| The note changed in the meantime. Press the key again. | ノートが変更されました。もう一度キーを押してください。 |
| This task has no instruction: write it inside the brackets. | タスクに指示が書かれていません。括弧の中に書いてください。 |
| Commands can only run in the desktop app | コマンドの実行はデスクトップアプリでのみ利用できます |
| No answer from the command (timed out) | コマンドから応答がありませんでした (タイムアウト) |
| Security Block: {reason} | セキュリティ制限: {reason} |
| CLI command cancelled | CLIコマンドを中止しました |
| No snippets available | 使えるひな形がありません |
| No slot found to run (place the cursor inside a {{ }}-style block). | 実行できるスロットが見つかりません（カーソルを {{ }} などのブロック内に置いてください） |

### 4.2 Command palette (Ctrl+Shift+P)

Substring filter (case-insensitive) over each entry's title and description; Up/Down/Enter/Esc. Entries: New Tab, Open File, Open Folder, "Ask AI", "Command Bar" (opens in the mode used last), "Command Bar: Run a Command" (manual CLI mode), "Command Bar: AI Writes the Command" (AI mode), "Insert task snippet" (ja 「タスクのひな形を挿入」: the snippet list of 3.1.2 at the caret), Mobile Drop, Voice Input, three prompt presets (Polish, Bullet points, Action items: they open the Ask AI bar with the instruction pre-filled), "Diagram: Convert Selection to Mermaid", "Diagram: Generate Image with Gemini", "Diagram: Generate Image Prompt from Mermaid", AI proofread, Export plain text, Zen mode, Toggle split (20 commands in all); plus every note found in the open workspace folder (title, relative path and first line; Enter opens it in a new tab). It has no settings entries.

### 4.3 Ask AI bar (Ctrl+L) and Command Bar (Ctrl+E)

Two small non-modal bars that open under the caret. Opening one closes the other when that one is idle (a command bar that is running or generating is left alone).

Ask AI bar (`inlinePrompt`, default Ctrl+L / Cmd+L; `openInlinePromptBar`, `executeInlinePromptQuery`, `startLlmTask` in `app.js`). The toolbar AI button (tooltip "Ask AI (Ctrl+L)"), the right-click item "Ask AI...", the palette item "Ask AI" and the key all open this one bar. The palette's three prompt presets open it with the instruction filled in.
- Precondition (`isLlmConfigured`): if the built-in text LLM cannot possibly answer, the bar does NOT open, the note is not touched, and a toast says "LLM is not configured (Settings -> AI Models)" (ja "LLMが未設定です（設定 → AIモデル）"). That is the case when `text.baseUrl` or `text.model` is empty, or when `text.apiKey` is empty and the model name contains `gemini` or the URL is a hosted service (`googleapis.com`, `openai.com`, `groq.com`, `together.xyz`, `openrouter.ai`). Local servers (Ollama, LM Studio, a LAN box) need no key. Failures at run time (bad key, server down, timeout) still leave the one-line `[LLM error: ...]` described below. The same check guards every Ctrl+Enter path that talks to the LLM (an instruction line, a hand-written `[[ @llm ]]`, the ask bar route of 4.1): the same toast, and the note is not touched.
- Opened from Ctrl+Enter (4.1) the bar runs in record mode (`recordInstruction`, `onSubmit`): it only collects the instruction and hands it back, and the answer is written as a task below the target (3.1.1) instead of the placeholder-and-answer flow described below. Placeholder "What should the AI do with this text?", hint "The instruction is saved in the note as [[ @llm ... ]]".
- Target, in this order: the selection; else the current line; else (caret on a blank line) the whole note. A chip shows which: `Selection: N chars` / `Current line` / `Whole note` (`No target text (free question)` for an empty note). The instruction plus the target text go to the built-in text LLM (Settings -> AI Models, `text.*`).
- The bar: an `AI` badge, the input (placeholder "Ask AI: summarize, translate, rewrite..."), the Run button, a close button, the chip and the hint "Enter to run, Esc to close". It opens under the end of the selection, or under the caret when nothing is selected. Enter runs, Esc closes; an Enter that confirms an IME conversion does not send.
- Result: the text `\n\n<answer>\n` is inserted at the end of the target's last line, so the answer sits BELOW the target, after a blank line; the selection or line itself is never replaced. On a blank line (target = whole note, or none) the answer takes that line itself. While the model works the placeholder `[AI Generating: <first 20 chars of the instruction>...]` is in the note (section 3.6); on failure it becomes one line `[LLM error: <message>]`.
- Task panel (Alt+T): each request is a task of type `llm` with the agent name `LLM`. Cancelling it there removes the placeholder (the note is back to how it was), drops a late answer and shows the toast "LLM request canceled"; the request itself is not aborted on the Go side, only forgotten.

Command Bar (`commandBar`, default Ctrl+E / Cmd+E; `openCommandBar`, `toggleCommandBarMode`, `setCliMode` in `app.js`). One bar, two modes: manual CLI (badge `CLI`: the input is a shell command, button Run) and AI (badge `AI CLI`: describe what you want, button "Generate"; the AI writes the command into the field for you to check, and Enter again runs it). Esc closes (and cancels a running command).
- Ways in: Ctrl+E (Cmd+E) opens it in the mode used last (a fresh profile: manual CLI); the right-click item "Command Bar..." (one item); the palette items "Command Bar" (last mode), "Command Bar: Run a Command" (manual) and "Command Bar: AI Writes the Command" (AI); the optional keys `runCliFilter` / `runAiCli` (empty by default, section 4.1).
- Switching: Tab in the field (no modifier keys) or a click on the badge (tooltip "Click or press Tab to switch between CLI and AI mode"); ignored while a command runs or is being generated. A mode picked this way, or by opening a mode explicitly, is remembered in browser storage (`md_memo_cmdbar_mode`: `ai` or `cli`); the automatic switch back to manual after a command was generated is not remembered. If text is selected when the AI mode opens, it is put into the field as the request.
- CLI mode: the input is a shell command (datalist: the last 15 commands from browser storage `md_memo_cli_history` first, then the presets in this order: the agents file's own `command` snippets, the fixed filter list (`sort`, `sort -u`, `jq .`, `tr a-z A-Z`, `wc -l`, ...), then the built-in `command` snippets of 3.1.2 that match the OS; snippets with a placeholder in the body are left out; if the snippet library is not loaded only the fixed list is offered). Before running, `ValidateCliCommand` (guard in `reviewed` mode): blocked -> refused, badge `BLOCKED`; warn -> confirm dialog. Input to the command's stdin = the selection if any, otherwise the WHOLE note. Runs in the app's own working directory (no `Dir` is set), 30 s timeout, output capped at 10 MB (both streams), ANSI stripped, exit code 126 = blocked, 124 = timeout, 130 = cancelled. Windows: `cmd.exe /c "chcp 65001 >nul & <cmd>"`, but PowerShell first (`pwsh.exe` if on PATH, else `powershell.exe`, with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`) when the text looks like PowerShell (`IsPowerShellSyntax`: cmdlet verb-noun names, `$_`, `$(`, `${`, any `{...}`, `1..5`, a leading `|`, and the exact commands `sort -r`, `sort -u`, `uniq`, which are mapped to `Sort-Object`/`Get-Unique`), with a fallback to the other shell on "not recognized"-type errors. macOS: `sh -c`.
- Result handling: two settings decide it. `config.cli.resultPlacement` (`below`, the default, or `replace`; anything else means `below`) is where the output goes when it is put into the note: `below` inserts it on a new line under the last line of the input and leaves the input as it is (`\n` + the output without its trailing line breaks; nothing is inserted when the output is empty, and nothing either when the output is the very text the command ran on: compared with `\r\n` read as `\n` and trailing white space ignored, a blank input never counts, and the toast `cliNoChange` says so; the result tab, if on, still opens), `replace` overwrites the input as the classic filter did (it always writes the output). `config.cli.openResultInNewTab` (default true): with a selection the output is put into the note as set above AND a `[CLI] <cmd>.md` result tab is opened; with no selection only the result tab opens. With the option false and no selection, `below` adds the output at the end of the note (an empty note simply receives it) and `replace` overwrites the ENTIRE note. Failures (`cli.openErrorInNewTab`, default true) open an `[Error] <cmd>.md` tab and keep the bar open with the command for editing.
- AI mode (badge `AI CLI`): Enter asks the LLM (`cli.*`, falling back per field to `text.*`) to write ONE command for the OS (temperature 0.2, active file path/dir/name given as context), strips fences/prompts/shell-name headers, validates in `reviewed` mode, puts the command back into the bar in CLI mode (badge `WARN` for warnings, refused with `BLOCKED` when blocked) for the user to read and press Enter. Nothing runs automatically.

### 4.4 Quick Actions (Ctrl+J)

Up to three cards (one per orthogonal slot: generative/local, deterministic/local, generative/global). Auto-appears after `action.delaySec` (default 1.5 s) of no typing unless `action.manualOnly` or `action.enabled` is false; not while composing an IME. The status-bar `Action` badge cycles On -> Manual (key hint) -> Off. Context sent to prediction: up to 1500 characters before and 500 after the caret. With no `action.apiKey`, the default `action.baseUrl` and no Jev env key, prediction is the built-in local rules and nothing leaves the machine.
- Engines (`Predict` in `pkg/jev/jev_client.go`; the key kind is judged from the endpoint and the key shape, `sk-or-` = OpenRouter, because Settings has ONE key field): (1) Jev on System One. Jev only RANKS the built-in candidate pool (every candidate of the keyword rules, currently 11, offered as one Choice question `next_action`; the answer's probabilities order the pool). It never writes text, so what is shown and run is always a built-in candidate (`sh` ones still pass the strict guard). Routes: TypeSafe direct (`action.baseUrl` on a typesafe.ai host, also `.../v1` or `.../v1/systemone`, plus a TypeSafe key, sent to `https://api.typesafe.ai/v1/systemone`) or OpenRouter (an `sk-or-` key and a Jev model name: `jev-latest`, `jev-*`, `typesafe/jev-*`, with the default or a blank base URL, sent to the fixed `https://openrouter.ai/api/v1/systemone`). (2) OpenRouter chat completions (fixed `.../chat/completions`, `sk-or-` key only) when the model is NOT a Jev model: the model writes the candidate text. (3) A custom base URL: `POST <baseUrl>/predict`. When route (1) applies and cannot be used (401/402/422/429/5xx, a network error, the 5 s client timeout, an answer whose Choice confidence is below 0.15, an empty note) the local rules answer; the key is never tried on another engine. A TypeSafe key next to the OpenRouter base URL is sent nowhere. The three cards are then picked from the ranked list by the orthogonal selector as before.
- Keys: Ctrl+1..3 (Cmd on macOS; Alt+1..3 also) runs a card; Ctrl+Tab moves the highlight, then Enter confirms (plain Enter never runs a card); Esc closes.
- Card kinds: delegate (`ai` action or a command that begins with a configured slot open delimiter) inserts the slot on the line after the caret and runs it; run (`sh`) is verified with the STRICT guard then executed (Windows `powershell -NoProfile -NonInteractive -Command`, else `sh -c`; app working directory; 20 s; 2 MB output cap) and appended as `- [x] sh <cmd>` plus the output as a blockquote (<= 3 lines) or fenced block, or `> (出力なし)`; write (`doc` action that is not a slot) calls the built-in LLM, see the Go note in `troubleshooting.md`; only an engine that writes candidate text (a chat model, a custom `/predict` server) produces one, the Jev route never does.

### 4.5 Task panel (Alt+T / Option+T, or click the running-task badge)

Lists running tasks and finished ones. Agent/action tasks are listed with the agent's name, an Ask AI request or a `[[ @llm ]]` task as type `llm` (label "LLM", sections 4.3 and 3.1.1), and a `[[ $ command ]]` task as type `command` (label "Command"). The last 10 finished tasks (done / failed / canceled) are kept and the newest 5 are shown. The status-bar badge `stat-tasks` is visible only while something runs (and 4 s after it ends). Each running card has a Cancel button (ja 「中断」). For a classic slot it kills the agent process tree and restores the slot to the original text; for a `{{ @agent }}` task it kills the process tree and removes the run marker; for an LLM task it forgets the request (a late answer is dropped); for a command task it stops the command. When `hover_peek_enabled`, agent (`slot`) tasks show the agent's latest output line, polled every second (Hover Peek).

### 4.6 Settings dialog

Open with Ctrl+, (Cmd+,), the toolbar sliders icon, or the context menu. Five tabs. Save closes at once and persists in the background; Cancel/Esc discards live changes (theme, language, shortcuts, toolbar layout are applied live and restored).
1. General: theme (`olive`, `blue`, `forest`, `charcoal`), language (`ja`/`en`), restore session, 2-pane on startup, tray resident, autosave, IME Guardian, AI correction, cursor aura, toolbar and right-click layout editor (show/hide/reorder; the Settings icon cannot be hidden).
2. AI Models: Ollama status/start/stop/"Install Gemma 4" card; Text LLM; Ghost Text; Image OCR/Vision (+ paste-OCR toggle); Voice input (model with suggestions, API style, language codes, mode, custom vocabulary, silence timeout, prompt; there is no voice key/URL field, it falls back to the Vision ones); Image generation.
3. Agent (ja 「連携」; four groups, in this order): Commands (Run): CLI model, open result in new tab, Max Pipe Input Size (stored but not enforced); Agents (Delegate): Open agents.yaml button + availability badge, default agent, timeout, Ghost Diff duration, Hover Peek; Auto selector (Ctrl+Enter) (ja 「自動セレクター (Ctrl+Enter)」): two checkboxes, "Let Ctrl+Enter decide: ask the AI, hand over to an agent, or run a command" (`autoSelector.enabled`) and "Confirm before an auto-detected agent or command runs" (`autoSelector.agentConfirm`), both ticked by default and saved with Save like the rest (behaviour in section 4.1); Suggestions (Quick Actions): enabled, manual only, delay, base URL/model/API key.
4. Sync: scraps folder (+ Browse), Git sync toggle/debounce/branch, Git remote URL with Test Connection and Link/Init, git repo status badge.
5. Shortcuts: table of section 4.1.
Footer: Export... / Import... (they open the "Export package" / "Import package" dialogs, section 5.2), Save, Cancel.

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
| `<cfg>/agents.yaml` (`.yml`, `.md`, `.json`) | YAML/JSON/Markdown with an embedded fenced block | Slot agents (with their `aliases`), notations, recipes and task `snippets` (3.1.2). Search order and schema in `setup-guide.md`. The Go side picks changes up on the next slot run (mtime/size cache); the page reads `aliases` and `snippets` at start. |
| `<scrapDir>/.md-memo/agents.yaml` (or `.yml`, `.md`, `.json`) | same | Per-project agents file; searched BEFORE `<cfg>`. |
| `<cfg>/session.json` | JSON, 0600 | Open tabs and unsaved buffers (restore session). Private. |
| `<cfg>/ipc-session.json` | JSON, 0600 | `{pid, port, token, started_at}` of the running instance (section 2). |
| `<cfg>/instance.lock` | flock file (macOS/Linux only) | Single-instance lock. Windows uses the named mutex `Local\MDMemo_SingleInstance_Mutex_v1` instead. |
| `<cfg>/voice_cache/` | `<stamp>_<id>.webm`, 0600 | Failed voice recordings awaiting retry/keep/discard. |
| `<cfg>/pack_backups/<YYYYMMDD-HHmmss>/` | copies of files | Created only when a package import overwrites an agents file or a skill: the previous versions (section 5.2). Outside every project. |
| `<cfg>/assets/` | images | Generated diagram images (`diagram_<ns>.png`, `.jpg` or `.webp`) when the note has no absolute path; pasted/imported assets when the note has no folder and no workspace is open. Links are then absolute (`file://` for pasted assets). |
| `<note folder>/assets/` | files | `SaveAsset`: `YYYY-MM-DD-HHmmss.<ext>` (extensions png jpg jpeg gif webp webm ogg m4a mp3 wav pdf txt md; <= 25 MB); `ImportAssetFile`: sanitised original name; `KeepVoiceCache`: `voice_note.webm`; generated diagrams: `diagram_<ns>.<ext>`. Name clashes get `-2`, `-3`. Base = the note's folder, else the open workspace folder, else `<cfg>`. |
| `<scrapDir>/YYYY-MM-DD.md` | Markdown | Daily scrap, local date. Entry format appended by a pipe: a line `---`, then `## [HH:MM:SS] <command or "CLI Pipe">`, then a fenced code block tagged `text` holding the (right-trimmed) content; a blank line separates entries. Default `<scrapDir>` = `~/Documents/md-memo/scraps` (`~` = user home). Created on first pipe. |
| `<scrapDir>/.git` | git repo | Enables Git sync. `git add .` adds EVERYTHING in the scraps folder, including `.md-memo/agents.yaml` and any `.env` there. |
| project-root `.env` | dotenv | Environment for slot agents only (never for MD-Memo itself). See `setup-guide.md`. |
| `<UserCacheDir>/md-memo/webview/` (Windows `%LOCALAPPDATA%\md-memo\webview`) | WebView2 profile | Browser storage: cached config copy, session copy, CLI history, last Command Bar mode, voice-cache map, workspace folder, font size. Browser storage is per ORIGIN, and the origin includes the port (41739 or a random one). |
| `*.mdmemopack` (wherever the user saves it; suggested name `md-memo-YYYYMMDD.mdmemopack`) | zip, written with mode 0600 | Settings package made by Settings -> Export... and read only when the user picks it in Settings -> Import... (section 5.2). |
| `jev.json` / `.jev.json` | (planned) | Not read by any released code path. See 1.4 and `setup-guide.md`. |

### 5.1 Git sync (`pkg/gitsync`)

Active only when `scraps.gitSyncEnabled` (default true) and `<scrapDir>` is a git work tree (`.git` exists or `git rev-parse --is-inside-work-tree`). On startup, and again whenever scrap/git settings change on Settings Save or after Link/Init: `git pull --rebase origin <branch>` (120 s limit; "couldn't find remote ref"/"no tracking information" are treated as an empty remote). After any save (`SaveFile`, `SaveFileAs`) or scrap append the debounce timer restarts (default 30 s; UI range 5-3600): then `git add .`, `git status --porcelain`, `git commit -m "chore(scrap): sync YYYY-MM-DD HH:mm"`, `git push origin <branch>` (local steps 30 s, network steps 120 s). `GIT_TERMINAL_PROMPT=0` is set, so credentials must already work non-interactively (credential helper or SSH key). No remote is required for local commits, but the push then fails and the status turns to error. `SetupRemote` (Settings -> Sync -> Link/Init) runs `git init` if needed, sets local `user.name=MD-Memo` / `user.email=md-memo@local` when unset, `git branch -M <branch>`, creates `README.md` and an initial commit if none exist, sets/updates `origin`, and `push -u`, with an automatic `pull --rebase --allow-unrelated-histories` retry when the remote already has commits.

### 5.2 Settings packages (`.mdmemopack`)

Source: `pkg/configpack/*`, `app_pack.go`, `frontend/js/config_pack.js`. One zip file that carries part of a working setup to another PC: settings sections, the app-wide and the project agents file, and the skills of the CURRENT PROJECT. Only the user makes and applies it, in the Settings dialog footer:
- "Export..." opens "Export package": format "Package (.mdmemopack)" (suggested name `md-memo-YYYYMMDD.mdmemopack`) or "JSON (settings only)" (one plain JSON file, `md-memo-config.json`, with the chosen sections; no agents files, no skills). It exports the SAVED settings (unsaved edits in the Settings dialog are not included). "Include API keys" is off by default.
- "Import..." first opens a native file dialog (a package, or such a plain settings JSON file), then "Import package": the user ticks what to apply. Sync settings are unticked by default; agents files and skills that already exist are badged "will overwrite"; project items show "needs a project" when no project is found.

IMPORTANT for agents: settings are merged into the config by the RUNNING app. On import the Go side only reads the package and hands the settings text back; the page merges the ticked sections over the live config, saves it, and re-applies theme, language, toolbar layout and shortcuts (the Settings dialog re-opens). Never try to import a package by writing `config.json` (the app rewrites the whole file at its next save, section 5), by unzipping a package into `<cfg>` or a project, or by copying its files by hand. Agents files and skills are written by the app itself, after the user has ticked them in the dialog.

Layout of the zip:

| Entry | Content |
|---|---|
| `manifest.json` | the index below (max 256 KB) |
| `config/config.json` | the chosen settings as one JSON object: only the top-level keys of the chosen sections (max 2 MB) |
| `agents/app.yaml` | the app-wide agents file (`<cfg>/agents.*`, max 1 MB), always stored under this name; the original file name is kept in the manifest (`origName`) |
| `agents/project.yaml` | the project agents file (`<project>/.md-memo/agents.*`, max 1 MB), always stored under this name |
| `skills/<root>/<name>/...` | one skill per folder (a single-file skill is `skills/<root>/<file>.md`, its manifest `name` being the file name and `entry` `file`); `<root>` is `skills`, `.claude/skills`, `.gemini/skills` or `.codex/skills`, so a file looks like `skills/.claude/skills/my-skill/SKILL.md` |

Manifest (`configpack.Manifest`; the app writes it indented, this is only the shape with example values):

```json
{
  "format": "md-memo-pack",
  "version": 1,
  "createdAt": "2026-09-21T10:00:00+09:00",
  "appVersion": "1.6.0",
  "includesSecrets": false,
  "configSections": ["general", "models", "shortcuts"],
  "items": [
    { "id": "config", "kind": "config", "path": "config/config.json", "bytes": 2048 },
    { "id": "agents:app", "kind": "agents", "scope": "app", "path": "agents/app.yaml", "origName": "agents.yaml", "bytes": 900 },
    { "id": "agents:project", "kind": "agents", "scope": "project", "path": "agents/project.yaml", "origName": "agents.yaml", "bytes": 700 },
    { "id": "skill:.claude/skills/my-skill", "kind": "skill", "root": ".claude/skills", "name": "my-skill", "entry": "dir", "files": 3, "bytes": 5120 }
  ]
}
```

- `format` must be `md-memo-pack` and `version` 1 (a higher version is refused: "package is from a newer version; update the app"). `createdAt` is RFC 3339; `appVersion` is the exporting app's version.
- Item ids are fixed: `config`, `agents:app`, `agents:project`, `skill:<root>/<name>`. `entry` is `dir` or `file`; `origName` is one of `agents.yaml`, `agents.yml`, `agents.md`, `agents.json`.
- `includesSecrets` is true only when "Include API keys" was ticked and at least one secret value was found. `false` is not proof that the package is clean: an agents file that could not be cleaned safely is left unchanged and only a notice at export time says so.
- `configSections` lists the section ids that were exported:

| Section id | Label in the dialog (EN) | Top-level `config.json` keys (from `CONFIG_SECTIONS`) | Ticked by default |
|---|---|---|---|
| `general` | General | `general` | yes |
| `models` | AI Models | `text`, `autocomplete`, `vision`, `voice`, `cli`, `image` | yes |
| `integration` | Agent & Quick Actions | `action`, `default_agent`, `timeout_seconds`, `hover_peek_enabled`, `ghost_diff_duration_ms`, `autoSelector`, `agents`, `slot_profiles`, `recipes` | yes |
| `shortcuts` | Shortcuts | `shortcuts` | yes |
| `sync` | Sync (tag "this PC only") | `scraps`, `scrap_dir`, `git_sync_enabled`, `git_sync_debounce_seconds`, `git_remote_branch`, `max_pipe_size_mb` | no |
| `other` | Other settings | every top-level key not listed above (shown only when something is left) | yes |

The ids are written into the manifest and do not change; `CONFIG_SECTIONS` in `frontend/js/config_pack.js` is the source for the key lists. A section without a saved value is not offered.

What a package never contains: `.env` files (`.env` and `.env.*`, except the templates ending `.example`, `.sample`, `.template` or `.dist`), `.git`, `node_modules` and `__pycache__` folders, `.DS_Store`, `Thumbs.db` and `desktop.ini`, symbolic links, global skills (those in the home folder), and the notes themselves (the scraps folder's contents are never packed; the Sync section carries only its path and the Git remote). Skills come only from the current project, and only from the four `<root>` folders that exist there.

Secrets when "Include API keys" is off (the default): in the settings every string under a key whose name contains `apikey`, `api_key`, `api-key`, `token`, `secret`, `password` or `passwd` (any case, any depth) is blanked to `""`, and an `http(s)://` URL value such as the Git remote loses `user:pass@` or `token@`; numbers and booleans are left alone. In agents files the same kind of values under `env:` are blanked (comments and layout kept); if that cannot be done safely the file is left unchanged and the result panel warns that it may still contain secrets. The result panel shows how many were left out. On import, an empty value under a secret-named key never overwrites a key the user already has.

Limits (`pkg/configpack/configpack.go`): package file 50 MB; 3000 entries; one file 10 MB; 100 MB after unpacking; settings 2 MB; one agents file 1 MB; manifest 256 KB. A single skill or agents file that exceeds them is left out of the export with a notice (never truncated); if the whole selection together exceeds them, the export fails with `size limit exceeded`.

Refusals on import (bilingual message, Japanese then `/ English`): `not a zip file` (the file starts like a zip but is not a valid one; zip64 archives are refused as well), `size limit exceeded`, `too many entries`, `unsafe path in package` (an entry name with `..`, an absolute path, a drive letter or `:`, a backslash, control characters, `<>"|?*`, a Windows reserved device name such as `CON` or `COM1`, a trailing dot or space, or an over-long name), `invalid manifest`, `invalid entry in package` (encrypted or unusual-compression entries, links and other non-regular entries, a listed entry that is missing), `duplicate entry names` (case-insensitive) and `package is from a newer version; update the app`. A file that is not a zip at all must be a JSON object of at most 2 MB, else `file is too large` or `not a settings package or a settings JSON file`. Every entry name is checked, listed or not; entries the manifest does not list are ignored; listed skill files that are `.env` files, `.DS_Store` / `Thumbs.db` / `desktop.ini`, or sit under `.git`, `node_modules` or `__pycache__` are never restored.

What an import writes (only what the user ticked):
- Settings: merged into the running app's config as above (objects merge; arrays and scalars are replaced; a null never overwrites). The result panel says "Some settings take effect after you restart MD-Memo." whenever settings were applied.
- App-wide agents file: `<cfg>/agents.yaml`; another extension (`agents.yml`, `agents.md`, `agents.json`) is kept only if that file already exists and nothing of higher priority shadows it. Project agents file: `<project>/.md-memo/agents.yaml` (folder created if needed). A file that is empty or does not parse (`slotagent.ParseAgentConfigFile`) is skipped with the reason; writes into a project never go through a symbolic link. The slot-config cache is dropped afterwards, so the next agent run re-reads the agents settings.
- Skills: `<project>/<root>/<name>`. The skill is unpacked into a hidden temporary folder beside the target first, then swapped in; an existing skill of that name is replaced as a whole (an existing symbolic link is never replaced).
- Backups: everything that is overwritten is first copied to `<cfg>/pack_backups/<YYYYMMDD-HHmmss>/` (`-2`, `-3` ... on a name clash; Windows `%AppData%\md-memo\pack_backups\...`), as `app/<agents file name>`, `project/.md-memo/agents.yaml` and `project/<root>/<name>/...`. The folder exists only when something was overwritten and is OUTSIDE every project, so skill folders stay clean. The result panel shows its path.

"Project" (`packProjectRootNote`): the folder of the active note (an unsaved note: the opened workspace folder; neither: the scraps folder), walked upwards to the nearest folder that holds `.md-memo`, `agents.yaml`, `agents.yml`, `AGENTS.md`, `agents.json`, `skills` or `.git` (none found: that folder itself). A result that is the home folder or a folder containing it is never treated as a project, because its `.claude/skills` are the user's global ones. Without a project the dialogs say "Project agent definitions and skills need a project: save the note to a file or open a folder first."

Reading a package as an agent is fine and safe when done without extracting: `manifest.json` is the index; see the recipe in `setup-guide.md` (h).

---

## 6. Network surfaces

| Surface | Bind / target | Auth | Lifetime |
|---|---|---|---|
| Embedded UI server | `127.0.0.1:41739` (random port if taken) | none; serves the embedded frontend and `/api/image?path=<abs path>` (GET/HEAD; Host header must be `127.0.0.1:<port>` or `localhost:<port>`; image extensions only; content sniffed as `image/*` except SVG) | while the app runs |
| IPC JSON-RPC | `127.0.0.1:49152` (random if taken) | optional token (section 2) | while the app runs |
| Mobile Drop server | `0.0.0.0:8765` (random if taken), LAN-visible | one-time 128-bit token in the URL query, constant-time compared before any body is read | only while the dialog is open (6.2) |
| Cloudflare Quick Tunnel | `cloudflared tunnel --url http://127.0.0.1:<mobile-drop-port>` | same token, embedded in the public URL | 6.3 |
| Outbound LLM calls | text (including Ask AI), ghost text, vision, voice, image generation, command-bar AI-mode generation | API key from `config.json` (Gemini keys travel in the URL query for `generateContent`, in `x-goog-api-key` for the Interactions API; OpenAI-style in `Authorization: Bearer`) | per request (120 s general, 30 s ghost text) |
| Quick Actions engine | Jev on System One (ranks the built-in candidates): TypeSafe `https://api.typesafe.ai/v1/systemone` (`action.baseUrl` on a typesafe.ai host and a TypeSafe key) or OpenRouter's fixed `https://openrouter.ai/api/v1/systemone` (an `sk-or-` key and a Jev model); OpenRouter's fixed `https://openrouter.ai/api/v1/chat/completions` for a non-Jev model; else `<action.baseUrl>/predict` for a custom URL. CLI `jev dispatch` uses the same System One routes | `action.apiKey` (GUI, one field for both services); env keys per `setup-guide.md` section (d) | only when configured; sends about 2,000 characters of context, nothing for an empty note |
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

One judgement function, `jev.VerifyCommand(cmd, mode, rules)`, is used by `md-memo jev verify`, the command-bar run gate (`reviewed`, which the `[[ $ command ]]` task of 3.1.1 shares), command-bar AI-mode validation (`reviewed`), and Quick Actions execution (`strict`, via `ASTCommandVerifier`). It is a static check of BASH text (`mvdan.cc/sh` parser), not a sandbox: it cannot see inside scripts or binaries and reports run-time-built strings as `opaque`.

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

`window.backend.*` (defined in `window_windows.go` / `window_darwin.go`) wraps Go methods bound as `window.backend_<name>`; results arrive through globals such as `window.__onLLMResult`, `__onAutocompleteResult`, `__onSlotAgentResult`, `__onVoiceResult`, `__onMobileDrop*`, `__onCliFilterResult`, `onGitSyncStatus`, `onScrapAppended`. `window.__mdMemoRPC` (section 2) is the only bridge object meant for tooling. Other page globals reachable through `ui eval`: `SlotAgent`, `AutoSelector`, `SlotSnippets`, `JevAction`, `TaskManager`, `VoiceInput`, `FileAnchor`, `ChromeLayout`, `ConfigPack`, `HtmlToMd`, `MdMemoBridge` (its `getConfig()` returns the live config including API keys), `__testHelper`. Do not use them for normal work.

---

## Source of truth

- `main.go` (dispatch, pipe, single instance, UI server, `/api/image`), `app.go`, `app_cli.go`, `cli_ai.go`, `app_rpc.go`, `app_config.go`, `app_scrap.go`, `app_files.go`, `app_inputs.go`, `app_slot.go`, `app_jev.go`, `app_llm.go`, `app_mobiledrop.go`, `app_pack.go`, `ollama_ops*.go`, `window_windows.go`, `window_darwin.go`, `hotkey_darwin.go`, `console_windows.go`
- `pkg/cli/{client,headless,format}.go`, `pkg/ipc/{ipc,rpc_types}.go`, `pkg/appdir`, `pkg/scrap`, `pkg/search`, `pkg/gitsync`, `pkg/configpack/*`, `pkg/slotagent/*` (`mention.go` for `@agent` resolution), `pkg/jev/*` (`guard*.go`, `verifier.go`, `runner.go`, `agent_bridge.go`, `jev_client.go`, `types.go`), `pkg/llm/{llm,audio,ollama}.go`, `pkg/dropzone/{server,dropzone,tunnel,html}.go`, `pkg/hotkey`, `pkg/singleinstance`, `pkg/shellenv`, `pkg/encoding`
- `frontend/index.html`, `frontend/js/{app,slot_agent,auto_selector,slot_snippets,jev_action,task_manager,voice_input,file_anchor,chrome_layout,config_pack,i18n,html_to_md}.js`
- Existing docs are orientation only and contain errors: `manual.html`, `manual_ja.html`, `README.md`, `docs/design/*.md` (the design documents describe unimplemented work).
