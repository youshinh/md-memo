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

  // The recording indicator at the bottom left. A silent stand-in replaces the microphone (and the silence timeout is long, so
  // the recording does not stop by itself); the indicator is drawn by the application's own voice input code.
  async voiceIndicator(ctx) {
    await ctx.ev("(function(){var c=MdMemoBridge.getConfig();c.voice=c.voice||{};c.voice.silence_timeout_sec=120;var ac=new (window.AudioContext||window.webkitAudioContext)();navigator.mediaDevices.getUserMedia=function(){return Promise.resolve(ac.createMediaStreamDestination().stream);};return true;})()");
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.ev('__docshot.editor().focus()');
    await ctx.ev('VoiceInput.toggle()');
    await ctx.waitFor("(function(){var e=document.querySelector('.voice-indicator .voice-elapsed');return !!e && e.textContent==='3s';})()", { timeout: 15000, label: 'recording indicator at 3 s' });
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
    await ctx.ev("(function(){var d=document.getElementById('cfg-layout-details');d.open=true;d.dispatchEvent(new Event('toggle'));})()");
    await ctx.waitFor("document.querySelectorAll('#cfg-layout-toolbar .layout-row, #cfg-layout-toolbar > *').length > 0", { label: 'layout rows' });
    await ctx.ev(scrollPaneTo('#cfg-layout-details', 'start'));
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
