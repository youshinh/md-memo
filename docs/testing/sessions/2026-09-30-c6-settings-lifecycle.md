# セッション 2026-09-30: C6 設定の一生（既定 → 編集 → 保存 → 書き出し → 取り込み → 版をまたぐ → 既定に戻す）

- 憲章: 設定の一生（既定 → 編集 → 差分保存 → 書き出し → 取り込み → 他の版 → 既定に戻す）を、言語切り替え中の設定画面・「詳細設定を表示」・新しいスイッチ・未知/欠けたキー・新しい設定（general.checkUpdates / welcomeShown / aiChoiceMade / cloudConsent）で探り、値が消える・戻る・落ちる経路を見つける
- 時間: 開始 03:14 / 終了 03:44（計 約 30 分。記録した操作は 約 130 件、23 本のスクリプト）
- ナビゲーター: 呼び出し元（リード） / ドライバー兼記録係: Claude Code Sonnet 5.5
- 環境: 版 1.10.5（HEAD `a8bfea5`。作業ツリーには他セッションの未コミット変更が多数ある。キットは作業ツリーの `frontend/` をそのまま動かしたので、初回ウェルカム・タブのあふれ・AI 状態ポップオーバー・About・更新確認スイッチ・宛先行を含む）/ Windows 11 / 道具: 探索キット（`tools/explore/kit.mjs`、ヘッドレス Edge ＋ docshots のモック）。実アプリ・実 config・実ノート・実クリップボードには触れていない
- 範囲外（やらないこと）: 実アプリの操作、実 Go 側（`SaveConfig`、パッケージの zip、OS のホットキー登録）、macOS、ネイティブのファイルダイアログ、IME、ソースとテストの編集（直していない）
- 証拠: `C:/Users/yoush/AppData/Local/Temp/claude/C--Users-yoush-Documents-md-memo/c56620cc-7e7e-498b-a7c7-c4a14c374db1/scratchpad/explore/C6/`（以下 EV。`sNN_*.mjs` が各スクリプト、`*.png` が画面、`*.json` が状態のダンプ）

## 道具の補足（キットの上に足したもの。リポジトリは触っていない）

