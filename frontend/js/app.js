// MD-Notepad Core Application Logic (High Performance, Autocomplete & Clean Minimalist UI)
(function () {
  'use strict';

  // State
  let tabs = [];
  let activeTabId = null;
  let tabCounter = 1;
  let isPreviewMode = false;
  let autoSaveTimerPrimary = null;
  let autoSaveTimerSecondary = null;
  let autocompleteTimer = null;
  let currentAutocompleteReqId = null;
  let ghostSuggestion = '';
  let ghostTargetCursor = 0;
  // Set by the global keydown handler on Ctrl/Cmd+Shift+V (without Alt), consumed by the
  // shared paste handler within SPECIAL_PASTE_WINDOW_MS: this is how "special paste" (paste
  // as Markdown / save image) is told apart from a normal paste, since both fire the same
  // browser 'paste' event.
  let specialPasteArmedAt = 0;
  const SPECIAL_PASTE_WINDOW_MS = 1000;
  let cursorAuraTimer = null;
  let cursorAuraFadeTimer = null;
  let lastCursorAuraPos = -1;
  const CURSOR_AURA_IDLE_DELAY = 1200;

  // Hidden off-screen caret-measurement mirrors, one per editor (see
  // getCharPixelCoords). Declared here so early callers such as applyFontSize()
  // can invalidate them before that function is reached.
  const charMirrors = new WeakMap(); // editor -> { mirror, span, width, generation }
  let charMirrorGeneration = 0;

  function invalidateCharPixelMirrors() {
    charMirrorGeneration++;
  }

  let pendingLLMRequests = new Map();
  // Watchdog timers for pendingLLMRequests. The Go side gives up on an LLM call
  // after 120s (pkg/llm client timeout) plus up to ~6s of Ollama cold start, so a
  // 180s guard can never fire before a legitimately slow local model finishes; it
  // only catches a callback that never arrives at all, which would otherwise leave
  // the [AI生成中...] anchor in the note and the indicator spinning forever.
  const LLM_REQUEST_TIMEOUT_MS = 180000;
  let llmRequestTimers = new Map();
  let cachedLineCount = 0;
  let cachedSecondaryLineCount = 0;
  let rendererLibsLoaded = false;
  let mdInstance = null;

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
    voice: {
      model: 'gemini-3.5-transcribe',
      apiStyle: 'auto',
      baseUrl: '',
      apiKey: '',
      languageCodes: [],
      mode: 'smart',
      customVocabulary: [],
      prompt: 'この音声を正確に文字起こししてください。前置きや解説は不要です。句読点を含む自然な日本語テキストのみを出力してください。',
      silence_timeout_sec: 5,
      // Second stage: tidy the transcript (or apply it to a selection as an edit instruction). Keep in
      // step with resolveRefineConfig in voice_input.js and llm.RefineSettings.
      refine: { enabled: true, model: 'gemini-flash-lite-latest', timeoutSec: 5 }
    },
    cli: {
      model: '',
      baseUrl: '',
      apiKey: '',
      systemPrompt: '',
      openResultInNewTab: true,
      openErrorInNewTab: true,
      resultPlacement: 'below'
    },
    action: {
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'jev-latest',
      apiKey: ''
    },
    image: {
      model: 'gemini-3.1-flash-lite-image',
      aspectRatio: '16:9',
      resolution: '1024'
    },
    general: {
      language: (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('ja')) ? 'ja' : 'en',
      theme: 'olive',
      mermaidTone: 'dark', // diagram colors in the preview: dark | light | neutral | forest (mermaid_tone.js)
      autoSave: true,
      pasteImageOcr: true,
      pasteHtmlAsMarkdown: true,
      restoreSession: true,
      trayResident: true,
      splitViewOnStartup: false,
      imeGuardian: (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('ja')),
      aiCorrection: true,
      cursorAura: true,
      // Toolbar icons / right-click menu items that are hidden, and their order (chrome_layout.js).
      // Empty = the built-in layout.
      toolbarLayout: { order: [], hidden: [] },
      contextMenuLayout: { order: [], hidden: [] }
    },
    scraps: {
      scrapDir: '~/Documents/md-memo/scraps',
      gitSyncEnabled: true,
      gitSyncDebounceSeconds: 30,
      gitRemoteBranch: 'main',
      gitRemoteUrl: '',
      maxPipeSizeMB: 10
    },
    discordBridge: {
      enabled: false,
      botToken: '',
      allowedUserId: '',
      pollIntervalSeconds: 45
    },
    inbox: {
      enabled: false,
      dir: ''
    },
    // Ctrl+Enter's "do what I mean" dispatch (read by slot_agent.js through MdMemoBridge.getAutoSelectorConfig).
    autoSelector: {
      enabled: true,
      agentConfirm: true
    },
    shortcuts: {}
  };

  // Prefer the shared platform.js detection (loaded first in index.html) so every
  // frontend file agrees on the current platform; fall back to the same raw
  // expression when platform.js hasn't run (e.g. a test harness that extracts
  // and evaluates app.js source in isolation without loading index.html).
  const isMac = (typeof window !== 'undefined' && window.MDMemoPlatform)
    ? window.MDMemoPlatform.isMac
    : (typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent));

  // Runtime OS capabilities, fetched (once, best-effort) from the Go backend via
  // window.backend.getPlatformCapabilities(). Conservative defaults (everything
  // supported) are assumed until/unless that call resolves, and forever if the
  // bound helper isn't present at all (older backend build) or the call rejects.
  let platformCapabilities = { os: isMac ? 'darwin' : 'win32', nativeImeSwitch: true, tray: true, globalHotkey: true };
  // True once we've seen a persisted config that already had an explicit
  // general.imeGuardian value (from localStorage or the backend config file).
  // Used to distinguish a genuinely first-ever run (nothing persisted yet) from
  // every subsequent launch, since savePersistentConfig() always serializes the
  // whole `config` object once the user has saved anything at all.
  let hasPersistedImeGuardianSetting = false;

  const DEFAULT_SHORTCUTS_WIN = {
    newTab: 'Ctrl+N',
    openFile: 'Ctrl+O',
    openFolder: 'Ctrl+Shift+O',
    saveFile: 'Ctrl+S',
    saveFileAs: 'Ctrl+Shift+S',
    closeTab: 'Ctrl+W',
    exportPlainText: '',
    find: 'Ctrl+F',
    searchScraps: 'Ctrl+Shift+F',
    replace: 'Ctrl+H',
    gotoLine: 'Ctrl+G',
    quickPick: 'Ctrl+Shift+P',
    insertDate: 'F5',
    togglePreview: 'Ctrl+P',
    toggleSplit: 'Ctrl+\\',
    zenMode: 'Shift+F11',
    // F11 is full screen (the whole monitor, no title bar or taskbar); it is fixed, this entry is a second key for it.
    // Maximize / restore has no key of its own any more (the title bar's button and a double click do it).
    toggleFullscreen: 'F11',
    toggleMaximize: '',
    minimize: '',
    globalSummon: 'Ctrl+Alt+M',
    // Global (OS-level) hotkey for the native quick-capture popup; Windows only. Keep in step with
    // defaultQuickCaptureShortcut in quickcapture.go.
    quickCapture: 'Ctrl+Shift+Q',
    inlinePrompt: 'Ctrl+L',
    aiCorrection: 'Alt+C',
    quickActions: 'Ctrl+J',
    convertMermaid: '',
    mermaidToImage: '',
    moveLineUp: 'Alt+ArrowUp',
    moveLineDown: 'Alt+ArrowDown',
    duplicateLineUp: 'Shift+Alt+ArrowUp',
    duplicateLineDown: 'Shift+Alt+ArrowDown',
    deleteLine: 'Ctrl+Shift+K',
    insertLineBelow: 'Shift+Enter',
    insertLineAbove: 'Shift+Alt+Enter',
    // One key for the command bar (it reopens in the mode last used); the two mode-specific keys are
    // opt-in now, a config that already saved Ctrl+Shift+B / Ctrl+Shift+E keeps them.
    commandBar: 'Ctrl+E',
    runCliFilter: '',
    runAiCli: '',
    mobileDrop: 'Ctrl+Shift+U',
    voiceInput: 'Ctrl+Shift+R',
    voiceInputRaw: 'Ctrl+Shift+Alt+R',
    voiceRefineToggle: 'Ctrl+Alt+R',
    openSettings: 'Ctrl+,'
  };

  const DEFAULT_SHORTCUTS_MAC = {
    newTab: 'Cmd+N',
    openFile: 'Cmd+O',
    openFolder: 'Cmd+Shift+O',
    saveFile: 'Cmd+S',
    saveFileAs: 'Cmd+Shift+S',
    closeTab: 'Cmd+W',
    exportPlainText: '',
    find: 'Cmd+F',
    searchScraps: 'Cmd+Shift+F',
    replace: 'Cmd+Option+F',
    gotoLine: 'Cmd+G',
    quickPick: 'Cmd+Shift+P',
    insertDate: 'Cmd+Shift+I',
    togglePreview: 'Cmd+P',
    toggleSplit: 'Cmd+\\',
    // NOT 'Cmd+Shift+Z': that's the native Edit menu's Redo, which consumes the
    // key equivalent before the WKWebView ever sees the keydown, making Zen
    // Mode permanently unreachable on macOS. See migrateMacShortcuts() for the
    // one-time migration of configs saved under the old (broken) default.
    zenMode: 'Ctrl+Cmd+Z',
    toggleFullscreen: 'Ctrl+Cmd+F',
    toggleMaximize: '',
    minimize: 'Cmd+M',
    globalSummon: 'Cmd+Alt+M',
    quickCapture: '',
    inlinePrompt: 'Cmd+L',
    aiCorrection: 'Cmd+Shift+C',
    quickActions: 'Cmd+J',
    convertMermaid: '',
    mermaidToImage: '',
    moveLineUp: 'Option+ArrowUp',
    moveLineDown: 'Option+ArrowDown',
    duplicateLineUp: 'Shift+Option+ArrowUp',
    duplicateLineDown: 'Shift+Option+ArrowDown',
    deleteLine: 'Cmd+Shift+K',
    insertLineBelow: 'Shift+Enter',
    insertLineAbove: 'Shift+Option+Enter',
    commandBar: 'Cmd+E',
    runCliFilter: '',
    runAiCli: '',
    mobileDrop: 'Cmd+Shift+U',
    voiceInput: 'Cmd+Shift+R',
    voiceInputRaw: 'Cmd+Shift+Option+R',
    voiceRefineToggle: 'Cmd+Option+R',
    openSettings: 'Cmd+,'
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

  // Pure decision table for the clipboard paste branch (机能 1): normal paste (Ctrl/Cmd+V) vs
  // special paste (Ctrl/Cmd+Shift+V), crossed with what the clipboard actually holds. Kept
  // free of the DOM/editor so it can be unit tested directly (see
  // tests/rev3_wiring_test.mjs), and so the paste handler itself is just "look up the action,
  // then do it".
  // Ctrl+V makes Markdown of what it is given: HTML with structure (a table, headings, lists, links ...) becomes Markdown and
  // a picture on its own is transcribed by OCR. Ctrl+Shift+V pastes as it is: plain text, or the picture kept as a file.
  // With the setting general.pasteHtmlAsMarkdown off (htmlAsMarkdown false) the old split applies: Ctrl+V plain,
  // Ctrl+Shift+V converts.
  //   'ocr'       - a picture on its own, OCR-on-paste enabled and set up (Ctrl+V)
  //   'saveImage' - a picture on its own: save to ./assets, insert link. Ctrl+Shift+V always; Ctrl+V when the picture
  //                 cannot be transcribed (OCR off, or no API setup: visionReady false), the way Mobile Drop keeps
  //                 what it cannot transcribe
  //   'htmlToMd'  - HTML with structure (structured true) that does not come from an editor (editorOrigin false):
  //                 convert to Markdown, insert
  //   'readClipboard' - Ctrl+Shift+V whose event holds no picture and no plain text (Chromium strips everything but
  //                 text/plain from it): ask the async clipboard for the picture / HTML. Old split: also without HTML.
  //   'default'   - let the browser perform its normal paste unmodified (plain text)
  function decidePasteAction(opts) {
    const o = opts || {};
    const types = o.types || [];
    const hasHtml = types.indexOf('text/html') !== -1;
    const hasPlain = types.indexOf('text/plain') !== -1;
    const pictureOnly = !!o.hasImage && !hasPlain;
    if (o.htmlAsMarkdown === false) {
      if (o.special) {
        // Excel / Word put an image next to the HTML: the table is what the user wants.
        if (hasHtml) return 'htmlToMd';
        if (o.hasImage) return 'saveImage';
        return o.canReadClipboard ? 'readClipboard' : 'default';
      }
      if (pictureOnly) return (o.ocrEnabled && o.visionReady !== false) ? 'ocr' : 'saveImage';
      return 'default';
    }
    if (o.special) {
      if (pictureOnly) return 'saveImage';
      // Chromium gives "paste as plain text" (Ctrl+Shift+V) an event that carries text/plain and nothing else, so a
      // picture (or a page's HTML) is invisible to it. With no plain text in the event, ask the real clipboard.
      return (!hasPlain && !o.hasImage && o.canReadClipboard) ? 'readClipboard' : 'default';
    }
    if (pictureOnly) return (o.ocrEnabled && o.visionReady !== false) ? 'ocr' : 'saveImage';
    if (hasHtml && o.structured && !o.editorOrigin) return 'htmlToMd';
    return 'default';
  }

  // Whether the image (vision) model can answer at all. Mirrors QueryVision in pkg/llm: Gemini (also the default when the
  // URL is empty) needs an API key, and so do the hosted OpenAI-style services; a local server (Ollama, LM Studio, a LAN
  // box) does not.
  function isVisionConfigured() {
    const cfg = config.vision || {};
    if (String(cfg.apiKey || '').trim()) return true;
    const base = String(cfg.baseUrl || '').trim().toLowerCase();
    const model = (String(cfg.model || '').trim() || 'gemini-flash-lite-latest').toLowerCase();
    const local = (base.indexOf('11434') !== -1 || base.indexOf(':1234') !== -1 || base.indexOf(':8080') !== -1) && base.indexOf('/v1beta') === -1;
    const gemini = !local && (base.indexOf('googleapis.com') !== -1 || model.indexOf('gemini') !== -1 || base.indexOf('/v1beta') !== -1 || base === '');
    if (gemini) return false;
    return !['openai.com', 'groq.com', 'together.xyz', 'openrouter.ai'].some((host) => base.indexOf(host) !== -1);
  }

  // ext whitelist mirrors assetExtWhitelist in app_inputs.go; only these ever reach SaveAsset.
  function assetExtForMime(mimeType) {
    const m = String(mimeType || '').toLowerCase();
    if (m.indexOf('jpeg') !== -1 || m.indexOf('jpg') !== -1) return 'jpg';
    if (m.indexOf('gif') !== -1) return 'gif';
    if (m.indexOf('webp') !== -1) return 'webp';
    return 'png';
  }

  // Settings text <-> list conversion for the voice fields (language codes, custom vocabulary).
  // A hand-edited config may hold a plain string instead of an array: it is shown as it is.
  function listToText(value, sep) {
    if (Array.isArray(value)) return value.join(sep);
    return typeof value === 'string' ? value : '';
  }

  // Splits on sepRe, trims, and drops empty items.
  function textToList(text, sepRe) {
    return String(text || '').split(sepRe).map((s) => s.trim()).filter((s) => s.length > 0);
  }

  // Clamps a settings numeric input's raw value into [min, max], falling back
  // to `fallback` when the value is empty/NaN. Used at every numeric settings
  // save site so an out-of-range or garbage value (e.g. a negative timeout)
  // can never reach the persisted config or a live backend call.
  function clampNumber(value, min, max, fallback, isFloat) {
    const num = isFloat ? parseFloat(value) : parseInt(value, 10);
    if (isNaN(num)) return fallback;
    let clamped = num;
    if (typeof min === 'number' && clamped < min) clamped = min;
    if (typeof max === 'number' && clamped > max) clamped = max;
    return clamped;
  }

  // Generates a request/tab id as `${prefix}${Date.now()}_${random}`. Several
  // call sites key off the prefix (e.g. an LLM callback checks reqId.startsWith
  // ('vision_')), so callers must keep passing their own existing prefix
  // unchanged; only the random-suffix boilerplate is deduplicated here.
  function genReqId(prefix) {
    return prefix + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  }

  // Wires a number input so that on blur its value is clamped/reflected back,
  // giving the user immediate feedback about what will actually be saved.
  function wireNumberInputClamp(id, min, max, fallback, isFloat) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('blur', () => {
      if (el.value === '') return; // let placeholder/fallback logic handle empty on save
      const clamped = clampNumber(el.value, min, max, fallback, isFloat);
      el.value = clamped;
    });
  }

  function applyTheme() {
    const theme = (config.general && config.general.theme) || 'olive';
    document.body.classList.remove('theme-olive', 'theme-blue', 'theme-forest', 'theme-charcoal');
    document.body.classList.add('theme-' + theme);
    if (typeof invalidateCharPixelMirrors === 'function') invalidateCharPixelMirrors();
  }

  function applyLanguage() {
    const lang = (config.general && config.general.language) || 'en';
    document.documentElement.lang = lang;

    // Translate all elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val !== key) {
        el.textContent = val;
      }
    });

    // Translate titles
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const val = t(key);
      if (val !== key) {
        el.title = val;
      }
    });

    // Translate placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = t(key);
      if (val !== key) {
        el.placeholder = val;
      }
    });

    // Update status bar texts
    renderAutosaveStatus();
    renderVoiceRefineStatus();
    if (statAutocomplete && !statAutocomplete.textContent.includes('Error') && !statAutocomplete.textContent.includes('エラー')) {
      statAutocomplete.textContent = config.autocomplete.enabled ? t('statAutocompleteOn') : t('statAutocompleteOff');
      statAutocomplete.title = config.autocomplete.enabled ? t('statAutocompleteTooltip') : t('statAutocompleteOffTooltip');
    }
    if (statIme) {
      const isJa = (lang === 'ja');
      const isImeEnabled = !!(config.general && config.general.imeGuardian);
      if (isJa) {
        statIme.style.display = '';
        statIme.textContent = isImeEnabled ? t('statImeOn') : t('statImeOff');
        statIme.title = t('statImeTooltip');
        statIme.style.opacity = isImeEnabled ? '1' : '0.6';
      } else {
        statIme.style.display = 'none';
      }
    }
    updateActionStatus();
    if (btnTogglePreview) btnTogglePreview.title = isPreviewMode ? t('edit') : t('togglePreviewTitle');
    if (btnToggleSplit) btnToggleSplit.title = t('splitViewTitle');
    if (typeof updateGitSyncStatusUI === 'function') updateGitSyncStatusUI();
    updateShortcutLabels();
    // The editor's row labels are translated text: redraw them if it is open.
    if (layoutDetailsEl && layoutDetailsEl.open) renderLayoutEditors();
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
  const btnZen = document.getElementById('btn-zen');
  const btnFullscreen = document.getElementById('btn-fullscreen');
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
  // SlotAgent was previously only ever attached to the primary editor (from
  // selectTab), so the secondary pane had no {{ }} trigger detection, quick
  // selector, or Ctrl+Enter slot execution. The attach guard on the SlotAgent
  // side (__slotAgentAttached) makes this idempotent, so it's safe to wire up
  // once here rather than repeating it at every split/tab-select call site.
  if (window.SlotAgent && window.SlotAgent.attachEditor && editorSecondary) {
    window.SlotAgent.attachEditor(editorSecondary);
  }
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
  const statAction = document.getElementById('stat-action');
  const statAutocomplete = document.getElementById('stat-autocomplete');
  const statAutosave = document.getElementById('stat-autosave');
  const statVoiceRefine = document.getElementById('stat-voice-refine');
  const statEncoding = document.getElementById('stat-encoding');
  const statMode = document.getElementById('stat-mode');

  const contextMenu = document.getElementById('context-menu');
  const settingsModal = document.getElementById('settings-modal');

  // Settings tab elements (5-tab architecture: general, model, agent, sync, shortcuts)
  const tabBtnGeneral = document.getElementById('tab-btn-general');
  const tabBtnText = document.getElementById('tab-btn-text'); // legacy fallback
  const tabBtnImage = document.getElementById('tab-btn-image'); // legacy fallback
  const tabBtnModel = document.getElementById('tab-btn-model');
  const tabBtnAgent = document.getElementById('tab-btn-agent') || document.getElementById('tab-btn-cli');
  const tabBtnSync = document.getElementById('tab-btn-sync') || document.getElementById('tab-btn-scraps');
  const tabBtnShortcuts = document.getElementById('tab-btn-shortcuts');
  const btnHelp = document.getElementById('btn-help');
  const helpUpdateBadge = document.getElementById('help-update-badge');

  const paneGeneral = document.getElementById('pane-general');
  const paneText = document.getElementById('pane-text'); // legacy fallback
  const paneImage = document.getElementById('pane-image'); // legacy fallback
  const paneModel = document.getElementById('pane-model');
  const paneAgent = document.getElementById('pane-agent') || document.getElementById('pane-cli');
  const paneSync = document.getElementById('pane-sync') || document.getElementById('pane-scraps');
  const paneShortcuts = document.getElementById('pane-shortcuts');
  const shortcutsListBody = document.getElementById('shortcuts-list-body');
  const btnResetShortcuts = document.getElementById('btn-reset-shortcuts');

  // Scraps & Git Sync Elements
  const statGitSync = document.getElementById('stat-gitsync');
  let currentGitSyncStatus = null;

  function updateGitSyncStatusUI(statusInfo) {
    if (!statGitSync) return;
    if (statusInfo) {
      currentGitSyncStatus = statusInfo;
    }
    const isEnabled = config.scraps ? (config.scraps.gitSyncEnabled !== false) : (config.git_sync_enabled !== false);
    if (!isEnabled) {
      statGitSync.textContent = t('gitSyncStatusDisabled');
      statGitSync.title = t('gitSyncDisabledTooltip');
      statGitSync.style.color = 'var(--text-muted, #888)';
      statGitSync.style.opacity = '0.55';
      statGitSync.classList.add('status-disabled');
      return;
    }

    statGitSync.classList.remove('status-disabled');
    statGitSync.style.opacity = '1';

    const info = currentGitSyncStatus;
    if (!info || info.status === 'ready') {
      statGitSync.textContent = 'Git: Ready';
      statGitSync.title = 'Git Sync Status: Click to trigger sync';
      statGitSync.style.color = '';
    } else if (info.status === 'syncing') {
      statGitSync.textContent = 'Git: Syncing';
      statGitSync.title = info.message || 'Git: Syncing in background...';
      statGitSync.style.color = '#e2c08d';
    } else if (info.status === 'synced') {
      statGitSync.textContent = 'Git: Synced';
      statGitSync.title = info.message || 'Git: Synced';
      statGitSync.style.color = '#73c991';
    } else if (info.status === 'error') {
      statGitSync.textContent = 'Git: Error';
      statGitSync.title = info.message || 'Git: Sync error';
      statGitSync.style.color = '#f48771';
    } else if (info.status === 'disabled') {
      statGitSync.textContent = t('gitSyncStatusDisabled');
      statGitSync.title = t('gitSyncDisabledTooltip');
      statGitSync.style.color = 'var(--text-muted, #888)';
      statGitSync.style.opacity = '0.55';
      statGitSync.classList.add('status-disabled');
    }
  }

  const btnSearchScraps = document.getElementById('btn-search-scraps');
  const scrapsSearchModal = document.getElementById('scraps-search-modal');
  const scrapsSearchInput = document.getElementById('scraps-search-input');
  const scrapsSearchResults = document.getElementById('scraps-search-results');
  let lastPipedCwd = '';

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

  // Ask Bar Elements (Ctrl+L)
  const inlinePromptBar = document.getElementById('inline-prompt-bar');
  const inlinePromptInput = document.getElementById('inline-prompt-input');
  const inlinePromptTarget = document.getElementById('inline-prompt-target');
  const inlinePromptHint = document.getElementById('inline-prompt-hint');
  const btnInlinePromptSend = document.getElementById('btn-inline-prompt-send');
  const btnInlinePromptClose = document.getElementById('btn-inline-prompt-close');

  // Command Bar Elements (Ctrl+E)
  const cliFilterBar = document.getElementById('cli-filter-bar');
  const cliFilterBadge = document.getElementById('cli-filter-badge');
  const cliFilterInput = document.getElementById('cli-filter-input');
  const btnCliFilterSend = document.getElementById('btn-cli-filter-send');
  const btnCliFilterClose = document.getElementById('btn-cli-filter-close');
  const btnCliFilterExpand = document.getElementById('btn-cli-filter-expand');
  const cliFilterPreview = document.getElementById('cli-filter-preview');

  // Settings Export / Import Elements
  const btnExportSettings = document.getElementById('btn-export-settings');
  const btnImportSettings = document.getElementById('btn-import-settings');

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

  // Mobile Drop QR Sync Elements (Ctrl+Shift+U / Cmd+Shift+U)
  const mobileDropModal = document.getElementById('mobile-drop-modal');
  const mobileDropLoading = document.getElementById('mobile-drop-loading');
  const mobileDropContent = document.getElementById('mobile-drop-content');
  const mobileDropErrorEl = document.getElementById('mobile-drop-error');
  const mobileDropQrImg = document.getElementById('mobile-drop-qr');
  const mobileDropUrlEl = document.getElementById('mobile-drop-url');
  const mobileDropCountdownEl = document.getElementById('mobile-drop-countdown');
  const mobileDropHintEl = document.getElementById('mobile-drop-hint');
  const mobileDropSharedPreviewEl = document.getElementById('mobile-drop-shared-preview');
  const modalMobileDropClose = document.getElementById('modal-mobile-drop-close');
  const btnMobileDropCancel = document.getElementById('btn-mobile-drop-cancel');
  const btnMobileDropTunnel = document.getElementById('btn-mobile-drop-tunnel');
  const mobileDropTunnelStatusEl = document.getElementById('mobile-drop-tunnel-status');
  const btnMobileDrop = document.getElementById('btn-mobile-drop');
  const btnVoiceInput = document.getElementById('btn-voice-input');
  const btnQuickCapture = document.getElementById('btn-quick-capture');
  const layoutDetailsEl = document.getElementById('cfg-layout-details');
  const layoutToolbarHostEl = document.getElementById('cfg-layout-toolbar');
  const layoutContextHostEl = document.getElementById('cfg-layout-context');
  const btnLayoutReset = document.getElementById('btn-layout-reset');
  const mobileDropInstallEl = document.getElementById('mobile-drop-install');
  const mobileDropInstallCmdEl = document.getElementById('mobile-drop-install-cmd');
  const btnMobileDropInstallCopy = document.getElementById('btn-mobile-drop-install-copy');
  const mobileDropInstallCopyLabelEl = document.getElementById('mobile-drop-install-copy-label');

  // Custom In-App Confirm Dialog (Eliminates Browser 127.0.0.1 Prompt)
  const confirmModal = document.getElementById('confirm-modal');
  const confirmModalMessage = document.getElementById('confirm-modal-message');
  const confirmModalSave = document.getElementById('confirm-modal-save');
  const confirmModalDontSave = document.getElementById('confirm-modal-dontsave');
  const confirmModalOk = document.getElementById('confirm-modal-ok');
  const confirmModalCancel = document.getElementById('confirm-modal-cancel');
  const confirmModalClose = document.getElementById('confirm-modal-close');

  // Notepad-standard 3-option dialog: Save / Don't Save / Cancel
  function confirmSaveDialog(title) {
    return new Promise((resolve) => {
      if (!confirmModal || !confirmModalMessage) {
        resolve('dontsave');
        return;
      }
      confirmModalMessage.textContent = t('confirmCloseUnsaved', { title: title || t('untitled') });
      if (confirmModalSave) {
        confirmModalSave.textContent = t('btnSave');
        confirmModalSave.style.display = '';
      }
      if (confirmModalDontSave) {
        confirmModalDontSave.textContent = t('btnDontSave');
        confirmModalDontSave.style.display = '';
      }
      if (confirmModalCancel) {
        confirmModalCancel.textContent = t('btnCancel');
        confirmModalCancel.style.display = '';
      }
      if (confirmModalOk) {
        confirmModalOk.style.display = 'none';
      }
      confirmModal.classList.remove('hidden');

      const cleanup = (action) => {
        confirmModal.classList.add('hidden');
        if (confirmModalSave) confirmModalSave.onclick = null;
        if (confirmModalDontSave) confirmModalDontSave.onclick = null;
        if (confirmModalCancel) confirmModalCancel.onclick = null;
        if (confirmModalClose) confirmModalClose.onclick = null;
        window.removeEventListener('keydown', onKeyDown, true);
        resolve(action);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('cancel');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('save');
        } else if (e.key === 'd' || e.key === 'D' || e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('dontsave');
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('save');
        }
      };

      if (confirmModalSave) confirmModalSave.onclick = () => cleanup('save');
      if (confirmModalDontSave) confirmModalDontSave.onclick = () => cleanup('dontsave');
      if (confirmModalCancel) confirmModalCancel.onclick = () => cleanup('cancel');
      if (confirmModalClose) confirmModalClose.onclick = () => cleanup('cancel');
      window.addEventListener('keydown', onKeyDown, true);

      // Focus Save button by default
      setTimeout(() => {
        if (confirmModalSave) confirmModalSave.focus();
      }, 10);
    });
  }

  function customConfirm(message) {
    return new Promise((resolve) => {
      if (!confirmModal || !confirmModalMessage) {
        resolve(true);
        return;
      }
      confirmModalMessage.textContent = message;
      if (confirmModalSave) confirmModalSave.style.display = 'none';
      if (confirmModalDontSave) confirmModalDontSave.style.display = 'none';
      if (confirmModalOk) {
        confirmModalOk.textContent = t('btnOk');
        confirmModalOk.classList.remove('hidden');
        confirmModalOk.style.display = '';
      }
      if (confirmModalCancel) {
        confirmModalCancel.textContent = t('btnCancel');
        confirmModalCancel.style.display = '';
      }
      confirmModal.classList.remove('hidden');

      const cleanup = (result) => {
        confirmModal.classList.add('hidden');
        if (confirmModalOk) confirmModalOk.onclick = null;
        if (confirmModalCancel) confirmModalCancel.onclick = null;
        if (confirmModalClose) confirmModalClose.onclick = null;
        window.removeEventListener('keydown', onKeyDown, true);
        resolve(result);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(true);
        }
      };

      if (confirmModalOk) confirmModalOk.onclick = () => cleanup(true);
      if (confirmModalCancel) confirmModalCancel.onclick = () => cleanup(false);
      if (confirmModalClose) confirmModalClose.onclick = () => cleanup(false);
      window.addEventListener('keydown', onKeyDown, true);

      setTimeout(() => {
        if (confirmModalOk) confirmModalOk.focus();
      }, 10);
    });
  }

  // --- Non-Intrusive Tab-Based IME Guardian (On-Demand Instance) ---
  let imeGuardianInstance = null;
  function getImeGuardian() {
    if (!imeGuardianInstance && typeof IMEGuardian !== 'undefined') {
      imeGuardianInstance = new IMEGuardian();
    }
    return imeGuardianInstance;
  }
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

  let rendererLibsLoadingPromise = null;
  async function ensureRendererLibraries() {
    if (rendererLibsLoaded) return;
    if (rendererLibsLoadingPromise) return rendererLibsLoadingPromise;

    rendererLibsLoadingPromise = (async () => {
      try {
        const tasks = [];
        if (!document.querySelector('link[href*="katex.min.css"]')) {
          tasks.push(loadStylesheet('vendor/katex.min.css'));
        }
        if (!window.markdownit) {
          tasks.push(loadScript('vendor/markdown-it.min.js'));
        }
        if (!window.katex) {
          tasks.push(loadScript('vendor/katex.min.js'));
        }
        if (tasks.length > 0) {
          await Promise.all(tasks);
        }

        if (window.markdownit && !mdInstance) {
          mdInstance = window.markdownit({
            html: false,
            linkify: true,
            typographer: true,
            breaks: true
          });
          // Accept `![alt](/path with spaces/x.png)` (preview_images.js), e.g. ~/Library/Application Support.
          window.PreviewImages.installLooseImageRule(mdInstance);
        }
        rendererLibsLoaded = true;
      } catch (e) {
        console.warn('Renderer script load error:', e);
      } finally {
        rendererLibsLoadingPromise = null;
      }
    })();

    return rendererLibsLoadingPromise;
  }

  let mermaidLoaded = false;
  let mermaidLoadingPromise = null;
  let mermaidAppliedTone = null;

  // (Re)initialises Mermaid when the diagram tone (config.general.mermaidTone, mermaid_tone.js) is not
  // the one it was last set up with. Returns the tone in force.
  function applyMermaidTone() {
    const tone = window.MermaidTone.normalizeTone(config.general && config.general.mermaidTone);
    if (window.mermaid && mermaidAppliedTone !== tone) {
      window.mermaid.initialize(window.MermaidTone.mermaidConfig(tone));
      mermaidAppliedTone = tone;
    }
    return tone;
  }

  // The button on each diagram: flips dark <-> light, remembers it, and redraws the diagrams.
  function flipMermaidTone() {
    if (!config.general) config.general = {};
    config.general.mermaidTone = window.MermaidTone.flipTone(config.general.mermaidTone);
    savePersistentConfig();
    renderPreview();
    renderSecondaryPreview();
  }

  async function ensureMermaidLibraries() {
    if (window.mermaid && mermaidLoaded) return;
    if (mermaidLoadingPromise) return mermaidLoadingPromise;

    mermaidLoadingPromise = (async () => {
      try {
        if (!window.mermaid) {
          await loadScript('vendor/mermaid.min.js');
        }
        if (window.mermaid) {
          applyMermaidTone();
          mermaidLoaded = true;
        }
      } catch (e) {
        console.warn('Mermaid load error:', e);
      } finally {
        mermaidLoadingPromise = null;
      }
    })();

    return mermaidLoadingPromise;
  }

  // --- Autonomous Memory Reclaimer (OS WorkingSet & Go Heap Compression) ---
  let memoryTrimTimer = null;
  function scheduleMemoryTrim(delayMs = 25000) {
    clearTimeout(memoryTrimTimer);
    memoryTrimTimer = setTimeout(() => {
      triggerMemoryTrimNow();
    }, delayMs);
  }

  function triggerMemoryTrimNow() {
    clearTimeout(memoryTrimTimer);
    if (window.backend && window.backend.trimMemory) {
      try {
        window.backend.trimMemory();
      } catch (_) {}
    }
  }

  // Auto-trim memory when window loses visibility or focus
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      triggerMemoryTrimNow();
    }
  });
  window.addEventListener('blur', () => {
    scheduleMemoryTrim(5000); // 5s after window loses focus
  });

  // Chromium drops the space that follows the insertion point when the inserted text itself
  // contains whitespace (seen with an overflow:hidden ancestor). Replacing that space together
  // with the selection keeps it, in a single undo step.
  function execInsertTextExact(editor, text) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const before = editor.value;
    const next = before.charAt(end);
    const guard = next === ' ' && /\s/.test(text);
    if (guard) editor.setSelectionRange(start, end + 1);
    if (!document.execCommand('insertText', false, guard ? text + next : text)) {
      if (guard) editor.setSelectionRange(start, end);
      return false;
    }
    const expected = before.substring(0, start) + text + before.substring(end);
    if (editor.value !== expected) editor.value = expected;
    const caret = start + text.length;
    editor.setSelectionRange(caret, caret);
    return true;
  }

  // Undo/Redo Friendly Text Insertion & Range Replacement
  function insertTextWithUndo(text, targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return;
    editor.focus();
    let success = false;
    try {
      success = execInsertTextExact(editor, text);
    } catch (e) {
      success = false;
    }
    if (!success) {
      // Fallback if browser environment restricts execCommand
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const val = editor.value;
      editor.value = val.substring(0, start) + text + val.substring(end);
      editor.selectionStart = start + text.length;
      editor.selectionEnd = start + text.length;
    }
  }

  // Restore what an asynchronously arriving LLM result would otherwise disturb:
  // the user's focus target, selection (incl. direction) and editor scroll.
  function restoreEditorUserContext(editor, snap, newStart, newEnd) {
    const len = editor.value.length;
    const s = Math.max(0, Math.min(len, newStart));
    const e = Math.max(s, Math.min(len, newEnd));
    try {
      if (snap.dir && snap.dir !== 'none' && typeof editor.setSelectionRange === 'function') {
        editor.setSelectionRange(s, e, snap.dir);
      } else {
        editor.selectionStart = s;
        editor.selectionEnd = e;
      }
    } catch (err) {
      editor.selectionStart = editor.selectionEnd = s;
    }
    editor.scrollTop = snap.scrollTop;
    if (snap.activeEl && snap.activeEl !== editor && typeof snap.activeEl.focus === 'function') {
      try {
        snap.activeEl.focus();
      } catch (err) {
        /* element is gone; nothing to restore */
      }
    }
  }

  function replaceAnchorWithUndo(anchorId, replacementText, targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return false;

    // Snapshot BEFORE focus()/setSelectionRange clobber it. The status text
    // promises "typing enabled", so the merge must be invisible to a user who
    // has moved on (Find box, CLI bar, settings, the other pane...).
    const snap = {
      activeEl: document.activeElement,
      start: editor.selectionStart,
      end: editor.selectionEnd,
      dir: editor.selectionDirection || 'none',
      scrollTop: editor.scrollTop || 0
    };

    editor.focus();
    const currentVal = editor.value;
    const anchorIdx = currentVal.indexOf(anchorId);
    if (anchorIdx !== -1) {
      const anchorEnd = anchorIdx + anchorId.length;
      const delta = replacementText.length - anchorId.length;
      // Before the anchor: untouched. After it: slide by the length delta.
      // At/inside it (the user is waiting right there): keep today's behavior of
      // landing just after the inserted text.
      const mapOffset = (off) => {
        if (off < anchorIdx) return off;
        if (off >= anchorEnd) return off + delta;
        return anchorIdx + replacementText.length;
      };

      editor.setSelectionRange(anchorIdx, anchorEnd);
      let success = false;
      try {
        success = execInsertTextExact(editor, replacementText);
      } catch (e) {
        success = false;
      }
      if (!success) {
        editor.value = currentVal.replace(anchorId, replacementText);
      }
      restoreEditorUserContext(editor, snap, mapOffset(snap.start), mapOffset(snap.end));
      return true;
    } else {
      // If anchor was removed/missing, append to the end
      const appendAt = currentVal.length;
      const insertion = `\n\n${replacementText}\n`;
      editor.setSelectionRange(appendAt, appendAt);
      insertTextWithUndo(insertion, editor);
      const mapOffset = (off) => (off >= appendAt ? off + insertion.length : off);
      restoreEditorUserContext(editor, snap, mapOffset(snap.start), mapOffset(snap.end));
      return false;
    }
  }

  // Finds anchorId in the tab identified by tabId and replaces it with replacement (or
  // appends replacement if the anchor is no longer there), wherever that tab currently lives:
  // the active pane, the secondary pane, or neither (a background tab, edited as a plain
  // string). This is __onLLMResult's own three-branch dispatch, pulled out so
  // MdMemoBridge.replaceAnchor (used by voice_input.js / file_anchor.js) shares the exact
  // same behavior instead of re-implementing it. Returns false only when tabId names a tab
  // that no longer exists.
  function applyAnchorReplacement(tabId, anchorId, replacement) {
    const targetTab = getTab(tabId);
    if (!targetTab) return false;

    if (tabId === activeTabId) {
      replaceAnchorWithUndo(anchorId, replacement, editorEl);

      targetTab.content = editorEl.value;
      targetTab.isDirty = true;
      renderTabs();
      cachedLineCount = 0;
      updateLineNumbers();
      updateStatusBar();
      if (isPreviewMode) renderPreview();
      if (isSplitMode && secondaryTabId === targetTab.id) {
        if (secondaryViewMode === 'preview') {
          renderSecondaryPreview();
        } else if (editorSecondary && editorSecondary.value !== editorEl.value) {
          editorSecondary.value = editorEl.value;
          updateSecondaryLineNumbers();
        }
      }
    } else if (isSplitMode && secondaryViewMode === 'editor' && tabId === secondaryTabId && editorSecondary) {
      replaceAnchorWithUndo(anchorId, replacement, editorSecondary);

      targetTab.content = editorSecondary.value;
      targetTab.isDirty = true;
      renderTabs();
      updateSecondaryLineNumbers();
      updateStatusBar();
      if (targetTab.id === activeTabId) {
        editorEl.value = editorSecondary.value;
        cachedLineCount = 0;
        updateLineNumbers();
        if (isPreviewMode) renderPreview();
      }
    } else {
      if (targetTab.content.includes(anchorId)) {
        targetTab.content = targetTab.content.replace(anchorId, replacement);
      } else {
        targetTab.content += `\n\n${replacement}\n`;
      }
      targetTab.isDirty = true;
      renderTabs();
    }
    return true;
  }

  // --- Line Operations ---
  function getLineBoundaries(val, start, end) {
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = val.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = val.length;
    return { lineStart, lineEnd };
  }

  function executeMoveLine(editor, direction) {
    if (!editor) return;
    const val = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const { lineStart, lineEnd } = getLineBoundaries(val, start, end);

    if (direction === 'up') {
      if (lineStart === 0) return; // At top
      const prevLineStart = val.lastIndexOf('\n', lineStart - 2) + 1;
      const prevLineText = val.substring(prevLineStart, lineStart - 1);
      const targetText = val.substring(lineStart, lineEnd);
      const newBlock = targetText + '\n' + prevLineText;
      const shift = prevLineText.length + 1;

      editor.focus();
      editor.setSelectionRange(prevLineStart, lineEnd);
      let success = false;
      try {
        success = document.execCommand('insertText', false, newBlock);
      } catch (e) {}
      if (!success) {
        editor.value = val.substring(0, prevLineStart) + newBlock + val.substring(lineEnd);
      }
      editor.setSelectionRange(start - shift, end - shift);
    } else if (direction === 'down') {
      if (lineEnd >= val.length) return; // At bottom
      const nextLineEndIdx = val.indexOf('\n', lineEnd + 1);
      const nextLineEnd = nextLineEndIdx === -1 ? val.length : nextLineEndIdx;
      const nextLineText = val.substring(lineEnd + 1, nextLineEnd);
      const targetText = val.substring(lineStart, lineEnd);
      const newBlock = nextLineText + '\n' + targetText;
      const shift = nextLineText.length + 1;

      editor.focus();
      editor.setSelectionRange(lineStart, nextLineEnd);
      let success = false;
      try {
        success = document.execCommand('insertText', false, newBlock);
      } catch (e) {}
      if (!success) {
        editor.value = val.substring(0, lineStart) + newBlock + val.substring(nextLineEnd);
      }
      editor.setSelectionRange(start + shift, end + shift);
    }

    onEditorInput(editor);
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }

  function executeDuplicateLine(editor, direction) {
    if (!editor) return;
    const val = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const { lineStart, lineEnd } = getLineBoundaries(val, start, end);
    const targetText = val.substring(lineStart, lineEnd);

    editor.focus();
    if (direction === 'down') {
      editor.setSelectionRange(lineEnd, lineEnd);
      const toInsert = '\n' + targetText;
      let success = false;
      try {
        success = document.execCommand('insertText', false, toInsert);
      } catch (e) {}
      if (!success) {
        editor.value = val.substring(0, lineEnd) + toInsert + val.substring(lineEnd);
      }
      const shift = targetText.length + 1;
      editor.setSelectionRange(start + shift, end + shift);
    } else { // 'up'
      editor.setSelectionRange(lineStart, lineStart);
      const toInsert = targetText + '\n';
      let success = false;
      try {
        success = document.execCommand('insertText', false, toInsert);
      } catch (e) {}
      if (!success) {
        editor.value = val.substring(0, lineStart) + toInsert + val.substring(lineStart);
      }
      const shift = targetText.length + 1;
      editor.setSelectionRange(start + shift, end + shift);
    }

    onEditorInput(editor);
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }

  function executeDeleteLine(editor) {
    if (!editor) return;
    const val = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const { lineStart, lineEnd } = getLineBoundaries(val, start, end);

    let deleteStart = lineStart;
    let deleteEnd = lineEnd;
    if (deleteEnd < val.length && val[deleteEnd] === '\n') {
      deleteEnd += 1;
    } else if (deleteStart > 0 && val[deleteStart - 1] === '\n') {
      deleteStart -= 1;
    }

    editor.focus();
    editor.setSelectionRange(deleteStart, deleteEnd);
    let success = false;
    try {
      success = document.execCommand('delete');
    } catch (e) {}
    if (!success) {
      editor.value = val.substring(0, deleteStart) + val.substring(deleteEnd);
    }
    const newPos = Math.min(lineStart, editor.value.length);
    editor.setSelectionRange(newPos, newPos);

    onEditorInput(editor);
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }

  function executeInsertLine(editor, position) {
    if (!editor) return;
    const val = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;

    editor.focus();
    if (position === 'below') {
      let lineEnd = val.indexOf('\n', end);
      if (lineEnd === -1) lineEnd = val.length;
      editor.setSelectionRange(lineEnd, lineEnd);
      insertTextWithUndo('\n', editor);
    } else { // 'above'
      const lineStart = val.lastIndexOf('\n', start - 1) + 1;
      editor.setSelectionRange(lineStart, lineStart);
      insertTextWithUndo('\n', editor);
      editor.setSelectionRange(lineStart, lineStart);
    }

    onEditorInput(editor);
    hideCursorAura(true);
    triggerCursorAuraDebounced();
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
    // Scan lines lazily and stop at the first usable one: this runs on every
    // keystroke for auto-titled unsaved tabs, so splitting the whole note would
    // allocate an array proportional to the document on each key.
    let fallbackDateTitle = '';
    const len = text.length;
    let pos = 0;
    while (pos <= len) {
      const nl = text.indexOf('\n', pos);
      const end = (nl === -1) ? len : nl;
      let line = text.substring(pos, end).trim();
      pos = end + 1;
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
    const tabId = genReqId('tab_');
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
    if (isSplitMode && activePane === 'secondary') {
      selectSecondaryTab(tabId);
    } else {
      selectTab(tabId);
    }
    saveSessionDebounced();
    return newTab;
  }

  function updatePaneFocusClasses() {
    if (editorPane) {
      editorPane.classList.toggle('pane-focused', !isSplitMode || activePane === 'primary');
    }
    if (secondaryPane) {
      secondaryPane.classList.toggle('pane-focused', isSplitMode && activePane === 'secondary');
    }
  }

  function selectTab(tabId) {
    clearGhostText();
    if (activeTabId) {
      const prevTab = getTab(activeTabId);
      if (prevTab && editorEl) {
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
    activePane = 'primary';
    updatePaneFocusClasses();
    renderTabs();
    cachedLineCount = 0;
    updateLineNumbers();
    updateStatusBar();

    if (isPreviewMode) {
      renderPreview();
    }
    if (isSplitMode && secondaryViewMode === 'preview') {
      secondaryTabId = tabId;
      updateSecondaryPane();
    }
    saveSessionDebounced();
    hideCursorAura(true);
    triggerCursorAuraDebounced();

    if (window.backend && window.backend.watchActiveFile) {
      if (tab.path) {
        window.backend.watchActiveFile(tab.path);
      } else {
        window.backend.unwatchActiveFile();
      }
    }

    if (window.SlotAgent && window.SlotAgent.attachEditor) {
      window.SlotAgent.attachEditor(editorEl);
    }

    if (editorEl) {
      editorEl.focus();
    }
  }

  window.getCurrentTabPath = function () {
    const tab = getTab(activeTabId);
    return tab ? (tab.path || '') : '';
  };

  // Public resolver for sibling frontend modules (SlotAgent / JevAction) so they
  // route to the pane the user is actually in instead of always #editor.
  window.getActiveEditorEl = function () {
    return getActiveEditor();
  };

  function selectSecondaryTab(tabId) {
    clearGhostText();
    if (secondaryTabId) {
      const prevSecTab = getTab(secondaryTabId);
      if (prevSecTab && editorSecondary && secondaryViewMode === 'editor') {
        prevSecTab.content = editorSecondary.value;
        prevSecTab.cursorPos = editorSecondary.selectionStart;
      }
    }

    secondaryTabId = tabId;
    const tab = getTab(tabId);
    if (!tab) return;

    activePane = 'secondary';
    updateSecondaryPane();
    updatePaneFocusClasses();
    renderTabs();
    updateStatusBar();
    saveSessionDebounced();
    if (editorSecondary && secondaryViewMode === 'editor') {
      editorSecondary.focus();
    }
  }

  function handleTabClick(tabId, altKey = false) {
    if (altKey) {
      openSplitEditor(tabId);
      return;
    }
    if (!isSplitMode) {
      selectTab(tabId);
      editorEl.focus();
      return;
    }

    if (activePane === 'secondary') {
      if (tabId === secondaryTabId) {
        if (editorSecondary && secondaryViewMode === 'editor') editorSecondary.focus();
        updatePaneFocusClasses();
        renderTabs();
        updateStatusBar();
      } else {
        selectSecondaryTab(tabId);
      }
    } else {
      if (tabId === activeTabId) {
        editorEl.focus();
        updatePaneFocusClasses();
        renderTabs();
        updateStatusBar();
      } else {
        selectTab(tabId);
        editorEl.focus();
      }
    }
  }

  async function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = tabs[tabIndex];
    if (tab.isDirty) {
      const action = await confirmSaveDialog(tab.title);
      if (action === 'cancel') {
        return; // Cancel closing tab
      }
      if (action === 'save') {
        const saved = await saveTab(tab, false);
        if (!saved) {
          return; // Save was cancelled or failed, keep tab open
        }
      }
      // action === 'dontsave': proceed to discard changes and close tab
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
    scheduleMemoryTrim(1000);
  }

  function getTab(tabId) {
    return tabs.find(t => t.id === tabId);
  }

  // Get the currently focused editor element ('primary' or 'secondary')
  function getActiveEditor() {
    if (isSplitMode && activePane === 'secondary' && secondaryViewMode === 'editor' && editorSecondary) {
      return editorSecondary;
    }
    return editorEl;
  }

  // Get the tab corresponding to the currently active pane
  function getActiveTab() {
    if (isSplitMode && activePane === 'secondary' && secondaryTabId) {
      return getTab(secondaryTabId) || getTab(activeTabId);
    }
    return getTab(activeTabId);
  }

  let activeTabDrag = null;
  let contextMenuTargetTabId = null;

  // Refresh ONLY the active / split / focused classes of the already rendered
  // tab bar. Used from editor click & focus, where nothing that affects the
  // rendered tab bar changed: a full renderTabs() there threw away the DOM and
  // re-bound every per-tab listener on each click.
  function refreshTabActiveClasses() {
    if (!tabsListEl) return;
    const tabEls = tabsListEl.querySelectorAll('.tab-item');
    if (!tabEls || tabEls.length !== tabs.length) {
      renderTabs();
      return;
    }
    for (let i = 0; i < tabEls.length; i++) {
      const tabEl = tabEls[i];
      const tabId = tabEl.dataset ? tabEl.dataset.tabId : null;
      const isPrimary = tabId === activeTabId;
      const isSecondary = isSplitMode && tabId === secondaryTabId;
      const isFocused = isSplitMode
        ? (activePane === 'secondary' ? isSecondary : isPrimary)
        : isPrimary;

      if (isPrimary) tabEl.classList.add('active'); else tabEl.classList.remove('active');
      if (isSecondary) tabEl.classList.add('split-active'); else tabEl.classList.remove('split-active');
      if (isFocused) tabEl.classList.add('focused-tab'); else tabEl.classList.remove('focused-tab');
    }
  }

  function renderTabs() {
    tabsListEl.innerHTML = '';
    tabs.forEach((tab, index) => {
      const tabEl = document.createElement('div');
      const isPrimary = tab.id === activeTabId;
      const isSecondary = isSplitMode && tab.id === secondaryTabId;
      const isFocused = isSplitMode
        ? (activePane === 'secondary' ? isSecondary : isPrimary)
        : isPrimary;

      let cls = 'tab-item';
      if (isPrimary && isSecondary) {
        cls += ' active split-active';
      } else if (isPrimary) {
        cls += ' active';
      } else if (isSecondary) {
        cls += ' split-active';
      }
      if (isFocused) {
        cls += ' focused-tab';
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
            handleTabClick(tab.id, e.altKey);
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
      closeEl.title = t('closeTabTitle');
      closeEl.onclick = (e) => closeTab(tab.id, e);
      tabEl.appendChild(closeEl);

      tabsListEl.appendChild(tabEl);
    });
  }

  // Number of "\n" in text.substring(0, end) (the whole text when end is omitted). indexOf scans
  // natively: ~3.5x faster than a charCodeAt loop on a 3 MB note (1.1 ms vs 3.8 ms).
  function countNewlines(text, end) {
    const limit = end === undefined ? text.length : Math.min(end, text.length);
    let count = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < limit; i = text.indexOf('\n', i + 1)) count++;
    return count;
  }

  // Line-number gutter. The numbers are always 1..N, so adding or removing lines anywhere in the
  // note only changes the tail of the column. They are kept as blocks of GUTTER_BLOCK_LINES lines
  // ("1\n2\n...\n" in one <div> each) so that a change lays out one block instead of the whole
  // column: at 80,000 lines one text node cost ~200 ms per Enter, the blocks cost ~1 ms.
  const GUTTER_BLOCK_LINES = 1000;
  const lineGutters = new WeakMap(); // gutter element -> { blocks: [<div>], lines: rendered line count }

  // `rows` (from LineGutter.rowsFor) is how many screen rows each logical line takes when some lines
  // wrap; the number then sits on the line's first row and the wrapped rows stay blank. Without it
  // the gutter is the plain 1..N.
  function renderLineGutter(el, lines, rows) {
    let gutter = lineGutters.get(el);
    if (!gutter) {
      gutter = { blocks: [], lines: 0, wrapped: false, texts: [] };
      lineGutters.set(el, gutter);
      el.textContent = '';
    }
    if (rows) {
      const blockCount = Math.ceil(lines / GUTTER_BLOCK_LINES);
      while (gutter.blocks.length > blockCount) { el.removeChild(gutter.blocks.pop()); gutter.texts.pop(); }
      for (let b = 0; b < blockCount; b++) {
        const s = window.LineGutter.gutterBlockText(b * GUTTER_BLOCK_LINES, Math.min((b + 1) * GUTTER_BLOCK_LINES, lines), rows);
        if (b < gutter.blocks.length) {
          if (gutter.texts[b] !== s) gutter.blocks[b].textContent = s;
        } else {
          const block = document.createElement('div');
          block.textContent = s;
          el.appendChild(block);
          gutter.blocks.push(block);
        }
        gutter.texts[b] = s;
      }
      gutter.lines = lines;
      gutter.wrapped = true;
      return;
    }
    // Back to plain numbering after a wrapped layout: every block has to be rewritten.
    if (gutter.wrapped) { gutter.lines = 0; gutter.wrapped = false; gutter.texts = []; }
    if (lines === gutter.lines) return;

    const blockCount = Math.ceil(lines / GUTTER_BLOCK_LINES);
    while (gutter.blocks.length > blockCount) el.removeChild(gutter.blocks.pop());
    // Lines 1..min(old, new) are unchanged: start at the block that holds the first changed line.
    for (let b = Math.floor(Math.min(gutter.lines, lines) / GUTTER_BLOCK_LINES); b < blockCount; b++) {
      const last = Math.min((b + 1) * GUTTER_BLOCK_LINES, lines);
      let s = '';
      for (let n = b * GUTTER_BLOCK_LINES + 1; n <= last; n++) s += n + '\n';
      if (b < gutter.blocks.length) {
        gutter.blocks[b].textContent = s;
      } else {
        const block = document.createElement('div');
        block.textContent = s;
        el.appendChild(block);
        gutter.blocks.push(block);
      }
    }
    gutter.lines = lines;
  }

  // Ultra-Fast Zero-HTML Line Numbers
  function updateLineNumbers() {
    // Every place that sets the note's text itself (tab switch, replace, LLM merge...) passes through
    // here, so this is where the link underlines are told the text may have changed (a no-op unless
    // the note has links; the work happens once typing pauses).
    if (window.FileAnchor && window.FileAnchor.scheduleMarks) window.FileAnchor.scheduleMarks(editorEl);
    const lines = countNewlines(editorEl.value) + 1;
    const rows = lineRowsOf(editorEl);
    // Plain numbering only changes with the line count; a wrapped layout also changes when a line
    // wraps differently (typing, a resize, a zoom), so it is re-checked every time.
    if (!rows && lines === cachedLineCount && !isGutterWrapped(lineNumbersEl)) return;
    cachedLineCount = lines;
    renderLineGutter(lineNumbersEl, lines, rows);
  }

  // Screen rows per logical line, or null while nothing wraps (see line_gutter.js).
  function lineRowsOf(editor) {
    try {
      return window.LineGutter ? window.LineGutter.rowsFor(editor) : null;
    } catch (e) {
      return null;
    }
  }

  function isGutterWrapped(el) {
    const gutter = lineGutters.get(el);
    return !!(gutter && gutter.wrapped);
  }

  // Coalesce the full-buffer newline scan into one run per animation frame for
  // the typing paths. Call sites that must be correct synchronously (tab switch,
  // programmatic replace, scroll sync, LLM merge...) keep calling the immediate
  // updateLineNumbers() / updateSecondaryLineNumbers().
  let lineNumbersScheduled = false;
  function scheduleUpdateLineNumbers() {
    if (lineNumbersScheduled) return;
    lineNumbersScheduled = true;
    requestAnimationFrame(() => {
      lineNumbersScheduled = false;
      updateLineNumbers();
    });
  }

  let secondaryLineNumbersScheduled = false;
  function scheduleUpdateSecondaryLineNumbers() {
    if (secondaryLineNumbersScheduled) return;
    secondaryLineNumbersScheduled = true;
    requestAnimationFrame(() => {
      secondaryLineNumbersScheduled = false;
      updateSecondaryLineNumbers();
    });
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
    const editor = getActiveEditor();
    if (!editor) return;
    const text = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;

    // Ln/Col without copying + splitting the whole prefix on every keystroke.
    // Identical result: 1-based line, 1-based column in UTF-16 code units.
    const lineNum = 1 + countNewlines(text, start);
    // NB: lastIndexOf clamps a negative fromIndex to 0, so start === 0 must be
    // special-cased or a leading "\n" would report Col 0.
    const lastNewline = start > 0 ? text.lastIndexOf('\n', start - 1) : -1;
    const colNum = start - lastNewline;

    statCursor.textContent = t('lineCol', { line: lineNum, col: colNum });
    statChars.textContent = t('charCount', { count: text.length });

    const selLength = Math.abs(end - start);
    if (selLength > 0) {
      statSelection.textContent = t('selectionCount', { count: selLength });
      statSelection.classList.remove('hidden');
    } else {
      statSelection.classList.add('hidden');
    }

    const curTab = getActiveTab();
    if (curTab && statEncoding) {
      statEncoding.textContent = curTab.encoding || 'UTF-8';
    }

    if (statMode) {
      statMode.textContent = isHtmlDocument(text, curTab ? curTab.path : '') ? 'HTML' : 'Markdown';
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
      previewPane.innerHTML = '';
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      if (btnTogglePreview) {
        btnTogglePreview.classList.remove('active');
        btnTogglePreview.title = t('togglePreviewTitle');
      }
      editorEl.focus();
      triggerCursorAuraDebounced();
      scheduleMemoryTrim(1000);
    }
  }

  // --- Flexible Split View & Pane Management (VS Code Style) ---
  function applySplitRatio() {
    if (!isSplitMode) return;
    const pct = (splitRatio * 100).toFixed(2);
    editorPane.style.flex = `0 0 ${pct}%`;
    secondaryPane.style.flex = `1 1 0`;
    invalidateCharPixelMirrors();
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

    if (isSplitMode && secondaryTabId) {
      const prevSecTab = getTab(secondaryTabId);
      if (prevSecTab && editorSecondary && secondaryViewMode === 'editor') {
        prevSecTab.content = editorSecondary.value;
        prevSecTab.cursorPos = editorSecondary.selectionStart;
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

    activePane = 'secondary';
    updateSecondaryPane();
    updatePaneFocusClasses();
    renderTabs();
    editorSecondary.focus();
    saveSessionDebounced();
  }

  // Open Preview to the Side (Right Pane) with Smart Sync Scroll
  async function openPreviewToSide(tabId) {
    clearGhostText();
    if (isSplitMode && secondaryTabId) {
      const prevSecTab = getTab(secondaryTabId);
      if (prevSecTab && editorSecondary && secondaryViewMode === 'editor') {
        prevSecTab.content = editorSecondary.value;
        prevSecTab.cursorPos = editorSecondary.selectionStart;
      }
    }
    const targetTabId = tabId || activeTabId;
    secondaryTabId = targetTabId;
    secondaryViewMode = 'preview';
    isSplitMode = true;
    syncScrollEnabled = true;

    workspaceEl.classList.add('split-mode');
    secondaryPane.classList.remove('hidden');
    paneResizer.classList.remove('hidden');
    if (btnToggleSplit) btnToggleSplit.classList.add('active');

    if (secondaryEditorPane) secondaryEditorPane.classList.add('hidden');
    if (secondaryPreviewPane) secondaryPreviewPane.classList.remove('hidden');

    if (isPreviewMode) {
      isPreviewMode = false;
      previewPane.classList.add('hidden');
      editorPane.classList.remove('hidden');
      if (btnTogglePreview) btnTogglePreview.classList.remove('active');
    }

    await ensureRendererLibraries();
    activePane = 'primary';
    updateSecondaryPane();
    updatePaneFocusClasses();
    renderTabs();
    editorEl.focus();
    saveSessionDebounced();
  }

  function closeSecondaryPane() {
    if (secondaryTabId) {
      const secTab = getTab(secondaryTabId);
      if (secTab && editorSecondary && secondaryViewMode === 'editor') {
        secTab.content = editorSecondary.value;
        secTab.cursorPos = editorSecondary.selectionStart;
      }
    }
    isSplitMode = false;
    workspaceEl.classList.remove('split-mode');
    secondaryPane.classList.add('hidden');
    paneResizer.classList.add('hidden');
    editorPane.style.flex = '';
    if (secondaryPreviewPane) secondaryPreviewPane.innerHTML = '';
    if (btnToggleSplit) btnToggleSplit.classList.remove('active');
    activePane = 'primary';
    updatePaneFocusClasses();
    renderTabs();
    updateStatusBar();
    editorEl.focus();
    saveSessionDebounced();
    scheduleMemoryTrim(1000);
  }

  async function toggleSplitMode() {
    if (isSplitMode) {
      closeSecondaryPane();
    } else {
      await openSplitEditor();
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
      cachedSecondaryLineCount = 0;
      updateSecondaryLineNumbers();
    }

    applySplitRatio();
    updatePaneFocusClasses();
  }

  function updateSecondaryLineNumbers() {
    if (!isSplitMode || secondaryViewMode !== 'editor' || !editorSecondary || !secondaryLineNumbers) return;
    if (window.FileAnchor && window.FileAnchor.scheduleMarks) window.FileAnchor.scheduleMarks(editorSecondary);
    const lines = countNewlines(editorSecondary.value) + 1;
    const rows = lineRowsOf(editorSecondary);
    if (!rows && lines === cachedSecondaryLineCount && !isGutterWrapped(secondaryLineNumbers)) return;
    cachedSecondaryLineCount = lines;
    renderLineGutter(secondaryLineNumbers, lines, rows);
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

    // 1b. The marker lines a task run leaves in the note are bookkeeping: the preview shows the answer only
    if (window.AutoSelector && typeof window.AutoSelector.stripMarkers === 'function') {
      rawText = window.AutoSelector.stripMarkers(rawText);
    }

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
        // preview_images.js: decodes the percent-escapes markdown-it puts in `src` (a space in
        // "Application Support", non-ASCII file names) so /api/image gets the real path.
        const fullPath = window.PreviewImages.resolveLocalImagePath(img.getAttribute('src'), noteDir);
        if (fullPath === null) return;
        img.src = '/api/image?path=' + encodeURIComponent(fullPath);
      });
    } catch (e) {
      console.warn('Failed to resolve local preview images:', e);
    }

    // Render Mermaid diagrams on demand
    const mermaidCodeBlocks = targetPane.querySelectorAll('pre code.language-mermaid');
    if (mermaidCodeBlocks.length > 0) {
      ensureMermaidLibraries().then(() => {
        if (!window.mermaid) return;
        const tone = applyMermaidTone();
        mermaidCodeBlocks.forEach(async (block, idx) => {
          const diagramCode = block.textContent;
          const container = block.parentElement;
          const id = 'mermaid-svg-' + idx + '-' + Date.now();
          try {
            const { svg } = await window.mermaid.render(id, diagramCode);
            container.innerHTML = svg;
            window.MermaidTone.decorate(container, tone, t('mermaidToneToggle'), flipMermaidTone);
          } catch (err) {
            container.innerHTML = '<div class="mermaid-error" style="color:#f48771;">' + escapeHtml(t('mermaidError')) + escapeHtml(err.message) + '</div>';
          }
        });
      });
    }

    // 8. Linkify file paths to VS Code URI (Feature 5)
    linkifyVsCodePaths(targetPane, tabObj);
  }

  // Feature 5: Detect path/to/file.ext:line and convert to vscode:// URI links
  function linkifyVsCodePaths(container, tabObj) {
    if (!container) return;
    const pathRegex = /(?:^|[\s\(\[\'"])((?:[a-zA-Z]:[\\\/]|\/|\.\/|\.\.\/)?(?:[\w\.\-\_\\\/]+?\.[a-zA-Z0-9]+)):(\d+)(?::(\d+))?/g;

    let baseDir = lastPipedCwd || '';
    if (!baseDir && tabObj && tabObj.path) {
      baseDir = tabObj.path.replace(/[\\\/][^\\\/]+$/, '');
    }

    const elementsToProcess = container.querySelectorAll('p, li, blockquote, pre code');
    elementsToProcess.forEach(el => {
      if (el.querySelector('.vscode-jump-link')) return;

      const originalHtml = el.innerHTML;
      if (!originalHtml || originalHtml.indexOf(':') === -1) return;

      const updatedHtml = originalHtml.replace(pathRegex, (match, filePath, line) => {
        let cleanPath = filePath.trim();
        if (cleanPath.startsWith('http:') || cleanPath.startsWith('https:')) return match;

        let absPath = cleanPath;
        const isWindowsAbs = /^[a-zA-Z]:[\\\/]/.test(cleanPath);
        const isUnixAbs = cleanPath.startsWith('/');
        if (!isWindowsAbs && !isUnixAbs && baseDir) {
          absPath = baseDir.replace(/\\/g, '/') + '/' + cleanPath.replace(/\\/g, '/');
        }

        let vscodeUri = 'vscode://file/' + absPath.replace(/\\/g, '/') + ':' + line;
        const prefix = match.slice(0, match.indexOf(filePath));
        return `${prefix}<a href="${vscodeUri}" class="vscode-jump-link" title="Open in VS Code (${absPath}:${line})">${filePath}:${line}</a>`;
      });

      if (updatedHtml !== originalHtml) {
        el.innerHTML = updatedHtml;
      }
    });
  }

  async function renderPreview() {
    await ensureRendererLibraries();
    renderMarkdownContentTo(editorEl.value, previewPane, getActiveTab());
  }

  async function renderSecondaryPreview() {
    if (!isSplitMode || secondaryViewMode !== 'preview') return;
    const secTab = getTab(secondaryTabId) || getActiveTab();
    if (!secTab) return;
    await ensureRendererLibraries();
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
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('vscode://')) {
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

  // Kept byte-identical (aside from its name's casing) to jev_action.js's and
  // task_manager.js's escapeHTML() — see tests/escape_html_parity_test.mjs.
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Ghost Text & Autocomplete Engine
  let isAcceptingGhost = false;
  // The overlay mirrors the whole text before the caret so the suggestion lands
  // exactly on the real caret. Rebuilding it from an HTML string re-parsed and
  // re-laid-out a full copy of the note on every suggestion and on every
  // accepted word; keep the spans alive and write textContent instead.
  let ghostInnerEl = null;
  let ghostPrefixSpan = null;
  let ghostSuggestionSpan = null;
  let ghostPrefixText = '';
  let ghostGutter = 0;
  // The note the in-flight LLM suggestion was requested for (see __onAutocompleteResult).
  let pendingAutocomplete = null;

  function ghostSpansAttached() {
    return !!(ghostInnerEl && ghostInnerEl.parentElement === ghostOverlayEl &&
      ghostPrefixSpan && ghostPrefixSpan.parentElement === ghostInnerEl &&
      ghostSuggestionSpan && ghostSuggestionSpan.parentElement === ghostInnerEl);
  }

  function ensureGhostSpans() {
    if (!ghostOverlayEl) return false;
    if (ghostSpansAttached()) return true;
    ghostOverlayEl.innerHTML = '';
    ghostInnerEl = document.createElement('div');
    ghostPrefixSpan = document.createElement('span');
    ghostPrefixSpan.className = 'ghost-prefix';
    ghostSuggestionSpan = document.createElement('span');
    ghostSuggestionSpan.className = 'ghost-suggestion';
    ghostInnerEl.appendChild(ghostPrefixSpan);
    ghostInnerEl.appendChild(ghostSuggestionSpan);
    ghostOverlayEl.appendChild(ghostInnerEl);
    ghostPrefixText = '';
    return true;
  }

  // The overlay has to lay out and scroll exactly like the textarea, or the suggestion
  // lands away from the caret:
  //  * Scroll: the overlay only holds the text BEFORE the caret, so its own scroll range
  //    is shorter than the textarea's whenever the note continues below the caret.
  //    Assigning scrollTop gets clamped to that shorter range and draws the suggestion
  //    N lines too low (N = lines below the caret). The inner block is translated
  //    instead: a transform has no range to clamp against.
  //  * Width: a textarea with a vertical scrollbar wraps a scrollbar-width narrower than
  //    the scrollbar-less overlay, which shifts every wrapped line above the caret. The
  //    overlay reserves the same gutter.
  function syncGhostScroll() {
    if (!ghostInnerEl) return;
    ghostInnerEl.style.transform = `translate(${-editorEl.scrollLeft}px, ${-editorEl.scrollTop}px)`;
  }

  function syncGhostGutter() {
    const gutter = editorEl.offsetWidth - editorEl.clientWidth;
    if (gutter === ghostGutter) return;
    ghostGutter = gutter;
    ghostOverlayEl.style.right = `${gutter}px`;
  }

  function clearGhostText() {
    ghostSuggestion = '';
    activeImeSuggestion = null;
    if (!ghostOverlayEl) return;
    if (ghostSpansAttached()) {
      if (ghostPrefixText !== '') {
        ghostPrefixSpan.textContent = '';
        ghostPrefixText = '';
      }
      if (ghostSuggestionSpan.textContent !== '') {
        ghostSuggestionSpan.textContent = '';
      }
    } else {
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

    if (!ensureGhostSpans()) return;
    // Only touch the (huge) prefix node when it actually changed.
    if (prefix !== ghostPrefixText) {
      ghostPrefixSpan.textContent = prefix;
      ghostPrefixText = prefix;
    }
    if (ghostSuggestionSpan.textContent !== suggestion) {
      ghostSuggestionSpan.textContent = suggestion;
    }
    syncGhostGutter();
    syncGhostScroll();
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
    const isImeEnabled = !!(config.general && config.general.imeGuardian);
    if (!isImeEnabled || isPreviewMode || isComposing) {
      activeImeSuggestion = null;
      return false;
    }
    const guardian = getImeGuardian();
    if (!guardian) {
      activeImeSuggestion = null;
      return false;
    }

    const cursor = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    if (cursor !== end) {
      activeImeSuggestion = null;
      return false;
    }

    const suggestion = guardian.getRomajiSuggestion(editorEl.value, cursor, isImeEnabled);
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

    isAcceptingGhost = true;
    try {
      insertTextWithUndo(chunk);
    } finally {
      isAcceptingGhost = false;
    }

    const newCursor = editorEl.selectionStart;
    ghostSuggestion = remaining;
    ghostTargetCursor = newCursor;

    const curTab = getTab(activeTabId);
    if (curTab) {
      curTab.content = editorEl.value;
      curTab.isDirty = true;
    }

    if (!ghostSuggestion) {
      clearGhostText();
      onEditorInput(editorEl, curTab, false);
    } else {
      const textBefore = editorEl.value.substring(0, newCursor);
      renderGhostText(textBefore, ghostSuggestion);
      onEditorInput(editorEl, curTab, true); // skipAutocomplete = true
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

      const reqId = genReqId('ac_');
      currentAutocompleteReqId = reqId;
      pendingAutocomplete = { prefix, tabId: activeTabId };

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
    const asked = pendingAutocomplete;
    pendingAutocomplete = null;

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

    // A suggestion continues the note exactly as it was when it was requested. If the
    // caret or the text before it has changed since (Enter pressed, caret moved, note
    // switched), it no longer belongs at the caret: drawing it there is what put
    // "ございます" on the line below "おはよう". Drop it; the next pause asks again.
    const cursor = editorEl.selectionStart;
    if (!asked || asked.tabId !== activeTabId ||
        editorEl.selectionEnd !== cursor || cursor !== asked.prefix.length ||
        !editorEl.value.startsWith(asked.prefix)) {
      clearGhostText();
      return;
    }

    renderGhostText(asked.prefix, suggestion);
  };

  // --- LLM tasks: one engine for "send a prompt, swap an in-note anchor for the answer" (ask bar, Auto Selector) ---

  // Hosted services that always reject a keyless request (openAIHostNeedsKey + the Gemini endpoint in pkg/llm);
  // local servers (Ollama, LM Studio, a LAN box) work without a key.
  const LLM_KEY_HOSTS = ['googleapis.com', 'openai.com', 'groq.com', 'together.xyz', 'openrouter.ai'];

  // False when the built-in LLM cannot possibly answer (no model / URL, or a hosted service without a key).
  function isLlmConfigured(showToast) {
    const cfg = config.text || {};
    const baseUrl = String(cfg.baseUrl || '').trim().toLowerCase();
    const model = String(cfg.model || '').trim();
    let ok = !!baseUrl && !!model;
    if (ok && !String(cfg.apiKey || '').trim()) {
      ok = !(model.toLowerCase().indexOf('gemini') !== -1 || LLM_KEY_HOSTS.some((host) => baseUrl.indexOf(host) !== -1));
    }
    if (!ok && showToast) showMessage(t('askLlmNotConfigured'), 4500);
    return ok;
  }

  // Settings -> Integration -> Auto selector, with the defaults an old config (no such group) gets.
  function getAutoSelectorConfig() {
    const cfg = (config.autoSelector && typeof config.autoSelector === 'object') ? config.autoSelector : {};
    return {
      enabled: cfg.enabled !== false,
      agentConfirm: cfg.agentConfirm !== false
    };
  }

  // The live text of a note, wherever it is shown (null when the tab is gone).
  function getTabText(tabId) {
    const tab = getTab(tabId);
    if (!tab) return null;
    if (tabId === activeTabId && editorEl) return editorEl.value;
    if (isSplitMode && secondaryViewMode === 'editor' && tabId === secondaryTabId && editorSecondary) return editorSecondary.value;
    return tab.content || '';
  }

  function finishLlmTask(reqId, info, status, errorText) {
    if (!info || !info.isTask) return;
    if (window.TaskManager && window.TaskManager.updateTask) {
      window.TaskManager.updateTask(reqId, { status: status, error: errorText || undefined });
    }
    if (typeof info.onFinish === 'function') {
      try {
        info.onFinish(status);
      } catch (e) {
        console.warn('LLM task onFinish failed:', e);
      }
    }
  }

  // The text that replaces a task's anchor: the caller's wrapper (a throwing wrapper falls back to the plain text).
  // A failure is always one line: providers answer with multi-line JSON.
  function llmTaskReplacement(info, cleanedResult, errorText) {
    const message = errorText ? String(errorText).replace(/\s+/g, ' ').trim().substring(0, 300) : '';
    const fallback = errorText ? `[${t('llmError')}${message}]` : cleanedResult;
    const wrap = errorText ? info.wrapError : info.wrapResult;
    if (typeof wrap !== 'function') return fallback;
    try {
      const wrapped = wrap(errorText ? message : cleanedResult);
      return typeof wrapped === 'string' ? wrapped : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // Starts an LLM request whose answer replaces `anchorText` (already in the note) and lists it in the task panel.
  //   opts: { tabId, prompt, anchorText, label?, wrapResult?(text) -> string, wrapError?(message) -> string,
  //           cancelReplacement?: string (what a cancel leaves in place of the anchor, default ''),
  //           onFinish?(status: 'completed' | 'failed' | 'canceled') }
  // Returns the request id, or null when it cannot start.
  function startLlmTask(opts) {
    const o = opts || {};
    if (!o.tabId || !getTab(o.tabId) || !o.anchorText || typeof o.prompt !== 'string') return null;

    const reqId = genReqId('llm_');
    registerPendingLLMRequest(reqId, {
      tabId: o.tabId,
      anchorId: o.anchorText,
      isTask: true,
      wrapResult: o.wrapResult,
      wrapError: o.wrapError,
      cancelReplacement: typeof o.cancelReplacement === 'string' ? o.cancelReplacement : '',
      onFinish: o.onFinish
    });
    updateLLMIndicator();

    if (window.TaskManager && window.TaskManager.addTask) {
      window.TaskManager.addTask({
        id: reqId,
        type: 'llm',
        agent: 'LLM',
        instruction: String(o.label || o.prompt).replace(/\s+/g, ' ').trim().substring(0, 80),
        onCancel: () => cancelLlmTask(reqId)
      });
    }

    if (window.BuiltinAI && window.BuiltinAI.isPromptAPIAvailable()) {
      window.BuiltinAI.generateText(o.prompt).then((text) => {
        if (text !== null) {
          window.__onLLMResult(reqId, text, '');
        } else {
          dispatchLlmToBackend(reqId, o.prompt);
        }
      });
    } else {
      dispatchLlmToBackend(reqId, o.prompt);
    }
    return reqId;
  }

  // Shared by startLlmTask's real path and its browser-preview mock path (no window.backend at all).
  function dispatchLlmToBackend(reqId, prompt) {
    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, prompt, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `(LLM生成完了)\n> "${prompt}"\nについての回答です。`, '');
      }, 2500);
    }
  }

  // The request itself cannot be aborted on the Go side, so cancelling forgets it: the anchor goes away and the
  // late answer finds nothing waiting for it (see the pendingLLMRequests guard in __onLLMResult).
  function cancelLlmTask(reqId) {
    const info = pendingLLMRequests.get(reqId);
    if (!info || !info.isTask) return false;
    pendingLLMRequests.delete(reqId);
    clearPendingLLMTimer(reqId);
    updateLLMIndicator();

    const text = getTabText(info.tabId);
    if (text !== null && text.indexOf(info.anchorId) !== -1) {
      applyAnchorReplacement(info.tabId, info.anchorId, info.cancelReplacement || '');
    }
    finishLlmTask(reqId, info, 'canceled');
    showMessage(t('llmTaskCanceled'), 2500);
    return true;
  }

  // --- Command tasks (Auto selector: [[ $ command ]]): a shell command whose output replaces an anchor in the note ---

  // The command bar's safety gate, without touching the note: false when the command is refused (blocked, or a
  // warning the user declines); true when it may run (also when no validator is available).
  async function confirmCommand(cmd) {
    const cmdStr = String(cmd || '').trim();
    if (!cmdStr) return false;
    if (!window.backend || !window.backend.validateCliCommand) return true;
    try {
      const val = await window.backend.validateCliCommand(cmdStr);
      if (val && val.isBlocked) {
        showMessage(t('cliBlockedError', { reason: val.reason }), 6000);
        return false;
      }
      if (val && val.isWarning) {
        const proceed = await customConfirm(t('cliWarningConfirm', { reason: val.reason, cmd: cmdStr }));
        if (!proceed) {
          showMessage(t('cliCancelled'), 2000);
          return false;
        }
      }
    } catch (e) { /* the backend validates again when it runs the command */ }
    return true;
  }

  const pendingCommandTasks = new Map(); // reqId -> { isTask, tabId, anchorId, wrapResult, wrapError, cancelReplacement, onFinish, timer }
  const COMMAND_TASK_TIMEOUT_MS = 40000; // the backend stops a command after 30 s and always answers; this only guards a lost answer

  function settleCommandTask(reqId, result, errStr) {
    const info = pendingCommandTasks.get(reqId);
    if (!info) return;
    pendingCommandTasks.delete(reqId);
    clearTimeout(info.timer);
    if (window.__cliCallbacks) window.__cliCallbacks.delete(reqId);

    if (!getTab(info.tabId)) {
      finishLlmTask(reqId, info, 'canceled');
      return;
    }
    const code = result && typeof result.exitCode === 'number' ? result.exitCode : 0;
    const failed = !result || code !== 0;
    const message = String((!result ? errStr : (result.error || `exit code ${code}`)) || 'no response').replace(/\s+/g, ' ').trim().substring(0, 300);
    const fallback = failed ? `[${message}]` : String(result.output || '').trim();
    const wrap = failed ? info.wrapError : info.wrapResult;
    let replacement = fallback;
    if (typeof wrap === 'function') {
      try {
        const wrapped = failed ? wrap(message, result || null) : wrap(result);
        if (typeof wrapped === 'string') replacement = wrapped;
      } catch (e) { /* the plain text stays */ }
    }
    applyAnchorReplacement(info.tabId, info.anchorId, replacement);
    finishLlmTask(reqId, info, failed ? 'failed' : 'completed', failed ? message : undefined);
    showMessage(failed ? t('cliError', { err: message }) : t('autoSelCommandDone'), failed ? 5000 : 3000);
  }

  // Runs opts.command with no input and, when it ends, replaces opts.anchorText (already in the note) with the answer.
  //   opts: { tabId, command, anchorText, label?, wrapResult?(result) -> string, wrapError?(message, result|null) -> string,
  //           cancelReplacement?: string (what a cancel leaves in place of the anchor, default ''),
  //           onFinish?(status: 'completed' | 'failed' | 'canceled') }
  //   result is { output, error, exitCode }; wrapResult is called for exit code 0, wrapError for anything else.
  // Returns the request id, or null when it cannot start (the note is left alone). Desktop app only.
  function runCommandTask(opts) {
    const o = opts || {};
    const command = typeof o.command === 'string' ? o.command.trim() : '';
    if (!o.tabId || !getTab(o.tabId) || !o.anchorText || !command) return null;
    if (!window.backend || !window.backend.runCommandFilterAsync) {
      showMessage(t('autoSelCommandNativeOnly'), 4500);
      return null;
    }

    const reqId = genReqId('cmdtask_');
    const info = {
      isTask: true,
      tabId: o.tabId,
      anchorId: o.anchorText,
      wrapResult: o.wrapResult,
      wrapError: o.wrapError,
      cancelReplacement: typeof o.cancelReplacement === 'string' ? o.cancelReplacement : '',
      onFinish: o.onFinish,
      timer: null
    };
    pendingCommandTasks.set(reqId, info);
    window.__cliCallbacks.set(reqId, (result, errStr) => settleCommandTask(reqId, result, errStr));
    info.timer = setTimeout(() => settleCommandTask(reqId, null, t('autoSelCommandTimeout')), COMMAND_TASK_TIMEOUT_MS);

    if (window.TaskManager && window.TaskManager.addTask) {
      window.TaskManager.addTask({
        id: reqId,
        type: 'command',
        agent: t('autoSelCommandLabel'),
        instruction: String(o.label || command).replace(/\s+/g, ' ').trim().substring(0, 80),
        onCancel: () => cancelCommandTask(reqId)
      });
    }

    try {
      const started = window.backend.runCommandFilterAsync(reqId, command, '');
      if (started && typeof started.catch === 'function') {
        started.catch((err) => settleCommandTask(reqId, null, (err && err.message) || String(err)));
      }
    } catch (err) {
      settleCommandTask(reqId, null, (err && err.message) || String(err));
    }
    return reqId;
  }

  // Stops the command, removes the anchor and forgets the task: the answer that may still arrive finds no callback.
  function cancelCommandTask(reqId) {
    const info = pendingCommandTasks.get(reqId);
    if (!info) return false;
    pendingCommandTasks.delete(reqId);
    clearTimeout(info.timer);
    if (window.__cliCallbacks) window.__cliCallbacks.delete(reqId);
    if (window.backend && window.backend.cancelCommandFilter) {
      try {
        window.backend.cancelCommandFilter(reqId);
      } catch (e) { /* already finished */ }
    }
    const text = getTabText(info.tabId);
    if (text !== null && text.indexOf(info.anchorId) !== -1) {
      applyAnchorReplacement(info.tabId, info.anchorId, info.cancelReplacement || '');
    }
    finishLlmTask(reqId, info, 'canceled');
    showMessage(t('autoSelCommandCanceled'), 2500);
    return true;
  }

  // Vision / Image LLM Query (Gemini Flash Lite)
  async function triggerClipboardImageOCR(imageFileOrBlob, targetEditor) {
    const editor = targetEditor || getActiveEditor();
    let imgData = null;

    if (imageFileOrBlob) {
      imgData = await convertBlobToBase64(imageFileOrBlob);
    } else {
      imgData = await getClipboardImage();
    }

    if (!imgData) {
      showMessage(t('noImageClipboard'), 3000);
      return;
    }

    const curTab = getActiveTab();
    if (!curTab) return;

    const reqId = genReqId('vision_');
    const anchorId = `[${t('ocrTranscribingAnchor')}]`;

    const insertPos = editor.selectionEnd;
    editor.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion, editor);

    curTab.content = editor.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    registerPendingLLMRequest(reqId, {
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

  // Register a pending LLM request together with its watchdog timer.
  // Mirrors the per-request timer used by jev_action.js's jevExecuteAsync.
  function registerPendingLLMRequest(reqId, info) {
    pendingLLMRequests.set(reqId, info);
    clearPendingLLMTimer(reqId);
    llmRequestTimers.set(reqId, setTimeout(() => {
      llmRequestTimers.delete(reqId);
      if (!pendingLLMRequests.has(reqId)) return;
      // Resolve through the normal result path so the anchor is restored /
      // replaced and the indicator clears exactly as on a backend error.
      window.__onLLMResult(reqId, '', t('llmTimeout'));
    }, LLM_REQUEST_TIMEOUT_MS));
  }

  function clearPendingLLMTimer(reqId) {
    if (llmRequestTimers.has(reqId)) {
      clearTimeout(llmRequestTimers.get(reqId));
      llmRequestTimers.delete(reqId);
    }
  }

  function updateLLMIndicator() {
    if (pendingLLMRequests.size === 0) {
      statLlmIndicator.classList.add('hidden');
    } else {
      statLlmIndicator.classList.remove('hidden');
      statLlmText.textContent = t('llmProcessingWithCount', { count: pendingLLMRequests.size });
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

  // markdownOnly: for free-form answers, where an untagged or ```text fence may be a real code
  // block the user asked for. Only a wrapper explicitly tagged markdown/md is removed.
  function stripMarkdownCodeFences(text, markdownOnly) {
    if (!text || typeof text !== 'string') return text;
    let s = text.trim();
    if (!s.startsWith('```')) return s;

    const lines = s.split('\n');
    if (lines.length < 2) return s;

    const firstLine = lines[0].trim();
    const lastLine = lines[lines.length - 1].trim();

    if (firstLine.startsWith('```') && lastLine === '```') {
      const lang = firstLine.replace(/^```/, '').trim().toLowerCase();
      const isMarkdownTag = lang === 'markdown' || lang === 'md';
      if (isMarkdownTag || (!markdownOnly && (lang === '' || lang === 'text'))) {
        const inner = lines.slice(1, lines.length - 1);
        if (markdownOnly && !fencesAreNested(inner)) return s;
        return inner.join('\n').trim();
      }
    }
    return s;
  }

  // False when the first line's fence is closed early and another block follows
  // ("```markdown ... ``` prose ```python ... ```"): that is two blocks, not a wrapper.
  function fencesAreNested(innerLines) {
    let open = false;
    for (const line of innerLines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('```')) continue;
      if (open && trimmed !== '```') return false;
      open = !open;
    }
    return !open;
  }

  function cleanAICorrectionResult(rawText) {
    if (!rawText) return '';
    let s = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (s.includes('<think>')) {
      s = s.substring(0, s.indexOf('<think>'));
    }
    s = s.trim();

    const introPatterns = [
      /^Here is the corrected text:\s*/i,
      /^Corrected text:\s*/i,
      /^Corrected version:\s*/i,
      /^Here's the corrected text:\s*/i,
      /^修正後のテキスト[：:]\s*/,
      /^修正結果[：:]\s*/,
      /^修正後[：:]\s*/
    ];
    for (const pat of introPatterns) {
      s = s.replace(pat, '').trim();
    }

    s = stripMarkdownCodeFences(s);

    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
        (s.startsWith('「') && s.endsWith('」') && s.length >= 2)) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  // Global callback invoked by Go when background LLM finishes
  window.__onLLMResult = function (reqId, resultText, errorText) {
    const reqInfo = pendingLLMRequests.get(reqId);
    if (!reqInfo) return;

    pendingLLMRequests.delete(reqId);
    clearPendingLLMTimer(reqId);
    updateLLMIndicator();

    const targetTab = getTab(reqInfo.tabId);
    if (!targetTab) {
      finishLlmTask(reqId, reqInfo, 'canceled');
      return;
    }

    let cleanedResult = resultText || '';
    cleanedResult = cleanedResult.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (cleanedResult.includes('<think>')) {
      cleanedResult = cleanedResult.substring(0, cleanedResult.indexOf('<think>'));
    }
    cleanedResult = cleanedResult.trim();

    let isRollback = false;
    if (reqInfo.isCorrection) {
      cleanedResult = cleanAICorrectionResult(cleanedResult);
      if (errorText || !cleanedResult || cleanedResult.trim() === '') {
        // Zero Data Loss: safely rollback to the original text
        cleanedResult = reqInfo.originalText || '';
        isRollback = true;
      }
    } else if (reqId.startsWith('vision_') || reqId.startsWith('ocr_')) {
      cleanedResult = stripMarkdownCodeFences(cleanedResult);
    } else {
      cleanedResult = stripMarkdownCodeFences(cleanedResult, true);
    }

    const replacement = reqInfo.isTask
      ? llmTaskReplacement(reqInfo, cleanedResult, errorText)
      : ((errorText && !reqInfo.isCorrection) ? `[${t('llmError')}${errorText}]` : cleanedResult);

    applyAnchorReplacement(reqInfo.tabId, reqInfo.anchorId, replacement);
    finishLlmTask(reqId, reqInfo, errorText ? 'failed' : 'completed', errorText);

    if (reqInfo.isCorrection) {
      if (isRollback) {
        showMessage(t('aiCorrectionRestored'), 4000);
      } else {
        showMessage(t('aiCorrectionSuccess'), 3000);
      }
    } else if (errorText) {
      showMessage(`${t('llmError')}${errorText}`, 5000);
    } else {
      showMessage(t('llmResponseInserted'), 3000);
    }
  };

  // File Operations (Save as-is / Export Plain Text / Open)
  async function saveTab(tab, forceSaveAs) {
    if (!tab) return false;
    if (tab.id === activeTabId && editorEl) {
      tab.content = editorEl.value;
    } else if (isSplitMode && tab.id === secondaryTabId && editorSecondary && secondaryViewMode === 'editor') {
      tab.content = editorSecondary.value;
    }

    if (!window.backend) {
      tab.isDirty = false;
      renderTabs();
      showMessage('Saved (Web Mock)', 2000);
      return true;
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
          return true;
        }
        return false; // User cancelled Save As dialog
      } else {
        await window.backend.saveFile(tab.path, tab.content, tab.encoding);
        tab.isDirty = false;
        renderTabs();
        showMessage(`${t('saveSuccess')}${tab.title}`, 2000);
        return true;
      }
    } catch (e) {
      showMessage(`${t('saveError')}${e.message || e}`, 4000);
      return false;
    }
  }

  async function saveActiveFile(forceSaveAs) {
    return saveTab(getActiveTab(), forceSaveAs);
  }

  // Schedules a debounced autosave for a SPECIFIC tab (captured at schedule time,
  // not "whatever is active" when the timer fires). Callers pass their own timer
  // handle (one per pane) so typing in one pane never cancels a pending save in
  // the other. Returns the new timer handle to store back into that pane's variable.
  function scheduleAutoSave(tab, currentTimer) {
    clearTimeout(currentTimer);
    return setTimeout(() => {
      // Re-validate: the tab may have been closed, saved, or emptied of its
      // path in the time between scheduling and firing.
      if (getTab(tab.id) === tab && tab.isDirty && tab.path) {
        saveTab(tab, false);
      }
    }, 1500);
  }

  // Explicit Plain Text Export (.txt with stripped markdown formatting)
  async function exportPlainText() {
    const tab = getActiveTab();
    if (!tab) return;
    const editor = getActiveEditor();
    if (editor) tab.content = editor.value;

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

  function renderAutosaveStatus() {
    if (!statAutosave) return;
    const on = !!(config.general && config.general.autoSave);
    statAutosave.textContent = on ? t('statAutosaveOn') : t('statAutosaveOff');
    statAutosave.title = on ? t('statAutosaveTooltip') : t('statAutosaveOffTooltip');
    statAutosave.style.opacity = on ? '1' : '0.6';
  }

  function voiceRefineEnabled() {
    return !(config.voice && config.voice.refine && config.voice.refine.enabled === false);
  }

  // The second stage of voice input (tidying the transcript, speak-to-edit) as a status badge, like Predict / Autosave.
  function renderVoiceRefineStatus() {
    if (!statVoiceRefine) return;
    const on = voiceRefineEnabled();
    statVoiceRefine.textContent = on ? t('statVoiceRefineOn') : t('statVoiceRefineOff');
    statVoiceRefine.title = on ? t('statVoiceRefineTooltip') : t('statVoiceRefineOffTooltip');
    statVoiceRefine.style.opacity = on ? '1' : '0.6';
  }

  function toggleVoiceRefine() {
    if (!config.voice) config.voice = {};
    config.voice.refine = Object.assign({ model: 'gemini-flash-lite-latest', timeoutSec: 5 }, config.voice.refine, { enabled: !voiceRefineEnabled() });
    renderVoiceRefineStatus();
    showMessage(t(config.voice.refine.enabled ? 'voiceRefineOnToast' : 'voiceRefineOffToast'), 2500);
    savePersistentConfig();
  }

  function toggleAutoSave() {
    config.general.autoSave = !config.general.autoSave;
    renderAutosaveStatus();
    clearTimeout(autoSaveTimerPrimary);
    clearTimeout(autoSaveTimerSecondary);
    autoSaveTimerPrimary = null;
    autoSaveTimerSecondary = null;
    if (config.general.autoSave) {
      // Pick up edits made while autosave was off, in both panes independently
      const primaryTab = getTab(activeTabId);
      if (primaryTab && primaryTab.path && primaryTab.isDirty) {
        autoSaveTimerPrimary = scheduleAutoSave(primaryTab, autoSaveTimerPrimary);
      }
      if (isSplitMode && secondaryViewMode === 'editor' && secondaryTabId && secondaryTabId !== activeTabId) {
        const secTab = getTab(secondaryTabId);
        if (secTab && secTab.path && secTab.isDirty) {
          autoSaveTimerSecondary = scheduleAutoSave(secTab, autoSaveTimerSecondary);
        }
      }
    }
    const cfgAutosaveEl = document.getElementById('cfg-autosave');
    if (cfgAutosaveEl) cfgAutosaveEl.checked = config.general.autoSave;
    savePersistentConfig();
  }

  function toggleIME() {
    config.general.imeGuardian = !config.general.imeGuardian;
    if (statIme) {
      statIme.textContent = config.general.imeGuardian ? t('statImeOn') : t('statImeOff');
      statIme.style.opacity = config.general.imeGuardian ? '1' : '0.6';
    }
    if (!config.general.imeGuardian && imeGuardianInstance) {
      imeGuardianInstance.reset();
    }
    savePersistentConfig();
  }

  function updateActionStatus() {
    if (!statAction) return;
    if (!config.action) {
      config.action = {
        enabled: true,
        manualOnly: false,
        delaySec: 1.5,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'jev-latest',
        apiKey: ''
      };
    }
    const isEn = config.action.enabled !== false;
    const isManual = isEn && !!config.action.manualOnly;
    if (isManual) {
      // Naming the actual key to press (its configured shortcut, not a static "Ctrl+J") is
      // more directly actionable than a plain "Manual" label, and stays correct if the user
      // rebinds quickActions.
      const manualKey = getShortcutDisplay('quickActions', isMac ? 'Cmd+J' : 'Ctrl+J');
      statAction.textContent = t('statActionManual', { key: manualKey });
      statAction.title = t('statActionManualTooltip', { key: manualKey });
      statAction.style.opacity = '1';
    } else {
      statAction.textContent = isEn ? t('statActionOn') : t('statActionOff');
      statAction.title = isEn ? t('statActionTooltip') : t('statActionOffTooltip');
      statAction.style.opacity = isEn ? '1' : '0.6';
    }
    if (window.JevAction && window.JevAction.updateConfig) {
      window.JevAction.updateConfig({
        enabled: isEn,
        manualOnly: !!config.action.manualOnly,
        delaySec: typeof config.action.delaySec === 'number' ? config.action.delaySec : 1.5
      });
    } else if (window.JevAction && window.JevAction.setEnabled) {
      window.JevAction.setEnabled(isEn);
    }
  }

  // Cycles the status-bar Quick Actions badge through its three real states, in order from
  // most to least active: On (auto-suggest) -> Manual (Ctrl+J only, no auto-popup) -> Off
  // (disabled entirely) -> back to On. Mirrors the same enabled/manualOnly pair the settings
  // modal's two checkboxes control (see updateQuickActionsFieldStates), so both stay in sync.
  function cycleActionStatus() {
    if (!config.action) {
      config.action = {
        enabled: true,
        manualOnly: false,
        delaySec: 1.5,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'jev-latest',
        apiKey: ''
      };
    }
    const isEn = config.action.enabled !== false;
    const isManual = isEn && !!config.action.manualOnly;

    if (isEn && !isManual) {
      // On -> Manual
      config.action.manualOnly = true;
    } else if (isManual) {
      // Manual -> Off
      config.action.enabled = false;
      config.action.manualOnly = false;
    } else {
      // Off -> On
      config.action.enabled = true;
      config.action.manualOnly = false;
    }

    updateActionStatus();

    const cfgActEnabledEl = document.getElementById('cfg-action-enabled');
    if (cfgActEnabledEl) cfgActEnabledEl.checked = config.action.enabled !== false;
    const cfgActManualOnlyEl = document.getElementById('cfg-action-manual-only');
    if (cfgActManualOnlyEl) cfgActManualOnlyEl.checked = !!config.action.manualOnly;
    // Keep the settings modal's muted/disabled field states correct if it happens to be open.
    if (typeof updateQuickActionsFieldStates === 'function') updateQuickActionsFieldStates();

    savePersistentConfig();
  }

  function insertDateAtCursor() {
    const editor = getActiveEditor();
    const dateStr = getFormattedDateTime('standard');
    insertTextWithUndo(dateStr, editor);
    onEditorInput();
  }

  function showMessage(msg, duration) {
    statMessage.textContent = msg;
    statMessage.title = msg;
    setTimeout(() => {
      if (statMessage.textContent === msg) {
        statMessage.textContent = '';
        statMessage.title = '';
      }
    }, duration || 2500);
  }
  // Exposed so slot_agent.js / jev_action.js can surface their own status toasts
  // (e.g. "no slot found" / "already running") through the same status-bar message
  // area, the same way getCharPixelCoords / getActiveEditorEl are shared.
  window.showMessage = showMessage;

  // Event Listeners
  function onEditorInput(targetEditor, targetTab, skipAutocomplete = false) {
    const editor = targetEditor || getActiveEditor();
    const tab = targetTab || (editor === editorSecondary ? getTab(secondaryTabId) : getTab(activeTabId));
    if (tab && editor) {
      tab.content = editor.value;
      if (!tab.isDirty) {
        tab.isDirty = true;
        const activeTabEl = tabsListEl.querySelector(`.tab-item[data-tab-id="${tab.id}"]`);
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
        const newTitle = deriveTitleFromContent(editor.value);
        if (newTitle && tab.title !== `${newTitle}.md`) {
          tab.title = `${newTitle}.md`;
          if (isSplitMode && secondaryTabId === tab.id && secondaryPaneTitle) {
            secondaryPaneTitle.textContent = tab.title;
          }
          const activeTabEl = tabsListEl.querySelector(`.tab-item[data-tab-id="${tab.id}"]`);
          if (activeTabEl) {
            const titleEl = activeTabEl.querySelector('.tab-title');
            if (titleEl) titleEl.textContent = tab.title;
          }
        }
      }

      // Sync between primary and secondary editor if editing the same note
      if (isSplitMode && secondaryViewMode === 'editor' && secondaryTabId === activeTabId) {
        if (editor === editorEl && editorSecondary && editorSecondary.value !== editorEl.value) {
          editorSecondary.value = editorEl.value;
          scheduleUpdateSecondaryLineNumbers();
        } else if (editor === editorSecondary && editorEl && editorEl.value !== editorSecondary.value) {
          editorEl.value = editorSecondary.value;
          scheduleUpdateLineNumbers();
        }
      }
    }
    if (editor === editorSecondary) {
      scheduleUpdateSecondaryLineNumbers();
    } else {
      scheduleUpdateLineNumbers();
    }
    scheduleUpdateStatusBar();
    triggerZenModeActive();
    triggerAmbientContextDebounced();

    // Auto-save debouncing. Each pane has its own timer (keyed off which editor
    // fired this handler) so typing in one pane cannot cancel a pending save in
    // the other, and the tab being saved is the one captured here, not whatever
    // happens to be "active" 1.5s from now.
    if (config.general.autoSave && tab && tab.path) {
      if (editor === editorSecondary) {
        autoSaveTimerSecondary = scheduleAutoSave(tab, autoSaveTimerSecondary);
      } else {
        autoSaveTimerPrimary = scheduleAutoSave(tab, autoSaveTimerPrimary);
      }
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

    // Schedule background memory trimming when editing idles
    scheduleMemoryTrim();
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
    activePane = 'primary';
    updatePaneFocusClasses();
    if (isAcceptingGhost) {
      onEditorInput(editorEl, getTab(activeTabId), true);
    } else {
      onEditorInput(editorEl, getTab(activeTabId), false);
    }
    hideCursorAura(false);
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('keyup', () => {
    scheduleUpdateStatusBar();
    if (activeImeSuggestion && editorEl.selectionStart !== activeImeSuggestion.endPos) {
      clearGhostText();
    } else if (ghostSuggestion && !activeImeSuggestion && editorEl.selectionStart !== ghostTargetCursor) {
      // Arrow keys / Home / End moved the caret away: the suggestion stays where it was
      // drawn and can no longer be accepted, so take it down instead of leaving it behind.
      clearGhostText();
    }
    if (ghostSuggestion) syncGhostScroll();
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('click', () => {
    activePane = 'primary';
    updatePaneFocusClasses();
    clearGhostText();
    refreshTabActiveClasses();
    updateStatusBar();
    triggerCursorAuraDebounced();
  });
  // Voice rescue-anchor clicks (retry/save/discard) and file-anchor Ctrl/Cmd+Click (open) /
  // Alt+Click (reveal) both bail out immediately unless the caret landed on something they
  // recognize, so this costs nothing on an ordinary click.
  editorEl.addEventListener('click', (e) => {
    if (window.VoiceInput && window.VoiceInput.handleEditorClick(editorEl, e)) { e.preventDefault(); return; }
    if (window.FileAnchor && window.FileAnchor.handleEditorClick(editorEl, e)) { e.preventDefault(); }
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
    if (ghostSuggestion) syncGhostScroll();
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  });
  editorEl.addEventListener('focus', () => {
    activePane = 'primary';
    updatePaneFocusClasses();
    refreshTabActiveClasses();
    updateStatusBar();
    triggerCursorAuraDebounced();
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
        if (!secTab.isDirty) {
          secTab.isDirty = true;
          const secTabEl = tabsListEl.querySelector(`.tab-item[data-tab-id="${secondaryTabId}"]`);
          if (secTabEl && !secTabEl.querySelector('.tab-dirty-dot')) {
            const dotEl = document.createElement('span');
            dotEl.className = 'tab-dirty-dot';
            dotEl.textContent = '●';
            const titleEl = secTabEl.querySelector('.tab-title');
            if (titleEl) titleEl.after(dotEl);
          }
        }

        // Zero-Taxonomy: If tab is unfiled/untitled, update tab title dynamically from 1st line
        if (secTab.isAutoTitle && !secTab.path) {
          const newTitle = deriveTitleFromContent(editorSecondary.value);
          if (newTitle && secTab.title !== `${newTitle}.md`) {
            secTab.title = `${newTitle}.md`;
            if (secondaryPaneTitle) {
              secondaryPaneTitle.textContent = secTab.title;
            }
            const secTabEl = tabsListEl.querySelector(`.tab-item[data-tab-id="${secondaryTabId}"]`);
            if (secTabEl) {
              const titleEl = secTabEl.querySelector('.tab-title');
              if (titleEl) titleEl.textContent = secTab.title;
            }
          }
        }
      }
      if (secondaryTabId === activeTabId) {
        editorEl.value = editorSecondary.value;
        cachedLineCount = 0;
        scheduleUpdateLineNumbers();
        if (isPreviewMode) {
          renderPreview();
        }
      }
      scheduleUpdateSecondaryLineNumbers();
      scheduleUpdateStatusBar();
      triggerCursorAuraDebounced();

      // Auto-save debouncing for secondary editor (its own timer; see scheduleAutoSave)
      if (config.general.autoSave && secTab && secTab.path) {
        autoSaveTimerSecondary = scheduleAutoSave(secTab, autoSaveTimerSecondary);
      }

      saveSessionDebounced();
    });

    editorSecondary.addEventListener('scroll', () => {
      if (secondaryLineNumbers) {
        secondaryLineNumbers.scrollTop = editorSecondary.scrollTop;
      }
      hideCursorAura(true);
      triggerCursorAuraDebounced();
    });

    editorSecondary.addEventListener('focus', () => {
      activePane = 'secondary';
      updatePaneFocusClasses();
      refreshTabActiveClasses();
      updateStatusBar();
      triggerCursorAuraDebounced();
    });

    editorSecondary.addEventListener('click', () => {
      activePane = 'secondary';
      updatePaneFocusClasses();
      refreshTabActiveClasses();
      updateStatusBar();
      triggerCursorAuraDebounced();
    });
    editorSecondary.addEventListener('click', (e) => {
      if (window.VoiceInput && window.VoiceInput.handleEditorClick(editorSecondary, e)) { e.preventDefault(); return; }
      if (window.FileAnchor && window.FileAnchor.handleEditorClick(editorSecondary, e)) { e.preventDefault(); }
    });

    editorSecondary.addEventListener('keyup', () => {
      activePane = 'secondary';
      scheduleUpdateStatusBar();
      triggerCursorAuraDebounced();
    });

    editorSecondary.addEventListener('select', () => {
      scheduleUpdateStatusBar();
      triggerCursorAuraDebounced();
    });

    editorSecondary.addEventListener('blur', () => {
      hideCursorAura(true);
    });

    // Tab / Shift+Tab indent-unindent parity with the primary editor (see
    // applyTabIndent()). Ghost text / IME suggestion acceptance is deliberately
    // NOT wired here: that overlay (#ghost-overlay) only ever renders over the
    // primary pane, so there is nothing for the secondary pane to accept.
    editorSecondary.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        applyTabIndent(editorSecondary, e);
      }
    });

    editorSecondary.addEventListener('paste', (e) => handleEditorPaste(e, editorSecondary));
  }

  // Intercepts paste on either editor pane: normal image paste -> OCR (unchanged), special
  // paste (Ctrl/Cmd+Shift+V, armed by the global keydown handler) -> HTML-to-Markdown or
  // save-image-to-assets. Plain text is left to the browser/textarea in both cases (a
  // textarea already only ever holds plain text).
  async function handleEditorPaste(e, editor) {
    clearGhostText();
    hideCursorAura(true);
    triggerCursorAuraDebounced();

    const special = (Date.now() - specialPasteArmedAt) < SPECIAL_PASTE_WINDOW_MS;
    if (special) specialPasteArmedAt = 0;

    const cd = e.clipboardData;
    let types = cd && cd.types ? Array.from(cd.types) : [];
    let imageItem = null;
    if (cd && cd.items) {
      for (const item of cd.items) {
        if (item.type && item.type.indexOf('image/') === 0) { imageItem = item; break; }
      }
    }

    const ocrOn = !!(config.general && config.general.pasteImageOcr);
    const htmlAsMarkdown = !(config.general && config.general.pasteHtmlAsMarkdown === false);
    // Only a plain Ctrl+V needs to know whether the HTML is worth converting (and where it came from)
    const structured = htmlAsMarkdown && !special && types.indexOf('text/html') !== -1 &&
      !!(window.HtmlToMd && window.HtmlToMd.hasStructure && window.HtmlToMd.hasStructure(cd.getData('text/html') || ''));
    const action = decidePasteAction({
      special: special,
      types: types,
      hasImage: !!imageItem,
      ocrEnabled: ocrOn,
      visionReady: isVisionConfigured(),
      htmlAsMarkdown: htmlAsMarkdown,
      structured: structured,
      editorOrigin: types.indexOf('vscode-editor-data') !== -1,
      canReadClipboard: !!(navigator.clipboard && navigator.clipboard.read)
    });

    if (action === 'ocr') {
      const file = imageItem.getAsFile();
      if (file) {
        e.preventDefault();
        triggerClipboardImageOCR(file, editor);
      }
      return;
    }

    if (action === 'saveImage') {
      // A normal paste gets here when the picture cannot be transcribed: it is kept as a file (like Mobile Drop does) and
      // the message says why.
      const why = special ? 'pasteImageSaved' : (ocrOn ? 'pasteImageSavedNoVision' : 'pasteImageSavedOcrOff');
      await savePastedImage(e, imageItem, editor, why);
      return;
    }

    if (action === 'htmlToMd') {
      const markdown = window.HtmlToMd ? window.HtmlToMd.convert(cd.getData('text/html') || '') : '';
      const onlyAnImage = /^!\[[^\]]*\]\([^)]*\)$/.test(markdown.trim());
      if (imageItem && (!markdown.trim() || onlyAnImage)) {
        await savePastedImage(e, imageItem, editor);
        return;
      }
      if (!markdown.trim()) return; // default plain-text paste
      e.preventDefault();
      insertPastedText(markdown, editor, 'pasteHtmlConverted');
      return;
    }

    if (action === 'readClipboard') {
      // Chromium's "paste as plain text" event carries no picture and no text/html; the async
      // clipboard API still sees them. preventDefault must happen before the first await.
      const plain = cd ? cd.getData('text/plain') : '';
      e.preventDefault();
      let html = '';
      let imageBlob = null;
      let readFailed = false;
      try {
        const items = await navigator.clipboard.read();
        for (const clipItem of items) {
          const kinds = clipItem.types || [];
          const imageType = kinds.find((k) => k.indexOf('image/') === 0);
          if (imageType && !imageBlob) imageBlob = await clipItem.getType(imageType);
          if (!html && kinds.indexOf('text/html') !== -1) html = await (await clipItem.getType('text/html')).text();
        }
      } catch (err) { readFailed = true; }
      const markdown = html && window.HtmlToMd ? window.HtmlToMd.convert(html) : '';
      const onlyAnImage = /^!\[[^\]]*\]\([^)]*\)$/.test(markdown.trim());
      if (imageBlob && (htmlAsMarkdown || !markdown.trim() || onlyAnImage)) {
        // "As it is": a picture is kept as a file (a browser's "copy image" also brings an <img> HTML that is only a remote link)
        await savePastedImageBlob(imageBlob, editor, 'pasteImageSaved');
      } else if (markdown.trim()) {
        insertPastedText(markdown, editor, 'pasteHtmlConverted');
      } else if (plain) {
        insertPastedText(plain.replace(/\r\n?/g, '\n'), editor, '');
      } else if (readFailed) {
        showMessage(t('pasteClipboardUnreadable'), 5000);
      }
    }
  }

  function insertPastedText(text, editor, messageKey) {
    insertTextWithUndo(text, editor);
    onEditorInput(editor, getTab(getTabIdForEditor(editor)) || getActiveTab(), true);
    if (messageKey) showMessage(t(messageKey), 3000);
  }

  async function savePastedImage(e, imageItem, editor, messageKey) {
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    await savePastedImageBlob(file, editor, messageKey);
  }

  async function savePastedImageBlob(blob, editor, messageKey) {
    try {
      const imgData = await convertBlobToBase64(blob);
      if (!(window.backend && window.backend.saveAsset)) {
        showMessage(t('fanchorImportUnavailable'), 3000);
        return;
      }
      const res = await window.backend.saveAsset(await getNoteDir(), assetExtForMime(imgData.mimeType), imgData.base64);
      const target = (res && (res.relPath || res.fileUrl)) || '';
      if (!target) return;
      const safeTarget = window.FileAnchor && window.FileAnchor.encodeLinkTarget ? window.FileAnchor.encodeLinkTarget(target) : target;
      insertPastedText(`![image](${safeTarget})`, editor, messageKey || 'pasteImageSaved');
    } catch (err) {
      showMessage(t('pasteImageSaveFailed', { error: String((err && err.message) || err) }), 4000);
    }
  }

  editorEl.addEventListener('paste', (e) => handleEditorPaste(e, editorEl));

  // Tab / Shift+Tab indent-unindent, shared by both editor panes (see the
  // editorSecondary keydown listener below). Ghost-text / IME-suggestion
  // acceptance on Tab is intentionally NOT part of this shared function: that
  // overlay only exists for the primary editor (#ghost-overlay is a single,
  // primary-pane-only element — see ghostOverlayEl), so there is nothing for
  // the secondary pane to accept, and wiring it in would just be dead code.
  function applyTabIndent(ed, e) {
    e.preventDefault(); // Always prevent Tab from moving focus to menu buttons

    const start = ed.selectionStart;
    const end = ed.selectionEnd;
    const val = ed.value;
    const tabSpaces = '    '; // 4 spaces for markdown indentation

    if (start === end) {
      if (!e.shiftKey) {
        // Insert 4 spaces at cursor with undo history support
        insertTextWithUndo(tabSpaces, ed);
      } else {
        // Shift+Tab: unindent current line
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const lineText = val.substring(lineStart);
        if (lineText.startsWith('    ')) {
          ed.value = val.substring(0, lineStart) + lineText.substring(4);
          ed.selectionStart = Math.max(lineStart, start - 4);
          ed.selectionEnd = Math.max(lineStart, end - 4);
        } else if (lineText.startsWith('\t')) {
          ed.value = val.substring(0, lineStart) + lineText.substring(1);
          ed.selectionStart = Math.max(lineStart, start - 1);
          ed.selectionEnd = Math.max(lineStart, end - 1);
        } else if (lineText.startsWith(' ')) {
          const count = Math.min(lineText.search(/\S|$/), 4);
          ed.value = val.substring(0, lineStart) + lineText.substring(count);
          ed.selectionStart = Math.max(lineStart, start - count);
          ed.selectionEnd = Math.max(lineStart, end - count);
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
      ed.value = val.substring(0, startLineStart) + newBlock + val.substring(endLineEnd);
      ed.selectionStart = startLineStart;
      ed.selectionEnd = startLineStart + newBlock.length;
    }

    onEditorInput(ed);
  }

  // Editor specific keydown (Tab key & Shift+Tab handling to keep focus inside editor)
  editorEl.addEventListener('keydown', (e) => {
    hideCursorAura(false);

    if (e.key === 'Tab') {
      // Ctrl+Tab is the note-switch shortcut (and Quick Actions' "move highlight"): it
      // must not indent the note it is leaving.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // If ghost text / IME suggestion is active and user presses Tab (not Shift+Tab), accept completion
      if (!e.shiftKey && (ghostSuggestion || activeImeSuggestion)) {
        if (acceptGhostSuggestion()) {
          e.preventDefault();
          return;
        }
      }

      applyTabIndent(editorEl, e);
      return;
    }

    if ((e.key === 'ArrowRight' || e.key === 'Right') && (e.ctrlKey || e.altKey || e.metaKey) && (ghostSuggestion || activeImeSuggestion)) {
      if (editorEl.selectionStart === ghostTargetCursor || activeImeSuggestion) {
        if (acceptGhostWord()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    if ((e.key === 'ArrowRight' || e.key === 'Right') && !e.ctrlKey && !e.altKey && !e.metaKey && (ghostSuggestion || activeImeSuggestion)) {
      if (editorEl.selectionStart === ghostTargetCursor || activeImeSuggestion) {
        if (acceptGhostSuggestion()) {
          e.preventDefault();
          e.stopPropagation();
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
    if (editorSecondary) editorSecondary.style.fontSize = `${currentFontSize}px`;
    if (secondaryLineNumbers) secondaryLineNumbers.style.fontSize = `${currentFontSize}px`;
    try {
      localStorage.setItem('md_memo_font_size', currentFontSize.toString());
    } catch (e) {}
    invalidateCharPixelMirrors();
    hideCursorAura(true);
    triggerCursorAuraDebounced();
    // The link underlines take the editor's font, so they follow a zoom. So do the wrapped lines
    // in the line-number gutter: a bigger font wraps more.
    if (window.FileAnchor && window.FileAnchor.scheduleMarks) window.FileAnchor.scheduleMarks();
    scheduleUpdateLineNumbers();
    scheduleUpdateSecondaryLineNumbers();
  }
  applyFontSize(currentFontSize);

  // Where a line wraps depends on the editor's width (a window resize, a dragged split pane, the
  // scrollbar appearing), and the gutter numbers follow the wrapping.
  // (Debounced: dragging a window edge or the split bar reports a new width every frame, and every
  // new width means measuring the long lines again.)
  if (typeof ResizeObserver === 'function') {
    let gutterResizeTimer = null;
    const gutterResizeObserver = new ResizeObserver(() => {
      clearTimeout(gutterResizeTimer);
      gutterResizeTimer = setTimeout(() => {
        scheduleUpdateLineNumbers();
        scheduleUpdateSecondaryLineNumbers();
      }, 80);
    });
    gutterResizeObserver.observe(editorEl);
    if (editorSecondary) gutterResizeObserver.observe(editorSecondary);
  }

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

  function toggleZenMode() {
    const isZen = document.body.classList.toggle('zen-mode');
    if (isZen) {
      document.body.classList.remove('zen-active');
      // Show whatever shortcut is actually configured/effective (formatted for
      // the current platform), not a hardcoded string. The defaults are Shift+F11
      // (Windows/Linux) and Ctrl+Cmd+Z (macOS); Ctrl+Shift+Z is Redo everywhere.
      const sc = formatShortcutForDisplay(getEffectiveShortcut('zenMode')) || (isMac ? 'Ctrl+Cmd+Z' : 'Shift+F11');
      showMessage(t('zenModeEnabled', { sc }) || `Zen Mode: Distraction-free (Esc / ${sc} to exit)`, 3000);
    } else {
      showMessage(t('zenModeDisabled') || 'Zen Mode: Off', 3000);
    }
  }

  // --- Full screen: the window covers the whole monitor (the native window does it; the browser API is the fallback) ---
  function toggleFullscreen() {
    if (window.backend && window.backend.toggleFullscreen) {
      window.backend.toggleFullscreen();
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  // The native window says nothing when it changes size, so full screen is recognised by its size: the page fills the
  // whole screen. Keeps the header button pressed while it lasts.
  function isFullscreenNow() {
    if (document.fullscreenElement) return true;
    return Math.abs(window.innerWidth - screen.width) <= 1 && Math.abs(window.innerHeight - screen.height) <= 1;
  }

  function syncFullscreenState() {
    const on = isFullscreenNow();
    if (document.body.classList.contains('is-fullscreen') === on) return;
    document.body.classList.toggle('is-fullscreen', on);
    const btn = document.getElementById('btn-fullscreen');
    if (btn) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  window.addEventListener('resize', syncFullscreenState);
  document.addEventListener('fullscreenchange', syncFullscreenState);

  // --- Ask Bar (Ctrl+L): ask the built-in LLM about the selection, the current line or the whole note ---
  let currentInlinePromptContext = null;

  // What the bar acts on: the selection, else the current line, else (on a blank line) the whole note.
  function resolveAskTarget(text, start, end) {
    if (end > start) {
      const selected = text.substring(start, end).trim();
      if (selected) return { kind: 'selection', text: selected, start: start, end: end };
    }
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.substring(lineStart, lineEnd).trim();
    if (line) return { kind: 'line', text: line, start: lineStart, end: lineEnd };
    const whole = text.trim();
    if (whole) return { kind: 'note', text: whole, start: 0, end: text.length };
    return { kind: 'none', text: '', start: start, end: end };
  }

  // Where the answer goes: the end of the target's last line (the caret's line when the target is the whole note).
  function askInsertPos(text, target, caret) {
    let from = caret;
    if (target.kind !== 'note' && target.kind !== 'none') {
      from = (target.end > target.start && text.charAt(target.end - 1) === '\n') ? target.end - 1 : target.end;
    }
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
  }

  function askTargetLabel(target) {
    if (target.kind === 'selection') return t('askTargetSelection', { count: target.text.length });
    if (target.kind === 'line') return t('askTargetLine');
    if (target.kind === 'note') return t('askTargetNote');
    return t('askTargetNone');
  }

  function isAskBarOpen() {
    return !!inlinePromptBar && !inlinePromptBar.classList.contains('hidden');
  }

  // The editor showing a note, or null when the note is not on screen.
  function editorForTab(tabId) {
    const focused = getActiveEditor();
    if (getTabIdForEditor(focused) === tabId) return focused;
    if (tabId === activeTabId) return editorEl;
    if (isSplitMode && secondaryViewMode === 'editor' && tabId === secondaryTabId && editorSecondary) return editorSecondary;
    return null;
  }

  // opts (all optional): { tabId, target: { text, start, end, kind? }, recordInstruction, onSubmit(instruction, ctx) }
  // Without onSubmit this is the quick ask: the answer lands below the target. With onSubmit the bar only collects
  // the instruction and hands it back (the caller writes the task line); ctx = { tabId, target, insertPos, recordInstruction }.
  function openInlinePromptBar(opts) {
    clearGhostText();
    if (!inlinePromptBar) return;
    const o = opts || {};

    // The shortcut pressed again inside the open bar just brings the caret back to it.
    if (isAskBarOpen() && !o.tabId && !o.target && !o.onSubmit) {
      inlinePromptInput.focus();
      return;
    }

    const curTab = o.tabId ? getTab(o.tabId) : getActiveTab();
    if (!curTab) return;
    if (!isLlmConfigured(true)) return;

    const editor = editorForTab(curTab.id);
    const text = editor ? editor.value : (curTab.content || '');
    const start = editor ? editor.selectionStart : 0;
    const end = editor ? editor.selectionEnd : 0;

    let target;
    if (o.target && typeof o.target.text === 'string') {
      target = {
        kind: o.target.kind || 'selection',
        text: o.target.text,
        start: Number.isFinite(o.target.start) ? o.target.start : start,
        end: Number.isFinite(o.target.end) ? o.target.end : end
      };
    } else {
      target = resolveAskTarget(text, start, end);
    }

    currentInlinePromptContext = {
      tabId: curTab.id,
      target: target,
      insertPos: askInsertPos(text, target, end),
      recordInstruction: !!o.recordInstruction,
      onSubmit: typeof o.onSubmit === 'function' ? o.onSubmit : null
    };

    // Both bars float at the caret: an idle command bar makes room, a running one is left alone.
    if (cliFilterBar && !cliFilterBar.classList.contains('hidden') && !isCliFilterRunning && !isAiCliGenerating) {
      closeCliFilterBar();
    }

    inlinePromptBar.classList.remove('hidden');
    inlinePromptInput.value = '';
    inlinePromptInput.placeholder = t(o.recordInstruction ? 'askPlaceholderRecord' : 'inlinePromptPlaceholder');
    if (inlinePromptTarget) {
      inlinePromptTarget.textContent = askTargetLabel(target);
      inlinePromptTarget.title = target.text.length > 300 ? target.text.substring(0, 300) + '...' : target.text;
    }
    if (inlinePromptHint) inlinePromptHint.textContent = t(o.recordInstruction ? 'askRecordHint' : 'askKeysHint');

    // Position the bar right beneath the cursor / selection (top left when the note is not on screen)
    try {
      if (!editor) {
        inlinePromptBar.style.left = '24px';
        inlinePromptBar.style.top = '12px';
        inlinePromptBar.style.width = '460px';
        inlinePromptInput.focus();
        return;
      }
      const targetCursor = (target.kind === 'selection' || o.target) ? target.end : start;
      const coords = keepCoordsInView(getCharPixelCoords(targetCursor, editor), editor);
      const editorRect = editor.getBoundingClientRect();
      const workspaceRect = workspaceEl ? workspaceEl.getBoundingClientRect() : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };

      // Calculate pixel coordinates relative to #workspace container
      const cursorX = (editorRect.left - workspaceRect.left) + (coords.left - editor.scrollLeft);
      const cursorY = (editorRect.top - workspaceRect.top) + (coords.top - editor.scrollTop);

      const barWidth = 460;
      const barHeight = 74;
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
      inlinePromptBar.style.width = '460px';
    }

    inlinePromptInput.focus();
  }

  function closeInlinePromptBar() {
    if (inlinePromptBar) inlinePromptBar.classList.add('hidden');
    currentInlinePromptContext = null;
    const editor = getActiveEditor();
    if (editor) editor.focus();
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

    // Collect-only mode: the caller turns the instruction into a task line and runs it.
    if (ctx.onSubmit) {
      if (!instruction) {
        inlinePromptInput.focus();
        return;
      }
      closeInlinePromptBar();
      try {
        ctx.onSubmit(instruction, {
          tabId: ctx.tabId,
          target: ctx.target,
          insertPos: ctx.insertPos,
          recordInstruction: ctx.recordInstruction
        });
      } catch (e) {
        console.warn('Ask bar onSubmit failed:', e);
      }
      return;
    }

    const targetText = ctx.target.text;
    if (!instruction && !targetText) {
      closeInlinePromptBar();
      return;
    }

    let finalPrompt = targetText;
    if (instruction && targetText) {
      finalPrompt = `【指示】:\n${instruction}\n\n【対象テキスト】:\n${targetText}`;
    } else if (instruction) {
      finalPrompt = instruction;
    }

    const shortInstruction = instruction ? instruction.substring(0, 20) : (config.general && config.general.language === 'ja' ? '処理中' : 'Processing');
    const anchorLabel = `[${t('aiGeneratingAnchor', { instruction: shortInstruction })}]`;

    // The answer sits below the target's last line; with no target (blank line) it takes the blank line itself.
    // The anchor carries the surrounding line breaks, so cancelling it restores the note exactly.
    const onOwnLine = ctx.target.kind === 'note' || ctx.target.kind === 'none';
    const anchorText = onOwnLine ? `${anchorLabel}\n` : `\n\n${anchorLabel}\n`;
    const wrapResult = onOwnLine ? (answer) => `${answer}\n` : (answer) => `\n\n${answer}\n`;
    const wrapError = (message) => wrapResult(`[${t('llmError')}${message}]`);

    const editor = editorForTab(curTab.id);
    if (editor) {
      const insertPos = Math.min(ctx.insertPos, editor.value.length);
      editor.setSelectionRange(insertPos, insertPos);
      insertTextWithUndo(anchorText, editor);
      curTab.content = editor.value;
    } else {
      const content = curTab.content || '';
      const insertPos = Math.min(ctx.insertPos, content.length);
      curTab.content = content.substring(0, insertPos) + anchorText + content.substring(insertPos);
    }
    curTab.isDirty = true;
    renderTabs();
    if (editor === editorSecondary) {
      updateSecondaryLineNumbers();
    } else if (editor) {
      updateLineNumbers();
    }
    updateStatusBar();
    closeInlinePromptBar();

    startLlmTask({
      tabId: curTab.id,
      prompt: finalPrompt,
      anchorText: anchorText,
      label: instruction || targetText,
      wrapResult: wrapResult,
      wrapError: wrapError
    });
  }

  // AI Typo, Mistake & Context Correction (Alt+C / Cmd+Shift+C)
  async function triggerAICorrection() {
    clearGhostText();
    const curTab = getActiveTab();
    const editor = getActiveEditor();
    if (!curTab || !editor) return;

    let targetText = '';
    let isExplicitSelection = false;
    let start = editor.selectionStart;
    let end = editor.selectionEnd;

    if (end > start) {
      targetText = editor.value.substring(start, end).trim();
      isExplicitSelection = true;
    } else {
      const text = editor.value;
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

    const reqId = genReqId('correct_');
    const anchorId = `[${t('aiCorrectingAnchor')}]`;

    editor.setSelectionRange(start, end);
    insertTextWithUndo(anchorId, editor);

    curTab.content = editor.value;
    curTab.isDirty = true;
    renderTabs();
    if (editor === editorSecondary) {
      updateSecondaryLineNumbers();
    } else {
      updateLineNumbers();
    }
    updateStatusBar();

    registerPendingLLMRequest(reqId, {
      tabId: curTab.id,
      anchorId: anchorId,
      originalText: targetText,
      isCorrection: true
    });

    updateLLMIndicator();
    showMessage(t('aiCorrecting'), 3000);

    const hasJapanese = /[一-龠ぁ-んァ-ヶ]/.test(targetText);
    const isJa = hasJapanese || (config.general && config.general.language === 'ja');

    let promptPayload = '';
    if (isJa) {
      promptPayload = `以下のテキストの誤字・脱字・打ち間違い・変換ミス・文脈エラーを自然に修正し、修正後のテキストのみを出力してください。挨拶・解説・前置き・引用符などは一切含めず、修正後の本文のみを直接出力してください。\n\n【対象テキスト】:\n${targetText}`;
    } else {
      promptPayload = `Fix all typos, spelling errors, grammar mistakes, and accidental keystrokes in the following text. Output ONLY the corrected text without any greetings, explanations, markdown quotes, or conversational filler.\n\n[Text]:\n${targetText}`;
    }

    if (window.backend && window.backend.queryLLMAsync) {
      window.backend.queryLLMAsync(reqId, promptPayload, JSON.stringify(config.text));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, targetText, '');
      }, 1500);
    }
  }

  // Enter that confirms an IME conversion (Safari reports it as a plain Enter with keyCode 229) must not submit.
  function isImeComposingKey(e) {
    return !!(e && (e.isComposing || e.keyCode === 229));
  }

  if (inlinePromptInput) {
    inlinePromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (isImeComposingKey(e)) return;
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

  // --- Command bar (Ctrl+E): a shell filter over the selection, or AI that writes the command ---
  const CLI_PRESET_SNIPPETS = [
    { value: 'sort', label: '行を昇順ソート (Sort ascending)' },
    { value: 'sort -r', label: '行を降順ソート (Sort descending)' },
    { value: 'sort -u', label: '重複行を排除してソート (Sort unique)' },
    { value: 'uniq', label: '連続する重複行を排除 (Remove repeated adjacent lines)' },
    { value: 'jq .', label: 'JSON整形・インデント (Pretty-print JSON)' },
    { value: 'jq -c .', label: 'JSONを1行に圧縮 (Minify JSON)' },
    { value: 'tr a-z A-Z', label: '大文字に変換 (Convert to uppercase)' },
    { value: 'tr A-Z a-z', label: '小文字に変換 (Convert to lowercase)' },
    { value: 'wc -l', label: '行数をカウント (Count lines)' },
    { value: 'wc -w', label: '単語数をカウント (Count words)' },
    { value: 'base64 -d', label: 'Base64デコード (Decode base64)' },
    { value: 'base64', label: 'Base64エンコード (Encode base64)' },
    { value: 'npx prettier --parser markdown', label: 'Markdown整形 (Prettier format)' },
    { value: 'duckdb -box', label: 'SQL実行: DuckDB 表形式 (DuckDB query)' },
    { value: 'sqlite3 -header -column', label: 'SQL実行: SQLite 表形式 (SQLite query)' },
    { value: 'psql -f -', label: 'SQL実行: PostgreSQL (psql execute stdin)' },
    { value: 'mysql -t', label: 'SQL実行: MySQL 表形式 (MySQL execute stdin)' }
  ];

  // 'win' / 'unix': which variant of a command snippet suits the shell the bar runs commands through.
  function currentCommandOs() {
    const os = String((platformCapabilities && platformCapabilities.os) || '').toLowerCase();
    if (os === 'windows' || os === 'win32') return 'win';
    if (os === 'darwin' || os === 'linux') return 'unix';
    if (isMac) return 'unix';
    return (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '')) ? 'win' : 'unix';
  }

  // agents.yaml `snippets`, fetched when the bar opens (only when the snippet library is loaded at all).
  let commandUserSnippets = [];

  function refreshCommandUserSnippets() {
    if (!(window.SlotSnippets && window.backend && window.backend.getActiveSlotConfigJSON)) return;
    Promise.resolve(window.backend.getActiveSlotConfigJSON()).then((raw) => {
      const cfg = raw ? JSON.parse(raw) : null;
      commandUserSnippets = (cfg && Array.isArray(cfg.snippets)) ? cfg.snippets : [];
      refreshCliSnippetsDatalist();
    }).catch(() => {});
  }

  // Presets for the manual mode: the agents.yaml snippets of the user first, then the fixed filters above (what the bar
  // pipes the selection through: sort -u, jq ., ...), then the shared built-in command snippets when the library is loaded.
  // A body that still holds a ${...} / $0 placeholder is a task template that needs a value, not a command that can run
  // as it is: it is skipped. "$$0" and "$${" are the library's escapes for a literal "$0" / "${".
  function commandPresetItems() {
    if (window.SlotSnippets && typeof window.SlotSnippets.list === 'function') {
      try {
        const mine = [];
        const shared = [];
        window.SlotSnippets.list({
          kind: 'command',
          os: currentCommandOs(),
          lang: (config.general && config.general.language) || 'en',
          user: commandUserSnippets
        }).forEach((snip) => {
          const body = String((snip && snip.body) || '').trim();
          if (!body || /\$\{[^}]*\}|\$0/.test(body.replace(/\$\$0|\$\$\{/g, ''))) return;
          const value = body.replace(/\$\$0/g, () => '$0').replace(/\$\$\{/g, () => '${');
          (snip.builtin === false ? mine : shared).push({ value: value, label: snip.label || value });
        });
        return mine.concat(CLI_PRESET_SNIPPETS, shared);
      } catch (e) {
        console.warn('Command presets from SlotSnippets failed:', e);
      }
    }
    return CLI_PRESET_SNIPPETS;
  }

  function refreshCliSnippetsDatalist() {
    const datalist = document.getElementById('cli-snippets');
    if (!datalist) return;
    datalist.innerHTML = '';

    let history = [];
    try {
      const saved = localStorage.getItem('md_memo_cli_history');
      if (saved) history = JSON.parse(saved);
    } catch (e) {}

    const seen = new Set();

    // 1. Add recent history first
    if (Array.isArray(history)) {
      history.forEach(cmd => {
        if (!cmd || seen.has(cmd)) return;
        seen.add(cmd);
        const opt = document.createElement('option');
        opt.value = cmd;
        opt.label = `${t('cliHistoryPrefix')} ${cmd}`;
        datalist.appendChild(opt);
      });
    }

    // 2. Add preset snippets
    commandPresetItems().forEach(snip => {
      if (seen.has(snip.value)) return;
      seen.add(snip.value);
      const opt = document.createElement('option');
      opt.value = snip.value;
      opt.label = snip.label;
      datalist.appendChild(opt);
    });
  }

  let isAiCliMode = false;
  let isAiCliGenerating = false;
  let activeAiCliGenReqId = null;
  window.__aiCliGenCallbacks = new Map();

  window.__onCliCommandGenerated = function(reqID, cleanCmd, errStr, valResult) {
    if (window.__aiCliGenCallbacks && window.__aiCliGenCallbacks.has(reqID)) {
      const cb = window.__aiCliGenCallbacks.get(reqID);
      window.__aiCliGenCallbacks.delete(reqID);
      cb(cleanCmd, errStr, valResult);
    }
  };

  function updateCliFilterBarModeUI() {
    if (cliFilterBadge) {
      if (isAiCliGenerating) {
        cliFilterBadge.innerHTML = '<span class="cli-spinner cli-spinner-sm"></span>' + (t('aiCliThinking') || 'Thinking...');
        cliFilterBadge.style.background = 'var(--accent-hover, var(--accent-color, #6b843d))';
      } else if (isCliFilterRunning) {
        cliFilterBadge.innerHTML = '<span class="cli-spinner cli-spinner-sm"></span>' + (t('cliRunningShort') || 'Running...');
        cliFilterBadge.style.background = '#d97706';
      } else if (isAiCliMode) {
        cliFilterBadge.textContent = t('aiCliFilterBadge') || 'AI CLI';
        cliFilterBadge.style.background = 'var(--accent-hover, var(--accent-color, #6b843d))';
      } else {
        cliFilterBadge.textContent = t('cliFilterBadge') || 'CLI';
        cliFilterBadge.style.background = 'var(--accent-color, #556b2f)';
      }
    }
    if (cliFilterInput) {
      if (isAiCliMode) {
        cliFilterInput.placeholder = t('aiCliFilterPlaceholder');
        cliFilterInput.removeAttribute('list');
      } else {
        cliFilterInput.placeholder = t('cliFilterPlaceholder');
        cliFilterInput.setAttribute('list', 'cli-snippets');
      }
    }
    if (btnCliFilterSend) {
      if (isAiCliGenerating) {
        btnCliFilterSend.innerHTML = '<span class="cli-spinner"></span>';
        btnCliFilterSend.title = t('aiCliThinking') || 'Thinking...';
        btnCliFilterSend.disabled = true;
      } else if (isCliFilterRunning) {
        btnCliFilterSend.innerHTML = '<span class="cli-spinner"></span>';
        btnCliFilterSend.title = t('cliRunningShort') || 'Running...';
        btnCliFilterSend.disabled = true;
      } else if (isAiCliMode) {
        btnCliFilterSend.textContent = t('btnGenCli') || 'Generate';
        btnCliFilterSend.title = 'Generate Command (Enter)';
        btnCliFilterSend.disabled = false;
      } else {
        btnCliFilterSend.textContent = t('btnRunCli') || 'Run';
        btnCliFilterSend.title = 'Run Command (Enter)';
        btnCliFilterSend.disabled = false;
      }
    }
  }

  // The mode the bar opens in is the one the user last picked (badge click, Tab, or opening a mode explicitly);
  // the switch back to manual after an AI command was generated is automatic and is not remembered.
  const COMMAND_BAR_MODE_KEY = 'md_memo_cmdbar_mode';

  function readCommandBarMode() {
    try {
      return localStorage.getItem(COMMAND_BAR_MODE_KEY) === 'ai' ? 'ai' : 'cli';
    } catch (e) {
      return 'cli';
    }
  }

  function setCliMode(aiMode, remember) {
    isAiCliMode = !!aiMode;
    updateCliFilterBarModeUI();
    if (remember) {
      try {
        localStorage.setItem(COMMAND_BAR_MODE_KEY, isAiCliMode ? 'ai' : 'cli');
      } catch (e) {}
    }
  }

  // The preset list belongs to the manual mode: rebuilt whenever that mode is shown.
  function refreshCommandPresets() {
    refreshCliSnippetsDatalist();
    refreshCommandUserSnippets();
  }

  // Badge click and Tab: switch between the manual and the AI mode (ignored while a command runs or is generated).
  function toggleCommandBarMode() {
    if (isCliFilterRunning || isAiCliGenerating) return;
    setCliMode(!isAiCliMode, true);
    if (!isAiCliMode) refreshCommandPresets();
    if (cliFilterInput) cliFilterInput.focus();
  }

  if (cliFilterBadge) {
    cliFilterBadge.addEventListener('click', toggleCommandBarMode);
  }

  function updateCliFilterPreview(cmdText) {
    if (!cliFilterPreview) return;
    const text = (cmdText !== undefined ? cmdText : (cliFilterInput ? cliFilterInput.value : '')).trim();
    if (text) {
      cliFilterPreview.textContent = text;
      if (cliFilterInput) cliFilterInput.title = text;
    } else {
      cliFilterPreview.textContent = '';
      if (cliFilterInput) cliFilterInput.removeAttribute('title');
    }
  }

  function toggleCliFilterPreview() {
    if (!cliFilterPreview) return;
    const isHidden = cliFilterPreview.classList.contains('hidden');
    if (isHidden) {
      updateCliFilterPreview();
      cliFilterPreview.classList.remove('hidden');
    } else {
      cliFilterPreview.classList.add('hidden');
    }
    const ed = getActiveEditor();
    if (ed) positionCliBar(ed);
  }

  function positionCliBar(editor) {
    try {
      const workspace = document.getElementById('workspace');
      const editorRect = editor.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const coords = keepCoordsInView(getCharPixelCoords(editor.selectionEnd, editor), editor);

      const cursorX = (editorRect.left - workspaceRect.left) + (coords.left - editor.scrollLeft);
      const cursorY = (editorRect.top - workspaceRect.top) + (coords.top - editor.scrollTop);

      // Dynamically size bar width up to 880px to allow ample space for reading and editing long commands
      const barWidth = Math.min(880, Math.max(520, workspaceRect.width - 48));
      const barHeight = cliFilterPreview && !cliFilterPreview.classList.contains('hidden') ? 110 : 46;
      const lineHeight = Math.max(22, Math.round(currentFontSize * 1.6));

      let posX = Math.max(16, Math.min(workspaceRect.width - barWidth - 16, cursorX - 10));
      let posY = cursorY + lineHeight + 6;
      if (posY + barHeight > workspaceRect.height - 10) {
        posY = Math.max(10, cursorY - barHeight - 6);
      }

      cliFilterBar.style.left = `${Math.round(posX)}px`;
      cliFilterBar.style.top = `${Math.round(posY)}px`;
      cliFilterBar.style.width = `${barWidth}px`;
    } catch (e) {
      cliFilterBar.style.left = '24px';
      cliFilterBar.style.top = '12px';
      cliFilterBar.style.width = 'min(880px, calc(100% - 48px))';
    }
  }

  // mode: 'cli' (manual command), 'ai' (AI writes the command) or nothing = the mode the user last picked.
  function openCommandBar(mode) {
    clearGhostText();
    if (!cliFilterBar) return;

    const editor = getActiveEditor();
    if (!editor) return;

    const wantAi = (mode === 'ai' || mode === 'cli') ? mode === 'ai' : readCommandBarMode() === 'ai';

    // Already open: keep what was typed, follow an explicitly requested mode, and bring the caret back.
    if (!cliFilterBar.classList.contains('hidden')) {
      if ((mode === 'ai' || mode === 'cli') && wantAi !== isAiCliMode && !isCliFilterRunning && !isAiCliGenerating) {
        setCliMode(wantAi, true);
        if (!wantAi) refreshCommandPresets();
      }
      if (cliFilterInput) cliFilterInput.focus();
      return;
    }

    if (inlinePromptBar && !inlinePromptBar.classList.contains('hidden')) {
      closeInlinePromptBar();
    }
    if (!findReplaceBar.classList.contains('hidden')) {
      closeFindBar();
    }

    setCliMode(wantAi, true);
    if (cliFilterPreview) {
      cliFilterPreview.classList.add('hidden');
      cliFilterPreview.textContent = '';
    }
    cliFilterBar.classList.remove('hidden');
    if (cliFilterInput) {
      cliFilterInput.removeAttribute('title');
      cliFilterInput.value = '';
    }

    let selected = '';
    if (wantAi) {
      // If text is selected in the editor, preload it as the request
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      selected = (start !== end) ? editor.value.substring(start, end).trim() : '';
      if (cliFilterInput) cliFilterInput.value = selected;
    } else {
      refreshCommandPresets();
    }

    positionCliBar(editor);
    if (cliFilterInput) {
      cliFilterInput.focus();
      if (selected) cliFilterInput.select();
    }
  }

  let activeCliReqId = null;
  let isCliFilterRunning = false;
  window.__cliCallbacks = new Map();

  window.__onCliFilterResult = function(reqID, result, errStr) {
    if (window.__cliCallbacks && window.__cliCallbacks.has(reqID)) {
      const cb = window.__cliCallbacks.get(reqID);
      window.__cliCallbacks.delete(reqID);
      cb(result, errStr);
    }
  };

  function resetCliFilterUI() {
    isCliFilterRunning = false;
    isAiCliGenerating = false;
    activeCliReqId = null;
    activeAiCliGenReqId = null;
    updateCliFilterBarModeUI();
    if (cliFilterInput) {
      cliFilterInput.disabled = false;
    }
  }

  function cancelActiveCliFilter() {
    if (isCliFilterRunning && activeCliReqId) {
      if (window.backend && window.backend.cancelCommandFilter) {
        try {
          window.backend.cancelCommandFilter(activeCliReqId);
        } catch (e) {}
      }
      showMessage(t('cliCancelled'), 2000);
    }
    resetCliFilterUI();
  }

  function closeCliFilterBar() {
    if (isCliFilterRunning) {
      cancelActiveCliFilter();
    }
    if (cliFilterBar) cliFilterBar.classList.add('hidden');
    if (cliFilterPreview) {
      cliFilterPreview.classList.add('hidden');
      cliFilterPreview.textContent = '';
    }
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  async function generateAiCliCommand() {
    if (isAiCliGenerating) return;
    if (!cliFilterInput) return;
    const promptText = (cliFilterInput.value || '').trim();
    if (!promptText) {
      closeCliFilterBar();
      return;
    }

    isAiCliGenerating = true;
    updateCliFilterBarModeUI();
    if (cliFilterInput) cliFilterInput.disabled = true;

    const reqID = genReqId('aicli_');
    activeAiCliGenReqId = reqID;

    showMessage(t('aiCliGenerating'), 4000);

    try {
      if (!window.backend || !window.backend.generateCliCommandAsync) {
        throw new Error("AI CLI generation is only available in native desktop mode.");
      }

      // Gather active file and path context for command generation
      const activeTab = getActiveTab();
      const activeFilePath = (activeTab && activeTab.path) || '';
      let activeFileDir = '';
      let activeFileName = '';
      if (activeFilePath) {
        const lastSlash = Math.max(activeFilePath.lastIndexOf('/'), activeFilePath.lastIndexOf('\\'));
        if (lastSlash !== -1) {
          activeFileDir = activeFilePath.substring(0, lastSlash);
          activeFileName = activeFilePath.substring(lastSlash + 1);
        } else {
          activeFileName = activeFilePath;
        }
      }

      const contextMeta = {
        filePath: activeFilePath,
        fileDir: activeFileDir,
        fileName: activeFileName
      };

      const genRes = await new Promise((resolve, reject) => {
        window.__aiCliGenCallbacks.set(reqID, (cmd, errStr, valResult) => {
          if (errStr && !cmd) {
            reject(new Error(errStr));
          } else {
            resolve({ cmd, valResult });
          }
        });

        const effectiveCliConfig = {
          baseUrl: (config.cli && config.cli.baseUrl) || config.text.baseUrl || 'http://localhost:11434',
          model: (config.cli && config.cli.model) || config.text.model || 'qwen2.5:latest',
          apiKey: (config.cli && config.cli.apiKey) ? config.cli.apiKey : (config.text.apiKey || ''),
          systemPrompt: (config.cli && config.cli.systemPrompt) || ''
        };
        window.backend.generateCliCommandAsync(reqID, promptText, JSON.stringify(effectiveCliConfig), JSON.stringify(contextMeta));
      });

      let cleanCmd = (genRes.cmd || '').trim();
      // Defensive client-side strip for shell wrappers or language headers
      cleanCmd = cleanCmd.replace(/^(?:powershell|pwsh|cmd|bash|sh|zsh|shell|terminal):?\r?\n+/i, '');
      cleanCmd = cleanCmd.replace(/^(?:powershell|pwsh|bash|sh)\s+([^-/].*)$/i, '$1');

      const valResult = genRes.valResult || { isSafe: true };

      // If command has newlines, format safely with semicolon separator for single-line input
      const singleLineCmd = cleanCmd.includes('\n')
        ? cleanCmd.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('; ')
        : cleanCmd;

      isAiCliGenerating = false;
      if (cliFilterInput) {
        cliFilterInput.disabled = false;
        cliFilterInput.value = singleLineCmd;
        cliFilterInput.title = cleanCmd;
      }
      updateCliFilterPreview(cleanCmd);

      // If blocked by security policy, alert and refuse to execute
      if (valResult.isBlocked) {
        setCliMode(false);
        if (cliFilterBadge) {
          cliFilterBadge.textContent = 'BLOCKED';
          cliFilterBadge.style.background = '#d9534f';
        }
        showMessage(t('cliBlockedError', { reason: valResult.reason }), 6000);
        if (cliFilterInput) {
          cliFilterInput.focus();
          cliFilterInput.scrollLeft = 0;
        }
        return;
      }

      // Switch back to normal CLI mode so user can inspect and press Enter to execute!
      setCliMode(false);

      if (valResult.isWarning) {
        if (cliFilterBadge) {
          cliFilterBadge.textContent = 'WARN';
          cliFilterBadge.style.background = '#f0ad4e';
        }
        showMessage(valResult.reason, 5000);
      } else {
        showMessage(t('aiCliGenerated'), 4000);
      }

      // Auto-show preview if command has multiple lines or is long
      if (cliFilterPreview && (cleanCmd.includes('\n') || cleanCmd.length > 70)) {
        cliFilterPreview.classList.remove('hidden');
      }

      const activeEd = getActiveEditor();
      if (activeEd) positionCliBar(activeEd);

      if (cliFilterInput) {
        cliFilterInput.focus();
        cliFilterInput.scrollLeft = 0; // Ensure start of command is visible
        cliFilterInput.setSelectionRange(0, cleanCmd.length, 'backward');
      }
    } catch (e) {
      resetCliFilterUI();
      showMessage(t('cliError', { err: e.message || String(e) }), 5000);
      if (cliFilterInput) {
        cliFilterInput.focus();
      }
    }
  }

  // Where a command's output goes when it is put into the note: on the lines below the text it was run on (the default; that
  // text stays) or over that text (the classic filter). Settings -> Agent -> Commands.
  function cliResultPlacement() {
    return (config.cli && config.cli.resultPlacement === 'replace') ? 'replace' : 'below';
  }

  // True when a command gave back the very text it was run on (sort on sorted lines, cat, jq . on tidy JSON ...), line breaks and
  // trailing white space aside. Below the input that would only be a second copy of it, so nothing is put there.
  function isCliOutputSameAsInput(input, output) {
    const norm = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    const text = norm(input);
    return text !== '' && text === norm(output);
  }

  // Puts `output` on a new line below the last line of the input (which ends at `endOfInput`); false when there is nothing to put.
  function insertCliOutputBelow(editor, endOfInput, output) {
    const body = String(output || '').replace(/[\r\n]+$/, '');
    if (!body) return false;
    const text = editor.value;
    let from = Math.min(endOfInput, text.length);
    if (from > 0 && text.charAt(from - 1) === '\n') from -= 1; // a selection that took its last line break with it
    const nl = text.indexOf('\n', from);
    const pos = nl === -1 ? text.length : nl;
    editor.focus();
    editor.setSelectionRange(pos, pos);
    insertTextWithUndo('\n' + body, editor);
    return true;
  }

  async function executeCliFilter() {
    if (isAiCliMode) {
      // In AI mode, Enter generates the command
      return generateAiCliCommand();
    }

    if (isCliFilterRunning) return; // Prevent double-triggering
    if (!cliFilterInput) return;
    const cmdStr = (cliFilterInput.value || '').trim();
    if (!cmdStr) {
      closeCliFilterBar();
      return;
    }

    // Safety Validation Check
    if (window.backend && window.backend.validateCliCommand) {
      try {
        const val = await window.backend.validateCliCommand(cmdStr);
        if (val && val.isBlocked) {
          showMessage(t('cliBlockedError', { reason: val.reason }), 6000);
          if (cliFilterBadge) {
            cliFilterBadge.textContent = 'BLOCKED';
            cliFilterBadge.style.background = '#d9534f';
          }
          return;
        }
        if (val && val.isWarning) {
          const proceed = await customConfirm(t('cliWarningConfirm', { reason: val.reason, cmd: cmdStr }));
          if (!proceed) {
            showMessage(t('cliCancelled'), 2000);
            return;
          }
        }
      } catch (e) {}
    }

    const editor = getActiveEditor();
    if (!editor) return;

    const val = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const isSelection = start !== end;
    const inputContent = isSelection ? val.substring(start, end) : val;

    isCliFilterRunning = true;
    updateCliFilterBarModeUI();
    if (cliFilterInput) {
      cliFilterInput.disabled = true;
    }

    const reqID = genReqId('cli_');
    activeCliReqId = reqID;

    showMessage(t('cliRunning', { cmd: cmdStr }), 4000);

    try {
      if (!window.backend || (!window.backend.runCommandFilterAsync && !window.backend.runCommandFilter)) {
        throw new Error("CLI execution is only available in native desktop mode.");
      }

      let res = null;
      if (window.backend.runCommandFilterAsync) {
        // True non-blocking execution via goroutine and RPC callback
        res = await new Promise((resolve) => {
          window.__cliCallbacks.set(reqID, (result, errStr) => {
            if (errStr && !result) {
              resolve({ exitCode: 1, error: errStr, output: '' });
            } else {
              resolve(result);
            }
          });
          window.backend.runCommandFilterAsync(reqID, cmdStr, inputContent);
        });
      } else {
        // Fallback to synchronous bridge if async is unavailable
        res = await window.backend.runCommandFilter(cmdStr, inputContent);
      }

      if (!res) throw new Error("No response from CLI command.");

      if (res.exitCode !== 0) {
        const errDetail = res.error || `Exit code ${res.exitCode}`;
        const openErrorInNewTab = !config.cli || config.cli.openErrorInNewTab !== false;

        if (openErrorInNewTab) {
          const cleanCmdPreview = cmdStr.length > 20 ? cmdStr.substring(0, 20) + '...' : cmdStr;
          const errTitle = `[Error] ${cleanCmdPreview}.md`;
          const isJa = (config.general && config.general.language) === 'ja';
          const tipText = isJa
            ? '> **ヒント**: 上部のコマンド入力バーからコマンドを修正し、`Enter` を押すと即座に再実行できます。キャンセルする場合は `Escape` を押してください。'
            : '> **Tip**: Modify your command in the top bar and press `Enter` to re-execute immediately, or `Escape` to cancel.';
          const errContent = `# CLI Execution Error

- **Command**: \`${cmdStr}\`
- **Exit Code**: \`${res.exitCode}\`
- **Timestamp**: ${getFormattedDateTime('header').trim()}

## Standard Error / Failure Details
\`\`\`
${res.error || '(no error output)'}
\`\`\`
${res.output ? `\n## Standard Output\n\`\`\`\n${res.output}\n\`\`\`\n` : ''}
---
${tipText}
`;
          const errTab = createTab(errTitle, errContent);
          errTab.isAutoTitle = false;
          selectTab(errTab.id);
          showMessage(t('cliErrorTabOpened'), 6000);
        } else {
          showMessage(t('cliError', { err: errDetail }), 5000);
        }

        resetCliFilterUI();
        if (cliFilterBar) cliFilterBar.classList.remove('hidden');
        if (cliFilterBadge) {
          cliFilterBadge.textContent = 'ERROR';
          cliFilterBadge.style.background = '#d9534f';
        }
        if (cliFilterInput) {
          cliFilterInput.disabled = false;
          cliFilterInput.value = cmdStr;
          cliFilterInput.focus();
          cliFilterInput.select();
        }
        const activeEd = getActiveEditor();
        if (activeEd) positionCliBar(activeEd);
        return;
      }

      // Save command to history
      try {
        let history = [];
        const saved = localStorage.getItem('md_memo_cli_history');
        if (saved) history = JSON.parse(saved);
        if (!Array.isArray(history)) history = [];
        history = [cmdStr, ...history.filter(c => c !== cmdStr)].slice(0, 15);
        localStorage.setItem('md_memo_cli_history', JSON.stringify(history));
      } catch (e) {}

      const openResultInNewTab = !config.cli || config.cli.openResultInNewTab !== false;

      if (openResultInNewTab) {
        // With text selected: the output goes below it (the selection stays) or over it, as the setting says
        if (isSelection && editor) {
          if (cliResultPlacement() === 'replace') {
            editor.focus();
            editor.setSelectionRange(start, end);
            insertTextWithUndo(res.output, editor);
            onEditorInput(editor);
          } else if (!isCliOutputSameAsInput(inputContent, res.output) && insertCliOutputBelow(editor, end, res.output)) {
            onEditorInput(editor);
          }
        }

        // Open a dedicated new tab with the executed command and output so the command is never lost
        const cleanCmdPreview = cmdStr.length > 20 ? cmdStr.substring(0, 20) + '...' : cmdStr;
        const successTitle = `[CLI] ${cleanCmdPreview}.md`;
        const successContent = `# CLI Execution Result

- **Command**: \`${cmdStr}\`
- **Timestamp**: ${getFormattedDateTime('header').trim()}
- **Exit Code**: 0

## Output
\`\`\`
${res.output || '(no output)'}
\`\`\`
`;
        const resultTab = createTab(successTitle, successContent);
        resultTab.isAutoTitle = false;
        selectTab(resultTab.id);
        showMessage(t('cliSuccessTabOpened'), 3500);
      } else {
        // Directly into the active editor: below the input (the default) or over it
        editor.focus();
        let unchanged = false; // below the input, a copy of that same text is not added
        if (cliResultPlacement() === 'below' && val.trim() !== '') {
          unchanged = isCliOutputSameAsInput(inputContent, res.output);
          if (!unchanged) insertCliOutputBelow(editor, isSelection ? end : val.length, res.output);
        } else if (isSelection) {
          editor.setSelectionRange(start, end);
          insertTextWithUndo(res.output, editor);
        } else {
          if (val.trim() === '') {
            insertTextWithUndo(res.output, editor);
          } else {
            editor.setSelectionRange(0, editor.value.length);
            insertTextWithUndo(res.output, editor);
          }
        }
        if (unchanged) {
          showMessage(t('cliNoChange', { cmd: cmdStr }), 3500);
        } else {
          onEditorInput(editor);
          showMessage(t('cliSuccess', { cmd: cmdStr }), 2500);
        }
      }

      resetCliFilterUI();
      if (cliFilterBar) cliFilterBar.classList.add('hidden');
    } catch (e) {
      const openErrorInNewTab = !config.cli || config.cli.openErrorInNewTab !== false;

      if (openErrorInNewTab) {
        const isJa = (config.general && config.general.language) === 'ja';
        const tipText = isJa
          ? '> **ヒント**: 上部のコマンド入力バーからコマンドを修正し、`Enter` を押すと即座に再実行できます。キャンセルする場合は `Escape` を押してください。'
          : '> **Tip**: Modify your command in the top bar and press `Enter` to re-execute immediately, or `Escape` to cancel.';
        const errContent = `# CLI Execution Exception

- **Command**: \`${cmdStr}\`
- **Error**: \`${e.message || String(e)}\`
- **Timestamp**: ${getFormattedDateTime('header').trim()}

## Exception Details
\`\`\`
${e.stack || e.message || String(e)}
\`\`\`
---
${tipText}
`;
        const errTab = createTab('[Error] cli-exception.md', errContent);
        errTab.isAutoTitle = false;
        selectTab(errTab.id);
        showMessage(t('cliErrorTabOpened'), 6000);
      } else {
        showMessage(t('cliError', { err: e.message || String(e) }), 5000);
      }

      resetCliFilterUI();
      if (cliFilterBar) cliFilterBar.classList.remove('hidden');
      if (cliFilterBadge) {
        cliFilterBadge.textContent = 'ERROR';
        cliFilterBadge.style.background = '#d9534f';
      }
      if (cliFilterInput) {
        cliFilterInput.disabled = false;
        cliFilterInput.value = cmdStr;
        cliFilterInput.focus();
        cliFilterInput.select();
      }
      const activeEd = getActiveEditor();
      if (activeEd) positionCliBar(activeEd);
    }
  }

  if (cliFilterInput) {
    cliFilterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (isImeComposingKey(e)) return;
        e.preventDefault();
        executeCliFilter();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCliFilterBar();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !isImeComposingKey(e)) {
        e.preventDefault();
        toggleCommandBarMode();
      }
    });
    cliFilterInput.addEventListener('input', () => {
      updateCliFilterPreview();
    });
  }
  if (btnCliFilterExpand) btnCliFilterExpand.onclick = toggleCliFilterPreview;
  if (btnCliFilterSend) btnCliFilterSend.onclick = executeCliFilter;
  if (btnCliFilterClose) btnCliFilterClose.onclick = closeCliFilterBar;

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
      showMessage(t('noTextForMermaid'), 3000);
      return;
    }

    const reqId = genReqId('mermaid_');
    const anchorId = `[${t('generatingMermaidAnchor')}]`;

    const insertPos = selEnd > selStart ? selEnd : editorEl.selectionEnd;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    registerPendingLLMRequest(reqId, {
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
      showMessage(t('noMermaidFound'), 4000);
      return;
    }

    // Check Gemini API key (priority: image > vision > text)
    const apiKey = (config.image && config.image.apiKey) || (config.vision && config.vision.apiKey) || (config.text && config.text.apiKey) || '';
    if (!apiKey && (!window.backend || !window.backend.generateImageAsync)) {
      showMessage(t('geminiKeyRequired'), 4000);
      return;
    }

    const reqId = genReqId('img_');
    const anchorId = `[${t('generatingImageAnchor')}]`;

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

    registerPendingLLMRequest(reqId, {
      tabId: curTab.id,
      anchorId: anchorId
    });

    updateLLMIndicator();

    const imageGenPrompt = buildInfographicImagePrompt(mermaidCode, curTab.content);
    const imageModel = (config.image && config.image.model) || 'gemini-3.1-flash-lite-image';
    const imageAspect = (config.image && config.image.aspectRatio) || '16:9';
    const imageRes = (config.image && config.image.resolution) || '1024';

    // Ensure Gemini endpoint is used for image generation (do not inherit local vision baseUrl)
    let imageBaseUrl = (config.image && config.image.baseUrl) || '';
    if (!imageBaseUrl || imageBaseUrl.includes('localhost') || imageBaseUrl.includes('127.0.0.1') || imageBaseUrl.startsWith('http://')) {
      if (config.vision && config.vision.baseUrl && !config.vision.baseUrl.includes('localhost') && !config.vision.baseUrl.includes('127.0.0.1') && !config.vision.baseUrl.startsWith('http://')) {
        imageBaseUrl = config.vision.baseUrl;
      } else {
        imageBaseUrl = 'https://generativelanguage.googleapis.com';
      }
    }

    const imageConfig = {
      baseUrl: imageBaseUrl,
      model: imageModel,
      apiKey: apiKey,
      aspectRatio: imageAspect,
      resolution: imageRes
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
      showMessage(t('noMermaidFound'), 4000);
      return;
    }

    const reqId = genReqId('imgprompt_');
    const anchorId = `[${t('extractingPromptAnchor')}]`;

    const insertPos = editorEl.selectionEnd;
    editorEl.setSelectionRange(insertPos, insertPos);
    const insertion = `\n\n${anchorId}\n\n`;
    insertTextWithUndo(insertion);

    curTab.content = editorEl.value;
    curTab.isDirty = true;
    renderTabs();
    updateLineNumbers();
    updateStatusBar();

    registerPendingLLMRequest(reqId, {
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
    const newTabSc = getShortcutDisplay('newTab', isMac ? 'Cmd+N' : 'Ctrl+N');
    const baseCommands = [
      {
        id: 'cmd_new_tab',
        title: t('cmdPaletteNewTab'),
        desc: t('cmdPaletteNewTabDesc', { sc: newTabSc }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
        action: () => createTab()
      },
      {
        id: 'cmd_open_file',
        title: t('cmdPaletteOpenFile'),
        desc: t('cmdPaletteOpenFileDesc', { sc: getShortcutDisplay('openFile', isMac ? 'Cmd+O' : 'Ctrl+O') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        action: () => openFile()
      },
      {
        id: 'cmd_open_folder',
        title: t('cmdPaletteOpenFolder'),
        desc: t('cmdPaletteOpenFolderDesc', { sc: getShortcutDisplay('openFolder', isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        action: () => openFolder()
      },
      {
        id: 'cmd_ask_ai',
        title: t('cmdPaletteAskAi'),
        desc: paletteDescWithShortcut('cmdPaletteAskAiDesc', 'inlinePrompt'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.8L21 12l-6.6 3.2L12 22l-2.4-6.8L3 12l6.6-3.2L12 2z"/></svg>',
        action: () => openInlinePromptBar()
      },
      {
        id: 'cmd_command_bar',
        title: t('cmdPaletteCommandBar'),
        desc: paletteDescWithShortcut('cmdPaletteCommandBarDesc', 'commandBar'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        action: () => openCommandBar()
      },
      {
        id: 'cmd_cli_filter',
        title: t('cmdPaletteCliFilter'),
        desc: paletteDescWithShortcut('cmdPaletteCliFilterDesc', 'runCliFilter'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        action: () => openCommandBar('cli')
      },
      {
        id: 'cmd_ai_cli',
        title: t('cmdPaletteAiCli'),
        desc: paletteDescWithShortcut('cmdPaletteAiCliDesc', 'runAiCli'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/><circle cx="17" cy="7" r="3"/></svg>',
        action: () => openCommandBar('ai')
      },
      {
        id: 'cmd_snippets',
        title: t('cmdPaletteSnippets'),
        desc: t('cmdPaletteSnippetsDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>',
        action: () => { if (window.SlotAgent && window.SlotAgent.openSnippetPicker) window.SlotAgent.openSnippetPicker(); }
      },
      {
        id: 'cmd_mobile_drop',
        title: t('cmdPaletteMobileDrop'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
        desc: t('cmdPaletteMobileDropDesc', { sc: getShortcutDisplay('mobileDrop', isMac ? 'Cmd+Shift+U' : 'Ctrl+Shift+U') }),
        action: () => startMobileDrop()
      },
      {
        id: 'cmd_voice_input',
        title: t('cmdPaletteVoiceInput'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
        desc: voiceInputPaletteDesc(),
        action: () => { if (window.VoiceInput) window.VoiceInput.toggle(); }
      },
      ...((window.backend && window.backend.openQuickCapture) ? [{
        id: 'cmd_quick_capture',
        title: t('cmdPaletteQuickCapture'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2.5"/><line x1="6" y1="12" x2="12" y2="12"/><line x1="16" y1="10" x2="16" y2="14"/></svg>',
        desc: paletteDescWithShortcut('cmdPaletteQuickCaptureDesc', 'quickCapture'),
        action: () => { Promise.resolve(window.backend.openQuickCapture()).catch(() => {}); }
      }] : []),
      ...((window.backend && window.backend.openInboxFolder && config.inbox && config.inbox.enabled) ? [{
        id: 'cmd_open_inbox',
        title: t('cmdPaletteOpenInbox'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
        desc: t('cmdPaletteOpenInboxDesc'),
        action: () => { Promise.resolve(window.backend.openInboxFolder()).catch((e) => showMessage(String((e && e.message) || e), 4000)); }
      }] : []),
      {
        id: 'cmd_pipe_polish',
        title: t('cmdPalettePipePolish'),
        desc: t('cmdPalettePipePolishDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.8L21 12l-6.6 3.2L12 22l-2.4-6.8L3 12l6.6-3.2L12 2z"/></svg>',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = t('cmdPalettePipePolishPrompt');
        }
      },
      {
        id: 'cmd_pipe_bullets',
        title: t('cmdPalettePipeBullets'),
        desc: t('cmdPalettePipeBulletsDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = t('cmdPalettePipeBulletsPrompt');
        }
      },
      {
        id: 'cmd_pipe_tasks',
        title: t('cmdPalettePipeTasks'),
        desc: t('cmdPalettePipeTasksDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
        action: () => {
          openInlinePromptBar();
          if (inlinePromptInput) inlinePromptInput.value = t('cmdPalettePipeTasksPrompt');
        }
      },
      {
        id: 'cmd_convert_mermaid',
        title: t('cmdPaletteConvertMermaid'),
        desc: t('cmdPaletteConvertMermaidDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M10 6.5h4a2 2 0 0 1 2 2v5.5"/></svg>',
        action: () => convertSelectionToMermaid()
      },
      {
        id: 'cmd_mermaid_to_image',
        title: t('cmdPaletteMermaidToImage'),
        desc: t('cmdPaletteMermaidToImageDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        action: () => generateImageFromMermaid()
      },
      {
        id: 'cmd_mermaid_to_prompt',
        title: t('cmdPaletteMermaidToPrompt'),
        desc: t('cmdPaletteMermaidToPromptDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        action: () => generateImagePromptFromMermaid()
      },
      {
        id: 'cmd_ai_correct',
        title: t('cmdPaletteAiCorrect'),
        desc: t('cmdPaletteAiCorrectDesc', { sc: getShortcutDisplay('aiCorrection', isMac ? 'Cmd+Shift+C' : 'Alt+C') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
        action: () => triggerAICorrection()
      },
      {
        id: 'cmd_export_plain',
        title: t('cmdPaletteExportPlain'),
        desc: t('cmdPaletteExportPlainDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        action: () => exportPlainText()
      },
      {
        id: 'cmd_toggle_zen',
        title: t('cmdPaletteToggleZen'),
        desc: t('cmdPaletteToggleZenDesc', { sc: getShortcutDisplay('zenMode', isMac ? 'Ctrl+Cmd+Z' : 'Shift+F11') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" stroke-width="1.5"/><path stroke-width="1.5" d="M12 9L12 1.4M14.12 9.88L19.5 4.5M15 12L22.6 12M14.12 14.12L19.5 19.5M12 15L12 22.6M9.88 14.12L4.5 19.5M9 12L1.4 12M9.88 9.88L4.5 4.5"/></svg>',
        action: () => toggleZenMode()
      },
      {
        id: 'cmd_toggle_fullscreen',
        title: t('cmdPaletteToggleFullscreen'),
        desc: t('cmdPaletteToggleFullscreenDesc', { sc: getShortcutDisplay('toggleFullscreen', isMac ? 'Ctrl+Cmd+F' : 'F11') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        action: () => toggleFullscreen()
      },
      {
        id: 'cmd_toggle_split',
        title: t('cmdPaletteToggleSplit'),
        desc: t('cmdPaletteToggleSplitDesc', { sc: getShortcutDisplay('toggleSplit', isMac ? 'Cmd+\\' : 'Ctrl+\\') }),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><line x1="12" y1="3" x2="12" y2="21"/></svg>',
        action: () => toggleSplitMode()
      }
    ];

    // Add workspace notes as searchable entries
    const noteCommands = (workspaceNotes || []).map(note => ({
      id: `note_${note.path}`,
      title: note.title,
      desc: `${note.relPath} — ${note.snippet}`,
      iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
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
    quickPickInput.placeholder = t('cmdPalettePlaceholder');
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
        <div class="quick-pick-item-main">
          ${item.iconSvg ? `<span class="quick-pick-item-icon">${item.iconSvg}</span>` : ''}
          <div class="quick-pick-item-content">
            <div class="quick-pick-item-title">${escapeHtml(item.title)}</div>
            ${item.desc ? `<div class="quick-pick-item-desc">${escapeHtml(item.desc)}</div>` : ''}
          </div>
        </div>
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


  // Huge notes: laying out everything before the caret in the mirror costs ~0.45 ms per 1000
  // characters (about 2 s per call at 3 MB, on every pause in typing with the cursor aura on, on
  // Ctrl+J, ...). Above CHAR_MIRROR_FULL_LIMIT characters only a window is measured: from the start
  // of the line CHAR_MIRROR_WINDOW_LINES above the caret's line (fewer if that would be more than
  // CHAR_MIRROR_WINDOW_CHARS characters; the caret's own line is always whole, so `left` and the
  // wrapped row stay exact) down to the caret.
  const CHAR_MIRROR_FULL_LIMIT = 150000;
  const CHAR_MIRROR_WINDOW_LINES = 300;
  const CHAR_MIRROR_WINDOW_CHARS = 40000;

  // Offset where the measured window starts: a line start, at most maxLines lines above the line
  // that holds charIndex and not making the window from there to charIndex longer than maxChars.
  function charMirrorWindowStart(text, charIndex, maxLines, maxChars) {
    // (lastIndexOf clamps a negative fromIndex to 0, hence the explicit guards.)
    let start = charIndex > 0 ? text.lastIndexOf('\n', charIndex - 1) + 1 : 0;
    for (let n = 0; n < maxLines && start > 0; n++) {
      const above = start > 1 ? text.lastIndexOf('\n', start - 2) + 1 : 0;
      if (charIndex - above > maxChars) break;
      start = above;
    }
    return start;
  }

  // Height of the skippedLines logical lines that are not measured: their share of the content
  // height the textarea itself reports (wrapped rows included), i.e. the average line height.
  function estimateSkippedHeight(skippedLines, totalLines, contentHeight) {
    if (!(skippedLines > 0 && totalLines > 0 && contentHeight > 0)) return 0;
    return skippedLines * (contentHeight / totalLines);
  }

  // Accurate pixel coordinate calculation (top & left) for character offset in textarea.
  // One hidden off-screen mirror is kept alive per editor; its styles are only
  // re-copied when they can have changed (font size / zoom, theme, window or
  // split-pane resize), instead of running getComputedStyle plus a DOM
  // insert/remove on every single call.
  // In a huge note (see CHAR_MIRROR_FULL_LIMIT) `left` is still exact and so is `top` near the
  // start and the end of the note; elsewhere `top` is an estimate (flagged with estimated: true):
  // exact inside the window, the lines above it counted at the average line height.
  function getCharPixelCoords(charIndex, targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return { top: 0, left: 0 };
    try {
      let entry = charMirrors.get(editor);
      if (!entry) {
        const mirror = document.createElement('div');
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.pointerEvents = 'none';
        mirror.style.top = '0';
        mirror.style.left = '-9999px';
        const span = document.createElement('span');
        span.textContent = '|';
        // Only cache once the node is actually in the document: if the host
        // cannot append (e.g. unit-test stub), fall through to the estimate.
        document.body.appendChild(mirror);
        entry = { mirror: mirror, span: span, width: -1, generation: -1, paddingY: 0 };
        charMirrors.set(editor, entry);
      }

      const width = editor.clientWidth;
      if (entry.generation !== charMirrorGeneration || entry.width !== width) {
        const style = window.getComputedStyle(editor);
        const ms = entry.mirror.style;
        entry.paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        ms.width = `${width}px`;
        ms.fontFamily = style.fontFamily;
        ms.fontSize = style.fontSize;
        ms.lineHeight = style.lineHeight;
        ms.padding = style.padding;
        ms.boxSizing = style.boxSizing;
        ms.whiteSpace = style.whiteSpace;
        ms.wordWrap = style.wordWrap;
        ms.tabSize = style.tabSize;
        entry.width = width;
        entry.generation = charMirrorGeneration;
      }

      const text = editor.value;
      if (text.length > CHAR_MIRROR_FULL_LIMIT) {
        // substring() semantics for the caret: NaN and negatives mean 0, too large means the end.
        const caret = Math.min(Math.max(charIndex, 0) || 0, text.length);
        // Near the end of the note count from the bottom instead: the distance from the caret to
        // the end is measured, and the textarea's own scrollHeight gives the rest exactly.
        const fromBottom = text.length - caret <= CHAR_MIRROR_WINDOW_CHARS && editor.scrollHeight > 0;
        const windowStart = charMirrorWindowStart(text, caret, fromBottom ? 0 : CHAR_MIRROR_WINDOW_LINES, CHAR_MIRROR_WINDOW_CHARS);
        if (windowStart > 0) {
          entry.mirror.textContent = text.substring(windowStart, caret);
          entry.mirror.appendChild(entry.span);
          if (fromBottom) {
            let tail = text.substring(caret);
            // A textarea shows a trailing newline as one more (empty) row; a plain div does not.
            if (tail.charCodeAt(tail.length - 1) === 10) tail += '\u200b';
            if (tail) entry.mirror.appendChild(document.createTextNode(tail));
            return {
              top: Math.round(editor.scrollHeight - (entry.mirror.offsetHeight - entry.span.offsetTop)),
              left: entry.span.offsetLeft
            };
          }
          const skipped = estimateSkippedHeight(
            countNewlines(text, windowStart),
            countNewlines(text) + 1,
            editor.scrollHeight - entry.paddingY
          );
          return { top: Math.round(entry.span.offsetTop + skipped), left: entry.span.offsetLeft, estimated: true };
        }
      }

      const before = text.substring(0, charIndex);
      entry.mirror.textContent = before;
      entry.mirror.appendChild(entry.span);

      return { top: entry.span.offsetTop, left: entry.span.offsetLeft };
    } catch (e) {
      const lineNum = editor.value.substring(0, charIndex).split('\n').length;
      return { top: (lineNum - 1) * 22, left: 14 };
    }
  }

  function getCharPixelTop(charIndex, targetEditor) {
    return getCharPixelCoords(charIndex, targetEditor).top;
  }

  // Floating UI that hangs off the caret (Command Bar, inline prompt) must stay on screen: an
  // estimated `top` (huge note) can be far off, so pin it to the visible part of the editor.
  function keepCoordsInView(coords, editor) {
    if (!coords.estimated) return coords;
    const lineHeight = Math.max(22, Math.round(currentFontSize * 1.6));
    const top = Math.min(Math.max(coords.top, editor.scrollTop), editor.scrollTop + editor.clientHeight - lineHeight);
    return { top: top, left: coords.left };
  }

  // A scroll computed from an estimated `top` can miss the caret in a huge note. The browser
  // scrolls a textarea to its caret when the field takes focus, so let it finish the job. It only
  // does that for a collapsed caret, not for a range: collapse to the start, then put the range back.
  function revealCaretInHugeNote(editor) {
    if (editor.value.length <= CHAR_MIRROR_FULL_LIMIT) return;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const direction = editor.selectionDirection;
    editor.setSelectionRange(start, start);
    editor.blur();
    editor.focus();
    editor.setSelectionRange(start, end, direction);
  }

  // Sibling frontend modules (SlotAgent quick selector, JevAction panel docking)
  // need caret pixel coordinates; expose the single implementation rather than
  // letting them duplicate the mirror-measurement logic.
  window.getCharPixelCoords = getCharPixelCoords;

  // --- Subtle Cursor Aura (Ambient Affordance Engine) ---

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
      // Called on every scroll event: skip entirely when already hidden, and
      // restore the transition on the next frame instead of forcing a
      // synchronous layout with offsetHeight. Visually identical.
      if (cursorAuraEl.style.display === 'none' && !cursorAuraEl.classList.contains('active')) {
        return;
      }
      cursorAuraEl.style.transition = 'none';
      cursorAuraEl.classList.remove('active');
      cursorAuraEl.style.display = 'none';
      requestAnimationFrame(() => {
        if (cursorAuraEl) cursorAuraEl.style.transition = '';
      });
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
    const editor = getActiveEditor();
    if (isPreviewMode || !editor) return;

    cursorAuraTimer = setTimeout(() => {
      showCursorAura();
    }, CURSOR_AURA_IDLE_DELAY);
  }

  function showCursorAura() {
    if (!config.general || config.general.cursorAura === false) return;
    const editor = getActiveEditor();
    if (isPreviewMode || !editor || !cursorAuraEl) return;

    // Only activate if active editor is focused or window has focus
    if (document.activeElement !== editor && !document.hasFocus()) return;

    // Ensure cursorAuraEl is appended to the wrapper of the currently active editor
    const wrapper = editor.parentElement;
    if (wrapper && cursorAuraEl.parentElement !== wrapper) {
      wrapper.insertBefore(cursorAuraEl, editor);
    }

    const cursorPos = editor.selectionStart;
    const coords = getCharPixelCoords(cursorPos, editor);

    // Calculate position relative to editor-wrapper considering textarea scroll offset
    const x = coords.left - editor.scrollLeft;
    const y = coords.top - editor.scrollTop + 10; // align with middle of font line

    // Verify coordinates are within editor viewport
    if (x < 0 || x > editor.clientWidth || y < 0 || y > editor.clientHeight) {
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

  function openFindBar(showReplace = false) {
    findReplaceBar.classList.remove('hidden');
    if (showReplace) {
      replaceRow.classList.remove('hidden');
      btnToggleReplace.textContent = '▼';
    }
    const editor = getActiveEditor();
    if (editor) {
      const selStart = editor.selectionStart;
      const selEnd = editor.selectionEnd;
      if (selEnd > selStart) {
        const selected = editor.value.substring(selStart, selEnd);
        if (!selected.includes('\n')) {
          findInput.value = selected;
        }
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
    cancelPendingSearch();
    findReplaceBar.classList.add('hidden');
    findMatches = [];
    currentMatchIndex = -1;
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  function toggleReplaceRow() {
    const isHidden = replaceRow.classList.toggle('hidden');
    btnToggleReplace.textContent = isHidden ? '▶' : '▼';
    if (!isHidden) {
      replaceInput.focus();
    }
  }

  // searchMatches() scans the whole document with a RegExp and collects every
  // match; running it on each keystroke in the Find box stalls typing on large
  // notes. Debounce it, and flush before anything that acts on the match list.
  const FIND_DEBOUNCE_MS = 120;
  let findSearchTimer = null;

  function searchMatchesDebounced() {
    clearTimeout(findSearchTimer);
    findSearchTimer = setTimeout(() => {
      findSearchTimer = null;
      searchMatches();
    }, FIND_DEBOUNCE_MS);
  }

  function flushPendingSearch() {
    if (findSearchTimer) {
      clearTimeout(findSearchTimer);
      findSearchTimer = null;
      searchMatches();
    }
  }

  function cancelPendingSearch() {
    clearTimeout(findSearchTimer);
    findSearchTimer = null;
  }

  function searchMatches() {
    cancelPendingSearch();
    const query = findInput.value;
    if (!query) {
      findMatches = [];
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
      return;
    }

    const editor = getActiveEditor();
    const text = editor ? editor.value : '';
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
      const cursorPos = editor ? editor.selectionStart : 0;
      let closestIdx = findMatches.findIndex(m => m.start >= cursorPos);
      if (closestIdx === -1) closestIdx = 0;
      currentMatchIndex = closestIdx;
      findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
    }
  }

  function goToMatch(index) {
    if (findMatches.length === 0) return;
    const editor = getActiveEditor();
    if (!editor) return;

    currentMatchIndex = (index + findMatches.length) % findMatches.length;
    const match = findMatches[currentMatchIndex];
    editor.focus();
    editor.setSelectionRange(match.start, match.end);

    const charTop = getCharPixelTop(match.start, editor);
    const viewHeight = editor.clientHeight;
    // Find bar height + top margin is ~75px. We reserve ~80px top buffer so match is not hidden underneath it.
    const topReserved = 85;
    const currentScroll = editor.scrollTop;
    const charBottom = charTop + 24;

    // Check if match is already comfortably in view outside the find bar area
    const isVisible = (charTop >= currentScroll + topReserved) && (charBottom <= currentScroll + viewHeight - 20);
    if (!isVisible) {
      // Center the match in the visible area below the find bar
      const availableHeight = Math.max(100, viewHeight - topReserved);
      const targetScroll = Math.max(0, charTop - topReserved - Math.floor(availableHeight / 3));
      editor.scrollTop = targetScroll;
      if (editor === editorSecondary) {
        if (secondaryLineNumbers) secondaryLineNumbers.scrollTop = targetScroll;
      } else {
        if (lineNumbersEl) lineNumbersEl.scrollTop = targetScroll;
      }
    }
    revealCaretInHugeNote(editor);

    findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
  }

  function findNext() {
    flushPendingSearch();
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    const editor = getActiveEditor();
    const m = findMatches[currentMatchIndex];
    if (editor && m && (editor.selectionStart !== m.start || editor.selectionEnd !== m.end)) {
      goToMatch(currentMatchIndex);
    } else {
      goToMatch(currentMatchIndex + 1);
    }
  }

  function findPrev() {
    flushPendingSearch();
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    const editor = getActiveEditor();
    const m = findMatches[currentMatchIndex];
    if (editor && m && (editor.selectionStart !== m.start || editor.selectionEnd !== m.end)) {
      goToMatch(currentMatchIndex);
    } else {
      goToMatch(currentMatchIndex - 1);
    }
  }

  function replaceOne() {
    flushPendingSearch();
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0 || currentMatchIndex === -1) return;

    const editor = getActiveEditor();
    if (!editor) return;

    const m = findMatches[currentMatchIndex];
    const repVal = replaceInput.value || '';
    const val = editor.value;

    const nextSearchPos = m.start + repVal.length;
    editor.value = val.substring(0, m.start) + repVal + val.substring(m.end);
    const tab = getActiveTab();
    if (tab) {
      tab.content = editor.value;
      tab.isDirty = true;
      renderTabs();
    }
    if (editor === editorSecondary) {
      updateSecondaryLineNumbers();
    } else {
      updateLineNumbers();
    }
    scheduleUpdateStatusBar();
    saveSessionDebounced();

    // Re-run search matches on new content
    searchMatches();
    if (findMatches.length > 0) {
      let nextIdx = findMatches.findIndex(match => match.start >= nextSearchPos);
      if (nextIdx === -1) nextIdx = 0;
      goToMatch(nextIdx);
    } else {
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
    }
  }

  function replaceAll() {
    flushPendingSearch();
    if (findMatches.length === 0) searchMatches();
    if (findMatches.length === 0) return;

    const editor = getActiveEditor();
    if (!editor) return;

    const query = findInput.value;
    const repVal = replaceInput.value || '';
    const text = editor.value;

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

      editor.value = text.replace(regex, repVal);
      const tab = getActiveTab();
      if (tab) {
        tab.content = editor.value;
        tab.isDirty = true;
        renderTabs();
      }
      if (editor === editorSecondary) {
        updateSecondaryLineNumbers();
      } else {
        updateLineNumbers();
      }
      scheduleUpdateStatusBar();
      saveSessionDebounced();
      searchMatches();
    } catch (e) {
      console.warn('Replace all regex error:', e);
    }
  }

  // Find & Replace Input and Button Events
  findInput.addEventListener('input', searchMatchesDebounced);
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

  // --- Mobile Drop QR Sync (Ctrl+Shift+U / Cmd+Shift+U) ---
  let mobileDropCountdownTimer = null;
  let mobileDropRemainingSeconds = 0;

  function appendToActiveBuffer(text) {
    const editor = getActiveEditor();
    const tab = getActiveTab();
    if (!editor || !tab) {
      showMessage(t('mobileDropNoActiveTab'), 3000);
      return;
    }
    const endPos = editor.value.length;
    editor.setSelectionRange(endPos, endPos);
    insertTextWithUndo(text, editor);
    // Same bookkeeping as typing (dirty flag, line numbers, status bar, autosave, session
    // save, live preview). skipAutocomplete: a ghost suggestion is not wanted after a paste.
    onEditorInput(editor, tab, true);
    editor.scrollTop = editor.scrollHeight;
  }

  function stopMobileDropCountdown() {
    if (mobileDropCountdownTimer) {
      clearInterval(mobileDropCountdownTimer);
      mobileDropCountdownTimer = null;
    }
  }

  function startMobileDropCountdown(seconds) {
    stopMobileDropCountdown();
    mobileDropRemainingSeconds = Math.max(0, Math.floor(seconds) || 60);
    if (mobileDropCountdownEl) mobileDropCountdownEl.textContent = String(mobileDropRemainingSeconds);
    mobileDropCountdownTimer = setInterval(() => {
      mobileDropRemainingSeconds -= 1;
      if (mobileDropRemainingSeconds < 0) {
        stopMobileDropCountdown();
        return;
      }
      if (mobileDropCountdownEl) mobileDropCountdownEl.textContent = String(mobileDropRemainingSeconds);
    }, 1000);
  }

  function isMobileDropModalOpen() {
    return !!(mobileDropModal && !mobileDropModal.classList.contains('hidden'));
  }

  function showMobileDropError(message) {
    if (!mobileDropModal) return;
    mobileDropModal.classList.remove('hidden');
    if (mobileDropLoading) mobileDropLoading.classList.add('hidden');
    if (mobileDropContent) mobileDropContent.classList.add('hidden');
    if (mobileDropErrorEl) {
      mobileDropErrorEl.classList.remove('hidden');
      mobileDropErrorEl.textContent = message;
    }
  }

  function closeMobileDropModal() {
    if (mobileDropModal) mobileDropModal.classList.add('hidden');
    stopMobileDropCountdown();
    resetMobileDropTunnelUI();
    unbindMobileDropSharedTextListeners();
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  function resetMobileDropTunnelUI() {
    if (btnMobileDropTunnel) {
      btnMobileDropTunnel.disabled = false;
      btnMobileDropTunnel.classList.remove('hidden');
    }
    if (mobileDropTunnelStatusEl) {
      mobileDropTunnelStatusEl.classList.add('hidden');
      mobileDropTunnelStatusEl.classList.remove('error');
      mobileDropTunnelStatusEl.textContent = '';
    }
    if (mobileDropHintEl) {
      mobileDropHintEl.textContent = t('mobileDropHint');
    }
    hideMobileDropInstall();
  }

  // The install command offered when cloudflared is missing, with a Copy button.
  let mobileDropCopiedTimer = null;

  function hideMobileDropInstall() {
    clearTimeout(mobileDropCopiedTimer);
    if (mobileDropInstallEl) mobileDropInstallEl.classList.add('hidden');
    if (mobileDropInstallCmdEl) mobileDropInstallCmdEl.textContent = '';
    if (mobileDropInstallCopyLabelEl) mobileDropInstallCopyLabelEl.textContent = t('mobileDropCopy');
  }

  function showMobileDropInstall(command) {
    if (!mobileDropInstallEl || !mobileDropInstallCmdEl) return;
    clearTimeout(mobileDropCopiedTimer);
    mobileDropInstallCmdEl.textContent = command;
    if (mobileDropInstallCopyLabelEl) mobileDropInstallCopyLabelEl.textContent = t('mobileDropCopy');
    mobileDropInstallEl.classList.remove('hidden');
  }

  // navigator.clipboard needs a secure context and a user gesture; some webviews refuse it, so
  // fall back to a throw-away textarea + execCommand. Resolves to whether anything was copied.
  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through to the legacy path */ }
    const previouslyFocused = document.activeElement;
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    document.body.removeChild(scratch);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    return copied;
  }

  async function copyMobileDropInstallCommand() {
    const command = mobileDropInstallCmdEl ? mobileDropInstallCmdEl.textContent : '';
    if (!command || !mobileDropInstallCopyLabelEl) return;
    const copied = await copyTextToClipboard(command);
    if (!copied && window.getSelection && document.createRange) {
      // Could not write to the clipboard: select the command so Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(mobileDropInstallCmdEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    mobileDropInstallCopyLabelEl.textContent = t(copied ? 'mobileDropCopied' : 'mobileDropCopyFailed');
    clearTimeout(mobileDropCopiedTimer);
    mobileDropCopiedTimer = setTimeout(() => {
      mobileDropInstallCopyLabelEl.textContent = t('mobileDropCopy');
    }, 2000);
  }

  // Applies a MobileDropInfo response (from either startMobileDrop or a
  // successful tunnel switch) to the already-visible modal content. A
  // brief opacity fade on the QR image marks a genuine mode switch without
  // introducing a new visual language for the initial (local) display.
  function applyMobileDropInfo(info, opts) {
    const animate = !!(opts && opts.animate);
    const applyNow = () => {
      if (!isMobileDropModalOpen()) return; // closed during the fade: do not restart the countdown
      if (info && info.qrDataUri && mobileDropQrImg) {
        mobileDropQrImg.src = info.qrDataUri;
        mobileDropQrImg.classList.remove('hidden');
      } else if (mobileDropQrImg) {
        mobileDropQrImg.classList.add('hidden');
      }
      if (mobileDropUrlEl) mobileDropUrlEl.textContent = (info && info.url) || '';
      startMobileDropCountdown((info && info.idleTimeoutSeconds) || 60);
      if (animate && mobileDropQrImg) {
        // Force reflow so the re-added transition actually animates in.
        void mobileDropQrImg.offsetWidth;
        mobileDropQrImg.classList.remove('swapping');
      }
    };

    if (animate && mobileDropQrImg) {
      mobileDropQrImg.classList.add('swapping');
      setTimeout(applyNow, 180);
    } else {
      applyNow();
    }
  }

  // --- PC -> phone shared text (机能 5A): pushes the active editor's selection (or, if none,
  // one clipboard read attempt) to the phone while a session is open, kept in sync as the
  // selection changes. Listeners are bound only for the lifetime of the session (added in
  // startMobileDrop, removed in closeMobileDropModal) so this costs nothing otherwise.
  const MOBILE_DROP_SHARED_TEXT_MAX = 64 * 1024;
  const MOBILE_DROP_SHARED_TEXT_DEBOUNCE_MS = 400;
  let mobileDropSharedTextTimer = null;
  let mobileDropSharedTextListenersBound = false;

  function currentEditorSelectionText() {
    const editor = getActiveEditor();
    if (!editor) return '';
    return editor.value.substring(editor.selectionStart, editor.selectionEnd);
  }

  function truncateForPreview(text, max) {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
  }

  function updateMobileDropSharedPreview(text) {
    if (!mobileDropSharedPreviewEl) return;
    if (!text) {
      mobileDropSharedPreviewEl.classList.add('hidden');
      mobileDropSharedPreviewEl.textContent = '';
      return;
    }
    mobileDropSharedPreviewEl.classList.remove('hidden');
    mobileDropSharedPreviewEl.textContent = t('mobileDropSharingPreview', { text: truncateForPreview(text, 80) });
  }

  function pushMobileDropSharedText(text) {
    if (!(window.backend && window.backend.setMobileDropSharedText)) return;
    let capped = text;
    if (capped.length > MOBILE_DROP_SHARED_TEXT_MAX) capped = capped.slice(0, MOBILE_DROP_SHARED_TEXT_MAX);
    window.backend.setMobileDropSharedText(capped);
    updateMobileDropSharedPreview(capped);
  }

  function scheduleMobileDropSharedTextPush() {
    if (!isMobileDropModalOpen()) return;
    clearTimeout(mobileDropSharedTextTimer);
    mobileDropSharedTextTimer = setTimeout(() => pushMobileDropSharedText(currentEditorSelectionText()), MOBILE_DROP_SHARED_TEXT_DEBOUNCE_MS);
  }

  function bindMobileDropSharedTextListeners() {
    if (mobileDropSharedTextListenersBound) return;
    mobileDropSharedTextListenersBound = true;
    editorEl.addEventListener('select', scheduleMobileDropSharedTextPush);
    editorEl.addEventListener('mouseup', scheduleMobileDropSharedTextPush);
    editorEl.addEventListener('keyup', scheduleMobileDropSharedTextPush);
    if (editorSecondary) {
      editorSecondary.addEventListener('select', scheduleMobileDropSharedTextPush);
      editorSecondary.addEventListener('mouseup', scheduleMobileDropSharedTextPush);
      editorSecondary.addEventListener('keyup', scheduleMobileDropSharedTextPush);
    }
  }

  function unbindMobileDropSharedTextListeners() {
    if (!mobileDropSharedTextListenersBound) return;
    mobileDropSharedTextListenersBound = false;
    clearTimeout(mobileDropSharedTextTimer);
    editorEl.removeEventListener('select', scheduleMobileDropSharedTextPush);
    editorEl.removeEventListener('mouseup', scheduleMobileDropSharedTextPush);
    editorEl.removeEventListener('keyup', scheduleMobileDropSharedTextPush);
    if (editorSecondary) {
      editorSecondary.removeEventListener('select', scheduleMobileDropSharedTextPush);
      editorSecondary.removeEventListener('mouseup', scheduleMobileDropSharedTextPush);
      editorSecondary.removeEventListener('keyup', scheduleMobileDropSharedTextPush);
    }
    updateMobileDropSharedPreview('');
  }

  // First push at session start: the current selection, or (if there is none) one silent
  // clipboard read attempt - denial/absence is ignored, since this is a nice-to-have.
  async function pushInitialMobileDropSharedText() {
    let text = currentEditorSelectionText();
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      try { text = await navigator.clipboard.readText(); } catch (e) { text = ''; }
    }
    if (!isMobileDropModalOpen()) return; // closed while the clipboard read was in flight
    pushMobileDropSharedText(text || '');
  }

  async function startMobileDrop() {
    if (!mobileDropModal || isMobileDropModalOpen()) return;

    mobileDropModal.classList.remove('hidden');
    if (mobileDropLoading) mobileDropLoading.classList.remove('hidden');
    if (mobileDropContent) mobileDropContent.classList.add('hidden');
    if (mobileDropErrorEl) mobileDropErrorEl.classList.add('hidden');
    resetMobileDropTunnelUI();

    if (!(window.backend && (window.backend.startMobileDropWithVoice || window.backend.startMobileDrop))) {
      showMobileDropError(t('mobileDropUnavailable'));
      return;
    }

    try {
      // Voice recordings dropped from the phone need the same voice settings as PC recording,
      // including the fall back to the vision (OCR) key/base URL: VoiceInput builds both. The
      // timeout stays at the backend's own default (0) because a phone recording can be long.
      const voiceJSON = window.VoiceInput && window.VoiceInput.configJSON
        ? window.VoiceInput.configJSON(config, { timeout: 0 })
        : '{}';

      const info = window.backend.startMobileDropWithVoice
        ? await window.backend.startMobileDropWithVoice(JSON.stringify(config.vision || {}), voiceJSON)
        : await window.backend.startMobileDrop(JSON.stringify(config.vision || {}));
      if (!isMobileDropModalOpen()) return; // user cancelled while the request was in flight

      if (mobileDropLoading) mobileDropLoading.classList.add('hidden');
      if (mobileDropContent) mobileDropContent.classList.remove('hidden');
      if (btnMobileDropTunnel) {
        btnMobileDropTunnel.classList.toggle('hidden', !(window.backend && window.backend.requestMobileDropTunnel));
      }
      applyMobileDropInfo(info, { animate: false });

      bindMobileDropSharedTextListeners();
      pushInitialMobileDropSharedText();
    } catch (err) {
      showMobileDropError((err && err.message) ? err.message : String(err));
    }
  }

  function cancelMobileDrop() {
    const wasOpen = isMobileDropModalOpen();
    closeMobileDropModal();
    if (wasOpen && window.backend && window.backend.cancelMobileDrop) {
      window.backend.cancelMobileDrop();
    }
  }

  function requestMobileDropTunnel() {
    if (!isMobileDropModalOpen() || !btnMobileDropTunnel || btnMobileDropTunnel.disabled) return;
    if (!(window.backend && window.backend.requestMobileDropTunnel)) {
      if (mobileDropTunnelStatusEl) {
        mobileDropTunnelStatusEl.classList.remove('hidden');
        mobileDropTunnelStatusEl.classList.add('error');
        mobileDropTunnelStatusEl.textContent = t('mobileDropUnavailable');
      }
      return;
    }
    btnMobileDropTunnel.disabled = true;
    hideMobileDropInstall(); // retrying after installing cloudflared
    if (mobileDropTunnelStatusEl) {
      mobileDropTunnelStatusEl.classList.remove('hidden', 'error');
      mobileDropTunnelStatusEl.textContent = t('mobileDropTunnelConnecting');
    }
    window.backend.requestMobileDropTunnel();
  }

  window.__onMobileDropReceived = function (data) {
    closeMobileDropModal();
    if (data && data.content) {
      appendToActiveBuffer(data.content);
    }
    // Photos / voice notes that could not be OCR'd or transcribed were kept as files instead.
    const kept = data && Number(data.fallbackCount) > 0 ? Number(data.fallbackCount) : 0;
    if (kept > 0) showMessage(t('mobileDropReceivedFallback', { count: kept }), 7000);
    else showMessage(t('mobileDropReceived'), 3000);
  };

  window.__onMobileDropTimeout = function () {
    if (isMobileDropModalOpen()) {
      closeMobileDropModal();
      showMessage(t('mobileDropTimedOut'), 3000);
    }
  };

  window.__onMobileDropError = function (data) {
    const msg = (data && data.message) ? data.message : t('mobileDropGenericError');
    showMobileDropError(msg);
  };

  window.__onMobileDropTunnelReady = function (data) {
    if (!isMobileDropModalOpen()) return; // user already cancelled/closed
    if (btnMobileDropTunnel) btnMobileDropTunnel.classList.add('hidden');
    if (mobileDropTunnelStatusEl) mobileDropTunnelStatusEl.classList.add('hidden');
    if (mobileDropHintEl) mobileDropHintEl.textContent = t('mobileDropTunnelHint');
    applyMobileDropInfo(data, { animate: true });
  };

  window.__onMobileDropTunnelError = function (data) {
    if (!isMobileDropModalOpen()) return;
    if (btnMobileDropTunnel) btnMobileDropTunnel.disabled = false;
    // cloudflared missing: say so in the UI language and offer the install command to copy.
    const missing = !!(data && data.code === 'cloudflared_missing' && data.installCommand);
    if (mobileDropTunnelStatusEl) {
      mobileDropTunnelStatusEl.classList.remove('hidden');
      mobileDropTunnelStatusEl.classList.add('error');
      mobileDropTunnelStatusEl.textContent = missing
        ? t('mobileDropCloudflaredMissing')
        : ((data && data.message) ? data.message : t('mobileDropGenericError'));
    }
    if (missing) showMobileDropInstall(data.installCommand);
    else hideMobileDropInstall();
  };

  if (btnMobileDropCancel) btnMobileDropCancel.onclick = cancelMobileDrop;
  if (modalMobileDropClose) modalMobileDropClose.onclick = cancelMobileDrop;
  if (btnMobileDropTunnel) btnMobileDropTunnel.onclick = requestMobileDropTunnel;
  if (btnMobileDropInstallCopy) btnMobileDropInstallCopy.onclick = copyMobileDropInstallCommand;
  if (btnMobileDrop) btnMobileDrop.onclick = () => startMobileDrop();
  if (mobileDropModal) {
    mobileDropModal.addEventListener('mousedown', (e) => {
      if (e.target === mobileDropModal) cancelMobileDrop();
    });
  }

  // --- Toolbar / right-click menu layout (chrome_layout.js) ---
  // Which items are shown and in what order. A layout nobody customised costs nothing: applyAll
  // returns before touching the DOM.
  function applyChromeLayout() {
    if (window.ChromeLayout) window.ChromeLayout.applyAll(config);
  }

  // The settings rows are built only when the section is opened (and redrawn after a language change).
  function renderLayoutEditors() {
    const layoutApi = window.ChromeLayout;
    if (!layoutApi || !layoutToolbarHostEl || !layoutContextHostEl) return;
    const opts = { labels: { up: t('layoutMoveUp'), down: t('layoutMoveDown'), locked: t('layoutAlwaysShown') } };
    layoutApi.renderEditor('toolbar', layoutToolbarHostEl, layoutApi.ensureLayout(config, 'toolbar'), opts);
    layoutApi.renderEditor('context', layoutContextHostEl, layoutApi.ensureLayout(config, 'context'), opts);
  }

  if (layoutDetailsEl) {
    layoutDetailsEl.addEventListener('toggle', () => {
      if (layoutDetailsEl.open) renderLayoutEditors();
    });
  }
  if (btnLayoutReset) {
    btnLayoutReset.onclick = () => {
      const layoutApi = window.ChromeLayout;
      if (!layoutApi) return;
      layoutApi.reset('toolbar', layoutApi.ensureLayout(config, 'toolbar'));
      layoutApi.reset('context', layoutApi.ensureLayout(config, 'context'));
      renderLayoutEditors();
    };
  }

  // --- Go to Line Modal ---
  function openGotoLineModal() {
    const editor = getActiveEditor();
    if (!editor) return;
    const lines = editor.value.split('\n').length;
    const curLine = editor.value.substring(0, editor.selectionStart).split('\n').length;
    gotoLineInput.max = lines;
    gotoLineInput.value = curLine;
    gotoLineModal.classList.remove('hidden');
    gotoLineInput.focus();
    gotoLineInput.select();
  }

  function closeGotoLineModal() {
    gotoLineModal.classList.add('hidden');
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  function gotoLineNumber(targetLine) {
    const editor = getActiveEditor();
    if (!editor) return;
    if (!isNaN(targetLine) && targetLine >= 1) {
      const lines = editor.value.split('\n');
      const clampedLine = Math.min(targetLine, lines.length);
      let charPos = 0;
      for (let i = 0; i < clampedLine - 1; i++) {
        charPos += lines[i].length + 1;
      }
      editor.focus();
      editor.setSelectionRange(charPos, charPos);
      const targetY = getCharPixelTop(charPos, editor);
      const viewHeight = editor.clientHeight;
      const targetScroll = Math.max(0, targetY - Math.floor(viewHeight / 3));
      editor.scrollTop = targetScroll;
      if (editor === editorSecondary) {
        if (secondaryLineNumbers) secondaryLineNumbers.scrollTop = targetScroll;
      } else {
        if (lineNumbersEl) lineNumbersEl.scrollTop = targetScroll;
        if (ghostSuggestion) syncGhostScroll();
      }
      revealCaretInHugeNote(editor);
    }
  }

  function flashEditorLine(lineNum) {
    // (The gutter is blocks of 1000 numbers, not one element per line: nothing to flash there.)
    editorEl.classList.remove('scrap-flash-highlight');
    void editorEl.offsetWidth;
    editorEl.classList.add('scrap-flash-highlight');
    setTimeout(() => editorEl.classList.remove('scrap-flash-highlight'), 1600);
  }

  function executeGotoLine() {
    const targetLine = parseInt(gotoLineInput.value, 10);
    gotoLineNumber(targetLine);
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

  // --- Feature 4: Ultra-fast Scraps In-Memory Search Modal (Ctrl+Shift+F) ---
  let scrapsSearchDebounceTimer = null;
  let scrapsSearchFlattened = [];
  let scrapsSearchSelectedIndex = 0;

  function openScrapsSearchModal() {
    if (!scrapsSearchModal) return;
    scrapsSearchModal.classList.remove('hidden');
    if (scrapsSearchInput) {
      scrapsSearchInput.value = '';
      setTimeout(() => {
        scrapsSearchInput.focus();
        scrapsSearchInput.select();
      }, 40);
    }
    scrapsSearchSelectedIndex = 0;
    scrapsSearchFlattened = [];
    renderScrapsSearchResults([]);
  }

  function closeScrapsSearchModal() {
    if (!scrapsSearchModal) return;
    scrapsSearchModal.classList.add('hidden');
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  if (scrapsSearchModal) {
    scrapsSearchModal.addEventListener('click', (e) => {
      if (e.target === scrapsSearchModal) {
        closeScrapsSearchModal();
      }
    });
  }

  if (btnSearchScraps) {
    btnSearchScraps.onclick = openScrapsSearchModal;
  }

  if (scrapsSearchInput) {
    scrapsSearchInput.addEventListener('input', () => {
      const q = scrapsSearchInput.value.trim();
      clearTimeout(scrapsSearchDebounceTimer);
      if (!q) {
        scrapsSearchFlattened = [];
        renderScrapsSearchResults([]);
        return;
      }
      scrapsSearchDebounceTimer = setTimeout(async () => {
        if (window.backend && window.backend.searchScraps) {
          try {
            const results = await window.backend.searchScraps(q, 100);
            renderScrapsSearchResults(results || []);
          } catch (err) {
            console.error('searchScraps failed:', err);
          }
        }
      }, 150);
    });

    scrapsSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeScrapsSearchModal();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (scrapsSearchFlattened.length > 0) {
          scrapsSearchSelectedIndex = (scrapsSearchSelectedIndex + 1) % scrapsSearchFlattened.length;
          updateScrapsSearchSelection();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (scrapsSearchFlattened.length > 0) {
          scrapsSearchSelectedIndex = (scrapsSearchSelectedIndex - 1 + scrapsSearchFlattened.length) % scrapsSearchFlattened.length;
          updateScrapsSearchSelection();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (scrapsSearchFlattened.length > 0 && scrapsSearchFlattened[scrapsSearchSelectedIndex]) {
          const item = scrapsSearchFlattened[scrapsSearchSelectedIndex];
          jumpToScrap(item.filePath, item.fileName, item.match.lineNumber);
          closeScrapsSearchModal();
        }
      }
    });
  }

  function renderScrapsSearchResults(results) {
    scrapsSearchFlattened = [];
    scrapsSearchSelectedIndex = 0;

    results.forEach(res => {
      if (res.matches) {
        res.matches.forEach(m => {
          scrapsSearchFlattened.push({
            filePath: res.filePath,
            fileName: res.fileName,
            match: m
          });
        });
      }
    });

    if (!scrapsSearchResults) return;

    if (scrapsSearchFlattened.length === 0) {
      const q = scrapsSearchInput ? scrapsSearchInput.value.trim() : '';
      scrapsSearchResults.innerHTML = `<div class="scraps-search-empty">${q ? escapeHtml(t('scrapsSearchNoResults')) : escapeHtml(t('scrapsSearchEmpty'))}</div>`;
      return;
    }

    scrapsSearchResults.innerHTML = scrapsSearchFlattened.map((item, idx) => {
      const isSelected = idx === 0 ? 'active' : '';
      const previewText = item.match.snippet || item.match.lineText;
      return `
        <div class="scraps-match-item ${isSelected}" data-idx="${idx}">
          <div class="scraps-match-header">
            <span class="scraps-match-file">${escapeHtml(item.fileName)}</span>
            <span class="scraps-match-line">Ln ${item.match.lineNumber}</span>
          </div>
          <div class="scraps-match-snippet">${escapeHtml(previewText)}</div>
        </div>
      `;
    }).join('');

    scrapsSearchResults.querySelectorAll('.scraps-match-item').forEach(el => {
      el.onclick = () => {
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && scrapsSearchFlattened[idx]) {
          const item = scrapsSearchFlattened[idx];
          jumpToScrap(item.filePath, item.fileName, item.match.lineNumber);
          closeScrapsSearchModal();
        }
      };
    });
  }

  function updateScrapsSearchSelection() {
    if (!scrapsSearchResults) return;
    const items = scrapsSearchResults.querySelectorAll('.scraps-match-item');
    items.forEach((el, idx) => {
      const isActive = idx === scrapsSearchSelectedIndex;
      el.classList.toggle('active', isActive);
      if (isActive) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  async function jumpToScrap(filePath, fileName, lineNumber) {
    let targetTab = tabs.find(t => t.path === filePath || t.title === fileName);
    if (!targetTab) {
      let content = '';
      if (window.backend && window.backend.readFileByPath) {
        try {
          const res = await window.backend.readFileByPath(filePath);
          if (res) content = res.content;
        } catch (e) {
          console.warn('Failed to read scrap file:', e);
        }
      }
      targetTab = createTab(fileName, content, filePath);
      targetTab.isAutoTitle = false;
      targetTab.isScrap = true;
    }
    selectTab(targetTab.id);

    setTimeout(() => {
      gotoLineNumber(lineNumber);
      flashEditorLine(lineNumber);
    }, 60);
  }

  // --- Feature 2: Webview Scrap Appended Listener ---
  window.onScrapAppended = async function(data) {
    if (!data) return;
    if (data.cwd) lastPipedCwd = data.cwd;

    let targetTab = tabs.find(t => t.path === data.filePath || t.title === data.fileName);
    if (targetTab) {
      if (window.backend && window.backend.readFileByPath) {
        try {
          const res = await window.backend.readFileByPath(data.filePath);
          if (res && res.content !== undefined) {
            targetTab.content = res.content;
            targetTab.isDirty = false;
            if (activeTabId === targetTab.id) {
              editorEl.value = res.content;
              updateLineNumbers();
            }
          }
        } catch (e) {
          console.warn('Failed to refresh scrap tab:', e);
        }
      }
      selectTab(targetTab.id);
      setTimeout(() => {
        editorEl.scrollTop = editorEl.scrollHeight;
      }, 50);
    } else {
      let content = '';
      if (window.backend && window.backend.readFileByPath) {
        try {
          const res = await window.backend.readFileByPath(data.filePath);
          if (res && res.content !== undefined) {
            content = res.content;
          }
        } catch (e) {
          console.warn('Failed to read initial scrap tab:', e);
        }
      }
      const newTab = createTab(data.fileName, content, data.filePath);
      newTab.isAutoTitle = false; // Bypass auto title from 1st line
      newTab.isScrap = true;
      selectTab(newTab.id);
      setTimeout(() => {
        editorEl.scrollTop = editorEl.scrollHeight;
      }, 50);
    }

    showMessage(`Scrap appended: ${data.command || 'CLI Pipe'}`, 2500);
  };

  // --- Feature 3: Webview Git Sync Status Listener ---
  window.onGitSyncStatus = function(info) {
    if (!info) return;
    updateGitSyncStatusUI(info);
  };

  if (statGitSync) {
    statGitSync.onclick = () => {
      const isEnabled = config.scraps ? (config.scraps.gitSyncEnabled !== false) : (config.git_sync_enabled !== false);
      if (!isEnabled) {
        showMessage(t('gitSyncDisabledToast'), 2500);
        return;
      }
      if (window.backend && window.backend.triggerGitSync) {
        window.backend.triggerGitSync();
        showMessage('Triggered Git sync...', 1500);
      }
    };
  }

  // Voice input's ESC-to-abort must beat every other Escape consumer (modals, the Quick
  // Actions panel in jev_action.js, the bubble-phase handler below) and only while actually
  // recording (VoiceInput.handleKeydown returns false otherwise, so this is a no-op the rest
  // of the time). Registered in the capture phase for that reason.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.VoiceInput && window.VoiceInput.handleKeydown(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;

    // On macOS, physical Ctrl+<letter> is reserved by the OS/WebKit for the
    // standard Emacs-style text-editing bindings on A, E, K, D, F, B, N, P, H,
    // T, O, L, V and Y (NSStandardKeyBindingResponding — e.g. physical Ctrl+A
    // is "move to beginning of line", not "select all"). A hardcoded (i.e. not
    // user-rebindable via the shortcut registry) combo that uses one of those
    // letters must require Cmd specifically on macOS, so a physical Ctrl press
    // is left alone for the OS to handle. Everywhere else `isCtrl` is still the
    // right check (Windows/Linux, or combos that don't collide with a macOS
    // text-editing binding, like Ctrl+Tab / Ctrl+W).
    const isModStrict = isMac ? e.metaKey : isCtrl;

    // Voice input start/stop (機能 3): a configurable shortcut (default Ctrl/Cmd+Shift+R; an
    // unassigned one matches nothing). matchShortcut also accepts the physical key (e.code), so a
    // Japanese IME that delivers the press as key 'Process' / keyCode 229 still triggers it.
    // WebView2 has its browser accelerator keys disabled (see configureWebViewSettings in
    // window_windows.go), so there is no native "reload" to race with.
    if (matchShortcut(e, config.shortcuts && config.shortcuts.voiceInput)) {
      e.preventDefault();
      if (window.VoiceInput) window.VoiceInput.toggle();
      return;
    }
    // The same recording without the second stage (tidying / speak-to-edit), whatever the setting says.
    if (matchShortcut(e, config.shortcuts && config.shortcuts.voiceInputRaw)) {
      e.preventDefault();
      if (window.VoiceInput) window.VoiceInput.toggle({ raw: true });
      return;
    }
    if (matchShortcut(e, config.shortcuts && config.shortcuts.voiceRefineToggle)) {
      e.preventDefault();
      toggleVoiceRefine();
      return;
    }

    // Arms "special paste" (paste as Markdown / save image instead of plain text / OCR) for
    // the next 'paste' event. Deliberately does NOT call preventDefault: the browser must
    // still fire its native paste event for the shared handler below to see clipboardData.
    if (isModStrict && e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
      specialPasteArmedAt = Date.now();
    }

    // Direct clipboard & editing fallback for macOS webview if needed
    const activeEl = document.activeElement;
    const isEditable = activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.isContentEditable);

    if (isModStrict && (e.key === 'a' || e.key === 'A') && isEditable) {
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
    if (matchShortcut(e, config.shortcuts && config.shortcuts.openSettings) || (isCtrl && (e.key === ','))) {
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

    // Line Operations (active only when editor is focused)
    const isEditorActive = (activeEl === editorEl || activeEl === editorSecondary);
    if (isEditorActive) {
      if (matchShortcut(e, config.shortcuts && config.shortcuts.moveLineUp)) {
        e.preventDefault();
        executeMoveLine(activeEl, 'up');
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.moveLineDown)) {
        e.preventDefault();
        executeMoveLine(activeEl, 'down');
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.duplicateLineUp)) {
        e.preventDefault();
        executeDuplicateLine(activeEl, 'up');
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.duplicateLineDown)) {
        e.preventDefault();
        executeDuplicateLine(activeEl, 'down');
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.deleteLine)) {
        e.preventDefault();
        executeDeleteLine(activeEl);
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.insertLineBelow)) {
        e.preventDefault();
        executeInsertLine(activeEl, 'below');
        return;
      }
      if (matchShortcut(e, config.shortcuts && config.shortcuts.insertLineAbove)) {
        e.preventDefault();
        executeInsertLine(activeEl, 'above');
        return;
      }
    }

    // Escape priority order: Ghost / IME suggestion -> Inline prompt -> CLI filter -> Find bar -> Modals -> Zen mode
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
      if (cliFilterBar && !cliFilterBar.classList.contains('hidden')) {
        closeCliFilterBar();
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
      if (!settingsModal.classList.contains('hidden')) {
        cancelSettings();
        return;
      }
      if (quickPickModal && !quickPickModal.classList.contains('hidden')) {
        closeQuickPick();
        return;
      }
      if (isMobileDropModalOpen()) {
        cancelMobileDrop();
        return;
      }
      if (document.body.classList.contains('zen-mode')) {
        toggleZenMode();
        return;
      }
      return;
    }

    // Toggle Zen Mode: only the configured shortcut. (A hard-wired Ctrl+Shift+Z used to work here
    // whatever the binding was, which kept Redo from ever working on Windows/Linux.)
    if (matchShortcut(e, config.shortcuts && config.shortcuts.zenMode)) {
      e.preventDefault();
      toggleZenMode();
      return;
    }

    // Full screen (F11 by default). Holding the key must not flip the window back and forth.
    if (matchShortcut(e, config.shortcuts && config.shortcuts.toggleFullscreen)) {
      e.preventDefault();
      if (!e.repeat) toggleFullscreen();
      return;
    }

    // Maximize / restore the window (no key by default)
    if (matchShortcut(e, config.shortcuts && config.shortcuts.toggleMaximize)) {
      e.preventDefault();
      if (window.backend && window.backend.toggleMaximize) window.backend.toggleMaximize();
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

    // Search All Daily Scraps (Ctrl+Shift+F)
    if (matchShortcut(e, config.shortcuts && config.shortcuts.searchScraps)) {
      e.preventDefault();
      openScrapsSearchModal();
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
    } else if (isModStrict && e.altKey && !e.shiftKey && e.code === 'KeyV') {
      // Moved from Ctrl/Cmd+Shift+V, which is now the "special paste" (paste-as-Markdown /
      // save-image) trigger handled by the shared paste listener. e.code (not e.key) is used
      // because Option remaps e.key on macOS (e.g. Option+V -> '√').
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
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.closeTab) || (isCtrl && (e.key === 'w' || e.key === 'W'))) {
      e.preventDefault();
      if (isSplitMode && activePane === 'secondary') {
        closeSecondaryPane();
        return;
      }
      if (tabs.length === 1) {
        // Notepad standard behavior: closing the sole remaining tab exits the application
        const tab = tabs[0];
        if (tab.isDirty) {
          confirmSaveDialog(tab.title).then(async (action) => {
            if (action === 'cancel') return;
            if (action === 'save') {
              const saved = await saveTab(tab, false);
              if (!saved) return;
            }
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
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.runCliFilter)) {
      e.preventDefault();
      openCommandBar('cli');
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.runAiCli)) {
      e.preventDefault();
      openCommandBar('ai');
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.mobileDrop)) {
      e.preventDefault();
      startMobileDrop();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.quickActions)) {
      e.preventDefault();
      if (window.JevAction && window.JevAction.triggerJevPrediction) {
        window.JevAction.triggerJevPrediction();
      }
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.insertDate)) {
      e.preventDefault();
      insertDateAtCursor();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.commandBar)) {
      // Last in the chain: a binding the user chose for another action before this default existed still wins.
      e.preventDefault();
      openCommandBar();
    } else if (isCtrl && e.key === 'Tab') {
      e.preventDefault();
      if (tabs.length > 1) {
        if (isSplitMode && activePane === 'secondary') {
          const curSecIdx = tabs.findIndex(t => t.id === secondaryTabId);
          const nextSecIdx = (curSecIdx + 1) % tabs.length;
          selectSecondaryTab(tabs[nextSecIdx].id);
        } else {
          const curIdx = tabs.findIndex(t => t.id === activeTabId);
          const nextIdx = (curIdx + 1) % tabs.length;
          selectTab(tabs[nextIdx].id);
        }
      }
    }
  });

  // Context Menu Handling with Smart Overflow & Flip Detection
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (window.ChromeLayout && !window.ChromeLayout.hasVisibleItems('context')) {
      contextMenu.classList.add('hidden'); // every item is hidden in Settings: nothing to show
      return;
    }
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
  const ctxAiCorrect = document.getElementById('ctx-ai-correct');
  if (ctxAiCorrect) {
    ctxAiCorrect.onclick = () => {
      contextMenu.classList.add('hidden');
      triggerAICorrection();
    };
  }
  const ctxCommandBar = document.getElementById('ctx-command-bar');
  if (ctxCommandBar) {
    ctxCommandBar.onclick = () => {
      contextMenu.classList.add('hidden');
      openCommandBar();
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
  const ctxZen = document.getElementById('ctx-zen');
  if (ctxZen) {
    ctxZen.onclick = () => {
      contextMenu.classList.add('hidden');
      toggleZenMode();
      refocusEditor();
    };
  }
  const ctxFullscreen = document.getElementById('ctx-fullscreen');
  if (ctxFullscreen) {
    ctxFullscreen.onclick = () => {
      contextMenu.classList.add('hidden');
      toggleFullscreen();
      refocusEditor();
    };
  }
  const ctxVoiceInput = document.getElementById('ctx-voice-input');
  if (ctxVoiceInput) {
    ctxVoiceInput.onclick = () => {
      contextMenu.classList.add('hidden');
      if (window.VoiceInput) window.VoiceInput.toggle();
    };
  }

  // Header Button Bindings
  btnNewTab.onclick = () => createTab();
  btnOpenFile.onclick = () => openFile();
  if (btnOpenFolder) btnOpenFolder.onclick = () => openFolder();
  btnSaveFile.onclick = () => saveActiveFile(false);
  if (btnFind) btnFind.onclick = () => openFindBar(false);
  if (btnHeaderLLM) btnHeaderLLM.onclick = () => openInlinePromptBar();
  // Zen mode and full screen: the same toggles as their shortcuts; the note gets the focus back so typing goes on.
  const refocusEditor = () => { const ed = getActiveEditor(); if (ed) ed.focus(); };
  if (btnZen) btnZen.onclick = () => { toggleZenMode(); refocusEditor(); };
  if (btnFullscreen) btnFullscreen.onclick = () => { toggleFullscreen(); refocusEditor(); };
  // Voice input: the same toggle as the shortcut. The button shows the recording state, which
  // VoiceInput reports through one listener (nothing polls).
  if (btnVoiceInput) btnVoiceInput.onclick = () => { if (window.VoiceInput) window.VoiceInput.toggle(); };
  // Quick Capture exists only where the native popup does (Windows). Elsewhere the button is removed
  // rather than hidden, so the toolbar-layout logic (which toggles the hidden class itself) cannot bring it back.
  if (btnQuickCapture) {
    if (window.backend && window.backend.openQuickCapture) {
      btnQuickCapture.onclick = () => { Promise.resolve(window.backend.openQuickCapture()).catch(() => {}); };
    } else {
      if (btnQuickCapture.parentNode) btnQuickCapture.parentNode.removeChild(btnQuickCapture);
    }
  }
  if (window.VoiceInput && window.VoiceInput.onStateChange) {
    window.VoiceInput.onStateChange((recording) => {
      if (btnVoiceInput) btnVoiceInput.classList.toggle('active', !!recording);
    });
  }
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
    btnSecondaryMode.onclick = async () => {
      clearGhostText();
      if (secondaryViewMode === 'editor') {
        const secTab = getTab(secondaryTabId);
        if (secTab && editorSecondary) {
          secTab.content = editorSecondary.value;
          secTab.cursorPos = editorSecondary.selectionStart;
        }
        await ensureRendererLibraries();
        secondaryViewMode = 'preview';
      } else {
        secondaryViewMode = 'editor';
      }
      updateSecondaryPane();
      if (secondaryViewMode === 'editor' && editorSecondary) {
        editorSecondary.focus();
      }
    };
  }
  if (btnSecondaryClose) {
    btnSecondaryClose.onclick = () => closeSecondaryPane();
  }
  if (secondaryPaneHeader) {
    secondaryPaneHeader.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      activePane = 'secondary';
      updatePaneFocusClasses();
      renderTabs();
      updateStatusBar();
    });
  }
  if (secondaryPreviewPane) {
    secondaryPreviewPane.addEventListener('click', () => {
      activePane = 'secondary';
      updatePaneFocusClasses();
      renderTabs();
      updateStatusBar();
    });
  }

  statEncoding.onclick = () => toggleEncoding();
  statAutocomplete.onclick = () => toggleAutocomplete();
  if (statAutosave) statAutosave.onclick = () => toggleAutoSave();
  if (statVoiceRefine) statVoiceRefine.onclick = () => toggleVoiceRefine();
  if (statIme) statIme.onclick = () => toggleIME();
  if (statAction) statAction.onclick = () => cycleActionStatus();

  // Settings Tab Switching (5-tab architecture: general, model, agent, sync, shortcuts)
  if (tabBtnGeneral) tabBtnGeneral.onclick = () => switchSettingsTab('general');
  if (tabBtnModel) tabBtnModel.onclick = () => switchSettingsTab('model');
  if (tabBtnAgent) tabBtnAgent.onclick = () => switchSettingsTab('agent');
  if (tabBtnSync) tabBtnSync.onclick = () => switchSettingsTab('sync');
  if (tabBtnShortcuts) tabBtnShortcuts.onclick = () => switchSettingsTab('shortcuts');

  // Header Help / Documentation Button
  if (btnHelp) {
    btnHelp.onclick = () => {
      if (helpUpdateBadge && !helpUpdateBadge.classList.contains('hidden')) {
        helpUpdateBadge.classList.add('hidden');
        const titleMatch = (btnHelp.title || '').match(/v([0-9.]+)/);
        if (titleMatch && titleMatch[1]) {
          try {
            localStorage.setItem('mdmemo_dismissed_update_version', titleMatch[1]);
          } catch (_) {}
        }
      }
      const helpUrl = 'https://youshinh.github.io/md-memo/';
      if (window.backend && window.backend.openExternal) {
        window.backend.openExternal(helpUrl);
      } else {
        window.open(helpUrl, '_blank');
      }
    };
  }

  const btnBrowseScrapDir = document.getElementById('btn-browse-scrap-dir');
  if (btnBrowseScrapDir) {
    btnBrowseScrapDir.onclick = async () => {
      if (window.backend && window.backend.openFolder) {
        try {
          const selected = await window.backend.openFolder();
          if (selected) {
            const input = document.getElementById('cfg-scrap-dir');
            if (input) {
              input.value = selected;
              updateGitRepoStatusUI(selected);
            }
          }
        } catch (e) {
          console.error('Failed to open scrap folder dialog:', e);
        }
      }
    };
  }

  const scrapDirInput = document.getElementById('cfg-scrap-dir');
  if (scrapDirInput) {
    scrapDirInput.addEventListener('change', () => {
      updateGitRepoStatusUI(scrapDirInput.value.trim());
    });
  }

  // Git Connection Test button
  const btnGitTestRemote = document.getElementById('btn-git-test-remote');
  if (btnGitTestRemote) {
    btnGitTestRemote.onclick = async () => {
      const gitRemoteUrlEl = document.getElementById('cfg-git-remote-url');
      const testHintEl = document.getElementById('git-test-result-hint');
      const remoteUrl = (gitRemoteUrlEl && gitRemoteUrlEl.value.trim()) || '';

      if (!remoteUrl) {
        showMessage(t('gitRemoteUrlRequired'), 3000);
        if (gitRemoteUrlEl) gitRemoteUrlEl.focus();
        return;
      }

      if (window.backend && window.backend.testGitRemote) {
        try {
          btnGitTestRemote.disabled = true;
          btnGitTestRemote.textContent = t('btnGitTesting') || 'Testing...';
          if (testHintEl) {
            testHintEl.style.color = 'var(--text-muted)';
            testHintEl.textContent = 'Testing connection & authentication...';
          }

          const res = await window.backend.testGitRemote(remoteUrl);
          if (res && res.success) {
            showMessage(t('gitTestSuccess'), 4000);
            if (testHintEl) {
              testHintEl.style.color = '#73c991';
              testHintEl.textContent = '✓ ' + (t('gitTestSuccess') || res.message);
            }
          } else {
            const errDetail = (res && (res.message || res.error)) || 'Unknown error';
            showMessage(t('gitTestFailed', { err: errDetail }), 6000);
            if (testHintEl) {
              testHintEl.style.color = '#f48771';
              testHintEl.textContent = '✗ ' + errDetail;
            }
          }
        } catch (e) {
          const errDetail = e.message || String(e);
          showMessage(t('gitTestFailed', { err: errDetail }), 6000);
          if (testHintEl) {
            testHintEl.style.color = '#f48771';
            testHintEl.textContent = '✗ ' + errDetail;
          }
        } finally {
          btnGitTestRemote.disabled = false;
          btnGitTestRemote.textContent = t('btnGitTest');
        }
      }
    };
  }

  const btnGitSetupRemote = document.getElementById('btn-git-setup-remote');
  if (btnGitSetupRemote) {
    btnGitSetupRemote.onclick = async () => {
      const scrapDirEl = document.getElementById('cfg-scrap-dir');
      const gitRemoteUrlEl = document.getElementById('cfg-git-remote-url');
      const gitBranchEl = document.getElementById('cfg-git-remote-branch');
      const testHintEl = document.getElementById('git-test-result-hint');
      const dir = (scrapDirEl && scrapDirEl.value.trim()) || '~/Documents/md-memo/scraps';
      const remoteUrl = (gitRemoteUrlEl && gitRemoteUrlEl.value.trim()) || '';
      const branch = (gitBranchEl && gitBranchEl.value.trim()) || 'main';

      if (!remoteUrl) {
        showMessage(t('gitRemoteUrlRequired'), 3000);
        if (gitRemoteUrlEl) gitRemoteUrlEl.focus();
        return;
      }

      if (window.backend && window.backend.setupGitRemote) {
        try {
          btnGitSetupRemote.disabled = true;
          btnGitSetupRemote.textContent = '...';
          if (testHintEl) {
            testHintEl.style.color = 'var(--text-muted)';
            testHintEl.textContent = 'Configuring repository & pushing initial commit...';
          }
          await window.backend.setupGitRemote(dir, remoteUrl, branch);
          await updateGitRepoStatusUI(dir);
          showMessage(t('gitSetupSuccess'), 4000);
          if (testHintEl) {
            testHintEl.style.color = '#73c991';
            testHintEl.textContent = '✓ ' + t('gitSetupSuccess');
          }
        } catch (e) {
          const errDetail = e.message || String(e);
          showMessage(t('gitSetupFailed', { err: errDetail }), 7000);
          if (testHintEl) {
            testHintEl.style.color = '#f48771';
            testHintEl.textContent = '✗ ' + errDetail;
          }
        } finally {
          btnGitSetupRemote.disabled = false;
          btnGitSetupRemote.textContent = t('btnGitSetup');
        }
      }
    };
  }

  async function checkGitInstalledStatusUI() {
    const banner = document.getElementById('git-installed-banner');
    if (!banner) return;
    if (window.backend && window.backend.checkGitInstalled) {
      try {
        const info = await window.backend.checkGitInstalled();
        if (info && !info.installed) {
          banner.style.display = 'block';
        } else {
          banner.style.display = 'none';
        }
      } catch (e) {
        console.warn('Failed to check git installed:', e);
      }
    }
  }

  // --- External Agent Configuration File Management ---
  // The last slot config JSON loaded from the backend (agents.yaml or
  // defaults), kept so the auto-approve warning and availability badge can
  // look up the selected agent's command/args without a fresh RPC.
  let lastLoadedSlotConfig = null;
  let agentAvailabilityReqToken = 0;

  function populateAgentSelectOptions(slotCfg) {
    const defaultAgentEl = document.getElementById('cfg-default-agent');
    if (!defaultAgentEl) return;
    if (!slotCfg || !slotCfg.agents) return;

    lastLoadedSlotConfig = slotCfg;

    const currentSelected = defaultAgentEl.value || config.default_agent || slotCfg.default_agent || 'claude-code';
    defaultAgentEl.innerHTML = '';

    const agentKeys = Object.keys(slotCfg.agents);
    if (agentKeys.length === 0) {
      const opt = document.createElement('option');
      opt.value = 'claude-code';
      opt.textContent = 'Claude Code';
      defaultAgentEl.appendChild(opt);
      return;
    }

    agentKeys.forEach((key) => {
      const def = slotCfg.agents[key];
      const opt = document.createElement('option');
      opt.value = key;
      // The description alone (e.g. "Antigravity") reads far better in a dropdown than
      // appending the full command line, which for some agents (agy's
      // --dangerously-skip-permissions default in particular) is long enough to make
      // every option in the list equally unreadable. The full command is still
      // available in agents.yaml and in the auto-approve warning shown below this
      // select when such a flag is detected.
      opt.textContent = def.description ? def.description : key;
      defaultAgentEl.appendChild(opt);
    });

    // Select target agent
    const targetAgent = slotCfg.default_agent || currentSelected;
    if (slotCfg.agents[targetAgent]) {
      defaultAgentEl.value = targetAgent;
      config.default_agent = targetAgent;
    } else if (defaultAgentEl.options.length > 0) {
      defaultAgentEl.selectedIndex = 0;
      config.default_agent = defaultAgentEl.value;
    }
  }

  // A small, documented list of flags known to make an agent CLI skip its own
  // confirmation prompts. Anything not on this list is left alone — this is a
  // disclosure aid, not a sandbox.
  const AUTO_APPROVE_AGENT_FLAGS = ['--dangerously-skip-permissions', '--yolo', '--full-auto', '--auto-approve'];

  function updateAgentAutoApproveWarning() {
    const warnEl = document.getElementById('agent-auto-approve-warning');
    if (!warnEl) return;
    const agentDef = lastLoadedSlotConfig && lastLoadedSlotConfig.agents && lastLoadedSlotConfig.agents[config.default_agent];
    const args = (agentDef && agentDef.args) || [];
    const hasAutoApprove = args.some(a => AUTO_APPROVE_AGENT_FLAGS.includes(a));
    warnEl.classList.toggle('hidden', !hasAutoApprove);
  }

  async function updateAgentAvailabilityBadge() {
    const badgeEl = document.getElementById('agent-availability-badge');
    if (!badgeEl) return;
    if (!(window.backend && window.backend.checkAgentAvailability)) {
      badgeEl.classList.add('hidden');
      return;
    }
    const selectedKey = config.default_agent;
    const agentDef = lastLoadedSlotConfig && lastLoadedSlotConfig.agents && lastLoadedSlotConfig.agents[selectedKey];
    const fallbackCommand = (agentDef && agentDef.command) || selectedKey || '';
    const myToken = ++agentAvailabilityReqToken;
    try {
      const result = await window.backend.checkAgentAvailability(selectedKey);
      if (myToken !== agentAvailabilityReqToken) return; // selection changed while awaiting
      const command = (result && result.command) || fallbackCommand;
      if (result && result.available) {
        badgeEl.textContent = t('agentInstalledBadge', { command });
        badgeEl.classList.remove('hidden');
      } else {
        badgeEl.textContent = t('agentNotFoundBadge', { command });
        badgeEl.classList.remove('hidden');
      }
    } catch (e) {
      badgeEl.classList.add('hidden');
    }
  }

  async function checkActiveAgentsConfigStatus() {
    const badgeEl = document.getElementById('agent-config-status-badge');
    const defaultAgentEl = document.getElementById('cfg-default-agent');

    // 1. Populate dynamic agent options from active agents.yaml (or defaults)
    if (window.backend && window.backend.getActiveSlotConfigJSON) {
      try {
        const rawJson = await window.backend.getActiveSlotConfigJSON();
        if (rawJson) {
          const slotCfg = JSON.parse(rawJson);
          populateAgentSelectOptions(slotCfg);
        }
      } catch (e) {
        console.warn('Failed to load active slot config JSON:', e);
      }
    }

    // 2. Query file location and external/internal status
    if (badgeEl && window.backend && window.backend.getActiveAgentsConfigStatus) {
      try {
        const scrapDir = (document.getElementById('cfg-scrap-dir') && document.getElementById('cfg-scrap-dir').value.trim()) || '';
        const status = await window.backend.getActiveAgentsConfigStatus(scrapDir);
        badgeEl.removeAttribute('data-i18n'); // real status resolved; stop applyLanguage() from resetting it to "Checking..."
        if (status && status.is_external) {
          badgeEl.textContent = t('statusAgentConfigExternal');
          badgeEl.style.background = 'var(--accent-active-bg, rgba(255, 255, 255, 0.15))';
          badgeEl.style.color = 'var(--accent-hover, var(--text-active, #ffffff))';
          badgeEl.style.border = '1px solid var(--accent-hover, transparent)';
          if (status.default_agent && defaultAgentEl) {
            defaultAgentEl.value = status.default_agent;
            config.default_agent = status.default_agent;
          }
        } else {
          badgeEl.textContent = t('statusAgentConfigDefault');
          badgeEl.style.background = 'rgba(255, 255, 255, 0.08)';
          badgeEl.style.color = 'var(--text-muted)';
          badgeEl.style.border = '1px solid transparent';
        }
      } catch (e) {
        console.warn('Failed to get agents config status:', e);
      }
    }

    updateAgentAutoApproveWarning();
    updateAgentAvailabilityBadge();
  }

  const btnOpenAgentsConfig = document.getElementById('btn-open-agents-config');
  if (btnOpenAgentsConfig) {
    btnOpenAgentsConfig.onclick = async () => {
      if (window.backend && window.backend.openAgentsConfigFile) {
        try {
          const scrapDir = (document.getElementById('cfg-scrap-dir') && document.getElementById('cfg-scrap-dir').value.trim()) || '';
          const targetPath = await window.backend.openAgentsConfigFile(scrapDir);
          if (targetPath) {
            // Close settings modal so user is immediately back to editor
            if (settingsModal) {
              settingsModal.classList.add('hidden');
            }
            // Open or activate agents.yaml tab in MD-Memo directly
            let targetTab = tabs.find(t => t.path === targetPath);
            if (!targetTab) {
              let content = '';
              if (window.backend.readFileByPath) {
                const res = await window.backend.readFileByPath(targetPath);
                if (res) content = res.content;
              }
              const fileName = targetPath.split(/[/\\]/).pop() || 'agents.yaml';
              targetTab = createTab(fileName, content, targetPath);
              targetTab.isAutoTitle = false;
            }
            selectTab(targetTab.id);
            showMessage(t('agentsConfigLoadedSuccess', { path: targetPath }), 3000);
          }
        } catch (e) {
          showMessage(t('agentsConfigError', { err: e.message || String(e) }), 6000);
        }
      }
    };
  }

  const defaultAgentSelectEl = document.getElementById('cfg-default-agent');
  if (defaultAgentSelectEl) {
    // In-memory only: this must NOT write to agents.yaml immediately, so that
    // Cancel/Esc/× can leave the persisted config untouched (it is only
    // persisted from the Save handler below, and only when actually changed).
    defaultAgentSelectEl.onchange = () => {
      config.default_agent = defaultAgentSelectEl.value;
      if (window.SlotAgent && window.SlotAgent.updateConfig) {
        window.SlotAgent.updateConfig(config);
      }
      updateAgentAutoApproveWarning();
      updateAgentAvailabilityBadge();
    };
  }

  function switchSettingsTab(tabName) {
    // Normalize legacy tab names
    if (tabName === 'text') tabName = 'general';
    if (tabName === 'autocomplete' || tabName === 'vision' || tabName === 'image') tabName = 'model';
    if (tabName === 'cli') tabName = 'agent';
    if (tabName === 'scraps') tabName = 'sync';
    if (tabName === 'keys') tabName = 'shortcuts';

    if (tabBtnGeneral) tabBtnGeneral.classList.toggle('active', tabName === 'general');
    if (tabBtnModel) tabBtnModel.classList.toggle('active', tabName === 'model');
    if (tabBtnAgent) tabBtnAgent.classList.toggle('active', tabName === 'agent');
    if (tabBtnSync) tabBtnSync.classList.toggle('active', tabName === 'sync');
    if (tabBtnShortcuts) tabBtnShortcuts.classList.toggle('active', tabName === 'shortcuts');

    if (paneGeneral) paneGeneral.classList.toggle('hidden', tabName !== 'general');
    if (paneText) paneText.classList.toggle('hidden', true);
    if (paneImage) paneImage.classList.toggle('hidden', true);
    if (paneModel) paneModel.classList.toggle('hidden', tabName !== 'model');
    if (paneAgent) paneAgent.classList.toggle('hidden', tabName !== 'agent');
    if (paneSync) paneSync.classList.toggle('hidden', tabName !== 'sync');
    if (paneShortcuts) paneShortcuts.classList.toggle('hidden', tabName !== 'shortcuts');

    if (tabName === 'shortcuts') {
      renderShortcutsTable();
    }
    if (tabName === 'model') {
      updateOllamaStatus();
    }
    if (tabName === 'agent') {
      checkActiveAgentsConfigStatus();
    }
    if (tabName === 'sync') {
      checkGitInstalledStatusUI();
      const scrapDirInput = document.getElementById('cfg-scrap-dir');
      if (scrapDirInput) {
        updateGitRepoStatusUI(scrapDirInput.value.trim());
      }
    }
  }

  // --- Dynamic Keyboard Shortcuts Engine ---
  function formatShortcutForDisplay(shortcutStr) {
    if (!shortcutStr) return '';
    const parts = shortcutStr.split('+').map(p => p.trim());
    const normalizeKey = (k) => {
      if (k === 'ArrowUp' || k === 'Up') return '↑';
      if (k === 'ArrowDown' || k === 'Down') return '↓';
      if (k === 'ArrowLeft' || k === 'Left') return '←';
      if (k === 'ArrowRight' || k === 'Right') return '→';
      if (k === 'Enter' || k === 'Return') return 'Enter';
      return k;
    };

    if (isMac) {
      const hasCmd = parts.some(p => p === 'Cmd' || p === 'Command' || p === '⌘');
      const hasCtrl = parts.some(p => p === 'Ctrl' || p === 'Control');
      // If legacy shortcut has only 'Ctrl' on Mac, display as 'Cmd'
      if (hasCtrl && !hasCmd) {
        return parts.map(p => (p === 'Ctrl' || p === 'Control') ? 'Cmd' : (p === 'Alt' ? 'Option' : normalizeKey(p))).join('+');
      }
      return parts.map(p => p === 'Alt' ? 'Option' : normalizeKey(p)).join('+');
    } else {
      // Windows/Linux: normalize Cmd -> Ctrl, Option -> Alt
      return parts.map(p => (p === 'Cmd' || p === 'Command') ? 'Ctrl' : (p === 'Option' ? 'Alt' : normalizeKey(p))).join('+');
    }
  }

  function getShortcutDisplay(key, fallback) {
    return formatShortcutForDisplay((config.shortcuts && config.shortcuts[key]) || fallback || '');
  }

  // A palette description's "{sc}" is the action's CURRENT binding; an unassigned action drops the empty "()".
  function paletteDescWithShortcut(descKey, actionKey) {
    const sc = getEffectiveShortcut(actionKey);
    const text = t(descKey, { sc: sc ? formatShortcutForDisplay(sc) : '' });
    return sc ? text : text.replace(/\s*[(（]\s*[)）]\s*$/, '');
  }

  // The palette entry's description names the CURRENT voice-input binding; an unassigned one shows none.
  function voiceInputPaletteDesc() {
    const sc = getEffectiveShortcut('voiceInput');
    const text = t('cmdPaletteVoiceInputDesc', { sc: sc ? formatShortcutForDisplay(sc) : '' });
    return sc ? text : text.replace(/\s*[(（]\s*[)）]\s*$/, '');
  }

  // matchShortcut runs ~36 times per keydown; the shortcut strings are immutable,
  // so their parsed form is memoized (cleared when shortcuts are re-recorded).
  const shortcutParseCache = new Map();

  function parseShortcutString(shortcutStr) {
    let parsed = shortcutParseCache.get(shortcutStr);
    if (parsed !== undefined) return parsed;

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

    parsed = mainKey
      ? { hasCtrl, hasCmd, hasShift, hasAlt, target: mainKey.toUpperCase() }
      : null;

    if (shortcutParseCache.size > 256) shortcutParseCache.clear();
    shortcutParseCache.set(shortcutStr, parsed);
    return parsed;
  }

  function clearShortcutParseCache() {
    shortcutParseCache.clear();
  }

  function matchShortcut(e, shortcutStr) {
    if (!shortcutStr) return false;
    const parsed = parseShortcutString(shortcutStr);
    if (!parsed) return false;
    const hasCtrl = parsed.hasCtrl;
    const hasCmd = parsed.hasCmd;
    const hasShift = parsed.hasShift;
    const hasAlt = parsed.hasAlt;

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

    const target = parsed.target;
    if (target === '\\' || target === 'BACKSLASH') {
      return e.key === '\\' || e.code === 'Backslash';
    }
    if (target === ',' || target === 'COMMA') {
      return e.key === ',' || e.code === 'Comma';
    }
    if (target === 'UP' || target === 'ARROWUP' || target === '↑') {
      return e.key === 'ArrowUp';
    }
    if (target === 'DOWN' || target === 'ARROWDOWN' || target === '↓') {
      return e.key === 'ArrowDown';
    }
    if (target === 'ENTER' || target === 'RETURN') {
      return e.key === 'Enter';
    }
    if (target.startsWith('F') && !isNaN(target.substring(1))) {
      return e.key.toUpperCase() === target;
    }
    // Digits: on macOS, holding Option/Alt composes a different character into
    // e.key (Option+1 -> '¡', Option+2 -> '™', Option+3 -> '£', ...), so a
    // shortcut recorded as e.g. "Option+1" would otherwise never match. `.code`
    // stays the physical digit key regardless of Option, on every platform.
    if (target.length === 1 && target >= '0' && target <= '9') {
      return e.key === target || e.code === 'Digit' + target || e.code === 'Numpad' + target;
    }
    // Punctuation the shortcut recorder can produce, subject to the same
    // Option-composition problem as digits (e.g. Option+, -> '≤' on macOS,
    // Option+\ -> '«'). '\\' and ',' already have dedicated branches above;
    // this covers the rest of the recorder's punctuation keys. Declared inline
    // (rather than module-level) so this function stays a single self-contained
    // unit — some of this repo's tests extract matchShortcut's source text
    // standalone and eval it in an isolated sandbox.
    const punctCodeMap = {
      '`': 'Backquote', '.': 'Period', '/': 'Slash', ';': 'Semicolon',
      "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal'
    };
    const punctCode = punctCodeMap[target];
    if (punctCode) {
      return e.key === target || e.code === punctCode;
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
    setLabel('sc-ctx-ai-correct', config.shortcuts.aiCorrection);
    setLabel('sc-ctx-convert-mermaid', config.shortcuts.convertMermaid);
    setLabel('sc-ctx-mermaid-to-image', config.shortcuts.mermaidToImage);
    setLabel('sc-ctx-save-txt', config.shortcuts.exportPlainText);
    setLabel('sc-ctx-insert-date', config.shortcuts.insertDate);
    setLabel('sc-ctx-toggle-preview', config.shortcuts.togglePreview);
    // Unlike setLabel, an unassigned voice-input shortcut must blank its label, not keep a stale one.
    const voiceScEl = document.getElementById('sc-ctx-voice-input');
    if (voiceScEl) voiceScEl.textContent = config.shortcuts.voiceInput ? formatShortcutForDisplay(config.shortcuts.voiceInput) : '';
    const zenScEl = document.getElementById('sc-ctx-zen');
    if (zenScEl) zenScEl.textContent = config.shortcuts.zenMode ? formatShortcutForDisplay(config.shortcuts.zenMode) : '';
    const fullscreenScEl = document.getElementById('sc-ctx-fullscreen');
    if (fullscreenScEl) fullscreenScEl.textContent = config.shortcuts.toggleFullscreen ? formatShortcutForDisplay(config.shortcuts.toggleFullscreen) : '';
    const askScEl = document.getElementById('sc-ctx-inline-prompt');
    if (askScEl) askScEl.textContent = config.shortcuts.inlinePrompt ? formatShortcutForDisplay(config.shortcuts.inlinePrompt) : '';
    const commandBarScEl = document.getElementById('sc-ctx-command-bar');
    if (commandBarScEl) commandBarScEl.textContent = config.shortcuts.commandBar ? formatShortcutForDisplay(config.shortcuts.commandBar) : '';

    const getSc = (key, fallback) => formatShortcutForDisplay((config.shortcuts && config.shortcuts[key]) || fallback);
    // The i18n titles already end in a default "(Ctrl+O)": drop it before appending the configured one.
    const baseTitle = (text) => (window.ChromeLayout ? window.ChromeLayout.stripShortcut(text) : text);

    if (btnNewTab) btnNewTab.title = `${baseTitle(t('newTabTitle'))} (${getSc('newTab', isMac ? 'Cmd+N' : 'Ctrl+N')})`;
    if (btnOpenFile) btnOpenFile.title = `${baseTitle(t('openFileTitle'))} (${getSc('openFile', isMac ? 'Cmd+O' : 'Ctrl+O')})`;
    if (btnOpenFolder) btnOpenFolder.title = `${baseTitle(t('openFolderTitle'))} (${getSc('openFolder', isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O')})`;
    if (btnSaveFile) btnSaveFile.title = `${baseTitle(t('saveFileTitle'))} (${getSc('saveFile', isMac ? 'Cmd+S' : 'Ctrl+S')})`;
    if (btnFind) btnFind.title = `${baseTitle(t('findTitle'))} (${getSc('find', isMac ? 'Cmd+F' : 'Ctrl+F')})`;
    if (btnSearchScraps) btnSearchScraps.title = `${baseTitle(t('searchScrapsTitle'))} (${getSc('searchScraps', isMac ? 'Cmd+Shift+F' : 'Ctrl+Shift+F')})`;
    if (btnHeaderLLM) btnHeaderLLM.title = `${baseTitle(t('llmTitle'))} (${getSc('inlinePrompt', isMac ? 'Cmd+L' : 'Ctrl+L')})`;
    if (btnToggleSplit) btnToggleSplit.title = `${baseTitle(t('splitViewTitle'))} (${getSc('toggleSplit', isMac ? 'Cmd+\\' : 'Ctrl+\\')})`;
    if (btnTogglePreview) btnTogglePreview.title = `${isPreviewMode ? t('edit') : baseTitle(t('togglePreviewTitle'))} (${getSc('togglePreview', isMac ? 'Cmd+P' : 'Ctrl+P')})`;
    if (btnMobileDrop) btnMobileDrop.title = `${t('mobileDropToolbarTitle')} (${getSc('mobileDrop', isMac ? 'Cmd+Shift+U' : 'Ctrl+Shift+U')})`;
    const quickCaptureBtnEl = document.getElementById('btn-quick-capture');
    if (quickCaptureBtnEl) {
      quickCaptureBtnEl.title = config.shortcuts.quickCapture
        ? `${baseTitle(t('quickCaptureTitle'))} (${formatShortcutForDisplay(config.shortcuts.quickCapture)})`
        : baseTitle(t('quickCaptureTitle'));
    }
    if (btnVoiceInput) {
      // The shortcut may have been cleared: then the tooltip carries no combo at all.
      btnVoiceInput.title = config.shortcuts.voiceInput
        ? `${baseTitle(t('voiceInputTitle'))} (${formatShortcutForDisplay(config.shortcuts.voiceInput)})`
        : baseTitle(t('voiceInputTitle'));
    }
    if (btnPreviewSide) btnPreviewSide.title = `${baseTitle(t('previewToSideTitle'))} (${isMac ? 'Cmd+Option+V' : 'Ctrl+Alt+V'})`;
    // A cleared shortcut leaves the tooltip without a combo, like the voice button.
    const titleWithKey = (label, key) => (config.shortcuts && config.shortcuts[key])
      ? `${baseTitle(label)} (${formatShortcutForDisplay(config.shortcuts[key])})`
      : baseTitle(label);
    if (btnZen) btnZen.title = titleWithKey(t('zenToggleTitle'), 'zenMode');
    if (btnFullscreen) btnFullscreen.title = titleWithKey(t('fullscreenTitle'), 'toggleFullscreen');
  }

  let activeRecordingAction = null;

  // Combos the app itself handles outside the shortcut registry (see the
  // global keydown handler: Ctrl+Tab cycles tabs, Ctrl+, opens Settings).
  // Assigning any user shortcut to one
  // of these would silently do nothing useful (the hardcoded handler always
  // wins first), so recording one is blocked with an inline message instead.
  // The second row is the fixed shortcuts the app handles itself BEFORE the registry is consulted
  // (special paste, preview to the side, task panel, ghost-text word accept), and the
  // third row is the editing keys the browser owns: binding an action to any of them would either
  // never fire or break copy/paste/undo, so the recorder refuses them.
  const RESERVED_SYSTEM_SHORTCUTS_WIN = ['Ctrl+Tab', 'Ctrl+,',
    'Ctrl+Shift+V', 'Ctrl+Alt+V', 'Alt+T', 'Ctrl+ArrowRight',
    // SlotAgent captures every Ctrl+Enter variant in the editor to run a slot, so none of these could ever fire.
    'Ctrl+Enter', 'Ctrl+Shift+Enter', 'Ctrl+Alt+Enter', 'Ctrl+Shift+Alt+Enter',
    'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y'];
  // macOS: the native app/Edit menu's key equivalents consume these before the
  // WKWebView's keydown handler ever runs, so binding a user shortcut to one of
  // them would be just as silently useless as the Windows list above. Ctrl+Tab
  // is kept too — this app hardcodes it for tab cycling on every platform, and
  // it must stay physical Ctrl on macOS (Cmd+Tab is the system app switcher).
  // Cmd+, is reserved for the same reason as Windows' Ctrl+, (the app itself
  // hardcodes a Cmd/Ctrl+, fallback to open Settings, independent of isMac —
  // see the "Open Settings shortcut" check in the global keydown handler).
  // F11 is NOT reserved here: macOS' own Mission Control already intercepts it
  // before it ever reaches the WKWebView, and the app's mac default for
  // toggleFullscreen is 'Ctrl+Cmd+F', not F11, so nothing in this app is actually
  // depending on F11 arriving as a keydown on macOS.
  const RESERVED_SYSTEM_SHORTCUTS_MAC = [
    'Ctrl+Tab', 'Cmd+,', 'Cmd+Q', 'Cmd+H', 'Cmd+Option+H', 'Cmd+M',
    'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+A', 'Cmd+Tab', 'Cmd+Space',
    // App-fixed shortcuts (see the Windows list above); Ctrl and Cmd compare as equal.
    'Cmd+Shift+V', 'Cmd+Option+V', 'Option+T', 'Cmd+ArrowRight',
    'Cmd+Enter', 'Cmd+Shift+Enter', 'Cmd+Option+Enter', 'Cmd+Shift+Option+Enter'
  ];

  function getReservedSystemShortcuts() {
    return isMac ? RESERVED_SYSTEM_SHORTCUTS_MAC : RESERVED_SYSTEM_SHORTCUTS_WIN;
  }

  function normalizeComboForCompare(comboStr) {
    if (!comboStr) return '';
    const parts = comboStr.split('+').map(p => p.trim());
    let ctrl = false, shift = false, alt = false, key = '';
    parts.forEach(p => {
      if (p === 'Ctrl' || p === 'Control' || p === 'Cmd' || p === 'Command') ctrl = true;
      else if (p === 'Shift') shift = true;
      else if (p === 'Alt' || p === 'Option') alt = true;
      else key = p.toUpperCase();
    });
    return `${ctrl ? 1 : 0}|${shift ? 1 : 0}|${alt ? 1 : 0}|${key}`;
  }

  function isReservedSystemShortcut(comboStr) {
    if (!comboStr) return false;
    const norm = normalizeComboForCompare(comboStr);
    return getReservedSystemShortcuts().some(r => normalizeComboForCompare(r) === norm);
  }

  function getAllShortcutActionKeys() {
    const keys = [];
    SHORTCUT_GROUPS.forEach(group => group.actions.forEach(act => keys.push(act.key)));
    return keys;
  }

  function getActionLabelKey(actionKey) {
    for (const group of SHORTCUT_GROUPS) {
      const found = group.actions.find(a => a.key === actionKey);
      if (found) return found.labelKey;
    }
    return actionKey;
  }

  // One-time migration + ongoing safety net for macOS shortcut configs, run
  // after every config load (local, backend-synced, or imported):
  //  - Older builds defaulted Zen Mode to Cmd+Shift+Z, which the native Edit
  //    menu's Redo now consumes before the WKWebView ever sees the keydown
  //    (Zen was permanently unreachable). Move stale configs onto the new
  //    default (Ctrl+Cmd+Z).
  //  - A Windows-authored config can fold to a mac-reserved combo once Ctrl is
  //    remapped to Cmd (see matchShortcut's mac branch) — e.g. replace:
  //    'Ctrl+H' becomes Cmd+H (Hide App), silently breaking that action since
  //    the native menu consumes the keystroke first. Fall back to that
  //    action's own mac default instead, but only when the configured combo
  //    differs from that default already: some defaults (like minimize's
  //    Cmd+M) are deliberately in the reserved list and must be left alone.
  // `showToast` is false for the earliest, synchronous local-storage load (so
  // the user isn't shown a toast before the UI has even painted); the
  // authoritative backend config load passes true.
  // Set when a migration below changed a binding; syncBackendConfig saves the config once so the
  // change (and its notice) does not repeat on every start.
  let shortcutMigrationDirty = false;

  // "Insert line below/above" used to default to Ctrl/Cmd+Enter and Ctrl/Cmd+Shift+Enter. SlotAgent
  // captures every Ctrl+Enter variant first (to run a slot), so those bindings never fired; the
  // first replacement default for "below" was Alt+Enter. A config that still holds one of these old
  // defaults is moved to the current default; any other value the user chose is left alone.
  function migrateInsertLineShortcuts() {
    if (!config.shortcuts) return;
    const oldDefaults = {
      insertLineBelow: ['Ctrl+Enter', 'Alt+Enter'],
      insertLineAbove: ['Ctrl+Shift+Enter']
    };
    Object.keys(oldDefaults).forEach((key) => {
      const cur = config.shortcuts[key];
      if (!cur) return;
      const curNorm = normalizeComboForCompare(cur);
      if (oldDefaults[key].some((old) => normalizeComboForCompare(old) === curNorm)) {
        config.shortcuts[key] = DEFAULT_SHORTCUTS[key];
        shortcutMigrationDirty = true;
      }
    });
  }

  // Zen mode used to default to Ctrl+Shift+Z on Windows/Linux, which is Redo almost everywhere. It
  // now defaults to Shift+F11 (next to F11) and Ctrl+Shift+Z is Redo again. macOS already moved
  // (see migrateMacShortcuts), so this only touches the other platforms.
  function migrateZenShortcut(showToast) {
    if (isMac || !config.shortcuts) return;
    const cur = config.shortcuts.zenMode;
    if (!cur || normalizeComboForCompare(cur) !== normalizeComboForCompare('Ctrl+Shift+Z')) return;
    config.shortcuts.zenMode = DEFAULT_SHORTCUTS.zenMode;
    shortcutMigrationDirty = true;
    if (showToast && typeof showMessage === 'function') {
      showMessage(t('zenShortcutMoved', { sc: formatShortcutForDisplay(DEFAULT_SHORTCUTS.zenMode) }), 8000);
    }
  }

  // The inline bar (Ctrl+K) and the prompt dialog (Ctrl+L) became one ask bar on Ctrl+L. A saved Ctrl+K moves to the
  // new default with one notice, unless another action already holds Ctrl+L (then the old key keeps working);
  // the dialog's own binding has nothing left to open and is dropped. Anything else the user chose is kept.
  // Only a config that still carries that dialog binding predates the change: the binding is dropped by the first
  // run, so a Ctrl+K the user assigns to the ask bar afterwards is theirs and is not moved back at the next start.
  function migrateAskShortcuts(showToast) {
    if (!config.shortcuts) return;
    const oldCombo = normalizeComboForCompare('Ctrl+K');
    const newCombo = DEFAULT_SHORTCUTS.inlinePrompt;
    const cur = config.shortcuts.inlinePrompt;
    const predatesMerge = Object.prototype.hasOwnProperty.call(config.shortcuts, 'llmModal');

    if (predatesMerge && cur && normalizeComboForCompare(cur) === oldCombo) {
      const target = normalizeComboForCompare(newCombo);
      const taken = Object.keys(config.shortcuts).some((key) =>
        key !== 'inlinePrompt' && key !== 'llmModal' && config.shortcuts[key] && normalizeComboForCompare(config.shortcuts[key]) === target);
      if (!taken) {
        config.shortcuts.inlinePrompt = newCombo;
        shortcutMigrationDirty = true;
        if (showToast && typeof showMessage === 'function') {
          showMessage(t('askShortcutMoved', { sc: formatShortcutForDisplay(newCombo) }), 8000);
        }
      }
    }
    if (predatesMerge) {
      delete config.shortcuts.llmModal;
      shortcutMigrationDirty = true;
    }
  }

  // F11 (Ctrl+Cmd+F on macOS) used to be the key for "maximize"; it is full screen now. A config that still holds that old
  // default for maximize hands the key to full screen and leaves maximize without one; a key the user chose is left alone.
  function migrateFullscreenShortcut() {
    if (!config.shortcuts) return;
    const cur = config.shortcuts.toggleMaximize;
    const oldDefault = isMac ? 'Ctrl+Cmd+F' : 'F11';
    if (!cur || normalizeComboForCompare(cur) !== normalizeComboForCompare(oldDefault)) return;
    config.shortcuts.toggleMaximize = '';
    if (!config.shortcuts.toggleFullscreen) config.shortcuts.toggleFullscreen = DEFAULT_SHORTCUTS.toggleFullscreen;
    shortcutMigrationDirty = true;
  }

  function migrateMacShortcuts(showToast) {
    if (!isMac || !config.shortcuts) return;

    if (config.shortcuts.zenMode === 'Cmd+Shift+Z') {
      config.shortcuts.zenMode = DEFAULT_SHORTCUTS_MAC.zenMode;
    }

    let fellBack = false;
    getAllShortcutActionKeys().forEach((key) => {
      const combo = config.shortcuts[key];
      if (!combo) return;
      if (combo === DEFAULT_SHORTCUTS_MAC[key]) return;
      if (isReservedSystemShortcut(combo)) {
        config.shortcuts[key] = DEFAULT_SHORTCUTS_MAC[key] || '';
        fellBack = true;
      }
    });

    if (fellBack && showToast && typeof showMessage === 'function') {
      showMessage(t('macReservedShortcutFallback'), 4500);
    }
  }

  function getEffectiveShortcut(actionKey) {
    return (config.shortcuts && config.shortcuts[actionKey] !== undefined)
      ? config.shortcuts[actionKey]
      : (DEFAULT_SHORTCUTS[actionKey] || '');
  }

  // Returns the action key already bound to `comboStr` (other than
  // `excludeKey`), or null if the combo is free.
  function findShortcutConflict(comboStr, excludeKey) {
    if (!comboStr) return null;
    const norm = normalizeComboForCompare(comboStr);
    for (const key of getAllShortcutActionKeys()) {
      if (key === excludeKey) continue;
      const existing = getEffectiveShortcut(key);
      if (existing && normalizeComboForCompare(existing) === norm) return key;
    }
    return null;
  }

  function commitShortcutAssignment(actionKey, comboOrEmpty, conflictKeyToClear) {
    if (!config.shortcuts) config.shortcuts = {};
    if (conflictKeyToClear) {
      config.shortcuts[conflictKeyToClear] = '';
    }
    config.shortcuts[actionKey] = comboOrEmpty;
    clearShortcutParseCache();
    renderShortcutsTable();
    updateShortcutLabels();
  }

  const SHORTCUT_GROUPS = [
    {
      titleKey: 'shortcutGroupFile',
      actions: [
        { key: 'newTab', labelKey: 'shortcutActionNewTab' },
        { key: 'openFile', labelKey: 'shortcutActionOpenFile' },
        { key: 'openFolder', labelKey: 'shortcutActionOpenFolder' },
        { key: 'saveFile', labelKey: 'shortcutActionSaveFile' },
        { key: 'saveFileAs', labelKey: 'shortcutActionSaveFileAs' },
        { key: 'closeTab', labelKey: 'shortcutActionCloseTab' },
        { key: 'exportPlainText', labelKey: 'shortcutActionExportPlainText' }
      ]
    },
    {
      titleKey: 'shortcutGroupEdit',
      actions: [
        { key: 'find', labelKey: 'shortcutActionFind' },
        { key: 'searchScraps', labelKey: 'searchScrapsTitle' },
        { key: 'replace', labelKey: 'shortcutActionReplace' },
        { key: 'gotoLine', labelKey: 'shortcutActionGotoLine' },
        { key: 'quickPick', labelKey: 'shortcutActionQuickPick' },
        { key: 'insertDate', labelKey: 'shortcutActionInsertDate' }
      ]
    },
    {
      titleKey: 'shortcutGroupLine',
      actions: [
        { key: 'moveLineUp', labelKey: 'shortcutActionMoveLineUp' },
        { key: 'moveLineDown', labelKey: 'shortcutActionMoveLineDown' },
        { key: 'duplicateLineUp', labelKey: 'shortcutActionDuplicateLineUp' },
        { key: 'duplicateLineDown', labelKey: 'shortcutActionDuplicateLineDown' },
        { key: 'deleteLine', labelKey: 'shortcutActionDeleteLine' },
        { key: 'insertLineBelow', labelKey: 'shortcutActionInsertLineBelow' },
        { key: 'insertLineAbove', labelKey: 'shortcutActionInsertLineAbove' }
      ]
    },
    {
      titleKey: 'shortcutGroupCLI',
      actions: [
        { key: 'commandBar', labelKey: 'shortcutActionCommandBar' },
        { key: 'runCliFilter', labelKey: 'shortcutActionRunCliFilter' },
        { key: 'runAiCli', labelKey: 'shortcutActionRunAiCli' },
        { key: 'mobileDrop', labelKey: 'shortcutActionMobileDrop' }
      ]
    },
    {
      titleKey: 'shortcutGroupView',
      actions: [
        { key: 'togglePreview', labelKey: 'shortcutActionTogglePreview' },
        { key: 'toggleSplit', labelKey: 'shortcutActionToggleSplit' },
        { key: 'zenMode', labelKey: 'shortcutActionZenMode' },
        { key: 'toggleFullscreen', labelKey: 'shortcutActionToggleFullscreen' },
        { key: 'toggleMaximize', labelKey: 'shortcutActionToggleMaximize' },
        { key: 'minimize', labelKey: 'shortcutActionMinimize' },
        { key: 'globalSummon', labelKey: 'shortcutActionGlobalSummon' },
        { key: 'quickCapture', labelKey: 'shortcutActionQuickCapture', needsBackend: 'openQuickCapture' }
      ]
    },
    {
      titleKey: 'shortcutGroupAI',
      actions: [
        { key: 'inlinePrompt', labelKey: 'shortcutActionInlinePrompt' },
        { key: 'aiCorrection', labelKey: 'shortcutActionAICorrection' },
        { key: 'quickActions', labelKey: 'shortcutActionQuickActions' },
        { key: 'convertMermaid', labelKey: 'shortcutActionConvertMermaid' },
        { key: 'mermaidToImage', labelKey: 'shortcutActionMermaidToImage' },
        { key: 'voiceInput', labelKey: 'shortcutActionVoiceInput' },
        { key: 'voiceInputRaw', labelKey: 'shortcutActionVoiceInputRaw' },
        { key: 'voiceRefineToggle', labelKey: 'shortcutActionVoiceRefineToggle' }
      ]
    },
    {
      titleKey: 'shortcutGroupGeneral',
      actions: [
        { key: 'openSettings', labelKey: 'shortcutActionOpenSettings' }
      ]
    }
  ];

  function renderShortcutsTable() {
    if (!shortcutsListBody) return;
    shortcutsListBody.innerHTML = '';

    const shortcutsHintEl = document.getElementById('shortcuts-hint');
    if (shortcutsHintEl) {
      shortcutsHintEl.textContent = activeRecordingAction ? t('shortcutRecordingHint') : t('shortcutsHint');
    }

    SHORTCUT_GROUPS.forEach(group => {
      // Category header row
      const headerTr = document.createElement('tr');
      headerTr.className = 'shortcut-category-row';
      const headerTh = document.createElement('th');
      headerTh.colSpan = 2;
      headerTh.textContent = t(group.titleKey);
      headerTr.appendChild(headerTh);
      shortcutsListBody.appendChild(headerTr);

      group.actions.forEach(act => {
        if (act.needsBackend && !(window.backend && window.backend[act.needsBackend])) return;
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
          const raw = (config.shortcuts && config.shortcuts[act.key] !== undefined)
            ? config.shortcuts[act.key]
            : (DEFAULT_SHORTCUTS[act.key] || '');
          if (raw) {
            btn.textContent = formatShortcutForDisplay(raw);
          } else {
            btn.classList.add('empty');
            btn.textContent = t('shortcutUnassigned');
            btn.title = t('shortcutClickToAssign');
          }
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
    });
  }

  if (btnResetShortcuts) {
    btnResetShortcuts.onclick = () => {
      const prevQuickCapture = quickCaptureShortcutOf(config.shortcuts);
      config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
      syncQuickCaptureShortcut(prevQuickCapture);
      clearShortcutParseCache();
      activeRecordingAction = null;
      if (window.backend && window.backend.updateGlobalShortcut) {
        Promise.resolve(window.backend.updateGlobalShortcut((config.shortcuts && config.shortcuts.globalSummon) || DEFAULT_SHORTCUTS.globalSummon)).then((ok) => {
          if (ok === false) showMessage(t('globalShortcutRegisterFailed'), 5000);
        }).catch((e) => console.warn('updateGlobalShortcut failed:', e));
      }
      renderShortcutsTable();
      updateShortcutLabels();
    };
  }

  // Maps a KeyboardEvent.code to the physical, un-shifted character it
  // produces, independent of any Option/Alt-composed character in `.key`.
  // Used by the shortcut recorder below (see the Option-composition problem
  // documented on matchShortcut's own digit/punctuation fallback): without
  // this, recording "Option+T" on macOS would store the mojibake
  // "Option+†" instead of the intended "Option+T".
  function physicalCharFromCode(code) {
    if (typeof code !== 'string') return '';
    if (code.slice(0, 3) === 'Key' && code.length === 4) return code.slice(3);
    if (code.slice(0, 5) === 'Digit' && code.length === 6) return code.slice(5);
    const PUNCT = {
      Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
      Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
    };
    return PUNCT[code] || '';
  }

  // Turns a keydown event into the "Ctrl+Shift+X" style combo string the shortcut
  // recorder stores/matches. Pure (no preventDefault, no access to
  // activeRecordingAction or the DOM) so it can be unit tested directly; the
  // recorder below is just "compute the combo, then decide what to do with it".
  function comboFromKeyEvent(e) {
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
    // When Alt/Option is held, prefer the PHYSICAL character from e.code over
    // the (possibly composed) e.key: on macOS, Option+T reports key '†', code
    // 'KeyT' — without this, the recorder would store the mojibake "Option+†"
    // instead of "Option+T". On Windows/Linux this is a no-op (Alt+letter
    // already reports the plain letter in e.key), so behavior there is unchanged.
    if (e.altKey) {
      const physical = physicalCharFromCode(e.code);
      if (physical) k = physical;
    }
    if (k === ' ') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }

  window.addEventListener('keydown', (e) => {
    if (activeRecordingAction) {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      const recordingKey = activeRecordingAction;

      if (e.key === 'Escape') {
        activeRecordingAction = null;
        renderShortcutsTable();
        return;
      }

      // The registry already supports empty strings (several defaults are
      // unassigned), so Backspace/Delete simply clears this action's binding.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        activeRecordingAction = null;
        commitShortcutAssignment(recordingKey, '', null);
        return;
      }

      const newCombo = comboFromKeyEvent(e);

      activeRecordingAction = null;

      if (isReservedSystemShortcut(newCombo)) {
        renderShortcutsTable();
        showMessage(t('shortcutReservedByApp', { combo: formatShortcutForDisplay(newCombo) }), 4000);
        return;
      }

      const conflictKey = findShortcutConflict(newCombo, recordingKey);
      if (conflictKey) {
        renderShortcutsTable();
        const conflictLabel = t(getActionLabelKey(conflictKey));
        customConfirm(t('shortcutOverwriteConfirm', { action: conflictLabel })).then((confirmed) => {
          if (confirmed) {
            commitShortcutAssignment(recordingKey, newCombo, conflictKey);
          }
        });
        return;
      }

      commitShortcutAssignment(recordingKey, newCombo, null);
    }
  }, true);

  // Clamp every numeric settings field on blur so users see what will be saved
  // (matches the min/max/step already declared on each <input> in index.html).
  wireNumberInputClamp('cfg-auto-delay', 200, 2000, 500);
  wireNumberInputClamp('cfg-auto-tokens', 10, 100, 30);
  wireNumberInputClamp('cfg-max-pipe-size', 1, 100, 10);
  wireNumberInputClamp('cfg-slot-timeout', 10, 600, 180);
  wireNumberInputClamp('cfg-slot-ghost-diff-ms', 1000, 10000, 4000);
  wireNumberInputClamp('cfg-action-delay', 0.5, 10.0, 1.5, true);
  wireNumberInputClamp('cfg-git-debounce', 5, 3600, 30);
  wireNumberInputClamp('cfg-discord-poll-interval', 15, 600, 45);

  // Quick Actions settings: "enabled" and "manual-only" are contradictory when
  // combined naively (manual-only implies auto-suggest is off, so its delay/API
  // fields are meaningless if the feature itself is off). Mute the dependent
  // fields instead of letting the user set values that can never take effect.
  // This is pure UI coupling — the saved values themselves are unchanged.
  function setFieldMuted(el, muted) {
    if (!el) return;
    el.disabled = muted;
    const group = el.closest('.form-group') || el.closest('.inline-group');
    if (group) group.classList.toggle('field-muted', muted);
  }

  function updateQuickActionsFieldStates() {
    const enabledEl = document.getElementById('cfg-action-enabled');
    const manualOnlyEl = document.getElementById('cfg-action-manual-only');
    const delayEl = document.getElementById('cfg-action-delay');
    const baseUrlEl = document.getElementById('cfg-action-base-url');
    const modelEl = document.getElementById('cfg-action-model');
    const apiKeyEl = document.getElementById('cfg-action-api-key');
    const enabled = enabledEl ? enabledEl.checked : true;
    const manualOnly = manualOnlyEl ? manualOnlyEl.checked : false;

    setFieldMuted(manualOnlyEl, !enabled);
    setFieldMuted(baseUrlEl, !enabled);
    setFieldMuted(modelEl, !enabled);
    setFieldMuted(apiKeyEl, !enabled);
    // Delay only matters for the automatic (non-manual) popup.
    setFieldMuted(delayEl, !enabled || manualOnly);
  }

  const qaEnabledToggleEl = document.getElementById('cfg-action-enabled');
  if (qaEnabledToggleEl) qaEnabledToggleEl.addEventListener('change', updateQuickActionsFieldStates);
  const qaManualOnlyToggleEl = document.getElementById('cfg-action-manual-only');
  if (qaManualOnlyToggleEl) qaManualOnlyToggleEl.addEventListener('change', updateQuickActionsFieldStates);

  // Auto selector: "confirm before an agent / command runs" means nothing while the selector itself is off.
  function updateAutoSelectorFieldStates() {
    const enabledEl = document.getElementById('cfg-autosel-enabled');
    setFieldMuted(document.getElementById('cfg-autosel-agent-confirm'), enabledEl ? !enabledEl.checked : false);
  }

  const autoSelEnabledToggleEl = document.getElementById('cfg-autosel-enabled');
  if (autoSelEnabledToggleEl) autoSelEnabledToggleEl.addEventListener('change', updateAutoSelectorFieldStates);

  // Discord Bridge: the token/user-id/interval/test button mean nothing while the bridge itself is off.
  function updateDiscordBridgeFieldStates() {
    const enabledEl = document.getElementById('cfg-discord-enabled');
    const enabled = enabledEl ? enabledEl.checked : false;
    setFieldMuted(document.getElementById('cfg-discord-bot-token'), !enabled);
    setFieldMuted(document.getElementById('cfg-discord-user-id'), !enabled);
    setFieldMuted(document.getElementById('cfg-discord-poll-interval'), !enabled);
    const testBtn = document.getElementById('btn-discord-test');
    if (testBtn) testBtn.disabled = !enabled;
  }
  const discordEnabledToggleEl = document.getElementById('cfg-discord-enabled');
  if (discordEnabledToggleEl) discordEnabledToggleEl.addEventListener('change', updateDiscordBridgeFieldStates);

  const btnDiscordTest = document.getElementById('btn-discord-test');
  if (btnDiscordTest) {
    btnDiscordTest.addEventListener('click', async () => {
      const hint = document.getElementById('discord-test-result-hint');
      const tokenEl = document.getElementById('cfg-discord-bot-token');
      const userIdEl = document.getElementById('cfg-discord-user-id');
      const token = tokenEl ? tokenEl.value.trim() : '';
      const userId = userIdEl ? userIdEl.value.trim() : '';
      if (!window.backend || !window.backend.testDiscordBridgeConnection) return;
      btnDiscordTest.disabled = true;
      const prevLabel = btnDiscordTest.textContent;
      btnDiscordTest.textContent = t('btnDiscordBridgeTesting');
      if (hint) { hint.textContent = ''; hint.style.color = 'var(--text-muted)'; }
      try {
        const result = await window.backend.testDiscordBridgeConnection(token, userId);
        if (hint) {
          hint.textContent = t('discordBridgeTestSuccess', { bot: (result && result.botUsername) || '' });
          hint.style.color = 'var(--accent-color, #4dabf7)';
        }
      } catch (e) {
        if (hint) {
          hint.textContent = t('discordBridgeTestFailed', { err: (e && e.message) || String(e) });
          hint.style.color = '#ff6b6b';
        }
      } finally {
        btnDiscordTest.disabled = !(document.getElementById('cfg-discord-enabled') && document.getElementById('cfg-discord-enabled').checked);
        btnDiscordTest.textContent = prevLabel;
      }
    });
  }

  // Send To (Explorer right-click OCR): the section only exists where the native binding does
  // (Windows). On any other platform/preview, hide it instead of wiring buttons that would fail.
  const sendToSection = document.getElementById('sendto-section');
  const sendToCard = document.getElementById('sendto-card');
  const hasSendToBackend = !!(window.backend && window.backend.isSendToShortcutInstalled);
  if (!hasSendToBackend) {
    if (sendToSection) sendToSection.classList.add('hidden');
    if (sendToCard) sendToCard.classList.add('hidden');
  }

  async function refreshSendToStatus() {
    if (!hasSendToBackend) return;
    const badge = document.getElementById('sendto-status-badge');
    const btnInstall = document.getElementById('btn-install-sendto');
    const btnUninstall = document.getElementById('btn-uninstall-sendto');
    try {
      const installed = await window.backend.isSendToShortcutInstalled();
      if (badge) {
        badge.textContent = installed ? t('sendToStatusInstalled') : t('sendToStatusNotInstalled');
      }
      if (btnInstall) btnInstall.classList.toggle('hidden', !!installed);
      if (btnUninstall) btnUninstall.classList.toggle('hidden', !installed);
    } catch (e) {
      if (badge) badge.textContent = t('sendToStatusNotInstalled');
    }
  }

  const btnInstallSendTo = document.getElementById('btn-install-sendto');
  if (btnInstallSendTo) {
    btnInstallSendTo.addEventListener('click', async () => {
      const hint = document.getElementById('sendto-result-hint');
      if (!window.backend || !window.backend.installSendToShortcut) return;
      try {
        await window.backend.installSendToShortcut();
        if (hint) { hint.textContent = ''; }
      } catch (e) {
        if (hint) hint.textContent = t('sendToInstallFailed', { err: (e && e.message) || String(e) });
      }
      refreshSendToStatus();
    });
  }

  const btnUninstallSendTo = document.getElementById('btn-uninstall-sendto');
  if (btnUninstallSendTo) {
    btnUninstallSendTo.addEventListener('click', async () => {
      const hint = document.getElementById('sendto-result-hint');
      if (!window.backend || !window.backend.uninstallSendToShortcut) return;
      try {
        await window.backend.uninstallSendToShortcut();
        if (hint) { hint.textContent = ''; }
      } catch (e) {
        if (hint) hint.textContent = t('sendToInstallFailed', { err: (e && e.message) || String(e) });
      }
      refreshSendToStatus();
    });
  }

  const btnBrowseInboxDir = document.getElementById('btn-browse-inbox-dir');
  if (btnBrowseInboxDir) {
    btnBrowseInboxDir.onclick = async () => {
      if (window.backend && window.backend.openFolder) {
        try {
          const selected = await window.backend.openFolder();
          if (selected) {
            const input = document.getElementById('cfg-inbox-dir');
            if (input) input.value = selected;
          }
        } catch (e) { /* user canceled or dialog failed; leave the field as-is */ }
      }
    };
  }

  // --- Discord Bridge: background status + a new scrap arriving while the app may be minimized ---
  // Deliberately its own handler, not onScrapAppended: that one switches the active tab to the
  // scrap file, right for "I just ran a CLI pipe" but wrong for a message that can arrive at any
  // moment in the background - it must never steal focus from whatever the user is editing.
  window.onDiscordBridgeStatus = function(info) {
    if (!info) return;
    const hint = document.getElementById('discord-test-result-hint');
    if (!hint || !settingsModal || settingsModal.classList.contains('hidden')) return;
    if (info.status === 'connected') {
      hint.textContent = t('discordBridgeStatusConnected');
      hint.style.color = 'var(--accent-color, #4dabf7)';
    } else if (info.status === 'connecting') {
      hint.textContent = t('discordBridgeStatusConnecting');
      hint.style.color = 'var(--text-muted)';
    } else if (info.status === 'error') {
      hint.textContent = t('discordBridgeStatusError', { err: info.message || '' });
      hint.style.color = '#ff6b6b';
    }
  };

  window.onDiscordBridgeMessage = async function(data) {
    if (!data) return;
    const targetTab = tabs.find(t => t.path === data.filePath || t.title === data.fileName);
    if (targetTab && window.backend && window.backend.readFileByPath) {
      try {
        const res = await window.backend.readFileByPath(data.filePath);
        if (res && res.content !== undefined) {
          targetTab.content = res.content;
          targetTab.isDirty = false;
          if (activeTabId === targetTab.id) {
            editorEl.value = res.content;
            updateLineNumbers();
          }
        }
      } catch (e) {
        console.warn('Failed to refresh scrap tab after a Discord message:', e);
      }
    }
    showMessage(t('discordBridgeMessageToast'), 2500);
  };

  // Settings Dialog
  let openedConfigSnapshot = null;

  function openSettings() {
    try {
      openedConfigSnapshot = JSON.parse(JSON.stringify(config));
    } catch (e) {
      openedConfigSnapshot = Object.assign({}, config);
    }
    applyLanguage();

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

    const voiceModelEl = document.getElementById('cfg-voice-model');
    if (voiceModelEl) voiceModelEl.value = (config.voice && config.voice.model) || 'gemini-3.5-transcribe';
    const voiceStyleEl = document.getElementById('cfg-voice-api-style');
    if (voiceStyleEl) {
      const style = config.voice && config.voice.apiStyle;
      voiceStyleEl.value = (style === 'interactions' || style === 'generateContent') ? style : 'auto';
    }
    const voiceLanguageEl = document.getElementById('cfg-voice-language');
    if (voiceLanguageEl) voiceLanguageEl.value = listToText(config.voice && config.voice.languageCodes, ', ');
    const voiceModeEl = document.getElementById('cfg-voice-mode');
    if (voiceModeEl) voiceModeEl.value = (config.voice && config.voice.mode === 'verbatim') ? 'verbatim' : 'smart';
    const voiceVocabularyEl = document.getElementById('cfg-voice-vocabulary');
    if (voiceVocabularyEl) voiceVocabularyEl.value = listToText(config.voice && config.voice.customVocabulary, '\n');
    const voiceSilenceEl = document.getElementById('cfg-voice-silence');
    if (voiceSilenceEl) voiceSilenceEl.value = (config.voice && config.voice.silence_timeout_sec) || 5;
    const voiceRefine = (config.voice && config.voice.refine) || {};
    const voiceRefineEnabledEl = document.getElementById('cfg-voice-refine-enabled');
    if (voiceRefineEnabledEl) voiceRefineEnabledEl.checked = voiceRefineEnabled();
    const voiceRefineModelEl = document.getElementById('cfg-voice-refine-model');
    if (voiceRefineModelEl) voiceRefineModelEl.value = voiceRefine.model || 'gemini-flash-lite-latest';
    const voiceRefineTimeoutEl = document.getElementById('cfg-voice-refine-timeout');
    if (voiceRefineTimeoutEl) voiceRefineTimeoutEl.value = voiceRefine.timeoutSec || 5;
    const voicePromptEl = document.getElementById('cfg-voice-prompt');
    if (voicePromptEl) voicePromptEl.value = (config.voice && config.voice.prompt) || '';
    const voiceCredentialHintEl = document.getElementById('cfg-voice-credential-hint');
    if (voiceCredentialHintEl) {
      voiceCredentialHintEl.classList.toggle('hidden', !!(config.voice && config.voice.apiKey));
    }

    const cliModelEl = document.getElementById('cfg-cli-model');
    if (cliModelEl) cliModelEl.value = (config.cli && config.cli.model) || '';
    const cliBaseUrlEl = document.getElementById('cfg-cli-base-url');
    if (cliBaseUrlEl) cliBaseUrlEl.value = (config.cli && config.cli.baseUrl) || '';
    const cliApiKeyEl = document.getElementById('cfg-cli-api-key');
    if (cliApiKeyEl) cliApiKeyEl.value = (config.cli && config.cli.apiKey) || '';
    const cliSysPromptEl = document.getElementById('cfg-cli-system-prompt');
    if (cliSysPromptEl) cliSysPromptEl.value = (config.cli && config.cli.systemPrompt) || '';
    const cliOpenNewTabEl = document.getElementById('cfg-cli-open-new-tab');
    if (cliOpenNewTabEl) cliOpenNewTabEl.checked = config.cli ? (config.cli.openResultInNewTab !== false) : true;
    const cliResultPlacementEl = document.getElementById('cfg-cli-result-placement');
    if (cliResultPlacementEl) cliResultPlacementEl.value = cliResultPlacement();
    const cliOpenErrorTabEl = document.getElementById('cfg-cli-open-error-tab');
    if (cliOpenErrorTabEl) cliOpenErrorTabEl.checked = config.cli ? (config.cli.openErrorInNewTab !== false) : true;

    const actEnabledEl = document.getElementById('cfg-action-enabled');
    if (actEnabledEl) actEnabledEl.checked = config.action ? (config.action.enabled !== false) : true;
    const actManualOnlyEl = document.getElementById('cfg-action-manual-only');
    if (actManualOnlyEl) actManualOnlyEl.checked = config.action ? !!config.action.manualOnly : false;
    const actDelayEl = document.getElementById('cfg-action-delay');
    if (actDelayEl) actDelayEl.value = (config.action && typeof config.action.delaySec === 'number') ? config.action.delaySec : 1.5;
    const actBaseUrlEl = document.getElementById('cfg-action-base-url');
    if (actBaseUrlEl) actBaseUrlEl.value = (config.action && config.action.baseUrl) || '';
    const actModelEl = document.getElementById('cfg-action-model');
    if (actModelEl) actModelEl.value = (config.action && config.action.model) || '';
    const actApiKeyEl = document.getElementById('cfg-action-api-key');
    if (actApiKeyEl) actApiKeyEl.value = (config.action && config.action.apiKey) || '';

    const imgApiKeyInput = document.getElementById('cfg-image-api-key');
    if (imgApiKeyInput) imgApiKeyInput.value = (config.image && config.image.apiKey) || '';
    const imgModelInput = document.getElementById('cfg-image-model');
    if (imgModelInput) imgModelInput.value = (config.image && config.image.model) || 'gemini-3.1-flash-lite-image';
    const imgAspectSelect = document.getElementById('cfg-image-aspect-ratio');
    if (imgAspectSelect) imgAspectSelect.value = (config.image && config.image.aspectRatio) || '16:9';
    const imgResSelect = document.getElementById('cfg-image-resolution');
    if (imgResSelect) imgResSelect.value = (config.image && config.image.resolution) || '1024';

    const themeSelect = document.getElementById('cfg-theme');
    if (themeSelect) {
      themeSelect.value = config.general.theme || 'olive';
    }
    const mermaidToneSelect = document.getElementById('cfg-mermaid-tone');
    if (mermaidToneSelect) {
      mermaidToneSelect.value = window.MermaidTone.normalizeTone(config.general.mermaidTone);
    }
    document.getElementById('cfg-language').value = config.general.language || 'en';
    document.getElementById('cfg-restore-session').checked = config.general.restoreSession !== false;
    document.getElementById('cfg-autosave').checked = config.general.autoSave;
    document.getElementById('cfg-paste-image-ocr').checked = config.general.pasteImageOcr;
    const pasteHtmlMdEl = document.getElementById('cfg-paste-html-md');
    if (pasteHtmlMdEl) pasteHtmlMdEl.checked = config.general.pasteHtmlAsMarkdown !== false;
    const imeGuardianCheckbox = document.getElementById('cfg-ime-guardian');
    if (imeGuardianCheckbox) {
      imeGuardianCheckbox.checked = !!(config.general && config.general.imeGuardian);
    }
    // Refresh the OS-capability hints (persistent IME hint, tray/Dock disable)
    // in case platformCapabilities resolved after the last render.
    updateImeGuardianCapabilityHint();
    applyTrayCapabilityUI();
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
    const splitViewOnStartupCheckbox = document.getElementById('cfg-split-view-on-startup');
    if (splitViewOnStartupCheckbox) {
      splitViewOnStartupCheckbox.checked = !!(config.general && config.general.splitViewOnStartup);
    }

    // Slot & Autonomous Agent Settings (v2.2.0)
    const slotTimeoutEl = document.getElementById('cfg-slot-timeout');
    if (slotTimeoutEl) slotTimeoutEl.value = config.timeout_seconds || 180;
    const ghostDiffEl = document.getElementById('cfg-slot-ghost-diff-ms');
    if (ghostDiffEl) ghostDiffEl.value = config.ghost_diff_duration_ms || 4000;
    const hoverPeekEl = document.getElementById('cfg-slot-hover-peek');
    if (hoverPeekEl) hoverPeekEl.checked = config.hover_peek_enabled !== false;
    const defaultAgentEl = document.getElementById('cfg-default-agent');
    if (defaultAgentEl) defaultAgentEl.value = config.default_agent || 'claude-code';
    checkActiveAgentsConfigStatus();

    const autoSelEnabledEl = document.getElementById('cfg-autosel-enabled');
    if (autoSelEnabledEl) autoSelEnabledEl.checked = getAutoSelectorConfig().enabled;
    const autoSelConfirmEl = document.getElementById('cfg-autosel-agent-confirm');
    if (autoSelConfirmEl) autoSelConfirmEl.checked = getAutoSelectorConfig().agentConfirm;
    updateAutoSelectorFieldStates();

    // Scraps & Background Git Sync Settings
    const scrapDirEl = document.getElementById('cfg-scrap-dir');
    if (scrapDirEl) {
      scrapDirEl.value = (config.scraps && config.scraps.scrapDir) || config.scrap_dir || '~/Documents/md-memo/scraps';
    }
    const gitSyncEnabledEl = document.getElementById('cfg-git-sync-enabled');
    if (gitSyncEnabledEl) {
      gitSyncEnabledEl.checked = config.scraps ? (config.scraps.gitSyncEnabled !== false) : (config.git_sync_enabled !== false);
    }
    const gitDebounceEl = document.getElementById('cfg-git-debounce');
    if (gitDebounceEl) {
      gitDebounceEl.value = (config.scraps && config.scraps.gitSyncDebounceSeconds) || config.git_sync_debounce_seconds || 30;
    }
    const gitBranchEl = document.getElementById('cfg-git-remote-branch');
    if (gitBranchEl) {
      gitBranchEl.value = (config.scraps && config.scraps.gitRemoteBranch) || config.git_remote_branch || 'main';
    }
    const gitRemoteUrlEl = document.getElementById('cfg-git-remote-url');
    if (gitRemoteUrlEl) {
      gitRemoteUrlEl.value = (config.scraps && config.scraps.gitRemoteUrl) || '';
    }
    const maxPipeSizeEl = document.getElementById('cfg-max-pipe-size');
    if (maxPipeSizeEl) {
      maxPipeSizeEl.value = (config.scraps && config.scraps.maxPipeSizeMB) || config.max_pipe_size_mb || 10;
    }

    // Discord Bridge
    const discordEnabledEl = document.getElementById('cfg-discord-enabled');
    if (discordEnabledEl) discordEnabledEl.checked = !!(config.discordBridge && config.discordBridge.enabled);
    const discordTokenEl = document.getElementById('cfg-discord-bot-token');
    if (discordTokenEl) discordTokenEl.value = (config.discordBridge && config.discordBridge.botToken) || '';
    const discordUserIdEl = document.getElementById('cfg-discord-user-id');
    if (discordUserIdEl) discordUserIdEl.value = (config.discordBridge && config.discordBridge.allowedUserId) || '';
    const discordIntervalEl = document.getElementById('cfg-discord-poll-interval');
    if (discordIntervalEl) discordIntervalEl.value = (config.discordBridge && config.discordBridge.pollIntervalSeconds) || 45;
    const discordHintEl = document.getElementById('discord-test-result-hint');
    if (discordHintEl) discordHintEl.textContent = '';
    updateDiscordBridgeFieldStates();

    // Inbox (Hot Folder)
    const inboxEnabledEl = document.getElementById('cfg-inbox-enabled');
    if (inboxEnabledEl) inboxEnabledEl.checked = !!(config.inbox && config.inbox.enabled);
    const inboxDirEl = document.getElementById('cfg-inbox-dir');
    if (inboxDirEl) inboxDirEl.value = (config.inbox && config.inbox.dir) || '';
    const ocrOnDeviceEl = document.getElementById('cfg-ocr-on-device');
    if (ocrOnDeviceEl) {
      ocrOnDeviceEl.checked = !!(config.vision && config.vision.ocrMode === 'on-device');
      // The on-device OCR is Windows.Media.Ocr; there is no macOS engine behind it, so "on-device only"
      // would make every image fail there. Do not offer it.
      const ocrGroup = ocrOnDeviceEl.closest ? ocrOnDeviceEl.closest('.form-group') : null;
      if (ocrGroup && ocrGroup.classList) ocrGroup.classList.toggle('hidden', isMac || platformCapabilities.os === 'darwin');
    }

    // On-device speech engine (Whisper) panel in the Voice section.
    if (window.SpeechSettings) {
      window.SpeechSettings.init({ t, backend: window.backend, doc: document });
      window.SpeechSettings.load(config);
    }

    refreshSendToStatus();

    const currentScrapDir = scrapDirEl ? scrapDirEl.value.trim() : '';
    updateGitRepoStatusUI(currentScrapDir);

    renderShortcutsTable();
    updateShortcutLabels();
    switchSettingsTab('general');
    updateOllamaStatus();
    updateQuickActionsFieldStates();
    updateLLMProviderDetection();
    settingsModal.classList.remove('hidden');
    // Match the other modals in this app: move focus into the dialog on open, and
    // back to the editor on close.
    setTimeout(() => {
      if (tabBtnGeneral) tabBtnGeneral.focus();
    }, 50);
  }

  function closeSettings() {
    activeRecordingAction = null;
    settingsModal.classList.add('hidden');
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  // Restores config fields that were mutated live (applied immediately while
  // the dialog was open, before Save) back to the snapshot taken at open time.
  // Called only on Cancel/×/Esc — never after a real Save.
  function restoreLiveConfigFromSnapshot() {
    const snap = openedConfigSnapshot;
    if (!snap) return;
    let languageChanged = false;
    let themeChanged = false;
    if (config.general && snap.general) {
      if (config.general.language !== snap.general.language) {
        config.general.language = snap.general.language;
        languageChanged = true;
      }
      if (config.general.theme !== snap.general.theme) {
        config.general.theme = snap.general.theme;
        themeChanged = true;
      }
    }
    if (config.default_agent !== snap.default_agent) {
      config.default_agent = snap.default_agent;
      if (window.SlotAgent && window.SlotAgent.updateConfig) {
        window.SlotAgent.updateConfig(config);
      }
    }
    // Shortcut recording mutates config.shortcuts in place (matchShortcut()
    // reads it live), so an unsaved recording would otherwise stay active
    // for the rest of the session even after Cancel.
    if (snap.shortcuts && JSON.stringify(config.shortcuts) !== JSON.stringify(snap.shortcuts)) {
      config.shortcuts = Object.assign({}, snap.shortcuts);
      clearShortcutParseCache();
      updateShortcutLabels();
    }
    // Toolbar / right-click layout edits are applied live too: put the saved arrangement back.
    let layoutChanged = false;
    if (config.general && snap.general) {
      for (const key of ['toolbarLayout', 'contextMenuLayout']) {
        if (JSON.stringify(config.general[key]) !== JSON.stringify(snap.general[key])) {
          config.general[key] = snap.general[key]
            ? JSON.parse(JSON.stringify(snap.general[key]))
            : { order: [], hidden: [] };
          layoutChanged = true;
        }
      }
    }
    if (languageChanged) applyLanguage();
    if (themeChanged) applyTheme();
    if (layoutChanged) applyChromeLayout();
  }

  // Cancel / × / Esc path: undo anything applied live, then hide the dialog.
  // Never persists to disk (agents.yaml, config.json) — only Save does that.
  function cancelSettings() {
    restoreLiveConfigFromSnapshot();
    closeSettings();
  }

  async function updateGitRepoStatusUI(dir) {
    const badge = document.getElementById('git-repo-status-badge');
    const remoteInput = document.getElementById('cfg-git-remote-url');
    if (!badge) return;

    if (!window.backend || !window.backend.getGitRepoStatus) {
      badge.removeAttribute('data-i18n');
      badge.textContent = 'Local';
      return;
    }

    try {
      const status = await window.backend.getGitRepoStatus(dir || '');
      if (status) {
        badge.removeAttribute('data-i18n'); // real status resolved; stop applyLanguage() from resetting it to "Checking..."
        if (!status.is_git) {
          badge.textContent = t('gitStatusNotGit');
          badge.style.background = 'rgba(255, 193, 7, 0.15)';
          badge.style.color = '#ffc107';
        } else if (status.remote_url) {
          const shortUrl = status.remote_url.replace(/https?:\/\/|git@/g, '').split('/')[1] || status.remote_url;
          badge.textContent = t('gitStatusLinked', { url: shortUrl });
          badge.title = status.remote_url;
          badge.style.background = 'rgba(40, 167, 69, 0.15)';
          badge.style.color = '#28a745';
          if (remoteInput && !remoteInput.value) {
            remoteInput.value = status.remote_url;
          }
        } else {
          badge.textContent = t('gitStatusNoRemote');
          badge.style.background = 'rgba(108, 117, 125, 0.15)';
          badge.style.color = '#adb5bd';
        }
      }
    } catch (e) {
      console.warn('Failed to get git status:', e);
      badge.removeAttribute('data-i18n');
      badge.textContent = 'Error';
    }
  }

  // Wire protocol detection for the Text model's Base URL: the app used to
  // silently guess Ollama/Gemini/OpenAI from the URL shape with no feedback.
  // This surfaces what was actually detected, using the backend's own
  // heuristic (never re-implemented here).
  let providerDetectReqToken = 0;
  async function updateLLMProviderDetection() {
    const lineEl = document.getElementById('text-provider-detect-line');
    if (!lineEl) return;
    if (!(window.backend && window.backend.detectLLMProvider)) {
      lineEl.classList.add('hidden');
      return;
    }
    const baseUrlEl = document.getElementById('cfg-base-url');
    const apiKeyEl = document.getElementById('cfg-api-key');
    const baseUrl = baseUrlEl ? baseUrlEl.value.trim() : '';
    const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
    if (!baseUrl) {
      lineEl.classList.add('hidden');
      return;
    }
    const myToken = ++providerDetectReqToken;
    try {
      const provider = await window.backend.detectLLMProvider(baseUrl, apiKey);
      if (myToken !== providerDetectReqToken) return; // stale response, URL changed since
      const providerLabelKeys = {
        ollama: 'providerOllama',
        gemini: 'providerGemini',
        'openai-compatible': 'providerOpenAICompatible'
      };
      if (providerLabelKeys[provider]) {
        lineEl.textContent = t('llmProtocolDetected', { protocol: t(providerLabelKeys[provider]) });
      } else {
        lineEl.textContent = t('llmProtocolUnknown');
      }
      lineEl.classList.remove('hidden');
    } catch (e) {
      lineEl.classList.add('hidden');
    }
  }

  let providerDetectDebounceTimer = null;
  function debouncedUpdateLLMProviderDetection() {
    if (providerDetectDebounceTimer) clearTimeout(providerDetectDebounceTimer);
    providerDetectDebounceTimer = setTimeout(updateLLMProviderDetection, 300);
  }
  const cfgBaseUrlEl = document.getElementById('cfg-base-url');
  if (cfgBaseUrlEl) cfgBaseUrlEl.addEventListener('input', debouncedUpdateLLMProviderDetection);
  const cfgApiKeyForProviderEl = document.getElementById('cfg-api-key');
  if (cfgApiKeyForProviderEl) cfgApiKeyForProviderEl.addEventListener('input', debouncedUpdateLLMProviderDetection);

  // Ollama Lifecycle & Automated Gemma 4 Setup
  async function updateOllamaStatus() {
    const badge = document.getElementById('ollama-status-badge');
    const btnStart = document.getElementById('btn-start-ollama');
    const btnStop = document.getElementById('btn-stop-ollama');
    if (!badge) return;

    if (!window.backend || !window.backend.checkOllamaRunning) {
      badge.removeAttribute('data-i18n');
      badge.textContent = 'Local';
      badge.style.background = 'rgba(255,255,255,0.1)';
      badge.style.color = '#aaa';
      if (btnStart) btnStart.classList.add('hidden');
      if (btnStop) btnStop.classList.add('hidden');
      return;
    }

    try {
      const running = await window.backend.checkOllamaRunning();
      badge.removeAttribute('data-i18n');
      if (running) {
        badge.textContent = t('ollamaRunning');
        badge.style.background = 'rgba(46, 204, 113, 0.2)';
        badge.style.color = '#2ecc71';
        if (btnStart) btnStart.classList.add('hidden');
        if (btnStop) btnStop.classList.remove('hidden');
      } else {
        badge.textContent = t('ollamaStopped');
        badge.style.background = 'rgba(231, 76, 60, 0.2)';
        badge.style.color = '#e74c3c';
        if (btnStart) btnStart.classList.remove('hidden');
        if (btnStop) btnStop.classList.add('hidden');
      }
    } catch (e) {
      badge.removeAttribute('data-i18n');
      badge.textContent = t('ollamaStopped');
      badge.style.background = 'rgba(231, 76, 60, 0.2)';
      badge.style.color = '#e74c3c';
      if (btnStart) btnStart.classList.remove('hidden');
      if (btnStop) btnStop.classList.add('hidden');
    }
  }

  let activeOllamaSetupReqId = null;

  const btnStartOllama = document.getElementById('btn-start-ollama');
  if (btnStartOllama) {
    btnStartOllama.onclick = async () => {
      const badge = document.getElementById('ollama-status-badge');
      if (badge) {
        badge.textContent = t('ollamaChecking');
        badge.style.color = '#f1c40f';
      }
      btnStartOllama.disabled = true;
      if (window.backend && window.backend.startOllamaService) {
        try {
          await window.backend.startOllamaService();
          showMessage(t('ollamaStarted'), 3000);
        } catch (e) {
          showMessage(t('ollamaStartFailed', { err: e.message || String(e) }), 4000);
        }
      }
      setTimeout(() => {
        btnStartOllama.disabled = false;
        updateOllamaStatus();
      }, 2000);
    };
  }

  const btnStopOllama = document.getElementById('btn-stop-ollama');
  if (btnStopOllama) {
    btnStopOllama.onclick = async () => {
      btnStopOllama.disabled = true;
      if (window.backend && window.backend.stopOllamaService) {
        try {
          await window.backend.stopOllamaService();
          showMessage(t('ollamaStoppedSuccess'), 3000);
        } catch (e) {}
      }
      setTimeout(() => {
        btnStopOllama.disabled = false;
        updateOllamaStatus();
      }, 1000);
    };
  }

  const btnSetupOllama = document.getElementById('btn-setup-ollama');
  const btnCancelOllamaSetup = document.getElementById('btn-cancel-ollama-setup');
  const ollamaProgressBox = document.getElementById('ollama-setup-progress-box');
  const ollamaProgressMsg = document.getElementById('ollama-progress-msg');
  const ollamaProgressStep = document.getElementById('ollama-progress-step');
  const ollamaProgressBar = document.getElementById('ollama-progress-bar');

  if (btnSetupOllama) {
    btnSetupOllama.onclick = () => {
      activeOllamaSetupReqId = 'ollama_setup_' + Date.now();
      if (ollamaProgressBox) ollamaProgressBox.classList.remove('hidden');
      if (ollamaProgressMsg) ollamaProgressMsg.textContent = t('ollamaChecking');
      if (ollamaProgressStep) ollamaProgressStep.textContent = 'Step 1/5';
      if (ollamaProgressBar) ollamaProgressBar.style.width = '20%';
      btnSetupOllama.classList.add('hidden');
      if (btnCancelOllamaSetup) btnCancelOllamaSetup.classList.remove('hidden');

      if (window.backend && window.backend.setupOllamaGemma4Async) {
        window.backend.setupOllamaGemma4Async(activeOllamaSetupReqId);
      }
    };
  }

  if (btnCancelOllamaSetup) {
    btnCancelOllamaSetup.onclick = () => {
      if (activeOllamaSetupReqId && window.backend && window.backend.cancelOllamaSetup) {
        window.backend.cancelOllamaSetup(activeOllamaSetupReqId);
      }
      if (ollamaProgressBox) ollamaProgressBox.classList.add('hidden');
      if (btnSetupOllama) btnSetupOllama.classList.remove('hidden');
      btnCancelOllamaSetup.classList.add('hidden');
      activeOllamaSetupReqId = null;
    };
  }

  window.__onOllamaSetupProgress = (prog) => {
    if (!prog || (activeOllamaSetupReqId && prog.reqId !== activeOllamaSetupReqId)) {
      return;
    }

    if (ollamaProgressMsg && prog.message) {
      ollamaProgressMsg.textContent = prog.message;
    }
    if (ollamaProgressStep && prog.step) {
      ollamaProgressStep.textContent = `Step ${prog.step}/${prog.total || 5}`;
    }
    if (ollamaProgressBar && prog.step && prog.total) {
      const pct = Math.min(100, Math.round((prog.step / prog.total) * 100));
      ollamaProgressBar.style.width = pct + '%';
    }

    if (prog.isDone) {
      if (btnSetupOllama) btnSetupOllama.classList.remove('hidden');
      if (btnCancelOllamaSetup) btnCancelOllamaSetup.classList.add('hidden');
      setTimeout(() => {
        if (ollamaProgressBox) ollamaProgressBox.classList.add('hidden');
      }, 3000);

      if (prog.success) {
        const baseUrl = 'http://localhost:11434';
        const model = 'gemma4:e2b';

        const baseInput = document.getElementById('cfg-base-url');
        const modelInput = document.getElementById('cfg-model');
        const autoBaseInput = document.getElementById('cfg-auto-base-url');
        const autoModelInput = document.getElementById('cfg-auto-model');

        if (baseInput) baseInput.value = baseUrl;
        if (modelInput) modelInput.value = model;
        if (autoBaseInput) autoBaseInput.value = baseUrl;
        if (autoModelInput) autoModelInput.value = model;

        config.text.baseUrl = baseUrl;
        config.text.model = model;
        config.autocomplete.baseUrl = baseUrl;
        config.autocomplete.model = model;

        savePersistentConfig();
        updateOllamaStatus();
        showMessage(t('ollamaSetupSuccess'), 4000);
      } else {
        updateOllamaStatus();
        showMessage(t('ollamaSetupFailed', { err: prog.error || 'Unknown error' }), 5000);
      }
      activeOllamaSetupReqId = null;
    }
  };

  const cfgLanguageSelect = document.getElementById('cfg-language');
  if (cfgLanguageSelect) {
    cfgLanguageSelect.onchange = () => {
      config.general.language = cfgLanguageSelect.value;
      const imeCheckbox = document.getElementById('cfg-ime-guardian');
      // Don't auto-check IME Guardian on an OS that can't switch the input
      // source automatically (see applyImeGuardianCapabilityDefault()): turning
      // it on there just produces mixed kana/latin text, so switching the UI
      // language to Japanese must not silently flip it on behind the user.
      if (imeCheckbox && platformCapabilities.nativeImeSwitch !== false) {
        imeCheckbox.checked = (cfgLanguageSelect.value === 'ja');
      }
      applyLanguage();
    };
  }

  document.querySelectorAll('.btn-get-gemini-key').forEach(btn => {
    btn.onclick = () => {
      const url = 'https://aistudio.google.com/app/apikey';
      if (window.backend && window.backend.openExternal) {
        window.backend.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    };
  });

  document.querySelectorAll('.link-external').forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const url = link.getAttribute('href');
      if (url) {
        if (window.backend && window.backend.openExternal) {
          window.backend.openExternal(url);
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
    };
  });

  document.getElementById('modal-close').onclick = cancelSettings;
  document.getElementById('btn-cancel-settings').onclick = cancelSettings;
  document.getElementById('btn-save-settings').onclick = async () => {
    config.text.baseUrl = document.getElementById('cfg-base-url').value.trim() || 'http://localhost:11434';
    config.text.model = document.getElementById('cfg-model').value.trim() || 'qwen2.5:latest';
    config.text.apiKey = document.getElementById('cfg-api-key').value.trim();
    config.text.systemPrompt = document.getElementById('cfg-system-prompt').value.trim();

    config.autocomplete.enabled = document.getElementById('cfg-auto-enabled').checked;
    config.autocomplete.baseUrl = document.getElementById('cfg-auto-base-url').value.trim() || 'http://localhost:11434';
    config.autocomplete.model = document.getElementById('cfg-auto-model').value.trim() || 'qwen2.5:latest';
    config.autocomplete.apiKey = document.getElementById('cfg-auto-api-key').value.trim();
    config.autocomplete.delayMs = clampNumber(document.getElementById('cfg-auto-delay').value, 200, 2000, 500);
    config.autocomplete.maxTokens = clampNumber(document.getElementById('cfg-auto-tokens').value, 10, 100, 30);

    config.vision.baseUrl = document.getElementById('cfg-vision-base-url').value.trim() || 'https://generativelanguage.googleapis.com';
    config.vision.model = document.getElementById('cfg-vision-model').value.trim() || 'gemini-flash-lite-latest';
    config.vision.apiKey = document.getElementById('cfg-vision-api-key').value.trim();
    config.vision.prompt = document.getElementById('cfg-vision-prompt').value.trim();

    if (!config.voice) config.voice = {};
    const saveVoiceModelEl = document.getElementById('cfg-voice-model');
    if (saveVoiceModelEl) config.voice.model = saveVoiceModelEl.value.trim() || 'gemini-3.5-transcribe';
    const saveVoiceStyleEl = document.getElementById('cfg-voice-api-style');
    if (saveVoiceStyleEl) config.voice.apiStyle = saveVoiceStyleEl.value || 'auto';
    const saveVoiceLanguageEl = document.getElementById('cfg-voice-language');
    if (saveVoiceLanguageEl) config.voice.languageCodes = textToList(saveVoiceLanguageEl.value, /[\s,、，]+/);
    const saveVoiceModeEl = document.getElementById('cfg-voice-mode');
    if (saveVoiceModeEl) config.voice.mode = saveVoiceModeEl.value === 'verbatim' ? 'verbatim' : 'smart';
    const saveVoiceVocabularyEl = document.getElementById('cfg-voice-vocabulary');
    if (saveVoiceVocabularyEl) config.voice.customVocabulary = textToList(saveVoiceVocabularyEl.value, /\r?\n/);
    const saveVoiceSilenceEl = document.getElementById('cfg-voice-silence');
    if (saveVoiceSilenceEl) config.voice.silence_timeout_sec = clampNumber(saveVoiceSilenceEl.value, 1, 30, 5);
    const saveVoicePromptEl = document.getElementById('cfg-voice-prompt');
    if (saveVoicePromptEl) config.voice.prompt = saveVoicePromptEl.value.trim();
    const saveRefineEnabledEl = document.getElementById('cfg-voice-refine-enabled');
    if (saveRefineEnabledEl) {
      const saveRefineModelEl = document.getElementById('cfg-voice-refine-model');
      const saveRefineTimeoutEl = document.getElementById('cfg-voice-refine-timeout');
      config.voice.refine = {
        enabled: saveRefineEnabledEl.checked,
        model: (saveRefineModelEl && saveRefineModelEl.value.trim()) || 'gemini-flash-lite-latest',
        timeoutSec: saveRefineTimeoutEl ? clampNumber(saveRefineTimeoutEl.value, 1, 30, 5) : 5
      };
    }

    if (!config.cli) config.cli = {};
    const saveCliModelEl = document.getElementById('cfg-cli-model');
    if (saveCliModelEl) config.cli.model = saveCliModelEl.value.trim();
    const saveCliBaseUrlEl = document.getElementById('cfg-cli-base-url');
    if (saveCliBaseUrlEl) config.cli.baseUrl = saveCliBaseUrlEl.value.trim();
    const saveCliApiKeyEl = document.getElementById('cfg-cli-api-key');
    if (saveCliApiKeyEl) config.cli.apiKey = saveCliApiKeyEl.value.trim();
    const saveCliPromptEl = document.getElementById('cfg-cli-system-prompt');
    if (saveCliPromptEl) config.cli.systemPrompt = saveCliPromptEl.value.trim();
    const saveCliOpenNewTabEl = document.getElementById('cfg-cli-open-new-tab');
    if (saveCliOpenNewTabEl) config.cli.openResultInNewTab = saveCliOpenNewTabEl.checked;
    const saveCliResultPlacementEl = document.getElementById('cfg-cli-result-placement');
    if (saveCliResultPlacementEl) config.cli.resultPlacement = saveCliResultPlacementEl.value === 'replace' ? 'replace' : 'below';
    const saveCliOpenErrorTabEl = document.getElementById('cfg-cli-open-error-tab');
    if (saveCliOpenErrorTabEl) config.cli.openErrorInNewTab = saveCliOpenErrorTabEl.checked;

    if (!config.action) config.action = {};
    const saveActEnabledEl = document.getElementById('cfg-action-enabled');
    if (saveActEnabledEl) config.action.enabled = saveActEnabledEl.checked;
    const saveActManualOnlyEl = document.getElementById('cfg-action-manual-only');
    if (saveActManualOnlyEl) config.action.manualOnly = saveActManualOnlyEl.checked;
    const saveActDelayEl = document.getElementById('cfg-action-delay');
    if (saveActDelayEl) {
      config.action.delaySec = clampNumber(saveActDelayEl.value, 0.5, 10.0, 1.5, true);
    }
    const saveActBaseUrlEl = document.getElementById('cfg-action-base-url');
    if (saveActBaseUrlEl) config.action.baseUrl = saveActBaseUrlEl.value.trim();
    const saveActModelEl = document.getElementById('cfg-action-model');
    if (saveActModelEl) config.action.model = saveActModelEl.value.trim() || 'jev-latest';
    const saveActApiKeyEl = document.getElementById('cfg-action-api-key');
    if (saveActApiKeyEl) config.action.apiKey = saveActApiKeyEl.value.trim();
    updateActionStatus();

    if (!config.image) config.image = {};
    const imgApiKeyEl = document.getElementById('cfg-image-api-key');
    if (imgApiKeyEl) config.image.apiKey = imgApiKeyEl.value.trim();
    const imgModelEl = document.getElementById('cfg-image-model');
    if (imgModelEl) config.image.model = imgModelEl.value.trim() || 'gemini-3.1-flash-lite-image';
    const imgAspectEl = document.getElementById('cfg-image-aspect-ratio');
    if (imgAspectEl) config.image.aspectRatio = imgAspectEl.value || '16:9';
    const imgResEl = document.getElementById('cfg-image-resolution');
    if (imgResEl) config.image.resolution = imgResEl.value || '1024';

    const themeSelect = document.getElementById('cfg-theme');
    if (themeSelect) {
      config.general.theme = themeSelect.value || 'olive';
    }
    const mermaidToneSelect = document.getElementById('cfg-mermaid-tone');
    if (mermaidToneSelect) {
      config.general.mermaidTone = window.MermaidTone.normalizeTone(mermaidToneSelect.value);
    }
    config.general.language = document.getElementById('cfg-language').value || 'en';
    config.general.restoreSession = document.getElementById('cfg-restore-session').checked;
    config.general.autoSave = document.getElementById('cfg-autosave').checked;
    config.general.pasteImageOcr = document.getElementById('cfg-paste-image-ocr').checked;
    const savePasteHtmlMdEl = document.getElementById('cfg-paste-html-md');
    if (savePasteHtmlMdEl) config.general.pasteHtmlAsMarkdown = savePasteHtmlMdEl.checked;
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
    const splitViewOnStartupSaveCheckbox = document.getElementById('cfg-split-view-on-startup');
    if (splitViewOnStartupSaveCheckbox) {
      config.general.splitViewOnStartup = splitViewOnStartupSaveCheckbox.checked;
    }

    // Save Slot & Autonomous Agent Settings
    const saveSlotTimeoutEl = document.getElementById('cfg-slot-timeout');
    if (saveSlotTimeoutEl) config.timeout_seconds = clampNumber(saveSlotTimeoutEl.value, 10, 600, 180);
    const saveGhostDiffEl = document.getElementById('cfg-slot-ghost-diff-ms');
    if (saveGhostDiffEl) config.ghost_diff_duration_ms = clampNumber(saveGhostDiffEl.value, 1000, 10000, 4000);
    const saveHoverPeekEl = document.getElementById('cfg-slot-hover-peek');
    if (saveHoverPeekEl) config.hover_peek_enabled = saveHoverPeekEl.checked;
    const saveDefaultAgentEl = document.getElementById('cfg-default-agent');
    if (saveDefaultAgentEl) {
      config.default_agent = saveDefaultAgentEl.value || 'claude-code';
    }
    if (!config.autoSelector || typeof config.autoSelector !== 'object') config.autoSelector = {};
    const saveAutoSelEnabledEl = document.getElementById('cfg-autosel-enabled');
    if (saveAutoSelEnabledEl) config.autoSelector.enabled = saveAutoSelEnabledEl.checked;
    const saveAutoSelConfirmEl = document.getElementById('cfg-autosel-agent-confirm');
    if (saveAutoSelConfirmEl) config.autoSelector.agentConfirm = saveAutoSelConfirmEl.checked;

    // Snapshot comparison for differential / dirty updates
    const prev = openedConfigSnapshot || {};
    const prevScraps = prev.scraps || {};
    const prevShortcuts = prev.shortcuts || {};
    const prevGeneral = prev.general || {};

    const scrapDirInput = (document.getElementById('cfg-scrap-dir') && document.getElementById('cfg-scrap-dir').value.trim()) || '';
    if (saveDefaultAgentEl && (config.default_agent !== prev.default_agent || (scrapDirInput && scrapDirInput !== prevScraps.scrapDir))) {
      if (window.backend && window.backend.updateActiveAgentsConfigDefaultAgent) {
        window.backend.updateActiveAgentsConfigDefaultAgent(scrapDirInput, config.default_agent).catch(e => {
          console.warn('Failed to update default_agent in agents.yaml:', e);
        });
      }
    }

    if (window.SlotAgent && window.SlotAgent.updateConfig) {
      window.SlotAgent.updateConfig(config);
    }

    // Save Scraps & Background Git Sync Settings
    if (!config.scraps) config.scraps = {};
    const saveScrapDirEl = document.getElementById('cfg-scrap-dir');
    if (saveScrapDirEl) {
      config.scraps.scrapDir = saveScrapDirEl.value.trim() || '~/Documents/md-memo/scraps';
      config.scrap_dir = config.scraps.scrapDir;
    }
    const saveGitSyncEnabledEl = document.getElementById('cfg-git-sync-enabled');
    if (saveGitSyncEnabledEl) {
      config.scraps.gitSyncEnabled = saveGitSyncEnabledEl.checked;
      config.git_sync_enabled = config.scraps.gitSyncEnabled;
    }
    const saveGitDebounceEl = document.getElementById('cfg-git-debounce');
    if (saveGitDebounceEl) {
      config.scraps.gitSyncDebounceSeconds = clampNumber(saveGitDebounceEl.value, 5, 3600, 30);
      config.git_sync_debounce_seconds = config.scraps.gitSyncDebounceSeconds;
    }
    const saveGitBranchEl = document.getElementById('cfg-git-remote-branch');
    if (saveGitBranchEl) {
      config.scraps.gitRemoteBranch = saveGitBranchEl.value.trim() || 'main';
      config.git_remote_branch = config.scraps.gitRemoteBranch;
    }
    const saveGitRemoteUrlEl = document.getElementById('cfg-git-remote-url');
    if (saveGitRemoteUrlEl) {
      config.scraps.gitRemoteUrl = saveGitRemoteUrlEl.value.trim();
    }
    const saveMaxPipeSizeEl = document.getElementById('cfg-max-pipe-size');
    if (saveMaxPipeSizeEl) {
      config.scraps.maxPipeSizeMB = clampNumber(saveMaxPipeSizeEl.value, 1, 100, 10);
      config.max_pipe_size_mb = config.scraps.maxPipeSizeMB;
    }

    // Save Discord Bridge settings
    if (!config.discordBridge) config.discordBridge = {};
    const saveDiscordEnabledEl = document.getElementById('cfg-discord-enabled');
    if (saveDiscordEnabledEl) config.discordBridge.enabled = saveDiscordEnabledEl.checked;
    const saveDiscordTokenEl = document.getElementById('cfg-discord-bot-token');
    if (saveDiscordTokenEl) config.discordBridge.botToken = saveDiscordTokenEl.value.trim();
    const saveDiscordUserIdEl = document.getElementById('cfg-discord-user-id');
    if (saveDiscordUserIdEl) config.discordBridge.allowedUserId = saveDiscordUserIdEl.value.trim();
    const saveDiscordIntervalEl = document.getElementById('cfg-discord-poll-interval');
    if (saveDiscordIntervalEl) config.discordBridge.pollIntervalSeconds = clampNumber(saveDiscordIntervalEl.value, 15, 600, 45);

    // Save Inbox (Hot Folder) settings
    if (!config.inbox) config.inbox = {};
    const saveInboxEnabledEl = document.getElementById('cfg-inbox-enabled');
    if (saveInboxEnabledEl) config.inbox.enabled = saveInboxEnabledEl.checked;
    const saveInboxDirEl = document.getElementById('cfg-inbox-dir');
    if (saveInboxDirEl) config.inbox.dir = saveInboxDirEl.value.trim();
    // "on-device" = never send images out; '' = the default (cloud model first, on-device as fallback).
    const saveOcrOnDeviceEl = document.getElementById('cfg-ocr-on-device');
    if (saveOcrOnDeviceEl && !(isMac || platformCapabilities.os === 'darwin')) config.vision.ocrMode = saveOcrOnDeviceEl.checked ? 'on-device' : '';
    if (window.SpeechSettings) window.SpeechSettings.save(config);

    // Only configure git remote if the remote URL or branch was genuinely changed by the user
    const prevRemoteUrl = (prevScraps.gitRemoteUrl || '').trim();
    const prevBranch = (prevScraps.gitRemoteBranch || 'main').trim();
    const curRemoteUrl = (config.scraps.gitRemoteUrl || '').trim();
    const curBranch = (config.scraps.gitRemoteBranch || 'main').trim();
    if (curRemoteUrl && (curRemoteUrl !== prevRemoteUrl || curBranch !== prevBranch) && window.backend && window.backend.setupGitRemote) {
      window.backend.setupGitRemote(config.scraps.scrapDir, curRemoteUrl, curBranch).catch(e => {
        console.warn('Differential setupGitRemote error:', e);
      });
    }

    // Apply UI theme & language only when changed
    if (config.general.theme !== prevGeneral.theme) {
      applyTheme();
    }
    if (config.general.language !== prevGeneral.language) {
      applyLanguage();
    }
    renderVoiceRefineStatus();
    // Diagram colors: redraw the diagrams already on screen (preview panes only; nothing when unchanged).
    if (window.MermaidTone.normalizeTone(config.general.mermaidTone) !== window.MermaidTone.normalizeTone(prevGeneral.mermaidTone)) {
      renderPreview();
      renderSecondaryPreview();
    }

    // Whether the global OS shortcut needs updating is decided here (before the
    // config snapshot variables go out of scope), but the actual backend call
    // and its failure handling are deferred until after the optimistic
    // close/save below — see the "Update global OS shortcut" block there.
    const prevShortcut = (prevShortcuts && prevShortcuts.globalSummon) || DEFAULT_SHORTCUTS.globalSummon;
    const prevQuickCapture = quickCaptureShortcutOf(prevShortcuts);
    const curShortcut = (config.shortcuts && config.shortcuts.globalSummon) || DEFAULT_SHORTCUTS.globalSummon;
    if (curShortcut !== prevShortcut) {
      updateShortcutLabels();
    }

    // Auto-stop Ollama only if user transitioned from Ollama to cloud API
    const wasOllamaConfigured = (prev.text && prev.text.baseUrl && prev.text.baseUrl.includes('11434')) ||
                               (prev.autocomplete && prev.autocomplete.enabled && prev.autocomplete.baseUrl && prev.autocomplete.baseUrl.includes('11434'));
    const isOllamaConfigured = (config.text.baseUrl && config.text.baseUrl.includes('11434')) ||
                               (config.autocomplete.enabled && config.autocomplete.baseUrl && config.autocomplete.baseUrl.includes('11434'));
    if (wasOllamaConfigured && !isOllamaConfigured && window.backend && window.backend.stopOllamaService) {
      window.backend.stopOllamaService().catch(() => {});
    }

    // Optimistic UI: Immediately close settings modal and show toast without waiting
    closeSettings();
    showMessage(t('settingsSaved'), 2000);

    // Save persistently in background
    saveSessionDebounced();
    savePersistentConfig().catch(e => {
      console.warn('Failed to save config persistently:', e);
    });

    // Update global OS shortcut only when changed. Deferred to here (after the
    // optimistic close/save above) so this async correction never delays
    // closing the dialog. The backend reports whether the OS actually accepted
    // the registration (on macOS in particular, this can genuinely fail); if it
    // didn't, revert to the previous value instead of leaving the user thinking
    // a broken shortcut is live.
    if (curShortcut !== prevShortcut && window.backend && window.backend.updateGlobalShortcut) {
      Promise.resolve(window.backend.updateGlobalShortcut(curShortcut)).then((ok) => {
        if (ok === false) {
          if (config.shortcuts) config.shortcuts.globalSummon = prevShortcut;
          clearShortcutParseCache();
          renderShortcutsTable();
          updateShortcutLabels();
          savePersistentConfig().catch(() => {});
          showMessage(t('globalShortcutRegisterFailed'), 5000);
        }
      }).catch((err) => {
        console.warn('updateGlobalShortcut failed:', err);
      });
    }
    syncQuickCaptureShortcut(prevQuickCapture);
  };

  // The quick-capture hotkey is registered with the OS (Windows), so a changed binding is handed to the
  // backend; if the OS refuses it (another program already owns the combination) the previous binding is
  // restored. An empty string means "no global hotkey", and only a missing value means the default.
  function quickCaptureShortcutOf(shortcuts) {
    const v = shortcuts && shortcuts.quickCapture;
    return typeof v === 'string' ? v : (DEFAULT_SHORTCUTS.quickCapture || '');
  }

  function syncQuickCaptureShortcut(prev) {
    if (!(window.backend && window.backend.updateQuickCaptureShortcut)) return;
    const cur = quickCaptureShortcutOf(config.shortcuts);
    if (cur === prev) return;
    Promise.resolve(window.backend.updateQuickCaptureShortcut(cur)).then((ok) => {
      if (ok === false) {
        if (config.shortcuts) config.shortcuts.quickCapture = prev;
        clearShortcutParseCache();
        renderShortcutsTable();
        updateShortcutLabels();
        savePersistentConfig().catch(() => {});
        showMessage(t('globalShortcutRegisterFailed'), 5000);
      }
    }).catch((err) => {
      console.warn('updateQuickCaptureShortcut failed:', err);
    });
  }

  // `next` is the whole config as merged by ConfigPack.mergeImported (imported sections laid over the
  // current values); only the top-level keys that actually changed are put back into the live config.
  function applyImportedConfig(next) {
    if (!next || typeof next !== 'object') {
      throw new Error("Invalid config format");
    }
    const prevSummon = (config.shortcuts && config.shortcuts.globalSummon) || DEFAULT_SHORTCUTS.globalSummon;
    const prevQuickCapture = quickCaptureShortcutOf(config.shortcuts);

    for (const key of Object.keys(next)) {
      if (key !== '__proto__' && next[key] !== config[key]) config[key] = next[key];
    }
    if (next.general && next.general.imeGuardian !== undefined) hasPersistedImeGuardianSetting = true;
    if (next.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, next.shortcuts);
    migrateInsertLineShortcuts();
    migrateZenShortcut(true);
    migrateAskShortcuts(true);
    migrateMacShortcuts(true);
    migrateFullscreenShortcut();
    if (window.SlotAgent && window.SlotAgent.updateConfig) {
      window.SlotAgent.updateConfig(config);
    }

    applyTheme();
    applyLanguage();
    applyChromeLayout();
    openSettings(); // Refresh settings modal inputs
    updateShortcutLabels();
    updateActionStatus();
    const saved = savePersistentConfig();

    // Same as Save: the OS-level hotkey follows the imported shortcut, and falls back if it is refused.
    const curSummon = (config.shortcuts && config.shortcuts.globalSummon) || DEFAULT_SHORTCUTS.globalSummon;
    if (curSummon !== prevSummon && window.backend && window.backend.updateGlobalShortcut) {
      Promise.resolve(window.backend.updateGlobalShortcut(curSummon)).then((ok) => {
        if (ok === false) {
          if (config.shortcuts) config.shortcuts.globalSummon = prevSummon;
          clearShortcutParseCache();
          renderShortcutsTable();
          updateShortcutLabels();
          savePersistentConfig().catch(() => {});
          showMessage(t('globalShortcutRegisterFailed'), 5000);
        }
      }).catch((err) => {
        console.warn('updateGlobalShortcut failed:', err);
      });
    }
    syncQuickCaptureShortcut(prevQuickCapture);
    return saved;
  }

  // Export / Import open the settings-package dialog (js/config_pack.js); the app only lends it the
  // pieces it needs.
  function packHost() {
    return {
      getConfig: () => config,
      getProjectHint: getNoteDir,
      applyConfig: applyImportedConfig,
      refreshAgents: checkActiveAgentsConfigStatus,
      t: t,
      showMessage: showMessage
    };
  }

  if (btnExportSettings) {
    btnExportSettings.onclick = () => {
      if (window.ConfigPack) window.ConfigPack.openExport(packHost());
    };
  }

  if (btnImportSettings) {
    btnImportSettings.onclick = () => {
      if (window.ConfigPack) window.ConfigPack.openImport(packHost());
    };
  }

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
        if (parsed.voice) Object.assign(config.voice, parsed.voice);
        if (parsed.cli) {
          if (!config.cli) config.cli = {};
          Object.assign(config.cli, parsed.cli);
        }
        if (parsed.image) {
          if (!config.image) config.image = {};
          Object.assign(config.image, parsed.image);
        }
        if (parsed.scraps) {
          if (!config.scraps) config.scraps = {};
          Object.assign(config.scraps, parsed.scraps);
        }
        if (parsed.discordBridge) {
          if (!config.discordBridge) config.discordBridge = {};
          Object.assign(config.discordBridge, parsed.discordBridge);
        }
        if (parsed.inbox) {
          if (!config.inbox) config.inbox = {};
          Object.assign(config.inbox, parsed.inbox);
        }
        if (parsed.action) {
          if (!config.action) config.action = {};
          Object.assign(config.action, parsed.action);
        }
        if (parsed.autoSelector && typeof parsed.autoSelector === 'object') config.autoSelector = Object.assign({}, config.autoSelector, parsed.autoSelector);
        if (parsed.general) Object.assign(config.general, parsed.general);
        if (parsed.general && parsed.general.imeGuardian !== undefined) hasPersistedImeGuardianSetting = true;
        if (parsed.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, parsed.shortcuts);
        migrateInsertLineShortcuts();
        migrateZenShortcut(false);
        migrateAskShortcuts(false);
        // No toast here: this runs synchronously before the UI has painted.
        // The authoritative backend load below (syncBackendConfig) re-runs this
        // migration and shows the toast if anything actually fell back.
        migrateMacShortcuts(false);
        migrateFullscreenShortcut();
      }
    } catch (e) {}
    applyTheme();
    applyLanguage();
    applyChromeLayout(); // synchronous, before the first paint: no flash of hidden icons
    updateShortcutLabels();
    updateActionStatus();
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
          if (fileConfig.voice) Object.assign(config.voice, fileConfig.voice);
          if (fileConfig.cli) {
            if (!config.cli) config.cli = {};
            Object.assign(config.cli, fileConfig.cli);
          }
          if (fileConfig.image) {
            if (!config.image) config.image = {};
            Object.assign(config.image, fileConfig.image);
          }
          if (fileConfig.scraps) {
            if (!config.scraps) config.scraps = {};
            Object.assign(config.scraps, fileConfig.scraps);
          }
          if (fileConfig.discordBridge) {
            if (!config.discordBridge) config.discordBridge = {};
            Object.assign(config.discordBridge, fileConfig.discordBridge);
          }
          if (fileConfig.inbox) {
            if (!config.inbox) config.inbox = {};
            Object.assign(config.inbox, fileConfig.inbox);
          }
          if (fileConfig.action) {
            if (!config.action) config.action = {};
            Object.assign(config.action, fileConfig.action);
          }
          if (fileConfig.autoSelector && typeof fileConfig.autoSelector === 'object') {
            config.autoSelector = Object.assign({}, config.autoSelector, fileConfig.autoSelector);
          }
          // Remember what the (already applied) local config produced so the
          // whole-DOM i18n / theme passes are not repeated for no reason.
          const prevTheme = (config.general && config.general.theme) || 'olive';
          const prevLang = (config.general && config.general.language) || 'en';

          if (fileConfig.general) Object.assign(config.general, fileConfig.general);
          if (fileConfig.general && fileConfig.general.imeGuardian !== undefined) hasPersistedImeGuardianSetting = true;
          if (fileConfig.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, config.shortcuts, fileConfig.shortcuts);
          migrateInsertLineShortcuts();
          migrateZenShortcut(true);
          migrateAskShortcuts(true);
          // Authoritative config load: this is the one place the migration is
          // allowed to toast the user, since the UI has already painted by now.
          migrateMacShortcuts(true);
          migrateFullscreenShortcut();
          // The backend-reported config is authoritative for whether this is a
          // genuinely new install; re-apply the IME Guardian capability default
          // now that we know for sure.
          applyImeGuardianCapabilityDefault();

          // Sync Slot & Agent configuration (v2.2.0)
          if (fileConfig.default_agent) config.default_agent = fileConfig.default_agent;
          if (fileConfig.timeout_seconds) config.timeout_seconds = fileConfig.timeout_seconds;
          if (fileConfig.hover_peek_enabled !== undefined) config.hover_peek_enabled = fileConfig.hover_peek_enabled;
          if (fileConfig.ghost_diff_duration_ms) config.ghost_diff_duration_ms = fileConfig.ghost_diff_duration_ms;
          if (fileConfig.agents) config.agents = fileConfig.agents;
          if (fileConfig.slot_profiles) config.slot_profiles = fileConfig.slot_profiles;
          if (fileConfig.recipes) config.recipes = fileConfig.recipes;

          if (window.SlotAgent && window.SlotAgent.updateConfig) {
            window.SlotAgent.updateConfig(fileConfig);
          }
          if (((config.general && config.general.theme) || 'olive') !== prevTheme) {
            applyTheme();
          }
          if (((config.general && config.general.language) || 'en') !== prevLang) {
            applyLanguage();
          }
          applyChromeLayout(); // a no-op unless the backend copy differs from what is applied
          updateShortcutLabels();
          updateActionStatus();
          renderVoiceRefineStatus();
          if (shortcutMigrationDirty) {
            shortcutMigrationDirty = false;
            savePersistentConfig();
          }
        }
      } catch (e) {
        console.warn('Failed to load persistent config from backend:', e);
      }
    }
  }

  // Fetches OS capabilities from the backend (window.backend.getPlatformCapabilities()
  // -> Promise<{os, nativeImeSwitch, tray, globalHotkey}>), if that bound helper
  // exists at all (older backend builds won't have it). Best-effort: absence or
  // rejection just keeps the conservative "everything supported" defaults above,
  // so behavior is unchanged on any platform/build that predates this.
  async function loadPlatformCapabilities() {
    if (!(window.backend && window.backend.getPlatformCapabilities)) return;
    try {
      const caps = await window.backend.getPlatformCapabilities();
      if (caps && typeof caps === 'object') {
        platformCapabilities = Object.assign({}, platformCapabilities, caps);
      }
    } catch (e) {
      console.warn('Failed to fetch platform capabilities:', e);
    }
    applyImeGuardianCapabilityDefault();
    applyTrayCapabilityUI();
  }

  // On an OS that can't switch the input source automatically (nativeImeSwitch
  // === false), the IME Guardian's romaji->kana text conversion has no OS-level
  // follow-up, which produces mixed kana/latin text. New configs (nothing
  // persisted yet) default the feature OFF there instead of ON; a user who
  // explicitly turns it on (or whose config already had an explicit value,
  // persisted or imported) keeps that choice. Only ever called from the
  // startup config-load paths — NOT from openSettings() — so it can never
  // clobber a checkbox the user just toggled on in an still-open dialog.
  function applyImeGuardianCapabilityDefault() {
    if (!hasPersistedImeGuardianSetting && platformCapabilities.nativeImeSwitch === false) {
      config.general.imeGuardian = false;
    }
    updateImeGuardianCapabilityHint();
  }

  // Just the persistent hint's visibility — safe to call anytime, including
  // every time the Settings dialog opens (unlike applyImeGuardianCapabilityDefault(),
  // this never touches config.general.imeGuardian itself).
  function updateImeGuardianCapabilityHint() {
    const hintEl = document.getElementById('ime-guardian-os-hint');
    if (hintEl) {
      hintEl.classList.toggle('hidden', platformCapabilities.nativeImeSwitch !== false);
    }
  }

  // "Keep resident in background/tray on close" only means anything where a
  // tray icon exists to be resident in. When the backend reports tray === false
  // the setting is disabled with an explanatory hint rather than relabeled to
  // Dock wording, because (as of this build) window_darwin.go doesn't wire this
  // option to anything on macOS at all — relabeling it would imply a working
  // "resident in Dock" behavior that doesn't exist yet.
  function applyTrayCapabilityUI() {
    const checkbox = document.getElementById('cfg-tray-resident');
    const hintEl = document.getElementById('tray-resident-os-hint');
    const unsupported = platformCapabilities.tray === false;
    if (checkbox) checkbox.disabled = unsupported;
    if (hintEl) hintEl.classList.toggle('hidden', !unsupported);
  }

  // Session Management (Unsaved documents & Tabs Persistence)
  let sessionSaveTimer = null;
  // Per-tab JSON fragment cache used by getSessionDataJson: when none of the fields
  // that go into a tab's session entry changed since the last save, its previous
  // JSON fragment is reused instead of being re-escaped by JSON.stringify. This
  // matters because `content` can be tens of MB for a huge note, and otherwise every
  // debounced save (triggered by typing in ANY tab) re-stringifies every open tab.
  const sessionTabFragmentCache = new WeakMap();

  function syncActiveEditorsIntoTabs() {
    const primaryTab = getTab(activeTabId);
    if (primaryTab && editorEl) {
      primaryTab.content = editorEl.value;
      primaryTab.cursorPos = editorEl.selectionStart;
    }
    if (isSplitMode && secondaryTabId && secondaryViewMode === 'editor' && editorSecondary) {
      const secTab = getTab(secondaryTabId);
      if (secTab) {
        secTab.content = editorSecondary.value;
        secTab.cursorPos = editorSecondary.selectionStart;
      }
    }
  }

  function getSessionData() {
    syncActiveEditorsIntoTabs();
    return {
      activeTabId: activeTabId,
      tabCounter: tabCounter,
      isSplitMode: !!isSplitMode,
      secondaryTabId: secondaryTabId || null,
      secondaryViewMode: secondaryViewMode || 'editor',
      activePane: activePane || 'primary',
      isPreviewMode: !!isPreviewMode,
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

  // JSON fragment for one tab's session entry (same shape/key order as the object
  // literal in getSessionData's tabs.map above), reusing the previous serialization
  // when id/title/path/content/isDirty/encoding/cursorPos are all unchanged. An
  // unchanged `content` compares equal by reference in O(1); a changed-but-equal
  // string still costs an O(n) comparison here, but that is cheaper than the
  // O(n) escaping scan JSON.stringify would do anyway, so this is never a loss.
  function sessionTabFragment(t) {
    const cached = sessionTabFragmentCache.get(t);
    if (
      cached &&
      cached.id === t.id &&
      cached.title === t.title &&
      cached.path === t.path &&
      cached.content === t.content &&
      cached.isDirty === t.isDirty &&
      cached.encoding === t.encoding &&
      cached.cursorPos === t.cursorPos
    ) {
      return cached.json;
    }
    const json = JSON.stringify({
      id: t.id,
      title: t.title,
      path: t.path,
      content: t.content,
      isDirty: t.isDirty,
      encoding: t.encoding,
      cursorPos: t.cursorPos
    });
    sessionTabFragmentCache.set(t, {
      id: t.id,
      title: t.title,
      path: t.path,
      content: t.content,
      isDirty: t.isDirty,
      encoding: t.encoding,
      cursorPos: t.cursorPos,
      json: json
    });
    return json;
  }

  // Byte-identical to JSON.stringify(getSessionData()), built by splicing per-tab
  // fragments (see sessionTabFragment) into the small "head" object's JSON instead
  // of re-stringifying every open tab's full content on every save.
  function getSessionDataJson() {
    syncActiveEditorsIntoTabs();
    const head = JSON.stringify({
      activeTabId: activeTabId,
      tabCounter: tabCounter,
      isSplitMode: !!isSplitMode,
      secondaryTabId: secondaryTabId || null,
      secondaryViewMode: secondaryViewMode || 'editor',
      activePane: activePane || 'primary',
      isPreviewMode: !!isPreviewMode
    });
    const tabsJson = '[' + tabs.map(sessionTabFragment).join(',') + ']';
    if (head === '{}') return '{"tabs":' + tabsJson + '}';
    return head.slice(0, -1) + ',"tabs":' + tabsJson + '}';
  }

  function saveSessionDebounced() {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => {
      savePersistentSession();
    }, 500);
  }

  async function savePersistentSession() {
    if (config.general.restoreSession === false) return;
    const jsonStr = getSessionDataJson();

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

      // Restore layout & split mode state
      if (sessionData.isSplitMode) {
        const secTabId = (sessionData.secondaryTabId && tabs.some(t => t.id === sessionData.secondaryTabId))
          ? sessionData.secondaryTabId
          : (tabs.find(t => t.id !== targetTabId)?.id || targetTabId);

        if (sessionData.secondaryViewMode === 'preview') {
          openPreviewToSide(secTabId);
        } else {
          openSplitEditor(secTabId);
        }
        if (sessionData.activePane === 'secondary') {
          activePane = 'secondary';
          updatePaneFocusClasses();
        }
      } else {
        if (isSplitMode) {
          closeSecondaryPane();
        }
        if (sessionData.isPreviewMode && !isPreviewMode) {
          togglePreview();
        }
      }
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
      const jsonStr = getSessionDataJson();
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
  // Which editor pane (if any) a window-level drag event is currently over: e.target is the
  // element directly under the pointer, and for a drag inside the editor that is the textarea
  // itself (a drag anywhere else - the tab bar, the header - falls through to the old
  // "open as a new tab" behavior).
  function editorUnderPointer(e) {
    if (e.target === editorEl) return editorEl;
    if (editorSecondary && e.target === editorSecondary) return editorSecondary;
    return null;
  }

  window.addEventListener('dragover', (e) => {
    const editor = editorUnderPointer(e);
    if (editor && window.FileAnchor && window.FileAnchor.handleDragOver(e, editor)) {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('dragleave', (e) => {
    if (window.FileAnchor) window.FileAnchor.handleDragLeave(e);
  });
  window.addEventListener('dragend', (e) => {
    if (window.FileAnchor) window.FileAnchor.handleDragLeave(e);
  });

  window.addEventListener('drop', async (e) => {
    const editor = editorUnderPointer(e);
    // preventDefault() must run synchronously, before any await below - otherwise the
    // browser's own "navigate to the dropped file" default can win the race.
    e.preventDefault();
    e.stopPropagation();

    if (editor && window.FileAnchor) {
      const handled = await window.FileAnchor.handleDrop(e, editor);
      if (handled) return;
    }

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
    // Cheap listener registration only (hover-preview mousemove, scroll, keydown); no
    // per-file work happens until an actual drag/click/hover occurs.
    if (window.FileAnchor) window.FileAnchor.init();

    // 2. Background Asynchronous Verification & Sync:
    loadPlatformCapabilities();
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

      // Restore saved workspace folder if any (defer non-critical scan slightly to guarantee instantaneous first paint)
      const savedFolder = localStorage.getItem('md_memo_workspace_folder');
      if (savedFolder) {
        setTimeout(() => {
          loadWorkspaceFolder(savedFolder);
        }, 300);
      }

      // Background asynchronous sync of configuration
      await syncBackendConfig();

      // Only force split mode if session restore is disabled AND explicitly configured
      if (config.general && config.general.restoreSession === false && config.general.splitViewOnStartup && !isSplitMode) {
        await toggleSplitMode();
      }

      // Check for app updates asynchronously in background (deferred 2.5s to keep startup 0ms smooth)
      setTimeout(() => {
        checkForAppUpdates();
      }, 2500);
    })();

    initPaneResizer();
  }

  // Asynchronous background update checker (Zero impact on startup)
  function isNewerVersion(latest, current) {
    const p1 = latest.split('.').map(n => parseInt(n, 10) || 0);
    const p2 = current.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const v1 = p1[i] || 0;
      const v2 = p2[i] || 0;
      if (v1 > v2) return true;
      if (v1 < v2) return false;
    }
    return false;
  }

  async function checkForAppUpdates() {
    if (!helpUpdateBadge || !btnHelp) return;
    try {
      const resp = await fetch('https://api.github.com/repos/youshinh/md-memo/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-cache'
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const latestTag = (data.tag_name || '').replace(/^v/, '').trim();
      if (!latestTag) return;

      let currentVersion = '1.7.2';
      if (window.backend && typeof window.backend.getAppVersion === 'function') {
        try {
          const v = await window.backend.getAppVersion();
          if (v) currentVersion = String(v).replace(/^v/, '').trim();
        } catch (_) {}
      }

      let dismissedVersion = '';
      try {
        dismissedVersion = localStorage.getItem('mdmemo_dismissed_update_version') || '';
      } catch (_) {}

      if (isNewerVersion(latestTag, currentVersion) && dismissedVersion !== latestTag) {
        helpUpdateBadge.classList.remove('hidden');
        const tooltip = `${t('helpUpdateAvailable') || 'Update available'}: v${latestTag}`;
        btnHelp.title = tooltip;
        helpUpdateBadge.title = tooltip;
      } else {
        helpUpdateBadge.classList.add('hidden');
      }
    } catch (e) {
      // Silently ignore network / rate-limit failures
    }
  }

  // Expose programmatic RPC interface for CLI, Unix pipe, and Agent operations
  window.__mdMemoRPC = {
    getBuffer: function (tabId) {
      const targetTab = tabId ? getTab(tabId) : (getTab(activeTabId) || tabs[0]);
      if (!targetTab) return null;
      let content = targetTab.content || '';
      if (targetTab.id === activeTabId && editorEl) {
        content = editorEl.value;
      }
      const lines = content.split('\n');
      return {
        tabId: targetTab.id,
        title: targetTab.title || 'Untitled',
        path: targetTab.path || '',
        content: content,
        length: content.length,
        lineCount: lines.length,
        isActive: targetTab.id === activeTabId,
        isModified: !!targetTab.isDirty
      };
    },

    setBuffer: function (text, tabId) {
      if (tabId && tabId !== activeTabId) {
        selectTab(tabId);
      }
      if (!editorEl) return false;
      editorEl.focus();
      editorEl.select();
      let success = false;
      try {
        success = execInsertTextExact(editorEl, text);
      } catch (e) {
        success = false;
      }
      if (!success || editorEl.value !== text) {
        editorEl.value = text;
      }
      editorEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof updateLineNumbers === 'function') updateLineNumbers();
      if (typeof saveSessionDebounced === 'function') saveSessionDebounced();
      return true;
    },

    appendBuffer: function (text, tabId) {
      if (tabId && tabId !== activeTabId) {
        selectTab(tabId);
      }
      if (!editorEl) return false;
      editorEl.focus();
      const len = editorEl.value.length;
      editorEl.setSelectionRange(len, len);
      let success = false;
      try {
        success = execInsertTextExact(editorEl, text);
      } catch (e) {
        success = false;
      }
      if (!success) {
        editorEl.value += text;
      }
      editorEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof updateLineNumbers === 'function') updateLineNumbers();
      if (typeof saveSessionDebounced === 'function') saveSessionDebounced();
      return true;
    },

    replaceRange: function (startLine, startCol, endLine, endCol, text, tabId) {
      if (tabId && tabId !== activeTabId) {
        selectTab(tabId);
      }
      if (!editorEl) return false;
      const content = editorEl.value;
      const lines = content.split('\n');

      // Convert 1-indexed (line, col) to character index
      let startOffset = 0;
      for (let i = 0; i < Math.min(startLine - 1, lines.length); i++) {
        startOffset += lines[i].length + 1; // +1 for newline
      }
      startOffset += Math.max(0, startCol - 1);

      let endOffset = 0;
      for (let i = 0; i < Math.min(endLine - 1, lines.length); i++) {
        endOffset += lines[i].length + 1;
      }
      endOffset += Math.max(0, endCol - 1);

      startOffset = Math.max(0, Math.min(startOffset, content.length));
      endOffset = Math.max(startOffset, Math.min(endOffset, content.length));

      editorEl.focus();
      editorEl.setSelectionRange(startOffset, endOffset);
      let success = false;
      try {
        success = execInsertTextExact(editorEl, text);
      } catch (e) {
        success = false;
      }
      if (!success) {
        editorEl.value = content.substring(0, startOffset) + text + content.substring(endOffset);
      }
      editorEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof updateLineNumbers === 'function') updateLineNumbers();
      if (typeof saveSessionDebounced === 'function') saveSessionDebounced();
      return true;
    },

    getTabs: function () {
      return tabs.map(t => ({
        id: t.id,
        title: t.title || 'Untitled',
        path: t.path || '',
        isActive: t.id === activeTabId,
        isModified: !!t.isDirty
      }));
    },

    switchTab: function (tabId) {
      selectTab(tabId);
      return true;
    },

    // Folder the active note lives in ('' when unknown). Mobile Drop asks for it (over RPC) to
    // save a photo or voice note it could not OCR / transcribe next to the note.
    getNoteDir: function () {
      return getNoteDir();
    },

    newTab: function (title, content, path) {
      createTab(title, content, path);
      return true;
    },

    closeTab: function (tabId) {
      closeTab(tabId || activeTabId);
      return true;
    },

    toggleSplit: async function () {
      if (typeof toggleSplitMode === 'function') {
        await toggleSplitMode();
        return true;
      }
      return false;
    },

    // Selection CLI interface (机能 2): `md-memo buffer get --selection` / `replace-selection`.
    getSelection: function (tabId) {
      let editor = getActiveEditor();
      let resolvedTabId = getTabIdForEditor(editor);
      if (tabId && tabId !== resolvedTabId) {
        if (tabId === activeTabId) {
          editor = editorEl;
          resolvedTabId = activeTabId;
        } else if (isSplitMode && tabId === secondaryTabId && secondaryViewMode === 'editor' && editorSecondary) {
          editor = editorSecondary;
          resolvedTabId = secondaryTabId;
        } else {
          selectTab(tabId);
          editor = editorEl;
          resolvedTabId = activeTabId;
        }
      }
      if (!editor) return { tabId: resolvedTabId || '', text: '', start: 0, end: 0, hasSelection: false };
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      return {
        tabId: resolvedTabId || '',
        text: editor.value.substring(start, end),
        start: start,
        end: end,
        hasSelection: end > start
      };
    },

    replaceSelection: function (text, tabId, expectedStart, expectedEnd) {
      let editor = getActiveEditor();
      let resolvedTabId = getTabIdForEditor(editor);
      if (tabId && tabId !== resolvedTabId) {
        if (tabId === activeTabId) {
          editor = editorEl;
        } else if (isSplitMode && tabId === secondaryTabId && secondaryViewMode === 'editor' && editorSecondary) {
          editor = editorSecondary;
        } else {
          selectTab(tabId);
          editor = editorEl;
        }
        resolvedTabId = tabId;
      }
      if (!editor) return { replaced: false, start: 0, end: 0, reason: 'no active editor' };

      // Re-check the live selection against the caller's expected bounds so a caret move
      // between the RPC's read and this write cannot silently clobber the wrong text. Both
      // negative (buffer.replace_selection never sends them) skips the check.
      if (expectedStart >= 0 && expectedEnd >= 0 &&
        (editor.selectionStart !== expectedStart || editor.selectionEnd !== expectedEnd)) {
        return { replaced: false, start: editor.selectionStart, end: editor.selectionEnd, reason: 'selection changed before replace could be applied' };
      }

      editor.focus();
      let success = false;
      try {
        success = execInsertTextExact(editor, text);
      } catch (e) {
        success = false;
      }
      if (!success) {
        const start = editor.selectionStart;
        const val = editor.value;
        editor.value = val.substring(0, start) + text + val.substring(editor.selectionEnd);
        editor.selectionStart = start;
        editor.selectionEnd = start + text.length;
      }
      const newEnd = editor.selectionEnd;
      const newStart = newEnd - text.length;
      editor.setSelectionRange(newStart, newEnd);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof updateLineNumbers === 'function') updateLineNumbers();
      if (typeof saveSessionDebounced === 'function') saveSessionDebounced();
      return { replaced: true, start: newStart, end: newEnd, reason: '' };
    }
  };

  // Directory component of a note path, tolerating both '/' (POSIX) and '\' (Windows)
  // separators regardless of the platform this instance is running on.
  function dirOfPath(p) {
    if (!p) return '';
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx === -1 ? '' : p.slice(0, idx);
  }

  function getTabIdForEditor(editor) {
    if (editor === editorSecondary) return secondaryTabId;
    return activeTabId;
  }

  // Directory a paste/drop-created asset (or a rescued voice recording) should be written
  // relative to: the active note's own folder when it has one, else the open workspace
  // folder, else '' (SaveAsset/ImportAssetFile then fall back to the app data dir).
  async function getNoteDir() {
    const tab = getActiveTab();
    if (tab && tab.path) {
      const dir = dirOfPath(tab.path);
      if (dir) return dir;
    }
    return workspaceRootPath || '';
  }

  // Bridge new frontend modules (voice_input.js, file_anchor.js) use instead of reaching into
  // app.js internals directly. See rev3_contract.md for the exact shape.
  window.MdMemoBridge = {
    getActiveEditor: getActiveEditor,
    getActiveTab: getActiveTab,
    getTabIdForEditor: getTabIdForEditor,
    insertTextWithUndo: insertTextWithUndo,
    replaceAnchor: applyAnchorReplacement,
    notifyEdited: function (editor) {
      const tab = getActiveTab();
      if (editor && tab) onEditorInput(editor, tab, true);
    },
    t: t,
    showMessage: showMessage,
    getConfig: function () { return config; },
    getNoteDir: getNoteDir,
    // False while the rendered preview covers the editor (its textarea is then hidden).
    isEditorVisible: function () { return !isPreviewMode; },
    // Ask bar (Ctrl+L). opts: { tabId?, target?: { text, start, end }, recordInstruction?, onSubmit?(instruction, ctx) }.
    // Without onSubmit it is the quick ask (answer below the target); with it the bar only collects the instruction.
    openAskBar: openInlinePromptBar,
    // LLM requests that leave an anchor in the note: see startLlmTask above for the options.
    startLlmTask: startLlmTask,
    cancelLlmTask: cancelLlmTask,
    // False (with a toast when asked) if the built-in LLM cannot answer: no model / URL, or a hosted service without a key.
    isLlmConfigured: isLlmConfigured,
    getAutoSelectorConfig: getAutoSelectorConfig,
    // Command tasks ([[ $ command ]]): confirmCommand is the command bar's safety gate (Promise<boolean>, toasts the reason
    // itself, never touches the note); runCommandTask / cancelCommandTask: see runCommandTask above.
    confirmCommand: confirmCommand,
    runCommandTask: runCommandTask,
    cancelCommandTask: cancelCommandTask,
    // The live text of a note wherever it is shown, or null when the tab is gone.
    getTabText: getTabText
  };

  // Expose test and screenshot automation helpers safely
  window.__testHelper = {
    toggleSplitMode,
    openSplitEditor,
    openPreviewToSide,
    closeSecondaryPane,
    openQuickPick,
    openInlinePromptBar,
    convertSelectionToMermaid,
    generateImageFromMermaid,
    triggerAICorrection,
    createTab,
    getActiveEditor,
    applyLanguage,
    updateGitSyncStatusUI,
    config
  };

  initApp();
})();
