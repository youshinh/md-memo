// Unit tests for auto_selector.js: the line classifier (table driven, Japanese and English), the task
// finder, the rewriter and the result-block helpers. Plain Node, no DOM.
const assert = require('assert');

const AS = require('./auto_selector.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error(e && e.stack ? e.stack : e);
  }
}

// rows: [line, ...expected] or a bare string; expect(got, rest) returns true when the row is right.
function table(name, rows, expect, minRows) {
  test(name, () => {
    assert.ok(rows.length >= (minRows || 60), 'table has only ' + rows.length + ' rows');
    const bad = [];
    rows.forEach((row) => {
      const args = Array.isArray(row) ? row : [row];
      const got = AS.classify(args[0]);
      if (!expect(got, args.slice(1))) bad.push(JSON.stringify(args[0]) + '  ->  ' + JSON.stringify(got));
    });
    assert.strictEqual(bad.length, 0, bad.length + ' of ' + rows.length + ' rows are wrong:\n  ' + bad.join('\n  '));
  });
}

const isInstr = (target) => (got) => got.kind === 'instruction' && got.target === target;

// ---- instruction -> built-in LLM --------------------------------------------------------------------
const LLM_LINES = [
  '以下を英語に翻訳してください',
  'この文章を要約して',
  '次の文章を校正してください。',
  '敬語に直して',
  'もっと丁寧な表現に言い換えて',
  '箇条書きにして',
  '表にまとめて',
  '3行で要約して',
  'TCPとUDPの違いを教えて',
  '量子コンピュータについて説明してください',
  '「持続可能性」の意味は？',
  '新商品のキャッチコピーを5つ考えて',
  'メールの返信文を書いて',
  'この文章を読みやすくして',
  '英語に訳して',
  '日本語に翻訳',
  'アイデアを10個出して',
  'この段落を短くして',
  '誤字脱字をチェックして',
  '東京の人口はどのくらいですか？',
  'Kubernetesとは？',
  '江戸時代の身分制度について教えてください',
  'なぜ空は青いのですか',
  '会議の議事録のテンプレートを作って',
  'カジュアルな文体に書き換えて',
  '　この文章を要約してください　',
  '- この文章をやさしい日本語に直して',
  '> 英語に翻訳してください',
  '1. 要点を3つに絞って',
  '・箇条書きに整理して',
  '要約をお願いします',
  '英訳お願いします',
  'これを英語にしてもらえますか？',
  'もう少し詳しく説明してくれる？',
  '簡単な例を挙げて',
  'この文章の誤りを指摘して',
  '要約して。',
  '翻訳してください！',
  '教えてください…',
  '校正をお願いできますか',
  'もっと簡潔にして',
  '英文メールの下書きを作って',
  'この文の主語と述語を教えて',
  '100字以内にまとめて',
  '専門用語を初心者向けに説明してください',
  '「ありがとう」を英語で何と言いますか',
  '山手線の駅を全部挙げて',
  'この考えの長所と短所を整理して',
  '会議の要点を3つにまとめてください',
  '下の文章を日本語に訳してください',
  '明日のプレゼンの構成案を考えてください',
  '犬と猫の違いは何ですか？',
  '表形式で比較して',
  'この関数の仕組みを説明して',
  '短い自己紹介文を書いてください',
  '英語のビジネスメールに直して',
  '以下の文章から固有名詞を抽出して',
  'この記事の要点を教えてください',
  '文章をもっと自然な日本語に整えて',
  '要約を3行でお願いします',
  'なんで空は青いの？',
  'Pythonとは何ですか？',
  'この単語の意味を教えて',
  'Translate this into Japanese',
  'Summarize the following text in 3 bullet points',
  'Proofread this paragraph',
  'Rewrite this in a more formal tone',
  'Explain how DNS works',
  'What is the difference between TCP and UDP?',
  'Please translate to English',
  'Can you summarize this?',
  'Give me 5 title ideas for this article',
  'How does garbage collection work?',
  'Why is the sky blue?',
  'Simplify this explanation for a beginner',
  'Write a short email declining the invitation',
  'Paraphrase the sentence below',
  'Could you shorten this to one sentence?',
  'Brainstorm names for a coffee shop',
  "Explain recursion like I'm five",
  'tl;dr this article',
  'Translate to French, please',
  'Please proofread',
  'Correct the grammar in this sentence',
  'Summarise in two sentences',
  'Rephrase this so it sounds friendlier',
  'Explain the difference between let and const',
  'How do I center a div in CSS?',
  'What does "idempotent" mean?',
  'Describe the plot of Hamlet in two sentences',
  'Convert this list to a table',
  'Translate "good morning" into Japanese',
  'Suggest a better title for this post',
  'Help me write a cover letter',
  'Give me a one-line summary',
  'Turn these notes into a checklist',
  'Improve the wording of this sentence',
  'Fix the grammar in this paragraph',
  '- Summarize this note',
  '> Translate to Japanese',
  '英語のテストを作って',
  'テスト問題を作って',
  'テストの結果を要約して',
  'ビルドの手順を説明して',
  '実行計画を箇条書きにして'
];
table('classify: clear requests to the built-in LLM are instruction/llm', LLM_LINES, isInstr('llm'));

// ---- instruction -> agent ---------------------------------------------------------------------------
const AGENT_LINES = [
  'このリポジトリのテストを実行して',
  'READMEを更新して',
  '変更をコミットして',
  'バグを修正してください',
  'エラーログを調査して',
  'src/main.go をリファクタリングして',
  'ビルドが失敗する原因を調べて修正して',
  'この関数のユニットテストを書いて',
  '依存パッケージを最新版に更新して',
  'PRを作成して',
  '本番環境にデプロイして',
  'package.json の scripts を整理して',
  'ログインバグを再現して修正して',
  'Lintエラーを全部直して',
  'この機能を実装して',
  'Webで最新の情報を調査して',
  'ブランチを切ってプルリクを作成して',
  'テストが落ちる原因を調査して',
  '型エラーをすべて修正して',
  'CIが落ちている原因を調べて',
  'このバグを再現するテストを書いて',
  '依存関係を調査して更新して',
  'Gitの履歴から原因のコミットを探して',
  'マージコンフリクトを解消して',
  'スクリプトを書いてファイルを整理して',
  'ログファイルからエラーを抽出して',
  '新しいブランチでこの機能を実装してプッシュして',
  '環境構築の手順を調査して',
  'Web検索して最新のニュースを調べて',
  'ネット検索でレビューを調べて',
  '既存のテストを全部実行して、失敗を修正して',
  'TypeScriptの型エラーを修正して',
  'Fix the failing tests',
  'Refactor this module to use async/await',
  'Run the test suite and fix failures',
  'Implement pagination for the users API',
  'Commit the changes with a good message',
  'Open a pull request for this branch',
  'Deploy to staging',
  "Investigate why the build is failing",
  'Add unit tests for parser.go',
  'Update the README with install instructions',
  'Debug the login bug',
  'Create a new branch and push it',
  'Find and fix the memory leak in the repo',
  'Please refactor the config loader',
  'Rebase the feature branch onto main',
  'Merge the PR after CI passes',
  'Install the dependencies and run the build',
  'Investigate the stack trace in the error log',
  'Lint the codebase and fix warnings',
  'Write unit tests for the parser',
  'Search the repo for TODO comments',
  'Push the branch to origin',
  'Check the git log for the last release',
  'Research the best Go logging libraries',
  'Create a pull request for these changes',
  ['@claude このコードをレビューして', 'claude-code'],
  ['@claude-code READMEを整えて', 'claude-code'],
  ['@cc テストを追加して', 'claude-code'],
  ['@CLAUDE review this code', 'claude-code'],
  ['@gemini 最新のAPI仕様を調べて', 'agy'],
  ['@antigravity fix the flaky test', 'agy'],
  ['@agy implement the feature', 'agy'],
  ['@codex この関数を最適化して', 'codex'],
  ['@hermes 議事録を要約して', 'hermes'],
  ['- @claude 依存を更新して', 'claude-code'],
  'テストを実行して',
  'テスト実行して',
  'npm test を実行して',
  'go test ./... を実行して',
  'pytestを実行して',
  'ビルドして',
  'スクリプトを実行して',
  'Please run the tests',
  'Run npm test please'
];
table('classify: agent-sized work and explicit @agent are instruction/agent', AGENT_LINES, (got, rest) => (
  got.kind === 'instruction' && got.target === 'agent' && (rest.length === 0 ? got.agent === undefined : got.agent === rest[0])
));

