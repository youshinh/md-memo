# セッション 2026-09-30: C9 初回体験（新規インストール相当、AI 未設定、Ollama なし）

- 憲章: 初回体験（config なし・セッションなし・モデルなし・Ollama なし）の新規の人として、ようこそノート、AI の選択画面、ステータスバーの AI 項目、モデルなしの質問バー、設定 > AIモデル、パレット、ヘルプの入口、About を通して、行き止まり・画面同士の食い違い・分かりにくい言葉を見つける。あわせて既存ユーザー（config あり）で新しい案内が出ないことを確かめる
- 時間: 終了 03:41（開始時刻は記録していない。約 30 分と推定）。スクリプト 34 本、操作 約 150 件
- ナビゲーター: 呼び出し元（リード） / ドライバー兼記録係: Claude Code Sonnet 5.5
- 環境: 版 1.10.5（HEAD a8bfea5。作業ツリーには他セッションの未コミット変更あり。キットは作業ツリーの `frontend/` をそのまま動かした）/ Windows 11 / 道具: 探索キット `tools/explore`（ヘッドレス Edge + モックのバックエンド）+ 自作の補助（証拠フォルダの `lib.mjs`）/ 英語 UI と日本語 UI
- 範囲外（やらないこと）: 実アプリ・実 config・実クリップボード・実 Ollama・実 winget。ソースとテストの編集（修正はしていない）。IME、macOS、実 WebView2 の窓、スクリーンリーダー、Mobile Drop と hot folder の初回、CLI 経由の最初の起動
- 証拠: `C:/Users/yoush/AppData/Local/Temp/claude/C--Users-yoush-Documents-md-memo/c56620cc-7e7e-498b-a7c7-c4a14c374db1/scratchpad/explore/c9/`（以下 EV。`tNN.mjs` が各スクリプト、`*.png` が画像、`*.json` がパレット一覧と About のダンプ、`lib.mjs` が共通の補助）

## 進め方のメモ

- 質問: 「config も履歴もモデルもない人が、最初の 10 分で何を見て、どこで詰まり、画面同士は同じことを言っているか」。
- **新規の人の状態の作り方（重要）**: キットの `fresh: true` だけでは初回起動にならない。README は「初回起動の状態」と書くが、実際は `?fresh=1` だけでセッションが残るため 2 回目の起動の状態（日付見出しのノート、ようこそなし。`getSession` は空でない）になった（en / ja の 2 回で確認、C9-16）。そこで `startExplore({fresh: true})` のあとに `/?lang=..&fresh=1&nosession=1` へ開き直し、初期化スクリプトで `checkOllamaRunning` を `false`（Ollama なし）にした。`lib.mjs` の `brandNew()`。
- モックの限界: ローカル LLM は台本で失敗させた（`fail`、既定の「接続拒否」の日本語 1 行 = Go が返す文と同じ形）。ゴースト（入力予測）の失敗は `autocompleteAsync` を差し替えて Go の `Ollama接続エラー (...)` をそのまま返した。Ollama 導入（`setupOllamaGemma4Async`）はモックが何もしないので、`ollama_ops.go` が送る文字列をそのまま `__onOllamaSetupProgress` に渡して再現した。`detectLLMProvider` はモックが常に `ollama` を返すので、設定の「Protocol: Ollama」表示は判断に使っていない。`getGitRepoStatus` は常に「リポジトリあり」を返すので、Git の設定画面の状態も使っていない。
- 「2 回目の起動」は、1 回目に `saveConfig` へ渡された部分 JSON（`{"general":{"toolbarLayout":..,"welcomeShown":true}}`）を、`getConfig` の障害注入（`result`）でそのまま返して再現した（t11）。
- 罠にはまった点（アプリの不具合ではない）: (1) 私のスクリプトで Ctrl+W を押すと、ヘッドレス Edge がタブごと閉じて以後の CDP 呼び出しが永久に戻らない。ブラウザが 2 つ残ったので、プロファイル名で自分の分だけを止めて消した（C9-16）。(2) ヒアドキュメント内の `\s` を正規表現にすると `s` が空白に化けて見えた（テキストの `s` が抜けて見える）。スクリプトの書き方の問題だった。

## ログ（時系列）

`tNN` は EV のスクリプト。

