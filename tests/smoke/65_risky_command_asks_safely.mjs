// A command the safety check calls dangerous asks before it runs, and the question defaults to NO (UX review B20). The dialog used
// to take any Enter as "OK", whatever had the focus: a held or repeated Enter (the same Enter that submitted the command bar),
// a double press, or Enter on the focused Cancel all ran the command. The reason also lost its line breaks.
import { assert, waitFocus, waitHidden, waitShown } from './lib.mjs';

const RISKY = { validateCliCommand: { result: { isWarning: true, isSafe: false, reason: 'deletes files', command: 'del /q *.tmp' } } };
const runs = (s) => s.ev("window.__docshot.calls.filter(function (c) { return c.fn === 'runCommandFilterAsync'; }).length");

// Opens the command bar in the note, types the risky command and presses Enter; the question is up when this returns.
async function askRisky(s) {
  await s.ev('document.getElementById("editor").focus()');
  await s.key('e', { ctrl: true });
  await waitShown(s, 'cli-filter-bar');
  await waitFocus(s, 'cli-filter-input');
  await s.type('del /q *.tmp');
  await s.key('Enter');
  await waitShown(s, 'confirm-modal');
  await waitFocus(s, 'confirm-modal-cancel');
}

export default {
  title: 'a dangerous command asks first, Cancel has the focus, and no Enter but a deliberate one on OK runs it',
  session: { notes: [{ title: 'a.md', content: 'hello\n' }], backend: RISKY },

  async run(s, t) {
    t.step('the question is up: Cancel has the focus and the reason keeps its line breaks');
    await askRisky(s);
    assert.equal(await s.ev("getComputedStyle(document.getElementById('confirm-modal-message')).whiteSpace"), 'pre-line');

    t.step('an Enter that repeats (a key held down) does not answer');
    await s.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))");
    await s.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }))");
    assert.equal(await s.ev("!document.getElementById('confirm-modal').classList.contains('hidden')"), true, 'the question is still there');
    assert.equal(await runs(s), 0, 'nothing ran');

    t.step('Enter on the focused Cancel means Cancel');
    await s.key('Enter');
    await waitHidden(s, 'confirm-modal');
    assert.equal(await runs(s), 0, 'the command did not run');

    t.step('the command can still be run on purpose: move to OK, then Enter');
    await askRisky(s);
    await s.key('Tab', { shift: true });
    await waitFocus(s, 'confirm-modal-ok');
    await s.key('Enter');
    await waitHidden(s, 'confirm-modal');
    await s.waitFor("window.__docshot.calls.filter(function (c) { return c.fn === 'runCommandFilterAsync'; }).length === 1");
  },
};