- `EV/lib.mjs`: モックの `getConfig` / `saveConfig` は静的（保存しても読み直しに反映されず、何が書かれたかも残らない）ので、頁の中で `window.backend` を包み直して「config.json の模型」を足した。`sessionStorage` に持つので再読み込み（＝再起動）をまたいで残り、`localStorage` も再起動をまたいで残す（実 WebView と同じ）。書き込み失敗・読み込み失敗も切り替えられる。
- 設定パッケージ（書き出し・取り込み）の模型: `packExport` は Go の `StripJSON` と同じ規則（秘密名のキー以下の文字列を空に、URL の user:pass@ を削る）で作り、`packInspect` / `packImport` はそれをそのまま返す。zip・ダイアログ・マニフェストの検証は入っていない（Go 側は見ていない）。
- 言語切り替えの比較: 「設定を開いたまま切り替えた画面」と「その言語で新しく起動した画面」を、要素の位置ごとにテキスト・title・placeholder・aria-label を突き合わせた。
- 罠（自分の道具の問題）: bash のヒアドキュメント経由だとスクリプトの `\\` が `\` に潰れ、正規表現が壊れて出力の 's' が空白になった回がある（s9 / s14 の「結果」行の文字欠けは道具のせいで、アプリの不具合ではない）。

## 進め方のメモ

- 問い: 「設定は config.json / WebView の localStorage / 画面の入力欄 / メモリの 4 か所にある。どの経路で保存され、どの経路で読み戻され、どこで正規化されるか」。保存の経路は 1 つに見えて、実は Settings の Save、状態バーのトグル、AI の初回選択、同意、取り込み、初回ウェルカムがそれぞれ `savePersistentConfig()` か `saveConfig()` を呼ぶ。読み込みは既知のセクションだけを取り込む。
- 「もし」の出どころ: `Object.assign` の受け皿が型を見ない / `select` に無い値は空になり Save で既定値に置き換わる / `openSettings()` は開くたびにスナップショットを取り直す / Reset は OS のホットキーを即時に登録する / 書き出しの「General」に端末ごとの旗が入る。
- 共通点: どれも「画面の見た目と、ディスク・メモリ・OS のどれかが黙ってずれる」。

## ログ（時系列）

| 時刻 | 操作 | 観察 | 疑問 · 次の一手 |
|---|---|---|---|
| 03:14 | キットの smoke を実行 | 3.5 秒で通る | 設定用の模型を足す |
| 03:15 | s1 初回起動（config.json なし、保存物なし、セッションなし）| ウェルカムノートが出る。config.json は `{general:{toolbarLayout, welcomeShown:true}}` だけ。localStorage は font_size と calm_toolbar の 2 つ | 何も変えずに Save したら？ |
| 03:15 | 何も変えずに Settings を Save | 22 個の最上位キー（general は 19 キー）が書かれる。`welcomeShown:true`、`aiChoiceMade:false`、`cloudConsent:{}`、`checkUpdates:true` が明示される。フロントは差分ではなく全量を書く（差分なのは Go の再初期化だけ） | 再起動してウェルカムが戻らないか |
| 03:15 | 再起動 → check-updates と autosave を OFF → Save → 再起動 | ウェルカムは戻らない。両方 OFF のまま残る | 新しいスイッチの往復は問題なし |
| 03:16 | s2 未知キー・選択肢にない値・範囲外の値・最上位の平のキー（`scraps` なし）だけの config を開いて Save | 失われたキー: `futureSection`、`topFlag`。変わった値: `theme: solarized→olive`、`mermaidTone`、`autocomplete.delayMs 100→200`、`maxTokens 300→100`、`image.aspectRatio 21:9→16:9`、`cli.resultPlacement`、`voice.apiStyle/mode`、`timeout_seconds 900→600`、`ghost_diff_duration_ms 20000→10000`、`scrap_dir D:\scraps→既定`、`git_sync_enabled false→true`（C6-11, C6-12）| 再現をもう一度（03:40）。Save を通らなくても落ちるか |
| 03:16 | s3 全 `select` の選択肢と `number` の範囲を一覧 | theme は 4 つ、aspect ratio は 5 つ、number に min/max あり | 範囲外/選択肢外の値の扱いは s2 のとおり |
| 03:17 | s4 設定を開いたまま言語を en→ja / ja→en | 差分が 80 件前後。ほとんどは「開いた/開かない」の状態差でノイズ | 比較を「画面の外側」と「設定の内側」に分ける |
| 03:18 | s4b 主画面だけを「その言語で新しく起動した画面」と比較（Save の前後・カーソルを動かした後）| 状態バーの `AI: local` が ja になっても英語のまま（Save 後も、カーソル移動後も）。逆向きは `AI: ローカル` が英語 UI に残る。タブの × の title、ja→en で `Replace` `Run` の aria-label が日本語のまま（C6-07, C6-14）| 直す経路があるか。状態バーの AI 項目のコードを読む |
| 03:19 | s4c ja に切り替えて「ショートカット」タブへ → Save → AI ポップオーバーを開く | 表は日本語になる。ポップオーバーは日本語（開いた時に作る）。状態バーの項目だけ英語 | 原因は `status_ai.js` の `drawItem` の再描画キーに言語が入っていないこと（読んで確認）|
| 03:20 | s5 マシン A から書き出し（キーなし）→ マシン B へ取り込み | A のキー 5 個と `user:pw@` が消える。B の `action.apiKey` / `discordBridge.botToken` は残る。`cloudConsent` は出ない・上書きされない（設計どおり）。ところが B の `aiChoiceMade` が true→false に戻った（C6-09）。B の `text.baseUrl` が A の別ホストになり、B のキー `sk-1` はそのまま（C6-10）| 端末ごとの旗が運ばれる。キーと宛先の組が変わる |
| 03:20 | 設定を開いて未保存の入力をしたまま「取り込み」 | 入力欄が取り込み後の値に置き換わる。未保存の入力は消える | 取り込む対象でないセクションでも消えるか（03:32）|
| 03:21 | s6 壊れた config.json 25 通り（型違い、null、配列、BOM、切れた JSON、`__proto__` など）| Settings が開かない 1 件（`shortcuts` の値が数値）以外は落ちない。`{}` `[]` `null` `123` も落ちない。`__proto__` で汚染は起きない。BOM・切れた JSON・`null` は「保存できません」（保存の前に警告はない） | 開かない 1 件を詰める。起動時の無言を確かめる |
| 03:24 | s7 ショートカット値の型を 1 つずつ | 数値・`true`・配列は Settings が開かない。`null`・空文字・未知のアクション名・変な文字列は問題なし | 何が動かなくなるか（03:25）|
| 03:25 | s7b `shortcuts.find = 5` だけの config | 起動時のエラー表示なし。Ctrl+L / Ctrl+E / Ctrl+Shift+P / Ctrl+, がすべて反応しない（押すたびに `shortcutStr.split is not a function`）。歯車ボタンでも設定が開かない。文字入力だけは効く。2 回とも同じ | 直す手段が UI にない（C6-03）|
| 03:26 | s8 BOM 付き・末尾カンマ・切れた JSON、各 2 回 | 起動から 6 秒間、トーストもエラーも無し。言語もテーマも既定のまま。Save すると「Settings saved successfully」の直後に「config.json could not be read…」に変わる。saveConfig は 0 回 | 起動時に言わない（C6-02）|
| 03:27 | s9 Mac の書き出し（Cmd+…）を Windows に取り込み | Settings 上は Ctrl+N などに見える（Cmd→Ctrl 表示）。`quickCapture` が空になる | Cmd は Windows では Ctrl と同じ扱い。衝突は？ |
| 03:28 | s9b Mac の既定の 48 個を丸ごと取り込み、Ctrl+Z / Ctrl+F | ベースライン: Ctrl+Z は取り消し、Ctrl+F は検索。取り込み後（2 回）: Ctrl+Z は Zen モードに切り替わり本文は取り消されない。Ctrl+F は検索が開かない（全画面切り替え）| 衝突表を計算（03:29）→ `find` と `toggleFullscreen` が同じ Ctrl+F、`zenMode` が Ctrl+Z、`find` が Ctrl+F（C6-04）|
| 03:29 | s9c 同じ取り込みの後で Ctrl+F / Ctrl+Z のバックエンド呼び出しを確認（後追い、03:43）| Ctrl+F は `toggleFullscreen` を呼び、検索バーは開かない。Ctrl+Z は Zen モードが ON になり、本文 "abc" は取り消されない（2 回）| 衝突表と一致 |
| 03:30 | s10 独自のグローバルホットキーを持つ設定で「既定に戻す」→ Cancel | Reset の時に `updateGlobalShortcut("Ctrl+Alt+M")` を呼ぶ。Cancel でアプリ内のショートカットは元に戻るが、OS への登録を戻す呼び出しは無い。2 回とも | 画面の設定とOS の登録がずれる（C6-08）|
| 03:31 | s11 `checkUpdates` の値 4 通り | 未設定・null・`"false"`（文字列）は起動 2.5 秒後に api.github.com へ要求。`false` だけ要求なし。About の「今すぐ確認」はどれでも動く | 文字列 `"false"` を ON と読むのは手書きの型ミスの範囲（一覧のみ）|
| 03:32 | s12 A: 「忘れる」→ Cancel / Save → 再起動 | Cancel で元に戻る。Save で `{}`、再起動後は同意を聞かれ、同意前の要求は 0 件（2 回）| 新しい同意は堅い |
| 03:32 | s12 B: 設定を開いて言語を ja にして（未保存）、「取り込み」→ 閉じる → Cancel | 取り込みが終わった時点で言語 ja が config.json に書かれる。Cancel しても ja のまま、再起動後も ja（2 回。C6-06）| スナップショットの取り直しが原因か |
| 03:32 | s12 D: モデル名を入力（未保存）→ ショートカットだけ取り込み | 入力が消えて元のモデル名に戻る（2 回）| |
| 03:33 | s12 C: 「詳細設定を表示」ON → Cancel → 開き直す → 再起動 → OFF | 14 セクション中 5→14→5。Cancel・再起動をまたいで保持される。localStorage の 1 キー | 問題なし |
| 03:33 | s13 何も変えずに Save / テーマだけ変えて Save（リモート URL が config に無い）| config に URL があれば無関係な Save は `saveSession` だけ。config にリモート URL が無くフォルダが Git リポジトリのとき（2 通りとも）は、無関係な Save でも `setupGitRemote` が 1 回呼ばれる（状態確認が入力欄に既存のリモートを自動入力し、スナップショットと違って見えるため。同じ URL で、保存後は呼ばれない） | 差分保存はほぼ成り立つ。害は見えないので一覧のみ |
| 03:34 | s14 変わった中身の取り込み 8 通り（`general` が文字列、`shortcuts.find` が数値、`text` が null、80 段の入れ子、JSON でない、未知セクション、空、旧形式）| 数値のショートカットは取り込みの段階で「適用できません」で止まり config は壊れない。`general: "x"` は config.general が文字列のまま書かれる（読み直し後は文字が 0,1 のキーになる）。未知の最上位キーは「その他」で取り込むと config に残る。ほかは落ちない | 壊れた中身を書き込む経路は 1 つだけ（一覧）|
| 03:35 | s15 IME Guardian: ja で OFF のまま言語を en→ja と往復して Save | チェックが true になり、config も true（3 回。ja+ON で en にして Save すると false）（C6-13）| |
| 03:35 | s15 言語とテーマを変えて閉じ方を比べる（Esc / × / 背景クリック / Ctrl+, をもう一度押して Cancel）| Esc と × は元に戻る。背景クリックは閉じない。Ctrl+, をもう一度押してから Cancel だと言語 ja が残る（2 回）| 再入の疑い |
| 03:37 | s16 未保存のモデル名＋言語を ja にしたまま Ctrl+, をもう一度 | 入力欄が元の値に戻る。設定は開いたまま。Cancel しても ja のまま。その後、状態バーの「Autosave」を切り替えると config.json に `language: ja` が書かれる（2 回。C6-05）| |
| 03:37 | s17 全コントロール 75 個を別の値にして Save → 再起動 → 比較 | 不一致は `cfg-default-agent` の 1 つだけ。原因はモックが agents.yaml の既定を保存しないこと（`getActiveSlotConfigJSON` が固定）。実アプリでは起きないと見て除外。Save をもう一度しても同じファイル | 往復は堅い（何も出ない）|
| 03:38 | s18 config.json に書けない状態で API キーとテーマを変えて Save | トースト「Settings saved successfully」。エラーは console.warn だけ。再起動すると API キーは旧値、テーマは新値（2 回。C6-01）| |
| 03:38 | s19 既定の Ollama モデルで初回の Ctrl+L | 選択肢が出る。何も答えず Esc → もう一度開くとまた出る。指示を入れて Enter で実行すると `aiChoiceMade:true` が書かれ、再起動後は出ない。無関係な Save でも残る（2 回）| 設計どおり |
| 03:39 | s20 端末ごとの旗が運ばれる影響を目に見える形で確認 | 私は答え済み＋同僚の旗が false → 取り込み後にまた選択肢が出る。新しい PC で未回答＋同僚の旗が true → 一度も出ない（各 2 回。C6-09）| |
| 03:40 | s21 未知の最上位キーがある config で、設定を開かず AI の選択肢に「後で」だけ答える | `futureSection` `topFlag` `llm` が消える（2 回）。Settings を開かなくても落ちる（C6-11）| |
| 03:40 | s21 同意済みの api.openai.com がある状態で、AI モデルの宛先が collector.example のパッケージを取り込む | 宛先は変わるが API キー sk-1 はそのまま。ask バーには「gpt-x (cloud)」、同意の質問が出て要求は 0 件。質問の文言は「文章を … に送信」で、キーのことは書いていない（2 回。C6-10）| |
| 03:41 | s22 言語を切り替えたあと各タブを順に開く | 状態バッジ（Ollama・エージェント・Git）と表は開いた時に日本語になる。「接続方式」の行（`text-provider-detect-line`）だけ英語のまま（2 回）| C6-14 は主画面側の 3 点＋この行 |

## バグ候補

（ID は `B-20260930-C6-連番`。重大度は案。決めるのはナビゲーター。）

### B-20260930-C6-01 config.json に書けなくても「保存しました」と出て、再起動で値が戻る

- 重大度（案）: P1 ― 設定（API キーを含む）が黙って失われる。読み取り専用のフォルダ・ディスクいっぱい・ウイルス対策のロックで起きる
- 気づきの型: WI
- なぜ気づけたか: 「ディスクがいっぱい / 書けない」を設定の保存に当てた。保存は「先に閉じてトーストを出す（楽観 UI）」で、書き込みの失敗の受け皿を探したら `console.warn` だけだった
- 再現手順:
  1. 設定の書き込みが失敗する状態にする（EV/s18_savefail.mjs は `saveConfig` を reject にする）
  2. 設定 > AIモデルで API キーを新しい値にし、テーマも変えて Save
  3. 画面とトーストを見る → 再起動して設定を開く
- 期待（オラクル）: 常識・「データを失わない」。失敗したら失敗と分かる（他の保存 `configNotSavedUnreadable` は警告を出している）
- 実際: トースト「Settings saved successfully」。エラーは console.warn のみ。再起動後、API キーは旧値（config.json から）に戻り、テーマは新値のまま（WebView の localStorage にキーなしのコピーが残るため、と推定。半分だけ保存された状態になる）
- 環境: 版 1.10.5 · Windows · 探索キット（`saveConfig` を reject に差し替え）· 英語 UI
- 再現性: 毎回（2 回中 2 回）
- 証拠: `EV/s18_savefail.mjs` の出力（トースト・console.warn・再起動後のフィールド）
- 原因の仮説: `frontend/js/app.js` の Save ハンドラ（`closeSettings(); showMessage(t('settingsSaved'))` の後で `savePersistentConfig().catch(console.warn)`）と `savePersistentConfig` の `catch`（警告のみ）。Go 側 `SaveConfig` は書き込み失敗で `(false, error)` を返す
- 自動テストにできるか: できる（`tests/` に、`saveConfig` が reject するスタブでトーストの文面を確かめる）

### B-20260930-C6-02 起動時に config.json が読めなくても何も言わない（保存の時だけ、先に「保存しました」が出る）

- 重大度（案）: P2 ― BOM・末尾カンマ・書き込み途中の切れなど、手で編集した config が「設定が消えた」ように見える。保存は止まる（守りは効いている）が、その理由は保存を押すまで分からない
- 気づきの型: WI
- なぜ気づけたか: 「手で壊した config」「PowerShell の `Set-Content -Encoding UTF8` は BOM を付ける」という内部の知識から。トラブルシュートの資料にも BOM が載っている
- 再現手順:
  1. config.json を BOM 付き / 末尾カンマ / 途中で切れた JSON にして起動（EV/s8_unreadable.mjs、各 2 回）
  2. 6 秒待つ。言語・テーマ・モデルの表示を見る
  3. 設定を開いて Save
- 期待（オラクル）: 他の失敗表示（AI の失敗バナーなど）と同じく、読めなかったと分かること。「保存しました」を出してすぐ警告に替えるのは誤解のもと
- 実際: 6 秒間トーストなし・エラーなし。UI は英語・既定のテーマ（config の ja / blue は無視）。Save → トースト「Settings saved successfully」→ 続けて「config.json could not be read at start-up, so settings are not saved…」。`saveConfig` は 0 回。API キーは config.json にしかないので、AI が「未設定」に見える
- 環境: 版 1.10.5 · Windows · 探索キット（`getConfig` を差し替え）· 英語 UI
- 再現性: 毎回（3 種類 × 2 回 ＝ 6 回中 6 回）
- 証拠: `EV/s8_unreadable.mjs` の出力、`EV/s8-bom-after-save.png`
- 原因の仮説: `syncBackendConfig` の `catch`（`backendConfigLoadFailed = true`、`console.warn` のみ）。通知は `savePersistentConfig` の中だけ。Save ハンドラが先に成功トーストを出す
- 自動テストにできるか: できる（`tests/` に、`getConfig` が壊れた JSON を返すスタブで、起動後のメッセージを確かめる）

### B-20260930-C6-03 config.json の ショートカットの値が文字列でないと、全ショートカットが効かず、設定も開けない

- 重大度（案）: P2 ― 手で編集した / エージェントが書いた config が対象。起動時に何も表示されず、UI からは直せない（設定が開かないため）
- 気づきの型: WI
- なぜ気づけたか: 「壊れた config / 型違い」を 25 通り流した中で、1 件だけ Settings が開かなかった。型を 1 つずつ詰めた
- 再現手順:
  1. config.json に `{"shortcuts":{"find":5}}` を書いて起動（`5` の代わりに `true` や `["x"]` でも同じ。`null` と `""` は問題なし。EV/s7_shortcut_types.mjs, s7b, s7c）
  2. Ctrl+L / Ctrl+E / Ctrl+Shift+P / Ctrl+, を押す → 歯車ボタンを押す
- 期待（オラクル）: 未知の値は無視する（`shortcuts` の未知のアクション名や空文字は無視されている）。設定に入れなくなるのは避ける
- 実際: 起動時のトーストなし。どのキーも反応しない（押すたびに `TypeError: shortcutStr.split is not a function` が `matchShortcut` → `parseShortcutString` で出る）。歯車でも Settings が開かない（`openSettings` → `applyLanguage` → `updateShortcutLabels` → `formatShortcutForDisplay` で同じ例外）。文字入力は効く
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（数値 / 真偽 / 配列 × 各 1〜2 回、合計 5 回以上）
- 証拠: `EV/s7c-gear-dead.png`、`EV/s7b-shortcut-crash.png`、各スクリプトの出力
- 原因の仮説: `frontend/js/app.js` の `parseShortcutString` と `formatShortcutForDisplay` が `shortcutStr.split` を型の確認なしに呼ぶ。読み込みは `Object.assign({}, DEFAULT_SHORTCUTS, config.shortcuts, fileConfig.shortcuts)` で型を見ない。取り込みの経路は例外で止まり config は壊れないが、メモリにはもう入っている可能性がある（要確認）
- 自動テストにできるか: できる（`tests/` の shortcut 系に、非文字列を含む config で `matchShortcut` と `updateShortcutLabels` が落ちないことを確かめる）

### B-20260930-C6-04 別 OS（Mac）で作った設定パッケージのショートカットを取り込むと、Windows で Ctrl+Z が Zen モード、Ctrl+F が全画面になる

- 重大度（案）: P1 ― 取り消しと検索が黙って壊れる。「ショートカット」の項目は取り込みの既定でチェック済み。マニフェストに OS の情報がなく、取り込み画面に注意もない。戻し方は「設定 > ショートカット > 既定に戻す」
- 気づきの型: ENV
- なぜ気づけたか: 「設定の書き出し × 別の環境で取り込み」（計画 3.1 の 15）。Windows では Cmd と Ctrl を同じに扱う、というコード（`matchShortcut`）を読み、Mac の既定を畳んで衝突を計算した
- 再現手順:
  1. Mac の既定のショートカット全部（`DEFAULT_SHORTCUTS_MAC` を Mac が Save した形で）を入れたパッケージを用意（EV/s9b_macdefaults.mjs）
  2. Windows のキットで設定 > 取り込み > 「ショートカット」のまま実行
  3. エディタに "abc def" と打ち、Ctrl+Z → Ctrl+F
- 期待（オラクル）: 別の OS の割り当てで、標準の編集キーが壊れない。少なくとも取り込み前に分かる
- 実際: ベースラインは Ctrl+Z で "abc def"→"abc"、Ctrl+F で検索バー。取り込み後は Ctrl+Z で Zen モードが ON になり本文は取り消されない、Ctrl+F で検索バーが開かず `toggleFullscreen`（バックエンド）が呼ばれる（`EV/s9c_verify.mjs`）。衝突表: `find` と `toggleFullscreen` が Ctrl+F、`zenMode`（Ctrl+Cmd+Z）が Ctrl+Z。Mac の `quickCapture` は空で、Windows の全体ホットキー Ctrl+Shift+Q が無効になる（config.json で `quickCapture: ""` を確認）
- 環境: 版 1.10.5 · Windows（キットは Windows のみ）· 探索キット · 英語 UI。Mac 実機での書き出しの中身は `app.js` の既定表をもとにした推定
- 再現性: 毎回（2 回中 2 回、ベースラインとの対。後追いの確認 `s9c` でさらに 2 回）
- 証拠: `EV/s9b-collisions.txt`（衝突の計算）、`EV/s9-mac-shortcuts-on-windows.png`、`EV/s9b_macdefaults.mjs` の出力
- 原因の仮説: `frontend/js/config_pack.js` の `CONFIG_SECTIONS` の `shortcuts` は `defaultOn: true` でプラットフォーム印がない。`app.js` の `matchShortcut` は Windows で `hasCtrl || hasCmd` を Ctrl とみなす
- 自動テストにできるか: できる（`config_pack_test.js` に、Mac の既定を Windows の `matchShortcut` に通して衝突を数える純粋なテスト。取り込み時の変換/警告を入れたらその挙動を確かめる）

### B-20260930-C6-05 設定を開いたまま Ctrl+, をもう一度押すと、未保存の入力が消え、言語の Cancel が効かなくなる

- 重大度（案）: P2 ― 「Cancel は何も保存しない」が崩れる。切り替えを試しただけの言語が、後の無関係な保存で config.json に入る
- 気づきの型: NV
- なぜ気づけたか: 「設定を開いたまま × 言語を切り替える」（計画 3.1 の 14）に、「開くショートカットをもう一度」を掛けた。`openSettings()` は開くたびにスナップショットを取り直すと読んだため
- 再現手順:
  1. 設定を開き、モデル名を入力（保存しない）、言語を ja にする（画面が日本語になる）
  2. Ctrl+, をもう一度押す
  3. Cancel を押す → 状態バーの「Autosave」を切り替える
- 期待（オラクル）: 開いているダイアログを開き直しても、入力は消えず、Cancel は開いた時点に戻す
- 実際: モデル名の入力が元の値に戻る。設定は開いたまま。Cancel しても UI は ja のまま。Autosave を切り替えると config.json に `language: ja` が書かれる
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（2 回中 2 回。Ctrl+, → Cancel だけの確認も 2 回、合計 4 回）
- 証拠: `EV/s16-reopen-1.png`、`EV/s16_reopen.mjs` と `EV/s15_cancel_paths.mjs` の出力
- 原因の仮説: `openSettings()` の冒頭で `openedConfigSnapshot = JSON.parse(JSON.stringify(config))` を毎回取る。すでに開いている時の早期 return がない
- 自動テストにできるか: できる（`openSettings` を 2 回呼んだ後の Cancel で言語が戻ること）

### B-20260930-C6-06 設定を開いたまま「取り込み」すると、未保存の言語が保存され、Cancel でも戻らない（対象外のセクションの入力も消える）

- 重大度（案）: P3 ― C6-05 と同じ原因。取り込みは意図した操作なので、影響は小さい
- 気づきの型: NV
- なぜ気づけたか: 取り込みの後で `applyImportedConfig` が `openSettings()` を呼んで入力欄を更新している、という読みから
- 再現手順:
  1. 設定を開き、言語を ja に（未保存）
  2. 「取り込み」でショートカットだけのパッケージを取り込む → 閉じる → Cancel
  3. 再起動
- 期待（オラクル）: Cancel は取り込み前に切り替えただけの値を保存しない。取り込まない対象の入力は残る
- 実際: 取り込みが終わった時点で config.json の language が ja。Cancel しても ja、再起動後も ja。別の確認では、モデル名の未保存の入力が、取り込み対象でなくても元の値に戻る
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（言語 2 回、入力の消失 2 回）
- 証拠: `EV/s12_flows.mjs` の出力（B, D の各回）
- 原因の仮説: `applyImportedConfig` → `savePersistentConfig`（ライブで変えた `config.general.language` ごと保存）→ `openSettings()`（スナップショットの取り直し）
- 自動テストにできるか: できる（`config_pack_test.js` か `tests/` にホストのスタブで）

### B-20260930-C6-07 言語を切り替えても、状態バーの「AI: …」が元の言語のまま

- 重大度（案）: P3 ― 表示だけ。新しく入れた AI 状態ポップオーバーの項目で、他の状態バーは切り替わる
- 気づきの型: OR
- なぜ気づけたか: 他の画面（「行 1, 列 1」「自動保存: ON」）は切り替わっているのに、この 1 つだけ違う
- 再現手順:
  1. 英語 UI で設定を開き、言語を ja にして Save（Save しなくても、開いたままで同じ）
  2. 状態バーの右側を見る。カーソルを動かす。ポップオーバーを開く
- 期待（オラクル）: 他の状態バーと同様に新しい言語になる（`applyLanguage` のコメントは「AI 項目もラベルとポップオーバーを新しい言語で描き直す」と言っている）
- 実際: `AI: local`（title も英語）のまま。ja→en では `AI: ローカル` が残る。カーソル移動でも直らない。ポップオーバーは開いた時に作られるので新しい言語になる
- 環境: 版 1.10.5 · Windows · 探索キット · 日英両方向
- 再現性: 毎回（en→ja 2 回、ja→en 1 回）
- 証拠: `EV/s4b-en-ja-after-save.png`、`EV/s4b-ja-en-after-save.png`、`EV/s4b-*-main-saved.json`
- 原因の仮説: `frontend/js/status_ai.js` の `drawItem()` の再描画キー（`labelKey|titleKey|model|error|open|busy`）に言語が入っていない。キーが同じなので `setText` / `title` が呼ばれない
- 自動テストにできるか: できる（`status_ai_test.mjs` に、言語を替えて `refresh()` した後のラベル）

### B-20260930-C6-08 「ショートカットを既定に戻す」→ Cancel で、画面の設定と OS のグローバルホットキーがずれる

- 重大度（案）: P2 ― 呼び出しのホットキー（Ctrl+Alt+M など）は、アプリを前面に出す入口。設定画面には独自のキーが残っているのに、実際は既定のキーが有効になる（再起動まで）
- 気づきの型: LC
- なぜ気づけたか: 「既定に戻す」がグローバルホットキーを即時に OS へ登録する、という読みと、Cancel の復元がアプリ内のメモリだけ、という読みから
- 再現手順:
  1. `shortcuts.globalSummon = Ctrl+Alt+K` の config で設定 > ショートカット > 「Reset to Defaults」
  2. Cancel
  3. バックエンドへの呼び出しを見る（`__docshot.calls`）
- 期待（オラクル）: Cancel の後は、画面・config・OS の登録が同じ値（Ctrl+Alt+K）
- 実際: Reset で `updateGlobalShortcut("Ctrl+Alt+M")` が呼ばれ、Cancel の後に `Ctrl+Alt+K` へ戻す呼び出しは無い。config と設定画面は Ctrl+Alt+K のまま。Quick Capture（`updateQuickCaptureShortcut`）はモックに無く、コードの読みでは同じ（未確認）
- 環境: 版 1.10.5 · Windows · 探索キット（OS の登録自体は見えない。バックエンドの呼び出しの記録だけ）· 英語 UI
- 再現性: 毎回（2 回中 2 回、呼び出しの記録として）
- 証拠: `EV/s10_reset_cancel.mjs` の出力
- 原因の仮説: `btnResetShortcuts.onclick` が `updateGlobalShortcut` と `syncQuickCaptureShortcut` を即時に呼ぶ。`restoreLiveConfigFromSnapshot` は `config.shortcuts` を戻すだけ
- 自動テストにできるか: できる（バックエンドのスタブで、Reset → Cancel の後に元の値で再登録される、または Reset が Save まで遅れる、ことを確かめる）。実機のホットキーの確認は実アプリでのみ

### B-20260930-C6-09 書き出し・取り込みで、端末ごとの旗（aiChoiceMade / welcomeShown）が運ばれる（cloudConsent は運ばれない）

- 重大度（案）: P3 ― 一度きりの案内が「戻る」「出ない」だけで、害は小さい
- 気づきの型: OR
- なぜ気づけたか: `cloudConsent` は「この PC のもの」として書き出し・取り込みの対象外にしてある（`LOCAL_ONLY_NESTED`）のに、同じ性質の旗が General に入っている、という不一致から
- 再現手順:
  1. 私（aiChoiceMade=true、既定の Ollama モデル）が、同僚の General（aiChoiceMade=false）を取り込む → 設定を閉じて Ctrl+L
  2. 逆に、新しい PC（未回答）が、同僚の General（aiChoiceMade=true）を取り込む → Ctrl+L
- 期待（オラクル）: 端末ごとの状態は他の端末に影響しない（cloudConsent と同じ扱い）
- 実際: 1. では config の aiChoiceMade が false に戻り、またモデル選択が出る。2. では true になり、一度もモデル選択が出ない。`welcomeShown` も同じ経路で運ばれる（初回起動には影響しない）
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（各方向 2 回中 2 回）
- 証拠: `EV/s5-pack-A.json`（パッケージの general に 2 つの旗が入っている）、`EV/s20_flagleak.mjs` の出力
- 原因の仮説: `frontend/js/config_pack.js` の `LOCAL_ONLY_NESTED` に `general: ['cloudConsent']` しかない
- 自動テストにできるか: できる（`config_pack_test.js`: `splitConfig` と `mergeImported` で `aiChoiceMade` `welcomeShown` が出入りしない）

### B-20260930-C6-10 取り込みでモデルの宛先だけが変わり、手元の API キーがそのまま新しい宛先へ送られる（同意の文言はキーに触れない）

- 重大度（案）: P2（セキュリティ設計の懸念。ナビゲーターが P1 に上げる余地がある。入り口は他人のパッケージを取り込むこと＋ask バーの同意）
- 気づきの型: WI
- なぜ気づけたか: 「キーを含めない書き出し × 取り込み」（計画 3.1 の 16）と「同意の新機能」を組み合わせ、「キーは残る」と「宛先は変わる」が同時に起きうる、と考えた
- 再現手順:
  1. 手元は `text.baseUrl = https://api.openai.com/v1`、キー `sk-1`、`api.openai.com` に同意済み
  2. `text.baseUrl = https://collector.example/v1`・キー空のパッケージ（AI Models のみ）を取り込む（取り込み画面は「API キーは含まれていません。今のキーはそのまま残ります。」）
  3. ask バー（Ctrl+L）に入力して Enter
