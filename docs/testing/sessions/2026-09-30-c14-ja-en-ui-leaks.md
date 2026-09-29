# セッション 2026-09-30: C14 日本語 UI と英語 UI を全画面で通す

- 憲章: 日本語 UI と英語 UI を、隔離した Edge＋モックのバックエンド（探索キット）で全画面・全パネル・全ダイアログ・ツールチップ・トースト・エラー・プレースホルダーにわたって通し、言語の漏れ・混在・書式の不一致・折り返しや切れを見つける（言語を開いたまま切り替える場合を含む）
- 時間: 開始 03:11 / 終了 03:56（計 約 45 分。時刻は端末の時計）
- ナビゲーター: 調整役のセッション / ドライバー兼記録係: Claude Code（Sonnet 5.5）
- 環境: 版 1.10.5 相当（コミット a8bfea5、作業ツリーは未コミットの変更あり）/ Windows 11 / 道具 = 探索キット（`tools/explore/kit.mjs`、ヘッドレス Edge 154＋docshots のモック）＋静的な読み取り（`frontend/js/i18n.js` ほか）。実アプリ・実 config・実クリップボードには触れていない
- 範囲外（やらないこと）: 実アプリの操作、ネイティブのダイアログ・トレイ・クイックキャプチャ、macOS、実 Ollama・実 Gemini、スクリーンリーダー、`manual*.html` の本文、直すこと

証拠の置き場所（すべて `C:/Users/yoush/AppData/Local/Temp/claude/C--Users-yoush-Documents-md-memo/c56620cc-7e7e-498b-a7c7-c4a14c374db1/scratchpad/explore/C14/`）: `en/`・`ja/` に PNG と各画面の可視テキストの JSON、直下にスクリプト（`walk*.mjs`、`verify.mjs`、`lib.mjs`、`trunc.js`、`collect.js`）と出力ログ（`sw-en.txt`、`sw-ja.txt`、`w14.txt`、`w15.txt`、`w16.txt`、`verify.txt`、`walk9.txt`）。以下ではこの場所を `C14/` と書く。

## 進め方（レンズ）

1. **辞書の静的な突き合わせ**: `i18n.js` の en と ja（各 944 キー）で、キーの過不足、`{count}` などの差し込みの一致、en の中の日本語、ja が en と同一の値、`...` と `…`、矢印、全角・半角の括弧、同じ英語に別の訳、を機械で調べた。
2. **画面ごとの可視テキストの収集**: 各画面を開き、文字ノード・`title`・`placeholder`・`aria-label`・`alt`・選択肢・入力欄の値を集め、EN に日本語、JA に英文が残っていないか判定。同時に、切れ・はみ出し（`text-overflow`、`overflow`、ビューポート外）を測った（`trunc.js`）。
3. **言語を開いたまま切り替える（名詞×動詞）**: 設定で言語を変えた直後（Save 前）と Save 後に、質問バーの失敗表示・AI ポップオーバー・全タブ一覧・タスクパネルが開いた状態から、新しい言語の「新規起動」と違う所を差分で見つけた（`walk8`〜`walk10b`）。
4. **What If**: Go 側が返す日本語の文字列（保存失敗・ガードの理由・パッケージの失敗・音声の部品表）を、モックに実物のまま入れて英語 UI に出してみた。初回起動（`fresh`）だけで見える既定値も確認。
5. **書式**: 1 文字・0 件・1 件の複数形、単位、日付。

## ログ（時系列）

