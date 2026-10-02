// The daily notes search without Settings > Semantic search: it is the plain panel it always was (no "Exact | Meaning" switch, no Deep
// search button, no status line, the same placeholder and hint, Ctrl+Enter opens the note like Enter), and nothing asks the semantic
// functions of the backend. Turning the setting on shows the switch the next time the panel opens; turning it off takes it away again.
import { assert, click, rpc, waitFocus, waitHidden } from './lib.mjs';
import { asked, itemCount, openSearch, phrase, typeQuery, visible } from './semantic_lib.mjs';

export default {
  title: 'daily notes search without Semantic search: no switch, no Deep search, Ctrl+Enter as before; the setting shows and hides them',
  session: { notes: [{ title: 'a.md', content: 'x\n' }] },

  async run(s, t) {
    const placeholder = () => s.ev("document.getElementById('scraps-search-input').placeholder");
    const hint = () => s.ev("document.getElementById('scraps-search-hint').textContent");
    const plain = async (why) => {
      assert.equal(await visible(s, 'scraps-search-mode'), false, `${why}: no Exact / Meaning switch`);
      assert.equal(await visible(s, 'btn-scraps-deep'), false, `${why}: no Deep search button`);
      assert.equal(await visible(s, 'scraps-search-status'), false, `${why}: no status line`);
      assert.equal(await placeholder(), await phrase(s, 'scrapsSearchPlaceholder'), `${why}: the usual placeholder`);
      assert.equal(await hint(), await phrase(s, 'scrapsSearchHint'), `${why}: the usual hint`);
    };

    t.step('Semantic search is not set up: the panel opens as it always did');
    await openSearch(s);
    await plain('semantic absent');

    t.step('JSON-RPC ui.open_panel cannot switch it on: Meaning is refused (invalid_params), Exact with a query searches by words');
    await s.key('Escape');
    const refused = await rpc(s, 'openPanel("scraps_search", {query: "API", mode: "meaning"})');
    assert.equal(refused.kind, 'invalid_params', JSON.stringify(refused));
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), []);
    assert.equal((await rpc(s, 'openPanel("scraps_search", {query: "API", mode: "exact"})')).ok.panel, 'scraps_search');
    assert.equal(await s.ev("document.getElementById('scraps-search-input').value"), 'API');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    await plain('after the RPC opening');
    await s.key('Escape');
    await openSearch(s);

    t.step('typing finds lines with the plain search, one request, no semantic call, no "Show more"');
    await typeQuery(s, 'API');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    assert.ok((await asked(s, 'searchScraps')).length >= 1, 'the plain search ran');
    assert.deepEqual(await asked(s, 'searchScrapsSemantic'), [], 'the semantic search was never asked');
    assert.equal(await s.ev("document.querySelectorAll('#scraps-search-results .scraps-search-more').length"), 0);
    await plain('after a search');

    t.step('Ctrl+Enter opens the chosen note like Enter does, and starts no Deep search');
    await s.key('Enter', { ctrl: true });
    await waitHidden(s, 'scraps-search-modal');
    await s.waitFor("window.__explore.state().tabs.length === 2"); // the note was opened
    await s.waitFor("document.getElementById('editor').classList.contains('scrap-flash-highlight')"); // and the jump to its line has finished
    await waitFocus(s, 'editor');
    assert.deepEqual(await asked(s, 'deepSearchPlan'), [], 'no Deep search plan was asked');

    t.step('the setting turned on: the switch is there the next time the panel opens, in Exact, with the usual placeholder');
    await s.ev("MdMemoBridge.getConfig().semantic = { enabled: true }; 1");
    await openSearch(s);
    assert.equal(await visible(s, 'scraps-search-mode'), true, 'the switch is shown');
    assert.equal(await s.ev("document.getElementById('scraps-mode-exact').getAttribute('aria-pressed')"), 'true');
    assert.equal(await s.ev("document.getElementById('scraps-mode-meaning').getAttribute('aria-pressed')"), 'false');
    assert.equal(await visible(s, 'btn-scraps-deep'), false, 'no Deep search button without a meaning list');
    assert.equal(await placeholder(), await phrase(s, 'scrapsSearchPlaceholder'));

    t.step('Meaning chosen, then the setting turned off: the panel is the plain one again and searches by words');
    await click(s, 'scraps-mode-meaning');
    assert.equal(await s.ev("document.getElementById('scraps-mode-meaning').getAttribute('aria-pressed')"), 'true');
    await s.key('Escape');
    await waitHidden(s, 'scraps-search-modal');
    await s.ev("MdMemoBridge.getConfig().semantic = { enabled: false }; 1");
    await openSearch(s);
    await plain('semantic switched off');
    const before = (await asked(s, 'searchScrapsSemantic')).length;
    await typeQuery(s, 'API');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    assert.equal((await asked(s, 'searchScrapsSemantic')).length, before, 'a person who turned it off is not searched by meaning');
    assert.ok((await itemCount(s)) > 0);
  }
};
