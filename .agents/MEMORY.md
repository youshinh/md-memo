# Project Memory & Architecture Context (MD-Memo)

## 1. Project Overview & Binary Specifications
- **App Name**: `MD-Memo` (Executable: `md-memo.exe` on Windows, `MD-Memo.app` on macOS).
- **Module Path**: `md-memo` in `go.mod` (must NOT be `mdnotepad`).
- **Subsystem / Console Behavior on Windows**:
  - Windows executable must ALWAYS be built with `-ldflags="-H windowsgui -s -w"` to suppress the background console (Command Prompt) window.
  - Standard command: `go build -ldflags="-H windowsgui -s -w" -trimpath -o md-memo.exe .` or `.\build_windows.ps1`.

## 2. Multi-Pane & UI Architecture Invariants
- **Active Pane & Editor Routing**:
  - The frontend dynamically operates two panes: Primary (`editorEl`) and Secondary (`editorSecondary`).
  - Always use `getActiveEditor()` to retrieve the currently focused textarea.
  - Always use `getActiveTab()` to retrieve the active tab/file object for operations (e.g. `Ctrl+S`, LLM insertion, inline prompts, character counts, status bar).
  - DOM elements tied to cursor position (like `#cursor-aura`) must be dynamically moved into the parent wrapper (`#secondary-editor-wrapper` vs `#editor-wrapper`) of the active editor.
- **Unsaved Tab Close Confirmation**:
  - Unsaved modifications prompt a 3-choice modal (`Save` / `Don't Save` / `Cancel`).
  - Shortcut keys: `S`/`Enter` = Save, `D`/`N` = Don't Save (Discard), `Esc` = Cancel.
- **IME Guardian & Phonological Conversion**:
  - Automatic Romaji-to-Japanese conversion works via syllable rhythm triggers.
  - Windows IME toggle utilizes `VK_IME_ON` (0x16) key events via `procKeybdEvent`.

## 3. CLI, Shell & Caching Protocols
- **Local HTTP Asset Caching (WebView2)**:
  - `main.go` file server must always send `Cache-Control: no-cache, no-store, must-revalidate` for embedded frontend assets.
  - Scripts in `index.html` must increment cache query parameters (e.g. `?v=1.5.4`) upon major frontend additions.
- **Defensive i18n Text Application**:
  - `applyLanguage()` guards against missing keys by never overwriting HTML defaults with raw key strings (`val !== key`).
- **ANSI Escape Code Stripping**:
  - Shell commands in `app.go` run with `$PSStyle.OutputRendering = 'PlainText'`, `$env:NO_COLOR = '1'`, and Go-level regex stripping (`stripAnsi`) so terminal formatting codes (`[32;1m`, `[44;1m`) never leak into Markdown tabs.
- **AI CLI Generator Prompt & Cleaner**:
  - System prompt in `cli_ai.go` strictly bans standalone shell identifiers (`powershell`, `bash`).
  - Cleaner removes any leading shell labels before commands are passed to single-line input controls.