| 時刻 | 操作 | 観察 | 疑問・次の一手 |
|---|---|---|---|
| 03:11 | `smoke.mjs --ja`、i18n.js の en/ja を読み込み、キーの過不足・差し込み・英日の混在を比較 | キット動作。944 対 944、欠落 0、差し込みの不一致 0。en の中の日本語は 1 件だけ（`voiceTranscribeTimeout` の「[再試行]」）。ja が en と同一の値は製品名などで妥当 | 辞書は堅い。漏れは辞書の外（直書き・別テーブル・Go・欄の値）にあるはず |
| 03:13 | `crawl1`: 英語と日本語の素の画面で、全 DOM（隠れた要素も）の文字・属性を収集 | EN: 日本語は隠れた `#stat-tasks-count`（「実行中: 0件」）と言語の選択肢だけ。JA: 設定のプレースホルダーと選択肢（約 40 個）、`aria-label` 3 個、副エディタの placeholder が英語 | 設定の英語は多い。実行時に見える画面（パレット・バー）を歩く |
| 03:14 | `walk1`（EN・JA）: 質問（選択なし・あり）、書き換え、コマンドバー、Quick Actions、パレット、スクラップ検索、検索置換、行へ移動、ヘルプ、About、Mobile Drop、タスクパネル、AI ポップオーバー、右クリックメニュー、設定 | EN は全画面で日本語 0。JA: コマンドバーの送信ボタンの `title` が "Run Command (Enter)"、パレット検索欄の `aria-label` が英語。JA のパレットの説明に `{{ @エージェント ... }}` | ボタンの title は他のバーは翻訳済みなのに、なぜここだけ英語か → app.js を読む（5612・5616 行で直書き） |
| 03:18 | `walk2`: 設定の全 5 タブ、`Show advanced` オン、全 `<details>` と「?」ヒントを開いて収集 | EN: 日本語 0（言語の選択肢の "日本語 (Japanese)" のみ）。JA: AI モデルのタブに英語の placeholder・選択肢（"16:9 (Landscape - Default)"、"4K (4096px - Ultra High Res)" ほか）。切れ・はみ出しは 0 | 選択肢や placeholder は JA でも英語のまま。実用度は低いが漏れ |
| 03:19 | `walk3`・`walk4`: 初回起動（`fresh`、`nosession=1`）の EN・JA: ウェルカムノート、AI の選択画面、AI ポップオーバー、About | ウェルカムノートは両言語とも本文が自然。EN は "Settings > AI Models"、AI ポップオーバーは "Settings › AI Models"（記号が違う）。選択画面は EN・JA とも欠け・切れなし | 記号の不統一は辞書の走査で件数を出す |
| 03:20 | `pairs`・`terms`・`heur`: 用語（Scraps、Delegate、LLM、Zen、メモ/ノート）と記法（`->`、`>`、`›`、`→`、`...`、全角/半角の括弧、cancelled/canceled、Grey/Gray）を辞書全体で数える | 「Scraps / daily scraps / daily notes」「日付ノート / スクラップ / デイリースクラップ / 日次ログ」が同居。EN の「Delegate tab」は存在しないタブ（実際は "Agent"）。Zen が JA で 3 通りの表記。EN の矢印が `->` `>` `›` `→` の 4 通り。JA の括弧は全角 83 件と半角 70 件 | UX レビュー H1〜H3 は未実施のまま。現状の実例として起票 |
| 03:22 | `walk5`: コマンドバーのプリセット（datalist）とボタン、質問バーの失敗表示を 7 種（接続・認証・モデルなし・時間切れ・上限・5xx・その他）× ローカル/クラウド × EN/JA | 失敗の平易な説明は EN・JA とも自然。「詳細」を開くと Go の生の日本語（"ローカルLLM/API接続エラー ..."、"APIエラー (401)"）が EN でも出る（折りたたみの奥）。JA のプリセットは「行を昇順ソート (Sort ascending)」型と「現在の日時」型が混在。JA の送信ボタンの title は "Run Command (Enter)" / "Generate Command (Enter)"（2 回目の再現） | 詳細の生ログは設計どおり。ボタン title は不具合 |
| 03:23 | `walk6`: Go が実際に返す日本語の保存失敗・開く失敗をモックに入れ、Ctrl+S・自動保存・Ctrl+O（EN/JA、各 2 回） | EN: "Save error: ファイルの保存に失敗しました: open C:\...\a.md: Access is denied."、"Open file error: ファイルが見つかりません: ..."。JA は接頭辞が重複（"保存エラー: ファイルの保存に失敗しました: ..."）。自動保存の失敗も同じ | Go 側の日本語エラーは 164 件・19 ファイル。一番効く経路 |
| 03:24 | `walk7`: 1 文字選択（状態バー・質問バー）、`[[ @llm ]]` を Ctrl+Enter、実行中のバッジ、タスクパネル（実行中・完了） | EN: "1 chars"、"Selection: 1 chars"。実行中バッジは EN "Running: 1"、JA "実行中: 1件"。状態バーの処理中表示は EN "AI working (1)... (typing enabled)" と JA "LLM処理中 (1件)... (入力可能)"（AI と LLM）。タスクパネル・経過時間（"2s"/"2秒"）は問題なし。JA のタスク指示文 "summarize this note" は利用者の文字なので対象外 | 複数形と AI/LLM を起票 |
| 03:26 | `walk8`（EN→JA、JA→EN）: 5 つの状況（質問バーの失敗表示、AI ポップオーバー、全タブ一覧、タスクパネル、トースト）から、設定で言語を切り替え、Save | 質問バーは「選択範囲/宛先/ヒント/エラー本文」が旧言語のまま、ボタンだけ新言語（混在）。状態バーの AI 項目のツールチップとタブの閉じるボタンの title が、Save 後も旧言語のまま。JA→EN では "AI: ローカル" の文字自体も残る。5 状況すべてで再現 | Save 後に設定を開き直すと直る所と直らない所を分けたい |
| 03:28 | `walk9`: AI 項目とタブの title を前後で読む（EN→JA を 2 回、JA→EN を 1 回。ポップオーバーを開く/閉じる、別タブをクリック） | Save 後: "AI: local"/"AI model: ..."（EN→JA）、"AI: ローカル"/"AIモデル: ..."（JA→EN）が残る。AI ポップオーバーを 1 回開くと AI 項目だけ直る。タブの閉じる title は別タブをクリックしても直らない。Cancel では元の言語に戻る（`<html lang>` も追随） | 原因の仮説: status_ai.js の描き直しの鍵（`lastKey`）に言語が入っていない。renderTabs が言語切替で呼ばれない |
| 03:29 | `walk10`・`walk10b`: 「新規に日本語で起動した設定ダイアログ」と「英語で起動→日本語に切替（Save 前/後に開き直し）」の全タブ・全選択肢の文字を、多重集合で差分 | Save 前: ショートカット一覧（約 60 語）、Ollama の状態、"Built-in Defaults"、"Not Set"、"Click to assign" などが旧言語のまま。Save して開き直すと、残るのは AI 項目・タブの閉じる title（と JA→EN の aria-label 3 個: 置換・実行 (Enter)・このスロットを実行 (Ctrl+Enter)）だけ | 設定を開いたままの言語切替は、ライブ表示が半端（P3）。Save 後の残りは P2 |
| 03:31 | `fallbacks`: JS が使う全 i18n キーが辞書にあるか、index.html の `data-i18n*` が辞書にあるか | 欠けは 0。辞書に載っているが参照されないキーが 14 個（git ガイドなど。動的に組み立てているかもしれない） | 辞書の外の直書きを探す |
| 03:31 | `walk11`: Go のガードの理由（`pkg/jev/guard.go` の実文字列）をモックの `__onCliCommandGenerated` に返させ、EN・JA でブロック・警告を出す | EN: "Security Block: フォーク爆弾パターンを検知しました (Fork bomb detected)"、警告は接頭辞なしで "find -delete による一括削除を検知しました (find -delete blocked)"。JA でも英語の括弧がそのまま出る。バッジの文字は EN・JA とも "BLOCKED"/"WARN"（直書き） | Go の「日本語 (English)」形式は分割されずに表示される |
| 03:32 | `walk12`: 幅 1120/820/640/480 px × EN/JA × 基本・質問失敗・設定 | 幅 480 px で横スクロール（EN は文書幅 519、JA は質問失敗時に 603）。640 px で周辺ヒントの丸ボタンが「✦ Relea」まで潰れる。JA は「ローカルの Ollama（gemma4:la…」が切れる。最小幅の制限なし（Go に最小サイズなし）。1120/820 px は問題なし | 狭い窓の話。P3 |
| 03:34 | `walk13`: About の更新確認（新しい/最新/失敗）と Help メニュー、"詳細をコピー" の中身（fetch を差し替え） | EN・JA とも文言は自然で、状態ごとに正しい。ヘルプボタンの title も追随。"詳細をコピー" のテキストは意図的に英語 | 良い。"MD-Memo v9.9.9 ... 現在 v1.5.5"（Help）と "バージョン 9.9.9 ... 現在 1.5.5"（About）で "v" の有無が違う程度 |
| 03:35 | `walk14` を実行 → Ctrl+W で全体が固まる（詳細は下のツール欄） | 以後の評価がすべて待ちのまま。ブラウザのプロセスを自分の分だけ止めて後始末 | キットの制限として起票 |
| 03:41 | `dbg1`〜`dbg3`: Ctrl+W の直前直後のターゲット一覧を比較 | Ctrl+W でページのターゲットが 1 → 0 になる。ヘッドレス Edge のアクセラレータがページを閉じる | Ctrl+N も同様に届かない（新規タブが増えない） |
| 03:42 | `walk14`（タブの × ボタンで閉じる版）: 保存確認、パッケージ書き出し、Mobile Drop、プレビュー、分割、Zen | 保存確認は EN・JA とも自然。Mobile Drop: EN "Expires in 60s"、JA "有効期限 60s"（単位 "s" は index.html の直書き）。パッケージの書き出しの画面は、JA でも英語に見えるのは利用者のスキル名（"meeting-minutes" など）だけで問題なし。分割で空のノートを出すと、JA でも副エディタの placeholder は "Type markdown here..."。Zen 中は状態バーが画面外へ出る（意図） | placeholder の直書きを確認 |
| 03:44 | `jalits`: `i18n.js` 以外の JS の日本語の文字列リテラルを一覧 | app.js:3329・3539（バックエンドなしの疑似応答）、5448 付近のプリセット（英日併記）、auto_selector の言い回し（判定用）は意図。voice_input.js、slot_agent.js、slot_snippets.js は自前の EN/JA テーブル | 音声の既定プロンプトが日本語の固定（app.js:82、voice_input.js:12、Go の `DefaultVoicePrompt`） |
| 03:44 | `vals`・`vals2`: 設定の全入力欄の値を EN・JA で調べる（textarea の値は文字ノード収集の対象外だった） | JA: システムプロンプト、Vision プロンプトの既定が英語（想定内）。EN: 通常のキット設定では出ないが、`fresh`（設定なし）にすると `cfg-voice-prompt` が日本語の既定のまま | 初回起動でだけ見える漏れ。2 回確かめる |
| 03:46 | `verify`: V4 初回起動の音声プロンプト（2 回）、V5 分割の副エディタ placeholder、V6 1 文字の複数形、V7 パッケージ失敗の表示、V8 Quick Actions パネル、V9 辞書の `voiceTranscribeTimeout` と F5 | V4: 2 回とも「この音声を正確に文字起こししてください。…自然な日本語テキストのみを出力してください。」。V5: JA で "Type markdown here..."（EN 側の本欄は翻訳済み）。V6: "1 chars"。V7: EN "Export failed: ファイルを開けません / cannot open the file"、JA "書き出しに失敗しました: ファイルを開けません / cannot open the file"。V8: 両言語とも自然（種別タグ Delegate/Run/Write ↔ 任せる/実行/書く）。V9: EN 辞書に "Use [再試行]"。F5 は EN・JA とも "2026/09/18 10:24:00"（新規ノートの見出しは "2026-09-18 10:24"） | 起票する |
| 03:48 | `walk15`: 検索の件数・不一致・不正な正規表現、行へ移動の範囲外、スクラップ検索の空/該当なし、パレットの該当なし、ショートカットの衝突確認 | 件数 "1/2"・"0/0" は言語共通。不正な正規表現の件数表示は "!" だけで説明の title がない（言語の問題ではないが気づき）。衝突確認は EN が `"..."`、JA が『...』で、対象名も EN "Suggest Quick Actions" と JA「アクション候補を表示」で呼び方が違う | 引用符と機能名の不統一は用語欄に足す |
| 03:49 | `walk16`: AI 未設定、クラウド設定済み（送信先の行と同意）、初回の選択画面の 3 ボタン（EN/JA） | 未設定 D3・送信先 I3・同意・選択画面は、EN・JA とも文言が自然で欠けなし。「あとで」は質問バーに戻り、他 2 つは設定を開く | 新機能の言語面は良い |
| 03:51 | `alltabs`: 16 タブの一覧（日本語と英語の長い名前）、`plural`: フォルダを開く（1 件/0 件） | 一覧は EN・JA とも正常で切れなし。EN "Loaded workspace: 1 notes found"、JA "ワークスペース読込完了: 1 件のメモ"（ここだけ「メモ」）。 | 複数形の証拠がそろった |
| 03:53 | `htmllang`・`scrapapp`: 言語切替の Cancel、Go イベント `onScrapAppended` を JA で 2 回 | Cancel で言語は元へ戻る。JA でも "Scrap appended: ls -la"（英語直書き、しかも内部用語 "Scrap"） | 直書きの一覧に加える |
| 03:55 | `speech`: Go の Whisper 部品表の実文字列（`pkg/speech/catalog.go`・`service.go`）を注入して、設定 > AI モデル > 音声エンジン「Whisper」を EN・JA・EN で表示 | EN でも「kotoba-whisper v2.0 量子化版(日本語特化・推奨) (513 MB)」「日本語に特化した高精度モデル。約513MB。…」「ローカル音声認識の実行ファイルが未インストールです」（3 回中 3 回） | Go 由来の日本語表示は、この設定画面でも出る |

