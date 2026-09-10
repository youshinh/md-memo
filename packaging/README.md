# MD-Memo Distribution & Packaging

This directory contains package manager manifests and recipes to distribute **MD-Memo** via **Windows Package Manager (WinGet)** and **Homebrew (macOS Tap)**.

---

## 📦 Package Summary

| Target | Manager | Type | Manifest File | Binary / Archive URL | SHA256 Hash |
|---|---|---|---|---|---|
| **Windows (x64)** | WinGet | Portable Zip (`.exe`) | `packaging/winget/youshinh.md-memo.yaml` | `https://github.com/youshinh/md-memo/releases/download/v1.0.0/md-memo-windows-x64.zip` | `9309BB8A00D31B392A20B08BD9A0BC91806F3B7DF47B65610FB4748896CCBB2F` |
| **macOS (Intel/ARM)** | Homebrew | Cask (`.app`) | `packaging/homebrew/md-memo.rb` | `https://github.com/youshinh/md-memo/releases/download/v1.0.0/md-memo-macos.zip` | `ddff1ee93e58ef0b20a6e2f3eea61a15382c4727e824b8e3b1362a5a7795ddda` |

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

The Cask installs `MD-Memo.app` directly into `/Applications`.

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

### 2. Setting up a Homebrew Tap (`youshinh/homebrew-tap`)
1. Create a public repository on GitHub named `homebrew-tap` under your account (`youshinh/homebrew-tap`).
2. Create a `Casks/` folder in that repository.
3. Copy `packaging/homebrew/md-memo.rb` into `Casks/md-memo.rb`.
4. Users can then install MD-Memo using:
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
