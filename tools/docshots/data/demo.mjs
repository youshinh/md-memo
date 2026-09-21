// Demo data for the documentation screenshots: neutral, deterministic, no private content.
// buildBoot(query, title) returns the object the mock backend reads as window.__DOCSHOT_BOOT.

export const FIXED_CLOCK = { y: 2026, m: 8, d: 18, h: 10, mi: 24 }; // 2026-09-18 10:24 (month is 0-based)

const ROOT = 'C:\\Users\\demo\\Documents\\notes';
const SCRAP_DIR = '~/Documents/md-memo/scraps';
const P = (name) => ROOT + '\\' + name;

const MAIN_EN = [
  '# Mobile Drop rollout',
  '',
  'Plan for shipping the phone-to-desk drop flow. Owner: Aya.',
  '',
  '## Schedule',
  '',
  '| Task            | Owner | Due   |',
  '|-----------------|-------|-------|',
  '| API design memo | Aya   | 09-24 |',
  '| Beta test       | Ken   | 10-01 |',
  '| Release notes   | Mio   | 10-08 |',
  '',
  '## API sketch',
  '',
  '```json',
  '{',
  '  "endpoint": "/upload-batch",',
  '  "rateLimit": 60',
  '}',
  '```',
  '',
  '## Checklist',
  '',
  '- [x] Draft the API design',
  '- [ ] Review rate limits at the weekly review',
  '- [ ] Prepare the release notes',
  '',
  '## Flow',
  '',
  '```mermaid',
  'graph LR',
  '  A[Phone] --> B[QR scan]',
  '  B --> C[Note]',
  '```',
  '',
  '{{ Turn the checklist above into three release note bullets }}',
  '',
  '## Attachments',
  '',
  '[spec.pdf](./assets/spec.pdf)',
  '![diagram](./assets/diagram.png)',
  '',
  '## Open questions',
  '',
  '- Should the QR code expire sooner than 60 seconds?',
  '- Where should voice recordings be stored by default?',
  '- Who signs off the rate limit?',
  '',
  '## Next steps',
  '',
  '- Send the beta invite list to Ken',
  '- Book the review meeting',
  '',
].join('\n');

const MAIN_JA = [
  '# モバイルドロップ展開計画',
  '',
  'スマホから PC へ送る流れを公開するための計画メモ。担当: 佐藤。',
  '',
  '## スケジュール',
  '',
  '| タスク | 担当 | 期限 |',
  '|--------|------|------|',
  '| API 設計メモ | 佐藤 | 09-24 |',
  '| ベータ試験 | 田中 | 10-01 |',
  '| リリースノート | 鈴木 | 10-08 |',
  '',
  '## API スケッチ',
  '',
  '```json',
  '{',
  '  "endpoint": "/upload-batch",',
  '  "rateLimit": 60',
  '}',
  '```',
  '',
  '## チェックリスト',
  '',
  '- [x] API 設計を下書きする',
  '- [ ] 週次レビューでレート制限を見直す',
  '- [ ] リリースノートを用意する',
  '',
  '## フロー',
  '',
  '```mermaid',
  'graph LR',
  '  A[スマホ] --> B[QR 読み取り]',
  '  B --> C[ノート]',
  '```',
  '',
  '{{ 上のチェックリストからリリースノートの要点を 3 行で書く }}',
  '',
  '## 添付',
  '',
  '[spec.pdf](./assets/spec.pdf)',
  '![diagram](./assets/diagram.png)',
  '',
  '## 未解決の質問',
  '',
  '- QR コードの有効期限を 60 秒より短くするか',
  '- 音声の保存先の既定値をどうするか',
  '- レート制限の承認者は誰か',
  '',
  '## 次のアクション',
  '',
  '- 田中さんにベータ招待リストを送る',
  '- レビュー会議を予約する',
  '',
].join('\n');

const MEETING_EN = [
  '# Meeting 2026-09-18',
  '',
  'Attendees: Aya, Ken, Mio',
  '',
  '## Decisions',
  '',
  '- Ship the beta on 10-01.',
  '- Keep the rate limit at 60 requests per minute.',
  '',
  '## Next steps',
  '',
  '- [ ] Ken: set up the beta test group',
  '- [ ] Mio: draft the release notes',
  '',
].join('\n');