## バグ候補

（ID は憲章 ID－連番。重大度は案で、決めるのはナビゲーター。）

### C14-01 Go 側の日本語だけのメッセージが英語 UI にそのまま出る

- 重大度（案）: P2
- 気づきの型: WI
- なぜ気づけたか: 「保存や部品表の文言を作っているのは Go だが、Go は UI の言語を知らない」という内部の作りから、Go が返す実際の文字列を英語 UI に入れてみた。
- 再現手順:
  1. `startExplore({ lang: 'en', notes: [{ title:'a.md', content:'# A\n\nhello\n', path:'C:\\Users\\demo\\Documents\\notes\\a.md' }] })`
  2. `s.setBackend({ saveFile: { fail: 'ファイルの保存に失敗しました: open C:\\Users\\demo\\Documents\\notes\\a.md: Access is denied.' } })`（`app_files.go:431` の実文字列）
  3. 末尾に文字を打ち、Ctrl+S（または 1.5 秒待って自動保存）。`s.state().toasts` を読む。
  4. 同様に `openFile` に `app_files.go:237` の "ファイルが見つかりません: ..." を失敗として入れて Ctrl+O。
  5. 別経路: `getSpeechStatus` に `pkg/speech/catalog.go` と `service.go` の実文字列を返させ、設定 > AI モデルで音声エンジンを Whisper にする（`C14/speech.mjs`）。
