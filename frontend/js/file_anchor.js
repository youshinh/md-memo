// MD-Memo file anchors: Ctrl/Cmd+Click open, Alt+Click reveal, image hover preview and
// drag & drop of files into the editor as markdown links. Spec: 機能 4.
// Uses window.MdMemoBridge / window.backend only; never touches app.js internals directly.
(function (global) {
  'use strict';

  const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
  const MAX_HOVER_LINKS = 200;
  const HOVER_DEBOUNCE_MS = 300;

  const I18N_FALLBACK = {
    ja: {
      fanchorOpenFailed: 'ファイルを開けませんでした: {error}',
      fanchorRevealFailed: 'ファイルの場所を開けませんでした: {error}',
      fanchorImportFailed: '{name} の取り込みに失敗しました: {error}',
      fanchorImportUnavailable: 'ファイルの取り込み機能を利用できません',
      fanchorFileTooLarge: '{name} は大きすぎます（25MB超）',
      fanchorDropLabel: 'リンクとして挿入'
    },
    en: {
      fanchorOpenFailed: 'Could not open the file: {error}',
      fanchorRevealFailed: 'Could not reveal the file: {error}',
      fanchorImportFailed: 'Failed to import {name}: {error}',
      fanchorImportUnavailable: 'File import is unavailable',
      fanchorFileTooLarge: '{name} is too large (over 25MB)',
      fanchorDropLabel: 'Insert as link'
    }
  };

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // Bare (non-angle-wrapped) targets never contain a literal space or ')' - those cases must be
  // percent-encoded or wrapped in <...>, matching the spec's own guidance.
  const LINK_RE = /(!)?\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^\s()]*))(?:\s+"[^"]*")?\s*\)/g;

  function isRemoteScheme(target) {
    return /^(https?:|mailto:)/i.test(target);
  }

  // Finds the markdown link/image under `caret`, restricted to its own line (a textarea has no
  // DOM to inspect, so caret position + surrounding text is all we have). Returns null for
  // http(s)/mailto targets - the app already handles those elsewhere.
  function findLinkAt(text, caret) {
    if (typeof text !== 'string' || typeof caret !== 'number') return null;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = text.indexOf('\n', caret);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.indexOf('](') === -1) return null;

    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(line))) {
      const start = lineStart + m.index;
      const end = lineStart + m.index + m[0].length;
      if (caret < start || caret > end) continue;
      const target = m[3] !== undefined ? m[3] : m[4];
      if (!target) return null;
      if (isRemoteScheme(target)) return null;
      return { isImage: !!m[1], label: m[2], target: target, start: start, end: end };
    }
    return null;
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
    openOrReveal(link.target, wantOpen, bridge);
    return true;
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

  function showTooltip(clientX, clientY, src) {
    ensureStyles();
    if (!tooltipEl) {
      tooltipEl = global.document.createElement('div');
      tooltipEl.className = 'fanchor-tooltip';
      tooltipEl.appendChild(global.document.createElement('img'));
      global.document.body.appendChild(tooltipEl);
    }
    const img = tooltipEl.querySelector ? tooltipEl.querySelector('img') : tooltipEl.children[0];
    if (img) img.src = src;
    tooltipEl.style.left = (clientX + 16) + 'px';
    tooltipEl.style.top = (clientY + 16) + 'px';
    tooltipEl.style.display = 'block';
  }

  function lineOf(text, index) {
    let n = 0;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  async function checkHover(editor, clientX, clientY) {
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

  function onMouseMove(event) {
    if (!event || !event.target || event.target.tagName !== 'TEXTAREA') { hideTooltip(); return; }
    const editor = event.target;
    const x = event.clientX;
    const y = event.clientY;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { checkHover(editor, x, y); }, HOVER_DEBOUNCE_MS);
  }

  function bindHoverListeners() {
    if (hoverListenersBound) return;
    hoverListenersBound = true;
    global.document.addEventListener('mousemove', onMouseMove);
    global.document.addEventListener('mouseleave', hideTooltip, true);
    global.document.addEventListener('scroll', hideTooltip, true);
    global.document.addEventListener('keydown', hideTooltip);
    global.document.addEventListener('click', hideTooltip);
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
    encodeLinkTarget: encodeLinkTarget
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findLinkAt: findLinkAt,
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
