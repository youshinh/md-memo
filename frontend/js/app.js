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
      autoSave: true,
      pasteImageOcr: true,
      restoreSession: true
    }
  };

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
    statAutosave.textContent = config.general.autoSave ? t('statAutosaveOn') : t('statAutosaveOff');
    if (!statAutocomplete.textContent.includes('Error') && !statAutocomplete.textContent.includes('エラー')) {
      statAutocomplete.textContent = config.autocomplete.enabled ? t('statAutocompleteOn') : t('statAutocompleteOff');
      statAutocomplete.title = config.autocomplete.enabled ? t('statAutocompleteTooltip') : t('statAutocompleteOffTooltip');
    }
    if (btnTogglePreview) btnTogglePreview.title = isPreviewMode ? t('edit') : t('togglePreviewTitle');
    if (btnToggleSplit) btnToggleSplit.title = t('splitViewTitle');
  }

  // State Variables
  let isSplitMode = false;

  // DOM Elements
  const tabsListEl = document.getElementById('tabs-list');
  const btnNewTab = document.getElementById('btn-new-tab');
  const btnOpenFile = document.getElementById('btn-open-file');
  const btnSaveFile = document.getElementById('btn-save-file');
  const btnTogglePreview = document.getElementById('btn-toggle-preview');
  const btnToggleSplit = document.getElementById('btn-toggle-split');
  const btnFind = document.getElementById('btn-find');
  const btnHeaderLLM = document.getElementById('btn-header-llm');
  const btnSettings = document.getElementById('btn-settings');
  const workspaceEl = document.getElementById('workspace');
  const editorPane = document.getElementById('editor-pane');
  const previewPane = document.getElementById('preview-pane');
  const editorEl = document.getElementById('editor');
  const ghostOverlayEl = document.getElementById('ghost-overlay');
  const lineNumbersEl = document.getElementById('line-numbers');

  const statCursor = document.getElementById('stat-cursor');
  const statChars = document.getElementById('stat-chars');
  const statSelection = document.getElementById('stat-selection');
  const statLlmIndicator = document.getElementById('stat-llm-indicator');
  const statLlmText = document.getElementById('stat-llm-text');
  const statMessage = document.getElementById('stat-message');
  const statAutocomplete = document.getElementById('stat-autocomplete');
  const statAutosave = document.getElementById('stat-autosave');
  const statEncoding = document.getElementById('stat-encoding');

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
  const paneTextLLM = document.getElementById('pane-text-llm');
  const paneAutocomplete = document.getElementById('pane-autocomplete');
  const paneVisionLLM = document.getElementById('pane-vision-llm');
  const paneGeneral = document.getElementById('pane-general');

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

  // Go to Line Elements
  const gotoLineModal = document.getElementById('goto-line-modal');
  const gotoLineInput = document.getElementById('goto-line-input');
  const modalGotoClose = document.getElementById('modal-goto-close');
  const btnGotoConfirm = document.getElementById('btn-goto-confirm');
  const btnGotoCancel = document.getElementById('btn-goto-cancel');

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
      await Promise.all([
        loadStylesheet('vendor/katex.min.css'),
        loadScript('vendor/markdown-it.min.js'),
        loadScript('vendor/katex.min.js'),
        loadScript('vendor/mermaid.min.js')
      ]);

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

  // Tab Operations
  function createTab(title, content, path, encoding) {
    const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const initialContent = content !== undefined ? content : getFormattedDateTime('header');

    const newTab = {
      id: tabId,
      title: title || `${t('untitled')}-${tabCounter++}.md`,
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
  }

  function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    if (tab.isDirty && !confirm(t('confirmCloseUnsaved', { title: tab.title }))) {
      return;
    }

    tabs.splice(tabIndex, 1);
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

  function renderTabs() {
    tabsListEl.innerHTML = '';
    tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      tabEl.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '');
      tabEl.onclick = () => selectTab(tab.id);

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
  }

  // 1-Screen Toggle: Editor ⇄ Preview
  async function togglePreview() {
    clearGhostText();
    if (isSplitMode) {
      isSplitMode = false;
      workspaceEl.classList.remove('split-mode');
      if (btnToggleSplit) btnToggleSplit.classList.remove('active');
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
    }
  }

  // 左右分割表示 (Split View: Editor Left, Live Preview Right)
  async function toggleSplitMode() {
    clearGhostText();
    isSplitMode = !isSplitMode;

    if (isSplitMode) {
      isPreviewMode = false;
      if (btnTogglePreview) {
        btnTogglePreview.classList.remove('active');
        btnTogglePreview.title = t('togglePreviewTitle');
      }

      workspaceEl.classList.add('split-mode');
      editorPane.classList.remove('hidden');
      previewPane.classList.remove('hidden');
      if (btnToggleSplit) btnToggleSplit.classList.add('active');

      const activeTab = getActiveTab();
      if (activeTab) activeTab.content = editorEl.value;

      await ensureRendererLibraries();
      renderPreview();
      editorEl.focus();
    } else {
      workspaceEl.classList.remove('split-mode');
      if (btnToggleSplit) btnToggleSplit.classList.remove('active');
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      editorEl.focus();
    }
  }

  // Live preview debouncer for typing in split mode
  let livePreviewTimer = null;
  function debouncedLivePreview() {
    if (livePreviewTimer) clearTimeout(livePreviewTimer);
    livePreviewTimer = setTimeout(() => {
      renderPreview();
    }, 120);
  }

  function renderPreview() {
    if (!mdInstance) {
      previewPane.innerHTML = '<pre>' + escapeHtml(editorEl.value) + '</pre>';
      return;
    }

    let rawText = editorEl.value;

    // KaTeX Math Pre-processing
    rawText = rawText.replace(/\$\$([\s\S]+?)\$\$/g, function (_, math) {
      try {
        if (window.katex) {
          return '<div class="katex-block">' + window.katex.renderToString(math.trim(), { displayMode: true }) + '</div>';
        }
      } catch (e) {
        return '<pre class="katex-error">' + escapeHtml(math) + '</pre>';
      }
      return '$$' + math + '$$';
    });

    rawText = rawText.replace(/\$([^\$\n]+?)\$/g, function (_, math) {
      try {
        if (window.katex) {
          return window.katex.renderToString(math.trim(), { displayMode: false });
        }
      } catch (e) {
        return '<code>' + escapeHtml(math) + '</code>';
      }
      return '$' + math + '$';
    });

    // Render Markdown (Safe Mode)
    let html = mdInstance.render(rawText);
    previewPane.innerHTML = html;

    // Render Mermaid diagrams
    if (window.mermaid) {
      const codeBlocks = previewPane.querySelectorAll('pre code.language-mermaid');
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

  // Intercept all in-preview link clicks to prevent in-webview navigation and IPC exposure
  previewPane.addEventListener('click', (e) => {
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

  // Proportional scroll synchronization between editor and preview in Split Mode
  let isSyncingEditorScroll = false;
  let isSyncingPreviewScroll = false;

  editorEl.addEventListener('scroll', () => {
    if (!isSplitMode || isSyncingEditorScroll) return;
    isSyncingPreviewScroll = true;
    const maxEditorScroll = editorEl.scrollHeight - editorEl.clientHeight;
    if (maxEditorScroll > 0) {
      const ratio = editorEl.scrollTop / maxEditorScroll;
      const maxPreviewScroll = previewPane.scrollHeight - previewPane.clientHeight;
      previewPane.scrollTop = ratio * maxPreviewScroll;
    }
    setTimeout(() => { isSyncingPreviewScroll = false; }, 40);
  });

  previewPane.addEventListener('scroll', () => {
    if (!isSplitMode || isSyncingPreviewScroll) return;
    isSyncingEditorScroll = true;
    const maxPreviewScroll = previewPane.scrollHeight - previewPane.clientHeight;
    if (maxPreviewScroll > 0) {
      const ratio = previewPane.scrollTop / maxPreviewScroll;
      const maxEditorScroll = editorEl.scrollHeight - editorEl.clientHeight;
      editorEl.scrollTop = ratio * maxEditorScroll;
    }
    setTimeout(() => { isSyncingEditorScroll = false; }, 40);
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Ghost Text & Autocomplete Engine
  function clearGhostText() {
    ghostSuggestion = '';
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

  function acceptGhostSuggestion() {
    if (!ghostSuggestion) return false;
    const currentCursor = editorEl.selectionStart;
    if (currentCursor !== ghostTargetCursor) {
      clearGhostText();
      return false;
    }

    const text = editorEl.value;
    const textBefore = text.substring(0, currentCursor);
    const textAfter = text.substring(currentCursor);

    editorEl.value = textBefore + ghostSuggestion + textAfter;
    const newCursor = currentCursor + ghostSuggestion.length;
    editorEl.selectionStart = newCursor;
    editorEl.selectionEnd = newCursor;

    clearGhostText();
    onEditorInput();
    return true;
  }

  let isComposing = false;

  function triggerAutocompleteDebounced() {
    clearTimeout(autocompleteTimer);
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

  // LLM Instruction Prompt Modal & Query Trigger
  function openLLMInstructionModal() {
    clearGhostText();
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    let selectedText = editorEl.value.substring(start, end).trim();

    if (!selectedText) {
      const text = editorEl.value;
      const prevNewline = text.lastIndexOf('\n', start - 1);
      const nextNewline = text.indexOf('\n', end);
      const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
      const lineEnd = nextNewline === -1 ? text.length : nextNewline;
      selectedText = text.substring(lineStart, lineEnd).trim();
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
    const textBefore = editorEl.value.substring(0, insertPos);
    const textAfter = editorEl.value.substring(insertPos);

    const insertion = `\n\n${anchorId}\n\n`;
    editorEl.value = textBefore + insertion + textAfter;

    const newCursor = insertPos + insertion.length;
    editorEl.selectionStart = newCursor;
    editorEl.selectionEnd = newCursor;

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
    const textBefore = editorEl.value.substring(0, insertPos);
    const textAfter = editorEl.value.substring(insertPos);

    const insertion = `\n\n${anchorId}\n\n`;
    editorEl.value = textBefore + insertion + textAfter;

    const newCursor = insertPos + insertion.length;
    editorEl.selectionStart = newCursor;
    editorEl.selectionEnd = newCursor;

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

  // Global callback invoked by Go when background LLM finishes
  window.__onLLMResult = function (reqId, resultText, errorText) {
    const reqInfo = pendingLLMRequests.get(reqId);
    if (!reqInfo) return;

    pendingLLMRequests.delete(reqId);
    updateLLMIndicator();

    const targetTab = getTab(reqInfo.tabId);
    if (!targetTab) return;

    const replacement = errorText ? `[LLMエラー: ${errorText}]` : resultText;

    if (reqInfo.tabId === activeTabId) {
      const currentVal = editorEl.value;
      const selStart = editorEl.selectionStart;
      const selEnd = editorEl.selectionEnd;

      if (currentVal.includes(reqInfo.anchorId)) {
        const anchorIdx = currentVal.indexOf(reqInfo.anchorId);
        editorEl.value = currentVal.replace(reqInfo.anchorId, replacement);

        if (selStart > anchorIdx) {
          const delta = replacement.length - reqInfo.anchorId.length;
          editorEl.selectionStart = Math.max(0, selStart + delta);
          editorEl.selectionEnd = Math.max(0, selEnd + delta);
        } else {
          editorEl.selectionStart = selStart;
          editorEl.selectionEnd = selEnd;
        }
      } else {
        editorEl.value += `\n\n${replacement}\n`;
      }

      targetTab.content = editorEl.value;
      targetTab.isDirty = true;
      renderTabs();
      cachedLineCount = 0;
      updateLineNumbers();
      updateStatusBar();
      if (isPreviewMode) renderPreview();
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
        const res = await window.backend.saveFileAs(tab.content, tab.encoding, tab.title || `${t('untitled')}.md`);
        if (res && res.path) {
          tab.path = res.path;
          tab.title = res.title;
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

  async function openFile() {
    if (!window.backend) return;
    try {
      const res = await window.backend.openFile();
      if (res && res.path) {
        createTab(res.title, res.content, res.path, res.encoding);
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

  function insertDateAtCursor() {
    const dateStr = getFormattedDateTime('standard');
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    const text = editorEl.value;
    editorEl.value = text.substring(0, start) + dateStr + text.substring(end);
    editorEl.selectionStart = start + dateStr.length;
    editorEl.selectionEnd = start + dateStr.length;
    onEditorInput();
  }

  function showMessage(msg, duration) {
    statMessage.textContent = msg;
    setTimeout(() => {
      if (statMessage.textContent === msg) statMessage.textContent = '';
    }, duration || 2500);
  }

  // Event Listeners
  function onEditorInput() {
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
    }
    updateLineNumbers();
    scheduleUpdateStatusBar();

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
    triggerAutocompleteDebounced();
  }

  editorEl.addEventListener('compositionstart', () => {
    isComposing = true;
    clearGhostText();
    clearTimeout(autocompleteTimer);
  });
  editorEl.addEventListener('compositionend', () => {
    isComposing = false;
    triggerAutocompleteDebounced();
  });

  editorEl.addEventListener('input', onEditorInput);
  editorEl.addEventListener('keyup', () => {
    scheduleUpdateStatusBar();
    if (ghostOverlayEl) {
      ghostOverlayEl.scrollTop = editorEl.scrollTop;
      ghostOverlayEl.scrollLeft = editorEl.scrollLeft;
    }
  });
  editorEl.addEventListener('click', () => {
    clearGhostText();
    updateStatusBar();
  });
  editorEl.addEventListener('scroll', () => {
    lineNumbersEl.scrollTop = editorEl.scrollTop;
    if (ghostOverlayEl) {
      ghostOverlayEl.scrollTop = editorEl.scrollTop;
      ghostOverlayEl.scrollLeft = editorEl.scrollLeft;
    }
  });

  // Intercept Paste for Direct Image OCR
  editorEl.addEventListener('paste', (e) => {
    clearGhostText();
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
    if (e.key === 'Tab') {
      // If ghost text suggestion is active and user presses Tab (not Shift+Tab), accept completion
      if (!e.shiftKey && ghostSuggestion) {
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
          // Insert 4 spaces at cursor
          editorEl.value = val.substring(0, start) + tabSpaces + val.substring(end);
          editorEl.selectionStart = start + tabSpaces.length;
          editorEl.selectionEnd = start + tabSpaces.length;
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

  function goToMatch(index) {
    if (findMatches.length === 0) return;
    currentMatchIndex = (index + findMatches.length) % findMatches.length;
    const match = findMatches[currentMatchIndex];
    editorEl.focus();
    editorEl.setSelectionRange(match.start, match.end);

    const textBefore = editorEl.value.substring(0, match.start);
    const lineNum = textBefore.split('\n').length;
    const lineHeight = 21;
    const targetScroll = Math.max(0, (lineNum - 5) * lineHeight);
    if (Math.abs(editorEl.scrollTop - targetScroll) > 200) {
      editorEl.scrollTop = targetScroll;
    }

    findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
  }

  function findNext() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length > 0) goToMatch(currentMatchIndex + 1);
  }

  function findPrev() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length > 0) goToMatch(currentMatchIndex - 1);
  }

  function replaceOne() {
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0 || currentMatchIndex === -1) return;

    const m = findMatches[currentMatchIndex];
    const repVal = replaceInput.value || '';
    const val = editorEl.value;

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

    searchMatches();
    if (findMatches.length > 0) {
      goToMatch(currentMatchIndex);
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
      editorEl.scrollTop = Math.max(0, (clampedLine - 5) * 21);
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

    // Escape clears ghost text, closes find bar, or closes modals
    if (e.key === 'Escape') {
      if (ghostSuggestion) {
        clearGhostText();
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
    }

    // If Prompt Modal is open, handle Enter
    if (!llmPromptModal.classList.contains('hidden')) {
      if (isCtrl && e.key === 'Enter') {
        e.preventDefault();
        executeLLMQueryFromModal();
      }
      return;
    }

    // Find & Replace shortcuts
    if (isCtrl && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openFindBar(false);
    } else if (isCtrl && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      openFindBar(true);
    } else if (isCtrl && (e.key === 'g' || e.key === 'G')) {
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
    } else if (isCtrl && (e.key === 'p' || e.key === 'P' || e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      togglePreview();
    } else if (isCtrl && (e.key === '\\' || e.code === 'Backslash')) {
      e.preventDefault();
      toggleSplitMode();
    } else if (isCtrl && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveActiveFile(e.shiftKey);
    } else if (isCtrl && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      openFile();
    } else if (isCtrl && (e.key === 't' || e.key === 'T' || e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      createTab();
    } else if (isCtrl && (e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (tabs.length === 1) {
        // Notepad standard behavior: closing the sole remaining tab exits the application
        const tab = tabs[0];
        if (tab.isDirty && !confirm(t('confirmCloseUnsaved', { title: tab.title }))) {
          return;
        }
        if (window.backend && window.backend.closeWindow) {
          window.backend.closeWindow();
        }
      } else if (activeTabId) {
        closeTab(activeTabId);
      }
    } else if (isCtrl && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      openLLMInstructionModal();
    } else if (e.key === 'F5') {
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

  // Context Menu Handling
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 240)}px`;
    contextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 360)}px`;
    contextMenu.classList.remove('hidden');
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
  document.getElementById('ctx-llm-query').onclick = () => {
    contextMenu.classList.add('hidden');
    openLLMInstructionModal();
  };
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
      const start = editorEl.selectionStart;
      const end = editorEl.selectionEnd;
      editorEl.value = editorEl.value.substring(0, start) + text + editorEl.value.substring(end);
      editorEl.selectionStart = start + text.length;
      editorEl.selectionEnd = start + text.length;
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
  document.getElementById('ctx-settings').onclick = () => {
    contextMenu.classList.add('hidden');
    openSettings();
  };

  // Header Button Bindings
  btnNewTab.onclick = () => createTab();
  btnOpenFile.onclick = () => openFile();
  btnSaveFile.onclick = () => saveActiveFile(false);
  if (btnFind) btnFind.onclick = () => openFindBar(false);
  if (btnHeaderLLM) btnHeaderLLM.onclick = () => openLLMInstructionModal();
  if (btnToggleSplit) btnToggleSplit.onclick = () => toggleSplitMode();
  btnTogglePreview.onclick = () => togglePreview();
  btnSettings.onclick = () => openSettings();
  statEncoding.onclick = () => toggleEncoding();
  statAutocomplete.onclick = () => toggleAutocomplete();

  // Settings Tab Switching
  tabBtnTextLLM.onclick = () => switchSettingsTab('text');
  tabBtnAutocomplete.onclick = () => switchSettingsTab('autocomplete');
  tabBtnVisionLLM.onclick = () => switchSettingsTab('vision');
  tabBtnGeneral.onclick = () => switchSettingsTab('general');

  function switchSettingsTab(tabName) {
    tabBtnTextLLM.classList.toggle('active', tabName === 'text');
    tabBtnAutocomplete.classList.toggle('active', tabName === 'autocomplete');
    tabBtnVisionLLM.classList.toggle('active', tabName === 'vision');
    tabBtnGeneral.classList.toggle('active', tabName === 'general');

    paneTextLLM.classList.toggle('hidden', tabName !== 'text');
    paneAutocomplete.classList.toggle('hidden', tabName !== 'autocomplete');
    paneVisionLLM.classList.toggle('hidden', tabName !== 'vision');
    paneGeneral.classList.toggle('hidden', tabName !== 'general');
  }

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

    document.getElementById('cfg-language').value = config.general.language || 'en';
    document.getElementById('cfg-restore-session').checked = config.general.restoreSession !== false;
    document.getElementById('cfg-autosave').checked = config.general.autoSave;
    document.getElementById('cfg-paste-image-ocr').checked = config.general.pasteImageOcr;

    switchSettingsTab('text');
    settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
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

    config.general.language = document.getElementById('cfg-language').value || 'en';
    config.general.restoreSession = document.getElementById('cfg-restore-session').checked;
    config.general.autoSave = document.getElementById('cfg-autosave').checked;
    config.general.pasteImageOcr = document.getElementById('cfg-paste-image-ocr').checked;

    applyLanguage();
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
        config = Object.assign(config, JSON.parse(saved));
      }
    } catch (e) {}
    applyLanguage();
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
          applyLanguage();
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

  async function syncBackendSession() {
    if (window.backend && window.backend.getSession) {
      try {
        const str = await window.backend.getSession();
        if (str) {
          const sessionData = JSON.parse(str);
          // Only apply if tabs were not already loaded or different
          if (tabs.length === 0) {
            restoreSessionFromData(sessionData);
          }
        }
      } catch (e) {
        console.warn('Failed to get session from backend:', e);
      }
    }
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

  // App Startup Entrypoint (Zero-Latency Instant Paint)
  function initApp() {
    loadLocalConfigSync();

    let restored = false;
    if (config.general.restoreSession !== false) {
      restored = loadLocalSessionSync();
    }

    if (!restored) {
      createTab();
    }

    // Background asynchronous sync with filesystem
    syncBackendConfig();
    syncBackendSession();
  }

  initApp();
})();
