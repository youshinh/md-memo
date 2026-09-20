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
        args: ["-p", "{instruction}", "--dangerously-skip-permissions"],
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
  let ghostDiffTimeouts = new Map(); // slotKey -> { revertInfo, timer }
  let slotUndoHistory = []; // { reqId, oldContent, newContent, timestamp }

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
  function normalizeIMESlotTrigger(editor) {
    if (!editor) return false;
    const pos = editor.selectionStart;
    const text = editor.value;
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
        <span>⚡ AI Agent Slot & Pipeline</span>
        <span style="font-size: 10px; opacity: 0.6;">Alt+↑/↓ 移動 • 1-9 確定 • Esc 閉じる</span>
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
  async function triggerSlotExecution(targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return false;

    const text = editor.value;
    const cursor = editor.selectionStart;

    // Check if cursor is in excluded code block/inline code
    if (isInsideCode(text, cursor)) {
      return false; // Spec 3.1.3: 0ns AST Bypass
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
      return false; // No slot found
    }

    const target = parseRes.targetSlot;

    // Concurrency guard: Do not re-trigger if this slot is already running
    if (target) {
      const slotRaw = text.substring(target.startOffset, target.endOffset);
      if (slotRaw.includes('実行中')) {
        return false;
      }
      for (const [, existingMeta] of activeRequests.entries()) {
        if (Math.abs(existingMeta.startOffset - target.startOffset) < 30) {
          console.warn('Slot execution already in progress for offset:', target.startOffset);
          return false;
        }
      }
    }

    const reqId = 'slot-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

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
      const editor = getActiveEditor();
      if (editor) {
        const text = editor.value;
        const targetSearch = meta.executingText || "{{ ⟳ 実行中... }}";
        const idx = text.indexOf(targetSearch);
        if (idx !== -1) {
          replaceRangeWithUndo(editor, idx, idx + targetSearch.length, meta.oldContent);
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
    const editor = getActiveEditor();
    if (!editor) {
      pendingMergeQueue = [];
      return;
    }

    while (pendingMergeQueue.length > 0) {
      const item = pendingMergeQueue.shift();
      applyMergeToEditor(editor, item);
    }
  }

  function applyMergeToEditor(editor, result) {
    const text = editor.value;
    const curStart = editor.selectionStart;
    const curEnd = editor.selectionEnd;

    let targetText = result.newContent || "";
    const meta = (result.reqId && activeRequests.get(result.reqId)) || null;
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

    // Caret Preservation: slide caret offset if after replacement
    let newCursor = curStart;
    if (curStart >= replaceEnd) {
      newCursor = curStart + delta;
    } else if (curStart > replaceStart && curStart < replaceEnd) {
      newCursor = replaceStart + newLen;
    }
    editor.selectionStart = editor.selectionEnd = Math.max(0, Math.min(editor.value.length, newCursor));

    // Ghost Diff: light up the modified lines
    triggerGhostDiff(editor, replaceStart, replaceStart + newLen);

    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 7. Ghost Diff & Local Revert (Esc) (Spec 3.4.4)
  function triggerGhostDiff(editor, startOffset, endOffset) {
    // Add temporary visual glowing indicator
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
  function getActiveEditor() {
    return document.getElementById('note-editor') || document.querySelector('textarea.active') || document.querySelector('textarea');
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
        // Arrow navigation: Alt+Down / Alt+Up or plain Down / Up
        if (e.key === 'ArrowDown' || (e.altKey && e.key === 'Down')) {
          e.preventDefault();
          selectorSelectedIndex = (selectorSelectedIndex + 1) % presets.length;
          renderSelectorList(presets);
          return;
        }
        if (e.key === 'ArrowUp' || (e.altKey && e.key === 'Up')) {
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

      // Ctrl+Enter / Cmd+Enter: Trigger slot execution / pipeline resume
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const handled = triggerSlotExecution();
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }, true);

    editor.addEventListener('input', () => {
      lastTypingTime = Date.now();

      // 1. Auto-IME normalization
      if (normalizeIMESlotTrigger(editor)) {
        return;
      }

      // 2. Trigger check for quick selector
      const pos = editor.selectionStart;
      const text = editor.value;

      if (isInsideCodeOrUrl(text, pos)) {
        hideQuickSelector();
        return;
      }

      // Check if user just typed trigger delimiter
      const twoChars = text.substring(Math.max(0, pos - 2), pos);
      const threeChars = text.substring(Math.max(0, pos - 3), pos);

      if (twoChars === '{{') {
        showQuickSelector(editor, '{{', pos - 2);
      } else if (twoChars === '[?') {
        showQuickSelector(editor, '[?', pos - 2);
      } else if (twoChars === '【?') {
        showQuickSelector(editor, '【?', pos - 2);
      } else if (twoChars === '[!') {
        showQuickSelector(editor, '[!', pos - 2);
      } else if (threeChars === '[>>') {
        showQuickSelector(editor, '[>>', pos - 3);
      } else {
        // Dismiss quick selector if typing normal words or space (0s evaporation)
        if (selectorEl && selectorEl.classList.contains('active')) {
          hideQuickSelector();
        }
      }
    });

    editor.addEventListener('compositionend', () => {
      normalizeIMESlotTrigger(editor);
    });

    editor.addEventListener('blur', () => {
      setTimeout(hideQuickSelector, 200);
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

  // Expose SlotAgent global API
  global.SlotAgent = {
    init: function () {
      initSelectorDOM();
      const editor = getActiveEditor();
      if (editor) setupEditorEvents(editor);

      if (window.backend && window.backend.getActiveSlotConfigJSON) {
        try {
          const raw = window.backend.getActiveSlotConfigJSON();
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
    },
    attachEditor: setupEditorEvents,
    triggerSlotExecution: triggerSlotExecution,
    cancelSlotExecution: cancelSlotExecution,
    updateConfig: function (newCfg) {
      if (newCfg) {
        slotConfig = Object.assign(slotConfig, newCfg);
      }
    },
    getConfig: function () {
      return slotConfig;
    }
  };

  // Auto initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', global.SlotAgent.init);
  } else {
    global.SlotAgent.init();
  }

})(window);
