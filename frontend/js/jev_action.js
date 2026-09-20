// MD-Memo x Jev Autonomous Action Integration
// Spec: Deterministic Governance, EBNF Grammar Constraint, MAP-Elites Orthogonal Triad Selection
(function (global) {
  'use strict';

  let editorEl = null;
  let panelEditor = null; // the pane the currently shown candidates belong to
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
    bindEvents(editorEl);
    // The app has two panes; Quick Actions must work in whichever one the user
    // is typing in (Ctrl+J from the secondary pane included).
    const secondaryEl = document.getElementById('editor-secondary');
    if (secondaryEl) bindEvents(secondaryEl);
    bindGlobalEvents();
  }

  // Resolve the editor the user is currently in, falling back to the primary pane.
  function getActiveEditor() {
    const el = document.activeElement;
    if (el && el.tagName === 'TEXTAREA' && (el.id === 'editor' || el.id === 'editor-secondary')) {
      return el;
    }
    if (typeof global.getActiveEditorEl === 'function') {
      const resolved = global.getActiveEditorEl();
      if (resolved) return resolved;
    }
    return editorEl;
  }

  function isEditorEl(el) {
    return !!el && el.tagName === 'TEXTAREA' && (el.id === 'editor' || el.id === 'editor-secondary');
  }

  // Generates a request id as `${prefix}${Date.now()}_${random}`. Callers must
  // keep passing their own existing prefix unchanged in case anything downstream
  // keys off it; only the random-suffix boilerplate is deduplicated here.
  function genReqId(prefix) {
    return prefix + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  }

  // 'Alt' on Windows/Linux, 'Option' on macOS. Falls back to 'Alt' when
  // platform.js hasn't loaded (e.g. this file required standalone under Node).
  function getAltLabel() {
    return (global.MDMemoPlatform && global.MDMemoPlatform.altLabel) || 'Alt';
  }

  // Extracts the physical digit ('1'/'2'/'3') from a KeyboardEvent, preferring
  // `.code` (unaffected by Option composing '¡'/'™'/'£' into `.key` on macOS)
  // and falling back to `.key` when `.code` isn't available (older engines,
  // or the synthetic events used by jev_action_test.js).
  function getPhysicalDigit(e) {
    if (global.MDMemoPlatform && typeof global.MDMemoPlatform.codeDigit === 'function') {
      const fromCode = global.MDMemoPlatform.codeDigit(e);
      if (fromCode) return fromCode;
    } else {
      const code = e && e.code;
      if (typeof code === 'string') {
        if (code.slice(0, 5) === 'Digit' && code.length === 6) return code.slice(5);
        if (code.slice(0, 6) === 'Numpad' && code.length === 7 && code[6] >= '0' && code[6] <= '9') return code.slice(6);
      }
    }
    return (e && ['1', '2', '3'].includes(e.key)) ? e.key : '';
  }

  function createJevPanelDOM() {
    if (document.getElementById('jev-action-panel')) return;

    const altLabel = getAltLabel();
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
          <span class="jev-kbd">${altLabel}+1..3</span> 選択 / <span class="jev-kbd">Tab</span> 移動 / <span class="jev-kbd">${altLabel}+Enter</span> 確定 / <span class="jev-kbd">Esc</span> 閉じる
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

  function bindEvents(targetEditor) {
    const ed = targetEditor || editorEl;
    if (!ed || ed.__jevActionAttached) return;
    ed.__jevActionAttached = true;

    // 0. IME composition events (suppress popups during Japanese composition)
    ed.addEventListener('compositionstart', () => {
      isComposing = true;
      hidePanel();
      clearTimeout(debounceTimer);
    });

    ed.addEventListener('compositionend', () => {
      isComposing = false;
      schedulePrediction();
    });

    // 1. Keystroke stillness detection (configurable debounce delay)
    ed.addEventListener('input', () => {
      hidePanel();
      clearTimeout(debounceTimer);
      if (isComposing) return;
      schedulePrediction();
    });

    // 2. Keyboard handling for selection, dismissal, and manual trigger
    ed.addEventListener('keydown', (e) => {
      // Manual trigger is no longer hardcoded here: it is bound via the customizable
      // shortcut registry in app.js (config.shortcuts.quickActions, default Ctrl+J / Cmd+J),
      // which calls window.JevAction.triggerJevPrediction() so users can rebind it.

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
      // metaKey (Cmd) is treated exactly like ctrlKey here so a Cmd+Enter on macOS
      // executes below instead of falling into this dismiss branch.
      if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        hidePanel();
        return;
      }

      // Explicit execution shortcut: Alt+Enter, Ctrl+Enter, or Cmd+Enter (macOS).
      if (e.key === 'Enter' && (e.altKey || ((e.ctrlKey || e.metaKey) && !e.shiftKey))) {
        if (currentCandidates.length > 0 && selectedIndex < currentCandidates.length) {
          e.preventDefault();
          // app.js's global (window-level) keydown handler also listens for
          // plain Ctrl/Cmd+Enter (LLM prompt modal) and other combos; this
          // panel's own handler must win while it is visible, so stop the
          // event here rather than letting it bubble up to that handler too.
          e.stopPropagation();
          executeCandidate(currentCandidates[selectedIndex]);
        }
        return;
      }

      // Quick digit shortcuts: Alt+1..3, Ctrl+1..3, or Cmd+1..3 (macOS).
      // Reads the PHYSICAL digit from e.code, not e.key: on macOS, holding
      // Option composes '¡'/'™'/'£' into e.key for 1/2/3, so a literal e.key
      // check would never match under Option. Falls back to e.key when
      // e.code isn't available.
      // CRITICAL: Plain '1', '2', '3' without a modifier must NOT be intercepted,
      // allowing standard number typing in the note!
      const physicalDigit = getPhysicalDigit(e);
      if (physicalDigit && (e.altKey || ((e.ctrlKey || e.metaKey) && !e.shiftKey))) {
        const idx = parseInt(physicalDigit, 10) - 1;
        if (idx >= 0 && idx < currentCandidates.length) {
          e.preventDefault();
          // Same rationale as the Enter branch above: app.js's global handler
          // uses Ctrl/Cmd+1 and Ctrl/Cmd+2 for pane-focus switching, which
          // would otherwise fire right after this on the same keystroke.
          e.stopPropagation();
          executeCandidate(currentCandidates[idx]);
        }
      }
    });
  }

  let globalEventsBound = false;
  function bindGlobalEvents() {
    if (globalEventsBound) return;
    globalEventsBound = true;

    // Hide panel on click outside or blur
    document.addEventListener('click', (e) => {
      if (isPanelVisible && jevPanelEl && !jevPanelEl.contains(e.target) && !isEditorEl(e.target)) {
        hidePanel();
      }
    });

    // The panel is docked relative to the caret; re-evaluate when the box moves.
    if (global.addEventListener) {
      global.addEventListener('resize', () => {
        if (isPanelVisible) repositionPanel();
      });
    }
  }

  async function triggerJevPrediction() {
    if (!isActionEnabled) return;
    if (isComposing) return;
    if (!window.backend || !window.backend.jevPredict) return;
    if (!isEditorEl(document.activeElement)) return;

    const activeEditor = document.activeElement;
    const fullText = activeEditor.value;
    const cursor = activeEditor.selectionStart;

    // Optional context extraction around cursor
    const startPos = Math.max(0, cursor - 1500);
    const endPos = Math.min(fullText.length, cursor + 500);
    const contextText = fullText.substring(startPos, endPos);

    try {
      const resp = await window.backend.jevPredict(contextText, cursor);
      if (resp && resp.candidates && resp.candidates.length > 0) {
        currentCandidates = resp.candidates;
        selectedIndex = 0;
        panelEditor = activeEditor;
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

  // Users can reconfigure slot delimiters in agents.yaml (trigger_open/trigger_close
  // on each slot_profile / recipe), so "does this command already look like a slot"
  // can't be hardcoded to the factory-default {{ }} / [? ] pair. Ask SlotAgent for
  // its live, merged config when available; fall back to the historical defaults
  // when it isn't (e.g. this file loaded standalone under the Node unit tests).
  const DEFAULT_TRIGGER_OPENS = ['{{', '[?'];
  const DEFAULT_PROFILE_DELIMS = { open: '{{', close: '}}' };

  function getLiveSlotConfig() {
    try {
      if (window.SlotAgent && typeof window.SlotAgent.getConfig === 'function') {
        return window.SlotAgent.getConfig() || null;
      }
    } catch (e) { /* ignore, fall back below */ }
    return null;
  }

  // All trigger_open strings currently configured (slot profiles + recipes).
  function getConfiguredTriggerOpens() {
    const cfg = getLiveSlotConfig();
    if (!cfg) return DEFAULT_TRIGGER_OPENS;

    const opens = [];
    (cfg.slot_profiles || []).forEach((p) => { if (p && p.trigger_open) opens.push(p.trigger_open); });
    (cfg.recipes || []).forEach((r) => { if (r && r.trigger_open) opens.push(r.trigger_open); });
    return opens.length ? opens : DEFAULT_TRIGGER_OPENS;
  }

  // The delimiters to wrap a bare instruction in when turning it into a slot.
  // Uses the first configured slot_profile (the "default" one, e.g. {{ }} unless
  // the user reordered/renamed it), falling back to the factory default.
  function getDefaultProfileDelimiters() {
    const cfg = getLiveSlotConfig();
    const first = cfg && Array.isArray(cfg.slot_profiles) && cfg.slot_profiles[0];
    if (first && first.trigger_open && first.trigger_close) {
      return { open: first.trigger_open, close: first.trigger_close };
    }
    return DEFAULT_PROFILE_DELIMS;
  }

  function commandLooksLikeSlot(command) {
    return getConfiguredTriggerOpens().some((open) => command.startsWith(open));
  }

  // Single source of truth for "what will actually happen" when a candidate is chosen.
  // Mirrors the routing decision in executeCandidate(), so the card label can never
  // disagree with what pressing it actually does.
  function classifyActionKind(actType, command) {
    if (actType === 'slot' || actType === 'ai' || commandLooksLikeSlot(command)) {
      return 'delegate'; // 任せる: hands off to an external agent in the background
    }
    if (actType === 'sh') {
      return 'run'; // 実行する: shell command execution
    }
    return 'write'; // 書く: built-in LLM generates/edits text
  }

  // Bilingual-safe fallback (always Japanese) used when I18N / config are unavailable,
  // e.g. when this file is loaded under plain Node for unit tests.
  const VERB_LABEL_FALLBACK = {
    delegate: { tag: '任せる', sub: 'エージェントがバックグラウンドで作業' },
    run: { tag: '実行', sub: 'コマンドを実行して結果を挿入' },
    write: { tag: '書く', sub: 'AIが文章を生成して挿入' }
  };

  const VERB_LABEL_KEYS = {
    delegate: { tagKey: 'jevVerbDelegateTag', subKey: 'jevVerbDelegateSub' },
    run: { tagKey: 'jevVerbRunTag', subKey: 'jevVerbRunSub' },
    write: { tagKey: 'jevVerbWriteTag', subKey: 'jevVerbWriteSub' }
  };

  // Least-invasive language detection: app.js's applyLanguage() sets
  // document.documentElement.lang, so we read that instead of reaching into
  // app.js's private `config` closure variable (which isn't exposed on window).
  function getUILang() {
    try {
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en') {
        return 'en';
      }
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  function getVerbLabel(kind) {
    const fallback = VERB_LABEL_FALLBACK[kind] || VERB_LABEL_FALLBACK.write;
    const keys = VERB_LABEL_KEYS[kind] || VERB_LABEL_KEYS.write;
    try {
      const lang = getUILang();
      if (typeof I18N !== 'undefined' && I18N[lang] && I18N[lang][keys.tagKey] && I18N[lang][keys.subKey]) {
        return { tag: I18N[lang][keys.tagKey], sub: I18N[lang][keys.subKey] };
      }
    } catch (e) { /* ignore, fall back below */ }
    return fallback;
  }

  function renderSlots() {
    const container = document.getElementById('jev-slots-container');
    if (!container) return;

    container.innerHTML = '';

    currentCandidates.forEach((cand, idx) => {
      const isSel = idx === selectedIndex;
      const actType = (cand.action_type || cand.ActionType || 'sh').toLowerCase();
      const command = cand.command || cand.Command || '';
      const desc = cand.description || cand.Description || '';

      const kind = classifyActionKind(actType, command);
      const verbLabel = getVerbLabel(kind);

      const card = document.createElement('div');
      card.className = `jev-slot-card ${isSel ? 'selected' : ''} jev-type-${actType}`;
      card.innerHTML = `
        <div class="jev-slot-top">
          <span class="jev-slot-num">${idx + 1}</span>
          <span class="jev-slot-tag jev-tag-${actType}">${escapeHTML(verbLabel.tag)}</span>
          <span class="jev-slot-axis">${escapeHTML(verbLabel.sub)}</span>
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

  function dockPanel(edge) {
    if (!jevPanelEl || !jevPanelEl.style) return;
    if (edge === 'top') {
      jevPanelEl.style.bottom = 'auto';
      jevPanelEl.style.top = '24px';
    } else {
      jevPanelEl.style.top = 'auto';
      jevPanelEl.style.bottom = '24px';
    }
  }

  // The panel auto-appears while the user is still in the note, so it must never
  // sit on the line being edited: dock it to whichever vertical edge is clear.
  function repositionPanel() {
    if (!jevPanelEl) return;
    const ed = panelEditor || getActiveEditor();
    const wrapper = jevPanelEl.parentElement;
    if (!ed || !wrapper) return;
    if (typeof wrapper.getBoundingClientRect !== 'function') return;
    if (typeof ed.getBoundingClientRect !== 'function') return;
    if (typeof global.getCharPixelCoords !== 'function') return;

    try {
      const panelH = jevPanelEl.offsetHeight || 0;
      if (!panelH) return;

      const coords = global.getCharPixelCoords(ed.selectionStart, ed);
      const edRect = ed.getBoundingClientRect();
      const wrapRect = wrapper.getBoundingClientRect();

      let lineH = 22;
      try {
        const parsed = parseFloat(global.getComputedStyle(ed).lineHeight);
        if (!isNaN(parsed) && parsed > 0) lineH = parsed;
      } catch (e) { /* keep default */ }

      const caretTop = (edRect.top - wrapRect.top) + coords.top - (ed.scrollTop || 0);
      const caretBottom = caretTop + lineH;

      const gap = 24;
      const bottomDockTop = wrapRect.height - gap - panelH;
      const topDockBottom = gap + panelH;

      const hitsBottomDock = caretBottom > bottomDockTop;
      if (!hitsBottomDock) {
        dockPanel('bottom');
        return;
      }
      const hitsTopDock = caretTop < topDockBottom;
      if (!hitsTopDock) {
        dockPanel('top');
        return;
      }
      // Both edges collide (very short pane): pick the edge farther from the caret.
      dockPanel(caretTop > wrapRect.height / 2 ? 'top' : 'bottom');
    } catch (err) {
      /* positioning is best-effort; keep the CSS default */
    }
  }

  function showPanel() {
    if (!jevPanelEl) return;
    // Follow the active pane (same invariant as #cursor-aura).
    const ed = panelEditor || getActiveEditor();
    const wrapper = ed && ed.parentElement;
    if (wrapper && jevPanelEl.parentElement !== wrapper && typeof wrapper.appendChild === 'function') {
      wrapper.appendChild(jevPanelEl);
    }
    jevPanelEl.classList.remove('hidden');
    isPanelVisible = true;
    repositionPanel();
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

    // Act on the pane these candidates were predicted for.
    const targetEditor = panelEditor || getActiveEditor();

    // 1. Slot / Agent delegation / AI instructions: insert directly into note and trigger SlotAgent
    if (classifyActionKind(actType, command) === 'delegate') {
      hidePanel();
      let slotSnippet = command;
      if (!commandLooksLikeSlot(command)) {
        const delims = getDefaultProfileDelimiters();
        slotSnippet = `${delims.open} ${command} ${delims.close}`;
      }
      insertSlotAndTrigger(slotSnippet, targetEditor);
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
      const fullText = targetEditor ? targetEditor.value : '';
      const res = await runBackendJevExecute(candidate, fullText);

      if (res && res.success) {
        insertMarkdownResult(res.markdown, targetEditor);
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
        const reqId = genReqId('jev_');

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
        resolve({ success: false, error: 'アクション候補のバックエンドが利用できません' });
      }
    });
  }

  function insertSlotAndTrigger(slotText, targetEditor) {
    const ed = targetEditor || getActiveEditor();
    if (!slotText || !ed) return;

    const curPos = ed.selectionStart;
    const text = ed.value;

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
    ed.value = before + insertion + after;

    const newCursor = insertPos + insertion.length;
    ed.selectionStart = newCursor;
    ed.selectionEnd = newCursor;

    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();

    // Trigger SlotAgent execution asynchronously
    if (window.SlotAgent && window.SlotAgent.triggerSlotExecution) {
      setTimeout(() => {
        window.SlotAgent.triggerSlotExecution(ed);
      }, 50);
    }
  }

  function insertMarkdownResult(markdown, targetEditor) {
    const ed = targetEditor || getActiveEditor();
    if (!markdown || !ed) return;

    const curPos = ed.selectionStart;
    const text = ed.value;

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
    ed.value = before + insertion + after;

    const newCursor = insertPos + insertion.length;
    ed.selectionStart = newCursor;
    ed.selectionEnd = newCursor;

    // Dispatch input event to trigger autosave and live preview
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    ed.focus();
  }

  // Kept byte-identical to task_manager.js's escapeHTML() and app.js's escapeHtml()
  // — see tests/escape_html_parity_test.mjs.
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
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
