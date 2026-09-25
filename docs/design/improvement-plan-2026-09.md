# 改修計画 2026-09（結果ブロック・コメント切替・CLI/RPC・エージェント）

| | |
|---|---|
| 対象 | md-memo v1.8.0（`main` @ baecc6d 以降） |
| 入力 | ユーザーの要望メモ（機能要望 1〜18、不具合・記載相違 B1〜B9）と、結果ブロック／Ctrl+/ の要望 |
| 方法 | コードを読み取り専用で調査（4 系統）→ 各項目を TRUE / FALSE / PARTLY で検証 → 設計 → 実装計画 |
| 状態 | **設計・計画のみ。実装は未着手** |
| 注意 | 見積もりは「コードを知っている開発者の作業日」。実機（WebView2 / macOS）確認の時間は別。行番号は調査時点のもの |

## 0. 要約

- 全体で **約 31〜35 作業日**（本文の背景の層を入れる場合を含む）。4 つのフェーズに分け、それぞれ 1 リリースにできる。
- **フェーズ 1（約 9 日）を最優先**: 結果ブロックの可視化とコマンド、Ctrl+/、自動タイトル、記載の小修正。ユーザーが最初に頼んだもの。
- メモの記載のうち、**B1〜B4 は現在のツリーでは成り立たない**（古い README を見た可能性）。B5 と 9/B6 は TRUE。**B9 は再現できず**、先に再現手順が要る。
- 危険なもの（`--dangerously-skip-permissions` の既定、`{instruction}` の自動追加、書き込み RPC に認証がない）は、機能追加より先に手当てするか、少なくとも計画に入れておく。
- 結果ブロックの色付けは、**行番号ガターのアクセントライン**を先に作る。本文側の薄い背景は、カーソルオーラを隠さない条件付きで、その次。

## 1. メモの検証結果

| 項目 | 判定 | 根拠（要点） |
|---|---|---|
| 1 buffer save | 未実装（要望どおり） | Ctrl+S は `saveTab`（app.js）。RPC / CLI には保存がない |
| 2 tab new / close | 未実装 | `__mdMemoRPC.newTab` は id を返さず、`closeTab` は待たない |
| 3 書き込みの `--tab` | TRUE（無視される） | `app_rpc.go` が id を JS へ渡さない。JS 側の `selectTab` は表示を切り替えてしまう |
| 4 info / 設定の参照 | 未実装 | `ocr` と同じ方式で単体実行できる |
| 5 scrap list / search | 未実装 | `pkg/search` は標準ライブラリだけなので CLI から呼べる |
| 6 Windows の CLI | TRUE | リリース exe は GUI サブシステム（`-H windowsgui`）。PowerShell は待たず、終了コードも不安定 |
| 7 --out | 未実装 | Windows でリダイレクトすると PowerShell が OEM コードページで読み、日本語が化ける |
| 8 install-skill | 未実装 | Homebrew の cask は `.app` だけを入れ、`skills/` は届かない |
| 9 / B6 タイトル | **TRUE** | 日付見出しを意図して飛ばし、次の非空行を使う。表の行・コメントは除外されず、40 UTF-16 単位で機械的に切る |
| 10 エージェント無効化 | **TRUE** | `complementSlotConfig`（loader.go:109-119）が内蔵 4 種を毎回足し戻す |
| 11 skip-permissions | **TRUE**（一部は緩和済み） | Go・JS・テンプレートの 3 か所にある。確認ダイアログは自動書き換え後にしか出ず、手書きの `{{ @gemini }}` は素通し |
| 12 `{instruction}` 自動追加 | **TRUE** | runner.go:152-155。`powershell -Command` などの検出はない |
| 13 スニペットの既定文 | **TRUE** | `${selection}` の正規表現（slot_snippets.js:261）は既定値を持てない |
| 14 ドロップダウン | **TRUE** | app.js:8403 が `description` だけを表示。テストが完全一致を固定している |
| 15 エラー重複 | **PARTLY** | `{{ @agent }}` の結果ブロックだけ（slot_agent.js:1414-1416）。従来スロットは対策済み |
| 16 8.3 パス | **TRUE** | runner.go:368-385 が `os.CreateTemp` のパスをそのまま `{file}` に入れる |
| 17 結果ブロック | 未実装 | 検出関数はあるが「全ブロック列挙」がない |
| 18 Ctrl+/ | 未実装 | 割り当てなし。プレビューは HTML コメントを文字として表示する（markdown-it の `html: false`。実測済み） |
| B1 Ctrl+K / Ctrl+L | **FALSE** | README は現在 Ctrl+L で正しい。「操作プロトコル」は 2026-09-15 に削除済み |
| B2 winget | **FALSE** | README は「未公開」と明記。`winget install` の記載は cloudflared だけ |
| B3 Linux | **FALSE** | README は「非対応」。緩い表現は「macOS と Linux の sh」（マニュアル）の 2 か所だけ |
| B4 Claude | **FALSE** | ドキュメントに記載なし。コードコメント（llm.go:37）だけが「Claude」と書いている |
| B5 `level` | **TRUE** | manual.html:3928-3935、manual_ja.html:4056-4063、README の 1 行例に `level` がない |
| B7 claude の引数 | **TRUE** | `--prompt` は存在しない前提（一般知識。この環境に claude はなく未検証）。既定は 5 か所に重複 |
| B8 ollama | **TRUE** | 実行前の存在確認がなく、`exec: "ollama"…` の生のエラーが出る |
| B9 中断で復元されない | **FALSE（再現せず）** | Node での再現では、レシピも従来スロットも元に戻った。ただし復元は「最善努力」で、失敗を黙って捨てる箇所がある |

