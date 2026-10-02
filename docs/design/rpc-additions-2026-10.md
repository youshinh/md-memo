# JSON-RPC の拡張（2026-10-02）

状態: Go 側（19 メソッド）とページ側（`window.__mdMemoRPC` の 7 関数）を実装し、Go のテストとヘッドレスの実ブラウザ（スモーク）で確認済み。実アプリ（本物の WebView2、macOS）での確認は未。コミットは未。

## 1. 目的と方針

アプリの機能のうち、画面と CLI から使えるのに、起動中のアプリへの JSON-RPC（`ipc-session.json` のポートとトークン）からは操作できなかったものを、同じトークン認証の下に足す。

- **新しいメソッドはすべてトークン必須**（`pkg/ipc/auth.go` は「トークンなしで安全なもの」の一覧で、既存の 3 つの読み取りだけ。新しいメソッドは、人が明示的に足さない限り保護される。`TestEveryRPCMethodExceptTheOldReadsNeedsTheToken` が固定）。
- **CLI と同じ関数で答える**: `info`、`config get`、`scrap path / list / search` は、`pkg/cli/shared.go` の関数を CLI と RPC の両方が呼ぶ。2 つの答えが食い違わない。
- **書き込みは、読んだときのハッシュで守る**（`buffer.replace_all`）。人の編集と競合したら、-32001 で何も変えない。
- **取り返しのつかないもの、利用者の費用や外部への送信が発生するもの、物理的に作用するものは足さない**（§4）。足したもののうち、外へ影響するもの（`git.sync`、`filter.run`、`scrap.append`）は、スキルに「頼まれたときだけ」と書き、ガードを通す。

## 2. 追加したメソッド（すべてトークン必須）

| 区分 | メソッド | 内容 |
|---|---|---|
| 情報 | `app.info`、`config.get` | `md-memo info`、`config get` と同じ答え。鍵は伏せる。 |
| スクラップ | `scrap.path`、`scrap.list`、`scrap.search`、`scrap.open` | `scrap.search` は、完全一致、`ranked`、実験的な `semantic` まで、CLI と同じ引数。各ヒットに、リンクとして引用する材料（`rel`、`url`、`label`、`link`）がある。 |
| パイプ | `scrap.append` | `cmd \| md-memo [タイトル語]` と同じ追記（§3）。`format: "markdown"` は、囲みなしで書く（リンクが生きる。検索結果の要約を書く用途、`search-summary-prep-2026-10.md`）。 |
| コマンド | `filter.validate`、`filter.run` | コマンドバーが選択範囲にかける処理。ガードを通す（§3 の末尾）。 |
| 編集 | `buffer.find`、`buffer.replace_all` | ノートの中の検索と、一括置換（1 回の書き込み）。 |
| カーソル | `buffer.cursor`、`buffer.select` | 選択がなくても読める。選択、キャレットの設定。`focus` の既定は false。 |
| 表示 | `ui.state`、`ui.set_view`、`ui.open_panel` | プレビュー（off / full / side）、分割、Zen、パネルの表示。 |
| タスク | `task.list`、`task.cancel` | タスクパネルの内容と、取り消し。**起動するメソッドはない**。 |
| Git | `git.status`、`git.sync` | 状態（リモートの認証情報は伏せる）と、同期の開始。 |
| タブ | `tab.list` の項目を追加 | `encoding`、`eol`、`diskConflict`、`isScrap`、`pane`。 |

## 3. パイプ（`cmd | md-memo`）との対応

コマンドラインからパイプで `md-memo` に送るときの機能を、1 つずつ RPC に置いた。

| パイプの機能 | RPC |
|---|---|
| 標準入力、最大 10MB | `scrap.append`、同じ 10MB（超えると -32602） |
| Shift_JIS、UTF-16、BOM の復号（日本語コンソール） | `content_base64`（生のバイト列を、パイプと同じ `encoding.DecodePiped` で復号）。`content` は UTF-8 の文字列 |
| コマンドライン上のタイトル語が見出しになる（なければ `CLI Pipe`） | `title`。見出しは 1 行なので、改行と連続する空白は 1 つの空白にし、200 文字まで（見出しの偽造を防ぐ） |
| 作業ディレクトリの記録（ページへの通知に入る） | `cwd` |
| 今日のスクラップへの追記（`---` / `## [HH:MM:SS] タイトル` / ```text ... ```） | 同じ `pkg/scrap` の追記。返事に `path`、`date`、`time`、`title`、`line`（エントリの `---` の行）、`bytes` |
| Git 同期の起動、ページへの通知 | 同じ |
| ウィンドウを前面に出す | `activate: true`（既定は false。入力中の人から注意を奪わないため） |
| 空のパイプは何もしない | 空の内容は -32602 `nothing to append` |
| `md-memo <file.md>`（ファイルを開く）、引数なし（前面へ） | 既存の `tab.new {path}`、`ui.activate` |
| アプリが閉じていれば起動する | **しない**（RPC は起動中のアプリへ。閉じていれば接続できない） |
| 認証なし（旧形式の 1 行メッセージ） | **トークン必須**（旧形式は、そのまま残る） |

