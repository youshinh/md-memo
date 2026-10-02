// The print panel (print_panel.js): the settings are on the RIGHT of the page preview, the header and footer are off unless switched on and
// then carry the file's name (above) and its folder (below), every change asks the backend for a new preview once (after a pause; an
// older answer never replaces a newer one), a failure is one line with the way out, "Save as PDF" asks where and writes, closing frees
// the viewer, and what was chosen is remembered (a page range is not). The backend is the mock (a blank PDF).
import { assert, click, clickSelector, settle } from './lib.mjs';
import { phrase } from './semantic_lib.mjs';

const NOTE = '# Print\n\nSome text for the page.\n';
const PATH = 'C:\\Users\\demo\\Documents\\notes\\print.md';

export default {
  title: 'print panel: settings on the right, header and footer off by default (file name and folder when on), one preview per change, failures, saving, remembered choices',
  session: { notes: [{ title: 'print.md', path: PATH, content: NOTE }, { title: 'draft.md', content: NOTE }] },
  timeoutMs: 60000,

  async run(s, t) {
    const ready = "!document.getElementById('print-modal').classList.contains('hidden') && !!document.querySelector('#print-stage embed')";
    const asks = () => s.ev("window.__docshot.calls.filter(function (c) { return c.fn === 'printPreview'; }).map(function (c) { return JSON.parse(JSON.stringify(c.args[0])); })");
    const callsOf = (fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${JSON.stringify(fn)}; }).map(function (c) { return JSON.parse(JSON.stringify(c.args)); })`);
    const embedSrc = () => s.ev("(document.querySelector('#print-stage embed') || {}).src || ''");
    const statusText = () => s.ev("(function () { var e = document.getElementById('print-status'); return e.classList.contains('hidden') ? '' : e.textContent; })()");
    const shown = () => s.ev("!document.getElementById('print-modal').classList.contains('hidden')");
    const setSelect = (id, value) => s.ev(`(function () { var e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    const waitAsks = (n) => s.waitFor(`window.__docshot.calls.filter(function (c) { return c.fn === 'printPreview'; }).length >= ${n}`, { timeout: 10000 });
    const openPanel = async () => {
      await click(s, 'btn-preview-print');
      await s.waitFor(ready, { timeout: 20000 });
    };
    const closePanel = async () => {
      await s.key('Escape');
      await s.waitFor("document.getElementById('print-modal').classList.contains('hidden')");
    };

    await click(s, 'btn-toggle-preview');
    await s.waitFor("!document.getElementById('preview-pane').classList.contains('hidden')");

    t.step('it opens with the defaults; the header and footer are off; the settings are on the right of the page preview');
    await openPanel();
    let all = await asks();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], { paper: 'a4', landscape: false, margin: 'normal', scale: 100, pages: '', headerFooter: false, title: 'print.md', location: 'C:\\Users\\demo\\Documents\\notes' });
    assert.equal(await s.ev("document.getElementById('print-header-footer').checked"), false, 'the header and footer are off by default');
    const rects = await s.ev("(function () { var side = document.querySelector('.print-side').getBoundingClientRect(), stage = document.querySelector('.print-stage').getBoundingClientRect(); return { sideLeft: side.left, stageRight: stage.right, stageLeft: stage.left, sideW: side.width, stageW: stage.width }; })()");
    assert.ok(rects.sideLeft >= rects.stageRight - 1, `the settings (from ${rects.sideLeft}) are right of the preview (to ${rects.stageRight})`);
    assert.ok(rects.stageW > rects.sideW, 'the preview is the wide part');
    const src = await embedSrc();
    assert.ok(/^data:application\/pdf/.test(src) && /#zoom=\d+$/.test(src), `the viewer shows the PDF at a zoom that leaves a margin round the sheet: ${src.slice(-30)}`);
    const zoom = Number(src.match(/#zoom=(\d+)$/)[1]);
    const stageW = await s.ev("document.querySelector('.print-stage').clientWidth");
    const sheetW = 8.27 * 96 * zoom / 100;
    assert.ok(stageW - sheetW >= 2 * 20 + 16 - 8 && stageW - sheetW <= 2 * 20 + 16 + 14, `the A4 sheet (${sheetW.toFixed(0)} px) leaves a margin on both sides in the pane (${stageW} px)`);
    assert.equal(await s.ev("document.getElementById('print-save').disabled"), false, 'saving is possible once there is a preview');
    assert.equal(await statusText(), '', 'no message');
    assert.equal(await s.ev("document.getElementById('print-summary').textContent"), `A4 · ${await phrase(s, 'printPortrait')} · ${await phrase(s, 'printPageCount', { n: 4 })}`);
    assert.equal(await s.ev("document.querySelector('.print-card h3').textContent"), await phrase(s, 'printTitle'));

    t.step('every change asks for a new preview: orientation, paper, margins, scale; a range after a pause, once; the header and footer');
    await click(s, 'print-landscape');
    await waitAsks(2);
    await setSelect('print-paper', 'a3');
    await waitAsks(3);
    await click(s, 'print-margin-narrow');
    await waitAsks(4);
    await setSelect('print-scale', '125');
    await waitAsks(5);
    await s.ev("(function () { var e = document.getElementById('print-pages'); e.value = '1'; e.dispatchEvent(new Event('input', { bubbles: true })); e.value = '1-2'; e.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
    await waitAsks(6);
    await settle(700);
    assert.equal((await asks()).length, 6, 'two edits of the range in a moment are one request');
    await s.ev("document.getElementById('print-header-footer').click(); 1");
    await waitAsks(7);
    all = await asks();
    assert.deepEqual(all[1], { ...all[0], landscape: true });
    assert.equal(all[2].paper, 'a3');
    assert.equal(all[3].margin, 'narrow');
    assert.equal(all[4].scale, 125);
    assert.deepEqual(all[5].pages, '1-2');
    assert.deepEqual(all[6], { paper: 'a3', landscape: true, margin: 'narrow', scale: 125, pages: '1-2', headerFooter: true, title: 'print.md', location: 'C:\\Users\\demo\\Documents\\notes' }, 'on: the file name for the top, its folder for the bottom');
    assert.equal(await s.ev("document.getElementById('print-summary').textContent"), `A3 · ${await phrase(s, 'printLandscape')} · ${await phrase(s, 'printPageCount', { n: 4 })}`);
    const stored = JSON.parse(await s.ev("localStorage.getItem('md_memo_print_settings')"));
    assert.deepEqual(stored, { paper: 'a3', landscape: true, margin: 'narrow', scale: 125, pages: '1-2', headerFooter: true }, 'the choices are kept');

    t.step('closed and opened again: the choices are back (not the range), and one change is one request (no handler is stacked)');
    await closePanel();
    assert.equal(await s.ev("document.querySelectorAll('#print-stage embed').length"), 0, 'the viewer is gone with the panel');
    await openPanel();
    all = await asks();
    const first = all[all.length - 1];
    assert.deepEqual(first, { paper: 'a3', landscape: true, margin: 'narrow', scale: 125, pages: '', headerFooter: true, title: 'print.md', location: 'C:\\Users\\demo\\Documents\\notes' });
    assert.equal(await s.ev("document.getElementById('print-pages').value"), '');
    const before = all.length;
    await setSelect('print-scale', '90');
    await waitAsks(before + 1);
    await settle(600);
    assert.equal((await asks()).length, before + 1, 'exactly one request for one change');

    t.step('a slow answer that a newer request overtakes does not replace it');
    await s.ev("window.__docshot.print.delays = [800, 0]; 1");
    const n0 = (await asks()).length;
    await setSelect('print-paper', 'b5'); // the slow one
    await waitAsks(n0 + 1);
    await click(s, 'print-portrait'); // the fast one
    await waitAsks(n0 + 2);
    await settle(1500);
    const seq = await s.ev('window.__docshot.print.seq');
    assert.ok(new RegExp('#mock' + seq + '#zoom=\\d+$').test(await embedSrc()), `the viewer holds the newest answer (mock${seq}), not the slow one: ${(await embedSrc()).slice(-30)}`);
    assert.equal(await s.ev("document.querySelectorAll('#print-stage embed').length"), 1);
    assert.equal(await s.ev("document.getElementById('print-summary').textContent").then((x) => x.startsWith('B5 ')), true);

    t.step('a failure is one line, the viewer goes, saving is off; the next good change brings it back');
    await s.ev("window.__docshot.print.reject = 'the engine said no'; 1");
    await setSelect('print-scale', '100');
    await s.waitFor("!document.getElementById('print-status').classList.contains('hidden')");
    assert.equal(await statusText(), await phrase(s, 'printFailed', { message: 'the engine said no' }));
    assert.equal(await s.ev("document.getElementById('print-status').classList.contains('print-status-error')"), true);
    assert.equal(await s.ev("document.querySelectorAll('#print-stage embed').length"), 0);
    assert.equal(await s.ev("document.getElementById('print-save').disabled"), true);
    await s.ev("window.__docshot.print.reject = ''; 1");
    await setSelect('print-scale', '90');
    await s.waitFor(ready, { timeout: 10000 });
    assert.equal(await statusText(), '');
    assert.equal(await s.ev("document.getElementById('print-save').disabled"), false);

    t.step('Save as PDF: the Save dialog is offered the note\'s name, the PDF is written there, a toast says where, the panel closes');
    await click(s, 'print-save');
    await s.waitFor("document.getElementById('print-modal').classList.contains('hidden')", { timeout: 10000 });
    const picks = await callsOf('printPickPdfPath');
    assert.deepEqual(picks.map((c) => c[0]), ['print.md']);
    const saves = await callsOf('printSavePdf');
    assert.equal(saves.length, 1);
    const savedTo = await s.ev('window.__docshot.print.pickPath');
    assert.equal(saves[0][1], savedTo);
    assert.equal(saves[0][0].title, 'print.md');
    assert.equal(saves[0][0].headerFooter, true);
    const toasts = (await s.state()).toasts;
    assert.ok(toasts.some((x) => String(x).includes(savedTo)), `a toast names the file: ${toasts}`);
    assert.equal(await s.ev('window.__docshot.print.closed') >= 2, true, 'the PDF kept by the backend was dropped');

    t.step('the Save dialog cancelled: nothing is written and the panel stays; a failing write is one line and the panel stays');
    await openPanel();
    await s.ev("window.__docshot.print.pickPath = ''; 1");
    await click(s, 'print-save');
    await settle(500);
    assert.equal((await callsOf('printSavePdf')).length, 1, 'cancelled: nothing more was written');
    assert.equal(await shown(), true);
    assert.equal(await s.ev("document.getElementById('print-save').disabled"), false, 'and saving is possible again');
    await s.ev("window.__docshot.print.pickPath = 'C:\\\\x\\\\y.pdf'; window.__docshot.print.saveReject = 'disk full'; 1");
    await click(s, 'print-save');
    await s.waitFor("!document.getElementById('print-status').classList.contains('hidden')");
    assert.equal(await statusText(), await phrase(s, 'printSaveFailed', { message: 'disk full' }));
    assert.equal(await shown(), true);
    assert.equal(await s.ev("document.getElementById('print-save').disabled"), false);
    await s.ev("window.__docshot.print.saveReject = ''; 1");
    await closePanel();

    t.step('a note that is not a file says so in the footer: "(not saved yet)"');
    const draft = (await s.state()).tabs.find((tab) => tab.title.indexOf('draft') >= 0);
    await clickSelector(s, `.tab-item[data-tab-id="${draft.id}"]`);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(draft.id)}`);
    await openPanel();
    all = await asks();
    const last = all[all.length - 1];
    assert.equal(last.title, 'draft.md');
    assert.equal(last.location, await phrase(s, 'printUnsaved'));
    assert.equal(last.headerFooter, true, 'the switch was left on: the choice is remembered');
    await closePanel();
  }
};