// ---- instruction -> command -------------------------------------------------------------------------
const COMMAND_LINES = [
  'git status',
  'git diff --stat',
  'git log --oneline -20',
  'ls -la',
  'dir /s /b *.md',
  'cat README.md',
  'grep -rn "TODO" .',
  'rg TODO src',
  'find . -name "*.md"',
  'curl -I https://example.com',
  'npm test',
  'npm run build',
  'go test ./...',
  'python script.py',
  'node -v',
  'docker ps',
  'Get-ChildItem -Recurse',
  'type notes.txt',
  'git log --oneline | head -5',
  'cat a.txt | sort | uniq',
  '$ ls -la',
  '$ git status',
  '$ npm run build',
  '- git status',
  '> git diff',
  'git branch -a',
  'pip list',
  'cargo build --release',
  'kubectl get pods',
  'ls | wc -l',
  'tree -L 2',
  'df -h',
  'ps aux | grep node',
  'whoami /all',
  'ipconfig /all',
  'tasklist | findstr chrome',
  'Select-String -Path *.md -Pattern TODO',
  'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5',
  'Get-Content notes.txt -Tail 20',
  'echo hello',
  'date +%F',
  'git show HEAD~1',
  'git stash list',
  'head -n 20 README.md',
  'tail -n 50 app.log',
  'wc -l *.md',
  'jq . package.json',
  'uname -a',
  'docker logs myapp --tail 50',
  'go version',
  'go vet ./...',
  'make test',
  'yarn install',
  'pnpm run lint',
  'diff a.txt b.txt',
  'git remote -v',
  'rg -n "TODO" --glob "*.md"',
  'grep -c error server.log',
  'find . -type f -name "*.go"',
  'ls -lh ~/Documents',
  'dir C:\\Users',
  'cat ./notes/todo.md',
  'stat README.md',
  'git rev-parse HEAD',
  'Test-Path .\\config.json',
  '$ dir',
  '$ Get-Date',
  'git fetch --all --prune',
  '　git status　',
  '  $ git log -5'
];
table('classify: shell command lines are instruction/command', COMMAND_LINES, isInstr('command'));

// ---- content: ordinary text must never run --------------------------------------------------------------
const CONTENT_LINES = [
  '今日は会議が長引いてしまった。',
  '明日は10時に集合',
  '山田さん 090-1234-5678',
  'りんご、みかん、ぶどう',
  '- [ ] 牛乳を買う',
  '## 議事録',
  '# 2026年5月の目標',
  'https://example.com/docs/getting-started',
  '> 人は誰でも間違える',
  '打ち合わせの内容をまとめると、来月から新しい体制になる。',
  'Kubernetesを勉強したい',
  '田中さんにメールする',
  '資料を作成済み',
  'ありがとうございました。',
  'よろしくお願いします。',
  'お世話になっております。',
  'ご確認をお願いいたします。',
  'ご連絡ありがとうございます。',
  '売上は前年比120%だった。',
  '参考: https://example.com/article',
  '`const x = 5;`',
  '```js',
  '| 名前 | 年齢 |',
  'TODO: 資料作成',
  '締切: 2026-05-03',
  '会議室Aを予約した',
  '卵 2個、牛乳 1本、パン',
  '夕食はカレーにした',
  '最近のAIの進化はすごい',
  'メモ: 要約機能の実装を検討中',
  '翻訳ツールの比較表',
  '議事録の要約は後で共有する',
  '英語の勉強を始めた',
  '今週のまとめ',
  '今日は英語の翻訳の宿題があった',
  '要約: 売上は好調だった',
  '校正済み',
  '翻訳ありがとう',
  '確認しました',
  '$100 の予算',
  '$HOME/bin を PATH に追加する',
  '@alice ミーティングの件、確認しました',
  '>> 要約して',
  '2026/05/03 定例会議',
  '12:30 ランチ',
  'foo@example.com',
  'C:\\Users\\me\\Documents\\report.docx',
  'git@github.com:foo/bar.git',
  '{"name": "md-memo", "version": "1.0"}',
  'SELECT * FROM users WHERE id = 1;',
  'def foo(x):',
  'import os',
  'console.log("hello")',
  'const x = 5;',
  'print("hello")',
  'import numpy as np',
  '<div class="foo">bar</div>',
  '{{ 要約して }}',
  '[? Goの最新バージョンは ]',
  '【? 議事録を整理 】',
  '[! この設計のリスク !]',
  '[>> 調査してコードを書く ]',
  'Meeting notes from Monday',
  'Buy milk and eggs',
  'Call mom',
  'Remember to water the plants',
  'The quick brown fox jumps over the lazy dog.',
  'TODO: update the docs',
  'Q3 revenue was up 12%',
  'Version 2.3.1 released',
  'See also: RFC 2616',
  'I think we should reconsider the schedule.',
  'She said it would be ready by Friday.',
  'Note: password reset emails are delayed',
  'Shopping list',
  'Alice - project lead',
  'Deadline: May 3',
  '"The best way out is always through."',
  '1. Milk 2. Eggs',
  'Lunch with Sam at noon',
  'Flight lands at 18:45',
  'The API returns a list of users',
  'Reading: Designing Data-Intensive Applications',
  'Ideas for the blog',
  'Summary of last week',
  'Translation memory tools',
  '---',
  '',
  '   ',
  'https://github.com/youshinh/md-memo',
  'a\nb\nc\nd',
  'これは長い段落です。'.repeat(30),
  'A sentence about nothing in particular. '.repeat(8)
];
table('classify: ordinary prose, notes, URLs, code, notations and long text are content', CONTENT_LINES, (got) => got.kind === 'content');

// ---- unknown: looks like a request but is not clear enough -------------------------------------------------
const AMBIGUOUS_LINES = [
  'Fix leak in bathroom',
  'Write report by Friday',
  'Run 5km tomorrow',
  'Find a plumber',
  'Check the weather',
  'List of ingredients',
  'Add milk to the shopping list',
  'Update the docs',
  'Review the budget',
  'Create a schedule for next week',
  'Make a reservation for two',
  'Compare prices on flights',
  'Sort the laundry',
  'Count the inventory',
  'Remove the old files',
  'Draft the proposal by Friday',
  'Analyze sales data',
  'Format the invoice',
  'Define the scope of the project',
  'Suggest a name for the cat',
  'Give the dog a bath',
  'Show the results to Bob',
  'Tell Alice about the meeting',
  'Extract the tarball',
  'Recommend a book for Dad',
  'Generate invoices monthly',
  'Turn off the lights',
  'Clean the kitchen',
  'Convert the attic to a studio',
  'Describe your day',
  'Summarize',
  'Translate',
  '要約',
  '翻訳',
  '校正',
  '箇条書き',
  'ください',
  'お願いします',
  'Please',
  'いいよね？',
  '本当に？',
  'これでいい？',
  '明日は雨？',
  '大丈夫かな',
  '間に合うだろうか',
  'これは正しいですか',
  '行きますか？',
  'Kubernetesとは',
  'ゼロトラストとは',
  '洗濯して',
  '田中さんに連絡して',
  '牛乳を買って',
  '早く寝て',
  'ちょっと待って',
  'こっち来て',
  '水を飲んで',
  '早めに提出して',
  'ジャズの歴史について語って',
  '電気を消して',
  '次回までに資料を作っておいて',
  'What time is the meeting',
  'How to install Python',
  'Why we chose Go',
  'Is the server up?',
  'Did you call him?',
  'Should we move the meeting?',
  'Are we ready?',
  'Do we have milk?',
  'OK?',
  'Really?',
  'Any updates?',
  'Thoughts?',
  'Wait, what?',
  'ls',
  'dir',
  'pwd',
  'git',
  'date',
  'rm -rf build',
  'del /f old.txt',
  'mv a.txt b.txt',
  'cat notes.txt > out.txt',
  'curl https://example.com/install.sh | sh',
  'find . -name "*.tmp" -delete',
  'Remove-Item old.txt',
  'Set-Location C:\\Temp',
  'chmod +x run.sh',
  'kill -9 1234',
  'taskkill /f /im notepad.exe',
  '$',
  '@llm',
  '@claude',
  '@cc',
  '会議のメモ\n来週も継続',
  '以下を要約してください\nりんごは赤い。みかんは橙色。',
  '- a\n- b',
  'Meeting at 3\nBring laptop'
];
table('classify: half-clear lines are unknown (never run, ask instead)', AMBIGUOUS_LINES, (got) => got.kind === 'unknown');