const MEETING_JA = [
  '# 会議メモ 2026-09-18',
  '',
  '参加者: 佐藤、田中、鈴木',
  '',
  '## 決定事項',
  '',
  '- ベータ版は 10-01 に公開する。',
  '- レート制限は 1 分あたり 60 リクエストのままにする。',
  '',
  '## 次のアクション',
  '',
  '- [ ] 田中: ベータ試験のグループを用意する',
  '- [ ] 鈴木: リリースノートを下書きする',
  '',
].join('\n');

const IDEAS_EN = [
  '# Ideas',
  '',
  '- Share a selection with the phone',
  '- Voice notes that turn into checklists',
  '- A weekly digest of open tasks',
  '',
].join('\n');

const IDEAS_JA = [
  '# アイデア',
  '',
  '- 選択したテキストをスマホと共有する',
  '- 音声メモをチェックリストに変える',
  '- 未完了タスクの週次ダイジェスト',
  '',
].join('\n');

const WORKSPACE_EN = [
  { name: 'api-design-memo.md', title: 'API design memo', snippet: 'Draft the API design first. Rate limits, auth and the upload-batch endpoint.' },
  { name: 'weekly-review.md', title: 'Weekly review', snippet: 'Review rate limits, release notes and open risks every Friday.' },
  { name: 'reading-list.md', title: 'Reading list', snippet: 'Articles about local-first software and Markdown tooling.' },
  { name: 'release-checklist.md', title: 'Release checklist', snippet: 'Tag, build, smoke test, publish the notes.' },
  { name: 'meeting-2026-09-10.md', title: 'Meeting 2026-09-10', snippet: 'Kick-off. Scope of the drop feature and owners.' },
];

const WORKSPACE_JA = [
  { name: 'api-design-memo.md', title: 'API 設計メモ', snippet: 'API 設計を下書きする。レート制限とバッチ送信の仕様を整理する。' },
  { name: 'weekly-review.md', title: '週次レビュー', snippet: '議事: 週次レビューでレート制限を見直す。リリースノートの担当を決める。' },
  { name: 'reading-list.md', title: '読書リスト', snippet: 'ローカルファーストのソフトウェアと Markdown 周辺ツールの記事。' },
  { name: 'release-checklist.md', title: 'リリースチェックリスト', snippet: 'タグ付け、ビルド、動作確認、ノート公開。' },
  { name: 'meeting-2026-09-10.md', title: '会議メモ 2026-09-10', snippet: 'キックオフ。ドロップ機能の範囲と担当。' },
];

const SCRAPS_EN = [
  { name: '2026-09-17.md', lines: ['# 2026-09-17', '', '10:12 API design: keep /upload-batch, add a size limit', '10:40 Ask Ken about the beta group', '15:05 Reading: local-first sync notes', ''] },
  { name: '2026-09-15.md', lines: ['# 2026-09-15', '', '09:30 Weekly review: rate limits stay at 60 per minute', '11:02 API keys are never stored in notes', '17:20 Draft the release notes tomorrow', ''] },
  { name: '2026-09-12.md', lines: ['# 2026-09-12', '', '13:15 Mobile drop: QR expires after 60 seconds', '14:48 API error format: plain text, one line', '16:30 Book list for the weekend', ''] },
];

const SCRAPS_JA = [
  { name: '2026-09-17.md', lines: ['# 2026-09-17', '', '10:12 API 設計: /upload-batch は残し、サイズ上限を追加する', '10:40 田中さんにベータ参加者の件を確認', '15:05 読書: ローカルファースト同期のメモ', ''] },
  { name: '2026-09-15.md', lines: ['# 2026-09-15', '', '09:30 週次レビュー: レート制限は 1 分あたり 60 のまま', '11:02 API キーはノートに保存しない', '17:20 リリースノートは明日下書きする', ''] },
  { name: '2026-09-12.md', lines: ['# 2026-09-12', '', '13:15 モバイルドロップ: QR は 60 秒で失効する', '14:48 API のエラー形式: 1 行のプレーンテキスト', '16:30 週末の読書リスト', ''] },
];