- 期待（オラクル）: 英語 UI に日本語の文が出ない（目的: 使う人が読める。前提: `t('saveError')` などの接頭辞は既に訳されている）。日本語 UI でも、"保存エラー: ファイルの保存に失敗しました: ..." のような二重の言い方は避ける。
- 実際: EN の状態バーに "Save error: ファイルの保存に失敗しました: open C:\...\a.md: Access is denied." と "Open file error: ファイルが見つかりません: CreateFile ...:"。JA は "保存エラー: ファイルの保存に失敗しました: ..."（接頭辞と本文が同義で重なる）。Whisper の設定では EN でもモデル名の脇に「日本語特化・推奨」、説明文、"ローカル音声認識の実行ファイルが未インストールです" が出る。Go のファイル内の日本語エラーは `fmt.Errorf`/`errors.New` で 164 件・19 ファイル（`app_files.go`、`app_inputs.go`、`app_config.go`、`app_mobiledrop.go`、`app_discordbridge.go`、`ollama_ops.go`、`pkg/llm/*.go`、`pkg/gitsync/gitsync.go`、`pkg/speech/*.go`、`pkg/slotagent/loader.go`、`pkg/discordbridge/client.go`）。ネイティブのダイアログ名（`app_files.go:255` "ファイルを開く"、`:305` "メモフォルダを選択"、`app_pack.go:295,364,466`）も日本語だけ（キットにネイティブのダイアログがないので画面では未確認）。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · en（ja でも二重表示を確認）
- 再現性: 毎回（EN で 6 回中 6 回: 保存 2、自動保存 2、開く 2。Whisper の表示は EN で 2 回中 2 回、JA でも同じ表示）
- 証拠: `C14/walk6.txt`（保存・自動保存・開くの各 2 回）、`C14/speech.txt`、`C14/en/60-go-error-toast.png`、`C14/en/150-speech-whisper-en.png`、`C14/ja/150-speech-whisper-ja.png`
- 原因の仮説: Go は UI の言語を知らず、`e.message` をそのまま `showMessage` に渡している（`app.js:3826, 3885, 3923` など）。
- 自動テストにできるか: できる。Go 側: 利用者に届くエラーを表にして、種別コードを返す形に変えたうえで、JS 側では「コード → 辞書」の対応が両言語にあることを検査する。現状のままなら、`fmt.Errorf("...日本語...")` を機械で数えて増えたら落ちる検査（棚卸しの回帰防止）は今すぐ書ける。

### C14-02 Go 側の「日本語 (English)」形式の文が、分割されずに両言語で出る

- 重大度（案）: P2
- 気づきの型: OR
- なぜ気づけたか: ガードの「理由」を調べたら、日本語の後ろに英語を括弧で足した文字列を Go が作り、画面はそのまま出していた。EN の画面で日本語が読める＝他の英語の画面と食い違う。
- 再現手順:
  1. `startExplore({ lang: 'en' })`。`window.backend.generateCliCommandAsync` を、`__onCliCommandGenerated(reqID, 'rm -rf /', '', { isBlocked: true, reason: 'フォーク爆弾パターンを検知しました (Fork bomb detected)' })` を返すものに差し替える（`pkg/jev/guard.go:125` の実文字列）。
  2. Ctrl+E → Tab（AI モード）→ 文を入れて Enter。状態バーとバッジを読む。
  3. 警告版: `{ isWarning: true, reason: 'find -delete による一括削除を検知しました (find -delete blocked)' }`（`pkg/jev/guard_ast.go:367`）。
  4. パッケージ: 設定 > Export... → 書き出しが `app_pack.go:30-35` の形式 "ファイルを開けません / cannot open the file" で失敗した場合の表示を読む（`C14/verify.mjs` の V7）。
- 期待（オラクル）: UI の言語で 1 つの文が出る（分割して選ぶ、または Go が言語ごとに作る）。警告と拒否で見た目の文の型が揃う。
- 実際: EN: "Security Block: フォーク爆弾パターンを検知しました (Fork bomb detected)"。警告は "find -delete による一括削除を検知しました (find -delete blocked)"（"High-risk operation detected" のような前置きがなく、バッジは "WARN"）。JA: "セキュリティ制限: フォーク爆弾パターンを検知しました (Fork bomb detected)"（英語の括弧が残る）。パッケージ: EN "Export failed: ファイルを開けません / cannot open the file"、JA "書き出しに失敗しました: ファイルを開けません / cannot open the file"。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · en/ja
- 再現性: 毎回（ガード 4 回中 4 回、パッケージ 2 回中 2 回）
- 証拠: `C14/walk11.txt`、`C14/en/90-cli-blocked.png`、`C14/en/90-cli-warn.png`、`C14/ja/90-cli-blocked.png`、`C14/en/112-pack-error-bilingual.png`、`C14/verify.txt`
- 原因の仮説: 二言語を 1 つの文字列にして返す作り（`pkg/jev/guard.go:122-182`、`guard_ast.go:66-73,234,367`、`app_pack.go:30-35,229,318-337`）に対し、`app.js:3363,5895,5911`・`config_pack.js` が分割せずに表示している。
- 自動テストにできるか: できる。「`日本語 (English)` または `日本語 / English` の形の Go 文字列を、フロントは言語で選んで表示する」関数を作り、その単体テストを JS に置ける。今のままでも、Go 側の該当文字列を機械で拾って件数を固定する検査は書ける。

### C14-03 初回起動の英語 UI で、音声文字起こしの既定プロンプトが日本語（設定に出て、モデルにも送られる）

- 重大度（案）: P2
- 気づきの型: LC
- なぜ気づけたか: 「設定が何もない初回起動」を英語で最後まで見る、という流れで入力欄の「値」を全部読んだ（文字ノードの収集では見えなかった）。
- 再現手順:
  1. `startExplore({ lang: 'en', fresh: true, notes: [] })`
  2. Ctrl+, → AI モデルのタブ → 音声入力の節を開き、`#cfg-voice-prompt` の値を読む。
  3. 通常のキット設定（モックが英語の値を入れている）では出ない。`fresh` でのみ出る。
