// Printing the preview (the printer button at the top right of the preview, js/print_preview.js, css/print.css). The paper look itself
// is checked in a browser (tests/smoke/97_print_preview.mjs, and by printing the preview to PDF); this keeps the pieces from drifting
// apart: what is loaded when, what is hidden where, and the words in both languages. It also keeps the feature light: the stylesheet is
// for the print media only and the script is loaded on the first press, so a start-up pays for neither.
import fs from 'fs';
import assert from 'assert';
import vm from 'vm';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const html = read('frontend/index.html');
const css = read('frontend/css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const print = read('frontend/css/print.css').replace(/\/\*[\s\S]*?\*\//g, '');
const app = read('frontend/js/app.js');
const i18nSrc = read('frontend/js/i18n.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL: ' + name);
    console.log(e && e.stack ? e.stack : e);
  }
}

check('print.css is a stylesheet for the print media only, after style.css; print_preview.js is not loaded at start-up', () => {
  const link = html.match(/<link rel="stylesheet" href="css\/print\.css[^"]*" media="print">/);
  assert.ok(link, 'index.html links css/print.css with media="print"');
  assert.ok(html.indexOf(link[0]) > html.indexOf('css/style.css'), 'after style.css, so that it wins where both apply');
  assert.ok(!/<script[^>]+print_preview/.test(html), 'the script is loaded on the first press (app.js), not by index.html');
  assert.match(app, /if \(!window\.PrintPreview\) await loadScript\('js\/print_preview\.js[^']*'\);/);
});

check('the printer button follows the badge, is hidden unless the markdown preview is shown (on a Mac too: there it opens the system dialog)', () => {
  assert.match(html, /<div id="preview-badge"[^>]*>[^<]*<\/div>\s*(<!--[\s\S]*?-->\s*)?<button id="btn-preview-print" type="button" class="preview-print-btn" data-i18n-title="previewPrintTitle"/);
  const block = (sel) => { const m = css.match(new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); assert.ok(m, 'rule not found: ' + sel); return m[1]; };
  assert.match(block('.preview-print-btn'), /display:\s*none\s*;/, 'hidden by default');
  assert.match(block('.preview-print-btn'), /position:\s*absolute\s*;/, 'it takes no room in the layout');
  assert.match(block('#preview-pane:not(.hidden):not(.html-mode) ~ .preview-print-btn'), /display:\s*flex\s*;/, 'shown with the markdown preview, never over an HTML page');
  assert.match(block('.preview-print-btn[hidden]'), /display:\s*none\s*!important\s*;/, 'the hidden attribute wins over the rule above');
  assert.ok(!/btnPreviewPrint\.hidden\s*=/.test(app), 'the button is shown on a Mac too (it opens the system dialog; it was hidden before that existed)');
  assert.ok(/<svg[^>]*aria-hidden="true"/.test(html.slice(html.indexOf('id="btn-preview-print"'), html.indexOf('id="btn-preview-print"') + 900)), 'a line SVG icon, no emoji');
});

check('the paper look: only the preview, a white page, no fixed size, pictures and diagrams that fit, nothing cut', () => {
  assert.match(print, /body > \*:not\(#app\),\s*#app > \*:not\(#workspace\),\s*body:not\(\[data-print-pane="secondary"\]\) #workspace > \*:not\(#preview-pane\),\s*body\[data-print-pane="secondary"\] #workspace > \*:not\(#secondary-pane\),\s*body\[data-print-pane="secondary"\] #secondary-pane > \*:not\(#secondary-preview-pane\)\s*\{\s*display:\s*none\s*!important;/, 'everything but the preview (the full one, or the side one when the page says so) is hidden');
  assert.match(print, /@page\s*\{[^}]*margin:\s*20mm\s*;/, 'a 20 mm margin on the system dialog\'s paper (the panel\'s PDF has the same by default)');
  assert.match(print, /@page\s*\{[^}]*background:\s*#fff\s*;/, 'the margin of a PDF is white too (the page\'s dark colour scheme would paint it dark)');
  assert.ok(!/@page\s*\{[^}]*\bsize\s*:/.test(print), 'no @page size: the paper and its orientation are the print dialog\'s (a size would win over the person\'s choice)');
  assert.match(print, /html body\s*\{[^}]*background:\s*#fff\s*!important;[^}]*color:\s*#000\s*!important;/);
  assert.match(print, /(?:^|\})\s*html\s*\{\s*color-scheme:\s*light\s*!important;\s*\}/, 'a light colour scheme on paper (the page declares a dark one, which turns the margins of a PDF black)');
  assert.match(print, /content-visibility:\s*visible\s*!important;/, 'off-screen blocks are printed too');
  assert.match(print, /:is\(#preview-pane, #secondary-preview-pane\) img\s*\{[^}]*max-width:\s*100%\s*!important;[^}]*max-height:\s*\d+vh\s*!important;/, 'a picture is as wide as the page at most and shorter than a page, in any orientation (vh, not mm)');
  assert.ok(!/max-height:\s*\d+mm/.test(print), 'no height in mm: a landscape page is shorter than 245 mm');
  assert.match(print, /pre\.mermaid-card\s*\{[^}]*background:\s*#fff\s*!important;[^}]*break-inside:\s*avoid;/, 'a diagram sits on white and is not cut');
  assert.ok(!/pre\.mermaid-card svg\s*\{[^}]*max-width/.test(print), 'the SVG keeps Mermaid\'s own max-width (its natural size), so that a small diagram is not enlarged');
  assert.match(print, /:is\(#preview-pane, #secondary-preview-pane\) pre:not\(\.mermaid-card\)\s*\{[^}]*white-space:\s*pre-wrap;/, 'code wraps instead of running off the paper');
  assert.match(print, /:is\(#preview-pane, #secondary-preview-pane\) tr\s*\{[^}]*break-inside:\s*avoid;/);
  assert.match(print, /:is\(#preview-pane, #secondary-preview-pane\) thead\s*\{[^}]*table-header-group;/, 'the head row repeats on the next page');
  assert.match(print, /p:has\(\+ p > img:only-child\)[^{]*\{\s*break-after:\s*avoid;/, 'a line that introduces a picture stays with it');
  assert.match(print, /:not\(\.mermaid-card, \.mermaid-card \*\)\s*\{[^}]*color:\s*#000\s*!important;/, 'black text, but a diagram keeps its own colours');
  assert.ok(!/@media/.test(print), 'the whole file is for the print media: no @media blocks inside');
});

check('app.js: the diagram keeps its source for printing; the press opens the panel (or the system dialog alone) and always ends', () => {
  assert.match(app, /container\.dataset\.mermaidSrc = diagramCode;/);
  const start = app.indexOf("const btnPreviewPrint = document.getElementById('btn-preview-print');");
  assert.ok(start > 0);
  const block = app.slice(start, app.indexOf('// Smart Proportional Scroll Synchronization', start));
  // the system dialog alone (no backend that makes the PDF): print() once, and afterprint or the fallback ends it
  assert.strictEqual((block.match(/window\.print\(\)/g) || []).length, 2, 'once for that, once for "Print..." in the panel');
  assert.match(block, /window\.addEventListener\('afterprint', finish\);/);
  assert.match(block, /setTimeout\(finish, 1500\);/, 'a missing afterprint must not leave the diagrams light');
  assert.match(block, /if \(printBusy \|\| rpcPrintBusy \|\| !pane \|\| pane\.classList\.contains\('hidden'\) \|\| pane\.classList\.contains\('html-mode'\)\) return;/, 'no second press, none while print.pdf (JSON-RPC) is printing, not outside the markdown preview');
  // the side preview: its own button, shown only while the pane shows the preview; the page tells the print style which pane it prints
  assert.match(block, /btnSecondaryPrint\.addEventListener\('click', \(\) => startPrint\(true\)\)/);
  assert.match(block, /if \(side\) document\.body\.dataset\.printPane = 'secondary';/);
  assert.match(block, /delete document\.body\.dataset\.printPane;/, 'and takes it back when the press ends');
  assert.match(block, /\? \{ pane: secondaryPreviewPane, tab: getTab\(secondaryTabId\) \|\| getActiveTab\(\) \}/, 'the note of the side pane, not the one in the editor');
  assert.match(app, /if \(btnSecondaryPrint\) btnSecondaryPrint\.hidden = secondaryViewMode !== 'preview';/);
  assert.match(html, /<button id="btn-secondary-print" type="button" class="btn-pane-icon" data-i18n-title="previewPrintTitle"[^>]*\bhidden>/, 'in the header of the right-hand pane, hidden until it shows the preview');
  assert.match(css, /\.btn-pane-icon\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  // JSON-RPC print.pdf: the same preparation and engine, and the window put back whatever happens
  const rpcStart = app.indexOf('async function printPdfForRpc(');
  assert.ok(rpcStart > 0);
  const rpc = app.slice(rpcStart, app.indexOf('// Expose programmatic RPC interface', rpcStart));
  assert.match(rpc, /if \(rpcPrintBusy \|\| printPanelOpen\) rpcFail\('conflict'/, 'one print at a time, not while the panel is open');
  assert.match(rpc, /await window\.PrintPreview\.prepare\(previewPane, /, 'the same preparation as the button');
  assert.match(rpc, /await window\.backend\.printSavePdf\(asked, outPath\)/, 'the same engine call as the panel\'s Save as PDF');
  assert.match(rpc, /\} finally \{\s*if \(restoreDiagrams\) restoreDiagrams\(\);[\s\S]*rpcPrintBusy = false;/, 'the diagrams, the view and the flag come back in finally');
  assert.match(app, /printPdf: function \(tabId, settings, outPath\) \{\s*return printPdfForRpc\(tabId, settings, outPath\);/);
  assert.match(block, /const resetMermaid = \(\) => \{ mermaidAppliedTone = null; applyMermaidTone\(\); \};/, 'Mermaid goes back to the tone of the settings');
  // the panel: its scripts are loaded on the first press; it knows the note's name and place; closing ends the press
  assert.match(block, /if \(isMac \|\| !\(window\.backend && window\.backend\.printPreview\)\) \{\s*await printWithSystemDialog\(\);/, 'without the PDF backend, and on a Mac (whose PDF is made by the system dialog), the system dialog alone');
  // a Mac has no window.print(): the native dialog (NSPrintOperation) through backend.printSystem, titled with the note's name;
  // its answer comes when the dialog is closed, and that puts the diagrams back
  assert.match(block, /if \(isMac && window\.backend && window\.backend\.printSystem\) \{/);
  assert.match(block, /await window\.backend\.printSystem\(tab && tab\.title \? String\(tab\.title\)\.replace\(\/\\\.\(md\|markdown\|txt\)\$\/i, ''\) : ''\);\s*finish\(\);\s*return;/);
  assert.match(block, /if \(!window\.PrintPanel\) await loadScript\('js\/print_panel\.js[^']*'\);/);
  assert.match(block, /note: \(\) => \{ const tab = printTarget\(\)\.tab; return \{ title: tab \? tab\.title : '', path: tab \? tab\.path : '' \}; \},/);
  assert.match(block, /onClose: idle/);
  assert.match(app, /shown\(scrapsSearchModal\) \|\| deepDialogOpen \|\| printPanelOpen \|\|/, 'the shortcuts of the editor do not act while the panel is open');
});

check('the print panel: modules, the markup (settings on the right), the PDF served by the app, the calls bound on both platforms', () => {
  const panel = read('frontend/js/print_panel.js');
  assert.ok(!/<script[^>]+print_panel/.test(html), 'print_panel.js is loaded by the first press, not by index.html');
  const modal = html.slice(html.indexOf('id="print-modal"'), html.indexOf('id="print-modal"') + 6000);
  assert.ok(modal.indexOf('class="print-stage"') > 0 && modal.indexOf('class="print-side"') > modal.indexOf('class="print-stage"'), 'the preview comes first, the settings after it: on the right');
  assert.match(css, /\.print-side\s*\{[^}]*flex:\s*0 0 280px;[^}]*border-left:/, 'a fixed pane on the right with its divider');
  assert.match(modal, /<input id="print-header-footer" type="checkbox">/, 'the switch carries no "checked": off by default');
  assert.ok(!/id="print-header-footer"[^>]*checked/.test(modal));
  assert.match(panel, /headerFooter: o\.headerFooter === true/, 'only a real true switches the header and footer on');
  assert.match(panel, /s\.pages = '';/, 'a page range is not carried to the next note');
  assert.ok(!/(?:src|href)\s*=\s*['"]https?:/.test(panel), 'nothing in the panel reaches outside');
  for (const f of ['bind_common.go']) {
    const src = read(f);
    for (const name of ['backend_printPreviewAsync', 'backend_printPickPdfPath', 'backend_printSavePdfAsync', 'backend_printPreviewClose']) assert.ok(src.includes('"' + name + '"'), f + ' binds ' + name);
  }
  // the Mac: the system's print dialog for the page (WKWebView's print operation, macOS 11+), a sheet of the window, 20 mm margins
  const mac = read('window_darwin.go');
  assert.match(mac, /_ = w\.Bind\("backend_printSystemAsync", func\(reqID, title string\) error \{/, 'the Mac binds the native print dialog');
  assert.match(mac, /printSystem: \(title\) => window\.__mdmemoAsync\('printSystem_', \d+, \(reqID\) => window\.backend_printSystemAsync\(reqID, title \|\| ''\)\)/, 'and the page reaches it as backend.printSystem');
  assert.match(mac, /printOperationWithPrintInfo:info/);
  assert.match(mac, /setTopMargin:margin[\s\S]*setBottomMargin:margin[\s\S]*setLeftMargin:margin[\s\S]*setRightMargin:margin/);
  assert.match(mac, /CGFloat margin = 20\.0 \* 72\.0 \/ 25\.4;/, '20 mm');
  assert.match(mac, /runOperationModalForWindow:gWindow/);
  assert.match(mac, /\[panel setOptions:\(\[panel options\] \| NSPrintPanelShowsPaperSize \| NSPrintPanelShowsOrientation \| NSPrintPanelShowsScaling\)\];/, 'the panel offers the paper, the orientation and the scale (it shows only copies, pages and the preview unless asked)');
  for (const f of ['window_windows.go', 'window_darwin.go']) {
    const src = read(f);
    assert.match(src, /window\.__onPrintPdfResult = function \(reqID, result, errMsg\) \{\s*window\.__mdmemoSettle\(reqID, result, errMsg\);/, f + ': the answers settle the promises');
    for (const fn of ['printPreview', 'printPickPdfPath', 'printSavePdf', 'printPreviewClose']) assert.ok(src.includes(fn + ':'), f + ' has window.backend.' + fn);
  }
  assert.match(read('main.go'), /r\.URL\.Path == "\/api\/print\/preview\.pdf"/, 'the app\'s own server serves the preview PDF');
});

check('the words exist in English and Japanese with the same placeholders, and the English has no Japanese', () => {
  const ctx = { window: {}, module: {}, globalThis: {} };
  vm.createContext(ctx);
  vm.runInContext(i18nSrc + '\n;this.I18N_OUT = typeof I18N !== "undefined" ? I18N : null;', ctx);
  const I18N = ctx.I18N_OUT;
  assert.ok(I18N && I18N.en && I18N.ja);
  for (const key of ['previewPrintTitle', 'previewPrintFailed', 'printTitle', 'printPaper', 'printLetter', 'printOrientation', 'printPortrait', 'printLandscape', 'printMargin', 'printMarginNormal', 'printMarginNarrow', 'printScale', 'printPages', 'printPagesPlaceholder', 'printHeaderFooter', 'printHeaderFooterHint', 'printUnsaved', 'printPageCount', 'printMaking', 'printFailed', 'printPreviewLabel', 'printSaving', 'printSaved', 'printSaveFailed', 'printSavePdf', 'printSystem']) {
    assert.ok(I18N.en[key] && I18N.ja[key], key + ' in both languages');
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    assert.strictEqual(ph(I18N.en[key]), ph(I18N.ja[key]), key + ': the same placeholders');
    assert.ok(!/[぀-ヿ一-鿿]/.test(I18N.en[key]), key + ': no Japanese in the English text');
  }
  assert.match(I18N.en.previewPrintTitle, /PDF/);
  assert.match(I18N.ja.previewPrintTitle, /PDF/);
  assert.match(I18N.ja.printSavePdf, /PDF/);
});

if (failed) {
  console.log(failed + ' test(s) failed');
  process.exit(1);
}
console.log('all passed');