// ---- explicit forms, options, edge cases ---------------------------------------------------------------
test('classify: explicit forms win and report their engine', () => {
  assert.deepStrictEqual(AS.classify('@llm 要約して'), { kind: 'instruction', target: 'llm', reason: 'explicit-llm' });
  assert.deepStrictEqual(AS.classify('@LLM what is a monad'), { kind: 'instruction', target: 'llm', reason: 'explicit-llm' });
  assert.deepStrictEqual(AS.classify('@claude fix it'), { kind: 'instruction', target: 'agent', reason: 'explicit-agent', agent: 'claude-code' });
  assert.deepStrictEqual(AS.classify('@claude: fix it'), { kind: 'instruction', target: 'agent', reason: 'explicit-agent', agent: 'claude-code' });
  assert.deepStrictEqual(AS.classify('$ ls -la'), { kind: 'instruction', target: 'command', reason: 'explicit-command' });
  assert.deepStrictEqual(AS.classify('- @llm 要約して'), { kind: 'instruction', target: 'llm', reason: 'explicit-llm' });
  assert.strictEqual(AS.classify('@llm').kind, 'unknown');
  assert.strictEqual(AS.classify('$ ').kind, 'unknown');
  assert.strictEqual(AS.classify('@llmx do it').reason, 'mention-not-agent');
});

test('classify: an @mention that is not an agent (a skill, a person) is plain content', () => {
  assert.deepStrictEqual(AS.classify('@code-review src/ を見て'), { kind: 'content', target: 'llm', reason: 'mention-not-agent' });
  assert.strictEqual(AS.classify('@alice please review the draft').kind, 'content');
});

test('classify: opts.agents replaces the built-in agent list (keys, aliases, arrays, functions)', () => {
  const agents = { mybot: { aliases: ['bot', 'Helper'] } };
  assert.strictEqual(AS.classify('@bot do it', { agents }).agent, 'mybot');
  assert.strictEqual(AS.classify('@helper do it', { agents }).agent, 'mybot');
  assert.strictEqual(AS.classify('@claude do it', { agents }).reason, 'mention-not-agent');
  assert.strictEqual(AS.classify('@x1 do it', { agents: ['x1'] }).agent, 'x1');
  assert.strictEqual(AS.classify('@zed do it', { agents: (n) => (n === 'zed' ? 'zed-agent' : null) }).agent, 'zed-agent');
  assert.strictEqual(AS.classify('@llm do it', { agents: ['llm'] }).reason, 'explicit-llm');
});

test('classify: existing notations and wiki links', () => {
  ['{{ 要約して }}', '{{ @claude fix }}', '[? 今日の天気 ]', '【? 今日の天気 】', '[! リスク !]', '[>> 調査して ]', '[[ @llm 要約して ]]', '[[ $ ls ]]', '- [[ @llm 要約して ]]']
    .forEach((s) => assert.deepStrictEqual([AS.classify(s).kind, AS.classify(s).reason], ['content', 'existing-notation'], s));
  assert.strictEqual(AS.classify('[[Project A]] の内容を要約して').kind, 'instruction');
  assert.strictEqual(AS.classify('[[Project A]]').kind, 'content');
  assert.strictEqual(AS.classify('[[Note|alias]] を参照').kind, 'content');
});

test('stripMarkers: the marker lines of a run are removed for display, everything else stays', () => {
  const block = AS.makeResultBlock('a1b2', 'answer line 1\nanswer line 2', 'ctx=above n=1');
  const note = `question\n[[ @llm summarize ]]\n${block}\nnext`;
  assert.strictEqual(AS.stripMarkers(note), 'question\n[[ @llm summarize ]]\nanswer line 1\nanswer line 2\nnext');
  assert.strictEqual(AS.stripMarkers('a\n<!-- md-memo:run zz9x -->\nb'), 'a\nb', 'the run marker of a task still running');
  assert.strictEqual(AS.stripMarkers('x\r\n<!-- md-memo:res ab12 -->\r\ny\r\n<!-- /md-memo:res -->\r\nz'), 'x\r\ny\r\nz', 'CRLF notes');
  assert.strictEqual(AS.stripMarkers('  <!-- md-memo:res ab12 -->  \ny'), 'y', 'indented markers');
  const other = 'a\n<!-- a normal comment -->\n<!-- md-memo:other -->\nb <!-- md-memo:res x --> c';
  assert.strictEqual(AS.stripMarkers(other), other, 'other comments, unknown md-memo comments and markers in the middle of a line are left alone');
  assert.strictEqual(AS.stripMarkers('no markers here'), 'no markers here');
  assert.strictEqual(AS.stripMarkers(''), '');
  assert.strictEqual(AS.stripMarkers(null), '');
});

test('classify: an approval gate line of a recipe is an existing notation, whatever its wording says', () => {
  ['- [x] 次のステップ（レビューを実行）を実行する // approve', '- [ ] 次のステップ（要約して）を実行する // approve', '  -  [X]  翻訳して //approve  ', '- [x] Run the tests and fix failures // approve']
    .forEach((s) => assert.deepStrictEqual([AS.classify(s).kind, AS.classify(s).reason], ['content', 'existing-notation'], s));
  // the same words without the gate marker are still an ordinary line
  assert.strictEqual(AS.classify('- [x] 次のステップを実行して').reason !== 'existing-notation', true);
});

test('classify: the reserved ">> " prefix stays plain text', () => {
  assert.strictEqual(AS.classify('>> 要約して').reason, 'reserved-chain-prefix');
  assert.strictEqual(AS.classify('  >> git status').reason, 'reserved-chain-prefix');
  assert.strictEqual(AS.classify('>>要約して').kind, 'content');
  assert.strictEqual(AS.classify('> > 要約して').kind, 'instruction');
});

test('classify: line count and length limits, code fences', () => {
  assert.strictEqual(AS.classify('a\nb\nc\nd').reason, 'too-many-lines');
  assert.strictEqual(AS.classify('a\nb\nc').reason, 'multi-line');
  assert.strictEqual(AS.classify('```\nfix this\n```').reason, 'code-fence');
  assert.strictEqual(AS.classify('要約して\n').kind, 'instruction');
  assert.strictEqual(AS.classify('要約して\r\n').kind, 'instruction');
  assert.strictEqual(AS.classify('あ'.repeat(241)).reason, 'too-long');
  assert.strictEqual(AS.classify('この文章を要約して' + 'あ'.repeat(240)).kind, 'content');
  assert.strictEqual(AS.classify(null).kind, 'content');
  assert.strictEqual(AS.classify(undefined).kind, 'content');
});

test('classify: target follows the words, defaulting to the built-in LLM', () => {
  assert.strictEqual(AS.classify('このコードを説明して').target, 'llm');
  assert.strictEqual(AS.classify('バグを修正して').target, 'agent');
  assert.strictEqual(AS.classify('Fix the grammar in this paragraph').target, 'llm');
  assert.strictEqual(AS.classify('コミットメッセージを考えて').target, 'llm');
  assert.strictEqual(AS.classify('変更をコミットして').target, 'agent');
  assert.strictEqual(AS.classify('git status を実行して').target, 'agent');
  assert.strictEqual(AS.classify('東京の人口は？').target, 'llm');
});

test('classify: every result has a valid shape and is deterministic', () => {
  [].concat(LLM_LINES, CONTENT_LINES, AMBIGUOUS_LINES).forEach((s) => {
    const a = AS.classify(s);
    assert.ok(['instruction', 'content', 'unknown'].includes(a.kind), s);
    assert.ok(['llm', 'agent', 'command'].includes(a.target), s);
    assert.ok(typeof a.reason === 'string' && a.reason, s);
    assert.deepStrictEqual(AS.classify(s), a);
  });
});

test('classify: opts.rules overrides the tables (partial objects merge, lists replace)', () => {
  assert.strictEqual(AS.classify('踊って', { rules: { jaAiVerbs: ['踊って'] } }).kind, 'instruction');
  assert.strictEqual(AS.classify('要約して', { rules: { jaAiVerbs: ['踊って'] } }).kind, 'unknown');
  assert.strictEqual(AS.classify('要約して').kind, 'instruction');
  assert.strictEqual(AS.classify('ジラフを直して', { rules: { agentWords: { strong: ['ジラフ'] } } }).target, 'agent');
  assert.strictEqual(AS.classify('ジラフを直して').target, 'llm');
  assert.strictEqual(AS.classify('a\nb', { rules: { maxLines: 1 } }).reason, 'too-many-lines');
  assert.strictEqual(AS.classify('この文章を要約して', { rules: { maxChars: 5 } }).reason, 'too-long');
  assert.notStrictEqual(AS.classify('要約してください', { rules: { jaPolite: [], jaAiVerbs: [], jaNouns: [] } }).kind, 'instruction');
  const rules = { commandBinaries: ['mytool'], commandSubs: { mytool: ['go'] } };
  assert.strictEqual(AS.classify('mytool go', { rules }).target, 'command');
  assert.strictEqual(AS.classify('git status', { rules }).target, 'llm');
  assert.ok(Object.isFrozen(AS.RULES));
});

