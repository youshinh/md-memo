// The printer button of the preview: it is only there while the preview is, left of the badge; the first press loads print_preview.js and
// print_panel.js, opens the print panel and draws the diagrams that are in the dark tone again in the light one for as long as it is open
// (closing it puts them back); "Print..." in the panel is the system's print dialog (window.print(), stubbed here); without the backend that
// makes the PDF the press opens that dialog alone (afterprint puts everything back); and under the print media (emulated) the page is the
// preview alone, white with black text, with images and diagrams no wider than the page and no screen chrome (the panel included).
import zlib from 'node:zlib';
import { assert, click } from './lib.mjs';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    crc ^= buf[n];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A w x h PNG in one colour (enough to be a real, wider-than-the-page image).
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 60; raw[o + 2] = 90; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const uri = (w, h) => 'data:image/png;base64,' + png(w, h).toString('base64');

const NOTE = `# Print test

Some text, **bold**, and a [link](https://example.com).

| a | b |
|---|---|
| 1 | 2 |

\`\`\`mermaid
flowchart LR
  A[one] --> B[two] --> C[three]
\`\`\`

A wide picture:

![wide](${uri(1800, 300)})

\`\`\`js
const longLine = "this line is long enough to be wider than a printed page when it does not wrap, so it must wrap on paper";
\`\`\`
`;

