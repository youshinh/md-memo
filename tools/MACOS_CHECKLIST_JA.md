# macOS 実機チェックリスト

macOS 向けの修正はすべて Windows 上で書かれており、Objective-C / cgo 部分は一度もコンパイル・実行されていません。
GitHub に push すると `.github/workflows/ci.yml` が macOS ランナーでビルドし、`md-memo-macos-<sha>` として .app を成果物に出します。
初回起動は `xattr -dr com.apple.quarantine MD-Memo.app`（macOS 15 以降は システム設定 → プライバシーとセキュリティ →「このまま開く」、14 以前は右クリック →「開く」）が必要です。

## 0. まず CI が通るか

- [ ] macOS ジョブの `go build ./...` が成功する
  - 失敗箇所が `hotkey_darwin.go` の場合: そのファイルを削除し、`window_darwin.go` 側で `updateGlobalHotKeyNative` を `return false` のスタブにすれば他は生きます
  - `window_darwin.go` の場合に疑う順: `-fobjc-exceptions` と `@try/@catch` → `(NSWindow *)nsWindow` のキャスト → `setValue:forKey:@"drawsBackground"`
  - `use of undeclared identifier 'kAEQuitReason'` の場合: `#import <CoreServices/CoreServices.h>` が効いていません。`kAEQuitReason` を整数 `0x7768793F`（`'why?'`）に置き換えれば通ります
  - `mdmemoGoQuit` の未定義・型不一致の場合: `openfile_darwin.go` の `//export mdmemoGoQuit`（戻り値 `C.int`）と `window_darwin.go` の `extern int mdmemoGoQuit(void);` を突き合わせる
- [ ] ログの `lipo -archs` が `x86_64 arm64` になっている（片方だけならユニバーサル化に失敗してフォールバックしています）
- [ ] `plutil -lint` が OK
- [ ] `tools/crosscheck.ps1`（相当の手順: `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go vet ./...` / `go test -c`)で、cgo を使わない純 Go 部分（`platform_darwin.go` など）は Windows 上でも型チェックできるようになりました。CI の Windows ジョブにも同じクロスチェック手順(`.github/workflows/ci.yml` の "Cross-check macOS build (no cgo)")が入っています。Objective-C / cgo 側(`window_darwin.go`、`hotkey_darwin.go`)は引き続きこの macOS ジョブでしか検証できません

## 1. ウィンドウの生死（最重要）

- [ ] タイトルバーの黄・緑ボタンが有効。ウィンドウをリサイズできる
- [ ] メニューバーに Window ▸ Minimize (⌘M) / Zoom がある
- [ ] ⌘M で Dock に格納され、Dock アイコンのクリックで戻る
- [ ] 赤ボタンで閉じる → プロセスは残り、Dock アイコンで復帰する
- [ ] 最後のタブを ⌘W で閉じる / ⌘Q → 完全に終了する（`ps aux | grep -i md-memo` が空、`lsof -i :41739` が空、`~/Library/Application Support/md-memo/ipc-session.json` が消えている）
- [ ] 起動時に白いフラッシュが出ない
- [ ] Finder / Dock / Spotlight から起動したとき、ウィンドウが前面に出てキー入力をすぐ受け付ける（アプリのデリゲートを `webview.New` より前に設定するよう変えたため、起動直後の前面化の経路が変わっています）
- [ ] ターミナルから `.app` の中の実行ファイルを直接起動しても、ウィンドウと Dock アイコンが出て前面に来る

## 1b. 終了の経路（⌘Q / Dock / ログアウト）

⌘Q・メニューの「Quit MD-Memo」・Dock の「終了」は、ページにセッションを保存させてから `App.CloseWindow` と同じ経路で終了するようになりました。ログアウト・再起動・システム終了のときだけは止めずに AppKit に終了させます。