// ---- line prefixes -------------------------------------------------------------------------------------
test('splitLinePrefix: indent, quote and list markers; prefix + body is always the line', () => {
  const rows = [
    ['- item', '- '], ['* item', '* '], ['+ item', '+ '], ['1. item', '1. '], ['12) item', '12) '], ['3． 全角', '3． '], ['3．全角', ''],
    ['- [ ] todo', '- [ ] '], ['- [x] done', '- [x] '], ['- [X] done', '- [X] '], ['> quote', '> '], ['>quote', '>'], ['> > nested', '> > '],
    ['  - indented', '  - '], ['\t- tabbed', '\t- '], ['　- fullwidth indent', '　- '], ['・箇条', '・'], ['• bullet', '• '], ['> - quoted list', '> - '],
    ['>> chain', ''], ['  >> chain', '  '], ['plain text', ''], ['-nospace', ''], ['**bold** x', ''], ['1.5 kg', ''], ['2026. 要約して', ''],
    ['', ''], ['- ', '- '], ['> ', '> '], ['#heading', ''], ['---', '']
  ];
  rows.forEach(([line, prefix]) => {
    const sp = AS.splitLinePrefix(line);
    assert.strictEqual(sp.prefix, prefix, JSON.stringify(line));
    assert.strictEqual(sp.prefix + sp.body, line);
  });
  assert.deepStrictEqual(AS.splitLinePrefix(null), { prefix: '', body: '' });
});

// ---- decorate -------------------------------------------------------------------------------------------
test('decorate: wraps a line in the task notation and keeps its prefix', () => {
  assert.strictEqual(AS.decorate('llm', 'この文章を要約して'), '[[ @llm この文章を要約して ]]');
  assert.strictEqual(AS.decorate('llm', '- 要約して'), '- [[ @llm 要約して ]]');
  assert.strictEqual(AS.decorate('llm', '> 翻訳して'), '> [[ @llm 翻訳して ]]');
  assert.strictEqual(AS.decorate('llm', '  1. 校正して'), '  1. [[ @llm 校正して ]]');
  assert.strictEqual(AS.decorate('llm', '- [ ] 要約して'), '- [ ] [[ @llm 要約して ]]');
  assert.strictEqual(AS.decorate('llm', '　要約して　'), '　[[ @llm 要約して ]]');
  assert.strictEqual(AS.decorate('llm', 'Summarize this. '), '[[ @llm Summarize this. ]]');
  assert.strictEqual(AS.decorate('command', 'git status'), '[[ $ git status ]]');
  assert.strictEqual(AS.decorate('command', '- git status\r\n'), '- [[ $ git status ]]');
  assert.strictEqual(AS.decorate('agent', 'テストを実行して', { agent: 'claude-code' }), '{{ @claude-code テストを実行して }}');
  assert.strictEqual(AS.decorate('agent', 'テストを実行して'), '{{ @claude-code テストを実行して }}');
  assert.strictEqual(AS.decorate('agent', '> テストを実行して', { agent: 'agy' }), '> {{ @agy テストを実行して }}');
});

test('decorate: a leading marker of the same kind is not doubled', () => {
  assert.strictEqual(AS.decorate('llm', '@llm 要約して'), '[[ @llm 要約して ]]');
  assert.strictEqual(AS.decorate('llm', '- @LLM 要約して'), '- [[ @llm 要約して ]]');
  assert.strictEqual(AS.decorate('command', '$ git status'), '[[ $ git status ]]');
  assert.strictEqual(AS.decorate('command', '$HOME/bin/run'), '[[ $ $HOME/bin/run ]]');
  assert.strictEqual(AS.decorate('agent', '@cc テストを追加して', { agent: 'claude-code' }), '{{ @claude-code テストを追加して }}');
  assert.strictEqual(AS.decorate('agent', '@bot do it', { agent: 'mybot', agents: { mybot: { aliases: ['bot'] } } }), '{{ @mybot do it }}');
  assert.strictEqual(AS.decorate('agent', '@nobody do it', { agent: 'claude-code' }), '{{ @claude-code @nobody do it }}');
});

test('decorate: null when the text cannot be one single-line notation', () => {
  assert.strictEqual(AS.decorate('llm', ''), null);
  assert.strictEqual(AS.decorate('llm', '   \n'), null);
  assert.strictEqual(AS.decorate('llm', '- '), null);
  assert.strictEqual(AS.decorate('llm', '@llm'), null);
  assert.strictEqual(AS.decorate('llm', 'line1\nline2'), null);
  assert.strictEqual(AS.decorate('llm', 'what does ]] mean'), null);
  assert.strictEqual(AS.decorate('command', 'echo ]]'), null);
  assert.strictEqual(AS.decorate('agent', 'a }} b'), null);
  assert.strictEqual(AS.decorate('bogus', 'x'), null);
  assert.strictEqual(AS.decorate('llm', null), null);
});

test('decorate: balanced wiki links and shell conditionals inside survive a round trip', () => {
  const line = AS.decorate('llm', '[[Project A]] の内容を要約して');
  assert.strictEqual(line, '[[ @llm [[Project A]] の内容を要約して ]]');
  const task = AS.findTaskAt(line, 3);
  assert.strictEqual(task.instruction, '[[Project A]] の内容を要約して');
  assert.strictEqual(task.end, line.length);
  const cmd = AS.decorate('command', '[[ -f x ]] && echo ok');
  assert.strictEqual(cmd, '[[ $ [[ -f x ]] && echo ok ]]');
  assert.strictEqual(AS.findTaskAt(cmd, 0).instruction, '[[ -f x ]] && echo ok');
});

test('decorate: sanitize joins lines and spaces out stray delimiters so the task is always valid', () => {
  assert.strictEqual(AS.decorate('llm', 'line1\nline2', { sanitize: true }), '[[ @llm line1 line2 ]]');
  assert.strictEqual(AS.decorate('llm', '- line1\n  line2\n', { sanitize: true }), '- [[ @llm line1 line2 ]]');
  const s = AS.decorate('llm', 'a ]] b', { sanitize: true });
  assert.strictEqual(s, '[[ @llm a ] ] b ]]');
  assert.strictEqual(AS.findTaskAt(s, 0).instruction, 'a ] ] b');
  assert.strictEqual(AS.decorate('agent', 'x }} y {{ z', { sanitize: true, agent: 'claude-code' }), '{{ @claude-code x } } y { { z }}');
  assert.strictEqual(AS.decorate('llm', '   ', { sanitize: true }), null);
});

test('decorate: every clear LLM line round-trips through findTaskAt', () => {
  LLM_LINES.filter((s) => s.indexOf('\n') < 0 && s.trim()).forEach((s) => {
    const out = AS.decorate('llm', s);
    assert.ok(out, s);
    const task = AS.findTaskAt(out, out.length);
    assert.ok(task, out);
    assert.strictEqual(task.kind, 'llm');
    assert.strictEqual(task.instruction, AS.splitLinePrefix(s).body.trim().replace(/^@llm\s+/i, ''));
    assert.strictEqual(out.slice(0, task.prefixLen), AS.splitLinePrefix(s).prefix);
    assert.strictEqual(AS.classify(out).kind, 'content', 'a decorated line must not be classified again');
  });
});

// ---- findTaskAt --------------------------------------------------------------------------------------------
const LLM_TASK = '[[ @llm 要約して ]]';

test('findTaskAt: an LLM task line reports exact UTF-16 offsets', () => {
  const text = '前の行\n' + LLM_TASK + '\n次の行';
  const start = text.indexOf('[[');
  const end = start + LLM_TASK.length;
  const task = AS.findTaskAt(text, start + 5);
  assert.deepStrictEqual(task, {
    kind: 'llm', start, end, lineStart: start, lineEnd: end, prefixLen: 0, open: '[[', close: ']]',
    instruction: '要約して', agent: null, mention: null, outputMode: 'below', raw: LLM_TASK
  });
  assert.strictEqual(text.slice(task.start, task.end), LLM_TASK);
});

