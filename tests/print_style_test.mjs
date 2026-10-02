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

check('the printer button follows the badge, is hidden unless the markdown preview is shown, and is hidden on a Mac', () => {
  assert.match(html, /<div id="preview-badge"[^>]*>[^<]*<\/div>\s*(<!--[\s\S]*?-->\s*)?<button id="btn-preview-print" type="button" class="preview-print-btn" data-i18n-title="previewPrintTitle"/);
  const block = (sel) => { const m = css.match(new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); assert.ok(m, 'rule not found: ' + sel); return m[1]; };
  assert.match(block('.preview-print-btn'), /display:\s*none\s*;/, 'hidden by default');
  assert.match(block('.preview-print-btn'), /position:\s*absolute\s*;/, 'it takes no room in the layout');
  assert.match(block('#preview-pane:not(.hidden):not(.html-mode) ~ .preview-print-btn'), /display:\s*flex\s*;/, 'shown with the markdown preview, never over an HTML page');
  assert.match(block('.preview-print-btn[hidden]'), /display:\s*none\s*!important\s*;/, 'the hidden attribute wins over the rule above');
  assert.match(app, /if \(isMac\) \{\s*btnPreviewPrint\.hidden = true;/, 'WKWebView has no window.print(): no button on a Mac');
  assert.ok(/<svg[^>]*aria-hidden="true"/.test(html.slice(html.indexOf('id="btn-preview-print"'), html.indexOf('id="btn-preview-print"') + 900)), 'a line SVG icon, no emoji');
});

check('the paper look: only the preview, a white page, no fixed size, pictures and diagrams that fit, nothing cut', () => {
  assert.match(print, /body > \*:not\(#app\),\s*#app > \*:not\(#workspace\),\s*#workspace > \*:not\(#preview-pane\)\s*\{\s*display:\s*none\s*!important;/, 'everything but the preview is hidden');
  assert.match(print, /@page\s*\{[^}]*margin:/);
  assert.ok(!/@page\s*\{[^}]*\bsize\s*:/.test(print), 'no @page size: the paper and its orientation are the print dialog\'s (a size would win over the person\'s choice)');
  assert.match(print, /html body\s*\{[^}]*background:\s*#fff\s*!important;[^}]*color:\s*#000\s*!important;/);
  assert.match(print, /content-visibility:\s*visible\s*!important;/, 'off-screen blocks are printed too');
  assert.match(print, /#preview-pane img\s*\{[^}]*max-width:\s*100%\s*!important;[^}]*max-height:\s*\d+vh\s*!important;/, 'a picture is as wide as the page at most and shorter than a page, in any orientation (vh, not mm)');
  assert.ok(!/max-height:\s*\d+mm/.test(print), 'no height in mm: a landscape page is shorter than 245 mm');
  assert.match(print, /pre\.mermaid-card\s*\{[^}]*background:\s*#fff\s*!important;[^}]*break-inside:\s*avoid;/, 'a diagram sits on white and is not cut');
  assert.ok(!/pre\.mermaid-card svg\s*\{[^}]*max-width/.test(print), 'the SVG keeps Mermaid\'s own max-width (its natural size), so that a small diagram is not enlarged');
  assert.match(print, /#preview-pane pre:not\(\.mermaid-card\)\s*\{[^}]*white-space:\s*pre-wrap;/, 'code wraps instead of running off the paper');
  assert.match(print, /#preview-pane tr\s*\{[^}]*break-inside:\s*avoid;/);
  assert.match(print, /#preview-pane thead\s*\{[^}]*table-header-group;/, 'the head row repeats on the next page');
  assert.match(print, /p:has\(\+ p > img:only-child\)[^{]*\{\s*break-after:\s*avoid;/, 'a line that introduces a picture stays with it');
  assert.match(print, /:not\(\.mermaid-card, \.mermaid-card \*\)\s*\{[^}]*color:\s*#000\s*!important;/, 'black text, but a diagram keeps its own colours');
  assert.ok(!/@media/.test(print), 'the whole file is for the print media: no @media blocks inside');
});

check('app.js: the diagram keeps its source for printing, the press runs print() once and always ends (afterprint, or the fallback)', () => {
  assert.match(app, /container\.dataset\.mermaidSrc = diagramCode;/);
  const start = app.indexOf("const btnPreviewPrint = document.getElementById('btn-preview-print');");
  assert.ok(start > 0);
  const block = app.slice(start, app.indexOf('// Smart Proportional Scroll Synchronization', start));
  assert.strictEqual((block.match(/window\.print\(\)/g) || []).length, 1);
  assert.match(block, /window\.addEventListener\('afterprint', finish\);/);
  assert.match(block, /setTimeout\(finish, 1500\);/, 'a missing afterprint must not leave the diagrams light');
  assert.match(block, /if \(printBusy \|\| previewPane\.classList\.contains\('hidden'\) \|\| previewPane\.classList\.contains\('html-mode'\)\) return;/, 'no second press, not outside the markdown preview');
  assert.match(block, /resetMermaid: \(\) => \{ mermaidAppliedTone = null; applyMermaidTone\(\); \}/, 'Mermaid goes back to the tone of the settings');
});

check('the words exist in English and Japanese with the same placeholders, and the English has no Japanese', () => {
  const ctx = { window: {}, module: {}, globalThis: {} };
  vm.createContext(ctx);
  vm.runInContext(i18nSrc + '\n;this.I18N_OUT = typeof I18N !== "undefined" ? I18N : null;', ctx);
  const I18N = ctx.I18N_OUT;
  assert.ok(I18N && I18N.en && I18N.ja);
  for (const key of ['previewPrintTitle', 'previewPrintFailed']) {
    assert.ok(I18N.en[key] && I18N.ja[key], key + ' in both languages');
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    assert.strictEqual(ph(I18N.en[key]), ph(I18N.ja[key]), key + ': the same placeholders');
    assert.ok(!/[぀-ヿ一-鿿]/.test(I18N.en[key]), key + ': no Japanese in the English text');
  }
  assert.match(I18N.en.previewPrintTitle, /PDF/);
  assert.match(I18N.ja.previewPrintTitle, /PDF/);
});

if (failed) {
  console.log(failed + ' test(s) failed');
  process.exit(1);
}
console.log('all passed');
