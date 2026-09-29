// The first start of a new install (nothing saved: no settings, no tabs, no folder) shows one editable Welcome note, once:
// a new note afterwards is an ordinary one, the settings written record that it was shown, and the second start of the same
// profile (settings still unsaved, a session left behind) does not show it again. (UX review A1, docs/design/first-run.md.)
import { assert, click, lastSavedConfig, reloadAs, waitFocus } from './lib.mjs';

export default {
  title: 'welcome note: shown on the first start only',
  session: { fresh: true },

  async run(s, t) {
    const TITLE = t.pick('Welcome', 'ようこそ');
    const HEADING = t.pick('# Welcome to MD-Memo', '# MD-Memo へようこそ');

    t.step('the first start of a new install');
    await reloadAs(s, { firstLaunch: true });
    let st = await s.state();
    assert.equal(st.tabs.length, 1, 'one tab');
    assert.equal(st.tabs[0].title, TITLE, 'and it is the Welcome note');
    assert.ok(st.tabs[0].content.startsWith(HEADING), `in the UI language: ${JSON.stringify(st.tabs[0].content.slice(0, 40))}`);
    assert.equal(st.tabs[0].dirty, false, 'not marked unsaved before the person touched it');
    assert.equal(st.tabs[0].path, '', 'and not tied to a file');

    t.step('it records that it was shown');
    await s.waitFor("window.__docshot.calls.some(function (c) { return c.fn === 'saveConfig'; })");
    const saved = await lastSavedConfig(s);
    assert.equal(saved.general.welcomeShown, true, 'general.welcomeShown is written');

    t.step('it is an ordinary editable note');
    await s.ev("(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()");
    await s.type('\nmy own line');
    st = await s.state();
    assert.ok(st.tabs[0].content.endsWith('my own line'), 'typing works in it');
    assert.equal(st.tabs[0].dirty, true, 'and marks it unsaved');

    t.step('a new note is not another Welcome');
    await click(s, 'btn-new-tab');
    await s.waitFor('window.__explore.state().tabs.length === 2');
    await waitFocus(s, 'editor');
    st = await s.state();
    assert.equal(st.tabs.filter((tab) => tab.title === TITLE).length, 1, 'still exactly one Welcome note');
    assert.ok(!st.tabs[1].content.includes(HEADING), 'the new note is empty of it');

    t.step('the second start of the same profile');
    await reloadAs(s, { firstLaunch: false });
    st = await s.state();
    assert.ok(st.tabs.length >= 1);
    assert.ok(!st.tabs.some((tab) => tab.title === TITLE || tab.content.includes(HEADING)), `no Welcome note on the second start: ${JSON.stringify(st.tabs.map((tab) => tab.title))}`);
  },
};
