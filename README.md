# MD-Memo

> A zero-latency, local-first Markdown scratchpad engineered for instant capture.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/github/go-mod/go-version/youshinh/md-memo)](https://golang.org/)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey)](#quick-start)

**MD-Memo** is a high-bandwidth capture instrument that sits quietly in your system tray. Built with a compiled Go core and OS-native webviews, it wakes in milliseconds, manages multilingual IME states autonomously, and vanishes when you're done.

[Releases](https://github.com/youshinh/md-memo/releases) • [The Scratchpad Paradox](#the-scratchpad-paradox) • [Architecture & Capabilities](#architecture--capabilities) • [Quick Start](#quick-start) • [Command Palette & Hotkeys](#command-palette--hotkeys) • [日本語ドキュメント (JA)](README_JA.md)

---

## Visual Showcase

| Live Split View & Mermaid Diagrams (`Ctrl+\`) | Command & Navigation Palette (`Ctrl+Shift+P`) |
|:---:|:---:|
| ![Live Split View](img/screen_diagram.png) | ![Command Palette](img/screen_palette.png) |

| In-Place AI Prompt Bar (`Ctrl+K`) | Air-Gapped LLM & Theme Settings |
|:---:|:---:|
| ![Inline Prompt Bar](img/screen_prompt.png) | ![Settings](img/setting.png) |

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
| **File Dialogs** | OS Native | Node.js IPC wrapper | **COM `IFileDialog` / Cocoa Native** |

> **Workflow Tip**: Point MD-Memo directly at your Obsidian Vault, Git repository, or daily log directory to use it as an instant-entry terminal.

---

## Architecture & Capabilities

### 1. Minimal Footprint & Sub-Millisecond Wake
Built to run 24/7 without taxing your system.
- **Instant Summon (`Ctrl+Alt+M` / `Option+Cmd+M`)**: Bypasses heavy rendering pipelines to wake instantly from the system tray with your cursor exactly where you left it.
- **Aggressive Idle Reclamation**: Leverages `debug.FreeOSMemory()` to compress the active working set down to 5–15 MB when the window is minimized or idle.
- **Native OS Dialogs**: Direct integration with Windows COM and macOS Cocoa panels ensures file operations remain native and instantaneous.

### 2. Autonomous IME Shield
Technical writing in CJK (Chinese/Japanese/Korean) environments often suffers from IME mode-switching friction. MD-Memo handles this algorithmically:
- **Lexical Scope Protection**: Inside inline code (`` `...` ``), code blocks, and URLs, the editor intercepts full-width characters and forces alphanumeric mode with negligible overhead (~11 µs per keystroke).
- **Phonological Auto-Correction**: Detects Romaji cadence typed in direct input mode and can silently convert it into composition.
- **Powered by LLRT**: Computational linguistics via Log-Likelihood Ratio Testing ensures your typing speed is never compromised.

### 3. Local-First AI Integration
AI should act as an unobtrusive shadow, not a distracting chat window.
- **Air-Gapped Ghost Text**: Offline predictive completion powered by your local Ollama, LM Studio, or vLLM instance.
- **Transparent Stream Cleaning**: Automatically strips reasoning tokens (e.g., `<think>` tags from DeepSeek models) before they hit the canvas.
- **One-Click Local Setup**: Native integration to pull and configure lightweight models (like Gemma 4 E2B) directly from the settings panel.

### 4. UNIX Pipeline & CLI Automation
Treat your notes as standard output streams.
- **CLI Standard Input (`cat log | md-memo`)**: Pipe terminal output directly into a running MD-Memo instance via local TCP IPC. Transmits instantly or cold-boots the app if closed.
- **In-Editor CLI Agent (`Ctrl+Shift+E`)**: Describe OS tasks naturally (*"find files modified today"*). The agent generates the shell command, validates it against a built-in AST/regex safety engine (blocking destructive commands like `rm -rf /`), and executes it in a background goroutine.
- **External CLI Filters (`Ctrl+Shift+B`)**: Feed text selections through external utilities (`jq`, `sort`, `prettier`) and replace the buffer instantly.

### 5. High-Speed Parallel Scrap Search
- **Zero-Allocation Multithreaded Scan**: Uses `runtime.NumCPU()` worker threads and `bufio.Scanner` to execute parallel, in-memory grep matching across your daily scraps (`scraps/YYYY-MM-DD.md`).
- **Debounced Incremental Search**: 150ms debounce ensures fluid typing, while click-to-jump instantly scrolls to the matched line with an ambient UI highlight.

### 6. Background Git Sync
Keep your plain-text data durable and synchronized across machines.
- **Silent Operations**: Automatically runs `git pull --rebase` on launch and debounces `git add/commit/push` after 30 seconds of idle time.
- **Zero-Conflict Setup**: Simply provide an empty GitHub/GitLab repository URL in the settings to establish a bulletproof, automated cloud backup.

---

## Quick Start

Distributed as an unbundled, standalone binary with zero installer overhead.

### Package Managers

#### Windows
```powershell
winget install youshinh.md-memo
```

#### macOS
```bash
brew install --cask youshinh/tap/md-memo
```

### Standalone Binaries
Zero-installer executables are available directly from the [GitHub Releases](https://github.com/youshinh/md-memo/releases) page.

---

## Command Palette & Hotkeys

| Action | Windows / Linux | macOS |
|---|---|---|
| Global Summon / Hide | `Ctrl + Alt + M` | `Option + Cmd + M` |
| High-speed Scrap Search | `Ctrl + Shift + F` | `Cmd + Shift + F` |
| Accept Ghost Text (Word) | `Ctrl + →` | `Option + →` |
| AI CLI Agent | `Ctrl + Shift + E` | `Cmd + Shift + E` |
| CLI Pipeline Filter | `Ctrl + Shift + B` | `Cmd + Shift + B` |
| Split Editor Right | `Ctrl + \` | `Cmd + \` |
| Line Operations | `Alt + ↑` / `↓` | `Option + ↑` / `↓` |

*(See full shortcut list in the application via `Ctrl+Shift+P`)*

---

## System Topology

```text
[ Frontend: Monospaced Canvas / Ghost Overlay / Scrap Search UI ]
                               ▲
                               │ Bi-directional RPC Bridge (Wails)
                               ▼
[ Core Engine: Go 1.26 / OS Native WebView / Native Dialogs ]
       │
       ├─► CLI Pipe & TCP IPC (127.0.0.1:49152)
       ├─► Local LLM Engine (Ollama / vLLM)
       ├─► Daily Scrap Aggregator (scraps/YYYY-MM-DD.md)
       ├─► Cloud Inference (Gemini / Claude)
       ├─► Parallel Grep Engine (runtime.NumCPU())
       ├─► Background Git Sync
       ├─► Direct File IO (UTF-8 / Shift_JIS)
       ├─► Loopback Media Engine
       └─► Memory Reclaimer (Aggressive GC)
```

---

## License

Distributed under the [MIT License](LICENSE). Free for personal and commercial use.
