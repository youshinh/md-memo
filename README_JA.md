# MD-Memo

**カーソルの位置にAIがいる、Markdownのスクラッチパッド。思いついた瞬間には、もう開いています。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac-lightgrey)](#インストール)
[![Release](https://img.shields.io/github/v/release/youshinh/md-memo)](https://github.com/youshinh/md-memo/releases/latest)
[![Official Manual](https://img.shields.io/badge/Docs-公式マニュアル-green.svg)](https://youshinh.github.io/md-memo/manual_ja.html)

<p align="center"><img src="img/demo/ask-ai.gif" width="760" alt="下書きを選んで Ctrl+L を押し、指示を入力すると、整えた文章が選択範囲のすぐ下に入り、しばらく光ります"></p>

MD-Memo は、Windows と macOS で動く小さなデスクトップメモ帳です。トレイから一瞬で戻ってきて、メモはあなたのディスク上のふつうの Markdown ファイルとして保存されます。AI は、いま文字を打っているその場所で働きます。チャット画面も、コピー＆貼り付けも要りません。文章を整える、選んだ文章にシェルコマンドをかける、丸ごとの作業を Claude Code や Codex に任せる。どれも、答えは書いた文章のすぐ下に入ります。

[**ダウンロード**](https://github.com/youshinh/md-memo/releases/latest) • [公式マニュアル](https://youshinh.github.io/md-memo/manual_ja.html) • [English README](README.md) • [全機能リファレンス](docs/features_ja.md)

## 選ばれる理由

- **待たされない。** AI に2つ頼んで、そのまま入力を続け、音声でも書く。全部いっぺんに動かせます。答えは、できた順にそれぞれの場所へ入り、入力が止まることはありません。
- **とにかく速い。** システムトレイ（macOS では Dock）に常駐し、`Ctrl+Alt+M` ひとつで、直前のカーソル位置のまま戻ってきます。Go のコアと OS 標準の WebView で作っていて、Electron は使いません。アイドル時のメモリは 5〜15 MB 程度です。
- **AI は打っている場所にいる。** `Ctrl+L` で選択範囲について質問すると、答えがその下に入ります。あなたの文章は書き換えられません。書いている途中には、ローカルモデル（Ollama、LM Studio、vLLM）の予測が薄い文字で出て、`Tab` で採用できます。クラウドのキーでも、完全オフラインでも使えます。
- **図も画像も、回り道なし。** ひとつのコマンドで箇条書きが Mermaid のフローチャートになり、プレビューにリアルタイムで描かれます。画像認識モデルを設定していれば、貼り付けたスクリーンショットも Markdown や図に読み取れます。
- **文章がそのままコマンドラインになる。** `Ctrl+E` で選択範囲を `sort`、`jq`、`prettier` など PATH 上のコマンドに通し、出力を下に入れます。危険なコマンドは実行前にチェックされます。
- **大きな仕事は任せる。** `{{ @claude 要点をまとめてリリースノートを下書きして }}` と書けば、エージェント CLI が裏で作業し、その間も入力を続けられます。`Ctrl+Enter` は、キャレットのある行を読んで「AIに聞く」「エージェントに任せる」「コマンドを実行する」のどれかを選びます。
- **ふつうのファイルで、ずっとあなたのもの。** メモは、選んだフォルダに置かれる普通の `.md` ファイルです。Obsidian の Vault や Git リポジトリを指定でき、リモートを設定すればバックグラウンドで commit と push もします。
- **スクリプトから触れる。** `cat build.log | md-memo` で、起動中のアプリへ直接流し込めます。コマンドライン、JSON-RPC ポート、用意済みのスキルで、スクリプトや AI エージェントがメモを読み書きできます。

## 動きを見る

### 待たされない: AI・入力・音声を同時に
<p align="center"><img src="img/demo/parallel.gif" width="720" alt="AI への依頼を2つ出したまま、入力を続け、音声で1文を口述する。答えは、それぞれの場所へ入る"></p>

### 誤字・脱字をワンキーで直す（`Alt+C`）
<p align="center"><img src="img/demo/proofread.gif" width="720" alt="誤字だらけの文章で Alt+C を押すと、直した文章に、その場で置き換わる"></p>

### 打ちながら予測、`Tab` で採用
<p align="center"><img src="img/demo/ghost-text.gif" width="720" alt="キャレットの後ろに薄い予測が出て、Tab で採用される"></p>

### 箇条書きを図にする
<p align="center"><img src="img/demo/mermaid-ai.gif" width="720" alt="手順の箇条書きを選んで「フローチャートに変換」を実行すると、Mermaid のフローチャートがノートに書かれ、横のプレビューに描かれる"></p>

### 画像を貼ると、Markdown や図になる（`Ctrl+V`）
<p align="center"><img src="img/demo/paste-image.gif" width="720" alt="ホワイトボードのスケッチのスクリーンショットを貼り付けると、Mermaid のフローチャートに読み取られ、横のプレビューに描かれる"></p>

### 文章にコマンドをかける（`Ctrl+E`）
<p align="center"><img src="img/demo/command-bar.gif" width="720" alt="行を選んで Ctrl+E を押し、シェルのワンライナーを入力すると、並べ替えて数えた結果が選択範囲の下に入る"></p>

### エージェントに任せる（`Ctrl+Enter`）
<p align="center"><img src="img/demo/delegate-agent.gif" width="720" alt="@claude で始まる行で Ctrl+Enter を押すと、行がエージェントのタスクになり、裏で実行されて、結果が下に届く"></p>

### ライブプレビュー。Mermaid の図もそのまま（`Ctrl+Alt+V`）
<p align="center"><img src="img/demo/live-preview.gif" width="720" alt="左で Markdown を書くと、Mermaid のフローチャートも含めて右にリアルタイムで描画される"></p>

### これまでのメモを全部さがす（`Ctrl+Shift+F`）
<p align="center"><img src="img/demo/scrap-search.gif" width="720" alt="単語を入力すると、すべての日付メモから該当箇所が一瞬で出て、Tab でメモに引用できる"></p>

### 次に何をするか迷ったら（`Ctrl+J`）
<p align="center"><img src="img/demo/quick-actions.gif" width="720" alt="Ctrl+J で、いま書いている内容に合う次の一手を最大3件提案する"></p>

*実際の画面を録画したものです（表示は英語です）。AI の答えは台本どおりに返しているので、毎回同じように再生されます。*

## ほかにも

- **スマート貼り付け**: `Ctrl+V` で、Web ページ・Word・Excel の内容がきれいな Markdown になります。画像認識モデルを設定していれば、コピーしたスクリーンショットは文字として読み取ります。
- **音声入力**（`Ctrl+Shift+R`）: 話した内容を文字にし、2つ目のモデルが整えます。文字を選んでいるときは、話した内容を選択範囲への編集指示として適用します。
- **Mobile Drop**（`Ctrl+Shift+U`）: QR コードを読むだけで、スマホの写真・音声メモ・テキストがノートに入ります。アプリもアカウントも不要です。
- **Discord連携**: 自分のボットにどこからでもメッセージを送ると、次に MD-Memo を起動したとき（閉じていても）今日のノートに入ります。
- **ホットフォルダ**（Windows / macOS）: 画像や録音をフォルダに置くだけで、OCR や文字起こしを通してノートになります。**クイックキャプチャと画面キャプチャ**（Windows）: グローバルホットキーでメモ用のポップアップが開きます。
- **IME Guardian**: コードブロック・インラインコード・URL の中では、日本語などの IME が入力を全角にしてしまうのを防ぎます（入力ソースの自動切り替えは Windows のみ）。
- **書くときの工夫**: Zenモード、`Ctrl+/` でコメントアウト、折り返した行でも正しい行番号、ファイルをドロップしてリンクにして `Ctrl+クリック` で開く。

どれも [docs/features_ja.md](docs/features_ja.md) と [公式マニュアル](https://youshinh.github.io/md-memo/manual_ja.html) に詳しく書いてあります。

## インストール

**Windows**（x64。Edge WebView2 Runtime が必要で、Windows 11 には入っています）。PowerShell から:

```powershell
Invoke-WebRequest https://github.com/youshinh/md-memo/releases/latest/download/md-memo-windows-x64.zip -OutFile md-memo.zip
Expand-Archive md-memo.zip -DestinationPath md-memo
md-memo\md-memo.exe
```

**macOS**（10.15 以降。Apple Silicon と Intel の両方）:

```bash
brew install --cask youshinh/tap/md-memo
```

macOS 版は ad-hoc 署名で Apple の公証は受けていないため、最初の起動だけ操作が1つ増えます。**システム設定 → プライバシーとセキュリティ** を開いて **このまま開く**（macOS 15 以降）を押すか、アプリを右クリックして **開く** を選んでください。詳しくは [docs/features_ja.md](docs/features_ja.md#クイックスタート) にあります。

どちらの zip も [リリースページ](https://github.com/youshinh/md-memo/releases) にあります。インストーラーはありません。Linux は未対応です。クイックキャプチャ・画面キャプチャ・「送る」メニュー・端末内 Whisper は、今のところ Windows だけです（[何がどちらで使えるか](docs/features_ja.md#windowsとmacosの違い)）。

## 覚えておきたいショートカット

| | Windows | macOS |
|---|---|---|
| MD-Memo を前面に出す | `Ctrl+Alt+M` | `Option+Cmd+M` |
| 選択範囲についてAIに質問 | `Ctrl+L` | `Cmd+L` |
| 誤字・脱字を直す | `Alt+C` | `Cmd+Shift+C` |
| コマンドバー（`Tab` でAIモードに切り替え） | `Ctrl+E` | `Cmd+E` |
| 自動セレクター: 行の内容から「聞く・任せる・実行する」を自動で選ぶ | `Ctrl+Enter` | `Cmd+Enter` |
| 次の一手を提案 | `Ctrl+J` | `Cmd+J` |
| すべてのノートを検索 | `Ctrl+Shift+F` | `Cmd+Shift+F` |
| コマンドパレット | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| 横にプレビュー | `Ctrl+Alt+V` | `Cmd+Option+V` |

ほとんどのキーは 設定 → ショートカット で変えられます。全部の一覧は [docs/features_ja.md](docs/features_ja.md#ショートカット一覧) です。

## スクリプトやAIエージェントから

```bash
cat build.log | md-memo                 # ターミナルの出力をそのままアプリへ流し込む
md-memo buffer get                      # 開いているノートを読む
echo "- [ ] 次にやること" | md-memo buffer append
md-memo agent install-skill             # Claude Code に MD-Memo の操作方法を覚えさせる
```

同じ操作は `127.0.0.1` の JSON-RPC でもできます。[CLI と JSON-RPC](docs/features_ja.md#プログラマブル制御ハブ--json-rpc-20) と [AIエージェントから MD-Memo を使う](docs/features_ja.md#aiエージェントから-md-memo-を使う) を見てください。

## ドキュメント

- [公式マニュアル](https://youshinh.github.io/md-memo/manual_ja.html)（[English](https://youshinh.github.io/md-memo/manual.html)）: スクリーンショット付きの使い方
- [機能リファレンス](docs/features_ja.md)（[English](docs/features.md)）: すべての機能・ショートカット・コマンドラインの詳細

## ライセンス

[MIT License](LICENSE) で配布しています。個人利用も商用利用も無料です。
