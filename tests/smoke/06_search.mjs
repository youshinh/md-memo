// Searching: find in the note (Ctrl+F: count, Enter selects the match, Escape gives the focus back), replace all (Ctrl+H), and the
// daily notes search (Ctrl+Shift+F: results with file and line, nothing found is said, Enter opens the note).
import { assert, focusEditor, shown, textOf, waitFocus, waitHidden, waitShown, click } from './lib.mjs';

const NOTE = 'banana\napple\ncherry\nbanana split\n';

export default {
  title: 'search: find in note, replace all, search daily notes',
  session: { notes: [{ title: 'fruit.md', content: NOTE }] },

  async run(s, t) {
    t.step('find in the note');
    await focusEditor(s);
    await s.key('f', { ctrl: true });
    await waitShown(s, 'find-replace-bar');
    await waitFocus(s, 'find-input');
    await s.type('banana');
    await s.waitFor("/\\/2$/.test(document.getElementById('find-count').textContent.trim())");
    await s.key('Enter');
    await s.waitFor("(function () { var e = document.getElementById('editor'); return e.value.slice(e.selectionStart, e.selectionEnd) === 'banana'; })()");
    await s.key('Escape');
    await waitHidden(s, 'find-replace-bar');
    await waitFocus(s, 'editor');
    assert.equal((await s.state()).tabs[0].content, NOTE, 'finding changes nothing');

    t.step('replace all');
    await s.key('h', { ctrl: true });
    await waitShown(s, 'replace-row');
    // The focus goes to the Replace box when a search term is already there, to the Find box when not: set both explicitly.
    await s.ev("(function () { var f = document.getElementById('find-input'); f.focus(); f.select(); })()");
    await s.type('banana');
    await s.ev("(function () { var r = document.getElementById('replace-input'); r.focus(); r.select(); })()");
    await s.type('mango');
    await click(s, 'btn-replace-all');
    await s.waitFor("document.getElementById('editor').value.indexOf('banana') === -1");
    assert.equal((await s.state()).tabs[0].content, 'mango\napple\ncherry\nmango split\n', 'both matches were replaced and nothing else');
    await s.key('Escape');
    await waitHidden(s, 'find-replace-bar');

    t.step('search the daily notes');
    const QUERY = t.pick('rate limits', 'レート制限');
    await s.key('f', { ctrl: true, shift: true });
    await waitShown(s, 'scraps-search-modal');
    await waitFocus(s, 'scraps-search-input');
    await s.key('a', { ctrl: true });
    await s.type(QUERY);
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    const hit = await s.ev("(function () { var i = document.querySelector('#scraps-search-results .scraps-match-item'); return { file: i.querySelector('.scraps-match-file').textContent, line: i.querySelector('.scraps-match-line').textContent, snippet: i.querySelector('.scraps-match-snippet').textContent }; })()");
    assert.equal(hit.file, '2026-09-15.md', 'the hit names the daily note');
    assert.ok(hit.line.trim().length > 0, 'the hit names the line');
    assert.ok(hit.snippet.includes(QUERY), `the snippet shows the line that matched: ${JSON.stringify(hit.snippet)}`);

    t.step('nothing found is said');
    await s.key('a', { ctrl: true });
    await s.type('zzzqqxx');
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length === 0");
    assert.ok((await textOf(s, 'scraps-search-results')).trim().length > 0, 'an empty result says so');

    t.step('Enter on a hit opens that daily note');
    await s.key('a', { ctrl: true });
    await s.type(QUERY);
    await s.waitFor("document.querySelectorAll('#scraps-search-results .scraps-match-item').length > 0");
    await s.key('Enter');
    await waitHidden(s, 'scraps-search-modal');
    await s.waitFor("(function () { var st = window.__explore.state(); var a = st.tabs.filter(function (t) { return t.id === st.activeTabId; })[0]; return !!a && a.title === '2026-09-15.md'; })()");
    assert.equal((await s.state()).tabs.length, 2, 'the daily note opened in a tab of its own');
    assert.equal(await shown(s, 'scraps-search-modal'), false);
  },
};
