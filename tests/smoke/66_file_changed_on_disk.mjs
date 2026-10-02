// A note's file changed by something else (another editor, a Git pull, a sync client): the next save must not write over it, and a CRLF
// file keeps its line ending (exploratory findings C2-05, C2-06 and C4-08). The backend is a small in-page model of a file system whose
// saveFileChecked behaves like the Go side: it refuses (conflict) when the file no longer holds the text the tab last knew of it.
import { assert, clickSelector, focusEditor, settle, shown, waitHidden, waitShown } from './lib.mjs';

const PATH = 'C:\\notes\\crlf.md';

const DISK = `window.__disk = {}; window.__saves = [];
window.__disk[${JSON.stringify(PATH)}] = 'one\\r\\ntwo\\r\\n';
window.backend.readFileByPath = function (p) {
  return Promise.resolve({ path: p, title: 'crlf.md', content: window.__disk[p], encoding: 'UTF-8' });
};
window.backend.saveFile = function (p, content) {
  window.__saves.push({ p: p, content: content, checked: false });
  window.__disk[p] = content;
  return Promise.resolve({ path: p, title: 'crlf.md', success: true });
};
window.backend.saveFileChecked = function (p, content, enc, sig) {
  window.__saves.push({ p: p, content: content, sig: sig, checked: true });
  if (sig && window.__disk[p] !== undefined && DiskSync.sum(window.__disk[p]) !== sig) {
    return Promise.resolve({ path: p, title: 'crlf.md', conflict: true });
  }
  window.__disk[p] = content;
  return Promise.resolve({ path: p, title: 'crlf.md', success: true, sig: DiskSync.sum(content) });
};
window.__mdMemoRPC.openTab({ title: 'crlf.md', path: ${JSON.stringify(PATH)}, content: window.__disk[${JSON.stringify(PATH)}] });`;

// something else rewrites the file, and the watcher tells the page (as Go's file watcher does)
const externalWrite = (s, text) => s.ev(`window.__disk[${JSON.stringify(PATH)}] = ${JSON.stringify(text)}; window.__onExternalFileChanged(${JSON.stringify(PATH)})`);

const tabOf = async (s) => (await s.state()).tabs.find((tab) => tab.path === PATH);
const disk = (s) => s.ev(`window.__disk[${JSON.stringify(PATH)}]`);
const saves = (s) => s.ev('window.__saves.length');

