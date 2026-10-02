# 大きな更新のあとのチェックリスト

機能を足した・画面を足した・設定のキーや CLI / JSON-RPC を足した、といった更新のあとに、**書き忘れ・直し忘れ**を防ぐための一覧。
2026-10-03 の「印刷・PDF 保存、意味検索・深掘り、Mac の印刷、JSON-RPC / CLI の追加」で、コードとテストが済んだあとにマニュアルや
skills が数週間分遅れていたことが分かった（JSON-RPC の 19 メソッドがマニュアルに無かった、skills の GUI の章に深掘りと印刷が
無かった、等）。同じことを繰り返さないための手順であり、**「テストが緑」は「終わり」ではない**。

使い方: 更新の区切りで上から順に見る。当てはまらない項目は飛ばす。機械で確かめられるものは、コマンドを書いてある。

---

## 0. 先に、洗い出す（5 分）

- [ ] 何が増えたかを 1 行ずつ書き出す（画面、ショートカット、設定キー、CLI のコマンド / フラグ、JSON-RPC のメソッド、保存するファイル、
      送信先、プラットフォーム差）。以降の各項目は「これに対して」確かめる。
- [ ] ユーザーに見える**文字列**はあるか（あれば 1 章）。**外へ送るデータ**はあるか（あれば 3 章の同意と文書）。**Mac で動かない / 未確認**
      の部分はあるか（あれば 6 章）。
- [ ] 別セッションの未コミットが作業ツリーに混ざっていないか（`git status`）。混ざっていたら、自分のパスだけを `git add` する
      （`git add -A` や `git commit -a` は使わない）。

## 1. コード（画面）

- [ ] **文字列は英日の両方**: `frontend/js/i18n.js` の `en` と `ja`（同じキー、同じ `{placeholder}`、英語に日本語を混ぜない）。
      `node tools/run_js_tests.mjs`
- [ ] **絵文字を使わない**。アイコンはアプリ共通の線画 SVG（✕ のみ例外）。マニュアル・ランディング・スマホ用ページ・ノートへ
      挿入する見出しも同じ。`python tools/check_manual.py` が見る。
- [ ] **ショートカットを足した**: `frontend/js/app.js` の `DEFAULT_SHORTCUTS` と照合（既存と衝突しない。Ctrl+Shift+O の件の再発防止）、
      Mac のキー（Cmd / Option）、設定画面の表、マニュアルの表（`cfg-shortcuts`）、`docs/features*.md`、skills の 4.1。
- [ ] **設定キーを足した**: 既定値、設定画面の保存で消えない（`syncBackendConfig` のようにページが読み書きする経路）、
      **設定パッケージ**で他人の値が危険なものは `LOCAL_ONLY_KEYS` に入れる（同意・送り先・鍵）、`skills/.../setup-guide.md` (b) の表。
- [ ] **重さ**: 使うまで何も読み込まない（遅延ロード、早期 return、init で重い処理をしない）。起動時間・待機メモリ・JS ヒープ・DOM を
      実測して数字で書く（開いている間のメモリは `powershell -NoProfile -File tools/measure/app-memory.ps1 -Name <プロセス名>`。読むだけで、WebView2 を名前で kill しない）。使っている間だけ増えるものは、その数字を文書に書く。
- [ ] **ダイアログ・パネル**: 見た目は既存の統一（幅・上端中央・塗りなしラベル・フェード・スイッチ。`docs/design/panel-template.md`）。
      開いている間はエディタのショートカットを止める（`isDialogOpen`）。a11y のフォーカス戻し（`a11y.js`）と競合しない。
- [ ] **ボタンを足した**: `frontend/index.html` の `?v=` は**ファイルごと**の番号。遅延ロードする JS は `loadScript('js/x.js?v=1.0.0')`。

## 2. コード（Go と Mac）

- [ ] **bind を足した**: `bind_common.go`（両 OS 共通）か、`window_windows.go` と `window_darwin.go` の**両方**（シムの
      `window.backend` の関数も両方）。片方だけなら `platform_bridge_parity_test.go` の `windowsOnlyBinds` / `darwinOnlyBinds` に理由つきで。
- [ ] **cgo を含む darwin のファイルを足した**: `platform_darwin_nocgo.go` に同名のスタブ。この PC では Obj-C をコンパイルできないので、
      `GOOS=darwin CGO_ENABLED=0 go vet .` で型だけ確かめ、**push して CI の macOS ジョブ**で初めて確かめる（タグを打つ前に緑を待つ）。