| 時刻 | 操作 | 観察 | 疑問 · 次の一手 |
|---|---|---|---|
| t01 | 新規の人（en）で起動 | タブは「Welcome」1 つ（1340 字、未保存扱いではない）。ツールバーは 7 個（Help なし）。ステータスバー「Git: Ready / AI: local / Autosave: ON」 | ようこそ本文と画面は合っているか。「AI: local」は本当か |
| t01 | 同じことを ja で | 「ようこそ」811 字、日英で構成が同じ。ステータスバー「AI: ローカル」 | 日本語の漏れはない |
| t02 | Ctrl+L（Welcome の 1 行目、選択なし） | 質問バー。対象「Current line」、送り先「Local Ollama (qwen2.5:latest)」、その下に選択の帯「Where should the AI run? … Set up a local model (Ollama) / Use a cloud key / Later」。設定は開かない | 送り先は既に決まっているのに「どこで動かすか」と聞く |
| t02 | 「translate to Japanese」→ Enter（Ollama なし） | 帯が失敗の帯に替わる: 「Can't reach the AI model at localhost:11434. Is Ollama (or your model server) running?」＋ Retry / AI settings、詳細は折りたたみ。`aiChoiceMade` が true に。ノートの文字は同じ。だがタブに ● が付く | 文字が同じなのに未保存？（後で t32） |
| t03 | 選択の帯の 3 ボタンを実マウスで（3 セッション並列） | 「ローカル」: 設定が開き `btn-setup-ollama`（「Install Gemma 4」）にフォーカス。「クラウド」: 設定 > AIモデルの APIキー欄にフォーカス、URL は http://localhost:11434 のまま。「Later」: 帯が消え、バーは開いたまま。3 つとも `aiChoiceMade` = true。Esc でどれも編集画面に戻る（フォーカスは editor） | ローカルの行き先が「Gemma 4」？ クラウドは URL が Ollama のまま |
| t04 | 「クラウド」→ API キー欄に `sk-proj-…` だけ貼って Save → Ctrl+L → 実行 | 設定は URL/モデルが localhost:11434 / qwen2.5 のまま、キーだけ入る。ステータスは「AI: local」、送り先は「Local Ollama」。同意の確認は出ない。実行すると「Can't reach the AI model at localhost:11434. Is Ollama … running?」。LLM へ渡る設定にキーが入っている | クラウドのつもりで、実際はローカル宛て（C9-04） |
| t05 | ようこその末尾で普通に文字を打つ（AI は一度も呼んでいない）。ゴーストの要求は Go と同じ失敗 | 打ち終えて約 1 秒でステータスバーが赤い「AI: error」に。ツールチップとポップオーバーに `Ollama接続エラー (http://localhost:11434): Post "…/api/generate": dial tcp … connectex: No connection could be made because the t…`（160 字で途中切れ）。ja も同じ（「AI: エラー」）。ポップオーバーのスイッチ（入力予測・提案・音声の整形）は全部オン | 質問バーの失敗は平易なのに、こちらは生（C9-05） |
| t06 | 設定でクラウド URL・モデルだけ入れて（キーなし）Save | 「AI: not set up」（琥珀）。質問バーは「No AI model is set up yet. [Set up]」、Run は無効、送り先の行は消える。Enter は無視され、フォーカスが「Set up」に移る | モデルなしの道はある |
| t06 | 同じ状態で Ctrl+Enter | トースト「LLM is not configured (Settings -> AI Models)」 | バー・ステータスの文と言い方が違う（C9-11） |
| t06 | 「Set up」をクリック | 設定が「AIモデル」で開く。フォーカスは「General」タブのボタン。Text LLM の欄へはスクロールされない | 選択の帯の「クラウド」は APIキー欄にフォーカスした（C9-12） |
| t06 | 琥珀の「AI: not set up」をクリック | 直接、設定 > AIモデルが開く（ポップオーバーなし） | 設計どおり |
| t06 | Tab を 5 回 | 「Set up」から次の Tab でバーの外（editor）に出る。以後の Tab は editor に入り、ノートに空白が入る（バーは開いたまま） | パネルは非モーダルの設計か。要判断（未再現の欄へ） |
| t07 | Ctrl+Shift+P（en / ja） | 39 項目。「Settings」「Keyboard shortcuts」「Help and manual (web)」「About MD-Memo」がある。検索: help → 1 件、about → 2 件。**model / setup / ollama / api key / cloud / language / theme / toolbar / git / close / welcome / update → 該当なし** | ようこそは「Every command is there」と言う（C9-09） |
| t08 | 起動して 3 秒待つ → パレット → About | 3 秒後に `api.github.com` への要求が 1 件（モックが遮断。実機なら実際に出る）。About: 「Updates: Could not reach GitHub…」（その起動時の確認の結果）、フォルダ 3 行、リンク、「This build is not code-signed…」。文言「The start-up check can be turned off in Settings › General」 | 設定のスイッチは実在するか |
| t09 | 設定の各タブ（en） | General / AI Models / Agent / Sync / Shortcuts。ようこそが挙げる「Settings > AI Models」「Settings > Sync」は実在。Sync にデイリーノートのフォルダ欄がある（簡易表示で見える）。General に「Check for updates at start-up」（既定オン） | ようこその案内と画面は合う |
| t10 | 「Show advanced」の前後 | フォルダ欄・更新確認・言語は簡易表示で見える | 問題なし |
| t11 | 1 回目の起動が書いたものを回収し、2 回目の起動を再現（en） | 書いたのは `saveConfig` 1 回（`general.toolbarLayout` と `welcomeShown`）と `saveSession`。2 回目: ようこそは通常のタブとして復元、追加なし。ツールバーは 7 個のまま（10 個隠す）。設定は既定で補われ、`aiChoiceMade` は false のまま | 良好（この道の問題なし） |
| t12 | 未保存のようこそを編集して 2.5 秒待つ | `saveFile` は呼ばれない（自動保存はパスのあるノートだけ）。セッションだけ保存。ツールチップ「saved files are written 1.5s after…」。Ctrl+S は名前を付けて保存へ | ステータス「Autosave: ON」は未保存ノートには効かないが、ツールチップが正直 |
| t13 | ステータスバーの「Git: Ready」をクリック（en / ja） | トースト「Git sync started」/「Git同期を開始しました」。Go の `executeSync` は Git リポジトリでなければ何も通知せず戻る（コード確認）。ラベルは「Ready」/「待機中」のまま | Git を設定していない人に「Ready」（C9-07） |
| t14 | Ctrl+P（プレビュー）→ Ctrl+L | ようこそが整形表示（見出し 5 つ、コード 12）。バーは開き対象は「Current line」（隠れたエディタの行）。ja も同じ | プレビュー中の対象が見えない（C3 の範囲。問題として扱わない） |
| t15 | プレビューのまま質問（成功） | 答えは 1 行目の見出しの下に 1 回入り、プレビューも更新される | 問題なし |
| t16 | 既存ユーザー（kit 既定 config: gemma4:latest）で起動 | ようこそなし、タブ 3 つ、ツールバー 16 個、ステータス「AI: local」、Ctrl+L で選択の帯なし、`saveConfig` 0 回 | 新しく邪魔するものなし |
| t17 | 既存ユーザーで qwen2.5:latest（未変更の既定）のとき Ctrl+L → Esc を 3 回 | 3 回とも選択の帯が出る（`aiChoiceMade` は false のまま）。Ctrl+K（書き換え）の帯にも、Ctrl+Enter の指示バーにも出る | 実行するまで毎回（C9-10） |
| t17 | 既存ユーザーで `restoreSession: false`・ノートなし | ようこそなし。日付見出しのノート 1 つ | 問題なし |
| t18 | fetch を差し替えて最新版 v9.9.9 を返す。新規 / 既存 / 更新確認オフ | 新規（Help ボタンなし）: 2.5 秒後にトースト 1 回「MD-Memo v9.9.9 is available. See About MD-Memo in the command palette.」。既存: Help ボタンにバッジ、トーストなし。オフ: 起動時の要求 0 回。About > Check now は動く（「Version 9.9.9 is available. You have 1.5.5.」） | 更新確認は設計どおり |
| t19 | 「ローカル」→「Install Gemma 4」を押し、成功を通知 | 進捗ボックス。成功で `text.model` と `autocomplete.model` が `gemma4:e2b` に、保存される。トースト「Gemma 4 E2B setup completed successfully!」。設定の Cancel を押しても戻らない。質問バーの送り先は「Local Ollama (gemma4:e2b)」に | ステータスバーは？ |
| t20 | 同じ手順で、ステータス項目のツールチップを見る | インストール直後も、設定を閉じた後も「AI model: qwen2.5:latest, …」のまま。項目をクリックするとやっと gemma4:e2b に（C9-08） | |
| t21 | 進捗に Go の文言をそのまま渡す（A / B の 2 セッション） | 英語 UI の進捗行が「Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...」。失敗時は行が「Ollamaのインストールに失敗しました」のまま、トーストは「Setup failed: exit status 1: 'winget' is not recognized …」（C9-03） | |
| t22 | 失敗した質問のあとのタスク項目 | 「Task: Failed」、ツールチップ「Running tasks: 1 (Alt+T …)」。9 秒後に消える。開いたパネルは 0 件（C9-15） | |
| t23 | 選択の帯をキーボードだけで | Tab の順は 入力 → Run → ✕ → ローカル → クラウド → Later。Later を Enter で押すと帯が消えフォーカスは入力欄へ。クラウドを Space で押すと設定が開き APIキー欄にフォーカス、Esc で editor に戻る。幅 560 × 高さ 420 でもバーは 16〜544 px に収まる | 問題なし |
| t24 | 起動直後に Ctrl+Z / Ctrl+Y、全選択 → Delete → Ctrl+Z | ようこそは消えない。削除は元に戻る | 問題なし |
| t24 | 日付ノート検索（結果 0 件） | 「No matching lines in your daily scraps」 | 平易 |
| t24/t25 | 設定で言語を en→ja（ja→en）にして保存（新規 2 回、既存 1 回） | Git と Autosave は切り替わるが、AI 項目は「AI: local」とツールチップが英語のまま。AI 項目のポップオーバーを開閉すると直る | C9-08 |
| t26 | 古い config（toolbarLayout なし、welcomeShown なし）の既存ユーザー | ようこそなし、ツールバー 16 個、`saveConfig` 0 回。Ctrl+L で選択の帯が 1 回出る（A2 の設計どおり）。text モデル空の人は琥珀の「AI: not set up」 | 問題なし（設計どおり） |
| t27 | config.json あり・WebView の保存領域だけ消えた人 | ようこそなし、ツールバー 16 個、「AI: cloud」 | 問題なし |
| t28 | About: 「Open」（失敗させる）、「Copy details」、パレットの Help | 「Could not open the folder. It may not exist yet.」（平易）。コピーにはキーや設定の中身なし。Help は https://youshinh.github.io/md-memo/ を開く | 問題なし |
| t29 | C9-04 の 2 回目（ja）、C9-11 / C9-12 の 2 回目、パレット追加語 | すべて再現。パレット: ollama / api key / cloud / language / theme / toolbar / git / close は該当なし | |
| t30 | Ctrl+J（提案）: 正常 / モデルなし / 新規 | 3 つとも何も出ない（モックの Jev は候補 0）。差は判断できない | 判断に使わない |
| t31 | 失敗した質問のタスク項目（既存 en / 新規 ja） | どちらもツールチップ「Running tasks: 1」/「実行中タスク: 1件」で、ラベルは失敗 | C9-15 が 3 回目 |
| t32 | 失敗した質問（内容は同じ）のあと、タブの ✕ で閉じる（4 種類のノート） | 4 つとも「Do you want to save changes to "…"?」（ようこそ en / ja、未保存ノート、保存済みノート）。中身は変わっていないのに ● が付いたまま | 初回に最も当たる（C9-01） |
| t33 | `startExplore({fresh:true})` だけで起動（en / ja） | 日付見出しのノート 1 つ、ようこそなし、`getSession` は空でない | キットの説明と違う（C9-16） |