- 期待（オラクル）: 英語 UI の既定は英語（または言語を限定しない指示）。プロンプトは実際にモデルに送られるので、"日本語テキストのみを出力してください" は英語の話者の文字起こしを日本語にしてしまうおそれがある。
- 実際: 2 回とも「この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。」。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット（fresh）· en
- 再現性: 毎回（2 回中 2 回）
- 証拠: `C14/verify.txt`（V4）、`C14/en/110-fresh-voice-prompt-japanese.png`
- 原因の仮説: 既定値が日本語で固定されている（`frontend/js/app.js:82`、`frontend/js/voice_input.js:12`、`pkg/llm/audio.go:19` の `DefaultVoicePrompt`）。
- 自動テストにできるか: できる。JS: 既定の config の `voice.prompt` が UI の言語に依存する、または言語中立であることを検査する。実際の音声の結果への影響は実機でしか確かめられない。

### C14-04 言語を切り替えたあと、状態バーの AI 項目とタブの閉じるボタンなどが旧言語のまま残る（Save 後も）

- 重大度（案）: P2
- 気づきの型: NV
- なぜ気づけたか: 名詞（状態バーの項目・タブ・質問バー）×動詞（設定で言語を切り替える）の組み合わせを、「新しい言語で起動した画面」との差分で見た。
- 再現手順:
  1. `startExplore({ lang: 'en' })` → Ctrl+,
  2. `#cfg-language` を `ja` にして `change` イベントを起こす（設定の実際の操作と同じ）。
  3. `btn-save-settings` をクリックする。
  4. `#stat-ai` の文字と title、`.tab-close` の title、開いていれば質問バーの各部を読む。
  5. 逆向き（JA→EN）も。
- 期待（オラクル）: `applyLanguage()` のコメントが約束する通り、AI 項目が新しい言語で描き直される。ほかの項目（自動保存・IME・Git）は即座に追随している。
- 実際: EN→JA: "AI: local"、"AI model: gemma4:latest, running on this computer or your network. ..."、"Close (Ctrl+W)" が残る。JA→EN: "AI: ローカル"、"AIモデル: ..."、"閉じる (Ctrl+W)" が残る。AI ポップオーバーを 1 回開くと AI 項目だけ直る。タブの閉じる title は別のタブをクリックしても直らない（タブが作り直されるまで）。質問バーを開いたまま切り替えると、対象チップ・送信先・ヒント・エラー本文が旧言語のままで、ボタンだけ新しい言語（例: "Selection: 11 chars | ... | Can't reach the AI model ..." の隣に「再試行」「AI設定」「詳細」）。JA→EN では `aria-label`（"置換"、"実行 (Enter)"、"このスロットを実行 (Ctrl+Enter)"）も旧言語のまま。設定ダイアログを開いたまま切り替えた場合（Save 前）は、ショートカット一覧と Ollama の状態なども旧言語（Save して開き直すと直る）。Cancel では言語も表示も元に戻る。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · en→ja、ja→en
- 再現性: 毎回（6 回中 6 回: `walk8` の 5 状況＋`walk9` 3 回＋`walk10b` 2 回。同じ結果）
- 証拠: `C14/sw-en.txt`、`C14/sw-ja.txt`、`C14/walk9.txt`、`C14/en/81-switch-popover-en-to-ja.png`、`C14/ja/81-switch-popover-ja-to-en.png`
- 原因の仮説: `frontend/js/status_ai.js` の `drawItem()` が再描画するかを決める鍵（`lastKey`）に言語が入っていない。`applyLanguage()`（`app.js:451`）は `renderTabs()` を呼ばず、`A11y.refresh()` だけでは直書きの title を直せない。
- 自動テストにできるか: できる。`walk10b` の差分（「新規に日本語で起動」と「英語→日本語に切替＋Save＋開き直し」の可視テキスト・属性の多重集合が一致する）を JS のテストにして CI に入れられる。

### C14-05 i18n を通らない直書きの英語が、日本語 UI に出る

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 他のバーやボタンは翻訳されているのに、この画面だけ英語（他の画面との食い違い）。あとで `.title =`・`.textContent =`・`showMessage` の直書きを grep して見つけたものを、画面で確かめた。
- 再現手順（JA で）:
  1. `startExplore({ lang: 'ja' })`、Ctrl+E。送信ボタンの title を読む → "Run Command (Enter)"。Tab で AI モードにして "Generate Command (Enter)"（`app.js:5612,5616`）。
  2. AI コマンド生成がブロック/警告を返す状況（C14-02 の手順）で、バッジが "BLOCKED"/"WARN"（`app.js:5892,5898,5998`）。
  3. `window.onScrapAppended({ fileName, filePath, command:'ls -la' })` → 状態バー "Scrap appended: ls -la"（`app.js:8400`）。
  4. Ctrl+Shift+U（Mobile Drop）→ 有効期限の行が "有効期限 60s"（`index.html:1338` の "s" の直書き）。
  5. Ctrl+\ で分割し、空のノートを副エディタに出す → placeholder "Type markdown here..."（`index.html` の `#editor-secondary`）。
  6. `aria-label` が英語のまま: `#help-menu`、`#quick-pick-modal`、`#scraps-search-modal`（読み上げ用）。`cliExpandTitle` は「コマンド全文プレビュー切替 (Toggle Command Preview)」と日本語＋英語の併記。
- 期待（オラクル）: 日本語 UI に英語の文（の直書き）が出ない。
- 実際: 上記のとおり。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · ja
- 再現性: 毎回（title 2 回、バッジ 4 回、Scrap 2 回、Mobile Drop 2 回、placeholder 3 回）
- 証拠: `C14/ja/04-command-bar.json`、`C14/walk11.txt`、`C14/ja/90-cli-blocked.png`、`C14/ja/104-split.json`、`C14/ja/111-split-empty-placeholder.png`、`C14/ja/12-mobile-drop.png`、`C14/dom-ja-base.json`（`aria-label`）
- 原因の仮説: 直書き（上の行番号）。既に翻訳済みの `tipRunEnter`（"実行 (Enter)"）を `updateCliFilterBarModeUI()` が上書きしている。
- 自動テストにできるか: できる。`app.js`・`index.html`・各モジュールで、`.title =`/`.textContent =`/`showMessage(` に英語のリテラルを直接渡している所を grep する静的テスト、および JA の全画面で英語文が出ないことを見る収集テスト（許可リスト付き）。

