// Meaning mode when things go wrong or the page has no storage: a rejected search says why on ONE line and the switch stays so the person can
// go back to Exact; a search the backend dropped for a newer one ("superseded") says nothing; the Deep search button is only there with a
// list in Meaning mode; and the panel works (and remembers the mode for the session) when sessionStorage cannot be used at all.
import { assert, click, waitFocus, waitHidden, settle } from './lib.mjs';
import { SEMANTIC_ON, asked, itemCount, openSearch, phrase, semanticKnobs, typeQuery, visible, waitMeaningList } from './semantic_lib.mjs';

export default {
  title: 'daily notes search, Meaning mode: a rejected search is one line with the way back to Exact, superseded is silent, Deep search only with a list, no sessionStorage needed',
  session: { ...SEMANTIC_ON, notes: [{ title: 'a.md', content: 'x\n' }] },
  timeoutMs: 45000,

  async run(s, t) {
    const pressed = (id) => s.ev(`document.getElementById(${JSON.stringify(id)}).getAttribute('aria-pressed')`);
    const errorLines = () => s.ev("Array.from(document.querySelectorAll('#scraps-search-results .scraps-search-error')).map(function (e) { return e.textContent; })");
    const REJECT = 'Semantic search is off. Turn it on in Settings.';

    t.step('the page has no sessionStorage (it throws): the panel opens in Exact and Meaning can still be chosen');
    await s.ev("Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { throw new Error('denied'); } }); 1");
    await openSearch(s);
    assert.equal(await pressed('scraps-mode-exact'), 'true');
    await click(s, 'scraps-mode-meaning');
    assert.equal(await pressed('scraps-mode-meaning'), 'true');

    t.step('closed and opened again, the panel is still in Meaning (the choice is kept in the page for the session)');
    await s.key('Escape');
    await waitHidden(s, 'scraps-search-modal');
    await openSearch(s);
    assert.equal(await pressed('scraps-mode-meaning'), 'true');
    assert.equal(await s.ev("document.getElementById('scraps-search-input').placeholder"), await phrase(s, 'scrapsSearchPlaceholderMeaning'));

    t.step('Deep search is there only with a list: none before a search, none for an empty answer, one for an answer');
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'no list yet');
    await semanticKnobs(s, { total: 0 });
    await typeQuery(s, 'nothing like it');
    await s.waitFor("document.querySelector('#scraps-search-results .scraps-search-empty') && !document.querySelector('#scraps-search-results .scraps-search-empty').classList.contains('scraps-search-error') && document.querySelector('#scraps-search-results .scraps-search-empty').textContent.indexOf('...') === -1");
    assert.equal(await itemCount(s), 0);
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'an empty answer has nothing to take to Deep search');
    await semanticKnobs(s, { total: 12 });
    await typeQuery(s, 'bamboo');
    await waitMeaningList(s);
    assert.equal(await visible(s, 'btn-scraps-deep'), true);

    t.step('a rejected search: the message on ONE line in place of the list, no Deep search, no "Show more", and the switch stays');
    await semanticKnobs(s, { reject: REJECT });
    await typeQuery(s, 'API');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-search-error').length === 1");
    const lines = await errorLines();
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(REJECT) && !/\n/.test(lines[0]), `the message, in one line: ${lines[0]}`);
    assert.equal(await itemCount(s), 0);
    assert.equal(await visible(s, 'btn-scraps-deep'), false);
    assert.equal(await visible(s, 'btn-scraps-more'), false);
    assert.equal(await visible(s, 'scraps-search-mode'), true, 'the switch is still there');

    t.step('the way back: Exact answers the same text with the plain search, the error line is gone, Meaning is not asked again');
    const meaningCalls = (await asked(s, 'searchScrapsSemantic')).length;
    await click(s, 'scraps-mode-exact');
    assert.equal(await pressed('scraps-mode-exact'), 'true');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    assert.deepEqual(await errorLines(), []);
    assert.equal((await asked(s, 'searchScrapsSemantic')).length, meaningCalls);
    assert.equal(await s.ev("document.getElementById('scraps-search-input').placeholder"), await phrase(s, 'scrapsSearchPlaceholder'));
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'no Deep search in Exact');

    t.step('a failure with a long, multi-line message is still one line of text');
    await click(s, 'scraps-mode-meaning');
    await semanticKnobs(s, { reject: 'embedding model unreachable\n  dial tcp 127.0.0.1:11434: connectex: refused\n' + 'x'.repeat(400) });
    await typeQuery(s, 'API again');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-search-error').length === 1");
    const long = (await errorLines())[0];
    assert.ok(!/\n/.test(long) && long.length < 330, `one short line: ${long.length} characters`);

    t.step('superseded (the backend dropped the search for a newer one) says nothing: no error line appears');
    await semanticKnobs(s, { reject: 'superseded' });
    const before = (await asked(s, 'searchScrapsSemantic')).length;
    await typeQuery(s, 'API once more');
    await s.waitFor(`window.__docshot.calls.filter(function (c) { return c.fn === 'searchScrapsSemantic'; }).length === ${before + 1}`);
    await settle(200); // nothing more happens: the dropped answer must not turn into a message
    assert.deepEqual(await errorLines(), []);

    t.step('a search that works again draws its list');
    await semanticKnobs(s, { reject: '' });
    await typeQuery(s, 'bamboo');
    await waitMeaningList(s);
    assert.equal(await itemCount(s), 10);
    await waitFocus(s, 'scraps-search-input');
  }
};