### 既存ユーザーで新しく邪魔になるものがあるか（結果）

| 確かめたこと | 結果 |
|---|---|
| config あり + セッションありで起動 | ようこそなし、`saveConfig` なし、ツールバーは全アイコン（t16、t26） |
| config あり + セッションなし（`restoreSession: false`、WebView の保存領域が空） | ようこそなし（t17、t27） |
| 古い config（新しい鍵が何もない） | 何も書き込まない。ステータス項目は「AI: local」（t26） |
| テキストモデルが未変更の既定（qwen2.5 + Ollama） | 選択の帯が質問バー・書き換えバー・Ctrl+Enter の指示バーに、**実行か 3 ボタンを押すまで毎回**出る。Esc では記録されない（C9-10）。設計に書かれた振る舞い |
| テキストモデルが空 | 琥珀の「AI: not set up」がずっと残る。押すと設定へ。消す方法はモデルを設定するまでない（設計どおり。気になる人がいるかは要判断） |
| 更新の案内 | 既存は Help ボタンのバッジだけ（トーストなし）。起動時の確認は設定でオフにでき、オフなら要求 0 回（t18） |
| 質問が失敗したあと | 中身が同じノートに「保存しますか」が出る（C9-01）。既存ユーザーにも起きる |

## バグ候補

ID は C9-連番。重大度は案（決めるのはナビゲーター）。証拠は EV の相対パス。再現回数は、独立したセッションで同じ結果を得た回数。

### C9-01 失敗した質問のあと、中身が同じノートに ● が付き、閉じると「保存しますか」が出る（初回は「ようこそ」で当たる）

- 重大度（案）: P2 ― 初回の最初の操作（Ctrl+L → 失敗 → タブを閉じる）で必ず当たる。データは失わないが、変えていないノートに保存を問う
- 気づきの型: LC
- なぜ気づけたか: 新規の人の最初の 5 分（質問 → 失敗 → 閉じる）を最後まで追った。t02 で失敗のあとタブに ● が付いていたのを疑問として残し、閉じる操作まで進めた
- 再現手順:
  1. 新規の人の状態で起動する（ようこそが開く。● なし）。
  2. Ctrl+L、「translate」、Enter（Ollama がなく失敗する）。
  3. Esc でバーを閉じ、タブの ✕ をクリックする。
