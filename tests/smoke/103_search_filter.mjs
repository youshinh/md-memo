// The filter row of the daily notes search (Ctrl+Shift+F): a period and tags that narrow every search of the panel.
// docs/design/tag-filter-2026-10.md section 5. The backend is the mock (tools/docshots/mock/backend.js: three daily notes with tags, the twelve
// meaning hits with tags, and window.__docshot.filter for more notes / a fixed tag list / a failure); the mock clock says it is 2026-09-18.
//   - an older backend (no scrapFilterOptions) gets no filter button and no filter argument with its searches
//   - the tag list is asked for once, when the area is first opened in an opening of the panel, and never before
//   - a tag narrows the list and goes to the backend in the filter; two tags are both required; a period becomes from / to; Clear resets
//   - the line about notes without a date is there only with a period and at least one such note
//   - an empty list under a filter says it is the filter; the meaning search and the Deep search are given the same filter as the list on screen
//   - the keys are the panel's own: the buttons are out of the Tab order, Tab still quotes the line, Enter opens it, Esc closes the panel
import { assert, click, clickSelector, focusEditor, selectInEditor, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';
import { SEMANTIC_ON, itemCount, openSearch, phrase, textOf, typeQuery, visible, waitMeaningList } from './semantic_lib.mjs';

// The mock's notes (their file-wide tags): 2026-09-17 work idea, 2026-09-15 work urgent, 2026-09-12 reading. The meaning hits are the days
// 2026-09-28 down to 2026-09-17; of those work is on 28 26 24 22 20 18 17 and urgent on 28 24 20.
const ALL = ['2026-09-17.md', '2026-09-15.md', '2026-09-12.md'];
const WEEK = { from: '2026-09-12', to: '2026-09-18' };

export default {
  title: 'daily notes search filter: tags and period narrow every search, asked once and only when opened, undated line, empty sentence, same filter for meaning and Deep search, keys unchanged',
  session: { ...SEMANTIC_ON, notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 90000,

  async run(s, t) {
    const q = (v) => JSON.stringify(v);
    const callsOf = (fn) => s.ev(`window.__docshot.calls.filter(function (c) { return c.fn === ${q(fn)}; })`);
    const lastCall = async (fn) => { const c = await callsOf(fn); return c.length ? c[c.length - 1] : null; };
    const optionCalls = async () => (await callsOf('scrapFilterOptions')).length;
    // Waits until the newest call of fn carries exactly this filter (null = none): the search for it has started
    const waitFilter = (fn, filter) => s.waitFor(`(function () {
      var c = window.__docshot.calls.filter(function (x) { return x.fn === ${q(fn)}; });
      return c.length > 0 && JSON.stringify(c[c.length - 1].filter) === ${q(JSON.stringify(filter))};
    })()`);
    // Waits until the newest call of fn was made for this text and filter. (A list of the same notes can already be on screen from the
    // search of the word the panel opened with, so the names alone do not say that the answer to this text has come.)
    const waitSearch = (fn, text, filter) => s.waitFor(`(function () {
      var c = window.__docshot.calls.filter(function (x) { return x.fn === ${q(fn)}; });
      var l = c[c.length - 1];
      return !!l && l.args[0] === ${q(text)} && JSON.stringify(l.filter) === ${q(JSON.stringify(filter))};
    })()`);
    // Types the text in the box and waits for the search of it
    const search = async (text, filter = null) => { await typeQuery(s, text); await waitSearch('searchScraps', text, filter); };
    const names = () => s.ev("Array.from(document.querySelectorAll('#scraps-search-results .scraps-match-file')).map(function (e) { return e.textContent; })");
    const waitNames = (list) => s.waitFor(`JSON.stringify(Array.from(document.querySelectorAll('#scraps-search-results .scraps-match-file')).map(function (e) { return e.textContent; })) === ${q(JSON.stringify(list))}`);
    const emptyText = () => textOf(s, '#scraps-search-results .scraps-search-empty');
    const chip = (kind, value) => `[data-filter-${kind}="${value}"]`;
    const pressed = (selector) => s.ev(`(function () { var e = document.querySelector(${q(selector)}); return e ? e.getAttribute('aria-pressed') : null; })()`);
    const pressedAll = (kind) => s.ev(`Array.from(document.querySelectorAll('#scraps-filter-area [data-filter-${kind}]')).map(function (e) { return e.getAttribute('data-filter-${kind}') + ':' + e.getAttribute('aria-pressed'); })`);
    const tagNames = () => s.ev("Array.from(document.querySelectorAll('#scraps-filter-area [data-filter-tag]')).map(function (e) { return e.getAttribute('data-filter-tag'); })");
    const buttonCount = () => textOf(s, '#scraps-filter-count');
    const noteLines = () => s.ev("Array.from(document.querySelectorAll('#scraps-filter-area .scraps-filter-note')).map(function (e) { return e.textContent; })");
    const areaOpen = () => visible(s, 'scraps-filter-area');
    const pick = async (kind, value) => { await clickSelector(s, chip(kind, value)); await waitFocus(s, 'scraps-search-input'); };
    // Opens the area and waits until the tags have come (or have failed): the periods are there at once, the tags a moment later
    const openArea = async () => {
      await click(s, 'btn-scraps-filter');
      await waitFocus(s, 'scraps-search-input');
      await s.waitFor("document.querySelectorAll('#scraps-filter-area .scraps-filter-chip').length >= 5 && !document.querySelector('#scraps-filter-area .scraps-filter-status:not(.scraps-filter-status-error)')");
    };
    const closePanel = async () => { await s.key('Escape'); await waitHidden(s, 'scraps-search-modal'); };

    t.step('an older backend (no scrapFilterOptions): no filter button, and the searches carry no filter');
    await s.ev('window.__savedFilterOptions = window.backend.scrapFilterOptions; delete window.backend.scrapFilterOptions; 1');
    await openSearch(s);
    assert.equal(await visible(s, 'scraps-filter'), false, 'the row is hidden');
    assert.equal(await visible(s, 'btn-scraps-filter'), false, 'and so is its button');
    await search('API');
    await waitNames(ALL);
    let c = await lastCall('searchScraps');
    assert.deepEqual(c.args, ['API', 100]);
    assert.equal(c.filter, null, 'no filter: the search is the one it always was');
    assert.equal(await optionCalls(), 0);
    await closePanel();
    await s.ev('window.backend.scrapFilterOptions = window.__savedFilterOptions; 1');

    t.step('a backend that can list tags: the button is there, closed, and nothing is built or asked for');
    await openSearch(s);
    assert.equal(await visible(s, 'btn-scraps-filter'), true);
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').getAttribute('aria-expanded')"), 'false');
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').getAttribute('tabindex')"), '-1', 'out of the Tab order');
    assert.equal(await textOf(s, '#btn-scraps-filter span:not(#scraps-filter-count)'), await phrase(s, 'scrapsFilterButton'));
    assert.equal(await buttonCount(), '', 'nothing is chosen: no count');
    assert.equal(await areaOpen(), false);
    assert.equal(await s.ev("document.getElementById('scraps-filter-area').childElementCount"), 0, 'the area is empty until it is opened');
    await search('API');
    await waitNames(ALL);
    assert.equal(await optionCalls(), 0, 'searching does not ask for the tags');
    c = await lastCall('searchScraps');
    assert.deepEqual(c.args, ['API', 100]);
    assert.equal(c.filter, null, 'no filter chosen: null');

    t.step('opening the area asks for the tags once; most used first, a period list with "all" chosen, every button out of the Tab order');
    await openArea();
    assert.equal(await areaOpen(), true);
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').getAttribute('aria-expanded')"), 'true');
    assert.equal(await optionCalls(), 1);
    assert.deepEqual(await tagNames(), ['work', 'reading', 'urgent', 'idea'], 'by the number of notes: work 8, reading 5, urgent 4, idea 1');
    assert.deepEqual(await pressedAll('period'), ['all:true', 'today:false', 'week:false', 'days30:false', 'month:false']);
    assert.deepEqual(await pressedAll('tag'), ['work:false', 'reading:false', 'urgent:false', 'idea:false']);
    assert.equal(await s.ev("Array.from(document.querySelectorAll('#scraps-filter button')).filter(function (b) { return b.getAttribute('tabindex') !== '-1'; }).length"), 0, 'no filter button takes the Tab key');
    assert.equal(await s.ev("document.querySelector('#scraps-filter-area [data-filter-tag=\"work\"]').title"), await phrase(s, 'scrapsFilterTagNotes', { n: 8 }));
    assert.deepEqual(await noteLines(), [], 'no period: no line about notes without a date');
    assert.equal(await s.ev("document.querySelectorAll('#scraps-filter-area [data-filter-clear]').length"), 0, 'nothing chosen: nothing to clear');
    await click(s, 'btn-scraps-filter');
    assert.equal(await areaOpen(), false, 'the button closes it');
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').getAttribute('aria-expanded')"), 'false');
    await openArea();
    assert.equal(await areaOpen(), true);
    assert.equal(await optionCalls(), 1, 'opened again in the same opening of the panel: not asked again');

    t.step('a tag narrows the list; the filter goes to the backend; the caret is back in the box; the button counts');
    const before = (await callsOf('searchScraps')).length;
    await pick('tag', 'work');
    await waitFilter('searchScraps', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    assert.equal((await callsOf('searchScraps')).length, before + 1, 'one search for the change');
    assert.equal(await pressed(chip('tag', 'work')), 'true');
    assert.equal(await buttonCount(), '(1)');
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').classList.contains('on')"), true, 'the button is lit while something is chosen');
    assert.equal(await s.ev("document.getElementById('scraps-search-input').value"), 'API', 'the text is as it was');
    assert.deepEqual((await lastCall('searchScraps')).args, ['API', 100]);

    t.step('two tags are both required; letting one go widens the list again');
    await pick('tag', 'urgent');
    await waitFilter('searchScraps', { tags: ['work', 'urgent'] });
    await waitNames(['2026-09-15.md']);
    assert.equal(await buttonCount(), '(2)');
    await pick('tag', 'reading');
    await waitFilter('searchScraps', { tags: ['work', 'urgent', 'reading'] });
    await waitNames([]);
    assert.equal(await emptyText(), await phrase(s, 'scrapsFilterNoResults'), 'no note has all three: the sentence says it is the filter');
    await pick('tag', 'reading');
    await pick('tag', 'urgent');
    await waitFilter('searchScraps', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);

    t.step('a period becomes from / to (local days, the clock says 2026-09-18); the tags stay');
    await pick('period', 'week');
    await waitFilter('searchScraps', { tags: ['work'], ...WEEK });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    assert.equal(await buttonCount(), '(2)', 'a tag and a period');
    assert.deepEqual(await pressedAll('period'), ['all:false', 'today:false', 'week:true', 'days30:false', 'month:false']);
    await pick('period', 'today');
    await waitFilter('searchScraps', { tags: ['work'], from: '2026-09-18', to: '2026-09-18' });
    await waitNames([]);
    assert.equal(await emptyText(), await phrase(s, 'scrapsFilterNoResults'), 'the filtered sentence');
    assert.notEqual(await emptyText(), await phrase(s, 'scrapsSearchNoResults'), 'and not the one for a search with no filter');
    await pick('period', 'days30');
    await waitFilter('searchScraps', { tags: ['work'], from: '2026-08-20', to: '2026-09-18' });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    await pick('period', 'month');
    await waitFilter('searchScraps', { tags: ['work'], from: '2026-09-01', to: '2026-09-18' });
    await pick('period', 'all');
    await waitFilter('searchScraps', { tags: ['work'] });
    assert.equal(await buttonCount(), '(1)');

    t.step('Clear lets everything go: no tag, period "all", no count, no filter on the next search');
    await pick('tag', 'urgent');
    await pick('period', 'week');
    await waitFilter('searchScraps', { tags: ['work', 'urgent'], ...WEEK });
    assert.equal(await buttonCount(), '(3)');
    await clickSelector(s, '[data-filter-clear]');
    await waitFocus(s, 'scraps-search-input');
    await waitFilter('searchScraps', null);
    await waitNames(ALL);
    assert.equal(await buttonCount(), '');
    assert.deepEqual(await pressedAll('tag'), ['work:false', 'reading:false', 'urgent:false', 'idea:false']);
    assert.deepEqual(await pressedAll('period'), ['all:true', 'today:false', 'week:false', 'days30:false', 'month:false']);
    assert.equal(await s.ev("document.getElementById('btn-scraps-filter').classList.contains('on')"), false);
    assert.equal(await s.ev("document.querySelectorAll('#scraps-filter-area [data-filter-clear]').length"), 0, 'and Clear goes with them');
    await closePanel();

    t.step('notes without a date: the line is there only with a period chosen and at least one such note');
    await s.ev(`window.__docshot.filter.extra = [
      { fileName: '2026-08-01.md', lines: ['# 2026-08-01', '', '09:00 API review of the old schema', ''], tags: { file: ['work'] } },
      { fileName: 'scratch.md', lines: ['# scratch', '', 'API idea for later', ''], tags: { file: ['idea'] } }
    ]; 1`);
    await openSearch(s);
    await search('API');
    await waitNames([...ALL, '2026-08-01.md', 'scratch.md']);
    assert.equal(await optionCalls(), 1, 'a new opening of the panel has not asked yet');
    await openArea();
    assert.equal(await optionCalls(), 2, 'asked when the area was opened, once for this opening');
    assert.deepEqual(await noteLines(), [], 'no period yet: no line');
    await pick('period', 'today');
    await waitFilter('searchScraps', { from: '2026-09-18', to: '2026-09-18' });
    assert.deepEqual(await noteLines(), [await phrase(s, 'scrapsFilterUndatedOne')], 'one note has no date in its name and is in no period');
    await pick('period', 'month');
    await waitFilter('searchScraps', { from: '2026-09-01', to: '2026-09-18' });
    await waitNames(ALL);
    assert.deepEqual(await noteLines(), [await phrase(s, 'scrapsFilterUndatedOne')], 'the dated note of August and the undated one are both out; the line speaks of the undated one');
    await pick('period', 'all');
    await waitFilter('searchScraps', null);
    await waitNames([...ALL, '2026-08-01.md', 'scratch.md']);
    assert.deepEqual(await noteLines(), [], 'no period: the line is gone and the undated note is back in the list');
    await pick('tag', 'idea');
    await waitFilter('searchScraps', { tags: ['idea'] });
    await waitNames(['2026-09-17.md', 'scratch.md']);
    assert.deepEqual(await noteLines(), [], 'a tag alone leaves no note out for its date');
    await pick('period', 'month');
    await waitFilter('searchScraps', { tags: ['idea'], from: '2026-09-01', to: '2026-09-18' });
    await waitNames(['2026-09-17.md']);
    assert.equal((await noteLines()).length, 1);
    await clickSelector(s, '[data-filter-clear]');
    await waitFilter('searchScraps', null);
    await s.ev('window.__docshot.filter.extra = []; 1');
    await closePanel();

    t.step('the meaning search and the Deep search are given the same filter as the list on screen');
    await openSearch(s);
    await click(s, 'scraps-mode-meaning');
    await typeQuery(s, 'API');
    await waitMeaningList(s);
    assert.equal(await itemCount(s), 10);
    assert.equal((await lastCall('searchScrapsSemantic')).filter, null, 'no filter yet: null');
    assert.deepEqual((await lastCall('searchScrapsSemantic')).args, ['API', 10]);
    await openArea();
    await pick('tag', 'urgent');
    await waitFilter('searchScrapsSemantic', { tags: ['urgent'] });
    await waitMeaningList(s);
    assert.deepEqual(await names(), ['2026-09-28.md', '2026-09-24.md', '2026-09-20.md'], 'the three hits that carry urgent');
    assert.equal(await visible(s, 'btn-scraps-more'), false, 'nothing more to show');
    assert.deepEqual((await lastCall('searchScrapsSemantic')).args, ['API', 10]);
    assert.equal(await pressed(chip('tag', 'urgent')), 'true');
    await pick('tag', 'urgent'); // let it go and take work, which has seven hits
    await pick('tag', 'work');
    await waitFilter('searchScrapsSemantic', { tags: ['work'] });
    await waitMeaningList(s);
    assert.equal(await itemCount(s), 7);

    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'deep-search-modal');
    await waitFocus(s, 'deep-search-cancel');
    const plan1 = await lastCall('deepSearchPlan');
    assert.deepEqual(plan1.args, ['API', 10]);
    assert.deepEqual(plan1.filter, { tags: ['work'] }, 'the plan is for the notes the list on screen is for');
    assert.equal(await s.ev("document.querySelectorAll('#deep-search-source-list li').length"), 3);
    await s.key('Escape');
    await waitHidden(s, 'deep-search-modal');
    assert.equal(await shown(s, 'scraps-search-modal'), true, 'Esc closed the dialog only');
    await waitFocus(s, 'scraps-search-input');

    t.step('another filter, another plan: the period too, and a list that is empty has no Deep search');
    await pick('period', 'month');
    await waitFilter('searchScrapsSemantic', { tags: ['work'], from: '2026-09-01', to: '2026-09-18' });
    await waitMeaningList(s);
    assert.deepEqual(await names(), ['2026-09-18.md', '2026-09-17.md']);
    await click(s, 'btn-scraps-deep');
    await waitShown(s, 'deep-search-modal');
    const plan2 = await lastCall('deepSearchPlan');
    assert.deepEqual(plan2.filter, { tags: ['work'], from: '2026-09-01', to: '2026-09-18' });
    assert.equal(await s.ev("document.querySelectorAll('#deep-search-source-list li').length"), 2, 'only the notes inside the filter are sources');
    assert.equal((await callsOf('deepSearchPlan')).length, 2);
    await s.key('Escape');
    await waitHidden(s, 'deep-search-modal');
    await pick('tag', 'urgent');
    await waitFilter('searchScrapsSemantic', { tags: ['work', 'urgent'], from: '2026-09-01', to: '2026-09-18' });
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length === 0 && !!document.querySelector('#scraps-search-results .scraps-search-empty')");
    assert.equal(await emptyText(), await phrase(s, 'scrapsFilterNoResults'));
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'nothing to send: no Deep search');
    await clickSelector(s, '[data-filter-clear]');
    await waitFilter('searchScrapsSemantic', null);
    await waitMeaningList(s);
    await click(s, 'scraps-mode-exact');
    await closePanel();

    t.step('the keys are the panel\'s own: Enter opens the chosen line, Tab quotes it into the note, Esc closes the panel');
    await focusEditor(s);
    await selectInEditor(s, 'x', { caretOnly: true });
    await openSearch(s);
    await search('API');
    await waitNames(ALL);
    await openArea();
    await pick('tag', 'work');
    await waitFilter('searchScraps', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    t.step('Tab: the buttons took no focus, so the caret is in the box and Tab quotes the chosen line as it always did');
    await s.key('Tab');
    await waitHidden(s, 'scraps-search-modal');
    const line = t.pick('10:12 API design: keep /upload-batch, add a size limit', '10:12 API 設計: /upload-batch は残し、サイズ上限を追加する');
    await s.waitFor(`document.getElementById('editor').value.indexOf(${q(line)}) !== -1`);
    assert.equal((await s.state()).tabs.find((x) => x.title === 'a.md').content.indexOf(line), 0, 'the first line of the filtered list went in at the caret');
    await waitFocus(s, 'editor');

    t.step('the choice is kept while the app is open; the area starts closed; Esc closes the panel, once');
    await openSearch(s);
    assert.equal(await buttonCount(), '(1)', 'work is still chosen');
    assert.equal(await areaOpen(), false, 'the area starts closed');
    await search('API', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    await openArea();
    assert.equal(await pressed(chip('tag', 'work')), 'true');
    await s.key('Escape');
    await waitHidden(s, 'scraps-search-modal');
    await waitFocus(s, 'editor');

    t.step('Enter opens the first line of the filtered list in a tab of its own');
    await openSearch(s);
    await search('API', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    await s.key('Enter');
    await waitHidden(s, 'scraps-search-modal');
    await s.waitFor("(function () { var st = window.__explore.state(); var a = st.tabs.filter(function (x) { return x.id === st.activeTabId; })[0]; return !!a && a.title === '2026-09-17.md'; })()");
    await s.waitFor("document.getElementById('editor').classList.contains('scrap-flash-highlight')"); // the jump to its line has finished
    await waitFocus(s, 'editor');
    await openSearch(s);
    await search('API', { tags: ['work'] });
    await waitNames(['2026-09-17.md', '2026-09-15.md']);
    await openArea();
    await clickSelector(s, '[data-filter-clear]');
    await waitFilter('searchScraps', null);
    await waitNames(ALL);
    await closePanel();

    t.step('more than 40 tags: 40 buttons and the rest only counted; at most 8 can be chosen, the others say so');
    await s.ev(`window.__docshot.filter.options = { files: 120, undated: 0, tags: Array.from({ length: 45 }, function (_, i) { return { tag: 'tag' + (i < 9 ? '0' : '') + (i + 1), files: 100 - i, entries: 100 - i }; }) }; 1`);
    await openSearch(s);
    await search('API');
    await waitNames(ALL);
    await openArea();
    assert.equal((await tagNames()).length, 40);
    assert.equal((await tagNames())[0], 'tag01');
    assert.equal(await textOf(s, '#scraps-filter-area .scraps-filter-more'), await phrase(s, 'scrapsFilterMore', { n: 5 }));
    assert.equal(await s.ev("document.querySelectorAll('#scraps-filter-area .scraps-filter-more button').length"), 0, 'the rest is a count, not a button');
    for (let i = 1; i <= 8; i++) await pick('tag', 'tag0' + i);
    await waitFilter('searchScraps', { tags: ['tag01', 'tag02', 'tag03', 'tag04', 'tag05', 'tag06', 'tag07', 'tag08'] });
    assert.equal(await buttonCount(), '(8)');
    assert.equal(await s.ev("document.querySelectorAll('#scraps-filter-area [data-filter-tag]:disabled').length"), 32, 'the 32 others cannot be chosen');
    assert.equal(await s.ev("document.querySelector('#scraps-filter-area [data-filter-tag=\"tag09\"]').title"), await phrase(s, 'scrapsFilterTagLimit', { n: 8 }));
    const searches = (await callsOf('searchScraps')).length;
    await s.ev("document.querySelector('#scraps-filter-area [data-filter-tag=\"tag09\"]').click()"); // a disabled button takes no click
    await pick('tag', 'tag08'); // one can still be let go
    await waitFilter('searchScraps', { tags: ['tag01', 'tag02', 'tag03', 'tag04', 'tag05', 'tag06', 'tag07'] });
    assert.equal((await callsOf('searchScraps')).length, searches + 1, 'the refused click searched nothing');
    await clickSelector(s, '[data-filter-clear]');
    await waitFilter('searchScraps', null);
    await s.ev("window.__docshot.filter.options = null; 1");
    await closePanel();

    t.step('the tags could not be read: one line says why, the period and the search still work');
    await s.ev("window.__docshot.filter.reject = 'the notes folder could not be read'; 1");
    await openSearch(s);
    await search('API');
    await waitNames(ALL);
    const optionsBefore = await optionCalls();
    await openArea();
    await s.waitFor("!!document.querySelector('#scraps-filter-area .scraps-filter-status-error')");
    assert.equal(await textOf(s, '#scraps-filter-area .scraps-filter-status-error'), await phrase(s, 'scrapsFilterFailed', { message: 'the notes folder could not be read' }));
    assert.deepEqual(await tagNames(), []);
    await pick('period', 'week');
    await waitFilter('searchScraps', WEEK);
    await waitNames(ALL);
    assert.equal(await optionCalls(), optionsBefore + 1, 'asked once, and not again after the failure');
    await s.ev("window.__docshot.filter.reject = ''; 1");
    await clickSelector(s, '[data-filter-clear]');
    await closePanel();
  }
};
