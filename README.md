# MD-Memo

> A zero-latency, local-first Markdown scratchpad engineered for instant capture.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/github/go-mod/go-version/youshinh/md-memo)](https://golang.org/)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac-lightgrey)](#quick-start)
[![Official Manual](https://img.shields.io/badge/Docs-Official%20Manual-green.svg)](https://youshinh.github.io/md-memo/manual.html)

**MD-Memo** is a high-bandwidth capture instrument that sits quietly in your system tray. Built with a compiled Go core and OS-native webviews, it wakes in milliseconds, manages multilingual IME states autonomously, and vanishes when you're done.

[Official Manual](https://youshinh.github.io/md-memo/manual.html) • [日本語マニュアル](https://youshinh.github.io/md-memo/manual_ja.html) • [Releases](https://github.com/youshinh/md-memo/releases) • [The Scratchpad Paradox](#the-scratchpad-paradox) • [Which One Do I Use?](#which-one-do-i-use) • [Architecture & Capabilities](#architecture--capabilities) • [Programmable Control Hub](#programmable-control-hub--json-rpc-20) • [Quick Start](#quick-start) • [日本語ドキュメント (JA)](README_JA.md)

---

## Visual Showcase

| Live Split View & Mermaid Diagrams (`Ctrl+\`) | Command & Navigation Palette (`Ctrl+Shift+P`) |
|:---:|:---:|
| ![Live Split View](img/screen_diagram.png) | ![Command Palette](img/screen_palette.png) |

| AI Prompt Dialog (`Ctrl+L`, or the inline bar with `Ctrl+K`) | CLI Pipeline & Filter Bar (`Ctrl+Shift+B`) |
|:---:|:---:|
| ![AI Prompt Dialog](img/screen_prompt.png) | ![CLI Pipeline Filter](img/screen_cli_filter.png) |

| Parallel Daily Scrap Search (`Ctrl+Shift+F`) | Autonomous Agent & Orchestration Settings |
|:---:|:---:|
| ![Scraps Search](img/screen_scraps_search.png) | ![Agent Settings](img/screen_settings_agent.png) |

---

## The Scratchpad Paradox

Modern knowledge bases (like Obsidian or Notion) are phenomenal for structuring long-term data, but their architectures inherently introduce startup latency and heavy memory footprints. When you need to capture a fleeting thought or pipe an ephemeral error log, a 2-second Electron initialization breaks cognitive momentum.

**MD-Memo is not a replacement for your vault; it is the zero-friction buffer in front of it.**

| Dimension | Standard Text Editor | Knowledge Vaults | MD-Memo |
|---|---|---|---|
| **Architecture** | C++ / Swift | Electron / JVM | **Go 1.26 + OS-Native WebView** |
| **Summon Latency** | ~100ms (Cold) | 2.0s – 5.0s | **< 15ms (from System Tray)** |
| **Idle Memory** | ~15 MB | 400 MB – 800 MB+ | **5 – 15 MB (Aggressive GC)** |
| **Storage Model** | Plain text | Internal DB / Proprietary | **100% Local POSIX Plain Text** |
| **Programmable IPC** | Socket plugin / none | Heavy HTTP plugins | **Zero-latency JSON-RPC 2.0 TCP** |
| **File Dialogs** | OS Native | Node.js IPC wrapper | **Windows: native COM `IFileDialog`. macOS: system file chooser via AppleScript.** |

> **Workflow Tip**: Point MD-Memo directly at your Obsidian Vault, Git repository, or daily log directory to use it as an instant-entry terminal.

---

## Which One Do I Use?

Everything AI-related is organized around three verbs — Write, Run, and Delegate — and each has a single entry point to remember.

| What you want | Entry point | What it does |
|---|---|---|
| **Write** — fix or draft the text in front of you | `Ctrl+K` / `Cmd+K` | The built-in LLM rewrites or generates text in seconds |
| **Run** — execute a command | Command bar `Ctrl+Shift+B` (type the command yourself) / `Ctrl+Shift+E` (describe it in plain language and the AI writes it) | Pipes your selection through a shell command and replaces it with the output |
| **Delegate** — hand off a whole investigation or implementation | Type `{{ instruction }}` in the note | An external agent CLI works in the background for minutes |
| **Not sure what to do** | `Ctrl+J` / `Cmd+J` | Suggests up to three next steps for what you are writing (Quick Actions) |

*(See the [Official Manual](https://youshinh.github.io/md-memo/manual.html) for the full walkthrough of each)*

---

## Architecture & Capabilities

### 1. Minimal Footprint & Sub-Millisecond Wake
Built to run 24/7 without taxing your system.
- **Instant Summon (`Ctrl+Alt+M` / `Option+Cmd+M`)**: Bypasses heavy rendering pipelines to wake instantly with your cursor exactly where you left it. On Windows this wakes it from the system tray; on macOS, where there is no menu-bar icon, it brings the app forward from the Dock (clicking the Dock icon does the same — quit with `Cmd+Q`).
- **Aggressive Idle Reclamation**: Leverages `debug.FreeOSMemory()` to compress the active working set down to 5–15 MB when the window is minimized or idle.
- **Native OS Dialogs**: Windows uses native COM `IFileDialog` panels; macOS uses the system file chooser via AppleScript. Both keep file operations instantaneous without an Electron-style wrapper.

### 2. Autonomous IME Shield (IME Guardian)
Technical writing in multilingual CJK environments often suffers from IME mode-switching friction. MD-Memo handles this algorithmically:
- **Lexical Scope Protection**: Inside inline code (`` `...` ``), code blocks, and URLs, the editor intercepts full-width characters and forces alphanumeric mode with negligible overhead (~11 µs per keystroke).
- **Phonological Auto-Correction**: Detects Romaji cadence typed in direct input mode and can silently convert it into composition.
- **Powered by LLRT**: Computational linguistics via Log-Likelihood Ratio Testing ensures your typing speed is never compromised.
- **Platform note**: On Windows the Guardian switches the OS input source for you, and it starts on when your system language is Japanese. macOS can't switch the input source automatically yet, so it starts off there.

### 3. Write, Delegate, Suggest — Local-First AI
AI should act as an unobtrusive shadow, not a distracting chat window.
- **Write (`Ctrl+K` / `Ctrl+L`)**: Rewrite or generate the selected text in place, in seconds. `Alt+C` proofreads without needing an instruction at all, and the command palette ships presets for polishing, bullet summaries, and action-item extraction.
- **Ghost Text (the passive form of Write)**: Offline predictive completion powered by your local Ollama, LM Studio, or vLLM instance.
- **Delegate (`{{ instruction }}`)**: Hand an instruction written in the note to an external agent CLI (Claude Code, Codex, Hermes, Antigravity, …). Press `Ctrl+Enter`, or click the **▶ Run** button that appears beside a complete block. It runs in the background, progress shows in the task panel (`Alt+T`), and the result is merged back into the note. Notations and agents are fully customizable in `agents.yaml` (internal name: Slot).
- **Quick Actions (`Ctrl+J`)**: Suggests up to three next steps based on what you are writing, each mapping to Write, Run, or Delegate. Run a card with `Ctrl+1`–`3` (`Cmd+1`–`3` on macOS), or move with `Ctrl+Tab` and confirm with `Enter`. Click the **Action** badge in the status bar to cycle On → Manual → Off. By default it runs on built-in local rules and nothing from your note leaves your machine; only if you enter an API key or a custom endpoint does it send an excerpt of about 2,000 characters around your caret to an external inference model such as Jev (internal names: System 1 / 3-Beam / MAP-Elites).
- **Deterministic AST Guardrail**: Shell commands offered as suggestions are parsed by an AST safety checker before they run, refusing destructive operations such as `rm -rf /` and writes into protected system directories.
- **Transparent Stream Cleaning**: Automatically strips reasoning tokens (e.g., `<think>` tags from DeepSeek models) before they hit the canvas.

### 4. UNIX Pipeline & CLI Automation
Treat your notes as standard output streams.
- **CLI Standard Input (`cat log | md-memo`)**: Pipe terminal output directly into a running MD-Memo instance via local TCP IPC. Transmits instantly or cold-boots the app if closed.
- **Command Bar, CLI mode (`Ctrl+Shift+B`)**: Feed text selections through external utilities (`jq`, `sort`, `tr`, `prettier`, `duckdb`) and replace the buffer instantly.
- **Command Bar, AI CLI mode (`Ctrl+Shift+E`)**: The same bar in AI mode. Describe OS tasks naturally (*"find files modified today"*) and it writes the shell command, runs it through a safety check, and executes it in a background goroutine. Click the badge on the bar to switch modes at any time.

### 5. High-Speed Parallel Scrap Search
- **Zero-Allocation Multithreaded Scan**: Uses `runtime.NumCPU()` worker threads and `bufio.Scanner` to execute parallel, in-memory grep matching across your daily scraps (`scraps/YYYY-MM-DD.md`) in <150ms.
- **Debounced Incremental Search**: 150ms debounce ensures fluid typing, while click-to-jump instantly scrolls to the matched line with an ambient UI highlight.

### 6. Background Git Sync
Keep your plain-text data durable and synchronized across machines.
- **Silent Operations**: Automatically runs `git pull --rebase` on launch and debounces `git add/commit/push` after 30 seconds of idle time.
- **Zero-Conflict Setup**: Simply provide an empty GitHub/GitLab repository URL in the settings to establish a bulletproof, automated cloud backup.

---

## Programmable Control Hub & JSON-RPC 2.0

MD-Memo is fully controllable from external scripts, terminals, Neovim, VS Code, or autonomous AI agents via its built-in JSON-RPC 2.0 TCP server (`127.0.0.1:49152` by default; the port actually in use, and a session token, are written to `ipc-session.json` in the app's config folder).

### CLI Subcommands
`buffer`, `tab` and `ui` commands drive a running MD-Memo; `jev` and `agent` run standalone.

```bash
# 1. Read current active buffer (plain text in a terminal; JSON with a content hash when piped or with --json; --text forces plain text)
md-memo buffer get
md-memo buffer get --json

# 2. Replace buffer atomically with optimistic lock protection
#    (the hash is the first 16 hex characters of the buffer's SHA-256, as returned by `buffer get --json`)
echo "# New Content" | md-memo buffer set --expected-hash a1b2c3d4e5f60718

# 3. Append terminal output to active buffer
echo "- [ ] Next Action Item" | md-memo buffer append

# 4. Selective line/column range replacement
echo "Replaced Text" | md-memo buffer replace --start 2:1 --end 2:15

# 5. Verify shell command safety against the deterministic AST engine (standalone; exit code 1 when blocked)
md-memo jev verify "git status && npm test"
# [SAFE] Command passed AST validation: git status && npm test
md-memo jev verify --json "rm -rf /"
# {"isSafe": false, "reason": "破壊的コマンド \"rm\" は安全基準により実行を拒否されました (Destructive command blocked)",
#  "command": "rm -rf /", "rule": "destructive", "subject": "rm"}

# 6. Extract only the relevant parts of a Markdown file before handing it to an agent (Headless)
md-memo agent prune --query "authentication bug" --file notes.md
```

---

## Quick Start

Distributed as an unbundled, standalone binary with zero installer overhead.

**Requirements**: Windows (x64) with the Microsoft Edge WebView2 Runtime (included with Windows 11), or macOS 10.15 or later. Linux is not supported yet.

### Package Managers

#### Windows
```powershell
winget install youshinh.md-memo
```

#### macOS
```bash
brew install --cask youshinh/tap/md-memo
```

> **macOS first launch**: releases are ad-hoc signed, not notarized by Apple, so Gatekeeper will initially refuse to open `MD-Memo.app`. Either right-click it in Finder and choose **Open** (then confirm), or clear the quarantine flag once: `xattr -dr com.apple.quarantine "MD-Memo.app"`. Starting with the next release, the macOS build is a **universal binary** supporting both Apple Silicon and Intel Macs.

### Standalone Binaries
Zero-installer executables are available directly from the [GitHub Releases](https://github.com/youshinh/md-memo/releases) page.

### No Mac? Get a macOS Build from CI
Every push to this repository builds a ready-to-run `MD-Memo.app` on GitHub-hosted macOS runners — useful if you want to test a change without owning a Mac:
1. Push to GitHub (or open the **Actions** tab and run the **CI** workflow manually via **Run workflow**).
2. Open the latest **CI** run → **Artifacts** → download `md-memo-macos-<commit-sha>`.
3. Unzip it, then follow the same first-launch step above (`xattr -dr com.apple.quarantine "MD-Memo.app"` or right-click → Open) — CI builds are ad-hoc signed the same way release builds are.

---

## Command Palette & Hotkeys

| Action | Windows | macOS |
|---|---|---|
| Global Summon / Hide | `Ctrl + Alt + M` | `Option + Cmd + M` |
| High-speed Scrap Search | `Ctrl + Shift + F` | `Cmd + Shift + F` |
| Command Palette | `Ctrl + Shift + P` | `Cmd + Shift + P` |
| Inline AI Prompt Bar | `Ctrl + K` | `Cmd + K` |
| AI Prompt Modal | `Ctrl + L` | `Cmd + L` |
| AI Proofreading & Correction | `Alt + C` | `Cmd + Shift + C` |
| Suggest Quick Actions | `Ctrl + J` | `Cmd + J` |
| Run a Quick Actions Card | `Ctrl + 1` – `3` | `Cmd + 1` – `3` |
| Command Bar: CLI Mode | `Ctrl + Shift + B` | `Cmd + Shift + B` |
| Command Bar: AI CLI Mode | `Ctrl + Shift + E` | `Cmd + Shift + E` |
| Run Slot with an Agent | `Ctrl + Enter` | `Cmd + Enter` |
| Toggle Task Panel | `Alt + T` | `Option + T` |
| Split Editor Right | `Ctrl + \` | `Cmd + \` |
| Preview to the Side | `Ctrl + Shift + V` | `Cmd + Shift + V` |
| Zen Mode | `Ctrl + Shift + Z` | `Ctrl + Cmd + Z` |
| Accept Ghost Text (Word) | `Ctrl + →` | `Option + →` |
| Insert Date / Time | `F5` | `Cmd + Shift + I` |

*(See complete interactive shortcuts guide in the [Official Manual](https://youshinh.github.io/md-memo/manual.html))*

---

## System Topology

```text
[ Frontend: Monospaced Canvas / Ghost Overlay / Scrap Search UI / Split View ]
                                      ▲
                                      │ Bi-directional RPC Bridge
                                      ▼
[ Core Engine: Go 1.26 / OS Native WebView (WebView2 · WKWebView) ]
       │
       ├─► Programmable JSON-RPC 2.0 TCP Server (127.0.0.1:49152 / ipc-session.json)
       │    ├─► buffer.get / set / append / replace (Optimistic Locking)
       │    ├─► tab.list / switch
       │    └─► ui.toggle_split / activate / eval
       │
       ├─► Jev Autonomous Action Architecture
       │    ├─► System 1 Predictive Action Bar (3-Beam Contextual)
       │    ├─► Deterministic AST Guardrail (ASTCommandVerifier)
       │    └─► MAP-Elites Behavioral Diversity Selector
       │
       ├─► Local & Cloud AI Inference
       │    ├─► Air-gapped Ollama / Gemma 4 E2B One-Click Integration
       │    ├─► Gemini Flash Lite Vision OCR (Clipboard Paste Ctrl+V)
       │    └─► OpenRouter & OpenAI-compatible Endpoints
       │
       ├─► High-Speed Storage & Search
       │    ├─► Daily Scraps Aggregator (scraps/YYYY-MM-DD.md)
       │    ├─► Parallel Grep Engine (runtime.NumCPU() Worker Pool)
       │    └─► Background Git Sync (Silent Rebase & Idle Commit/Push)
       │
       ├─► Autonomous IME Guardian (Lexical Scope Alphanumeric Shield)
       └─► Aggressive Memory Reclaimer (debug.FreeOSMemory() -> 5-15MB idle)
```

---

## Documentation & Manuals

- [Official User Manual (EN)](https://youshinh.github.io/md-memo/manual.html)
- [公式マニュアル・詳細設定ガイド (JA)](https://youshinh.github.io/md-memo/manual_ja.html)

---

## License

Distributed under the [MIT License](LICENSE). Free for personal and commercial use.