- 期待（オラクル）: 失敗した質問は「ノートは変わらない」（UX review D1 のコミットの題、質問バーの文言 `llmErrOther`「ノートは変わっていません」）。変わっていないノートを閉じても確認は出ない
- 実際: 内容は一文字も違わないのに `isModified` が true のまま（タブに ●）。✕ で「Do you want to save changes to "Welcome"?  Save / Don't Save / Cancel」（ja は「"ようこそ" への変更内容を保存しますか？」）。パスのあるノートでは自動保存が同じ内容を書き直す
- 環境: 1.10.5 (a8bfea5) · Windows 11 · 探索キット · en / ja
- 再現性: 毎回（4 回中 4 回: ようこそ en、ようこそ ja、未保存ノート、保存済みノート）
- 証拠: `t32.mjs`、`t32-brand-new-Welcome.png`、`t02-askbar-fail.png`（● が見える）
- 原因の仮説: `executeInlinePromptQuery` がアンカー挿入時に `curTab.isDirty = true` にし、`__onLLMResult` の失敗経路（`applyAnchorReplacement`）が挿入前の状態に戻すだけで、`isDirty` を元に戻さない
- 自動テストにできるか: できる（`tests/ask_and_command_bar_test.mjs` か `tests/ai_lifecycle_fuzz_test.mjs` の不変条件に「失敗が決着したら、文字が同じなら isDirty は質問前と同じ」を足す）

### C9-02 「ローカルモデル（Ollama）を設定」が着く先は「Install Gemma 4」だけで、質問バーの qwen2.5 と食い違い、成功するとモデルが黙って替わる

- 重大度（案）: P2 ― 初回の主導線（選択の帯の一番目のボタン）で、何が入るかの説明がなく、画面ごとにモデル名が違う
- 気づきの型: OR
- なぜ気づけたか: 3 つのボタンを実マウスで押し、着いた先の文言と、押す前に見えていた文言（送り先の行）を突き合わせた
- 再現手順:
  1. 新規の人で Ctrl+L。送り先は「Local Ollama (qwen2.5:latest)」、帯は「Set up a local model (Ollama)」。
  2. その帯のボタンを押す。設定 > AIモデルが開き、ローカルAI（Ollama）カードの「Install Gemma 4」にフォーカスが行く。カードの説明は他にない。
  3. 押すと（`ollama_ops.go` の実装）: winget で Ollama を入れ、サービスを起動し、約 2.5 GB の `gemma4:e2b` を取得する。成功の通知が来ると `config.text.model` と `config.autocomplete.model` が `gemma4:e2b` に替わり、保存される（t19）。
- 期待（オラクル）: 他の画面（送り先の行、ステータスバー、設定のモデル名欄）と同じ名前で話す。入れるもの（Ollama 本体、モデル、約 2.5 GB、数分）を押す前に知らせる。モデルが替わることを知らせる
- 実際: 帯は「Ollama」、カードは「Gemma 4」、送り先とモデル名欄は「qwen2.5:latest」。カードにサイズ・所要時間・「Ollama も入れる」の説明がない。成功後は送り先が gemma4:e2b に替わる（ゴースト用のモデルも）。帯で「Later」を押した人、または既定のまま実行した人は、選択の帯には戻れず、失敗の帯（「Is Ollama … running?」+ Retry / AI settings）の「AI settings」から設定に入るしかない
- 環境: 1.10.5 (a8bfea5) · 探索キット（導入はモックが何もしないので、進捗を台本で渡した）· en
- 再現性: 毎回（t03、t19、t20、t21 の 4 セッション）。実機の導入の挙動は未確認
- 証拠: `t03-local.png`、`t19-after-install-en.png`、`t21-install-progress-A.png`、`ollama_ops.go`（`SetupOllamaGemma4Async`）、`frontend/js/i18n.js`（`btnSetupOllama`、`ollamaSetupSuccess`）
- 原因の仮説: 選択の帯（first_run / A2）が、既存の「Gemma 4 導入」カードを流用した。既定モデル（qwen2.5）と導入するモデル（gemma4:e2b）の食い違いは元からあり、帯が目立たせた
- 自動テストにできるか: 一部できる（帯の文言・遷移先は `tests/first_run_welcome_test.mjs`。モデル名の一致は、i18n と既定値を突き合わせる静的テストが書ける）。内容の判断（何と書くか）はナビゲーター

### C9-03 導入の進捗と失敗が、英語 UI でも日本語のまま・コマンドの生出力のまま出る

- 重大度（案）: P2 ― 初回の主導線の途中で、読めない文字と次の手がない失敗を見せる
- 気づきの型: OR
- なぜ気づけたか: 導入の進捗の受け手（`__onOllamaSetupProgress`）が `prog.message` をそのまま表示していることに気づき、Go が送る文言を英語 UI に渡して見た
- 再現手順:
  1. 英語 UI で C9-02 の手順を「Install Gemma 4」まで進める。
  2. Go が送る進捗（`{message: 'Gemma 4 E2B モデルを取得しています (約2.5GB、ダウンロード進行中)...', step: 4, total: 5}`）が届くと、進捗行にその日本語が出る。
  3. winget がない環境の失敗（`{isDone:true, success:false, message:'Ollamaのインストールに失敗しました', error:"exit status 1: 'winget' is not recognized …"}`）が届く。
- 期待（オラクル）: 英語 UI は英語で話す（他の画面は全部翻訳されている）。失敗は平易で、次の手（ollama.com/download から入れる、など）がある
- 実際: 進捗行は日本語のまま。失敗時は行が日本語のまま残り、トーストは「Setup failed: exit status 1: 'winget' is not recognized as an internal or external command」。「もう一度」「手動で入れる」の案内なし。Step 表示は「Step 4/5」（英語固定）
- 環境: 1.10.5 (a8bfea5) · 探索キット（Go の文言を `ollama_ops.go` から写して渡した）· en
- 再現性: 毎回（t21 の A / B、t21b。文言は実機のコードと同一。実機の winget の出力は未確認）
- 証拠: `t21-install-progress-A.png`、`t21b-install-failed.png`
- 原因の仮説: `dispatch(step, "日本語…")` が Go 側に直書きで、フロントは翻訳せず `prog.message` / `prog.error` を出す
- 自動テストにできるか: できる（Go 側: 進捗の文言を `step` の番号だけにして、フロントが i18n を引く形にするテスト。フロント側: `__onOllamaSetupProgress` の出力に日本語（U+3000 以降）が英語 UI で入らない、を `tests/english_ui_strings_test.mjs` の型で）

### C9-04 「クラウドのキーを使う」を押してキーだけ貼ると、キーは localhost 宛ての設定に入り、失敗は「Ollama は動いていますか」と言う