test('findTaskAt: the caret counts from just before the first bracket to just after the last', () => {
  const text = 'abc [[ @llm x ]] def';
  const start = text.indexOf('[[');
  const end = start + '[[ @llm x ]]'.length;
  assert.strictEqual(AS.findTaskAt(text, start - 1), null);
  assert.ok(AS.findTaskAt(text, start));
  assert.ok(AS.findTaskAt(text, start + 6));
  assert.ok(AS.findTaskAt(text, end));
  assert.strictEqual(AS.findTaskAt(text, end + 1), null);
  assert.strictEqual(AS.findTaskAt(text, 0), null, 'inline task: the caret must be on the task itself');
});

test('findTaskAt: when the task is all that is on its line the caret may be anywhere on the line', () => {
  const text = 'x\n- ' + LLM_TASK + '   \ny';
  const task = AS.findTaskAt(text, 2);
  assert.ok(task);
  assert.strictEqual(task.prefixLen, 2);
  assert.strictEqual(text.slice(task.lineStart, task.lineStart + task.prefixLen), '- ');
  assert.strictEqual(task.start, 4);
  assert.strictEqual(text.slice(task.start, task.end), LLM_TASK);
  assert.strictEqual(task.lineEnd, task.end + 3);
  assert.ok(AS.findTaskAt(text, task.lineEnd));
  assert.strictEqual(AS.findTaskAt(text, 0), null);
  assert.strictEqual(AS.findTaskAt(text, task.lineEnd + 1), null);
});

test('findTaskAt: list, quote, numbered and indented prefixes are reported as prefixLen', () => {
  [['- ', 2], ['> ', 2], ['  1. ', 5], ['- [ ] ', 6], ['> - ', 4], ['\t', 0 + 1], ['　', 1], ['', 0]].forEach(([prefix, len]) => {
    const text = prefix + '[[ $ git status ]]';
    const task = AS.findTaskAt(text, text.length);
    assert.ok(task, JSON.stringify(prefix));
    assert.strictEqual(task.kind, 'command');
    assert.strictEqual(task.prefixLen, len, JSON.stringify(prefix));
    assert.strictEqual(task.start, prefix.length);
    assert.strictEqual(task.instruction, 'git status');
  });
  assert.ok(AS.findTaskAt('  ' + LLM_TASK, 0), 'whole-line task: caret before the indent still counts');
});

test('findTaskAt: offsets are UTF-16 indices (astral characters count twice)', () => {
  const kanji = String.fromCodePoint(0x20BB7);
  const text = kanji + kanji + ' ' + LLM_TASK + ' ' + kanji;
  const task = AS.findTaskAt(text, text.indexOf('@llm'));
  assert.strictEqual(task.start, 5);
  assert.strictEqual(task.end, 5 + LLM_TASK.length);
  assert.strictEqual(text.slice(task.start, task.end), LLM_TASK);
  assert.strictEqual(task.lineEnd, text.length);
  assert.strictEqual(AS.findTaskAt(text, 0), null);
});

test('findTaskAt: agent tasks resolve the agent by key or alias; everything else stays legacy', () => {
  const text = '{{ @claude テストを実行して }}';
  const task = AS.findTaskAt(text, 4);
  assert.strictEqual(task.kind, 'agent');
  assert.strictEqual(task.agent, 'claude-code');
  assert.strictEqual(task.mention, 'claude');
  assert.strictEqual(task.instruction, 'テストを実行して');
  assert.strictEqual(task.open + task.close, '{{}}');
  assert.strictEqual(task.outputMode, 'below');
  assert.strictEqual(AS.findTaskAt('{{ @claude: fix it }}', 4).instruction, 'fix it');
  assert.strictEqual(AS.findTaskAt('{{ @CC fix it }}', 4).agent, 'claude-code');
  assert.strictEqual(AS.findTaskAt('{{ @gemini fix it }}', 4).agent, 'agy');
  assert.strictEqual(AS.findTaskAt('{{ @agy }}', 4).instruction, '');
  assert.strictEqual(AS.findTaskAt('{{ @code-review src/ }}', 4), null, 'a skill mention is not an agent task');
  assert.strictEqual(AS.findTaskAt('{{ 要約して }}', 4), null);
  assert.strictEqual(AS.findTaskAt('{{ code: foo }}', 4), null);
  assert.strictEqual(AS.findTaskAt('{{ @llm x }}', 4), null);
  assert.strictEqual(AS.findTaskAt('{{@claude x}}', 4).instruction, 'x');
  const agents = { mybot: { aliases: ['bot'] } };
  assert.strictEqual(AS.findTaskAt('{{ @bot go }}', 4, undefined, { agents }).agent, 'mybot');
  assert.strictEqual(AS.findTaskAt('{{ @claude go }}', 4, undefined, { agents }), null);
});

test('findTaskAt: command tasks need "$" followed by a space; wiki links are never tasks', () => {
  assert.strictEqual(AS.findTaskAt('[[ $ git status ]]', 5).kind, 'command');
  assert.strictEqual(AS.findTaskAt('[[   $   git status   ]]', 5).instruction, 'git status');
  assert.strictEqual(AS.findTaskAt('[[ $ ]]', 3).instruction, '');
  ['[[$git status]]', '[[$100 budget]]', '[[Note]]', '[[Note|alias]]', '[[Note#Heading]]', '![[image.png]]', '[[ Note ]]', '[[ @llmx ]]', '[[ @claude x ]]', '[[]]']
    .forEach((s) => assert.strictEqual(AS.findTaskAt(s, 3), null, s));
  assert.strictEqual(AS.findTaskAt('[[@llm]]', 3).instruction, '');
  assert.strictEqual(AS.findTaskAt('[[ @LLM Hi ]]', 3).kind, 'llm');
  assert.strictEqual(AS.findTaskAt('[[ @llm　全角空白　]]', 3).instruction, '全角空白');
});

test('findTaskAt: tasks are single-line and must be closed', () => {
  assert.strictEqual(AS.findTaskAt('[[ @llm no close', 3), null);
  assert.strictEqual(AS.findTaskAt('[[ @llm split\nacross ]]', 3), null);
  assert.strictEqual(AS.findTaskAt('{{ @claude split\nacross }}', 3), null);
  const crlf = '[[ @llm x ]]\r\nnext';
  const task = AS.findTaskAt(crlf, 3);
  assert.strictEqual(task.lineEnd, 12);
  assert.strictEqual(task.end, 12);
});

test('findTaskAt: nothing inside code fences or inline code is a task', () => {
  const fenced = 'intro\n```\n' + LLM_TASK + '\n```\n' + LLM_TASK + '\n';
  const first = fenced.indexOf(LLM_TASK);
  const second = fenced.lastIndexOf(LLM_TASK);
  assert.strictEqual(AS.findTaskAt(fenced, first + 3), null);
  assert.strictEqual(AS.findTaskAt(fenced, second + 3).start, second);
  const tilde = '~~~\n' + LLM_TASK + '\n~~~';
  assert.strictEqual(AS.findTaskAt(tilde, 6), null);
  const long = '````\n```\n' + LLM_TASK + '\n```\n````\n' + LLM_TASK;
  assert.strictEqual(AS.findTaskAt(long, long.indexOf(LLM_TASK) + 3), null);
  assert.ok(AS.findTaskAt(long, long.lastIndexOf(LLM_TASK) + 3));
  assert.strictEqual(AS.findTaskAt('`' + LLM_TASK + '`', 5), null);
  assert.strictEqual(AS.findTaskAt('use `code` then ' + LLM_TASK, 20).kind, 'llm');
  assert.strictEqual(AS.findTaskAt('```\n' + LLM_TASK, 8), null, 'an unclosed fence runs to the end of the note');
  assert.strictEqual(AS.inCodeFence('a\n```\nb\n```\nc', 6), true);
  assert.strictEqual(AS.inCodeFence('a\n```\nb\n```\nc', 12), false);
  assert.strictEqual(AS.inCodeFence('a\n```\nb\n```\nc', 0), false);
});

test('findTaskAt: several tasks on one line, the one under the caret wins', () => {
  const text = '[[ @llm a ]] and [[ $ ls ]]';
  assert.strictEqual(AS.findTaskAt(text, 3).instruction, 'a');
  assert.strictEqual(AS.findTaskAt(text, text.length - 3).instruction, 'ls');
  assert.strictEqual(AS.findTaskAt(text, 14), null);
});