### C14-06 設定画面の日本語 UI で、placeholder・選択肢・一部のラベルが英語のまま

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 設定の全タブを「Show advanced」にして全部開いた画面の文字を、JA だけ英語判定で洗った。
- 再現手順: `startExplore({ lang: 'ja' })` → Ctrl+, → 各タブ（`C14/walk2.mjs`）。
- 期待（オラクル）: JA UI で説明的な文が日本語。少なくとも同じ画面の他の項目（日本語）と揃う。
- 実際: placeholder: "sk-... or AIzaSy... (leave empty for local models)"、"gemma4:latest, claude-sonnet-5, gemini-flash-latest etc."、"e.g. qwen2.5-coder:latest"、"(Inherit from Vision/Text) e.g. AIzaSy..."、"https://github.com/username/scraps.git or git@github.com:username/scraps.git"、既定のシステム/Vision プロンプト（英語で当然だが説明の役割）。選択肢: "English (Default)"、"16:9 (Landscape - Default)"、"0.5K (512px - Fast / Draft)"、"2K (2048px - High Res)"、"4K (4096px - Ultra High Res)"、"Gemini Flash Lite (Cloud / Fast & Free Tier)"、"Qwen 2.5 VL (Local Ollama / Top OCR & Diagrams)"、"Gemini 3.5 Transcribe (Recommended)"、"Nano Banana 2 Lite (Fast & Lightweight / Recommended)" など約 20 個。ラベル "API Base URL:"、"API Base URL / Endpoint:"、"Vision API Key (クラウド用):"。JA のプリセット（コマンドバー）は「行を昇順ソート (Sort ascending)」型と「現在の日時」型が混在。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · ja
- 再現性: 毎回（`crawl1` と `walk2` の 2 回）
- 証拠: `C14/ja/30-settings-model.png`、`C14/ja/30-settings-model.json`、`C14/ja/30-settings-options.json`、`C14/dom-ja-base.json`
- 原因の仮説: `<option>`・`<datalist>`・placeholder が `data-i18n*` を持たない、または辞書に日本語がない。UX レビュー H4 の残り。
- 自動テストにできるか: できる（C14-05 と同じ収集テストで、許可リスト方式にする。モデル名・URL は許可）。

### C14-07 複数形が「1 chars」「1 notes found」になる

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 数を差し込む文言に、1 の場合を入れてみた（境界値）。
- 再現手順: `startExplore({ lang: 'en', notes: [{ title:'a.md', content:'x' }] })` → 状態バーの文字数を読む。1 文字選択して Ctrl+L → 対象チップ。`scanFolderFiles` が 1 件を返す状態で Ctrl+Shift+O。
- 期待（オラクル）: "1 char"、"Selection: 1 char"、"1 note found"（一般的な英語）。辞書には既に `packFilesOne: "1 file"` と `packFilesMany` の 2 形式の前例がある。
- 実際: "1 chars"、"Selection: 1 chars"、"Loaded workspace: 1 notes found"。ほかに "(s)" 形式が残る: `agentIssuesStartup`（"{count} agent definition(s) need a look"）、`packResultSecretWarnings`、`mobileDropReceivedFallback`。JA は "1 文字" などで問題なし。
- 環境: 1.10.5 相当（a8bfea5）· Windows 11 · 探索キット · en
- 再現性: 毎回（"1 chars"・"Selection: 1 chars"・"Loaded workspace: 1 notes found" の 3 か所とも、`C14/mini.mjs` で 2 回中 2 回。ほかに `verify.mjs` と `walk7.mjs` でも確認）
- 証拠: `C14/verify.txt`（V6）、`C14/mini.txt`、`C14/plural.txt`、`C14/walk7.txt`
- 原因の仮説: `charCount`・`askTargetSelection`・`folderLoaded` が単複の区別を持たない。
- 自動テストにできるか: できる（辞書のキーで `{count}`/`{n}` を持つものを列挙し、1 の場合の英語が文法的かを人が承認する表を持つ。少なくとも 1 と 2 で出力が変わる形に統一する）。

### C14-08 英語の辞書の `voiceTranscribeTimeout` に日本語が混ざり、案内するボタン名が実際のマーカーと違う

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 辞書の en 側の値に日本語が入っていないか機械で調べたら、これだけが引っかかった。
- 再現手順: `startExplore({ lang: 'en' })` → `I18N.en.voiceTranscribeTimeout` を評価。`voice_input.js` の `tr()` は先に `bridge.t()` を使うので、モジュール内の英語版（"[Retry]"）より辞書のこの値が表示される。
- 期待（オラクル）: "Use [Retry] in the note ..."。英語のノートには `[Retry(id:xxxx)]` と書かれる（`voice_input.js` の `ANCHOR_WORDS.en.retry`）。
- 実際: "No answer to the transcription. Use [再試行] in the note to send it again."（英語のノートに "[再試行]" はない）。
- 環境: 1.10.5 相当（a8bfea5）· 探索キット · en
- 再現性: 毎回（辞書の読み取り 2 回。この文言が出る経路そのもの＝録音後 90 秒近い待ちは、キットでは確かめていない）
- 証拠: `C14/verify.txt`（V9）、`frontend/js/i18n.js:629`
- 原因の仮説: 翻訳の取り違え。
- 自動テストにできるか: できる（辞書の en に日本語文字が入っていない、という一行のテスト。今は 1 件だけなので、直せば以後 0 に固定できる）。