- 重大度（案）: P2 ― 選択の帯の 2 番目のボタンが行き止まり。クラウドにつなぐには URL とモデル名も替える必要があるが、そう導かない
- 気づきの型: WI
- なぜ気づけたか: 「フォーカスが APIキー欄に行く」と読んで、「もし人がそこにキーだけ貼ったら」と考えた
- 再現手順:
  1. 新規の人で Ctrl+L、「Use a cloud key」を押す。設定 > AIモデルで API キー欄にフォーカスが行く。URL は `http://localhost:11434`、モデルは `qwen2.5:latest` のまま。
  2. `sk-proj-…`（または `AIzaSy…`）を貼り、Save。
  3. Ctrl+L → 「hello」→ Enter。
- 期待（オラクル）: 「クラウドのキーを使う」を選んだ人が、クラウドの URL とモデルへ導かれる。少なくとも、URL がローカルのままであることが分かる
- 実際: ステータスは「AI: local」、送り先は「Local Ollama (qwen2.5:latest)」。実行すると「Can't reach the AI model at localhost:11434. Is Ollama (or your model server) running?」。LLM に渡る設定は `baseUrl: http://localhost:11434`・`apiKey: 入り`（Go の `DetectProvider` は鍵があれば OpenAI 互換の形で localhost に送る）。クラウドの同意の確認は出ない（ローカル扱いなので）。失敗の文はキーにも URL にも触れない
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja
- 再現性: 毎回（en、ja の 2 回）
- 証拠: `t04-cloud-key-only.png`、`t29`（ja の出力）、`t03-cloud.png`
- 原因の仮説: `openAiModelsSettings('cloud')` は欄を見せてフォーカスするだけで、既定の URL・モデルを空にしたり、プロバイダを選ばせたりしない
- 自動テストにできるか: できる（`tests/first_run_welcome_test.mjs` に「クラウドを選んだ後にキーだけ保存したとき、ステータスが cloud でない / 案内が出る」）。何を出すかはナビゲーターの判断

### C9-05 何も聞いていないのに、文字を打つだけでステータスバーが赤い「AI: error」になり、日本語の生のエラーが出る

- 重大度（案）: P2 ― 初回の最初の入力で「壊れている」ように見える。質問バーの失敗は平易なのに、こちらは生のまま
- 気づきの型: WI
- なぜ気づけたか: 入力予測が既定でオン（`autocomplete.enabled` = true、Ollama 宛て）で、Ollama がないとき Go は `Ollama接続エラー (…)` を返す、という内部の知識から「新規の人が打つだけで何が起きるか」を試した
- 再現手順:
  1. 新規の人（Ollama なし）で起動する。
  2. ようこその末尾で改行し、「My first note about the trip」と打って 1.5 秒待つ（要求は Go が返すのと同じ失敗にした）。
  3. ステータスバーの AI 項目とそのツールチップ、クリックして開くポップオーバーを見る。