B1〜B4 は、メモを書いたときに読んでいた README が古かった可能性が高い。どのファイルを見たか確認する（§6）。

## 2. 設計

### 2.1 結果ブロックの可視化とコマンド（要望 17）

**検出（共通部品）**: `auto_selector.js` に `findResultBlocks(text)` を新設する。開始行・本文・終了行の範囲を返し、フェンスコードの中は飛ばし、CRLF を許す。閉じていない開始行は「実行中」として別に返す。Go 側の `findResultBlocks`（parser.go:107）は非公開なので触らない。

**可視化 1: 行番号ガターのアクセントライン（先に作る）**
- ガターは 1000 行ずつのブロックで、行ごとの要素がない。ブロックの上に、絶対配置のバーを置く小さな層を足す。
- バーの位置は、行番号 × 行の高さ。折り返しがあるときは、既存の `rows`（`LineGutter.rowsFor`）の累積を使う。ガターはエディタと一緒にスクロールする。
- 色は、開始行が明るい緑、本文が薄い緑、終了行が濃い緑（4 つのテーマごとに CSS 変数）。
- 再計算は、`<!-- md-memo:res` が本文にあるときだけ。なければ即 return し、層も作らない（軽さの原則）。
- 本文側の層と違い、揃え方のずれ・入力への遅れ・100k 文字の上限・ゴーストの重なりを気にしなくてよい。

**可視化 2: 本文の薄い背景（任意。設定 `general.resultBlockTint`: off / subtle）**
- `file_anchor.js` の `.fanchor-layer` と同じ作り（絶対配置の層に本文の複製、透明な文字、スクロール連動）を、別の層として持つ。
- **カーソルオーラを隠さない条件**:
  - オーラは `z-index: 1`、`mix-blend-mode: screen`（style.css:550-559）。背景の層は **`z-index: 0`（オーラの下）**、不透明度は **0.08 以下**にする。screen 合成なので、背景の上のオーラは明るくなり、隠れない。
  - リンク下線の層（z-index 1）と DOM の順で競合しないよう、背景の層を最背面に固定する。
  - 受け入れ条件: オーラの中心の輝度が、背景あり・なしで下がらないことを、実ブラウザのスクリーンショットで測る。
- 既知の制約: 100k 文字を超えるノートでは出さない。折り返し方の違い（CJK、`overflow-wrap`）に注意。DOM のテストがなく、WebView2 と WKWebView の目視が要る。
- 既定は off（アクセントラインが先。足りなければ subtle を既定にする）。

