# macOS 実機チェックリスト

macOS 向けの修正はすべて Windows 上で書かれており、Objective-C / cgo 部分は一度もコンパイル・実行されていません。
GitHub に push すると `.github/workflows/ci.yml` が macOS ランナーでビルドし、`md-memo-macos-<sha>` として .app を成果物に出します。
初回起動は `xattr -dr com.apple.quarantine MD-Memo.app`（または右クリック →「開く」）が必要です。

## 0. まず CI が通るか

- [ ] macOS ジョブの `go build ./...` が成功する
  - 失敗箇所が `hotkey_darwin.go` の場合: そのファイルを削除し、`window_darwin.go` 側で `updateGlobalHotKeyNative` を `return false` のスタブにすれば他は生きます
  - `window_darwin.go` の場合に疑う順: `-fobjc-exceptions` と `@try/@catch` → `(NSWindow *)nsWindow` のキャスト → `setValue:forKey:@"drawsBackground"`
- [ ] ログの `lipo -archs` が `x86_64 arm64` になっている（片方だけならユニバーサル化に失敗してフォールバックしています）
- [ ] `plutil -lint` が OK

## 1. ウィンドウの生死（最重要）

- [ ] タイトルバーの黄・緑ボタンが有効。ウィンドウをリサイズできる
- [ ] メニューバーに Window ▸ Minimize (⌘M) / Zoom がある
- [ ] ⌘M で Dock に格納され、Dock アイコンのクリックで戻る
- [ ] 赤ボタンで閉じる → プロセスは残り、Dock アイコンで復帰する
- [ ] 最後のタブを ⌘W で閉じる / ⌘Q → 完全に終了する（`ps aux | grep -i md-memo` が空、`lsof -i :41739` が空、`~/Library/Application Support/md-memo/ipc-session.json` が消えている）
- [ ] 起動時に白いフラッシュが出ない

## 2. 前面化・単一インスタンス・ファイル引き継ぎ

- [ ] 別アプリを前面にして `echo hi | md-memo` → スクラップに追記され、MD-Memo が前面に来る
- [ ] 起動中にもう一度 `md-memo` → 2つ目は即終了し、1つ目が前面に来る（Dock アイコンが2つにならない）
- [ ] `kill -9` で落とした後も普通に起動できる（ロックが残らない）
- [ ] 起動中に `md-memo ~/Documents/メモ 1.md`（空白・日本語入り）→ 既存ウィンドウの新しいタブで開く
- [ ] `cd /tmp && md-memo ../Users/<you>/note.md`（相対パス）でも開く

## 3. PATH（Finder / Dock から起動して確認）

- [ ] `brew install jq` 済みの状態で、コマンドバー（⌘⇧B）の `jq .` が動く
- [ ] 設定 → 連携 → エージェントの横に「✓ インストール済み」が出る（`claude` / `codex` / `ollama`）
- [ ] 起動が体感で遅くなっていない（PATH 取得は裏で走ります）
- [ ] `~/.zshrc` に `echo hello` を足しても PATH が正しく取れる

## 4. グローバル召喚（既定 ⌥⌘M）

- [ ] 他アプリを前面にして ⌥⌘M → MD-Memo が前面に来る
- [ ] 再起動直後（設定を開かなくても）効く
- [ ] 設定で OS が握っている組み合わせ（例: ⌘Space）を登録 → エラートーストが出て元の値に戻る
- [ ] ショートカットを2回変えると、最新のものだけが効く。解除（Backspace）すると効かなくなる

## 5. キーボード

- [ ] ⌘Z で Undo、⇧⌘Z で Redo が効く（効かない場合、Edit メニューの項目が無効化されています → 要対応）
- [ ] Zen モード: 設定の表示が `Ctrl+Cmd+Z`。⌃⌘Z で切り替わり、⇧⌘Z では切り替わらない
- [ ] アクション候補（⌘J）: パネルのヒントが `Option+1..3` / `Option+Enter`。⌥1〜3 で選択、⌥Enter と ⌘Enter で実行、素の Enter は閉じるだけ。パネル表示中の ⌘1 / ⌘2 はペイン切替にならない
- [ ] ⌥T でタスクパネルが開閉する
- [ ] 物理 Ctrl+A で行頭、Ctrl+E で行末へ移動する（全選択にならない）。⌘A は全選択
- [ ] ショートカット録画: ⌥T を登録すると `Option+T` と表示され（`Option+†` にならない）、実際に効く。⌥1 や ⌥, も効く
- [ ] ⌘Q / ⌘H / ⌘M / ⌘Tab / ⌘, は「予約済み」として登録を拒否される。F11 は拒否されない
- [ ] フルスクリーン: ⌃⌘F でネイティブのフルスクリーンになる
- [ ] 分割表示の第2ペインで Tab / ⇧Tab のインデントが効く

## 6. 設定画面

- [ ] 設定 → バージョン表示が空でない
- [ ] IME Guardian: 新規インストールでは既定オフで、理由のヒントが出ている。UI 言語を日本語に変えても勝手にオンにならない
- [ ] 常駐（トレイ）のチェックボックスが無効化され、ヒントが出ている

## 7. 未対応（実機で状況を確認してから判断するもの）

- [ ] 右クリック →「貼り付け」が効くか（WKWebView は `navigator.clipboard.readText()` を制限します。⌘V は効くはず）
- [ ] クリップボード画像の OCR 貼り付けが効くか
- [ ] ファイルのドラッグ&ドロップで開いたタブが保存先を持つか（`File.path` は WKWebView に無く、現状は毎回「名前を付けて保存」になります）
- [ ] ファイルダイアログ（AppleScript 経由）がウィンドウの背後に出ないか、開いている間 UI が固まらないか
- [ ] IME Guardian を手動でオンにしたときの挙動（入力ソースは切り替わりません）
- [ ] Ollama 停止で無関係なプロセス（`tail -f ollama.log` など）が落ちないこと
- [ ] Gatekeeper の実際の文言が README の案内と合っているか（Apple Silicon / Intel 両方）
