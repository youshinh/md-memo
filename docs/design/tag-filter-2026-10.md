# タグと検索の絞り込み（2026-10-03）

状態: 第 1 段（タグの読み取りと、検索の絞り込み）は 2026-10-03 に実装し、実アプリで確かめた（§9）。第 2 段（タグを付けるコマンド）は §10、見出しの下すべてに効く拡張は §11（2026-10-04）。第 3 段（AI の提案）は未着手。この文書は実装の契約でもある。

## 1. 決めたこと（利用者との合意）

- 目的は **検索のときの絞り込み**。タグは手がかりであって、分類の仕組みではない。
- タグは **ノートの本文に隠しコメントとして書く**。プレビューにも印刷にも出ない（HTML コメントはプレビューが取り除く: `app.js` の `HtmlComments.removeComments`）。別ファイルには保存しない（別のPCに行かない、名前を変えると外れる）。
- 範囲は **書き込み単位が基本、ファイル単位にもなる**（§2）。
- 絞り込みは **検索の機能として作る**。画面のボタンだけにしない。CLI・JSON-RPC・スキルから同じ絞り込みができる。
- **日付は、今ある意味（ファイル名の日付）のまま**使う。ファイル名に日付のないノートは日付の範囲に入らない。その件数を画面に出す。見出しの日付や更新日時での補完は、この段では入れない（意味検索の索引がファイル名の日付を保存しているため、補完を入れると索引の作り直しが要る。§7）。
- 自動生成（AI の提案）は後。**Jev はこの機能から外す。**
- 使わなければ無コスト。タグ絞り込みが指定されない検索は、今までと同じ経路・同じ速さで動く。

## 2. タグの書き方と範囲

### 2.1 書き方

1 行まるごとが次の形のコメント（前後の空白は可）:

```
<!-- tags: 仕事, 買い物 -->
```

- キーは `tags`（`tag` も可、大文字小文字は問わない）。コロンの後ろがタグの並び。
- 区切りは、空白、`,`、`、`、`，`、`;`、`；`。先頭の `#` は取る。1 つのコメントに最大 32 個、1 つのタグは最大 64 文字（超えたものは捨てる）。
- 1 行に収まるコメントだけを読む。複数行にまたがるコメント、行の途中にあるコメント、**コードフェンスの中**は読まない（この仕様を書いた文書そのものを検索したときに誤って拾わないため）。
- ファイルの先頭の YAML フロントマターに `tags:` / `tag:` があれば読む（**読むだけ。MD-Memo は書かない**）。形は `tags: [a, b]`、`tags: a, b`、`tags:` に続く `- a` の並び。最初の `---` の次の最初の空でない行が `key: value` の形のときだけフロントマターとみなす（`---` に続く `## [10:05:00] ...` はフロントマターではない）。

### 2.2 正規化

`NormalizeTag`: 前後の空白と先頭の `#` を取り、全角の ASCII（`！`〜`～`、全角空白）を半角に直し、小文字にする。ひらがな・カタカナの統一や同義語の処理はしない。比較は正規化したもの同士で、表示にも正規化後の形を使う（先頭の `#` なし）。

### 2.3 範囲

タグは、次のどちらかの範囲に付く。

- **ファイル全体**: ファイルの先頭から最初の見出し行・区切り線（`---`）の前まで（前文）にあるタグのコメント、またはフロントマターの `tags:`。
- **その書き込み**: それ以外の場所にあるタグのコメントは、それを含む書き込み（`search.Entries` が切る単位: `#`〜`###` の見出し、または `---` の区切り線から次まで。コードフェンスの中は数えない）に付く。

ある書き込みの **有効なタグ** は、ファイル全体のタグと、その書き込みのタグと、**その書き込みの上の見出しのタグ**（`#` の下の `##` が引き継ぐ。§11 で追加した。最初に作った版は引き継ぎをしなかった）の和集合。ノート全体に付けたいときは、最初の見出しより上に書く。

## 3. 絞り込みの意味

- タグの指定は **すべてを含む（AND）**。`--tag 仕事,急ぎ` は、有効なタグに「仕事」と「急ぎ」の両方がある書き込み。
- 語の検索の行ごとの結果（完全一致）では、見つかった行を含む書き込みの有効なタグで判定する。順位つきの語の検索（ranked）では、書き込みごとに判定する。意味検索では、チャンクの先頭行を含む書き込みで判定する（索引を作ったあとにファイルが変わると、ずれることがある。次の索引更新で直る）。
- 指定したタグが 1 つも見つからなくても、エラーにはしない（結果が 0 件になる）。
- タグの指定がなければ、今までと同じ。

### 3.1 日付

`From` / `To`（`YYYY-MM-DD`、端を含む）はこれまでどおり。ファイル名の日付の判定を **`scrap.DayOfName`** に一本化する: 名前の先頭が実在する `YYYY-MM-DD` で、その直後が数字以外（`.md`、`_`、空白、`-` など）。`2026-09-27_How Might We.md` は 2026-09-27 のノート。これまで語の検索の日付の範囲は `YYYY-MM-DD.md` ちょうどだけを日付つきとしていたが、意味検索の索引（`semindex.dateOfName`）は先頭の日付を使っていた。**語の検索を意味検索に揃える**（保存名の初期値 `YYYY-MM-DD_要約.md` が範囲に入るようになる）。

## 4. インターフェース契約

### 4.1 Go: `pkg/scrap`

```go
// DayOfName is the day a note's file name starts with: "2026-09-27_How Might We.md" gives "2026-09-27". It is false for a name that
// does not start with a real calendar day written YYYY-MM-DD, or whose next character is a digit ("2026-09-271.md").
func DayOfName(name string) (string, bool)
```

`semindex` の `dateOfName` は `scrap.DayOfName` を呼ぶ形に置き換える（結果は、実在しない日付 `2026-02-30` を日付と見なさなくなる点だけ変わる。索引は作り直さない）。`DateOfFile` は残す（日別ファイルの一覧 `scrap list` が使う）。

### 4.2 Go: `pkg/search/tags.go`（新規、純粋関数）

```go
func NormalizeTag(s string) string
// ParseTagList reads a person's list ("#仕事, 急ぎ"): normalized, de-duplicated, in order. At most 8 tags; the rest are dropped.
func ParseTagList(s string) []string

// TagMap holds the tags of one file: the ones of the whole file and the ones of each entry (the entries of Entries(data)).
type TagMap struct{ /* unexported */ }
// ScanTags returns nil when the file cannot carry a tag (no "<!--" and no front matter): a cheap check before any parsing.
func ScanTags(data []byte) *TagMap
func (m *TagMap) HasLine(line int, want []string) bool    // the entry holding this 1-based line has all of want (file tags included)
func (m *TagMap) HasEntry(i int, want []string) bool
func (m *TagMap) FileTags() []string
func (m *TagMap) EntryTags(i int) []string                // only that entry's own tags

type TagCount struct {
	Tag     string `json:"tag"`
	Files   int    `json:"files"`   // files that carry the tag in any scope
	Entries int    `json:"entries"` // entries the tag applies to (a whole-file tag counts every entry of its file)
}
// CollectTags walks the scrap folder (the same files the search reads: .md, no dot folders) and counts the tags. Sorted by Files
// descending, then Tag. It honours ctx.
func CollectTags(ctx context.Context, scrapDir string) ([]TagCount, error)
```

