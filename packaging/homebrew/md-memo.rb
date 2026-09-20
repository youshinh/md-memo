cask "md-memo" do
  # NOTE: bump both `version` and `sha256` together whenever a new
  # md-memo-macos.zip is published (e.g. via a `brew bump-cask-pr`-style
  # step). sha256 must be the real hash of that release's md-memo-macos.zip —
  # never hand-edit it without recomputing it from the actual asset.
  version "1.5.5"
  sha256 "2677b8d62138f3f8057f1ea3b9357c58f7cba26377bb4d3168c49a45ee47798d"

  url "https://github.com/youshinh/md-memo/releases/download/v#{version}/md-memo-macos.zip"
  name "MD-Memo"
  desc "Ultra-lightweight, high-speed, AI-native Markdown & text editor"
  homepage "https://github.com/youshinh/md-memo"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :high_sierra"

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
    Gatekeeper will refuse to open it as "damaged" or "from an unidentified
    developer". To run it, either:

      1. Right-click (or Control-click) MD-Memo.app in Finder and choose
         "Open", then confirm in the dialog that appears; or
      2. Clear the quarantine attribute from a terminal:
           xattr -dr com.apple.quarantine "#{appdir}/MD-Memo.app"

    This is only required once per install/update.
  EOS
end
