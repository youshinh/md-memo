// MD-Notepad Core Application Logic (High Performance, Autocomplete & Clean Minimalist UI)
(function () {
  'use strict';

  // State
  let tabs = [];
  let activeTabId = null;
  let tabCounter = 1;
  let isPreviewMode = false;
  let autoSaveTimer = null;
  let autocompleteTimer = null;
  let currentAutocompleteReqId = null;
  let ghostSuggestion = '';
  let ghostTargetCursor = 0;
  let cursorAuraTimer = null;
  let cursorAuraFadeTimer = null;
  let lastCursorAuraPos = -1;
  const CURSOR_AURA_IDLE_DELAY = 1200;

  let pendingLLMRequests = new Map();
  let cachedLineCount = 0;
  let rendererLibsLoaded = false;
  let mdInstance = null;

  let currentLLMPromptContext = null;

  let config = {
    text: {
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:latest',
      apiKey: '',
      systemPrompt: 'You are a helpful assistant. Provide concise, accurate markdown responses.'
    },
    autocomplete: {
      enabled: true,
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:latest',
      apiKey: '',
      delayMs: 500,
      maxTokens: 30
    },
    vision: {
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-flash-lite-latest',
      apiKey: '',
      prompt: 'Transcribe the content of this image (text, diagrams, tables, code, etc.) into structured, faithful Markdown format.'
    },
    general: {
      language: 'en',
      theme: 'olive',
      autoSave: true,
      pasteImageOcr: true,
      restoreSession: true,
      trayResident: true,
      splitViewOnStartup: false,
      imeGuardian: true,
      aiCorrection: true,
      cursorAura: true
    },
    shortcuts: {}
  };

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);

  const DEFAULT_SHORTCUTS_WIN = {
    newTab: 'Ctrl+N',
    openFile: 'Ctrl+O',
    openFolder: 'Ctrl+Shift+O',
    saveFile: 'Ctrl+S',
    saveFileAs: 'Ctrl+Shift+S',
    find: 'Ctrl+F',
    replace: 'Ctrl+H',
    gotoLine: 'Ctrl+G',
    quickPick: 'Ctrl+Shift+P',
    togglePreview: 'Ctrl+P',
    toggleSplit: 'Ctrl+\\',
    zenMode: 'Ctrl+Shift+Z',
    minimize: '',
    toggleMaximize: 'F11',
    inlinePrompt: 'Ctrl+K',
    llmModal: 'Ctrl+L',
    aiCorrection: 'Alt+C',
    convertMermaid: '',
    mermaidToImage: '',
    exportPlainText: '',
    insertDate: 'F5'
  };

  const DEFAULT_SHORTCUTS_MAC = {
    newTab: 'Cmd+N',
    openFile: 'Cmd+O',
    openFolder: 'Cmd+Shift+O',
    saveFile: 'Cmd+S',
    saveFileAs: 'Cmd+Shift+S',
    find: 'Cmd+F',
    replace: 'Cmd+Option+F',
    gotoLine: 'Cmd+G',
    quickPick: 'Cmd+Shift+P',
    togglePreview: 'Cmd+P',
    toggleSplit: 'Cmd+\\',
    zenMode: 'Cmd+Shift+Z',
    minimize: 'Cmd+M',
    toggleMaximize: 'Ctrl+Cmd+F',
    inlinePrompt: 'Cmd+K',
    llmModal: 'Cmd+L',
    aiCorrection: 'Cmd+Shift+C',
    convertMermaid: '',
    mermaidToImage: '',
    exportPlainText: '',
    insertDate: 'Cmd+Shift+I'
  };

  const DEFAULT_SHORTCUTS = isMac ? DEFAULT_SHORTCUTS_MAC : DEFAULT_SHORTCUTS_WIN;

  config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);

  // Zero-Overhead Fast i18n Translation Helper
  function t(key, params) {
    const lang = (config.general && config.general.language) || 'en';
    const dict = (typeof I18N !== 'undefined' && I18N[lang]) || (typeof I18N !== 'undefined' && I18N['en']) || {};
    let text = dict[key] !== undefined ? dict[key] : (typeof I18N !== 'undefined' && I18N['en'] && I18N['en'][key] !== undefined ? I18N['en'][key] : key);
    if (params && typeof text === 'string') {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
      }
    }
    return text;
  }

  function applyTheme() {
    const theme = (config.general && config.general.theme) || 'olive';
    document.body.classList.remove('theme-olive', 'theme-blue', 'theme-forest', 'theme-charcoal');
    document.body.classList.add('theme-' + theme);
  }

  function applyLanguage() {
    const lang = (config.general && config.general.language) || 'en';
    document.documentElement.lang = lang;

    // Translate all elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });

    // Translate titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = t(key);
    });

    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = t(key);
    });

    // Update status bar texts
    if (statAutosave) {
      statAutosave.textContent = config.general.autoSave ? t('statAutosaveOn') : t('statAutosaveOff');
    }
    if (statAutocomplete && !statAutocomplete.textContent.includes('Error') && !statAutocomplete.textContent.includes('エラー')) {
      statAutocomplete.textContent = config.autocomplete.enabled ? t('statAutocompleteOn') : t('statAutocompleteOff');
      statAutocomplete.title = config.autocomplete.enabled ? t('statAutocompleteTooltip') : t('statAutocompleteOffTooltip');
    }
    if (statIme) {
      statIme.textContent = (config.general && config.general.imeGuardian !== false) ? t('statImeOn') : t('statImeOff');
      statIme.title = t('statImeTooltip');
      statIme.style.opacity = (config.general && config.general.imeGuardian !== false) ? '1' : '0.6';
    }
    if (btnTogglePreview) btnTogglePreview.title = isPreviewMode ? t('edit') : t('togglePreviewTitle');
    if (btnToggleSplit) btnToggleSplit.title = t('splitViewTitle');
  }

  // State Variables
  let isSplitMode = false;
  let splitRatio = 0.5;
  let activePane = 'primary'; // 'primary' | 'secondary'
  let secondaryTabId = null;
  let secondaryViewMode = 'editor'; // 'editor' | 'preview'
  let syncScrollEnabled = true;

  // DOM Elements
  const tabsListEl = document.getElementById('tabs-list');
  const btnNewTab = document.getElementById('btn-new-tab');
  const btnOpenFile = document.getElementById('btn-open-file');
  const btnOpenFolder = document.getElementById('btn-open-folder');
  const btnSaveFile = document.getElementById('btn-save-file');
  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  const btnToggleSplit = document.getElementById('btn-toggle-split');
  const btnPreviewSide = document.getElementById('btn-preview-side');
  const btnFind = document.getElementById('btn-find');
  const btnHeaderLLM = document.getElementById('btn-header-llm');
  const btnSettings = document.getElementById('btn-settings');
  const workspaceEl = document.getElementById('workspace');
  const editorPane = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  const editorEl = document.getElementById('editor');
  const cursorAuraEl = document.getElementById('cursor-aura');
  const ghostOverlayEl = document.getElementById('ghost-overlay');
  const lineNumbersEl = document.getElementById('line-numbers');

  // Secondary Pane Elements
  const secondaryPane = document.getElementById('secondary-pane');
  const secondaryPaneHeader = document.getElementById('secondary-pane-header');
  const secondaryPaneTitle = document.getElementById('secondary-pane-title');
  const btnSecondarySync = document.getElementById('btn-secondary-sync');
  const btnSecondaryMode = document.getElementById('btn-secondary-mode');
  const btnSecondaryClose = document.getElementById('btn-secondary-close');
  const secondaryEditorPane = document.getElementById('secondary-editor-pane');
  const secondaryLineNumbers = document.getElementById('secondary-line-numbers');
  const editorSecondary = document.getElementById('editor-secondary');
  const secondaryPreviewPane = document.getElementById('secondary-preview-pane');
  const paneResizer = document.getElementById('pane-resizer');
  const ctxOpenToSide = document.getElementById('ctx-open-to-side');

  const statCursor = document.getElementById('stat-cursor');
  const statChars = document.getElementById('stat-chars');
  const statSelection = document.getElementById('stat-selection');
  const statLlmIndicator = document.getElementById('stat-llm-indicator');
  const statLlmText = document.getElementById('stat-llm-text');
  const statMessage = document.getElementById('stat-message');
  const statIme = document.getElementById('stat-ime');
  const statAutocomplete = document.getElementById('stat-autocomplete');
  const statAutosave = document.getElementById('stat-autosave');
  const statEncoding = document.getElementById('stat-encoding');
  const statMode = document.getElementById('stat-mode');

  const contextMenu = document.getElementById('context-menu');
  const settingsModal = document.getElementById('settings-modal');

  // LLM Prompt Modal Elements
  const llmPromptModal = document.getElementById('llm-prompt-modal');
  const llmTargetPreview = document.getElementById('llm-target-preview');
  const llmCustomInstruction = document.getElementById('llm-custom-instruction');
  const btnSendLLM = document.getElementById('btn-send-llm');
  const btnCancelLLM = document.getElementById('btn-cancel-llm');
  const modalLLMClose = document.getElementById('modal-llm-close');

  // Settings tab elements
  const tabBtnTextLLM = document.getElementById('tab-btn-text-llm');
  const tabBtnAutocomplete = document.getElementById('tab-btn-autocomplete');
  const tabBtnVisionLLM = document.getElementById('tab-btn-vision-llm');
  const tabBtnGeneral = document.getElementById('tab-btn-general');
  const tabBtnShortcuts = document.getElementById('tab-btn-shortcuts');
  const paneTextLLM = document.getElementById('pane-text-llm');
  const paneAutocomplete = document.getElementById('pane-autocomplete');
  const paneVisionLLM = document.getElementById('pane-vision-llm');
  const paneGeneral = document.getElementById('pane-general');
  const paneShortcuts = document.getElementById('pane-shortcuts');
  const shortcutsListBody = document.getElementById('shortcuts-list-body');
  const btnResetShortcuts = document.getElementById('btn-reset-shortcuts');

  // Find & Replace Elements
  const findReplaceBar = document.getElementById('find-replace-bar');
  const findInput = document.getElementById('find-input');
  const findCount = document.getElementById('find-count');
  const btnToggleReplace = document.getElementById('btn-toggle-replace');
  const btnFindCase = document.getElementById('btn-find-case');
  const btnFindWord = document.getElementById('btn-find-word');
  const btnFindRegex = document.getElementById('btn-find-regex');
  const btnFindPrev = document.getElementById('btn-find-prev');
  const btnFindNext = document.getElementById('btn-find-next');
  const btnFindClose = document.getElementById('btn-find-close');
  const replaceRow = document.getElementById('replace-row');
  const replaceInput = document.getElementById('replace-input');
  const btnReplaceOne = document.getElementById('btn-replace-one');
  const btnReplaceAll = document.getElementById('btn-replace-all');

  // Inline Prompt Elements (Ctrl+K / Ctrl+L)
  const inlinePromptBar = document.getElementById('inline-prompt-bar');
  const inlinePromptInput = document.getElementById('inline-prompt-input');
  const btnInlinePromptSend = document.getElementById('btn-inline-prompt-send');
  const btnInlinePromptClose = document.getElementById('btn-inline-prompt-close');

  // Go to Line Elements
  const gotoLineModal = document.getElementById('goto-line-modal');
  const gotoLineInput = document.getElementById('goto-line-input');
  const modalGotoClose = document.getElementById('modal-goto-close');
  const btnGotoConfirm = document.getElementById('btn-goto-confirm');
  const btnGotoCancel = document.getElementById('btn-goto-cancel');

  const quickPickModal = document.getElementById('quick-pick-modal');
  const quickPickInput = document.getElementById('quick-pick-input');
  const quickPickList = document.getElementById('quick-pick-list');
  const statAmbientContainer = document.getElementById('stat-ambient-container');

  // Custom In-App Confirm Dialog (Eliminates Browser 127.0.0.1 Prompt)
  const confirmModal = document.getElementById('confirm-modal');
  const confirmModalMessage = document.getElementById('confirm-modal-message');
  const confirmModalOk = document.getElementById('confirm-modal-ok');
  const confirmModalCancel = document.getElementById('confirm-modal-cancel');
  const confirmModalClose = document.getElementById('confirm-modal-close');

  function customConfirm(message) {
    return new Promise((resolve) => {
      if (!confirmModal || !confirmModalMessage) {
        resolve(true);
        return;
      }
      confirmModalMessage.textContent = message;
      confirmModal.classList.remove('hidden');

      const cleanup = (result) => {
        confirmModal.classList.add('hidden');
        confirmModalOk.onclick = null;
        confirmModalCancel.onclick = null;
        confirmModalClose.onclick = null;
        window.removeEventListener('keydown', onKeyDown);
        resolve(result);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          cleanup(true);
        }
      };

      confirmModalOk.onclick = () => cleanup(true);
      confirmModalCancel.onclick = () => cleanup(false);
      confirmModalClose.onclick = () => cleanup(false);
      window.addEventListener('keydown', onKeyDown);

      // Focus OK button
      setTimeout(() => confirmModalOk.focus(), 10);
    });
  }

  // --- Non-Intrusive Tab-Based IME Guardian Instance ---
  let imeGuardian = (typeof IMEGuardian !== 'undefined') ? new IMEGuardian() : null;
  let activeImeSuggestion = null;

  // Lazy Script & Stylesheet Loader for Ultra-Fast Startup
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  function loadStylesheet(href) {
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    });
  }

  async function ensureRendererLibraries() {
    if (rendererLibsLoaded) return;
    try {
      if (!window.markdownit || !window.katex || !window.mermaid) {
        await Promise.all([
          loadStylesheet('vendor/katex.min.css'),
          loadScript('vendor/markdown-it.min.js'),
          loadScript('vendor/katex.min.js'),
          loadScript('vendor/mermaid.min.js')
        ]);
      }

      if (window.markdownit) {
        mdInstance = window.markdownit({
          html: false,
          linkify: true,
          typographer: true,
          breaks: true
        });
      }

      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          themeVariables: {
            darkMode: true,
            background: '#252526',
            primaryColor: '#007acc',
            textColor: '#d4d4d4'
          }
        });
      }
      rendererLibsLoaded = true;
    } catch (e) {
      console.warn('Renderer script load error:', e);
    }
  }

  // Undo/Redo Friendly Text Insertion & Range Replacement
  function insertTextWithUndo(text) {
    editorEl.focus();
    let success = false;
    try {
      success = document.execCommand('insertText', false, text);
    } catch (e) {
      success = false;
    }
    if (!success) {
      // Fallback if browser environment restricts execCommand
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      const val = editorEl.value;
      editorEl.value = val.substring(0, start) + text + val.substring(end);
      editorEl.selectionStart = start + text.length;
      editorEl.selectionEnd = start + text.length;
    }
  }

  function replaceAnchorWithUndo(anchorId, replacementText) {
    editorEl.focus();
    const currentVal = editorEl.value;
    const anchorIdx = currentVal.indexOf(anchorId);
    if (anchorIdx !== -1) {
      editorEl.setSelectionRange(anchorIdx, anchorIdx + anchorId.length);
      let success = false;
      try {
        success = document.execCommand('insertText', false, replacementText);
      } catch (e) {
        success = false;
      }
      if (!success) {
        const selStart = editorEl.selectionStart;
        const selEnd = editorEl.selectionEnd;
        editorEl.value = currentVal.replace(anchorId, replacementText);
        if (selStart > anchorIdx) {
          const delta = replacementText.length - anchorId.length;
          editorEl.selectionStart = Math.max(0, selStart + delta);
          editorEl.selectionEnd = Math.max(0, selEnd + delta);
        } else {
          editorEl.selectionStart = selStart;
          editorEl.selectionEnd = selEnd;
        }
      }
      return true;
    } else {
      // If anchor was removed/missing, append to the end
      editorEl.setSelectionRange(currentVal.length, currentVal.length);
      insertTextWithUndo(`\n\n${replacementText}\n`);
      return false;
    }
  }

  function getFormattedDateTime(format) {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');

    if (format === 'header') {
      return `# ${YYYY}-${MM}-${DD} ${HH}:${mm}\n\n`;
    }
    return `${YYYY}/${MM}/${DD} ${HH}:${mm}:${ss}`;
  }

  // Zero-Taxonomy: Derive clean filename / tab title from first non-empty heading or line
  function deriveTitleFromContent(text) {
    if (!text) return '';
    const lines = text.split('\n');
    let fallbackDateTitle = '';
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      // Check if line is timestamp header e.g. "# 2026-09-11 18:28" or "2026/09/11 18:28:30" or "2026-09-11"
      const isDateOnly = /^(#+\s*)?\d{4}[-/]\d{2}[-/]\d{2}(\s+\d{2}:\d{2}(:\d{2})?)?$/.test(line);
      if (isDateOnly) {
        if (!fallbackDateTitle) {
          fallbackDateTitle = line.replace(/^#+\s*/, '').replace(/[\\/:*?"<>|]/g, '-').trim();
        }
        continue; // Skip date header to find real user note title!
      }
      // Strip markdown header symbols
      if (line.startsWith('#')) {
        line = line.replace(/^#+\s*/, '');
      }
      // Strip task or list markers
      line = line.replace(/^(\*|-|\+|\d+\.)\s+(\[[ xX]\]\s+)?/, '');
      // Sanitize forbidden filename characters: \ / : * ? " < > |
      line = line.replace(/[\\/:*?"<>|]/g, '').trim();
      if (line) {
        return line.length > 40 ? line.substring(0, 40) : line;
      }
    }
    return fallbackDateTitle || '';
  }

  // Tab Operations
  function createTab(title, content, path, encoding) {
    const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const initialContent = content !== undefined ? content : getFormattedDateTime('header');

    let isAutoTitle = false;
    let initialTitle = title;
    if (!initialTitle && !path) {
      isAutoTitle = true;
      const derived = deriveTitleFromContent(initialContent);
      initialTitle = derived ? `${derived}.md` : `${t('untitled')}-${tabCounter++}.md`;
    } else if (!initialTitle) {
      initialTitle = `${t('untitled')}-${tabCounter++}.md`;
    }

    const newTab = {
      id: tabId,
      title: initialTitle,
      isAutoTitle: isAutoTitle,
      path: path || '',
      content: initialContent,
      isDirty: false,
      encoding: encoding || 'UTF-8',
      cursorPos: initialContent.length
    };

    tabs.push(newTab);
    renderTabs();
    selectTab(tabId);
    saveSessionDebounced();
    return newTab;
  }

  function selectTab(tabId) {
    clearGhostText();
    if (activeTabId) {
      const prevTab = getTab(activeTabId);
      if (prevTab) {
        prevTab.content = editorEl.value;
        prevTab.cursorPos = editorEl.selectionStart;
      }
    }

    activeTabId = tabId;
    const tab = getTab(tabId);
    if (!tab) return;

    editorEl.value = tab.content;
    const pos = tab.cursorPos !== undefined ? tab.cursorPos : tab.content.length;
    editorEl.selectionStart = pos;
    editorEl.selectionEnd = pos;

    statEncoding.textContent = tab.encoding;
    renderTabs();
    cachedLineCount = 0;
    updateLineNumbers();
    updateStatusBar();

    if (isPreviewMode || isSplitMode) {
      renderPreview();
    }
    saveSessionDebounced();
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }

  async function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    if (tab.isDirty) {
      const ok = await customConfirm(t('confirmCloseUnsaved', { title: tab.title }));
      if (!ok) return;
    }

    tabs.splice(tabIndex, 1);
    if (isSplitMode && secondaryTabId === tabId) {
      const remaining = tabs.filter(t => t.id !== tabId);
      if (remaining.length > 0) {
        secondaryTabId = remaining[0].id;
        updateSecondaryPane();
      } else {
        closeSecondaryPane();
      }
    }
    if (tabs.length === 0) {
      createTab();
    } else if (activeTabId === tabId) {
      const nextIndex = Math.max(0, tabIndex - 1);
      selectTab(tabs[nextIndex].id);
    } else {
      renderTabs();
      saveSessionDebounced();
    }
  }

  function getTab(tabId) {
    return tabs.find(t => t.id === tabId);
  }

  function getActiveTab() {
    return getTab(activeTabId);
  }

  let activeTabDrag = null;
  let contextMenuTargetTabId = null;

  function renderTabs() {
    tabsListEl.innerHTML = '';
    tabs.forEach((tab, index) => {
      const tabEl = document.createElement('div');
      const isPrimary = tab.id === activeTabId;
      const isSecondary = isSplitMode && tab.id === secondaryTabId;
      let cls = 'tab-item';
      if (isPrimary && isSecondary) {
        cls += ' active split-active';
      } else if (isPrimary) {
        cls += ' active';
      } else if (isSecondary) {
        cls += ' split-active';
      }
      tabEl.className = cls;
      tabEl.dataset.tabId = tab.id;

      tabEl.addEventListener('contextmenu', () => {
        contextMenuTargetTabId = tab.id;
      });

      // Robust Pointer-Based Tab Drag & Reorder Engine (Works 100% reliably in WebView2)
      tabEl.addEventListener('pointerdown', (e) => {
        // Only primary mouse button and not clicking on the close button
        if (e.button !== 0 || e.target.closest('.tab-close')) return;

        const startX = e.clientX;
        const startY = e.clientY;
        let isDragging = false;
        let lastTargetTabId = null;
        let lastInsertAfter = false;

        const cleanupDragIndicators = () => {
          document.querySelectorAll('.tab-item').forEach(el => {
            el.classList.remove('dragging', 'drag-over-left', 'drag-over-right');
          });
        };

        const onPointerMove = (moveEv) => {
          const dx = Math.abs(moveEv.clientX - startX);
          const dy = Math.abs(moveEv.clientY - startY);

          if (!isDragging) {
            if (dx > 4 || dy > 4) {
              isDragging = true;
              try {
                tabEl.setPointerCapture(e.pointerId);
              } catch (_) {}
              tabEl.classList.add('dragging');
            } else {
              return;
            }
          }

          // Find the tab under the cursor
          const allTabs = Array.from(tabsListEl.querySelectorAll('.tab-item'));
          let hoverTab = null;
          let insertAfter = false;

          for (const item of allTabs) {
            if (item.dataset.tabId === tab.id) continue;
            const r = item.getBoundingClientRect();
            if (moveEv.clientX >= r.left && moveEv.clientX <= r.right) {
              hoverTab = item;
              insertAfter = moveEv.clientX > (r.left + r.width / 2);
              break;
            }
          }

          // If moved outside bounds to the left or right of tabs list
          if (!hoverTab && allTabs.length > 1) {
            const firstTab = allTabs[0];
            const lastTab = allTabs[allTabs.length - 1];
            const firstRect = firstTab.getBoundingClientRect();
            const lastRect = lastTab.getBoundingClientRect();

            if (moveEv.clientX < firstRect.left && firstTab.dataset.tabId !== tab.id) {
              hoverTab = firstTab;
              insertAfter = false;
            } else if (moveEv.clientX > lastRect.right && lastTab.dataset.tabId !== tab.id) {
              hoverTab = lastTab;
              insertAfter = true;
            }
          }

          allTabs.forEach(el => el.classList.remove('drag-over-left', 'drag-over-right'));

          if (hoverTab) {
            lastTargetTabId = hoverTab.dataset.tabId;
            lastInsertAfter = insertAfter;
            hoverTab.classList.add(insertAfter ? 'drag-over-right' : 'drag-over-left');
          } else {
            lastTargetTabId = null;
          }
        };

        const onPointerUp = (upEv) => {
          window.removeEventListener('pointermove', onPointerMove);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointercancel', onPointerUp);

          try {
            if (tabEl.hasPointerCapture(e.pointerId)) {
              tabEl.releasePointerCapture(e.pointerId);
            }
          } catch (_) {}

          if (isDragging) {
            cleanupDragIndicators();

            if (lastTargetTabId && lastTargetTabId !== tab.id) {
              const fromIdx = tabs.findIndex(t => t.id === tab.id);
              if (fromIdx !== -1) {
                const [movedTab] = tabs.splice(fromIdx, 1);
                let toIdx = tabs.findIndex(t => t.id === lastTargetTabId);
                if (toIdx !== -1) {
                  if (lastInsertAfter) toIdx++;
                  tabs.splice(toIdx, 0, movedTab);
                  renderTabs();
                  saveSessionDebounced();
                } else {
                  // Fallback restore
                  tabs.splice(fromIdx, 0, movedTab);
                  renderTabs();
                }
              }
            } else {
              tabEl.classList.remove('dragging');
            }
          } else {
            // Normal click without drag threshold
            if (e.altKey) {
              openSplitEditor(tab.id);
            } else if (isSplitMode && activePane === 'secondary') {
              secondaryTabId = tab.id;
              updateSecondaryPane();
              renderTabs();
            } else {
              selectTab(tab.id);
            }
          }
        };

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
      });

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-title';
      titleEl.textContent = tab.title;

      tabEl.appendChild(titleEl);

      if (tab.isDirty) {
        const dotEl = document.createElement('span');
        dotEl.className = 'tab-dirty-dot';
        dotEl.textContent = '●';
        tabEl.appendChild(dotEl);
      }

      const closeEl = document.createElement('span');
      closeEl.className = 'tab-close';
      closeEl.textContent = '×';
      closeEl.title = '閉じる (Ctrl+W)';
      closeEl.onclick = (e) => closeTab(tab.id, e);
      tabEl.appendChild(closeEl);

      tabsListEl.appendChild(tabEl);
    });
  }

  // Ultra-Fast Zero-HTML Line Numbers
  function updateLineNumbers() {
    const text = editorEl.value;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines++;
    }
    if (lines === cachedLineCount) return;
    cachedLineCount = lines;

    let s = '1';
    for (let i = 2; i <= lines; i++) {
      s += '\n' + i;
    }
    lineNumbersEl.textContent = s;
  }

  let statusBarScheduled = false;
  function scheduleUpdateStatusBar() {
    if (statusBarScheduled) return;
    statusBarScheduled = true;
    requestAnimationFrame(() => {
      statusBarScheduled = false;
      updateStatusBar();
    });
  }

  function updateStatusBar() {
    const text = editorEl.value;
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;

    const textBeforeCursor = text.substring(0, start);
    const lines = textBeforeCursor.split('\n');
    const lineNum = lines.length;
    const colNum = lines[lines.length - 1].length + 1;

    statCursor.textContent = t('lineCol', { line: lineNum, col: colNum });
    statChars.textContent = t('charCount', { count: text.length });

    const selLength = Math.abs(end - start);
    if (selLength > 0) {
      statSelection.textContent = t('selectionCount', { count: selLength });
      statSelection.classList.remove('hidden');
    } else {
      statSelection.classList.add('hidden');
    }

    if (statMode) {
      statMode.textContent = isHtmlDocument() ? 'HTML' : 'Markdown';
    }
  }

  // 1-Screen Toggle: Editor ⇄ Preview
  async function togglePreview() {
    clearGhostText();
    if (isSplitMode) {
      closeSecondaryPane();
    }

    isPreviewMode = !isPreviewMode;
    if (isPreviewMode) {
      const activeTab = getActiveTab();
      if (activeTab) activeTab.content = editorEl.value;

      previewPane.innerHTML = `<div style="color:#858585; padding:20px;">${t('rendererLoading')}</div>`;
      editorPane.classList.add('hidden');
      previewPane.classList.remove('hidden');
      if (btnTogglePreview) {
        btnTogglePreview.classList.add('active');
        btnTogglePreview.title = t('edit');
      }

      hideCursorAura(true);
      await ensureRendererLibraries();
      renderPreview();
    } else {
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      if (btnTogglePreview) {
        btnTogglePreview.classList.remove('active');
        btnTogglePreview.title = t('togglePreviewTitle');
      }
      editorEl.focus();
      triggerCursorAuraDebounced();
    }
  }

  // --- Flexible Split View & Pane Management (VS Code Style) ---
  function applySplitRatio() {
    if (!isSplitMode) return;
    const pct = (splitRatio * 100).toFixed(2);
    editorPane.style.flex = `0 0 ${pct}%`;
    secondaryPane.style.flex = `1 1 0`;
  }

  function initPaneResizer() {
    if (!paneResizer) return;

    let isResizing = false;
    let startX = 0;
    let startLeftWidth = 0;

    paneResizer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      isResizing = true;
      startX = e.clientX;
      startLeftWidth = editorPane.getBoundingClientRect().width;

      paneResizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      try { paneResizer.setPointerCapture(e.pointerId); } catch (_) {}

      const onPointerMove = (moveEv) => {
        if (!isResizing) return;
        const totalWidth = workspaceEl.getBoundingClientRect().width;
        if (totalWidth <= 0) return;

        const currentLeftWidth = startLeftWidth + (moveEv.clientX - startX);
        let ratio = currentLeftWidth / totalWidth;
        // Clamp between 15% and 85% for ergonomic view
        ratio = Math.max(0.15, Math.min(0.85, ratio));
        splitRatio = ratio;
        applySplitRatio();
      };

      const onPointerUp = (upEv) => {
        isResizing = false;
        paneResizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try { paneResizer.releasePointerCapture(e.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    });

    // Double-click to reset 50:50 equal split
    paneResizer.addEventListener('dblclick', () => {
      splitRatio = 0.5;
      applySplitRatio();
    });
  }

  // Open / Switch Split Editor (Right Pane)
  async function openSplitEditor(tabId) {
    clearGhostText();
    let targetTabId = tabId;
    if (!targetTabId) {
      if (tabs.length > 1) {
        const otherTab = tabs.find(t => t.id !== activeTabId);
        targetTabId = otherTab ? otherTab.id : activeTabId;
      } else {
        targetTabId = activeTabId;
      }
    }

    secondaryTabId = targetTabId;
    secondaryViewMode = 'editor';
    isSplitMode = true;

    workspaceEl.classList.add('split-mode');
    secondaryPane.classList.remove('hidden');
    paneResizer.classList.remove('hidden');
    if (btnToggleSplit) btnToggleSplit.classList.add('active');

    if (isPreviewMode) {
      isPreviewMode = false;
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      if (btnTogglePreview) btnTogglePreview.classList.remove('active');
    }

    updateSecondaryPane();
    activePane = 'secondary';
    editorSecondary.focus();
  }

  // Open Preview to the Side (Right Pane) with Smart Sync Scroll
  async function openPreviewToSide(tabId) {
    clearGhostText();
    const targetTabId = tabId || activeTabId;
    secondaryTabId = targetTabId;
    secondaryViewMode = 'preview';
    isSplitMode = true;
    syncScrollEnabled = true;

    workspaceEl.classList.add('split-mode');
    secondaryPane.classList.remove('hidden');
    paneResizer.classList.remove('hidden');
    if (btnToggleSplit) btnToggleSplit.classList.add('active');

    if (isPreviewMode) {
      isPreviewMode = false;
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      if (btnTogglePreview) btnTogglePreview.classList.remove('active');
    }

    await ensureRendererLibraries();
    updateSecondaryPane();
    editorEl.focus();
  }

  function closeSecondaryPane() {
    isSplitMode = false;
    workspaceEl.classList.remove('split-mode');
    secondaryPane.classList.add('hidden');
    paneResizer.classList.add('hidden');
    editorPane.style.flex = '';
    if (btnToggleSplit) btnToggleSplit.classList.remove('active');
    activePane = 'primary';
    editorEl.focus();
  }

  function toggleSplitMode() {
    if (isSplitMode) {
      closeSecondaryPane();
    } else {
      openSplitEditor();
    }
  }

  function updateSecondaryPane() {
    if (!isSplitMode) return;

    const secTab = getTab(secondaryTabId) || getActiveTab();
    if (!secTab) return;
    secondaryTabId = secTab.id;

    if (secondaryPaneTitle) {
      secondaryPaneTitle.textContent = secTab.title || t('untitled');
      secondaryPaneTitle.title = secTab.path || secTab.title || '';
    }

    if (secondaryViewMode === 'preview') {
      secondaryEditorPane.classList.add('hidden');
      secondaryPreviewPane.classList.remove('hidden');
      if (btnSecondaryMode) {
        btnSecondaryMode.classList.add('active');
        btnSecondaryMode.title = t('edit');
      }
      if (btnSecondarySync) {
        btnSecondarySync.style.display = (secTab.id === activeTabId) ? 'inline-flex' : 'none';
        btnSecondarySync.classList.toggle('active', syncScrollEnabled);
      }
      renderSecondaryPreview();
    } else {
      secondaryPreviewPane.classList.add('hidden');
      secondaryEditorPane.classList.remove('hidden');
      if (btnSecondaryMode) {
        btnSecondaryMode.classList.remove('active');
        btnSecondaryMode.title = t('preview');
      }
      if (btnSecondarySync) {
        btnSecondarySync.style.display = 'none';
      }
      editorSecondary.value = secTab.content || '';
      updateSecondaryLineNumbers();
    }

    applySplitRatio();
  }

  function updateSecondaryLineNumbers() {
    if (!isSplitMode || secondaryViewMode !== 'editor') return;
    const text = editorSecondary.value || '';
    const count = (text.match(/\n/g) || []).length + 1;
    let lines = '';
    for (let i = 1; i <= count; i++) {
      lines += i + '\n';
    }
    secondaryLineNumbers.textContent = lines;
  }

  // Live preview debouncer for typing in split mode
  let livePreviewTimer = null;
  function debouncedLivePreview() {
    if (livePreviewTimer) clearTimeout(livePreviewTimer);
    livePreviewTimer = setTimeout(() => {
      if (isPreviewMode) renderPreview();
      if (isSplitMode && secondaryViewMode === 'preview') renderSecondaryPreview();
    }, 120);
  }

  function isHtmlDocument(targetContent, targetPath) {
    const filename = targetPath || '';
    if (/\.(html|htm)$/i.test(filename)) return true;
    const trimmed = (targetContent || '').trim();
    if (/^<!DOCTYPE\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return true;
    return false;
  }

  function renderHtmlPreviewTo(rawHtml, targetPane) {
    targetPane.classList.add('html-mode');
    let frame = targetPane.querySelector('#html-preview-frame');

    const helperScript = `
<script>
(function() {
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'scrollRatio') {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0) window.scrollTo({ top: max * e.data.ratio, behavior: 'instant' });
    }
  });
  window.addEventListener('scroll', function() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (max > 0) {
      window.parent.postMessage({ type: 'previewScroll', ratio: window.scrollY / max }, '*');
    }
  });
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a');
    if (a && a.href) {
      var href = a.getAttribute('href') || a.href;
      if (href.startsWith('http://') || href.startsWith('https://')) {
        e.preventDefault();
        window.parent.postMessage({ type: 'openExternal', url: href }, '*');
      }
    }
  });
})();
<\/script>
`;

    let fullDoc;
    if (rawHtml.toLowerCase().includes('</body>')) {
      const idx = rawHtml.toLowerCase().lastIndexOf('</body>');
      fullDoc = rawHtml.substring(0, idx) + helperScript + rawHtml.substring(idx);
    } else {
      fullDoc = rawHtml + helperScript;
    }

    if (!frame) {
      targetPane.innerHTML = '';
      frame = document.createElement('iframe');
      frame.id = 'html-preview-frame';
      frame.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms');
      frame.style.width = '100%';
      frame.style.height = '100%';
      frame.style.border = 'none';
      frame.style.display = 'block';
      frame.style.background = '#ffffff';
      targetPane.appendChild(frame);
    }

    frame.srcdoc = fullDoc;
  }

  // Core Markdown & Diagram Renderer (Reusable for both Primary and Secondary panes)
  function renderMarkdownContentTo(rawContent, targetPane, tabObj) {
    if (!targetPane) return;
    const text = rawContent || '';

    if (isHtmlDocument(text, (tabObj && (tabObj.path || tabObj.title)) || '')) {
      renderHtmlPreviewTo(text, targetPane);
      return;
    }

    targetPane.classList.remove('html-mode');

    if (!mdInstance) {
      targetPane.innerHTML = '<pre>' + escapeHtml(text) + '</pre>';
      return;
    }

    let rawText = text;

    // 1. Protect fenced code blocks (```...``` / ~~~...~~~) and inline code (`...`)
    const codeSnippets = [];
    rawText = rawText.replace(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]+`)/g, (match) => {
      const token = `KATEXCODESNIPPET${codeSnippets.length}XYZ`;
      codeSnippets.push(match);
      return token;
    });

    // 2. Extract Block Math ($$...$$)
    const mathPlaceholders = [];
    rawText = rawText.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
      const token = `KATEXMATHBLOCK${mathPlaceholders.length}XYZ`;
      let rendered = '';
      try {
        if (window.katex) {
          rendered = '<div class="katex-block">' + window.katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }) + '</div>';
        } else {
          rendered = '<div class="katex-block">$$' + escapeHtml(math) + '$$</div>';
        }
      } catch (e) {
        rendered = '<pre class="katex-error">' + escapeHtml(math) + '</pre>';
      }
      mathPlaceholders.push(rendered);
      return token;
    });

    // 3. Extract Inline Math ($...$)
    rawText = rawText.replace(/\$([^\$\s\n](?:[^\$\n]*?[^\$\s\n])?)\$/g, (_, math) => {
      const token = `KATEXMATHINLINE${mathPlaceholders.length}XYZ`;
      let rendered = '';
      try {
        if (window.katex) {
          rendered = window.katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
        } else {
          rendered = '$' + escapeHtml(math) + '$';
        }
      } catch (e) {
        rendered = '<code>' + escapeHtml(math) + '</code>';
      }
      mathPlaceholders.push(rendered);
      return token;
    });

    // 4. Restore protected code snippets
    rawText = rawText.replace(/KATEXCODESNIPPET(\d+)XYZ/g, (_, idx) => codeSnippets[Number(idx)]);

    // 5. Render Markdown
    let html = mdInstance.render(rawText);

    // 6. Strip <p> tags wrapping standalone block math expressions
    html = html.replace(/<p>\s*(KATEXMATHBLOCK\d+XYZ)\s*<\/p>/g, '$1');

    // 7. Inject rendered KaTeX HTML back into placeholders
    html = html.replace(/KATEXMATH(?:BLOCK|INLINE)(\d+)XYZ/g, (_, idx) => mathPlaceholders[Number(idx)]);

    targetPane.innerHTML = html;

    // Resolve local image paths relative to note
    try {
      const noteDir = (tabObj && tabObj.path) ? tabObj.path.replace(/[\\\/][^\\\/]+$/, '') : '';
      const imgs = targetPane.querySelectorAll('img');
      imgs.forEach(img => {
        const rawSrc = img.getAttribute('src');
        if (!rawSrc) return;
        if (rawSrc.startsWith('http://') || rawSrc.startsWith('https://') || rawSrc.startsWith('data:') || rawSrc.startsWith('/api/image')) {
          return;
        }
        let fullPath = rawSrc;
        if (fullPath.startsWith('file:///')) {
          fullPath = decodeURIComponent(fullPath.slice(8));
        } else if (fullPath.startsWith('file://')) {
          fullPath = decodeURIComponent(fullPath.slice(7));
        }
        const isWindowsAbs = /^[a-zA-Z]:[\\\/]/.test(fullPath);
        const isUnixAbs = fullPath.startsWith('/');
        if (!isWindowsAbs && !isUnixAbs && noteDir) {
          fullPath = noteDir + '/' + fullPath;
        }
        img.src = '/api/image?path=' + encodeURIComponent(fullPath);
      });
    } catch (e) {
      console.warn('Failed to resolve local preview images:', e);
    }

    // Render Mermaid diagrams
    if (window.mermaid) {
      const codeBlocks = targetPane.querySelectorAll('pre code.language-mermaid');
      codeBlocks.forEach(async (block, idx) => {
        const diagramCode = block.textContent;
        const container = block.parentElement;
        const id = 'mermaid-svg-' + idx + '-' + Date.now();
        try {
          const { svg } = await window.mermaid.render(id, diagramCode);
          container.innerHTML = svg;
        } catch (err) {
          container.innerHTML = '<div class="mermaid-error" style="color:#f48771;">Mermaid構文エラー: ' + escapeHtml(err.message) + '</div>';
        }
      });
    }
  }

  function renderPreview() {
    renderMarkdownContentTo(editorEl.value, previewPane, getActiveTab());
  }

  function renderSecondaryPreview() {
    if (!isSplitMode || secondaryViewMode !== 'preview') return;
    const secTab = getTab(secondaryTabId) || getActiveTab();
    if (!secTab) return;
    renderMarkdownContentTo(secTab.content, secondaryPreviewPane, secTab);
  }

  // Intercept all in-preview link clicks to prevent in-webview navigation
  [previewPane, secondaryPreviewPane].forEach(pane => {
    if (!pane) return;
    pane.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link && link.href) {
        e.preventDefault();
        const href = link.getAttribute('href') || link.href;
        if (href.startsWith('http://') || href.startsWith('https://')) {
          if (window.backend && window.backend.openExternal) {
            window.backend.openExternal(href);
          } else {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
        }
      }
    });
  });

  // Smart Proportional Scroll Synchronization (Active when same note is open in editor and side preview)
  let isSyncingEditorScroll = false;
  let isSyncingPreviewScroll = false;

  function shouldSyncScroll() {
    return isSplitMode && 
           secondaryViewMode === 'preview' && 
           syncScrollEnabled && 
           (activeTabId === secondaryTabId);
  }

  editorEl.addEventListener('scroll', () => {
    if (!shouldSyncScroll() || isSyncingEditorScroll) return;
    isSyncingPreviewScroll = true;
    const maxEditorScroll = editorEl.scrollHeight - editorEl.clientHeight;
    if (maxEditorScroll > 0) {
      const ratio = editorEl.scrollTop / maxEditorScroll;
      const targetPane = secondaryPreviewPane;
      const activeTab = getActiveTab();
      if (isHtmlDocument(editorEl.value, activeTab ? activeTab.path : '')) {
        const frame = targetPane.querySelector('#html-preview-frame');
        if (frame && frame.contentWindow) {
          frame.contentWindow.postMessage({ type: 'scrollRatio', ratio: ratio }, '*');
        }
      } else {
        const maxPreviewScroll = targetPane.scrollHeight - targetPane.clientHeight;
        targetPane.scrollTop = ratio * maxPreviewScroll;
      }
    }
    setTimeout(() => { isSyncingPreviewScroll = false; }, 40);
  });

  secondaryPreviewPane.addEventListener('scroll', () => {
    if (!shouldSyncScroll() || isSyncingPreviewScroll) return;
    isSyncingEditorScroll = true;
    const maxPreviewScroll = secondaryPreviewPane.scrollHeight - secondaryPreviewPane.clientHeight;
    if (maxPreviewScroll > 0) {
      const ratio = secondaryPreviewPane.scrollTop / maxPreviewScroll;
      const maxEditorScroll = editorEl.scrollHeight - editorEl.clientHeight;
      editorEl.scrollTop = ratio * maxEditorScroll;
    }
    setTimeout(() => { isSyncingEditorScroll = false; }, 40);
  });

  // Handle messages from sandboxed HTML preview iframe (scrolling & external link opening)
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'previewScroll') {
      if (!isSplitMode || isSyncingPreviewScroll) return;
      isSyncingEditorScroll = true;
      const maxEditorScroll = editorEl.scrollHeight - editorEl.clientHeight;
      if (maxEditorScroll > 0) {
        editorEl.scrollTop = e.data.ratio * maxEditorScroll;
      }
      setTimeout(() => { isSyncingEditorScroll = false; }, 40);
    } else if (e.data && e.data.type === 'openExternal' && e.data.url) {
      if (window.backend && window.backend.openExternal) {
        window.backend.openExternal(e.data.url);
      } else {
        window.open(e.data.url, '_blank', 'noopener,noreferrer');
      }
    }
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Ghost Text & Autocomplete Engine
  function clearGhostText() {
    ghostSuggestion = '';
    activeImeSuggestion = null;
    if (ghostOverlayEl) {
      ghostOverlayEl.innerHTML = '';
    }
  }

  function renderGhostText(prefix, suggestion) {
    if (!suggestion || isPreviewMode || !ghostOverlayEl) {
      clearGhostText();
      return;
    }
    ghostSuggestion = suggestion;
    ghostTargetCursor = editorEl.selectionStart;

    ghostOverlayEl.innerHTML = `<span class="ghost-prefix">${escapeHtml(prefix)}</span><span class="ghost-suggestion">${escapeHtml(suggestion)}</span>`;
    ghostOverlayEl.scrollTop = editorEl.scrollTop;
    ghostOverlayEl.scrollLeft = editorEl.scrollLeft;
  }

  function acceptImeSuggestion() {
    if (!activeImeSuggestion) return false;
    const currentCursor = editorEl.selectionStart;
    if (currentCursor !== activeImeSuggestion.endPos) {
      activeImeSuggestion = null;
      clearGhostText();
      return false;
    }

    const { startPos, endPos, hiragana } = activeImeSuggestion;
    activeImeSuggestion = null;
    clearGhostText();

    editorEl.setSelectionRange(startPos, endPos);
    insertTextWithUndo(hiragana);

    // Synchronize OS IME to Japanese (Windows IMM32 / VK_IME_ON)
    if (window.backend && window.backend.setIMEMode) {
      try {
        window.backend.setIMEMode(true);
      } catch (_) {}
    }

    onEditorInput();
    return true;
  }

  function checkImeSuggestion() {
    if (!imeGuardian || isPreviewMode || isComposing) {
      activeImeSuggestion = null;
      return false;
    }
    const isImeEnabled = (config.general && config.general.imeGuardian !== false);
    if (!isImeEnabled) {
      activeImeSuggestion = null;
      return false;
    }

    const cursor = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    if (cursor !== end) {
      activeImeSuggestion = null;
      return false;
    }

    const suggestion = imeGuardian.getRomajiSuggestion(editorEl.value, cursor, isImeEnabled);
    if (suggestion) {
      activeImeSuggestion = suggestion;
      const textBefore = editorEl.value.substring(0, cursor);
      renderGhostText(textBefore, ` [Tab: ${suggestion.hiragana}]`);
      return true;
    } else {
      if (activeImeSuggestion) {
        activeImeSuggestion = null;
        clearGhostText();
      }
      return false;
    }
  }

  function acceptGhostSuggestion() {
    if (activeImeSuggestion) {
      return acceptImeSuggestion();
    }
    if (!ghostSuggestion) return false;
    const currentCursor = editorEl.selectionStart;
    if (currentCursor !== ghostTargetCursor) {
      clearGhostText();
      return false;
    }

    const suggestionToInsert = ghostSuggestion;
    clearGhostText();
    editorEl.setSelectionRange(currentCursor, currentCursor);
    insertTextWithUndo(suggestionToInsert);

    onEditorInput();
    return true;
  }

  function acceptGhostWord() {
    if (activeImeSuggestion) {
      return acceptImeSuggestion();
    }
    if (!ghostSuggestion) return false;
    const currentCursor = editorEl.selectionStart;
    if (currentCursor !== ghostTargetCursor) {
      clearGhostText();
      return false;
    }

    // Match leading whitespace + word/CJK cluster or punctuation group
    const regex = /^(\s*[\u4E00-\u9FAF]+\s*|\s*[\u3040-\u309F]+\s*|\s*[\u30A0-\u30FF]+\s*|\s*\w+\s*|\s*[^\s\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]+\s*|\s+)/;
    const match = ghostSuggestion.match(regex);
    const chunk = (match && match[0] && match[0].length > 0) ? match[0] : ghostSuggestion.charAt(0);
    if (!chunk) return false;

    const remaining = ghostSuggestion.slice(chunk.length);
    editorEl.setSelectionRange(currentCursor, currentCursor);
    insertTextWithUndo(chunk);

    const newCursor = editorEl.selectionStart;
    ghostSuggestion = remaining;
    ghostTargetCursor = newCursor;

    if (!ghostSuggestion) {
      clearGhostText();
      onEditorInput();
    } else {
      const textBefore = editorEl.value.substring(0, newCursor);
      renderGhostText(textBefore, ghostSuggestion);
      onEditorInput(true);
    }
    return true;
  }

  let isComposing = false;

  function triggerAutocompleteDebounced() {
    clearTimeout(autocompleteTimer);

    // Instant synchronous check for IME Guardian suggestion first
    if (checkImeSuggestion()) {
      return; // IME Guardian suggestion is active, bypass LLM network request
    }

    clearGhostText();

    if (!config.autocomplete.enabled || isPreviewMode || isComposing) return;

    const delay = Math.max(config.autocomplete.delayMs || 600, 300);

    autocompleteTimer = setTimeout(() => {
      if (isComposing || isPreviewMode || !config.autocomplete.enabled) return;

      const cursor = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      if (cursor !== end) return;

      const fullText = editorEl.value;
      if (!fullText.trim()) return;

      const prefix = fullText.substring(0, cursor);
      const suffix = fullText.substring(cursor);

      if (prefix.trim().length < 2) return;

      const reqId = 'ac_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
      currentAutocompleteReqId = reqId;

      if (config.autocomplete.enabled) {
        statAutocomplete.textContent = t('statPredicting');
      }

      if (window.backend && window.backend.autocompleteAsync) {
        window.backend.autocompleteAsync(reqId, prefix, suffix, JSON.stringify(config.autocomplete));
      }
    }, delay);
  }

  window.__onAutocompleteResult = function (reqId, suggestion, errMsg) {
    if (reqId !== currentAutocompleteReqId) return;

    if (errMsg) {
      clearGhostText();
      statAutocomplete.textContent = t('statAutocompleteError');
      statAutocomplete.title = t('statAutocompleteErrorTitle') + errMsg;
      statAutocomplete.style.color = '#f48771';
      return;
    }

    statAutocomplete.textContent = config.autocomplete.enabled ? t('statAutocompleteOn') : t('statAutocompleteOff');
    statAutocomplete.title = config.autocomplete.enabled ? t('statAutocompleteTooltip') : t('statAutocompleteOffTooltip');
    statAutocomplete.style.color = '#ffffff';

    if (!suggestion || isPreviewMode) {
      clearGhostText();
      return;
    }
    const currentCursor = editorEl.selectionStart;
    const fullText = editorEl.value;
    const prefix = fullText.substring(0, currentCursor);

    renderGhostText(prefix, suggestion);
  };

  // LLM Instruction Prompt Modal & Query Trigger (Ctrl+L)
  function openLLMInstructionModal() {
    clearGhostText();
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    let selectedText = '';
    let isExplicitSelection = false;

    if (start !== end) {
      selectedText = editorEl.value.substring(start, end).trim();
      isExplicitSelection = true;
    }

    if (!selectedText) {
      const text = editorEl.value;
      const prevNewline = text.lastIndexOf('\n', start - 1);
      const nextNewline = text.indexOf('\n', end);
      const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
      const lineEnd = nextNewline === -1 ? text.length : nextNewline;
      selectedText = text.substring(lineStart, lineEnd).trim();
    }

    if (!selectedText && editorEl.value.trim()) {
      selectedText = editorEl.value.trim();
    }

    if (!selectedText) {
      showMessage('LLMに送信するテキストがありません', 2000);
      return;
    }

    const curTab = getActiveTab();
    if (!curTab) return;

    currentLLMPromptContext = {
      tabId: curTab.id,
      selectedText: selectedText,
      isExplicitSelection: isExplicitSelection,
      insertPos: end
    };

    llmTargetPreview.textContent = selectedText.length > 300 ? selectedText.substring(0, 300) + '...' : selectedText;
    llmCustomInstruction.value = '';
    llmPromptModal.classList.remove('hidden');
    setTimeout(() => llmCustomInstruction.focus(), 50);
  }

  function closeLLMPromptModal() {
    llmPromptModal.classList.add('hidden');
    currentLLMPromptContext = null;
    editorEl.focus();
  }

  function executeLLMQueryFromModal() {
    if (!currentLLMPromptContext) return;

    const ctx = currentLLMPromptContext;
    const instruction = llmCustomInstruction.value.trim();
    const curTab = getTab(ctx.tabId);
    if (!curTab) {
      closeLLMPromptModal();
      return;
    }

    let finalPrompt = ctx.selectedText;
    if (instruction) {
      finalPrompt = `【指示】:\n${instruction}\n\n【対象テキスト】:\n${ctx.selectedText}`;
    }

    const reqId = 'llm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[LLM 生成中...]`;

    const insertPos = ctx.insertPos;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();
    closeLLMPromptModal();

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, finalPrompt, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `(LLM生成完了)\n> "${finalPrompt}"\nについての回答です。`, '');
      }, 2500);
    }
  }

  // Vision / Image LLM Query (Gemini Flash Lite)
  async function triggerClipboardImageOCR(imageFileOrBlob) {
    let imgData = null;

    if (imageFileOrBlob) {
      imgData = await convertBlobToBase64(imageFileOrBlob);
    } else {
      imgData = await getClipboardImage();
    }

    if (!imgData) {
      showMessage('クリップボードに画像が見つかりませんでした (キャプチャ画像をコピーしてください)', 3000);
      return;
    }

    const curTab = getActiveTab();
    if (!curTab) return;

    const reqId = 'vision_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[画像マークダウン変換中 (Gemini)...]`;

    const insertPos = editorEl.selectionEnd;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();

    if (window.backend && window.backend.queryVisionAsync) {
      window.backend.queryVisionAsync(reqId, config.vision.prompt, imgData.base64, imgData.mimeType, JSON.stringify(config.vision));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `### 画像解析マークダウン (Gemini Flash Lite)\n\n- 解析テキスト完了`, '');
      }, 3000);
    }
  }

  function updateLLMIndicator() {
    if (pendingLLMRequests.size === 0) {
      statLlmIndicator.classList.add('hidden');
    } else {
      statLlmIndicator.classList.remove('hidden');
      statLlmText.textContent = `LLM処理中 (${pendingLLMRequests.size}件)... (入力可能)`;
    }
  }

  async function getClipboardImage() {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              return await convertBlobToBase64(blob);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Clipboard image access error:', err);
    }
    return null;
  }

  function convertBlobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          base64: reader.result,
          mimeType: blob.type || 'image/png'
        });
      };
      reader.readAsDataURL(blob);
    });
  }

  function stripMarkdownCodeFences(text) {
    if (!text || typeof text !== 'string') return text;
    let s = text.trim();
    if (!s.startsWith('```')) return s;

    const lines = s.split('\n');
    if (lines.length < 2) return s;

    const firstLine = lines[0].trim();
    const lastLine = lines[lines.length - 1].trim();

    if (firstLine.startsWith('```') && lastLine === '```') {
      const lang = firstLine.replace(/^```/, '').trim().toLowerCase();
      if (lang === '' || lang === 'markdown' || lang === 'md' || lang === 'text') {
        return lines.slice(1, lines.length - 1).join('\n').trim();
      }
    }
    return s;
  }

  // Global callback invoked by Go when background LLM finishes
  window.__onLLMResult = function (reqId, resultText, errorText) {
    const reqInfo = pendingLLMRequests.get(reqId);
    if (!reqInfo) return;

    pendingLLMRequests.delete(reqId);
    updateLLMIndicator();

    const targetTab = getTab(reqInfo.tabId);
    if (!targetTab) return;

    // If result is from vision OCR or text, ensure redundant outer ```markdown is removed
    let cleanedResult = resultText;
    if (reqId.startsWith('vision_') || reqId.startsWith('ocr_')) {
      cleanedResult = stripMarkdownCodeFences(cleanedResult);
    }

    const replacement = errorText ? `[LLMエラー: ${errorText}]` : cleanedResult;

    if (reqInfo.tabId === activeTabId) {
      replaceAnchorWithUndo(reqInfo.anchorId, replacement);

      targetTab.content = editorEl.value;
      targetTab.isDirty = true;
      renderTabs();
      cachedLineCount = 0;
      updateLineNumbers();
      updateStatusBar();
      if (isPreviewMode || isSplitMode) renderPreview();
    } else {
      if (targetTab.content.includes(reqInfo.anchorId)) {
        targetTab.content = targetTab.content.replace(reqInfo.anchorId, replacement);
      } else {
        targetTab.content += `\n\n${replacement}\n`;
      }
      targetTab.isDirty = true;
      renderTabs();
    }

    if (errorText) {
      showMessage(`${t('llmError')}${errorText}`, 5000);
    } else {
      showMessage(t('llmResponseInserted'), 3000);
    }
  };

  // File Operations (Save as-is / Export Plain Text / Open)
  async function saveActiveFile(forceSaveAs) {
    const tab = getActiveTab();
    if (!tab) return;
    tab.content = editorEl.value;

    if (!window.backend) {
      tab.isDirty = false;
      renderTabs();
      showMessage('Saved (Web Mock)', 2000);
      return;
    }

    try {
      if (!tab.path || forceSaveAs) {
        let suggestedName = tab.title;
        const isDefaultUntitled = !suggestedName ||
          tab.isAutoTitle ||
          suggestedName.startsWith(t('untitled')) ||
          suggestedName.startsWith('untitled') ||
          suggestedName.startsWith('無題') ||
          /^\d{4}[-/]\d{2}/.test(suggestedName);

        if (isDefaultUntitled) {
          const derived = deriveTitleFromContent(tab.content);
          suggestedName = derived ? `${derived}.md` : (tab.title || `${t('untitled')}.md`);
        }
        const res = await window.backend.saveFileAs(tab.content, tab.encoding, suggestedName);
        if (res && res.path) {
          tab.path = res.path;
          tab.title = res.title;
          tab.isAutoTitle = false;
          tab.isDirty = false;
          renderTabs();
          showMessage(`${t('saveSuccess')}${tab.title}`, 2500);
        }
      } else {
        await window.backend.saveFile(tab.path, tab.content, tab.encoding);
        tab.isDirty = false;
        renderTabs();
        showMessage(`${t('saveSuccess')}${tab.title}`, 2000);
      }
    } catch (e) {
      showMessage(`${t('saveError')}${e.message || e}`, 4000);
    }
  }

  // Explicit Plain Text Export (.txt with stripped markdown formatting)
  async function exportPlainText() {
    const tab = getActiveTab();
    if (!tab) return;
    tab.content = editorEl.value;

    if (!window.backend) {
      showMessage('Exported plain text (Web Mock)', 2000);
      return;
    }

    try {
      const defaultTxtName = (tab.title || t('untitled')).replace(/\.md$/i, '') + '.txt';
      const res = await window.backend.exportPlainTextAs(tab.content, tab.encoding, defaultTxtName);
      if (res && res.path) {
        showMessage(`${t('exportPlainTextSuccess')}${res.title}`, 3000);
      }
    } catch (e) {
      showMessage(`${t('exportPlainTextError')}${e.message || e}`, 4000);
    }
  }

  // Workspace Notes for Ambient Context & Search
  let workspaceRootPath = '';
  let workspaceNotes = [];

  async function openFolder() {
    if (!window.backend || !window.backend.openFolder) return;
    try {
      const folderPath = await window.backend.openFolder();
      if (folderPath) {
        await loadWorkspaceFolder(folderPath);
      }
    } catch (e) {
      showMessage(`${t('openError')}${e.message || e}`, 4000);
    }
  }

  async function loadWorkspaceFolder(folderPath) {
    if (!folderPath) return;
    workspaceRootPath = folderPath;
    try {
      localStorage.setItem('md_memo_workspace_folder', folderPath);
    } catch (e) {}

    if (window.backend && window.backend.scanFolderFiles) {
      try {
        const entries = await window.backend.scanFolderFiles(folderPath);
        if (entries && Array.isArray(entries)) {
          workspaceNotes = entries;
          showMessage(t('folderLoaded', { count: entries.length }), 3000);
          triggerAmbientContextImmediate();
        }
      } catch (err) {
        console.warn('Failed to scan workspace folder:', err);
      }
    }
  }

  async function openFile() {
    if (!window.backend) return;
    try {
      const res = await window.backend.openFile();
      if (res && res.path) {
        // Ensure editable editor is visible (switch out of preview mode if active)
        if (isPreviewMode) {
          await togglePreview();
        }
        const tab = createTab(res.title, res.content, res.path, res.encoding);
        editorEl.focus();
      }
    } catch (e) {
      showMessage(`${t('openError')}${e.message || e}`, 4000);
    }
  }

  function toggleEncoding() {
    const tab = getActiveTab();
    if (!tab) return;
    tab.encoding = (tab.encoding === 'UTF-8') ? 'Shift_JIS' : 'UTF-8';
    statEncoding.textContent = tab.encoding;
    tab.isDirty = true;
    renderTabs();
    showMessage(t('encodingSwitched', { enc: tab.encoding }), 3000);
  }

  function toggleAutocomplete() {
    config.autocomplete.enabled = !config.autocomplete.enabled;
    statAutocomplete.textContent = config.autocomplete.enabled ? t('statAutocompleteOn') : t('statAutocompleteOff');
    statAutocomplete.title = config.autocomplete.enabled ? t('statAutocompleteTooltip') : t('statAutocompleteOffTooltip');
    statAutocomplete.style.opacity = config.autocomplete.enabled ? '1' : '0.6';
    if (!config.autocomplete.enabled) {
      clearGhostText();
    }
    savePersistentConfig();
  }

  function toggleIME() {
    config.general.imeGuardian = !(config.general && config.general.imeGuardian !== false);
    if (statIme) {
      statIme.textContent = config.general.imeGuardian ? t('statImeOn') : t('statImeOff');
      statIme.style.opacity = config.general.imeGuardian ? '1' : '0.6';
    }
    if (!config.general.imeGuardian && typeof imeGuardian !== 'undefined' && imeGuardian) {
      imeGuardian.reset();
    }
    savePersistentConfig();
  }

  function insertDateAtCursor() {
    const dateStr = getFormattedDateTime('standard');
    insertTextWithUndo(dateStr);
    onEditorInput();
  }

  function showMessage(msg, duration) {
    statMessage.textContent = msg;
    setTimeout(() => {
      if (statMessage.textContent === msg) statMessage.textContent = '';
    }, duration || 2500);
  }

  // Event Listeners
  function onEditorInput(skipAutocomplete = false) {
    const tab = getActiveTab();
    if (tab) {
      tab.content = editorEl.value;
      if (!tab.isDirty) {
        tab.isDirty = true;
        const activeTabEl = tabsListEl.querySelector('.tab-item.active');
        if (activeTabEl && !activeTabEl.querySelector('.tab-dirty-dot')) {
          const dotEl = document.createElement('span');
          dotEl.className = 'tab-dirty-dot';
          dotEl.textContent = '●';
          const titleEl = activeTabEl.querySelector('.tab-title');
          if (titleEl) titleEl.after(dotEl);
        }
      }

      // Zero-Taxonomy: If tab is unfiled/untitled, update tab title dynamically from 1st line
      if (tab.isAutoTitle && !tab.path) {
        const newTitle = deriveTitleFromContent(editorEl.value);
        if (newTitle && tab.title !== `${newTitle}.md`) {
          tab.title = `${newTitle}.md`;
          const activeTabEl = tabsListEl.querySelector('.tab-item.active');
          if (activeTabEl) {
            const titleEl = activeTabEl.querySelector('.tab-title');
            if (titleEl) titleEl.textContent = tab.title;
          }
        }
      }

      // Sync to secondary editor if editing the same note
      if (isSplitMode && secondaryViewMode === 'editor' && secondaryTabId === activeTabId) {
        if (editorSecondary && editorSecondary.value !== editorEl.value) {
          editorSecondary.value = editorEl.value;
          updateSecondaryLineNumbers();
        }
      }
    }
    updateLineNumbers();
    scheduleUpdateStatusBar();
    triggerZenModeActive();
    triggerAmbientContextDebounced();

    // Auto-save debouncing
    if (config.general.autoSave && tab && tab.path) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        saveActiveFile(false);
      }, 1500);
    }

    // Save session state (unfiled buffer persistence)
    saveSessionDebounced();

    // Live preview in split mode
    if (isSplitMode) {
      debouncedLivePreview();
    }

    // Trigger local LLM autocomplete
    if (skipAutocomplete !== true) {
      triggerAutocompleteDebounced();
    }
  }

  editorEl.addEventListener('compositionstart', () => {
    isComposing = true;
    clearGhostText();
    hideCursorAura(true);
    clearTimeout(autocompleteTimer);
  });
  editorEl.addEventListener('compositionend', () => {
    isComposing = false;
    triggerAutocompleteDebounced();
    triggerCursorAuraDebounced();
  });

  editorEl.addEventListener('input', () => {
    onEditorInput();
    hideCursorAura(false);
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('keyup', () => {
    scheduleUpdateStatusBar();
    if (activeImeSuggestion && editorEl.selectionStart !== activeImeSuggestion.endPos) {
      clearGhostText();
    }
    if (ghostOverlayEl) {
      ghostOverlayEl.scrollTop = editorEl.scrollTop;
      ghostOverlayEl.scrollLeft = editorEl.scrollLeft;
    }
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('click', () => {
    clearGhostText();
    updateStatusBar();
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('mouseup', () => {
    scheduleUpdateStatusBar();
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('select', () => {
    scheduleUpdateStatusBar();
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('scroll', () => {
    lineNumbersEl.scrollTop = editorEl.scrollTop;
    if (ghostOverlayEl) {
      ghostOverlayEl.scrollTop = editorEl.scrollTop;
      ghostOverlayEl.scrollLeft = editorEl.scrollLeft;
    }
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('focus', () => {
    activePane = 'primary';
    renderTabs();
  });
  editorEl.addEventListener('blur', () => {
    hideCursorAura(true);
  });
  window.addEventListener('blur', () => {
    hideCursorAura(true);
  });

  // Secondary Editor Event Listeners (Zero overhead when not in split mode)
  if (editorSecondary) {
    editorSecondary.addEventListener('input', () => {
      const secTab = getTab(secondaryTabId);
      if (secTab) {
        secTab.content = editorSecondary.value;
        secTab.isDirty = true;
        renderTabs();
      }
      if (secondaryTabId === activeTabId) {
        editorEl.value = editorSecondary.value;
        cachedLineCount = 0;
        updateLineNumbers();
      }
      updateSecondaryLineNumbers();
      saveSessionDebounced();
    });

    editorSecondary.addEventListener('scroll', () => {
      if (secondaryLineNumbers) {
        secondaryLineNumbers.scrollTop = editorSecondary.scrollTop;
      }
    });

    editorSecondary.addEventListener('focus', () => {
      activePane = 'secondary';
      renderTabs();
    });
  }

  // Intercept Paste for Direct Image OCR
  editorEl.addEventListener('paste', (e) => {
    clearGhostText();
    hideCursorAura(true);
    triggerCursorAuraDebounced();
    if (!config.general.pasteImageOcr) return;

    if (e.clipboardData && e.clipboardData.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            triggerClipboardImageOCR(file);
            return;
          }
        }
      }
    }
  });

  // Editor specific keydown (Tab key & Shift+Tab handling to keep focus inside editor)
  editorEl.addEventListener('keydown', (e) => {
    hideCursorAura(false);

    if (e.key === 'Tab') {
      // If ghost text / IME suggestion is active and user presses Tab (not Shift+Tab), accept completion
      if (!e.shiftKey && (ghostSuggestion || activeImeSuggestion)) {
        if (acceptGhostSuggestion()) {
          e.preventDefault();
          return;
        }
      }

      e.preventDefault(); // Always prevent Tab from moving focus to menu buttons

      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      const val = editorEl.value;
      const tabSpaces = '    '; // 4 spaces for markdown indentation

      if (start === end) {
        if (!e.shiftKey) {
          // Insert 4 spaces at cursor with undo history support
          insertTextWithUndo(tabSpaces);
        } else {
          // Shift+Tab: unindent current line
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          const lineText = val.substring(lineStart);
          if (lineText.startsWith('    ')) {
            editorEl.value = val.substring(0, lineStart) + lineText.substring(4);
            editorEl.selectionStart = Math.max(lineStart, start - 4);
            editorEl.selectionEnd = Math.max(lineStart, end - 4);
          } else if (lineText.startsWith('\t')) {
            editorEl.value = val.substring(0, lineStart) + lineText.substring(1);
            editorEl.selectionStart = Math.max(lineStart, start - 1);
            editorEl.selectionEnd = Math.max(lineStart, end - 1);
          } else if (lineText.startsWith(' ')) {
            const count = Math.min(lineText.search(/\S|$/), 4);
            editorEl.value = val.substring(0, lineStart) + lineText.substring(count);
            editorEl.selectionStart = Math.max(lineStart, start - count);
            editorEl.selectionEnd = Math.max(lineStart, end - count);
          }
        }
      } else {
        // Multi-line selection: indent or unindent whole block
        const startLineStart = val.lastIndexOf('\n', start - 1) + 1;
        let endLineEnd = val.indexOf('\n', end);
        if (endLineEnd === -1) endLineEnd = val.length;

        const selectedBlock = val.substring(startLineStart, endLineEnd);
        const lines = selectedBlock.split('\n');

        let modifiedLines;
        if (!e.shiftKey) {
          modifiedLines = lines.map(line => tabSpaces + line);
        } else {
          modifiedLines = lines.map(line => {
            if (line.startsWith('    ')) return line.substring(4);
            if (line.startsWith('\t')) return line.substring(1);
            return line.replace(/^ {1,3}/, '');
          });
        }

        const newBlock = modifiedLines.join('\n');
        editorEl.value = val.substring(0, startLineStart) + newBlock + val.substring(endLineEnd);
        editorEl.selectionStart = startLineStart;
        editorEl.selectionEnd = startLineStart + newBlock.length;
      }

      onEditorInput();
      return;
    }

    if (e.key === 'ArrowRight' && (e.ctrlKey || e.altKey) && ghostSuggestion) {
      if (editorEl.selectionStart === ghostTargetCursor) {
        if (acceptGhostWord()) {
          e.preventDefault();
          return;
        }
      }
    }

    if (e.key === 'ArrowRight' && ghostSuggestion) {
      if (editorEl.selectionStart === ghostTargetCursor) {
        if (acceptGhostSuggestion()) {
          e.preventDefault();
          return;
        }
      }
    }
  });

  // --- Editor Zoom (Font Size) ---
  let currentFontSize = 14;
  try {
    const savedSize = localStorage.getItem('md_memo_font_size');
    if (savedSize) currentFontSize = parseInt(savedSize, 10) || 14;
  } catch (e) {}

  function applyFontSize(size) {
    currentFontSize = Math.max(10, Math.min(36, size));
    editorEl.style.fontSize = `${currentFontSize}px`;
    ghostOverlayEl.style.fontSize = `${currentFontSize}px`;
    lineNumbersEl.style.fontSize = `${currentFontSize}px`;
    try {
      localStorage.setItem('md_memo_font_size', currentFontSize.toString());
    } catch (e) {}
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }
  applyFontSize(currentFontSize);

  function zoomIn() {
    applyFontSize(currentFontSize + 1);
  }
  function zoomOut() {
    applyFontSize(currentFontSize - 1);
  }
  function zoomReset() {
    applyFontSize(14);
  }

  // --- Zen Mode (Distraction-Free Focus) ---
  let zenTimer = null;
  function triggerZenModeActive() {
    if (document.body.classList.contains('zen-mode')) return;
    document.body.classList.add('zen-active');
    clearTimeout(zenTimer);
    zenTimer = setTimeout(() => {
      document.body.classList.remove('zen-active');
    }, 2800);
  }

  function cancelZenMode() {
    clearTimeout(zenTimer);
    document.body.classList.remove('zen-active');
  }

  function toggleZenMode() {
    const isZen = document.body.classList.toggle('zen-mode');
    if (isZen) {
      document.body.classList.remove('zen-active');
      showNotification(t('zenModeEnabled') || 'Zen Mode: Distraction-free (Esc / Ctrl+Shift+Z to exit)');
    } else {
      showNotification(t('zenModeDisabled') || 'Zen Mode: Off');
    }
  }

  // --- In-Place Non-Modal Inline Prompt Bar (Ctrl+K) ---
  let currentInlinePromptContext = null;

  function openInlinePromptBar() {
    clearGhostText();
    if (!inlinePromptBar) return;

    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    let selectedText = '';
    let isExplicitSelection = false;

    if (start !== end) {
      selectedText = editorEl.value.substring(start, end).trim();
      isExplicitSelection = true;
    }

    if (!selectedText) {
      const text = editorEl.value;
      const prevNewline = text.lastIndexOf('\n', start - 1);
      const nextNewline = text.indexOf('\n', end);
      const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
      const lineEnd = nextNewline === -1 ? text.length : nextNewline;
      selectedText = text.substring(lineStart, lineEnd).trim();
    }

    const curTab = getActiveTab();
    if (!curTab) return;

    currentInlinePromptContext = {
      tabId: curTab.id,
      selectedText: selectedText,
      isExplicitSelection: isExplicitSelection,
      startPos: start,
      endPos: end,
      insertPos: end
    };

    inlinePromptBar.classList.remove('hidden');
    inlinePromptInput.value = '';
    if (isExplicitSelection && selectedText) {
      const charLen = selectedText.length;
      inlinePromptInput.placeholder = `(選択範囲: ${charLen}文字) 指示を入力... (Enterで実行, Escで閉じる)`;
    } else {
      inlinePromptInput.placeholder = "AIに指示 (編集/要約/変換/翻訳... Enterで実行, Escで閉じる)";
    }

    // Position inline prompt bar right beneath the cursor / selection
    try {
      const targetCursor = isExplicitSelection ? end : start;
      const coords = getCharPixelCoords(targetCursor);
      const editorRect = editorEl.getBoundingClientRect();
      const workspaceRect = workspaceEl ? workspaceEl.getBoundingClientRect() : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };

      // Calculate pixel coordinates relative to #workspace container
      const cursorX = (editorRect.left - workspaceRect.left) + (coords.left - editorEl.scrollLeft);
      const cursorY = (editorRect.top - workspaceRect.top) + (coords.top - editorEl.scrollTop);

      const barWidth = 420;
      const barHeight = 46;
      const lineHeight = Math.max(22, Math.round(currentFontSize * 1.6));

      // Desired X: aligned with cursor, clamped within workspace bounds
      let posX = Math.max(16, Math.min(workspaceRect.width - barWidth - 16, cursorX - 10));
      // Desired Y: directly beneath cursor line
      let posY = cursorY + lineHeight + 6;

      // If opening below would overflow workspace bottom, display directly above cursor line
      if (posY + barHeight > workspaceRect.height - 10) {
        posY = Math.max(10, cursorY - barHeight - 6);
      }

      inlinePromptBar.style.left = `${Math.round(posX)}px`;
      inlinePromptBar.style.top = `${Math.round(posY)}px`;
      inlinePromptBar.style.width = `${barWidth}px`;
    } catch (err) {
      console.warn('Failed to compute cursor position for inline prompt bar:', err);
      inlinePromptBar.style.left = '24px';
      inlinePromptBar.style.top = '12px';
      inlinePromptBar.style.width = '420px';
    }

    inlinePromptInput.focus();
  }

  function closeInlinePromptBar() {
    if (inlinePromptBar) inlinePromptBar.classList.add('hidden');
    currentInlinePromptContext = null;
    editorEl.focus();
  }

  function executeInlinePromptQuery() {
    if (!currentInlinePromptContext) return;

    const ctx = currentInlinePromptContext;
    const instruction = inlinePromptInput.value.trim();
    const curTab = getTab(ctx.tabId);
    if (!curTab) {
      closeInlinePromptBar();
      return;
    }

    if (!instruction && !ctx.selectedText) {
      closeInlinePromptBar();
      return;
    }

    let finalPrompt = ctx.selectedText;
    if (instruction && ctx.selectedText) {
      finalPrompt = `【指示】:\n${instruction}\n\n【対象テキスト】:\n${ctx.selectedText}`;
    } else if (instruction) {
      finalPrompt = instruction;
    }

    const reqId = 'llm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[AI生成中: ${instruction ? instruction.substring(0, 20) : '処理中'}...]`;

    const insertPos = ctx.insertPos;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();
    closeInlinePromptBar();

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, finalPrompt, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `(AI生成完了)\n> "${finalPrompt}"\nについての回答です。`, '');
      }, 2500);
    }
  }

  // AI Typo, Mistake & Context Correction (Alt+C)
  async function triggerAICorrection() {
    clearGhostText();
    const curTab = getActiveTab();
    if (!curTab) return;

    let targetText = '';
    let isExplicitSelection = false;
    let start = editorEl.selectionStart;
    let end = editorEl.selectionEnd;

    if (end > start) {
      targetText = editorEl.value.substring(start, end).trim();
      isExplicitSelection = true;
    } else {
      const text = editorEl.value;
      const prevNewline = text.lastIndexOf('\n', start - 1);
      const nextNewline = text.indexOf('\n', end);
      start = prevNewline === -1 ? 0 : prevNewline + 1;
      end = nextNewline === -1 ? text.length : nextNewline;
      targetText = text.substring(start, end).trim();
    }

    if (!targetText) {
      showMessage(t('aiCorrectionNoText'), 3000);
      return;
    }

    const reqId = 'correct_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[AI補正中...]`;

    editorEl.setSelectionRange(start, end);
    insertTextWithUndo(anchorId);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();
    showMessage(t('aiCorrecting'), 3000);

    const promptPayload = `以下のテキストの誤字・脱字・打ち間違い・変換ミス・文脈エラーを自然に修正し、修正後のテキストのみを出力してください。解説や挨拶は一切不要です。\n\n【対象テキスト】:\n${targetText}`;

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, promptPayload, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, targetText, '');
      }, 1500);
    }
  }

  if (inlinePromptInput) {
    inlinePromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        executeInlinePromptQuery();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeInlinePromptBar();
      }
    });
  }
  if (btnInlinePromptSend) btnInlinePromptSend.onclick = executeInlinePromptQuery;
  if (btnInlinePromptClose) btnInlinePromptClose.onclick = closeInlinePromptBar;

  // --- Degram-inspired Lightweight Diagram & Mermaid Engine ---
  const DEGRAM_MERMAID_SYSTEM_PROMPT = `You are a Mermaid.js diagram expert. Convert the user's text into a clean, accurate Mermaid 11 diagram.
STRICT SYNTAX SAFETY RULES:
1. Node IDs MUST be ASCII-only alphanumeric (e.g. A, Node1, ProcB). NEVER use Japanese or spaces in IDs.
2. ALL labels must be enclosed in double quotes: id["Label Text"]. Use <br/> for line breaks inside labels.
3. NEVER use the reserved word 'end' as an ID, participant, or label. Use Finish, EndStep, etc.
4. Replace inner double quotes with single quotes. Use fullwidth （ ） for parentheses in labels.
5. Flowchart subgraphs MUST use: subgraph SG1["Title"] ... end.
6. Choose the best diagram type: flowchart, sequenceDiagram, stateDiagram-v2, mindmap, timeline, or quadrantChart.
7. Return ONLY the markdown fenced mermaid code block (\`\`\`mermaid ... \`\`\`) with NO conversational filler or greetings.`;

  function convertSelectionToMermaid() {
    clearGhostText();
    const curTab = getActiveTab();
    if (!curTab) return;

    let targetText = '';
    const selStart = editorEl.selectionStart;
    const selEnd = editorEl.selectionEnd;

    if (selEnd > selStart) {
      targetText = editorEl.value.substring(selStart, selEnd);
    } else {
      // If nothing selected, use current paragraph or full content
      const val = editorEl.value;
      const prevBreak = val.lastIndexOf('\n\n', selStart - 1);
      const nextBreak = val.indexOf('\n\n', selStart);
      const pStart = prevBreak === -1 ? 0 : prevBreak + 2;
      const pEnd = nextBreak === -1 ? val.length : nextBreak;
      targetText = val.substring(pStart, pEnd).trim();
      if (!targetText) {
        targetText = val.trim();
      }
    }

    if (!targetText) {
      showMessage('Mermaid図に変換するテキストがありません', 3000);
      return;
    }

    const reqId = 'mermaid_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[Mermaid図生成中 (Degram Engine)...]`;

    const insertPos = selEnd > selStart ? selEnd : editorEl.selectionEnd;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();

    const promptPayload = `以下の内容を理解し、最も分かりやすい構造のMermaid 11図コードを作成してください。\n\n【対象テキスト】:\n${targetText}`;
    const llmCfg = Object.assign({}, config.text, {
      systemPrompt: DEGRAM_MERMAID_SYSTEM_PROMPT
    });

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, promptPayload, JSON.stringify(llmCfg));
    } else {
      setTimeout(() => {
        const mockMermaid = '```mermaid\nflowchart TD\n  A["' + targetText.substring(0, 15).replace(/"/g, "'") + '"] --> B["分析・整理"]\n  B --> C["出力・図解"]\n```';
        window.__onLLMResult(reqId, mockMermaid, '');
      }, 2000);
    }
  }

  function extractMermaidAtCursor() {
    const val = editorEl.value;
    const curPos = editorEl.selectionStart;

    // Check if selection itself is a mermaid block
    const selStart = editorEl.selectionStart;
    const selEnd = editorEl.selectionEnd;
    if (selEnd > selStart) {
      const selected = val.substring(selStart, selEnd).trim();
      if (selected.includes('```mermaid') || selected.startsWith('flowchart') || selected.startsWith('sequenceDiagram')) {
        return selected.replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim();
      }
    }

    // Search for closest ```mermaid ... ``` block surrounding cursor
    const beforeCursor = val.substring(0, curPos);
    const blockStartIdx = beforeCursor.lastIndexOf('```mermaid');
    if (blockStartIdx !== -1) {
      const blockEndIdx = val.indexOf('```', blockStartIdx + 10);
      if (blockEndIdx !== -1 && curPos <= blockEndIdx + 3) {
        return val.substring(blockStartIdx + 10, blockEndIdx).trim();
      }
    }

    // Fallback: look for ANY ```mermaid in the note
    const match = val.match(/```mermaid([\s\S]*?)```/i);
    if (match) {
      return match[1].trim();
    }

    return null;
  }

  // --- Clean Material Design 3 Infographic Image Prompt Generator ---
  const CLEAN_INFOGRAPHIC_STYLE = 
    "Material Design 3 infographic design system. " +
    "Flat solid colors only — absolutely NO gradients anywhere. " +
    "Page canvas is a slightly blue-tinted light grey (#f0f4f9); content sits on pure white cards with a 28px corner radius, a 1px light grey border (#c4c7c5) and NO drop shadow. " +
    "Primary accent is Action Blue #0b57d0, used sparingly; supporting elements use a soft tonal blue container tint (#d3e3fd). " +
    "Action-like elements are full pill shapes; inputs 4px radius. " +
    "Typography is a clean geometric sans (Rubik / Roboto / Noto Sans JP): headings are LARGE but at normal-to-medium weight, never heavy bold. Japanese text is set in Noto Sans JP. " +
    "Icons are Google Material Symbols Outlined line icons, 24px, monochrome. " +
    "Strict 8px spacing grid, generous structural spacing, left-aligned layout, content width feels like a 1440px max-width document. " +
    "Calm, restrained, corporate-internal-tool aesthetic — solid color, type and line icons instead of illustration or photography.";

  const CLEAN_INFOGRAPHIC_NEGATIVES = 
    "No gradients of any kind. No drop shadows on cards. No heavy bold headings. " +
    "No emoji, no Unicode-symbol icons, no filled/colored icon badges. " +
    "No photography, no photorealism, no 3D, no glossy or glassy effects. " +
    "No hand-drawn or sketchy style. No neon, no dark cyberpunk. No decorative illustration. " +
    "No gibberish text. No random placeholder words. No blurry text. No tiny unreadable text. " +
    "Do NOT render any prompt meta labels such as: REFERENCE, DIAGRAM FIDELITY, TEXT FIDELITY, NEGATIVE CONSTRAINTS. " +
    "Do NOT render the instruction text of this prompt. Render only content derived from the Mermaid diagram.";

  function extractFlowDirectionText(code) {
    const src = String(code == null ? '' : code).replace(/\r/g, '');
    const first = src.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
    const flow = /^(?:flowchart|graph)\s+([A-Za-z]{2})\b/i.exec(first);
    if (flow && flow[1]) {
      const dir = flow[1].toUpperCase();
      switch (dir) {
        case 'LR': return 'from left to right';
        case 'RL': return 'from right to left';
        case 'TB':
        case 'TD': return 'from top to bottom';
        case 'BT': return 'from bottom to top';
      }
    }
    const stateDir = /(?:^|\n)\s*direction\s+([A-Za-z]{2})\b/i.exec(src);
    if (stateDir && stateDir[1]) {
      const dir = stateDir[1].toUpperCase();
      switch (dir) {
        case 'LR': return 'from left to right';
        case 'RL': return 'from right to left';
        case 'TB':
        case 'TD': return 'from top to bottom';
        case 'BT': return 'from bottom to top';
      }
    }
    return 'with a clear directional flow';
  }

  function deriveDiagramTitle(mermaidCode, noteContent) {
    const src = String(mermaidCode == null ? '' : mermaidCode).replace(/\r/g, '');
    const m = /^\s*(?:%%\s*)?title\s*[:\s]\s*["']?(.+?)["']?\s*$/im.exec(src);
    if (m && m[1]) return m[1].trim();

    // Try finding title from note content near mermaid
    if (noteContent) {
      const lines = noteContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#') && !line.includes('```')) {
          return line.replace(/^#+\s*/, '').trim();
        }
      }
    }
    return 'プロセス構造図';
  }

  function buildInfographicImagePrompt(mermaidCode, noteContent) {
    const dirText = extractFlowDirectionText(mermaidCode);
    const title = deriveDiagramTitle(mermaidCode, noteContent);

    return [
      `A high-quality ${CLEAN_INFOGRAPHIC_STYLE}`,
      `REFERENCE (Mermaid code for understanding only; do NOT render this text verbatim): """\n${mermaidCode}\n"""`,
      `DIAGRAM FIDELITY (highest priority): The Mermaid code is the blueprint. Render a clean diagram/infographic that matches the Mermaid structure exactly: include every node and every edge; preserve branches/merges; preserve subgraph groupings as separate containers with titles; follow the declared direction (${dirText}).`,
      `TEXT FIDELITY: Copy node labels, decision labels, and subgraph titles from the Mermaid code VERBATIM. Do not translate, do not paraphrase, do not summarize Mermaid labels. Do not invent any new labels that are not present in the Mermaid code.`,
      `Text rendering: render clean, sharp, legible labels for nodes, decisions, and subgraph titles in Japanese (Noto Sans JP) or original language from the Mermaid diagram.`,
      `Slide layout: wide 16:9. Use a clean card composition: (1) a prominent header title '${title}' (normal-to-medium weight geometric sans), (2) a central diagram area following the Mermaid structure on crisp white cards with 28px rounded corners and 1px light border, (3) clear directional arrows with Action Blue #0b57d0 accents.`,
      `Visual system: strict 8px spacing grid, Google Material Symbols Outlined line icons, consistent stroke weight, clear arrowheads, generous structural whitespace.`,
      `TITLE RULE: The slide must prominently display the header title: '${title}'.`,
      `NEGATIVE CONSTRAINTS: ${CLEAN_INFOGRAPHIC_NEGATIVES}`,
      `high resolution, 8k, sharp focus, aesthetic composition, publication-ready vector finish.`
    ].join(' ');
  }

  function generateImageFromMermaid() {
    clearGhostText();
    const curTab = getActiveTab();
    if (!curTab) return;

    const mermaidCode = extractMermaidAtCursor();
    if (!mermaidCode) {
      showMessage('カーソル付近にMermaid図 (```mermaid ...) が見つかりません', 4000);
      return;
    }

    // Check Gemini API key in config.vision
    const apiKey = (config.vision && config.vision.apiKey) || (config.text && config.text.apiKey) || '';
    if (!apiKey && (!window.backend || !window.backend.generateImageAsync)) {
      showMessage('Gemini API Keyを設定画面 (Settings) で入力してください', 4000);
      return;
    }

    const reqId = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[AI画像生成中 (Gemini - Clean Infographic)...]`;

    // Find the end of the mermaid block to insert image directly below it
    const val = editorEl.value;
    const mermaidBlockIdx = val.indexOf(mermaidCode);
    let insertPos = editorEl.selectionEnd;
    if (mermaidBlockIdx !== -1) {
      const fenceEnd = val.indexOf('```', mermaidBlockIdx + mermaidCode.length);
      if (fenceEnd !== -1) {
        insertPos = fenceEnd + 3;
      }
    }

    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();

    const imageGenPrompt = buildInfographicImagePrompt(mermaidCode, curTab.content);
    const imageConfig = {
      baseUrl: (config.vision && config.vision.baseUrl) || 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.1-flash-lite-image',
      apiKey: apiKey,
      aspectRatio: '16:9'
    };

    if (window.backend && window.backend.generateImageAsync) {
      window.backend.generateImageAsync(reqId, imageGenPrompt, JSON.stringify(imageConfig), curTab.path || '');
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `![Generated Diagram](https://placehold.co/800x450/252526/ffffff?text=Gemini+Infographic)`, '');
      }, 2500);
    }
  }

  function generateImagePromptFromMermaid() {
    clearGhostText();
    const curTab = getActiveTab();
    if (!curTab) return;

    const mermaidCode = extractMermaidAtCursor();
    if (!mermaidCode) {
      showMessage('カーソル付近にMermaid図 (```mermaid ...) が見つかりません', 4000);
      return;
    }

    const reqId = 'imgprompt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const anchorId = `[画像生成プロンプト構築中 (Material Design)...]`;

    const insertPos = editorEl.selectionEnd;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    pendingLLMRequests.set(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();

    const infoPrompt = buildInfographicImagePrompt(mermaidCode, curTab.content);
    const promptPayload = `以下のMermaid図の構造と意味を理解し、GeminiやMidjourney等でMaterial Design 3（Action Blue #0b57d0, フラット単色, 白カード28px角丸, ドロップシャドウ・グラデーション禁止, Noto Sans JP）に完全準拠した美麗なインフォグラフィック図解を生成するための「英語プロンプト」を出力してください。\n\n【推奨ベースプロンプト】:\n${infoPrompt}\n\n【Mermaid図】:\n${mermaidCode}\n\n回答はプロンプト（英語）のみを引用形式で出力してください。`;

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, promptPayload, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `> ${infoPrompt}`, '');
      }, 1500);
    }
  }



  // --- Phase 3: Ambient Context Engine (Serendipity Recall) ---
  let ambientDebounceTimer = null;

  function triggerAmbientContextDebounced() {
    clearTimeout(ambientDebounceTimer);
    ambientDebounceTimer = setTimeout(() => {
      triggerAmbientContextImmediate();
    }, 1200);
  }

  function triggerAmbientContextImmediate() {
    if (!statAmbientContainer) return;
    if (!workspaceNotes || workspaceNotes.length === 0) {
      statAmbientContainer.classList.add('hidden');
      statAmbientContainer.innerHTML = '';
      return;
    }

    const val = editorEl.value;
    const curPos = editorEl.selectionStart;
    // Extract context: current line and recent 250 characters before cursor
    const lineStart = Math.max(0, val.lastIndexOf('\n', curPos - 1) + 1);
    const lineEnd = val.indexOf('\n', curPos);
    const curLine = val.substring(lineStart, lineEnd === -1 ? val.length : lineEnd).trim();
    const recentChunk = val.substring(Math.max(0, curPos - 250), curPos).trim();

    // Extract significant keywords (length >= 2, non-trivial)
    const combined = `${curLine} ${recentChunk}`;
    const words = combined.match(/[\u4e00-\u9faf\u3040-\u309f\u30a0-\u30ffa-zA-Z0-9_-]{2,}/g) || [];
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'were', 'what', 'which', 'また', 'これ', 'それ', 'その', 'です', 'ます', 'ある', 'する', 'こと', 'よう', 'ため', 'など', 'への', 'から', 'まで']);
    const uniqueKeywords = [...new Set(words.filter(w => !stopWords.has(w.toLowerCase()) && w.length >= 2))].slice(0, 8);

    if (uniqueKeywords.length === 0) {
      statAmbientContainer.classList.add('hidden');
      statAmbientContainer.innerHTML = '';
      return;
    }

    const curTab = getActiveTab();
    const currentPath = (curTab && curTab.path) || '';

    // Score notes based on BM25-style keyword occurrence in title and snippet
    const scored = [];
    for (const note of workspaceNotes) {
      if (note.path === currentPath) continue; // Skip active note itself

      let score = 0;
      const lowerTitle = (note.title || '').toLowerCase();
      const lowerSnippet = (note.snippet || '').toLowerCase();
      const lowerRel = (note.relPath || '').toLowerCase();

      for (const kw of uniqueKeywords) {
        const lowerKw = kw.toLowerCase();
        if (lowerTitle.includes(lowerKw)) score += 3;
        if (lowerSnippet.includes(lowerKw)) score += 1.5;
        if (lowerRel.includes(lowerKw)) score += 1;
      }

      if (score > 0) {
        scored.push({ note, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topPicks = scored.slice(0, 2);

    if (topPicks.length === 0) {
      statAmbientContainer.classList.add('hidden');
      statAmbientContainer.innerHTML = '';
      return;
    }

    statAmbientContainer.innerHTML = '';
    for (const item of topPicks) {
      const pill = document.createElement('div');
      pill.className = 'ambient-pill';
      pill.title = `${item.note.title} (${item.note.relPath})\n${item.note.snippet}`;
      pill.innerHTML = `<span class="ambient-pill-icon">✦</span> ${escapeHtml(item.note.title)}`;
      pill.onclick = async () => {
        if (window.backend && window.backend.readFileByPath) {
          try {
            const res = await window.backend.readFileByPath(item.note.path);
            if (res && res.content !== undefined) {
              createTab(res.title, res.content, res.path, res.encoding);
            }
          } catch (e) {
            showMessage(`${t('openError')}${e.message || e}`, 4000);
          }
        }
      };
      statAmbientContainer.appendChild(pill);
    }
    statAmbientContainer.classList.remove('hidden');
  }

  // --- Quick Pick Palette & Fast Fuzzy Search (Ctrl+Shift+P / Ctrl+P) ---
  let quickPickItems = [];
  let quickPickSelectedIndex = 0;

  function openQuickPick(mode = 'all') {
    if (!quickPickModal) return;
    clearGhostText();

    // Prepare default items: actions & commands
    const baseCommands = [
      {
        id: 'cmd_new_tab',
        title: 'New Note / Tab (新規タブ作成)',
        desc: 'Zero-Taxonomy blank slate (Ctrl+N / Ctrl+T)',
        action: () => createTab()
      },
      {
        id: 'cmd_open_file',
        title: 'Open File (ファイルを開く)',
        desc: 'Native OS file picker (Ctrl+O)',
        action: () => openFile()
      },
      {
        id: 'cmd_open_folder',
        title: 'Open Notes Folder (ワークスペースフォルダを開く)',
        desc: 'Bring Your Own Notes workspace (Ctrl+Shift+O)',
        action: () => openFolder()
      },
      {
        id: 'cmd_pipe_polish',
        title: 'UNIX Pipe: Polish & Refactor (文章推敲・リファクタ)',
        desc: 'Send selection/line to LLM for writing polish',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = '文章を推敲し、簡潔かつ論理的な表現に整えてください。';
        }
      },
      {
        id: 'cmd_pipe_bullets',
        title: 'UNIX Pipe: Convert to Bullet Points (箇条書き要約)',
        desc: 'Summarize target section into structured Markdown bullets',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = '重要なポイントを抽出し、Markdownの箇条書きに要約してください。';
        }
      },
      {
        id: 'cmd_pipe_tasks',
        title: 'UNIX Pipe: Extract Action Items (未完了タスク抽出)',
        desc: 'Extract action items as [ ] Markdown tasks',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = '文章から未完了タスク・TODOを抽出し、- [ ] 形式のチェックリストに変換してください。';
        }
      },
      {
        id: 'cmd_convert_mermaid',
        title: '⚡ Diagram: Convert Selection to Mermaid (選択範囲を図解)',
        desc: 'Convert text to Mermaid flowchart/sequence/mindmap via Degram prompt',
        action: () => convertSelectionToMermaid()
      },
      {
        id: 'cmd_mermaid_to_image',
        title: '🎨 Diagram: Generate Image with Gemini (Mermaidから画像生成)',
        desc: 'Render Mermaid diagram as a modern visual infographic using Gemini',
        action: () => generateImageFromMermaid()
      },
      {
        id: 'cmd_mermaid_to_prompt',
        title: '📝 Diagram: Generate Image Prompt from Mermaid (画像プロンプト抽出)',
        desc: 'Extract optimized Midjourney / DALL-E prompt from Mermaid diagram',
        action: () => generateImagePromptFromMermaid()
      },
      {
        id: 'cmd_ai_correct',
        title: '✨ AI Typo & Mistake Correction (入力間違い・誤字脱字自動補正)',
        desc: 'Correct typos and mistypes via AI context analysis (Alt+C)',
        action: () => triggerAICorrection()
      },
      {
        id: 'cmd_export_plain',
        title: 'Export as Clean Plain Text (.txt)',
        desc: 'Strip Markdown formatting and export clean plain text',
        action: () => exportPlainText()
      },
      {
        id: 'cmd_toggle_zen',
        title: 'Toggle Zen Mode (集中モード切替)',
        desc: 'Full distraction-free writing space (Ctrl+Shift+Z)',
        action: () => toggleZenMode()
      },
      {
        id: 'cmd_toggle_split',
        title: 'Toggle Split View (左右分割切替)',
        desc: 'Side-by-side editor and live preview (Ctrl+\\)',
        action: () => toggleSplitMode()
      }
    ];

    // Add workspace notes as searchable entries
    const noteCommands = (workspaceNotes || []).map(note => ({
      id: `note_${note.path}`,
      title: `📄 ${note.title}`,
      desc: `${note.relPath} — ${note.snippet}`,
      action: async () => {
        if (window.backend && window.backend.readFileByPath) {
          try {
            const res = await window.backend.readFileByPath(note.path);
            if (res && res.content !== undefined) {
              createTab(res.title, res.content, res.path, res.encoding);
            }
          } catch (e) {
            showMessage(`${t('openError')}${e.message || e}`, 4000);
          }
        }
      }
    }));

    quickPickItems = [...baseCommands, ...noteCommands];
    quickPickSelectedIndex = 0;
    quickPickInput.value = '';
    renderQuickPickList();

    quickPickModal.classList.remove('hidden');
    setTimeout(() => {
      quickPickInput.focus();
      quickPickInput.select();
    }, 50);
  }

  function closeQuickPick() {
    if (quickPickModal) quickPickModal.classList.add('hidden');
    editorEl.focus();
  }

  function renderQuickPickList() {
    if (!quickPickList) return;
    const filter = (quickPickInput.value || '').trim().toLowerCase();

    const matched = quickPickItems.filter(item => {
      if (!filter) return true;
      return item.title.toLowerCase().includes(filter) || (item.desc && item.desc.toLowerCase().includes(filter));
    });

    quickPickList.innerHTML = '';
    if (matched.length === 0) {
      quickPickList.innerHTML = `<div style="padding: 12px 16px; color: var(--text-muted); font-size: 13px;">${t('noMatches')}</div>`;
      return;
    }

    if (quickPickSelectedIndex >= matched.length) {
      quickPickSelectedIndex = Math.max(0, matched.length - 1);
    }

    matched.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = `quick-pick-item ${idx === quickPickSelectedIndex ? 'active' : ''}`;
      el.innerHTML = `
        <div class="quick-pick-item-title">${escapeHtml(item.title)}</div>
        ${item.desc ? `<div class="quick-pick-item-desc">${escapeHtml(item.desc)}</div>` : ''}
      `;
      el.onmousedown = (e) => {
        e.preventDefault();
        closeQuickPick();
        item.action();
      };
      quickPickList.appendChild(el);
    });

    // Auto-scroll selected item into view
    const activeItemEl = quickPickList.children[quickPickSelectedIndex];
    if (activeItemEl) {
      activeItemEl.scrollIntoView({ block: 'nearest' });
    }
  }

  if (quickPickInput) {
    quickPickInput.addEventListener('input', () => {
      quickPickSelectedIndex = 0;
      renderQuickPickList();
    });

    quickPickInput.addEventListener('keydown', (e) => {
      const items = quickPickList.querySelectorAll('.quick-pick-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length > 0) {
          quickPickSelectedIndex = (quickPickSelectedIndex + 1) % items.length;
          renderQuickPickList();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length > 0) {
          quickPickSelectedIndex = (quickPickSelectedIndex - 1 + items.length) % items.length;
          renderQuickPickList();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const filter = (quickPickInput.value || '').trim().toLowerCase();
        const matched = quickPickItems.filter(item => {
          if (!filter) return true;
          return item.title.toLowerCase().includes(filter) || (item.desc && item.desc.toLowerCase().includes(filter));
        });
        if (matched.length > 0 && matched[quickPickSelectedIndex]) {
          closeQuickPick();
          matched[quickPickSelectedIndex].action();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeQuickPick();
      }
    });
  }

  // --- Find & Replace & Navigation ---
  let findMatches = [];
  let currentMatchIndex = -1;
  let isCaseSensitive = false;
  let isWholeWord = false;
  let isRegex = false;

  function openFindBar(showReplace = false) {
    findReplaceBar.classList.remove('hidden');
    if (showReplace) {
      replaceRow.classList.remove('hidden');
      btnToggleReplace.textContent = '▼';
    }
    const selStart = editorEl.selectionStart;
    const selEnd = editorEl.selectionEnd;
    if (selEnd > selStart) {
      const selected = editorEl.value.substring(selStart, selEnd);
      if (!selected.includes('\n')) {
        findInput.value = selected;
      }
    }
    searchMatches();
    if (showReplace && findInput.value) {
      replaceInput.focus();
      replaceInput.select();
    } else {
      findInput.focus();
      findInput.select();
    }
  }

  function closeFindBar() {
    findReplaceBar.classList.add('hidden');
    findMatches = [];
    currentMatchIndex = -1;
    editorEl.focus();
  }

  function toggleReplaceRow() {
    const isHidden = replaceRow.classList.toggle('hidden');
    btnToggleReplace.textContent = isHidden ? '▶' : '▼';
    if (!isHidden) {
      replaceInput.focus();
    }
  }

  function searchMatches() {
    const query = findInput.value;
    if (!query) {
      findMatches = [];
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
      return;
    }

    const text = editorEl.value;
    findMatches = [];

    try {
      let pattern = query;
      if (!isRegex) {
        pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (isWholeWord) {
        pattern = '\\b' + pattern + '\\b';
      }
      const flags = isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);

      let match;
      while ((match = regex.exec(text)) !== null) {
        findMatches.push({ start: match.index, end: match.index + match[0].length });
        if (regex.lastIndex === match.index) {
          regex.lastIndex++;
        }
      }
    } catch (e) {
      findCount.textContent = '!';
      return;
    }

    if (findMatches.length === 0) {
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
    } else {
      const cursorPos = editorEl.selectionStart;
      let closestIdx = findMatches.findIndex(m => m.start >= cursorPos);
      if (closestIdx === -1) closestIdx = 0;
      currentMatchIndex = closestIdx;
      findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
    }
  }

  // Accurate pixel coordinate calculation (top & left) for character offset in textarea
  function getCharPixelCoords(charIndex) {
    if (!editorEl) return { top: 0, left: 0 };
    try {
      const mirror = document.createElement('div');
      const style = window.getComputedStyle(editorEl);
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.pointerEvents = 'none';
      mirror.style.top = '0';
      mirror.style.left = '-9999px';
      mirror.style.width = `${editorEl.clientWidth}px`;
      mirror.style.fontFamily = style.fontFamily;
      mirror.style.fontSize = style.fontSize;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.padding = style.padding;
      mirror.style.boxSizing = style.boxSizing;
      mirror.style.whiteSpace = style.whiteSpace;
      mirror.style.wordWrap = style.wordWrap;
      mirror.style.tabSize = style.tabSize;

      const before = editorEl.value.substring(0, charIndex);
      const span = document.createElement('span');
      span.textContent = '|';

      mirror.textContent = before;
      mirror.appendChild(span);
      document.body.appendChild(mirror);

      const coords = { top: span.offsetTop, left: span.offsetLeft };
      document.body.removeChild(mirror);
      return coords;
    } catch (e) {
      const lineNum = editorEl.value.substring(0, charIndex).split('\n').length;
      return { top: (lineNum - 1) * 22, left: 14 };
    }
  }

  function getCharPixelTop(charIndex) {
    return getCharPixelCoords(charIndex).top;
  }

  // --- 🌌 Subtle Cursor Aura (Ambient Affordance Engine) ---

  function getAuraGradientForTheme() {
    const theme = (config.general && config.general.theme) || 'olive';
    switch (theme) {
      case 'blue':
        return 'radial-gradient(circle, rgba(14, 99, 156, 0.14) 0%, rgba(0, 122, 204, 0.06) 45%, rgba(0, 122, 204, 0) 75%)';
      case 'forest':
        return 'radial-gradient(circle, rgba(46, 102, 86, 0.15) 0%, rgba(31, 64, 55, 0.07) 45%, rgba(31, 64, 55, 0) 75%)';
      case 'charcoal':
        return 'radial-gradient(circle, rgba(255, 255, 255, 0.08) 0%, rgba(200, 200, 200, 0.03) 45%, rgba(255, 255, 255, 0) 75%)';
      case 'olive':
      default:
        // Default warm dark olive subtle ambient glow
        return 'radial-gradient(circle, rgba(138, 154, 91, 0.15) 0%, rgba(85, 107, 47, 0.07) 45%, rgba(85, 107, 47, 0) 75%)';
    }
  }

  function hideCursorAura(immediate) {
    clearTimeout(cursorAuraTimer);
    clearTimeout(cursorAuraFadeTimer);
    if (!cursorAuraEl) return;
    if (immediate) {
      cursorAuraEl.style.transition = 'none';
      cursorAuraEl.classList.remove('active');
      cursorAuraEl.style.display = 'none';
      // Force reflow to restore transition
      void cursorAuraEl.offsetHeight;
      cursorAuraEl.style.transition = '';
    } else {
      cursorAuraEl.classList.remove('active');
      cursorAuraFadeTimer = setTimeout(() => {
        if (!cursorAuraEl.classList.contains('active')) {
          cursorAuraEl.style.display = 'none';
        }
      }, 1800);
    }
  }

  function triggerCursorAuraDebounced() {
    hideCursorAura(false);
    if (!config.general || config.general.cursorAura === false) return;
    if (isPreviewMode || !editorEl) return;

    cursorAuraTimer = setTimeout(() => {
      showCursorAura();
    }, CURSOR_AURA_IDLE_DELAY);
  }

  function showCursorAura() {
    if (!config.general || config.general.cursorAura === false) return;
    if (isPreviewMode || !editorEl || !cursorAuraEl) return;

    // Only activate if window / editor is active
    if (document.activeElement !== editorEl && !document.hasFocus()) return;

    const cursorPos = editorEl.selectionStart;
    const coords = getCharPixelCoords(cursorPos);

    // Calculate position relative to editor-wrapper considering textarea scroll offset
    const x = coords.left - editorEl.scrollLeft;
    const y = coords.top - editorEl.scrollTop + 10; // align with middle of font line

    // Verify coordinates are within editor viewport
    if (x < 0 || x > editorEl.clientWidth || y < 0 || y > editorEl.clientHeight) {
      hideCursorAura(true);
      return;
    }

    const auraSize = Math.max(160, Math.min(260, Math.round(currentFontSize * 14)));
    cursorAuraEl.style.width = `${auraSize}px`;
    cursorAuraEl.style.height = `${auraSize}px`;
    cursorAuraEl.style.background = getAuraGradientForTheme();
    cursorAuraEl.style.left = `${x}px`;
    cursorAuraEl.style.top = `${y}px`;
    cursorAuraEl.style.display = 'block';

    // Micro-delay to ensure smooth CSS transition activation
    requestAnimationFrame(() => {
      cursorAuraEl.classList.add('active');
    });
  }

  function goToMatch(index) {
    if (findMatches.length === 0) return;
    currentMatchIndex = (index + findMatches.length) % findMatches.length;
    const match = findMatches[currentMatchIndex];
    editorEl.focus();
    editorEl.setSelectionRange(match.start, match.end);

    const charTop = getCharPixelTop(match.start);
    const viewHeight = editorEl.clientHeight;
    // Find bar height + top margin is ~75px. We reserve ~80px top buffer so match is not hidden underneath it.
    const topReserved = 85;
    const currentScroll = editorEl.scrollTop;
    const charBottom = charTop + 24;

    // Check if match is already comfortably in view outside the find bar area
    const isVisible = (charTop >= currentScroll + topReserved) && (charBottom <= currentScroll + viewHeight - 20);
    if (!isVisible) {
      // Center the match in the visible area below the find bar
      const availableHeight = Math.max(100, viewHeight - topReserved);
      const targetScroll = Math.max(0, charTop - topReserved - Math.floor(availableHeight / 3));
      editorEl.scrollTop = targetScroll;
      if (lineNumbersEl) lineNumbersEl.scrollTop = targetScroll;
      if (ghostOverlayEl) ghostOverlayEl.scrollTop = targetScroll;
    }

    findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
  }

  function findNext() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    // If current selection is not the current match, go to current match first
    const m = findMatches[currentMatchIndex];
    if (m && (editorEl.selectionStart !== m.start || editorEl.selectionEnd !== m.end)) {
      goToMatch(currentMatchIndex);
    } else {
      goToMatch(currentMatchIndex + 1);
    }
  }

  function findPrev() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    const m = findMatches[currentMatchIndex];
    if (m && (editorEl.selectionStart !== m.start || editorEl.selectionEnd !== m.end)) {
      goToMatch(currentMatchIndex);
    } else {
      goToMatch(currentMatchIndex - 1);
    }
  }

  function replaceOne() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0 || currentMatchIndex === -1) return;

    const m = findMatches[currentMatchIndex];
    const repVal = replaceInput.value || '';
    const val = editorEl.value;

    const nextSearchPos = m.start + repVal.length;
    editorEl.value = val.substring(0, m.start) + repVal + val.substring(m.end);
    const tab = getActiveTab();
    if (tab) {
      tab.content = editorEl.value;
      tab.isDirty = true;
      renderTabs();
    }
    updateLineNumbers();
    scheduleUpdateStatusBar();
    saveSessionDebounced();

    // Re-run search matches on new content
    searchMatches();
    if (findMatches.length > 0) {
      // Advance to the match at or after nextSearchPos
      let nextIdx = findMatches.findIndex(match => match.start >= nextSearchPos);
      if (nextIdx === -1) nextIdx = 0; // Wrap around to first match
      goToMatch(nextIdx);
    } else {
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
    }
  }

  function replaceAll() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    const query = findInput.value;
    const repVal = replaceInput.value || '';
    const text = editorEl.value;

    try {
      let pattern = query;
      if (!isRegex) {
        pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      if (isWholeWord) {
        pattern = '\\b' + pattern + '\\b';
      }
      const flags = isCaseSensitive ? 'g' : 'gi';
      const regex = new RegExp(pattern, flags);

      editorEl.value = text.replace(regex, repVal);
      const tab = getActiveTab();
      if (tab) {
        tab.content = editorEl.value;
        tab.isDirty = true;
        renderTabs();
      }
      updateLineNumbers();
      scheduleUpdateStatusBar();
      saveSessionDebounced();
      searchMatches();
    } catch (e) {
      console.warn('Replace all regex error:', e);
    }
  }

  // Find & Replace Input and Button Events
  findInput.addEventListener('input', searchMatches);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceOne();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFindBar();
    }
  });

  btnToggleReplace.onclick = toggleReplaceRow;
  btnFindCase.onclick = () => {
    isCaseSensitive = !isCaseSensitive;
    btnFindCase.classList.toggle('active', isCaseSensitive);
    searchMatches();
  };
  btnFindWord.onclick = () => {
    isWholeWord = !isWholeWord;
    btnFindWord.classList.toggle('active', isWholeWord);
    searchMatches();
  };
  btnFindRegex.onclick = () => {
    isRegex = !isRegex;
    btnFindRegex.classList.toggle('active', isRegex);
    searchMatches();
  };
  btnFindPrev.onclick = findPrev;
  btnFindNext.onclick = findNext;
  btnFindClose.onclick = closeFindBar;
  btnReplaceOne.onclick = replaceOne;
  btnReplaceAll.onclick = replaceAll;

  // --- Go to Line Modal ---
  function openGotoLineModal() {
    const lines = editorEl.value.split('\n').length;
    const curLine = editorEl.value.substring(0, editorEl.selectionStart).split('\n').length;
    gotoLineInput.max = lines;
    gotoLineInput.value = curLine;
    gotoLineModal.classList.remove('hidden');
    gotoLineInput.focus();
    gotoLineInput.select();
  }

  function closeGotoLineModal() {
    gotoLineModal.classList.add('hidden');
    editorEl.focus();
  }

  function executeGotoLine() {
    const targetLine = parseInt(gotoLineInput.value, 10);
    if (!isNaN(targetLine) && targetLine >= 1) {
      const lines = editorEl.value.split('\n');
      const clampedLine = Math.min(targetLine, lines.length);
      let charPos = 0;
      for (let i = 0; i < clampedLine - 1; i++) {
        charPos += lines[i].length + 1;
      }
      editorEl.focus();
      editorEl.setSelectionRange(charPos, charPos);
      const targetY = getCharPixelTop(charPos);
      const viewHeight = editorEl.clientHeight;
      const targetScroll = Math.max(0, targetY - Math.floor(viewHeight / 3));
      editorEl.scrollTop = targetScroll;
      if (lineNumbersEl) lineNumbersEl.scrollTop = targetScroll;
      if (ghostOverlayEl) ghostOverlayEl.scrollTop = targetScroll;
    }
    closeGotoLineModal();
  }

  modalGotoClose.onclick = closeGotoLineModal;
  btnGotoCancel.onclick = closeGotoLineModal;
  btnGotoConfirm.onclick = executeGotoLine;
  gotoLineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeGotoLine();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeGotoLineModal();
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;

    // Direct clipboard & editing fallback for macOS webview if needed
    const activeEl = document.activeElement;
    const isEditable = activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.isContentEditable);

    if (isCtrl && (e.key === 'a' || e.key === 'A') && isEditable) {
      if (typeof activeEl.select === 'function') {
        activeEl.select();
        e.preventDefault();
        return;
      }
    }

    // Direct Redo fallback for macOS webview (Cmd+Shift+Z)
    if (isMac && e.metaKey && e.shiftKey && (e.key === 'z' || e.key === 'Z') && isEditable) {
      if (document.execCommand) {
        document.execCommand('redo');
        e.preventDefault();
        return;
      }
    }

    // Open Settings shortcut (macOS standard Cmd+, / Windows Ctrl+,)
    if (isCtrl && (e.key === ',')) {
      e.preventDefault();
      openSettings();
      return;
    }

    // AI Typo & Mistake Correction
    if (matchShortcut(e, config.shortcuts && config.shortcuts.aiCorrection)) {
      e.preventDefault();
      triggerAICorrection();
      return;
    }

    // Escape priority order: Ghost / IME suggestion -> Inline prompt -> Find bar -> Modals -> Zen mode
    // (Never minimize window to prevent accidental hiding while typing/editing)
    if (e.key === 'Escape') {
      if (activeImeSuggestion || ghostSuggestion) {
        clearGhostText();
        return;
      }
      if (inlinePromptBar && !inlinePromptBar.classList.contains('hidden')) {
        closeInlinePromptBar();
        return;
      }
      if (!findReplaceBar.classList.contains('hidden')) {
        closeFindBar();
        return;
      }
      if (!gotoLineModal.classList.contains('hidden')) {
        closeGotoLineModal();
        return;
      }
      if (!llmPromptModal.classList.contains('hidden')) {
        closeLLMPromptModal();
        return;
      }
      if (!settingsModal.classList.contains('hidden')) {
        closeSettings();
        return;
      }
      if (quickPickModal && !quickPickModal.classList.contains('hidden')) {
        closeQuickPick();
        return;
      }
      if (document.body.classList.contains('zen-mode')) {
        toggleZenMode();
        return;
      }
      return;
    }

    // If Prompt Modal is open, handle Enter
    if (!llmPromptModal.classList.contains('hidden')) {
      if (isCtrl && e.key === 'Enter') {
        e.preventDefault();
        executeLLMQueryFromModal();
      }
      return;
    }

    // Toggle Zen Mode
    if (matchShortcut(e, config.shortcuts && config.shortcuts.zenMode) || (isCtrl && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
      e.preventDefault();
      toggleZenMode();
      return;
    }

    // Toggle Window Maximize / Fullscreen (F11 default)
    if (matchShortcut(e, config.shortcuts && config.shortcuts.toggleMaximize) || e.key === 'F11') {
      e.preventDefault();
      if (window.backend && window.backend.toggleMaximize) {
        window.backend.toggleMaximize();
      } else if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      return;
    }

    // Minimize Window
    if (matchShortcut(e, config.shortcuts && config.shortcuts.minimize)) {
      e.preventDefault();
      if (window.backend && window.backend.minimizeWindow) {
        window.backend.minimizeWindow();
      }
      return;
    }

    // AI Correction shortcut
    if (matchShortcut(e, config.shortcuts && config.shortcuts.aiCorrection)) {
      e.preventDefault();
      triggerAICorrection();
      return;
    }

    // Convert selection to Mermaid Diagram
    if (matchShortcut(e, config.shortcuts && config.shortcuts.convertMermaid)) {
      e.preventDefault();
      convertSelectionToMermaid();
      return;
    }

    // Render Mermaid Diagram to Image
    if (matchShortcut(e, config.shortcuts && config.shortcuts.mermaidToImage)) {
      e.preventDefault();
      generateImageFromMermaid();
      return;
    }

    // Export Plain Text
    if (matchShortcut(e, config.shortcuts && config.shortcuts.exportPlainText)) {
      e.preventDefault();
      exportPlainText();
      return;
    }

    // Command Palette / Search Notes
    if (matchShortcut(e, config.shortcuts && config.shortcuts.quickPick)) {
      e.preventDefault();
      openQuickPick();
      return;
    }

    // Open Folder / Notes Workspace
    if (matchShortcut(e, config.shortcuts && config.shortcuts.openFolder)) {
      e.preventDefault();
      openFolder();
      return;
    }

    // Find & Replace shortcuts
    if (matchShortcut(e, config.shortcuts && config.shortcuts.find)) {
      e.preventDefault();
      openFindBar(false);
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.replace)) {
      e.preventDefault();
      openFindBar(true);
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.gotoLine)) {
      e.preventDefault();
      openGotoLineModal();
    } else if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (isCtrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomIn();
    } else if (isCtrl && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      zoomOut();
    } else if (isCtrl && e.key === '0') {
      e.preventDefault();
      zoomReset();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.togglePreview)) {
      e.preventDefault();
      togglePreview();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.toggleSplit)) {
      e.preventDefault();
      toggleSplitMode();
    } else if (isCtrl && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      openPreviewToSide();
    } else if (isCtrl && e.key === '1') {
      e.preventDefault();
      editorEl.focus();
      activePane = 'primary';
      renderTabs();
    } else if (isCtrl && e.key === '2') {
      e.preventDefault();
      if (isSplitMode && secondaryViewMode === 'editor' && editorSecondary) {
        editorSecondary.focus();
        activePane = 'secondary';
        renderTabs();
      }
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.saveFileAs)) {
      e.preventDefault();
      saveActiveFile(true);
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.saveFile)) {
      e.preventDefault();
      saveActiveFile(false);
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.openFile)) {
      e.preventDefault();
      openFile();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.newTab)) {
      e.preventDefault();
      createTab();
    } else if (isCtrl && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (isSplitMode && activePane === 'secondary') {
        closeSecondaryPane();
        return;
      }
      if (tabs.length === 1) {
        // Notepad standard behavior: closing the sole remaining tab exits the application
        const tab = tabs[0];
        if (tab.isDirty) {
          customConfirm(t('confirmCloseUnsaved', { title: tab.title })).then((ok) => {
            if (!ok) return;
            if (window.backend && window.backend.closeWindow) {
              window.backend.closeWindow();
            }
          });
          return;
        }
        if (window.backend && window.backend.closeWindow) {
          window.backend.closeWindow();
        }
      } else if (activeTabId) {
        closeTab(activeTabId);
      }
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.inlinePrompt)) {
      e.preventDefault();
      openInlinePromptBar();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.llmModal)) {
      e.preventDefault();
      openLLMInstructionModal();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.insertDate)) {
      e.preventDefault();
      insertDateAtCursor();
    } else if (isCtrl && e.key === 'Tab') {
      e.preventDefault();
      if (tabs.length > 1) {
        const curIdx = tabs.findIndex(t => t.id === activeTabId);
        const nextIdx = (curIdx + 1) % tabs.length;
        selectTab(tabs[nextIdx].id);
      }
    }
  });

  // LLM Prompt Modal Buttons
  btnSendLLM.onclick = executeLLMQueryFromModal;
  btnCancelLLM.onclick = closeLLMPromptModal;
  modalLLMClose.onclick = closeLLMPromptModal;

  // Context Menu Handling with Smart Overflow & Flip Detection
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu.classList.remove('hidden');

    const menuWidth = contextMenu.offsetWidth || 220;
    const menuHeight = contextMenu.offsetHeight || 520;
    const padding = 8;

    // Smart horizontal positioning
    let left = e.clientX;
    if (left + menuWidth > window.innerWidth - padding) {
      if (e.clientX - menuWidth >= padding) {
        left = e.clientX - menuWidth;
      } else {
        left = Math.max(padding, window.innerWidth - menuWidth - padding);
      }
    }

    // Smart vertical positioning: if overflowing bottom, flip upwards or clamp within viewport
    let top = e.clientY;
    if (top + menuHeight > window.innerHeight - padding) {
      if (e.clientY - menuHeight >= padding) {
        // Flip upwards so menu sits above cursor
        top = e.clientY - menuHeight;
      } else {
        // Clamp to bottom with margin
        top = Math.max(padding, window.innerHeight - menuHeight - padding);
      }
    }

    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
  });

  window.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.classList.add('hidden');
    }
  });

  // Context Menu Actions
  const ctxUndo = document.getElementById('ctx-undo');
  if (ctxUndo) {
    ctxUndo.onclick = () => {
      contextMenu.classList.add('hidden');
      document.execCommand('undo');
    };
  }
  const ctxRedo = document.getElementById('ctx-redo');
  if (ctxRedo) {
    ctxRedo.onclick = () => {
      contextMenu.classList.add('hidden');
      document.execCommand('redo');
    };
  }
  const ctxFind = document.getElementById('ctx-find');
  if (ctxFind) {
    ctxFind.onclick = () => {
      contextMenu.classList.add('hidden');
      openFindBar(false);
    };
  }
  const ctxReplace = document.getElementById('ctx-replace');
  if (ctxReplace) {
    ctxReplace.onclick = () => {
      contextMenu.classList.add('hidden');
      openFindBar(true);
    };
  }
  const ctxGotoLine = document.getElementById('ctx-goto-line');
  if (ctxGotoLine) {
    ctxGotoLine.onclick = () => {
      contextMenu.classList.add('hidden');
      openGotoLineModal();
    };
  }
  const ctxQuickPick = document.getElementById('ctx-quick-pick');
  if (ctxQuickPick) {
    ctxQuickPick.onclick = () => {
      contextMenu.classList.add('hidden');
      openQuickPick();
    };
  }
  const ctxOpenFolder = document.getElementById('ctx-open-folder');
  if (ctxOpenFolder) {
    ctxOpenFolder.onclick = () => {
      contextMenu.classList.add('hidden');
      openFolder();
    };
  }
  document.getElementById('ctx-llm-query').onclick = () => {
    contextMenu.classList.add('hidden');
    openInlinePromptBar();
  };
  const ctxLLMModal = document.getElementById('ctx-llm-modal');
  if (ctxLLMModal) {
    ctxLLMModal.onclick = () => {
      contextMenu.classList.add('hidden');
      openLLMInstructionModal();
    };
  }
  const ctxAiCorrect = document.getElementById('ctx-ai-correct');
  if (ctxAiCorrect) {
    ctxAiCorrect.onclick = () => {
      contextMenu.classList.add('hidden');
      triggerAICorrection();
    };
  }
  const ctxConvertMermaid = document.getElementById('ctx-convert-mermaid');
  if (ctxConvertMermaid) {
    ctxConvertMermaid.onclick = () => {
      contextMenu.classList.add('hidden');
      convertSelectionToMermaid();
    };
  }
  const ctxMermaidToImage = document.getElementById('ctx-mermaid-to-image');
  if (ctxMermaidToImage) {
    ctxMermaidToImage.onclick = () => {
      contextMenu.classList.add('hidden');
      generateImageFromMermaid();
    };
  }
  document.getElementById('ctx-save-txt').onclick = () => {
    contextMenu.classList.add('hidden');
    exportPlainText();
  };
  document.getElementById('ctx-cut').onclick = () => {
    contextMenu.classList.add('hidden');
    document.execCommand('cut');
  };
  document.getElementById('ctx-copy').onclick = () => {
    contextMenu.classList.add('hidden');
    document.execCommand('copy');
  };
  document.getElementById('ctx-paste').onclick = () => {
    contextMenu.classList.add('hidden');
    navigator.clipboard.readText().then(text => {
      insertTextWithUndo(text);
      onEditorInput();
    }).catch(() => document.execCommand('paste'));
  };
  document.getElementById('ctx-select-all').onclick = () => {
    contextMenu.classList.add('hidden');
    editorEl.select();
  };
  document.getElementById('ctx-insert-date').onclick = () => {
    contextMenu.classList.add('hidden');
    insertDateAtCursor();
  };
  document.getElementById('ctx-toggle-preview').onclick = () => {
    contextMenu.classList.add('hidden');
    togglePreview();
  };
  if (ctxOpenToSide) {
    ctxOpenToSide.onclick = () => {
      contextMenu.classList.add('hidden');
      openSplitEditor(contextMenuTargetTabId || activeTabId);
    };
  }
  document.getElementById('ctx-settings').onclick = () => {
    contextMenu.classList.add('hidden');
    openSettings();
  };

  // Header Button Bindings
  btnNewTab.onclick = () => createTab();
  btnOpenFile.onclick = () => openFile();
  if (btnOpenFolder) btnOpenFolder.onclick = () => openFolder();
  btnSaveFile.onclick = () => saveActiveFile(false);
  if (btnFind) btnFind.onclick = () => openFindBar(false);
  if (btnHeaderLLM) btnHeaderLLM.onclick = () => openInlinePromptBar();
  if (btnToggleSplit) btnToggleSplit.onclick = () => toggleSplitMode();
  if (btnPreviewSide) btnPreviewSide.onclick = () => openPreviewToSide();
  btnTogglePreview.onclick = () => togglePreview();
  btnSettings.onclick = () => openSettings();

  // Secondary Pane Button Bindings
  if (btnSecondarySync) {
    btnSecondarySync.onclick = () => {
      syncScrollEnabled = !syncScrollEnabled;
      btnSecondarySync.classList.toggle('active', syncScrollEnabled);
    };
  }
  if (btnSecondaryMode) {
    btnSecondaryMode.onclick = () => {
      secondaryViewMode = (secondaryViewMode === 'editor' ? 'preview' : 'editor');
      updateSecondaryPane();
    };
  }
  if (btnSecondaryClose) {
    btnSecondaryClose.onclick = () => closeSecondaryPane();
  }

  statEncoding.onclick = () => toggleEncoding();
  statAutocomplete.onclick = () => toggleAutocomplete();
  if (statIme) statIme.onclick = () => toggleIME();

  // Settings Tab Switching
  tabBtnTextLLM.onclick = () => switchSettingsTab('text');
  tabBtnAutocomplete.onclick = () => switchSettingsTab('autocomplete');
  tabBtnVisionLLM.onclick = () => switchSettingsTab('vision');
  tabBtnGeneral.onclick = () => switchSettingsTab('general');
  if (tabBtnShortcuts) tabBtnShortcuts.onclick = () => switchSettingsTab('shortcuts');

  function switchSettingsTab(tabName) {
    tabBtnTextLLM.classList.toggle('active', tabName === 'text');
    tabBtnAutocomplete.classList.toggle('active', tabName === 'autocomplete');
    tabBtnVisionLLM.classList.toggle('active', tabName === 'vision');
    tabBtnGeneral.classList.toggle('active', tabName === 'general');
    if (tabBtnShortcuts) tabBtnShortcuts.classList.toggle('active', tabName === 'shortcuts');

    paneTextLLM.classList.toggle('hidden', tabName !== 'text');
    paneAutocomplete.classList.toggle('hidden', tabName !== 'autocomplete');
    paneVisionLLM.classList.toggle('hidden', tabName !== 'vision');
    paneGeneral.classList.toggle('hidden', tabName !== 'general');
    if (paneShortcuts) paneShortcuts.classList.toggle('hidden', tabName !== 'shortcuts');

    if (tabName === 'shortcuts') {
      renderShortcutsTable();
    }
  }

  // --- Dynamic Keyboard Shortcuts Engine ---
  function formatShortcutForDisplay(shortcutStr) {
    if (!shortcutStr) return '';
    const parts = shortcutStr.split('+').map(p => p.trim());
    if (isMac) {
      const hasCmd = parts.some(p => p === 'Cmd' || p === 'Command' || p === '⌘');
      const hasCtrl = parts.some(p => p === 'Ctrl' || p === 'Control');
      // If legacy shortcut has only 'Ctrl' on Mac, display as 'Cmd'
      if (hasCtrl && !hasCmd) {
        return parts.map(p => (p === 'Ctrl' || p === 'Control') ? 'Cmd' : (p === 'Alt' ? 'Option' : p)).join('+');
      }
      return parts.map(p => p === 'Alt' ? 'Option' : p).join('+');
    } else {
      // Windows/Linux: normalize Cmd -> Ctrl, Option -> Alt
      return parts.map(p => (p === 'Cmd' || p === 'Command') ? 'Ctrl' : (p === 'Option' ? 'Alt' : p)).join('+');
    }
  }

  function matchShortcut(e, shortcutStr) {
    if (!shortcutStr) return false;
    const parts = shortcutStr.split('+').map(p => p.trim());
    
    let hasCtrl = false;
    let hasCmd = false;
    let hasShift = false;
    let hasAlt = false;
    let mainKey = null;

    for (const p of parts) {
      if (p === 'Ctrl' || p === 'Control') hasCtrl = true;
      else if (p === 'Cmd' || p === 'Command' || p === '⌘') hasCmd = true;
      else if (p === 'Shift' || p === '⇧') hasShift = true;
      else if (p === 'Alt' || p === 'Option' || p === '⌥') hasAlt = true;
      else mainKey = p;
    }

    if (!mainKey) return false;

    if (isMac) {
      let reqMeta = hasCmd;
      let reqCtrl = hasCtrl;
      // If a shortcut was configured with only "Ctrl" (e.g. from older default or Windows config),
      // treat it as Cmd on Mac unless Cmd was also explicitly specified (like 'Ctrl+Cmd+F')
      if (hasCtrl && !hasCmd) {
        reqMeta = true;
        reqCtrl = false;
      }
      if (reqMeta !== Boolean(e.metaKey)) return false;
      if (reqCtrl !== Boolean(e.ctrlKey)) return false;
    } else {
      // On Windows / Linux: Ctrl or Cmd matches e.ctrlKey
      const reqCtrl = hasCtrl || hasCmd;
      if (reqCtrl !== Boolean(e.ctrlKey)) return false;
    }

    if (hasShift !== Boolean(e.shiftKey)) return false;
    if (hasAlt !== Boolean(e.altKey)) return false;

    const target = mainKey.toUpperCase();
    if (target === '\\' || target === 'BACKSLASH') {
      return e.key === '\\' || e.code === 'Backslash';
    }
    if (target === ',' || target === 'COMMA') {
      return e.key === ',' || e.code === 'Comma';
    }
    if (target.startsWith('F') && !isNaN(target.substring(1))) {
      return e.key.toUpperCase() === target;
    }
    return (e.key && e.key.toUpperCase() === target) || (e.code && e.code.toUpperCase() === 'KEY' + target);
  }

  function updateShortcutLabels() {
    if (!config.shortcuts) return;

    const setLabel = (id, sc) => {
      const el = document.getElementById(id);
      if (el && sc) el.textContent = formatShortcutForDisplay(sc);
    };
    setLabel('sc-ctx-undo', isMac ? 'Cmd+Z' : 'Ctrl+Z');
    setLabel('sc-ctx-redo', isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y');
    setLabel('sc-ctx-cut', isMac ? 'Cmd+X' : 'Ctrl+X');
    setLabel('sc-ctx-copy', isMac ? 'Cmd+C' : 'Ctrl+C');
    setLabel('sc-ctx-paste', isMac ? 'Cmd+V' : 'Ctrl+V');
    setLabel('sc-ctx-select-all', isMac ? 'Cmd+A' : 'Ctrl+A');
    setLabel('sc-ctx-find', config.shortcuts.find);
    setLabel('sc-ctx-replace', config.shortcuts.replace);
    setLabel('sc-ctx-goto-line', config.shortcuts.gotoLine);
    setLabel('sc-ctx-quick-pick', config.shortcuts.quickPick);
    setLabel('sc-ctx-open-folder', config.shortcuts.openFolder);
    setLabel('sc-ctx-inline-prompt', config.shortcuts.inlinePrompt);
    setLabel('sc-ctx-llm-modal', config.shortcuts.llmModal);
    setLabel('sc-ctx-ai-correct', config.shortcuts.aiCorrection);
    setLabel('sc-ctx-convert-mermaid', config.shortcuts.convertMermaid);
    setLabel('sc-ctx-mermaid-to-image', config.shortcuts.mermaidToImage);
    setLabel('sc-ctx-save-txt', config.shortcuts.exportPlainText);
    setLabel('sc-ctx-insert-date', config.shortcuts.insertDate);
    setLabel('sc-ctx-toggle-preview', config.shortcuts.togglePreview);

    const getSc = (key, fallback) => formatShortcutForDisplay((config.shortcuts && config.shortcuts[key]) || fallback);

    if (btnNewTab) btnNewTab.title = `${t('newTabTitle')} (${getSc('newTab', isMac ? 'Cmd+N' : 'Ctrl+N')})`;
    if (btnOpenFile) btnOpenFile.title = `${t('openFileTitle')} (${getSc('openFile', isMac ? 'Cmd+O' : 'Ctrl+O')})`;
    if (btnOpenFolder) btnOpenFolder.title = `${t('openFolderTitle')} (${getSc('openFolder', isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O')})`;
    if (btnSaveFile) btnSaveFile.title = `${t('saveFileTitle')} (${getSc('saveFile', isMac ? 'Cmd+S' : 'Ctrl+S')})`;
    if (btnFind) btnFind.title = `${t('findTitle')} (${getSc('find', isMac ? 'Cmd+F' : 'Ctrl+F')})`;
    if (btnHeaderLLM) btnHeaderLLM.title = `${t('llmTitle')} (${getSc('inlinePrompt', isMac ? 'Cmd+K' : 'Ctrl+K')} / ${getSc('llmModal', isMac ? 'Cmd+L' : 'Ctrl+L')})`;
    if (btnToggleSplit) btnToggleSplit.title = `${t('splitViewTitle')} (${getSc('toggleSplit', isMac ? 'Cmd+\\' : 'Ctrl+\\')})`;
    if (btnTogglePreview) btnTogglePreview.title = `${isPreviewMode ? t('edit') : t('togglePreviewTitle')} (${getSc('togglePreview', isMac ? 'Cmd+P' : 'Ctrl+P')})`;
  }

  let activeRecordingAction = null;

  function renderShortcutsTable() {
    if (!shortcutsListBody) return;
    shortcutsListBody.innerHTML = '';

    const actions = [
      { key: 'newTab', labelKey: 'shortcutActionNewTab' },
      { key: 'openFile', labelKey: 'shortcutActionOpenFile' },
      { key: 'openFolder', labelKey: 'shortcutActionOpenFolder' },
      { key: 'saveFile', labelKey: 'shortcutActionSaveFile' },
      { key: 'saveFileAs', labelKey: 'shortcutActionSaveFileAs' },
      { key: 'find', labelKey: 'shortcutActionFind' },
      { key: 'replace', labelKey: 'shortcutActionReplace' },
      { key: 'gotoLine', labelKey: 'shortcutActionGotoLine' },
      { key: 'quickPick', labelKey: 'shortcutActionQuickPick' },
      { key: 'togglePreview', labelKey: 'shortcutActionTogglePreview' },
      { key: 'toggleSplit', labelKey: 'shortcutActionToggleSplit' },
      { key: 'zenMode', labelKey: 'shortcutActionZenMode' },
      { key: 'minimize', labelKey: 'shortcutActionMinimize' },
      { key: 'toggleMaximize', labelKey: 'shortcutActionToggleMaximize' },
      { key: 'inlinePrompt', labelKey: 'shortcutActionInlinePrompt' },
      { key: 'llmModal', labelKey: 'shortcutActionLLMModal' },
      { key: 'aiCorrection', labelKey: 'shortcutActionAICorrection' },
      { key: 'convertMermaid', labelKey: 'shortcutActionConvertMermaid' },
      { key: 'mermaidToImage', labelKey: 'shortcutActionMermaidToImage' },
      { key: 'exportPlainText', labelKey: 'shortcutActionExportPlainText' },
      { key: 'insertDate', labelKey: 'shortcutActionInsertDate' }
    ];

    actions.forEach(act => {
      const tr = document.createElement('tr');

      const tdAction = document.createElement('td');
      tdAction.textContent = t(act.labelKey);

      const tdKey = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'shortcut-key-btn';
      if (activeRecordingAction === act.key) {
        btn.classList.add('recording');
        btn.textContent = t('shortcutPressKey');
      } else {
        const raw = (config.shortcuts && config.shortcuts[act.key]) || DEFAULT_SHORTCUTS[act.key] || '';
        btn.textContent = formatShortcutForDisplay(raw);
      }

      btn.onclick = (e) => {
        e.stopPropagation();
        if (activeRecordingAction === act.key) {
          activeRecordingAction = null;
        } else {
          activeRecordingAction = act.key;
        }
        renderShortcutsTable();
      };

      tdKey.appendChild(btn);
      tr.appendChild(tdAction);
      tr.appendChild(tdKey);
      shortcutsListBody.appendChild(tr);
    });
  }

  if (btnResetShortcuts) {
    btnResetShortcuts.onclick = () => {
      config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
      activeRecordingAction = null;
      renderShortcutsTable();
      updateShortcutLabels();
    };
  }

  window.addEventListener('keydown', (e) => {
    if (activeRecordingAction) {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      const parts = [];
      if (isMac) {
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.metaKey) parts.push('Cmd');
        if (e.altKey) parts.push('Option');
        if (e.shiftKey) parts.push('Shift');
      } else {
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
      }

      let k = e.key;
      if (k === ' ') k = 'Space';
      else if (k === 'Escape') {
        activeRecordingAction = null;
        renderShortcutsTable();
        return;
      } else if (k.length === 1) {
        k = k.toUpperCase();
      }
      parts.push(k);

      if (!config.shortcuts) config.shortcuts = {};
      config.shortcuts[activeRecordingAction] = parts.join('+');
      activeRecordingAction = null;
      renderShortcutsTable();
      updateShortcutLabels();
    }
  }, true);

  // Settings Dialog
  function openSettings() {
    document.getElementById('cfg-base-url').value = config.text.baseUrl || '';
    document.getElementById('cfg-model').value = config.text.model || '';
    document.getElementById('cfg-api-key').value = config.text.apiKey || '';
    document.getElementById('cfg-system-prompt').value = config.text.systemPrompt || '';

    document.getElementById('cfg-auto-enabled').checked = config.autocomplete.enabled;
    document.getElementById('cfg-auto-base-url').value = config.autocomplete.baseUrl || 'http://localhost:11434';
    document.getElementById('cfg-auto-model').value = config.autocomplete.model || 'qwen2.5:latest';
    document.getElementById('cfg-auto-api-key').value = config.autocomplete.apiKey || '';
    document.getElementById('cfg-auto-delay').value = config.autocomplete.delayMs || 500;
    document.getElementById('cfg-auto-tokens').value = config.autocomplete.maxTokens || 30;

    document.getElementById('cfg-vision-base-url').value = config.vision.baseUrl || '';
    document.getElementById('cfg-vision-model').value = config.vision.model || 'gemini-flash-lite-latest';
    document.getElementById('cfg-vision-api-key').value = config.vision.apiKey || '';
    document.getElementById('cfg-vision-prompt').value = config.vision.prompt || '';

    const themeSelect = document.getElementById('cfg-theme');
    if (themeSelect) {
      themeSelect.value = config.general.theme || 'olive';
    }
    document.getElementById('cfg-language').value = config.general.language || 'en';
    document.getElementById('cfg-restore-session').checked = config.general.restoreSession !== false;
    document.getElementById('cfg-autosave').checked = config.general.autoSave;
    document.getElementById('cfg-paste-image-ocr').checked = config.general.pasteImageOcr;
    const imeGuardianCheckbox = document.getElementById('cfg-ime-guardian');
    if (imeGuardianCheckbox) {
      imeGuardianCheckbox.checked = config.general.imeGuardian !== false;
    }
    const aiCorrectionCheckbox = document.getElementById('cfg-ai-correction');
    if (aiCorrectionCheckbox) {
      aiCorrectionCheckbox.checked = config.general.aiCorrection !== false;
    }
    const cursorAuraCheckbox = document.getElementById('cfg-cursor-aura');
    if (cursorAuraCheckbox) {
      cursorAuraCheckbox.checked = config.general.cursorAura !== false;
    }
    const trayResidentCheckbox = document.getElementById('cfg-tray-resident');
    if (trayResidentCheckbox) {
      trayResidentCheckbox.checked = config.general.trayResident !== false;
    }

    renderShortcutsTable();
    updateShortcutLabels();
    switchSettingsTab('text');
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    activeRecordingAction = null;
    settingsModal.classList.add('hidden');
  }

  document.getElementById('modal-close').onclick = closeSettings;
  document.getElementById('btn-cancel-settings').onclick = closeSettings;
  document.getElementById('btn-save-settings').onclick = async () => {
    config.text.baseUrl = document.getElementById('cfg-base-url').value.trim() || 'http://localhost:11434';
    config.text.model = document.getElementById('cfg-model').value.trim() || 'qwen2.5:latest';
    config.text.apiKey = document.getElementById('cfg-api-key').value.trim();
    config.text.systemPrompt = document.getElementById('cfg-system-prompt').value.trim();

    config.autocomplete.enabled = document.getElementById('cfg-auto-enabled').checked;
    config.autocomplete.baseUrl = document.getElementById('cfg-auto-base-url').value.trim() || 'http://localhost:11434';
    config.autocomplete.model = document.getElementById('cfg-auto-model').value.trim() || 'qwen2.5:latest';
    config.autocomplete.apiKey = document.getElementById('cfg-auto-api-key').value.trim();
    config.autocomplete.delayMs = parseInt(document.getElementById('cfg-auto-delay').value, 10) || 500;
    config.autocomplete.maxTokens = parseInt(document.getElementById('cfg-auto-tokens').value, 10) || 30;

    config.vision.baseUrl = document.getElementById('cfg-vision-base-url').value.trim() || 'https://generativelanguage.googleapis.com';
    config.vision.model = document.getElementById('cfg-vision-model').value.trim() || 'gemini-flash-lite-latest';
    config.vision.apiKey = document.getElementById('cfg-vision-api-key').value.trim();
    config.vision.prompt = document.getElementById('cfg-vision-prompt').value.trim();

    const themeSelect = document.getElementById('cfg-theme');
    if (themeSelect) {
      config.general.theme = themeSelect.value || 'olive';
    }
    config.general.language = document.getElementById('cfg-language').value || 'en';
    config.general.restoreSession = document.getElementById('cfg-restore-session').checked;
    config.general.autoSave = document.getElementById('cfg-autosave').checked;
    config.general.pasteImageOcr = document.getElementById('cfg-paste-image-ocr').checked;
    const imeGuardianSaveCheckbox = document.getElementById('cfg-ime-guardian');
    if (imeGuardianSaveCheckbox) {
      config.general.imeGuardian = imeGuardianSaveCheckbox.checked;
    }
    const aiCorrectionSaveCheckbox = document.getElementById('cfg-ai-correction');
    if (aiCorrectionSaveCheckbox) {
      config.general.aiCorrection = aiCorrectionSaveCheckbox.checked;
    }
    const cursorAuraSaveCheckbox = document.getElementById('cfg-cursor-aura');
    if (cursorAuraSaveCheckbox) {
      config.general.cursorAura = cursorAuraSaveCheckbox.checked;
      if (!config.general.cursorAura) {
        hideCursorAura(true);
      } else {
        triggerCursorAuraDebounced();
      }
    }
    const trayResidentSaveCheckbox = document.getElementById('cfg-tray-resident');
    if (trayResidentSaveCheckbox) {
      config.general.trayResident = trayResidentSaveCheckbox.checked;
    }

    applyTheme();
    applyLanguage();
    updateShortcutLabels();
    await savePersistentConfig();
    saveSessionDebounced();
    closeSettings();
    showMessage(t('settingsSaved'), 2000);
  };

  async function savePersistentConfig() {
    try {
      localStorage.setItem('md_notepad_config_v3', JSON.stringify(config));
    } catch (e) {}

    if (window.backend && window.backend.saveConfig) {
      try {
        await window.backend.saveConfig(JSON.stringify(config));
      } catch (e) {
        console.warn('Failed to save config to local file:', e);
      }
    }
  }

  // Load Saved Config from local storage & backend RPC
  function loadLocalConfigSync() {
    try {
      const saved = localStorage.getItem('md_memo_config_v1') || localStorage.getItem('md_notepad_config_v3');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.text) Object.assign(config.text, parsed.text);
        if (parsed.autocomplete) Object.assign(config.autocomplete, parsed.autocomplete);
        if (parsed.vision) Object.assign(config.vision, parsed.vision);
        if (parsed.general) Object.assign(config.general, parsed.general);
        if (parsed.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, parsed.shortcuts);
      }
    } catch (e) {}
    applyTheme();
    applyLanguage();
    updateShortcutLabels();
  }

  async function syncBackendConfig() {
    if (window.backend && window.backend.getConfig) {
      try {
        const fileConfigStr = await window.backend.getConfig();
        if (fileConfigStr) {
          const fileConfig = JSON.parse(fileConfigStr);
          if (fileConfig.text) Object.assign(config.text, fileConfig.text);
          if (fileConfig.autocomplete) Object.assign(config.autocomplete, fileConfig.autocomplete);
          if (fileConfig.vision) Object.assign(config.vision, fileConfig.vision);
          if (fileConfig.general) Object.assign(config.general, fileConfig.general);
          if (fileConfig.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, config.shortcuts, fileConfig.shortcuts);
          applyTheme();
          applyLanguage();
          updateShortcutLabels();
        }
      } catch (e) {
        console.warn('Failed to load persistent config from backend:', e);
      }
    }
  }

  // Session Management (Unsaved documents & Tabs Persistence)
  let sessionSaveTimer = null;

  function getSessionData() {
    const curTab = getActiveTab();
    if (curTab) {
      curTab.content = editorEl.value;
      curTab.cursorPos = editorEl.selectionStart;
    }

    return {
      activeTabId: activeTabId,
      tabCounter: tabCounter,
      tabs: tabs.map(t => ({
        id: t.id,
        title: t.title,
        path: t.path,
        content: t.content,
        isDirty: t.isDirty,
        encoding: t.encoding,
        cursorPos: t.cursorPos
      }))
    };
  }

  function saveSessionDebounced() {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      savePersistentSession();
    }, 500);
  }

  async function savePersistentSession() {
    if (config.general.restoreSession === false) return;
    const sessionData = getSessionData();
    const jsonStr = JSON.stringify(sessionData);

    try {
      localStorage.setItem('md_memo_session_v1', jsonStr);
    } catch (e) {}

    if (window.backend && window.backend.saveSession) {
      try {
        await window.backend.saveSession(jsonStr);
      } catch (e) {
        console.warn('Failed to save session to backend:', e);
      }
    }
  }

  function restoreSessionFromData(sessionData) {
    if (sessionData && Array.isArray(sessionData.tabs) && sessionData.tabs.length > 0) {
      tabs = sessionData.tabs;
      tabCounter = sessionData.tabCounter || (tabs.length + 1);
      const targetTabId = sessionData.activeTabId && tabs.some(t => t.id === sessionData.activeTabId)
        ? sessionData.activeTabId
        : tabs[0].id;
      renderTabs();
      selectTab(targetTabId);
      return true;
    }
    return false;
  }

  function loadLocalSessionSync() {
    try {
      const str = localStorage.getItem('md_memo_session_v1') || localStorage.getItem('md_notepad_session_v1');
      if (str) {
        return restoreSessionFromData(JSON.parse(str));
      }
    } catch (e) {}
    return false;
  }

  // Save session on window close or tab visibility change
  window.addEventListener('beforeunload', () => {
    if (config.general.restoreSession !== false) {
      const sessionData = getSessionData();
      const jsonStr = JSON.stringify(sessionData);
      try {
        localStorage.setItem('md_memo_session_v1', jsonStr);
      } catch (e) {}
      if (window.backend && window.backend.saveSession) {
        window.backend.saveSession(jsonStr);
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      savePersistentSession();
    }
  });

  // Intercept window drag and drop to prevent default WebView2 file navigation and open files as tabs
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      for (const file of e.dataTransfer.files) {
        try {
          const text = await file.text();
          createTab(file.name, text, file.path || '');
        } catch (err) {
          console.warn('Failed to read dropped file:', err);
        }
      }
    }
  });

  // App Startup Entrypoint (Zero-Latency Instant Paint)
  function initApp() {
    loadLocalConfigSync();

    // 1. Instant Synchronous First Paint:
    // Restore tabs and render workspace synchronously from localStorage without waiting for IPC
    let restored = false;
    if (config.general.restoreSession !== false) {
      restored = loadLocalSessionSync();
    }
    if (!restored || tabs.length === 0) {
      createTab();
    }
    editorEl.focus();
    triggerCursorAuraDebounced();

    // 2. Background Asynchronous Verification & Sync:
    (async () => {
      // Check if a file path was passed via CLI argument or double-clicked from Explorer / Finder
      let startupFile = null;
      if (window.backend && window.backend.getStartupFile) {
        try {
          startupFile = await window.backend.getStartupFile();
        } catch (e) {
          console.warn('Failed to retrieve startup file:', e);
        }
      }

      if (startupFile && startupFile.path) {
        if (isPreviewMode) {
          await togglePreview();
        }
        // If the only tab is an empty untitled tab, replace it
        if (tabs.length === 1 && !tabs[0].path && !tabs[0].isDirty && (tabs[0].content.trim() === '' || tabs[0].content.startsWith('# '))) {
          tabs[0].title = startupFile.title;
          tabs[0].content = startupFile.content;
          tabs[0].path = startupFile.path;
          tabs[0].encoding = startupFile.encoding;
          tabs[0].isDirty = false;
          renderTabs();
          selectTab(tabs[0].id);
        } else {
          createTab(startupFile.title, startupFile.content, startupFile.path, startupFile.encoding);
        }
        editorEl.focus();
        syncBackendConfig();
        return;
      }

      // Sync session from backend file (AppData/md-memo/session.json)
      if (config.general.restoreSession !== false && window.backend && window.backend.getSession) {
        try {
          const backendSessionStr = await window.backend.getSession();
          if (backendSessionStr) {
            const sessionData = JSON.parse(backendSessionStr);
            if (sessionData && Array.isArray(sessionData.tabs) && sessionData.tabs.length > 0) {
              restoreSessionFromData(sessionData);
            }
          }
        } catch (e) {
          console.warn('Failed to load session from backend:', e);
        }
      }

      // Restore saved workspace folder if any
      const savedFolder = localStorage.getItem('md_memo_workspace_folder');
      if (savedFolder) {
        loadWorkspaceFolder(savedFolder);
      }

      // Background asynchronous sync of configuration
      await syncBackendConfig();

      if (config.general && config.general.splitViewOnStartup && !isSplitMode) {
        await toggleSplitMode();
      }
    })();

    initPaneResizer();
  }

  // Expose test and screenshot automation helpers safely
  window.__testHelper = {
    toggleSplitMode,
    openSplitEditor,
    openPreviewToSide,
    closeSecondaryPane,
    openQuickPick,
    openInlinePromptBar,
    convertSelectionToMermaid,
    generateImageFromMermaid
  };

  initApp();
})();