**コマンド**（コマンドパレットと、設定でキー変更可能。`DEFAULT_SHORTCUTS` の Win / Mac、`SHORTCUT_GROUPS`、i18n の en / ja、`isEditorActive` 内の分岐、ドキュメントの 5 か所）:
- 次の結果へ・前の結果へ: `gotoLineNumber` と `revealCaretInHugeNote` を使う。
- この結果をコピー（本文だけ）: `copyTextToClipboard`。
- この結果を削除: `execCommand('delete')` の 1 回（Undo 1 回で戻る）。フォールバックの `editor.value =` は Undo が切れるので使わない。
- 結果を確定: ブロック全体を本文に置き換える 1 回の挿入。マーカー 2 行を別々に消すと Undo が 2 回になる。確定後は本文の記法（`{{ }}` など）が再び有効になる点を、コマンドの説明に書く。
- 既定のキー: `Alt+↑/↓` は行の移動、`Ctrl+Alt+矢印` は古い Intel ドライバの画面回転と衝突しうる。**既定は割り当てなし（パレットのみ）を基本**にし、次へ・前へだけ `Alt+Shift+↓/↑` を候補にする（実装時に予約キーを再確認）。

**見積もり**: ガター 1.5 日、コマンド 2 日、任意の背景 1.5〜2 日。

### 2.2 Ctrl+/（Cmd+/）でコメントの切替（要望 18）

**動き**: 行ごとに `<!-- 行 -->` で包む・外す（VS Code の Markdown と同じ）。選択がなければ現在行。全行がコメント済みなら外し、そうでなければ全部包む。空行は飛ばす。字下げは保つ。`<!-- md-memo:` で始まるマーカー行は触らない。行に `-->` が含まれるときは、その行を対象外にしてメッセージを出す。設定 `general.commentStyle`: `line`（既定）/ `block`（選択全体を 1 組で包む）。Undo は 1 回。

**プレビューで隠す**: `renderMarkdownContentTo` の `stripMarkers` の直後（app.js:2317 付近）に、`<!--[\s\S]*?-->` の除去を足す。行全体のコメントは改行も消し、段落が割れないようにする。閉じていないコメントは表示したまま。コード（フェンス・インラインコード）は既存のプレースホルダ方式で保護済みの位置なので、その後に処理する。実測した現状: 単独行・行内・複数行のコメントは、すべて `&lt;!-- … --&gt;` の文字として出る。

**コメントの中のタスクを止める**（これが本来の目的）:
- 実行できる記法を検出する箇所は、JS の `findTaskAt`、`ctrlEnterFlow`（`classify`）、`updateRunButton`、`findEnclosingSlotSpan`、Go の `ParseSlots`（`FindExcludedRanges`）。ランタイムでは Ctrl+Enter が `parseSlotsRPC` と `runSlotAgentAsync` を通るので、**Go も直す必要がある**。
- JS に `htmlCommentRanges(text)`（UTF-16 の `[s,e)`。`<!--` がなければ即 return。フェンス・インラインコードの中の開始は無視）、Go に `findHTMLComments(content, prior)` を `FindExcludedRanges`（parser.go:94）の新しい段として足す。閉じていないコメントは無視。コメントは入れ子にならない。
- **最も危険なこと**: Go が除外したスロットを JS が生きていると見なすと、`app_slot.go:470-481` と `:533-544` のフォールバックが「カーソル以降の最初のスロット」または `slots[0]` を実行する。JS と Go が完全に一致しなければならない。対策として、**共通のテストベクトル（同じ入力と期待範囲）を JS と Go の両方のテストで回す**。加えて「コメントアウトしたスロットは、ほかのスロットを実行しない」というテストを置く。
- コメント内の普通の文に Ctrl+Enter を押したときは、`inCodeFence` と同じ扱い（何もしない）。
- 承認ゲート `- [x] … // approve`（Go の `FindApprovalGates`）は、コード除外もしていない。同じ helper に載せるか、対象外と明記する。

**見積もり**: 切替 + キー登録 1 日、プレビュー 0.25 日、パーサーと共通テスト 2 日。

### 2.3 自動タイトルの改善（要望 9 / B6）