- 期待（オラクル）: 宛先が別のホストに変わるなら、キーがそのホストへ送られることが分かる（または、キーを空にして取り込む/警告する）
- 実際: config は `collector.example` ＋ 手元のキー `sk-1`。ask バーに「gpt-x (cloud)」と同意の質問（「文章をインターネットを通して collector.example に送信します。許可しますか。」）。文言は文章のことだけで、キー（別のサービスのもの）が Authorization として同じ要求に載ることは書いていない。同意前の要求は 0 件（ここは堅い）
- 環境: 版 1.10.5 · Windows · 探索キット（Go 側のキーの送り方は見ていない。`text.apiKey` を使う、というコードの読みによる）· 英語 UI
- 再現性: 毎回（2 回中 2 回）
- 証拠: `EV/s21_unknown_and_consent.mjs` の出力（CC1, CC2）、`EV/s5_pack.mjs` の出力
- 原因の仮説: `mergeImported` は空文字（マスクされた秘密）を上書きしない設計（`isBlankedSecret`）。宛先（`baseUrl`）と資格情報（`apiKey`）が別々にマージされ、組が保たれない
- 自動テストにできるか: 一部できる（`config_pack_test.js` に「baseUrl が変わったらキーを持ち越さない/フラグを立てる」の規則を決めてから）

