// MD-Memo Autonomous AI Agent Slot & Pipeline Mechanism (v2.2.0-aligned)
// Architecture:
// - AST Lexical Shield (0ns Bypass)
// - Auto-IME Normalization
// - Non-blocking Quick Selector (0ms typing hindrance)
// - Caret-Preserving Debounced Merger
// - Ghost Diff & Local Revert (Esc)
// - Human-in-the-Loop Approval Gates

(function (global) {
  'use strict';

  let slotConfig = {
    version: 2,
    default_agent: "claude-code",
    timeout_seconds: 180,
    hover_peek_enabled: true,
    ghost_diff_duration_ms: 4000,
    agents: {
      "claude-code": {
        command: "claude",
        args: ["-p", "対象ノート: {file}\n指示: {instruction}"],
        description: "Claude Code (高知能・CLI操作・Web調査)",
        aliases: ["claude", "cc"]
      },
      "hermes": {
        command: "ollama",
        args: ["run", "hermes3", "{instruction}"],
        description: "Hermes 3 (完全ローカル・機密保護)"
      },
      "codex": {
        command: "codex",
        args: ["exec", "{instruction}"],
        description: "Codex (高速コード補完・リファクタリング)"
      },
      "agy": {
        command: "agy",
        args: ["-p", "対象ノート: {file}\n指示: {instruction}"],
        description: "Google Antigravity 2.0 (自律リポジトリ開発)",
        aliases: ["antigravity", "gemini"]
      }
    },
    slot_profiles: [
      {
        trigger_open: "{{",
        trigger_close: "}}",
        name: "code",
        agent: "claude-code",
        system_instruction: "前置きや挨拶を一切省き、そのまま動くコードブロックのみを出力してください。"
      },
      {
        trigger_open: "[?",
        trigger_close: "]",
        name: "research",
        agent: "claude-code",
        system_instruction: "Web検索を行い、客観的な数値と一次ソースURLを併記して簡潔に回答してください。"
      },
      {
        trigger_open: "【?",
        trigger_close: "】",
        name: "writing",
        agent: "hermes",
        system_instruction: "外部通信を行わず、論理的で分かりやすいビジネス日本語の箇条書きに整形してください。"
      },
      {
        trigger_open: "[!",
        trigger_close: "!]",
        name: "adversarial",
        agent: "claude-code",
        system_instruction: "甘口の肯定を排し、潜在的リスク、セキュリティ脆弱性、ボトルネックを3点指摘してください。"
      }
    ],
    recipes: [
      {
        trigger_open: "[>>",
        trigger_close: "]",
        name: "deep-research-and-code",
        description: "Web調査 -> リスク反証 -> 実装コード生成",
        steps: [
          "Web検索ツールを用いて最新の公式仕様とベストプラクティスを調査する",
          "調査結果に基づき、潜在的な移行リスクと破壊的変更を指摘する",
          "上記を踏まえ、完全なGoコードを生成する"
        ],
        requires_approval_step: 2,
        self_refine: true
      }
    ]
  };

  // ---- Agents switched off (agents.yaml: enabled: false / disabled_agents) --------------------------------------------
  // The Go side sends the config finalised (pkg/slotagent/enabled.go): no disabled agent under `agents`, their keys in
  // `disabled_agents`, and a default_agent that names an enabled agent. The page holds configs of its own as well (config.json
  // may carry `agents`, and the config merged last wins), so finalizeAgentConfig applies the same rules after every merge into
  // slotConfig: everything below (Auto selector, quick selector, snippets, profiles, recipes) sees enabled agents only.
  // Keep in step with the Go side (tests/agent_switch_parity_test.mjs).
  const AGENT_FALLBACK_ORDER = ['claude-code', 'hermes', 'codex', 'agy'];

  // The enabled agent with a command that comes first in AGENT_FALLBACK_ORDER, else the smallest key ('' when none).
  function firstUsableAgentKey(agents) {
    const list = agents && typeof agents === 'object' ? agents : {};
    const usable = (k) => !!(list[k] && list[k].command);
    for (let i = 0; i < AGENT_FALLBACK_ORDER.length; i++) {
      if (usable(AGENT_FALLBACK_ORDER[i])) return AGENT_FALLBACK_ORDER[i];
    }
    const rest = Object.keys(list).filter(usable).sort();
    return rest.length ? rest[0] : '';
  }

  // Applies `enabled: false` and `disabled_agents` to cfg in place. cfg.agents is replaced, never edited (it may be the persisted
  // config's own object). Afterwards cfg.disabled_agents is the sorted list of the keys switched off (always an array), and a
  // default_agent that named one of them (or, with claude-code disabled, named nothing usable) is the first usable enabled agent.
  function finalizeAgentConfig(cfg) {
    const agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
    const off = new Map(); // lower-case key -> the key as shown
    Object.keys(agents).sort().forEach((k) => {
      if (agents[k] && agents[k].enabled === false) off.set(k.toLowerCase(), k);
    });
    (Array.isArray(cfg.disabled_agents) ? cfg.disabled_agents : []).forEach((item) => {
      let name = String(item == null ? '' : item).trim();
      const lower = name.toLowerCase();
      if (!name || off.has(lower)) return;
      if (AGENT_FALLBACK_ORDER.indexOf(lower) !== -1) name = lower; // "AGY" in the list is still the built-in agy
      off.set(lower, name);
    });
    Object.keys(agents).forEach((k) => {
      if (off.has(k.toLowerCase())) off.set(k.toLowerCase(), k); // a listed key that names an agents entry takes its spelling
    });
    cfg.disabled_agents = Array.from(off.values()).sort();
    if (!off.size) return cfg;

    const enabled = {};
    Object.keys(agents).forEach((k) => {
      if (!off.has(k.toLowerCase())) enabled[k] = agents[k];
    });
    cfg.agents = enabled;
    const dflt = String(cfg.default_agent == null ? '' : cfg.default_agent).trim();
    if (dflt) {
      if (off.has(dflt.toLowerCase())) cfg.default_agent = firstUsableAgentKey(enabled);
      else if (off.has('claude-code') && !(enabled[dflt] && enabled[dflt].command)) cfg.default_agent = firstUsableAgentKey(enabled);
    }
    return cfg;
  }

  // The key (as listed) when `name` is an agent switched off, else null. Aliases do not count: a disabled agent's aliases are free.
  function disabledAgentKey(name) {
    const wanted = String(name || '').trim().replace(/^@/, '').toLowerCase();
    if (!wanted) return null;
    const list = Array.isArray(slotConfig.disabled_agents) ? slotConfig.disabled_agents : [];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase() === wanted) return String(list[i]);
    }
    return null;
  }

  // Every agent is switched off: there is nothing to run and nothing to offer.
  function noAgentEnabled() {
    return Object.keys(slotConfig.agents || {}).length === 0 && Array.isArray(slotConfig.disabled_agents) && slotConfig.disabled_agents.length > 0;
  }

  // State
  let activeRequests = new Map(); // reqId -> meta { reqId, startOffset, endOffset, oldContent, executingText, openD, closeD }
  let lastTypingTime = 0;
  let pendingMergeQueue = [];
  let mergeDebounceTimer = null;
  let selectorEl = null;
  let selectorSelectedIndex = 0;
  let selectorTriggerInfo = null; // { open, close, startPos }
  let runButtonEl = null;
  let runButtonEditor = null; // the editor the currently-shown button targets
  let runButtonTimer = null; // debounce for the cheap caret-position scan
  let blurHideTimer = null; // hides the popup / run button a moment after the editor loses focus
  let ghostDiffTimeouts = new Map(); // slotKey -> { revertInfo, timer }
  let slotUndoHistory = []; // { reqId, oldContent, newContent, timestamp }
  let skipSlotUndo = 0; // Ctrl+Z presses left to the browser: they undo the auto selector's own rewrite, not an old slot's result
  let selectorPresets = null; // the rows of the open quick selector
  // Auto selector: tasks in the new notation that are running, "<tabId>:<marker id>" -> { reqId, tabId }.
  // The marker id is what tells two adjacent tasks (or a task and its re-run) apart.
  const runningTasks = new Map();
  // Editors whose Ctrl+Enter is being handled right now -> start time (a double press must not start two runs;
  // a stale entry, e.g. an RPC that never answered, stops counting after TRIGGER_BUSY_MS).
  const triggerInFlight = new WeakMap();
  const TRIGGER_BUSY_MS = 10000;

  // Generates a request id as `${prefix}${Date.now()}-${random}`. Keep passing
  // the existing 'slot-' prefix/dash style unchanged in case anything downstream
  // keys off it; only the random-suffix boilerplate is deduplicated here.
  function genReqId(prefix) {
    return prefix + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
  }

  // Safe Range Replacement preserving Browser Native Undo/Redo history
  function replaceRangeWithUndo(editor, start, end, replacement) {
    if (!editor) return false;
    editor.focus();
    const before = editor.value;
    editor.setSelectionRange(start, end);
    let success = false;
    try {
      success = document.execCommand('insertText', false, replacement);
    } catch (e) {
      success = false;
    }
    if (!success) {
      const text = editor.value;
      editor.value = text.substring(0, start) + replacement + text.substring(end);
      editor.setSelectionRange(start + replacement.length, start + replacement.length);
    } else {
      // The browser may alter what it inserts (it has dropped the space after the caret before): the note must end up as asked.
      const expected = before.substring(0, start) + replacement + before.substring(end);
      if (editor.value !== expected) {
        editor.value = expected;
        editor.setSelectionRange(start + replacement.length, start + replacement.length);
      }
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // 1. AST Lexical Shield (0ns code block / inline code / url bypass)
  function isInsideCode(text, cursor) {
    if (cursor <= 0 || !text) return false;

    // A. Check code block fences
    const prefix = text.substring(0, cursor);
    const codeFenceCount = (prefix.match(/```/g) || []).length;
    if (codeFenceCount % 2 !== 0) {
      return true; // Inside code block
    }

    // B. Check inline code
    const lineStart = prefix.lastIndexOf('\n') + 1;
    const currentLinePrefix = prefix.substring(lineStart);
    const inlineTickCount = (currentLinePrefix.match(/`/g) || []).length;
    if (inlineTickCount % 2 !== 0) {
      return true; // Inside inline code
    }

    return false;
  }

  function isInsideCodeOrUrl(text, cursor) {
    if (isInsideCode(text, cursor)) return true;

    // Check Markdown link or URL for quick selector typing
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const currentLinePrefix = text.substring(lineStart, cursor);

    // If currently inside an open slot trigger (e.g. {{, [?, 【?, [!), URL is part of prompt
    if (/(\{\{|\[\?|【\?|\[!|\[>>)[^}\]]*$/.test(currentLinePrefix)) {
      return false;
    }

    const linkMatch = currentLinePrefix.match(/\[[^\]]*\]\([^)]*$/);
    if (linkMatch) {
      return true; // Inside link url target
    }
    const urlMatch = currentLinePrefix.match(/https?:\/\/[^\s\]]+$/);
    if (urlMatch) {
      return true; // Inside bare URL
    }

    return false;
  }

  // 2. Auto-IME Normalization
  function normalizeIMESlotTrigger(editor, cachedPos, cachedText) {
    if (!editor) return false;
    const pos = (cachedPos !== undefined) ? cachedPos : editor.selectionStart;
    const text = (cachedText !== undefined) ? cachedText : editor.value;
    if (pos < 2) return false;

    // Check last 2 fullwidth chars
    const twoChars = text.substring(pos - 2, pos);
    let replaced = null;

    if (twoChars === '｛｛') {
      replaced = '{{';
    } else if (twoChars === '［？') {
      replaced = '[?';
    } else if (twoChars === '【？') {
      replaced = '【?';
    }

    if (replaced) {
      replaceRangeWithUndo(editor, pos - 2, pos, replaced);
      editor.selectionStart = editor.selectionEnd = pos;
      return true;
    }
    return false;
  }

  // 3. Non-blocking Quick Selector UI
  function initSelectorDOM() {
    if (selectorEl) return;
    selectorEl = document.createElement('div');
    selectorEl.id = 'slot-quick-selector';
    selectorEl.className = 'hidden';
    document.body.appendChild(selectorEl);
  }

  // A user who has never discovered Ctrl+Enter has no way to know a fully-written
  // {{ ... }} block is actually runnable - especially one a Quick Actions candidate
  // just inserted, which auto-runs on its own but gives no visible cue that it did.
  // This floating button appears next to a complete, not-already-running slot whenever
  // the caret sits inside it, as a discoverable alternative to the keyboard shortcut.
  function initRunButtonDOM() {
    if (runButtonEl) return;
    runButtonEl = document.createElement('button');
    runButtonEl.id = 'slot-run-button';
    runButtonEl.type = 'button';
    runButtonEl.className = 'hidden';
    runButtonEl.addEventListener('mousedown', (e) => {
      // Prevent the editor from losing focus/selection before the click fires.
      e.preventDefault();
    });
    runButtonEl.addEventListener('click', () => {
      const editor = runButtonEditor;
      hideRunButton();
      if (editor) handleCtrlEnter(editor);
    });
    document.body.appendChild(runButtonEl);
    applyRunButtonLabel();
  }

  // The app's line icons (no text glyphs in the UI)
  const RUN_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

  function applyRunButtonLabel() {
    if (!runButtonEl) return;
    const lang = getUILang();
    const dict = (typeof I18N !== 'undefined' && I18N[lang]) || (typeof I18N !== 'undefined' && I18N.ja) || {};
    const mod = (global.MDMemoPlatform && global.MDMemoPlatform.isMac) ? 'Cmd' : 'Ctrl';
    const key = mod + '+Enter';
    runButtonEl.innerHTML = RUN_ICON_SVG + '<span>' + escapeHtml(dict.slotRunButtonLabel || '実行') + '</span>';
    const tooltipTpl = dict.slotRunButtonTooltip || 'このスロットを実行 ({key})';
    runButtonEl.title = tooltipTpl.replace('{key}', key);
  }

  // All open/close delimiter pairs currently configured (slot profiles + recipes),
  // falling back to the factory defaults. Mirrors jev_action.js's own
  // getConfiguredTriggerOpens/getDefaultProfileDelimiters (kept as a separate local
  // copy, same as this file's other config-derived helpers, so it works standalone).
  function getConfiguredDelimiterPairs() {
    const pairs = [];
    (slotConfig.slot_profiles || []).forEach((p) => {
      if (p && p.trigger_open && p.trigger_close) pairs.push({ open: p.trigger_open, close: p.trigger_close });
    });
    (slotConfig.recipes || []).forEach((r) => {
      if (r && r.trigger_open && r.trigger_close) pairs.push({ open: r.trigger_open, close: r.trigger_close });
    });
    if (pairs.length) return pairs;
    return [{ open: '{{', close: '}}' }, { open: '[?', close: ']' }, { open: '【?', close: '】' }, { open: '[!', close: '!]' }, { open: '[>>', close: ']' }];
  }

  // Cheap, client-side heuristic for "is the caret inside a complete, not-yet-running
  // slot block?" - a bounded nearest-open/nearest-close scan, not the authoritative
  // parser (that's Go's slotagent.ParseSlots, called via parseSlotsRPC only when the
  // button/Ctrl+Enter is actually used, exactly as before this feature). A false
  // positive here just means a click that politely reports "no slot found" instead of
  // running anything; it can never suppress a real slot that IS there.
  const RUN_BUTTON_SCAN_WINDOW = 4000;

  // HTML comments (html_comments.js): text inside one never runs. Without the module (a test harness that does not
  // load it) there are no comments. Nothing is scanned unless the text contains "<!--".
  function commentRanges(text) {
    const api = global.HtmlComments;
    return api && text && text.indexOf('<!--') !== -1 ? api.htmlCommentRanges(text) : [];
  }

  function caretInComment(text, pos) {
    const api = global.HtmlComments;
    return !!(api && text && text.indexOf('<!--') !== -1 && api.isInsideComment(text, pos));
  }

  function notifyInComment() {
    notifyNoAction('commentNoRun', 'Inside a comment (<!-- -->): nothing runs here.');
  }

  // Why a run cannot start, in the UI language: problem is the Go side's { kind: 'disabled' | 'none-enabled' | 'missing', agent,
  // command, message } (slotagent.RunProblem); the same words are in pkg/slotagent/enabled.go.
  const RUN_PROBLEMS = {
    disabled: ['agentRunDisabled', 'Agent "{agent}" is disabled in agents.yaml (enabled: false)'],
    'none-enabled': ['agentRunNoneEnabled', 'No agent is enabled: every agent is disabled in agents.yaml (enabled: false)'],
    missing: ['agentRunMissing', 'Agent "{agent}" needs "{command}", which was not found in PATH. Install it or choose another agent in agents.yaml.']
  };

  function runProblemText(problem) {
    const p = problem || {};
    const known = RUN_PROBLEMS[p.kind];
    if (!known) return String(p.message || '');
    return tr(known[0], known[1], { agent: p.agent || '', command: p.command || '' });
  }

  function notifyRunProblem(problem) {
    const text = runProblemText(problem);
    if (!text) return;
    try {
      if (typeof global.showMessage === 'function') {
        global.showMessage(text, 8000);
        return;
      }
    } catch (e) { /* fall through to console */ }
    console.warn(text);
  }

  function findEnclosingSlotSpan(text, cursor) {
    const pairs = getConfiguredDelimiterPairs();
    const searchStart = Math.max(0, cursor - RUN_BUTTON_SCAN_WINDOW);
    const searchEnd = Math.min(text.length, cursor + RUN_BUTTON_SCAN_WINDOW);
    let comments = null; // looked up at the first candidate
    let best = null;

    for (const pair of pairs) {
      // The nearest open delimiter at/before the cursor is the only one that can be
      // this slot's own: an earlier open would have been closed (or be nested) by then.
      const openIdx = text.lastIndexOf(pair.open, cursor);
      if (openIdx === -1 || openIdx < searchStart) continue;
      // Its closing delimiter is the first one after it - which may sit BEFORE the
      // cursor (caret parked right after the block, exactly where a Quick Actions
      // insert or finishing typing '}}' leaves it) or after it (caret inside).
      const afterOpen = openIdx + pair.open.length;
      const relativeCloseIdx = text.substring(afterOpen, searchEnd).indexOf(pair.close);
      if (relativeCloseIdx === -1) continue;
      const closeIdx = afterOpen + relativeCloseIdx;
      const endOffset = closeIdx + pair.close.length;
      // Inside the block, or touching either edge; strictly outside means a different
      // (already-closed) slot's tail or plain text.
      if (cursor < openIdx || cursor > endOffset) continue;

      const raw = text.substring(openIdx, endOffset);
      if (raw.includes('実行中')) continue; // already running: nothing to offer
      // A span a comment holds or cuts is not a slot for the Go parser either (FindExcludedRanges); offering it would
      // hand Ctrl+Enter to Go's "next slot / first slot" fallback.
      if (comments === null) comments = commentRanges(text);
      if (comments.length && global.HtmlComments.isRangeExcluded(comments, openIdx, endOffset)) continue;

      // Prefer the smallest (innermost) enclosing span across delimiter kinds.
      if (!best || (endOffset - openIdx) < (best.endOffset - best.startOffset)) {
        best = { startOffset: openIdx, endOffset: endOffset };
      }
    }
    return best;
  }

  function hideRunButton() {
    if (runButtonEl) runButtonEl.className = 'hidden';
    runButtonEditor = null;
  }

  function updateRunButton(editor) {
    // The quick selector takes priority; never show both floating elements at once.
    if (selectorEl && selectorEl.classList.contains('active')) {
      hideRunButton();
      return;
    }
    if (!editor || document.activeElement !== editor) {
      hideRunButton();
      return;
    }
    const text = editor.value;
    const cursor = editor.selectionStart;
    if (editor.selectionStart !== editor.selectionEnd || isInsideCode(text, cursor)) {
      hideRunButton();
      return;
    }
    // A task in the new notation (also {{ @agent ... }}) has its own rules: offered while it is not running, on its own line.
    const newTask = newFormTaskAt(text, cursor);
    const span = newTask ? findRunnableTaskSpan(editor, text, cursor, newTask) : findEnclosingSlotSpan(text, cursor);
    // A caret inside a comment runs nothing (not even the slot around the comment): no button there
    if (!span || caretInComment(text, cursor)) {
      hideRunButton();
      return;
    }
    if (!runButtonEl) initRunButtonDOM();
    runButtonEditor = editor;
    runButtonEl.className = 'active';

    // Same page-coordinate conversion showQuickSelector uses: getCharPixelCoords
    // returns offsets within the (off-screen) measurement mirror, which share the
    // editor's own font/line metrics but need the editor's real bounding rect and
    // scroll position added to become actual viewport coordinates.
    let coords = { top: 100, left: 100 };
    if (typeof global.getCharPixelCoords === 'function') {
      coords = global.getCharPixelCoords(span.endOffset, editor);
    }
    const rect = editor.getBoundingClientRect();
    // A task in the new notation owns the line below it (its result), so its button sits after it on the same line
    const x = Math.min(window.innerWidth - 140, Math.max(10, rect.left + coords.left - editor.scrollLeft + (span.sameLine ? 14 : 0)));
    const y = Math.min(window.innerHeight - 40, rect.top + coords.top - editor.scrollTop + (span.sameLine ? -1 : 22));
    runButtonEl.style.left = `${x}px`;
    runButtonEl.style.top = `${y}px`;
  }

  function scheduleRunButtonUpdate(editor) {
    clearTimeout(runButtonTimer);
    runButtonTimer = setTimeout(() => updateRunButton(editor), 150);
  }

  function snippetsApi() {
    const api = global.SlotSnippets;
    return api && typeof api.list === 'function' ? api : null;
  }

  // Every snippet for this language and OS (built-in ones and the agents.yaml `snippets`), or [] without the module.
  function listSnippets() {
    const api = snippetsApi();
    if (!api) return [];
    try {
      return api.list({ lang: getUILang(), os: 'auto', user: slotConfig.snippets });
    } catch (e) {
      return [];
    }
  }

  // One line for the popup: what the snippet gives with nothing selected (${selection:text} shows its text,
  // ${selection?text} nothing), the other placeholders as an ellipsis, the caret marker dropped.
  function snippetPreview(body) {
    const api = snippetsApi();
    return api && typeof api.preview === 'function' ? api.preview(body) : String(body || '').replace(/\s+/g, ' ').trim();
  }

  const SNIPPET_KIND_TAG = { llm: 'LLM', agent: 'AGENT', command: 'CMD', text: 'TEXT' };

  // The agents key a preset row runs: its profile's agent when that is an agent with a command, else the default agent
  // (as slotagent.RunAgentFor chooses). null when there is none.
  function presetAgentKey(name) {
    const agents = slotConfig.agents || {};
    if (name && agents[name] && agents[name].command) return name;
    const key = defaultAgentKey();
    return key && agents[key] && agents[key].command ? key : null;
  }

  function getAvailablePresets(snippetsOnly) {
    const presets = [];
    let idx = 1;

    // Slot profiles (one whose agent is switched off cannot run: it is not offered, and takes no number key)
    if (!snippetsOnly && slotConfig.slot_profiles) {
      slotConfig.slot_profiles.forEach(p => {
        if (noAgentEnabled() || (p.agent && disabledAgentKey(p.agent))) return;
        presets.push({
          numKey: idx <= 9 ? String(idx++) : '',
          type: 'slot',
          role: p.name,
          agent: p.agent,
          agentKey: presetAgentKey(p.agent),
          open: p.trigger_open,
          close: p.trigger_close,
          desc: p.system_instruction ? (p.system_instruction.substring(0, 24) + '...') : p.name
        });
      });
    }

    // Recipes (they run the default agent)
    if (!snippetsOnly && slotConfig.recipes) {
      slotConfig.recipes.forEach(r => {
        if (noAgentEnabled()) return;
        presets.push({
          numKey: idx <= 9 ? String(idx++) : '',
          type: 'recipe',
          role: r.name,
          agent: slotConfig.default_agent || 'claude-code',
          agentKey: defaultAgentKey(),
          open: r.trigger_open,
          close: r.trigger_close,
          desc: r.description || 'パイプラインレシピ'
        });
      });
    }

    // Snippets (ready-made tasks) come last, so the number keys of the profiles and recipes stay where they were
    listSnippets().forEach(s => {
      presets.push({
        numKey: idx <= 9 ? String(idx++) : '',
        type: 'snippet',
        kind: s.kind,
        role: s.label,
        snippet: s,
        desc: snippetPreview(s.body)
      });
    });

    return presets;
  }

  // pickerOnly: opened from the palette (no typed "{{" to replace): only the snippets are listed.
  function showQuickSelector(editor, triggerOpen, openStartPos, pickerOnly) {
    // A blur a moment ago (the palette closing) must not hide the list that is opening now
    clearTimeout(blurHideTimer);
    initSelectorDOM();
    const presets = getAvailablePresets(pickerOnly);
    if (presets.length === 0) return;

    selectorTriggerInfo = {
      open: triggerOpen,
      startPos: openStartPos,
      pickerOnly: !!pickerOnly
    };
    selectorPresets = presets;
    selectorSelectedIndex = 0;

    renderSelectorList(presets);
    markMissingPrograms(presets);

    // Calculate position under caret
    let coords = { top: 100, left: 100 };
    if (typeof global.getCharPixelCoords === 'function') {
      coords = global.getCharPixelCoords(openStartPos, editor);
    }
    const rect = editor.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 380, Math.max(10, rect.left + coords.left - editor.scrollLeft));
    const lineTop = rect.top + coords.top - editor.scrollTop;
    const y = Math.min(window.innerHeight - 200, lineTop + 22);

    selectorEl.style.left = `${x}px`;
    selectorEl.style.top = `${y}px`;
    selectorEl.classList.remove('hidden');
    selectorEl.classList.add('active');

    // The list of snippets is tall: with no room below the caret it opens above it, and never leaves the window
    const height = selectorEl.offsetHeight || 0;
    if (height && y + height > window.innerHeight - 8) {
      const above = lineTop - height - 4;
      selectorEl.style.top = `${Math.max(8, above >= 8 ? above : window.innerHeight - height - 8)}px`;
    }
  }

  // Rows whose agent program is not on PATH get a short tag. Asked when the list opens (the backend's lookup is cached for a
  // few seconds), after the list is shown, so opening it never waits. Only the program is looked up: nothing is claimed about
  // what it needs to work (an Ollama model that is not pulled yet, a login).
  function markMissingPrograms(presets) {
    const backend = global.backend;
    if (!backend || typeof backend.checkAgentAvailability !== 'function') return;
    const keys = [];
    presets.forEach((p) => {
      if (p.agentKey && keys.indexOf(p.agentKey) === -1) keys.push(p.agentKey);
    });
    keys.forEach((key) => {
      Promise.resolve()
        .then(() => backend.checkAgentAvailability(key))
        .then((res) => {
          if (!res || res.available !== false || !res.command) return; // found, or unknown to the backend: no tag
          let changed = false;
          presets.forEach((p) => {
            if (p.agentKey === key && !p.missing) {
              p.missing = res.command;
              changed = true;
            }
          });
          if (changed && selectorPresets === presets && selectorEl && selectorEl.classList.contains('active')) renderSelectorList(presets);
        })
        .catch(() => { /* no tag: the run says it if the program is missing */ });
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Rows are built from agents.yaml text (profile names, snippet labels and bodies): always escaped.
  function renderSelectorList(presets) {
    if (!selectorEl) return;
    const pickerOnly = !!(selectorTriggerInfo && selectorTriggerInfo.pickerOnly);
    const header = pickerOnly
      ? `<span>${escapeHtml(tr('autoSelSnippetsHeader', 'Task snippets'))}</span>
        <span style="font-size: 10px; opacity: 0.6;">${escapeHtml(tr('autoSelSnippetsKeys', 'Up/Down move, Enter/Tab/1-9 insert, Esc close'))}</span>`
      : `<span>${escapeHtml(tr('slotSelectorHeader', 'エージェントに任せる'))}</span>
        <span style="font-size: 10px; opacity: 0.6;">${escapeHtml(tr('slotSelectorKeys', '↑/↓ 移動 • Enter/Tab/1-9 確定 • Esc 閉じる'))}</span>`;
    let html = `
      <div class="slot-selector-header">
        ${header}
      </div>
      <ul class="slot-selector-list">
    `;

    presets.forEach((p, idx) => {
      const isSel = idx === selectorSelectedIndex ? 'selected' : '';
      const keyBadge = p.numKey ? `<span class="slot-item-key">${p.numKey}</span>` : '';
      if (p.type === 'snippet') {
        const kind = SNIPPET_KIND_TAG[p.kind] ? p.kind : 'text';
        html += `
        <li class="slot-selector-item ${isSel}" data-index="${idx}" title="${escapeHtml(p.desc)}">
          ${keyBadge}
          <span class="slot-item-kind slot-kind-${kind}">${SNIPPET_KIND_TAG[kind]}</span>
          <span class="slot-item-role">${escapeHtml(p.role)}</span>
          <span class="slot-item-desc">${escapeHtml(p.desc)}</span>
        </li>
      `;
        return;
      }
      const typeTag = p.type === 'recipe' ? '<span style="color:#e5c07b;font-size:10px;margin-right:4px;">[RECIPE]</span>' : '';
      // The program of this row's agent is not on PATH (markMissingPrograms): a short tag, the full sentence as its tooltip
      const missingTag = p.missing
        ? `<span class="slot-item-kind" title="${escapeHtml(tr('agentRunMissing', 'Agent "{agent}" needs "{command}", which was not found in PATH. Install it or choose another agent in agents.yaml.', { agent: p.agentKey, command: p.missing }))}">${escapeHtml(tr('slotPresetMissing', 'not found'))}</span>`
        : '';
      html += `
        <li class="slot-selector-item ${isSel}" data-index="${idx}">
          ${keyBadge}
          ${typeTag}
          <span class="slot-item-role">${escapeHtml(p.role)}:</span>
          ${missingTag}
          <span class="slot-item-desc">${escapeHtml(p.desc)}</span>
        </li>
      `;
    });

    html += `</ul>`;
    selectorEl.innerHTML = html;

    // Attach click events
    selectorEl.querySelectorAll('.slot-selector-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const index = parseInt(item.getAttribute('data-index'), 10);
        commitPreset(presets[index]);
      });
    });

    // A long list scrolls: keep the highlighted row in view
    const current = selectorEl.querySelector ? selectorEl.querySelector('.slot-selector-item.selected') : null;
    if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }

  function hideQuickSelector() {
    if (selectorEl) {
      selectorEl.classList.add('hidden');
      selectorEl.classList.remove('active');
    }
    selectorTriggerInfo = null;
    selectorPresets = null;
  }

  // Inserts a snippet: it replaces the typed "{{" (or the selection, when the snippet is about the selection) and
  // the caret lands where the snippet's $0 says.
  function commitSnippet(editor, snippet) {
    const api = snippetsApi();
    if (!api || !snippet) return;
    const text = editor.value;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    const info = selectorTriggerInfo;

    let start = selEnd;
    let end = selEnd;
    let selection = '';
    if (info && !info.pickerOnly && info.startPos <= selStart) {
      start = info.startPos;
      end = selStart;
    } else if (selStart !== selEnd && typeof api.usesSelection === 'function' && api.usesSelection(snippet.body)) {
      start = selStart;
      end = selEnd;
      selection = text.substring(selStart, selEnd);
    }

    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.substring(lineStart, start) + text.substring(end, lineEnd);

    const out = api.expand(snippet, {
      selection: selection,
      line: line,
      agents: slotConfig.agents,
      disabledAgents: slotConfig.disabled_agents,
      defaultAgent: slotConfig.default_agent
    });
    replaceRangeWithUndo(editor, start, end, out.text);
    const caret = start + out.caret;
    editor.setSelectionRange(caret, caret);
    editor.focus();
    hideQuickSelector();
  }

  // Tab after an exact snippet trigger (";sum") that starts the line or follows whitespace: the trigger becomes the
  // snippet. Returns false, having done nothing, in every other case (so Tab keeps indenting).
  function tryExpandSnippetTrigger(editor) {
    const api = snippetsApi();
    if (!api || editor.selectionStart !== editor.selectionEnd) return false;
    const pos = editor.selectionStart;
    const text = editor.value;
    const lineStart = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
    let start = pos;
    while (start > lineStart && pos - start <= 30 && !/[\s　]/.test(text.charAt(start - 1))) start--;
    if (pos - start < 2 || pos - start > 30) return false;

    const hit = api.findByTrigger(text.substring(start, pos), listSnippets());
    if (!hit || isInsideCode(text, pos)) return false;

    const line = text.substring(lineStart, start) + text.substring(pos, lineBreakAfter(text, pos));
    const out = api.expand(hit, { selection: '', line: line, agents: slotConfig.agents, disabledAgents: slotConfig.disabled_agents, defaultAgent: slotConfig.default_agent });
    replaceRangeWithUndo(editor, start, pos, out.text);
    editor.setSelectionRange(start + out.caret, start + out.caret);
    hideQuickSelector();
    return true;
  }

  function lineBreakAfter(text, pos) {
    const nl = text.indexOf('\n', pos);
    return nl === -1 ? text.length : nl;
  }

  function commitPreset(preset) {
    const editor = getActiveEditor();
    if (!editor || !preset) return;
    if (preset.type === 'snippet') {
      commitSnippet(editor, preset.snippet);
      return;
    }

    const pos = editor.selectionStart;
    const text = editor.value;

    let triggerLen = 0;
    let insertStart = pos;

    if (selectorTriggerInfo && selectorTriggerInfo.startPos <= pos) {
      insertStart = selectorTriggerInfo.startPos;
      triggerLen = pos - insertStart;
    }

    const openTag = preset.open;
    const closeTag = preset.close;
    const rolePrefix = `${preset.role}: `;
    const insertion = `${openTag} ${rolePrefix}`;
    const fullSnippet = `${insertion} ${closeTag}`;

    replaceRangeWithUndo(editor, insertStart, pos, fullSnippet);

    // Place cursor right after role prefix: {{ code: | }}
    const newCursor = insertStart + insertion.length;
    editor.selectionStart = editor.selectionEnd = newCursor;
    editor.focus();

    hideQuickSelector();
  }

  // 4. Execution & Debounced Caret-Preserving Merger
  // Least-invasive language detection: app.js's applyLanguage() sets
  // document.documentElement.lang, so we read that instead of reaching into
  // app.js's private `config` closure variable (which isn't exposed on window).
  // Same pattern as jev_action.js's own copy; kept local rather than shared so this
  // file still works standalone under the Node test harness.
  function getUILang() {
    try {
      if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang === 'en') {
        return 'en';
      }
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  // The text for `key` in the UI language with {name} placeholders filled (params), or fallbackText when
  // there is no dictionary.
  function tr(key, fallbackText, params) {
    let text = fallbackText;
    try {
      const lang = getUILang();
      const dict = (typeof I18N !== 'undefined' && I18N[lang]) || (typeof I18N !== 'undefined' && I18N.ja);
      if (dict && dict[key]) text = dict[key];
    } catch (e) { /* the fallback stays */ }
    if (params) {
      text = String(text).replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
    }
    return text;
  }

  // Shows a brief toast explaining why Ctrl+Enter (or an auto-triggered run, e.g. right
  // after a Quick Actions candidate inserts a slot) did nothing. Before this, every
  // early-return path below failed completely silently: the note looked untouched either
  // way, whether nothing was found or a run was already in progress, so a user pressing
  // Ctrl+Enter again had no way to tell "not found" from "already running" from "worked,
  // just hasn't finished yet". Falls back to console.warn if showMessage isn't reachable
  // (e.g. this file loaded standalone under the Node test harness).
  function notifyNoAction(key, fallbackText, params, duration) {
    const text = tr(key, fallbackText, params);
    try {
      if (typeof global.showMessage === 'function') {
        global.showMessage(text, duration || 3000);
        return;
      }
    } catch (e) { /* fall through to console */ }
    console.warn(text);
  }

  // Public entry (Jev's inserted slots, the run button, tests): a run in progress for this editor is not started twice.
  function triggerSlotExecution(targetEditor, opts) {
    const editor = targetEditor || getActiveEditor();
    if (!editor) return Promise.resolve(false);
    return guarded(editor, () => runSlotTrigger(editor, opts));
  }

  // opts.cursor: where the slot to run is (default: the caret)
  async function runSlotTrigger(editor, opts) {
    const text = editor.value;
    const cursor = opts && typeof opts.cursor === 'number' ? opts.cursor : editor.selectionStart;

    // Check if cursor is in excluded code block/inline code
    if (isInsideCode(text, cursor)) {
      return false; // Spec 3.1.3: 0ns AST Bypass (silent: the cursor isn't near a slot at all)
    }
    // Inside an HTML comment nothing runs: Go would find no slot there and fall back to another one
    if (caretInComment(text, cursor)) {
      notifyInComment();
      return false;
    }

    // Call Go backend to locate actionable slot
    let parseRes = null;
    if (window.backend && window.backend.parseSlotsRPC) {
      try {
        parseRes = await window.backend.parseSlotsRPC(text, cursor, JSON.stringify(slotConfig));
      } catch (e) {
        console.error("parseSlotsRPC error:", e);
      }
    }

    if (parseRes && parseRes.caretInComment) {
      notifyInComment();
      return false;
    }
    if (!parseRes || (!parseRes.targetSlot && !parseRes.hasWaitingApproval)) {
      notifyNoAction('slotNoTargetFound', '実行できるスロットが見つかりません（カーソルを {{ }} などのブロック内に置いてください）');
      return false; // No slot found
    }

    const target = parseRes.targetSlot;

    // The run cannot start (its agent is disabled, or its program is not installed): say so and leave the note as it is.
    // It is never "skill not found", and never another agent's run.
    if (parseRes.runProblem) {
      notifyRunProblem(parseRes.runProblem);
      return false;
    }

    // An agent that acts without asking for permission is confirmed before anything in the note changes
    const beforeGate = editor.value;
    if (!(await allowAgentRun(parseRes, target))) {
      if (opts && typeof opts.onDeclined === 'function') opts.onDeclined();
      return false;
    }
    if (editor.value !== beforeGate) {
      notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
      return false;
    }

    // A task in the new notation ({{ @agent ... }}) keeps its line and gets the answer below it; which run is
    // already going is told by the marker id under it, not by where it sits.
    if (target && target.outputMode === 'below') {
      return startBelowAgentRun(editor, text, cursor, target);
    }

    // Concurrency guard: a legacy slot that is running shows the placeholder in place of its text
    if (target) {
      const slotRaw = text.substring(target.startOffset, target.endOffset);
      if (slotRaw.includes('実行中')) {
        notifyNoAction('slotAlreadyRunning', 'このスロットはすでに実行中です');
        return false;
      }
    }

    // A run is genuinely starting: the floating run button (if shown for this exact
    // span) is about to be replaced by the "実行中" placeholder text anyway, so hide
    // it immediately rather than waiting for the next debounced scan to notice.
    hideRunButton();

    const reqId = genReqId('slot-');

    let openD = "{{";
    let closeD = "}}";
    if (target) {
      openD = target.openDelimiter || "{{";
      closeD = target.closeDelim || "}}";
    }
    let executingPlaceholder = `${openD} ⟳ 実行中... ${closeD}`;

    let startOff = 0;
    let endOff = 0;
    let oldContent = "";

    if (target) {
      startOff = target.startOffset;
      endOff = target.endOffset;
      oldContent = text.substring(startOff, endOff);
    } else {
      // Waiting approval gate resume (a gate inside an HTML comment is off, as in Go's FindApprovalGates)
      const comments = commentRanges(text);
      let gateMatch = null;
      for (const m of text.matchAll(/^[ \t]*-[ \t]*\[[xX]\][ \t]*(.*?)[ \t]*\/\/[ \t]*approve[ \t]*$/gm)) {
        if (!comments.length || !global.HtmlComments.isRangeExcluded(comments, m.index, m.index + m[0].length)) {
          gateMatch = m;
          break;
        }
      }
      if (gateMatch) {
        startOff = gateMatch.index;
        endOff = startOff + gateMatch[0].length;
        oldContent = gateMatch[0];
        executingPlaceholder = `${oldContent} (実行中...)`;
      }
    }

    const meta = {
      reqId: reqId,
      // The pane the slot was triggered in. The result must merge back HERE even
      // if the user has moved to the other pane meanwhile.
      editor: editor,
      startOffset: startOff,
      endOffset: endOff,
      oldContent: oldContent,
      executingText: executingPlaceholder,
      openD: openD,
      closeD: closeD
    };
    rememberRunSurroundings(meta, editor, startOff, endOff);
    activeRequests.set(reqId, meta);

    // Register with TaskManager for UI visualization and cancel controls
    if (global.TaskManager && global.TaskManager.addTask) {
      const agentName = (target && target.role) || (target && target.skillName) || slotConfig.default_agent || 'agy';
      const instructionText = (target && target.instruction) || oldContent;
      global.TaskManager.addTask({
        id: reqId,
        type: 'slot',
        agent: agentName,
        instruction: instructionText,
        startTime: Date.now(),
        onCancel: () => cancelSlotExecution(reqId)
      });
    }

    // Save previous state to local revert registry for Esc local revert
    registerLocalRevert(startOff, oldContent);

    // Replace slot text with executing placeholder in editor (preserving Undo stack)
    replaceRangeWithUndo(editor, startOff, endOff, executingPlaceholder);

    // Adjust cursor position if necessary
    if (cursor > endOff) {
      editor.selectionStart = editor.selectionEnd = cursor - (endOff - startOff) + executingPlaceholder.length;
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    // Trigger Go process runner asynchronously (0ns UI blocking)
    const filePath = (global.getCurrentTabPath && global.getCurrentTabPath()) || "";
    if (window.backend && window.backend.runSlotAgentAsync) {
      window.backend.runSlotAgentAsync(reqId, filePath, text, cursor, JSON.stringify(slotConfig));
    }

    return true;
  }

  // ---- Auto selector: what Ctrl+Enter does ---------------------------------------------------------------
  // The decision is plain synchronous JS (no RPC before it), one of:
  //   1. a task in the new notation under the caret ([[ @llm .. ]], [[ $ .. ]], {{ @agent .. }}): run that one
  //   2. a hand-written {{ }} style slot at the caret, auto mode off, a blank line, a code fence: the old behaviour
  //   3. a line that is clearly a request: rewrite it into a task (keeping its list / quote prefix) and run it
  //      (an agent or a command stops after the rewrite unless the setting says otherwise)
  //   4. anything else: the ask bar (Ctrl+L) about that text, whose answer is recorded as a task below it
  // A task keeps its line; a marker line under it stands for the running task and is replaced by the result block.

  function selectorApi() {
    const api = global.AutoSelector;
    return api && typeof api.findTaskAt === 'function' ? api : null;
  }

  function bridge() {
    return global.MdMemoBridge || null;
  }

  function modKey() {
    return global.MDMemoPlatform && global.MDMemoPlatform.isMac ? 'Cmd' : 'Ctrl';
  }

  function taskKey(tabId, id) {
    return tabId + ':' + id;
  }

  function isBusy(editor) {
    const since = triggerInFlight.get(editor);
    return since !== undefined && Date.now() - since < TRIGGER_BUSY_MS;
  }

  // Runs fn (which returns a promise) while the editor is marked busy: a second press meanwhile does nothing.
  function guarded(editor, fn) {
    if (isBusy(editor)) return Promise.resolve(false);
    triggerInFlight.set(editor, Date.now());
    let running;
    try {
      running = Promise.resolve(fn());
    } catch (err) {
      running = Promise.reject(err);
    }
    return running
      .then((result) => result, (err) => {
        console.error('Ctrl+Enter failed:', err);
        return false;
      })
      .then((result) => {
        triggerInFlight.delete(editor);
        return result;
      });
  }

  function handleCtrlEnter(editor) {
    return guarded(editor, () => ctrlEnterFlow(editor));
  }

  // [ls, le) of the line that contains idx (le excludes the line break).
  function lineBounds(text, idx) {
    const ls = idx <= 0 ? 0 : text.lastIndexOf('\n', idx - 1) + 1;
    let le = text.indexOf('\n', idx);
    if (le === -1) le = text.length;
    if (le > ls && text.charCodeAt(le - 1) === 13) le--;
    return { ls: ls, le: le };
  }

  const RESULT_OPEN = '<!-- md-memo:res ';
  const RESULT_CLOSE = '<!-- /md-memo:res -->';

  // True when pos is between the opener and the closer of a result block (text a run wrote, never an instruction).
  function insideResultBlock(text, pos) {
    const open = text.lastIndexOf(RESULT_OPEN, pos);
    if (open === -1 || text.lastIndexOf(RESULT_CLOSE, pos) > open) return false;
    const close = text.indexOf(RESULT_CLOSE, pos);
    if (close === -1) return false;
    const nextOpen = text.indexOf(RESULT_OPEN, pos);
    return nextOpen === -1 || nextOpen > close;
  }

  // The agents.yaml key an agent name or alias stands for (null when there is none).
  function resolveAgentKey(name) {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    const agents = slotConfig.agents || {};
    for (const key of Object.keys(agents)) {
      if (key.toLowerCase() === wanted) return key;
      const aliases = agents[key] && agents[key].aliases;
      if (Array.isArray(aliases) && aliases.some((alias) => String(alias).toLowerCase() === wanted)) return key;
    }
    return null;
  }

  // The agent a line that asks for "an agent" runs with: the default agent, else the first usable enabled one (the Go side's
  // order). null when every agent is switched off; 'claude-code' when the config holds no agents at all and none is disabled.
  function defaultAgentKey() {
    return resolveAgentKey(slotConfig.default_agent) || firstUsableAgentKey(slotConfig.agents) || Object.keys(slotConfig.agents || {})[0] || (noAgentEnabled() ? null : 'claude-code');
  }

  // The agent a run of `target` starts, chosen from the loaded config the way the Go side chooses (slotagent.RunAgentFor):
  // for a line not rewritten yet, and a parse answer that does not name it (a test double, an older backend).
  // { key, def } (def null: unknown).
  function pickRunAgent(target) {
    const agents = slotConfig.agents || {};
    const usable = (k) => !!(k && agents[k] && agents[k].command);
    const dflt = slotConfig.default_agent;
    const fallback = () => (usable(dflt) ? { key: dflt, def: agents[dflt] } : { key: disabledAgentKey('claude-code') ? '' : 'claude-code', def: null });
    if (!target || target.type === 'recipe') return fallback();
    if (target.agentName) {
      const key = resolveAgentKey(target.agentName) || target.agentName;
      return { key: key, def: agents[key] || null };
    }
    const profile = (slotConfig.slot_profiles || []).find((p) => p && p.trigger_open === target.openDelimiter && p.trigger_close === target.closeDelim);
    const key = (profile && profile.agent) || dflt;
    if (disabledAgentKey(key)) return { key: key, def: null }; // a profile that names a disabled agent is not swapped for another
    return usable(key) ? { key: key, def: agents[key] } : fallback();
  }

  // Asks before an agent that acts without asking for permission runs (once per agent and exact command line: the app's
  // confirmAgentRun, see agent_risk.js). parseRes.runAgent is the definition Go will start (absent: nothing starts, e.g. an
  // unapproved gate); without a parse answer (a line about to be rewritten) the loaded config names it. Resolves false when
  // declined.
  async function allowAgentRun(parseRes, target) {
    const B = bridge();
    if (!B || typeof B.confirmAgentRun !== 'function') return true;
    let key = parseRes && parseRes.runAgentKey;
    let def = parseRes && parseRes.runAgent;
    if (!def && target) {
      const picked = pickRunAgent(target);
      key = picked.key;
      def = picked.def;
    }
    if (!def) return true;
    try {
      return (await B.confirmAgentRun(key, def)) !== false;
    } catch (err) {
      console.error('confirmAgentRun failed:', err);
      return false; // a broken gate must not let a risky agent run
    }
  }

  // Puts the caret where it was, mapped through an edit that replaced [from, to) by `insertedLength` characters:
  // before it stays, after it slides, inside it goes to `inside`.
  function mapThroughEdit(index, from, to, insertedLength, inside) {
    if (index <= from) return index;
    if (index >= to) return index + insertedLength - (to - from);
    return inside;
  }

  // The user's selection [start, end] after an edit that wrote text ending at `inside` and put a marker line right under it.
  // mapThroughEdit alone slides a position at the end of the replaced text (a caret at the end of the line, a selected line,
  // a line selected with its line break) behind the marker: the selection then covered the marker and later the answer, and a
  // caret stood on the closing marker line. The marker is bookkeeping, so the end of the selection (or a caret) that sat at the
  // end of the replaced text, or behind nothing but line breaks, stays before it. `text` is the note before the edit.
  function mapSelectionThroughEdit(text, selStart, selEnd, from, to, insertedLength, inside) {
    const atEnd = selEnd >= to && selEnd > from && !/[^\r\n]/.test(text.substring(to, selEnd));
    const end = atEnd ? inside : mapThroughEdit(selEnd, from, to, insertedLength, inside);
    const start = selStart === selEnd ? end : Math.min(mapThroughEdit(selStart, from, to, insertedLength, inside), end);
    return [start, end];
  }

  async function ctrlEnterFlow(editor) {
    const AS = selectorApi();
    const B = bridge();
    if (!AS || !B || typeof B.getAutoSelectorConfig !== 'function') return runSlotTrigger(editor);

    const text = editor.value;
    const a = editor.selectionStart;
    const b = editor.selectionEnd;
    const agentOpt = { agents: slotConfig.agents, disabledAgents: slotConfig.disabled_agents };

    if (insideResultBlock(text, a)) {
      notifyNoAction('autoSelInResult', 'This is a result block. Write your instruction outside of it.');
      return false;
    }
    // Text inside an HTML comment never runs, and nothing else runs in its place (no fallback to another slot)
    const comments = commentRanges(text);
    if (comments.some((r) => r[0] < a && a < r[1])) {
      notifyInComment();
      return false;
    }

    // 1. A task in the new notation under the caret (with a selection: the one under its start, else the first in it)
    const task = AS.findTaskAt(text, a, b, agentOpt);
    if (task) return runTask(editor, task);

    // 2. A slot written by hand keeps working as before
    if (findEnclosingSlotSpan(text, a)) return runSlotTrigger(editor);

    // 3. The subject: the selection, else the current line
    let selEnd = b;
    while (selEnd > a && (text.charCodeAt(selEnd - 1) === 10 || text.charCodeAt(selEnd - 1) === 13)) selEnd--;
    const hasSelection = selEnd > a;
    const line = lineBounds(text, a);
    const subject = hasSelection ? text.substring(a, selEnd) : text.substring(line.ls, line.le);
    // What the subject says once its comments are gone: a commented-out line is not a blank line (which would hand
    // Ctrl+Enter to the slot parser and its fallback) and not an instruction
    const bare = comments.length ? global.HtmlComments.maskComments(text, comments) : text;
    const bareSubject = hasSelection ? bare.substring(a, selEnd) : bare.substring(line.ls, line.le);
    if (subject.trim() && !bareSubject.trim()) {
      notifyInComment();
      return false;
    }
    const cfg = B.getAutoSelectorConfig() || {};
    if (cfg.enabled === false || !subject.trim() || AS.inCodeFence(text, a)) return runSlotTrigger(editor);

    const tabId = B.getTabIdForEditor(editor);
    const multiLine = hasSelection && subject.indexOf('\n') !== -1;
    let wholeLine = !hasSelection;
    if (hasSelection && !multiLine) {
      const body = text.substring(line.ls + AS.splitLinePrefix(text.substring(line.ls, line.le)).prefix.length, line.le);
      const lead = /^[ \t　]*/.exec(body)[0].length;
      const trail = /[ \t　]*$/.exec(body)[0].length;
      const bodyStart = line.le - body.length;
      wholeLine = a <= bodyStart + lead && selEnd >= line.le - trail;
    }
    if (!wholeLine || multiLine) {
      return askAbout(editor, tabId, { text: subject, start: a, end: selEnd, kind: 'selection' });
    }

    const lineText = text.substring(line.ls, line.le);
    const bareLine = bare.substring(line.ls, line.le);
    const verdict = AS.classify(bareLine, agentOpt);
    if (verdict.reason === 'disabled-agent') {
      // "@agy ..." typed as plain text, with agy switched off: said, not taken for an ordinary line
      notifyRunProblem({ kind: 'disabled', agent: verdict.agent });
      return false;
    }
    if (verdict.reason === 'existing-notation') return runSlotTrigger(editor);
    // A line that holds a comment is not rewritten into a task (the comment would end up inside the brackets): ask
    if (verdict.kind !== 'instruction' || bareLine !== lineText) {
      return askAbout(editor, tabId, { text: lineText, start: line.ls, end: line.le, kind: 'line' });
    }
    return runInstruction(editor, tabId, verdict, line.ls, line.le, lineText);
  }

  // A task already in the note.
  function runTask(editor, task) {
    // The agent run goes through the same parse as a hand-written slot; the cursor names this task exactly.
    if (task.kind === 'agent') return runSlotTrigger(editor, { cursor: task.start + 1 });
    return runNewFormTask(editor, {
      kind: task.kind,
      instruction: task.instruction,
      from: task.lineEnd,
      replaceTo: task.lineEnd,
      taskLineEnd: task.lineEnd,
      lead: '',
      contextFrom: task.lineStart
    });
  }

  function rewriteLine(editor, from, to, decorated) {
    hideRunButton();
    replaceRangeWithUndo(editor, from, to, decorated);
    editor.setSelectionRange(from + decorated.length, from + decorated.length);
    skipSlotUndo = Math.min(skipSlotUndo + 1, 3);
  }

  // The whole line is a request: make it a task and run it (an agent or a command waits for a second press).
  function runInstruction(editor, tabId, verdict, ls, le, lineText) {
    const AS = selectorApi();
    const B = bridge();
    const cfg = B.getAutoSelectorConfig() || {};
    const agentOpt = { agents: slotConfig.agents };
    const ask = () => askAbout(editor, tabId, { text: lineText, start: ls, end: le, kind: 'line' });
    const rewriteSpec = (kind, decorated) => {
      const parsed = decorated ? AS.findTaskAt(decorated, decorated.length, undefined, agentOpt) : null;
      return parsed ? { kind: kind, instruction: parsed.instruction, from: ls, replaceTo: le, taskLineEnd: le, lead: decorated, contextFrom: -1 } : null;
    };

    if (verdict.target === 'llm') {
      if (!B.isLlmConfigured(true)) return false;
      const spec = rewriteSpec('llm', AS.decorate('llm', lineText, agentOpt));
      return spec ? runNewFormTask(editor, spec) : ask();
    }

    if (verdict.target === 'agent') {
      const agent = (verdict.agent && resolveAgentKey(verdict.agent)) || defaultAgentKey();
      if (!agent) {
        notifyRunProblem({ kind: 'none-enabled' });
        return false;
      }
      const decorated = AS.decorate('agent', lineText, { agent: agent, agents: slotConfig.agents });
      if (!decorated) return ask();
      if (cfg.agentConfirm !== false) {
        rewriteLine(editor, ls, le, decorated);
        announceRewrite('agent', agent);
        return true;
      }
      return runRewrittenAgentTask(editor, agent, ls, lineText, decorated);
    }

    const decorated = AS.decorate('command', lineText, agentOpt);
    if (!rewriteSpec('command', decorated)) return ask();
    if (cfg.agentConfirm !== false) {
      rewriteLine(editor, ls, le, decorated);
      announceRewrite('command');
      return true;
    }
    return runNewFormTask(editor, rewriteSpec('command', decorated));
  }

  // The line runs as an agent task at once (the confirmation setting is off). An agent that acts without asking is
  // confirmed before the line is rewritten; one declined at the run's own check (the backend resolved another definition)
  // gets its line back, so declining never leaves the note changed.
  async function runRewrittenAgentTask(editor, agent, ls, lineText, decorated) {
    const before = editor.value;
    if (!(await allowAgentRun(null, { agentName: agent }))) return false;
    if (editor.value !== before) {
      notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
      return false;
    }
    rewriteLine(editor, ls, ls + lineText.length, decorated);
    const rewritten = selectorApi().findTaskAt(editor.value, ls + decorated.length, undefined, { agents: slotConfig.agents });
    if (!rewritten) return false;
    const putLineBack = () => {
      if (editor.value.substring(ls, ls + decorated.length) === decorated) replaceRangeWithUndo(editor, ls, ls + decorated.length, lineText);
    };
    return runSlotTrigger(editor, { cursor: rewritten.start + 1, onDeclined: putLineBack });
  }

  // After a rewrite that stops: tell what happened and how to undo it (an agent that cannot be found is said so).
  function announceRewrite(kind, agent) {
    const params = { key: modKey(), agent: agent || '' };
    if (kind === 'command') {
      notifyNoAction('autoSelCommandDecorated', 'Rewritten as a command. {key}+Enter runs it, {key}+Z undoes.', params, 5000);
      return;
    }
    const decorated = () => notifyNoAction('autoSelAgentDecorated', 'Rewritten as an agent task. {key}+Enter runs it, {key}+Z undoes.', params, 5000);
    decorated();
    const backend = global.backend;
    if (!backend || typeof backend.checkAgentAvailability !== 'function') return;
    Promise.resolve()
      .then(() => backend.checkAgentAvailability(agent))
      .then((res) => {
        if (res && res.available === false) {
          notifyNoAction('autoSelAgentDecoratedMissing', 'Agent "{agent}" not found (check agents.yaml and PATH). Rewritten anyway; {key}+Z undoes.', params, 7000);
        }
      })
      .catch(() => { /* the toast above stands */ });
  }

  // The text is not clearly a request: open the ask bar about it; what the user types there becomes a task below the text.
  function askAbout(editor, tabId, target) {
    const B = bridge();
    const raw = editor.value.substring(target.start, target.end);
    B.openAskBar({
      tabId: tabId,
      target: { text: target.text.trim(), start: target.start, end: target.end, kind: target.kind },
      recordInstruction: true,
      onSubmit: (instruction) => {
        Promise.resolve(recordAskedTask(editor, tabId, raw, target, instruction)).catch((err) => console.error('Recording the task failed:', err));
      }
    });
    return true;
  }

  // The pane that shows the note `tabId` right now (the note may have been switched away meanwhile), or null.
  function editorShowing(preferred, tabId) {
    const B = bridge();
    const candidates = [preferred];
    try {
      candidates.push(B.getActiveEditor());
      ['editor', 'editor-secondary'].forEach((id) => candidates.push(document.getElementById(id)));
    } catch (e) { /* the candidates so far are all there is */ }
    for (const candidate of candidates) {
      if (candidate && typeof candidate.value === 'string' && B.getTabIdForEditor(candidate) === tabId) return candidate;
    }
    return null;
  }

  // The ask bar's answer: `[[ @llm <instruction> ]]` on a new line below the text, then run it with that text as its subject.
  async function recordAskedTask(editor, tabId, raw, target, instruction) {
    const AS = selectorApi();
    const B = bridge();
    if (!AS || !B) return false;
    const agentOpt = { agents: slotConfig.agents };
    const ed = editorShowing(editor, tabId);
    if (!ed) {
      notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
      return false;
    }
    const text = ed.value;
    let shift = 0;
    if (text.substring(target.start, target.end) !== raw) {
      const at = text.indexOf(raw);
      if (at === -1) {
        notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
        return false;
      }
      shift = at - target.start;
    }
    const taskLine = AS.decorate('llm', instruction, { sanitize: true });
    const parsed = taskLine ? AS.findTaskAt(taskLine, taskLine.length, undefined, agentOpt) : null;
    if (!parsed || !B.isLlmConfigured(true)) return false;

    const insertAt = lineBounds(text, target.end + shift).le;
    return runNewFormTask(ed, {
      kind: 'llm',
      instruction: parsed.instruction,
      from: insertAt,
      replaceTo: insertAt,
      taskLineEnd: -1,
      lead: '\n' + taskLine,
      contextFrom: -1,
      context: target.text.trim(),
      ctxAttr: true,
      ctxLines: target.text.trim().split('\n').length
    });
  }

  // A code fence longer than any run of backticks in the text, so the output cannot end it early.
  function fenced(body) {
    const runs = String(body).match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return fence + '\n' + body + '\n' + fence;
  }

  // The user's selection in the pane that shows the note, when it lies before `anchorText`. The answer is written from the
  // anchor on and the app moves a caret sitting right at it to the end of the answer - onto the closing marker line, where
  // typing would spoil the block - so the caller puts the selection back afterwards (putSelectionBack).
  function selectionBefore(editor, tabId, anchorText) {
    const ed = editorShowing(editor, tabId);
    if (!ed) return null;
    const at = ed.value.indexOf(anchorText);
    return at !== -1 && ed.selectionEnd <= at ? { ed: ed, start: ed.selectionStart, end: ed.selectionEnd } : null;
  }

  function putSelectionBack(saved) {
    if (!saved) return;
    try {
      saved.ed.setSelectionRange(saved.start, saved.end);
    } catch (e) { /* the pane is gone */ }
  }

  function dropAnchor(tabId, anchorText) {
    const B = bridge();
    if (!B || typeof B.replaceAnchor !== 'function') return;
    const current = typeof B.getTabText === 'function' ? B.getTabText(tabId) : null;
    if (current !== null && current.indexOf(anchorText) !== -1) B.replaceAnchor(tabId, anchorText, '');
  }

  // Runs an LLM or command task. spec:
  //   kind, instruction
  //   from, replaceTo, lead   the edit that starts it: [from, replaceTo) becomes `lead` + the marker line (when a result
  //                           or a marker already sits below the task line, that is replaced instead of stacking a second one)
  //   taskLineEnd             end of the task line, where a result would start (-1: a task line that does not exist yet)
  //   contextFrom             start of the task line, for the text above it on a re-run (-1: none)
  //   context, ctxAttr, ctxLines  the explicit subject of a task recorded from the ask bar, whether its marker says so, and how many
  //                           lines that text has
  async function runNewFormTask(editor, spec) {
    const AS = selectorApi();
    const B = bridge();
    const kind = spec.kind;
    if (!spec.instruction) {
      notifyNoAction('autoSelEmptyTask', 'This task has no instruction: write it inside the brackets.');
      return false;
    }

    const before = editor.value;
    const tabId = B.getTabIdForEditor(editor);
    const existing = spec.taskLineEnd >= 0 ? AS.findResultAfter(before, spec.taskLineEnd) : null;
    if (existing && existing.marker === 'run' && runningTasks.has(taskKey(tabId, existing.id))) {
      notifyNoAction('slotAlreadyRunning', 'このスロットはすでに実行中です');
      return false;
    }

    // What has to be right before the note is touched
    if (kind === 'llm') {
      if (!B.isLlmConfigured(true)) return false;
    } else {
      if (!global.backend || typeof global.backend.runCommandFilterAsync !== 'function') {
        notifyNoAction('autoSelCommandNativeOnly', 'Commands can only run in the desktop app', null, 4500);
        return false;
      }
      if (!(await B.confirmCommand(spec.instruction))) return false;
      if (editor.value !== before) {
        notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
        return false;
      }
    }

    // The subject of an LLM task: what the ask bar was about, or (a re-run of a recorded task) the text above it
    // (the marker remembers that, and how many lines the text had, so a re-run sends the same text)
    const rerunKeepsContext = !!(existing && existing.attrs && /(?:^| )ctx=above(?: |$)/.test(existing.attrs));
    let context = spec.context;
    if (context === undefined && rerunKeepsContext && spec.contextFrom >= 0) {
      const lines = /(?:^| )n=(\d+)(?: |$)/.exec(existing.attrs);
      const found = AS.findContextAbove(before, spec.contextFrom, { agents: slotConfig.agents, maxLines: lines ? parseInt(lines[1], 10) : 80 });
      context = found ? found.text : '';
    }
    let attrs = '';
    if (kind === 'llm' && spec.ctxAttr) attrs = 'ctx=above n=' + Math.max(1, spec.ctxLines || 1);
    else if (kind === 'llm' && rerunKeepsContext) attrs = existing.attrs;

    const id = AS.newTaskId(before);
    const anchorText = '\n' + AS.makeRunMarker(id, attrs);
    const from = spec.from;
    const to = existing ? existing.end : spec.replaceTo;
    const insert = spec.lead + anchorText;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    hideRunButton();
    replaceRangeWithUndo(editor, from, to, insert);
    const inside = from + spec.lead.length;
    const sel = mapSelectionThroughEdit(before, selStart, selEnd, from, to, insert.length, inside);
    editor.setSelectionRange(sel[0], sel[1]);

    const key = taskKey(tabId, id);
    runningTasks.set(key, { reqId: null, tabId: tabId });
    // wrapResult / wrapError run just before the answer is written, onFinish just after it
    let saved = null;
    const beforeAnswer = () => { saved = selectionBefore(editor, tabId, anchorText); };
    const finished = () => {
      runningTasks.delete(key);
      putSelectionBack(saved);
      saved = null;
    };
    let reqId;
    if (kind === 'llm') {
      reqId = B.startLlmTask({
        tabId: tabId,
        prompt: context ? '【指示】:\n' + spec.instruction + '\n\n【対象テキスト】:\n' + context : spec.instruction,
        anchorText: anchorText,
        label: spec.instruction,
        wrapResult: (answer) => { beforeAnswer(); return '\n' + AS.makeResultBlock(id, answer, attrs); },
        wrapError: (message) => { beforeAnswer(); return '\n' + AS.makeResultBlock(id, '[' + B.t('llmError') + message + ']', attrs); },
        cancelReplacement: '',
        onFinish: finished
      });
    } else {
      reqId = B.runCommandTask({
        tabId: tabId,
        command: spec.instruction,
        anchorText: anchorText,
        label: spec.instruction,
        wrapResult: (res) => { beforeAnswer(); return '\n' + AS.makeResultBlock(id, fenced(String(res.output || '').replace(/\s+$/, ''))); },
        wrapError: (message, res) => {
          beforeAnswer();
          const lines = [];
          if (res && res.output) lines.push(String(res.output).replace(/\s+$/, ''));
          if (res && res.error) lines.push(String(res.error).trim());
          lines.push(res && typeof res.exitCode === 'number' ? 'exit code ' + res.exitCode : message);
          return '\n' + AS.makeResultBlock(id, fenced(lines.join('\n')));
        },
        cancelReplacement: '',
        onFinish: finished
      });
    }
    if (!reqId) {
      finished();
      dropAnchor(tabId, anchorText);
      return false;
    }
    const entry = runningTasks.get(key);
    if (entry) entry.reqId = reqId;
    return true;
  }

  // An agent task ({{ @agent ... }}): the marker line goes under the task line, the whole note (with the marker) goes to the agent,
  // and the answer replaces the marker when the run ends (handleSlotResult).
  async function startBelowAgentRun(editor, text, cursor, target) {
    const AS = selectorApi();
    const B = bridge();
    if (!AS || !B) {
      console.warn('Agent tasks need auto_selector.js and the app bridge.');
      return false;
    }
    if (editor.value !== text) {
      notifyNoAction('autoSelNoteChanged', 'The note changed in the meantime. Press the key again.');
      return false;
    }
    const tabId = B.getTabIdForEditor(editor);
    const existing = AS.findResultAfter(text, target.endOffset);
    if (existing && existing.marker === 'run' && runningTasks.has(taskKey(tabId, existing.id))) {
      notifyNoAction('slotAlreadyRunning', 'このスロットはすでに実行中です');
      return false;
    }

    let lineEnd = text.indexOf('\n', target.endOffset);
    if (lineEnd === -1) lineEnd = text.length;
    const id = AS.newTaskId(text);
    const anchorText = '\n' + AS.makeRunMarker(id);
    const to = existing ? existing.end : lineEnd;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    hideRunButton();
    replaceRangeWithUndo(editor, lineEnd, to, anchorText);
    const sel = mapSelectionThroughEdit(text, selStart, selEnd, lineEnd, to, anchorText.length, lineEnd);
    editor.setSelectionRange(sel[0], sel[1]);

    const reqId = genReqId('slot-');
    const agentName = target.agentName || slotConfig.default_agent || 'agy';
    activeRequests.set(reqId, {
      reqId: reqId,
      mode: 'below',
      editor: editor,
      tabId: tabId,
      id: id,
      anchorText: anchorText,
      agent: agentName,
      startOffset: target.startOffset,
      endOffset: target.endOffset,
      oldContent: '',
      executingText: ''
    });
    runningTasks.set(taskKey(tabId, id), { reqId: reqId, tabId: tabId });

    if (global.TaskManager && global.TaskManager.addTask) {
      global.TaskManager.addTask({
        id: reqId,
        type: 'slot',
        agent: agentName,
        instruction: target.instruction || target.rawContent || '',
        startTime: Date.now(),
        onCancel: () => cancelSlotExecution(reqId)
      });
    }

    // The task is sent by its own position, so a caret elsewhere on the line (or before it) still finds it
    const runCursor = cursor >= target.startOffset && cursor <= target.endOffset ? cursor : target.startOffset + 1;
    const filePath = (global.getCurrentTabPath && global.getCurrentTabPath()) || '';
    if (window.backend && window.backend.runSlotAgentAsync) {
      window.backend.runSlotAgentAsync(reqId, filePath, editor.value, runCursor, JSON.stringify(slotConfig));
    }
    return true;
  }

  // The message of a failed agent run for the one-line block. The runner writes its failures as "<warning sign> エラー: ..."
  // (a classic slot shows that as it is), but the block already says "<agent> error:" / "<agent> エラー:", so that lead-in is
  // dropped (the sign may carry a variation selector; spaces, also full-width ones, and a full-width colon are accepted).
  // Nothing left, or nothing given: "Exit Code N".
  function agentErrorMessage(result) {
    const raw = String(result.errorMsg == null ? '' : result.errorMsg).replace(/\s+/g, ' ').trim();
    const message = raw.replace(/^\u26A0\uFE0F?\s*エラー\s*[:\uFF1A]\s*/, '').trim();
    return message || 'Exit Code ' + result.exitCode;
  }

  // The run of an agent task ended: its answer (or its failure, in one line) replaces the marker. A request that was
  // canceled or is not known any more is ignored.
  function applyBelowResult(result) {
    const meta = result.reqId ? activeRequests.get(result.reqId) : null;
    if (!meta || meta.mode !== 'below') return;
    activeRequests.delete(meta.reqId);
    runningTasks.delete(taskKey(meta.tabId, meta.id));
    const AS = selectorApi();
    const B = bridge();
    if (!AS || !B) return;

    if (result.status === 'canceled') {
      dropAnchor(meta.tabId, meta.anchorText);
      return;
    }
    let body;
    if (result.status === 'failed') {
      const message = agentErrorMessage(result);
      body = '[' + tr('autoSelAgentError', '{agent} error: {message}', { agent: meta.agent, message: message }) + ']';
    } else {
      body = String(result.output || '');
    }
    const saved = selectionBefore(meta.editor, meta.tabId, meta.anchorText);
    B.replaceAnchor(meta.tabId, meta.anchorText, '\n' + AS.makeResultBlock(meta.id, body));
    putSelectionBack(saved);
  }

  // The task in the new notation under the caret, if any. Runs after typing pauses: for a line with no brackets it returns at once.
  function newFormTaskAt(text, cursor) {
    const AS = selectorApi();
    return AS ? AS.findTaskAt(text, cursor, cursor, { agents: slotConfig.agents }) : null;
  }

  // The run button offers a task in the new notation that is not running yet.
  function findRunnableTaskSpan(editor, text, cursor, task) {
    const AS = selectorApi();
    const B = bridge();
    if (!AS || !B || typeof B.getTabIdForEditor !== 'function') return null;
    if (!task || insideResultBlock(text, cursor)) return null;
    const existing = AS.findResultAfter(text, task.end);
    if (existing && existing.marker === 'run' && runningTasks.has(taskKey(B.getTabIdForEditor(editor), existing.id))) return null;
    return { startOffset: task.start, endOffset: task.end, sameLine: true };
  }

  // ---- Putting a canceled run's slot back --------------------------------------------------------------------------
  // A classic slot or a recipe shows "{{ ⟳ 実行中... }}" / "[>> ⟳ 実行中... ]" in place of its text while it runs. The mark
  // reads the same for every run, so a cancel cannot find its own by text alone: a note can hold several (two runs at once, or one
  // that an earlier run left behind), and the note may not be the one on screen. A run therefore remembers the note it started in
  // (its tab) and the text around its slot, and a cancel puts the slot back where that text and position say. A cancel that cannot
  // find the mark says so and gives the text back in the message; it never fails silently.
  const RUN_CONTEXT_CHARS = 48;
  const canceledRuns = new Set(); // request ids the page canceled: what their process still reports is not merged (capped)

  function rememberRunSurroundings(meta, editor, startOff, endOff) {
    const value = editor.value;
    meta.before = value.substring(Math.max(0, startOff - RUN_CONTEXT_CHARS), startOff);
    meta.after = value.substring(endOff, endOff + RUN_CONTEXT_CHARS);
    const B = bridge();
    try {
      meta.tabId = B && typeof B.getTabIdForEditor === 'function' ? B.getTabIdForEditor(editor) : null;
    } catch (e) {
      meta.tabId = null;
    }
  }

  // Where the running mark of `meta` is in `text` ({ start, end }), or null. Of several identical marks the one whose surroundings
  // match what stood around the slot when the run started wins (characters in common, before and after); of equally good ones the
  // one nearest to where the slot was.
  function findRunMark(text, meta) {
    const mark = meta.executingText;
    if (!mark) return null;
    const before = meta.before || '';
    const after = meta.after || '';
    let best = -1;
    let bestScore = -1;
    for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + 1)) {
      let score = 0;
      while (score < before.length && at - 1 - score >= 0 && text.charCodeAt(at - 1 - score) === before.charCodeAt(before.length - 1 - score)) score++;
      const tail = at + mark.length;
      let k = 0;
      while (k < after.length && tail + k < text.length && text.charCodeAt(tail + k) === after.charCodeAt(k)) k++;
      score += k;
      if (score > bestScore || (score === bestScore && Math.abs(at - meta.startOffset) < Math.abs(best - meta.startOffset))) {
        best = at;
        bestScore = score;
      }
    }
    return best === -1 ? null : { start: best, end: best + mark.length };
  }

  // The note a replace-mode run started in and its text now: { editor, text } when a pane shows it, { tabId, text } when it is
  // open in the background, null when it is closed.
  function runNote(meta) {
    const B = bridge();
    if (meta.tabId && B && typeof B.getTabText === 'function') {
      const shown = editorShowing(meta.editor, meta.tabId);
      if (shown) return { editor: shown, text: shown.value };
      const stored = B.getTabText(meta.tabId);
      return stored === null ? null : { tabId: meta.tabId, text: stored };
    }
    const editor = meta.editor || getActiveEditor();
    return editor ? { editor: editor, text: editor.value } : null;
  }

  // The original text back in a pane. Cancel is often clicked from the tasks panel; the user is not taken into the editor and the
  // caret stays where it was.
  function putSlotBackInEditor(editor, mark, original) {
    const curStart = editor.selectionStart;
    const curEnd = editor.selectionEnd;
    const snap = captureUserContext(editor);
    const delta = original.length - (mark.end - mark.start);
    const mapOffset = (off) => {
      if (off >= mark.end) return off + delta;
      if (off > mark.start && off < mark.end) return mark.start + original.length;
      return off;
    };
    replaceRangeWithUndo(editor, mark.start, mark.end, original);
    restoreUserContext(editor, snap, mapOffset(curStart), mapOffset(curEnd));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The original text back in a note that is open in the background: the bridge replaces one piece of text of a tab, so the mark
  // is asked for together with as much of its surroundings as it takes to be the only such piece.
  function putSlotBackInTab(tabId, text, mark, original) {
    const B = bridge();
    for (let pad = 0; ; pad = pad === 0 ? 16 : pad * 4) {
      const from = Math.max(0, mark.start - pad);
      const to = Math.min(text.length, mark.end + pad);
      const piece = text.substring(from, to);
      if (text.indexOf(piece) === from && text.indexOf(piece, from + 1) === -1) {
        B.replaceAnchor(tabId, piece, text.substring(from, mark.start) + original + text.substring(mark.end, to));
        return;
      }
    }
  }

  function tellRunMarkNotRestored(meta) {
    const oneLine = String(meta.oldContent).replace(/\s+/g, ' ').trim();
    const shown = oneLine.length > 80 ? oneLine.substring(0, 80) + '…' : oneLine;
    console.warn('The run ' + meta.reqId + ' was canceled but its running mark is not in the note; the note was left as it is. The text was: ' + meta.oldContent);
    notifyNoAction('slotCancelNotRestored', 'Canceled, but the running mark was not found in the note, so the note was left as it is. The instruction was: {text}', { text: shown }, 8000);
  }

  // Puts the slot back in place of the running mark of a canceled replace-mode run. Nothing to do when the note is closed, or the
  // text is back already (the user undid the start of the run); otherwise it is put back, or the user is told why it was not.
  function restoreRunMark(meta) {
    try {
      const note = runNote(meta);
      if (!note) return;
      const mark = findRunMark(note.text, meta);
      if (!mark) {
        if (note.text.indexOf(meta.oldContent) === -1) tellRunMarkNotRestored(meta);
        return;
      }
      if (note.editor) putSlotBackInEditor(note.editor, mark, meta.oldContent);
      else putSlotBackInTab(note.tabId, note.text, mark, meta.oldContent);
    } catch (err) {
      console.error('Putting the canceled slot back failed:', err);
      tellRunMarkNotRestored(meta);
    }
  }

  function cancelSlotExecution(reqId) {
    if (!reqId) return false;
    const meta = activeRequests.get(reqId);
    if (window.backend && window.backend.cancelSlotAgent) {
      try {
        window.backend.cancelSlotAgent(reqId);
      } catch (err) {
        console.error('cancelSlotAgent error:', err);
      }
    }
    activeRequests.delete(reqId);

    // A task in the new notation: the marker line under it goes away, the note is as it was
    if (meta && meta.mode === 'below') {
      runningTasks.delete(taskKey(meta.tabId, meta.id));
      dropAnchor(meta.tabId, meta.anchorText);
    }

    // A classic slot or a recipe: its text takes the place of the running mark
    if (meta && meta.mode !== 'below' && meta.oldContent) {
      canceledRuns.add(reqId);
      if (canceledRuns.size > 50) canceledRuns.delete(canceledRuns.values().next().value);
      restoreRunMark(meta);
    }

    if (global.TaskManager && global.TaskManager.updateTask) {
      global.TaskManager.updateTask(reqId, { status: 'canceled', endTime: Date.now() });
    }
    return true;
  }

  // 5. Safe Debounced Merger & Caret Preservation (Spec 3.4.2 & 3.4.3)
  // A run that never started (its agent is disabled or its program is not installed): the note is as it was. What the page put in
  // for the run (the running placeholder, the marker line under a task) is taken away as for a cancel, the task is marked failed
  // with the reason, and the user is told.
  function applyRunProblem(result) {
    cancelSlotExecution(result.reqId);
    if (global.TaskManager && global.TaskManager.updateTask) {
      global.TaskManager.updateTask(result.reqId, { status: 'failed', endTime: Date.now(), error: runProblemText(result.problem) });
    }
    notifyRunProblem(result.problem);
  }

  function handleSlotResult(result) {
    if (!result) return;
    if (result.problem) {
      applyRunProblem(result);
      return;
    }

    // The backend reports a run as canceled that the page still counts as running: the stop did not come from the page's own cancel
    // (which forgets the run and puts the note back first), so nobody has put the note back yet.
    if (result.status === 'canceled' && result.reqId && activeRequests.has(result.reqId)) {
      cancelSlotExecution(result.reqId);
      return;
    }

    if (global.TaskManager && global.TaskManager.updateTask) {
      const isErr = result.status === 'failed' || (result.exitCode && result.exitCode !== 0);
      global.TaskManager.updateTask(result.reqId, {
        status: isErr ? 'failed' : 'completed',
        endTime: Date.now(),
        error: result.errorMsg || ''
      });
    }

    // A task in the new notation writes its answer under its own line, not over a slot: nothing to merge
    if (result.outputMode === 'below') {
      applyBelowResult(result);
      return;
    }

    // Enqueue merge request
    pendingMergeQueue.push(result);
    processPendingMergesDebounced();
  }

  function processPendingMergesDebounced() {
    clearTimeout(mergeDebounceTimer);
    const now = Date.now();
    const idleTime = now - lastTypingTime;

    if (idleTime < 500) {
      // Human is currently typing; delay merge until 500ms idle
      mergeDebounceTimer = setTimeout(processPendingMergesDebounced, 500 - idleTime + 50);
      return;
    }

    // Apply all pending merges atomically
    const fallbackEditor = getActiveEditor();

    while (pendingMergeQueue.length > 0) {
      const item = pendingMergeQueue.shift();
      const meta = (item && item.reqId && activeRequests.get(item.reqId)) || null;
      // Merge into the pane the slot was triggered in, not wherever focus is now.
      const editor = (meta && meta.editor) || fallbackEditor;
      if (!editor) continue;
      applyMergeToEditor(editor, item);
    }
  }

  // Snapshot everything an asynchronously arriving merge could disturb, so the
  // user keeps their focus, selection and scroll position.
  function captureUserContext(editor) {
    return {
      activeEl: (typeof document !== 'undefined') ? document.activeElement : null,
      dir: editor.selectionDirection || 'none',
      scrollTop: editor.scrollTop || 0,
      scrollLeft: editor.scrollLeft || 0
    };
  }

  function restoreUserContext(editor, snap, newStart, newEnd) {
    const len = (editor.value || '').length;
    const s = Math.max(0, Math.min(len, newStart));
    const e = Math.max(s, Math.min(len, newEnd));
    try {
      if (typeof editor.setSelectionRange === 'function' && snap.dir && snap.dir !== 'none') {
        editor.setSelectionRange(s, e, snap.dir);
      } else {
        editor.selectionStart = s;
        editor.selectionEnd = e;
      }
    } catch (err) {
      editor.selectionStart = editor.selectionEnd = s;
    }
    editor.scrollTop = snap.scrollTop;
    editor.scrollLeft = snap.scrollLeft;

    // replaceRangeWithUndo has to focus the editor for execCommand; give focus
    // back to wherever the user actually was (Find box, CLI bar, other pane...).
    const prev = snap.activeEl;
    if (prev && prev !== editor && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch (err) {
        /* element gone; nothing to restore */
      }
    }
  }

  function applyMergeToEditor(editor, result) {
    const meta = (result.reqId && activeRequests.get(result.reqId)) || null;
    // The user canceled this run: whatever its process still reported is not merged (the note is back as it was)
    if (result.reqId && canceledRuns.has(result.reqId)) return;
    // A report that names neither a run nor the text it replaces (the file watcher's "the file changed") has nothing to merge into;
    // matched by the running mark's text it would put the whole file in place of the mark
    if (!meta && !result.reqId && !result.oldContent) return;
    const targetText = result.newContent || "";
    const priorText = (meta && meta.oldContent) || result.oldContent || "";

    // A "no actionable slot" result carries nothing to apply: a canceled run
    // (newContent === oldContent), a run that produced no content at all, or a
    // result that arrived with no real location info (both offsets defaulted
    // to 0 rather than pointing at an actual slot). Bail out as a true no-op
    // before touching the DOM: no execCommand, no focus/caret/scroll change,
    // and no ghost-diff flash.
    const noRealOffsets = result.startOffset === 0 && result.endOffset === 0;
    const noRealChange = !targetText || targetText === priorText;
    if (noRealOffsets || noRealChange) {
      if (result.reqId) activeRequests.delete(result.reqId);
      return;
    }

    const text = editor.value;
    const curStart = editor.selectionStart;
    const curEnd = editor.selectionEnd;
    const snap = captureUserContext(editor);
    const placeholder = (meta && meta.executingText) || "{{ ⟳ 実行中... }}";

    // 1. Precise location search near recorded startOffset
    let replaceStart = -1;
    let replaceEnd = -1;

    if (meta && meta.executingText) {
      const searchStart = Math.max(0, meta.startOffset - 40);
      const foundIdx = text.indexOf(meta.executingText, searchStart);
      if (foundIdx !== -1 && Math.abs(foundIdx - meta.startOffset) < 300) {
        replaceStart = foundIdx;
        replaceEnd = foundIdx + meta.executingText.length;
      }
    }

    if (replaceStart === -1) {
      // 2. Global search for placeholder
      const idx = text.indexOf(placeholder);
      if (idx !== -1) {
        replaceStart = idx;
        replaceEnd = idx + placeholder.length;
      }
    }

    if (replaceStart === -1 && result.oldContent) {
      // 3. Search for oldContent
      const idx = text.indexOf(result.oldContent);
      if (idx !== -1) {
        replaceStart = idx;
        replaceEnd = idx + result.oldContent.length;
      }
    }

    if (replaceStart === -1 && result.startOffset !== undefined && result.endOffset !== undefined) {
      // 4. Fallback to offsets
      replaceStart = Math.min(result.startOffset, text.length);
      replaceEnd = Math.min(result.endOffset, text.length);
    }

    if (replaceStart === -1) {
      if (result.reqId) activeRequests.delete(result.reqId);
      return; // Could not safely locate merge target
    }

    const oldLen = replaceEnd - replaceStart;
    const newLen = targetText.length;
    const delta = newLen - oldLen;

    // Record for Ctrl+Z undo & Esc local revert
    const revertText = (meta && meta.oldContent) || result.oldContent || "";
    registerLocalRevert(replaceStart, revertText, targetText);
    if (revertText && targetText) {
      slotUndoHistory.push({
        reqId: result.reqId,
        oldContent: revertText,
        newContent: targetText,
        timestamp: Date.now()
      });
      if (slotUndoHistory.length > 30) slotUndoHistory.shift();
    }

    // Apply text replacement preserving browser Undo stack
    replaceRangeWithUndo(editor, replaceStart, replaceEnd, targetText);

    if (result.reqId) activeRequests.delete(result.reqId);

    // Caret Preservation: slide offsets that sit after the replacement, leave
    // offsets before it alone, and park offsets inside it after the new text.
    const mapOffset = (off) => {
      if (off >= replaceEnd) return off + delta;
      if (off > replaceStart && off < replaceEnd) return replaceStart + newLen;
      return off;
    };
    restoreUserContext(editor, snap, mapOffset(curStart), mapOffset(curEnd));

    // Ghost Diff: light up the modified lines
    triggerGhostDiff(editor, replaceStart, replaceStart + newLen);

    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 7. Ghost Diff & Local Revert (Esc) (Spec 3.4.4)
  // Keep the CSS animation length in lockstep with the configured duration.
  function applyGhostDiffDuration() {
    try {
      const root = (typeof document !== 'undefined') && document.documentElement;
      if (root && root.style && typeof root.style.setProperty === 'function') {
        root.style.setProperty('--ghost-diff-duration', `${slotConfig.ghost_diff_duration_ms || 4000}ms`);
      }
    } catch (e) {
      /* no-op */
    }
  }

  function triggerGhostDiff(editor, startOffset, endOffset) {
    // Add temporary visual glowing indicator
    applyGhostDiffDuration();
    editor.classList.add('slot-ghost-diff');
    const duration = slotConfig.ghost_diff_duration_ms || 4000;

    setTimeout(() => {
      editor.classList.remove('slot-ghost-diff');
    }, duration);
  }

  function registerLocalRevert(startOffset, oldText, newText) {
    const key = 'revert-' + startOffset;
    const timeoutMs = (slotConfig.ghost_diff_duration_ms || 4000) + 1000;

    const timer = setTimeout(() => {
      ghostDiffTimeouts.delete(key);
    }, timeoutMs);

    ghostDiffTimeouts.set(key, {
      startOffset: startOffset,
      oldText: oldText,
      newText: newText,
      expiresAt: Date.now() + timeoutMs,
      timer: timer
    });
  }

  function tryLocalRevert() {
    const editor = getActiveEditor();
    if (!editor || ghostDiffTimeouts.size === 0) return false;

    const text = editor.value;

    for (const [key, item] of ghostDiffTimeouts.entries()) {
      if (item.oldText && item.newText) {
        const foundIdx = text.indexOf(item.newText);
        if (foundIdx !== -1) {
          // Revert this slot only preserving Undo stack
          replaceRangeWithUndo(editor, foundIdx, foundIdx + item.newText.length, item.oldText);
          editor.setSelectionRange(foundIdx, foundIdx + item.oldText.length);
          editor.classList.remove('slot-ghost-diff');

          clearTimeout(item.timer);
          ghostDiffTimeouts.delete(key);
          return true;
        }
      }
    }
    return false;
  }

  // Dedicated Ctrl+Z / Cmd+Z Handler for reverting Slot Agent execution
  function trySlotUndo(editor) {
    if (skipSlotUndo > 0) {
      skipSlotUndo--;
      return false;
    }
    if (!editor || slotUndoHistory.length === 0) return false;

    const text = editor.value;
    for (let i = slotUndoHistory.length - 1; i >= 0; i--) {
      const item = slotUndoHistory[i];
      if (!item.newContent || !item.oldContent) continue;

      const idx = text.indexOf(item.newContent);
      if (idx !== -1) {
        replaceRangeWithUndo(editor, idx, idx + item.newContent.length, item.oldContent);
        editor.setSelectionRange(idx, idx + item.oldContent.length);
        editor.classList.remove('slot-ghost-diff');

        slotUndoHistory.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Helper
  // Resolve the editor the user is currently in. The app hosts two panes
  // (#editor / #editor-secondary); previously this matched neither and always
  // fell through to the first textarea, i.e. the primary pane.
  function getActiveEditor() {
    const el = document.activeElement;
    if (el && el.tagName === 'TEXTAREA' && (el.id === 'editor' || el.id === 'editor-secondary')) {
      return el;
    }
    if (typeof global.getActiveEditorEl === 'function') {
      const resolved = global.getActiveEditorEl();
      if (resolved) return resolved;
    }
    return document.getElementById('editor') || document.querySelector('textarea');
  }

  // 8. Event Listeners & Keyboard Hook
  function setupEditorEvents(editor) {
    if (!editor || editor.__slotAgentAttached) return;
    editor.__slotAgentAttached = true;

    // Track human typing timestamp for debounce merge
    editor.addEventListener('keydown', (e) => {
      lastTypingTime = Date.now();

      // Check if quick selector is open
      if (selectorEl && selectorEl.classList.contains('active')) {
        const presets = selectorPresets || getAvailablePresets();
        // Esc: close menu
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          hideQuickSelector();
          return;
        }
        // Arrow navigation (plain ArrowUp/ArrowDown on every platform; no modifier
        // needed or accepted). The legacy `e.key === 'Down'/'Up'` aliases (old
        // IE-style key names) were removed: no engine this app runs on — Chromium,
        // WebKit/WKWebView, or Firefox — has ever emitted them as `key` for the
        // arrow keys, so `e.key === 'ArrowDown'` alone covers every real event.
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectorSelectedIndex = (selectorSelectedIndex + 1) % presets.length;
          renderSelectorList(presets);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectorSelectedIndex = (selectorSelectedIndex - 1 + presets.length) % presets.length;
          renderSelectorList(presets);
          return;
        }
        // Tab / Enter: commit
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commitPreset(presets[selectorSelectedIndex]);
          return;
        }
        // Numbers 1-9: instant commit
        if (e.key >= '1' && e.key <= '9') {
          const num = parseInt(e.key, 10);
          if (num <= presets.length) {
            e.preventDefault();
            e.stopPropagation();
            commitPreset(presets[num - 1]);
            return;
          }
        }
      }

      // Tab right after a snippet trigger (";sum") types the snippet; any other Tab is left to the editor
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && e.keyCode !== 229) {
        if (tryExpandSnippetTrigger(editor)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Ctrl+Z / Cmd+Z: Revert Slot Agent execution directly to original prompt
      if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (trySlotUndo(editor)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Esc: Local Revert (within 5 seconds of ghost diff)
      if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        if (tryLocalRevert()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Ctrl+Enter / Cmd+Enter: run the task under the caret, or do what the current line asks for (see
      // ctrlEnterFlow). The decision is made synchronously; what happens next is reported through toasts
      // (notifyNoAction), never through a return value. Every Ctrl/Cmd+Enter variant (Shift, Alt) is taken
      // here, which is why the shortcut recorder refuses them (RESERVED_SYSTEM_SHORTCUTS in app.js).
      // The Enter that confirms an IME conversion is not this key, and a held key does not repeat the run.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) handleCtrlEnter(editor);
        return;
      }
    }, true);

    editor.addEventListener('input', () => {
      lastTypingTime = Date.now();
      scheduleRunButtonUpdate(editor);

      // Read the textarea value once per keystroke and reuse it below.
      const pos = editor.selectionStart;
      const text = editor.value;

      // 1. Auto-IME normalization
      if (normalizeIMESlotTrigger(editor, pos, text)) {
        return;
      }

      // 2. Trigger check for quick selector.
      // The cheap 2-3 char delimiter test runs FIRST: the lexical shield walks
      // the whole prefix, and on the overwhelming majority of keystrokes it
      // cannot change the outcome (no trigger typed, selector not open).
      const twoChars = text.substring(Math.max(0, pos - 2), pos);
      const threeChars = text.substring(Math.max(0, pos - 3), pos);

      let trigger = null;
      let triggerStart = 0;
      if (twoChars === '{{') {
        trigger = '{{'; triggerStart = pos - 2;
      } else if (twoChars === '[?') {
        trigger = '[?'; triggerStart = pos - 2;
      } else if (twoChars === '【?') {
        trigger = '【?'; triggerStart = pos - 2;
      } else if (twoChars === '[!') {
        trigger = '[!'; triggerStart = pos - 2;
      } else if (threeChars === '[>>') {
        trigger = '[>>'; triggerStart = pos - 3;
      }

      const selectorActive = !!(selectorEl && selectorEl.classList.contains('active'));
      if (!trigger && !selectorActive) {
        return; // nothing to open, nothing to dismiss
      }

      if (isInsideCodeOrUrl(text, pos)) {
        hideQuickSelector();
        return;
      }

      if (trigger) {
        showQuickSelector(editor, trigger, triggerStart);
      } else {
        // Dismiss quick selector if typing normal words or space (0s evaporation)
        hideQuickSelector();
      }
    });

    editor.addEventListener('compositionend', () => {
      normalizeIMESlotTrigger(editor);
    });

    // Cursor-only moves (arrow keys, mouse clicks) don't fire 'input', but the run
    // button still needs to appear/disappear/reposition as the caret enters or
    // leaves a slot.
    editor.addEventListener('keyup', (e) => {
      if (e.key && e.key.indexOf('Arrow') === 0) scheduleRunButtonUpdate(editor);
    });
    editor.addEventListener('click', () => scheduleRunButtonUpdate(editor));

    editor.addEventListener('blur', () => {
      clearTimeout(blurHideTimer);
      blurHideTimer = setTimeout(() => {
        hideQuickSelector();
        hideRunButton();
      }, 200);
    });
  }

  // 9. Attach global callbacks
  window.__onSlotAgentResult = function (result) {
    handleSlotResult(result);
  };

  window.__onExternalFileChanged = function (filePath) {
    // If current active note matches, trigger merge check
    const curPath = (global.getCurrentTabPath && global.getCurrentTabPath()) || "";
    if (curPath && curPath === filePath) {
      if (window.backend && window.backend.readFileByPath) {
        window.backend.readFileByPath(filePath).then(fileRes => {
          if (fileRes && fileRes.content !== undefined) {
            handleSlotResult({
              newContent: fileRes.content
            });
          }
        });
      }
    }
  };

  // Forward slot settings that other frontend modules depend on
  // (hover peek toggle / ghost diff duration).
  function propagateSlotConfig() {
    if (global.TaskManager && global.TaskManager.updateConfig) {
      global.TaskManager.updateConfig({ hover_peek_enabled: slotConfig.hover_peek_enabled !== false });
    }
    applyGhostDiffDuration();
  }

  // Expose SlotAgent global API
  global.SlotAgent = {
    init: async function () {
      initSelectorDOM();
      initRunButtonDOM();
      const editor = getActiveEditor();
      if (editor) setupEditorEvents(editor);

      if (window.backend && window.backend.getActiveSlotConfigJSON) {
        try {
          // Bound backend calls resolve asynchronously (webview's Bind wraps every
          // call in a Promise even for a synchronous Go method) - awaiting it was
          // missing here, so `raw` was always the Promise object itself and
          // JSON.parse(raw) always threw, silently caught below. slotConfig was
          // therefore never actually synced from the backend; every session ran on
          // this file's hardcoded JS defaults regardless of agents.yaml.
          const raw = await window.backend.getActiveSlotConfigJSON();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              slotConfig = Object.assign(slotConfig, parsed);
              // the Go side leaves the field out when nothing is disabled: an older list must not stay
              if (!Array.isArray(parsed.disabled_agents)) slotConfig.disabled_agents = [];
              finalizeAgentConfig(slotConfig);
            }
          }
        } catch (e) {
          console.warn('Failed to load active slot config in SlotAgent.init:', e);
        }
      }
      propagateSlotConfig();
      applyRunButtonLabel();
    },
    attachEditor: setupEditorEvents,
    triggerSlotExecution: triggerSlotExecution,
    // What the Ctrl+Enter key does (also the run button): see ctrlEnterFlow. Returns a promise.
    handleCtrlEnter: handleCtrlEnter,
    cancelSlotExecution: cancelSlotExecution,
    // Opens the snippet list at the caret (palette entry "Insert task snippet").
    openSnippetPicker: function () {
      const editor = getActiveEditor();
      if (!editor) return;
      if (listSnippets().length === 0) {
        notifyNoAction('autoSelSnippetsNone', 'No snippets available');
        return;
      }
      editor.focus();
      showQuickSelector(editor, '', editor.selectionStart, true);
    },
    updateConfig: function (newCfg) {
      if (newCfg) {
        slotConfig = Object.assign(slotConfig, newCfg);
        finalizeAgentConfig(slotConfig);
        propagateSlotConfig();
      }
      applyRunButtonLabel();
    },
    getConfig: function () {
      return slotConfig;
    },
    // Internal helpers exposed only so the Node unit tests can exercise pure logic
    // directly; not part of the public API.
    _findEnclosingSlotSpan: findEnclosingSlotSpan,
    _insideResultBlock: insideResultBlock,
    _runningTaskCount: function () { return runningTasks.size; },
    _finalizeAgentConfig: finalizeAgentConfig,
    _getAvailablePresets: getAvailablePresets,
    _defaultAgentKey: defaultAgentKey,
    _updateRunButton: updateRunButton
  };

  // Auto initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', global.SlotAgent.init);
  } else {
    global.SlotAgent.init();
  }

})(window);