新しいモジュール `frontend/js/note_title.js`（+ `_test.js`）に移す。`app.js` の `deriveTitleFromContent` は、1 関数だけ抽出して試す既存のテスト（`tests/hot_path_parity_test.mjs` の T2。旧実装と完全一致を固定している）を、ルールの確認テストに書き換える。
1. 空行、front matter、フェンスコード、`<!-- -->`（`md-memo:` のマーカーも）、表の行と区切り、水平線、`[[ ]]` / `{{ }}` の行を飛ばす。
2. 日付だけの見出し（自動で入る `# 2026-09-25 07:51`）は、ほかに何もないときだけ使う。
3. 最初の日付でない ATX 見出し。なければ最初の意味のある行。走査は 200 行まで。
4. Markdown の記号を外す（引用、リスト、タスク、強調、バッククォート、リンク → 表示文字、画像 → alt、HTML タグ、末尾の `#`）。空白をまとめる。
5. `\ / : * ? " < > |` と制御文字は、削除ではなく空白に置き換える。末尾のドットと空白を落とす。Windows の予約名（`CON`、`NUL` など）には `_` を付ける。
6. 約 40 コードポイントで切る（`Array.from` か `Intl.Segmenter`。キー入力のたびに動くので、最終候補だけ）。空白か閉じ括弧の境界まで戻し、括弧が開いたままなら、その括弧の前で切る。省略記号は付けない。
7. 「名前を付けて保存」の既定だけ `YYYY-MM-DD_<要約>.md`（日付は日付見出し、なければ今日）。タブの表示名には適用しない。

**見積もり**: 1 日 + 保存名の 0.25 日。

### 2.4 CLI / RPC（要望 1〜8、4 の後半）

**共通の下地（先に 1 日）**
- コマンド一覧が `main.go:89`、`main.go:330`、`pkg/cli/help.go:105`、`headless.go:69` に重複している。1 か所（`cli.Run(args, version)` とコマンドの表）にまとめる。`valueFlags`（help.go:19）に新しい値付きフラグ（`as`、`encoding`、`out`、`from`、`to`、`date`、`title`、`path`）を足す。
- `flag` は最初の位置引数で解析を止めるので、`tab close <id> --if-saved` が誤読される。フラグを後ろにも置ける解析を新コマンドに使う。
- `LoadConfig()`（設定ファイルを直接読む共通の読み込み）、`scrap.DailyPath(dir, t)`、`inbox` の解決を、`package main` から共有パッケージへ出す。バージョンは `-X` の ldflags で渡す（`build_mac.sh` と `build_mac_test.go` が `app.go` の `AppVersion` の記述を grep しているので注意）。

**単独で動くもの（GUI 不要）**
- 7 `buffer get --out <file>`（0.4 日）: CLI 自身がファイルを書く。UTF-8・BOM なし（`--bom` は任意）、原子的に書く。標準出力にはメタデータ（パス・バイト数・hash）だけ。
- 4 `info --json`（0.5〜1 日）: scrap フォルダ、今日の scrap のパス、inbox、設定フォルダ、autosave、バージョン。API キー・トークン・`gitRemoteUrl`（認証情報を含みうる）は出さない。
- 5 `scrap list | search | path`（1.5 日）: `SearchMatch` に `Heading` と `HeadingLine` を足す（直前の ATX 見出し。フェンス内は飛ばす）。`list` は `^\d{4}-\d{2}-\d{2}\.md$` に絞る。`path` は書き込まずに返す。JSON のキー表記は、既存の検索（camelCase）と RPC（snake_case）で割れているので、CLI は snake_case に統一して明記する。
- 8 `agent install-skill`（1.25 日）: **`go:embed` を使う**（`skills/embed.go`、約 278 KB。exe が約 16 MB なので増加は 2% 弱）。Homebrew では `skills/` が届かないため、実行ファイルからの相対探索は主にしない。既定は「コピー」（原子的に書き、版のマーカーを付け、編集済みなら `--force` なしでは上書きしない）。`--link` はディスク上の実体があり Unix のときだけ。Windows のシンボリックリンクは、開発者モードか管理者が要る。配置先は Claude Code が `~/.claude/skills/md-memo`（`CLAUDE_CONFIG_DIR` を尊重）、Codex は `$CODEX_HOME/skills`（未確認）。
- 6 Windows のコンソール用 exe（1.25 日）: **`cmd/md-memo-cli`**（`pkg/cli` と `pkg/ipc` だけを import するコンソールサブシステム）を zip に同梱する。`release.yml`、`ci.yml`、ドキュメント、スキルを直す。winget は新しいマニフェストの版が要る（PR #438694 はまだ 1.6.0 のまま）。名前の入れ替え（コンソール版を `md-memo.exe`）は、「送る」・ショートカット・関連付けが壊れるので**やらない**。`md-memo.com` や PATH への登録は、winget のエイリアスと相性が悪く、壊れやすいので採らない。

