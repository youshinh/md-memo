import { readFileSync } from 'node:fs';

// Per-shot state setup. Each function receives ctx (see makeCtx in run.mjs) on a freshly loaded demo page
// and drives the app the way a user would: real key and mouse events through CDP. Clipboard and drag events
// are synthetic on purpose (a real Ctrl+V would paste the user's actual clipboard).
const MAIN_LINES = {
  checklistLast: 26, // "- [ ] Prepare the release notes"
  slot: 36,          // the {{ ... }} line
  attachments: 40,   // the image link line
};

async function pillsReady(ctx) {
  await ctx.waitFor("document.querySelectorAll('#stat-ambient-container .ambient-pill').length >= 2", { timeout: 8000, label: 'related-note pills' });
}

async function quietStatus(ctx) {
  await ctx.ev("(function(){var m=document.getElementById('stat-message'); if(m) m.textContent=''; return true;})()");
}

async function caretAtEndOf(ctx, line) {
  await ctx.ev(`__docshot.setCaret(__docshot.lineEnd(${line}))`);
}

async function shortcutsTab(ctx) {
  await ctx.key(',', { ctrl: true });
  await ctx.waitFor("!document.getElementById('settings-modal').classList.contains('hidden')", { label: 'settings modal' });
  await ctx.clickSel('#tab-btn-shortcuts');
  await ctx.waitFor("!document.getElementById('pane-shortcuts').classList.contains('hidden')", { label: 'shortcuts pane' });
}

async function openSettings(ctx, tab) {
  await ctx.key(',', { ctrl: true });
  await ctx.waitFor("!document.getElementById('settings-modal').classList.contains('hidden')", { label: 'settings modal' });
  if (tab && tab !== 'general') {
    await ctx.clickSel('#tab-btn-' + tab);
    await ctx.waitFor(`!document.getElementById('pane-${tab}').classList.contains('hidden')`, { label: tab + ' pane' });
  }
  // The pictures show every section, so switch "Show advanced" on (a beginner sees the advanced sections folded).
  await ctx.ev("(function(){var c=document.getElementById('cfg-show-advanced'); if (c && !c.checked) c.click();})()");
  await ctx.sleep(600); // provider / Ollama / Git status lines resolve asynchronously
}

// Clicks the checkbox of the row with this title inside the package dialog (a real mouse click).
async function packRowClick(ctx, title) {
  const pos = await ctx.ev(`(function(){
    var row = Array.from(document.querySelectorAll('#pack-body .pack-row')).find(function(r){var t=r.querySelector('.pack-row-title');return t && t.textContent===${JSON.stringify(title)};});
    if (!row) return null;
    var i = row.querySelector('input'); i.scrollIntoView({block:'nearest'});
    var b = i.getBoundingClientRect();
    return {x:b.left+b.width/2, y:b.top+b.height/2};
  })()`);
  if (!pos) throw new Error('package dialog row not found: ' + title);
  await ctx.click(pos.x, pos.y);
}

async function openPackExport(ctx) {
  await openSettings(ctx, 'general');
  await ctx.clickSel('#btn-export-settings');
  await ctx.waitFor("!document.getElementById('pack-modal').classList.contains('hidden') && document.querySelectorAll('#pack-body .pack-listbox .pack-row').length >= 5", { label: 'export dialog with the project list' });
  await packRowClick(ctx, 'meeting-minutes');
  await packRowClick(ctx, 'release-notes');
}

async function openPackImport(ctx) {
  // The package date is shown in the browser's locale; the harness browser is en-US, so the Japanese pictures ask for ja-JP.
  if (ctx.ja) await ctx.ev("(function(){var f=Date.prototype.toLocaleString;Date.prototype.toLocaleString=function(){return f.call(this,'ja-JP');};})()");
  await openSettings(ctx, 'general');
  await ctx.clickSel('#btn-import-settings');
  await ctx.waitFor("!document.getElementById('pack-modal').classList.contains('hidden') && document.querySelectorAll('#pack-body .pack-row').length >= 5", { label: 'import dialog' });
}

async function packScroll(ctx, where) {
  await ctx.ev(`(function(){var b=document.getElementById('pack-body');b.scrollTop=${where === 'top' ? '0' : 'b.scrollHeight'};return b.scrollTop;})()`);
  await ctx.sleep(250);
}

// A blank line to type an instruction on, with a blank line left below it: Enter twice on the blank line 27, then up
// to line 28. The view is scrolled first, so anything that follows the caret (the Run button) keeps its place.
async function instructionLine(ctx, text) {
  await ctx.ev('__docshot.scrollToLine(27, 8)');
  await caretAtEndOf(ctx, 27);
  await ctx.key('Enter');
  await ctx.key('Enter');
  await ctx.key('ArrowUp');
  await ctx.type(text);
}

const scrollPaneTo = (sel, block = 'start') =>
  `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:${JSON.stringify(block)}});return true;})()`;

// More notes than the strip can show (B2): real Ctrl+N, then a first line that names the tab. The demo starts with three tabs.
const MANY_TAB_NAMES = {
  en: ['Weekly review', 'Reading list', 'Trip to Kyoto', 'Budget 2026', 'Ideas backlog', 'Standup notes', 'Miso soup recipe', 'Book draft', 'Call with Sato', 'Launch checklist'],
  ja: ['週次レビュー', '読書リスト', '京都旅行', '予算2026', 'アイデア置き場', '朝会メモ', '味噌汁のレシピ', '本の下書き', '佐藤さんとの電話', 'リリース前チェック'],
};

async function openManyTabs(ctx, total) {
  const names = ctx.pick(MANY_TAB_NAMES.en, MANY_TAB_NAMES.ja);
  const have = await ctx.ev("document.querySelectorAll('#tabs-list .tab-item').length");
  for (let i = 0; have + i < total; i++) {
    await ctx.key('n', { ctrl: true });
    await ctx.waitFor(`document.querySelectorAll('#tabs-list .tab-item').length === ${have + i + 1}`, { label: 'new tab ' + (have + i + 1) });
    await ctx.key('a', { ctrl: true });
    await ctx.type('# ' + names[i % names.length]);
  }
  await ctx.sleep(400); // the strip scrolls the newest tab into view on the next frame
}

// The Lessons pictures call the agent "claude". The demo's agents.yaml key is claude-code, with "claude" as an alias, which the mock would
// resolve back to claude-code (the dialog names the agent the backend resolved); so the demo agent is renamed in the mock's own copy of the
// settings (the page read its settings at start-up and is not told). The model that proposes is the demo's text model on this PC.
async function lessonsDemoAgent(ctx) {
  await ctx.ev(`(function(){
    var a = __docshot.boot.slotConfig.agents;
    if (a['claude-code']) { a.claude = a['claude-code']; a.claude.aliases = ['cc']; delete a['claude-code']; }
    var L = __docshot.lessons;
    L.model = 'gemma4:latest'; L.host = 'localhost:11434'; L.local = true; L.consent = false;
    return 1;
  })()`);
}

// Two finished delegated tasks of "claude" in the task list: an older one that finished with two lessons applied, then a newer one that failed.
async function lessonsDemoCards(ctx) {
  const [okText, badText] = ctx.pick(
    ['Build and summarize the result', 'Build and fix the compile error'],
    ['ビルドして結果をまとめる', 'コンパイルエラーを直す']);
  const output = 'cc1: fatal error: ADF.h: No such file or directory\ncompilation terminated.';
  await ctx.ev(`(function(){
    var now = Date.now();
    function card(id, text, startAgo, update) {
      TaskManager.addTask({ id: id, type: 'slot', agent: 'claude', agentKey: 'claude', instruction: text, startTime: now - startAgo, onCancel: function () {} });
      TaskManager.updateTask(id, Object.assign({ endTime: now }, update));
    }
    card('lesson_demo_done', ${JSON.stringify(okText)}, 48000, { status: 'completed', error: '', output: 'Build finished: 0 errors, 2 warnings.', exitCode: 0, lessonsApplied: 2 });
    card('lesson_demo_failed', ${JSON.stringify(badText)}, 72000, { status: 'failed', error: 'Exit Code 1', output: ${JSON.stringify(output)}, exitCode: 1 });
    return 1;
  })()`);
}

// The About / update pictures need the version the app really has (read from app.go, so a release does not make them stale) and a fake
// GitHub answer that names the next minor version.
const APP_VERSION = (/AppVersion = "([^"]+)"/.exec(readFileSync(new URL('../../app.go', import.meta.url), 'utf8')) || [])[1] || '1.0.0';
const NEXT_VERSION = APP_VERSION.split('.').map(Number).map((n, i) => (i === 1 ? n + 1 : i === 2 ? 0 : n)).join('.');