### B-20260930-C6-11 config.json の未知の最上位キーは、どの保存でも消える（設定を開かなくても、AI の選択肢に答えるだけで）

- 重大度（案）: P3 ― 手で足したキーや、新しい版が足したキー（旧版に戻した時）が消える。マニュアルの資料にも「未知の最上位キーは次の UI 保存で消える」と書いてある既知の制限。ただし、保存の経路が増え（AI の選択・同意・状態バー）、設定を開かなくても落ちるようになった
- 気づきの型: LC
- なぜ気づけたか: 「版をまたぐ」（計画 3.2）。読み込みは既知のセクションだけを `config` に入れ、保存は `config` を丸ごと書く、と読んだ
- 再現手順:
  1. config.json に `futureSection`、`topFlag`、`llm` などの未知の最上位キーを入れて起動
  2. 設定を開かず、Ctrl+L → 「後で」（あるいは設定を開いて何も変えずに Save）
  3. config.json を見る
- 期待（オラクル）: 書き出しの「その他」（キーが不明なもの）という区分があるように、未知のキーは保存で消えない
- 実際: 消える（設定を開かない経路で 2 回、Save の経路で 2 回）。逆に、取り込みの「その他」経由では config に残り、次の再起動＋保存で消える
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（4 回中 4 回）
- 証拠: `EV/s2-diff.json`、`EV/s21_unknown_and_consent.mjs` の出力
- 原因の仮説: `loadLocalConfigSync` / `syncBackendConfig` が既知のキーだけを拾い、`savePersistentConfig` が `JSON.stringify(config)`。未知のキーを別に持ち越す仕組みがない
- 自動テストにできるか: できる（読み込み→保存の往復で未知の最上位キーが残る、をスタブのバックエンドで）

