// MD-Memo: the print panel of the preview (the printer button at the top right of the preview). The page as it will be printed is
// shown on the left, as the PDF that WebView2's own engine makes of it (print_pdf.go, Page.printToPDF; css/print.css is its paper
// look), and the settings are on the right: paper, orientation, margins, scale, pages, and a header and footer that, when switched on,
// carry the file's name above and its place (and the page number) below. "Save as PDF" asks where, then writes the same PDF.
// "Print..." is the system's print dialog (window.print()) for a printer.
//
// The file is loaded the first time the button is pressed, so it costs nothing before that. Nothing of the PDF is kept after the panel
// is closed: the viewer is taken out of the page and the backend forgets the PDF.
(function (global) {
  'use strict';

  const STORE_KEY = 'md_memo_print_settings';
  const DEBOUNCE_MS = 300;
  const DEFAULTS = Object.freeze({ paper: 'a4', landscape: false, margin: 'normal', scale: 100, pages: '', headerFooter: false });
  const PAPERS = ['a4', 'a3', 'b5', 'letter'];
  const SCALES = [50, 75, 90, 100, 110, 125, 150, 200];

  // ---- pure helpers (exported for Node tests) -----------------------------------------------

  // The settings as they were remembered, made safe: anything unknown falls back to the default.
  function normalize(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const scale = Number(o.scale);
    return {
      paper: PAPERS.indexOf(o.paper) >= 0 ? o.paper : DEFAULTS.paper,
      landscape: o.landscape === true,
      margin: o.margin === 'narrow' ? 'narrow' : 'normal',
      scale: SCALES.indexOf(scale) >= 0 ? scale : DEFAULTS.scale,
      pages: typeof o.pages === 'string' && /^[0-9 ,-]{0,100}$/.test(o.pages) ? o.pages.trim() : '',
      headerFooter: o.headerFooter === true // off unless the person switched it on
    };
  }

  // The folder of a path, with whichever separator the path uses ('' for a name with no folder).
  function dirname(path) {
    const p = String(path || '');
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    if (i < 0) return '';
    if (i === 0) return p.charAt(0);
    if (i === 2 && /^[A-Za-z]:/.test(p)) return p.slice(0, 3);
    return p.slice(0, i);
  }

  function basename(path) {
    const p = String(path || '');
    return p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
  }

  // The viewer fitted to the width makes the sheet touch both sides of the pane, like a screen and not like paper. This asks for a zoom
  // that leaves a grey margin on both sides (and above) of the sheet: its width is the pane's, less the scroll bar and the margins.
  const PAPER_IN = { a4: [8.27, 11.69], a3: [11.69, 16.54], b5: [7.17, 10.12], letter: [8.5, 11] }; // as in print_pdf.go
  const VIEW_GUTTER = 20;
  const VIEW_SCROLLBAR = 16;
  function viewHash(paper, landscape, paneWidth) {
    const dims = PAPER_IN[paper] || PAPER_IN.a4;
    const room = Number(paneWidth) - VIEW_SCROLLBAR - 2 * VIEW_GUTTER;
    if (!(room > 0)) return '#view=FitH'; // no width to go by (not laid out yet)
    const pct = Math.floor((100 * room) / ((landscape ? dims[1] : dims[0]) * 96));
    return '#zoom=' + Math.max(25, Math.min(200, pct));
  }

  // What the backend is asked for: the settings, and the file's name and place for the header and footer.
  function requestOf(settings, note, unsavedText) {
    const s = normalize(settings);
    const n = note || {};
    const title = n.title || basename(n.path) || '';
    return {
      paper: s.paper, landscape: s.landscape, margin: s.margin, scale: s.scale, pages: s.pages, headerFooter: s.headerFooter,
      title: title,
      location: n.path ? dirname(n.path) || n.path : (unsavedText || '')
    };
  }

  // ---- the panel ------------------------------------------------------------------------------

  let current = null; // the open panel's state, or null

  function byId(id) { return global.document.getElementById(id); }

  function readStored() {
    try {
      const s = normalize(JSON.parse(global.localStorage.getItem(STORE_KEY)));
      s.pages = ''; // a range belongs to the note it was typed for: never carried to the next one
      return s;
    } catch (e) { return normalize(null); }
  }
  function writeStored(s) {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* the settings of this time only */ }
  }

  function setPressed(group, value) {
    group.querySelectorAll('.print-seg-btn').forEach(function (b) {
      const on = b.getAttribute('data-value') === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // Opens the panel. host: { t, backend, note() -> { title, path }, pane, prepare(), systemPrint(), withNativeDialog(fn), showMessage(text, ms),
  // onClose() }. Resolves when it is open; the panel closes itself (button, Esc, after saving).
  async function open(host) {
    if (current) return;
    const modal = byId('print-modal');
    if (!modal) throw new Error('the print panel is not in the page');
    const t = host.t;
    const stage = byId('print-stage');
    const status = byId('print-status');
    const state = { settings: readStored(), seq: 0, timer: 0, restore: null, embed: null, pages: 0, closed: false };
    current = state;

    const els = {
      paper: byId('print-paper'), scale: byId('print-scale'), pages: byId('print-pages'), header: byId('print-header-footer'),
      orient: byId('print-orientation'), margin: byId('print-margin'), summary: byId('print-summary'),
      save: byId('print-save'), system: byId('print-system'), cancel: byId('print-cancel'), close: byId('print-close')
    };

    const note = () => (typeof host.note === 'function' ? host.note() : {}) || {};
    const request = () => requestOf(state.settings, note(), t('printUnsaved'));
    const paperName = () => (state.settings.paper === 'letter' ? t('printLetter') : state.settings.paper.toUpperCase());

    function paint() {
      const s = state.settings;
      els.paper.value = s.paper;
      els.scale.value = String(s.scale);
      els.pages.value = s.pages;
      els.header.checked = s.headerFooter;
      setPressed(els.orient, s.landscape ? 'landscape' : 'portrait');
      setPressed(els.margin, s.margin);
      const parts = [paperName(), t(s.landscape ? 'printLandscape' : 'printPortrait')];
      if (state.pages > 0) parts.push(t('printPageCount', { n: state.pages }));
      els.summary.textContent = parts.join(' · ');
    }

    function showStatus(text, isError) {
      status.textContent = text || '';
      status.classList.toggle('print-status-error', !!isError);
      status.classList.toggle('hidden', !text);
    }

    function removeEmbed() {
      if (state.embed && state.embed.parentNode) state.embed.parentNode.removeChild(state.embed);
      state.embed = null;
    }

    // Makes the PDF for the settings now and shows it. A newer request makes an older answer moot.
    async function refresh() {
      const seq = ++state.seq;
      const asked = request();
      els.save.disabled = true;
      showStatus(t('printMaking'), false);
      let res;
      try {
        res = await host.backend.printPreview(asked);
      } catch (err) {
        if (state.closed || seq !== state.seq) return;
        removeEmbed();
        state.pages = 0;
        paint();
        showStatus(t('printFailed', { message: oneLine(err) }), true);
        return;
      }
      if (state.closed || seq !== state.seq) return;
      state.pages = Number(res && res.pages) || 0;
      removeEmbed();
      const embed = global.document.createElement('embed');
      embed.type = 'application/pdf';
      embed.className = 'print-embed';
      embed.setAttribute('aria-label', t('printPreviewLabel'));
      embed.src = String(res.url) + viewHash(state.settings.paper, state.settings.landscape, stage.clientWidth);
      stage.appendChild(embed);
      state.embed = embed;
      showStatus('', false);
      els.save.disabled = false;
      paint();
    }

    function changed() {
      state.settings = normalize({
        paper: els.paper.value, landscape: state.settings.landscape, margin: state.settings.margin, scale: Number(els.scale.value),
        pages: els.pages.value, headerFooter: els.header.checked
      });
      writeStored(state.settings);
      paint();
      global.clearTimeout(state.timer);
      state.timer = global.setTimeout(refresh, DEBOUNCE_MS);
    }

    // The groups of two buttons (orientation, margins). Handlers are properties, set each time the panel opens and cleared when it
    // closes, so that opening it again never stacks them.
    function onSeg(group, key) {
      group.onclick = function (e) {
        const b = e.target.closest ? e.target.closest('.print-seg-btn') : null;
        if (!b) return;
        const v = b.getAttribute('data-value');
        if (key === 'orientation') state.settings.landscape = v === 'landscape';
        else state.settings.margin = v === 'narrow' ? 'narrow' : 'normal';
        writeStored(normalize(state.settings));
        paint();
        global.clearTimeout(state.timer);
        state.timer = global.setTimeout(refresh, 0);
      };
    }

    function oneLine(err) {
      return String((err && err.message) || err || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    }

    function close() {
      if (state.closed) return;
      state.closed = true;
      global.clearTimeout(state.timer);
      state.seq++;
      removeEmbed();
      try { host.backend.printPreviewClose(); } catch (e) { /* nothing is kept either way */ }
      if (state.restore) state.restore();
      modal.classList.add('hidden');
      global.document.removeEventListener('keydown', onKey, true);
      [els.orient, els.margin].forEach(function (g) { g.onclick = null; });
      els.paper.onchange = els.scale.onchange = els.header.onchange = els.pages.oninput = null;
      els.cancel.onclick = els.close.onclick = els.save.onclick = els.system.onclick = null;
      current = null;
      if (typeof host.onClose === 'function') host.onClose();
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }

    async function save() {
      if (els.save.disabled) return;
      const asked = request();
      els.save.disabled = true;
      try {
        const path = await host.withNativeDialog(function () { return host.backend.printPickPdfPath(asked.title || ''); });
        if (!path) return; // cancelled, or a dialog is already open
        showStatus(t('printSaving'), false);
        const res = await host.backend.printSavePdf(asked, path);
        host.showMessage(t('printSaved', { path: (res && res.path) || path }), 6000);
        close();
      } catch (err) {
        showStatus(t('printSaveFailed', { message: oneLine(err) }), true);
      } finally {
        if (!state.closed) els.save.disabled = !state.embed;
      }
    }

    // wiring
    els.orient.setAttribute('aria-label', t('printOrientation'));
    els.margin.setAttribute('aria-label', t('printMargin'));
    paint();
    showStatus(t('printMaking'), false);
    onSeg(els.orient, 'orientation');
    onSeg(els.margin, 'margin');
    els.paper.onchange = els.scale.onchange = els.header.onchange = changed;
    els.pages.oninput = changed;
    els.cancel.onclick = close;
    els.close.onclick = close;
    els.save.onclick = save;
    els.system.onclick = function () { if (typeof host.systemPrint === 'function') host.systemPrint(); };
    global.document.addEventListener('keydown', onKey, true);

    modal.classList.remove('hidden');
    els.save.disabled = true;
    els.save.focus();
    try {
      state.restore = await host.prepare(); // the images are loaded and the diagrams are light, for as long as the panel is open
    } catch (e) { state.restore = null; }
    if (state.closed) { if (state.restore) state.restore(); return; }
    refresh();
  }

  const api = { open: open, normalize: normalize, dirname: dirname, basename: basename, requestOf: requestOf, viewHash: viewHash, DEFAULTS: DEFAULTS, PAPERS: PAPERS, SCALES: SCALES };
  global.PrintPanel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
