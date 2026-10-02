// MD-Memo "special paste": clipboard HTML -> clean Markdown (a small Turndown-equivalent).
//
// No dependency: pasted HTML is untrusted, so this parses it with a tolerant hand-written
// tokenizer/tree builder instead of the DOM (innerHTML/DOMParser would execute or need a
// browser, and Node tests here have no jsdom). Never eval()s or builds real DOM nodes.
(function (global) {
  'use strict';

  const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);
  // Content of these is not HTML (may contain stray '<'); scan it as raw text and drop it.
  const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
  // Rendered as nothing, whole subtree included.
  const SKIP_TAGS = new Set([
    'script', 'style', 'head', 'meta', 'link', 'noscript', 'template', 'svg', 'iframe', 'object'
  ]);
  // Block-ish containers with no markdown syntax of their own: their children flow into the
  // surrounding block list (this is what makes div/section/etc. "just cause a paragraph break").
  const TRANSPARENT_BLOCK = new Set([
    'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
    'figure', 'figcaption', 'html', 'body', 'form', 'fieldset', 'details', 'summary', 'center'
  ]);
  // A start tag for key implicitly closes an open element of the same tag on top of the stack
  // (real HTML does this; copied web markup very often omits these closing tags).
  const AUTO_CLOSE = {
    li: ['li'], p: ['p'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], option: ['option']
  };

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
    nbsp: ' ', copy: '©', reg: '®', hellip: '…',
    mdash: '—', ndash: '–', laquo: '«', raquo: '»', yen: '¥'
  };

  function isSpace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  }

  function isAlpha(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  function isNameChar(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === ':';
  }

  function decodeEntities(str) {
    if (str.indexOf('&') === -1) return str;
    const out = [];
    const len = str.length;
    let i = 0;
    while (i < len) {
      if (str[i] === '&') {
        const semi = str.indexOf(';', i + 1);
        if (semi !== -1 && semi - i <= 10) {
          const ent = str.slice(i + 1, semi);
          let rep = null;
          if (ent[0] === '#') {
            let code = null;
            if (ent[1] === 'x' || ent[1] === 'X') code = parseInt(ent.slice(2), 16);
            else code = parseInt(ent.slice(1), 10);
            if (code !== null && !isNaN(code) && code >= 0 && code <= 0x10FFFF) {
              try { rep = String.fromCodePoint(code); } catch (e) { rep = null; }
            }
          } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent)) {
            rep = NAMED_ENTITIES[ent];
          }
          if (rep !== null) {
            out.push(rep);
            i = semi + 1;
            continue;
          }
        }
      }
      out.push(str[i]);
      i++;
    }
    return out.join('');
  }

  // ---- tokenizer -------------------------------------------------------------------------

  function readTagName(html, i) {
    const len = html.length;
    if (i >= len || !isAlpha(html[i])) return null;
    let j = i + 1;
    while (j < len && isNameChar(html[j])) j++;
    return html.slice(i, j);
  }

  function readAttrs(html, start) {
    const len = html.length;
    let j = start;
    const attrs = {};
    let selfClose = false;
    while (j < len) {
      while (j < len && isSpace(html[j])) j++;
      if (j >= len) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/') {
        if (html[j + 1] === '>') { selfClose = true; j += 2; break; }
        j++;
        continue;
      }
      const nameStart = j;
      while (j < len) {
        const c = html[j];
        if (isSpace(c) || c === '=' || c === '/' || c === '>') break;
        j++;
      }
      if (j === nameStart) { j++; continue; }
      const attrName = html.slice(nameStart, j).toLowerCase();
      while (j < len && isSpace(html[j])) j++;
      let attrValue = '';
      if (html[j] === '=') {
        j++;
        while (j < len && isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === '\'') {
          j++;
          const valStart = j;
          const closeIdx = html.indexOf(q, j);
          const end = closeIdx === -1 ? len : closeIdx;
          attrValue = html.slice(valStart, end);
          j = closeIdx === -1 ? len : closeIdx + 1;
        } else {
          const valStart = j;
          while (j < len && !isSpace(html[j]) && html[j] !== '>') j++;
          attrValue = html.slice(valStart, j);
        }
      }
      attrs[attrName] = decodeEntities(attrValue);
    }
    return { attrs, selfClose, end: j };
  }

  function tokenize(html) {
    const tokens = [];
    const len = html.length;
    let i = 0;
    // The lower-cased copy that </style> / </script> are looked up in, made once and only when one shows up (making it for each such
    // element copied the whole page every time: the conversion time grew with the square of their number).
    let lowerHtml = null;
    while (i < len) {
      if (html[i] === '<') {
        if (html.startsWith('<!--', i)) {
          const end = html.indexOf('-->', i + 4);
          i = end === -1 ? len : end + 3;
          continue;
        }
        if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
          const end = html.indexOf('>', i + 2);
          i = end === -1 ? len : end + 1;
          continue;
        }
        if (html[i + 1] === '/') {
          const name = readTagName(html, i + 2);
          if (name) {
            const gt = html.indexOf('>', i + 2 + name.length);
            i = gt === -1 ? len : gt + 1;
            tokens.push({ t: 'end', name: name.toLowerCase() });
            continue;
          }
          tokens.push({ t: 'text', v: '<' });
          i++;
          continue;
        }
        const name = readTagName(html, i + 1);
        if (name) {
          const lower = name.toLowerCase();
          const parsed = readAttrs(html, i + 1 + name.length);
          i = parsed.end;
          if (RAW_TEXT_ELEMENTS.has(lower) && !parsed.selfClose) {
            const closeMarker = '</' + lower;
            if (lowerHtml === null) lowerHtml = html.toLowerCase();
            const idx = lowerHtml.indexOf(closeMarker, i);
            if (idx === -1) { i = len; }
            else {
              const gt = html.indexOf('>', idx);
              i = gt === -1 ? len : gt + 1;
            }
            continue; // raw-text content dropped entirely, never reaches output
          }
          tokens.push({ t: 'start', name: lower, attrs: parsed.attrs, selfClose: parsed.selfClose });
          continue;
        }
        tokens.push({ t: 'text', v: '<' });
        i++;
        continue;
      }
      const next = html.indexOf('<', i);
      const end = next === -1 ? len : next;
      tokens.push({ t: 'text', v: decodeEntities(html.slice(i, end)) });
      i = end;
    }
    return tokens;
  }

  // ---- tree builder ------------------------------------------------------------------------

  function buildTree(tokens) {
    const root = { tag: '#root', attrs: {}, children: [] };
    const stack = [root];
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k];
      if (tok.t === 'text') {
        if (tok.v.length) stack[stack.length - 1].children.push({ text: tok.v });
        continue;
      }
      if (tok.t === 'start') {
        const auto = AUTO_CLOSE[tok.name];
        if (auto && stack.length > 1 && auto.indexOf(stack[stack.length - 1].tag) !== -1) stack.pop();
        const node = { tag: tok.name, attrs: tok.attrs, children: [] };
        stack[stack.length - 1].children.push(node);
        if (!tok.selfClose && !VOID_ELEMENTS.has(tok.name)) stack.push(node);
        continue;
      }
      if (tok.t === 'end') {
        let idx = -1;
        for (let s = stack.length - 1; s >= 1; s--) {
          if (stack[s].tag === tok.name) { idx = s; break; }
        }
        if (idx !== -1) stack.length = idx;
        continue;
      }
    }
    return root;
  }

  function extractFragment(html) {
    const startMarker = '<!--StartFragment-->';
    const endMarker = '<!--EndFragment-->';
    const s = html.indexOf(startMarker);
    const e = html.indexOf(endMarker);
    if (s !== -1 && e !== -1 && e > s) return html.slice(s + startMarker.length, e);
    return html;
  }

  // ---- inline helpers ------------------------------------------------------------------------

  function styleMap(styleAttr) {
    const map = {};
    if (!styleAttr) return map;
    const parts = styleAttr.split(';');
    for (let i = 0; i < parts.length; i++) {
      const idx = parts[i].indexOf(':');
      if (idx === -1) continue;
      const k = parts[i].slice(0, idx).trim().toLowerCase();
      const v = parts[i].slice(idx + 1).trim().toLowerCase();
      if (k) map[k] = v;
    }
    return map;
  }

  function isTransparentBold(node) {
    const fw = styleMap(node.attrs.style)['font-weight'];
    return fw === 'normal' || fw === '400';
  }

  // A no-break space (&nbsp;, &#160;, or the character itself) is an ordinary space in the note: it looks like one, and a search for a
  // space or a replacement of one would otherwise skip it.
  function collapseWs(s) {
    return s.replace(/[ \t\r\n\f\xa0]+/g, ' ');
  }

  // A bare web address in the text is left exactly as it is: escaping its `_` (and `*`, `[`) made it a different address, and a
  // Ctrl+click on the pasted note opened a cut one (https://example.com/a\_b\_c). An underscore between two letters or digits
  // (snake_case) is no emphasis mark in Markdown and stays too.
  const BARE_URL = /((?:https?|ftp|file):\/\/[^\s<>"'`\])]+)/gi;

  function escapeMarks(part) {
    return part.replace(/[`*[_]/g, (ch, at, whole) => {
      if (ch === '_' && at > 0 && /[A-Za-z0-9]/.test(whole[at - 1]) && /[A-Za-z0-9]/.test(whole[at + 1] || '')) return ch;
      return '\\' + ch;
    });
  }

  function escapeInline(text) {
    // split() with a capture group: the odd parts are the addresses
    return text.split(BARE_URL).map((part, i) => (i % 2 ? part : escapeMarks(part))).join('');
  }

  function escapeLineStarts(text) {
    return text.split('\n').map((line) => {
      if (/^#{1,6}(?=\s|$)/.test(line)) return '\\' + line;
      if (/^[-+](?=\s|$)/.test(line)) return '\\' + line;
      if (line[0] === '>') return '\\' + line;
      const m = /^(\d+)\.(?=\s|$)/.exec(line);
      if (m) return m[1] + '\\.' + line.slice(m[0].length);
      return line;
    }).join('\n');
  }

  function getRawText(node) {
    if (node.text !== undefined) return node.text;
    if (SKIP_TAGS.has(node.tag)) return '';
    if (node.tag === 'br') return '\n';
    const out = [];
    for (let i = 0; i < node.children.length; i++) out.push(getRawText(node.children[i]));
    return out.join('');
  }

  function backtickFence(raw) {
    let maxRun = 0;
    let run = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '`') { run++; if (run > maxRun) maxRun = run; } else run = 0;
    }
    return maxRun;
  }

  function renderInlineCode(node) {
    const raw = getRawText(node);
    const run = backtickFence(raw);
    const fence = '`'.repeat(Math.max(1, run + 1));
    const pad = run > 0 || raw === '' ? ' ' : '';
    return fence + pad + raw + pad + fence;
  }

  function renderLink(node) {
    const href = node.attrs.href;
    const inner = renderInlineList(node.children).trim();
    if (!href) return inner;
    const lower = href.trim().toLowerCase();
    if (lower.indexOf('javascript:') === 0 || lower.indexOf('data:') === 0) return inner;
    const text = inner || href;
    const title = node.attrs.title;
    if (title) return '[' + text + '](' + href + ' "' + title + '")';
    return '[' + text + '](' + href + ')';
  }

  function renderImage(node) {
    const src = node.attrs.src || '';
    if (!src || src.trim().toLowerCase().indexOf('data:') === 0) return '';
    const alt = (node.attrs.alt || '').replace(/\]/g, '\\]');
    return '![' + alt + '](' + src + ')';
  }

  function renderInline(node) {
    if (node.text !== undefined) return escapeInline(collapseWs(node.text));
    const tag = node.tag;
    if (SKIP_TAGS.has(tag)) return '';
    switch (tag) {
      case 'br': return '  \n';
      case 'strong':
      case 'b': {
        if (isTransparentBold(node)) return renderInlineList(node.children);
        const inner = renderInlineList(node.children);
        return inner.trim() ? '**' + inner + '**' : inner;
      }
      case 'em':
      case 'i': {
        const inner = renderInlineList(node.children);
        return inner.trim() ? '*' + inner + '*' : inner;
      }
      case 'del':
      case 's':
      case 'strike': {
        const inner = renderInlineList(node.children);
        return inner.trim() ? '~~' + inner + '~~' : inner;
      }
      case 'code':
        return renderInlineCode(node);
      case 'a':
        return renderLink(node);
      case 'img':
        return renderImage(node);
      case 'span': {
        const style = styleMap(node.attrs.style);
        const fw = style['font-weight'];
        const fs = style['font-style'];
        const inner = renderInlineList(node.children);
        if (!inner.trim()) return inner;
        const bold = fw === '700' || fw === 'bold' || fw === 'bolder';
        const italic = fs === 'italic';
        if (bold && italic) return '***' + inner + '***';
        if (bold) return '**' + inner + '**';
        if (italic) return '*' + inner + '*';
        return inner;
      }
      case 'input':
        if ((node.attrs.type || '').toLowerCase() === 'checkbox') return ('checked' in node.attrs) ? '[x]' : '[ ]';
        return '';
      default: {
        if (BLOCK_RENDERERS[tag] || TRANSPARENT_BLOCK.has(tag)) {
          const rendered = BLOCK_RENDERERS[tag]
            ? BLOCK_RENDERERS[tag](node)
            : renderChildrenAsBlocks(node.children).join('\n\n');
          return rendered ? '\n\n' + rendered + '\n\n' : '';
        }
        return renderInlineList(node.children || []);
      }
    }
  }

  function renderInlineList(nodes) {
    const parts = [];
    for (let i = 0; i < nodes.length; i++) parts.push(renderInline(nodes[i]));
    return parts.join('');
  }

  function paragraphText(nodes) {
    const raw = renderInlineList(nodes).trim();
    if (!raw) return '';
    return escapeLineStarts(raw);
  }

  // ---- block renderers -----------------------------------------------------------------------

  function heading(level) {
    return (node) => {
      const text = renderInlineList(node.children).trim().replace(/\s*\n+\s*/g, ' ');
      if (!text) return '';
      return '#'.repeat(level) + ' ' + text;
    };
  }

  function renderPre(node) {
    let codeNode = null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].tag === 'code') { codeNode = node.children[i]; break; }
    }
    let lang = '';
    if (codeNode) {
      const cls = codeNode.attrs.class || '';
      const m = /(?:^|\s)language-([\w-]+)/.exec(cls);
      if (m) lang = m[1];
    }
    let raw = getRawText(codeNode || node);
    raw = raw.replace(/\n$/, '');
    const fenceLen = Math.max(3, backtickFence(raw) + 1);
    const fence = '`'.repeat(fenceLen);
    return fence + lang + '\n' + raw + '\n' + fence;
  }

  function renderBlockquote(node) {
    const inner = renderChildrenAsBlocks(node.children).join('\n\n');
    if (!inner) return '';
    return inner.split('\n').map((line) => (line.length ? '> ' + line : '>')).join('\n');
  }

  function renderList(ordered) {
    return (node) => {
      let idx = parseInt(node.attrs.start, 10);
      if (isNaN(idx)) idx = 1;
      const lines = [];
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.tag !== 'li') continue;
        const marker = ordered ? (idx++ + '. ') : '- ';
        let liChildren = child.children;
        let firstIdx = 0;
        while (firstIdx < liChildren.length && liChildren[firstIdx].text !== undefined && !liChildren[firstIdx].text.trim()) firstIdx++;
        const first = liChildren[firstIdx];
        let checkboxPrefix = '';
        if (first && first.tag === 'input' && (first.attrs.type || '').toLowerCase() === 'checkbox') {
          checkboxPrefix = ('checked' in first.attrs) ? '[x] ' : '[ ] ';
          liChildren = liChildren.slice(0, firstIdx).concat(liChildren.slice(firstIdx + 1));
        }
        let text = renderChildrenAsBlocks(liChildren).join('\n\n');
        text = checkboxPrefix + text;
        const textLines = text.split('\n');
        const out = [marker + (textLines[0] || '')];
        for (let l = 1; l < textLines.length; l++) out.push(textLines[l].length ? '    ' + textLines[l] : '');
        lines.push(out.join('\n'));
      }
      return lines.join('\n');
    };
  }

  function tableCellsOf(row) {
    return row.children.filter((c) => c.tag === 'td' || c.tag === 'th');
  }

  // > 0 while the text of a table cell is being made: a table met then is markup used for layout, and Markdown has no table inside
  // a cell (the rows and the separator line of a Markdown table came out as escaped text there).
  let cellDepth = 0;

  function tableCellText(cell) {
    cellDepth++;
    let t;
    try {
      t = renderInlineList(cell.children).trim();
    } finally {
      cellDepth--;
    }
    return t.replace(/\|/g, '\\|').replace(/[ \t]*\r?\n[ \t]*/g, '<br>');
  }

  // A table inside a table cell, read as the words of its cells in order ("in1 in2"); the outer cell escapes them.
  function flattenTable(node) {
    const words = [];
    (function walk(n) {
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (c.tag === 'td' || c.tag === 'th') {
          const t = renderInlineList(c.children).trim();
          if (t) words.push(t);
        } else if (c.children) {
          walk(c);
        }
      }
    })(node);
    return words.join(' ');
  }

  // A row's cells laid on the grid of the table: a cell with colspan="2" takes two columns (its text in the first, the other empty)
  // and one with rowspan="2" keeps its column in the row below, so the following cells stay under their own headings. `covered[col]`
  // counts the rows a rowspan from above still occupies in that column. A slot with no cell is null.
  function tableRowSlots(row, covered) {
    const slots = [];
    const skipCovered = () => {
      while (covered[slots.length] > 0) {
        covered[slots.length]--;
        slots.push(null);
      }
    };
    const span = (cell, name) => Math.min(Math.max(parseInt(cell.attrs[name], 10) || 1, 1), 50); // (50: a bogus colspan="9999" is no table)
    const cells = tableCellsOf(row);
    for (let i = 0; i < cells.length; i++) {
      skipCovered();
      const colspan = span(cells[i], 'colspan');
      const rowspan = span(cells[i], 'rowspan');
      for (let k = 0; k < colspan; k++) {
        if (rowspan > 1) covered[slots.length] = rowspan - 1;
        slots.push(k === 0 ? cells[i] : null);
      }
    }
    skipCovered();
    return slots;
  }

  function tableAlignOf(cell) {
    let align = (cell.attrs.align || '').toLowerCase();
    if (align !== 'left' && align !== 'right' && align !== 'center') {
      const m = /text-align\s*:\s*(left|right|center)/i.exec(cell.attrs.style || '');
      align = m ? m[1].toLowerCase() : '';
    }
    return align;
  }

  function renderTable(node) {
    if (cellDepth > 0) return flattenTable(node);
    const theadRows = [];
    const bodyRows = [];
    function collect(container, into) {
      for (let i = 0; i < container.children.length; i++) {
        const c = container.children[i];
        if (c.tag === 'tr') into.push(c);
        else if (c.tag === 'tbody' || c.tag === 'tfoot') collect(c, into);
      }
    }
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if (c.tag === 'thead') collect(c, theadRows);
      else if (c.tag === 'tbody' || c.tag === 'tfoot') collect(c, bodyRows);
      else if (c.tag === 'tr') bodyRows.push(c);
    }
    let headerRow = null;
    if (theadRows.length) {
      headerRow = theadRows[0];
      for (let i = 1; i < theadRows.length; i++) bodyRows.unshift(theadRows[i]);
    } else if (bodyRows.length) {
      headerRow = bodyRows.shift();
    }

    const covered = [];
    const headerSlots = headerRow ? tableRowSlots(headerRow, covered) : [];
    let headerTexts = headerSlots.map((c) => (c ? tableCellText(c) : ''));
    let aligns = headerSlots.map((c) => (c ? tableAlignOf(c) : ''));
    const dataRows = bodyRows.map((r) => tableRowSlots(r, covered).map((c) => (c ? tableCellText(c) : '')));

    let cols = headerTexts.length;
    for (let i = 0; i < dataRows.length; i++) cols = Math.max(cols, dataRows[i].length);
    if (cols === 0) return '';
    while (headerTexts.length < cols) { headerTexts.push(''); aligns.push(''); }

    const sepCell = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
    const lines = [];
    lines.push('| ' + headerTexts.join(' | ') + ' |');
    lines.push('| ' + aligns.map(sepCell).join(' | ') + ' |');
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i].slice();
      while (row.length < cols) row.push('');
      lines.push('| ' + row.join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  const BLOCK_RENDERERS = {
    h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6),
    p: (node) => paragraphText(node.children),
    hr: () => '---',
    pre: renderPre,
    blockquote: renderBlockquote,
    ul: renderList(false),
    ol: renderList(true),
    table: renderTable,
    li: (node) => {
      const text = renderChildrenAsBlocks(node.children).join('\n\n');
      return text ? '- ' + text : '';
    }
  };

  function renderChildrenAsBlocks(children) {
    const blocks = [];
    let inlineBuf = [];
    const flush = () => {
      if (inlineBuf.length) {
        const text = paragraphText(inlineBuf);
        if (text) blocks.push(text);
        inlineBuf = [];
      }
    };
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.text !== undefined) { inlineBuf.push(child); continue; }
      const tag = child.tag;
      if (SKIP_TAGS.has(tag)) continue;
      if (TRANSPARENT_BLOCK.has(tag)) {
        flush();
        const sub = renderChildrenAsBlocks(child.children);
        for (let s = 0; s < sub.length; s++) blocks.push(sub[s]);
        continue;
      }
      if (BLOCK_RENDERERS[tag]) {
        flush();
        const b = BLOCK_RENDERERS[tag](child);
        if (b) blocks.push(b);
        continue;
      }
      inlineBuf.push(child);
    }
    flush();
    return blocks;
  }

  function convert(html) {
    if (!html) return '';
    const fragment = extractFragment(html);
    const tokens = tokenize(fragment);
    const root = buildTree(tokens);
    const blocks = renderChildrenAsBlocks(root.children);
    let md = blocks.join('\n\n');
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return md;
  }

  // True when clipboard HTML carries structure worth turning into Markdown: a table, heading, list, link, image, quote, rule or
  // emphasis. HTML that is only paragraphs, line breaks and styled spans (what an editor or a terminal puts there for plain
  // code and logs) has none: pasting it as plain text loses nothing. One copied spreadsheet cell is a table of one cell, and
  // that is just text too.
  const STRUCTURE_SRC = '<(table|h[1-6]|ul|ol|li|blockquote|hr|img|strong|em|del|s|strike|b|i|a)(?=[\\s>/])';

  function hasStructure(html) {
    if (!html) return false;
    const s = String(html);
    const cells = (s.match(/<t[dh](?=[\s>/])/gi) || []).length;
    const re = new RegExp(STRUCTURE_SRC, 'gi');
    let m;
    while ((m = re.exec(s))) {
      if (m[1].toLowerCase() === 'table' && cells <= 1) continue;
      return true;
    }
    return false;
  }

  // Markdown that came out of a paste is put in where the caret is, and a block glued to the words around it stops being one:
  // "Sales figures| A | B |", "| 1 | 2 || A | B |", "text## Heading", "![image](a)![image](b)". A block is a table, heading, list,
  // quote, fence, rule or a picture on its own line. separateBlock returns `text` with the line breaks that make it a paragraph of its
  // own: a blank line before it when something comes before it, and a blank line after it when something follows. `before` / `after` are
  // the note's text on each side of the caret. A caret that already sits on an empty line gets nothing added, and text that is just
  // running words (no block marker on its first line) is returned as it is, so a pasted phrase still lands inside a sentence.
  const BLOCK_FIRST_LINE = [
    /^\|.*\|[ \t]*$/, // table row
    /^#{1,6}[ \t]/, // heading
    /^[-*+][ \t]/, // bullet list
    /^\d{1,9}[.)][ \t]/, // numbered list
    /^>/, // quote
    /^(?:`{3,}|~{3,})/, // fence
    /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, // rule
    /^!\[[^\]]*\]\([^)]*\)[ \t]*$/ // a picture on its own
  ];

  function separateBlock(text, before, after) {
    text = String(text == null ? '' : text);
    const firstLine = text.split('\n', 1)[0];
    if (!BLOCK_FIRST_LINE.some((re) => re.test(firstLine))) return text;
    before = String(before == null ? '' : before);
    after = String(after == null ? '' : after);
    const breaksAt = (s, fromEnd) => {
      let n = 0;
      for (let i = 0; i < s.length && n < 2; i++) {
        const c = s.charAt(fromEnd ? s.length - 1 - i : i);
        if (c !== '\n') break;
        n++;
      }
      return n;
    };
    const lead = before.trim() === '' ? '' : '\n'.repeat(2 - breaksAt(before, true));
    const trail = after.trim() === '' ? '' : '\n'.repeat(2 - breaksAt(after, false));
    return lead + text + trail;
  }

  const HtmlToMd = { convert, hasStructure, separateBlock };

  global.HtmlToMd = HtmlToMd;
  if (typeof module !== 'undefined') module.exports = HtmlToMd;
})(typeof window !== 'undefined' ? window : globalThis);
