# 📝 MD-Memo

> **Ultra-lightweight, High-speed, AI-Native Markdown & Text Editor for Windows & macOS**  
> Super fast (<0.2s launch), minimal memory footprint (~40MB total, ~3.5MB Go runtime), real-time inline ghost text predictions, context LLM prompting, and one-screen toggle preview with KaTeX & Mermaid.

[![Release](https://img.shields.io/github/v/release/youshinh/md-notepad?style=flat-square)](https://github.com/youshinh/md-notepad/releases)
[![Go Version](https://img.shields.io/github/go-mod/go-version/youshinh/md-notepad?style=flat-square)](https://golang.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

**English Documentation** | [🇯🇵 日本語のドキュメントはこちら (Japanese Documentation)](README_JA.md)

---

## ✨ Key Features

- ⚡ **Ultra-Fast Startup & Minimal Memory**: Launches in <0.2 seconds with a total Working Set footprint of ~40MB (Go engine alone uses ~3.5MB).
- 🌐 **Multilingual (i18n)**: English (Default) and Japanese interface with zero-overhead translation.
- 💡 **Inline Predictive Ghost Text**: Copilot-style real-time completions as you type. Accept seamlessly with <kbd>Tab</kbd> or <kbd>→</kbd>.
  - Works with local offline LLMs (LM Studio, Ollama, vLLM) and cloud APIs (Gemini, OpenAI, Claude).
  - Smart debounce and IME composition handling to prevent premature triggers.
  - Automatic `<think>` tag stripping and multi-line runaway suppression.
- 🤖 **Context LLM Prompt Mode (`Ctrl+L`)**: Send full document or selection to LLM with custom instructions (Translate, Summarize, Refactor, Fix Bugs, etc.) and insert response directly in-place.
- 👁️ **Gemini Vision OCR (`Ctrl+V`)**: Paste any screenshot or image from clipboard and Gemini Vision automatically converts it into structured, faithful Markdown tables and text.
- 🔄 **1-Screen Toggle Preview (`Ctrl+P`)**:
  - GitHub Flavored Markdown (GFM) rendering.
  - KaTeX math support (inline `$..$`, block `$$..$$`).
  - Mermaid diagram rendering (flowcharts, sequence diagrams, gantt charts).
- 📑 **Multi-Tab & Session Persistence**:
  - Temporary auto-save keeps unsaved scratchpads safe.
  - Reopen the app and immediately restore all previous tabs, buffers, and cursor positions (configurable in Settings).
  - Smart 1.5-second debounce autosave for saved files.
- 🔤 **Automatic Encoding Detection**: Preserves and handles UTF-8 and Shift_JIS (CP932) flawlessly.
- 📄 **Export Clean Plain Text (.txt)**: Strips Markdown formatting syntax (`#`, `*`, `[]()`, etc.) into clean plain text.
- 🍏 **Cross-Platform**: Native OS WebView integration on Windows (Edge WebView2) and macOS (WebKit / WKWebView).

---

## 📥 Download & Installation

### 🪟 Windows (x64)
1. Download `md-memo-windows-x64.zip` from the [Releases Page](https://github.com/youshinh/md-notepad/releases).
2. Extract the zip and launch `md-memo.exe` (Standalone portable single binary, no installer needed).

### 🍏 macOS (Apple Silicon / Intel)
1. Download `md-memo-macos.zip` from the [Releases Page](https://github.com/youshinh/md-notepad/releases).
2. Move `MD-Memo.app` to your `/Applications` folder and open it.

---

## ⚙️ LLM API Setup Guide

Click the **"Settings"** button at the top right (or right-click anywhere for Context Menu) to configure your AI providers.  
You can assign different models for Text Generation, Autocomplete, and Vision OCR independently.

### 1. 🌐 Google Gemini (Google AI Studio)
Ultra-fast and low-latency multimodal LLM. Highly recommended for image OCR and autocomplete.

| Setting | Value |
|---|---|
| **API Base URL** | `https://generativelanguage.googleapis.com/v1beta` |
| **Model Name (Recommended)** | `gemini-flash-latest` (fast & smart) / `gemini-flash-lite-latest` (ultra-fast) / `gemini-pro-latest` |
| **API Key** | Get your free API key at [Google AI Studio](https://aistudio.google.com/) |

---

### 2. 🟢 OpenAI (ChatGPT / GPT-4.1 / GPT-4o / o3-mini)
Standard OpenAI API integration.

| Setting | Value |
|---|---|
| **API Base URL** | `https://api.openai.com/v1` |
| **Model Name (Recommended)** | `gpt-4.1-mini` (latest fast) / `gpt-4.1` (flagship) / `gpt-4o-mini` / `o3-mini` (reasoning) |
| **API Key** | Get your API key (`sk-...`) at [OpenAI Platform](https://platform.openai.com/api-keys) |

---

### 3. 🟣 Anthropic Claude (via LiteLLM / Proxy)
Connect Claude via any OpenAI-compatible proxy (LiteLLM, Cloudflare AI Gateway, One-API).

| Setting | Value |
|---|---|
| **API Base URL** | `http://localhost:4000/v1` (Proxy address) |
| **Model Name** | `claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-3-5-haiku` |
| **API Key** | Proxy key or `sk-ant-...` |

---

### 4. 💻 LM Studio (Free & Offline Local LLM)
Start the LM Studio Local Server. Excellent for zero-cost, private autocomplete ghost text.

| Setting | Value |
|---|---|
| **API Base URL** | `http://localhost:1234/v1` (or LAN IP `http://192.168.x.x:1234/v1`) |
| **Model Name** | Loaded model identifier (e.g. `google/gemma-4-12b-qat`, `prism-ml/bonsai-27b`, `qwen2.5-coder-7b-instruct`) |
| **API Key** | Leave empty or `not-needed` |
| **Autocomplete Config** | Delay: `500` ms / Max tokens: `30`-`50` |

---

### 5. 🦙 Ollama (Free Local LLM)
Direct connection to Ollama server.

| Setting | Value |
|---|---|
| **API Base URL** | `http://localhost:11434` or `http://localhost:11434/v1` |
| **Model Name** | `qwen2.5-coder:7b`, `llama3.3:latest`, `deepseek-r1:8b` |
| **API Key** | Leave empty |

---

### 6. 🚀 vLLM / llama-server / Text Generation WebUI
Compatible with any standard OpenAI `/v1/chat/completions` or `/v1/completions` endpoint.

| Setting | Value |
|---|---|
| **API Base URL** | `http://localhost:8000/v1` |
| **Model Name** | Server model identifier |
| **API Key** | As required by your server |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Tab</kbd> / <kbd>→</kbd> | **Accept inline autocomplete suggestion (Ghost Text)** |
| <kbd>Esc</kbd> | Dismiss autocomplete suggestion / Close modal |
| <kbd>Ctrl</kbd> + <kbd>L</kbd> | **Open LLM prompt & instruction modal** |
| <kbd>Ctrl</kbd> + <kbd>Enter</kbd> | Send LLM prompt immediately from modal |
| <kbd>Ctrl</kbd> + <kbd>P</kbd> / <kbd>Ctrl</kbd> + <kbd>E</kbd> | **Toggle Edit ⇄ Preview mode** |
| <kbd>Ctrl</kbd> + <kbd>S</kbd> | Save file (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> for Save As) |
| <kbd>Ctrl</kbd> + <kbd>O</kbd> | Open file (Markdown, JSON, YAML, code files, etc.) |
| <kbd>Ctrl</kbd> + <kbd>N</kbd> / <kbd>Ctrl</kbd> + <kbd>T</kbd> | Create new tab |
| <kbd>Ctrl</kbd> + <kbd>W</kbd> | Close current tab |
| <kbd>Ctrl</kbd> + <kbd>Tab</kbd> | Switch to next tab |
| <kbd>Ctrl</kbd> + <kbd>V</kbd> | Paste (Triggers Gemini Vision OCR automatically on image paste) |
| <kbd>F5</kbd> | Insert current timestamp (`YYYY/MM/DD HH:mm:ss`) |

---

## 🛠️ Build from Source

### Prerequisites
- [Go 1.22+](https://golang.org/dl/)

### 🪟 Build on Windows
```powershell
# Clone repository
git clone https://github.com/youshinh/md-notepad.git
cd md-notepad

# Run tests
go test -v ./...

# Build optimized Windows GUI binary
go build -ldflags="-H windowsgui -s -w" -trimpath -o md-memo.exe .
```

### 🍏 Build on macOS
```bash
# Clone repository
git clone https://github.com/youshinh/md-notepad.git
cd md-notepad

# Run build script to generate MD-Memo.app bundle
chmod +x build_mac.sh
./build_mac.sh

# Launch App
open MD-Memo.app
```

---

## 📐 Architecture

```mermaid
graph TD
    subgraph UI ["Frontend (HTML5 / Vanilla JS / CSS)"]
        Editor["Textarea Editor + Ghost Overlay"]
        Renderer["Markdown-it + KaTeX + Mermaid (Lazy Loaded)"]
        BridgeJS["window.backend RPC Bridge"]
    end

    subgraph Native ["Go Core Engine"]
        WinNative["Windows: Microsoft Edge WebView2"]
        MacNative["macOS: WebKit / WKWebView"]
        FileSys["Encoding Auto-Detect (UTF-8 / Shift_JIS)"]
        MemoryMgr["Idle RAM Reclaimer (debug.FreeOSMemory)"]
    end

    subgraph AI ["AI Engine (pkg/llm)"]
        LocalLLM["Local LLMs (LM Studio / Ollama / vLLM)"]
        CloudLLM["Cloud LLMs (Gemini / OpenAI / Claude)"]
    end

    Editor <--> BridgeJS
    Renderer <--> BridgeJS
    BridgeJS <--> WinNative
    BridgeJS <--> MacNative
    WinNative <--> FileSys
    MacNative <--> FileSys
    WinNative <--> AI
    MacNative <--> AI
    AI <--> LocalLLM
    AI <--> CloudLLM
```

---

## 📜 License

Distributed under the [MIT License](LICENSE). Free for both personal and commercial use.
