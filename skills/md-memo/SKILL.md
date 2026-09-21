---
name: md-memo
description: Use this skill whenever a task involves operating, scripting, integrating, configuring or troubleshooting MD-Memo, the local Go + WebView Markdown scratchpad (binary `md-memo`, repo `youshinh/md-memo`). It covers reading or editing the open note with `md-memo buffer|tab|ui` or the local JSON-RPC port, piping output into the daily scrap, judging a shell command with `md-memo jev verify`, editing `config.json`, `agents.yaml` or `.env`, setting up API keys, voice input, OCR, Ollama, Git sync, Mobile Drop or agent CLIs behind `{{ }}` slots, explaining what a shortcut, note syntax or setting does, and diagnosing why a feature does nothing. It carries source-verified references (interfaces, setup, troubleshooting) and the safety rules to follow before touching the user's live instance, notes or keys.
---

# MD-Memo for agents

MD-Memo is a single-instance desktop Markdown scratchpad: a Go core with an OS WebView (Windows WebView2, macOS WKWebView; Linux unsupported) around a plain `<textarea>` editor. It keeps daily "scrap" files (`YYYY-MM-DD.md`), talks to LLMs (Ollama, Gemini, OpenAI-compatible), hands `{{ instruction }}` blocks to external agent CLIs, and exposes a small CLI plus a local JSON-RPC port. Version 1.5.5. The user's instance is usually RUNNING and holds private notes and API keys.

Read the reference that matches the job before acting. Everything in them was checked in source; `(unverified)` is marked.

## Interfaces at a glance

| Interface | What it is | Needs GUI running | Reference |
|---|---|---|---|
| `md-memo buffer get\|set\|append\|replace\|replace-selection` | read/edit the active note | yes | interfaces.md 1.2 |
| `md-memo tab list\|switch`, `md-memo ui activate\|toggle-split\|eval` | tabs and window; `eval` is unrestricted JS | yes | interfaces.md 1.3 |
| `cmd \| md-memo [title]`, `md-memo <file>` | append to today's scrap, open a file | no (cold-starts GUI) | interfaces.md 1.0 |
| `md-memo jev verify [--mode strict\|reviewed\|unattended]` (exit 0/1/2), `jev score`, `jev predict`, `jev dispatch`, `agent prune` | local guard/scoring/pruning | no | interfaces.md 1.4, 7 |
| JSON-RPC 2.0 on `127.0.0.1:<port from ipc-session.json>` | same as the CLI, callable directly | yes | interfaces.md 2 |
| In-note syntax: `{{ }}` `[? ]` `【? 】` `[! !]` `[>> ]` slots, ghost text, file links, voice markers `⦅...⦆`, `## Mobile Drop [..]` | features driven by text in the note | yes | interfaces.md 3 |
| GUI: shortcuts, command palette, command bar (Ctrl+Shift+B / Ctrl+Shift+E), Quick Actions (Ctrl+J), task panel (Alt+T), Settings (5 tabs), status bar | user-facing surfaces | yes | interfaces.md 4 |
| Files: `<cfg>/config.json`, `agents.yaml`, `session.json`, `ipc-session.json`, `voice_cache/`, `assets/`, scraps folder, git | persistence (`<cfg>` = `%AppData%\md-memo` or `~/Library/Application Support/md-memo`) | no | interfaces.md 5, setup-guide.md |
| Network: UI `127.0.0.1:41739`, IPC `49152`, Mobile Drop `0.0.0.0:8765` (one-shot), optional Cloudflare tunnel, LLM/GitHub calls | listeners and outbound traffic | - | interfaces.md 6 |

## I want to ... -> use ...

| Goal | Do this |
|---|---|
| Read the open note | `md-memo buffer get --json` (keep `hash`). Piped output is JSON; `--text` for raw text. |
| Change the open note safely | `md-memo buffer set --expected-hash <hash> "<full text>"` (or `replace --start L:C --end L:C`, `append`). On `conflict`, re-read and redo. |
| Work on the selection | `buffer get --selection`, `buffer replace-selection` (exit 1 `no active selection` if none). |
| Add a log or result to the user's scrap | `some-command \| md-memo "title"` (max 10 MB). |
| Decide if a shell command is dangerous | `md-memo jev verify --mode reviewed "<cmd>"`; 0 safe, 1 blocked, 2 cannot vouch. Strict is the default. |
| Give an agent only the relevant parts of a note | `md-memo agent prune --query "..." --file note.md` |
| Talk to MD-Memo from code | JSON-RPC, section 2 of interfaces.md (read the port from `ipc-session.json`; always send an `id`). |
| Set up keys, models, voice, OCR, Ollama, Git, tunnel | setup-guide.md (a) procedure, (b) schema, (e) checklist. |
| Add or change an agent CLI or a slot notation | edit `agents.yaml` (setup-guide.md (c)); confirm the CLI's flags with `--help`. |
| Change a shortcut | `config.json` `shortcuts.<action>` with MD-Memo closed, or the Settings recorder (setup-guide.md (f)). |
| Explain a feature or symbol in a note | interfaces.md 3 (note syntax) and 4 (GUI). |
| A feature does nothing | troubleshooting.md, matching the symptom. |

