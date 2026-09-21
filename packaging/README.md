# MD-Memo Distribution & Packaging

This directory contains package manager manifests and recipes to distribute **MD-Memo** via **Windows Package Manager (WinGet)** and **Homebrew (macOS Tap)**.

---

## 📦 Package Summary

| Target | Manager | Type | Manifest File | Binary / Archive URL | SHA256 Hash |
|---|---|---|---|---|---|
| **Windows (x64)** | WinGet | Portable Zip (`.exe`) | `packaging/winget/youshinh.md-memo.yaml` | `https://github.com/youshinh/md-memo/releases/download/v1.6.0/md-memo-windows-x64.zip` | `81D06EBACE72AE58D53DF9DA8E0548B881E6684D2C62196CA672E1D896EBE020` |
| **macOS (Intel/ARM)** | Homebrew | Cask (`.app`) | `packaging/homebrew/md-memo.rb` | `https://github.com/youshinh/md-memo/releases/download/v1.6.0/md-memo-macos.zip` | `3357f6147c7eb288b9c426c5b62be4f3e7aaf64fbe6be231d358dabcb1092bfb` |

> **Status (2026-09-22):** the Homebrew tap `youshinh/homebrew-tap` is live. The WinGet package is **not published yet**: `microsoft/winget-pkgs` has no `youshinh.md-memo` entry, so the README, the manuals and the landing page point Windows users at the release zip instead.

---

## 🪟 Windows: WinGet

### 1. Local Validation
Verify the manifest syntax against the WinGet schema:

```powershell
winget validate packaging/winget/youshinh.md-memo.yaml
```

### 2. Local Installation Testing
Test installing MD-Memo locally from the manifest file:

```powershell
winget install --manifest packaging/winget/youshinh.md-memo.yaml
```

To test uninstalling:

```powershell
winget uninstall youshinh.md-memo
```

### 3. Publishing to `microsoft/winget-pkgs`

#### Option A: Using `wingetcreate` (Automated CLI)
1. Install `wingetcreate`:
   ```powershell
   winget install Microsoft.WingetCreate
   ```
2. Submit new release or update:
   ```powershell
   wingetcreate submit --urls https://github.com/youshinh/md-memo/releases/download/v1.0.0/md-memo-windows-x64.zip --token <YOUR_GITHUB_PAT>
   ```

#### Option B: Manual GitHub Pull Request
1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).
2. Place the manifest in:
   `manifests/y/youshinh/md-memo/1.0.0/youshinh.md-memo.yaml`
3. Commit and open a Pull Request.

---

## 🍏 macOS: Homebrew Tap (Cask)

The Cask installs `MD-Memo.app` directly into `/Applications` and symlinks
its `md-memo` CLI binary (`MD-Memo.app/Contents/MacOS/MD-Memo`) onto `PATH`,
so `cat log | md-memo` and the `md-memo buffer/tab/ui/jev/agent` subcommands
work the same as on Windows/Linux.

The released app bundle is ad-hoc signed (not notarized), so on first launch
Gatekeeper will refuse to open it; the cask's `caveats` block tells users what to
do (macOS 15 or later: System Settings → Privacy & Security → Open Anyway; macOS 14
or earlier: right-click → Open) or to run `xattr -dr com.apple.quarantine
"$(brew --prefix)/Caskroom/md-memo/*/MD-Memo.app"` once.

### 1. Local Testing (macOS)
To test installing the cask locally without publishing to a tap:

```bash
brew install --cask ./packaging/homebrew/md-memo.rb
```

To audit style and syntax:

```bash
brew audit --cask ./packaging/homebrew/md-memo.rb
```

To test uninstallation:

```bash
brew uninstall --cask md-memo
```

### 2. The Homebrew Tap (`youshinh/homebrew-tap`)
1. The public repository `youshinh/homebrew-tap` exists and holds `Casks/md-memo.rb`, a copy of `packaging/homebrew/md-memo.rb`.
2. After every release, copy the updated `packaging/homebrew/md-memo.rb` (new `version` and `sha256`) into `Casks/md-memo.rb` there and push. Homebrew reads the tap, not this directory.
3. Users install MD-Memo using:
   ```bash
   brew tap youshinh/tap
   brew install --cask md-memo
   ```
   Or in a single command:
   ```bash
   brew install --cask youshinh/tap/md-memo
   ```

---

## 🔄 Release Automation (GitHub Actions)

When creating a new release (e.g., `v1.0.1`), update:
1. Calculate SHA256 of new archives:
   ```powershell
   (Get-FileHash md-memo-windows-x64.zip -Algorithm SHA256).Hash
   (Get-FileHash md-memo-macos.zip -Algorithm SHA256).Hash
   ```
2. Update `PackageVersion`, `InstallerUrl`, and `InstallerSha256` in `packaging/winget/youshinh.md-memo.yaml`.
3. Update `version` and `sha256` in `packaging/homebrew/md-memo.rb`.
4. Copy that file into `Casks/md-memo.rb` in `youshinh/homebrew-tap` and push (see the Homebrew section above).
