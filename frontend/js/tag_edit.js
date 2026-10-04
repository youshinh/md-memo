// MD-Memo: add and remove the tags of a note (palette: "Add a tag to this entry", "Add a tag to the whole note", "Remove a tag").
// docs/design/tag-filter-2026-10.md section 10.
//
//  - The rules of where a tag goes (which lines are the entry, what the whole note is, what is already there, a front matter) live in ONE
//    place, the backend (search.EditTags, reached by window.backend.tagEdit). This file never works them out: it asks, with the note's
//    text, the kind of change, the line of the caret and the tags, and gets back a patch: "replace the lines [start_line, end_line) of the
//    text by new_lines". Everything here is the page's side of that: the request, putting the patch into the editor's text and moving the
//    caret with it, the list of tags to pick from, the typed text read as tags, and the sentence for the status line.
//  - Pure functions first (no DOM, nothing runs at load); the picker panel, which needs the DOM, is built only when a command is used
//    (openPicker), over the hidden markup of index.html. The file itself is loaded on the first command.
//  - The list of tags offered to add: the tags of the folder (window.backend.scrapFilterOptions, read once when the panel opens, the most
//    used first), then the tags the note has that the folder does not; a tag that is already on in the range is not offered. What the
//    person typed is the first row ("New tag: x") unless it is a tag that is there anyway. Several tags can be typed at once.
//  - A tag under a heading applies to every smaller heading below it (section 11): the "show" answer has the path from the entry up to its
//    root, and the picker lets the person say where the tag goes: the entry (the default), or one of the headings above it (a row of
//    choices, only when there is more than one; Ctrl+Up / Ctrl+Down walk it). The tags that are on already are worked out again from the path
//    when the place changes; the backend is asked once. A word selected in the note is the first thing in the box (selectedTag).
(function (global) {
  'use strict';

  const MAX_TAGS = 8;       // at a time (search.MaxFilterTags)
  const MAX_TAG_CHARS = 64; // one tag, in characters (search.maxTagRunes)
  const MAX_ROWS = 8;       // rows of the list shown

  // ---- reading the typed text as tags (search.ParseTagList / NormalizeTag) --------------------------------------

  // Full-width ASCII (code points 0xFF01 to 0xFF5E) made half-width, the white space (the ideographic space too: trim knows it) and the
  // leading "#" taken off, lower case: the form tags are kept and compared in.
  function normalizeTag(s) {
    let t = '';
    String(s == null ? '' : s).split('').forEach(function (ch) {
      const c = ch.charCodeAt(0);
      t += c >= 0xFF01 && c <= 0xFF5E ? String.fromCharCode(c - 0xFEE0) : ch;
    });
    return t.trim().replace(/^#+/, '').trim().toLowerCase();
  }

  const SEPARATORS = /[\s,;、，；]+/; // white space (the ideographic space too), "," ";" and their Japanese forms
  const ENDS_WITH_SEPARATOR = /[\s,;、，；]$/;

  function charCount(s) {
    return Array.from(s).length;
  }

  // The text as { tags, tooMany, tooLong, bad }: normalized, without duplicates, in the order written. A ninth tag, one of more than 64
  // characters and one that holds a comment delimiter ("<!--" or "-->", which would end the line's comment) are not taken and say so (the
  // backend refuses a request that has any of them; a quiet drop would add less than was typed).
  function splitTags(input) {
    const tags = [];
    let tooMany = false;
    let tooLong = false;
    let bad = false;
    String(input == null ? '' : input).split(SEPARATORS).forEach(function (piece) {
      const tag = normalizeTag(piece);
      if (!tag) return;
      if (charCount(tag) > MAX_TAG_CHARS) { tooLong = true; return; }
      if (tag.indexOf('-->') >= 0 || tag.indexOf('<!--') >= 0) { bad = true; return; }
      if (tags.indexOf(tag) >= 0) return;
      if (tags.length >= MAX_TAGS) { tooMany = true; return; }
      tags.push(tag);
    });
    return { tags: tags, tooMany: tooMany, tooLong: tooLong, bad: bad };
  }

  // The sentence for what is wrong with the typed text (problem: "tooMany" | "tooLong" | "bad"), in the language of t.
  function problemText(t, problem) {
    if (problem === 'tooMany') return t('tagEditTooMany', { n: MAX_TAGS });
    if (problem === 'tooLong') return t('tagEditTooLong', { n: MAX_TAG_CHARS });
    return t('tagEditBadChars');
  }

  // ---- the request ----------------------------------------------------------------------------------------------

  // 1-based line number of a character offset.
  function lineOfOffset(text, offset) {
    const t = String(text == null ? '' : text);
    const end = Math.max(0, Math.min(t.length, Math.floor(Number(offset)) || 0));
    let line = 1;
    for (let i = t.indexOf('\n'); i !== -1 && i < end; i = t.indexOf('\n', i + 1)) line++;
    return line;
  }

  // The line an entry is decided from: the caret's, or the first line of the selection. A caret on the empty line after the last line break
  // is not a line of the file (the search does not count it, and the backend would place it on the last line anyway), so it counts as the
  // last line: the number the panel shows is then the line it really works on.
  function lineOfSelection(text, selStart, selEnd) {
    const t = String(text == null ? '' : text);
    const a = Math.min(Number(selStart) || 0, Number(selEnd) || 0);
    let line = lineOfOffset(t, a);
    if (t.length > 0 && t.charCodeAt(t.length - 1) === 10) {
      const last = lineOfOffset(t, t.length) - 1;
      if (line > last) line = last;
    }
    return Math.max(1, line);
  }

  // The first and last line a selection covers, { first, last }, or null for no selection (a caret). The first line is the one the entry is
  // decided from (lineOfSelection); a selection that ends right after a line break stops at the line before it.
  function selectionLines(text, selStart, selEnd) {
    const t = String(text == null ? '' : text);
    const a = Math.min(Number(selStart) || 0, Number(selEnd) || 0);
    const b = Math.max(Number(selStart) || 0, Number(selEnd) || 0);
    if (!(b > a)) return null;
    const first = lineOfSelection(t, a, b);
    const end = t.charCodeAt(Math.min(b, t.length) - 1) === 10 ? Math.min(b, t.length) - 1 : b;
    const lines = Math.max(1, lineTable(t).count);
    return { first: first, last: Math.max(first, Math.min(lineOfOffset(t, end), lines)) };
  }

  // ---- a selected word as the first tag (section 11.7) ----------------------------------------------------------

  const MAX_SELECTED_CHARS = 200;
  // What is taken off the ends of a selected word: brackets, quotes and the marks of a sentence. A "#" goes from the front only (and any
  // number of them), and a "#" or "+" at the end stays (c#, c++).
  const WORD_ENDS = '「」『』()（）[]［］<>＜＞"\'、。，．,.;:；：!?！？';

  // The word a selection is, as the first thing in the box: '' when the selection is not one tag. A candidate is a selection inside one line
  // (no line break), of 200 characters at most, that is one tag after the white space, the leading "#"s and the brackets, quotes and marks
  // of a sentence at its two ends are taken off (the same rules as typed text: splitTags finds one tag of 64 characters at most, no
  // "<!--" or "-->"). Two words, or an empty remainder, give ''. The offsets may come in either order.
  function selectedTag(text, selStart, selEnd) {
    const t = String(text == null ? '' : text);
    const a = Math.min(Number(selStart) || 0, Number(selEnd) || 0);
    const b = Math.max(Number(selStart) || 0, Number(selEnd) || 0);
    if (!(b > a) || b - a > MAX_SELECTED_CHARS * 2) return ''; // (a code point is two units at most: a longer run is too long whatever it holds)
    let s = t.slice(Math.max(0, a), Math.min(t.length, b));
    if (charCount(s) > MAX_SELECTED_CHARS || /[\r\n]/.test(s)) return '';
    const isEnd = function (ch) { return WORD_ENDS.indexOf(ch) >= 0; };
    for (let again = true; again;) {
      again = false;
      const before = s;
      s = s.trim();
      while (s.length > 0 && (s[0] === '#' || isEnd(s[0]))) s = s.slice(1);
      while (s.length > 0 && isEnd(s[s.length - 1])) s = s.slice(0, -1);
      if (s !== before) again = true;
    }
    if (!s) return '';
    const r = splitTags(s);
    return r.tags.length === 1 && !r.tooMany && !r.tooLong && !r.bad ? s : '';
  }

  // What window.backend.tagEdit is given. op "add" | "remove" | "show"; scope "note" | "entry" (an entry needs its line).
  function request(text, op, scope, line, tags) {
    const req = { text: String(text == null ? '' : text), op: op, scope: scope === 'entry' ? 'entry' : 'note', tags: Array.isArray(tags) ? tags.slice() : [] };
    if (req.scope === 'entry') req.line = Math.max(1, Math.floor(Number(line)) || 1);
    return req;
  }

  // ---- the patch ------------------------------------------------------------------------------------------------

  // Offsets of the starts of the lines, and how many lines the text has: the way the search counts, so a last line break does not start
  // another line ("a\nb\n" has two).
  function lineTable(text) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    const count = text === '' ? 0 : text.charCodeAt(text.length - 1) === 10 ? starts.length - 1 : starts.length;
    return { starts: starts, count: count };
  }

  function offsetOfLine(table, text, line) {
    return line - 1 < table.starts.length ? table.starts[line - 1] : text.length;
  }

  function isHighSurrogate(code) { return code >= 0xD800 && code <= 0xDBFF; }
  function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

  // The patch (a TagEdit that changed something) as a change of the text:
  //   { start, end, rep, text, kind, stickLeft }  text.slice(start, end) is replaced by rep; `text` is the new whole text.
  // The lines [start_line, end_line) are replaced by new_lines, each ending with the file's own line break (eol). A line that is changed
  // keeps whatever is the same at its two ends, so only the tags part is written: the caret in the comment line stays where it is, and
  // the undo step is as small as it can be. A run of lines put in or taken out is written whole.
  function changeOf(text, edit) {
    const t = String(text == null ? '' : text);
    const e = edit || {};
    const eol = e.eol === '\r\n' ? '\r\n' : '\n';
    const lines = Array.isArray(e.new_lines) ? e.new_lines : [];
    const table = lineTable(t);
    const first = Math.max(1, Math.floor(Number(e.start_line)) || 1);
    const last = Math.max(first, Math.floor(Number(e.end_line)) || first);
    const from = offsetOfLine(table, t, first);
    const to = offsetOfLine(table, t, last);
    const unterminated = t.length > 0 && t.charCodeAt(t.length - 1) !== 10; // the last line has no line break of its own
    const body = lines.join(eol);

    let rep;
    let stickLeft = false;
    if (lines.length === 0) rep = '';
    else if (from === t.length && to === t.length && unterminated) { rep = eol + body; stickLeft = true; } // after a last line that has no break
    else if (to === t.length && unterminated) rep = body;      // the run it replaces ended the text without a break: the new one does too
    else rep = body + eol;

    let start = from;
    let end = to;
    let kind = from === to ? 'insert' : lines.length === 0 ? 'delete' : 'replace';
    if (kind === 'delete' && to === t.length && unterminated && from > 0) {
      // The last line has no break of its own and it goes: the text still ends without one, so the break before it goes with it.
      start = from - 1;
      if (start > 0 && t.charCodeAt(start - 1) === 13) start--;
    }
    if (kind === 'replace') {
      const old = t.slice(from, to);
      let p = 0;
      while (p < old.length && p < rep.length && old.charCodeAt(p) === rep.charCodeAt(p)) p++;
      if (p > 0 && isHighSurrogate(old.charCodeAt(p - 1))) p--;
      let q = 0;
      while (q < old.length - p && q < rep.length - p && old.charCodeAt(old.length - 1 - q) === rep.charCodeAt(rep.length - 1 - q)) q++;
      if (q > 0 && isLowSurrogate(old.charCodeAt(old.length - q))) q--;
      start = from + p;
      end = to - q;
      rep = rep.slice(p, rep.length - q);
      if (start === end && rep === '') kind = 'none';
    }
    return { start: start, end: end, rep: rep, text: t.slice(0, start) + rep + t.slice(end), kind: kind, stickLeft: stickLeft, from: from, to: to };
  }

  // Where an offset of the old text is in the new one. Behind the change it moves by the difference in length; before it, it stays. At the
  // start of a line that gets lines put in before it, it goes with its line (the caret stays on the same words); after a last line that has
  // no break it stays (the line break and the new line come after it). Inside what is rewritten it goes behind the new text, inside lines
  // that are taken out it goes to where they were.
  function mapOffset(change, p) {
    const c = change;
    const delta = c.rep.length - (c.end - c.start);
    if (c.kind === 'none') return p;
    if (c.kind === 'insert') {
      if (p < c.start) return p;
      if (p === c.start && c.stickLeft) return p;
      return p + c.rep.length;
    }
    if (p <= c.start) return p;
    if (p >= c.end) return p + delta;
    return c.kind === 'delete' ? c.start : c.start + c.rep.length;
  }

  // The selection after the change: [selStart, selEnd], both moved the same way.
  function selectionAfter(change, selStart, selEnd) {
    return [mapOffset(change, selStart), mapOffset(change, selEnd)];
  }

  // ---- the list of tags to pick from ---------------------------------------------------------------------------

  // The backend's answer to scrapFilterOptions as a list of { tag, files }, the most used first. Anything else is an empty list.
  function folderTags(raw) {
    let src = raw;
    if (typeof src === 'string') {
      try { src = JSON.parse(src); } catch (e) { src = null; }
    }
    const rows = src && typeof src === 'object' && Array.isArray(src.tags) ? src.tags : [];
    const seen = new Set();
    const out = [];
    rows.forEach(function (r) {
      const tag = r && typeof r.tag === 'string' ? normalizeTag(r.tag) : '';
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      const files = Math.floor(Number(r.files));
      out.push({ tag: tag, files: isFinite(files) && files > 0 ? files : 0 });
    });
    return out.sort(function (a, b) { return b.files - a.files || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0); });
  }

  // The answer to op "show": the tags of the whole note, and of the entry (the entry's own ones), as lists of normalized tags without
  // duplicates; the scope it was worked out for ("note" when the line is not in an entry of its own).
  function shownTags(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const list = function (a) {
      const out = [];
      (Array.isArray(a) ? a : []).forEach(function (x) {
        const tag = normalizeTag(x);
        if (tag && out.indexOf(tag) < 0) out.push(tag);
      });
      return out;
    };
    const num = function (n) { return typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : 0; };
    const scope = s.scope === 'entry' ? 'entry' : 'note';
    // The path from the entry up to its root, the nearest first (section 11.2): each place is { line (of its heading), level, heading,
    // range_start, range_end (its lines and all those under it), descendants, tags (its own) }. A note has none; a backend that does not
    // send one (an older one) leaves it empty, and the picker then works on the entry alone.
    const path = [];
    (scope === 'entry' && Array.isArray(s.path) ? s.path : []).forEach(function (p) {
      const line = p && typeof p === 'object' ? num(p.line) : 0;
      if (!line) return;
      const start = num(p.range_start) || line;
      path.push({
        line: line, level: Math.min(3, num(p.level)), heading: typeof p.heading === 'string' ? p.heading : '',
        range_start: start, range_end: Math.max(start, num(p.range_end)), descendants: num(p.descendants), tags: list(p.tags)
      });
    });
    return {
      scope: scope, note: list(s.note_tags), entry: list(s.entry_tags),
      // where the entry is, for the context row (a backend that does not say leaves these 0 and '')
      range_start: num(s.range_start), range_end: num(s.range_end), heading: typeof s.heading === 'string' ? s.heading : '',
      descendants: num(s.descendants), inherited: list(s.inherited_tags), path: path
    };
  }

  // ---- the place a tag goes to (section 11.4) -----------------------------------------------------------------

  // Where the picker starts in the path of the entry that holds the selection's first line (0 = that entry itself, the nearest). For a
  // selection of several lines it is the lowest common ancestor-or-self of that entry and the one that holds the last selected line: the
  // first place of pathFirst (near to far) whose heading line is also in pathLast. A caret, a one-line selection, the same entry, a failed
  // answer for the last line (pathLast null) and a selection across separate trees (nothing in common) all give 0.
  function defaultPlace(pathFirst, pathLast) {
    const first = Array.isArray(pathFirst) ? pathFirst : [];
    const last = Array.isArray(pathLast) ? pathLast : [];
    if (first.length < 2 || last.length === 0) return 0;
    for (let i = 0; i < first.length; i++) {
      for (let k = 0; k < last.length; k++) {
        if (first[i].line === last[k].line) return i;
      }
    }
    return 0;
  }

  // The tags that apply at a place already: the whole note's, the place's own and those of the headings above it. Without a path (the
  // entry alone) they are the entry's own.
  function tagsOn(shown, place) {
    const path = shown && Array.isArray(shown.path) ? shown.path : [];
    let out = shown && Array.isArray(shown.note) ? shown.note.slice() : [];
    if (path.length === 0) return out.concat(shown && Array.isArray(shown.entry) ? shown.entry : []);
    const from = Math.max(0, Math.min(Math.floor(Number(place)) || 0, path.length - 1));
    for (let k = from; k < path.length; k++) out = out.concat(path[k].tags);
    return out;
  }

  // Every tag the text has around the entry: its own, those of the headings above it, then the whole note's (to offer in the list).
  function tagsInText(shown) {
    let out = shown.entry.slice();
    (Array.isArray(shown.path) ? shown.path : []).forEach(function (p) { out = out.concat(p.tags); });
    return out.concat(shown.note);
  }

  // Prefix matches before the others, each group in the order given.
  function matching(tags, query) {
    if (!query) return tags.slice();
    const starts = [];
    const inside = [];
    tags.forEach(function (row) {
      const at = row.tag.indexOf(query);
      if (at === 0) starts.push(row);
      else if (at > 0) inside.push(row);
    });
    return starts.concat(inside);
  }

  // The rows of the list when adding. input: the box's text; ctx: { scope: "note" | "entry" (what the command asked), folder: folderTags(),
  // shown: shownTags() or null while it is being read, place: where in shown.path the tag would go (0 = the entry; default 0) }.
  // Each row is { kind, tags, tag?, files?, where? }; the tags are what pressing Enter on it adds:
  //   "new"    what was typed, all of it (some word of it is a tag nobody has)    "typed"  the same, every word of it is a known tag
  //   "on"     a typed tag that is there already (Enter says so)
  //   "tag"    a tag of the list: the finished words of the box (typed before the last separator) and this tag
  // Returns { rows (at most 8), more (how many were left out), problem: "" | "tooMany" | "tooLong" | "bad" }.
  function addRows(input, ctx) {
    const c = ctx || {};
    const shown = c.shown || { scope: c.scope === 'note' ? 'note' : 'entry', note: [], entry: [] };
    const effectiveScope = c.scope === 'note' || shown.scope === 'note' ? 'note' : 'entry';
    const on = effectiveScope === 'note' ? shown.note.slice() : tagsOn(shown, c.place); // what is on in the range already
    const text = String(input == null ? '' : input);
    const typed = splitTags(text);
    const problem = typed.tooMany ? 'tooMany' : typed.tooLong ? 'tooLong' : typed.bad ? 'bad' : '';
    if (problem) return { rows: [], more: 0, problem: problem }; // nothing that could be added: the panel says what is wrong instead

    // The finished words of the box and the one being typed (none when the box ends in a separator: the whole list is wanted).
    const pieces = text.split(SEPARATORS).map(normalizeTag).filter(Boolean);
    const partial = ENDS_WITH_SEPARATOR.test(text) || pieces.length === 0 ? '' : pieces[pieces.length - 1];
    const done = [];
    pieces.slice(0, pieces.length - (partial ? 1 : 0)).forEach(function (tag) { if (done.indexOf(tag) < 0) done.push(tag); });

    // The pool: the folder's tags, then the ones the note has that the folder does not (a tag of a note not saved yet, say).
    const pool = [];
    const have = new Set();
    (Array.isArray(c.folder) ? c.folder : []).forEach(function (r) { have.add(r.tag); pool.push({ tag: r.tag, files: r.files }); });
    tagsInText(shown).forEach(function (tag) { if (!have.has(tag)) { have.add(tag); pool.push({ tag: tag, files: 0, inText: true }); } });
    const offered = pool.filter(function (r) { return on.indexOf(r.tag) < 0 && done.indexOf(r.tag) < 0; });
    let hits = matching(offered, partial);
    const exact = partial ? hits.findIndex(function (r) { return r.tag === partial; }) : -1;
    if (exact > 0) hits = [hits[exact]].concat(hits.slice(0, exact), hits.slice(exact + 1));

    // What was typed is the first row: "New tag: x" when some word of it is a tag nobody has, "Add: x, y" when all of them are known, and
    // "Already there: x" for one that is on in the range. Not shown when the word still being typed is a tag of the list as it stands: that
    // tag is the first row then (with the finished words in front of it), and does what the typed row would.
    const rows = [];
    if (typed.tags.length === 1 && on.indexOf(typed.tags[0]) >= 0) {
      rows.push({ kind: 'on', tags: typed.tags });
    } else if (typed.tags.length > 0 && !(partial && hits.length > 0 && hits[0].tag === partial)) {
      const known = function (tag) { return have.has(tag) || on.indexOf(tag) >= 0; };
      rows.push({ kind: typed.tags.every(known) ? 'typed' : 'new', tags: typed.tags });
    }
    hits.forEach(function (r) {
      rows.push({ kind: 'tag', tag: r.tag, files: r.files, inText: !!r.inText, tags: done.concat(r.tag).slice(0, MAX_TAGS) });
    });
    return { rows: rows.slice(0, MAX_ROWS), more: Math.max(0, rows.length - MAX_ROWS), problem: problem };
  }

  // The rows of the list when removing: the tags of the place (the entry, or the heading chosen from the path), then the ones it gets from
  // the headings above it, each marked with the heading it comes from (taking it off goes to that heading), then the tags of the whole note.
  // A tag the box's text is found in; nothing else is offered (a tag that is not there cannot be taken off). ctx: { shown, place }.
  // Returns { rows, more }; each row is { kind: "tag", tag, where: "entry" | "parent" | "note", tags: [tag] }, and, when the answer had a
  // path, `at` (the index in the path of the place the tag is on), `heading` and `line` (of that place's heading).
  function removeRows(input, ctx) {
    const c = ctx || {};
    const shown = c.shown || { scope: 'note', note: [], entry: [] };
    const path = Array.isArray(shown.path) ? shown.path : [];
    const place = Math.max(0, Math.min(Math.floor(Number(c.place)) || 0, path.length - 1));
    const query = normalizeTag(input);
    const all = [];
    if (shown.scope === 'entry') {
      if (path.length === 0) {
        shown.entry.forEach(function (tag) { all.push({ kind: 'tag', tag: tag, where: 'entry', tags: [tag] }); });
      } else {
        const at = function (k, where) {
          return function (tag) { all.push({ kind: 'tag', tag: tag, where: where, tags: [tag], at: k, heading: path[k].heading, line: path[k].line }); };
        };
        path[place].tags.forEach(at(place, 'entry'));
        for (let k = place + 1; k < path.length; k++) path[k].tags.forEach(at(k, 'parent'));
      }
    }
    shown.note.forEach(function (tag) { all.push({ kind: 'tag', tag: tag, where: 'note', tags: [tag] }); });
    const hits = matching(all, query);
    return { rows: hits.slice(0, MAX_ROWS), more: Math.max(0, hits.length - MAX_ROWS), problem: '' };
  }

  // ---- what to tell the person ----------------------------------------------------------------------------------

  const CODE_KEYS = {
    already: 'tagEditAlready',
    front_matter: 'tagEditFrontMatter',
    front_matter_tag: 'tagEditFrontMatterTag',
    on_note: 'tagEditOnNote',
    on_entry: 'tagEditOnEntry',
    on_parent: 'tagEditOnParent',
    none_found: 'tagEditNoneFound'
  };

  // The sentence of a message_code as { key, params }: on_parent names the heading the tag comes from and its line.
  function codeSentence(e, code) {
    if (code === 'on_parent') return { key: CODE_KEYS[code], params: { heading: shortHeading(e.parent_heading) || '#', line: e.parent_line > 0 ? e.parent_line : 0 } };
    return { key: CODE_KEYS[code], params: {} };
  }

  // A heading for a sentence: on one line, 40 characters at most (a code point is never cut).
  const HEADING_CHARS = 40;
  function shortHeading(h) {
    const s = String(h == null ? '' : h).replace(/\s+/g, ' ').trim();
    const cps = Array.from(s);
    return cps.length > HEADING_CHARS ? cps.slice(0, HEADING_CHARS).join('').trim() + '…' : s;
  }

  // How far a tag line is from the caret, when that is more than a screenful away (the line goes under the heading, which may be far
  // above the caret, and the editor keeps its scroll: without a word about it the person sees nothing happen where they are).
  const FAR_LINES = 8;
  function relation(tagLine, caretLine) {
    const a = Number(tagLine), b = Number(caretLine);
    if (!(a > 0) || !(b > 0)) return null;
    const n = Math.abs(a - b);
    if (n <= FAR_LINES) return null;
    return { key: a < b ? 'tagEditPlaceAbove' : 'tagEditPlaceBelow', params: { n: n } };
  }

  // The sentences for the status line, as [{ key, params }] (the app joins them with a space). op is what was asked: "add" | "remove".
  // ctx.caretLine (optional): the line the caret was on, to say how far the tag line is from it.
  function describe(edit, op, ctx) {
    const e = edit && typeof edit === 'object' ? edit : {};
    const list = function (a) { return (Array.isArray(a) ? a : []).join(', '); };
    const where = e.scope === 'entry' ? 'Entry' : 'Note';
    const code = typeof e.message_code === 'string' ? e.message_code : '';
    const heading = e.scope === 'entry' ? shortHeading(e.heading) : '';
    const out = [];
    if (e.changed) {
      if (op === 'remove') {
        if (heading) out.push({ key: 'tagEditRemovedEntryHead', params: { tags: list(e.removed), heading: heading } });
        else out.push({ key: 'tagEditRemoved' + where, params: { tags: list(e.removed) } });
      } else {
        // Where it went: under the entry's heading (named), else at its line; the whole note says only that
        if (heading && e.line > 0) out.push({ key: 'tagEditAddedEntryHead', params: { tags: list(e.added), heading: heading, line: e.line } });
        else if (e.scope === 'entry' && e.line > 0 && e.range_start > 0) out.push({ key: 'tagEditAddedEntryLine', params: { tags: list(e.added), line: e.line } });
        else out.push({ key: 'tagEditAdded' + where, params: { tags: list(e.added) } });
        const far = relation(e.line, ctx && ctx.caretLine);
        if (far) out.push(far);
        // A tag under a heading is on every smaller heading below it too: say how many entries that is (section 11.4).
        if (e.scope === 'entry' && e.descendants > 0) out.push({ key: e.descendants === 1 ? 'tagEditAlsoUnderOne' : 'tagEditAlsoUnder', params: { n: e.descendants } });
      }
      if (op !== 'remove' && Array.isArray(e.unchanged) && e.unchanged.length) out.push({ key: 'tagEditAlsoThere', params: { tags: list(e.unchanged) } });
      if (code && code !== 'already' && CODE_KEYS[code]) out.push(codeSentence(e, code));
      return out;
    }
    if (code === 'already') return [{ key: 'tagEditAlready', params: { tags: list(e.unchanged) } }];
    if (CODE_KEYS[code]) return [codeSentence(e, code)];
    return [{ key: 'tagEditNothing', params: {} }];
  }

  // Which of the palette commands are offered: none when the backend has no tagEdit (an older one), else all three.
  function commands(backend) {
    return backend && typeof backend.tagEdit === 'function' ? ['entry', 'note', 'remove'] : [];
  }

  // ---- the picker (the DOM; built only when a command is used) ---------------------------------------------------

  const TAG_ICON = '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>';
  const PLUS_ICON = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
  const ICON_OPEN = '<svg class="menu-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let current = null;  // the open picker, or null
  let wired = false;   // the listeners of the markup are put on once
  let fade = null;     // PanelFade of the card (made on the first opening)
  let openSeq = 0;

  function el(id) { return global.document.getElementById(id); }

  // A backend call as a promise, whatever it throws or returns; a JSON text is read.
  function ask(fn) {
    let call;
    try { call = Promise.resolve(fn()); } catch (err) { call = Promise.reject(err); }
    return call.then(function (v) {
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (e) { return null; }
      }
      return v;
    });
  }

  function failure(err) {
    const m = err && err.message ? err.message : err;
    return String(m == null ? '?' : m).split('\n')[0].trim() || '?';
  }

  function rowTitle(row, t) {
    if (row.kind === 'new') return t('tagEditNew', { tags: row.tags.join(', ') });
    if (row.kind === 'typed') return t('tagEditAddThese', { tags: row.tags.join(', ') });
    if (row.kind === 'on') return t('tagEditOnAlready', { tags: row.tags.join(', ') });
    return row.tags.join(', '); // a tag of the list, with the words already typed in front of it
  }

  function rowDesc(row, t) {
    if (row.kind !== 'tag') return '';
    if (row.where === 'parent') return t('tagEditWhereParent', { heading: shortHeading(row.heading) || '#', line: row.line });
    if (row.where === 'entry' && row.at > 0) return t('tagEditWhereHeading', { heading: shortHeading(row.heading) || '#' }); // a heading above the entry was chosen
    if (row.where) return t(row.where === 'entry' ? 'tagEditWhereEntry' : 'tagEditWhereNote');
    if (row.files > 0) return t(row.files === 1 ? 'tagEditFilesOne' : 'tagEditFiles', { n: row.files });
    return row.inText ? t('tagEditInText') : '';
  }

  // Rows of the state's list for the box's text (nothing while the tags of the note are still being read, apart from what was typed).
  function computeRows(st) {
    const input = el('tag-pick-input').value;
    const ctx = { scope: st.scope, folder: st.folder, shown: st.shown, place: st.place };
    if (st.op === 'remove') return removeRows(input, ctx);
    return addRows(input, ctx);
  }

  // The places of the "where" row: the path of the entry (the nearest first), or null when there is nothing to choose between: the whole-note
  // command, a note whose entry has no heading above it (the entry alone is the place), an older backend.
  function whereChoices(st) {
    const s = st.shown;
    return s && s.scope === 'entry' && st.scope !== 'note' && s.path.length > 1 ? s.path : null;
  }

  // The place the change goes to: { line (the line the backend is asked with), start, end, heading, descendants } - the chosen place of the
  // path, or the entry as the backend said it (an older backend sends no path), or null before the answer.
  function chosenPlace(st) {
    const s = st.shown;
    if (!s || s.scope !== 'entry') return null;
    if (s.path.length > 0) {
      const p = s.path[Math.min(st.place, s.path.length - 1)];
      return { line: p.line, start: p.range_start, end: p.range_end, heading: p.heading, descendants: p.descendants };
    }
    return s.range_start > 0 && s.range_end >= s.range_start ? { line: st.line, start: s.range_start, end: s.range_end, heading: s.heading, descendants: s.descendants } : null;
  }

  function placeLabel(p, t) {
    return t('tagEditPlaceChoice', { heading: shortHeading(p.heading) || '#'.repeat(Math.max(1, p.level)), start: p.range_start, end: p.range_end });
  }

  // The "where" row: one choice per place of the path, the nearest first, the chosen one marked. Not shown (and not built) without a choice.
  function paintWhere(st) {
    const t = st.host.t;
    const box = el('tag-pick-where');
    const path = whereChoices(st);
    el('tag-pick-hint').textContent = t(st.op === 'remove' ? (path ? 'tagEditHintRemoveWhere' : 'tagEditHintRemove') : (path ? 'tagEditHintAddWhere' : 'tagEditHintAdd'));
    if (!box) return;
    if (!path) {
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); box.innerHTML = ''; }
      return;
    }
    const label = t(st.op === 'remove' ? 'tagEditPlaceLabelRemove' : 'tagEditPlaceLabelAdd');
    let html = '<span class="tag-pick-where-label">' + escapeHtml(label) + '</span>';
    path.forEach(function (p, i) {
      html += '<span class="tag-pick-place' + (i === st.place ? ' active' : '') + '" role="radio" aria-checked="' + (i === st.place ? 'true' : 'false') + '" data-place="' + i + '">' + escapeHtml(placeLabel(p, t)) + '</span>';
    });
    box.setAttribute('aria-label', label);
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  // Chooses a place of the path (a click, or Ctrl+Up / Ctrl+Down): what is on at it, the rows and the context row follow.
  function setPlace(st, place) {
    const path = whereChoices(st);
    if (!path || st !== current) return;
    const next = Math.max(0, Math.min(Math.floor(Number(place)) || 0, path.length - 1));
    st.placeChosen = true; // the person's choice: the default worked out from a second answer must not take it back
    if (next === st.place) return;
    st.place = next;
    st.active = 0;
    paintWhere(st);
    paintContext(st);
    paintRows(st);
  }

  function paintRows(st) {
    const t = st.host.t;
    const list = el('tag-pick-list');
    const input = el('tag-pick-input');
    const view = computeRows(st);
    st.rows = view.rows;
    st.problem = view.problem;
    if (st.active >= st.rows.length) st.active = Math.max(0, st.rows.length - 1);
    let html = '';
    st.rows.forEach(function (row, i) {
      const desc = rowDesc(row, t);
      const icon = ICON_OPEN + (row.kind === 'new' ? PLUS_ICON : TAG_ICON) + '</svg>';
      html += '<div class="quick-pick-item tag-pick-item' + (i === st.active ? ' active' : '') + '" id="tag-pick-row-' + i + '" role="option" aria-selected="' + (i === st.active ? 'true' : 'false') + '" data-row="' + i + '">' +
        '<div class="quick-pick-item-main"><span class="quick-pick-item-icon">' + icon + '</span>' +
        '<div class="quick-pick-item-content"><div class="quick-pick-item-title">' + escapeHtml(rowTitle(row, t)) + '</div>' +
        (desc ? '<div class="quick-pick-item-desc">' + escapeHtml(desc) + '</div>' : '') + '</div></div></div>';
    });
    let note = '';
    if (st.problem) note = problemText(t, st.problem);
    else if (st.showStatus === 'loading' && st.rows.length === 0) note = t('tagEditLoading');
    else if (st.showStatus === 'failed') note = t('tagEditShowFailed', { message: st.showMessage });
    else if (st.rows.length === 0) note = t(st.op === 'remove' ? 'tagEditNoRemovable' : 'tagEditTypeATag');
    else if (view.more > 0) note = t('tagEditMore', { n: view.more });
    if (note) html += '<div class="tag-pick-note' + (st.problem || st.showStatus === 'failed' ? ' tag-pick-note-warn' : '') + '" role="status">' + escapeHtml(note) + '</div>';
    list.innerHTML = html;
    list.classList.toggle('hidden', html === '');
    if (st.rows.length) input.setAttribute('aria-activedescendant', 'tag-pick-row-' + st.active);
    else input.removeAttribute('aria-activedescendant');
    const active = list.querySelector('.tag-pick-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  // The context row: what the change is about.
  function paintContext(st) {
    const t = st.host.t;
    // An entry that is the front of the note (nothing above it) is the whole note: the backend says so with the scope it answers.
    const whole = st.op !== 'remove' && (st.scope === 'note' || (st.shown && st.shown.scope === 'note'));
    el('tag-pick-context').textContent = whole ? t('tagEditCtxNote') : entryContext(st, t);
  }

  // The place the change is about: its heading and lines (the subtree, with "and everything under it" and how many entries that is when it
  // has some) when the backend has said (the show answer), else the caret's line. The heading is the one the tag line goes under, so the
  // person sees which unit the caret is in, wherever the caret is.
  function entryContext(st, t) {
    const place = chosenPlace(st);
    if (place && place.start > 0 && place.end >= place.start) {
      const p = { start: place.start, end: place.end, line: st.line };
      const heading = shortHeading(place.heading);
      if (heading) p.heading = heading;
      if (place.descendants > 0) {
        p.under = t(place.descendants === 1 ? 'tagEditUnderOne' : 'tagEditUnder', { n: place.descendants });
        return t(heading ? 'tagEditCtxTreeHead' : 'tagEditCtxTreeRange', p);
      }
      return t(heading ? 'tagEditCtxEntryHead' : 'tagEditCtxEntryRange', p);
    }
    return t('tagEditCtxEntry', { line: st.line });
  }

  // restoreFocus (default true): the caret goes back into the editor. replaced: another picker is opening over this one, which is not a
  // close for the app (its flag stays up).
  function closePicker(restoreFocus, replaced) {
    const st = current;
    if (!st) return;
    current = null;
    el('tag-pick-modal').classList.add('hidden');
    el('tag-pick-list').innerHTML = '';
    el('tag-pick-input').value = '';
    if (el('tag-pick-where')) { el('tag-pick-where').classList.add('hidden'); el('tag-pick-where').innerHTML = ''; }
    if (fade) fade.reset();
    if (restoreFocus !== false && st.editor && st.editor.focus) {
      try { st.editor.focus({ preventScroll: true }); } catch (e) { st.editor.focus(); }
      st.editor.scrollTop = st.scrollTop;
      st.editor.scrollLeft = st.scrollLeft;
    }
    if (!replaced && typeof st.host.onClose === 'function') st.host.onClose();
  }

  // The line of the entry a request is about: the caret's (or the selection's first), or with a path the chosen place's heading line; a tag
  // taken off that comes from a heading above (row.at) is asked at that heading's line.
  function lineFor(st, row) {
    const s = st.shown;
    if (!s || s.scope !== 'entry' || s.path.length === 0) return st.line;
    const at = st.op === 'remove' && row && row.at !== undefined ? row.at : st.place;
    return s.path[Math.max(0, Math.min(at, s.path.length - 1))].line;
  }

  // Enter on a row: ask the backend, close the panel, and put the patch into the editor.
  function commit(st, row) {
    if (st.busy || st !== current) return;
    const t = st.host.t;
    if (st.problem) { st.host.showMessage(problemText(t, st.problem), 4000); return; }
    if (!row) return; // an empty list: Enter does nothing, the list says why
    st.busy = true;
    // (An entry that is the front of the note is switched to the whole note by the backend, not here.) The line is the chosen place's heading
    // (the tag line goes under it, and the whole subtree is its range); a tag that comes from a heading above is taken off at that heading's line.
    const req = request(st.text, st.op, st.op === 'remove' ? (row.where === 'note' ? 'note' : 'entry') : st.scope, lineFor(st, row), row.tags);
    ask(function () { return st.host.backend.tagEdit(req); }).then(function (edit) {
      if (st !== current) return; // closed while the backend was working
      closePicker(true);
      finish(st, req, edit);
    }, function (err) {
      if (st !== current) return;
      closePicker(true);
      st.host.showMessage(t('tagEditFailed', { message: failure(err) }), 5000);
    });
  }

  // The answer: the sentence, and when something changed the patch in the editor (as one undo step).
  function finish(st, req, edit) {
    const t = st.host.t;
    const e = edit && typeof edit === 'object' ? edit : null;
    if (!e) { st.host.showMessage(t('tagEditFailed', { message: '?' }), 5000); return; }
    const say = function () {
      st.host.showMessage(describe(e, req.op, { caretLine: st.line }).map(function (m) { return t(m.key, m.params); }).join(' '), 7000);
    };
    if (!e.changed) { say(); return; }
    if (st.editor.value !== st.text) { st.host.showMessage(t('tagEditStale'), 5000); return; } // the note changed meanwhile: the lines would be wrong
    const change = changeOf(st.text, e);
    if (change.kind === 'none') { say(); return; }
    st.host.apply(st.editor, change, selectionAfter(change, st.selStart, st.selEnd), { scrollTop: st.scrollTop, scrollLeft: st.scrollLeft });
    say();
  }

  function onKey(e) {
    const st = current;
    if (!st) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // one Esc closes one panel
      closePicker(true);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault(); // Ctrl+Up: the heading above (the parent), Ctrl+Down: back toward the entry (the child); the list keeps its row
      if (whereChoices(st)) setPlace(st, st.place + (e.key === 'ArrowUp' ? 1 : -1));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (st.rows.length) {
        st.active = (st.active + (e.key === 'ArrowDown' ? 1 : st.rows.length - 1)) % st.rows.length;
        paintRows(st);
      }
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) {
      if (e.isComposing || e.keyCode === 229) return; // the Enter that confirms a conversion is not "add"
      e.preventDefault(); // Tab stays in the panel too, as in the snippet list: it takes the row like Enter
      commit(st, st.rows[st.active]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const input = el('tag-pick-input');
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', function () {
      if (!current) return;
      current.active = 0;
      paintRows(current);
    });
    // A row is taken on press (the box keeps the focus), like the palette's.
    el('tag-pick-list').addEventListener('mousedown', function (e) {
      const row = e.target && e.target.closest ? e.target.closest('[data-row]') : null;
      e.preventDefault();
      if (!row || !current) return;
      current.active = Number(row.getAttribute('data-row')) || 0;
      commit(current, current.rows[current.active]);
    });
    // A place of the "where" row is chosen on press as well (the box keeps the focus).
    if (el('tag-pick-where')) {
      el('tag-pick-where').addEventListener('mousedown', function (e) {
        const choice = e.target && e.target.closest ? e.target.closest('[data-place]') : null;
        e.preventDefault();
        if (choice && current) setPlace(current, Number(choice.getAttribute('data-place')) || 0);
      });
    }
    el('tag-pick-modal').addEventListener('mousedown', function (e) {
      if (e.target === el('tag-pick-modal')) closePicker(true);
    });
    if (global.PanelFade) {
      fade = global.PanelFade.create(el('tag-pick-card'), {
        isOpen: function () { return !!current; },
        close: function () { closePicker(true); },
        getValue: function () { return el('tag-pick-input').value; },
        refocus: function () { el('tag-pick-input').focus(); }
      });
    }
  }

  // Once both answers are in (the first line's, and the last line's for a selection of several lines), the place the picker starts at: the
  // lowest heading both entries have under it. Never over a place the person has chosen already.
  function decidePlace(st) {
    if (st.placeChosen || st.waitLast || !st.shown) return;
    const next = defaultPlace(st.shown.path, st.pathLast);
    if (next === st.place) return;
    st.place = next;
    st.active = 0;
    paintWhere(st);
    paintContext(st);
    paintRows(st);
  }

  // Opens the picker for the editor. host: { kind: "entry" | "note" | "remove", editor, backend, t, showMessage(msg, ms),
  // apply(editor, change, selection, view) (puts the change into the editor as one undo step and moves the caret), onClose() }.
  // Returns false when the markup is not there.
  function openPicker(host) {
    if (!global.document || !el('tag-pick-modal') || !host || !host.editor || !host.backend) return false;
    wire();
    if (current) closePicker(false, true);
    const editor = host.editor;
    const text = editor.value;
    const st = {
      host: host, editor: editor, text: text, selStart: editor.selectionStart, selEnd: editor.selectionEnd,
      scrollTop: editor.scrollTop, scrollLeft: editor.scrollLeft,
      line: lineOfSelection(text, editor.selectionStart, editor.selectionEnd), sel: selectionLines(text, editor.selectionStart, editor.selectionEnd),
      op: host.kind === 'remove' ? 'remove' : 'add', scope: host.kind === 'note' ? 'note' : 'entry', place: 0, placeChosen: false,
      pathLast: null, waitLast: false, // the path of the entry of the last selected line (a selection of several lines only) and whether it is still on its way
      shown: null, showStatus: 'loading', showMessage: '', folder: [], rows: [], active: 0, problem: '', busy: false, seq: ++openSeq
    };
    current = st;
    const t = host.t;
    const input = el('tag-pick-input');
    // A word selected in the note is what the box starts with, all of it selected (typing replaces it, Enter adds it): for adding only.
    const word = st.op === 'add' ? selectedTag(text, editor.selectionStart, editor.selectionEnd) : '';
    input.value = word;
    input.setAttribute('placeholder', t(st.op === 'remove' ? 'tagEditPlaceholderRemove' : 'tagEditPlaceholderAdd'));
    el('tag-pick-card').setAttribute('aria-label', t(st.op === 'remove' ? 'cmdPaletteTagRemove' : st.scope === 'note' ? 'cmdPaletteTagNote' : 'cmdPaletteTagEntry'));
    paintWhere(st); // (the hint line; the row itself comes with the answer)
    paintContext(st);
    paintRows(st);
    if (fade) fade.reset();
    el('tag-pick-modal').classList.remove('hidden');
    setTimeout(function () { if (current === st) { input.focus(); if (word) input.select(); } }, 0);

    // A selection of several lines starts at the lowest heading the entries of its first and last line have in common: the entry of the last
    // line is asked for as well (at the same time; a caret, a line and the whole-note command ask once). If that fails the first entry's own
    // place stays.
    if (st.scope === 'entry' && st.sel && st.sel.last > st.sel.first) {
      st.waitLast = true;
      ask(function () { return host.backend.tagEdit(request(st.text, 'show', 'entry', st.sel.last, [])); }).then(function (raw) {
        st.pathLast = shownTags(raw).path;
      }, function () { st.pathLast = null; }).then(function () {
        st.waitLast = false;
        if (current === st) decidePlace(st);
      });
    }

    // What the note has at the caret (to show, and to leave out what is on already), and for adding the tags of the folder; each once.
    ask(function () { return host.backend.tagEdit(request(st.text, 'show', 'entry', st.line, [])); }).then(function (raw) {
      if (current !== st) return;
      st.shown = shownTags(raw);
      st.showStatus = 'ready';
      paintWhere(st);
      paintContext(st);
      paintRows(st);
      decidePlace(st);
    }, function (err) {
      if (current !== st) return;
      st.showStatus = 'failed';
      st.showMessage = failure(err);
      paintRows(st);
    });
    if (st.op === 'add' && typeof host.backend.scrapFilterOptions === 'function') {
      ask(function () { return host.backend.scrapFilterOptions(); }).then(function (raw) {
        if (current !== st) return;
        st.folder = folderTags(raw);
        paintRows(st);
      }, function () { /* the folder's tags are only a help: the note's own tags and what is typed still work */ });
    }
    return true;
  }

  function isOpen() {
    return !!current;
  }

  const api = {
    MAX_TAGS: MAX_TAGS,
    MAX_TAG_CHARS: MAX_TAG_CHARS,
    MAX_ROWS: MAX_ROWS,
    normalizeTag: normalizeTag,
    splitTags: splitTags,
    problemText: problemText,
    lineOfOffset: lineOfOffset,
    lineOfSelection: lineOfSelection,
    selectionLines: selectionLines,
    selectedTag: selectedTag,
    defaultPlace: defaultPlace,
    tagsOn: tagsOn,
    request: request,
    changeOf: changeOf,
    mapOffset: mapOffset,
    selectionAfter: selectionAfter,
    folderTags: folderTags,
    shownTags: shownTags,
    addRows: addRows,
    removeRows: removeRows,
    describe: describe,
    shortHeading: shortHeading,
    relation: relation,
    commands: commands,
    openPicker: openPicker,
    isOpen: isOpen
  };
  global.TagEdit = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