## Safety rules (follow all)

1. The user's MD-Memo is live and single-instance. Never start another one (bare `md-memo`, `md-memo <file>` when it is not running), never kill it, never open a second window. To restart it, ask the user (Windows: tray icon -> Quit; closing the window only hides it).
2. Never read, print, paste or commit `config.json`, its backups, `.env`, or `session.json`; they hold API keys and private notes. Redact keys as `set (...last4)`. Never call `md-memo ui eval` to read config or call `window.backend.*`; treat `ui eval` as full control of the UI.
3. Edit `config.json` ONLY while MD-Memo is fully closed (the UI rewrites the whole file on Save and on status-bar toggles). Back up first; keep valid BOM-free UTF-8; write explicit values instead of deleting keys. `agents.yaml` may change while running, but a syntax error is silently ignored: lint it.
4. RPC writes behave like typing: undoable, but with autosave (default on) the note's FILE is rewritten about 1.5 s later. Always pass explicit content (an empty stdin empties the note) and `--expected-hash`; use only tab ids from `tab list` (an unknown id to `tab switch` breaks the active tab).
5. Running a `{{ }}` slot overwrites the note's file on disk with the editor text (UTF-8) before the agent starts. Do not trigger slots for the user without saying so. Never add permission-skipping flags to agent definitions.
6. Git sync runs `git add .`, commit and push inside the scraps folder: never point it at a repository you do not want auto-committed and never keep `.env` there un-ignored.
7. `jev verify` catches known dangerous patterns in bash text; it is not a sandbox and does not prove safety. Exit 2 is not "safe".
8. Do not start the Cloudflare tunnel, install tools, change OS permissions, or run `ollama` commands (they can start the Ollama app) unless asked. Do not claim something works without running its verification step; say `(unverified)`.

## Facts that are easy to get wrong

- Not implemented (design docs only): `md-memo share`, `agent init-skill`, `config` subcommands, `filters.json`, `prompts.json`, `hooks/`, and any loading of `jev.json` / `.jev.json`. The `max_pipe_size_mb` setting has no effect (limit is a fixed 10 MB).
- `--tab` is honoured only by `buffer get`, `get --selection` and `replace-selection`; `set`, `append`, `replace` always act on the primary pane's active tab.
- `hash` = first 16 hex chars of SHA-256 (UTF-8). `generation` is a process-wide counter of RPC writes only.
- MD-Memo's own LLM keys live only in `config.json` (not in `GEMINI_API_KEY`-style variables). Only `TYPESAFE_API_KEY`, `JEV_API_KEY`, `OPENROUTER_API_KEY` (CLI only), `JEV_MODEL`, `JEV_API_URL` and PATH-like variables are read (setup-guide.md (d)). Slot agents get keys from `<projectRoot>/.env`.
- Ctrl+Enter in the editor runs a slot: the caret's slot, else the next one after it, else the first in the note.
- Shipped default agent arguments can be stale for external CLIs (the `codex` entry does not match `codex exec`); check `--help` before relying on them.
- This folder doubles as an MD-Memo slot skill: `{{ @md-memo: ... }}` in a note inside this repository passes this file's body to the agent.

## References

- [references/interfaces.md](references/interfaces.md): every CLI subcommand and flag, JSON-RPC methods and error codes, note syntax, GUI surfaces, files, network surfaces, the command-safety guard.
- [references/setup-guide.md](references/setup-guide.md): configuration procedure, full `config.json` schema, `agents.yaml`, `.env`, environment variables, per-feature prerequisites with verification commands, ready-to-paste instructions (EN/JA), never-do list.
- [references/troubleshooting.md](references/troubleshooting.md): symptom -> cause -> fix.