`Options`（`pkg/search/ordered.go`）に追加: `Tags []string`（正規化済み。空 = 絞り込みなし）。`SearchScrapsOrdered` と `SearchScrapsRanked` が使う。ファイルを読む前に `Keep` を通し、`Tags` があるファイルは、ファイルを読んで `ScanTags` が nil か、必要なタグを 1 つも持てないものを捨てる。完全一致は、見つかった行を `HasLine` で判定してから件数に数える。ranked は、書き込みの採点の前に `HasEntry` で判定する。

追加: `SearchScrapsWithFallbackOptions(ctx, scrapDir, query, maxResults, opts Options)`。画面の完全一致の検索が使う: `SearchScrapsOrdered`（opts つき）→ 0 件なら `SearchScrapsRanked`（同じ opts）。opts が空なら `SearchScrapsWithFallback` と同じ結果になること（同じ関数を呼べばよい）。

### 4.3 Go: `pkg/semindex`

`SearchOptions` に `Keep func(rel string, line int) bool`（nil = 全部通す）。チャンクを採点する前に呼ぶ。`Rel` は索引の相対パス（`/` 区切り）、`line` はチャンクの先頭行。

### 4.4 Go: `pkg/cli`

- `ScrapSearchParams` に `Tags []string \`json:"tag"\``。どの検索（語・ranked・意味）でも使える（`--semantic` が要る制限は付けない）。`scrapSearch` は `ParseTagList` 相当の検証をしてから渡す。8 個を超える指定は `paramErr`。
- 語の検索の日付の範囲は `scrap.DayOfName` を使う（§3.1）。意味検索側の語へのフォールバック（`keepWords`）にも同じ。
- 意味検索: `semindex.SearchOptions.Keep` にタグの判定（ファイルごとに 1 回だけ読んでキャッシュ）を渡し、索引にまだない/古いファイルのための語の検索にも `Options.Tags` を渡す。
- `ScrapTags(ctx) (ScrapTagsResult, error)`、`ScrapTagsResult{Tags []search.TagCount \`json:"tags"\`; Files int \`json:"files"\`; Undated int \`json:"undated"\`}`。`Files` は走査した .md の数、`Undated` はそのうち名前に日付がないものの数。`Tags` は空でも `[]`（nil にしない）。
- CLI: `md-memo scrap search ... --tag <a,b>`（繰り返し可。語・`--ranked`・`--semantic` のどれとも組める）、新しい `md-memo scrap tags [--json|--text]`。`help.go` とスキル（`skills/md-memo/**`）に載せる（整合性テストが全フラグを要求する）。

### 4.5 JSON-RPC

- `scrap.search` の params に `tag`（文字列 `"a,b"` または文字列の配列。`kind` と同じ受け方）。
- 新メソッド `scrap.tags`（params なし。トークン必須）。結果は `ScrapTagsResult`。
- `docs/features.md` / `features_ja.md` の RPC 表、`manual.html` / `manual_ja.html` の JSON-RPC 表、`skills/md-memo/references/interfaces.md` に載せる（`python tools/check_manual.py` が見ている）。

### 4.6 画面の bind（Go ↔ ページ）

既存の bind に **最後の引数 `filterJSON string`**（空文字 = 絞り込みなし）を足す。形:

```json
{"tags": ["仕事"], "from": "2026-10-01", "to": "2026-10-03"}
```

- `SearchScrapsAsync(reqID, query, maxResults, filterJSON)`: 絞り込みなしは今までと同じ呼び出し（`SearchScrapsWithFallback`）。絞り込みありは `SearchScrapsWithFallbackOptions`。
- `SearchScrapsSemanticAsync(reqID, query, limit, filterJSON)`、`DeepSearchPlanAsync(reqID, query, limit, filterJSON)`: 同じ `cli.ScrapSearch` に `Tags/From/To` を渡す。**深掘りは、画面で絞り込んだ検索と同じ絞り込みで資料を集める**（絞り込みの外のノートの抜粋を AI に送らない）。
- 新しい bind `ScrapFilterOptionsAsync(reqID)`: `cli.ScrapTags` の結果を返す。結果の配送は `SearchScrapsSemanticAsync` と同じやり方（既存の `window.__mdmemoAsync` の約束に従う）。
- ページ側の `window.backend`: `searchScraps(query, max, filter)`、`searchScrapsSemantic(query, limit, filter)`、`deepSearchPlan(query, limit, filter)`、`scrapFilterOptions()`。`filter` はオブジェクトまたは null。Windows と macOS の両方の薄い橋渡し（`window_windows.go` / `window_darwin.go`）に同じ行を入れる（`platform_bridge_parity_test.go` が見ている）。
- 絞り込みの JSON に不正な値（日付の書式違い、9 個以上のタグ）があるときは、その検索を失敗させる（エラー文は 1 行）。

## 5. 画面

検索パネル（`Ctrl+Shift+F`）の入力欄の下に、**絞り込み**の行を足す。

- 行の左に「絞り込み」ボタン（細い線画のじょうごの SVG と文字。絵文字は使わない）。押すと下に絞り込みの領域が開閉する。絞り込みが有効なときは、ボタンに件数（例: 「絞り込み (2)」）を出す。
- 領域の中: **期間**（すべて / 今日 / 7 日間 / 30 日間 / 今月）のボタン列（1 つだけ選べる）と、**タグ**のボタン列（複数選べる、すべてを含む）。タグはファイル数の多い順、最大 40 個、あふれた分は「他 N 個」の表示のみ。タグが 0 個なら、タグの付け方を 1 行で案内する（`<!-- tags: 仕事 -->` と書く）。「解除」ボタンで全部外す。
- 期間を選んでいて、名前に日付のないノートが 1 件以上あるときは、1 行で「日付のないノート N 件は期間に入りません」と出す。
- タグ一覧と未日付の件数は、**絞り込みの領域を最初に開いたとき**に `scrapFilterOptions()` で取る（パネルを開くたびに 1 回まで）。開かなければ呼ばない。
- 絞り込みが変わったら、検索をやり直す（入力と同じデバウンス）。完全一致・意味・深掘りの 3 つすべてに同じ絞り込みが付く。深掘りのボタンは、絞り込んだ一覧の資料を使う。
- 0 件のとき、絞り込みが有効なら「条件に合うノートがありません」（絞り込みなしの文言とは別）。
- 絞り込みの状態は、アプリを開いている間だけ覚える（保存しない）。
- `Tab`（行の引用）と `Esc` など、パネルの既存のキー操作は変えない。絞り込みのボタンは `Tab` の巡回に入れない（`tabindex="-1"`）が、クリックとスクリーンリーダーの操作はできる（`aria-pressed`、`aria-expanded`）。

