// The daily notes search in Meaning mode (Settings > Semantic search on): the "Exact | Meaning" switch, one request after typing has paused
// (400 ms), the same list as the plain search with no score anywhere, the backend's own notes as quiet lines, "Show more" asking for 30,
// and a list that is not for the text in the box (a slow answer is on its way) opening nothing. The backend is the mock's fixed answer
// (tools/docshots/mock/backend.js: 12 hits, a score on each) - the real Go bind is not needed here.
import { assert, click, shown, waitFocus } from './lib.mjs';
import { SEMANTIC_ON, asked, itemCount, openSearch, phrase, semanticKnobs, textOf, typeQuery, visible, waitMeaningList } from './semantic_lib.mjs';

const NOTE = '2 results far below the best were left out.';

export default {
  title: 'daily notes search, Meaning mode: switch, one request per pause, the same list without scores, backend notes, Show more asks 30, a stale list opens nothing',
  session: { ...SEMANTIC_ON, notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 45000,

  async run(s, t) {
    const pressed = (id) => s.ev(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-pressed')`);
    const noteLines = () => s.ev("Array.from(document.querySelectorAll('#scraps-search-results .scraps-search-note')).map(function (e) { return e.textContent; })");
    const semanticCalls = async () => (await asked(s, 'searchScrapsSemantic')).length;
    await semanticKnobs(s, { notes: [NOTE] });

    t.step('the switch is there, in Exact; the plain search still answers a typed word and the semantic call is not used');
    await openSearch(s);
    assert.equal(await visible(s, 'scraps-search-mode'), true);
    assert.deepEqual([await pressed('scraps-mode-exact'), await pressed('scraps-mode-meaning')], ['true', 'false']);
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'no Deep search button in Exact');
    await typeQuery(s, 'API');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), []);
    assert.equal(await visible(s, 'btn-scraps-deep'), false);

    t.step('Meaning chosen with the mouse: the box says what to write, the hint names Ctrl+Enter, and the text in the box is searched at once');
    await click(s, 'scraps-mode-meaning');
    assert.deepEqual([await pressed('scraps-mode-exact'), await pressed('scraps-mode-meaning')], ['false', 'true']);
    await waitFocus(s, 'scraps-search-input');
    assert.equal(await s.ev("document.getElementById('scraps-search-input').placeholder"), await phrase(s, 'scrapsSearchPlaceholderMeaning'));
    assert.equal(await textOf(s, '#scraps-search-hint'), await phrase(s, 'scrapsSearchHintMeaning', { mod: 'Ctrl' }));
    await waitMeaningList(s);
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), [['API', 10]], 'the first ask is for 10 notes');

    t.step('typing a word is ONE request (after the pause), not one per letter');
    await typeQuery(s, 'bamboo');
    await waitMeaningList(s);
    assert.deepEqual((await asked(s, 'searchScrapsSemantic')).map((a) => a[0]), ['API', 'bamboo']);

    t.step('the list: 10 rows like the plain search, lines spanned, the backend\'s note above, and no score as a number or a percentage');
    assert.equal(await itemCount(s), 10);
    assert.equal(await textOf(s, '#scraps-search-results .scraps-match-item .scraps-match-line'), 'Ln 3–5');
    assert.deepEqual(await noteLines(), [NOTE], 'the backend\'s sentence as it is, and not the plain search\'s "ranked" label');
    const panelText = await s.ev("document.getElementById('scraps-search-modal').innerText");
    assert.ok(!/\d\.\d|%/.test(panelText), `no score (0.9 ...) or percentage on screen: ${panelText}`);
    assert.equal(await visible(s, 'btn-scraps-deep'), true, 'the Deep search button is up with a list');
    assert.equal(await visible(s, 'btn-scraps-more'), true, 'the backend said there were more');

    t.step('the keyboard moves through the rows as in the plain search');
    await s.key('ArrowDown');
    assert.equal(await s.ev("document.querySelector('#scraps-search-results .scraps-match-item.active').getAttribute('data-idx')"), '1');
    await s.key('ArrowUp');
    assert.equal(await s.ev("document.querySelector('#scraps-search-results .scraps-match-item.active').getAttribute('data-idx')"), '0');

    t.step('Show more asks for 30 and the list grows to what there is; the button is gone and the box keeps the focus');
    await click(s, 'btn-scraps-more');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length === 12");
    assert.deepEqual((await asked(s, 'searchScrapsSemantic')).pop(), ['bamboo', 30]);
    assert.equal(await s.ev("document.getElementById('btn-scraps-more')"), null);
    await waitFocus(s, 'scraps-search-input');

    t.step('a slow answer is on its way: the list on screen is not for the text in the box, so Enter opens nothing and Deep search is away');
    // From here the backend answers only when the flow lets it (a held promise per request), like a slow embedding model.
    await s.ev(`window.__held = [];
      window.__origSemantic = window.backend.searchScrapsSemantic;
      window.backend.searchScrapsSemantic = function (q, limit) {
        return new Promise(function (resolve, reject) {
          window.__held.push({ q: q, release: async function () {
            window.__origSemantic(q, limit).then(resolve, reject);
            for (var i = 0; i < 20; i++) await Promise.resolve(); // let the page's own handlers run
          } });
        });
      };
      1`);
    await s.type('x');
    await s.waitFor("window.__held.length === 1 && window.__held[0].q === 'bamboox'");
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'the button waits for the list of this text');
    await s.key('Enter');
    assert.equal(await shown(s, 'scraps-search-modal'), true, 'Enter did not open a line of the old list');

    t.step('an older answer that arrives after a newer search was made is dropped');
    await s.type('y');
    await s.waitFor("window.__held.length === 2 && window.__held[1].q === 'bambooxy'");
    await semanticKnobs(s, { notes: ['answer to the OLD text'] });
    await s.ev('window.__held[0].release()');
    assert.ok(!(await noteLines()).includes('answer to the OLD text'), 'the old answer was not drawn');
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'still waiting for the list of the newest text');
    await semanticKnobs(s, { notes: ['answer to the NEW text'] });
    await s.ev('window.__held[1].release()');
    await waitMeaningList(s);
    assert.deepEqual(await noteLines(), ['answer to the NEW text']);

    t.step('the backend fell back to words (semantic false): its note is shown, the list is the same, Deep search is still offered');
    await s.ev('window.backend.searchScrapsSemantic = window.__origSemantic; 1');
    await semanticKnobs(s, { semantic: false, notes: ['Meaning search is not ready: these are matches by words.'] });
    const before = await semanticCalls();
    await typeQuery(s, 'bamboo shoots');
    await s.waitFor(`window.__docshot.calls.filter(function (c) { return c.fn === 'searchScrapsSemantic'; }).length === ${before + 1}`);
    await waitMeaningList(s);
    assert.deepEqual(await noteLines(), [await phrase(s, 'scrapsSearchWordsFallback'), 'Meaning search is not ready: these are matches by words.'], 'the plain words first, then the reason the backend gave');
    assert.equal(await visible(s, 'btn-scraps-deep'), true, 'a list found by words can still be taken to Deep search');

    t.step('counts come as numbers and are worded in the UI language: files not indexed yet, notes left out by the cut-off (no command-line flags on screen)');
    await semanticKnobs(s, { semantic: true, notes: [], pending: 3, leftOut: 2 });
    await typeQuery(s, 'bamboo stalks');
    await waitMeaningList(s);
    assert.deepEqual(await noteLines(), [await phrase(s, 'scrapsSearchPending', { n: '3' }), await phrase(s, 'scrapsSearchLeftOut', { n: '2' })]);
    assert.ok(!/--|md-memo scrap/.test(await s.ev("document.getElementById('scraps-search-results').innerText")), 'no command-line jargon in the panel');
  }
};
