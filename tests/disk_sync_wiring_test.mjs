// The pieces that make a note follow its file and refuse to write over a change made elsewhere are wired in the page (the behaviour
// itself runs in tests/smoke/66_file_changed_on_disk.mjs and frontend/js/disk_sync_test.js; Go: app_disk_sync_test.go).
import fs from 'fs';
import assert from 'assert';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const app = read('frontend/js/app.js');
const html = read('frontend/index.html');
const slot = read('frontend/js/slot_agent.js');
const i18n = read('frontend/js/i18n.js');
const bindCommon = read('bind_common.go');

let n = 0;
function check(name, fn) { fn(); n++; console.log('PASS: ' + name); }

check('index.html loads disk_sync.js before app.js', () => {
  const ds = html.indexOf('js/disk_sync.js');
  assert.ok(ds !== -1, 'disk_sync.js is not loaded');
  assert.ok(ds < html.indexOf('js/app.js'), 'it must come before app.js');
});

check('a file the tab knows is saved through saveFileChecked, with the fingerprint and the file\'s line ending', () => {
  assert.ok(/window\.backend\.saveFileChecked\(tab\.path, body, tab\.encoding, tab\.diskSig\)/.test(app));
  assert.ok(/DiskSync\.applyEol\(persistedContent\(tab\), tab\.eol\)/.test(app));
});

check('the bound backend has saveFileChecked on every platform', () => {
  assert.ok(/Bind\("backend_saveFileChecked", app\.SaveFileChecked\)/.test(bindCommon));
  for (const f of ['window_windows.go', 'window_darwin.go']) {
    assert.ok(/saveFileChecked: \(path, content, enc, expectSig\) => window\.backend_saveFileChecked\(/.test(read(f)), f);
  }
});

check('the session keeps each tab\'s fingerprint and line ending, in both serializations', () => {
  assert.strictEqual((app.match(/diskSig: t\.diskSig/g) || []).length >= 3, true, 'getSessionData, the fragment and its cache');
  assert.ok(/cached\.diskSig === t\.diskSig/.test(app) && /cached\.eol === t\.eol/.test(app), 'the fragment cache compares them');
});

check('the file watcher\'s read reaches the page, and a restored session is checked after the first paint', () => {
  assert.ok(/window\.__onDiskTextSeen\(filePath, fileRes\)/.test(slot));
  assert.ok(/window\.__onDiskTextSeen = function/.test(app));
  assert.ok(/setTimeout\(verifyRestoredTabsAgainstDisk, \d+\)/.test(app));
});

check('an automatic save never asks: a tab in conflict waits for Ctrl+S', () => {
  assert.ok(/opts && opts\.auto && tab\.diskConflict && tab\.path && !forceSaveAs\) return false/.test(app));
  assert.ok(/tab\.isDirty && tab\.path && !tab\.diskConflict\) \{\s*saveTab\(tab, false, \{ auto: true \}\)/.test(app));
});

check('every path that changes a tab\'s text from its file, or the file behind its back, updates what the tab knows of the file', () => {
  // a slot / agent run: Go writes the note to its file first (app_slot.go), both call sites tell the page
  assert.strictEqual((slot.match(/window\.__onDiskTextWritten\(filePath, /g) || []).length, 2, 'both runSlotAgentAsync call sites');
  assert.ok(/window\.__onDiskTextWritten = function \(path, text\)/.test(app));
  // a scrap that something appended to (CLI pipe, Quick Capture, hot folder, Discord) and a reopened file
  const refresh = app.slice(app.indexOf('async function refreshTabFromDisk'), app.indexOf('// --- Feature 2: Webview Scrap Appended Listener'));
  assert.ok(/rememberDiskText\(tab, res\.content\)/.test(refresh), 'refreshTabFromDisk');
  const adopt = app.slice(app.indexOf('function adoptDiskText'), app.indexOf('function rememberDiskText'));
  assert.ok((adopt.match(/rememberDiskText\(tab, text, rawText\)/g) || []).length === 2, 'adoptDiskText, both branches');
  assert.ok(/if \(path && content !== undefined\) rememberDiskText\(newTab, initialContent\)/.test(app), 'createTab');
});

check('the strings exist in both languages', () => {
  const keys = ['diskConflictMessage', 'diskConflictSaveAs', 'diskConflictReload', 'diskConflictOverwrite', 'diskConflictMineTitle',
    'diskConflictKept', 'diskConflictLoaded', 'diskConflictLoadFailed', 'diskChangedReloaded', 'diskChangedWhileClosed',
    'diskChangedWhileClosedMany', 'diskChangedUnsaved', 'diskConflictTabTitle'];
  for (const k of keys) assert.strictEqual(i18n.split('\n    ' + k + ':').length - 1, 2, k + ' must be in en and ja');
});

console.log(`\ndisk_sync_wiring_test.mjs: ${n} passed`);
