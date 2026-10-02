// MD-Notepad Core Application Logic (High Performance, Autocomplete & Clean Minimalist UI)
(function () {
  'use strict';

  // State
  let tabs = [];
  let activeTabId = null;
  let tabCounter = 1;
  let isPreviewMode = false;
  // Autosave timers, one per tab (tab id -> timer; see armAutoSave): typing in another tab or in the other pane must never cancel a
  // pending save of this one. Created on the first edit of a note that has a file, so it costs nothing before that.
  let rpcAutoSaveTimers = null;
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
      refine: { enabled: true, model: 'gemini-flash-lite-latest', timeoutSec: 5 },
      // Windows: also record the sound this PC plays (Zoom's other participants), mixed with the microphone
      includeSystemAudio: false
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
      checkUpdates: true, // ask GitHub for the latest release ~2.5 s after start-up; false = no request at start-up (About > Check now still works)
      cloudConsent: {}, // cloud hosts the ask / rewrite bars may send text to: { "host": "date allowed" }; kept on this PC, never exported
      imeGuardian: (typeof navigator !== 'undefined' && navigator.language && navigator.language.startsWith('ja')),
      imeGuardianRetype: true,
      imeGuardianReverse: true,
      aiCorrection: true,
      cursorAura: true,
      welcomeShown: false, // the Welcome note was shown (first_run.js): written on the very first start only; false / absent = not yet
      aiChoiceMade: false, // the ask bar's one-time model choice was answered (first_run.js); false / absent = not yet
      commentStyle: 'line', // Ctrl+/ writes one <!-- --> per line ('line') or one around the lines ('block'): comment_toggle.js
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
  // A new profile starts with the calm header (ChromeLayout.calmToolbarLayout: seven icons, the rest reachable from the command
  // palette and the Settings list). "New" means nothing saved anywhere and no sign that this WebView was used before: an existing
  // config keeps the layout it has (an empty one means "show everything"), and so does someone who never saved a setting but has
  // a session or a workspace folder here, so nobody's toolbar changes on an upgrade. A new profile leaves one mark of its own
  // (CALM_TOOLBAR_MARK), so its second start, before it has saved anything, is calm too without waiting for config.json.
  // hasSavedConfig is set once localStorage or config.json is found.
  const CALM_TOOLBAR_MARK = 'md_memo_calm_toolbar_v1';
  let hasSavedConfig = false;
  let calmToolbarApplied = false;
  let tabOverflow; // undefined until getTabOverflow() first builds it
  function applyCalmToolbarForNewProfile() {
    if (hasSavedConfig || !window.ChromeLayout || !window.ChromeLayout.calmToolbarLayout) return;
    try {
      const marked = !!localStorage.getItem(CALM_TOOLBAR_MARK);
      const used = !!(localStorage.getItem('md_memo_session_v1') || localStorage.getItem('md_notepad_session_v1') || localStorage.getItem('md_memo_workspace_folder'));
      if (used && !marked) return;
      if (!marked) localStorage.setItem(CALM_TOOLBAR_MARK, '1');
    } catch (e) {
      return; // no storage to tell a new profile from an old one: keep the toolbar as it always was
    }
    if (!config.general) config.general = {};
    config.general.toolbarLayout = window.ChromeLayout.calmToolbarLayout();
    calmToolbarApplied = true;
  }

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
    // The preview only, in the right-hand pane (it used to be a fixed key, absent from Settings > Shortcuts).
    previewToSide: 'Ctrl+Alt+V',
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
    rewriteSelection: 'Ctrl+K',
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
    // Result blocks (result_blocks.js). No default keys: Alt+Shift+Up/Down, the natural pair, are the duplicate-line keys.
    resultNext: '',
    resultPrev: '',
    resultCopy: '',
    resultDelete: '',
    resultConfirm: '',
    commentToggle: 'Ctrl+/',
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
    previewToSide: 'Cmd+Option+V',
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
    rewriteSelection: 'Cmd+K',
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
    resultNext: '',
    resultPrev: '',
    resultCopy: '',
    resultDelete: '',
    resultConfirm: '',
    commentToggle: 'Cmd+/',
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
        // A function: a value (an error text from a command, a model's answer) may hold "$&" or "$'", which a string would expand
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), () => v);
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
  //   'insertFiles' - files copied in a file manager (hasFiles, and no text, HTML or picture beside them): handled like a drop of the
  //                 same files on the note (a link, the file copied beside the note). The paste did nothing at all before.
  //   'default'   - let the browser perform its normal paste unmodified (plain text)
  function decidePasteAction(opts) {
    const o = opts || {};
    const types = o.types || [];
    const hasHtml = types.indexOf('text/html') !== -1;
    const hasPlain = types.indexOf('text/plain') !== -1;
    const pictureOnly = !!o.hasImage && !hasPlain;
    if (o.hasFiles && !hasPlain && !hasHtml && !o.hasImage) return 'insertFiles';
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
    renderImeStatus();
    updateActionStatus(); // also redraws the AI item (its label and popover, in the new language)
    if (btnTogglePreview) btnTogglePreview.title = isPreviewMode ? t('edit') : t('togglePreviewTitle');
    if (btnToggleSplit) btnToggleSplit.title = t('splitViewTitle');
    renderProviderDetectLine(); // Settings > AI Models "Protocol: ...", written once when the dialog opened
    if (typeof updateGitSyncStatusUI === 'function') updateGitSyncStatusUI();
    updateShortcutLabels();
    // The editor's row labels are translated text: redraw them if it is open.
    if (layoutSectionOpen()) renderLayoutEditors();
    // Icon-only buttons are named by their (translated) title: name them again.
    if (window.A11y) window.A11y.refresh();
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
  const statAutosave = document.getElementById('stat-autosave');
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
  const helpMenu = document.getElementById('help-menu');
  const helpMenuUpdate = document.getElementById('help-menu-update');
  const helpMenuUpdateText = document.getElementById('help-menu-update-text');
  const btnHelpMenuNotes = document.getElementById('help-menu-notes');
  const btnHelpMenuManual = document.getElementById('help-menu-manual');
  const btnHelpMenuAbout = document.getElementById('help-menu-about');

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
    // The label and the lead of the tooltip are in the UI language; the engine's own message (English detail such as
    // "Synced at 12:00:01" or the reason of a failure) follows in brackets.
    const detail = info && info.message ? ' (' + info.message + ')' : '';
    if (!info || info.status === 'ready') {
      statGitSync.textContent = t('gitStatusReady');
      statGitSync.title = t('gitSyncReadyTooltip');
      statGitSync.style.color = '';
    } else if (info.status === 'syncing') {
      statGitSync.textContent = t('gitStatusSyncing');
      statGitSync.title = t('gitSyncSyncingTooltip') + detail;
      statGitSync.style.color = 'var(--status-warn, #e2c08d)';
    } else if (info.status === 'synced') {
      statGitSync.textContent = t('gitStatusSynced');
      statGitSync.title = t('gitSyncSyncedTooltip') + detail;
      statGitSync.style.color = 'var(--status-ok, #73c991)';
    } else if (info.status === 'error') {
      statGitSync.textContent = t('gitStatusError');
      statGitSync.title = t('gitSyncErrorTooltip') + detail;
      statGitSync.style.color = 'var(--status-error, #f48771)';
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

  // Ask Bar Elements (Ctrl+L; the same bar doubles as the Ctrl+K rewrite bar, see openInlinePromptBar)
  const inlinePromptBar = document.getElementById('inline-prompt-bar');
  const inlinePromptBadge = document.getElementById('inline-prompt-badge');
  const inlinePromptInput = document.getElementById('inline-prompt-input');
  const inlinePromptTarget = document.getElementById('inline-prompt-target');
  const inlinePromptHint = document.getElementById('inline-prompt-hint');
  const btnInlinePromptSend = document.getElementById('btn-inline-prompt-send');
  const inlinePromptSetup = document.getElementById('inline-prompt-setup');
  const btnInlinePromptSetup = document.getElementById('btn-inline-prompt-setup');
  const inlinePromptChoice = document.getElementById('inline-prompt-choice');
  const inlinePromptError = document.getElementById('inline-prompt-error');
  const inlinePromptErrorText = document.getElementById('inline-prompt-error-text');
  const inlinePromptErrorDetail = document.getElementById('inline-prompt-error-detail');
  const inlinePromptErrorDetails = document.getElementById('inline-prompt-error-details');
  const btnInlinePromptRetry = document.getElementById('btn-inline-prompt-retry');
  const btnInlinePromptErrorSettings = document.getElementById('btn-inline-prompt-error-settings');
  const btnInlinePromptClose = document.getElementById('btn-inline-prompt-close');
  const inlinePromptDest = document.getElementById('inline-prompt-dest');
  const inlinePromptDestText = document.getElementById('inline-prompt-dest-text');
  const inlinePromptConsent = document.getElementById('inline-prompt-consent');
  const inlinePromptConsentText = document.getElementById('inline-prompt-consent-text');
  const btnInlinePromptConsentAllow = document.getElementById('btn-inline-prompt-consent-allow');
  const btnInlinePromptConsentCancel = document.getElementById('btn-inline-prompt-consent-cancel');
  const btnForgetCloudConsent = document.getElementById('btn-forget-cloud-consent');

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

  // The Save / Don't Save / Cancel dialog and customConfirm show the same modal, so only one of them can own it at a time.
  // confirmModalRelease closes the owner (as Cancel). A second request while the modal is up (a repeated Ctrl+W, key repeat, a
  // second close request) is refused instead of stacking another key listener and taking the buttons over: the first dialog would
  // be orphaned, its window listener would stay, and it would answer a later plain d / n / s / Enter, discarding a tab.
  let confirmModalRelease = null;
  // A plain d / n / s / Enter does not answer the Save dialog in its first moments: when something other than the person's own
  // keystroke opened it (an agent's tab.close while they type), the keys they were already typing would answer it unseen.
  // Clicks and Esc work at once.
  const CONFIRM_KEY_GRACE_MS = 400;

  function confirmModalTaken() {
    if (!confirmModalRelease) return false;
    if (confirmModal && !confirmModal.classList.contains('hidden')) return true;
    confirmModalRelease(); // the modal was hidden behind its owner's back: let go of the owner's key listener
    return false;
  }

  // Notepad-standard 3-option dialog: Save / Don't Save / Cancel
  function confirmSaveDialog(title) {
    // Already asking: one dialog, one outcome. The extra request is answered Cancel (it does nothing); the question on screen decides.
    if (confirmModalTaken()) return Promise.resolve('cancel');
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
      const openedAt = Date.now();

      let settled = false;
      const cleanup = (action) => {
        if (settled) return;
        settled = true;
        confirmModal.classList.add('hidden');
        if (confirmModalSave) confirmModalSave.onclick = null;
        if (confirmModalDontSave) confirmModalDontSave.onclick = null;
        if (confirmModalCancel) confirmModalCancel.onclick = null;
        if (confirmModalClose) confirmModalClose.onclick = null;
        window.removeEventListener('keydown', onKeyDown, true);
        if (confirmModalRelease === release) confirmModalRelease = null;
        resolve(action);
      };
      const release = () => cleanup('cancel');
      confirmModalRelease = release;

      const onKeyDown = (e) => {
        if (e.isComposing || e.keyCode === 229) return; // an IME is converting text: not an answer
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('cancel');
          return;
        }
        // Ctrl / Alt / Cmd combinations (Ctrl+D, Alt+S, Ctrl+W, Cmd+N ...) are ordinary shortcuts, never an answer.
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        const isEnter = e.key === 'Enter';
        const isDontSave = e.key === 'd' || e.key === 'D' || e.key === 'n' || e.key === 'N';
        const isSave = e.key === 's' || e.key === 'S';
        if (!isEnter && !isDontSave && !isSave) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return; // a held key is not an answer
        if (Date.now() - openedAt < CONFIRM_KEY_GRACE_MS) return; // typed before the dialog could be read: swallowed, not an answer
        if (isEnter) {
          // Enter presses the button that has the focus (Save when the focus is somewhere else).
          const focused = document.activeElement;
          if (focused && focused === confirmModalDontSave) cleanup('dontsave');
          else if (focused && (focused === confirmModalCancel || focused === confirmModalClose)) cleanup('cancel');
          else cleanup('save');
        } else {
          cleanup(isDontSave ? 'dontsave' : 'save');
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

  // opts (all optional): okLabel (the OK button's text), multiline (keep the message's line breaks), safeDefault (focus
  // Cancel; Enter presses the focused button and Ctrl/Cmd+Enter does nothing, so a repeated shortcut cannot confirm).
  function customConfirm(message, opts) {
    const o = opts || {};
    // The modal is already asking something (see confirmModalRelease): this request is declined, never stacked on top of it.
    if (confirmModalTaken()) return Promise.resolve(false);
    return new Promise((resolve) => {
      if (!confirmModal || !confirmModalMessage) {
        resolve(true);
        return;
      }
      confirmModalMessage.textContent = message;
      confirmModalMessage.style.whiteSpace = o.multiline ? 'pre-line' : '';
      if (confirmModalSave) confirmModalSave.style.display = 'none';
      if (confirmModalDontSave) confirmModalDontSave.style.display = 'none';
      if (confirmModalOk) {
        confirmModalOk.textContent = o.okLabel || t('btnOk');
        confirmModalOk.classList.remove('hidden');
        confirmModalOk.style.display = '';
      }
      if (confirmModalCancel) {
        confirmModalCancel.textContent = t('btnCancel');
        confirmModalCancel.style.display = '';
      }
      confirmModal.classList.remove('hidden');

      let settled = false;
      const cleanup = (result) => {
        if (settled) return;
        settled = true;
        confirmModal.classList.add('hidden');
        if (confirmModalOk) confirmModalOk.onclick = null;
        if (confirmModalCancel) confirmModalCancel.onclick = null;
        if (confirmModalClose) confirmModalClose.onclick = null;
        window.removeEventListener('keydown', onKeyDown, true);
        if (confirmModalRelease === release) confirmModalRelease = null;
        resolve(result);
      };
      const release = () => cleanup(false);
      confirmModalRelease = release;

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (!o.safeDefault) cleanup(true);
          else if (!e.ctrlKey && !e.metaKey && !e.repeat) cleanup(document.activeElement === confirmModalOk);
        }
      };

      if (confirmModalOk) confirmModalOk.onclick = () => cleanup(true);
      if (confirmModalCancel) confirmModalCancel.onclick = () => cleanup(false);
      if (confirmModalClose) confirmModalClose.onclick = () => cleanup(false);
      window.addEventListener('keydown', onKeyDown, true);

      setTimeout(() => {
        const first = o.safeDefault ? confirmModalCancel : confirmModalOk;
        if (first) first.focus();
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
  // A long many-line text does not go through the 'insertText' command: Chromium applies it line by line, each line costing a pass
  // over the whole note and an input event of its own (2,000 lines froze the window for ~6 s, 4,000 for ~20 s). bulk_insert.js
  // inserts it as one editing step (still one Ctrl+Z) with a single input event.
  function execInsertTextExact(editor, text) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const before = editor.value;
    const next = before.charAt(end);
    const guard = next === ' ' && /\s/.test(text);
    if (guard) editor.setSelectionRange(start, end + 1);
    const payload = guard ? text + next : text;
    const bulk = !!(window.BulkInsert && window.BulkInsert.wanted(payload, before));
    if (!(bulk ? window.BulkInsert.exec(editor, payload) : document.execCommand('insertText', false, payload))) {
      if (guard) editor.setSelectionRange(start, end);
      return false;
    }
    const expected = before.substring(0, start) + text + before.substring(end);
    if (editor.value !== expected) editor.value = expected;
    const caret = start + text.length;
    editor.setSelectionRange(caret, caret);
    return true;
  }

  // True when the editor has the focus after focus() was asked of it: only then does the insertText command go into it. An editor that
  // cannot be focused (the full preview covers it) leaves the focus where it was - in the ask bar's input, say - and the text would
  // go there, with the fix-up in execInsertTextExact then setting the note's text behind its back (and the undo history with it).
  // The caller puts the text in itself then.
  function takesInsertCommand(editor) {
    return document.activeElement === editor;
  }

  // Undo/Redo Friendly Text Insertion & Range Replacement
  function insertTextWithUndo(text, targetEditor) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return;
    editor.focus();
    let success = false;
    try {
      success = takesInsertCommand(editor) && execInsertTextExact(editor, text);
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

  // Replaces [from, to) of the editor's text with `text` as ONE undo step and leaves the caret after it. Every edit of a range
  // must go through here (or insertTextWithUndo): a programmatic `editor.value = ...` throws the textarea's whole undo history
  // away, so Ctrl+Z would then do nothing at all, not even for what was typed before. Focuses the editor (execCommand needs that).
  function replaceRangeWithUndo(editor, from, to, text) {
    editor.setSelectionRange(from, to);
    insertTextWithUndo(text, editor);
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

  // The same "a few seconds of amber glow" cue slot_agent.js uses for {{ }} / {{ @agent }}
  // task results (ghost_diff.js: a band over just the rows that changed), reused here so every
  // place AI-generated text lands via an anchor — Ctrl+L, [[ @llm ]] Auto Selector tasks (both
  // go through startLlmTask below), Ctrl+K rewrite, Alt+C correction, voice, OCR, Mermaid, ...
  // — gets the same visual confirmation, not just slot/agent tasks. See replaceAnchorWithUndo.
  // [start, end) is the text that landed, as the textarea now holds it. Harmless wherever
  // there is no layout (tests, a tab that never made it onto a real pane): then there is no cue.
  function flashGhostDiff(editor, start, end) {
    if (!editor || !window.GhostDiff) return;
    // Nothing was added (a cancelled or failed request put the note back): there is no changed row to mark.
    if (!(end > start)) return;
    window.GhostDiff.flash(editor, start, end, { durationMs: config.ghost_diff_duration_ms || 4000 });
  }
  // Sibling modules that put text into the note themselves (Quick Actions) mark it the same way.
  window.flashGhostDiff = flashGhostDiff;

  // What really goes in when the waiting text \`anchor\` (found at \`at\` in \`text\`) is taken out for \`replacement\`. An ask under a line waits
  // with its own line breaks in front ("\n\n[AI Generating: x...]\n"). Taking it out for nothing (a failure, a cancel) also takes the
  // break that kept whatever follows on its own line: another request's waiting text, or a line typed on the empty line the ask
  // opened, would be glued to the line above it, and the answer that comes later would be appended to that line. One break stays then.
  function anchorGap(text, at, anchor, replacement) {
    if (replacement !== '' || anchor.charAt(0) !== '\n') return replacement;
    const before = at > 0 ? text.charAt(at - 1) : '';
    const after = text.charAt(at + anchor.length);
    if (before === '' || before === '\n' || after === '' || after === '\n') return replacement;
    return '\n';
  }

  // What goes on the end of the note for a result whose waiting text is gone (deleted, or taken out by Ctrl+Z): on lines of its own, a
  // blank line after what is there. The line breaks already there count: the note's own last ones, and those a result brings with it
  // (an ask's answer opens with a blank line and closes with a break; a task's result block too). They used to be added on top of
  // each other, and the result landed after three or four blank lines.
  function endOfNoteInsertion(text, replacement) {
    const own = (/^\n*/.exec(replacement) || [''])[0].length; // breaks the result opens with
    const have = text === '' ? 2 : (/\n*$/.exec(text) || [''])[0].length; // breaks the note ends with (an empty note needs none)
    const surplus = Math.max(0, Math.min(own, have + own - 2)); // those of the result that would make a second blank line
    const body = replacement.slice(surplus);
    return '\n'.repeat(Math.max(0, 2 - have - (own - surplus))) + body + (body.endsWith('\n') ? '' : '\n');
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
      replacementText = anchorGap(currentVal, anchorIdx, anchorId, replacementText);
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
        success = takesInsertCommand(editor) && execInsertTextExact(editor, replacementText);
      } catch (e) {
        success = false;
      }
      if (!success) {
        // A function, so that "$&", "$$", "$`" and "$'" in a model's answer stay what they are
        editor.value = currentVal.replace(anchorId, () => replacementText);
      }
      restoreEditorUserContext(editor, snap, mapOffset(snap.start), mapOffset(snap.end));
      // The length that actually went in: the textarea stores line breaks as \n, so it can differ from replacementText.length.
      flashGhostDiff(editor, anchorIdx, anchorIdx + Math.max(0, editor.value.length - (currentVal.length - anchorId.length)));
      return true;
    } else {
      // If anchor was removed/missing, append to the end
      const appendAt = currentVal.length;
      const insertion = endOfNoteInsertion(currentVal, replacementText);
      editor.setSelectionRange(appendAt, appendAt);
      insertTextWithUndo(insertion, editor);
      const mapOffset = (off) => (off >= appendAt ? off + insertion.length : off);
      restoreEditorUserContext(editor, snap, mapOffset(snap.start), mapOffset(snap.end));
      flashGhostDiff(editor, appendAt, editor.value.length);
      return false;
    }
  }

  // ---- The waiting text of an AI request: one per request, and never part of a saved file ----

  // The label of the text a request leaves in the note while it waits ("AI Correcting...", "Transcribing Image (Gemini)...").
  // Every rewrite says the same, and an answer, a cancel and a restore all find their text with indexOf, i.e. the FIRST such text in
  // the note: with two waiting in one note the answers landed on each other's place. A label that is already taken in this note (in
  // its text, or by a request still waiting there) therefore gets a number ("AI Correcting... 2"); the first one keeps the plain look.
  function uniqueAnchorLabel(tabId, label) {
    const text = getTabText(tabId) || '';
    const waiting = [];
    pendingLLMRequests.forEach((info) => { if (info.tabId === tabId && info.anchorId) waiting.push(info.anchorId); });
    const taken = (candidate) => {
      const anchor = `[${candidate}]`;
      return text.includes(anchor) || waiting.some((w) => w.includes(anchor) || anchor.includes(w));
    };
    if (!taken(label)) return label;
    for (let n = 2; ; n++) {
      const candidate = `${label} ${n}`;
      if (!taken(candidate)) return candidate;
    }
  }

  // True when `text` (the span a rewrite or correction is about to take) holds the waiting text of a request in this note that has not
  // been answered yet: an ask, a rewrite, an image being read, a command task. The words are compared without the line breaks an
  // ask's waiting text carries, so a selection that starts or ends on the label itself counts too.
  function holdsWaitingAnchor(tabId, text) {
    if (!text) return false;
    const holds = (info) => {
      const label = info && info.tabId === tabId && typeof info.anchorId === 'string' ? info.anchorId.trim() : '';
      return label !== '' && text.indexOf(label) !== -1;
    };
    for (const info of pendingLLMRequests.values()) if (holds(info)) return true;
    for (const info of pendingCommandTasks.values()) if (holds(info)) return true;
    return false;
  }

  // The text of a note as it belongs on disk and in the saved session. The waiting text of an ask, rewrite, correction or pasted
  // image whose answer has not come yet is not the person's note: it is swapped back for what it replaced (their own words, or
  // nothing). Otherwise the file kept "[AI Correcting...]" where their sentence had been when the answer never arrived (the note
  // closed, the app quit, the request lost), and the sentence was nowhere. Requests register what to put back as `persistRestore`
  // (and `persistedText` when more than the anchor was inserted). Returns tab.content itself when nothing is waiting.
  function persistedContent(tab) {
    const content = tab.content;
    if (pendingLLMRequests.size === 0 || typeof content !== 'string') return content;
    let out = content;
    // the newest first: a rewrite can have taken an older request's waiting text into its own original
    const waiting = Array.from(pendingLLMRequests.values()).reverse();
    for (const info of waiting) {
      if (info.tabId !== tab.id || typeof info.persistRestore !== 'string') continue;
      const shown = info.persistedText || info.anchorId;
      const at = shown ? out.indexOf(shown) : -1;
      if (at !== -1) out = out.slice(0, at) + anchorGap(out, at, shown, info.persistRestore) + out.slice(at + shown.length);
    }
    return out;
  }

  // Finds anchorId in the tab identified by tabId and replaces it with replacement (or
  // appends replacement if the anchor is no longer there), wherever that tab currently lives:
  // the active pane, the secondary pane, or neither (a background tab, edited as a plain
  // string). This is __onLLMResult's own three-branch dispatch, pulled out so
  // MdMemoBridge.replaceAnchor (used by voice_input.js / file_anchor.js) shares the exact
  // same behavior instead of re-implementing it. Returns false only when tabId names a tab
  // that no longer exists.
  // baseline ({ content, dirty }, optional): the note as it was before the request put its waiting text in, and whether it was
  // modified then. When the replacement brings the note back to exactly that text (a failure, a cancel), it is as unmodified as it
  // was; a note the person changed meanwhile, or whose waiting text moved, stays modified.
  function applyAnchorReplacement(tabId, anchorId, replacement, baseline) {
    const targetTab = getTab(tabId);
    if (!targetTab) return false;

    // The same note in both panes: the answer lands in the pane the person is working in, so the highlight (a few seconds of amber
    // band) is drawn where they are looking - not always in the left one. The other pane is brought up to date either way.
    const inSecondaryEditor = isSplitMode && secondaryViewMode === 'editor' && tabId === secondaryTabId && !!editorSecondary;
    if (tabId === activeTabId && !(inSecondaryEditor && getActiveEditor() === editorSecondary)) {
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
          mirrorEditorText(editorSecondary, editorEl);
          updateSecondaryLineNumbers();
        }
      }
    } else if (inSecondaryEditor) {
      replaceAnchorWithUndo(anchorId, replacement, editorSecondary);

      targetTab.content = editorSecondary.value;
      targetTab.isDirty = true;
      renderTabs();
      updateSecondaryLineNumbers();
      updateStatusBar();
      if (targetTab.id === activeTabId) {
        mirrorEditorText(editorEl, editorSecondary);
        cachedLineCount = 0;
        updateLineNumbers();
        if (isPreviewMode) renderPreview();
      }
    } else {
      const at = targetTab.content.indexOf(anchorId);
      if (at !== -1) {
        const put = anchorGap(targetTab.content, at, anchorId, replacement);
        // A function, so that "$&", "$$", "$`" and "$'" in the replacement stay what they are
        targetTab.content = targetTab.content.replace(anchorId, () => put);
      } else {
        targetTab.content += endOfNoteInsertion(targetTab.content, replacement);
      }
      targetTab.isDirty = true;
      renderTabs();
      // The note is shown only as the right pane's preview: that preview still held the waiting text.
      if (isSplitMode && secondaryViewMode === 'preview' && tabId === secondaryTabId) renderSecondaryPreview();
    }
    if (baseline && typeof baseline.content === 'string' && targetTab.content === baseline.content && targetTab.isDirty !== !!baseline.dirty) {
      targetTab.isDirty = !!baseline.dirty;
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

  // --- Result blocks (result_blocks.js): go to the next / previous one, copy, delete or confirm the one at the caret ---
  // "Confirm" drops the two marker lines and keeps the text; "delete" drops the whole block. Each is ONE undo step
  // (Ctrl+Z brings the block back). The commands are in the palette and can be given keys in Settings -> Shortcuts.
  const RESULT_ACTIONS = ['resultNext', 'resultPrev', 'resultCopy', 'resultDelete', 'resultConfirm'];

  // Replaces text[start, end) of the editor as one step of the browser's own undo history, then tells the app the
  // text changed (line numbers, tab state, autosave). Setting .value would drop the undo history, so that is only the
  // fallback when the editing command is refused.
  function replaceEditorRange(editor, start, end, replacement) {
    const before = editor.value;
    const expected = before.slice(0, start) + replacement + before.slice(end);
    editor.focus();
    editor.setSelectionRange(start, end);
    try {
      if (replacement) insertTextWithUndo(replacement, editor);
      else document.execCommand('delete');
    } catch (e) { /* checked below */ }
    if (editor.value !== expected) editor.value = expected;
    const caret = Math.min(start, editor.value.length);
    editor.setSelectionRange(caret, caret);
    onEditorInput(editor);
    hideCursorAura(true);
    triggerCursorAuraDebounced();
  }

  function runResultAction(action) {
    const RB = window.ResultBlocks;
    const editor = getActiveEditor();
    if (!RB || !editor) return;
    // With the preview over the editor there is no caret to start from.
    if (editor === editorEl && isPreviewMode) {
      showMessage(t('resultNeedsEditor'), 3000);
      return;
    }
    const text = editor.value;

    if (action === 'resultNext' || action === 'resultPrev') {
      const blocks = RB.findResultBlocks(text);
      const block = RB.pickBlock(blocks, editor.selectionStart, action === 'resultNext' ? 1 : -1);
      if (!block) {
        showMessage(t('resultNone'), 3000);
        return;
      }
      gotoLineNumber(block.openLine + 1); // also scrolls it into view, huge notes included
      scheduleUpdateStatusBar();
      showMessage(t('resultAt', { n: blocks.indexOf(block) + 1, total: blocks.length }), 2500);
      return;
    }

    const block = RB.blockAt(text, editor.selectionStart);
    if (!block) {
      showMessage(t('resultNoneAtCaret'), 3000);
      return;
    }
    if (!block.closed) {
      showMessage(t('resultUnclosed'), 5000);
      return;
    }

    if (action === 'resultCopy') {
      const body = RB.bodyText(text, block);
      if (!body) {
        showMessage(t('resultEmptyBody'), 3000);
        return;
      }
      copyTextToClipboard(body).then((ok) => showMessage(ok ? t('resultCopied') : t('resultCopyFailed'), 2500));
      return;
    }

    let edit;
    if (action === 'resultDelete') {
      const range = RB.deleteRange(text, block);
      edit = range && { start: range.start, end: range.end, replacement: '' };
    } else {
      edit = RB.confirmEdit(text, block);
    }
    if (!edit) return;
    replaceEditorRange(editor, edit.start, edit.end, edit.replacement);
    showMessage(action === 'resultDelete' ? t('resultDeleted') : t('resultConfirmed'), 5000);
  }

  // The five palette entries. Each description ends with "({sc})", the action's current key (dropped when it has none).
  function resultBlockPaletteCommands() {
    const svg = (inner) => '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
    const entries = [
      ['resultNext', 'cmd_result_next', 'cmdPaletteResultNext', 'cmdPaletteResultNextDesc', '<polyline points="6 9 12 15 18 9"/><line x1="6" y1="19" x2="18" y2="19"/>'],
      ['resultPrev', 'cmd_result_prev', 'cmdPaletteResultPrev', 'cmdPaletteResultPrevDesc', '<polyline points="18 15 12 9 6 15"/><line x1="6" y1="5" x2="18" y2="5"/>'],
      ['resultCopy', 'cmd_result_copy', 'cmdPaletteResultCopy', 'cmdPaletteResultCopyDesc', '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'],
      ['resultDelete', 'cmd_result_delete', 'cmdPaletteResultDelete', 'cmdPaletteResultDeleteDesc', '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'],
      ['resultConfirm', 'cmd_result_confirm', 'cmdPaletteResultConfirm', 'cmdPaletteResultConfirmDesc', '<circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/>']
    ];
    return entries.map((e) => ({
      id: e[1],
      title: t(e[2]),
      desc: paletteDescWithShortcut(e[3], e[0]),
      iconSvg: svg(e[4]),
      action: () => runResultAction(e[0])
    }));
  }

  // Ctrl+/ (Cmd+/): the lines of the selection become HTML comments, or back. comment_toggle.js decides (style:
  // general.commentStyle, 'line' or 'block'); the edit is one undo step. Lines left alone and refusals are told.
  function executeToggleComment(editor) {
    if (!editor || !window.CommentToggle) return;
    const style = config.general && config.general.commentStyle === 'block' ? 'block' : 'line';
    const r = window.CommentToggle.toggleComment(editor.value, editor.selectionStart, editor.selectionEnd, style);
    if (r.status === 'refused') {
      let msg = t('commentToggleUnsafe');
      if (r.reason === 'unclosed') msg = t('commentToggleUnclosed');
      else if (r.reason === 'terminator') msg = t('commentToggleTerminator');
      else if (r.reason === 'marker') msg = t('commentToggleMarker');
      else if (r.reason === 'overlap') msg = t('commentToggleOverlap');
      showMessage(msg, 4500);
      return;
    }
    if (r.status === 'commented' || r.status === 'uncommented') {
      editor.focus();
      editor.setSelectionRange(r.start, r.end);
      insertTextWithUndo(r.replacement, editor);
      editor.setSelectionRange(r.selStart, r.selEnd);
      onEditorInput(editor);
      hideCursorAura(true);
      triggerCursorAuraDebounced();
    }
    const lines = r.skipped.slice(0, 5).join(', ') + (r.skipped.length > 5 ? ', ...' : '');
    if (r.skipped.length) showMessage(t('commentToggleSkipped', { lines }), 4500);
    else if (r.status === 'nothing') showMessage(t('commentToggleNothing'), 2500);
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

  // Zero-Taxonomy: Derive clean filename / tab title (no ".md") from the note; the rules live in note_title.js.
  // This runs on every keystroke for auto-titled unsaved tabs; the module reads at most 200 lines.
  function deriveTitleFromContent(text) {
    if (!text || !window.NoteTitle) return '';
    return window.NoteTitle.deriveTitle(text);
  }

  // Tab Operations
  // background (RPC tab.new --background): the tab is added to the bar and nothing else moves (no selection, no focus).
  // A file that is already open is not opened twice (Ctrl+O, the palette, a drop, the file given at start-up, `md-memo file.md` on a
  // running instance): its tab is brought forward and comes back instead. A second copy would keep its own text and later save
  // it over the first copy's edits. The text the caller has just read from the file goes into that tab when the tab holds no unsaved
  // text (the file may have changed on disk since the tab was filled: a Git pull, another editor, a session restored after a change,
  // and the next save would write the older text over it); a tab with unsaved text keeps it (see adoptDiskText).
  function createTab(title, content, path, encoding, background) {
    const alreadyOpen = path ? findTabByPath(path) : null;
    if (alreadyOpen) {
      const adopted = adoptDiskText(alreadyOpen, content);
      if (!(background && activeTabId && getTab(activeTabId))) showTab(alreadyOpen.id);
      if (!background) {
        const key = adopted === 'refreshed' ? 'tabAlreadyOpenReloaded' : (adopted === 'kept' ? 'tabAlreadyOpenUnsaved' : 'tabAlreadyOpen');
        showMessage(t(key, { title: alreadyOpen.title || '' }), 2500);
      }
      return alreadyOpen;
    }
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
    // A tab opened from a file remembers what the file holds and its line ending (see rememberDiskText).
    if (path && content !== undefined) rememberDiskText(newTab, initialContent);

    tabs.push(newTab);
    renderTabs();
    if (!(background && activeTabId && getTab(activeTabId))) {
      showTab(tabId);
    }
    saveSessionDebounced();
    return newTab;
  }

  // Puts a tab on screen in the pane the user is working in.
  function showTab(tabId) {
    if (isSplitMode && activePane === 'secondary') {
      selectSecondaryTab(tabId);
    } else {
      selectTab(tabId);
    }
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
    // An id that names no tab changes nothing: it used to be stored in activeTabId before the lookup, which left the
    // app with no valid active tab until the user clicked one.
    if (!getTab(tabId)) return;
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

    // A result's highlight belongs to the note it landed in, not to whatever this textarea shows next.
    if (window.GhostDiff) window.GhostDiff.clear(editorEl);
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
    followAskBarToActiveTab();
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
    followAskBarToActiveTab();
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

  // The Save / Don't save / Cancel question for closing a note with unsaved text. Resolves to 'saved' (the note was written),
  // 'discard' (Don't save: its text is to be thrown away) or 'cancel' (Cancel, or the save was cancelled or failed: keep the note).
  // While the question is up the note is marked closePrompt: an automatic save would write the very text "Don't save" is about to
  // throw away, however long the person takes to answer. A second close request for the same note is declined at once by
  // confirmSaveDialog and must not lift the mark of the first one.
  async function askToSaveBeforeClosing(tab) {
    const owner = !tab.closePrompt;
    tab.closePrompt = true;
    let outcome = 'cancel';
    try {
      const action = await confirmSaveDialog(tab.title);
      if (action === 'dontsave') outcome = 'discard';
      else if (action === 'save' && (await saveTab(tab, false))) outcome = 'saved';
    } finally {
      if (owner) {
        tab.closePrompt = false;
        // The note stays: the autosave that came due while the question was up was skipped, so start it again.
        if (outcome === 'cancel' && getTab(tab.id) === tab && tab.isDirty) armAutoSave(tab);
      }
    }
    return outcome;
  }

  // The user's way to close a tab: a tab with unsaved changes asks first (Save / Don't save / Cancel).
  async function closeTab(tabId, e) {
    if (e) e.stopPropagation();
    const tab = getTab(tabId);
    if (!tab) return;

    if (tab.isDirty) {
      if ((await askToSaveBeforeClosing(tab)) === 'cancel') {
        return; // Cancel, or the save was cancelled or failed: keep the tab open
      }
      // 'saved', or 'discard' (Don't save): proceed to close the tab
    }

    removeTab(tabId);
  }

  // What a closed note's waiting requests can never do is put their answer anywhere: they are settled now, so the task list does not
  // keep showing them as "Running" (and the status bar counting them) until the answer or the 180 s watchdog arrives. A late answer
  // finds nothing waiting for it.
  function settleRequestsOfClosedTab(tabId) {
    Array.from(pendingLLMRequests.entries()).forEach(([reqId, info]) => {
      if (!info || info.tabId !== tabId) return;
      pendingLLMRequests.delete(reqId);
      clearPendingLLMTimer(reqId);
      finishLlmTask(reqId, info, 'canceled');
    });
    updateLLMIndicator();
    Array.from(pendingCommandTasks.entries()).forEach(([reqId, info]) => {
      if (info && info.tabId === tabId) cancelCommandTask(reqId);
    });
  }

  // Takes a tab out without asking anything (closeTab asks; the RPC tab.close decides for itself). The index is
  // looked up now, not before a dialog: tabs may have come and gone while the prompt was open.
  function removeTab(tabId) {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return false;

    tabs.splice(tabIndex, 1);
    settleRequestsOfClosedTab(tabId);
    if (rpcAutoSaveTimers) {
      clearTimeout(rpcAutoSaveTimers.get(tabId));
      rpcAutoSaveTimers.delete(tabId);
    }
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

  // The tab the user is working in: the primary pane's, or the secondary pane's while that one has focus.
  function focusedTabId() {
    return isSplitMode && activePane === 'secondary' ? secondaryTabId : activeTabId;
  }

  // Tab strip overflow (tab_overflow.js): "+" and the All tabs button stay in reach, cut-off edges fade, the focused tab is scrolled
  // into view. renderTabs and refreshTabActiveClasses tell it what changed; with tabs that fit it draws nothing. Built on first use
  // (null when the page has no tab_overflow.js or no #tabs-scroll).
  function getTabOverflow() {
    if (tabOverflow === undefined) {
      tabOverflow = window.TabOverflow ? window.TabOverflow.create({
        scrollEl: document.getElementById('tabs-scroll'),
        listEl: tabsListEl,
        newBtn: document.getElementById('btn-new-tab'),
        allBtn: document.getElementById('btn-all-tabs'),
        getTabs: () => tabs,
        getActiveId: focusedTabId,
        onSelect: (tabId) => handleTabClick(tabId),
        // the All tabs button hides itself when the tabs fit: a keyboard user who pressed Esc in the list has the editor, not the page
        focusFallback: () => { const ed = getActiveEditor(); if (ed && ed.focus) ed.focus(); },
        label: (key) => t(key)
      }) : null;
    }
    return tabOverflow;
  }
  function notifyTabOverflow() {
    const overflow = getTabOverflow();
    if (overflow) overflow.update({ focusedId: focusedTabId(), count: tabs.length });
  }

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
    notifyTabOverflow();
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
      tabEl.title = tab.path || tab.title || '';

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
      if (tab.diskConflict || (tab.saveFailed && tab.isDirty)) {
        // the file changed on disk under this note's unsaved text (Ctrl+S asks what to do), or the last save did not work (the text
        // is only in this tab until a save does)
        const warnEl = document.createElement('span');
        warnEl.className = 'tab-conflict-mark';
        warnEl.textContent = '!';
        warnEl.title = t(tab.diskConflict ? 'diskConflictTabTitle' : 'saveFailedTabTitle');
        tabEl.appendChild(warnEl);
      }

      const closeEl = document.createElement('span');
      closeEl.className = 'tab-close';
      closeEl.textContent = '×';
      closeEl.title = t('closeTabTitle');
      closeEl.setAttribute('data-i18n-title', 'closeTabTitle'); // applyLanguage() retitles it when the UI language changes
      closeEl.onclick = (e) => closeTab(tab.id, e);
      tabEl.appendChild(closeEl);

      tabsListEl.appendChild(tabEl);
    });
    renderAutosaveStatus(); // "failed" follows the tabs: a note's save failing, working, or the note being closed
    notifyTabOverflow();
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
      gutter = { blocks: [], lines: 0, wrapped: false, texts: [], digits: 0 };
      lineGutters.set(el, gutter);
      el.textContent = '';
    }
    // The 44px of style.css holds four digits (the last one may reach into the padding). From 10,000 lines on, the last digit of a
    // number was cut off (99999 read as 9999), so the gutter is at least as wide as its digits then: 13px is its padding and border,
    // 1ch one digit of its monospace font.
    const digits = String(lines).length;
    if (el.style && gutter.digits !== digits) {
      gutter.digits = digits;
      el.style.minWidth = digits > 4 ? `calc(13px + ${digits}ch)` : '';
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
    if (rows || lines !== cachedLineCount || isGutterWrapped(lineNumbersEl)) {
      cachedLineCount = lines;
      renderLineGutter(lineNumbersEl, lines, rows);
    }
    updateResultAccent(lineNumbersEl, editorEl, rows);
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

  // Result blocks (result_blocks.js) show in the gutter as a 3px green bar: bright on the line that opens a block, light
  // on the lines of the result, dark on the line that closes it. The bars live in one overlay element inside the gutter,
  // so they scroll with the numbers, and take their rows from the same line height (and wrapped-row counts) as the
  // numbers. A note with no block has no overlay: the whole check is one indexOf inside findResultBlocks, and an
  // overlay left from an earlier text is removed. The bars are only rewritten when a position changed.
  const resultAccents = new WeakMap(); // gutter element -> { overlay: <div> | null, sig: string }

  // The height of one screen row as the layout really stacks the rows, or NaN when that cannot be read. The layout
  // cuts a fractional line height (14px * 1.6 = 22.4px) to 1/64px per row, so rows * 22.4 drifts from the real rows
  // by about a pixel per hundred rows (the bars would sit two lines off at line 5,000). The height of the first block of
  // numbers divided by the rows in it does not drift: the numbers are laid out by the same engine as the text.
  function gutterRowPitch(el, rows) {
    const g = lineGutters.get(el);
    const block = g && g.blocks[0];
    if (!block || !(g.lines > 0)) return NaN;
    const n = Math.min(GUTTER_BLOCK_LINES, g.lines);
    let count = n;
    if (rows) {
      count = 0;
      for (let i = 0; i < n; i++) count += rows[i] || 1;
    }
    const h = block.getBoundingClientRect().height;
    return h > 0 ? h / count : NaN;
  }

  function updateResultAccent(el, editor, rows) {
    const RB = window.ResultBlocks;
    if (!RB || !el || !editor) return;
    let st = resultAccents.get(el);
    const blocks = RB.findResultBlocks(editor.value);
    if (blocks.length === 0) {
      if (st && st.overlay) {
        if (st.overlay.parentNode === el) el.removeChild(st.overlay);
        st.overlay = null;
        st.sig = '';
      }
      return;
    }
    // A gutter that is not on screen cannot be measured; it is drawn when it comes back (every path that shows it
    // refreshes the numbers).
    if (!(el.clientWidth > 0)) return;
    const cs = window.getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize) || 14;
    const cssLine = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : NaN;
    const measured = gutterRowPitch(el, rows);
    const lineHeight = measured > 0 ? measured : (cssLine > 0 ? cssLine : fontSize * 1.6);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const bars = RB.accentBars(blocks, rows, lineHeight);
    let sig = String(padTop);
    for (let i = 0; i < bars.length; i++) sig += '|' + bars[i].kind.charAt(1) + bars[i].top + ',' + bars[i].height;
    if (!st) {
      st = { overlay: null, sig: '' };
      resultAccents.set(el, st);
    }
    if (st.overlay && st.sig === sig) return;
    if (!st.overlay) {
      st.overlay = document.createElement('div');
      st.overlay.className = 'result-accent';
      st.overlay.setAttribute('aria-hidden', 'true');
      el.appendChild(st.overlay);
    }
    st.overlay.style.top = padTop + 'px';
    st.overlay.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < bars.length; i++) {
      const bar = document.createElement('div');
      bar.className = 'result-accent-bar result-accent-' + bars[i].kind;
      bar.style.top = bars[i].top + 'px';
      bar.style.height = bars[i].height + 'px';
      frag.appendChild(bar);
    }
    st.overlay.appendChild(frag);
    st.sig = sig;
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

  // How many characters a note has as a person counts them: an emoji is one, not its two UTF-16 units (a row of 300 emoji read
  // "605 chars"). Ln/Col stay in UTF-16 units. A note without surrogates, nearly every note, is settled by one native scan.
  function countChars(text) {
    if (!/[\uD800-\uDBFF]/.test(text)) return text.length;
    let n = text.length;
    for (let i = 0; i < text.length; i++) {
      if ((text.charCodeAt(i) & 0xFC00) === 0xD800 && (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00) {
        n--;
        i++;
      }
    }
    return n;
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
    statChars.textContent = t('charCount', { count: countChars(text) });

    const selLength = Math.abs(end - start);
    if (selLength > 0) {
      statSelection.textContent = t('selectionCount', { count: countChars(text.substring(Math.min(start, end), Math.max(start, end))) });
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
    if (rows || lines !== cachedSecondaryLineCount || isGutterWrapped(secondaryLineNumbers)) {
      cachedSecondaryLineCount = lines;
      renderLineGutter(secondaryLineNumbers, lines, rows);
    }
    updateResultAccent(secondaryLineNumbers, editorSecondary, rows);
  }

  // Live preview debouncer for typing in split mode. The wait follows what the last render cost (three times that, from 120 ms to 2 s):
  // a side preview of a 40,000-line note takes 1.5 s per render and was started at every pause in typing, so each key waited for
  // the render the key before had started. A small note still re-renders after 120 ms.
  let livePreviewTimer = null;
  let livePreviewCostMs = 0;
  function livePreviewDelay(costMs) {
    return Math.min(2000, Math.max(120, costMs * 3));
  }
  function debouncedLivePreview() {
    if (livePreviewTimer) clearTimeout(livePreviewTimer);
    livePreviewTimer = setTimeout(async () => {
      const startedAt = Date.now();
      if (isPreviewMode) await renderPreview();
      if (isSplitMode && secondaryViewMode === 'preview') await renderSecondaryPreview();
      livePreviewCostMs = Date.now() - startedAt;
    }, livePreviewDelay(livePreviewCostMs));
  }

  // --- Links in an HTML note's preview -------------------------------------------------------------------
  // The preview frame runs the note's own scripts next to a small helper that reports a click on a link
  // (renderHtmlPreviewTo). The note can send the same message without any click, so a message is only
  // believed when it comes from one of our preview frames, names an http(s) address, and follows a real
  // click inside the frame. Such a click gives this window transient user activation (navigator.userActivation),
  // which a script cannot create. Our own keys and clicks give it too (opening the preview with Ctrl+P is one),
  // and then a click in the frame cannot be told from a script that starts running right away: a message
  // that arrives within HTML_LINK_ACTIVATION_MS of our own input is refused and the user is asked to click again.
  // Nothing here runs until an HTML note is previewed.
  const HTML_LINK_ACTIVATION_MS = 6000; // browsers keep an activation for 5 s (Chromium, Firefox); a little more
  let lastOwnInputAt = -Infinity;       // performance.now() of the last key / pointer event this window received itself
  let ownInputTracked = false;

  function trackOwnInput() {
    lastOwnInputAt = performance.now();
    if (ownInputTracked) return;
    ownInputTracked = true;
    ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach((type) => {
      window.addEventListener(type, () => { lastOwnInputAt = performance.now(); }, { capture: true, passive: true });
    });
  }

  // info: { fromFrame, url, active (has transient activation), sinceOwnInput (ms) } -> { ok: true, url } | { ok: false, reason }
  function decideHtmlPreviewLink(info) {
    if (!info || !info.fromFrame) return { ok: false, reason: 'source' };
    let u = null;
    try { u = new URL(String(info.url)); } catch (err) { /* not an address */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { ok: false, reason: 'scheme' };
    if (!info.active) return { ok: false, reason: 'no-click' };
    if (!(info.sinceOwnInput >= HTML_LINK_ACTIVATION_MS)) return { ok: false, reason: 'ambiguous' };
    return { ok: true, url: u.href };
  }

  function openExternalFromHtmlPreview(e) {
    let fromFrame = false;
    document.querySelectorAll('#html-preview-frame').forEach((frame) => {
      if (frame.contentWindow && frame.contentWindow === e.source) fromFrame = true;
    });
    const activation = navigator.userActivation;
    const verdict = decideHtmlPreviewLink({
      fromFrame: fromFrame,
      url: e.data && e.data.url,
      active: !!(activation && activation.isActive),
      sinceOwnInput: performance.now() - lastOwnInputAt
    });
    if (!verdict.ok) {
      if (verdict.reason === 'ambiguous') showMessage(t('htmlLinkRetry'), 4000);
      return;
    }
    if (window.backend && window.backend.openExternal) {
      window.backend.openExternal(verdict.url);
    } else {
      window.open(verdict.url, '_blank', 'noopener,noreferrer');
    }
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
    trackOwnInput(); // see openExternalFromHtmlPreview: a page that starts running now must not ride on the input that opened it
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

    // 0. HTML comments are not shown (html_comments.js: outside code, md-memo markers left for stripMarkers). Taken out
    //    before the code is set aside, so a fence inside a comment can never pair with a real one.
    if (window.HtmlComments && rawText.indexOf('<!--') !== -1) {
      rawText = window.HtmlComments.removeComments(rawText);
    }

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
        // '' is a network path (//host/share/x.png): nothing is requested, the image just stays empty.
        if (fullPath === '') { img.removeAttribute('src'); return; }
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
        // absPath carries the note's folder name and the last piped cwd, which are arbitrary text: escaped for the attributes.
        return `${prefix}<a href="${escapeHtml(vscodeUri)}" class="vscode-jump-link" title="Open in VS Code (${escapeHtml(absPath + ':' + line)})">${filePath}:${line}</a>`;
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
      openExternalFromHtmlPreview(e);
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
    // #ghost-overlay only ever draws prefix (invisible) + suggestion (colored): it never
    // redraws whatever real text already follows the caret. #editor sits ON TOP of it
    // (z-index 2 vs 1) and is fully opaque, so real text sitting on the SAME LINE as the
    // caret paints straight over the suggestion and hides it completely — a plain
    // <textarea> can't dim part of its own content to make room. Only guard against that:
    // text on LATER lines (the common case — writing mid-document with more paragraphs
    // below) never overlaps a suggestion drawn right after the caret on its own line, so
    // checking the whole rest of the document here (as an earlier version of this guard
    // did) was overbroad and hid suggestions almost everywhere. Sliced from the actual
    // caret, not from prefix.length: a caller's prefix is normally the text up to the
    // caret, but what matters here is where the caret really is right now.
    const caretNow = editorEl.selectionStart;
    const valueNow = editorEl.value;
    const nextNewline = valueNow.indexOf('\n', caretNow);
    const restOfLine = nextNewline === -1 ? valueNow.slice(caretNow) : valueNow.slice(caretNow, nextNewline);
    if (restOfLine.trim().length > 0) {
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

  // IME retype (Windows, opt-in): instead of committing the hiragana, remove the romaji and have the OS input method
  // type the same keys again, so the word arrives as an unconfirmed composition and Space offers kanji. If no
  // composition starts (the IME did not react, the window lost focus), the hiragana is committed as before.
  const IME_RETYPE_WAIT_MS = 900;
  let pendingImeRetype = null;
  let imeRetypeSeq = 0;

  function imeRetypeAvailable() {
    return !!(config.general && config.general.imeGuardianRetype && window.backend && window.backend.retypeWithImeAsync &&
      platformCapabilities.nativeImeSwitch !== false);
  }

  // Why the retype gave up, for the short message that follows a fall-back: 'timeout' (no composition started) or
  // what the Go side said (the window was not in front, the keys could not be sent).
  function imeRetypeReasonText(reason) {
    if (reason === 'timeout') return t('imeRetypeReasonTimeout');
    return String(reason || '').slice(0, 80);
  }

  function finishImeRetype(p, reason) {
    if (pendingImeRetype !== p) return;
    pendingImeRetype = null;
    clearTimeout(p.timer);
    const plan = typeof planImeRetypeFallback === 'function'
      ? planImeRetypeFallback(editorEl.value, p.pos, p.romaji, editorEl.selectionStart) : null;
    if (plan) {
      editorEl.setSelectionRange(plan.start, plan.end);
      insertTextWithUndo(p.hiragana);
      const why = imeRetypeReasonText(reason);
      showMessage(t('imeRetypeFellBack') + (why ? ' (' + why + ')' : ''), 5000);
    }
    if (window.backend && window.backend.setIMEMode) {
      try { window.backend.setIMEMode(true); } catch (_) {}
    }
    onEditorInput();
  }

  function startImeRetype(startPos, endPos, romaji, hiragana) {
    editorEl.focus();
    const before = editorEl.value;
    editorEl.setSelectionRange(startPos, endPos);
    let removed = false;
    try { removed = document.execCommand('delete'); } catch (_) { removed = false; }
    const expected = before.substring(0, startPos) + before.substring(endPos);
    if (!removed || editorEl.value !== expected) {
      editorEl.value = expected;
      editorEl.setSelectionRange(startPos, startPos);
    }
    const pending = { id: 'ime-retype-' + (++imeRetypeSeq), pos: startPos, romaji: romaji, hiragana: hiragana, timer: 0 };
    pending.timer = setTimeout(() => finishImeRetype(pending, 'timeout'), IME_RETYPE_WAIT_MS);
    pendingImeRetype = pending;
    onEditorInput();
    try {
      Promise.resolve(window.backend.retypeWithImeAsync(pending.id, romaji)).catch((e) => finishImeRetype(pending, e && e.message));
    } catch (e) {
      finishImeRetype(pending, e && e.message);
    }
  }

  // The keys were not sent (another window was in front, ...): do not wait for a composition that cannot start.
  window.__onImeRetypeResult = function (reqID, errMsg) {
    if (errMsg && pendingImeRetype && pendingImeRetype.id === reqID) finishImeRetype(pendingImeRetype, errMsg);
  };

  // English typed with the IME on (opt-in): the keys of each composition are logged, and when it ends as kana that cannot be
  // romaji, "[Tab: hello]" offers the English back (see englishRetypeCandidate in ime_guardian.js).
  let imeKeyLog = null;
  function getImeKeyLog() {
    if (!imeKeyLog && typeof newImeKeyLog === 'function') imeKeyLog = newImeKeyLog();
    return imeKeyLog;
  }

  function imeReverseWanted() {
    return !!(config.general && config.general.imeGuardian && config.general.imeGuardianReverse &&
      platformCapabilities.nativeImeSwitch !== false);
  }

  editorEl.addEventListener('keydown', (e) => {
    if (!config.general || !config.general.imeGuardianReverse) return;
    const log = getImeKeyLog();
    if (!log) return;
    if (e.isComposing || e.keyCode === 229) imeKeyLogPush(log, e);
    else resetImeKeyLog(log); // a key outside any composition: whatever was logged is over
  }, true);

  function offerEnglishRetype(committed) {
    const log = getImeKeyLog();
    if (!log) return;
    const keys = log.valid ? log.text : '';
    resetImeKeyLog(log);
    if (!keys || !committed || !imeReverseWanted() || isPreviewMode) return;
    const english = typeof englishRetypeCandidate === 'function' ? englishRetypeCandidate(keys, committed) : null;
    if (!english) return;
    const end = editorEl.selectionStart;
    const start = end - committed.length;
    if (editorEl.selectionEnd !== end || start < 0 || editorEl.value.substring(start, end) !== committed) return;
    activeImeSuggestion = { reverse: true, startPos: start, endPos: end, committed: committed, english: english };
    renderGhostText(editorEl.value.substring(0, end), ` [Tab: ${english}]`);
  }

  function acceptImeSuggestion() {
    if (!activeImeSuggestion) return false;
    const currentCursor = editorEl.selectionStart;
    if (currentCursor !== activeImeSuggestion.endPos) {
      activeImeSuggestion = null;
      clearGhostText();
      return false;
    }

    if (activeImeSuggestion.reverse) {
      // English typed with the IME on: put the English where the kana is, and leave the IME in direct input
      const { startPos, endPos, english } = activeImeSuggestion;
      activeImeSuggestion = null;
      clearGhostText();
      editorEl.setSelectionRange(startPos, endPos);
      insertTextWithUndo(english);
      if (window.backend && window.backend.setIMEMode) {
        try { window.backend.setIMEMode(false); } catch (_) {}
      }
      onEditorInput();
      return true;
    }

    const { startPos, endPos, hiragana, word } = activeImeSuggestion;
    activeImeSuggestion = null;
    clearGhostText();

    if (imeRetypeAvailable() && /^[a-zA-Z]{1,32}$/.test(word || '')) {
      startImeRetype(startPos, endPos, word.toLowerCase(), hiragana);
      return true;
    }

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
      const keepReverse = activeImeSuggestion && activeImeSuggestion.reverse && cursor === activeImeSuggestion.endPos &&
        editorEl.value.substring(activeImeSuggestion.startPos, activeImeSuggestion.endPos) === activeImeSuggestion.committed;
      if (keepReverse) return true; // still on offer: the caller must not clear it or start a completion over it
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
      // renderGhostText refuses to show a suggestion when real text follows the caret on
      // the SAME LINE (see its own comment): asking for one here would just be a wasted
      // round trip. Text on later lines is fine, so this checks only up to the next
      // newline, not the whole suffix (that would also skip requesting a suggestion for
      // nearly every position in a multi-paragraph note).
      const nextNewlineInSuffix = suffix.indexOf('\n');
      const restOfLine = nextNewlineInSuffix === -1 ? suffix : suffix.slice(0, nextNewlineInSuffix);
      if (restOfLine.trim().length > 0) return;

      const reqId = genReqId('ac_');
      currentAutocompleteReqId = reqId;
      pendingAutocomplete = { prefix, tabId: activeTabId };

      if (config.autocomplete.enabled) setPredictStatus('busy');

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
      // In words (the same sorting as the ask bar's failure), not the Go client's raw line: that one is Japanese, cut at 160
      // characters in the tooltip and shown to someone who never asked the AI for anything. The model asked is the prediction's own.
      setPredictStatus('error', describeLlmFailure(errMsg, config.autocomplete).summary);
      return;
    }

    setPredictStatus('ok');

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
    if (!info || !(info.isTask || info.listed)) return;
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
    if (errorText && info.restoreOnError) return info.cancelReplacement || '';
    const message = errorText ? plainLlmError(errorText) : '';
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
  //           restoreOnError?: boolean (a failure puts cancelReplacement back instead of writing the error into the note),
  //           baseline?: { content, dirty } (the note before the anchor went in: a cancel or failure that puts back exactly that
  //             text leaves the note as unmodified as it was),
  //           persistRestore?: string (what a saved file / session holds in place of the anchor while the request waits),
  //           baseline?: { content, dirty } (the note before the anchor went in: a cancel or failure that restores exactly that
  //             text leaves the note as unmodified as it was), persistRestore?: string (what a saved file / session holds in
  //             place of the anchor while the request is waiting; without it the anchor is saved as it is),
  //           onFailure?(errorText) -> boolean (called after that; true = it showed the failure itself, so no toast),
  //           onFinish?(status: 'completed' | 'failed' | 'canceled') }
  // Returns the request id, or null when it cannot start.
  function startLlmTask(opts) {
    const o = opts || {};
    if (!o.tabId || !getTab(o.tabId) || !o.anchorText || typeof o.prompt !== 'string') return null;

    const reqId = genReqId('llm_');
    registerPendingLLMRequest(reqId, {
      tabId: o.tabId,
      anchorId: o.anchorText,
      baseline: o.baseline,
      persistRestore: typeof o.persistRestore === 'string' ? o.persistRestore : undefined,
      isTask: true,
      wrapResult: o.wrapResult,
      wrapError: o.wrapError,
      cancelReplacement: typeof o.cancelReplacement === 'string' ? o.cancelReplacement : '',
      restoreOnError: !!o.restoreOnError,
      onFailure: o.onFailure,
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
      applyAnchorReplacement(info.tabId, info.anchorId, info.cancelReplacement || '', info.baseline);
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
    let val = null;
    try {
      val = await window.backend.validateCliCommand(cmdStr);
    } catch (e) { /* handled below: no verdict */ }
    // A check that failed or said nothing proves nothing: ask as for a risky command instead of running it unchecked.
    // (The backend still refuses a forbidden command when it runs.)
    if (!val || typeof val !== 'object') val = { isWarning: true, reason: t('cliCheckFailed') };
    if (val.isBlocked) {
      showMessage(t('cliBlockedError', { reason: goErr(val.reason) }), 6000);
      return false;
    }
    if (val.isWarning) {
      // A dangerous command: Cancel has the focus, a repeated or held Enter never answers, and the reason keeps its line breaks.
      const proceed = await customConfirm(t('cliWarningConfirm', { reason: goErr(val.reason), cmd: cmdStr }), { okLabel: t('agentRiskRun'), multiline: true, safeDefault: true });
      if (!proceed) {
        showMessage(t('cliCancelled'), 2000);
        return false;
      }
    }
    return true;
  }

  // The agent safety gate, without touching the note: before an agent that acts without asking for permission runs, asks
  // once per agent and exact command line (agent_risk.js); the answer is kept in config.agentAck. Promise<boolean>.
  async function confirmAgentRun(agentKey, def) {
    if (!window.AgentRisk) return true; // only in harnesses that leave agent_risk.js out; the page always loads it
    return window.AgentRisk.confirmRun({
      getAcks: () => config.agentAck,
      setAcks: (acks) => {
        config.agentAck = acks;
        savePersistentConfig().catch(() => {});
      },
      ask: (text) => customConfirm(text, { okLabel: t('agentRiskRun'), multiline: true, safeDefault: true }),
      t: (key) => t(key)
    }, String(agentKey || ''), def);
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

  // What the image's waiting text names as the reader of the picture: Gemini (the default), otherwise the model that is set (a local
  // qwen2.5vl was shown as "Gemini", which says the picture left the machine when it did not).
  function visionTargetLabel() {
    const cfg = config.vision || {};
    const base = String(cfg.baseUrl || '').trim().toLowerCase();
    const model = String(cfg.model || '').trim();
    if (base === '' || base.indexOf('googleapis.com') !== -1) return 'Gemini';
    return model || base.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '') || 'Gemini';
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
    const anchorId = `[${uniqueAnchorLabel(curTab.id, t('ocrTranscribingAnchor', { target: visionTargetLabel() }))}]`;

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
      anchorId: anchorId,
      persistedText: insertion,
      persistRestore: '',
      listed: true // in the task panel (finishLlmTask settles it), where it can be cancelled
    });

    updateLLMIndicator();

    // The status bar counts the image being read ("AI working (1)"), so the task panel lists it too, with a way to stop waiting.
    if (window.TaskManager && window.TaskManager.addTask) {
      window.TaskManager.addTask({
        id: reqId,
        type: 'llm',
        agent: 'LLM',
        instruction: anchorId.slice(1, -1),
        onCancel: () => cancelImageRead(reqId)
      });
    }

    if (window.backend && window.backend.queryVisionAsync) {
      window.backend.queryVisionAsync(reqId, config.vision.prompt, imgData.base64, imgData.mimeType, JSON.stringify(config.vision));
    } else {
      setTimeout(() => {
        window.__onLLMResult(reqId, `### 画像解析マークダウン (Gemini Flash Lite)\n\n- 解析テキスト完了`, '');
      }, 3000);
    }
  }

  // Stops waiting for an image being read (cancel in the task panel). Like cancelLlmTask: the request cannot be aborted on the Go side,
  // so it is forgotten; the waiting text goes with the line breaks it came with, and the late answer finds nothing waiting for it.
  function cancelImageRead(reqId) {
    const info = pendingLLMRequests.get(reqId);
    if (!info || !info.listed) return false;
    pendingLLMRequests.delete(reqId);
    clearPendingLLMTimer(reqId);
    updateLLMIndicator();
    const text = getTabText(info.tabId);
    const whole = info.persistedText || '';
    const landOn = whole && text !== null && text.indexOf(whole) !== -1 ? whole : info.anchorId;
    if (text !== null && text.indexOf(landOn) !== -1) applyAnchorReplacement(info.tabId, landOn, '', info.baseline);
    finishLlmTask(reqId, info, 'canceled');
    showMessage(t('llmTaskCanceled'), 2500);
    return true;
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
  // An error line can carry the API key: the address of a cloud request holds it. Every error text passes through here before it
  // is shown, written into a note or kept in the task list. The keys in the settings are removed wherever they appear.
  function redactLlmSecrets(text) {
    if (!text || !window.LlmError || typeof window.LlmError.redact !== 'function') return text;
    const secrets = [];
    Object.keys(config).forEach((group) => {
      const entry = config[group];
      if (entry && typeof entry === 'object' && typeof entry.apiKey === 'string' && entry.apiKey) secrets.push(entry.apiKey);
    });
    return window.LlmError.redact(text, secrets);
  }

  // An error in words for a note or a toast: the kind of failure in the UI language ("Can't reach ..."), not the raw line the
  // client produced (Japanese text with an address in it). A failure that fits no kind keeps its own (redacted) one-line text.
  function plainLlmError(errorText, cfg) {
    if (errorText === t('llmTimeout') || errorText === t('llmEmptyAnswer')) return errorText; // our own words are plain already
    const failure = describeLlmFailure(errorText, cfg);
    if (failure.kind !== 'other') return failure.summary;
    return window.LlmError ? window.LlmError.oneLine(errorText, 300) : String(errorText || '').replace(/\s+/g, ' ').trim().substring(0, 300);
  }

  // The settings of the model a request went to: an image read by the vision model reports on config.vision.
  function llmConfigOf(reqId) {
    return String(reqId).startsWith('vision_') ? config.vision : config.text;
  }

  window.__onLLMResult = function (reqId, resultText, errorText) {
    const reqInfo = pendingLLMRequests.get(reqId);
    if (!reqInfo) return;
    errorText = redactLlmSecrets(errorText);

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
    } else if (reqInfo.isRewrite) {
      // Same Zero Data Loss guarantee as isCorrection above: this also replaces a
      // selection in place (Ctrl+K), so a failed/empty rewrite must restore the
      // original text rather than leave the anchor or blank it out.
      cleanedResult = stripMarkdownCodeFences(cleanedResult, true);
      if (errorText || !cleanedResult || cleanedResult.trim() === '') {
        cleanedResult = reqInfo.originalText || '';
        isRollback = true;
      }
    } else if (reqId.startsWith('vision_') || reqId.startsWith('ocr_')) {
      cleanedResult = stripMarkdownCodeFences(cleanedResult);
    } else {
      cleanedResult = stripMarkdownCodeFences(cleanedResult, true);
    }

    // An answer with nothing in it (blank, or only a <think> block) is a failure, not "inserted": it used to leave the blank lines
    // the waiting text had around it and say the answer was inserted. A rewrite / correction already restores its text above.
    // A task goes down the failure path (the ask bar shows it with Retry); a plain request just has its waiting text taken out.
    const emptyAnswer = !errorText && !cleanedResult && !reqInfo.isCorrection && !reqInfo.isRewrite;
    if (emptyAnswer && reqInfo.isTask) errorText = t('llmEmptyAnswer');

    let replacement = reqInfo.isTask
      ? llmTaskReplacement(reqInfo, cleanedResult, errorText)
      : ((errorText && !reqInfo.isCorrection && !reqInfo.isRewrite) ? `[${t('llmError')}${plainLlmError(errorText, llmConfigOf(reqId))}]` : cleanedResult);

    // What the answer lands on is the waiting text (the whole insertion, with its line breaks, when nothing is to be written).
    let landOn = reqInfo.anchorId;
    const liveText = getTabText(reqInfo.tabId);
    if (emptyAnswer && !reqInfo.isTask) {
      replacement = '';
      const whole = reqInfo.persistedText || `\n\n${reqInfo.anchorId}\n\n`;
      if (liveText !== null && liveText.indexOf(whole) !== -1) landOn = whole;
    }
    // A pure restore (a failed or empty answer puts the person's own text back, or nothing) has nothing to do once the waiting text
    // is gone from the note (Ctrl+Z took it out, and with it the request's reason to write): appending would duplicate the line.
    const restoreOnly = isRollback || (reqInfo.isTask && !!errorText && !!reqInfo.restoreOnError) || (emptyAnswer && !reqInfo.isTask);
    const nothingToRestore = restoreOnly && liveText !== null && liveText.indexOf(landOn) === -1;
    if (!nothingToRestore) applyAnchorReplacement(reqInfo.tabId, landOn, replacement, reqInfo.baseline);
    // The task list gets the same plain words as the note and the toast, not the raw line (Japanese text, a Go error, an address).
    finishLlmTask(reqId, reqInfo, errorText ? 'failed' : 'completed', errorText ? plainLlmError(errorText, llmConfigOf(reqId)) : undefined);

    // The ask / rewrite bars show a failure themselves (plain words, Retry, AI settings) instead of a toast.
    if (errorText && typeof reqInfo.onFailure === 'function') {
      let handled = false;
      try {
        handled = reqInfo.onFailure(errorText) === true;
      } catch (e) {
        console.warn('LLM onFailure failed:', e);
      }
      if (handled) return;
    }

    if (reqInfo.isCorrection) {
      if (isRollback) {
        showMessage(t('aiCorrectionRestored'), 4000);
      } else {
        showMessage(t('aiCorrectionSuccess'), 3000);
      }
    } else if (reqInfo.isRewrite) {
      if (isRollback) {
        showMessage(t('aiCorrectionRestored'), 4000);
      } else {
        showMessage(t('rewriteSuccess'), 3000);
      }
    } else if (errorText) {
      showMessage(`${t('llmError')}${plainLlmError(errorText, llmConfigOf(reqId))}`, 5000);
    } else if (emptyAnswer) {
      showMessage(`${t('llmError')}${t('llmEmptyAnswer')}`, 5000);
    } else {
      showMessage(t('llmResponseInserted'), 3000);
    }
  };

  // One native file dialog at a time. The dialogs are shown on the window's own thread: while one is being built or is
  // open, that thread serves nothing else, so a further click on Save / Open waits in the host and opens one more dialog
  // the moment the first is closed ("pressed Save a few times, got a few dialogs"). This script runs in another process and
  // is not held up, so it drops the extra requests itself. A dropped request reads as "cancelled" to every caller
  // (undefined), the same as closing the dialog.
  let nativeDialogBusy = false;
  async function withNativeDialog(open) {
    if (nativeDialogBusy) {
      showMessage(t('dialogAlreadyOpen'), 2500);
      return undefined;
    }
    nativeDialogBusy = true;
    try {
      return await open();
    } finally {
      nativeDialogBusy = false;
    }
  }

  // File Operations (Save as-is / Export Plain Text / Open)
  //
  // One write per note at a time: a save that starts while another is still writing this note waits for it, so an older text can
  // never land after a newer one (an autosave that fires during a slow write, Ctrl+S during an autosave). Costs nothing when saves
  // do not overlap: the first one runs at once.
  const saveInFlight = new WeakMap();
  // opts.auto (the autosave timer): if it had to wait and the write it waited for left nothing unsaved (or the tab was closed with
  // "Don't save" meanwhile), there is nothing left to write.
  async function saveTab(tab, forceSaveAs, opts) {
    if (!tab) return false;
    let waited = false;
    while (saveInFlight.has(tab)) {
      waited = true;
      await saveInFlight.get(tab);
    }
    if (waited && opts && opts.auto && (!tab.isDirty || getTab(tab.id) !== tab)) return true;
    const run = saveTabNow(tab, forceSaveAs, opts);
    const release = () => { if (saveInFlight.get(tab) === settled) saveInFlight.delete(tab); };
    const settled = run.then(release, release);
    saveInFlight.set(tab, settled);
    return run;
  }

  // Marks a tab saved up to `sent`, the text that was handed to the backend. Whatever was typed while the write was in flight is
  // not on disk: the tab stays unsaved, so the next autosave and the close prompt still cover it.
  function markSavedUpTo(tab, sent) {
    const now = getTabText(tab.id);
    tab.saveFailed = false; // this write worked (see the catch of saveTabNow)
    tab.isDirty = now !== null && now !== sent;
    if (tab.isDirty) armAutoSave(tab);
    else tab.autoSaveSince = 0; // nothing unsaved is waiting any more (see scheduleAutoSave)
  }

  // The tab's text written to its file with the file's own line ending. A file the tab already knows is written through
  // saveFileChecked, which first makes sure it still holds what the tab last read or wrote (`force` skips that check: the person chose
  // to overwrite). Without that, a Git pull, a sync client or another editor changed the file and the next save wrote the older
  // text over it. Backends without saveFileChecked (a test mock) and tabs that never learned the file save plainly.
  function writeTabToItsFile(tab, force) {
    const body = window.DiskSync ? window.DiskSync.applyEol(persistedContent(tab), tab.eol) : persistedContent(tab);
    if (!force && tab.diskSig && window.backend.saveFileChecked) {
      return window.backend.saveFileChecked(tab.path, body, tab.encoding, tab.diskSig);
    }
    return window.backend.saveFile(tab.path, body, tab.encoding);
  }

  // What the file holds after a write of the tab's text: the Go side fingerprints what it wrote; a backend that does not say gets
  // the page's own fingerprint of the same text.
  function rememberWritten(tab, res) {
    if (!window.DiskSync) return;
    tab.diskSig = (res && res.sig) || window.DiskSync.sum(persistedContent(tab));
    tab.diskConflict = false;
  }

  // The file changed on disk under a tab that has unsaved text. Autosave stops for this note (it would ask, in the middle of typing)
  // and the person is told once; Ctrl+S asks what to do (see saveTabNow).
  function flagDiskConflict(tab) {
    if (tab.diskConflict) return;
    tab.diskConflict = true;
    renderTabs();
    showMessage(t('diskChangedUnsaved', { title: tab.title || '' }), 7000);
  }

  // What to do with a file that changed on disk when the person saves: 'saveas', 'reload', 'overwrite' or 'cancel'. The same modal as
  // the close prompt, so it is never stacked on another question; no letter shortcuts, Esc cancels, and Enter presses the focused
  // button (Save as first: it destroys nothing).
  function confirmDiskConflict(title) {
    if (confirmModalTaken()) return Promise.resolve('cancel');
    return new Promise((resolve) => {
      if (!confirmModal || !confirmModalMessage) {
        resolve('cancel');
        return;
      }
      confirmModalMessage.textContent = t('diskConflictMessage', { title: title || t('untitled') });
      confirmModalMessage.style.whiteSpace = 'pre-line';
      const labelled = [[confirmModalSave, 'diskConflictSaveAs'], [confirmModalDontSave, 'diskConflictReload'], [confirmModalOk, 'diskConflictOverwrite'], [confirmModalCancel, 'btnCancel']];
      labelled.forEach(([el, key]) => {
        if (!el) return;
        el.textContent = t(key);
        el.classList.remove('hidden');
        el.style.display = '';
      });
      // four long choices: one under the other; the one that destroys the other change is not the highlighted button
      confirmModal.classList.add('confirm-stacked');
      if (confirmModalOk) confirmModalOk.classList.replace('btn-primary', 'btn-secondary');
      confirmModal.classList.remove('hidden');

      let settled = false;
      const cleanup = (action) => {
        if (settled) return;
        settled = true;
        confirmModal.classList.add('hidden');
        confirmModal.classList.remove('confirm-stacked');
        if (confirmModalOk) confirmModalOk.classList.replace('btn-secondary', 'btn-primary');
        confirmModalMessage.style.whiteSpace = '';
        [confirmModalSave, confirmModalDontSave, confirmModalOk, confirmModalCancel, confirmModalClose].forEach((el) => { if (el) el.onclick = null; });
        window.removeEventListener('keydown', onKeyDown, true);
        if (confirmModalRelease === release) confirmModalRelease = null;
        resolve(action);
      };
      const release = () => cleanup('cancel');
      confirmModalRelease = release;

      const onKeyDown = (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup('cancel');
          return;
        }
        if (e.ctrlKey || e.altKey || e.metaKey || e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const focused = document.activeElement;
        if (focused === confirmModalDontSave) cleanup('reload');
        else if (focused === confirmModalOk) cleanup('overwrite');
        else if (focused === confirmModalCancel || focused === confirmModalClose) cleanup('cancel');
        else cleanup('saveas');
      };

      if (confirmModalSave) confirmModalSave.onclick = () => cleanup('saveas');
      if (confirmModalDontSave) confirmModalDontSave.onclick = () => cleanup('reload');
      if (confirmModalOk) confirmModalOk.onclick = () => cleanup('overwrite');
      if (confirmModalCancel) confirmModalCancel.onclick = () => cleanup('cancel');
      if (confirmModalClose) confirmModalClose.onclick = () => cleanup('cancel');
      window.addEventListener('keydown', onKeyDown, true);
      setTimeout(() => { if (confirmModalSave) confirmModalSave.focus(); }, 10);
    });
  }

  // "Load the file": the tab shows the file as it is on disk. The person's own text is not thrown away: it goes into a new unsaved
  // tab next to this one. Resolves to true when the tab was switched.
  async function reloadTabFromDisk(tab, mine) {
    let res = null;
    try {
      res = window.backend && window.backend.readFileByPath ? await window.backend.readFileByPath(tab.path) : null;
    } catch (e) {
      showMessage(`${t('diskConflictLoadFailed')}${goErr(e.message || e)}`, 4000);
      return false;
    }
    if (!res || typeof res.content !== 'string') {
      showMessage(`${t('diskConflictLoadFailed')}${tab.path}`, 4000);
      return false;
    }
    let mineTab = null;
    if (lfText(res.content) !== lfText(mine)) {
      const base = String(tab.title || t('untitled')).replace(/\.(md|markdown|txt)$/i, '');
      mineTab = createTab(t('diskConflictMineTitle', { title: base }), mine, '', tab.encoding, true);
      mineTab.isDirty = true;
    }
    tab.isDirty = false;
    tab.content = mine; // so that the tab being on screen counts as showing nothing unsaved while it takes the file's text
    if (tab.encoding && res.encoding) tab.encoding = res.encoding;
    adoptDiskText(tab, res.content, res.content);
    renderTabs();
    saveSessionDebounced();
    showMessage(mineTab ? t('diskConflictKept', { title: tab.title || '', mine: mineTab.title }) : t('diskConflictLoaded', { title: tab.title || '' }), 6000);
    return true;
  }

  async function saveTabNow(tab, forceSaveAs, opts) {
    if (tab.id === activeTabId && editorEl) {
      tab.content = editorEl.value;
    } else if (isSplitMode && tab.id === secondaryTabId && editorSecondary && secondaryViewMode === 'editor') {
      tab.content = editorSecondary.value;
    }
    // The file changed under this note's unsaved text: an automatic save would have to ask in the middle of typing, so it waits for
    // Ctrl+S (see flagDiskConflict).
    if (opts && opts.auto && tab.diskConflict && tab.path && !forceSaveAs) return false;
    // The close prompt of this note is open: an automatic save would write the very text "Don't save" is about to throw away (see
    // askToSaveBeforeClosing, which starts the autosave again if the note stays).
    if (opts && opts.auto && tab.closePrompt) return false;
    const sent = tab.content; // exactly what this save writes

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
          // "YYYY-MM-DD_<summary>.md" (the note's own date heading, else today); the tab label stays the plain summary.
          const derived = window.NoteTitle ? window.NoteTitle.defaultSaveName(tab.content, new Date()) : '';
          suggestedName = derived || (tab.title || `${t('untitled')}.md`);
        }
        const asBody = window.DiskSync ? window.DiskSync.applyEol(persistedContent(tab), tab.eol) : persistedContent(tab);
        const res = await withNativeDialog(() => window.backend.saveFileAs(asBody, tab.encoding, suggestedName));
        if (res && res.path) {
          // Another tab may show this very file (Save As over an open note): it is out of date now and must not own the path too.
          const displaced = releasePathFromOtherTabs(tab, res.path);
          tab.path = res.path;
          tab.title = res.title;
          tab.isAutoTitle = false;
          rememberWritten(tab, res);
          markSavedUpTo(tab, sent);
          renderTabs();
          showMessage(displaced === 'detached' ? t('saveAsOtherTabKept', { title: tab.title }) : `${t('saveSuccess')}${tab.title}`, 2500);
          return true;
        }
        return false; // User cancelled Save As dialog
      } else {
        let res = await writeTabToItsFile(tab, false);
        if (res && res.conflict) {
          // The file holds something other than what this note last knew of it; nothing was written.
          if (opts && opts.auto) {
            flagDiskConflict(tab);
            return false;
          }
          const choice = await confirmDiskConflict(tab.title);
          if (choice === 'saveas') return saveTabNow(tab, true, opts);
          if (choice === 'reload') {
            await reloadTabFromDisk(tab, sent);
            return false;
          }
          if (choice !== 'overwrite') return false;
          res = await writeTabToItsFile(tab, true);
        }
        rememberWritten(tab, res);
        markSavedUpTo(tab, sent);
        renderTabs();
        // An automatic save is routine: its "Saved" note must not bring the dimmed status bar back every time typing pauses.
        showMessage(`${t('saveSuccess')}${tab.title}`, 2000, { quiet: !!(opts && opts.auto) });
        return true;
      }
    } catch (e) {
      showMessage(`${t('saveError')}${goErr(e.message || e)}`, 4000);
      // The toast is gone in four seconds: what stays says the text is NOT on disk (a mark on the tab, "failed" on the autosave
      // item). The next keystroke arms the autosave again (onEditorInput), Ctrl+S tries at once; a save that works clears it.
      tab.saveFailed = true;
      renderTabs();
      return false;
    }
  }

  async function saveActiveFile(forceSaveAs) {
    return saveTab(getActiveTab(), forceSaveAs);
  }

  // Schedules a debounced autosave for a SPECIFIC tab (captured at schedule time,
  // not "whatever is active" when the timer fires). Callers pass that tab's own timer
  // handle (see armAutoSave) so typing in one tab or pane never cancels a pending save
  // of another. Returns the new timer handle.
  function scheduleAutoSave(tab, currentTimer) {
    clearTimeout(currentTimer);
    // 1.5 s after the last keystroke, but never later than 10 s after the first one that is still unsaved: a debounce alone writes
    // nothing for as long as the pauses between keystrokes stay under 1.5 s, and a crash then loses all of it.
    const now = Date.now();
    if (!tab.autoSaveSince) tab.autoSaveSince = now;
    const delay = Math.max(0, Math.min(1500, 10000 - (now - tab.autoSaveSince)));
    return setTimeout(() => {
      tab.autoSaveSince = 0;
      // Re-validate: the tab may have been closed, saved, or emptied of its
      // path in the time between scheduling and firing. One whose close prompt is
      // open waits for the answer.
      if (getTab(tab.id) === tab && !tab.closePrompt && tab.isDirty && tab.path && !tab.diskConflict) {
        saveTab(tab, false, { auto: true });
      }
    }, delay);
  }

  // The tab's debounced autosave, on the tab's own timer (every note, shown in a pane or not, keeps one; a keystroke in another
  // note, switching tabs, or the other pane cannot cancel it). Nothing happens with autosave off or for a note without a file.
  function armAutoSave(tab) {
    if (!tab || !tab.path || !config.general.autoSave) return;
    if (!rpcAutoSaveTimers) rpcAutoSaveTimers = new Map();
    rpcAutoSaveTimers.set(tab.id, scheduleAutoSave(tab, rpcAutoSaveTimers.get(tab.id)));
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
      const res = await withNativeDialog(() => window.backend.exportPlainTextAs(tab.content, tab.encoding, defaultTxtName));
      if (res && res.path) {
        showMessage(`${t('exportPlainTextSuccess')}${res.title}`, 3000);
      }
    } catch (e) {
      showMessage(`${t('exportPlainTextError')}${goErr(e.message || e)}`, 4000);
    }
  }

  // Workspace Notes for Ambient Context & Search
  let workspaceRootPath = '';
  let workspaceNotes = [];

  async function openFolder() {
    if (!window.backend || !window.backend.openFolder) return;
    try {
      const folderPath = await withNativeDialog(() => window.backend.openFolder());
      if (folderPath) {
        await loadWorkspaceFolder(folderPath);
      }
    } catch (e) {
      showMessage(`${t('openError')}${goErr(e.message || e)}`, 4000);
    }
  }

  async function loadWorkspaceFolder(folderPath, quiet) {
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
          if (!quiet) showMessage(t('folderLoaded', { count: entries.length }), 3000);
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
      const res = await withNativeDialog(() => window.backend.openFile());
      if (res && res.path) {
        // Ensure editable editor is visible (switch out of preview mode if active)
        if (isPreviewMode) {
          await togglePreview();
        }
        const tab = createTab(res.title, res.content, res.path, res.encoding);
        editorEl.focus();
      }
    } catch (e) {
      showMessage(`${t('openError')}${goErr(e.message || e)}`, 4000);
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

  // The AI item of the status bar (its label and its popover of switches) follows the config; see status_ai.js. Nothing
  // happens when the module is absent.
  function refreshStatusAI() {
    if (window.StatusAI) window.StatusAI.refresh();
  }

  // The last text prediction as the AI item shows it: 'busy' while a request is out, 'error' with the message, else 'ok'.
  function setPredictStatus(state, detail) {
    if (window.StatusAI) window.StatusAI.setPredict(state, detail);
  }

  // Text prediction (ghost text) on / off. Turning it off forgets a failed or pending request: there is nothing to show.
  function toggleAutocomplete() {
    config.autocomplete.enabled = !config.autocomplete.enabled;
    setPredictStatus('ok');
    refreshStatusAI();
    showMessage(t(config.autocomplete.enabled ? 'toastPredictionOn' : 'toastPredictionOff'), 2000);
    if (!config.autocomplete.enabled) {
      clearGhostText();
    }
    savePersistentConfig();
  }

  function renderAutosaveStatus() {
    if (!statAutosave) return;
    const on = !!(config.general && config.general.autoSave);
    // A save that failed and has not worked since: "ON" would say the text is being kept (it is only in the tab and the session).
    const failed = tabs.some((tb) => tb.saveFailed && tb.isDirty);
    statAutosave.textContent = failed ? t('statAutosaveFailed') : (on ? t('statAutosaveOn') : t('statAutosaveOff'));
    statAutosave.title = failed ? t('statAutosaveFailedTooltip') : (on ? t('statAutosaveTooltip') : t('statAutosaveOffTooltip'));
    statAutosave.style.opacity = on || failed ? '1' : '0.6';
    statAutosave.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // The IME Guardian toggle: only in the Japanese UI. Words, look and pressed state follow the config.
  function renderImeStatus() {
    if (!statIme) return;
    if (((config.general && config.general.language) || 'en') !== 'ja') {
      statIme.style.display = 'none';
      return;
    }
    const on = !!(config.general && config.general.imeGuardian);
    statIme.style.display = '';
    statIme.textContent = on ? t('statImeOn') : t('statImeOff');
    statIme.title = t('statImeTooltip');
    statIme.style.opacity = on ? '1' : '0.6';
    statIme.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // Settings > AI Models > Voice input: "also record the sound this PC plays". Shown where the backend can do it (Windows);
  // "Check audio devices" opens the microphone and the PC-audio capture for half a second and says what each one did.
  let meetingAudioCheck = null;
  window.__onMeetingAudioCheck = function (reqId, json) {
    const c = meetingAudioCheck;
    meetingAudioCheck = null;
    if (!c) return;
    c.btn.disabled = false;
    try {
      const r = JSON.parse(json);
      const part = (p, key) => p.ok ? t(key + 'Ok') : t(key + 'Fail', { error: p.error || '' });
      c.out.textContent = part(r.microphone, 'voiceMeetingMic') + '  /  ' + part(r.system, 'voiceMeetingSys');
    } catch (e) {
      c.out.textContent = t('voiceMeetingCheckFailed');
    }
  };

  function initMeetingAudioSettings() {
    const group = document.getElementById('cfg-voice-system-audio-group');
    const box = document.getElementById('cfg-voice-system-audio');
    if (box) box.checked = !!(config.voice && config.voice.includeSystemAudio);
    if (!group) return;
    const backend = window.backend;
    if (!backend || typeof backend.meetingRecordingSupported !== 'function') { group.classList.add('hidden'); return; }
    Promise.resolve(backend.meetingRecordingSupported()).then((ok) => { group.classList.toggle('hidden', !ok); }).catch(() => group.classList.add('hidden'));
    const btn = document.getElementById('btn-check-meeting-audio');
    const out = document.getElementById('meeting-audio-check-result');
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        if (!out || typeof backend.checkMeetingAudioAsync !== 'function') return;
        btn.disabled = true;
        out.textContent = t('voiceMeetingChecking');
        meetingAudioCheck = { btn: btn, out: out };
        try {
          const called = backend.checkMeetingAudioAsync('chk_' + Date.now());
          if (called && typeof called.catch === 'function') called.catch(() => window.__onMeetingAudioCheck('', ''));
        } catch (e) {
          window.__onMeetingAudioCheck('', '');
        }
      });
    }
  }

  function voiceRefineEnabled() {
    return !(config.voice && config.voice.refine && config.voice.refine.enabled === false);
  }

  // Voice tidy-up: the second stage of voice input (tidying the transcript, speak-to-edit). Its switch is in the AI popover.
  function toggleVoiceRefine() {
    if (!config.voice) config.voice = {};
    config.voice.refine = Object.assign({ model: 'gemini-flash-lite-latest', timeoutSec: 5 }, config.voice.refine, { enabled: !voiceRefineEnabled() });
    refreshStatusAI();
    showMessage(t(config.voice.refine.enabled ? 'voiceRefineOnToast' : 'voiceRefineOffToast'), 2500);
    savePersistentConfig();
  }

  function toggleAutoSave() {
    config.general.autoSave = !config.general.autoSave;
    renderAutosaveStatus();
    showMessage(t(config.general.autoSave ? 'toastAutosaveOn' : 'toastAutosaveOff'), 2000);
    if (rpcAutoSaveTimers) {
      rpcAutoSaveTimers.forEach((timer) => clearTimeout(timer));
      rpcAutoSaveTimers.clear();
    }
    if (config.general.autoSave) {
      // Pick up the edits made while autosave was off, in every note that has a file (not only the ones on screen)
      tabs.forEach((tb) => {
        if (tb.isDirty) armAutoSave(tb);
      });
    }
    const cfgAutosaveEl = document.getElementById('cfg-autosave');
    if (cfgAutosaveEl) cfgAutosaveEl.checked = config.general.autoSave;
    savePersistentConfig();
  }

  function toggleIME() {
    config.general.imeGuardian = !config.general.imeGuardian;
    renderImeStatus();
    showMessage(t(config.general.imeGuardian ? 'toastImeOn' : 'toastImeOff'), 2000);
    if (!config.general.imeGuardian && imeGuardianInstance) {
      imeGuardianInstance.reset();
    }
    savePersistentConfig();
  }

  function ensureActionConfig() {
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
    return config.action;
  }

  // Suggestions (Quick Actions): hands the setting to the suggestion engine and redraws the AI item, whose switches show it.
  function updateActionStatus() {
    const isEn = ensureActionConfig().enabled !== false;
    if (window.JevAction && window.JevAction.updateConfig) {
      window.JevAction.updateConfig({
        enabled: isEn,
        manualOnly: !!config.action.manualOnly,
        delaySec: typeof config.action.delaySec === 'number' ? config.action.delaySec : 1.5
      });
    } else if (window.JevAction && window.JevAction.setEnabled) {
      window.JevAction.setEnabled(isEn);
    }
    refreshStatusAI();
  }

  // Suggestions have three real states behind two switches in the AI popover: 'auto' (suggests while you type), 'manual'
  // (only on its shortcut, no auto-popup) and 'off'. They are the enabled / manualOnly pair that the two switches of
  // Settings control (see updateQuickActionsFieldStates), so both places stay in step.
  function actionMode() {
    const isEn = ensureActionConfig().enabled !== false;
    return !isEn ? 'off' : (config.action.manualOnly ? 'manual' : 'auto');
  }

  function setActionMode(mode) {
    ensureActionConfig();
    config.action.enabled = mode !== 'off';
    config.action.manualOnly = mode === 'manual';

    updateActionStatus();

    const cfgActEnabledEl = document.getElementById('cfg-action-enabled');
    if (cfgActEnabledEl) cfgActEnabledEl.checked = config.action.enabled !== false;
    const cfgActManualOnlyEl = document.getElementById('cfg-action-manual-only');
    if (cfgActManualOnlyEl) cfgActManualOnlyEl.checked = !!config.action.manualOnly;
    // Keep the settings modal's muted/disabled field states correct if it happens to be open.
    if (typeof updateQuickActionsFieldStates === 'function') updateQuickActionsFieldStates();

    // Naming the actual key (its configured shortcut, not a fixed "Ctrl+J") stays right if the user rebinds quickActions.
    const toastKey = mode === 'off' ? 'toastSuggestionsOff' : (mode === 'manual' ? 'toastSuggestionsManual' : 'toastSuggestionsOn');
    showMessage(t(toastKey, { key: suggestionsKeyLabel() }), 2500);
    savePersistentConfig();
  }

  function suggestionsKeyLabel() {
    return getShortcutDisplay('quickActions', isMac ? 'Cmd+J' : 'Ctrl+J');
  }

  function toggleSuggestions() {
    setActionMode(actionMode() === 'off' ? 'auto' : 'off');
  }

  function toggleSuggestionsManual() {
    setActionMode(actionMode() === 'manual' ? 'auto' : 'manual');
  }

  // The AI item of the status bar (status_ai.js): the popover holds Text prediction, Suggestions and Voice tidy-up as switches,
  // and the item says which model answers. Every toggle is the function the rest of the app already uses.
  function initStatusAI() {
    if (!window.StatusAI) return;
    window.StatusAI.init({
      t,
      getConfig: () => config,
      isConfigured: () => isLlmConfigured(false),
      getManualKey: suggestionsKeyLabel,
      actions: {
        prediction: toggleAutocomplete,
        suggestions: toggleSuggestions,
        suggestionsManual: toggleSuggestionsManual,
        voice: toggleVoiceRefine,
        openSettings: () => {
          openSettings();
          switchSettingsTab('model');
        }
      }
    });
  }

  function insertDateAtCursor() {
    const editor = getActiveEditor();
    const dateStr = getFormattedDateTime('standard');
    insertTextWithUndo(dateStr, editor);
    onEditorInput();
  }

  // opts.quiet: a routine note (an automatic save). It shows as usual, but while the status bar is dimmed for writing (Zen) it
  // does not bring the bar back to full opacity: that is what made the bar flash bright each time typing paused.
  function showMessage(msg, duration, opts) {
    statMessage.textContent = msg;
    statMessage.title = msg;
    if (opts && opts.quiet) statMessage.setAttribute('data-quiet', ''); else statMessage.removeAttribute('data-quiet');
    setTimeout(() => {
      if (statMessage.textContent === msg) {
        statMessage.textContent = '';
        statMessage.title = '';
        statMessage.removeAttribute('data-quiet');
      }
    }, duration || 2500);
  }
  // Exposed so slot_agent.js / jev_action.js can surface their own status toasts
  // (e.g. "no slot found" / "already running") through the same status-bar message
  // area, the same way getCharPixelCoords / getActiveEditorEl are shared.
  window.showMessage = showMessage;

  // A message that the Go side worded (it does not know the UI language: Japanese, or "日本語 (English)" in one string) in the UI
  // language where it is known (see go_text.js); anything else is shown as it came.
  function goErr(text) {
    const s = String(text == null ? '' : text);
    return window.GoText ? window.GoText.localize(s, (config.general && config.general.language) || 'en', t) : s;
  }

  // The notices that are said once, a few seconds after start-up (a newer version, agent definitions that need a look), share the one
  // status-bar line. Each waits for the one before it to run out instead of replacing it: a notice that is overwritten is never said
  // again. `onShown` runs when it is really on screen (that is when it counts as seen).
  let startupNoticeFreeAt = 0;
  function showStartupNotice(msg, duration, onShown) {
    const wait = startupNoticeFreeAt - Date.now();
    if (wait > 0) {
      setTimeout(() => showStartupNotice(msg, duration, onShown), wait + 50);
      return;
    }
    startupNoticeFreeAt = Date.now() + duration;
    showMessage(msg, duration);
    if (onShown) onShown();
  }

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
          mirrorEditorText(editorSecondary, editorEl);
          scheduleUpdateSecondaryLineNumbers();
        } else if (editor === editorSecondary && editorEl && editorEl.value !== editorSecondary.value) {
          mirrorEditorText(editorEl, editorSecondary);
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

    // Auto-save debouncing. Each tab has its own timer, so typing in another tab or in
    // the other pane cannot cancel a pending save of this one, and the tab being saved
    // is the one captured here, not whatever happens to be "active" 1.5s from now.
    armAutoSave(tab);

    // Save session state (unfiled buffer persistence)
    saveSessionDebounced();

    // Live preview in split mode, and in the full preview (Ctrl+P): a result that lands while it is open ({{ }} tasks write through
    // here) must not leave the "running" text on screen. Nobody types into the hidden editor, so this costs nothing otherwise.
    if (isSplitMode || isPreviewMode) {
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
    if (pendingImeRetype) { // the IME took the retyped keys: it owns the word now
      clearTimeout(pendingImeRetype.timer);
      pendingImeRetype = null;
    }
    clearGhostText();
    hideCursorAura(true);
    clearTimeout(autocompleteTimer);
  });
  editorEl.addEventListener('compositionend', (e) => {
    isComposing = false;
    offerEnglishRetype(e && e.data);
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
        mirrorEditorText(editorEl, editorSecondary);
        cachedLineCount = 0;
        scheduleUpdateLineNumbers();
        if (isPreviewMode) {
          renderPreview();
        }
      }
      scheduleUpdateSecondaryLineNumbers();
      scheduleUpdateStatusBar();
      triggerCursorAuraDebounced();

      // Auto-save debouncing for the secondary editor (the tab's own timer; see armAutoSave)
      armAutoSave(secTab);

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
      hasFiles: types.indexOf('Files') !== -1 && !!(cd && cd.files && cd.files.length),
      ocrEnabled: ocrOn,
      visionReady: isVisionConfigured(),
      htmlAsMarkdown: htmlAsMarkdown,
      structured: structured,
      editorOrigin: types.indexOf('vscode-editor-data') !== -1,
      canReadClipboard: !!(navigator.clipboard && navigator.clipboard.read)
    });

    if (action === 'insertFiles') {
      // handleDrop reads `.types` and `.files` of what it is given: a clipboard has both, like a drop's dataTransfer
      if (window.FileAnchor && typeof window.FileAnchor.handleDrop === 'function') {
        e.preventDefault();
        await window.FileAnchor.handleDrop({ dataTransfer: cd, preventDefault() {} }, editor);
      }
      return;
    }

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
      insertPastedText(markdown, editor, 'pasteHtmlConverted', true);
      return;
    }

    if (action === 'readClipboard') {
      // Chromium's "paste as plain text" event carries no picture and no text/html; the async
      // clipboard API still sees them. preventDefault must happen before the first await.
      const plain = cd ? cd.getData('text/plain') : '';
      e.preventDefault();
      const pasteTabId = getTabIdForEditor(editor); // the reads below can wait on a permission dialog: the note is fixed now
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
        await savePastedImageBlob(imageBlob, editor, 'pasteImageSaved', pasteTabId);
      } else if (markdown.trim()) {
        insertPastedText(markdown, editor, 'pasteHtmlConverted', true, pasteTabId);
      } else if (plain) {
        insertPastedText(plain.replace(/\r\n?/g, '\n'), editor, '', false, pasteTabId);
      } else if (readFailed) {
        showMessage(t('pasteClipboardUnreadable'), 5000);
      }
    }
  }

  // asBlock: Markdown made from a paste (a table, a heading, a picture link): kept apart from the words around the caret.
  // tabId: the note the paste was made into, fixed when it happened. An await in between (saving the picture, the clipboard's
  // permission dialog) leaves time to switch notes, and the shared textarea then shows another one: the text goes into that note
  // (through writeTabText, at the caret it had), never into whatever the editor shows now. The note closed meanwhile: nothing to do.
  function insertPastedText(text, editor, messageKey, asBlock, tabId) {
    const away = !!tabId && getTabIdForEditor(editor) !== tabId;
    if (away) {
      const tab = getTab(tabId);
      if (!tab) return;
      const content = getTabText(tabId) || '';
      const shown = editorForTab(tabId);
      let at = shown ? shown.selectionStart : tab.cursorPos;
      at = Math.max(0, Math.min(typeof at === 'number' ? at : content.length, content.length));
      if (asBlock && window.HtmlToMd && window.HtmlToMd.separateBlock) text = window.HtmlToMd.separateBlock(text, content.slice(0, at), content.slice(at));
      const lines = content.slice(0, at).split('\n');
      const col = lines[lines.length - 1].length + 1;
      writeTabText(tab, text, 'replace', { startLine: lines.length, startCol: col, endLine: lines.length, endCol: col });
      if (messageKey) showMessage(t(messageKey), 3000);
      return;
    }
    if (asBlock && window.HtmlToMd && window.HtmlToMd.separateBlock) {
      const value = editor.value;
      text = window.HtmlToMd.separateBlock(text, value.slice(0, editor.selectionStart), value.slice(editor.selectionEnd));
    }
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

  // pasteTabId: the note the picture was pasted into (default: the one `editor` shows now). It is read before the first await, so a
  // switch to another note while the file is being saved cannot send the link there; the picture's folder is that note's too.
  async function savePastedImageBlob(blob, editor, messageKey, pasteTabId) {
    const tabId = pasteTabId || getTabIdForEditor(editor);
    const noteDir = getNoteDir(getTab(tabId));
    try {
      const imgData = await convertBlobToBase64(blob);
      if (!(window.backend && window.backend.saveAsset)) {
        showMessage(t('fanchorImportUnavailable'), 3000);
        return;
      }
      const res = await window.backend.saveAsset(await noteDir, assetExtForMime(imgData.mimeType), imgData.base64);
      const target = (res && (res.relPath || res.fileUrl)) || '';
      if (!target) return;
      const safeTarget = window.FileAnchor && window.FileAnchor.encodeLinkTarget ? window.FileAnchor.encodeLinkTarget(target) : target;
      insertPastedText(`![image](${safeTarget})`, editor, messageKey || 'pasteImageSaved', true, tabId);
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
        // Shift+Tab: unindent current line (only the line itself is looked at: a line of blanks must not eat its line break)
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = val.indexOf('\n', lineStart);
        if (lineEnd === -1) lineEnd = val.length;
        const lineText = val.substring(lineStart, lineEnd);
        let count = 0;
        if (lineText.startsWith('    ')) count = 4;
        else if (lineText.startsWith('\t')) count = 1;
        else if (lineText.startsWith(' ')) count = Math.min(lineText.search(/\S|$/), 4);
        if (count > 0) {
          replaceRangeWithUndo(ed, lineStart, lineStart + count, '');
          ed.setSelectionRange(Math.max(lineStart, start - count), Math.max(lineStart, end - count));
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
      if (newBlock !== selectedBlock) replaceRangeWithUndo(ed, startLineStart, endLineEnd, newBlock);
      ed.setSelectionRange(startLineStart, startLineStart + newBlock.length);
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
  // body.zen-active dims the header and the status bar once you start typing, so the note is what you
  // look at. It used to fade back on a fixed 2.8 s timer after the last keystroke, so every short pause
  // (thinking, waiting for a suggestion to arrive) brought the chrome back and the next keystroke dimmed
  // it again: dark, normal, dark, normal — the opposite of helping you concentrate. It now stays on for
  // as long as a note editor is the focused element, and goes when focus leaves them (a click on the
  // header or a dialog, Settings, ...). Hovering the dimmed header / status bar still shows it at full
  // opacity by itself (CSS :hover) without ending the state.
  function triggerZenModeActive() {
    if (document.body.classList.contains('zen-mode')) return;
    document.body.classList.add('zen-active');
  }

  function isNoteEditorFocused() {
    const el = document.activeElement;
    return !!el && (el === editorEl || (!!editorSecondary && el === editorSecondary));
  }

  // The blur event fires before document.activeElement has moved, so look one tick later: moving from
  // one pane to the other (split view) then does not blink the dimming off and on.
  function endZenModeActiveIfEditorLost() {
    setTimeout(() => {
      if (!isNoteEditorFocused()) document.body.classList.remove('zen-active');
    }, 0);
  }
  editorEl.addEventListener('blur', endZenModeActiveIfEditorLost);
  if (editorSecondary) editorSecondary.addEventListener('blur', endZenModeActiveIfEditorLost);

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

  // Where a floating bar sits (docs/design/panel-template.md): 16px under the header, centred, 560px wide (all in the style sheet).
  // The one exception is a target near the top of the note: the bar then goes to the bottom edge so it never covers the text it is about.
  // Call with the bar already shown (its height is measured).
  function dockPanelBar(bar, editor, index) {
    if (!bar) return;
    bar.style.left = '';
    bar.style.top = '';
    bar.style.width = '';
    let bottom = false;
    try {
      if (editor && workspaceEl) {
        const coords = keepCoordsInView(getCharPixelCoords(index, editor), editor);
        const editorRect = editor.getBoundingClientRect();
        const workspaceRect = workspaceEl.getBoundingClientRect();
        const cursorY = (editorRect.top - workspaceRect.top) + (coords.top - editor.scrollTop);
        const lineHeight = Math.max(22, Math.round(currentFontSize * 1.6));
        const barBottom = 16 + (bar.offsetHeight || 74) + 8;
        bottom = cursorY < barBottom && cursorY + lineHeight > 0;
      }
    } catch (err) {
      console.warn('Failed to compute the target position for a panel bar:', err);
    }
    bar.classList.toggle('panel-dock-bottom', bottom);
  }

  // Ctrl+L / Ctrl+K: when focus leaves the bar (a click in the note, Tab away) it closes after a 0.4 s grace and a 0.2 s
  // fade, unless something was typed into it. Alt+Tab away does not count (panel_fade.js; docs/design/panel-template.md).
  const askBarFade = window.PanelFade && inlinePromptBar ? window.PanelFade.create(inlinePromptBar, {
    isOpen: isAskBarOpen,
    close: () => closeInlinePromptBar(),
    getValue: () => (inlinePromptInput ? inlinePromptInput.value : ''),
    isBusy: () => askErrorShown || askConsentShown,
    refocus: () => { if (inlinePromptInput) inlinePromptInput.focus(); }
  }) : null;

  // The editor showing a note, or null when the note is not on screen.
  function editorForTab(tabId) {
    const focused = getActiveEditor();
    if (getTabIdForEditor(focused) === tabId) return focused;
    if (tabId === activeTabId) return editorEl;
    if (isSplitMode && secondaryViewMode === 'editor' && tabId === secondaryTabId && editorSecondary) return editorSecondary;
    return null;
  }

  // ---- The bar's offsets and the note: the bar takes character offsets when it opens, the note can change before Enter ----

  // Where offset `off` of `oldText` is in `newText` when the two differ by one edit (typing, an answer landing): the text that
  // both start with and end with is found, what lies before the edit stays, what lies after it moves by the change in length.
  // -1 = the offset is inside the part that was changed.
  function offsetAfterEdit(oldText, newText, off) {
    if (oldText === newText) return off;
    const max = Math.min(oldText.length, newText.length);
    let head = 0;
    while (head < max && oldText.charCodeAt(head) === newText.charCodeAt(head)) head++;
    let tail = 0;
    while (tail < max - head && oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)) tail++;
    if (off <= head) return off;
    if (off >= oldText.length - tail) return off + (newText.length - oldText.length);
    return -1;
  }

  // The occurrence of `piece` in `text` nearest to `near` (-1: there is none).
  function nearestOccurrence(text, piece, near) {
    if (!piece) return -1;
    let best = -1;
    for (let at = text.indexOf(piece); at !== -1; at = text.indexOf(piece, at + 1)) {
      if (best === -1 || Math.abs(at - near) < Math.abs(best - near)) best = at;
      else if (at > near) break;
    }
    return best;
  }

  // [start, end) narrowed to the words inside it: what a rewrite replaces. The white space around them (the indentation of a list
  // item, the line break at the end of a selection) belongs to the note and stays where it is.
  function trimmedSpan(text, start, end) {
    const raw = text.substring(start, end);
    const lead = raw.length - raw.trimStart().length;
    const tail = raw.length - raw.trimEnd().length;
    if (lead + tail >= raw.length) return { start: start, end: start };
    return { start: start + lead, end: end - tail };
  }

  // Brings what the bar took when it opened (the target's offsets, where the answer goes) up to date with the note as it is now:
  // the target is found again by its own text, nearest to where it was. False when it is gone (the very text was edited): the
  // caller says so instead of writing the answer over whatever sits at the old offsets.
  function refreshAskContext(ctx, tab) {
    const editor = editorForTab(tab.id);
    const current = editor ? editor.value : (tab.content || '');
    const old = ctx.textAtOpen;
    if (typeof old !== 'string' || old === current) return true;
    const target = ctx.target;
    let caret = offsetAfterEdit(old, current, ctx.caret);
    if (caret < 0) caret = Math.min(ctx.caret, current.length);
    if (target.kind === 'note') {
      target.start = 0;
      target.end = current.length;
    } else if (target.kind === 'none') {
      target.start = caret;
      target.end = caret;
    } else {
      const raw = ctx.targetRaw || '';
      let near = offsetAfterEdit(old, current, target.start);
      if (near < 0) near = Math.min(target.start, current.length);
      const at = raw ? nearestOccurrence(current, raw, near) : near;
      if (at === -1) return false;
      target.start = at;
      target.end = at + raw.length;
    }
    ctx.caret = caret;
    ctx.insertPos = askInsertPos(current, target, caret);
    ctx.textAtOpen = current;
    return true;
  }

  // opts (all optional): { tabId, target: { text, start, end, kind? }, recordInstruction, onSubmit(instruction, ctx), mode }
  // Without onSubmit this is the quick ask: the answer lands below the target. With onSubmit the bar only collects
  // the instruction and hands it back (the caller writes the task line); ctx = { tabId, target, insertPos, recordInstruction }.
  // mode: 'rewrite' (Ctrl+K) replaces the target with the answer instead of inserting below it (see
  // executeInlinePromptQuery); it needs actual text to rewrite, so — unlike the default ask — it does not
  // fall back to the whole note or an empty line.
  function openInlinePromptBar(opts) {
    clearGhostText();
    if (!inlinePromptBar) return;
    const o = opts || {};
    const isRewrite = o.mode === 'rewrite';

    // The shortcut pressed again inside the open bar brings the caret back to it - unless the bar no longer matches what the person is
    // looking at: another note, another selection, or the other mode (Ctrl+K with the ask bar open). Then it opens again on the current
    // target; what was typed stays, and the banner of an earlier failure goes.
    let keptText = null;
    if (isAskBarOpen() && !o.tabId && !o.target && !o.onSubmit) {
      const held = currentInlinePromptContext;
      if (!held || held.onSubmit || !askBarOutdated(held, isRewrite ? 'rewrite' : 'ask')) {
        inlinePromptInput.focus();
        return;
      }
      keptText = inlinePromptInput.value;
    }

    const curTab = o.tabId ? getTab(o.tabId) : getActiveTab();
    if (!curTab) return;
    // Text typed into the command bar is not thrown away to make room (docs/design/panel-template.md: a panel with input stays open).
    if (cliBarHoldsText()) {
      showMessage(t('commandBarHasText'), 4000);
      if (cliFilterInput) cliFilterInput.focus();
      return;
    }
    // Without a model that can answer the bar still opens, with a way to fix that: a toast vanished and left nothing to click.
    const llmReady = isLlmConfigured(false);
    if (!llmReady && o.onSubmit) { isLlmConfigured(true); return; }

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

    if (isRewrite && (target.kind === 'note' || target.kind === 'none')) {
      showMessage(t('aiCorrectionNoText'), 3000);
      return;
    }

    currentInlinePromptContext = {
      tabId: curTab.id,
      target: target,
      insertPos: askInsertPos(text, target, end),
      // the note and the caret as they were now: executeInlinePromptQuery re-finds the target if the note changed before Enter
      textAtOpen: text,
      targetRaw: text.substring(target.start, target.end),
      caret: end,
      // where the note's own selection was: a later press of the shortcut that finds it elsewhere means a new target (askBarOutdated)
      seenStart: start,
      seenEnd: end,
      recordInstruction: !!o.recordInstruction,
      onSubmit: typeof o.onSubmit === 'function' ? o.onSubmit : null,
      mode: isRewrite ? 'rewrite' : 'ask'
    };

    // Both bars float at the caret: an idle command bar makes room (one with text in it was dealt with above), a running one is left alone.
    if (cliFilterBar && !cliFilterBar.classList.contains('hidden') && !isCliFilterRunning && !isAiCliGenerating) {
      closeCliFilterBar();
    }

    if (askBarFade) askBarFade.reset();
    inlinePromptBar.classList.remove('hidden');
    inlinePromptBar.classList.toggle('inline-prompt-rewrite', isRewrite);
    if (inlinePromptBadge) inlinePromptBadge.textContent = t(isRewrite ? 'badgeRewrite' : 'badgeAsk');
    setInlinePromptSetupState(!llmReady);
    setInlinePromptChoiceState(llmReady && aiChoiceNeeded());
    setInlinePromptError(null);
    setInlinePromptConsent(false);
    // The instruction typed before the bar was left for Settings (and the model fixed there) comes back once, for the same note and mode.
    const draft = askDraft;
    askDraft = null;
    const draftFits = !!draft && !o.onSubmit && !o.target && draft.tabId === curTab.id && draft.mode === (isRewrite ? 'rewrite' : 'ask') &&
      Date.now() - draft.at < ASK_DRAFT_MS;
    inlinePromptInput.value = keptText !== null ? keptText : (draftFits ? draft.text : '');
    if (inlinePromptInput.value && askBarFade && askBarFade.markTyped) askBarFade.markTyped(); // text that is back counts as typed
    inlinePromptInput.placeholder = t(isRewrite ? 'rewritePlaceholder' : (o.recordInstruction ? 'askPlaceholderRecord' : 'inlinePromptPlaceholder'));
    if (inlinePromptTarget) {
      inlinePromptTarget.textContent = askTargetLabel(target);
      inlinePromptTarget.title = target.text.length > 300 ? target.text.substring(0, 300) + '...' : target.text;
    }
    if (inlinePromptHint) inlinePromptHint.textContent = t(isRewrite ? 'rewriteKeysHint' : (o.recordInstruction ? 'askRecordHint' : 'askKeysHint'));
    // Where the text goes. A bar that only collects a task instruction (onSubmit) does not know yet: the task decides.
    updateAskDestination(llmReady && !o.onSubmit);

    // Every panel opens in the same place (top centre, 560px); it moves to the bottom edge only when the target would sit under it.
    dockPanelBar(inlinePromptBar, editor, (target.kind === 'selection' || o.target) ? target.end : start);
    if (!o.quiet) inlinePromptInput.focus(); // quiet: the bar follows the person to another note without taking the focus from it
  }

  // True when the open bar's target is no longer the one a fresh open would take: another note is in the pane the person works in, the
  // shortcut asks for the other mode, or the note's selection is not where it was when the bar opened.
  function askBarOutdated(held, mode) {
    const tab = getActiveTab();
    if (!tab || held.tabId !== tab.id || held.mode !== mode) return true;
    const editor = editorForTab(tab.id);
    return !!editor && (editor.selectionStart !== held.seenStart || editor.selectionEnd !== held.seenEnd);
  }

  // Another note was brought into the pane the person works in: the open bar follows it (what was typed stays) instead of going on
  // about a note that is out of sight - Enter would send the old note's text and put the answer into a note nobody is looking at.
  // Called from selectTab / selectSecondaryTab; with no bar open it is one test.
  function followAskBarToActiveTab() {
    const held = currentInlinePromptContext;
    if (!isAskBarOpen() || !held || held.onSubmit) return;
    const tab = getActiveTab();
    if (!tab || tab.id === held.tabId) return;
    openInlinePromptBar({ mode: held.mode === 'rewrite' ? 'rewrite' : undefined, quiet: true });
    // nothing to ask about in this note (a rewrite needs text): the old bar must not stay on
    if (currentInlinePromptContext === held) closeInlinePromptBar();
  }

  // The bar's text stays when it is left for Settings: it was typed for a note, and the way back is usually the same shortcut.
  const ASK_DRAFT_MS = 10 * 60 * 1000;
  let askDraft = null;
  function closeAskBarForSettings() {
    const held = currentInlinePromptContext;
    const typed = inlinePromptInput ? inlinePromptInput.value : '';
    closeInlinePromptBar();
    askDraft = (held && !held.onSubmit && typed.trim()) ? { tabId: held.tabId, mode: held.mode, text: typed, at: Date.now() } : null;
  }

  // A ready-made prompt from the palette: put in the input and counted as typed, so the bar does not fade away at the first click in
  // the note (panel_fade.js only counts input events, and a value set by the page raises none).
  function openAskBarWithPreset(text) {
    openInlinePromptBar();
    if (!inlinePromptInput || !isAskBarOpen()) return;
    inlinePromptInput.value = text;
    if (askBarFade && askBarFade.markTyped) askBarFade.markTyped();
  }

  // True when the command bar is open with text in it that a close would lose (not a running or generating one: it is left alone).
  function cliBarHoldsText() {
    if (!cliFilterBar || cliFilterBar.classList.contains('hidden') || isCliFilterRunning || isAiCliGenerating) return false;
    if (cliBarFade && typeof cliBarFade.isTyped === 'function') return cliBarFade.isTyped();
    return !!(cliFilterInput && String(cliFilterInput.value || '').trim());
  }

  // The same for the ask / rewrite bar: typed text, a failure banner with its Retry, or the open question about a cloud host.
  function askBarHoldsText() {
    if (!isAskBarOpen()) return false;
    if (askErrorShown || askConsentShown) return true;
    if (askBarFade && typeof askBarFade.isTyped === 'function') return askBarFade.isTyped();
    return !!(inlinePromptInput && String(inlinePromptInput.value || '').trim());
  }

  // ---- Where the ask / rewrite text goes, and the one-time question for a cloud host (UX review I3) ----
  // The bar's context row says "-> Local Ollama (model)" or "-> model (cloud)". The first request to a cloud host asks once, in the bar;
  // general.cloudConsent keeps the answer per host ({ "host": "date allowed" }). Both read config.text, the model the ask and rewrite
  // bars use. A local model is never asked. Nothing here runs until the bar opens.

  // { kind: 'local' | 'cloud', host, model, ollama, consentKey } for config.text, or null when no model is set up (the setup banner
  // shows then). consentKey is what an answer is stored under: the host for https, "http://host" for plain http, so allowing
  // https://host never allows http://host (the key and the text would then travel unencrypted). A key without a scheme, which
  // is what every earlier answer was stored under, therefore stays an https answer; nothing is widened.
  function askDestination() {
    const cfg = config.text || {};
    const baseUrl = String(cfg.baseUrl || '').trim();
    const model = String(cfg.model || '').trim();
    if (!baseUrl || !model || !window.LlmError) return null;
    const host = window.LlmError.hostOf(baseUrl);
    const local = window.LlmError.isLocal(baseUrl);
    const consentKey = /^http:\/\//i.test(baseUrl) ? 'http://' + host : host;
    return { kind: local ? 'local' : 'cloud', host: host, model: model, ollama: local && /:11434$/.test(host), consentKey: consentKey };
  }

  function cloudConsentMap() {
    const c = config.general && config.general.cloudConsent;
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  }

  function cloudConsentGiven(host) {
    const c = cloudConsentMap();
    return Object.prototype.hasOwnProperty.call(c, host) && !!c[host];
  }

  // An older build keyed the answer on the URL's whole authority, "user:password@host". A key with an @ is never matched (the host
  // is credential-free now), never listed, and dropped the next time an answer is saved, so the password does not stay on show.
  function cloudConsentHosts() {
    const c = cloudConsentMap();
    return Object.keys(c).filter((h) => !!c[h] && h.indexOf('@') === -1).sort();
  }

  function rememberCloudConsent(host) {
    if (!config.general) config.general = {};
    const old = cloudConsentMap();
    const c = {};
    Object.keys(old).forEach((h) => { if (h.indexOf('@') === -1) c[h] = old[h]; });
    c[host] = new Date().toISOString().slice(0, 10);
    config.general.cloudConsent = c;
    savePersistentConfig();
  }

  // True when the next ask / rewrite would leave for a cloud host the person has not allowed yet.
  function needsCloudConsent() {
    const dest = askDestination();
    return !!dest && dest.kind === 'cloud' && !cloudConsentGiven(dest.consentKey);
  }

  // show: false hides the line (no model set up, or the bar only collects a task instruction and the destination is decided later).
  function updateAskDestination(show) {
    const dest = show ? askDestination() : null;
    if (inlinePromptDest) inlinePromptDest.classList.toggle('hidden', !dest);
    if (!dest || !inlinePromptDest) return;
    inlinePromptDest.setAttribute('data-kind', dest.kind);
    if (inlinePromptDestText) {
      inlinePromptDestText.textContent = t(dest.kind === 'cloud' ? 'askDestCloud' : (dest.ollama ? 'askDestLocalOllama' : 'askDestLocalServer'), { model: dest.model });
    }
    inlinePromptDest.title = t(dest.kind === 'cloud' ? 'askDestTitleCloud' : 'askDestTitleLocal', { host: dest.host });
  }

  let askConsentShown = false;
  let askConsentShownAt = 0;

  function setInlinePromptConsent(on) {
    askConsentShown = !!on;
    if (inlinePromptConsent) inlinePromptConsent.classList.toggle('hidden', !on);
    if (on) {
      const dest = askDestination();
      if (inlinePromptConsentText) inlinePromptConsentText.textContent = t('askConsentText', { host: dest ? dest.host : '' });
      askConsentShownAt = Date.now();
    }
  }

  function allowCloudConsent(evt) {
    // An Enter still held down from the request that raised the question must not answer it (a key press has detail 0).
    if (evt && evt.detail === 0 && Date.now() - askConsentShownAt < 350) return;
    const dest = askDestination();
    if (dest && dest.kind === 'cloud') rememberCloudConsent(dest.consentKey);
    setInlinePromptConsent(false);
    executeInlinePromptQuery();
  }

  function declineCloudConsent() {
    setInlinePromptConsent(false);
    if (inlinePromptInput) inlinePromptInput.focus();
  }

  // Settings > General: the hosts that were allowed, with a button to forget them all. Hidden while there are none.
  function renderCloudConsentRow() {
    const row = document.getElementById('cfg-cloud-consent-row');
    const list = document.getElementById('cfg-cloud-consent-hosts');
    if (!row || !list) return;
    const hosts = cloudConsentHosts();
    row.classList.toggle('hidden', hosts.length === 0);
    list.textContent = hosts.join(', ');
  }

  function setInlinePromptSetupState(needed) {
    if (inlinePromptSetup) inlinePromptSetup.classList.toggle('hidden', !needed);
    if (btnInlinePromptSend) btnInlinePromptSend.disabled = !!needed;
  }

  // The one-time model choice (first_run.js; docs/design/first-run.md, UX review A2): the first time the bar opens with the untouched
  // default model (local Ollama, qwen2.5) and no choice made yet, it offers: set up a local model, use a cloud key, or later. Once
  // general.aiChoiceMade is set this is one flag test per open.
  function aiChoiceNeeded() {
    return !!(window.FirstRun && window.FirstRun.shouldOfferAiChoice(config.general, config.text));
  }

  function setInlinePromptChoiceState(on) {
    if (inlinePromptChoice) inlinePromptChoice.classList.toggle('hidden', !on);
  }

  // Any answer to the choice - or going ahead with the default by running the bar - is remembered in general.aiChoiceMade.
  function markAiChoiceMade() {
    setInlinePromptChoiceState(false);
    if (!config.general || config.general.aiChoiceMade === true) return;
    config.general.aiChoiceMade = true;
    savePersistentConfig();
  }

  // Settings > AI Models with the part the person chose in view: the card that installs a local model ('local'), or the Text model
  // fields - URL, name and key - ('cloud': the key gets the focus; 'text': the first field, for "no model is set up yet", where
  // nothing says which kind of model it will be). Sections the compact view folded are opened first.
  function openAiModelsSettings(part) {
    closeAskBarForSettings();
    openSettings();
    switchSettingsTab('model');
    const cloud = part === 'cloud' || part === 'text';
    const anchor = document.getElementById(cloud ? 'cfg-base-url' : 'local-ai-card');
    if (anchor) {
      for (let n = anchor; n; n = n.parentElement) {
        if (n.tagName === 'DETAILS') n.open = true;
      }
      const block = cloud && anchor.parentElement ? anchor.parentElement : anchor;
      if (typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: cloud ? 'start' : 'nearest' });
    }
    // openSettings() moves focus to its first tab after 50 ms; the field the person asked for gets it after that.
    setTimeout(() => {
      const field = document.getElementById(part === 'text' ? 'cfg-base-url' : cloud ? 'cfg-api-key' : 'btn-setup-ollama');
      if (field) field.focus({ preventScroll: true });
    }, 80);
  }

  // What went wrong with an AI request, in words: { kind, summary, detail }. The raw line (Japanese, multi-line JSON at times)
  // is only the detail.
  // cfg: the model the request went to (config.text unless it was the image reader's).
  function describeLlmFailure(errorText, cfg) {
    // The model answered, with nothing: not a connection or setup problem, so it has no kind of its own to sort into.
    if (errorText === t('llmEmptyAnswer')) return { kind: 'empty', summary: errorText, detail: errorText };
    const info = window.LlmError ? window.LlmError.classify(errorText) : { kind: 'other', status: null };
    const model = cfg || config.text;
    const baseUrl = (model && model.baseUrl) || '';
    const local = window.LlmError ? window.LlmError.isLocal(baseUrl) : true;
    const keys = {
      conn: local ? 'llmErrConnLocal' : 'llmErrConnCloud',
      auth: 'llmErrAuth',
      model: 'llmErrModel',
      timeout: 'llmErrTimeout',
      rate: 'llmErrRate',
      server: 'llmErrServer',
      other: 'llmErrOther'
    };
    const target = (window.LlmError ? window.LlmError.hostOf(baseUrl) : baseUrl) || 'localhost:11434';
    return {
      kind: info.kind,
      summary: t(keys[info.kind] || 'llmErrOther', { target: target, model: (model && model.model) || '', status: info.status || '' }),
      detail: window.LlmError ? window.LlmError.oneLine(redactLlmSecrets(errorText), 300) : String(errorText || '')
    };
  }

  let askErrorShown = false;
  function setInlinePromptError(failure) {
    askErrorShown = !!failure;
    if (!inlinePromptError) return;
    inlinePromptError.classList.toggle('hidden', !failure);
    if (failure) {
      setInlinePromptChoiceState(false); // a failure is shown alone, never next to the one-time choice
      if (inlinePromptErrorText) inlinePromptErrorText.textContent = failure.summary;
      if (inlinePromptErrorDetail) inlinePromptErrorDetail.textContent = failure.detail;
      if (inlinePromptErrorDetails) inlinePromptErrorDetails.open = false;
    }
  }

  // A failed ask / rewrite: the note is already back to how it was. Reopen the bar on the same target with the same
  // instruction so Retry is one press; when the person has moved on (another note, or a new bar is open) say it in a toast.
  // The toast for a failure that cannot reopen the bar (another bar is open, or another note is in front). It says what was asked: the
  // second failure in a row, or one that comes while something else is typed, would otherwise be a message about nobody's request.
  function askFailureToast(f, failure) {
    const what = String(f.instruction || (f.target && f.target.text) || '').replace(/\s+/g, ' ').trim();
    if (!what) return failure.summary;
    return t('askFailedNamed', { request: what.length > 40 ? what.substring(0, 40) + '...' : what, summary: failure.summary });
  }

  function showAskFailure(f) {
    const failure = describeLlmFailure(f.errorText);
    // "The note the person is in" is the one in the focused pane: with the right pane focused, that is not activeTabId (the left one).
    if (f.tabId !== getTabIdForEditor(getActiveEditor()) || isAskBarOpen()) {
      showMessage(askFailureToast(f, failure), 7000);
      return true;
    }
    const editor = editorForTab(f.tabId);
    // The note may have moved on while the request waited (another answer landed above the target): the target is found again by its
    // own text, nearest to where it was, so Retry is about the same words. Gone (edited meanwhile): the bar opens on the caret as usual.
    let target = f.target;
    if (editor && target && editor.value.substring(target.start, target.end).trim() !== target.text) {
      const at = target.text ? nearestOccurrence(editor.value, target.text, target.start) : -1;
      target = at === -1 ? null : { kind: target.kind, text: target.text, start: at, end: at + target.text.length };
    }
    const sameText = !!(editor && target);
    openInlinePromptBar(sameText ? { tabId: f.tabId, target: target, mode: f.mode === 'rewrite' ? 'rewrite' : undefined } : {});
    if (!isAskBarOpen()) {
      showMessage(askFailureToast(f, failure), 7000);
      return true;
    }
    inlinePromptInput.value = f.instruction || '';
    setInlinePromptError(failure);
    inlinePromptInput.focus();
    const end = inlinePromptInput.value.length;
    try { inlinePromptInput.setSelectionRange(end, end); } catch (e) { /* not a text field in some tests */ }
    return true;
  }

  function closeInlinePromptBar() {
    if (askBarFade) askBarFade.cancel();
    setInlinePromptConsent(false);
    if (inlinePromptBar) inlinePromptBar.classList.add('hidden');
    currentInlinePromptContext = null;
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  function executeInlinePromptQuery() {
    if (!currentInlinePromptContext) return;

    const ctx = currentInlinePromptContext;
    if (!ctx.onSubmit && !isLlmConfigured(false)) {
      if (btnInlinePromptSetup) btnInlinePromptSetup.focus();
      return;
    }
    const instruction = inlinePromptInput.value.trim();
    const curTab = getTab(ctx.tabId);
    if (!curTab) {
      closeInlinePromptBar();
      return;
    }
    // The offsets the bar took when it opened are only good while the note is as it was then (typing, another answer landing).
    // A bar that only collects a task instruction hands them to its caller, which finds its text again by itself.
    if (!ctx.onSubmit && !refreshAskContext(ctx, curTab)) {
      closeInlinePromptBar();
      showMessage(t('askTargetMoved'), 5000);
      return;
    }
    // Going ahead with the default model answers the one-time choice too.
    if ((instruction || ctx.target.text) && aiChoiceNeeded()) markAiChoiceMade();

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

    // The first request to a cloud host asks once, here in the bar (general.cloudConsent); nothing is written into the note before the answer.
    if (needsCloudConsent()) {
      setInlinePromptConsent(true);
      if (btnInlinePromptConsentAllow) btnInlinePromptConsentAllow.focus();
      return;
    }

    // Rewrite mode (Ctrl+K): replace the target IN PLACE with the answer, the way Alt+C's
    // typo correction does, instead of inserting a new answer below it. openInlinePromptBar
    // already refused to open this mode without real text to rewrite (kind 'note'/'none').
    if (ctx.mode === 'rewrite') {
      closeInlinePromptBar();

      const editor = editorForTab(curTab.id);
      if (!editor) { // the tab isn't on screen: nothing to replace in place - and the person is told, not left with a bar that just closed
        showMessage(t('askTargetMoved'), 5000);
        return;
      }

      const hasJapanese = /[一-龠ぁ-んァ-ヶ]/.test(targetText);
      const isJa = hasJapanese || (config.general && config.general.language === 'ja');
      const effectiveInstruction = instruction || t('rewriteDefaultInstruction');
      const promptPayload = isJa
        ? `以下のテキストを、次の指示に沿って自然に書き直し、書き直した後のテキストのみを出力してください。挨拶・解説・前置き・引用符などは一切含めず、書き直した本文のみを直接出力してください。\n\n【指示】:\n${effectiveInstruction}\n\n【対象テキスト】:\n${targetText}`
        : `Rewrite the following text according to the instruction below. Output ONLY the rewritten text, with no greetings, explanations, or conversational filler.\n\n[Instruction]:\n${effectiveInstruction}\n\n[Text]:\n${targetText}`;

      const reqId = genReqId('rewrite_');
      const anchorId = `[${uniqueAnchorLabel(curTab.id, t('aiCorrectingAnchor'))}]`;
      // Only the words are replaced: the indentation before them and the line break after them stay in the note.
      const span = trimmedSpan(editor.value, ctx.target.start, ctx.target.end);
      const originalText = editor.value.substring(span.start, span.end);
      // The span holds another request's waiting text: it would go into this request's original, a failure would put it back
      // as plain text and the other answer would then have no place to land (it ended up at the end of the note).
      if (holdsWaitingAnchor(curTab.id, originalText)) {
        showMessage(t('rewriteOverWaiting'), 5000);
        return;
      }
      const baseline = { content: editor.value, dirty: !!curTab.isDirty };

      editor.setSelectionRange(span.start, span.end);
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
        originalText: originalText,
        baseline: baseline,
        persistRestore: originalText,
        isRewrite: true,
        onFailure: (errorText) => showAskFailure({
          tabId: curTab.id, mode: 'rewrite', target: { kind: ctx.target.kind, text: originalText, start: span.start, end: span.end }, instruction: instruction, errorText: errorText
        })
      });

      updateLLMIndicator();
      showMessage(t('rewriteInProgress'), 3000);

      if (window.backend && window.backend.queryLLMAsync) {
        window.backend.queryLLMAsync(reqId, promptPayload, JSON.stringify(config.text));
      } else {
        setTimeout(() => {
          window.__onLLMResult(reqId, targetText, '');
        }, 1500);
      }
      return;
    }

    let finalPrompt = targetText;
    if (instruction && targetText) {
      finalPrompt = `【指示】:\n${instruction}\n\n【対象テキスト】:\n${targetText}`;
    } else if (instruction) {
      finalPrompt = instruction;
    }

    const shortInstruction = instruction ? instruction.substring(0, 20) : (config.general && config.general.language === 'ja' ? '処理中' : 'Processing');
    const anchorLabel = `[${uniqueAnchorLabel(curTab.id, t('aiGeneratingAnchor', { instruction: shortInstruction }))}]`;

    // The answer sits below the target's last line; with no target (blank line) it takes the blank line itself.
    // The anchor carries the surrounding line breaks, so cancelling it restores the note exactly.
    const onOwnLine = ctx.target.kind === 'note' || ctx.target.kind === 'none';
    const anchorText = onOwnLine ? `${anchorLabel}\n` : `\n\n${anchorLabel}\n`;
    const wrapResult = onOwnLine ? (answer) => `${answer}\n` : (answer) => `\n\n${answer}\n`;
    const wrapError = (message) => wrapResult(`[${t('llmError')}${message}]`);

    const editor = editorForTab(curTab.id);
    const baseline = { content: editor ? editor.value : (curTab.content || ''), dirty: !!curTab.isDirty };
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
      wrapError: wrapError,
      restoreOnError: true,
      baseline: baseline,
      persistRestore: '',
      onFailure: (errorText) => showAskFailure({ tabId: curTab.id, mode: 'ask', target: ctx.target, instruction: instruction, errorText: errorText })
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
    const anchorId = `[${uniqueAnchorLabel(curTab.id, t('aiCorrectingAnchor'))}]`;
    // Only the words are replaced: the indentation before them and the line break after them stay in the note.
    const span = trimmedSpan(editor.value, start, end);
    const originalText = editor.value.substring(span.start, span.end);
    if (holdsWaitingAnchor(curTab.id, originalText)) { // see the rewrite in executeInlinePromptQuery
      showMessage(t('rewriteOverWaiting'), 5000);
      return;
    }
    const baseline = { content: editor.value, dirty: !!curTab.isDirty };

    editor.setSelectionRange(span.start, span.end);
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
      originalText: originalText,
      baseline: baseline,
      persistRestore: originalText,
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
    inlinePromptInput.addEventListener('input', () => { if (askErrorShown) setInlinePromptError(null); });
    inlinePromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (isImeComposingKey(e)) return;
        e.preventDefault();
        executeInlinePromptQuery();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        // One Esc closes one thing: the window's Esc chain would otherwise go on to the next open panel (and drop what is typed there).
        e.stopPropagation();
        closeInlinePromptBar();
      }
    });
  }
  if (btnInlinePromptSend) btnInlinePromptSend.onclick = executeInlinePromptQuery;
  if (btnInlinePromptSetup) {
    // Same as the choice's buttons: the field to fill in gets the focus (it used to stay on the General tab of a window showing AI Models)
    btnInlinePromptSetup.onclick = () => openAiModelsSettings('text');
  }
  if (btnInlinePromptRetry) btnInlinePromptRetry.onclick = executeInlinePromptQuery;
  if (btnInlinePromptConsentAllow) {
    btnInlinePromptConsentAllow.onclick = allowCloudConsent;
    // Enter held down from the request that raised the question keeps repeating into the focused button: a repeat never answers it.
    btnInlinePromptConsentAllow.addEventListener('keydown', (e) => { if (e.repeat) e.preventDefault(); });
  }
  if (btnInlinePromptConsentCancel) btnInlinePromptConsentCancel.onclick = declineCloudConsent;
  if (btnForgetCloudConsent) {
    btnForgetCloudConsent.onclick = () => {
      if (!config.general) return;
      config.general.cloudConsent = {};
      renderCloudConsentRow();
      showMessage(t('cloudConsentForgotten'), 4000);
    };
  }
  if (btnInlinePromptErrorSettings) {
    btnInlinePromptErrorSettings.onclick = () => {
      closeAskBarForSettings();
      openSettings();
      switchSettingsTab('model');
    };
  }
  if (btnInlinePromptClose) btnInlinePromptClose.onclick = closeInlinePromptBar;
  const btnAiChoiceLocal = document.getElementById('btn-ai-choice-local');
  const btnAiChoiceCloud = document.getElementById('btn-ai-choice-cloud');
  const btnAiChoiceLater = document.getElementById('btn-ai-choice-later');
  if (btnAiChoiceLocal) btnAiChoiceLocal.onclick = () => { markAiChoiceMade(); openAiModelsSettings('local'); };
  if (btnAiChoiceCloud) btnAiChoiceCloud.onclick = () => { markAiChoiceMade(); openAiModelsSettings('cloud'); };
  if (btnAiChoiceLater) btnAiChoiceLater.onclick = () => { markAiChoiceMade(); if (inlinePromptInput) inlinePromptInput.focus(); };

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

  // The fixed filters above are labelled "日本語 (English)". A Japanese UI keeps both halves; an English UI shows only the English one.
  function cliPresetLabel(label) {
    if (((config.general && config.general.language) || 'en') === 'ja') return label;
    const m = /\(([^()]*)\)\s*$/.exec(label);
    return m ? m[1] : label;
  }

  function cliPresetSnippets() {
    return CLI_PRESET_SNIPPETS.map((p) => ({ value: p.value, label: cliPresetLabel(p.label) }));
  }

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
        return mine.concat(cliPresetSnippets(), shared);
      } catch (e) {
        console.warn('Command presets from SlotSnippets failed:', e);
      }
    }
    return cliPresetSnippets();
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
  // What the badge says about the text now in the input: 'blocked' / 'warn' (the safety check) or 'error' (the run failed). The
  // verdict is about that text only, so the next edit takes it away.
  let cliBadgeVerdict = '';
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
        cliFilterBadge.style.color = 'var(--accent-label, #a6c26a)';
      } else if (isCliFilterRunning) {
        cliFilterBadge.innerHTML = '<span class="cli-spinner cli-spinner-sm"></span>' + (t('cliRunningShort') || 'Running...');
        cliFilterBadge.style.color = '#f0ad4e';
      } else if (cliBadgeVerdict) {
        cliFilterBadge.textContent = t({ blocked: 'cliBadgeBlocked', warn: 'cliBadgeWarn', error: 'cliBadgeError' }[cliBadgeVerdict]);
        cliFilterBadge.style.color = cliBadgeVerdict === 'warn' ? '#f0ad4e' : '#f26d6a';
      } else if (isAiCliMode) {
        cliFilterBadge.textContent = t('aiCliFilterBadge') || 'AI CLI';
        cliFilterBadge.style.color = 'var(--accent-label, #a6c26a)';
      } else {
        cliFilterBadge.textContent = t('cliFilterBadge') || 'CLI';
        cliFilterBadge.style.color = 'var(--accent-label, #a6c26a)';
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
        btnCliFilterSend.title = t('tipGenerateEnter');
        btnCliFilterSend.disabled = false;
      } else {
        btnCliFilterSend.textContent = t('btnRunCli') || 'Run';
        btnCliFilterSend.title = t('tipRunEnter');
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
    cliBadgeVerdict = '';
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
    dockPanelBar(cliFilterBar, editor, editor ? editor.selectionEnd : 0);
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

    // An ask / rewrite bar with text, a failure or a question in it stays (docs/design/panel-template.md); an empty one makes room.
    if (isAskBarOpen()) {
      if (askBarHoldsText()) {
        showMessage(t('askBarHasText'), 4000);
        inlinePromptInput.focus();
        return;
      }
      closeInlinePromptBar();
    }
    if (!findReplaceBar.classList.contains('hidden')) {
      closeFindBar();
    }

    cliBadgeVerdict = ''; // a bar that opens empty has nothing to say yet
    setCliMode(wantAi, true);
    if (cliFilterPreview) {
      cliFilterPreview.classList.add('hidden');
      cliFilterPreview.textContent = '';
    }
    if (cliBarFade) cliBarFade.reset();
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
      // Forget the request: the host still answers a cancelled command ("cancelled by user", exit 130), and that late answer must not
      // open an error tab or take the bar over (it may by then be running another command). cancelCommandTask does the same.
      if (window.__cliCallbacks) window.__cliCallbacks.delete(activeCliReqId);
      if (window.backend && window.backend.cancelCommandFilter) {
        try {
          window.backend.cancelCommandFilter(activeCliReqId);
        } catch (e) {}
      }
      showMessage(t('cliCancelled'), 2000);
    }
    resetCliFilterUI();
  }

  // Ctrl+E: same as the ask bar; a running or generating command keeps it open.
  const cliBarFade = window.PanelFade && cliFilterBar ? window.PanelFade.create(cliFilterBar, {
    isOpen: () => !cliFilterBar.classList.contains('hidden'),
    close: () => closeCliFilterBar(),
    getValue: () => (cliFilterInput ? cliFilterInput.value : ''),
    isBusy: () => isCliFilterRunning || isAiCliGenerating,
    refocus: () => { if (cliFilterInput && !cliFilterInput.disabled) cliFilterInput.focus(); }
  }) : null;

  function closeCliFilterBar() {
    if (cliBarFade) cliBarFade.cancel();
    if (isCliFilterRunning) {
      cancelActiveCliFilter();
    }
    // A command the AI is still writing is dropped as well. Left alone, the bar the person opens next would still say "Thinking...",
    // with its input disabled, and the answer that comes late would be put into it whatever they had typed meanwhile.
    if (isAiCliGenerating) {
      if (activeAiCliGenReqId && window.__aiCliGenCallbacks) window.__aiCliGenCallbacks.delete(activeAiCliGenReqId);
      resetCliFilterUI();
    }
    if (cliFilterBar) cliFilterBar.classList.add('hidden');
    if (cliFilterPreview) {
      cliFilterPreview.classList.add('hidden');
      cliFilterPreview.textContent = '';
    }
    const editor = getActiveEditor();
    if (editor) editor.focus();
  }

  // An API key belongs to the provider that issued it. A settings group with no key of its own may borrow another group's only
  // when that group points at the same host as `baseUrl`, so no key reaches a host its owner never chose (a Gemini key to a
  // self-hosted server, an OpenAI key to OpenRouter). groups: [{ baseUrl, apiKey }] in order of preference. '' when none
  // qualifies, so the caller's "key not set" message applies.
  function borrowedApiKey(baseUrl, groups) {
    const hostOf = (u) => (window.LlmError ? window.LlmError.hostOf(u) : String(u || '').trim().toLowerCase());
    const host = hostOf(baseUrl);
    for (const g of groups) {
      if (g && g.apiKey && hostOf(g.baseUrl) === host) return g.apiKey;
    }
    return '';
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

        const cliBaseUrl = (config.cli && config.cli.baseUrl) || config.text.baseUrl || 'http://localhost:11434';
        const effectiveCliConfig = {
          baseUrl: cliBaseUrl,
          model: (config.cli && config.cli.model) || config.text.model || 'qwen2.5:latest',
          // The text model's key goes along only while the command model talks to the same host as the text model.
          apiKey: (config.cli && config.cli.apiKey) || borrowedApiKey(cliBaseUrl, [{ baseUrl: config.text.baseUrl || 'http://localhost:11434', apiKey: config.text.apiKey }]),
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
        cliBadgeVerdict = 'blocked';
        setCliMode(false);
        showMessage(t('cliBlockedError', { reason: goErr(valResult.reason) }), 6000);
        if (cliFilterInput) {
          cliFilterInput.focus();
          cliFilterInput.scrollLeft = 0;
        }
        return;
      }

      // Switch back to normal CLI mode so user can inspect and press Enter to execute!
      cliBadgeVerdict = valResult.isWarning ? 'warn' : '';
      setCliMode(false);

      if (valResult.isWarning) {
        showMessage(goErr(valResult.reason), 5000);
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
    // Mark the rows the output went into (not the line break that starts them: it is skipped by the band).
    flashGhostDiff(editor, pos, pos + Math.max(0, editor.value.length - text.length));
    return true;
  }

  // Replaces [start, end) with a command's output as one undo step and marks the rows it went into.
  function replaceWithCliOutput(editor, start, end, output) {
    const before = editor.value.length;
    editor.setSelectionRange(start, end);
    insertTextWithUndo(output, editor);
    flashGhostDiff(editor, start, start + Math.max(0, editor.value.length - before + (end - start)));
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

    // Safety Validation Check. The in-flight flag goes up before the first await: an Enter pressed again while the check (or the
    // question it leads to) is still open would otherwise start the same command once more.
    cliBadgeVerdict = '';
    isCliFilterRunning = true;
    updateCliFilterBarModeUI();
    let mayRun = false;
    try {
      if (window.backend && window.backend.validateCliCommand) {
        let check = null;
        try {
          check = await window.backend.validateCliCommand(cmdStr);
        } catch (e) { /* handled below: no verdict */ }
        // A check that failed or said nothing proves nothing: ask as for a risky command instead of running it unchecked.
        // (The backend still refuses a forbidden command when it runs.)
        if (!check || typeof check !== 'object') check = { isWarning: true, reason: t('cliCheckFailed') };
        if (check.isBlocked) {
          showMessage(t('cliBlockedError', { reason: goErr(check.reason) }), 6000);
          cliBadgeVerdict = 'blocked';
          resetCliFilterUI();
          return;
        }
        if (check.isWarning) {
          // Same question as confirmCommand: Cancel is the default, so an Enter that is still held down cannot run the command.
          const proceed = await customConfirm(t('cliWarningConfirm', { reason: goErr(check.reason), cmd: cmdStr }), { okLabel: t('agentRiskRun'), multiline: true, safeDefault: true });
          if (!proceed) {
            showMessage(t('cliCancelled'), 2000);
            return;
          }
        }
      }
      mayRun = true;
    } finally {
      // Refused (or the question failed): the bar is usable again. A refusal that already reset it keeps its badge.
      if (!mayRun && isCliFilterRunning) resetCliFilterUI();
    }
    // Esc or the close button while the check was out: it already reset the bar, and nothing may run.
    if (!isCliFilterRunning) return;

    let editor = getActiveEditor();
    if (!editor) {
      resetCliFilterUI();
      return;
    }
    // The primary pane's textarea shows every note in turn (selectTab swaps its text), so this element cannot say whose text the
    // offsets below belong to. Remember the note; the output is only put into it while it is still on screen (see below).
    const originTabId = getTabIdForEditor(editor);

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

        cliBadgeVerdict = 'error';
        resetCliFilterUI();
        if (cliFilterBar) cliFilterBar.classList.remove('hidden');
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

      // The command may have run for a while. If another note was brought into that pane meanwhile, `editor` and the offsets read
      // before the run belong to a note that is not on screen: splicing at them would change whichever note is shown now. So
      // nothing goes into any note then; the output is in the result tab, which always opens in that case.
      editor = editorForTab(originTabId);
      const noteLeft = !editor;
      const openResultInNewTab = noteLeft || !config.cli || config.cli.openResultInNewTab !== false;

      if (openResultInNewTab) {
        // With text selected: the output goes below it (the selection stays) or over it, as the setting says
        if (isSelection && editor) {
          if (cliResultPlacement() === 'replace') {
            editor.focus();
            replaceWithCliOutput(editor, start, end, res.output);
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
        showMessage(t(noteLeft ? 'cliNoteLeft' : 'cliSuccessTabOpened'), noteLeft ? 6000 : 3500);
      } else {
        // Directly into the active editor: below the input (the default) or over it
        editor.focus();
        let unchanged = false; // below the input, a copy of that same text is not added
        if (cliResultPlacement() === 'below' && val.trim() !== '') {
          unchanged = isCliOutputSameAsInput(inputContent, res.output);
          if (!unchanged) insertCliOutputBelow(editor, isSelection ? end : val.length, res.output);
        } else if (isSelection) {
          replaceWithCliOutput(editor, start, end, res.output);
        } else {
          if (val.trim() === '') {
            replaceWithCliOutput(editor, editor.selectionStart, editor.selectionEnd, res.output);
          } else {
            replaceWithCliOutput(editor, 0, editor.value.length, res.output);
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

      cliBadgeVerdict = 'error';
      resetCliFilterUI();
      if (cliFilterBar) cliFilterBar.classList.remove('hidden');
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
        e.stopPropagation(); // one Esc closes one panel (see the ask bar)
        closeCliFilterBar();
      } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !isImeComposingKey(e)) {
        e.preventDefault();
        toggleCommandBarMode();
      }
    });
    cliFilterInput.addEventListener('input', () => {
      updateCliFilterPreview();
      // The BLOCKED / WARN / ERROR badge judged the text that was there before this edit.
      if (cliBadgeVerdict) {
        cliBadgeVerdict = '';
        updateCliFilterBarModeUI();
      }
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

    // Ensure Gemini endpoint is used for image generation (do not inherit local vision baseUrl)
    let imageBaseUrl = (config.image && config.image.baseUrl) || '';
    if (!imageBaseUrl || imageBaseUrl.includes('localhost') || imageBaseUrl.includes('127.0.0.1') || imageBaseUrl.startsWith('http://')) {
      if (config.vision && config.vision.baseUrl && !config.vision.baseUrl.includes('localhost') && !config.vision.baseUrl.includes('127.0.0.1') && !config.vision.baseUrl.startsWith('http://')) {
        imageBaseUrl = config.vision.baseUrl;
      } else {
        imageBaseUrl = 'https://generativelanguage.googleapis.com';
      }
    }

    // Check Gemini API key (priority: image > vision > text). Another group's key is borrowed only while that group talks to
    // the same host as the image endpoint: it is sent there as ?key=, so a key of another provider must not be.
    const apiKey = (config.image && config.image.apiKey) || borrowedApiKey(imageBaseUrl, [
      { baseUrl: (config.vision && config.vision.baseUrl) || 'https://generativelanguage.googleapis.com', apiKey: config.vision && config.vision.apiKey },
      { baseUrl: (config.text && config.text.baseUrl) || 'http://localhost:11434', apiKey: config.text && config.text.apiKey }
    ]);
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
            showMessage(`${t('openError')}${goErr(e.message || e)}`, 4000);
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

  // The things a newcomer looks for first and the palette used to lack.
  function basicPaletteCommands() {
    const icon = (body) => '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
    return [
      {
        id: 'cmd_settings',
        title: t('cmdPaletteSettings'),
        desc: t('cmdPaletteSettingsDesc', { sc: isMac ? 'Cmd+,' : 'Ctrl+,' }),
        iconSvg: icon('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
        action: () => openSettings()
      },
      {
        id: 'cmd_shortcuts',
        title: t('cmdPaletteShortcuts'),
        desc: t('cmdPaletteShortcutsDesc'),
        iconSvg: icon('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
        action: () => { openSettings(); switchSettingsTab('shortcuts'); }
      },
      {
        // A newcomer looks for "model", "ollama", "api key", "cloud", "language", "theme", "update" here: each word is in a title or description
        id: 'cmd_ai_settings',
        title: t('cmdPaletteAiSetup'),
        desc: t('cmdPaletteAiSetupDesc'),
        iconSvg: icon('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>'),
        action: () => openAiModelsSettings('text')
      },
      {
        id: 'cmd_general_settings',
        title: t('cmdPaletteGeneralSettings'),
        desc: t('cmdPaletteGeneralSettingsDesc'),
        iconSvg: icon('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
        action: () => { openSettings(); switchSettingsTab('general'); }
      },
      {
        id: 'cmd_help',
        title: t('cmdPaletteHelp'),
        desc: t('cmdPaletteHelpDesc'),
        iconSvg: icon('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
        action: () => openHelpDocs()
      },
      {
        id: 'cmd_about',
        title: t('cmdPaletteAbout'),
        desc: t('cmdPaletteAboutDesc'),
        iconSvg: icon('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
        action: () => openAboutDialog()
      },
      {
        id: 'cmd_save',
        title: t('cmdPaletteSave'),
        desc: paletteDescWithShortcut('cmdPaletteSaveDesc', 'saveFile'),
        iconSvg: icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
        action: () => saveActiveFile(false)
      },
      {
        id: 'cmd_save_as',
        title: t('cmdPaletteSaveAs'),
        desc: paletteDescWithShortcut('cmdPaletteSaveAsDesc', 'saveFileAs'),
        iconSvg: icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
        action: () => saveActiveFile(true)
      },
      {
        id: 'cmd_find',
        title: t('cmdPaletteFind'),
        desc: paletteDescWithShortcut('cmdPaletteFindDesc', 'find'),
        iconSvg: icon('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
        action: () => openFindBar(false)
      },
      {
        id: 'cmd_replace',
        title: t('cmdPaletteReplace'),
        desc: paletteDescWithShortcut('cmdPaletteReplaceDesc', 'replace'),
        iconSvg: icon('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>'),
        action: () => openFindBar(true)
      },
      {
        id: 'cmd_preview',
        title: t('cmdPalettePreview'),
        desc: paletteDescWithShortcut('cmdPalettePreviewDesc', 'togglePreview'),
        iconSvg: icon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
        action: () => togglePreview()
      },
      {
        id: 'cmd_preview_side',
        title: t('cmdPalettePreviewSide'),
        desc: t('cmdPalettePreviewSideDesc', { sc: getShortcutDisplay('previewToSide', isMac ? 'Cmd+Option+V' : 'Ctrl+Alt+V') }),
        iconSvg: icon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
        action: () => openPreviewToSide()
      },
      {
        id: 'cmd_search_scraps',
        title: t('cmdPaletteSearchNotes'),
        desc: paletteDescWithShortcut('cmdPaletteSearchNotesDesc', 'searchScraps'),
        iconSvg: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11" cy="14" r="3"/><line x1="13.5" y1="16.5" x2="16" y2="19"/>'),
        action: () => openScrapsSearchModal()
      },
      {
        id: 'cmd_all_tabs',
        title: t('cmdPaletteAllTabs'),
        desc: t('cmdPaletteAllTabsDesc'),
        iconSvg: icon('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
        action: () => { const overflow = getTabOverflow(); if (overflow) overflow.openList(); }
      }
    ];
  }

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
      ...basicPaletteCommands(),
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
      ...resultBlockPaletteCommands(),
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
        action: () => openAskBarWithPreset(t('cmdPalettePipePolishPrompt'))
      },
      {
        id: 'cmd_pipe_bullets',
        title: t('cmdPalettePipeBullets'),
        desc: t('cmdPalettePipeBulletsDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        action: () => openAskBarWithPreset(t('cmdPalettePipeBulletsPrompt'))
      },
      {
        id: 'cmd_pipe_tasks',
        title: t('cmdPalettePipeTasks'),
        desc: t('cmdPalettePipeTasksDesc'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
        action: () => openAskBarWithPreset(t('cmdPalettePipeTasksPrompt'))
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
        id: 'cmd_comment_toggle',
        title: t('cmdPaletteCommentToggle'),
        desc: paletteDescWithShortcut('cmdPaletteCommentToggleDesc', 'commentToggle'),
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>',
        action: () => executeToggleComment(getActiveEditor())
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
        iconSvg: '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
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
            showMessage(`${t('openError')}${goErr(e.message || e)}`, 4000);
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
    // Back to the pane the person was working in: the palette's command runs right after this and acts on the focused pane
    // (focusing #editor would make the left pane the working one and send the command to the wrong note).
    (getActiveEditor() || editorEl).focus();
  }
  if (quickPickModal) {
    quickPickModal.addEventListener('mousedown', (e) => {
      if (e.target === quickPickModal) closeQuickPick();
    });
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
        if (isImeComposingKey(e)) return; // the Enter that confirms a conversion must not run the first command
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
        e.stopPropagation(); // one Esc closes one panel (see the ask bar)
        closeQuickPick();
      }
    });
  }

  // --- Find & Replace & Navigation ---
  let findMatches = [];
  let findSearchedText = null; // the text findMatches was computed from (its offsets mean nothing for any other text)
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

  // True in a huge note when the caret's own line is longer than the window: that line is always measured whole, so locating the
  // caret on a 10 MB line took 0.5 to 1.4 s at every pause in typing. The cursor aura (a soft glow) is not worth that and is skipped.
  function caretLineTooLong(text, caret) {
    try {
      return text.length > CHAR_MIRROR_FULL_LIMIT && caret - charMirrorWindowStart(text, caret, 0, CHAR_MIRROR_WINDOW_CHARS) > CHAR_MIRROR_WINDOW_CHARS;
    } catch (e) {
      return false; // asked before the constants above exist (a page that runs timers while the script is still loading)
    }
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
    if (caretLineTooLong(editor.value, cursorPos)) {
      hideCursorAura(true);
      return;
    }
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

  // What Ctrl+F / Ctrl+Shift+F put in their search box (scrap_quote.js): the selection - in the editor or
  // in a preview pane - or, for the scrap search only (allowWord), the word just before the caret.
  // Call it before focus moves into the search box.
  function getSearchSeed(allowWord) {
    const active = document.activeElement;
    const inEditor = active === editorEl || (!!editorSecondary && active === editorSecondary);
    if (!inEditor && window.getSelection) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.anchorNode) {
        const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        const inPreview = !!node && ((previewPane && previewPane.contains(node)) ||
          (secondaryPreviewPane && secondaryPreviewPane.contains(node)));
        if (inPreview) {
          // Selection.toString() is empty when the page has lost focus; the range's own text is not.
          return window.ScrapQuote.seedFromSelection(sel.toString() || (sel.rangeCount ? sel.getRangeAt(0).toString() : ''));
        }
      }
    }
    const editor = inEditor ? active : getActiveEditor();
    // A hidden editor (the preview covers it) keeps a stale selection and caret: they are not what the user sees.
    if (!editor || editor.getClientRects().length === 0) return '';
    return window.ScrapQuote.searchSeed(editor.value, editor.selectionStart, editor.selectionEnd, allowWord);
  }

  function openFindBar(showReplace = false) {
    const seed = getSearchSeed(false);
    const wasOpen = !findReplaceBar.classList.contains('hidden');
    findReplaceBar.classList.remove('hidden');
    if (showReplace) {
      replaceRow.classList.remove('hidden');
      btnToggleReplace.textContent = '▼';
    }
    if (seed && !(wasOpen && findInput.value)) findInput.value = seed;
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
    hideFindMark();
    findReplaceBar.classList.add('hidden');
    findMatches = [];
    findSearchedText = null;
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

  // The match list is offsets into the text as it was when the search ran. Typing, pasting, undo or an AI edit changes that text
  // without running a search, and selecting or replacing at the old offsets would hit unrelated characters. So whatever acts on
  // the list first searches again when the text is no longer the one the list was made from (comparing two strings costs far less
  // than a search). A list that is still good is left alone, so the match the person navigated to stays current.
  function ensureFreshMatches() {
    flushPendingSearch();
    const editor = getActiveEditor();
    const text = editor ? editor.value : '';
    if (findMatches.length === 0 || text !== findSearchedText) searchMatches();
  }

  // The one place that turns the Find toggles into a RegExp (the search and Replace all must never disagree). g: every match.
  // m: ^ and $ are the start and end of a LINE, as in every editor (without it ^## found nothing past the first line). u: an emoji
  // is one character ([😀] and . must not see its two halves); tried first and dropped when the pattern is not valid with it (a
  // stray \- or { is a syntax error in unicode mode, fine without). No lookbehind: WKWebView before 16.4 does not know it.
  function buildFindRegex(query, useRegex, caseSensitive) {
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = 'gm' + (caseSensitive ? '' : 'i');
    try {
      return new RegExp(pattern, flags + 'u');
    } catch (e) {
      return new RegExp(pattern, flags);
    }
  }

  // "Whole word" is not \b, which only knows the ASCII word characters (a Japanese word or an emoji never had a boundary, so the
  // switch matched nothing there). An edge of the match is a word edge unless a letter, digit or _ (any script; a combining mark goes
  // with its letter) sits on both sides of it; an edge that is itself none of those (an emoji, a dot) always is one.
  // (Code points, with the ASCII ones decided without a regex: this runs once per match, and a note can have millions.)
  function isWholeWordMatch(text, start, end) {
    if (end <= start) return false;
    const isWord = (cp) => {
      if (cp === undefined) return false;
      if (cp < 128) return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) || (cp >= 48 && cp <= 57) || cp === 95;
      return /[\p{L}\p{N}\p{M}_]/u.test(String.fromCodePoint(cp));
    };
    const endingAt = (i) => { // the code point that ends just before index i
      if (i <= 0) return undefined;
      const unit = text.charCodeAt(i - 1);
      return (unit & 0xFC00) === 0xDC00 && i >= 2 && (text.charCodeAt(i - 2) & 0xFC00) === 0xD800 ? text.codePointAt(i - 2) : unit;
    };
    return !(isWord(endingAt(start)) && isWord(text.codePointAt(start))) && !(isWord(endingAt(end)) && isWord(text.codePointAt(end)));
  }

  // Calls onMatch(m) with each match of regex in text (m is the exec result), leaving out those that are not whole words when asked.
  // lastIndex moves on by a whole character: in unicode mode one that points into an emoji is taken back to its start, which
  // would find the same match for ever.
  function scanFindMatches(text, regex, wholeWord, onMatch) {
    const stepPast = (i) => ((text.charCodeAt(i) & 0xFC00) === 0xD800 && (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00 ? i + 2 : i + 1);
    let m;
    while ((m = regex.exec(text)) !== null) {
      if (wholeWord && !isWholeWordMatch(text, m.index, m.index + m[0].length)) {
        regex.lastIndex = stepPast(m.index);
        continue;
      }
      onMatch(m);
      if (m[0].length === 0) regex.lastIndex = stepPast(m.index);
    }
  }

  // What Replace all (whole-word, regex mode) puts in for one match, as String.replace would read the text: $$ $& $` $' $1..$99 $<name>.
  function expandReplacement(tpl, m, text) {
    return tpl.replace(/\$(\$|&|`|'|\d\d?|<[^>]*>)/g, (all, tok) => {
      if (tok === '$') return '$';
      if (tok === '&') return m[0];
      if (tok === '`') return text.substring(0, m.index);
      if (tok === "'") return text.substring(m.index + m[0].length);
      if (tok[0] === '<') return m.groups ? (m.groups[tok.slice(1, -1)] || '') : all;
      const captures = m.length - 1;
      const two = parseInt(tok, 10);
      if (tok.length === 2 && two >= 1 && two <= captures) return m[two] || '';
      const one = parseInt(tok[0], 10);
      return one >= 1 && one <= captures ? (m[one] || '') + tok.slice(1) : all;
    });
  }

  function searchMatches() {
    cancelPendingSearch();
    hideFindMark(); // a new search: the box drawn for the old current match no longer says anything
    const query = findInput.value;
    if (!query) {
      findMatches = [];
      findSearchedText = null;
      currentMatchIndex = -1;
      findCount.textContent = '0/0';
      return;
    }

    const editor = getActiveEditor();
    const text = editor ? editor.value : '';
    findMatches = [];
    findSearchedText = text;

    try {
      const regex = buildFindRegex(query, isRegex, isCaseSensitive);
      scanFindMatches(text, regex, isWholeWord, (match) => {
        findMatches.push({ start: match.index, end: match.index + match[0].length });
      });
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
    // Asked from inside the find bar (Enter in the box, the arrow buttons, Replace): the focus stays there, so the next Enter goes
    // on to the next match. Moving it into the note made the second Enter replace the selected match with a line break (and
    // Shift+Enter insert a blank line). The note paints its selection only while it is focused, so the match is drawn behind the
    // text instead (showFindMark). From anywhere else (F3 in the note) the note takes the focus, as before.
    const prevFocus = document.activeElement;
    const keepFocus = isFocusInFindBar();
    if (!keepFocus) editor.focus();
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
    revealCaretInHugeNote(editor); // (focuses the note for a moment in a huge note)
    if (keepFocus) {
      if (prevFocus && document.activeElement !== prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      showFindMark(editor, match.start, match.end);
    }

    findCount.textContent = `${currentMatchIndex + 1}/${findMatches.length}`;
  }

  function isFocusInFindBar() {
    const active = document.activeElement;
    return !!(active && findReplaceBar && findReplaceBar.contains(active));
  }

  // The boxes for a match that runs from coordinate c0 (its first character) to c1 (just after its last one): one box when both are
  // on the same row, otherwise the tail of the first row, the whole rows between, and the head of the last row (left out when empty).
  function findMarkRects(c0, c1, lineHeight, padLeft, rightEdge, maxRows) {
    const rows = Math.max(1, Math.round((c1.top - c0.top) / lineHeight) + 1);
    if (rows === 1) return [{ top: c0.top, left: c0.left, width: Math.max(2, c1.left - c0.left), height: lineHeight }];
    const rects = [];
    for (let i = 0; i < Math.min(rows, maxRows); i++) {
      const left = i === 0 ? c0.left : padLeft;
      const right = i === rows - 1 ? c1.left : rightEdge;
      if (right - left >= 1) rects.push({ top: c0.top + i * lineHeight, left: left, width: right - left, height: lineHeight });
    }
    return rects;
  }

  // The current match while the focus is in the find bar: a textarea paints its selection only while it has the focus, and the
  // focus has to stay in the find box (see goToMatch), so the match is drawn as boxes behind the note's text instead (one per row;
  // a very long match is cut off after FIND_MARK_MAX_ROWS rows). Nothing exists until a match is shown from the find bar. It is
  // taken away by everything that could make it point at other text: typing, the note taking the focus (its own selection is
  // painted then), a new search, closing the bar, a resize, and any change of the marked text however it came about (a poll runs
  // only while the mark is shown). Not drawn in a huge note (over CHAR_MIRROR_FULL_LIMIT characters), whose row positions are only
  // estimated and whose measuring would cost more than the cue is worth: there the match is just selected.
  const FIND_MARK_MAX_ROWS = 60;
  let findMark = null; // { editor, layer, timer, onScroll, onHide } while shown

  function hideFindMark() {
    const m = findMark;
    if (!m) return;
    findMark = null;
    clearInterval(m.timer);
    m.editor.removeEventListener('scroll', m.onScroll);
    m.editor.removeEventListener('input', m.onHide);
    m.editor.removeEventListener('focus', m.onHide);
    if (m.layer.parentNode) m.layer.parentNode.removeChild(m.layer);
  }

  function showFindMark(editor, start, end) {
    hideFindMark();
    const wrap = editor.parentElement;
    // (the length of the text the list was made from is the note's length now: no second read of a big textarea's value)
    if (!wrap || !(end > start) || (findSearchedText || '').length > CHAR_MIRROR_FULL_LIMIT) return;
    try {
      const cs = window.getComputedStyle(editor);
      const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.6) || 22.4;
      const c0 = getCharPixelCoords(start, editor);
      const c1 = getCharPixelCoords(end, editor);
      if (c0.estimated || c1.estimated) return;
      const rects = findMarkRects(c0, c1, lineHeight, parseFloat(cs.paddingLeft) || 0,
        editor.clientWidth - (parseFloat(cs.paddingRight) || 0), FIND_MARK_MAX_ROWS);
      if (rects.length === 0) return;
      if (window.getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

      const layer = document.createElement('div');
      layer.className = 'find-match-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.style.left = editor.offsetLeft + 'px';
      layer.style.top = editor.offsetTop + 'px';
      layer.style.width = editor.offsetWidth + 'px';
      layer.style.height = editor.offsetHeight + 'px';
      const inner = document.createElement('div');
      inner.className = 'find-match-inner';
      const follow = () => { inner.style.transform = 'translateY(' + (-(editor.scrollTop || 0)) + 'px)'; };
      follow();
      rects.forEach((r) => {
        const box = document.createElement('div');
        box.className = 'find-match-rect';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        inner.appendChild(box);
      });
      layer.appendChild(inner);
      wrap.appendChild(layer);

      const marked = editor.value.substring(start, end);
      const width = editor.clientWidth;
      findMark = { editor: editor, layer: layer, timer: null, onScroll: follow, onHide: () => hideFindMark() };
      findMark.timer = setInterval(() => {
        if (editor.value.substring(start, end) !== marked || editor.clientWidth !== width) hideFindMark();
      }, 300);
      editor.addEventListener('scroll', follow, { passive: true });
      editor.addEventListener('input', findMark.onHide);
      editor.addEventListener('focus', findMark.onHide);
    } catch (e) {
      hideFindMark(); // a visual cue only: the match is still selected in the note
    }
  }

  function findNext() {
    ensureFreshMatches();
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
    ensureFreshMatches();
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
    ensureFreshMatches(); // (offsets of an earlier search would replace whatever sits there now)
    if (findMatches.length === 0 || currentMatchIndex === -1) return;

    const editor = getActiveEditor();
    if (!editor) return;

    const m = findMatches[currentMatchIndex];
    const repVal = replaceInput.value || '';

    const nextSearchPos = m.start + repVal.length;
    // One undo step (a `.value =` would empty the undo history). The edit needs the note focused for a moment; the focus goes
    // back to where it was so that Enter in the replace box can go on to the next match.
    const prevFocus = document.activeElement;
    replaceRangeWithUndo(editor, m.start, m.end, repVal);
    clearTimeout(autocompleteTimer); // the edit's input event asked for a ghost suggestion; a replacement is not typing
    if (prevFocus && prevFocus !== editor && typeof prevFocus.focus === 'function') prevFocus.focus();
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
    ensureFreshMatches();
    if (findMatches.length === 0) return;

    const editor = getActiveEditor();
    if (!editor) return;

    const query = findInput.value;
    const repVal = replaceInput.value || '';
    const text = editor.value;

    try {
      const regex = buildFindRegex(query, isRegex, isCaseSensitive);
      // Plain mode puts the replacement in as typed, like Replace (one) does; only regex mode expands "$1" / "$&".
      let replaced;
      if (!isWholeWord) {
        replaced = text.replace(regex, isRegex ? repVal : () => repVal);
      } else {
        // Whole word keeps only some of the regex's matches (the same ones the search counted), so the text is put together by hand.
        const parts = [];
        let from = 0;
        scanFindMatches(text, regex, true, (m) => {
          parts.push(text.substring(from, m.index), isRegex ? expandReplacement(repVal, m, text) : repVal);
          from = m.index + m[0].length;
        });
        replaced = parts.join('') + text.substring(from);
      }
      if (replaced !== text) {
        // One undo step, and only the stretch from the first change to the last goes through the editor (a whole-note
        // replacement of a big note would be slow and would fill the undo history with a copy of the note).
        const span = changedSpan(text, replaced);
        const prevFocus = document.activeElement;
        replaceRangeWithUndo(editor, span.from, span.oldEnd, replaced.substring(span.from, span.newEnd));
        clearTimeout(autocompleteTimer);
        if (prevFocus && prevFocus !== editor && typeof prevFocus.focus === 'function') prevFocus.focus();
      }
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

  // Makes `dst` (one pane) show the text of `src` (the other pane of the same note). Assigning `.value` puts the caret at the end of
  // the note, so the pane the person had put their caret in lost it whenever the other pane changed (typing there, an answer
  // arriving). Only the stretch that differs is replaced, and the selection is kept in step with it ('preserve').
  function mirrorEditorText(dst, src) {
    const from = dst.value;
    const to = src.value;
    if (from === to) return;
    if (typeof dst.setRangeText !== 'function') {
      dst.value = to;
      return;
    }
    const span = changedSpan(from, to);
    dst.setRangeText(to.substring(span.from, span.newEnd), span.from, span.oldEnd, 'preserve');
  }

  // The stretch that differs between two texts: text.substring(from, oldEnd) became next.substring(from, newEnd). Never cuts a
  // surrogate pair in two (an emoji that changes into another one).
  function changedSpan(text, next) {
    const max = Math.min(text.length, next.length);
    let from = 0;
    while (from < max && text.charCodeAt(from) === next.charCodeAt(from)) from++;
    let tail = 0;
    while (tail < max - from && text.charCodeAt(text.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)) tail++;
    const isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;
    const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;
    if (from > 0 && isHigh(text.charCodeAt(from - 1))) from--;
    if (tail > 0 && isLow(text.charCodeAt(text.length - tail))) tail--;
    return { from: from, oldEnd: text.length - tail, newEnd: next.length - tail };
  }

  // Find & Replace Input and Button Events
  findInput.addEventListener('input', searchMatchesDebounced);
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (isImeComposingKey(e)) return; // the Enter that confirms a conversion belongs to the IME (WKWebView sends it as a plain Enter)
      e.preventDefault();
      e.stopPropagation(); // the key is answered here: the note's line shortcuts (Shift+Enter = a line below) must not see it too
      if (e.shiftKey) findPrev();
      else findNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // one Esc closes one panel (see the ask bar)
      closeFindBar();
    }
  });

  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (isImeComposingKey(e)) return; // else the half-typed kana is what replaces the match
      e.preventDefault();
      replaceOne();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // one Esc closes one panel (see the ask bar)
      closeFindBar();
    }
  });

  btnToggleReplace.onclick = toggleReplaceRow;
  btnFindCase.onclick = () => {
    isCaseSensitive = !isCaseSensitive;
    btnFindCase.classList.toggle('active', isCaseSensitive);
    btnFindCase.setAttribute('aria-pressed', String(isCaseSensitive)); // on/off for a screen reader, not only the colour
    searchMatches();
  };
  btnFindWord.onclick = () => {
    isWholeWord = !isWholeWord;
    btnFindWord.classList.toggle('active', isWholeWord);
    btnFindWord.setAttribute('aria-pressed', String(isWholeWord));
    searchMatches();
  };
  btnFindRegex.onclick = () => {
    isRegex = !isRegex;
    btnFindRegex.classList.toggle('active', isRegex);
    btnFindRegex.setAttribute('aria-pressed', String(isRegex));
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
    // Like the other dialogs, take the focus in: with it left in the note (or on the header button that opened this) whatever is
    // typed next lands behind the QR code (Esc and the close button still work; closing hands the focus back to the editor).
    if (btnMobileDropCancel) btnMobileDropCancel.focus();

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

  // The editor lives in a section that folds like the others (settings_compact.js wraps it in details.settings-section); its rows
  // are built when that section opens. toggle does not bubble, so listen in the capture phase.
  function layoutSectionOpen() {
    const section = layoutDetailsEl && layoutDetailsEl.closest ? layoutDetailsEl.closest('details.settings-section') : null;
    return !!(section && section.open);
  }
  document.addEventListener('toggle', (e) => {
    const t0 = e.target;
    if (t0 && t0.matches && t0.matches('details.settings-section') && layoutDetailsEl && t0.contains(layoutDetailsEl) && t0.open) renderLayoutEditors();
  }, true);
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
      e.stopPropagation(); // one Esc closes one panel (see the ask bar)
      closeGotoLineModal();
    }
  });

  // --- Feature 4: Ultra-fast Scraps In-Memory Search Modal (Ctrl+Shift+F) ---
  let scrapsSearchDebounceTimer = null;
  let scrapsSearchFlattened = [];
  let scrapsSearchSelectedIndex = 0;
  // The editor that had the caret when the search opened: Tab quotes the chosen line into it.
  let scrapsSearchTarget = null;
  // Numbers the searches, so a slow answer to an earlier query never replaces a newer one.
  let scrapsSearchSeq = 0;
  // True from an edit of the query until the answer for it is shown: the list on screen answers an older query, so Enter / Tab
  // must not open one of its lines (the query box says something else).
  let scrapsSearchStale = false;

  function runScrapsSearch(q) {
    const seq = ++scrapsSearchSeq;
    if (!(window.backend && window.backend.searchScraps)) return;
    Promise.resolve(window.backend.searchScraps(q, 100)).then((results) => {
      if (seq === scrapsSearchSeq) renderScrapsSearchResults(results || []);
    }).catch((err) => {
      console.error('searchScraps failed:', err);
      if (seq === scrapsSearchSeq) scrapsSearchStale = false;
    });
  }

  // Also the toolbar button's click handler, so it takes no argument.
  function openScrapsSearchModal() {
    if (!scrapsSearchModal) return;
    // Before focus moves into the search box: the selection, or the word before the caret, is the first query.
    const seed = getSearchSeed(true);
    scrapsSearchTarget = getActiveEditor();
    scrapsSearchModal.classList.remove('hidden');
    scrapsSearchSelectedIndex = 0;
    scrapsSearchFlattened = [];
    clearTimeout(scrapsSearchDebounceTimer);
    scrapsSearchSeq++;
    if (scrapsSearchInput) {
      scrapsSearchInput.value = seed;
      setTimeout(() => {
        scrapsSearchInput.focus();
        scrapsSearchInput.select();
      }, 40);
    }
    renderScrapsSearchResults([]);
    if (seed) runScrapsSearch(seed);
  }

  // Tab in the search: put the chosen line into the note at the caret (replacing a selection, like a paste,
  // and undoable with Ctrl+Z) instead of opening its file.
  function quoteScrapLine(item) {
    const text = window.ScrapQuote.quoteText(item && item.match);
    if (!text) return;
    const editor = scrapsSearchTarget;
    // The preview covering the editor: there is no visible caret to insert at.
    if (!editor || editor.getClientRects().length === 0) {
      showMessage(t('scrapsSearchNoEditor'), 3000);
      return;
    }
    closeScrapsSearchModal();
    insertTextWithUndo(text, editor);
    const tab = getActiveTab();
    if (tab) onEditorInput(editor, tab, true);
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
      scrapsSearchStale = true;
      scrapsSearchDebounceTimer = setTimeout(() => runScrapsSearch(q), 150);
    });

    scrapsSearchInput.addEventListener('keydown', (e) => {
      // While an IME composition is open, Enter / Tab / arrows / Esc belong to the IME (confirming a
      // conversion must neither jump to a result nor insert one).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // one Esc closes one panel (see the ask bar)
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
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!scrapsSearchStale && scrapsSearchFlattened.length > 0 && scrapsSearchFlattened[scrapsSearchSelectedIndex]) {
          const item = scrapsSearchFlattened[scrapsSearchSelectedIndex];
          jumpToScrap(item.filePath, item.fileName, item.match.lineNumber);
          closeScrapsSearchModal();
        }
      } else if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && e.shiftKey)) {
        // Tab (or Shift+Enter): quote the chosen line into the note. Shift+Tab keeps its usual meaning.
        // stopPropagation: focus moves to the editor below, and the key must not then reach the
        // document-level key handlers as if it had been pressed there (Shift+Enter would add a line break).
        e.preventDefault();
        e.stopPropagation();
        if (!scrapsSearchStale && scrapsSearchFlattened.length > 0 && scrapsSearchFlattened[scrapsSearchSelectedIndex]) {
          quoteScrapLine(scrapsSearchFlattened[scrapsSearchSelectedIndex]);
        }
      }
    });
  }

  function renderScrapsSearchResults(results) {
    scrapsSearchFlattened = [];
    scrapsSearchSelectedIndex = 0;
    scrapsSearchStale = false;

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
    // The tab that shows THIS file (same path), never another note that only has the same name: the date-named scrap exists in every folder.
    let targetTab = findTabByPath(filePath);
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

  // Brings the tab that shows a scrap file up to date after something appended to that file (CLI pipe, Quick Capture, hot folder,
  // Discord). A tab with unsaved text is never overwritten and never marked saved: what was typed there is not on disk, so the tab
  // is left as it is (checked before the read AND after it, the person may type while the file is read). Resolves to 'refreshed',
  // 'unchanged', 'kept' (unsaved text), 'gone' (the tab was closed meanwhile) or 'failed'.
  async function refreshTabFromDisk(tab, filePath) {
    if (!window.backend || !window.backend.readFileByPath) return 'failed';
    if (tabHasUnsavedText(tab)) return 'kept';
    let res;
    try {
      res = await window.backend.readFileByPath(filePath);
    } catch (e) {
      console.warn('Failed to refresh scrap tab:', e);
      return 'failed';
    }
    if (getTab(tab.id) !== tab) return 'gone';
    if (tabHasUnsavedText(tab)) return 'kept';
    if (!res || typeof res.content !== 'string') return 'failed';
    rememberDiskText(tab, res.content); // the tab shows the file as it is now (or is about to): that is what its next save compares with
    if (res.content === tab.content || lfText(res.content) === lfText(tab.content)) return 'unchanged';
    tab.content = res.content;
    if (activeTabId === tab.id) {
      editorEl.value = res.content;
      updateLineNumbers();
      if (isPreviewMode) renderPreview();
    }
    if (isSplitMode && secondaryTabId === tab.id) updateSecondaryPane();
    saveSessionDebounced();
    return 'refreshed';
  }

  // --- Feature 2: Webview Scrap Appended Listener ---
  window.onScrapAppended = async function(data) {
    if (!data) return;
    if (data.cwd) lastPipedCwd = data.cwd;

    // Matched on the file's path only: a note that merely has the same name (the date-named scrap of another folder) is another note.
    let targetTab = data.filePath ? findTabByPath(data.filePath) : null;
    if (targetTab) {
      if ((await refreshTabFromDisk(targetTab, data.filePath)) === 'kept') {
        showMessage(t('scrapKeptUnsavedEdits'), 4000);
        return;
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

    showMessage(t('scrapAppended', { command: data.command || 'CLI Pipe' }), 2500);
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
        showMessage(t('gitSyncTriggeredToast'), 1500);
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

  // A dialog that takes the whole window is up (Settings, About, the command palette, the note search, a question that waits for an
  // answer ...). The shortcuts that open the floating bars stand back while one is: the bar would open behind it, out of sight, and
  // Enter in it would still send the note's text to the model.
  function isDialogOpen() {
    const shown = (el) => !!el && !el.classList.contains('hidden');
    return shown(settingsModal) || shown(gotoLineModal) || shown(quickPickModal) || shown(mobileDropModal) || shown(confirmModal) ||
      shown(scrapsSearchModal) || !!(window.AboutDialog && window.AboutDialog.isOpen && window.AboutDialog.isOpen());
  }

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
    // Only from an editor: pressed in the find box (or anywhere else) no editor paste event follows, the flag would stay up for the
    // whole window and turn the next plain Ctrl+V into a special paste.
    if (isModStrict && e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V') &&
        (e.target === editorEl || (editorSecondary && e.target === editorSecondary))) {
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
      // Result blocks: next / previous / copy / delete / confirm (all unassigned until the user gives them a key).
      const resultAction = RESULT_ACTIONS.find((a) => matchShortcut(e, config.shortcuts && config.shortcuts[a]));
      if (resultAction) {
        e.preventDefault();
        runResultAction(resultAction);
        return;
      }

      // Toggle comment (Ctrl+/, Cmd+/ on macOS). A key the IME is still composing with is not the shortcut.
      if (matchShortcut(e, config.shortcuts && config.shortcuts.commentToggle)) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat) executeToggleComment(activeEl);
        return;
      }
    }

    // Escape priority order: Ghost / IME suggestion -> Inline prompt -> CLI filter -> Find bar -> Modals -> Zen mode
    // (Never minimize window to prevent accidental hiding while typing/editing)
    if (e.key === 'Escape') {
      if (contextMenu && !contextMenu.classList.contains('hidden')) {
        contextMenu.classList.add('hidden');
        return;
      }
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
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.previewToSide)) {
      // Moved from Ctrl/Cmd+Shift+V, which is now the "special paste" (paste-as-Markdown /
      // save-image) trigger handled by the shared paste listener. A shortcut the person can
      // change in Settings > Shortcuts; matchShortcut reads the physical key (e.code) too,
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
          askToSaveBeforeClosing(tab).then(async (outcome) => {
            if (outcome === 'cancel') return;
            if (outcome === 'discard') {
              // "Don't save" throws the text away: take the note out, and write that to the session before the window goes, so the
              // discarded text does not come back from session.json at the next start (or from the hidden window of a tray-resident app).
              removeTab(tab.id);
              await savePersistentSession();
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
      if (!isDialogOpen()) openInlinePromptBar();
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.rewriteSelection)) {
      e.preventDefault();
      if (!isDialogOpen()) openInlinePromptBar({ mode: 'rewrite' });
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.runCliFilter)) {
      e.preventDefault();
      if (!isDialogOpen()) openCommandBar('cli');
    } else if (matchShortcut(e, config.shortcuts && config.shortcuts.runAiCli)) {
      e.preventDefault();
      if (!isDialogOpen()) openCommandBar('ai');
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
      if (!isDialogOpen()) openCommandBar();
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
  if (statAutosave) statAutosave.onclick = () => toggleAutoSave();
  if (statIme) statIme.onclick = () => toggleIME();
  initStatusAI();

  // Settings Tab Switching (5-tab architecture: general, model, agent, sync, shortcuts)
  if (tabBtnGeneral) tabBtnGeneral.onclick = () => switchSettingsTab('general');
  if (tabBtnModel) tabBtnModel.onclick = () => switchSettingsTab('model');
  if (tabBtnAgent) tabBtnAgent.onclick = () => switchSettingsTab('agent');
  if (tabBtnSync) tabBtnSync.onclick = () => switchSettingsTab('sync');
  if (tabBtnShortcuts) tabBtnShortcuts.onclick = () => switchSettingsTab('shortcuts');

  // Header Help button: a small menu (online manual, the release notes when an update is known, About MD-Memo).
  if (btnHelp) {
    btnHelp.setAttribute('aria-haspopup', 'true');
    btnHelp.setAttribute('aria-expanded', 'false');
    btnHelp.onclick = () => openHelpMenu();
  }

  const btnBrowseScrapDir = document.getElementById('btn-browse-scrap-dir');
  if (btnBrowseScrapDir) {
    btnBrowseScrapDir.onclick = async () => {
      if (window.backend && window.backend.openFolder) {
        try {
          const selected = await withNativeDialog(() => window.backend.openFolder());
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

    // An agent that is switched off (agents.yaml: enabled: false / disabled_agents) is not offered. The Go side already leaves
    // it out; an entry that still says enabled: false is skipped as well.
    const agentKeys = Object.keys(slotCfg.agents).filter((key) => !(slotCfg.agents[key] && slotCfg.agents[key].enabled === false));
    if (agentKeys.length === 0) {
      const opt = document.createElement('option');
      const allOff = Array.isArray(slotCfg.disabled_agents) && slotCfg.disabled_agents.length > 0;
      opt.value = allOff ? '' : 'claude-code';
      opt.textContent = allOff ? (typeof t === 'function' ? t('agentNoneEnabled') : 'No agent is enabled') : 'Claude Code';
      defaultAgentEl.appendChild(opt);
      defaultAgentEl.disabled = allOff;
      return;
    }
    defaultAgentEl.disabled = false;

    agentKeys.forEach((key) => {
      const def = slotCfg.agents[key];
      const opt = document.createElement('option');
      opt.value = key;
      // "key - description": the key is what agents.yaml and {{ @key }} use, the description says what the agent is.
      // The full command line stays out of the label: for some agents (agy's --dangerously-skip-permissions default in
      // particular) it is long enough to make every option in the list equally unreadable. It is still available in
      // agents.yaml and in the auto-approve warning shown below this select when such a flag is detected.
      opt.textContent = def && def.description ? key + ' - ' + def.description : key;
      defaultAgentEl.appendChild(opt);
    });

    // Select target agent
    const targetAgent = slotCfg.default_agent || currentSelected;
    if (agentKeys.indexOf(targetAgent) !== -1) {
      defaultAgentEl.value = targetAgent;
      config.default_agent = targetAgent;
    } else if (defaultAgentEl.options.length > 0) {
      defaultAgentEl.selectedIndex = 0;
      config.default_agent = defaultAgentEl.value;
    }
  }

  // Settings > Agent: names the agents that are switched off in agents.yaml (enabled: false / disabled_agents), only when there are any.
  function renderAgentDisabledNote(slotCfg) {
    const el = document.getElementById('agent-disabled-note');
    if (!el) return;
    const list = slotCfg && Array.isArray(slotCfg.disabled_agents) ? slotCfg.disabled_agents.filter((key) => typeof key === 'string' && key) : [];
    el.textContent = list.length ? t('agentDisabledNote', { agents: list.join(', ') }) : '';
    el.classList.toggle('hidden', list.length === 0);
  }

  // The selected agent skips its CLI's permission prompts: the same flag list the run-time confirmation uses
  // (AgentRisk.AUTO_APPROVE_FLAGS in agent_risk.js). A disclosure aid, not a sandbox.
  function updateAgentAutoApproveWarning() {
    const warnEl = document.getElementById('agent-auto-approve-warning');
    if (!warnEl) return;
    const agentDef = lastLoadedSlotConfig && lastLoadedSlotConfig.agents && lastLoadedSlotConfig.agents[config.default_agent];
    const hasAutoApprove = !!(agentDef && window.AgentRisk && window.AgentRisk.riskFlags(agentDef).length > 0);
    warnEl.classList.toggle('hidden', !hasAutoApprove);
  }

  // Settings > Agent: agent definitions worth a look (the Go side's agent_issues), until hidden for this set.
  function renderAgentIssues(slotCfg) {
    const el = document.getElementById('agent-issues');
    if (!el || !window.AgentRisk) return;
    window.AgentRisk.renderIssues(el, slotCfg && slotCfg.agent_issues, {
      t: (key) => t(key),
      doc: document,
      agents: slotCfg && slotCfg.agents,
      state: config.agentNotice,
      copy: copyTextToClipboard,
      showMessage: showMessage,
      onDismiss: (state) => {
        config.agentNotice = state;
        savePersistentConfig().catch(() => {});
      }
    });
  }

  // Once per set of agent issues, a few seconds after start-up: a status-bar message pointing to Settings > Agent.
  async function announceAgentIssues() {
    if (!window.AgentRisk || !window.backend || !window.backend.getActiveSlotConfigJSON) return;
    try {
      const raw = await window.backend.getActiveSlotConfigJSON();
      const due = window.AgentRisk.startupNotice(config.agentNotice, raw ? JSON.parse(raw).agent_issues : null);
      if (!due) return;
      showStartupNotice(t('agentIssuesStartup', { count: due.count }), 8000, () => {
        config.agentNotice = due.state;
        savePersistentConfig().catch(() => {});
      });
    } catch (e) {
      console.warn('Checking the agent definitions failed:', e);
    }
  }

  async function updateAgentAvailabilityBadge() {
    const badgeEl = document.getElementById('agent-availability-badge');
    if (!badgeEl) return;
    if (!(window.backend && window.backend.checkAgentAvailability)) {
      badgeEl.classList.add('hidden');
      return;
    }
    const agentSelectEl = document.getElementById('cfg-default-agent');
    if (agentSelectEl && agentSelectEl.disabled) { // every agent is disabled: there is nothing to look for
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
          renderAgentDisabledNote(slotCfg);
          renderAgentIssues(slotCfg);
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

    // The select now names the agent a run really uses (a disabled default_agent is replaced by the next enabled one). That is
    // what Settings opened with, so Save must not write it back into agents.yaml as if the user had picked it.
    if (openedConfigSnapshot && config.default_agent) openedConfigSnapshot.default_agent = config.default_agent;

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

  // The shortcuts of a config that may hold anything (config.json is edited by hand, and agents write it): only a string can be a
  // key combination ('' and null mean "unassigned"). A number, true or a list in its place would make every key press throw in
  // parseShortcutString and keep Settings from opening, so it is left out and that action keeps its default.
  function usableShortcuts(map) {
    const out = {};
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      Object.keys(map).forEach((k) => {
        if (k !== '__proto__' && (typeof map[k] === 'string' || map[k] === null)) out[k] = map[k];
      });
    }
    return out;
  }

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
      // "Ctrl+Cmd+X" is a macOS chord (Zen mode is Ctrl+Cmd+Z, full screen Ctrl+Cmd+F). The Windows recorder never writes Cmd, so one
      // that got here came from a Mac's settings; reading it as plain Ctrl+X would swallow Ctrl+Z / Ctrl+F, so it matches nothing.
      if (hasCtrl && hasCmd) return false;
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
    if (btnPreviewSide) {
      // A cleared or changed shortcut shows in the tooltip like the others.
      btnPreviewSide.title = config.shortcuts.previewToSide
        ? `${baseTitle(t('previewToSideTitle'))} (${formatShortcutForDisplay(config.shortcuts.previewToSide)})`
        : baseTitle(t('previewToSideTitle'));
    }
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
  // (special paste, task panel, ghost-text word accept; "preview to the side" is a registry shortcut now), and the
  // third row is the editing keys the browser owns: binding an action to any of them would either
  // never fire or break copy/paste/undo, so the recorder refuses them.
  const RESERVED_SYSTEM_SHORTCUTS_WIN = ['Ctrl+Tab', 'Ctrl+,',
    'Ctrl+Shift+V', 'Alt+T', 'Ctrl+ArrowRight',
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
    'Cmd+Shift+V', 'Option+T', 'Cmd+ArrowRight',
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

  // v1.10.8 shipped the two Japanese-input helpers off and wrote that default into config.json whenever Settings was saved, so
  // v1.10.9's new default never reached those files. Once, put both on. imeHelpersMigrated is set only by the authoritative load,
  // so a later load of the file (which carries the person's own choice and the flag) is never overridden.
  function migrateImeHelpers(authoritative) {
    if (!config.general || config.general.imeHelpersMigrated === true) return;
    config.general.imeGuardianRetype = true;
    config.general.imeGuardianReverse = true;
    if (authoritative) config.general.imeHelpersMigrated = true;
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
        { key: 'insertLineAbove', labelKey: 'shortcutActionInsertLineAbove' },
        { key: 'commentToggle', labelKey: 'shortcutActionCommentToggle' }
      ]
    },
    {
      titleKey: 'shortcutGroupResult',
      actions: [
        { key: 'resultNext', labelKey: 'shortcutActionResultNext' },
        { key: 'resultPrev', labelKey: 'shortcutActionResultPrev' },
        { key: 'resultCopy', labelKey: 'shortcutActionResultCopy' },
        { key: 'resultDelete', labelKey: 'shortcutActionResultDelete' },
        { key: 'resultConfirm', labelKey: 'shortcutActionResultConfirm' }
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
        { key: 'previewToSide', labelKey: 'shortcutActionPreviewToSide' },
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
        { key: 'rewriteSelection', labelKey: 'shortcutActionRewriteSelection' },
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
      config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS);
      clearShortcutParseCache();
      activeRecordingAction = null;
      // The OS hotkeys (summon, quick capture) are NOT registered here: Cancel puts config.shortcuts back but cannot take back what the
      // OS was told, which left the hotkeys at the defaults while Settings and config.json still showed the person's own. Save compares
      // with what the dialog opened with and registers what changed (the click handler of #btn-save-settings).
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
    // the section is folded like the others, so hide the whole fold, not just its heading
    const sendToFold = sendToSection && sendToSection.closest && sendToSection.closest('details.settings-section');
    if (sendToFold) sendToFold.classList.add('hidden');
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
          const selected = await withNativeDialog(() => window.backend.openFolder());
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
    // Same rule as onScrapAppended: the tab that shows this file's path, refreshed only when it holds no unsaved text.
    const targetTab = data.filePath ? findTabByPath(data.filePath) : null;
    if (targetTab && (await refreshTabFromDisk(targetTab, data.filePath)) === 'kept') {
      showMessage(t('scrapKeptUnsavedEdits'), 4000);
      return;
    }
    showMessage(t('discordBridgeMessageToast'), 2500);
  };

  // Settings Dialog
  let openedConfigSnapshot = null;

  // Set by the import, which changes the config under the open dialog and wants every field redrawn (see openSettings).
  let settingsRefreshRequested = false;

  function openSettings() {
    if (contextMenu) contextMenu.classList.add('hidden');
    // A second open of a dialog that is already up (Ctrl+, again, the gear button) only brings the focus back: reading every field
    // from the config again would wipe what was typed, and the new snapshot would make Cancel keep a language or theme tried since.
    if (settingsModal && !settingsModal.classList.contains('hidden') && !settingsRefreshRequested) {
      if (tabBtnGeneral && !settingsModal.contains(document.activeElement)) tabBtnGeneral.focus();
      return;
    }
    settingsRefreshRequested = false;
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
    initMeetingAudioSettings();
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
    const imeRetypeGroup = document.getElementById('ime-retype-group');
    if (imeRetypeGroup) imeRetypeGroup.classList.toggle('hidden', !(window.backend && window.backend.retypeWithImeAsync));
    const imeReverseGroup = document.getElementById('ime-reverse-group');
    if (imeReverseGroup) imeReverseGroup.classList.toggle('hidden', !(window.backend && window.backend.retypeWithImeAsync));
    const imeReverseCheckbox = document.getElementById('cfg-ime-reverse');
    if (imeReverseCheckbox) imeReverseCheckbox.checked = !!(config.general && config.general.imeGuardianReverse);
    const imeRetypeCheckbox = document.getElementById('cfg-ime-retype');
    if (imeRetypeCheckbox) imeRetypeCheckbox.checked = !!(config.general && config.general.imeGuardianRetype);
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
    const commentStyleSelect = document.getElementById('cfg-comment-style');
    if (commentStyleSelect) {
      commentStyleSelect.value = config.general.commentStyle === 'block' ? 'block' : 'line';
    }
    const trayResidentCheckbox = document.getElementById('cfg-tray-resident');
    if (trayResidentCheckbox) {
      trayResidentCheckbox.checked = config.general.trayResident !== false;
    }
    const splitViewOnStartupCheckbox = document.getElementById('cfg-split-view-on-startup');
    if (splitViewOnStartupCheckbox) {
      splitViewOnStartupCheckbox.checked = !!(config.general && config.general.splitViewOnStartup);
    }
    const checkUpdatesCheckbox = document.getElementById('cfg-check-updates');
    if (checkUpdatesCheckbox) checkUpdatesCheckbox.checked = updateCheckAtStartup();
    renderCloudConsentRow();

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
      // The tab that is showing, not always the first: the AI item of the status bar, the ask bar and the palette switch the tab right
      // after opening, and focus left on a tab that is not showing put a keyboard user in the wrong place.
      const shown = [tabBtnGeneral, tabBtnModel, tabBtnAgent, tabBtnSync, tabBtnShortcuts].find((b) => b && b.classList && b.classList.contains('active'));
      const target = shown || tabBtnGeneral;
      if (target) target.focus();
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
    // "Forget" in Settings > General clears the allowed cloud hosts in memory; Cancel puts them back (Save is what writes them).
    if (config.general && snap.general && JSON.stringify(config.general.cloudConsent) !== JSON.stringify(snap.general.cloudConsent)) {
      config.general.cloudConsent = snap.general.cloudConsent ? JSON.parse(JSON.stringify(snap.general.cloudConsent)) : {};
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
  // The provider the last detection found ('' = none we know), null = no line is showing. A var, not a let: applyLanguage()
  // reads it through renderProviderDetectLine(), and it may run before this line has.
  var lastDetectedProvider = null;
  async function updateLLMProviderDetection() {
    const lineEl = document.getElementById('text-provider-detect-line');
    if (!lineEl) return;
    if (!(window.backend && window.backend.detectLLMProvider)) {
      lastDetectedProvider = null;
      lineEl.classList.add('hidden');
      return;
    }
    const baseUrlEl = document.getElementById('cfg-base-url');
    const apiKeyEl = document.getElementById('cfg-api-key');
    const baseUrl = baseUrlEl ? baseUrlEl.value.trim() : '';
    const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
    if (!baseUrl) {
      lastDetectedProvider = null;
      lineEl.classList.add('hidden');
      return;
    }
    const myToken = ++providerDetectReqToken;
    try {
      const provider = await window.backend.detectLLMProvider(baseUrl, apiKey);
      if (myToken !== providerDetectReqToken) return; // stale response, URL changed since
      lastDetectedProvider = provider == null ? '' : String(provider);
      renderProviderDetectLine();
      lineEl.classList.remove('hidden');
    } catch (e) {
      lastDetectedProvider = null;
      lineEl.classList.add('hidden');
    }
  }

  // Writes the protocol line from the provider that was detected last, so that a change of the UI language can write it
  // again without asking the backend. Does nothing while no protocol has been detected.
  function renderProviderDetectLine() {
    const lineEl = lastDetectedProvider == null ? null : document.getElementById('text-provider-detect-line');
    if (!lineEl) return;
    const providerLabelKeys = {
      ollama: 'providerOllama',
      gemini: 'providerGemini',
      'openai-compatible': 'providerOpenAICompatible'
    };
    const key = providerLabelKeys[lastDetectedProvider];
    lineEl.textContent = key ? t('llmProtocolDetected', { protocol: t(key) }) : t('llmProtocolUnknown');
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
      if (ollamaProgressStep) ollamaProgressStep.textContent = t('ollamaStepOf', { step: 1, total: 5 });
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

    // The Go side words each step in Japanese: said in the UI language here (go_text.js)
    if (ollamaProgressMsg && prog.message) {
      ollamaProgressMsg.textContent = goErr(prog.message);
    }
    if (ollamaProgressStep && prog.step) {
      ollamaProgressStep.textContent = t('ollamaStepOf', { step: prog.step, total: prog.total || 5 });
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
        refreshStatusAI(); // the model behind the AI item of the status bar just changed
        showMessage(t('ollamaSetupSuccess'), 4000);
      } else {
        updateOllamaStatus();
        showMessage(t('ollamaSetupFailed', { err: goErr(prog.error || '') || t('ollamaSetupUnknown') }), 8000);
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
      // And not where the person (or an imported file) already decided: the checkbox is a default for a profile that has never
      // saved one, and a language chosen to try it out must not turn it on, or off, for good with the next Save.
      if (imeCheckbox && platformCapabilities.nativeImeSwitch !== false && !hasPersistedImeGuardianSetting) {
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
    const saveSystemAudioEl = document.getElementById('cfg-voice-system-audio');
    if (saveSystemAudioEl) config.voice.includeSystemAudio = !!saveSystemAudioEl.checked;
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
    const imeRetypeSaveCheckbox = document.getElementById('cfg-ime-retype');
    if (imeRetypeSaveCheckbox) config.general.imeGuardianRetype = imeRetypeSaveCheckbox.checked;
    const imeReverseSaveCheckbox = document.getElementById('cfg-ime-reverse');
    if (imeReverseSaveCheckbox) config.general.imeGuardianReverse = imeReverseSaveCheckbox.checked;
    const aiCorrectionSaveCheckbox = document.getElementById('cfg-ai-correction');
    if (aiCorrectionSaveCheckbox) {
      config.general.aiCorrection = aiCorrectionSaveCheckbox.checked;
    }
    const commentStyleSaveSelect = document.getElementById('cfg-comment-style');
    if (commentStyleSaveSelect) {
      config.general.commentStyle = commentStyleSaveSelect.value === 'block' ? 'block' : 'line';
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
    const checkUpdatesSaveCheckbox = document.getElementById('cfg-check-updates');
    if (checkUpdatesSaveCheckbox) config.general.checkUpdates = checkUpdatesSaveCheckbox.checked;

    // Save Slot & Autonomous Agent Settings
    const saveSlotTimeoutEl = document.getElementById('cfg-slot-timeout');
    if (saveSlotTimeoutEl) config.timeout_seconds = clampNumber(saveSlotTimeoutEl.value, 10, 600, 180);
    const saveGhostDiffEl = document.getElementById('cfg-slot-ghost-diff-ms');
    if (saveGhostDiffEl) config.ghost_diff_duration_ms = clampNumber(saveGhostDiffEl.value, 1000, 10000, 4000);
    const saveHoverPeekEl = document.getElementById('cfg-slot-hover-peek');
    if (saveHoverPeekEl) config.hover_peek_enabled = saveHoverPeekEl.checked;
    const saveDefaultAgentEl = document.getElementById('cfg-default-agent');
    if (saveDefaultAgentEl) {
      config.default_agent = saveDefaultAgentEl.value || config.default_agent || 'claude-code'; // empty: every agent is disabled
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
    // The status-bar toggles follow what was just saved: autosave, IME and the AI item (model label, switches).
    renderAutosaveStatus();
    renderImeStatus();
    refreshStatusAI();
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

    // Optimistic UI: the modal closes at once, the write runs in the background. The "saved" toast waits for the write: when
    // config.json cannot be written, savePersistentConfig has already said so and this toast must not.
    closeSettings();
    saveSessionDebounced();
    savePersistentConfig().then((saved) => {
      if (saved !== false) showMessage(t('settingsSaved'), 2000);
    }).catch(e => {
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
    if (next.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, usableShortcuts(next.shortcuts));
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
    settingsRefreshRequested = true;
    openSettings(); // Refresh settings modal inputs (the dialog is open: this is not a second open)
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
      isMac: isMac, // a package's shortcuts made on a Mac are not taken on another OS
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

  // Resolves true when config.json took the config (or there is no backend to write to), false when it did not. A failure is
  // said here, in the status bar, every time - not only in the console - so no caller has to remember to (and none can show a
  // "saved" that is not true). It never rejects.
  async function savePersistentConfig() {
    try {
      // The copy kept in this WebView's storage has no API keys or tokens: config.json (through
      // window.backend below, and read back by syncBackendConfig) is the only place they live.
      if (window.SecretStrip) window.SecretStrip.saveLocalCopy(localStorage, config);
    } catch (e) {}

    if (window.backend && window.backend.saveConfig) {
      // The keys are not in the local copy any more: when config.json could not be read at start-up, this page
      // does not have them, and writing the config now would blank them in the file. Nothing is saved until the
      // page is reloaded with a readable config.json.
      if (backendConfigLoadFailed) {
        showMessage(t('configNotSavedUnreadable'), 8000);
        return false;
      }
      try {
        await window.backend.saveConfig(JSON.stringify(config));
      } catch (e) {
        console.warn('Failed to save config to local file:', e);
        // Go words its error in Japanese ("<sentence>: open C:\...\config.json: Access is denied."): keep what the system said, so the
        // English toast does not carry a Japanese sentence.
        const why = String((e && e.message) || e || '').replace(/\s+/g, ' ').replace(/^[^:]*[\u3040-\u30ff\u4e00-\u9fff][^:]*:\s*/, '').trim();
        showMessage(t('configSaveFailed', { err: (why.length > 120 ? why.slice(0, 120) + '…' : why) || t('configSaveFailedUnknown') }), 9000);
        return false;
      }
    }
    return true;
  }

  // Set when the backend's config.json could not be read at start-up (see syncBackendConfig).
  let backendConfigLoadFailed = false;

  // What this machine remembers about agents (agent_risk.js): the confirmed command lines (agentAck) and which agent
  // notice was shown or hidden (agentNotice). Kept with the config, never exported in a settings package.
  function loadAgentSafetyState(saved) {
    for (const key of ['agentAck', 'agentNotice']) {
      const v = saved && saved[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) config[key] = Object.assign({}, v);
    }
  }

  // Load Saved Config from local storage & backend RPC
  function loadLocalConfigSync() {
    try {
      const saved = localStorage.getItem('md_memo_config_v1') || localStorage.getItem('md_notepad_config_v3');
      if (saved) {
        hasSavedConfig = true;
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
        loadAgentSafetyState(parsed);
        if (parsed.general) Object.assign(config.general, parsed.general);
        if (parsed.general && parsed.general.imeGuardian !== undefined) hasPersistedImeGuardianSetting = true;
        if (parsed.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, usableShortcuts(parsed.shortcuts));
        migrateInsertLineShortcuts();
        migrateZenShortcut(false);
        migrateAskShortcuts(false);
        // No toast here: this runs synchronously before the UI has painted.
        // The authoritative backend load below (syncBackendConfig) re-runs this
        // migration and shows the toast if anything actually fell back.
        migrateMacShortcuts(false);
        migrateFullscreenShortcut();
        migrateImeHelpers(false);
      }
    } catch (e) {}
    applyCalmToolbarForNewProfile();
    applyTheme();
    applyLanguage();
    applyChromeLayout(); // synchronous, before the first paint: no flash of hidden icons
    updateShortcutLabels();
    updateActionStatus();
  }

  // The scrap settings that only the older flat keys of config.json decide (scrap_dir, git_sync_enabled, ...), as `scraps.*` names.
  // The backend reads both forms (parseScrapConfig in app_scrap.go) and the nested `scraps` object wins, but only with a usable value
  // (not "", not 0); the page used to read only the nested one, so Settings showed the defaults and the next Save wrote them over the
  // person's own folder (and switched Git sync back on).
  function legacyScrapSettings(fileConfig) {
    const out = {};
    if (!fileConfig || typeof fileConfig !== 'object') return out;
    const nested = fileConfig.scraps && typeof fileConfig.scraps === 'object' ? fileConfig.scraps : {};
    const usable = (v, kind) => (kind === 'bool' ? typeof v === 'boolean' : kind === 'str' ? typeof v === 'string' && v !== '' : typeof v === 'number' && v > 0);
    [['scrap_dir', 'scrapDir', 'str'], ['git_sync_enabled', 'gitSyncEnabled', 'bool'], ['git_sync_debounce_seconds', 'gitSyncDebounceSeconds', 'num'],
      ['git_remote_branch', 'gitRemoteBranch', 'str'], ['max_pipe_size_mb', 'maxPipeSizeMB', 'num']].forEach(([flat, name, kind]) => {
      if (usable(fileConfig[flat], kind) && !usable(nested[name], kind)) out[name] = fileConfig[flat];
    });
    return out;
  }

  // Resolves to true / false: config.json exists / does not (first_run.js needs a definite false), or null when that could not be told.
  async function syncBackendConfig() {
    let configFileFound = null;
    if (window.backend && window.backend.getConfig) {
      try {
        const fileConfigStr = await window.backend.getConfig();
        configFileFound = !!(fileConfigStr && String(fileConfigStr).trim());
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
          const flatScraps = legacyScrapSettings(fileConfig);
          if (fileConfig.scraps || Object.keys(flatScraps).length) {
            if (!config.scraps) config.scraps = {};
            Object.assign(config.scraps, fileConfig.scraps || {}, flatScraps);
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
          loadAgentSafetyState(fileConfig);
          // Remember what the (already applied) local config produced so the
          // whole-DOM i18n / theme passes are not repeated for no reason.
          const prevTheme = (config.general && config.general.theme) || 'olive';
          const prevLang = (config.general && config.general.language) || 'en';

          if (fileConfig.general) Object.assign(config.general, fileConfig.general);
          if (fileConfig.general && fileConfig.general.imeGuardian !== undefined) hasPersistedImeGuardianSetting = true;
          hasSavedConfig = true;
          if (calmToolbarApplied) {
            // The page's own storage was empty but config.json is there (a reinstall, a cleared WebView profile): its layout wins, and a
            // config from before layouts were saved means "show everything".
            calmToolbarApplied = false;
            const savedLayout = fileConfig.general && fileConfig.general.toolbarLayout;
            if (!savedLayout || typeof savedLayout !== 'object') config.general.toolbarLayout = { order: [], hidden: [] };
          }
          if (fileConfig.shortcuts) config.shortcuts = Object.assign({}, DEFAULT_SHORTCUTS, config.shortcuts, usableShortcuts(fileConfig.shortcuts));
          migrateInsertLineShortcuts();
          migrateZenShortcut(true);
          migrateAskShortcuts(true);
          // Authoritative config load: this is the one place the migration is
          // allowed to toast the user, since the UI has already painted by now.
          migrateMacShortcuts(true);
          migrateFullscreenShortcut();
          migrateImeHelpers(true);
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
          renderAutosaveStatus();
          renderImeStatus();
          if (shortcutMigrationDirty) {
            shortcutMigrationDirty = false;
            savePersistentConfig();
          }
        }
      } catch (e) {
        backendConfigLoadFailed = true;
        configFileFound = null;
        console.warn('Failed to load persistent config from backend:', e);
        // Say it now, not at the first Save: the theme, the language and every key in config.json are missing from this page.
        showMessage(t('configNotSavedUnreadable'), 8000);
      }
    }
    return configFileFound;
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
        content: persistedContent(t),
        isDirty: t.isDirty,
        encoding: t.encoding,
        cursorPos: t.cursorPos,
        diskSig: t.diskSig,
        eol: t.eol
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
    // what belongs on disk: a request still waiting for its answer has not changed the person's note (see persistedContent)
    const content = persistedContent(t);
    const cached = sessionTabFragmentCache.get(t);
    if (
      cached &&
      cached.id === t.id &&
      cached.title === t.title &&
      cached.path === t.path &&
      cached.content === content &&
      cached.isDirty === t.isDirty &&
      cached.encoding === t.encoding &&
      cached.cursorPos === t.cursorPos &&
      cached.diskSig === t.diskSig &&
      cached.eol === t.eol
    ) {
      return cached.json;
    }
    const json = JSON.stringify({
      id: t.id,
      title: t.title,
      path: t.path,
      content: content,
      isDirty: t.isDirty,
      encoding: t.encoding,
      cursorPos: t.cursorPos,
      diskSig: t.diskSig,
      eol: t.eol
    });
    sessionTabFragmentCache.set(t, {
      id: t.id,
      title: t.title,
      path: t.path,
      content: content,
      isDirty: t.isDirty,
      encoding: t.encoding,
      cursorPos: t.cursorPos,
      diskSig: t.diskSig,
      eol: t.eol,
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

  let sessionSaveAskedAt = 0; // when the session was first asked to be saved since it last was
  function saveSessionDebounced() {
    clearTimeout(sessionSaveTimer);
    // 0.5 s after the last change, but never later than 5 s after the first one: with keystrokes closer together than 0.5 s a plain
    // debounce writes nothing while the person types, and a crash loses all of it.
    const now = Date.now();
    if (!sessionSaveAskedAt) sessionSaveAskedAt = now;
    const delay = Math.max(0, Math.min(500, 5000 - (now - sessionSaveAskedAt)));
    sessionSaveTimer = setTimeout(() => {
      sessionSaveAskedAt = 0;
      savePersistentSession();
    }, delay);
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

  // The tabs of a saved session, made safe to use. session.json / localStorage are read back after a downgrade, a hand edit or a
  // damaged write, and one malformed element must not stop the start or take another note's place. An element that is not an
  // object is dropped; every field gets the type the rest of the app relies on (a tab without `content` used to show the text
  // "undefined"); an id that is missing, or already used by an earlier tab, is replaced by a fresh one so the tabs stay distinct;
  // isDirty stays only when it is literally true, diskSig / eol only when they are strings.
  function normalizeSessionTabs(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    raw.forEach((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return;
      let id = typeof r.id === 'string' ? r.id : (typeof r.id === 'number' && isFinite(r.id) ? String(r.id) : '');
      while (!id || seen.has(id)) id = genReqId('tab_');
      seen.add(id);
      const path = typeof r.path === 'string' ? r.path : '';
      const content = typeof r.content === 'string' ? r.content : '';
      const tab = {
        id: id,
        title: (typeof r.title === 'string' && r.title) || path.split(/[\\/]/).pop() || `${t('untitled')}.md`,
        path: path,
        content: content,
        isDirty: r.isDirty === true,
        encoding: (typeof r.encoding === 'string' && r.encoding) || 'UTF-8',
        cursorPos: Number.isFinite(r.cursorPos) ? Math.min(Math.max(0, Math.floor(r.cursorPos)), content.length) : content.length
      };
      if (typeof r.diskSig === 'string') tab.diskSig = r.diskSig;
      if (typeof r.eol === 'string') tab.eol = r.eol;
      if (r.isAutoTitle === true) tab.isAutoTitle = true; // written by older versions; the current session format leaves it out
      out.push(tab);
    });
    return out;
  }

  function restoreSessionFromData(sessionData) {
    const restoredTabs = sessionData ? normalizeSessionTabs(sessionData.tabs) : [];
    if (restoredTabs.length > 0) {
      tabs = restoredTabs;
      tabCounter = Number.isInteger(sessionData.tabCounter) && sessionData.tabCounter > 0 ? sessionData.tabCounter : tabs.length + 1;
      const asId = (id) => (id == null ? '' : String(id));
      const targetTabId = tabs.some(t => t.id === asId(sessionData.activeTabId))
        ? asId(sessionData.activeTabId)
        : tabs[0].id;
      renderTabs();
      selectTab(targetTabId);

      // Restore layout & split mode state
      if (sessionData.isSplitMode) {
        const secTabId = (sessionData.secondaryTabId != null && tabs.some(t => t.id === asId(sessionData.secondaryTabId)))
          ? asId(sessionData.secondaryTabId)
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

  // A file dropped on the tab bar or the header opens as a note only when it is text: a picture, a PDF or an archive became a tab of
  // garbage characters (and saving it wrote a broken .md). A picture type says so at once; for the rest the first 8 KB decide: text has
  // no NUL byte, and nearly every binary format has one in its header (a UTF-16 file starts with its byte order mark and is let through).
  async function looksLikeTextFile(file) {
    if (/^(image|audio|video)\//.test(file.type || '')) return false;
    try {
      const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
      if ((head[0] === 0xFF && head[1] === 0xFE) || (head[0] === 0xFE && head[1] === 0xFF)) return true;
      for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
    } catch (err) { /* not readable this way: the read below reports it */ }
    return true;
  }

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
          if (!(await looksLikeTextFile(file))) {
            showMessage(t('dropNotTextFile', { name: file.name }), 4000);
            continue;
          }
          const text = await file.text();
          createTab(file.name, text, file.path || '');
        } catch (err) {
          console.warn('Failed to read dropped file:', err);
        }
      }
    }
  });

  // The very first start only (first_run.js; docs/design/first-run.md, UX review A1). Once the backend has said there is no config.json,
  // the first note is still empty, and there is no session, workspace folder or start-up file, that note becomes an editable Welcome
  // note and general.welcomeShown is written so it never comes back. Any later start costs one boolean test; a note the person has
  // already typed into is never replaced.
  function showWelcomeOnFirstRun(signals) {
    const FR = window.FirstRun;
    // Every start after the first ends here: a config.json exists (true), or the backend could not say (null).
    if (!FR || !editorEl || !signals || signals.configFileFound !== false) return false;
    const welcomeShown = !!(config.general && config.general.welcomeShown);
    let localConfigFound = false;
    try {
      localConfigFound = !!(localStorage.getItem('md_memo_config_v1') || localStorage.getItem('md_notepad_config_v3'));
    } catch (e) { /* storage unavailable: the backend's answer decides */ }
    if (!FR.isFirstRun(Object.assign({ welcomeShown: welcomeShown, localConfigFound: localConfigFound }, signals))) return false;
    if (tabs.length !== 1 || !FR.isUntouchedNewTab(tabs[0], editorEl.value)) return false;

    const shortcut = (action) => {
      const sc = getEffectiveShortcut(action);
      return sc ? formatShortcutForDisplay(sc) : '';
    };
    const note = FR.welcomeNote(config.general.language, {
      ask: shortcut('inlinePrompt'),
      palette: shortcut('quickPick'),
      settings: shortcut('openSettings'),
      search: shortcut('searchScraps'),
      preview: shortcut('togglePreview'),
      save: shortcut('saveFile'),
      scrapDir: (config.scraps && config.scraps.scrapDir) || ''
    });
    const tab = tabs[0];
    tab.title = note.title;
    tab.isAutoTitle = false;
    tab.isDirty = false;
    tab.content = note.content;
    tab.cursorPos = note.cursorPos;
    // selectTab copies the live editor into the tab it leaves, so the editor has to hold the note first.
    editorEl.value = note.content;
    editorEl.setSelectionRange(0, 0);
    selectTab(tab.id);

    config.general.welcomeShown = true;
    try {
      // The toolbar layout in effect goes with the flag: a profile with no config file starts with the calm toolbar, and a config file
      // that has no layout would turn it into "show everything" on the next start (applyCalmToolbarForNewProfile).
      const saved = window.backend && window.backend.saveConfig ? window.backend.saveConfig(FR.welcomeConfigJson({ toolbarLayout: config.general.toolbarLayout })) : null;
      if (saved && typeof saved.catch === 'function') saved.catch((e) => console.warn('Failed to remember the welcome note:', e));
    } catch (e) {
      console.warn('Failed to remember the welcome note:', e);
    }
    return true;
  }

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
    setTimeout(announceAgentIssues, 4000); // well after the first paint and the config sync
    (async () => {
      // Check if a file path was passed via CLI argument or double-clicked from Explorer / Finder
      // The file is opened as one more tab AFTER the session, the workspace and the settings are restored (below): a start with a
      // file is still a normal start, it only adds a tab.
      let startupFile = null;
      let startupError = '';
      if (window.backend && window.backend.getStartupFile) {
        try {
          startupFile = await window.backend.getStartupFile();
        } catch (e) {
          console.warn('Failed to retrieve startup file:', e);
          startupError = String((e && e.message) || e || 'unknown error');
        }
      }

      // Sync session from backend file (AppData/md-memo/session.json)
      let backendSessionFound = false;
      let sessionUnreadable = false;
      if (config.general.restoreSession !== false && window.backend && window.backend.getSession) {
        try {
          const backendSessionStr = await window.backend.getSession();
          if (backendSessionStr) {
            backendSessionFound = true;
            const sessionData = JSON.parse(backendSessionStr);
            if (sessionData && Array.isArray(sessionData.tabs) && sessionData.tabs.length > 0) {
              restoreSessionFromData(sessionData);
            }
          }
        } catch (e) {
          console.warn('Failed to load session from backend:', e);
          // Text that is not JSON (cut off by a crash, edited by hand), as opposed to a call that failed: said below.
          if (e && e.name === 'SyntaxError') sessionUnreadable = true;
        }
      }

      // The file given on the command line / opened from Explorer or Finder. The restored tabs stay; only an untouched first note
      // (the empty note a start with no session begins with) gives way to it, so nothing anyone wrote is replaced.
      if (startupFile && startupFile.path) {
        if (isPreviewMode) {
          await togglePreview();
        }
        const first = tabs.length === 1 ? tabs[0] : null;
        const FR = window.FirstRun;
        const emptyFirstNote = !!first && !first.path && !first.isDirty &&
          (FR ? FR.isUntouchedNewTab(first, first.id === activeTabId ? editorEl.value : undefined) : String(first.content == null ? '' : first.content).trim() === '');
        createTab(startupFile.title, startupFile.content, startupFile.path, startupFile.encoding);
        if (emptyFirstNote && tabs.length > 1 && getTab(first.id)) removeTab(first.id);
        editorEl.focus();
      } else if (startupError) {
        // Go's message names the file; say what was being done as well, so a failed start-up file is not a silent blank note.
        showMessage(t('startupFileFailed', { err: startupError }), 8000);
      }
      // A session that could not be read is replaced by the next save about a second from now, and nothing else says it ever existed:
      // tell the person, and where the old file is kept (the Go side copies it to session.json.bak). Not when the page's own copy
      // of the session was restored: then nothing is missing.
      if (sessionUnreadable && !restored) showMessage(t('sessionUnreadable'), 10000);

      // The restored tabs are checked against their files once the window is up (a file may have changed while the app was closed).
      setTimeout(verifyRestoredTabsAgainstDisk, 1700);

      // Restore saved workspace folder if any (defer non-critical scan slightly to guarantee instantaneous first paint)
      const savedFolder = localStorage.getItem('md_memo_workspace_folder');
      if (savedFolder) {
        setTimeout(() => {
          loadWorkspaceFolder(savedFolder, true);
        }, 300);
      }

      // Background asynchronous sync of configuration
      const configFileFound = await syncBackendConfig();
      // The very first start only: the still-empty first note becomes the Welcome note (first_run.js).
      showWelcomeOnFirstRun({ configFileFound: configFileFound, sessionFound: restored || backendSessionFound, workspaceFolder: savedFolder });

      // Only force split mode if session restore is disabled AND explicitly configured
      if (config.general && config.general.restoreSession === false && config.general.splitViewOnStartup && !isSplitMode) {
        await toggleSplitMode();
      }

      // Check for app updates asynchronously in background (deferred 2.5s to keep startup 0ms smooth)
      // (general.checkUpdates = false: no timer and no request; About MD-Memo > Check now still works)
      if (updateCheckAtStartup()) {
        setTimeout(() => {
          if (updateCheckAtStartup()) checkForAppUpdates();
        }, 2500);
      }
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

  // ---- The update check (UX review I2), About MD-Memo (I1) and the Help menu ----
  // Nothing here runs at start-up except the one timer that asks GitHub for the latest release number, and only when
  // general.checkUpdates is not false. About MD-Memo > Check now works whatever that setting says.
  const UPDATE_API_URL = 'https://api.github.com/repos/youshinh/md-memo/releases/latest';
  const HELP_DOCS_URL = 'https://youshinh.github.io/md-memo/';
  const UPDATE_CHECK_TIMEOUT_MS = 15000;

  // What the last check found. status: idle (never asked) | checking | current | newer | error. The dot on the Help button, the Help
  // menu and the About dialog all read it.
  let updateState = { status: 'idle', latest: '', current: '', url: '' };
  let updateCheckPromise = null;
  let updateNoticeQueuedFor = ''; // the version whose "newer version" notice is on screen or waiting its turn (see showStartupNotice)
  let appVersionCache = '';

  // general.checkUpdates: on unless the settings say false (an old config has no such key).
  function updateCheckAtStartup() {
    return !(config.general && config.general.checkUpdates === false);
  }

  async function appVersionString() {
    let currentVersion = '1.10.14';
    if (window.backend && typeof window.backend.getAppVersion === 'function') {
      try {
        const v = await window.backend.getAppVersion();
        if (v) currentVersion = String(v).replace(/^v/, '').trim();
      } catch (_) {}
    }
    appVersionCache = currentVersion;
    return currentVersion;
  }

  function releaseNotesUrlFor(version) {
    return (window.AboutDialog && window.AboutDialog.releaseNotesUrl) ? window.AboutDialog.releaseNotesUrl(version) : 'https://github.com/youshinh/md-memo/releases';
  }

  // The dot on the Help button: shown for a newer version the person has not looked at yet (opening the Help menu counts as looking).
  function applyUpdateBadge() {
    if (!helpUpdateBadge || !btnHelp) return;
    if (updateState.status === 'checking' || updateState.status === 'error') return; // keep what is shown until an answer comes
    let dismissedVersion = '';
    try {
      dismissedVersion = localStorage.getItem('mdmemo_dismissed_update_version') || '';
    } catch (_) {}
    if (updateState.status === 'newer' && dismissedVersion !== updateState.latest) {
      if (helpButtonVisible()) {
        helpUpdateBadge.classList.remove('hidden');
        const tooltip = `${t('helpUpdateAvailable') || 'Update available'}: v${updateState.latest}`;
        btnHelp.title = tooltip;
        helpUpdateBadge.title = tooltip;
      } else {
        // The toolbar layout hides the Help button (a fresh installation does), so the dot has nowhere to sit: say it once instead.
        helpUpdateBadge.classList.add('hidden');
        if (!(window.AboutDialog && window.AboutDialog.isOpen && window.AboutDialog.isOpen()) && updateNoticeQueuedFor !== updateState.latest) {
          const latest = updateState.latest;
          updateNoticeQueuedFor = latest; // a second check while it waits must not queue it twice
          showStartupNotice(t('updateFoundHidden', { latest: 'v' + latest }), 9000, () => {
            try {
              localStorage.setItem('mdmemo_dismissed_update_version', latest);
            } catch (_) {}
          });
        }
      }
    } else {
      helpUpdateBadge.classList.add('hidden');
    }
  }

  function helpButtonVisible() {
    if (!btnHelp || typeof btnHelp.getBoundingClientRect !== 'function') return false;
    const rect = btnHelp.getBoundingClientRect();
    return !!(rect && (rect.width || rect.height));
  }

  // Asks GitHub for the latest release and records the answer in updateState. Never throws. While a check is running, a second
  // call gets the same promise. updateState.status is 'checking' as soon as this returns, so a dialog can show it at once.
  function checkForAppUpdates() {
    if (updateCheckPromise) return updateCheckPromise;
    updateState = Object.assign({}, updateState, { status: 'checking' });
    const run = (async () => {
      let timer = null;
      try {
        // A proxy or captive portal can hold the connection open for good: without a limit About says "Checking..." for ever and
        // Check now stays disabled. Past 15 s the check counts as failed (it can be asked again).
        const control = typeof AbortController === 'function' ? new AbortController() : null;
        const limit = new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (control) control.abort();
            reject(new Error('timeout'));
          }, UPDATE_CHECK_TIMEOUT_MS);
        });
        const ask = (async () => {
          const init = { headers: { 'Accept': 'application/vnd.github.v3+json' }, cache: 'no-cache' };
          if (control) init.signal = control.signal;
          const resp = await fetch(UPDATE_API_URL, init);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.json();
        })();
        ask.catch(() => {}); // the loser of the race may fail later: nobody is waiting for it
        const data = await Promise.race([ask, limit]);
        const latestTag = String((data && data.tag_name) || '').replace(/^v/, '').trim();
        if (!latestTag) throw new Error('no release tag');
        const currentVersion = await appVersionString();
        updateState = {
          status: isNewerVersion(latestTag, currentVersion) ? 'newer' : 'current',
          latest: latestTag,
          current: currentVersion,
          url: releaseNotesUrlFor(latestTag)
        };
      } catch (e) {
        // Network and rate-limit failures are silent at start-up; the About dialog says it when the person asked.
        updateState = Object.assign({}, updateState, { status: 'error' });
      } finally {
        clearTimeout(timer);
      }
      applyUpdateBadge();
      return updateState;
    })();
    updateCheckPromise = run;
    const done = () => { if (updateCheckPromise === run) updateCheckPromise = null; };
    run.then(done, done);
    return run;
  }

  function openExternalUrl(url) {
    if (window.backend && window.backend.openExternal) {
      window.backend.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  function openHelpDocs() {
    openExternalUrl(HELP_DOCS_URL);
  }

  // About MD-Memo (about_dialog.js). The host hands the module everything it needs, so it stays free of app.js state.
  function openAboutDialog() {
    closeHelpMenu(false);
    if (!window.AboutDialog) {
      openHelpDocs();
      return null;
    }
    return window.AboutDialog.open({
      t: t,
      language: (config.general && config.general.language) || 'en',
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
      getVersion: () => appVersionCache,
      getInfo: async () => {
        let info = null;
        if (window.backend && typeof window.backend.getAppInfo === 'function') {
          try { info = await window.backend.getAppInfo(); } catch (_) { info = null; }
        }
        const version = await appVersionString();
        return info ? Object.assign({}, info, { version: info.version || version }) : { version: version };
      },
      getUpdateState: () => updateState,
      checkNow: () => checkForAppUpdates(),
      isCheckAtStartup: updateCheckAtStartup,
      openExternal: openExternalUrl,
      openFolder: async (folder) => {
        if (!window.backend || !window.backend.openPath) throw new Error('openPath is unavailable');
        await window.backend.openPath(folder, '');
      },
      copyText: copyTextToClipboard
    }).catch((e) => {
      console.warn('The About dialog could not open:', e);
    });
  }

  // The Help button opens a small menu under itself: the online manual, the release notes when an update is known, About MD-Memo.
  let helpMenuHandlers = null;

  function isHelpMenuOpen() {
    return !!helpMenu && !helpMenu.classList.contains('hidden');
  }

  function closeHelpMenu(refocus) {
    if (!isHelpMenuOpen()) return;
    helpMenu.classList.add('hidden');
    if (btnHelp) btnHelp.setAttribute('aria-expanded', 'false');
    if (helpMenuHandlers) {
      document.removeEventListener('mousedown', helpMenuHandlers.down, true);
      document.removeEventListener('keydown', helpMenuHandlers.key, true);
      helpMenuHandlers = null;
    }
    if (refocus && btnHelp && typeof btnHelp.focus === 'function') btnHelp.focus();
  }

  function openHelpMenu() {
    // A Help button the toolbar layout has hidden (or a page without the menu markup) has nothing to anchor a menu to: the click
    // does what it always did.
    const rect = (helpMenu && btnHelp && typeof btnHelp.getBoundingClientRect === 'function') ? btnHelp.getBoundingClientRect() : null;
    if (!rect || (!rect.width && !rect.height)) {
      openHelpDocs();
      return;
    }
    if (isHelpMenuOpen()) {
      closeHelpMenu(true);
      return;
    }
    const known = updateState.status === 'newer';
    if (helpMenuUpdate) helpMenuUpdate.classList.toggle('hidden', !known);
    if (known) {
      if (helpMenuUpdateText) helpMenuUpdateText.textContent = t('helpMenuUpdateText', { latest: 'v' + updateState.latest, current: 'v' + updateState.current });
      // Having seen the notice is what dismisses the dot (a click on the button used to do it).
      try {
        localStorage.setItem('mdmemo_dismissed_update_version', updateState.latest);
      } catch (_) {}
      applyUpdateBadge();
    }
    helpMenu.setAttribute('aria-label', t('helpTitle'));
    helpMenu.style.top = Math.round(rect.bottom + 6) + 'px';
    helpMenu.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px';
    helpMenu.classList.remove('hidden');
    if (btnHelp) btnHelp.setAttribute('aria-expanded', 'true');
    helpMenuHandlers = {
      down: (e) => {
        if (helpMenu.contains(e.target) || (btnHelp && btnHelp.contains(e.target))) return;
        closeHelpMenu(false);
      },
      key: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeHelpMenu(true);
        } else if (e.key === 'Tab') {
          // Focus goes back to the Help button first, so that this very Tab moves on from there (the menu is the last thing in the
          // page: leaving it hidden-but-focused sent Tab to the top of the page)
          closeHelpMenu(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const items = Array.prototype.filter.call(helpMenu.querySelectorAll('button'), (b) => b.offsetParent !== null);
          if (!items.length) return;
          e.preventDefault();
          const at = items.indexOf(document.activeElement);
          const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
          items[next].focus();
        }
      }
    };
    document.addEventListener('mousedown', helpMenuHandlers.down, true);
    document.addEventListener('keydown', helpMenuHandlers.key, true);
    const first = known ? btnHelpMenuNotes : btnHelpMenuManual;
    if (first && typeof first.focus === 'function') first.focus();
  }

  if (btnHelpMenuManual) btnHelpMenuManual.onclick = () => { closeHelpMenu(false); openHelpDocs(); };
  if (btnHelpMenuAbout) btnHelpMenuAbout.onclick = () => { openAboutDialog(); };
  if (btnHelpMenuNotes) {
    btnHelpMenuNotes.onclick = () => {
      closeHelpMenu(false);
      openExternalUrl(updateState.url || releaseNotesUrlFor(updateState.latest));
    };
  }

  // ---- Support for the JSON-RPC writes (window.__mdMemoRPC below; the Go side is app_rpc.go and app_rpc_write.go) ----
  // Nothing here runs until an RPC call arrives.

  // An error the caller must see as a JSON-RPC error of its own carries its kind as a "[kind] " prefix; the Go side
  // (jsErrorResponse) maps not_found to -32002, conflict to -32001 and invalid_params to -32602. Any other error is -32603.
  function rpcFail(kind, message) {
    const err = new Error('[' + kind + '] ' + message);
    err.rpcKind = kind;
    throw err;
  }

  // The hash of a note text: first 8 bytes of SHA-256 of its UTF-8, the same as computeHash in app_rpc.go (note_hash.js).
  function rpcHash(text) {
    if (!window.NoteHash) throw new Error('note_hash.js is not loaded');
    return window.NoteHash.hash16(text);
  }

  // The tab an RPC call names: no id = the tab that is active in the primary pane (as before); an id that names no tab is an error.
  function resolveTab(tabId) {
    if (!tabId) {
      const active = getTab(activeTabId) || tabs[0];
      if (!active) rpcFail('not_found', 'no tab is open');
      return active;
    }
    const tab = getTab(tabId);
    if (!tab) rpcFail('not_found', 'no such tab: ' + tabId);
    return tab;
  }

  // Text in the editor has LF line endings (a textarea hands back LF whatever it was given), so RPC text is made LF too:
  // a tab that is not on screen then holds exactly what it will show, and its hash does not change when it is selected.
  function lfText(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  // 1-based line / column (a column counts UTF-16 units, lines split on \n) -> offsets into the text, clamped, end >= start.
  function rangeOffsets(content, startLine, startCol, endLine, endCol) {
    const lines = content.split('\n');
    let startOffset = 0;
    for (let i = 0; i < Math.min(startLine - 1, lines.length); i++) startOffset += lines[i].length + 1;
    startOffset += Math.max(0, startCol - 1);
    let endOffset = 0;
    for (let i = 0; i < Math.min(endLine - 1, lines.length); i++) endOffset += lines[i].length + 1;
    endOffset += Math.max(0, endCol - 1);
    startOffset = Math.max(0, Math.min(startOffset, content.length));
    endOffset = Math.max(startOffset, Math.min(endOffset, content.length));
    return { start: startOffset, end: endOffset };
  }

  // Replaces [start, end) of an editor's text through the browser's editing command, so Ctrl+Z undoes it, and puts back what
  // that would disturb: the focused element, the user's caret (moved along with the edit) and scroll, and which pane is the
  // active one. `expected` is the text the editor must hold afterwards; if the command was refused it is set directly.
  function editThroughEditor(editor, start, end, text, expected, mapOffset) {
    const snap = {
      activeEl: document.activeElement,
      start: editor.selectionStart,
      end: editor.selectionEnd,
      dir: editor.selectionDirection || 'none',
      scrollTop: editor.scrollTop || 0
    };
    const pane = activePane;
    editor.focus();
    editor.setSelectionRange(start, end);
    let ok = false;
    try {
      if (!text && start === end) ok = true; // nothing to insert or remove ('delete' on a bare caret would eat a character)
      else ok = text ? execInsertTextExact(editor, text) : document.execCommand('delete');
    } catch (e) {
      ok = false;
    }
    if (!ok || editor.value !== expected) editor.value = expected;
    restoreEditorUserContext(editor, snap, mapOffset(snap.start), mapOffset(snap.end));
    if (!snap.activeEl || snap.activeEl === document.body) {
      if (typeof editor.blur === 'function') editor.blur(); // nothing had the focus before
    }
    if (activePane !== pane) {
      activePane = pane;
      updatePaneFocusClasses();
      refreshTabActiveClasses();
    }
  }

  // What a user edit does to a tab that is not typed into directly: dirty, the automatic title, the autosave for a tab with
  // a file (the tab's own autosave timer, wherever the tab is shown), the session save, the tab bar.
  function afterRpcTabEdit(tab) {
    tab.isDirty = true;
    if (tab.isAutoTitle && !tab.path) {
      const body = tab.content;
      const derived = deriveTitleFromContent(body);
      if (derived && tab.title !== `${derived}.md`) {
        tab.title = `${derived}.md`;
        if (isSplitMode && secondaryTabId === tab.id && secondaryPaneTitle) secondaryPaneTitle.textContent = tab.title;
      }
    }
    armAutoSave(tab);
    saveSessionDebounced();
    renderTabs();
  }

  // Writes text into a tab wherever it is, WITHOUT selecting it or focusing anything: mode 'set' replaces the whole note,
  // 'append' adds at the end, 'replace' replaces the range {startLine, startCol, endLine, endCol}. Three places, the
  // precedent of applyAnchorReplacement: the tab active in the primary pane and the tab in the split editor are edited
  // through their editor (undoable; the user's caret and focus stay), any other tab is a plain string edit of tab.content
  // (it has no undo history: the RPC result's previous_hash is how a caller checks what it was). Returns the text the tab holds now.
  function writeTabText(tab, text, mode, range) {
    text = lfText(text);
    const before = getTabText(tab.id);
    let start = 0;
    let end = before.length;
    if (mode === 'append') {
      start = end;
    } else if (mode === 'replace') {
      const r = range || {};
      ({ start, end } = rangeOffsets(before, r.startLine, r.startCol, r.endLine, r.endCol));
    }
    const after = before.slice(0, start) + text + before.slice(end);
    const removed = end - start;
    // Where a position of the old text is afterwards: before the edit it stays, after it it moves by the length change,
    // inside the replaced part it lands behind the new text (the whole note being replaced keeps the caret's offset).
    const mapOffset = (off) => {
      if (mode === 'set') return Math.min(off, after.length);
      if (off <= start) return off;
      if (off >= end) return off + text.length - removed;
      return start + text.length;
    };

    try {
      if (tab.id === activeTabId && editorEl) {
        clearGhostText();
        editThroughEditor(editorEl, start, end, text, after, mapOffset);
        onEditorInput(editorEl, tab, true); // the same bookkeeping as typing: dirty, title, autosave, session, split sync
        cachedLineCount = 0;
        updateLineNumbers();
        updateStatusBar();
        if (isPreviewMode) renderPreview();
        renderTabs();
      } else if (isSplitMode && secondaryViewMode === 'editor' && tab.id === secondaryTabId && editorSecondary) {
        editThroughEditor(editorSecondary, start, end, text, after, mapOffset);
        tab.content = editorSecondary.value;
        afterRpcTabEdit(tab);
        updateSecondaryLineNumbers();
        updateStatusBar();
      } else {
        tab.content = after;
        afterRpcTabEdit(tab);
        if (isSplitMode && secondaryViewMode === 'preview' && tab.id === secondaryTabId) renderSecondaryPreview();
      }
    } catch (err) {
      // If the text changed, the write HAPPENED and only refreshing the screen failed: report success (an error would make
      // the caller retry, and an append or a range replace would then be applied twice). Nothing written: a real error.
      if (getTabText(tab.id) === before) throw err;
      console.warn('RPC write applied, but updating the screen failed:', err);
      tab.content = getTabText(tab.id);
      tab.isDirty = true;
    }
    return getTabText(tab.id);
  }

  // Path comparison for "is this file already open": separators are not told apart, and a Windows path (drive letter or UNC)
  // is compared without regard to case.
  function pathKey(p) {
    let key = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\//.test(key) || key.indexOf('//') === 0) key = key.toLowerCase();
    return key;
  }

  function findTabByPath(path) {
    const key = pathKey(path);
    if (!key) return null;
    return tabs.find((t) => t.path && pathKey(t.path) === key) || null;
  }

  // A file that is opened again while a tab already shows it: `text` is what was just read from the file (undefined: nothing was read).
  // A tab with no unsaved text takes it, so it shows the file as it is now. A tab with unsaved text keeps its own (what was typed there
  // is not on disk). Resolves to 'refreshed', 'kept' (unsaved text that differs from the file's) or 'unchanged'.
  function adoptDiskText(tab, text, rawText) {
    if (typeof text !== 'string') return 'unchanged';
    const same = (a) => a === text || lfText(a) === lfText(text);
    if (tabHasUnsavedText(tab)) {
      if (!same(getTabText(tab.id) || '')) return 'kept';
      rememberDiskText(tab, text, rawText); // the tab's own text is the file's: that is what the file holds
      return 'unchanged';
    }
    rememberDiskText(tab, text, rawText);
    if (same(tab.content)) return 'unchanged';
    tab.content = text;
    if (activeTabId === tab.id && editorEl) {
      const caret = Math.min(editorEl.selectionStart, text.length);
      editorEl.value = text;
      editorEl.selectionStart = editorEl.selectionEnd = caret;
      tab.cursorPos = caret;
      cachedLineCount = 0;
      updateLineNumbers();
      if (isPreviewMode) renderPreview();
    }
    if (isSplitMode && secondaryTabId === tab.id) updateSecondaryPane();
    saveSessionDebounced();
    return 'refreshed';
  }

  // The tab now knows what its file holds: the fingerprint of that text (the next save sends it, and the Go side refuses to write
  // over a file that holds something else, see disk_sync.js) and the file's own line ending, which a save writes back. `rawText`
  // is the text as read, when `text` has already been turned into LF.
  function rememberDiskText(tab, text, rawText) {
    if (!window.DiskSync || typeof text !== 'string') return;
    tab.diskSig = window.DiskSync.sum(text);
    if (window.DiskSync.detectEol(typeof rawText === 'string' ? rawText : text) === 'crlf') tab.eol = 'crlf';
    else delete tab.eol;
    tab.diskConflict = false;
  }

  // A tab's file has been read again (the watcher saw it change, or the app has just started): bring the tab in line with it.
  // Returns 'refreshed' (the tab had nothing unsaved and now shows the file's text), 'conflict' (the tab has unsaved text AND the
  // file changed under it: see flagDiskConflict) or '' (the file is what the tab knows, or nothing can be told).
  function reconcileWithDisk(tab, res) {
    if (!window.DiskSync || !res || typeof res.content !== 'string') return '';
    const plan = window.DiskSync.planExternalChange({
      tabSig: tab.diskSig,
      diskSig: window.DiskSync.sum(res.content),
      hasUnsavedText: tabHasUnsavedText(tab)
    });
    if (plan === 'reload') return adoptDiskText(tab, res.content, res.content) === 'refreshed' ? 'refreshed' : '';
    if (plan === 'conflict') {
      flagDiskConflict(tab);
      return 'conflict';
    }
    return '';
  }

  // slot_agent.js's file watcher callback read a changed file: a note that shows it follows it (see reconcileWithDisk). The app's
  // own save comes through here too and is recognised by its fingerprint.
  window.__onDiskTextSeen = function (path, res) {
    const tab = path ? findTabByPath(path) : null;
    if (!tab) return;
    if (reconcileWithDisk(tab, res) === 'refreshed') showMessage(t('diskChangedReloaded', { title: tab.title || '' }), 4000);
  };

  // The Go side wrote `text` to the file of a tab without going through a save (a slot or agent run saves the note first so that the
  // agent sees it): the file holds exactly that text now, so the next save must compare against it, not against the older text.
  window.__onDiskTextWritten = function (path, text) {
    const tab = path ? findTabByPath(path) : null;
    if (!tab || !window.DiskSync || typeof text !== 'string') return;
    tab.diskSig = window.DiskSync.sum(text);
    tab.diskConflict = false;
  };

  // The tabs of the last session show the text they held when the app closed. A file that changed in the meantime (a Git pull, a
  // sync client, another editor) would be written over by the next save of a tab that still shows the old text. After the first
  // paint, each file tab is checked against its file: one with nothing unsaved shows the new text, one with unsaved text is
  // flagged (autosave pauses, Ctrl+S asks). A file that is gone or unreadable leaves its tab as it is.
  async function verifyRestoredTabsAgainstDisk() {
    if (!window.DiskSync || !window.backend || !window.backend.readFileByPath) return;
    const refreshed = [];
    for (const tab of tabs.filter((x) => x.path).slice(0, 30)) {
      let res = null;
      try {
        res = await window.backend.readFileByPath(tab.path);
      } catch (e) {
        continue;
      }
      if (getTab(tab.id) !== tab) continue;
      if (reconcileWithDisk(tab, res) === 'refreshed') refreshed.push(tab);
    }
    if (refreshed.length === 1) showMessage(t('diskChangedWhileClosed', { title: refreshed[0].title || '' }), 5000);
    else if (refreshed.length > 1) showMessage(t('diskChangedWhileClosedMany', { count: refreshed.length }), 5000);
    if (refreshed.length) renderTabs();
  }

  // True when a tab holds text that is not in its file: it is marked unsaved, or (the tab on screen) the editor differs from the tab.
  function tabHasUnsavedText(tab) {
    if (tab.isDirty) return true;
    if (tab.id !== activeTabId || !editorEl) return false;
    const live = editorEl.value;
    return live !== tab.content && lfText(live) !== lfText(tab.content); // the plain comparison first: a big note is scanned only when it differs
  }

  // No two tabs own one file. `tab` is being bound to `path` (Save As, RPC buffer.save) and another tab already shows that file, so
  // the other one is out of date. With no unsaved text it is closed; with some it stays as a note of its own (no file, its text and
  // its unsaved mark kept), so its edits are not lost and it can never be saved over the file. Returns '', 'closed' or 'detached'.
  function releasePathFromOtherTabs(tab, path) {
    const key = pathKey(path);
    if (!key) return '';
    let outcome = '';
    tabs.filter((other) => other !== tab && other.path && pathKey(other.path) === key).forEach((other) => {
      if (tabHasUnsavedText(other)) {
        other.path = '';
        other.isAutoTitle = false;
        other.isDirty = true;
        if (other.id === activeTabId && window.backend && window.backend.unwatchActiveFile) window.backend.unwatchActiveFile();
        outcome = 'detached';
      } else {
        removeTab(other.id);
        if (!outcome) outcome = 'closed';
      }
    });
    return outcome;
  }

  // Line endings do not count when a tab's text is compared with its file.
  function sameTextIgnoringEol(a, b) {
    return lfText(a) === lfText(b);
  }

  // RPC tab.close: the tab's own answer, never waiting for a dialog. Resolves to {closed, reason?}.
  //   if_saved: closes without any prompt, and only when the tab has a file whose current content (read now, through the
  //     same bound reader the app uses) equals the tab's text; the text is looked at again after the read, so an edit in
  //     between cancels the close. Otherwise {closed:false, reason:'unsaved'}.
  //   no if_saved: a tab without unsaved changes is closed; one with them gets the GUI's own save prompt (not awaited) and
  //     the answer is {closed:false, reason:'prompt'}.
  async function closeTabForRpc(tabId, ifSaved) {
    if (!tabId) rpcFail('invalid_params', 'tab_id is required');
    const tab = getTab(tabId);
    if (!tab) rpcFail('not_found', 'no such tab: ' + tabId);

    if (ifSaved) {
      if (!tab.path) return { closed: false, reason: 'unsaved' };
      const shown = getTabText(tab.id);
      let onDisk = null;
      try {
        const res = window.backend && window.backend.readFileByPath ? await window.backend.readFileByPath(tab.path) : null;
        if (res && typeof res.content === 'string') onDisk = res.content;
      } catch (e) {
        onDisk = null; // gone or unreadable: it cannot be shown to be saved
      }
      const now = getTabText(tab.id);
      if (now === null) return { closed: false, reason: 'gone' }; // closed by someone else while the file was read
      if (onDisk === null || now !== shown || !sameTextIgnoringEol(onDisk, now)) return { closed: false, reason: 'unsaved' };
      removeTab(tab.id);
      return { closed: true };
    }

    if (!tab.isDirty) {
      removeTab(tab.id);
      return { closed: true };
    }
    closeTab(tab.id); // the usual Save / Don't save / Cancel prompt; the RPC must not wait for a person
    return { closed: false, reason: 'prompt' };
  }

  // Expose programmatic RPC interface for CLI, Unix pipe, and Agent operations
  window.__mdMemoRPC = {
    getBuffer: function (tabId) {
      const targetTab = resolveTab(tabId);
      const content = getTabText(targetTab.id) || '';
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

    // The RPC writes (buffer.set / append / replace): ONE call checks expected_hash / expected_generation against the live text
    // and writes, so nothing can slip in between the check and the write. req: { tabId, mode: 'set' | 'append' | 'replace',
    // content, range?: {startLine, startCol, endLine, endCol}, expectedHash?, expectedGeneration?, currentGeneration? }
    // (currentGeneration is the process-wide counter the Go side owns: it counts RPC writes only).
    // A tab that is not on screen is written too, without being selected. Errors: not_found, conflict (see rpcFail).
    writeText: function (req) {
      req = req || {};
      const tab = resolveTab(req.tabId);
      const previousHash = rpcHash(getTabText(tab.id));
      if (req.expectedHash && req.expectedHash !== previousHash) {
        rpcFail('conflict', 'conflict: expected hash ' + req.expectedHash + ' but buffer is at ' + previousHash);
      }
      if (req.expectedGeneration > 0 && req.expectedGeneration !== req.currentGeneration) {
        rpcFail('conflict', 'conflict: expected generation ' + req.expectedGeneration + ' but buffer is at ' + req.currentGeneration);
      }
      writeTabText(tab, req.content, req.mode, req.range);
      return { tab_id: tab.id, previous_hash: previousHash, hash: rpcHash(getTabText(tab.id)) };
    },

    // The older positional forms of the same writes (no lock). They no longer switch tabs or take the focus.
    setBuffer: function (text, tabId) {
      writeTabText(resolveTab(tabId), text, 'set');
      return true;
    },

    appendBuffer: function (text, tabId) {
      writeTabText(resolveTab(tabId), text, 'append');
      return true;
    },

    replaceRange: function (startLine, startCol, endLine, endCol, text, tabId) {
      writeTabText(resolveTab(tabId), text, 'replace', { startLine: startLine, startCol: startCol, endLine: endLine, endCol: endCol });
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

    // An id that names no tab is an error (not_found), not a tab-less window.
    switchTab: function (tabId) {
      selectTab(resolveTab(tabId).id);
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

    // RPC tab.new. spec: { title?, path?, content?, encoding?, background? }. With a path (the Go side has read and decoded
    // the file) a file that is already open in some tab is not opened again: that tab comes back with existing:true (and is
    // shown unless background). background: the new tab is added to the bar and nothing is selected or focused.
    openTab: function (spec) {
      spec = spec || {};
      const background = !!spec.background;
      const existing = spec.path ? findTabByPath(spec.path) : null;
      if (existing) {
        // the text the Go side has just read from the file replaces the tab's when the tab has no unsaved text (see adoptDiskText)
        adoptDiskText(existing, typeof spec.content === 'string' ? lfText(spec.content) : undefined, spec.content);
        if (!background) showTab(existing.id);
        return { id: existing.id, title: existing.title || '', path: existing.path || '', existing: true };
      }
      const tab = createTab(
        spec.title || undefined,
        typeof spec.content === 'string' ? lfText(spec.content) : undefined,
        spec.path || '',
        spec.encoding || undefined,
        background
      );
      // the page was given LF text: the file's own line ending is in what Go read
      if (spec.path && typeof spec.content === 'string') rememberDiskText(tab, lfText(spec.content), spec.content);
      return { id: tab.id, title: tab.title || '', path: tab.path || '', existing: false };
    },

    closeTab: function (tabId) {
      closeTab(tabId || activeTabId);
      return true;
    },

    // RPC tab.close: see closeTabForRpc. Resolves to {closed, reason?}.
    closeTabChecked: function (tabId, ifSaved) {
      return closeTabForRpc(tabId, !!ifSaved);
    },

    // RPC buffer.save, step 1: what the Go side needs to validate and write. The text is the live one (editor or tab).
    prepareSave: function (tabId) {
      const tab = resolveTab(tabId);
      const content = getTabText(tab.id);
      return {
        tab_id: tab.id,
        content: content,
        hash: rpcHash(content),
        path: tab.path || '',
        encoding: tab.encoding || 'UTF-8',
        title: tab.title || '',
        eol: tab.eol || '',
        disk_sig: tab.diskSig || ''
      };
    },

    // RPC buffer.save, step 2, after the file was written: bind the tab to it the way the GUI's Save As does (path, title,
    // encoding, clean) and start watching it if it is the active file (as selectTab does). If the text is no longer the one
    // that was written (the user edited during the save) nothing is bound: conflict. info: { path, encoding, hash, bytes }.
    commitSave: function (tabId, info) {
      info = info || {};
      const tab = getTab(tabId);
      if (!tab) rpcFail('not_found', 'no such tab: ' + tabId + ' (it was closed while saving; the file was written)');
      if (rpcHash(getTabText(tab.id)) !== info.hash) {
        rpcFail('conflict', 'the note was edited while it was being saved (the file holds the earlier text)');
      }
      releasePathFromOtherTabs(tab, info.path);
      tab.path = info.path;
      tab.title = String(info.path).split(/[\\/]/).pop();
      tab.isAutoTitle = false;
      tab.encoding = info.encoding || tab.encoding;
      if (info.sig) { tab.diskSig = info.sig; tab.diskConflict = false; } // the file now holds exactly the text that was written
      tab.isDirty = false;
      if (tab.id === activeTabId) {
        if (statEncoding) statEncoding.textContent = tab.encoding;
        if (window.backend && window.backend.watchActiveFile) window.backend.watchActiveFile(tab.path);
      }
      if (isSplitMode && secondaryTabId === tab.id && secondaryPaneTitle) {
        secondaryPaneTitle.textContent = tab.title;
        secondaryPaneTitle.title = tab.path;
      }
      renderTabs();
      updateStatusBar();
      saveSessionDebounced();
      showMessage(`${t('saveSuccess')}${tab.title}`, 2500);
      return { tab_id: tab.id, path: tab.path, title: tab.title };
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
          // Only a tab that is on screen has a live selection; any other existing tab is brought forward first.
          if (!getTab(tabId)) rpcFail('not_found', 'no such tab: ' + tabId);
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
          if (!getTab(tabId)) rpcFail('not_found', 'no such tab: ' + tabId);
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
  // forTab (optional): another note than the active one, when the asset belongs to it.
  async function getNoteDir(forTab) {
    const tab = forTab || getActiveTab();
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
    // Agent runs: (agentKey, definition) -> Promise<boolean>, false when the user declines a risky agent.
    confirmAgentRun: confirmAgentRun,
    runCommandTask: runCommandTask,
    cancelCommandTask: cancelCommandTask,
    // The live text of a note wherever it is shown, or null when the tab is gone.
    getTabText: getTabText,
    // The pane that shows a note right now (the focused one when both do), or null when it is not on screen.
    editorForTab: editorForTab
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
    openAboutDialog,
    checkForAppUpdates,
    askDestination,
    config
  };

  initApp();
})();
