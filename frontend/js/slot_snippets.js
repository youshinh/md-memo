// MD-Memo snippets: ready-made text for the task notations, plus the user's own from agents.yaml.
//
//   [[ @llm <body> ]]      kind 'llm'      the built-in LLM
//   {{ @<agent> <body> }}  kind 'agent'    an agents.yaml agent
//   [[ $ <body> ]]         kind 'command'  a shell command (Windows and Unix variants)
//   <body>                 kind 'text'     inserted as it is
//
// A snippet is { id, label, kind, body, os: 'win' | 'unix' | 'any', trigger?, agent?, builtin }.
// Bodies may use ${selection}, ${line}, ${date}, ${agent} and $0 (where the caret ends up); "$$0" and
// "$${" are a literal "$0" and "${".
//
// Cost model: loading this file only defines functions and one table of strings. The built-in list is
// built the first time list() asks for a language and then cached; nothing touches the DOM or a timer.
(function (global) {
  'use strict';

  const KINDS = Object.freeze(['llm', 'agent', 'command', 'text']);

  // [id, kind, os, trigger, ja label, ja body, en label, en body]. A command that differs between
  // PowerShell (Windows) and sh (macOS / Linux) has one row per os under the same id. Nothing here
  // deletes, overwrites or installs anything.
  const BUILTIN = [
    ['llm-summarize', 'llm', 'any', ';sum', '要約する', '次の文章を3行で要約して: ${selection}$0', 'Summarize', 'Summarize the following text in 3 lines: ${selection}$0'],
    ['llm-translate-en', 'llm', 'any', ';en', '英語に翻訳', '次の文章を英語に翻訳して: ${selection}$0', 'Translate to English', 'Translate the following text into English: ${selection}$0'],
    ['llm-translate-ja', 'llm', 'any', ';ja', '日本語に翻訳', '次の文章を自然な日本語に翻訳して: ${selection}$0', 'Translate to Japanese', 'Translate the following text into natural Japanese: ${selection}$0'],
    ['llm-proofread', 'llm', 'any', ';proof', '校正する', '次の文章の誤字脱字と不自然な表現を校正して: ${selection}$0', 'Proofread', 'Proofread the following text for typos and awkward phrasing: ${selection}$0'],
    ['llm-rephrase', 'llm', 'any', ';rephrase', '言い換える', '次の文章をより丁寧で分かりやすい表現に言い換えて: ${selection}$0', 'Rephrase', 'Rephrase the following text to be clearer and more polite: ${selection}$0'],
    ['llm-bullets', 'llm', 'any', ';bullets', '箇条書きにする', '次の内容を箇条書きに整理して: ${selection}$0', 'Bullet points', 'Turn the following into a bulleted list: ${selection}$0'],
    ['llm-table', 'llm', 'any', ';table', '表にまとめる', '次の内容をMarkdownの表にまとめて: ${selection}$0', 'Make a table', 'Organize the following into a Markdown table: ${selection}$0'],
    ['llm-ideas', 'llm', 'any', ';ideas', 'アイデアを出す', '次のテーマについてアイデアを5つ出して: ${selection}$0', 'Brainstorm ideas', 'Give me 5 ideas about the following topic: ${selection}$0'],

    ['agent-research', 'agent', 'any', ';research', '調査する', 'Webで調べて、要点を出典付きでまとめて: ${selection}$0', 'Research', 'Research the following on the web and summarize the key points with sources: ${selection}$0'],
    ['agent-implement', 'agent', 'any', ';impl', '実装する', '次の内容を実装して: ${selection}$0', 'Implement', 'Implement the following: ${selection}$0'],
    ['agent-test', 'agent', 'any', ';test', 'テストを実行', 'テストを実行して、失敗があれば原因を説明して$0', 'Run tests', 'Run the tests and explain the cause of any failure$0'],
    ['agent-review', 'agent', 'any', ';review', 'レビューする', '次の変更をレビューして、問題点を指摘して: ${selection}$0', 'Review', 'Review the following changes and point out problems: ${selection}$0'],
    ['agent-refactor', 'agent', 'any', ';refactor', 'リファクタリング', '動作を変えずに次のコードをリファクタリングして: ${selection}$0', 'Refactor', 'Refactor the following code without changing its behavior: ${selection}$0'],

    ['cmd-date', 'command', 'win', ';date', '現在の日時', 'Get-Date -Format "yyyy-MM-dd HH:mm"', 'Current date and time', 'Get-Date -Format "yyyy-MM-dd HH:mm"'],
    ['cmd-date', 'command', 'unix', ';date', '現在の日時', 'date "+%Y-%m-%d %H:%M"', 'Current date and time', 'date "+%Y-%m-%d %H:%M"'],
    ['cmd-git-status', 'command', 'any', ';gst', 'Git: 変更状況', 'git status', 'Git status', 'git status'],
    ['cmd-git-diff-stat', 'command', 'any', ';gdiff', 'Git: 差分の要約', 'git diff --stat', 'Git diff summary', 'git diff --stat'],
    ['cmd-git-log', 'command', 'any', ';glog', 'Git: 直近のコミット', 'git log --oneline -20', 'Git recent commits', 'git log --oneline -20'],
    ['cmd-grep-word', 'command', 'win', ';grep', '単語を検索 (md / txt)', 'Get-ChildItem -Recurse -File -Include *.md,*.txt | Select-String -SimpleMatch -Pattern "${selection}$0" | Select-Object -First 50', 'Search for a word (md / txt)', 'Get-ChildItem -Recurse -File -Include *.md,*.txt | Select-String -SimpleMatch -Pattern "${selection}$0" | Select-Object -First 50'],
    ['cmd-grep-word', 'command', 'unix', ';grep', '単語を検索 (grep)', 'grep -rnF "${selection}$0" . | head -50', 'Search for a word (grep)', 'grep -rnF "${selection}$0" . | head -50'],
    ['cmd-rg-word', 'command', 'any', ';rg', '単語を検索 (ripgrep)', 'rg -n -F --max-columns 200 "${selection}$0" .', 'Search for a word (ripgrep)', 'rg -n -F --max-columns 200 "${selection}$0" .'],
    ['cmd-count-lines', 'command', 'win', ';wc', '行数を数える (ファイル)', 'Get-Content "${selection}$0" | Measure-Object -Line', 'Count lines (file)', 'Get-Content "${selection}$0" | Measure-Object -Line'],
    ['cmd-count-lines', 'command', 'unix', ';wc', '行数を数える (ファイル)', 'wc -l "${selection}$0"', 'Count lines (file)', 'wc -l "${selection}$0"'],
    ['cmd-sort-unique', 'command', 'win', ';uniq', '重複を除いて並べ替え (ファイル)', 'Get-Content "${selection}$0" | Sort-Object -Unique', 'Unique sorted lines (file)', 'Get-Content "${selection}$0" | Sort-Object -Unique'],
    ['cmd-sort-unique', 'command', 'unix', ';uniq', '重複を除いて並べ替え (ファイル)', 'sort -u "${selection}$0"', 'Unique sorted lines (file)', 'sort -u "${selection}$0"'],
    ['cmd-jq', 'command', 'any', ';jq', 'JSON を整形 (jq)', 'jq . "${selection}$0"', 'Pretty-print JSON (jq)', 'jq . "${selection}$0"'],
    ['cmd-large-files', 'command', 'win', ';big', '大きいファイルを探す', 'Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 20 FullName, Length', 'List large files', 'Get-ChildItem -Recurse -File | Sort-Object Length -Descending | Select-Object -First 20 FullName, Length'],
    ['cmd-large-files', 'command', 'unix', ';big', '大きいファイルを探す', 'du -ah . | sort -rh | head -20', 'List large files', 'du -ah . | sort -rh | head -20'],
    ['cmd-list-files', 'command', 'win', ';ls', 'ファイル一覧', 'Get-ChildItem | Select-Object Mode, Length, LastWriteTime, Name', 'List files', 'Get-ChildItem | Select-Object Mode, Length, LastWriteTime, Name'],
    ['cmd-list-files', 'command', 'unix', ';ls', 'ファイル一覧', 'ls -la', 'List files', 'ls -la'],

    ['text-llm-task', 'text', 'any', ';llm', 'LLM タスク (空)', '[[ @llm $0 ]]', 'LLM task (blank)', '[[ @llm $0 ]]'],
    ['text-agent-task', 'text', 'any', ';agent', 'エージェントタスク (空)', '{{ @${agent} $0 }}', 'Agent task (blank)', '{{ @${agent} $0 }}'],
    ['text-command-task', 'text', 'any', ';cmd', 'コマンドタスク (空)', '[[ $ $0 ]]', 'Command task (blank)', '[[ $ $0 ]]']
  ];

  const builtinCache = Object.create(null);

  function str(v) {
    return v == null ? '' : String(v);
  }

  function langOf(lang) {
    return /^en/i.test(str(lang)) ? 'en' : 'ja';
  }

  function normalizeOS(os) {
    const s = str(os).trim().toLowerCase();
    if (!s || s === 'any' || s === 'all' || s === '*') return 'any';
    if (s === 'win' || s === 'win32' || s === 'windows' || s === 'powershell') return 'win';
    if (s === 'unix' || s === 'linux' || s === 'mac' || s === 'macos' || s === 'darwin' || s === 'sh') return 'unix';
    return 'any';
  }

  function builtins(lang) {
    const l = langOf(lang);
    if (!builtinCache[l]) {
      const at = l === 'en' ? 6 : 4;
      builtinCache[l] = BUILTIN.map((r) => Object.freeze({
        id: r[0], label: r[at], kind: r[1], body: r[at + 1], os: r[2], trigger: r[3], builtin: true
      }));
    }
    return builtinCache[l];
  }

  // A user snippet as it comes from agents.yaml / config JSON (lower-case or Go-style keys). Anything
  // unusable (no body, unknown kind) is dropped. Later duplicates of the same id + os replace earlier ones.
  function normalizeUser(list) {
    const seen = new Map();
    (Array.isArray(list) ? list : []).forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const pick = (a, b) => (raw[a] !== undefined ? raw[a] : raw[b]);
      const kind = str(pick('kind', 'Kind')).trim().toLowerCase();
      const body = str(pick('body', 'Body'));
      if (KINDS.indexOf(kind) < 0 || !body.trim()) return;
      const id = str(pick('id', 'ID')).trim() || 'user-' + (i + 1);
      const snippet = { id, label: str(pick('label', 'Label')).trim() || id, kind, body, os: normalizeOS(pick('os', 'OS')), builtin: false };
      const trigger = str(pick('trigger', 'Trigger')).trim();
      const agent = str(pick('agent', 'Agent')).trim();
      if (trigger) snippet.trigger = trigger;
      if (agent) snippet.agent = agent;
      seen.set(JSON.stringify([id, snippet.os]), snippet);
    });
    return Array.from(seen.values());
  }

  function detectOS() {
    try {
      if (global.MDMemoPlatform && global.MDMemoPlatform.isMac) return 'unix';
      const nav = global.navigator;
      const s = nav ? str(nav.platform || nav.userAgent) : '';
      if (/Win/i.test(s)) return 'win';
      if (/Mac|Linux|X11|iPhone|iPad|Android/i.test(s)) return 'unix';
    } catch (e) { /* fall through */ }
    if (typeof process !== 'undefined' && process && process.platform) return process.platform === 'win32' ? 'win' : 'unix';
    return 'win';
  }

  // ---- list ------------------------------------------------------------------------------------------
  // list({ kind, os, lang, user }): the built-ins for the language with the user's snippets merged in.
  // A user snippet with the id of a built-in replaces it in place; the others are appended in order.
  //   kind  'llm' | 'agent' | 'command' | 'text', or an array of them (default: all)
  //   os    'win' | 'unix' | 'auto' (this machine). Undefined or 'any' keeps every variant.
  //   lang  'ja' (default) | 'en'
  //   user  the `snippets` array from agents.yaml (see normalizeUser)
  // The built-in objects are frozen and shared: do not modify them.
  function list(opts) {
    const o = opts || {};
    const user = normalizeUser(o.user);
    const builtinIds = new Set(builtins(o.lang).map((b) => b.id));
    const overridden = new Set(user.map((u) => u.id));
    const placed = new Set();
    const merged = [];
    builtins(o.lang).forEach((b) => {
      if (!overridden.has(b.id)) { merged.push(b); return; }
      if (placed.has(b.id)) return;
      placed.add(b.id);
      user.forEach((u) => { if (u.id === b.id) merged.push(u); });
    });
    user.forEach((u) => { if (!builtinIds.has(u.id)) merged.push(u); });

    const kinds = o.kind ? [].concat(o.kind).map((k) => str(k).toLowerCase()) : null;
    const os = o.os === 'auto' ? detectOS() : normalizeOS(o.os);
    return merged.filter((s) => (!kinds || kinds.indexOf(s.kind) >= 0) && (os === 'any' || s.os === 'any' || s.os === os));
  }

  // ---- expand ----------------------------------------------------------------------------------------
  const lazy = Object.create(null);
  function rx(name, make) {
    return lazy[name] || (lazy[name] = make());
  }

  function oneLine(v) {
    return str(v).replace(/[\r\n]+/g, ' ');
  }

  // Cuts at a length without splitting a surrogate pair.
  function cut(s, n) {
    if (s.length <= n) return s;
    const code = s.charCodeAt(n - 1);
    return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  }

  // A value that is going to sit inside a quoted word of a shell command: nothing that could close the
  // quote, expand a variable or start another command survives, and it stays one short line.
  function shellSafe(v, keepBackslash) {
    const unsafe = keepBackslash ? /[\x00-\x1f\x7f"'`$%;&|<>^!]/g : /[\x00-\x1f\x7f"'`$%;&|<>^!\\]/g;
    return cut(oneLine(v).replace(unsafe, ' ').replace(/ {2,}/g, ' ').trim(), 300);
  }

  function balanced(body, open, close) {
    let depth = 0;
    for (let j = 0; j < body.length - 1;) {
      if (body.startsWith(open, j)) { depth++; j += 2; }
      else if (body.startsWith(close, j)) { if (--depth < 0) return false; j += 2; }
      else j++;
    }
    return depth === 0;
  }

  function neutralize(s, open, close, caret) {
    let text = '';
    let at = caret;
    for (let i = 0; i < s.length;) {
      if (s.startsWith(open, i) || s.startsWith(close, i)) {
        if (i < caret) at++;
        text += s[i] + ' ' + s[i + 1];
        i += 2;
      } else {
        text += s[i++];
      }
    }
    return { text, caret: at };
  }

  function formatDate(d) {
    if (typeof d === 'string' && d.trim()) return d.trim();
    const dt = d instanceof Date ? d : typeof d === 'number' && isFinite(d) ? new Date(d) : new Date();
    if (isNaN(dt.getTime())) return '';
    const p = (n) => (n < 10 ? '0' : '') + n;
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }

  // ctx.agents (config.agents shaped { key: { aliases } }, or an array of names) tells which agents
  // exist; a snippet's agent, then ctx.defaultAgent, then the first agent is used, whichever exists.
  function pickAgent(snippetAgent, ctx) {
    const names = new Map();
    let firstKey = '';
    const add = (key, aliases) => {
      if (typeof key !== 'string' || !key) return;
      if (!firstKey) firstKey = key;
      names.set(key.toLowerCase(), key);
      (Array.isArray(aliases) ? aliases : []).forEach((a) => { if (typeof a === 'string' && a) names.set(a.toLowerCase(), key); });
    };
    if (Array.isArray(ctx.agents)) ctx.agents.forEach((k) => add(k, null));
    else if (ctx.agents && typeof ctx.agents === 'object') Object.keys(ctx.agents).forEach((k) => add(k, ctx.agents[k] && ctx.agents[k].aliases));
    const wanted = [snippetAgent, ctx.defaultAgent, ctx.agent].map(str).map((x) => x.trim()).filter(Boolean);
    if (!names.size) return (wanted[0] || 'claude-code').replace(/[^A-Za-z0-9_.-]/g, '') || 'claude-code';
    for (let i = 0; i < wanted.length; i++) {
      const key = names.get(wanted[i].toLowerCase());
      if (key) return key;
    }
    return firstKey;
  }

  const WRAP = {
    llm: { open: '[[', close: ']]', head: () => '[[ @llm ', tail: ' ]]' },
    command: { open: '[[', close: ']]', head: () => '[[ $ ', tail: ' ]]' },
    agent: { open: '{{', close: '}}', head: (agent) => '{{ @' + agent + ' ', tail: ' }}' }
  };

  // expand(snippet, ctx) -> { text, caret }
  //   ctx  { selection, line, date, agents, defaultAgent }; date is a string, a Date or a timestamp
  //        (default: today, YYYY-MM-DD)
  // text is what to insert, wrapped for the snippet's kind; caret is a UTF-16 index into text (the
  // first $0, else the end of the body). In a task the substituted values are made single-line and
  // cannot break the notation; in a command they are also stripped of quotes, "$", ";", "|" and other
  // shell syntax; ${selection} / ${line} are cut at 2000 characters in a task and 300 in a command.
  function expand(snippet, ctx) {
    const s = snippet && typeof snippet === 'object' ? snippet : {};
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const kind = KINDS.indexOf(s.kind) >= 0 ? s.kind : 'text';
    const wrap = WRAP[kind] || null;
    const keepBackslash = s.os === 'win';
    let body = str(s.body);
    if (wrap) body = body.replace(/[ \t]*\r?\n\s*/g, ' ');

    let agentName = null;
    const agent = () => (agentName === null ? (agentName = pickAgent(s.agent, c)) : agentName);
    const value = (name) => {
      let v = name === 'selection' ? str(c.selection) : name === 'line' ? str(c.line) : name === 'date' ? formatDate(c.date) : agent();
      if (kind === 'command') return shellSafe(v, keepBackslash);
      if (wrap) v = cut(oneLine(v), 2000);
      return v;
    };

    const re = rx('placeholder', () => /\$\$(?=0|\{)|\$\{(selection|line|date|agent)\}|\$0/g);
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    let caret = -1;
    let m;
    while ((m = re.exec(body))) {
      out += body.slice(last, m.index);
      last = m.index + m[0].length;
      if (m[0] === '$0') { if (caret < 0) caret = out.length; }
      else if (m[0] === '$$') out += '$';
      else out += value(m[1]);
    }
    out += body.slice(last);
    if (caret < 0) caret = out.length;
    if (!wrap) return { text: out, caret };

    if (!balanced(out, wrap.open, wrap.close)) {
      const fixed = neutralize(out, wrap.open, wrap.close, caret);
      out = fixed.text;
      caret = fixed.caret;
    }
    const head = wrap.head(kind === 'agent' ? agent() : '');
    return { text: head + out + wrap.tail, caret: head.length + caret };
  }

  // ---- triggers --------------------------------------------------------------------------------------
  // Trims, lower-cases and turns full-width ASCII (what a Japanese IME types for ";sum") into plain ASCII.
  function normalizeTrigger(t) {
    const s = str(t);
    let out = '';
    for (let k = 0; k < s.length; k++) {
      const code = s.charCodeAt(k);
      out += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : code === 0x3000 ? ' ' : s[k];
    }
    return out.trim().toLowerCase();
  }

  // Snippets of `list` whose trigger equals the typed text (first) or starts with it. Empty text matches
  // nothing. Pass a list already filtered by os, or both variants of a command come back.
  function matchTrigger(typedText, snippets) {
    const q = normalizeTrigger(typedText);
    if (!q || !Array.isArray(snippets)) return [];
    const exact = [];
    const prefix = [];
    snippets.forEach((s) => {
      const t = s && s.trigger ? normalizeTrigger(s.trigger) : '';
      if (!t) return;
      if (t === q) exact.push(s);
      else if (t.startsWith(q)) prefix.push(s);
    });
    return exact.concat(prefix);
  }

  function findByTrigger(typedText, snippets) {
    const q = normalizeTrigger(typedText);
    const hit = matchTrigger(q, snippets)[0];
    return hit && normalizeTrigger(hit.trigger) === q ? hit : null;
  }

  const api = {
    KINDS,
    list,
    expand,
    matchTrigger,
    findByTrigger,
    normalizeTrigger,
    normalizeUser,
    detectOS
  };

  global.SlotSnippets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
