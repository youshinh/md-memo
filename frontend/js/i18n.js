// MD-Notepad Zero-Overhead Lightweight i18n Translation Dictionaries
const I18N = {
  en: {
    // Header
    open: "Open",
    save: "Save",
    preview: "Preview",
    edit: "Edit",
    settings: "Settings",
    newTabTitle: "New Tab (Ctrl+N / Ctrl+T)",
    openFileTitle: "Open File (Ctrl+O)",
    saveFileTitle: "Save (Ctrl+S)",
    togglePreviewTitle: "Toggle Edit / Preview (Ctrl+P)",
    settingsTitle: "Settings",
    untitled: "Untitled",

    // Editor
    editorPlaceholder: "Type markdown here... (Press Tab to accept autocomplete, Ctrl+L to prompt LLM)",
    rendererLoading: "Loading renderer...",
    mermaidError: "Mermaid syntax error: ",

    // Status Bar
    lineCol: "Ln {line}, Col {col}",
    charCount: "{count} chars",
    selectionCount: "(Sel: {count})",
    llmProcessing: "LLM processing... (typing enabled)",
    statAutocompleteOn: "Predict: ON",
    statAutocompleteOff: "Predict: OFF",
    statPredicting: "Predicting...",
    statAutocompleteError: "Predict: Error",
    statAutocompleteErrorTitle: "Autocomplete error: ",
    statAutocompleteTooltip: "Autocomplete is enabled (Accept with Tab or → key)",
    statAutocompleteOffTooltip: "Autocomplete is disabled (Click to toggle)",
    statAutosaveOn: "Autosave: ON",
    statAutosaveOff: "Autosave: OFF",
    statEncodingTooltip: "Click to toggle encoding",

    // Context Menu
    ctxUndo: "Undo ",
    ctxRedo: "Redo ",
    ctxCut: "Cut ",
    ctxCopy: "Copy ",
    ctxPaste: "Paste ",
    ctxSelectAll: "Select All ",
    ctxFind: "Find... ",
    ctxReplace: "Replace... ",
    ctxGotoLine: "Go to Line... ",
    ctxPromptLLM: "Prompt LLM with Selection... ",
    ctxExportPlainText: "Export as Plain Text (.txt)...",
    ctxInsertDateTime: "Insert Current Date & Time ",
    ctxTogglePreview: "Toggle Preview ",
    ctxSettings: "Settings...",

    // Find & Replace & Navigation
    findPlaceholder: "Find...",
    replacePlaceholder: "Replace...",
    btnReplace: "Replace",
    btnReplaceAll: "Replace All",
    btnGo: "Go",
    gotoLineTitle: "Go to Line",
    gotoLinePrompt: "Line number:",
    noMatches: "No results",
    matchCount: "{current} of {total}",

    // LLM Modal
    llmModalTitle: "Prompt & Instruct LLM",
    llmTargetLabel: "Target Text:",
    llmInstructionLabel: "Additional Instruction (leave empty to send target text as-is):",
    llmInstructionPlaceholder: "e.g. Translate to Japanese, Summarize, Refactor code, Fix bugs, Convert to bullet points...",
    llmModalHint: "Tip: Ctrl+Enter to send immediately, Esc to cancel",
    llmSendBtn: "Send (Ctrl+Enter)",
    llmCancelBtn: "Cancel",

    // Settings Modal
    settingsModalTitle: "Editor & LLM Settings",
    tabTextLLM: "Text LLM",
    tabAutocomplete: "Autocomplete",
    tabVisionLLM: "Vision LLM (Gemini)",
    tabGeneral: "General",

    // Text LLM Tab
    apiBaseUrlLabel: "API Base URL:",
    apiBaseUrlHint: "For local Ollama use <code>http://localhost:11434</code>, LM Studio use <code>http://localhost:1234/v1</code>",
    modelNameLabel: "Model Name:",
    modelNamePlaceholder: "gpt-5.6-luna, claude-sonnet-5, gemini-flash-latest etc.",
    apiKeyLabel: "API Key (for cloud APIs):",
    apiKeyPlaceholder: "sk-... or AIzaSy... (leave empty for local models)",
    systemPromptLabel: "System Prompt:",
    systemPromptDefault: "You are a helpful assistant. Provide concise, accurate markdown responses.",

    // Autocomplete Tab
    enableAutocomplete: "Enable inline autocomplete (Ghost Text)",
    autoDelayLabel: "Suggestion delay (milliseconds):",
    autoMaxTokensLabel: "Max prediction tokens:",

    // Vision LLM Tab
    visionModelLabel: "Vision Model Name:",
    visionModelPlaceholder: "gemini-flash-lite-latest, gemini-flash-latest etc.",
    visionModelHint: "Recommended: <code>gemini-flash-lite-latest</code> / <code>gemini-flash-latest</code> (ultra-fast & low latency)",
    visionApiKeyLabel: "Gemini API Key (Google AI Studio):",
    visionPromptLabel: "Vision prompt instruction:",
    visionPromptDefault: "Transcribe the content of this image (text, diagrams, tables, code, etc.) into structured, faithful Markdown format.",

    // General Tab
    languageLabel: "Language:",
    restoreSessionLabel: "Restore open tabs & unsaved notes on startup",
    autoSaveLabel: "Autosave existing files on 1.5s pause",
    pasteImageOcrLabel: "Automatically transcribe pasted images (Ctrl+V) using Gemini OCR",
    btnSave: "Save",
    btnCancel: "Cancel",

    // Messages
    settingsSaved: "Settings saved successfully",
    saveSuccess: "Saved: ",
    saveError: "Save error: ",
    openError: "Open file error: ",
    exportPlainTextSuccess: "Exported plain text: ",
    exportPlainTextError: "Export error: ",
    encodingSwitched: "Encoding set to {enc} (applied on save)",
    llmResponseInserted: "LLM response inserted",
    llmError: "LLM error: ",
    confirmCloseUnsaved: 'Do you want to save changes to "{title}"?'
  },
  ja: {
    // Header
    open: "開く",
    save: "保存",
    preview: "プレビュー",
    edit: "編集",
    settings: "設定",
    newTabTitle: "新規タブ (Ctrl+N / Ctrl+T)",
    openFileTitle: "ファイルを開く (Ctrl+O)",
    saveFileTitle: "上書き保存 (Ctrl+S)",
    togglePreviewTitle: "編集 / プレビュー切替 (Ctrl+P)",
    settingsTitle: "設定",
    untitled: "無題",

    // Editor
    editorPlaceholder: "ここにマークダウンを入力... (Tabキーで入力予測を確定、Ctrl+L でLLMに指示)",
    rendererLoading: "レンダラー読み込み中...",
    mermaidError: "Mermaid構文エラー: ",

    // Status Bar
    lineCol: "行 {line}, 列 {col}",
    charCount: "{count} 文字",
    selectionCount: "(選択: {count})",
    llmProcessing: "LLM処理中... (入力可能)",
    statAutocompleteOn: "予測: ON",
    statAutocompleteOff: "予測: OFF",
    statPredicting: "予測中...",
    statAutocompleteError: "予測: エラー",
    statAutocompleteErrorTitle: "入力予測エラー: ",
    statAutocompleteTooltip: "入力予測が有効です (Tabまたは→キーで確定)",
    statAutocompleteOffTooltip: "入力予測が無効です (クリックで切替)",
    statAutosaveOn: "自動保存: ON",
    statAutosaveOff: "自動保存: OFF",
    statEncodingTooltip: "クリックで文字コード切替",

    // Context Menu
    ctxUndo: "元に戻す ",
    ctxRedo: "やり直し ",
    ctxCut: "切り取り ",
    ctxCopy: "コピー ",
    ctxPaste: "貼り付け ",
    ctxSelectAll: "すべて選択 ",
    ctxFind: "検索... ",
    ctxReplace: "置換... ",
    ctxGotoLine: "行へ移動... ",
    ctxPromptLLM: "LLMに送信・指示... ",
    ctxExportPlainText: "装飾なしテキスト(.txt)でエクスポート...",
    ctxInsertDateTime: "現在日時を挿入 ",
    ctxTogglePreview: "プレビュー切替 ",
    ctxSettings: "設定...",

    // Find & Replace & Navigation
    findPlaceholder: "検索...",
    replacePlaceholder: "置換...",
    btnReplace: "置換",
    btnReplaceAll: "すべて置換",
    btnGo: "移動",
    gotoLineTitle: "行へ移動",
    gotoLinePrompt: "行番号:",
    noMatches: "見つかりません",
    matchCount: "{current} / {total} 件",

    // LLM Modal
    llmModalTitle: "LLMへの送信・指示",
    llmTargetLabel: "対象テキスト:",
    llmInstructionLabel: "追加の指示 (空欄の場合はそのまま送信):",
    llmInstructionPlaceholder: "例: 日本語に翻訳して、要約して、箇条書きにして、コードをリファクタして、バグを指摘して 等",
    llmModalHint: "ヒント: Ctrl+Enter で即時送信、Esc でキャンセル",
    llmSendBtn: "送信 (Ctrl+Enter)",
    llmCancelBtn: "キャンセル",

    // Settings Modal
    settingsModalTitle: "エディタ & LLM 接続設定",
    tabTextLLM: "テキストLLM",
    tabAutocomplete: "入力予測",
    tabVisionLLM: "画像解析LLM (Gemini)",
    tabGeneral: "基本設定",

    // Text LLM Tab
    apiBaseUrlLabel: "API Base URL:",
    apiBaseUrlHint: "ローカルOllamaの場合は <code>http://localhost:11434</code>、LM Studioの場合は <code>http://localhost:1234/v1</code>",
    modelNameLabel: "モデル名:",
    modelNamePlaceholder: "gpt-5.6-luna, claude-sonnet-5, gemini-flash-latest 等",
    apiKeyLabel: "API Key (外部API用):",
    apiKeyPlaceholder: "sk-... または AIzaSy... (ローカルなら空でOK)",
    systemPromptLabel: "システムプロンプト:",
    systemPromptDefault: "あなたは有能なアシスタントです。質問に対して簡潔かつ正確にマークダウン形式で回答してください。",

    // Autocomplete Tab
    enableAutocomplete: "入力予測 (インライン補完) を有効にする",
    autoDelayLabel: "サジェスト遅延時間 (ミリ秒):",
    autoMaxTokensLabel: "最大予測トークン数:",

    // Vision LLM Tab
    visionModelLabel: "画像解析モデル名 (Vision Model):",
    visionModelPlaceholder: "gemini-flash-lite-latest, gemini-flash-latest 等",
    visionModelHint: "推奨: <code>gemini-flash-lite-latest</code> / <code>gemini-flash-latest</code> (超高速・低遅延)",
    visionApiKeyLabel: "Gemini API Key (Google AI Studio):",
    visionPromptLabel: "画像解析プロンプト指示:",
    visionPromptDefault: "この画像の内容（テキスト、図、表、コード等）を忠実かつ構造化されたマークダウン形式で書き起こしてください。",

    // General Tab
    languageLabel: "表示言語 (Language):",
    restoreSessionLabel: "起動時に前回開いていたタブ・未保存内容を復元する",
    autoSaveLabel: "1.5秒入力停止時に自動保存",
    pasteImageOcrLabel: "画像ペースト(Ctrl+V)時に自動でGemini画像マークダウン化を実行",
    btnSave: "保存",
    btnCancel: "キャンセル",

    // Messages
    settingsSaved: "設定をローカルに保存しました",
    saveSuccess: "保存完了: ",
    saveError: "保存エラー: ",
    openError: "ファイルオープンエラー: ",
    exportPlainTextSuccess: "装飾なしテキストで保存完了: ",
    exportPlainTextError: "テキスト保存エラー: ",
    encodingSwitched: "文字コードを {enc} に設定しました (保存時に適用)",
    llmResponseInserted: "LLMの回答を挿入しました",
    llmError: "LLMエラー: ",
    confirmCloseUnsaved: '"{title}" への変更内容を保存しますか？'
  }
};