test('findTaskAt: a selection picks the task under its start, else the first task on the selected lines', () => {
  const text = 'para\n[[ @llm one ]]\nmore\n{{ @claude two }}\nend';
  const one = text.indexOf('[[');
  const two = text.indexOf('{{');
  assert.strictEqual(AS.findTaskAt(text, 0, text.length).instruction, 'one');
  assert.strictEqual(AS.findTaskAt(text, two + 3, text.length).instruction, 'two');
  assert.strictEqual(AS.findTaskAt(text, 0, 4), null);
  assert.strictEqual(AS.findTaskAt(text, one + 3, one + 8).instruction, 'one');
  assert.strictEqual(AS.findTaskAt(text, one, text.indexOf('more')).instruction, 'one', 'whole task line selected (ends at the next line start)');
  assert.strictEqual(AS.findTaskAt(text, 0, one), null, 'a selection that ends at the start of the task line does not include it');
  assert.strictEqual(AS.findTaskAt(text, text.indexOf('more'), two), null, 'the selection ends at the start of the second task line');
  assert.strictEqual(AS.findTaskAt(text, one + 2, two + 2).instruction, 'one');
  assert.strictEqual(AS.findTaskAt(text, text.length, 0).instruction, 'one', 'reversed selection is normalised');
});

test('findTaskAt: `>> ` stays plain text; the task inside is still found by caret', () => {
  const text = '>> [[ @llm x ]]';
  assert.strictEqual(AS.findTaskAt(text, 5).instruction, 'x');
  assert.strictEqual(AS.findTaskAt(text, 5).prefixLen, 0);
  assert.strictEqual(AS.findTaskAt(text, 0), null);
});

test('findTaskAt: robust against odd arguments and results below a task', () => {
  assert.strictEqual(AS.findTaskAt('', 0), null);
  assert.strictEqual(AS.findTaskAt(null, 5), null);
  assert.strictEqual(AS.findTaskAt(undefined), null);
  assert.strictEqual(AS.findTaskAt(LLM_TASK, -5).kind, 'llm');
  assert.strictEqual(AS.findTaskAt(LLM_TASK, 999).kind, 'llm');
  assert.strictEqual(AS.findTaskAt(LLM_TASK, NaN).kind, 'llm');
  const note = LLM_TASK + '\n' + AS.makeResultBlock('ab12', 'done') + '\nafter';
  assert.strictEqual(AS.findTaskAt(note, note.indexOf('done')), null);
});

test('findTaskAt: cost stays tiny on a large note without tasks and with one at the end', () => {
  const big = 'ordinary line of text without any brackets\n'.repeat(3000);
  let t0 = process.hrtime.bigint();
  assert.strictEqual(AS.findTaskAt(big, big.length >> 1), null);
  const plain = Number(process.hrtime.bigint() - t0) / 1e6;
  const withTask = big + '```\nx\n```\n' + LLM_TASK;
  t0 = process.hrtime.bigint();
  assert.strictEqual(AS.findTaskAt(withTask, withTask.length).kind, 'llm');
  const found = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  findTaskAt on a ' + big.length + ' char note: ' + plain.toFixed(3) + ' ms (no task), ' + found.toFixed(3) + ' ms (task at the end, fence scan)');
  assert.ok(plain < 5 && found < 25);
});

// ---- run markers and result blocks ---------------------------------------------------------------------
test('makeRunMarker / makeResultBlock: exact text', () => {
  assert.strictEqual(AS.makeRunMarker('ab12'), '<!-- md-memo:run ab12 -->');
  assert.strictEqual(AS.makeRunMarker('AB-12'), '<!-- md-memo:run ab12 -->');
  assert.strictEqual(AS.makeRunMarker(''), '<!-- md-memo:run 0000 -->');
  assert.strictEqual(AS.makeResultBlock('ab12', '  hello\nworld \n\n'), '<!-- md-memo:res ab12 -->\nhello\nworld\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeResultBlock('ab12', '\r\nline1\r\nline2\r\n'), '<!-- md-memo:res ab12 -->\nline1\nline2\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeResultBlock('ab12', '   '), '<!-- md-memo:res ab12 -->\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeResultBlock('ab12', null), '<!-- md-memo:res ab12 -->\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeResultBlock('ab12', 'a\n\nb'), '<!-- md-memo:res ab12 -->\na\n\nb\n<!-- /md-memo:res -->');
});

test('findResultAfter: finds the block or the run marker directly below a task and round-trips', () => {
  const block = AS.makeResultBlock('ab12', '結果の\n複数行');
  const note = '前\n' + LLM_TASK + '\n' + block + '\n後ろ';
  const task = AS.findTaskAt(note, note.indexOf('@llm'));
  const hit = AS.findResultAfter(note, task.end);
  assert.deepStrictEqual(hit, { kind: 'block', marker: 'res', id: 'ab12', start: note.indexOf('<!-- md-memo:res'), end: note.indexOf('\n後ろ'), text: block });
  const replaced = note.slice(0, hit.start) + AS.makeResultBlock('zz99', '新しい') + note.slice(hit.end);
  assert.strictEqual(replaced, '前\n' + LLM_TASK + '\n' + AS.makeResultBlock('zz99', '新しい') + '\n後ろ');
  assert.deepStrictEqual(AS.findResultAfter(note, task.lineStart), hit, 'any index inside the task line works');

  const running = LLM_TASK + '\n' + AS.makeRunMarker('q1w2') + '\nrest';
  const m = AS.findResultAfter(running, LLM_TASK.length);
  assert.deepStrictEqual(m, { kind: 'marker', marker: 'run', id: 'q1w2', start: LLM_TASK.length + 1, end: LLM_TASK.length + 1 + AS.makeRunMarker('q1w2').length, text: AS.makeRunMarker('q1w2') });
});

test('findResultAfter: an empty block, the last block in a note, CRLF notes, indented markers', () => {
  const empty = LLM_TASK + '\n' + AS.makeResultBlock('e001', '');
  assert.strictEqual(AS.findResultAfter(empty, 3).text, AS.makeResultBlock('e001', ''));
  assert.strictEqual(AS.findResultAfter(empty, 3).end, empty.length);
  const crlf = LLM_TASK + '\r\n<!-- md-memo:res c001 -->\r\nbody\r\n<!-- /md-memo:res -->\r\ntail';
  const c = AS.findResultAfter(crlf, 3);
  assert.strictEqual(c.kind, 'block');
  assert.strictEqual(crlf.slice(c.start, c.end), '<!-- md-memo:res c001 -->\r\nbody\r\n<!-- /md-memo:res -->');
  const indented = LLM_TASK + '\n  <!-- md-memo:res i001 -->  \nx\n  <!-- /md-memo:res -->  \n';
  const i = AS.findResultAfter(indented, 3);
  assert.strictEqual(indented.slice(i.start, i.end), '<!-- md-memo:res i001 -->  \nx\n  <!-- /md-memo:res -->');
});

test('findResultAfter: only the line directly below counts, and each task owns its own block', () => {
  const b1 = AS.makeResultBlock('aa11', 'one');
  const b2 = AS.makeResultBlock('bb22', 'two');
  const note = '[[ @llm a ]]\n' + b1 + '\n[[ @llm b ]]\n' + b2;
  assert.strictEqual(AS.findResultAfter(note, 5).id, 'aa11');
  assert.strictEqual(AS.findResultAfter(note, note.lastIndexOf('[[ @llm b ]]') + 3).id, 'bb22');
  assert.strictEqual(AS.findResultAfter(LLM_TASK + '\nplain text\n' + b1, 3), null);
  assert.strictEqual(AS.findResultAfter(LLM_TASK + '\n\n' + b1, 3), null, 'a blank line breaks the association');
  assert.strictEqual(AS.findResultAfter(LLM_TASK, 3), null);
  assert.strictEqual(AS.findResultAfter(LLM_TASK + '\n', 3), null);
  assert.strictEqual(AS.findResultAfter('', 0), null);
  assert.strictEqual(AS.findResultAfter(null, 0), null);
});

test('findResultAfter: an unclosed block is reported as a single marker line and never swallows the next block', () => {
  const open = '<!-- md-memo:res aaaa -->';
  const note = LLM_TASK + '\n' + open + '\ntext\n' + AS.makeResultBlock('bbbb', 'x');
  const hit = AS.findResultAfter(note, 3);
  assert.deepStrictEqual([hit.kind, hit.marker, hit.id, hit.text], ['marker', 'res', 'aaaa', open]);
  assert.strictEqual(AS.findResultAfter(LLM_TASK + '\n' + open + '\ntext without end', 3).kind, 'marker');
});

