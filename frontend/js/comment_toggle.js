// MD-Memo: Ctrl+/ (Cmd+/ on macOS) turns the lines of the selection into HTML comments, or back.
//
//   toggleComment(text, selStart, selEnd, style)
//     -> { start, end, replacement, selStart, selEnd, status, skipped, reason }
//
// The lines are every line the selection touches (a selection that ends at the start of a line leaves that line
// out); with no selection, the caret's line. Replacing [start, end) of the text with `replacement` is the whole edit
// (one undo step), and selStart / selEnd is the selection after it. status is 'commented', 'uncommented', 'nothing'
// or 'refused' (then `reason` says why and the replacement is the text as it was).
//
// style 'line' (the default): one comment per line, "  <!-- - item -->" (the indentation stays outside). When every
// line that can be toggled is already a one-line comment, they are all uncommented; otherwise every line that is not
// commented yet is commented. Empty lines and md-memo marker lines are never touched. A line that contains "-->" (the
// comment would end there) or that is part of a comment spanning several lines stays as it is and is listed in
// `skipped` (1-based line numbers).
//
// style 'block': one comment around the lines, "<!-- " before the first line's text and " -->" after the last's; when
// the lines already are exactly one comment it is taken off. Refused when the lines contain "-->" ('terminator') or an
// md-memo marker ('marker'), or touch a comment that goes on outside them ('overlap').
//
// Either style checks its result with html_comments.js: every comment it writes must come out as exactly that comment,
// and every other comment of the note must stay as it was. Otherwise nothing changes: 'unclosed' when a "<!--" that
// never closes comes before the lines (the new "-->" would close it and hide everything in between), else 'unsafe'
// (the lines are inside code, where "<!--" is plain text, or the edit would change other lines). Line breaks (LF or
// CRLF) stay as they are. Pure: no DOM, nothing runs until the key is pressed.
(function (global) {
  'use strict';

  const MARKER = /<!--\s*\/?md-memo:/;
  const ONE_LINE = /^(\s*)<!--(\s?)([\s\S]*?)\s?-->(\s*)$/;
  const OPEN = '<!-- ';
  const CLOSE = ' -->';

  function str(v) {
    return v == null ? '' : String(v);
  }

  function api() {
    if (global.HtmlComments) return global.HtmlComments;
    if (typeof require === 'function') return require('./html_comments.js');
    return null;
  }

  function clamp(v, n) {
    const x = typeof v === 'number' && isFinite(v) ? Math.floor(v) : 0;
    return x < 0 ? 0 : x > n ? n : x;
  }

  function lineStartOf(t, i) {
    return i <= 0 ? 0 : t.lastIndexOf('\n', i - 1) + 1;
  }

  function lineNumberAt(t, i) {
    let n = 1;
    for (let p = t.indexOf('\n'); p !== -1 && p < i; p = t.indexOf('\n', p + 1)) n++;
    return n;
  }

  // Where position p of the old text is after the edits (sorted, not overlapping; { pos, del, ins, kind }). At an
  // insertion point, `after(edit)` says whether p goes behind the inserted text; inside deleted text p lands where
  // the deletion was.
  function mapPos(p, edits, after) {
    let delta = 0;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (e.del === 0) {
        if (p > e.pos || (p === e.pos && after(e))) delta += e.ins.length;
        else if (p < e.pos) break;
      } else if (p >= e.pos + e.del) {
        delta += e.ins.length - e.del;
      } else if (p > e.pos) {
        return e.pos + delta;
      } else {
        break;
      }
    }
    return p + delta;
  }

  function applyEdits(t, start, end, edits) {
    let out = '';
    let pos = start;
    for (let i = 0; i < edits.length; i++) {
      out += t.slice(pos, edits[i].pos) + edits[i].ins;
      pos = edits[i].pos + edits[i].del;
    }
    return out + t.slice(pos, end);
  }

  // The selection after the edits: a caret moves with the text (behind an opening "<!-- ", before a closing " -->");
  // a selection grows to hold what was inserted at its edges.
  function mapSelection(a, b, edits) {
    if (a === b) {
      const c = mapPos(a, edits, (e) => e.kind === 'open');
      return [c, c];
    }
    return [mapPos(a, edits, () => false), mapPos(b, edits, () => true)];
  }

  function result(range, t, a, b, status, extra) {
    return Object.assign({
      start: range.start,
      end: range.end,
      replacement: t.slice(range.start, range.end),
      selStart: a,
      selEnd: b,
      status,
      skipped: []
    }, extra || {});
  }

  // Checks the edited text: the comments that were not touched are still there (moved by the edit), the ones that
  // were taken off are gone, and each new one is exactly a comment. Returns true when so.
  function sameStructure(HC, t, oldRanges, removed, added, range, replacement, edits) {
    const next = t.slice(0, range.start) + replacement + t.slice(range.end);
    const expected = [];
    for (let i = 0; i < oldRanges.length; i++) {
      const r = oldRanges[i];
      if (removed.some((x) => x[0] === r[0] && x[1] === r[1])) continue;
      expected.push([mapPos(r[0], edits, () => false), mapPos(r[1], edits, () => true)]);
    }
    for (let i = 0; i < added.length; i++) expected.push(added[i]);
    expected.sort((x, y) => x[0] - y[0]);
    const got = HC.htmlCommentRanges(next);
    if (got.length !== expected.length) return false;
    for (let i = 0; i < got.length; i++) {
      if (got[i][0] !== expected[i][0] || got[i][1] !== expected[i][1]) return false;
    }
    return true;
  }

  function refuseUnsafe(HC, t, range, a, b) {
    const u = HC.unclosedCommentAt(t);
    return result(range, t, a, b, 'refused', { reason: u !== -1 && u < range.end ? 'unclosed' : 'unsafe' });
  }

  // ---- one comment per line ------------------------------------------------------------------------------------
  function toggleLines(HC, t, range, a, b) {
    const ranges = HC.htmlCommentRanges(t);
    const multi = ranges.filter((r) => t.slice(r[0], r[1]).indexOf('\n') !== -1);
    const lines = [];
    let pos = range.start;
    const raws = t.slice(range.start, range.end).split('\n');
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i];
      const body = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
      const ls = pos;
      const le = pos + body.length;
      pos += raw.length + 1;
      const line = { ls, le, body, kind: 'plain', m: null };
      if (/^\s*$/.test(body)) line.kind = 'empty';
      else if (MARKER.test(body)) line.kind = 'marker';
      else if (multi.some((r) => r[0] < le && r[1] > ls)) line.kind = 'blocked';
      else {
        const m = ONE_LINE.exec(body);
        if (m && m[3].indexOf('-->') === -1) {
          line.kind = 'commented';
          line.m = m;
        } else if (body.indexOf('-->') !== -1) line.kind = 'blocked';
      }
      lines.push(line);
    }

    const plain = lines.filter((l) => l.kind === 'plain');
    const commented = lines.filter((l) => l.kind === 'commented');
    const blocked = lines.filter((l) => l.kind === 'blocked');
    const skipped = [];
    if (blocked.length) {
      const first = lineNumberAt(t, range.start);
      lines.forEach((l, i) => { if (l.kind === 'blocked') skipped.push(first + i); });
    }
    if (!plain.length && !commented.length) return result(range, t, a, b, 'nothing', { skipped });

    const edits = [];
    const removed = [];
    const added = [];
    if (plain.length) {
      for (let i = 0; i < plain.length; i++) {
        const l = plain[i];
        const indent = /^[ \t]*/.exec(l.body)[0].length;
        edits.push({ pos: l.ls + indent, del: 0, ins: OPEN, kind: 'open' });
        edits.push({ pos: l.le, del: 0, ins: CLOSE, kind: 'close' });
      }
    } else {
      for (let i = 0; i < commented.length; i++) {
        const l = commented[i];
        const m = l.m;
        const indent = m[1].length;
        const innerStart = indent + 4 + m[2].length;
        const innerEnd = innerStart + m[3].length;
        const closeEnd = l.body.length - m[4].length;
        edits.push({ pos: l.ls + indent, del: innerStart - indent, ins: '', kind: 'open' });
        edits.push({ pos: l.ls + innerEnd, del: closeEnd - innerEnd, ins: '', kind: 'close' });
        removed.push([l.ls + indent, l.ls + closeEnd]);
      }
    }
    const replacement = applyEdits(t, range.start, range.end, edits);
    if (plain.length) {
      for (let i = 0; i < plain.length; i++) {
        const l = plain[i];
        const indent = /^[ \t]*/.exec(l.body)[0].length;
        const s = mapPos(l.ls + indent, edits, () => false);
        added.push([s, s + OPEN.length + (l.body.length - indent) + CLOSE.length]);
      }
    }
    if (!sameStructure(HC, t, ranges, removed, added, range, replacement, edits)) return refuseUnsafe(HC, t, range, a, b);
    const sel = mapSelection(a, b, edits);
    return {
      start: range.start,
      end: range.end,
      replacement,
      selStart: sel[0],
      selEnd: sel[1],
      status: plain.length ? 'commented' : 'uncommented',
      skipped
    };
  }

  // ---- one comment around the lines ----------------------------------------------------------------------------
  function toggleBlock(HC, t, range, a, b) {
    const region = t.slice(range.start, range.end);
    const first = region.search(/\S/);
    if (first === -1) return result(range, t, a, b, 'nothing');
    let last = region.length;
    while (last > first && /\s/.test(region[last - 1])) last--;
    const inner = region.slice(first, last);
    const s = range.start + first;
    const e = range.start + last;
    const ranges = HC.htmlCommentRanges(t);
    let edits;
    let removed = [];
    let added = [];
    let status;

    if (inner.length >= 7 && inner.startsWith('<!--') && inner.endsWith('-->') && !MARKER.test(inner) &&
        inner.indexOf('-->', 2) === inner.length - 3) {
      // Exactly one comment: take "<!--" and "-->" off. A "<!--" or "-->" alone on its line goes with that line.
      let from = 4;
      const nl = inner.indexOf('\n', from);
      if (nl !== -1 && /^[ \t\r]*$/.test(inner.slice(from, nl))) from = nl + 1;
      else if (inner[from] === ' ' || inner[from] === '\t') from++;
      let to = inner.length - 3;
      const pnl = inner.lastIndexOf('\n', to - 1);
      if (pnl !== -1 && pnl + 1 >= from && /^[ \t]*$/.test(inner.slice(pnl + 1, to))) {
        to = pnl > 0 && inner[pnl - 1] === '\r' ? pnl - 1 : pnl;
      } else if (inner[to - 1] === ' ' || inner[to - 1] === '\t') {
        to--;
      }
      if (to < from) to = from;
      edits = [
        { pos: s, del: from, ins: '', kind: 'open' },
        { pos: s + to, del: inner.length - to, ins: '', kind: 'close' }
      ];
      if (edits[1].pos < edits[0].pos + edits[0].del) {
        edits = [{ pos: s, del: inner.length, ins: '', kind: 'open' }];
      }
      removed = ranges.filter((r) => r[0] === s && r[1] === e);
      status = 'uncommented';
    } else {
      if (MARKER.test(inner)) return result(range, t, a, b, 'refused', { reason: 'marker' });
      if (inner.indexOf('-->') !== -1) return result(range, t, a, b, 'refused', { reason: 'terminator' });
      if (ranges.some((r) => r[0] < e && r[1] > s)) return result(range, t, a, b, 'refused', { reason: 'overlap' });
      edits = [
        { pos: s, del: 0, ins: OPEN, kind: 'open' },
        { pos: e, del: 0, ins: CLOSE, kind: 'close' }
      ];
      added = [[s, s + OPEN.length + inner.length + CLOSE.length]];
      status = 'commented';
    }
    const replacement = applyEdits(t, range.start, range.end, edits);
    if (!sameStructure(HC, t, ranges, removed, added, range, replacement, edits)) return refuseUnsafe(HC, t, range, a, b);
    const sel = mapSelection(a, b, edits);
    return { start: range.start, end: range.end, replacement, selStart: sel[0], selEnd: sel[1], status, skipped: [] };
  }

  function toggleComment(text, selStart, selEnd, style) {
    const t = str(text);
    const n = t.length;
    let a = clamp(selStart, n);
    let b = selEnd === undefined || selEnd === null ? a : clamp(selEnd, n);
    if (b < a) { const x = a; a = b; b = x; }
    const start = lineStartOf(t, a);
    const lastPos = b > a && b === lineStartOf(t, b) ? b - 1 : b;
    let end = t.indexOf('\n', Math.max(lastPos, start));
    if (end === -1) end = n;
    const range = { start, end };
    const HC = api();
    if (!HC) return result(range, t, a, b, 'refused', { reason: 'unsafe' });
    return style === 'block' ? toggleBlock(HC, t, range, a, b) : toggleLines(HC, t, range, a, b);
  }

  const exported = { toggleComment };
  global.CommentToggle = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window !== 'undefined' ? window : globalThis);
