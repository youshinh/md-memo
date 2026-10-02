// The JSON-RPC tab and task listings of the page (window.__mdMemoRPC.getTabs / getTasks / cancelTask, behind `tab.list` / `task.list` /
// `task.cancel`): getTabs also says how each tab's file is read and written (encoding, line ending), whether the file changed under
// unsaved text, whether it is a scrap and which pane shows it; the task list shows what is running without any prompt or output text,
// and cancel stops a task the way the Task panel's Cancel button does.
import { assert, clickSelector, click, rpc, waitShown } from './lib.mjs';

const CRLF = 'C:\\notes\\crlf.md';
const SCRAP = 'C:\\notes\\scraps\\2026-10-02.md';

// A small in-page file system, like the one tests/smoke/66_file_changed_on_disk.mjs uses.
const DISK = `window.__disk = {};
window.__disk[${JSON.stringify(CRLF)}] = 'one\\r\\ntwo\\r\\n';
window.__disk[${JSON.stringify(SCRAP)}] = '# scrap\\n';
window.backend.readFileByPath = function (p) {
  return Promise.resolve({ path: p, title: p.split('\\\\').pop(), content: window.__disk[p], encoding: 'UTF-8' });
};
window.backend.saveFile = function (p, content) { window.__disk[p] = content; return Promise.resolve({ path: p, title: 'x.md', success: true }); };
window.backend.saveFileChecked = function (p, content) { window.__disk[p] = content; return Promise.resolve({ path: p, title: 'x.md', success: true, sig: DiskSync.sum(content) }); };
1`;

const tabs = async (s) => (await rpc(s, 'getTabs()')).ok;
const byTitle = (list, title) => list.find((x) => x.title === title);