**RPC の書き込み（GUI が要る。まとめて 1 つの塊）**
- 認証の強化（0.5 日）: 現在は「トークンを付けて間違えたときだけ拒否」で、付けなければ通る。`save` と `close` を足す前に、書き込み系のメソッドではトークンを必須にする。**トークンなしで書いているクライアント（エディタのプラグインなど）が壊れる非互換**なので、§6 で決めてもらう。
- 3 書き込みの `--tab`（1.75 日）: `resolveTab(id)`（不明な id は `-32002`）と `writeTabText(tab, text, mode)`。既存の `applyAnchorReplacement`（app.js:1090-1136）の 3 分岐が参考になるが、自動保存の予約と `saveSessionDebounced` が抜けているので足す。hash の検査と書き込みは、1 回の JS 呼び出しで行い、2 回の RPC の間の競合をなくす。textarea は 1 つで `selectTab` が読み直すため、背景タブの書き込みは Undo できない（`previous_hash` を返す）。
- 2 `tab new / close`（1.75 日）: `newTab` は `{id, title, path}` を返し、`background` を受ける。`closeTab` を「確認」と `removeTab(id)` に分ける。`close --if-saved` は、`isDirty` ではなく、ファイルの内容と本文（CRLF を正規化）を比べ、直前に再検査する。パスなしのタブは閉じない。`--path` は、すでに開いているタブと重複させない。
- 1 `buffer save [--as] [--encoding]`（2 日）: RPC から**ダイアログを開かない**（CLI 3 秒・アプリ 5 秒の制限）。パスなし・`--as` なしはエラー。CLI 側で絶対パスにする。パスの検証（拡張子の許可リスト、ディレクトリ不可、上書きは `--overwrite`、UNC、ADS、デバイス名の拒否）。`encoding.Encode` は不明な名前を黙って UTF-8 にし、SJIS にできない文字を `?` にするので、名前を検証し、欠落があれば警告か拒否にする。保存後はタブを紐づけ、自動保存もそのパスに向かう。
- ※ `ui.eval` はすでに任意のパスを書けるので、新しい種類の能力は増えない。それでもトークン必須にする。

**API キー（4 の後半）**
- 案 (a) `md-memo config get [path] --json`（キーは `set (…末尾4桁)` と表示。既存の `IsSecretKey` を使う）と、`localStorage` への書き込みからキーを除く 0.5 日の修正。**これを先にやる**。`config.json` を直接読ませない規則（SKILL.md）は残す。
- 案 (b) `secrets.json` に分ける（3〜5 日）。すべての Go の読み手と `pkg/cli/ocr.go` を、統合する読み込みに通す必要がある。旧版が空のキーで `SaveConfig` を書くと、平文が戻る移行リスクがある。Windows の 0600 はほぼ効かない。
- 案 (c) OS の資格情報ストア（6〜9 日）は、Mac の署名（アドホック）で更新のたびに確認が出うるので**勧めない**。
- 現在は、全設定が `localStorage['md_notepad_config_v3']` に平文で複製されている（app.js:10513）。これは (a) と同時に直す。

**見積もり合計**: 下地 1 + 単独 4.6〜5.2 + RPC 6 + キー 0.5〜1 = **約 12〜13 日**。

### 2.5 エージェントとスロット（要望 10〜16、B7〜B9）

順序は、**スキーマ（`enabled`、`append_instruction`）と既定値の見直しを 1 回でまとめて**、次に無効化、最後に確認ダイアログと存在確認。

