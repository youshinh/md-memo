// MD-Memo Task Manager
// Background Task Lifecycle Management, Progress Tracking, Hover Peek & Cancel Controls
(function (global) {
  'use strict';

  const tasks = new Map(); // id -> TaskInfo
  const completedHistory = []; // list of completed/canceled/failed tasks
  const MAX_HISTORY = 10;

  let pollTimer = null;
  let isPanelVisible = false;
  let completionBadgeTimer = null;
  let hoverPeekEnabled = true;

  const COMPLETION_BADGE_MS = 4000;

  // Least-invasive language detection, same technique jev_action.js uses:
  // app.js's applyLanguage() sets document.documentElement.lang, so read that
  // instead of reaching into app.js's private `config` closure variable.
  function getUILang() {
    try {
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en') {
        return 'en';
      }
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  // 'Alt' on Windows/Linux, 'Option' on macOS (platform.js loads before this
  // file in index.html). Falls back to 'Alt' when platform.js hasn't run, e.g.
  // this file required standalone under the Node unit tests.
  function getAltLabel() {
    return (global.MDMemoPlatform && global.MDMemoPlatform.altLabel) || 'Alt';
  }

  // Bilingual-safe fallback (always Japanese, matching what this file always
  // hardcoded) used when I18N isn't loaded, e.g. under plain Node for the
  // unit tests in task_manager_test.js.
  const TASK_I18N_FALLBACK_JA = {
    taskRunningBadge: '実行中: {count}件',
    taskRunningTooltip: '実行中タスク: {count}件 ({alt}+T でタスク一覧を開く)',
    taskDoneBadge: 'タスク: 完了',
    taskCanceledBadge: 'タスク: 中断',
    taskFailedBadge: 'タスク: 失敗',
    taskSectionRunning: '実行中',
    taskSectionHistory: '直近の履歴',
    taskRunningStatus: '実行中 ({elapsed})',
    taskStatusDone: '完了',
    taskStatusCanceled: '中断',
    taskStatusFailed: '失敗',
    taskNoInstruction: '(指示なし)',
    taskWaitingProcess: 'プロセス待機中...',
    taskCancelTitle: 'タスクを強制終了',
    taskCancelLabel: '中断',
    taskCancelingLabel: '中断中...',
    taskEmptyState: '現在動作しているタスクはありません'
  };

  function tt(key, params) {
    let text;
    try {
      const lang = getUILang();
      if (typeof I18N !== 'undefined' && I18N[lang] && I18N[lang][key] !== undefined) {
        text = I18N[lang][key];
      }
    } catch (e) { /* ignore, fall back below */ }
    if (text === undefined) {
      text = TASK_I18N_FALLBACK_JA[key] || key;
    }
    if (params) {
      Object.keys(params).forEach((k) => {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
      });
    }
    return text;
  }

  // The tasks list DOM is only worth rebuilding when the user can actually see it.
  function isListObservable() {
    return isPanelVisible && !(typeof document !== 'undefined' && document.hidden);
  }

  // DOM elements
  let statTasksEl = null;
  let statTasksCountEl = null;
  let tasksPanelEl = null;
  let tasksListEl = null;
  let activeCountBadgeEl = null;

  function init() {
    statTasksEl = document.getElementById('stat-tasks');
    statTasksCountEl = document.getElementById('stat-tasks-count');
    tasksPanelEl = document.getElementById('running-tasks-panel');
    tasksListEl = document.getElementById('tasks-panel-list');
    activeCountBadgeEl = document.getElementById('tasks-active-count');

    if (statTasksEl) {
      statTasksEl.addEventListener('click', () => {
        togglePanel();
      });
    }

    const btnClose = document.getElementById('btn-tasks-close');
    if (btnClose) {
      btnClose.addEventListener('click', () => {
        hidePanel();
      });
    }

    const btnClear = document.getElementById('btn-tasks-clear-history');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        clearHistory();
      });
    }

    // Global keyboard shortcut: Alt+T (Option+T on macOS) to toggle tasks panel.
    // On macOS, holding Option composes 't' into '†' in e.key, so e.key checks
    // alone would never match; e.code stays the physical 'KeyT' regardless.
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (e.key === 'Escape' && isPanelVisible) {
        hidePanel();
      }
    });

    // Render once as soon as the window becomes visible again (tray restore),
    // since list rebuilds are skipped while hidden.
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) renderUI();
      });
    }

    renderUI();
  }

  function getActiveTasks() {
    return Array.from(tasks.values()).filter(t => t.status === 'running');
  }

  function getActiveCount() {
    return getActiveTasks().length;
  }

  function addTask(opts) {
    if (!opts || !opts.id) return null;

    const task = {
      id: opts.id,
      type: opts.type || 'slot', // 'slot' | 'action' | 'llm' | 'command'
      agent: opts.agent || 'Agent',
      instruction: opts.instruction || '',
      status: 'running', // 'running' | 'completed' | 'failed' | 'canceled'
      startTime: opts.startTime || Date.now(),
      endTime: null,
      lastOutput: '',
      error: null,
      onCancel: opts.onCancel || null
    };

    tasks.set(task.id, task);
    startPolling();
    renderUI();

    return task;
  }

  function updateTask(id, updates) {
    if (!id || !tasks.has(id)) return;
    const task = tasks.get(id);

    if (updates.status && updates.status !== task.status) {
      task.status = updates.status;
      if (['completed', 'failed', 'canceled'].includes(updates.status)) {
        task.endTime = updates.endTime || Date.now();
        // Move to history
        completedHistory.unshift({ ...task });
        if (completedHistory.length > MAX_HISTORY) {
          completedHistory.pop();
        }
        tasks.delete(id);
      }
    }

    if (updates.lastOutput !== undefined) {
      task.lastOutput = updates.lastOutput;
    }
    if (updates.error !== undefined) {
      task.error = updates.error;
    }

    if (getActiveCount() === 0) {
      stopPolling();
    }

    renderUI();
  }

  function cancelTask(id) {
    if (!id) return;
    let task = tasks.get(id);
    if (!task) {
      return;
    }

    // Call onCancel callback if registered
    if (typeof task.onCancel === 'function') {
      try {
        task.onCancel();
      } catch (err) {
        console.error('Task onCancel error:', err);
      }
    }

    // Direct backend cancel (a command task has no slot process: its onCancel stops the command itself)
    if (task.type !== 'command' && window.backend && window.backend.cancelSlotAgent) {
      try {
        window.backend.cancelSlotAgent(id);
      } catch (err) {
        console.error('backend.cancelSlotAgent error:', err);
      }
    }

    updateTask(id, {
      status: 'canceled',
      endTime: Date.now()
    });
  }

  function clearHistory() {
    completedHistory.length = 0;
    renderUI();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const active = getActiveTasks();
      if (active.length === 0) {
        stopPolling();
        return;
      }

      // Query latest stdout/stderr hover peek for slot tasks.
      // Only worth the RPC when the peek is actually displayed (panel open,
      // window not hidden in the tray) and the feature is enabled.
      if (hoverPeekEnabled && isListObservable()) {
        for (const t of active) {
          if (t.type === 'slot' && window.backend && window.backend.getSlotHoverPeek) {
            try {
              const peek = await window.backend.getSlotHoverPeek(t.id);
              if (peek && peek !== t.lastOutput) {
                t.lastOutput = peek;
              }
            } catch (e) {
              // ignore peek errors
            }
          }
        }
      }

      renderUI();
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function togglePanel() {
    if (isPanelVisible) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function showPanel() {
    if (!tasksPanelEl) return;
    tasksPanelEl.classList.remove('hidden');
    isPanelVisible = true;
    renderUI();
  }

  function hidePanel() {
    if (!tasksPanelEl) return;
    tasksPanelEl.classList.add('hidden');
    isPanelVisible = false;
  }

  function formatElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}分${remSec}秒`;
  }

  function renderUI() {
    const active = getActiveTasks();
    const activeCount = active.length;

    // 1. Update Status Bar Badge
    if (completionBadgeTimer) {
      clearTimeout(completionBadgeTimer);
      completionBadgeTimer = null;
    }
    if (statTasksEl && statTasksCountEl) {
      if (activeCount > 0) {
        statTasksEl.classList.remove('hidden');
        statTasksEl.classList.add('task-running');
        statTasksCountEl.textContent = tt('taskRunningBadge', { count: activeCount });
        statTasksEl.title = tt('taskRunningTooltip', { count: activeCount, alt: getAltLabel() });
      } else if (completedHistory.length > 0 && Date.now() - (completedHistory[0].endTime || 0) < COMPLETION_BADGE_MS) {
        // Show brief completion indicator for 4 seconds.
        // Polling has already stopped by now, so schedule the one re-render that
        // retires the badge once the window elapses (otherwise it stays forever).
        const remaining = COMPLETION_BADGE_MS - (Date.now() - (completedHistory[0].endTime || 0));
        completionBadgeTimer = setTimeout(() => {
          completionBadgeTimer = null;
          renderUI();
        }, Math.max(0, remaining) + 50);
        statTasksEl.classList.remove('hidden');
        statTasksEl.classList.remove('task-running');
        const last = completedHistory[0];
        if (last.status === 'completed') {
          statTasksCountEl.textContent = tt('taskDoneBadge');
        } else if (last.status === 'canceled') {
          statTasksCountEl.textContent = tt('taskCanceledBadge');
        } else {
          statTasksCountEl.textContent = tt('taskFailedBadge');
        }
      } else {
        statTasksEl.classList.add('hidden');
        statTasksEl.classList.remove('task-running');
      }
    }

    if (activeCountBadgeEl) {
      activeCountBadgeEl.textContent = String(activeCount);
    }

    // 2. Update Tasks Panel if visible
    if (!tasksListEl) return;
    // Rebuilding the list is pure waste while the panel is closed or the window
    // is hidden in the tray; showPanel()/visibilitychange re-render immediately.
    if (!isListObservable()) return;

    if (activeCount === 0 && completedHistory.length === 0) {
      tasksListEl.innerHTML = `
        <div class="tasks-empty-state">
          <svg class="tasks-empty-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span class="tasks-empty-text">${escapeHTML(tt('taskEmptyState'))}</span>
        </div>
      `;
      return;
    }

    let html = '';

    // Active tasks section
    if (activeCount > 0) {
      html += `<div class="tasks-section-title">${escapeHTML(tt('taskSectionRunning'))}</div>`;
      active.forEach((task) => {
        const elapsed = formatElapsed(Date.now() - task.startTime);
        const safeAgent = escapeHTML(task.agent);
        const safeInstruction = escapeHTML(task.instruction || tt('taskNoInstruction'));
        const safeOutput = escapeHTML((hoverPeekEnabled ? task.lastOutput : '') || tt('taskWaitingProcess'));

        html += `
          <div class="task-card task-card-running" data-task-id="${escapeHTML(task.id)}" data-task-type="${escapeHTML(task.type)}">
            <div class="task-card-header">
              <span class="task-agent-badge">${safeAgent}</span>
              <span class="task-instruction" title="${safeInstruction}">${safeInstruction}</span>
              <button class="btn-task-cancel" data-cancel-id="${escapeHTML(task.id)}" title="${escapeHTML(tt('taskCancelTitle'))}">${escapeHTML(tt('taskCancelLabel'))}</button>
            </div>
            <div class="task-card-meta">
              <span class="cli-spinner cli-spinner-sm"></span>
              <span class="task-status-text">${escapeHTML(tt('taskRunningStatus', { elapsed }))}</span>
            </div>
            <div class="task-card-log">
              <code class="task-log-text">${safeOutput}</code>
            </div>
          </div>
        `;
      });
    }

    // Completed history section
    if (completedHistory.length > 0) {
      html += `<div class="tasks-section-title tasks-history-title">${escapeHTML(tt('taskSectionHistory'))}</div>`;
      completedHistory.slice(0, 5).forEach((task) => {
        const duration = formatElapsed((task.endTime || Date.now()) - task.startTime);
        const safeAgent = escapeHTML(task.agent);
        const safeInstruction = escapeHTML(task.instruction || tt('taskNoInstruction'));

        let statusClass = 'task-status-completed';
        let statusLabel = tt('taskStatusDone');
        if (task.status === 'canceled') {
          statusClass = 'task-status-canceled';
          statusLabel = tt('taskStatusCanceled');
        } else if (task.status === 'failed') {
          statusClass = 'task-status-failed';
          statusLabel = tt('taskStatusFailed');
        }

        html += `
          <div class="task-card task-card-history ${statusClass}" data-task-type="${escapeHTML(task.type)}">
            <div class="task-card-header">
              <span class="task-agent-badge badge-dim">${safeAgent}</span>
              <span class="task-instruction" title="${safeInstruction}">${safeInstruction}</span>
              <span class="task-status-pill ${statusClass}">${statusLabel} (${duration})</span>
            </div>
            ${task.error ? `<div class="task-card-error">${escapeHTML(task.error)}</div>` : ''}
          </div>
        `;
      });
    }

    tasksListEl.innerHTML = html;

    // Bind cancel buttons
    const cancelBtns = tasksListEl.querySelectorAll('.btn-task-cancel');
    cancelBtns.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.getAttribute('data-cancel-id');
        if (tid) {
          btn.disabled = true;
          btn.textContent = tt('taskCancelingLabel');
          cancelTask(tid);
        }
      });
    });
  }

  // Kept byte-identical to jev_action.js's escapeHTML() and app.js's escapeHtml()
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
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Global export
  global.TaskManager = {
    init: init,
    addTask: addTask,
    updateTask: updateTask,
    cancelTask: cancelTask,
    clearHistory: clearHistory,
    getActiveTasks: getActiveTasks,
    getActiveCount: getActiveCount,
    togglePanel: togglePanel,
    showPanel: showPanel,
    hidePanel: hidePanel,
    renderUI: renderUI,
    updateConfig: function (cfg) {
      if (!cfg) return;
      if (cfg.hover_peek_enabled !== undefined) {
        hoverPeekEnabled = cfg.hover_peek_enabled !== false;
        renderUI();
      }
    },
    isHoverPeekEnabled: function () {
      return hoverPeekEnabled;
    }
  };
})(window);