### B-20260930-C6-12 選択肢にない値・範囲外の値は、無関係な Save で黙って書き換わる（テーマ、縦横比、タイムアウトなど）

- 重大度（案）: P3 ― 手で書いた値や新しい版の値が対象。`timeout_seconds` の 900 が 600 になる、`scraps` なしの最上位 scrap_dir が既定に戻り git_sync_enabled が true になる、が実害に近い（後者は資料に書いてある）
- 気づきの型: LC
- なぜ気づけたか: Save が「全コントロールの値を読み取って config に書く」作りで、`select` に無い値は空になり `|| '既定'` に落ちる
- 再現手順:
  1. config.json に `theme: solarized`、`image.aspectRatio: 21:9`、`autocomplete.delayMs: 100`、`timeout_seconds: 900`、`scraps` なしで最上位にだけある `scrap_dir: D:\scraps` と `git_sync_enabled: false` を入れる
  2. 設定を開き、何も変えずに Save
- 期待（オラクル）: 触っていない設定は変わらない
- 実際: `theme→olive`、`aspectRatio→16:9`、`delayMs→200`、`maxTokens 300→100`、`timeout_seconds→600`、`ghost_diff_duration_ms 20000→10000`、`scrap_dir→~/Documents/md-memo/scraps`、`git_sync_enabled→true`
- 環境: 版 1.10.5 · Windows · 探索キット · 英語 UI
- 再現性: 毎回（2 回中 2 回）
- 証拠: `EV/s2-diff.json`、`EV/s3-options.json`
- 原因の仮説: `openSettings()` が select に値を入れる（無い値は空）、Save が `select.value || 既定`。最上位だけの `scrap_dir` は読み込み経路がない（資料は「両方書け」と書いている）
- 自動テストにできるか: できる（値を選択肢/範囲の外にした config で Save の前後を比較）

