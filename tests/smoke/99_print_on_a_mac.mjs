// The printer button on a Mac (the platform is emulated: the user agent says Macintosh, then the page is loaded again). WKWebView has no
// window.print() and the PDF engine of the Windows panel is WebView2's, so the button is there but opens no panel: it prepares the page
// (the diagrams light for the paper) and asks the backend for the system's own print dialog (backend.printSystem, an NSPrintOperation),
// offering the note's name without its extension as the title of the job. When the dialog is closed (printed, saved or cancelled) the
// diagrams go back and the button can be pressed again; a failure is one line. window.print() is never called.
import { assert, click } from './lib.mjs';

const NOTE = `# Print on a Mac

Some text.

\`\`\`mermaid
flowchart LR
  A[one] --> B[two]
\`\`\`
`;

export default {
  title: 'printing on a Mac: the button opens the system dialog (no panel) with the note\'s name, the diagrams are light while it is open and go back, a failure is one line',
  session: { notes: [{ title: 'mac notes.md', content: NOTE }] },
  timeoutMs: 60000,

  async run(s, t) {
    const tones = () => s.ev("Array.from(document.querySelectorAll('#preview-pane pre.mermaid-card')).map(function (e) { return e.classList.contains('tone-dark') ? 'dark' : e.classList.contains('tone-light') ? 'light' : '?'; }).join(',')");
    const systemCalls = () => s.ev('window.__docshot.print.system.slice()');
    const printCalls = () => s.ev('window.__printCalls');

    t.step('the page believes it is on a Mac');
    await s.page.cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel'
    });
    await s.page.navigate(`${s.base}/?lang=${s.lang}`);
    await s.waitFor('window.__docshot && window.__docshot.isReady()', { timeout: 30000 });
    assert.equal(await s.ev('window.MDMemoPlatform.isMac'), true);
    await s.ev('window.__printCalls = 0; window.print = function () { window.__printCalls++; }; 1');

    t.step('the button is there with the preview (it was hidden on a Mac before the native dialog)');
    await click(s, 'btn-toggle-preview');
    await s.waitFor("document.querySelectorAll('#preview-pane pre.mermaid-card svg[id^=mermaid]').length === 1", { timeout: 20000 });
    assert.equal(await s.ev("getComputedStyle(document.getElementById('btn-preview-print')).display"), 'flex');
    assert.equal(await s.ev("document.getElementById('btn-preview-print').hidden"), false);
    assert.equal(await tones(), 'dark');

    t.step('the press asks for the native dialog with the note\'s name; the diagram is light while it is open, and back afterwards');
    await s.ev('window.__docshot.print.systemDelay = 600; 1');
    await click(s, 'btn-preview-print');
    await s.waitFor("window.__docshot.print.system.length === 1", { timeout: 10000 });
    assert.deepEqual(await systemCalls(), ['mac notes'], 'the title is the note\'s name without ".md"');
    assert.equal(await tones(), 'light', 'light for the paper while the dialog is open');
    assert.equal(await s.ev("document.getElementById('btn-preview-print').disabled"), true, 'no second press while it is open');
    assert.equal(await s.ev("document.getElementById('print-modal').classList.contains('hidden')"), true, 'no panel: the PDF is the system dialog\'s');
    assert.equal(await s.ev("typeof window.PrintPanel"), 'undefined', 'the panel\'s script is not even loaded');
    await s.waitFor("document.getElementById('btn-preview-print').disabled === false", { timeout: 10000 });
    assert.equal(await tones(), 'dark', 'the diagram is back in its tone');
    assert.equal(await printCalls(), 0, 'window.print() does nothing in WKWebView and is not used');
    assert.equal(await s.ev("document.querySelectorAll('#preview-pane pre.mermaid-card .mermaid-tone-btn').length"), 1, 'with its own tone button');

    t.step('a failure is one line, and everything is back (the button works again)');
    await s.ev("window.__docshot.print.systemDelay = 0; window.__docshot.print.systemReject = 'no printer service'; 1");
    await click(s, 'btn-preview-print');
    await s.waitFor("window.__docshot.print.system.length === 2", { timeout: 10000 });
    await s.waitFor("document.getElementById('btn-preview-print').disabled === false", { timeout: 10000 });
    assert.equal(await tones(), 'dark');
    const toasts = (await s.state()).toasts;
    assert.ok(toasts.some((x) => String(x).includes('no printer service')), `a toast says why: ${toasts}`);
    await s.ev("window.__docshot.print.systemReject = ''; 1");
    await click(s, 'btn-preview-print');
    await s.waitFor("window.__docshot.print.system.length === 3", { timeout: 10000 });
    await s.waitFor("document.getElementById('btn-preview-print').disabled === false", { timeout: 10000 });
    assert.equal(await printCalls(), 0);
  }
};