export default {
  title: 'a file changed on disk is not overwritten by the next save, and a CRLF file keeps its line ending',
  session: { notes: [{ title: 'a.md', content: 'unrelated\n' }] },

  async run(s, t) {
    await s.ev(DISK);
    await s.waitFor(`window.__explore.state().tabs.some(function (t) { return t.path === ${JSON.stringify(PATH)}; })`);
    const id = (await tabOf(s)).id;
    await clickSelector(s, `.tab-item[data-tab-id="${id}"]`);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(id)}`);

    t.step('a CRLF file: typing and the automatic save write CRLF back, not LF');
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type('three');
    await s.waitFor('window.__saves.length >= 1', { timeout: 6000 });
    assert.equal(await disk(s), 'one\r\ntwo\r\nthree', 'the file keeps its CRLF line ending');
    assert.equal((await s.ev('window.__saves[0].checked')), true, 'a file the tab knows is saved through the checked call');

    t.step('a clean note follows a change made to its file from outside');
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.path === ${JSON.stringify(PATH)}; })[0].dirty === false`);
    await externalWrite(s, 'one\r\ntwo\r\nthree\r\nfour (written elsewhere)\r\n');
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.path === ${JSON.stringify(PATH)}; })[0].content.indexOf('four (written elsewhere)') !== -1`);
    assert.equal((await tabOf(s)).dirty, false, 'refreshing from the file does not count as an edit');

    t.step('a note with unsaved text is not refreshed: it is flagged, and its autosave stops');
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type(' MINE');
    await externalWrite(s, 'one\r\ntwo\r\nREWRITTEN BY A GIT PULL\r\n');
    await s.waitFor(`document.querySelector('.tab-item[data-tab-id="${id}"] .tab-conflict-mark') !== null`);
    const before = await saves(s);
    await settle(2200); // "nothing more happens": longer than the 1.5 s autosave delay
    assert.equal(await saves(s), before, 'no automatic save was attempted while the file is in conflict');
    assert.equal(await disk(s), 'one\r\ntwo\r\nREWRITTEN BY A GIT PULL\r\n', 'the other change is untouched');

    t.step('Ctrl+S asks; Cancel writes nothing');
    await focusEditor(s);
    await s.key('s', { ctrl: true });
    await waitShown(s, 'confirm-modal');
    await clickSelector(s, '#confirm-modal-cancel');
    await waitHidden(s, 'confirm-modal');
    assert.equal(await disk(s), 'one\r\ntwo\r\nREWRITTEN BY A GIT PULL\r\n', 'cancel left the file alone');
    assert.equal((await tabOf(s)).dirty, true, 'the note still has its unsaved text');

    t.step('"Load the file": the note shows the file, and the person\'s own text is kept in a new tab');
    await focusEditor(s);
    await s.key('s', { ctrl: true });
    await waitShown(s, 'confirm-modal');
    await clickSelector(s, '#confirm-modal-dontsave');
    await waitHidden(s, 'confirm-modal');
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.path === ${JSON.stringify(PATH)}; })[0].content.indexOf('REWRITTEN BY A GIT PULL') !== -1`);
    let st = await s.state();
    const mine = st.tabs.find((tab) => !tab.path && tab.content.indexOf('MINE') !== -1);
    assert.ok(mine, 'the unsaved text went into a new tab');
    assert.equal(mine.dirty, true, 'and that tab is still unsaved');
    assert.equal(st.tabs.find((tab) => tab.path === PATH).dirty, false, 'the file tab is clean again');
    assert.equal(await shown(s, 'confirm-modal'), false);

    t.step('"Overwrite the file": the person\'s text replaces the other change, in CRLF, and the note is clean');
    await clickSelector(s, `.tab-item[data-tab-id="${id}"]`);
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type(' SECOND');
    await externalWrite(s, 'one\r\ntwo\r\nREWRITTEN AGAIN\r\n');
    await s.waitFor(`document.querySelector('.tab-item[data-tab-id="${id}"] .tab-conflict-mark') !== null`);
    await focusEditor(s);
    await s.key('s', { ctrl: true });
    await waitShown(s, 'confirm-modal');
    await clickSelector(s, '#confirm-modal-ok');
    await waitHidden(s, 'confirm-modal');
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.path === ${JSON.stringify(PATH)}; })[0].dirty === false`);
    assert.ok((await disk(s)).endsWith(' SECOND'), 'the file now holds the person\'s text');
    assert.ok((await disk(s)).includes('\r\n') && !/[^\r]\n/.test(await disk(s)), 'still CRLF all through');
    assert.equal(await s.ev(`document.querySelector('.tab-item[data-tab-id="${id}"] .tab-conflict-mark')`), null, 'the warning mark is gone');

    t.step('the app\'s own appends (CLI pipe, Quick Capture) refresh a clean note and cause no false conflict on the next save');
    const base = await saves(s);
    await s.ev(`window.__disk[${JSON.stringify(PATH)}] += 'appended by the CLI\\r\\n'`);
    await s.ev(`window.onScrapAppended({ filePath: ${JSON.stringify(PATH)}, fileName: 'crlf.md', command: 'test' })`);
    await s.waitFor(`window.__explore.state().tabs.filter(function (t) { return t.path === ${JSON.stringify(PATH)}; })[0].content.indexOf('appended by the CLI') !== -1`);
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type('!');
    await s.waitFor(`window.__saves.length > ${base}`, { timeout: 6000 });
    assert.ok((await disk(s)).includes('appended by the CLI') && (await disk(s)).endsWith('!'), 'the appended text and the new typing are both in the file');
    assert.equal(await s.ev(`document.querySelector('.tab-item[data-tab-id="${id}"] .tab-conflict-mark')`), null, 'no conflict was raised');

    t.step('an agent run saves the note first: the next save compares against what the run wrote');
    await s.ev(`window.__onDiskTextWritten(${JSON.stringify(PATH)}, 'what the run wrote\\ntwo')`);
    await s.ev(`window.__disk[${JSON.stringify(PATH)}] = 'what the run wrote\\ntwo'`);
    await focusEditor(s);
    await s.key('End', { ctrl: true });
    await s.type('?');
    const afterRun = await saves(s);
    await s.waitFor(`window.__saves.length > ${afterRun}`, { timeout: 6000 });
    assert.equal(await s.ev('window.__saves[window.__saves.length - 1].checked'), true);
    assert.equal(await s.ev(`document.querySelector('.tab-item[data-tab-id="${id}"] .tab-conflict-mark')`), null, 'a note whose file the run just wrote is not in conflict');
  }
};