### B-20260930-C6-13 言語のセレクトが IME Guardian のチェックを書き換え、Save で保存される

- 重大度（案）: P3 ― 日本語 UI で IME Guardian を OFF にしている人が、言語を en→ja と往復して Save すると ON になる。ja の人が en にして Save すると OFF になる
- 気づきの型: NV
- なぜ気づけたか: 言語切り替えの `onchange` が `imeCheckbox.checked = (value === 'ja')` を書いている、というコードの読みから
- 再現手順:
  1. ja UI、`imeGuardian:false` の config で設定を開く
  2. 言語を en にして、ja に戻して Save
- 期待（オラクル）: 言語を選んでも別の設定は動かない（利用者が明示した値）
- 実際: 戻した時点でチェックが true、Save で config も true（ja+ON のとき en にして Save すると false）
- 環境: 版 1.10.5 · Windows（IME を切り替えられる環境）· 探索キット · 日本語 UI
- 再現性: 毎回（3 回中 3 回）
- 証拠: `EV/s15_cancel_paths.mjs` の出力（IME1〜3）
- 原因の仮説: `cfgLanguageSelect.onchange`（`app.js`）
- 自動テストにできるか: できる

### B-20260930-C6-14 言語を切り替えても直らない、小さな表示が残る（タブの × の説明、aria-label、接続方式の行）