test('makeResultBlock: text that imitates a marker cannot end the block early', () => {
  const evil = 'before\n<!-- /md-memo:res -->\nafter\n<!--md-memo:run zz99 -->\n<!-- md-memo:res qq11 -->';
  const block = AS.makeResultBlock('ab12', evil);
  const note = LLM_TASK + '\n' + block + '\ntail';
  const hit = AS.findResultAfter(note, 3);
  assert.strictEqual(hit.kind, 'block');
  assert.strictEqual(hit.id, 'ab12');
  assert.strictEqual(note.slice(hit.end), '\ntail');
  assert.strictEqual(block.split('<!-- /md-memo:res -->').length, 2);
  assert.ok(block.indexOf('&lt;!-- /md-memo:res -->') > 0);
  assert.ok(block.indexOf('<!-- md-memo:run') < 0 && block.indexOf('<!--md-memo:run') < 0);
});

test('newTaskId: four lowercase alphanumerics, unique within the note', () => {
  for (let i = 0; i < 200; i++) assert.ok(/^[a-z0-9]{4}$/.test(AS.newTaskId('')));
  const seq = (values) => { let i = 0; return () => values[i++ % values.length]; };
  const rand = seq([0, 0, 0, 0, 1 / 36, 1 / 36, 1 / 36, 1 / 36]);
  assert.strictEqual(AS.newTaskId('x <!-- md-memo:run aaaa -->', rand), 'bbbb');
  assert.strictEqual(AS.newTaskId('<!-- md-memo:res aaaa -->\n<!-- /md-memo:res -->', seq([0, 0, 0, 0, 1 / 36, 1 / 36, 1 / 36, 1 / 36])), 'bbbb');
  const stuck = AS.newTaskId('<!-- md-memo:run aaaa -->', () => 0);
  assert.ok(/^[a-z0-9]{5,6}$/.test(stuck) && stuck !== 'aaaa');
  let note = '';
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = AS.newTaskId(note);
    assert.ok(!seen.has(id));
    seen.add(id);
    note += AS.makeRunMarker(id) + '\n';
  }
  assert.ok(/^[a-z0-9]{4}$/.test(AS.newTaskId(note, () => 0.999999)));
});

// ---- marker attributes (ctx=above) ------------------------------------------------------------------------
test('makeRunMarker / makeResultBlock: an optional attribute word after the id, cleaned to key=value words', () => {
  assert.strictEqual(AS.makeRunMarker('ab12', 'ctx=above'), '<!-- md-memo:run ab12 ctx=above -->');
  assert.strictEqual(AS.makeResultBlock('ab12', 'x', 'ctx=above'), '<!-- md-memo:res ab12 ctx=above -->\nx\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeResultBlock('ab12', '', 'ctx=above'), '<!-- md-memo:res ab12 ctx=above -->\n<!-- /md-memo:res -->');
  assert.strictEqual(AS.makeRunMarker('ab12', ''), '<!-- md-memo:run ab12 -->');
  assert.strictEqual(AS.makeRunMarker('ab12', null), '<!-- md-memo:run ab12 -->');
  assert.strictEqual(AS.makeRunMarker('ab12', 'CTX=Above  a=b'), '<!-- md-memo:run ab12 ctx=above a=b -->');
  assert.strictEqual(AS.makeRunMarker('ab12', 'x --> <b>'), '<!-- md-memo:run ab12 x b -->', 'nothing that could close the comment survives');
});

test('findResultAfter: reports attrs when the marker or block carries some, and leaves the shape alone when not', () => {
  const block = AS.makeResultBlock('ab12', 'done', 'ctx=above');
  const note = LLM_TASK + '\n' + block + '\nafter';
  const hit = AS.findResultAfter(note, 3);
  assert.deepStrictEqual(hit, { kind: 'block', marker: 'res', id: 'ab12', start: LLM_TASK.length + 1, end: LLM_TASK.length + 1 + block.length, text: block, attrs: 'ctx=above' });
  const run = AS.makeRunMarker('q1w2', 'ctx=above');
  assert.deepStrictEqual(AS.findResultAfter(LLM_TASK + '\n' + run, 3), { kind: 'marker', marker: 'run', id: 'q1w2', start: LLM_TASK.length + 1, end: LLM_TASK.length + 1 + run.length, text: run, attrs: 'ctx=above' });
  assert.ok(!('attrs' in AS.findResultAfter(LLM_TASK + '\n' + AS.makeRunMarker('q1w2'), 3)), 'no attrs key without attributes');
  const open = '<!-- md-memo:res aaaa ctx=above -->';
  assert.deepStrictEqual(AS.findResultAfter(LLM_TASK + '\n' + open + '\ntext without end', 3).attrs, 'ctx=above', 'an unclosed opener keeps its attrs');
  assert.strictEqual(AS.findResultAfter(LLM_TASK + '\n<!-- md-memo:run ab12 ctx=above garbage! -->', 3), null, 'a marker with junk after the id is not one of ours');
  const replaced = note.slice(0, hit.start) + AS.makeResultBlock('zz99', 'new', 'ctx=above') + note.slice(hit.end);
  assert.strictEqual(replaced, LLM_TASK + '\n' + AS.makeResultBlock('zz99', 'new', 'ctx=above') + '\nafter');
});

test('makeResultBlock with attrs: the opener still matches the prefix the Go parser hides (md-memo:res )', () => {
  const block = AS.makeResultBlock('ab12', 'x', 'ctx=above');
  assert.ok(block.startsWith('<!-- md-memo:res '));
  assert.ok(block.endsWith('<!-- /md-memo:res -->'));
});

// ---- findContextAbove --------------------------------------------------------------------------------------
test('findContextAbove: the contiguous non-blank lines directly above a task', () => {
  const note = 'intro\n\nline one\nline two\n[[ @llm 要約して ]]\nafter';
  const at = note.indexOf('[[');
  const ctx = AS.findContextAbove(note, at);
  assert.deepStrictEqual(ctx, { text: 'line one\nline two', start: note.indexOf('line one'), end: note.indexOf('\n[[ @llm'), lines: 2 });
  assert.strictEqual(note.slice(ctx.start, ctx.end), ctx.text);
  assert.strictEqual(AS.findContextAbove(note, at + 5).text, 'line one\nline two', 'any index of the task line works');
  assert.strictEqual(AS.findContextAbove('[[ @llm x ]]', 0), null, 'nothing above');
  assert.strictEqual(AS.findContextAbove('\n[[ @llm x ]]', 1), null, 'a blank line directly above is no text');
  assert.strictEqual(AS.findContextAbove('para\n\n[[ @llm x ]]', 6), null, 'a blank line between the text and the task breaks the link');
  assert.strictEqual(AS.findContextAbove(null, 0), null);
});

test('findContextAbove: looks through earlier task lines, result blocks and run markers so a second instruction finds the same text', () => {
  const b1 = AS.makeResultBlock('aa11', 'first answer\n\nwith a blank line', 'ctx=above');
  const note = 'topic one\ntopic two\n[[ @llm first ]]\n' + b1 + '\n[[ $ ls ]]\n' + AS.makeRunMarker('bb22') + '\n{{ @claude third }}\ntail';
  const second = note.indexOf('{{ @claude');
  const ctx = AS.findContextAbove(note, second);
  assert.strictEqual(ctx.text, 'topic one\ntopic two');
  assert.strictEqual(ctx.lines, 2);
  const cmd = AS.findContextAbove(note, note.indexOf('[[ $ ls ]]'));
  assert.strictEqual(cmd.text, 'topic one\ntopic two', 'through a block with a blank line inside it');
  assert.strictEqual(AS.findContextAbove(note, note.indexOf('[[ @llm first ]]')).text, 'topic one\ntopic two');
  const skill = 'text above\n{{ @some-skill x }}\n[[ @llm x ]]';
  assert.strictEqual(AS.findContextAbove(skill, skill.indexOf('[[ @llm')).text, 'text above\n{{ @some-skill x }}', 'a skill mention is text, not a task');
  const orphan = 'text\n<!-- md-memo:res zz99 -->\nunclosed body\n[[ @llm x ]]';
  assert.strictEqual(AS.findContextAbove(orphan, orphan.indexOf('[[ @llm')).text, 'unclosed body', 'a marker line ends the text: only what is below it counts');
  const marker = 'text\n<!-- md-memo:run zz99 -->\n[[ @llm x ]]';
  assert.strictEqual(AS.findContextAbove(marker, marker.indexOf('[[ @llm')).text, 'text', 'a run marker directly above is looked through');
});

test('findContextAbove: a task line inside the collected text ends it, CRLF is normalised, wiki links stay text', () => {
  const note = 'old text\n[[ @llm earlier ]]\nnew text\n[[Wiki Link]] here\n[[ @llm now ]]';
  assert.strictEqual(AS.findContextAbove(note, note.lastIndexOf('[[ @llm now')).text, 'new text\n[[Wiki Link]] here');
  const crlf = 'a\r\nb\r\n[[ @llm x ]]';
  const c = AS.findContextAbove(crlf, crlf.indexOf('[['));
  assert.strictEqual(c.text, 'a\nb');
  assert.strictEqual(crlf.slice(c.start, c.end), 'a\r\nb');
  assert.strictEqual(AS.findContextAbove('x\n[[ @llm a ]]', 3, { agents: ['zz'] }).text, 'x', 'agent list option is accepted');
  const agents = { bot: { aliases: ['b'] } };
  assert.strictEqual(AS.findContextAbove('text\n{{ @b do }}\n[[ @llm x ]]', 17, { agents }).text, 'text', '{{ @alias }} of the given agents is a task line');
  assert.strictEqual(AS.findContextAbove('text\n{{ @claude do }}\n[[ @llm x ]]', 23, { agents }).text, 'text\n{{ @claude do }}', 'and an unknown agent is not');
});

test('findContextAbove: at most 80 lines and 8000 characters, the ones nearest the task, whole characters only', () => {
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push('line ' + i);
  const note = lines.join('\n') + '\n[[ @llm x ]]';
  const ctx = AS.findContextAbove(note, note.lastIndexOf('[['));
  assert.strictEqual(ctx.lines, 80);
  assert.strictEqual(ctx.text.split('\n')[0], 'line 21');
  assert.strictEqual(ctx.text.split('\n')[79], 'line 100');
  const wide = ('あ'.repeat(3000) + '\n').repeat(4) + '[[ @llm x ]]';
  const w = AS.findContextAbove(wide, wide.lastIndexOf('[['));
  assert.strictEqual(w.lines, 2);
  assert.ok(w.text.length <= 8000 && w.text.length >= 6001, String(w.text.length));
  const giant = 'い'.repeat(9000) + '\n[[ @llm x ]]';
  const g = AS.findContextAbove(giant, giant.lastIndexOf('[['));
  assert.strictEqual(g.text.length, 8000, 'one huge line: its last 8000 characters');
  assert.strictEqual(g.lines, 1);
  const emoji = String.fromCodePoint(0x1F600).repeat(4500) + '\n[[ @llm x ]]';
  const e = AS.findContextAbove(emoji, emoji.lastIndexOf('[['));
  assert.ok(e.text.length <= 8000 && e.text.length % 2 === 0, 'a surrogate pair is never cut in half');
  assert.ok(e.text.charCodeAt(0) >= 0xd800 && e.text.charCodeAt(0) <= 0xdbff, 'starts on a high surrogate');
});

test('findContextAbove: opts.maxLines takes fewer lines (a recorded task remembers how many its text had)', () => {
  const note = 'heading\nfirst\nsecond\n[[ @llm x ]]';
  const at = note.lastIndexOf('[[');
  assert.strictEqual(AS.findContextAbove(note, at).text, 'heading\nfirst\nsecond');
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: 1 }).text, 'second');
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: 2 }).text, 'first\nsecond');
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: 2 }).lines, 2);
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: 0 }).text, 'second', 'at least one line');
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: 1000 }).lines, 3, 'never more than the text has');
  assert.strictEqual(AS.findContextAbove(note, at, { maxLines: NaN }).lines, 3);
  const lines = [];
  for (let i = 1; i <= 100; i++) lines.push('line ' + i);
  const big = lines.join('\n') + '\n[[ @llm x ]]';
  assert.strictEqual(AS.findContextAbove(big, big.lastIndexOf('[['), { maxLines: 500 }).lines, 80, 'still capped at 80');
});