- **S0 スキーマ + 既定値の見直し（B7、11 の前半、codex）**: `AgentDef` に `Enabled *bool`、`AppendInstruction *bool` を足す（config.go:8-15）。`SlotConfig` に `DisabledAgents []string`。既定値は Go（config.go:71-76、loader.go:233-240）、JS（slot_agent.js:20-25）、テンプレート、パリティテスト（`tests/agent_defaults_parity_test.mjs:236`）、マニュアル 3 か所、`tools/docshots/data/demo.mjs` の 5 か所に重複しているので、同時に直す。`claude` の既定は、リポジトリ自身の例（setup-guide.md:233）に合わせた `["-p","対象ノート: {file}\n指示: {instruction}"]` にする（**この環境に claude がなく、権限まわりの引数は未検証**）。`codex` の既定（`--execute --file`）は存在しないフラグなので、`["exec","{instruction}"]`（setup-guide.md:229）に直す。既存のインストールは、マージが利用者の定義を上書きしないので、古い引数が残る。**移行の通知（設定を更新するかの確認）は別作業（+0.5 日）**。
- **10 と 14 無効化と選択肢（1.5〜2 日）**: `complementSlotConfig`（loader.go:109-119）、`MergeSlotConfig`（config.go:145-182）、`buildActiveSlotConfig`（app_slot.go:385-393）の最後に、共通の「無効を除く」段を足す。無効なキーは、`Agents` から消し、内蔵の足し戻しからも外し、`DefaultAgent` が無効を指していれば直す。`@agy` は「無効」と返す（今は「skill が見つからない」に落ちる、parser.go:277-282）。JS の使う側（`resolveAgentKey`、`defaultAgentKey`、`runInstruction`、`makeResolver`、`pickAgent`、クイックセレクタのプリセット、`populateAgentSelectOptions`、`config_pack.js:23`）に、無効を渡さない。ドロップダウンは「キー — 説明」にし、無効は選択肢から外す。`tests/agent_options_test.mjs:92-98` の完全一致を直す。
- **11 の後半 確認ダイアログ（2 日）**: 既存の `autoSelector.agentConfirm` は、自動書き換えの後にしか出ない。手書きの `{{ @gemini }}` とプロファイル指定は通らない。橋に `confirmAgentRun`（既存の `customConfirm` を使う）を足し、`runSlotTrigger` と `startBelowAgentRun` の `runSlotAgentAsync` の直前に呼ぶ。危険なフラグの一覧を app.js:8421 の外へ出し、共有する。「確認済み」の印は、`config.json` に持ち、設定の保存で消えないようにする。**既定から `--dangerously-skip-permissions` を外すと、`agy -p` が権限を待って止まる可能性がある（未検証）。外す前に、確認ダイアログと移行の通知が先。**
- **12 `append_instruction` と警告（1 日）**: runner.go:152-155 で `AppendInstruction` を見る。コマンド名が `powershell`・`pwsh`・`cmd`・`sh`・`bash`・`zsh`、または引数が `-Command`・`/c`・`-c` のときは、読み込み時に警告する。
- **13 スニペット（1 日）**: `${selection:既定文}` と `${selection?前置き}`（値が空なら前置きごと出さない）。`\}` のエスケープを許す。`slot_snippets.js:261` の正規表現、`commitSnippet`（slot_agent.js:591）、`snippetPreview`、内蔵の本文、`slot_snippets_test.js:215-217` が固定している「空のときの出力」、ドキュメント（interfaces.md:283-284、setup-guide.md:207、テンプレート loader.go:218）。
- **15 エラー重複（0.25 日）**: `applyBelowResult`（slot_agent.js:1415）で `^⚠\s*エラー:\s*` を除き、`slot_agent_test.js:630` を延ばす。interfaces.md:254 も直す。
- **16 8.3 パス（0.5 日）**: `golang.org/x/sys/windows` の `GetLongPathName`（すでに go.mod にある）で、一時ファイルのパスを長い形式に直してから `{file}` に入れる。`pkg/slotagent` に `longpath_windows.go` と `longpath_other.go` を足す。テストは、展開関数を差し替え可能にした純粋なテストと、Windows 限定のテスト（`TMP` を短縮名にし、短縮名が作れないときはスキップ）。
- **B8 存在確認（1.5 日）**: 実行前に `exec.LookPath` で確かめ、分かりやすいメッセージにする（app_slot.go:755-798 と、レシピの分岐 :594）。使えないエージェントは、クイックセレクタで印を付ける。`ollama run hermes3` は、モデルがなければ取得を始めるので、バイナリの有無だけでは足りない（一般知識で未検証）。
- **B9 中断（0.5〜1 日）**: **再現できなかった**。Node での再現では復元された。復元は「最善努力」で、`text.indexOf(executingText)` が失敗する（実行中の文言が編集された・Undo された）か、`activeRequests` に残っていないと、黙って何もしない。疑わしいのは、タスクリストが毎秒作り直されて（task_manager.js:242-268）クリックが失われること、または古い版。**コンソールのログ付きで再現してもらってから直す**。それまでは、復元が失敗したことを表示するテストとログの追加だけ行う。

