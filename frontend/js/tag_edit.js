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
//    used first), then the tags the note has that the folder list does not; a tag that is already on in the range is not offered. What the
//    person typed is the first row ("New tag: x") unless it is a tag that is there anyway. Several tags can be typed at once.
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
    return { scope: s.scope === 'entry' ? 'entry' : 'note', note: list(s.note_tags), entry: list(s.entry_tags) };
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
  // shown: shownTags() or null while it is being read }.
  // Each row is { kind, tags, tag?, files?, where? }; the tags are what pressing Enter on it adds:
  //   "new"    what was typed, all of it (some word of it is a tag nobody has)    "typed"  the same, every word of it is a known tag
  //   "on"     a typed tag that is there already (Enter says so)
  //   "tag"    a tag of the list: the finished words of the box (typed before the last separator) and this tag
  // Returns { rows (at most 8), more (how many were left out), problem: "" | "tooMany" | "tooLong" | "bad" }.
  function addRows(input, ctx) {
    const c = ctx || {};
    const shown = c.shown || { scope: c.scope === 'note' ? 'note' : 'entry', note: [], entry: [] };
    const effectiveScope = c.scope === 'note' || shown.scope === 'note' ? 'note' : 'entry';
    const on = effectiveScope === 'note' ? shown.note.slice() : shown.note.concat(shown.entry); // what is on in the range already
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
    shown.entry.concat(shown.note).forEach(function (tag) { if (!have.has(tag)) { have.add(tag); pool.push({ tag: tag, files: 0, inText: true }); } });
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

  // The rows of the list when removing: the tags of the entry, then the tags of the whole note, each marked with the range it would be
  // taken from. A tag the box's text is found in; nothing else is offered (a tag that is not there cannot be taken off).
  // Returns { rows, more }; each row is { kind: "tag", tag, where: "entry" | "note", tags: [tag] }.
  function removeRows(input, ctx) {
    const c = ctx || {};
    const shown = c.shown || { scope: 'note', note: [], entry: [] };
    const query = normalizeTag(input);
    const all = [];
    if (shown.scope === 'entry') {
      shown.entry.forEach(function (tag) { all.push({ kind: 'tag', tag: tag, where: 'entry', tags: [tag] }); });
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
    none_found: 'tagEditNoneFound'
  };

  // The sentences for the status line, as [{ key, params }] (the app joins them with a space). op is what was asked: "add" | "remove".
  function describe(edit, op) {
    const e = edit && typeof edit === 'object' ? edit : {};
    const list = function (a) { return (Array.isArray(a) ? a : []).join(', '); };
    const where = e.scope === 'entry' ? 'Entry' : 'Note';
    const code = typeof e.message_code === 'string' ? e.message_code : '';
    const out = [];
    if (e.changed) {
      if (op === 'remove') out.push({ key: 'tagEditRemoved' + where, params: { tags: list(e.removed) } });
      else out.push({ key: 'tagEditAdded' + where, params: { tags: list(e.added) } });
      if (op !== 'remove' && Array.isArray(e.unchanged) && e.unchanged.length) out.push({ key: 'tagEditAlsoThere', params: { tags: list(e.unchanged) } });
      if (code && code !== 'already' && CODE_KEYS[code]) out.push({ key: CODE_KEYS[code], params: {} });
      return out;
    }
    if (code === 'already') return [{ key: 'tagEditAlready', params: { tags: list(e.unchanged) } }];
    if (CODE_KEYS[code]) return [{ key: CODE_KEYS[code], params: {} }];
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
    if (row.where) return t(row.where === 'entry' ? 'tagEditWhereEntry' : 'tagEditWhereNote');
    if (row.files > 0) return t(row.files === 1 ? 'tagEditFilesOne' : 'tagEditFiles', { n: row.files });
    return row.inText ? t('tagEditInText') : '';
  }

  // Rows of the state's list for the box's text (nothing while the tags of the note are still being read, apart from what was typed).
  function computeRows(st) {
    const input = el('tag-pick-input').value;
    const ctx = { scope: st.scope, folder: st.folder, shown: st.shown };
    if (st.op === 'remove') return removeRows(input, ctx);
    return addRows(input, ctx);
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
    el('tag-pick-context').textContent = whole ? t('tagEditCtxNote') : t('tagEditCtxEntry', { line: st.line });
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
    if (fade) fade.reset();
    if (restoreFocus !== false && st.editor && st.editor.focus) {
      try { st.editor.focus({ preventScroll: true }); } catch (e) { st.editor.focus(); }
      st.editor.scrollTop = st.scrollTop;
      st.editor.scrollLeft = st.scrollLeft;
    }
    if (!replaced && typeof st.host.onClose === 'function') st.host.onClose();
  }

  // Enter on a row: ask the backend, close the panel, and put the patch into the editor.
  function commit(st, row) {
    if (st.busy || st !== current) return;
    const t = st.host.t;
    if (st.problem) { st.host.showMessage(problemText(t, st.problem), 4000); return; }
    if (!row) return; // an empty list: Enter does nothing, the list says why
    st.busy = true;
    // (An entry that is the front of the note is switched to the whole note by the backend, not here.)
    const req = request(st.text, st.op, st.op === 'remove' ? row.where : st.scope, st.line, row.tags);
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
      st.host.showMessage(describe(e, req.op).map(function (m) { return t(m.key, m.params); }).join(' '), 5000);
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
      line: lineOfSelection(text, editor.selectionStart, editor.selectionEnd),
      op: host.kind === 'remove' ? 'remove' : 'add', scope: host.kind === 'note' ? 'note' : 'entry',
      shown: null, showStatus: 'loading', showMessage: '', folder: [], rows: [], active: 0, problem: '', busy: false, seq: ++openSeq
    };
    current = st;
    const t = host.t;
    const input = el('tag-pick-input');
    input.value = '';
    input.setAttribute('placeholder', t(st.op === 'remove' ? 'tagEditPlaceholderRemove' : 'tagEditPlaceholderAdd'));
    el('tag-pick-card').setAttribute('aria-label', t(st.op === 'remove' ? 'cmdPaletteTagRemove' : st.scope === 'note' ? 'cmdPaletteTagNote' : 'cmdPaletteTagEntry'));
    el('tag-pick-hint').textContent = t(st.op === 'remove' ? 'tagEditHintRemove' : 'tagEditHintAdd');
    paintContext(st);
    paintRows(st);
    if (fade) fade.reset();
    el('tag-pick-modal').classList.remove('hidden');
    setTimeout(function () { if (current === st) input.focus(); }, 0);

    // What the note has at the caret (to show, and to leave out what is on already), and for adding the tags of the folder; each once.
    ask(function () { return host.backend.tagEdit(request(st.text, 'show', 'entry', st.line, [])); }).then(function (raw) {
      if (current !== st) return;
      st.shown = shownTags(raw);
      st.showStatus = 'ready';
      paintContext(st);
      paintRows(st);
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
    request: request,
    changeOf: changeOf,
    mapOffset: mapOffset,
    selectionAfter: selectionAfter,
    folderTags: folderTags,
    shownTags: shownTags,
    addRows: addRows,
    removeRows: removeRows,
    describe: describe,
    commands: commands,
    openPicker: openPicker,
    isOpen: isOpen
  };
  global.TagEdit = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