- [ ] **JSON-RPC のメソッドを足した**: `app_rpc.go` の `switch`、`pkg/cli/help.go` の `rpcHelp`（`TestHelpListsEveryRPCMethod`）、
      トークン必須（`pkg/ipc/auth.go` は既定で保護）、接続の期限は **10 秒**（`pkg/ipc/ipc.go`）、RPC 自身の上限は 5 秒（長い処理は
      別の上限か、人が確認する画面を開くだけの形にする）。AI の起動・外への送信・シェルの実行は RPC に出さない（`docs/design/rpc-additions-2026-10.md` 4 章）。
- [ ] **CLI を足した**: `pkg/cli/registry.go`（コマンド語）、`help.go`、`main_skilldocs_test.go` が「フラグが skills に書かれているか」を見る。
      コマンド語はパイプのタイトル語と衝突しうる（`md-memo pdf` にしなかった理由）。
- [ ] **ファイルを書く・送る・保存する**: 書く先の検証（絶対パス、拡張子、既存を上書きしない）、秘密の伏せ字、同意（`general.cloudConsent` など）、
      Go 側でも同意を**もう一度**確かめる（ページの言うことを信じない）。
- [ ] **ノートのファイルを Go が書く新経路**: 「外部変更を上書きしない」仕組みの baseline 更新（`project_disk_sync_crlf` の落とし穴）。

## 3. テスト

- [ ] `go test ./... -count=1`（**実機に副作用を出さない**: `OpenExternal` / Ollama の起動停止 / 実 config を触るテストは書かない。`TestMain` でスタブ）
- [ ] `go vet . ./pkg/...`（`possible misuse of unsafe.Pointer` は既知の注釈。それ以外が出たら直す）
- [ ] `node tools/run_js_tests.mjs`（フロントを触ったら**全件**）
- [ ] `node tests/smoke/run.mjs` と `node tests/smoke/run.mjs --lang ja`（流れは `NN_*.mjs` と `NNN_*.mjs`。ユーザーに見える流れごとに 1 本足す）。
      モックの `tools/docshots/mock/backend.js` に新しい `window.backend` の関数を足す（`window_windows.go` / `window_darwin.go` のシムと同じ名前）
- [ ] **足したテストが本当に落ちる**ことを確かめる（実装を一時的に壊して失敗するか見る＝ミューテーション確認。戻したら `grep` で残っていないか確認）
- [ ] **手元で通って CI で落ちる**ものを作らない: 一時フォルダが symlink / 8.3 短縮名の背後、Windows パス前提、macOS の ENOTDIR。push 後に `gh run watch`。
- [ ] 実アプリ（**本物の設定・プロファイルに触れない**）: `go build -overlay`（`window_windows.go` のコピーを毎回ソースから作り直す。`--remote-debugging-port` と
      WebView2 のデータ先を足す）、`APPDATA` / `MDM_E2E_WEBVIEW` を scratchpad に向け、CDP で操作し、終わったら試験用 exe と Ollama を止める。
      見た目は画面写真を**自分の目で見る**。

## 4. ドキュメント（ここが一番漏れる）

**どれも英日で、同じ構成にする。事実はコードで確かめてから書く（ショートカット、既定値、パス、上限）。**

- [ ] `docs/features.md` と `docs/features_ja.md`: 章、末尾の「Windows と macOS で何が動くか」の表の行、スクリプトからの使い方。
- [ ] **`manual.html` と `manual_ja.html`**（図は `figure.fig` + `ol.fig-legend`、日英で同じ id・同じ図の数）:
      サイドバー、節（`doc-section`）、「どれを使う？」の表（`which-one`）、「テキストはどこへ行くか」（`about-md-memo`）、
      JSON-RPC の表（`json-rpc`）、CLI（`headless-cli`）、用語集（`glossary`）、ショートカットの表（`cfg-shortcuts`）、設定の章（`cfg-*`）。
      **`python tools/check_manual.py`**（id の重複、リンク切れ、タグの閉じ忘れ、図の凡例数 = マーカー数、日英の対応、
      JSON-RPC のメソッドと CLI のコマンドが両方のマニュアルにあること）。