export const SLOT_CONFIG = {
  version: 2,
  default_agent: 'claude-code',
  timeout_seconds: 180,
  hover_peek_enabled: true,
  ghost_diff_duration_ms: 8000,
  agents: {
    'claude-code': { command: 'claude', args: ['--file', '{file}', '--prompt', '{instruction}'], description: 'Claude Code' },
    hermes: { command: 'ollama', args: ['run', 'hermes3', '{instruction}'], description: 'Hermes 3 (local)' },
    codex: { command: 'codex', args: ['--execute', '--file', '{file}'], description: 'Codex' },
    agy: { command: 'agy', args: ['-p', '{instruction}'], description: 'Google Antigravity' },
  },
  slot_profiles: [
    { trigger_open: '{{', trigger_close: '}}', name: 'code', agent: 'claude-code', system_instruction: 'Output only the result, without preamble.' },
    { trigger_open: '[?', trigger_close: ']', name: 'research', agent: 'claude-code', system_instruction: 'Search the web and answer briefly with sources.' },
    { trigger_open: '[!', trigger_close: '!]', name: 'adversarial', agent: 'claude-code', system_instruction: 'List three risks.' },
  ],
  recipes: [],
};

// Settings package (export / import) demo: a project with three skills spread over two skill roots, an app-level and a
// project-level agents file, and a package on the desktop whose agents file and two skills already exist ("will overwrite").
const APP_DIR = 'C:\\Users\\demo\\AppData\\Roaming\\md-memo';
const PACK_PATH = 'C:\\Users\\demo\\Desktop\\md-memo-20260918.mdmemopack';

function packDemo() {
  const skill = (root, name, files, bytes) => ({ id: `skill:${root}/${name}`, root, name, entry: 'dir', files, bytes });
  const skills = [
    skill('skills', 'meeting-minutes', 3, 5120),
    skill('skills', 'release-notes', 4, 7168),
    skill('.claude/skills', 'api-review', 5, 9216),
  ];
  const sections = ['general', 'models', 'integration', 'shortcuts'];
  return {
    list: {
      projectRoot: ROOT,
      agents: [
        { id: 'agents:app', scope: 'app', path: APP_DIR + '\\agents.yaml', bytes: 2048 },
        { id: 'agents:project', scope: 'project', path: ROOT + '\\.md-memo\\agents.yaml', bytes: 912 },
      ],
      skills,
      warnings: [],
    },
    exportResult: {
      ok: true, path: PACK_PATH,
      counts: { config: 1, agents: 2, skills: 2, files: 11, bytes: 31744 },
      secretsStripped: 1, secretWarnings: 0, warnings: [],
    },
    inspect: {
      packPath: PACK_PATH,
      legacy: false,
      projectRoot: ROOT,
      manifest: {
        format: 'md-memo-pack', version: 1, createdAt: '2026-09-18T09:40:00+09:00', appVersion: '1.5.5',
        includesSecrets: false, configSections: sections, items: [],
      },
      items: [
        { id: 'config', kind: 'config', sections },
        { id: 'agents:app', kind: 'agents', scope: 'app', bytes: 2048, exists: true },
        { id: 'agents:project', kind: 'agents', scope: 'project', bytes: 912, exists: false },
        { ...skill('skills', 'release-notes', 4, 7168), kind: 'skill', exists: true },
        { ...skill('skills', 'meeting-minutes', 3, 5120), kind: 'skill', exists: false },
        { ...skill('.claude/skills', 'api-review', 5, 9216), kind: 'skill', exists: true },
      ],
      warnings: [],
    },
    importResult: {
      ok: true, configJSON: '', configSections: [], applied: { agents: [], skills: [] }, backupDir: '', skipped: [], needsRestart: false,
    },
  };
}

// The agents settings as the frontend gets them (getActiveSlotConfigJSON): the default agents carry their aliases, and the
// project's agents.yaml holds one own snippet (the example from the generated template), in the picture's language.
function slotConfigFor(ja) {
  const cfg = JSON.parse(JSON.stringify(SLOT_CONFIG));
  cfg.agents['claude-code'].aliases = ['claude', 'cc'];
  cfg.agents.agy.aliases = ['antigravity', 'gemini'];
  cfg.snippets = [ja
    ? { id: 'weekly', label: '今週の振り返り', kind: 'llm', trigger: '/weekly', body: 'この内容を今週の振り返りとして3点に要約して: ${selection}' }
    : { id: 'weekly', label: 'Weekly recap', kind: 'llm', trigger: '/weekly', body: 'Summarize this in three points as a weekly recap: ${selection}' }];
  return cfg;
}

function lineEndOffset(text, lineNo) {
  const lines = text.split('\n');
  let off = 0;
  for (let i = 0; i < lineNo; i++) off += lines[i].length + 1;
  return off - 1;
}