- [ ] 何か入力した直後（0.5 秒以内）に ⌘Q → 再起動すると、最後の入力まで残っている（未保存タブ・新規タブの両方）
- [ ] ⌘Q 後に `~/Library/Application Support/md-memo/ipc-session.json` が消えている。`lsof -i :41739` が空
- [ ] メニューバーの「MD-Memo ▸ Quit MD-Memo」でも同じ（入力が残る・ipc-session.json が消える）
- [ ] Dock アイコンを右クリック →「終了」でも同じ。消えていなくても（Dock が終了理由を付けて送る場合）終了すること自体は必須
- [ ] ⌘Q を連打しても 1 回だけ終了し、エラーダイアログやクラッシュレポートが出ない
- [ ] 未保存の変更があっても ⌘Q で確認ダイアログは出ない（以前と同じ。変更はセッションに残る）
- [ ] 起動中にログアウト → ログアウトが「MD-Memo が中断しました」で止まらない。再ログイン後、直前の入力が残っている
- [ ] 起動中に再起動 / システム終了 → 止まらない
- [ ] ファイル選択ダイアログ（画像の挿入など）を開いたまま Dock から「終了」→ 遅くとも 5 秒ほどで終了する
- [ ] 赤ボタン（隠す）→ Dock から「終了」でも終了し、ipc-session.json が消える
- [ ] `osascript -e 'quit app "MD-Memo"'` はエラー -128（User canceled）を返すことがあるが、アプリは直後に終了する（想定どおり）

## 2. 前面化・単一インスタンス・ファイル引き継ぎ

- [ ] 別アプリを前面にして `echo hi | md-memo` → スクラップに追記され、MD-Memo が前面に来る
- [ ] 起動中にもう一度 `md-memo` → 2つ目は即終了し、1つ目が前面に来る（Dock アイコンが2つにならない）
- [ ] `kill -9` で落とした後も普通に起動できる（ロックが残らない）
- [ ] 起動中に `md-memo ~/Documents/メモ 1.md`（空白・日本語入り）→ 既存ウィンドウの新しいタブで開く
- [ ] `cd /tmp && md-memo ../Users/<you>/note.md`（相対パス）でも開く
- [ ] MD-Memo を終了した状態で、Finder の `.md` を右クリック →「このアプリケーションで開く ▸ MD-Memo」→ 起動してそのファイルが最初のタブに出る（「"Markdown Document" 形式のファイルを開けません」が出ない）。同じファイルのタブが 2 つにならない
- [ ] 終了した状態で `.md` をダブルクリック（MD-Memo が既定のアプリの場合）/ Dock アイコンにドロップ → 同上
- [ ] 終了した状態で Finder で `.md` を 2 つ選んで「このアプリケーションで開く」→ 1 つ目が最初のタブ、2 つ目が別タブで開く
- [ ] 起動中に Finder から「このアプリケーションで開く」→ 新しいタブで開き、ウィンドウが前面に来る（従来どおり）
- [ ] ファイル無しで起動したときは、前回のセッションが今までどおり復元される

## 3. PATH（Finder / Dock から起動して確認）

- [ ] `brew install jq` 済みの状態で、コマンドバー（⌘⇧B）の `jq .` が動く
- [ ] 設定 → 連携 → エージェントの横に「✓ インストール済み」が出る（`claude` / `codex` / `ollama`）
- [ ] 起動が体感で遅くなっていない（PATH 取得は裏で走ります）
- [ ] `~/.zshrc` に `echo hello` を足しても PATH が正しく取れる

## 4. グローバル召喚（既定 ⌥⌘M）

- [ ] 他アプリを前面にして ⌥⌘M → MD-Memo が前面に来る
- [ ] 再起動直後（設定を開かなくても）効く（起動時の登録をメインキューへ回すよう変えたため、特に要確認）
- [ ] 設定で OS が握っている組み合わせ（例: ⌘Space）を登録 → エラートーストが出て元の値に戻る
- [ ] ショートカットを2回変えると、最新のものだけが効く。解除（Backspace）すると効かなくなる

## 5. キーボード

- [ ] ⌘Z で Undo、⇧⌘Z で Redo が効く（効かない場合、Edit メニューの項目が無効化されています → 要対応）
- [ ] Zen モード: 設定の表示が `Ctrl+Cmd+Z`。⌃⌘Z で切り替わり、⇧⌘Z では切り替わらない
- [ ] アクション候補（⌘J）: パネルのヒントが `Cmd+1..3 即実行 / Ctrl+Tab 移動 → Enter 決定 / Esc 閉じる`。⌘1〜3（⌥1〜3 も可）で即実行、⌃Tab で強調表示が移動し、その後の Enter で決定（⌃Tab を押していない素の Enter は改行として閉じるだけ）。⌘Enter はパネルに奪われずスロット実行のまま。パネル表示中の ⌘1 / ⌘2 と ⌃Tab はペイン切替・ノート切替にならない
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
