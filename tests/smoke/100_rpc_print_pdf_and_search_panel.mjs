// Two page calls of the JSON-RPC server (window.__mdMemoRPC), behind `print.pdf` and `ui.open_panel`:
//  - printPdf(tabId, settings, outPath): a note as a PDF. The tab's preview is shown, the diagrams are light for the paper, the engine is asked
//    (backend.printSavePdf, the mock here) with the note's name and folder and the settings, and afterwards the window is as it was: the tab
//    that was active, the preview (off, full or side) and the diagrams' tone. A second call while one runs, an HTML page and an unknown tab
//    are errors that leave the window alone.
//  - openPanel('scraps_search', {query, mode}): the notes search in that mode, with that text, searched at once; the Deep search button is
//    still the person's to press. Meaning needs semantic search turned on in config.json (invalid_params otherwise).
import { assert, rpc, shown, waitShown } from './lib.mjs';
import { SEMANTIC_ON, asked } from './semantic_lib.mjs';

const NOTE_A = `# First

\`\`\`mermaid
flowchart LR
  A[one] --> B[two]
\`\`\`
`;
const NOTE_B = '# Second\n\nText of the second note.\n';
const PATH_B = 'C:\\Users\\demo\\Documents\\notes\\second.md';

export default {
  title: 'RPC print.pdf and ui.open_panel(query, mode): the PDF of a tab with the window put back, the notes search opened in a mode with a query',
  session: { ...SEMANTIC_ON, notes: [{ title: 'first.md', content: NOTE_A }, { title: 'second.md', path: PATH_B, content: NOTE_B }] },
  timeoutMs: 60000,

  async run(s, t) {
    const tabs = async () => (await s.state()).tabs;
    const ids = async () => (await tabs()).map((x) => x.id);
    const view = async () => (await rpc(s, 'getUiState()')).ok;
    const tones = () => s.ev("Array.from(document.querySelectorAll('#preview-pane pre.mermaid-card')).map(function (e) { return e.classList.contains('tone-dark') ? 'dark' : e.classList.contains('tone-light') ? 'light' : '?'; }).join(',')");
    const lightLeft = () => s.ev("document.querySelectorAll('#preview-pane .tone-light').length"); // a diagram still drawn for paper
    const requests = () => s.ev('(window.__docshot.print.requests || []).slice()');
    const saved = () => s.ev('window.__docshot.print.saved.slice()');
    const button = () => s.ev("document.getElementById('btn-preview-print').disabled");
    const OUT = 'C:\\Users\\demo\\Documents\\out\\one.pdf';
    const settings = { paper: 'a3', landscape: true, margin: 'narrow', scale: 80, pages: '1-2', headerFooter: true };

    t.step('the notes search opens in Meaning with a query and searches it at once (the Deep search button is not pressed for the person)');
    let [a, b] = await ids();
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), []);
    let r = await rpc(s, 'openPanel("scraps_search", {query: "bamboo growth", mode: "meaning"})');
    assert.deepEqual(r.ok, { panel: 'scraps_search', mode: 'meaning' }, JSON.stringify(r));
    await waitShown(s, 'scraps-search-modal');
    assert.equal(await s.ev("document.getElementById('scraps-search-input').value"), 'bamboo growth');
    assert.equal(await s.ev("document.getElementById('scraps-mode-meaning').getAttribute('aria-pressed')"), 'true');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0 && !document.getElementById('btn-scraps-deep').classList.contains('hidden')");
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), [['bamboo growth', 10]], 'one meaning search, for the text given');
    assert.equal(await shown(s, 'deep-search-modal'), false, 'no deep search was started: the dialog that says what would be sent waits for the person');

    t.step('the same panel opened again in Exact with another query: that mode, that text, the plain search');
    r = await rpc(s, 'openPanel("scraps_search", {query: "API", mode: "exact"})');
    assert.deepEqual(r.ok, { panel: 'scraps_search', mode: 'exact' }, JSON.stringify(r));
    assert.equal(await s.ev("document.getElementById('scraps-search-input').value"), 'API');
    assert.equal(await s.ev("document.getElementById('scraps-mode-exact').getAttribute('aria-pressed')"), 'true');
    await s.waitFor("(window.__docshot.calls.filter(function (c) { return c.fn === 'searchScraps'; }).length) > 0");
    assert.equal((await asked(s, 'searchScrapsSemantic')).length, 1, 'no second meaning search');

    t.step('a query alone keeps the mode that is on; no query and no mode is the plain opening (the answer has no mode)');
    r = await rpc(s, 'openPanel("scraps_search", {query: "rice"})');
    assert.deepEqual(r.ok, { panel: 'scraps_search', mode: 'exact' }, JSON.stringify(r));
    assert.equal(await s.ev("document.getElementById('scraps-search-input').value"), 'rice');
    r = await rpc(s, 'openPanel("scraps_search")');
    assert.deepEqual(r.ok, { panel: 'scraps_search' }, JSON.stringify(r));
    await s.key('Escape');

    t.step('print.pdf: the active tab\'s preview is printed with the settings, and the window is as it was');
    assert.equal((await view()).preview, 'off');
    assert.equal(await s.ev("document.getElementById('btn-preview-print') ? document.getElementById('btn-preview-print').disabled : null"), false);
    r = await rpc(s, `printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.deepEqual(Object.keys(r.ok || {}).sort(), ['bytes', 'pages', 'path', 'tab_id'], JSON.stringify(r));
    assert.equal(r.ok.path, OUT);
    assert.equal(r.ok.tab_id, a, 'the active tab was the one printed');
    assert.deepEqual(await saved(), [OUT]);
    let asks = await requests();
    assert.equal(asks.length, 1);
    assert.deepEqual({ ...asks[0], title: undefined, location: undefined }, { paper: 'a3', landscape: true, margin: 'narrow', scale: 80, pages: '1-2', headerFooter: true, title: undefined, location: undefined }, 'every setting reached the engine, the scale as given (not rounded to the panel\'s list)');
    assert.equal(asks[0].title, 'first.md');
    assert.equal(asks[0].location, await s.ev('I18N[document.documentElement.lang].printUnsaved'), 'a note that is not a file says so');
    assert.equal((await view()).preview, 'off', 'the preview is off again');
    assert.equal((await view()).activeTabId, a);
    assert.equal(await lightLeft(), 0, 'no diagram is left drawn for paper');
    assert.equal(await button(), false, 'the printer button works again');
    assert.equal(await shown(s, 'print-modal'), false, 'no panel was opened');

    t.step('another tab: it is shown for the print and the first one is active again afterwards; its name and folder reach the engine');
    r = await rpc(s, `printPdf(${JSON.stringify(b)}, ${JSON.stringify({ ...settings, headerFooter: false, pages: '' })}, ${JSON.stringify(OUT)})`);
    assert.equal(r.ok && r.ok.tab_id, b, JSON.stringify(r));
    asks = await requests();
    assert.equal(asks.length, 2);
    assert.equal(asks[1].title, 'second.md');
    assert.equal(asks[1].location, 'C:\\Users\\demo\\Documents\\notes', 'the folder of the file');
    assert.equal(asks[1].headerFooter, false);
    assert.equal((await view()).activeTabId, a, 'the tab that was active is active again');
    assert.equal((await view()).preview, 'off');

    t.step('a preview that was open stays open (full), and a side preview comes back as a side preview');
    assert.ok((await rpc(s, 'setUiState({preview: "full"})')).ok);
    r = await rpc(s, `printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await view()).preview, 'full');
    assert.equal(await tones(), 'dark');
    assert.ok((await rpc(s, 'setUiState({preview: "side"})')).ok);
    r = await rpc(s, `printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((await view()).preview, 'side', 'the side preview is back');
    assert.ok((await rpc(s, 'setUiState({preview: "off"})')).ok);

    t.step('errors leave the window alone: an unknown tab, a call while one runs, an engine that fails');
    const before = await saved();
    r = await rpc(s, `printPdf("tab_nope", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.equal(r.kind, 'not_found', JSON.stringify(r));
    await s.ev('window.__docshot.print.delays = [800]; window.__docshot.print.saveDelay = 800; 1');
    const first = s.ev(`window.__mdMemoRPC.printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)}).then(function () { return 'done'; }, function (e) { return 'ERR ' + e.message; })`);
    await s.waitFor('document.getElementById("btn-preview-print").disabled === true', { timeout: 10000 });
    r = await rpc(s, `printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.equal(r.kind, 'conflict', `a second print while one is in progress: ${JSON.stringify(r)}`);
    assert.equal(await first, 'done');
    await s.ev("window.__docshot.print.saveReject = 'the engine said no'; 1");
    r = await rpc(s, `printPdf("", ${JSON.stringify(settings)}, ${JSON.stringify(OUT)})`);
    assert.ok(r.err && r.err.includes('the engine said no'), JSON.stringify(r));
    await s.ev("window.__docshot.print.saveReject = ''; 1");
    assert.equal((await view()).preview, 'off', 'a failure puts the view back too');
    assert.equal(await lightLeft(), 0);
    assert.equal(await button(), false);
    assert.equal((await saved()).length, before.length + 1, 'only the call that was allowed to finish wrote');
  }
};