- 重大度（案）: P3 ― 表示・読み上げの仕上げ
- 気づきの型: OR
- なぜ気づけたか: 「その言語で新しく起動した画面」との要素ごとの突き合わせ（s4b）
- 再現手順:
  1. 設定を開いたまま言語を切り替え、Save して（またはしないで）主画面を見る／AI モデルのタブを開く
- 期待（オラクル）: すべて新しい言語（新しく起動した画面と同じ）
- 実際: タブの × の title（例 `Close (Ctrl+W)` が ja でも英語）。ja→en では「Replace」「Run」「Run（cli バー）」ボタンの aria-label が `置換` `実行 (Enter)` のまま（`a11y.js` は文字が 2 字以下のときだけ aria-label を付け、英語で 3 字になると外さない）。AI モデルのタブの「Protocol: Ollama」行が ja でも英語のまま（`updateLLMProviderDetection` は開く時だけ）。ほかのバッジ・表・ヒント（Quick Actions は開く時に描き直す）は問題なし
- 環境: 版 1.10.5 · Windows · 探索キット · 日英両方向
- 再現性: 毎回（2 回以上）
- 証拠: `EV/s4b-*-main-saved.json`、`EV/s22_tabs_after_switch.mjs` の出力
- 原因の仮説: タブの × の title は `renderTabs` 時に設定。`a11y.js` の `labelButtons` は `data-a11y-label` の外し方がない
- 自動テストにできるか: できる（言語を往復して主画面を新しく起動した画面と突き合わせる比較を、テスト化する）

