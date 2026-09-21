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
  await ctx.sleep(600); // provider / Ollama / Git status lines resolve asynchronously
}

const scrollPaneTo = (sel, block = 'start') =>
  `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.scrollIntoView({block:${JSON.stringify(block)}});return true;})()`;

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
    await ctx.key('k', { ctrl: true });
    await ctx.waitFor("!document.getElementById('inline-prompt-bar').classList.contains('hidden')", { label: 'inline prompt bar' });
    await ctx.type(ctx.pick('Rewrite this in a friendlier tone', 'もう少し親しみやすい文体に書き直して'));
    // Hand focus back to the note so the selection shows in its active colour (the bar keeps its text).
    await ctx.ev('__docshot.editor().focus()');
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
      ed.dispatchEvent(new KeyboardEvent('keydown', {key:'V', code:'KeyV', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true}));
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
    await ctx.ev("MdMemoBridge.insertTextWithUndo('\\u2985音声入力中... [id:a1b2]\\u2986', __docshot.editor())");
  },

  async voiceRescue(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Enter');
    await ctx.ev("MdMemoBridge.insertTextWithUndo('\\u2985文字起こし失敗: [再試行(id:a1b2)] [音声保存] [破棄]\\u2986', __docshot.editor())");
  },

  async cliBar(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, 20);
    await ctx.key('B', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden')", { label: 'CLI bar' });
    await ctx.type('sort -u');
  },

  async aiCliBar(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, 20);
    await ctx.key('E', { ctrl: true, shift: true });
    await ctx.waitFor("!document.getElementById('cli-filter-bar').classList.contains('hidden')", { label: 'AI CLI bar' });
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
    await ctx.waitFor("__docshot.editor().classList.contains('slot-ghost-diff')", { label: 'ghost diff glow' });
    // Freeze the animation ~300 ms into a default 4 s run (the demo config uses 8 s, so scale the time).
    await ctx.ev(`(function(){var ed=__docshot.editor();var d=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ghost-diff-duration'))||4000;ed.getAnimations().forEach(function(a){a.pause();a.currentTime=300*d/4000;});return d;})()`);
    await ctx.sleep(400); // let the line-number gutter catch up with the inserted lines
    await ctx.ev('__docshot.scrollToLine(30, 4)');
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

  async settingsAgent(ctx) {
    await openSettings(ctx, 'agent');
    await ctx.ev(scrollPaneTo('#cfg-default-agent', 'center'));
    await ctx.sleep(200);
  },

  async settingsSync(ctx) {
    await openSettings(ctx, 'sync');
  },

  async settingsShortcuts(ctx) {
    await shortcutsTab(ctx);
    await ctx.ev(`(function(){var b=Array.from(document.querySelectorAll('.shortcut-key-btn')).find(function(x){return x.textContent.trim()==='Ctrl+L';});b.scrollIntoView({block:'center'});})()`);
    // click the Ctrl+L row (LLM prompt modal) to start recording
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
    await ctx.key('k', { ctrl: true }); // already assigned to the inline AI prompt
    await ctx.waitFor("!document.getElementById('confirm-modal').classList.contains('hidden')", { label: 'overwrite confirmation' });
    await ctx.sleep(200);
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

  async zenMode(ctx) {
    await ctx.ev('__docshot.scrollToLine(14, 0)');
    await caretAtEndOf(ctx, MAIN_LINES.checklistLast);
    await ctx.key('Z', { ctrl: true, shift: true });
    await ctx.waitFor("document.body.classList.contains('zen-mode')", { label: 'zen mode' });
    await ctx.ev("__docshot.pin('#stat-message')");
  },
};
