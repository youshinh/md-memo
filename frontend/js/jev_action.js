// MD-Memo x Jev Autonomous Action Integration
// Spec: Deterministic Governance, EBNF Grammar Constraint, MAP-Elites Orthogonal Triad Selection
(function (global) {
  'use strict';

  let editorEl = null;
  let jevPanelEl = null;
  let debounceTimer = null;
  let currentCandidates = [];
  let selectedIndex = 0;
  let isPanelVisible = false;
  let isExecuting = false;
  let isActionEnabled = true;
  let isManualOnly = false;
  let debounceDelayMs = 2500;
  let isComposing = false;

  function initJevIntegration() {
    editorEl = document.getElementById('editor');
    if (!editorEl) return;

    createJevPanelDOM();
    bindEvents();
  }

  function createJevPanelDOM() {
    if (document.getElementById('jev-action-panel')) return;

    jevPanelEl = document.createElement('div');
    jevPanelEl.id = 'jev-action-panel';
    jevPanelEl.className = 'jev-action-panel hidden';
    jevPanelEl.innerHTML = `
      <div class="jev-header">
        <div class="jev-title">
          <span class="jev-badge">Quick Actions</span>
          <span class="jev-sub">アクション候補</span>
        </div>
        <div class="jev-hints">
          <span class="jev-kbd">Alt+1..3</span> 選択 / <span class="jev-kbd">Tab</span> 移動 / <span class="jev-kbd">Alt+Enter</span> 確定 / <span class="jev-kbd">Esc</span> 閉じる
        </div>
      </div>
      <div class="jev-slots" id="jev-slots-container"></div>
      <div class="jev-status hidden" id="jev-status-bar"></div>
    `;

    // Append to workspace or editor wrapper
    const wrapper = document.getElementById('editor-wrapper') || document.body;
    wrapper.appendChild(jevPanelEl);
  }

  function schedulePrediction() {
    if (!isActionEnabled || isManualOnly) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(triggerJevPrediction, debounceDelayMs);
  }

  function bindEvents() {
    // 0. IME composition events (suppress popups during Japanese composition)
    editorEl.addEventListener('compositionstart', () => {
      isComposing = true;
      hidePanel();
      clearTimeout(debounceTimer);
    });

    editorEl.addEventListener('compositionend', () => {
      isComposing = false;
      schedulePrediction();
    });

    // 1. Keystroke stillness detection (configurable debounce delay)
    editorEl.addEventListener('input', () => {
      hidePanel();
      clearTimeout(debounceTimer);
      if (isComposing) return;
      schedulePrediction();
    });

    // 2. Keyboard handling for selection, dismissal, and manual trigger
    editorEl.addEventListener('keydown', (e) => {
      // Manual trigger shortcut: Alt+A or Ctrl+Shift+A
      if ((e.altKey && (e.key === 'a' || e.key === 'A')) ||
          (e.ctrlKey && e.shiftKey && (e.key === 'a' || e.key === 'A'))) {
        e.preventDefault();
        e.stopPropagation();
        triggerJevPrediction();
        return;
      }

      if (!isPanelVisible) return;

      if (e.key === 'Escape') {
        hidePanel();
        isExecuting = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (isExecuting) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (currentCandidates.length > 0) {
          selectedIndex = (selectedIndex + 1) % currentCandidates.length;
          renderSlots();
        }
        return;
      }

      // Plain Enter without modifier: If user is typing in the editor, NEVER execute candidate on plain Enter!
      // Plain Enter must insert a normal newline. We quietly hide the suggestion panel.
      if (e.key === 'Enter' && !e.altKey && !e.ctrlKey) {
        hidePanel();
        return;
      }

      // Explicit execution shortcut: Alt+Enter or Ctrl+Enter
      if (e.key === 'Enter' && (e.altKey || (e.ctrlKey && !e.shiftKey))) {
        if (currentCandidates.length > 0 && selectedIndex < currentCandidates.length) {
          e.preventDefault();
          executeCandidate(currentCandidates[selectedIndex]);
        }
        return;
      }

      // Quick digit shortcuts: Alt+1..3 or Ctrl+1..3
      // CRITICAL: Plain '1', '2', '3' without Alt/Ctrl modifiers must NOT be intercepted,
      // allowing standard number typing in the note!
      if (['1', '2', '3'].includes(e.key) && (e.altKey || (e.ctrlKey && !e.shiftKey))) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < currentCandidates.length) {
          e.preventDefault();
          executeCandidate(currentCandidates[idx]);
        }
      }
    });

    // Hide panel on click outside or blur
    document.addEventListener('click', (e) => {
      if (isPanelVisible && jevPanelEl && !jevPanelEl.contains(e.target) && e.target !== editorEl) {
        hidePanel();
      }
    });
  }

  async function triggerJevPrediction() {
    if (!isActionEnabled) return;
    if (isComposing) return;
    if (!window.backend || !window.backend.jevPredict) return;
    if (document.activeElement !== editorEl) return;

    const fullText = editorEl.value;
    const cursor = editorEl.selectionStart;

    // Optional context extraction around cursor
    const startPos = Math.max(0, cursor - 1500);
    const endPos = Math.min(fullText.length, cursor + 500);
    const contextText = fullText.substring(startPos, endPos);

    try {
      const resp = await window.backend.jevPredict(contextText, cursor);
      if (resp && resp.candidates && resp.candidates.length > 0) {
        currentCandidates = resp.candidates;
        selectedIndex = 0;
        renderSlots();
        showPanel();
      } else {
        hidePanel();
      }
    } catch (err) {
      console.warn('Jev prediction failed or canceled:', err);
      hidePanel();
    }
  }

  function renderSlots() {
    const container = document.getElementById('jev-slots-container');
    if (!container) return;

    container.innerHTML = '';
    const slotLabels = [
      { num: 1, name: 'Local × Generative', tag: 'AI' },
      { num: 2, name: 'Local × Deterministic', tag: 'CLI' },
      { num: 3, name: 'Global × Documentation', tag: 'DOC' }
    ];

    currentCandidates.forEach((cand, idx) => {
      const isSel = idx === selectedIndex;
      const actType = (cand.action_type || cand.ActionType || 'sh').toLowerCase();
      const command = cand.command || cand.Command || '';
      const desc = cand.description || cand.Description || '';
      const scope = cand.scope || cand.Scope || 'local';

      const meta = slotLabels[idx] || { num: idx + 1, name: scope, tag: actType.toUpperCase() };

      const card = document.createElement('div');
      card.className = `jev-slot-card ${isSel ? 'selected' : ''} jev-type-${actType}`;
      card.innerHTML = `
        <div class="jev-slot-top">
          <span class="jev-slot-num">${meta.num}</span>
          <span class="jev-slot-tag jev-tag-${actType}">${actType.toUpperCase()}</span>
          <span class="jev-slot-axis">${meta.name}</span>
        </div>
        <div class="jev-slot-cmd"><code>${escapeHTML(command)}</code></div>
        <div class="jev-slot-desc">${escapeHTML(desc)}</div>
      `;

      card.addEventListener('click', () => {
        selectedIndex = idx;
        executeCandidate(cand);
      });

      container.appendChild(card);
    });
  }

  const pendingJevRequests = new Map();

  // Global callback for asynchronous Jev execution results from backend
  global.__onJevResult = function (reqId, res) {
    if (pendingJevRequests.has(reqId)) {
      const resolve = pendingJevRequests.get(reqId);
      pendingJevRequests.delete(reqId);
      resolve(res);
    }
  };

  function showPanel() {
    if (!jevPanelEl) return;
    jevPanelEl.classList.remove('hidden');
    isPanelVisible = true;
  }

  function hidePanel() {
    if (!jevPanelEl) return;
    jevPanelEl.classList.add('hidden');
    isPanelVisible = false;
    currentCandidates = [];
    const statusBar = document.getElementById('jev-status-bar');
    if (statusBar) {
      statusBar.classList.add('hidden');
      statusBar.innerHTML = '';
    }
  }

  async function executeCandidate(candidate) {
    if (!candidate || isExecuting) return;

    const command = candidate.command || candidate.Command || '';
    const actType = (candidate.action_type || candidate.ActionType || 'sh').toLowerCase();

    // 1. Slot / Agent delegation / AI instructions: insert directly into note and trigger SlotAgent
    if (actType === 'slot' || actType === 'ai' || command.startsWith('{{') || command.startsWith('[?')) {
      hidePanel();
      const slotSnippet = (command.startsWith('{{') || command.startsWith('[?')) ? command : `{{ ${command} }}`;
      insertSlotAndTrigger(slotSnippet);
      return;
    }

    // 2. Deterministic CLI or Generative tasks: execute asynchronously via backend
    isExecuting = true;
    const statusBar = document.getElementById('jev-status-bar');
    if (statusBar) {
      statusBar.classList.remove('hidden');
      statusBar.innerHTML = `実行中: <code>${escapeHTML(command)}</code>`;
    }

    try {
      const fullText = editorEl.value;
      const res = await runBackendJevExecute(candidate, fullText);

      if (res && res.success) {
        insertMarkdownResult(res.markdown);
        hidePanel();
      } else {
        const errMsg = res && res.error ? res.error : '実行に失敗しました';
        if (statusBar) {
          statusBar.innerHTML = `<span class="jev-err">エラー:</span> ${escapeHTML(errMsg)}`;
        }
        setTimeout(hidePanel, 3000);
      }
    } catch (err) {
      if (statusBar) {
        statusBar.innerHTML = `<span class="jev-err">エラー:</span> ${escapeHTML(String(err))}`;
      }
      setTimeout(hidePanel, 3000);
    } finally {
      isExecuting = false;
    }
  }

  function runBackendJevExecute(candidate, fullText) {
    return new Promise((resolve) => {
      const actType = (candidate.action_type || candidate.ActionType || 'CLI').toUpperCase();
      const cmdText = candidate.command || candidate.Command || '';

      if (window.backend && window.backend.jevExecuteAsync) {
        const reqId = 'jev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        if (global.TaskManager && global.TaskManager.addTask) {
          global.TaskManager.addTask({
            id: reqId,
            type: 'action',
            agent: actType,
            instruction: cmdText,
            startTime: Date.now()
          });
        }

        const timer = setTimeout(() => {
          pendingJevRequests.delete(reqId);
          if (global.TaskManager && global.TaskManager.updateTask) {
            global.TaskManager.updateTask(reqId, { status: 'failed', error: 'タイムアウト (15秒超過)' });
          }
          resolve({ success: false, error: '実行がタイムアウトしました (15秒超過)' });
        }, 16000);

        pendingJevRequests.set(reqId, (res) => {
          clearTimeout(timer);
          if (global.TaskManager && global.TaskManager.updateTask) {
            global.TaskManager.updateTask(reqId, {
              status: res && res.success ? 'completed' : 'failed',
              endTime: Date.now(),
              error: res && res.error ? res.error : ''
            });
          }
          resolve(res);
        });

        window.backend.jevExecuteAsync(reqId, JSON.stringify(candidate), fullText);
      } else if (window.backend && window.backend.jevExecute) {
        Promise.resolve(window.backend.jevExecute(JSON.stringify(candidate), fullText))
          .then(resolve)
          .catch((err) => resolve({ success: false, error: String(err) }));
      } else {
        resolve({ success: false, error: 'Jevバックエンドが利用できません' });
      }
    });
  }

  function insertSlotAndTrigger(slotText) {
    if (!slotText || !editorEl) return;

    const curPos = editorEl.selectionStart;
    const text = editorEl.value;

    let insertPos = curPos;
    const nextNewline = text.indexOf('\n', curPos);
    if (nextNewline !== -1) {
      insertPos = nextNewline;
    } else {
      insertPos = text.length;
    }

    const before = text.substring(0, insertPos);
    const after = text.substring(insertPos);

    const insertion = slotText.startsWith('\n') ? slotText : '\n' + slotText;
    editorEl.value = before + insertion + after;

    const newCursor = insertPos + insertion.length;
    editorEl.selectionStart = newCursor;
    editorEl.selectionEnd = newCursor;

    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
    editorEl.focus();

    // Trigger SlotAgent execution asynchronously
    if (window.SlotAgent && window.SlotAgent.triggerSlotExecution) {
      setTimeout(() => {
        window.SlotAgent.triggerSlotExecution(editorEl);
      }, 50);
    }
  }

  function insertMarkdownResult(markdown) {
    if (!markdown || !editorEl) return;

    const curPos = editorEl.selectionStart;
    const text = editorEl.value;

    // Find end of current line to append cleanly
    let insertPos = curPos;
    const nextNewline = text.indexOf('\n', curPos);
    if (nextNewline !== -1) {
      insertPos = nextNewline;
    } else {
      insertPos = text.length;
    }

    const before = text.substring(0, insertPos);
    const after = text.substring(insertPos);

    const insertion = markdown.startsWith('\n') ? markdown : '\n' + markdown;
    editorEl.value = before + insertion + after;

    const newCursor = insertPos + insertion.length;
    editorEl.selectionStart = newCursor;
    editorEl.selectionEnd = newCursor;

    // Dispatch input event to trigger autosave and live preview
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
    editorEl.focus();
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Auto initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initJevIntegration);
  } else {
    initJevIntegration();
  }

  // Export for testing & application config
  global.JevAction = {
    init: initJevIntegration,
    triggerJevPrediction: triggerJevPrediction,
    hidePanel: hidePanel,
    updateConfig: function (cfg) {
      if (!cfg) return;
      if (typeof cfg.enabled === 'boolean') {
        isActionEnabled = cfg.enabled;
        if (!isActionEnabled) hidePanel();
      }
      if (typeof cfg.manualOnly === 'boolean') {
        isManualOnly = cfg.manualOnly;
        if (isManualOnly) clearTimeout(debounceTimer);
      }
      if (typeof cfg.delaySec === 'number' && !isNaN(cfg.delaySec)) {
        debounceDelayMs = Math.max(200, Math.round(cfg.delaySec * 1000));
      }
    },
    setEnabled: function (enabled) {
      isActionEnabled = !!enabled;
      if (!isActionEnabled) hidePanel();
    },
    isEnabled: function () {
      return isActionEnabled;
    },
    isManualOnly: function () {
      return isManualOnly;
    },
    getDelayMs: function () {
      return debounceDelayMs;
    }
  };
})(window);