export default {
  title: 'tab and task RPC: getTabs reports encoding, line ending, disk conflict, scrap and pane; getTasks / cancelTask list and stop a task',
  session: { notes: [{ title: 'a.md', content: 'first note\n' }, { title: 'b.md', content: 'second note\n' }] },
  timeoutMs: 60000,

  async run(s, t) {
    await s.ev(DISK);
    const KEYS = ['diskConflict', 'encoding', 'eol', 'id', 'isActive', 'isModified', 'isScrap', 'pane', 'path', 'title'];

    t.step('a plain note: UTF-8, LF, no conflict, not a scrap; the active tab is in the primary pane, the others in none');
    let list = await tabs(s);
    assert.equal(list.length, 2);
    for (const entry of list) assert.deepEqual(Object.keys(entry).sort(), KEYS, 'the old keys are all still there, with the five new ones');
    assert.deepEqual(byTitle(list, 'a.md'), { id: 'tab_x1', title: 'a.md', path: '', isActive: true, isModified: false, encoding: 'UTF-8', eol: 'lf', diskConflict: false, isScrap: false, pane: 'primary' });
    assert.deepEqual(byTitle(list, 'b.md'), { id: 'tab_x2', title: 'b.md', path: '', isActive: false, isModified: false, encoding: 'UTF-8', eol: 'lf', diskConflict: false, isScrap: false, pane: null });

    t.step('a dirty tab is isModified; a CRLF file and a Shift_JIS tab say so');
    await s.ev("(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()");
    await s.type('typed');
    await s.waitFor("window.__explore.state().tabs[0].dirty === true");
    await rpc(s, `openTab({ title: 'crlf.md', path: ${JSON.stringify(CRLF)}, content: ${JSON.stringify('one\r\ntwo\r\n')}, background: true })`);
    await rpc(s, "openTab({ title: 'sj.md', content: 'x', encoding: 'Shift_JIS', background: true })");
    list = await tabs(s);
    assert.equal(list.length, 4);
    assert.equal(byTitle(list, 'a.md').isModified, true);
    assert.equal(byTitle(list, 'b.md').isModified, false);
    const crlf = byTitle(list, 'crlf.md');
    assert.deepEqual([crlf.eol, crlf.encoding, crlf.path, crlf.isModified, crlf.pane], ['crlf', 'UTF-8', CRLF, false, null]);
    const sj = byTitle(list, 'sj.md');
    assert.deepEqual([sj.eol, sj.encoding, sj.pane], ['lf', 'Shift_JIS', null]);
    assert.equal(byTitle(list, 'a.md').eol, 'lf');

    t.step('a tab whose file changed under unsaved text is diskConflict, and only that tab');
    await s.ev(`window.__mdMemoRPC.switchTab(${JSON.stringify(crlf.id)})`);
    await s.waitFor(`window.__explore.state().activeTabId === ${JSON.stringify(crlf.id)}`);
    await s.ev("(function () { var e = document.getElementById('editor'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()");
    await s.type(' MINE');
    await s.ev(`window.__disk[${JSON.stringify(CRLF)}] = 'one\\r\\ntwo\\r\\nREWRITTEN ELSEWHERE\\r\\n'; window.__onExternalFileChanged(${JSON.stringify(CRLF)})`);
    await s.waitFor(`document.querySelector('.tab-item[data-tab-id="${crlf.id}"] .tab-conflict-mark') !== null`);
    list = await tabs(s);
    assert.deepEqual(list.filter((x) => x.diskConflict).map((x) => x.title), ['crlf.md']);
    assert.equal(byTitle(list, 'crlf.md').isModified, true);
    assert.equal(byTitle(list, 'crlf.md').pane, 'primary');
    assert.equal(byTitle(list, 'a.md').pane, null, 'a tab that is not shown has no pane');

    t.step('a scrap the app opened for a pipe or capture is isScrap');
    await s.ev(`window.onScrapAppended({ filePath: ${JSON.stringify(SCRAP)}, fileName: '2026-10-02.md', command: 'test' })`);
    await s.waitFor("window.__explore.state().tabs.some(function (x) { return x.title === '2026-10-02.md'; })");
    list = await tabs(s);
    assert.deepEqual(list.filter((x) => x.isScrap).map((x) => x.title), ['2026-10-02.md']);

    t.step('pane: the tab in the split\'s right-hand pane says "secondary", exactly one tab per pane');
    await s.waitFor("window.__mdMemoRPC.getTabs().filter(function (x) { return x.pane === 'primary'; }).length === 1");
    await click(s, 'btn-toggle-split');
    await waitShown(s, 'secondary-pane');
    list = await tabs(s);
    const secondaryId = (await rpc(s, 'getUiState()')).ok.secondaryTabId;
    assert.deepEqual(list.filter((x) => x.pane === 'secondary').map((x) => x.id), [secondaryId]);
    assert.equal(list.filter((x) => x.pane === 'primary').length, 1);
    await click(s, 'btn-toggle-split');
    await s.waitFor("document.getElementById('secondary-pane').classList.contains('hidden')");
    assert.equal((await tabs(s)).filter((x) => x.pane === 'secondary').length, 0);

    t.step('getTasks: nothing running, nothing finished');
    assert.deepEqual((await rpc(s, 'getTasks()')).ok, { running: [], recent: [] });

    t.step('a running task is listed with its kind and label, never its instruction text');
    await s.ev(`window.__cancelled = [];
      window.TaskManager.addTask({ id: 'fake-1', type: 'llm', agent: 'LLM', instruction: 'SECRET PROMPT WORDS', onCancel: function () { window.__cancelled.push('fake-1'); } });
      window.TaskManager.addTask({ id: 'fake-action', type: 'action', agent: 'CLI', instruction: 'a command line with a token' });
      1`);
    let tasks = (await rpc(s, 'getTasks()')).ok;
    assert.deepEqual(tasks.recent, []);
    assert.deepEqual(tasks.running.map((x) => x.id).sort(), ['fake-1', 'fake-action']);
    const fake = tasks.running.find((x) => x.id === 'fake-1');
    assert.deepEqual(Object.keys(fake).sort(), ['cancellable', 'id', 'kind', 'label', 'startedAt', 'status']);
    assert.deepEqual([fake.kind, fake.label, fake.status, fake.cancellable], ['llm', 'LLM', 'running', true]);
    assert.equal(typeof fake.startedAt, 'number');
    assert.ok(!JSON.stringify(tasks).includes('SECRET PROMPT WORDS') && !JSON.stringify(tasks).includes('command line'), 'no instruction text');
    assert.equal(tasks.running.find((x) => x.id === 'fake-action').cancellable, false, 'nothing could stop a task that has no cancel of its own');

    t.step('cancelTask stops it through the task\'s own cancel and moves it to the history as canceled');
    let r = await rpc(s, "cancelTask('fake-1')");
    assert.deepEqual(r.ok, { cancelled: true });
    assert.deepEqual(await s.ev('window.__cancelled'), ['fake-1'], 'the task\'s own cancel ran, once');
    tasks = (await rpc(s, 'getTasks()')).ok;
    assert.deepEqual(tasks.running.map((x) => x.id), ['fake-action']);
    assert.equal(tasks.recent.length, 1);
    assert.deepEqual([tasks.recent[0].id, tasks.recent[0].status, tasks.recent[0].cancellable], ['fake-1', 'canceled', false]);
    assert.equal(typeof tasks.recent[0].finishedAt, 'number');

    t.step('cancelTask: finished -> not_running, unknown -> not_found, no way to stop it -> not_cancellable, no id -> invalid_params');
    r = await rpc(s, "cancelTask('fake-1')");
    assert.deepEqual(r.ok, { cancelled: false, reason: 'not_running' });
    r = await rpc(s, "cancelTask('no-such-task')");
    assert.deepEqual(r.ok, { cancelled: false, reason: 'not_found' });
    r = await rpc(s, "cancelTask('fake-action')");
    assert.deepEqual(r.ok, { cancelled: false, reason: 'not_cancellable' });
    assert.deepEqual((await rpc(s, 'getTasks()')).ok.running.map((x) => x.id), ['fake-action'], 'it is still running: it was not only hidden');
    r = await rpc(s, "cancelTask('')");
    assert.equal(r.kind, 'invalid_params');
    r = await rpc(s, 'cancelTask()');
    assert.equal(r.kind, 'invalid_params');

    t.step('a failed task is in the history with its reason in one short line; the history is newest first');
    await s.ev("window.TaskManager.updateTask('fake-action', { status: 'failed', error: 'exit code 1\\nsecond line' }); 1");
    tasks = (await rpc(s, 'getTasks()')).ok;
    assert.deepEqual(tasks.running, []);
    assert.deepEqual(tasks.recent.map((x) => [x.id, x.status]), [['fake-action', 'failed'], ['fake-1', 'canceled']]);
    assert.equal(tasks.recent[0].error, 'exit code 1 second line');
    assert.equal('error' in tasks.recent[1], false, 'no error key when there is none');

    t.step('the Task panel\'s own Cancel button and the RPC take the same path');
    await s.ev("window.TaskManager.addTask({ id: 'fake-2', type: 'llm', agent: 'LLM', instruction: 'x', onCancel: function () { window.__cancelled.push('fake-2'); } }); window.TaskManager.showPanel(); 1");
    await s.waitFor("document.querySelector('.btn-task-cancel[data-cancel-id=\"fake-2\"]') !== null");
    await clickSelector(s, '.btn-task-cancel[data-cancel-id="fake-2"]');
    await s.waitFor("window.__cancelled.indexOf('fake-2') !== -1");
    tasks = (await rpc(s, 'getTasks()')).ok;
    assert.deepEqual(tasks.running, []);
    assert.deepEqual([tasks.recent[0].id, tasks.recent[0].status], ['fake-2', 'canceled'], 'the same end state the RPC leaves');
    await s.ev('window.TaskManager.hidePanel(); 1');
  }
};
