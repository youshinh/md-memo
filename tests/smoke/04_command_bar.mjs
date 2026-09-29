// The command bar (Ctrl+E): a command run over the selected text, its output landing in the note; a command that fails opens the
// error note and keeps the bar open with the command in it. The backend has no shell here, so the runner is a stand-in that
// answers the way the Go side does (window.__onCliFilterResult).
import { assert, selectInEditor, shown, waitFocus, waitHidden, waitShown } from './lib.mjs';

const NOTE = 'banana\napple\ncherry\n';

// Answers a command: `mode` 'upper' upper-cases the input, 'fail' exits with 1.
const RUNNER = `window.__ran = [];
window.backend.runCommandFilterAsync = function (id, cmd, input) {
  window.__ran.push({ cmd: cmd, input: input });
  setTimeout(function () {
    if (window.__runnerMode === 'fail') window.__onCliFilterResult(id, { exitCode: 1, output: '', error: 'boom: no such file' }, '');
    else window.__onCliFilterResult(id, { exitCode: 0, output: String(input).toUpperCase(), error: '' }, '');
  }, 40);
  return Promise.resolve(null);
};
window.__runnerMode = 'upper';`;

export default {
  title: 'command bar: run a command over the selection, failure keeps the bar',
  session: { notes: [{ title: 'fruit.md', content: NOTE }] },

  async run(s, t) {
    await s.ev(RUNNER);

    t.step('open the command bar on a selection');
    await selectInEditor(s, 'banana');
    await s.key('e', { ctrl: true });
    await waitShown(s, 'cli-filter-bar');
    await waitFocus(s, 'cli-filter-input');

    t.step('run a command');
    await s.type('tr a-z A-Z');
    await s.key('Enter');
    await s.waitFor('window.__ran.length === 1');
    const ran = await s.ev('window.__ran[0]');
    assert.equal(ran.cmd, 'tr a-z A-Z', 'the command reached the runner as typed');
    assert.equal(ran.input, 'banana', 'the runner got the selected text, not the whole note');
    await waitHidden(s, 'cli-filter-bar');

    t.step('the output landed in the note');
    let st = await s.state();
    const holder = st.tabs.find((tab) => tab.content.includes('BANANA'));
    assert.ok(holder, `the output BANANA is in some note: ${JSON.stringify(st.tabs.map((tab) => tab.title))}`);
    assert.ok(!st.tabs.some((tab) => /^\[Error\]/.test(tab.title)), 'no error note was opened');
    assert.equal(st.pendingLlm, 0);
    const original = st.tabs.find((tab) => tab.title === 'fruit.md');
    assert.ok(original.content.includes('apple') && original.content.includes('cherry'), 'the rest of the original note is kept');
    // A small app problem this flow saw: the result note's "Timestamp" line shows the date heading's "# " ("**Timestamp**: # 2026-...").
    await t.knownIssue('the CLI result note prints its Timestamp as "# 2026-..." (the heading format leaks into the line)', async () => {
      const resultTab = st.tabs.find((tab) => /^\[CLI\]/.test(tab.title));
      assert.ok(resultTab, 'a [CLI] result note exists');
      assert.ok(!/\*\*Timestamp\*\*: #/.test(resultTab.content), 'the Timestamp line has no "#"');
    });

    t.step('a failing command opens the error note and keeps the bar');
    await s.ev("window.__runnerMode = 'fail'");
    await s.ev("document.getElementById('editor').focus()");
    await s.key('e', { ctrl: true });
    await waitShown(s, 'cli-filter-bar');
    await waitFocus(s, 'cli-filter-input');
    await s.type('cat missing.txt');
    await s.key('Enter');
    await s.waitFor('window.__ran.length === 2');
    await s.waitFor("window.__explore.state().tabs.some(function (t) { return /^\\[Error\\]/.test(t.title); })");
    st = await s.state();
    const errTab = st.tabs.find((tab) => /^\[Error\]/.test(tab.title));
    assert.ok(errTab.content.includes('boom: no such file'), 'the error note carries the command\'s error text');
    assert.ok(errTab.content.includes('cat missing.txt'), 'the error note names the command');
    assert.equal(await shown(s, 'cli-filter-bar'), true, 'the bar is open again so the command can be fixed');
    assert.equal(await s.ev("document.getElementById('cli-filter-input').value"), 'cat missing.txt', 'the command is still in the input');
    assert.equal(await s.ev("document.getElementById('cli-filter-input').disabled"), false, 'and it can be edited');
    await s.key('Escape');
    await waitHidden(s, 'cli-filter-bar');
  },
};
