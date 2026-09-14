# MD-Memo

> **The zero-latency Markdown scratchpad for thoughts that move faster than heavy runtimes.**  
> Instant recall (0.01s), 100% local POSIX files, an autonomous IME Guardian for polyglot writing, and air-gapped local AI.

[Releases](https://github.com/youshinh/md-memo/releases) • [Why MD-Memo?](#the-friction-we-eliminate) • [Workflow Pairing](#where-md-memo-fits-in-your-workflow) • [Superpowers](#superpowers) • [Quick Start](#quick-start) • [Shortcuts](#command-palette--shortcuts) • [Core Tenets](#core-tenets) • [日本語ドキュメント (JA)](README_JA.md)

---

## Visual Showcase

| Live Split View & Mermaid 11 Diagrams (`Ctrl+\`) | Command & Navigation Palette (`Ctrl+Shift+P`) |
|:---:|:---:|
| ![Live Split View](img/screen_diagram.png) | ![Command Palette](img/screen_palette.png) |

| In-Place AI Prompt Bar (`Ctrl+K`) | Air-Gapped LLM & Theme Settings |
|:---:|:---:|
| ![Inline Prompt Bar](img/screen_prompt.png) | ![Settings](img/setting.png) |

---

## The Friction We Eliminate

Modern knowledge tools (Obsidian, Notion, VS Code) are extraordinary databases, but terrible scratchpads.

When inspiration strikes or you need to jot down an ephemeral bug note:
- **You wait 2–5 seconds** for an Electron runtime and dozens of plugins to initialize—and the fleeting thought evaporates.
- **You fight the IME**: Typing in alphanumeric mode produces `konnichiha`, or opening a code fence corrupts your code with full-width characters (`ｃｏｎｓｔ　ｘ　＝`).
- **You sacrifice privacy**: Autocomplete requires piping your uncommitted thoughts and proprietary code to third-party cloud APIs.

**MD-Memo is engineered to sit quietly between biological thought and your filesystem.** It is not a destination wiki; it is a high-bandwidth capture instrument that wakes in 10ms, consumes virtually zero idle RAM, and disappears the moment you are done.

---

## Key Metrics

| Dimension | Specification | Reference Standard |
|---|---|---|
| Engine Architecture | Compiled Go 1.26 + Native OS WebView | Edge WebView2 (Win) / WebKit (macOS) / WebKitGTK (Linux) |
| Reopen Latency | **0.01 seconds** | System tray resident state |
| Cold Startup | **< 0.10 seconds** | From process invocation |
| Memory Footprint | **~40 MB active / 5–15 MB idle** | Automated idle memory reclamation (`debug.FreeOSMemory`) |
| Native Dialogs | **Sub-millisecond** direct invocation | Windows COM `IFileDialog` / macOS native Cocoa panels |
| Data Storage | **100% Local POSIX plain text** | Pure `.md` / `.txt` files directly on your filesystem |
| Platform Support | Windows 10/11 (x64), macOS, Linux | OS-native frame, dark mode & tray integration |

---

## Where MD-Memo Fits in Your Workflow

MD-Memo does not compete with your permanent storage or knowledge base—it supercharges them by eliminating entry friction.

| Dimension | Notepad / TextEdit | Electron Vault (Obsidian) | MD-Memo |
|---|---|---|---|
| **Summon / Wake** | Cold launch only (~0.1s) | Heavy (2.0s – 5.0s) | **Instant (0.01s Tray / <0.1s Cold)** |
| **Idle Memory** | ~15 MB | 400 MB – 800 MB+ | **5 – 15 MB (active ~40 MB)** |
| **Storage Model** | Plain text | Local Vault / Internal DB | **100% Native POSIX Plain Text** |
| **File Dialogs** | C++ Win32 | Node.js IPC wrapper | **Windows COM `IFileDialog` / Cocoa** |
| **IME State Friction** | Manual toggle required | Manual toggle required | **Autonomous 4-Layer Shield (0 ns overhead)** |
| **Inline Copilot** | None | Plugin-dependent (Cloud APIs) | **Native Local LLM (Air-Gapped Ollama / LM Studio)** |
| **Visual Structure** | Plain text only | Heavy plugin stack | **Built-in Mermaid 11 & Vision OCR** |
| **Automation** | None | Community plugin / Shell exec | **AI CLI Agent & Unix Pipe Ecosystem** |
| **Focus Environment**| Static text field | Complex multi-pane UI | **Minimalist canvas with subtle Cursor Aura** |

> [!TIP]
> **Ideal Pairing**: Use MD-Memo as your always-on, instant-capture scratchpad pointed directly at your Obsidian Vault, log directory, or Git repository.

---

## Superpowers

### 1. 0.01s Instant Wake & 5 MB Idle Footprint
Built with a compiled Go core (~3.5 MB runtime) and OS-native webviews (WebView2 / WebKit), completely bypassing embedded Chromium and Node.js.
- **Global Summon (`Ctrl+Alt+M` / `Option+Cmd+M`)**: Wakes instantly from the system tray with your cursor positioned and buffer intact.
- **Aggressive Idle Reclamation**: Automatically compresses working set memory down to 5–15 MB when idle or minimized (`debug.FreeOSMemory`). Keep it running 24/7 without feeling it.
- **Native OS Dialogs**: Uses direct Windows COM `IFileDialog` and macOS Cocoa panels for sub-millisecond file interactions.

### 2. The 4-Layer IME Guardian (World-First)
Eliminates the persistent friction of technical writing in multilingual environments (Japanese & English):
- **Autonomous Script Inversion**: Started typing Romaji in direct input mode? The phonological classifier detects the consonant-vowel cadence within 3 keystrokes and silently converts it into Japanese composition.
- **Lexical Scope Shield**: Inside inline code (`` `...` ``), fenced code blocks (```...```), and URLs, IME and full-width character conversions are intercepted at 0 ns overhead. Identifiers like `interface`, `component`, or `const` are never contaminated.
- **Instant AI Typo Fix (`Alt+C` / `Option+C`)**: Fixes mistyped words, malformed query strings, and transposed kana-kanji conversions on the fly.
- **Microsecond Execution**: Built on computational linguistics Log-Likelihood Ratio Testing (LLRT). Runs in ~11 µs per keystroke with a ~35 KB static footprint—perceptible typing lag is physically zero.

### 3. Air-Gapped Ambient Copilot (Ghost Text)
AI that acts like an unobtrusive shadow, not a distracting chatbot:
- **Local Predictive Completion**: Inline grey ghost text powered entirely offline via Ollama, LM Studio, or vLLM. Accept the full completion with `Tab`, or accept word-by-word with `Ctrl+→` (`Option+→` on macOS).
- **One-Click Gemma 4 Setup**: Press "Gemma 4 Setup" in Settings (`Ctrl+,`) to automatically install Ollama, pull Google's edge-optimized Gemma 4 E2B model (~2.3B parameters), and configure local endpoints without opening a terminal. Includes automatic memory release when idle.
- **Reasoning Stream Cleaner**: Transparently strips reasoning clutter (such as `<think>...</think>` tokens from DeepSeek-R1) in real time so your canvas stays clean.
- **Subtle Cursor Aura**: When you pause typing to reflect, a soft ambient glow radiates around the caret, anchoring your focus without breaking cognitive momentum.

### 4. Multimodal & Visual Capture
- **Screenshot to Markdown Table (`Ctrl+V` / `Cmd+V`)**: Copy any screenshot of documentation, spreadsheets, or logs—pasting it invokes Vision OCR to structure it into clean GitHub-Flavored Markdown tables.
- **Text to Diagram**: Turn unstructured bullet points into live Mermaid 11 flowcharts, sequence diagrams, and timelines instantly.
- **Local Loopback Media**: Smoothly preview local images via an internal loopback streaming endpoint (`/api/image`).

> [!TIP]
> **Free 1-Minute Gemini API Setup**:
> The Gemini API for Vision OCR, image generation, and cloud autocomplete offers a **generous free tier with no credit card required**.
> 1. Visit [Google AI Studio (API Keys)](https://aistudio.google.com/app/apikey) and sign in with your Google account.
> 2. Click **"Create API key"** (accessible directly via the **"Get API key ↗"** button in Settings).
> 3. Paste the key into Settings (`Ctrl+,`) → **Image** tab to unlock instant multimodal capture.

### 5. AI CLI Agent & Unix Pipe Ecosystem
Uncompromising editing speed coupled with Unix pipelines and AI automation:
- **AI CLI Agent (`Ctrl+Shift+E` / `Cmd+Shift+E`)**: Describe tasks in natural language (e.g. *"ping 128.0.0.1 to 10 and summarize results"*, *"find all files modified in the last 24h"*). The local or cloud LLM generates the native OS command (`powershell` / `bash`), displays it in the bar for review, and executes it in the background with stdout captured directly into your note upon pressing `Enter`.
  - **Context-Aware Metadata Injection**: Automatically injects local environment variables—including the active note's full path, parent directory, filename, and app root—allowing natural commands like *"backup this file"* or *"list images in this folder"* to resolve exact paths seamlessly.
  - **Multi-Tier Security Validation**: Built-in AST/regex safety engine blocks catastrophic commands (e.g. drive formatting, `rm -rf /`, fork bombs, registry wipes) unconditionally (`BLOCKED`). Warns and prompts explicit confirmation for recursive file deletions and system shutdown operations (`⚠️ WARN`).
- **CLI Pipeline Filter (`Ctrl+Shift+B` / `Cmd+Shift+B`)**: Feed selection or whole notes into external CLI utilities (`sort`, `uniq`, `jq`, `tr`, `prettier`, `duckdb`, `sqlite3`, `psql`) via standard input, instantly replacing target text with stdout.
  - **Zero UI Freezing**: Background goroutine execution guarantees zero main-thread hitching even during long operations.
  - **Instant Cancellation**: Pressing `Escape` immediately terminates the entire child process tree (Windows `taskkill /T /F` integration).
  - **Snippet & History Autocomplete**: Native `<datalist>` autocomplete with common utility and SQL presets plus adaptive history learning.

### 6. Fluid Editing & Split Canvas
- **Side-by-Side Dual Pane (`Ctrl+\` / `Cmd+\`)**: Split the editor to work on two notes in parallel with draggable split-bar resizing.
- **Synchronized Live Preview (`Ctrl+Shift+V` / `Cmd+Shift+V`)**: Open live preview to the side with bidirectional scroll synchronization.
- **Home-Row Line Operations**: Effortlessly swap, duplicate, delete, and insert lines without taking fingers off home row (`Alt+↑/↓`, `Shift+Alt+↑/↓`, `Ctrl+Shift+K`, `Ctrl+Enter`).
- **Complete Settings Portability**: Full configuration export and import as clean indented JSON via native OS file dialogs in Settings (`Ctrl+,`).

---

## Quick Start

Distributed as an unbundled, standalone binary with zero installer overhead, or managed through native package managers.

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
Zero-installer, single-file executables (`.zip` / `.app`) are available directly from the [GitHub Releases](https://github.com/youshinh/md-memo/releases) page.

---

## Command Palette & Shortcuts

| Windows / Linux | macOS | Action |
|---|---|---|
| `Ctrl + Alt + M` | `Option + Cmd + M` | **Global Summon / Hide MD-Memo from anywhere** |
| `Ctrl + Shift + Z` | `Cmd + Shift + Z` | Pin Window (Always-on-Top toggle) |
| `F11` | `F11` | Distraction-free fullscreen mode |
| `Tab` / `→` | `Tab` / `→` | Accept full predictive ghost text |
| `Ctrl + →` | `Option + →` | Accept predictive suggestion word-by-word |
| `Alt + C` | `Option + C` | Instant AI typo & conversion correction |
| `Ctrl + K` | `Cmd + K` | In-place selection AI transformation prompt bar |
| `Ctrl + L` | `Cmd + L` | Document-level AI instruction modal |
| `Ctrl + Shift + E` | `Cmd + Shift + E` | **AI CLI Agent (Natural language to shell command execution)** |
| `Ctrl + Shift + B` | `Cmd + Shift + B` | External CLI pipeline filter (Context menu / Instant cancel) |
| `Alt + ↑` / `↓` | `Option + ↑` / `↓` | **Move line up / down (Supports multi-line selection)** |
| `Shift + Alt + ↑` / `↓` | `Shift + Option + ↑` / `↓` | **Duplicate line up / down** |
| `Ctrl + Shift + K` | `Cmd + Shift + K` | **Delete entire line** |
| `Ctrl + Enter` | `Cmd + Enter` | **Insert line below (without moving cursor to end)** |
| `Ctrl + Shift + Enter` | `Cmd + Shift + Enter` | **Insert line above** |
| `Ctrl + \` | `Cmd + \` | **Split Editor Right (Parallel editing / Draggable resize)** |
| `Ctrl + Shift + V` / `Ctrl + K V` | `Cmd + Shift + V` / `Cmd + K V` | Open Preview to the Side (Smart bidirectional scroll sync) |
| `Ctrl + 1` / `2` | `Cmd + 1` / `2` | Switch focus between Left (Primary) and Right (Secondary) panes |
| `Ctrl + P` | `Cmd + P` | Toggle in-pane document preview |
| `Ctrl + Shift + P` | `Cmd + Shift + P` | Command and navigation palette |
| `Ctrl + V` | `Cmd + V` | Standard paste / Automated screenshot-to-table OCR |
| `Ctrl + Tab` | `Control + Tab` | Cycle active buffers (Drag tabs to reorder) |
| `Ctrl + F` / `H` | `Cmd + F` / `H` | Monospaced search / Regular expression replace |

---

## System Topology

```
[ Frontend: Monospaced Textarea / Ghost Overlay / Cursor Aura / Markdown AST ]
                                       ▲
                                       │ Bi-directional RPC Bridge (Wails v2)
                                       ▼
[ Core Engine: Go 1.26 (~3.5 MB) / OS Native WebView / Windows COM IFileDialog ]
       │                                                      │
       ├─► Direct File IO (UTF-8 / Shift_JIS)                 ├─► Local Offline LLM (Ollama / LM Studio)
       ├─► Loopback Media Engine (/api/image)                 └─► Upstream Engine (Gemini / Claude / OpenAI)
       └─► Memory Reclaimer (5–15 MB idle)
```

---

## Core Tenets

1. **The Tool Must Disappear**: Software should never demand attention for its own existence. Visual clutter, latency, and unnecessary animations are treated as defects.
2. **Absolute Data Sovereignty**: Your thoughts belong to you. Files remain clean, durable plain text on your filesystem—openable 50 years from now by standard POSIX utilities.
3. **Speed is Respect**: Forcing a writer to wait 3 seconds to capture an idea does not respect human thought. Every architectural decision in MD-Memo serves the velocity of thinking.

---

## License

Distributed under the [MIT License](LICENSE). Free for personal and commercial use.