### C14-09 用語・記法の不統一（UX レビュー H1〜H3 は未実施のまま。現状の実例）

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 辞書全体を数え、同じ概念の名前と記号を並べた。
- 再現手順: `C14/heur.mjs`、`C14/pairs.mjs "<正規表現>"` を実行。
- 期待（オラクル）: 一つの概念に一つの名前と一つの記号（UX レビュー H1〜H3、docs 内の用語集）。
- 実際（主なもの）:
  - 日付ノート: EN "Scraps"（ボタン "Search All Scraps"）、"daily scraps"（検索欄 "Search daily scraps in milliseconds..."）、"Daily notes"（About・パレット）、JA「スクラップ」「日付ノート」「デイリースクラップ」「日次ログ」。
  - 存在しない参照: EN の `modelSummaryRowActions` は "Delegate tab" と言うが、設定のタブは "Agent"。JA のタブ名「連携」は Git 連携（「連携中」「連携 / 初期化」）・OS 連携・エージェントの 3 つの意味に使われている。
  - 「LLM」と「AI」: EN の状態バーは "AI working (1)..."、JA は「LLM処理中 (1件)...」。トーストも EN "LLM response inserted" と JA「LLMの回答を挿入しました」。ボタンは "AI settings"、タブは "AI Models"、文言は "the AI model"。
  - Quick Actions の呼び方: EN "Quick Actions"/"Suggestions"/"Suggest"、JA「提案」「アクション候補」「クイックアクション」。ショートカット衝突の対象名は EN "Suggest Quick Actions"、JA「アクション候補を表示」。
  - Zen: JA「集中(Zen)モード」「集中（Zen）モード」「集中モード (Zen Mode)」。EN "Zen Mode" と "Zen mode"。
  - 「メモ」と「ノート」: JA の "ワークスペース読込完了: 1 件のメモ" だけ「メモ」。
  - 設定への道: EN で `Settings -> AI Models`、`Settings > Agent`、`Settings › AI Models`、`Settings → AI Models` の 4 通り（`askLlmNotConfigured`、`agentIssuesStartup`、`statAiTitleNotSet`、`pasteImageSavedNoVision`）。JA も「設定 → 連携」と「設定 › 一般」が混在。
  - 引用符・綴り: JA の引用が「」・『』・"" の 3 種。EN の "Grey text" と "Gray (white background)"、"cancelled" と "Canceled"。`...` が 59 件、`…` が 2 件。JA の括弧は全角 83 件と半角 70 件。
  - JA のパレットの説明に `{{ @エージェント ... }}`。動く記法は `{{ @agent ... }}`（記法の例は訳してはいけない）。
- 環境: 1.10.5 相当（a8bfea5）· 探索キット · en/ja
- 再現性: 毎回（辞書の静的な事実。パレットの `{{ @エージェント ... }}` は JA の実画面で 3 回。パレットの項目 44 個に tooltip は 0 個で、省略された説明の続きを読む手段がない）
- 証拠: `C14/ja/06-palette.json`、`C14/mini.txt`（パレットの説明と tooltip 数）、`C14/heur.mjs`・`C14/pairs.mjs`（辞書の走査。`node heur.mjs` で再実行できる）
- 原因の仮説: 用語集が未確定（UX レビュー H1・H2・H3 が未実施）。
- 自動テストにできるか: 一部できる（禁止語の grep、`{{ @` の後ろが `agent` であること、矢印の記号を 1 つに限る）。用語の決定自体は人の判断。

### C14-10 日付の書式が場面ごとに違い、一部は UI の言語ではなく OS のロケールに従う

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 「日付・数の書式」を、挿入・見出し・ファイル名・インポート情報で見比べた。
- 再現手順: `startExplore({ lang: 'en' or 'ja', notes: [{ title:'a.md', content:'' }] })` → F5。
- 期待（オラクル）: 同じ日時は同じ形（ノートの見出し "2026-09-18 10:24"、保存名 "2026-09-18_..."）。表示は UI の言語に従う。
- 実際: F5 は EN・JA とも "2026/09/18 10:24:00"（スラッシュ）。新規ノートの見出しとタブ名は "2026-09-18 10:24"（ハイフン）。設定パッケージのインポートの作成日時は `d.toLocaleString()`（`config_pack.js:812`）で、UI の言語ではなくブラウザ（OS）のロケールで表示される（キットのブラウザは en-US なので、JA の UI に "9/30/2026, 10:24:00 AM" が出る見込み。インポートの画面までは実行しておらず、コードの読みのみ）。
- 環境: 1.10.5 相当（a8bfea5）· 探索キット · en/ja
- 再現性: 毎回（F5 は EN・JA で 2 回。ロケール部分は未実行）
- 証拠: `C14/verify.txt`（V9）
- 原因の仮説: `getFormattedDateTime('standard')` の書式と、見出しの書式が別。`toLocaleString()` はロケール指定なし。
- 自動テストにできるか: できる（`getFormattedDateTime` の書式を固定するテスト。`toLocaleString()` を UI の言語で呼ぶ形に）。

### C14-11 狭い窓（480 px 前後）で横スクロールが出て、ヒントの丸ボタンが潰れる

- 重大度（案）: P3
- 気づきの型: ENV
- なぜ気づけたか: 日本語のほうが長い文言のため、狭い幅で言語による差が出ないかを幅の走査で見た。
- 再現手順: `startExplore({ lang, viewport: { w: 480, h: 700 } })`。基本の画面、質問失敗（Ctrl+L → Enter）、設定を順に開く（`C14/walk12.mjs`）。
- 期待（オラクル）: 画面が横に溢れない（UX レビューの良い点に「800px でも横あふれしない」がある）。最小幅の制御があるか、または崩れない。
- 実際: EN は文書幅 519 > 480。JA は質問失敗時に 603 > 480（状態バーの「タスク: 失敗」「自動保存: ON」が右に出る）。640 px の設定で周辺ヒントのピルが "✦ Relea" まで潰れる（EN・JA とも）。JA の送信先「ローカルの Ollama（gemma4:la…」が切れる。JA の Mobile Drop では「同一Wi-\nFi/LAN上」「別\nWi-Fi」と Wi-Fi の途中で折れる（`C14/ja/12-mobile-drop.png`）。1120/820 px では問題なし。ウィンドウの最小サイズは Go に設定がない。
- 環境: 1.10.5 相当（a8bfea5）· 探索キット（ヘッドレスの 480 px）· en/ja
- 再現性: 毎回（EN・JA とも 2 回ずつ）
- 証拠: `C14/walk12.txt`、`C14/ja/95-w480-ask-failed.png`、`C14/en/95-w640-settings.png`
- 原因の仮説: 状態バーが折り返さず、ピルの `flex-shrink` が強い。
- 自動テストにできるか: できる（幅 480/640 で `scrollWidth <= innerWidth` を確かめる収集テスト）。実機の最小幅の扱いは人が決める。

