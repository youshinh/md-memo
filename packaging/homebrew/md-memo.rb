cask "md-memo" do
  # NOTE: bump both `version` and `sha256` together whenever a new
  # md-memo-macos.zip is published (e.g. via a `brew bump-cask-pr`-style
  # step). sha256 must be the real hash of that release's md-memo-macos.zip —
  # never hand-edit it without recomputing it from the actual asset.
  version "1.7.0"
  sha256 "0b162498a686b1162138f975177a8f8d3e5cb449c0c6fb2673e7590facd4ff3a"

  url "https://github.com/youshinh/md-memo/releases/download/v#{version}/md-memo-macos.zip"
  name "MD-Memo"
  desc "Ultra-lightweight, high-speed, AI-native Markdown & text editor"
  homepage "https://github.com/youshinh/md-memo"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :catalina"

  app "MD-Memo.app"
  binary "#{appdir}/MD-Memo.app/Contents/MacOS/MD-Memo", target: "md-memo"

  zap trash: [
    # Current bundle id (com.youshinh.md-memo) writes lowercase "md-memo".
    "~/Library/Application Support/md-memo",
    # Older releases used the "mdnotepad" bundle id and/or a "MD-Memo" casing;
    # kept here so `brew uninstall --zap` still cleans those up too.
    "~/Library/Application Support/MD-Memo",
    "~/Library/Saved Application State/com.youshinh.md-memo.savedState",
    "~/Library/Saved Application State/com.mdnotepad.app.savedState",
    "~/Library/Preferences/com.youshinh.md-memo.plist",
    "~/Library/Preferences/com.mdnotepad.app.plist",
  ]

  caveats <<~EOS
    MD-Memo.app is ad-hoc signed, not notarized by Apple. On first launch,
    Gatekeeper will refuse to open it (a dialog saying Apple could not verify
    that it is free of malware). To run it:

      macOS 15 (Sequoia) or later:
        Click "Done" in the dialog, open System Settings > Privacy & Security,
        scroll to "Security", click "Open Anyway" and enter your login
        password. The button is shown for about an hour after the attempt.
      macOS 14 or earlier:
        Right-click (or Control-click) MD-Memo.app in Finder and choose "Open".
      Any version:
        xattr -dr com.apple.quarantine "#{appdir}/MD-Memo.app"

    This is only required once per install/update.
  EOS
end
