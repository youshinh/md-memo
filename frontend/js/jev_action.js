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

  const DEBOUNCE_MS = 300;

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
          <span class="jev-badge">Jev 3-Beam</span>
          <span class="jev-sub">直交自律アクション候補</span>
        </div>
        <div class="jev-hints">
          <span class="jev-kbd">1..3</span> 選択 / <span class="jev-kbd">Tab</span> 移動 / <span class="jev-kbd">Enter</span> 確定 / <span class="jev-kbd">Esc</span> 閉じる
        </div>
      </div>
      <div class="jev-slots" id="jev-slots-container"></div>
      <div class="jev-status hidden" id="jev-status-bar"></div>
    `;

    // Append to workspace or editor wrapper
    const wrapper = document.getElementById('editor-wrapper') || document.body;
    wrapper.appendChild(jevPanelEl);
  }

  function bindEvents() {
    // 1. Debounced keystroke stillness detection (300ms)
    editorEl.addEventListener('input', () => {
      hidePanel();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(triggerJevPrediction, DEBOUNCE_MS);
    });

    // 2. Keyboard handling for selection and dismissal
    editorEl.addEventListener('keydown', (e) => {
      if (!isPanelVisible || isExecuting) return;

      if (e.key === 'Escape') {
        hidePanel();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % currentCandidates.length;
        renderSlots();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (currentCandidates.length > 0 && selectedIndex < currentCandidates.length) {
          e.preventDefault();
          executeCandidate(currentCandidates[selectedIndex]);
        }
        return;
      }

      // Quick digit shortcuts: 1, 2, 3 (or Alt+1, Alt+2, Alt+3)
      if (['1', '2', '3'].includes(e.key) && (e.altKey || !hasModifiers(e))) {
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

  function hasModifiers(e) {
    return e.ctrlKey || e.metaKey || e.shiftKey;
  }

  async function triggerJevPrediction() {
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
  }

  async function executeCandidate(candidate) {
    if (!candidate || isExecuting) return;
    isExecuting = true;

    const command = candidate.command || candidate.Command || '';
    const statusBar = document.getElementById('jev-status-bar');
    if (statusBar) {
      statusBar.classList.remove('hidden');
      statusBar.innerHTML = `<span class="jev-spinner">⏳</span> 実行中: <code>${escapeHTML(command)}</code>`;
    }

    try {
      const fullText = editorEl.value;
      const res = await window.backend.jevExecute(JSON.stringify(candidate), fullText);

      if (res && res.success) {
        insertMarkdownResult(res.markdown);
        hidePanel();
      } else {
        const errMsg = res && res.error ? res.error : '実行に失敗しました';
        if (statusBar) {
          statusBar.innerHTML = `<span class="jev-err">❌ 実行拒否/失敗:</span> ${escapeHTML(errMsg)}`;
        }
        setTimeout(hidePanel, 3000);
      }
    } catch (err) {
      if (statusBar) {
        statusBar.innerHTML = `<span class="jev-err">❌ エラー:</span> ${escapeHTML(String(err))}`;
      }
      setTimeout(hidePanel, 3000);
    } finally {
      isExecuting = false;
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

  // Export for testing
  global.JevAction = {
    init: initJevIntegration,
    triggerJevPrediction: triggerJevPrediction,
    hidePanel: hidePanel
  };
})(window);