- 期待（オラクル）: 質問バーの失敗と同じく平易な文（「AI モデルに接続できません。Ollama は起動していますか」）。生の内部文言を出さない。何も頼んでいない人に赤いエラーを見せない
- 実際: 「AI: error」（赤）。ツールチップ「The last text prediction failed (Ollama接続エラー (http://localhost:11434): Post "http://localhost:11434/api/generate": dial tcp 127.0.0.1:11434: connectex: No connection could be made because the t…). Click to open the AI options.」。ポップオーバーにも同じ文が赤枠で出る。英語 UI でも日本語の部分が入り、160 字で単語の途中で切れる。ja では「AI: エラー」と「直近の入力予測に失敗しました（Ollama接続エラー …）」
- 環境: 1.10.5 (a8bfea5) · 探索キット（ゴーストの失敗は `autocompleteAsync` の差し替えで再現）· en / ja。実機では Go が先に `EnsureOllamaRunning`（最大 4 秒）を試すので、Ollama が入っているが止まっている人は自動で起動して出ない可能性がある
- 再現性: 毎回（en、ja の 2 回）
- 証拠: `t05-ghost-fail-statusbar.png`、`t05-ghost-fail-popover.png`
- 原因の仮説: `__onAutocompleteResult` が `setPredictStatus('error', errMsg)` に生の文言を渡し、質問バーの `describeLlmFailure` / `LlmError.classify` を通していない
- 自動テストにできるか: できる（`tests/status_ai_test.mjs` に「エラー文が LlmError を通った平易な文になる」「英語 UI に日本語が入らない」）

### C9-06 Ollama がない新規の環境でも「AI: local」（「running on this computer」）と出て、設定のカードは「Stopped」

- 重大度（案）: P2 ― 起動直後の画面が「動いている」と言い、最初の質問で初めて外れる。P3 に下げる余地もある（設定は正しく、失敗は平易に出る）
- 気づきの型: OR
- なぜ気づけたか: ステータスバー、質問バーの送り先、設定のカードの 3 つを並べて、同じ「ローカル AI」を同じことばで言っているかを見た
- 再現手順:
  1. 新規の人（Ollama なし）で起動する。
  2. ステータスバーの「AI: local」にカーソルを乗せる。ツールチップは「AI model: qwen2.5:latest, running on this computer or your network. …」。
  3. Ctrl+, → AIモデル。ローカルAI（Ollama）カードの状態は赤い「Stopped」で、「Start」がある。
- 期待（オラクル）: 動いていない・入っていないものを「running」と言わない。あるいは 3 か所が同じ状態を言う
- 実際: ステータスバーは設定の値だけから決める（`isLlmConfigured` は URL とモデル名の有無だけ）。Ollama の死活は見ない。最初の質問または入力予測の失敗まで、この矛盾は表に出ない
- 環境: 1.10.5 (a8bfea5) · 探索キット（`checkOllamaRunning` = false）· en / ja
- 再現性: 毎回（t01、t02、t03、t19 の 4 セッション）
- 証拠: `t01-launch-en.png`、`t03-local.png`
- 原因の仮説: `status_ai.js` の `modelState` は「設定されているか」だけで「答えられるか」を見ない（設計のコメントに明記）。ツールチップの「running」が強すぎる
- 自動テストにできるか: 一部できる（文言: 「running」を使わない、を静的に）。死活の反映は設計判断

### C9-07 Git を何も設定していない新規の環境で「Git: Ready」と出て、押すと「Git sync started」と言うが、何も起きない

- 重大度（案）: P2 ― ようこその「Git 同期を設定しない限りノートはこのパソコンの外に出ません」と、ステータスバーの「Ready」が食い違う
- 気づきの型: OR
- なぜ気づけたか: ようこその文とステータスバーを並べ、「Git: Ready」を押す人がいるかと考えて押した。Go 側の `executeSync` を読んだ
- 再現手順:
  1. 新規の人で起動する。ステータスバーに「Git: Ready」（ja は「Git: 待機中」）。ツールチップは「Git sync status. Click to sync now.」。
  2. クリックする。
- 期待（オラクル）: 設定していないものは「未設定」または表示しない（AI 項目は「not set up」と言う）。押して何も起きないなら「何も起きなかった」と言う
- 実際: 「Git sync started」/「Git同期を開始しました」のトースト。Go の `executeSync` は `IsGitRepo()` が false なら状態の通知もせず戻るので、ラベルは「Ready」のまま、何も動いていない。`gitSyncEnabled` の既定が true のため、Git を一度も使わない人にずっと出る
- 環境: 1.10.5 (a8bfea5) · 探索キット（Go は読んで確認）· en / ja
- 再現性: 毎回（en、ja の 2 回）
- 証拠: `t13.mjs`、`pkg/gitsync/gitsync.go`（`executeSync`）、`frontend/js/app.js`（`updateGitSyncStatusUI`、`statGitSync.onclick`）
- 原因の仮説: 表示は「有効か」だけで決まり、「リポジトリがあるか」を見ない
- 自動テストにできるか: できる（`tests/git_sync_disabled_test.mjs` の隣に「リポジトリなしのときのラベル」）。何と出すかはナビゲーター

### C9-08 ステータスバーの AI 項目が、言語の切り替えとモデルの切り替えのあと再描画されない

- 重大度（案）: P3 ― 表示だけ。操作すると直る
- 気づきの型: LC
- なぜ気づけたか: 設定を開いたまま言語を替える（計画 3.1 の 14）を、新しい AI 項目に当てた
- 再現手順:
  1. 英語 UI で起動し、設定 > 一般で言語を「日本語」にして保存する。
  2. ステータスバーを見る: 「Git: 待機中 | AI: local | 自動保存: ON」（AI だけ英語、ツールチップも英語）。
  3. AI 項目を押してポップオーバーを閉じると「AI: ローカル」になる。
  4. 別の再現: 「Install Gemma 4」が成功しても、AI 項目のツールチップは「qwen2.5:latest」のまま（項目を押すまで）。
- 期待（オラクル）: 言語を替えたら状態表示は全部替わる（Git と Autosave は替わる）。モデルが替わったら表示も替わる
- 実際: 上のとおり
- 環境: 1.10.5 (a8bfea5) · 探索キット · en→ja、ja→en、既存ユーザーの en→ja（3 回）、導入後のモデル（t19、t20 の 2 回）
- 再現性: 毎回（言語 3 回中 3 回、モデル 2 回中 2 回）
- 証拠: `t25.mjs` の出力、`t24-language-switch-ask.png`
- 原因の仮説: `StatusAI.refresh()` が `applyLanguage()` と `__onOllamaSetupProgress`（成功時）から呼ばれていない（`refresh` は設定の保存や質問バーの経路からだけ）
- 自動テストにできるか: できる（`tests/status_ai_test.mjs` に「言語を替えたあと項目の文字が替わる」「導入成功後にツールチップのモデル名が替わる」）

### C9-09 パレットに、AI の設定へ行く項目も、ようこそに戻る項目もなく、ようこその「すべてのコマンドがあります」と合わない

- 重大度（案）: P3 ― 行き止まりではない（Ctrl+,、ステータス項目、失敗の帯から行ける）が、探す人が見つからない
- 気づきの型: OR
- なぜ気づけたか: ようこその「Every command is there: just start typing」を、AI の設定を探す新規の人として試した
- 再現手順:
  1. Ctrl+Shift+P。
  2. 「model」「setup」「ollama」「api key」「cloud」「language」「theme」「toolbar」「git」「close」「update」「welcome」を順に入力する。
- 期待（オラクル）: ようこその案内（パレットにすべてある）と、AI の設定・言語・更新の確認といった、新規の人が探す言葉に当たる項目がある。ようこその「あとで読み返したい」（設計の残りに記載）
- 実際: 上の語はすべて「No results」（ja も「見つかりません」: 「モデル」「更新」「ようこそ」）。ある: Settings、Keyboard shortcuts、Help and manual (web)、About MD-Memo。言葉も、初回の人には固い（"Zero-Taxonomy blank slate"、"Bring Your Own Notes workspace"、"UNIX Pipe: …"）
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja
- 再現性: 毎回（t07 の en / ja と t29 の追加語）
- 証拠: `t07-palette-en.json`、`t07-palette-ja.json`、`t07-palette-en.png`
- 原因の仮説: パレットの項目は機能単位で、設定のタブごとの入口がない。ようこそを再表示する項目は設計の「残り」に載っている
- 自動テストにできるか: できる（パレットの項目に「設定を開く（AIモデル）」があること、を `tests/` の模擬環境で）

### C9-10 選択の帯の記録の規則が、ボタンの名前と逆になっている（「Later」は二度と出ない、Esc は毎回出る）

- 重大度（案）: P3 ― 設計に書かれた規則（Esc では記録しない、Later は記録する）だが、名前と挙動が逆に読める
- 気づきの型: OR
- なぜ気づけたか: 3 つのボタンと Esc の記録の有無を、既存ユーザーの毎回の使い方（Esc で閉じる）に当てた
- 再現手順:
  1. 新規の人で Ctrl+L、「Later」を押す → 次の Ctrl+L 以降、帯は二度と出ない（`aiChoiceMade` = true）。
  2. 既存ユーザー（テキストモデルが未変更の qwen2.5 + Ollama）で Ctrl+L → Esc を 3 回繰り返す → 3 回とも帯が出る。Ctrl+K、Ctrl+Enter の指示バーにも出る。
- 期待（オラクル）: 「Later（あとで）」は、あとでまた聞くと読める。「Esc」で閉じた人に毎回同じ質問をしない
- 実際: 上のとおり。実行するか 3 ボタンを押すまで、毎回出る。Ctrl+Enter の指示バーでは、エージェントを使う人にも「Where should the AI run?」と聞く
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja
- 再現性: 毎回（Later 2 回、Esc の繰り返し 2 回: en、ja）
- 証拠: `t03-later.png`、`t17-existing-qwen-ctrlenter.png`、`t23.mjs` の出力
- 原因の仮説: `markAiChoiceMade` の呼び出しが「押した」と「実行した」だけ（`docs/design/first-run.md` に決定として記載）
- 自動テストにできるか: できる（模擬環境の `tests/first_run_welcome_test.mjs` に、決めた規則を固定する）

### C9-11 「AIが設定されていない」の言い方が場所ごとに違う（LLM / AI model、`->` / `›`）

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: モデルなしの状態で、質問バー、ステータス項目、Ctrl+Enter を続けて見た
- 再現手順:
  1. モデルなし（クラウド URL + モデル名、キーなし）で保存する。
  2. ステータス: 「AI: not set up」/「No AI model is set up yet. Click to set one up (Settings › AI Models).」。質問バー: 「No AI model is set up yet. [Set up]」。
  3. 行を選んで Ctrl+Enter。
- 期待（オラクル）: 同じことを同じことばで（設定のタブ名は「AI Models」）
- 実際: Ctrl+Enter のトーストだけ「LLM is not configured (Settings -> AI Models)」（ja は「LLMが未設定です（設定 → AIモデル）」で、他は「AIモデルがまだ設定されていません」）。矢印も `->` と `›`
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja（文言は i18n から確認）
- 再現性: 毎回（t06、t29 の 2 回）
- 証拠: `t06-unset-statusbar.png`、`frontend/js/i18n.js` 456・1491 行（`askLlmNotConfigured`）
- 原因の仮説: `askLlmNotConfigured` は古い文言のまま。ステータス・質問バーの新しい文言が別に作られた
- 自動テストにできるか: できる（i18n の文言に「LLM is not configured」が残らない静的テスト）

### C9-12 モデルなしの質問バーの「Set up」は、設定を開いても「General」タブにフォーカスが残り、Text LLM の欄へ案内しない

- 重大度（案）: P3
- 気づきの型: NV
- なぜ気づけたか: 「Set up」を、選択の帯のボタン（欄にフォーカスする）と比べた。キーボードだけの人の最初の一手を想像した
- 再現手順:
  1. モデルなし（C9-11 と同じ）で Ctrl+L。「Set up」をクリック（または Enter で移ったフォーカスから押す）。
- 期待（オラクル）: 選択の帯の「クラウド」/「ローカル」と同じく、入力する欄・押すボタンにフォーカスが行く
- 実際: 表示は「AIモデル」タブだが、フォーカスは `tab-btn-general`（「General」タブのボタン）。欄へのスクロールもしない
- 環境: 1.10.5 (a8bfea5) · 探索キット · en
- 再現性: 毎回（t06、t29 の 2 回）
- 証拠: `t06-setup-click.png`
- 原因の仮説: `openSettings()` の 50 ms 後のフォーカスが、`openAiModelsSettings()` を通らない経路（「Set up」）でそのまま残る
- 自動テストにできるか: できる（模擬環境で、クリック後の `document.activeElement` の id）

### C9-13 ようこその「ノートはこのパソコンの外に出ません」は、既定でオンの起動時の GitHub への問い合わせに触れない

- 重大度（案）: P3 ― 送るのは「最新リリースの番号を尋ねる 1 回の GET」だけ（設定と About に明記）。説明の置き場所の判断
- 気づきの型: OR
- なぜ気づけたか: 「勝手に外へ出ない」を、初回の起動から 3 秒間のネットワークの動きに当てた
- 再現手順:
  1. 新規の人で起動し、3 秒待つ。`__docshot.calls` に `fetch(blocked) https://api.github.com` が 1 件（実機なら実際に出る）。
  2. ようこその最後の行を読む。
- 期待（オラクル）: 初回に読む文で、外へ出るものが分かる（設定 > 一般と About にはある）。少なくとも「ノート」以外の通信もあると分かる
- 実際: ようこそは「クラウドのモデル、Git 同期、Mobile Drop を設定しない限り、ノートはこのパソコンの外に出ません」とだけ言う。更新確認は既定オン（`checkUpdates` 未設定 = オン）で、起動の約 2.5 秒後に走る。同意の確認なし
- 環境: 1.10.5 (a8bfea5) · 探索キット · en
- 再現性: 毎回（t08、t18 の 2 回）
- 証拠: `t08.mjs` の出力、`t18-about-checknow-newer.png`、`frontend/index.html` 598・600 行の `checkUpdatesHint`
- 原因の仮説: 設計上の判断（隠していない）。書く場所の問題
- 自動テストにできるか: できない（何を書くかの判断。現状の文言は `frontend/js/first_run_test.js` が固定している）

### C9-14 ようこそが「保存先」を `~/Documents/md-memo/scraps` と書き、Help・マニュアル・About の入口には触れない

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: ようこそに書かれた場所と、About が出す実際の場所、ヘルプの入口を突き合わせた
- 再現手順:
  1. 新規の人（Windows）で起動し、ようこその「Where your notes are」を読む。
  2. パレット → About を開き、「Daily notes」の行を見る。
- 期待（オラクル）: 同じ場所は同じ表記。ヘルプの場所が分かる
- 実際: ようこそはチルダ表記の設定の既定値（`~/Documents/md-memo/scraps`）。About は `C:\Users\…\Documents\md-memo\scraps`。ツールバーの Help ボタンは落ち着いた配置で隠れていて、ようこそにはオンラインマニュアル・About への言及がない（パレットに「Help and manual (web)」と「About」はある）
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja
- 再現性: 毎回（t01、t08、t14 の 3 回）
- 証拠: `t01-launch-en.png`、`t08-about-en.png`
- 原因の仮説: ようこそは `config.scraps.scrapDir` を出し、実際に展開した場所（`getAppInfo().scrapDir`）を使っていない
- 自動テストにできるか: 一部できる（ようこその作成時に実パスを入れるかどうかは判断）

### C9-15 失敗した質問のあと、ステータスバーが「Task: Failed」なのにツールチップは「Running tasks: 1」

- 重大度（案）: P3
- 気づきの型: OR
- なぜ気づけたか: 失敗のあとの右下の表示を、ラベルとツールチップの両方で見た
- 再現手順:
  1. 失敗する質問を 1 回実行する。
  2. 右下の「Task: Failed」にカーソルを乗せる。
- 期待（オラクル）: ラベルとツールチップが同じ状態を言う
- 実際: ツールチップ「Running tasks: 1 (Alt+T to open the task list)」/ ja「実行中タスク: 1件 …」。約 9 秒後に項目は消え、開いたタスク一覧は「Active Tasks 0」
- 環境: 1.10.5 (a8bfea5) · 探索キット · en / ja
- 再現性: 毎回（t22 en、t31 の既存 en と新規 ja の 3 回）
- 証拠: `t22-task-failed-en.png`
- 原因の仮説: ツールチップは個数だけで作られ、状態を見ていない（C1 の範囲）
- 自動テストにできるか: できる

### C9-16 探索キットの 2 点: `fresh: true` は初回起動にならない（README と違う）。Ctrl+W でセッションが永久に止まり、ブラウザが残る

- 重大度（案）: P3（道具）
- 気づきの型: ENV
- なぜ気づけたか: (a) 初回の状態を作ったつもりで、ようこそが出なかった。(b) 自分のスクリプトが 2 回、戻ってこなくなった
- 再現手順:
  1. (a) `startExplore({ lang: 'en', fresh: true })` だけで起動し、`s.state().tabs` を見る。
  2. (b) セッション中に `s.key('w', { ctrl: true })` を押す。以後の `s.ev` / `s.state` が戻らない。
- 期待（オラクル）: (a) README「fresh: true = the state of a first launch」。ようこそが出る。(b) ブラウザのタブを閉じるキーは、キットが握りつぶすか、`s.ev` が時間切れで失敗する
- 実際: (a) 日付見出しのノート（`2026-09-18 10-24.md`）1 つでようこそなし。`getSession` が空でない（2 回目の起動の状態）。(b) ヘッドレス Edge がタブを閉じ、CDP の `Runtime.evaluate` に時間切れがなく永久に待つ。`timeout` で Node を止めたあと、ブラウザとプロファイル（`%TEMP%\explore-profile-*`）が残った（Windows では SIGTERM の掃除が働かなかったらしい。原因は未確認）。自分の 2 つは、ページも local server もない孤児であることを確かめてから、プロファイル名で手で止めて消した
- 環境: 1.10.5 (a8bfea5) · 探索キット · Windows 11
- 再現性: (a) 毎回（en、ja の 2 回）、(b) 毎回（2 回中 2 回）
- 証拠: `t33.out`、`t32.mjs` の冒頭のコメント
- 原因の仮説: (a) キットは `?fresh=1` だけを付け、モックの `nosession=1`（初回の状態）を付けない。(b) `keyEvents` がブラウザ既定のショートカット（Ctrl+W、Ctrl+T、Ctrl+N、F5 など）を除外しない。`Page.eval` に時間切れがない
- 自動テストにできるか: できる（`tests/explore_kit_test.mjs`: `fresh: true` が `nosession=1` を付ける、Ctrl+W をキットが拒否する）

## 気づきの型の内訳

NV: 1 件 / LC: 2 件 / WI: 2 件 / OR: 10 件 / RC: 0 件 / ENV: 1 件（計 16 件）

## 見つからなかったこと（正直に）

- 新規の人の主な道は動いた: ようこそは 1 回だけ出て、2 回目の起動では出ず、ツールバーは変わらない（t11）。Ctrl+Z / Ctrl+Y で消えない（t24）。プレビューでも読める（t14）。キーボードだけで選択の帯を通せて、狭い窓（560 × 420）でも収まる（t23）。日付ノート検索の空の結果、About の「Open」の失敗、コピーの中身も平易で、鍵は含まれない（t24、t28）。
- 既存ユーザーには、ようこそ・落ち着いたツールバー・設定の書き込みは出ない（t16、t17、t26、t27）。新しく出るのは、C9-10 の選択の帯（未変更の既定のモデルのときだけ）、琥珀の「AI: not set up」（モデルが空の人だけ）、C9-01 の保存の確認だけ。
- 日本語 UI: ようこそ、選択の帯、失敗の帯、パレット、About、ステータスバーに英語の漏れは見つからなかった。日本語が英語 UI に出るのは C9-03、C9-05 のみ（Go の生の文言）。

## 振り返り（5 分）

- 学んだこと（次に同じ型で探すときのヒント）:
  - 初回の人の困りごとの多くは「画面同士が別のことを言う」型だった（OR が 10 件）。新しい表示（AI 項目、Git 項目、選択の帯、導入カード）を作ったら、既存の別の画面が同じ事実を言っているかを、同じ画面の並びで見る。
  - Go が直接返す文言（導入の進捗、ゴーストの失敗、Git の状態）は、フロントの翻訳と分類を通らない。「生の文言が UI に出る経路」を Go 側から洗い出すと、同じ型がまだ出る。
  - 「何も頼んでいないのに出るもの」（入力予測の失敗、更新確認、Git の Ready）は、初回の人が最初に見る。ここを先に洗う。
- 次にやる憲章: C9 の続き（実機の WebView2 とインストーラーでの初回、Mac の Cmd 表記のようこそ、Ollama が入っているが止まっている人の自動起動）。C6（設定の一生）に「部分的な config.json → 保存 → 全体」の橋（`welcomeShown` の取り込み・書き出し）を足す。C14（日英）に「Go が返す文言を英語 UI に通す」を足す。
- 自動テストにできるもの: C9-01（失敗した質問のあとの isDirty）、C9-05（ゴーストの失敗を平易にする）、C9-08（言語切り替えと導入成功のあとの再描画）、C9-11（`LLM is not configured` を残さない）、C9-16（キットの `fresh` と Ctrl+W）。C9-03 は Go 側の文言を番号にして、フロントで i18n を引く形なら静的に守れる。
- うまくいかなかったこと（道具・進め方）:
  - キットの `fresh: true` は初回起動にならず、開き直しの補助が要った（C9-16）。`brandNew()` をキットに取り込むと、C9 系の再探索が速い。
  - Ctrl+W でセッションを 2 回止めた。キットが拒否するか、`s.ev` に時間切れを持たせたい。
  - スクリプト 34 本、操作 約 150 件は目安（80〜150）の上限。ログ 1 行の書き方を「操作 → 観察」に絞ると、記録の時間は探索の 10% に収まる。