文言は英語と日本語（`i18n.js`）。マークアップと状態の純粋関数は新しい `frontend/js/scraps_filter.js` に分け、`app.js` からは薄く呼ぶ。

## 6. 軽さ

- タグの絞り込みがない検索は、ファイルを余計に読まない・追加の確保をしない。
- タグの絞り込みがある検索は、`<!--` もフロントマターもないファイルを 1 回の `bytes.Contains` で捨てる。
- `scrap tags` / `scrapFilterOptions` は、呼ばれたときだけフォルダを走査する。起動時には何もしない。
- 新しい依存は入れない。

## 7. この段に入れないもの

- タグを付ける・外すコマンド（第 2 段。既存のタグを補完候補にする）。
- AI のタグ提案（第 3 段）。
- 日付の補完（見出しの日付、更新日時）。意味検索の索引がファイル名の日付を保存しているので、入れるなら索引の版を上げて作り直させる必要がある（クラウドの埋め込みなら費用が出る）。
- 書き込み単位の日付。
- タグの別名、タグの OR 指定（見出しの階層での引き継ぎは §11 で入れた）。

## 8. 検証

- Go: 正規化・解析（コードフェンス内・1 行でないコメント・フロントマター・CRLF・BOM）・範囲（前文、書き込み、区切り線で始まる書き込み）・和集合・各検索（完全一致、ranked、意味）でのタグの絞り込み・フォールバック・`CollectTags`・日付の一本化・RPC・CLI・橋渡しの同一性。
- ページ: 純粋関数のテスト（`node tools/run_js_tests.mjs` の全件）、スモークの新しい流れ（英日）。
- 実機: 隔離した実アプリ（隔離の手順は `docs/maintenance`）で、タグつきのノートを置き、完全一致・意味（Ollama）・深掘りの計画が同じ絞り込みで動くこと。
- 軽さ: 絞り込みなしの検索の速さが変わらないこと（同じフォルダで前後を実測）。

## 9. 実装の結果（2026-10-03）

### 9.1 確かめたこと

- Go: `go vet ./pkg/... .`（既存の unsafe.Pointer の注意 4 件のみ）、`go test ./pkg/...` と `go test .` が全部通る。タグの解析、範囲、各検索（完全一致、ranked、意味、索引にまだないファイルの語への切り替え、モデルが使えないときの切り替え）、`CollectTags`、日付の一本化、RPC、CLI、橋渡しの同一性。
- ページ: `node tools/run_js_tests.mjs` 112/112、スモーク 45/45（英語・日本語。新しい流れは `103_search_filter`）。
- 実アプリ（隔離した実 WebView2、本物の Ollama `bge-m3`、5 つのノート）: 完全一致・意味・深掘りの計画のすべてで、タグ（1 つ、2 つ、見つからない）・期間（7 日、今月、30 日）・解除が期待どおり。前文のタグ（ファイル全体）、書き込みのタグ、フロントマターのタグ、コードフェンス内のタグ（数えない）。`scrap.tags` と `scrap.search` の `tag`（文字列・配列・9 個のエラー）も、起動中のアプリへの JSON-RPC で確かめた。
- 深掘りの計画: 絞り込みの外のノートは資料にならず、隣の書き込み（短い書き込みに足される前後）も絞り込みの条件を満たすものだけ（`tag 読書` の計画は、そのタグの書き込みの 3 行・49 文字だけ。絞り込みなしでは前後を含む 7 行）。
- 速さ: 既存の `BenchmarkSearchScraps`（50 ファイル）が、変更前 1.50〜1.67 ms・2.07 MB・645 回の割り当て、変更後 1.51〜1.69 ms・2.07 MB・644〜645 回で、差は誤差の範囲。絞り込みなしの経路は追加の読み込みをしない。ページ側は、絞り込みの領域を開くまで何も作らず・何も尋ねない（パネルを開く時間 9.4 µs → 11.4 µs、300 個のタグを最初に描く 1.1 ms）。

### 9.2 契約からの変更と、契約になかった決めごと

- 検索の抜粋（ヒットの前後の行）に、タグのコメントの行を入れない（`search.IsTagCommentLine`）。プレビューに出さない方針を、検索結果にも通すため。その行が検索語に合えば、ヒット自体は残る。行番号は変わらない。
- `search.ParseTagFilter`（検索の指定用）は、9 個以上、64 文字を超えるタグ、タグを含まない文字列を **エラー**にする（`ParseTagList` は黙って捨てる）。指定したタグを黙って落とすと、意図より多く通してしまうため。
- 深掘りの資料づくり（`deepsearch.BuildSources`）は、短い書き込みに足す前後の書き込みを、絞り込みの外から持ってこない（`Options.Tags`、`Stats.Filtered`）。契約の「絞り込みの外の抜粋を送らない」を満たすための穴ふさぎ。
- `scrapFileOrder`（検索結果の並び）とヒットの日付も `DayOfName` を使う。`2026-09-27_x.md` は日付つきの並びに入り、日付が出る。`scrap list` は `DateOfFile` のまま。
- `semindex.dateOfName` は、日の直後が数字（`2026-09-271.md`）なら日付としない。索引は作り直さない。
- フロントマターは、`---` か `...` で閉じるまでが 200 行以内のときだけ。閉じる `---` の前後で、検索の区切りが 2 つの書き込みに切る（検索自身の切り方のまま）。
- `NormalizeTag` は全角を半角にしてから `#` を取る（`＃仕事` → `仕事`）。冪等。
- `deepsearch.plan`（JSON-RPC）は絞り込みの引数を持たない（契約が定めていない）。
- ページ: 「今月」は 1 日から今日まで。選べるタグは 8 個まで（8 個選ぶと、残りは押せなくなる）。選んだタグは 40 個目より後でも表示する。領域はパネルを開くたびに閉じた状態から始まり、選んだ絞り込みはアプリを開いている間は残る。タグの読み込みに失敗したら 1 行出し、次にパネルを開くまで読み直さない。

### 9.3 まだ確かめていないこと

