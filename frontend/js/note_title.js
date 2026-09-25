// MD-Memo: the automatic title of an untitled note (the tab label) and the file name that Save As offers.
//
// What is used as the title, in this order:
//  1. the first ATX heading ("# ...") that is not just a date;
//  2. otherwise the first line that says something;
//  3. otherwise the date heading the app inserts into a new note ("# 2026-09-25 07:51"), as "2026-09-25 07-51".
// Left out on the way: blank lines, front matter, fenced code, HTML comments (the md-memo markers too), table rows,
// horizontal rules, and lines that are only slot / task notation ({{ }}, [[ ]], [? ], [! !], [>> ], 【? 】).
// The text is cleaned of Markdown (quotes, bullets, task boxes, emphasis, code ticks, links, images, HTML tags), made safe as a
// file name (illegal characters become spaces, Windows reserved names get a "_" in front) and cut to about 40 code points:
// never inside a surrogate pair, at a word or closing-bracket boundary, and never with a bracket left open.
//
// The Save As default is "YYYY-MM-DD_<summary>.md": the date of the note's own date heading, else today.
//
// It runs while the user types (for an untitled tab), so only the first 200 lines are looked at, a line is never cleaned beyond
// 1000 characters, and only the one line that becomes the title is cleaned. Pure functions: no DOM, nothing runs until called.
(function (global) {
  'use strict';

  const MAX_LINES = 200; // physical lines examined (blank and skipped ones count)
  const MAX_CHARS = 40; // code points kept from the summary
  const MAX_BODY = 1000; // UTF-16 units of one line that are cleaned; the rest cannot reach a 40-code-point title

  // Brackets, ASCII and full-width, with the closer that belongs to each opener.
  const PAIRS = new Map([
    ['(', ')'], ['[', ']'], ['{', '}'],
    ['（', '）'], // （ ）
    ['「', '」'], // 「 」
    ['『', '』'], // 『 』
    ['【', '】'], // 【 】
    ['［', '］'], // ［ ］
    ['〈', '〉'], // 〈 〉
    ['《', '》'] // 《 》
  ]);
  const CLOSERS = new Set(PAIRS.values());

  const ILLEGAL = /[\\/:*?"<>|\u0000-\u001F\u007F]/g;
  const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\s*(?:\..*)?$/i;
  const SPACE = /\s/;
  // What may not end a cut summary: whitespace and the connectors that would dangle ("Foo, bar," -> "Foo, bar").
  const CUT_TAIL = /[\s,;\u3001\uFF0C\uFF1B\-\u2013\u2014]+$/;

  // A line that carries only a date: "# 2026-09-25 07:51", "2026/09/11 18:28:30", "2026-09-11".
  const DATE_ONLY = /^(?:#+[ \t\u3000]*)?(\d{4})[-/](\d{2})[-/](\d{2})(?:[ \t\u3000]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
  const HEADING_MARK = /^#{1,6}(?:[ \t\u3000]+|$)/;
  // One leading container marker: blockquote, bullet (incl. the Japanese ones), number, task box.
  const CONTAINER = /^(?:>|[-*+][ \t\u3000]+|[・•●○◦][ \t\u3000]*|\d{1,3}[.)．）][ \t\u3000]+|[０-９]{1,3}[.)．）][ \t\u3000]+|\[[ xX]\](?:[ \t\u3000]+|$))/;
  const FENCE = /^(`{3,}|~{3,})(.*)$/;
  // Rules and separators: "---", "***", "___", "====", "|---|:--:|", "+---+", box-drawing lines.
  const SEPARATOR = /^[-=*_~+:|\s\u2013\u2014\u2015\u2500-\u257F\uFF0D\uFF1D]+$/;
  // A line that is nothing but slot / task notation (see auto_selector.js and slot_agent.js for the syntax).
  const SLOT_ONLY = [
    /^\{\{.*\}\}$/,
    /^\[\?.*\]$/,
    /^【\?.*】$/,
    /^\[!.*!\]$/,
    /^\[>>.*\]$/,
    /^\[\[[ \t\u3000].*\]\]$/,
    /^\[\[(?:@llm|\$).*\]\]$/
  ];
  // Front matter lines look like YAML: "key: value", "- item", an indented continuation, a comment or a blank.
  const YAML_LINE = /^(?:[ \t]|#|-(?:[ \t]|$)|[^\s:][^:]*:(?:[ \t]|$))/;

  let graphemeSegmenter = null;

  function isSlotOnly(s) {
    const c = s.charCodeAt(0);
    if (c !== 0x7B && c !== 0x5B && c !== 0x3010) return false; // { [ 【
    for (let i = 0; i < SLOT_ONLY.length; i++) {
      if (SLOT_ONLY[i].test(s)) return true;
    }
    return false;
  }

  // Removes leading blockquote / bullet / number / task-box markers ("> - [x] text" -> "text").
  function stripContainers(s) {
    for (let i = 0; i < 8; i++) {
      const m = CONTAINER.exec(s);
      if (!m) break;
      s = s.slice(m[0].length).replace(/^[ \t\u3000]+/, '');
    }
    return s;
  }

  // HTML comments of one line, in a single linear pass: [the text that is left, whether a comment is still open at the end].
  function removeComments(s) {
    let out = '';
    let from = 0;
    for (;;) {
      const o = s.indexOf('<!--', from);
      if (o === -1) return [out + s.slice(from), false];
      const c = s.indexOf('-->', o + 4);
      if (c === -1) return [out + s.slice(from, o), true];
      out += s.slice(from, o) + ' ';
      from = c + 3;
    }
  }

  // The inline Markdown of one line: images and links keep their text, emphasis, code ticks, HTML tags and comments go.
  function stripInline(s) {
    s = s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    if (s.indexOf('<!--') !== -1) s = removeComments(s)[0];
    s = s.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
    s = s.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
    s = s.replace(/<((?:https?|ftp|mailto):[^>\s]*)>/gi, '$1');
    s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[A-Za-z][^<>]*>/g, '');
    s = s.replace(/\b(?:https?|ftp):\/\//gi, '');
    s = s.replace(/`+/g, '');
    s = s.replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2');
    s = s.replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1');
    s = s.replace(/(^|[^A-Za-z0-9_])_([^_\s](?:[^_]*[^_\s])?)_(?![A-Za-z0-9_])/g, '$1$2');
    s = s.replace(/~~(\S(?:.*?\S)?)~~/g, '$1');
    s = s.replace(/[ \t\u3000]+#+[ \t\u3000]*$/, '');
    return s.replace(/\s+/g, ' ').trim();
  }

  // Plain text of one Markdown line: quote / bullet / task box / heading marks, emphasis, ticks, links, images, HTML, trailing "#".
  function stripMarkdown(line) {
    let s = String(line == null ? '' : line).trim();
    s = stripContainers(s).replace(HEADING_MARK, '');
    return stripInline(fitBody(s));
  }

  // Illegal file-name characters and control characters become spaces (not deletions: "a|b" must not become "ab").
  function sanitizeCore(s) {
    return s.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  }

  function guardReserved(s) {
    return RESERVED.test(s) ? '_' + s : s;
  }

  // Safe as a file name on Windows, macOS and Linux: illegal characters -> space, spaces collapsed, no trailing dots or
  // spaces, a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9; with or without an extension) gets "_" in front.
  function sanitizeFileName(name) {
    const s = sanitizeCore(String(name == null ? '' : name)).replace(/[. ]+$/, '');
    return guardReserved(s);
  }

  // The part of a line that gets cleaned: at most MAX_BODY units, never ending in half a surrogate pair, and a link or image
  // whose address runs past the cut keeps its text ("[title](https://...very long" -> "title").
  function fitBody(s) {
    if (s.length <= MAX_BODY) return s;
    const last = s.charCodeAt(MAX_BODY - 1);
    return s.slice(0, last >= 0xD800 && last <= 0xDBFF ? MAX_BODY - 1 : MAX_BODY).replace(/!?\[([^\]]*)\]\([^)]*$/, '$1');
  }

  // The number of code points (<= cut) that end on a grapheme-cluster boundary, so an emoji sequence or a base letter
  // with its combining mark is not split. Intl.Segmenter is used only when it exists, and only for the one final candidate.
  function graphemeSafeCut(chars, cut) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return cut;
    try {
      if (!graphemeSegmenter) graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const sample = chars.slice(0, Math.min(chars.length, cut + 16)).join('');
      let n = 0;
      for (const part of graphemeSegmenter.segment(sample)) {
        const len = Array.from(part.segment).length;
        if (n + len > cut) break;
        n += len;
      }
      return n > 0 ? n : cut;
    } catch (e) {
      return cut;
    }
  }

  // Cuts `text` (already one clean line) to about `max` code points. Never inside a surrogate pair; backs up to a whitespace or
  // closing-bracket boundary (but keeps at least half of `max`: a short word in front of a long unbroken run, typically
  // CJK text, does not become the whole title); a bracket still open at the cut is removed with what follows its opener.
  // No ellipsis. Returns '' when nothing is left.
  function truncateTitle(text, max) {
    const limit = max > 0 ? Math.floor(max) : MAX_CHARS;
    const s = String(text == null ? '' : text);
    if (s.length <= limit) return s; // UTF-16 units are an upper bound of code points
    const chars = Array.from(s);
    if (chars.length <= limit) return s;

    let cut = limit;
    let hard = false;
    if (!(SPACE.test(chars[cut]) || SPACE.test(chars[cut - 1]) || CLOSERS.has(chars[cut - 1]))) {
      const floor = Math.ceil(limit / 2);
      let p = -1;
      for (let i = cut - 1; i >= floor; i--) {
        if (SPACE.test(chars[i])) { p = i; break; }
        if (CLOSERS.has(chars[i])) { p = i + 1; break; }
      }
      if (p >= 0) cut = p; else hard = true;
    }

    // Is a bracket still open at the cut? Then the summary ends before its (outermost) opener.
    const open = [];
    for (let i = 0; i < cut; i++) {
      const c = chars[i];
      const closer = PAIRS.get(c);
      if (closer) {
        open.push([closer, i]);
      } else if (CLOSERS.has(c)) {
        for (let j = open.length - 1; j >= 0; j--) {
          if (open[j][0] === c) { open.length = j; break; }
        }
      }
    }
    if (open.length > 0) {
      cut = open[0][1];
    } else if (hard) {
      cut = graphemeSafeCut(chars, cut);
    }
    return chars.slice(0, cut).join('').replace(CUT_TAIL, '');
  }

  // One line body (containers and heading mark already removed) -> the finished summary, or '' when nothing usable is left.
  function summarize(body, maxChars) {
    const s = sanitizeCore(stripInline(fitBody(body)));
    if (!s) return '';
    return truncateTitle(s, maxChars).replace(/[. ]+$/, '');
  }

  function nextLineEnd(text, from) {
    const i = text.indexOf('\n', from);
    return i === -1 ? text.length : i;
  }

  // Front matter at the very top: "---", YAML-looking lines, then "---" (or "..."). Returns { pos, lines } after the closing
  // line, or null when the note does not start with a real front-matter block (a lone "---" is just a rule).
  function skipFrontMatter(text, pos, maxLines) {
    const len = text.length;
    const firstEnd = nextLineEnd(text, pos);
    if (text.substring(pos, firstEnd).trim() !== '---') return null;
    let p = firstEnd + 1;
    let n = 1;
    while (p <= len && n < maxLines) {
      const e = nextLineEnd(text, p);
      const line = text.substring(p, e).trim();
      n++;
      if (line === '---' || line === '...') return { pos: e + 1, lines: n };
      if (line !== '' && !YAML_LINE.test(line)) return null;
      p = e + 1;
    }
    return null;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // The result of reading a note: { title, dateTitle, date }
  //   title      the summary ('' when the note has nothing to say)
  //   dateTitle  "YYYY-MM-DD HH-mm" of the first date-only line, the last-resort title ('' when there is none)
  //   date       "YYYY-MM-DD" of that line when it is a real calendar-looking date, else ''
  // opts: { maxLines, maxChars, scanAll } (scanAll keeps reading after the title is known, to find the date line)
  function analyze(content, opts) {
    const res = { title: '', dateTitle: '', date: '' };
    const text = content == null ? '' : String(content);
    if (!text) return res;
    const maxLines = opts && opts.maxLines > 0 ? opts.maxLines : MAX_LINES;
    const maxChars = opts && opts.maxChars > 0 ? opts.maxChars : MAX_CHARS;
    const scanAll = !!(opts && opts.scanAll);
    const len = text.length;

    let pos = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
    let lineNo = 0;
    const fm = skipFrontMatter(text, pos, maxLines);
    if (fm) { pos = fm.pos; lineNo = fm.lines; }

    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let inComment = false;
    let headingTitle = '';
    let lineTitle = '';

    while (pos <= len && lineNo < maxLines) {
      const e = nextLineEnd(text, pos);
      let s = text.substring(pos, e);
      pos = e + 1;
      lineNo++;

      if (inFence) {
        const m = FENCE.exec(stripContainers(s.trim()));
        if (m && m[1].charAt(0) === fenceChar && m[1].length >= fenceLen && m[2].trim() === '') inFence = false;
        continue;
      }
      if (inComment) {
        const c = s.indexOf('-->');
        if (c === -1) continue;
        s = s.slice(c + 3);
        inComment = false;
      }
      if (s.indexOf('<!--') !== -1) {
        const r = removeComments(s);
        s = r[0];
        inComment = r[1];
      }
      s = s.trim();
      if (!s) continue;

      let b = stripContainers(s);
      if (!b) continue;

      const fenceMatch = FENCE.exec(b);
      if (fenceMatch && (fenceMatch[1].charAt(0) === '~' || fenceMatch[2].indexOf('`') === -1)) {
        inFence = true;
        fenceChar = fenceMatch[1].charAt(0);
        fenceLen = fenceMatch[1].length;
        continue;
      }
      if (b.charCodeAt(0) === 0x7C) continue; // a table row
      if (SEPARATOR.test(b)) continue; // a rule, a table separator

      const dm = DATE_ONLY.exec(b);
      if (dm) {
        if (!res.dateTitle) {
          res.dateTitle = dm[1] + '-' + dm[2] + '-' + dm[3] + (dm[4] ? ' ' + dm[4] + '-' + dm[5] + (dm[6] ? '-' + dm[6] : '') : '');
          const mo = +dm[2];
          const da = +dm[3];
          if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) res.date = dm[1] + '-' + dm[2] + '-' + dm[3];
        }
        continue;
      }

      let isHeading = false;
      if (b.charCodeAt(0) === 0x23) { // #
        const hm = HEADING_MARK.exec(b);
        if (hm) { isHeading = true; b = b.slice(hm[0].length); }
      }
      if (isSlotOnly(b)) continue;
      if (headingTitle || (lineTitle && !isHeading)) continue; // a line that cannot change the result

      const t = summarize(b, maxChars);
      if (!t) continue;
      if (isHeading) {
        headingTitle = t;
        if (!scanAll) break;
      } else {
        lineTitle = t;
      }
    }

    res.title = headingTitle || lineTitle;
    return res;
  }

  // The tab label for an untitled note (no ".md"). '' when the note has neither a summary nor a date heading.
  function deriveTitle(content, opts) {
    const a = analyze(content, opts);
    return a.title ? guardReserved(a.title) : a.dateTitle;
  }

  function todayString(today) {
    if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}/.test(today)) return today.slice(0, 10);
    const d = today && typeof today.getFullYear === 'function' && !isNaN(today.getTime()) ? today : new Date();
    return String(d.getFullYear()).padStart(4, '0') + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // The file name Save As offers for an untitled note: "YYYY-MM-DD_<summary>.md", the date being the note's own date
  // heading if it has one, else `today` (a Date or "YYYY-MM-DD"; default: now). A note with only a date heading is
  // named after it ("2026-09-25 07-51.md"); '' when the note has nothing to name it after.
  function defaultSaveName(content, today) {
    const a = analyze(content, { scanAll: true });
    if (a.title) return (a.date || todayString(today)) + '_' + a.title + '.md';
    if (a.dateTitle) return a.dateTitle + '.md';
    return '';
  }

  global.NoteTitle = {
    MAX_LINES: MAX_LINES,
    MAX_CHARS: MAX_CHARS,
    deriveTitle: deriveTitle,
    defaultSaveName: defaultSaveName,
    analyze: analyze,
    stripMarkdown: stripMarkdown,
    sanitizeFileName: sanitizeFileName,
    truncateTitle: truncateTitle
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.NoteTitle;
  }
})(typeof window !== 'undefined' ? window : globalThis);
