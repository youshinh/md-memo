// MD-Memo file anchors: Ctrl/Cmd+Click open, Alt+Click reveal, image hover preview and
// drag & drop of files into the editor as markdown links. Spec: 機能 4.
// Links in the editor are also marked: a thin underline under every clickable link (dotted for a
// local image, which previews on hover), drawn by a transparent copy of the note behind the
// textarea, and a hint while the pointer rests on one.
// Uses window.MdMemoBridge / window.backend only; never touches app.js internals directly.
(function (global) {
  'use strict';

  const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
  const MAX_HOVER_LINKS = 200;
  const HOVER_DEBOUNCE_MS = 300;

  // Link marks (underlines). The layer holds a full copy of the note, and laying it out costs about
  // 1 ms per 5,000 characters (measured: 12 ms at 60,000, 30 ms at 150,000), so it is only built for
  // notes up to this size (bigger ones stay unmarked; Ctrl+Click still works) and only when the note
  // has a link at all.
  const MARK_MAX_CHARS = 100000;
  const MAX_MARKS = 3000;
  const MARK_DEBOUNCE_MS = 100;
  const MARK_MAX_WAIT_MS = 400;

  const I18N_FALLBACK = {
    ja: {
      fanchorOpenFailed: 'ファイルを開けませんでした: {error}',
      fanchorRevealFailed: 'ファイルの場所を開けませんでした: {error}',
      fanchorImportFailed: '{name} の取り込みに失敗しました: {error}',
      fanchorImportUnavailable: 'ファイルの取り込み機能を利用できません',
      fanchorFileTooLarge: '{name} は大きすぎます（25MB超）',
      fanchorDropLabel: 'リンクとして挿入',
      fanchorHintLocal: '{mod}+クリックで開く / Alt+クリックで場所を表示',
      fanchorHintRemote: '{mod}+クリックでブラウザで開く'
    },
    en: {
      fanchorOpenFailed: 'Could not open the file: {error}',
      fanchorRevealFailed: 'Could not reveal the file: {error}',
      fanchorImportFailed: 'Failed to import {name}: {error}',
      fanchorImportUnavailable: 'File import is unavailable',
      fanchorFileTooLarge: '{name} is too large (over 25MB)',
      fanchorDropLabel: 'Insert as link',
      fanchorHintLocal: '{mod}+click to open / Alt+click to show its location',
      fanchorHintRemote: '{mod}+click to open in the browser'
    }
  };

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // Bare (non-angle-wrapped) targets never contain a literal space or ')' - those cases must be
  // percent-encoded or wrapped in <...>, matching the spec's own guidance.
  const LINK_RE = /(!)?\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^\s()]*))(?:\s+"[^"]*")?\s*\)/g;

  function isRemoteScheme(target) {
    return /^(https?:|mailto:)/i.test(target);
  }

  // Bare web addresses in running text. ASCII only: a URL written right before Japanese text
  // ("https://example.com/aです") must not swallow the text after it.
  const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g;
  const URL_TAIL_RE = /[.,;:!?]+$/;

  // Something with a scheme other than http(s)/file (mailto:, javascript:, ...) has nothing to open.
  // A Windows drive path ("C:\x") has a one-letter "scheme" and is a file.
  function isOpenableTarget(target) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(target);
    if (!m) return true;
    const scheme = m[1].toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'file';
  }

  // Every link in `text` that Ctrl/Cmd+Click can open, in order: Markdown links and images, then the
  // bare http(s) addresses that are not already inside one of those. Each is
  //   { start, end, label, target, isImage, remote }
  // where remote means an http(s) address (opened in the browser); everything else is a local file.
  function scanLinks(text, limit) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    const cap = limit > 0 ? limit : MAX_MARKS;
    if (text.indexOf('](') !== -1) {
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(text))) {
        const target = m[3] !== undefined ? m[3] : m[4];
        if (!target || !isOpenableTarget(target)) continue;
        out.push({
          start: m.index, end: m.index + m[0].length, label: m[2], target: target,
          isImage: !!m[1], remote: /^https?:/i.test(target)
        });
        if (out.length >= cap) return out;
      }
    }
    if (text.indexOf('://') !== -1) {
      const md = out.slice();
      let j = 0;
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(text))) {
        const url = m[0].replace(URL_TAIL_RE, '');
        if (url.length <= 8) continue; // just "https://"
        const start = m.index;
        const end = start + url.length;
        while (j < md.length && md[j].end <= start) j++;
        if (j < md.length && md[j].start < end) continue; // part of a Markdown link
        out.push({ start: start, end: end, label: '', target: url, isImage: false, remote: true });
        if (out.length >= cap) break;
      }
      if (md.length && out.length > md.length) out.sort((a, b) => a.start - b.start);
    }
    return out;
  }

  // Finds the link under `caret`, restricted to its own line (a textarea has no DOM to inspect, so
  // caret position + surrounding text is all we have). null when the caret is not on an openable link.
  function findLinkAt(text, caret) {
    if (typeof text !== 'string' || typeof caret !== 'number') return null;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = text.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.indexOf('](') === -1 && line.indexOf('://') === -1) return null;

    const links = scanLinks(line);
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      const start = lineStart + l.start;
      const end = lineStart + l.end;
      if (caret < start || caret > end) continue;
      return { isImage: l.isImage, label: l.label, target: l.target, start: start, end: end, remote: l.remote };
    }
    return null;
  }

  // Splits `text` into the pieces the mark layer is built from: plain runs (link: -1) and the links
  // themselves (link: index into `links`). `links` must be ordered and non-overlapping, as scanLinks
  // returns them. Empty pieces are left out.
  function segmentText(text, links) {
    const out = [];
    let pos = 0;
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (l.start < pos) continue;
      if (l.start > pos) out.push({ text: text.slice(pos, l.start), link: -1 });
      out.push({ text: text.slice(l.start, l.end), link: i });
      pos = l.end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos), link: -1 });
    return out;
  }

  // All local (non-http/mailto) image links in the whole note, for the hover-preview scan.
  function collectImageLinks(text) {
    const out = [];
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(text))) {
      if (!m[1]) continue; // not an image
      const target = m[3] !== undefined ? m[3] : m[4];
      if (!target || isRemoteScheme(target)) continue;
      out.push({ start: m.index, end: m.index + m[0].length, target: target });
      if (out.length > MAX_HOVER_LINKS) break;
    }
    return out;
  }

  // Resolves a link target to a URL the webview can actually load as an <img src>, reusing the
  // exact same /api/image local-file route app.js's renderPreview() uses for note preview images.
  function resolveLocalImageSrc(target, noteDir) {
    let p = target;
    if (/^file:\/\/\//i.test(p)) p = decodeURIComponent(p.slice(8));
    else if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.slice(7));
    else { try { p = decodeURIComponent(p); } catch (e) { /* leave as-is */ } }
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(p);
    const isUnixAbs = p.startsWith('/');
    if (!isWinAbs && !isUnixAbs && noteDir) {
      p = String(noteDir).replace(/[\\/]+$/, '') + '/' + p;
    }
    return '/api/image?path=' + encodeURIComponent(p);
  }

  // Converts a local filesystem path (Windows or POSIX) to a well-formed file:// URL, percent-
  // encoding each path segment so spaces / Japanese / '#' / '%' round-trip correctly.
  function pathToFileUrl(p) {
    if (typeof p !== 'string' || !p) return '';
    const norm = p.replace(/\\/g, '/');
    const winMatch = /^([a-zA-Z]):\/(.*)$/.exec(norm);
    if (winMatch) {
      const rest = winMatch[2].split('/').map(encodeURIComponent).join('/');
      return `file:///${winMatch[1]}:/${rest}`;
    }
    const abs = norm.startsWith('/') ? norm : '/' + norm;
    const encoded = abs.split('/').map(encodeURIComponent).join('/');
    return 'file://' + encoded;
  }

  function escapeLabel(name) {
    return String(name || '').replace(/[[\]]/g, (c) => (c === '[' ? '\\[' : '\\]'));
  }

  function isImageName(name, mimeType) {
    if (mimeType && /^image\//.test(mimeType)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(name || ''));
  }

  function hasFiles(dataTransfer) {
    if (!dataTransfer) return false;
    if (dataTransfer.types) {
      for (let i = 0; i < dataTransfer.types.length; i++) {
        if (dataTransfer.types[i] === 'Files') return true;
      }
      return false;
    }
    return !!(dataTransfer.files && dataTransfer.files.length);
  }

  // ---- i18n / toast ----------------------------------------------------------------------------

  function getUILang() {
    try {
      if (global.document && global.document.documentElement && global.document.documentElement.lang === 'en') return 'en';
    } catch (e) { /* ignore */ }
    return 'ja';
  }

  function tr(bridge, key, params) {
    try {
      if (bridge && typeof bridge.t === 'function') {
        const v = bridge.t(key, params);
        if (v && v !== key) return v;
      }
    } catch (e) { /* ignore, fall back below */ }
    const lang = getUILang();
    let text = (I18N_FALLBACK[lang] && I18N_FALLBACK[lang][key]) || I18N_FALLBACK.ja[key] || key;
    if (params) {
      Object.keys(params).forEach((k) => { text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]); });
    }
    return text;
  }

  function toast(bridge, key, params) {
    try {
      const text = tr(bridge, key, params);
      if (bridge && typeof bridge.showMessage === 'function') bridge.showMessage(text, 4000);
    } catch (e) { /* ignore */ }
  }

  // ---- click: Ctrl/Cmd+Click open, Alt+Click reveal --------------------------------------------

  async function openOrReveal(target, wantOpen, bridge) {
    try {
      const noteDir = bridge.getNoteDir ? await bridge.getNoteDir() : '';
      const backend = global.backend;
      if (wantOpen) {
        if (backend && typeof backend.openPath === 'function') await backend.openPath(target, noteDir);
      } else if (backend && typeof backend.revealPath === 'function') {
        await backend.revealPath(target, noteDir);
      }
    } catch (e) {
      toast(bridge, wantOpen ? 'fanchorOpenFailed' : 'fanchorRevealFailed', { error: String((e && e.message) || e) });
    }
  }

  function handleEditorClick(editor, event) {
    if (!event || (!event.ctrlKey && !event.metaKey && !event.altKey)) return false; // hot path bail
    if (!editor || typeof editor.value !== 'string' || typeof editor.selectionStart !== 'number') return false;
    const link = findLinkAt(editor.value, editor.selectionStart);
    if (!link) return false;
    const bridge = global.MdMemoBridge;
    if (!bridge) return false;
    const wantOpen = !!(event.ctrlKey || event.metaKey);
    const wantReveal = !wantOpen && !!event.altKey;
    if (!wantOpen && !wantReveal) return false;
    if (link.remote) {
      // A web address opens in the browser; there is no file to reveal.
      if (!wantOpen) return false;
      openInBrowser(link.target, bridge);
      return true;
    }
    openOrReveal(link.target, wantOpen, bridge);
    return true;
  }

  function openInBrowser(url, bridge) {
    try {
      const backend = global.backend;
      if (backend && typeof backend.openExternal === 'function') {
        Promise.resolve(backend.openExternal(url)).catch((e) => {
          toast(bridge, 'fanchorOpenFailed', { error: String((e && e.message) || e) });
        });
      }
    } catch (e) {
      toast(bridge, 'fanchorOpenFailed', { error: String((e && e.message) || e) });
    }
  }

  // ---- hover preview --------------------------------------------------------------------------

  let hoverTimer = null;
  let tooltipEl = null;
  let hoverListenersBound = false;

  function ensureStyles() {
    if (global.document.getElementById('fanchor-styles')) return;
    const style = global.document.createElement('style');
    style.id = 'fanchor-styles';
    style.textContent =
      '.fanchor-tooltip{position:fixed;z-index:9999;display:none;padding:4px;border-radius:6px;' +
      'background:var(--bg-modal,#252526);border:1px solid var(--border-color,#3e3e42);' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;}' +
      '.fanchor-tooltip img{display:block;max-width:240px;max-height:180px;object-fit:contain;}' +
      '.fanchor-hint{padding:2px 6px;font-size:12px;line-height:1.5;white-space:nowrap;' +
      'color:var(--text-main,#d4d4d4);}' +
      '.fanchor-tooltip img+.fanchor-hint{padding-top:6px;}' +
      // The mark layer: a transparent copy of the note behind the textarea (which is see-through),
      // laid out like the textarea so each link lines up with the text above it. Only the underline
      // of a link is visible. It copies the textarea's font/padding at update time (see copyMetrics).
      '.fanchor-layer{position:absolute;top:0;left:0;right:0;bottom:0;box-sizing:border-box;' +
      'pointer-events:none;overflow:hidden;user-select:none;-webkit-user-select:none;' +
      'color:transparent;white-space:pre-wrap;word-wrap:break-word;z-index:1;}' +
      // The theme's accent, lightened toward the text colour: the charcoal theme's accent is a dark
      // grey (2.6:1 on the editor background), which alone would be a barely visible line.
      '.fanchor-layer .lnk{text-decoration:underline;' +
      'text-decoration-color:var(--accent-hover,var(--accent-color,#4ec9b0));' +
      'text-decoration-color:color-mix(in srgb,var(--accent-hover,var(--accent-color,#4ec9b0)) 65%,var(--text-main,#d4d4d4));' +
      'text-decoration-thickness:1px;text-underline-offset:3px;}' +
      '.fanchor-layer .lnk-img{text-decoration-style:dotted;text-decoration-thickness:2px;}' +
      '.fanchor-layer .lnk-hot{text-decoration-thickness:2px;}' +
      '.fanchor-layer .lnk-img.lnk-hot{text-decoration-style:solid;}' +
      '.fanchor-drop-target{outline:2px solid var(--accent-color,#556b2f);outline-offset:-2px;' +
      'animation:fanchor-pulse 1.1s ease-in-out infinite;}' +
      '@keyframes fanchor-pulse{0%,100%{outline-color:var(--accent-color,#556b2f);}' +
      '50%{outline-color:var(--accent-hover,#6b843d);}}' +
      '@media (prefers-reduced-motion:reduce){.fanchor-drop-target{animation:none;}}' +
      '.fanchor-drop-badge{position:fixed;z-index:9999;display:flex;align-items:center;gap:6px;' +
      'padding:4px 10px;border-radius:999px;font-size:12px;pointer-events:none;' +
      'background:var(--bg-modal,#252526);color:var(--text-main,#d4d4d4);' +
      'border:1px solid var(--border-color,#3e3e42);}';
    global.document.head.appendChild(style);
  }

  function hideTooltip() {
    clearTimeout(hoverTimer);
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  // The tooltip shows an image preview (src, may be empty) and/or a one-line hint on how to open.
  function showTooltip(clientX, clientY, src, hint) {
    ensureStyles();
    if (!tooltipEl) {
      tooltipEl = global.document.createElement('div');
      tooltipEl.className = 'fanchor-tooltip';
      tooltipEl.appendChild(global.document.createElement('img'));
      const hintEl = global.document.createElement('div');
      hintEl.className = 'fanchor-hint';
      tooltipEl.appendChild(hintEl);
      global.document.body.appendChild(tooltipEl);
    }
    const img = tooltipEl.querySelector ? tooltipEl.querySelector('img') : tooltipEl.children[0];
    if (img) {
      if (src) img.src = src;
      img.style.display = src ? 'block' : 'none';
    }
    const hintEl = tooltipEl.querySelector ? tooltipEl.querySelector('.fanchor-hint') : tooltipEl.children[1];
    if (hintEl) {
      hintEl.textContent = hint || '';
      hintEl.style.display = hint ? 'block' : 'none';
    }
    tooltipEl.style.left = (clientX + 16) + 'px';
    tooltipEl.style.top = (clientY + 16) + 'px';
    tooltipEl.style.display = 'block';
  }

  function lineOf(text, index) {
    let n = 0;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  // The image-only preview for a note that has no mark layer (a huge note): it finds the image link
  // from character coordinates, which are estimates there.
  async function checkHoverLegacy(editor, clientX, clientY) {
    const bridge = global.MdMemoBridge;
    if (!bridge || typeof global.getCharPixelCoords !== 'function') return;
    const text = editor.value || '';
    if (text.indexOf('](') === -1) return;
    const links = collectImageLinks(text);
    if (links.length === 0 || links.length > MAX_HOVER_LINKS) return;

    let lineHeight = 22;
    try {
      const parsed = parseFloat(global.getComputedStyle(editor).lineHeight);
      if (!isNaN(parsed) && parsed > 0) lineHeight = parsed;
    } catch (e) { /* keep default */ }

    const scrollTop = editor.scrollTop || 0;
    const firstVisibleLine = Math.max(0, Math.floor(scrollTop / lineHeight) - 1);
    const lastVisibleLine = Math.ceil((scrollTop + (editor.clientHeight || 0)) / lineHeight) + 1;

    let rect;
    try { rect = editor.getBoundingClientRect(); } catch (e) { return; }
    const localX = clientX - rect.left + (editor.scrollLeft || 0);
    const localY = clientY - rect.top + scrollTop;

    for (const link of links) {
      const ln = lineOf(text, link.start);
      if (ln < firstVisibleLine || ln > lastVisibleLine) continue;
      let coords;
      try { coords = global.getCharPixelCoords(link.start, editor); } catch (e) { continue; }
      if (!coords) continue;
      const approxWidth = Math.max(20, (link.end - link.start) * 7);
      const withinY = localY >= coords.top && localY <= coords.top + lineHeight;
      const withinX = localX >= coords.left && localX <= coords.left + approxWidth;
      if (withinY && withinX) {
        const noteDir = bridge.getNoteDir ? await bridge.getNoteDir() : '';
        showTooltip(clientX, clientY, resolveLocalImageSrc(link.target, noteDir));
        return;
      }
    }
    hideTooltip();
  }

  // ---- link marks -------------------------------------------------------------------------------

  // One mark layer per editor, made the first time its note has a link and kept (emptied) after.
  //   { el, inner, links, spans, text, hot }
  // el is the positioned box behind the textarea; inner is the block that is translated to follow the
  // textarea's scroll (a transform has no scroll range to clamp against, like the ghost overlay's).
  const layers = new WeakMap();

  function modKey() {
    try {
      if (global.navigator && /Mac|iPhone|iPad/i.test(global.navigator.platform || '')) return 'Cmd';
    } catch (e) { /* ignore */ }
    return 'Ctrl';
  }

  function makeLayer(editor) {
    const parent = editor.parentElement;
    if (!parent || !global.document.createElement) return null;
    ensureStyles();
    const el = global.document.createElement('div');
    el.className = 'fanchor-layer';
    el.setAttribute('aria-hidden', 'true');
    const inner = global.document.createElement('div');
    el.appendChild(inner);
    parent.insertBefore(el, editor);
    const layer = { el: el, inner: inner, links: [], spans: [], text: null, hot: null };
    layers.set(editor, layer);
    // The textarea's scrollbar comes and goes (a note growing past the window, a resize, a split pane
    // being dragged), and the layer has to give up exactly that much width to keep wrapping like it.
    if (typeof global.ResizeObserver === 'function') {
      try {
        new global.ResizeObserver(() => { if (layer.text !== null) syncLayerScroll(editor, layer); }).observe(editor);
      } catch (e) { /* the gutter is still refreshed on every scroll and update */ }
    }
    return layer;
  }

  function clearLayer(layer) {
    if (!layer || layer.text === null) return;
    layer.inner.textContent = '';
    layer.links = [];
    layer.spans = [];
    layer.text = null;
    layer.hot = null;
  }

  // The layer must lay out exactly like the textarea, so it takes the textarea's own font and box.
  function copyMetrics(editor, layer) {
    let cs;
    try { cs = global.getComputedStyle(editor); } catch (e) { return; }
    const st = layer.el.style;
    st.fontFamily = cs.fontFamily;
    st.fontSize = cs.fontSize;
    st.fontWeight = cs.fontWeight;
    st.lineHeight = cs.lineHeight;
    st.letterSpacing = cs.letterSpacing;
    st.padding = cs.padding;
    st.tabSize = cs.tabSize;
    st.whiteSpace = cs.whiteSpace;
    st.wordBreak = cs.wordBreak;
    st.overflowWrap = cs.overflowWrap;
  }

  // Follows the textarea's scroll, and reserves the width of its scrollbar (a textarea with a
  // scrollbar wraps that much narrower than a box without one).
  function syncLayerScroll(editor, layer) {
    layer.inner.style.transform = 'translate(' + (-(editor.scrollLeft || 0)) + 'px, ' + (-(editor.scrollTop || 0)) + 'px)';
    const gutter = (editor.offsetWidth || 0) - (editor.clientWidth || 0);
    layer.el.style.right = (gutter > 0 ? gutter : 0) + 'px';
  }

  function updateMarks(editor) {
    if (!editor || typeof editor.value !== 'string' || !global.document) return;
    const text = editor.value;
    let links = [];
    if (text.length <= MARK_MAX_CHARS && (text.indexOf('](') !== -1 || text.indexOf('://') !== -1)) {
      links = scanLinks(text, MAX_MARKS);
    }
    let layer = layers.get(editor);
    if (links.length === 0) {
      clearLayer(layer);
      return;
    }
    if (!layer) layer = makeLayer(editor);
    if (!layer) return;
    copyMetrics(editor, layer);
    if (layer.text !== text) {
      const frag = global.document.createDocumentFragment();
      const spans = [];
      const parts = segmentText(text, links);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.link < 0) {
          frag.appendChild(global.document.createTextNode(part.text));
          continue;
        }
        const link = links[part.link];
        const span = global.document.createElement('span');
        span.className = link.isImage && !link.remote ? 'lnk lnk-img' : 'lnk';
        span.textContent = part.text;
        frag.appendChild(span);
        spans.push({ el: span, link: link });
      }
      layer.inner.textContent = '';
      layer.inner.appendChild(frag);
      layer.links = links;
      layer.spans = spans;
      layer.text = text;
      layer.hot = null;
    }
    syncLayerScroll(editor, layer);
  }

  // Marks are refreshed once typing pauses (or every MARK_MAX_WAIT_MS of continuous typing), not per
  // keystroke: rebuilding the layer means laying out a copy of the note.
  const markTimers = new Map();

  function scheduleMarks(editor) {
    if (!editor) return;
    const now = Date.now();
    let st = markTimers.get(editor);
    if (!st) { st = { timer: null, since: now }; markTimers.set(editor, st); }
    // `since` is when the current burst of changes began: a new burst starts once the last one ran.
    if (st.timer) clearTimeout(st.timer); else st.since = now;
    const wait = Math.max(0, Math.min(MARK_DEBOUNCE_MS, st.since + MARK_MAX_WAIT_MS - now));
    st.timer = setTimeout(() => {
      st.timer = null;
      try { updateMarks(editor); } catch (e) { /* the marks are decoration only */ }
    }, wait);
  }

  // The link under a viewport point, from the geometry of the layer's own spans (exact, wrapped
  // links included). Only spans that intersect the visible part of the note are measured.
  function hitTest(editor, clientX, clientY) {
    const layer = layers.get(editor);
    if (!layer || layer.spans.length === 0) return null;
    const top = editor.scrollTop || 0;
    const bottom = top + (editor.clientHeight || 0);
    for (let i = 0; i < layer.spans.length; i++) {
      const item = layer.spans[i];
      const el = item.el;
      if (el.offsetTop > bottom || el.offsetTop + el.offsetHeight < top) continue;
      const rects = el.getClientRects();
      for (let r = 0; r < rects.length; r++) {
        const rc = rects[r];
        if (clientX >= rc.left && clientX <= rc.right && clientY >= rc.top && clientY <= rc.bottom) return item;
      }
    }
    return null;
  }

  function setHot(editor, item) {
    const layer = layers.get(editor);
    const prev = layer ? layer.hot : null;
    if (prev === item) return;
    if (prev && prev.el.classList) prev.el.classList.remove('lnk-hot');
    if (layer) layer.hot = item;
    if (item && item.el.classList) item.el.classList.add('lnk-hot');
    editor.style.cursor = item ? 'pointer' : '';
  }

  // While Ctrl/Cmd/Alt is held, a link under the pointer thickens and the pointer becomes a hand -
  // the same cue the Ctrl+Click will act on. Alt only acts on files (it reveals them), so a web
  // address does not react to it.
  let hotEditor = null;
  let hotFrame = 0;
  let hotX = 0;
  let hotY = 0;
  let hotAlt = false;
  let hotCtrl = false;

  function clearHot() {
    if (hotEditor) setHot(hotEditor, null);
    hotEditor = null;
  }

  function updateHot() {
    hotFrame = 0;
    const editor = hotEditor;
    if (!editor) return;
    const item = hitTest(editor, hotX, hotY);
    const acts = item && (hotCtrl || (hotAlt && !item.link.remote));
    setHot(editor, acts ? item : null);
  }

  function scheduleHot(editor, event) {
    if (hotEditor && hotEditor !== editor) setHot(hotEditor, null);
    hotEditor = editor;
    hotX = event.clientX;
    hotY = event.clientY;
    hotCtrl = !!(event.ctrlKey || event.metaKey);
    hotAlt = !!event.altKey;
    if (hotFrame) return;
    const raf = global.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    hotFrame = raf(updateHot);
  }

  // Resting the pointer on a link shows how to open it (and, for a local image, the image).
  async function checkHover(editor, clientX, clientY) {
    const layer = layers.get(editor);
    if (!layer || layer.spans.length === 0) return checkHoverLegacy(editor, clientX, clientY);
    const item = hitTest(editor, clientX, clientY);
    if (!item) { hideTooltip(); return; }
    const bridge = global.MdMemoBridge;
    const link = item.link;
    const hint = tr(bridge, link.remote ? 'fanchorHintRemote' : 'fanchorHintLocal', { mod: modKey() });
    let src = '';
    if (link.isImage && !link.remote && bridge) {
      const noteDir = bridge.getNoteDir ? await bridge.getNoteDir() : '';
      src = resolveLocalImageSrc(link.target, noteDir);
    }
    showTooltip(clientX, clientY, src, hint);
  }

  function onMouseMove(event) {
    if (!event || !event.target || event.target.tagName !== 'TEXTAREA') { hideTooltip(); clearHot(); return; }
    const editor = event.target;
    if (event.ctrlKey || event.metaKey || event.altKey) scheduleHot(editor, event);
    else if (hotEditor) clearHot();
    const x = event.clientX;
    const y = event.clientY;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { checkHover(editor, x, y); }, HOVER_DEBOUNCE_MS);
  }

  function onKeyUp(event) {
    if (hotEditor && !(event.ctrlKey || event.metaKey || event.altKey)) clearHot();
  }

  const MARKED_EDITOR_IDS = ['editor', 'editor-secondary'];

  function bindMarkListeners() {
    for (let i = 0; i < MARKED_EDITOR_IDS.length; i++) {
      const editor = global.document.getElementById(MARKED_EDITOR_IDS[i]);
      if (!editor || !editor.addEventListener) continue;
      editor.addEventListener('input', () => scheduleMarks(editor));
      editor.addEventListener('scroll', () => {
        const layer = layers.get(editor);
        if (layer && layer.text !== null) syncLayerScroll(editor, layer);
      });
      scheduleMarks(editor);
    }
  }

  function refreshMarks() {
    for (let i = 0; i < MARKED_EDITOR_IDS.length; i++) {
      const editor = global.document.getElementById(MARKED_EDITOR_IDS[i]);
      if (editor) scheduleMarks(editor);
    }
  }

  function bindHoverListeners() {
    if (hoverListenersBound) return;
    hoverListenersBound = true;
    global.document.addEventListener('mousemove', onMouseMove);
    global.document.addEventListener('mouseleave', hideTooltip, true);
    global.document.addEventListener('scroll', hideTooltip, true);
    global.document.addEventListener('keydown', hideTooltip);
    global.document.addEventListener('keyup', onKeyUp);
    global.document.addEventListener('click', hideTooltip);
    bindMarkListeners();
  }

  // ---- drag & drop ------------------------------------------------------------------------------

  let dropBadgeEl = null;
  let dropTargetEditor = null;

  const DROP_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 17H7a5 5 0 0 1 0-10h2"></path><path d="M15 7h2a5 5 0 0 1 0 10h-2"></path>' +
    '<line x1="8" y1="12" x2="16" y2="12"></line></svg>';

  function showDropBadge(bridge, clientX, clientY) {
    ensureStyles();
    if (!dropBadgeEl) {
      dropBadgeEl = global.document.createElement('div');
      dropBadgeEl.className = 'fanchor-drop-badge';
      global.document.body.appendChild(dropBadgeEl);
    }
    dropBadgeEl.innerHTML = DROP_ICON + '<span>' + tr(bridge, 'fanchorDropLabel') + '</span>';
    dropBadgeEl.style.left = (clientX + 16) + 'px';
    dropBadgeEl.style.top = (clientY + 16) + 'px';
    dropBadgeEl.style.display = 'flex';
  }

  function clearDropFeedback() {
    if (dropTargetEditor && dropTargetEditor.parentElement && dropTargetEditor.parentElement.classList) {
      dropTargetEditor.parentElement.classList.remove('fanchor-drop-target');
    }
    dropTargetEditor = null;
    if (dropBadgeEl) dropBadgeEl.style.display = 'none';
  }

  function handleDragOver(event, editor) {
    if (!event || !editor) return false;
    if (!hasFiles(event.dataTransfer)) return false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const bridge = global.MdMemoBridge;
    const wrapper = editor.parentElement;
    if (wrapper && wrapper.classList) {
      ensureStyles();
      wrapper.classList.add('fanchor-drop-target');
      dropTargetEditor = editor;
    }
    showDropBadge(bridge, event.clientX || 0, event.clientY || 0);
    return true;
  }

  function handleDragLeave(event) {
    clearDropFeedback();
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new global.FileReader();
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.onload = () => {
          const result = String(reader.result || '');
          const idx = result.indexOf(',');
          resolve(idx >= 0 ? result.slice(idx + 1) : result);
        };
        reader.readAsDataURL(file);
      } catch (e) { reject(e); }
    });
  }

  async function insertOneFile(file, noteDir, bridge) {
    const label = escapeLabel(file.name || 'file');
    const image = isImageName(file.name, file.type);
    if (file.path) {
      const url = pathToFileUrl(file.path);
      return (image ? '!' : '') + `[${label}](${url})`;
    }
    if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES) {
      toast(bridge, 'fanchorFileTooLarge', { name: file.name });
      return null;
    }
    const backend = global.backend;
    if (!backend || typeof backend.importAssetFile !== 'function') {
      toast(bridge, 'fanchorImportUnavailable');
      return null;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await backend.importAssetFile(noteDir, file.name, dataBase64);
      const target = (res && (res.relPath || res.fileUrl)) || '';
      if (!target) return null;
      return (image ? '!' : '') + `[${label}](${encodeLinkTarget(target)})`;
    } catch (e) {
      toast(bridge, 'fanchorImportFailed', { name: file.name, error: String((e && e.message) || e) });
      return null;
    }
  }

  async function handleDrop(event, editor) {
    if (!event || !editor) return false;
    if (!hasFiles(event.dataTransfer)) return false;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    clearDropFeedback();

    const bridge = global.MdMemoBridge;
    if (!bridge) return false;
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (files.length === 0) return false;

    const noteDir = bridge.getNoteDir ? await bridge.getNoteDir() : '';
    const lines = [];
    for (const file of files) {
      const line = await insertOneFile(file, noteDir, bridge);
      if (line) lines.push(line);
    }
    if (lines.length === 0) return true;

    bridge.insertTextWithUndo(lines.join('\n') + '\n', editor);
    if (typeof bridge.notifyEdited === 'function') bridge.notifyEdited(editor);
    return true;
  }

  // A raw space or parenthesis would end a Markdown link target early.
  function encodeLinkTarget(target) {
    return String(target || '').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  function init() {
    bindHoverListeners();
  }

  global.FileAnchor = {
    init: init,
    handleEditorClick: handleEditorClick,
    handleDragOver: handleDragOver,
    handleDragLeave: handleDragLeave,
    handleDrop: handleDrop,
    encodeLinkTarget: encodeLinkTarget,
    // Refresh the link underlines of an editor (or of both, without an argument) once typing pauses;
    // app.js calls this wherever it sets a note's text itself, which fires no input event.
    scheduleMarks: function (editor) { if (editor) scheduleMarks(editor); else refreshMarks(); }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findLinkAt: findLinkAt,
      scanLinks: scanLinks,
      segmentText: segmentText,
      encodeLinkTarget: encodeLinkTarget,
      collectImageLinks: collectImageLinks,
      pathToFileUrl: pathToFileUrl,
      resolveLocalImageSrc: resolveLocalImageSrc,
      escapeLabel: escapeLabel,
      isImageName: isImageName,
      hasFiles: hasFiles
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