## 見つからなかったもの（この範囲で）

- 設定の往復: 75 個のコントロールを全部変えて Save → 再起動 → 比較して、一致（`default_agent` はモックの制限で除外）。Save を続けてもファイルは変わらない。
- 「詳細設定を表示」: Cancel・再起動をまたいで保持される。ON/OFF で開閉するセクションは 14 中 5↔14。
- 新しいスイッチ: `checkUpdates`（ON/OFF、未設定、null）、`cloudConsent`（Forget → Save / Cancel、再起動、同意前の要求 0 件、書き出し・取り込みの除外）、`aiChoiceMade`（Esc/実行/再起動/無関係な Save）、`welcomeShown`（初回だけ、戻らない）は設計どおり。
- 壊れた config.json（型違い・null・配列・`__proto__`）の大半は落ちない（C6-03 を除く）。
- 壊れたパッケージの取り込み（JSON でない、数値のショートカット、空、旧形式）は、止まるか適用される。config は壊れない（`general: "x"` のみ文字列のまま保存される）。

## 気づきの型の内訳

NV: 3 件（C6-05, 06, 13）/ LC: 3 件（C6-08, 11, 12）/ WI: 4 件（C6-01, 02, 03, 10）/ OR: 3 件（C6-07, 09, 14）/ RC: 0 件 / ENV: 1 件（C6-04）

## 振り返り（5 分）

- 学んだこと: 「保存の経路」を一覧にすると（Save、状態バー、AI の選択、同意、取り込み、初回）、`openSettings()` の再入と、Cancel の復元が「メモリだけ」であることが同じ形で効いてくる。設定は「画面の入力欄」「メモリ」「ディスク」「OS の登録」がずれる場所を探すと出る。
- 次にやる憲章: C10（取り込みで宛先だけ変わる件と、キーの行き先）、C11（グローバルホットキーの登録と Cancel、実アプリで）、C14（言語の切り替えを全画面で「新しく起動した画面」と比較）、C6b（本物の Go の `PackExport`/`PackImport` と `SaveConfig` を通した往復）。
- 自動テストにできるもの: (1) 全コントロールの往復（s17 をそのまま `tests/` に）、(2) 壊れた config.json のコーパス（s6/s7 の表。「開ける・ショートカットが効く・通知が出る」を確かめる）、(3) 主画面の「言語を切り替えた画面 = 新しく起動した画面」の突き合わせ、(4) Cancel の不変条件（開く前と Cancel 後で `config`・ディスク・OS 登録の呼び出しが同じ）、(5) パッケージの不変条件（端末ごとの旗、宛先とキーの組、Mac の既定を Windows に通した衝突）。
- うまくいかなかったこと（道具・進め方）: キットの `getConfig` / `saveConfig` が静的で、再起動やパッケージを通せない。今回は頁の中で模型を足したが、`s.restart()`・「config.json の模型」・パッケージの往復をキット本体に入れるべき。ヒアドキュメントで `\\` が潰れて 2 回無駄にした。言語の比較は最初ノイズだらけで、「主画面」と「設定の内側（タブを開いた後）」に分けてから読めるようになった。