**見積もり合計**: 約 9〜11 日。

### 2.6 ドキュメントと小修正

- B5: `manual.html:3928-3935`、`manual_ja.html:4056-4063` に `"subject": "rm",` と `"level": "block"` を足す。README の 1 行例（`README.md:217-218`、`README_JA.md:216-217`）も同様。
- `pkg/llm/llm.go:37` のコメント「OpenAI/Gemini/Claude」を直す（Claude のネイティブ対応はない）。
- 「macOS と Linux の sh」（`manual.html:1944`、`manual_ja.html:1958`）の表現を、「macOS の sh」に近い表現へ。
- 各フェーズで、マニュアル（英日）、README（英日）、`skills/md-memo`、`help.go` を同時に更新する（`main_help_test.go` が RPC メソッドの漏れを検出する）。

## 3. 実装計画

### フェーズ 1（約 9 日）編集体験と記載の修正
1. `findResultBlocks` と共通部品（0.5 日）
2. ガターのアクセントライン + 結果のコマンド 5 つ（3.5 日）
3. Ctrl+/ の切替 + プレビュー + JS・Go のパーサー + 共通テスト（3.25 日）
4. 自動タイトル（1.25 日）
5. B5 とコメントの直し（0.25 日）
6. 任意: 本文の薄い背景（+1.5〜2 日、`resultBlockTint`）

### フェーズ 2（約 6.5 日）CLI の基盤
下地 → `--out` → `info` → `scrap` → `config get` + localStorage のキー除去 → `install-skill` → コンソール用 exe。

### フェーズ 3（約 6 日）RPC の書き込み
トークン必須（§6 で決定）→ `--tab` の書き込み → `tab new / close` → `buffer save`。

### フェーズ 4（約 9〜11 日）エージェント
S0（スキーマ + 既定値）→ 10 と 14 → 11 の後半と 12 → 16 と 15 → 13 → B8 → B9（再現後）。

**フェーズの入れ替え案**: 安全性を先に高めたければ、S0・12（警告）・11 の確認ダイアログ（約 3.5 日）を、フェーズ 1 の前に出す。

### 実装の進め方（並列にするとき）
- 過去の方針どおり、大きな作業はサブエージェントに任せ、**共有の契約ファイル + 担当ファイルの分離 + 統合役**で進める。報告は信用せず、自分でテスト・差分・ブラウザ確認をする。
- 火種は `frontend/js/app.js`（約 11,000 行）。並列の作業が同じ場所を触らないよう、**app.js への差し込みは統合役だけが行い**、各担当は新しいモジュール（`result_blocks.js`、`comment_toggle.js`、`note_title.js`）を作る。
- 別のセッションが同じツリーで作業している（音声入力、v1.8.0 など）。コミットは、自分のパスだけを対象にする。
- 担当の分け方の例（フェーズ 1）: A = 検出とガター、B = Ctrl+/ と JS・Go のパーサー、C = タイトルとドキュメント。契約 = `findResultBlocks` / `htmlCommentRanges` の入出力と、テストベクトルの置き場所。

