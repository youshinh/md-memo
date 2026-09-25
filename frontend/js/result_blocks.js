// MD-Memo result blocks: find them in a note, and work out what to do with one.
//
// A run of the Auto selector (an AI answer, a command's output, an agent's reply) is written into the note
// between two comment lines:
//
//     <!-- md-memo:res a1b2 -->
//     the result
//     <!-- /md-memo:res -->
//
// This module only reads text and returns numbers or strings. It has no DOM and nothing runs until the
// app calls it, and the common case (a note with no such marker) costs one indexOf.
//
// Rules, kept in step with auto_selector.js (findResultAfter) and pkg/slotagent/parser.go:
//  - The opener and the closer are whole lines (indent allowed) shaped like the two lines above.
//  - Once an opener has been seen, the FIRST closer line after it ends the block. Another opener (or a
//    "md-memo:run" marker) before any closer means the run never finished (a crash): the earlier block is
//    "unclosed" and only its opener line is known.
//  - A marker inside a fenced code block (``` or ~~~) is only text, not a block. The body of a block is
//    opaque: a fence that starts inside it neither hides its closer nor leaks out of the block.
//  - Lines end with "\n" or "\r\n"; the editor's value always uses "\n", a tab's saved content may not.
//
// All offsets are UTF-16 indexes into the text; lines are 0-based.
(function (global) {
  'use strict';

  // The blank set in the three lines below is space, tab and the ideographic space (U+3000), which a Japanese IME
  // types as an indent.
  const OPEN_LINE = /^[ \t　]*<!--\s*md-memo:res(?:\s+([^\s>]+)(?:\s+[^\s>]+)*)?\s*-->[ \t　]*$/;
  const CLOSE_LINE = /^[ \t　]*<!--\s*\/md-memo:res\s*-->[ \t　]*$/;
  const RUN_LINE = /^[ \t　]*<!--\s*md-memo:run[\s>]/;

  // ---- fenced code -----------------------------------------------------------------------------------

  // Follows the fenced code blocks of `text` from the top: advance(to) reads every fence line that starts before
  // `to`, skip(to) jumps over text that is not to be read, inFence() says whether the point reached is inside a
  // fence. Only the lines that begin with three or more backticks or tildes are ever looked at (found with
  // indexOf), so a note with no fence at all costs two searches.
  function makeFenceScanner(text) {
    let a = text.indexOf('```');
    let b = text.indexOf('~~~');
    let cursor = 0; // every line that starts before this offset has been read (or skipped)
    let ch = ''; // the character of the fence that is open, '' when none
    let len = 0; // and the length of its opening run

    function refresh() {
      if (a !== -1 && a < cursor) a = text.indexOf('```', cursor);
      if (b !== -1 && b < cursor) b = text.indexOf('~~~', cursor);
    }

    function advance(to) {
      for (;;) {
        const p = a === -1 ? b : (b === -1 ? a : (a < b ? a : b));
        if (p === -1 || p >= to) break;
        const ls = p === 0 ? 0 : text.lastIndexOf('\n', p - 1) + 1;
        let le = text.indexOf('\n', p);
        if (le === -1) le = text.length;
        cursor = le + 1;
        if (onlyIndent(text, ls, p)) {
          const c = text.charAt(p);
          let q = p;
          while (text.charAt(q) === c) q++;
          const run = q - p;
          let restEnd = le;
          if (restEnd > q && text.charCodeAt(restEnd - 1) === 13) restEnd--;
          const rest = text.slice(q, restEnd);
          if (ch === '') {
            // An opening fence; a backtick fence cannot have a backtick in its info string.
            if (c !== '`' || rest.indexOf('`') === -1) { ch = c; len = run; }
          } else if (c === ch && run >= len && /^[ \t]*$/.test(rest)) {
            ch = '';
            len = 0;
          }
        }
        refresh();
      }
      if (cursor < to) cursor = to;
    }

    function skip(to) {
      if (to > cursor) cursor = to;
      refresh();
    }

    return { advance: advance, skip: skip, inFence: function () { return ch !== ''; } };
  }

  function onlyIndent(text, from, to) {
    for (let i = from; i < to; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  }

  // ---- finding the blocks ------------------------------------------------------------------------------

  // Every result block of `text`, in order:
  //   { id, closed, openLine, closeLine, openStart, openEnd, bodyStart, bodyEnd, closeStart, closeEnd }
  // openStart..openEnd is the opener line without its line break (its indent is inside); closeStart..closeEnd the
  // closer line likewise; bodyStart..bodyEnd what lies between the two marker lines, without the line break next
  // to each marker (an empty range when there is no body line, or only an empty one: compare closeLine with
  // openLine + 1 to tell them apart). An unclosed block has closeLine, bodyStart, bodyEnd and every close*
  // offset set to -1. Returns [] at once for a text that has no "md-memo:res" in it.
  function findResultBlocks(text) {
    if (typeof text !== 'string' || text.indexOf('md-memo:res') === -1) return [];
    const blocks = [];
    const fence = makeFenceScanner(text);

    // Line numbers are counted forward between the lines that matter; the lines asked for only ever increase.
    let lnPos = 0;
    let lnNo = 0;
    function lineOf(pos) {
      for (let i = text.indexOf('\n', lnPos); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) lnNo++;
      lnPos = pos;
      return lnNo;
    }

    let cur = null; // the opener seen and not closed yet: { id, line, start, end, le }
    function finishUnclosed() {
      blocks.push({
        id: cur.id, closed: false,
        openLine: cur.line, closeLine: -1,
        openStart: cur.start, openEnd: cur.end,
        bodyStart: -1, bodyEnd: -1, closeStart: -1, closeEnd: -1
      });
      cur = null;
    }

    let p = text.indexOf('md-memo:');
    while (p !== -1) {
      const ls = p === 0 ? 0 : text.lastIndexOf('\n', p - 1) + 1;
      let le = text.indexOf('\n', p);
      if (le === -1) le = text.length;
      let end = le;
      if (end > ls && text.charCodeAt(end - 1) === 13) end--;
      const line = text.slice(ls, end);

      if (cur) {
        if (CLOSE_LINE.test(line)) {
          const closeLine = lineOf(ls);
          const noBody = closeLine === cur.line + 1;
          let bodyEnd = ls - 1;
          if (bodyEnd > cur.le + 1 && text.charCodeAt(bodyEnd - 1) === 13) bodyEnd--;
          blocks.push({
            id: cur.id, closed: true,
            openLine: cur.line, closeLine: closeLine,
            openStart: cur.start, openEnd: cur.end,
            bodyStart: noBody ? ls : cur.le + 1, bodyEnd: noBody ? ls : bodyEnd,
            closeStart: ls, closeEnd: end
          });
          cur = null;
          fence.skip(le + 1); // what lay between the markers is not read for fences
        } else if (OPEN_LINE.test(line) || RUN_LINE.test(line)) {
          finishUnclosed(); // the run that wrote it never finished; this line is looked at again below
        }
      }
      if (!cur) {
        const m = OPEN_LINE.exec(line);
        if (m) {
          fence.advance(ls);
          if (!fence.inFence()) cur = { id: m[1] || '', line: lineOf(ls), start: ls, end: end, le: le };
        }
      }
      p = text.indexOf('md-memo:', le + 1);
    }
    if (cur) finishUnclosed();
    return blocks;
  }

  // ---- asking about the blocks -----------------------------------------------------------------------------

  // The block that holds the caret at `pos`: the marker lines and the body count, the line break after the
  // closer does not. For an unclosed block only its opener line counts (nothing is known about the rest).
  function blockAt(text, pos) {
    const blocks = findResultBlocks(text);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (pos >= b.openStart && pos <= (b.closed ? b.closeEnd : b.openEnd)) return b;
    }
    return null;
  }

  // The block to go to from the caret at `pos`, out of an array findResultBlocks returned: dir 1 = the first one
  // whose opener starts after pos, else the first one of the note; any other dir = the last one whose opener
  // starts before pos, else the last one of the note. null when there are no blocks.
  function pickBlock(blocks, pos, dir) {
    const n = blocks ? blocks.length : 0;
    if (n === 0) return null;
    if (dir >= 0) {
      for (let i = 0; i < n; i++) if (blocks[i].openStart > pos) return blocks[i];
      return blocks[0];
    }
    for (let i = n - 1; i >= 0; i--) if (blocks[i].openStart < pos) return blocks[i];
    return blocks[n - 1];
  }

  // Next (dir 1) or previous (dir -1) block by where its opener is, wrapping around the ends of the note.
  function nextBlock(text, pos, dir) {
    return pickBlock(findResultBlocks(text), pos, dir);
  }

  // The result text between the two marker lines, as it is written (no marker, and not the line break next to each).
  // '' for a block with no body and for an unclosed one.
  function bodyText(text, block) {
    if (!block || !block.closed || block.bodyEnd < block.bodyStart) return '';
    return text.slice(block.bodyStart, block.bodyEnd);
  }

  function breakAfter(text, pos) {
    const c = text.charCodeAt(pos);
    if (c === 10) return 1;
    return c === 13 && text.charCodeAt(pos + 1) === 10 ? 2 : 0;
  }

  function breakBefore(text, pos) {
    if (pos < 1 || text.charCodeAt(pos - 1) !== 10) return 0;
    return pos > 1 && text.charCodeAt(pos - 2) === 13 ? 2 : 1;
  }

  // What to cut to remove the whole block: { start, end } from the start of the opener line through the closer
  // line and its line break, so no empty line is left where it stood. When the closer is the last line of the
  // text the line break before the opener goes instead. null for an unclosed block (its extent is not known).
  function deleteRange(text, block) {
    if (!block || !block.closed) return null;
    const after = breakAfter(text, block.closeEnd);
    if (after > 0) return { start: block.openStart, end: block.closeEnd + after };
    return { start: block.openStart - breakBefore(text, block.openStart), end: block.closeEnd };
  }

  // Replacing the block by its own lines, so the two marker lines are gone and the body stays in the note:
  // { start, end, replacement } (replace text.slice(start, end) with replacement). The range is deleteRange's, and
  // the body comes back followed by the line break the closer had. A block with no body line is just removed; a
  // block whose closer is the last line of the text keeps the line break before the opener. null for an unclosed
  // block.
  function confirmEdit(text, block) {
    if (!block || !block.closed) return null;
    const hasBodyLines = block.closeLine - block.openLine > 1;
    const after = breakAfter(text, block.closeEnd);
    if (after > 0) {
      return {
        start: block.openStart,
        end: block.closeEnd + after,
        replacement: hasBodyLines ? bodyText(text, block) + text.slice(block.closeEnd, block.closeEnd + after) : ''
      };
    }
    if (!hasBodyLines) {
      const d = deleteRange(text, block);
      return { start: d.start, end: d.end, replacement: '' };
    }
    return { start: block.openStart, end: block.closeEnd, replacement: bodyText(text, block) };
  }

  // ---- the gutter bars ----------------------------------------------------------------------------------------

  // Bars to draw beside the line numbers, top to bottom: { kind: 'open' | 'body' | 'close', top, height } in pixels,
  // measured from the top of the first line. The opener line is 'open', the lines of the result together are one
  // 'body' bar, the closer line is 'close'; an unclosed block has only its 'open' bar. `rows` (Uint32Array or
  // Array, one entry per logical line) is how many screen rows each line takes when some lines wrap (see
  // line_gutter.js), or null when every line is one row. At most maxBlocks blocks are drawn (2000 by default).
  function accentBars(blocks, rows, lineHeight, maxBlocks) {
    const bars = [];
    if (!blocks || blocks.length === 0 || !(lineHeight > 0)) return bars;
    const limit = maxBlocks > 0 ? maxBlocks : 2000;

    // Screen rows above a line. The lines asked for only ever increase, so one pass over rows is enough.
    let curLine = 0;
    let curRow = 0;
    function rowsOf(line) {
      const r = rows ? (rows[line] | 0) : 1;
      return r > 0 ? r : 1;
    }
    function rowStart(line) {
      if (!rows) return line;
      if (line < curLine) { curLine = 0; curRow = 0; }
      while (curLine < line) { curRow += rowsOf(curLine); curLine++; }
      return curRow;
    }
    function px(n) {
      return Math.round(n * 100) / 100;
    }
    function bar(kind, fromLine, toLine) { // the lines fromLine .. toLine - 1
      const top = rowStart(fromLine);
      const rowsHigh = toLine - fromLine === 1 ? rowsOf(fromLine) : rowStart(toLine) - top;
      bars.push({ kind: kind, top: px(top * lineHeight), height: px(rowsHigh * lineHeight) });
    }

    const n = blocks.length < limit ? blocks.length : limit;
    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      bar('open', b.openLine, b.openLine + 1);
      if (!b.closed) continue;
      if (b.closeLine > b.openLine + 1) bar('body', b.openLine + 1, b.closeLine);
      bar('close', b.closeLine, b.closeLine + 1);
    }
    return bars;
  }

  const api = {
    findResultBlocks: findResultBlocks,
    blockAt: blockAt,
    pickBlock: pickBlock,
    nextBlock: nextBlock,
    bodyText: bodyText,
    deleteRange: deleteRange,
    confirmEdit: confirmEdit,
    accentBars: accentBars
  };
  global.ResultBlocks = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
