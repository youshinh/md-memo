// The ask bar next to the other panels and the note it is about (exploratory review 2026-09-30: C3-07, C3-09, C1-08, C1-12), in the
// real page: one Esc closes one panel, a dialog stops the shortcut that would open a bar behind it, a bar left open follows the note
// that is on screen, and an ask made while the full preview hides the editor does not type its waiting text into the bar.
import { assert, clickSelector, openAsk, selectInEditor, settle, shown, waitFocus, waitHidden, waitNote, waitShown } from './lib.mjs';

const A = '# A\n\nalpha line\nsecond line\n';
const B = '# B\n\nbeta line\n';

const askInput = (s) => s.ev("document.getElementById('inline-prompt-input').value");
const askLabel = (s) => s.ev("document.getElementById('inline-prompt-target').textContent");
const tabById = async (s, id) => (await s.state()).tabs.find((tab) => tab.id === id);

// A real click on a note's tab, then wait until it is the one on screen.
async function goToTab(s, id) {
  await clickSelector(s, `.tab-item[data-tab-id="${id}"]`);
  await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(id)}`);
}

export default {
  title: 'ask bar: one Esc closes one panel, a dialog holds back its shortcut, it follows the note on screen, a hidden editor is not typed into',
  session: { notes: [{ title: 'a.md', content: A }, { title: 'b.md', content: B }], llm: { mode: 'ok', delayMs: 120 } },

  async run(s, t) {
    const [tabA, tabB] = (await s.state()).tabs.map((tab) => tab.id);
    await goToTab(s, tabA);

    t.step('Esc closes one panel: the find bar goes, the ask bar and what is typed in it stay');
    await selectInEditor(s, 'alpha line');
    await openAsk(s);
    await s.type('explain this');
    await s.key('f', { ctrl: true });
    await waitShown(s, 'find-replace-bar');
    await waitFocus(s, 'find-input');
    await s.key('Escape');
    await waitHidden(s, 'find-replace-bar');
    assert.ok(await shown(s, 'inline-prompt-bar'), 'the ask bar is still open');
    assert.equal(await askInput(s), 'explain this', 'with what was typed');
    await s.key('Escape');
    await waitHidden(s, 'inline-prompt-bar');

    t.step('with Settings open, Ctrl+L opens no bar behind it');
    await s.key(',', { ctrl: true });
    await waitShown(s, 'settings-modal');
    await s.key('l', { ctrl: true });
    await settle(); // "nothing more happens"
    assert.ok(!(await shown(s, 'inline-prompt-bar')), 'no ask bar behind the dialog');
    await s.key('Escape');
    await waitHidden(s, 'settings-modal');

    t.step('a bar left open follows the note on screen: Enter is about that note, and the other one is not touched');
    await selectInEditor(s, 'alpha line');
    await openAsk(s);
    await s.type('make formal');
    const before = await askLabel(s);
    await goToTab(s, tabB);
    await s.waitFor(`document.getElementById('inline-prompt-target').textContent !== ${JSON.stringify(before)}`);
    assert.ok(await shown(s, 'inline-prompt-bar'), 'the bar stays open');
    assert.equal(await askInput(s), 'make formal', 'with what was typed');
    await s.ev("document.getElementById('inline-prompt-input').focus()");
    await s.key('Enter');
    await waitNote(s, "text.indexOf('Reply 1.') !== -1");
    assert.equal((await tabById(s, tabA)).content, A, 'a.md is as it was');
    await s.waitFor('window.__explore.state().pendingLlm === 0');

    t.step('an ask made behind the full preview does not type its waiting text into the bar');
    await goToTab(s, tabA);
    await selectInEditor(s, 'second line');
    await s.key('p', { ctrl: true });
    await waitShown(s, 'preview-pane');
    await openAsk(s);
    await s.type('summarize');
    await s.key('Enter');
    await waitNote(s, "text.indexOf('Reply 2.') !== -1");
    assert.equal(await askInput(s), 'summarize', 'the bar\'s input holds what was typed, nothing else');
    await s.waitFor('window.__explore.state().pendingLlm === 0');
  },
};