- macOS（`window_darwin.go` の橋渡しは Windows と同じ行で、テキストの一致テストは通るが、cgo のコンパイルは CI まで）。
- スクリーンリーダー。
- 数千件のノートでの `scrap tags` / 絞り込みつき検索の時間（絞り込みなしは変わらないことだけ測った）。
- 日付の補完と書き込み単位の日付は入れていない（§7）。

## 10. 第 2 段: タグを付ける・外す（2026-10-03 着手、この節が契約）

状態: 2026-10-03 に実装し、実アプリで確かめた（§10.8）。第 1 段の仕様（§2 の書き方と範囲、§3 の意味）はそのまま。

### 10.1 方針

- **書き換えの計算は Go の 1 か所**（`pkg/search/tagedit.go`）。画面（パレットのコマンド）、CLI、JSON-RPC はそれを呼ぶだけ。範囲の規則（§2.3）を JS に写さない（二重実装は食い違う）。
- 計算は **純粋関数**: テキストを受け取り、直す行の指示（行の差し替え）を返す。ファイルを読み書きしない。画面は開いているタブのテキストにその指示を **1 回の取り消し単位**で当てる。
- CLI は標準出力へ新しいテキストを出す（`sed` のように使える）。ファイルを書くのは `--write` を付けたときだけで、`scrap` の他のコマンドは読み取り専用のまま。JSON-RPC は **ファイルにも画面にも触らない**計算だけ（エージェントは `buffer.get` → `scrap.tag_edit`（`return_text`）→ `buffer.set`（`expected_hash` つき。`buffer.replace_all` は検索と置換なので使えない）、または自分でファイルを書く）。
- 新しいショートカットは作らない（コマンドパレットだけ）。AI の提案は第 3 段。

### 10.2 書き換えの規則（`search.EditTags`）

行は `\n` で区切り、行末の `\r` は内容に含めない。コードフェンスの中の行・見出し/区切り線の判定は、検索と同じもの（`Entries`、`headingTracker`）を使う。

- **範囲**
  - `scope = "note"`: ファイル全体。
  - `scope = "entry"` と `line`（1 始まり）: その行を含む書き込み。**その行より上に見出しも区切り線もない（前文）、またはファイルに見出しも区切り線が 1 つもないときは、ファイル全体と同じ**なので、`scope` は `"note"` に切り替わって返る（結果の `scope` が実際に使った範囲）。
- **付ける（`add`）**
  - 対象の範囲に有効なタグ（ファイル全体のタグ ∪ その書き込みのタグ）としてすでにあるタグは付けない（`unchanged` に入れる。ファイル全体のタグが書き込みに効いているときも同じ）。
  - 付けるタグがあるとき、対象の範囲に **タグのコメント行がすでにあれば、最初の 1 行に足す**（順序は書いた順、正規化、重複なし）。1 行に 32 個を超えるぶんは、その下に新しい行を作る。**なければ新しい行を作る**: `note` はファイルの 1 行目（BOM があれば BOM の後ろでなく、新しい行の頭に BOM を移す）、`entry` はその書き込みの見出し行の**直後**（区切り線で始まる書き込みは、区切り線の次の見出し行の直後。見出しがなければ区切り線の直後）。
  - 書き換える行の形は `<!-- tags: a, b -->`。行頭の空白は元のまま。行末は元のファイルの改行（CRLF のファイルなら CRLF、結果の `eol`）。
- **外す（`remove`）**: 対象の範囲のタグのコメント行から、そのタグを取る。タグが 1 つも残らない行は **行ごと消す**。ない範囲のタグは `unchanged`。タグが **もう一方の範囲にだけある**ときは、何も変えず `message_code` にそれを書く（`on_note` / `on_entry`）。**フロントマターの `tags:` にだけあるタグは外せない**（`message_code = "front_matter_tag"`。MD-Memo はフロントマターを書かない）。
- **フロントマターのあるファイルの `note`**: 付けられない（`message_code = "front_matter"`、何も変えない）。`entry` は使える。理由: コメントをフロントマターの上には置けず、下に置くと「ファイル全体」ではなく、閉じる `---` の次の書き込みのタグになってしまう（§9.2）。
- **べき等**: 同じ指示を 2 回しても、2 回目は何も変えない。
- 入力の検査: `tags` は `ParseTagFilter` と同じ規則（空は不可、正規化、1 回 8 個まで、64 文字まで。**エラー**にする）。`line` が範囲外は不可。`text` は 16 MB まで。
- **書き換えたあとの検査**（テストの性質）: `ScanTags(新しいテキスト)` で、その範囲のタグに足したタグが入り、外したタグが入っていないこと。ほかの書き込みのタグは変わらないこと。

### 10.3 型

```go
type TagEdit struct {
	Changed   bool     `json:"changed"`
	Scope     string   `json:"scope"`       // "note" or "entry": the range that was used
	StartLine int      `json:"start_line"`  // 1-based; the lines [StartLine, EndLine) of the old text are replaced by NewLines
	EndLine   int      `json:"end_line"`    // EndLine == StartLine: lines are only inserted before StartLine. (StartLine = number of lines + 1 appends)
	NewLines  []string `json:"new_lines"`   // no line endings; empty with EndLine > StartLine: lines are deleted
	Eol       string   `json:"eol"`         // "\n" or "\r\n": the file's own, for joining NewLines
	Line      int      `json:"line"`        // 1-based line of the tag comment in the NEW text (the one that was added to or created); 0 when none is left
	Added     []string `json:"added"`       // never nil
	Removed   []string `json:"removed"`
	Unchanged []string `json:"unchanged"`
	// The tags that apply in the range after the edit, for the screen's feedback: of the whole note and of the entry.
	NoteTags  []string `json:"note_tags"`
	EntryTags []string `json:"entry_tags"`
	// MessageCode says why nothing (or not everything) was done: "" | "already" (every tag was there) | "front_matter" | "front_matter_tag" |
	// "on_note" | "on_entry" | "none_found" (remove: no such tag in the range).
	MessageCode string `json:"message_code"`
}
func EditTags(data []byte, op, scope string, line int, tags []string) (TagEdit, error) // op: "add" | "remove" | "show"
func (e TagEdit) Apply(data []byte) []byte   // the new text (uses Eol for the joins; keeps every other byte)
```