test('findContextAbove: a big note with many tasks stays cheap', () => {
  const chunk = 'ordinary line of text\n'.repeat(2000);
  let note = chunk;
  for (let i = 0; i < 20; i++) note += 'para ' + i + '\n[[ @llm q' + i + ' ]]\n' + AS.makeResultBlock('a' + i + 'aa', 'answer '.repeat(50), 'ctx=above') + '\n\n';
  note += 'last paragraph\n[[ @llm final ]]';
  const t0 = process.hrtime.bigint();
  const ctx = AS.findContextAbove(note, note.lastIndexOf('[[ @llm final'));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(ctx.text, 'last paragraph');
  console.log('  findContextAbove on a ' + note.length + ' char note: ' + ms.toFixed(3) + ' ms');
  assert.ok(ms < 10);
});

// ---- tuned rules --------------------------------------------------------------------------------------------
test('classify: "run the tests / a build" is agent work only with an execution verb next to something runnable', () => {
  assert.deepStrictEqual([AS.classify('テストを実行して').kind, AS.classify('テストを実行して').target], ['instruction', 'agent']);
  assert.strictEqual(AS.classify('npm test を実行して').target, 'agent');
  assert.strictEqual(AS.classify('ビルドして').target, 'agent');
  assert.strictEqual(AS.classify('テストの結果を要約して').target, 'llm', 'no execution verb');
  assert.strictEqual(AS.classify('実行計画を箇条書きにして').target, 'llm', 'nothing runnable');
  assert.strictEqual(AS.classify('英語のテストを作って').target, 'llm');
  assert.strictEqual(AS.classify('Please run the tests').target, 'agent');
  assert.strictEqual(AS.classify('テストを実行して', { rules: { runVerbs: ['踊'] } }).target, 'llm', 'the table can be replaced');
  assert.strictEqual(AS.classify('foo を実行して', { rules: { runTargets: ['foo'] } }).target, 'agent');
  assert.ok(Array.isArray(AS.RULES.runVerbs) && Array.isArray(AS.RULES.runTargets));
});

// ---- cost ------------------------------------------------------------------------------------------------
test('loading the module is free: one global, no timers, no regexps built at load', () => {
  const path = require.resolve('./auto_selector.js');
  const saved = require.cache[path];
  const savedGlobal = globalThis.AutoSelector;
  delete require.cache[path];
  delete globalThis.AutoSelector;
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const RealRegExp = RegExp;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let built = 0;
  let timers = 0;
  globalThis.RegExp = function (...args) { built++; return new RealRegExp(...args); };
  globalThis.setTimeout = (...a) => { timers++; return realSetTimeout(...a); };
  globalThis.setInterval = (...a) => { timers++; return realSetInterval(...a); };
  let fresh;
  try {
    fresh = require('./auto_selector.js');
  } finally {
    globalThis.RegExp = RealRegExp;
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  const added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k));
  assert.deepStrictEqual(added, ['AutoSelector']);
  assert.strictEqual(built, 0, 'no RegExp constructed while loading');
  assert.strictEqual(timers, 0);
  assert.strictEqual(Object.keys(fresh).sort().join(), Object.keys(AS).sort().join());

  const t0 = process.hrtime.bigint();
  fresh.classify('この文章を要約して');
  const cold = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  first classify() call on a fresh module (builds and caches the tables): ' + cold.toFixed(3) + ' ms');
  assert.ok(cold < 50);
  require.cache[path] = saved;
  globalThis.AutoSelector = savedGlobal;
});

test('classify: a call costs microseconds, far under 1 ms', () => {
  const lines = [].concat(LLM_LINES, AGENT_LINES.map((r) => (Array.isArray(r) ? r[0] : r)), COMMAND_LINES, CONTENT_LINES, AMBIGUOUS_LINES).filter((l) => l.length <= 240 && l.indexOf('\n') < 0);
  for (let i = 0; i < 3; i++) lines.forEach((l) => AS.classify(l));
  const rounds = 20;
  let worst = 0;
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < rounds; r++) {
    lines.forEach((l) => {
      const s = process.hrtime.bigint();
      AS.classify(l);
      const d = Number(process.hrtime.bigint() - s);
      if (d > worst) worst = d;
    });
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  const avgUs = (total * 1000) / (rounds * lines.length);
  console.log('  classify(): ' + lines.length + ' distinct lines x ' + rounds + ' rounds, average ' + avgUs.toFixed(1) + ' us per call, slowest single call ' + (worst / 1000).toFixed(0) + ' us');
  assert.ok(avgUs < 500, 'average ' + avgUs + ' us');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
