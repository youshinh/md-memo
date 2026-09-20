// MD-Memo Autonomous AI Agent Slot & Pipeline Mechanism (v2.2.0-aligned)
// Architecture:
// - AST Lexical Shield (0ns Bypass)
// - Auto-IME Normalization
// - Non-blocking Quick Selector (0ms typing hindrance)
// - Caret-Preserving Debounced Merger
// - Ghost Diff & Local Revert (Esc)
// - Human-in-the-Loop Approval Gates

(function (global) {
  'use strict';

  let slotConfig = {
    version: 2,
    default_agent: "claude-code",
    timeout_seconds: 180,
    hover_peek_enabled: true,
    ghost_diff_duration_ms: 4000,
    agents: {
      "claude-code": {
        command: "claude",
        args: ["--file", "{file}", "--prompt", "{instruction}"],
        description: "Claude Code (高知能・CLI操作・Web調査)"
      },
      "hermes": {
        command: "ollama",
        args: ["run", "hermes3", "{instruction}"],
        description: "Hermes 3 (完全ローカル・機密保護)"
      },
      "codex": {
        command: "codex",
        args: ["--execute", "--file", "{file}"],
        description: "Codex (高速コード補完・リファクタリング)"
      },
      "agy": {
        command: "agy",
        args: ["-p", "対象ノート: {file}\n指示: {instruction}", "--dangerously-skip-permissions"],
        description: "Google Antigravity 2.0 (自律リポジトリ開発)"
      }
    },
    slot_profiles: [
      {
        trigger_open: "{{",
        trigger_close: "}}",
        name: "code",
        agent: "claude-code",
        system_instruction: "前置きや挨拶を一切省き、そのまま動くコードブロックのみを出力してください。"
      },
      {
        trigger_open: "[?",
        trigger_close: "]",
        name: "research",
        agent: "claude-code",
        system_instruction: "Web検索を行い、客観的な数値と一次ソースURLを併記して簡潔に回答してください。"
      },
      {
        trigger_open: "【?",
        trigger_close: "】",
        name: "writing",
        agent: "hermes",
        system_instruction: "外部通信を行わず、論理的で分かりやすいビジネス日本語の箇条書きに整形してください。"
      },
      {
        trigger_open: "[!",
        trigger_close: "!]",
        name: "adversarial",
        agent: "claude-code",
        system_instruction: "甘口の肯定を排し、潜在的リスク、セキュリティ脆弱性、ボトルネックを3点指摘してください。"
      }
    ],
    recipes: [
      {
        trigger_open: "[>>",
        trigger_close: "]",
        name: "deep-research-and-code",
        description: "Web調査 -> リスク反証 -> 実装コード生成",
        steps: [
          "Web検索ツールを用いて最新の公式仕様とベストプラクティスを調査する",
          "調査結果に基づき、潜在的な移行リスクと破壊的変更を指摘する",
          "上記を踏まえ、完全なGoコードを生成する"
        ],
        requires_approval_step: 2,
        self_refine: true
      }
    ]
  };

  // State
  let activeRequests = new Map(); // reqId -> meta { reqId, startOffset, endOffset, oldContent, executingText, openD, closeD }
  let lastTypingTime = 0;
  let pendingMergeQueue = [];
  let mergeDebounceTimer = null;
  let selectorEl = null;
  let selectorSelectedIndex = 0;
  let selectorTriggerInfo = null; // { open, close, startPos }
  let runButtonEl = null;
  let runButtonEditor = null; // the editor the currently-shown button targets
  let runButtonTimer = null; // debounce for the cheap caret-position scan
  let ghostDiffTimeouts = new Map(); // slotKey -> { revertInfo, timer }
  let slotUndoHistory = []; // { reqId, oldContent, newContent, timestamp }

  // Generates a request id as `${prefix}${Date.now()}-${random}`. Keep passing
  // the existing 'slot-' prefix/dash style unchanged in case anything downstream
  // keys off it; only the random-suffix boilerplate is deduplicated here.
  function genReqId(prefix) {
    return prefix + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  }

  // Safe Range Replacement preserving Browser Native Undo/Redo history
  function replaceRangeWithUndo(editor, start, end, replacement) {
    if (!editor) return false;
    editor.focus();
    editor.setSelectionRange(start, end);
    let success = false;
    try {
      success = document.execCommand('insertText', false, replacement);
    } catch (e) {
      success = false;
    }
    if (!success) {
      const text = editor.value;
      editor.value = text.substring(0, start) + replacement + text.substring(end);
      editor.setSelectionRange(start + replacement.length, start + replacement.length);
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // 1. AST Lexical Shield (0ns code block / inline code / url bypass)
  function isInsideCode(text, cursor) {
    if (cursor <= 0 || !text) return false;

    // A. Check code block fences
    const prefix = text.substring(0, cursor);
    const codeFenceCount = (prefix.match(/```/g) || []).length;
    if (codeFenceCount % 2 !== 0) {
      return true; // Inside code block
    }

    // B. Check inline code
    const lineStart = prefix.lastIndexOf('\n') + 1;
    const currentLinePrefix = prefix.substring(lineStart);
    const inlineTickCount = (currentLinePrefix.match(/`/g) || []).length;
    if (inlineTickCount % 2 !== 0) {
      return true; // Inside inline code
    }

    return false;
  }

  function isInsideCodeOrUrl(text, cursor) {
    if (isInsideCode(text, cursor)) return true;

    // Check Markdown link or URL for quick selector typing
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const currentLinePrefix = text.substring(lineStart, cursor);

    // If currently inside an open slot trigger (e.g. {{, [?, 【?, [!), URL is part of prompt
    if (/(\{\{|\[\?|【\?|\[!|\[>>)[^}\]]*$/.test(currentLinePrefix)) {
      return false;
    }

    const linkMatch = currentLinePrefix.match(/\[[^\]]*\]\([^)]*$/);
    if (linkMatch) {
      return true; // Inside link url target
    }
    const urlMatch = currentLinePrefix.match(/https?:\/\/[^\s\]]+$/);
    if (urlMatch) {
      return true; // Inside bare URL
    }

    return false;
  }

  // 2. Auto-IME Normalization
  function normalizeIMESlotTrigger(editor, cachedPos, cachedText) {
    if (!editor) return false;
    const pos = (cachedPos !== undefined) ? cachedPos : editor.selectionStart;
    const text = (cachedText !== undefined) ? cachedText : editor.value;
    if (pos < 2) return false;

    // Check last 2 fullwidth chars
    const twoChars = text.substring(pos - 2, pos);
    let replaced = null;

    if (twoChars === '｛｛') {
      replaced = '{{';
    } else if (twoChars === '［？') {
      replaced = '[?';
    } else if (twoChars === '【？') {
      replaced = '【?';
    }

    if (replaced) {
      replaceRangeWithUndo(editor, pos - 2, pos, replaced);
      editor.selectionStart = editor.selectionEnd = pos;
      return true;
    }
    return false;
  }

  // 3. Non-blocking Quick Selector UI
  function initSelectorDOM() {
    if (selectorEl) return;
    selectorEl = document.createElement('div');
    selectorEl.id = 'slot-quick-selector';
    selectorEl.className = 'hidden';
    document.body.appendChild(selectorEl);
  }

  // A user who has never discovered Ctrl+Enter has no way to know a fully-written
  // {{ ... }} block is actually runnable - especially one a Quick Actions candidate
  // just inserted, which auto-runs on its own but gives no visible cue that it did.
  // This floating button appears next to a complete, not-already-running slot whenever
  // the caret sits inside it, as a discoverable alternative to the keyboard shortcut.
  function initRunButtonDOM() {
    if (runButtonEl) return;
    runButtonEl = document.createElement('button');
    runButtonEl.id = 'slot-run-button';
    runButtonEl.type = 'button';
    runButtonEl.className = 'hidden';
    runButtonEl.addEventListener('mousedown', (e) => {
      // Prevent the editor from losing focus/selection before the click fires.
      e.preventDefault();
    });
    runButtonEl.addEventListener('click', () => {
      const editor = runButtonEditor;
      hideRunButton();
      if (editor) triggerSlotExecution(editor);
    });
    document.body.appendChild(runButtonEl);
    applyRunButtonLabel();
  }

  function applyRunButtonLabel() {
    if (!runButtonEl) return;
    const lang = getUILang();
    const dict = (typeof I18N !== 'undefined' && I18N[lang]) || (typeof I18N !== 'undefined' && I18N.ja) || {};
    const mod = (global.MDMemoPlatform && global.MDMemoPlatform.isMac) ? 'Cmd' : 'Ctrl';
    const key = mod + '+Enter';
    runButtonEl.textContent = '▶ ' + (dict.slotRunButtonLabel || '実行');
    const tooltipTpl = dict.slotRunButtonTooltip || 'このスロットを実行 ({key})';
    runButtonEl.title = tooltipTpl.replace('{key}', key);
  }

  // All open/close delimiter pairs currently configured (slot profiles + recipes),
  // falling back to the factory defaults. Mirrors jev_action.js's own
  // getConfiguredTriggerOpens/getDefaultProfileDelimiters (kept as a separate local
  // copy, same as this file's other config-derived helpers, so it works standalone).
  function getConfiguredDelimiterPairs() {
    const pairs = [];
    (slotConfig.slot_profiles || []).forEach((p) => {
      if (p && p.trigger_open && p.trigger_close) pairs.push({ open: p.trigger_open, close: p.trigger_close });
    });
    (slotConfig.recipes || []).forEach((r) => {
      if (r && r.trigger_open && r.trigger_close) pairs.push({ open: r.trigger_open, close: r.trigger_close });
    });
    if (pairs.length) return pairs;
    return [{ open: '{{', close: '}}' }, { open: '[?', close: ']' }, { open: '【?', close: '】' }, { open: '[!', close: '!]' }, { open: '[>>', close: ']' }];
  }

  // Cheap, client-side heuristic for "is the caret inside a complete, not-yet-running
  // slot block?" - a bounded nearest-open/nearest-close scan, not the authoritative
  // parser (that's Go's slotagent.ParseSlots, called via parseSlotsRPC only when the
  // button/Ctrl+Enter is actually used, exactly as before this feature). A false
  // positive here just means a click that politely reports "no slot found" instead of
  // running anything; it can never suppress a real slot that IS there.
  const RUN_BUTTON_SCAN_WINDOW = 4000;

  function findEnclosingSlotSpan(text, cursor) {
    const pairs = getConfiguredDelimiterPairs();
    const searchStart = Math.max(0, cursor - RUN_BUTTON_SCAN_WINDOW);
    const searchEnd = Math.min(text.length, cursor + RUN_BUTTON_SCAN_WINDOW);
    let best = null;

    for (const pair of pairs) {
      // The nearest open delimiter at/before the cursor is the only one that can be
      // this slot's own: an earlier open would have been closed (or be nested) by then.
      const openIdx = text.lastIndexOf(pair.open, cursor);
      if (openIdx === -1 || openIdx < searchStart) continue;
      // Its closing delimiter is the first one after it - which may sit BEFORE the
      // cursor (caret parked right after the block, exactly where a Quick Actions
      // insert or finishing typing '}}' leaves it) or after it (caret inside).
      const afterOpen = openIdx + pair.open.length;
      const relativeCloseIdx = text.substring(afterOpen, searchEnd).indexOf(pair.close);
      if (relativeCloseIdx === -1) continue;
      const closeIdx = afterOpen + relativeCloseIdx;
      const endOffset = closeIdx + pair.close.length;
      // Inside the block, or touching either edge; strictly outside means a different
      // (already-closed) slot's tail or plain text.
      if (cursor < openIdx || cursor > endOffset) continue;

      const raw = text.substring(openIdx, endOffset);
      if (raw.includes('実行中')) continue; // already running: nothing to offer

      // Prefer the smallest (innermost) enclosing span across delimiter kinds.
      if (!best || (endOffset - openIdx) < (best.endOffset - best.startOffset)) {
        best = { startOffset: openIdx, endOffset: endOffset };
      }
    }
    return best;
  }

  function hideRunButton() {
    if (runButtonEl) runButtonEl.className = 'hidden';
    runButtonEditor = null;
  }

  function updateRunButton(editor) {
    // The quick selector takes priority; never show both floating elements at once.
    if (selectorEl && selectorEl.classList.contains('active')) {
      hideRunButton();
      return;
    }
    if (!editor || document.activeElement !== editor) {
      hideRunButton();
      return;
    }
    const text = editor.value;
    const cursor = editor.selectionStart;
    if (editor.selectionStart !== editor.selectionEnd || isInsideCode(text, cursor)) {
      hideRunButton();
      return;
    }
    const span = findEnclosingSlotSpan(text, cursor);
    if (!span) {
      hideRunButton();
      return;
    }
    if (!runButtonEl) initRunButtonDOM();
    runButtonEditor = editor;
    runButtonEl.className = 'active';

    // Same page-coordinate conversion showQuickSelector uses: getCharPixelCoords
    // returns offsets within the (off-screen) measurement mirror, which share the
    // editor's own font/line metrics but need the editor's real bounding rect and
    // scroll position added to become actual viewport coordinates.
    let coords = { top: 100, left: 100 };
    if (typeof global.getCharPixelCoords === 'function') {
      coords = global.getCharPixelCoords(span.endOffset, editor);
    }
    const rect = editor.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 140, Math.max(10, rect.left + coords.left - editor.scrollLeft));
    const y = Math.min(window.innerHeight - 40, rect.top + coords.top - editor.scrollTop + 22);
    runButtonEl.style.left = `${x}px`;
    runButtonEl.style.top = `${y}px`;
  }

  function scheduleRunButtonUpdate(editor) {
    clearTimeout(runButtonTimer);
    runButtonTimer = setTimeout(() => updateRunButton(editor), 150);
  }

  function getAvailablePresets() {
    const presets = [];
    let idx = 1;

    // Slot profiles
    if (slotConfig.slot_profiles) {
      slotConfig.slot_profiles.forEach(p => {
        presets.push({
          numKey: idx <= 9 ? String(idx++) : '',
          type: 'slot',
          role: p.name,
          agent: p.agent,
          open: p.trigger_open,
          close: p.trigger_close,
          desc: p.system_instruction ? (p.system_instruction.substring(0, 24) + '...') : p.name
        });
      });
    }

    // Recipes
    if (slotConfig.recipes) {
      slotConfig.recipes.forEach(r => {
        presets.push({
          numKey: idx <= 9 ? String(idx++) : '',
          type: 'recipe',
          role: r.name,
          agent: slotConfig.default_agent || 'claude-code',
          open: r.trigger_open,
          close: r.trigger_close,
          desc: r.description || 'パイプラインレシピ'
        });
      });
    }

    return presets;
  }

  function showQuickSelector(editor, triggerOpen, openStartPos) {
    initSelectorDOM();
    const presets = getAvailablePresets();
    if (presets.length === 0) return;

    selectorTriggerInfo = {
      open: triggerOpen,
      startPos: openStartPos
    };
    selectorSelectedIndex = 0;

    renderSelectorList(presets);

    // Calculate position under caret
    let coords = { top: 100, left: 100 };
    if (typeof global.getCharPixelCoords === 'function') {
      coords = global.getCharPixelCoords(openStartPos, editor);
    }
    const rect = editor.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 380, Math.max(10, rect.left + coords.left - editor.scrollLeft));
    const y = Math.min(window.innerHeight - 200, rect.top + coords.top - editor.scrollTop + 22);

    selectorEl.style.left = `${x}px`;
    selectorEl.style.top = `${y}px`;
    selectorEl.classList.remove('hidden');
    selectorEl.classList.add('active');
  }

  function renderSelectorList(presets) {
    if (!selectorEl) return;
    let html = `
      <div class="slot-selector-header">
        <span>エージェントに任せる</span>
        <span style="font-size: 10px; opacity: 0.6;">↑/↓ 移動 • Enter/Tab/1-9 確定 • Esc 閉じる</span>
      </div>
      <ul class="slot-selector-list">
    `;

    presets.forEach((p, idx) => {
      const isSel = idx === selectorSelectedIndex ? 'selected' : '';
      const keyBadge = p.numKey ? `<span class="slot-item-key">${p.numKey}</span>` : '';
      const typeTag = p.type === 'recipe' ? '<span style="color:#e5c07b;font-size:10px;margin-right:4px;">[RECIPE]</span>' : '';
      html += `
        <li class="slot-selector-item ${isSel}" data-index="${idx}">
          ${keyBadge}
          ${typeTag}
          <span class="slot-item-role">${p.role}:</span>
          <span class="slot-item-desc">${p.desc}</span>
        </li>
      `;
    });

    html += `</ul>`;
    selectorEl.innerHTML = html;

    // Attach click events
    selectorEl.querySelectorAll('.slot-selector-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const index = parseInt(item.getAttribute('data-index'), 10);
        commitPreset(presets[index]);
      });
    });
  }

  function hideQuickSelector() {
    if (selectorEl) {
      selectorEl.classList.add('hidden');
      selectorEl.classList.remove('active');
    }
    selectorTriggerInfo = null;
  }

  function commitPreset(preset) {
    const editor = getActiveEditor();
    if (!editor || !preset) return;

    const pos = editor.selectionStart;
    const text = editor.value;

    let triggerLen = 0;
    let insertStart = pos;

    if (selectorTriggerInfo && selectorTriggerInfo.startPos <= pos) {
      insertStart = selectorTriggerInfo.startPos;
      triggerLen = pos - insertStart;
    }

    const openTag = preset.open;
    const closeTag = preset.close;
    const rolePrefix = `${preset.role}: `;
    const insertion = `${openTag} ${rolePrefix}`;
    const fullSnippet = `${insertion} ${closeTag}`;

    replaceRangeWithUndo(editor, insertStart, pos, fullSnippet);

    // Place cursor right after role prefix: {{ code: | }}
    const newCursor = insertStart + insertion.length;
    editor.selectionStart = editor.selectionEnd = newCursor;
    editor.focus();

    hideQuickSelector();
  }

  // 4. Execution & Debounced Caret-Preserving Merger
  // Least-invasive language detection: app.js's applyLanguage() sets
  // document.documentElement.lang, so we read that instead of reaching into
  // app.js's private `config` closure variable (which isn't exposed on window).
  // Same pattern as jev_action.js's own copy; kept local rather than shared so this
  // file still works standalone under the Node test harness.
  function getUILang() {
    try {
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en') {
        return 'en';
      }
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  // Shows a brief toast explaining why Ctrl+Enter (or an auto-triggered run, e.g. right
  // after a Quick Actions candidate inserts a slot) did nothing. Before this, every
  // early-return path below failed completely silently: the note looked untouched either
  // way, whether nothing was found or a run was already in progress, so a user pressing
  // Ctrl+Enter again had no way to tell "not found" from "already running" from "worked,
  // just hasn't finished yet". Falls back to console.warn if showMessage isn't reachable
  // (e.g. this file loaded standalone under the Node test harness).
  function notifyNoAction(key, fallbackText) {
    try {
      if (typeof global.showMessage === 'function') {
        const lang = getUILang();
        const dict = (typeof I18N !== 'undefined' && I18N[lang]) || (typeof I18N !== 'undefined' && I18N.ja);
        global.showMessage((dict && dict[key]) || fallbackText, 3000);
        return;
      }
    } catch (e) { /* fall through to console */ }
    console.warn(fallbackText);
  }

  async function triggerSlotExecution(targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return false;

    const text = editor.value;
    const cursor = editor.selectionStart;

    // Check if cursor is in excluded code block/inline code
    if (isInsideCode(text, cursor)) {
      return false; // Spec 3.1.3: 0ns AST Bypass (silent: the cursor isn't near a slot at all)
    }

    // Call Go backend to locate actionable slot
    let parseRes = null;
    if (window.backend && window.backend.parseSlotsRPC) {
      try {
        parseRes = await window.backend.parseSlotsRPC(text, cursor, JSON.stringify(slotConfig));
      } catch (e) {
        console.error("parseSlotsRPC error:", e);
      }
    }

    if (!parseRes || (!parseRes.targetSlot && !parseRes.hasWaitingApproval)) {
      notifyNoAction('slotNoTargetFound', '実行できるスロットが見つかりません（カーソルを {{ }} などのブロック内に置いてください）');
      return false; // No slot found
    }

    const target = parseRes.targetSlot;

    // Concurrency guard: Do not re-trigger if this slot is already running
    if (target) {
      const slotRaw = text.substring(target.startOffset, target.endOffset);
      if (slotRaw.includes('実行中')) {
        notifyNoAction('slotAlreadyRunning', 'このスロットはすでに実行中です');
        return false;
      }
      for (const [, existingMeta] of activeRequests.entries()) {
        if (Math.abs(existingMeta.startOffset - target.startOffset) < 30) {
          console.warn('Slot execution already in progress for offset:', target.startOffset);
          notifyNoAction('slotAlreadyRunning', 'このスロットはすでに実行中です');
          return false;
        }
      }
    }

    // A run is genuinely starting: the floating run button (if shown for this exact
    // span) is about to be replaced by the "実行中" placeholder text anyway, so hide
    // it immediately rather than waiting for the next debounced scan to notice.
    hideRunButton();

    const reqId = genReqId('slot-');

    let openD = "{{";
    let closeD = "}}";
    if (target) {
      openD = target.openDelimiter || "{{";
      closeD = target.closeDelim || "}}";
    }
    let executingPlaceholder = `${openD} ⟳ 実行中... ${closeD}`;

    let startOff = 0;
    let endOff = 0;
    let oldContent = "";

    if (target) {
      startOff = target.startOffset;
      endOff = target.endOffset;
      oldContent = text.substring(startOff, endOff);
    } else {
      // Waiting approval gate resume
      const gateMatch = text.match(/^[ \t]*-[ \t]*\[[xX]\][ \t]*(.*?)[ \t]*\/\/[ \t]*approve[ \t]*$/m);
      if (gateMatch) {
        startOff = gateMatch.index;
        endOff = startOff + gateMatch[0].length;
        oldContent = gateMatch[0];
        executingPlaceholder = `${oldContent} (実行中...)`;
      }
    }

    const meta = {
      reqId: reqId,
      // The pane the slot was triggered in. The result must merge back HERE even
      // if the user has moved to the other pane meanwhile.
      editor: editor,
      startOffset: startOff,
      endOffset: endOff,
      oldContent: oldContent,
      executingText: executingPlaceholder,
      openD: openD,
      closeD: closeD
    };
    activeRequests.set(reqId, meta);

    // Register with TaskManager for UI visualization and cancel controls
    if (global.TaskManager && global.TaskManager.addTask) {
      const agentName = (target && target.role) || (target && target.skillName) || slotConfig.default_agent || 'agy';
      const instructionText = (target && target.instruction) || oldContent;
      global.TaskManager.addTask({
        id: reqId,
        type: 'slot',
        agent: agentName,
        instruction: instructionText,
        startTime: Date.now(),
        onCancel: () => cancelSlotExecution(reqId)
      });
    }

    // Save previous state to local revert registry for Esc local revert
    registerLocalRevert(startOff, oldContent);

    // Replace slot text with executing placeholder in editor (preserving Undo stack)
    replaceRangeWithUndo(editor, startOff, endOff, executingPlaceholder);

    // Adjust cursor position if necessary
    if (cursor > endOff) {
      editor.selectionStart = editor.selectionEnd = cursor - (endOff - startOff) + executingPlaceholder.length;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    // Trigger Go process runner asynchronously (0ns UI blocking)
    const filePath = (global.getCurrentTabPath && global.getCurrentTabPath()) || "";
    if (window.backend && window.backend.runSlotAgentAsync) {
      window.backend.runSlotAgentAsync(reqId, filePath, text, cursor, JSON.stringify(slotConfig));
    }

    return true;
  }

  function cancelSlotExecution(reqId) {
    if (!reqId) return false;
    const meta = activeRequests.get(reqId);
    if (window.backend && window.backend.cancelSlotAgent) {
      try {
        window.backend.cancelSlotAgent(reqId);
      } catch (err) {
        console.error('cancelSlotAgent error:', err);
      }
    }
    activeRequests.delete(reqId);

    // Revert placeholder in editor if still present
    if (meta && meta.oldContent) {
      const editor = (meta && meta.editor) || getActiveEditor();
      if (editor) {
        const text = editor.value;
        const targetSearch = meta.executingText || "{{ ⟳ 実行中... }}";
        const idx = text.indexOf(targetSearch);
        if (idx !== -1) {
          // Cancel is often clicked from the tasks panel; don't yank the user
          // into the editor or move their caret.
          const curStart = editor.selectionStart;
          const curEnd = editor.selectionEnd;
          const snap = captureUserContext(editor);
          const delta = meta.oldContent.length - targetSearch.length;
          const endIdx = idx + targetSearch.length;
          const mapOffset = (off) => {
            if (off >= endIdx) return off + delta;
            if (off > idx && off < endIdx) return idx + meta.oldContent.length;
            return off;
          };
          replaceRangeWithUndo(editor, idx, endIdx, meta.oldContent);
          restoreUserContext(editor, snap, mapOffset(curStart), mapOffset(curEnd));
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }

    if (global.TaskManager && global.TaskManager.updateTask) {
      global.TaskManager.updateTask(reqId, { status: 'canceled', endTime: Date.now() });
    }
    return true;
  }

  // 5. Safe Debounced Merger & Caret Preservation (Spec 3.4.2 & 3.4.3)
  function handleSlotResult(result) {
    if (!result) return;

    if (global.TaskManager && global.TaskManager.updateTask) {
      const isErr = result.status === 'failed' || (result.exitCode && result.exitCode !== 0);
      global.TaskManager.updateTask(result.reqId, {
        status: isErr ? 'failed' : 'completed',
        endTime: Date.now(),
        error: result.errorMsg || ''
      });
    }

    // Enqueue merge request
    pendingMergeQueue.push(result);
    processPendingMergesDebounced();
  }

  function processPendingMergesDebounced() {
    clearTimeout(mergeDebounceTimer);
    const now = Date.now();
    const idleTime = now - lastTypingTime;

    if (idleTime < 500) {
      // Human is currently typing; delay merge until 500ms idle
      mergeDebounceTimer = setTimeout(processPendingMergesDebounced, 500 - idleTime + 50);
      return;
    }

    // Apply all pending merges atomically
    const fallbackEditor = getActiveEditor();

    while (pendingMergeQueue.length > 0) {
      const item = pendingMergeQueue.shift();
      const meta = (item && item.reqId && activeRequests.get(item.reqId)) || null;
      // Merge into the pane the slot was triggered in, not wherever focus is now.
      const editor = (meta && meta.editor) || fallbackEditor;
      if (!editor) continue;
      applyMergeToEditor(editor, item);
    }
  }

  // Snapshot everything an asynchronously arriving merge could disturb, so the
  // user keeps their focus, selection and scroll position.
  function captureUserContext(editor) {
    return {
      activeEl: (typeof document !== 'undefined') ? document.activeElement : null,
      dir: editor.selectionDirection || 'none',
      scrollTop: editor.scrollTop || 0,
      scrollLeft: editor.scrollLeft || 0
    };
  }

  function restoreUserContext(editor, snap, newStart, newEnd) {
    const len = (editor.value || '').length;
    const s = Math.max(0, Math.min(len, newStart));
    const e = Math.max(s, Math.min(len, newEnd));
    try {
      if (typeof editor.setSelectionRange === 'function' && snap.dir && snap.dir !== 'none') {
        editor.setSelectionRange(s, e, snap.dir);
      } else {
        editor.selectionStart = s;
        editor.selectionEnd = e;
      }
    } catch (err) {
      editor.selectionStart = editor.selectionEnd = s;
    }
    editor.scrollTop = snap.scrollTop;
    editor.scrollLeft = snap.scrollLeft;

    // replaceRangeWithUndo has to focus the editor for execCommand; give focus
    // back to wherever the user actually was (Find box, CLI bar, other pane...).
    const prev = snap.activeEl;
    if (prev && prev !== editor && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch (err) {
        /* element gone; nothing to restore */
      }
    }
  }

  function applyMergeToEditor(editor, result) {
    const meta = (result.reqId && activeRequests.get(result.reqId)) || null;
    const targetText = result.newContent || "";
    const priorText = (meta && meta.oldContent) || result.oldContent || "";

    // A "no actionable slot" result carries nothing to apply: a canceled run
    // (newContent === oldContent), a run that produced no content at all, or a
    // result that arrived with no real location info (both offsets defaulted
    // to 0 rather than pointing at an actual slot). Bail out as a true no-op
    // before touching the DOM: no execCommand, no focus/caret/scroll change,
    // and no ghost-diff flash.
    const noRealOffsets = result.startOffset === 0 && result.endOffset === 0;
    const noRealChange = !targetText || targetText === priorText;
    if (noRealOffsets || noRealChange) {
      if (result.reqId) activeRequests.delete(result.reqId);
      return;
    }

    const text = editor.value;
    const curStart = editor.selectionStart;
    const curEnd = editor.selectionEnd;
    const snap = captureUserContext(editor);
    const placeholder = (meta && meta.executingText) || "{{ ⟳ 実行中... }}";

    // 1. Precise location search near recorded startOffset
    let replaceStart = -1;
    let replaceEnd = -1;

    if (meta && meta.executingText) {
      const searchStart = Math.max(0, meta.startOffset - 40);
      const foundIdx = text.indexOf(meta.executingText, searchStart);
      if (foundIdx !== -1 && Math.abs(foundIdx - meta.startOffset) < 300) {
        replaceStart = foundIdx;
        replaceEnd = foundIdx + meta.executingText.length;
      }
    }

    if (replaceStart === -1) {
      // 2. Global search for placeholder
      const idx = text.indexOf(placeholder);
      if (idx !== -1) {
        replaceStart = idx;
        replaceEnd = idx + placeholder.length;
      }
    }

    if (replaceStart === -1 && result.oldContent) {
      // 3. Search for oldContent
      const idx = text.indexOf(result.oldContent);
      if (idx !== -1) {
        replaceStart = idx;
        replaceEnd = idx + result.oldContent.length;
      }
    }

    if (replaceStart === -1 && result.startOffset !== undefined && result.endOffset !== undefined) {
      // 4. Fallback to offsets
      replaceStart = Math.min(result.startOffset, text.length);
      replaceEnd = Math.min(result.endOffset, text.length);
    }

    if (replaceStart === -1) {
      if (result.reqId) activeRequests.delete(result.reqId);
      return; // Could not safely locate merge target
    }

    const oldLen = replaceEnd - replaceStart;
    const newLen = targetText.length;
    const delta = newLen - oldLen;

    // Record for Ctrl+Z undo & Esc local revert
    const revertText = (meta && meta.oldContent) || result.oldContent || "";
    registerLocalRevert(replaceStart, revertText, targetText);
    if (revertText && targetText) {
      slotUndoHistory.push({
        reqId: result.reqId,
        oldContent: revertText,
        newContent: targetText,
        timestamp: Date.now()
      });
      if (slotUndoHistory.length > 30) slotUndoHistory.shift();
    }

    // Apply text replacement preserving browser Undo stack
    replaceRangeWithUndo(editor, replaceStart, replaceEnd, targetText);

    if (result.reqId) activeRequests.delete(result.reqId);

    // Caret Preservation: slide offsets that sit after the replacement, leave
    // offsets before it alone, and park offsets inside it after the new text.
    const mapOffset = (off) => {
      if (off >= replaceEnd) return off + delta;
      if (off > replaceStart && off < replaceEnd) return replaceStart + newLen;
      return off;
    };
    restoreUserContext(editor, snap, mapOffset(curStart), mapOffset(curEnd));

    // Ghost Diff: light up the modified lines
    triggerGhostDiff(editor, replaceStart, replaceStart + newLen);

    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 7. Ghost Diff & Local Revert (Esc) (Spec 3.4.4)
  // Keep the CSS animation length in lockstep with the configured duration.
  function applyGhostDiffDuration() {
    try {
      const root = (typeof document !== 'undefined') && document.documentElement;
      if (root && root.style && typeof root.style.setProperty === 'function') {
        root.style.setProperty('--ghost-diff-duration', `${slotConfig.ghost_diff_duration_ms || 4000}ms`);
      }
    } catch (e) {
      /* no-op */
    }
  }

  function triggerGhostDiff(editor, startOffset, endOffset) {
    // Add temporary visual glowing indicator
    applyGhostDiffDuration();
    editor.classList.add('slot-ghost-diff');
    const duration = slotConfig.ghost_diff_duration_ms || 4000;

    setTimeout(() => {
      editor.classList.remove('slot-ghost-diff');
    }, duration);
  }

  function registerLocalRevert(startOffset, oldText, newText) {
    const key = 'revert-' + startOffset;
    const timeoutMs = (slotConfig.ghost_diff_duration_ms || 4000) + 1000;

    const timer = setTimeout(() => {
      ghostDiffTimeouts.delete(key);
    }, timeoutMs);

    ghostDiffTimeouts.set(key, {
      startOffset: startOffset,
      oldText: oldText,
      newText: newText,
      expiresAt: Date.now() + timeoutMs,
      timer: timer
    });
  }

  function tryLocalRevert() {
    const editor = getActiveEditor();
    if (!editor || ghostDiffTimeouts.size === 0) return false;

    const text = editor.value;

    for (const [key, item] of ghostDiffTimeouts.entries()) {
      if (item.oldText && item.newText) {
        const foundIdx = text.indexOf(item.newText);
        if (foundIdx !== -1) {
          // Revert this slot only preserving Undo stack
          replaceRangeWithUndo(editor, foundIdx, foundIdx + item.newText.length, item.oldText);
          editor.setSelectionRange(foundIdx, foundIdx + item.oldText.length);
          editor.classList.remove('slot-ghost-diff');

          clearTimeout(item.timer);
          ghostDiffTimeouts.delete(key);
          return true;
        }
      }
    }
    return false;
  }

  // Dedicated Ctrl+Z / Cmd+Z Handler for reverting Slot Agent execution
  function trySlotUndo(editor) {
    if (!editor || slotUndoHistory.length === 0) return false;

    const text = editor.value;
    for (let i = slotUndoHistory.length - 1; i >= 0; i--) {
      const item = slotUndoHistory[i];
      if (!item.newContent || !item.oldContent) continue;

      const idx = text.indexOf(item.newContent);
      if (idx !== -1) {
        replaceRangeWithUndo(editor, idx, idx + item.newContent.length, item.oldContent);
        editor.setSelectionRange(idx, idx + item.oldContent.length);
        editor.classList.remove('slot-ghost-diff');

        slotUndoHistory.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Helper
  // Resolve the editor the user is currently in. The app hosts two panes
  // (#editor / #editor-secondary); previously this matched neither and always
  // fell through to the first textarea, i.e. the primary pane.
  function getActiveEditor() {
    const el = document.activeElement;
    if (el && el.tagName === 'TEXTAREA' && (el.id === 'editor' || el.id === 'editor-secondary')) {
      return el;
    }
    if (typeof global.getActiveEditorEl === 'function') {
      const resolved = global.getActiveEditorEl();
      if (resolved) return resolved;
    }
    return document.getElementById('editor') || document.querySelector('textarea');
  }

  // 8. Event Listeners & Keyboard Hook
  function setupEditorEvents(editor) {
    if (!editor || editor.__slotAgentAttached) return;
    editor.__slotAgentAttached = true;

    // Track human typing timestamp for debounce merge
    editor.addEventListener('keydown', (e) => {
      lastTypingTime = Date.now();

      // Check if quick selector is open
      if (selectorEl && selectorEl.classList.contains('active')) {
        const presets = getAvailablePresets();
        // Esc: close menu
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideQuickSelector();
          return;
        }
        // Arrow navigation (plain ArrowUp/ArrowDown on every platform; no modifier
        // needed or accepted). The legacy `e.key === 'Down'/'Up'` aliases (old
        // IE-style key names) were removed: no engine this app runs on — Chromium,
        // WebKit/WKWebView, or Firefox — has ever emitted them as `key` for the
        // arrow keys, so `e.key === 'ArrowDown'` alone covers every real event.
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectorSelectedIndex = (selectorSelectedIndex + 1) % presets.length;
          renderSelectorList(presets);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectorSelectedIndex = (selectorSelectedIndex - 1 + presets.length) % presets.length;
          renderSelectorList(presets);
          return;
        }
        // Tab / Enter: commit
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commitPreset(presets[selectorSelectedIndex]);
          return;
        }
        // Numbers 1-9: instant commit
        if (e.key >= '1' && e.key <= '9') {
          const num = parseInt(e.key, 10);
          if (num <= presets.length) {
            e.preventDefault();
            e.stopPropagation();
            commitPreset(presets[num - 1]);
            return;
          }
        }
      }

      // Ctrl+Z / Cmd+Z: Revert Slot Agent execution directly to original prompt
      if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (trySlotUndo(editor)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Esc: Local Revert (within 5 seconds of ghost diff)
      if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (tryLocalRevert()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Ctrl+Enter / Cmd+Enter: Trigger slot execution / pipeline resume.
      // triggerSlotExecution is async, so its return value here is always a (truthy)
      // Promise, never the eventual true/false result - the swallow below is therefore
      // unconditional, matching this app's other Ctrl+Enter handling (see
      // config.shortcuts.insertLineBelow's own default). Whether a slot was actually
      // found/started is reported asynchronously via notifyNoAction inside
      // triggerSlotExecution itself, not via this return value.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        triggerSlotExecution();
        return;
      }
    }, true);

    editor.addEventListener('input', () => {
      lastTypingTime = Date.now();
      scheduleRunButtonUpdate(editor);

      // Read the textarea value once per keystroke and reuse it below.
      const pos = editor.selectionStart;
      const text = editor.value;

      // 1. Auto-IME normalization
      if (normalizeIMESlotTrigger(editor, pos, text)) {
        return;
      }

      // 2. Trigger check for quick selector.
      // The cheap 2-3 char delimiter test runs FIRST: the lexical shield walks
      // the whole prefix, and on the overwhelming majority of keystrokes it
      // cannot change the outcome (no trigger typed, selector not open).
      const twoChars = text.substring(Math.max(0, pos - 2), pos);
      const threeChars = text.substring(Math.max(0, pos - 3), pos);

      let trigger = null;
      let triggerStart = 0;
      if (twoChars === '{{') {
        trigger = '{{'; triggerStart = pos - 2;
      } else if (twoChars === '[?') {
        trigger = '[?'; triggerStart = pos - 2;
      } else if (twoChars === '【?') {
        trigger = '【?'; triggerStart = pos - 2;
      } else if (twoChars === '[!') {
        trigger = '[!'; triggerStart = pos - 2;
      } else if (threeChars === '[>>') {
        trigger = '[>>'; triggerStart = pos - 3;
      }

      const selectorActive = !!(selectorEl && selectorEl.classList.contains('active'));
      if (!trigger && !selectorActive) {
        return; // nothing to open, nothing to dismiss
      }

      if (isInsideCodeOrUrl(text, pos)) {
        hideQuickSelector();
        return;
      }

      if (trigger) {
        showQuickSelector(editor, trigger, triggerStart);
      } else {
        // Dismiss quick selector if typing normal words or space (0s evaporation)
        hideQuickSelector();
      }
    });

    editor.addEventListener('compositionend', () => {
      normalizeIMESlotTrigger(editor);
    });

    // Cursor-only moves (arrow keys, mouse clicks) don't fire 'input', but the run
    // button still needs to appear/disappear/reposition as the caret enters or
    // leaves a slot.
    editor.addEventListener('keyup', (e) => {
      if (e.key && e.key.indexOf('Arrow') === 0) scheduleRunButtonUpdate(editor);
    });
    editor.addEventListener('click', () => scheduleRunButtonUpdate(editor));

    editor.addEventListener('blur', () => {
      setTimeout(hideQuickSelector, 200);
      setTimeout(hideRunButton, 200);
    });
  }

  // 9. Attach global callbacks
  window.__onSlotAgentResult = function (result) {
    handleSlotResult(result);
  };

  window.__onExternalFileChanged = function (filePath) {
    // If current active note matches, trigger merge check
    const curPath = (global.getCurrentTabPath && global.getCurrentTabPath()) || "";
    if (curPath && curPath === filePath) {
      if (window.backend && window.backend.readFileByPath) {
        window.backend.readFileByPath(filePath).then(fileRes => {
          if (fileRes && fileRes.content !== undefined) {
            handleSlotResult({
              newContent: fileRes.content
            });
          }
        });
      }
    }
  };

  // Forward slot settings that other frontend modules depend on
  // (hover peek toggle / ghost diff duration).
  function propagateSlotConfig() {
    if (global.TaskManager && global.TaskManager.updateConfig) {
      global.TaskManager.updateConfig({ hover_peek_enabled: slotConfig.hover_peek_enabled !== false });
    }
    applyGhostDiffDuration();
  }

  // Expose SlotAgent global API
  global.SlotAgent = {
    init: async function () {
      initSelectorDOM();
      initRunButtonDOM();
      const editor = getActiveEditor();
      if (editor) setupEditorEvents(editor);

      if (window.backend && window.backend.getActiveSlotConfigJSON) {
        try {
          // Bound backend calls resolve asynchronously (webview's Bind wraps every
          // call in a Promise even for a synchronous Go method) - awaiting it was
          // missing here, so `raw` was always the Promise object itself and
          // JSON.parse(raw) always threw, silently caught below. slotConfig was
          // therefore never actually synced from the backend; every session ran on
          // this file's hardcoded JS defaults regardless of agents.yaml.
          const raw = await window.backend.getActiveSlotConfigJSON();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              slotConfig = Object.assign(slotConfig, parsed);
            }
          }
        } catch (e) {
          console.warn('Failed to load active slot config in SlotAgent.init:', e);
        }
      }
      propagateSlotConfig();
      applyRunButtonLabel();
    },
    attachEditor: setupEditorEvents,
    triggerSlotExecution: triggerSlotExecution,
    cancelSlotExecution: cancelSlotExecution,
    updateConfig: function (newCfg) {
      if (newCfg) {
        slotConfig = Object.assign(slotConfig, newCfg);
        propagateSlotConfig();
      }
      applyRunButtonLabel();
    },
    getConfig: function () {
      return slotConfig;
    },
    // Internal helper exposed only so the Node unit tests can exercise the pure
    // run-button detection logic directly; not part of the public API.
    _findEnclosingSlotSpan: findEnclosingSlotSpan
  };

  // Auto initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', global.SlotAgent.init);
  } else {
    global.SlotAgent.init();
  }

})(window);
