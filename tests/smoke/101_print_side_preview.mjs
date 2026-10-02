// The printer button of the PREVIEW BESIDE THE EDITOR (Ctrl+Alt+V): it sat only on the full preview, so a person who works with the preview
// on the right (the usual way) found no button. Now the header of the right-hand pane has one while the pane shows the preview. It prints
// that pane and the note IT shows (the pane's own tab, which is what its title says): the print panel is asked for that note's name, and
// under the print media the page is that pane alone (white, black text, nothing of the editor or the pane's header). The full preview's
// button works as before afterwards.
import { assert, click, rpc, settle } from './lib.mjs';

const NOTE_A = `# First note

Text of the first note, shown in the side preview.

\`\`\`mermaid
flowchart LR
  A[one] --> B[two]
\`\`\`
`;
const NOTE_B = '# Second note\n\nText of the second note, in the editor.\n';

export default {
  title: 'printing the side preview: a button in the pane header, the note the pane shows, the print style for that pane, and the full preview still prints',
  session: { notes: [{ title: 'first.md', content: NOTE_A }, { title: 'second.md', content: NOTE_B }] },
  timeoutMs: 60000,

  async run(s, t) {
    const display = (sel) => s.ev(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e).display : 'absent'; })()`);
    const css = (sel, prop) => s.ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}]`);
    const printMedia = (on) => s.page.cdp.send('Emulation.setEmulatedMedia', { media: on ? 'print' : '' });
    const asks = () => s.ev("window.__docshot.calls.filter(function (c) { return c.fn === 'printPreview'; }).map(function (c) { return c.args[0].title; })");
    const panelReady = "!document.getElementById('print-modal').classList.contains('hidden') && !!document.querySelector('#print-stage embed')";
    const pane = () => s.ev('document.body.dataset.printPane || ""');
    const tones = () => s.ev("Array.from(document.querySelectorAll('#secondary-preview-pane pre.mermaid-card')).map(function (e) { return e.classList.contains('tone-dark') ? 'dark' : e.classList.contains('tone-light') ? 'light' : '?'; }).join(',')");
    const closePanel = async () => {
      await s.key('Escape');
      await s.waitFor("document.getElementById('print-modal').classList.contains('hidden')");
    };

    t.step('in the editor neither printer button is there');
    assert.equal(await display('#btn-preview-print'), 'none');
    assert.equal(await s.ev("document.getElementById('btn-secondary-print').hidden"), true, 'the side pane is closed, and so is its button');

    t.step('the preview opened beside the editor has the button in its header (and the full preview\'s button is still not there)');
    await s.key('v', { ctrl: true, alt: true });
    await s.waitFor("document.querySelectorAll('#secondary-preview-pane pre.mermaid-card svg[id^=mermaid]').length === 1", { timeout: 20000 });
    assert.equal(await s.ev("document.getElementById('btn-secondary-print').hidden"), false);
    const rect = await s.ev("(function () { var r = document.getElementById('btn-secondary-print').getBoundingClientRect(); var h = document.getElementById('secondary-pane-header').getBoundingClientRect(); return { w: r.width, h: r.height, inHeader: r.top >= h.top && r.bottom <= h.bottom + 1 }; })()");
    assert.ok(rect.w >= 18 && rect.h >= 18 && rect.inHeader, `a usable button in the header: ${JSON.stringify(rect)}`);
    assert.equal(await display('#btn-preview-print'), 'none', 'the full preview is not open');
    assert.equal(await tones(), 'dark');

    t.step('the press opens the print panel for the note of that pane, tells the style which pane it is, and draws its diagram light');
    await click(s, 'btn-secondary-print');
    await s.waitFor(panelReady, { timeout: 20000 });
    assert.deepEqual(await asks(), ['first.md']);
    assert.equal(await pane(), 'secondary', 'css/print.css is told which pane is printed');
    assert.equal(await tones(), 'light', 'the diagram of that pane is drawn light for the paper');
    assert.equal(await s.ev("document.getElementById('btn-secondary-print').disabled && document.getElementById('btn-preview-print').disabled"), true, 'no second press while it is open');

    t.step('under the print media the page is the side preview alone: white, black text, none of the editor, the pane\'s header or the panel');
    await printMedia(true);
    try {
      for (const sel of ['#editor-pane', '#secondary-pane-header', '#print-modal', '#header', '#status-bar', '#pane-resizer', '#preview-pane']) {
        assert.equal(await display(sel), 'none', `${sel} is not printed`);
      }
      assert.equal(await display('#secondary-pane'), 'block');
      assert.equal(await css('#secondary-pane', 'position'), 'static');
      assert.equal(await display('#secondary-preview-pane'), 'block');
      assert.equal(await css('#secondary-preview-pane', 'backgroundColor'), 'rgb(255, 255, 255)', 'white paper');
      assert.equal(await css('#secondary-preview-pane', 'overflowY'), 'visible', 'not a scroll box: every page is printed');
      assert.equal(await css('#secondary-preview-pane', 'borderTopWidth'), '0px', 'no accent frame on paper');
      assert.equal(await css('#secondary-preview-pane h1', 'color'), 'rgb(0, 0, 0)', 'black headings (on screen they are coloured)');
      assert.equal(await css('#secondary-preview-pane pre.mermaid-card', 'backgroundColor'), 'rgb(255, 255, 255)');
    } finally {
      await printMedia(false);
    }

    t.step('closing the panel puts everything back: the diagram, the buttons, and what the page says it prints');
    await closePanel();
    assert.equal(await pane(), '');
    assert.equal(await tones(), 'dark');
    assert.equal(await s.ev("document.getElementById('btn-secondary-print').disabled || document.getElementById('btn-preview-print').disabled"), false);
    assert.equal(await s.ev("document.getElementById('preview-pane').classList.contains('hidden')"), true);

    t.step('another note chosen in the editor: what is printed is the note the side pane shows (its title says which)');
    const [, second] = (await s.state()).tabs.map((x) => x.id);
    assert.equal((await rpc(s, `switchTab(${JSON.stringify(second)})`)).ok, true);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(second)}`);
    await settle(400);
    const shownInPane = await s.ev("document.getElementById('secondary-pane-title').textContent");
    assert.ok(/\.md$/.test(shownInPane), shownInPane);
    await click(s, 'btn-secondary-print');
    await s.waitFor(panelReady, { timeout: 20000 });
    assert.deepEqual(await asks(), ['first.md', shownInPane], 'the panel asked for the note of the side pane');
    await closePanel();

    t.step('the pane back to the editor: its button goes (there is no preview to print), and comes back with the preview');
    await click(s, 'btn-secondary-mode');
    await s.waitFor("document.getElementById('btn-secondary-print').hidden === true");
    await click(s, 'btn-secondary-mode');
    await s.waitFor("document.getElementById('btn-secondary-print').hidden === false");

    t.step('the full preview still prints its own note, and the style gets no side-pane mark');
    await click(s, 'btn-secondary-close');
    await s.waitFor("document.getElementById('secondary-pane').classList.contains('hidden')");
    await s.key('p', { ctrl: true });
    await s.waitFor("!document.getElementById('preview-pane').classList.contains('hidden')");
    assert.equal(await display('#btn-preview-print'), 'flex');
    await click(s, 'btn-preview-print');
    await s.waitFor(panelReady, { timeout: 20000 });
    assert.deepEqual(await asks(), ['first.md', shownInPane, 'second.md'], 'the full preview shows the note in the editor');
    assert.equal(await pane(), '', 'no secondary mark for the full preview');
    await printMedia(true);
    try {
      assert.equal(await display('#preview-pane'), 'block');
      assert.equal(await css('#preview-pane', 'backgroundColor'), 'rgb(255, 255, 255)');
      assert.equal(await display('#secondary-pane'), 'none');
    } finally {
      await printMedia(false);
    }
    await closePanel();
  }
};