export default {
  title: 'preview printing: the printer button opens the print panel, the diagrams are light for the paper while it is open, and the print style (one page of white, black text, pictures that fit)',
  session: { notes: [{ title: 'print.md', content: NOTE }] },
  timeoutMs: 60000,

  async run(s, t) {
    const display = (id) => s.ev(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`);
    const tones = () => s.ev("Array.from(document.querySelectorAll('#preview-pane pre.mermaid-card')).map(function (e) { return e.classList.contains('tone-dark') ? 'dark' : e.classList.contains('tone-light') ? 'light' : '?'; }).join(',')");
    const printMedia = (on) => s.page.cdp.send('Emulation.setEmulatedMedia', { media: on ? 'print' : '' });
    const css = (selector, prop) => s.ev(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(prop)}]`);
    const panelShown = () => s.ev("!document.getElementById('print-modal').classList.contains('hidden')");
    const calls = (fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${JSON.stringify(fn)}; }).length`);
    const panelReady = "!document.getElementById('print-modal').classList.contains('hidden') && !!document.querySelector('#print-stage embed')";

    t.step('in the editor there is no printer button, and nothing of the print code is loaded');
    assert.equal(await display('btn-preview-print'), 'none');
    assert.equal(await s.ev("typeof window.PrintPreview + ',' + typeof window.PrintPanel"), 'undefined,undefined', 'the scripts are loaded on the first press, not at start-up');
    assert.equal(await s.ev("Array.from(document.querySelectorAll('script')).some(function (e) { return /print_(preview|panel)/.test(e.src); })"), false);

    t.step('the preview shows the button at its top right, left of the badge and clear of it');
    await click(s, 'btn-toggle-preview');
    await s.waitFor("document.querySelectorAll('#preview-pane pre.mermaid-card svg[id^=mermaid]').length === 1 && document.querySelector('#preview-pane img') && document.querySelector('#preview-pane img').complete", { timeout: 20000 });
    assert.equal(await display('btn-preview-print'), 'flex');
    const rects = await s.ev("(function () { var b = document.getElementById('btn-preview-print').getBoundingClientRect(), g = document.getElementById('preview-badge').getBoundingClientRect(); return { btnRight: b.right, badgeLeft: g.left, btnW: b.width, btnTop: b.top, badgeTop: g.top, paneTop: document.getElementById('preview-pane').getBoundingClientRect().top }; })()");
    assert.ok(rects.btnRight <= rects.badgeLeft, `the button ends (${rects.btnRight}) before the badge begins (${rects.badgeLeft})`);
    assert.ok(rects.btnW >= 22 && rects.btnTop >= rects.paneTop && rects.btnTop < rects.paneTop + 30, 'a button of a usable size in the top row of the preview');
    assert.ok(Math.abs(rects.btnTop - rects.badgeTop) < 12, 'on the row of the badge');
    assert.deepEqual(await tones(), 'dark', 'the diagram is in the dark tone on screen');

    t.step('the first press opens the panel, loads the modules, draws the diagram light and asks for the preview once');
    await click(s, 'btn-preview-print');
    await s.waitFor(panelReady, { timeout: 20000 });
    assert.equal(await s.ev("typeof window.PrintPreview + ',' + typeof window.PrintPanel"), 'object,object');
    assert.equal(await calls('printPreview'), 1);
    assert.equal(await tones(), 'light', 'light for the paper while the panel is open');
    assert.equal(await s.ev("document.getElementById('btn-preview-print').disabled"), true, 'a second press is not possible while the panel is open');

    t.step('under the print media: the preview alone, white page, black text, no chrome (the panel too), pictures and diagram no wider than the page');
    await printMedia(true);
    try {
      for (const id of ['header', 'status-bar', 'preview-badge', 'btn-preview-print', 'print-modal']) assert.equal(await display(id), 'none', `${id} is not printed`);
      assert.equal(await display('editor-pane'), 'none');
      assert.equal(await css('#preview-pane', 'display'), 'block');
      assert.equal(await css('#preview-pane', 'backgroundColor'), 'rgb(255, 255, 255)', 'white paper');
      assert.equal(await css('body', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.equal(await css('html', 'colorScheme'), 'light', 'the page declares a dark scheme: on paper it must be light, or the margins of a PDF with backgrounds come out black');
      assert.equal(await css('html', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.equal(await css('#preview-pane h1', 'color'), 'rgb(0, 0, 0)', 'black headings (on screen they are coloured)');
      assert.equal(await css('#preview-pane p', 'color'), 'rgb(0, 0, 0)');
      assert.equal(await css('#preview-pane', 'overflowY'), 'visible', 'not a scroll box: every page is printed');
      assert.equal(await css('#preview-pane', 'position'), 'static');
      assert.equal(await css('#preview-pane', 'contentVisibility'), 'visible');
      assert.equal(await css('#preview-pane img', 'maxWidth'), '100%', 'a picture is never wider than the page');
      assert.equal(await css('#preview-pane pre.mermaid-card', 'backgroundColor'), 'rgb(255, 255, 255)', 'a diagram sits on white');
      // (the light drawing has no tone button of its own: the dark one is set aside until the panel is closed)
      assert.equal(await s.ev("document.querySelectorAll('#preview-pane .mermaid-tone-btn').length"), 0, 'no tone button on the printed diagram');
      const pre = await s.ev("(function () { var p = document.querySelector('#preview-pane pre:not(.mermaid-card)'); var c = getComputedStyle(p); return { ws: c.whiteSpace, ov: c.overflow }; })()");
      assert.equal(pre.ws, 'pre-wrap', 'code wraps on paper');
      assert.equal(pre.ov, 'visible');
      const imgW = await s.ev("document.querySelector('#preview-pane img').getBoundingClientRect().width");
      const paneW = await s.ev("document.getElementById('preview-pane').getBoundingClientRect().width");
      assert.ok(imgW <= paneW + 1, `the 1800 px picture (${imgW}) fits the page width (${paneW})`);
      const svgW = await s.ev("document.querySelector('#preview-pane pre.mermaid-card svg[id^=mermaid]').getBoundingClientRect().width");
      assert.ok(svgW <= paneW + 1, `the diagram (${svgW}) fits the page width (${paneW})`);
    } finally {
      await printMedia(false);
    }
    assert.equal(await css('#preview-pane', 'backgroundColor'), 'rgb(39, 43, 33)', 'the screen is as it was: the print style does not apply to it');
    assert.notEqual(await display('header'), 'none', 'the screen chrome is back');

    t.step('"Print..." in the panel is the system dialog (window.print) once; closing the panel puts the diagram back and frees the PDF');
    await s.ev("window.__printCalls = 0; window.print = function () { window.__printCalls++; }; 1");
    await click(s, 'print-system');
    await s.waitFor('window.__printCalls === 1', { timeout: 10000 });
    assert.equal(await panelShown(), true, 'the panel stays while the system dialog is used');
    assert.equal(await tones(), 'light');
    await click(s, 'print-cancel');
    assert.equal(await panelShown(), false);
    assert.equal(await tones(), 'dark', 'the diagram is back in its tone');
    assert.equal(await s.ev("document.querySelectorAll('#preview-pane pre.mermaid-card .mermaid-tone-btn').length"), 1, 'with its own tone button');
    assert.equal(await s.ev("document.querySelectorAll('#print-stage embed').length"), 0, 'the viewer is taken out of the page');
    assert.equal(await calls('printPreviewClose'), 1, 'the backend forgot the PDF');
    assert.equal(await s.ev("document.getElementById('btn-preview-print').disabled"), false);

    t.step('it opens again (and Esc closes it)');
    await click(s, 'btn-preview-print');
    await s.waitFor(panelReady, { timeout: 20000 });
    assert.equal(await calls('printPreview'), 2);
    assert.equal(await tones(), 'light');
    await s.key('Escape');
    await s.waitFor("document.getElementById('print-modal').classList.contains('hidden')");
    assert.equal(await tones(), 'dark');

    t.step('with no backend that makes the PDF the press is the system dialog alone, and afterprint puts the diagram back');
    await s.ev("delete window.backend.printPreview; window.__printCalls = 0; var __st = window.setTimeout; window.setTimeout = function (f, ms) { return ms === 1500 ? 0 : __st.apply(window, arguments); }; 1");
    await click(s, 'btn-preview-print');
    await s.waitFor('window.__printCalls === 1', { timeout: 10000 });
    assert.equal(await panelShown(), false, 'no panel');
    assert.equal(await tones(), 'light', 'light while that dialog is open');
    await s.ev("window.dispatchEvent(new Event('afterprint')); 1");
    assert.equal(await tones(), 'dark');
    assert.equal(await s.ev("document.getElementById('btn-preview-print').disabled"), false);

    t.step('back in the editor the button is gone again');
    await click(s, 'btn-toggle-preview');
    await s.waitFor("getComputedStyle(document.getElementById('btn-preview-print')).display === 'none'");
  }
};