### 検証
- 各機能の単体テスト（JS・Go）と、`node tools/run_js_tests.mjs`、`go test ./...`（隔離：実機の設定・Ollama・OpenExternal に触れない）。
- 実ブラウザ（Chromium のモック環境）での操作確認と、スクリーンショットの確認。カーソルオーラの輝度は、背景の有無で比べる。
- **実機で確認が要るもの**: WebView2 と Mac の WKWebView での層の揃え、Ctrl+/ の JIS キーボード・IME、Windows のコンソール用 exe、Mac の Finder、winget / Homebrew。
- 各フェーズの終わりに CI（Windows と macOS）を確認してから、リリースは指示があってから。

## 4. リスク

| リスク | 対策 |
|---|---|
| JS と Go のコメント判定が食い違い、別のスロットが実行される | 共通のテストベクトル。フォールバックが働かないことのテスト |
| 背景の層が、ずれる・遅れる・オーラを隠す | ガターを先に作る。背景は低い不透明度で最背面、既定 off |
| 確定（マーカー除去）後に本文の記法が生き返る | コマンドの説明に明記。1 回の Undo で戻せる |
| トークン必須化で、既存のクライアントが壊れる | 段階導入（警告のみ → 必須）。ドキュメントに明記 |
| 既定値の変更が、既存の設定に届かない、または `agy -p` が止まる | 移行の通知。確認ダイアログを先に |
| `secrets.json` 化で、旧版が平文を書き戻す | 案 (a) だけ先にやり、(b) は必要が出てから |
| Windows のコンソール用 exe と winget の版 | 新しいマニフェストの版が必要。PR #438694 が先 |

## 5. 見積もり表（作業日）

| フェーズ | 内容 | 日数 |
|---|---|---|
| 1 | 編集体験 + 記載の修正 | 約 9（背景の層を入れると +1.5〜2） |
| 2 | CLI の基盤 | 約 6.5 |
| 3 | RPC の書き込み | 約 6 |
| 4 | エージェント | 約 9〜11 |
| 合計 | | **約 31〜33（背景込みで 33〜35）** |

## 6. 決めてほしいこと

1. **結果ブロックの本文の背景**: アクセントラインだけで足りるか、薄い背景も要るか（要るなら既定 off か subtle か）。
2. **コメントの形式**: 既定は行ごと（`line`）でよいか。`block` も選べるようにするか。
3. **RPC の書き込みのトークン必須化**: 互換性を切るか、段階的にするか。
4. **`buffer save` の上書き**: 既存ファイルの上書きに `--overwrite` を必須にしてよいか。
5. **`--dangerously-skip-permissions` の既定**: 外す前に確認ダイアログ + 移行の通知を先にする順序でよいか。
6. **API キー**: 案 (a)（キーを隠した `config get` + localStorage の除去）まででよいか。
7. **B1〜B4**: どの README を見たか（古い複製の可能性）。
8. **B9**: コンソールのログ付きで再現してもらえるか（DevTools の `Ctrl+Shift+I` が使えるか要確認）。
9. **フェーズの順序**: 編集体験を先にし、安全性の 3.5 日分を前倒しするか。

## 7. 決定事項（2026-09-25 回答）

1. 結果ブロックは**ガターのアクセントラインだけ**（本文の背景の層は作らない。`resultBlockTint` も作らない）。
2. コメントは**行ごとが既定**（`general.commentStyle` = `line`。`block` も選べる）。
3. 書き込み RPC は**トークン必須**。トークンなし・誤りは、エラーを返す（段階導入はしない）。
4. `buffer save` は、既存ファイルの上書きに **`--overwrite` を必須**にする。
5. `--dangerously-skip-permissions` の既定は、**確認ダイアログと移行の通知を先に**出してから外す。
6. API キーは、**キーを隠した `config get` と localStorage からの除去まで**（`secrets.json` 化はしない）。
7. B1〜B4 は、どの README か不明（GitHub の最新だと認識）。現在のツリーでは成り立たないので、**変更しない**（B3 の「macOS と Linux の sh」の言い回しと、llm.go のコメントだけ直す）。
8. B9 は、ユーザーの環境で**再現できる**。再現手順（記法、エージェント、操作）を教えてもらってから直す（フェーズ 4）。
9. 順序: **フェーズ 1（編集体験）→ 安全性の前倒し分（S0 スキーマと既定値、12 の警告、11 の確認ダイアログと移行の通知、約 3.5 日）→ フェーズ 2 → 3 → 4（残り）**。
