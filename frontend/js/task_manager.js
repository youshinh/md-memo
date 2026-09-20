// MD-Memo Task Manager
// Background Task Lifecycle Management, Progress Tracking, Hover Peek & Cancel Controls
(function (global) {
  'use strict';

  const tasks = new Map(); // id -> TaskInfo
  const completedHistory = []; // list of completed/canceled/failed tasks
  const MAX_HISTORY = 10;

  let pollTimer = null;
  let isPanelVisible = false;

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

    // Global keyboard shortcut: Alt+T to toggle tasks panel
    document.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (e.key === 'Escape' && isPanelVisible) {
        hidePanel();
      }
    });

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
      type: opts.type || 'slot', // 'slot' | 'action' | 'llm'
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

    // Direct backend cancel
    if (window.backend && window.backend.cancelSlotAgent) {
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

      // Query latest stdout/stderr hover peek for slot tasks
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
    if (statTasksEl && statTasksCountEl) {
      if (activeCount > 0) {
        statTasksEl.classList.remove('hidden');
        statTasksEl.classList.add('task-running');
        statTasksCountEl.textContent = `実行中: ${activeCount}件`;
        statTasksEl.title = `実行中タスク: ${activeCount}件 (Alt+T でタスク一覧を開く)`;
      } else if (completedHistory.length > 0 && Date.now() - (completedHistory[0].endTime || 0) < 4000) {
        // Show brief completion indicator for 4 seconds
        statTasksEl.classList.remove('hidden');
        statTasksEl.classList.remove('task-running');
        const last = completedHistory[0];
        if (last.status === 'completed') {
          statTasksCountEl.textContent = 'タスク: 完了';
        } else if (last.status === 'canceled') {
          statTasksCountEl.textContent = 'タスク: 中断';
        } else {
          statTasksCountEl.textContent = 'タスク: 失敗';
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

    if (activeCount === 0 && completedHistory.length === 0) {
      tasksListEl.innerHTML = `
        <div class="tasks-empty-state">
          <svg class="tasks-empty-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span class="tasks-empty-text">現在動作しているタスクはありません</span>
        </div>
      `;
      return;
    }

    let html = '';

    // Active tasks section
    if (activeCount > 0) {
      html += '<div class="tasks-section-title">実行中</div>';
      active.forEach((task) => {
        const elapsed = formatElapsed(Date.now() - task.startTime);
        const safeAgent = escapeHTML(task.agent);
        const safeInstruction = escapeHTML(task.instruction || '(指示なし)');
        const safeOutput = escapeHTML(task.lastOutput || 'プロセス待機中...');

        html += `
          <div class="task-card task-card-running" data-task-id="${escapeHTML(task.id)}">
            <div class="task-card-header">
              <span class="task-agent-badge">${safeAgent}</span>
              <span class="task-instruction" title="${safeInstruction}">${safeInstruction}</span>
              <button class="btn-task-cancel" data-cancel-id="${escapeHTML(task.id)}" title="タスクを強制終了">中断</button>
            </div>
            <div class="task-card-meta">
              <span class="cli-spinner cli-spinner-sm"></span>
              <span class="task-status-text">実行中 (${elapsed})</span>
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
      html += '<div class="tasks-section-title tasks-history-title">直近の履歴</div>';
      completedHistory.slice(0, 5).forEach((task) => {
        const duration = formatElapsed((task.endTime || Date.now()) - task.startTime);
        const safeAgent = escapeHTML(task.agent);
        const safeInstruction = escapeHTML(task.instruction || '(指示なし)');

        let statusClass = 'task-status-completed';
        let statusLabel = '完了';
        if (task.status === 'canceled') {
          statusClass = 'task-status-canceled';
          statusLabel = '中断';
        } else if (task.status === 'failed') {
          statusClass = 'task-status-failed';
          statusLabel = '失敗';
        }

        html += `
          <div class="task-card task-card-history ${statusClass}">
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
          btn.textContent = '中断中...';
          cancelTask(tid);
        }
      });
    });
  }

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
    renderUI: renderUI
  };
})(window);