export function buildBoot(query, title) {
  const lang = query.lang === 'ja' ? 'ja' : 'en';
  const ja = lang === 'ja';
  const main = ja ? MAIN_JA : MAIN_EN;

  // Caret starts at the end of the second checklist item (line 25); it drives the "related notes" pills.
  const mainCaret = lineEndOffset(main, 25);

  const tabs = [
    { id: 'tab_demo_1', title: 'project-notes.md', path: P('project-notes.md'), content: main, isDirty: false, encoding: 'UTF-8', cursorPos: mainCaret },
    { id: 'tab_demo_2', title: 'meeting-2026-09-18.md', path: P('meeting-2026-09-18.md'), content: ja ? MEETING_JA : MEETING_EN, isDirty: false, encoding: 'UTF-8', cursorPos: 0 },
    { id: 'tab_demo_3', title: 'ideas.md', path: P('ideas.md'), content: ja ? IDEAS_JA : IDEAS_EN, isDirty: false, encoding: 'UTF-8', cursorPos: 0 },
  ];

  const session = {
    activeTabId: 'tab_demo_1',
    tabCounter: 4,
    isSplitMode: false,
    secondaryTabId: null,
    secondaryViewMode: 'editor',
    activePane: 'primary',
    isPreviewMode: false,
    tabs,
  };

  const config = {
    text: { baseUrl: 'http://localhost:11434', model: 'gemma4:latest', apiKey: '', systemPrompt: 'You are a helpful assistant. Provide concise, accurate markdown responses.' },
    autocomplete: { enabled: true, baseUrl: 'http://localhost:11434', model: 'gemma4:latest', apiKey: '', delayMs: 500, maxTokens: 30 },
    vision: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-flash-lite-latest', apiKey: 'DEMO-KEY-NOT-REAL-0000', prompt: 'Transcribe the content of this image (text, diagrams, tables, code, etc.) into structured, faithful Markdown format.' },
    voice: { model: 'gemini-3.5-transcribe', apiStyle: 'auto', languageCodes: ja ? ['ja-JP'] : [], mode: 'smart', customVocabulary: [], silence_timeout_sec: 5, prompt: ja ? 'この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。' : 'Transcribe this audio accurately. No preamble or commentary; output only the natural text with punctuation.', baseUrl: '', apiKey: '' },
    cli: { model: '', baseUrl: '', apiKey: '', systemPrompt: '', openResultInNewTab: true, openErrorInNewTab: true },
    action: { enabled: true, baseUrl: '', model: '', apiKey: '' },
    image: { model: 'gemini-3.1-flash-lite-image', aspectRatio: '16:9', resolution: '1024', apiKey: '' },
    general: {
      language: lang,
      theme: 'olive',
      autoSave: true,
      pasteImageOcr: true,
      restoreSession: true,
      trayResident: true,
      splitViewOnStartup: false,
      imeGuardian: ja,
      aiCorrection: true,
      cursorAura: false,
      toolbarLayout: { order: [], hidden: [] },
      contextMenuLayout: { order: [], hidden: [] },
    },
    scraps: { scrapDir: SCRAP_DIR, gitSyncEnabled: true, gitSyncDebounceSeconds: 30, gitRemoteBranch: 'main', gitRemoteUrl: 'https://github.com/demo-user/scraps.git', maxPipeSizeMB: 10 },
    shortcuts: {},
    default_agent: 'claude-code',
    timeout_seconds: 180,
    hover_peek_enabled: true,
    ghost_diff_duration_ms: SLOT_CONFIG.ghost_diff_duration_ms,
  };

  const wsSrc = ja ? WORKSPACE_JA : WORKSPACE_EN;
  const notes = wsSrc.map((n) => ({ path: P(n.name), relPath: n.name, title: n.title, snippet: n.snippet }));

  const scrapSrc = ja ? SCRAPS_JA : SCRAPS_EN;
  const scraps = scrapSrc.map((s) => ({ filePath: SCRAP_DIR.replace('~', 'C:\\Users\\demo') + '\\' + s.name, fileName: s.name, content: s.lines.join('\n') }));

  return {
    title,
    lang,
    clock: FIXED_CLOCK,
    config,
    session,
    slotConfig: slotConfigFor(ja),
    pack: packDemo(),
    workspace: { root: ROOT, notes },
    scraps,
    cliHistory: ['sort -u', 'jq .'],
    noteFiles: tabs.map((t) => ({ path: t.path, title: t.title, content: t.content })),
    phoneUrl: 'http://192.168.0.24:52814/?token=demo0000demo0000demo0000demo0000',
    version: '1.5.5',
    query,
  };
}