`op = "show"` changes nothing (`Changed=false`): it answers `NoteTags` / `EntryTags` / `Scope` for the entry at `line` (for the screen's "Remove tag" list and for `scrap tag show`); `tags` may be empty only for `show`.

### 10.4 CLI

```
md-memo scrap tag add <tags> [<file>] [--line <n>] [--write] [--json]
md-memo scrap tag remove <tags> [<file>] [--line <n>] [--write] [--json]
md-memo scrap tag show [<file>] [--line <n>] [--json|--text]
```

- `<tags>`: one argument, a list as in `--tag` (`"仕事, 急ぎ"`; a leading `#` is taken off). `<file>`: a path (relative to the current folder); without it the text is read from standard input (a pipe; decoded like the pipe does) and `--write` is an error.
- Without `--line` the range is the whole note; with `--line n`, the entry holding line n (`entry`; may come back as `note`, §10.2).
- Output: the new text on standard output, exactly (no extra newline), exit 0; when nothing changed the text is unchanged and a line on standard error says why (`already ...`); `--json` prints the `TagEdit` instead (and with `--text` nothing is added). Exit 1 for a refusal (`front_matter`, `front_matter_tag`, `on_note` / `on_entry`, bad arguments).
- `--write`: replaces the file in place and prints nothing but the summary on standard error. Safe write: a temporary file in the same folder, the same mode, then rename; the file is read again just before and the write is refused if it changed since it was read. It never creates a file. A file over 16 MB is refused.
- `help.go`, the skills (`skills/md-memo/**`) and the consistency tests list every flag.

### 10.5 JSON-RPC

`scrap.tag_edit` (token required; no file and no screen is touched): params `{"text": "...", "op": "add|remove|show", "scope": "note|entry", "line": 12, "tags": ["仕事"] | "仕事, 急ぎ", "return_text": false}`; `scope` defaults to `"note"` (and `"entry"` needs `line`). Result: the `TagEdit` object (§10.3); with `return_text` also `"text"`: the whole new text. Invalid params: -32602. Add to `rpcHelp`, the manual tables, `skills/.../interfaces.md`.

### 10.6 画面

- **パレットのコマンド 3 つ**（コマンドパレットの検索語は英語は "tag"、日本語は "タグ"）: 「この書き込みにタグを付ける」「ノート全体にタグを付ける」「タグを外す」。アクティブなエディタ（分割していればフォーカスのあるほう）のテキストが対象。書き込みの判定に使う行は、キャレットの行（選択があれば選択の最初の行）。
- 選ぶ画面は、スニペットの選択（`SlotAgent.openSnippetPicker`）のように、入力欄と候補の一覧を持つ小さなパネル（`docs/design/panel-template.md`）。
  - 付ける: 入力欄に打つと、候補が絞られる。候補は **フォルダのタグ**（`scrapFilterOptions()` の `tags`、多い順、パネルを開いたときに 1 回だけ読む）と、**今のテキストにあるタグ**（`op:"show"`）。打った文字列そのものを「新しいタグ: ○○」として先頭近くに出す。Enter で付ける。`,` や空白で区切って複数打てる。
  - 外す: 候補は **対象の範囲に付いているタグ**（書き込み→ノート全体の順に区別して表示。`show` の `entry_tags` / `note_tags`）。Enter で外す。
  - 範囲は「付ける」のコマンドで決まる（書き込み / ノート全体）。「外す」は、書き込みにあるタグ・ノート全体にあるタグの両方を候補に並べ、選んだ側の範囲で外す。
- 結果は、ステータスの 1 行で言う（付けた / すでにある / 外した / 結果の `message_code` ごとの 1 文）。何も変えなかったときはテキストに触らない。
- **取り消し 1 回で元に戻る**。キャレットと選択は、直した行より後ろにあれば行数のぶんずらす。
- **`Ctrl+/` はタグのコメント行に触らない**（`comment_toggle.js`: マーカー行と同じ扱いで、外さない・コメントにもしない。選択がタグ行だけなら何もしない）。
- bind: `TagEditAsync(reqID, reqJSON)`（`reqJSON` は 10.5 の params。配送は `SearchScrapsSemanticAsync` / `ScrapFilterOptionsAsync` と同じ `window.__onDeepSearchResult`）、ページ側 `window.backend.tagEdit(request)`（`request` はオブジェクト、結果は `TagEdit`）。`window_windows.go` と `window_darwin.go` の両方、モックの両方（スモークの `semantic_lib.mjs` 系と `tools/docshots/mock/backend.js`）。見つからない（古いバックエンド）ときは、コマンドを出さない。
- 文言は英語と日本語（`i18n.js`、`message_code` ごとの文を含む）。絵文字は使わない。

### 10.7 入れないもの / 注意

- フロントマターへの書き込み、AI の提案、複数ノートへのまとめ付け。
- ノートが `<!--` を含むかの簡易判定などで、タグの行がログの種類の判定（見出しの直後のコードフェンス）を壊さないこと: 見出しの直後にタグのコメントを足すと、`semindex` の「ログ」判定（`ChunkFile`）が変わらないか確かめ、変わるなら判定側でタグ行を飛ばす（既存の索引は作り直さない）。
- JSON-RPC の `scrap.tag_edit` は計算だけなので、これで AI や外への送信は起きない。

### 10.8 実装の結果（2026-10-03）

**確かめたこと**
- Go: `go vet ./pkg/... .`（既存の注意 4 件のみ）、`go test ./pkg/... .` 全 35 パッケージ。`EditTags` の表の試験 78 件、**性質の試験 2000 件**（固定の乱数で、ランダムなノートと操作に対して、`ScanTags` でタグが契約どおりの範囲に入る・ほかの書き込みのタグが変わらない・`Apply` が独立した行の差し替えと一致する・2 回目は何も変えない）。1 回だけ 30 万件も通した。正解データ `pkg/search/testdata/tagedit_golden.json` は 51 件（`-update` で作り直し、通常の実行は違いで失敗する）。
- ページ: JS 114/114、スモーク 46/46（英語・日本語）。モック（`tools/docshots/mock/tag_edit_mock.js`）は正解データ 51 件を全部、全項目で一致（見送りなし）。わざと 1 行ずらすと、スモークと単体試験の計 11 件が落ちる。
- **実アプリ（隔離した実 WebView2 と本物の Go の橋渡し）**: パレットから 3 つのコマンド。書き込みへの追加（見出しの直下、フォルダのタグが候補に出る、新しいタグの行）、**取り消し 1 回でバイト単位で元に戻り、やり直しも効く**、ノート全体への追加（2 つのタグ、1 行目）、「すでに付いています」、`Ctrl+/` がタグの行を動かさない、外す（候補にノート全体 / 書き込みの別が出る）、フロントマターのノートはノート全体を断り（文あり）書き込みへは付けられる、Esc でピッカーが閉じてフォーカスがエディタに戻る。**マウスのクリック**（パレットの項目、候補の行）でも同じ。
- CLI を実際のノートで: 区切り線で始まる日付のノート、CRLF のノート（改行が保たれる）、BOM つきのノート（BOM が先頭に残る）、フロントマター（ノート全体は断る、フロントマターだけのタグは外せない）、`--write` の 2 回目は何も変えない、`show --json`。

**契約になかった決めごと（担当の判断を私が確認した）**
- `-->` / `<!--` を含むタグはエラー（書いた行が、タグの行として読めなくなるため）。全角の `－－＞` も正規化後に判定する。
- `line` がフロントマターの中、またはエディタの最後の空行でも受け付ける（フロントマターの中は `note` に切り替わり、付ける操作は断る）。`scope = note` では `line` を無視し、`entry_tags` は常に空。
- 付けられなかった理由が複数あるときは、「どこを見ればよいか」を言う理由（`front_matter_tag`、`on_note`、`on_entry`）を優先する。一部だけ外せた場合も、この 3 つは付く（`changed` は true）。`already` と `none_found` は何も変えなかったときだけ。
- 改行は、テキストの最初の改行のもの。混在するファイルで、1 回の外す操作が 2 つのタグの行をまたぐときは、間の行もその改行でつなぐ。
- 書き直すタグの行は、読み込みの規則が無視するもの（64 文字を超えるタグ、33 個目以降）を落とす。
- CLI: 付ける・外すは新しいテキストを標準出力へ（`--json` なしで）、`show` はパイプなら JSON。断った場合、`--json` ならまず `TagEdit` を出してから `Error:` と終了コード 1。一部だけできた場合は終了コード 0 で標準エラーに 1 行。`--write` はシンボリックリンクの先を書く。標準入力は `DecodePiped`（BOM を落とす）、ファイルはバイトのまま。
- `semindex`: 見出しの直下のタグの行は、「ログ」の判定（見出しの直後のコードフェンス）を壊さない（コメントを消してから判定。`chunk.go` の変更なし、`ChunkerVersion` もそのまま）。1000 文字を超えるログの最後の 1 文字が落ちるが、タグを付けたその 1 つの塊だけ。
- ページ: `Tab` で選んだ行を決める（スニペットの選択と同じ）。タグの 9 個目・64 文字超・`-->` は、黙って捨てず文で断る。要求の間にノートが変わったら何も当てない（「その間にノートが変わりました」）。当てたあと、変えた行を「変更行の帯」で示す。`Ctrl+/` は、`block` の形で、タグの行を他の行と一緒にコメントにしようとするときは、新しい理由 `tags` で断る。テキストは 2 回送る（`show` と本番）ので、数 MB のノートでは時間がかかる（`EditTags` 自体は 15 MB・60 万行で約 60 ms）。

**まだ確かめていないこと / 既知の問題**
- macOS（`window_darwin.go` の橋渡しは Windows と同じ行）。IME の変換中の `Enter`。スクリーンリーダー。数 MB のノートでの体感の速さ。
- **既存の問題（第 2 段より前から）**: `search.Entries` と検索は BOM を見ないので、BOM つきのファイルの 1 行目にある見出し・区切り線・コードフェンスが見えない。BOM を動かす操作（ノート全体への追加、最初のタグ行の削除）で書き込みの構造が変わる。性質の試験は、この場合（2000 件中 75 件）だけを飛ばしている。直すなら `Entries` の 1 行目から BOM を取る（`ranked.go`）。

## 11. 見出しの下すべてに効くタグ（2026-10-04 契約）

利用者の使い方（見出しの下に Web 記事を貼る）では、記事自身の見出し（`#`〜`###`）が書き込みを何個にも分けてしまい、「この書き込み」のタグが記事の一部にしか効かなかった。**タグの行は増やさず、見出しに付けたタグを、その見出しの下の小見出しすべてに効かせる**（アウトラインの継承。Org-mode のタグと同じ考え方）。§2.3 の「見出しの階層による引き継ぎはしない」を、この節で置き換える。

### 11.1 意味

- **見出しの深さ**: 書き込み（`Entries` が切る単位）ごとに、その見出し行（`anchor` が指す行。`---` の次に見出しがあればその行）の先頭の `#` の数（1〜3）。見出しがない書き込み（区切り線だけ）と前文は 0。
- **親**: 書き込みを順に見て、見出しの深さの**スタック**（深さが厳密に増える並び）を持つ。書き込み j（深さ L）について:
  - L = 0（見出しのない書き込み: `---` だけの書き込み。前文）: スタックを空にする。親なし。スタックには積まない。
  - j が `---` の区切り線で始まり、その次の行が見出し（L ≥ 1）: スタックを空にして、親なし、j を積む（アウトラインは `---` で区切られる）。
  - それ以外（見出しで始まる）: スタックの先頭の深さが L 以上の間、取り除く。残った先頭が親（なければ親なし）。j を積む。
  例: `# A` / `## B` / `### C` の C の親は B。`# A` / `### C` の C の親は A（深さを飛ばしてよい）。`## B` が `# A` の下に続いたあとに `# A2` が来れば A2 は根（B の親ではない）。`---` + `## ping` は根で、その下の `### 詳細` はその子。`# A` / `## B` / `---` / `### C` の C は根（`---` だけの書き込みが鎖を切る）。
- **有効なタグ**: 書き込み j に効くタグ = ノート全体のタグ ∪ j 自身のタグ ∪ j の祖先（親、親の親…）それぞれの自身のタグ。検索（完全一致・ranked・意味・深掘りの資料づくり）、`CollectTags`、`HasLine` / `HasEntry` はすべてこの有効なタグで判定する（深掘りの前後の書き込みの検査も同じ）。
- **範囲**: 書き込み i の範囲（部分木）= i の最初の行から、i の子孫の最後の行まで（子孫 = i を祖先とする書き込み。i の直後から連続する）。

### 11.2 `EditTags` と結果（追加・変更）

- 付ける（`add`）: **有効なタグ**（祖先とノート全体の分を含む）にすでにあるタグは付けない（`unchanged`、`message_code = "already"`）。付ける場所は今までどおり、対象の書き込みの見出しの直後（対象の行は、呼ぶ側が決める: 子孫を含めたいときは、祖先の見出しの行を渡す）。
- 外す（`remove`）: 対象の **自身の** タグ行から外す。そこにはなく、**祖先に**ある（有効なタグとして届いている）ときは、何も変えず `message_code = "on_parent"` と `parent_heading` / `parent_line`（そのタグを自身に持つ、いちばん近い祖先の見出しと行）を返す。ノート全体にだけあるときは `on_note`（今までどおり）。タグ 1 つごとの理由は、対象に外せるタグがないとき、祖先にある（`on_parent`）、ノート全体にある（`on_note`）、フロントマターにある（`front_matter_tag`）の順に決める（どれでもなければ `none_found`）。複数のタグが外せなかったときは、今までどおり、場所を言える理由が `none_found` に勝ち、場所を言える理由が複数あれば、最初のタグのもの。対象の子孫にだけあるタグは `none_found`（ノート全体の操作で他の書き込みにあるときの `on_entry` は今までどおり）。
- 結果の項目:
  - `range_start` / `range_end`: **対象の範囲（部分木）**（旧: 書き込み 1 つぶん）。`scope = "note"` は今までどおり 1〜最後の行。
  - `descendants`（整数）: 対象の子孫の書き込みの数（0 なら、効くのは対象の書き込みだけ。`scope = "note"` は 0）。
  - `inherited_tags`（`[]string`）: 対象が祖先から受け取るタグ（ノート全体のものは含まない）。遠い祖先から順、重複なし。常に配列。
  - `path`（配列）: `scope = "entry"` のとき、対象から根まで（近い順、対象自身が先頭）の一覧。行は編集前の本文のもの（`range_start` などと同じ）。各要素 `{"line", "level", "heading", "range_start", "range_end", "descendants", "tags"}`（`line` は見出しの行、見出しのない書き込みは書き込みの最初の行。`level` は 0〜3。`tags` はその書き込み自身のタグ）。`scope = "note"`（前文・フロントマター・見出しも区切り線もないノートを含む）のときは `[]`。常に配列。
  - `entry_tags`: 今までどおり、対象 **自身の** タグ。
  - `parent_heading`（文字列）, `parent_line`（整数）: `on_parent` のときだけ値が入る（ほかは `""` と 0）。
- 検査: `line` が祖先の見出しの行でも、ふつうの行でも、対象の書き込みは「その行を含む書き込み」。

### 11.3 CLI / JSON-RPC

`scrap tag ... --line N` と `scrap.tag_edit` は、上の結果の項目がそのまま増える（`--json` と JSON-RPC）。`scrap tags` の `entries` は、有効なタグが届く書き込みの数（子孫を含む）。

### 11.4 画面

- 選択画面（「この書き込みにタグを付ける」「タグを外す」）に、**付ける場所**の行を足す: `show` の `path` の各要素を、近い順に並べた選択（見出しの名前と行の範囲つき。例: 「加工（10〜13 行）」「竹は三年で伐採できる（4〜14 行）」）。選んだ場所の見出しの下すべてに効く。**初期値**: 複数行の選択（`selectionStart` と `selectionEnd` が違い、最初の行と最後の行が別）のときは、**選択の最初の行を含む書き込みと、最後の行を含む書き込みの、いちばん近い共通の祖先（自身を含む）**: 最初の行の `path`（近い順）のうち、その見出しの行が最後の行の `path` にもある最初のもの。最後の行は、選択が行の先頭で終わる（`selectionEnd` が改行の直後）ときはその前の行。同じ書き込み、1 行の選択、キャレット、共通のものがない（別の木にまたがる）ときは、最初の行の書き込み自身（`path` の先頭）。最後の行の `show` は複数行の選択のときだけ、最初の行の `show` と同時に 1 回余分に呼び、2 つの答えがそろってから決める（失敗したら最初の行の書き込み自身。付ける場所をすでに利用者が選んでいたら上書きしない）。（旧: 最初の行の `path` の見出しの行は選択より前なので、見出しの行が選択に入る要素は先頭だけで、初期値が変わることがなかった。）選択画面の上の表示（今の「書き込み 9〜13 行目「…」」）は、選んだ場所のものにする（範囲は部分木、子孫があれば「と、その下すべて」）。
- 操作: クリックで選ぶ。キーボードは `Ctrl+↑` / `Ctrl+↓`（親へ / 子へ）。ヒント行に書く。`Tab` と `Enter` はこれまでどおり行を決める。
- 付ける: 選んだ場所の見出しの行を `line` にして `tagEdit` を呼ぶ。付けない候補（その場所に有効なタグ）は、場所を変えるたびに、`path` のデータから手元で計算し直す（`show` を呼び直さない）。
- 外す: 候補は、**選んだ場所 自身のタグ**、**祖先から届いているタグ**（出どころの見出しの名前つき。選ぶと、その祖先の見出しの行で外す）、**ノート全体のタグ**。`on_parent` と `on_note` は、これまでの文のほかに、出どころを言う（「見出し「…」（N 行目）から届いています」）。
- 付けたあとのステータス: 子孫があるときは、「（その下の N 個の書き込みにも効きます）」を足す。
- 右クリックメニューとパレットの 3 つのコマンドは変えない。

### 11.5 入れないもの

見出しの深さ 4 以上を書き込みとして数えること、同じ深さの兄弟へ効かせること、タグの行の移動（付けたあとに別の場所へ付け替える操作。外して付け直す）。

### 11.6 検証

- Go: 親の決め方（`# / ## / ###`、深さを飛ばす `# / ###`、`## B` のあとの `# A2`、`---` で始まる書き込みが根、見出しのない書き込みが鎖を切る、前文）、有効なタグ（検索の 4 つの経路、`CollectTags` の件数、深掘りの前後の書き込み）、`add` の `already`（祖先・ノート全体から届くもの）、`remove` の `on_parent`、範囲（部分木）と `descendants`、`path`、**性質の試験**（ランダムなノートで、親の決め方が独立な実装と一致する、`add` したタグが部分木のすべての書き込みの有効なタグに入りほかには入らない、2 回目は何も変えない）、正解データの作り直し。
- ページ: 純粋関数の試験、正解データとモックの一致、スモーク（見出しの下に子の見出しが続くノートで、上の見出しに付ける→子の小見出しにも効く（表示の文と、検索の絞り込みのモック）、初期値が選択で変わる、`Ctrl+↑/↓`、祖先から届いたタグを外す、`on_parent` の文）。
- 実アプリ（隔離）: 記事（子の見出しつき）に上の見出しで付け、絞り込みで子の小節の行もヒットすること。

### 11.7 選んだ語をタグの候補にする（2026-10-04 追記）

テキストの語を選んでから「この書き込みにタグを付ける」「この記事全体にタグを付ける」を使うと、その語を、入力欄に**はじめから入れて**（全選択の状態で）開く。ブラウザの検索が選択語を入れるのと同じ作法で、そのまま `Enter` で付き、打ち始めれば置き換わり、`Backspace` で空になる。入ったあとの扱いは、打ち込んだ語と同じ（新規 / すでに付いている / 候補の絞り込み）。`タグを外す` では入れない。

- 候補になる選択: 1 行の中で、`selectionStart` と `selectionEnd` が違い、選択の長さが 200 文字以下、改行を含まず、前後の空白と、先頭の `#`（何個でも）、前後の括弧・引用符・句読点（`「」『』()（）[]［］<>＜＞"'` と `、。，．,.;:；：!?！？`。末尾の `#` と `+` は取らない）を取り除いた残りが **1 つのタグ**（`splitTags` で 1 つ、64 文字以下、問題なし）になるもの。2 語以上（空白・読点などの区切りを含む）や、問題のある語は候補にしない（開き方は今までどおり、空の入力）。
- 付ける場所の初期値は 11.4 のとおり（1 行の選択では、見出しの行が選択の範囲に入るのはその行が見出しのときだけなので、ふつうはカーソルのある書き込み。複数行の選択は、語の候補にはならず、見出しの階層の初期値だけが効く）。
- 純粋関数 `selectedTag(text, selStart, selEnd)` を `tag_edit.js` から出す（候補なしは `""`）。入力欄は `st.selStart` / `st.selEnd` と同じ、開いたときの選択から決める。

### 11.8 分担

- **Go（`pkg/search`, `pkg/cli`, `app_*.go` の試験の更新、正解データ）**: 11.1〜11.3、11.6 の Go の項目。`TagMap` に親の配列を持たせ（タグのコメントがあるファイルだけ作る）、`entryHasAll` / `CollectTags` / `EditTags` を直す。検索の経路（`HasLine` / `HasEntry`）は `TagMap` の中で直るので、`ordered.go` / `ranked.go` / `semindex` / `deepsearch` の呼び出しは変えない（変える必要が出たら報告）。
- **画面（`frontend/js/tag_edit.js`、`i18n.js`、`index.html`、`app.js`、`tools/docshots/mock/tag_edit_mock.js`、`tests/smoke/104`/`106`、`tag_edit_test.js`、`tests/tag_edit_mock_test.mjs`）**: 11.4、11.7、モックの移植。モックは正解データ（Go が作る `pkg/search/testdata/tagedit_golden.json`）と一致させる。Go の側の正解データができるまでは、この契約から移植し、できたら照合する。
- ドキュメント（マニュアル EN/JA、features、skills、図）は両方の完了後に別にやる。

### 11.9 実装の結果と、契約からの判断（2026-10-04）

**入ったもの**: `pkg/search/outline.go`（親・深さ・部分木の終わり）、`TagMap`（親の配列は、自分のタグを持つ書き込みがあるファイルだけ作る）、`CollectTags`（部分木を 1 回ずつ数える）、`EditTags` の新しい結果の項目（22 個）、CLI（`scrap tag show` の「上の見出しから届くタグ」の行、`on_parent` の拒否）、画面（付ける場所の行、`Ctrl+↑/↓`、チップ、状態文、選んだ語の事前入力）、モックの移植。

**実測**（Go 側の担当が、同じセッションで旧版と新版を交互に計った）: タグのコメントのないノートは追加の費用なし（`ScanTags` 3.1 µs・0 割り当てのまま、`BenchmarkSearchScraps` 1.52 ms→1.51 ms・645 割り当て）。タグのあるノートは親の配列が 1 書き込みあたり 4 バイト増える。`CollectTags`（50 ファイル）は約 +3 %、15 MB のノートの `EditTags` は約 +4〜5 %。画面側は `tag_edit.js` が選択画面を開くまで読み込まれないまま（node での読み込み 2.7 ms、1 MB の選択の `selectedTag` は長さで先に抜けて 0.25 µs）。

**検証**: Go は `go test ./... -count=1` が全件通る（ルートを含む。`go vet` は既知の `unsafe.Pointer` の注意だけ）。性質の試験は 20 万件（ランダムなノートで、親の決め方を独立な素朴な実装と比べ、`add` が部分木のすべてに効いてほかには効かず、2 回目は何も変えないこと）、親の決め方の変異 12 種がすべて試験に捕まった。正解データは 51 → 88 件（既存の 51 件の値は変わらず、新しい 5 つのキーが加わっただけ）で、モックはその 88 件と一致する。JS は 115/115、選択画面の試験 43、スモークは日英とも 49/49。**実アプリ（隔離）**: 子見出しつきの記事で、小節の途中を右クリック→「付ける場所」の行→`Ctrl+↑`→上の見出しの下に付く（状態文「その下の 3 個の書き込みにも効きます」）、保存した記事を実際の CLI の絞り込み検索（完全一致・ranked）で検索すると子の小節の行がヒットし、別の `##` の行は出ない、`scrap tags` が 4 件、語を選んで右クリック→入力欄に入って全選択→Enter で見出しの直下、複数行の選択（二つの小節）の既定が共通の見出し（二つの `show` が同時に走る）、継承されたタグが出どころの見出しの行で外れる、を確かめた。

**契約からの判断**:
1. **複数行の選択の既定の場所**（11.4）: 最初に書いた「選択の行の範囲に見出しの行が入るもの」は、祖先の見出しは必ず選択の外（上）にあるため、決して見出しを選べなかった（画面側の担当が実装中に見つけた）。**選択の最初の行と最後の行のそれぞれの書き込みの、共通の祖先（最も低い）**に変えた。最後の行の `show` は、複数行の選択のときだけ 1 回余分に呼ぶ（キャレットと 1 行の選択は 1 回のまま）。2 つ目の答えを待つ間は、最初の書き込み自身が選ばれていて、人がすでに選んだ場所は上書きしない（その短い間に Enter を押すと、最初の書き込みに付く）。
2. **BOM**: `Entries` は 1 行目の BOM の後ろを見ない既知の制限のまま。タグの読み取りと同じく、深さの読み取りでは 1 行目の BOM を外して読むので、BOM つきの `# 題名` は深さ 1 で子を持つ。副作用として、そのファイルの 1 行目の見出しの `heading` / `heading_line` が `""` / 0 でなく見出しになる。
3. **`inherited_tags`**: 見出しが書いたタグだけ（ノート全体にしかないタグは含まない）。同じタグをノート全体も持っていても、見出しが書いていれば入る。
4. **ルール行で始まる書き込みの `line`**: `path` の `line` と `parent_line` は、ルール行でなく見出しの行。
5. **自分と祖先の両方にあるタグ**: 自分から外すと、メッセージなしで外れるが、祖先から届くのでまだ効いている（外れたことは状態文に出るが、「まだ効いている」とは言わない）。
6. **`on_parent` が画面から出ない**: 選択画面は、祖先から届いたタグをその祖先の行で外すので出ない。出るのは CLI と JSON-RPC（子の行を指定して外すとき）。画面側の試験は、バックエンドの呼び出しを置き換えて文を確かめている。
7. **Mac**: `Ctrl+↑` は Mission Control に取られるので、Mac ではクリックで選ぶ（`Alt` の代わりは足していない。実機未確認）。

**未確認**: Mac（画面も CLI も）、IME で選択画面の入力欄に書くとき、スクリーンリーダー、意味検索の実機での絞り込み（Go の呼び出しは共通で、単体の試験は通っている。実 Ollama では回していない）、数 MB を超えるノートでの `show` の 2 回呼び。
