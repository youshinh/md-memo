# MD-Memo

An ultra-lightweight, native Markdown instrument engineered for the velocity of thought.
Built with compiled Go and platform-native web engines. Zero runtime latency, minimal memory footprint, and uncompromising data sovereignty.

[Releases](https://github.com/youshinh/md-memo/releases) / [Documentation (JA)](README_JA.md) / [MIT License](LICENSE)

---

## The Tension

Most writing environments force a false dichotomy: capability or immediacy.

Modern knowledge bases are versatile, but their heavy web runtimes introduce noticeable latency, multi-hundred-megabyte memory footprints, and constant context friction. Traditional scratchpads launch instantly, but lack the structural primitives required for modern engineering and research: ambient autocomplete, semantic script normalization, and dynamic visualization.

MD-Memo resolves this tension. It pairs compiled system performance with a distraction-free writing surface—acting not as a destination database, but as a transparent, high-bandwidth instrument between biological thought and local storage.

---

## Key Metrics

| Dimension | Specification | Reference Standard |
|---|---|---|
| Engine Architecture | Compiled Go 1.26 + Native OS WebView | Edge WebView2 (Win) / WebKit (macOS) / WebKitGTK (Linux) |
| Reopen Latency | 0.01 seconds | System tray resident state |
| Cold Startup | < 0.10 seconds | From process invocation |
| Memory Footprint | ~40 MB active / 5–15 MB idle | Automated idle memory reclamation (`debug.FreeOSMemory`) |
| Native Dialogs | Sub-millisecond direct invocation | Windows COM `IFileDialog` / macOS native Cocoa panels |
| Data Storage | 100% Local POSIX plain text | Pure `.md` / `.txt` files on your filesystem |

---

## Interface Contrast

| Attribute | Legacy Scratchpad (Notepad) | Electron Knowledge Base (Obsidian) | MD-Memo |
|---|---|---|---|
| Startup / Restore | Instant (< 0.1s) | Latent (2.0s – 5.0s) | Instantaneous (0.01s Tray / < 0.1s Cold) |
| Working Set RAM | ~15 MB | 400 MB – 800 MB (Electron) | ~40 MB (compresses to 5–15 MB idle) |
| Native File Dialogs | C++ Win32 | Node.js IPC | Direct Windows COM `IFileDialog` / Cocoa |
| IME State Friction | Manual toggle required | Manual toggle required | Autonomous 4-Layer phonological normalization |
| Offline Intelligence | None | Third-party plugin dependencies | Native inline ghost text (Ollama / LM Studio) |
| Visual Structure | Plain text only | Plugin / Webview layer | Live Mermaid 11, KaTeX Math & Vision OCR |
| Focus Environment | Static text field | Complex multi-pane UI | Minimalist canvas with subtle Cursor Aura |

---

## Pillars of Craft

### 1. Zero-Latency Native Execution
MD-Memo pairs a compiled Go core (~3.5 MB runtime) directly with your operating system's native webview. By eliminating the embedded Chromium/Node.js stack:
- **Instantaneous Recall**: Waking the app from the system tray restores your buffers in 10 milliseconds with your cursor ready to write.
- **Native COM Integration**: File open/save operations bypass external script wrappers entirely, utilizing Windows COM `IFileDialog` interfaces for instantaneous directory navigation.
- **Dynamic Memory Reclaiming**: When minimized or idle, an active memory manager compresses working set RAM down to 5–15 MB, making persistent residency virtually cost-free.

### 2. The 4-Layer IME Guardian
The perpetual friction of Japanese-English technical writing—typing Romaji in direct alphanumeric mode or corrupting code with full-width characters—is resolved at the system boundary:
- **Autonomous Script Inversion**: If you begin typing Romaji in alphanumeric mode, an inline phonological classifier recognizes the syllable rhythm within three keystrokes and seamlessly transitions into Japanese composition.
- **Lexical Scope Shield**: Code fences (```), inline backticks (`...`), and URI schemes are strictly isolated at 0 ns overhead. Identifiers like `interface`, `component`, or `const` are never corrupted.
- **Instant AI Typo Fix (Alt+C)**: Corrects mistyped query strings or transposed kana-kanji conversions on the fly.

### 3. Ambient Intelligence & Sensory Focus
Intelligence in a text editor should behave like a quiet shadow, not an intrusive conversationalist:
- **Air-Gapped Copilot (Ghost Text)**: Predictive suggestions appear inline as subtle grey text. Accept completely with Tab, or incrementally word-by-word with Ctrl+→ (Option+→ on macOS). Powered 100% locally via Ollama, LM Studio, or vLLM with zero network dependency.
- **Subtle Cursor Aura**: When your typing pauses, a soft ambient glow gently emanates from the caret, anchoring your peripheral vision to your exact line of thought without breaking cognitive flow.
- **Reasoning Suppression**: Reasoning artifacts such as <think> tokens from DeepSeek-R1 models are automatically filtered in real time.

### 4. Multimodal Structural Capture
- **Image to Markdown Table (Ctrl+V)**: Pasting a screenshot of tabular data or documentation invokes Gemini Vision to extract and structure it into clean, editable GitHub-Flavored Markdown tables.
- **Text to Diagram**: Select unstructured bullet points and render crisp Mermaid 11 flowcharts, sequence diagrams, and timelines, with one-click vector infographic generation.
- **Local Media Streaming**: Local images are rendered smoothly in preview mode through an internal loopback streaming endpoint (/api/image).

---

## Quick Installation

Distributed as an unbundled, standalone binary with zero installer overhead, or managed through native package managers.

### Windows
```powershell
winget install youshinh.md-memo
```

### macOS
```bash
brew install --cask youshinh/tap/md-memo
```

Portable, zero-install single binaries (.zip / .app) are available directly from [Releases](https://github.com/youshinh/md-memo/releases).

---

## Command Protocols

| Windows / Linux | macOS | Function |
|---|---|---|
| Ctrl + Alt + M | Option + Cmd + M | Global Hotkey: Summon / Restore MD-Memo from anywhere |
| Ctrl + Shift + Z | Cmd + Shift + Z | Toggle Pin Window (Always-on-Top) |
| F11 | F11 | Toggle Distraction-Free Fullscreen |
| Tab / → | Tab / → | Accept full predictive ghost text |
| Ctrl + → | Option + → | Accept predictive suggestion word-by-word |
| Alt + C | Option + C | Instant AI typo and input correction |
| Ctrl + K | Cmd + K | In-place selection AI prompt bar |
| Ctrl + L | Cmd + L | Document-level instruction modal |
| Ctrl + &#92; | Cmd + &#92; | Toggle bidirectional live preview split |
| Ctrl + P | Cmd + P | Toggle full document preview |
| Ctrl + Shift + P | Cmd + Shift + P | Command and navigation palette |
| Ctrl + V | Cmd + V | Standard paste / Automated image-to-table OCR |
| Ctrl + Tab | Control + Tab | Traverse active buffers (Drag tabs to reorder) |
| Ctrl + F / H | Cmd + F / H | Monospaced search / Regular expression replace |

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

## Philosophy

1. **The Tool Must Disappear**: Software should never demand attention for its own existence. Visual clutter, latency, and unnecessary animations are treated as defects.
2. **Absolute Data Sovereignty**: Your thoughts belong to you. Files remain clean, durable plain text on your filesystem—openable 50 years from now by any standard POSIX tool.
3. **Speed is Respect**: A tool that makes a writer wait 3 seconds for a thought to be recorded does not respect the human mind. Every architectural decision in MD-Memo serves the velocity of thought.

---

## License

Distributed under the [MIT License](LICENSE). Free for personal and commercial use.
