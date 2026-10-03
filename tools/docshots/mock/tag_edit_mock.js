// The mock backend's tagEdit: a port of search.EditTags (pkg/search/tagedit.go) for the plain texts the screens exercise, so that the smoke flows and the
// documentation pictures see the answer the Go side would give (docs/design/tag-filter-2026-10.md section 10.2). ONE file, loaded by both:
//   - the page, as /__docshot/tag_edit_mock.js (tools/docshots/server.mjs puts it before mock/backend.js), which calls window.TagEditMock.editTags;
//   - node, by tests/tag_edit_mock_test.mjs, which runs every case of pkg/search/testdata/tagedit_golden.json through it and compares all fields.
// Deliberately NOT the code of the page (frontend/js/tag_edit.js): the page is what the mock is there to test.
//
// What it follows (the same walk as ScanTags / scanTagDoc): the lines of the text split at "\n" (a last line break does not start a line), the
// entries cut by "#".."###" headings and "---" rules outside ``` / ~~~ fences, the front part of the file, a YAML front matter, the one-line
// tag comments "<!-- tags: a, b -->". It does not handle what the golden test lists as skipped on purpose: mixed or odd line endings beyond the
// plain "\r\n" the patch carries, byte order marks written as bytes, the byte-size limit counted exactly.
(function (global) {
  'use strict';

  const MAX_FILTER_TAGS = 8;
  const MAX_TAG_RUNES = 64;
  const MAX_TAGS_PER_COMMENT = 32;
  const MAX_FRONT_MATTER_LINES = 200;
  const MAX_BYTES = 16 << 20;
  const BOM = String.fromCharCode(0xFEFF); // the byte order mark as a character

  // ---- tags (tags.go) ---------------------------------------------------------------------------------------------

  function normalizeTag(s) {
    let t = '';
    String(s).split('').forEach((ch) => {
      const c = ch.charCodeAt(0);
      t += c >= 0xFF01 && c <= 0xFF5E ? String.fromCharCode(c - 0xFEE0) : ch;
    });
    return t.trim().replace(/^#+/, '').trim().toLowerCase();
  }

  const SEP = /[\s,;、，；]+/;
  const runeCount = (s) => Array.from(s).length;
  const hasTag = (list, t) => list.indexOf(t) >= 0;

  // The tags of a list, at most max of them, normalized, without duplicates, in order; tooLong and overflow say what was not taken.
  function scanTagList(s, max) {
    const out = [];
    let tooLong = false;
    let overflow = false;
    const pieces = String(s).split(SEP);
    for (let i = 0; i < pieces.length && !overflow; i++) {
      const t = normalizeTag(pieces[i]);
      if (t === '') continue;
      if (runeCount(t) > MAX_TAG_RUNES) tooLong = true;
      else if (hasTag(out, t)) continue;
      else if (out.length >= max) overflow = true;
      else out.push(t);
    }
    return { out, tooLong, overflow };
  }

  const parseTags = (s, max) => scanTagList(s, max).out;

  function parseTagFilter(list) {
    const items = (Array.isArray(list) ? list : [list]).map((x) => (x == null ? '' : String(x)));
    if (!items.some((s) => s.trim() !== '')) return [];
    const r = scanTagList(items.join(','), MAX_FILTER_TAGS);
    if (r.overflow) throw new Error('too many tags (at most ' + MAX_FILTER_TAGS + ')');
    if (r.tooLong) throw new Error('a tag is longer than ' + MAX_TAG_RUNES + ' characters');
    if (r.out.length === 0) throw new Error('no tag in ' + JSON.stringify(items.join(',')));
    return r.out;
  }

  // Appends to dst the tags of src that dst does not hold yet, up to max in all.
  function addTags(dst, src, max) {
    const out = dst.slice();
    for (let i = 0; i < src.length && out.length < max; i++) if (!hasTag(out, src[i])) out.push(src[i]);
    return out;
  }

  // ---- the entries (ranked.go Entries / headingTracker) --------------------------------------------------------------

  function isRuleLine(line) {
    return /^-{3,}$/.test(line.trim());
  }

  function isEntryHeading(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    if (i > 3) return false;
    let n = 0;
    while (i + n < line.length && line[i + n] === '#') n++;
    if (n < 1 || n > 3) return false;
    const rest = line.slice(i + n);
    return rest === '' || rest[0] === ' ' || rest[0] === '\t';
  }

  // Follows the fenced code of a file line by line (only the fence matters here: a heading in a fence is code).
  function feed(tr, line) {
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    if (i > 3 || i >= line.length) return;
    const c = line[i];
    if (c !== '`' && c !== '~') return;
    let n = 0;
    while (i + n < line.length && line[i + n] === c) n++;
    if (n < 3) return;
    const rest = line.slice(i + n);
    if (tr.fenceChar === '') {
      if (c === '`' && rest.indexOf('`') >= 0) return;
      tr.fenceChar = c;
      tr.fenceLen = n;
    } else if (c === tr.fenceChar && n >= tr.fenceLen && rest.trim() === '') {
      tr.fenceChar = '';
    }
  }

  // The lines the way the search counts them: split at "\n", a last line break starts no line, a trailing "\r" is not part of a line.
  function goLines(text) {
    if (text === '') return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts.map((l) => (l.charCodeAt(l.length - 1) === 13 ? l.slice(0, -1) : l));
  }

  function entriesOf(lines) {
    const out = [];
    const tr = { fenceChar: '', fenceLen: 0 };
    let onlyRul = false;
    let startLine = 1;
    for (let k = 1; k <= lines.length; k++) {
      const line = lines[k - 1];
      let first = '';
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== ' ') { first = line[i]; break; }
      }
      if (first === '-' || first === '#' || first === '`' || first === '~') {
        const inFence = tr.fenceChar !== '';
        feed(tr, line);
        let starts = false;
        if (!inFence) {
          const rule = isRuleLine(line);
          const heading = isEntryHeading(line);
          if (!rule && !heading) {
            onlyRul = false;
          } else if (heading && onlyRul) {
            onlyRul = false;
          } else {
            onlyRul = rule;
            starts = true;
          }
        }
        if (starts && k > startLine) {
          out.push({ startLine: startLine, endLine: k - 1 });
          startLine = k;
        }
      } else {
        onlyRul = false;
      }
    }
    if (lines.length > 0) out.push({ startLine: startLine, endLine: lines.length });
    return out;
  }

  // ---- the front matter (tags.go frontMatterOf) ----------------------------------------------------------------------

  function isKeyLine(s) {
    const colon = s.indexOf(':');
    if (colon <= 0 || (colon + 1 < s.length && s[colon + 1] !== ' ' && s[colon + 1] !== '\t')) return false;
    const key = s.slice(0, colon).replace(/[ \t]+$/, '');
    if (key === '') return false;
    return /^[\p{L}\p{N}_.-]+$/u.test(key) && key[0] !== '-' && key[0] !== '.';
  }

  function yamlValue(v) {
    return v.replace(/[[\]"']/g, ' ');
  }

  // { tags, close }: the tags of a YAML front matter at the very start of the text and the 1-based line of its closing "---" (or "..."), 0 for none.
  function frontMatterOf(text) {
    const data = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    if (!data.startsWith('---')) return { tags: [], close: 0 };
    const rows = data.split('\n');
    if (rows[rows.length - 1] === '') rows.pop();
    let tags = [];
    let seenKey = false;
    let inList = false;
    for (let n = 0; n < rows.length; n++) {
      if (n > MAX_FRONT_MATTER_LINES) return { tags: [], close: 0 };
      const s = rows[n].replace(/[ \t\r]+$/, '');
      if (n === 0) {
        if (s !== '---') return { tags: [], close: 0 };
        continue;
      }
      const trimmed = s.trim();
      if (!seenKey) {
        if (trimmed === '') continue;
        if (!isKeyLine(s)) return { tags: [], close: 0 };
        seenKey = true;
      }
      if (s === '---' || s === '...') return { tags: tags, close: n + 1 };
      if (inList) {
        if (trimmed.startsWith('-')) {
          tags = addTags(tags, parseTags(yamlValue(trimmed.slice(1)), MAX_TAGS_PER_COMMENT), MAX_TAGS_PER_COMMENT);
          continue;
        }
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        inList = false;
      }
      if (s === '' || s[0] === ' ' || s[0] === '\t') continue;
      const colon = s.indexOf(':');
      if (colon <= 0) continue;
      const key = s.slice(0, colon).trim().toLowerCase();
      if (key === 'tags' || key === 'tag') {
        const val = s.slice(colon + 1).trim();
        if (val === '') inList = true;
        else tags = addTags(tags, parseTags(yamlValue(val), MAX_TAGS_PER_COMMENT), MAX_TAGS_PER_COMMENT);
      }
    }
    return { tags: [], close: 0 };
  }

  // ---- reading a text (tagedit.go scanTagDoc) ------------------------------------------------------------------------

  // What follows the colon of a line that is one whole tag comment, or null (t starts with "<!--").
  function tagCommentBody(t) {
    const s = t.replace(/[ \t\r]+$/, '');
    if (s.length < 7 || s.slice(-3) !== '-->') return null;
    const inner = s.slice(4, -3);
    if (inner.indexOf('-->') >= 0 || inner.indexOf('<!--') >= 0) return null;
    const colon = inner.indexOf(':');
    if (colon < 0) return null;
    const key = inner.slice(0, colon).trim().toLowerCase();
    return key === 'tags' || key === 'tag' ? inner.slice(colon + 1) : null;
  }

  function scanDoc(text) {
    const lines = goLines(text);
    const d = { text: text, lines: lines, entries: entriesOf(lines), tagLines: [], preamble: false, note: [], own: [], fmTags: [], fmEnd: 0 };
    d.own = d.entries.map(() => []);
    const fm = frontMatterOf(text);
    d.fmTags = fm.tags;
    d.fmEnd = fm.close;
    d.note = fm.tags.slice();
    if (d.entries.length === 0) return d;
    const first = (lines[0].charCodeAt(0) === 0xFEFF ? lines[0].slice(1) : lines[0]).slice(0, 256);
    d.preamble = !isRuleLine(first) && !isEntryHeading(first);
    if (text.indexOf('<!--') < 0) return d;

    const tr = { fenceChar: '', fenceLen: 0 };
    let ei = 0;
    for (let k = 1; k <= lines.length; k++) {
      const line = lines[k - 1];
      let t = line.replace(/^ +/, '');
      if (t.length > 0 && (t[0] === '`' || t[0] === '~')) {
        feed(tr, line);
        continue;
      }
      if (tr.fenceChar !== '') continue;
      if (k === 1 && t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      t = t.replace(/^[ \t]+/, '');
      if (!t.startsWith('<!--')) continue;
      const body = tagCommentBody(t);
      if (body === null) continue;
      while (ei + 1 < d.entries.length && d.entries[ei + 1].startLine <= k) ei++;
      const tags = parseTags(body, MAX_TAGS_PER_COMMENT);
      d.tagLines.push({ line: k, prefix: line.slice(0, line.length - t.length), tags: tags, entry: ei });
      if (ei === 0 && d.preamble) d.note = addTags(d.note, tags, Infinity);
      else d.own[ei] = addTags(d.own[ei], tags, Infinity);
    }
    return d;
  }

  // The index of the entry that holds the line, or -1 when the range is the whole note.
  function entryAtLine(d, line) {
    const n = d.lines.length;
    if (n === 0 || d.entries.length === 0) return -1;
    const l = Math.min(line, n);
    if (d.fmEnd > 0 && l <= d.fmEnd) return -1;
    let i = -1;
    for (let k = 0; k < d.entries.length; k++) if (d.entries[k].startLine <= l) i = k;
    if (i < 0 || (i === 0 && d.preamble)) return -1;
    return i;
  }

  function scopeLines(d, ent) {
    return d.tagLines.filter((c) => (ent < 0 && c.entry === 0 && d.preamble) || (ent >= 0 && c.entry === ent));
  }

  function anchor(d, ent) {
    const e = d.entries[ent];
    if (ent === 0 && d.fmEnd > 0) return d.fmEnd;
    if (isRuleLine(d.lines[e.startLine - 1]) && e.startLine + 1 <= e.endLine && isEntryHeading(d.lines[e.startLine])) return e.startLine + 1;
    return e.startLine;
  }

  const renderTags = (tags) => '<!-- tags: ' + tags.join(', ') + ' -->';
  const render = (c, tags) => c.prefix + renderTags(tags);
  const below = (c, tags) => c.prefix.split(BOM).join('') + renderTags(tags);

  // ---- the edits (tagedit.go add / remove) ------------------------------------------------------------------------------

  function add(d, res, want, ent) {
    if (ent < 0 && d.fmEnd > 0) {
      res.unchanged = want.slice();
      res.message_code = 'front_matter';
      return;
    }
    let have = d.note.slice();
    if (ent >= 0) have = have.concat(d.own[ent]);
    const toAdd = [];
    want.forEach((t) => { if (hasTag(have, t)) res.unchanged.push(t); else toAdd.push(t); });
    if (toAdd.length === 0) {
      res.message_code = 'already';
      return;
    }
    res.changed = true;
    res.added = toAdd;

    const inScope = scopeLines(d, ent);
    if (inScope.length > 0) {
      const c = inScope[0];
      const room = MAX_TAGS_PER_COMMENT - c.tags.length;
      if (room <= 0) {
        res.start_line = c.line + 1;
        res.end_line = c.line + 1;
        res.new_lines = [below(c, toAdd)];
        res.line = c.line + 1;
        return;
      }
      const n = Math.min(room, toAdd.length);
      res.start_line = c.line;
      res.end_line = c.line + 1;
      res.new_lines = [render(c, c.tags.concat(toAdd.slice(0, n)))];
      if (n < toAdd.length) res.new_lines.push(below(c, toAdd.slice(n)));
      res.line = c.line + res.new_lines.length - 1;
      return;
    }

    const line = renderTags(toAdd);
    if (ent >= 0) {
      const a = anchor(d, ent);
      res.start_line = a + 1;
      res.end_line = a + 1;
      res.new_lines = [line];
      res.line = a + 1;
      return;
    }
    res.line = 1;
    if (d.lines.length > 0 && d.text.charCodeAt(0) === 0xFEFF) {
      res.start_line = 1;
      res.end_line = 2;
      res.new_lines = [BOM + line, d.lines[0].replace(BOM, '')];
      return;
    }
    res.start_line = 1;
    res.end_line = 1;
    res.new_lines = [line];
  }

  function remove(d, res, want, ent) {
    const inScope = scopeLines(d, ent);
    let inTags = [];
    inScope.forEach((c) => { inTags = addTags(inTags, c.tags, Infinity); });
    let noteComment = [];
    if (d.preamble) scopeLines(d, -1).forEach((c) => { noteComment = addTags(noteComment, c.tags, Infinity); });
    const elsewhere = (t) => {
      if (ent >= 0) {
        if (hasTag(noteComment, t)) return 'on_note';
        if (hasTag(d.fmTags, t)) return 'front_matter_tag';
        return 'none_found';
      }
      if (hasTag(d.fmTags, t)) return 'front_matter_tag';
      for (let i = 0; i < d.own.length; i++) if (hasTag(d.own[i], t)) return 'on_entry';
      return 'none_found';
    };
    const rank = (code) => (code === '' ? 0 : code === 'none_found' ? 1 : 2);
    const rm = {};
    let code = '';
    want.forEach((t) => {
      if (hasTag(inTags, t)) {
        rm[t] = true;
        res.removed.push(t);
        return;
      }
      res.unchanged.push(t);
      const why = elsewhere(t);
      if (rank(why) > rank(code)) code = why;
    });
    if (res.removed.length === 0) {
      res.message_code = code;
      return;
    }
    if (rank(code) === 2) res.message_code = code;

    const changes = [];
    inScope.forEach((c) => {
      const keep = c.tags.filter((t) => !rm[t]);
      if (keep.length !== c.tags.length) changes.push({ c: c, keep: keep });
    });
    res.changed = true;
    res.start_line = changes[0].c.line;
    res.end_line = changes[changes.length - 1].c.line + 1;
    let bom = '';
    const put = (s) => { res.new_lines.push(bom + s); bom = ''; };
    let next = 0;
    for (let k = res.start_line; k < res.end_line; k++) {
      if (next < changes.length && changes[next].c.line === k) {
        const ch = changes[next++];
        if (ch.keep.length === 0) {
          if (k === 1 && ch.c.prefix.indexOf(BOM) >= 0) bom = BOM;
          continue;
        }
        if (res.line === 0) res.line = res.start_line + res.new_lines.length;
        put(render(ch.c, ch.keep));
        continue;
      }
      put(d.lines[k - 1]);
    }
    if (bom !== '' && res.end_line <= d.lines.length) {
      put(d.lines[res.end_line - 1]);
      res.end_line++;
    }
  }

  // ---- the entry point and Apply ------------------------------------------------------------------------------------------

  function eolOf(text) {
    const i = text.indexOf('\n');
    return i > 0 && text.charCodeAt(i - 1) === 13 ? '\r\n' : '\n';
  }

  function utf8Length(text) {
    if (text.length * 3 <= MAX_BYTES) return text.length * 3;
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length * 3;
  }

  // EditTags(text, op, scope, line, tags) -> the TagEdit (the JSON of section 10.3); throws an Error for a bad request.
  function editTags(text, op, scope, line, tags) {
    const data = String(text == null ? '' : text);
    if (op !== 'add' && op !== 'remove' && op !== 'show') throw new Error('unknown op ' + JSON.stringify(op) + ' (add, remove or show)');
    if (scope !== 'note' && scope !== 'entry') throw new Error('unknown scope ' + JSON.stringify(scope) + ' (note or entry)');
    if (utf8Length(data) > MAX_BYTES) throw new Error('the text is over 16 MB');
    let want = [];
    if (op !== 'show') {
      want = parseTagFilter(tags);
      if (want.length === 0) throw new Error('no tag given');
      want.forEach((t) => {
        if (t.indexOf('-->') >= 0 || t.indexOf('<!--') >= 0) throw new Error('a tag cannot contain "<!--" or "-->"');
      });
    }
    if (scope === 'entry') {
      const lastLine = data.split('\n').length;
      if (!(line >= 1 && line <= lastLine)) throw new Error('line ' + line + ' is outside the text (1 to ' + lastLine + ')');
    }
    const d = scanDoc(data);
    const res = {
      changed: false, scope: scope, start_line: 0, end_line: 0, new_lines: [], eol: eolOf(data), line: 0,
      added: [], removed: [], unchanged: [], note_tags: [], entry_tags: [], message_code: ''
    };
    let ent = -1;
    if (scope === 'entry') {
      ent = entryAtLine(d, line);
      if (ent < 0) res.scope = 'note';
    }
    if (op === 'add') add(d, res, want, ent);
    else if (op === 'remove') remove(d, res, want, ent);

    const after = res.changed ? apply(data, res) : data;
    const fb = after === data ? d : scanDoc(after);
    res.note_tags = fb.note.slice();
    if (ent >= 0) {
      const start = d.entries[ent].startLine;
      let i = -1;
      for (let k = 0; k < fb.entries.length; k++) if (fb.entries[k].startLine <= start) i = k;
      if (i >= 0) res.entry_tags = fb.own[i].slice();
    }
    return res;
  }

  // The new text: the lines before start_line, new_lines each ended with eol, the lines from end_line on; every other byte as it was. A text that did not
  // end with a newline still does not when the patch reaches its end (appending gives the last line a break, deleting the last line takes the break before it).
  function apply(text, edit) {
    if (!edit.changed) return text;
    const eol = edit.eol || '\n';
    const lineStart = (n) => {
      let off = 0;
      for (; n > 1; n--) {
        const i = text.indexOf('\n', off);
        if (i < 0) return text.length;
        off = i + 1;
      }
      return off;
    };
    const start = lineStart(edit.start_line);
    const end = edit.end_line > edit.start_line ? lineStart(edit.end_line) : start;
    let head = text.slice(0, start);
    const tail = text.slice(end);
    const terminated = text.length === 0 || text.charCodeAt(text.length - 1) === 10;
    const lines = edit.new_lines || [];
    if (lines.length === 0) {
      if (tail.length === 0 && !terminated) {
        if (head.endsWith('\n')) head = head.slice(0, -1);
        if (head.endsWith('\r')) head = head.slice(0, -1);
      }
      return head + tail;
    }
    if (tail.length > 0 || terminated) return head + lines.map((l) => l + eol).join('') + tail;
    if (start === text.length) return text + eol + lines.join(eol);
    return head + lines.join(eol);
  }

  const api = { editTags: editTags, apply: apply, normalizeTag: normalizeTag };
  global.TagEditMock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