async function aboutFixtures(ctx) {
  await ctx.ev(`(function(){ __docshot.boot.aboutVersion = ${JSON.stringify(APP_VERSION)}; __docshot.boot.version = ${JSON.stringify(APP_VERSION)}; })()`);
  await ctx.ev(`window.fetch = function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ tag_name: 'v${NEXT_VERSION}' }); } }); }`);
}

export const SETUPS = {
  async uiMap(ctx) {
    await pillsReady(ctx);
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await quietStatus(ctx);
  },

  async statusBar(ctx) {
    await pillsReady(ctx);
    // Blank the editor text so the call-outs above the bar sit on a plain background.
    await ctx.ev("(function(){var s=document.createElement('style');s.textContent='#editor{color:transparent!important} #line-numbers{visibility:hidden}';document.head.appendChild(s);})()");
    await quietStatus(ctx);
  },

  async inlineAi(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('(function(){var a=__docshot.lineStart(3), b=__docshot.lineEnd(3); __docshot.setCaret(a,b);})()');
    await ctx.key('l', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'ask bar' });
    await ctx.type(ctx.pick('Rewrite this in a friendlier tone', 'もう少し親しみやすい文体に書き直して'));
    // Hand focus back to the note so the selection shows in its active colour (the bar keeps its text).
    await ctx.ev('__docshot.editor().focus()');
  },

  // A failed ask: the note is back as it was and the bar is open again with the reason, Retry and AI settings.
  async askBarError(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('(function(){var a=__docshot.lineStart(3), b=__docshot.lineEnd(3); __docshot.setCaret(a,b);})()');
    // The mock has no model: make the request fail the way an Ollama that is not running does.
    await ctx.ev(`window.backend.queryLLMAsync = function (id) { setTimeout(function () { window.__onLLMResult(id, '', 'ローカルLLM/API接続エラー (http://localhost:11434): Post "http://localhost:11434/v1/chat/completions": dial tcp 127.0.0.1:11434: connectex: No connection could be made because the target machine actively refused it.'); }, 60); }`);
    await ctx.key('l', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'ask bar' });
    await ctx.type(ctx.pick('Make this shorter', 'もっと短くして'));
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('inline-prompt-error').classList.contains('hidden')", { timeout: 6000, label: 'error banner' });
  },

  // A1: the very first launch (boot fresh=1 + nosession=1: no settings, no tabs, no folder): one editable Welcome note.
  async welcomeNote(ctx) {
    await ctx.waitFor("window.MdMemoBridge && MdMemoBridge.getActiveTab() && MdMemoBridge.getActiveTab().title === " + JSON.stringify(ctx.pick('Welcome', 'ようこそ')), { label: 'the Welcome note' });
    await quietStatus(ctx);
  },

  // A2: the first Ctrl+L with the built-in model (local Ollama, qwen2.5) still untouched: the one-time choice inside the ask bar.
  async askBarChoice(ctx) {
    await ctx.ev("(function(){var c=MdMemoBridge.getConfig();c.text.baseUrl='http://localhost:11434';c.text.model='qwen2.5:latest';c.text.apiKey='';delete c.general.aiChoiceMade;return true;})()");
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('(function(){var a=__docshot.lineStart(3), b=__docshot.lineEnd(3); __docshot.setCaret(a,b);})()');
    await ctx.key('l', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-choice').classList.contains('hidden')", { label: 'the model choice' });
  },

  async ghostText(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Enter');
    const typed = ctx.pick('- [ ] Share the beta ', '- [ ] ベータ日程を');
    const ghost = ctx.pick('schedule with the whole team before Friday', 'チーム全員に金曜までに共有する');
    await ctx.ev(`__docshot.ghost = ${JSON.stringify(ghost)}`);
    await ctx.type(typed);
    await ctx.waitFor("document.querySelector('#ghost-overlay .ghost-suggestion') && document.querySelector('#ghost-overlay .ghost-suggestion').textContent.length > 0", { timeout: 6000, label: 'ghost suggestion' });
  },

  async smartPaste(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Enter');
    await ctx.key('Enter');
    const head = ctx.pick(['Item', 'Qty', 'Price'], ['品目', '数量', '単価']);
    const rows = ctx.pick(
      [['Notebook', '3', '4.50'], ['Marker set', '2', '6.00'], ['Sticky notes', '5', '1.20']],
      [['ノート', '3', '450'], ['マーカー', '2', '600'], ['付箋', '5', '120']],
    );
    const html = '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
    const plain = [head, ...rows].map((r) => r.join('\t')).join('\n');
    await ctx.ev(`(function(){
      var ed = __docshot.editor(); ed.focus();
      var dt = new DataTransfer();
      dt.setData('text/html', ${JSON.stringify(html)});
      dt.setData('text/plain', ${JSON.stringify(plain)});
      var ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles:true, cancelable:true});
      ed.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    await ctx.waitFor("__docshot.editor().value.indexOf('| ---') !== -1", { label: 'markdown table inserted' });
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await ctx.ev("__docshot.pin('#stat-message')");
  },

  async voiceRecording(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Enter');
    // The marker's wording follows the UI language (voice_input.js).
    await ctx.ev(`MdMemoBridge.insertTextWithUndo('\\u2985${ctx.pick('Recording...', '音声入力中...')} [id:a1b2]\\u2986', __docshot.editor())`);
  },

  // The recording indicator in the status bar. A silent stand-in replaces the microphone (and the silence timeout is long, so
  // the recording does not stop by itself); the indicator is drawn by the application's own voice input code.
  async voiceIndicator(ctx) {
    await ctx.ev("(function(){var c=MdMemoBridge.getConfig();c.voice=c.voice||{};c.voice.silence_timeout_sec=120;var ac=new (window.AudioContext||window.webkitAudioContext)();navigator.mediaDevices.getUserMedia=function(){return Promise.resolve(ac.createMediaStreamDestination().stream);};return true;})()");
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.ev('__docshot.editor().focus()');
    await ctx.ev('VoiceInput.toggle()');
    await ctx.waitFor("(function(){var e=document.querySelector('#stat-recording .rec-time');return !!e && e.textContent==='0:03';})()", { timeout: 15000, label: 'recording indicator at 3 s' });
    await ctx.ev("(function(){var s=document.createElement('style');s.textContent='#editor{color:transparent!important} #line-numbers{visibility:hidden}';document.head.appendChild(s);return true;})()");
  },

  async voiceRescue(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Enter');
    await ctx.ev(`MdMemoBridge.insertTextWithUndo('\\u2985${ctx.pick('Transcription failed: [Retry(id:a1b2)] [Save audio] [Discard]', '文字起こし失敗: [再試行(id:a1b2)] [音声保存] [破棄]')}\\u2986', __docshot.editor())`);
  },

  // The command bar (Ctrl+E) opens in the mode used last; a fresh profile has none, so it opens in the manual CLI mode.
  async cliBar(ctx) {
    await ctx.ev("(function(){try{localStorage.removeItem('md_memo_cmdbar_mode');}catch(e){}})()");
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, 20);
    await ctx.key('e', { ctrl: true });
    await ctx.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden') && document.getElementById('cli-filter-input').hasAttribute('list')", { label: 'command bar in CLI mode' });
    await ctx.type('sort -u');
  },

  // Same key, then Tab in the field switches to the AI mode (clicking the badge does the same).
  async aiCliBar(ctx) {
    await ctx.ev("(function(){try{localStorage.removeItem('md_memo_cmdbar_mode');}catch(e){}})()");
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, 20);
    await ctx.key('e', { ctrl: true });
    await ctx.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden')", { label: 'command bar' });
    await ctx.key('Tab');
    await ctx.waitFor("!document.getElementById('cli-filter-input').hasAttribute('list')", { label: 'command bar in AI mode' });
    await ctx.type(ctx.pick('list the ten newest .md files in this folder', 'このフォルダの新しい .md ファイルを 10 件表示'));
  },

  async slotAgent(ctx) {
    await ctx.ev('__docshot.scrollToLine(30, 4)');
    await ctx.ev("__docshot.setCaret(__docshot.find('{{') + 4)");
    await ctx.key('Enter', { ctrl: true });
    await ctx.waitFor("__docshot.editor().value.indexOf('実行中') !== -1", { label: 'running placeholder' });
    await ctx.waitFor("!document.getElementById('stat-tasks').classList.contains('hidden')", { label: 'task badge' });
    await ctx.ev('__docshot.scrollToLine(30, 4)');
  },

  async ghostDiff(ctx) {
    await ctx.ev('__docshot.scrollToLine(30, 4)');
    const newContent = ctx.pick(
      '- Beta ships on 10-01 with QR pairing and batch upload.\n- The rate limit stays at 60 requests per minute.\n- Voice input arrives as an opt-in setting.',
      '- 10-01 に QR ペアリングとバッチ送信付きでベータを公開する。\n- レート制限は 1 分あたり 60 リクエストのまま。\n- 音声入力は任意の設定として追加する。',
    );
    const info = await ctx.ev(`(function(){var v=__docshot.editor().value;var s=v.indexOf('{{');var e=v.indexOf('}}',s)+2;return {start:s,end:e,raw:v.substring(s,e)};})()`);
    await ctx.ev(`__docshot.setCaret(${info.start + 4})`);
    await ctx.key('Enter', { ctrl: true });
    await ctx.waitFor("__docshot.editor().value.indexOf('実行中') !== -1", { label: 'running placeholder' });
    await ctx.sleep(1100); // the app merges a result only after 500 ms without typing
    const run = await ctx.ev('__docshot.slotRuns[__docshot.slotRuns.length - 1]');
    await ctx.ev(`window.__onSlotAgentResult({reqId:${JSON.stringify(run.reqId)}, type:'slot', role:'code', instruction:'', startOffset:${info.start}, endOffset:${info.end}, oldContent:${JSON.stringify(info.raw)}, newContent:${JSON.stringify(newContent)}, isInline:true, exitCode:0, status:'completed'})`);
    await ctx.waitFor("document.querySelectorAll('.ghost-diff-band').length > 0", { label: 'ghost diff band' });
    // Freeze the animation ~300 ms into a default 4 s run (the demo config uses 8 s, so scale the time). The duration
    // is a custom property on the band itself (ghost_diff.js); the band lives in the editor's wrapper, not on the editor.
    await ctx.ev(`(function(){var d=4000;document.querySelectorAll('.ghost-diff-band').forEach(function(b){d=parseFloat(b.style.getPropertyValue('--ghost-diff-duration'))||4000;b.getAnimations().forEach(function(a){a.pause();a.currentTime=300*d/4000;});});return d;})()`);
    await ctx.sleep(400); // let the line-number gutter catch up with the inserted lines
    await ctx.ev('__docshot.scrollToLine(30, 4)');
  },

  // Auto selector. The instruction is typed on the blank line 27 (between the checklist and "## Flow").
  // Ctrl+Enter on a line that reads as a request for the built-in LLM: it becomes [[ @llm ... ]] and the answer
  // arrives below the line, in a block between two comment lines. The instruction line itself stays.
  async autoSelResult(ctx) {
    await instructionLine(ctx, ctx.pick('Translate the checklist above into Japanese', '上のチェックリストを英語に翻訳して'));
    await ctx.ev(`__docshot.llmReply = ${JSON.stringify(ctx.pick(
      '- [x] API 設計を下書きする\n- [ ] 週次レビューでレート制限を見直す\n- [ ] リリースノートを用意する',
      '- [x] Draft the API design\n- [ ] Review rate limits at the weekly review\n- [ ] Prepare the release notes',
    ))}`);
    await ctx.key('Enter', { ctrl: true });
    await ctx.waitFor("__docshot.editor().value.indexOf('<!-- /md-memo:res') !== -1", { timeout: 8000, label: 'result block' });
    await ctx.sleep(600);
    await ctx.ev("__docshot.pin('#stat-message', '')"); // the autosave toast is not part of the picture
  },

  // A line that reads as a job for an agent: it is rewritten to {{ @agent ... }} and stops (the setting "confirm before
  // an auto-detected agent or command runs" is on by default); the toast says how to run it or undo the rewrite.
  async autoSelConfirm(ctx) {
    await instructionLine(ctx, ctx.pick('Run the tests and fix the failures', 'テストを実行して'));
    await ctx.key('Enter', { ctrl: true });
    await ctx.waitFor("__docshot.editor().value.indexOf('{{ @claude-code') !== -1", { label: 'rewritten as an agent task' });
    await ctx.waitFor("document.getElementById('stat-message').textContent.trim().length > 0", { label: 'rewrite toast' });
    await ctx.sleep(300);
    await ctx.ev("__docshot.pin('#stat-message')");
  },

  // Ctrl+Enter on an ordinary sentence (not a request): the ask bar opens for that line, and what you type is
  // written into the note below the line as [[ @llm ... ]].
  async askBarRecord(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('__docshot.setCaret(__docshot.lineEnd(3))');
    await ctx.key('Enter', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'ask bar in record mode' });
    await ctx.type(ctx.pick('Rewrite this in a friendlier tone', 'もう少し親しみやすい文体に書き直して'));
  },

  // Command palette -> "Insert task snippet": the snippet list on its own. (Typing {{ lists the same snippets after the
  // profiles and recipes; this route shows only the snippets, which is what the manual's legend describes.)
  async snippetPicker(ctx) {
    await ctx.ev('__docshot.scrollToLine(27, 8)');
    await caretAtEndOf(ctx, 27);
    await ctx.key('P', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'quick-pick-input'", { label: 'command palette input focused' });
    await ctx.type(ctx.pick('task snippet', 'タスクのひな形'));
    await ctx.waitFor("document.querySelectorAll('.quick-pick-item').length === 1", { label: 'one palette match' });
    await ctx.sleep(500); // the editor's blur timer (200 ms) from opening the palette must be over, or it closes the picker at once
    await ctx.key('Enter');
    await ctx.waitFor("(function(){var s=document.getElementById('slot-quick-selector');return !!s && s.classList.contains('active');})()", { label: 'snippet picker' });
    await ctx.sleep(500);
  },

  async settingsAutosel(ctx) {
    await openSettings(ctx, 'agent');
    await ctx.ev(scrollPaneTo('#cfg-autosel-enabled', 'center'));
    await ctx.sleep(200);
  },

  async quickActions(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    const cands = ctx.pick(
      [
        { action_type: 'ai', command: '{{ Turn the checklist above into three release note bullets }}', description: 'An agent drafts the release notes in the background' },
        { action_type: 'sh', command: 'git log --oneline -10', description: 'List the ten most recent commits and insert them' },
        { action_type: 'doc', command: 'Add a short "Risks" section under the checklist', description: 'The built-in AI writes the section for you' },
      ],
      [
        { action_type: 'ai', command: '{{ 上のチェックリストからリリースノートの要点を 3 行で書く }}', description: 'エージェントがバックグラウンドでリリースノートを下書きします' },
        { action_type: 'sh', command: 'git log --oneline -10', description: '直近 10 件のコミットを一覧にして挿入します' },
        { action_type: 'doc', command: 'チェックリストの下に「リスク」の節を短く追加する', description: '内蔵の AI が節を書いてくれます' },
      ],
    );
    await ctx.ev(`__docshot.jev = ${JSON.stringify(cands)}`);
    await ctx.key('j', { ctrl: true });
    await ctx.waitFor("!document.getElementById('jev-action-panel').classList.contains('hidden')", { label: 'quick actions panel' });
  },

  async fileLinkDrop(ctx) {
    await ctx.ev('__docshot.scrollToLine(30, 2)');
    await ctx.ev(`(function(){
      var ed = __docshot.editor(); var r = ed.getBoundingClientRect();
      var dt = new DataTransfer(); dt.items.add(new File(['demo'], 'spec.pdf', {type:'application/pdf'}));
      var opts = {bubbles:true, cancelable:true, dataTransfer:dt, clientX:r.left+360, clientY:r.top+150};
      ed.dispatchEvent(new DragEvent('dragenter', opts));
      ed.dispatchEvent(new DragEvent('dragover', opts));
    })()`);
    await ctx.waitFor("!!document.querySelector('#editor-wrapper.fanchor-drop-target') && !!document.querySelector('.fanchor-drop-badge')", { label: 'drop feedback' });
  },

  async fileLinkResult(ctx) {
    await ctx.ev('__docshot.scrollToLine(41, 8)');
    await ctx.sleep(150);
    const pos = await ctx.ev("(function(){var r=__docshot.textRect('![diagram](./assets/diagram.png)');return {x:r.x+90,y:r.y+r.h/2};})()");
    await ctx.move(pos.x, pos.y);
    await ctx.sleep(100);
    await ctx.move(pos.x + 2, pos.y);
    await ctx.waitFor("(function(){var t=document.querySelector('.fanchor-tooltip');var i=t&&t.querySelector('img');return !!(t&&t.style.display==='block'&&i&&i.complete&&i.naturalWidth>0);})()", { timeout: 6000, label: 'hover thumbnail' });
  },

  async splitPreview(ctx) {
    await ctx.ev('__testHelper.openPreviewToSide()');
    await ctx.waitFor("!!document.querySelector('#secondary-preview-pane svg')", { timeout: 20000, label: 'mermaid diagram' });
    await ctx.sleep(500);
    await ctx.ev("(function(){var s=document.querySelector('#secondary-preview-pane svg');s.scrollIntoView({block:'center'});})()");
    await ctx.ev('__docshot.scrollToLine(24, 2)');
    await ctx.sleep(300);
  },

  async scrapsSearch(ctx) {
    await ctx.key('F', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('scraps-search-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'scraps-search-input'", { label: 'scraps search input focused' });
    await ctx.type('API');
    await ctx.waitFor("document.querySelectorAll('.scraps-match-item').length >= 2", { timeout: 5000, label: 'search results' });
  },

  // The filter of the scraps search (Exact mode): the Filter area open, the period Last 30 days and one tag chosen, so that the list of "API"
  // is visibly shorter. The mock's notes get tags of their own in the language of the picture (the default mock tags are English and the
  // meaning-search days carry some too, so the whole map is replaced), plus three more notes: 2026-09-10 (inside the period, tagged, stays),
  // 2026-08-04 (tagged, but from before the period) and api-memo (tagged, but no date in its name, so the area says one note is not in
  // the period). 2026-09-12 has no `work` tag. So six notes match "API" and the filter leaves three. Only the data is seeded; the area is
  // opened and the period and the tag are chosen with real clicks.
  async scrapsFilter(ctx) {
    const [work, idea, reading, shopping, urgent] = ctx.pick(
      ['work', 'idea', 'reading', 'shopping', 'urgent'],
      ['仕事', 'アイデア', '読書', '買い物', '急ぎ']);
    const header = (day) => `# ${day}`;
    const extra = [
      {
        fileName: '2026-09-10.md',
        lines: [header('2026-09-10'), '', ctx.pick('14:20 API rate limit: ask the vendor about burst traffic', '14:20 API のレート制限: 瞬間的なアクセス増について業者に確認'), ''],
        tags: { file: [work, reading] },
      },
      {
        fileName: '2026-08-04.md',
        lines: [header('2026-08-04'), '', ctx.pick('09:10 API gateway: compare two vendors before September', '09:10 API ゲートウェイ: 9 月までに 2 社を比較する'), ''],
        tags: { file: [work] },
      },
      {
        fileName: 'api-memo.md',
        lines: [ctx.pick('API ideas from the train, no date yet', '電車の中で思いついた API の案(日付は未定)'), ''],
        tags: { file: [work] },
      },
    ];
    const tags = {
      '2026-09-17.md': { file: [work, idea] },
      '2026-09-15.md': { file: [work, urgent] },
      '2026-09-12.md': { file: [reading, shopping] },
    };
    await ctx.ev(`(function(){ var f = __docshot.filter; f.tags = ${JSON.stringify(tags)}; f.extra = ${JSON.stringify(extra)}; return 1; })()`);
    await ctx.key('F', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('scraps-search-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'scraps-search-input'", { label: 'scraps search input focused' });
    await ctx.type('API');
    await ctx.waitFor("document.querySelectorAll('.scraps-match-item').length >= 5", { timeout: 5000, label: 'search results before the filter' });
    // the Filter button opens the area (the tags are asked for now), then the period and the tag are pressed
    await ctx.clickSel('#btn-scraps-filter');
    await ctx.waitFor("!document.getElementById('scraps-filter-area').classList.contains('hidden') && document.querySelectorAll('[data-filter-tag]').length >= 3", { timeout: 5000, label: 'the filter area with its tags' });
    await ctx.clickSel('[data-filter-period="days30"]');
    await ctx.sleep(300);
    await ctx.clickSel(`[data-filter-tag=${JSON.stringify(work)}]`);
    await ctx.waitFor("document.getElementById('scraps-filter-count').textContent === '(2)' && document.querySelectorAll('.scraps-match-item').length === 3", { timeout: 5000, label: 'the narrowed list' });
    // the pointer rests on a neutral place, so that no chip is drawn in its hover state
    await ctx.move(1000, 640);
    await ctx.sleep(300);
  },

  // Adding a tag from the command palette (palette: "Add a tag to this entry"): a daily note with two dated entries, the caret in the second,
  // the picker open with the folder's tags and a new tag typed, so that the "New tag" row shows. The folder's tags are the mock's
  // scrapFilterOptions: its tag map is replaced by readable tags in the language of the picture (6 tags on 14 notes, the most notes first). The new tag
  // typed is the beginning of three of them, so the list narrows to those, as it does for a person typing.
  // Only the data is seeded (the tags, the note as a file tab); the palette, the command and the typed tag are real key events.
  async tagPicker(ctx) {
    const [work, reading, notes, plan, checklist, idea] = ctx.pick(
      ['work', 'reading', 'release-notes', 'release-plan', 'release-checklist', 'idea'],
      ['仕事', '読書', 'リリースノート', 'リリース計画', 'リリース確認', 'アイデア']);
    const day = (d) => `2026-09-${d}.md`;
    const tags = {};
    const put = (tag, days) => days.forEach((d) => { (tags[day(d)] = tags[day(d)] || { file: [] }).file.push(tag); });
    put(work, [17, 15, 28, 26, 24, 22, 20, 18]);
    put(reading, [12, 27, 25, 21, 19]);
    put(notes, [28, 24, 20, 17]);
    put(plan, [28, 22, 15]);
    put(checklist, [26, 19]);
    put(idea, [17, 23]);
    await ctx.ev(`(function(){ __docshot.filter.tags = ${JSON.stringify(tags)}; return 1; })()`);

    // a new note with two entries of the kind the daily scrap writes: a rule, then "## [time] title"
    const note = ctx.pick(
      ['# 2026-09-18', '', '---', '## [09:12:40] Weekly review', '', 'Rate limits stay at 60 per minute.', 'Ask Ken about the beta group.', '',
        '---', '## [10:24:07] Release notes draft', '', 'Turn the checklist into three bullets.', 'Send the draft to Mio before Friday.', ''],
      ['# 2026-09-18', '', '---', '## [09:12:40] 週次レビュー', '', 'レート制限は 1 分あたり 60 のまま。', '田中さんにベータ参加者の件を確認する。', '',
        '---', '## [10:24:07] リリースノートの下書き', '', 'チェックリストから要点を 3 行にまとめる。', '下書きは金曜までに鈴木さんへ送る。', '']).join('\n');
    // opened the way a file from the scraps folder is (a saved note: no dot of unsaved changes), through the page's own tab function
    const tabsBefore = await ctx.ev("document.querySelectorAll('#tabs-list .tab-item').length");
    // (the mock's "disk" gets the same text first, or the app would find the file empty and say it changed)
    const notePath = 'C:\\\\Users\\\\demo\\\\Documents\\\\md-memo\\\\scraps\\\\2026-09-18.md';
    await ctx.ev(`(function(){ __docshot.boot.noteFiles.push({ path: '${notePath}', title: '2026-09-18.md', content: ${JSON.stringify(note)} }); __testHelper.createTab('2026-09-18.md', ${JSON.stringify(note)}, '${notePath}', 'UTF-8'); return 1; })()`);
    await ctx.waitFor(`document.querySelectorAll('#tabs-list .tab-item').length === ${tabsBefore + 1} && document.getElementById('editor').value.indexOf('## [10:24:07]') !== -1`, { label: 'the note is open' });
    // the caret on the first line of the second entry's text (line 12)
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('__docshot.setCaret(__docshot.lineEnd(12))');

    // the palette: the word "tag" (タグ), the command, Enter
    const title = ctx.pick('Add a tag to this entry', 'この書き込みにタグを付ける');
    await ctx.key('P', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'quick-pick-input'", { label: 'command palette input focused' });
    await ctx.type(ctx.pick('tag', 'タグ'));
    const rowsOf = "Array.from(document.querySelectorAll('#quick-pick-list .quick-pick-item'))";
    await ctx.waitFor(`${rowsOf}.some(function(r){var t=r.querySelector('.quick-pick-item-title');return t && t.textContent===${JSON.stringify(title)};})`, { label: 'the tag command among the matches' });
    for (let i = 0; i < 4; i++) {
      const on = await ctx.ev(`(function(){var a=document.querySelector('#quick-pick-list .quick-pick-item.active .quick-pick-item-title');return !!a && a.textContent===${JSON.stringify(title)};})()`);
      if (on) break;
      await ctx.key('ArrowDown');
      await ctx.sleep(80);
    }
    await ctx.waitFor(`(function(){var a=document.querySelector('#quick-pick-list .quick-pick-item.active .quick-pick-item-title');return !!a && a.textContent===${JSON.stringify(title)};})()`, { label: 'the command is the chosen row' });
    await ctx.sleep(500); // the editor's blur timer from opening the palette must be over
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('tag-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'tag-pick-input'", { label: 'tag picker focused' });
    // the folder's tags have loaded: six rows, the first with the most notes
    await ctx.waitFor("document.querySelectorAll('#tag-pick-list .tag-pick-item').length === 6", { timeout: 5000, label: 'the folder tags in the list' });
    await ctx.type(ctx.pick('release', 'リリース'));
    await ctx.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && /release|リリース/.test(document.querySelector('#tag-pick-list .quick-pick-item-title').textContent)", { label: 'the New tag row' });
    // the pointer rests on a neutral place (outside the panel), so that no row is drawn in its hover state
    await ctx.move(1000, 660);
    await ctx.sleep(400);
  },

  // The same picker for a Web article pasted under a heading and cut into several entries by its own ### headings: the caret is in the
  // middle sub-section and Ctrl+Up has moved the "Attach to" row to the heading above, so that the chip says "Entry and everything under it
  // (3 entries)". The folder's tags are the mock's scrapFilterOptions (readable tags in the language of the picture); the typed tag is the
  // beginning of two of them. Only the data is seeded; the palette, the command, Ctrl+Up and the typed tag are real key events.
  async tagPickerTree(ctx) {
    const [work, reading, supplier, uses, idea, material] = ctx.pick(
      ['work', 'reading', 'bamboo-supplier', 'bamboo-uses', 'idea', 'materials'],
      ['仕事', '読書', '竹の仕入れ', '竹の用途', 'アイデア', '建材']);
    const day = (d) => `2026-09-${d}.md`;
    const tags = {};
    const put = (tag, days) => days.forEach((d) => { (tags[day(d)] = tags[day(d)] || { file: [] }).file.push(tag); });
    put(work, [17, 15, 28, 26, 24, 22, 20, 18]);
    put(reading, [12, 27, 25, 21, 19]);
    put(supplier, [28, 24, 20, 17]);
    put(uses, [26, 19]);
    put(idea, [17, 23]);
    put(material, [28, 22, 15]);
    await ctx.ev(`(function(){ __docshot.filter.tags = ${JSON.stringify(tags)}; return 1; })()`);

    // a daily note whose entry is a pasted article: "## [time] title" under a rule, then three ### sub-sections
    const note = ctx.pick(
      ['# 2026-09-18', '', '---', '## [10:24:07] About bamboo', 'Clipped from a web page.', '',
        '### Growth', 'Bamboo can be cut after about three years.', '',
        '### Processing', 'Split bamboo dries for a month before it is planed.', 'The ends are made into charcoal.', '',
        '### Uses', 'Flooring, shelves and ceiling panels.', ''],
      ['# 2026-09-18', '', '---', '## [10:24:07] 竹について', 'ウェブページから切り抜き。', '',
        '### 成長', '竹は三年ほどで伐採できる。', '',
        '### 加工', '割った竹は、かんなをかける前に一か月ほど乾かす。', '切れ端は炭にする。', '',
        '### 使いみち', '床材、棚、天井板。', '']).join('\n');
    const tabsBefore = await ctx.ev("document.querySelectorAll('#tabs-list .tab-item').length");
    const notePath = 'C:\\\\Users\\\\demo\\\\Documents\\\\md-memo\\\\scraps\\\\2026-09-18.md';
    await ctx.ev(`(function(){ __docshot.boot.noteFiles.push({ path: '${notePath}', title: '2026-09-18.md', content: ${JSON.stringify(note)} }); __testHelper.createTab('2026-09-18.md', ${JSON.stringify(note)}, '${notePath}', 'UTF-8'); return 1; })()`);
    await ctx.waitFor(`document.querySelectorAll('#tabs-list .tab-item').length === ${tabsBefore + 1} && document.getElementById('editor').value.indexOf('### ') !== -1`, { label: 'the note is open' });
    // the caret in the middle sub-section (the text line under its heading, line 11)
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('__docshot.setCaret(__docshot.lineEnd(11))');

    const title = ctx.pick('Add a tag to this entry', 'この書き込みにタグを付ける');
    await ctx.key('P', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'quick-pick-input'", { label: 'command palette input focused' });
    await ctx.type(ctx.pick('tag', 'タグ'));
    const rowsOf = "Array.from(document.querySelectorAll('#quick-pick-list .quick-pick-item'))";
    await ctx.waitFor(`${rowsOf}.some(function(r){var t=r.querySelector('.quick-pick-item-title');return t && t.textContent===${JSON.stringify(title)};})`, { label: 'the tag command among the matches' });
    for (let i = 0; i < 4; i++) {
      const on = await ctx.ev(`(function(){var a=document.querySelector('#quick-pick-list .quick-pick-item.active .quick-pick-item-title');return !!a && a.textContent===${JSON.stringify(title)};})()`);
      if (on) break;
      await ctx.key('ArrowDown');
      await ctx.sleep(80);
    }
    await ctx.waitFor(`(function(){var a=document.querySelector('#quick-pick-list .quick-pick-item.active .quick-pick-item-title');return !!a && a.textContent===${JSON.stringify(title)};})()`, { label: 'the command is the chosen row' });
    await ctx.sleep(500); // the editor's blur timer from opening the palette must be over
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('tag-pick-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'tag-pick-input'", { label: 'tag picker focused' });
    await ctx.waitFor("document.querySelectorAll('#tag-pick-list .tag-pick-item').length === 6", { timeout: 5000, label: 'the folder tags in the list' });
    // the "Attach to" row has the two places (the sub-section, the article); Ctrl+Up moves it to the article's heading
    await ctx.waitFor("!document.getElementById('tag-pick-where').classList.contains('hidden') && document.querySelectorAll('#tag-pick-where .tag-pick-place').length === 2", { timeout: 5000, label: 'the Attach to row' });
    await ctx.key('ArrowUp', { ctrl: true });
    await ctx.waitFor("(function(){var p=document.querySelectorAll('#tag-pick-where .tag-pick-place');return p.length === 2 && p[1].classList.contains('active');})()", { label: 'the article heading is the chosen place' });
    await ctx.type(ctx.pick('bamboo', '竹'));
    await ctx.waitFor("document.querySelector('#tag-pick-list .quick-pick-item-title') && /bamboo|竹/.test(document.querySelector('#tag-pick-list .quick-pick-item-title').textContent)", { label: 'the New tag row' });
    // the pointer rests on a neutral place (outside the panel), so that no row is drawn in its hover state
    await ctx.move(1000, 660);
    await ctx.sleep(400);
  },

  // Meaning mode of the scraps search: the question is in other words than the notes (a boot flag turned Semantic search on), and the mock
  // answers with readable hits.
  async scrapsMeaning(ctx) {
    const lines = ctx.pick(
      ['Bamboo grows fast and can be cut after about three years, so it is light on the environment.',
        'Asked the supplier about split-bamboo wainscot panels: 12 m, delivery in two weeks.',
        'Idea: make the menu board from leftover bamboo ends.',
        'The customer worried about cracks; I explained the warranty sheet.',
        'Compared bamboo flooring with oak: the price is close, the look is lighter.',
        'Visited the bamboo grove: the thinning work is done every winter.',
        'A tea shop wants bamboo shelves; ask about the curing time.',
        'Bamboo charcoal for the humidity of the cellar: try one box.',
        'The estimate for the bamboo ceiling is ready; send it on Friday.',
        'Notes on how bamboo is treated against insects.'],
      ['竹は成長が早く、三年ほどで伐採できるので、環境への負荷が小さい。',
        '腰壁に使う竹の割り材を業者に問い合わせた。12 m、納期は二週間。',
        'メニューボードは竹の端材で作れないか、案を考えた。',
        '割れの心配があるというお客さんに、保証の一枚紙で説明した。',
        '竹のフローリングとナラを比べた。価格は近く、見た目は軽い。',
        '竹林を見に行った。間伐は毎年冬にやっているそうだ。',
        'お茶屋さんが竹の棚を希望。乾燥にかかる期間を聞いておく。',
        '地下室の湿気対策に竹炭を一箱試してみる。',
        '竹の天井の見積もりができた。金曜に送る。',
        '竹の防虫処理についてのメモ。']);
    await ctx.ev(`__docshot.semantic.lines = ${JSON.stringify(lines)}`);
    await ctx.key('F', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('scraps-search-modal').classList.contains('hidden') && document.activeElement && document.activeElement.id === 'scraps-search-input'", { label: 'scraps search input focused' });
    await ctx.clickSel('#scraps-mode-meaning');
    await ctx.type(ctx.pick('using bamboo as a building material', '竹を建材に使う話'));
    await ctx.waitFor("document.querySelectorAll('.scraps-match-item').length >= 3 && !document.getElementById('btn-scraps-deep').classList.contains('hidden')", { timeout: 8000, label: 'meaning results and the Deep search button' });
    await ctx.sleep(300);
  },

  // The confirmation dialog of the Deep search: five notes to a model on this computer, one left out, two secrets blanked.
  async deepSearchDialog(ctx) {
    await ctx.ev('__docshot.deep.sources = 5; __docshot.deep.ignored = 2; __docshot.deep.masked = 2; 1');
    await SETUPS.scrapsMeaning(ctx);
    await ctx.clickSel('#btn-scraps-deep');
    await ctx.waitFor("!document.getElementById('deep-search-modal').classList.contains('hidden')", { timeout: 8000, label: 'deep search dialog' });
    await ctx.ev("document.getElementById('deep-search-sources').open = true; 1");
    await ctx.sleep(400);
  },

  // The print panel (Windows): the real print layout of the demo note. The harness's own Edge makes the PDF (Page.printToPDF, with the
  // panel open: the print style hides it) and puts it in the viewer in place of the mock's blank page.
  async printPanel(ctx) {
    await ctx.key('P', { ctrl: true });
    await ctx.waitFor("!document.getElementById('preview-pane').classList.contains('hidden')", { label: 'the preview' });
    await ctx.waitFor("document.querySelectorAll('#preview-pane svg').length >= 1", { timeout: 20000, label: 'the diagram' });
    await ctx.sleep(400);
    await ctx.clickSel('#btn-preview-print');
    await ctx.waitFor("!document.getElementById('print-modal').classList.contains('hidden') && !!document.querySelector('#print-stage embed')", { timeout: 20000, label: 'the print panel' });
    await ctx.sleep(500);
    const pdf = await ctx.page.cdp.send('Page.printToPDF', {
      paperWidth: 8.27, paperHeight: 11.69, marginTop: 0.79, marginRight: 0.79, marginBottom: 0.79, marginLeft: 0.79,
      printBackground: true, preferCSSPageSize: false, transferMode: 'ReturnAsBase64',
    });
    // the page count the summary line says is the PDF's own: ask for a new preview (the same settings) with that count, then swap the page in
    const pages = Math.max(1, (Buffer.from(pdf.data, 'base64').toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length);
    await ctx.ev(`__docshot.print.pages = ${pages}; document.getElementById('print-paper').dispatchEvent(new Event('change', { bubbles: true })); 1`);
    await ctx.sleep(1200);
    await ctx.ev(`(function () {
      var stage = document.getElementById('print-stage'), old = stage.querySelector('embed');
      var e = document.createElement('embed');
      e.type = 'application/pdf'; e.className = 'print-embed';
      e.src = 'data:application/pdf;base64,${pdf.data}' + PrintPanel.viewHash('a4', false, stage.clientWidth);
      old.parentNode.replaceChild(e, old);
      return 1;
    })()`);
    await ctx.sleep(2500); // the viewer draws the page
    // Edge's PDF viewer puts a bar of its own above the page (45 px of the window), so the viewport has shrunk: give the window back its height
    await ctx.page.setInnerSize(1120, 720);
  },

  // Settings > AI Models > Semantic search, on, with a model on this PC and an index that is a little behind.
  async settingsSemantic(ctx) {
    await ctx.ev("(function(){ var k = __docshot.semanticIndex; k.index = { exists: true, chunks: 412, files: 53, size_bytes: 3355443, updated: '2026-09-18T09:40:00+09:00', new_files: 4, changed_files: 2, removed_files: 0, rebuild_needed: false, corrupt: false }; return 1; })()");
    await ctx.key(',', { ctrl: true });
    await ctx.waitFor("!document.getElementById('settings-modal').classList.contains('hidden')", { label: 'settings modal' });
    await ctx.ev("document.getElementById('tab-btn-model').click(); 1");
    await ctx.waitFor("!document.getElementById('pane-model').classList.contains('hidden')", { label: 'AI Models pane' });
    await ctx.ev("(function(){ var d = document.getElementById('cfg-semantic-enabled').closest('details'); if (d) d.open = true; var b = document.getElementById('cfg-semantic-enabled'); b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()");
    await ctx.waitFor("!document.getElementById('semantic-destination').classList.contains('hidden') && document.getElementById('semantic-index-status').textContent.indexOf('412') !== -1", { timeout: 8000, label: 'the index status' });
    await ctx.ev("(function(){ var e = document.getElementById('cfg-semantic-enabled'); e.scrollIntoView({ block: 'start' }); var p = document.getElementById('pane-model'); p.scrollTop = Math.max(0, p.scrollTop - 12); return 1; })()");
    await ctx.sleep(300);
  },

  async commandPalette(ctx) {
    await ctx.key('P', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden')", { label: 'command palette' });
    await ctx.sleep(200);
  },

  // About MD-Memo from the palette. The harness blocks the network, so the answer to "Check now" (a newer release) is faked here.
  async aboutDialog(ctx) {
    await aboutFixtures(ctx);
    await ctx.key('P', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('quick-pick-modal').classList.contains('hidden')", { label: 'command palette' });
    await ctx.sleep(300); // the field takes the focus a moment after the palette opens
    await ctx.type(ctx.pick('About MD', 'MD-Memo \u306b\u3064\u3044\u3066'));
    await ctx.waitFor("document.querySelectorAll('.quick-pick-item').length === 1", { label: 'the palette filtered to About' });
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('about-modal').classList.contains('hidden') && !!document.getElementById('about-check')", { label: 'About dialog' });
    await ctx.clickSel('#about-check');
    await ctx.waitFor("!!document.getElementById('about-release-notes')", { timeout: 6000, label: 'the update answer' });
    await ctx.sleep(200);
  },

  // The Help button's menu when a newer version is known: the version, the Release notes button, the manual and About.
  async helpMenuUpdate(ctx) {
    await aboutFixtures(ctx);
    await ctx.ev('window.__testHelper.checkForAppUpdates().then(function () { return true; })');
    await ctx.waitFor("!document.getElementById('help-update-badge').classList.contains('hidden')", { timeout: 6000, label: 'the update dot' });
    await ctx.clickSel('#btn-help');
    await ctx.waitFor("!document.getElementById('help-menu').classList.contains('hidden')", { label: 'help menu' });
    await ctx.sleep(200);
  },

  // The Ask AI bar with a cloud model: it names the destination and, the first time, asks before anything is sent.
  async askBarConsent(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('(function(){var a=__docshot.lineStart(3), b=__docshot.lineEnd(3); __docshot.setCaret(a,b);})()');
    await ctx.ev("(function(){var c=window.__testHelper.config.text; c.baseUrl='https://generativelanguage.googleapis.com'; c.model='gemini-flash-lite-latest'; c.apiKey='demo-key';})()");
    await ctx.key('l', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'ask bar' });
    await ctx.type(ctx.pick('Make this shorter', '\u3082\u3063\u3068\u77ed\u304f\u3057\u3066'));
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('inline-prompt-consent').classList.contains('hidden')", { timeout: 6000, label: 'the cloud question' });
    await ctx.sleep(300);
  },

  async mobileDropDialog(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await ctx.ev("(function(){var a=__docshot.find('Draft the API design'); if(a<0) a=__docshot.find('API 設計を下書きする'); var e=__docshot.editor().value.indexOf('\\n',a); __docshot.setCaret(a,e);})()");
    await ctx.key('U', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('mobile-drop-content').classList.contains('hidden') && !document.getElementById('mobile-drop-shared-preview').classList.contains('hidden')", { timeout: 6000, label: 'Mobile Drop dialog' });
    await ctx.ev("__docshot.pin('#mobile-drop-countdown', '60')");
  },

  // The phone page (pkg/dropzone/html.go) with a fake token; two files are put into its send tray.
  async mobileDropPhone(ctx) {
    await ctx.waitFor("!document.getElementById('sharedCard').classList.contains('hidden')", { timeout: 8000, label: 'Text from PC card' });
    const add = (name, size, type) => `(function(){
      var dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(${size})], ${JSON.stringify(name)}, {type:${JSON.stringify(type)}}));
      var input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`;
    await ctx.ev(add('IMG_2041.jpg', 1258291, 'image/jpeg'));
    await ctx.waitFor("document.getElementById('trayCount').textContent === '1'", { label: 'first tray item' });
    await ctx.ev(add('meeting-notes.md', 2150, 'text/markdown'));
    await ctx.waitFor("document.getElementById('trayCount').textContent === '2'", { label: 'two tray items' });
    await ctx.sleep(300);
  },

  async mobileDropPhoneSend(ctx) {
    await SETUPS.mobileDropPhone(ctx);
    await ctx.ev('window.scrollTo(0, document.documentElement.scrollHeight)');
    await ctx.sleep(300);
  },

  async settingsGeneral(ctx) {
    await openSettings(ctx, 'general');
  },

  async settingsModel(ctx) {
    await openSettings(ctx, 'model');
    await ctx.ev(scrollPaneTo('#cfg-voice-model', 'center'));
    await ctx.sleep(200);
  },

  // Settings > AI Models > Voice input, on Windows: the switch for recording the PC's sound too, with "Check audio devices" answered.
  async settingsVoiceMeeting(ctx) {
    await ctx.ev(`(function(){
      window.backend.meetingRecordingSupported = function () { return Promise.resolve(true); };
      window.backend.checkMeetingAudioAsync = function (id) { setTimeout(function () { window.__onMeetingAudioCheck(id, JSON.stringify({ supported: true, microphone: { ok: true, level: 0.02 }, system: { ok: true, level: 0 } })); }, 50); };
      window.__testHelper.config.voice.includeSystemAudio = true;
    })()`);
    await openSettings(ctx, 'model');
    await ctx.ev(scrollPaneTo('#cfg-voice-system-audio', 'center'));
    await ctx.sleep(300);
    await ctx.ev("document.getElementById('btn-check-meeting-audio').click()");
    await ctx.sleep(400);
  },

  // Settings > General, scrolled to "Updates & Privacy", with one cloud host already allowed (so the list and its Forget button show).
  async settingsUpdatesPrivacy(ctx) {
    await ctx.ev("(function(){ window.__testHelper.config.general.cloudConsent = { 'generativelanguage.googleapis.com': '2026-09-18' }; })()");
    await openSettings(ctx, 'general');
    await ctx.ev(scrollPaneTo('h4[data-i18n="sectionUpdatesPrivacy"]', 'center'));
    await ctx.sleep(250);
  },

  async settingsAgent(ctx) {
    await openSettings(ctx, 'agent');
    await ctx.ev(scrollPaneTo('#cfg-default-agent', 'center'));
    await ctx.sleep(200);
  },

  async settingsSync(ctx) {
    await openSettings(ctx, 'sync');
  },

  async settingsDiscord(ctx) {
    await openSettings(ctx, 'sync');
    await ctx.ev(scrollPaneTo('h4[data-i18n="sectionDiscordBridge"]', 'start'));
    await ctx.sleep(200);
  },

  async settingsShortcuts(ctx) {
    await shortcutsTab(ctx);
    await ctx.ev(`(function(){var b=Array.from(document.querySelectorAll('.shortcut-key-btn')).find(function(x){return x.textContent.trim()==='Ctrl+L';});b.scrollIntoView({block:'center'});})()`);
    // click the Ctrl+L row (Ask AI) to start recording
    const pos = await ctx.ev(`(function(){var b=Array.from(document.querySelectorAll('.shortcut-key-btn')).find(function(x){return x.textContent.trim()==='Ctrl+L';});var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await ctx.click(pos.x, pos.y);
    await ctx.waitFor("!!document.querySelector('.shortcut-key-btn.recording')", { label: 'recording state' });
    await ctx.ev("document.querySelector('.shortcut-key-btn.recording').scrollIntoView({block:'center'})");
    await ctx.sleep(200);
  },

  async settingsToolbar(ctx) {
    await openSettings(ctx, 'general');
    // The section folds like the others: open it (its rows are built when it opens).
    await ctx.ev("(function(){var d=document.getElementById('cfg-layout-details').closest('details.settings-section');d.open=true;d.dispatchEvent(new Event('toggle'));})()");
    await ctx.waitFor("document.querySelectorAll('#cfg-layout-toolbar .layout-row, #cfg-layout-toolbar > *').length > 0", { label: 'layout rows' });
    await ctx.ev(scrollPaneTo('details.settings-section:has(#cfg-layout-details) > summary', 'start'));
    await ctx.sleep(300);
  },

  async shortcutConflict(ctx) {
    await shortcutsTab(ctx);
    const pos = await ctx.ev(`(function(){var b=Array.from(document.querySelectorAll('.shortcut-key-btn')).find(function(x){return x.textContent.trim()==='Ctrl+L';});b.scrollIntoView({block:'center'});var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await ctx.click(pos.x, pos.y);
    await ctx.waitFor("!!document.querySelector('.shortcut-key-btn.recording')", { label: 'recording state' });
    // keep the row being edited visible below the dialog
    await ctx.ev("document.querySelector('.shortcut-key-btn.recording').scrollIntoView({block:'end'})");
    await ctx.key('j', { ctrl: true }); // already assigned to Suggest Quick Actions
    await ctx.waitFor("!document.getElementById('confirm-modal').classList.contains('hidden')", { label: 'overwrite confirmation' });
    await ctx.sleep(200);
  },

  // Settings -> Export...: the package dialog is taller than the window and scrolls inside, so it is shown twice
  // (top: format and settings sections; bottom: agents, skills, options). Two of the three skills are ticked.
  async packExport(ctx) {
    await openPackExport(ctx);
    await packScroll(ctx, 'top');
  },

  async packExportItems(ctx) {
    await openPackExport(ctx);
    await packScroll(ctx, 'bottom');
  },

  // Settings -> Import...: the native file dialog is skipped by the mock, which answers with a demo package.
  async packImport(ctx) {
    await openPackImport(ctx);
    await packScroll(ctx, 'top');
  },

  async packImportItems(ctx) {
    await openPackImport(ctx);
    await packScroll(ctx, 'bottom');
  },

  // Settings -> Import..., after Import, for a package that also changes where text goes and what runs unasked: a model server,
  // the agent confirmation, the Discord bridge and the hot folder are listed with before -> after and start unticked. The mock's
  // canned package has none of these, so both answers are replaced here by a partner's package.
  async packImportReview(ctx) {
    await ctx.ev(`(function(){
      var sections = ['models', 'integration', 'other'];
      // a key saved for the current server, so the picture shows that a new server takes it away (a fake one, never displayed)
      MdMemoBridge.getConfig().text.apiKey = 'DEMO-KEY-NOT-REAL-0000';
      var cfg = {
        text: { baseUrl: 'https://llm.partner-gateway.example/v1', model: 'partner-model', apiKey: '' },
        autoSelector: { enabled: true, agentConfirm: false },
        discordBridge: { enabled: true, botToken: '', allowedUserId: '482915637201', pollIntervalSeconds: 45 },
        inbox: { enabled: true, dir: 'D:/partner/inbox' }
      };
      window.backend.packInspect = function () {
        return Promise.resolve(JSON.stringify({
          packPath: 'C:/Users/demo/Desktop/partner-gateway.mdmemopack', legacy: false, projectRoot: '',
          manifest: { format: 'md-memo-pack', version: 1, createdAt: '2026-09-18T09:40:00+09:00', appVersion: '1.10.5', includesSecrets: false, configSections: sections, items: [] },
          items: [{ id: 'config', kind: 'config', sections: sections }], warnings: []
        }));
      };
      window.backend.packImport = function () {
        return Promise.resolve(JSON.stringify({ ok: true, configJSON: JSON.stringify(cfg), configSections: sections, applied: { agents: [], skills: [] }, backupDir: '', skipped: [], needsRestart: false }));
      };
    })()`);
    await openSettings(ctx, 'general');
    await ctx.clickSel('#btn-import-settings');
    await ctx.waitFor("!document.getElementById('pack-modal').classList.contains('hidden') && document.querySelectorAll('#pack-body .pack-row').length === 3", { label: 'import dialog of the partner package' });
    await ctx.clickSel('#pack-confirm');
    await ctx.waitFor("document.querySelectorAll('#pack-body .pack-row').length === 4", { label: 'the review step' });
    await ctx.sleep(250);
  },

  async contextMenu(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('(function(){var a=__docshot.lineStart(3), b=__docshot.lineEnd(3); __docshot.setCaret(a,b);})()');
    await ctx.ev(`(function(){
      var ed = __docshot.editor();
      ed.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX:470, clientY:118}));
    })()`);
    await ctx.waitFor("!document.getElementById('context-menu').classList.contains('hidden')", { label: 'context menu' });
    await ctx.sleep(200);
  },

  async taskPanel(ctx) {
    const t1 = ctx.pick('Turn the checklist above into three release note bullets', '上のチェックリストからリリースノートの要点を 3 行で書く');
    const t2 = ctx.pick('Proofread the meeting notes and list open questions', '会議メモを校正して未解決の質問を挙げる');
    await ctx.ev(`(function(){
      var now = Date.now();
      __docshot.peek = {t_demo_1: ${JSON.stringify(ctx.pick('Reading the note... drafting bullet 2 of 3', 'ノートを読み込み中... 3 行中 2 行目を作成')) }, t_demo_2: ${JSON.stringify(ctx.pick('Checking names and dates against the schedule', 'スケジュールと名前・日付を照合中'))}};
      TaskManager.addTask({id:'t_demo_1', type:'slot', agent:'claude-code', instruction:${JSON.stringify(t1)}, startTime: now - 42000, onCancel:function(){}});
      TaskManager.addTask({id:'t_demo_2', type:'slot', agent:'hermes', instruction:${JSON.stringify(t2)}, startTime: now - 15000, onCancel:function(){}});
    })()`);
    await ctx.key('t', { alt: true });
    await ctx.waitFor("!document.getElementById('running-tasks-panel').classList.contains('hidden') && document.querySelectorAll('.task-card-running').length === 2", { label: 'task panel' });
    await ctx.sleep(1400); // one poll fills the live output lines
  },

  // Lessons, the task panel: two finished delegated tasks of the agent "claude". The newer one (on top) failed and has the Lessons button; the
  // older one (below) finished and says that two lessons went into its instruction (its button is there too: a finished run offers it as well).
  // The cards are made the way slot_agent.js makes them when a run ends (TaskManager.addTask, then updateTask with the result), with their own
  // start times so that the two durations differ; only the panel (Alt+T) is a real key. The status bar's "finished" badge, which stays for 4 s,
  // is waited out so that the picture does not depend on the timing.
  async lessonsCard(ctx) {
    await lessonsDemoAgent(ctx);
    await lessonsDemoCards(ctx);
    await ctx.key('t', { alt: true });
    await ctx.waitFor("!document.getElementById('running-tasks-panel').classList.contains('hidden') && document.querySelectorAll('#tasks-panel-list .btn-task-lessons').length === 2 && document.querySelectorAll('#tasks-panel-list .task-lessons-line').length === 1", { label: 'task panel with the two finished cards' });
    await ctx.waitFor("document.getElementById('stat-tasks').classList.contains('hidden')", { timeout: 9000, label: 'the finished badge of the status bar is gone' });
    await ctx.waitFor("document.querySelectorAll('#tasks-panel-list .btn-task-lessons').length === 2", { label: 'the list drawn again' });
    await ctx.move(120, 640);
    await ctx.sleep(300);
  },

  // Lessons, the dialog: opened with a real click on the Lessons button of the failed card, "Create a proposal" pressed with a real click (the
  // mock answers with two rules in the language of the picture; the model is the demo's own text model on this PC, so there is no consent box),
  // the first rule retyped a little in its field, both rules left ticked, the pointer parked outside the panel.
  async lessonsDialog(ctx) {
    const [rule1, rule1Edited, rule2] = ctx.pick(
      ['Do not include ADF.h: the build fails on this machine.', 'Do not include ADF.h: it is not installed on this machine.', 'Run the build with --no-color: a program reads the log.'],
      ['ADF.h は読み込まない。このマシンではビルドが通らない。', 'ADF.h は読み込まない。このマシンには入っていない。', 'ビルドは --no-color を付けて実行する。ログはプログラムが読む。']);
    await lessonsDemoAgent(ctx);
    await ctx.ev(`(function(){ var L = __docshot.lessons; L.rules = ${JSON.stringify([rule1, rule2])}; L.masked = 0; L.count = 0; return 1; })()`);
    await lessonsDemoCards(ctx);
    await ctx.key('t', { alt: true });
    await ctx.waitFor("!document.getElementById('running-tasks-panel').classList.contains('hidden') && !!document.querySelector('#tasks-panel-list [data-lessons-id=\"lesson_demo_failed\"]')", { label: 'task panel with the failed card' });
    await ctx.waitFor("document.getElementById('stat-tasks').classList.contains('hidden')", { timeout: 9000, label: 'the finished badge of the status bar is gone' });
    await ctx.waitFor("!!document.querySelector('#tasks-panel-list [data-lessons-id=\"lesson_demo_failed\"]')", { label: 'the list drawn again' });
    await ctx.clickSel('#tasks-panel-list [data-lessons-id="lesson_demo_failed"]');
    await ctx.waitFor("!document.getElementById('lesson-modal').classList.contains('hidden') && !document.getElementById('lesson-prepare').classList.contains('hidden') && !document.getElementById('lesson-primary').disabled", { timeout: 8000, label: 'the lessons dialog, ready to create a proposal' });
    await ctx.clickSel('#lesson-primary');
    await ctx.waitFor("!document.getElementById('lesson-result').classList.contains('hidden') && document.querySelectorAll('#lesson-rules .lesson-rule').length === 2 && document.activeElement && document.activeElement.id === 'lesson-rule-input-0'", { timeout: 8000, label: 'two proposed rules, the first field focused' });
    await ctx.key('a', { ctrl: true });
    await ctx.type(rule1Edited);
    await ctx.waitFor(`document.getElementById('lesson-rule-input-0').value === ${JSON.stringify(rule1Edited)}`, { label: 'the first rule retyped' });
    // the pointer rests outside the panel, so that no button is drawn in its hover state
    await ctx.move(980, 250);
    await ctx.sleep(400);
  },

  // B2: twelve tabs. "+" and the All tabs button stay at the right of the strip; the newest tab is in view; the left edge fades.
  async tabsOverflow(ctx) {
    await openManyTabs(ctx, 12);
    await quietStatus(ctx);
  },

  // The same at the smallest window: the strip gets what the toolbar leaves.
  async tabsOverflowNarrow(ctx) {
    await openManyTabs(ctx, 12);
    await quietStatus(ctx);
  },

  // The All tabs list: opened with a real click, the highlight moved with the arrow keys.
  async tabsAllList(ctx) {
    await openManyTabs(ctx, 12);
    await quietStatus(ctx);
    await ctx.clickSel('#btn-all-tabs');
    await ctx.waitFor("!document.getElementById('tab-list-panel').classList.contains('hidden')", { label: 'all tabs list' });
    await ctx.key('ArrowUp');
    await ctx.key('ArrowUp');
    await ctx.key('ArrowUp');
    await ctx.sleep(300);
  },

  // A5: the header of a profile with nothing saved (the boot flag fresh=1 hides the saved config).
  async headerCalm(ctx) {
    await quietStatus(ctx);
  },

  // B5: the AI item of the status bar, opened with a real click: Text prediction, Suggestions and Voice tidy-up as switches.
  async statusAiPopover(ctx) {
    await pillsReady(ctx);
    await quietStatus(ctx);
    await ctx.clickSel('#stat-ai');
    await ctx.waitFor("!document.getElementById('status-ai-pop').classList.contains('hidden')", { label: 'AI popover' });
    await ctx.sleep(300);
  },

  // A2: no model can answer (boot nomodel=1): the AI item is amber and says "not set up".
  async statusAiUnset(ctx) {
    await pillsReady(ctx);
    await ctx.ev("(function(){var s=document.createElement('style');s.textContent='#editor{color:transparent!important} #line-numbers{visibility:hidden}';document.head.appendChild(s);})()");
    await quietStatus(ctx);
  },

  // Review repair: the blue theme has the lightest bar. The AI item says "not set up" (boot nomodel=1), the Git button is in error, and the keyboard focus ring
  // (white, inside the button) is on the encoding button. A real key press first, so that the browser draws the ring for keyboard focus.
  async statusBarFocusBlue(ctx) {
    await pillsReady(ctx);
    await ctx.ev("(function(){var s=document.createElement('style');s.textContent='#editor{color:transparent!important} #line-numbers{visibility:hidden}';document.head.appendChild(s);})()");
    await ctx.ev("(function(){document.body.classList.remove('theme-olive','theme-forest','theme-charcoal');document.body.classList.add('theme-blue');var c=window.__testHelper.config;if(c.scraps)c.scraps.gitSyncEnabled=true;window.__testHelper.updateGitSyncStatusUI({status:'error',message:'push failed'});return true;})()");
    await quietStatus(ctx);
    await ctx.key('Tab');
    await ctx.ev("document.getElementById('stat-encoding').focus()");
  },

  // UX review B13: Enter in the Find box goes to the next match and the focus STAYS in the box; the current match is drawn behind the text.
  async findBarMatch(ctx) {
    await ctx.ev('__docshot.scrollToLine(1, 0)');
    await ctx.ev('__docshot.setCaret(0, 0)');
    await ctx.key('f', { ctrl: true });
    await ctx.waitFor("!document.getElementById('find-replace-bar').classList.contains('hidden')", { label: 'find bar' });
    await ctx.type('API');
    await ctx.waitFor("/\\/(\\d\\d+|[2-9])$/.test(document.getElementById('find-count').textContent.trim())", { label: 'the matches counted' });
    await ctx.key('Enter');
    await ctx.key('Enter');
    await ctx.waitFor("document.querySelectorAll('.find-match-rect').length > 0 && document.activeElement.id === 'find-input'", { label: 'the current match drawn, the focus still in the box' });
    await quietStatus(ctx);
  },

  // UX review B20: a dangerous command asks first, and the question defaults to Cancel.
  async riskyCommandConfirm(ctx) {
    await ctx.ev(`window.backend.validateCliCommand = function (cmd) { return Promise.resolve({ isSafe: false, isWarning: true, isBlocked: false, reason: ${JSON.stringify(ctx.pick('This deletes files and folders.', 'ファイルとフォルダを削除します。'))}, command: cmd }); }`);
    await ctx.ev('__docshot.editor().focus()');
    await ctx.key('e', { ctrl: true });
    await ctx.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden')", { label: 'command bar' });
    await ctx.type('rm -r build');
    await ctx.key('Enter');
    await ctx.waitFor("!document.getElementById('confirm-modal').classList.contains('hidden') && document.activeElement.id === 'confirm-modal-cancel'", { label: 'the question, Cancel focused' });
    await ctx.sleep(200);
  },

  async zenMode(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('F11', { shift: true });
    await ctx.waitFor("document.body.classList.contains('zen-mode')", { label: 'zen mode' });
    await ctx.ev("__docshot.pin('#stat-message')");
  },
};