### C14-12 （道具の問題）探索キットで Ctrl+W を送ると、ページごと閉じてセッションが固まる。Ctrl+N も届かない

- 重大度（案）: P3（アプリの不具合ではない）
- 気づきの型: ENV
- なぜ気づけたか: 保存確認のダイアログを撮ろうとして、Ctrl+W のあと `s.ev('1+1')` が返らなくなった。
- 再現手順: `startExplore({ lang:'en', notes:[{ title:'a.md', content:'# A\n', path:'C:/x/a.md' }] })`。`Target.getTargets`（ブラウザ側）でページの数を数え、`s.key('w', { ctrl:true })`、もう一度数える。
- 期待（オラクル）: キットの README に「Cmd+C/X/V は擬似クリップボードで動く」とあるように、ブラウザが先取りするショートカットも擬似で処理される、または README に制限がある。
- 実際: ページのターゲットが 1 → 0。以後の `s.ev` はすべて待ち続ける（time-out もしない）。Ctrl+N は新規タブを作らない（アプリに届かない）。Ctrl+T、Ctrl+Shift+T/N/W、Ctrl+Tab、Ctrl+PageUp/Down も同様と思われる（未確認）。
- 環境: 探索キット（ヘッドレス Edge 154）
- 再現性: 毎回（3 回中 3 回）
- 証拠: `C14/dbg1.mjs`〜`dbg3.mjs`（`dbg3` の出力: 前 1 件・後 0 件）
- 原因の仮説: ヘッドレス（new）の Edge が Ctrl+W をブラウザのアクセラレータとして処理する。
- 自動テストにできるか: できる（`tests/explore_kit_test.mjs` に `keyEvents('w', {ctrl:true})` を「DOM へのキー発行」に切り替える案、または README の一覧に載せる）。回避策: `.tab-close` のクリック。

## 気づきの型の内訳

NV: 1 件 / LC: 1 件 / WI: 1 件 / OR: 7 件 / RC: 0 件 / ENV: 2 件（計 12 件。ID は C14-01〜C14-12）

## 見て問題がなかった所（探した結果、見つからなかった）

- 辞書: 944 キーの en/ja の過不足、差し込み `{...}` の不一致、`data-i18n*` の欠落は 0。EN の全画面（パレット、設定の全タブ、About、Mobile Drop、パッケージ、保存確認、タスクパネル、AI ポップオーバー、全タブ一覧、右クリック、初回の選択画面）で、日本語が漏れているのは C14-01〜C14-03、C14-08 の Go 由来・初回・辞書の 1 件だけ。
- 新機能の言語面: ウェルカムノート、AI の選択、AI 未設定の案内、送信先の行と同意、失敗の平易な説明（7 種）、更新確認の 4 状態と Help メニュー、About、更新確認のスイッチの文言、全タブ一覧は、EN・JA とも自然で切れがない。
- 単位: タスクの経過時間（"2s" と "2秒"、"1m 5s" と "1分5秒" の形）、"件"、"文字" は正しい。
- 切れ・はみ出し: 1120/820 px では、はっきりした切れはパレットの説明の省略記号（意図）と、長いタブ名の省略（意図）だけ。パレットの説明は、EN・JA とも長い項目で肝心の後半が省略される（例: 結果の確定の説明が "... such as [[ @llm ..." で終わる）。項目 44 個に tooltip が 0 個で、続きを読めない。C14-09 の再現性欄に一言だけ残した（独立した起票にするかはナビゲーターの判断）。

## 振り返り（5 分）

- 学んだこと（次に同じ型で探すときのヒント）: 辞書自体は堅い（差異ほぼ 0）。漏れは「継ぎ目」にある: Go 由来の文字列、直書きの title・バッジ・トースト・単位、欄の値（textarea の既定値は文字ノード収集では見えない）、属性（`aria-label`・`placeholder`）、そして言語をライブで切り替えたときの描き直し漏れ。今後の C13（読み上げ・aria）は同じ収集（属性込み）をそのまま使える。
- 次にやる憲章: C6（設定の一生: 言語切替＋Save＋差分保存を組み合わせる）、C9（初回起動。`nosession=1` を使うと本物のウェルカムノートが出ると分かった）、C13（aria-label の言語と、Tab の届き方）。
- 自動テストにできるもの: (1) 全画面を EN・JA で開き、文字ノード・属性・入力欄の値・選択肢に、逆の言語が出ないことを見る収集テスト（許可リスト付き）。(2) 「新規に日本語で起動」と「英語→日本語に切替＋Save＋開き直し」の DOM の多重集合が一致する差分テスト（C14-04 を直接捕まえる）。(3) `.title =`/`.textContent =`/`showMessage(` に英語リテラルを渡す直書きの grep。(4) 辞書の en に日本語文字がない、`{count}` を持つキーは 1 の場合も文法的か。(5) Go 側の日本語エラーの件数を固定し、UI に届く経路はコード化する。
- うまくいかなかったこと（道具・進め方）: (a) 探索キットで Ctrl+W がページを閉じて固まる（C14-12）。(b) `| head` で長い出力を切ると、スクリプトの結果がまとめて遅れて見え、固まりとの区別が付かなかった。ログは必ずファイルに書く。(c) ヒアドキュメントで正規表現の `\s` や `\b` が消える事故が 2 回あり、スクリプトは Write で作る運用に切り替えた。(d) 私の判定器は「AI: local」のような英単語 1 つの文を英文と見なさない（言語判定は 2 語以上）ので、差分（多重集合）のほうが確実だった。(e) 並走する他のセッションのブラウザが同じ一時フォルダに多数あり、固まった自分の分だけを、プロファイル名と作成時刻で特定して止めた。

## 範囲外・未確認

- macOS の文言（⌘ など）、実 WebView2 での IME・フォント、Windows の表示言語（OS が日本語のときの `navigator.language` による初期言語）、ネイティブのダイアログ（Go 側のタイトルは日本語のみ。`app_files.go:255,305`、`app_pack.go:295,364,466`）、トレイ、クイックキャプチャ、Mobile Drop のスマホ側ページ、`md-memo-cli` の出力、`manual.html`/`manual_ja.html`、Git 同期・Discord・Whisper の実行時の状態文言、音声入力の一連の流れ、ゴースト、スクリーンリーダー。
