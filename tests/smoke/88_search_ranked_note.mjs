// The daily notes search (Ctrl+Shift+F) says so when no line held the whole text and the notes that hold its words are listed instead
// (their matches carry a score). The backend answers; here it is a stand-in. A plain answer (no score) shows no note.
import { assert, waitFocus, waitShown } from './lib.mjs';

const ANSWERS = {
  plain: [{ filePath: 'C:\\\\scraps\\\\2026-09-15.md', fileName: '2026-09-15.md', matches: [{ lineNumber: 3, lineText: 'exact line', snippet: 'exact line' }] }],
  ranked: [{ filePath: 'C:\\\\scraps\\\\2026-09-15.md', fileName: '2026-09-15.md', matches: [{ lineNumber: 3, lineText: 'delivery is late', snippet: 'delivery is late', score: 2.4 }] }],
  partial: [{ filePath: 'C:\\\\scraps\\\\2026-09-16.md', fileName: '2026-09-16.md', matches: [{ lineNumber: 2, lineText: 'only one word', snippet: 'only one word', score: 0.9, partial: true }] }]
};

export default {
  title: 'daily notes search: a list of notes that hold the words is labelled as such, an exact list is not',
  session: { notes: [{ title: 'a.md', content: 'x\n' }] },

  async run(s, t) {
    const answerWith = (kind) => s.ev(`window.backend.searchScraps = function () { return Promise.resolve(${JSON.stringify(ANSWERS[kind])}); }`);
    const noteText = () => s.ev(`(function () { var n = document.querySelector('#scraps-search-results .scraps-search-note'); return n ? n.textContent.trim() : null; })()`);
    // waits for the answer to THIS query (the previous list is still on screen until it arrives)
    const typeQuery = async (text, snippet) => {
      await s.key('a', { ctrl: true });
      await s.type(text);
      await s.waitFor(`document.querySelector('#scraps-search-results .scraps-match-snippet') && document.querySelector('#scraps-search-results .scraps-match-snippet').textContent.indexOf(${JSON.stringify(snippet)}) !== -1`);
    };

    t.step('open the search');
    await s.key('f', { ctrl: true, shift: true });
    await waitShown(s, 'scraps-search-modal');
    await waitFocus(s, 'scraps-search-input');

    t.step('an exact answer: no note above the list');
    await answerWith('plain');
    await typeQuery('exact', 'exact line');
    assert.equal(await noteText(), null, 'a plain list has no note');

    t.step('a ranked answer (every word in the note): the note says the list is by words');
    await answerWith('ranked');
    await typeQuery('delivery drawing', 'delivery is late');
    const ranked = await noteText();
    assert.ok(ranked && ranked.length > 10, `the ranked list says what it is: ${ranked}`);
    assert.equal(await s.ev("document.querySelectorAll('#scraps-search-results .scraps-match-item').length"), 1, 'the list itself is unchanged');

    t.step('a partial answer (some words only): a different note');
    await answerWith('partial');
    await typeQuery('delivery drawing schedule', 'only one word');
    const partial = await noteText();
    assert.ok(partial && partial !== ranked, `the partial list says that too: ${partial}`);

    t.step('the items still open on a click (the note is not an item)');
    assert.equal(await s.ev("document.querySelectorAll('#scraps-search-results .scraps-search-note').length"), 1);
    assert.equal(await s.ev("document.querySelector('#scraps-search-results .scraps-match-item').getAttribute('data-idx')"), '0');
  }
};
