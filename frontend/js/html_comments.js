// MD-Memo: where the HTML comments (<!-- ... -->) of a note are. Text inside a comment is hidden: a task or slot
// in it never runs, and the preview does not show it. pkg/slotagent/comments.go answers the same question for the
// Go slot parser with the same rules, and tests/fixtures/html_comment_vectors.json is run by both test suites, so
// the frontend and the backend never disagree about what is commented out.
//
// What counts as a comment:
//   - "<!--" up to the first "-->" after it: comments do not nest. "<!-->" and "<!--->" are complete, empty
//     comments, as in HTML. A "<!--" with no "-->" anywhere after it is not a comment (and nothing after it is).
//   - The "<!--" must not be inside a fenced code block (the fence rules of auto_selector.js: at most 3 spaces,
//     3 or more backticks or tildes, closed by a line of the same character at least as long with nothing else
//     on it; an unclosed fence runs to the end) and not inside inline code. Inline code is read as CommonMark
//     reads it, on one line: a run of n backticks opens a code span when a later run of exactly n backticks on
//     the same line closes it, otherwise it is plain text ("it`s" is not code, ``a`b`` is one span). The runs are
//     read from the line start, or from the end of the last comment on that line. Once a comment has started,
//     fences and backticks inside it mean nothing.
//   - md-memo's own markers ("<!-- md-memo:run id -->", "<!-- md-memo:res id -->", "<!-- /md-memo:res -->") are
//     the note's structure (result blocks), not hidden text: they are not reported.
// Every index is a UTF-16 index (what a textarea reports); the Go side uses byte offsets of the same text. Every
// character the rules look at is ASCII, so both describe the same spans.
//
// Cost: nothing runs unless the text contains "<!--"; then one pass over the text.
(function (global) {
  'use strict';

  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const MARKER = /<!--\s*\/?md-memo:/y;
  const BLANK = /^\s*$/;

  function str(v) {
    return v == null ? '' : String(v);
  }

  // Same as fenceLine in auto_selector.js (line: one line without its line break).
  function fenceLine(line) {
    const m = FENCE.exec(line);
    if (!m) return null;
    if (m[1][0] === '`' && m[2].indexOf('`') >= 0) return null;
    return { ch: m[1][0], len: m[1].length, rest: m[2] };
  }

  // The fence on the line [ls, le), or null. The cheap first-character test keeps the regexp off ordinary lines.
  function fenceAt(t, ls, le) {
    let i = ls;
    while (i < le && i - ls < 3 && t.charCodeAt(i) === 32) i++;
    const c = i < le ? t.charCodeAt(i) : 0;
    if (c !== 96 && c !== 126) return null;
    let line = t.slice(ls, le);
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    return fenceLine(line);
  }

  function isMarkerAt(t, p) {
    MARKER.lastIndex = p;
    return MARKER.test(t);
  }

  // The end of the backtick run that starts at q (le: end of the line).
  function runEnd(t, q, le) {
    let k = q;
    while (k < le && t.charCodeAt(k) === 96) k++;
    return k;
  }

  // Inline code before p on its line: walks the backtick runs from `from` up to p. Returns the end of the code span
  // that holds p, or -1 when p is not in one; in both cases state.from is where the next walk starts.
  function codeSpanEnd(t, state, p, le) {
    let i = state.from;
    while (i < p) {
      const q = t.indexOf('`', i);
      if (q === -1 || q >= p) break;
      const k = runEnd(t, q, le);
      let close = -1;
      for (let j = k; j < le;) {
        const r = t.indexOf('`', j);
        if (r === -1 || r >= le) break;
        const s = runEnd(t, r, le);
        if (s - r === k - q) {
          close = s;
          break;
        }
        j = s;
      }
      if (close === -1) {
        i = k;
        continue;
      }
      if (close > p) {
        state.from = close;
        return close;
      }
      i = close;
    }
    state.from = i;
    return -1;
  }

  // One pass: { ranges: [[start, end), ...] in order, unclosed: index of a "<!--" (outside code) that no "-->"
  // follows, or -1 }. With stopAt, only the comments that start before stopAt are looked for.
  function scan(text, stopAt) {
    const t = str(text);
    const ranges = [];
    let next = t.indexOf('<!--');
    if (next === -1) return { ranges, unclosed: -1 };
    const limited = typeof stopAt === 'number';
    const n = t.length;
    const fences = t.indexOf('```') !== -1 || t.indexOf('~~~') !== -1;
    let open = null;
    let ls = 0;
    while (ls < n) {
      if (limited && ls >= stopAt) break;
      if (next !== -1 && next < ls) next = t.indexOf('<!--', ls);
      if (next === -1) break;
      let le = t.indexOf('\n', ls);
      if (le === -1) le = n;
      if (fences) {
        const f = fenceAt(t, ls, le);
        if (open) {
          if (f && f.ch === open.ch && f.len >= open.len && BLANK.test(f.rest)) open = null;
          ls = le + 1;
          continue;
        }
        if (f) {
          open = f;
          ls = le + 1;
          continue;
        }
      }
      // The comments that start on this line. Inline code is read from the line start, then from the end of each
      // comment (backticks inside a comment are not code).
      const state = { from: ls };
      while (next !== -1 && next < le) {
        const p = next;
        if (limited && p >= stopAt) return { ranges, unclosed: -1 };
        const code = codeSpanEnd(t, state, p, le);
        if (code !== -1) {
          next = t.indexOf('<!--', code);
          continue;
        }
        const close = t.indexOf('-->', p + 2);
        if (close === -1) return { ranges, unclosed: p };
        const end = close + 3;
        if (!isMarkerAt(t, p)) ranges.push([p, end]);
        next = t.indexOf('<!--', end);
        if (end > le) {
          // The comment went on past this line: carry on after it, on the line where it ends.
          le = t.indexOf('\n', end);
          if (le === -1) le = n;
        }
        state.from = end;
      }
      ls = le + 1;
    }
    return { ranges, unclosed: -1 };
  }

  // [[start, end), ...]: the comments of the text, in order (see the rules at the top).
  function htmlCommentRanges(text) {
    return scan(text).ranges;
  }

  // Where a "<!--" that never closes starts (outside code), or -1. Adding a "-->" after it would turn everything in
  // between into a comment.
  function unclosedCommentAt(text) {
    return scan(text).unclosed;
  }

  // True when pos lies strictly inside a comment: between its "<" and its last ">". A caret right before "<!--"
  // or right after "-->" is outside. Only the text before pos is read.
  function isInsideComment(text, pos) {
    if (typeof pos !== 'number' || !(pos > 0)) return false;
    const rs = scan(text, pos).ranges;
    const last = rs.length ? rs[rs.length - 1] : null;
    return !!last && last[0] < pos && pos < last[1];
  }

  // True when a span [start, end) is cut off by a comment: it starts inside one, ends inside one, or lies inside one.
  // The same test as isOffsetExcluded in pkg/slotagent/parser.go, so a task the frontend runs is a slot the Go
  // parser accepts (a span that holds a whole comment is not excluded by it).
  function isRangeExcluded(ranges, start, end) {
    const rs = ranges || [];
    for (let i = 0; i < rs.length; i++) {
      const s = rs[i][0];
      const e = rs[i][1];
      if ((start >= s && start < e) || (end > s && end <= e) || (s <= start && end <= e)) return true;
    }
    return false;
  }

  // The text with every comment character replaced by a space; line breaks (CR and LF) and the length stay, so every
  // index still points at the same place. For code that scans with regular expressions. ranges: optional, from
  // htmlCommentRanges(text).
  function maskComments(text, ranges) {
    const t = str(text);
    const rs = ranges || htmlCommentRanges(t);
    if (!rs.length) return t;
    let out = '';
    let pos = 0;
    for (let i = 0; i < rs.length; i++) {
      out += t.slice(pos, rs[i][0]) + t.slice(rs[i][0], rs[i][1]).replace(/[^\r\n]/g, ' ');
      pos = rs[i][1];
    }
    return out + t.slice(pos);
  }

  // The text the preview renders: every comment taken out. A line that is left with nothing but spaces (or
  // blockquote marks) goes away with its line break, so the paragraph around a comment line is not split in two;
  // a comment inside a line is cut out in place. Code, markers and an unclosed "<!--" stay as they are.
  function removeComments(text) {
    const t = str(text);
    const rs = htmlCommentRanges(t);
    if (!rs.length) return t;
    const lines = [];
    let cur = { text: '', touched: false };
    const append = (s) => {
      const parts = s.split('\n');
      cur.text += parts[0];
      for (let i = 1; i < parts.length; i++) {
        lines.push(cur);
        cur = { text: parts[i], touched: false };
      }
    };
    let pos = 0;
    for (let i = 0; i < rs.length; i++) {
      append(t.slice(pos, rs[i][0]));
      cur.touched = true;
      pos = rs[i][1];
    }
    append(t.slice(pos));
    lines.push(cur);
    let out = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const last = i === lines.length - 1;
      if (line.touched && /^[\s>]*$/.test(line.text)) continue;
      out += last ? line.text : line.text + '\n';
    }
    return out;
  }

  const api = {
    htmlCommentRanges,
    unclosedCommentAt,
    isInsideComment,
    isRangeExcluded,
    maskComments,
    removeComments
  };

  global.HtmlComments = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
