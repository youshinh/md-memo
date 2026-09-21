// MD-Memo Auto Selector: decides what Ctrl+Enter should do with a line that is not already a slot.
//
// Pure and deterministic: no DOM, no timers, no network, no model. The three task notations are
//   [[ @llm <instruction> ]]        built-in LLM, result inserted below the line
//   {{ @<agent> <instruction> }}    an agents.yaml agent (or alias), result inserted below the line
//   [[ $ <command> ]]               a shell command, output inserted below the line
// and this file finds them (findTaskAt), writes them (decorate), classifies plain text as a request or
// not (classify), and owns the result markers that go under a task line (makeRunMarker, makeResultBlock,
// findResultAfter, newTaskId) and the lookup of the text a recorded task was written about (findContextAbove).
// Every index is a UTF-16 index, i.e. what a textarea reports.
//
// Cost model: loading this file only defines functions and plain word tables. Regular expressions are
// built on first use and cached, so a note that never presses Ctrl+Enter pays nothing.
// Whitespace classes such as [ \t　] contain the ideographic space (U+3000) written out literally.
(function (global) {
  'use strict';

  // ---- lazy regexp cache ---------------------------------------------------------------------------
  const cache = Object.create(null);
  function rx(name, make) {
    return cache[name] || (cache[name] = make());
  }

  function str(v) {
    return v == null ? '' : String(v);
  }

  function isWs(ch) {
    return ch === ' ' || ch === '\t' || ch === '　';
  }

  function trimAll(s) {
    return str(s).replace(rx('trim', () => /^[\s　]+|[\s　]+$/g), '');
  }

  function clampIdx(v, n) {
    const x = typeof v === 'number' && isFinite(v) ? Math.floor(v) : 0;
    return x < 0 ? 0 : x > n ? n : x;
  }

  function lineStartOf(text, idx) {
    return idx <= 0 ? 0 : text.lastIndexOf('\n', idx - 1) + 1;
  }

  // End of the line that contains idx, without the newline and without a CR before it.
  function lineEndOf(text, idx) {
    let e = text.indexOf('\n', idx);
    if (e < 0) e = text.length;
    if (e > 0 && text.charCodeAt(e - 1) === 13 && e - 1 >= idx) e--;
    return e;
  }

  // ---- agents --------------------------------------------------------------------------------------
  // Only used when the caller passes no agent list; mirrors the default agents.yaml.
  const DEFAULT_AGENTS = { 'claude-code': ['claude', 'cc'], hermes: [], codex: [], agy: ['antigravity', 'gemini'] };

  // agents may be: undefined (built-in defaults), an object shaped like config.agents
  // ({ key: { aliases: [] } }), an array of names, or a function(name) -> canonical key | falsy.
  function makeResolver(agents) {
    if (typeof agents === 'function') {
      return (name) => {
        if (str(name).toLowerCase() === 'llm') return null;
        const r = agents(name);
        return r ? (r === true ? str(name) : str(r)) : null;
      };
    }
    const map = new Map();
    const add = (key, aliases) => {
      if (typeof key !== 'string' || !key || key.toLowerCase() === 'llm') return;
      map.set(key.toLowerCase(), key);
      (Array.isArray(aliases) ? aliases : []).forEach((a) => {
        if (typeof a === 'string' && a && a.toLowerCase() !== 'llm') map.set(a.toLowerCase(), key);
      });
    };
    if (Array.isArray(agents)) agents.forEach((k) => add(k, null));
    else if (agents && typeof agents === 'object') Object.keys(agents).forEach((k) => add(k, agents[k] && agents[k].aliases));
    else Object.keys(DEFAULT_AGENTS).forEach((k) => add(k, DEFAULT_AGENTS[k]));
    return (name) => map.get(str(name).toLowerCase()) || null;
  }

  function resolverFor(opts) {
    if (opts && opts.agents !== undefined && opts.agents !== null) return makeResolver(opts.agents);
    return rx('defaultResolver', () => makeResolver(undefined));
  }

  // ---- line prefixes (indent, quote, list bullet) ----------------------------------------------------
  // prefix + body always equals the input. A line that starts with ">>" is reserved for chaining (round
  // B): it is not a quote, so nothing here treats it as a prefix.
  function splitLinePrefix(line) {
    const s = str(line);
    const n = s.length;
    let i = 0;
    for (;;) {
      while (i < n && isWs(s[i])) i++;
      if (s[i] === '>' && s[i + 1] !== '>') {
        i++;
        if (i < n && isWs(s[i])) i++;
        continue;
      }
      break;
    }
    const list = rx('listMarker', () => /^(?:[-*+][ \t　]+(?:\[[ xX]\][ \t　]+)?|\d{1,3}[.)．）][ \t　]+|[０-９]{1,3}[.)．）][ \t　]+|[・•●○◦][ \t　]*)/).exec(s.slice(i));
    if (list) i += list[0].length;
    return { prefix: s.slice(0, i), body: s.slice(i) };
  }

  // ---- code fences ---------------------------------------------------------------------------------
  function fenceLine(line) {
    const m = rx('fence', () => /^ {0,3}(`{3,}|~{3,})(.*)$/).exec(line);
    if (!m) return null;
    if (m[1][0] === '`' && m[2].indexOf('`') >= 0) return null;
    return { ch: m[1][0], len: m[1].length, rest: m[2] };
  }

  // Incremental: asking for ascending indices reads the text once.
  function makeFenceScanner(text) {
    let pos = 0;
    let open = null;
    return function inFence(idx) {
      const ls = lineStartOf(text, idx);
      if (ls < pos) { pos = 0; open = null; }
      while (pos < ls) {
        let e = text.indexOf('\n', pos);
        if (e < 0) e = text.length;
        const f = fenceLine(text.slice(pos, e).replace(/\r$/, ''));
        if (open) {
          if (f && f.ch === open.ch && f.len >= open.len && trimAll(f.rest) === '') open = null;
        } else if (f) {
          open = f;
        }
        pos = e + 1;
      }
      if (open) return true;
      return !!fenceLine(text.slice(ls, lineEndOf(text, ls)));
    };
  }

  function inCodeFence(text, index) {
    const t = str(text);
    return makeFenceScanner(t)(clampIdx(index, t.length));
  }

  function insideInlineCode(text, lineStart, idx) {
    let ticks = 0;
    for (let i = lineStart; i < idx; i++) if (text.charCodeAt(i) === 96) ticks++;
    return ticks % 2 === 1;
  }

  // ---- task notations ------------------------------------------------------------------------------
  // Matching close on the same line, counting nested pairs so a wiki link inside an instruction
  // ("[[ @llm summarise [[Note]] ]]") does not end the task early.
  function parseNotation(text, i, lineEnd) {
    const open = text[i] === '[' ? '[[' : '{{';
    const close = open === '[[' ? ']]' : '}}';
    const line = text.slice(i, lineEnd);
    let depth = 0;
    let j = 0;
    while (j < line.length - 1) {
      if (line.startsWith(open, j)) { depth++; j += 2; }
      else if (line.startsWith(close, j)) {
        depth--;
        j += 2;
        if (depth === 0) return { open, close, end: i + j, inner: line.slice(2, j - 2) };
      } else j++;
    }
    return null;
  }

  function taskFromInner(n, resolve) {
    if (n.open === '[[') {
      const m = rx('llmOrCmd', () => /^[ \t　]*(@llm|\$)(?=[ \t　]|$)([\s\S]*)$/i).exec(n.inner);
      if (!m) return null;
      return { kind: m[1] === '$' ? 'command' : 'llm', instruction: trimAll(m[2]), agent: null, mention: null };
    }
    const m = rx('agentMention', () => /^[ \t　]*@([^\s:]+)[ \t　]*:?([\s\S]*)$/).exec(n.inner);
    if (!m) return null;
    const agent = resolve(m[1]);
    if (!agent) return null;
    return { kind: 'agent', instruction: trimAll(m[2]), agent, mention: m[1] };
  }

  // The task under the caret, or null. Only the three new forms count (wiki links, legacy {{ }} slots
  // and @skill mentions are not tasks), each on a single line, outside code fences and inline code.
  //   caret, endCaret   selection start / end (endCaret defaults to caret)
  //   opts.agents       agent list for {{ @name }}, see makeResolver (defaults to the built-in agents)
  // Returns { kind: 'llm'|'agent'|'command', start, end, lineStart, lineEnd, prefixLen, open, close,
  // instruction, agent, mention, outputMode: 'below', raw } where [start, end) is the whole notation,
  // text.slice(lineStart, lineStart + prefixLen) is the list/quote prefix of its line, and agent is the
  // canonical agents.yaml key (mention is what was typed).
  //
  // A caret counts as inside the task from the first bracket to just after the last one. When the task
  // is all that is on its line (after the prefix) the caret may be anywhere on that line. With a
  // selection: the task under selection start; else the first task on the selected lines.
  function findTaskAt(text, caret, endCaret, opts) {
    const t = str(text);
    const n = t.length;
    let a = clampIdx(caret, n);
    let b = endCaret === undefined || endCaret === null ? a : clampIdx(endCaret, n);
    if (b < a) { const x = a; a = b; b = x; }

    const firstLs = lineStartOf(t, a);
    let regionEnd = t.indexOf('\n', b);
    if (regionEnd < 0) regionEnd = n;
    if (b > a && b === lineStartOf(t, b)) regionEnd = b - 1;
    const region = t.slice(firstLs, regionEnd);
    if (region.indexOf('[[') < 0 && region.indexOf('{{') < 0) return null;

    const resolve = resolverFor(opts);
    let inFence = null;
    const found = [];
    let from = 0;
    while (from < region.length) {
      const p1 = region.indexOf('[[', from);
      const p2 = region.indexOf('{{', from);
      const p = p1 < 0 ? p2 : p2 < 0 ? p1 : Math.min(p1, p2);
      if (p < 0) break;
      from = p + 1;
      const i = firstLs + p;
      const ls = lineStartOf(t, i);
      const le = lineEndOf(t, i);
      const notation = parseNotation(t, i, le);
      if (!notation) continue;
      const task = taskFromInner(notation, resolve);
      if (!task) continue;
      if (insideInlineCode(t, ls, i)) continue;
      if (!inFence) inFence = makeFenceScanner(t);
      if (inFence(i)) continue;
      const prefixLen = Math.min(splitLinePrefix(t.slice(ls, le)).prefix.length, i - ls);
      const wholeLine = trimAll(t.slice(ls + prefixLen, i)) === '' && trimAll(t.slice(notation.end, le)) === '';
      found.push({
        kind: task.kind,
        start: i,
        end: notation.end,
        lineStart: ls,
        lineEnd: le,
        prefixLen,
        open: notation.open,
        close: notation.close,
        instruction: task.instruction,
        agent: task.agent,
        mention: task.mention,
        outputMode: 'below',
        raw: t.slice(i, notation.end),
        wholeLine
      });
      from = notation.end - firstLs;
    }
    if (!found.length) return null;

    let pick = found.find((c) => a >= c.start && a <= c.end) || null;
    if (!pick) pick = found.find((c) => c.wholeLine && c.lineStart === firstLs) || null;
    if (!pick && b > a) pick = found[0];
    if (!pick) return null;
    delete pick.wholeLine;
    return pick;
  }

  // ---- writing tasks -------------------------------------------------------------------------------
  function balanced(body, open, close) {
    let depth = 0;
    for (let j = 0; j < body.length - 1;) {
      if (body.startsWith(open, j)) { depth++; j += 2; }
      else if (body.startsWith(close, j)) { if (--depth < 0) return false; j += 2; }
      else j++;
    }
    return depth === 0;
  }

  function neutralize(body, open, close) {
    return body.split(open).join(open[0] + ' ' + open[1]).split(close).join(close[0] + ' ' + close[1]);
  }

  // Rewrites one line into a task, keeping its indent / quote / list prefix.
  //   kind  'llm' | 'agent' | 'command'
  //   opts  { agent, agents, sanitize }
  // A leading explicit marker of the same kind (@llm, @<agent>, "$ ") is not doubled. Returns null when
  // the text cannot be one single-line notation: empty, several lines, or delimiters that would end the
  // notation early. With opts.sanitize the lines are joined with spaces and stray delimiters are spaced
  // out ("]]" -> "] ]") so the result is always a valid task (use it for free text typed in a dialog).
  function decorate(kind, text, opts) {
    if (kind !== 'llm' && kind !== 'agent' && kind !== 'command') return null;
    const o = opts || {};
    let s = str(text).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    if (s.indexOf('\n') >= 0 && !o.sanitize) return null;
    let firstLine = s;
    let rest = '';
    const nl = s.indexOf('\n');
    if (nl >= 0) {
      firstLine = s.slice(0, nl);
      rest = s.slice(nl + 1);
    }
    const sp = splitLinePrefix(firstLine);
    let body = sp.body;
    if (rest) body += '\n' + rest;
    body = trimAll(body);
    if (o.sanitize) body = body.replace(/[ \t　]*\n[\s　]*/g, ' ');

    const resolve = resolverFor(o);
    if (kind === 'llm') body = body.replace(rx('stripLlm', () => /^@llm(?=[ \t　]|$)[ \t　]*/i), '');
    else if (kind === 'command') body = body.replace(rx('stripCmd', () => /^\$(?=[ \t　])[ \t　]*/), '');
    else {
      const m = rx('stripAgent', () => /^@([^\s:]+)[ \t　]*:?[ \t　]*/).exec(body);
      if (m && (resolve(m[1]) || str(o.agent).toLowerCase() === m[1].toLowerCase())) body = body.slice(m[0].length);
    }
    body = trimAll(body);
    if (!body) return null;

    const open = kind === 'agent' ? '{{' : '[[';
    const close = kind === 'agent' ? '}}' : ']]';
    if (!balanced(body, open, close)) {
      if (!o.sanitize) return null;
      body = neutralize(body, open, close);
    }
    if (kind === 'llm') return sp.prefix + '[[ @llm ' + body + ' ]]';
    if (kind === 'command') return sp.prefix + '[[ $ ' + body + ' ]]';
    const agent = str(o.agent).replace(/[\s:]+/g, '') || 'claude-code';
    return sp.prefix + '{{ @' + agent + ' ' + body + ' }}';
  }

  // ---- run markers and result blocks -----------------------------------------------------------------
  function cleanId(id) {
    return str(id).toLowerCase().replace(/[^a-z0-9]/g, '') || '0000';
  }

  // attrs: optional "key=value" words after the id ("ctx=above"); anything else is dropped.
  function cleanAttrs(attrs) {
    const a = str(attrs).toLowerCase().replace(rx('attrBad', () => /[^a-z0-9=_ ]/g), ' ').replace(/\s+/g, ' ').trim();
    return a ? ' ' + a : '';
  }

  function makeRunMarker(id, attrs) {
    return '<!-- md-memo:run ' + cleanId(id) + cleanAttrs(attrs) + ' -->';
  }

  // The result is trimmed and no blank line is added inside. A marker-like comment inside the result
  // ("<!-- md-memo:res") is escaped so it can never end the block early.
  function makeResultBlock(id, text, attrs) {
    const body = trimAll(str(text).replace(/\r\n?/g, '\n')).replace(rx('markerLike', () => /<!--(\s*\/?md-memo:)/g), '&lt;!--$1');
    const open = '<!-- md-memo:res ' + cleanId(id) + cleanAttrs(attrs) + ' -->';
    return body ? open + '\n' + body + '\n<!-- /md-memo:res -->' : open + '\n<!-- /md-memo:res -->';
  }

  // Looks at the line directly below the task (taskEnd is any index inside the task's line, e.g. the
  // task's `end`). Returns null, or { kind, marker, id, start, end, text, attrs? } where [start, end) is
  // exactly the marker text without the surrounding line breaks, so replacing that span in place is enough:
  //   kind 'block'   a complete "md-memo:res" block (marker 'res')
  //   kind 'marker'  a single marker line: a "md-memo:run" marker (marker 'run', still running or left
  //                  by a crash) or an "md-memo:res" opener that never closed (marker 'res')
  // attrs ("ctx=above") is only present when the marker carries some.
  function findResultAfter(text, taskEnd) {
    const t = str(text);
    const n = t.length;
    const nl = t.indexOf('\n', clampIdx(taskEnd, n));
    if (nl < 0) return null;
    const ls = nl + 1;
    const le = lineEndOf(t, ls);
    const line = t.slice(ls, le);
    const m = rx('markerLine', () => /^[ \t　]*<!--\s*md-memo:(run|res)\s+([a-z0-9]+)((?:\s+[a-z0-9_]+=[a-z0-9_]+)*)\s*-->[ \t　]*$/).exec(line);
    if (!m) return null;
    const start = ls + line.indexOf('<!--');
    const openEnd = ls + line.replace(/[ \t　]+$/, '').length;
    const withAttrs = (r) => (m[3].trim() ? Object.assign(r, { attrs: m[3].trim() }) : r);
    if (m[1] === 'run') return withAttrs({ kind: 'marker', marker: 'run', id: m[2], start, end: openEnd, text: t.slice(start, openEnd) });

    const closeRe = rx('closeLine', () => /^[ \t　]*<!--\s*\/md-memo:res\s*-->[ \t　]*$/);
    const openRe = rx('anyMarkerLine', () => /^[ \t　]*<!--\s*md-memo:(?:run|res)\s/);
    let p = le + 1;
    while (p <= n) {
      const e = lineEndOf(t, p);
      const l = t.slice(p, e);
      if (closeRe.test(l)) {
        const end = p + l.replace(/[ \t　]+$/, '').length;
        return withAttrs({ kind: 'block', marker: 'res', id: m[2], start, end, text: t.slice(start, end) });
      }
      if (openRe.test(l)) break;
      const next = t.indexOf('\n', p);
      if (next < 0) break;
      p = next + 1;
    }
    return withAttrs({ kind: 'marker', marker: 'res', id: m[2], start, end: openEnd, text: t.slice(start, openEnd) });
  }

  // What a task that was recorded below its text is about: the contiguous non-blank lines directly above
  // the task's line, looking through task lines, result blocks and run markers that sit in between (so a
  // second instruction added under the same text still finds it). At most 80 lines / 8000 characters, the
  // ones nearest the task. Returns { text, start, end, lines } or null when there is no such text.
  //   opts.agents    agent list for "{{ @name }}" task lines (see makeResolver)
  //   opts.maxLines  take fewer lines than that (the marker of a recorded task remembers how many its text had)
  function findContextAbove(text, taskStart, opts) {
    const t = str(text);
    const resolve = resolverFor(opts);
    const wanted = opts && Number.isFinite(opts.maxLines) ? Math.floor(opts.maxLines) : 80;
    const maxLines = Math.max(1, Math.min(80, wanted));
    const maxChars = 8000;
    const closeRe = rx('closeLine', () => /^[ \t　]*<!--\s*\/md-memo:res\s*-->[ \t　]*$/);
    const resOpenRe = rx('resOpenLine', () => /^[ \t　]*<!--\s*md-memo:res[\s>]/);
    const runRe = rx('runLine', () => /^[ \t　]*<!--\s*md-memo:run[\s>]/);
    let ls = lineStartOf(t, clampIdx(taskStart, t.length));
    let first = -1;
    let last = -1;
    let lines = 0;
    let inBlock = false;
    while (ls > 0) {
      const lineEnd = ls - 1;
      const lineStart = lineStartOf(t, lineEnd);
      let line = t.slice(lineStart, lineEnd);
      const cr = line.charCodeAt(line.length - 1) === 13;
      if (cr) line = line.slice(0, -1);
      ls = lineStart;
      if (closeRe.test(line)) { inBlock = true; continue; }
      if (inBlock) { if (resOpenRe.test(line)) inBlock = false; continue; }
      if (resOpenRe.test(line) || runRe.test(line) || lineHasTask(line, resolve)) { if (last < 0) continue; break; }
      if (!trimAll(line)) break;
      const end = cr ? lineEnd - 1 : lineEnd;
      if (last < 0) {
        last = end;
        first = Math.max(lineStart, end - maxChars);
        if (first > lineStart && isLowSurrogate(t.charCodeAt(first))) first++;
        lines = 1;
        if (first > lineStart) break;
        continue;
      }
      if (lines >= maxLines || last - lineStart > maxChars) break;
      first = lineStart;
      lines++;
    }
    if (last < 0) return null;
    return { text: t.slice(first, last).replace(/\r\n?/g, '\n'), start: first, end: last, lines };
  }

  function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
  }

  // A closed task notation anywhere on the line (used only to look through task lines, no code-fence check).
  function lineHasTask(line, resolve) {
    if (line.indexOf('[[') < 0 && line.indexOf('{{') < 0) return false;
    for (let from = 0; from < line.length;) {
      const p1 = line.indexOf('[[', from);
      const p2 = line.indexOf('{{', from);
      const p = p1 < 0 ? p2 : p2 < 0 ? p1 : Math.min(p1, p2);
      if (p < 0) return false;
      const notation = parseNotation(line, p, line.length);
      if (notation && taskFromInner(notation, resolve)) return true;
      from = p + 1;
    }
    return false;
  }

  // The text without the marker lines a run leaves (the run marker, the result opener and closer), for display: the
  // preview shows the answer, not the bookkeeping. Call it after fenced code has been set aside.
  function stripMarkers(text) {
    const s = str(text);
    if (s.indexOf('md-memo:') === -1) return s;
    return s.replace(/^[ \t]*<!-- \/?md-memo:(?:run|res)\b[^\n]*?-->[ \t]*\r?\n?/gm, '');
  }

  // 4 lowercase alphanumerics that no marker in the text uses yet (rand: optional () => [0,1) for tests).
  function newTaskId(text, rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    const s = str(text);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let len = 4; len <= 6; len++) {
      for (let attempt = 0; attempt < 40; attempt++) {
        id = '';
        for (let k = 0; k < len; k++) id += chars[Math.floor(r() * 36) % 36];
        if (s.indexOf('md-memo:run ' + id) < 0 && s.indexOf('md-memo:res ' + id) < 0) return id;
      }
    }
    return id;
  }

  // ---- classification tables -------------------------------------------------------------------------
  // Plain word lists; pass opts.rules to classify() to replace any of them (llmWords / agentWords /
  // commandSubs may be given partially). Endings are matched at the end of the line after trailing
  // punctuation is dropped; ASCII words match whole words (plural / -ed / -ing forms included).
  const RULES = Object.freeze({
    maxChars: 240,
    maxLines: 3,
    // A request phrase at the end of the line, whatever the verb ("...してください", "...お願いします").
    jaPolite: [
      'てください', 'でください', 'て下さい', 'で下さい', 'ください', '下さい', 'てくれ', 'てくれる', 'てくれない',
      'てくれますか', 'てくれませんか', 'てもらえる', 'てもらえない', 'てもらえます', 'てもらえますか', 'てもらえませんか',
      'ていただけ', 'て頂け', 'ていただきたい', 'てほしい', 'て欲しい', 'てもらいたい', 'お願いします', 'お願いいたします',
      'お願い致します', 'お願いできますか', 'お願いできる', 'お願い', 'なさい', 'せよ'
    ],
    // Casual "...して": a request only when it names something an assistant does.
    jaAiVerbs: [
      '要約して', '翻訳して', '訳して', '英訳して', '和訳して', '校正して', '添削して', '推敲して', '言い換えて', '言いかえて',
      '書き換えて', '書き直して', 'リライトして', '整形して', '整理して', 'まとめて', '箇条書きにして', '表にして', 'リストにして',
      '教えて', '説明して', '解説して', '解釈して', '提案して', '考えて', '挙げて', '並べて', '分類して', '抽出して',
      '比較して', '調べて', '調査して', '探して', '検索して', '変換して', '計算して', '見積もって', '改善して', '最適化して',
      'リファクタして', 'リファクタリングして', '実装して', 'レビューして', '紹介して', '列挙して', '指摘して', '整えて', '絞って',
      '削って', '選んで', '解消して', '解決して', '案を出して', 'アイデアを出して', '例を出して', '意見を出して', '候補を出して',
      '個出して', 'つ出して', '案出して', '件出して', '誤字脱字をチェックして', '誤字をチェックして', '誤字脱字を確認して',
      '文法をチェックして', '文法を確認して', 'スペルチェックして', '間違いをチェックして',
      '抜き出して', '短くして', '詳しくして', '簡潔にして', '分かりやすくして', 'わかりやすくして', '読みやすくして', '丁寧にして',
      '直して', '修正して', '書いて', '作って', '作成して', '生成して', '追加して', '更新して', '実行して', '試して', 'テストして',
      'ビルドして', 'デプロイして', 'コミットして', 'プッシュして', 'マージして', '解析して', '分析して', '評価して', '命名して',
      '補足して', '加筆して', '圧縮して', '構造化して', '図解して', '敬語にして', '敬語に直して'
    ],
    // "<object>を要約" without a verb ending.
    jaNouns: ['要約', '翻訳', '英訳', '和訳', '校正', '添削', '推敲', 'リライト', '言い換え', '箇条書き', '要点整理', '整形'],
    // Words that make a question mark (or a "...ですか" ending) a real question.
    questionWords: [
      '何', 'なに', 'なぜ', 'どうして', 'なんで', 'どう', 'どの', 'どれ', 'どんな', 'どういう', 'どこ', 'いつ', '誰', 'だれ', 'いくら',
      'いくつ', 'どのくらい', 'どれくらい', 'どちら', '違い', '意味', '理由', '方法', 'やり方', '仕組み', 'とは', 'って何'
    ],
    // Email closings and honorific set phrases: typed text, not a request to an assistant.
    closings: ['よろしくお願い', '宜しくお願い', 'お世話になっ', 'お疲れ様', 'ありがとうございま', 'よろしくお願'],
    enRequests: ['please', 'kindly', 'pls', 'can you', 'could you', 'would you', 'will you', 'help me', 'i need you to', 'i want you to', "i'd like you to", 'tell me', 'show me', 'give me'],
    // Verbs that are a request to an assistant on their own.
    enOpenersStrong: [
      'translate', 'summarize', 'summarise', 'proofread', 'paraphrase', 'rephrase', 'reword', 'rewrite', 'explain', 'elaborate',
      'simplify', 'shorten', 'condense', 'polish', 'brainstorm', 'refactor', 'tl;dr', 'tldr'
    ],
    // Imperative openers that are also ordinary to-do words: a request only with a cue (enCues, please,
    // a question mark, or enough LLM/agent words).
    enOpenersWeak: [
      'fix', 'write', 'list', 'find', 'run', 'create', 'make', 'add', 'remove', 'check', 'review', 'compare', 'improve', 'format', 'sort',
      'count', 'extract', 'classify', 'calculate', 'define', 'suggest', 'recommend', 'outline', 'expand', 'generate', 'draft', 'describe',
      'analyze', 'analyse', 'convert', 'implement', 'debug', 'test', 'deploy', 'commit', 'build', 'install', 'update', 'investigate',
      'research', 'turn', 'clean', 'give', 'show', 'tell', 'correct', 'open', 'merge', 'rebase', 'lint', 'search', 'push', 'pull'
    ],
    enCues: [
      'this', 'that', 'these', 'those', 'the following', 'the above', 'the below', 'the selected', 'the text', 'the note', 'the paragraph',
      'the sentence', 'the code', 'for me', 'step by step', 'in japanese', 'in english', 'into japanese', 'into english', 'to japanese',
      'to english', 'bullet', 'bullets', 'table', 'email', 'e-mail', 'message', 'reply', 'letter', 'poem', 'story', 'essay', 'summary',
      'slogan', 'tagline', 'title', 'headline', 'caption', 'template', 'example', 'ideas', 'checklist', 'joke', 'speech', 'regex',
      'sentence', 'paragraph'
    ],
    enWhWords: ['how', 'what', 'why', 'when', 'where', 'who', 'which', 'whose'],
    enAuxWords: ['is', 'are', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'have', 'has'],
    // Target words. strong counts 2, each distinct weak word 1 (at most 2). An agent needs a score of at
    // least 2 and more than the LLM score; anything else stays on the built-in LLM.
    llmWords: {
      strong: [
        '翻訳', '英訳', '和訳', '要約', '校正', '添削', '推敲', '言い換え', '言いかえ', '書き換え', '書き直', 'リライト', '箇条書き',
        '表にして', '表にまとめ', '意味', '違い', 'アイデア', 'キャッチコピー', '例文', '敬語', '丁寧語', '読みやすく', 'わかりやすく',
        '分かりやすく', '説明', '解説', 'translate', 'summarize', 'summarise', 'proofread', 'rephrase', 'paraphrase', 'reword', 'rewrite',
        'explain', 'meaning', 'difference', 'ideas', 'brainstorm', 'bullet points', 'grammar', 'tone', 'simplify', 'shorten', 'tl;dr'
      ],
      weak: ['教え', '例', '文章', '文体', '要点', 'メール', '返信', '文案', '考え', '比較', 'define', 'definition', 'compare', 'table', 'email']
    },
    agentWords: {
      strong: [
        '実装', 'リファクタ', 'ユニットテスト', 'コミット', 'プッシュ', 'プルリク', 'リポジトリ', 'デプロイ', 'ビルド', 'git', 'github',
        'ブランチ', 'マージ', 'リンター', 'lint', 'スタックトレース', 'エラーログ', '調査', 'リサーチ', 'web検索', 'ウェブ検索', 'ネット検索',
        'readme', 'package.json', 'implement', 'refactor', 'unit test', 'commit', 'push', 'pull request', 'repo', 'repository', 'deploy', 'build',
        'debug', 'stack trace', 'error log', 'codebase', 'research', 'web search', 'install', 'pr', 'merge', 'rebase', 'ci'
      ],
      weak: [
        'コード', 'バグ', 'エラー', '修正', 'ファイル', 'テスト', 'スクリプト', '依存', 'パッケージ', '関数', 'クラス', '調べ', 'code', 'bug',
        'fix', 'test', 'file', 'script', 'function', 'class', 'dependency', 'investigate', 'issue', 'branch'
      ]
    },
    agentExclusions: ['コミットメッセージ', 'commit message', 'ビルド番号'],
    // "run <the tests / a build / a package script>" is agent work even though the words alone are too common
    // for agentWords: an execution verb together with something that can be executed.
    runVerbs: ['実行', '走らせ', '回して', '起動して', 'run', 'execute'],
    runTargets: [
      'テスト', 'ビルド', 'リント', 'スクリプト', 'コンパイル', 'test', 'tests', 'build', 'lint', 'compile', 'script', 'npm', 'pnpm', 'yarn',
      'pytest', 'jest', 'vitest', 'cargo', 'make', 'gradle', 'mvn', 'go test', 'go build', 'go vet', 'docker'
    ],
    // Shell commands recognised without a leading "$ ". A bare word ("find", "go", "cat") only counts
    // when an argument follows that looks like one (flag, path, file name, URL, quoted text, subcommand).
    commandBinaries: [
      'git', 'ls', 'dir', 'cat', 'type', 'grep', 'rg', 'find', 'findstr', 'head', 'tail', 'wc', 'sort', 'uniq', 'jq', 'curl', 'npm', 'pnpm',
      'yarn', 'npx', 'go', 'cargo', 'python', 'python3', 'py', 'node', 'deno', 'bun', 'docker', 'kubectl', 'make', 'pip', 'pip3', 'pwd',
      'whoami', 'hostname', 'date', 'echo', 'tree', 'du', 'df', 'ps', 'tasklist', 'ipconfig', 'ifconfig', 'ping', 'nslookup', 'where', 'which',
      'diff', 'stat', 'file', 'ver', 'systeminfo', 'uname', 'env', 'printenv', 'less', 'more'
    ],
    // Binaries that are never an ordinary word: any argument makes the line a command.
    commandFreeArgs: ['echo', 'rg'],
    commandFilters: ['grep', 'rg', 'sort', 'uniq', 'wc', 'head', 'tail', 'jq', 'awk', 'cut', 'tr', 'xargs', 'less', 'more', 'findstr', 'select-string', 'sort-object', 'where-object', 'foreach-object', 'measure-object', 'out-string', 'format-table', 'select-object'],
    // Commands that change or destroy things are never picked up implicitly (write "$ ..." to run them).
    blockedBinaries: ['rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy', 'chmod', 'chown', 'format', 'shutdown', 'reboot', 'kill', 'killall', 'taskkill', 'dd', 'mkfs', 'sudo', 'su', 'reg', 'net', 'sc', 'mkdir', 'md', 'touch', 'ren', 'rename', 'ln', 'tee', 'sed'],
    commandSubs: {
      git: ['status', 'diff', 'log', 'show', 'branch', 'checkout', 'switch', 'add', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'stash', 'tag', 'remote', 'blame', 'reset', 'restore', 'clone', 'init', 'config', 'describe', 'shortlog', 'reflog', 'ls-files', 'rev-parse', 'grep', 'clean'],
      npm: ['install', 'i', 'run', 'test', 'start', 'build', 'ci', 'ls', 'list', 'outdated', 'audit', 'init', 'publish', 'exec', 'view', 'info', 'update'],
      go: ['build', 'test', 'run', 'mod', 'vet', 'fmt', 'get', 'install', 'list', 'version', 'env', 'generate', 'doc', 'work', 'clean'],
      cargo: ['build', 'test', 'run', 'check', 'fmt', 'clippy', 'doc', 'add', 'new', 'clean', 'tree'],
      pip: ['install', 'list', 'show', 'freeze', 'uninstall', 'download', 'check'],
      docker: ['ps', 'run', 'build', 'images', 'logs', 'exec', 'compose', 'pull', 'push', 'stop', 'start', 'rm', 'rmi', 'inspect', 'stats', 'volume', 'network'],
      kubectl: ['get', 'describe', 'logs', 'apply', 'delete', 'exec', 'config', 'top', 'rollout', 'port-forward'],
      make: ['all', 'test', 'build', 'clean', 'install', 'lint', 'fmt']
    },
    // PowerShell verbs that only read.
    cmdletVerbs: ['get', 'select', 'sort', 'measure', 'where', 'format', 'test', 'write']
  });

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function alt(list) {
    return list.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  }

  // Japanese entries match anywhere; ASCII entries match whole words (with common suffixes).
  function compileWords(list) {
    const ja = [];
    const en = [];
    (list || []).forEach((w) => (/^[\x20-\x7e]+$/.test(w) ? en : ja).push(w));
    const parts = [];
    parts.push(ja.length ? '(' + alt(ja) + ')' : '((?!))');
    if (en.length) {
      const words = en.map((w) => escapeRe(w) + (/^[A-Za-z ]*[A-Za-z]{3}$/.test(w) ? '(?:s|es|ed|d|ing)?' : ''));
      parts.push('(?:^|[^A-Za-z0-9_])(' + words.join('|') + ')(?![A-Za-z0-9_])');
    }
    return new RegExp(parts.join('|'), 'gi');
  }

  function hits(re, text) {
    const found = new Set();
    if (!re || !text) return found;
    for (const m of text.matchAll(re)) {
      const w = (m[1] || m[2] || '').toLowerCase();
      if (w) found.add(w);
    }
    return found;
  }

  function wordScore(pair, text) {
    return (hits(pair.strong, text).size ? 2 : 0) + Math.min(hits(pair.weak, text).size, 2);
  }

  function mergeRules(base, over) {
    const out = Object.assign({}, base);
    Object.keys(over || {}).forEach((k) => {
      const v = over[k];
      const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
      out[k] = isObj(v) && isObj(base[k]) ? Object.assign({}, base[k], v) : v;
    });
    return out;
  }

  function compile(R) {
    const set = (list) => new Set((list || []).map((w) => w.toLowerCase()));
    const never = /(?!)/;
    const ending = (list, head, tail) => (list && list.length ? new RegExp(head + '(?:' + alt(list) + ')' + tail + '$') : never);
    return {
      R,
      polite: ending(R.jaPolite, '', ''),
      verbs: ending(R.jaAiVerbs, '', '(?:ね|よ|ちょうだい|くれ)?'),
      nouns: ending(R.jaNouns, '(?:を|に|へ|で)', ''),
      nounSet: set(R.jaNouns),
      closings: R.closings.length ? new RegExp('(?:' + alt(R.closings) + ')') : null,
      questionWords: compileWords(R.questionWords),
      cues: compileWords(R.enCues),
      llm: { strong: compileWords(R.llmWords.strong), weak: compileWords(R.llmWords.weak) },
      agent: { strong: compileWords(R.agentWords.strong), weak: compileWords(R.agentWords.weak) },
      exclusions: R.agentExclusions.length ? new RegExp(alt(R.agentExclusions), 'gi') : null,
      runVerbs: compileWords(R.runVerbs),
      runTargets: compileWords(R.runTargets),
      enRequests: R.enRequests.map((w) => w.toLowerCase()),
      enStrong: set(R.enOpenersStrong),
      enWeak: set(R.enOpenersWeak),
      enWh: set(R.enWhWords),
      enAux: set(R.enAuxWords),
      binaries: set(R.commandBinaries),
      filters: set(R.commandFilters),
      freeArgs: set(R.commandFreeArgs),
      blocked: set(R.blockedBinaries),
      cmdletVerbs: set(R.cmdletVerbs),
      subs: Object.keys(R.commandSubs).reduce((m, k) => m.set(k, set(R.commandSubs[k])), new Map())
    };
  }

  const compiledByRules = new WeakMap();

  function compiledFor(opts) {
    const custom = opts && opts.rules && typeof opts.rules === 'object' ? opts.rules : null;
    if (!custom) return rx('compiledDefault', () => compile(RULES));
    let c = compiledByRules.get(custom);
    if (!c) {
      c = compile(mergeRules(RULES, custom));
      compiledByRules.set(custom, c);
    }
    return c;
  }

  // ---- classify ------------------------------------------------------------------------------------
  function verdict(kind, target, reason, agent) {
    const r = { kind, target, reason };
    if (agent) r.agent = agent;
    return r;
  }

  function looksLikeCode(b) {
    if (/^<\/?[A-Za-z][^>]*>/.test(b) && /<\/?[A-Za-z][^>]*>$/.test(b)) return true;
    if (/^[{[]/.test(b) && /[}\]]$/.test(b) && /["':]/.test(b)) return true;
    if (/^(?:\/\/|\/\*|\*\/|#!|#include|#define|#pragma)/.test(b)) return true;
    if (/^(?:const|let|var)\s+[\w$]+\s*[=:]/.test(b)) return true;
    if (/^(?:function|def|func|fn)\s+[\w$]+\s*\(/.test(b)) return true;
    if (/^(?:class|interface|struct|enum|namespace|package)\s+[\w.$]+\s*(?:\{|:|\(|;|$)/.test(b)) return true;
    if (/^(?:import|from)\s+[\w.*{}, ]+\s+(?:from|import|as)\s/.test(b) || /^import\s+[\w.]+\s*;?$/.test(b)) return true;
    if (/^export\s+(?:default|const|function|class)\b/.test(b)) return true;
    if (/^(?:public|private|protected|static)\s+\w/.test(b)) return true;
    if (/^(?:if|for|while|elif|else|try|except|with)\b.*:$/.test(b)) return true;
    if (/^(?:select\s.+\sfrom\s|insert\s+into\s|update\s+\w+\s+set\s|delete\s+from\s|create\s+table\s|drop\s+table\s|alter\s+table\s)/i.test(b)) return true;
    if (/[;{}]\s*$/.test(b) && /[=(]/.test(b)) return true;
    if (b.indexOf('=>') >= 0) return true;
    if (/^[\w$.]+\([^()]*\)\s*;?$/.test(b)) return true;
    if (/^[A-Za-z_$][\w$.]*\s*[-+*/]?=\s*[^=\s]/.test(b)) return true;
    return false;
  }

  function normBinary(tok) {
    return str(tok).toLowerCase().replace(/^\.[\\/]/, '').replace(/\.exe$/, '');
  }

  function argLike(arg, bin, C) {
    if (!arg) return false;
    if (/^-{1,2}[A-Za-z0-9?]/.test(arg) || /^\/[A-Za-z?](?::|$)/.test(arg) || /^\+[\w%]/.test(arg)) return true;
    if (/^(?:\.{1,2}[\\/]?$|\.{1,2}[\\/]|~[\\/]?|[\\/]|[A-Za-z]:[\\/])/.test(arg) || arg === '.' || arg === '..') return true;
    if (/^[\w.-]*[\\/][\w.\\/-]*$/.test(arg) && arg.length > 1) return true;
    if (/^[A-Za-z_.][\w-]*\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(arg)) return true;
    if (/^["'*]/.test(arg) || /^https?:\/\//i.test(arg) || /^(?:\$\w|%\w+%)/.test(arg)) return true;
    const subs = C.subs.get(bin === 'pnpm' || bin === 'yarn' || bin === 'npx' ? 'npm' : bin === 'pip3' ? 'pip' : bin);
    return !!(subs && subs.has(arg.toLowerCase()));
  }

  // 'command' | 'risky' (looks like one, but writes or destroys) | 'lone' (a bare command word) | null
  function detectCommand(b, C) {
    const bare = b.replace(/"[^"]*"|'[^']*'/g, '""');
    if (/[぀-ゟ　。、]/.test(bare)) return null;
    const tokens = b.split(/\s+/);
    const first = normBinary(tokens[0]);
    const risky = () => /[<>]/.test(bare) || /\s-(?:delete|exec|ok)\b/.test(bare) || /\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|cmd)\b/i.test(bare);

    const segs = b.split(/\s\|\s/).map(trimAll);
    if (segs.length > 1 && segs.every(Boolean)) {
      const head = normBinary(segs[0].split(/\s+/)[0]);
      const tail = normBinary(segs[segs.length - 1].split(/\s+/)[0]);
      if (C.binaries.has(head) || C.filters.has(tail)) return risky() ? 'risky' : 'command';
      return null;
    }
    if (C.blocked.has(first)) return tokens.length > 1 && argLike(tokens[1], first, C) ? 'risky' : null;

    const cmdlet = /^([A-Z][a-z]+)-[A-Z][A-Za-z]+$/.exec(tokens[0]);
    if (cmdlet) return C.cmdletVerbs.has(cmdlet[1].toLowerCase()) ? (risky() ? 'risky' : 'command') : /^(?:Set|Remove|New|Start|Stop|Invoke|Copy|Move|Rename|Clear|Restart|Add|Install|Uninstall)$/.test(cmdlet[1]) ? 'risky' : null;

    if (!C.binaries.has(first)) return null;
    if (tokens.length === 1) return 'lone';
    if (C.freeArgs.has(first) || argLike(tokens[1], first, C)) return risky() ? 'risky' : 'command';
    return null;
  }

  function targetFor(b, C) {
    const clean = C.exclusions ? b.replace(C.exclusions, ' ') : b;
    if (hits(C.runVerbs, clean).size && hits(C.runTargets, clean).size) return 'agent';
    const a = wordScore(C.agent, clean);
    const l = wordScore(C.llm, b);
    return a >= 2 && a > l ? 'agent' : 'llm';
  }

  // { level: 'strong' | 'weak' | 'content', reason } for text that is not an explicit form or a command.
  function detectSignal(b, C) {
    const hasQ = rx('endsQ', () => /[?？][\s　」』)）"']*$/).test(b);
    const core = b.replace(rx('trailPunct', () => /[\s　。．.!！?？~〜…、,，」』)）"'’]+$/), '');
    if (!core) return { level: 'content', reason: 'no-request-signal' };
    const strong = (reason) => ({ level: 'strong', reason });
    const weak = (reason) => ({ level: 'weak', reason });

    if (C.closings && C.closings.test(core)) return { level: 'content', reason: 'closing-phrase' };
    if (rx('honorific', () => /ご(?:覧|確認|連絡|検討|対応|協力|返信|回答|査収|了承|理解|注意|留意|承知|参加|参照|利用|安心|遠慮|自由|相談|報告)を?(?:ください|下さい|お願い.*)?$/).test(core)) {
      return { level: 'content', reason: 'email-phrase' };
    }

    let best = null;
    const pm = C.polite.exec(core);
    if (pm) {
      const stem = core.length - pm[0].length;
      best = stem >= 2 ? strong('ja-request') : weak('ja-request-bare');
    }
    if (!best || best.level !== 'strong') {
      const vm = C.verbs.exec(core);
      if (vm) best = strong('ja-request-verb');
    }
    if (!best || best.level !== 'strong') {
      const nm = C.nouns.exec(core);
      if (nm && core.length > nm[0].length) best = strong('ja-verb-noun');
      else if (!best && C.nounSet.has(core.toLowerCase())) best = weak('lone-verb-noun');
    }
    if (!best && /[぀-ヿ一-鿿]/.test(core)) {
      const qw = hits(C.questionWords, core).size > 0;
      const politeQ = /(?:ですか|ますか|でしょうか)$/.test(core);
      const softQ = /(?:かな|だろうか|かしら)$/.test(core);
      if (qw && (hasQ || politeQ) && core.length >= 5) best = strong('question');
      else if (hasQ || politeQ || softQ) best = weak('question-unclear');
      else if (/とは$/.test(core)) best = weak('definition-topic');
    }
    if (!best) {
      const em = /^([A-Za-z][A-Za-z';]*)/.exec(core);
      if (em) {
        const w = em[1].toLowerCase();
        const lower = core.toLowerCase();
        const words = core.split(/\s+/).length;
        const phrase = C.enRequests.find((p) => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ','));
        if (phrase) best = words > phrase.split(' ').length ? strong('en-request') : weak('en-request-bare');
        else if (/(?:^|[\s,])(?:please|pls)$/i.test(core)) best = strong('en-please');
        else if (C.enStrong.has(w)) best = words > 1 ? strong('en-imperative') : weak('en-imperative-bare');
        else if (C.enWeak.has(w)) {
          const status = /^\S+\s+\d/.test(core);
          const cue = hits(C.cues, core).size > 0 || hasQ || (!status && (wordScore(C.agent, core) >= 2 || wordScore(C.llm, core) >= 2));
          best = cue ? strong('en-imperative-cue') : weak('en-imperative');
        } else if (C.enWh.has(w)) {
          if (hasQ) best = strong('en-question');
          else if (words >= 3) best = weak('en-question-no-mark');
        } else if (C.enAux.has(w) && hasQ) best = weak('en-yes-no-question');
      }
    }
    if (!best && hasQ) best = weak('question-mark');
    if (!best && /(?:て|んで|いで)$/.test(core)) best = weak('ja-casual-request');
    return best || { level: 'content', reason: 'no-request-signal' };
  }

  // classify(text, opts) -> { kind: 'instruction' | 'content' | 'unknown', target: 'llm' | 'agent' | 'command', agent?, reason }
  //   opts.agents  agent list for "@name" (see makeResolver; default: the built-in agents)
  //   opts.rules   replaces entries of RULES
  // text is one line or a selection. Explicit forms win ("@llm ...", "@<agent|alias> ...", "$ ...").
  // Otherwise only a clear request is an instruction; imperative-looking or question-looking text with
  // no clear cue is unknown, and ordinary prose, notes, URLs, code, headings and long or multi-line
  // text are content. Both content and unknown mean "do not guess: open the ask bar". target is the
  // engine the request belongs to (the built-in LLM unless the words or the form say otherwise).
  function classify(text, opts) {
    const C = compiledFor(opts);
    const R = C.R;
    const body = trimAll(str(text).replace(/\r\n?/g, '\n'));
    if (!body) return verdict('content', 'llm', 'empty');
    if (/^(?:```|~~~)/.test(body)) return verdict('content', 'llm', 'code-fence');
    const lines = body.split('\n');
    if (lines.length > R.maxLines) return verdict('content', 'llm', 'too-many-lines');
    if (body.length > R.maxChars) return verdict('content', 'llm', 'too-long');
    if (lines.length > 1) return verdict('unknown', 'llm', 'multi-line');

    // "- [x] ... // approve": the line a recipe waits on. Ctrl+Enter resumes it (the old path), whatever the words say.
    if (rx('approvalGate', () => /^[ \t　]*-[ \t　]*\[[ xX]\][ \t　]*.*?[ \t　]*\/\/[ \t　]*approve[ \t　]*$/).test(body)) {
      return verdict('content', 'llm', 'existing-notation');
    }
    const b = trimAll(splitLinePrefix(body).body);
    if (!b) return verdict('content', 'llm', 'empty');
    if (b.startsWith('>>')) return verdict('content', 'llm', 'reserved-chain-prefix');
    if (rx('slotNotation', () => /\{\{[^\n]*?\}\}|\[\?[^\n]*?\]|【\?[^\n]*?】|\[![^\n]*?!\]|\[>>[^\n]*?\]|\[\[[ \t　]*(?:@llm|\$)(?=[ \t　\]]|$)[^\n]*?\]\]/i).test(b)) {
      return verdict('content', 'llm', 'existing-notation');
    }

    const at = rx('atMention', () => /^@([^\s:]+)[ \t　]*:?[ \t　]*([\s\S]*)$/).exec(b);
    if (at) {
      const rest = trimAll(at[2]);
      if (at[1].toLowerCase() === 'llm') return rest ? verdict('instruction', 'llm', 'explicit-llm') : verdict('unknown', 'llm', 'empty-instruction');
      const agent = resolverFor(opts)(at[1]);
      if (agent) return rest ? verdict('instruction', 'agent', 'explicit-agent', agent) : verdict('unknown', 'agent', 'empty-instruction', agent);
      return verdict('content', 'llm', 'mention-not-agent');
    }
    if (b === '$') return verdict('unknown', 'command', 'empty-command');
    const dollar = rx('dollarCmd', () => /^\$[ \t　]+([\s\S]*)$/).exec(b);
    if (dollar) {
      const rest = trimAll(dollar[1]);
      if (!rest) return verdict('unknown', 'command', 'empty-command');
      if (/^\d/.test(rest)) return verdict('content', 'llm', 'currency');
      return verdict('instruction', 'command', 'explicit-command');
    }

    if (/^#{1,6}(?:[ \t　]|$)/.test(b)) return verdict('content', 'llm', 'heading');
    if (/^\|.*\|$/.test(b)) return verdict('content', 'llm', 'table-row');
    if (/^(?:-{3,}|\*{3,}|_{3,}|={3,})$/.test(b)) return verdict('content', 'llm', 'rule');
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(b) || /^<https?:[^>]+>$/i.test(b)) return verdict('content', 'llm', 'url');
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(b)) return verdict('content', 'llm', 'email-address');
    if (/^`[^`]*`$/.test(b)) return verdict('content', 'llm', 'inline-code');

    const cmd = detectCommand(b, C);
    if (cmd === 'command') return verdict('instruction', 'command', 'command-like');
    if (cmd === 'risky') return verdict('unknown', 'command', 'risky-command');
    if (cmd === 'lone') return verdict('unknown', 'llm', 'lone-command-word');
    if (looksLikeCode(b)) return verdict('content', 'llm', 'code');

    const sig = detectSignal(b, C);
    if (sig.level === 'strong') return verdict('instruction', targetFor(b, C), sig.reason);
    if (sig.level === 'weak') return verdict('unknown', 'llm', sig.reason);
    return verdict('content', 'llm', sig.reason);
  }

  const api = {
    RULES,
    classify,
    findTaskAt,
    decorate,
    splitLinePrefix,
    makeRunMarker,
    makeResultBlock,
    findResultAfter,
    findContextAbove,
    stripMarkers,
    newTaskId,
    inCodeFence
  };

  global.AutoSelector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