`filter.run`: コマンドバー（Ctrl+E）の「選択範囲をシェルのコマンドに通す」にあたる。入力を標準入力に渡し、標準出力、標準エラー、終了コードを返す（ノートは変えない。`buffer.get_selection` で読み、`buffer.replace_selection` で書き戻す）。**ガードは、コマンドバーと同じ**（`pkg/jev` の reviewed モード）: ブロックされたコマンドは -32602 で実行されない。警告のコマンドは、`confirm_warning: true` を付けたときだけ実行する（人が同意したときだけ送る）。5 秒（最大 8 秒）で止め、出力は 1MB で切る。`TestRPCFilterRunIsGuardedLikeTheCommandBar` が、ガードを通らないコマンドは実行器に届かないことを、実行器を差し替えて確かめる。

## 4. あえて足さなかったもの

| 機能 | 理由 |
|---|---|
| AI への問い合わせ（質問バー、書き換え）、エージェントやスロットの実行、タスクの起動 | 利用者の API の費用と、外部への送信、シェルの実行が起きる。確認の画面（「エージェントの確認」）が、人のためにある。呼ぶ側のプログラムに任せない。`task.list` と `task.cancel`（止めるだけ）は足した。 |
| OCR（画像から文字）、音声入力、会議の録音、画面キャプチャ、Quick Capture | 画像や音声が、クラウドのモデルへ送られ得る。物理的な入力（マイク、画面）にも触る。 |
| Mobile Drop の開始、トンネル、Discord ブリッジ、ホットフォルダの切り替え | ネットワークの窓口を開く、または、外部のサービスにつなぐ。 |
| 設定の変更、設定パックの書き出しと取り込み、エージェントの定義の編集 | 安全に関わる設定（ガード、確認、無効化のスイッチ）を、呼ぶ側が外せてしまう。スキルも「設定はアプリを閉じて、ファイルで」と案内している。 |
| ファイルの保存ダイアログ、フォルダを開く、エクスプローラーで表示 | ダイアログは待てない（RPC は 5 秒）。保存は `buffer.save`（ダイアログなし）がある。 |

必要になったものは、1 つずつ判断して足す（まず、人が確認する画面を RPC から開くだけの形を考える）。

## 5. 実装の場所とテスト

| 場所 | 内容 |
|---|---|
| `app_rpc_extra.go` | 新しいメソッドの処理。`app_rpc.go` の `switch` から呼ぶ（`--help` に載っていないメソッドは、`TestHelpListsEveryRPCMethod` が検出）。 |
| `pkg/cli/shared.go` | CLI と RPC が共有する `Info`、`ConfigGet`、`ScrapPathFor`、`ScrapList`、`ScrapSearch`。不正な引数は `ParamError`（RPC では -32602）。CLI の出力は変えていない（既存のテストが固定）。 |
| `pkg/scrap` | `AppendScrapAt`（追記したエントリの開始行を返す）。パイプの経路は、ファイルを読まない従来の `AppendScrap` のまま。 |
| `pkg/gitsync` | `Engine.Enabled()`。 |
| `app_rpc_extra_test.go` | 偽のページ（WebView のモック）で、全メソッドを確かめる。UTF-16 の位置、競合（人が読み書きの間に入力）、ガード、認証情報の除去、Shift_JIS の復号。 |
| `frontend/js/app.js`（`window.__mdMemoRPC`） | `getCursor`、`setCursor`、`getUiState`、`setUiState`、`openPanel`、`getTabs`（項目の追加）、`getTasks`、`cancelTask`。実ページでの確認は、`tests/smoke/89_*`。 |
| `skills/md-memo/references/interfaces.md`、`SKILL.md`、`pkg/cli/help.go` | 文書。 |

## 6. 残り

- CLI のコマンドは足していない（`buffer find`、`ui state` など）。RPC のみ。必要なら、既存の `buffer`、`ui` コマンドの形で足せる。
- 意味検索（`scrap.search` の `semantic`）は、呼ぶたびに索引をディスクから読む（CLI と同じ）。起動中のアプリが索引をメモリに載せる最適化は、設計書（`semantic-search-2026-10.md`）の P3。
- 実アプリ（本物の WebView2）での通し確認は、していない（モックのページと、ヘッドレスの実ブラウザでの確認のみ）。
