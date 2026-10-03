# MD-Memo Distribution & Packaging

This directory contains package manager manifests and recipes to distribute **MD-Memo** via **Windows Package Manager (WinGet)** and **Homebrew (macOS Tap)**.

---

## 📦 Package Summary

| Target | Manager | Type | Manifest File | Binary / Archive URL | SHA256 Hash |
|---|---|---|---|---|---|
| **Windows (x64)** | WinGet | Portable Zip (`.exe`, plus `md-memo-cli.exe`) | `packaging/winget/` (3 files) | `https://github.com/youshinh/md-memo/releases/download/v1.12.0/md-memo-windows-x64.zip` | `136137B581BC740AEAD47E7588E65664888420BA314DD00C0F2157902F2A6496` |
| **macOS (Intel/ARM)** | Homebrew | Cask (`.app`) | `packaging/homebrew/md-memo.rb` | `https://github.com/youshinh/md-memo/releases/download/v1.6.0/md-memo-macos.zip` | `3357f6147c7eb288b9c426c5b62be4f3e7aaf64fbe6be231d358dabcb1092bfb` |

> **Status (2026-10-03):** the Homebrew tap `youshinh/homebrew-tap` is live. The WinGet package is **submitted, not published yet**: [microsoft/winget-pkgs#438694](https://github.com/microsoft/winget-pkgs/pull/438694) is open and was moved from 1.6.0 to 1.12.0 on 2026-10-03; it needs the submitter's CLA comment and a moderator's approval (the README, the manuals and the landing page point Windows users at the release zip until it is merged). Once it is merged, `winget install youshinh.md-memo` works and those pages can advertise it again.

---

## 🪟 Windows: WinGet

### 1. Local Validation
Verify the manifest syntax against the WinGet schema:

```powershell
winget validate --manifest packaging/winget
```

### 2. Local Installation Testing
Test installing MD-Memo locally from the manifest folder (needs `winget settings --enable LocalManifestFiles`, which changes a winget setting and needs an administrator prompt):

```powershell
winget install --manifest packaging/winget
```

To test uninstalling:

```powershell
winget uninstall youshinh.md-memo
```

### 3. Publishing to `microsoft/winget-pkgs`

winget-pkgs accepts only the **multi-file** form (a `singleton` manifest is not accepted): `youshinh.md-memo.yaml` (version), `youshinh.md-memo.installer.yaml` and `youshinh.md-memo.locale.en-US.yaml`, under `manifests/y/youshinh/md-memo/<version>/`. The first submission, [#438694](https://github.com/microsoft/winget-pkgs/pull/438694), was opened for 1.6.0 and its branch was later updated in place to 1.12.0 through the GitHub API (new commit on the fork's branch that removes the old version folder and adds the new one; title and body edited). The Microsoft CLA has to be signed once by the submitter.

#### Option A: Using `wingetcreate` (updates once the package exists)
1. Install `wingetcreate`:
   ```powershell
   winget install Microsoft.WingetCreate
   ```
2. Submit an update for a new release:
   ```powershell
   wingetcreate update youshinh.md-memo --version <X.Y.Z> --urls https://github.com/youshinh/md-memo/releases/download/v<X.Y.Z>/md-memo-windows-x64.zip --submit --token <YOUR_GITHUB_PAT>
   ```

#### Option B: Manual GitHub Pull Request (how 1.6.0 was submitted)
1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (default branch only is enough; the repository is about 900 MB, so avoid cloning it: the three files can be added on a new branch with the GitHub API).
2. Put the three files from `packaging/winget/` under `manifests/y/youshinh/md-memo/<version>/`.
3. Open a Pull Request titled `New package: youshinh.md-memo version X.Y.Z` (later versions: `Update: youshinh.md-memo to X.Y.Z`) and fill in the template.

### 4. The console CLI (`md-memo-cli.exe`)
From the release that contains it, `md-memo-windows-x64.zip` holds a second executable, `md-memo-cli.exe`, next to `md-memo.exe`: the console-subsystem build of the same commands, for scripts, agents and CI (PowerShell waits for it and gets its exit codes). The manifests here list only `md-memo.exe`. To put `md-memo-cli` on `PATH` through winget, a manifest version for that release can add a second `NestedInstallerFiles` entry (`RelativeFilePath: md-memo-cli.exe`, `PortableCommandAlias: md-memo-cli`) and the matching `Commands` item. macOS is unchanged: a terminal waits for the app binary itself, and the cask installs no second executable.

---

## 🍏 macOS: Homebrew Tap (Cask)

The Cask installs `MD-Memo.app` directly into `/Applications` and symlinks
its `md-memo` CLI binary (`MD-Memo.app/Contents/MacOS/MD-Memo`) onto `PATH`,
so `cat log | md-memo` and the `md-memo buffer/tab/ui/jev/agent` subcommands
work the same as on Windows/Linux. The cask installs only the `.app`, not the `skills/`
folder that the release zips carry; a Homebrew user gets the agent skill with
`md-memo agent install-skill`, which copies the skill built into the binary (versions after 1.8.0).

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
2. Update `PackageVersion` in all three files of `packaging/winget/`, and `InstallerUrl`, `InstallerSha256` and `ReleaseDate` in `youshinh.md-memo.installer.yaml` (and `ReleaseNotesUrl` in the locale file); validate with `winget validate --manifest packaging/winget`; then submit the new version to `microsoft/winget-pkgs` (see above).
3. Update `version` and `sha256` in `packaging/homebrew/md-memo.rb`.
4. Copy that file into `Casks/md-memo.rb` in `youshinh/homebrew-tap` and push (see the Homebrew section above).