- [ ] **スクリーンショット**: `tools/docshots/shots.json`（名前・マーカー）と `setups.mjs`（画面の状態）と `mock/backend.js`（モックの答え）。
      `node tools/docshots/run.mjs --only 名前,名前 --lang both --method cdp`。**撮った画像を目で見る**（マーカーが文字に重なっていないか、
      1120x720 か、実データが写り込んでいないか）。UI を変えたら関係する画像を撮り直す（画像は撮影時のフロントを写す）。
- [ ] `README.md` / `README_JA.md`（短いまま。1 機能 1 行）、ルートの `index.html` / `index_ja.html`（`frontend/index.html` ではない。
      カード、下の注記、機能の数の表記）。デモ GIF は UI が変わったときだけ撮り直す。
- [ ] **`skills/md-memo/`**（エージェントが読む。LF）: `SKILL.md`（表の行）、`references/interfaces.md`（0 章の表、1 章 CLI、2.2 RPC の行、
      4 章 GUI、5 章ファイル、6 章ネットワーク）、`setup-guide.md`（(b) 設定キー、(e) 機能ごとの前提と確認）、`troubleshooting.md`（症状 → 原因 → 直し方）。
      `go test -run "Skill|Help" .` が、コマンド・フラグ・RPC メソッドの書き忘れを見る。
- [ ] `docs/design/` に**判断の記録**（なぜそうしたか、足さなかったもの、未確認の点）。
- [ ] 外へ送るものがあるなら、**マニュアルの「テキストはどこへ行くか」と README のプライバシーの記述**を直す。
- [ ] 「Mac では未確認」「Windows のみ」を、**嘘にならない言い方**で書く（確認していないことは確認済みと書かない）。

## 5. 版・リリース

- [ ] 版番号をユーザーに提案して決めてもらう（機能追加は minor、修正は patch）。
- [ ] 版を上げる場所: `app.go` の `AppVersion`、`app_rpc_test.go`、`frontend/js/app.js` の `currentVersion` 既定値、
      `tests/update_checker_test.mjs`（既定値が現行版と一致するかを見張るテスト）、`manual.html` / `manual_ja.html` のバッジ・例・フッター、
      `skills/md-memo/SKILL.md`（"Version x"）、`references/interfaces.md`（Basis と例の `"appVersion"`）、`references/setup-guide.md`（Basis）。
      **上げない**: 機能が入った版を示す履歴の言及（"from 1.10.0"）、`docs/design/*.md`、`frontend/index.html` の `?v=`、旧版の設定パッケージを表すダミー。
- [ ] 機能のコミットと版更新のコミットは**分ける**。コミットは `&&` でつなぐ（`;` だと前段が失敗しても後段が走る）。
- [ ] push → **CI（Windows と macOS）が緑**になるのを待つ → 注釈付きタグ → Release の成功 → `gh release edit` で英日の本文
      （空で出る）→ zip の `sha256` を `gh release view --json assets` の `digest` と照合 → `md-memo-cli --version`、`jev verify` の終了コード、
      macOS の Info.plist、埋め込みの frontend に今回の修正が入っていること（`grep -a -c -F`）→ `packaging/homebrew/md-memo.rb`
      とタップ `youshinh/homebrew-tap`（LF、名義 youshinh）を更新。winget は PR（`packaging/winget`）。
- [ ] リリースノートに**確認していない点**（実機の Mac など）を書く。

## 6. プラットフォーム（Mac）

- [ ] Mac で動かないもの・未確認のものを、`docs/features*.md` の表、マニュアル、ランディング、リリースノートの**全部**に同じ言い方で。
- [ ] cgo / Obj-C は CI の macOS ジョブが最初のコンパイル。赤ならタグを打たずに直す。
- [ ] ユーザーが Mac で試す点を、リリース報告に**箇条書き**で渡す（何を押して何が起きれば成功か）。

## 7. 終わったら

- [ ] 試験用に起動したもの（exe、Ollama、ブラウザ）を止める。scratchpad 以外にファイルを残さない。
- [ ] ユーザーの本番の exe は、起動中は上書きできない（終了させない）。再ビルドが要ることを伝える。
- [ ] この更新で見つけた**既存の不具合**（直したもの、直さなかったもの）を報告に分けて書く。
- [ ] 新しい落とし穴は、このチェックリストか `docs/design/` に 1 行足す。
