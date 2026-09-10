cask "md-memo" do
  version "1.0.0"
  sha256 "ddff1ee93e58ef0b20a6e2f3eea61a15382c4727e824b8e3b1362a5a7795ddda"

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

  zap trash: [
    "~/Library/Application Support/MD-Memo",
    "~/Library/Saved Application State/com.mdnotepad.app.savedState",
    "~/Library/Preferences/com.mdnotepad.app.plist",
  ]
end
